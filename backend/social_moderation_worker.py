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

DEPLOYMENT (LATER — NOT wired to cron yet; nothing uses the social tables today)
  Env required (text pass):
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
  Env required (image pass, on top of the above):
    SPOTLIGHT_POST_MEDIA_GCS_BUCKET  + Google application default credentials
    with read access to that bucket. When it is unset the image pass is SKIPPED
    (rows stay 'pending', which RLS already treats as hidden) — the worker still
    runs the text pass instead of crashing.
  One-shot (safe to run repeatedly):
    python3 backend/social_moderation_worker.py --once
  Continuous (simple loop; or install as a cron / systemd timer every 1-2 min):
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
BATCH = 50
HTTP_TIMEOUT = 30

# Defensive ceiling on the bytes we will base64 into a moderation request.
# The upload endpoint already caps a post image at 12 MB (server.py's
# DEFAULT_JSON_BODY_LIMIT_BYTES), and OpenAI accepts images up to 20 MB, so this
# only fires for an object that got into the bucket by some other route.
MAX_IMAGE_BYTES = 20 * 1024 * 1024


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
        raise SystemExit(f"Missing required env: {', '.join(missing)}")


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
            "%s is unset — image moderation is disabled; post_media rows stay "
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
def _moderate_text_table(table: str) -> int:
    rows = _fetch(table, f"moderation_checked_at=is.null&select=id,body&limit={BATCH}")
    for row in rows:
        try:
            flagged = _moderate_text(row.get("body"))
            payload: dict[str, Any] = {"moderation_checked_at": "now()"}
            if flagged:
                payload["content_status"] = "removed"
            _patch(table, f"id=eq.{row['id']}", payload)
            log.info("%s %s -> %s", table, row["id"], "removed" if flagged else "ok")
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

    rows = _fetch("post_media", f"moderation_status=eq.pending&select=id,storage_path&limit={BATCH}")
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
