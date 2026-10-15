"""Graded recent-sales helpers: eBay/FX price reconciliation, stored listing
photos, and the server's serve-time filter + recent-average headline."""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import server  # noqa: E402
from recent_sales import (  # noqa: E402
    ebay_item_id_from_url,
    local_price_outliers,
    reconcile_recent_sales_prices,
    title_conflicts_with_card,
)

BASE_CHARIZARD = {
    "id": "base1-4", "name": "Charizard", "number": "4/102", "set_name": "Base",
    "set_release_date": "1999/01/09", "rarity": "Rare Holo", "language": "English",
}
MOONBREON = {
    "id": "swsh7-215", "name": "Umbreon VMAX", "number": "215/203", "set_name": "Evolving Skies",
    "set_release_date": "2021/08/27", "rarity": "Rare Rainbow", "language": "English",
}

def _days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y/%m/%d")


class ReconcileTests(unittest.TestCase):
    def _sale(self, price, currency, item_id="100"):
        return {"price": price, "currencyCode": currency,
                "listingURL": f"https://www.ebay.com/itm/{item_id}?nordt=true", "sourcePayload": {}}

    def test_item_id_from_url(self):
        self.assertEqual(ebay_item_id_from_url("https://www.ebay.com/itm/366618245287?nordt=true"), "366618245287")
        self.assertIsNone(ebay_item_id_from_url("https://example.com/x"))

    def test_ebay_converted_amount_beats_fx(self):
        sale = self._sale(5900.0, "AUD")
        ebay = {"100": {"priceAmount": 4258.62, "priceCurrency": "USD", "convertedFromAmount": 5900.0,
                        "convertedFromCurrency": "AUD", "itemLocationCountry": "AU"}}
        counts = reconcile_recent_sales_prices([sale], to_usd=lambda a, c: 1.0, ebay_items_by_item_id=ebay)
        self.assertEqual(counts["ebay"], 1)
        self.assertEqual((sale["price"], sale["currencyCode"]), (4258.62, "USD"))
        spotlight = sale["sourcePayload"]["_spotlight"]
        self.assertEqual(spotlight["priceSource"], "ebay")
        self.assertEqual(spotlight["scrydexPrice"], 5900.0)
        self.assertEqual(spotlight["ebayConvertedFrom"], {"amount": 5900.0, "currency": "AUD"})

    def test_non_usd_row_without_ebay_is_fx_converted_or_left_honest(self):
        sale = self._sale(5900.0, "AUD")
        counts = reconcile_recent_sales_prices([sale], to_usd=lambda a, c: 4249.77)
        self.assertEqual(counts["fx"], 1)
        self.assertEqual((sale["price"], sale["currencyCode"]), (4249.77, "USD"))
        sale = self._sale(5900.0, "AUD")
        counts = reconcile_recent_sales_prices([sale], to_usd=lambda a, c: None)
        self.assertEqual(counts["unconverted"], 1)
        self.assertEqual((sale["price"], sale["currencyCode"]), (5900.0, "AUD"))

    def test_usd_row_stands(self):
        sale = self._sale(210.0, "USD")
        # A domestic eBay sale (no convertedFrom) does not override Scrydex.
        ebay = {"100": {"priceAmount": 999.0, "priceCurrency": "USD"}}
        counts = reconcile_recent_sales_prices([sale], to_usd=lambda a, c: None, ebay_items_by_item_id=ebay)
        self.assertEqual(counts, {"ebay": 0, "fx": 0, "scrydex": 1, "unconverted": 0})
        self.assertEqual(sale["price"], 210.0)


