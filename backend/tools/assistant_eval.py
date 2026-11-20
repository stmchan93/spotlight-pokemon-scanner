"""Real-model eval for the in-app assistant ("Ask Ekalight").

Runs the case file (backend/assistant_eval/cases.yaml) through
AssistantService.send against a DB + user id, grades every turn with code
checks (+ an LLM judge unless --no-judge), and prints JSONL, one line per turn:
{case, category, turn, question, status, answer, suggestions, tools,
tool_calls, tool_args, tiles, cards, charts, actions, cost_usd, latency_ms,
checks, judge, passed}.

Makes REAL Anthropic calls (needs ANTHROPIC_API_KEY). Threads it creates are
deleted at the end unless --keep-threads; usage/spend rows stay (they count
toward the daily cap). Guide: docs/ai-chat-eval-2026-11-19.md.

  backend/.venv/bin/python backend/tools/assistant_eval.py \\
      --database-path backend/data/spotlight_scanner.sqlite --user-id <supabase user id> \\
      [--case one_piece_priciest_reask] [--category investing] [--no-judge] [--repeat 3] \\
      [--out results.jsonl] [--report report.md] [--compare previous.jsonl] [--min-pass 0.8]

Offline (no API calls): --list, --validate, --from-results old.jsonl (re-render
report/compare/export-labels from a saved run).
Calibration: --export-labels labels.csv after a run; owner fills human_pass;
then --calibrate labels.csv (re-judges with ASSISTANT_EVAL_JUDGE_MODEL).
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

from assistant_eval.calibration import calibrate, export_labels, format_calibration  # noqa: E402
from assistant_eval.cases import DEFAULT_CASES_PATH, load_case_file, select_cases, validate_cases  # noqa: E402
from assistant_eval.grading import grade_turn, judge_check, judge_model, judge_turn  # noqa: E402
from assistant_eval.report import compare, format_compare, load_jsonl, render_report, summarize  # noqa: E402

MAX_TOOL_RESULT_CHARS = 1500


def _tile(card: dict[str, Any]) -> str:
    parts = [str(card.get(key)) for key in ("name", "set") if card.get(key)]
    if card.get("number"):
        parts.append(f"#{card['number']}")
    if card.get("grader") and card.get("grade"):
        parts.append(f"{card['grader']} {card['grade']}")
    price = card.get("price_usd")
    parts.append(f"${price:,.2f}" if isinstance(price, (int, float)) else "no price")
    return " · ".join(parts)


_CARD_KEYS = ("card_id", "name", "set", "number", "language", "price_usd", "variant", "grader", "grade")


class ToolRecorder:
    """Wraps AssistantToolbox.run to keep each call's structured args and a
    compact result (for arg checks and the judge). Reset per turn."""

    def __init__(self, toolbox: Any) -> None:
        from mcp_server.assistant.engine import summarize_tool_call
        from mcp_server.assistant.tools import strip_for_model

        self._original = toolbox.run
        self._summarize = summarize_tool_call
        self._strip = strip_for_model
        self.calls: list[dict[str, Any]] = []
        toolbox.run = self.run

    def run(self, name: str, arguments: dict[str, Any], *, owner_user_id: str):
        outcome = self._original(name, arguments, owner_user_id=owner_user_id)
        result = json.dumps(self._strip(outcome.content), default=str, ensure_ascii=False, separators=(",", ":"))
        self.calls.append(
            {
                "name": name,
                "arguments": arguments,
                "is_error": bool(outcome.is_error),
                "call": self._summarize(name, arguments),
                "result": result if len(result) <= MAX_TOOL_RESULT_CHARS else result[: MAX_TOOL_RESULT_CHARS - 1] + "…",
            }
        )
        return outcome

    def take(self) -> list[dict[str, Any]]:
        calls, self.calls = self.calls, []
        return calls


async def run_case(
    assistant: Any, caller: Any, recorder: ToolRecorder, case: dict[str, Any], repeat: int,
) -> tuple[list[dict[str, Any]], str | None]:
    thread_id = None
    records: list[dict[str, Any]] = []
    for number, turn in enumerate(case["turns"], start=1):
        base = {
            "case": case["id"], "category": case["category"], "holdout": bool(case.get("holdout")),
            "repeat": repeat, "turn": number, "question": turn["ask"],
            "context_card_ids": turn.get("card_ids") or [], "rubric": turn.get("rubric"),
        }
        body: dict[str, Any] = {"thread_id": thread_id, "client_message_id": str(uuid.uuid4()), "text": turn["ask"]}
        if turn.get("card_ids"):
            body["context"] = {"source": "scanner", "card_ids": turn["card_ids"]}
        recorder.take()
        started = time.monotonic()
        status, payload = await assistant.send(caller, body)
        latency_ms = int((time.monotonic() - started) * 1000)
        calls = recorder.take()
        if status != 200:
            records.append({**base, "status": f"http_{status}", "error": payload, "answer": "", "cost_usd": 0.0})
            break
        thread_id = payload["thread_id"]
        reply = payload["message"]
        row = assistant.store.conn.execute(
            "SELECT tools_used, tool_calls_json, cost_usd FROM assistant_messages WHERE id = ?", (reply["id"],)
        ).fetchone()
        charts = reply.get("charts") or []
        records.append(
            {
                **base,
                "status": reply["status"],
                "answer": reply["text"],
                "suggestions": reply["suggestions"],
                "tools": json.loads(row["tools_used"] or "[]"),
                "tool_calls": json.loads(row["tool_calls_json"] or "[]"),
                "tool_args": [{k: call[k] for k in ("name", "arguments", "is_error")} for call in calls],
                "tool_results": [{k: call[k] for k in ("name", "call", "result")} for call in calls],
                "tiles": [_tile(card) for card in reply["cards"]],
                "cards": [{key: card.get(key) for key in _CARD_KEYS} for card in reply["cards"]],
                "charts": [f"{c.get('name')} {c.get('range')} {len(c.get('points') or [])}pts" for c in charts],
                "chart_series": [
                    {"card_id": c.get("card_id"), "name": c.get("name"), "range": c.get("range"), "points": len(c.get("points") or [])}
                    for c in charts
                ],
                "actions": [action.get("summary") for action in reply["actions"]],
                "action_details": [
                    {"type": a.get("type"), "params": a.get("params"), "summary": a.get("summary")} for a in reply["actions"]
                ],
                "cost_usd": row["cost_usd"],
                "latency_ms": latency_ms,
            }
        )
    return records, thread_id


def grade_case(
    case: dict[str, Any], records: list[dict[str, Any]], defaults: dict[str, Any], judge_client: Any | None,
) -> None:
    """Adds checks / judge / passed to each turn record in place."""
    for index, record in enumerate(records):
        turn = case["turns"][record["turn"] - 1]
        checks = grade_turn(record, turn.get("expect"), defaults)
        judge = None
        if judge_client is not None and turn.get("rubric") and record.get("status") == "ok":
            prior = [{"question": r["question"], "answer": r.get("answer"), "tiles": r.get("tiles") or []} for r in records[:index]]
            judge = judge_turn(judge_client, turn["rubric"], record, prior)
            checks.append(judge_check(judge))
        record["checks"] = [check.to_dict() for check in checks]
        record["judge"] = judge.to_dict() if judge else None
        record["passed"] = all(check.passed for check in checks)
    # A case that stopped early (HTTP error) fails on its missing turns too.
    if len(records) < len(case["turns"]) and records:
        records[-1]["passed"] = False


async def run(args: argparse.Namespace, data: dict[str, Any], cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
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
    recorder = ToolRecorder(assistant.toolbox)
    caller = Caller(user_id=args.user_id, is_guest=False)
    judge_client = None
    if args.judge:
        import anthropic

        judge_client = anthropic.Anthropic(max_retries=2)
    defaults = data.get("defaults") or {}
    out = open(args.out, "w", encoding="utf-8") if args.out else None
    all_records: list[dict[str, Any]] = []
    threads: list[str] = []
    try:
        for case in cases:
            for repeat in range(1, args.repeat + 1):
                records, thread_id = await run_case(assistant, caller, recorder, case, repeat)
                if thread_id:
                    threads.append(thread_id)
                await asyncio.to_thread(grade_case, case, records, defaults, judge_client)
                for record in records:
                    line = json.dumps(record, ensure_ascii=False, default=str)
                    if not args.quiet:
                        print(line, flush=True)
                    if out:
                        out.write(line + "\n")
                        out.flush()
                all_records.extend(records)
    finally:
        if not args.keep_threads:
            for thread_id in threads:
                assistant.store.delete_thread(args.user_id, thread_id)
        if out:
            out.close()
    return all_records


def _min_pass(value: str) -> float:
    number = float(value)
    return number / 100 if number > 1 else number


def finish(args: argparse.Namespace, records: list[dict[str, Any]]) -> int:
    diff = compare(load_jsonl(args.compare), records) if args.compare else None
    if args.report:
        Path(args.report).write_text(render_report(records, diff=diff), encoding="utf-8")
    if args.export_labels:
        count = export_labels(records, args.export_labels, args.label_count)
        print(f"# wrote {count} rows to {args.export_labels}; fill human_pass (yes/no), then --calibrate", file=sys.stderr)
    summary = summarize(records)
    print(
        f"# pass {summary['pass_rate']:.0%} ({summary['passed']}/{summary['cases']}); "
        f"dev {summary['dev']['passed']}/{summary['dev']['total']}, holdout {summary['holdout']['passed']}/{summary['holdout']['total']}; "
        f"cost chat ${summary['chat_cost_usd']:.4f} + judge ${summary['judge_cost_usd']:.4f}",
        file=sys.stderr,
    )
    for name, tally in summary["categories"].items():
        print(f"#   {name}: {tally['passed']}/{tally['total']}", file=sys.stderr)
    if summary["flaky"]:
        print(f"# flaky: {', '.join(summary['flaky'])}", file=sys.stderr)
    if diff is not None:
        print("# vs previous: " + format_compare(diff).replace("\n", "\n#   "), file=sys.stderr)
    if summary["cases"] and summary["pass_rate"] < args.min_pass:
        print(f"# FAIL: pass rate {summary['pass_rate']:.0%} < --min-pass {args.min_pass:.0%}", file=sys.stderr)
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-path", default=str(BACKEND_ROOT / "data" / "spotlight_scanner.sqlite"))
    parser.add_argument("--user-id", help="Owner whose collection the tools read (required to run cases).")
    parser.add_argument("--cases", default=str(DEFAULT_CASES_PATH), help="Case file (.yaml or .json).")
    parser.add_argument("--case", action="append", help="Run only these case ids (repeatable).")
    parser.add_argument("--category", action="append", help="Run only these categories (repeatable).")
    parser.add_argument("--judge", action=argparse.BooleanOptionalAction, default=True,
                        help="LLM judge on rubric turns (default on; --no-judge = code checks only, no judge cost).")
    parser.add_argument("--repeat", type=int, default=1, help="Run each case N times; cases that flip are marked flaky.")
    parser.add_argument("--out", help="Write the graded JSONL here.")
    parser.add_argument("--report", help="Write a markdown report here.")
    parser.add_argument("--compare", help="Previous results JSONL: list cases that flipped pass/fail.")
    parser.add_argument("--min-pass", type=_min_pass, default=0.0, help="Exit 1 below this pass rate (0.8 or 80).")
    parser.add_argument("--from-results", help="Grade nothing; load this saved JSONL (for report/compare/export).")
    parser.add_argument("--export-labels", help="Write ~30 answers to this CSV for human pass/fail labels.")
    parser.add_argument("--label-count", type=int, default=30)
    parser.add_argument("--calibrate", help="Labeled CSV from --export-labels: judge-vs-human agreement.")
    parser.add_argument("--keep-threads", action="store_true", help="Keep the eval threads in the DB.")
    parser.add_argument("--quiet", action="store_true", help="Don't print JSONL to stdout.")
    parser.add_argument("--list", action="store_true", help="Print the selected cases and exit (no API calls).")
    parser.add_argument("--validate", action="store_true", help="Validate the case file and exit (no API calls).")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    data = load_case_file(args.cases)
    errors = validate_cases(data)
    if errors:
        raise SystemExit("case file problems:\n  " + "\n  ".join(errors))
    if args.validate:
        print(f"{len(data['cases'])} cases OK")
        return
    try:
        cases = select_cases(data, args.case, args.category)
    except ValueError as error:
        raise SystemExit(str(error))
    if args.list:
        for case in cases:
            print(json.dumps({"case": case["id"], "category": case["category"], "holdout": bool(case.get("holdout")),
                              "questions": [turn["ask"] for turn in case["turns"]]}, ensure_ascii=False))
        return
    if args.from_results:
        raise SystemExit(finish(args, load_jsonl(args.from_results)))
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        raise SystemExit("ANTHROPIC_API_KEY is not set; this eval makes real API calls.")
    if args.calibrate:
        import anthropic

        client = anthropic.Anthropic(max_retries=2)
        model = judge_model()
        result = calibrate(args.calibrate, lambda rubric, record, prior: judge_turn(client, rubric, record, prior, model=model))
        print(format_calibration(result, model))
        return
    if not args.user_id:
        raise SystemExit("--user-id is required to run cases.")
    if args.repeat < 1:
        raise SystemExit("--repeat must be >= 1")
    records = asyncio.run(run(args, data, cases))
    raise SystemExit(finish(args, records))


if __name__ == "__main__":
    main()
