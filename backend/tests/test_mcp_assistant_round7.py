"""Eval round 7: answers split across tool rounds, named cards always tiles, history
range and watch target taken from the question."""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, FakeClient, message, text, tool_use  # noqa: E402

from mcp_server.assistant import length_guard  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.engine import (
        ANSWER_NOW_NOTE,
        EMPTY_TEXT,
        AssistantEngine,
        correct_tool_arguments,
        history_range_for,
        merge_answer_parts,
        question_target_usd,
        substantive_text,
    )
    from mcp_server.assistant.tools import AssistantToolbox, apply_question_rules, choose_tiles


def ref(card_id: str, name: str, number: str = "1", set_name: str = "Set", **extra: Any) -> dict[str, Any]:
    return {"card_id": card_id, "name": name, "number": number, "set": set_name, **extra}


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class AnswerPartsUnitTests(unittest.TestCase):
    def test_substantive_text(self) -> None:
        self.assertEqual(substantive_text("Let me check the 1y history."), "")
        self.assertEqual(substantive_text("Checking now."), "")
        self.assertEqual(substantive_text("Kyogre-EX gained $18.49 this month."), "Kyogre-EX gained $18.49 this month.")
        self.assertEqual(
            substantive_text("Kyogre-EX gained $18.49. Let me pull its history too."), "Kyogre-EX gained $18.49."
        )
        twelve = "Your biggest gainers by dollars were Kyogre and Snorlax while Gyarados led in percent terms"
        self.assertEqual(substantive_text(twelve), twelve)
        self.assertEqual(substantive_text("Nice pick, that card is great."), "")
        self.assertEqual(substantive_text("Kyogre is up $5.\n<followups>\nMore?\n</followups>"), "Kyogre is up $5.")

    def test_merge_dedupes_both_ways(self) -> None:
        earlier = "Kyogre-EX gained $18.49 this month, the most by dollars."
        self.assertEqual(merge_answer_parts([earlier, "Kyogre-EX gained $18.49 this month!"]), earlier)
        restated = "Kyogre-EX gained $18.49 this month, the most by dollars; Snorlax led in percent at 40%."
        self.assertEqual(merge_answer_parts([earlier, restated]), restated)
        extra = "Its Near Mint price went from $318.96 on Aug 22 to $504.48 on Nov 19."
        self.assertEqual(merge_answer_parts([earlier, extra]), f"{earlier}\n\n{extra}")
        self.assertEqual(merge_answer_parts(["", extra, ""]), extra)


