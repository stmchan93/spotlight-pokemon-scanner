"""Prompt caching: per-turn cache usage is summed, stored, logged and sent to
PostHog; the cached prefix (tools + system) is byte-identical across users,
questions and scanner context; breakpoints sit where intended (max 4)."""

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
sys.path.insert(0, str(BACKEND_ROOT))
if not hasattr(sys.modules.get("assistant_eval", sys), "__path__"):
    sys.modules.pop("assistant_eval", None)

from assistant_eval.report import render_report, summarize  # noqa: E402
from test_mcp_assistant import HAVE_DEPS, USER_A, USER_B, AssistantCase, text, tool_use  # noqa: E402

if HAVE_DEPS:
    from anthropic.types import Message, Usage

    from mcp_server.assistant.engine import TurnResult, add_usage, cache_hit_ratio, with_history_breakpoint

EPHEMERAL = {"type": "ephemeral"}


def reply(content: list[Any], stop_reason: str = "end_turn", *, uncached: int, read: int, write: int, out: int):
    return Message(
        id="msg_test", type="message", role="assistant", model="claude-haiku-5-5", content=content,
        stop_reason=stop_reason, stop_sequence=None,
        usage=Usage(input_tokens=uncached, output_tokens=out, cache_read_input_tokens=read,
                    cache_creation_input_tokens=write),
    )


def strip_markers(node: Any) -> Any:
    """Payload with cache_control removed: markers move between requests and aren't part of the prefix."""
    if isinstance(node, dict):
        return {key: strip_markers(value) for key, value in node.items() if key != "cache_control"}
    if isinstance(node, list):
        return [strip_markers(item) for item in node]
    if hasattr(node, "model_dump"):
        return strip_markers(node.model_dump())
    return node


