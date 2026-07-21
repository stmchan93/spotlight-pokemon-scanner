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

DEPLOYMENT (LATER — NOT wired to cron yet; nothing uses the social tables today)
  Env required:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
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
import logging
import os
import time
from typing import Any

import requests

log = logging.getLogger("social_moderation_worker")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations"
MODERATION_MODEL = "omni-moderation-latest"
BATCH = 50
SIGNED_URL_TTL_SECONDS = 600
STORAGE_BUCKET = "post-media"
HTTP_TIMEOUT = 30


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


def _sign_object(path: str) -> str | None:
    resp = requests.post(
        f"{SUPABASE_URL}/storage/v1/object/sign/{STORAGE_BUCKET}/{path}",
        headers=_rest_headers(),
        json={"expiresIn": SIGNED_URL_TTL_SECONDS},
        timeout=HTTP_TIMEOUT,
    )
    if resp.status_code >= 400:
        log.warning("could not sign object %s: %s", path, resp.text)
        return None
    signed = resp.json().get("signedURL")
    return f"{SUPABASE_URL}/storage/v1{signed}" if signed else None


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


def _moderate_media() -> int:
    rows = _fetch("post_media", f"moderation_status=eq.pending&select=id,storage_path&limit={BATCH}")
    for row in rows:
        try:
            url = _sign_object(row["storage_path"])
            if not url:
                continue
            flagged = _moderate_image(url)
            status = "rejected" if flagged else "approved"
            _patch("post_media", f"id=eq.{row['id']}", {"moderation_status": status})
            log.info("post_media %s -> %s", row["id"], status)
        except Exception:  # noqa: BLE001
            log.exception("failed moderating media %s", row.get("id"))
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
