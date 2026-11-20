"""Assistant eval suite: code checks, judge (mocked client, no API calls),
case-file schema, run diff, report, calibration, and the runner glue."""

from __future__ import annotations

import asyncio
import copy
import csv
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))
# Other suites put backend/tools on sys.path, where tools/assistant_eval.py (the
# runner) would shadow the assistant_eval package: backend/ must come first.
sys.path.insert(0, str(BACKEND_ROOT))
if not hasattr(sys.modules.get("assistant_eval", sys), "__path__"):
    sys.modules.pop("assistant_eval", None)

from assistant_eval import grading  # noqa: E402
from assistant_eval.calibration import calibrate, export_labels, parse_human, pick_label_rows, sidecar_path  # noqa: E402
from assistant_eval.cases import DEFAULT_CASES_PATH, load_case_file, select_cases, validate_cases  # noqa: E402
from assistant_eval.grading import (  # noqa: E402
    JudgeResult,
    card_game,
    check_tool_args,
    grade_turn,
    judge_check,
    judge_turn,
    parse_tool_call_summary,
    tile_matches,
    value_matches,
)
from assistant_eval.report import case_results, compare, format_compare, render_report, summarize  # noqa: E402
from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, message, text, tool_use  # noqa: E402

TOOLS = frozenset(
    {"search_cards", "get_my_collection", "find_missing", "list_facets", "get_card", "get_my_watchlist",
     "get_portfolio_summary", "get_price_history", "find_price_lows", "find_new_highs", "get_market_trends",
     "find_top_graded", "grading_upside", "propose_add_to_collection", "propose_update_holding", "propose_watch_card", "show_cards",
     "add_to_collection_now"}
)

DEFAULTS = {
    "status": "ok",
    "max_words": 80,
    "max_cost_usd": 0.02,
    "banned": {"wishlist": r"\bwish ?list\b", "yen_word": r"\b(yen|JPY)\b", "tool_talk": r"\btool( call)?s?\b"},
}


def turn_record(**overrides: Any) -> dict[str, Any]:
    record = {
        "case": "c1", "category": "pricing_rank", "turn": 1, "question": "Most expensive One Piece card?",
        "status": "ok", "answer": "The priciest is Shanks at $1,200.", "tools": ["search_cards"],
        "tool_calls": ["search_cards(game=onepiece, sort=price_desc)"],
        "tool_args": [{"name": "search_cards", "arguments": {"filter": {"game": "onepiece"}, "sort": "price_desc"}, "is_error": False}],
        "cards": [{"card_id": "onepiece~OP01-120", "name": "Shanks", "language": "English", "price_usd": 1200.0}],
        "tiles": ["Shanks · Romance Dawn · $1,200.00"], "action_details": [], "actions": [], "cost_usd": 0.004,
    }
    record.update(overrides)
    return record


def failed_names(checks) -> list[str]:
    return [check.name for check in checks if not check.passed]


class MatcherTests(unittest.TestCase):
    def test_scalar_and_ops(self) -> None:
        self.assertTrue(value_matches("OnePiece", "onepiece"))
        self.assertTrue(value_matches(2, "2"))
        self.assertTrue(value_matches("400", 400.0))
        self.assertFalse(value_matches(grading._MISSING, "x"))
        self.assertTrue(value_matches(grading._MISSING, {"not": "Japanese"}))
        self.assertFalse(value_matches("Japanese", {"not": "japanese"}))
        self.assertTrue(value_matches("single", {"in": ["single", "sealed"]}))
        self.assertTrue(value_matches("any", {"not_in": ["sealed"]}))
        self.assertTrue(value_matches("Surging Sparks", {"contains": "surging"}))
        self.assertTrue(value_matches(["sir", "ultra"], {"contains": "SIR"}))
        self.assertTrue(value_matches(["sir"], "sir"))
        self.assertTrue(value_matches(40, {"gte": 10, "lte": 50}))
        self.assertFalse(value_matches(60, {"lte": 50}))
        self.assertTrue(value_matches(grading._MISSING, {"exists": False}))
        with self.assertRaises(ValueError):
            value_matches("x", {"bogus": 1})

    def test_summary_parse(self) -> None:
        name, flat = parse_tool_call_summary("find_top_graded(grader=PSA, grade=10, rarity_bucket=sir|ultra)")
        self.assertEqual(name, "find_top_graded")
        self.assertEqual(flat["grader"], "PSA")
        self.assertEqual(flat["rarity_bucket"], ["sir", "ultra"])
        self.assertIsNone(parse_tool_call_summary("not a call"))


class CheckTests(unittest.TestCase):
    def test_tool_args_structured_any_and_all(self) -> None:
        record = turn_record(tool_args=[
            {"name": "search_cards", "arguments": {"filter": {"game": "onepiece"}}},
            {"name": "search_cards", "arguments": {"filter": {"game": "pokemon"}}},
        ])
        spec = {"tool": "search_cards", "where": {"filter.game": "onepiece"}}
        self.assertTrue(check_tool_args(record, spec).passed)
        self.assertFalse(check_tool_args(record, {**spec, "mode": "all"}).passed)
        missing = check_tool_args(record, {"tool": "find_top_graded", "where": {"grader": "PSA"}})
        self.assertFalse(missing.passed)
        self.assertIn("not called", missing.reason)

    def test_tool_args_falls_back_to_summary_strings(self) -> None:
        record = turn_record(tool_args=[], tool_calls=["search_cards(game=onepiece, product=single)"])
        self.assertTrue(check_tool_args(record, {"tool": "search_cards", "where": {"filter.product": "single"}}).passed)
        self.assertFalse(check_tool_args(record, {"tool": "search_cards", "where": {"filter.language": "Japanese"}}).passed)

    def test_tile_predicates(self) -> None:
        self.assertEqual(card_game("onepiece~OP01-120"), "onepiece")
        self.assertEqual(card_game("sv3pt5-199"), "pokemon")
        self.assertEqual(card_game("weird~x"), "pokemon")
        self.assertTrue(tile_matches({"card_id": "sv2a_ja-201"}, {"japanese": True}))
        self.assertTrue(tile_matches({"card_id": "x-1", "language": "Japanese"}, {"japanese": True}))
        self.assertTrue(tile_matches({"card_id": "tcgp-sealed-123"}, {"sealed": True}))
        self.assertTrue(tile_matches({"card_id": "onepiece~tcgp-sealed-9"}, {"sealed": True, "game": "onepiece"}))
        self.assertFalse(tile_matches({"card_id": "onepiece~OP01-1"}, {"game_not": "onepiece"}))
        self.assertTrue(tile_matches({"card_id": "a", "name": "Elite Trainer Box"}, {"name_regex": "trainer box"}))

    def test_card_game_matches_catalog(self) -> None:
        try:
            from catalog_tools import SUPPORTED_GAMES, split_namespaced_catalog_id
        except ImportError:  # pragma: no cover
            self.skipTest("catalog_tools unavailable")
        self.assertEqual(set(SUPPORTED_GAMES), set(grading.KNOWN_GAMES))
        for card_id in ("sv3pt5-199", "onepiece~OP01-120", "lorcana~1-1", "riftbound~x", "gundam~y"):
            self.assertEqual(card_game(card_id), split_namespaced_catalog_id(card_id)[0])

    def test_grade_turn_happy_path(self) -> None:
        expect = {
            "tools_any": ["search_cards", "find_top_graded"],
            "tool_args": [{"tool": "search_cards", "mode": "all", "where": {"filter.game": "onepiece", "filter.language": {"not": "Japanese"}}}],
            "tiles_none_match": [{"game_not": "onepiece"}, {"japanese": True}, {"sealed": True}],
            "must_contain_any": ["$"],
            "max_words": 20,
        }
        checks = grade_turn(turn_record(), expect, DEFAULTS)
        self.assertEqual(failed_names(checks), [])
        names = {check.name for check in checks}
        self.assertTrue({"status", "banned", "actions", "max_cost_usd", "max_words", "tiles_none_match"} <= names)

    def test_grade_turn_failures_have_reasons(self) -> None:
        record = turn_record(
            answer="I used a tool to check your wishlist: ¥5000 or 5000 yen.",
            cards=[{"card_id": "sv3pt5-199", "name": "Charizard ex"}, {"card_id": "onepiece~tcgp-sealed-1", "name": "Box"}],
            action_details=[{"type": "watch_card", "params": {"card_id": "x"}, "summary": "Add x to Watchlist"}],
            cost_usd=0.5,
        )
        checks = grade_turn(record, {"tiles_none_match": [{"game_not": "onepiece"}, {"sealed": True}],
                                     "must_not_contain": ["¥"], "max_words": 5}, DEFAULTS)
        failed = {check.name: check.reason for check in checks if not check.passed}
        self.assertEqual(set(failed), {"tiles_none_match", "banned", "must_not_contain", "actions", "max_cost_usd", "max_words"})
        self.assertIn("wishlist", failed["banned"])
        self.assertIn("yen", failed["banned"])
        self.assertIn("Charizard", failed["tiles_none_match"])
        self.assertIn("Box", failed["tiles_none_match"])

    def test_allow_drops_a_default_ban(self) -> None:
        record = turn_record(answer="I only show USD, not yen: it's $450.")
        self.assertIn("banned", failed_names(grade_turn(record, {}, DEFAULTS)))
        self.assertNotIn("banned", failed_names(grade_turn(record, {"allow": ["yen_word"]}, DEFAULTS)))

    def test_expected_action_params(self) -> None:
        record = turn_record(action_details=[{"type": "add_to_collection", "params": {"card_id": "sv3pt5-199", "quantity": 2, "condition": "NM"}}])
        ok = grade_turn(record, {"expect_action": {"type": "add_to_collection", "params": {"quantity": 2, "condition": "NM"}}}, DEFAULTS)
        self.assertNotIn("actions", failed_names(ok))
        wrong = grade_turn(record, {"expect_action": {"type": "add_to_collection", "params": {"quantity": 3}}}, DEFAULTS)
        self.assertIn("actions", failed_names(wrong))
        wrong_type = grade_turn(record, {"expect_action": {"type": "watch_card"}}, DEFAULTS)
        self.assertIn("actions", failed_names(wrong_type))
        self.assertNotIn("actions", failed_names(grade_turn(record, {"actions_allowed": True}, DEFAULTS)))

    def test_chart_tools_and_http_errors(self) -> None:
        record = turn_record(tools=["get_card"], chart_series=[])
        failed = failed_names(grade_turn(record, {"chart_required": True, "tools_all": ["get_price_history"],
                                                  "tools_none": ["get_card"], "tiles_min": 3}, DEFAULTS))
        self.assertTrue({"chart_required", "tools_all", "tools_none", "tiles_min"} <= set(failed))
        charted = turn_record(chart_series=[{"card_id": "a", "points": 30}])
        self.assertNotIn("chart_required", failed_names(grade_turn(charted, {"chart_required": True}, DEFAULTS)))
        http = grade_turn({"status": "http_502", "error": {"error": "assistant_failed"}}, {}, DEFAULTS)
        self.assertEqual([check.name for check in http], ["status"])
        self.assertFalse(http[0].passed)
        self.assertIn("status", failed_names(grade_turn(turn_record(status="error"), {}, DEFAULTS)))


