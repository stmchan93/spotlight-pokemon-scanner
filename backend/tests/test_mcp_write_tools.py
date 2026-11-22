"""MCP write tools: the "Let AI assistants edit my collection" gate, owner
scoping, request_id idempotency, the write rate limit, tier exposure, and the
app's /api/v1/me/ai-settings endpoints."""

from __future__ import annotations

import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import user_ai_settings  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from mcp_server.policy import PUBLIC_POLICY, USER_POLICY, WRITE_TOOLS  # noqa: E402
from mcp_server.rate_limit import UserRateLimiter  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402

try:
    import anyio
    from mcp.server.mcpserver.exceptions import ToolError

    from mcp_server import app as mcp_app
    from mcp_server.auth import McpConfig
    from mcp_server.tools import CollectionTools
    from mcp_server.write_tools import (
        EDITS_OFF_MESSAGE,
        CollectionWriteTools,
        WritableSpotlightService,
        WriteToolRunner,
        register_write_tools,
    )

    HAVE_MCP = True
except ImportError:  # pragma: no cover - requirements install `mcp`
    HAVE_MCP = False


def _seed(db_path: Path) -> None:
    conn = connect(db_path)
    apply_schema(conn, BACKEND_ROOT / "schema.sql")
    for card_id, name in (("c-a", "Alakazam"), ("c-b", "Blastoise")):
        upsert_card(conn, card_id=card_id, name=name, set_name="Base Set", number="1", rarity="Rare Holo",
                    variant="Raw", language="English", set_id="base1", set_ptcgo_code="BS",
                    source_payload={"id": card_id})
    for entry_id, owner, card_id in (("e1", "user-a", "c-a"), ("e2", "user-b", "c-b")):
        conn.execute("INSERT INTO deck_entries (id, owner_user_id, identity_key, item_kind, card_id, quantity, "
                     "condition, cost_basis_total, cost_basis_cents, added_at, updated_at) "
                     "VALUES (?, ?, ?, 'raw', ?, 2, 'near_mint', 10.0, 500, ?, ?)",
                     (entry_id, owner, f"raw|{card_id}", card_id, utc_now(), utc_now()))
    conn.commit()
    conn.close()


