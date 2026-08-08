"""Tests for the post-media retention purge.

This is the only job in the system with DELETE authority over users' photos, so
the tests pin the safety properties rather than the happy path:

  - the 30-day boundary, from BOTH sides, through the injected clock
  - dry run (the default) deletes nothing
  - the per-run cap is enforced even when the query over-matches
  - storage object FIRST, post_media row SECOND
  - a storage failure neither aborts the run nor drops the row
  - a row failure after the object is gone is counted, not swallowed
  - class-2 selection (stale 'pending' rows) and its moderation-worker gate
  - --apply with no bucket refuses to run
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import post_media_purge as purge  # noqa: E402
from post_media_store import PostMediaStoreError  # noqa: E402

NOW = datetime(2026, 9, 15, 12, 0, 0, tzinfo=timezone.utc)
POST_ID = "11111111-2222-4333-8444-555555555555"


def _media_row(index: int, *, post_id: str = POST_ID) -> dict[str, object]:
    media_id = f"aaaaaaaa-bbbb-4ccc-8ddd-{index:012d}"
    return {
        "id": media_id,
        "post_id": post_id,
        "storage_path": f"{post_id}/{media_id}.jpg",
        "created_at": "2026-08-01T00:00:00+00:00",
    }


class FakeSource:
    """In-memory stand-in for PostgREST.

    Holds rows with their real `deleted_at` / `created_at` values and applies the
    same cutoffs PostgREST would, so the boundary tests exercise the cutoff this
    module computes rather than a filter the test hard-codes.
    """

    def __init__(
        self,
        *,
        soft_deleted: list[tuple[dict[str, object], datetime]] | None = None,
        pending: list[tuple[dict[str, object], datetime]] | None = None,
        worker_live: bool = True,
    ) -> None:
        self.soft_deleted = soft_deleted or []
        self.pending = pending or []
        self.worker_live = worker_live
        self.deleted_rows: list[tuple[str, str]] = []
        self.liveness_since: datetime | None = None
        self.row_delete_error: Exception | None = None
        self.calls: list[str] = []

    def fetch_media_for_soft_deleted_posts(self, *, deleted_before, limit):
        self.calls.append("fetch_soft_deleted")
        matched = [row for row, deleted_at in self.soft_deleted if deleted_at < deleted_before]
        return matched[:limit]

    def fetch_abandoned_pending_media(self, *, created_before, limit):
        self.calls.append("fetch_pending")
        matched = [row for row, created_at in self.pending if created_at < created_before]
        return matched[:limit]

    def moderation_worker_is_live(self, *, since):
        self.liveness_since = since
        return self.worker_live

    def delete_media_row(self, *, media_id, storage_path):
        self.calls.append(f"delete_row:{media_id}")
        if self.row_delete_error is not None:
            raise self.row_delete_error
        self.deleted_rows.append((media_id, storage_path))


class FakeStore:
    """Records object deletes, sharing a call log with the source for ordering."""

    def __init__(self, *, calls: list[str], error: Exception | None = None) -> None:
        self.calls = calls
        self.error = error
        self.deleted_paths: list[str] = []
        self.missing_paths: set[str] = set()

    def delete_object(self, storage_path: str) -> bool:
        self.calls.append(f"delete_object:{storage_path}")
        if self.error is not None:
            raise self.error
        self.deleted_paths.append(storage_path)
        return storage_path not in self.missing_paths


def _wire(source: FakeSource, *, error: Exception | None = None) -> FakeStore:
    """Give the store the source's call log so ordering is observable."""
    return FakeStore(calls=source.calls, error=error)


def _run(source: FakeSource, store, **kwargs):
    params = {
        "source": source,
        "store": store,
        "now": NOW,
        "dry_run": False,
        "include_abandoned": False,
    }
    params.update(kwargs)
    return purge.purge_post_media(**params)


