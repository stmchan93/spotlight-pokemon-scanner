"""Time the in-app assistant's read tools against a DB, the way chat runs them.

Each case goes through AssistantToolbox.run (the exact chat path: same args
shaping, policy, post-processing). No Anthropic call and no network; the tools
only read (the service runs the same idempotent schema checks as the MCP
process). Run it on the VM to see which tool eats a chat turn's time budget
(the turn deadline is ASSISTANT_TURN_DEADLINE_SECONDS, default 45s):

  backend/.venv/bin/python backend/tools/assistant_tool_timing.py \
      --database-path backend/data/spotlight_scanner.sqlite --user-id <owner id>

--repeat N runs every case N times (first run = cold page cache, best = warm;
for a truly cold first run: sync; echo 3 | sudo tee /proc/sys/vm/drop_caches).
--only find_top_graded limits to cases for one tool. --grading-upside also
times grading_upside on the first three cards a ranking returned.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from mcp_server.assistant.tools import AssistantToolbox  # noqa: E402
from mcp_server.readonly_service import ReadOnlySpotlightService  # noqa: E402
from mcp_server.tools import CollectionTools  # noqa: E402

CASES: list[tuple[str, str, dict]] = [
    ("PSA 10 by name", "find_top_graded", {"filter": {"text": "oshawott", "game": "pokemon"}, "grader": "PSA", "grade": "10"}),
    ("PSA 10 by name (popular)", "find_top_graded", {"filter": {"text": "charizard"}, "grader": "PSA", "grade": "10"}),
    ("top graded, whole game", "find_top_graded", {"filter": {"game": "pokemon"}}),
    ("PSA 10, whole game", "find_top_graded", {"filter": {"game": "pokemon"}, "grader": "PSA", "grade": "10"}),
    ("search by name", "search_cards", {"filter": {"text": "oshawott"}}),
    ("search priciest by name", "search_cards", {"filter": {"text": "charizard"}, "sort": "price_desc"}),
    ("search priciest set", "search_cards", {"filter": {"set": "Base"}, "sort": "price_desc"}),
    ("collection", "get_my_collection", {}),
    ("portfolio summary", "get_portfolio_summary", {}),
    ("my movers down 30d", "find_movers", {"direction": "down", "window": "30d", "owned": "owned"}),
    ("set movers up 30d", "find_movers", {"direction": "up", "window": "30d", "filter": {"set": "Base"}}),
    ("market trends", "get_market_trends", {}),
    ("price lows", "find_price_lows", {}),
]


def _summary(content: object) -> str:
    if not isinstance(content, dict):
        return type(content).__name__
    parts = []
    for key in ("cards", "results", "holdings", "items", "movers"):
        if isinstance(content.get(key), list):
            parts.append(f"{key}={len(content[key])}")
    for key in ("excluded_stale_count", "error", "note"):
        if content.get(key) is not None:
            parts.append(f"{key}={str(content[key])[:60]}")
    return " ".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-path", default=str(BACKEND_ROOT / "data" / "spotlight_scanner.sqlite"))
    parser.add_argument("--user-id", required=True, help="Owner whose collection the tools read.")
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--only", help="Only cases for this tool name.")
    parser.add_argument("--grading-upside", action="store_true",
                        help="Also time grading_upside on the first find_top_graded-by-name hit (or a search hit).")
    parser.add_argument("--json", action="store_true", help="One JSON line per case instead of a table.")
    args = parser.parse_args()

    service = ReadOnlySpotlightService(Path(args.database_path), BACKEND_ROOT.parent)
    toolbox = AssistantToolbox(CollectionTools(service))
    cases = [case for case in CASES if not args.only or case[1] == args.only]
    upside_ids: list[str] = []

    def run_case(label: str, tool: str, arguments: dict) -> None:
        times = []
        outcome = None
        for _ in range(max(1, args.repeat)):
            start = time.perf_counter()
            outcome = toolbox.run(tool, arguments, owner_user_id=args.user_id)
            times.append(time.perf_counter() - start)
        content = getattr(outcome, "content", None)
        if not upside_ids and tool in ("find_top_graded", "search_cards") and isinstance(content, dict):
            items = content.get("cards") or content.get("results") or []
            upside_ids.extend(str(item["card_id"]) for item in items[:3] if isinstance(item, dict) and item.get("card_id"))
        if args.json:
            print(json.dumps({"case": label, "tool": tool, "first_s": round(times[0], 3),
                              "best_s": round(min(times), 3), "summary": _summary(content)}))
        else:
            print(f"{label:<28} {tool:<22} first {times[0]*1000:8.0f} ms  best {min(times)*1000:8.0f} ms  {_summary(content)}")

    for label, tool, arguments in cases:
        run_case(label, tool, arguments)
    if args.grading_upside and upside_ids:
        run_case("grading upside", "grading_upside", {"card_ids": upside_ids})


if __name__ == "__main__":
    main()
