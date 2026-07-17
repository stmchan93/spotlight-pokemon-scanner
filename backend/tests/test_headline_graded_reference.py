"""Headline graded reference for graded-only cards.

Graded-only grails (e.g. Poncho-wearing Pikachu 207/XY-P) have NO raw price, so a
scan candidate would otherwise carry no price. build_headline_graded_reference
surfaces the headline graded value (PSA 10 preferred, else highest market),
skipping signed/perfect/error outliers, and only when there is no raw price.
"""

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import build_headline_graded_reference  # noqa: E402


def _graded(graders):
    return {"graders": graders}


def test_prefers_psa_10_and_flags_it_a_reference():
    graded = _graded(
        {
            "PSA": {
                "10": [{"market": 24824.52, "variant": "Holofoil", "currencyCode": "USD"}],
                "9": [{"market": 13564.99, "variant": "Holofoil"}],
            },
            "BGS": {"10": [{"market": 22978.67, "variant": "Holofoil"}]},
        }
    )
    ref = build_headline_graded_reference("xyp_ja-207", {"variants": {}}, graded)
    assert ref is not None
    assert ref["pricingMode"] == "graded_reference"
    assert ref["isGradedReference"] is True
    assert ref["grader"] == "PSA"
    assert ref["grade"] == "10"
    assert ref["market"] == 24824.52
    assert ref["currencyCode"] == "USD"


def test_returns_none_when_the_card_has_raw_pricing():
    graded = _graded({"PSA": {"10": [{"market": 500.0}]}})
    raw = {"variants": {"Holofoil": {"conditions": {"NM": {"market": 14.54}}}}}
    assert build_headline_graded_reference("c1", raw, graded) is None


def test_returns_none_without_graded_pricing():
    assert build_headline_graded_reference("c1", {"variants": {}}, {"graders": {}}) is None
    assert build_headline_graded_reference("c1", {"variants": {}}, None) is None


def test_falls_back_to_highest_market_when_no_psa_10():
    graded = _graded(
        {
            "CGC": {"10": [{"market": 9468.54, "variant": "Holofoil"}]},
            "BGS": {"9.5": [{"market": 14516.31, "variant": "Holofoil"}]},
        }
    )
    ref = build_headline_graded_reference("c1", {"variants": {}}, graded)
    assert ref is not None
    assert ref["grader"] == "BGS"
    assert ref["grade"] == "9.5"
    assert ref["market"] == 14516.31


def test_skips_signed_perfect_error_outliers():
    graded = _graded(
        {
            "PSA": {
                "10": [
                    {"market": 99999.0, "variant": "Holofoil", "isSigned": True},
                    {"market": 88888.0, "variant": "Holofoil", "isPerfect": True},
                    {"market": 77777.0, "variant": "Holofoil", "isError": True},
                    {"market": 24824.52, "variant": "Holofoil"},
                ]
            }
        }
    )
    ref = build_headline_graded_reference("c1", {"variants": {}}, graded)
    assert ref is not None
    assert ref["market"] == 24824.52  # the clean comp, not the autograph/one-off


def test_returns_none_when_every_graded_entry_is_flagged():
    graded = _graded({"PSA": {"10": [{"market": 99999.0, "isSigned": True}]}})
    assert build_headline_graded_reference("c1", {"variants": {}}, graded) is None
