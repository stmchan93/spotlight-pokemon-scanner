"""PPT sold-listing merge: verification tiers, grade bucketing, serve order,
and the server's serve-time filter + recent-average headline."""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import server  # noqa: E402
from recent_sales_merge import (  # noqa: E402
    clean_ppt_title,
    merge_ppt_sold_listings,
    ppt_only_rows_for_grade,
    ppt_row_to_sale,
    sale_verification,
    verify_aspects,
    verify_title,
)

GENGAR = {
    "id": "swsh8-157",
    "name": "Gengar VMAX",
    "number": "157/264",
    "set_name": "Fusion Strike",
    "language": "English",
}
CHARIZARD_CLASSIC = {
    "id": "clc-3",
    "name": "Charizard",
    "number": "003/034",
    "set_name": "Pokémon TCG Classic - Charizard",
    "language": "English",
}
MEW_PROMO = {"id": "basep-8", "name": "Mew", "number": "8", "set_name": "Wizards Black Star Promos", "language": "English"}


def _days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y/%m/%d")


class VerifyTitleTests(unittest.TestCase):
    def test_full_identity_in_title_passes(self):
        title = "2021 Pokemon Fusion Strike Gengar VMAX 157/264 Full Art PSA 10 GEM MINT"
        self.assertTrue(verify_title(title, card=GENGAR, grader="PSA", grade="10"))

    def test_ppt_sold_prefix_is_stripped(self):
        self.assertEqual(clean_ppt_title("Sold  Oct 9, 2025CGC 10 Ditto"), "CGC 10 Ditto")
        title = "Sold  Sep 6, 2026Pokemon Fusion Strike Gengar VMAX 157/264 PSA 10"
        self.assertTrue(verify_title(title, card=GENGAR, grader="PSA", grade="10"))

    def test_html_entities_and_slash_joined_names_pass(self):
        title = "Pokemon 2021 Sword &amp; Shield Fusion Strike #157 FA/Gengar VMAX PSA 10"
        self.assertTrue(verify_title(title, card=GENGAR, grader="PSA", grade="10"))

    def test_gem_mint_before_number_and_page_chrome_suffix(self):
        title = "2021 Pokemon Gengar VMAX PSA 10 Gem Mint 157/264 Swsh08: Fusion StrikeOpens in a new window or tab"
        self.assertTrue(verify_title(title, card=GENGAR, grader="PSA", grade="10"))
        self.assertTrue(verify_title("PSA 10 Gengar VMAX FUSION STRIKE 157/264 GEM MINT", card=GENGAR, grader="PSA", grade="10"))

    def test_wrong_number_or_missing_set_fails(self):
        self.assertFalse(verify_title("Gengar VMAX 271/264 Fusion Strike PSA 10", card=GENGAR, grader="PSA", grade="10"))
        self.assertFalse(verify_title("Gengar VMAX 157/264 PSA 10 alt art", card=GENGAR, grader="PSA", grade="10"))

    def test_grade_cannot_double_as_collector_number(self):
        # Card #10 must not match on the "PSA 10" token alone.
        card = dict(GENGAR, number="10/264")
        self.assertFalse(verify_title("Gengar VMAX Fusion Strike PSA 10", card=card, grader="PSA", grade="10"))

    def test_pristine_signed_lot_and_language_are_rejected(self):
        base = "Gengar VMAX 157/264 Fusion Strike CGC 10"
        self.assertTrue(verify_title(base, card=GENGAR, grader="CGC", grade="10"))
        self.assertFalse(verify_title(base + " Pristine", card=GENGAR, grader="CGC", grade="10"))
        self.assertFalse(verify_title(base + " signed by artist", card=GENGAR, grader="CGC", grade="10"))
        self.assertFalse(verify_title("Lot " + base, card=GENGAR, grader="CGC", grade="10"))
        self.assertFalse(verify_title(base + " Japanese", card=GENGAR, grader="CGC", grade="10"))

    def test_half_grade_and_leading_zero_numbers(self):
        title = "Pokemon Classic Charizard 3/34 CGC 9.5"
        self.assertTrue(verify_title(title, card=CHARIZARD_CLASSIC, grader="CGC", grade="9.5"))
        self.assertFalse(verify_title(title, card=CHARIZARD_CLASSIC, grader="CGC", grade="9"))

    def test_number_without_denominator_accepts_printed_set_size(self):
        mew = {"name": "Mew", "number": "11", "set_name": "Celebrations", "language": "English"}
        self.assertTrue(verify_title("Mew 011/025 Celebrations Holo PSA 9", card=mew, grader="PSA", grade="9"))
        self.assertTrue(verify_title("Celebrations Mew Holo #011/025 PSA 9", card=mew, grader="PSA", grade="9"))
        self.assertFalse(verify_title("Mew 025/025 Celebrations Holo PSA 9", card=mew, grader="PSA", grade="9"))

    def test_trailing_period_after_grade_and_singular_set_name(self):
        mew = {"name": "Mew", "number": "11", "set_name": "Celebrations", "language": "English"}
        self.assertTrue(verify_title("Mew 011/025 Holographic MINT PSA 9. Pokemon Celebrations", card=mew, grader="PSA", grade="9"))
        self.assertTrue(verify_title("2021 Pokémon Celebration - Mew 011/025 PSA 9", card=mew, grader="PSA", grade="9"))
        self.assertFalse(verify_title("Mew 011/025 Celebrations PSA 9.5", card=mew, grader="PSA", grade="9"))

    def test_loose_ppt_match_with_other_number_is_rejected(self):
        # PPT filed a $50k Gold Star Mew (promo 101) under the $8 Black Star Mew.
        title = "Pokemon Mew-Gold Star World Championships Promo 101 Empotech PSA 10 Gem Mint"
        self.assertFalse(verify_title(title, card=MEW_PROMO, grader="PSA", grade="10"))

    def test_promo_set_accepts_promo_word_and_hash_number(self):
        title = "Mew #8 Black Star Promo PSA 9 MINT"
        self.assertTrue(verify_title(title, card=MEW_PROMO, grader="PSA", grade="9"))


