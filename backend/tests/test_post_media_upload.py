from __future__ import annotations

import io
import json
import re
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
MEDIA_ID = "11111111-2222-4333-8444-555555555555"
JPEG_BYTES = b"\xff\xd8\xff\xe0post-image-bytes\x00\xff\xd9"
POST_MEDIA_PATH = "/api/v1/post-media"
CALLER_BEARER = "Bearer caller-jwt"

AUTHOR_USER_ID = "99999999-8888-4777-8666-555555555555"
OTHER_USER_ID = "12121212-3434-4565-8787-989898989898"
ADMIN_USER_ID = "0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e"

SERVICE_ROLE_ENV = {
    "SUPABASE_URL": "https://proj.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "service-role-key-123",
}


def make_fake_select(
    *,
    posts: dict[str, dict] | None = None,
    media: dict[str, dict] | None = None,
    admins: set[str] | None = None,
    unreadable_tables: set[str] | None = None,
):
    """Stand-in for ``_supabase_rest_select`` (the privileged PostgREST reads)."""
    posts = posts or {}
    media = media or {}
    admins = admins or set()
    unreadable_tables = unreadable_tables or set()

    def _select(table: str, params: dict[str, str]):
        if table in unreadable_tables:
            return None
        if table == "posts":
            row = posts.get(str(params["id"]).removeprefix("eq."))
            return [dict(row)] if row else []
        if table == "post_media":
            row = media.get(str(params["id"]).removeprefix("eq."))
            return [dict(row)] if row else []
        if table == "user_profiles":
            user_id = str(params["user_id"]).removeprefix("eq.")
            return [{"admin_enabled": user_id in admins}]
        if table == "blocks":
            re.findall(r"blocker_id\.eq\.([^,)]+)", params["or"])
            return []
        raise AssertionError(f"unexpected table: {table}")

    return _select


def authored_post(author_id: str = AUTHOR_USER_ID) -> dict[str, dict]:
    return {
        VALID_POST_ID: {
            "author_id": author_id,
            "content_status": "visible",
            "deleted_at": None,
        }
    }


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

    def _grant_identity(
        self, handler: SpotlightRequestHandler, user_id: str = AUTHOR_USER_ID
    ) -> None:
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=user_id, auth_source="test"
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

    def test_returns_403_when_insert_is_refused(self) -> None:
        # Caller doesn't author the post → no row → 403, and the bytes are NEVER
        # uploaded.
        store = Mock()
        service = self._service(store)
        handler, captured = make_post_media_post_handler(
            body=JPEG_BYTES, service=service
        )
        self._grant_identity(handler)
        handler._insert_post_media_row = lambda **kwargs: None  # type: ignore[method-assign]
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.FORBIDDEN)
        store.store_bytes.assert_not_called()

    def test_non_author_gets_403_end_to_end(self) -> None:
        # Full endpoint path with the real authorization helper behind it: user B
        # cannot attach media to user A's post, and nothing is uploaded.
        store = Mock()
        service = self._service(store)
        handler, captured = make_post_media_post_handler(
            body=JPEG_BYTES, service=service
        )
        self._grant_identity(handler, OTHER_USER_ID)
        handler._supabase_rest_select = make_fake_select(posts=authored_post())  # type: ignore[method-assign]
        with patch.dict("os.environ", SERVICE_ROLE_ENV, clear=False), patch(
            "urllib.request.urlopen"
        ) as urlopen:
            handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.FORBIDDEN)
        store.store_bytes.assert_not_called()
        urlopen.assert_not_called()  # no INSERT was even attempted

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

        handler._insert_post_media_row = fake_insert  # type: ignore[method-assign]
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        media_id = captured["payload"]["mediaId"]  # type: ignore[index]
        # storage_path is namespaced under the post id: "<postId>/<mediaId>.jpg".
        expected_path = f"{VALID_POST_ID}/{media_id}.jpg"
        self.assertEqual(insert_calls["post_id"], VALID_POST_ID)
        self.assertEqual(insert_calls["storage_path"], expected_path)
        # The insert is authorized against the VERIFIED identity, not a header.
        self.assertEqual(insert_calls["caller_user_id"], AUTHOR_USER_ID)
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
        handler._insert_post_media_row = lambda **kwargs: {  # type: ignore[method-assign]
            "id": kwargs["media_id"],
        }
        deleted: dict[str, object] = {}

        def fake_delete(media_id, *, post_id, caller_user_id):
            deleted.update(
                {
                    "media_id": media_id,
                    "post_id": post_id,
                    "caller_user_id": caller_user_id,
                }
            )

        handler._delete_post_media_row = fake_delete  # type: ignore[method-assign]
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.BAD_GATEWAY)
        # The just-inserted row is rolled back, authorized as the verified caller.
        self.assertEqual(deleted["caller_user_id"], AUTHOR_USER_ID)
        self.assertEqual(deleted["post_id"], VALID_POST_ID)
        self.assertIn("media_id", deleted)


