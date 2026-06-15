"""Guards for the dashboard cells-mode N+1 fix.

In PRICE_HISTORY_SOURCE=cells the per-day price resolver used to query the cell
table once per (card, day) — a massive N+1 that made the cold dashboard compute
blow past the client timeout. The fix bulk-prefetches the cells once and threads
them into `_portfolio_history_series_for_context` as `cells_by_date`, with the
resolver falling back to its single-day query only when nothing is prefetched.

These tests prove (a) the prefetched (batched) path yields a byte-identical series
to the per-day-query path, and (b) when prefetch is supplied the per-day query is
NEVER called (the N+1 is gone).
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import server  # noqa: E402
from catalog_tools import (  # noqa: E402
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    price_history_cell_rows_by_date,
    upsert_card,
    upsert_deck_entry,
    upsert_price_history_daily,
)
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

SCRYDEX = "scrydex"
CARD_ID = "c1"
DAY_1 = "2026-06-01"
DAY_3 = "2026-06-03"
ENTRY = {"cardID": CARD_ID, "itemKind": "raw", "variantName": "Holofoil"}


class PortfolioDashboardCellsBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "dash-cells-batch.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        upsert_card(
            connection,
            card_id=CARD_ID,
            name="Pikachu",
            set_name="Base Set",
            number="58/102",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=CARD_ID,
        )
        for price_date, market in ((DAY_1, 15.0), (DAY_3, 20.0)):
            upsert_price_history_daily(
                connection,
                card_id=CARD_ID,
                pricing_mode=RAW_PRICING_MODE,
                provider=SCRYDEX,
                price_date=price_date,
                currency_code="USD",
                variant="Holofoil",
                condition="NM",
                low_price=market - 1.0,
                market_price=market,
                mid_price=market + 0.5,
                high_price=market + 1.0,
                direct_low_price=market - 2.0,
                trend_price=market,
                payload={"provider": SCRYDEX, "variantKey": "holofoil"},
            )
        # Adversarial: corrupt the scalar defaults so the ONLY correct source is the
        # cells — a regression that ignored the prefetched cells would surface 999.0.
        connection.execute(
            "UPDATE card_price_history_daily SET default_raw_market_price = 999.0 WHERE card_id = ?",
            (CARD_ID,),
        )
        connection.commit()
        connection.close()

        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self._prev_source = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"
        self.addCleanup(self._restore_source)

        # Span includes a leading gap day (no row → None) and a carry-forward day
        # (06-02 carries 06-01's price) so the series exercises every branch.
        self.day_dates = [date(2026, 5, 31), date(2026, 6, 1), date(2026, 6, 2), date(2026, 6, 3)]
        self.history_rows = self.service._portfolio_history_rows_by_card_id(
            card_ids={CARD_ID},
            end_date=date(2026, 6, 3),
            provider=SCRYDEX,
        ).get(CARD_ID, [])
        # Mirror _load_portfolio_history_shared_inputs' prefetch for this one card.
        self.cells_by_date = price_history_cell_rows_by_date(
            self.service.connection,
            card_id=CARD_ID,
            provider=SCRYDEX,
            price_dates={DAY_1, DAY_3},
        )

    def _restore_source(self) -> None:
        if self._prev_source is None:
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
        else:
            os.environ["PRICE_HISTORY_SOURCE"] = self._prev_source

    def _series(self, *, cells_by_date):
        return self.service._portfolio_history_series_for_context(
            ENTRY,
            condition_code="NM",
            history_rows=self.history_rows,
            day_dates=self.day_dates,
            cells_by_date=cells_by_date,
        )

    def test_prefetched_series_matches_per_day_query(self) -> None:
        per_day = self._series(cells_by_date=None)       # falls back to per-day query
        prefetched = self._series(cells_by_date=self.cells_by_date)  # batched path
        self.assertEqual(prefetched, per_day)
        # Sanity: the cells (not the corrupted 999.0 default) drive the values.
        markets = [point["market"] if point else None for point in prefetched]
        self.assertEqual(markets, [None, 15.0, 15.0, 20.0])

    def test_prefetch_avoids_the_per_day_query(self) -> None:
        calls: list[tuple[str, str]] = []
        original = server.price_history_cell_rows_for_day

        def _counting(connection, *, card_id, price_date, lane=None):
            calls.append((card_id, price_date))
            return original(connection, card_id=card_id, price_date=price_date, lane=lane)

        server.price_history_cell_rows_for_day = _counting  # type: ignore[assignment]
        try:
            # With prefetch: the per-day query must never run.
            self._series(cells_by_date=self.cells_by_date)
            self.assertEqual(calls, [], "prefetched path must not issue per-day cell queries")
            # Without prefetch: it falls back to the per-day query (proves the spy works).
            self._series(cells_by_date=None)
            self.assertGreater(len(calls), 0)
        finally:
            server.price_history_cell_rows_for_day = original  # type: ignore[assignment]

    def test_deck_history_batched_matches_standalone_end_to_end(self) -> None:
        # End-to-end: in cells mode, deck_history with shared_inputs (which builds
        # the bulk cells prefetch) must produce a byte-identical result to calling
        # deck_history standalone (per-day cell query). This exercises the full
        # wiring: _load_portfolio_history_shared_inputs → cells_by_card_date →
        # deck_history → series builder → resolver.
        upsert_deck_entry(
            self.service.connection,
            owner_user_id="owner-a",
            card_id=CARD_ID,
            condition="near_mint",
            quantity=2,
            unit_price=10.0,
            currency_code="USD",
        )
        self.service.connection.commit()

        def strip_refreshed(value):
            if isinstance(value, dict):
                return {k: strip_refreshed(v) for k, v in value.items() if k != "refreshedAt"}
            if isinstance(value, list):
                return [strip_refreshed(v) for v in value]
            return value

        with self.service.request_identity_context(RequestIdentity(user_id="owner-a", auth_source="test")):
            shared_inputs = self.service._load_portfolio_history_shared_inputs()
            # The prefetch builder must have populated cells for the seeded card.
            self.assertIsNotNone(shared_inputs.get("cells_by_card_date"))
            self.assertIn(CARD_ID, shared_inputs["cells_by_card_date"])
            for label in ("1W", "30D", "90D", "YTD", "1Y", "ALL"):
                batched = self.service.deck_history(days=365, range_label=label, shared_inputs=shared_inputs)
                standalone = self.service.deck_history(days=365, range_label=label)
                self.assertEqual(
                    strip_refreshed(batched),
                    strip_refreshed(standalone),
                    f"cells-mode batched vs per-day history mismatch for {label}",
                )


if __name__ == "__main__":
    unittest.main()
