from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Any, Protocol

try:
    from google.cloud import storage as gcs_storage
except ImportError:  # pragma: no cover - optional dependency
    gcs_storage = None


SCAN_ARTIFACTS_STORAGE_ENV = "SPOTLIGHT_SCAN_ARTIFACTS_STORAGE"
SCAN_ARTIFACTS_ROOT_ENV = "SPOTLIGHT_SCAN_ARTIFACTS_ROOT"
SCAN_ARTIFACTS_GCS_BUCKET_ENV = "SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET"


_SAFE_PATH_SEGMENT_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True)
class StoredScanArtifacts:
    source_object_path: str
    normalized_object_path: str


class ScanArtifactStore(Protocol):
    @property
    def storage_kind(self) -> str:
        ...

    def debug_status(self) -> dict[str, Any]:
        ...

    def store(
        self,
        *,
        scan_id: str,
        source_bytes: bytes,
        normalized_bytes: bytes,
        year: str,
        month: str,
        day: str,
    ) -> StoredScanArtifacts:
        ...

    def store_labeling_session_artifact(
        self,
        *,
        session_id: str,
        angle_index: int,
        angle_label: str,
        source_bytes: bytes,
        normalized_bytes: bytes,
    ) -> StoredScanArtifacts:
        ...


def _safe_path_segment(value: object, *, fallback: str) -> str:
    segment = _SAFE_PATH_SEGMENT_PATTERN.sub("_", str(value or "").strip()).strip("._-")
    return segment or fallback


def _labeling_session_artifact_root(
    *,
    session_id: str,
    angle_index: int,
    angle_label: str,
) -> Path:
    safe_session_id = _safe_path_segment(session_id, fallback="session")
    safe_angle_label = _safe_path_segment(angle_label, fallback="capture")
    angle_directory = f"angle_{max(0, int(angle_index)):02d}_{safe_angle_label}"
    return Path("labeling-sessions") / safe_session_id / angle_directory


class FilesystemScanArtifactStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    @property
    def storage_kind(self) -> str:
        return "filesystem"

    def debug_status(self) -> dict[str, Any]:
        return {
            "storage": self.storage_kind,
            "filesystemRoot": str(self.root),
            "activeBucketName": None,
            "objectPrefix": None,
            "activeTarget": str(self.root),
        }

    def store(
        self,
        *,
        scan_id: str,
        source_bytes: bytes,
        normalized_bytes: bytes,
        year: str,
        month: str,
        day: str,
    ) -> StoredScanArtifacts:
        relative_root = Path("scans") / year / month / day / scan_id
        absolute_root = self.root / relative_root
        absolute_root.mkdir(parents=True, exist_ok=True)

        source_path = absolute_root / "source_capture.jpg"
        normalized_path = absolute_root / "normalized_target.jpg"
        source_path.write_bytes(source_bytes)
        normalized_path.write_bytes(normalized_bytes)

        return StoredScanArtifacts(
            source_object_path=relative_root.joinpath("source_capture.jpg").as_posix(),
            normalized_object_path=relative_root.joinpath("normalized_target.jpg").as_posix(),
        )

    def store_labeling_session_artifact(
        self,
        *,
        session_id: str,
        angle_index: int,
        angle_label: str,
        source_bytes: bytes,
        normalized_bytes: bytes,
    ) -> StoredScanArtifacts:
        relative_root = _labeling_session_artifact_root(
            session_id=session_id,
            angle_index=angle_index,
            angle_label=angle_label,
        )
        absolute_root = self.root / relative_root
        absolute_root.mkdir(parents=True, exist_ok=True)

        source_path = absolute_root / "source_capture.jpg"
        normalized_path = absolute_root / "normalized_target.jpg"
        source_path.write_bytes(source_bytes)
        normalized_path.write_bytes(normalized_bytes)

        return StoredScanArtifacts(
            source_object_path=relative_root.joinpath("source_capture.jpg").as_posix(),
            normalized_object_path=relative_root.joinpath("normalized_target.jpg").as_posix(),
        )