# --- authorization rule tests -------------------------------------------------


class _RecordingResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._body


class PostMediaWriteAuthorizationTests(unittest.TestCase):
    """``_insert_post_media_row`` / ``_delete_post_media_row`` ARE the
    authorization layer now.

    They mirror the ``post_media_write`` RLS policy in
    apps/spotlight-rn/supabase/migrations/
    20260720090100_social_01_posts_comments_reactions.sql:
      * WITH CHECK (insert): the parent post's AUTHOR only.
      * USING (delete): the parent post's author, or an admin.
    """

    def _handler(self, **fake_kwargs) -> SpotlightRequestHandler:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler._supabase_rest_select = make_fake_select(**fake_kwargs)  # type: ignore[method-assign]
        return handler

    def test_author_insert_posts_the_row_with_the_service_role_key(self) -> None:
        storage_path = f"{VALID_POST_ID}/{MEDIA_ID}.jpg"
        row = {
            "id": MEDIA_ID,
            "post_id": VALID_POST_ID,
            "storage_path": storage_path,
            "moderation_status": "pending",
        }
        captured_request: dict[str, object] = {}

        def fake_urlopen(request, timeout=None):
            captured_request["full_url"] = request.full_url
            captured_request["method"] = request.get_method()
            captured_request["headers"] = dict(request.headers)
            captured_request["data"] = request.data
            return _RecordingResponse(json.dumps([row]).encode("utf-8"))

        handler = self._handler(posts=authored_post())
        with patch.dict("os.environ", SERVICE_ROLE_ENV, clear=False), patch(
            "urllib.request.urlopen", fake_urlopen
        ):
            result = handler._insert_post_media_row(
                media_id=MEDIA_ID,
                post_id=VALID_POST_ID,
                storage_path=storage_path,
                caller_user_id=AUTHOR_USER_ID,
            )

        self.assertEqual(result, row)
        self.assertEqual(captured_request["method"], "POST")
        self.assertIn("post_media", str(captured_request["full_url"]))
        headers = {k.lower(): v for k, v in captured_request["headers"].items()}  # type: ignore[union-attr]
        # Service-role, NOT the caller's bearer: the backend already authorized.
        self.assertEqual(headers["authorization"], "Bearer service-role-key-123")
        self.assertEqual(headers["apikey"], "service-role-key-123")
        # moderation_status is omitted so it defaults to pending server-side.
        body = json.loads(captured_request["data"].decode("utf-8"))  # type: ignore[union-attr]
        self.assertEqual(body["id"], MEDIA_ID)
        self.assertEqual(body["post_id"], VALID_POST_ID)
        self.assertEqual(body["storage_path"], storage_path)
        self.assertNotIn("moderation_status", body)

    def test_non_author_insert_is_refused_without_touching_postgrest(self) -> None:
        handler = self._handler(posts=authored_post())
        with patch.dict("os.environ", SERVICE_ROLE_ENV, clear=False), patch(
            "urllib.request.urlopen"
        ) as urlopen:
            result = handler._insert_post_media_row(
                media_id=MEDIA_ID,
                post_id=VALID_POST_ID,
                storage_path=f"{VALID_POST_ID}/{MEDIA_ID}.jpg",
                caller_user_id=OTHER_USER_ID,
            )
        self.assertIsNone(result)
        urlopen.assert_not_called()

    def test_admin_insert_is_refused(self) -> None:
        # The SQL `with check` is author-only — admins are NOT in it.
        handler = self._handler(posts=authored_post(), admins={ADMIN_USER_ID})
        with patch.dict("os.environ", SERVICE_ROLE_ENV, clear=False), patch(
            "urllib.request.urlopen"
        ) as urlopen:
            result = handler._insert_post_media_row(
                media_id=MEDIA_ID,
                post_id=VALID_POST_ID,
                storage_path=f"{VALID_POST_ID}/{MEDIA_ID}.jpg",
                caller_user_id=ADMIN_USER_ID,
            )
        self.assertIsNone(result)
        urlopen.assert_not_called()

    def test_insert_denied_when_post_is_missing(self) -> None:
        handler = self._handler(posts={})
        with patch.dict("os.environ", SERVICE_ROLE_ENV, clear=False), patch(
            "urllib.request.urlopen"
        ) as urlopen:
            result = handler._insert_post_media_row(
                media_id=MEDIA_ID,
                post_id=VALID_POST_ID,
                storage_path=f"{VALID_POST_ID}/{MEDIA_ID}.jpg",
                caller_user_id=AUTHOR_USER_ID,
            )
        self.assertIsNone(result)
        urlopen.assert_not_called()

    def test_author_delete_is_scoped_to_id_and_post_id(self) -> None:
        captured_request: dict[str, object] = {}

        def fake_urlopen(request, timeout=None):
            captured_request["full_url"] = request.full_url
            captured_request["method"] = request.get_method()
            captured_request["headers"] = dict(request.headers)
            return _RecordingResponse(b"")

        handler = self._handler(posts=authored_post())
        with patch.dict("os.environ", SERVICE_ROLE_ENV, clear=False), patch(
            "urllib.request.urlopen", fake_urlopen
        ):
            handler._delete_post_media_row(
                MEDIA_ID, post_id=VALID_POST_ID, caller_user_id=AUTHOR_USER_ID
            )

        self.assertEqual(captured_request["method"], "DELETE")
        full_url = str(captured_request["full_url"])
        self.assertIn(f"id=eq.{MEDIA_ID}", full_url)
        self.assertIn(f"post_id=eq.{VALID_POST_ID}", full_url)
        headers = {k.lower(): v for k, v in captured_request["headers"].items()}  # type: ignore[union-attr]
        self.assertEqual(headers["authorization"], "Bearer service-role-key-123")

    def test_non_author_cannot_delete_another_users_media(self) -> None:
        handler = self._handler(posts=authored_post())
        with patch.dict("os.environ", SERVICE_ROLE_ENV, clear=False), patch(
            "urllib.request.urlopen"
        ) as urlopen:
            handler._delete_post_media_row(
                MEDIA_ID, post_id=VALID_POST_ID, caller_user_id=OTHER_USER_ID
            )
        urlopen.assert_not_called()

    def test_admin_may_delete(self) -> None:
        # Mirrors the `using` clause, which DOES include `public.is_admin()`.
        handler = self._handler(posts=authored_post(), admins={ADMIN_USER_ID})
        with patch.dict("os.environ", SERVICE_ROLE_ENV, clear=False), patch(
            "urllib.request.urlopen",
            lambda request, timeout=None: _RecordingResponse(b""),
        ):
            handler._delete_post_media_row(
                MEDIA_ID, post_id=VALID_POST_ID, caller_user_id=ADMIN_USER_ID
            )
        self.assertTrue(
            handler._caller_may_delete_post_media(VALID_POST_ID, ADMIN_USER_ID)
        )
        self.assertFalse(
            handler._caller_may_delete_post_media(VALID_POST_ID, OTHER_USER_ID)
        )

    def test_delete_requires_both_ids(self) -> None:
        handler = self._handler(posts=authored_post())
        with patch.dict("os.environ", SERVICE_ROLE_ENV, clear=False), patch(
            "urllib.request.urlopen"
        ) as urlopen:
            handler._delete_post_media_row(
                "", post_id=VALID_POST_ID, caller_user_id=AUTHOR_USER_ID
            )
            handler._delete_post_media_row(
                MEDIA_ID, post_id="", caller_user_id=AUTHOR_USER_ID
            )
        urlopen.assert_not_called()

    def test_insert_returns_none_when_service_role_env_missing(self) -> None:
        env = {
            "SUPABASE_URL": "",
            "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL": "",
            "SPOTLIGHT_SUPABASE_URL": "",
            "SUPABASE_SERVICE_ROLE_KEY": "",
            "SPOTLIGHT_SUPABASE_SERVICE_ROLE_KEY": "",
        }
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        with patch.dict("os.environ", env, clear=False):
            result = handler._insert_post_media_row(
                media_id=MEDIA_ID,
                post_id=VALID_POST_ID,
                storage_path=f"{VALID_POST_ID}/{MEDIA_ID}.jpg",
                caller_user_id=AUTHOR_USER_ID,
            )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
