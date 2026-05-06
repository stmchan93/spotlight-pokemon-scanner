from __future__ import annotations

import sys
import unittest
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from pricing_utils import (  # noqa: E402
    cleaned_high_price,
    cleaned_price,
    normalize_cardmarket_prices,
    normalize_price_summary,
    normalize_tcgplayer_prices,
    preferred_tcgplayer_price_entry,
)


class PricingUtilsTests(unittest.TestCase):
    def test_cleaned_price_rejects_invalid_or_non_positive_values(self) -> None:
        self.assertEqual(cleaned_price("19.25"), 19.25)
        self.assertEqual(cleaned_price(4), 4.0)
        self.assertIsNone(cleaned_price(None))
        self.assertIsNone(cleaned_price(0))
        self.assertIsNone(cleaned_price(-7))
        self.assertIsNone(cleaned_price("not-a-price"))

    def test_cleaned_high_price_rejects_values_below_reference(self) -> None:
        self.assertEqual(cleaned_high_price("14.50", 10.0), 14.5)
        self.assertIsNone(cleaned_high_price("8.00", 10.0))
        self.assertEqual(cleaned_high_price("8.00", None), 8.0)
        self.assertIsNone(cleaned_high_price("invalid", 10.0))

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

    def test_prefers_first_non_empty_fallback_variant_when_ordered_choices_are_missing(self) -> None:
        prices = {
            "etchedHolofoil": {},
            "specialIllustrationRare": {
                "market": 51.25,
            },
        }

        selected = preferred_tcgplayer_price_entry(prices)

        self.assertEqual(
            selected,
            (
                "specialIllustrationRare",
                {
                    "market": 51.25,
                },
            ),
        )

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

    def test_normalize_tcgplayer_prices_drops_invalid_high_when_lower_than_market(self) -> None:
        summary = normalize_tcgplayer_prices(
            {
                "updatedAt": "2026/04/06",
                "url": "https://prices.example.com/tcgplayer/base1-4",
                "prices": {
                    "holofoil": {
                        "low": "120.25",
                        "market": "150.50",
                        "mid": "155.10",
                        "high": "149.99",
                        "directLow": "145.00",
                    },
                },
            }
        )

        self.assertEqual(summary["low"], 120.25)
        self.assertEqual(summary["market"], 150.5)
        self.assertEqual(summary["mid"], 155.1)
        self.assertIsNone(summary["high"])
        self.assertEqual(summary["directLow"], 145.0)
        self.assertEqual(summary["trend"], 150.5)

    def test_normalize_tcgplayer_prices_returns_none_when_variant_has_no_valid_numbers(self) -> None:
        summary = normalize_tcgplayer_prices(
            {
                "prices": {
                    "normal": {
                        "low": "n/a",
                        "market": None,
                        "mid": 0,
                        "high": -1,
                    }
                }
            }
        )

        self.assertIsNone(summary)

    def test_normalize_cardmarket_prices_uses_fallback_average_and_low_price(self) -> None:
        summary = normalize_cardmarket_prices(
            {
                "updatedAt": "2026/05/05",
                "url": "https://prices.example.com/cardmarket/base1-4",
                "prices": {
                    "trendPrice": "88.50",
                    "averageSellPrice": None,
                    "avg30": "86.10",
                    "avg7": "87.20",
                    "lowPriceExPlus": None,
                    "lowPrice": "80.00",
                    "suggestedPrice": "99.95",
                },
            }
        )

        self.assertEqual(summary["source"], "cardmarket")
        self.assertEqual(summary["currencyCode"], "EUR")
        self.assertEqual(summary["variant"], "normal")
        self.assertEqual(summary["low"], 80.0)
        self.assertEqual(summary["market"], 86.1)
        self.assertEqual(summary["mid"], 86.1)
        self.assertEqual(summary["high"], 99.95)
        self.assertEqual(summary["trend"], 88.5)

    def test_normalize_price_summary_falls_back_to_cardmarket(self) -> None:
        summary = normalize_price_summary(
            {
                "prices": {
                    "normal": {
                        "market": None,
                    }
                }
            },
            {
                "prices": {
                    "trendPrice": "14.20",
                    "avg7": "13.80",
                }
            },
        )

        self.assertIsNotNone(summary)
        self.assertEqual(summary["source"], "cardmarket")
        self.assertEqual(summary["market"], 13.8)


if __name__ == "__main__":
    unittest.main()