# --------------------------------------------------------------------------- #
# The 30-day boundary (class 1)
# --------------------------------------------------------------------------- #
class RetentionBoundaryTests(unittest.TestCase):
    def test_media_deleted_more_than_30_days_ago_is_purged(self):
        row = _media_row(1)
        source = FakeSource(
            soft_deleted=[(row, NOW - timedelta(days=30, seconds=1))]
        )
        store = _wire(source)

        summary = _run(source, store)

        self.assertEqual(summary.purged, 1)
        self.assertEqual(store.deleted_paths, [row["storage_path"]])
        self.assertEqual(source.deleted_rows, [(row["id"], row["storage_path"])])

    def test_media_deleted_just_under_30_days_ago_is_retained(self):
        """The other side of the boundary: still inside the moderation window."""
        row = _media_row(2)
        source = FakeSource(
            soft_deleted=[(row, NOW - timedelta(days=29, hours=23, minutes=59))]
        )
        store = _wire(source)

        summary = _run(source, store)

        self.assertEqual(summary.considered, 0)
        self.assertEqual(summary.purged, 0)
        self.assertEqual(store.deleted_paths, [])
        self.assertEqual(source.deleted_rows, [])

    def test_boundary_moves_with_the_injected_clock(self):
        """Same row, same data — only `now` differs."""
        row = _media_row(3)
        deleted_at = NOW - timedelta(days=29)
        rows = [(row, deleted_at)]

        early_source = FakeSource(soft_deleted=rows)
        self.assertEqual(_run(early_source, _wire(early_source)).purged, 0)

        later_source = FakeSource(soft_deleted=rows)
        summary = _run(
            later_source, _wire(later_source), now=NOW + timedelta(days=2)
        )
        self.assertEqual(summary.purged, 1)

    def test_exactly_30_days_is_not_yet_expired(self):
        row = _media_row(4)
        source = FakeSource(soft_deleted=[(row, NOW - timedelta(days=30))])
        summary = _run(source, _wire(source))
        self.assertEqual(summary.purged, 0)

    def test_retention_days_must_be_positive(self):
        source = FakeSource()
        with self.assertRaises(ValueError):
            _run(source, _wire(source), retention_days=0)


# --------------------------------------------------------------------------- #
# Dry run — the default
# --------------------------------------------------------------------------- #
class DryRunTests(unittest.TestCase):
    def test_dry_run_is_the_default(self):
        row = _media_row(5)
        source = FakeSource(soft_deleted=[(row, NOW - timedelta(days=90))])
        store = _wire(source)

        summary = purge.purge_post_media(
            source=source, store=store, now=NOW, include_abandoned=False
        )

        self.assertTrue(summary.dry_run)
        self.assertEqual(summary.considered, 1)
        self.assertEqual(summary.purged, 0)
        self.assertEqual(store.deleted_paths, [])
        self.assertEqual(source.deleted_rows, [])

    def test_dry_run_logs_what_it_would_delete(self):
        row = _media_row(6)
        source = FakeSource(soft_deleted=[(row, NOW - timedelta(days=90))])

        with self.assertLogs("post_media_purge", level="INFO") as captured:
            purge.purge_post_media(
                source=source, store=_wire(source), now=NOW, include_abandoned=False
            )

        joined = "\n".join(captured.output)
        self.assertIn("would_purge", joined)
        self.assertIn(str(row["storage_path"]), joined)
        self.assertIn(POST_ID, joined)

    def test_dry_run_works_without_a_configured_bucket(self):
        row = _media_row(7)
        source = FakeSource(soft_deleted=[(row, NOW - timedelta(days=90))])

        summary = purge.purge_post_media(
            source=source, store=None, now=NOW, include_abandoned=False
        )

        self.assertEqual(summary.considered, 1)
        self.assertEqual(summary.purged, 0)

    def test_apply_without_a_store_refuses_to_run(self):
        """Reaping rows we cannot pair with an object delete strands the files."""
        source = FakeSource(soft_deleted=[(_media_row(8), NOW - timedelta(days=90))])
        with self.assertRaises(ValueError):
            purge.purge_post_media(
                source=source, store=None, now=NOW, dry_run=False
            )
        self.assertEqual(source.deleted_rows, [])


