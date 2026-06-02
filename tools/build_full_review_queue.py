#!/usr/bin/env python3
"""Build the FULL human-review queue for a show: every scan in the reviewed CSV,
each carrying the scanner prediction, the top-10 candidates, AND the AI's own
determination (so friends can see what the model guessed and we can measure how
accurate the AI was across the whole set — not just a blind 40-card sample).

This supersedes the partial queue from apply_verify_and_audit.py (128 unlabeled +
52 contested + 40 audit). Here we push ALL rows so humans review the whole show,
including the ~835 the AI was confident about.

Inputs (under --base):
  scan_review.reviewed.csv          1 row per scan; chosen_card_id = AI's final
                                    answer (blank = unsure/contested), top10_json,
                                    predicted_card_id, notes ("[ai high candidate]"…)
  ai-labels/shard_*.jsonl           pass-1 AI labels (card_id+name+number+set+…)
  ai-labels-pass2/*.jsonl           pass-2 re-reads (override pass-1)
  ai-labels-verify/*.jsonl          independent 2nd opinion (name fallback only)

The AI determination shown per card is the CSV's chosen_card_id. We resolve its
display name/number/set from the top-10 first, then from the AI shards. Rows with
a blank chosen_card_id surface as ai_label.disposition = "unsure" so reviewers
know the model punted.

Output:
  backend/review_queues/<queue>.json  {queue_id, bucket, count, items:[...]}

The backend reads the queue file per request, but this run pairs with server.py +
index.html changes (ai_label passthrough + display), so deploy the backend rather
than only scp-ing the queue. The scp line is printed for queue-only refreshes.
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import re
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent

# Allow big top10_json cells.
csv.field_size_limit(10_000_000)

_TAG_RE = re.compile(r"\s*\[([^\]]+)\]")


def _first_tag(notes: str | None) -> str:
    match = _TAG_RE.match(notes or "")
    return match.group(1).strip().lower() if match else ""


def _tier_and_source(notes: str | None) -> tuple[str | None, str | None]:
    """Parse "[ai high candidate]" / "[ai medium catalog_search]" → (tier, source)."""
    tag = _first_tag(notes)
    tier: str | None = None
    source: str | None = None
    if "high" in tag:
        tier = "high"
    elif "medium" in tag or "med" in tag:
        tier = "medium"
    if "catalog_search" in tag or "catalog search" in tag:
        source = "catalog_search"
    elif "candidate" in tag:
        source = "candidate"
    return tier, source


def _load_shard_names(base: Path) -> dict[str, dict[str, dict[str, Any]]]:
    """scan_id -> {card_id -> {name, number, set, confidence, source}}.

    Pass-2 overrides pass-1; verify fills any remaining gap. Keyed by card_id so
    we can resolve whichever card_id the CSV ultimately chose.
    """
    out: dict[str, dict[str, dict[str, Any]]] = {}
    globs = [
        base / "ai-labels" / "shard_*.jsonl",
        base / "ai-labels-pass2" / "*.jsonl",
        base / "ai-labels-verify" / "*.jsonl",
    ]
    for pattern in globs:
        for path in sorted(glob.glob(str(pattern))):
            with open(path, encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    sid = str(rec.get("scan_id") or "").strip()
                    cid = str(rec.get("card_id") or "").strip()
                    if not sid or not cid:
                        continue
                    out.setdefault(sid, {})[cid] = {
                        "name": rec.get("name") or "",
                        "number": rec.get("number") or "",
                        "set": rec.get("set") or "",
                        "confidence": rec.get("confidence") or "",
                        "source": rec.get("source") or "",
                    }
    return out


def _parse_top10(raw: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(raw or "[]")
    except ValueError:
        return []
    items: list[dict[str, Any]] = []
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        items.append(
            {
                "rank": entry.get("rank"),
                "card_id": entry.get("card_id"),
                "name": entry.get("name"),
                "number": entry.get("number"),
                "set": entry.get("set"),
            }
        )
    return items


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--base", type=Path, required=True, help="export dir")
    parser.add_argument("--queue", default="show-2026-05-31")
    parser.add_argument("--bucket", default="looty-staging")
    parser.add_argument(
        "--require-uploaded",
        action="store_true",
        help="skip rows whose upload_status is not 'uploaded' (image won't load)",
    )
    args = parser.parse_args()
    base = args.base

    rows = list(csv.DictReader(open(base / "scan_review.reviewed.csv", encoding="utf-8")))
    shard_names = _load_shard_names(base)

    items: list[dict[str, Any]] = []
    stats = {
        "rows": len(rows),
        "ai_confident": 0,
        "ai_unsure": 0,
        "ai_in_top10": 0,
        "ai_catalog_search": 0,
        "ai_name_unresolved": 0,
        "skipped_not_uploaded": 0,
        "tier_high": 0,
        "tier_medium": 0,
    }

    for row in rows:
        scan_id = str(row.get("scan_id") or "").strip()
        if not scan_id:
            continue
        upload_status = str(row.get("upload_status") or "").strip()
        if args.require_uploaded and upload_status != "uploaded":
            stats["skipped_not_uploaded"] += 1
            continue

        object_path = (
            str(row.get("normalized_object_path") or "").strip()
            or f"scans/2026/05/31/{scan_id}/normalized_target.jpg"
        )
        candidates = _parse_top10(row.get("top10_json") or "")
        top_by_id = {str(c.get("card_id")): c for c in candidates if c.get("card_id")}

        # predicted = the rank-1 candidate (matches the scanner top-1).
        predicted = None
        for cand in candidates:
            if cand.get("rank") == 1:
                predicted = {
                    "card_id": cand.get("card_id"),
                    "name": cand.get("name"),
                    "number": cand.get("number"),
                    "set": cand.get("set"),
                }
                break
        if predicted is None and row.get("predicted_card_id"):
            predicted = {"card_id": row.get("predicted_card_id")}

        chosen = str(row.get("chosen_card_id") or "").strip()
        notes = row.get("notes") or ""
        if not chosen:
            ai_label: dict[str, Any] = {"disposition": "unsure", "note": notes.strip() or None}
            stats["ai_unsure"] += 1
        else:
            stats["ai_confident"] += 1
            tier, source = _tier_and_source(notes)
            if tier == "high":
                stats["tier_high"] += 1
            elif tier == "medium":
                stats["tier_medium"] += 1

            in_top10 = chosen in top_by_id
            name = number = card_set = ""
            rank = None
            if in_top10:
                stats["ai_in_top10"] += 1
                cand = top_by_id[chosen]
                name = cand.get("name") or ""
                number = cand.get("number") or ""
                card_set = cand.get("set") or ""
                rank = cand.get("rank")
            else:
                stats["ai_catalog_search"] += 1
                shard = shard_names.get(scan_id, {}).get(chosen)
                if shard:
                    name = shard["name"]
                    number = shard["number"]
                    card_set = shard["set"]
            if not name:
                stats["ai_name_unresolved"] += 1

            ai_label = {
                "card_id": chosen,
                "name": name or None,
                "number": number or None,
                "set": card_set or None,
                "tier": tier,
                "source": source or ("candidate" if in_top10 else "catalog_search"),
                "in_top10": in_top10,
                "rank": rank,
                "note": notes.strip() or None,
            }

        items.append(
            {
                "scan_id": scan_id,
                "object_path": object_path,
                "predicted": predicted,
                "candidates": candidates,
                "ai_label": ai_label,
            }
        )

    queue_file = REPO_ROOT / "backend" / "review_queues" / f"{args.queue}.json"
    queue_file.parent.mkdir(parents=True, exist_ok=True)
    json.dump(
        {"queue_id": args.queue, "bucket": args.bucket, "count": len(items), "items": items},
        open(queue_file, "w", encoding="utf-8"),
        separators=(",", ":"),
        ensure_ascii=False,
    )

    stats["queue_size"] = len(items)
    stats["queueFile"] = str(queue_file)
    print(json.dumps(stats, indent=2))
    print(
        "\nDeploy the backend (server.py + index.html + this queue changed):\n"
        "  pnpm backend:deploy:staging\n"
        "\nOr, for a queue-only refresh (no server/html change), scp it:\n"
        f"  gcloud compute scp {queue_file} "
        f"spotlight-backend-vm-small:~/spotlight/review_queues/{args.queue}.json "
        "--zone us-central1-b --tunnel-through-iap"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