@unittest.skipUnless(HAVE_MCP, "mcp SDK not installed")
class WriteToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.db_path = Path(self.tempdir.name) / "mcp-write.sqlite"
        _seed(self.db_path)
        self.service = WritableSpotlightService(self.db_path, REPO_ROOT)
        self.addCleanup(lambda: self.service.connection.close())
        self.conn = self.service.connection

    def runner(self, user: str = "user-a", *, per_day: int = 200) -> WriteToolRunner:
        return WriteToolRunner(
            CollectionWriteTools(self.service),
            lambda: RequestIdentity(user_id=user, auth_source="mcp_bearer"),
            policy=USER_POLICY,
            limiter=UserRateLimiter(per_minute=60, per_day=per_day),
        )

    def run_tool(self, runner, method, **kwargs):
        return anyio.run(lambda: runner.run(method, **kwargs))

    def allow(self, user: str = "user-a", enabled: bool = True) -> None:
        user_ai_settings.set_allow_mcp_edits(self.conn, user, enabled)

    def quantity(self, entry_id: str) -> int:
        row = self.conn.execute("SELECT quantity FROM deck_entries WHERE id = ?", (entry_id,)).fetchone()
        return int(row[0]) if row else 0

    def owner_rows(self, owner: str) -> list:
        return self.conn.execute(
            "SELECT card_id, quantity, condition FROM deck_entries WHERE owner_user_id = ? AND quantity > 0 "
            "ORDER BY card_id, condition",
            (owner,),
        ).fetchall()

    def test_toggle_off_refuses_every_write_without_spending_quota(self) -> None:
        runner = self.runner(per_day=1)
        calls = (
            ("add_to_collection", {"card_id": "c-b", "request_id": "req-00000001"}),
            ("update_holding", {"holding_id": "e1", "quantity": 5}),
            ("watch_card", {"card_id": "c-b"}),
        )
        for method, kwargs in calls:
            with self.assertRaises(ToolError) as caught:
                self.run_tool(runner, method, **kwargs)
            self.assertEqual(str(caught.exception), EDITS_OFF_MESSAGE)
        self.allow(enabled=False)  # an explicit off row is still off
        with self.assertRaisesRegex(ToolError, "Let AI assistants edit my collection"):
            self.run_tool(runner, "watch_card", card_id="c-b")
        self.assertEqual(self.quantity("e1"), 2)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM card_favorites").fetchone()[0], 0)
        # Refusals spent nothing: the single daily write still goes through once on.
        self.allow()
        self.run_tool(runner, "watch_card", card_id="c-b")

    def test_toggle_on_writes_through_the_app_service_methods(self) -> None:
        self.allow()
        runner = self.runner()
        with patch.object(self.service, "create_deck_entry", wraps=self.service.create_deck_entry) as create:
            added = self.run_tool(runner, "add_to_collection", card_id="c-b", request_id="req-00000001",
                                  quantity=2, condition="LP")
        self.assertEqual(create.call_args.args[0]["selectionSource"], "assistant")
        self.assertEqual(create.call_args.args[0]["condition"], "lightly_played")
        self.assertEqual((added["card_id"], added["quantity"], added["condition"]), ("c-b", 2, "LP"))
        self.assertIn(("c-b", 2, "lightly_played"), [tuple(r) for r in self.owner_rows("user-a")])

        with patch.object(self.service, "set_deck_entry_quantity",
                          wraps=self.service.set_deck_entry_quantity) as set_quantity:
            updated = self.run_tool(runner, "update_holding", holding_id="e1", quantity=5)
        set_quantity.assert_called_once()
        self.assertEqual((updated["holding_id"], updated["quantity"]), ("e1", 5))
        self.assertEqual(self.quantity("e1"), 5)

        with patch.object(self.service, "set_card_favorite", wraps=self.service.set_card_favorite) as favorite:
            watched = self.run_tool(runner, "watch_card", card_id="c-b", target_price_usd=12.5)
        favorite.assert_called_once()
        self.assertEqual(watched["target_price_usd"], 12.5)
        row = self.conn.execute(
            "SELECT target_price_cents FROM card_favorites WHERE owner_user_id = 'user-a' AND card_id = 'c-b'"
        ).fetchone()
        self.assertEqual(row[0], 1250)

    def test_condition_change_keeps_quantity_and_cost_basis(self) -> None:
        self.allow()
        result = self.run_tool(self.runner(), "update_holding", holding_id="e1", condition="MP")
        self.assertEqual((result["quantity"], result["condition"]), (2, "MP"))
        self.assertEqual([tuple(r) for r in self.owner_rows("user-a")], [("c-a", 2, "moderately_played")])
        cents = self.conn.execute(
            "SELECT cost_basis_cents FROM deck_entries WHERE id = ?", (result["holding_id"],)
        ).fetchone()[0]
        self.assertEqual(cents, 500)

    def test_owner_scoping(self) -> None:
        self.allow("user-a")
        self.allow("user-b")
        runner = self.runner("user-a")
        for kwargs in ({"quantity": 9}, {"condition": "DMG"}):
            with self.assertRaisesRegex(ToolError, "Holding not found"):
                self.run_tool(runner, "update_holding", holding_id="e2", **kwargs)
        self.assertEqual([tuple(r) for r in self.owner_rows("user-b")], [("c-b", 2, "near_mint")])
        # user-b's toggle doesn't let user-a's token write, and vice versa.
        self.allow("user-a", enabled=False)
        with self.assertRaisesRegex(ToolError, "Let AI assistants"):
            self.run_tool(runner, "update_holding", holding_id="e1", quantity=3)
        # Someone else's collection id is refused, not silently re-targeted.
        self.conn.execute("INSERT INTO collections (id, owner_user_id, name, created_at) "
                          "VALUES ('col-b', 'user-b', 'B', ?)", (utc_now(),))
        self.conn.commit()
        self.allow("user-a")
        with self.assertRaisesRegex(ToolError, "Collection not found"):
            self.run_tool(runner, "add_to_collection", card_id="c-a", request_id="req-00000009",
                          collection_id="col-b")

    def test_add_is_idempotent_by_request_id(self) -> None:
        self.allow()
        runner = self.runner()
        first = self.run_tool(runner, "add_to_collection", card_id="c-b", request_id="req-retry-1")
        second = self.run_tool(runner, "add_to_collection", card_id="c-b", request_id="req-retry-1")
        self.assertEqual(first["quantity"], 1)
        self.assertTrue(second["already_done"])
        self.assertEqual(second["holding_id"], first["holding_id"])
        self.assertEqual(self.quantity(first["holding_id"]), 1)
        # A new request_id is a new add.
        third = self.run_tool(runner, "add_to_collection", card_id="c-b", request_id="req-retry-2")
        self.assertEqual(third["quantity"], 2)
        # A failed add releases its claim so the retry can run.
        with self.assertRaisesRegex(ToolError, "No Ekalight card"):
            self.run_tool(runner, "add_to_collection", card_id="missing", request_id="req-retry-3")
        with patch.object(self.service, "create_deck_entry", side_effect=RuntimeError("boom /secret")):
            with self.assertRaises(ToolError) as caught:
                self.run_tool(runner, "add_to_collection", card_id="c-a", request_id="req-retry-4")
        self.assertNotIn("/secret", str(caught.exception))
        retried = self.run_tool(runner, "add_to_collection", card_id="c-a", request_id="req-retry-4")
        self.assertNotIn("already_done", retried)

    def test_quantity_floor_and_no_delete(self) -> None:
        self.allow()
        runner = self.runner()
        with self.assertRaisesRegex(ToolError, "at least 1"):
            self.run_tool(runner, "update_holding", holding_id="e1", quantity=0)
        with self.assertRaisesRegex(ToolError, "quantity, a new condition"):
            self.run_tool(runner, "update_holding", holding_id="e1")
        self.assertEqual(self.quantity("e1"), 2)

    def test_write_rate_limit_is_separate(self) -> None:
        self.allow()
        runner = self.runner(per_day=2)
        self.run_tool(runner, "update_holding", holding_id="e1", quantity=3)
        self.run_tool(runner, "update_holding", holding_id="e1", quantity=4)
        with self.assertRaisesRegex(ToolError, "Daily limit reached \\(2 Ekalight edits per day\\)"):
            self.run_tool(runner, "update_holding", holding_id="e1", quantity=5)
        self.assertEqual(self.quantity("e1"), 4)


