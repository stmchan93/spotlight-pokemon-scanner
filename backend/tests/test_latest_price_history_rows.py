"""Regression guard for `_latest_price_history_rows_by_card_id` and its two
callers (`_yesterday_...` / `_price_history_rows_on_or_before_...`).

These batched readers used to read a card's ENTIRE price history and keep only
the latest row per card — a ~79x over-read that, cold, made the Collection
dashboard's day-change lookup an ~18s scan (12k index rows for a 151-card owner).
They now fetch only each card's latest row via a MAX(price_date) index-aggregate
+ join. This pins the contract that rewrite must preserve: latest date wins,
strict `<` excludes today/future, `<=` includes the cutoff boundary, and exactly
one row is returned per card.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
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
    upsert_price_history_daily,
)
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

SCRYDEX = "scrydex"
CARD_ID = "base1-4"
VARIANT = "Unlimited Holofoil"
# Three past dates plus one far-future date; the strict `<today` reader must land
# on the newest PAST date and never the future one.
D_OLD = "2026-06-01"
D_MID = "2026-06-15"
D_NEW = "2026-06-30"
D_FUTURE = "2099-01-01"


class LatestPriceHistoryRowsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "latest-rows.sqlite"
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
            source_provider="scrydex",
            source_record_id=CARD_ID,
        )
        self.connection = connection
        for price_date, market in (
            (D_OLD, 100.0),
            (D_MID, 200.0),
            (D_NEW, 300.0),
            (D_FUTURE, 999.0),
        ):
            self._seed(price_date, market=market)
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self.connection = self.service.connection

    def _seed(self, price_date: str, *, market: float) -> None:
        upsert_price_history_daily(
            self.connection,
            card_id=CARD_ID,
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX,
            price_date=price_date,
            currency_code="USD",
            variant=VARIANT,
            condition="NM",
            low_price=market - 1,
            market_price=market,
            mid_price=market,
            high_price=market + 1,
        )

    def test_yesterday_picks_newest_past_row_only(self) -> None:
        rows = self.service._yesterday_price_history_rows_by_card_id([CARD_ID])
        self.assertEqual(set(rows), {CARD_ID})  # exactly one card key
        row = rows[CARD_ID]
        self.assertIsNotNone(row)
        # Newest PAST date wins; the far-future row is excluded by strict `<today`.
        self.assertEqual(row["price_date"], D_NEW)
        self.assertAlmostEqual(row["default_raw_market_price"], 300.0, places=2)

    def test_on_or_before_includes_cutoff_boundary(self) -> None:
        rows = self.service._price_history_rows_on_or_before_by_card_id(
            [CARD_ID], cutoff_date_iso=D_MID
        )
        row = rows[CARD_ID]
        self.assertIsNotNone(row)
        # `<=` cutoff includes D_MID itself and excludes the newer D_NEW.
        self.assertEqual(row["price_date"], D_MID)
        self.assertAlmostEqual(row["default_raw_market_price"], 200.0, places=2)

    def test_unknown_card_absent(self) -> None:
        rows = self.service._yesterday_price_history_rows_by_card_id(["does-not-exist"])
        self.assertEqual(rows, {})


if __name__ == "__main__":
    unittest.main()
