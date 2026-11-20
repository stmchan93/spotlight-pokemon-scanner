"""Assistant answer quality flags: each flag's positive + negative case,
persistence on the message row, PostHog properties, and the review script."""

from __future__ import annotations

import contextlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
for path in (BACKEND_ROOT, BACKEND_ROOT / "tests", BACKEND_ROOT / "tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import assistant_review  # noqa: E402
from mcp_server.assistant.flags import (  # noqa: E402
    EXPENSIVE_COST_USD,
    LONG_ANSWER_WORDS,
    SLOW_LATENCY_MS,
    flag_turn,
)
from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, bearer, message, text, tool_use  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.store import SCHEMA_SQL, ensure_schema


def turn(**overrides):
    base = {
        "text": "Pikachu ex is $120.",
        "status": "ok",
        "stop_reason": "end_turn",
        "cards": [{"card_id": "ssp-1", "name": "Pikachu ex", "set": "Surging Sparks"}],
        "charts": [],
        "tool_errors": [],
        "round_limit_hit": False,
        "latency_ms": 2000,
        "cost_usd": 0.001,
    }
    base.update(overrides)
    return base


def flags_for(question: str = "What is Pikachu ex worth?", **overrides) -> list[str]:
    return flag_turn(question, turn(**overrides), {"source": "home"})


class FlagTurnTests(unittest.TestCase):
    def assertFlag(self, code: str, positive: list[str], negative: list[str]) -> None:
        self.assertIn(code, positive)
        self.assertNotIn(code, negative)

    def test_clean_turn_has_no_flags(self) -> None:
        self.assertEqual(flags_for(), [])

    def test_long_answer(self) -> None:
        self.assertFlag(
            "long_answer",
            flags_for(text="word " * (LONG_ANSWER_WORDS + 1)),
            flags_for(text="word " * LONG_ANSWER_WORDS),
        )

    def test_refusal_or_error(self) -> None:
        self.assertIn("refusal_or_error", flags_for(status="error"))
        self.assertIn("refusal_or_error", flags_for(stop_reason="refusal"))
        self.assertIn("refusal_or_error", flags_for(stop_reason="max_tokens"))
        self.assertNotIn("refusal_or_error", flags_for(stop_reason="end_turn"))

    def test_no_results(self) -> None:
        self.assertFlag("no_results", flags_for(text="I couldn’t find that card."), flags_for())
        self.assertIn("no_results", flags_for(text="That set is not in the catalog."))
        self.assertIn("no_results", flags_for(text="Ekalight doesn't have a price for it."))

    def test_tool_error(self) -> None:
        self.assertFlag("tool_error", flags_for(tool_errors=["get_card"]), flags_for(tool_errors=[]))

    def test_round_limit(self) -> None:
        self.assertFlag("round_limit", flags_for(round_limit_hit=True), flags_for(round_limit_hit=False))

    def test_slow(self) -> None:
        self.assertFlag("slow", flags_for(latency_ms=SLOW_LATENCY_MS + 1), flags_for(latency_ms=SLOW_LATENCY_MS))

    def test_expensive(self) -> None:
        self.assertFlag(
            "expensive", flags_for(cost_usd=EXPENSIVE_COST_USD + 0.0001), flags_for(cost_usd=EXPENSIVE_COST_USD)
        )

    def test_self_correction(self) -> None:
        self.assertFlag("self_correction", flags_for(text="Let me correct my last answer."), flags_for())
        self.assertIn("self_correction", flags_for(text="I didn't pull the price before."))
        self.assertIn("self_correction", flags_for(text="Sorry, I didn't run that search."))

    def test_mentions_internals(self) -> None:
        self.assertFlag("mentions_internals", flags_for(text="The tool returned two cards."), flags_for())
        self.assertIn("mentions_internals", flags_for(text="Earlier in this chat you asked."))
        self.assertIn("mentions_internals", flags_for(text="The search I ran found it."))
        self.assertNotIn("mentions_internals", flags_for(text="Toolbox Charizard is $5."))

    def test_currency_leak(self) -> None:
        self.assertFlag("currency_leak", flags_for(text="It sells for ¥1,200."), flags_for())
        self.assertIn("currency_leak", flags_for(text="About 5000 yen."))
        self.assertIn("currency_leak", flags_for(text="Priced in JPY."))
        self.assertNotIn("currency_leak", flags_for(text="Yenta is a cat."))

    def test_wrong_naming(self) -> None:
        self.assertFlag("wrong_naming", flags_for(text="Added to your Wishlist."), flags_for(text="On your Watchlist."))
        self.assertIn("wrong_naming", flags_for(text="your wish list"))

    def test_game_mismatch(self) -> None:
        pokemon_tiles = [{"card_id": "ssp-1", "name": "Pikachu ex"}]
        op_tiles = [{"card_id": "onepiece~OP01-001", "name": "Luffy"}]
        self.assertIn("game_mismatch", flags_for("Top One Piece cards?", cards=pokemon_tiles))
        self.assertNotIn("game_mismatch", flags_for("Top One Piece cards?", cards=op_tiles))
        self.assertIn("game_mismatch", flags_for("Best Pokémon cards?", cards=op_tiles))
        self.assertIn("game_mismatch", flags_for("Any Lorcana deals?", cards=op_tiles))
        self.assertNotIn("game_mismatch", flags_for("Best cards?", cards=op_tiles))  # no game named

    def test_no_tiles_for_card_question(self) -> None:
        self.assertIn("no_tiles_for_card_question", flags_for("How much is Charizard?", cards=[]))
        self.assertNotIn("no_tiles_for_card_question", flags_for("How much is Charizard?"))
        self.assertNotIn("no_tiles_for_card_question", flags_for("Charizard trend?", cards=[], charts=[{"card_id": "x"}]))
        self.assertNotIn("no_tiles_for_card_question", flags_for("Hi there!", cards=[]))

    def test_claims_unapplied_filter(self) -> None:
        sealed = [{"card_id": "tcgp-sealed-123", "name": "Surging Sparks Booster Box"}]
        named_box = [{"card_id": "x-1", "name": "Elite Trainer Box", "set": "Prismatic"}]
        japanese = [{"card_id": "sv8_ja-12", "name": "Pikachu"}]
        claim_singles = "Here are the top cards, excluding sealed products."
        self.assertIn("claims_unapplied_filter", flags_for(text=claim_singles, cards=sealed))
        self.assertIn("claims_unapplied_filter", flags_for(text="Singles only: ...", cards=named_box))
        self.assertNotIn("claims_unapplied_filter", flags_for(text=claim_singles))
        self.assertNotIn(
            "claims_unapplied_filter",
            flags_for(text=claim_singles, cards=[{"card_id": "ssp-9", "name": "Booster Energy Capsule"}]),
        )
        self.assertIn("claims_unapplied_filter", flags_for(text="English only results:", cards=japanese))
        self.assertNotIn("claims_unapplied_filter", flags_for(text="Here are results:", cards=japanese + sealed))

    def test_turn_object_and_order(self) -> None:
        class Obj:
            pass

        obj = Obj()
        for key, value in turn(status="error", cost_usd=1.0, text="I couldn't find it in yen").items():
            setattr(obj, key, value)
        self.assertEqual(flag_turn("price?", obj), ["refusal_or_error", "no_results", "currency_leak", "expensive"])


class RecordingAnalytics:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def capture(self, distinct_id: str, properties: dict) -> None:
        self.events.append((distinct_id, properties))


class FlagPersistenceTests(AssistantCase):
    def setUp(self) -> None:
        super().setUp()
        self.recorder = RecordingAnalytics()
        self.assistant.analytics = self.recorder

    def test_flags_persisted_returned_and_sent_to_posthog(self) -> None:
        self.client.queue(
            message([tool_use("no_such_tool", {}, "tu_1")], "tool_use"),
            message([text("I couldn't find it. It's on your wishlist.")]),
        )
        question = "What is Mewtwo worth? " + "x" * 300
        body = self.ask(question[:1000]).json()
        reply = body["message"]
        expected = ["tool_error", "no_results", "no_tiles_for_card_question", "wrong_naming"]
        self.assertEqual(reply["flags"], expected)
        self.assertEqual(body["user_message"]["flags"], [])
        stored = self.conn.execute("SELECT flags_json FROM assistant_messages WHERE id = ?", (reply["id"],)).fetchone()
        self.assertEqual(json.loads(stored["flags_json"]), expected)
        listed = self.http.get(
            f"/api/v1/assistant/threads/{body['thread_id']}/messages", headers=bearer(USER_A)
        ).json()["messages"]
        self.assertEqual(listed[-1]["flags"], expected)

        user, props = self.recorder.events[-1]
        self.assertEqual(user, USER_A)
        self.assertEqual(props["flags"], expected)
        self.assertEqual(props["flag_count"], 4)
        self.assertEqual(len(props["question"]), 200)
        self.assertTrue(props["answer_preview"].startswith("I couldn't find it"))
        self.assertEqual(props["thread_id"], body["thread_id"])
        self.assertEqual(props["message_id"], reply["id"])

    def test_round_limit_recorded(self) -> None:
        self.build(max_tool_rounds=1)
        self.assistant.analytics = self.recorder
        self.client.queue(
            message([tool_use("get_card", {"card_id": "ssp-1"}, "a")], "tool_use"),
            message([text("Pikachu ex is $120.")]),
        )
        reply = self.ask("Pikachu ex price?").json()["message"]
        self.assertIn("round_limit", reply["flags"])
        self.assertNotIn("tool_error", reply["flags"])
        self.assertEqual(self.recorder.events[-1][1]["answer_preview"], "Pikachu ex is $120.")

    def test_clean_turn_has_empty_flags(self) -> None:
        self.client.queue(message([text("Hello! Ask me about your cards.")]))
        reply = self.ask("Hi").json()["message"]
        self.assertEqual(reply["flags"], [])
        self.assertEqual(self.recorder.events[-1][1]["flag_count"], 0)

    def test_schema_patch_adds_flags_column(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.executescript(SCHEMA_SQL.replace(",\n    flags_json TEXT", ""))
        ensure_schema(conn)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(assistant_messages)")}
        self.assertIn("flags_json", columns)


class ReviewScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tempdir.name) / "review.sqlite")
        conn = sqlite3.connect(self.db)
        conn.executescript(
            """
            CREATE TABLE assistant_messages (
                id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, role TEXT NOT NULL,
                text TEXT NOT NULL, cards_json TEXT, actions_json TEXT, status TEXT NOT NULL DEFAULT 'ok',
                client_message_id TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, tools_used TEXT,
                created_at TEXT NOT NULL, suggestions_json TEXT, tool_calls_json TEXT, charts_json TEXT, flags_json TEXT
            );
            """
        )
        rows = [
            ("q1", "a1", "2026-11-10T00:00:00Z", "Old question", "Old answer", ["no_results"]),
            ("q2", "a2", "2026-11-18T00:00:00Z", "One Piece top cards?", "Here: Pikachu", ["game_mismatch"]),
            ("q3", "a3", "2026-11-18T01:00:00Z", "Price of Pikachu?", "It is $5 in yen", ["currency_leak", "slow"]),
            ("q4", "a4", "2026-11-18T02:00:00Z", "Hi", "Hello!", []),
            ("q5", "a5", "2026-11-18T03:00:00Z", "Worth?", "$9", []),
        ]
        for qid, aid, created, question, answer, flags in rows:
            conn.execute(
                "INSERT INTO assistant_messages (id, thread_id, owner_user_id, role, text, status, client_message_id, "
                "created_at) VALUES (?, 't1', 'u1', 'user', ?, 'ok', ?, ?)",
                (qid, question, f"cm-{qid}", created),
            )
            conn.execute(
                "INSERT INTO assistant_messages (id, thread_id, owner_user_id, role, text, status, client_message_id, "
                "created_at, cards_json, tool_calls_json, cost_usd, flags_json) "
                "VALUES (?, 't1', 'u1', 'assistant', ?, 'ok', ?, ?, ?, ?, 0.002, ?)",
                (aid, answer, f"cm-{qid}:reply", created, json.dumps([{"card_id": "ssp-1"}]),
                 json.dumps(["get_card(card_id=ssp-1)"]), json.dumps(flags)),
            )
        conn.commit()
        conn.close()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def run_main(self, *args: str) -> str:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(assistant_review.main(["--db", self.db, *args]), 0)
        return out.getvalue()

    def test_fetch_joins_question_and_since(self) -> None:
        conn = sqlite3.connect(self.db)
        turns = assistant_review.fetch_turns(conn, since="2026-11-15")
        conn.close()
        self.assertEqual([t["message_id"] for t in turns], ["a5", "a4", "a3", "a2"])
        self.assertEqual(turns[2]["question"], "Price of Pikachu?")
        self.assertEqual(turns[2]["tiles"], ["ssp-1"])
        self.assertEqual(turns[2]["tools"], ["get_card(card_id=ssp-1)"])

    def test_flag_filter_limit_and_sample(self) -> None:
        conn = sqlite3.connect(self.db)
        turns = assistant_review.fetch_turns(conn)
        conn.close()
        flagged, sample = assistant_review.select_turns(turns, flags=["currency_leak"])
        self.assertEqual([t["message_id"] for t in flagged], ["a3"])
        self.assertEqual(sample, [])
        flagged, _ = assistant_review.select_turns(turns, limit=2)
        self.assertEqual([t["message_id"] for t in flagged], ["a3", "a2"])
        _, sample = assistant_review.select_turns(turns, sample=5, seed=1)
        self.assertEqual({t["message_id"] for t in sample}, {"a4", "a5"})

    def test_main_output(self) -> None:
        output = self.run_main("--since", "2026-11-15", "--flag", "game_mismatch,no_results")
        self.assertIn("4 answers, 2 flagged", output)
        self.assertIn("Q:      One Piece top cards?", output)
        self.assertNotIn("Old question", output)
        self.assertNotIn("Price of Pikachu?", output)
        self.assertIn("cost:   $0.0020", output)
        sampled = self.run_main("--sample", "1", "--seed", "3")
        self.assertIn("=== Unflagged sample (1) ===", sampled)

    def test_parse_since(self) -> None:
        self.assertIsNone(assistant_review.parse_since(None))
        self.assertEqual(assistant_review.parse_since("2026-11-18"), "2026-11-18")
        self.assertTrue(assistant_review.parse_since("7d").endswith("Z"))
        with self.assertRaises(ValueError):
            assistant_review.parse_since("last week")


if __name__ == "__main__":
    unittest.main()
