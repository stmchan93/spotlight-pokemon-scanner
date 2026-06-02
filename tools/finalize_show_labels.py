#!/usr/bin/env python3
"""Merge friends' staging review picks with the AI-labeled CSV into one final
training CSV — the "we're done labeling, ship it" step.

Pulls scan_labeling_reviews off the staging VM (the friend picks for the 128
the AI couldn't read), folds them into the reviewed CSV (which already carries
the AI-confirmed labels), validates every card_id against the local catalog, and
writes scan_review.final.csv ready for import_confirmed_scans_to_training.py.

Run it whenever (re-runnable / idempotent). With --watch it polls the staging
queue and only finalizes once every scan has been reviewed.

Examples:
  python3 tools/finalize_show_labels.py \
    --csv ~/spotlight-datasets/.../show-2026-05-31/scan_review.reviewed.csv \
    --out ~/spotlight-datasets/.../show-2026-05-31/scan_review.final.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import time
from collections import Counter
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

# Reads scan_labeling_reviews on the VM and emits it as JSON to stdout. Only
# label columns — no secrets, no images.
VM_DUMP = (
    "import json,sqlite3,os;"
    "p=os.path.expanduser('~/spotlight/data/spotlight_scanner.sqlite');"
    "c=sqlite3.connect('file:%s?mode=ro'%p,uri=True);c.row_factory=sqlite3.Row;"
    "rows=[dict(r) for r in c.execute("
    "\"SELECT scan_id,labeled_card_id,label_disposition,reviewer_user_id,queue_id FROM scan_labeling_reviews\")];"
    "print(json.dumps(rows))"
)


def _run_vm_python(instance: str, zone: str, program: str) -> subprocess.CompletedProcess[str]:
    """Run a Python program on the VM. The source is base64-encoded so the
    remote shell never has to parse quotes/spaces inside it — earlier inline
    `python3 -c "..."` forms broke whenever the program contained double quotes
    (e.g. a quoted SQL string)."""
    import base64

    blob = base64.b64encode(program.encode("utf-8")).decode("ascii")
    remote = f"python3 -c \"import base64;exec(base64.b64decode('{blob}').decode())\""
    cmd = [
        "gcloud", "compute", "ssh", instance, "--zone", zone, "--tunnel-through-iap",
        "--command", remote,
    ]
    return subprocess.run(cmd, capture_output=True, text=True)


def fetch_vm_reviews(instance: str, zone: str) -> list[dict[str, Any]]:
    proc = _run_vm_python(instance, zone, VM_DUMP)
    if proc.returncode != 0:
        raise SystemExit(f"VM review fetch failed:\n{proc.stderr[-1500:]}")
    # The SSH banner may prefix stdout; take the last JSON array line.
    for line in reversed(proc.stdout.splitlines()):
        line = line.strip()
        if line.startswith("["):
            return json.loads(line)
    raise SystemExit("Could not parse review rows from VM output.")


def resolve_picks(reviews: list[dict[str, Any]], queue_id: str | None) -> tuple[dict[str, str], list[str]]:
    """Per scan, choose the agreed confirmed card_id. Returns (picks, conflicts)."""
    by_scan: dict[str, list[str]] = {}
    for r in reviews:
        if queue_id and str(r.get("queue_id") or "") not in ("", queue_id):
            continue
        if r.get("label_disposition") != "confirmed":
            continue
        cid = str(r.get("labeled_card_id") or "").strip()
        if cid:
            by_scan.setdefault(str(r["scan_id"]), []).append(cid)
    picks: dict[str, str] = {}
    conflicts: list[str] = []
    for scan_id, cids in by_scan.items():
        tally = Counter(cids)
        top, n = tally.most_common(1)[0]
        picks[scan_id] = top
        if len(tally) > 1:
            conflicts.append(scan_id)  # reviewers disagreed; took the majority
    return picks, conflicts


def valid_card_ids(db_path: Path, card_ids: set[str]) -> set[str]:
    import sqlite3
    if not card_ids or not db_path.exists():
        return set()
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        present: set[str] = set()
        ids = [c for c in card_ids if c]
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            ph = ",".join("?" for _ in chunk)
            present.update(str(r[0]) for r in con.execute(f"SELECT id FROM cards WHERE id IN ({ph})", chunk))
        return present
    finally:
        con.close()


def queue_remaining(instance: str, zone: str, queue_path: str) -> int | None:
    """Best-effort: how many queue scans still have no terminal human decision.

    "Done" = a reviewer confirmed it OR marked it unclear / not_in_top_10 (both
    terminal — the card was adjudicated, it just yields no training label). A
    plain 'skip' is NOT terminal so the scan stays in the count and requeues for
    others. This is what lets "everything is labeled" actually reach 0 even when
    some cards are genuinely unreadable.
    """
    dump = (
        "import json,sqlite3,os;"
        f"q=json.load(open(os.path.expanduser('{queue_path}')));"
        "ids=[i['scan_id'] for i in q['items']];"
        "p=os.path.expanduser('~/spotlight/data/spotlight_scanner.sqlite');"
        "c=sqlite3.connect('file:%s?mode=ro'%p,uri=True);"
        "done=set(r[0] for r in c.execute(\"SELECT scan_id FROM scan_labeling_reviews WHERE label_disposition IN ('confirmed','unclear','not_in_top_10')\"));"
        "print(len([i for i in ids if i not in done]))"
    )
    proc = _run_vm_python(instance, zone, dump)
    if proc.returncode != 0:
        return None
    for line in reversed(proc.stdout.splitlines()):
        line = line.strip()
        if line.isdigit():
            return int(line)
    return None


def merge(csv_path: Path, out_path: Path, picks: dict[str, str], db_path: Path) -> dict[str, int]:
    with csv_path.open(newline="") as h:
        rows = list(csv.DictReader(h))
    valid = valid_card_ids(db_path, set(picks.values()))
    counts = {"ai_labeled": 0, "friend_added": 0, "friend_bad_id": 0, "still_blank": 0, "total": len(rows)}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=CSV_FIELDS)
        w.writeheader()
        for row in rows:
            out = {k: row.get(k, "") for k in CSV_FIELDS}
            sid = str(row["scan_id"])
            if out["chosen_card_id"].strip():
                counts["ai_labeled"] += 1            # already AI-labeled; keep it
            elif sid in picks and picks[sid] in valid:
                out["chosen_card_id"] = picks[sid]
                out["notes"] = (out.get("notes") or "") + " [friend review]"
                counts["friend_added"] += 1
            elif sid in picks:
                out["notes"] = (out.get("notes") or "") + f" [friend picked {picks[sid]} not in catalog]"
                counts["friend_bad_id"] += 1
                counts["still_blank"] += 1
            else:
                counts["still_blank"] += 1
            w.writerow(out)
    return counts


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--csv", type=Path, required=True, help="scan_review.reviewed.csv (the AI-labeled 887 + blanks).")
    p.add_argument("--out", type=Path, required=True, help="Output final CSV.")
    p.add_argument("--db", type=Path, default=default_database_path(), help="Local catalog DB (validation).")
    p.add_argument("--instance", default="spotlight-backend-vm-small")
    p.add_argument("--zone", default="us-central1-b")
    p.add_argument("--queue", default="show-2026-05-31", help="Queue id (filters reviews).")
    p.add_argument("--watch", action="store_true", help="Poll until every queue scan is reviewed, then finalize.")
    p.add_argument("--poll-seconds", type=int, default=600)
    p.add_argument("--audit-truth", type=Path, help="verify/audit_truth.json — report friend-vs-AI accuracy.")
    args = p.parse_args()

    queue_path = f"~/spotlight/review_queues/{args.queue}.json"
    if args.watch:
        while True:
            remaining = queue_remaining(args.instance, args.zone, queue_path)
            print(f"[watch] remaining unreviewed: {remaining}")
            if remaining == 0:
                break
            time.sleep(max(60, args.poll_seconds))

    reviews = fetch_vm_reviews(args.instance, args.zone)
    picks, conflicts = resolve_picks(reviews, args.queue)
    counts = merge(args.csv, args.out, picks, args.db)

    print(json.dumps({"finalCsv": str(args.out), "friendPicks": len(picks),
                      "reviewerConflicts": len(conflicts), "counts": counts}, indent=2))

    # Spot-audit accuracy: of the audit scans a friend confirmed, how many matched the AI's label.
    if args.audit_truth and args.audit_truth.exists():
        truth = json.loads(args.audit_truth.read_text())
        checked = [(s, truth[s], picks[s]) for s in truth if s in picks]
        if checked:
            agree = sum(1 for _, ai, fr in checked if ai == fr)
            pct = 100.0 * agree / len(checked)
            print(f"\n=== Spot-audit accuracy ===")
            print(f"  audit scans a friend confirmed: {len(checked)} / {len(truth)}")
            print(f"  friend agreed with AI label:    {agree}  ({pct:.1f}%)")
            print(f"  -> estimated AI label accuracy on the batch ~ {pct:.1f}%")
            mism = [(s, ai, fr) for s, ai, fr in checked if ai != fr]
            if mism:
                print(f"  mismatches (AI vs friend), AI likely wrong on these:")
                for s, ai, fr in mism[:20]:
                    print(f"    {s[:8]}  ai={ai}  friend={fr}")
        else:
            print("\n(no audit scans reviewed yet — accuracy pending)")
    labeled = counts["ai_labeled"] + counts["friend_added"]
    print(f"\nTotal labeled for training: {labeled} / {counts['total']}  (still blank: {counts['still_blank']})")
    if conflicts:
        print(f"Note: {len(conflicts)} scans had reviewers disagree — took the majority pick.")
    print("\nImport into training:")
    print(f"  python3 tools/import_confirmed_scans_to_training.py --csv {args.out} "
          f"--db {args.db} --batch-id show-2026-05-31 --run-batch")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
