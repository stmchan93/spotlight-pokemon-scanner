"""Account deletion must erase the user's BYTES, not just the rows.

`DELETE /api/v1/account/delete` used to delete owner-scoped SQLite rows and the
Supabase auth user (which cascades posts/comments/messages/post_media) while
every image the user ever uploaded stayed in Google Cloud Storage, orphaned.
GDPR/CCPA erasure covers the image itself, not the row that points at it, and
this is the App Store 5.1.1(v) path, so it has to be genuinely complete.

These tests pin the properties that make that safe rather than the happy path:

  - objects are erased across all three stores (avatars, post media, scan
    artifacts + transaction photos)
  - post_media paths are captured BEFORE the auth-user cascade destroys them
  - objects are deleted while their pointers are still alive (a crash mid-sweep
    is retryable; the reverse strands files with nothing pointing at them)
  - an already-absent object is a no-op, not an error (users retry)
  - an unconfigured store is skipped and reported, never fatal
  - a storage failure NEVER blocks the account deletion, and is reported
  - the sweep is bounded by object count and by wall clock
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from avatar_store import (  # noqa: E402
    AvatarStoreError,
    GoogleCloudAvatarStore,
    owner_object_paths as avatar_owner_object_paths,
)
from catalog_tools import apply_schema, connect  # noqa: E402
from post_media_store import (  # noqa: E402
    GoogleCloudPostMediaStore,
    PostMediaStoreError,
)
from request_auth import RequestIdentity  # noqa: E402
from scan_artifact_store import (  # noqa: E402
    FilesystemScanArtifactStore,
    GoogleCloudScanArtifactStore,
    ScanArtifactStoreError,
    is_missing_object_error,
)
from server import (  # noqa: E402
    AVATAR_STORE_NAME,
    POST_MEDIA_STORE_NAME,
    SCAN_ARTIFACT_STORE_NAME,
    AccountStorageTarget,
    SpotlightScanService,
)

# Real Supabase auth ids are UUIDs, and the avatars bucket derives its object
# path from one, so the tests use UUID-shaped owners like production does.
OWNER_ID = "11111111-2222-4333-8444-555555555555"
OTHER_OWNER_ID = "99999999-8888-4777-8666-555555555555"

SUPABASE_ENV = {
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "service-role-key",
}


# --------------------------------------------------------------------------- #
# Fake GCS plumbing (same shape as test_post_media_serving / test_post_media_purge)
# --------------------------------------------------------------------------- #
class _NotFound(Exception):
    """Shaped like google.api_core.exceptions.NotFound."""

    code = 404


class _FakeBlob:
    def __init__(self, name: str, bucket: "_FakeBucket") -> None:
        self.name = name
        self._bucket = bucket

    def upload_from_string(self, data, *, content_type: str | None = None) -> None:
        self._bucket.existing.add(self.name)

    def delete(self) -> None:
        self._bucket.delete_calls.append(self.name)
        if self._bucket.on_delete is not None:
            self._bucket.on_delete(self.name)
        error = self._bucket.errors.get(self.name, self._bucket.error)
        if error is not None:
            raise error
        if self.name not in self._bucket.existing:
            raise _NotFound(f"{self.name} is gone")
        self._bucket.existing.discard(self.name)
        self._bucket.deleted.append(self.name)


class _FakeBucket:
    def __init__(self, name: str) -> None:
        self.name = name
        self.existing: set[str] = set()
        self.deleted: list[str] = []
        self.delete_calls: list[str] = []
        self.errors: dict[str, Exception] = {}
        self.error: Exception | None = None
        self.on_delete = None

    def blob(self, name: str) -> _FakeBlob:
        return _FakeBlob(name, self)


class _FakeGCSClient:
    def __init__(self) -> None:
        self.buckets: dict[str, _FakeBucket] = {}

    def bucket(self, name: str) -> _FakeBucket:
        return self.buckets.setdefault(name, _FakeBucket(name))


# --------------------------------------------------------------------------- #
# Fake Supabase (PostgREST listing + the auth-user admin DELETE)
# --------------------------------------------------------------------------- #
class _FakeResponse:
    def __init__(self, body: bytes = b"[]", status: int = 200) -> None:
        self._body = body
        self.status = status

    def read(self) -> bytes:
        return self._body

    def getcode(self) -> int:
        return self.status

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *args) -> bool:
        return False


class FakeSupabase:
    """Stands in for PostgREST + the auth admin API over one urlopen patch.

    Deleting the auth user CASCADES the post_media rows away, and this fake
    models that: `rows` is emptied when the admin DELETE lands. A listing read
    after the cascade therefore returns nothing — which is exactly how the
    ordering test detects a regression.
    """

    def __init__(
        self,
        *,
        rows: list[dict] | None = None,
        auth_status: int = 200,
        listing_error: Exception | None = None,
    ) -> None:
        self.rows = list(rows or [])
        self.auth_status = auth_status
        self.listing_error = listing_error
        self.calls: list[str] = []

    def urlopen(self, request, timeout=None):  # noqa: ARG002 - signature match
        url = request.full_url
        method = request.get_method()
        if "/auth/v1/admin/users/" in url:
            self.calls.append("auth_delete")
            # The FK cascade: post_media rows for this author cease to exist.
            self.rows = []
            return _FakeResponse(b"", status=self.auth_status)
        if "/rest/v1/post_media" in url:
            self.calls.append("post_media_listing")
            if self.listing_error is not None:
                raise self.listing_error
            body = json.dumps(self.rows).encode("utf-8")
            return _FakeResponse(body)
        raise AssertionError(f"unexpected {method} {url}")


def _media_row(storage_path: str) -> dict:
    return {"storage_path": storage_path, "posts": {"author_id": OWNER_ID}}


# --------------------------------------------------------------------------- #
# Shared service harness
# --------------------------------------------------------------------------- #
class _AccountDeletionTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "account-deletion.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

        self.gcs = _FakeGCSClient()

    # -- store wiring ------------------------------------------------------
    def wire_gcs_stores(self) -> None:
        """Point all three stores at the fake GCS client (production shape)."""
        self.service.avatar_store = GoogleCloudAvatarStore(
            "looty-avatars", client=self.gcs
        )
        self.service.post_media_store = GoogleCloudPostMediaStore(
            "looty-post-media", client=self.gcs
        )
        self.service.artifact_store = GoogleCloudScanArtifactStore(
            "looty-scan-artifacts", client=self.gcs
        )

    @property
    def avatars(self) -> _FakeBucket:
        return self.gcs.bucket("looty-avatars")

    @property
    def post_media(self) -> _FakeBucket:
        return self.gcs.bucket("looty-post-media")

    @property
    def artifacts(self) -> _FakeBucket:
        return self.gcs.bucket("looty-scan-artifacts")

    # -- row fixtures ------------------------------------------------------
    def insert_scan_artifact(
        self,
        *,
        scan_id: str,
        owner_user_id: str = OWNER_ID,
        source_path: str | None = None,
        normalized_path: str | None = None,
    ) -> tuple[str, str]:
        source_path = source_path or f"scans/2026/08/01/{scan_id}/source_capture.jpg"
        normalized_path = (
            normalized_path or f"scans/2026/08/01/{scan_id}/normalized_target.jpg"
        )
        self.service.connection.execute(
            "INSERT INTO scan_events (scan_id, owner_user_id, created_at, "
            "request_json, response_json) VALUES (?, ?, ?, '{}', '{}')",
            (scan_id, owner_user_id, "2026-08-01T00:00:00Z"),
        )
        self.service.connection.execute(
            "INSERT INTO scan_artifacts (scan_id, owner_user_id, source_object_path, "
            "normalized_object_path, upload_status, artifact_version, created_at) "
            "VALUES (?, ?, ?, ?, 'uploaded', 'v1', ?)",
            (
                scan_id,
                owner_user_id,
                source_path,
                normalized_path,
                "2026-08-01T00:00:00Z",
            ),
        )
        self.service.connection.commit()
        return source_path, normalized_path

    def insert_transaction_photo(
        self,
        *,
        transaction_id: str,
        owner_user_id: str = OWNER_ID,
        photo_path: str | None = None,
    ) -> str:
        photo_path = (
            photo_path or f"transactions/2026/08/01/{transaction_id}/photo.jpg"
        )
        self.service.connection.execute(
            "INSERT INTO card_transactions (id, owner_user_id, kind, item_count, "
            "currency_code, photo_object_path, photo_upload_status, occurred_at, "
            "created_at) VALUES (?, ?, 'bought', 1, 'USD', ?, 'uploaded', ?, ?)",
            (
                transaction_id,
                owner_user_id,
                photo_path,
                "2026-08-01T00:00:00Z",
                "2026-08-01T00:00:00Z",
            ),
        )
        self.service.connection.commit()
        return photo_path

    def owner_row_count(self, table: str, owner_user_id: str = OWNER_ID) -> int:
        row = self.service.connection.execute(
            f"SELECT COUNT(*) FROM {table} WHERE owner_user_id = ?",
            (owner_user_id,),
        ).fetchone()
        return int(row[0])

    # -- invocation --------------------------------------------------------
    def delete_account(
        self,
        *,
        supabase: FakeSupabase | None = None,
        owner_user_id: str = OWNER_ID,
    ) -> dict:
        identity = RequestIdentity(user_id=owner_user_id, auth_source="test")
        if supabase is None:
            with self.service.request_identity_context(identity):
                return self.service.delete_account({})
        with patch.dict(os.environ, SUPABASE_ENV, clear=False):
            with patch("urllib.request.urlopen", supabase.urlopen):
                with self.service.request_identity_context(identity):
                    return self.service.delete_account({})


# --------------------------------------------------------------------------- #
# The whole sweep
# --------------------------------------------------------------------------- #
class AllThreeStoresTests(_AccountDeletionTestCase):
    def test_objects_are_deleted_across_all_three_stores(self) -> None:
        self.wire_gcs_stores()

        avatar_path, cover_path = avatar_owner_object_paths(OWNER_ID)
        self.avatars.existing.update({avatar_path, cover_path})

        media_path = f"{OWNER_ID}/photo.jpg"
        self.post_media.existing.add(media_path)

        source, normalized = self.insert_scan_artifact(scan_id="scan-1")
        photo = self.insert_transaction_photo(transaction_id="txn-1")
        artifacts_json = "scans/2026/08/01/scan-1/artifacts.json"
        self.artifacts.existing.update({source, normalized, photo, artifacts_json})

        supabase = FakeSupabase(rows=[_media_row(media_path)])
        result = self.delete_account(supabase=supabase)

        self.assertTrue(result["deleted"])
        self.assertTrue(result["authUserDeleted"])

        self.assertEqual(sorted(self.avatars.deleted), sorted([avatar_path, cover_path]))
        self.assertEqual(self.post_media.deleted, [media_path])
        self.assertEqual(
            sorted(self.artifacts.deleted),
            sorted([source, normalized, artifacts_json, photo]),
        )

        storage = result["storage"]
        self.assertTrue(storage["complete"], storage)
        self.assertEqual(storage["deletedObjects"], 7)
        self.assertEqual(storage["failedObjects"], 0)
        self.assertEqual(storage["deferredObjects"], 0)
        self.assertEqual(storage["unresolvedObjects"], [])
        self.assertEqual(storage["problems"], [])

        # And the rows are gone too — the storage sweep does not replace them.
        self.assertEqual(self.owner_row_count("scan_artifacts"), 0)
        self.assertEqual(self.owner_row_count("card_transactions"), 0)

    def test_only_the_calling_owners_objects_are_touched(self) -> None:
        self.wire_gcs_stores()
        mine, _ = self.insert_scan_artifact(scan_id="scan-mine")
        theirs, _ = self.insert_scan_artifact(
            scan_id="scan-theirs", owner_user_id=OTHER_OWNER_ID
        )
        self.artifacts.existing.update({mine, theirs})

        self.delete_account(supabase=FakeSupabase())

        self.assertIn(mine, self.artifacts.deleted)
        self.assertNotIn(theirs, self.artifacts.deleted)
        self.assertNotIn(theirs, self.artifacts.delete_calls)
        self.assertEqual(self.owner_row_count("scan_artifacts", OTHER_OWNER_ID), 1)

    def test_the_per_scan_artifacts_json_is_swept_with_its_images(self) -> None:
        """No row records its path; it is derived from the image directory."""
        self.wire_gcs_stores()
        source, _ = self.insert_scan_artifact(scan_id="scan-json")
        self.artifacts.existing.add("scans/2026/08/01/scan-json/artifacts.json")

        self.delete_account(supabase=FakeSupabase())

        self.assertIn("scans/2026/08/01/scan-json/artifacts.json", self.artifacts.deleted)
        self.assertTrue(source.startswith("scans/2026/08/01/scan-json/"))


# --------------------------------------------------------------------------- #
# Ordering — the crux
# --------------------------------------------------------------------------- #
class OrderingTests(_AccountDeletionTestCase):
    def test_post_media_paths_are_captured_before_the_auth_user_cascade(self) -> None:
        """`FakeSupabase` empties `rows` when the auth user is deleted, exactly as
        the ON DELETE CASCADE does. If the listing ran after, it would see none.
        """
        self.wire_gcs_stores()
        media_path = f"{OWNER_ID}/photo.jpg"
        self.post_media.existing.add(media_path)
        supabase = FakeSupabase(rows=[_media_row(media_path)])

        result = self.delete_account(supabase=supabase)

        self.assertEqual(supabase.calls, ["post_media_listing", "auth_delete"])
        self.assertEqual(self.post_media.deleted, [media_path])
        self.assertTrue(result["storage"]["complete"])

    def test_objects_are_deleted_while_their_rows_still_point_at_them(self) -> None:
        """Object first, row second — a crash mid-sweep must stay retryable."""
        self.wire_gcs_stores()
        source, _ = self.insert_scan_artifact(scan_id="scan-order")
        self.artifacts.existing.add(source)

        rows_alive_at_delete: list[int] = []
        self.artifacts.on_delete = lambda _name: rows_alive_at_delete.append(
            self.owner_row_count("scan_artifacts")
        )

        self.delete_account(supabase=FakeSupabase())

        self.assertTrue(rows_alive_at_delete)
        self.assertTrue(
            all(count > 0 for count in rows_alive_at_delete),
            "scan_artifacts rows were deleted before their objects were swept",
        )
        self.assertEqual(self.owner_row_count("scan_artifacts"), 0)


# --------------------------------------------------------------------------- #
# Idempotence
# --------------------------------------------------------------------------- #
class IdempotenceTests(_AccountDeletionTestCase):
    def test_a_missing_object_is_a_no_op_not_an_error(self) -> None:
        """Nothing is seeded into the bucket: every delete hits a 404."""
        self.wire_gcs_stores()
        self.insert_scan_artifact(scan_id="scan-absent")

        result = self.delete_account(supabase=FakeSupabase())

        storage = result["storage"]
        self.assertTrue(result["deleted"])
        self.assertTrue(storage["complete"], storage)
        self.assertEqual(storage["deletedObjects"], 0)
        self.assertEqual(storage["failedObjects"], 0)
        self.assertEqual(storage["alreadyMissingObjects"], storage["consideredObjects"])

    def test_deleting_the_same_account_twice_still_succeeds(self) -> None:
        self.wire_gcs_stores()
        source, _ = self.insert_scan_artifact(scan_id="scan-twice")
        self.artifacts.existing.add(source)

        first = self.delete_account(supabase=FakeSupabase())
        second = self.delete_account(supabase=FakeSupabase())

        # Only the source image was ever stored; the other two derived paths were
        # already absent, which is a no-op rather than a failure.
        self.assertEqual(first["storage"]["deletedObjects"], 1)
        self.assertEqual(first["storage"]["failedObjects"], 0)
        # Second pass: the rows are gone, so only the deterministic avatar paths
        # remain to try, and both are already absent.
        self.assertTrue(second["deleted"])
        self.assertTrue(second["storage"]["complete"], second["storage"])
        self.assertEqual(second["storage"]["failedObjects"], 0)


# --------------------------------------------------------------------------- #
# Unconfigured stores — the features ship dark
# --------------------------------------------------------------------------- #
class UnconfiguredStoreTests(_AccountDeletionTestCase):
    def test_unconfigured_stores_are_skipped_and_reported(self) -> None:
        # The default test environment sets neither bucket env var, so both the
        # avatar and post-media stores are None — the "ships dark" state.
        self.assertIsNone(self.service.avatar_store)
        self.assertIsNone(self.service.post_media_store)

        result = self.delete_account()

        self.assertTrue(result["deleted"])
        storage = result["storage"]
        self.assertFalse(storage["complete"])
        reported = {
            (problem["store"], problem["reason"]) for problem in storage["problems"]
        }
        self.assertIn((AVATAR_STORE_NAME, "store_unconfigured"), reported)
        self.assertIn((POST_MEDIA_STORE_NAME, "store_unconfigured"), reported)

    def test_an_unconfigured_post_media_store_makes_no_supabase_listing_call(
        self,
    ) -> None:
        """No bucket means nothing to delete; do not pay for the read."""
        supabase = FakeSupabase(rows=[_media_row("x/y.jpg")])

        self.delete_account(supabase=supabase)

        self.assertEqual(supabase.calls, ["auth_delete"])

    def test_a_non_uuid_owner_id_is_reported_not_raised(self) -> None:
        """The avatars bucket derives its key from a UUID-shaped id."""
        self.wire_gcs_stores()

        result = self.delete_account(supabase=FakeSupabase(), owner_user_id="user-a")

        self.assertTrue(result["deleted"])
        reasons = {problem["reason"] for problem in result["storage"]["problems"]}
        self.assertIn("paths_unavailable", reasons)
        self.assertEqual(self.avatars.delete_calls, [])


# --------------------------------------------------------------------------- #
# Partial failure — the account still goes
# --------------------------------------------------------------------------- #
class StorageFailureTests(_AccountDeletionTestCase):
    def test_a_storage_failure_still_deletes_the_account_and_is_reported(self) -> None:
        self.wire_gcs_stores()
        source, normalized = self.insert_scan_artifact(scan_id="scan-flaky")
        self.artifacts.existing.update({source, normalized})
        self.artifacts.errors[source] = RuntimeError("permission denied")

        result = self.delete_account(supabase=FakeSupabase())

        # The account is gone. That is the legally important part.
        self.assertTrue(result["deleted"])
        self.assertTrue(result["authUserDeleted"])
        self.assertEqual(self.owner_row_count("scan_artifacts"), 0)

        storage = result["storage"]
        self.assertFalse(storage["complete"])
        self.assertEqual(storage["failedObjects"], 1)
        self.assertIn(
            f"{SCAN_ARTIFACT_STORE_NAME}:{source}", storage["unresolvedObjects"]
        )
        self.assertTrue(
            any("permission denied" in reason for reason in storage["failureReasons"])
        )
        # One bad object does not stop the sweep.
        self.assertIn(normalized, self.artifacts.deleted)

    def test_a_whole_bucket_outage_never_fails_the_request(self) -> None:
        self.wire_gcs_stores()
        self.insert_scan_artifact(scan_id="scan-outage")
        for bucket in (self.avatars, self.post_media, self.artifacts):
            bucket.error = RuntimeError("bucket unavailable")

        result = self.delete_account(supabase=FakeSupabase())

        self.assertTrue(result["deleted"])
        self.assertEqual(self.owner_row_count("scan_artifacts"), 0)
        self.assertGreater(result["storage"]["failedObjects"], 0)
        self.assertFalse(result["storage"]["complete"])

    def test_a_malformed_stored_path_is_refused_and_reported(self) -> None:
        """Defense in depth: a hostile stored path must never address an object."""
        self.wire_gcs_stores()
        self.insert_scan_artifact(scan_id="scan-bad", source_path="../../etc/passwd")

        result = self.delete_account(supabase=FakeSupabase())

        self.assertTrue(result["deleted"])
        # The guard rejects it before any blob is addressed, and rejects the
        # artifacts.json derived from the same poisoned directory too.
        self.assertNotIn("../../etc/passwd", self.artifacts.delete_calls)
        self.assertNotIn("../../artifacts.json", self.artifacts.delete_calls)
        self.assertEqual(result["storage"]["failedObjects"], 2)
        self.assertIn(
            f"{SCAN_ARTIFACT_STORE_NAME}:../../etc/passwd",
            result["storage"]["unresolvedObjects"],
        )
        # The well-formed sibling on the same scan is still swept.
        self.assertIn(
            "scans/2026/08/01/scan-bad/normalized_target.jpg",
            self.artifacts.delete_calls,
        )

    def test_a_failed_post_media_listing_is_reported_as_incomplete(self) -> None:
        """Bytes may survive that nobody can ever find again. Say so."""
        self.wire_gcs_stores()
        supabase = FakeSupabase(
            rows=[_media_row(f"{OWNER_ID}/photo.jpg")],
            listing_error=RuntimeError("postgrest down"),
        )

        result = self.delete_account(supabase=supabase)

        self.assertTrue(result["deleted"])
        storage = result["storage"]
        self.assertFalse(storage["complete"])
        self.assertIn(
            (POST_MEDIA_STORE_NAME, "listing_incomplete"),
            {(problem["store"], problem["reason"]) for problem in storage["problems"]},
        )

    def test_an_unanticipated_sweep_failure_still_deletes_the_account(self) -> None:
        """The outer guard. Nothing storage-shaped may strand a user's account."""
        self.wire_gcs_stores()
        self.insert_scan_artifact(scan_id="scan-boom")

        with patch.object(
            SpotlightScanService,
            "_collect_account_storage_targets",
            side_effect=RuntimeError("something nobody predicted"),
        ):
            result = self.delete_account(supabase=FakeSupabase())

        self.assertTrue(result["deleted"])
        self.assertTrue(result["authUserDeleted"])
        self.assertEqual(self.owner_row_count("scan_artifacts"), 0)
        self.assertEqual(result["storage"]["stoppedReason"], "sweep_aborted")
        self.assertFalse(result["storage"]["complete"])

    def test_the_orphan_list_is_logged_in_full_for_manual_cleanup(self) -> None:
        self.wire_gcs_stores()
        source, _ = self.insert_scan_artifact(scan_id="scan-logged")
        self.artifacts.existing.add(source)
        self.artifacts.errors[source] = RuntimeError("permission denied")

        emitted: list[dict] = []
        with patch.object(
            SpotlightScanService,
            "_emit_structured_log",
            lambda _self, payload: emitted.append(payload),
        ):
            self.delete_account(supabase=FakeSupabase())

        orphan_lines = [
            payload
            for payload in emitted
            if payload.get("event") == "account_deletion_orphaned_objects"
        ]
        self.assertTrue(orphan_lines)
        logged = [obj for line in orphan_lines for obj in line["objects"]]
        self.assertIn(f"{SCAN_ARTIFACT_STORE_NAME}:{source}", logged)
        self.assertTrue(
            any(line["ownerUserID"] == OWNER_ID for line in orphan_lines),
            "an orphan log line must name the owner it belonged to",
        )


