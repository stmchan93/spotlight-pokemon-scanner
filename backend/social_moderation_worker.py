#!/usr/bin/env python3
"""Async social-content moderation worker (the "AI pass").

Part of the social layer (see docs/social-layer-database-design-2026-07-20.md). This
is the layer-2 moderation step described there: the synchronous in-DB trigger
(blocked_terms + rate limit) already ran at insert time; this worker does the
nuanced text + image classification that can't run in Postgres.

WHAT IT DOES
  - Polls Supabase (PostgREST, service-role key) for:
      * posts / comments where moderation_checked_at IS NULL  (text)
      * post_media where moderation_status = 'pending'         (images)
  - Runs each through OpenAI `omni-moderation-latest` (FREE; text AND images).
  - Writes verdicts back:
      * text  flagged -> content_status='removed'; always stamps moderation_checked_at
      * image flagged -> moderation_status='rejected'; else 'approved'
  - Images stay hidden (RLS gates on moderation_status='approved') until this runs.

WHY THE VM, NOT AN EDGE FUNCTION
  The free OpenAI call needs a server to hold the key; this VM already is that
  server (same place sync_user_emails_from_supabase() uses the service-role key).
  No serverless bill, no Edge Function.

WHERE THE IMAGE BYTES LIVE
  NOT in Supabase Storage. Post images were migrated to a PRIVATE GCS bucket and
  are read through ``post_media_store`` (the same abstraction the authenticated
  serving proxy in server.py uses). The bytes are base64-inlined into the
  moderation request as a `data:` URL rather than handed over as a signed URL —
  see ``_image_data_url`` for why.

DEPLOYMENT
  Scheduled from the managed crontab block in deploy_to_vm.sh, on BOTH
  environments, every 2 minutes by default (SPOTLIGHT_VM_MODERATION_CRON), via
  run_social_moderation_vm.sh --once under an exclusive flock. Cron owns the
  cadence rather than --loop: an unsupervised loop that dies stays dead until the
  next deploy, whereas a missed tick costs one batch of latency.
  Env required (text pass):
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
  Env required (image pass, on top of the above):
    SPOTLIGHT_POST_MEDIA_GCS_BUCKET  + Google application default credentials
    with read access to that bucket. When it is unset the image pass is SKIPPED
    (rows stay 'pending', which RLS already treats as hidden) — the worker still
    runs the text pass instead of crashing.
  Anything missing is logged as "moderation disabled: missing <VAR>", so
    grep 'moderation disabled' ~/spotlight/logs/social_moderation.log
  distinguishes "not configured" from "nothing to do".
  One-shot (safe to run repeatedly):
    python3 backend/social_moderation_worker.py --once
  Continuous (kept for manual backfills; cron uses --once):
    python3 backend/social_moderation_worker.py --loop --interval 60

CSAM NOTE
  omni-moderation covers sexual/violence categories but is NOT sufficient for
  child-sexual-abuse material. Before public image uploads scale, add hash-matching
  (PhotoDNA / Cloudflare CSAM tool) + the legally-required NCMEC reporting path.
"""

from __future__ import annotations

import argparse
import base64
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

import requests

# The worker is executed as a script (`python3 backend/social_moderation_worker.py`)
# but is also imported by the tests, so make the backend package root importable
# either way before reaching for its siblings.
BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from post_media_store import (  # noqa: E402
    POST_MEDIA_GCS_BUCKET_ENV,
    PostMediaStoreError,
    build_post_media_store,
    content_type_for_path,
)

log = logging.getLogger("social_moderation_worker")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations"
MODERATION_MODEL = "omni-moderation-latest"
HTTP_TIMEOUT = 30

