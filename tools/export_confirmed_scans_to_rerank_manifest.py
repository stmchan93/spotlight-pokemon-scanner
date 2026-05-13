#!/usr/bin/env python3
"""Export Add-to-Deck confirmed scans into the training-manifest schema.

Confirmed scans (`scan_events.confirmed_card_id IS NOT NULL`) are gold
labels — the user explicitly verified the card identity. Each one has a
normalized_target.jpg artifact on disk that's exactly what gets matched
against the visual library at scan time.

This tool joins scan_events + scan_artifacts + cards in the production
SQLite database, hydrates each confirmed scan into a row matching the
training manifest schema (so the existing rerank-pool builder can ingest
it without modification), and writes a JSONL.

Defensively excludes any confirmed scan whose card maps to the held-out
fixture sets so production confirmations can never contaminate eval.

USE: by default DRY-RUN. Pass --apply to actually write the JSONL.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def truth_key(name: str, num: str, setc: str) -> str:
    return f"{name.strip()}|{num.strip()}|{setc.strip()}"


def name_number_key(name: str, num: str) -> str:
    return f"{name.strip().lower()}|{num.strip()}"


def collect_holdout_keys(roots: list[Path]) -> tuple[set[str], set[str]]:
    tk: set[str] = set()
    nk: set[str] = set()
    for root in roots:
        if not root.exists():
            continue
        for tjson in root.rglob("truth.json"):
            t = json.loads(tjson.read_text())
            name = str(t.get("cardName") or "")
            num = str(t.get("collectorNumber") or "")
            setc = str(t.get("setCode") or "")
            tk.add(truth_key(name, num, setc))
            nk.add(name_number_key(name, num))
    return tk, nk


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=Path("backend/data/spotlight_scanner.sqlite"),
        help="Path to the SQLite database holding scan_events / scan_artifacts / cards.",
    )
    parser.add_argument(
        "--artifact-root",
        type=Path,
        default=Path("backend/data/scan-artifacts"),
        help="Filesystem root for scan artifacts (matches scan_artifact_store filesystem mode).",
    )
    parser.add_argument(
        "--holdout-root",
        type=Path,
        action="append",
        dest="holdout_roots",
        default=[
            Path("qa/raw-footer-layout-check"),
            Path("/Users/stephenchan/spotlight-datasets/raw-visual-expansion-holdouts/delta-raw-20260504-audit"),
            Path("/Users/stephenchan/spotlight-datasets/raw-visual-expansion-holdouts/drive-download-20260420t172622z-3-001"),
        ],
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("backend/data/visual-index/confirmed_scans_rerank_input.jsonl"),
        help="Where to write the manifest. Default lives next to the rerank-pool artifact.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually write the JSONL. Default is dry-run (prints summary only).",
    )
    parser.add_argument(
        "--require-uploaded",
        action="store_true",
        default=True,
        help="Only export scans whose artifact upload_status='uploaded'. Default on.",
    )
    parser.add_argument(
        "--source-tag",
        default="confirmed_scan",
        help="Value for the rowSource field on emitted entries.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    db_path = args.db.resolve()
    artifact_root = args.artifact_root.resolve()
    output_path = args.output.resolve()
    if not db_path.exists():
        raise SystemExit(f"DB not found: {db_path}")

    holdout_truth_keys, holdout_nn_keys = collect_holdout_keys(
        [p.resolve() for p in args.holdout_roots]
    )
    print(f"held-out exclusion set: {len(holdout_truth_keys)} truth keys", flush=True)

    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    upload_filter = "AND a.upload_status = 'uploaded'" if args.require_uploaded else ""
    cur.execute(
        f"""
        SELECT e.scan_id, e.confirmed_card_id, e.confirmed_at, e.owner_user_id,
               a.normalized_object_path, a.upload_status,
               c.name AS card_name, c.number AS collector_number,
               c.set_id AS set_id, c.set_ptcgo_code AS set_ptcgo_code,
               c.language AS card_language
        FROM scan_events e
        JOIN scan_artifacts a USING(scan_id)
        LEFT JOIN cards c ON c.id = e.confirmed_card_id
        WHERE e.confirmed_card_id IS NOT NULL
        {upload_filter}
        ORDER BY e.confirmed_at
        """
    )
    rows = cur.fetchall()
    print(f"candidate confirmed scans (joinable + uploaded={args.require_uploaded}): {len(rows)}", flush=True)

    rejection_counts = {
        "missing_card_metadata": 0,
        "missing_normalized_image": 0,
        "holdout_overlap_truthkey": 0,
        "holdout_overlap_namenumber": 0,
    }
    accepted: list[dict[str, Any]] = []

    for row in rows:
        scan_id = row["scan_id"]
        pid = row["confirmed_card_id"]
        name = str(row["card_name"] or "").strip()
        num = str(row["collector_number"] or "").strip()
        # Use ptcgo_code if available; fallback to set_id
        setc = str(row["set_ptcgo_code"] or row["set_id"] or "").strip()
        if not (name and num and setc):
            rejection_counts["missing_card_metadata"] += 1
            continue
        normalized_rel = str(row["normalized_object_path"] or "")
        normalized_path = artifact_root / normalized_rel
        if not normalized_path.exists():
            rejection_counts["missing_normalized_image"] += 1
            continue
        if truth_key(name, num, setc) in holdout_truth_keys:
            rejection_counts["holdout_overlap_truthkey"] += 1
            continue
        if name_number_key(name, num) in holdout_nn_keys:
            rejection_counts["holdout_overlap_namenumber"] += 1
            continue
        accepted.append({
            "fixtureName": f"confirmed-{scan_id}",
            "fixturePath": str(normalized_path.parent),
            "fixtureRoot": str(artifact_root),
            "truthKey": truth_key(name, num, setc),
            "cardName": name,
            "collectorNumber": num,
            "setCode": setc,
            "normalizedImagePath": str(normalized_path),
            "providerSupported": True,
            "providerCardId": pid,
            "providerName": name,
            "providerCollectorNumber": num,
            "providerSetPtcgoCode": setc,
            "mappingConfidence": "high",
            "expansionHoldoutSelected": False,
            "rowSource": args.source_tag,
            "scanId": scan_id,
            "ownerUserId": row["owner_user_id"],
            "confirmedAt": row["confirmed_at"],
        })

    unique_pids = sorted({r["providerCardId"] for r in accepted})
    print()
    print(f"accepted: {len(accepted)} confirmed scans across {len(unique_pids)} unique cards")
    print(f"rejections: {rejection_counts}")
    if not accepted:
        print("(nothing to write)")
        return

    print()
    print("sample of accepted entries (first 5):")
    for entry in accepted[:5]:
        print(f"  {entry['providerCardId']:20s} {entry['cardName']!r:30s} {entry['collectorNumber']:10s} {entry['setCode']:6s} {Path(entry['normalizedImagePath']).name}")

    if not args.apply:
        print()
        print("DRY-RUN — no file written. Re-run with --apply to write the JSONL.")
        return

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w") as f:
        for entry in accepted:
            f.write(json.dumps(entry) + "\n")
    print()
    print(f"WROTE: {output_path}  ({len(accepted)} rows)")
    print()
    print("To rebuild the rerank pool with confirmed-scan rows added:")
    print("  python3 tools/build_user_photo_rerank_pool.py \\")
    print(f"    --training-manifest {output_path} \\")
    print("    --artifact-version v002")
    print()
    print("To merge with the existing training manifest, concatenate first:")
    print("  cat ~/spotlight-datasets/raw-visual-train/raw_visual_training_manifest.jsonl \\")
    print(f"      {output_path} > /tmp/combined_manifest.jsonl")
    print("  python3 tools/build_user_photo_rerank_pool.py \\")
    print("    --training-manifest /tmp/combined_manifest.jsonl \\")
    print("    --artifact-version v002")


if __name__ == "__main__":
    main()
