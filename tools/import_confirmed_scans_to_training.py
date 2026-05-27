#!/usr/bin/env python3
"""Turn a reviewed scan worksheet (from export_scan_training_rows.py) into a
raw-visual training batch and hand it off to process_raw_visual_batch.py.

For each row with an effective label (chosen_card_id, else confirmed_card_id):
  - resolve the card to name/number/set/provider via the `cards` table
  - block any card that belongs to the frozen Tier-1 suite (qa/raw-footer-layout-check)
  - assign a Tier (2=expansion holdout / 3=training) deterministically and ONCE
    per providerCardId (never reassigned), persisted in raw_scan_registry.json
  - write photos/<scan_id>.jpg + cards.tsv in the format process_raw_visual_batch
    consumes, then (with --run-batch) invoke it with --import-safe.

Idempotent: re-running reuses each providerCard's existing tier and relies on
process_raw_visual_batch's SHA-256 exact-dedupe to skip already-imported images.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "tools"))

from process_raw_visual_batch import (  # noqa: E402
    HELDOUT_ROOT,
    REQUIRED_BATCH_FIELDS,
    default_raw_visual_scan_registry_path,
    load_registry,
    load_truth_index,
    normalize_tier_assignment,
    slugify,
    truth_key,
    utc_now_iso,
)

NON_LABEL_TOKENS = {"", "none", "unclear", "skip", "not_in_top_10", "n/a"}
TSV_FIELDS = list(REQUIRED_BATCH_FIELDS) + [
    "provider_card_id", "tier_assignment", "routed_batch_id", "scan_id",
]


def open_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def resolve_card(connection: sqlite3.Connection, card_id: str) -> dict[str, Any] | None:
    row = connection.execute(
        "SELECT id, name, number, set_name, set_id, set_ptcgo_code, source_record_id "
        "FROM cards WHERE id = ? LIMIT 1",
        (card_id,),
    ).fetchone()
    if row is None:
        return None
    set_code = ""
    for key in ("set_ptcgo_code", "set_id", "set_name"):
        value = str(row[key] or "").strip()
        if value:
            set_code = value
            break
    return {
        "card_name": str(row["name"] or "").strip(),
        "number": str(row["number"] or "").strip(),
        "set": set_code or "UNKNOWN",
        "provider_card_id": str(row["source_record_id"] or row["id"] or "").strip(),
    }


def assign_tier(provider_card_id: str, batch_id: str, tier2_pct: int, provider_cards: dict[str, Any]) -> tuple[str, bool]:
    """Return (tier, is_new). Existing providerCards keep their tier forever."""
    existing = provider_cards.get(provider_card_id)
    if isinstance(existing, dict):
        existing_tier = normalize_tier_assignment(existing.get("tier"))
        if existing_tier:
            return existing_tier, False
    bucket = int(hashlib.sha256(f"{provider_card_id}:{batch_id}".encode("utf-8")).hexdigest(), 16) % 100
    return ("tier2" if bucket < tier2_pct else "tier3"), True


def main() -> int:
    parser = argparse.ArgumentParser(description="Import reviewed scans into a raw-visual training batch.")
    parser.add_argument("--csv", required=True, help="Reviewed worksheet from export_scan_training_rows.py.")
    parser.add_argument("--db", required=True, help="SQLite snapshot for cards resolution.")
    parser.add_argument("--review-dir", help="Dir holding the review images. Defaults to the CSV's parent.")
    parser.add_argument("--batch-id", help="Stable batch id (also the tier-routing salt). Defaults from the CSV name.")
    parser.add_argument("--tier2-pct", type=int, default=20, help="Share of NEW provider cards reserved for Tier 2 (15-25).")
    parser.add_argument("--registry-path", default=str(default_raw_visual_scan_registry_path()))
    parser.add_argument("--heldout-root", default=str(HELDOUT_ROOT))
    parser.add_argument("--output-root", help="Where to stage the batch. Defaults next to the CSV.")
    parser.add_argument("--run-batch", action="store_true", help="Invoke process_raw_visual_batch.py --import-safe.")
    parser.add_argument("--dry-run", action="store_true", help="Stage the batch + report, do not write the registry or run.")
    args = parser.parse_args()

    tier2_pct = max(15, min(25, int(args.tier2_pct)))
    csv_path = Path(args.csv).expanduser().resolve()
    review_dir = Path(args.review_dir).expanduser().resolve() if args.review_dir else csv_path.parent
    batch_id = args.batch_id or slugify(f"scans-{csv_path.stem}")
    output_root = (
        Path(args.output_root).expanduser().resolve()
        if args.output_root
        else csv_path.parent / "_incoming-batches" / batch_id
    )
    registry_path = Path(args.registry_path).expanduser().resolve()

    registry = load_registry(registry_path)
    provider_cards = registry["providerCards"]
    tier1_index = load_truth_index(Path(args.heldout_root).expanduser().resolve())

    photos_dir = output_root / "photos"
    photos_dir.mkdir(parents=True, exist_ok=True)
    tsv_path = output_root / "cards.tsv"

    accepted: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    newly_assigned: dict[str, dict[str, Any]] = {}

    with open_database(Path(args.db).expanduser().resolve()) as connection, tsv_path.open("w", newline="") as tsv_handle:
        writer = csv.DictWriter(tsv_handle, fieldnames=TSV_FIELDS, delimiter="\t")
        writer.writeheader()

        with csv_path.open(newline="") as csv_handle:
            for row in csv.DictReader(csv_handle):
                scan_id = str(row.get("scan_id") or "").strip()
                label = str(row.get("chosen_card_id") or "").strip() or str(row.get("confirmed_card_id") or "").strip()
                if label.lower() in NON_LABEL_TOKENS or not scan_id:
                    skipped.append({"scanID": scan_id, "reason": "no_effective_label"})
                    continue

                card = resolve_card(connection, label)
                if card is None or not card["card_name"]:
                    skipped.append({"scanID": scan_id, "reason": f"card_not_in_catalog:{label}"})
                    continue

                key = truth_key(card["card_name"], card["number"], card["set"])
                if key in tier1_index:
                    blocked.append({"scanID": scan_id, "providerCardId": card["provider_card_id"], "reason": "tier1_frozen_suite"})
                    continue

                image_src = (review_dir / str(row.get("image_file") or f"images/{scan_id}.jpg")).resolve()
                if not image_src.exists():
                    skipped.append({"scanID": scan_id, "reason": f"image_missing:{image_src}"})
                    continue

                provider_card_id = card["provider_card_id"]
                tier, is_new = assign_tier(provider_card_id, batch_id, tier2_pct, provider_cards)
                if is_new and provider_card_id not in newly_assigned:
                    newly_assigned[provider_card_id] = {
                        "providerCardId": provider_card_id,
                        "tier": tier,
                        "firstSeenScanId": scan_id,
                        "firstSeenBatchId": batch_id,
                        "firstSeenSource": "scan_review",
                        "assignedTierAt": utc_now_iso(),
                    }
                    # Make the assignment visible to subsequent rows in this run too.
                    provider_cards[provider_card_id] = newly_assigned[provider_card_id]

                file_name = f"{scan_id}.jpg"
                shutil.copy2(image_src, photos_dir / file_name)
                writer.writerow(
                    {
                        "file_name": file_name,
                        "card_name": card["card_name"],
                        "number": card["number"],
                        "set": card["set"],
                        "provider_card_id": provider_card_id,
                        "tier_assignment": tier,
                        "routed_batch_id": batch_id,
                        "scan_id": scan_id,
                    }
                )
                accepted.append({"scanID": scan_id, "providerCardId": provider_card_id, "tier": tier, "new": is_new})

    report = {
        "generatedAt": utc_now_iso(),
        "batchId": batch_id,
        "tier2Pct": tier2_pct,
        "outputRoot": str(output_root),
        "cardsTsv": str(tsv_path),
        "photosDir": str(photos_dir),
        "acceptedCount": len(accepted),
        "newProviderCardCount": len(newly_assigned),
        "tier2Count": sum(1 for item in accepted if item["tier"] == "tier2"),
        "tier3Count": sum(1 for item in accepted if item["tier"] == "tier3"),
        "blockedTier1Count": len(blocked),
        "blocked": blocked,
        "skippedCount": len(skipped),
        "skipped": skipped[:50],
    }
    (output_root / "import_report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")

    # Persist new provider-card tier assignments so the split is stable forever.
    if newly_assigned and not args.dry_run:
        registry["providerCards"] = provider_cards
        registry["updatedAt"] = utc_now_iso()
        registry_path.parent.mkdir(parents=True, exist_ok=True)
        registry_path.write_text(json.dumps(registry, indent=2, sort_keys=True) + "\n")

    print(json.dumps(report, indent=2, sort_keys=True))

    if not accepted:
        print("No rows accepted; nothing to import.", file=sys.stderr)
        return 0

    if args.run_batch and not args.dry_run:
        command = [
            "python3", str(REPO_ROOT / "tools" / "process_raw_visual_batch.py"),
            "--spreadsheet", str(tsv_path),
            "--photo-root", str(photos_dir),
            "--batch-id", batch_id,
            "--registry-path", str(registry_path),
            "--import-safe",
        ]
        print(f"[import] handing off: {' '.join(command)}", flush=True)
        subprocess.run(command, check=True, cwd=str(REPO_ROOT))
    else:
        print(
            f"[import] staged batch at {output_root}. Re-run with --run-batch to import via process_raw_visual_batch.py.",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
