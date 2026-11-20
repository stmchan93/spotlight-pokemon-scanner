"""Shared answer cache: market-wide first-message answers are stored once and
replayed to every user (no LLM call) until prices change or 24h pass."""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import (  # noqa: E402
    FOUNDER, GUEST, HAVE_DEPS, USER_A, USER_B, AssistantCase, bearer, message, text, tool_use,
)

if HAVE_DEPS:
    from catalog_tools import upsert_runtime_setting, utc_now
    from mcp_server.assistant import shared_answers
    from mcp_server.assistant.config import AssistantConfig

QUESTION = "Undervalued cards"
ANSWER = "Pikachu ex sits near its 90-day low at $120.00. That isn't a prediction."


class NormalizeTests(unittest.TestCase):
    @unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
    def test_normalization_and_aliases(self) -> None:
        norm = shared_answers.normalize_question
        self.assertEqual(norm("  What cards are   LIKELY to go up?? "), "what cards are likely to go up")
        self.assertEqual(norm("What’s trending in the market right now?"), "what's trending in the market right now")
        self.assertEqual(norm("Show me undervalued cards."), "undervalued cards")
        self.assertEqual(norm("Undervalued cards"), "undervalued cards")
        # No fuzzy matching: a different wording is a different key.
        self.assertEqual(norm("undervalued pokemon cards"), "undervalued pokemon cards")


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class SharedAnswerCase(AssistantCase):
    def setUp(self) -> None:
        super().setUp()
        self.version = "2026-11-20|psg:1|w:0"
        patcher = mock.patch.object(shared_answers, "data_version", side_effect=lambda conn: self.version)
        patcher.start()
        self.addCleanup(patcher.stop)
        # The seeded DB has no price_lows rows (no tiles); flags are set per test instead.
        self.flags: list[str] = []
        flagger = mock.patch("mcp_server.assistant.service.flag_turn", side_effect=lambda *a: list(self.flags))
        flagger.start()
        self.addCleanup(flagger.stop)

    def queue_market(self, tool: str = "find_price_lows", args: dict | None = None, answer: str = ANSWER) -> None:
        self.client.queue(
            message([tool_use(tool, args if args is not None else {"filter": {"game": "pokemon"}}, "t1")], "tool_use"),
            message([text(answer)]),
        )

    def calls(self) -> int:
        return len(self.client.messages.calls)

    def shared_rows(self) -> int:
        return self.count("assistant_shared_answers")