# --------------------------------------------------------------------------- #
# The cap
# --------------------------------------------------------------------------- #
class CapTests(unittest.TestCase):
    def test_cap_limits_what_is_purged_even_if_the_query_over_matches(self):
        """Simulates the failure this cap exists for: a query matching everything."""
        rows = [_media_row(i) for i in range(50)]
        source = FakeSource(
            soft_deleted=[(row, NOW - timedelta(days=90)) for row in rows]
        )
        # Ignore the limit the job passes, the way a buggy filter effectively would.
        source.fetch_media_for_soft_deleted_posts = (  # type: ignore[method-assign]
            lambda *, deleted_before, limit: rows
        )
        store = _wire(source)

        summary = _run(source, store, max_objects=5)

        self.assertEqual(summary.considered, 5)
        self.assertEqual(summary.purged, 5)
        self.assertTrue(summary.capped)
        self.assertEqual(len(store.deleted_paths), 5)
        self.assertEqual(len(source.deleted_rows), 5)

    def test_cap_is_shared_across_both_classes(self):
        soft_rows = [_media_row(i) for i in range(3)]
        pending_rows = [_media_row(100 + i) for i in range(5)]
        source = FakeSource(
            soft_deleted=[(row, NOW - timedelta(days=90)) for row in soft_rows],
            pending=[(row, NOW - timedelta(days=90)) for row in pending_rows],
        )
        store = _wire(source)

        summary = _run(source, store, max_objects=4, include_abandoned=True)

        self.assertEqual(summary.purged, 4)
        self.assertEqual(len(store.deleted_paths), 4)

    def test_cap_must_be_at_least_one(self):
        source = FakeSource()
        with self.assertRaises(ValueError):
            _run(source, _wire(source), max_objects=0)


# --------------------------------------------------------------------------- #
# Ordering and failure isolation
# --------------------------------------------------------------------------- #
class OrderingAndFailureTests(unittest.TestCase):
    def test_object_is_deleted_before_the_row(self):
        row = _media_row(9)
        source = FakeSource(soft_deleted=[(row, NOW - timedelta(days=90))])
        store = _wire(source)

        _run(source, store)

        ordered = [call for call in source.calls if call.startswith(("delete_object", "delete_row"))]
        self.assertEqual(
            ordered,
            [f"delete_object:{row['storage_path']}", f"delete_row:{row['id']}"],
        )

    def test_storage_failure_keeps_the_row_and_does_not_abort_the_run(self):
        bad = _media_row(10)
        good = _media_row(11)
        source = FakeSource(
            soft_deleted=[
                (bad, NOW - timedelta(days=90)),
                (good, NOW - timedelta(days=90)),
            ]
        )

        class FlakyStore(FakeStore):
            def delete_object(self, storage_path: str) -> bool:
                if storage_path == bad["storage_path"]:
                    self.calls.append(f"delete_object:{storage_path}")
                    raise RuntimeError("bucket unavailable")
                return super().delete_object(storage_path)

        store = FlakyStore(calls=source.calls)

        with self.assertLogs("post_media_purge", level="INFO"):
            summary = _run(source, store)

        # The failing row survives for the next run; the healthy one still purges.
        self.assertEqual(summary.failed, 1)
        self.assertEqual(summary.purged, 1)
        self.assertNotIn(bad["id"], [media_id for media_id, _ in source.deleted_rows])
        self.assertEqual(source.deleted_rows, [(good["id"], good["storage_path"])])

    def test_unusable_storage_path_is_counted_and_the_row_is_left_alone(self):
        row = _media_row(12)
        source = FakeSource(soft_deleted=[(row, NOW - timedelta(days=90))])
        store = _wire(source, error=PostMediaStoreError("bad path"))

        with self.assertLogs("post_media_purge", level="INFO"):
            summary = _run(source, store)

        self.assertEqual(summary.failed, 1)
        self.assertEqual(summary.purged, 0)
        self.assertEqual(source.deleted_rows, [])

    def test_row_delete_failure_after_the_object_is_gone_is_reported(self):
        """The intended degradation: broken image now, retried next run."""
        row = _media_row(13)
        source = FakeSource(soft_deleted=[(row, NOW - timedelta(days=90))])
        source.row_delete_error = RuntimeError("postgrest down")
        store = _wire(source)

        with self.assertLogs("post_media_purge", level="INFO") as captured:
            summary = _run(source, store)

        self.assertEqual(summary.purged, 0)
        self.assertEqual(summary.failed, 1)
        self.assertEqual(store.deleted_paths, [row["storage_path"]])
        self.assertIn("purge_failed", "\n".join(captured.output))

    def test_missing_object_still_reaps_the_row(self):
        """A rolled-back upload leaves a row whose object never existed."""
        row = _media_row(14)
        source = FakeSource(soft_deleted=[(row, NOW - timedelta(days=90))])
        store = _wire(source)
        store.missing_paths.add(str(row["storage_path"]))

        summary = _run(source, store)

        self.assertEqual(summary.purged, 1)
        self.assertEqual(summary.objects_already_missing, 1)
        self.assertEqual(source.deleted_rows, [(row["id"], row["storage_path"])])

    def test_rows_without_a_storage_path_are_skipped(self):
        row = _media_row(15)
        row["storage_path"] = ""
        source = FakeSource(soft_deleted=[(row, NOW - timedelta(days=90))])
        store = _wire(source)

        with self.assertLogs("post_media_purge", level="INFO"):
            summary = _run(source, store)

        self.assertEqual(summary.considered, 0)
        self.assertEqual(source.deleted_rows, [])


