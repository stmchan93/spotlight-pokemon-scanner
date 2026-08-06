"""Tests for the async social moderation worker's image pass.

The worker used to mint a Supabase Storage signed URL for each pending
``post_media`` row, but the bytes now live in a PRIVATE GCS bucket read through
``post_media_store``. These tests pin the new contract:

  - the bytes reach the moderation model base64-inlined as a ``data:`` URL
  - the worker degrades safely (text pass only) when the bucket is unconfigured
  - the Supabase PostgREST polling / write-back contract is unchanged
"""

from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import social_moderation_worker as worker  # noqa: E402
from post_media_store import (  # noqa: E402
    POST_MEDIA_GCS_BUCKET_ENV,
    GoogleCloudPostMediaStore,
    PostMediaStoreError,
)


MEDIA_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
POST_ID = "11111111-2222-4333-8444-555555555555"
STORAGE_PATH = f"{POST_ID}/{MEDIA_ID}.jpg"
IMAGE_BYTES = b"\xff\xd8\xff\xe0post-media-bytes\x00\xff\xd9"


# --- Fake GCS plumbing (mirrors test_post_media_serving) ----------------------


class _FakeBlob:
    def __init__(self, name: str) -> None:
        self.name = name
        self.data: bytes | None = None

    def download_as_bytes(self) -> bytes:
        if self.data is None:
            raise RuntimeError("object not found")
        return self.data


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


class _WorkerTestCase(unittest.TestCase):
    """Shared harness: no real network, no real GCS, no cached store leaking."""

    def setUp(self) -> None:
        worker._reset_media_store_cache()
        self.addCleanup(worker._reset_media_store_cache)

        self.fetched: list[tuple[str, str]] = []
        self.patched: list[tuple[str, str, dict]] = []
        self.moderated: list[list[dict]] = []

        def fake_fetch(table: str, query: str):
            self.fetched.append((table, query))
            return self.rows_for(table)

        def fake_patch(table: str, match: str, payload: dict) -> None:
            self.patched.append((table, match, payload))

        def fake_moderate(inputs: list[dict]) -> bool:
            self.moderated.append(inputs)
            return self.flagged

        self.flagged = False
        for name, fn in (
            ("_fetch", fake_fetch),
            ("_patch", fake_patch),
            ("_moderate", fake_moderate),
        ):
            patcher = patch.object(worker, name, fn)
            patcher.start()
            self.addCleanup(patcher.stop)

    def rows_for(self, table: str) -> list[dict]:
        if table == "post_media":
            return list(self.media_rows)
        return []

    media_rows: list[dict] = []

    def _install_store(self, *, bytes_at_path: bytes | None = IMAGE_BYTES) -> object:
        client = _FakeGCSClient()
        store = GoogleCloudPostMediaStore("looty-post-media", client=client)
        if bytes_at_path is not None:
            client.buckets["looty-post-media"].blob(STORAGE_PATH).data = bytes_at_path
        worker._media_store = store
        return store

    def _media_status_writes(self) -> list[tuple[str, str]]:
        return [
            (match, payload["moderation_status"])
            for table, match, payload in self.patched
            if table == "post_media" and "moderation_status" in payload
        ]


# --- the GCS read path --------------------------------------------------------


