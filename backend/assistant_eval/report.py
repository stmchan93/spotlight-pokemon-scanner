"""Roll graded turn records up to cases, diff two runs, render report.md."""

from __future__ import annotations

import json
from collections import OrderedDict
from pathlib import Path
from typing import Any


def load_jsonl(path: str | Path) -> list[dict[str, Any]]:
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            rows.append(json.loads(line))
    return rows


def case_results(records: list[dict[str, Any]]) -> "OrderedDict[str, dict[str, Any]]":
    """case id -> {category, holdout, passed, flaky, repeats, turns, chat_cost, judge_cost}.
    A repeat passes only if every turn in it passed; a case passes only if every
    repeat passed (strict --repeat), or, under --majority (records with majority)
    or once --repeat-failed re-ran it (majority_retry), if a majority of its
    attempts passed (ties fail); flaky = attempts disagree; pass_count = "k/N".
    Ungraded rows (old JSONL) -> passed None."""
    cases: OrderedDict[str, dict[str, Any]] = OrderedDict()
    for record in records:
        case = cases.setdefault(
            str(record.get("case")),
            {"category": record.get("category") or "?", "holdout": bool(record.get("holdout")), "graded": True,
             "repeats": OrderedDict(), "turns": [], "chat_cost": 0.0, "judge_cost": 0.0, "majority": False},
        )
        if record.get("majority_retry") or record.get("majority"):
            case["majority"] = True
        case["turns"].append(record)
        case["chat_cost"] += float(record.get("cost_usd") or 0.0)
        case["judge_cost"] += float((record.get("judge") or {}).get("cost_usd") or 0.0)
        repeat = int(record.get("repeat") or 1)
        if "passed" not in record:
            case["graded"] = False
            continue
        case["repeats"][repeat] = case["repeats"].get(repeat, True) and bool(record["passed"])
    for case in cases.values():
        outcomes = list(case["repeats"].values())
        if not case["graded"] or not outcomes:
            case["passed"], case["flaky"] = None, False
        else:
            case["passed"] = sum(outcomes) * 2 > len(outcomes) if case["majority"] else all(outcomes)
            case["flaky"] = len(set(outcomes)) > 1
        case["pass_count"] = f"{sum(outcomes)}/{len(outcomes)}" if case["graded"] and outcomes else None
    return cases


def _rate(cases: list[dict[str, Any]]) -> dict[str, Any]:
    passed = sum(1 for case in cases if case["passed"])
    return {"passed": passed, "total": len(cases), "pass_rate": (passed / len(cases)) if cases else 0.0}