class VerifyAspectsTests(unittest.TestCase):
    def test_matching_specifics_verify(self):
        aspects = {"Card Number": "157/264", "Grade": "10", "Professional Grader": "Professional Sports Authenticator (PSA)", "Set": "Fusion Strike"}
        self.assertTrue(verify_aspects(aspects, card=GENGAR, grader="PSA", grade="10"))

    def test_number_or_grade_mismatch_rejects_even_if_title_would_pass(self):
        aspects = {"Card Number": "158/264", "Grade": "10", "Set": "Fusion Strike"}
        self.assertFalse(verify_aspects(aspects, card=GENGAR, grader="PSA", grade="10"))
        aspects = {"Card Number": "157/264", "Grade": "9", "Set": "Fusion Strike"}
        self.assertFalse(verify_aspects(aspects, card=GENGAR, grader="PSA", grade="10"))
        title = "Gengar VMAX 157/264 Fusion Strike PSA 10"
        row = {"listingId": "1", "title": title, "price": 200, "currency": "USD", "soldDate": "2026-09-01T00:00:00.000Z"}
        sale = ppt_row_to_sale(row, card=GENGAR, grader="PSA", grade="10", ebay_item={"aspects": aspects})
        self.assertEqual(sale_verification(sale), "unverified")

    def test_missing_specifics_defer_to_title(self):
        self.assertIsNone(verify_aspects({}, card=GENGAR, grader="PSA", grade="10"))
        self.assertIsNone(verify_aspects({"Set": "Fusion Strike"}, card=GENGAR, grader="PSA", grade="10"))

    def test_signed_feature_rejects(self):
        aspects = {"Card Number": "157/264", "Grade": "10", "Set": "Fusion Strike", "Features": "Signed"}
        self.assertFalse(verify_aspects(aspects, card=GENGAR, grader="PSA", grade="10"))