class ModerateMediaGcsReadPathTests(_WorkerTestCase):
    def test_reads_from_gcs_and_inlines_bytes_as_data_url(self) -> None:
        self.media_rows = [{"id": MEDIA_ID, "storage_path": STORAGE_PATH}]
        self._install_store()

        handled = worker._moderate_media()

        self.assertEqual(handled, 1)
        # Polling contract unchanged: pending rows via PostgREST.
        table, query = self.fetched[0]
        self.assertEqual(table, "post_media")
        self.assertIn("moderation_status=eq.pending", query)
        self.assertIn("select=id,storage_path", query)

        # The image reached the model as a base64 data URL, not a signed URL.
        (inputs,) = self.moderated
        url = inputs[0]["image_url"]["url"]
        expected = base64.b64encode(IMAGE_BYTES).decode("ascii")
        self.assertEqual(url, f"data:image/jpeg;base64,{expected}")
        self.assertNotIn("supabase", url)
        self.assertNotIn("storage.googleapis.com", url)

        self.assertEqual(
            self._media_status_writes(), [(f"id=eq.{MEDIA_ID}", "approved")]
        )

    def test_flagged_image_is_rejected(self) -> None:
        self.media_rows = [{"id": MEDIA_ID, "storage_path": STORAGE_PATH}]
        self._install_store()
        self.flagged = True

        worker._moderate_media()

        self.assertEqual(
            self._media_status_writes(), [(f"id=eq.{MEDIA_ID}", "rejected")]
        )

    def test_store_is_asked_for_the_row_storage_path(self) -> None:
        self.media_rows = [{"id": MEDIA_ID, "storage_path": STORAGE_PATH}]
        store = Mock()
        store.read_bytes.return_value = IMAGE_BYTES
        worker._media_store = store

        worker._moderate_media()

        store.read_bytes.assert_called_once_with(STORAGE_PATH)

    def test_webp_object_gets_a_webp_data_url(self) -> None:
        webp_path = f"{POST_ID}/{MEDIA_ID}.webp"
        self.media_rows = [{"id": MEDIA_ID, "storage_path": webp_path}]
        store = Mock()
        store.read_bytes.return_value = IMAGE_BYTES
        worker._media_store = store

        worker._moderate_media()

        url = self.moderated[0][0]["image_url"]["url"]
        self.assertTrue(url.startswith("data:image/webp;base64,"))

    def test_each_row_is_moderated_independently(self) -> None:
        other_id = "99999999-8888-4777-8666-555555555555"
        other_path = f"{POST_ID}/{other_id}.jpg"
        self.media_rows = [
            {"id": MEDIA_ID, "storage_path": STORAGE_PATH},
            {"id": other_id, "storage_path": other_path},
        ]
        store = Mock()
        store.read_bytes.side_effect = [RuntimeError("gcs down"), IMAGE_BYTES]
        worker._media_store = store

        with self.assertLogs(worker.log, level="ERROR"):
            handled = worker._moderate_media()

        # A bad row does not abort the batch; the good row is still approved.
        self.assertEqual(handled, 2)
        self.assertEqual(
            self._media_status_writes(), [(f"id=eq.{other_id}", "approved")]
        )


# --- failure handling ---------------------------------------------------------


class ModerateMediaFailureTests(_WorkerTestCase):
    def test_transient_read_error_leaves_the_row_pending(self) -> None:
        self.media_rows = [{"id": MEDIA_ID, "storage_path": STORAGE_PATH}]
        # Object absent from the bucket → the fake blob raises.
        self._install_store(bytes_at_path=None)

        with self.assertLogs(worker.log, level="ERROR"):
            worker._moderate_media()

        # No verdict written: it stays 'pending' (hidden by RLS) and retries.
        self.assertEqual(self._media_status_writes(), [])
        self.assertEqual(self.moderated, [])

    def test_unusable_storage_path_is_rejected_not_retried(self) -> None:
        self.media_rows = [{"id": MEDIA_ID, "storage_path": "../escape.jpg"}]
        store = Mock()
        store.read_bytes.side_effect = PostMediaStoreError("bad segment")
        worker._media_store = store

        with self.assertLogs(worker.log, level="ERROR"):
            worker._moderate_media()

        self.assertEqual(
            self._media_status_writes(), [(f"id=eq.{MEDIA_ID}", "rejected")]
        )
        self.assertEqual(self.moderated, [])

    def test_missing_storage_path_is_rejected(self) -> None:
        self.media_rows = [{"id": MEDIA_ID, "storage_path": None}]
        store = Mock()
        worker._media_store = store

        with self.assertLogs(worker.log, level="WARNING"):
            worker._moderate_media()

        self.assertEqual(
            self._media_status_writes(), [(f"id=eq.{MEDIA_ID}", "rejected")]
        )
        store.read_bytes.assert_not_called()

    def test_empty_object_is_left_pending(self) -> None:
        self.media_rows = [{"id": MEDIA_ID, "storage_path": STORAGE_PATH}]
        store = Mock()
        store.read_bytes.return_value = b""
        worker._media_store = store

        with self.assertLogs(worker.log, level="WARNING"):
            worker._moderate_media()

        self.assertEqual(self._media_status_writes(), [])
        self.assertEqual(self.moderated, [])

    def test_oversized_object_is_rejected_without_calling_openai(self) -> None:
        self.media_rows = [{"id": MEDIA_ID, "storage_path": STORAGE_PATH}]
        store = Mock()
        store.read_bytes.return_value = b"x" * (worker.MAX_IMAGE_BYTES + 1)
        worker._media_store = store

        with self.assertLogs(worker.log, level="WARNING"):
            worker._moderate_media()

        self.assertEqual(
            self._media_status_writes(), [(f"id=eq.{MEDIA_ID}", "rejected")]
        )
        self.assertEqual(self.moderated, [])


