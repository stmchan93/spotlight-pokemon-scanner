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

# Two distinct people plus a post: the authorization rule is expressed entirely
# in terms of "is the caller the AUTHOR of the parent post".
POST_ID = "11111111-2222-4333-8444-555555555555"
AUTHOR_USER_ID = "99999999-8888-4777-8666-555555555555"
OTHER_USER_ID = "12121212-3434-4565-8787-989898989898"
ADMIN_USER_ID = "0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e"


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


# --- Fake Supabase PostgREST (the rows the authorization rule reads) ----------


def make_fake_select(
    *,
    media: dict[str, dict] | None = None,
    posts: dict[str, dict] | None = None,
    admins: set[str] | None = None,
    blocked_pairs: set[frozenset[str]] | None = None,
    unreadable_tables: set[str] | None = None,
):
    """Stand-in for ``_supabase_rest_select`` (the privileged PostgREST reads).

    Returns row lists per table, ``[]`` for a miss, and ``None`` for a table in
    ``unreadable_tables`` so the fail-closed paths can be exercised.
    """
    media = media or {}
    posts = posts or {}
    admins = admins or set()
    blocked_pairs = blocked_pairs or set()
    unreadable_tables = unreadable_tables or set()

    def _select(table: str, params: dict[str, str]):
        if table in unreadable_tables:
            return None
        if table == "post_media":
            row = media.get(str(params["id"]).removeprefix("eq."))
            return [dict(row)] if row else []
        if table == "posts":
            row = posts.get(str(params["id"]).removeprefix("eq."))
            return [dict(row)] if row else []
        if table == "user_profiles":
            user_id = str(params["user_id"]).removeprefix("eq.")
            return [{"admin_enabled": user_id in admins}]
        if table == "blocks":
            pair = frozenset(re.findall(r"blocker_id\.eq\.([^,)]+)", params["or"]))
            return [{"blocker_id": next(iter(pair))}] if pair in blocked_pairs else []
        raise AssertionError(f"unexpected table: {table}")

    return _select


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

    def test_returns_404_when_authorization_denies(self) -> None:
        # Not visible to this caller (or no such row) → 404. The store is never
        # touched, so a denied caller cannot even cause a bucket read.
        store = Mock()
        service = self._service(store)
        handler, captured = make_post_media_get_handler(
            path=f"/api/v1/post-media/{VALID_MEDIA_ID}", service=service
        )
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=VALID_MEDIA_ID, auth_source="test"
        )
        handler._fetch_authorized_post_media_row = lambda media_id, caller: None  # type: ignore[method-assign]
        handler.do_GET()

        self.assertEqual(captured["status"], HTTPStatus.NOT_FOUND)
        store.read_bytes.assert_not_called()

    def test_returns_bytes_when_authorized(self) -> None:
        store = Mock()
        store.read_bytes.return_value = IMAGE_BYTES
        service = self._service(store)
        handler, captured = make_post_media_get_handler(
            path=f"/api/v1/post-media/{VALID_MEDIA_ID}", service=service
        )
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=AUTHOR_USER_ID, auth_source="test"
        )
        seen: dict[str, object] = {}

        def fake_fetch(media_id, caller_user_id):
            seen["media_id"] = media_id
            seen["caller_user_id"] = caller_user_id
            return {"storage_path": STORAGE_PATH, "moderation_status": "approved"}

        handler._fetch_authorized_post_media_row = fake_fetch  # type: ignore[method-assign]
        handler.do_GET()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["body"], IMAGE_BYTES)
        self.assertEqual(captured["content_type"], "image/jpeg")
        store.read_bytes.assert_called_once_with(STORAGE_PATH)
        # The authorization check is fed the VERIFIED identity, never a header.
        self.assertEqual(seen["media_id"], VALID_MEDIA_ID)
        self.assertEqual(seen["caller_user_id"], AUTHOR_USER_ID)

    def test_other_users_pending_media_is_404_end_to_end(self) -> None:
        # Full endpoint path with the real authorization helper behind it: user B
        # asking for user A's PENDING media gets a 404 and no bucket read.
        store = Mock()
        service = self._service(store)
        handler, captured = make_post_media_get_handler(
            path=f"/api/v1/post-media/{VALID_MEDIA_ID}", service=service
        )
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=OTHER_USER_ID, auth_source="test"
        )
        handler._supabase_rest_select = make_fake_select(  # type: ignore[method-assign]
            media={
                VALID_MEDIA_ID: {
                    "storage_path": STORAGE_PATH,
                    "moderation_status": "pending",
                    "post_id": POST_ID,
                }
            },
            posts={
                POST_ID: {
                    "author_id": AUTHOR_USER_ID,
                    "content_status": "visible",
                    "deleted_at": None,
                }
            },
        )
        handler.do_GET()

        self.assertEqual(captured["status"], HTTPStatus.NOT_FOUND)
        store.read_bytes.assert_not_called()


