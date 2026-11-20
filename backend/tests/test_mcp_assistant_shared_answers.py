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
        self.assertEqual(norm("What’s trending in the market right now?"), "what's trending in market right now")
        self.assertEqual(norm("What's trending right now"), norm("what is trending in the market right now"))
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

    def test_version_reads_the_connection_on_its_own_thread(self) -> None:
        # Live connections are per-thread (check_same_thread): fetching one on the
        # event-loop thread and using it in a worker silently disabled the cache.
        import threading
        from mcp_server.assistant.store import AssistantStore

        seen: dict[str, int] = {}
        original = AssistantStore.conn

        def conn(store):
            seen["conn_thread"] = threading.get_ident()  # last access before the version read
            return original.fget(store)

        def version(_conn):
            seen.setdefault("version_thread", threading.get_ident())
            seen.setdefault("conn_thread_at_version", seen.get("conn_thread"))
            return self.version

        with mock.patch.object(AssistantStore, "conn", property(conn)), \
                mock.patch.object(shared_answers, "data_version", side_effect=version):
            seen.clear()
            self.queue_market()
            self.ask(QUESTION, user=USER_A)
        self.assertIn("version_thread", seen)
        self.assertEqual(seen["conn_thread_at_version"], seen["version_thread"])

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


KNOWLEDGE_Q = "What's a SIR?"
KNOWLEDGE_A = "A SIR is a Special Illustration Rare: a full-card alternate artwork printed above the set number."


class KnowledgeNormalizeTests(unittest.TestCase):
    @unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
    def test_light_normalization_variants(self) -> None:
        norm = shared_answers.normalize_question
        for variant in ("what is a sir", "Whats a SIR?", "What’s a SIR??", "Hey, what's a SIR", "so what is a sir",
                        "hey so whats a sir"):
            with self.subTest(variant=variant):
                self.assertEqual(norm(variant), "what's a sir")
        self.assertEqual(norm("What's the difference between PSA and CGC?"), "what's difference between psa and cgc")
        # Conservative: "the" inside a word and other fillers are untouched.
        self.assertEqual(norm("Theme decks explained"), "theme decks explained")
        self.assertEqual(norm("okay what's a sir"), "okay what's a sir")

    @unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
    def test_personal_questions(self) -> None:
        for question in ("What's my collection worth?", "Is the Charizard I own a SIR?", "what's in my watchlist",
                         "Explain my portfolio", "Which of mine are SIRs?"):
            with self.subTest(question=question):
                self.assertFalse(shared_answers.request_eligible({"thread_id": None, "text": question}))
        self.assertTrue(shared_answers.request_eligible({"thread_id": None, "text": "Show me undervalued cards"}))


