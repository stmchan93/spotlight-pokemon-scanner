#!/usr/bin/env python3
"""Scheduled retention purge for post-media images.

This module IS the spec — the planning doc it came from was folded in here and
deleted, so the reasoning lives next to the code that depends on it.

WHY THIS EXISTS
  Deleting a post is a SOFT delete (social_17): `posts.deleted_at` is set and the
  row stays, so a user cannot erase evidence behind an open report and the image
  stays FINDABLE. Soft delete does not free the bytes — it keeps them deletable.
  This is the job that actually frees them.

  `post_media.storage_path` is the only pointer to an object in the private
  post-media bucket. Rows are noise (~250 B); the images are the entire storage
  cost (200-400 KB each), so this job is really about the bucket.

RETENTION: 30 DAYS AFTER `posts.deleted_at`
  That number is a MODERATION window, not a storage decision. Purge sooner and
  the hole soft delete was chosen to close reopens: post something bad, delete
  it, and the image is gone before a human can look at it.

WHAT IT PURGES
  Class 1 — media of soft-deleted posts: `posts.deleted_at < now - 30d`.
    The main case. Well-defined, findable, safe.

  Class 2 — abandoned uploads: `post_media` rows still `moderation_status =
    'pending'` long after `created_at` (default 14 days), found through the
    existing `idx_post_media_pending on (created_at) where moderation_status =
    'pending'` index. See "WHAT AN ABANDONED ROW ACTUALLY LOOKS LIKE" below —
    this is NOT the shape the plan doc assumed, and the difference matters.

  Class 3 — files orphaned by past HARD deletes (anything deleted before the
    2026-08-08 soft-delete switch) — DELIBERATELY NOT IMPLEMENTED HERE. Nothing
    in the database points at those objects, so reclaiming them needs a full
    bucket listing diffed against every `post_media.storage_path`. That is a
    fundamentally riskier operation (its blast radius is "every object the diff
    got wrong" rather than "rows a query selected"), it is one-time rather than
    scheduled, and it must be eyeballed in dry-run before it is ever run for
    real. FUTURE WORK, as a separate reconciliation script, once this routine
    job has been running uneventfully for a while.

WHAT AN ABANDONED ROW ACTUALLY LOOKS LIKE (investigated, not assumed)
  The plan doc describes class 2 as rows "never bound to a published post". That
  shape CANNOT occur in the shipped composer:

    * `post_media.post_id` is `not null references public.posts(id)` (social_01),
      so every media row is bound to a real post row by construction.
    * new-post-screen.tsx creates the `posts` row FIRST (`createPost`, which
      inserts a `content_status='visible'` row), and only then uploads bytes to
      `POST /api/v1/post-media?postId=...`. By the time a media row can exist,
      the post is already published. Abandoning the composer before submitting
      uploads nothing at all.

  What DOES strand a row is the moderation lane:

    * server.py inserts the `post_media` row and then writes the bytes; on a
      storage failure it rolls the row back BEST-EFFORT. If that rollback DELETE
      fails, the row survives pointing at bytes that were never written.
    * social_moderation_worker.py resolves every `pending` row to 'approved' or
      'rejected' within minutes, EXCEPT when it cannot read the object — then it
      logs and `continue`s, leaving the row 'pending' forever on purpose.

  Both leave a row that RLS hides from every viewer permanently (post_media_select
  requires `moderation_status = 'approved'`), so its bytes can never be shown to
  anyone again. That is the garbage, and `pending` + age is exactly how it is
  identified.

  CONSEQUENCE — THE LIVENESS GATE: "still pending" only means "abandoned" while
  the moderation worker is actually running. run_social_moderation_vm.sh exits 0
  when OPENAI_API_KEY is absent, so a silently disabled worker leaves every
  recent upload pending — and purging those would delete LIVE users' photos off
  LIVE posts. So class 2 first proves the worker resolved something recently and
  SKIPS ITSELF when it cannot (see `moderation_worker_is_live`). Class 1 needs no
  such gate: it keys off `deleted_at`, which nothing but the user's own delete
  writes.

ORDER OF OPERATIONS (this order, deliberately)
  1. select candidate rows  2. delete the storage object  3. delete the row.
  Object first, row second. A failure between them leaves the row pointing at a
  missing object: the next run retries and the app degrades to a broken image.
  REVERSE the order and a failure strands the file forever with nothing pointing
  at it — precisely the garbage this job exists to prevent.

NEVER KEY OFF `content_status`
  The moderation worker overwrites it ('deleted' -> 'removed'), so it is advisory
  only. Every decision here keys off `deleted_at` / `moderation_status`, the same
  rule the in-DB counter triggers follow (social_17).

SAFETY POSTURE
  - DRY RUN IS THE DEFAULT. With no flags this deletes nothing and logs exactly
    what it would delete. Deleting requires `--apply`.
  - A HARD CAP per run (`--limit`, default 500). A query bug that matches
    everything deletes at most N objects, not the bucket.
  - NO ROW IS EVER DELETED WITHOUT ITS OBJECT. If the bucket is unconfigured,
    `--apply` refuses to run rather than reaping rows and stranding files.
  - INJECTABLE CLOCK. The 30-day boundary is the whole logic; `purge_post_media`
    takes `now` as a parameter so it is testable.
  - Every purge is logged as one structured line with post id and storage path,
    so "where did my image go" stays answerable.
  - A single failure never aborts the run: it is logged, counted, and the next
    candidate proceeds.

USAGE
    python3 backend/post_media_purge.py                 # dry run, deletes nothing
    python3 backend/post_media_purge.py --apply         # actually deletes
    python3 backend/post_media_purge.py --apply --limit 50

  Env required:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
    SPOTLIGHT_POST_MEDIA_GCS_BUCKET + Google application default credentials with
    delete access to that bucket (required for --apply; optional for a dry run).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlencode

import requests

# Executed as a script (`python3 backend/post_media_purge.py`) but also imported
# by the tests, so make the backend package root importable either way before
# reaching for its siblings. Mirrors social_moderation_worker.py.
BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from post_media_store import (  # noqa: E402
    POST_MEDIA_GCS_BUCKET_ENV,
    PostMediaStoreError,
    build_post_media_store,
)

# The traversal guard is imported rather than re-implemented ON PURPOSE. This is
# the only job in the system with DELETE authority over users' photos; a second,
# subtly different copy of "is this object key safe" is exactly the divergence
# that turns a malformed storage_path into a delete outside the intended key
# space. One guard, shared with the read/write paths in post_media_store.
from post_media_store import _sanitize_object_path as _sanitize_storage_path  # noqa: E402

log = logging.getLogger("post_media_purge")

# --------------------------------------------------------------------------- #
# Defaults
# --------------------------------------------------------------------------- #
# Moderation window, not a storage decision. See the module docstring.
DEFAULT_RETENTION_DAYS = 30

# Class 2 age threshold. Deliberately generous: the moderation worker resolves a
# healthy pending row within minutes (cron runs it every 2 min), so anything
# still pending after two WEEKS is stranded, not in-flight. The cost of waiting
# longer is a few hundred KB; the cost of being wrong is a user's photo.
DEFAULT_ABANDONED_UPLOAD_DAYS = 14

# Hard cap on objects touched per run. The point is blast-radius containment, not
# throughput: a daily job at this cap drains far faster than real users create
# deletions, and a run that hits the cap simply continues tomorrow.
DEFAULT_MAX_OBJECTS = 500

# How recently the moderation worker must have resolved a post_media row for
# class 2 to be trusted at all. See "THE LIVENESS GATE" in the module docstring.
DEFAULT_WORKER_LIVENESS_HOURS = 48

HTTP_TIMEOUT = 30

REASON_SOFT_DELETED_POST = "soft_deleted_post"
REASON_ABANDONED_UPLOAD = "abandoned_upload"


# --------------------------------------------------------------------------- #
# Structured logging
# --------------------------------------------------------------------------- #
def _log_event(event: str, **fields: Any) -> None:
    """Emit one machine-greppable line per decision.

    Every purge lands here with its media id, post id and storage path so that a
    later "where did my image go?" is answerable from the VM log alone.
    """
    payload = {"event": event}
    payload.update({key: value for key, value in fields.items() if value is not None})
    log.info("post_media_purge %s", json.dumps(payload, sort_keys=True, default=str))


def _iso(moment: datetime) -> str:
    """Render a UTC ISO-8601 timestamp for a PostgREST filter."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat()