class DisclaimerPhrasesTests(unittest.TestCase):
    def test_equivalent_phrasings_count_as_the_disclaimer(self) -> None:
        for line in ("It's no sure bet.", "Not a sure thing.", "I can't promise it climbs.", "Not a forecast."):
            self.assertFalse(length_guard.needs_disclaimer(line, ["get_market_trends"]), line)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class ArgumentCorrectionUnitTests(unittest.TestCase):
    def test_history_range_from_question(self) -> None:
        cases = {
            "How has Charizard ex moved over the past year?": "1y",
            "Pikachu price over the last 12 months": "1y",
            "Show the 1y chart": "1y",
            "Last 3 months of Kyogre": "90d",
            "Kyogre over 90 days": "90d",
            "How did it do in the past month?": "30d",
            "Price over 30 days": "30d",
            "Show Kyogre-EX's price history": None,
        }
        for question, expected in cases.items():
            self.assertEqual(history_range_for(question), expected, question)

    def test_history_range_only_lengthens(self) -> None:
        question = "How has it moved over the past year?"
        for given in (None, "30d", "90d"):
            args = {"card_id": "x"} if given is None else {"card_id": "x", "range": given}
            self.assertEqual(correct_tool_arguments("get_price_history", args, question)["range"], "1y")
        self.assertEqual(correct_tool_arguments("get_price_history", {"range": "1y"}, "past month")["range"], "1y")
        self.assertEqual(correct_tool_arguments("get_price_history", {}, "past month")["range"], "30d")
        self.assertNotIn("range", correct_tool_arguments("get_price_history", {}, "Show its history"))

    def test_watch_target_from_question(self) -> None:
        self.assertEqual(question_target_usd("Watch it and alert me if it drops under $400"), 400.0)
        self.assertEqual(question_target_usd("Ping me below $1,250.50"), 1250.5)
        self.assertEqual(question_target_usd("It's $300 now, alert me under $250"), 250.0)
        self.assertIsNone(question_target_usd("Is Pikachu worth $400?"))
        self.assertIsNone(question_target_usd("Watch Pikachu ex"))
        args = correct_tool_arguments("propose_watch_card", {"card_id": "x"}, "alert me under $400")
        self.assertEqual(args["target_price_usd"], 400.0)
        kept = correct_tool_arguments("propose_watch_card", {"card_id": "x", "target_price_usd": 350}, "under $400")
        self.assertEqual(kept["target_price_usd"], 350)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class Round7EngineCase(AssistantCase):
    def run_turn(self, client: Any, question: str) -> Any:
        engine = AssistantEngine(self.config, AssistantToolbox(self.tools), client)
        return asyncio.run(engine.run_turn(owner_user_id=USER_A, history=[], question=question))


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class SplitAnswerEngineTests(Round7EngineCase):
    SEARCH = {"filter": {"text": "pikachu"}}

    def two_rounds(self, first_text: str | None, final: list[Any], *extra: Any) -> FakeClient:
        first = ([text(first_text)] if first_text else []) + [tool_use("search_cards", self.SEARCH, "s1")]
        return FakeClient([message(first, "tool_use"), message(final), *extra])

    def test_answer_next_to_a_tool_call_is_kept_with_the_final_text(self) -> None:
        client = self.two_rounds(
            "Pikachu ex gained $20.00 this month, your biggest gainer by dollars.",
            [text("Its price went from $100.00 on Oct 20 to $120.00 on Nov 19.")],
        )
        turn = self.run_turn(client, "What were my biggest gainers this month?")
        self.assertEqual(
            turn.text,
            "Pikachu ex gained $20.00 this month, your biggest gainer by dollars.\n\n"
            "Its price went from $100.00 on Oct 20 to $120.00 on Nov 19.",
        )

    def test_near_duplicate_final_is_dropped(self) -> None:
        client = self.two_rounds("Pikachu ex is $120.00 right now.", [text("Pikachu ex is $120.00 right now!")])
        self.assertEqual(self.run_turn(client, "How much is Pikachu ex?").text, "Pikachu ex is $120.00 right now.")

    def test_final_that_restates_the_earlier_text_replaces_it(self) -> None:
        final = "Pikachu ex is $120.00 right now, up from $100.00 a month ago."
        client = self.two_rounds("Pikachu ex is $120.00 right now.", [text(final)])
        self.assertEqual(self.run_turn(client, "How much is Pikachu ex?").text, final)

    def test_preamble_is_not_kept(self) -> None:
        client = self.two_rounds("Let me check the 1y price first.", [text("Pikachu ex is $120.00.")])
        self.assertEqual(self.run_turn(client, "How much is Pikachu ex?").text, "Pikachu ex is $120.00.")

    def test_empty_final_uses_the_earlier_answer(self) -> None:
        client = self.two_rounds("Pikachu ex is $120.00 right now.", [])
        turn = self.run_turn(client, "How much is Pikachu ex?")
        self.assertEqual((turn.status, turn.text), ("ok", "Pikachu ex is $120.00 right now."))
        self.assertEqual(len(client.messages.calls), 2)

    def test_empty_final_without_earlier_text_gets_one_tools_off_retry(self) -> None:
        answer = "You need 3 cards, led by Pikachu ex; about $45.00 in total."  # names its tile
        client = self.two_rounds(None, [], message([text(answer)]))
        turn = self.run_turn(client, "How much would it cost to finish my set?")
        self.assertEqual((turn.status, turn.text), ("ok", answer))
        retry = client.messages.calls[-1]
        self.assertEqual(retry["tool_choice"], {"type": "none"})
        self.assertEqual(retry["messages"][-1]["content"][-1], {"type": "text", "text": ANSWER_NOW_NOTE})
        self.assertEqual(retry["messages"][-1]["content"][0]["type"], "tool_result")
        self.assertEqual(turn.rounds, 3)

    def test_empty_retry_is_the_generic_error(self) -> None:
        client = self.two_rounds(None, [], message([]))
        turn = self.run_turn(client, "How much would it cost to finish my set?")
        self.assertEqual((turn.status, turn.text), ("error", EMPTY_TEXT))
        self.assertEqual(len(client.messages.calls), 3)

    def test_length_guard_applies_to_the_combined_text(self) -> None:
        earlier = " ".join(f"Card {i} gained ${i}.00 over the month at shows." for i in range(1, 8))
        final = " ".join(f"Card {i} history climbed from ${i}0.00 in August." for i in range(1, 8))
        client = self.two_rounds(earlier, [text(final)], RuntimeError("no rewrite"))
        turn = self.run_turn(client, "What were my biggest gainers?")
        self.assertEqual(turn.length_guard, "trim")
        self.assertLessEqual(length_guard.word_count(turn.text), turn.word_limit)
        self.assertTrue(turn.text.startswith("Card 1 gained $1.00"))


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class ArgumentCorrectionEngineTests(Round7EngineCase):
    def test_past_year_question_runs_a_1y_history(self) -> None:
        client = FakeClient([
            message([tool_use("get_price_history", {"card_id": "ssp-1"}, "h1")], "tool_use"),
            message([text("Pikachu ex is flat.")]),
        ])
        turn = self.run_turn(client, "How has Pikachu ex moved over the past year?")
        self.assertIn("range=1y", turn.tool_calls[0])

    def test_watch_proposal_carries_the_stated_target(self) -> None:
        client = FakeClient([
            message([tool_use("propose_watch_card", {"card_id": "ssp-1"}, "w1")], "tool_use"),
            message([text("Pikachu ex is ready to confirm with a $400 alert.")]),
        ])
        turn = self.run_turn(client, "Watch Pikachu ex and alert me if it drops under $400")
        self.assertEqual(turn.actions[0]["params"]["target_price_usd"], 400.0)
        self.assertIn("$400.00", turn.actions[0]["summary"])


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class NamedTilesTests(unittest.TestCase):
    RAW = ref("lorcana~FBL-242", "Mickey Mouse", "242/204", "Fabled")
    BUZZ = ref("lorcana~WILD-241", "Buzz Lightyear", "241/204", "Wilds Unknown")
    CGC = ref("lorcana~C1-5", "Mickey Mouse", "5/C1", "Challenge Promos", grader="CGC", grade="9.5")
    ELSA = ref("lorcana~C1-7", "Elsa's Ice Palace", "7/C1", "Challenge Promos", grader="PSA", grade="10")

    @staticmethod
    def keys(tiles: list[dict[str, Any]]) -> list[tuple[str, Any]]:
        return [(tile["card_id"], tile.get("grade")) for tile in tiles]

    def tiles(self, selection, text_value, question, tools):
        refs = [self.RAW, self.BUZZ, self.CGC, self.ELSA]
        tiles, charts = choose_tiles(selection, refs, text_value, [], question=question)
        tiles, _, _ = apply_question_rules(tiles, charts, None, question=question, text=text_value, pool=refs,
                                           holding_refs=[], language_pairs={}, tools_used=tools)
        return tiles

    def test_graded_leader_named_by_set_is_a_tile(self) -> None:
        answer = ("The most expensive raw Lorcana card is the Fabled Mickey Mouse (242/204) at $4,166.67, followed by "
                  "Wilds Unknown Buzz Lightyear (241/204). For graded, the top is a CGC 9.5 Cold Foil Mickey Mouse "
                  "from Challenge Promos at $38,000, then a PSA 10 Elsa's Ice Palace (C1 #7) at $35,000.")
        tiles = self.tiles([self.RAW, self.BUZZ, self.ELSA], answer, "What are the most expensive Lorcana cards?",
                           {"search_cards", "find_top_graded"})
        self.assertIn(("lorcana~C1-5", "9.5"), self.keys(tiles))
        self.assertEqual(len(tiles), 4)

    def test_graded_leader_named_by_slab_only_is_a_tile(self) -> None:
        answer = "Raw, it's Mickey Mouse (242/204) at $4,166.67; graded, a CGC 9.5 Mickey Mouse at $38,000."
        tiles = self.tiles([self.RAW], answer, "What are the most expensive Lorcana cards?",
                           {"search_cards", "find_top_graded"})
        self.assertEqual(self.keys(tiles), [("lorcana~FBL-242", None), ("lorcana~C1-5", "9.5")])

    def test_singular_re_ask_keeps_named_runners_up(self) -> None:
        rocks = ref("op~1", "Rocks.D.Xebec", "OP17-118")
        nami = ref("op~2", "Nami", "EB05-055")
        robin = ref("op~3", "Nico Robin", "OP18-031")
        other = ref("op~4", "Luffy", "OP01-001")
        answer = "Rocks.D.Xebec is the top single at $6,100, ahead of Nami (EB05-055) and Nico Robin (OP18-031)."
        question = "What's the most expensive One Piece card?"
        refs = [rocks, nami, robin, other]
        tiles, charts = choose_tiles([rocks], refs, answer, [], question=question)
        tiles, _, _ = apply_question_rules(tiles, charts, None, question=question, text=answer, pool=refs,
                                           holding_refs=[], language_pairs={}, tools_used={"search_cards"})
        self.assertEqual([tile["card_id"] for tile in tiles], ["op~1", "op~2", "op~3"])


if __name__ == "__main__":
    unittest.main()
