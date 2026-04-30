#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scan_artifact_store import (  # noqa: E402
    SCAN_ARTIFACTS_GCS_BUCKET_ENV,
    SCAN_ARTIFACTS_ROOT_ENV,
    SCAN_ARTIFACTS_STORAGE_ENV,
)


SAFE_FILENAME_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_filename_part(value: object, *, fallback: str) -> str:
    cleaned = SAFE_FILENAME_PATTERN.sub("_", str(value or "").strip()).strip("._-")
    return cleaned or fallback


def default_database_path() -> Path:
    return REPO_ROOT / "backend" / "data" / "spotlight_scanner.sqlite"


def default_artifact_root() -> Path:
    return Path(os.environ.get(SCAN_ARTIFACTS_ROOT_ENV) or REPO_ROOT / "backend" / "data" / "scan-artifacts").expanduser()


def default_output_root(batch_id: str) -> Path:
    return Path.home() / "spotlight-datasets" / "raw-visual-train" / "labeling-session-exports" / batch_id


def storage_mode(value: str | None) -> str:
    return str(value or "filesystem").strip().lower() or "filesystem"


def open_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def load_completed_artifacts(
    connection: sqlite3.Connection,
    *,
    session_ids: list[str],
    since: str | None,
    limit: int | None,
) -> list[sqlite3.Row]:
    predicates = ["s.status = 'completed'"]
    params: list[Any] = []
    if session_ids:
        placeholders = ", ".join("?" for _ in session_ids)
        predicates.append(f"s.session_id IN ({placeholders})")
        params.extend(session_ids)
    if since:
        predicates.append("COALESCE(s.completed_at, s.updated_at, s.created_at) >= ?")
        params.append(since)

    query = f"""
        SELECT
            s.session_id,
            s.card_id,
            s.provider_card_id,
            s.tier_assignment,
            s.routed_batch_id,
            s.completed_at,
            s.created_at AS session_created_at,
            a.id AS artifact_id,
            a.angle_index,
            a.angle_label,
            a.scan_id,
            a.dataset_role,
            a.source_object_path,
            a.normalized_object_path,
            a.submitted_at,
            c.name AS card_name,
            c.number AS collector_number,
            c.set_name,
            c.set_id,
            c.set_ptcgo_code,
            c.source_provider,
            c.source_record_id
        FROM labeling_sessions s
        JOIN labeling_session_artifacts a ON a.session_id = s.session_id
        JOIN cards c ON c.id = s.card_id
        WHERE {" AND ".join(predicates)}
        ORDER BY COALESCE(s.completed_at, s.updated_at, s.created_at), s.session_id, a.angle_index
    """
    if limit is not None:
        query += "\n        LIMIT ?"
        params.append(limit)
    return list(connection.execute(query, params))