# --------------------------------------------------------------------------- #
# Types
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PurgeCandidate:
    """One `post_media` row selected for purging, with why it was selected."""

    media_id: str
    post_id: str
    storage_path: str
    reason: str


@dataclass
class PurgeSummary:
    """What a run did, for the closing log line and for the tests."""

    dry_run: bool
    considered: int = 0
    purged: int = 0
    failed: int = 0
    objects_already_missing: int = 0
    capped: bool = False
    abandoned_skipped_reason: str | None = None
    purged_paths: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "dryRun": self.dry_run,
            "considered": self.considered,
            "purged": self.purged,
            "failed": self.failed,
            "objectsAlreadyMissing": self.objects_already_missing,
            "capped": self.capped,
            "abandonedSkippedReason": self.abandoned_skipped_reason,
        }


class PurgeDataSource(Protocol):
    """The Supabase reads/writes this job needs. Faked wholesale in tests."""

    def fetch_media_for_soft_deleted_posts(
        self, *, deleted_before: datetime, limit: int
    ) -> list[dict[str, Any]]:
        ...

    def fetch_abandoned_pending_media(
        self, *, created_before: datetime, limit: int
    ) -> list[dict[str, Any]]:
        ...

    def moderation_worker_is_live(self, *, since: datetime) -> bool:
        ...

    def delete_media_row(self, *, media_id: str, storage_path: str) -> None:
        ...


