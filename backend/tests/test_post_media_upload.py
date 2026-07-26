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

from request_auth import RequestAuthError, RequestIdentity  # noqa: E402
from server import SpotlightRequestHandler  # noqa: E402


VALID_POST_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
JPEG_BYTES = b"\xff\xd8\xff\xe0post-image-bytes\x00\xff\xd9"
POST_MEDIA_PATH = "/api/v1/post-media"
CALLER_BEARER = "Bearer caller-jwt"


def make_post_media_post_handler(
    *,
    body: bytes,
    service: object,
    post_id: str = VALID_POST_ID,
    content_type: str = "image/jpeg",
) -> tuple[SpotlightRequestHandler, dict[str, object]]:
    handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
    handler.path = f"{POST_MEDIA_PATH}?postId={post_id}"
    handler.service = service
    handler.headers = {
        "Content-Type": content_type,
        "Content-Length": str(len(body)),
        "Authorization": CALLER_BEARER,
    }
    handler.rfile = io.BytesIO(body)
    captured: dict[str, object] = {}

    def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
        captured["status"] = status
        captured["payload"] = payload

    handler._write_json = write_json  # type: ignore[method-assign]
    return handler, captured


# --- endpoint tests -----------------------------------------------------------


class PostMediaUploadEndpointTests(unittest.TestCase):
    def _service(self, store: object) -> Mock:
        service = Mock()
        service.post_media_store = store
        return service

    def _grant_identity(self, handler: SpotlightRequestHandler) -> None:
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_POST_ID, auth_source="test"
        )

    def test_returns_401_when_unauthenticated(self) -> None:
        service = self._service(Mock())
        service.authenticator.resolve_identity.side_effect = RequestAuthError(
            "Authentication required."
        )
        handler, captured = make_post_media_post_handler(
            body=JPEG_BYTES, service=service
        )
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.UNAUTHORIZED)

    def test_returns_400_for_invalid_post_id(self) -> None:
        store = Mock()
        service = self._service(store)
        handler, captured = make_post_media_post_handler(
            body=JPEG_BYTES, service=service, post_id="not-a-uuid"
        )
        self._grant_identity(handler)
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        store.store_bytes.assert_not_called()

    def test_returns_400_when_body_empty(self) -> None:
        store = Mock()
        service = self._service(store)
        handler, captured = make_post_media_post_handler(body=b"", service=service)
        self._grant_identity(handler)
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        store.store_bytes.assert_not_called()

    def test_returns_503_when_storage_unconfigured(self) -> None:
        service = self._service(None)
        handler, captured = make_post_media_post_handler(
            body=JPEG_BYTES, service=service
        )
        self._grant_identity(handler)
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertEqual(
            captured["payload"]["error"], "post_media_storage_unconfigured"
        )

    def test_returns_403_when_rls_insert_returns_no_row(self) -> None:
        # RLS rejects the insert (caller doesn't own the post) → no row → 403,
        # and the bytes are NEVER uploaded.
        store = Mock()
        service = self._service(store)
        handler, captured = make_post_media_post_handler(
            body=JPEG_BYTES, service=service
        )
        self._grant_identity(handler)
        handler._insert_post_media_row_via_rls = lambda **kwargs: None  # type: ignore[method-assign]
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.FORBIDDEN)
        store.store_bytes.assert_not_called()

    def test_success_uploads_and_returns_media_id(self) -> None:
        store = Mock()
        service = self._service(store)
        handler, captured = make_post_media_post_handler(
            body=JPEG_BYTES, service=service
        )
        self._grant_identity(handler)

        insert_calls: dict[str, object] = {}

        def fake_insert(**kwargs):
            insert_calls.update(kwargs)
            return {
                "id": kwargs["media_id"],
                "post_id": kwargs["post_id"],
                "storage_path": kwargs["storage_path"],
                "moderation_status": "pending",
            }

        handler._insert_post_media_row_via_rls = fake_insert  # type: ignore[method-assign]
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        media_id = captured["payload"]["mediaId"]  # type: ignore[index]
        # storage_path is namespaced under the post id: "<postId>/<mediaId>.jpg".
        expected_path = f"{VALID_POST_ID}/{media_id}.jpg"
        self.assertEqual(insert_calls["post_id"], VALID_POST_ID)
        self.assertEqual(insert_calls["storage_path"], expected_path)
        # The insert forwards the CALLER'S bearer — RLS is the authorization.
        self.assertEqual(insert_calls["authorization_header"], CALLER_BEARER)
        store.store_bytes.assert_called_once_with(
            storage_path=expected_path,
            image_bytes=JPEG_BYTES,
            content_type="image/jpeg",
        )

    def test_upload_failure_rolls_back_row_and_returns_502(self) -> None:
        store = Mock()
        store.store_bytes.side_effect = RuntimeError("gcs down")
        service = self._service(store)
        handler, captured = make_post_media_post_handler(
            body=JPEG_BYTES, service=service
        )
        self._grant_identity(handler)
        handler._insert_post_media_row_via_rls = lambda **kwargs: {  # type: ignore[method-assign]
            "id": kwargs["media_id"],
        }
        deleted: dict[str, object] = {}
        handler._delete_post_media_row_via_rls = lambda media_id, auth: deleted.update(  # type: ignore[method-assign]
            {"media_id": media_id, "auth": auth}
        )
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.BAD_GATEWAY)
        # The just-inserted row is rolled back as the caller.
        self.assertEqual(deleted["auth"], CALLER_BEARER)
        self.assertIn("media_id", deleted)