class MergeTests(unittest.TestCase):
    def _ppt_rows(self):
        return {
            # Already in Scrydex's list -> excluded from PPT-only rows.
            "100": {"listingId": "100", "gradeKey": "psa10", "title": "x", "price": 1, "currency": "USD", "soldDate": "2026-09-01T00:00:00.000Z"},
            "101": {"listingId": "101", "gradeKey": "psa10", "title": "Gengar VMAX 157/264 Fusion Strike PSA 10", "price": 230.0, "currency": "USD", "soldDate": "2026-09-05T00:00:00.000Z"},
            "102": {"listingId": "102", "gradeKey": "psa10", "title": "Gengar VMAX Fusion Strike PSA 10 (no number)", "price": 5.0, "currency": "USD", "soldDate": "2026-09-07T00:00:00.000Z"},
            "103": {"listingId": "103", "gradeKey": "psa9", "title": "Gengar VMAX 157/264 Fusion Strike PSA 9", "price": 90.0, "currency": "USD", "soldDate": "2026-09-06T00:00:00.000Z"},
            "104": {"listingId": "104", "gradeKey": "cgc9_5", "title": "Gengar VMAX 157/264 Fusion Strike CGC 9.5", "price": 80.0, "currency": "USD", "soldDate": "2026-09-06T00:00:00.000Z"},
        }

    def test_grade_bucket_and_scrydex_dedupe(self):
        rows = ppt_only_rows_for_grade(self._ppt_rows(), grader="PSA", grade="10", scrydex_item_ids={"100"})
        self.assertEqual([r["listingId"] for r in rows], ["102", "101"])
        rows = ppt_only_rows_for_grade(self._ppt_rows(), grader="CGC", grade="9.5", scrydex_item_ids=set())
        self.assertEqual([r["listingId"] for r in rows], ["104"])

    def test_merge_orders_verified_newest_first_and_keeps_unverified_last(self):
        sales = [
            {"title": "scrydex row", "soldAt": "2026/09/02", "price": 210.0, "currencyCode": "USD",
             "rank": 1, "listingURL": "https://www.ebay.com/itm/100", "sourcePayload": {}},
        ]
        rows = ppt_only_rows_for_grade(self._ppt_rows(), grader="PSA", grade="10", scrydex_item_ids={"100"})
        counts = merge_ppt_sold_listings(sales, rows, card=GENGAR, grader="PSA", grade="10")
        self.assertEqual(counts, {"scrydex": 1, "aspects": 0, "title": 1, "unverified": 1, "outlier": 0})
        self.assertEqual([sale_verification(s) for s in sales], ["title", "scrydex", "unverified"])
        # Cache rank is unique per row; Scrydex's own rank (1) must not survive.
        self.assertEqual([s["rank"] for s in sales], [1, 2, 3])
        self.assertEqual([s["soldAt"] for s in sales], ["2026/09/05", "2026/09/02", "2026/09/07"])
        ppt_sale = sales[0]
        self.assertEqual(ppt_sale["sourceSaleID"], "ppt:101")
        self.assertEqual(ppt_sale["listingURL"], "https://www.ebay.com/itm/101")
        self.assertEqual(ppt_sale["sourcePayload"]["_spotlight"]["origin"], "ppt")
        self.assertEqual(sales[1]["sourcePayload"]["_spotlight"]["origin"], "scrydex")

    def test_ebay_item_supplies_photo_and_aspect_verification(self):
        rows = [{"listingId": "102", "gradeKey": "psa10", "title": "Gengar VMAX Fusion Strike PSA 10", "price": 5.0,
                 "currency": "USD", "soldDate": "2026-09-07T00:00:00.000Z"}]
        ebay = {"102": {"imageURL": "https://i.ebayimg.com/x.jpg", "title": "Gengar VMAX Fusion Strike PSA 10",
                        "aspects": {"Card Number": "157/264", "Grade": "10", "Card Name": "Gengar VMAX"}}}
        sales: list = []
        counts = merge_ppt_sold_listings(sales, rows, card=GENGAR, grader="PSA", grade="10", ebay_items_by_item_id=ebay)
        self.assertEqual(counts["aspects"], 1)
        self.assertEqual(sales[0]["imageURL"], "https://i.ebayimg.com/x.jpg")


class OutlierTests(unittest.TestCase):
    def test_cheap_ppt_row_is_demoted_but_scrydex_row_is_not(self):
        title = "Gengar VMAX 157/264 Fusion Strike PSA 10"
        rows = [
            {"listingId": str(i), "gradeKey": "psa10", "title": title, "price": p, "currency": "USD",
             "soldDate": f"2026-09-0{i}T00:00:00.000Z"}
            for i, p in ((1, 230.0), (2, 220.0), (3, 23.5), (4, 240.0), (5, 210.0))
        ]
        sales = [{"title": title, "soldAt": "2026/09/06", "price": 30.0, "currencyCode": "USD",
                  "listingURL": "https://www.ebay.com/itm/9", "sourcePayload": {}}]
        counts = merge_ppt_sold_listings(sales, rows, card=GENGAR, grader="PSA", grade="10")
        self.assertEqual(counts["outlier"], 1)
        by_id = {s.get("sourceSaleID"): sale_verification(s) for s in sales}
        self.assertEqual(by_id["ppt:3"], "outlier")
        self.assertEqual(by_id[None], "scrydex")
        self.assertEqual(sale_verification(sales[-1]), "outlier")


