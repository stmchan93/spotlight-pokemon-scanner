from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scan_artifact_store import (  # noqa: E402
    FilesystemScanArtifactStore,
    GoogleCloudScanArtifactStore,
    _labeling_session_artifact_root,
    _safe_path_segment,
    build_scan_artifact_store,
)


class _FakeBlob:
    def __init__(self) -> None:
        self.uploads: list[dict[str, object]] = []

    def upload_from_string(self, data: bytes, *, content_type: str) -> None:
        self.uploads.append({"data": data, "content_type": content_type})


class _FakeBucket:
    def __init__(self, name: str) -> None:
        self.name = name
        self.blobs: dict[str, _FakeBlob] = {}

    def blob(self, name: str) -> _FakeBlob:
        return self.blobs.setdefault(name, _FakeBlob())


class _FakeGCSClient:
    def __init__(self) -> None:
        self.bucket_calls: list[str] = []
        self.buckets: dict[str, _FakeBucket] = {}

    def bucket(self, name: str) -> _FakeBucket:
        self.bucket_calls.append(name)
        return self.buckets.setdefault(name, _FakeBucket(name))


class ScanArtifactStoreHelperTests(unittest.TestCase):
    def test_safe_path_segment_and_labeling_root_normalize_values(self) -> None:
        self.assertEqual(_safe_path_segment("  Misty's Tears / JP  ", fallback="fallback"), "Misty_s_Tears_JP")
        self.assertEqual(_safe_path_segment("", fallback="fallback"), "fallback")
        self.assertEqual(
            _labeling_session_artifact_root(
                session_id="session/1",
                angle_index=2,
                angle_label="Front Left",
            ).as_posix(),
            "labeling-sessions/session_1/angle_02_Front_Left",
        )

    def test_filesystem_store_writes_scan_and_labeling_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir_str:
            root = Path(tempdir_str)
            store = FilesystemScanArtifactStore(root)

            stored_scan = store.store(
                scan_id="scan-1",
                source_bytes=b"source",
                normalized_bytes=b"normalized",
                year="2026",
                month="05",
                day="05",
            )
            stored_labeling = store.store_labeling_session_artifact(
                session_id="session-1",
                angle_index=1,
                angle_label="Top Right",
                source_bytes=b"source-labeling",
                normalized_bytes=b"normalized-labeling",
            )

            self.assertEqual(stored_scan.source_object_path, "scans/2026/05/05/scan-1/source_capture.jpg")
            self.assertEqual((root / stored_scan.source_object_path).read_bytes(), b"source")
            self.assertEqual((root / stored_scan.normalized_object_path).read_bytes(), b"normalized")
            self.assertEqual(
                stored_labeling.normalized_object_path,
                "labeling-sessions/session-1/angle_01_Top_Right/normalized_target.jpg",
            )
            self.assertEqual((root / stored_labeling.source_object_path).read_bytes(), b"source-labeling")

    def test_gcs_store_uses_prefix_and_reports_debug_status(self) -> None:
        client = _FakeGCSClient()
        store = GoogleCloudScanArtifactStore("artifact-bucket", client=client, object_prefix="private/scans")

        stored = store.store_labeling_session_artifact(
            session_id="session-2",
            angle_index=0,
            angle_label="Front",
            source_bytes=b"source",
            normalized_bytes=b"normalized",
        )

        self.assertEqual(client.bucket_calls, ["artifact-bucket"])
        self.assertEqual(
            store.debug_status(),
            {
                "storage": "gcs",
                "filesystemRoot": None,
                "activeBucketName": "artifact-bucket",
                "objectPrefix": "private/scans",
                "activeTarget": "gs://artifact-bucket/private/scans",
            },
        )
        self.assertEqual(
            stored.source_object_path,
            "private/scans/labeling-sessions/session-2/angle_00_Front/source_capture.jpg",
        )
        bucket = client.buckets["artifact-bucket"]
        self.assertEqual(
            bucket.blobs[stored.normalized_object_path].uploads[0],
            {"data": b"normalized", "content_type": "image/jpeg"},
        )

    def test_build_store_supports_aliases_and_validates_modes(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir_str:
            repo_root = Path(tempdir_str)
            local_store = build_scan_artifact_store(
                repo_root=repo_root,
                storage_override="file",
                root_override="~/tmp/spotlight-artifacts",
            )
            self.assertIsInstance(local_store, FilesystemScanArtifactStore)
            self.assertTrue(str(local_store.root).endswith("tmp/spotlight-artifacts"))

        fake_client = _FakeGCSClient()
        gcs_store = build_scan_artifact_store(
            repo_root=Path("/tmp/repo"),
            storage_override="google_cloud_storage",
            gcs_bucket_override="bucket-1",
            gcs_client=fake_client,
        )
        self.assertIsInstance(gcs_store, GoogleCloudScanArtifactStore)

        with self.assertRaisesRegex(ValueError, "required when storage is set to gcs"):
            build_scan_artifact_store(repo_root=Path("/tmp/repo"), storage_override="gcs")

        with self.assertRaisesRegex(ValueError, "must be filesystem or gcs"):
            build_scan_artifact_store(repo_root=Path("/tmp/repo"), storage_override="unknown")


if __name__ == "__main__":
    unittest.main()
