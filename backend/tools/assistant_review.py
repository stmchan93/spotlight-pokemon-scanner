#!/usr/bin/env python3
"""Print recent flagged in-app AI chat answers for owner review, plus an
optional random sample of unflagged ones for spot-checks.

Read-only against a SQLite DB holding assistant_messages (flags_json is set
per answer by mcp_server/assistant/flags.py).

  python3 backend/tools/assistant_review.py --db /path/spotlight.sqlite
  python3 backend/tools/assistant_review.py --db DB --since 7d --flag game_mismatch --flag no_results --limit 20
  python3 backend/tools/assistant_review.py --db DB --since 2026-11-18 --sample 5
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

REPLY_SUFFIX = ":reply"
_RELATIVE = re.compile(r"^(\d+)([hd])$")


def parse_since(value: str | None, *, now: datetime | None = None) -> str | None:
    """'24h' / '7d' / ISO date or datetime -> ISO lower bound comparable to created_at."""
    if not value:
        return None
    match = _RELATIVE.match(value.strip().lower())
    if match:
        amount, unit = int(match.group(1)), match.group(2)
        delta = timedelta(hours=amount) if unit == "h" else timedelta(days=amount)
        moment = (now or datetime.now(timezone.utc)) - delta
        return moment.isoformat(timespec="microseconds").replace("+00:00", "Z")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"--since must be like 24h, 7d, or an ISO date: {value!r}") from None
    return value


def _json_list(raw: Any) -> list[Any]:
    try:
        value = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def _turn(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()

    def col(name: str) -> Any:  # columns added later may be missing on old DBs
        return row[name] if name in keys else None

    return {
        "message_id": row["id"],
        "thread_id": row["thread_id"],
        "owner_user_id": row["owner_user_id"],
        "created_at": row["created_at"],
        "status": row["status"],
        "question": row["question"] or "",
        "answer": row["text"] or "",
        "flags": [flag for flag in _json_list(col("flags_json")) if isinstance(flag, str)],
        "tools": _json_list(col("tool_calls_json")) or _json_list(row["tools_used"]),
        "tiles": [
            card.get("card_id")
            for card in _json_list(row["cards_json"])
            if isinstance(card, dict) and card.get("card_id")
        ],
        "charts": len(_json_list(col("charts_json"))),
        "cost_usd": row["cost_usd"],
    }


def fetch_turns(conn: sqlite3.Connection, *, since: str | None = None) -> list[dict[str, Any]]:
    """Assistant answers (newest first) joined to their question by client_message_id."""
    conn.row_factory = sqlite3.Row
    params: list[Any] = []
    where = "a.role = 'assistant'"
    if since:
        where += " AND a.created_at >= ?"
        params.append(since)
    rows = conn.execute(
        f"""
        SELECT a.*, q.text AS question FROM assistant_messages a
        LEFT JOIN assistant_messages q
          ON q.owner_user_id = a.owner_user_id AND q.role = 'user'
         AND a.client_message_id = q.client_message_id || '{REPLY_SUFFIX}'
        WHERE {where}
        ORDER BY a.created_at DESC, a.rowid DESC
        """,  # noqa: S608 - static fragments only
        params,
    ).fetchall()
    return [_turn(row) for row in rows]


def select_turns(
    turns: list[dict[str, Any]],
    *,
    flags: list[str] | None = None,
    limit: int = 50,
    sample: int = 0,
    seed: int | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(flagged turns matching any of `flags`, up to `limit`; random unflagged sample)."""
    wanted = set(flags or [])
    flagged = [turn for turn in turns if turn["flags"] and (not wanted or wanted & set(turn["flags"]))]
    unflagged = [turn for turn in turns if not turn["flags"]]
    picked = random.Random(seed).sample(unflagged, min(sample, len(unflagged))) if sample > 0 else []
    return flagged[:limit], picked


def format_turn(turn: dict[str, Any]) -> str:
    cost = turn["cost_usd"]
    lines = [
        f"--- {turn['created_at']}  thread={turn['thread_id']}  message={turn['message_id']}  status={turn['status']}",
        f"flags:  {', '.join(turn['flags']) or '(none)'}",
        f"Q:      {turn['question']}",
        f"A:      {turn['answer']}",
        f"tools:  {'; '.join(str(tool) for tool in turn['tools']) or '-'}",
        f"tiles:  {', '.join(str(tile) for tile in turn['tiles']) or '-'}" + (f"  (+{turn['charts']} chart)" if turn["charts"] else ""),
        f"cost:   {'-' if cost is None else f'${float(cost):.4f}'}",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", required=True, help="SQLite DB with assistant_messages")
    parser.add_argument("--since", help="24h, 7d, or ISO date/datetime (UTC)")
    parser.add_argument("--flag", action="append", default=[], help="only these flag codes (repeatable or comma list)")
    parser.add_argument("--limit", type=int, default=50, help="max flagged answers to print (default 50)")
    parser.add_argument("--sample", type=int, default=0, help="also print N random unflagged answers")
    parser.add_argument("--seed", type=int, help="random seed for --sample")
    args = parser.parse_args(argv)
    try:
        since = parse_since(args.since)
    except ValueError as error:
        parser.error(str(error))
    flags = [code.strip() for value in args.flag for code in value.split(",") if code.strip()]

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        turns = fetch_turns(conn, since=since)
    finally:
        conn.close()
    flagged, sampled = select_turns(turns, flags=flags, limit=max(0, args.limit), sample=args.sample, seed=args.seed)

    counts: dict[str, int] = {}
    for turn in turns:
        for code in turn["flags"]:
            counts[code] = counts.get(code, 0) + 1
    total_flagged = sum(1 for turn in turns if turn["flags"])
    print(f"{len(turns)} answers, {total_flagged} flagged" + (f" since {since}" if since else ""))
    for code, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        print(f"  {code}: {count}")
    print(f"\n=== Flagged ({len(flagged)} shown) ===")
    for turn in flagged:
        print(format_turn(turn))
    if args.sample:
        print(f"\n=== Unflagged sample ({len(sampled)}) ===")
        for turn in sampled:
            print(format_turn(turn))
    return 0


if __name__ == "__main__":
    sys.exit(main())