def tile(card_id: str, name: str, **extra: Any) -> dict[str, Any]:
    return {"card_id": card_id, "name": name, **extra}


def check(record: dict[str, Any], expect: dict[str, Any], name: str, known_tools: frozenset[str] | None = None):
    return next(c for c in grade_turn(record, expect, {}, known_tools) if c.name.startswith(name))


CHARIZARD = tile("sv3pt5-199", "Charizard ex", set="151", number="199/165", price_usd=287.93)
OBSIDIAN = tile("sv3-223", "Charizard ex", set="Obsidian Flames", number="223/197", price_usd=84.09)
KYOGRE = tile("xy5-54", "Kyogre-EX", set="Primal Clash", price_usd=19.39)


class TileCheckTests(unittest.TestCase):
    def test_tiles_exact_include_within_max(self) -> None:
        record = turn_record(cards=[OBSIDIAN, CHARIZARD])
        self.assertTrue(check(record, {"tiles_exact": ["sv3pt5-199", "sv3-223"]}, "tiles_exact").passed)
        ordered = check(record, {"tiles_exact": {"tiles": ["sv3pt5-199", "sv3-223"], "ordered": True}}, "tiles_exact")
        self.assertFalse(ordered.passed)
        self.assertIn("in order", ordered.reason)
        # Text can be right while the tiles are wrong: one extra tile fails.
        self.assertFalse(check(record, {"tiles_exact": ["sv3pt5-199"]}, "tiles_exact").passed)
        self.assertTrue(check(record, {"tiles_exact": [{"name_regex": "^Charizard ex$", "set_regex": "151"},
                                                       {"number": "223"}]}, "tiles_exact").passed)
        self.assertTrue(check(record, {"tiles_include": ["sv3pt5-199"]}, "tiles_include").passed)
        missing = check(record, {"tiles_include": ["xy5-54"]}, "tiles_include")
        self.assertFalse(missing.passed)
        self.assertIn("xy5-54", missing.reason)
        self.assertTrue(check(record, {"tiles_within": ["sv3pt5-199", "sv3-223", "xy5-54"]}, "tiles_within").passed)
        self.assertFalse(check(record, {"tiles_within": ["sv3pt5-199"]}, "tiles_within").passed)
        self.assertFalse(check(record, {"tiles_max": 1}, "tiles_max").passed)
        self.assertTrue(check(turn_record(cards=[]), {"tiles_max": 0}, "tiles_max").passed)

    def test_graded_and_price_predicates(self) -> None:
        slab = tile("base1-4", "Charizard", grader="PSA", grade="10", variant="firstEditionShadowlessHolofoil", price_usd=409540)
        raw = tile("base1-4", "Charizard", price_usd=500)
        record = turn_record(cards=[slab, raw])
        spec = [{"id": "base1-4", "grader": "PSA", "grade": "10", "variant_regex": "first"}, {"id": "base1-4", "graded": False}]
        self.assertTrue(check(record, {"tiles_exact": spec}, "tiles_exact").passed)
        placeholder = turn_record(cards=[tile("bw5-104", "Kyogre-EX", grader="PSA", grade="10", price_usd=999999)])
        self.assertFalse(check(placeholder, {"tiles_none_match": [{"price_gte": 999999}]}, "tiles_none_match").passed)
        self.assertTrue(tile_matches(tile("a", "x", rarity="Special Illustration Rare"), {"rarity_regex": "special illustration"}))

    def test_tile_quantity_label_and_sort(self) -> None:
        record = turn_record(cards=[dict(CHARIZARD)])
        quantity = check(record, {"tile_quantity": {"card_id": "sv3pt5-199", "quantity": 2}}, "tile_quantity")
        self.assertTrue(quantity.passed and quantity.skipped)
        record["cards"][0]["quantity"] = 2
        self.assertTrue(check(record, {"tile_quantity": {"card_id": "sv3pt5-199", "quantity": 2}}, "tile_quantity").passed)
        record["cards"][0]["quantity"] = 4
        self.assertFalse(check(record, {"tile_quantity": {"card_id": "sv3pt5-199", "quantity": 2}}, "tile_quantity").passed)
        self.assertFalse(check(record, {"tile_quantity": {"card_id": "xy5-54", "quantity": 2}}, "tile_quantity").passed)

        label = {"tiles_label": "top holdings by value"}
        self.assertTrue(check(record, label, "tiles_label").skipped)  # app sends no cards_label yet
        self.assertTrue(check(turn_record(cards=[], cards_label=None), label, "tiles_label").passed)
        self.assertTrue(check({**record, "cards_label": "Top holdings by value"}, label, "tiles_label").passed)
        self.assertFalse(check({**record, "cards_label": "Your cards"}, label, "tiles_label").passed)

        unsorted = turn_record(cards=[KYOGRE, CHARIZARD])
        self.assertFalse(check(unsorted, {"tiles_sorted": "price"}, "tiles_sorted").passed)
        self.assertTrue(check(turn_record(cards=[CHARIZARD, KYOGRE]), {"tiles_sorted": "price"}, "tiles_sorted").passed)
        # value = price x quantity owned: 30 Kyogres outrank one Charizard
        by_value = turn_record(cards=[{**KYOGRE, "quantity_owned": 30}, CHARIZARD])
        self.assertTrue(check(by_value, {"tiles_sorted": "value"}, "tiles_sorted").passed)
        self.assertTrue(check(turn_record(cards=[tile("a", "x")]), {"tiles_sorted": "price"}, "tiles_sorted").skipped)

    def test_chart_card_matches_tile(self) -> None:
        good = turn_record(cards=[CHARIZARD], chart_series=[{"card_id": "sv3pt5-199", "points": 30}])
        self.assertTrue(check(good, {"chart_card_matches_tile": True}, "chart_card_matches_tile").passed)
        five = turn_record(cards=[CHARIZARD, OBSIDIAN], chart_series=[{"card_id": "sv3pt5-199", "points": 30}])
        self.assertIn("expected exactly 1", check(five, {"chart_card_matches_tile": True}, "chart_card").reason)
        other = turn_record(cards=[OBSIDIAN], chart_series=[{"card_id": "sv3pt5-199", "points": 30}])
        self.assertFalse(check(other, {"chart_card_matches_tile": True}, "chart_card").passed)
        variant = turn_record(cards=[{**CHARIZARD, "variant": "holofoil"}],
                              chart_series=[{"card_id": "sv3pt5-199", "variant": "reverseHolofoil", "points": 3}])
        self.assertIn("variant", check(variant, {"chart_card_matches_tile": True}, "chart_card").reason)
        self.assertFalse(check(turn_record(cards=[CHARIZARD]), {"chart_card_matches_tile": True}, "chart_card").passed)
        self.assertFalse(check(good, {"no_chart": True}, "no_chart").passed)

    def test_named_cards_must_be_tiles(self) -> None:
        results = [{"name": "search_cards", "call": "search_cards(...)", "data": {"cards": [
            {"card_id": "a", "name": "Cyndaquil"}, {"card_id": "b", "name": "Swinub"}, {"card_id": "c", "name": "Charizard"},
            {"card_id": "d", "name": "Charizard ex"},
        ]}}]
        record = turn_record(answer="Cozy picks include Cyndaquil and Swinub, plus Charizard ex.", tool_results=results,
                             cards=[tile("a", "Cyndaquil"), tile("d", "Charizard ex")])
        failed = check(record, {"named_cards_in_tiles": True}, "named_cards_in_tiles")
        self.assertFalse(failed.passed)
        self.assertIn("Swinub", failed.reason)
        self.assertNotIn("'Charizard'", failed.reason)  # 'Charizard ex' won the overlap
        record["cards"].append(tile("b", "Swinub"))
        self.assertTrue(check(record, {"named_cards_in_tiles": True}, "named_cards_in_tiles").passed)
        # Scanner tray names count too; subtitled tile names match their prefix.
        tray = turn_record(answer="Mickey Mouse is worth the most.", tool_results=[],
                           context_cards=[{"card_id": "m", "name": "Mickey Mouse"}],
                           cards=[tile("m", "Mickey Mouse - Wayward Sorcerer")])
        self.assertTrue(check(tray, {"named_cards_in_tiles": True}, "named_cards_in_tiles").passed)

    def test_price_trusted_tiles(self) -> None:
        kyogre = tile("bw5-104", "Kyogre-EX", grader="PSA", grade="10", price_usd=999999)
        record = turn_record(cards=[kyogre], tool_results=[])
        self.assertTrue(check(record, {"tiles_price_trusted": True}, "tiles_price_trusted").skipped)
        record["tool_results"] = [{"name": "find_top_graded", "data": {"cards": [{**kyogre, "price_trusted": False}]}}]
        self.assertFalse(check(record, {"tiles_price_trusted": True}, "tiles_price_trusted").passed)
        record["tool_results"][0]["data"]["cards"][0]["price_trusted"] = True
        self.assertTrue(check(record, {"tiles_price_trusted": True}, "tiles_price_trusted").passed)


