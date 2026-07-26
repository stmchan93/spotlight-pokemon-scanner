from __future__ import annotations

import io
import json
import sys
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from post_media_store import (  # noqa: E402
    GoogleCloudPostMediaStore,
    PostMediaStoreError,
    build_post_media_store,
    content_type_for_path,
)
from request_auth import RequestAuthError, RequestIdentity  # noqa: E402
from server import SpotlightRequestHandler  # noqa: E402


VALID_MEDIA_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
IMAGE_BYTES = b"\xff\xd8\xff\xe0post-media-bytes\x00\xff\xd9"
STORAGE_PATH = "posts/2026/07/some-object.jpg"


# --- Fake GCS plumbing (mirrors test_profile_avatar_upload) -------------------


class _FakeBlob:
    def __init__(self, name: str) -> None:
        self.name = name
        self.data: bytes | None = None
        self.content_type: str | None = None

    def download_as_bytes(self) -> bytes:
        if self.data is None:
            raise RuntimeError("object not found")
        return self.data

    def upload_from_string(self, data, *, content_type: str) -> None:
        self.data = data
        self.content_type = content_type


class _FakeBucket:
    def __init__(self, name: str) -> None:
        self.name = name
        self.blobs: dict[str, _FakeBlob] = {}

    def blob(self, name: str) -> _FakeBlob:
        return self.blobs.setdefault(name, _FakeBlob(name))


class _FakeGCSClient:
    def __init__(self) -> None:
        self.buckets: dict[str, _FakeBucket] = {}

    def bucket(self, name: str) -> _FakeBucket:
        return self.buckets.setdefault(name, _FakeBucket(name))


def make_post_media_get_handler(
    *,
    path: str,
    service: object,
) -> tuple[SpotlightRequestHandler, dict[str, object]]:
    handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
    handler.path = path
    handler.service = service
    handler.headers = {"Authorization": "Bearer caller-jwt"}
    handler.rfile = io.BytesIO(b"")
    captured: dict[str, object] = {}

    def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
        captured["status"] = status
        captured["payload"] = payload

    def write_image(body: bytes, *, content_type: str) -> None:
        captured["status"] = HTTPStatus.OK
        captured["body"] = body
        captured["content_type"] = content_type

    handler._write_json = write_json  # type: ignore[method-assign]
    handler._write_post_media_image = write_image  # type: ignore[method-assign]
    return handler, captured


# --- post_media_store unit tests ----------------------------------------------


class PostMediaStoreTests(unittest.TestCase):
    def test_build_returns_none_when_bucket_unset(self) -> None:
        self.assertIsNone(build_post_media_store(gcs_bucket=None))
        self.assertIsNone(build_post_media_store(gcs_bucket=""))
        self.assertIsNone(build_post_media_store(gcs_bucket="   "))

    def test_build_returns_gcs_store_when_bucket_set(self) -> None:
        store = build_post_media_store(
            gcs_bucket="ekalight-post-media", gcs_client=_FakeGCSClient()
        )
        self.assertIsInstance(store, GoogleCloudPostMediaStore)
        self.assertEqual(store.storage_kind, "gcs")
        self.assertEqual(store.debug_status()["visibility"], "private")

    def test_read_bytes_downloads_object(self) -> None:
        client = _FakeGCSClient()
        store = GoogleCloudPostMediaStore("ekalight-post-media", client=client)
        client.buckets["ekalight-post-media"].blob(STORAGE_PATH).data = IMAGE_BYTES

        self.assertEqual(store.read_bytes(STORAGE_PATH), IMAGE_BYTES)

    def test_store_bytes_uploads_object(self) -> None:
        client = _FakeGCSClient()
        store = GoogleCloudPostMediaStore("ekalight-post-media", client=client)

        store.store_bytes(
            storage_path=STORAGE_PATH, image_bytes=IMAGE_BYTES, content_type="image/webp"
        )
        blob = client.buckets["ekalight-post-media"].blobs[STORAGE_PATH]
        self.assertEqual(blob.data, IMAGE_BYTES)
        self.assertEqual(blob.content_type, "image/webp")

    def test_read_bytes_rejects_traversal_paths(self) -> None:
        store = GoogleCloudPostMediaStore(
            "ekalight-post-media", client=_FakeGCSClient()
        )
        for bad in ["../secret.jpg", "/etc/passwd", "a/../../b.jpg", "", "a//b.jpg"]:
            with self.assertRaises(PostMediaStoreError):
                store.read_bytes(bad)

    def test_content_type_inference(self) -> None:
        self.assertEqual(content_type_for_path("a/b.jpg"), "image/jpeg")
        self.assertEqual(content_type_for_path("a/b.JPEG"), "image/jpeg")
        self.assertEqual(content_type_for_path("a/b.webp"), "image/webp")
        self.assertEqual(content_type_for_path("a/b.bin"), "image/jpeg")


# --- endpoint tests -----------------------------------------------------------