# --------------------------------------------------------------------------- #
# Bounds — a heavy scanner user owns thousands of artifacts
# --------------------------------------------------------------------------- #
class BoundedSweepTests(_AccountDeletionTestCase):
    def _targets(self, count: int) -> list[AccountStorageTarget]:
        return [
            AccountStorageTarget(
                store=SCAN_ARTIFACT_STORE_NAME,
                object_path=f"scans/2026/08/01/scan-{index}/normalized_target.jpg",
            )
            for index in range(count)
        ]

    def test_the_object_cap_bounds_one_request(self) -> None:
        self.wire_gcs_stores()
        targets = self._targets(50)
        self.artifacts.existing.update(target.object_path for target in targets)

        report = self.service._delete_account_storage_objects(
            OWNER_ID, targets, max_objects=5
        )

        self.assertEqual(report["deletedObjects"], 5)
        self.assertEqual(report["deferredObjects"], 45)
        self.assertEqual(report["stoppedReason"], "object_cap")
        self.assertEqual(len(self.artifacts.delete_calls), 5)
        self.assertFalse(report["complete"])

    def test_an_exhausted_time_budget_defers_the_rest(self) -> None:
        self.wire_gcs_stores()
        targets = self._targets(10)
        self.artifacts.existing.update(target.object_path for target in targets)

        report = self.service._delete_account_storage_objects(
            OWNER_ID, targets, time_budget_seconds=0.0
        )

        self.assertEqual(report["deletedObjects"], 0)
        self.assertEqual(report["deferredObjects"], 10)
        self.assertEqual(report["stoppedReason"], "time_budget")
        self.assertEqual(self.artifacts.delete_calls, [])

    def test_deferred_objects_are_reported_and_sampled_not_dumped(self) -> None:
        self.wire_gcs_stores()
        targets = self._targets(200)

        report = self.service._delete_account_storage_objects(
            OWNER_ID, targets, max_objects=1
        )

        sample = report["unresolvedObjects"]
        self.assertTrue(report["unresolvedObjectsTruncated"])
        self.assertEqual(
            len(sample), self.service._ACCOUNT_DELETION_UNRESOLVED_SAMPLE
        )
        self.assertTrue(all(item.startswith(f"{SCAN_ARTIFACT_STORE_NAME}:") for item in sample))

    def test_a_capped_sweep_still_deletes_the_account(self) -> None:
        self.wire_gcs_stores()
        for index in range(6):
            self.insert_scan_artifact(scan_id=f"scan-bulk-{index}")

        with patch.object(
            SpotlightScanService, "_ACCOUNT_DELETION_MAX_STORAGE_OBJECTS", 3
        ):
            result = self.delete_account(supabase=FakeSupabase())

        self.assertTrue(result["deleted"])
        self.assertEqual(result["storage"]["stoppedReason"], "object_cap")
        self.assertEqual(self.owner_row_count("scan_artifacts"), 0)


