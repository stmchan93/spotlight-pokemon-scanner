from __future__ import annotations

import re
from typing import Any, Protocol

try:
    from google.cloud import storage as gcs_storage
except ImportError:  # pragma: no cover - optional dependency
    gcs_storage = None


# The bucket that holds user-generated POST MEDIA images. Unlike the avatars
# bucket (public-read), this bucket is PRIVATE: post media must stay hidden
# until moderation approves it, so the bytes are never public and are only ever
# streamed back through the authenticated backend proxy after Supabase RLS has
# confirmed the caller may see the row. When this env var is unset the feature
# is inert (the serving endpoint returns 503) so it ships dark until the bucket
# is provisioned.
POST_MEDIA_GCS_BUCKET_ENV = "SPOTLIGHT_POST_MEDIA_GCS_BUCKET"

# Default content type when the object extension is unknown. Post images are
# stored as JPEG or WebP; callers infer the precise type from the storage path.
_DEFAULT_CONTENT_TYPE = "image/jpeg"


class PostMediaStoreError(RuntimeError):
    pass


class PostMediaStore(Protocol):
    @property
    def storage_kind(self) -> str:
        ...

    def debug_status(self) -> dict[str, Any]:
        ...

    def read_bytes(self, storage_path: str) -> bytes:
        ...

    def store_bytes(
        self, *, storage_path: str, image_bytes: bytes, content_type: str
    ) -> None:
        ...


# A storage_path comes from the trusted `post_media.storage_path` column, but it
# is still validated as defense-in-depth before it is ever handed to the bucket:
# an object key must be a relative, non-empty path with no traversal segments and
# no leading slash, so a malformed/hostile value can never address an object
# outside the intended key space.
_SEGMENT_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")


def _sanitize_object_path(storage_path: str) -> str:
    normalized = str(storage_path or "").strip()
    if not normalized:
        raise PostMediaStoreError("post media storage path is empty")
    if normalized.startswith("/") or normalized.startswith("\\"):
        raise PostMediaStoreError("post media storage path must be relative")
    if "\\" in normalized:
        raise PostMediaStoreError("post media storage path must use forward slashes")
    segments = normalized.split("/")
    for segment in segments:
        if not segment or segment in {".", ".."} or not _SEGMENT_PATTERN.match(segment):
            raise PostMediaStoreError(
                f"post media storage path has an invalid segment: {segment!r}"
            )
    return normalized


def content_type_for_path(storage_path: str) -> str:
    """Infer the image content type from the object extension.

    Post media are JPEG or WebP; anything unrecognized falls back to JPEG so a
    served object always carries a concrete image content type.
    """
    lowered = str(storage_path or "").strip().lower()
    if lowered.endswith(".webp"):
        return "image/webp"
    if lowered.endswith(".jpg") or lowered.endswith(".jpeg"):
        return "image/jpeg"
    return _DEFAULT_CONTENT_TYPE


class GoogleCloudPostMediaStore:
    """Streams private post-media images from a GCS bucket.

    Mirrors ``avatar_store.GoogleCloudAvatarStore`` but the bucket is PRIVATE:
    objects are never public and are only read back through the authenticated
    backend proxy. The proxy relies on Supabase RLS (not a local check) to decide
    whether a caller may see a given ``post_media`` row; this store only moves
    bytes for an already-authorized ``storage_path``.

    The read path is the only path used today. ``store_bytes`` is included for the
    later upload slice and is currently unused at runtime.
    """

    def __init__(
        self,
        bucket_name: str,
        *,
        client: Any | None = None,
    ) -> None:
        configured_bucket = str(bucket_name or "").strip()
        if not configured_bucket:
            raise ValueError("GCS bucket name is required")

        if client is None:
            if gcs_storage is None:
                raise RuntimeError(
                    "google-cloud-storage is not installed. "
                    "Install it or leave post media storage unconfigured."
                )
            client = gcs_storage.Client()

        self.bucket_name = configured_bucket
        self.client = client
        self.bucket = client.bucket(configured_bucket)

    @property
    def storage_kind(self) -> str:
        return "gcs"

    def debug_status(self) -> dict[str, Any]:
        return {
            "storage": self.storage_kind,
            "activeBucketName": self.bucket_name,
            "visibility": "private",
        }

    def read_bytes(self, storage_path: str) -> bytes:
        """Download the raw object bytes at ``storage_path``.

        Raises ``PostMediaStoreError`` when the path fails the traversal guard.
        Underlying GCS errors (missing object, permission) propagate to the
        caller so the endpoint can map them to the right HTTP status.
        """
        object_path = _sanitize_object_path(storage_path)
        blob = self.bucket.blob(object_path)
        return blob.download_as_bytes()

    def store_bytes(
        self, *, storage_path: str, image_bytes: bytes, content_type: str
    ) -> None:
        """Write object bytes at ``storage_path`` (future upload slice; unused).

        Included so the upload path can reuse the same store without a second
        pass over this module. Not wired into any runtime endpoint yet.
        """
        object_path = _sanitize_object_path(storage_path)
        resolved_content_type = str(content_type or "").strip() or _DEFAULT_CONTENT_TYPE
        blob = self.bucket.blob(object_path)
        blob.upload_from_string(image_bytes, content_type=resolved_content_type)


def build_post_media_store(
    *,
    gcs_bucket: str | None,
    gcs_client: Any | None = None,
) -> PostMediaStore | None:
    """Build the post-media store, or return ``None`` when no bucket is set.

    A ``None`` return means the feature is inert: the serving endpoint returns a
    503 "not configured" until the private bucket is provisioned. This mirrors
    ``avatar_store.build_avatar_store`` but the bucket is private, so there is no
    public-URL surface — bytes are only ever served through the backend proxy.
    """
    configured_bucket = str(gcs_bucket or "").strip()
    if not configured_bucket:
        return None
    return GoogleCloudPostMediaStore(configured_bucket, client=gcs_client)
