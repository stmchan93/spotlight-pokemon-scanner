#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def default_database_path() -> Path:
    repo_root = Path(__file__).resolve().parent.parent
    backend_database = repo_root / "backend" / "data" / "spotlight_scanner.sqlite"
    if backend_database.exists():
        return backend_database
    return repo_root / "data" / "spotlight_scanner.sqlite"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Backfill one labeling session and its artifact scan owners.")
    parser.add_argument("--database-path", type=Path, default=default_database_path())
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--owner-user-id", required=True)
    parser.add_argument("--expected-current-owner", default="legacy-owner")
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    database_path = args.database_path.expanduser().resolve()
    if not database_path.exists():
        raise SystemExit(f"Database not found: {database_path}")

    session_id = args.session_id.strip()
    owner_user_id = args.owner_user_id.strip()
    expected_current_owner = args.expected_current_owner.strip()
    if not session_id:
        raise SystemExit("--session-id is required")
    if not owner_user_id:
        raise SystemExit("--owner-user-id is required")

    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    try:
        session_row = connection.execute(
            """
            SELECT session_id, labeler_user_id, card_id, status
            FROM labeling_sessions
            WHERE session_id = ?
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()
        if session_row is None:
            raise SystemExit(f"Labeling session not found: {session_id}")

        current_owner = str(session_row["labeler_user_id"] or "").strip()
        if current_owner == owner_user_id:
            status = "already_backfilled"
        elif current_owner != expected_current_owner:
            raise SystemExit(
                f"Refusing to update {session_id}: current owner is {current_owner!r}, "
                f"expected {expected_current_owner!r}"
            )
        else:
            status = "would_backfill" if args.dry_run else "backfilled"

        scan_ids = [
            str(row["scan_id"] or "").strip()
            for row in connection.execute(
                """
                SELECT scan_id
                FROM labeling_session_artifacts
                WHERE session_id = ? AND scan_id IS NOT NULL AND scan_id != ''
                ORDER BY angle_index
                """,
                (session_id,),
            )
            if str(row["scan_id"] or "").strip()
        ]

        backup_path = None
        session_rows_updated = 0
        scan_event_rows_updated = 0
        scan_artifact_rows_updated = 0
        if status == "backfilled":
            backup_dir = (args.backup_dir.expanduser().resolve() if args.backup_dir else database_path.parent / "backups")
            backup_dir.mkdir(parents=True, exist_ok=True)
            backup_path = backup_dir / (
                f"{database_path.stem}_pre_labeler_backfill_"
                f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}{database_path.suffix}"
            )
            shutil.copy2(database_path, backup_path)

            connection.execute("BEGIN")
            try:
                session_rows_updated = connection.execute(
                    """
                    UPDATE labeling_sessions
                    SET labeler_user_id = ?, updated_at = ?
                    WHERE session_id = ? AND labeler_user_id = ?
                    """,
                    (owner_user_id, utc_now_iso(), session_id, expected_current_owner),
                ).rowcount
                if scan_ids:
                    placeholders = ",".join("?" for _ in scan_ids)
                    scan_event_rows_updated = connection.execute(
                        f"""
                        UPDATE scan_events
                        SET owner_user_id = ?
                        WHERE owner_user_id = ?
                          AND scan_id IN ({placeholders})
                        """,
                        (owner_user_id, expected_current_owner, *scan_ids),
                    ).rowcount
                    scan_artifact_rows_updated = connection.execute(
                        f"""
                        UPDATE scan_artifacts
                        SET owner_user_id = ?
                        WHERE owner_user_id = ?
                          AND scan_id IN ({placeholders})
                        """,
                        (owner_user_id, expected_current_owner, *scan_ids),
                    ).rowcount
                connection.commit()
            except Exception:
                connection.rollback()
                raise

        print(
            json.dumps(
                {
                    "status": status,
                    "databasePath": str(database_path),
                    "backupPath": str(backup_path) if backup_path else None,
                    "sessionID": session_id,
                    "previousOwnerUserID": current_owner,
                    "ownerUserID": owner_user_id,
                    "scanIDs": scan_ids,
                    "sessionRowsUpdated": session_rows_updated,
                    "scanEventRowsUpdated": scan_event_rows_updated,
                    "scanArtifactRowsUpdated": scan_artifact_rows_updated,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
