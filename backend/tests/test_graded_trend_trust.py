"""card_price_trend_list surfaces the PPT smartMarketPrice confidence + eBay sale
count on graded rows (the "High · 37 sales" trust line)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, card_price_trend_list, connect, upsert_card  # noqa: E402
from server import _apply_price_history_cells_schema_patch  # noqa: E402
from sync_ppt_catalog import sync_ppt_cards  # noqa: E402


def _card(sales_by_grade: dict) -> dict:
    return {
        "tcgPlayerId": "246723",
        "prices": {"market": 2276.45, "primaryPrinting": "Holofoil"},
        "variants": {"Holofoil": {"Near Mint": {"price": 2276.45}}},
        "ebay": {"salesByGrade": sales_by_grade},
    }


class GradedTrendTrustTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "trust.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        upsert_card(
            self.connection, card_id="swsh7-215", name="Umbreon VMAX",
            set_name="Evolving Skies", number="215/203", rarity="Secret",
            variant="Raw", language="English", source_provider="scrydex",
            tcgplayer_id="246723",
        )
        self.connection.commit()

    def _psa10_row(self):
        trend = card_price_trend_list(self.connection, "swsh7-215", mode="graded", provider="ppt")
        return next(r for r in trend["rows"] if r["key"] == "PSA 10")

    def test_high_confidence_smart_price_with_count(self) -> None:
        sync_ppt_cards(self.connection, [_card({
            "psa10": {"smartMarketPrice": 4600.0, "smartMarketConfidence": "high",
                      "medianPrice": 4524.88, "count": 37},
        })], price_date="2026-06-25")
        row = self._psa10_row()
        self.assertEqual(row["currentPrice"], 4600.0)   # smart (high conf) is the market
        self.assertEqual(row["confidence"], "high")
        self.assertEqual(row["saleCount"], 37)

    def test_median_fallback_carries_count_without_confidence(self) -> None:
        # No smart price/confidence -> median is the market; count still surfaces,
        # confidence is null (nothing to show).
        sync_ppt_cards(self.connection, [_card({
            "psa10": {"medianPrice": 4524.88, "minPrice": 4100.0, "maxPrice": 4900.0, "count": 12},
        })], price_date="2026-06-25")
        row = self._psa10_row()
        self.assertEqual(row["currentPrice"], 4524.88)
        self.assertIsNone(row["confidence"])
        self.assertEqual(row["saleCount"], 12)


if __name__ == "__main__":
    unittest.main()