# --- the not-configured path --------------------------------------------------


class MediaStoreNotConfiguredTests(_WorkerTestCase):
    def test_store_is_none_when_bucket_env_unset(self) -> None:
        with patch.dict("os.environ", {POST_MEDIA_GCS_BUCKET_ENV: ""}, clear=False):
            with self.assertLogs(worker.log, level="WARNING"):
                self.assertIsNone(worker._get_media_store())

    def test_media_pass_is_skipped_when_unconfigured(self) -> None:
        self.media_rows = [{"id": MEDIA_ID, "storage_path": STORAGE_PATH}]
        with patch.dict("os.environ", {POST_MEDIA_GCS_BUCKET_ENV: ""}, clear=False):
            with self.assertLogs(worker.log, level="WARNING"):
                handled = worker._moderate_media()

        # Nothing polled, nothing moderated, nothing written — and no crash.
        self.assertEqual(handled, 0)
        self.assertEqual(self.fetched, [])
        self.assertEqual(self.moderated, [])
        self.assertEqual(self.patched, [])

    def test_client_construction_failure_degrades_instead_of_crashing(self) -> None:
        env = {POST_MEDIA_GCS_BUCKET_ENV: "looty-post-media"}
        with patch.dict("os.environ", env, clear=False), patch.object(
            worker,
            "build_post_media_store",
            side_effect=RuntimeError("google-cloud-storage is not installed"),
        ):
            with self.assertLogs(worker.log, level="ERROR"):
                self.assertIsNone(worker._get_media_store())

    def test_store_result_is_cached_across_batches(self) -> None:
        env = {POST_MEDIA_GCS_BUCKET_ENV: "looty-post-media"}
        builder = Mock(return_value=Mock())
        with patch.dict("os.environ", env, clear=False), patch.object(
            worker, "build_post_media_store", builder
        ):
            first = worker._get_media_store()
            second = worker._get_media_store()

        self.assertIs(first, second)
        builder.assert_called_once_with(gcs_bucket="looty-post-media")

    def test_run_once_still_does_the_text_pass_without_the_bucket(self) -> None:
        with patch.dict("os.environ", {POST_MEDIA_GCS_BUCKET_ENV: ""}, clear=False):
            with self.assertLogs(worker.log, level="WARNING"):
                worker.run_once()

        polled = [table for table, _ in self.fetched]
        self.assertEqual(polled, ["posts", "comments"])


# --- unchanged Supabase contract ---------------------------------------------


class UnchangedWorkerContractTests(_WorkerTestCase):
    def rows_for(self, table: str) -> list[dict]:
        if table in {"posts", "comments"}:
            return [{"id": 7, "body": "hello"}]
        return []

    def test_text_pass_polls_and_stamps_the_same_way(self) -> None:
        handled = worker._moderate_text_table("posts")

        self.assertEqual(handled, 1)
        table, query = self.fetched[0]
        self.assertEqual(table, "posts")
        self.assertIn("moderation_checked_at=is.null", query)
        self.assertEqual(
            self.patched, [("posts", "id=eq.7", {"moderation_checked_at": "now()"})]
        )

    def test_flagged_text_is_removed(self) -> None:
        self.flagged = True
        worker._moderate_text_table("comments")

        self.assertEqual(
            self.patched[0][2],
            {"moderation_checked_at": "now()", "content_status": "removed"},
        )

    def test_supabase_storage_signing_is_gone(self) -> None:
        # Regression guard: the bytes are not in Supabase Storage any more, so
        # nothing may reintroduce a bucket signing path here.
        self.assertFalse(hasattr(worker, "_sign_object"))
        self.assertFalse(hasattr(worker, "STORAGE_BUCKET"))
        source = (BACKEND_ROOT / "social_moderation_worker.py").read_text()
        self.assertNotIn("/storage/v1/object/sign/", source)


if __name__ == "__main__":
    unittest.main()
