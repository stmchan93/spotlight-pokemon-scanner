from __future__ import annotations

import io
import sys
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from avatar_store import (  # noqa: E402
    AvatarStoreError,
    GoogleCloudAvatarStore,
    build_avatar_store,
)
from request_auth import RequestAuthError, RequestIdentity  # noqa: E402
from server import SpotlightRequestHandler  # noqa: E402


VALID_USER_ID = "11111111-2222-4333-8444-555555555555"
JPEG_BYTES = b"\xff\xd8\xff\xe0avatar-bytes\x00\xff\xd9"
AVATAR_PATH = "/api/v1/profile/avatar"
COVER_PATH = "/api/v1/profile/cover"


# --- Fake GCS plumbing (mirrors test_scan_artifact_store_helpers) -------------


class _FakeBlob:
    def __init__(self) -> None:
        self.uploads: list[dict[str, object]] = []

    def upload_from_string(self, data, *, content_type: str) -> None:
        self.uploads.append({"data": data, "content_type": content_type})


class _FakeBucket:
    def __init__(self, name: str) -> None:
        self.name = name
        self.blobs: dict[str, _FakeBlob] = {}

    def blob(self, name: str) -> _FakeBlob:
        return self.blobs.setdefault(name, _FakeBlob())


class _FakeGCSClient:
    def __init__(self) -> None:
        self.buckets: dict[str, _FakeBucket] = {}

    def bucket(self, name: str) -> _FakeBucket:
        return self.buckets.setdefault(name, _FakeBucket(name))


def make_avatar_post_handler(
    *,
    body: bytes,
    service: object,
    content_type: str = "image/jpeg",
    path: str = AVATAR_PATH,
) -> tuple[SpotlightRequestHandler, dict[str, object]]:
    handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
    handler.path = path
    handler.service = service
    handler.headers = {
        "Content-Type": content_type,
        "Content-Length": str(len(body)),
        "Authorization": "Bearer test-token",
    }
    handler.rfile = io.BytesIO(body)
    captured: dict[str, object] = {}

    def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
        captured["status"] = status
        captured["payload"] = payload

    handler._write_json = write_json  # type: ignore[method-assign]
    return handler, captured


# --- avatar_store unit tests --------------------------------------------------


class AvatarStoreTests(unittest.TestCase):
    def test_build_avatar_store_returns_none_when_bucket_unset(self) -> None:
        self.assertIsNone(build_avatar_store(gcs_bucket=None))
        self.assertIsNone(build_avatar_store(gcs_bucket=""))
        self.assertIsNone(build_avatar_store(gcs_bucket="   "))

    def test_build_avatar_store_returns_gcs_store_when_bucket_set(self) -> None:
        store = build_avatar_store(gcs_bucket="ekalight-avatars", gcs_client=_FakeGCSClient())
        self.assertIsInstance(store, GoogleCloudAvatarStore)
        self.assertEqual(store.storage_kind, "gcs")

    def test_store_avatar_uses_deterministic_owner_scoped_path_and_public_url(self) -> None:
        client = _FakeGCSClient()
        store = GoogleCloudAvatarStore("ekalight-avatars", client=client)

        url = store.store_avatar(user_id=VALID_USER_ID, jpeg_bytes=JPEG_BYTES)

        self.assertEqual(
            url,
            f"https://storage.googleapis.com/ekalight-avatars/avatars/{VALID_USER_ID}.jpg",
        )
        bucket = client.buckets["ekalight-avatars"]
        object_path = f"avatars/{VALID_USER_ID}.jpg"
        self.assertIn(object_path, bucket.blobs)
        upload = bucket.blobs[object_path].uploads[-1]
        self.assertEqual(upload["data"], JPEG_BYTES)
        self.assertEqual(upload["content_type"], "image/jpeg")

    def test_store_avatar_rejects_non_uuid_owner_id(self) -> None:
        store = GoogleCloudAvatarStore("ekalight-avatars", client=_FakeGCSClient())
        # A path-traversal-shaped id must never reach the object path.
        with self.assertRaises(AvatarStoreError):
            store.store_avatar(user_id="../someone-else", jpeg_bytes=JPEG_BYTES)


