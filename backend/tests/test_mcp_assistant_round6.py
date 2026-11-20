"""Eval round 6: the printing the user owns resolves an ambiguous card name, a
sentence cap for narrowing follow-ups and refusals, and the investing disclaimer."""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS, USER_A, USER_B, AssistantCase, FakeClient, message, text, tool_use  # noqa: E402

from mcp_server.assistant import length_guard  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.direct_add import TurnWrites
    from mcp_server.assistant.engine import AssistantEngine
    from mcp_server.assistant.tools import AssistantToolbox


class SentenceSplitTests(unittest.TestCase):
    def test_abbreviations_and_prices_do_not_split(self) -> None:
        line = "Base Set Charizard No. 4 is $1,001.05 at St. Louis shows, e.g. the #4/102 copy. Neo is $3,998.99."
        self.assertEqual(length_guard.sentence_count(line), 2)
        self.assertEqual(length_guard.sentence_count("One. Two!\n\nThree? Four"), 4)

    def test_narrowing_and_refusal_kinds_have_sentence_caps(self) -> None:
        cap = length_guard.sentence_limit_for
        self.assertEqual(cap("Show only single cards, not sealed", ["search_cards"]), 2)
        self.assertEqual(cap("just the English ones", ["search_cards"]), 2)
        self.assertEqual(cap("Write me a poem", []), 2)
        self.assertIsNone(cap("How much is Pikachu ex 238?", ["search_cards"]))
        self.assertIsNone(cap("What's the most expensive One Piece card?", ["search_cards"]))

    def test_trim_honours_the_sentence_cap(self) -> None:
        out = length_guard.trim_to_limit("Here are singles. No. 4 costs $1,001.05. Sorry about that. More.", 80, 2)
        self.assertEqual(out, "Here are singles. No. 4 costs $1,001.05.")

    def test_disclaimer_detection(self) -> None:
        used = ["get_market_trends"]
        self.assertTrue(length_guard.needs_disclaimer("Charizard is up 20%.", used))
        for done in ("It's not a prediction.", "This isn't a prediction.", "No guarantee it keeps rising.",
                     "I can't predict prices."):
            self.assertFalse(length_guard.needs_disclaimer(done, used), done)
        self.assertFalse(length_guard.needs_disclaimer("Charizard is up 20%.", ["search_cards"]))


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class Round6EngineCase(AssistantCase):
    def run_turn(self, client: Any, question: str, owner: str = USER_A) -> Any:
        engine = AssistantEngine(self.config, AssistantToolbox(self.tools), client)
        return asyncio.run(engine.run_turn(owner_user_id=owner, history=[], question=question))


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class OwnedPrintingTests(Round6EngineCase):
    def _seed(self) -> None:
        super()._seed()
        self.card("bw5-104", "Kyogre-EX", number="104/108", set_name="Dark Explorers")
        self.card("bw5-105", "Kyogre-EX", number="105/108", set_name="Dark Explorers FA")
        self.card("xy1-54", "Kyogre-EX", number="54/160", set_name="Primal Clash")
        for card_id in ("bw5-104", "bw5-105", "xy1-54"):
            self.price(card_id, 20.0)
        self.holding("a-kyogre", USER_A, "bw5-104")
        self.holding("b-kyogre-1", USER_B, "bw5-104")
        self.holding("b-kyogre-2", USER_B, "xy1-54")
        self.conn.commit()

    def search(self, owner: str, question: str) -> dict[str, Any]:
        turn = TurnWrites(client_message_id=None, question=question)
        return AssistantToolbox(self.tools).run(
            "search_cards", {"filter": {"text": "Kyogre-EX"}}, owner_user_id=owner, turn=turn
        ).content

    def test_the_one_owned_printing_resolves(self) -> None:
        for question in ("Show Kyogre-EX's price history", "How much is Kyogre-EX?"):
            content = self.search(USER_A, question)
            self.assertEqual(content.get("resolved_owned_card_id"), "bw5-104", question)
            self.assertNotIn("ambiguous", content)

    def test_owning_several_or_none_still_asks(self) -> None:
        self.assertTrue(self.search(USER_B, "How much is Kyogre-EX?").get("ambiguous"))  # owns two
        content = self.search("user-c", "How much is Kyogre-EX?")
        self.assertTrue(content.get("ambiguous"))
        self.assertNotIn("resolved_owned_card_id", content)

    def test_rankings_are_not_resolved_by_ownership(self) -> None:
        self.assertNotIn("resolved_owned_card_id", self.search(USER_A, "What's the most expensive Kyogre-EX?"))

    def test_engine_does_not_append_a_choice_question(self) -> None:
        client = FakeClient([
            message([tool_use("search_cards", {"filter": {"text": "Kyogre-EX"}}, "s1")], "tool_use"),
            message([text("Kyogre-EX (Dark Explorers #104/108) is $20.00.")]),
        ])
        turn = self.run_turn(client, "How much is Kyogre-EX?")
        self.assertEqual(turn.text, "Kyogre-EX (Dark Explorers #104/108) is $20.00.")
        payload = json.loads(client.messages.calls[1]["messages"][-1]["content"][0]["content"])
        self.assertEqual(payload["resolved_owned_card_id"], "bw5-104")


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class SentenceCapEngineTests(Round6EngineCase):
    THREE = "Here are only the single cards. Pikachu ex is $120.00. Charizard ex is $8.00 right now."

    def script(self, answer: str, *extra: Any) -> FakeClient:
        return FakeClient([
            message([tool_use("search_cards", {"filter": {"product": "single"}}, "s1")], "tool_use"),
            message([text(answer)]),
            *extra,
        ])

    def test_rewrite_to_two_sentences(self) -> None:
        rewrite = "Only single cards: Pikachu ex is $120.00. Charizard ex is $8.00."
        client = self.script(self.THREE, message([text(rewrite)]))
        turn = self.run_turn(client, "Show only single cards, not sealed")
        self.assertEqual((turn.text, turn.length_guard, turn.sentence_limit), (rewrite, "rewrite", 2))
        self.assertIn("2 sentences", client.messages.calls[-1]["system"])

    def test_three_sentence_rewrite_falls_back_to_trim(self) -> None:
        client = self.script(self.THREE, message([text("Sure thing. Pikachu ex is $120.00. Charizard ex is $8.00.")]))
        turn = self.run_turn(client, "Show only single cards, not sealed")
        self.assertEqual(turn.length_guard, "trim")
        self.assertEqual(length_guard.sentence_count(turn.text), 2)

    def test_two_sentences_make_no_extra_call(self) -> None:
        client = self.script("Pikachu ex is $120.00. Charizard ex is $8.00.")
        turn = self.run_turn(client, "Show only single cards, not sealed")
        self.assertEqual(len(client.messages.calls), 2)
        self.assertIsNone(turn.length_guard)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class DisclaimerEngineTests(Round6EngineCase):
    def script(self, answer: str, *extra: Any) -> FakeClient:
        return FakeClient([
            message([tool_use("get_market_trends", {}, "t1")], "tool_use"),
            message([text(answer)]),
            *extra,
        ])

    def test_missing_disclaimer_is_appended(self) -> None:
        turn = self.run_turn(self.script("Pikachu ex has been climbing."), "What's likely to go up?")
        self.assertTrue(turn.text.endswith(length_guard.DISCLAIMER_TEXT))

    def test_existing_disclaimer_is_kept_once(self) -> None:
        answer = "Pikachu ex has been climbing. That isn't a prediction."
        turn = self.run_turn(self.script(answer), "What's likely to go up?")
        self.assertEqual(turn.text, answer)

    def test_disclaimer_survives_the_word_guard(self) -> None:
        long = " ".join(f"Card {i} has been climbing for weeks at shows." for i in range(20))
        turn = self.run_turn(self.script(long, RuntimeError("boom")), "What's likely to go up?")
        self.assertTrue(turn.text.endswith(length_guard.DISCLAIMER_TEXT))
        self.assertLessEqual(length_guard.word_count(turn.text), turn.word_limit)


if __name__ == "__main__":
    unittest.main()
