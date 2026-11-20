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
     "find_top_graded", "propose_add_to_collection", "propose_update_holding", "propose_watch_card"}
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
                self.assertTrue(turn.get("rubric"), f"{case['id']} has a turn without judge criteria")

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
            graded(f"case{i}", True, category=f"cat{i % 3}", status="ok", rubric=["Is it right?"], tiles=["Card · $1.00"])
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


if __name__ == "__main__":
    unittest.main()
