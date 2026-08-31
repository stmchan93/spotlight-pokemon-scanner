#!/usr/bin/env python3
"""Export normal scan captures into a human/AI review worksheet for labeling.

Unlike labeling sessions (which carry a label already), normal scans only have a
prediction. This tool pulls each scan's normalized_target.jpg from GCS to a local
review dir and emits a CSV with the model's top-10 so a human (optionally with AI
help) can fill in `chosen_card_id`. Add-to-deck confirmations are pre-filled.

The reviewed CSV is then consumed by tools/import_confirmed_scans_to_training.py.

Example (staging snapshot in GCS):
  python3 tools/export_scan_training_rows.py \
    --db backend/data/spotlight_scanner.local.sqlite \
    --storage gcs --gcs-bucket looty-staging \
    --since 2026-05-23 --until 2026-05-25 --include-unconfirmed
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "tools"))

from export_labeling_sessions_batch import (  # noqa: E402
    SCAN_ARTIFACTS_GCS_BUCKET_ENV,
    SCAN_ARTIFACTS_ROOT_ENV,
    SCAN_ARTIFACTS_STORAGE_ENV,
    copy_artifact,
    default_artifact_root,
    default_database_path,
    open_database,
    set_code_for_row,
    storage_mode,
    utc_now_iso,
)

# Artifact rows whose normalized image is actually present.
USABLE_UPLOAD_STATUSES = ("uploaded", "normalized_only")


def parse_windows(raw_windows: list[str]) -> list[tuple[str, str]]:
    windows: list[tuple[str, str]] = []
    for raw in raw_windows:
        start, sep, end = str(raw).partition("..")
        if not sep or not start.strip() or not end.strip():
            raise SystemExit(f"--window must look like START..END (got {raw!r})")
        windows.append((start.strip(), end.strip()))
    return windows


def select_scan_rows(
    connection,
    *,
    since: str | None,
    until: str | None,
    windows: list[tuple[str, str]] | None = None,
    owner_user_ids: list[str],
    include_unconfirmed: bool,
) -> list[Any]:
    predicates = ["e.resolver_mode = 'raw_card'"]
    params: list[Any] = []
    if since:
        predicates.append("e.created_at >= ?")
        params.append(since)
    if until:
        predicates.append("e.created_at < ?")
        params.append(until)
    if windows:
        # Repeatable disjoint capture windows (e.g. three show weekends): a scan
        # matches if it falls inside ANY window. Combined with since/until by AND.
        clauses = []
        for window_start, window_end in windows:
            clauses.append("(e.created_at >= ? AND e.created_at < ?)")
            params.extend([window_start, window_end])
        predicates.append("(" + " OR ".join(clauses) + ")")
    if owner_user_ids:
        placeholders = ", ".join("?" for _ in owner_user_ids)
        predicates.append(f"e.owner_user_id IN ({placeholders})")
        params.extend(owner_user_ids)
    if not include_unconfirmed:
        predicates.append("e.confirmed_card_id IS NOT NULL AND e.confirmed_card_id <> ''")

    status_placeholders = ", ".join("?" for _ in USABLE_UPLOAD_STATUSES)
    params_with_status = list(params) + list(USABLE_UPLOAD_STATUSES)
    query = f"""
        SELECT
            e.scan_id,
            e.created_at,
            e.owner_user_id,
            e.predicted_card_id,
            e.confirmed_card_id,
            a.normalized_object_path,
            a.upload_status,
            pc.name AS predicted_card_name,
            cc.name AS confirmed_card_name
        FROM scan_events e
        JOIN scan_artifacts a ON a.scan_id = e.scan_id
        LEFT JOIN cards pc ON pc.id = e.predicted_card_id
        LEFT JOIN cards cc ON cc.id = e.confirmed_card_id
        WHERE {" AND ".join(predicates)}
          AND a.normalized_object_path IS NOT NULL
          AND a.upload_status IN ({status_placeholders})
        ORDER BY e.owner_user_id, e.created_at, e.scan_id
    """
    return list(connection.execute(query, params_with_status))


def top_candidates_for_scan(connection, scan_id: str) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT spc.rank, spc.card_id, spc.final_score, spc.candidate_json, c.name, c.number,
               c.set_ptcgo_code, c.set_id, c.set_name
        FROM scan_prediction_candidates spc
        LEFT JOIN cards c ON c.id = spc.card_id
        WHERE spc.scan_id = ?
        ORDER BY spc.rank ASC
        LIMIT 10
        """,
        (scan_id,),
    ).fetchall()
    candidates: list[dict[str, Any]] = []
    for row in rows:
        # Prefer the local cards row; fall back to the candidate_json snapshot
        # (covers candidates whose card isn't in the local catalog mirror).
        name = row["name"]
        number = row["number"]
        set_code = set_code_for_row(row) if name is not None else None
        if name is None and row["candidate_json"]:
            try:
                snapshot = json.loads(row["candidate_json"])
                name = snapshot.get("name")
                number = snapshot.get("number")
                set_code = snapshot.get("setName") or snapshot.get("setPtcgoCode")
            except (TypeError, ValueError):
                pass
        candidates.append(
            {
                "rank": int(row["rank"]) if row["rank"] is not None else None,
                "card_id": str(row["card_id"] or ""),
                "name": name,
                "number": number,
                "set": set_code,
            }
        )
    return candidates