class SealedGameTests(unittest.TestCase):
    """Sealed ids are tcgp-sealed-* with no game prefix: game/supertype come from the catalog row."""

    def test_game_and_sealed_from_data(self) -> None:
        box = {"card_id": "tcgp-sealed-555", "name": "OP-09 Booster Box", "game": "onepiece", "supertype": "Sealed"}
        self.assertFalse(tile_matches(box, {"game_not": "onepiece"}))
        self.assertTrue(tile_matches(box, {"game": "onepiece", "sealed": True}))
        # The id alone would have said pokemon:
        self.assertTrue(tile_matches({"card_id": "tcgp-sealed-555"}, {"game": "pokemon"}))
        single = {"card_id": "tcgp-sealed-oddity", "name": "x", "game": "pokemon", "supertype": "Pokémon"}
        self.assertFalse(tile_matches(single, {"sealed": True}))
        record = turn_record(cards=[box])
        self.assertTrue(check(record, {"tiles_none_match": [{"game_not": "onepiece"}]}, "tiles_none_match").passed)
        self.assertFalse(check(record, {"tiles_none_match": [{"sealed": True}]}, "tiles_none_match").passed)

    def test_runner_records_catalog_game(self) -> None:
        import sqlite3

        runner = load_runner()
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE cards (id TEXT, game TEXT, supertype TEXT, language TEXT, rarity TEXT)")
        conn.executemany("INSERT INTO cards VALUES (?, ?, ?, ?, ?)", [
            ("tcgp-sealed-555", "onepiece", "Sealed", "English", None),
            ("sv2a_ja-201", "pokemon", "Pokémon", "Japanese", "Special Art Rare"),
        ])
        cards = runner.tile_records(conn, [
            {"card_id": "tcgp-sealed-555", "name": "OP-09 Booster Box", "price_usd": 120.0},
            {"card_id": "sv2a_ja-201", "name": "Charizard ex", "language": None, "quantity_owned": 1},
            {"card_id": "missing-1", "name": "Ghost"},
        ])
        self.assertEqual((cards[0]["game"], cards[0]["supertype"]), ("onepiece", "Sealed"))
        self.assertEqual(cards[1]["language"], "Japanese")
        self.assertEqual(cards[1]["quantity_owned"], 1)
        self.assertIsNone(cards[2]["game"])
        tiles = [runner._tile(card) for card in cards]
        self.assertIn("sealed", tiles[0])
        self.assertIn("onepiece", tiles[0])
        self.assertIn("[tcgp-sealed-555]", tiles[0])
        self.assertIn("Japanese", tiles[1])
        self.assertTrue(tile_matches(cards[0], {"sealed": True, "game": "onepiece"}))