def download_gcs_object(*, bucket_name: str, object_name: str, destination: Path) -> None:
    try:
        from google.cloud import storage as gcs_storage
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise SystemExit(
            "google-cloud-storage is required to export GCS-backed labeling artifacts. "
            "Install it or run this tool against a local filesystem mirror."
        ) from exc

    client = gcs_storage.Client()
    bucket = client.bucket(bucket_name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    bucket.blob(object_name).download_to_filename(str(destination))


def parse_gcs_path(path: str, *, default_bucket: str | None) -> tuple[str, str]:
    if path.startswith("gs://"):
        without_scheme = path.removeprefix("gs://")
        bucket, _, object_name = without_scheme.partition("/")
        if not bucket or not object_name:
            raise ValueError(f"Invalid GCS object path: {path}")
        return bucket, object_name

    bucket = str(default_bucket or "").strip()
    if not bucket:
        raise ValueError("A GCS bucket is required for object paths stored without gs:// prefix.")
    return bucket, path.strip("/")


def copy_artifact(
    object_path: str,
    destination: Path,
    *,
    artifact_root: Path,
    configured_storage_mode: str,
    gcs_bucket: str | None,
) -> None:
    normalized_path = str(object_path or "").strip()
    if not normalized_path:
        raise ValueError("artifact object path is empty")

    if configured_storage_mode in {"gcs", "google-cloud-storage", "google_cloud_storage"} or normalized_path.startswith("gs://"):
        bucket_name, object_name = parse_gcs_path(normalized_path, default_bucket=gcs_bucket)
        download_gcs_object(bucket_name=bucket_name, object_name=object_name, destination=destination)
        return

    source_path = Path(normalized_path).expanduser()
    if not source_path.is_absolute():
        source_path = artifact_root / source_path
    if not source_path.exists():
        raise FileNotFoundError(f"Artifact file not found: {source_path}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, destination)


def set_code_for_row(row: sqlite3.Row) -> str:
    for key in ("set_ptcgo_code", "set_id", "set_name"):
        value = str(row[key] or "").strip()
        if value:
            return value
    return "UNKNOWN"


def export_rows(
    rows: list[sqlite3.Row],
    *,
    batch_id: str,
    output_root: Path,
    artifact_root: Path,
    configured_storage_mode: str,
    gcs_bucket: str | None,
) -> dict[str, Any]:
    photos_root = output_root / "photos"
    source_root = output_root / "source-captures"
    spreadsheet_path = output_root / "cards.tsv"
    summary_path = output_root / "export_summary.json"
    output_root.mkdir(parents=True, exist_ok=True)

    exported_rows: list[dict[str, Any]] = []
    skipped_rows: list[dict[str, Any]] = []

    with spreadsheet_path.open("w", newline="") as handle:
        fieldnames = [
            "file_name",
            "card_name",
            "number",
            "set",
            "Promo",
            "labeling_session_id",
            "labeling_artifact_id",
            "card_id",
            "provider",
            "provider_card_id",
            "tier_assignment",
            "routed_batch_id",
            "angle_index",
            "angle_label",
            "scan_id",
            "dataset_role",
            "source_capture_file_name",
            "normalized_object_path",
            "source_object_path",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames, delimiter="\t")
        writer.writeheader()

        for row in rows:
            file_stem = "__".join(
                [
                    safe_filename_part(row["session_id"], fallback="session"),
                    f"angle_{int(row['angle_index']):02d}",
                    safe_filename_part(row["angle_label"], fallback="capture"),
                    safe_filename_part(row["artifact_id"], fallback="artifact"),
                ]
            )
            normalized_file_name = f"{file_stem}.jpg"
            source_file_name = f"{file_stem}__source.jpg"
            normalized_destination = photos_root / normalized_file_name
            source_destination = source_root / source_file_name

            try:
                copy_artifact(
                    row["normalized_object_path"],
                    normalized_destination,
                    artifact_root=artifact_root,
                    configured_storage_mode=configured_storage_mode,
                    gcs_bucket=gcs_bucket,
                )
                copy_artifact(
                    row["source_object_path"],
                    source_destination,
                    artifact_root=artifact_root,
                    configured_storage_mode=configured_storage_mode,
                    gcs_bucket=gcs_bucket,
                )
            except Exception as exc:  # noqa: BLE001 - this is an export audit, not a runtime path.
                skipped_rows.append(
                    {
                        "sessionID": row["session_id"],
                        "artifactID": row["artifact_id"],
                        "angleIndex": row["angle_index"],
                        "reason": str(exc),
                    }
                )
                continue

            metadata_row = {
                "file_name": normalized_file_name,
                "card_name": row["card_name"],
                "number": row["collector_number"],
                "set": set_code_for_row(row),
                "Promo": "",
                "labeling_session_id": row["session_id"],
                "labeling_artifact_id": row["artifact_id"],
                "card_id": row["card_id"],
                "provider": row["source_provider"],
                "provider_card_id": row["provider_card_id"] or row["source_record_id"] or row["card_id"],
                "tier_assignment": row["tier_assignment"] or row["dataset_role"] or "",
                "routed_batch_id": row["routed_batch_id"] or "",
                "angle_index": row["angle_index"],
                "angle_label": row["angle_label"],
                "scan_id": row["scan_id"] or "",
                "dataset_role": row["dataset_role"] or "",
                "source_capture_file_name": source_file_name,
                "normalized_object_path": row["normalized_object_path"],
                "source_object_path": row["source_object_path"],
            }
            writer.writerow(metadata_row)
            exported_rows.append(metadata_row)

    summary = {
        "generatedAt": utc_now_iso(),
        "outputRoot": str(output_root),
        "photoRoot": str(photos_root),
        "sourceCaptureRoot": str(source_root),
        "spreadsheetPath": str(spreadsheet_path),
        "exportedArtifactCount": len(exported_rows),
        "skippedArtifactCount": len(skipped_rows),
        "skipped": skipped_rows,
        "processBatchCommand": [
            "python3",
            "tools/process_raw_visual_batch.py",
            "--spreadsheet",
            str(spreadsheet_path),
            "--photo-root",
            str(photos_root),
            "--batch-id",
            batch_id,
            "--import-safe",
        ],
    }
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export completed labeler sessions into a raw visual batch for process_raw_visual_batch.py."
    )
    parser.add_argument("--database-path", default=str(default_database_path()))
    parser.add_argument("--artifact-root", default=str(default_artifact_root()))
    parser.add_argument("--storage", default=os.environ.get(SCAN_ARTIFACTS_STORAGE_ENV, "filesystem"))
    parser.add_argument("--gcs-bucket", default=os.environ.get(SCAN_ARTIFACTS_GCS_BUCKET_ENV))
    parser.add_argument("--output-root", help="Defaults to ~/spotlight-datasets/raw-visual-train/labeling-session-exports/<batch-id>.")
    parser.add_argument("--batch-id", default=f"labeling-sessions-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}")
    parser.add_argument("--session-id", action="append", default=[], help="Export only this completed session. Repeatable.")
    parser.add_argument("--since", help="Export sessions completed/updated at or after this ISO timestamp.")
    parser.add_argument("--limit", type=int, help="Optional maximum artifact rows to export.")
    args = parser.parse_args()

    database_path = Path(args.database_path).expanduser().resolve()
    artifact_root = Path(args.artifact_root).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve() if args.output_root else default_output_root(args.batch_id)

    if args.limit is not None and args.limit <= 0:
        raise SystemExit("--limit must be positive when provided")

    with open_database(database_path) as connection:
        rows = load_completed_artifacts(
            connection,
            session_ids=[str(value).strip() for value in args.session_id if str(value).strip()],
            since=args.since,
            limit=args.limit,
        )

    summary = export_rows(
        rows,
        batch_id=args.batch_id,
        output_root=output_root,
        artifact_root=artifact_root,
        configured_storage_mode=storage_mode(args.storage),
        gcs_bucket=args.gcs_bucket,
    )
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
