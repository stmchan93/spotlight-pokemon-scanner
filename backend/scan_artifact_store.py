from __future__ import annotations

import json
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

ARTIFACTS_JSON_BASENAME = "artifacts.json"


_SAFE_PATH_SEGMENT_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True)
class StoredScanArtifacts:
    # source_object_path is None for a normalized-only store (the optional source
    # capture was unavailable, e.g. dropped under phone memory pressure).
    source_object_path: str | None
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

    def store_normalized_only(
        self,
        *,
        scan_id: str,
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

    def write_artifacts_json(
        self,
        *,
        scan_id: str,
        year: str,
        month: str,
        day: str,
        document: dict[str, Any],
    ) -> str:
        ...

    def read_artifacts_json(
        self,
        *,
        scan_id: str,
        year: str,
        month: str,
        day: str,
    ) -> dict[str, Any] | None:
        ...


def _scan_artifact_root(*, year: str, month: str, day: str, scan_id: str) -> Path:
    return Path("scans") / year / month / day / scan_id


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
        relative_root = _scan_artifact_root(year=year, month=month, day=day, scan_id=scan_id)
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

    def store_normalized_only(
        self,
        *,
        scan_id: str,
        normalized_bytes: bytes,
        year: str,
        month: str,
        day: str,
    ) -> StoredScanArtifacts:
        relative_root = _scan_artifact_root(year=year, month=month, day=day, scan_id=scan_id)
        absolute_root = self.root / relative_root
        absolute_root.mkdir(parents=True, exist_ok=True)

        normalized_path = absolute_root / "normalized_target.jpg"
        normalized_path.write_bytes(normalized_bytes)

        return StoredScanArtifacts(
            source_object_path=None,
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

    def write_artifacts_json(
        self,
        *,
        scan_id: str,
        year: str,
        month: str,
        day: str,
        document: dict[str, Any],
    ) -> str:
        relative_root = _scan_artifact_root(year=year, month=month, day=day, scan_id=scan_id)
        absolute_root = self.root / relative_root
        absolute_root.mkdir(parents=True, exist_ok=True)
        relative_path = relative_root.joinpath(ARTIFACTS_JSON_BASENAME)
        absolute_path = self.root / relative_path
        absolute_path.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
        return relative_path.as_posix()

    def read_artifacts_json(
        self,
        *,
        scan_id: str,
        year: str,
        month: str,
        day: str,
    ) -> dict[str, Any] | None:
        relative_path = _scan_artifact_root(year=year, month=month, day=day, scan_id=scan_id).joinpath(
            ARTIFACTS_JSON_BASENAME
        )
        absolute_path = self.root / relative_path
        if not absolute_path.exists():
            return None
        try:
            raw = absolute_path.read_text(encoding="utf-8")
        except OSError:
            return None
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return None
        if not isinstance(parsed, dict):
            return None
        return parsed


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

    def read_object_bytes(self, object_path: str) -> bytes | None:
        """Read the raw bytes of an object by its full bucket-relative path.

        Returns None when the object cannot be found or read. Unlike the
        artifact helpers above, ``object_path`` is treated as an already-fully
        qualified object name (the caller is responsible for any prefix); this
        matches the absolute ``scans/...`` paths stored in review queue files.
        """
        normalized = str(object_path or "").strip().lstrip("/")
        if not normalized:
            return None
        blob = self.bucket.blob(normalized)
        download = getattr(blob, "download_as_bytes", None) or getattr(blob, "download_as_string", None)
        if download is None:
            return None
        try:
            raw = download()
        except Exception:  # noqa: BLE001 - missing blob or transient failure
            return None
        if isinstance(raw, str):
            return raw.encode("utf-8")
        if isinstance(raw, bytes):
            return raw
        return None

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
        relative_root = _scan_artifact_root(year=year, month=month, day=day, scan_id=scan_id)
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

    def store_normalized_only(
        self,
        *,
        scan_id: str,
        normalized_bytes: bytes,
        year: str,
        month: str,
        day: str,
    ) -> StoredScanArtifacts:
        relative_root = _scan_artifact_root(year=year, month=month, day=day, scan_id=scan_id)
        normalized_object_path = self._object_name(relative_root.joinpath("normalized_target.jpg"))

        normalized_blob = self.bucket.blob(normalized_object_path)
        normalized_blob.upload_from_string(normalized_bytes, content_type="image/jpeg")

        return StoredScanArtifacts(
            source_object_path=None,
            normalized_object_path=normalized_object_path,
        )

    def write_artifacts_json(
        self,
        *,
        scan_id: str,
        year: str,
        month: str,
        day: str,
        document: dict[str, Any],
    ) -> str:
        relative_path = _scan_artifact_root(year=year, month=month, day=day, scan_id=scan_id).joinpath(
            ARTIFACTS_JSON_BASENAME
        )
        object_path = self._object_name(relative_path)
        blob = self.bucket.blob(object_path)
        blob.upload_from_string(
            json.dumps(document, separators=(",", ":")),
            content_type="application/json",
        )
        return object_path

    def read_artifacts_json(
        self,
        *,
        scan_id: str,
        year: str,
        month: str,
        day: str,
    ) -> dict[str, Any] | None:
        relative_path = _scan_artifact_root(year=year, month=month, day=day, scan_id=scan_id).joinpath(
            ARTIFACTS_JSON_BASENAME
        )
        object_path = self._object_name(relative_path)
        blob = self.bucket.blob(object_path)
        exists = getattr(blob, "exists", None)
        if callable(exists):
            try:
                if not exists():
                    return None
            except Exception:  # noqa: BLE001 - treat any check failure as missing
                return None
        download = getattr(blob, "download_as_text", None) or getattr(blob, "download_as_string", None)
        if download is None:
            return None
        try:
            raw = download()
        except Exception:  # noqa: BLE001 - missing blob or transient failure
            return None
        if isinstance(raw, bytes):
            try:
                raw = raw.decode("utf-8")
            except UnicodeDecodeError:
                return None
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return None
        if not isinstance(parsed, dict):
            return None
        return parsed

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