# --- endpoint tests -----------------------------------------------------------


class AvatarUploadEndpointTests(unittest.TestCase):
    def _service_with_store(self, store: object) -> Mock:
        service = Mock()
        service.avatar_store = store
        # access_allowed backs _require_access; grant it for the happy paths.
        service.access_allowed.return_value = True
        return service

    def test_upload_stores_at_authenticated_owner_path_and_returns_url(self) -> None:
        client = _FakeGCSClient()
        store = GoogleCloudAvatarStore("ekalight-avatars", client=client)
        service = self._service_with_store(store)

        handler, captured = make_avatar_post_handler(body=JPEG_BYTES, service=service)
        # Identity comes from the token — the object path is derived from it, not
        # from anything in the request body.
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_USER_ID, auth_source="test"
        )
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(
            captured["payload"],
            {
                "avatarUrl": (
                    f"https://storage.googleapis.com/ekalight-avatars/avatars/{VALID_USER_ID}.jpg"
                )
            },
        )
        object_path = f"avatars/{VALID_USER_ID}.jpg"
        self.assertIn(object_path, client.buckets["ekalight-avatars"].blobs)

    def test_upload_ignores_any_client_supplied_id_and_scopes_to_token(self) -> None:
        # Even though a DIFFERENT user id appears in the (raw) body, the stored
        # object path is the authenticated caller's — nobody can overwrite
        # someone else's avatar.
        attacker_body = b'{"userId":"99999999-9999-4999-8999-999999999999"}' + JPEG_BYTES
        store = Mock()
        store.store_avatar.return_value = (
            f"https://storage.googleapis.com/ekalight-avatars/avatars/{VALID_USER_ID}.jpg"
        )
        service = self._service_with_store(store)

        handler, captured = make_avatar_post_handler(body=attacker_body, service=service)
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_USER_ID, auth_source="test"
        )
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        store.store_avatar.assert_called_once_with(
            user_id=VALID_USER_ID, jpeg_bytes=attacker_body
        )

    def test_returns_503_when_avatar_storage_unconfigured(self) -> None:
        service = self._service_with_store(None)
        handler, captured = make_avatar_post_handler(body=JPEG_BYTES, service=service)
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_USER_ID, auth_source="test"
        )
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertEqual(captured["payload"]["error"], "avatar_storage_unconfigured")

    def test_returns_401_when_unauthenticated(self) -> None:
        service = self._service_with_store(GoogleCloudAvatarStore("b", client=_FakeGCSClient()))
        # The real identity gate: authenticator rejects → 401, never reaches the
        # store.
        service.authenticator.resolve_identity.side_effect = RequestAuthError(
            "Authentication required."
        )
        handler, captured = make_avatar_post_handler(body=JPEG_BYTES, service=service)
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.UNAUTHORIZED)

    def test_returns_400_when_body_empty(self) -> None:
        store = Mock()
        service = self._service_with_store(store)
        handler, captured = make_avatar_post_handler(body=b"", service=service)
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_USER_ID, auth_source="test"
        )
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        store.store_avatar.assert_not_called()