@unittest.skipUnless(HAVE_MCP, "mcp SDK not installed")
class WriteToolExposureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.db_path = Path(self.tempdir.name) / "mcp-exposure.sqlite"
        _seed(self.db_path)
        self.service = WritableSpotlightService(self.db_path, REPO_ROOT)
        self.addCleanup(lambda: self.service.connection.close())

    def tool_names(self, tier: str) -> dict:
        config = McpConfig(database_path=str(self.db_path), tier=tier,
                           authorization_server_url="https://example-ref.supabase.co/auth/v1")
        server = mcp_app.build_server(CollectionTools(self.service), config)
        return {tool.name: tool for tool in anyio.run(server.list_tools)}

    def test_public_tier_never_gets_write_tools(self) -> None:
        self.assertFalse(set(WRITE_TOOLS) & set(PUBLIC_POLICY.tools))
        self.assertFalse(set(WRITE_TOOLS) & set(self.tool_names("public")))
        self.assertIsNone(register_write_tools(object(), PUBLIC_POLICY, self.service, lambda: None))

    def test_user_tier_lists_write_tools_as_non_destructive(self) -> None:
        tools = self.tool_names("user")
        for name in WRITE_TOOLS:
            self.assertIn(name, tools)
            if name == "list_collections":  # gated with the writes, but a read
                self.assertTrue(tools[name].annotations.read_only_hint)
                continue
            self.assertFalse(tools[name].annotations.read_only_hint)
            self.assertFalse(tools[name].annotations.destructive_hint)
            self.assertFalse(tools[name].annotations.idempotent_hint)
        self.assertTrue(tools["get_card"].annotations.read_only_hint)


class AiSettingsEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        db_path = Path(self.tempdir.name) / "ai-settings.sqlite"
        conn = connect(db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        conn.close()
        self.service = SpotlightScanService(db_path, REPO_ROOT)
        self.addCleanup(lambda: self.service.connection.close())

    def handler(self, method: str, body: dict | None = None, user: str | None = "user-a"):
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/me/ai-settings"
        handler.service = self.service
        handler._read_json_body = lambda: body  # type: ignore[method-assign]
        handler._require_request_identity = (  # type: ignore[method-assign]
            lambda: RequestIdentity(user_id=user, auth_source="test") if user else None
        )
        handler.writes = []  # type: ignore[attr-defined]
        handler._write_json = lambda status, payload: handler.writes.append((status, payload))  # type: ignore[method-assign]
        getattr(handler, method)()
        return handler.writes

    def test_default_off_then_round_trip_owner_scoped(self) -> None:
        self.assertEqual(self.handler("do_GET"), [(HTTPStatus.OK, {"allow_mcp_edits": False})])
        self.assertEqual(self.handler("do_POST", {"allow_mcp_edits": True}),
                         [(HTTPStatus.OK, {"allow_mcp_edits": True})])
        self.assertEqual(self.handler("do_GET"), [(HTTPStatus.OK, {"allow_mcp_edits": True})])
        self.assertEqual(self.handler("do_GET", user="user-b"), [(HTTPStatus.OK, {"allow_mcp_edits": False})])
        self.assertEqual(self.handler("do_POST", {"allow_mcp_edits": False}),
                         [(HTTPStatus.OK, {"allow_mcp_edits": False})])
        self.assertFalse(user_ai_settings.allow_mcp_edits(self.service.connection, "user-a"))

    def test_rejects_non_boolean_and_unauthenticated(self) -> None:
        self.assertEqual(self.handler("do_POST", {"allow_mcp_edits": "yes"})[0][0], HTTPStatus.BAD_REQUEST)
        self.assertEqual(self.handler("do_POST", {})[0][0], HTTPStatus.BAD_REQUEST)
        self.assertEqual(self.handler("do_GET", user=None), [])
        self.assertEqual(self.handler("do_POST", {"allow_mcp_edits": True}, user=None), [])
        self.assertFalse(user_ai_settings.allow_mcp_edits(self.service.connection, "user-a"))

    def test_account_deletion_covers_ai_tables(self) -> None:
        tables = {table for table, _ in SpotlightScanService._ACCOUNT_DELETION_TABLE_PREDICATES}
        self.assertTrue({"user_ai_settings", "mcp_write_requests"} <= tables)
        user_ai_settings.set_allow_mcp_edits(self.service.connection, "user-a", True)
        user_ai_settings.set_allow_mcp_edits(self.service.connection, "user-b", True)
        self.service.connection.execute(
            "INSERT INTO mcp_write_requests (owner_user_id, request_id, tool, response_json, created_at) "
            "VALUES ('user-a', 'r1', 'add_to_collection', '{}', ?)", (utc_now(),))
        self.service.connection.commit()
        counts = self.service._delete_account_rows("user-a")
        self.assertEqual((counts["user_ai_settings"], counts["mcp_write_requests"]), (1, 1))
        self.assertTrue(user_ai_settings.allow_mcp_edits(self.service.connection, "user-b"))

    def test_schema_sql_ddl_matches_the_contract(self) -> None:
        self.assertIn(user_ai_settings.USER_AI_SETTINGS_DDL, (BACKEND_ROOT / "schema.sql").read_text())


if __name__ == "__main__":
    unittest.main()