# --------------------------------------------------------------------------- #
# Class 2 — abandoned uploads
# --------------------------------------------------------------------------- #
class AbandonedUploadTests(unittest.TestCase):
    def test_stale_pending_rows_are_purged(self):
        row = _media_row(16)
        source = FakeSource(pending=[(row, NOW - timedelta(days=15))])
        store = _wire(source)

        summary = _run(source, store, include_abandoned=True)

        self.assertEqual(summary.purged, 1)
        self.assertEqual(source.deleted_rows, [(row["id"], row["storage_path"])])

    def test_recent_pending_rows_are_left_alone(self):
        """A composer could still be mid-flight; the worker has minutes, not days."""
        row = _media_row(17)
        source = FakeSource(pending=[(row, NOW - timedelta(days=13))])
        store = _wire(source)

        summary = _run(source, store, include_abandoned=True)

        self.assertEqual(summary.considered, 0)
        self.assertEqual(source.deleted_rows, [])

    def test_class_two_is_skipped_when_the_moderation_worker_is_not_proven_live(self):
        """A stalled worker makes every live upload look abandoned."""
        row = _media_row(18)
        source = FakeSource(pending=[(row, NOW - timedelta(days=90))], worker_live=False)
        store = _wire(source)

        summary = _run(source, store, include_abandoned=True)

        self.assertEqual(summary.considered, 0)
        self.assertEqual(source.deleted_rows, [])
        self.assertEqual(
            summary.abandoned_skipped_reason, "moderation_worker_not_proven_live"
        )
        self.assertNotIn("fetch_pending", source.calls)

    def test_liveness_window_uses_the_injected_clock(self):
        source = FakeSource(pending=[(_media_row(19), NOW - timedelta(days=90))])
        _run(source, _wire(source), include_abandoned=True, worker_liveness_hours=12)
        self.assertEqual(source.liveness_since, NOW - timedelta(hours=12))

    def test_no_abandoned_flag_skips_the_class_entirely(self):
        row = _media_row(20)
        source = FakeSource(pending=[(row, NOW - timedelta(days=90))])
        store = _wire(source)

        summary = _run(source, store, include_abandoned=False)

        self.assertEqual(summary.considered, 0)
        self.assertEqual(summary.abandoned_skipped_reason, "disabled_by_flag")
        self.assertNotIn("fetch_pending", source.calls)

    def test_a_row_in_both_classes_is_purged_once(self):
        row = _media_row(21)
        source = FakeSource(
            soft_deleted=[(row, NOW - timedelta(days=90))],
            pending=[(row, NOW - timedelta(days=90))],
        )
        store = _wire(source)

        summary = _run(source, store, include_abandoned=True)

        self.assertEqual(summary.purged, 1)
        self.assertEqual(len(store.deleted_paths), 1)
        self.assertEqual(len(source.deleted_rows), 1)