def block_markers(call: dict[str, Any]) -> list[str]:
    """Where cache_control sits in one request, in render order (tools -> system -> messages)."""
    found = [f"tools[{i}]" for i, tool in enumerate(call["tools"]) if "cache_control" in tool]
    found += [f"system[{i}]" for i, block in enumerate(call["system"]) if "cache_control" in block]
    for i, msg in enumerate(call["messages"]):
        if isinstance(msg["content"], list):
            for j, block in enumerate(msg["content"]):
                if isinstance(block, dict) and "cache_control" in block:
                    found.append(f"messages[{i}][{j}]")
    return found


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class UsageAccountingTests(AssistantCase):
    def test_usage_summed_over_rounds_and_rewrite(self) -> None:
        result = TurnResult(text="", status="ok")
        add_usage(result, Usage(input_tokens=100, output_tokens=40, cache_read_input_tokens=9000,
                                cache_creation_input_tokens=300))
        add_usage(result, Usage(input_tokens=50, output_tokens=60, cache_read_input_tokens=9300,
                                cache_creation_input_tokens=0))
        add_usage(result, Usage(input_tokens=200, output_tokens=30))  # length-guard rewrite: uncached
        add_usage(result, None)
        self.assertEqual(result.input_tokens, 100 + 9000 + 300 + 50 + 9300 + 200)
        self.assertEqual((result.cache_read_tokens, result.cache_write_tokens, result.output_tokens), (18300, 300, 130))
        self.assertAlmostEqual(cache_hit_ratio(result.input_tokens, result.cache_read_tokens), 0.9657, places=4)
        self.assertEqual(cache_hit_ratio(0, 0), 0.0)

    def test_turn_usage_persisted_logged_and_sent_to_posthog(self) -> None:
        self.client.queue(
            reply([tool_use("get_card", {"card_id": "ssp-1"}, "c1")], "tool_use", uncached=120, read=9000, write=400, out=50),
            reply([text("Pikachu ex is **$120** raw.")], uncached=30, read=9400, write=300, out=70),
        )
        capture = mock.Mock()
        with mock.patch.object(self.assistant.analytics, "capture", capture), \
                self.assertLogs("ekalight.assistant", level="INFO") as logs:
            body = self.ask("What's my Pikachu ex worth?").json()
        row = self.conn.execute(
            "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM assistant_messages "
            "WHERE id = ?", (body["message"]["id"],),
        ).fetchone()
        total = 120 + 9000 + 400 + 30 + 9400 + 300
        self.assertEqual(tuple(row), (total, 120, 18400, 700))
        line = next(entry for entry in logs.output if "assistant_turn " in entry)
        self.assertIn(f"in={total} out=120 cache_read=18400 cache_write=700 cache_hit=0.96", line)
        properties = capture.call_args.args[1]
        self.assertEqual((properties["cache_read_tokens"], properties["cache_write_tokens"]), (18400, 700))
        self.assertEqual(properties["cache_hit_ratio"], round(18400 / total, 4))
        self.assertEqual(properties["input_tokens"], total)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class CachedPrefixTests(AssistantCase):
    def test_tools_and_system_prefix_byte_identical_across_requests(self) -> None:
        self.client.queue(reply([text("A.")], uncached=10, read=0, write=9000, out=5))
        first_thread = self.ask("What's my collection worth?").json()["thread_id"]
        self.client.queue(reply([text("B.")], uncached=10, read=9000, write=0, out=5))
        self.ask("Is this Charizard a good buy?", user=USER_B,
                 context={"source": "scanner", "card_ids": ["ssp-2"]})
        self.client.queue(reply([text("C.")], uncached=10, read=9000, write=0, out=5))
        self.ask("And graded?", thread_id=first_thread)
        calls = self.client.messages.calls
        prefixes = {
            json.dumps({key: call[key] for key in ("model", "tools", "system", "output_config")}, ensure_ascii=False)
            for call in calls
        }
        self.assertEqual(len(prefixes), 1)
        # Everything that varies (user, question, scanner context, history) is in messages.
        rendered = next(iter(prefixes))
        for volatile in ("Is this Charizard a good buy?", "And graded?", USER_A, USER_B, "ssp-2"):
            self.assertNotIn(volatile, rendered)
        self.assertNotEqual(calls[0]["messages"], calls[1]["messages"])

    def test_breakpoints_first_turn(self) -> None:
        self.client.queue(reply([text("Hi.")], uncached=10, read=0, write=0, out=5))
        self.ask()
        call = self.client.messages.calls[0]
        self.assertEqual(block_markers(call), [f"tools[{len(call['tools']) - 1}]", "system[0]"])
        self.assertEqual(call["tools"][-1]["cache_control"], EPHEMERAL)
        self.assertEqual(call["cache_control"], EPHEMERAL)  # automatic: last block, moves forward each round

    def test_follow_up_marks_end_of_history_and_reuses_previous_prefix(self) -> None:
        self.client.queue(reply([text("First.")], uncached=10, read=0, write=0, out=5))
        thread_id = self.ask("Q1?").json()["thread_id"]
        self.client.queue(reply([text("Second.")], uncached=10, read=0, write=0, out=5))
        self.ask("Q2?", thread_id=thread_id)
        self.client.queue(reply([text("Third.")], uncached=10, read=0, write=0, out=5))
        self.ask("Q3?", thread_id=thread_id)
        _, second, third = self.client.messages.calls
        self.assertEqual(block_markers(second)[2:], ["messages[1][0]"])
        self.assertEqual(block_markers(third)[2:], ["messages[3][0]"])
        for call in (second, third):
            self.assertLessEqual(len(block_markers(call)) + 1, 4)  # + the automatic breakpoint
        # Turn 3 re-sends turn 2's marked history byte-for-byte (markers aside), so it can read it.
        self.assertEqual(json.dumps(strip_markers(third["messages"][:2])), json.dumps(strip_markers(second["messages"][:2])))

    def test_tool_rounds_extend_the_previous_request(self) -> None:
        self.client.queue(
            reply([tool_use("get_card", {"card_id": "ssp-1"}, "c1")], "tool_use", uncached=10, read=0, write=0, out=5),
            reply([text("$120.")], uncached=10, read=0, write=0, out=5),
        )
        self.ask("Pikachu ex price?")
        first, second = self.client.messages.calls
        self.assertEqual(second["cache_control"], EPHEMERAL)
        n = len(first["messages"])
        self.assertEqual(json.dumps(strip_markers(second["messages"][:n])), json.dumps(strip_markers(first["messages"])))
        self.assertEqual(second["tool_choice"], first["tool_choice"])

    def test_history_breakpoint_helper(self) -> None:
        only = [{"role": "user", "content": [{"type": "text", "text": "q"}]}]
        self.assertIs(with_history_breakpoint(only), only)
        messages = [{"role": "user", "content": "q1"}, {"role": "assistant", "content": "a1"},
                    {"role": "user", "content": [{"type": "text", "text": "q2"}]}]
        marked = with_history_breakpoint(messages)
        self.assertEqual(marked[0]["content"], [{"type": "text", "text": "q1"}])
        self.assertEqual(marked[1]["content"], [{"type": "text", "text": "a1", "cache_control": EPHEMERAL}])
        self.assertIs(marked[2], messages[2])
        self.assertEqual(messages[1]["content"], "a1")  # input untouched


class TokenReportTests(unittest.TestCase):
    def test_report_shows_cache_hit_and_averages(self) -> None:
        records = [
            {"case": "a", "turn": 1, "cost_usd": 0.001, "input_tokens": 10000, "output_tokens": 200,
             "cache_read_tokens": 9000, "cache_write_tokens": 100},
            {"case": "b", "turn": 1, "cost_usd": 0.001, "input_tokens": 10000, "output_tokens": 400,
             "cache_read_tokens": 8000, "cache_write_tokens": 0},
            {"case": "c", "turn": 1, "cost_usd": 0.001},  # older JSONL row: no usage
        ]
        summary = summarize(records)
        self.assertEqual(summary["usage_turns"], 2)
        self.assertAlmostEqual(summary["cache_hit_ratio"], 0.85)
        self.assertEqual((summary["avg_input_tokens"], summary["avg_output_tokens"]), (10000, 300))
        self.assertIn("cache hit 85% of input; avg 10000 in / 300 out per turn", render_report(records))
        self.assertIsNone(summarize(records[2:])["cache_hit_ratio"])


if __name__ == "__main__":
    unittest.main()
