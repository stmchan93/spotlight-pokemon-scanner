"""Fix #2 guard: the dashboard's shared daily-history read is scoped to the open
range's window (+ per-card carry-in) instead of full history, so the first cold
Collection load reads ~8x fewer rows. `deck_history` output MUST be byte-identical
whether the shared read was full (range_labels=None) or scoped to that range — the
scoping is a pure I/O reduction, never a chart change. This mirrors the real-DB
parity run (all six ranges byte-identical for a 151-card owner) as a synthetic CI
check, and pins that scoping actually reads fewer rows (with a valid carry-in).
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_deck_entry,
    upsert_price_history_daily,
)
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

SCRYDEX = "scrydex"
CARD_ID = "scopecard"
USER = "user-scope"
HISTORY_DAYS = 40  # long enough that a 1W window is a strict subset
TZ = "America/Los_Angeles"


class PortfolioHistoryRangeScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "range-scope.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        upsert_card(
            connection,
            card_id=CARD_ID,
            name="Blastoise",
            set_name="Base Set",
            number="2/102",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            source_provider=SCRYDEX,
            source_record_id=CARD_ID,
        )
        start = datetime.now(timezone.utc).date() - timedelta(days=HISTORY_DAYS - 1)
        # A moving price so day-1 valuation (which relies on the carry-in row) is
        # distinguishable from the window's later days — a broken carry-in would
        # change the scoped chart's first point.
        for offset in range(HISTORY_DAYS):
            market = 100.0 + offset  # strictly increasing
            upsert_price_history_daily(
                connection,
                card_id=CARD_ID,
                pricing_mode=RAW_PRICING_MODE,
                provider=SCRYDEX,
                price_date=(start + timedelta(days=offset)).isoformat(),
                currency_code="USD",
                variant="Holofoil",
                condition="NM",
                low_price=market - 1,
                market_price=market,
                mid_price=market,
                high_price=market + 1,
                direct_low_price=market - 2,
                trend_price=market,
                payload={"provider": SCRYDEX, "variantKey": "holofoil"},
            )
        upsert_deck_entry(
            connection,
            card_id=CARD_ID,
            variant_name="Holofoil",
            condition="NM",
            quantity=2,
            owner_user_id=USER,
            added_at=start.isoformat(),
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self._prev_source = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"
        self.addCleanup(self._restore_source)

    def _restore_source(self) -> None:
        if self._prev_source is None:
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
        else:
            os.environ["PRICE_HISTORY_SOURCE"] = self._prev_source

    def _identity(self) -> RequestIdentity:
        return RequestIdentity(user_id=USER, auth_source="test")

    def test_scoped_read_is_smaller_but_has_carry_in(self) -> None:
        with self.service.request_identity_context(self._identity()):
            full = self.service._load_portfolio_history_shared_inputs(
                time_zone_name=TZ, range_labels=None
            )
            scoped = self.service._load_portfolio_history_shared_inputs(
                time_zone_name=TZ, range_labels=["1W"]
            )
            window_start = self.service._portfolio_history_window_start(
                ["1W"], time_zone_name=TZ
            )
        full_rows = full["history_rows_by_card_id"][CARD_ID]
        scoped_rows = scoped["history_rows_by_card_id"][CARD_ID]
        # (>= HISTORY_DAYS-1: the seed dates in UTC vs the read's LA "today" can
        # skew the last day by one — irrelevant to the scoping being validated.)
        self.assertGreaterEqual(len(full_rows), HISTORY_DAYS - 1)
        self.assertLess(len(scoped_rows), len(full_rows))
        # Rows stay sorted ascending; exactly one carry-in precedes the window and
        # the rest fall inside the 1W (7-day) window.
        dates = [str(r["price_date"]) for r in scoped_rows]
        self.assertEqual(dates, sorted(dates))
        before = [d for d in dates if d < window_start.isoformat()]
        in_window = [d for d in dates if d >= window_start.isoformat()]
        self.assertEqual(len(before), 1, "exactly one carry-in row before the window")
        self.assertTrue(1 <= len(in_window) <= 7, f"window rows out of range: {len(in_window)}")

    def _assert_range_parity(self, label: str) -> None:
        with self.service.request_identity_context(self._identity()):
            full = self.service._load_portfolio_history_shared_inputs(
                time_zone_name=TZ, range_labels=None
            )
            scoped = self.service._load_portfolio_history_shared_inputs(
                time_zone_name=TZ, range_labels=[label]
            )
            h_full = self.service.deck_history(
                days=365, range_label=label, time_zone_name=TZ, shared_inputs=full
            )
            h_scoped = self.service.deck_history(
                days=365, range_label=label, time_zone_name=TZ, shared_inputs=scoped
            )
        for key in ("summary", "coverage", "points"):
            self.assertEqual(h_full[key], h_scoped[key], f"{label} {key} differs full vs scoped")

    def test_deck_history_parity_1w(self) -> None:
        self._assert_range_parity("1W")

    def test_deck_history_parity_30d(self) -> None:
        self._assert_range_parity("30D")

    def test_deck_history_parity_all(self) -> None:
        self._assert_range_parity("ALL")


if __name__ == "__main__":
    unittest.main()
