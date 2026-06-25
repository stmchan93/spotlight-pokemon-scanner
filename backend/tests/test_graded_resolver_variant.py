"""Regression for the graded resolver wrong-variant / noisy-record bug.

base1-4 (Base Set Charizard) stores several printings under one card id with
multiple, noisy price records per grade. The resolver must (1) prefer the base
"Unlimited Holofoil" printing when no exact variant is requested — never a
1st-Edition / Shadowless / Metal record by storage order — and (2) pick the median
market among duplicate records so a raw price mislabeled as a PSA 9 ($632) or a
shadowless leak ($9,885) can't be surfaced. It must still honor an explicit variant.
"""

from catalog_tools import _resolve_graded_context_entry


def _entry(variant, market):
    return {"variant": variant, "market": market, "low": market, "high": market,
            "isPerfect": False, "isSigned": False, "isError": False, "currencyCode": "USD"}


# Mirrors the real stored ordering: novelty/1st-Ed/Metal come FIRST (the old bug).
GRADED = {
    "graders": {
        "PSA": {
            "9": [
                _entry("First Edition Shadowless Holofoil", 45845.8),
                _entry("Metal", 658.46),
                _entry("Metal", 4326.31),
                _entry("Unlimited Holofoil", 3407.55),
                _entry("Unlimited Holofoil", 632.0),       # raw price mislabeled as PSA 9
                _entry("Unlimited Holofoil", 9885.03),      # shadowless leak
                _entry("Unlimited Shadowless Holofoil", 11052.57),
                _entry("Unlimited Shadowless Holofoil", 4625.75),
            ],
            "7": [
                _entry("First Edition Shadowless Holofoil", 24621.34),
                _entry("First Edition Shadowless Holofoil", 7004.0),
                _entry("Metal", 218.08),
                _entry("Unlimited Holofoil", 764.87),
                _entry("Unlimited Holofoil", 1100.31),
                _entry("Unlimited Holofoil", 4528.64),
                _entry("Unlimited Shadowless Holofoil", 3214.98),
                _entry("Unlimited Shadowless Holofoil", 2010.86),
            ],
        }
    }
}


def test_no_variant_picks_base_printing_not_first_edition_or_metal():
    # PSA 7 with no variant must NOT return the $7,004 first-edition record.
    e = _resolve_graded_context_entry(GRADED, grader="PSA", grade="7", variant=None)
    assert "Unlimited Holofoil" in e["variant"]
    assert "First Edition" not in e["variant"] and "Metal" not in e["variant"]
    assert e["market"] == 1100.31  # median of [764.87, 1100.31, 4528.64]

    e9 = _resolve_graded_context_entry(GRADED, grader="PSA", grade="9", variant=None)
    assert "Unlimited Holofoil" in e9["variant"] and "Shadowless" not in e9["variant"]
    assert e9["market"] == 3407.55  # median of [632, 3407.55, 9885.03] — junk excluded


def test_explicit_variant_uses_median_not_first_record():
    e = _resolve_graded_context_entry(GRADED, grader="PSA", grade="9", variant="Unlimited Holofoil")
    assert e["market"] == 3407.55  # not the $632 first record, not the $9,885 leak


def test_explicit_shadowless_is_still_honored():
    e = _resolve_graded_context_entry(GRADED, grader="PSA", grade="7", variant="Unlimited Shadowless Holofoil")
    assert "Shadowless" in e["variant"]
    assert e["market"] == 3214.98  # median of [2010.86, 3214.98]


def test_unknown_grade_returns_none():
    assert _resolve_graded_context_entry(GRADED, grader="PSA", grade="999", variant=None) is None
