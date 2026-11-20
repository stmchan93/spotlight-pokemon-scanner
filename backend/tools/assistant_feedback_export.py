"""Export 👍/👎 feedback on in-app assistant answers, newest first.

Default: one JSON line per rated answer, 👎 only:
  {message_id, thread_id, owner_user_id, rating, reason, note, rated_at,
   question, answer, status, tool_calls, tiles, cost_usd}

--as-cases emits eval case stubs (YAML, or JSON with --format json) to paste
into the assistant eval suite (backend/assistant_eval/cases.*): the question
as the turn, empty expectations, and a judge-rubric TODO carrying the user's
reason/note. Read-only; makes no model calls.

  backend/.venv/bin/python backend/tools/assistant_feedback_export.py \\
      --database-path backend/data/spotlight_scanner.sqlite [--include-up] [--limit 100] [--as-cases]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]

REPLY_SUFFIX = ":reply"  # mirrors mcp_server.assistant.store.REPLY_SUFFIX
REASON_LABELS = {
    "wrong": "Wrong info",
    "not_helpful": "Not helpful",
    "too_long": "Too long",
    "wrong_cards": "Wrong cards",
    "other": "Other",
}


def _json_list(raw: Any) -> list[Any]:
    try:
        value = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def _tile(card: dict[str, Any]) -> str:
    parts = [str(card.get(key)) for key in ("name", "set") if card.get(key)]
    if card.get("number"):
        parts.append(f"#{card['number']}")
    if card.get("grader"):
        parts.append(f"{card['grader']} {card.get('grade') or ''}".strip())
    return " · ".join(parts) or str(card.get("card_id") or "?")


def _question(conn: sqlite3.Connection, answer: sqlite3.Row) -> str:
    client_id = str(answer["client_message_id"] or "")
    row = None
    if client_id.endswith(REPLY_SUFFIX):
        row = conn.execute(
            "SELECT text FROM assistant_messages WHERE owner_user_id = ? AND client_message_id = ?",
            (answer["owner_user_id"], client_id[: -len(REPLY_SUFFIX)]),
        ).fetchone()
    if row is None:
        row = conn.execute(
            """
            SELECT text FROM assistant_messages
            WHERE thread_id = ? AND owner_user_id = ? AND role = 'user' AND created_at <= ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1
            """,
            (answer["thread_id"], answer["owner_user_id"], answer["created_at"]),
        ).fetchone()
    return str(row["text"]) if row is not None else ""


def load_feedback(conn: sqlite3.Connection, *, ratings: tuple[str, ...] = ("down",), limit: int = 100) -> list[dict]:
    if conn.row_factory is None:
        conn.row_factory = sqlite3.Row
    marks = ",".join("?" * len(ratings))
    rows = conn.execute(
        f"""
        SELECT f.message_id, f.thread_id, f.owner_user_id, f.rating, f.reason, f.note, f.updated_at,
               m.text, m.status, m.tools_used, m.tool_calls_json, m.cards_json, m.cost_usd,
               m.client_message_id, m.created_at
        FROM assistant_feedback f
        JOIN assistant_messages m ON m.id = f.message_id AND m.owner_user_id = f.owner_user_id
        WHERE f.rating IN ({marks})
        ORDER BY f.updated_at DESC, f.message_id DESC
        LIMIT ?
        """,  # noqa: S608 - placeholders only
        (*ratings, limit),
    ).fetchall()
    items = []
    for row in rows:
        calls = _json_list(row["tool_calls_json"]) or _json_list(row["tools_used"])
        items.append({
            "message_id": row["message_id"],
            "thread_id": row["thread_id"],
            "owner_user_id": row["owner_user_id"],
            "rating": row["rating"],
            "reason": row["reason"],
            "note": row["note"],
            "rated_at": row["updated_at"],
            "question": _question(conn, row),
            "answer": row["text"],
            "status": row["status"],
            "tool_calls": [str(call) for call in calls if isinstance(call, str)],
            "tiles": [_tile(card) for card in _json_list(row["cards_json"]) if isinstance(card, dict)],
            "cost_usd": row["cost_usd"],
        })
    return items


def as_cases(items: list[dict]) -> list[dict]:
    """Eval case stubs: expectations are left for a human to fill in."""
    cases = []
    for item in items:
        complaint = REASON_LABELS.get(item["reason"] or "", "no reason given")
        if item["note"]:
            complaint += f': "{item["note"]}"'
        rated = "👍" if item["rating"] == "up" else "👎"
        cases.append({
            "id": f"feedback_{item['message_id'].removeprefix('msg_')[:12]}",
            "source": f"user feedback {rated} on {item['message_id']} ({item['rated_at']})",
            "turns": [{"question": item["question"]}],
            "expectations": {},
            "judge_rubric": (
                f"TODO: write the rubric. User said {rated} ({complaint}). "
                f"Original answer used: {', '.join(item['tool_calls']) or 'no tools'}."
            ),
        })
    return cases


def _dump_cases(cases: list[dict], fmt: str) -> str:
    if fmt == "yaml":
        try:
            import yaml

            return yaml.safe_dump({"cases": cases}, allow_unicode=True, sort_keys=False, width=100)
        except ImportError:
            print("PyYAML not installed; emitting JSON", file=sys.stderr)
    return json.dumps({"cases": cases}, ensure_ascii=False, indent=2) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-path", default=str(BACKEND_ROOT / "data" / "spotlight_scanner.sqlite"))
    parser.add_argument("--include-up", action="store_true", help="also export 👍 feedback")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--as-cases", action="store_true", help="emit eval case stubs instead of rows")
    parser.add_argument("--format", choices=("yaml", "json"), default="yaml", help="case stub format")
    args = parser.parse_args(argv)

    conn = sqlite3.connect(f"file:{args.database_path}?mode=ro", uri=True)
    try:
        items = load_feedback(conn, ratings=("down", "up") if args.include_up else ("down",), limit=args.limit)
    finally:
        conn.close()
    if args.as_cases:
        sys.stdout.write(_dump_cases(as_cases(items), args.format))
    else:
        for item in items:
            sys.stdout.write(json.dumps(item, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
