"""Label review 2026-11-21 (tool/data bugs): "null" argument strings and rarity-as-printing
on get_price_history (L013/L015/L022), the portfolio window the user names (L024),
precomputed leaders and from -> to moves (L001/L002), find_missing counts vs budget
(L026), and the scan-tray tile lost to number narrowing (L018)."""

from __future__ import annotations

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS  # noqa: E402
from test_mcp_chat_data_fixes import ChatFixCase  # noqa: E402
from test_mcp_tools import USER_A, McpToolsCase  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.compact import _portfolio_window, compact_result
    from mcp_server.assistant.engine import correct_tool_arguments
    from mcp_server.assistant.tools import (
        MAX_CARDS,
        AssistantToolbox,
        apply_question_rules,
        choose_tiles,
        result_refs,
    )

needs_deps = unittest.skipUnless(HAVE_DEPS, "assistant deps missing")


@needs_deps
class NullArgumentTests(unittest.TestCase):
    def test_null_words_count_as_omitted_for_every_tool(self) -> None:
        args = {"card_id": "bw5-104", "condition": "NM", "grader": "null", "grade": "NULL", "variant": " None "}
        self.assertEqual(correct_tool_arguments("get_price_history", args, "Show its price history"),
                         {"card_id": "bw5-104", "condition": "NM"})
        search = {"filter": {"text": "pikachu", "set": "null", "rarity_bucket": ["sir", "none"]}, "cursor": ""}
        self.assertEqual(correct_tool_arguments("search_cards", search, "pikachu cards"),
                         {"filter": {"text": "pikachu", "rarity_bucket": ["sir"]}})


class HistoryArgumentTests(ChatFixCase):
    def _seed(self) -> None:
        self.any_card("bw5-104", "Kyogre-EX", set_name="Dark Explorers", number="104/108", rarity="Rare Ultra")
        self.main_price("bw5-104", 504.48, variant="Holofoil")
        self.cell("bw5-104", 40, 319.0)
        self.cell("bw5-104", 2, 504.48)
        self.cell("bw5-104", 2, 9.0, variant="Reverse Holofoil")
        self.cell("bw5-104", 20, 1450.0, lane="graded", grader="PSA", grade="10")
        self.any_card("plain", "Plain Card")
        self.main_price("plain", 2.0, variant="Normal")
        self.cell("plain", 2, 2.0, variant="Normal")
        self.conn.commit()

    def test_null_strings_reach_the_main_printing(self) -> None:
        # L015: the MCP tool itself also reads "null" as omitted.
        history = self.call("get_price_history", card_id="bw5-104", grader="null", grade="NULL", variant="null")
        self.assertEqual((history["grader"], history["variant"]), (None, "Holofoil"))
        self.assertEqual([p["usd"] for p in history["points"]][-1], 504.48)

    def test_rarity_or_unknown_printing_falls_back_to_main_with_note(self) -> None:
        # L013/L022: a rarity name on a card with several printings.
        history = self.call("get_price_history", card_id="bw5-104", variant="Special Illustration Rare")
        self.assertEqual(history["variant"], "Holofoil")
        self.assertTrue(history["points"])
        self.assertIn("main printing, Holofoil", history["variant_note"])
        exact = self.call("get_price_history", card_id="bw5-104", variant="Reverse Holofoil")
        self.assertEqual(([p["usd"] for p in exact["points"]], exact.get("variant_note")), ([9.0], None))

    @needs_deps
    def test_graded_history_says_whether_psa10_sales_exist(self) -> None:
        toolbox = AssistantToolbox(self.tools)
        psa9 = toolbox.run("get_price_history", {"card_id": "bw5-104", "grader": "PSA", "grade": "9"},
                           owner_user_id=USER_A).content
        self.assertEqual((psa9["points"], psa9["has_psa10_sales"]), ([], True))
        none = toolbox.run("get_price_history", {"card_id": "plain", "grader": "PSA", "grade": "10"},
                           owner_user_id=USER_A).content
        self.assertIs(none["has_psa10_sales"], False)
        raw = toolbox.run("get_price_history", {"card_id": "plain"}, owner_user_id=USER_A).content
        self.assertNotIn("has_psa10_sales", raw)


