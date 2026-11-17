"""SQLite persistence for assistant threads, messages, usage. Owner-scoped:
every read and write takes `owner_user_id` and filters on it.

Sync code; callers run it in a worker thread (the service's connection is
thread-local)."""

from __future__ import annotations

import base64
import json
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

# Mirrors backend/schema.sql (the main server creates them from there).
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS assistant_threads (
    id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, title TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_threads_owner ON assistant_threads(owner_user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS assistant_messages (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
    role TEXT NOT NULL, text TEXT NOT NULL, cards_json TEXT, actions_json TEXT,
    status TEXT NOT NULL DEFAULT 'ok', client_message_id TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, tools_used TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_thread ON assistant_messages(thread_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_messages_client
    ON assistant_messages(owner_user_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS assistant_usage (
    owner_user_id TEXT NOT NULL, day TEXT NOT NULL, questions INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (owner_user_id, day)
);
CREATE TABLE IF NOT EXISTS user_ai_settings (
    owner_user_id TEXT PRIMARY KEY, allow_mcp_edits INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
"""

# The assistant reply reuses the question's client_message_id with this suffix,
# so a retried request finds both halves of the turn.
REPLY_SUFFIX = ":reply"
HISTORY_MESSAGES = 10
TITLE_CHARS = 60
PREVIEW_CHARS = 120


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA_SQL)
    connection.commit()


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(12)}"


def now_iso() -> str:
    # Microseconds keep a turn's question before its answer.
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def utc_day(moment: datetime | None = None) -> str:
    return (moment or datetime.now(timezone.utc)).date().isoformat()


def next_utc_midnight(moment: datetime | None = None) -> str:
    moment = moment or datetime.now(timezone.utc)
    tomorrow = moment.date() + timedelta(days=1)
    return f"{tomorrow.isoformat()}T00:00:00Z"


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _encode_cursor(payload: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")


def _decode_cursor(cursor: str | None) -> dict[str, Any] | None:
    if not cursor:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except (ValueError, json.JSONDecodeError):
        raise ValueError("cursor is invalid") from None
    if not isinstance(payload, dict):
        raise ValueError("cursor is invalid")
    return payload


def message_payload(row: sqlite3.Row) -> dict[str, Any]:
    """AssistantMessage wire shape."""
    role = str(row["role"])
    return {
        "id": row["id"],
        "thread_id": row["thread_id"],
        "role": role,
        "text": row["text"],
        "cards": json.loads(row["cards_json"]) if row["cards_json"] else [],
        "actions": (json.loads(row["actions_json"]) if row["actions_json"] else []) if role == "assistant" else [],
        "created_at": row["created_at"],
        "status": row["status"],
    }


class AssistantStore:
    def __init__(self, service: Any) -> None:
        self.service = service

    @property
    def conn(self) -> sqlite3.Connection:
        return self.service.connection

    # --- usage ---------------------------------------------------------------

    def usage_row(self, owner_user_id: str, day: str) -> tuple[int, float]:
        row = self.conn.execute(
            "SELECT questions, cost_usd FROM assistant_usage WHERE owner_user_id = ? AND day = ?",
            (owner_user_id, day),
        ).fetchone()
        return (int(row["questions"]), float(row["cost_usd"])) if row else (0, 0.0)

    def spend_today(self, day: str) -> float:
        row = self.conn.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM assistant_usage WHERE day = ?", (day,)).fetchone()
        return float(row[0] or 0.0)

    def _add_usage(self, owner_user_id: str, day: str, *, questions: int, cost: float) -> None:
        self.conn.execute(
            """
            INSERT INTO assistant_usage (owner_user_id, day, questions, cost_usd) VALUES (?, ?, ?, ?)
            ON CONFLICT(owner_user_id, day) DO UPDATE SET
                questions = questions + excluded.questions,
                cost_usd = cost_usd + excluded.cost_usd
            """,
            (owner_user_id, day, questions, cost),
        )

    def record_failed_cost(self, owner_user_id: str, day: str, cost: float) -> None:
        """A failed turn still spent tokens: count them toward the spend cap only."""
        if cost <= 0:
            return
        self._add_usage(owner_user_id, day, questions=0, cost=cost)
        self.conn.commit()

    # --- threads -------------------------------------------------------------

    def owned_thread(self, owner_user_id: str, thread_id: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM assistant_threads WHERE id = ? AND owner_user_id = ?",
            (thread_id, owner_user_id),
        ).fetchone()

    def history(self, owner_user_id: str, thread_id: str) -> list[dict[str, str]]:
        """Last HISTORY_MESSAGES messages of the thread, oldest first, text only."""
        rows = self.conn.execute(
            """
            SELECT role, text FROM assistant_messages
            WHERE thread_id = ? AND owner_user_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
            """,
            (thread_id, owner_user_id, HISTORY_MESSAGES),
        ).fetchall()
        return [{"role": str(row["role"]), "text": str(row["text"])} for row in reversed(rows)]

    def list_threads(self, owner_user_id: str, *, limit: int, cursor: str | None) -> dict[str, Any]:
        position = _decode_cursor(cursor)
        params: list[Any] = [owner_user_id]
        where = "t.owner_user_id = ?"
        if position is not None:
            where += " AND (t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))"
            params += [position.get("u"), position.get("u"), position.get("i")]
        rows = self.conn.execute(
            f"""
            SELECT t.id, t.title, t.updated_at,
                   (SELECT m.text FROM assistant_messages m
                    WHERE m.thread_id = t.id AND m.owner_user_id = t.owner_user_id
                    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_text
            FROM assistant_threads t
            WHERE {where}
            ORDER BY t.updated_at DESC, t.id DESC
            LIMIT ?
            """,  # noqa: S608 - static fragments only
            (*params, limit + 1),
        ).fetchall()
        page = rows[:limit]
        next_cursor = (
            _encode_cursor({"u": page[-1]["updated_at"], "i": page[-1]["id"]}) if len(rows) > limit and page else None
        )
        return {
            "threads": [
                {
                    "id": row["id"],
                    "title": row["title"],
                    "updated_at": row["updated_at"],
                    "last_message_preview": _clip(row["last_text"] or "", PREVIEW_CHARS),
                }
                for row in page
            ],
            "next_cursor": next_cursor,
        }

    def thread_messages(
        self, owner_user_id: str, thread_id: str, *, limit: int, before: str | None
    ) -> list[dict[str, Any]] | None:
        if self.owned_thread(owner_user_id, thread_id) is None:
            return None
        params: list[Any] = [thread_id, owner_user_id]
        where = "thread_id = ? AND owner_user_id = ?"
        if before:
            anchor = self.conn.execute(
                "SELECT created_at, rowid FROM assistant_messages WHERE id = ? AND thread_id = ? AND owner_user_id = ?",
                (before, thread_id, owner_user_id),
            ).fetchone()
            if anchor is None:
                raise ValueError("before is not a message in this thread")
            where += " AND (created_at < ? OR (created_at = ? AND rowid < ?))"
            params += [anchor["created_at"], anchor["created_at"], anchor["rowid"]]
        rows = self.conn.execute(
            f"""
            SELECT * FROM assistant_messages WHERE {where}
            ORDER BY created_at DESC, rowid DESC LIMIT ?
            """,  # noqa: S608 - static fragments only
            (*params, limit),
        ).fetchall()
        return [message_payload(row) for row in reversed(rows)]

    def delete_thread(self, owner_user_id: str, thread_id: str) -> bool:
        if self.owned_thread(owner_user_id, thread_id) is None:
            return False
        self.conn.execute(
            "DELETE FROM assistant_messages WHERE thread_id = ? AND owner_user_id = ?", (thread_id, owner_user_id)
        )
        self.conn.execute("DELETE FROM assistant_threads WHERE id = ? AND owner_user_id = ?", (thread_id, owner_user_id))
        self.conn.commit()
        return True

    def delete_all_threads(self, owner_user_id: str) -> int:
        self.conn.execute("DELETE FROM assistant_messages WHERE owner_user_id = ?", (owner_user_id,))
        cursor = self.conn.execute("DELETE FROM assistant_threads WHERE owner_user_id = ?", (owner_user_id,))
        self.conn.commit()
        return max(0, int(cursor.rowcount or 0))

    # --- turns ---------------------------------------------------------------

    def find_turn(self, owner_user_id: str, client_message_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """(user message, assistant reply) previously stored for this client id."""
        rows = {
            str(row["client_message_id"]): row
            for row in self.conn.execute(
                "SELECT * FROM assistant_messages WHERE owner_user_id = ? AND client_message_id IN (?, ?)",
                (owner_user_id, client_message_id, client_message_id + REPLY_SUFFIX),
            ).fetchall()
        }
        question = rows.get(client_message_id)
        reply = rows.get(client_message_id + REPLY_SUFFIX)
        if question is None or reply is None:
            return None
        return message_payload(question), message_payload(reply)

    def save_turn(
        self,
        owner_user_id: str,
        *,
        thread_id: str | None,
        client_message_id: str,
        question: str,
        reply: dict[str, Any],
        counted: bool,
        day: str,
    ) -> tuple[str, dict[str, Any], dict[str, Any]]:
        """Thread (created if new) + both messages + usage, one transaction."""
        conn = self.conn
        created = now_iso()
        try:
            if thread_id is None:
                thread_id = new_id("thr")
                conn.execute(
                    "INSERT INTO assistant_threads (id, owner_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (thread_id, owner_user_id, _clip(question, TITLE_CHARS), created, created),
                )
            user_id = new_id("msg")
            conn.execute(
                """
                INSERT INTO assistant_messages (id, thread_id, owner_user_id, role, text, status,
                                                client_message_id, created_at)
                VALUES (?, ?, ?, 'user', ?, 'ok', ?, ?)
                """,
                (user_id, thread_id, owner_user_id, question, client_message_id, created),
            )
            # Same-timestamp ties fall back to rowid order in every read.
            reply_created = max(now_iso(), created)
            reply_id = new_id("msg")
            conn.execute(
                """
                INSERT INTO assistant_messages (id, thread_id, owner_user_id, role, text, cards_json, actions_json,
                                                status, client_message_id, input_tokens, output_tokens, cost_usd,
                                                tools_used, created_at)
                VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    reply_id,
                    thread_id,
                    owner_user_id,
                    reply["text"],
                    json.dumps(reply["cards"]),
                    json.dumps(reply["actions"]),
                    reply["status"],
                    client_message_id + REPLY_SUFFIX,
                    reply.get("input_tokens"),
                    reply.get("output_tokens"),
                    reply.get("cost_usd"),
                    json.dumps(reply.get("tools_used") or []),
                    reply_created,
                ),
            )
            conn.execute(
                "UPDATE assistant_threads SET updated_at = ? WHERE id = ? AND owner_user_id = ?",
                (reply_created, thread_id, owner_user_id),
            )
            self._add_usage(owner_user_id, day, questions=1 if counted else 0, cost=float(reply.get("cost_usd") or 0.0))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        rows = conn.execute(
            "SELECT * FROM assistant_messages WHERE id IN (?, ?) AND owner_user_id = ?",
            (user_id, reply_id, owner_user_id),
        ).fetchall()
        by_id = {row["id"]: row for row in rows}
        return thread_id, message_payload(by_id[user_id]), message_payload(by_id[reply_id])

    # --- actions -------------------------------------------------------------

    def set_action_state(self, owner_user_id: str, action_id: str, state: str) -> dict[str, Any] | None:
        """Returns the updated action, None when the caller owns no such action.
        Raises ValueError on an invalid transition."""
        rows = self.conn.execute(
            """
            SELECT id, actions_json FROM assistant_messages
            WHERE owner_user_id = ? AND role = 'assistant' AND actions_json LIKE ?
            """,
            (owner_user_id, f'%"{action_id}"%'),
        ).fetchall()
        for row in rows:
            actions = json.loads(row["actions_json"] or "[]")
            for action in actions:
                if action.get("id") != action_id:
                    continue
                current = action.get("state")
                if current == state:
                    return action
                if current != "proposed":
                    raise ValueError(f"action is already {current}")
                action["state"] = state
                self.conn.execute(
                    "UPDATE assistant_messages SET actions_json = ? WHERE id = ? AND owner_user_id = ?",
                    (json.dumps(actions), row["id"], owner_user_id),
                )
                self.conn.commit()
                return action
        return None