class CoverStoreTests(unittest.TestCase):
    def test_store_cover_uses_its_own_prefix_under_the_same_bucket(self) -> None:
        client = _FakeGCSClient()
        store = GoogleCloudAvatarStore("ekalight-avatars", client=client)

        url = store.store_cover(user_id=VALID_USER_ID, jpeg_bytes=JPEG_BYTES)

        self.assertEqual(
            url,
            f"https://storage.googleapis.com/ekalight-avatars/covers/{VALID_USER_ID}.jpg",
        )
        bucket = client.buckets["ekalight-avatars"]
        object_path = f"covers/{VALID_USER_ID}.jpg"
        self.assertIn(object_path, bucket.blobs)
        upload = bucket.blobs[object_path].uploads[-1]
        self.assertEqual(upload["data"], JPEG_BYTES)
        self.assertEqual(upload["content_type"], "image/jpeg")

    def test_cover_and_avatar_are_independent_objects(self) -> None:
        # The point of the separate prefix: uploading a cover must never replace
        # the avatar (or the other way round).
        client = _FakeGCSClient()
        store = GoogleCloudAvatarStore("ekalight-avatars", client=client)

        store.store_avatar(user_id=VALID_USER_ID, jpeg_bytes=b"avatar")
        store.store_cover(user_id=VALID_USER_ID, jpeg_bytes=b"cover")

        blobs = client.buckets["ekalight-avatars"].blobs
        self.assertEqual(blobs[f"avatars/{VALID_USER_ID}.jpg"].uploads[-1]["data"], b"avatar")
        self.assertEqual(blobs[f"covers/{VALID_USER_ID}.jpg"].uploads[-1]["data"], b"cover")

    def test_store_cover_rejects_non_uuid_owner_id(self) -> None:
        store = GoogleCloudAvatarStore("ekalight-avatars", client=_FakeGCSClient())
        with self.assertRaises(AvatarStoreError):
            store.store_cover(user_id="../someone-else", jpeg_bytes=JPEG_BYTES)


class CoverUploadEndpointTests(unittest.TestCase):
    def _service_with_store(self, store: object) -> Mock:
        service = Mock()
        service.avatar_store = store
        service.access_allowed.return_value = True
        return service

    def test_upload_stores_at_authenticated_owner_path_and_returns_url(self) -> None:
        client = _FakeGCSClient()
        store = GoogleCloudAvatarStore("ekalight-avatars", client=client)
        service = self._service_with_store(store)

        handler, captured = make_avatar_post_handler(
            body=JPEG_BYTES, service=service, path=COVER_PATH
        )
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_USER_ID, auth_source="test"
        )
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(
            captured["payload"],
            {
                "coverUrl": (
                    f"https://storage.googleapis.com/ekalight-avatars/covers/{VALID_USER_ID}.jpg"
                )
            },
        )

    def test_upload_ignores_any_client_supplied_id_and_scopes_to_token(self) -> None:
        attacker_body = b'{"userId":"99999999-9999-4999-8999-999999999999"}' + JPEG_BYTES
        store = Mock()
        store.store_cover.return_value = (
            f"https://storage.googleapis.com/ekalight-avatars/covers/{VALID_USER_ID}.jpg"
        )
        service = self._service_with_store(store)

        handler, captured = make_avatar_post_handler(
            body=attacker_body, service=service, path=COVER_PATH
        )
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_USER_ID, auth_source="test"
        )
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        store.store_cover.assert_called_once_with(
            user_id=VALID_USER_ID, jpeg_bytes=attacker_body
        )

    def test_returns_503_when_storage_unconfigured(self) -> None:
        service = self._service_with_store(None)
        handler, captured = make_avatar_post_handler(
            body=JPEG_BYTES, service=service, path=COVER_PATH
        )
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_USER_ID, auth_source="test"
        )
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertEqual(captured["payload"]["error"], "avatar_storage_unconfigured")

    def test_returns_401_when_unauthenticated(self) -> None:
        service = self._service_with_store(GoogleCloudAvatarStore("b", client=_FakeGCSClient()))
        service.authenticator.resolve_identity.side_effect = RequestAuthError(
            "Authentication required."
        )
        handler, captured = make_avatar_post_handler(
            body=JPEG_BYTES, service=service, path=COVER_PATH
        )
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.UNAUTHORIZED)

    def test_returns_400_when_body_empty(self) -> None:
        store = Mock()
        service = self._service_with_store(store)
        handler, captured = make_avatar_post_handler(
            body=b"", service=service, path=COVER_PATH
        )
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_USER_ID, auth_source="test"
        )
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        store.store_cover.assert_not_called()


if __name__ == "__main__":
    unittest.main()
