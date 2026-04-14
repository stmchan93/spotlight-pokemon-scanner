from __future__ import annotations

import sys
import unittest
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from pricing_utils import normalize_price_summary, preferred_tcgplayer_price_entry  # noqa: E402


class PricingUtilsTests(unittest.TestCase):
    def test_prefers_unlimited_variant_over_first_edition_when_both_exist(self) -> None:
        prices = {
            "1stEditionHolofoil": {
                "low": 28.99,
                "market": 44.46,
                "mid": 46.49,
                "high": 440.0,
            },
            "unlimitedHolofoil": {
                "low": 6.89,
                "market": 9.11,
                "mid": 10.0,
                "high": 233.37,
                "directLow": 9.18,
            },
        }

        selected = preferred_tcgplayer_price_entry(prices)

        self.assertIsNotNone(selected)
        variant, payload = selected or ("", {})
        self.assertEqual(variant, "unlimitedHolofoil")
        self.assertEqual(payload.get("market"), 9.11)

    def test_normalize_price_summary_uses_unlimited_variant_for_vintage_default(self) -> None:
        summary = normalize_price_summary(
            {
                "updatedAt": "2026/04/06",
                "url": "https://prices.example.com/tcgplayer/base5-14",
                "prices": {
                    "1stEditionHolofoil": {
                        "low": 28.99,
                        "market": 44.46,
                        "mid": 46.49,
                        "high": 440.0,
                    },
                    "unlimitedHolofoil": {
                        "low": 6.89,
                        "market": 9.11,
                        "mid": 10.0,
                        "high": 233.37,
                        "directLow": 9.18,
                    },
                },
            },
            None,
        )

        self.assertIsNotNone(summary)
        self.assertEqual(summary["source"], "tcgplayer")
        self.assertEqual(summary["variant"], "unlimitedHolofoil")
        self.assertEqual(summary["market"], 9.11)


if __name__ == "__main__":
    unittest.main()
