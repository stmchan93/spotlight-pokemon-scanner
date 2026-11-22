"""Turn deadline: a slow model call or tool ends the turn server-side with an answer the
app shows, well before the app's 60s request timeout ("couldn't reach Ekalight")."""

from __future__ import annotations

import asyncio
import sys
import time
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, message, text, tool_use  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant import engine as engine_module
    from mcp_server.assistant import service as service_module
    from mcp_server.assistant.config import AssistantConfig
    from mcp_server.assistant.engine import TIME_LIMIT_NOTE, TIMEOUT_TEXT, TOOL_TIMEOUT_ERROR
    from mcp_server.assistant.service import Caller


class SlowMessages:
    """Answers from a script; an int item sleeps that many seconds first (a stalled call)."""

    def __init__(self, script: list[Any]) -> None:
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs):
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        item = self.script.pop(0) if self.script else message([text("Done.")])
        if isinstance(item, (int, float)):
            await asyncio.sleep(item)
            item = message([text("Too late.")])
        return item


class SlowClient:
    def __init__(self, script: list[Any]) -> None:
        self.messages = SlowMessages(script)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class TurnDeadlineTests(AssistantCase):
    def setUp(self) -> None:
        super().setUp()
        # Seconds, not tens of seconds: the reserves shrink with the test deadline.
        for name, value in (("FINAL_ANSWER_RESERVE_SECONDS", 0.3), ("POLISH_MIN_SECONDS", 0.1),
                            ("TILES_GRACE_SECONDS", 0.2)):
            patcher = mock.patch.object(engine_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def use(self, client: Any, deadline: float) -> None:
        self.client = client
        self.build(turn_deadline_seconds=deadline)

    def test_a_stalled_model_call_ends_as_a_timeout_answer(self) -> None:
        self.use(SlowClient([30]), deadline=1.0)
        started = time.monotonic()
        response = self.ask("whats oshawott worth in a psa 10")
        self.assertLess(time.monotonic() - started, 5.0)
        self.assertEqual(response.status_code, 200)
        reply = response.json()["message"]
        self.assertEqual((reply["status"], reply["text"]), ("error", TIMEOUT_TEXT))
        self.assertEqual(response.json()["usage"]["used_today"], 0)  # a timeout isn't a counted question

    def test_a_slow_tool_is_dropped_and_the_model_answers_without_tools(self) -> None:
        client = SlowClient([
            message([tool_use("search_cards", {"filter": {"text": "oshawott"}})], "tool_use"),
            message([text("I couldn't check Oshawott's PSA 10 price just now.")]),
        ])
        self.use(client, deadline=2.0)
        real_run = self.assistant.toolbox.run

        def slow_run(name: str, *args: Any, **kwargs: Any):
            if name == "search_cards":
                time.sleep(3.0)
            return real_run(name, *args, **kwargs)

        async def timed() -> tuple[float, tuple[int, dict[str, Any]]]:
            # Timed inside the loop: asyncio.run's exit waits for the abandoned worker thread.
            started = time.monotonic()
            result = await self.assistant.send(
                Caller(user_id=USER_A, is_guest=False),
                {"client_message_id": "cm-slow", "text": "whats oshawott worth in a psa 10"},
            )
            return time.monotonic() - started, result

        with mock.patch.object(self.assistant.toolbox, "run", side_effect=slow_run):
            elapsed, (status, body) = asyncio.run(timed())
        self.assertLess(elapsed, 2.9)  # answered before the tool finished
        self.assertEqual(status, 200)
        reply = body["message"]
        self.assertEqual(reply["status"], "ok")
        self.assertIn("couldn't check", reply["text"])
        final_call = client.messages.calls[-1]
        self.assertEqual(final_call["tool_choice"], {"type": "none"})
        tool_turn = final_call["messages"][-1]["content"]
        self.assertTrue(tool_turn[0]["is_error"])
        self.assertIn(TOOL_TIMEOUT_ERROR, tool_turn[0]["content"])
        self.assertEqual(tool_turn[-1], {"type": "text", "text": TIME_LIMIT_NOTE})

    def test_the_service_backstop_cancels_a_stuck_turn(self) -> None:
        self.use(SlowClient([]), deadline=0.5)

        async def stuck(**kwargs: Any):
            await asyncio.sleep(30)

        started = time.monotonic()
        with mock.patch.object(service_module, "TURN_HARD_GRACE_SECONDS", 0.3), \
                mock.patch.object(self.assistant.engine, "run_turn", side_effect=stuck):
            response = self.ask("whats oshawott worth in a psa 10")
        self.assertLess(time.monotonic() - started, 5.0)
        reply = response.json()["message"]
        self.assertEqual((reply["status"], reply["text"]), ("error", TIMEOUT_TEXT))

    def test_a_second_question_behind_a_running_turn_gets_busy_not_a_hang(self) -> None:
        self.use(SlowClient([]), deadline=5.0)

        async def scenario() -> tuple[int, dict[str, Any]]:
            lock = self.assistant._lock(USER_A)
            await lock.acquire()  # a turn already running for this user
            try:
                return await self.assistant.send(
                    Caller(user_id=USER_A, is_guest=False), {"client_message_id": "cm-2", "text": "hi"}
                )
            finally:
                lock.release()

        with mock.patch.object(service_module, "USER_LOCK_WAIT_SECONDS", 0.2):
            status, body = asyncio.run(scenario())
        self.assertEqual((status, body), (503, {"error": "assistant_busy"}))


class DeadlineConfigTests(unittest.TestCase):
    @unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
    def test_env_deadline_is_clamped_under_the_app_timeout(self) -> None:
        for raw, expected in (("", 45.0), ("30", 30.0), ("120", 50.0), ("2", 15.0), ("x", 45.0)):
            with mock.patch.dict("os.environ", {"ASSISTANT_TURN_DEADLINE_SECONDS": raw}):
                self.assertEqual(AssistantConfig.from_env().turn_deadline_seconds, expected, raw)


if __name__ == "__main__":
    unittest.main()
