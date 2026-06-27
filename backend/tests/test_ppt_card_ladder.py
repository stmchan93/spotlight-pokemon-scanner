from __future__ import annotations

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from ppt_card_ladder import (  # noqa: E402
    card_ladder_value_for_grade,
    card_ladder_values_from_card,
    confidence_from_recency,
    dedupe_relists,
    last_sold_value,
    normalize_sales,
)

AS_OF = date(2026, 6, 25)


def sale(price, day, title="Umbreon VMAX 215/203 PSA 10"):
    return {"price": price, "soldDate": day, "title": title}


class ConfidenceTests(unittest.TestCase):
    def test_recency_thresholds(self) -> None:
        self.assertEqual(confidence_from_recency(AS_OF - timedelta(days=0), AS_OF), 5)
        self.assertEqual(confidence_from_recency(AS_OF - timedelta(days=14), AS_OF), 5)
        self.assertEqual(confidence_from_recency(AS_OF - timedelta(days=15), AS_OF), 4)
        self.assertEqual(confidence_from_recency(AS_OF - timedelta(days=30), AS_OF), 4)
        self.assertEqual(confidence_from_recency(AS_OF - timedelta(days=31), AS_OF), 3)
        self.assertEqual(confidence_from_recency(AS_OF - timedelta(days=90), AS_OF), 3)
        self.assertEqual(confidence_from_recency(AS_OF - timedelta(days=91), AS_OF), 2)
        self.assertEqual(confidence_from_recency(AS_OF - timedelta(days=180), AS_OF), 2)
        self.assertEqual(confidence_from_recency(AS_OF - timedelta(days=181), AS_OF), 1)


class LastSoldTests(unittest.TestCase):
    def test_averages_the_most_recent_day(self) -> None:
        sales = normalize_sales([
            sale(4500, "2026-06-24", "A"),
            sale(4600, "2026-06-24", "B"),  # same day, different item -> averaged
            sale(4000, "2026-06-10", "C"),  # older -> ignored for value
        ])
        result = last_sold_value(sales)
        assert result is not None
        self.assertEqual(result["value"], 4550.0)
        self.assertEqual(result["lastSoldDate"], "2026-06-24")
        self.assertEqual(result["count"], 2)

    def test_dedupes_relisted_duplicate(self) -> None:
        # Same title + price one day apart = a relisted/re-scraped duplicate -> one sale.
        sales = normalize_sales([
            sale(4500, "2026-06-24"),
            sale(4500, "2026-06-25"),  # relist of the same item
        ])
        deduped = dedupe_relists(sales)
        self.assertEqual(len(deduped), 1)
        result = last_sold_value(sales)
        assert result is not None
        self.assertEqual(result["value"], 4500.0)
        self.assertEqual(result["count"], 1)


class CardLadderValueTests(unittest.TestCase):
    def test_recent_own_sale_uses_last_sold(self) -> None:
        sbg = {"psa10": [sale(4500, "2026-06-24"), sale(4600, "2026-06-24", "B")]}
        out = card_ladder_value_for_grade("psa10", sbg, AS_OF)
        assert out is not None
        self.assertEqual(out["method"], "last_sold")
        self.assertEqual(out["value"], 4550.0)
        self.assertEqual(out["confidence"], 5)

    def test_stale_own_sale_falls_back_to_grade_ratio(self) -> None:
        sbg = {
            # PSA 10's own most-recent sale is ~175 days old (stale, conf 2).
            "psa10": [sale(4000, "2025-06-01", "old"), sale(4200, "2026-01-01", "old2")],
            # PSA 9 sold recently; historical PSA9 sales pair with PSA10 within 6mo.
            "psa9": [sale(2000, "2025-06-05", "c1"), sale(2100, "2026-06-20", "c2")],
        }
        out = card_ladder_value_for_grade("psa10", sbg, AS_OF)
        assert out is not None
        self.assertEqual(out["method"], "grade_ratio")
        self.assertEqual(out["sourceGrade"], "psa9")
        # ratio ~2.0 (4000/2000, 4200/2100) x comp last-sold 2100 = ~4200.
        self.assertAlmostEqual(out["value"], 4200.0, delta=1.0)
        self.assertLessEqual(out["confidence"], 3)

    def test_stale_own_sale_no_comp_keeps_low_confidence(self) -> None:
        sbg = {"psa10": [sale(4200, "2026-01-01")]}  # ~175d old, no comp grades
        out = card_ladder_value_for_grade("psa10", sbg, AS_OF)
        assert out is not None
        self.assertEqual(out["method"], "last_sold")
        self.assertEqual(out["value"], 4200.0)
        self.assertEqual(out["confidence"], 2)

    def test_grade_never_sold_returns_none(self) -> None:
        # No anchor sales for PSA 10 -> can't form a ratio -> no value.
        sbg = {"psa10": [], "psa9": [sale(2100, "2026-06-20")]}
        self.assertIsNone(card_ladder_value_for_grade("psa10", sbg, AS_OF))


class CardPayloadTests(unittest.TestCase):
    def test_values_from_card_payload(self) -> None:
        card = {
            "tcgPlayerId": "246723",
            "ebay": {"soldListings": {
                "psa10": [sale(4500, "2026-06-24"), sale(4600, "2026-06-24", "B")],
                "psa9": [sale(2300, "2026-06-22", "c")],
            }},
        }
        values = card_ladder_values_from_card(card, "2026-06-25")
        self.assertEqual(values["psa10"]["value"], 4550.0)
        self.assertEqual(values["psa10"]["confidence"], 5)
        self.assertEqual(values["psa9"]["value"], 2300.0)

    def test_no_sold_listings_yields_empty(self) -> None:
        self.assertEqual(card_ladder_values_from_card({"ebay": {"salesByGrade": {}}}, "2026-06-25"), {})


if __name__ == "__main__":
    unittest.main()