class PurgeObjectStore(Protocol):
    def delete_object(self, storage_path: str) -> bool:
        """Delete the object. Return False when it was already absent."""
        ...


# --------------------------------------------------------------------------- #
# Supabase (PostgREST, service-role key)
# --------------------------------------------------------------------------- #
class SupabasePurgeSource:
    """PostgREST reads/writes with the service-role key.

    Same transport and error posture as social_moderation_worker.py: plain
    `requests`, `raise_for_status`, and let failures propagate to the caller,
    which decides whether to skip a row or abort.
    """

    def __init__(self, *, supabase_url: str, service_role_key: str) -> None:
        self.supabase_url = str(supabase_url or "").rstrip("/")
        self.service_role_key = str(service_role_key or "")
        if not self.supabase_url or not self.service_role_key:
            raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")

    def _headers(self) -> dict[str, str]:
        return {
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {self.service_role_key}",
            "Content-Type": "application/json",
        }

    def _get(self, table: str, query: str) -> list[dict[str, Any]]:
        response = requests.get(
            f"{self.supabase_url}/rest/v1/{table}?{query}",
            headers=self._headers(),
            timeout=HTTP_TIMEOUT,
        )
        response.raise_for_status()
        rows = response.json()
        return rows if isinstance(rows, list) else []

    def fetch_media_for_soft_deleted_posts(
        self, *, deleted_before: datetime, limit: int
    ) -> list[dict[str, Any]]:
        """Class 1: media whose parent post was soft-deleted before the cutoff.

        `posts!inner(...)` makes the embed an INNER JOIN so the `posts.deleted_at`
        filter restricts the `post_media` rows themselves rather than merely
        nulling out the embed. The filter is on `deleted_at` and NOTHING else —
        `content_status` is overwritten by the moderation worker and must never
        be part of a delete decision.
        """
        query = urlencode(
            {
                "select": "id,post_id,storage_path,created_at,posts!inner(deleted_at)",
                "posts.deleted_at": f"lt.{_iso(deleted_before)}",
                "order": "created_at.asc",
                "limit": str(limit),
            }
        )
        return self._get("post_media", query)

    def fetch_abandoned_pending_media(
        self, *, created_before: datetime, limit: int
    ) -> list[dict[str, Any]]:
        """Class 2: rows the moderation worker never resolved.

        Served by `idx_post_media_pending on (created_at) where moderation_status
        = 'pending'` — the partial index this predicate was written against.
        """
        query = urlencode(
            {
                "select": "id,post_id,storage_path,created_at",
                "moderation_status": "eq.pending",
                "created_at": f"lt.{_iso(created_before)}",
                "order": "created_at.asc",
                "limit": str(limit),
            }
        )
        return self._get("post_media", query)

    def moderation_worker_is_live(self, *, since: datetime) -> bool:
        """True when the image moderation pass resolved a row after `since`.

        `moderation_status` only ever leaves 'pending' because the worker wrote
        it (the upload endpoint omits the column so it defaults to 'pending'), so
        a recently-created row that is no longer pending is direct evidence the
        worker ran. No evidence -> class 2 refuses to purge anything.
        """
        query = urlencode(
            {
                "select": "id",
                "moderation_status": "neq.pending",
                "created_at": f"gte.{_iso(since)}",
                "limit": "1",
            }
        )
        return bool(self._get("post_media", query))

    def delete_media_row(self, *, media_id: str, storage_path: str) -> None:
        """Delete the row, scoped to the exact `storage_path` we just purged.

        Scoping on both columns means that if the row changed underneath us
        between select and delete, the delete matches nothing instead of reaping
        a row whose object is still live.
        """
        query = urlencode({"id": f"eq.{media_id}", "storage_path": f"eq.{storage_path}"})
        response = requests.delete(
            f"{self.supabase_url}/rest/v1/post_media?{query}",
            headers={**self._headers(), "Prefer": "return=minimal"},
            timeout=HTTP_TIMEOUT,
        )
        response.raise_for_status()


