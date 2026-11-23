"""Scan-tray actions (2026-11-22): `context.tray_rows` + tray_propose_add /
tray_propose_swap / tray_propose_remove. Client-side actions: the server only
validates against the tray rows the app sent and builds the Confirm card."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, message, text, tool_use  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant import shared_answers, tray_actions
    from mcp_server.assistant.direct_add import TurnWrites
    from mcp_server.assistant.engine import SYSTEM_PROMPT, TOOLS_PAYLOAD
    from mcp_server.assistant.tools import AssistantToolbox

ROWS = [
    {"row_ref": "cap-1", "card_id": "ssp-2", "condition": "LP", "grader": None, "grade": None, "quantity": 1,
     "variant": "Reverse Holofoil"},
    {"row_ref": "cap-2", "card_id": "ssp-1", "condition": None, "grader": "psa", "grade": "10", "quantity": 1,
     "variant": None},
]


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class ParseTrayRowsTests(unittest.TestCase):
    def test_rows_are_cleaned(self) -> None:
        rows, error = tray_actions.parse_tray_rows([
            *ROWS,
            {"row_ref": "cap-1", "card_id": "dup"},  # same row twice: first wins
            {"row_ref": "cap-3", "card_id": "ssp-3", "condition": "mint?", "quantity": 0},
        ])
        self.assertIsNone(error)
        self.assertEqual([row["row_ref"] for row in rows], ["cap-1", "cap-2", "cap-3"])
        self.assertEqual(rows[0]["condition"], "LP")
        self.assertEqual((rows[1]["grader"], rows[1]["grade"], rows[1]["condition"]), ("PSA", "10", None))
        self.assertEqual((rows[2]["condition"], rows[2]["quantity"]), ("NM", 1))

    def test_absent_and_malformed(self) -> None:
        self.assertEqual(tray_actions.parse_tray_rows(None), ([], None))
        for raw in ("x", [1], [{"row_ref": "a"}], [{"row_ref": "a", "card_id": "b", "quantity": "2"}],
                    [{"row_ref": "a", "card_id": "b", "grader": 5}],
                    [{"row_ref": str(i), "card_id": "c"} for i in range(21)]):
            _, error = tray_actions.parse_tray_rows(raw)
            self.assertIsNotNone(error, raw)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class TrayToolTests(AssistantCase):
    def run_tool(self, name: str, arguments: dict, rows=None):
        parsed, _ = tray_actions.parse_tray_rows(ROWS if rows is None else rows)
        turn = TurnWrites(client_message_id=None, question="", tray_rows=tuple(parsed))
        return AssistantToolbox(self.tools).run(name, arguments, owner_user_id=USER_A, turn=turn)

    def test_tools_are_non_strict_and_strict_budget_holds(self) -> None:
        by_name = {tool["name"]: tool for tool in TOOLS_PAYLOAD}
        for name in tray_actions.TRAY_TOOLS:
            self.assertIn(name, by_name)
            self.assertFalse(by_name[name].get("strict"), name)
        self.assertEqual(TOOLS_PAYLOAD[-1]["name"], "show_cards")  # cache breakpoint stays last
        self.assertIn("tray_propose_add", SYSTEM_PROMPT)
        self.assertIn("tray_propose_swap", SYSTEM_PROMPT)

    def test_add_all_rows_respects_each_row(self) -> None:
        before = self.count("deck_entries")
        outcome = self.run_tool("tray_propose_add", {"rows": []})
        self.assertFalse(outcome.is_error, outcome.content)
        action = outcome.action
        self.assertEqual(action["type"], "add_tray_to_collection")
        self.assertEqual(action["state"], "proposed")
        self.assertEqual(action["params"]["rows"], [
            {"row": 1, "row_ref": "cap-1", "card_id": "ssp-2", "quantity": 1, "condition": "LP",
             "variant_name": "Reverse Holofoil", "grader": None, "grade": None},
            {"row": 2, "row_ref": "cap-2", "card_id": "ssp-1", "quantity": 1, "condition": None,
             "variant_name": None, "grader": "PSA", "grade": "10"},
        ])
        self.assertEqual(action["summary"], "Add 2 scanned cards to your collection: Charizard ex, Pikachu ex")
        self.assertEqual({card["card_id"] for card in outcome.cards}, {"ssp-1", "ssp-2"})
        self.assertEqual(self.count("deck_entries"), before)  # client-side: nothing written

    def test_add_one_row_summary(self) -> None:
        action = self.run_tool("tray_propose_add", {"rows": [1]}).action
        self.assertEqual(action["summary"], "Add Charizard ex (Surging Sparks 2) · Reverse Holofoil · LP · ×1")
        self.assertEqual([row["row_ref"] for row in action["params"]["rows"]], ["cap-1"])

    def test_swap(self) -> None:
        outcome = self.run_tool("tray_propose_swap", {"row": 1, "to_card_id": "ssp-3"})
        self.assertFalse(outcome.is_error, outcome.content)
        action = outcome.action
        self.assertEqual(action["type"], "swap_tray_card")
        params = action["params"]
        self.assertEqual(
            (params["row"], params["row_ref"], params["from_card_id"], params["to_card_id"]), (1, "cap-1", "ssp-2", "ssp-3")
        )
        self.assertEqual(params["to_card"]["name"], "Eevee")
        self.assertEqual(params["to_card"]["number"], "3")
        self.assertEqual(action["summary"], "Swap Charizard ex (Surging Sparks 2) → Eevee (Surging Sparks 3)")
        self.assertEqual([card["card_id"] for card in outcome.cards], ["ssp-3"])

    def test_remove(self) -> None:
        action = self.run_tool("tray_propose_remove", {"row": 2}).action
        self.assertEqual(action["type"], "remove_tray_card")
        self.assertEqual(action["params"], {"row": 2, "row_ref": "cap-2", "card_id": "ssp-1"})
        self.assertEqual(action["summary"], "Remove Pikachu ex (Surging Sparks 238) from your scan tray")

    def test_validation(self) -> None:
        for name, args, rows in (
            ("tray_propose_add", {}, []),                        # no tray in this chat
            ("tray_propose_add", {"rows": [3]}, None),           # no such row
            ("tray_propose_swap", {"row": 0, "to_card_id": "ssp-3"}, None),
            ("tray_propose_swap", {"row": 1, "to_card_id": "missing"}, None),
            ("tray_propose_swap", {"row": 1, "to_card_id": "ssp-2"}, None),  # already that card
            ("tray_propose_swap", {"row": "one", "to_card_id": "ssp-3"}, None),
            ("tray_propose_remove", {"row": 9}, None),
        ):
            outcome = self.run_tool(name, args, rows)
            self.assertTrue(outcome.is_error, (name, args))
            self.assertIsNone(outcome.action)
        no_tray = self.run_tool("tray_propose_remove", {"row": 1}, [])
        self.assertIn("Ekalight button on their scan tray", no_tray.content["error"])


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class TrayTurnTests(AssistantCase):
    def context_text(self) -> str:
        return "\n".join(block["text"] for block in self.client.messages.calls[0]["messages"][-1]["content"])

    def test_rows_note_replaces_tray_note_and_proposal_reaches_reply(self) -> None:
        self.client.queue(
            message([tool_use("tray_propose_swap", {"row": 1, "to_card_id": "ssp-3"})], "tool_use"),
            message([text("Swapping row 1 to Eevee is ready to confirm.")]),
        )
        response = self.ask("Swap the Charizard for Eevee", context={
            "source": "scanner", "card_ids": ["ssp-2", "ssp-1"], "tray_rows": ROWS,
            "page": {"kind": "scanner", "label": "Scanner", "params": {}},
        })
        self.assertEqual(response.status_code, 200, response.text)
        note = self.context_text()
        self.assertIn("The user's scan tray contains (row numbers are for tray actions):", note)
        self.assertIn(
            "- Row 1: Charizard ex · Surging Sparks · #2 · $8.00 · Reverse Holofoil · LP (card_id: ssp-2)", note
        )
        self.assertIn("- Row 2: Pikachu ex · Surging Sparks · #238 · $120.00 · PSA 10 (card_id: ssp-1)", note)
        self.assertNotIn("The user's scan tray contains:\n", note)  # the old unnumbered note is replaced
        actions = response.json()["message"]["actions"]
        self.assertEqual([action["type"] for action in actions], ["swap_tray_card"])
        self.assertEqual(actions[0]["params"]["row_ref"], "cap-1")

    def test_follow_up_turn_keeps_rows_in_reach(self) -> None:
        self.client.queue(message([text("Sure.")]))
        response = self.ask("Remove the Pikachu", context={"source": "scanner", "tray_rows": ROWS})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("still open behind this chat", self.context_text())

    def test_bad_rows_are_400_and_never_shared(self) -> None:
        response = self.ask("Hi", context={"source": "scanner", "tray_rows": "rows"})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(shared_answers.request_eligible({"thread_id": None, "text": "Undervalued cards",
                                                          "tray_rows": [{"row_ref": "a"}]}))


if __name__ == "__main__":
    unittest.main()