class PlannedFeatureTests(unittest.TestCase):
    """Checks against other agents' planned tools/fields skip while those are absent."""

    BUILD = TOOLS - grading.PLANNED_TOOLS  # a build from before show_cards / add_to_collection_now / grading_upside
    MERGED = TOOLS

    def write_record(self, **overrides: Any) -> dict[str, Any]:
        fields = {
            "tools": ["add_to_collection_now"],
            "tool_args": [{"name": "add_to_collection_now", "is_error": False,
                           "arguments": {"card_id": "sv3pt5-199", "quantity": 2, "condition": "NM"}}],
            "tool_results": [{"name": "add_to_collection_now", "data": {"added": True, "undo_token": "u1"}}],
            "action_details": [{"type": "add_to_collection", "state": "executed", "params": {"card_id": "sv3pt5-199"}}],
        }
        return turn_record(**{**fields, **overrides})

    def test_planned_tools_skip_before_merge(self) -> None:
        record = turn_record()
        self.assertTrue(check(record, {"tools_all": ["add_to_collection_now"]}, "tools_all", self.BUILD).skipped)
        self.assertFalse(check(record, {"tools_all": ["add_to_collection_now"]}, "tools_all", self.MERGED).passed)
        # A mixed list keeps the tools that exist.
        mixed = check(record, {"tools_any": ["grading_upside", "search_cards"]}, "tools_any", self.BUILD)
        self.assertTrue(mixed.passed and not mixed.skipped)
        self.assertTrue(check(record, {"expect_write": {"params": {"quantity": 2}}}, "expect_write", self.BUILD).skipped)
        self.assertTrue(check(record, {"undo_offered": True}, "undo_offered", self.BUILD).skipped)

    def test_direct_add_write_undo_and_no_write(self) -> None:
        record = self.write_record()
        spec = {"expect_write": {"params": {"card_id": "sv3pt5-199", "quantity": 2, "condition": "NM"}}}
        self.assertTrue(check(record, spec, "expect_write", self.MERGED).passed)
        self.assertFalse(check(record, {"expect_write": {"params": {"quantity": 3}}}, "expect_write", self.MERGED).passed)
        self.assertTrue(check(record, {"undo_offered": True}, "undo_offered", self.MERGED).passed)
        no_undo = self.write_record(tool_results=[{"name": "add_to_collection_now", "data": {"added": True}}],
                                    action_details=[{"type": "add_to_collection", "state": "executed"}])
        self.assertFalse(check(no_undo, {"undo_offered": True}, "undo_offered", self.MERGED).passed)
        self.assertFalse(check(record, {"expect_no_write": True}, "expect_no_write").passed)
        failed_write = self.write_record(tool_args=[{"name": "add_to_collection_now", "is_error": True, "arguments": {}}])
        self.assertTrue(check(failed_write, {"expect_no_write": True}, "expect_no_write").passed)
        self.assertFalse(check(failed_write, spec, "expect_write", self.MERGED).passed)
        # An executed action isn't a "proposed" one, so it doesn't trip the no-actions default.
        self.assertTrue(check(record, {}, "actions").passed)
        # add_to_collection_now falls back to a proposal (no error, added=false): not a write.
        fallback = self.write_record(tool_results=[{"name": "add_to_collection_now", "data": {"added": False, "reason": "condition not given"}}],
                                     action_details=[{"type": "add_to_collection", "state": "proposed", "params": {"card_id": "sv3pt5-199"}}])
        self.assertTrue(check(fallback, {"expect_no_write": True}, "expect_no_write").passed)
        self.assertFalse(check(fallback, spec, "expect_write", self.MERGED).passed)
        self.assertFalse(check(fallback, {}, "actions").passed)
        # O's real undo payload shape: action.undo = {deck_entry_id, quantity_added, expires_at}.
        real = self.write_record(tool_results=[{"name": "add_to_collection_now", "data": {"added": True}}],
                                 action_details=[{"type": "add_to_collection", "state": "done",
                                                  "undo": {"deck_entry_id": "d1", "quantity_added": 2, "expires_at": "x"}}])
        self.assertTrue(check(real, {"undo_offered": True}, "undo_offered", self.MERGED).passed)
        # The direct-add tile carries quantity_owned (L007 clears prior copies first).
        tiled = turn_record(cards=[{**CHARIZARD, "quantity_owned": 2}])
        quantity = check(tiled, {"tile_quantity": {"card_id": "sv3pt5-199", "quantity": 2}}, "tile_quantity")
        self.assertTrue(quantity.passed and not quantity.skipped)

    def test_merged_build_runs_every_planned_check(self) -> None:
        """With all 18 tools present, no shipped check skips for a missing tool."""
        data = load_case_file(DEFAULT_CASES_PATH)
        record = turn_record(tool_results=[])
        for case in data["cases"]:
            for turn in case["turns"]:
                for result in grade_turn(record, turn.get("expect"), data["defaults"], self.MERGED):
                    self.assertFalse(result.skipped and "not in this build" in result.reason, (case["id"], result))

    def test_proposed_card_ids(self) -> None:
        record = turn_record(action_details=[
            {"type": "add_to_collection", "params": {"card_id": "xy5-54"}},
            {"type": "add_to_collection", "params": {"card_id": "sv3pt5-199"}},
        ])
        self.assertTrue(check(record, {"proposed_card_ids": ["sv3pt5-199", "xy5-54"]}, "proposed_card_ids").passed)
        self.assertFalse(check(record, {"proposed_card_ids": ["sv3pt5-199"]}, "proposed_card_ids").passed)

    def test_tool_result_where_and_history_range(self) -> None:
        old = turn_record(tool_results=[{"name": "find_missing", "data": {"missing_count": 278}}])
        spec = {"tool_result_where": [{"tool": "find_missing", "where": {"priced_subtotal_usd": {"gte": 0}}}]}
        self.assertTrue(check(old, spec, "tool_result:find_missing").skipped)
        new = turn_record(tool_results=[{"name": "find_missing", "data": {"missing_count": 278, "priced_subtotal_usd": 12.5}}])
        self.assertTrue(check(new, spec, "tool_result:find_missing").passed)
        nested = turn_record(tool_results=[{"name": "find_top_graded", "data": {"cards": [{"price_trusted": False}, {"price_trusted": True}]}}])
        trusted = {"tool_result_where": [{"tool": "find_top_graded", "where": {"cards.price_trusted": True}}]}
        self.assertTrue(check(nested, trusted, "tool_result:find_top_graded").passed)
        self.assertTrue(check(turn_record(), {"tool_result_where": [{"tool": "grading_upside", "where": {"x": 1}}]},
                              "tool_result:grading_upside", self.BUILD).skipped)

        history = {"card_id": "sv3pt5-199", "first_date": "2026-04-02", "last_date": "2026-11-18", "covers_full_range": False}
        partial = turn_record(answer="Up 31% over the past year.", tool_results=[{"name": "get_price_history", "data": history}])
        self.assertFalse(check(partial, {"history_range_stated": True}, "history_range_stated").passed)
        partial["answer"] = "Since early April it's up 31%."
        self.assertTrue(check(partial, {"history_range_stated": True}, "history_range_stated").passed)
        partial["answer"] = "Since Apr 2 it's up 31%."
        self.assertTrue(check(partial, {"history_range_stated": True}, "history_range_stated").passed)
        no_flag = turn_record(tool_results=[{"name": "get_price_history", "data": {"card_id": "x"}}])
        self.assertTrue(check(no_flag, {"history_range_stated": True}, "history_range_stated").skipped)

    def test_skipped_checks_reach_the_report(self) -> None:
        record = turn_record(passed=True, checks=[{"name": "tiles_label", "passed": True, "skipped": True, "reason": "x"}])
        summary = summarize([record, {"case": "w", "category": "writes", "status": "skipped", "turn": 1}])
        self.assertEqual(summary["skipped_checks"], 1)
        self.assertEqual(summary["skipped_cases"], ["w"])
        self.assertIn("need --db-copy", render_report([record, {"case": "w", "category": "writes", "status": "skipped"}]))


class FakeJudgeMessages:
    def __init__(self, reply: Any) -> None:
        self.reply = reply
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def judge_reply(payload: Any, *, stop_reason: str = "end_turn") -> Any:
    body = payload if isinstance(payload, str) else json.dumps(payload)
    return SimpleNamespace(
        content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=body)],
        stop_reason=stop_reason,
        usage=SimpleNamespace(input_tokens=1_000_000, output_tokens=100_000, cache_read_input_tokens=0, cache_creation_input_tokens=0),
    )


def fake_judge(reply: Any) -> SimpleNamespace:
    return SimpleNamespace(messages=FakeJudgeMessages(reply))