# --------------------------------------------------------------------------- #
# Object store (the PRIVATE post-media bucket, via post_media_store)
# --------------------------------------------------------------------------- #
def _is_object_missing(error: Exception) -> bool:
    """True when a delete failed only because the object was already gone.

    Checked structurally rather than by importing google.api_core, which is not a
    declared dependency of this module and would make the whole file unimportable
    in a test environment without it.
    """
    for attribute in ("code", "status_code"):
        if getattr(error, attribute, None) == 404:
            return True
    return type(error).__name__ == "NotFound"


class GcsPostMediaObjectStore:
    """Deletes objects from the private post-media bucket.

    `post_media_store` owns bucket access, so the bucket handle comes from a
    store built by `build_post_media_store` rather than from a GCS client
    constructed here. It exposes read/write but no delete (the serving and upload
    paths never needed one), so the delete is issued against the store's bucket —
    through the store's OWN path guard, imported above.
    """

    def __init__(self, media_store: Any) -> None:
        self._media_store = media_store

    def delete_object(self, storage_path: str) -> bool:
        object_path = _sanitize_storage_path(storage_path)
        blob = self._media_store.bucket.blob(object_path)
        try:
            blob.delete()
        except Exception as error:  # noqa: BLE001 - re-raised unless it's a 404
            if _is_object_missing(error):
                # Already gone (rolled-back upload, or a previous run that died
                # between the object delete and the row delete). The purge
                # SUCCEEDED for our purposes; let the row be reaped.
                return False
            raise
        return True


