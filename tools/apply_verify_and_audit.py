#!/usr/bin/env python3
"""Process the Tier-C verification pass + seed a spot-audit, then rebuild the
web review queue.

Inputs (under --base):
  scan_review.reviewed.csv         the AI-labeled 887 + blanks
  verify/pass1_answers.json        {scan_id: original chosen_card_id} for the 258 Tier-C
  verify/verify_worklist.jsonl     the 258 verified blind
  ai-labels-verify/shard_*.jsonl   the independent second-pass results
  worklist.jsonl                   candidates + predicted per scan (for queue items)
  review_queues/...                (we regenerate this)

Actions:
  - Tier-C agree (2nd pass == original): keep the label (verified).
  - Tier-C disagree / 2nd pass unsure: blank chosen_card_id (contested) and add
    the scan to the human web queue.
  - Pick --audit-n random labels from the confident 887 and add them to the queue
    too (blind) so friends measure AI accuracy; their AI answer is saved to
    verify/audit_truth.json (NOT shown to friends).
  - Rewrite backend/review_queues/<queue>.json = original-unlabeled + contested + audit.

Then scp the new queue file to the VM (printed at the end). No restart needed —
the backend reads the queue file per request.
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import random
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_labels(glob_pat: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for f in sorted(glob.glob(glob_pat)):
        for line in open(f):
            line = line.strip()
            if line:
                d = json.loads(line)
                out[d["scan_id"]] = d
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", type=Path, required=True)
    p.add_argument("--queue", default="show-2026-05-31")
    p.add_argument("--audit-n", type=int, default=40)
    p.add_argument("--seed", type=int, default=531)
    args = p.parse_args()
    base = args.base

    rows = list(csv.DictReader(open(base / "scan_review.reviewed.csv")))
    pass1 = json.load(open(base / "verify" / "pass1_answers.json"))
    verify = load_labels(str(base / "ai-labels-verify" / "shard_*.jsonl"))
    wl = {json.loads(l)["scan_id"]: json.loads(l) for l in open(base / "worklist.jsonl")}

    # 1. Tier-C agree vs disagree
    contested: set[str] = set()
    agreed = 0
    for sid, orig in pass1.items():
        v = verify.get(sid, {})
        vid = str(v.get("card_id") or "").strip()
        if vid and vid == orig:
            agreed += 1
        else:
            contested.add(sid)

    # 2. blank contested in the CSV
    for r in rows:
        if r["scan_id"] in contested:
            r["chosen_card_id"] = ""
            r["notes"] = (r.get("notes") or "") + " [contested: verify disagreed -> human]"

    # 3. confident labeled pool (chosen still filled) -> pick audit sample
    labeled_now = [r["scan_id"] for r in rows if r["chosen_card_id"].strip()]
    rng = random.Random(args.seed)
    audit = set(rng.sample(labeled_now, min(args.audit_n, len(labeled_now))))
    audit_truth = {sid: next(r["chosen_card_id"] for r in rows if r["scan_id"] == sid) for sid in audit}

    # 4. original-unlabeled = blanks that were NOT just contested (the true 128)
    unlabeled = [r["scan_id"] for r in rows if not r["chosen_card_id"].strip() and r["scan_id"] not in contested]

    # 5. build queue items (friends see no AI answer)
    queue_ids = list(dict.fromkeys(unlabeled + sorted(contested) + sorted(audit)))
    items = []
    manifest = {}
    for sid in queue_ids:
        w = wl.get(sid, {})
        items.append({
            "scan_id": sid,
            "object_path": f"scans/2026/05/31/{sid}/normalized_target.jpg",
            "predicted": w.get("predicted"),
            "candidates": [{"rank": c["rank"], "card_id": c["card_id"], "name": c["name"],
                            "number": c["number"], "set": c["set"]} for c in w.get("candidates", [])],
        })
        manifest[sid] = ("audit" if sid in audit else "contested" if sid in contested else "unlabeled")

    # 6. write outputs
    qf = REPO_ROOT / "backend" / "review_queues" / f"{args.queue}.json"
    qf.parent.mkdir(parents=True, exist_ok=True)
    json.dump({"queue_id": args.queue, "bucket": "looty-staging", "count": len(items), "items": items},
              open(qf, "w"), separators=(",", ":"))
    with open(base / "scan_review.reviewed.csv", "w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    json.dump(audit_truth, open(base / "verify" / "audit_truth.json", "w"), indent=2)
    json.dump(manifest, open(base / "verify" / "queue_manifest.json", "w"), indent=2)

    print(json.dumps({
        "tierC_total": len(pass1), "verified_agree": agreed, "contested_disagree": len(contested),
        "agreement_rate": f"{(100.0*agreed/len(pass1)):.1f}%" if pass1 else "n/a",
        "audit_sample": len(audit),
        "new_queue_size": len(items),
        "queue_breakdown": {"unlabeled": len(unlabeled), "contested": len(contested), "audit": len(audit)},
        "still_labeled_887_after_verify": len(labeled_now),
        "queueFile": str(qf),
    }, indent=2))
    print(f"\nDeploy the new queue (no restart needed):\n  gcloud compute scp {qf} "
          f"spotlight-backend-vm-small:~/spotlight/review_queues/{args.queue}.json "
          f"--zone us-central1-b --tunnel-through-iap")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