class JudgeTests(unittest.TestCase):
    CRITERIA = ["Does it name a One Piece card?", "Is it short?"]

    def test_request_shape_and_pass(self) -> None:
        client = fake_judge(judge_reply({"criteria": [{"n": 1, "pass": True}, {"n": 2, "pass": True}], "reason": "Names Shanks."}))
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(grading.JUDGE_MODEL_ENV, None)
            result = judge_turn(client, self.CRITERIA, turn_record(tool_results=[{"call": "search_cards(game=onepiece)", "result": '{"cards":[]}'}]),
                                [{"question": "hi", "answer": "hello", "tiles": []}])
        self.assertTrue(result.passed)
        self.assertEqual((result.score, result.total), (2, 2))
        # Haiku 5.5 pricing: 1M in * $0.10 + 0.1M out * $0.50
        self.assertAlmostEqual(result.cost_usd, 0.15)
        call = client.messages.calls[0]
        self.assertEqual(call["model"], "claude-haiku-5-5")
        self.assertEqual(call["output_config"]["effort"], "low")
        self.assertEqual(call["output_config"]["format"]["type"], "json_schema")
        for banned in ("temperature", "top_p", "top_k", "thinking"):
            self.assertNotIn(banned, call)
        prompt = call["messages"][0]["content"]
        self.assertIn("1. Does it name a One Piece card?", prompt)
        self.assertIn("search_cards(game=onepiece) ->", prompt)
        self.assertIn("[Earlier] User: hi", prompt)
        self.assertTrue(judge_check(result).passed)

    def test_model_override_from_env(self) -> None:
        client = fake_judge(judge_reply({"criteria": [{"n": 1, "pass": True}], "reason": "ok"}))
        with mock.patch.dict(os.environ, {grading.JUDGE_MODEL_ENV: "claude-sonnet-5-5"}):
            result = judge_turn(client, "Is it fine?", turn_record())
        self.assertEqual(client.messages.calls[0]["model"], "claude-sonnet-5-5")
        self.assertAlmostEqual(result.cost_usd, 2.0 + 1.0)

    def test_failed_and_skipped_criteria(self) -> None:
        client = fake_judge(judge_reply({"criteria": [{"n": 1, "pass": True}], "reason": " ".join(["word"] * 40)}))
        result = judge_turn(client, self.CRITERIA, turn_record())
        self.assertFalse(result.passed)
        self.assertEqual(result.criteria, [True, False])
        self.assertLessEqual(len(result.reason.split()), 30)
        self.assertIn("failed #2", judge_check(result).reason)

    def test_errors_are_not_verdicts(self) -> None:
        for client, needle in (
            (fake_judge(RuntimeError("boom")), "RuntimeError"),
            (fake_judge(judge_reply("not json")), "unparseable"),
            (fake_judge(judge_reply({"criteria": [{"n": 1, "pass": "yes"}], "reason": ""})), "unparseable"),
            (fake_judge(judge_reply("", stop_reason="refusal")), "refused"),
        ):
            result = judge_turn(client, self.CRITERIA, turn_record())
            self.assertFalse(result.passed)
            self.assertIn(needle, result.error)
            self.assertIn("judge error", judge_check(result).reason)
        self.assertEqual(judge_turn(fake_judge(None), [], turn_record()).error, "empty rubric")


class JudgeContextTests(unittest.TestCase):
    """Run 1's judge saw tool results cut at 3000 chars and no scanner context."""

    def big_search(self) -> dict[str, Any]:
        cards = [{"card_id": f"c{i}", "name": f"Filler {i}", "set": "Some Set", "number": f"{i}/200",
                  "price_usd": 1.0 + i, "image_small_url": "https://x/" + "y" * 80} for i in range(200)]
        cards.append({"card_id": "sv3pt5-199", "name": "Charizard ex", "set": "151", "number": "199/165",
                      "price_usd": 287.93, "price_trusted": True})
        return {"total": 201, "lower_bound": False, "cards": cards,
                "points": [{"date": "2026-04-01", "usd": 200.0}, {"date": "2026-11-18", "usd": 287.93}]}

    def test_compact_results_keep_named_cards_and_key_fields(self) -> None:
        record = turn_record(
            answer="Charizard ex is the one at $287.93.",
            tool_results=[{"name": "search_cards", "call": "search_cards(text=charizard)", "data": self.big_search(),
                           "result": "{...}"}],
        )
        text = grading.compact_tool_results(record, budget=2000)
        self.assertLessEqual(len(text), 2600)
        self.assertIn("sv3pt5-199 | Charizard ex | 151 #199/165 | $287.93 | price_trusted=True", text)
        self.assertIn('"total": 201', text)
        self.assertIn("2026-04-01 $200.00 -> 2026-11-18 $287.93", text)
        self.assertIn("more cards not shown", text)
        self.assertNotIn("image_small_url", text)
        # The default budget is 12k and fits far more than run 1's 3000 chars.
        self.assertEqual(grading.MAX_TOOL_RESULT_CHARS, 12000)
        self.assertGreater(len(grading.compact_tool_results(record)), 9000)

    def test_old_records_fall_back_to_text(self) -> None:
        record = turn_record(tool_results=[{"call": "get_card(card_id=x)", "result": '{"name":"Shanks"}'}])
        self.assertIn('get_card(card_id=x) -> {"name":"Shanks"}', grading.compact_tool_results(record))

    def test_prompt_has_scanner_context_reference_and_label(self) -> None:
        record = turn_record(
            question="Which of these is worth the most?", context_card_ids=["sv3pt5-199"],
            scanner_context="The user is looking at these scanned cards:\n- Charizard ex · 151 · #199/165 · $287.93 (card_id: sv3pt5-199)",
            reference="Charizard ex (151) is worth the most at $287.93.", cards_label="Your scan tray",
            tool_results=[],
        )
        prompt = grading.judge_prompt(["Picks the highest?"], record)
        self.assertIn("Scanner context the assistant saw:", prompt)
        self.assertIn("(card_id: sv3pt5-199)", prompt)
        self.assertIn("Reference answer (guidance; equivalent meaning passes, exact wording not required)", prompt)
        self.assertIn("labelled 'Your scan tray'", prompt)
        self.assertLess(prompt.index("Reference answer"), prompt.index("Criteria:"))
        self.assertIn("equivalent meaning passes", grading.JUDGE_SYSTEM)
        ids_only = grading.judge_prompt(["x?"], turn_record(context_card_ids=["a", "b"]))
        self.assertIn("Scanner tray card ids: a, b", ids_only)


class CaseFileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = load_case_file(DEFAULT_CASES_PATH)

    def known_tools(self) -> frozenset[str]:
        if not HAVE_DEPS:
            return TOOLS
        from mcp_server.assistant.tools import TOOL_DEFINITIONS

        return frozenset(tool["name"] for tool in TOOL_DEFINITIONS)

    def test_shipped_cases_are_valid(self) -> None:
        self.assertEqual(validate_cases(self.data, self.known_tools()), [])

    def test_hardcoded_tool_list_matches_assistant(self) -> None:
        if not HAVE_DEPS:
            self.skipTest("assistant deps unavailable")
        self.assertEqual(self.known_tools(), TOOLS)

    def test_coverage(self) -> None:
        cases = self.data["cases"]
        self.assertGreaterEqual(len(cases), 45)
        self.assertTrue(any(len(case["turns"]) > 1 for case in cases))
        self.assertTrue(any(case.get("holdout") for case in cases))
        self.assertTrue(any(turn.get("card_ids") for case in cases for turn in case["turns"]))
        asks = {turn["ask"] for case in cases for turn in case["turns"]}
        for chip in ("Undervalued cards", "Cards with the most recent new high sales", "What cards are likely to go up?"):
            self.assertIn(chip, asks)
        for case in cases:
            for turn in case["turns"]:
                if not turn.get("retry"):  # a retry replays the same reply; its checks are code-only
                    self.assertTrue(turn.get("rubric"), f"{case['id']} has a turn without judge criteria")

    def test_owner_review_labels_are_all_covered(self) -> None:
        labels = " ".join(str(case.get("review_label") or "") for case in self.data["cases"])
        for number in range(1, 31):
            self.assertIn(f"L{number:03d}", labels)
        by_id = {case["id"]: case for case in self.data["cases"]}
        self.assertIn("why_charizard_moved_no_history", by_id)
        add = by_id["add_quantity_2"]
        self.assertTrue(add["writes"])
        self.assertTrue(add["turns"][1]["retry"])
        for case in self.data["cases"]:
            if case.get("review_label"):
                self.assertTrue(any(t.get("reference") or t.get("retry") for t in case["turns"])
                                or case["id"] in {"off_topic_poem", "off_topic_weather", "psa_vs_cgc", "ambiguous_charizard_price",
                                                  "ambiguous_pikachu_add", "en_twin_of_jp", "wishlist_wording", "scanner_add_all"},
                                case["id"])

    def test_new_keys_are_validated(self) -> None:
        bad = copy.deepcopy(self.data)
        bad["cases"][0]["turns"][0]["expect"] = {
            "tiles_exact": [{"colour": "red"}],
            "tiles_include": [],
            "tile_quantity": {"card_id": "x"},
            "tiles_sorted": "name",
            "tiles_max": -1,
            "tiles_label": "(",
            "tool_result_where": [{"tool": "nope", "where": {"a": 1}}],
        }
        bad["cases"][1]["turns"].append({"ask": "different", "retry": True, "rubric": ["ok?"]})
        bad["cases"][2]["state_checks"] = {"holding_delta": [{"card_id": "x", "delta": 1}]}
        bad["cases"][3]["fixtures"] = {"delete": [{"table": "deck entries; drop", "where": {"a": 1}}], "upsert": []}
        errors = "\n".join(validate_cases(bad, TOOLS))
        for needle in ("unknown tile predicate 'colour'", "tiles_include: needs at least one", "tile_quantity: needs",
                       "tiles_sorted: must be", "tiles_max: must be", "tiles_label: bad regex", "tool_result_where[0]: needs tool",
                       "retry turn repeats", "state_checks need writes", "needs table", "unknown key 'upsert'"):
            self.assertIn(needle, errors)
        # Planned tools validate before they exist (their checks skip at run time).
        ok = copy.deepcopy(self.data)
        ok["cases"][0]["turns"][0]["expect"] = {"tools_any": ["show_cards", "grading_upside"]}
        self.assertEqual(validate_cases(ok, TOOLS), [])

    def test_validation_catches_mistakes(self) -> None:
        bad = copy.deepcopy(self.data)
        bad["cases"][0]["turns"][0]["expect"] = {
            "tools_any": ["search_card"],
            "tool_args": [{"tool": "search_cards", "where": {"filter.game": {"equals": "x"}}}],
            "tiles_none_match": [{"game_not": "magic"}],
            "allow": ["not_a_ban"],
            "expect_action": {"type": "delete_card"},
            "bogus": 1,
        }
        bad["cases"][1]["id"] = bad["cases"][0]["id"]
        bad["cases"][2]["turns"][0]["rubric"] = []
        bad["cases"][3]["holdout"] = "yes"
        errors = "\n".join(validate_cases(bad, TOOLS))
        for needle in ("unknown tool 'search_card'", "unknown matcher ops", "game_not must be", "not a defaults.banned",
                       "expect_action", "unknown expect key 'bogus'", "duplicate id", "rubric must be", "holdout must be"):
            self.assertIn(needle, errors)
        self.assertEqual(validate_cases({"nope": 1}, TOOLS), ["top level must be a mapping with a `cases` list"])

    def test_feedback_export_stub_shape_loads(self) -> None:
        stub = {
            "id": "feedback_ab12CD34ef56",
            "source": "user feedback 👎 on msg_ab12 (2026-11-19)",
            "turns": [{"question": "What's the most expensive One Piece card?"}],
            "expectations": {"tools_any": ["search_cards"]},
            "judge_rubric": "TODO: write the rubric. User said 👎.",
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stubs.json"
            path.write_text(json.dumps({"cases": [stub]}))
            data = load_case_file(path)
        case = data["cases"][0]
        self.assertEqual(case["id"], "feedback_ab12cd34ef56")
        self.assertEqual(case["category"], "feedback")
        self.assertEqual(case["turns"][0]["ask"], stub["turns"][0]["question"])
        self.assertEqual(case["turns"][0]["expect"], {"tools_any": ["search_cards"]})
        self.assertIn("rubric still has a TODO", "\n".join(validate_cases(data, TOOLS)))
        case["turns"][0]["rubric"] = ["Does it name a One Piece card?"]
        self.assertEqual(validate_cases(data, TOOLS), [])

    def test_select(self) -> None:
        self.assertEqual([c["id"] for c in select_cases(self.data, ["undervalued"])], ["undervalued"])
        self.assertTrue(all(c["category"] == "investing" for c in select_cases(self.data, categories=["investing"])))
        with self.assertRaises(ValueError):
            select_cases(self.data, ["nope"])


def graded(case: str, passed: bool, *, category: str = "x", turn: int = 1, repeat: int = 1, holdout: bool = False, **extra) -> dict[str, Any]:
    return {"case": case, "category": category, "turn": turn, "repeat": repeat, "holdout": holdout, "passed": passed,
            "question": f"q {case}", "answer": f"a {case}", "cost_usd": 0.01, "checks": [], "judge": None, **extra}


class ReportTests(unittest.TestCase):
    def test_case_rollup_repeats_and_holdout(self) -> None:
        records = [
            graded("a", True, turn=1), graded("a", False, turn=2),
            graded("b", True, repeat=1), graded("b", False, repeat=2),
            graded("c", True, holdout=True, category="y"),
        ]
        cases = case_results(records)
        self.assertFalse(cases["a"]["passed"])
        self.assertFalse(cases["b"]["passed"])
        self.assertTrue(cases["b"]["flaky"])
        self.assertFalse(cases["a"]["flaky"])
        summary = summarize(records)
        self.assertEqual((summary["passed"], summary["cases"]), (1, 3))
        self.assertEqual(summary["holdout"], {"passed": 1, "total": 1, "pass_rate": 1.0})
        self.assertEqual(summary["dev"]["total"], 2)
        self.assertEqual(summary["flaky"], ["b"])
        self.assertAlmostEqual(summary["chat_cost_usd"], 0.05)

    def test_compare(self) -> None:
        before = [graded("a", True), graded("b", False), graded("c", True), {"case": "old", "turn": 1}]
        after = [graded("a", False), graded("b", True), graded("c", True), graded("new", True)]
        diff = compare(before, after)
        self.assertEqual(diff["pass_to_fail"], ["a"])
        self.assertEqual(diff["fail_to_pass"], ["b"])
        self.assertEqual(diff["new"], ["new"])
        self.assertEqual(diff["missing"], ["old"])
        self.assertIn("pass → FAIL (1): a", format_compare(diff))
        self.assertEqual(format_compare(compare(after, after)), "no flips vs previous run")

    def test_ungraded_rows_are_not_counted(self) -> None:
        summary = summarize([{"case": "legacy", "turn": 1, "cost_usd": 0.01}])
        self.assertEqual(summary["cases"], 0)

    def test_render(self) -> None:
        records = [
            graded("good", True, category="investing"),
            graded("bad", False, category="pricing_rank", holdout=True, tool_calls=["search_cards(game=onepiece)"],
                   checks=[{"name": "tiles_none_match", "passed": False, "reason": "Charizard [sv3pt5-199] matches"}],
                   judge={"passed": False, "score": 1, "total": 2, "reason": "Names a Pokémon card.", "cost_usd": 0.002}),
        ]
        text = render_report(records, diff=compare([graded("bad", True)], records))
        self.assertIn("**Pass rate: 50%** (1/2 cases)", text)
        self.assertIn("| investing | 1 | 1 |", text)
        self.assertIn("Holdout set: 0% (0/1)", text)
        self.assertIn("### bad (pricing_rank, holdout)", text)
        self.assertIn("FAIL `tiles_none_match`: Charizard", text)
        self.assertIn("judge fail (1/2): Names a Pokémon card.", text)
        self.assertIn("pass → FAIL (1): bad", text)
        self.assertIn("judge $0.0020", text)
        self.assertNotIn("### good", text)


class CalibrationTests(unittest.TestCase):
    def test_export_then_calibrate(self) -> None:
        records = [
            graded(f"case{i}", True, category=f"cat{i % 3}", status="ok", rubric=["Is it right?"], tiles=["Card · $1.00 [c1]"],
                   cards=[{"card_id": "c1", "name": "Card"}, {"card_id": "c2", "name": "Slab", "grader": "PSA", "grade": "10"}],
                   reference="Card is $1.")
            for i in range(10)
        ]
        records.append(graded("case0", True, category="cat0", turn=2, status="ok", rubric=["Consistent?"]))
        records.append(graded("norubric", True, status="ok"))
        picked = pick_label_rows(records, 4)
        self.assertEqual([r["category"] for r in picked], ["cat0", "cat1", "cat2", "cat0"])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "labels.csv"
            self.assertEqual(export_labels(records, path, 30), 11)
            sidecar = [json.loads(line) for line in sidecar_path(path).read_text().splitlines()]
            followup = next(item for item in sidecar if item["record"]["turn"] == 2)
            self.assertEqual(followup["prior_turns"][0]["question"], "q case0")
            with path.open(newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]["human_pass"], "")
            self.assertEqual(rows[0]["tile_ids"], "c1; c2")
            self.assertEqual(rows[0]["tile_names"], "Card; Slab PSA 10")
            self.assertEqual(rows[0]["reference"], "Card is $1.")
            for row, label in zip(rows, ["yes", "no", "Y", "", "fail"]):
                row["human_pass"] = label
            with path.open("w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)

            def judge(rubric, record, prior):
                return JudgeResult(True, 1, "fine", total=1, criteria=[True], cost_usd=0.001)

            result = calibrate(path, judge)
        self.assertEqual(result["labeled"], 4)
        self.assertEqual(result["agree"], 2)
        self.assertEqual(result["agreement"], 0.5)
        self.assertEqual(len(result["disagreements"]), 2)
        self.assertAlmostEqual(result["judge_cost_usd"], 0.004)

    def test_parse_human(self) -> None:
        self.assertTrue(parse_human(" Yes "))
        self.assertFalse(parse_human("0"))
        self.assertIsNone(parse_human("maybe"))


def load_runner():
    spec = importlib.util.spec_from_file_location("assistant_eval_runner", BACKEND_ROOT / "tools" / "assistant_eval.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RunnerOfflineTests(unittest.TestCase):
    def test_finish_min_pass_report_and_compare(self) -> None:
        runner = load_runner()
        records = [graded("a", True), graded("b", False)]
        with tempfile.TemporaryDirectory() as tmp:
            previous = Path(tmp) / "prev.jsonl"
            previous.write_text("\n".join(json.dumps(r) for r in [graded("a", True), graded("b", True)]))
            report = Path(tmp) / "r.md"
            args = runner.build_parser().parse_args(["--report", str(report), "--compare", str(previous), "--min-pass", "60"])
            self.assertEqual(args.min_pass, 0.6)
            with mock.patch("sys.stderr"):
                self.assertEqual(runner.finish(args, records), 1)
                args.min_pass = 0.5
                self.assertEqual(runner.finish(args, records), 0)
            self.assertIn("pass → FAIL (1): b", report.read_text())
        self.assertTrue(runner.build_parser().parse_args(["--no-judge"]).judge is False)

    def test_grade_case_with_judge(self) -> None:
        runner = load_runner()
        case = {"id": "c", "category": "x", "turns": [{"ask": "q1", "expect": {}, "rubric": ["ok?"]}, {"ask": "q2"}]}
        records = [turn_record(turn=1, answer="Fine answer at $5."), turn_record(turn=2, answer="Second.")]
        client = fake_judge(judge_reply({"criteria": [{"n": 1, "pass": False}], "reason": "Wrong card."}))
        runner.grade_case(case, records, DEFAULTS, client)
        self.assertFalse(records[0]["passed"])
        self.assertEqual(records[0]["judge"]["reason"], "Wrong card.")
        self.assertTrue(records[1]["passed"])
        self.assertIsNone(records[1]["judge"])
        self.assertEqual(len(client.messages.calls), 1)
        # Stopped early (HTTP error on turn 1 of 2): the case fails.
        stopped = [{"case": "c", "turn": 1, "question": "q1", "status": "http_502", "error": {}, "answer": ""}]
        runner.grade_case(case, stopped, DEFAULTS, None)
        self.assertFalse(stopped[0]["passed"])


def make_db(path: Path) -> None:
    import sqlite3

    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE deck_entries (id TEXT PRIMARY KEY, owner_user_id TEXT, card_id TEXT, quantity INTEGER)")
    conn.execute("CREATE TABLE slab_recent_sales (id TEXT PRIMARY KEY, card_id TEXT, price REAL, created_at TEXT)")
    conn.executemany("INSERT INTO deck_entries VALUES (?, ?, ?, ?)", [
        ("d1", "u1", "sv3pt5-199", 1), ("d2", "u1", "xy5-54", 3), ("d3", "u2", "sv3pt5-199", 5),
    ])
    conn.execute("INSERT INTO slab_recent_sales VALUES ('s0', 'bw5-104', 900.0, 'old')")
    conn.commit()
    conn.close()


def rows(path: Path, sql: str) -> list[tuple]:
    import sqlite3

    conn = sqlite3.connect(str(path))
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


class FixtureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.src = Path(self.tmp.name) / "live.sqlite"
        make_db(self.src)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_db_copy_is_independent(self) -> None:
        from assistant_eval.fixtures import copy_database

        copy = copy_database(self.src, Path(self.tmp.name) / "copy.sqlite")
        self.assertEqual(rows(copy, "SELECT COUNT(*) FROM deck_entries"), [(3,)])
        import sqlite3

        conn = sqlite3.connect(str(copy))
        conn.execute("DELETE FROM deck_entries")
        conn.commit()
        conn.close()
        self.assertEqual(rows(self.src, "SELECT COUNT(*) FROM deck_entries"), [(3,)])
        with self.assertRaises(FileNotFoundError):
            copy_database(Path(self.tmp.name) / "nope.sqlite", Path(self.tmp.name) / "x.sqlite")

    def test_apply_and_cleanup_restore_rows(self) -> None:
        from assistant_eval.fixtures import CaseFixtures

        before_deck = rows(self.src, "SELECT * FROM deck_entries ORDER BY id")
        before_sales = rows(self.src, "SELECT * FROM slab_recent_sales ORDER BY id")
        fixtures = CaseFixtures(self.src, "u1")
        fixtures.apply({
            "delete": [{"table": "deck_entries", "where": {"owner_user_id": "$USER", "card_id": "sv3pt5-199"}},
                       {"table": "slab_recent_sales", "where": {"card_id": "bw5-104"}},
                       {"table": "card_price_history_daily", "where": {"card_id": "x"}}],  # absent table: ignored
            "insert": [{"table": "slab_recent_sales", "rows": [{"id": "s1", "card_id": "bw5-104", "price": 1450.0, "created_at": "$NOW"}]}],
        })
        self.assertEqual(rows(self.src, "SELECT card_id FROM deck_entries WHERE owner_user_id = 'u1'"), [("xy5-54",)])
        self.assertEqual(fixtures.holding_quantity("sv3pt5-199"), 0)
        inserted = rows(self.src, "SELECT id, price, created_at FROM slab_recent_sales")
        self.assertEqual(inserted[0][:2], ("s1", 1450.0))
        self.assertNotEqual(inserted[0][2], "$NOW")
        # The assistant writes during a `writes: true` case; cleanup puts the owner's rows back.
        fixtures.snapshot_owner_holdings()
        import sqlite3

        conn = sqlite3.connect(str(self.src))
        conn.execute("INSERT INTO deck_entries VALUES ('new', 'u1', 'sv3pt5-199', 2)")
        conn.commit()
        conn.close()
        self.assertEqual(fixtures.holding_quantity("sv3pt5-199"), 2)
        fixtures.cleanup()
        fixtures.close()
        self.assertEqual(rows(self.src, "SELECT * FROM deck_entries ORDER BY id"), before_deck)
        self.assertEqual(rows(self.src, "SELECT * FROM slab_recent_sales ORDER BY id"), before_sales)

    def test_shipped_fixtures_name_real_columns(self) -> None:
        from assistant_eval.fixtures import case_needs_db_copy

        data = load_case_file(DEFAULT_CASES_PATH)
        needing = [case["id"] for case in data["cases"] if case_needs_db_copy(case)]
        self.assertEqual(set(needing), {"complete_151_cost", "worth_grading", "why_charizard_moved_no_history", "add_quantity_2"})
        schema = {
            "deck_entries": {"owner_user_id", "card_id"},
            "slab_recent_sales": {"id", "card_id", "grader", "grade", "source", "source_sale_id", "rank", "title", "sold_at",
                                  "price", "currency_code", "created_at"},
            "slab_recent_sales_cache": {"card_id", "grader", "grade", "source", "status", "result_count", "fetched_at",
                                        "created_at", "updated_at"},
            "card_price_history_daily": {"card_id"},
            "card_price_history_cell": {"card_id"},
        }
        for case in data["cases"]:
            for spec in (case.get("fixtures") or {}).get("delete") or []:
                self.assertLessEqual(set(spec["where"]), schema[spec["table"]], case["id"])
            for spec in (case.get("fixtures") or {}).get("insert") or []:
                for row in spec["rows"]:
                    self.assertLessEqual(set(row), schema[spec["table"]], case["id"])


class RunnerFixtureTests(unittest.TestCase):
    def test_prepare_database_copies_and_points_at_the_copy(self) -> None:
        runner = load_runner()
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "live.sqlite"
            make_db(src)
            args = runner.build_parser().parse_args(["--database-path", str(src), "--db-copy"])
            with mock.patch("sys.stderr"):
                temp_dir = runner.prepare_database(args)
            try:
                self.assertNotEqual(args.database_path, str(src))
                self.assertTrue(args.database_path.startswith(temp_dir))
                self.assertEqual(rows(Path(args.database_path), "SELECT COUNT(*) FROM deck_entries"), [(3,)])
            finally:
                import shutil

                shutil.rmtree(temp_dir)
            plain = runner.build_parser().parse_args(["--database-path", str(src)])
            self.assertIsNone(runner.prepare_database(plain))
            self.assertEqual(plain.database_path, str(src))

    def test_state_checks_and_skipped_records(self) -> None:
        runner = load_runner()
        case = {"id": "add", "category": "writes", "writes": True, "review_label": "L007",
                "state_checks": {"holding_delta": [{"card_id": "sv3pt5-199", "delta": 2}]}, "turns": [{"ask": "Add 2"}]}
        merged = TOOLS
        ok = runner.state_check_results(case, {"sv3pt5-199": 1}, {"sv3pt5-199": 3}, merged)
        self.assertTrue(ok[0].passed and not ok[0].skipped)
        doubled = runner.state_check_results(case, {"sv3pt5-199": 1}, {"sv3pt5-199": 5}, merged)
        self.assertFalse(doubled[0].passed)
        self.assertIn("changed by 4", doubled[0].reason)
        self.assertTrue(runner.state_check_results(case, {}, {}, TOOLS - grading.PLANNED_TOOLS)[0].skipped)
        skipped = runner.skipped_record(case, 1, "needs --db-copy")
        self.assertNotIn("passed", skipped)
        self.assertIsNone(case_results([skipped])["add"]["passed"])
        # Case-level checks attach to the last turn.
        records = [turn_record(case="add", turn=1, answer="Added 2.")]
        runner.grade_case(case, records, DEFAULTS, None, known_tools=merged, case_checks=doubled)
        self.assertFalse(records[0]["passed"])
        self.assertIn("holding_delta:sv3pt5-199", [c["name"] for c in records[0]["checks"]])


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class RunnerEndToEndTests(AssistantCase):
    """run_case through the real AssistantService with a scripted fake model."""

    def test_run_case_records_structured_args_and_results(self) -> None:
        runner = load_runner()
        from mcp_server.assistant.service import Caller

        self.client.queue(
            message([tool_use("search_cards", {"filter": {"text": "pikachu", "game": "pokemon"}, "sort": "price_desc"})],
                    stop_reason="tool_use"),
            message([text("Pikachu ex is the priciest at $120.")]),
        )
        recorder = runner.ToolRecorder(self.assistant.toolbox)
        case = {"id": "pika", "category": "pricing_rank", "turns": [{"ask": "Priciest Pikachu?", "card_ids": ["ssp-1"]}]}
        records, thread_id = asyncio.run(runner.run_case(self.assistant, Caller(USER_A, False), recorder, case, 1))
        self.assertIsNotNone(thread_id)
        record = records[0]
        self.assertEqual(record["status"], "ok")
        self.assertEqual(record["tool_args"][0]["arguments"]["filter"]["game"], "pokemon")
        self.assertIn("search_cards(", record["tool_results"][0]["call"])
        self.assertIn("Pikachu ex", record["tool_results"][0]["result"])
        self.assertEqual(record["cards"][0]["card_id"], "ssp-1")
        self.assertEqual(record["context_card_ids"], ["ssp-1"])
        self.assertIn("scanned cards", json.dumps(self.client.messages.calls[0]["messages"]))
        expect = {"tool_args": [{"tool": "search_cards", "where": {"filter.text": {"contains": "pikachu"}}}], "tiles_min": 1}
        runner.grade_case({**case, "turns": [{**case["turns"][0], "expect": expect}]}, records, DEFAULTS, None)
        self.assertTrue(record["passed"], record["checks"])
        # New: structured results, catalog meta on tiles, the scanner context the model saw.
        self.assertIsInstance(record["tool_results"][0]["data"], dict)
        self.assertIn("game", record["cards"][0])
        self.assertIn("[ssp-1]", record["tiles"][0])
        self.assertIn("scanned cards", record["scanner_context"] or "")
        self.assertEqual(record["context_cards"][0]["card_id"], "ssp-1")

    def test_l026_fixture_feeds_grading_upside(self) -> None:
        """The shipped L026 comp rows are exactly what grading_upside reads."""
        from assistant_eval.fixtures import CaseFixtures

        self.card("bw5-104", "Kyogre-EX", number="104/108", set_name="Dark Explorers")
        self.card("xy5g_ja-77", "Teammates", number="077/070", set_name="ガイアボルケーノ")
        self.price("bw5-104", 504.48)
        self.price("xy5g_ja-77", 2.0)
        self.holding("k1", USER_A, "bw5-104")
        self.conn.commit()
        case = next(c for c in load_case_file(DEFAULT_CASES_PATH)["cases"] if c["id"] == "worth_grading")
        db_path = Path(self.tempdir.name) / "assistant.sqlite"
        fixtures = CaseFixtures(db_path, USER_A)
        try:
            fixtures.apply(case["fixtures"])
            result = self.tools.grading_upside(USER_A, ["bw5-104", "xy5g_ja-77"])
        finally:
            fixtures.cleanup()
            fixtures.close()
        by_id = {item["card_id"]: item for item in result["cards"]}
        kyogre = by_id["bw5-104"]
        self.assertEqual(kyogre["comp_source"], "ebay_sold")
        self.assertIn(kyogre["comp_price_usd"], (1450.0, 1500.0))
        self.assertEqual(kyogre["comp_sale_count"], 2)
        self.assertAlmostEqual(kyogre["gross_premium_usd"], round(kyogre["comp_price_usd"] - 504.48, 2))
        self.assertEqual((by_id["xy5g_ja-77"]["comp_source"], by_id["xy5g_ja-77"]["comp_price_usd"]), ("ebay_sold", 45.0))
        # The case's own result check passes on this real result.
        expect = case["turns"][0]["expect"]
        record = turn_record(tool_results=[{"name": "grading_upside", "data": result}])
        self.assertTrue(grading.check_tool_result_where(record, expect["tool_result_where"][0], TOOLS).passed)
        # Cleanup removed the comps again.
        self.assertTrue(self.tools.grading_upside(USER_A, ["bw5-104"])["cards"][0]["comp_missing"])

    def test_retry_turn_resends_the_same_request(self) -> None:
        runner = load_runner()
        from mcp_server.assistant.service import Caller

        self.client.queue(message([text("Pikachu ex is $120.")]))
        recorder = runner.ToolRecorder(self.assistant.toolbox)
        case = {"id": "r", "category": "writes", "turns": [{"ask": "Priciest Pikachu?"}, {"ask": "Priciest Pikachu?", "retry": True}]}
        records, _ = asyncio.run(runner.run_case(self.assistant, Caller(USER_A, False), recorder, case, 1))
        self.assertEqual([r["status"] for r in records], ["ok", "ok"])
        self.assertTrue(records[1]["retry"])
        self.assertEqual(records[0]["answer"], records[1]["answer"])
        self.assertEqual(len(self.client.messages.calls), 1)  # replayed by client_message_id, no second model call


if __name__ == "__main__":
    unittest.main()
