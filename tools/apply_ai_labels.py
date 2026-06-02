#!/usr/bin/env python3
"""Merge AI per-scan labels into the review CSV, ready for training import.

Reads the ai-labels/shard_*.jsonl produced by the labeling agents (each line:
{scan_id, card_id, confidence, source, notes, ...}) and applies them to the
scan_review.csv worksheet:

  - confidence high  (and medium, unless --accept high) with a non-empty card_id
    -> chosen_card_id is filled (these flow into training).
  - everything else (unsure / blank card_id / no AI label) -> chosen_card_id left
    blank and a note added, so it routes to humans via tools/scan_labeling_server.py.

Validates every chosen card_id against the local catalog so a bad id never reaches
training. Output is an export_scan_training_rows-compatible CSV.
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "tools"))

from export_labeling_sessions_batch import default_database_path  # noqa: E402

CSV_FIELDS = [
    "scan_id", "created_at", "owner_user_id", "image_file", "normalized_object_path",
    "upload_status", "predicted_card_id", "predicted_card_name", "confirmed_card_id",
    "confirmed_card_name", "chosen_card_id", "top10_json", "notes",
]


def load_ai_labels(labels_globs: list[str]) -> dict[str, dict[str, Any]]:
    """Load labels from globs in priority order; later globs override earlier
    ones for the same scan_id (so a pass-2 label upgrades a pass-1 'unsure')."""
    decisions: dict[str, dict[str, Any]] = {}
    for labels_glob in labels_globs:
        for path in sorted(glob.glob(labels_glob)):
            with open(path) as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    scan_id = str(record.get("scan_id") or "").strip()
                    if scan_id:
                        decisions[scan_id] = record
    return decisions


def valid_card_ids(db_path: Path, card_ids: set[str]) -> set[str]:
    if not card_ids or not db_path.exists():
        return set()
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        present: set[str] = set()
        ids = [c for c in card_ids if c]
        for i in range(0, len(ids), 500):
            chunk = ids[i : i + 500]
            placeholders = ",".join("?" for _ in chunk)
            rows = con.execute(f"SELECT id FROM cards WHERE id IN ({placeholders})", chunk).fetchall()
            present.update(str(r[0]) for r in rows)
        return present
    finally:
        con.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv", type=Path, required=True, help="scan_review.csv worksheet.")
    parser.add_argument("--labels-glob", action="append", required=True, dest="labels_globs",
                        help="Glob for ai-labels/shard_*.jsonl. Repeatable; later globs override earlier.")
    parser.add_argument("--out", type=Path, required=True, help="Output reviewed CSV.")
    parser.add_argument("--db", type=Path, default=default_database_path(), help="Local catalog DB (validation).")
    parser.add_argument("--accept", choices=["high", "high+medium"], default="high+medium",
                        help="Which AI confidence to auto-accept into chosen_card_id.")
    args = parser.parse_args()

    accept = {"high"} if args.accept == "high" else {"high", "medium"}
    ai = load_ai_labels(args.labels_globs)

    with args.csv.open(newline="") as handle:
        worklist = list(csv.DictReader(handle))

    proposed = {
        d["card_id"]
        for d in ai.values()
        if d.get("confidence") in accept and str(d.get("card_id") or "").strip()
    }
    valid = valid_card_ids(args.db, proposed)

    counts = {"accepted": 0, "rejected_bad_id": 0, "to_human_unsure": 0, "no_ai_label": 0,
              "high": 0, "medium": 0, "unsure": 0}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for row in worklist:
            out = {key: row.get(key, "") for key in CSV_FIELDS}
            scan_id = str(row["scan_id"])
            d = ai.get(scan_id)
            if d is None:
                counts["no_ai_label"] += 1
                out["notes"] = (out.get("notes") or "") + " [no ai label -> human]"
                writer.writerow(out)
                continue
            conf = str(d.get("confidence") or "unsure")
            counts[conf] = counts.get(conf, 0) + 1
            card_id = str(d.get("card_id") or "").strip()
            note = str(d.get("notes") or "").strip()
            if conf in accept and card_id and card_id in valid:
                out["chosen_card_id"] = card_id
                out["notes"] = f"[ai {conf} {d.get('source','')}] {note}".strip()
                counts["accepted"] += 1
            else:
                # unsure, blank id, rejected id, or below-accept confidence -> human
                if conf in accept and card_id and card_id not in valid:
                    counts["rejected_bad_id"] += 1
                    reason = f"ai picked {card_id} but not in catalog"
                else:
                    counts["to_human_unsure"] += 1
                    reason = f"ai {conf}"
                out["chosen_card_id"] = ""
                out["notes"] = f"[{reason} -> human] {note}".strip()
            writer.writerow(out)

    print(json.dumps({"reviewedCsv": str(args.out), "accept": args.accept, "counts": counts}, indent=2))
    accepted = counts["accepted"]
    human = counts["no_ai_label"] + counts["to_human_unsure"] + counts["rejected_bad_id"]
    print(f"\nAuto-labeled (into training): {accepted}")
    print(f"Routed to human web tool:     {human}")
    print("\nImport the auto-labeled set:")
    print(f"  python3 tools/import_confirmed_scans_to_training.py --csv {args.out} --db {args.db} --run-batch")
    print("\nLabel the rest with friends (only the blank chosen_card_id rows need a human):")
    print(f"  python3 tools/scan_labeling_server.py --csv {args.out} --db {args.db} --host 0.0.0.0 --port 8765")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
