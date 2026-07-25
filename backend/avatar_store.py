from __future__ import annotations

import re
from typing import Any, Protocol

try:
    from google.cloud import storage as gcs_storage
except ImportError:  # pragma: no cover - optional dependency
    gcs_storage = None


# The bucket that holds public profile avatars. This is DELIBERATELY separate
# from the scan-artifacts bucket: scan artifacts are private per the repo
# invariants, avatars are public-read. When this env var is unset the avatar
# feature is inert (the endpoint returns a clear "not configured" error) so the
# feature ships dark until the bucket is provisioned.
AVATARS_GCS_BUCKET_ENV = "SPOTLIGHT_AVATARS_GCS_BUCKET"

# Object path prefix inside the avatars bucket.
AVATAR_OBJECT_PREFIX = "avatars"

# The stored object is a single deterministic JPEG per user, so a repeat upload
# overwrites in place (no orphaned objects to garbage-collect). The client adds
# its own `?t=<ts>` cache-buster to the returned URL so the CDN/image cache
# picks up the new bytes.
_AVATAR_CONTENT_TYPE = "image/jpeg"

# Owner id sanity guard. The object path is ALWAYS derived from the
# authenticated caller's user id (a Supabase auth UUID), never from a
# client-supplied value, so an attacker cannot address another user's object.
# This pattern is a defense-in-depth check that the id is UUID-shaped before it
# is ever interpolated into an object path.
_USER_ID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


class AvatarStoreError(RuntimeError):
    pass


class AvatarStore(Protocol):
    @property
    def storage_kind(self) -> str:
        ...

    def debug_status(self) -> dict[str, Any]:
        ...

    def store_avatar(self, *, user_id: str, jpeg_bytes: bytes) -> str:
        ...


def _avatar_object_path(user_id: str) -> str:
    normalized = str(user_id or "").strip()
    if not _USER_ID_PATTERN.match(normalized):
        raise AvatarStoreError("avatar owner id must be a valid user id")
    return f"{AVATAR_OBJECT_PREFIX}/{normalized}.jpg"


class GoogleCloudAvatarStore:
    """Stores public profile avatars in a GCS bucket, mirroring the pattern in
    ``scan_artifact_store.GoogleCloudScanArtifactStore``.

    The object path is deterministic and owner-scoped (``avatars/<user_id>.jpg``)
    so a repeat upload overwrites the caller's own avatar in place and never
    touches anyone else's. The bucket is expected to be public-read; the
    returned URL is the standard public object URL.
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
                    "Install it or leave avatar storage unconfigured."
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
            "objectPrefix": AVATAR_OBJECT_PREFIX,
        }

    def public_url(self, object_path: str) -> str:
        return f"https://storage.googleapis.com/{self.bucket_name}/{object_path}"

    def store_avatar(self, *, user_id: str, jpeg_bytes: bytes) -> str:
        object_path = _avatar_object_path(user_id)
        blob = self.bucket.blob(object_path)
        blob.upload_from_string(jpeg_bytes, content_type=_AVATAR_CONTENT_TYPE)
        return self.public_url(object_path)


def build_avatar_store(
    *,
    gcs_bucket: str | None,
    gcs_client: Any | None = None,
) -> AvatarStore | None:
    """Build the avatar store, or return ``None`` when no bucket is configured.

    A ``None`` return means the feature is inert: the caller should surface a
    clear "avatar storage is not configured" response until the bucket is
    provisioned. This mirrors ``scan_artifact_store.build_scan_artifact_store``
    but has no filesystem fallback — avatars are only meaningful when they are
    served from a public bucket.
    """
    configured_bucket = str(gcs_bucket or "").strip()
    if not configured_bucket:
        return None
    return GoogleCloudAvatarStore(configured_bucket, client=gcs_client)
