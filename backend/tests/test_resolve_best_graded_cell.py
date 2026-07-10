"""Parity guard for `_resolve_best_graded_cell` — the cells twin of the RANKED
graded resolver `_resolve_best_graded_context_entry` (the one the current-price
display path uses). The June 2026 cutover attempts failed because the cells side
lacked this ranked tier; this test pins tier-by-tier agreement using the REAL
base1-63 (Base Set Charizard) PSA-10 pool pulled from the staging DB 2026-07-10:

    variant                    market    flags
    First Edition Shadowless    305.13   —
    Jumbo                       268.41   —
    Unlimited                   428.81   —
    Unlimited                   275.00   signed
    Unlimited Shadowless        953.21   —
    Unlimited Shadowless       1775.00   error   <- the June "$1775" leak

Every scenario asserts BOTH resolvers pick the same variant+market, so the
cells cutover cannot re-introduce the wrong-variant class.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import unittest

from server import SpotlightScanService  # noqa: E402

# The real pool, expressed in both storage formats.
_POOL = [
    # (json_variant_label, cells_variant_key, market, perfect, signed, error)
    ("First Edition Shadowless", "firstEditionShadowless", 305.13, False, False, False),
    ("Jumbo", "jumbo", 268.41, False, False, False),
    ("Unlimited", "unlimited", 428.81, False, False, False),
    ("Unlimited", "unlimited", 275.0, False, True, False),
    ("Unlimited Shadowless", "unlimitedShadowless", 953.21, False, False, False),
    ("Unlimited Shadowless", "unlimitedShadowless", 1775.0, False, False, True),
]


def _json_contexts() -> dict:
    return {
        "graders": {
            "PSA": {
                "10": [
                    {
                        "variant": label,
                        "market": market,
                        "currencyCode": "USD",
                        "isPerfect": perfect,
                        "isSigned": signed,
                        "isError": error,
                    }
                    for (label, _key, market, perfect, signed, error) in _POOL
                ]
            }
        }
    }


def _cells() -> list[dict]:
    return [
        {
            "lane": "graded",
            "grader": "PSA",
            "grade": "10",
            "variant_key": key,
            "market": market,
            "currency_code": "USD",
            "is_perfect": int(perfect),
            "is_signed": int(signed),
            "is_error": int(error),
        }
        for (_label, key, market, perfect, signed, error) in _POOL
    ]


class ResolveBestGradedCellParityTests(unittest.TestCase):
    def _both(self, *, preferred_variant=None, variant_hints=None):
        json_entry = SpotlightScanService._resolve_best_graded_context_entry(
            _json_contexts(),
            grader="PSA",
            grade="10",
            preferred_variant=preferred_variant,
            variant_hints=variant_hints,
        )
        cell = SpotlightScanService._resolve_best_graded_cell(
            _cells(),
            grader="PSA",
            grade="10",
            preferred_variant=preferred_variant,
            variant_hints=variant_hints,
        )
        return json_entry, cell

    def _assert_agree(self, json_entry, cell, *, market):
        self.assertIsNotNone(json_entry)
        self.assertIsNotNone(cell)
        self.assertEqual(json_entry.get("market"), market)
        self.assertEqual(cell["market"], market)

    def test_tier2_no_hints_picks_base_printing(self) -> None:
        # No preferred variant, no hints → base printing (Unlimited), median of
        # its non-special records → 428.81, NEVER the $1775 error cell.
        json_entry, cell = self._both()
        self._assert_agree(json_entry, cell, market=428.81)

    def test_tier1_preferred_variant_exact(self) -> None:
        json_entry, cell = self._both(preferred_variant="Unlimited Shadowless")
        self._assert_agree(json_entry, cell, market=953.21)

    def test_tier1_preferred_variant_cells_spelling(self) -> None:
        # The slab's stored variant may arrive in the camelCase key spelling.
        json_entry, cell = self._both(preferred_variant="unlimitedShadowless")
        self._assert_agree(json_entry, cell, market=953.21)

    def test_tier3_shadowless_hint(self) -> None:
        hints = {"shadowless": True, "firstEdition": False, "redCheeks": False, "yellowCheeks": False, "jumbo": False}
        json_entry, cell = self._both(variant_hints=hints)
        self._assert_agree(json_entry, cell, market=953.21)

    def test_tier3_first_edition_hint(self) -> None:
        hints = {"shadowless": True, "firstEdition": True, "redCheeks": False, "yellowCheeks": False, "jumbo": False}
        json_entry, cell = self._both(variant_hints=hints)
        self._assert_agree(json_entry, cell, market=305.13)

    def test_tier3_plain_label_hints_pick_base(self) -> None:
        # A label with no novelty markers (firstEdition=None per the inference
        # rules) must still land on Unlimited — not Shadowless, not the error.
        hints = {"shadowless": False, "firstEdition": None, "redCheeks": False, "yellowCheeks": False, "jumbo": False}
        json_entry, cell = self._both(variant_hints=hints)
        self._assert_agree(json_entry, cell, market=428.81)

    def test_error_cell_never_wins(self) -> None:
        # Across every scenario in this file the $1775 error record must lose.
        for kwargs in (
            {},
            {"preferred_variant": "Unlimited Shadowless"},
            {"variant_hints": {"shadowless": True, "firstEdition": False, "redCheeks": False, "yellowCheeks": False, "jumbo": False}},
        ):
            json_entry, cell = self._both(**kwargs)
            self.assertNotEqual(json_entry.get("market"), 1775.0)
            self.assertNotEqual(cell["market"], 1775.0)

    def test_corrupt_guard_is_cells_only_and_deliberate(self) -> None:
        # A garbage pull far below peer graders: cells return None (guard);
        # JSON surfaces it. This asymmetry is INTENTIONAL — pinned here so the
        # harness's "guard-trip" bucket has a documented contract.
        cells = _cells() + [
            {"lane": "graded", "grader": g, "grade": "10", "variant_key": "unlimited",
             "market": m, "currency_code": "USD", "is_perfect": 0, "is_signed": 0, "is_error": 0}
            for g, m in (("BGS", 2000.0), ("CGC", 1900.0), ("ACE", 2100.0))
        ]
        # Make PSA-10's only plain record collapse to 30 (< 0.25 * peer median).
        for c in cells:
            if c["grader"] == "PSA" and c["market"] == 428.81:
                c["market"] = 30.0
        cell = SpotlightScanService._resolve_best_graded_cell(
            cells, grader="PSA", grade="10", variant_hints=None
        )
        self.assertIsNone(cell)


if __name__ == "__main__":
    unittest.main()