def token_usage(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Prompt-cache totals over turns that recorded usage (older JSONL rows have none)."""
    rows = [r for r in records if isinstance(r.get("input_tokens"), int)]
    total_in = sum(r["input_tokens"] for r in rows)
    read = sum(int(r.get("cache_read_tokens") or 0) for r in rows)
    return {
        "usage_turns": len(rows),
        "cache_hit_ratio": (read / total_in) if total_in else None,
        "cache_read_tokens": read,
        "cache_write_tokens": sum(int(r.get("cache_write_tokens") or 0) for r in rows),
        "avg_input_tokens": (total_in / len(rows)) if rows else None,
        "avg_output_tokens": (sum(int(r.get("output_tokens") or 0) for r in rows) / len(rows)) if rows else None,
    }


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    cases = case_results(records)
    graded = [case for case in cases.values() if case["passed"] is not None]
    categories: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
    for case in graded:
        categories.setdefault(case["category"], []).append(case)
    overall = _rate(graded)
    return {
        "cases": overall["total"],
        "passed": overall["passed"],
        "pass_rate": overall["pass_rate"],
        "dev": _rate([case for case in graded if not case["holdout"]]),
        "holdout": _rate([case for case in graded if case["holdout"]]),
        "categories": {name: _rate(items) for name, items in categories.items()},
        "flaky": [case_id for case_id, case in cases.items() if case["flaky"]],
        "repeats": max((len(case["repeats"]) for case in cases.values()), default=0),
        "majority": any(record.get("majority") for record in records),
        "pass_counts": {case_id: case["pass_count"] for case_id, case in cases.items() if case["pass_count"]},
        "chat_cost_usd": sum(case["chat_cost"] for case in cases.values()),
        "judge_cost_usd": sum(case["judge_cost"] for case in cases.values()),
        **token_usage(records),
        "skipped_cases": [case_id for case_id, case in cases.items()
                          if any(t.get("status") == "skipped" for t in case["turns"])],
        "skipped_checks": sum(1 for r in records for c in r.get("checks") or [] if c.get("skipped")),
    }


def compare(previous: list[dict[str, Any]], current: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Flips between two runs, by case id (only cases graded in both)."""
    before = {case_id: case["passed"] for case_id, case in case_results(previous).items()}
    after = {case_id: case["passed"] for case_id, case in case_results(current).items()}
    both = [case_id for case_id in after if case_id in before and before[case_id] is not None and after[case_id] is not None]
    return {
        "pass_to_fail": [case_id for case_id in both if before[case_id] and not after[case_id]],
        "fail_to_pass": [case_id for case_id in both if not before[case_id] and after[case_id]],
        "new": [case_id for case_id in after if case_id not in before],
        "missing": [case_id for case_id in before if case_id not in after],
    }


def format_compare(diff: dict[str, list[str]]) -> str:
    lines = []
    for key, label in (("pass_to_fail", "pass → FAIL"), ("fail_to_pass", "fail → pass"), ("new", "new"), ("missing", "not run now")):
        if diff[key]:
            lines.append(f"{label} ({len(diff[key])}): {', '.join(diff[key])}")
    return "\n".join(lines) or "no flips vs previous run"


def _quote(text: Any) -> str:
    return "\n".join("> " + line for line in str(text or "").strip().splitlines()) or "> (empty)"


def render_report(records: list[dict[str, Any]], *, diff: dict[str, list[str]] | None = None, title: str = "Ask Ekalight eval") -> str:
    summary = summarize(records)
    dev, holdout = summary["dev"], summary["holdout"]
    lines = [
        f"# {title}",
        "",
        f"**{'Majority pass' if summary['majority'] else 'Pass'} rate: {summary['pass_rate']:.0%}** "
        f"({summary['passed']}/{summary['cases']} cases)",
        "",
        f"- Dev set: {dev['pass_rate']:.0%} ({dev['passed']}/{dev['total']})",
        f"- Holdout set: {holdout['pass_rate']:.0%} ({holdout['passed']}/{holdout['total']}) (never tune prompts against these)",
    ]
    if summary["repeats"] > 1:
        mode = "a majority of runs must pass" if summary["majority"] else "every run must pass"
        lines.append(
            f"- Repeats: {summary['repeats']} per case ({mode}); flaky ({len(summary['flaky'])}): "
            f"{', '.join(summary['flaky']) or 'none'}"
        )
    if summary["skipped_cases"]:
        lines.append(f"- Not run (need --db-copy): {', '.join(summary['skipped_cases'])}")
    if summary["skipped_checks"]:
        lines.append(f"- Checks skipped (planned feature not in this build): {summary['skipped_checks']}")
    lines += [
        f"- Cost: chat ${summary['chat_cost_usd']:.4f} + judge ${summary['judge_cost_usd']:.4f} = "
        f"${summary['chat_cost_usd'] + summary['judge_cost_usd']:.4f}",
    ]
    if summary["cache_hit_ratio"] is not None:
        lines.append(
            f"- Tokens: cache hit {summary['cache_hit_ratio']:.0%} of input; avg {summary['avg_input_tokens']:.0f} in / "
            f"{summary['avg_output_tokens']:.0f} out per turn (cache read {summary['cache_read_tokens']}, "
            f"write {summary['cache_write_tokens']})"
        )
    lines += [
        "",
        "| Category | Passed | Total |",
        "|---|---|---|",
    ]
    for name, tally in summary["categories"].items():
        lines.append(f"| {name} | {tally['passed']} | {tally['total']} |")
    if diff is not None:
        lines += ["", "## Changes vs previous run", "", "```", format_compare(diff), "```"]
    if summary["majority"]:
        lines += ["", "## Per-case passes", "", "| Case | Runs passed |", "|---|---|"]
        lines += [f"| {case_id} | {count} |" for case_id, count in summary["pass_counts"].items()]
    failing = [(case_id, case) for case_id, case in case_results(records).items() if case["passed"] is False]
    lines += ["", f"## Failing cases ({len(failing)})"]
    for case_id, case in failing:
        tags = [case["category"]] + (["holdout"] if case["holdout"] else []) + (["flaky"] if case["flaky"] else [])
        lines += ["", f"### {case_id} ({', '.join(tags)})"]
        failed_repeats = {repeat for repeat, ok in case["repeats"].items() if not ok}
        shown = next(iter(sorted(failed_repeats)), 1)
        for record in case["turns"]:
            if int(record.get("repeat") or 1) != shown:
                continue
            lines += ["", f"**Turn {record.get('turn')}: {record.get('question')}**", "", _quote(record.get("answer"))]
            if record.get("tool_calls"):
                lines += ["", f"Tools: `{'; '.join(record['tool_calls'])}`"]
            if record.get("tiles"):
                label = f" ({record['cards_label']})" if record.get("cards_label") else ""
                lines += ["", f"Tiles{label}: {'; '.join(record['tiles'])}"]
            failed = [check for check in record.get("checks") or [] if not check.get("passed")]
            if failed:
                lines.append("")
                lines += [f"- FAIL `{check['name']}`: {check.get('reason')}" for check in failed]
            judge = record.get("judge")
            if judge:
                verdict = "error" if judge.get("error") else ("pass" if judge.get("passed") else "fail")
                lines.append(
                    f"- judge {verdict} ({judge.get('score')}/{judge.get('total')}): {judge.get('error') or judge.get('reason')}"
                )
    return "\n".join(lines) + "\n"
