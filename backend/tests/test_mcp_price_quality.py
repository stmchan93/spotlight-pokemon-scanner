"""Chat/MCP price quality: stale prices (no observation in 14 days) and raw prices
above the card's own PSA 10 are withheld; grading_upside prefers the card's own
graded cell and only takes eBay comps whose title names the card's set + number."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_chat_data_fixes import ChatFixCase  # noqa: E402
from test_mcp_tools import USER_A, _days_ago  # noqa: E402
from catalog_tools import replace_slab_recent_sales_cache, upsert_card  # noqa: E402
from mcp_server.policy import USER_POLICY  # noqa: E402
from mcp_server.tools import listing_matches_card  # noqa: E402

TEAMMATES_JP_PAYLOAD = {
    "id": "xy5g_ja-77",
    "expansion": {"id": "xy5g_ja", "name": "ガイアボルケーノ", "code": "XY5",
                  "translation": {"en": {"name": "Gaia Volcano"}}},
}


class PriceQualityCase(ChatFixCase):
    def scrydex_price(self, card_id, amount, *, variant="Holofoil"):
        self.price(card_id, amount)
        self.conn.execute(
            "UPDATE card_price_snapshots SET default_raw_variant = ? WHERE card_id = ?", (variant, card_id)
        )

    def scrydex_raw_cell(self, card_id, days_ago, market, *, variant="holofoil"):
        self.cell(card_id, days_ago, market, lane="raw", variant=variant, provider="scrydex")

    def psa10_cell(self, card_id, days_ago, market, *, variant="holofoil"):
        self.cell(card_id, days_ago, market, lane="graded", grader="PSA", grade="10", variant=variant)

    def teammates_jp(self, card_id="xy5g_ja-77"):
        upsert_card(
            self.conn, card_id=card_id, name="Teammates", set_name="ガイアボルケーノ", number="077/070",
            rarity="Super Rare", variant="Raw", language="Japanese", source_provider="scrydex",
            source_record_id=card_id, set_id="xy5g_ja", set_ptcgo_code="XY5", set_release_date="2014-12-13",
            artist=None, supertype="Trainer", national_pokedex_numbers=[], image_url=None,
            source_payload=dict(TEAMMATES_JP_PAYLOAD, id=card_id),
        )


class StaleAndUntrustedTests(PriceQualityCase):
    def _seed(self) -> None:
        self.any_card("fresh", "Fresh Card")
        self.scrydex_price("fresh", 50.0)
        self.scrydex_raw_cell("fresh", 2, 50.0)
        self.any_card("stale", "Stale Card")
        self.scrydex_price("stale", 461.96)  # snapshot clock is fresh; the raw cells are not
        self.scrydex_raw_cell("stale", 125, 461.96)
        self.any_card("phantom", "Phantom Card")
        self.scrydex_price("phantom", 500.0)
        self.scrydex_raw_cell("phantom", 1, 500.0)
        self.psa10_cell("phantom", 1, 351.94)
        self.any_card("other-printing", "Other Printing")
        self.scrydex_price("other-printing", 500.0)
        self.scrydex_raw_cell("other-printing", 1, 500.0)
        self.psa10_cell("other-printing", 1, 351.94, variant="reverseHolofoil")
        self.any_card("tcg", "TCGplayer Card")
        self.main_price("tcg", 30.0, variant="Holofoil")
        self.scrydex_raw_cell("tcg", 90, 25.0)  # stale Scrydex lane doesn't matter: TCGplayer serves
        self.holding("h-fresh", USER_A, "fresh", quantity=2)
        self.holding("h-stale", USER_A, "stale")
        self.holding("h-phantom", USER_A, "phantom")
        self.conn.commit()

    def test_get_card_withholds_stale_and_untrusted_prices(self) -> None:
        stale = self.call("get_card", card_id="stale")
        self.assertIsNone(stale["price_usd"])
        self.assertIsNone(stale["price_source"])
        self.assertTrue(stale["price_stale"])
        self.assertEqual(stale["price_as_of"], _days_ago(125))
        phantom = self.call("get_card", card_id="phantom")
        self.assertIsNone(phantom["price_usd"])
        self.assertTrue(phantom["price_untrusted"])
        self.assertIn("$351.94", phantom["price_untrusted_reason"])
        self.assertEqual(self.call("get_card", card_id="fresh")["price_usd"], 50.0)
        self.assertEqual(self.call("get_card", card_id="other-printing")["price_usd"], 500.0)  # different printing
        tcg = self.call("get_card", card_id="tcg")
        self.assertEqual((tcg["price_usd"], tcg["price_source"]), (30.0, "tcgplayer"))
        self.assertNotIn("price_stale", tcg)

    def test_policy_lets_the_flags_out(self) -> None:
        shaped = USER_POLICY.shape(self.call("get_card", card_id="stale"))
        self.assertTrue(shaped["price_stale"])
        self.assertEqual(shaped["price_as_of"], _days_ago(125))

    def test_price_rankings_leave_them_out(self) -> None:
        result = self.call("search_cards", card_filter={}, sort="price_desc", limit=50)
        ids = self.ids(result["results"])
        self.assertNotIn("stale", ids)
        self.assertNotIn("phantom", ids)
        self.assertEqual(ids[:2], ["other-printing", "fresh"])

    def test_collection_total_excludes_and_counts_them(self) -> None:
        result = self.call("get_my_collection")
        self.assertEqual(result["total_value_usd"], 100.0)
        self.assertEqual((result["stale_price_count"], result["untrusted_price_count"]), (1, 1))
        self.assertEqual(result["unpriced_count"], 0)
        self.assertIn("excluded_price_note", result)
        portfolio = self.call("get_portfolio_summary")
        self.assertEqual(portfolio["value_usd"], 100.0)
        self.assertEqual((portfolio["stale_price_count"], portfolio["untrusted_price_count"]), (1, 1))
        self.assertEqual([h["card_id"] for h in portfolio["top_holdings"]], ["fresh"])

    def test_no_flags_when_everything_is_current(self) -> None:
        self.conn.execute("DELETE FROM deck_entries WHERE id IN ('h-stale', 'h-phantom')")
        self.conn.commit()
        result = self.call("get_my_collection")
        self.assertNotIn("stale_price_count", result)


class GradingUpsideCompTests(PriceQualityCase):
    def _seed(self) -> None:
        # Our own graded cell says $351.94; a cached eBay "PSA 10" sale for $45 is a
        # different Teammates (English Primal Clash 141/160).
        self.teammates_jp("xy5g_ja-77")
        self.scrydex_price("xy5g_ja-77", 40.0, variant="unlimitedHolofoil")
        self.scrydex_raw_cell("xy5g_ja-77", 1, 40.0, variant="unlimitedHolofoil")
        self.psa10_cell("xy5g_ja-77", 1, 351.94, variant="unlimitedHolofoil")
        self.mismatched_sales("xy5g_ja-77")
        # No graded cell: only eBay comps are left.
        self.teammates_jp("xy5g_ja-66")
        self.conn.execute("UPDATE cards SET number = '066/070' WHERE id = 'xy5g_ja-66'")
        self.scrydex_price("xy5g_ja-66", 20.0, variant="unlimitedHolofoil")
        self.scrydex_raw_cell("xy5g_ja-66", 1, 20.0, variant="unlimitedHolofoil")
        self.mismatched_sales("xy5g_ja-66")
        # Stale own graded cell: not a current comp.
        self.teammates_jp("xy5g_ja-55")
        self.conn.execute("UPDATE cards SET number = '055/070' WHERE id = 'xy5g_ja-55'")
        self.scrydex_price("xy5g_ja-55", 20.0, variant="unlimitedHolofoil")
        self.scrydex_raw_cell("xy5g_ja-55", 1, 20.0, variant="unlimitedHolofoil")
        self.psa10_cell("xy5g_ja-55", 125, 300.0, variant="unlimitedHolofoil")
        self.conn.commit()

    def mismatched_sales(self, card_id):
        replace_slab_recent_sales_cache(
            self.conn, card_id=card_id, grader="PSA", grade="10", source="ebay",
            sales=[{"sourceSaleID": f"{card_id}-x", "title": "Pokemon Teammates 141/160 Primal Clash PSA 10",
                    "price": 45.0, "currencyCode": "USD", "soldAt": _days_ago(3)}],
        )

    def test_own_graded_cell_beats_a_mismatched_ebay_comp(self) -> None:
        card = self.call("grading_upside", card_ids=["xy5g_ja-77"])["cards"][0]
        self.assertEqual((card["comp_price_usd"], card["comp_source"]), (351.94, "scrydex_market"))
        self.assertEqual(card["comp_as_of"], _days_ago(1))

    def test_mismatched_ebay_comp_is_ignored(self) -> None:
        card = self.call("grading_upside", card_ids=["xy5g_ja-66"])["cards"][0]
        self.assertTrue(card["comp_missing"])
        self.assertIsNone(card["comp_price_usd"])

    def test_matching_ebay_comp_is_used(self) -> None:
        replace_slab_recent_sales_cache(
            self.conn, card_id="xy5g_ja-66", grader="PSA", grade="10", source="ebay",
            sales=[{"sourceSaleID": "m1", "title": "Teammates 066/070 XY5 Gaia Volcano Japanese PSA 10",
                    "price": 180.0, "currencyCode": "USD", "soldAt": _days_ago(5)},
                   {"sourceSaleID": "m2", "title": "Pokemon Teammates 141/160 Primal Clash PSA 10",
                    "price": 45.0, "currencyCode": "USD", "soldAt": _days_ago(2)}],
        )
        self.conn.commit()
        card = self.call("grading_upside", card_ids=["xy5g_ja-66"])["cards"][0]
        self.assertEqual((card["comp_price_usd"], card["comp_source"], card["comp_sale_count"]), (180.0, "ebay_sold", 1))

    def test_stale_own_comp_is_not_current(self) -> None:
        card = self.call("grading_upside", card_ids=["xy5g_ja-55"])["cards"][0]
        self.assertTrue(card["comp_missing"])


class ListingMatchTests(unittest.TestCase):
    CARD = {"number": "077/070", "setName": "ガイアボルケーノ", "setPtcgoCode": "XY5"}
    NAMES = ["ガイアボルケーノ", "XY5", "Gaia Volcano"]

    def test_needs_number_and_set(self) -> None:
        self.assertTrue(listing_matches_card("Teammates 077/070 Gaia Volcano PSA 10", self.CARD, set_names=self.NAMES))
        self.assertTrue(listing_matches_card("Japanese XY5 Teammates #77 SR PSA 10", self.CARD, set_names=self.NAMES))
        self.assertFalse(listing_matches_card("Teammates 141/160 Primal Clash PSA 10", self.CARD, set_names=self.NAMES))
        self.assertFalse(listing_matches_card("Teammates Gaia Volcano PSA 10", self.CARD, set_names=self.NAMES))
        self.assertFalse(listing_matches_card("Teammates 077/070 PSA 10", self.CARD, set_names=self.NAMES))
        self.assertFalse(listing_matches_card("", self.CARD, set_names=self.NAMES))

    def test_grade_is_not_a_collector_number(self) -> None:
        card = {"number": "10", "setName": "Base Set", "setPtcgoCode": "BS"}
        self.assertFalse(listing_matches_card("Base Set Machamp PSA 10", card))
        self.assertTrue(listing_matches_card("Base Set Mewtwo 10/102 PSA 10", card))

    def test_prefixed_numbers(self) -> None:
        card = {"number": "TG05", "setName": "Lost Origin", "setPtcgoCode": "LOR"}
        self.assertTrue(listing_matches_card("Pikachu TG05/TG30 Lost Origin PSA 10", card))
        self.assertFalse(listing_matches_card("Pikachu 5/196 Lost Origin PSA 10", card))


if __name__ == "__main__":
    unittest.main()
