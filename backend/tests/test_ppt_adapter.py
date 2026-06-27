"""Tests for ppt_adapter: PPT card record -> raw/graded contexts.

Includes a round-trip: the contexts the adapter builds must resolve through the
SAME resolvers the app uses (resolve_graded_entry_from_cells / the raw resolver),
proving PPT data is a drop-in for Scrydex pricing with no read-path changes.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    price_history_cells_from_contexts,
    resolve_graded_entry_from_cells,
    resolve_raw_summary_from_cells,
)
from ppt_adapter import (  # noqa: E402
    build_card_population,
    build_population_entry,
    build_ppt_graded_contexts,
    build_ppt_pricing_bundle,
    build_ppt_raw_contexts,
    parse_ppt_grade_key,
)


# Realistic PPT Moonbreon (swsh7-215) record, shaped from the live probe + schema.
PPT_MOONBREON = {
    "tcgPlayerId": "246723",
    "externalCatalogId": "swsh7-215",
    "name": "Umbreon VMAX (Alternate Art Secret)",
    "prices": {"market": 2276.45, "low": 1999.0, "primaryPrinting": "Holofoil"},
    "variants": {
        "Holofoil": {
            "Near Mint": {"price": 2276.45, "priceString": "$2,276.45"},
            "Lightly Played": {"price": 1850.0},
        }
    },
    "ebay": {
        "salesByGrade": {
            "psa10": {"medianPrice": 4524.88, "minPrice": 4100.0, "maxPrice": 4900.0,
                      "averagePrice": 4500.0, "marketPrice7Day": 4480.0, "count": 37},
            "psa9": {"medianPrice": 2305.0, "minPrice": 2000.0, "maxPrice": 2500.0, "count": 12},
            "cgc9_5": {"medianPrice": 2566.77, "count": 5},
            "bgs10": {"medianPrice": 4401.53, "count": 3},
            "tag10": {"medianPrice": 3489.52, "count": 2},
            "weird_key!": {"medianPrice": 1.0},
            "psa8": {"count": 1},  # no price -> skipped
        }
    },
}

_CELL_COLS = (
    "card_id", "provider", "price_date", "lane", "cell_key", "variant_key",
    "condition", "grader", "grade", "is_perfect", "is_signed", "is_error",
    "currency_code", "low", "market", "mid", "high", "direct_low", "trend", "updated_at",
)


class PptGradeKeyTests(unittest.TestCase):
    def test_parses_company_and_grade(self):
        self.assertEqual(parse_ppt_grade_key("psa10"), ("PSA", "10"))
        self.assertEqual(parse_ppt_grade_key("cgc9_5"), ("CGC", "9.5"))
        self.assertEqual(parse_ppt_grade_key("bgs9_5"), ("BGS", "9.5"))
        self.assertEqual(parse_ppt_grade_key("sgc9"), ("SGC", "9"))
        self.assertEqual(parse_ppt_grade_key("ace10"), ("ACE", "10"))

    def test_none_on_unparseable(self):
        self.assertIsNone(parse_ppt_grade_key("weird_key!"))
        self.assertIsNone(parse_ppt_grade_key(""))


class PptContextsTests(unittest.TestCase):
    def test_graded_contexts_mapping(self):
        graded = build_ppt_graded_contexts(PPT_MOONBREON)["graders"]
        self.assertEqual(set(graded.keys()), {"PSA", "CGC", "BGS", "TAG"})  # psa8/weird skipped
        psa10 = graded["PSA"]["10"][0]
        self.assertEqual(psa10["market"], 4524.88)
        self.assertEqual(psa10["low"], 4100.0)
        self.assertEqual(psa10["high"], 4900.0)
        self.assertEqual(psa10["trend"], 4480.0)
        # PPT graded is flat -> all flags False (signed-leak class cannot occur).
        self.assertFalse(psa10["isSigned"] or psa10["isPerfect"] or psa10["isError"])
        self.assertEqual(graded["CGC"]["9.5"][0]["market"], 2566.77)

    def test_raw_contexts_mapping(self):
        conditions = build_ppt_raw_contexts(PPT_MOONBREON)["variants"]["Holofoil"]["conditions"]
        self.assertEqual(conditions["NM"]["market"], 2276.45)
        self.assertEqual(conditions["LP"]["market"], 1850.0)
        self.assertIsNone(conditions["NM"]["low"])  # PPT has no low/mid/high per condition
        self.assertIsNone(conditions["NM"]["high"])

    def test_graded_prefers_smart_market_when_confident(self):
        card = {"ebay": {"salesByGrade": {
            "psa10": {"medianPrice": 3499, "smartMarketPrice": 4525, "smartMarketConfidence": "high",
                      "marketPrice7Day": 4500},
            "psa9": {"medianPrice": 1900, "smartMarketPrice": 46, "smartMarketConfidence": "low"},
        }}}
        graded = build_ppt_graded_contexts(card)["graders"]["PSA"]
        # high confidence -> smartMarketPrice (current market, not the lagging median)
        self.assertEqual(graded["10"][0]["market"], 4525)
        # low confidence -> fall back to median (low-confidence smart can be wild)
        self.assertEqual(graded["9"][0]["market"], 1900)

    def test_raw_headline_used_when_variants_absent(self):
        card = {"prices": {"market": 99.5, "low": 80.0, "primaryPrinting": "Normal"}}
        conditions = build_ppt_raw_contexts(card)["variants"]["Normal"]["conditions"]
        self.assertEqual(conditions["NM"]["market"], 99.5)
        self.assertEqual(conditions["NM"]["low"], 80.0)

    def test_pricing_bundle_carries_join_key(self):
        bundle = build_ppt_pricing_bundle(PPT_MOONBREON)
        self.assertEqual(bundle["tcgplayer_id"], "246723")
        self.assertEqual(bundle["external_catalog_id"], "swsh7-215")
        self.assertTrue(bundle["raw_contexts"]["variants"])
        self.assertTrue(bundle["graded_contexts"]["graders"])


class PptRoundTripTests(unittest.TestCase):
    def test_roundtrip_through_real_resolvers(self):
        # adapter contexts -> cells -> the SAME resolvers the app uses.
        bundle = build_ppt_pricing_bundle(PPT_MOONBREON)
        cells = price_history_cells_from_contexts(
            card_id="swsh7-215", provider="ppt", price_date="2026-06-25",
            currency_code="USD", raw_contexts=bundle["raw_contexts"],
            graded_contexts=bundle["graded_contexts"], updated_at="2026-06-25T00:00:00Z",
        )
        rows = [dict(zip(_CELL_COLS, c)) for c in cells]

        graded = resolve_graded_entry_from_cells(rows, grader="PSA", grade="10", variant=None)
        self.assertIsNotNone(graded)
        self.assertEqual(graded["market"], 4524.88)
        self.assertFalse(graded["is_signed"])

        _, _, raw_summary = resolve_raw_summary_from_cells(rows, variant="Holofoil", condition="NM")
        self.assertIsNotNone(raw_summary)
        self.assertEqual(raw_summary["market"], 2276.45)


class PptPopulationTests(unittest.TestCase):
    # The documented GemrateData example from the PPT /population spec.
    GEMRATE = {
        "tcgPlayerId": "490294",
        "populationByGrader": {
            "PSA": {"g10": 2500, "g9": 9500, "totalPopulation": 12000, "gemRate": 20.83},
            "BGS": {"g10": 100, "g9_5": 730, "pristine": 50, "perfect": 10,
                    "totalPopulation": 1830, "gemRate": 7.1},
            "SGC": {"g10": 30, "g9": 100, "totalPopulation": 130, "gemRate": 23.08},
        },
    }

    def test_build_card_population_normalizes_grades_and_meta(self):
        out = build_card_population(self.GEMRATE)
        self.assertEqual(set(out), {"PSA", "BGS", "SGC"})
        self.assertEqual(out["PSA"]["grades"], {"10": 2500, "9": 9500})
        self.assertEqual(out["PSA"]["totalPopulation"], 12000)
        self.assertEqual(out["PSA"]["gemRate"], 20.83)
        # Half grades become dotted decimals; non-grade meta (pristine/perfect) dropped.
        self.assertEqual(out["BGS"]["grades"], {"10": 100, "9.5": 730})

    def test_total_population_falls_back_to_grade_sum(self):
        entry = build_population_entry({"g10": 5, "g9": 7})
        self.assertEqual(entry["totalPopulation"], 12)
        self.assertIsNone(entry["gemRate"])

    def test_grader_without_grade_counts_is_dropped(self):
        self.assertIsNone(build_population_entry({"gemRate": 5, "totalPopulation": 100}))
        self.assertEqual(build_card_population({"populationByGrader": {"PSA": {"gemRate": 5}}}), {})

    def test_string_counts_coerce(self):
        entry = build_population_entry(
            {"g10": "1,234", "g9_5": "50", "totalPopulation": "2000", "gemRate": "12.5"}
        )
        self.assertEqual(entry["grades"], {"10": 1234, "9.5": 50})
        self.assertEqual(entry["totalPopulation"], 2000)
        self.assertEqual(entry["gemRate"], 12.5)

    def test_malformed_input_is_safe(self):
        self.assertEqual(build_card_population({}), {})
        self.assertEqual(build_card_population({"populationByGrader": None}), {})
        self.assertIsNone(build_population_entry("nope"))

    def test_live_api_shape_beckett_alias_fraction_gemrate_and_zero_drop(self):
        # Shape from a real /population response: Beckett is keyed "BECKETT", the
        # per-grader gemRate is a 0–1 fraction, and the grade ladder is mostly zeros.
        live = {
            "tcgPlayerId": "490294",
            "populationByGrader": {
                "PSA": {"g1": 0, "g6": 4, "g7": 14, "g8": 69, "g9": 240, "g10": 179,
                        "g8_5": 1, "g9_5": 0, "qualifiers": 4, "totalPopulation": 513,
                        "gemRate": 0.3489278752436647},
                "BECKETT": {"g6": 1, "g8": 1, "g9": 6, "g10": 0, "totalPopulation": 13,
                            "gemRate": 0.3076923076923077},
            },
        }
        out = build_card_population(live)
        # Beckett → BGS so the app's BGS lane resolves.
        self.assertEqual(set(out), {"PSA", "BGS"})
        # Zero-count grades dropped (no "1", no "9.5"); half grade kept when nonzero.
        self.assertEqual(out["PSA"]["grades"], {"6": 4, "7": 14, "8": 69, "9": 240, "10": 179, "8.5": 1})
        # Fractional gemRate scaled to a percentage.
        self.assertAlmostEqual(out["PSA"]["gemRate"], 34.89278752436647)
        # BGS had g10=0 → dropped; only its nonzero grades remain.
        self.assertEqual(out["BGS"]["grades"], {"6": 1, "8": 1, "9": 6})


if __name__ == "__main__":
    unittest.main()
