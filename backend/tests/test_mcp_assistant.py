"""In-app assistant (mcp_server.assistant): HTTP routes, auth, limits,
idempotency, owner scoping, the Claude tool loop (mocked client — no network),
propose_* validation, card tiles, and the small main-backend contract changes."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
for path in (BACKEND_ROOT, BACKEND_ROOT / "tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import jwt  # noqa: E402

from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from mcp_server.auth import McpConfig  # noqa: E402
from mcp_server.policy import PUBLIC_POLICY, USER_POLICY  # noqa: E402
from mcp_server.readonly_service import ReadOnlySpotlightService  # noqa: E402
from mcp_server.tools import CollectionTools  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402

try:
    from anthropic.types import Message, TextBlock, ThinkingBlock, ToolUseBlock, Usage
    from starlette.testclient import TestClient

    from mcp_server import app as mcp_app
    from mcp_server.assistant import AssistantConfig, build_assistant_service, install_assistant
    from mcp_server.assistant.config import cost_usd
    from mcp_server.assistant.engine import (
        EMPTY_TEXT,
        REFUSAL_TEXT,
        SYSTEM_PROMPT,
        TOO_LONG_TEXT,
        build_messages,
        provenance_note,
        split_suggestions,
        summarize_tool_call,
    )
    from mcp_server.assistant.store import HISTORY_MESSAGES, ensure_schema, message_payload
    from mcp_server.assistant.tools import MAX_CARDS, TOOL_DEFINITIONS, AssistantToolbox

    HAVE_DEPS = True
except ImportError:  # pragma: no cover - requirements install anthropic + mcp
    HAVE_DEPS = False

SUPABASE_URL = "https://example-ref.supabase.co"
JWT_SECRET = "test-secret-that-is-long-enough-for-hs256"
USER_A = "user-a"
USER_B = "user-b"
GUEST = "guest-1"
FOUNDER = "founder-1"


def make_jwt(sub: str, *, anonymous: bool = False, client_id: str | None = None) -> str:
    now = int(time.time())
    claims = {"sub": sub, "iss": f"{SUPABASE_URL}/auth/v1", "iat": now, "exp": now + 600,
              "aud": "authenticated", "is_anonymous": anonymous}
    if client_id:
        claims["client_id"] = client_id
    return jwt.encode(claims, JWT_SECRET, algorithm="HS256")


def bearer(sub: str, **kwargs) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_jwt(sub, **kwargs)}"}


def message(content: list[Any], stop_reason: str = "end_turn", *, input_tokens: int = 1000,
            output_tokens: int = 100, cache_read: int = 0) -> "Message":
    return Message(
        id="msg_test", type="message", role="assistant", model="claude-haiku-5-5", content=content,
        stop_reason=stop_reason, stop_sequence=None,
        usage=Usage(input_tokens=input_tokens, output_tokens=output_tokens, cache_read_input_tokens=cache_read),
    )


def text(value: str) -> "TextBlock":
    return TextBlock(type="text", text=value)


def tool_use(name: str, arguments: dict[str, Any], block_id: str = "tu_1") -> "ToolUseBlock":
    return ToolUseBlock(type="tool_use", id=block_id, name=name, input=arguments)


def thinking() -> "ThinkingBlock":
    return ThinkingBlock(type="thinking", thinking="", signature="sig-abc")


class FakeMessages:
    def __init__(self, script: list[Any]) -> None:
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs):
        # Snapshot: the engine mutates its messages list after the call.
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        if not self.script:
            return message([text("Done.")])
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        if callable(item):
            return item(kwargs)
        return item


class FakeClient:
    def __init__(self, script: list[Any] | None = None) -> None:
        self.messages = FakeMessages(script or [])

    def queue(self, *items: Any) -> None:
        self.messages.script.extend(items)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class AssistantCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        db_path = Path(self.tempdir.name) / "assistant.sqlite"
        conn = connect(db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        conn.close()
        self.service = ReadOnlySpotlightService(db_path, REPO_ROOT)
        self.tools = CollectionTools(self.service)
        self.conn = self.service.connection
        self._seed()
        self.client = FakeClient()
        self.mcp_config = McpConfig(
            database_path=str(db_path), supabase_url=SUPABASE_URL, supabase_jwt_secret=JWT_SECRET,
            authorization_server_url=f"{SUPABASE_URL}/auth/v1",
            # MCP clients must carry client_id; the in-app chat must not need it.
            require_oauth_client=True,
        )
        self.build()

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def build(self, **overrides: Any) -> None:
        values = dict(enabled=True, unlimited_user_ids=frozenset({FOUNDER}), daily_spend_cap_usd=5.0, max_tool_rounds=4)
        values.update(overrides)
        self.config = AssistantConfig(**values)
        server = mcp_app.build_server(
            self.tools, self.mcp_config,
            token_verifier=mcp_app.SupabaseTokenVerifier(mcp_app.validator_for(self.mcp_config)),
        )
        self.assistant = install_assistant(server, self.tools, self.mcp_config, config=self.config, client=self.client)
        app = server.streamable_http_app(streamable_http_path="/mcp", stateless_http=True, json_response=True)
        self.http = TestClient(app)

    # --- seeding -------------------------------------------------------------

    def card(self, card_id: str, name: str, *, number: str = "1", set_name: str = "Surging Sparks") -> None:
        upsert_card(
            self.conn, card_id=card_id, name=name, set_name=set_name, number=number, rarity="Common",
            variant="Raw", language="English", source_provider="scrydex", source_record_id=card_id,
            set_id="ssp", set_ptcgo_code="SSP", set_release_date="2024-11-08", artist="Arita",
            supertype="Pokémon", national_pokedex_numbers=[], image_url=f"https://img.example/{card_id}.png",
            source_payload={"id": card_id},
        )

    def price(self, card_id: str, amount: float) -> None:
        self.conn.execute(
            "INSERT INTO card_price_snapshots (card_id, provider, display_currency_code, default_raw_market_price, "
            "updated_at) VALUES (?, 'scrydex', 'USD', ?, ?)",
            (card_id, amount, utc_now()),
        )

    def holding(self, entry_id: str, owner: str, card_id: str, *, quantity: int = 1, grader=None, grade=None) -> None:
        added = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        self.conn.execute(
            "INSERT INTO deck_entries (id, owner_user_id, identity_key, item_kind, card_id, grader, grade, condition, "
            "quantity, cost_basis_total, cost_basis_currency_code, added_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'near_mint', ?, 0, 'USD', ?, ?)",
            (entry_id, owner, f"{card_id}|{grader or ''}|{grade or ''}", "slab" if grader else "raw", card_id,
             grader, grade, quantity, added, added),
        )

    def _seed(self) -> None:
        self.card("ssp-1", "Pikachu ex", number="238")
        self.card("ssp-2", "Charizard ex", number="2")
        self.card("ssp-3", "Eevee", number="3")
        self.price("ssp-1", 120.0)
        self.price("ssp-2", 8.0)
        self.holding("a1", USER_A, "ssp-1", quantity=1)
        self.holding("a2", USER_A, "ssp-2", quantity=3)
        self.holding("a-slab", USER_A, "ssp-2", quantity=1, grader="PSA", grade="10")
        self.holding("b1", USER_B, "ssp-3", quantity=2)
        self.conn.execute(
            "INSERT INTO collections (id, owner_user_id, name, created_at, hidden) VALUES ('col-b', ?, 'B', ?, 0)",
            (USER_B, utc_now()),
        )
        self.conn.commit()

    # --- helpers -------------------------------------------------------------

    def ask(self, text_value: str = "What is my collection worth?", *, user: str = USER_A, cmid: str | None = None,
            thread_id: str | None = None, context: dict | None = None, **token_kwargs):
        body = {"thread_id": thread_id, "client_message_id": cmid or f"cm-{time.monotonic_ns()}", "text": text_value}
        if context is not None:
            body["context"] = context
        return self.http.post("/api/v1/assistant/messages", json=body, headers=bearer(user, **token_kwargs))

    def count(self, table: str, where: str = "1=1", params: tuple = ()) -> int:
        return int(self.conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", params).fetchone()[0])


class AuthTests(AssistantCase):
    def test_unauthenticated_and_bad_tokens_get_401(self) -> None:
        self.assertEqual(self.http.get("/api/v1/assistant/usage").status_code, 401)
        bad = jwt.encode({"sub": USER_A, "iss": f"{SUPABASE_URL}/auth/v1", "exp": int(time.time()) + 60},
                         "wrong-secret-wrong-secret-wrong-secret", algorithm="HS256")
        response = self.http.get("/api/v1/assistant/usage", headers={"Authorization": f"Bearer {bad}"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": "unauthorized"})
        self.assertEqual(self.http.post("/api/v1/assistant/messages", json={}).status_code, 401)

    def test_app_session_token_without_client_id_is_accepted(self) -> None:
        response = self.http.get("/api/v1/assistant/usage", headers=bearer(USER_A))
        self.assertEqual(response.status_code, 200)
        usage = response.json()
        self.assertEqual(usage["limit"], 3)
        self.assertEqual(usage["used_today"], 0)
        self.assertEqual(usage["remaining_today"], 3)
        self.assertFalse(usage["is_guest"])
        self.assertTrue(usage["resets_at"].endswith("T00:00:00Z"))

    def test_guest_is_allowed_with_guest_limit(self) -> None:
        usage = self.http.get("/api/v1/assistant/usage", headers=bearer(GUEST, anonymous=True)).json()
        self.assertEqual((usage["limit"], usage["is_guest"]), (1, True))
        self.client.queue(message([text("Your collection is empty.")]))
        self.assertEqual(self.ask(user=GUEST, anonymous=True).status_code, 200)

    def test_disabled_returns_503(self) -> None:
        self.build(enabled=False)
        response = self.ask()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"error": "assistant_disabled"})

    def test_enabled_without_key_stays_disabled(self) -> None:
        service = build_assistant_service(self.tools, AssistantConfig(enabled=True, api_key=None))
        self.assertFalse(service.available)

    def test_mcp_endpoint_still_requires_auth(self) -> None:
        self.assertEqual(self.http.post("/mcp", json={}).status_code, 401)


class LimitTests(AssistantCase):
    def test_three_per_day_then_429(self) -> None:
        for _ in range(3):
            self.assertEqual(self.ask().status_code, 200)
        response = self.ask()
        self.assertEqual(response.status_code, 429)
        body = response.json()
        self.assertEqual(body["error"], "daily_limit")
        self.assertEqual((body["usage"]["used_today"], body["usage"]["remaining_today"]), (3, 0))
        self.assertEqual(len(self.client.messages.calls), 3)

    def test_guest_one_per_day(self) -> None:
        self.assertEqual(self.ask(user=GUEST, anonymous=True).status_code, 200)
        self.assertEqual(self.ask(user=GUEST, anonymous=True).status_code, 429)

    def test_allowlist_is_unlimited(self) -> None:
        for _ in range(5):
            response = self.ask(user=FOUNDER)
            self.assertEqual(response.status_code, 200)
        usage = response.json()["usage"]
        self.assertIsNone(usage["limit"])
        self.assertIsNone(usage["remaining_today"])
        self.assertEqual(usage["used_today"], 5)

    def test_unlimited_all_lifts_limit_for_everyone(self) -> None:
        from mcp_server.assistant.config import AssistantConfig

        config = AssistantConfig(unlimited_all=True)
        self.assertIsNone(config.limit_for("anyone", is_guest=False))
        self.assertIsNone(config.limit_for("guest", is_guest=True))
        with mock.patch.dict(os.environ, {"ASSISTANT_UNLIMITED_ALL": "1"}):
            self.assertTrue(AssistantConfig.from_env().unlimited_all)

    def test_failed_turn_is_not_counted(self) -> None:
        self.client.queue(RuntimeError("network down"))
        response = self.ask()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"error": "assistant_failed"})
        self.assertEqual(self.count("assistant_messages"), 0)
        usage = self.http.get("/api/v1/assistant/usage", headers=bearer(USER_A)).json()
        self.assertEqual(usage["used_today"], 0)

    def test_failed_turn_after_tool_round_records_cost_only(self) -> None:
        self.client.queue(message([tool_use("get_portfolio_summary", {})], "tool_use"), RuntimeError("boom"))
        self.assertEqual(self.ask().status_code, 502)
        questions, cost = self.conn.execute(
            "SELECT questions, cost_usd FROM assistant_usage WHERE owner_user_id = ?", (USER_A,)
        ).fetchone()
        self.assertEqual(questions, 0)
        self.assertGreater(cost, 0)

    def test_server_wide_spend_cap(self) -> None:
        day = datetime.now(timezone.utc).date().isoformat()
        self.conn.execute(
            "INSERT INTO assistant_usage (owner_user_id, day, questions, cost_usd) VALUES ('someone', ?, 0, 5.01)",
            (day,),
        )
        self.conn.commit()
        response = self.ask(user=FOUNDER)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"error": "assistant_busy"})
        self.assertEqual(self.client.messages.calls, [])

    def test_refusal_is_polite_and_not_counted(self) -> None:
        self.client.queue(message([], "refusal"))
        response = self.ask("something off-limits")
        self.assertEqual(response.status_code, 200)
        reply = response.json()["message"]
        self.assertEqual((reply["status"], reply["text"]), ("error", REFUSAL_TEXT))
        self.assertEqual(response.json()["usage"]["used_today"], 0)

    def test_max_tokens_without_text(self) -> None:
        self.client.queue(message([thinking()], "max_tokens"))
        reply = self.ask().json()["message"]
        self.assertEqual((reply["status"], reply["text"]), ("error", TOO_LONG_TEXT))

    def test_max_tokens_with_text_keeps_partial_answer(self) -> None:
        self.client.queue(message([text("Your top card is")], "max_tokens"))
        reply = self.ask().json()["message"]
        self.assertEqual(reply["status"], "ok")
        self.assertTrue(reply["text"].startswith("Your top card is"))


class IdempotencyAndThreadTests(AssistantCase):
    def test_same_client_message_id_replays_without_charge(self) -> None:
        self.client.queue(message([text("About $144.")]))
        first = self.ask(cmid="same-1").json()
        second = self.ask(cmid="same-1").json()
        self.assertEqual(first["message"]["id"], second["message"]["id"])
        self.assertEqual(first["user_message"]["id"], second["user_message"]["id"])
        self.assertEqual(first["thread_id"], second["thread_id"])
        self.assertEqual(len(self.client.messages.calls), 1)
        self.assertEqual(second["usage"]["used_today"], 1)
        # Replays still work after the daily limit is hit.
        self.ask()
        self.ask()
        self.assertEqual(self.ask(cmid="same-1").status_code, 200)

    def test_new_thread_title_history_and_listing(self) -> None:
        self.client.queue(message([text("First answer.")]))
        first = self.ask("How much is my Pikachu ex worth right now in the market today please?").json()
        thread_id = first["thread_id"]
        self.assertTrue(thread_id.startswith("thr_"))
        self.assertEqual(first["user_message"]["role"], "user")
        self.assertEqual(first["message"]["role"], "assistant")
        self.client.queue(message([text("Second answer.")]))
        self.ask("And my Charizard?", thread_id=thread_id)
        sent = self.client.messages.calls[-1]["messages"]
        self.assertEqual([m["role"] for m in sent], ["user", "assistant", "user"])
        self.assertEqual(sent[1]["content"], "First answer.")

        listing = self.http.get("/api/v1/assistant/threads", headers=bearer(USER_A)).json()
        self.assertEqual(len(listing["threads"]), 1)
        summary = listing["threads"][0]
        self.assertLessEqual(len(summary["title"]), 60)
        self.assertEqual(summary["last_message_preview"], "Second answer.")
        self.assertIsNone(listing["next_cursor"])

        messages = self.http.get(f"/api/v1/assistant/threads/{thread_id}/messages", headers=bearer(USER_A)).json()
        self.assertEqual([m["text"] for m in messages["messages"]][-1], "Second answer.")
        self.assertEqual(len(messages["messages"]), 4)
        older = self.http.get(
            f"/api/v1/assistant/threads/{thread_id}/messages?before={messages['messages'][2]['id']}",
            headers=bearer(USER_A),
        ).json()
        self.assertEqual([m["id"] for m in older["messages"]], [m["id"] for m in messages["messages"][:2]])

    def test_history_is_capped_and_text_only(self) -> None:
        thread_id = self.ask(user=FOUNDER).json()["thread_id"]
        for _ in range(7):
            self.ask(user=FOUNDER, thread_id=thread_id)
        sent = self.client.messages.calls[-1]["messages"]
        # last 10 stored messages (5 turns) + this question
        self.assertEqual(len(sent), HISTORY_MESSAGES + 1)
        self.assertTrue(all(isinstance(m["content"], str) for m in sent[:-1]))

    def test_thread_pagination(self) -> None:
        for _ in range(3):
            self.ask(user=FOUNDER)
        page = self.http.get("/api/v1/assistant/threads?limit=2", headers=bearer(FOUNDER)).json()
        self.assertEqual(len(page["threads"]), 2)
        rest = self.http.get(
            f"/api/v1/assistant/threads?limit=2&cursor={page['next_cursor']}", headers=bearer(FOUNDER)
        ).json()
        self.assertEqual(len(rest["threads"]), 1)
        self.assertIsNone(rest["next_cursor"])

    def test_delete_thread_and_clear_all(self) -> None:
        first = self.ask(user=FOUNDER).json()["thread_id"]
        self.ask(user=FOUNDER)
        self.ask(user=FOUNDER)
        response = self.http.delete(f"/api/v1/assistant/threads/{first}", headers=bearer(FOUNDER))
        self.assertEqual(response.json(), {"deleted": True})
        self.assertEqual(self.count("assistant_messages", "thread_id = ?", (first,)), 0)
        self.assertEqual(self.http.delete("/api/v1/assistant/threads", headers=bearer(FOUNDER)).json(), {"deleted": 2})
        self.assertEqual(self.count("assistant_threads"), 0)

    def test_invalid_requests(self) -> None:
        cases = [
            {"client_message_id": "x", "text": ""},
            {"client_message_id": "x", "text": "a" * 1001},
            {"text": "hi"},
            {"client_message_id": "x", "text": "hi", "context": {"card_ids": ["c"] * 21}},
            {"client_message_id": "x", "text": "hi", "context": {"source": "feed"}},
        ]
        for body in cases:
            response = self.http.post("/api/v1/assistant/messages", json=body, headers=bearer(USER_A))
            self.assertEqual(response.status_code, 400, body)
            self.assertEqual(response.json()["error"], "invalid_request")


class OwnerScopingTests(AssistantCase):
    def setUp(self) -> None:
        super().setUp()
        self.client.queue(
            message([tool_use("propose_watch_card", {"card_id": "ssp-1"})], "tool_use"),
            message([text("Ready to confirm.")]),
        )
        first = self.ask("Watch Pikachu ex for me").json()
        self.thread_id = first["thread_id"]
        self.action_id = first["message"]["actions"][0]["id"]

    def test_other_user_cannot_read_or_delete_thread(self) -> None:
        b = bearer(USER_B)
        self.assertEqual(self.http.get(f"/api/v1/assistant/threads/{self.thread_id}/messages", headers=b).status_code, 404)
        self.assertEqual(self.http.delete(f"/api/v1/assistant/threads/{self.thread_id}", headers=b).status_code, 404)
        self.assertEqual(self.http.get("/api/v1/assistant/threads", headers=b).json()["threads"], [])
        self.assertEqual(self.http.delete("/api/v1/assistant/threads", headers=b).json(), {"deleted": 0})
        self.assertEqual(self.ask(user=USER_B, thread_id=self.thread_id).status_code, 404)
        self.assertEqual(self.count("assistant_threads", "id = ?", (self.thread_id,)), 1)

    def test_other_user_cannot_confirm_action(self) -> None:
        response = self.http.post(
            f"/api/v1/assistant/actions/{self.action_id}", json={"state": "confirmed"}, headers=bearer(USER_B)
        )
        self.assertEqual(response.status_code, 404)

    def test_action_state_transitions(self) -> None:
        url = f"/api/v1/assistant/actions/{self.action_id}"
        response = self.http.post(url, json={"state": "confirmed"}, headers=bearer(USER_A))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["action"]["state"], "confirmed")
        self.assertEqual(self.http.post(url, json={"state": "confirmed"}, headers=bearer(USER_A)).status_code, 200)
        self.assertEqual(self.http.post(url, json={"state": "dismissed"}, headers=bearer(USER_A)).status_code, 409)
        self.assertEqual(self.http.post(url, json={"state": "done"}, headers=bearer(USER_A)).status_code, 400)
        stored = self.http.get(f"/api/v1/assistant/threads/{self.thread_id}/messages", headers=bearer(USER_A)).json()
        self.assertEqual(stored["messages"][-1]["actions"][0]["state"], "confirmed")

    def test_tools_read_only_the_callers_collection(self) -> None:
        self.client.queue(message([tool_use("get_my_collection", {})], "tool_use"), message([text("ok")]))
        cards = self.ask(user=USER_B).json()["message"]["cards"]
        self.assertEqual({card["card_id"] for card in cards}, {"ssp-3"})


class ToolLoopTests(AssistantCase):
    def test_request_shape(self) -> None:
        self.client.queue(message([text("Hi!")]))
        self.ask()
        call = self.client.messages.calls[0]
        self.assertEqual(call["model"], "claude-haiku-5-5")
        self.assertEqual(call["output_config"], {"effort": "low"})
        self.assertEqual(call["tool_choice"], {"type": "auto"})
        for banned in ("temperature", "top_p", "top_k", "thinking"):
            self.assertNotIn(banned, call)
        self.assertEqual(call["system"][-1]["cache_control"], {"type": "ephemeral"})
        self.assertEqual(call["tools"][-1]["cache_control"], {"type": "ephemeral"})
        names = [tool["name"] for tool in call["tools"]]
        self.assertEqual(len(names), 16)
        self.assertIn("find_top_graded", names)
        self.assertIn("find_new_highs", names)
        self.assertIn("get_my_watchlist", names)
        self.assertTrue({"find_price_lows", "get_market_trends"} <= set(names))
        by_name = {tool["name"]: tool for tool in call["tools"]}
        self.assertIn("good buy", by_name["find_price_lows"]["description"])
        self.assertIn("trending", by_name["get_market_trends"]["description"])
        self.assertTrue(by_name["get_market_trends"].get("strict"))
        self.assertIn("find_price_lows", call["system"][-1]["text"])
        self.assertIn("undervalued", by_name["find_price_lows"]["description"])
        self.assertIn("most recent new high sales", by_name["find_new_highs"]["description"])
        self.assertIn("likely to go up", by_name["get_market_trends"]["description"])
        self.assertFalse(by_name["find_new_highs"].get("strict"))  # carries a CardFilter
        system = call["system"][-1]["text"]
        self.assertIn("find_new_highs", system)
        self.assertIn("Likely to go up", system)
        self.assertIn("get_market_trends", call["system"][-1]["text"])
        self.assertTrue({"propose_add_to_collection", "propose_update_holding", "propose_watch_card"} <= set(names))
        strict = [tool for tool in call["tools"] if tool.get("strict")]
        # The API caps strict schemas at 24 optional params per request.
        optional = sum(len(set(t["input_schema"]["properties"]) - set(t["input_schema"]["required"])) for t in strict)
        self.assertLessEqual(optional, 24)
        self.assertTrue(all(t["name"] in {s["name"] for s in strict} for t in call["tools"] if t["name"].startswith("propose_")))
        for tool in call["tools"]:
            self.assertFalse(tool["input_schema"]["additionalProperties"])

    def test_tool_use_then_final_answer_builds_cards_from_tool_results(self) -> None:
        self.client.queue(
            message([thinking(), tool_use("get_my_collection", {"sort": "value_desc"}, "tu_9")], "tool_use"),
            # Mentions a card no tool returned: must not become a tile.
            message([text("Your top holding is **Pikachu ex**. Also Mewtwo GX is cool.")]),
        )
        body = self.ask().json()
        reply = body["message"]
        self.assertEqual(reply["status"], "ok")
        second = self.client.messages.calls[1]["messages"]
        assistant_turn = second[-2]
        self.assertEqual(assistant_turn["role"], "assistant")
        self.assertEqual(assistant_turn["content"][0].type, "thinking")  # passed back unchanged
        self.assertEqual(assistant_turn["content"][0].signature, "sig-abc")
        result_block = second[-1]["content"][0]
        self.assertEqual((result_block["type"], result_block["tool_use_id"]), ("tool_result", "tu_9"))
        payload = json.loads(result_block["content"])
        self.assertIn("holding_id", payload["items"][0])
        self.assertNotIn("image_small_url", payload["items"][0])
        ids = [card["card_id"] for card in reply["cards"]]
        self.assertIn("ssp-1", ids)
        self.assertNotIn("mewtwo", " ".join(ids).lower())
        tile = next(card for card in reply["cards"] if card["card_id"] == "ssp-1")
        self.assertEqual(tile["price_usd"], 120.0)
        self.assertEqual(tile["quantity_owned"], 1)
        self.assertTrue(tile["image_small_url"])
        self.assertTrue(tile["app_url"].startswith("spotlight://cards/"))
        stored = self.conn.execute(
            "SELECT tools_used, input_tokens, output_tokens, cost_usd FROM assistant_messages WHERE id = ?",
            (reply["id"],),
        ).fetchone()
        self.assertEqual(json.loads(stored["tools_used"]), ["get_my_collection"])
        self.assertEqual((stored["input_tokens"], stored["output_tokens"]), (2000, 200))
        self.assertGreater(stored["cost_usd"], 0)

    def test_parallel_tool_calls_return_in_one_user_message(self) -> None:
        self.client.queue(
            message([tool_use("get_card", {"card_id": "ssp-1"}, "a"), tool_use("get_card", {"card_id": "nope"}, "b")],
                    "tool_use"),
            message([text("ok")]),
        )
        self.ask()
        results = self.client.messages.calls[1]["messages"][-1]["content"]
        self.assertEqual([r["tool_use_id"] for r in results], ["a", "b"])
        self.assertNotIn("is_error", results[0])
        self.assertTrue(results[1]["is_error"])

    def test_max_rounds_forces_final_answer(self) -> None:
        self.build(max_tool_rounds=2)
        self.client.queue(
            message([tool_use("list_facets", {}, "r1")], "tool_use"),
            message([tool_use("list_facets", {}, "r2")], "tool_use"),
            message([text("Here's what I found.")]),
        )
        reply = self.ask().json()["message"]
        self.assertEqual(reply["text"], "Here's what I found.")
        calls = self.client.messages.calls
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[-1]["tool_choice"], {"type": "none"})

    def test_cards_capped_and_deduped(self) -> None:
        for index in range(20):
            self.card(f"x-{index}", f"Pikachu Promo {index}", number=str(index))
        self.conn.commit()
        self.client.queue(
            message([tool_use("search_cards", {"filter": {"text": "pikachu"}, "limit": 20}, "s1"),
                     tool_use("get_card", {"card_id": "ssp-1"}, "s2")], "tool_use"),
            message([text("Lots of Pikachu.")]),
        )
        cards = self.ask(user=FOUNDER).json()["message"]["cards"]
        self.assertLessEqual(len(cards), MAX_CARDS)
        self.assertEqual(cards[0]["card_id"], "ssp-1")  # get_card ranks first
        keys = [(c["card_id"], c["grader"], c["grade"]) for c in cards]
        self.assertEqual(len(keys), len(set(keys)))

    def test_scanner_context_is_resolved_server_side(self) -> None:
        self.client.queue(message([text("Pikachu ex is worth the most.")]))
        response = self.ask("Which is worth the most?", context={"source": "scanner", "card_ids": ["ssp-1", "ssp-2", "nope"]})
        self.assertEqual(response.status_code, 200)
        content = self.client.messages.calls[0]["messages"][-1]["content"]
        self.assertIn("The user is looking at these scanned cards", content[0]["text"])
        self.assertIn("Pikachu ex · Surging Sparks · #238 · $120.00", content[0]["text"])
        self.assertNotIn("nope", content[0]["text"])
        self.assertEqual(content[1]["text"], "Which is worth the most?")

    def test_build_messages_drops_leading_assistant(self) -> None:
        messages = build_messages([{"role": "assistant", "text": "orphan"}, {"role": "user", "text": "q1"},
                                   {"role": "assistant", "text": "a1"}], "q2", None)
        self.assertEqual([m["role"] for m in messages], ["user", "assistant", "user"])

    def test_cost_pricing(self) -> None:
        usage = Usage(input_tokens=1_000_000, output_tokens=1_000_000, cache_read_input_tokens=1_000_000,
                      cache_creation_input_tokens=1_000_000)
        self.assertAlmostEqual(cost_usd(usage), 0.10 + 0.50 + 0.01 + 0.125)


class ProposeTests(AssistantCase):
    def run_tool(self, name: str, arguments: dict[str, Any], owner: str = USER_A):
        return AssistantToolbox(self.tools).run(name, arguments, owner_user_id=owner)

    def assert_error(self, name: str, arguments: dict[str, Any], owner: str = USER_A) -> str:
        outcome = self.run_tool(name, arguments, owner)
        self.assertTrue(outcome.is_error, outcome.content)
        self.assertIsNone(outcome.action)
        return outcome.content["error"]

    def test_add_validates_and_changes_nothing(self) -> None:
        before = self.count("deck_entries")
        self.assert_error("propose_add_to_collection", {"card_id": "missing"})
        self.assert_error("propose_add_to_collection", {"card_id": "ssp-1", "quantity": 0})
        self.assert_error("propose_add_to_collection", {"card_id": "ssp-1", "condition": "MINT"})
        self.assert_error("propose_add_to_collection", {"card_id": "ssp-1", "grader": "PSA"})
        self.assert_error("propose_add_to_collection", {"card_id": "ssp-1", "collection_id": "col-b"})  # B's
        outcome = self.run_tool("propose_add_to_collection", {"card_id": "ssp-2", "quantity": 2})
        self.assertFalse(outcome.is_error)
        action = outcome.action
        self.assertEqual(action["type"], "add_to_collection")
        self.assertEqual(action["state"], "proposed")
        self.assertTrue(action["id"].startswith("act_"))
        self.assertEqual(action["params"], {"card_id": "ssp-2", "quantity": 2, "condition": "NM", "variant_name": None,
                                            "grader": None, "grade": None, "collection_id": None})
        self.assertEqual(action["summary"], "Add Charizard ex (Surging Sparks 2) · NM · ×2")
        self.assertEqual(outcome.cards[0]["card_id"], "ssp-2")
        slab = self.run_tool("propose_add_to_collection", {"card_id": "ssp-2", "grader": "psa", "grade": "10",
                                                           "condition": "LP"}).action
        self.assertEqual((slab["params"]["grader"], slab["params"]["condition"]), ("PSA", None))
        self.assertIn("PSA 10", slab["summary"])
        self.assertEqual(self.count("deck_entries"), before)

    def test_update_requires_owned_holding(self) -> None:
        self.assert_error("propose_update_holding", {"holding_id": "b1", "quantity": 3})  # B's holding
        self.assert_error("propose_update_holding", {"holding_id": "a1"})
        self.assert_error("propose_update_holding", {"holding_id": "a1", "quantity": 0})
        self.assert_error("propose_update_holding", {"holding_id": "a-slab", "condition": "LP"})
        action = self.run_tool("propose_update_holding", {"holding_id": "a2", "quantity": 4, "condition": "LP"}).action
        self.assertEqual(action["params"], {"holding_id": "a2", "quantity": 4, "condition": "LP"})
        self.assertEqual(action["summary"], "Update Charizard ex (Surging Sparks 2) · ×3 → ×4 · NM → LP")
        quantity = self.conn.execute("SELECT quantity FROM deck_entries WHERE id = 'a2'").fetchone()[0]
        self.assertEqual(quantity, 3)

    def test_watch(self) -> None:
        self.assert_error("propose_watch_card", {"card_id": "ssp-1", "target_price_usd": -5})
        action = self.run_tool("propose_watch_card", {"card_id": "ssp-1", "target_price_usd": 99.999}).action
        self.assertEqual(action["params"], {"card_id": "ssp-1", "variant": None, "target_price_usd": 100.0})
        self.assertEqual(action["summary"], "Add Pikachu ex (Surging Sparks 238) to Watchlist · alert at $100.00 or less")
        self.assertEqual(self.count("card_favorites"), 0)

    def test_watchlist_read_builds_tiles_and_is_owner_scoped(self) -> None:
        self.conn.execute("INSERT INTO card_favorites (owner_user_id, card_id, variant_key, created_at, "
                          "target_price_cents) VALUES (?, 'ssp-1', '', ?, 9900)", (USER_A, utc_now()))
        self.conn.commit()
        outcome = self.run_tool("get_my_watchlist", {})
        self.assertFalse(outcome.is_error, outcome.content)
        self.assertEqual([(i["card_id"], i["target_price_usd"]) for i in outcome.content["items"]], [("ssp-1", 99.0)])
        self.assertNotIn("image_small_url", outcome.content["items"][0])  # stripped for the model
        self.assertEqual([card["card_id"] for card in outcome.cards], ["ssp-1"])
        self.assertTrue(outcome.cards[0]["image_small_url"])
        self.assertEqual(self.run_tool("get_my_watchlist", {}, USER_B).content["items"], [])

    def test_descriptions_steer_quantity_and_watchlist(self) -> None:
        tools = {tool["name"]: tool for tool in TOOL_DEFINITIONS}
        self.assertIn("Always pass quantity", tools["propose_add_to_collection"]["description"])
        self.assertIn("NEW TOTAL", tools["propose_update_holding"]["description"])
        self.assertIn("wishlist", tools["get_my_watchlist"]["description"])
        self.assertIn("at least", tools["find_missing"]["description"])
        self.assertIn("always pass quantity", SYSTEM_PROMPT)
        self.assertIn("get_my_watchlist", SYSTEM_PROMPT)

    def test_refusal_drops_proposals(self) -> None:
        self.client.queue(
            message([tool_use("propose_watch_card", {"card_id": "ssp-1"})], "tool_use"),
            message([], "refusal"),
        )
        self.assertEqual(self.ask().json()["message"]["actions"], [])


class MainBackendContractTests(AssistantCase):
    def test_holding_id_is_user_tier_only(self) -> None:
        items = USER_POLICY.shape(self.tools.get_my_collection(USER_A))["items"]
        self.assertEqual({item["holding_id"] for item in items}, {"a1", "a2", "a-slab"})
        card = USER_POLICY.shape(self.tools.get_card(USER_A, "ssp-2"))
        self.assertEqual({h["holding_id"] for h in card["my_holdings"]}, {"a2", "a-slab"})
        public = PUBLIC_POLICY.shape(self.tools.get_my_collection(USER_A))["items"]
        self.assertTrue(all("holding_id" not in item for item in public))

    def test_account_deletion_clears_assistant_tables(self) -> None:
        self.ask(user=USER_A)
        self.ask(user=USER_B)
        self.conn.execute(
            "INSERT INTO user_ai_settings (owner_user_id, allow_mcp_edits, updated_at) VALUES (?, 1, ?)",
            (USER_A, utc_now()),
        )
        self.conn.commit()
        counts = self.service._delete_account_rows(USER_A)
        for table in ("assistant_threads", "assistant_messages", "assistant_usage", "user_ai_settings"):
            self.assertGreaterEqual(counts[table], 1, table)
            self.assertEqual(self.count(table, "owner_user_id = ?", (USER_A,)), 0, table)
        self.assertEqual(self.count("assistant_messages", "owner_user_id = ?", (USER_B,)), 2)

    def test_create_deck_entry_maps_assistant_selection_source(self) -> None:
        from server import SpotlightScanService

        writable = SpotlightScanService(Path(self.service.database_path), REPO_ROOT)
        identity = RequestIdentity(user_id=USER_A, auth_source="test")
        try:
            with writable.request_identity_context(identity):
                writable._log_scan(  # noqa: SLF001
                    {"scanID": "scan-assist"},
                    {"scanID": "scan-assist", "topCandidates": [], "confidence": "medium", "ambiguityFlags": [],
                     "matcherSource": "remoteHybrid", "matcherVersion": "t", "resolverMode": "raw_card",
                     "resolverPath": "visual_fallback", "reviewDisposition": "ready", "reviewReason": None},
                    [{"candidate": {"id": "ssp-3"}, "finalScore": 0.9, "retrievalScore": 0.8, "rerankScore": 0.8}],
                )
                writable.create_deck_entry(
                    {"cardID": "ssp-3", "sourceScanID": "scan-assist", "selectionSource": "assistant"}
                )
            row = writable.connection.execute(
                "SELECT confirmation_source FROM scan_confirmations WHERE scan_id = 'scan-assist'"
            ).fetchone()
            self.assertEqual(row["confirmation_source"], "add_assistant")
        finally:
            writable.connection.close()


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class SplitSuggestionsTests(unittest.TestCase):
    def test_parses_and_strips_block(self) -> None:
        visible, items = split_suggestions(
            "It's about **$120** raw.\n\n<followups>\nIs it worth grading?\n- Add it to my Watchlist\n"
            '2. "Show its price history"\n</followups>'
        )
        self.assertEqual(visible, "It's about **$120** raw.")
        self.assertEqual(items, ["Is it worth grading?", "Add it to my Watchlist", "Show its price history"])

    def test_absent_block_leaves_text_alone(self) -> None:
        self.assertEqual(split_suggestions("Just an answer."), ("Just an answer.", []))
        # A stray closing tag never shows.
        self.assertEqual(split_suggestions("Answer.</followups>"), ("Answer.", []))

    def test_caps_dedupes_and_drops_bad_lines(self) -> None:
        body = "\n".join([
            "Is it worth grading?", "is it worth grading?", "x" * 41, "<b>bad</b>", "Price in ¥?",
            "", "Compare to PSA 10", "Watch it under $40", "A fourth one",
        ])
        visible, items = split_suggestions(f"Answer.\n<followups>\n{body}\n</followups>")
        self.assertEqual(visible, "Answer.")
        self.assertEqual(items, ["Is it worth grading?", "Compare to PSA 10", "Watch it under $40"])

    def test_json_list_inside_block_and_malformed_json(self) -> None:
        self.assertEqual(
            split_suggestions('Ok.\n<followups>["Is it worth grading?", 3, "Add to Watchlist"]</followups>'),
            ("Ok.", ["Is it worth grading?", "Add to Watchlist"]),
        )
        self.assertEqual(split_suggestions('Ok.\n<followups>["broken</followups>'), ("Ok.", []))
        self.assertEqual(split_suggestions('Ok.\n<followups>{"a": 1}</followups>'), ("Ok.", []))

    def test_unclosed_block(self) -> None:
        # Finished but forgot the closing tag: keep the chips.
        self.assertEqual(split_suggestions("Ok.\n<FollowUps>\nIs it worth grading?"), ("Ok.", ["Is it worth grading?"]))
        # Cut off by max_tokens: the last line may be half a prompt, so drop all.
        self.assertEqual(split_suggestions("Ok.\n<followups>\nIs it worth gr", "max_tokens"), ("Ok.", []))

    def test_code_fenced_block_and_text_after_block_stay_hidden(self) -> None:
        visible, items = split_suggestions("Ok.\n```\n<followups>\nWhat's trending?\n</followups>\n```\nextra")
        self.assertEqual((visible, items), ("Ok.", ["What's trending?"]))


class SuggestionTurnTests(AssistantCase):
    REPLY = "**$120** raw.\n<followups>\nIs it worth grading?\nAdd it to my Watchlist\n</followups>"

    def test_suggestions_on_reply_persisted_and_listed(self) -> None:
        self.client.queue(message([thinking(), text(self.REPLY)]))
        body = self.ask("What's my Pikachu ex worth?", cmid="sugg-1").json()
        reply = body["message"]
        self.assertEqual(reply["text"], "**$120** raw.")
        self.assertEqual(reply["suggestions"], ["Is it worth grading?", "Add it to my Watchlist"])
        self.assertEqual(body["user_message"]["suggestions"], [])
        stored = self.conn.execute(
            "SELECT text, suggestions_json FROM assistant_messages WHERE id = ?", (reply["id"],)
        ).fetchone()
        self.assertEqual(stored["text"], "**$120** raw.")
        self.assertEqual(json.loads(stored["suggestions_json"]), reply["suggestions"])

        listed = self.http.get(
            f"/api/v1/assistant/threads/{body['thread_id']}/messages", headers=bearer(USER_A)
        ).json()["messages"]
        self.assertEqual([m["suggestions"] for m in listed], [[], reply["suggestions"]])
        preview = self.http.get("/api/v1/assistant/threads", headers=bearer(USER_A)).json()["threads"][0]
        self.assertEqual(preview["last_message_preview"], "**$120** raw.")
        # Idempotent replay returns the same chips without a second call.
        again = self.ask("What's my Pikachu ex worth?", cmid="sugg-1").json()["message"]
        self.assertEqual(again["suggestions"], reply["suggestions"])
        self.assertEqual(len(self.client.messages.calls), 1)

    def test_history_sent_to_model_has_no_followups_block(self) -> None:
        self.client.queue(message([text(self.REPLY)]))
        thread_id = self.ask().json()["thread_id"]
        self.ask("Is it worth grading?", thread_id=thread_id)
        sent = self.client.messages.calls[-1]["messages"]
        self.assertEqual(sent[1], {"role": "assistant", "content": "**$120** raw."})

    def test_absent_and_malformed_blocks_give_empty_list(self) -> None:
        self.client.queue(message([text("Plain answer.")]))
        self.assertEqual(self.ask().json()["message"]["suggestions"], [])
        self.client.queue(message([text("Answer.\n<followups>\n" + "y" * 80 + "\n</followups>")]))
        reply = self.ask().json()["message"]
        self.assertEqual((reply["text"], reply["suggestions"]), ("Answer.", []))

    def test_block_only_reply_is_an_error_without_suggestions(self) -> None:
        self.client.queue(message([text("<followups>\nWhat's trending?\n</followups>")]))
        reply = self.ask().json()["message"]
        self.assertEqual((reply["status"], reply["text"], reply["suggestions"]), ("error", EMPTY_TEXT, []))

    def test_refusal_and_truncation_have_no_suggestions(self) -> None:
        self.client.queue(message([text("<followups>\nHi\n</followups>")], "refusal"))
        self.assertEqual(self.ask().json()["message"]["suggestions"], [])
        self.client.queue(message([text("Your top card is\n<followups>\nIs it wor")], "max_tokens"))
        reply = self.ask().json()["message"]
        self.assertEqual((reply["text"], reply["suggestions"]), ("Your top card is…", []))

    def test_schema_patch_adds_column_to_old_table_idempotently(self) -> None:
        import sqlite3

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE assistant_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,"
            " role TEXT NOT NULL, text TEXT NOT NULL, cards_json TEXT, actions_json TEXT,"
            " status TEXT NOT NULL DEFAULT 'ok', client_message_id TEXT, input_tokens INTEGER, output_tokens INTEGER,"
            " cost_usd REAL, tools_used TEXT, created_at TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO assistant_messages (id, thread_id, owner_user_id, role, text, created_at)"
            " VALUES ('m-old', 't', 'u', 'assistant', 'old reply', '2026-11-17T00:00:00Z')"
        )
        ensure_schema(conn)
        ensure_schema(conn)
        columns = [row[1] for row in conn.execute("PRAGMA table_info(assistant_messages)")]
        self.assertEqual(columns.count("suggestions_json"), 1)
        self.assertEqual(columns.count("tool_calls_json"), 1)
        old = message_payload(conn.execute("SELECT * FROM assistant_messages").fetchone())
        self.assertEqual(old["suggestions"], [])
        conn.execute("UPDATE assistant_messages SET suggestions_json = 'not json'")
        self.assertEqual(message_payload(conn.execute("SELECT * FROM assistant_messages").fetchone())["suggestions"], [])
        conn.close()
        self.assertIn("suggestions_json", (BACKEND_ROOT / "schema.sql").read_text())
        self.assertIn("tool_calls_json", (BACKEND_ROOT / "schema.sql").read_text())

    def test_system_prompt_keeps_safety_rules_and_asks_for_followups(self) -> None:
        for rule in (
            "Never show yen",
            "Never invent a card, price",
            "Use the tools for every fact",
            'Watchlist" (never "wishlist")',
            "don't predict or promise gains",
            "find_price_lows",
            "get_market_trends",
            "call a propose_* tool",
            "never invent others",
            "<followups>",
            "under 40 characters",
        ):
            self.assertIn(rule, SYSTEM_PROMPT)
        self.assertNotIn("Wishlist", SYSTEM_PROMPT)
        # Nothing volatile in the cached prefix.
        self.assertNotRegex(SYSTEM_PROMPT, r"20\d\d-\d\d-\d\d")


class ProvenanceTests(AssistantCase):
    """Prior answers carry what was looked up, so the model never disowns them."""

    def first_turn(self) -> str:
        self.client.queue(
            message([tool_use("get_card", {"card_id": "ssp-1"}, "p1"),
                     tool_use("get_price_history", {"card_id": "ssp-1", "range": "90d"}, "p2")], "tool_use"),
            message([text("Pikachu ex is **$120** raw.")]),
        )
        return self.ask("What's my Pikachu ex worth?").json()["thread_id"]

    def test_prior_answer_gets_provenance_note_after_reload_from_db(self) -> None:
        thread_id = self.first_turn()
        stored = self.conn.execute(
            "SELECT tool_calls_json FROM assistant_messages WHERE role = 'assistant' AND thread_id = ?", (thread_id,)
        ).fetchone()
        self.assertEqual(json.loads(stored["tool_calls_json"]),
                         ["get_card(card_id=ssp-1)", "get_price_history(card_id=ssp-1, range=90d)"])
        self.build()  # fresh service + engine: history comes only from the DB
        self.client.queue(message([text("Still $120.")]))
        self.ask("Is that a good price?", thread_id=thread_id)
        sent = self.client.messages.calls[-1]["messages"]
        self.assertEqual([m["role"] for m in sent], ["user", "assistant", "user"])
        prior = sent[1]["content"]
        self.assertTrue(prior.startswith("Pikachu ex is **$120** raw.\n\n[Looked up with: "))
        self.assertIn("get_card(card_id=ssp-1); get_price_history(card_id=ssp-1, range=90d)", prior)
        self.assertIn("Cards shown: Pikachu ex Surging Sparks #238 [ssp-1]", prior)
        self.assertTrue(prior.endswith("]"))
        # The note is model-only: the app never sees it.
        listed = self.http.get(f"/api/v1/assistant/threads/{thread_id}/messages", headers=bearer(USER_A)).json()
        self.assertEqual(listed["messages"][1]["text"], "Pikachu ex is **$120** raw.")

    def test_rows_without_tool_calls_fall_back_to_tool_names(self) -> None:
        thread_id = self.first_turn()
        self.conn.execute("UPDATE assistant_messages SET tool_calls_json = NULL WHERE thread_id = ?", (thread_id,))
        self.conn.commit()
        self.client.queue(message([text("ok")]))
        self.ask("And graded?", thread_id=thread_id)
        prior = self.client.messages.calls[-1]["messages"][1]["content"]
        self.assertIn("[Looked up with: get_card; get_price_history.", prior)

    def test_answer_without_tools_gets_no_note(self) -> None:
        self.client.queue(message([text("PSA 10 is gem mint.")]))
        thread_id = self.ask("What is a PSA 10?").json()["thread_id"]
        self.ask("And a 9?", thread_id=thread_id)
        self.assertEqual(self.client.messages.calls[-1]["messages"][1]["content"], "PSA 10 is gem mint.")

    def test_echoed_note_is_stripped_from_new_answers(self) -> None:
        self.client.queue(message([text("It's $120.\n[Looked up with: get_card(card_id=ssp-1)]")]))
        self.assertEqual(self.ask().json()["message"]["text"], "It's $120.")

    def test_summarize_flattens_filters_and_skips_paging(self) -> None:
        call = summarize_tool_call(
            "search_cards", {"filter": {"text": "kyogre ex", "language": "English", "pokemon": ["Kyogre", "Groudon"]},
                             "sort": "price_desc", "limit": 10, "cursor": "abc"})
        self.assertEqual(call, "search_cards(text=kyogre ex, language=English, pokemon=Kyogre|Groudon, sort=price_desc)")
        self.assertLessEqual(len(summarize_tool_call("search_cards", {"text": "x" * 500, "set": "y" * 500})), 160)
        self.assertIsNone(provenance_note([], [{"card_id": "ssp-1", "name": "Pikachu ex"}]))
        note = provenance_note(["get_card(card_id=a)"] * 3, [{"card_id": "a", "name": "A", "grader": "PSA", "grade": "10"}])
        self.assertEqual(note, "[Looked up with: get_card(card_id=a). Cards shown: A PSA 10 [a]]")

    def test_system_prompt_has_coherence_rules(self) -> None:
        for rule in (
            "based on tool results you can no longer see",
            "Trust your earlier answers",
            "Never correct, retract, or disown an earlier answer unless the user says it's wrong or a new tool "
            "result contradicts it",
            "Never write a [Looked up with: ...] note yourself",
            'never mention tools, tool calls, searches or lookups you ran, "this chat"',
            "Only state what the tool results show",
            "Never say a filter or sort was applied",
            "unless the tool input used it",
            "re-query with the right filter",
            "under 50 words",
            "about 90 words",
        ):
            self.assertIn(rule, SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