# Rows pulled per table per invocation. This is the knob that bounds how long a
# single cron tick runs, which matters on the FIRST run against a backlog: every
# image posted since the feature shipped is still 'pending', so tick one faces
# the whole queue at once.
#
# Why 50 is safe rather than merely small:
#   - Rate limit: the calls are sequential, one item per request, so the peak
#     rate is ~1 request per round trip (a few per second at best). Nowhere near
#     the moderation endpoint's limits, and the endpoint is free, so a backlog
#     costs nothing but time and GCS egress.
#   - Cron interval: 3 passes x 50 rows is the worst-case tick. Images dominate
#     (GCS read + base64 + upload), so a full tick can exceed the 2-minute
#     interval on a real backlog. That is expected and handled — the runner's
#     flock makes the next tick a no-op instead of piling on, and the queue
#     drains at up to 50 images per tick until it is empty.
# Lower it (SPOTLIGHT_MODERATION_BATCH) if ticks need to stay inside a shorter
# interval; there is no correctness reason to raise it.
DEFAULT_BATCH = 50
MAX_BATCH = 200
BATCH_ENV = "SPOTLIGHT_MODERATION_BATCH"

# Defensive ceiling on the bytes we will base64 into a moderation request.
# The upload endpoint already caps a post image at 12 MB (server.py's
# DEFAULT_JSON_BODY_LIMIT_BYTES), and OpenAI accepts images up to 20 MB, so this
# only fires for an object that got into the bucket by some other route.
MAX_IMAGE_BYTES = 20 * 1024 * 1024


def _batch_limit() -> int:
    """Rows to pull per table per pass, clamped to a sane range.

    Read at call time rather than import time so the operator can retune it in
    the runtime env file without touching code, and so a garbage value degrades
    to the default instead of putting an unbounded (or zero) ``limit=`` on the
    PostgREST query.
    """
    raw = str(os.environ.get(BATCH_ENV) or "").strip()
    if not raw:
        return DEFAULT_BATCH
    try:
        value = int(raw)
    except ValueError:
        log.warning("%s=%r is not an integer; using %s", BATCH_ENV, raw, DEFAULT_BATCH)
        return DEFAULT_BATCH
    if value < 1:
        log.warning("%s=%s is below 1; using 1", BATCH_ENV, value)
        return 1
    if value > MAX_BATCH:
        log.warning("%s=%s exceeds %s; clamping", BATCH_ENV, value, MAX_BATCH)
        return MAX_BATCH
    return value


def _rest_headers() -> dict[str, str]:
    return {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }


