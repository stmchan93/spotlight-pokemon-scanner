from __future__ import annotations

import sqlite3
import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import _relax_scan_artifacts_nullability  # noqa: E402

# The pre-fix shape: both object-path columns NOT NULL.
OLD_SCHEMA = """
CREATE TABLE scan_events (scan_id TEXT PRIMARY KEY);
CREATE TABLE scan_artifacts (
    scan_id TEXT PRIMARY KEY REFERENCES scan_events(scan_id) ON DELETE CASCADE,
    owner_user_id TEXT,
    source_object_path TEXT NOT NULL,
    normalized_object_path TEXT NOT NULL,
    source_width INTEGER,
    source_height INTEGER,
    normalized_width INTEGER,
    normalized_height INTEGER,
    camera_zoom_factor REAL,
    capture_source TEXT,
    upload_status TEXT NOT NULL,
    uploaded_at TEXT,
    artifact_version TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_scan_artifacts_owner_user_id ON scan_artifacts(owner_user_id, created_at DESC);
"""


def _notnull(connection: sqlite3.Connection, table: str, column: str) -> int:
    for row in connection.execute(f"PRAGMA table_info({table})"):
        if row[1] == column:
            return int(row[3])
    raise AssertionError(f"{column} not found on {table}")


class ScanArtifactsNullabilityMigrationTests(unittest.TestCase):
    def test_relaxes_notnull_preserves_rows_and_is_idempotent(self) -> None:
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.executescript(OLD_SCHEMA)
        connection.execute("INSERT INTO scan_events(scan_id) VALUES ('s1')")
        connection.execute(
            "INSERT INTO scan_artifacts(scan_id, source_object_path, normalized_object_path, "
            "upload_status, artifact_version, created_at) "
            "VALUES ('s1', 'src/path', 'norm/path', 'uploaded', 'v1', '2026-05-24T00:00:00Z')"
        )
        connection.commit()
        self.assertEqual(_notnull(connection, "scan_artifacts", "source_object_path"), 1)

        _relax_scan_artifacts_nullability(connection)

        # Constraints relaxed.
        self.assertEqual(_notnull(connection, "scan_artifacts", "source_object_path"), 0)
        self.assertEqual(_notnull(connection, "scan_artifacts", "normalized_object_path"), 0)
        # Existing row preserved.
        row = connection.execute(
            "SELECT source_object_path, normalized_object_path, upload_status FROM scan_artifacts WHERE scan_id='s1'"
        ).fetchone()
        self.assertEqual(tuple(row), ("src/path", "norm/path", "uploaded"))
        # Index recreated.
        idx = connection.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_scan_artifacts_owner_user_id'"
        ).fetchone()
        self.assertIsNotNone(idx)
        # Normalized-only and failed rows are now insertable.
        connection.execute("INSERT INTO scan_events(scan_id) VALUES ('s2')")
        connection.execute(
            "INSERT INTO scan_artifacts(scan_id, source_object_path, normalized_object_path, "
            "upload_status, artifact_version, created_at) VALUES ('s2', NULL, 'norm/2', 'normalized_only', 'v1', 't')"
        )
        connection.execute("INSERT INTO scan_events(scan_id) VALUES ('s3')")
        connection.execute(
            "INSERT INTO scan_artifacts(scan_id, source_object_path, normalized_object_path, "
            "upload_status, artifact_version, created_at) VALUES ('s3', NULL, NULL, 'failed', 'v1', 't')"
        )
        connection.commit()

        # Idempotent: second run is a no-op (already relaxed).
        _relax_scan_artifacts_nullability(connection)
        self.assertEqual(_notnull(connection, "scan_artifacts", "source_object_path"), 0)
        self.assertEqual(
            connection.execute("SELECT COUNT(*) FROM scan_artifacts").fetchone()[0], 3
        )

    def test_noop_when_already_relaxed(self) -> None:
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.executescript(
            "CREATE TABLE scan_artifacts ("
            "scan_id TEXT PRIMARY KEY, source_object_path TEXT, normalized_object_path TEXT, "
            "upload_status TEXT NOT NULL, artifact_version TEXT NOT NULL, created_at TEXT NOT NULL)"
        )
        # Must not raise and must not rebuild.
        _relax_scan_artifacts_nullability(connection)
        self.assertEqual(_notnull(connection, "scan_artifacts", "source_object_path"), 0)


if __name__ == "__main__":
    unittest.main()
