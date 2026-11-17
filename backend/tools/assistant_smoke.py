"""Ask the in-app assistant one real question against a local DB.

Makes a real Anthropic API call (costs a fraction of a cent on Haiku 5.5) and
needs ANTHROPIC_API_KEY. Nothing is written except the assistant tables in the
given DB (use a copy if that matters).

  backend/.venv/bin/python backend/tools/assistant_smoke.py \
      --database-path backend/data/spotlight_scanner.sqlite \
      --user-id <supabase user id> "What's my collection worth?"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import uuid
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from mcp_server.assistant import build_assistant_service  # noqa: E402
from mcp_server.assistant.config import AssistantConfig  # noqa: E402
from mcp_server.assistant.service import Caller  # noqa: E402
from mcp_server.readonly_service import ReadOnlySpotlightService  # noqa: E402
from mcp_server.tools import CollectionTools  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("question")
    parser.add_argument("--database-path", default=str(BACKEND_ROOT / "data" / "spotlight_scanner.sqlite"))
    parser.add_argument("--user-id", required=True, help="Owner whose collection the tools read.")
    parser.add_argument("--guest", action="store_true")
    parser.add_argument("--thread-id")
    parser.add_argument("--card-id", action="append", default=[], help="Scanner context card id (repeatable).")
    args = parser.parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ANTHROPIC_API_KEY is not set; this script makes a real API call.")
    logging.basicConfig(level=logging.INFO)
    service = ReadOnlySpotlightService(Path(args.database_path), BACKEND_ROOT.parent)
    config = AssistantConfig.from_env()
    # Smoke runs ignore the flag/limits but keep the env's model and round cap.
    config = AssistantConfig(
        enabled=True,
        model=config.model,
        max_tool_rounds=config.max_tool_rounds,
        max_output_tokens=config.max_output_tokens,
        unlimited_user_ids=frozenset({args.user_id}),
        daily_spend_cap_usd=max(config.daily_spend_cap_usd, 1.0),
        api_key=config.api_key,
    )
    assistant = build_assistant_service(CollectionTools(service), config)
    body = {
        "thread_id": args.thread_id,
        "client_message_id": str(uuid.uuid4()),
        "text": args.question,
        "context": {"source": "scanner" if args.card_id else "home", "card_ids": args.card_id},
    }
    status, payload = asyncio.run(assistant.send(Caller(user_id=args.user_id, is_guest=args.guest), body))
    print(f"HTTP {status}")
    print(json.dumps(payload, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
