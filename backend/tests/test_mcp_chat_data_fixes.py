"""Owner review of AI chat eval run 1 (docs/ai-chat-eval-owner-review-2026-11-20.md):
data/tool correctness fixes for L001, L002/L018, L010, L015, L016/L020, L023, L026, L027."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_tools import USER_A, McpToolsCase, _days_ago  # noqa: E402
from catalog_tools import replace_slab_recent_sales_cache, upsert_card, utc_now  # noqa: E402
from mcp_server import tools as tools_module  # noqa: E402


class ChatFixCase(McpToolsCase):
    def setUp(self) -> None:
        env = mock.patch.dict("os.environ", {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"})
        env.start()
        self.addCleanup(env.stop)
        super().setUp()

    def _seed(self) -> None:
        self.conn.commit()

    def any_card(self, card_id, name, *, game="pokemon", supertype="Pokémon", set_name="Set", set_code="SET",
                 number="1", rarity="Rare", language="English"):
        upsert_card(
            self.conn, card_id=card_id, name=name, set_name=set_name, number=number, rarity=rarity, variant="Raw",
            language=language, source_provider="scrydex", source_record_id=card_id, set_id=set_code.lower(),
            set_ptcgo_code=set_code, set_release_date="2023-09-22", artist=None, supertype=supertype,
            national_pokedex_numbers=[], image_url=None, source_payload={"id": card_id}, game=game,
        )

    def main_price(self, card_id, amount, *, variant=None):
        self.price(card_id, amount)
        self.conn.execute(
            "UPDATE card_price_snapshots SET main_raw_market_price = ?, main_raw_updated_at = ?, "
            "default_raw_variant = ? WHERE card_id = ?",
            (amount, utc_now(), variant, card_id),
        )

    def cell(self, card_id, days_ago, market, *, lane="raw_main", variant="Holofoil", grader=None, grade=None,
             condition="NM", provider="tcgcsv"):
        if lane == "graded":
            condition, provider = None, "scrydex"
        self.conn.execute(
            "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, variant_key, "
            "condition, grader, grade, is_perfect, is_signed, is_error, currency_code, market, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'USD', ?, ?)",
            (card_id, provider, _days_ago(days_ago), lane, f"{lane}|{grader}|{grade}|{variant}|{condition}",
             variant, condition, grader, grade, market, utc_now()),
        )


class CardsMeanSinglesTests(ChatFixCase):
    """L009/L015: product='single' drops sealed before the ranking cap."""

    def test_product_single_applies_before_the_row_ceiling(self) -> None:
        for index in range(3):
            card_id = f"tcgp-sealed-{index}"
            self.any_card(card_id, f"Booster Box Case {index}", supertype="Sealed", rarity="Sealed")
            self.main_price(card_id, 10_000.0 + index)
        self.any_card("single-1", "Mickey Mouse")
        self.main_price("single-1", 4166.67)
        self.any_card("single-2", "Buzz Lightyear")
        self.main_price("single-2", 3593.09)
        self.conn.commit()
        with mock.patch.object(tools_module, "STRUCTURED_ROW_CEILING", 2):
            result = self.call("search_cards", card_filter={"product": "single"}, sort="price_desc")
        self.assertEqual(self.ids(result["results"]), ["single-1", "single-2"])

    def test_descriptions_and_prompt_say_cards_means_singles(self) -> None:
        self.assertIn("'single' whenever the user says card/cards", tools_module.PRODUCT_FILTER_NOTE)
        from mcp_server.assistant.engine import SYSTEM_PROMPT

        self.assertIn('filter.product="single" whenever the user says card or cards', SYSTEM_PROMPT)
        self.assertIn("raw leader", SYSTEM_PROMPT)
        self.assertIn("graded leader", SYSTEM_PROMPT)


class GradedTrustTests(ChatFixCase):
    """L010: placeholder/outlier graded prices never rank; 'verified' = sales-backed."""

    def _seed(self) -> None:
        cards = {
            "np-37": ("Kyogre ex", 5.0),
            "base1-4": ("Charizard", 500.0),
            "base6-11": ("Gengar", 100.0),
            "np-40": ("Mew", 4.0),
        }
        for card_id, (name, raw) in cards.items():
            self.any_card(card_id, name)
            self.main_price(card_id, raw)
        self.cell("np-37", 0, 999_999.0, lane="graded", grader="PSA", grade="10", variant="holofoil")
        self.cell("np-37", 0, 60.0, lane="graded", grader="PSA", grade="9", variant="holofoil")
        self.cell("base1-4", 0, 409_539.86, lane="graded", grader="PSA", grade="10",
                  variant="firstEditionShadowlessHolofoil")
        self.cell("base1-4", 0, 60_000.0, lane="graded", grader="PSA", grade="9",
                  variant="firstEditionShadowlessHolofoil")
        self.cell("base1-4", 0, 2_000.0, lane="graded", grader="PSA", grade="9", variant="unlimitedHolofoil")
        # Rare reverse slab: ~4000x the main raw price, no lower grade on file: still trusted.
        self.cell("base6-11", 0, 408_000.0, lane="graded", grader="PSA", grade="10", variant="reverseHolofoil")
        self.cell("np-40", 0, 43_920.0, lane="graded", grader="PSA", grade="10", variant="holofoil")
        self.cell("np-40", 0, 150.0, lane="graded", grader="PSA", grade="9", variant="holofoil")
        self.conn.commit()

    def test_only_trusted_prices_rank(self) -> None:
        result = self.call("find_top_graded", grader="PSA", grade="10")
        self.assertEqual(self.ids(result["cards"]), ["base1-4", "base6-11"])
        for card in result["cards"]:
            self.assertTrue(card["price_trusted"])
            self.assertFalse(card["price_verified"])  # Scrydex market, not a sale
        excluded = {item["card_id"]: item for item in result["excluded_untrusted"]}
        self.assertEqual(set(excluded), {"np-37", "np-40"})
        self.assertIn("placeholder", excluded["np-37"]["reason"])
        self.assertIn("lower grade", excluded["np-40"]["reason"])
        # Excluded records carry no name, so they can never become tiles.
        self.assertTrue(all("name" not in item for item in result["excluded_untrusted"]))

    def test_sales_backed_price_is_verified(self) -> None:
        replace_slab_recent_sales_cache(
            self.conn, card_id="np-40", grader="PSA", grade="10", source="ebay",
            sales=[{"sourceSaleID": "s1", "title": "Mew 40 PSA 10", "price": 210.0, "currencyCode": "USD",
                    "soldAt": _days_ago(3)}],
        )
        self.conn.commit()
        cards = {card["card_id"]: card for card in self.call("find_top_graded", grader="PSA", grade="10")["cards"]}
        self.assertEqual((cards["np-40"]["price_usd"], cards["np-40"]["price_source"]), (210.0, "ebay_sold"))
        self.assertTrue(cards["np-40"]["price_verified"])

    def test_placeholder_pattern(self) -> None:
        check = tools_module.CollectionTools._is_placeholder_price
        for value in (999_999.0, 99_999.0, 199_999.99):
            self.assertTrue(check(value), value)
        for value in (409_539.86, 408_000.0, 1_999.99, 9_999.0):
            self.assertFalse(check(value), value)

    def test_one_piece_has_no_graded_and_says_so(self) -> None:
        result = self.call("find_top_graded", card_filter={"game": "onepiece"})
        self.assertEqual(result["cards"], [])
        self.assertIn("no graded prices for One Piece", result["note"])


class PortfolioChangeConsistencyTests(ChatFixCase):
    """L001: change_pct must agree with value_usd and change_usd."""

    def _seed(self) -> None:
        self.card("mover", "Mover")
        self.price("mover", 100.0)
        self.history("mover", [(20, 200.0), (1, 100.0)])
        self.card("flat", "No History")
        self.price("flat", 300.0)
        self.holding("h1", USER_A, "mover", added_days_ago=400)
        self.holding("h2", USER_A, "flat", added_days_ago=400)
        self.conn.commit()

    def test_change_pct_uses_whole_collection_start(self) -> None:
        summary = self.call("get_portfolio_summary", range_key="30d")
        self.assertEqual(summary["value_usd"], 400.0)
        self.assertEqual(summary["change_usd"], -100.0)
        self.assertEqual(summary["start_value_usd"], 500.0)
        self.assertEqual(summary["change_pct"], -20.0)  # -100 / (400 + 100)
        self.assertEqual(summary["covered_start_value_usd"], 200.0)
        self.assertEqual(summary["covered_change_pct"], -50.0)
        self.assertEqual(summary["change_covers_holdings"], 1)
        self.assertIn("change_pct = change_usd / start_value_usd", summary["change_basis"])
        self.assertAlmostEqual(
            summary["change_usd"] / summary["start_value_usd"] * 100, summary["change_pct"], places=2
        )


class SetCompletionTests(ChatFixCase):
    """L002/L018: '151' is the English set; chase cards first; honest completion cost."""

    def _seed(self) -> None:
        en = {"en151-199": ("Charizard ex", 287.93), "en151-200": ("Blastoise ex", 150.0),
              "en151-41": ("Zubat", 0.07), "en151-25": ("Pikachu", None), "en151-1": ("Bulbasaur", None)}
        for card_id, (name, price) in en.items():
            self.any_card(card_id, name, set_name="151", set_code="sv3pt5", number=card_id.split("-")[1])
            if price is not None:
                self.main_price(card_id, price, variant="Holofoil")
        # Unpriced snapshot, but its own printing has a TCGplayer point 5 days ago.
        self.main_price("en151-25", None, variant="Holofoil")
        self.cell("en151-25", 5, 3.25)
        for index in range(3):
            card_id = f"jp151-{index}"
            self.any_card(card_id, f"JP card {index}", set_name="ポケモンカード151", set_code="sv2a_ja",
                          language="Japanese", number=str(index))
            self.main_price(card_id, 0.08)
        self.holding("h1", USER_A, "en151-41")
        self.conn.commit()

    def test_151_resolves_to_english_set(self) -> None:
        result = self.call("find_missing", card_filter={"set": "151"}, sort="value_desc")
        self.assertEqual(result["set_resolved"]["language"], "English")
        self.assertEqual(result["missing_count"], 4)
        self.assertEqual(result["owned_count"], 1)
        self.assertFalse(any(card_id.startswith("jp151") for card_id in self.ids(result["missing"])))
        japanese = self.call("find_missing", card_filter={"set": "151", "language": "Japanese"})
        self.assertEqual(japanese["missing_count"], 3)
        self.assertEqual(japanese["set_resolved"]["set"], "ポケモンカード151")

    def test_value_desc_lists_chase_cards_first(self) -> None:
        chase = self.call("find_missing", card_filter={"set": "151"}, sort="value_desc")
        self.assertEqual(self.ids(chase["missing"])[:2], ["en151-199", "en151-200"])
        cheap = self.call("find_missing", card_filter={"set": "151"})
        self.assertEqual(self.ids(cheap["missing"])[0], "en151-25")
        with self.assertRaises(tools_module.ToolInputError):
            self.call("find_missing", card_filter={"set": "151"}, sort="newest")

    def test_partial_completion_cost_with_exact_match_fallback(self) -> None:
        result = self.call("find_missing", card_filter={"set": "151"}, sort="value_desc")
        by_id = {item["card_id"]: item for item in result["missing"]}
        self.assertEqual(by_id["en151-25"]["price_usd"], 3.25)
        self.assertIn("last recorded", by_id["en151-25"]["price_source"])
        self.assertIsNone(by_id["en151-1"]["price_usd"])
        self.assertIsNone(result["cheapest_completion_usd"])
        self.assertEqual(result["priced_count"], 3)
        self.assertEqual(result["priced_subtotal_usd"], round(287.93 + 150.0 + 3.25, 2))
        self.assertIn("3 of 4 missing cards", result["completion_note"])

    def test_full_estimate_only_when_all_priced(self) -> None:
        self.main_price("en151-1", 0.5, variant="Holofoil")
        self.conn.commit()
        result = self.call("find_missing", card_filter={"set": "151"})
        self.assertEqual(result["cheapest_completion_usd"], round(287.93 + 150.0 + 3.25 + 0.5, 2))
        self.assertNotIn("completion_note", result)

    def test_assistant_defaults_to_value_desc_unless_budget(self) -> None:
        from mcp_server.assistant.tools import AssistantToolbox

        box = AssistantToolbox(self.tools)
        outcome = box.run("find_missing", {"filter": {"set": "151"}}, owner_user_id=USER_A)
        self.assertEqual(outcome.content["sort"], "value_desc")
        budget = box.run("find_missing", {"filter": {"set": "151"}, "budget_usd": 5}, owner_user_id=USER_A)
        self.assertEqual(budget.content["sort"], "price_asc")


class BaseSetLookupTests(ChatFixCase):
    """L023: 'Base Set Pikachu #58' is base1-58 (set name 'Base')."""

    def _seed(self) -> None:
        self.any_card("base1-58", "Pikachu", set_name="Base", set_code="base1", number="58/102")
        self.any_card("base4-87", "Pikachu", set_name="Base Set 2", set_code="base4", number="87/130")
        self.any_card("base4-58", "Raticate", set_name="Base Set 2", set_code="base4", number="58/130")
        self.conn.commit()

    def test_set_name_with_set_suffix_resolves_exactly(self) -> None:
        result = self.call("search_cards", card_filter={"text": "Pikachu", "set": "Base Set"})
        self.assertEqual(self.ids(result["results"])[0], "base1-58")
        self.assertFalse({"base4-87", "base4-58"} & set(self.ids(result["results"])))
        self.assertEqual(result["set_resolved"]["set"], "Base")
        set_two = self.call("search_cards", card_filter={"text": "Pikachu", "set": "Base Set 2"})
        self.assertEqual(self.ids(set_two["results"])[0], "base4-87")
        self.assertNotIn("base1-58", self.ids(set_two["results"]))

    def test_number_without_total_finds_the_card(self) -> None:
        result = self.call("search_cards", card_filter={"text": "Pikachu 58"})
        self.assertEqual(self.ids(result["results"])[0], "base1-58")


class PriceHistoryRangeTests(ChatFixCase):
    """L016/L020: misnamed printings still chart; the covered span is explicit."""

    def _seed(self) -> None:
        self.any_card("sv3pt5-199", "Charizard ex", set_name="151", set_code="sv3pt5", number="199/165",
                      rarity="Special Illustration Rare")
        self.main_price("sv3pt5-199", 287.93, variant="Holofoil")
        for days, market in ((200, 417.0), (150, 500.0), (60, 320.0), (2, 287.93)):
            self.cell("sv3pt5-199", days, market)
        self.any_card("two-print", "Two Printings")
        self.main_price("two-print", 5.0, variant="Normal")
        self.cell("two-print", 10, 5.0, variant="Normal")
        self.cell("two-print", 10, 9.0, variant="Reverse Holofoil")
        self.conn.commit()

    def test_success_with_default_and_misnamed_printing(self) -> None:
        for variant in (None, "Special Illustration Rare", "Reverse Holofoil"):
            kwargs = {"variant": variant} if variant else {}
            history = self.call("get_price_history", card_id="sv3pt5-199", range_key="30d", **kwargs)
            self.assertEqual(history["variant"], "Holofoil", variant)
            self.assertEqual([p["usd"] for p in history["points"]], [287.93], variant)
        noted = self.call("get_price_history", card_id="sv3pt5-199", variant="Reverse Holofoil")
        self.assertIn("main printing, Holofoil", noted["variant_note"])

    def test_unknown_printing_on_multi_printing_card_falls_back_to_main_with_note(self) -> None:
        history = self.call("get_price_history", card_id="two-print", variant="1st Edition")
        self.assertEqual(history["variant"], "Normal")
        self.assertEqual([p["usd"] for p in history["points"]], [5.0])
        self.assertIn("No '1st Edition' printing", history["variant_note"])
        self.assertIn("main printing, Normal", history["variant_note"])
        self.assertEqual(set(history["available_variants"]), {"Normal", "Reverse Holofoil"})

    def test_fallback_when_no_history(self) -> None:
        self.any_card("no-history", "Quiet Card")
        self.conn.commit()
        history = self.call("get_price_history", card_id="no-history", range_key="1y")
        self.assertEqual(history["points"], [])
        self.assertIsNone(history["first_date"])
        self.assertFalse(history["covers_full_range"])

    def test_one_year_window_reports_partial_coverage(self) -> None:
        year = self.call("get_price_history", card_id="sv3pt5-199", range_key="1y")
        self.assertEqual((year["first_date"], year["last_date"]), (_days_ago(200), _days_ago(2)))
        self.assertEqual((year["first_usd"], year["last_usd"]), (417.0, 287.93))
        self.assertFalse(year["covers_full_range"])
        quarter = self.call("get_price_history", card_id="sv3pt5-199", range_key="90d")
        self.assertTrue(quarter["covers_full_range"] is False)  # first point 60 days ago, range starts at 90
        self.cell("sv3pt5-199", 88, 330.0)
        self.conn.commit()
        self.assertTrue(self.call("get_price_history", card_id="sv3pt5-199", range_key="90d")["covers_full_range"])

    def test_policy_keeps_range_fields_and_prompt_rule(self) -> None:
        from mcp_server.assistant.engine import SYSTEM_PROMPT
        from mcp_server.policy import USER_POLICY

        shaped = USER_POLICY.shape(self.call("get_price_history", card_id="sv3pt5-199", range_key="1y"))
        for key in ("first_date", "last_date", "covers_full_range", "range_start"):
            self.assertIn(key, shaped)
        self.assertIn("window_label", SYSTEM_PROMPT)  # owner 2026-11-20: no coverage remarks


class NewHighsWordingTests(unittest.TestCase):
    """L027: find_new_highs results are market-price highs, not sales."""

    def test_description_and_prompt(self) -> None:
        self.assertIn("call them 'market-price highs'", tools_module.NEW_HIGHS_DESCRIPTION)
        from mcp_server.assistant.engine import SYSTEM_PROMPT

        self.assertIn('call them "market-price highs"', SYSTEM_PROMPT)


class GradingUpsideTests(ChatFixCase):
    """L026: raw price vs PSA 10 comp from stored data."""

    def _seed(self) -> None:
        self.any_card("xy5-54", "Kyogre-EX", set_name="Primal Clash", set_code="xy5")
        self.main_price("xy5-54", 100.0, variant="Holofoil")
        replace_slab_recent_sales_cache(
            self.conn, card_id="xy5-54", grader="PSA", grade="10", source="ebay",
            sales=[{"sourceSaleID": "k1", "title": "Kyogre EX 54 PSA 10", "price": 400.0, "currencyCode": "USD",
                    "soldAt": _days_ago(4)},
                   {"sourceSaleID": "k2", "title": "Kyogre EX 54 PSA 10", "price": 380.0, "currencyCode": "USD",
                    "soldAt": _days_ago(20)}],
        )
        self.any_card("lugia", "Lugia")
        self.main_price("lugia", 50.0, variant="Holofoil")
        self.cell("lugia", 0, 250.0, lane="graded", grader="PSA", grade="10", variant="holofoil")
        self.cell("lugia", 0, 90.0, lane="graded", grader="PSA", grade="9", variant="holofoil")
        self.any_card("teammates", "Teammates")
        self.main_price("teammates", 40.0, variant="Holofoil")
        self.holding("h1", USER_A, "xy5-54")
        self.conn.commit()

    def test_comps_premiums_and_missing(self) -> None:
        result = self.call("grading_upside", card_ids=["xy5-54", "lugia", "teammates", "nope"])
        cards = {card["card_id"]: card for card in result["cards"]}
        kyogre = cards["xy5-54"]
        self.assertEqual((kyogre["raw_price_usd"], kyogre["comp_price_usd"], kyogre["comp_source"]),
                         (100.0, 400.0, "ebay_sold"))
        self.assertEqual(kyogre["comp_sale_count"], 2)
        self.assertEqual(kyogre["comp_as_of"], _days_ago(4))
        self.assertEqual((kyogre["gross_premium_usd"], kyogre["gross_premium_pct"]), (300.0, 300.0))
        self.assertTrue(kyogre["owned"])
        lugia = cards["lugia"]
        self.assertEqual((lugia["comp_price_usd"], lugia["comp_source"]), (250.0, "scrydex_market"))
        self.assertEqual(lugia["gross_premium_pct"], 400.0)
        self.assertTrue(cards["teammates"]["comp_missing"])
        self.assertIsNone(cards["teammates"]["gross_premium_usd"])
        self.assertEqual(result["not_found"], ["nope"])
        self.assertEqual(self.ids(result["cards"]), ["xy5-54", "lugia", "teammates"])  # biggest premium first

    def test_assistant_tool_is_strict_without_optional_params_and_prompt_has_bullets(self) -> None:
        from mcp_server.assistant.engine import SYSTEM_PROMPT
        from mcp_server.assistant.tools import TOOL_DEFINITIONS, AssistantToolbox

        tool = next(tool for tool in TOOL_DEFINITIONS if tool["name"] == "grading_upside")
        self.assertTrue(tool["strict"])
        self.assertEqual(tool["input_schema"]["required"], ["card_ids"])
        self.assertIn("raw $504.48 → PSA 10 $1,450 (+$945.52, +187%)", SYSTEM_PROMPT)  # owner 2026-11-20: no tables
        outcome = AssistantToolbox(self.tools).run("grading_upside", {"card_ids": ["xy5-54"]}, owner_user_id=USER_A)
        self.assertFalse(outcome.is_error, outcome.content)
        self.assertEqual(outcome.content["cards"][0]["comp_price_usd"], 400.0)
        self.assertEqual([ref["card_id"] for ref in outcome.cards], ["xy5-54"])
        json.dumps(outcome.content)


if __name__ == "__main__":
    unittest.main()
