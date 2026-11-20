"""Direct add (owner review 2026-11-20, decision 2): a fully specified add is
written server-side once (idempotent per client_message_id), shows one tile
with the new quantity, and can be undone; anything ambiguous stays a proposal."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import (  # noqa: E402
    HAVE_DEPS,
    USER_A,
    USER_B,
    AssistantCase,
    bearer,
    message,
    text,
    tool_use,
)

if HAVE_DEPS:
    from mcp_server.assistant.direct_add import condition_stated, grade_stated


def add_now(card_id: str = "ssp-3", *, quantity: int = 2, condition: str | None = "NM", variant_name=None,
            grader=None, grade=None, block_id: str = "tu_1"):
    return tool_use(
        "add_to_collection_now",
        {"card_id": card_id, "quantity": quantity, "condition": condition, "variant_name": variant_name,
         "grader": grader, "grade": grade},
        block_id,
    )


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class DirectAddTests(AssistantCase):
    ASK = "Add 2 near mint Eevee SSP #3 to my collection"

    def owned(self, owner: str = USER_A, card_id: str = "ssp-3") -> int:
        row = self.conn.execute(
            "SELECT COALESCE(SUM(quantity), 0) FROM deck_entries WHERE owner_user_id = ? AND card_id = ?",
            (owner, card_id),
        ).fetchone()
        return int(row[0])

    def direct(self, ask: str = ASK, *, cmid: str = "cm-add-1", **kwargs: Any) -> dict[str, Any]:
        self.client.queue(message([add_now(**kwargs)], "tool_use"), message([text("Added 2 Near Mint Eevee.")]))
        response = self.ask(ask, cmid=cmid)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["message"]

    def ask(self, text_value: str = "", *, user: str = USER_A, cmid: str | None = None, capable: bool = True, **kw):
        body = {"thread_id": None, "client_message_id": cmid or "cm-x", "text": text_value}
        if capable:
            body["capabilities"] = ["direct_add"]
        return self.http.post("/api/v1/assistant/messages", json=body, headers=bearer(user))

    def undo(self, action_id: str, user: str = USER_A):
        return self.http.post(f"/api/v1/assistant/actions/{action_id}/undo", headers=bearer(user))

    def tool_result(self, call_index: int) -> dict[str, Any]:
        blocks = self.client.messages.calls[call_index]["messages"][-1]["content"]
        return json.loads(next(block for block in blocks if block.get("type") == "tool_result")["content"])

    # --- direct add ------------------------------------------------------------

    def test_fully_specified_add_writes_once_and_shows_one_tile(self) -> None:
        reply = self.direct()
        self.assertEqual(self.owned(), 2)
        [action] = reply["actions"]
        self.assertEqual(action["state"], "done")
        self.assertEqual(action["type"], "add_to_collection")
        self.assertEqual(action["params"]["quantity"], 2)
        self.assertEqual(action["params"]["condition"], "NM")
        self.assertTrue(action["summary"].startswith("Added Eevee"))
        self.assertEqual(action["undo"]["quantity_added"], 2)
        self.assertTrue(action["undo"]["expires_at"].endswith("Z"))
        self.assertEqual([(c["card_id"], c["quantity_owned"]) for c in reply["cards"]], [("ssp-3", 2)])
        self.assertTrue(self.tool_result(1)["added"])
        row = self.conn.execute(
            "SELECT condition FROM deck_entries WHERE owner_user_id = ? AND card_id = 'ssp-3'", (USER_A,)
        ).fetchone()
        self.assertEqual(row["condition"], "near_mint")

    def test_same_client_message_id_never_adds_twice(self) -> None:
        first = self.direct()
        calls = len(self.client.messages.calls)
        again = self.ask(self.ASK, cmid="cm-add-1").json()["message"]
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(len(self.client.messages.calls), calls)
        self.assertEqual(self.owned(), 2)

    def test_replayed_turn_after_failure_does_not_add_again(self) -> None:
        # The write lands, then the model call fails: the turn isn't saved.
        self.client.queue(message([add_now()], "tool_use"), RuntimeError("network"))
        self.assertEqual(self.ask(self.ASK, cmid="cm-retry").status_code, 502)
        self.assertEqual(self.owned(), 2)
        reply = self.direct(cmid="cm-retry")
        self.assertEqual(self.owned(), 2)
        self.assertEqual(reply["actions"][0]["state"], "done")
        self.assertEqual(reply["actions"][0]["undo"]["quantity_added"], 2)

    def test_new_message_is_a_new_add(self) -> None:
        self.direct(cmid="cm-1")
        self.direct(cmid="cm-2")
        self.assertEqual(self.owned(), 4)

    def test_refusal_after_the_write_still_reports_it(self) -> None:
        self.client.queue(message([add_now()], "tool_use"), message([], "refusal"))
        reply = self.ask(self.ASK, cmid="cm-ref").json()["message"]
        self.assertEqual(reply["status"], "ok")
        self.assertEqual(reply["actions"][0]["state"], "done")
        self.assertIn("Added Eevee", reply["text"])
        self.assertEqual(self.owned(), 2)

    def test_slab_with_stated_grade_is_added(self) -> None:
        self.direct("Add a PSA 10 Eevee SSP #3", quantity=1, condition=None, grader="PSA", grade="10")
        row = self.conn.execute(
            "SELECT grader, grade, quantity FROM deck_entries WHERE owner_user_id = ? AND card_id = 'ssp-3'", (USER_A,)
        ).fetchone()
        self.assertEqual((row["grader"], row["grade"], row["quantity"]), ("PSA", "10", 1))

    # --- fallbacks to the proposal flow ----------------------------------------

    def assert_proposed(self, reply: dict[str, Any], reason_part: str) -> None:
        self.assertEqual(self.owned(), 0)
        self.assertTrue(reply["actions"])
        self.assertTrue(all(action["state"] == "proposed" for action in reply["actions"]))
        result = self.tool_result(1)
        self.assertFalse(result["added"])
        self.assertIn(reason_part, result["reason"])

    def test_inferred_condition_stays_a_proposal(self) -> None:
        self.assert_proposed(self.direct("Add 2 Eevee SSP #3 to my collection"), "condition")

    def test_condition_that_differs_from_the_users_stays_a_proposal(self) -> None:
        self.assert_proposed(self.direct("Add 2 lightly played Eevee SSP #3", condition="NM"), "condition")

    def test_missing_condition_stays_a_proposal(self) -> None:
        self.assert_proposed(self.direct(condition=None), "condition not given")

    def test_unstated_grade_stays_a_proposal(self) -> None:
        self.assert_proposed(
            self.direct("Add a graded Eevee SSP #3", quantity=1, condition=None, grader="PSA", grade="10"), "grade"
        )

    def test_several_printings_without_one_named_stays_a_proposal(self) -> None:
        with mock.patch.object(
            type(self.service), "_raw_history_variants", return_value=["Normal", "Reverse Holofoil"]
        ):
            self.assert_proposed(self.direct(), "printings")

    def test_named_printing_is_matched_and_stored(self) -> None:
        with mock.patch.object(
            type(self.service), "_raw_history_variants", return_value=["Normal", "Reverse Holofoil"]
        ):
            reply = self.direct(variant_name="reverse holofoil")
        self.assertEqual(reply["actions"][0]["state"], "done")
        self.assertEqual(reply["actions"][0]["params"]["variant_name"], "Reverse Holofoil")
        row = self.conn.execute(
            "SELECT variant_name FROM deck_entries WHERE owner_user_id = ? AND card_id = 'ssp-3'", (USER_A,)
        ).fetchone()
        self.assertEqual(row["variant_name"], "Reverse Holofoil")

    def test_batch_add_stays_proposals(self) -> None:
        self.client.queue(
            message([add_now("ssp-3", block_id="tu_1"), add_now("ssp-1", block_id="tu_2")], "tool_use"),
            message([text("Ready to confirm.")]),
        )
        reply = self.ask("Add the cards in my tray as near mint, 2 each", cmid="cm-batch").json()["message"]
        self.assertEqual([a["state"] for a in reply["actions"]], ["proposed", "proposed"])
        self.assertEqual(self.owned(card_id="ssp-3"), 0)
        self.assertEqual(self.owned(card_id="ssp-1"), 1)  # the seeded holding only

    def test_second_add_in_the_same_turn_is_a_proposal(self) -> None:
        self.client.queue(
            message([add_now("ssp-3")], "tool_use"),
            message([add_now("ssp-1", block_id="tu_2")], "tool_use"),
            message([text("Done.")]),
        )
        reply = self.ask(self.ASK, cmid="cm-two").json()["message"]
        self.assertEqual([a["state"] for a in reply["actions"]], ["done", "proposed"])
        self.assertEqual(self.owned(card_id="ssp-1"), 1)

    def test_app_without_the_capability_only_gets_proposals(self) -> None:
        self.client.queue(message([add_now()], "tool_use"), message([text("Ready to confirm.")]))
        reply = self.ask(self.ASK, cmid="cm-old", capable=False).json()["message"]
        self.assertEqual(reply["actions"][0]["state"], "proposed")
        self.assertEqual(self.owned(), 0)

    def test_toolbox_without_turn_context_proposes(self) -> None:
        outcome = self.assistant.toolbox.run(
            "add_to_collection_now",
            {"card_id": "ssp-3", "quantity": 1, "condition": "NM", "variant_name": None, "grader": None, "grade": None},
            owner_user_id=USER_A,
        )
        self.assertEqual(outcome.action["state"], "proposed")
        self.assertEqual(self.owned(), 0)

    # --- undo --------------------------------------------------------------------

    def test_undo_removes_a_new_holding_and_is_idempotent(self) -> None:
        action = self.direct()["actions"][0]
        response = self.undo(action["id"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["action"]["state"], "undone")
        self.assertEqual(self.owned(), 0)
        self.assertEqual(self.count("deck_entries", "owner_user_id = ? AND card_id = 'ssp-3'", (USER_A,)), 0)
        again = self.undo(action["id"])
        self.assertEqual((again.status_code, again.json()["action"]["state"]), (200, "undone"))
        self.assertEqual(self.owned(), 0)
        thread = self.ask(self.ASK, cmid="cm-add-1").json()
        self.assertEqual(thread["message"]["actions"][0]["state"], "undone")

    def test_undo_takes_back_only_the_copies_it_added(self) -> None:
        self.direct(cmid="cm-1")
        second = self.direct("Add 1 near mint Eevee SSP #3", cmid="cm-2", quantity=1)["actions"][0]
        self.assertEqual(self.owned(), 3)
        self.assertEqual(self.undo(second["id"]).status_code, 200)
        self.assertEqual(self.owned(), 2)

    def test_undo_is_owner_scoped(self) -> None:
        action = self.direct()["actions"][0]
        self.assertEqual(self.undo(action["id"], user=USER_B).status_code, 404)
        self.assertEqual(self.owned(), 2)

    def test_undo_window_expires(self) -> None:
        action = self.direct()["actions"][0]
        row = self.conn.execute("SELECT id, actions_json FROM assistant_messages WHERE actions_json LIKE ?",
                                (f'%{action["id"]}%',)).fetchone()
        actions = json.loads(row["actions_json"])
        actions[0]["undo"]["expires_at"] = "2020-01-01T00:00:00Z"
        self.conn.execute("UPDATE assistant_messages SET actions_json = ? WHERE id = ?", (json.dumps(actions), row["id"]))
        self.conn.commit()
        response = self.undo(action["id"])
        self.assertEqual((response.status_code, response.json()["error"]), (409, "undo_expired"))
        self.assertEqual(self.owned(), 2)

    def test_undo_after_the_holding_is_gone(self) -> None:
        action = self.direct()["actions"][0]
        self.conn.execute("DELETE FROM deck_entries WHERE owner_user_id = ? AND card_id = 'ssp-3'", (USER_A,))
        self.conn.commit()
        response = self.undo(action["id"])
        self.assertEqual((response.status_code, response.json()["error"]), (409, "cannot_undo"))
        self.assertEqual(self.undo(action["id"]).status_code, 409)  # state stayed "done"

    def test_proposals_cannot_be_undone_and_done_cannot_be_confirmed(self) -> None:
        proposed = self.direct("Add 2 Eevee SSP #3")["actions"][0]
        self.assertEqual(self.undo(proposed["id"]).json()["error"], "not_undoable")
        done = self.direct(cmid="cm-done")["actions"][0]
        url = f"/api/v1/assistant/actions/{done['id']}"
        self.assertEqual(self.http.post(url, json={"state": "confirmed"}, headers=bearer(USER_A)).status_code, 409)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class StatedDetailsTests(unittest.TestCase):
    def test_condition_words(self) -> None:
        self.assertTrue(condition_stated("Add two Near Mint Charizard ex", "NM"))
        self.assertTrue(condition_stated("add 2 NM charizard", "NM"))
        self.assertTrue(condition_stated("add a lightly-played one", "LP"))
        self.assertFalse(condition_stated("add 2 charizard ex", "NM"))
        self.assertFalse(condition_stated("add 2 lightly played charizard", "NM"))

    def test_grade_words(self) -> None:
        self.assertTrue(grade_stated("Add my PSA 10 Charizard #199/165", "PSA", "10"))
        self.assertTrue(grade_stated("add a cgc 9.5 umbreon", "CGC", "9.5"))
        self.assertFalse(grade_stated("add a PSA 9 #10", "PSA", "9.5"))
        self.assertFalse(grade_stated("add charizard #199/165", "PSA", "10"))


if __name__ == "__main__":
    unittest.main()