class PostMediaEndpointTests(unittest.TestCase):
    def _service(self, store: object) -> Mock:
        service = Mock()
        service.post_media_store = store
        return service

    def test_returns_401_when_unauthenticated(self) -> None:
        service = self._service(Mock())
        service.authenticator.resolve_identity.side_effect = RequestAuthError(
            "Authentication required."
        )
        handler, captured = make_post_media_get_handler(
            path=f"/api/v1/post-media/{VALID_MEDIA_ID}", service=service
        )
        handler.do_GET()

        self.assertEqual(captured["status"], HTTPStatus.UNAUTHORIZED)

    def test_returns_400_for_invalid_media_id(self) -> None:
        service = self._service(Mock())
        handler, captured = make_post_media_get_handler(
            path="/api/v1/post-media/not-a-uuid", service=service
        )
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_MEDIA_ID, auth_source="test"
        )
        handler.do_GET()

        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)

    def test_returns_503_when_storage_unconfigured(self) -> None:
        service = self._service(None)
        handler, captured = make_post_media_get_handler(
            path=f"/api/v1/post-media/{VALID_MEDIA_ID}", service=service
        )
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_MEDIA_ID, auth_source="test"
        )
        handler.do_GET()

        self.assertEqual(captured["status"], HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertEqual(
            captured["payload"]["error"], "post_media_storage_unconfigured"
        )

    def test_returns_404_when_rls_returns_no_row(self) -> None:
        # RLS denies visibility (not approved / not found) → zero rows → 404. The
        # store is never touched.
        store = Mock()
        service = self._service(store)
        handler, captured = make_post_media_get_handler(
            path=f"/api/v1/post-media/{VALID_MEDIA_ID}", service=service
        )
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_MEDIA_ID, auth_source="test"
        )
        handler._fetch_post_media_row_via_rls = lambda media_id, auth: None  # type: ignore[method-assign]
        handler.do_GET()

        self.assertEqual(captured["status"], HTTPStatus.NOT_FOUND)
        store.read_bytes.assert_not_called()

    def test_returns_bytes_when_rls_returns_row(self) -> None:
        store = Mock()
        store.read_bytes.return_value = IMAGE_BYTES
        service = self._service(store)
        handler, captured = make_post_media_get_handler(
            path=f"/api/v1/post-media/{VALID_MEDIA_ID}", service=service
        )
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_MEDIA_ID, auth_source="test"
        )
        handler._fetch_post_media_row_via_rls = lambda media_id, auth: {  # type: ignore[method-assign]
            "storage_path": STORAGE_PATH,
            "moderation_status": "approved",
        }
        handler.do_GET()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["body"], IMAGE_BYTES)
        self.assertEqual(captured["content_type"], "image/jpeg")
        store.read_bytes.assert_called_once_with(STORAGE_PATH)


# --- RLS-as-authz mechanism test ----------------------------------------------


class PostMediaRlsLookupTests(unittest.TestCase):
    """The outbound Supabase call IS the authorization layer: verify it forwards
    the caller's bearer + anon apikey to PostgREST and reads back the row."""

    def _handler(self) -> SpotlightRequestHandler:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        return handler

    def test_forwards_bearer_and_returns_row(self) -> None:
        row = {"storage_path": STORAGE_PATH, "moderation_status": "approved"}

        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return json.dumps([row]).encode("utf-8")

        captured_request: dict[str, object] = {}

        def fake_urlopen(request, timeout=None):
            captured_request["full_url"] = request.full_url
            captured_request["headers"] = dict(request.headers)
            return _Resp()

        env = {
            "SUPABASE_URL": "https://proj.supabase.co",
            "SUPABASE_ANON_KEY": "anon-key-123",
        }
        with patch.dict("os.environ", env, clear=False), patch(
            "urllib.request.urlopen", fake_urlopen
        ):
            result = self._handler()._fetch_post_media_row_via_rls(
                VALID_MEDIA_ID, "Bearer caller-jwt"
            )

        self.assertEqual(result, row)
        self.assertIn("post_media", str(captured_request["full_url"]))
        self.assertIn(f"eq.{VALID_MEDIA_ID}", str(captured_request["full_url"]))
        headers = {k.lower(): v for k, v in captured_request["headers"].items()}  # type: ignore[union-attr]
        self.assertEqual(headers["authorization"], "Bearer caller-jwt")
        self.assertEqual(headers["apikey"], "anon-key-123")

    def test_returns_none_on_empty_rows(self) -> None:
        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"[]"

        env = {
            "SUPABASE_URL": "https://proj.supabase.co",
            "SUPABASE_ANON_KEY": "anon-key-123",
        }
        with patch.dict("os.environ", env, clear=False), patch(
            "urllib.request.urlopen", lambda request, timeout=None: _Resp()
        ):
            result = self._handler()._fetch_post_media_row_via_rls(
                VALID_MEDIA_ID, "Bearer caller-jwt"
            )
        self.assertIsNone(result)

    def test_returns_none_when_env_missing(self) -> None:
        env = {
            "SUPABASE_URL": "",
            "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL": "",
            "SPOTLIGHT_SUPABASE_URL": "",
            "SUPABASE_ANON_KEY": "",
            "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY": "",
            "SPOTLIGHT_SUPABASE_ANON_KEY": "",
        }
        with patch.dict("os.environ", env, clear=False):
            result = self._handler()._fetch_post_media_row_via_rls(
                VALID_MEDIA_ID, "Bearer caller-jwt"
            )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
