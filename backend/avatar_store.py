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

# Profile COVER banners live in the SAME public bucket under their own prefix.
# Same visibility rules (public-read, owner-write) and same lifecycle, so a
# second bucket would only add provisioning work; a separate prefix keeps the
# two objects independent so replacing one never touches the other.
COVER_OBJECT_PREFIX = "covers"

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

    def store_cover(self, *, user_id: str, jpeg_bytes: bytes) -> str:
        ...


def _owner_object_path(prefix: str, user_id: str) -> str:
    normalized = str(user_id or "").strip()
    if not _USER_ID_PATTERN.match(normalized):
        raise AvatarStoreError("avatar owner id must be a valid user id")
    return f"{prefix}/{normalized}.jpg"


def _avatar_object_path(user_id: str) -> str:
    return _owner_object_path(AVATAR_OBJECT_PREFIX, user_id)


def _cover_object_path(user_id: str) -> str:
    return _owner_object_path(COVER_OBJECT_PREFIX, user_id)


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
            "coverObjectPrefix": COVER_OBJECT_PREFIX,
        }

    # The client cache-busts every upload with `?t=<epoch>`, so any given URL
    # names immutable bytes: a new photo is always a NEW url. That makes a long
    # immutable max-age safe, and it is the only thing that helps OTHER people
    # viewing this profile — they cannot prefetch the way the uploader's own
    # device can. Without it every viewer paid a cold GCS round-trip on a blank
    # banner. Objects are overwritten in place on re-upload, but the previous
    # URL is never requested again, so no stale copy is ever served.
    _IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"

    def _upload_public_image(self, object_path: str, jpeg_bytes: bytes) -> str:
        blob = self.bucket.blob(object_path)
        blob.cache_control = self._IMMUTABLE_CACHE_CONTROL
        blob.upload_from_string(jpeg_bytes, content_type=_AVATAR_CONTENT_TYPE)
        return self.public_url(object_path)

    def public_url(self, object_path: str) -> str:
        return f"https://storage.googleapis.com/{self.bucket_name}/{object_path}"

    def store_avatar(self, *, user_id: str, jpeg_bytes: bytes) -> str:
        return self._upload_public_image(_avatar_object_path(user_id), jpeg_bytes)

    def store_cover(self, *, user_id: str, jpeg_bytes: bytes) -> str:
        """Store the caller's profile cover banner (``covers/<user_id>.jpg``).

        Identical owner-scoping to ``store_avatar`` — the path is derived from
        the authenticated caller's id, never from client input — writing to a
        different prefix so avatar and cover replace independently.
        """
        return self._upload_public_image(_cover_object_path(user_id), jpeg_bytes)


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