def _require_env() -> None:
    missing = [
        name
        for name, val in (
            ("SUPABASE_URL", SUPABASE_URL),
            ("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY),
            ("OPENAI_API_KEY", OPENAI_API_KEY),
        )
        if not val
    ]
    if missing:
        # Same wording as run_social_moderation_vm.sh so one grep over the log
        # ("moderation disabled") finds every reason the pass is not running,
        # whichever layer noticed first.
        raise SystemExit(f"moderation disabled: missing {', '.join(missing)}")


# --------------------------------------------------------------------------- #
# OpenAI moderation
# --------------------------------------------------------------------------- #
def _moderate(inputs: list[dict[str, Any]]) -> bool:
    """Return True if the content is flagged (should be removed/rejected)."""
    resp = requests.post(
        OPENAI_MODERATION_URL,
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        json={"model": MODERATION_MODEL, "input": inputs},
        timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    results = resp.json().get("results", [])
    return any(bool(r.get("flagged")) for r in results)


def _moderate_text(body: str | None) -> bool:
    text = (body or "").strip()
    if not text:
        return False
    return _moderate([{"type": "text", "text": text}])


def _moderate_image(image_url: str) -> bool:
    return _moderate([{"type": "image_url", "image_url": {"url": image_url}}])


# --------------------------------------------------------------------------- #
# Post-media images (PRIVATE GCS bucket)
# --------------------------------------------------------------------------- #
# Built once per process and cached, including the "not configured" answer, so a
# looping worker does not re-attempt (and re-log) client construction every batch.
_MEDIA_STORE_UNSET = object()
_media_store: Any = _MEDIA_STORE_UNSET


def _build_media_store() -> Any | None:
    """Build the private post-media GCS store, or ``None`` when unavailable.

    Mirrors how server.py builds it, but this is a standalone process so it also
    swallows client-construction failures (missing google-cloud-storage, absent
    application default credentials). The worker must degrade to a text-only pass
    rather than crash: an unmoderated ``post_media`` row stays 'pending', and RLS
    already treats anything other than 'approved' as hidden, so skipping the
    image pass fails closed.
    """
    bucket = str(os.environ.get(POST_MEDIA_GCS_BUCKET_ENV) or "").strip()
    if not bucket:
        log.warning(
            "image moderation disabled: missing %s — post_media rows stay "
            "'pending' (hidden by RLS) until the bucket is configured.",
            POST_MEDIA_GCS_BUCKET_ENV,
        )
        return None
    try:
        return build_post_media_store(gcs_bucket=bucket)
    except Exception:  # noqa: BLE001 — no client/credentials → ship dark, not crash
        log.exception(
            "could not build the post media store for bucket %s — image "
            "moderation is disabled for this run",
            bucket,
        )
        return None


def _get_media_store() -> Any | None:
    global _media_store
    if _media_store is _MEDIA_STORE_UNSET:
        _media_store = _build_media_store()
    return _media_store


def _reset_media_store_cache() -> None:
    """Drop the cached store (tests; also usable from a REPL)."""
    global _media_store
    _media_store = _MEDIA_STORE_UNSET


def _image_data_url(storage_path: str, image_bytes: bytes) -> str:
    """Inline the object bytes as a ``data:`` URL for the moderation request.

    WHY BASE64 AND NOT A SIGNED URL:
      - ``post_media_store`` exposes ``read_bytes`` and nothing else; no store in
        this backend mints signed URLs, so a signed-URL path would mean new GCS
        plumbing (blob.generate_signed_url needs a signing key, which the VM's
        default compute service account does not have — it would need the IAM
        SignBlob API plus the matching role).
      - A signed URL is, for its lifetime, an unauthenticated public handle to
        UNMODERATED user content. The whole point of this bucket being private is
        that un-approved bytes are never publicly addressable; base64 keeps that
        invariant and the bytes only ever travel over the OpenAI TLS request.
    """
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{content_type_for_path(storage_path)};base64,{encoded}"


# --------------------------------------------------------------------------- #
# Supabase helpers
# --------------------------------------------------------------------------- #
def _fetch(table: str, query: str) -> list[dict[str, Any]]:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}?{query}",
        headers=_rest_headers(),
        timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def _patch(table: str, match: str, payload: dict[str, Any]) -> None:
    resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{table}?{match}",
        headers={**_rest_headers(), "Prefer": "return=minimal"},
        json=payload,
        timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()


# --------------------------------------------------------------------------- #
# Passes
# --------------------------------------------------------------------------- #
# `reports.target_type` is singular ("post" / "comment"); the poll tables are
# plural. Mapping it wrong would silently return "no reports" for everything and
# quietly re-publish content the community had hidden, so it is explicit.
_REPORT_TARGET_TYPES = {"posts": "post", "comments": "comment"}


def _has_open_report(table: str, row_id: str) -> bool:
    """True when the community has an unresolved report against this row.

    Used only to decide whether a `pending` row the AI cleared may go back to
    `visible`. Fails CLOSED: an unknown table or a failed lookup reports True, so
    a blip leaves content hidden rather than republishing something reported.
    """
    target_type = _REPORT_TARGET_TYPES.get(table)
    if target_type is None:
        return True
    try:
        # Matches idx_reports_target, which is partial on status = 'open'.
        return bool(
            _fetch(
                "reports",
                f"target_type=eq.{target_type}&target_id=eq.{row_id}"
                "&status=eq.open&select=id&limit=1",
            )
        )
    except Exception:  # noqa: BLE001 — never republish on a lookup failure
        log.exception("open-report lookup failed for %s %s; holding", table, row_id)
        return True


def _moderate_text_table(table: str) -> int:
    rows = _fetch(
        table,
        "moderation_checked_at=is.null"
        f"&select=id,body,content_status&limit={_batch_limit()}",
    )
    for row in rows:
        try:
            flagged = _moderate_text(row.get("body"))
            payload: dict[str, Any] = {"moderation_checked_at": "now()"}
            if flagged:
                payload["content_status"] = "removed"
                outcome = "removed"
            elif row.get("content_status") == "pending":
                # The synchronous prefilter (tg_content_prefilter) parks anything
                # matching a `soft` wordlist term at `pending` and leaves
                # moderation_checked_at NULL so THIS pass decides. If we only
                # stamped the timestamp, a soft hit the AI cleared would stay
                # hidden forever — `soft` would be a one-way delete with extra
                # steps, which is the opposite of what the tier is for.
                #
                # But `pending` has a second author: tg_reports_threshold() hides
                # a target once K distinct users report it. Blindly promoting
                # every clean `pending` row would silently overturn community
                # moderation, so only rows with no open report are released. That
                # check is why this cannot live in a DB trigger.
                if _has_open_report(table, row["id"]):
                    outcome = "held (open report)"
                else:
                    payload["content_status"] = "visible"
                    outcome = "released"
            else:
                outcome = "ok"
            _patch(table, f"id=eq.{row['id']}", payload)
            log.info("%s %s -> %s", table, row["id"], outcome)
        except Exception:  # noqa: BLE001 — keep the worker alive on a single bad row
            log.exception("failed moderating %s %s", table, row.get("id"))
    return len(rows)


def _set_media_status(media_id: Any, status: str) -> None:
    _patch("post_media", f"id=eq.{media_id}", {"moderation_status": status})
    log.info("post_media %s -> %s", media_id, status)


def _moderate_media() -> int:
    store = _get_media_store()
    if store is None:
        # Not configured (or no credentials): skip the whole pass. _build_media_store
        # already logged once; rows stay 'pending' and therefore stay hidden.
        return 0

    rows = _fetch(
        "post_media",
        f"moderation_status=eq.pending&select=id,storage_path&limit={_batch_limit()}",
    )
    for row in rows:
        media_id = row.get("id")
        try:
            storage_path = str(row.get("storage_path") or "").strip()
            if not storage_path:
                # A row with no object can never be moderated. Fail closed and
                # stop retrying it every batch.
                log.warning("post_media %s has no storage_path -> rejected", media_id)
                _set_media_status(media_id, "rejected")
                continue

            try:
                image_bytes = store.read_bytes(storage_path)
            except PostMediaStoreError:
                # Malformed/hostile object key: deterministic, never succeeds.
                log.exception(
                    "post_media %s has an unusable storage_path -> rejected", media_id
                )
                _set_media_status(media_id, "rejected")
                continue
            except Exception:  # noqa: BLE001 — GCS outage / missing object
                # Possibly transient. Leave the row 'pending' (still hidden) so
                # the next batch retries instead of wrongly rejecting during an
                # outage.
                log.exception("could not read post media bytes for %s", media_id)
                continue

            if not image_bytes:
                log.warning("post_media %s object is empty; leaving pending", media_id)
                continue
            if len(image_bytes) > MAX_IMAGE_BYTES:
                # Too large to hand to the moderation model, so it can never be
                # cleared — refuse rather than leave it retrying forever.
                log.warning(
                    "post_media %s is %s bytes (> %s) -> rejected",
                    media_id,
                    len(image_bytes),
                    MAX_IMAGE_BYTES,
                )
                _set_media_status(media_id, "rejected")
                continue

            flagged = _moderate_image(_image_data_url(storage_path, image_bytes))
            _set_media_status(media_id, "rejected" if flagged else "approved")
        except Exception:  # noqa: BLE001 — keep the worker alive on a single bad row
            log.exception("failed moderating media %s", media_id)
    return len(rows)


def run_once() -> int:
    handled = 0
    handled += _moderate_text_table("posts")
    handled += _moderate_text_table("comments")
    handled += _moderate_media()
    return handled


def main() -> None:
    parser = argparse.ArgumentParser(description="Social content moderation worker (AI pass).")
    parser.add_argument("--once", action="store_true", help="Process one batch and exit.")
    parser.add_argument("--loop", action="store_true", help="Run continuously.")
    parser.add_argument("--interval", type=int, default=60, help="Seconds between loops.")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    _require_env()
    # Resolve the image store up front so the "image pass disabled" warning lands
    # at startup rather than mid-batch. Never fatal: the text pass runs regardless.
    log.info(
        "image moderation: %s",
        "enabled" if _get_media_store() is not None else "DISABLED",
    )

    if args.loop:
        log.info("moderation worker: continuous mode, interval=%ss", args.interval)
        while True:
            try:
                n = run_once()
                log.info("batch done: %s items", n)
            except Exception:  # noqa: BLE001
                log.exception("batch failed")
            time.sleep(args.interval)
    else:
        n = run_once()
        log.info("done: %s items", n)


if __name__ == "__main__":
    main()