# --- authorization rule tests -------------------------------------------------


class PostMediaReadAuthorizationTests(unittest.TestCase):
    """``_fetch_authorized_post_media_row`` IS the authorization layer now.

    Each case mirrors one branch of the ``post_media_select`` RLS policy in
    apps/spotlight-rn/supabase/migrations/
    20260720090100_social_01_posts_comments_reactions.sql — the policy is left
    enabled in the database as defense in depth, but this backend no longer
    depends on it to decide.
    """

    def _handler(self, **fake_kwargs) -> SpotlightRequestHandler:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler._supabase_rest_select = make_fake_select(**fake_kwargs)  # type: ignore[method-assign]
        return handler

    @staticmethod
    def _media(status: str = "approved") -> dict[str, dict]:
        return {
            VALID_MEDIA_ID: {
                "storage_path": STORAGE_PATH,
                "moderation_status": status,
                "post_id": POST_ID,
            }
        }

    @staticmethod
    def _posts(
        *, content_status: str = "visible", deleted_at: object = None
    ) -> dict[str, dict]:
        return {
            POST_ID: {
                "author_id": AUTHOR_USER_ID,
                "content_status": content_status,
                "deleted_at": deleted_at,
            }
        }

    def test_author_sees_own_pending_media(self) -> None:
        handler = self._handler(media=self._media("pending"), posts=self._posts())
        row = handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, AUTHOR_USER_ID)
        self.assertIsNotNone(row)
        self.assertEqual(row["storage_path"], STORAGE_PATH)  # type: ignore[index]

    def test_author_sees_own_media_on_a_removed_post(self) -> None:
        # RLS: `p.author_id = auth.uid()` alone satisfies the policy.
        handler = self._handler(
            media=self._media("approved"),
            posts=self._posts(content_status="removed"),
        )
        self.assertIsNotNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, AUTHOR_USER_ID)
        )

    def test_other_user_cannot_see_pending_media(self) -> None:
        handler = self._handler(media=self._media("pending"), posts=self._posts())
        self.assertIsNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, OTHER_USER_ID)
        )

    def test_other_user_cannot_see_rejected_media(self) -> None:
        handler = self._handler(media=self._media("rejected"), posts=self._posts())
        self.assertIsNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, OTHER_USER_ID)
        )

    def test_other_user_sees_approved_media_on_a_visible_post(self) -> None:
        # NOT a widening: the RLS policy allows exactly this, and the social feed
        # depends on it.
        handler = self._handler(media=self._media("approved"), posts=self._posts())
        self.assertIsNotNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, OTHER_USER_ID)
        )

    def test_other_user_cannot_see_approved_media_on_a_removed_post(self) -> None:
        handler = self._handler(
            media=self._media("approved"),
            posts=self._posts(content_status="removed"),
        )
        self.assertIsNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, OTHER_USER_ID)
        )

    def test_blocked_user_cannot_see_approved_media(self) -> None:
        handler = self._handler(
            media=self._media("approved"),
            posts=self._posts(),
            blocked_pairs={frozenset({AUTHOR_USER_ID, OTHER_USER_ID})},
        )
        self.assertIsNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, OTHER_USER_ID)
        )

    def test_unreadable_blocks_table_fails_closed(self) -> None:
        handler = self._handler(
            media=self._media("approved"),
            posts=self._posts(),
            unreadable_tables={"blocks"},
        )
        self.assertIsNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, OTHER_USER_ID)
        )

    def test_soft_deleted_post_hides_media_from_everyone(self) -> None:
        handler = self._handler(
            media=self._media("approved"),
            posts=self._posts(deleted_at="2026-08-01T00:00:00Z"),
            admins={ADMIN_USER_ID},
        )
        for caller in (AUTHOR_USER_ID, OTHER_USER_ID, ADMIN_USER_ID):
            self.assertIsNone(
                handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, caller)
            )

    def test_admin_sees_another_users_pending_media(self) -> None:
        # Mirrors the `public.is_admin()` branch of the policy.
        handler = self._handler(
            media=self._media("pending"),
            posts=self._posts(),
            admins={ADMIN_USER_ID},
        )
        self.assertIsNotNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, ADMIN_USER_ID)
        )

    def test_unreadable_profiles_table_does_not_grant_admin(self) -> None:
        handler = self._handler(
            media=self._media("pending"),
            posts=self._posts(),
            unreadable_tables={"user_profiles"},
        )
        self.assertIsNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, OTHER_USER_ID)
        )

    def test_missing_media_row_denies(self) -> None:
        handler = self._handler(media={}, posts=self._posts())
        self.assertIsNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, AUTHOR_USER_ID)
        )

    def test_missing_parent_post_denies(self) -> None:
        handler = self._handler(media=self._media("approved"), posts={})
        self.assertIsNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, AUTHOR_USER_ID)
        )

    def test_empty_caller_denies(self) -> None:
        handler = self._handler(media=self._media("approved"), posts=self._posts())
        self.assertIsNone(handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, ""))

    def test_unreadable_supabase_denies(self) -> None:
        handler = self._handler(
            media=self._media("approved"),
            posts=self._posts(),
            unreadable_tables={"post_media"},
        )
        self.assertIsNone(
            handler._fetch_authorized_post_media_row(VALID_MEDIA_ID, AUTHOR_USER_ID)
        )


