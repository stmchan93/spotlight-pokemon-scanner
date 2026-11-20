"""👍/👎 feedback on assistant answers: endpoint validation, owner scoping,
clear, history payload, PostHog event, account deletion, and the export tool."""

from __future__ import annotations

import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
for path in (BACKEND_ROOT, BACKEND_ROOT / "tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

try:
    from backend.tests.test_mcp_assistant import (  # noqa: E402
        HAVE_DEPS,
        USER_A,
        USER_B,
        AssistantCase,
        bearer,
        message,
        text,
        tool_use,
    )
except ImportError:  # direct invocation from backend/tests
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
    from mcp_server.assistant.analytics import EVENT_FEEDBACK, TurnAnalytics  # noqa: E402

    import assistant_feedback_export  # noqa: E402


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class FeedbackTests(AssistantCase):
    def turn(self, user: str = USER_A, question: str = "What is my collection worth?") -> dict:
        self.client.queue(
            message([tool_use("get_portfolio_summary", {})], "tool_use"),
            message([text("Your collection is worth $136.")]),
        )
        response = self.ask(question, user=user)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def rate(self, message_id: str, body, *, user: str = USER_A):
        return self.http.post(
            f"/api/v1/assistant/messages/{message_id}/feedback", json=body, headers=bearer(user)
        )

    def test_thumbs_down_with_reason_is_stored_and_returned(self) -> None:
        turn = self.turn()
        self.assertIsNone(turn["message"]["feedback"])
        message_id = turn["message"]["id"]
        response = self.rate(message_id, {"rating": "down", "reason": "wrong", "note": "  Too low  "})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["message_id"], message_id)
        self.assertEqual(
            {k: body["feedback"][k] for k in ("rating", "reason", "note")},
            {"rating": "down", "reason": "wrong", "note": "Too low"},
        )
        row = self.conn.execute("SELECT * FROM assistant_feedback WHERE message_id = ?", (message_id,)).fetchone()
        self.assertEqual((row["owner_user_id"], row["thread_id"]), (USER_A, turn["thread_id"]))

    def test_history_includes_feedback(self) -> None:
        turn = self.turn()
        self.rate(turn["message"]["id"], {"rating": "up"})
        messages = self.http.get(
            f"/api/v1/assistant/threads/{turn['thread_id']}/messages", headers=bearer(USER_A)
        ).json()["messages"]
        by_role = {m["role"]: m for m in messages}
        self.assertEqual(by_role["assistant"]["feedback"]["rating"], "up")
        self.assertIsNone(by_role["assistant"]["feedback"]["reason"])
        self.assertIsNone(by_role["user"]["feedback"])

    def test_change_then_clear(self) -> None:
        message_id = self.turn()["message"]["id"]
        self.rate(message_id, {"rating": "down", "reason": "too_long"})
        changed = self.rate(message_id, {"rating": "up"}).json()["feedback"]
        self.assertEqual((changed["rating"], changed["reason"]), ("up", None))
        cleared = self.rate(message_id, {"rating": None, "reason": "wrong"})
        self.assertEqual(cleared.status_code, 200)
        self.assertIsNone(cleared.json()["feedback"])
        self.assertEqual(self.count("assistant_feedback"), 0)

    def test_owner_scoping_and_unknown_message(self) -> None:
        message_id = self.turn()["message"]["id"]
        self.assertEqual(self.rate(message_id, {"rating": "down"}, user=USER_B).status_code, 404)
        self.assertEqual(self.rate("msg_missing", {"rating": "down"}).status_code, 404)
        self.assertEqual(self.count("assistant_feedback"), 0)

    def test_user_messages_take_no_feedback(self) -> None:
        turn = self.turn()
        response = self.rate(turn["user_message"]["id"], {"rating": "up"})
        self.assertEqual(response.status_code, 400)

    def test_invalid_values(self) -> None:
        message_id = self.turn()["message"]["id"]
        for body in (
            {"rating": "meh"},
            {"rating": "down", "reason": "bad_vibes"},
            {"rating": "down", "note": "x" * 501},
            {"rating": "down", "note": 5},
            {},
            ["down"],
        ):
            response = self.rate(message_id, body)
            self.assertEqual(response.status_code, 400, body)
            self.assertEqual(response.json()["error"], "invalid_request")
        self.assertEqual(self.rate(message_id, {"rating": "down", "note": "x" * 500}).status_code, 200)
        self.assertEqual(self.http.post(f"/api/v1/assistant/messages/{message_id}/feedback").status_code, 401)

    def test_posthog_event_payload(self) -> None:
        turn = self.turn(question="What is my collection worth?")
        message_id = turn["message"]["id"]
        with mock.patch.object(self.assistant.analytics, "capture") as capture:
            self.rate(message_id, {"rating": "down", "reason": "wrong_cards", "note": "n"})
            self.rate(message_id, {"rating": "down", "reason": "wrong_cards", "note": "n"})  # no change, no event
            self.rate(message_id, {"rating": None})
        self.assertEqual(capture.call_count, 2)
        distinct_id, properties, event = capture.call_args_list[0].args
        self.assertEqual((distinct_id, event), (USER_A, EVENT_FEEDBACK))
        self.assertEqual(properties["rating"], "down")
        self.assertEqual(properties["reason"], "wrong_cards")
        self.assertEqual(properties["message_id"], message_id)
        self.assertEqual(properties["thread_id"], turn["thread_id"])
        self.assertEqual(properties["tools"], ["get_portfolio_summary"])
        self.assertGreater(properties["cost_usd"], 0)
        self.assertEqual(properties["question"], "What is my collection worth?")
        self.assertEqual(properties["answer"], "Your collection is worth $136.")
        self.assertIsNone(capture.call_args_list[1].args[1]["rating"])

        analytics = TurnAnalytics(api_key="phc_test", host="https://ph.example", environment="staging")
        body = analytics.payload(USER_A, properties, EVENT_FEEDBACK)
        self.assertEqual(body["event"], "assistant_feedback")
        self.assertEqual(body["properties"]["environment"], "staging")

    def test_event_truncates_long_text(self) -> None:
        self.client.queue(message([text("word " * 200)]))
        turn = self.ask("q" * 600).json()
        with mock.patch.object(self.assistant.analytics, "capture") as capture:
            self.rate(turn["message"]["id"], {"rating": "up"})
        properties = capture.call_args.args[1]
        self.assertLessEqual(len(properties["question"]), 200)
        self.assertLessEqual(len(properties["answer"]), 400)

    def test_thread_delete_and_account_deletion_clear_feedback(self) -> None:
        first = self.turn()
        self.rate(first["message"]["id"], {"rating": "down"})
        self.http.delete(f"/api/v1/assistant/threads/{first['thread_id']}", headers=bearer(USER_A))
        self.assertEqual(self.count("assistant_feedback"), 0)

        self.rate(self.turn()["message"]["id"], {"rating": "down"})
        self.rate(self.turn(user=USER_B)["message"]["id"], {"rating": "up"}, user=USER_B)
        counts = self.service._delete_account_rows(USER_A)  # noqa: SLF001
        self.assertEqual(counts["assistant_feedback"], 1)
        self.assertEqual(self.count("assistant_feedback", "owner_user_id = ?", (USER_A,)), 0)
        self.assertEqual(self.count("assistant_feedback", "owner_user_id = ?", (USER_B,)), 1)

    def test_export_lists_feedback_and_emits_cases(self) -> None:
        down = self.turn(question="Price of my Pikachu?")
        up = self.turn(question="What is my collection worth?")
        self.rate(down["message"]["id"], {"rating": "down", "reason": "wrong", "note": "It said $5"})
        self.rate(up["message"]["id"], {"rating": "up"})

        rows = assistant_feedback_export.load_feedback(self.conn, ratings=("down",), limit=50)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["question"], "Price of my Pikachu?")
        self.assertEqual(rows[0]["tool_calls"], ["get_portfolio_summary()"])
        self.assertEqual(rows[0]["reason"], "wrong")
        both = assistant_feedback_export.load_feedback(self.conn, ratings=("down", "up"), limit=50)
        self.assertEqual([row["rating"] for row in both], ["up", "down"])  # newest first

        cases = assistant_feedback_export.as_cases(rows)
        self.assertEqual(cases[0]["turns"], [{"question": "Price of my Pikachu?"}])
        self.assertEqual(cases[0]["expectations"], {})
        self.assertIn("It said $5", cases[0]["judge_rubric"])
        self.assertTrue(cases[0]["id"].startswith("feedback_"))

        db_path = self.service.database_path
        out = io.StringIO()
        with redirect_stdout(out):
            assistant_feedback_export.main(["--database-path", str(db_path), "--as-cases", "--format", "json"])
        self.assertEqual(json.loads(out.getvalue())["cases"][0]["turns"][0]["question"], "Price of my Pikachu?")
        out = io.StringIO()
        with redirect_stdout(out):
            assistant_feedback_export.main(["--database-path", str(db_path), "--include-up"])
        self.assertEqual(len(out.getvalue().strip().splitlines()), 2)


if __name__ == "__main__":
    unittest.main()
