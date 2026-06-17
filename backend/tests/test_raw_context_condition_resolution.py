"""Regression tests for raw-context condition resolution.

Bug (2026-06-17): a raw deck entry with `variant_name=NULL` and a non-NM
condition (e.g. Lightly Played) showed "—" in the Collection even though
Scrydex priced that condition. Two causes:

1. `_normalized_condition_code` only upper-cased its input, so the deck's
   snake_case condition ("lightly_played") became "LIGHTLY_PLAYED" and never
   matched the "LP" key in the raw price context.
2. `_resolve_raw_context_summary` ignored the requested condition entirely
   when no variant was supplied, dropping straight to the NM default.

Real data that motivated this: Marill 232/217 (me2pt5-232), Holofoil —
NM $17.06, LP $16.86, MP $14.99, DM $12.00.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    _normalized_condition_code,
    _resolve_raw_context_summary,
)


def _marill_raw_contexts() -> dict:
    def entry(code: str, market: float) -> dict:
        return {
            "currencyCode": "USD",
            "market": market,
            "condition": code,
            "payload": {"variant": "Holofoil", "condition": code},
        }

    return {
        "variants": {
            "Holofoil": {
                "conditions": {
                    "NM": entry("NM", 17.06),
                    "LP": entry("LP", 16.86),
                    "MP": entry("MP", 14.99),
                    "DM": entry("DM", 12.00),
                }
            }
        }
    }


class NormalizedConditionCodeTest(unittest.TestCase):
    def test_maps_snake_case_to_two_letter_code(self) -> None:
        self.assertEqual(_normalized_condition_code("lightly_played"), "LP")
        self.assertEqual(_normalized_condition_code("near_mint"), "NM")
        self.assertEqual(_normalized_condition_code("moderately_played"), "MP")
        self.assertEqual(_normalized_condition_code("heavily_played"), "HP")
        self.assertEqual(_normalized_condition_code("damaged"), "DM")

    def test_passes_through_existing_codes_and_defaults(self) -> None:
        self.assertEqual(_normalized_condition_code("LP"), "LP")
        self.assertEqual(_normalized_condition_code("lp"), "LP")
        self.assertEqual(_normalized_condition_code(None), "NM")
        self.assertEqual(_normalized_condition_code(""), "NM")


class ResolveRawContextSummaryConditionTest(unittest.TestCase):
    def test_variantless_lightly_played_resolves_lp_price(self) -> None:
        raw = _marill_raw_contexts()
        variant, condition, summary = _resolve_raw_context_summary(
            raw, variant=None, condition="lightly_played"
        )
        self.assertEqual(variant, "Holofoil")
        self.assertEqual(condition, "LP")
        self.assertEqual(summary["market"], 16.86)

    def test_variantless_moderately_played_resolves_mp_price(self) -> None:
        _, condition, summary = _resolve_raw_context_summary(
            _marill_raw_contexts(), variant=None, condition="moderately_played"
        )
        self.assertEqual(condition, "MP")
        self.assertEqual(summary["market"], 14.99)

    def test_variantless_no_condition_still_defaults_to_nm(self) -> None:
        # Unchanged behavior: no condition requested -> NM default.
        variant, condition, summary = _resolve_raw_context_summary(
            _marill_raw_contexts(), variant=None, condition=None
        )
        self.assertEqual(variant, "Holofoil")
        self.assertEqual(condition, "NM")
        self.assertEqual(summary["market"], 17.06)

    def test_variantless_heavily_played_with_no_hp_comp_uses_nearest_condition(self) -> None:
        # Marill has NM/LP/MP/DM but no HP. A Heavily Played add must show the
        # nearest available real price; MP and DM are equidistant from HP, so the
        # closer playable grade (MP) wins — never "—" and never the inflated NM.
        _, condition, summary = _resolve_raw_context_summary(
            _marill_raw_contexts(), variant=None, condition="heavily_played"
        )
        self.assertEqual(condition, "MP")
        self.assertEqual(summary["market"], 14.99)

    def test_missing_condition_falls_back_through_priority(self) -> None:
        # A requested condition with no entry falls back to the best available
        # (priority NM, LP, MP, HP, DM) rather than returning nothing.
        raw = {
            "variants": {"Holofoil": {"conditions": {"NM": {"market": 5.0, "condition": "NM"}}}}
        }
        _, condition, summary = _resolve_raw_context_summary(
            raw, variant=None, condition="heavily_played"
        )
        self.assertEqual(condition, "NM")
        self.assertEqual(summary["market"], 5.0)


if __name__ == "__main__":
    unittest.main()