class SharedAnswerTests(SharedAnswerCase):
    def test_first_answer_is_stored_and_replayed_to_another_user(self) -> None:
        self.queue_market()
        first = self.ask(QUESTION, user=USER_A)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(self.calls(), 2)
        self.assertEqual(self.shared_rows(), 1)

        second = self.ask("show me undervalued cards!", user=USER_B)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(self.calls(), 2)  # no LLM call
        body = second.json()
        self.assertEqual(body["message"]["text"], first.json()["message"]["text"])
        self.assertNotEqual(body["message"]["id"], first.json()["message"]["id"])
        self.assertNotEqual(body["thread_id"], first.json()["thread_id"])
        row = self.conn.execute(
            "SELECT cached, cost_usd, input_tokens, owner_user_id FROM assistant_messages WHERE id = ?",
            (body["message"]["id"],),
        ).fetchone()
        self.assertEqual((row["cached"], row["cost_usd"], row["input_tokens"], row["owner_user_id"]), (1, 0.0, 0, USER_B))
        hits = self.conn.execute("SELECT hits FROM assistant_shared_answers").fetchone()[0]
        self.assertEqual(hits, 1)
        # Still a question: the limit counts it, and the spend stays 0.
        self.assertEqual(body["usage"]["used_today"], 1)
        questions, cost = self.conn.execute(
            "SELECT questions, cost_usd FROM assistant_usage WHERE owner_user_id = ?", (USER_B,)
        ).fetchone()
        self.assertEqual((questions, cost), (1, 0.0))
        # Owner-scoped like any other thread.
        self.assertEqual(self.http.get(f"/api/v1/assistant/threads/{body['thread_id']}/messages",
                                       headers=bearer(USER_A)).status_code, 404)

    def test_cached_answer_counts_toward_daily_limit(self) -> None:
        self.queue_market()
        self.ask(QUESTION, user=USER_A)
        self.assertEqual(self.ask(QUESTION, user=GUEST, anonymous=True).status_code, 200)
        response = self.ask(QUESTION, user=GUEST, anonymous=True)
        self.assertEqual(response.status_code, 429)
        self.assertEqual(self.calls(), 2)

    def test_cached_answer_served_past_the_spend_cap(self) -> None:
        self.queue_market()
        self.ask(QUESTION, user=USER_A)
        day = datetime.now(timezone.utc).date().isoformat()
        self.conn.execute(
            "INSERT INTO assistant_usage (owner_user_id, day, questions, cost_usd) VALUES ('someone', ?, 0, 99)", (day,)
        )
        self.conn.commit()
        self.assertEqual(self.ask(QUESTION, user=FOUNDER).status_code, 200)
        self.assertEqual(self.ask("Pikachu ex price", user=FOUNDER).status_code, 503)

    def test_version_change_invalidates(self) -> None:
        self.queue_market()
        self.ask(QUESTION, user=USER_A)
        self.version = "2026-11-20|psg:2|w:0"
        self.queue_market()
        self.ask(QUESTION, user=USER_B)
        self.assertEqual(self.calls(), 4)
        # The new answer replaced the old version's row.
        self.assertEqual(self.shared_rows(), 1)
        self.assertEqual(self.conn.execute("SELECT version FROM assistant_shared_answers").fetchone()[0], self.version)

    def test_expired_entry_misses(self) -> None:
        self.queue_market()
        self.ask(QUESTION, user=USER_A)
        past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(timespec="seconds").replace("+00:00", "Z")
        self.conn.execute("UPDATE assistant_shared_answers SET expires_at = ?", (past,))
        self.conn.commit()
        self.queue_market()
        self.ask(QUESTION, user=USER_B)
        self.assertEqual(self.calls(), 4)

    def test_expiry_is_24_hours(self) -> None:
        store = shared_answers.SharedAnswerStore(lambda: self.conn)
        start = datetime(2026, 11, 20, 12, tzinfo=timezone.utc)
        store.put("k", question_norm="q", version="v", reply={"text": "x"}, now=start)
        self.assertIsNotNone(store.get("k", "v", now=start + timedelta(hours=23)))
        self.assertIsNone(store.get("k", "v", now=start + timedelta(hours=24, seconds=1)))
        self.assertIsNone(store.get("k", "other", now=start))

    def test_follow_up_and_scanner_context_bypass_the_cache(self) -> None:
        self.queue_market()
        first = self.ask(QUESTION, user=USER_A).json()
        self.queue_market()
        self.ask(QUESTION, user=USER_A, thread_id=first["thread_id"])
        self.queue_market()
        self.ask(QUESTION, user=USER_B, context={"source": "scanner", "card_ids": ["ssp-1"]})
        self.assertEqual(self.calls(), 6)
        self.assertEqual(self.shared_rows(), 1)

    def test_user_specific_tools_and_owned_filters_are_not_cached(self) -> None:
        cases = [
            ("get_portfolio_summary", {}),
            ("get_my_collection", {}),
            ("find_price_lows", {"filter": {"game": "pokemon"}, "owned": "owned"}),
            ("search_cards", {"filter": {"text": "pikachu"}, "owned": "not_owned"}),
            ("get_card", {"card_id": "ssp-1"}),
            ("grading_upside", {"card_ids": ["ssp-1"]}),
        ]
        for tool, args in cases:
            with self.subTest(tool=tool, args=args):
                self.queue_market(tool, args)
                self.assertEqual(self.ask(f"q {tool} {args}", user=FOUNDER).status_code, 200)
        self.assertEqual(self.shared_rows(), 0)

    def test_proposals_are_not_cached(self) -> None:
        self.client.queue(
            message([tool_use("find_price_lows", {"filter": {"game": "pokemon"}}, "t1"),
                     tool_use("propose_watch_card", {"card_id": "ssp-1", "target_price_usd": None, "variant": None},
                              "t2")], "tool_use"),
            message([text(ANSWER)]),
        )
        self.ask(QUESTION, user=USER_A)
        self.assertEqual(self.shared_rows(), 0)

    def test_flagged_and_failed_answers_are_not_cached(self) -> None:
        self.flags = ["no_results"]
        self.queue_market()
        self.ask(QUESTION, user=USER_A)
        self.flags = []
        self.client.queue(message([text("")], "refusal"))
        self.ask("What's trending in the market right now?", user=USER_A)
        self.assertEqual(self.shared_rows(), 0)

    def test_cost_and_latency_flags_do_not_block(self) -> None:
        self.flags = ["slow", "expensive"]
        self.queue_market()
        self.ask(QUESTION, user=USER_A)
        self.assertEqual(self.shared_rows(), 1)

    def test_answer_without_tools_is_not_cached(self) -> None:
        self.client.queue(message([text("Which game do you mean?")]))
        self.ask(QUESTION, user=USER_A)
        self.assertEqual(self.shared_rows(), 0)

    def test_kill_switch(self) -> None:
        with mock.patch.dict(os.environ, {"ASSISTANT_SHARED_ANSWERS": "0"}):
            self.assertFalse(AssistantConfig.from_env().shared_answers)
        self.assertTrue(AssistantConfig.from_env().shared_answers)
        self.build(shared_answers=False)
        self.queue_market()
        self.ask(QUESTION, user=USER_A)
        self.queue_market()
        self.ask(QUESTION, user=USER_B)
        self.assertEqual(self.calls(), 4)
        self.assertEqual(self.shared_rows(), 0)

    def test_no_version_means_no_cache(self) -> None:
        self.version = None
        self.queue_market()
        self.ask(QUESTION, user=USER_A)
        self.assertEqual(self.shared_rows(), 0)

    def test_stored_and_served_tiles_carry_no_ownership(self) -> None:
        reply = shared_answers.replay({"text": "x", "cards": [{"card_id": "a", "quantity_owned": 3, "name": "A"}]})
        self.assertEqual(reply["cards"], [{"card_id": "a", "name": "A"}])
        self.assertEqual((reply["cost_usd"], reply["actions"], reply["flags"]), (0.0, [], []))
        self.assertTrue(shared_answers._has_user_data({"results": [{"my_holdings": []}]}))
        self.assertTrue(shared_answers._has_user_data({"resolved_owned_card_id": "x"}))

    def test_cached_analytics_props(self) -> None:
        self.queue_market()
        self.ask(QUESTION, user=USER_A)
        with mock.patch.object(self.assistant.analytics, "capture") as capture:
            self.ask(QUESTION, user=USER_B)
        props = capture.call_args[0][1]
        self.assertTrue(props["cached"])
        self.assertEqual(props["cost_usd"], 0.0)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class DataVersionTests(AssistantCase):
    def test_token_moves_with_price_date_and_sync_generation(self) -> None:
        self.assertIsNone(shared_answers.data_version(self.conn))
        self.conn.execute(
            "INSERT INTO card_price_history_daily (card_id, provider, price_date, display_currency_code, updated_at) "
            "VALUES ('ssp-1', 'scrydex', '2026-11-19', 'USD', ?)", (utc_now(),),
        )
        self.conn.commit()
        first = shared_answers.data_version(self.conn)
        self.assertIn("2026-11-19", first)
        upsert_runtime_setting(self.conn, key="pricing_sync_generation", value=7)
        self.conn.commit()
        second = shared_answers.data_version(self.conn)
        self.assertNotEqual(first, second)
        self.assertIn("psg:7", second)



