"""Scrydex sends a card's price in MULTIPLE currencies for the same (variant,
condition) — e.g. Gastly NM raw as both {4000 JPY} and {42.99 USD}. Our ingestion
used array order (last-write-wins), so the displayed price flipped when Scrydex
reordered (the $24.73 <-> $42.99 jump). The fix prefers the USD/TCGplayer price
deterministically; JPY-only cards (non-TCGplayer tail) stay JPY.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scrydex_adapter import build_scrydex_pricing_bundle_from_card_payload  # noqa: E402


def _card(prices):
    return {"data": {"name": "Gastly", "expansion": {"name": "Wild Force"},
                     "variants": [{"name": "holofoil", "prices": prices}]}}


JPY_NM = {"type": "raw", "condition": "NM", "market": 4000.0, "low": 3500.0, "currency": "JPY"}
USD_NM = {"type": "raw", "condition": "NM", "market": 42.99, "low": 29.3, "currency": "USD"}


def _nm(bundle):
    variants = bundle["rawContexts"]["variants"]
    conditions = next(iter(variants.values()))["conditions"]
    return conditions["NM"]


class ScrydexCurrencyPreferenceTests(unittest.TestCase):
    def test_usd_wins_when_jpy_first(self):
        b = build_scrydex_pricing_bundle_from_card_payload(_card([JPY_NM, USD_NM]))
        self.assertEqual(_nm(b)["market"], 42.99)
        self.assertEqual(_nm(b)["currencyCode"], "USD")
        self.assertEqual(b["displayCurrencyCode"], "USD")
        self.assertEqual(b["defaultRawMarketPrice"], 42.99)

    def test_usd_wins_when_usd_first(self):
        # order-independent: USD still wins
        b = build_scrydex_pricing_bundle_from_card_payload(_card([USD_NM, JPY_NM]))
        self.assertEqual(_nm(b)["market"], 42.99)
        self.assertEqual(_nm(b)["currencyCode"], "USD")

    def test_jpy_only_card_keeps_jpy(self):
        # non-TCGplayer tail: no USD price -> JPY stays (FX-converted at display time)
        b = build_scrydex_pricing_bundle_from_card_payload(_card([JPY_NM]))
        self.assertEqual(_nm(b)["market"], 4000.0)
        self.assertEqual(_nm(b)["currencyCode"], "JPY")
        self.assertEqual(b["displayCurrencyCode"], "JPY")

    def test_mixed_conditions_each_prefer_usd(self):
        prices = [
            JPY_NM, USD_NM,
            {"type": "raw", "condition": "LP", "market": 5000.0, "currency": "JPY"},
            {"type": "raw", "condition": "LP", "market": 29.3, "currency": "USD"},
        ]
        b = build_scrydex_pricing_bundle_from_card_payload(_card(prices))
        conditions = next(iter(b["rawContexts"]["variants"].values()))["conditions"]
        self.assertEqual(conditions["NM"]["market"], 42.99)
        self.assertEqual(conditions["LP"]["market"], 29.3)


if __name__ == "__main__":
    unittest.main()
