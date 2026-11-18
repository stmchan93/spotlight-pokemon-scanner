"""Real-model eval for the in-app assistant: runs single questions and
multi-turn sequences through AssistantService and prints JSONL, one line per
turn: {case, turn, question, status, answer, suggestions, tools, tool_calls,
tiles, cost_usd, latency_ms}.

Makes REAL Anthropic calls (needs ANTHROPIC_API_KEY; a full run is a few
cents on Haiku 5.5). Not run by tests. Threads it creates are deleted at the
end unless --keep-threads; usage/spend rows stay (they count toward the cap).
Use a DB copy if that matters.

  backend/.venv/bin/python backend/tools/assistant_eval.py \\
      --database-path backend/data/spotlight_scanner.sqlite \\
      --user-id <supabase user id> [--case investing] [--out eval.jsonl]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# Each case = one thread; questions run in order (multi-turn when >1).
CASES: dict[str, list[str]] = {
    "one_piece_priciest_reask": [
        "What's the most expensive One Piece card?",
        "What's the most expensive One Piece card?",
    ],
    "pokemon_priciest_singles": [
        "What are the most expensive Pokémon cards?",
        "Show only single cards, not sealed",
    ],
    "grading_then_history": [
        "Is anything I own worth grading?",
        "Show Kyogre-EX's price history",
    ],
    "collection_value": ["What's my collection worth?"],
    "missing_from_set": ["What am I missing from Surging Sparks?"],
    "watchlist": ["What's on my Watchlist and is anything near my target price?"],
    "investing": ["What's a good card to invest in right now?"],
}


def _tile(card: dict[str, Any]) -> str:
    parts = [str(card.get(key)) for key in ("name", "set") if card.get(key)]
    if card.get("number"):
        parts.append(f"#{card['number']}")
    if card.get("grader") and card.get("grade"):
        parts.append(f"{card['grader']} {card['grade']}")
    price = card.get("price_usd")
    parts.append(f"${price:,.2f}" if isinstance(price, (int, float)) else "no price")
    return " · ".join(parts)


async def run_case(assistant: Any, caller: Any, name: str, questions: list[str], emit) -> str | None:
    thread_id = None
    for turn, question in enumerate(questions, start=1):
        started = time.monotonic()
        status, payload = await assistant.send(
            caller, {"thread_id": thread_id, "client_message_id": str(uuid.uuid4()), "text": question}
        )
        latency_ms = int((time.monotonic() - started) * 1000)
        if status != 200:
            emit({"case": name, "turn": turn, "question": question, "http_status": status, "error": payload})
            break
        thread_id = payload["thread_id"]
        reply = payload["message"]
        row = assistant.store.conn.execute(
            "SELECT tools_used, tool_calls_json, cost_usd FROM assistant_messages WHERE id = ?", (reply["id"],)
        ).fetchone()
        emit(
            {
                "case": name,
                "turn": turn,
                "question": question,
                "status": reply["status"],
                "answer": reply["text"],
                "suggestions": reply["suggestions"],
                "tools": json.loads(row["tools_used"] or "[]"),
                "tool_calls": json.loads(row["tool_calls_json"] or "[]"),
                "tiles": [_tile(card) for card in reply["cards"]],
                "actions": [action.get("summary") for action in reply["actions"]],
                "cost_usd": row["cost_usd"],
                "latency_ms": latency_ms,
            }
        )
    return thread_id


async def run(args: argparse.Namespace) -> None:
    from mcp_server.assistant import build_assistant_service
    from mcp_server.assistant.config import AssistantConfig
    from mcp_server.assistant.service import Caller
    from mcp_server.readonly_service import ReadOnlySpotlightService
    from mcp_server.tools import CollectionTools

    env = AssistantConfig.from_env()
    config = AssistantConfig(
        enabled=True,
        model=env.model,
        max_tool_rounds=env.max_tool_rounds,
        max_output_tokens=env.max_output_tokens,
        unlimited_user_ids=frozenset({args.user_id}),
        daily_spend_cap_usd=max(env.daily_spend_cap_usd, 1.0),
        api_key=env.api_key,
    )
    service = ReadOnlySpotlightService(Path(args.database_path), BACKEND_ROOT.parent)
    assistant = build_assistant_service(CollectionTools(service), config)
    caller = Caller(user_id=args.user_id, is_guest=False)
    out = open(args.out, "w", encoding="utf-8") if args.out else None
    total = 0.0

    def emit(record: dict[str, Any]) -> None:
        nonlocal total
        total += float(record.get("cost_usd") or 0.0)
        line = json.dumps(record, ensure_ascii=False)
        print(line, flush=True)
        if out:
            out.write(line + "\n")

    selected = args.case or list(CASES)
    threads: list[str] = []
    try:
        for name in selected:
            thread_id = await run_case(assistant, caller, name, CASES[name], emit)
            if thread_id:
                threads.append(thread_id)
    finally:
        if not args.keep_threads:
            for thread_id in threads:
                assistant.store.delete_thread(args.user_id, thread_id)
        if out:
            out.close()
        print(f"# {len(selected)} cases, total cost ${total:.4f}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-path", default=str(BACKEND_ROOT / "data" / "spotlight_scanner.sqlite"))
    parser.add_argument("--user-id", required=True, help="Owner whose collection the tools read.")
    parser.add_argument("--case", action="append", choices=sorted(CASES), help="Run only these cases (repeatable).")
    parser.add_argument("--out", help="Also write the JSONL here.")
    parser.add_argument("--keep-threads", action="store_true", help="Keep the eval threads in the DB.")
    parser.add_argument("--list", action="store_true", help="Print the cases and exit (no API calls).")
    args = parser.parse_args()
    if args.list:
        for name, questions in CASES.items():
            print(json.dumps({"case": name, "questions": questions}, ensure_ascii=False))
        return
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        raise SystemExit("ANTHROPIC_API_KEY is not set; this eval makes real API calls.")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
