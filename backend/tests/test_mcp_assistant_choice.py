"""Pick-a-printing replies (L023): an ambiguous add/update shows the candidate
printings as tap-to-pick tiles (`choice`) and tells the user to tap one."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, bearer, message, text, tool_use  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.choice import (
        TAP_HINT,
        pick_printing_choice,
        stated_condition,
        stated_quantity,
        with_tap_hint,
        write_intent,
    )


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class ChoiceRuleTests(unittest.TestCase):
    CARDS = [{"card_id": "a"}, {"card_id": "b"}]

    def test_write_intent(self) -> None:
        self.assertEqual(write_intent("add Charizard ex to my collection"), "add")
        self.assertEqual(write_intent("Can you add a Pikachu?"), "add")
        self.assertEqual(write_intent("change my Charizard ex to 2 copies"), "update")
        for question in ("how do I add cards to my collection?", "add Charizard ex to my watchlist",
                         "add all the cards in my tray", "what is Charizard ex worth?", "add these to my binder"):
            self.assertIsNone(write_intent(question), question)

    def test_stated_details(self) -> None:
        self.assertEqual(stated_quantity("add 2 Charizard ex"), 2)
        self.assertEqual(stated_quantity("add three copies of Charizard"), 3)
        self.assertEqual(stated_quantity("add Charizard ex x4"), 4)
        self.assertIsNone(stated_quantity("add Charizard ex"))
        self.assertIsNone(stated_quantity("add 151 Charizard ex"))
        self.assertIsNone(stated_quantity("add 228/197 Charizard"))
        self.assertEqual(stated_condition("add a lightly played Charizard"), "LP")
        self.assertEqual(stated_condition("add a near mint Charizard"), "NM")
        self.assertIsNone(stated_condition("add Charizard ex"))

    def test_choice_needs_write_intent_two_turn_candidates_and_no_action(self) -> None:
        q = "add Charizard ex to my collection"
        choice = pick_printing_choice(q, cards=self.CARDS, actions=[], turn_card_ids={"a", "b"})
        self.assertEqual(choice, {"kind": "pick_printing", "intent": "add", "quantity": 1, "condition": "NM",
                                  "grader": None, "grade": None, "quantity_stated": False,
                                  "condition_stated": False})
        self.assertIsNone(pick_printing_choice(q, cards=self.CARDS, actions=[{"id": "x"}], turn_card_ids={"a", "b"}))
        self.assertIsNone(pick_printing_choice(q, cards=self.CARDS[:1], actions=[], turn_card_ids={"a", "b"}))
        # Earlier tiles / scanned cards aren't this turn's candidates.
        self.assertIsNone(pick_printing_choice(q, cards=self.CARDS, actions=[], turn_card_ids={"a"}))
        self.assertIsNone(pick_printing_choice("price of Charizard ex", cards=self.CARDS, actions=[],
                                               turn_card_ids={"a", "b"}))

    def test_stated_quantity_condition_and_slab_carry_through(self) -> None:
        choice = pick_printing_choice("add 2 lightly played Charizard ex", cards=self.CARDS, actions=[],
                                      turn_card_ids={"a", "b"})
        self.assertEqual((choice["quantity"], choice["condition"], choice["quantity_stated"],
                          choice["condition_stated"]), (2, "LP", True, True))
        slab = pick_printing_choice("add my PSA 10 Charizard ex", cards=self.CARDS, actions=[],
                                    turn_card_ids={"a", "b"})
        self.assertEqual((slab["condition"], slab["grader"], slab["grade"]), (None, "PSA", "10"))
        update = pick_printing_choice("update my Charizard ex to 3 copies", cards=self.CARDS, actions=[],
                                      turn_card_ids={"a", "b"})
        self.assertEqual((update["intent"], update["quantity"], update["condition"]), ("update", 3, None))

    def test_tap_hint_appended_once(self) -> None:
        self.assertEqual(with_tap_hint("I found 2 printings."), f"I found 2 printings.\n\n{TAP_HINT}")
        self.assertEqual(with_tap_hint(f"Two printings. {TAP_HINT}"), f"Two printings. {TAP_HINT}")
        self.assertEqual(with_tap_hint(""), TAP_HINT)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class ChoiceReplyTests(AssistantCase):
    def setUp(self) -> None:
        super().setUp()
        self.card("obf-228", "Charizard ex", number="228", set_name="Obsidian Flames")
        self.card("mew-199", "Charizard ex", number="199", set_name="151")
        self.conn.commit()

    def search_round(self):
        return message([tool_use("search_cards", {"filter": {"text": "Charizard ex"}, "limit": 10})], "tool_use")

    def test_ambiguous_add_marks_tiles_as_choices_and_persists(self) -> None:
        self.client.queue(
            self.search_round(),
            message([text("Which Charizard ex do you mean: Obsidian Flames 228, 151 199 or Surging Sparks 2?")]),
        )
        response = self.ask("Add Charizard ex to my collection", cmid="cm-pick")
        self.assertEqual(response.status_code, 200, response.text)
        reply = response.json()["message"]
        self.assertEqual(reply["actions"], [])
        self.assertGreaterEqual(len(reply["cards"]), 2)
        self.assertEqual(reply["choice"]["kind"], "pick_printing")
        self.assertEqual((reply["choice"]["intent"], reply["choice"]["quantity"], reply["choice"]["condition"]),
                         ("add", 1, "NM"))
        self.assertTrue(reply["text"].endswith(TAP_HINT))
        stored = self.http.get(f"/api/v1/assistant/threads/{reply['thread_id']}/messages",
                               headers=bearer(USER_A)).json()["messages"]
        self.assertEqual(stored[-1]["choice"], reply["choice"])
        self.assertIsNone(stored[0]["choice"])

    def test_proposal_reply_is_not_a_choice(self) -> None:
        self.client.queue(
            message([tool_use("propose_add_to_collection", {"card_id": "obf-228"})], "tool_use"),
            message([text("Ready to add Charizard ex (Obsidian Flames 228). Tap Confirm.")]),
        )
        reply = self.ask("Add Charizard ex Obsidian Flames 228 to my collection").json()["message"]
        self.assertEqual(len(reply["actions"]), 1)
        self.assertIsNone(reply["choice"])
        self.assertNotIn(TAP_HINT, reply["text"])

    def test_price_question_is_not_a_choice(self) -> None:
        self.client.queue(self.search_round(), message([text("Which Charizard ex do you mean?")]))
        reply = self.ask("How much is Charizard ex?").json()["message"]
        self.assertIsNone(reply["choice"])


if __name__ == "__main__":
    unittest.main()