class KnowledgeAnswerTests(SharedAnswerCase):
    def queue_knowledge(self, answer: str = KNOWLEDGE_A) -> None:
        self.client.queue(message([text(answer)]))

    def knowledge_rows(self) -> int:
        return self.count("assistant_shared_answers", "version = ?", (shared_answers.KNOWLEDGE_VERSION,))

    def test_knowledge_answer_replayed_to_another_user_at_zero_cost(self) -> None:
        self.queue_knowledge()
        first = self.ask(KNOWLEDGE_Q, user=USER_A)
        self.assertEqual(first.status_code, 200)
        self.assertEqual((self.calls(), self.knowledge_rows()), (1, 1))
        second = self.ask("hey what is a sir", user=USER_B)
        self.assertEqual(self.calls(), 1)
        body = second.json()
        self.assertEqual(body["message"]["text"], first.json()["message"]["text"])
        row = self.conn.execute(
            "SELECT cached, cost_usd, owner_user_id FROM assistant_messages WHERE id = ?", (body["message"]["id"],)
        ).fetchone()
        self.assertEqual((row["cached"], row["cost_usd"], row["owner_user_id"]), (1, 0.0, USER_B))

    def test_price_version_change_does_not_invalidate(self) -> None:
        self.queue_knowledge()
        self.ask(KNOWLEDGE_Q, user=USER_A)
        self.version = "2026-11-21|psg:9|w:0"
        self.ask(KNOWLEDGE_Q, user=USER_B)
        self.version = None  # no price data at all: knowledge still served
        self.ask("Whats a SIR", user=FOUNDER)
        self.assertEqual(self.calls(), 1)

    def test_knowledge_expiry_is_7_days(self) -> None:
        self.queue_knowledge()
        self.ask(KNOWLEDGE_Q, user=USER_A)
        key, created, expires = self.conn.execute(
            "SELECT key, created_at, expires_at FROM assistant_shared_answers"
        ).fetchone()
        parse = lambda value: datetime.fromisoformat(value.replace("Z", "+00:00"))  # noqa: E731
        self.assertEqual(parse(expires) - parse(created), timedelta(days=7))
        store = shared_answers.SharedAnswerStore(lambda: self.conn)
        version = shared_answers.KNOWLEDGE_VERSION
        self.assertIsNotNone(store.get(key, version, now=parse(created) + timedelta(days=6, hours=23)))
        self.assertIsNone(store.get(key, version, now=parse(created) + timedelta(days=7, seconds=1)))

    def test_engine_change_misses(self) -> None:
        self.queue_knowledge()
        self.ask(KNOWLEDGE_Q, user=USER_A)
        with mock.patch.object(shared_answers, "engine_fingerprint", return_value="other-model|x"):
            self.queue_knowledge()
            self.ask(KNOWLEDGE_Q, user=USER_B)
        self.assertEqual(self.calls(), 2)

    def test_refusals_declines_and_clarifications_are_not_cached(self) -> None:
        cases = [
            ("Write me a poem about the ocean", "Here is a short poem about waves."),  # turn_kind 'refusal'
            ("What's a good pizza recipe?", "I can only help with cards and collecting in Ekalight."),
            ("What's a SIR?", "Do you mean Pokémon or One Piece?"),
        ]
        for question, answer in cases:
            with self.subTest(question=question):
                self.queue_knowledge(answer)
                self.ask(question, user=USER_A)
        self.client.queue(message([text("")], "refusal"))
        self.ask("What is a hit?", user=USER_A)
        self.flags = ["long_answer"]
        self.queue_knowledge()
        self.ask("What does Near Mint mean?", user=USER_A)
        self.assertEqual(self.shared_rows(), 0)

    def test_slow_flag_and_what_does_mean_are_cached(self) -> None:
        self.flags = ["slow"]
        self.queue_knowledge("Near Mint means the card looks unplayed apart from tiny flaws.")
        self.ask("What does Near Mint mean?", user=USER_A)
        self.flags = []
        self.queue_knowledge("PSA has the deepest resale market; CGC grades subgrades more strictly.")
        self.ask("PSA vs CGC?", user=USER_A)
        self.assertEqual(self.knowledge_rows(), 2)

    def test_personal_questions_are_never_cached(self) -> None:
        for question in ("What's a SIR in my collection?", "Why is my watchlist empty?",
                         "Explain the grade on the card I own"):
            with self.subTest(question=question):
                self.queue_knowledge()
                self.ask(question, user=USER_A)
        self.assertEqual(self.shared_rows(), 0)

    def test_scanner_context_and_follow_ups_bypass(self) -> None:
        self.queue_knowledge()
        first = self.ask(KNOWLEDGE_Q, user=USER_A).json()
        self.queue_knowledge()
        self.ask(KNOWLEDGE_Q, user=USER_A, thread_id=first["thread_id"])
        self.queue_knowledge()
        self.ask(KNOWLEDGE_Q, user=USER_B, context={"source": "scanner", "card_ids": ["ssp-1"]})
        self.assertEqual(self.calls(), 3)

    def test_price_dependent_example_answer_stays_on_the_price_version(self) -> None:
        # A knowledge question answered with a priced catalog example is a market answer.
        question = "What's a SIR? Show an example"
        self.queue_market("search_cards", {"filter": {"text": "pikachu"}}, "A SIR like Pikachu ex runs $120.00.")
        self.ask(question, user=USER_A)
        self.assertEqual(self.knowledge_rows(), 0)
        self.assertEqual(
            self.conn.execute("SELECT version FROM assistant_shared_answers").fetchone()[0], self.version
        )
        self.ask(question, user=USER_B)
        self.assertEqual(self.calls(), 2)
        self.version = "2026-11-21|psg:2|w:0"
        self.queue_market("search_cards", {"filter": {"text": "pikachu"}}, "A SIR like Pikachu ex runs $130.00.")
        self.ask(question, user=FOUNDER)
        self.assertEqual(self.calls(), 4)


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