class GoogleCloudScanArtifactStore:
    def __init__(
        self,
        bucket_name: str,
        *,
        client: Any | None = None,
        object_prefix: str | None = None,
    ) -> None:
        configured_bucket = str(bucket_name or "").strip()
        if not configured_bucket:
            raise ValueError("GCS bucket name is required")

        if client is None:
            if gcs_storage is None:
                raise RuntimeError(
                    "google-cloud-storage is not installed. "
                    "Install it or leave scan artifact storage in filesystem mode."
                )
            client = gcs_storage.Client()

        self.client = client
        self.bucket = client.bucket(configured_bucket)
        self.object_prefix = str(object_prefix or "").strip().strip("/")

    @property
    def storage_kind(self) -> str:
        return "gcs"

    def debug_status(self) -> dict[str, Any]:
        bucket_name = getattr(self.bucket, "name", None)
        active_target = f"gs://{bucket_name}" if bucket_name else None
        if active_target and self.object_prefix:
            active_target = f"{active_target}/{self.object_prefix}"
        return {
            "storage": self.storage_kind,
            "filesystemRoot": None,
            "activeBucketName": bucket_name,
            "objectPrefix": self.object_prefix or None,
            "activeTarget": active_target,
        }

    def _object_name(self, relative_object_path: Path) -> str:
        object_name = relative_object_path.as_posix()
        if self.object_prefix:
            return f"{self.object_prefix}/{object_name}"
        return object_name

    def store(
        self,
        *,
        scan_id: str,
        source_bytes: bytes,
        normalized_bytes: bytes,
        year: str,
        month: str,
        day: str,
    ) -> StoredScanArtifacts:
        relative_root = Path("scans") / year / month / day / scan_id
        source_object_path = self._object_name(relative_root.joinpath("source_capture.jpg"))
        normalized_object_path = self._object_name(relative_root.joinpath("normalized_target.jpg"))

        source_blob = self.bucket.blob(source_object_path)
        source_blob.upload_from_string(source_bytes, content_type="image/jpeg")

        normalized_blob = self.bucket.blob(normalized_object_path)
        normalized_blob.upload_from_string(normalized_bytes, content_type="image/jpeg")

        return StoredScanArtifacts(
            source_object_path=source_object_path,
            normalized_object_path=normalized_object_path,
        )

    def store_labeling_session_artifact(
        self,
        *,
        session_id: str,
        angle_index: int,
        angle_label: str,
        source_bytes: bytes,
        normalized_bytes: bytes,
    ) -> StoredScanArtifacts:
        relative_root = _labeling_session_artifact_root(
            session_id=session_id,
            angle_index=angle_index,
            angle_label=angle_label,
        )
        source_object_path = self._object_name(relative_root.joinpath("source_capture.jpg"))
        normalized_object_path = self._object_name(relative_root.joinpath("normalized_target.jpg"))

        source_blob = self.bucket.blob(source_object_path)
        source_blob.upload_from_string(source_bytes, content_type="image/jpeg")

        normalized_blob = self.bucket.blob(normalized_object_path)
        normalized_blob.upload_from_string(normalized_bytes, content_type="image/jpeg")

        return StoredScanArtifacts(
            source_object_path=source_object_path,
            normalized_object_path=normalized_object_path,
        )


def _normalize_storage_mode(value: str | None) -> str:
    return str(value or "").strip().lower()


def build_scan_artifact_store(
    *,
    repo_root: Path,
    storage_override: str | None = None,
    root_override: str | None = None,
    gcs_bucket_override: str | None = None,
    gcs_client: Any | None = None,
) -> ScanArtifactStore:
    storage_mode = _normalize_storage_mode(storage_override)
    configured_root = str(root_override or "").strip()
    configured_bucket = str(gcs_bucket_override or "").strip()

    if storage_mode in {"gcs", "google-cloud-storage", "google_cloud_storage"}:
        if not configured_bucket:
            raise ValueError("SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET is required when storage is set to gcs")
        return GoogleCloudScanArtifactStore(configured_bucket, client=gcs_client)

    if storage_mode and storage_mode not in {"filesystem", "file", "local"}:
        raise ValueError(
            "SPOTLIGHT_SCAN_ARTIFACTS_STORAGE must be filesystem or gcs when set"
        )

    if configured_root:
        root = Path(configured_root).expanduser()
    else:
        root = repo_root / "backend" / "data" / "scan-artifacts"
    return FilesystemScanArtifactStore(root)