class StoredListingImageTests(unittest.TestCase):
    """eBay answers `getItem` for ~90 days after a listing ends but serves the
    PHOTO far longer (June comps still 200 in September 2026). The sold-comp
    cache is rebuilt from scratch every refresh, so a row photographed at day 30
    had its URL replaced with NULL the day the listing crossed 90 — we discarded
    images we already held, and old comps went grey forever (user, 2026-09-15).
    """

    def _conn(self, tmp):
        from catalog_tools import apply_schema, connect
        conn = connect(Path(tmp) / "images.sqlite")
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        return conn

    def test_a_photo_survives_the_listing_falling_out_of_browse(self):
        import tempfile
        from catalog_tools import ebay_listing_images_by_item_id, remember_ebay_listing_images

        with tempfile.TemporaryDirectory() as tmp:
            conn = self._conn(tmp)
            photo = "https://i.ebayimg.com/images/g/abc/s-l1600.jpg"

            # Day 30: Browse still answers, so the URL is recorded.
            self.assertEqual(remember_ebay_listing_images(conn, {"100": {"imageURL": photo}}), 1)
            conn.commit()

            # Day 91: Browse returns nothing for that item at all.
            sale = {
                "title": "Gengar VMAX", "soldAt": "2026/06/18", "price": 210.0,
                "currencyCode": "USD", "listingURL": "https://www.ebay.com/itm/100",
                "sourcePayload": {},
            }
            stored = ebay_listing_images_by_item_id(conn, ["100"])
            self.assertEqual(stored, {"100": photo})
            reconcile_recent_sales_prices(
                [sale], to_usd=lambda a, c: a,
                ebay_items_by_item_id={},
                stored_images_by_item_id=stored,
            )
            self.assertEqual(sale["imageURL"], photo)
            self.assertEqual(sale["sourcePayload"]["_spotlight"]["imageURL"], photo)

    def test_a_live_browse_photo_still_wins_and_refreshes_the_store(self):
        import tempfile
        from catalog_tools import ebay_listing_images_by_item_id, remember_ebay_listing_images

        with tempfile.TemporaryDirectory() as tmp:
            conn = self._conn(tmp)
            old_photo = "https://i.ebayimg.com/images/g/old/s-l1600.jpg"
            new_photo = "https://i.ebayimg.com/images/g/new/s-l1600.jpg"
            remember_ebay_listing_images(conn, {"100": {"imageURL": old_photo}})
            remember_ebay_listing_images(conn, {"100": {"imageURL": new_photo}})
            conn.commit()
            self.assertEqual(ebay_listing_images_by_item_id(conn, ["100"]), {"100": new_photo})

            sale = {
                "title": "Gengar VMAX", "soldAt": "2026/09/02", "price": 210.0,
                "currencyCode": "USD", "listingURL": "https://www.ebay.com/itm/100",
                "sourcePayload": {},
            }
            reconcile_recent_sales_prices(
                [sale], to_usd=lambda a, c: a,
                ebay_items_by_item_id={"100": {"imageURL": new_photo}},
                stored_images_by_item_id={"100": old_photo},
            )
            self.assertEqual(sale["imageURL"], new_photo)

    def test_no_stored_photo_leaves_the_row_exactly_as_before(self):
        import tempfile
        from catalog_tools import ebay_listing_images_by_item_id

        with tempfile.TemporaryDirectory() as tmp:
            conn = self._conn(tmp)
            self.assertEqual(ebay_listing_images_by_item_id(conn, ["404"]), {})
            sale = {
                "title": "Gengar VMAX", "soldAt": "2026/06/18", "price": 210.0,
                "currencyCode": "USD", "listingURL": "https://www.ebay.com/itm/404",
                "sourcePayload": {},
            }
            reconcile_recent_sales_prices(
                [sale], to_usd=lambda a, c: a,
                ebay_items_by_item_id={}, stored_images_by_item_id={},
            )
            self.assertIsNone(sale.get("imageURL"))
            self.assertIsNone(sale["sourcePayload"]["_spotlight"]["imageURL"])

    def test_helpers_no_op_on_a_database_without_the_table(self):
        # A database that has not taken the schema patch must behave exactly as
        # it did before, not raise.
        import sqlite3
        from catalog_tools import ebay_listing_images_by_item_id, remember_ebay_listing_images
        bare = sqlite3.connect(":memory:")
        self.assertEqual(remember_ebay_listing_images(bare, {"1": {"imageURL": "x"}}), 0)
        self.assertEqual(ebay_listing_images_by_item_id(bare, ["1"]), {})

    def test_nothing_is_written_for_an_item_with_no_photo(self):
        import tempfile
        from catalog_tools import ebay_listing_images_by_item_id, remember_ebay_listing_images
        with tempfile.TemporaryDirectory() as tmp:
            conn = self._conn(tmp)
            self.assertEqual(remember_ebay_listing_images(conn, {"1": {"imageURL": ""}, "2": {}}), 0)
            self.assertEqual(ebay_listing_images_by_item_id(conn, ["1", "2"]), {})