# --------------------------------------------------------------------------- #
# Query construction — the filters are the delete decision
# --------------------------------------------------------------------------- #
class SupabaseQueryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = purge.SupabasePurgeSource(
            supabase_url="https://example.supabase.co/",
            service_role_key="service-role-key",
        )
        self.queries: list[tuple[str, str]] = []

        def fake_get(table: str, query: str):
            self.queries.append((table, query))
            return []

        self.source._get = fake_get  # type: ignore[method-assign]

    def test_soft_deleted_query_keys_off_deleted_at_only(self):
        self.source.fetch_media_for_soft_deleted_posts(deleted_before=NOW, limit=10)
        table, query = self.queries[0]
        self.assertEqual(table, "post_media")
        self.assertIn("posts%21inner", query)  # posts!inner -> real inner join
        self.assertIn("posts.deleted_at=lt.", query)
        # content_status is overwritten by the moderation worker; it must never
        # participate in a delete decision.
        self.assertNotIn("content_status", query)

    def test_pending_query_matches_the_partial_index_predicate(self):
        self.source.fetch_abandoned_pending_media(created_before=NOW, limit=10)
        _, query = self.queries[0]
        self.assertIn("moderation_status=eq.pending", query)
        self.assertIn("created_at=lt.", query)

    def test_liveness_query_asks_for_a_resolved_recent_row(self):
        self.source.moderation_worker_is_live(since=NOW)
        _, query = self.queries[0]
        self.assertIn("moderation_status=neq.pending", query)
        self.assertIn("created_at=gte.", query)

    def test_missing_config_is_rejected(self):
        with self.assertRaises(ValueError):
            purge.SupabasePurgeSource(supabase_url="", service_role_key="key")


# --------------------------------------------------------------------------- #
# Object store adapter
# --------------------------------------------------------------------------- #
class _FakeBlob:
    def __init__(self, name: str, *, error: Exception | None = None) -> None:
        self.name = name
        self.error = error
        self.deleted = False

    def delete(self) -> None:
        if self.error is not None:
            raise self.error
        self.deleted = True


class _FakeBucket:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.blobs: dict[str, _FakeBlob] = {}

    def blob(self, name: str) -> _FakeBlob:
        return self.blobs.setdefault(name, _FakeBlob(name, error=self.error))


class _FakeMediaStore:
    def __init__(self, bucket: _FakeBucket) -> None:
        self.bucket = bucket


class _NotFound(Exception):
    """Shaped like google.api_core.exceptions.NotFound."""

    code = 404


class ObjectStoreTests(unittest.TestCase):
    def test_delete_reports_true_when_the_object_existed(self):
        bucket = _FakeBucket()
        store = purge.GcsPostMediaObjectStore(_FakeMediaStore(bucket))

        self.assertTrue(store.delete_object(f"{POST_ID}/media.jpg"))
        self.assertTrue(bucket.blobs[f"{POST_ID}/media.jpg"].deleted)

    def test_already_missing_object_is_not_an_error(self):
        bucket = _FakeBucket(error=_NotFound("gone"))
        store = purge.GcsPostMediaObjectStore(_FakeMediaStore(bucket))

        self.assertFalse(store.delete_object(f"{POST_ID}/media.jpg"))

    def test_other_storage_errors_propagate(self):
        bucket = _FakeBucket(error=RuntimeError("permission denied"))
        store = purge.GcsPostMediaObjectStore(_FakeMediaStore(bucket))

        with self.assertRaises(RuntimeError):
            store.delete_object(f"{POST_ID}/media.jpg")

    def test_traversal_paths_are_refused_by_the_shared_guard(self):
        bucket = _FakeBucket()
        store = purge.GcsPostMediaObjectStore(_FakeMediaStore(bucket))

        for bad in ("../secrets.jpg", "/absolute.jpg", "", f"{POST_ID}/../../x.jpg"):
            with self.assertRaises(PostMediaStoreError):
                store.delete_object(bad)
        self.assertEqual(bucket.blobs, {})


if __name__ == "__main__":
    unittest.main()
