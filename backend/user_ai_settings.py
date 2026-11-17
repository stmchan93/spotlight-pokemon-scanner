"""Per-user AI settings: today only "Let AI assistants edit my collection".

ABSENT ROW = OFF. MCP write tools (Claude/ChatGPT connectors) run only when the
owner's row says allow_mcp_edits = 1. The DDL matches
docs/ai-chat-contracts-2026-11-17.md exactly (the chat backend creates the
same table).
"""

from __future__ import annotations

import sqlite3

from catalog_tools import utc_now

USER_AI_SETTINGS_DDL = """CREATE TABLE IF NOT EXISTS user_ai_settings (
  owner_user_id TEXT PRIMARY KEY, allow_mcp_edits INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);"""

# Idempotency ledger for MCP write tools: a retried call with the same
# request_id returns the stored result instead of writing twice. A row with
# NULL response_json is an in-flight claim.
MCP_WRITE_REQUESTS_DDL = """CREATE TABLE IF NOT EXISTS mcp_write_requests (
  owner_user_id TEXT NOT NULL, request_id TEXT NOT NULL, tool TEXT NOT NULL,
  response_json TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, request_id)
);"""


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.execute(USER_AI_SETTINGS_DDL)
    connection.execute(MCP_WRITE_REQUESTS_DDL)


def allow_mcp_edits(connection: sqlite3.Connection, owner_user_id: str) -> bool:
    row = connection.execute(
        "SELECT allow_mcp_edits FROM user_ai_settings WHERE owner_user_id = ? LIMIT 1",
        (owner_user_id,),
    ).fetchone()
    return bool(row is not None and int(row[0] or 0) == 1)


def set_allow_mcp_edits(connection: sqlite3.Connection, owner_user_id: str, enabled: bool) -> bool:
    connection.execute(
        """
        INSERT INTO user_ai_settings (owner_user_id, allow_mcp_edits, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(owner_user_id) DO UPDATE SET
            allow_mcp_edits = excluded.allow_mcp_edits,
            updated_at = excluded.updated_at
        """,
        (owner_user_id, 1 if enabled else 0, utc_now()),
    )
    connection.commit()
    return enabled