def deduplicate_bursts(rows: list[Any], *, window_seconds: int = 5) -> tuple[list[Any], list[dict[str, Any]]]:
    """Drop near-simultaneous repeats of the same predicted card by one owner."""
    kept: list[Any] = []
    dropped: list[dict[str, Any]] = []
    last_by_key: dict[str, datetime] = {}
    for row in rows:
        owner = str(row["owner_user_id"] or "")
        predicted = str(row["predicted_card_id"] or "")
        key = f"{owner}|{predicted}"
        created_raw = str(row["created_at"] or "").replace("Z", "+00:00")
        try:
            created = datetime.fromisoformat(created_raw)
        except ValueError:
            kept.append(row)
            continue
        previous = last_by_key.get(key)
        if previous is not None and predicted and abs((created - previous).total_seconds()) <= window_seconds:
            dropped.append({"scanID": row["scan_id"], "reason": "burst_duplicate", "predictedCardId": predicted})
            continue
        last_by_key[key] = created
        kept.append(row)
    return kept, dropped


def main() -> int:
    parser = argparse.ArgumentParser(description="Export normal scans into a review worksheet for labeling + training.")
    parser.add_argument("--db", default=str(default_database_path()), help="SQLite snapshot path.")
    parser.add_argument("--artifact-root", default=str(default_artifact_root()))
    parser.add_argument("--storage", default=os.environ.get(SCAN_ARTIFACTS_STORAGE_ENV, "filesystem"))
    parser.add_argument("--gcs-bucket", default=os.environ.get(SCAN_ARTIFACTS_GCS_BUCKET_ENV))
    parser.add_argument("--since", help="Include scans with created_at >= this ISO date/time.")
    parser.add_argument("--until", help="Include scans with created_at < this ISO date/time.")
    parser.add_argument(
        "--window",
        action="append",
        default=[],
        metavar="START..END",
        help="Repeatable UTC window 'START..END' (ISO, END exclusive); a scan matches ANY window. Use for multi-show exports.",
    )
    parser.add_argument("--owner-user-id", action="append", default=[], help="Filter to owner. Repeatable.")
    parser.add_argument("--confirmed-only", dest="include_unconfirmed", action="store_false", default=False)
    parser.add_argument("--include-unconfirmed", dest="include_unconfirmed", action="store_true")
    parser.add_argument("--no-dedupe", dest="dedupe", action="store_false", default=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument(
        "--output-root",
        help="Defaults to ~/spotlight-datasets/raw-visual-train/scan-review-exports/<batch-id>.",
    )
    parser.add_argument(
        "--batch-id",
        default=f"scan-review-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
    )
    args = parser.parse_args()

    database_path = Path(args.db).expanduser().resolve()
    artifact_root = Path(args.artifact_root).expanduser().resolve()
    output_root = (
        Path(args.output_root).expanduser().resolve()
        if args.output_root
        else Path.home() / "spotlight-datasets" / "raw-visual-train" / "scan-review-exports" / args.batch_id
    )
    review_images = output_root / "images"
    csv_path = output_root / "scan_review.csv"
    summary_path = output_root / "export_summary.json"
    output_root.mkdir(parents=True, exist_ok=True)

    with open_database(database_path) as connection:
        rows = select_scan_rows(
            connection,
            since=args.since,
            until=args.until,
            windows=parse_windows(args.window),
            owner_user_ids=[v.strip() for v in args.owner_user_id if v.strip()],
            include_unconfirmed=args.include_unconfirmed,
        )
        dropped_bursts: list[dict[str, Any]] = []
        if args.dedupe:
            rows, dropped_bursts = deduplicate_bursts(rows)
        if args.limit is not None:
            rows = rows[: args.limit]

        exported: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        configured_storage = storage_mode(args.storage)

        with csv_path.open("w", newline="") as handle:
            fieldnames = [
                "scan_id", "created_at", "owner_user_id", "image_file", "normalized_object_path",
                "upload_status", "predicted_card_id", "predicted_card_name", "confirmed_card_id",
                "confirmed_card_name", "chosen_card_id", "top10_json", "notes",
            ]
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()

            for row in rows:
                scan_id = str(row["scan_id"])
                image_file = f"{scan_id}.jpg"
                try:
                    copy_artifact(
                        row["normalized_object_path"],
                        review_images / image_file,
                        artifact_root=artifact_root,
                        configured_storage_mode=configured_storage,
                        gcs_bucket=args.gcs_bucket,
                    )
                except Exception as exc:  # noqa: BLE001 - export audit, not a runtime path
                    skipped.append({"scanID": scan_id, "reason": f"image_unavailable: {exc}"})
                    continue

                candidates = top_candidates_for_scan(connection, scan_id)
                confirmed = str(row["confirmed_card_id"] or "").strip()
                writer.writerow(
                    {
                        "scan_id": scan_id,
                        "created_at": row["created_at"],
                        "owner_user_id": row["owner_user_id"],
                        "image_file": f"images/{image_file}",
                        "normalized_object_path": row["normalized_object_path"],
                        "upload_status": row["upload_status"],
                        "predicted_card_id": row["predicted_card_id"] or "",
                        "predicted_card_name": row["predicted_card_name"] or "",
                        "confirmed_card_id": confirmed,
                        "confirmed_card_name": row["confirmed_card_name"] or "",
                        # Pre-fill the gold confirmation; leave blank for review otherwise.
                        "chosen_card_id": confirmed,
                        "top10_json": json.dumps(candidates, separators=(",", ":")),
                        "notes": "",
                    }
                )
                exported.append({"scanID": scan_id, "confirmed": bool(confirmed)})

    summary = {
        "generatedAt": utc_now_iso(),
        "batchId": args.batch_id,
        "outputRoot": str(output_root),
        "reviewCsv": str(csv_path),
        "reviewImages": str(review_images),
        "exportedCount": len(exported),
        "prefilledConfirmedCount": sum(1 for item in exported if item["confirmed"]),
        "needsReviewCount": sum(1 for item in exported if not item["confirmed"]),
        "skippedCount": len(skipped),
        "skipped": skipped[:50],
        "burstDuplicatesDropped": len(dropped_bursts),
        "importCommand": [
            "python3", "tools/import_confirmed_scans_to_training.py",
            "--csv", str(csv_path), "--db", str(database_path), "--run-batch",
        ],
    }
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