@needs_deps
class PortfolioWindowTests(McpToolsCase):
    def _seed(self) -> None:
        for card_id, name, start, now, added in (
            ("old-up", "Old Riser", 50.0, 60.0, 400),
            ("new-down", "New Faller", 40.0, 30.0, 10),
        ):
            self.card(card_id, name)
            self.price(card_id, now)
            self.history(card_id, [(89, start), (10, start), (1, now)])
            self.holding(f"h-{card_id}", USER_A, card_id, quantity=2, added_days_ago=added)
        self.conn.commit()

    def test_question_window_wins_over_the_default(self) -> None:
        # L024: four 30d calls for a 90-day question.
        for question, wanted in (
            ("Which of my cards dropped the most in the last 90 days?", "90d"),
            ("My biggest gainers this week?", "7d"),
            ("What were my biggest gainers this month?", "30d"),
            ("How did my collection do over the past year?", "1y"),
        ):
            args = correct_tool_arguments("get_portfolio_summary", {"focus": "movers", "range": "30d"}, question)
            self.assertEqual(args["range"], wanted, question)
        self.assertNotIn("range", correct_tool_arguments("get_portfolio_summary", {"focus": "movers"}, "My movers?"))

    def test_movers_carry_from_to_and_window_label_not_coverage(self) -> None:
        args = correct_tool_arguments("get_portfolio_summary", {"focus": "movers"}, "Biggest losers in the last 90 days?")
        outcome = AssistantToolbox(self.tools).run("get_portfolio_summary", args, owner_user_id=USER_A)
        self.assertEqual(outcome.content["range"], "90d")
        payload = compact_result("get_portfolio_summary", outcome.content, args)
        gainer = payload["top_gainer_by_usd"]
        self.assertEqual((gainer["card_id"], gainer["from_usd"], gainer["to_usd"], gainer["change_usd"]),
                         ("old-up", 50.0, 60.0, 20.0))
        self.assertEqual(gainer["window_label"], "past 90 days")
        # Added 10 days ago: its move is real but the window isn't covered -> "recently".
        self.assertEqual(payload["top_loser_by_usd"]["window_label"], "recently")
        for item in payload["top_gainers"] + payload["top_losers"]:
            self.assertNotIn("baseline_date", item)
            self.assertNotIn("baseline_price_usd", item)

    def test_summary_window_label_follows_the_earliest_mover(self) -> None:
        today = date(2026, 11, 21)
        summary = {"range": "30d", "top_gainers": [{"card_id": "a", "name": "A", "baseline_date": "2026-11-10"}]}
        self.assertEqual(_portfolio_window(dict(summary), today)["window_label"], "recently")
        summary["top_gainers"][0]["baseline_date"] = (today - timedelta(days=30)).isoformat()
        self.assertEqual(_portfolio_window(dict(summary), today)["window_label"],
                         "past 30 days")


@needs_deps
class CollectionLeaderTests(McpToolsCase):
    def _seed(self) -> None:
        for card_id, name, price, quantity in (("big", "Big Single", 119.8, 1), ("pair", "Pair Card", 108.26, 2),
                                                ("cheap", "Cheap Card", 1.0, 1)):
            self.card(card_id, name)
            self.price(card_id, price)
            self.holding(f"h-{card_id}", USER_A, card_id, quantity=quantity)
        self.conn.commit()

    def test_unit_and_total_leaders_cover_every_matching_holding(self) -> None:
        # L001: the most valuable copy vs the largest holding, read not inferred.
        result = self.call("get_my_collection", sort="added_desc", limit=1)
        self.assertEqual((result["top_by_unit_price"]["card_id"], result["top_by_unit_price"]["price_usd"]), ("big", 119.8))
        self.assertEqual((result["top_by_total_value"]["card_id"], result["top_by_total_value"]["value_usd"]),
                         ("pair", 216.52))
        refs = result_refs(result)
        self.assertEqual(len({ref["card_id"] for ref in refs}), len(refs))  # leaders aren't duplicate tiles
        self.assertEqual({ref["card_id"] for ref in refs} - {item["card_id"] for item in result["items"]},
                         {"big", "pair"})  # off-page leaders can still become tiles