class ServeTimeTests(unittest.TestCase):
    def _cached(self, sales):
        return {"sales": sales, "status": "available", "fetchedAt": None}

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

    def test_title_conflict_catches_other_printings_of_the_same_name_and_number(self):
        for title in (
            "2021 POKEMON CELEBRATIONS ULTRA-PREMIUM COLLECTION #4 CHARIZARD PSA 9",
            "CHARIZARD 2021 POKEMON CELEBRATIONS CLASSIC BASE SET 4/102 RARE HOLO PSA 9",
            "Charizard 4/102 Base Set NON HOLO PSA 9",
        ):
            self.assertTrue(title_conflicts_with_card(title, BASE_CHARIZARD), title)
        for title in (
            "1999 POKEMON BASE SET UNLIMITED #4 CHARIZARD-HOLO PSA 9",
            "2006 Pokemon Base Set Charizard 4/102 PSA 9",  # label years don't match catalog dates
            "Charizard 4/102 Base Set Holo PSA 9",  # no year at all
        ):
            self.assertFalse(title_conflicts_with_card(title, BASE_CHARIZARD), title)
        # A Celebrations card's own sales are not a conflict.
        venusaur = {"set_name": "Celebrations: Classic Collection", "set_release_date": "2021/10/08"}
        self.assertFalse(title_conflicts_with_card("2021 Celebrations Classic Collection Venusaur PSA 9", venusaur))

    def test_local_outliers_flag_a_mismatch_but_keep_a_rising_cards_old_sales(self):
        moonbreon = [{"soldAt": "2026/10/05", "price": 199.99}] + [
            {"soldAt": f"2026/10/0{day}", "price": price}
            for day, price in ((5, 4050.0), (4, 3750.0), (4, 3938.0), (3, 3900.0), (2, 3650.0), (1, 3850.0))
        ]
        self.assertEqual(local_price_outliers(moonbreon), {0})
        # Steady climb from $150 to $1,500 over a year: nothing is an outlier.
        rising = [
            {"soldAt": f"2025/{month:02d}/15", "price": 150.0 * month}
            for month in range(1, 11)
        ]
        self.assertEqual(local_price_outliers(rising), set())
        # Too few sales to judge.
        self.assertEqual(local_price_outliers(moonbreon[:4]), set())

    def test_filter_drops_title_conflicts_and_local_outliers_before_capping(self):
        sales = [
            {"soldAt": "2026/10/05", "price": 199.99, "title": "Umbreon VMAX 215/203 PSA 10", "sourcePayload": {}},
            {"soldAt": "2026/10/05", "price": 4050.0, "title": "Moonbreon 215/203 PSA 10", "sourcePayload": {}},
            {"soldAt": "2026/10/04", "price": 3750.0, "title": "Umbreon VMAX 215/203 PSA 10", "sourcePayload": {}},
            {"soldAt": "2026/10/04", "price": 3938.0, "title": "2021 Evolving Skies Umbreon VMAX PSA 10", "sourcePayload": {}},
            {"soldAt": "2026/10/03", "price": 3900.0, "title": "Umbreon VMAX 215/203 PSA 10", "sourcePayload": {}},
            {"soldAt": "2026/10/02", "price": 3650.0, "title": "Umbreon VMAX 215/203 PSA 10", "sourcePayload": {}},
            {"soldAt": "2026/10/01", "price": 3850.0, "title": "Umbreon VMAX 215/203 PSA 10", "sourcePayload": {}},
            {"soldAt": "2026/10/01", "price": 900.0, "title": "2023 Umbreon VMAX 215/203 PSA 10", "sourcePayload": {}},
        ]
        filtered = server._filter_recent_sales_rows(
            self._cached(sales), variant_key=None, limit=3, card=MOONBREON
        )
        self.assertEqual([s["price"] for s in filtered["sales"]], [4050.0, 3750.0, 3938.0])

    def test_recent_average_is_the_median_so_one_bad_sale_cannot_swing_it(self):
        rows = [
            {"soldAt": _days_ago(1), "price": 199.99, "currencyCode": "USD"},
            {"soldAt": _days_ago(1), "price": 4050.0, "currencyCode": "USD"},
            {"soldAt": _days_ago(2), "price": 3750.0, "currencyCode": "USD"},
        ]
        self.assertEqual(server._recent_sales_average(rows)["amount"], 3750.0)

    def test_recent_average_takes_whole_days_so_same_day_order_does_not_matter(self):
        day1, day2 = _days_ago(1), _days_ago(2)
        rows = [
            {"soldAt": day1, "price": 4050.0, "currencyCode": "USD"},
            {"soldAt": day2, "price": 3750.0, "currencyCode": "USD"},
            {"soldAt": day2, "price": 3938.0, "currencyCode": "USD"},
            {"soldAt": day2, "price": 4100.0, "currencyCode": "USD"},
            {"soldAt": day2, "price": 4583.52, "currencyCode": "USD"},
            {"soldAt": _days_ago(3), "price": 9999.0, "currencyCode": "USD"},
        ]
        avg = server._recent_sales_average(rows)
        self.assertEqual((avg["amount"], avg["sampleSize"]), (4050.0, 5))
        self.assertEqual(server._recent_sales_average(list(reversed(rows)))["amount"], 4050.0)

    def test_filter_average_ignores_the_page_cap(self):
        rows = [
            {"soldAt": _days_ago(1), "price": 100.0, "currencyCode": "USD", "sourcePayload": {}},
            {"soldAt": _days_ago(1), "price": 110.0, "currencyCode": "USD", "sourcePayload": {}},
            {"soldAt": _days_ago(1), "price": 120.0, "currencyCode": "USD", "sourcePayload": {}},
        ]
        capped = server._filter_recent_sales_rows(self._cached(rows), variant_key=None, limit=1)
        payload = server._recent_sales_payload(capped, source="ebay", grader="PSA", grade="10")
        self.assertEqual(payload["saleCount"], 1)
        self.assertEqual((payload["recentAverage"]["amount"], payload["recentAverage"]["sampleSize"]), (110.0, 3))


