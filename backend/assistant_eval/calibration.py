"""Judge calibration: export answers for the owner to label by hand, then
measure how often the (current) judge model agrees with those labels.

export_labels writes labels.csv (owner fills `human_pass` with yes/no) plus a
sidecar labels.records.jsonl holding what the judge needs (rubric, tool
results, earlier turns), so calibrate can re-judge with any judge model."""

from __future__ import annotations

import csv
import json
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

from assistant_eval.grading import JudgeResult, rubric_criteria

CSV_COLUMNS = ["label_id", "case", "category", "turn", "question", "answer", "tiles", "criteria", "human_pass", "human_note"]
_YES = {"yes", "y", "pass", "true", "1", "ok"}
_NO = {"no", "n", "fail", "false", "0"}


def sidecar_path(csv_path: str | Path) -> Path:
    path = Path(csv_path)
    return path.with_name(path.stem + ".records.jsonl")


def _prior_turns(records: list[dict[str, Any]], record: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"question": r.get("question"), "answer": r.get("answer"), "tiles": r.get("tiles") or []}
        for r in records
        if r.get("case") == record.get("case") and (r.get("repeat") or 1) == (record.get("repeat") or 1)
        and int(r.get("turn") or 0) < int(record.get("turn") or 0)
    ]


def pick_label_rows(records: list[dict[str, Any]], count: int = 30) -> list[dict[str, Any]]:
    """Up to `count` judged turns (first repeat only), round-robin across categories
    so every category is represented."""
    by_category: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
    for record in records:
        if (record.get("repeat") or 1) == 1 and rubric_criteria(record.get("rubric")) and record.get("status") == "ok":
            by_category.setdefault(str(record.get("category") or "?"), []).append(record)
    picked: list[dict[str, Any]] = []
    while len(picked) < count and any(by_category.values()):
        for items in by_category.values():
            if items and len(picked) < count:
                picked.append(items.pop(0))
    return picked


def export_labels(records: list[dict[str, Any]], csv_path: str | Path, count: int = 30) -> int:
    rows = pick_label_rows(records, count)
    csv_path = Path(csv_path)
    with csv_path.open("w", newline="", encoding="utf-8") as handle, sidecar_path(csv_path).open("w", encoding="utf-8") as side:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for number, record in enumerate(rows, start=1):
            label_id = f"L{number:03d}"
            criteria = rubric_criteria(record.get("rubric"))
            writer.writerow(
                {
                    "label_id": label_id,
                    "case": record.get("case"),
                    "category": record.get("category"),
                    "turn": record.get("turn"),
                    "question": record.get("question"),
                    "answer": record.get("answer"),
                    "tiles": "; ".join((record.get("tiles") or [])[:8]),
                    "criteria": " | ".join(criteria),
                    "human_pass": "",
                    "human_note": "",
                }
            )
            side.write(
                json.dumps(
                    {"label_id": label_id, "rubric": criteria, "record": record, "prior_turns": _prior_turns(records, record)},
                    ensure_ascii=False,
                )
                + "\n"
            )
    return len(rows)


def parse_human(value: Any) -> bool | None:
    text = str(value or "").strip().casefold()
    if text in _YES:
        return True
    if text in _NO:
        return False
    return None


def calibrate(
    csv_path: str | Path,
    judge: Callable[[list[str], dict[str, Any], list[dict[str, Any]]], JudgeResult],
) -> dict[str, Any]:
    """Re-judge every labeled row with `judge` and compare to the human label."""
    sidecar = {}
    for line in sidecar_path(csv_path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            item = json.loads(line)
            sidecar[item["label_id"]] = item
    with Path(csv_path).open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    categories: OrderedDict[str, list[int]] = OrderedDict()
    disagreements: list[dict[str, Any]] = []
    errors: list[str] = []
    agree = labeled = 0
    cost = 0.0
    for row in rows:
        human = parse_human(row.get("human_pass"))
        item = sidecar.get(row.get("label_id"))
        if human is None or item is None:
            continue
        result = judge(item["rubric"], item["record"], item.get("prior_turns") or [])
        cost += result.cost_usd
        if result.error:
            errors.append(f"{row['label_id']}: {result.error}")
            continue
        labeled += 1
        same = result.passed == human
        agree += same
        tally = categories.setdefault(row.get("category") or "?", [0, 0])
        tally[0] += same
        tally[1] += 1
        if not same:
            disagreements.append(
                {"label_id": row["label_id"], "case": row.get("case"), "question": row.get("question"),
                 "human": human, "judge": result.passed, "reason": result.reason, "human_note": row.get("human_note") or ""}
            )
    return {
        "labeled": labeled,
        "agree": agree,
        "agreement": (agree / labeled) if labeled else 0.0,
        "categories": {name: {"agree": a, "total": t} for name, (a, t) in categories.items()},
        "disagreements": disagreements,
        "errors": errors,
        "judge_cost_usd": cost,
    }


def format_calibration(result: dict[str, Any], model: str) -> str:
    lines = [
        f"Judge {model}: {result['agreement']:.0%} agreement with human labels ({result['agree']}/{result['labeled']}), "
        f"judge cost ${result['judge_cost_usd']:.4f}",
    ]
    for name, tally in result["categories"].items():
        rate = tally["agree"] / tally["total"] if tally["total"] else 0.0
        lines.append(f"  {name}: {rate:.0%} ({tally['agree']}/{tally['total']})")
    if result["disagreements"]:
        lines.append("Disagreements:")
        for item in result["disagreements"]:
            human = "pass" if item["human"] else "fail"
            judge = "pass" if item["judge"] else "fail"
            lines.append(f"  {item['label_id']} {item['case']}: human {human}, judge {judge} - {item['reason']}")
    for error in result["errors"]:
        lines.append(f"  judge error {error}")
    return "\n".join(lines)