# --------------------------------------------------------------------------- #
# Filesystem scan-artifact store (staging runs on it)
# --------------------------------------------------------------------------- #
class FilesystemStoreTests(_AccountDeletionTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.artifact_root = Path(self.tempdir.name) / "scan-artifacts"
        self.service.artifact_store = FilesystemScanArtifactStore(self.artifact_root)

    def _write(self, relative_path: str) -> Path:
        absolute = self.artifact_root / relative_path
        absolute.parent.mkdir(parents=True, exist_ok=True)
        absolute.write_bytes(b"jpeg")
        return absolute

    def test_files_are_removed_and_empty_scan_directories_are_pruned(self) -> None:
        source, normalized = self.insert_scan_artifact(scan_id="scan-fs")
        source_file = self._write(source)
        normalized_file = self._write(normalized)

        result = self.delete_account(supabase=FakeSupabase())

        self.assertFalse(source_file.exists())
        self.assertFalse(normalized_file.exists())
        # The directory name carries the scan id, so an empty shell would still
        # be an identifiable trace of the deleted account.
        self.assertFalse((self.artifact_root / "scans" / "2026").exists())
        self.assertEqual(result["storage"]["deletedObjects"], 2)

    def test_a_missing_file_is_not_an_error(self) -> None:
        self.insert_scan_artifact(scan_id="scan-fs-missing")

        result = self.delete_account(supabase=FakeSupabase())

        self.assertTrue(result["deleted"])
        self.assertEqual(result["storage"]["deletedObjects"], 0)
        self.assertEqual(result["storage"]["alreadyMissingObjects"], 3)

    def test_a_sibling_directory_is_not_pruned(self) -> None:
        source, _ = self.insert_scan_artifact(scan_id="scan-fs-keep")
        self._write(source)
        keeper = self._write("scans/2026/08/01/other-scan/normalized_target.jpg")

        self.delete_account(supabase=FakeSupabase())

        self.assertTrue(keeper.exists())

    def test_traversal_out_of_the_artifact_root_is_refused(self) -> None:
        store = FilesystemScanArtifactStore(self.artifact_root)
        outside = Path(self.tempdir.name) / "secret.txt"
        outside.write_text("keep me", encoding="utf-8")

        for bad in ("../secret.txt", "/etc/passwd", "", "scans/../../secret.txt"):
            with self.assertRaises(ScanArtifactStoreError):
                store.delete_object(bad)
        self.assertTrue(outside.exists())


# --------------------------------------------------------------------------- #
# Store-level delete contracts
# --------------------------------------------------------------------------- #
class StoreDeleteObjectTests(unittest.TestCase):
    def setUp(self) -> None:
        self.gcs = _FakeGCSClient()

    def test_gcs_scan_artifact_delete_is_idempotent(self) -> None:
        store = GoogleCloudScanArtifactStore("bucket", client=self.gcs)
        bucket = self.gcs.bucket("bucket")
        bucket.existing.add("scans/2026/08/01/s/normalized_target.jpg")

        self.assertTrue(store.delete_object("scans/2026/08/01/s/normalized_target.jpg"))
        self.assertFalse(store.delete_object("scans/2026/08/01/s/normalized_target.jpg"))

    def test_gcs_scan_artifact_delete_propagates_real_errors(self) -> None:
        store = GoogleCloudScanArtifactStore("bucket", client=self.gcs)
        self.gcs.bucket("bucket").error = RuntimeError("permission denied")

        with self.assertRaises(RuntimeError):
            store.delete_object("scans/2026/08/01/s/normalized_target.jpg")

    def test_post_media_delete_uses_the_shared_path_guard(self) -> None:
        store = GoogleCloudPostMediaStore("bucket", client=self.gcs)
        bucket = self.gcs.bucket("bucket")

        for bad in ("../secrets.jpg", "/absolute.jpg", "", "post/../../x.jpg"):
            with self.assertRaises(PostMediaStoreError):
                store.delete_object(bad)
        self.assertEqual(bucket.delete_calls, [])

    def test_post_media_delete_is_idempotent(self) -> None:
        store = GoogleCloudPostMediaStore("bucket", client=self.gcs)
        self.gcs.bucket("bucket").existing.add("post-id/media.jpg")

        self.assertTrue(store.delete_object("post-id/media.jpg"))
        self.assertFalse(store.delete_object("post-id/media.jpg"))

    def test_avatar_delete_is_idempotent(self) -> None:
        store = GoogleCloudAvatarStore("bucket", client=self.gcs)
        avatar_path, cover_path = avatar_owner_object_paths(OWNER_ID)
        self.gcs.bucket("bucket").existing.add(avatar_path)

        self.assertTrue(store.delete_object(avatar_path))
        self.assertFalse(store.delete_object(avatar_path))
        # A user who never set a cover: absent is success, not failure.
        self.assertFalse(store.delete_object(cover_path))

    def test_avatar_owner_paths_cover_both_public_images(self) -> None:
        avatar_path, cover_path = avatar_owner_object_paths(OWNER_ID)
        self.assertEqual(avatar_path, f"avatars/{OWNER_ID}.jpg")
        self.assertEqual(cover_path, f"covers/{OWNER_ID}.jpg")

    def test_avatar_owner_paths_reject_a_non_user_id(self) -> None:
        for bad in ("", "user-a", "../../etc/passwd"):
            with self.assertRaises(AvatarStoreError):
                avatar_owner_object_paths(bad)

    def test_missing_object_detection_is_structural(self) -> None:
        """No google.api_core import: the store modules stay importable without it."""

        class _Status:
            status_code = 404

        self.assertTrue(is_missing_object_error(_NotFound("gone")))
        self.assertTrue(is_missing_object_error(_Status()))
        self.assertFalse(is_missing_object_error(RuntimeError("permission denied")))


if __name__ == "__main__":
    unittest.main()