class GradedTrendOverlayTests(unittest.TestCase):
    def test_graded_row_shows_the_cached_recent_sales_figure(self):
        from unittest import mock
        service = server.SpotlightScanService.__new__(server.SpotlightScanService)
        service._thread_local = type("T", (), {})()
        service._thread_local.connection = object()
        trend_list = {"mode": "psa", "rows": [
            {"key": "PSA 10", "currentPrice": 3850.0, "currencyCode": "USD"},
            {"key": "PSA 9", "currentPrice": 2300.0, "currencyCode": "USD"},
        ]}
        sales = [
            {"soldAt": _days_ago(1), "price": p, "currencyCode": "USD", "title": "Umbreon VMAX 215/203 PSA 10", "sourcePayload": {}}
            for p in (4050.0, 3750.0, 3938.0)
        ]
        def fake_cache(_conn, *, card_id, grader, grade, source, limit):
            return {"sales": sales, "status": "available"} if grade == "10" else None
        with mock.patch.object(server, "card_by_id", return_value=MOONBREON), \
             mock.patch.object(server, "slab_recent_sales_cache", side_effect=fake_cache):
            result = service._apply_recent_sales_average_to_graded_trend_rows("swsh7-215", trend_list, variant=None)
        self.assertEqual([r["currentPrice"] for r in result["rows"]], [3938.0, 2300.0])


if __name__ == "__main__":
    unittest.main()