def build_object_store_from_env() -> PurgeObjectStore | None:
    """Build the bucket-backed deleter, or None when it is unavailable.

    Returning None is not fatal for a dry run (which touches nothing), but
    `--apply` refuses to proceed without it: deleting rows while unable to delete
    objects strands the files forever, which is the exact garbage this job exists
    to prevent.
    """
    bucket = str(os.environ.get(POST_MEDIA_GCS_BUCKET_ENV) or "").strip()
    if not bucket:
        log.warning(
            "%s is unset — no objects can be purged.", POST_MEDIA_GCS_BUCKET_ENV
        )
        return None
    try:
        media_store = build_post_media_store(gcs_bucket=bucket)
    except Exception:  # noqa: BLE001 - missing client / credentials
        log.exception("could not build the post media store for bucket %s", bucket)
        return None
    if media_store is None:
        return None
    return GcsPostMediaObjectStore(media_store)


# --------------------------------------------------------------------------- #
# Candidate selection
# --------------------------------------------------------------------------- #
def _to_candidate(row: dict[str, Any], reason: str) -> PurgeCandidate | None:
    media_id = str(row.get("id") or "").strip()
    post_id = str(row.get("post_id") or "").strip()
    storage_path = str(row.get("storage_path") or "").strip()
    if not media_id or not storage_path:
        # A row with no object key cannot be purged by this job; it has no bytes
        # to reclaim, and deleting it is a database-hygiene question rather than
        # a storage one. Leave it and say so.
        _log_event(
            "skipped_unusable_row",
            mediaId=media_id or None,
            postId=post_id or None,
            reason=reason,
            detail="missing id or storage_path",
        )
        return None
    return PurgeCandidate(
        media_id=media_id,
        post_id=post_id,
        storage_path=storage_path,
        reason=reason,
    )


def select_candidates(
    *,
    source: PurgeDataSource,
    now: datetime,
    max_objects: int,
    retention_days: int,
    abandoned_upload_days: int,
    include_abandoned: bool,
    worker_liveness_hours: int,
    summary: PurgeSummary,
) -> list[PurgeCandidate]:
    """Gather class-1 then class-2 rows, deduped and capped at `max_objects`."""
    candidates: list[PurgeCandidate] = []
    seen: set[str] = set()

    def _absorb(rows: list[dict[str, Any]], reason: str) -> None:
        for row in rows:
            candidate = _to_candidate(row, reason)
            if candidate is None or candidate.media_id in seen:
                continue
            seen.add(candidate.media_id)
            candidates.append(candidate)

    deleted_before = now - timedelta(days=retention_days)
    _log_event(
        "selecting",
        klass=REASON_SOFT_DELETED_POST,
        deletedBefore=_iso(deleted_before),
        limit=max_objects,
    )
    _absorb(
        source.fetch_media_for_soft_deleted_posts(
            deleted_before=deleted_before, limit=max_objects
        ),
        REASON_SOFT_DELETED_POST,
    )

    remaining = max_objects - len(candidates)
    if not include_abandoned:
        summary.abandoned_skipped_reason = "disabled_by_flag"
    elif remaining <= 0:
        summary.abandoned_skipped_reason = "cap_reached_by_soft_deleted_posts"
    else:
        # A "pending" row is only abandoned if the worker that resolves pending
        # rows is actually running. If it is not, every recent upload looks
        # abandoned and purging would delete live photos off live posts.
        liveness_since = now - timedelta(hours=worker_liveness_hours)
        if not source.moderation_worker_is_live(since=liveness_since):
            summary.abandoned_skipped_reason = "moderation_worker_not_proven_live"
            _log_event(
                "skipped_abandoned_uploads",
                since=_iso(liveness_since),
                detail=(
                    "no post_media row created since the liveness window has left "
                    "'pending', so a stalled moderation worker cannot be ruled out"
                ),
            )
        else:
            created_before = now - timedelta(days=abandoned_upload_days)
            _log_event(
                "selecting",
                klass=REASON_ABANDONED_UPLOAD,
                createdBefore=_iso(created_before),
                limit=remaining,
            )
            _absorb(
                source.fetch_abandoned_pending_media(
                    created_before=created_before, limit=remaining
                ),
                REASON_ABANDONED_UPLOAD,
            )

    if len(candidates) > max_objects:
        # Belt and braces over the per-query limits: whatever the server returned,
        # a single run can never touch more than the cap.
        _log_event(
            "cap_enforced",
            matched=len(candidates),
            cap=max_objects,
            dropped=len(candidates) - max_objects,
        )
        candidates = candidates[:max_objects]

    summary.capped = len(candidates) >= max_objects
    return candidates


