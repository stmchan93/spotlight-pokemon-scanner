"""The newest chart point prices slabs the daily history has no cell for.

The balance headline IS the chart's last point. That point prices every
holding from that day's `card_price_history_cell` rows, and a holding with no
cell is dropped from the day's total — silently, so the number just reads low.

That is exactly what a missing LANE looks like: staging writes raw cells daily
(TCGCSV, free) and no graded cells at all (Scrydex credits), so a PSA 10
holding worth $409k landed in the balance at its $897 raw price while the
Collection picker, which prices live, showed the real number.

The newest day now falls back to live snapshot pricing, so the headline agrees
with the Collection total. Older days do NOT: today's price is not evidence of
what a card was worth last month, and their drops stay counted in
`excludedCardCount`.
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
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_deck_entry,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

SCRYDEX = "scrydex"
CARD_ID = "base1-4"
USER = "user-live-newest"
HISTORY_DAYS = 8
TZ = "America/Los_Angeles"
RAW_MARKET = 897.19
GRADED_MARKET = 409539.86


class PortfolioHistoryLiveNewestDayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "live-newest.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        upsert_card(
            connection,
            card_id=CARD_ID,
            name="Charizard",
            set_name="Base",
            number="4/102",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            source_provider=SCRYDEX,
            source_record_id=CARD_ID,
        )

        start = datetime.now(timezone.utc).date() - timedelta(days=HISTORY_DAYS - 1)
        # RAW cells every day — the lane that keeps syncing.
        for offset in range(HISTORY_DAYS):
            upsert_price_history_daily(
                connection,
                card_id=CARD_ID,
                pricing_mode=RAW_PRICING_MODE,
                provider=SCRYDEX,
                price_date=(start + timedelta(days=offset)).isoformat(),
                currency_code="USD",
                variant="Holofoil",
                condition="NM",
                low_price=RAW_MARKET - 1,
                market_price=RAW_MARKET,
                mid_price=RAW_MARKET,
                high_price=RAW_MARKET + 1,
                direct_low_price=RAW_MARKET - 2,
                trend_price=RAW_MARKET,
                payload={"provider": SCRYDEX, "variantKey": "holofoil"},
            )

        # The GRADED price exists only as a live snapshot — no graded history
        # cell on any day, which is the staging shape.
        upsert_price_snapshot(
            connection,
            card_id=CARD_ID,
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider=SCRYDEX,
            currency_code="USD",
            variant="Holofoil",
            grader="PSA",
            grade="10",
            low_price=GRADED_MARKET - 5,
            market_price=GRADED_MARKET,
            mid_price=GRADED_MARKET + 1,
            high_price=GRADED_MARKET + 5,
            direct_low_price=GRADED_MARKET - 6,
            trend_price=GRADED_MARKET + 2,
            payload={"provider": SCRYDEX, "variantKey": "holofoil"},
        )

        upsert_deck_entry(
            connection,
            card_id=CARD_ID,
            grader="PSA",
            grade="10",
            variant_name="Holofoil",
            quantity=1,
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

    def _history(self):
        with self.service.request_identity_context(RequestIdentity(user_id=USER, auth_source="test")):
            return self.service.deck_history(days=365, range_label="1W", time_zone_name=TZ)

    def _collection_total(self) -> float:
        with self.service.request_identity_context(RequestIdentity(user_id=USER, auth_source="test")):
            summary = self.service.deck_entries_for_owner(
                USER, limit=1000, offset=0, include_inactive=False, compute_day_change=False
            )["summary"]
        return float(summary["totalValue"])

    def test_newest_point_matches_the_collection_total(self) -> None:
        history = self._history()
        points = history["points"]
        self.assertGreater(len(points), 1)
        newest = points[-1]
        self.assertAlmostEqual(newest["totalValue"], GRADED_MARKET, places=2)
        # The headline and the Collection picker are the same number now.
        self.assertAlmostEqual(newest["totalValue"], self._collection_total(), places=2)
        self.assertAlmostEqual(history["summary"]["currentValue"], GRADED_MARKET, places=2)
        # It was PRICED, not excluded.
        self.assertEqual(newest["excludedCardCount"], 0)
        self.assertEqual(newest["pricedCardCount"], 1)

    def test_the_raw_cell_is_not_what_the_slab_gets_priced_at(self) -> None:
        # The regression: the slab took the only cell on the day, its RAW price.
        newest = self._history()["points"][-1]
        self.assertNotAlmostEqual(newest["totalValue"], RAW_MARKET, places=2)

    def test_older_days_keep_history_only_pricing(self) -> None:
        # Today's price is not evidence of last week's, so earlier days still
        # drop the holding and say so.
        points = self._history()["points"]
        earlier = points[0]
        self.assertEqual(earlier["totalValue"], 0.0)
        self.assertEqual(earlier["pricedCardCount"], 0)
        self.assertEqual(earlier["excludedCardCount"], 1)