# --- RLS-as-authz mechanism test ----------------------------------------------


class PostMediaInsertRlsTests(unittest.TestCase):
    """The outbound Supabase INSERT IS the authorization layer: verify it POSTs
    the row to PostgREST forwarding the caller's bearer + anon apikey and reads
    the inserted row back."""

    def _handler(self) -> SpotlightRequestHandler:
        return SpotlightRequestHandler.__new__(SpotlightRequestHandler)

    def test_forwards_bearer_and_posts_row(self) -> None:
        media_id = "11111111-2222-4333-8444-555555555555"
        storage_path = f"{VALID_POST_ID}/{media_id}.jpg"
        row = {
            "id": media_id,
            "post_id": VALID_POST_ID,
            "storage_path": storage_path,
            "moderation_status": "pending",
        }

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
            captured_request["method"] = request.get_method()
            captured_request["headers"] = dict(request.headers)
            captured_request["data"] = request.data
            return _Resp()

        env = {
            "SUPABASE_URL": "https://proj.supabase.co",
            "SUPABASE_ANON_KEY": "anon-key-123",
        }
        with patch.dict("os.environ", env, clear=False), patch(
            "urllib.request.urlopen", fake_urlopen
        ):
            result = self._handler()._insert_post_media_row_via_rls(
                media_id=media_id,
                post_id=VALID_POST_ID,
                storage_path=storage_path,
                authorization_header=CALLER_BEARER,
            )

        self.assertEqual(result, row)
        self.assertEqual(captured_request["method"], "POST")
        self.assertIn("post_media", str(captured_request["full_url"]))
        headers = {k.lower(): v for k, v in captured_request["headers"].items()}  # type: ignore[union-attr]
        self.assertEqual(headers["authorization"], CALLER_BEARER)
        self.assertEqual(headers["apikey"], "anon-key-123")
        # moderation_status is omitted so it defaults to pending server-side.
        body = json.loads(captured_request["data"].decode("utf-8"))  # type: ignore[union-attr]
        self.assertEqual(body["id"], media_id)
        self.assertEqual(body["post_id"], VALID_POST_ID)
        self.assertEqual(body["storage_path"], storage_path)
        self.assertNotIn("moderation_status", body)

    def test_returns_none_on_rejected_insert(self) -> None:
        # RLS denial surfaces as an error / empty rows → None (endpoint → 403).
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
            result = self._handler()._insert_post_media_row_via_rls(
                media_id="x",
                post_id=VALID_POST_ID,
                storage_path="p/x.jpg",
                authorization_header=CALLER_BEARER,
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
            result = self._handler()._insert_post_media_row_via_rls(
                media_id="x",
                post_id=VALID_POST_ID,
                storage_path="p/x.jpg",
                authorization_header=CALLER_BEARER,
            )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