class CacheWriteTests(unittest.TestCase):
    def test_merged_rows_round_trip_through_the_cache(self):
        import tempfile
        from catalog_tools import apply_schema, connect, replace_slab_recent_sales_cache, slab_recent_sales_cache, upsert_card

        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "merge.sqlite")
            apply_schema(conn, BACKEND_ROOT / "schema.sql")
            upsert_card(
                conn, card_id="swsh8-157", name="Gengar VMAX", set_name="Fusion Strike", number="157/264",
                rarity="Rare", variant="Raw", language="English", source_provider="scrydex",
                source_record_id="swsh8-157", set_id="swsh8", set_series="Sword & Shield",
            )
            title = "Gengar VMAX 157/264 Fusion Strike PSA 10"
            sales = [
                {"title": title, "soldAt": "2026/09/02", "price": 210.0, "currencyCode": "USD", "rank": 1,
                 "listingURL": "https://www.ebay.com/itm/100", "sourcePayload": {}},
                {"title": title, "soldAt": "2026/09/01", "price": 205.0, "currencyCode": "USD", "rank": 2,
                 "listingURL": "https://www.ebay.com/itm/101", "sourcePayload": {}},
            ]
            rows = [
                {"listingId": str(i), "gradeKey": "psa10", "title": title, "price": 200.0 + i, "currency": "USD",
                 "soldDate": f"2026-09-0{i}T00:00:00.000Z"}
                for i in (3, 4, 5)
            ]
            merge_ppt_sold_listings(sales, rows, card=GENGAR, grader="PSA", grade="10")
            cached = replace_slab_recent_sales_cache(
                conn, card_id="swsh8-157", grader="PSA", grade="10", source="ebay", sales=sales,
                fetched_at="2026-09-09T00:00:00+00:00", source_url=None, source_payload={},
            )
            conn.commit()
            self.assertEqual(len(cached["sales"]), 5)
            read_back = slab_recent_sales_cache(conn, card_id="swsh8-157", grader="PSA", grade="10", source="ebay", limit=25)
            self.assertEqual([s["soldAt"] for s in read_back["sales"]], ["2026/09/05", "2026/09/04", "2026/09/03", "2026/09/02", "2026/09/01"])
            self.assertEqual([sale_verification(s) for s in read_back["sales"]], ["title", "title", "title", "scrydex", "scrydex"])


class ServeTimeTests(unittest.TestCase):
    def _cached(self, sales):
        return {"sales": sales, "status": "available", "fetchedAt": None}

    def test_filter_drops_unverified_and_legacy_rows_still_serve(self):
        sales = [
            {"soldAt": "2026/09/07", "sourcePayload": {"_spotlight": {"verification": "unverified"}}},
            {"soldAt": "2026/09/06", "sourcePayload": {"_spotlight": {"verification": "title"}}},
            # Cached before verification existed: a Scrydex row, still shown.
            {"soldAt": "2026/09/05", "sourcePayload": {}},
        ]
        filtered = server._filter_recent_sales_rows(self._cached(sales), variant_key=None, limit=5)
        self.assertEqual([s["soldAt"] for s in filtered["sales"]], ["2026/09/06", "2026/09/05"])

    def test_recent_average_uses_newest_three_then_two_then_one(self):
        rows = [
            {"soldAt": _days_ago(1), "price": 230.0, "currencyCode": "USD"},
            {"soldAt": _days_ago(2), "price": 220.0, "currencyCode": "USD"},
            {"soldAt": _days_ago(3), "price": 210.0, "currencyCode": "USD"},
            {"soldAt": _days_ago(4), "price": 100.0, "currencyCode": "USD"},
        ]
        avg = server._recent_sales_average(rows)
        self.assertEqual((avg["amount"], avg["sampleSize"]), (220.0, 3))
        avg = server._recent_sales_average(rows[:2])
        self.assertEqual((avg["amount"], avg["sampleSize"]), (225.0, 2))
        avg = server._recent_sales_average(rows[:1])
        self.assertEqual((avg["amount"], avg["sampleSize"]), (230.0, 1))

    def test_recent_average_ignores_old_and_non_usd_rows(self):
        rows = [
            {"soldAt": _days_ago(400), "price": 20.0, "currencyCode": "USD"},
            {"soldAt": _days_ago(2), "price": 50.0, "currencyCode": "AUD"},
        ]
        self.assertIsNone(server._recent_sales_average(rows))
        payload = server._recent_sales_payload(self._cached(rows), source="ebay", grader="CGC", grade="9.5")
        self.assertIsNone(payload["recentAverage"])
        self.assertEqual(payload["saleCount"], 2)


if __name__ == "__main__":
    unittest.main()