@needs_deps
class MissingCountTests(McpToolsCase):
    def _seed(self) -> None:
        for i in range(30):
            self.card(f"evs-{i}", f"Sky Card {i}", number=str(i), set_name="Evolving Skies", set_code="EVS")
            self.price(f"evs-{i}", 0.5 + i)
        self.holding("a-evs", USER_A, "evs-29")
        self.conn.commit()

    def test_budget_counts_are_distinct(self) -> None:
        # L026: "missing 84" was the budget picks.
        result = self.call("find_missing", card_filter={"set": "Evolving Skies"}, budget_usd=10)
        self.assertEqual(result["missing_count"], 29)
        self.assertEqual(result["matching_count"], len(result["missing"]))
        self.assertLess(result["matching_count"], 29)
        self.assertIn("matching_count", result["count_note"])
        plain = self.call("find_missing", card_filter={"set": "Evolving Skies"})
        self.assertNotIn("matching_count", plain)

    def test_under_x_is_a_per_card_cap_and_shown_matches_the_tiles(self) -> None:
        question = "Which Evolving Skies cards am I missing under $10?"
        args = correct_tool_arguments(
            "find_missing", {"filter": {"set": "Evolving Skies"}, "budget_usd": 10, "limit": 20}, question
        )
        self.assertEqual((args["filter"]["price_max_usd"], args["sort"]), (10.0, "price_asc"))
        self.assertNotIn("budget_usd", args)
        spend = correct_tool_arguments("find_missing", {"filter": {"set": "x"}, "budget_usd": 10},
                                       "I have $10 to spend, what can I get under $10?")
        self.assertEqual(spend["budget_usd"], 10)
        outcome = AssistantToolbox(self.tools).run("find_missing", args, owner_user_id=USER_A)
        self.assertEqual(outcome.content["missing_count"], 10)  # $0.50 .. $9.50
        self.assertEqual(outcome.content["shown"], len(outcome.content["missing"]))
        self.assertLessEqual(outcome.content["shown"], MAX_CARDS)


@needs_deps
class ScanTrayTileTests(unittest.TestCase):
    def test_numbered_printing_keeps_the_other_printing_named_by_set(self) -> None:
        # L018: "Charizard ex from 151 (#199/165) ... the Obsidian Flames Charizard ex" lost sv3-223.
        tray = [
            {"card_id": "sv3pt5-199", "name": "Charizard ex", "set": "151", "number": "199/165"},
            {"card_id": "sv3-223", "name": "Charizard ex", "set": "Obsidian Flames", "number": "223/197"},
            {"card_id": "xy5-54", "name": "Kyogre-EX", "set": "Primal Clash", "number": "54/160"},
        ]
        text = (
            "The **Charizard ex from 151 (#199/165)** is worth the most at $281.34, roughly three times the "
            "Obsidian Flames Charizard ex ($84.07). The Kyogre-EX from Primal Clash ($19.67) is well behind both."
        )
        question = "Which of these is worth the most?"
        keep = {ref["card_id"] for ref in tray}
        tiles, charts = choose_tiles(None, [dict(r) for r in tray], text, [], extra_refs=[dict(r) for r in tray],
                                     keep_ids=keep, question=question)
        tiles, _, _ = apply_question_rules(tiles, charts, None, question=question, text=text, pool=tray,
                                           holding_refs=[], language_pairs={}, keep_ids=keep, tools_used={"get_card"})
        self.assertEqual([t["card_id"] for t in tiles], ["sv3pt5-199", "sv3-223", "xy5-54"])

    def test_number_still_narrows_when_no_other_set_is_named(self) -> None:
        refs = [
            {"card_id": "a", "name": "Pikachu ex", "set": "Surging Sparks", "number": "238/191"},
            {"card_id": "b", "name": "Pikachu ex", "set": "Prismatic Evolutions", "number": "179/131"},
        ]
        tiles, _ = choose_tiles(None, refs, "Pikachu ex (#238/191) is up.", [])
        self.assertEqual([t["card_id"] for t in tiles], ["a"])


if __name__ == "__main__":
    unittest.main()
