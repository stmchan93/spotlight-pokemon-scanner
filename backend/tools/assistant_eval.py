"""Real-model eval for the in-app assistant ("Ask Ekalight").

Runs the case file (backend/assistant_eval/cases.yaml) through
AssistantService.send against a DB + user id, grades every turn with code
checks (+ an LLM judge unless --no-judge), and prints JSONL, one line per turn:
{case, category, turn, question, reference, status, answer, suggestions, tools,
tool_calls, tool_args, tool_results, tiles, cards, cards_label, charts, actions,
scanner_context, cost_usd, latency_ms, checks, judge, passed}.

Makes REAL Anthropic calls (needs ANTHROPIC_API_KEY). Threads it creates are
deleted at the end unless --keep-threads; usage/spend rows stay (they count
toward the daily cap). Guide: docs/ai-chat-eval-2026-11-19.md.

  backend/.venv/bin/python backend/tools/assistant_eval.py \\
      --database-path backend/data/spotlight_scanner.sqlite --user-id <supabase user id> \\
      [--db-copy] [--case one_piece_priciest_reask] [--category investing] [--no-judge] [--repeat 3] \\
      [--majority] [--repeat-failed 2] \\
      [--out results.jsonl] [--report report.md] [--compare previous.jsonl] [--min-pass 0.8]

--db-copy runs against a temp COPY of the DB. Cases with `fixtures` or
`writes: true` (direct adds) only run with it; without it they are reported as skipped.

--repeat N alone is strict: a case passes only if all N runs pass. --repeat N --majority
passes a case when most of its N runs pass (use an odd N; ties fail); the report shows
the majority pass rate and each case's pass count (e.g. 2/3).

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
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from assistant_eval.calibration import calibrate, export_labels, format_calibration  # noqa: E402
from assistant_eval.cases import DEFAULT_CASES_PATH, load_case_file, select_cases, validate_cases  # noqa: E402
from assistant_eval.fixtures import CaseFixtures, case_needs_db_copy, copy_database  # noqa: E402
from assistant_eval.grading import (  # noqa: E402
    WRITE_TOOLS,
    CheckResult,
    attach_artwork,
    grade_turn,
    judge_check,
    judge_model,
    judge_turn,
)
from assistant_eval.report import (  # noqa: E402
    case_results,
    compare,
    format_compare,
    load_jsonl,
    render_report,
    summarize,
)

MAX_TOOL_RESULT_CHARS = 4000  # text copy for humans; the judge uses the structured `data`
MAX_TOOL_DATA_CHARS = 60000


def _tile(card: dict[str, Any]) -> str:
    parts = [str(card.get(key)) for key in ("name", "set") if card.get(key)]
    if card.get("number"):
        parts.append(f"#{card['number']}")
    if card.get("grader") and card.get("grade"):
        parts.append(f"{card['grader']} {card['grade']}")
    if card.get("variant"):
        parts.append(str(card["variant"]))
    if card.get("language") and str(card["language"]).casefold() != "english":
        parts.append(str(card["language"]))
    if str(card.get("supertype") or "").casefold() == "sealed":
        parts.append("sealed")
    if card.get("game") and card["game"] != "pokemon":
        parts.append(str(card["game"]))
    price = card.get("price_usd")
    parts.append(f"${price:,.2f}" if isinstance(price, (int, float)) else "no price")
    return " · ".join(parts) + f" [{card.get('card_id')}]"


_CARD_KEYS = ("card_id", "name", "set", "number", "language", "price_usd", "variant", "grader", "grade",
              "quantity", "quantity_added", "quantity_owned")


def catalog_meta(conn: Any, card_ids: list[str]) -> dict[str, dict[str, Any]]:
    """game / supertype / language / rarity from the catalog row (sealed ids have no game prefix)."""
    ids = list(dict.fromkeys(str(card_id) for card_id in card_ids if card_id))
    if not ids:
        return {}
    rows = conn.execute(
        f"SELECT id, game, supertype, language, rarity FROM cards WHERE id IN ({','.join('?' for _ in ids)})", ids
    ).fetchall()
    return {
        str(row[0]): {"game": row[1] or "pokemon", "supertype": row[2], "language": row[3], "rarity": row[4]}
        for row in rows
    }


def tile_records(conn: Any, cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    try:
        meta = catalog_meta(conn, [card.get("card_id") for card in cards])
    except Exception:  # noqa: BLE001 - tiles still record without catalog meta
        meta = {}
    out = []
    for card in cards:
        row = {key: card.get(key) for key in _CARD_KEYS}
        extra = meta.get(str(card.get("card_id"))) or {}
        row["game"] = extra.get("game")
        row["supertype"] = extra.get("supertype")
        row["rarity"] = extra.get("rarity")
        row["language"] = row["language"] or extra.get("language")
        out.append(row)
    return out


class ToolRecorder:
    """Wraps AssistantToolbox.run to keep each call's structured args and result
    (for arg/result checks and the judge). Reset per turn."""

    def __init__(self, toolbox: Any) -> None:
        from mcp_server.assistant.engine import summarize_tool_call
        from mcp_server.assistant.tools import strip_for_model
        from mcp_server.assistant.length_guard import is_art_search

        self._is_art_search = is_art_search

        self._original = toolbox.run
        self._conn = getattr(toolbox, "conn", None)
        self._summarize = summarize_tool_call
        self._strip = strip_for_model
        self.calls: list[dict[str, Any]] = []
        toolbox.run = self.run

    def run(self, name: str, arguments: dict[str, Any], *, owner_user_id: str, **kwargs: Any):
        outcome = self._original(name, arguments, owner_user_id=owner_user_id, **kwargs)
        data = self._strip(outcome.content)
        result = json.dumps(data, default=str, ensure_ascii=False, separators=(",", ":"))
        if name == "search_cards" and self._is_art_search(arguments) and self._conn is not None:
            data = attach_artwork(data, self._describe_art)  # judge-only; the model never saw it
        self.calls.append(
            {
                "name": name,
                "arguments": arguments,
                "is_error": bool(outcome.is_error),
                "call": self._summarize(name, arguments),
                "result": result if len(result) <= MAX_TOOL_RESULT_CHARS else result[: MAX_TOOL_RESULT_CHARS - 1] + "…",
                "data": json.loads(json.dumps(data, default=str)) if len(result) <= MAX_TOOL_DATA_CHARS else None,
            }
        )
        return outcome

    def _describe_art(self, card_id: str) -> str | None:
        import art_search

        try:
            return (art_search.get_card_art(self._conn, card_id) or {}).get("alt_text")
        except Exception:  # noqa: BLE001 - no art tables: the judge goes without
            return None

    def take(self) -> list[dict[str, Any]]:
        calls, self.calls = self.calls, []
        return calls


def scanner_info(toolbox: Any, card_ids: list[str]) -> tuple[str | None, list[dict[str, Any]]]:
    """The scanner context line the model sees, plus the tray cards (for named-card checks)."""
    if not card_ids:
        return None, []
    try:
        context = toolbox.scanner_context(card_ids)
        summaries = toolbox.tools._summaries(card_ids)
    except Exception:  # noqa: BLE001 - grading still works off the ids
        return None, []
    cards = [
        {"card_id": card_id, "name": summaries[card_id].get("name"), "price_usd": summaries[card_id].get("price_usd")}
        for card_id in card_ids if card_id in summaries
    ]
    return context, cards


async def run_case(
    assistant: Any, caller: Any, recorder: ToolRecorder, case: dict[str, Any], repeat: int,
) -> tuple[list[dict[str, Any]], str | None]:
    thread_id = None
    records: list[dict[str, Any]] = []
    body: dict[str, Any] | None = None
    for number, turn in enumerate(case["turns"], start=1):
        base = {
            "case": case["id"], "category": case["category"], "holdout": bool(case.get("holdout")),
            "review_label": case.get("review_label"), "repeat": repeat, "turn": number, "question": turn["ask"],
            "context_card_ids": turn.get("card_ids") or [], "rubric": turn.get("rubric"),
            "reference": turn.get("reference"), "retry": bool(turn.get("retry")),
        }
        if not (turn.get("retry") and body is not None):
            body = {
                "thread_id": thread_id, "client_message_id": str(uuid.uuid4()), "text": turn["ask"],
                "capabilities": ["direct_add"],
            }
            if turn.get("card_ids"):
                body["context"] = {"source": "scanner", "card_ids": turn["card_ids"]}
        context, context_cards = await asyncio.to_thread(scanner_info, assistant.toolbox, turn.get("card_ids") or [])
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
        cards = tile_records(assistant.toolbox.conn, reply.get("cards") or [])
        record = {
            **base,
            "status": reply["status"],
            "answer": reply["text"],
            "suggestions": reply.get("suggestions"),
            "scanner_context": context,
            "context_cards": context_cards,
            "tools": json.loads(row["tools_used"] or "[]"),
            "tool_calls": json.loads(row["tool_calls_json"] or "[]"),
            "tool_args": [{k: call[k] for k in ("name", "arguments", "is_error")} for call in calls],
            "tool_results": [{k: call[k] for k in ("name", "call", "is_error", "result", "data")} for call in calls],
            "tiles": [_tile(card) for card in cards],
            "cards": cards,
            "charts": [f"{c.get('name')} {c.get('range')} {len(c.get('points') or [])}pts" for c in charts],
            "chart_series": [
                {"card_id": c.get("card_id"), "name": c.get("name"), "variant": c.get("variant"),
                 "range": c.get("range"), "points": len(c.get("points") or [])}
                for c in charts
            ],
            "actions": [action.get("summary") for action in reply.get("actions") or []],
            "action_details": [
                {key: a.get(key) for key in ("type", "params", "summary", "state")} | (
                    {key: a[key] for key in a if "undo" in key.casefold()}
                )
                for a in reply.get("actions") or []
            ],
            "cost_usd": row["cost_usd"],
            "latency_ms": latency_ms,
        }
        if "cards_label" in reply:  # absent until show_cards lands; tiles_label skips then
            record["cards_label"] = reply.get("cards_label")
        records.append(record)
    return records, thread_id


def state_check_results(case: dict[str, Any], before: dict[str, int], after: dict[str, int],
                        known_tools: frozenset[str] | None) -> list[CheckResult]:
    """Case-level DB checks (whole case, so a retried add must still net exactly +delta)."""
    results = []
    write_tool_known = known_tools is None or any(tool in known_tools for tool in WRITE_TOOLS)
    for spec in (case.get("state_checks") or {}).get("holding_delta") or []:
        card_id, want = spec["card_id"], int(spec["delta"])
        name = f"holding_delta:{card_id}"
        if not write_tool_known:
            results.append(CheckResult(name, True, "add_to_collection_now not in this build", skipped=True))
            continue
        got = after.get(card_id, 0) - before.get(card_id, 0)
        results.append(CheckResult(name, got == want, "" if got == want else f"quantity changed by {got}, expected {want}"))
    return results


def grade_case(
    case: dict[str, Any], records: list[dict[str, Any]], defaults: dict[str, Any], judge_client: Any | None,
    *, known_tools: frozenset[str] | None = None, case_checks: list[CheckResult] | None = None,
) -> None:
    """Adds checks / judge / passed to each turn record in place. case_checks
    (DB state) attach to the last turn."""
    for index, record in enumerate(records):
        turn = case["turns"][record["turn"] - 1]
        checks = grade_turn(record, turn.get("expect"), defaults, known_tools)
        if case_checks and index == len(records) - 1:
            checks += case_checks
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


def skipped_record(case: dict[str, Any], repeat: int, reason: str) -> dict[str, Any]:
    """No `passed` key: the report counts it as not graded."""
    return {"case": case["id"], "category": case["category"], "holdout": bool(case.get("holdout")),
            "review_label": case.get("review_label"), "repeat": repeat, "turn": 1,
            "question": case["turns"][0]["ask"], "status": "skipped", "skip_reason": reason, "answer": "", "cost_usd": 0.0}


def prepare_database(args: argparse.Namespace) -> str | None:
    """--db-copy: point args.database_path at a temp copy; returns the temp dir to remove."""
    if not args.db_copy:
        return None
    temp_dir = tempfile.mkdtemp(prefix="assistant-eval-db-")
    copy = copy_database(args.database_path, Path(temp_dir) / "eval.sqlite")
    print(f"# running against a DB copy: {copy}", file=sys.stderr)
    args.database_path = str(copy)
    return temp_dir


async def run(args: argparse.Namespace, data: dict[str, Any], cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from assistant_eval.cases import assistant_tool_names
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
        effort=env.effort,
        unlimited_user_ids=frozenset({args.user_id}),
        daily_spend_cap_usd=max(env.daily_spend_cap_usd, 1.0),
        api_key=env.api_key,
    )
    service = ReadOnlySpotlightService(Path(args.database_path), BACKEND_ROOT.parent)
    assistant = build_assistant_service(CollectionTools(service), config)
    recorder = ToolRecorder(assistant.toolbox)
    caller = Caller(user_id=args.user_id, is_guest=False)
    known_tools = assistant_tool_names()
    judge_client = None
    if args.judge:
        import anthropic

        judge_client = anthropic.Anthropic(max_retries=2)
    defaults = data.get("defaults") or {}
    out = open(args.out, "w", encoding="utf-8") if args.out else None
    all_records: list[dict[str, Any]] = []
    threads: list[str] = []

    def emit(records: list[dict[str, Any]]) -> None:
        for record in records:
            line = json.dumps(record, ensure_ascii=False, default=str)
            if not args.quiet:
                print(line, flush=True)
            if out:
                out.write(line + "\n")
                out.flush()
        all_records.extend(records)

    async def run_once(case: dict[str, Any], repeat: int, *, majority: bool = False) -> None:
        if case_needs_db_copy(case) and not args.db_copy:
            emit([skipped_record(case, repeat, "needs --db-copy (fixtures or writes)")])
            return
        fixtures = CaseFixtures(args.database_path, args.user_id) if case_needs_db_copy(case) else None
        tracked = [spec["card_id"] for spec in (case.get("state_checks") or {}).get("holding_delta") or []]
        try:
            if fixtures:
                fixtures.apply(case.get("fixtures"))
                if case.get("writes"):
                    fixtures.snapshot_owner_holdings()
            before = {card_id: fixtures.holding_quantity(card_id) for card_id in tracked} if fixtures else {}
            records, thread_id = await run_case(assistant, caller, recorder, case, repeat)
            after = {card_id: fixtures.holding_quantity(card_id) for card_id in tracked} if fixtures else {}
        finally:
            if fixtures:
                fixtures.cleanup()
                fixtures.close()
        if thread_id:
            threads.append(thread_id)
        case_checks = state_check_results(case, before, after, known_tools) if tracked else None
        await asyncio.to_thread(
            grade_case, case, records, defaults, judge_client, known_tools=known_tools, case_checks=case_checks
        )
        if majority:
            for record in records:
                record["majority_retry"] = True
        if args.majority:
            for record in records:
                record["majority"] = True
        emit(records)

    try:
        for case in cases:
            for repeat in range(1, args.repeat + 1):
                await run_once(case, repeat)
        if args.repeat_failed:
            # Noise check: re-run only failing cases; report.case_results then passes a case
            # on a majority of all its attempts and flags mixed outcomes as flaky.
            failing = {case_id for case_id, case in case_results(all_records).items() if case["passed"] is False}
            for case in cases:
                if case["id"] not in failing:
                    continue
                for extra in range(1, args.repeat_failed + 1):
                    await run_once(case, args.repeat + extra, majority=True)
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
    if summary["skipped_cases"]:
        print(f"# not run: {', '.join(summary['skipped_cases'])}", file=sys.stderr)
    if summary["skipped_checks"]:
        print(f"# {summary['skipped_checks']} checks skipped (planned features not in this build)", file=sys.stderr)
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
    parser.add_argument("--db-copy", action="store_true",
                        help="Copy the DB to a temp file first and run there (required for fixture/write cases).")
    parser.add_argument("--keep-db-copy", action="store_true", help="Don't delete the --db-copy file at the end.")
    parser.add_argument("--cases", default=str(DEFAULT_CASES_PATH), help="Case file (.yaml or .json).")
    parser.add_argument("--case", action="append", help="Run only these case ids (repeatable).")
    parser.add_argument("--category", action="append", help="Run only these categories (repeatable).")
    parser.add_argument("--judge", action=argparse.BooleanOptionalAction, default=True,
                        help="LLM judge on rubric turns (default on; --no-judge = code checks only, no judge cost).")
    parser.add_argument("--repeat", type=int, default=1,
                        help="Run each case N times; strict: a case passes only if every repeat passes.")
    parser.add_argument("--majority", action="store_true",
                        help="With --repeat N: a case passes when a majority of its N runs pass (ties fail); "
                             "the report lists per-case pass counts.")
    parser.add_argument("--repeat-failed", type=int, default=0, metavar="N",
                        help="After the run, re-run only failing cases N more times; such a case passes on a "
                             "majority of all its attempts (ties fail) and is flagged flaky when attempts disagree.")
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
            print(json.dumps({"case": case["id"], "label": case.get("review_label"), "category": case["category"],
                              "holdout": bool(case.get("holdout")), "needs_db_copy": case_needs_db_copy(case),
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
    if args.repeat_failed < 0:
        raise SystemExit("--repeat-failed must be >= 0")
    if args.majority and args.repeat < 2:
        raise SystemExit("--majority needs --repeat N with N >= 2 (odd N avoids ties)")
    temp_dir = prepare_database(args)
    try:
        records = asyncio.run(run(args, data, cases))
    finally:
        if temp_dir and not args.keep_db_copy:
            shutil.rmtree(temp_dir, ignore_errors=True)
    raise SystemExit(finish(args, records))


if __name__ == "__main__":
    main()
