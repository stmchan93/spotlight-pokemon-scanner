"""Per-turn card attachments: a chat photo the scanner identified rides any turn
as context.attached_card_ids, separate from the scan tray's card_ids."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, message, text  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant import shared_answers
    from mcp_server.assistant.engine import ATTACHED_CARDS_HEADER, attached_cards_context


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class AttachedCardsTests(AssistantCase):
    def last_context(self) -> str:
        return self.client.messages.calls[-1]["messages"][-1]["content"][0]["text"]

    def test_follow_up_turn_carries_attached_cards(self) -> None:
        self.client.queue(message([text("Hi.")]), message([text("The card in your photo is $120.00.")]))
        first = self.ask("hello", context={"source": "home"}).json()
        response = self.ask(
            "Is this worth grading?", thread_id=first["thread_id"],
            context={"source": "home", "attached_card_ids": ["ssp-1"]},
        )
        self.assertEqual(response.status_code, 200)
        context = self.last_context()
        self.assertIn(ATTACHED_CARDS_HEADER, context)
        self.assertIn("Pikachu ex · Surging Sparks · #238 · $120.00 (card_id: ssp-1)", context)
        self.assertNotIn("The user's scan tray contains:", context)

    def test_tray_and_attachment_stay_separate(self) -> None:
        self.client.queue(message([text("ok")]))
        response = self.ask(
            "Compare these", context={"source": "scanner", "card_ids": ["ssp-2"], "attached_card_ids": ["ssp-1"]},
        )
        self.assertEqual(response.status_code, 200)
        context = self.last_context()
        tray, _, attached = context.partition(ATTACHED_CARDS_HEADER)
        self.assertIn("The user's scan tray contains:", tray)
        self.assertIn("ssp-2", tray)
        self.assertIn("ssp-1", attached)
        self.assertNotIn("ssp-2", attached)

    def test_old_clients_without_attachments_unchanged(self) -> None:
        self.client.queue(message([text("ok")]))
        response = self.ask("Which is worth the most?", context={"source": "scanner", "card_ids": ["ssp-1"]})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(ATTACHED_CARDS_HEADER, self.last_context())

    def test_unknown_attached_ids_add_no_note(self) -> None:
        self.client.queue(message([text("ok")]))
        response = self.ask("What is this?", context={"source": "home", "attached_card_ids": ["nope"]})
        self.assertEqual(response.status_code, 200)
        content = self.client.messages.calls[-1]["messages"][-1]["content"]
        self.assertFalse(any(ATTACHED_CARDS_HEADER in block["text"] for block in content))

    def test_rejects_bad_attached_ids(self) -> None:
        bad = self.ask("x", context={"source": "home", "attached_card_ids": "ssp-1"})
        self.assertEqual(bad.status_code, 400)
        too_many = self.ask("x", context={"source": "home", "attached_card_ids": [f"c{i}" for i in range(6)]})
        self.assertEqual(too_many.status_code, 400)

    def test_attachment_turn_never_uses_shared_answers(self) -> None:
        self.assertFalse(shared_answers.request_eligible(
            {"thread_id": None, "card_ids": [], "attached_card_ids": ["ssp-1"], "text": "Undervalued cards"}
        ))

    def test_attached_cards_context_helper(self) -> None:
        self.assertIsNone(attached_cards_context(None))
        self.assertIsNone(attached_cards_context("header only"))
        note = attached_cards_context("The user's scan tray contains:\n- A (card_id: a)")
        assert note is not None
        self.assertTrue(note.startswith(ATTACHED_CARDS_HEADER))
        self.assertIn("- A (card_id: a)", note)
        self.assertNotIn("scan tray", note)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
