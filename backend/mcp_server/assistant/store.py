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

import user_ai_settings

from mcp_server.assistant.shared_answers import SCHEMA_SQL as SHARED_ANSWERS_SCHEMA_SQL

# Mirrors backend/schema.sql (the main server creates them from there).
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS assistant_threads (
    id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, title TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, game TEXT
);
CREATE INDEX IF NOT EXISTS idx_assistant_threads_owner ON assistant_threads(owner_user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS assistant_messages (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
    role TEXT NOT NULL, text TEXT NOT NULL, cards_json TEXT, actions_json TEXT,
    status TEXT NOT NULL DEFAULT 'ok', client_message_id TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, tools_used TEXT,
    created_at TEXT NOT NULL, suggestions_json TEXT, tool_calls_json TEXT, charts_json TEXT,
    flags_json TEXT, cards_label TEXT, cards_view_all_json TEXT,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, cached INTEGER, sets_json TEXT, choice_json TEXT
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

# 👍/👎 on assistant answers, one row per message (null rating = row deleted).
FEEDBACK_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS assistant_feedback (
    message_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    rating TEXT NOT NULL, reason TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_feedback_owner ON assistant_feedback(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_feedback_rating ON assistant_feedback(rating, updated_at DESC);
"""
FEEDBACK_RATINGS = ("up", "down")
FEEDBACK_REASONS = ("wrong", "not_helpful", "too_long", "wrong_cards", "other")
FEEDBACK_NOTE_CHARS = 500

# The assistant reply reuses the question's client_message_id with this suffix,
# so a retried request finds both halves of the turn.
REPLY_SUFFIX = ":reply"
HISTORY_MESSAGES = 10
TITLE_CHARS = 60
PREVIEW_CHARS = 120


# Columns added after the tables first shipped: (table, column, SQL type).
COLUMN_PATCHES = (
    ("assistant_messages", "suggestions_json", "TEXT"),
    ("assistant_messages", "tool_calls_json", "TEXT"),
    ("assistant_messages", "charts_json", "TEXT"),
    ("assistant_messages", "flags_json", "TEXT"),
    ("assistant_messages", "cards_label", "TEXT"),
    ("assistant_messages", "cards_view_all_json", "TEXT"),
    # Prompt-cache usage per turn (input_tokens is the whole prompt, these included).
    ("assistant_messages", "cache_read_tokens", "INTEGER"),
    ("assistant_messages", "cache_write_tokens", "INTEGER"),
    ("assistant_messages", "cached", "INTEGER"),
    # Set tiles for set-level answers (market trends); older rows have none.
    ("assistant_messages", "sets_json", "TEXT"),
    # Tap-to-pick printing choice (choice.py); null on ordinary replies.
    ("assistant_messages", "choice_json", "TEXT"),
    # The game this thread last named or ranked (game_scope.py); older threads have none.
    ("assistant_threads", "game", "TEXT"),
)


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA_SQL)
    # Direct adds share the MCP write tools' idempotency ledger.
    user_ai_settings.ensure_schema(connection)
    connection.executescript(FEEDBACK_SCHEMA_SQL)
    connection.executescript(SHARED_ANSWERS_SCHEMA_SQL)
    for table, column, sql_type in COLUMN_PATCHES:
        columns = {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}")
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


def _suggestions(raw: Any) -> list[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _json_list(raw: Any) -> list[Any]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def _charts(raw: Any) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def feedback_payload(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {"rating": row["rating"], "reason": row["reason"], "note": row["note"], "updated_at": row["updated_at"]}


def message_payload(row: sqlite3.Row, feedback: dict[str, Any] | None = None) -> dict[str, Any]:
    """AssistantMessage wire shape."""
    role = str(row["role"])
    keys = row.keys()
    raw_suggestions = row["suggestions_json"] if "suggestions_json" in keys else None
    raw_charts = row["charts_json"] if "charts_json" in keys else None
    raw_sets = row["sets_json"] if "sets_json" in keys else None
    raw_flags = row["flags_json"] if "flags_json" in keys else None
    raw_choice = row["choice_json"] if role == "assistant" and "choice_json" in keys else None
    try:
        choice = json.loads(raw_choice) if raw_choice else None
    except (TypeError, ValueError):
        choice = None
    is_reply = role == "assistant"
    raw_view_all = row["cards_view_all_json"] if is_reply and "cards_view_all_json" in keys else None
    try:
        view_all = json.loads(raw_view_all) if raw_view_all else None
    except (TypeError, ValueError):
        view_all = None
    return {
        "id": row["id"],
        "thread_id": row["thread_id"],
        "role": role,
        "text": row["text"],
        "cards": json.loads(row["cards_json"]) if row["cards_json"] else [],
        # Section header above the tiles, and the "View all N" link (e.g. the Watchlist).
        "cards_label": (row["cards_label"] if "cards_label" in keys else None) if is_reply else None,
        "cards_view_all": view_all if isinstance(view_all, dict) else None,
        "actions": (json.loads(row["actions_json"]) if row["actions_json"] else []) if role == "assistant" else [],
        "suggestions": _suggestions(raw_suggestions) if role == "assistant" else [],
        "charts": _charts(raw_charts) if role == "assistant" else [],
        "sets": _charts(raw_sets) if role == "assistant" else [],
        # Tiles are tap-to-pick printings for an add/update (choice.py); older apps ignore it.
        "choice": choice if isinstance(choice, dict) else None,
        # Review-only quality flags (flags.py); the app doesn't render them.
        "flags": _suggestions(raw_flags) if role == "assistant" else [],
        "created_at": row["created_at"],
        "status": row["status"],
        "feedback": feedback if role == "assistant" else None,
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

    def thread_game(self, owner_user_id: str, thread_id: str) -> str | None:
        row = self.owned_thread(owner_user_id, thread_id)
        return str(row["game"]) if row is not None and "game" in row.keys() and row["game"] else None

    def history(self, owner_user_id: str, thread_id: str) -> list[dict[str, Any]]:
        """Last HISTORY_MESSAGES messages of the thread, oldest first: text plus,
        for assistant rows, the tool calls and tiles behind the answer."""
        rows = self.conn.execute(
            """
            SELECT role, text, tools_used, tool_calls_json, cards_json FROM assistant_messages
            WHERE thread_id = ? AND owner_user_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
            """,
            (thread_id, owner_user_id, HISTORY_MESSAGES),
        ).fetchall()
        history: list[dict[str, Any]] = []
        for row in reversed(rows):
            item: dict[str, Any] = {"role": str(row["role"]), "text": str(row["text"])}
            if item["role"] == "assistant":
                # Rows from before tool_calls_json: bare tool names still beat nothing.
                calls = _json_list(row["tool_calls_json"]) or _json_list(row["tools_used"])
                item["tool_calls"] = [str(call) for call in calls if isinstance(call, str)]
                item["cards"] = [
                    {key: card.get(key) for key in ("card_id", "name", "set", "number", "grader", "grade")}
                    for card in _json_list(row["cards_json"])
                    if isinstance(card, dict) and card.get("card_id")
                ]
            history.append(item)
        return history

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
        feedback = self.feedback_by_message(owner_user_id, [str(row["id"]) for row in rows])
        return [message_payload(row, feedback.get(str(row["id"]))) for row in reversed(rows)]

    def delete_thread(self, owner_user_id: str, thread_id: str) -> bool:
        if self.owned_thread(owner_user_id, thread_id) is None:
            return False
        self.conn.execute(
            "DELETE FROM assistant_feedback WHERE thread_id = ? AND owner_user_id = ?", (thread_id, owner_user_id)
        )
        self.conn.execute(
            "DELETE FROM assistant_messages WHERE thread_id = ? AND owner_user_id = ?", (thread_id, owner_user_id)
        )
        self.conn.execute("DELETE FROM assistant_threads WHERE id = ? AND owner_user_id = ?", (thread_id, owner_user_id))
        self.conn.commit()
        return True

    def delete_all_threads(self, owner_user_id: str) -> int:
        self.conn.execute("DELETE FROM assistant_feedback WHERE owner_user_id = ?", (owner_user_id,))
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
        game: str | None = None,
    ) -> tuple[str, dict[str, Any], dict[str, Any]]:
        """Thread (created if new) + both messages + usage, one transaction. `game` (when
        given) becomes the thread's remembered game."""
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
                                                tools_used, created_at, suggestions_json, tool_calls_json, charts_json,
                                                flags_json, cards_label, cards_view_all_json, cache_read_tokens,
                                                cache_write_tokens, sets_json, choice_json)
                VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    json.dumps(reply.get("suggestions") or []),
                    json.dumps(reply.get("tool_calls") or []),
                    json.dumps(reply.get("charts") or []),
                    json.dumps(reply.get("flags") or []),
                    reply.get("cards_label"),
                    json.dumps(reply["cards_view_all"]) if reply.get("cards_view_all") else None,
                    reply.get("cache_read_tokens"),
                    reply.get("cache_write_tokens"),
                    json.dumps(reply.get("sets") or []),
                    json.dumps(reply["choice"]) if reply.get("choice") else None,
                ),
            )
            conn.execute(
                "UPDATE assistant_threads SET updated_at = ?, game = COALESCE(?, game) WHERE id = ? AND owner_user_id = ?",
                (reply_created, game, thread_id, owner_user_id),
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

    def mark_cached(self, owner_user_id: str, message_id: str) -> None:
        """Flag a reply that replayed a shared answer (no LLM call)."""
        self.conn.execute(
            "UPDATE assistant_messages SET cached = 1 WHERE id = ? AND owner_user_id = ?", (message_id, owner_user_id)
        )
        self.conn.commit()

    # --- actions -------------------------------------------------------------

    def find_action(
        self, owner_user_id: str, action_id: str
    ) -> tuple[str, list[dict[str, Any]], dict[str, Any]] | None:
        """(message id, that message's actions, the action), owner-scoped."""
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
                if action.get("id") == action_id:
                    return str(row["id"]), actions, action
        return None

    def save_actions(self, owner_user_id: str, message_id: str, actions: list[dict[str, Any]]) -> None:
        self.conn.execute(
            "UPDATE assistant_messages SET actions_json = ? WHERE id = ? AND owner_user_id = ?",
            (json.dumps(actions), message_id, owner_user_id),
        )
        self.conn.commit()

    def set_action_state(self, owner_user_id: str, action_id: str, state: str) -> dict[str, Any] | None:
        """Returns the updated action, None when the caller owns no such action.
        Raises ValueError on an invalid transition."""
        found = self.find_action(owner_user_id, action_id)
        if found is None:
            return None
        message_id, actions, action = found
        current = action.get("state")
        if current == state:
            return action
        if current != "proposed":
            raise ValueError(f"action is already {current}")
        action["state"] = state
        self.save_actions(owner_user_id, message_id, actions)
        return action


    # --- feedback ------------------------------------------------------------

    def feedback_by_message(self, owner_user_id: str, message_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not message_ids:
            return {}
        marks = ",".join("?" * len(message_ids))
        rows = self.conn.execute(
            f"SELECT * FROM assistant_feedback WHERE owner_user_id = ? AND message_id IN ({marks})",  # noqa: S608
            (owner_user_id, *message_ids),
        ).fetchall()
        return {str(row["message_id"]): feedback_payload(row) for row in rows}  # type: ignore[misc]

    def feedback_target(self, owner_user_id: str, message_id: str) -> dict[str, Any] | None:
        """The owned message plus the question it answered (for analytics)."""
        row = self.conn.execute(
            "SELECT * FROM assistant_messages WHERE id = ? AND owner_user_id = ?", (message_id, owner_user_id)
        ).fetchone()
        if row is None:
            return None
        question = None
        client_id = str(row["client_message_id"] or "")
        if client_id.endswith(REPLY_SUFFIX):
            question = self.conn.execute(
                "SELECT text FROM assistant_messages WHERE owner_user_id = ? AND client_message_id = ?",
                (owner_user_id, client_id[: -len(REPLY_SUFFIX)]),
            ).fetchone()
        if question is None:
            question = self.conn.execute(
                """
                SELECT text FROM assistant_messages
                WHERE thread_id = ? AND owner_user_id = ? AND role = 'user' AND created_at <= ?
                ORDER BY created_at DESC, rowid DESC LIMIT 1
                """,
                (row["thread_id"], owner_user_id, row["created_at"]),
            ).fetchone()
        return {
            "id": str(row["id"]),
            "thread_id": str(row["thread_id"]),
            "role": str(row["role"]),
            "text": str(row["text"]),
            "question": str(question["text"]) if question is not None else "",
            "tools_used": [str(item) for item in _json_list(row["tools_used"]) if isinstance(item, str)],
            "cost_usd": float(row["cost_usd"]) if row["cost_usd"] is not None else None,
        }

    def set_feedback(
        self, owner_user_id: str, message_id: str, thread_id: str, *, rating: str | None, reason: str | None,
        note: str | None,
    ) -> tuple[dict[str, Any] | None, bool]:
        """Upsert (rating set) or delete (rating None). Returns (stored feedback, changed)."""
        current = feedback_payload(self.conn.execute(
            "SELECT * FROM assistant_feedback WHERE message_id = ? AND owner_user_id = ?", (message_id, owner_user_id)
        ).fetchone())
        if rating is None:
            if current is None:
                return None, False
            self.conn.execute(
                "DELETE FROM assistant_feedback WHERE message_id = ? AND owner_user_id = ?", (message_id, owner_user_id)
            )
            self.conn.commit()
            return None, True
        if current is not None and (current["rating"], current["reason"], current["note"]) == (rating, reason, note):
            return current, False
        stamp = now_iso()
        self.conn.execute(
            """
            INSERT INTO assistant_feedback (message_id, owner_user_id, thread_id, rating, reason, note,
                                            created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET
                rating = excluded.rating, reason = excluded.reason, note = excluded.note,
                updated_at = excluded.updated_at
            WHERE assistant_feedback.owner_user_id = excluded.owner_user_id
            """,
            (message_id, owner_user_id, thread_id, rating, reason, note, stamp, stamp),
        )
        self.conn.commit()
        stored = feedback_payload(self.conn.execute(
            "SELECT * FROM assistant_feedback WHERE message_id = ? AND owner_user_id = ?", (message_id, owner_user_id)
        ).fetchone())
        return stored, True
