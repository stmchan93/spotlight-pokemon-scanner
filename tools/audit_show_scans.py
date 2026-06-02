#!/usr/bin/env python3
"""Read-only audit of scans captured on a given day (e.g. a card show).

Card-show captures have a history of dropping their images (client all-or-nothing
upload guard + phone memory pressure + backend throttling under load). Before
mobilizing labelers, run this to find out how many of the day's scans actually
landed with a usable normalized image versus how many are unlabelable.

This tool ONLY reads — it never writes to the DB or GCS.

Examples:
  # Count everything captured on 2026-05-31 (all owners), DB on the VM:
  python3 tools/audit_show_scans.py --db backend/data/spotlight_scanner.sqlite --date 2026-05-31

  # Just my scans, and actually HEAD-check that the normalized objects exist in GCS:
  python3 tools/audit_show_scans.py --date 2026-05-31 \
      --owner-user-id <me> \
      --check-gcs --storage gcs --gcs-bucket looty-staging
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import Counter
from datetime import date as date_cls, timedelta
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "tools"))

from export_labeling_sessions_batch import (  # noqa: E402
    SCAN_ARTIFACTS_GCS_BUCKET_ENV,
    SCAN_ARTIFACTS_STORAGE_ENV,
    default_database_path,
    open_database,
    parse_gcs_path,
    storage_mode,
)

# upload_status values whose normalized image is actually present and trainable.
USABLE_UPLOAD_STATUSES = ("uploaded", "normalized_only")


def _day_bounds(value: str) -> tuple[str, str]:
    """Return [since, until) ISO date strings spanning the single given day."""
    parsed = date_cls.fromisoformat(value)
    return parsed.isoformat(), (parsed + timedelta(days=1)).isoformat()


def _build_where(
    *,
    since: str | None,
    until: str | None,
    owner_user_ids: list[str],
) -> tuple[str, list[Any]]:
    predicates: list[str] = []
    params: list[Any] = []
    if since:
        predicates.append("e.created_at >= ?")
        params.append(since)
    if until:
        predicates.append("e.created_at < ?")
        params.append(until)
    if owner_user_ids:
        placeholders = ", ".join("?" for _ in owner_user_ids)
        predicates.append(f"e.owner_user_id IN ({placeholders})")
        params.extend(owner_user_ids)
    where = (" WHERE " + " AND ".join(predicates)) if predicates else ""
    return where, params


def _pct(part: int, whole: int) -> str:
    if whole <= 0:
        return "0.0%"
    return f"{(100.0 * part / whole):.1f}%"


def audit(connection, *, since: str | None, until: str | None, owner_user_ids: list[str]) -> dict[str, Any]:
    where, params = _build_where(since=since, until=until, owner_user_ids=owner_user_ids)

    # One pass over the day's scans, LEFT JOIN so scans whose artifact row never
    # persisted (image fully dropped) still show up.
    rows = connection.execute(
        f"""
        SELECT
            e.scan_id,
            e.owner_user_id,
            e.resolver_mode,
            e.predicted_card_id,
            e.confirmed_card_id,
            a.upload_status,
            a.normalized_object_path,
            a.source_object_path,
            (SELECT COUNT(*) FROM scan_prediction_candidates spc WHERE spc.scan_id = e.scan_id) AS candidate_count
        FROM scan_events e
        LEFT JOIN scan_artifacts a ON a.scan_id = e.scan_id
        {where}
        ORDER BY e.created_at, e.scan_id
        """,
        params,
    ).fetchall()

    total = len(rows)
    by_status: Counter[str] = Counter()
    by_lane: Counter[str] = Counter()
    owners: set[str] = set()
    distinct_predicted: set[str] = set()
    labelable_rows: list[Any] = []
    confirmed = 0
    has_top10 = 0
    normalized_missing_path = 0  # artifact row exists, usable status, but no normalized path

    for row in rows:
        status = (row["upload_status"] or "(no artifact row)").strip() or "(no artifact row)"
        by_status[status] += 1
        by_lane[(row["resolver_mode"] or "(unknown)")] += 1
        if row["owner_user_id"]:
            owners.add(str(row["owner_user_id"]))
        if row["predicted_card_id"]:
            distinct_predicted.add(str(row["predicted_card_id"]))
        if row["confirmed_card_id"]:
            confirmed += 1
        if (row["candidate_count"] or 0) > 0:
            has_top10 += 1

        is_usable_status = (row["upload_status"] or "") in USABLE_UPLOAD_STATUSES
        has_normalized = bool((row["normalized_object_path"] or "").strip())
        if is_usable_status and has_normalized:
            labelable_rows.append(row)
        elif is_usable_status and not has_normalized:
            normalized_missing_path += 1

    return {
        "total": total,
        "owners": sorted(owners),
        "by_status": by_status,
        "by_lane": by_lane,
        "distinct_predicted": len(distinct_predicted),
        "confirmed": confirmed,
        "has_top10": has_top10,
        "normalized_missing_path": normalized_missing_path,
        "labelable_rows": labelable_rows,
    }


def check_gcs(labelable_rows: list[Any], *, bucket: str, sample: int) -> dict[str, Any]:
    """HEAD-check that normalized objects actually exist in the bucket.

    The DB recording an 'uploaded' status does not guarantee the object survived
    in GCS, so this catches the worst case: row says uploaded, object is gone.
    """
    try:
        from google.cloud import storage as gcs_storage
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise SystemExit(
            "google-cloud-storage is required for --check-gcs. Install it or drop the flag."
        ) from exc

    targets = labelable_rows if sample <= 0 else labelable_rows[:sample]
    client = gcs_storage.Client()
    bucket_obj = client.bucket(bucket)

    present = 0
    missing: list[str] = []
    for row in targets:
        bucket_name, object_name = parse_gcs_path(
            str(row["normalized_object_path"]), default_bucket=bucket
        )
        target_bucket = bucket_obj if bucket_name == bucket else client.bucket(bucket_name)
        if target_bucket.blob(object_name).exists(client):
            present += 1
        else:
            missing.append(str(row["scan_id"]))

    return {"checked": len(targets), "present": present, "missing": missing}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=default_database_path(), help="Path to the scan SQLite DB.")
    parser.add_argument("--date", help="Single day to audit, e.g. 2026-05-31 (sets --since/--until).")
    parser.add_argument("--since", help="ISO lower bound on created_at (inclusive). Ignored if --date is set.")
    parser.add_argument("--until", help="ISO upper bound on created_at (exclusive). Ignored if --date is set.")
    parser.add_argument(
        "--owner-user-id",
        action="append",
        default=[],
        dest="owner_user_ids",
        help="Restrict to one or more owner user ids (repeatable). Omit for all owners.",
    )
    parser.add_argument(
        "--check-gcs",
        action="store_true",
        help="HEAD-check that normalized objects actually exist in the bucket (needs creds).",
    )
    parser.add_argument(
        "--storage",
        default=os.environ.get(SCAN_ARTIFACTS_STORAGE_ENV),
        help="Storage mode (filesystem|gcs). Defaults to the backend env var.",
    )
    parser.add_argument(
        "--gcs-bucket",
        default=os.environ.get(SCAN_ARTIFACTS_GCS_BUCKET_ENV),
        help="GCS bucket for --check-gcs. Defaults to the backend env var.",
    )
    parser.add_argument(
        "--gcs-sample",
        type=int,
        default=200,
        help="How many labelable rows to HEAD-check (<=0 checks all). Default 200.",
    )
    args = parser.parse_args()

    since, until = args.since, args.until
    if args.date:
        since, until = _day_bounds(args.date)

    if not args.db.exists():
        print(f"error: DB not found at {args.db}", file=sys.stderr)
        return 2

    connection = open_database(args.db)
    try:
        result = audit(connection, since=since, until=until, owner_user_ids=args.owner_user_ids)
    finally:
        connection.close()

    total = result["total"]
    labelable = len(result["labelable_rows"])

    scope = args.date or f"{since or '(start)'}..{until or '(end)'}"
    owner_scope = ", ".join(args.owner_user_ids) if args.owner_user_ids else "all owners"
    print(f"\n=== Show-scan audit — {scope} — {owner_scope} ===")
    print(f"DB: {args.db}")
    print(f"\nTotal scan_events in scope: {total}")
    if total == 0:
        print("\nNo scans matched. Double-check the date, owner id, and that this is the right DB.")
        return 0

    print(f"Distinct owners: {len(result['owners'])}")
    print(f"Distinct predicted cards (rough unique-card / repeat sense): {result['distinct_predicted']}")
    print(f"Already have confirmed_card_id (labeled): {result['confirmed']} ({_pct(result['confirmed'], total)})")
    print(f"Have top-10 candidates stored: {result['has_top10']} ({_pct(result['has_top10'], total)})")

    print("\nLane (resolver_mode):")
    for lane, count in result["by_lane"].most_common():
        print(f"  {lane:<22} {count:>6}  ({_pct(count, total)})")

    print("\nArtifact upload_status (this is the image-drop story):")
    for status, count in result["by_status"].most_common():
        print(f"  {status:<22} {count:>6}  ({_pct(count, total)})")
    if result["normalized_missing_path"]:
        print(f"  (note: {result['normalized_missing_path']} rows have a usable status but NO normalized path)")

    print("\n--- Bottom line ---")
    print(f"LABELABLE now (usable normalized image): {labelable} ({_pct(labelable, total)})")
    print(f"NOT labelable (failed / no artifact row / no normalized image): {total - labelable} ({_pct(total - labelable, total)})")
    to_label = labelable - result["confirmed"]
    print(f"Still need a label (labelable minus already-confirmed): {max(0, to_label)}")

    if args.check_gcs:
        storage = storage_mode(args.storage)
        if storage not in {"gcs", "google-cloud-storage", "google_cloud_storage"}:
            print("\n--check-gcs given but --storage is not gcs; skipping object existence check.")
        elif not args.gcs_bucket:
            print(f"\n--check-gcs given but no bucket; set --gcs-bucket or {SCAN_ARTIFACTS_GCS_BUCKET_ENV}.")
        else:
            print(f"\nHEAD-checking normalized objects in gs://{args.gcs_bucket} ...")
            gcs = check_gcs(result["labelable_rows"], bucket=args.gcs_bucket, sample=args.gcs_sample)
            print(f"  checked: {gcs['checked']}  present: {gcs['present']}  missing: {len(gcs['missing'])}")
            if gcs["missing"]:
                preview = ", ".join(gcs["missing"][:10])
                more = "" if len(gcs["missing"]) <= 10 else f" (+{len(gcs['missing']) - 10} more)"
                print(f"  DB says uploaded but object is GONE for scan_ids: {preview}{more}")

    print(
        "\nNext: if the labelable count looks healthy, run tools/export_scan_training_rows.py "
        "with --include-unconfirmed for the same date to produce the review worksheet."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