# --------------------------------------------------------------------------- #
# The run
# --------------------------------------------------------------------------- #
def purge_post_media(
    *,
    source: PurgeDataSource,
    store: PurgeObjectStore | None,
    now: datetime,
    dry_run: bool = True,
    max_objects: int = DEFAULT_MAX_OBJECTS,
    retention_days: int = DEFAULT_RETENTION_DAYS,
    abandoned_upload_days: int = DEFAULT_ABANDONED_UPLOAD_DAYS,
    include_abandoned: bool = True,
    worker_liveness_hours: int = DEFAULT_WORKER_LIVENESS_HOURS,
) -> PurgeSummary:
    """Purge expired post media. DRY RUN BY DEFAULT — pass `dry_run=False` to delete.

    `now` is a REQUIRED parameter, never the wall clock: the 30-day boundary is
    the entire logic of this job and is untestable if the boundary reads the
    clock itself.
    """
    if max_objects < 1:
        raise ValueError("max_objects must be at least 1")
    if retention_days < 1:
        # A zero/negative retention window would purge media of posts deleted in
        # the future, i.e. everything. Refuse rather than "helpfully" clamp.
        raise ValueError("retention_days must be at least 1")
    if abandoned_upload_days < 1:
        raise ValueError("abandoned_upload_days must be at least 1")

    summary = PurgeSummary(dry_run=dry_run)
    if not dry_run and store is None:
        # Never reap a row we cannot pair with an object delete.
        raise ValueError(
            "refusing to purge: the post-media bucket is unconfigured, so rows "
            "would be deleted while their objects survive unreferenced"
        )

    _log_event(
        "run_start",
        dryRun=dry_run,
        cap=max_objects,
        retentionDays=retention_days,
        abandonedUploadDays=abandoned_upload_days,
        now=_iso(now),
    )

    candidates = select_candidates(
        source=source,
        now=now,
        max_objects=max_objects,
        retention_days=retention_days,
        abandoned_upload_days=abandoned_upload_days,
        include_abandoned=include_abandoned,
        worker_liveness_hours=worker_liveness_hours,
        summary=summary,
    )
    summary.considered = len(candidates)

    for candidate in candidates:
        # Logged BEFORE the delete so an audit trail survives a process that dies
        # mid-purge; the outcome line follows.
        _log_event(
            "would_purge" if dry_run else "purging",
            mediaId=candidate.media_id,
            postId=candidate.post_id,
            storagePath=candidate.storage_path,
            reason=candidate.reason,
        )
        if dry_run:
            continue

        # ---- ORDER MATTERS: OBJECT FIRST, ROW SECOND ----------------------
        # A failure between the two leaves the row pointing at a missing object:
        # the next run retries it and the app degrades to a broken image. The
        # reverse order would strand the file forever with nothing pointing at
        # it — the exact garbage this job exists to prevent.
        try:
            existed = store.delete_object(candidate.storage_path)  # type: ignore[union-attr]
        except PostMediaStoreError:
            # Malformed/hostile object key. Deterministic: it will never succeed,
            # and the row is deliberately LEFT so a human can look at it.
            log.exception(
                "unusable storage_path for post_media %s", candidate.media_id
            )
            summary.failed += 1
            _log_event(
                "purge_failed",
                mediaId=candidate.media_id,
                postId=candidate.post_id,
                storagePath=candidate.storage_path,
                stage="storage",
                detail="unusable storage path",
            )
            continue
        except Exception:  # noqa: BLE001 - bucket outage / permissions
            # Keep the run alive; the row stays, so the next run retries.
            log.exception(
                "could not delete post media object for %s", candidate.media_id
            )
            summary.failed += 1
            _log_event(
                "purge_failed",
                mediaId=candidate.media_id,
                postId=candidate.post_id,
                storagePath=candidate.storage_path,
                stage="storage",
            )
            continue

        if not existed:
            summary.objects_already_missing += 1

        try:
            source.delete_media_row(
                media_id=candidate.media_id, storage_path=candidate.storage_path
            )
        except Exception:  # noqa: BLE001 - PostgREST outage
            # The object is gone but the row survives. Intended failure mode: a
            # broken image, retried and cleaned up on the next run.
            log.exception("could not delete post_media row %s", candidate.media_id)
            summary.failed += 1
            _log_event(
                "purge_failed",
                mediaId=candidate.media_id,
                postId=candidate.post_id,
                storagePath=candidate.storage_path,
                stage="row",
                detail="object deleted; row retained for retry",
            )
            continue

        summary.purged += 1
        summary.purged_paths.append(candidate.storage_path)
        _log_event(
            "purged",
            mediaId=candidate.media_id,
            postId=candidate.post_id,
            storagePath=candidate.storage_path,
            reason=candidate.reason,
            objectAlreadyMissing=None if existed else True,
        )

    _log_event("run_done", **summary.as_dict())
    return summary


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _parse_now(raw: str | None) -> datetime:
    if not raw:
        return datetime.now(timezone.utc)
    moment = datetime.fromisoformat(raw)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Purge expired post-media images (DRY RUN unless --apply)."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually delete. Without this flag nothing is deleted (the default).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_MAX_OBJECTS,
        help=f"Hard cap on objects purged per run (default {DEFAULT_MAX_OBJECTS}).",
    )
    parser.add_argument(
        "--retention-days",
        type=int,
        default=DEFAULT_RETENTION_DAYS,
        help=(
            "Days after posts.deleted_at before media is purged "
            f"(default {DEFAULT_RETENTION_DAYS}; this is a moderation window)."
        ),
    )
    parser.add_argument(
        "--abandoned-upload-days",
        type=int,
        default=DEFAULT_ABANDONED_UPLOAD_DAYS,
        help=(
            "Age at which a still-'pending' post_media row counts as abandoned "
            f"(default {DEFAULT_ABANDONED_UPLOAD_DAYS})."
        ),
    )
    parser.add_argument(
        "--no-abandoned",
        action="store_true",
        help="Purge only media of soft-deleted posts (skip class 2 entirely).",
    )
    parser.add_argument(
        "--worker-liveness-hours",
        type=int,
        default=DEFAULT_WORKER_LIVENESS_HOURS,
        help=(
            "How recently the moderation worker must have resolved a row for "
            f"class 2 to run at all (default {DEFAULT_WORKER_LIVENESS_HOURS})."
        ),
    )
    parser.add_argument(
        "--now",
        default=None,
        help="Override the clock with an ISO-8601 timestamp (replay/debugging).",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )

    supabase_url = os.environ.get("SUPABASE_URL", "")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not supabase_url or not service_role_key:
        log.error("Missing required env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        return 1

    source = SupabasePurgeSource(
        supabase_url=supabase_url, service_role_key=service_role_key
    )
    store = build_object_store_from_env()
    if args.apply and store is None:
        log.error(
            "--apply requires %s and working credentials; refusing to delete rows "
            "whose objects cannot be deleted.",
            POST_MEDIA_GCS_BUCKET_ENV,
        )
        return 1
    if not args.apply:
        log.info("DRY RUN — nothing will be deleted. Pass --apply to purge for real.")

    try:
        purge_post_media(
            source=source,
            store=store,
            now=_parse_now(args.now),
            dry_run=not args.apply,
            max_objects=args.limit,
            retention_days=args.retention_days,
            abandoned_upload_days=args.abandoned_upload_days,
            include_abandoned=not args.no_abandoned,
            worker_liveness_hours=args.worker_liveness_hours,
        )
    except ValueError as error:
        log.error("%s", error)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