# --- privileged transport tests -----------------------------------------------


class SupabaseServiceRoleSelectTests(unittest.TestCase):
    """The PostgREST reads now use the SERVICE-ROLE key — the caller's bearer is
    never forwarded, because the backend (not Supabase) decides authorization."""

    def _handler(self) -> SpotlightRequestHandler:
        return SpotlightRequestHandler.__new__(SpotlightRequestHandler)

    def test_uses_service_role_key_and_never_the_caller_bearer(self) -> None:
        row = {
            "storage_path": STORAGE_PATH,
            "moderation_status": "approved",
            "post_id": POST_ID,
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
            captured_request["headers"] = dict(request.headers)
            return _Resp()

        env = {
            "SUPABASE_URL": "https://proj.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "service-role-key-123",
        }
        with patch.dict("os.environ", env, clear=False), patch(
            "urllib.request.urlopen", fake_urlopen
        ):
            rows = self._handler()._supabase_rest_select(
                "post_media",
                {"id": f"eq.{VALID_MEDIA_ID}", "select": "storage_path"},
            )

        self.assertEqual(rows, [row])
        self.assertIn("post_media", str(captured_request["full_url"]))
        self.assertIn(f"eq.{VALID_MEDIA_ID}", str(captured_request["full_url"]))
        headers = {k.lower(): v for k, v in captured_request["headers"].items()}  # type: ignore[union-attr]
        self.assertEqual(headers["authorization"], "Bearer service-role-key-123")
        self.assertEqual(headers["apikey"], "service-role-key-123")

    def test_returns_empty_list_on_no_rows(self) -> None:
        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"[]"

        env = {
            "SUPABASE_URL": "https://proj.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "service-role-key-123",
        }
        with patch.dict("os.environ", env, clear=False), patch(
            "urllib.request.urlopen", lambda request, timeout=None: _Resp()
        ):
            rows = self._handler()._supabase_rest_select(
                "post_media", {"id": f"eq.{VALID_MEDIA_ID}"}
            )
        self.assertEqual(rows, [])

    def test_error_object_is_not_mistaken_for_a_row(self) -> None:
        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{"message": "permission denied"}'

        env = {
            "SUPABASE_URL": "https://proj.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "service-role-key-123",
        }
        with patch.dict("os.environ", env, clear=False), patch(
            "urllib.request.urlopen", lambda request, timeout=None: _Resp()
        ):
            rows = self._handler()._supabase_rest_select(
                "post_media", {"id": f"eq.{VALID_MEDIA_ID}"}
            )
        self.assertIsNone(rows)

    def test_returns_none_when_service_role_env_missing(self) -> None:
        env = {
            "SUPABASE_URL": "https://proj.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "",
            "SPOTLIGHT_SUPABASE_SERVICE_ROLE_KEY": "",
        }
        with patch.dict("os.environ", env, clear=False):
            rows = self._handler()._supabase_rest_select(
                "post_media", {"id": f"eq.{VALID_MEDIA_ID}"}
            )
        self.assertIsNone(rows)

    def test_denies_when_supabase_env_missing(self) -> None:
        env = {
            "SUPABASE_URL": "",
            "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL": "",
            "SPOTLIGHT_SUPABASE_URL": "",
            "SUPABASE_SERVICE_ROLE_KEY": "",
            "SPOTLIGHT_SUPABASE_SERVICE_ROLE_KEY": "",
        }
        with patch.dict("os.environ", env, clear=False):
            result = self._handler()._fetch_authorized_post_media_row(
                VALID_MEDIA_ID, AUTHOR_USER_ID
            )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