@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class EvalSharedCacheTests(SharedAnswerCase):
    """The eval bypasses the cache by default; --shared-cache exercises it."""

    def runner(self):
        from test_assistant_eval import load_runner

        return load_runner()

    def test_eval_flag_defaults_to_bypass(self) -> None:
        parser = self.runner().build_parser()
        self.assertFalse(parser.parse_args([]).shared_cache)
        self.assertFalse(parser.parse_args(["--no-shared-cache"]).shared_cache)
        self.assertTrue(parser.parse_args(["--shared-cache"]).shared_cache)

    def test_run_case_records_cached_replay(self) -> None:
        import asyncio

        from mcp_server.assistant.service import Caller

        runner = self.runner()
        recorder = runner.ToolRecorder(self.assistant.toolbox)
        case = {"id": "uv", "category": "investing", "turns": [{"ask": QUESTION}]}
        self.queue_market()
        first, _ = asyncio.run(runner.run_case(self.assistant, Caller(USER_A, False), recorder, case, 1))
        second, _ = asyncio.run(runner.run_case(self.assistant, Caller(USER_A, False), recorder, case, 2))
        self.assertFalse(first[0]["cached"])
        self.assertTrue(second[0]["cached"])
        self.assertEqual(second[0]["cost_usd"], 0.0)
        self.assertEqual(second[0]["answer"], first[0]["answer"])
        self.assertEqual(self.calls(), 2)

        self.build(shared_answers=False)  # what the eval does by default
        self.queue_market()
        third, _ = asyncio.run(runner.run_case(self.assistant, Caller(USER_A, False), recorder, case, 3))
        self.assertFalse(third[0]["cached"])
        self.assertEqual(self.calls(), 4)


if __name__ == "__main__":
    unittest.main()
