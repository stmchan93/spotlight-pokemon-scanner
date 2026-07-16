from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sqlite3
import sys
import traceback
import threading
import uuid
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import perf_counter
from typing import Any, Literal
from urllib.parse import parse_qs, unquote, urlparse
from zoneinfo import ZoneInfo

from env_loader import load_backend_env_file as _load_backend_env_file


_load_backend_env_file(Path(__file__).resolve().parent / ".env")

from catalog_tools import (
    _coerce_price_summary_from_entry,
    _graded_contexts_payload,
    _graded_variants_for_context,
    _is_raw_phantom_price,
    _is_raw_phantom_price_from_cells,
    _ppt_graded_signal_row,
    _normalized_condition_code,
    _normalized_variant_label,
    _raw_context_conditions,
    _raw_context_entry,
    _raw_context_variants,
    _raw_contexts_payload,
    _resolve_graded_context_entry,
    _resolve_raw_context_summary,
    _cell_summary_from_row,
    _cell_field,
    price_history_cells_enabled,
    pricing_provider,
    price_history_cell_rows_for_day,
    price_history_cell_rows_by_date,
    price_history_cell_portfolio_rows_by_card_date,
    resolve_graded_entry_from_cells,
    resolve_raw_summary_from_cells,
    _graded_cell_is_corrupt,
    DEFAULT_RAW_CONDITION,
    MATCHER_VERSION,
    RAW_CONDITION_PRIORITY,
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    RAW_VARIANT_PRIORITY,
    RawDecisionResult,
    RawEvidence,
    RawRetrievalPlan,
    RawSignalScores,
    apply_schema,
    build_raw_evidence,
    build_raw_retrieval_plan,
    canonicalize_collector_number,
    card_by_id,
    card_price_trend_list,
    card_text_from_card,
    tcgplayer_variants_subset,
    collision_guard,
    suppressed_raw_variant_labels,
    filter_suppressed_raw_variants,
    cards_by_ids,
    append_deck_entry_event,
    connect,
    contextual_pricing_summary_for_card,
    deck_entry_storage_key,
    delete_card_transaction,
    delete_runtime_setting,
    finalize_raw_decision,
    get_card_transaction,
    insert_card_transaction,
    list_card_transactions,
    latest_price_history_update_for_context,
    latest_price_history_row_for_card,
    latest_provider_sync_run,
    load_index,
    merge_raw_candidate_pools,
    price_history_rows_for_card,
    price_history_rows_for_cards_batched,
    price_snapshot_row,
    provider_sync_run_is_fresh,
    rank_raw_candidates,
    raw_debug_payload,
    rank_visual_hybrid_candidates,
    resolver_mode_for_payload,
    score_raw_candidate_resolution,
    score_raw_candidate_retrieval,
    score_raw_signals,
    _MANUAL_SEARCH_POOL_CEILING,
    search_cards,
    search_cards_local,
    search_cards_local_collector_only,
    search_cards_local_collector_set,
    search_cards_local_title_only,
    search_cards_local_title_set,
    expansion_count,
    get_cards_by_expansion,
    list_local_expansions,
    list_persisted_expansions,
    runtime_setting,
    tokenize,
    upsert_catalog_card,
    upsert_deck_entry,
    upsert_runtime_setting,
    upsert_scan_artifact,
    upsert_scan_confirmation,
    upsert_scan_event,
    replace_scan_prediction_candidates,
    replace_scan_price_observations,
    replace_slab_recent_sales_cache,
    record_sale_event,
    slab_recent_sales_cache,
    utc_now,
)
from fx_rates import (
    convert_price_trend_list_with_fx,
    decorate_pricing_summary_with_fx,
)
from ebay_comps import DEFAULT_RESULT_LIMIT as DEFAULT_EBAY_LISTING_LIMIT, fetch_graded_card_ebay_comps
from pricecharting_adapter import PriceChartingProvider
from pricing_provider import PricingProviderRegistry
from portfolio_imports import (
    commit_portfolio_import,
    get_portfolio_import_job,
    preview_portfolio_import,
    resolve_portfolio_import,
)
from scrydex_adapter import (
    SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
    SCRYDEX_PROVIDER,
    ScrydexProvider,
    best_remote_scrydex_raw_candidates,
    fetch_scrydex_recent_sales,
    fetch_scrydex_price_history,
    fetch_scrydex_expansions,
    sync_scrydex_expansions,
    map_scrydex_catalog_card,
    persist_scrydex_price_history_payload,
    persist_scrydex_raw_snapshot,
    scrydex_request_audit_summary,
    scrydex_request_stats_snapshot,
    search_remote_scrydex_raw_candidates,
    search_remote_scrydex_slab_candidates,
    raw_evidence_looks_japanese,
    search_remote_scrydex_japanese_raw_candidates,
)
from slab_cert_resolver import resolve_psa_cert_from_scan_cache
from slab_set_aliases import resolve_slab_set_aliases
from scan_artifact_store import (
    SCAN_ARTIFACTS_GCS_BUCKET_ENV,
    SCAN_ARTIFACTS_STORAGE_ENV,
    SCAN_ARTIFACTS_ROOT_ENV,
    build_scan_artifact_store,
)
from request_auth import RequestAuthError, RequestIdentity, SupabaseRequestAuthenticator

_OMIT_STRUCTURED_LOG_VALUE = object()

MANUAL_SCRYDEX_MIRROR_ENV = "SPOTLIGHT_MANUAL_SCRYDEX_MIRROR"
LIVE_PRICING_ENABLED_ENV = "SPOTLIGHT_LIVE_PRICING_ENABLED"
SCAN_ARTIFACT_UPLOADS_ENABLED_ENV = "SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED"
SUPABASE_URL_ENV = "SUPABASE_URL"
SUPABASE_JWKS_URL_ENV = "SUPABASE_JWKS_URL"
SUPABASE_JWT_SECRET_ENV = "SUPABASE_JWT_SECRET"
AUTH_REQUIRED_ENV = "SPOTLIGHT_AUTH_REQUIRED"
AUTH_FALLBACK_USER_ID_ENV = "SPOTLIGHT_AUTH_FALLBACK_USER_ID"
REVIEWER_USER_IDS_ENV = "SPOTLIGHT_REVIEWER_USER_IDS"
REVIEWER_EMAILS_ENV = "SPOTLIGHT_REVIEWER_EMAILS"
REVIEW_QUEUE_DEFAULT_LIMIT = 30
# A live, DB-backed review queue: instead of a frozen file, serve every raw scan
# that still needs a label from REVIEW_DYNAMIC_SINCE onward, oldest first, and
# keep auto-feeding new scans as they come in. The /review page points at this id.
REVIEW_DYNAMIC_QUEUE_ID = "all"
REVIEW_DYNAMIC_SINCE = os.environ.get("SPOTLIGHT_REVIEW_SINCE", "2026-05-19")
_REVIEW_QUEUE_ID_PATTERN = re.compile(r"[^A-Za-z0-9_-]")
CARD_SHOW_MODE_SETTING_KEY = "card_show_mode"
LIVE_PRICING_SETTING_KEY = "live_pricing"

# --- Public App Store ACCESS GATE -------------------------------------------
# When the gate is CLOSED (card-show-mode inactive), only allowed users may use
# the protected backend surface. Allowed = gate OPEN, OR admin email, OR a
# whitelisted email, OR a redeemed invite-code grant persisted to the account.
#
# Admin emails and invite codes are configured via environment (comma-separated)
# so they are not baked into the public repo. Set them in the gitignored secrets
# file that the VM sources before launch:
#   SPOTLIGHT_ACCESS_ADMIN_EMAILS=admin@example.com,other@example.com
#   SPOTLIGHT_ACCESS_INVITE_CODES=some_invite_code
ACCESS_ADMIN_EMAILS_ENV = "SPOTLIGHT_ACCESS_ADMIN_EMAILS"
ACCESS_INVITE_CODES_ENV = "SPOTLIGHT_ACCESS_INVITE_CODES"


def _access_admin_emails() -> set[str]:
    raw = os.environ.get(ACCESS_ADMIN_EMAILS_ENV) or ""
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


def _access_invite_codes() -> set[str]:
    raw = os.environ.get(ACCESS_INVITE_CODES_ENV) or ""
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


# Runtime-settings key holding the dynamic email whitelist: {"emails": [...]}.
ACCESS_WHITELIST_SETTING_KEY = "access_whitelist_emails"

# Size of the persisted scan candidate pool. The live scan response still hydrates
# exactly the top 10 candidates (with pricing); the remainder of the pool is stored
# as LIGHTWEIGHT rows (no per-candidate DB lookup, no pricing) so that the "load
# more candidates" endpoint can hydrate them cheaply, on demand, without adding any
# latency to the live scan path.
SCAN_CANDIDATE_POOL_SIZE = int(os.environ.get("SPOTLIGHT_SCAN_CANDIDATE_POOL_SIZE", "30"))

# --- Scan inference concurrency guard (queue/wait, not fail-fast) ------------
# The HTTP server is threaded (one thread per request) and the visual encoder
# (ONNX forward) is CPU-bound. With nothing bounding how many encoder runs
# execute at once, a burst of concurrent/retried scans on a small VM makes every
# inference fight for CPU: a normally ~60ms forward balloons to ~60s, the load
# average spikes, and every request times out client-side. Worse, when the app
# aborts a slow request and retries, the abandoned request keeps burning CPU
# (the server only notices the disconnect when it tries to write the response),
# so retries pile MORE load on. That is the failure we saw.
#
# This semaphore caps concurrent encoder-bearing scans so they take turns —
# each one stays fast on a free core instead of all thrashing. A request that
# can't get a slot WAITS in line (it does not fail immediately); only if the
# wait exceeds the acquire timeout does it return 503. That timeout is set
# deliberately BELOW the app's per-scan request timeout, so any shed load comes
# back as a quick 503 that the app's existing (invisible) retry re-submits once
# the queue has drained — the user just keeps seeing "scanning…", not an error.
# A request that never gets a slot runs zero inference, so 503s are cheap and
# self-healing.
#
# Concurrency defaults to (CPU count - 1) so the encoder can't starve the
# request-accept loop / pricing lookups, and it auto-scales when the VM is
# resized (e.g. 2 vCPU -> 1 concurrent, 4 vCPU -> 3). Both are env-overridable.
SCAN_INFERENCE_MAX_CONCURRENCY = max(
    1,
    int(
        os.environ.get("SPOTLIGHT_MAX_CONCURRENT_SCAN_INFERENCES")
        or max(1, (os.cpu_count() or 2) - 1)
    ),
)
# Kept below the client's per-scan request timeout (raw match = 10s) so a queued
# request that can't get a slot in time returns 503 BEFORE the app aborts it,
# letting the app's silent retry absorb it. Override with
# SPOTLIGHT_SCAN_INFERENCE_ACQUIRE_TIMEOUT_S.
SCAN_INFERENCE_ACQUIRE_TIMEOUT_S = float(
    os.environ.get("SPOTLIGHT_SCAN_INFERENCE_ACQUIRE_TIMEOUT_S") or "6.0"
)
_scan_inference_semaphore = threading.BoundedSemaphore(SCAN_INFERENCE_MAX_CONCURRENCY)

# Heavy-read backpressure (separate pool from scan inference: those are CPU-bound,
# these are disk-I/O-bound). Caps how many expensive portfolio/collection reads
# (dashboard, history, ledger, deck entries) run at once so a concurrency spike
# fails FAST with a retryable 503 instead of every request piling up on disk I/O
# and cascading into multi-second/60s hangs (load testing showed these endpoints
# are ~1s solo but collapse under ~30 concurrent readers). The cap is kept at ~one
# per core (NOT cores×2): these reads bottleneck on a single disk, and a cold
# portfolio/history read re-scans a 27M-row table — letting too many run at once
# thrashes I/O and lets none finish, whereas a tight cap lets the first warm the
# page cache so the rest return fast. Scales with cores; override with
# SPOTLIGHT_MAX_CONCURRENT_HEAVY_READS.
HEAVY_READ_MAX_CONCURRENCY = max(
    2,
    int(
        os.environ.get("SPOTLIGHT_MAX_CONCURRENT_HEAVY_READS")
        or (os.cpu_count() or 2)
    ),
)
# Short wait: a queued read that can't get a slot in time returns 503 quickly
# (the client retries silently) rather than hanging. Override with
# SPOTLIGHT_HEAVY_READ_ACQUIRE_TIMEOUT_S.
HEAVY_READ_ACQUIRE_TIMEOUT_S = float(
    os.environ.get("SPOTLIGHT_HEAVY_READ_ACQUIRE_TIMEOUT_S") or "3.0"
)
_heavy_read_semaphore = threading.BoundedSemaphore(HEAVY_READ_MAX_CONCURRENCY)

RECENT_SALES_DEFAULT_LIMIT = 5
RECENT_SALES_MAX_LIMIT = 25
RECENT_SALES_FRESHNESS_HOURS = 24
RECENT_SALES_EMPTY_REFRESH_HOURS = 48

# Fail-fast budget for slab resolution. Slabs hit the OCR label-scoring
# fallback when both the cert cache and (gated) remote search miss; that
# path was producing 40-50s requests on staging. Cap the whole slab match
# path at this many seconds and return a clean "could not identify" shape
# when the budget is exceeded instead of grinding on local OCR fallbacks
# that surface unrelated cards (e.g. cert OCR collisions on collector
# number 290 matching me2pt5-290).
SLAB_MATCH_BUDGET_SECONDS = 7.0

# Module-level sentinel used by the card-lookup-cache to distinguish a true
# `None` (card not found, cached) from "key absent". Allocated once so the
# `is` identity check stays cheap across calls.
_CARD_LOOKUP_CACHE_MISS: object = object()


def _strip_cross_language_set_suffix(set_name: str) -> str:
    """Strip deck-specific suffixes from cross-language set names.

    "Pokémon TCG Classic - Venusaur"  → "Pokémon TCG Classic"
    "Pokémon TCG Classic - Charizard" → "Pokémon TCG Classic"
    "Pokémon TCG Classic - Blastoise" → "Pokémon TCG Classic"
    Other set names are returned unchanged.
    """
    prefix = "Pokémon TCG Classic"
    if set_name.startswith(prefix + " - "):
        return prefix
    return set_name


def _recent_sales_age_hours(fetched_at: str | None) -> int | None:
    text = str(fetched_at or "").strip()
    if not text:
        return None
    cleaned = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)
    if delta.total_seconds() < 0:
        return 0
    return int(delta.total_seconds() // 3600)


def _recent_sales_payload(
    cached: dict[str, Any] | None,
    *,
    source: str,
    grader: str,
    grade: str,
    not_loaded: bool = False,
    unavailable_reason: str | None = None,
) -> dict[str, Any]:
    if cached is None:
        return {
            "source": source,
            "grader": grader,
            "grade": grade,
            "status": "unavailable",
            "statusReason": "not_loaded" if not_loaded else "unavailable",
            "unavailableReason": unavailable_reason,
            "fetchedAt": None,
            "canRefresh": False,
            "saleCount": 0,
            "sales": [],
        }

    fetched_at = str(cached.get("fetchedAt") or "").strip() or None
    status = str(cached.get("status") or "").strip().lower()
    age_hours = _recent_sales_age_hours(fetched_at)
    refresh_after_hours = RECENT_SALES_EMPTY_REFRESH_HOURS if status == "no_results" else RECENT_SALES_FRESHNESS_HOURS
    sale_rows = list(cached.get("sales") or [])
    unavailable = status != "available"
    return {
        "source": str(cached.get("source") or source).strip().lower() or source,
        "grader": str(cached.get("grader") or grader).strip().upper() or grader,
        "grade": str(cached.get("grade") or grade).strip().upper() or grade,
        "status": "unavailable" if unavailable else "available",
        "statusReason": "no_results" if status == "no_results" else None,
        "unavailableReason": unavailable_reason or ("No recent sold sales were returned for this slab." if status == "no_results" else None),
        "fetchedAt": fetched_at,
        "canRefresh": bool(age_hours is not None and age_hours >= refresh_after_hours),
        "saleCount": len(sale_rows),
        "sales": [
            {
                "id": str(row.get("id") or "").strip(),
                "title": str(row.get("title") or "").strip() or None,
                "soldAt": str(row.get("soldAt") or row.get("sold_at") or "").strip() or None,
                "price": {
                    "amount": row.get("price"),
                    "currencyCode": str(row.get("currencyCode") or "USD").strip().upper() or "USD",
                },
                "currencyCode": str(row.get("currencyCode") or "USD").strip().upper() or "USD",
                "listingURL": str(row.get("listingURL") or row.get("listing_url") or "").strip() or None,
            }
            for row in sale_rows
        ],
    }
SCAN_ARTIFACT_UPLOADS_SETTING_KEY = "scan_artifact_uploads"
DEFAULT_CARD_SHOW_MODE_HOURS = 8.0
LIVE_PRICING_REFRESH_WINDOW_HOURS = 1.0
# Rolling window for the passive "people watching" count on the card detail.
CARD_WATCHER_WINDOW_DAYS = 7
DEFAULT_JSON_BODY_LIMIT_BYTES = 12 * 1024 * 1024
SCAN_ARTIFACT_JSON_BODY_LIMIT_BYTES = 32 * 1024 * 1024
DECK_CARD_CONDITIONS = {
    "near_mint",
    "lightly_played",
    "moderately_played",
    "heavily_played",
    "damaged",
}
LABELING_SESSION_REQUIRED_ANGLE_COUNT = 4
LABELING_REGISTRY_SCHEMA_VERSION = 2
LABELING_ACTIVE_BATCH_ID_ENV = "SPOTLIGHT_LABELING_ACTIVE_BATCH_ID"
LABELING_TIER2_PERCENT_ENV = "SPOTLIGHT_LABELING_TIER2_PERCENT"
DEFAULT_LABELING_TIER2_PERCENT = 20


def _labeling_session_id_from_path(path: str, suffix: str) -> str | None:
    prefix = "/api/v1/labeling-sessions/"
    if not path.startswith(prefix) or not path.endswith(suffix):
        return None
    raw_session_id = path[len(prefix) : len(path) - len(suffix)]
    session_id = unquote(raw_session_id)
    if not session_id or "/" in session_id:
        return ""
    return session_id


def _is_large_image_upload_path(path: str) -> bool:
    if path == "/api/v1/scan-artifacts":
        return True
    if path == "/api/v1/card-transactions":
        return True
    return _labeling_session_id_from_path(path, "/artifacts") is not None


def _default_dataset_root() -> Path:
    configured = str(os.environ.get("SPOTLIGHT_DATASET_ROOT") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / "spotlight-datasets"


def _default_raw_visual_train_root() -> Path:
    configured = str(os.environ.get("SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return _default_dataset_root() / "raw-visual-train"


def _default_labeling_registry_path() -> Path:
    return _default_raw_visual_train_root() / "raw_scan_registry.json"


# Backbone-aware visual-similarity calibration for the confidence score.
# The raw-visual confidence bands (in compute_raw_confidence) were tuned against
# CLIP-B/32's cosine scale, where correct matches center ~0.74. SigLIP2-384's correct
# matches center slightly lower (~0.70), so without calibration its confidence reads
# artificially low. This affine maps SigLIP's correct-match distribution onto CLIP's,
# derived by aligning the 10/25/50/75/90th percentiles of correct top-1 similarity on
# the 204-card show holdout (2026-06-07): 0.65*s + 0.29 sends SigLIP {0.566,0.612,0.701,
# 0.757,0.788} -> {0.658,0.688,0.746,0.782,0.802}, matching CLIP {0.65,0.688,0.74,0.774,
# 0.805}. CLIP (and any non-SigLIP backbone) is returned unchanged.
_SIGLIP_SIM_CALIBRATION_GAIN = 0.65
_SIGLIP_SIM_CALIBRATION_OFFSET = 0.29


def _calibrate_visual_similarity(similarity: float, model_id: str) -> float:
    if "siglip" in (model_id or "").lower():
        calibrated = _SIGLIP_SIM_CALIBRATION_GAIN * similarity + _SIGLIP_SIM_CALIBRATION_OFFSET
        return max(0.0, min(1.0, calibrated))
    return similarity


def _normalize_labeling_tier(value: Any) -> str | None:
    normalized = str(value or "").strip().lower()
    if normalized in {"tier2", "tier3"}:
        return normalized
    return None


def _deterministic_labeling_tier_bucket(provider_card_id: str, batch_id: str) -> int:
    digest = hashlib.sha256(f"{provider_card_id}|{batch_id}".encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % 100


def _sqlite_table_exists(connection: sqlite3.Connection, table_name: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        (table_name,),
    ).fetchone()
    return row is not None


def _sqlite_add_column_if_missing(
    connection: sqlite3.Connection,
    table_name: str,
    column_name: str,
    column_sql: str,
) -> None:
    if not _sqlite_table_exists(connection, table_name):
        return
    columns = {
        str(row["name"])
        for row in connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    }
    if column_name in columns:
        return
    connection.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_sql}")


def _apply_labeling_pipeline_schema_patch(connection: sqlite3.Connection) -> None:
    _sqlite_add_column_if_missing(connection, "labeling_sessions", "labeler_user_id", "TEXT")
    _sqlite_add_column_if_missing(connection, "labeling_sessions", "provider_card_id", "TEXT")
    _sqlite_add_column_if_missing(
        connection,
        "labeling_sessions",
        "tier_assignment",
        "TEXT CHECK(tier_assignment IN ('tier2', 'tier3'))",
    )
    _sqlite_add_column_if_missing(connection, "labeling_sessions", "routed_batch_id", "TEXT")
    _sqlite_add_column_if_missing(connection, "labeling_sessions", "first_capture_scan_id", "TEXT")
    _sqlite_add_column_if_missing(connection, "labeling_session_artifacts", "scan_id", "TEXT")
    _sqlite_add_column_if_missing(
        connection,
        "labeling_session_artifacts",
        "dataset_role",
        "TEXT CHECK(dataset_role IN ('tier2', 'tier3'))",
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_labeling_sessions_provider_card
        ON labeling_sessions(provider_card_id, created_at DESC)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_labeling_session_artifacts_scan_id
        ON labeling_session_artifacts(scan_id)
        """
    )


def _apply_sale_payment_schema_patch(connection: sqlite3.Connection) -> None:
    _sqlite_add_column_if_missing(connection, "sale_events", "paid_at", "TEXT")
    _sqlite_add_column_if_missing(connection, "sale_events", "voided_at", "TEXT")


def _apply_collections_redesign_schema_patch(connection: sqlite3.Connection) -> None:
    """Additive columns for the Collections-tab redesign (Frame 4/5).

    All columns are nullable and additive — no destructive changes. SQLite uses
    INTEGER for BIGINT and TEXT for both JSONB and TIMESTAMPTZ at the storage
    layer; the type names are kept for production-Postgres parity.
    """
    _sqlite_add_column_if_missing(connection, "deck_entries", "cost_basis_cents", "BIGINT")
    _sqlite_add_column_if_missing(connection, "deck_entries", "listing_url", "TEXT")
    _sqlite_add_column_if_missing(connection, "deck_entries", "listing_price_cents", "BIGINT")
    _sqlite_add_column_if_missing(connection, "deck_entries", "listed_at", "TIMESTAMPTZ")
    _sqlite_add_column_if_missing(connection, "sale_events", "cost_basis_per_unit_cents", "BIGINT")
    _sqlite_add_column_if_missing(connection, "sale_events", "profit_cents", "BIGINT")
    _sqlite_add_column_if_missing(connection, "sale_events", "last_listing_snapshot", "JSONB")


def _apply_since_added_baseline_schema_patch(connection: sqlite3.Connection) -> None:
    """Additive columns for the "Since you added it" display: the market price
    (and its date) the app showed for the entry's context on the day it was
    added. Written at insert time; historical rows are filled once by
    /api/v1/ops/backfill-added-baselines. The card_favorites twin columns live
    in `_apply_card_favorites_schema_patch`."""
    _sqlite_add_column_if_missing(connection, "deck_entries", "added_market_price", "REAL")
    _sqlite_add_column_if_missing(connection, "deck_entries", "added_market_date", "TEXT")


def _card_transactions_amount_cents_is_not_null(connection: sqlite3.Connection) -> bool:
    """True when the existing card_transactions.amount_cents column is NOT NULL.

    Older databases were created with ``amount_cents BIGINT NOT NULL``. SQLite
    cannot drop a column NOT NULL constraint in place, so detecting it lets us
    decide whether a one-time table rebuild is required to make price optional.
    """
    if not _sqlite_table_exists(connection, "card_transactions"):
        return False
    for row in connection.execute("PRAGMA table_info(card_transactions)").fetchall():
        if str(row["name"]) == "amount_cents":
            return bool(row["notnull"])
    return False


def _apply_card_transactions_schema_patch(connection: sqlite3.Connection) -> None:
    """Additive patch for the memory-bank ledger: optional price + item_count.

    - ``item_count`` is an additive NOT NULL column with a DEFAULT, so existing
      rows backfill to 1 via the standard ADD COLUMN idiom.
    - ``amount_cents`` becomes nullable. SQLite cannot relax a column's NOT NULL
      constraint with ALTER, so when an older NOT NULL definition is detected we
      rebuild the table once, copying every row through. New databases created
      from schema.sql already define the column as nullable and skip the rebuild.
    """
    if not _sqlite_table_exists(connection, "card_transactions"):
        return

    if _card_transactions_amount_cents_is_not_null(connection):
        # One-time rebuild to drop the NOT NULL on amount_cents. item_count is
        # included here so the rebuilt table matches the current schema in a
        # single pass; the ADD COLUMN below is then a no-op for this database.
        connection.execute("DROP TABLE IF EXISTS card_transactions__rebuild")
        connection.execute(
            """
            CREATE TABLE card_transactions__rebuild (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('bought','sold','traded')),
                amount_cents BIGINT,
                item_count INTEGER NOT NULL DEFAULT 1,
                currency_code TEXT NOT NULL DEFAULT 'USD',
                note TEXT,
                photo_object_path TEXT,
                photo_upload_status TEXT,
                photo_uploaded_at TEXT,
                photo_width INTEGER,
                photo_height INTEGER,
                image_url TEXT,
                occurred_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            INSERT INTO card_transactions__rebuild (
                id, owner_user_id, kind, amount_cents, currency_code, note,
                photo_object_path, photo_upload_status, photo_uploaded_at,
                photo_width, photo_height, occurred_at, created_at
            )
            SELECT
                id, owner_user_id, kind, amount_cents, currency_code, note,
                photo_object_path, photo_upload_status, photo_uploaded_at,
                photo_width, photo_height, occurred_at, created_at
            FROM card_transactions
            """
        )
        connection.execute("DROP TABLE card_transactions")
        connection.execute("ALTER TABLE card_transactions__rebuild RENAME TO card_transactions")
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_card_transactions_owner_occurred
            ON card_transactions (owner_user_id, occurred_at DESC, id DESC)
            """
        )

    # Databases that were already nullable (incl. fresh ones) still need the
    # additive item_count column backfilled here.
    _sqlite_add_column_if_missing(
        connection, "card_transactions", "item_count", "INTEGER NOT NULL DEFAULT 1"
    )
    # Optional catalog image URL for the sold/bought/traded card. Additive,
    # nullable; existing rows backfill to NULL.
    _sqlite_add_column_if_missing(
        connection, "card_transactions", "image_url", "TEXT"
    )
    # Optional payment method (cash/venmo/cashapp/paypal/zelle/other). Additive,
    # nullable; existing rows backfill to NULL.
    _sqlite_add_column_if_missing(
        connection, "card_transactions", "payment_method", "TEXT"
    )


def _apply_card_favorites_schema_patch(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS card_favorites (
            owner_user_id TEXT NOT NULL,
            card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (owner_user_id, card_id)
        )
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_card_favorites_owner_user_id
        ON card_favorites(owner_user_id, created_at DESC, card_id)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_card_favorites_card_id
        ON card_favorites(card_id, created_at DESC)
        """
    )
    # "Since you added it" baseline for wishlist rows: the market price the app
    # displayed for the card on the day it was favorited (uniform baseline; NOT
    # cost basis). Written on the favorite INSERT; historical rows are filled
    # once by /api/v1/ops/backfill-added-baselines.
    _sqlite_add_column_if_missing(connection, "card_favorites", "added_market_price", "REAL")
    _sqlite_add_column_if_missing(connection, "card_favorites", "added_market_date", "TEXT")


def _apply_card_likes_schema_patch(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS card_likes (
            owner_user_id TEXT NOT NULL,
            card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (owner_user_id, card_id)
        )
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_card_likes_owner_user_id
        ON card_likes(owner_user_id, created_at DESC, card_id)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_card_likes_card_id
        ON card_likes(card_id, created_at DESC)
        """
    )


def _apply_price_history_cells_schema_patch(connection: sqlite3.Connection) -> None:
    """Additive, reversible Phase 1 of the price-history normalization
    (docs/price-history-normalization-migration-plan-2026-06-09.md).

    Creates the normalized ``card_price_history_cell`` table — one tiny row per
    price cell ``(card, date, lane, variant, condition | grader, grade)`` — plus
    its read indexes. The JSON columns on ``card_price_history_daily`` are
    untouched and remain the source of truth.

    CRASH-LOOP GUARD: only do this when the table is ABSENT (a fresh DB). NEVER
    build indexes at startup on an existing table — a populated cell table's index
    build can exceed the systemd service start timeout and crash-loop the backend
    (this happened 2026-06-10). Backfills/migrations own indexing on an existing
    table; this patch only bootstraps a fresh DB. Reversible via DROP TABLE.
    """
    if _sqlite_table_exists(connection, "card_price_history_cell"):
        return
    # Regular rowid table (NOT `WITHOUT ROWID`): inserts append to the rowid heap
    # regardless of arrival order, so the daily dual-write and the one-time backfill
    # never pay clustered-B-tree page-split costs that compound as the table grows.
    # Identity is enforced by a separate UNIQUE index (so a bulk backfill can drop
    # it, load, and rebuild). Read paths are served by the lookup indexes below.
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS card_price_history_cell (
            card_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            price_date TEXT NOT NULL,
            lane TEXT NOT NULL,
            cell_key TEXT NOT NULL,
            variant_key TEXT,
            condition TEXT,
            grader TEXT,
            grade TEXT,
            is_perfect INTEGER NOT NULL DEFAULT 0,
            is_signed INTEGER NOT NULL DEFAULT 0,
            is_error INTEGER NOT NULL DEFAULT 0,
            currency_code TEXT,
            low REAL,
            market REAL,
            mid REAL,
            high REAL,
            direct_low REAL,
            trend REAL,
            updated_at TEXT NOT NULL
        )
        """
    )
    # Identity: dedupe target for the dual-write/backfill upsert; its (card_id,
    # price_date) prefix also serves the dashboard fan and the dual-write's
    # per-(card,date) delete.
    connection.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cell_identity
        ON card_price_history_cell (card_id, price_date, cell_key)
        """
    )
    # Raw-lane holding lookup: a card's condition history over a date window.
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_cell_raw_lookup
        ON card_price_history_cell (card_id, variant_key, condition, price_date)
        WHERE lane = 'raw'
        """
    )
    # Graded-lane holding lookup: a card's grader/grade history over a window.
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_cell_graded_lookup
        ON card_price_history_cell (card_id, grader, grade, variant_key, price_date)
        WHERE lane = 'graded'
        """
    )
    # Date-scoped cell lookups (day-over-day diffs, condition-history series).
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_cell_date
        ON card_price_history_cell (price_date)
        """
    )
    # Price-trend COVERING index: serves the projected single-card trend read
    # (`price_history_cell_trend_rows_by_date`, catalog_tools.py) INDEX-ONLY —
    # the leading (card_id, provider, price_date) satisfies the WHERE, and the
    # trailing columns supply every projected field, avoiding the scattered cold
    # table-row fetches that dominate a card's first PDP open (~1.3s cold → ~1ms).
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_cell_trend_market
        ON card_price_history_cell (
            card_id, provider, price_date, lane, grader, grade, variant_key,
            condition, is_perfect, is_signed, is_error, market
        )
        """
    )


def _apply_scan_labeling_reviews_schema_patch(connection: sqlite3.Connection) -> None:
    """Idempotently ensure the friend-reviewer labels table exists.

    schema.sql also creates this table, but that only runs for the configured
    schema_path on bootstrap; existing staging databases get the additive table
    here on every startup the same way other patches do.
    """
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS scan_labeling_reviews (
            id TEXT PRIMARY KEY,
            scan_id TEXT NOT NULL,
            reviewer_user_id TEXT NOT NULL,
            reviewer_role TEXT NOT NULL,
            labeled_card_id TEXT,
            label_disposition TEXT NOT NULL,
            selected_rank INTEGER,
            was_top_prediction INTEGER,
            notes TEXT,
            queue_id TEXT,
            created_at TEXT NOT NULL,
            labeled_variant TEXT,
            UNIQUE(scan_id, reviewer_user_id)
        )
        """
    )
    # Additive: existing staging DBs predate the labeled_variant column (the
    # holo-finish a reviewer picked, e.g. pokeBallReverseHolofoil).
    existing_columns = {
        str(row[1])
        for row in connection.execute("PRAGMA table_info(scan_labeling_reviews)").fetchall()
    }
    if "labeled_variant" not in existing_columns:
        connection.execute("ALTER TABLE scan_labeling_reviews ADD COLUMN labeled_variant TEXT")
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_scan_labeling_reviews_scan_id
        ON scan_labeling_reviews(scan_id, label_disposition)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_scan_labeling_reviews_reviewer
        ON scan_labeling_reviews(reviewer_user_id, created_at DESC)
        """
    )


def _apply_access_gate_schema_patch(connection: sqlite3.Connection) -> None:
    """Additive tables for the public-App-Store ACCESS GATE.

    - ``access_grants`` records a per-account redeemed-invite-code grant so that a
      whitelisted/invited user keeps access across sessions even when the card-show
      gate is closed.
    - ``access_waitlist`` captures early-access email sign-ups from blocked users.

    Both are additive and reversible (DROP TABLE). schema.sql also creates them for
    fresh databases; this patch backfills existing staging DBs on startup the same
    way the other patches do.
    """
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS access_grants (
            user_id TEXT PRIMARY KEY,
            email TEXT,
            granted_via TEXT,
            granted_at TEXT
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS access_waitlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT,
            user_id TEXT,
            created_at TEXT
        )
        """
    )
    # Local mirror of Supabase emails (we only get them live from the JWT).
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS user_emails (
            user_id TEXT PRIMARY KEY,
            email TEXT,
            updated_at TEXT
        )
        """
    )

    # One-time backfill: grant every EXISTING user (anyone who already has data in
    # the app) persistent access, so current users aren't locked out when the gate
    # goes live. Guarded by a runtime flag so it runs exactly once — later manual
    # revokes stick, and it never re-grants on subsequent startups. The backend
    # only knows users by Supabase user_id (no stored emails), so the whitelist is
    # by user_id. Wrapped defensively so a fresh DB (tables not yet populated)
    # never breaks startup.
    try:
        already = runtime_setting(connection, "access_existing_users_backfilled")
        if already is None:
            now_iso = datetime.now(timezone.utc).isoformat()
            rows = connection.execute(
                """
                SELECT DISTINCT owner_user_id FROM (
                    SELECT owner_user_id FROM deck_entries
                    UNION SELECT owner_user_id FROM scan_events
                    UNION SELECT owner_user_id FROM sale_events
                    UNION SELECT owner_user_id FROM card_favorites
                )
                WHERE owner_user_id IS NOT NULL AND TRIM(owner_user_id) != ''
                """
            ).fetchall()
            for row in rows:
                uid = str(row[0] or "").strip()
                if not uid:
                    continue
                connection.execute(
                    """
                    INSERT OR IGNORE INTO access_grants
                        (user_id, email, granted_via, granted_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (uid, None, "existing_user_backfill", now_iso),
                )
            upsert_runtime_setting(
                connection,
                key="access_existing_users_backfilled",
                value={"at": now_iso, "count": len(rows)},
            )
            connection.commit()
    except sqlite3.OperationalError:
        # A user-data table doesn't exist yet (fresh DB / patch ordering) — nothing
        # to backfill. The flag stays unset so it can run once data tables exist.
        pass


def _env_flag(name: str, *, default: bool = False) -> bool:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    return str(raw_value).strip().lower() in {"1", "true", "yes", "on"}


# The "Scanning for" EN/JP toggle hard-filters the raw-visual candidate list so
# the headline pick can never be the wrong language. That filter, however, also
# deletes the *actually scanned* card when the user has the wrong toggle on,
# leaving it unreachable. When this flag is on we keep the toggle-language pick
# as top-1 (ranking unchanged) but append the top 1-2 other-language matches to
# the TAIL of the candidate list so a "Switch" can still reach the real card.
# Default ON; set to a falsey value ("0"/"false"/"off") to restore the strict
# hard-filter behavior.
SCAN_KEEP_CROSSLANG_CANDIDATES_ENV = "SCAN_KEEP_CROSSLANG_CANDIDATES"
SCAN_KEEP_CROSSLANG_CANDIDATES_MAX = 2


def scan_keep_crosslang_candidates_enabled() -> bool:
    """True when the raw-visual lane should append other-language matches to the
    tail of the candidate list (so the actually-scanned card stays reachable as a
    "Switch"). Default on; disable with a falsey ``SCAN_KEEP_CROSSLANG_CANDIDATES``."""
    return _env_flag(SCAN_KEEP_CROSSLANG_CANDIDATES_ENV, default=True)


# Startup portfolio-dashboard prewarm: after a reboot the OS page cache is empty
# and the multi-GB DB sits on a slow disk, so the first dashboard refresh cold-
# reads owner rows and can exceed the client timeout. We proactively warm each
# active owner's dashboard at boot (see prewarm_portfolio_dashboards).
# "Since you added it" row sparklines: 30-day window, downsampled to <=20
# points per row, and a per-page context budget — pages needing more than this
# many history contexts skip sparklines for the overflow rows (the sinceAdded
# pill fields are never truncated).
SINCE_ADDED_SPARK_DAYS = 30
SINCE_ADDED_SPARK_POINTS = 20
SINCE_ADDED_SPARK_MAX_CONTEXTS = 800
# One-shot guard flag for /api/v1/ops/backfill-added-baselines (mirrors
# access_existing_users_backfilled).
ADDED_BASELINE_BACKFILL_FLAG = "added_baseline_backfilled"

PORTFOLIO_DASHBOARD_PREWARM_ENV = "PORTFOLIO_DASHBOARD_PREWARM"
PORTFOLIO_DASHBOARD_PREWARM_MAX_OWNERS_ENV = "PORTFOLIO_DASHBOARD_PREWARM_MAX_OWNERS"
PORTFOLIO_DASHBOARD_PREWARM_DELAY_ENV = "PORTFOLIO_DASHBOARD_PREWARM_DELAY_SECONDS"
DEFAULT_PORTFOLIO_DASHBOARD_PREWARM_MAX_OWNERS = 50
DEFAULT_PORTFOLIO_DASHBOARD_PREWARM_DELAY_SECONDS = 3.0


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8788


class SpotlightThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True


@dataclass(frozen=True)
class SlabMatchEvidence:
    title_text_primary: str
    title_text_secondary: str
    label_text: str
    parsed_label_text: tuple[str, ...]
    card_number: str | None
    language_hint: str | None
    set_hint_tokens: tuple[str, ...]
    matched_set_alias: str | None
    set_hint_source: str | None
    variant_hints: dict[str, Any]
    grader: str | None
    grade: str | None
    cert_number: str | None
    recommended_lookup_path: str | None
    cross_language_set_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class PricingContext:
    mode: str
    grader: str | None = None
    grade: str | None = None
    cert_number: str | None = None
    preferred_variant: str | None = None
    preferred_condition: str | None = None
    variant_hints: dict[str, Any] | None = None

    @property
    def is_graded(self) -> bool:
        return self.mode == "graded"


@dataclass(frozen=True)
class CandidateRankPricingRule:
    rank: int
    ensure_cached: bool = False
    refresh_stale: bool = False
    refresh_missing: bool = False
    force_show_mode_refresh: bool = False


@dataclass(frozen=True)
class PricingLoadPolicy:
    limit: int
    rank_rules: tuple[CandidateRankPricingRule, ...]

    @classmethod
    def top_ten_cached_only(cls) -> "PricingLoadPolicy":
        return cls(
            limit=10,
            rank_rules=(
                CandidateRankPricingRule(rank=1),
                CandidateRankPricingRule(rank=2),
                CandidateRankPricingRule(rank=3),
                CandidateRankPricingRule(rank=4),
                CandidateRankPricingRule(rank=5),
                CandidateRankPricingRule(rank=6),
                CandidateRankPricingRule(rank=7),
                CandidateRankPricingRule(rank=8),
                CandidateRankPricingRule(rank=9),
                CandidateRankPricingRule(rank=10),
            ),
        )

    @classmethod
    def top_ten_refresh_top_one(
        cls,
        *,
        refresh_top_candidate_stale: bool,
        refresh_top_candidate_missing: bool,
        force_show_mode_top_candidate_refresh: bool = False,
    ) -> "PricingLoadPolicy":
        return cls.top_ten_live_refresh(
            refresh_stale=refresh_top_candidate_stale,
            refresh_missing=refresh_top_candidate_missing,
            force_show_mode_refresh=force_show_mode_top_candidate_refresh,
        )

    @classmethod
    def top_ten_live_refresh(
        cls,
        *,
        refresh_stale: bool,
        refresh_missing: bool,
        force_show_mode_refresh: bool = False,
    ) -> "PricingLoadPolicy":
        return cls(
            limit=10,
            rank_rules=tuple(
                CandidateRankPricingRule(
                    rank=index,
                    refresh_stale=refresh_stale,
                    refresh_missing=refresh_missing,
                    force_show_mode_refresh=force_show_mode_refresh,
                )
                for index in range(1, 11)
            ),
        )

    def rule_for_rank(self, rank: int) -> CandidateRankPricingRule:
        for rule in self.rank_rules:
            if rule.rank == rank:
                return rule
        return CandidateRankPricingRule(rank=rank)


@dataclass(frozen=True)
class CandidateEncodingItem:
    card: dict[str, Any]
    image_score: float
    collector_number_score: float
    name_score: float
    final_score: float
    reasons: tuple[str, ...]
    scored_fields: dict[str, Any] | None = None


@dataclass
class PendingVisualScan:
    scan_id: str
    owner_user_id: str
    created_at: float
    visual_matches: list[Any]
    visual_debug: dict[str, Any]
    requested_top_k: int
    visual_match_ms: float


class SpotlightScanService:
    def __init__(self, database_path: Path, repo_root: Path) -> None:
        self.database_path = database_path
        self.repo_root = repo_root
        self._thread_local = threading.local()
        self._state_lock = threading.RLock()
        supabase_url = os.environ.get(SUPABASE_URL_ENV) or os.environ.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL")
        supabase_jwks_url = os.environ.get(SUPABASE_JWKS_URL_ENV) or os.environ.get("SPOTLIGHT_SUPABASE_JWKS_URL")
        supabase_jwt_secret = (
            os.environ.get(SUPABASE_JWT_SECRET_ENV) or os.environ.get("SPOTLIGHT_SUPABASE_JWT_SECRET")
        )
        auth_required = _env_flag(AUTH_REQUIRED_ENV, default=False)
        fallback_user_id = (
            os.environ.get(AUTH_FALLBACK_USER_ID_ENV)
            or ("local-dev-user" if not auth_required else None)
        )
        self.authenticator = SupabaseRequestAuthenticator(
            supabase_url=supabase_url,
            jwks_url=supabase_jwks_url,
            jwt_secret=supabase_jwt_secret,
            auth_required=auth_required,
            fallback_user_id=fallback_user_id,
        )
        bootstrap_connection = connect(database_path)
        try:
            _apply_labeling_pipeline_schema_patch(bootstrap_connection)
            _apply_card_favorites_schema_patch(bootstrap_connection)
            _apply_card_likes_schema_patch(bootstrap_connection)
            _apply_sale_payment_schema_patch(bootstrap_connection)
            _apply_collections_redesign_schema_patch(bootstrap_connection)
            _apply_since_added_baseline_schema_patch(bootstrap_connection)
            _apply_card_transactions_schema_patch(bootstrap_connection)
            _apply_scan_labeling_reviews_schema_patch(bootstrap_connection)
            _apply_price_history_cells_schema_patch(bootstrap_connection)
            _apply_access_gate_schema_patch(bootstrap_connection)
            bootstrap_connection.commit()
            self.index = load_index(bootstrap_connection)
        finally:
            bootstrap_connection.close()
        self._card_lookup_cache: dict[str, dict[str, Any] | None] = {}
        self._raw_visual_matcher: Any | None = None
        self._pending_visual_scans: dict[str, PendingVisualScan] = {}
        self._pending_visual_scan_ttl_seconds: float = 90.0
        # Per-owner portfolio-dashboard cache (version-keyed, auto-invalidating)
        # + per-owner dogpile locks so a concurrent burst computes once. Guarded
        # by a single lock since the maps are touched from request threads.
        self._dashboard_cache: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}
        self._dashboard_cache_locks: dict[tuple[str, str], threading.Lock] = {}
        self._dashboard_cache_locks_guard = threading.Lock()
        self._dashboard_cache_max_entries = 256
        # Per-owner deck-entries cache, same version-token + dogpile pattern as
        # the dashboard cache above. deck_entries recomputes ~1s of per-card
        # pricing on EVERY Collection view; uncached, ~30 concurrent browsers
        # saturate the heavy-read slots and shed 503s (load-tested 2026-07-05).
        self._deck_entries_cache: dict[tuple[Any, ...], tuple[str, dict[str, Any]]] = {}
        self._deck_entries_cache_locks: dict[tuple[Any, ...], threading.Lock] = {}
        self._deck_entries_cache_max_entries = 512
        self.artifact_store = build_scan_artifact_store(
            repo_root=repo_root,
            storage_override=os.environ.get(SCAN_ARTIFACTS_STORAGE_ENV),
            root_override=os.environ.get(SCAN_ARTIFACTS_ROOT_ENV),
            gcs_bucket_override=os.environ.get(SCAN_ARTIFACTS_GCS_BUCKET_ENV),
        )

        self.pricing_registry = PricingProviderRegistry()
        self.pricing_registry.register(ScrydexProvider())
        self.pricing_registry.register(PriceChartingProvider())
        self._emit_structured_log(
            {
                "severity": "INFO",
                "event": "scan_artifact_store_config",
                "databasePath": str(self.database_path),
                "scanArtifactUploads": self._scan_artifact_uploads_state(),
            }
        )

    @property
    def connection(self) -> sqlite3.Connection:
        connection = getattr(self._thread_local, "connection", None)
        if connection is None:
            connection = connect(self.database_path)
            self._thread_local.connection = connection
        return connection

    def _new_connection(self) -> sqlite3.Connection:
        return connect(self.database_path)

    @contextmanager
    def request_identity_context(self, identity: RequestIdentity | None):
        previous_identity = getattr(self._thread_local, "request_identity", None)
        if identity is None:
            if hasattr(self._thread_local, "request_identity"):
                delattr(self._thread_local, "request_identity")
        else:
            self._thread_local.request_identity = identity
        try:
            yield
        finally:
            if previous_identity is None:
                if hasattr(self._thread_local, "request_identity"):
                    delattr(self._thread_local, "request_identity")
            else:
                self._thread_local.request_identity = previous_identity

    def _current_request_identity(self) -> RequestIdentity:
        identity = getattr(self._thread_local, "request_identity", None)
        if isinstance(identity, RequestIdentity):
            return identity
        if self.authenticator.auth_required:
            raise RequestAuthError("Authenticated request identity is required.")
        fallback_user_id = self.authenticator.fallback_user_id
        if fallback_user_id:
            return RequestIdentity(user_id=fallback_user_id, auth_source="service_fallback")
        raise RequestAuthError("Authenticated request identity is required.")

    def _current_owner_user_id(self) -> str:
        return self._current_request_identity().user_id

    @staticmethod
    def _labeling_scan_id(session_id: str, angle_index: int) -> str:
        return f"labeling-scan:{session_id}:{int(angle_index):02d}"

    def _assert_labeling_session_owner(self, row: sqlite3.Row, owner_user_id: str) -> None:
        session_owner_user_id = str(row["labeler_user_id"] or "").strip()
        if session_owner_user_id and session_owner_user_id != owner_user_id:
            raise FileNotFoundError("labeling session not found")

    @staticmethod
    def _labeling_batch_config() -> tuple[str, int]:
        configured_batch_id = str(os.environ.get(LABELING_ACTIVE_BATCH_ID_ENV) or "").strip()
        batch_id = configured_batch_id or f"labeling-auto-{datetime.now(timezone.utc).strftime('%Y%m%d')}"
        tier2_pct_raw = str(os.environ.get(LABELING_TIER2_PERCENT_ENV) or "").strip()
        try:
            tier2_pct = int(tier2_pct_raw) if tier2_pct_raw else DEFAULT_LABELING_TIER2_PERCENT
        except ValueError:
            tier2_pct = DEFAULT_LABELING_TIER2_PERCENT
        return batch_id, max(0, min(100, tier2_pct))

    def _load_labeling_registry(self) -> dict[str, Any]:
        path = _default_labeling_registry_path()
        if not path.exists():
            return {
                "schemaVersion": LABELING_REGISTRY_SCHEMA_VERSION,
                "updatedAt": None,
                "providerCards": {},
                "entries": [],
            }
        try:
            payload = json.loads(path.read_text())
        except Exception:  # noqa: BLE001
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        provider_cards = payload.get("providerCards")
        if not isinstance(provider_cards, dict):
            provider_cards = {}
        entries = payload.get("entries")
        if not isinstance(entries, list):
            entries = []
        return {
            "schemaVersion": max(int(payload.get("schemaVersion") or 1), LABELING_REGISTRY_SCHEMA_VERSION),
            "updatedAt": payload.get("updatedAt"),
            "providerCards": provider_cards,
            "entries": entries,
        }

    def _save_labeling_registry(self, payload: dict[str, Any]) -> None:
        path = _default_labeling_registry_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload["schemaVersion"] = LABELING_REGISTRY_SCHEMA_VERSION
        payload["updatedAt"] = utc_now()
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")

    def _route_labeling_provider_card(
        self,
        *,
        provider_card_id: str,
        first_scan_id: str,
        labeling_session_id: str,
        source_type: str,
    ) -> tuple[str, str]:
        batch_id, tier2_pct = self._labeling_batch_config()
        with self._state_lock:
            registry = self._load_labeling_registry()
            provider_cards = registry.setdefault("providerCards", {})
            existing = provider_cards.get(provider_card_id)
            existing_tier = _normalize_labeling_tier(existing.get("tier")) if isinstance(existing, dict) else None
            if existing_tier:
                existing_batch_id = str(existing.get("firstSeenBatchId") or "").strip() or batch_id
                return existing_tier, existing_batch_id

            bucket = _deterministic_labeling_tier_bucket(provider_card_id, batch_id)
            tier = "tier2" if bucket < tier2_pct else "tier3"
            provider_cards[provider_card_id] = {
                "providerCardId": provider_card_id,
                "tier": tier,
                "firstSeenScanId": first_scan_id,
                "firstSeenBatchId": batch_id,
                "firstSeenSource": source_type,
                "firstSeenLabelingSessionId": labeling_session_id,
                "assignedTierAt": utc_now(),
            }
            self._save_labeling_registry(registry)
            return tier, batch_id

    def _owned_deck_entry_row_by_reference(self, deck_entry_reference: str) -> sqlite3.Row | None:
        normalized_reference = str(deck_entry_reference or "").strip()
        if not normalized_reference:
            return None
        owner_user_id = self._current_owner_user_id()
        return self.connection.execute(
            """
            SELECT *
            FROM deck_entries
            WHERE owner_user_id = ?
              AND (id = ? OR identity_key = ?)
            ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
            LIMIT 1
            """,
            (owner_user_id, normalized_reference, normalized_reference, normalized_reference),
        ).fetchone()

    def _resolve_owned_deck_entry_id(
        self,
        *,
        card_id: str,
        grader: str | None = None,
        grade: str | None = None,
        cert_number: str | None = None,
        variant_name: str | None = None,
        condition: str | None = None,
    ) -> str | None:
        owner_user_id = self._current_owner_user_id()
        identity_key = deck_entry_storage_key(
            card_id=card_id,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            variant_name=variant_name,
            condition=condition,
        )
        row = self.connection.execute(
            """
            SELECT id
            FROM deck_entries
            WHERE owner_user_id = ?
              AND identity_key = ?
            LIMIT 1
            """,
            (owner_user_id, identity_key),
        ).fetchone()
        return str(row["id"] or "").strip() or None if row is not None else None

    def _optional_owner_user_id(self) -> str | None:
        try:
            return self._current_owner_user_id()
        except RequestAuthError:
            return None

    def _favorite_row(self, card_id: str, *, owner_user_id: str | None) -> sqlite3.Row | None:
        normalized_owner_user_id = str(owner_user_id or "").strip()
        normalized_card_id = str(card_id or "").strip()
        if not normalized_owner_user_id or not normalized_card_id:
            return None
        return self.connection.execute(
            """
            SELECT owner_user_id, card_id, created_at, added_market_price, added_market_date
            FROM card_favorites
            WHERE owner_user_id = ?
              AND card_id = ?
            LIMIT 1
            """,
            (normalized_owner_user_id, normalized_card_id),
        ).fetchone()

    def _favorite_rows_by_card_id(
        self,
        card_ids: list[Any],
        *,
        owner_user_id: str | None,
    ) -> dict[str, sqlite3.Row]:
        normalized_owner_user_id = str(owner_user_id or "").strip()
        normalized_card_ids = self._normalized_unique_card_ids(card_ids)
        if not normalized_owner_user_id or not normalized_card_ids:
            return {}
        placeholders = ",".join("?" for _ in normalized_card_ids)
        rows = self.connection.execute(
            f"""
            SELECT card_id, created_at
            FROM card_favorites
            WHERE owner_user_id = ?
              AND card_id IN ({placeholders})
            """,
            (normalized_owner_user_id, *normalized_card_ids),
        ).fetchall()
        return {
            str(row["card_id"] or "").strip(): row
            for row in rows
            if str(row["card_id"] or "").strip()
        }

    @staticmethod
    def _favorite_state_payload(card_id: str, favorite_row: sqlite3.Row | None) -> dict[str, Any]:
        return {
            "cardID": card_id,
            "isFavorite": favorite_row is not None,
            "favoritedAt": favorite_row["created_at"] if favorite_row is not None else None,
        }

    @classmethod
    def _favorite_context_payload(
        cls,
        favorite_row: sqlite3.Row | None,
        pricing: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        """PDP "since wishlisted" context: the requester's favorite-day baseline
        vs the detail's already-resolved display pricing. None when the
        requester has not favorited the card; a NULL stored baseline keeps
        favoritedAt but yields all-None arithmetic (mirrors the favorites list
        serializer)."""
        if favorite_row is None:
            return None
        since_added_amount, since_added_percent, since_added_baseline_date = (
            cls._since_added_change(
                baseline_price=favorite_row["added_market_price"],
                baseline_date=favorite_row["added_market_date"],
                current_price=cls._history_primary_price_value(pricing),
            )
        )
        return {
            "favoritedAt": favorite_row["created_at"],
            "sinceAddedChangeAmount": since_added_amount,
            "sinceAddedChangePercent": since_added_percent,
            "sinceAddedBaselineDate": since_added_baseline_date,
        }

    def _like_row(self, card_id: str, *, owner_user_id: str | None) -> sqlite3.Row | None:
        normalized_owner_user_id = str(owner_user_id or "").strip()
        normalized_card_id = str(card_id or "").strip()
        if not normalized_owner_user_id or not normalized_card_id:
            return None
        return self.connection.execute(
            """
            SELECT owner_user_id, card_id, created_at
            FROM card_likes
            WHERE owner_user_id = ?
              AND card_id = ?
            LIMIT 1
            """,
            (normalized_owner_user_id, normalized_card_id),
        ).fetchone()

    @staticmethod
    def _like_state_payload(card_id: str, like_row: sqlite3.Row | None) -> dict[str, Any]:
        return {
            "cardID": card_id,
            "isLiked": like_row is not None,
            "likedAt": like_row["created_at"] if like_row is not None else None,
        }

    def _card_like_count(self, card_id: str) -> int:
        """Public like count == number of users who LIKED this card (card_likes —
        the PDP heart), distinct from the wishlist (card_favorites)."""
        normalized_card_id = str(card_id or "").strip()
        if not normalized_card_id:
            return 0
        row = self.connection.execute(
            "SELECT COUNT(*) FROM card_likes WHERE card_id = ?",
            (normalized_card_id,),
        ).fetchone()
        return int(row[0]) if row else 0

    def _card_population(self, card_id: str) -> dict[str, Any]:
        """GemRate population for this card, keyed by grader (PSA/BGS/CGC/SGC). Empty
        dict when none is synced. Populated by the PPT population overlay; read-only
        metadata that never affects a displayed price."""
        normalized_card_id = str(card_id or "").strip()
        if not normalized_card_id:
            return {}
        row = self.connection.execute(
            "SELECT population_json FROM card_price_snapshots WHERE card_id = ? LIMIT 1",
            (normalized_card_id,),
        ).fetchone()
        if not row or not row[0]:
            return {}
        try:
            parsed = json.loads(row[0])
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def _card_watcher_count(self, card_id: str) -> int:
        """Distinct viewers of this card within the rolling watcher window."""
        normalized_card_id = str(card_id or "").strip()
        if not normalized_card_id:
            return 0
        cutoff = (
            datetime.now(timezone.utc) - timedelta(days=CARD_WATCHER_WINDOW_DAYS)
        ).isoformat()
        row = self.connection.execute(
            """
            SELECT COUNT(DISTINCT owner_user_id)
            FROM card_views
            WHERE card_id = ?
              AND viewed_at >= ?
            """,
            (normalized_card_id, cutoff),
        ).fetchone()
        return int(row[0]) if row else 0

    def _record_card_view(self, card_id: str, *, owner_user_id: str | None) -> None:
        """Log a passive card view, deduped to one row per (user, card, UTC day).

        Best-effort: a view that fails to persist must never break the detail
        fetch, so failures are swallowed.
        """
        normalized_owner_user_id = str(owner_user_id or "").strip()
        normalized_card_id = str(card_id or "").strip()
        if not normalized_owner_user_id or not normalized_card_id:
            return
        now = utc_now()
        viewed_on = now[:10]  # YYYY-MM-DD bucket for daily dedupe
        try:
            self.connection.execute(
                """
                INSERT INTO card_views (owner_user_id, card_id, viewed_on, viewed_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(owner_user_id, card_id, viewed_on)
                DO UPDATE SET viewed_at = excluded.viewed_at
                """,
                (normalized_owner_user_id, normalized_card_id, viewed_on, now),
            )
            self.connection.commit()
        except sqlite3.Error:
            try:
                self.connection.rollback()
            except sqlite3.Error:
                pass

    def _card_counterpart(self, card_id: str) -> sqlite3.Row | None:
        """The other-language counterpart for this card, or None when unlinked.

        Backed by card_language_links (built offline). Absence of a row is the
        normal case — the PDP hides the EN/JP toggle when there is no counterpart.
        """
        normalized_card_id = str(card_id or "").strip()
        if not normalized_card_id:
            return None
        return self.connection.execute(
            """
            SELECT counterpart_card_id, counterpart_language
            FROM card_language_links
            WHERE card_id = ?
            LIMIT 1
            """,
            (normalized_card_id,),
        ).fetchone()

    def refresh_index(self) -> None:
        connection = self._new_connection()
        try:
            index = load_index(connection)
        finally:
            connection.close()
        with self._state_lock:
            self.index = index
            self._card_lookup_cache.clear()

    def _raw_visual_matcher_instance(self) -> Any:
        with self._state_lock:
            if self._raw_visual_matcher is None:
                from raw_visual_matcher import RawVisualMatcher

                self._raw_visual_matcher = RawVisualMatcher(repo_root=self.repo_root)
            return self._raw_visual_matcher

    def refresh_visual_index(self, *, dry_run: bool = False, max_cards: int | None = None) -> dict[str, Any]:
        """Embed catalog cards missing from the visual index, append them, and
        hot-reload — so new Scrydex sets become scannable without a full rebuild
        or a backend restart. Reuses the already-loaded encoder + adapter."""
        from visual_index_incremental import run_refresh

        matcher = self._raw_visual_matcher_instance()

        def _logger(severity: str, message: str) -> None:
            self._emit_structured_log(
                {"severity": severity, "event": "visual_index_refresh", "message": message}
            )

        return run_refresh(
            index=matcher.index,
            connection=self.connection,
            embed_images_fn=matcher.embed_reference_images,
            model_id=matcher.model_id,
            dry_run=dry_run,
            max_cards=max_cards,
            logger=_logger,
        )

    def _prune_pending_visual_scans(self) -> None:
        cutoff = perf_counter() - self._pending_visual_scan_ttl_seconds
        with self._state_lock:
            for scan_id, pending in list(self._pending_visual_scans.items()):
                if pending.created_at < cutoff:
                    self._pending_visual_scans.pop(scan_id, None)

    def _store_pending_visual_scan(
        self,
        *,
        scan_id: str,
        visual_matches: list[Any],
        visual_debug: dict[str, Any],
        requested_top_k: int,
        visual_match_ms: float,
    ) -> None:
        scan_id = str(scan_id or "").strip()
        if not scan_id:
            return
        owner_user_id = self._current_owner_user_id()
        pending = PendingVisualScan(
            scan_id=scan_id,
            owner_user_id=owner_user_id,
            created_at=perf_counter(),
            visual_matches=list(visual_matches),
            visual_debug=dict(visual_debug or {}),
            requested_top_k=max(1, int(requested_top_k)),
            visual_match_ms=float(visual_match_ms),
        )
        with self._state_lock:
            self._prune_pending_visual_scans()
            self._pending_visual_scans[scan_id] = pending

    def _pending_visual_scan(self, scan_id: str, *, owner_user_id: str | None = None) -> PendingVisualScan | None:
        scan_id = str(scan_id or "").strip()
        if not scan_id:
            return None
        with self._state_lock:
            self._prune_pending_visual_scans()
            pending = self._pending_visual_scans.get(scan_id)
        if pending is not None and owner_user_id is not None and pending.owner_user_id != owner_user_id:
            return None
        if pending is None:
            return None
        return pending

    def _take_pending_visual_scan(self, scan_id: str, *, owner_user_id: str | None = None) -> PendingVisualScan | None:
        scan_id = str(scan_id or "").strip()
        if not scan_id:
            return None
        with self._state_lock:
            self._prune_pending_visual_scans()
            pending = self._pending_visual_scans.get(scan_id)
            if pending is not None and owner_user_id is not None and pending.owner_user_id != owner_user_id:
                pending = None
            elif pending is not None:
                self._pending_visual_scans.pop(scan_id, None)
        if pending is None:
            return None
        return pending

    def _clear_pending_visual_scan(self, scan_id: str) -> None:
        scan_id = str(scan_id or "").strip()
        if scan_id:
            with self._state_lock:
                self._pending_visual_scans.pop(scan_id, None)

    def _run_raw_visual_phase(
        self,
        payload: dict[str, Any],
        *,
        requested_top_k: int,
    ) -> tuple[list[Any], dict[str, Any], float, list[Any]]:
        started_at = perf_counter()
        # The "Scanning for" language toggle is authoritative for the raw lane:
        # a raw EN toggle must never surface a JP candidate/top-1 and vice versa.
        # Over-fetch when a toggle is active so language filtering can't starve
        # the shortlist of correct-language candidates, then trim back.
        scan_language = self._explicit_scan_language(payload)
        fetch_top_k = requested_top_k * 3 if scan_language else requested_top_k
        all_matches, debug = self._raw_visual_matcher_instance().match_payload(payload, top_k=fetch_top_k)
        all_matches = list(all_matches)
        # The toggle-language matches drive ranking / top-1 exactly as before.
        matches = self._filter_visual_matches_by_scan_language(all_matches, scan_language)[:requested_top_k]
        # ALSO surface the top other-language matches that the hard filter just
        # dropped. These never enter ranking or the decision; the response builder
        # only appends them to the TAIL of the candidate list so the actually-
        # scanned card stays reachable as a "Switch". Highest similarity first is
        # preserved by `match_payload`'s ordering (all_matches is already ranked).
        other_language_matches: list[Any] = []
        if scan_language in ("english", "japanese") and scan_keep_crosslang_candidates_enabled():
            want_japanese = scan_language == "japanese"
            kept_ids = {
                str(getattr(match, "entry", {}).get("providerCardId") or "")
                for match in matches
            }
            other_language_matches = [
                match
                for match in all_matches
                if self._candidate_is_japanese(getattr(match, "entry", {}) or {}) != want_japanese
                and str(getattr(match, "entry", {}).get("providerCardId") or "") not in kept_ids
            ][:SCAN_KEEP_CROSSLANG_CANDIDATES_MAX]
        visual_match_ms = (perf_counter() - started_at) * 1000.0
        return matches, dict(debug or {}), visual_match_ms, other_language_matches

    def _build_raw_visual_only_response(
        self,
        payload: dict[str, Any],
        *,
        matches: list[Any],
        debug: dict[str, Any],
        visual_match_ms: float,
        api_key: str | None = None,
        is_provisional: bool = False,
        finalize_response: bool = True,
        other_language_matches: list[Any] | None = None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        self._prime_card_lookup_cache(
            [
                entry.get("providerCardId")
                for match in matches[:10]
                for entry in [getattr(match, "entry", None)]
                if isinstance(entry, dict)
            ]
        )
        ranked_matches = [self._visual_match_summary(match) for match in matches]
        confidence, ambiguity_flags, confidence_detail = self._visual_confidence(ranked_matches)
        review_disposition = "ready" if confidence != "low" else "needs_review"
        pricing_policy = self._scan_candidate_pricing_policy(
            refresh_top_candidate_stale=True,
            refresh_top_candidate_missing=True,
            force_show_mode_top_candidate_refresh=True,
        )
        response_build_started_at = perf_counter()
        encoded_candidates, scored_candidates, encode_debug = self._encode_top_candidates(
            [
                CandidateEncodingItem(
                    card=self._visual_candidate_stub(match.entry),
                    image_score=float(summary["similarity"]),
                    collector_number_score=0.0,
                    name_score=0.0,
                    final_score=float(summary["similarity"]),
                    reasons=("visual_similarity",),
                    scored_fields={"visualScore": round(float(summary["similarity"]), 4)},
                )
                for match, summary in zip(matches[:10], ranked_matches[:10], strict=True)
            ],
            pricing_context=self._raw_pricing_context(),
            pricing_policy=pricing_policy,
            trigger_source="scan_match_raw",
            api_key=api_key,
        )

        # Build the persisted candidate pool. The first 10 are the fully hydrated
        # encoded candidates (with pricing) that already power the response above;
        # they are reused verbatim so we never re-hydrate them. The remainder
        # (ranks 11..SCAN_CANDIDATE_POOL_SIZE) are LIGHTWEIGHT rows built purely
        # from the visual-match summaries: no per-candidate DB lookup, no pricing,
        # so they add no latency to the live scan path. The "load more candidates"
        # endpoint hydrates pricing for these rows on demand.
        storage_candidates: list[dict[str, Any]] = list(encoded_candidates)
        for offset, summary in enumerate(ranked_matches[10:SCAN_CANDIDATE_POOL_SIZE]):
            similarity = float(summary.get("similarity") or 0.0)
            storage_candidates.append(
                {
                    "rank": 10 + offset + 1,
                    "candidate": {
                        "id": str(summary.get("providerCardId") or ""),
                        "name": str(summary.get("name") or ""),
                        "setName": str(summary.get("setName") or ""),
                        "number": str(summary.get("collectorNumber") or ""),
                        "rarity": "Unknown",
                        "variant": "Raw",
                        "language": str(summary.get("language") or "Unknown"),
                        "imageSmallURL": summary.get("imageUrl"),
                        "imageLargeURL": summary.get("imageUrl"),
                    },
                    "imageScore": round(similarity, 4),
                    "collectorNumberScore": 0.0,
                    "nameScore": 0.0,
                    "finalScore": round(similarity, 4),
                }
            )

        # Cross-language "Switch" tail: when the "Scanning for" toggle hard-filtered
        # the actually-scanned card out (e.g. an EN card scanned with the JP toggle
        # on), append the top other-language matches to the END of both the live
        # `topCandidates` and the persisted pool so the real card stays reachable.
        # This runs AFTER the decision/ranking above, so top-1 and the main ranked
        # order are untouched; these rows are only ever appended at the tail.
        other_language_matches = other_language_matches or []
        if other_language_matches:
            existing_candidate_ids = {
                str((row.get("candidate") or {}).get("id") or "").strip()
                for row in storage_candidates
            }
            cross_lang_items: list[CandidateEncodingItem] = []
            for match in other_language_matches:
                stub = self._visual_candidate_stub(match.entry)
                stub_id = str(stub.get("id") or "").strip()
                if not stub_id or stub_id in existing_candidate_ids:
                    continue
                existing_candidate_ids.add(stub_id)
                similarity = float(getattr(match, "similarity", 0.0) or 0.0)
                cross_lang_items.append(
                    CandidateEncodingItem(
                        card=stub,
                        image_score=similarity,
                        collector_number_score=0.0,
                        name_score=0.0,
                        final_score=similarity,
                        reasons=("visual_similarity", "cross_language_switch"),
                        scored_fields={
                            "visualScore": round(similarity, 4),
                            "crossLanguageSwitch": True,
                        },
                    )
                )
            if cross_lang_items:
                cross_encoded, cross_scored, _ = self._encode_top_candidates(
                    cross_lang_items,
                    pricing_context=self._raw_pricing_context(),
                    pricing_policy=pricing_policy,
                    trigger_source="scan_match_raw_cross_language",
                    api_key=api_key,
                )
                # Re-rank the appended rows to follow the existing tail and tag the
                # candidate language so the client can label the "Switch" entry.
                for offset, encoded in enumerate(cross_encoded):
                    tail_rank = len(storage_candidates) + 1
                    encoded["rank"] = tail_rank
                    encoded["crossLanguageSwitch"] = True
                    encoded_candidates.append(encoded)
                    scored_candidates.append(cross_scored[offset])
                    storage_candidates.append(encoded)

        response = {
            "scanID": payload["scanID"],
            "topCandidates": encoded_candidates,
            "confidence": confidence,
            "confidenceDetail": confidence_detail,
            "ambiguityFlags": ambiguity_flags,
            "matcherSource": "visualIndex",
            "matcherVersion": MATCHER_VERSION,
            "resolverMode": "raw_card",
            "resolverPath": "visual_only_index",
            "slabContext": None,
            "targetLanguageMismatch": debug.get("targetLanguageMismatch"),
            "reviewDisposition": review_disposition,
            "reviewReason": None if confidence != "low" else "Visual-only candidates are ambiguous.",
            "rawDecisionDebug": {
                "visualOnly": {
                    **debug,
                    "candidateCount": len(ranked_matches),
                    "topCandidates": ranked_matches[:10],
                    "isProvisional": is_provisional,
                }
            },
            "isProvisional": is_provisional,
            "matchingStage": "visual" if is_provisional else "final",
            "candidatePoolSize": len(storage_candidates),
        }
        self._record_backend_timing(
            response,
            visualMatchMs=round(float(visual_match_ms), 3),
            candidateEncodeMs=encode_debug.get("candidateEncodeMs"),
            encodedCandidateCount=encode_debug.get("encodedCandidateCount"),
            candidateTimings=encode_debug.get("candidateTimings"),
            responseBuildMs=(perf_counter() - response_build_started_at) * 1000.0,
            **self._visual_matcher_timing_fields(debug),
        )
        if finalize_response:
            self._finalize_scan_response(
                payload,
                response,
                scored_candidates,
                prediction_candidates=storage_candidates,
            )
        return response, scored_candidates, ranked_matches, storage_candidates

    def _prewarm_raw_visual_runtime(self, *, run_inference: bool = True) -> dict[str, Any]:
        started_at = perf_counter()
        try:
            matcher = self._raw_visual_matcher_instance()
            if hasattr(matcher, "prewarm"):
                try:
                    result = matcher.prewarm(run_inference=run_inference)
                except TypeError:
                    result = matcher.prewarm()
            else:
                result = {"available": True, "prewarmed": True}
            return {
                **result,
                "requested": True,
                "totalMs": round((perf_counter() - started_at) * 1000.0, 3),
            }
        except Exception as exc:
            return {
                "requested": True,
                "available": False,
                "prewarmed": False,
                "error": str(exc),
                "totalMs": round((perf_counter() - started_at) * 1000.0, 3),
            }

    def _scrydex_full_catalog_sync(self) -> dict[str, Any] | None:
        return latest_provider_sync_run(
            self.connection,
            provider=SCRYDEX_PROVIDER,
            sync_scope=SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
        )

    def _scrydex_full_catalog_sync_is_fresh(self) -> bool:
        return provider_sync_run_is_fresh(
            self.connection,
            provider=SCRYDEX_PROVIDER,
            sync_scope=SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
            max_age_hours=24.0,
        )

    @staticmethod
    def _manual_scrydex_mirror_enabled() -> bool:
        return _env_flag(MANUAL_SCRYDEX_MIRROR_ENV, default=True)

    @staticmethod
    def _coerce_utc_datetime(raw_value: str | None) -> datetime | None:
        cleaned = str(raw_value or "").strip()
        if not cleaned:
            return None
        try:
            parsed = datetime.fromisoformat(cleaned)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    @staticmethod
    def _portfolio_time_zone(time_zone_name: str | None) -> ZoneInfo:
        candidate = str(time_zone_name or "").strip() or "America/Los_Angeles"
        try:
            return ZoneInfo(candidate)
        except Exception:
            return ZoneInfo("America/Los_Angeles")

    @staticmethod
    def _portfolio_day_start(day: date, time_zone: ZoneInfo) -> datetime:
        return datetime.combine(day, datetime.min.time(), tzinfo=time_zone)

    @classmethod
    def _normalize_portfolio_range_label(cls, range_label: str | None) -> str | None:
        """Normalize the inbound range label and apply backward-compat aliases.

        The canonical history range tokens are ``1W``, ``1M``, ``3M``, ``YTD``,
        ``1Y``, ``ALL`` (plus the legacy day-based labels ``30D``, ``90D``).
        Older clients may still send ``7D``; treat it as an alias for ``1W``.
        """
        normalized = str(range_label or "").strip().upper() or None
        if normalized == "7D":
            return "1W"
        return normalized

    @classmethod
    def _portfolio_date_bounds(
        cls,
        *,
        days: int,
        range_label: str | None,
        time_zone_name: str | None,
        earliest_at: datetime | None = None,
    ) -> tuple[ZoneInfo, date, date]:
        time_zone = cls._portfolio_time_zone(time_zone_name)
        end_date = datetime.now(time_zone).date()
        resolved_days = max(1, min(int(days), 365))
        start_date = end_date - timedelta(days=resolved_days - 1)
        normalized_range = cls._normalize_portfolio_range_label(range_label)
        if normalized_range == "1W":
            start_date = end_date - timedelta(days=6)
        elif normalized_range == "30D":
            start_date = end_date - timedelta(days=29)
        elif normalized_range == "90D":
            start_date = end_date - timedelta(days=89)
        elif normalized_range == "YTD":
            start_date = date(end_date.year, 1, 1)
        elif normalized_range == "1Y":
            start_date = end_date - timedelta(days=364)
        if earliest_at is not None:
            earliest_date = earliest_at.astimezone(time_zone).date()
            if normalized_range == "ALL":
                start_date = earliest_date
            elif (
                normalized_range in {"1W", "30D", "90D", "YTD", "1Y"}
                and earliest_date > start_date
            ):
                start_date = earliest_date
        return time_zone, start_date, end_date

    def _portfolio_earliest_activity_at(self) -> datetime | None:
        owner_user_id = self._current_owner_user_id()
        earliest_row = self.connection.execute(
            """
            SELECT MIN(created_at) AS earliest_at
            FROM (
                SELECT created_at AS created_at
                FROM deck_entry_events
                WHERE owner_user_id = ?
                UNION ALL
                SELECT sold_at AS created_at
                FROM sale_events
                WHERE owner_user_id = ?
                UNION ALL
                SELECT added_at AS created_at
                FROM deck_entries
                WHERE owner_user_id = ?
            )
            """,
            (owner_user_id, owner_user_id, owner_user_id),
        ).fetchone()
        earliest_raw = str(earliest_row["earliest_at"] if earliest_row is not None else "").strip()
        return self._coerce_utc_datetime(earliest_raw)

    def _portfolio_earliest_priced_date(self) -> date | None:
        """Earliest day for which ANY price history exists (provider-scoped).

        The daily job prices the whole catalog each run, so the global minimum
        price_date is also the first day a portfolio can have a non-zero value.
        History-bounded ranges (3M/1Y/ALL) must not plot days before this — there
        is no price to value the portfolio with, so every such day reads $0 and
        drags the chart (and its baseline) to zero. Clamping the window start to
        this date makes those ranges show "since data began" instead.
        """
        row = self.connection.execute(
            "SELECT MIN(price_date) AS earliest_date FROM card_price_history_daily WHERE provider = ?",
            (pricing_provider(),),
        ).fetchone()
        earliest_raw = str(row["earliest_date"] if row is not None else "").strip()
        if not earliest_raw:
            return None
        try:
            return date.fromisoformat(earliest_raw[:10])
        except ValueError:
            return None

    def _card_show_mode_record(self) -> dict[str, Any] | None:
        return runtime_setting(self.connection, CARD_SHOW_MODE_SETTING_KEY)

    def _card_show_mode_state(self) -> dict[str, Any]:
        record = self._card_show_mode_record()
        payload = (record or {}).get("value") if isinstance(record, dict) else {}
        if not isinstance(payload, dict):
            payload = {}

        set_at = str(payload.get("setAt") or "").strip() or None
        note = str(payload.get("note") or "").strip() or None

        # Show mode is a plain on/off switch: ON until the admin turns it OFF.
        # Back-compat: older records used a time window `until`; treat a
        # still-future window as ON so an already-enabled record keeps working.
        active = bool(payload.get("active"))
        if not active:
            until_at = self._coerce_utc_datetime(str(payload.get("until") or "").strip() or None)
            active = bool(until_at is not None and until_at > datetime.now(timezone.utc))

        return {
            "active": active,
            "until": None,
            "setAt": set_at,
            "note": note,
            "remainingSeconds": 0,
        }

    def _card_show_mode_active(self) -> bool:
        return bool(self._card_show_mode_state().get("active"))

    def set_card_show_mode(
        self,
        *,
        note: str | None = None,
        **_legacy: Any,
    ) -> dict[str, Any]:
        """Turn show mode ON. Stays ON until ``clear_card_show_mode`` turns it OFF.

        A plain on/off switch — no expiry window. Legacy time kwargs (``until`` /
        ``duration_hours``) are accepted and ignored so existing callers keep
        working.
        """
        now = datetime.now(timezone.utc)
        upsert_runtime_setting(
            self.connection,
            key=CARD_SHOW_MODE_SETTING_KEY,
            value={
                "active": True,
                "setAt": now.isoformat(),
                "note": str(note or "").strip() or None,
            },
        )
        self.connection.commit()
        return self._card_show_mode_state()

    def clear_card_show_mode(self) -> dict[str, Any]:
        delete_runtime_setting(self.connection, CARD_SHOW_MODE_SETTING_KEY)
        self.connection.commit()
        return self._card_show_mode_state()

    # --- Public App Store ACCESS GATE --------------------------------------
    def _access_whitelist_emails(self) -> set[str]:
        record = runtime_setting(self.connection, ACCESS_WHITELIST_SETTING_KEY)
        payload = (record or {}).get("value") if isinstance(record, dict) else {}
        if not isinstance(payload, dict):
            return set()
        emails = payload.get("emails")
        if not isinstance(emails, list):
            return set()
        return {
            str(item).strip().lower()
            for item in emails
            if str(item or "").strip()
        }

    def list_whitelist_emails(self) -> list[str]:
        return sorted(self._access_whitelist_emails())

    def add_whitelist_email(self, email: str) -> list[str]:
        normalized = str(email or "").strip().lower()
        if not normalized or "@" not in normalized:
            raise ValueError("invalid_email")
        emails = self._access_whitelist_emails()
        emails.add(normalized)
        upsert_runtime_setting(
            self.connection,
            key=ACCESS_WHITELIST_SETTING_KEY,
            value={"emails": sorted(emails)},
        )
        self.connection.commit()
        return sorted(emails)

    def remove_whitelist_email(self, email: str) -> list[str]:
        normalized = str(email or "").strip().lower()
        emails = self._access_whitelist_emails()
        emails.discard(normalized)
        upsert_runtime_setting(
            self.connection,
            key=ACCESS_WHITELIST_SETTING_KEY,
            value={"emails": sorted(emails)},
        )
        self.connection.commit()
        return sorted(emails)

    def _is_admin_email(self, email: str | None) -> bool:
        return str(email or "").strip().lower() in _access_admin_emails()

    def _access_email_allowed(self, email: str | None) -> bool:
        normalized = str(email or "").strip().lower()
        if not normalized:
            return False
        if normalized in _access_admin_emails():
            return True
        return normalized in self._access_whitelist_emails()

    def _access_has_grant(self, user_id: str | None) -> bool:
        normalized = str(user_id or "").strip()
        if not normalized:
            return False
        row = self.connection.execute(
            "SELECT 1 FROM access_grants WHERE user_id = ? LIMIT 1",
            (normalized,),
        ).fetchone()
        return row is not None

    def access_allowed(self, identity: RequestIdentity) -> bool:
        return (
            self._card_show_mode_active()
            or self._access_email_allowed(getattr(identity, "email", "") )
            or self._access_has_grant(getattr(identity, "user_id", ""))
        )

    def access_status(self, identity: RequestIdentity) -> dict[str, Any]:
        # Mirror this user's email locally (we only receive it live from the JWT).
        # access_status is hit by every signed-in user on launch, so this captures
        # everyone's email over time without a per-request write hot path.
        self._record_user_email(
            getattr(identity, "user_id", ""), getattr(identity, "email", "")
        )
        return {
            "accessOpen": self._card_show_mode_active(),
            "allowed": self.access_allowed(identity),
            "isAdmin": self._is_admin_email(getattr(identity, "email", "")),
            "showMode": self._card_show_mode_state(),
        }

    def redeem_invite_code(self, identity: RequestIdentity, code: str) -> dict[str, Any]:
        normalized = str(code or "").strip().lower()
        if normalized not in _access_invite_codes():
            raise ValueError("invalid_code")
        user_id = str(getattr(identity, "user_id", "") or "").strip()
        if not user_id:
            raise ValueError("invalid_code")
        self.connection.execute(
            """
            INSERT INTO access_grants (user_id, email, granted_via, granted_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                email = excluded.email,
                granted_via = excluded.granted_via,
                granted_at = excluded.granted_at
            """,
            (
                user_id,
                str(getattr(identity, "email", "") or "").strip() or None,
                "invite_code",
                utc_now(),
            ),
        )
        self.connection.commit()
        return {"redeemed": True, "allowed": True}

    def add_waitlist_email(self, identity: RequestIdentity, email: str) -> dict[str, Any]:
        self.connection.execute(
            """
            INSERT INTO access_waitlist (email, user_id, created_at)
            VALUES (?, ?, ?)
            """,
            (
                str(email or "").strip() or None,
                str(getattr(identity, "user_id", "") or "").strip() or None,
                utc_now(),
            ),
        )
        self.connection.commit()
        return {"ok": True}

    def _record_user_email(self, user_id: str | None, email: str | None) -> None:
        """Mirror a user's Supabase email into our own DB. We only ever receive the
        email live from the JWT (it's not stored locally otherwise), so capturing it
        here lets us list / whitelist / contact users by email instead of opaque IDs.
        Also fills in the email on any existing grant for this user."""
        uid = str(user_id or "").strip()
        em = str(email or "").strip()
        if not uid or not em:
            return
        now = utc_now()
        self.connection.execute(
            """
            INSERT INTO user_emails (user_id, email, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                email = excluded.email, updated_at = excluded.updated_at
            """,
            (uid, em, now),
        )
        self.connection.execute(
            "UPDATE access_grants SET email = ? WHERE user_id = ? AND (email IS NULL OR email = '')",
            (em, uid),
        )
        self.connection.commit()

    def sync_user_emails_from_supabase(self) -> dict[str, Any]:
        """One-shot pull of every existing user's email from Supabase `auth.users`
        (admin API + service-role key) into `user_emails` — backfills users who
        signed up before we started mirroring emails locally. Paginated."""
        base = str(os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
        key = str(os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        if not base or not key:
            raise RuntimeError("supabase_not_configured")
        from urllib.request import Request, urlopen

        synced = 0
        page = 1
        per_page = 200
        while True:
            url = f"{base}/auth/v1/admin/users?page={page}&per_page={per_page}"
            request = Request(url, headers={"Authorization": f"Bearer {key}", "apikey": key})
            with urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
            users = payload.get("users") if isinstance(payload, dict) else payload
            if not users:
                break
            for user in users:
                uid = str((user or {}).get("id") or "").strip()
                email = str((user or {}).get("email") or "").strip()
                if uid and email:
                    self._record_user_email(uid, email)
                    synced += 1
            if len(users) < per_page:
                break
            page += 1
        return {"synced": synced}

    def _live_pricing_record(self) -> dict[str, Any] | None:
        return runtime_setting(self.connection, LIVE_PRICING_SETTING_KEY)

    def _live_pricing_state(self) -> dict[str, Any]:
        record = self._live_pricing_record()
        payload = (record or {}).get("value") if isinstance(record, dict) else {}
        if not isinstance(payload, dict):
            payload = {}

        if "enabled" in payload:
            enabled = bool(payload.get("enabled") is True)
            source = "runtime_setting"
            set_at = str(payload.get("setAt") or (record or {}).get("updatedAt") or "").strip() or None
            note = str(payload.get("note") or "").strip() or None
        else:
            enabled = _env_flag(LIVE_PRICING_ENABLED_ENV, default=False)
            source = "env_default"
            set_at = None
            note = None

        return {
            "enabled": enabled,
            "source": source,
            "setAt": set_at,
            "note": note,
            "refreshWindowHours": LIVE_PRICING_REFRESH_WINDOW_HOURS,
        }

    def _live_pricing_enabled(self) -> bool:
        return bool(self._live_pricing_state().get("enabled"))

    def set_live_pricing_mode(
        self,
        *,
        enabled: bool,
        note: str | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        upsert_runtime_setting(
            self.connection,
            key=LIVE_PRICING_SETTING_KEY,
            value={
                "enabled": bool(enabled),
                "setAt": now.isoformat(),
                "note": str(note or "").strip() or None,
            },
        )
        self.connection.commit()
        return self._live_pricing_state()

    def _scan_artifact_uploads_record(self) -> dict[str, Any] | None:
        return runtime_setting(self.connection, SCAN_ARTIFACT_UPLOADS_SETTING_KEY)

    def _scan_artifact_uploads_state(self) -> dict[str, Any]:
        record = self._scan_artifact_uploads_record()
        payload = (record or {}).get("value") if isinstance(record, dict) else {}
        if not isinstance(payload, dict):
            payload = {}

        if "enabled" in payload:
            enabled = bool(payload.get("enabled") is True)
            source = "runtime_setting"
            set_at = str(payload.get("setAt") or (record or {}).get("updatedAt") or "").strip() or None
            note = str(payload.get("note") or "").strip() or None
        else:
            enabled = _env_flag(SCAN_ARTIFACT_UPLOADS_ENABLED_ENV, default=False)
            source = "env_default"
            set_at = None
            note = None

        return {
            "enabled": enabled,
            "source": source,
            "setAt": set_at,
            "note": note,
            **self.artifact_store.debug_status(),
            "gcsBucketConfigured": bool(str(os.environ.get(SCAN_ARTIFACTS_GCS_BUCKET_ENV) or "").strip()),
        }

    def _scan_artifact_uploads_enabled(self) -> bool:
        return bool(self._scan_artifact_uploads_state().get("enabled"))

    def scan_artifact_status(self) -> dict[str, Any]:
        artifact_row = self.connection.execute(
            """
            SELECT uploaded_at
            FROM scan_artifacts
            WHERE upload_status = 'uploaded'
            ORDER BY uploaded_at DESC, scan_id DESC
            LIMIT 1
            """
        ).fetchone()
        stored_artifact_count = self.connection.execute(
            "SELECT COUNT(*) AS count FROM scan_artifacts"
        ).fetchone()["count"]
        return {
            "scanArtifactUploads": self._scan_artifact_uploads_state(),
            "storedArtifactCount": int(stored_artifact_count or 0),
            "latestUploadedAt": artifact_row["uploaded_at"] if artifact_row else None,
        }

    def set_scan_artifact_uploads_mode(
        self,
        *,
        enabled: bool,
        note: str | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        upsert_runtime_setting(
            self.connection,
            key=SCAN_ARTIFACT_UPLOADS_SETTING_KEY,
            value={
                "enabled": bool(enabled),
                "setAt": now.isoformat(),
                "note": str(note or "").strip() or None,
            },
        )
        self.connection.commit()
        return self._scan_artifact_uploads_state()

    @staticmethod
    def _pricing_refreshed_at(pricing: dict[str, Any] | None) -> datetime | None:
        if not isinstance(pricing, dict):
            return None
        raw_value = str(pricing.get("refreshedAt") or "").strip()
        if not raw_value:
            return None
        try:
            parsed = datetime.fromisoformat(raw_value)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    def _pricing_snapshot_age_hours(self, pricing: dict[str, Any] | None) -> float | None:
        refreshed_at = self._pricing_refreshed_at(pricing)
        if refreshed_at is None:
            return None
        return max(0.0, (datetime.now(timezone.utc) - refreshed_at).total_seconds() / 3600.0)

    def _pricing_within_live_refresh_window(self, pricing: dict[str, Any] | None) -> bool:
        age_hours = self._pricing_snapshot_age_hours(pricing)
        if age_hours is None:
            return False
        return age_hours <= LIVE_PRICING_REFRESH_WINDOW_HOURS

    def _should_use_cached_pricing_snapshot(
        self,
        pricing: dict[str, Any] | None,
        *,
        force_refresh: bool,
    ) -> bool:
        if pricing is None or force_refresh:
            return False
        if self._live_pricing_enabled():
            return self._pricing_within_live_refresh_window(pricing)
        return pricing.get("isFresh") is True

    def _live_scrydex_searches_allowed(self) -> bool:
        if self._manual_scrydex_mirror_enabled():
            return False
        return not self._scrydex_full_catalog_sync_is_fresh()

    def _live_scrydex_pricing_refresh_allowed(self) -> bool:
        return self._live_pricing_enabled()

    def _live_scrydex_queries_blocked(self) -> bool:
        return not (
            self._live_scrydex_searches_allowed()
            or self._live_scrydex_pricing_refresh_allowed()
        )

    def live_scrydex_queries_allowed(self) -> bool:
        return not self._live_scrydex_queries_blocked()

    def _manual_scrydex_mirror_status(self) -> dict[str, Any]:
        full_sync_fresh = self._scrydex_full_catalog_sync_is_fresh()
        searches_allowed = self._live_scrydex_searches_allowed()
        pricing_refresh_allowed = self._live_scrydex_pricing_refresh_allowed()
        return {
            "enabled": self._manual_scrydex_mirror_enabled(),
            "fullCatalogSyncFresh": full_sync_fresh,
            "searchesAllowed": searches_allowed,
            "searchesBlocked": not searches_allowed,
            "pricingRefreshAllowed": pricing_refresh_allowed,
            "pricingRefreshBlocked": not pricing_refresh_allowed,
            "liveQueriesBlocked": not (searches_allowed or pricing_refresh_allowed),
            "cardShowMode": self._card_show_mode_state(),
        }

    def run_manual_scrydex_sync(
        self,
        *,
        page_size: int = 100,
        max_pages: int | None = None,
        language: str | None = None,
        scheduled_for: str | None = None,
    ) -> dict[str, Any]:
        from sync_scrydex_catalog import sync_scrydex_catalog

        summary = sync_scrydex_catalog(
            database_path=self.database_path,
            repo_root=self.repo_root,
            page_size=page_size,
            language=language,
            max_pages=max_pages,
            scheduled_for=scheduled_for,
        )
        self.refresh_index()
        return {
            **summary,
            "manualScrydexMirror": self._manual_scrydex_mirror_status(),
        }

    @staticmethod
    def _raw_resolver_strategy(payload: dict[str, Any]) -> str:
        hint = str(payload.get("rawResolverMode") or "").strip().lower()
        if hint in {"visual", "visual_only", "hybrid", "ocr"}:
            return hint
        return "hybrid"

    @staticmethod
    def _log_scrydex_match_usage(
        scan_id: str,
        *,
        before_total: int,
        started_at: float,
        response: dict[str, Any],
    ) -> None:
        stats = scrydex_request_stats_snapshot()
        after_total = int(stats.get("total") or 0)
        delta = max(0, after_total - before_total)
        recent = list(stats.get("recent") or [])
        recent_entries = recent[-delta:] if delta > 0 else []
        types = [str(entry.get("type") or "unknown") for entry in recent_entries]
        server_processing_ms = max(0.0, (perf_counter() - started_at) * 1000.0)
        response["performance"] = {
            "serverProcessingMs": round(server_processing_ms, 3),
            "scrydexRequestCount": delta,
            "scrydexRequestTypes": types,
        }
        visual_hybrid_debug = ((response.get("rawDecisionDebug") or {}).get("visualHybrid") or {})
        phase_timings = visual_hybrid_debug.get("phaseTimings") or {}
        matcher_timings = visual_hybrid_debug.get("timings") or {}
        backend_timings = response.get("backendTimingDebug") or {}
        if phase_timings or matcher_timings:
            response["performance"]["phaseTimings"] = phase_timings
            response["performance"]["matcherTimings"] = matcher_timings
        if backend_timings:
            response["performance"]["backendTimings"] = backend_timings

    def _display_pricing_summary_for_card(
        self,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
        preferred_variant: str | None = None,
        preferred_condition: str | None = None,
    ) -> dict[str, Any] | None:
        pricing_context = (
            self._slab_pricing_context(
                grader=grader,
                grade=grade,
                preferred_variant=preferred_variant,
            )
            if grader or grade
            else self._raw_pricing_context(
                preferred_variant=preferred_variant,
                preferred_condition=preferred_condition,
            )
        )
        return self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context)

    @staticmethod
    def _raw_pricing_context(
        preferred_variant: str | None = None,
        preferred_condition: str | None = None,
    ) -> PricingContext:
        return PricingContext(
            mode="raw",
            preferred_variant=preferred_variant,
            preferred_condition=preferred_condition,
        )

    @staticmethod
    def _sanitize_slab_variant_name(
        variant_name: str | None,
        grader: str | None,
        grade: str | None,
    ) -> str | None:
        """Reject a slab variant_name that is really the grade label.

        A slab's variant_name must be the card's print variant (e.g. "Holofoil"),
        which is how the graded price snapshot is keyed. Some client add paths
        compose `${grader} ${grade}` (e.g. "PSA 10") into variantName; stored as
        the variant it never matches the snapshot's real variant, so the graded
        price collapses to "—" on the Collection/Wishlist. Drop such values so the
        pricing resolver falls back to the grade's real entry.
        """
        candidate = str(variant_name or "").strip()
        if not candidate:
            return None
        g = str(grader or "").strip()
        gr = str(grade or "").strip()
        grade_labels = {label.casefold() for label in (f"{g} {gr}".strip(), gr, g) if label}
        if candidate.casefold() in grade_labels:
            return None
        return candidate

    @staticmethod
    def _slab_pricing_context(
        *,
        grader: str | None,
        grade: str | None,
        cert_number: str | None = None,
        preferred_variant: str | None = None,
        variant_hints: dict[str, Any] | None = None,
    ) -> PricingContext:
        return PricingContext(
            mode="graded",
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            preferred_variant=preferred_variant,
            variant_hints=dict(variant_hints) if isinstance(variant_hints, dict) else None,
        )

    @staticmethod
    def _slab_pricing_context_from_payload(slab_context: dict[str, Any] | None) -> PricingContext:
        slab_context = slab_context or {}
        return SpotlightScanService._slab_pricing_context(
            grader=str(slab_context.get("grader") or "").strip() or None,
            grade=str(slab_context.get("grade") or "").strip() or None,
            cert_number=str(slab_context.get("certNumber") or "").strip() or None,
            preferred_variant=str(slab_context.get("variantName") or "").strip() or None,
            variant_hints=slab_context.get("variantHints") if isinstance(slab_context.get("variantHints"), dict) else None,
        )

    @staticmethod
    def _slab_context_payload_for_pricing_context(
        pricing_context: PricingContext,
        *,
        include_variant_hints: bool = False,
        resolved_variant: str | None = None,
    ) -> dict[str, Any] | None:
        if not pricing_context.is_graded or not pricing_context.grader:
            return None
        slab_context = {
            "grader": pricing_context.grader,
            "grade": pricing_context.grade,
            "certNumber": pricing_context.cert_number,
        }
        variant_name = resolved_variant or pricing_context.preferred_variant
        if variant_name:
            slab_context["variantName"] = variant_name
        if include_variant_hints and pricing_context.variant_hints:
            slab_context["variantHints"] = dict(pricing_context.variant_hints)
        return slab_context

    def _display_pricing_summary_for_context(
        self,
        card_id: str,
        *,
        pricing_context: PricingContext,
        snapshot_row: sqlite3.Row | None = None,
        day_cells: list[Any] | None = None,
    ) -> dict[str, Any] | None:
        if snapshot_row is None and pricing_context.is_graded:
            snapshot_row = price_snapshot_row(self.connection, card_id)
        if snapshot_row is not None:
            pricing = self._pricing_summary_from_snapshot_row(
                snapshot_row,
                pricing_context=pricing_context,
                day_cells=day_cells,
            )
            if (
                pricing is not None
                and (
                    pricing_context.is_graded
                    or self._raw_pricing_matches_context(
                        pricing,
                        preferred_variant=pricing_context.preferred_variant,
                        preferred_condition=pricing_context.preferred_condition,
                    )
                )
            ):
                # `pricing` is already FX-decorated by
                # `_pricing_summary_from_snapshot_row` (graded + raw).
                return pricing

        pricing = contextual_pricing_summary_for_card(
            self.connection,
            card_id,
            grader=pricing_context.grader,
            grade=pricing_context.grade,
            variant=pricing_context.preferred_variant,
            condition=pricing_context.preferred_condition,
        )
        if pricing is None and pricing_context.is_graded:
            pricing = contextual_pricing_summary_for_card(
                self.connection,
                card_id,
                grader=pricing_context.grader,
                grade=pricing_context.grade,
                variant=None,
            )
        pricing = decorate_pricing_summary_with_fx(self.connection, pricing)
        # A graded entry whose exact (grade + preferred variant) price doesn't
        # exist falls back to an available graded variant — e.g. an owned
        # "League Stamp" PSA 10 whose only PSA-10 price is for variant "Normal"
        # ($49). The resolver honors that fallback internally (step 1's
        # variant=<preferred> lookup already best-matches to "Normal") or via the
        # variant=None retry above. When a non-null preferred variant had no exact
        # price and we fell back, SHOW the fallback price (product-desired; matches
        # the PDP) instead of blanking the tile: skip the graded variant-match
        # guard for that intentional fallback. When the exact variant WAS found the
        # resolved variant matches the request (guard is a no-op), and when
        # preferred_variant is null the guard still applies variant_hints.
        used_graded_variant_fallback = (
            pricing_context.is_graded
            and pricing is not None
            and bool(pricing_context.preferred_variant)
            and bool(pricing.get("variant"))
            and not self._slab_variant_matches(
                pricing.get("variant"),
                preferred_variant=pricing_context.preferred_variant,
            )
        )
        if (
            pricing_context.is_graded
            and pricing is not None
            and pricing.get("variant")
            and not used_graded_variant_fallback
            and not self._slab_variant_matches(
                pricing.get("variant"),
                preferred_variant=pricing_context.preferred_variant,
                variant_hints=pricing_context.variant_hints,
            )
        ):
            return None
        if (
            not pricing_context.is_graded
            and pricing is not None
            and not self._raw_pricing_matches_context(
                pricing,
                preferred_variant=pricing_context.preferred_variant,
                preferred_condition=pricing_context.preferred_condition,
            )
        ):
            return None
        # Phantom raw suppression at the display chokepoint so it applies to EVERY
        # read path — incl. the cells-based contextual_pricing_summary_for_card
        # above, which bypasses _pricing_summary_from_snapshot_row's guard. A raw
        # price above the card's own PSA 10 is a fake illiquid number; show nothing.
        if (
            not pricing_context.is_graded
            and pricing is not None
            and pricing.get("market") is not None
        ):
            phantom_row = snapshot_row or price_snapshot_row(self.connection, card_id)
            if phantom_row is not None and _is_raw_phantom_price(
                self.connection,
                _raw_contexts_payload(phantom_row["raw_contexts_json"]),
                _graded_contexts_payload(phantom_row["graded_contexts_json"]),
            ):
                for _k in ("market", "low", "mid", "high", "trend", "directLow", "trendsPct"):
                    if _k in pricing:
                        pricing[_k] = None
                pricing["suppressionReason"] = "phantom"
        return pricing

    def _raw_pricing_matches_context(
        self,
        pricing: dict[str, Any] | None,
        *,
        preferred_variant: str | None,
        preferred_condition: str | None,
    ) -> bool:
        if not isinstance(pricing, dict):
            return False

        # Condition is owned by the resolver: it returns the exact requested
        # condition when Scrydex prices it, otherwise the NEAREST available one.
        # So a differing condition here is a legitimate best-available fallback
        # (e.g. Heavily Played with no HP comp -> MP/DM), not a mismatch to
        # reject with "—". Only the variant must still line up.
        if preferred_variant:
            requested_variant = _normalized_variant_label(preferred_variant)
            pricing_variant = _normalized_variant_label(str(pricing.get("variant") or "").strip() or None)
            if requested_variant != pricing_variant:
                return False

        return True

    def _cells_summary_from_snapshot_row(
        self,
        snapshot_row: sqlite3.Row,
        *,
        pricing_context: PricingContext,
        day_cells: list[Any],
    ) -> tuple[str | None, dict[str, Any] | None] | None:
        """Cells-first twin of the variant/condition resolution inside
        ``_pricing_summary_from_snapshot_row``. Resolves the snapshot row's
        CURRENT price for ``pricing_context`` from the pre-fetched normalized
        cells for that card's latest ``price_date`` instead of the fat
        ``raw_contexts_json`` / ``graded_contexts_json`` blobs.

        Returns ``(resolved_variant, summary)`` mirroring the JSON path's
        ``summary`` shape, or ``None`` when the cells yield nothing (so the
        caller falls back to the JSON-context resolution). The cell summary
        carries ``payload={}`` / ``trendsPct=None`` (cells do not persist those);
        the pricing dict's payload-derived fields then resolve from the
        snapshot's lightweight ``source_payload_json`` exactly as the JSON path
        does when an entry's own payload is empty — see the parity harness for
        the bounded divergence this introduces (payload/trendsPct only)."""
        if not day_cells:
            return None
        if pricing_context.is_graded:
            # RANKED resolution, including variant_hints — the cells twin of
            # _resolve_best_graded_context_entry. This is what the June 2026
            # cutover lacked (it deferred hinted contexts to the JSON blobs);
            # the hint-scoring tiers now run natively on cell fields.
            #
            # No explicit retry-without-variant here (the June code had one):
            # _resolve_best_graded_cell's tier 1 already falls through
            # internally when the preferred variant has no exact cell — tier 2
            # (variant=None simple pick) or tier 3 (hint-ranked) then resolve
            # it, which IS the retry. A None therefore means the grade
            # genuinely has no usable cell for ANY variant (or the cells-only
            # corrupt-pull guard tripped) → defer to the JSON fallback.
            cell = self._resolve_best_graded_cell(
                day_cells,
                grader=pricing_context.grader,
                grade=pricing_context.grade,
                preferred_variant=pricing_context.preferred_variant,
                variant_hints=pricing_context.variant_hints,
            )
            if cell is None:
                return None
            summary = _cell_summary_from_row(cell)
            cell_variant = _normalized_variant_label(_cell_field(cell, "variant_key"))
            resolved_variant = cell_variant or pricing_context.preferred_variant
            return resolved_variant, summary

        resolved_variant, _, summary = resolve_raw_summary_from_cells(
            day_cells,
            variant=pricing_context.preferred_variant or snapshot_row["default_raw_variant"],
            condition=pricing_context.preferred_condition or DEFAULT_RAW_CONDITION,
        )
        if summary is None:
            return None
        # Phantom raw suppression, cells twin: the JSON branch nulls a raw price
        # that exceeds the card's own PSA 10 (_is_raw_phantom_price). The cells
        # path must not silently bypass that guard, and it must not parse the
        # blobs to apply it — evaluate the same rule on the day's cells.
        if _is_raw_phantom_price_from_cells(self.connection, day_cells):
            for key in ("market", "low", "mid", "high", "trend", "directLow"):
                summary[key] = None
            summary["suppressionReason"] = "phantom"
        return resolved_variant, summary

    def _pricing_summary_from_snapshot_row(
        self,
        snapshot_row: sqlite3.Row,
        *,
        pricing_context: PricingContext,
        day_cells: list[Any] | None = None,
    ) -> dict[str, Any] | None:
        updated_at = snapshot_row["updated_at"]
        is_fresh = False
        if updated_at:
            try:
                refreshed = datetime.fromisoformat(str(updated_at))
                is_fresh = datetime.now(timezone.utc) - refreshed <= timedelta(hours=24)
            except ValueError:
                is_fresh = False

        # Cells-first: when the cell read source is active AND the caller has
        # pre-fetched this card's latest-day cells (``day_cells``), resolve the
        # price fields from the normalized cell table and skip parsing the fat
        # raw/graded context blobs entirely. ``day_cells is None`` means "not
        # pre-fetched" — keep the JSON path so no per-call cell query is issued
        # (avoids an N+1 in deck_entries); an empty list means "this card has no
        # cells" and also falls through to JSON.
        use_cells = price_history_cells_enabled() and day_cells is not None
        cells_resolution: tuple[str | None, dict[str, Any] | None] | None = None
        if use_cells:
            cells_resolution = self._cells_summary_from_snapshot_row(
                snapshot_row,
                pricing_context=pricing_context,
                day_cells=day_cells or [],
            )

        # The JSON-context blobs are only parsed when cells did not resolve the
        # price (fallback), so the cells-first path never pays for the cold blob
        # read.
        need_json = cells_resolution is None
        raw_contexts = (
            _raw_contexts_payload(snapshot_row["raw_contexts_json"]) if need_json else {}
        )
        graded_contexts = (
            _graded_contexts_payload(snapshot_row["graded_contexts_json"]) if need_json else {}
        )

        payload: dict[str, Any] = {}
        source_payload_raw = snapshot_row["source_payload_json"]
        if source_payload_raw:
            try:
                decoded_payload = json.loads(source_payload_raw)
                if isinstance(decoded_payload, dict):
                    payload = decoded_payload
            except (TypeError, ValueError, json.JSONDecodeError):
                payload = {}

        summary: dict[str, Any] | None = None
        resolved_payload: dict[str, Any] = {}
        resolved_variant: str | None = None

        if cells_resolution is not None:
            # Cells-first path: the price fields come from the normalized cell
            # row; payload/trendsPct are absent on cells, so resolved_payload
            # stays empty and the payload-derived fields below fall through to
            # the snapshot's source_payload_json payload (same fallback the JSON
            # path uses for an entry with an empty payload).
            resolved_variant, summary = cells_resolution
            resolved_payload = {}
        elif pricing_context.is_graded:
            entry = self._resolve_best_graded_context_entry(
                graded_contexts,
                grader=pricing_context.grader,
                grade=pricing_context.grade,
                preferred_variant=pricing_context.preferred_variant,
                variant_hints=pricing_context.variant_hints,
            )
            summary = _coerce_price_summary_from_entry(entry)
            if summary is None:
                return None
            resolved_variant = (
                str(entry.get("variant") or "").strip() or pricing_context.preferred_variant
                if isinstance(entry, dict)
                else pricing_context.preferred_variant
            )
            resolved_payload = summary.get("payload") or {}
        else:
            resolved_variant, _, summary = _resolve_raw_context_summary(
                raw_contexts,
                variant=pricing_context.preferred_variant or snapshot_row["default_raw_variant"],
                condition=pricing_context.preferred_condition or DEFAULT_RAW_CONDITION,
            )
            if summary is None and snapshot_row["default_raw_market_price"] is not None:
                summary = {
                    "currencyCode": snapshot_row["display_currency_code"],
                    "low": snapshot_row["default_raw_low_price"],
                    "market": snapshot_row["default_raw_market_price"],
                    "mid": snapshot_row["default_raw_mid_price"],
                    "high": snapshot_row["default_raw_high_price"],
                    "directLow": snapshot_row["default_raw_direct_low_price"],
                    "trend": snapshot_row["default_raw_trend_price"],
                    "payload": {},
                }
            if summary is None:
                return None
            resolved_payload = summary.get("payload") or {}
            # FREE Scrydex-only suppression: if this raw NM market exceeds the
            # card's OWN PSA 10 (currency-aware), it's an illiquid "phantom" price.
            # Showing a fake number is worse than showing nothing — null the raw
            # price fields and flag the reason. Only triggers on raw>own-PSA10, NOT
            # on mere illiquidity (a valid flat-priced card is never blanked).
            if _is_raw_phantom_price(self.connection, raw_contexts, graded_contexts):
                for key in ("market", "low", "mid", "high", "trend", "directLow"):
                    summary[key] = None
                summary["suppressionReason"] = "phantom"

        if pricing_context.is_graded:
            # Merge DURABLE PPT trust signals (ppt_graded_signals) into the headline
            # graded summary so the trust line survives a Scrydex sync that
            # overwrites graded_contexts_json. Defensive: no row -> leave as-is.
            # Applies to BOTH graded resolutions: the JSON branch above and the
            # cells-first branch (the signal table is a side table, not a blob, so
            # reading it costs the cells path nothing and keeps the trust line
            # identical across read sources).
            signal_row = _ppt_graded_signal_row(
                self.connection,
                snapshot_row["card_id"],
                pricing_context.grader,
                pricing_context.grade,
            )
            if signal_row is not None:
                resolved_payload = dict(resolved_payload)
                if signal_row["confidence"] is not None:
                    confidence_raw = str(signal_row["confidence"]).strip().lower()
                    if confidence_raw:
                        resolved_payload["confidenceLabel"] = confidence_raw.capitalize()
                        resolved_payload["confidenceLevel"] = confidence_raw
                if signal_row["count"] is not None:
                    resolved_payload["compCount"] = signal_row["count"]

        pricing = {
            "id": snapshot_row["card_id"],
            "cardID": snapshot_row["card_id"],
            "pricingMode": "psa_grade_estimate" if pricing_context.is_graded else RAW_PRICING_MODE,
            "provider": snapshot_row["provider"],
            "source": snapshot_row["provider"],
            "grader": pricing_context.grader,
            "grade": pricing_context.grade,
            "variant": resolved_variant if pricing_context.is_graded else (resolved_variant or snapshot_row["default_raw_variant"]),
            "currencyCode": summary.get("currencyCode") or snapshot_row["display_currency_code"],
            "low": summary.get("low"),
            "market": summary.get("market"),
            "mid": summary.get("mid"),
            "high": summary.get("high"),
            "directLow": summary.get("directLow"),
            "trend": summary.get("trend"),
            "trendsPct": summary.get("trendsPct"),
            "suppressionReason": summary.get("suppressionReason"),
            "sourceURL": snapshot_row["source_url"],
            "updatedAt": snapshot_row["source_updated_at"],
            "refreshedAt": snapshot_row["updated_at"],
            "pricingTier": resolved_payload.get("pricingTier") if resolved_payload else payload.get("pricingTier"),
            "confidenceLabel": resolved_payload.get("confidenceLabel") if resolved_payload else payload.get("confidenceLabel"),
            "confidenceLevel": resolved_payload.get("confidenceLevel") if resolved_payload else payload.get("confidenceLevel"),
            "compCount": resolved_payload.get("compCount") if resolved_payload else payload.get("compCount"),
            "recentCompCount": resolved_payload.get("recentCompCount") if resolved_payload else payload.get("recentCompCount"),
            "lastSoldPrice": resolved_payload.get("lastSalePrice") if resolved_payload else payload.get("lastSalePrice"),
            "lastSoldAt": resolved_payload.get("lastSaleDate") if resolved_payload else payload.get("lastSaleDate"),
            "bucketKey": resolved_payload.get("bucketKey") if resolved_payload else payload.get("bucketKey"),
            "methodologySummary": resolved_payload.get("summary") if resolved_payload else payload.get("summary"),
            "payload": resolved_payload if resolved_payload else payload,
            "isFresh": is_fresh,
        }
        pricing = decorate_pricing_summary_with_fx(self.connection, pricing)
        if (
            pricing_context.is_graded
            and pricing is not None
            and pricing.get("variant")
            and not self._slab_variant_matches(
                pricing.get("variant"),
                preferred_variant=pricing_context.preferred_variant,
                variant_hints=pricing_context.variant_hints,
            )
        ):
            return None
        return pricing

    @staticmethod
    def _normalized_unique_card_ids(card_ids: list[Any]) -> list[str]:
        normalized_ids: list[str] = []
        seen_ids: set[str] = set()
        for raw_card_id in card_ids:
            card_id = str(raw_card_id or "").strip()
            if not card_id or card_id in seen_ids:
                continue
            seen_ids.add(card_id)
            normalized_ids.append(card_id)
        return normalized_ids

    def _price_snapshot_rows_by_card_id(self, card_ids: list[str]) -> dict[str, sqlite3.Row]:
        normalized_ids = self._normalized_unique_card_ids(card_ids)
        if not normalized_ids:
            return {}
        placeholders = ",".join("?" for _ in normalized_ids)
        rows = self.connection.execute(
            f"""
            SELECT *
            FROM card_price_snapshots
            WHERE card_id IN ({placeholders})
            """,
            normalized_ids,
        ).fetchall()
        return {
            str(row["card_id"] or "").strip(): row
            for row in rows
            if str(row["card_id"] or "").strip()
        }

    def _batched_card_hydration_context(
        self,
        card_ids: list[Any],
    ) -> tuple[dict[str, dict[str, Any]], dict[str, sqlite3.Row]]:
        normalized_ids = self._normalized_unique_card_ids(card_ids)
        if not normalized_ids:
            return {}, {}
        return (
            cards_by_ids(self.connection, normalized_ids),
            self._price_snapshot_rows_by_card_id(normalized_ids),
        )

    def _prime_card_lookup_cache(self, card_ids: list[Any]) -> None:
        normalized_ids = self._normalized_unique_card_ids(card_ids)
        if not normalized_ids:
            return
        missing_ids = [card_id for card_id in normalized_ids if card_id not in self._card_lookup_cache]
        if not missing_ids:
            return
        fetched_cards = cards_by_ids(self.connection, missing_ids)
        for card_id in missing_ids:
            self._card_lookup_cache.setdefault(card_id, fetched_cards.get(card_id))

    @staticmethod
    def _history_primary_price_value(point: dict[str, Any] | None) -> float | None:
        if not point:
            return None
        for key in ("market", "mid", "low", "high"):
            value = point.get(key)
            if isinstance(value, (int, float)):
                return float(value)
        return None

    @staticmethod
    def _since_added_change(
        *,
        baseline_price: Any,
        baseline_date: Any,
        current_price: float | None,
    ) -> tuple[float | None, float | None, str | None]:
        """(sinceAddedChangeAmount, sinceAddedChangePercent, sinceAddedBaselineDate)
        from the stored add-day baseline vs the price the list currently displays.

        A missing/zero baseline yields all-None (the row renders no pill); a
        priced baseline whose CURRENT price is unavailable keeps the baseline
        date but no arithmetic. Display is pure serve-time arithmetic — no
        history reads."""
        try:
            baseline = float(baseline_price) if baseline_price is not None else None
        except (TypeError, ValueError):
            baseline = None
        if baseline is None or baseline <= 0:
            return None, None, None
        normalized_date = str(baseline_date or "").strip() or None
        if current_price is None:
            return None, None, normalized_date
        amount = round(float(current_price) - baseline, 2)
        percent = round((float(current_price) - baseline) / baseline * 100.0, 2)
        return amount, percent, normalized_date

    @staticmethod
    def _history_display_condition_label(condition: str) -> str:
        normalized = str(condition or "").strip().upper()
        mapping = {
            "NM": "NM",
            "LP": "LP",
            "MP": "MP",
            "HP": "HP",
            "DM": "DM",
        }
        return mapping.get(normalized, normalized or "Unknown")

    @staticmethod
    def _portfolio_condition_code(condition: str | None) -> str | None:
        normalized = str(condition or "").strip().lower()
        if not normalized:
            return None
        mapping = {
            "nm": "NM",
            "lp": "LP",
            "mp": "MP",
            "hp": "HP",
            "dm": "DM",
            "near_mint": "NM",
            "lightly_played": "LP",
            "moderately_played": "MP",
            "heavily_played": "HP",
            "damaged": "DM",
        }
        return mapping.get(normalized)

    def _history_is_fresh(self, updated_at: str | None) -> bool:
        parsed = self._coerce_utc_datetime(updated_at)
        if parsed is None:
            return False
        return datetime.now(timezone.utc) - parsed <= timedelta(hours=24)

    def _snapshot_raw_contexts(self, card_id: str) -> dict[str, Any]:
        row = price_snapshot_row(self.connection, card_id)
        if row is not None:
            raw_contexts = _raw_contexts_payload(row["raw_contexts_json"])
        else:
            history_row = latest_price_history_row_for_card(
                self.connection,
                card_id,
                provider=pricing_provider(),
            )
            if history_row is None:
                return {}
            raw_contexts = _raw_contexts_payload(history_row["raw_contexts_json"])
        # Drop printings whose TCGplayer product id is mis-mapped to another card
        # (Scrydex collision) — otherwise the PDP shows a phantom variant carrying
        # the WRONG card's price/default. One chokepoint fixes chips + default +
        # headline, since all recompute from raw_contexts.
        suppressed = suppressed_raw_variant_labels(self.connection, card_id)
        if suppressed:
            raw_contexts = filter_suppressed_raw_variants(raw_contexts, suppressed)
        return raw_contexts

    def _snapshot_graded_contexts(self, card_id: str) -> dict[str, Any]:
        row = price_snapshot_row(self.connection, card_id)
        if row is not None:
            return _graded_contexts_payload(row["graded_contexts_json"])
        history_row = latest_price_history_row_for_card(
            self.connection,
            card_id,
            provider=pricing_provider(),
        )
        if history_row is None:
            return {}
        return _graded_contexts_payload(history_row["graded_contexts_json"])

    @staticmethod
    def _ordered_history_codes(
        values: list[str],
        *,
        preferred: str | None,
        priority: tuple[str, ...],
    ) -> list[str]:
        normalized_preferred = str(preferred or "").strip()
        normalized_priority = {value: index for index, value in enumerate(priority)}
        seen: set[str] = set()
        ordered: list[str] = []
        for value in values:
            cleaned = str(value or "").strip()
            if not cleaned or cleaned in seen:
                continue
            seen.add(cleaned)
            ordered.append(cleaned)

        def sort_key(value: str) -> tuple[int, int, str]:
            if normalized_preferred and value == normalized_preferred:
                return (0, 0, value)
            if value in normalized_priority:
                return (1, normalized_priority[value], value)
            return (2, len(normalized_priority), value)

        return sorted(ordered, key=sort_key)

    def _raw_history_variants(self, card_id: str) -> list[str]:
        row = price_snapshot_row(self.connection, card_id)
        raw_contexts = self._snapshot_raw_contexts(card_id)
        return self._ordered_history_codes(
            _raw_context_variants(raw_contexts),
            preferred=str(row["default_raw_variant"] or "").strip() or "Normal" if row is not None else "Normal",
            priority=("Normal", "Holofoil", "Reverse Holofoil"),
        )

    def _raw_history_conditions(self, card_id: str, variant: str | None) -> list[str]:
        if not variant:
            return []
        row = price_snapshot_row(self.connection, card_id)
        raw_contexts = self._snapshot_raw_contexts(card_id)
        return self._ordered_history_codes(
            _raw_context_conditions(raw_contexts, variant),
            preferred=str(row["default_raw_condition"] or "").strip().upper() or "NM" if row is not None else "NM",
            priority=("NM", "LP", "MP", "HP", "DM"),
        )

    def _raw_history_condition_options(self, card_id: str, variant: str | None) -> list[dict[str, Any]]:
        if not variant:
            return []
        options: list[dict[str, Any]] = []
        raw_contexts = self._snapshot_raw_contexts(card_id)
        for code in _raw_context_conditions(raw_contexts, variant):
            entry = _raw_context_entry(raw_contexts, variant=variant, condition=code)
            summary = _coerce_price_summary_from_entry(entry)
            if summary is None:
                continue
            current_price = self._history_primary_price_value(
                self._display_price_history_row(
                    {
                        "pricingMode": "raw",
                        "currencyCode": summary.get("currencyCode"),
                        "low": summary.get("low"),
                        "market": summary.get("market"),
                        "mid": summary.get("mid"),
                        "high": summary.get("high"),
                    }
                )
            )
            options.append(
                {
                    "id": code,
                    "label": self._history_display_condition_label(code),
                    "currentPrice": current_price,
                }
            )
        return options

    _RAW_CONDITION_FULL_LABELS = {
        "NM": "Near Mint",
        "LP": "Lightly Played",
        "MP": "Moderately Played",
        "HP": "Heavily Played",
        "DM": "Damaged",
    }

    def raw_pricing_matrix(self, card_id: str) -> dict[str, Any]:
        """Return the full variant x condition price matrix for a raw card.

        Reads from the SQLite snapshot/daily-history cache only. Never calls
        Scrydex. Returns an empty `variants` list when no cached data exists.
        """

        raw_contexts = self._snapshot_raw_contexts(card_id)
        variants_payload: list[dict[str, Any]] = []
        currency_code: str | None = None

        def variant_sort_key(label: str) -> tuple[int, int, str]:
            try:
                return (0, RAW_VARIANT_PRIORITY.index(label), label)
            except ValueError:
                return (1, 0, label)

        def condition_sort_key(code: str) -> tuple[int, int, str]:
            try:
                return (0, RAW_CONDITION_PRIORITY.index(code), code)
            except ValueError:
                return (1, 0, code)

        ordered_variants = sorted(_raw_context_variants(raw_contexts), key=variant_sort_key)
        for variant_label in ordered_variants:
            variant_key = ""
            condition_rows: list[dict[str, Any]] = []
            ordered_conditions = sorted(
                _raw_context_conditions(raw_contexts, variant_label),
                key=condition_sort_key,
            )
            for condition_code in ordered_conditions:
                entry = _raw_context_entry(
                    raw_contexts,
                    variant=variant_label,
                    condition=condition_code,
                )
                summary = _coerce_price_summary_from_entry(entry)
                if summary is None:
                    continue
                display = self._display_price_history_row(
                    {
                        "pricingMode": "raw",
                        "currencyCode": summary.get("currencyCode"),
                        "low": summary.get("low"),
                        "market": summary.get("market"),
                        "mid": summary.get("mid"),
                        "high": summary.get("high"),
                    }
                )
                entry_currency = str(display.get("currencyCode") or summary.get("currencyCode") or "")
                if entry_currency and currency_code is None:
                    currency_code = entry_currency
                payload = summary.get("payload") if isinstance(summary.get("payload"), dict) else {}
                if not variant_key:
                    variant_key = str(payload.get("variantKey") or payload.get("variant") or "").strip()
                condition_rows.append(
                    {
                        "code": condition_code,
                        "label": self._RAW_CONDITION_FULL_LABELS.get(
                            condition_code,
                            condition_code or "Unknown",
                        ),
                        "low": display.get("low"),
                        "mid": display.get("mid"),
                        "market": display.get("market"),
                        "high": display.get("high"),
                    }
                )
            if not condition_rows:
                continue
            variants_payload.append(
                {
                    "variant": variant_label,
                    "variantKey": variant_key or variant_label.lower().replace(" ", ""),
                    "conditions": condition_rows,
                }
            )

        return {
            "cardID": card_id,
            "currencyCode": currency_code or "USD",
            "variants": variants_payload,
        }

    def _history_variant_query_key(
        self,
        card_id: str,
        *,
        selected_variant: str | None,
        pricing_summary: dict[str, Any] | None,
    ) -> str | None:
        payload = (pricing_summary or {}).get("payload") if isinstance(pricing_summary, dict) else {}
        if isinstance(payload, dict):
            summary_variant = str((pricing_summary or {}).get("variant") or "").strip()
            summary_variant_key = str(payload.get("variantKey") or payload.get("variant") or "").strip()
            if selected_variant and selected_variant == summary_variant and summary_variant_key:
                return summary_variant_key
        if selected_variant:
            raw_contexts = self._snapshot_raw_contexts(card_id)
            entry = _raw_context_entry(raw_contexts, variant=selected_variant, condition="NM")
            summary = _coerce_price_summary_from_entry(entry)
            payload = (summary or {}).get("payload") if isinstance(summary, dict) else {}
            if isinstance(payload, dict):
                variant_key = str(payload.get("variantKey") or payload.get("variant") or "").strip()
                if variant_key:
                    return variant_key
        return None

    def _selected_raw_history_variant(
        self,
        card_id: str,
        *,
        requested_variant: str | None,
        pricing_summary: dict[str, Any] | None,
    ) -> str | None:
        available_variants = self._raw_history_variants(card_id)
        requested = str(requested_variant or "").strip() or None
        if requested and requested in available_variants:
            return requested
        pricing_variant = str((pricing_summary or {}).get("variant") or "").strip() or None
        if pricing_variant and pricing_variant in available_variants:
            return pricing_variant
        payload = (pricing_summary or {}).get("payload") if isinstance(pricing_summary, dict) else {}
        pricing_variant_key = str((payload or {}).get("variantKey") or (payload or {}).get("variant") or "").strip()
        pricing_variant_label = (
            re.sub(r"\s+", " ", re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", pricing_variant_key)).strip().title()
            if pricing_variant_key
            else None
        )
        if pricing_variant_label and pricing_variant_label in available_variants:
            return pricing_variant_label
        if requested and not available_variants:
            return requested
        if pricing_variant_label and not available_variants:
            return pricing_variant_label
        if pricing_variant and not available_variants:
            return pricing_variant
        return available_variants[0] if available_variants else None

    def _selected_raw_history_condition(
        self,
        card_id: str,
        *,
        variant: str | None,
        requested_condition: str | None,
    ) -> str | None:
        available_conditions = self._raw_history_conditions(card_id, variant)
        requested = self._portfolio_condition_code(requested_condition)
        if requested is None:
            requested = str(requested_condition or "").strip().upper() or None
        if requested and requested in available_conditions:
            return requested
        for candidate in ("NM", "LP", "MP", "HP", "DM"):
            if candidate in available_conditions:
                return candidate
        return available_conditions[0] if available_conditions else None

    def _history_delta_payload(self, points: list[dict[str, Any]], days: int) -> dict[str, Any] | None:
        if len(points) < 2:
            return None
        latest_point = points[-1]
        latest_price = self._history_primary_price_value(latest_point)
        latest_date = self._coerce_utc_datetime(f"{latest_point.get('date')}T00:00:00+00:00")
        if latest_price is None or latest_date is None:
            return None
        target_date = latest_date - timedelta(days=days)
        baseline_point = None
        for point in points:
            point_date = self._coerce_utc_datetime(f"{point.get('date')}T00:00:00+00:00")
            if point_date is None:
                continue
            if point_date <= target_date:
                baseline_point = point
        if baseline_point is None:
            baseline_point = points[0]
        baseline_price = self._history_primary_price_value(baseline_point)
        if baseline_price is None:
            return None
        price_change = latest_price - baseline_price
        percent_change = None if baseline_price == 0 else (price_change / baseline_price) * 100.0
        return {
            "days": days,
            "priceChange": round(price_change, 4),
            "percentChange": round(percent_change, 4) if percent_change is not None else None,
        }

    def _history_points_payload(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        points = [
            {
                "date": str(row.get("date") or ""),
                "market": row.get("market"),
                "low": row.get("low"),
                "mid": row.get("mid"),
                "high": row.get("high"),
            }
            for row in reversed(rows)
            if str(row.get("date") or "").strip()
        ]
        return points

    def _display_price_history_row(self, row: dict[str, Any]) -> dict[str, Any]:
        pricing = {
            "pricingMode": row.get("pricingMode"),
            "currencyCode": row.get("currencyCode"),
            "low": row.get("low"),
            "market": row.get("market"),
            "mid": row.get("mid"),
            "high": row.get("high"),
            "directLow": None,
            "trend": row.get("market") or row.get("mid") or row.get("low") or row.get("high"),
        }
        converted = decorate_pricing_summary_with_fx(self.connection, pricing)
        if converted is None:
            return row
        display_row = dict(row)
        for key in ("currencyCode", "low", "market", "mid", "high"):
            display_row[key] = converted.get(key)
        return display_row

    def _display_price_history_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [self._display_price_history_row(row) for row in rows]

    def _backfill_market_history_if_needed(
        self,
        card_id: str,
        *,
        pricing_context: PricingContext,
        days: int,
        selected_variant: str | None,
        pricing_summary: dict[str, Any] | None,
        history_is_fresh: bool,
    ) -> None:
        if history_is_fresh or not self._live_pricing_enabled():
            return
        if pricing_context.is_graded:
            if not pricing_context.grader or not pricing_context.grade:
                return
            payload = fetch_scrydex_price_history(
                card_id,
                days=days,
                company=pricing_context.grader,
                grade=pricing_context.grade,
            )
            persist_scrydex_price_history_payload(self.connection, card_id=card_id, payload=payload)
            return

        variant_key = self._history_variant_query_key(
            card_id,
            selected_variant=selected_variant,
            pricing_summary=pricing_summary,
        )
        payload = fetch_scrydex_price_history(
            card_id,
            days=days,
            variant=variant_key,
        )
        persist_scrydex_price_history_payload(self.connection, card_id=card_id, payload=payload)

    def _card_volume_level(self, card_id: str) -> Literal["low", "normal", "unknown"]:
        """Classify a card's recent pricing volume from card_price_history_daily.

        Looks at the trailing 30 days of rows for the card and returns:
        - "unknown" when there are fewer than 7 days of recorded history
        - "low" when there are >= 7 days but only one distinct
          `default_raw_market_price` value (flat/illiquid)
        - "normal" otherwise
        """
        row = self.connection.execute(
            """
            SELECT COUNT(*) AS days,
                   COUNT(DISTINCT default_raw_market_price) AS distinct_prices
            FROM card_price_history_daily
            WHERE card_id = ? AND price_date >= date('now','-30 days')
            """,
            (card_id,),
        ).fetchone()
        if row is None:
            return "unknown"
        try:
            days = int(row["days"] or 0)
        except (KeyError, TypeError, ValueError):
            days = 0
        try:
            distinct_prices = int(row["distinct_prices"] or 0)
        except (KeyError, TypeError, ValueError):
            distinct_prices = 0
        if days < 7:
            return "unknown"
        if distinct_prices <= 1:
            return "low"
        return "normal"

    def card_market_history(
        self,
        card_id: str,
        *,
        days: int = 30,
        grader: str | None = None,
        grade: str | None = None,
        cert_number: str | None = None,
        preferred_variant: str | None = None,
        condition: str | None = None,
    ) -> dict[str, Any] | None:
        pricing_context = (
            self._slab_pricing_context(
                grader=grader,
                grade=grade,
                cert_number=cert_number,
                preferred_variant=preferred_variant,
            )
            if grader or grade
            else self._raw_pricing_context()
        )
        card = card_by_id(self.connection, card_id)
        if card is None:
            return None

        days = max(7, min(int(days), 90))
        pricing_summary = self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context)

        if pricing_context.is_graded:
            selected_variant = str(preferred_variant or (pricing_summary or {}).get("variant") or "").strip() or None
            history_updated_at = latest_price_history_update_for_context(
                self.connection,
                card_id=card_id,
                pricing_mode="graded",
                provider=pricing_provider(),
                grader=pricing_context.grader,
                grade=pricing_context.grade,
            )
            self._backfill_market_history_if_needed(
                card_id,
                pricing_context=pricing_context,
                days=days,
                selected_variant=selected_variant,
                pricing_summary=pricing_summary,
                history_is_fresh=self._history_is_fresh(history_updated_at),
            )
            rows = price_history_rows_for_card(
                self.connection,
                card_id,
                pricing_mode="graded",
                provider=pricing_provider(),
                days=days,
                variant=selected_variant,
                grader=pricing_context.grader,
                grade=pricing_context.grade,
            )
            if not rows and selected_variant is not None:
                rows = price_history_rows_for_card(
                    self.connection,
                    card_id,
                    pricing_mode="graded",
                    provider=pricing_provider(),
                    days=days,
                    grader=pricing_context.grader,
                    grade=pricing_context.grade,
                )
            available_variants = [
                {"id": variant_name, "label": variant_name}
                for variant_name in _graded_variants_for_context(
                    self._snapshot_graded_contexts(card_id),
                    grader=pricing_context.grader,
                    grade=pricing_context.grade,
                )
            ]
            if selected_variant is None and available_variants:
                selected_variant = str(available_variants[0]["id"])
                rows = price_history_rows_for_card(
                    self.connection,
                    card_id,
                    pricing_mode="graded",
                    provider=pricing_provider(),
                    days=days,
                    variant=selected_variant,
                    grader=pricing_context.grader,
                    grade=pricing_context.grade,
                )
            rows = self._display_price_history_rows(rows)
            points = self._history_points_payload(rows)
            latest_point = points[-1] if points else None
            current_price = self._history_primary_price_value(latest_point) or self._primary_price_value(pricing_summary)
            currency_code = str((rows[0].get("currencyCode") if rows else None) or (pricing_summary or {}).get("currencyCode") or "USD")
            refreshed_at = history_updated_at or ((pricing_summary or {}).get("refreshedAt") if isinstance(pricing_summary, dict) else None)
            return {
                "cardID": card_id,
                "pricingMode": "graded",
                "currencyCode": currency_code,
                "currentPrice": current_price,
                "currentDate": latest_point.get("date") if latest_point else None,
                "points": points,
                "availableVariants": available_variants,
                "availableConditions": [],
                "selectedVariant": selected_variant,
                "selectedCondition": None,
                "deltas": {
                    "days7": self._history_delta_payload(points, 7),
                    "days14": self._history_delta_payload(points, 14),
                    "days30": self._history_delta_payload(points, 30),
                },
                "source": pricing_provider(),
                "isFresh": self._history_is_fresh(refreshed_at),
                "refreshedAt": refreshed_at,
                "livePricingEnabled": self._live_pricing_enabled(),
                # Graded pricing is condition-irrelevant; surface "normal" for
                # response-shape consistency so clients can rely on the field.
                "volumeLevel": "normal",
            }

        selected_variant = self._selected_raw_history_variant(
            card_id,
            requested_variant=preferred_variant,
            pricing_summary=pricing_summary,
        )
        history_updated_at = latest_price_history_update_for_context(
            self.connection,
            card_id=card_id,
            pricing_mode="raw",
            provider=pricing_provider(),
            variant=selected_variant,
        )
        self._backfill_market_history_if_needed(
            card_id,
            pricing_context=pricing_context,
            days=days,
            selected_variant=selected_variant,
            pricing_summary=pricing_summary,
            history_is_fresh=self._history_is_fresh(history_updated_at),
        )
        selected_variant = self._selected_raw_history_variant(
            card_id,
            requested_variant=preferred_variant,
            pricing_summary=pricing_summary,
        )
        selected_condition = self._selected_raw_history_condition(
            card_id,
            variant=selected_variant,
            requested_condition=condition,
        )
        rows = price_history_rows_for_card(
            self.connection,
            card_id,
            pricing_mode="raw",
            provider=pricing_provider(),
            days=days,
            variant=selected_variant,
            condition=selected_condition,
        )
        rows = self._display_price_history_rows(rows)
        available_variants = [
            {"id": variant_name, "label": variant_name}
            for variant_name in self._raw_history_variants(card_id)
        ]
        available_conditions = self._raw_history_condition_options(card_id, selected_variant)
        # Low-volume (illiquid/flat) and unknown-volume cards should not expose
        # non-NM condition pickers. Only NM has trustworthy pricing for those.
        volume_level = self._card_volume_level(card_id)
        if volume_level != "normal":
            available_conditions = [
                option for option in available_conditions if str(option.get("id") or "").upper() == "NM"
            ]
        points = self._history_points_payload(rows)
        latest_point = points[-1] if points else None
        current_price = self._history_primary_price_value(latest_point) or self._primary_price_value(pricing_summary)
        currency_code = str((rows[0].get("currencyCode") if rows else None) or (pricing_summary or {}).get("currencyCode") or "USD")
        refreshed_at = latest_price_history_update_for_context(
            self.connection,
            card_id=card_id,
            pricing_mode="raw",
            provider=pricing_provider(),
            variant=selected_variant,
            condition=selected_condition,
        ) or ((pricing_summary or {}).get("refreshedAt") if isinstance(pricing_summary, dict) else None)
        return {
            "cardID": card_id,
            "pricingMode": "raw",
            "currencyCode": currency_code,
            "currentPrice": current_price,
            "currentDate": latest_point.get("date") if latest_point else None,
            "points": points,
            "availableVariants": available_variants,
            "availableConditions": available_conditions,
            "selectedVariant": selected_variant,
            "selectedCondition": selected_condition,
            "deltas": {
                "days7": self._history_delta_payload(points, 7),
                "days14": self._history_delta_payload(points, 14),
                "days30": self._history_delta_payload(points, 30),
            },
            "source": pricing_provider(),
            "isFresh": self._history_is_fresh(refreshed_at),
            "refreshedAt": refreshed_at,
            "livePricingEnabled": self._live_pricing_enabled(),
            "volumeLevel": volume_level,
        }

    def card_price_trends(
        self,
        card_id: str,
        *,
        mode: str,
        variant: str | None = None,
        grader: str | None = None,
    ) -> dict[str, Any] | None:
        """Per-condition (raw) / per-grade (graded) price-trend list for a card.

        Read-only SQLite read of cached daily history + the current snapshot. No
        provider fetch, so it honors the live-pricing-off SQLite-only invariant.
        """
        if card_by_id(self.connection, card_id) is None:
            return None
        trend_list = card_price_trend_list(
            self.connection,
            card_id,
            mode=mode,
            provider=pricing_provider(),
            variant=variant,
            grader=grader,
        )
        return convert_price_trend_list_with_fx(self.connection, trend_list)

    @staticmethod
    def _prettify_variant_key(variant_key: str) -> str:
        s = str(variant_key or "").strip()
        if not s:
            return ""
        spaced = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)
        return spaced[:1].upper() + spaced[1:]

    def card_condition_history(
        self,
        card_id: str,
        *,
        lane: str = "raw",
        days: int = 365,
    ) -> dict[str, Any] | None:
        """Per-condition (raw) / per-grade (graded) price history for a card, read
        straight from the normalized ``card_price_history_cell`` table — one series
        per ``(variant, condition)`` (raw) or ``(grader, grade, variant)`` (graded),
        each a date-ordered list of points. Read-only SQLite (honors
        live-pricing-off); native currency, no FX (single-card view). Empty series
        are omitted. Returns None if the card doesn't exist."""
        if card_by_id(self.connection, card_id) is None:
            return None
        resolved_lane = "graded" if str(lane or "").strip().lower() == "graded" else "raw"
        clamped_days = max(7, min(int(days), 365))
        start_date = (datetime.now(timezone.utc).date() - timedelta(days=clamped_days)).isoformat()

        if resolved_lane == "raw":
            rows = self.connection.execute(
                """
                SELECT variant_key, condition, price_date, low, market, mid, high, currency_code
                FROM card_price_history_cell
                WHERE card_id = ? AND lane = 'raw' AND price_date >= ?
                ORDER BY variant_key, condition, price_date, updated_at
                """,
                (card_id, start_date),
            ).fetchall()
        else:
            rows = self.connection.execute(
                """
                SELECT grader, grade, variant_key, price_date, low, market, mid, high, currency_code
                FROM card_price_history_cell
                WHERE card_id = ? AND lane = 'graded' AND price_date >= ?
                ORDER BY grader, grade, variant_key, price_date, updated_at
                """,
                (card_id, start_date),
            ).fetchall()

        series_map: dict[tuple[str, ...], dict[str, Any]] = {}
        order: list[tuple[str, ...]] = []
        currency_counts: dict[str, int] = {}
        for r in rows:
            if resolved_lane == "raw":
                vk = str(r["variant_key"] or "")
                cond = str(r["condition"] or "")
                key = (vk, cond)
                if key not in series_map:
                    order.append(key)
                    series_map[key] = {
                        "key": f"{vk}|{cond}",
                        "label": (f"{self._prettify_variant_key(vk)} · {cond}" if vk else cond),
                        "variantKey": vk or None,
                        "condition": cond or None,
                        "grader": None,
                        "grade": None,
                        "points": [],
                    }
            else:
                grader = str(r["grader"] or "")
                grade = str(r["grade"] or "")
                vk = str(r["variant_key"] or "")
                key = (grader, grade, vk)
                if key not in series_map:
                    order.append(key)
                    label = f"{grader} {grade}".strip()
                    if vk:
                        label = f"{label} · {self._prettify_variant_key(vk)}"
                    series_map[key] = {
                        "key": f"{grader}|{grade}|{vk}",
                        "label": label,
                        "variantKey": vk or None,
                        "condition": None,
                        "grader": grader or None,
                        "grade": grade or None,
                        "points": [],
                    }
            cc = str(r["currency_code"] or "")
            if cc:
                currency_counts[cc] = currency_counts.get(cc, 0) + 1
            series_map[key]["points"].append(
                {
                    "date": r["price_date"],
                    "market": r["market"],
                    "low": r["low"],
                    "mid": r["mid"],
                    "high": r["high"],
                }
            )

        currency_code = max(currency_counts, key=currency_counts.get) if currency_counts else "USD"
        series = [series_map[k] for k in order if series_map[k]["points"]]
        return {
            "cardId": card_id,
            "lane": resolved_lane,
            "currencyCode": currency_code,
            "series": series,
        }

    def _portfolio_history_price_row_for_entry_on_day(
        self,
        entry: dict[str, Any],
        *,
        as_of_date: date,
        condition_code: str | None,
    ) -> dict[str, Any] | None:
        card_id = str(entry.get("cardID") or "").strip()
        if not card_id:
            return None

        row = latest_price_history_row_for_card(
            self.connection,
            card_id,
            provider=pricing_provider(),
            as_of_date=as_of_date.isoformat(),
        )
        return self._portfolio_history_price_row_from_history_row(
            entry,
            row=row,
            condition_code=condition_code,
        )

    def _portfolio_history_price_row_from_history_row(
        self,
        entry: dict[str, Any],
        *,
        row: sqlite3.Row | dict[str, Any] | None,
        condition_code: str | None,
        day_cells: list[Any] | None = None,
        require_condition_match: bool = False,
    ) -> dict[str, Any] | None:
        """Price one entry from a single day's history row/cells.

        ``require_condition_match`` (used by the day-change path) returns ``None``
        rather than a price when the requested raw condition cannot be resolved
        exactly — the resolvers otherwise fall back to a nearby/NM condition, which
        would diff e.g. an LP entry against the NM default and surface a phantom
        change. Day-over-day deltas must compare like-for-like or not at all.
        """
        if row is None:
            return None
        pricing_mode = "graded" if str(entry.get("itemKind") or "").strip().lower() == "slab" else "raw"
        grader = str(entry.get("grader") or "").strip() or None
        grade = str(entry.get("grade") or "").strip() or None
        variant_name = str(entry.get("variantName") or "").strip() or None

        # Phase 4: when the cell flag is on, resolve the per-day price from the
        # normalized cell table instead of this row's raw/graded JSON blobs. The
        # row still supplies card_id, price_date, the display currency, and the
        # default_raw_* fallback columns.
        #
        # `day_cells` may be pre-fetched in bulk by the dashboard (see
        # _load_portfolio_history_shared_inputs) to avoid a per-(card, day) query.
        # `None` means "not pre-fetched" → fall back to the single-day query;
        # an empty list means "this date genuinely has no cells".
        use_cells = price_history_cells_enabled()
        if not use_cells:
            day_cells = []
        elif day_cells is None:
            day_cells = price_history_cell_rows_for_day(
                self.connection,
                card_id=str(row["card_id"]),
                price_date=str(row["price_date"]),
            )

        if pricing_mode == "graded":
            if use_cells:
                graded_cell = resolve_graded_entry_from_cells(
                    day_cells, grader=grader, grade=grade, variant=variant_name
                )
                summary = _cell_summary_from_row(graded_cell) if graded_cell is not None else None
                if summary is None and variant_name:
                    graded_cell = resolve_graded_entry_from_cells(
                        day_cells, grader=grader, grade=grade, variant=None
                    )
                    summary = _cell_summary_from_row(graded_cell) if graded_cell is not None else None
            else:
                entry = _resolve_graded_context_entry(
                    _graded_contexts_payload(row["graded_contexts_json"]),
                    grader=grader,
                    grade=grade,
                    variant=variant_name,
                )
                summary = _coerce_price_summary_from_entry(entry)
                if summary is None and variant_name:
                    entry = _resolve_graded_context_entry(
                        _graded_contexts_payload(row["graded_contexts_json"]),
                        grader=grader,
                        grade=grade,
                        variant=None,
                    )
                    summary = _coerce_price_summary_from_entry(entry)
            if summary is None:
                return None
            return self._display_price_history_row(
                {
                    "pricingMode": "graded",
                    "currencyCode": summary.get("currencyCode"),
                    "low": summary.get("low"),
                    "market": summary.get("market"),
                    "mid": summary.get("mid"),
                    "high": summary.get("high"),
                    "date": row["price_date"],
                }
            )

        if use_cells:
            _, resolved_condition, summary = resolve_raw_summary_from_cells(
                day_cells,
                variant=variant_name,
                condition=condition_code,
            )
        else:
            _, resolved_condition, summary = _resolve_raw_context_summary(
                _raw_contexts_payload(row["raw_contexts_json"]),
                variant=variant_name,
                condition=condition_code,
            )
        # Like-for-like guard: when an exact condition is required, bail out if the
        # resolver had to substitute a different condition (the phantom-delta bug).
        requested_condition = _normalized_condition_code(condition_code) if condition_code else None
        if (
            require_condition_match
            and requested_condition
            and (
                summary is None
                or _normalized_condition_code(resolved_condition) != requested_condition
            )
        ):
            return None
        if summary is None and self._history_primary_price_value(
            {
                "market": row["default_raw_market_price"],
                "mid": row["default_raw_mid_price"],
                "low": row["default_raw_low_price"],
                "high": row["default_raw_high_price"],
            }
        ) is not None:
            # The default raw context is NM-by-default, not the requested condition;
            # never use it when an exact condition match is required.
            if require_condition_match and requested_condition:
                return None
            summary = {
                "currencyCode": row["display_currency_code"],
                "low": row["default_raw_low_price"],
                "market": row["default_raw_market_price"],
                "mid": row["default_raw_mid_price"],
                "high": row["default_raw_high_price"],
                "payload": {},
            }
        if summary is None:
            return None
        return self._display_price_history_row(
            {
                "pricingMode": "raw",
                "currencyCode": summary.get("currencyCode"),
                "low": summary.get("low"),
                "market": summary.get("market"),
                "mid": summary.get("mid"),
                "high": summary.get("high"),
                "date": row["price_date"],
            }
        )

    @staticmethod
    def _portfolio_history_context_key(
        entry: dict[str, Any],
        *,
        condition_code: str | None,
    ) -> tuple[str, str, str, str, str, str] | None:
        card_id = str(entry.get("cardID") or "").strip()
        if not card_id:
            return None
        pricing_mode = "graded" if str(entry.get("itemKind") or "").strip().lower() == "slab" else "raw"
        return (
            pricing_mode,
            card_id,
            str(entry.get("grader") or "").strip(),
            str(entry.get("grade") or "").strip(),
            str(entry.get("variantName") or "").strip(),
            str(condition_code or "").strip(),
        )

    # Non-blob columns of card_price_history_daily that the portfolio history
    # resolver actually reads (price_date, the default_raw_* price fields, the
    # display currency) plus the keys used for ordering/identity. The fat columns
    # (raw_contexts_json ~2.5KB, graded_contexts_json ~2.4KB, source_payload_json,
    # source_url) are excluded here and re-added selectively below.
    _PORTFOLIO_HISTORY_BASE_COLUMNS = (
        "card_id",
        "provider",
        "price_date",
        "display_currency_code",
        "default_raw_variant",
        "default_raw_condition",
        "default_raw_low_price",
        "default_raw_market_price",
        "default_raw_mid_price",
        "default_raw_high_price",
        "default_raw_direct_low_price",
        "default_raw_trend_price",
        "updated_at",
    )

    def _portfolio_history_select_columns(
        self,
        *,
        include_raw_json: bool,
        include_graded_json: bool,
        alias: str | None = None,
    ) -> str:
        """Column list for portfolio history reads. The raw/graded context JSON
        blobs are the bulk of each row (and of the whole table on disk, via
        overflow pages), but a raw-only portfolio never reads graded contexts and
        a slab-only portfolio never reads raw contexts. Selecting only the side(s)
        actually needed lets SQLite skip the unused blob's overflow pages — for a
        typical all-raw portfolio that is ~60MB less I/O per dashboard refresh,
        which is what makes the cold-cache read time out. The skipped column is
        aliased to NULL so the row shape (and the resolver) is unchanged.

        ``alias`` prefixes the real columns with a table alias (e.g. ``h.``) for
        use in a join where a bare column name would be ambiguous; the NULL-aliased
        skipped column keeps its output name so a UNION with the unaliased form
        stays column-compatible."""
        prefix = f"{alias}." if alias else ""
        columns = [f"{prefix}{col}" for col in self._PORTFOLIO_HISTORY_BASE_COLUMNS]
        columns.append(
            f"{prefix}raw_contexts_json" if include_raw_json else "NULL AS raw_contexts_json"
        )
        columns.append(
            f"{prefix}graded_contexts_json"
            if include_graded_json
            else "NULL AS graded_contexts_json"
        )
        return ", ".join(columns)

    def _portfolio_history_rows_by_card_id(
        self,
        *,
        card_ids: set[str],
        end_date: date,
        provider: str,
        include_raw_json: bool = True,
        include_graded_json: bool = True,
        start_date: date | None = None,
    ) -> dict[str, list[sqlite3.Row]]:
        # When the cell table is the price-history source, the per-day resolver
        # (_portfolio_history_price_row_from_history_row) reads every price from
        # cells and never touches these JSON blobs — so reading them is pure dead
        # weight: ~500MB+ of overflow-page I/O per dashboard refresh on a large
        # portfolio, which is what makes the cold-cache dashboard read time out.
        # Skip them; the NULL-aliased columns keep the row shape (and the
        # resolver) unchanged, so cells-mode output is byte-identical.
        if price_history_cells_enabled():
            include_raw_json = False
            include_graded_json = False
        rows_by_card_id: dict[str, list[sqlite3.Row]] = {}
        ordered_card_ids = sorted(card_id for card_id in card_ids if str(card_id or "").strip())
        select_columns = self._portfolio_history_select_columns(
            include_raw_json=include_raw_json,
            include_graded_json=include_graded_json,
        )
        for start in range(0, len(ordered_card_ids), 400):
            chunk = ordered_card_ids[start : start + 400]
            if not chunk:
                continue
            placeholders = ",".join("?" for _ in chunk)
            if start_date is None:
                # Full history — every range can be plotted from one shared read
                # (all-six / prewarm). Unchanged behaviour.
                rows = self.connection.execute(
                    f"""
                    SELECT {select_columns}
                    FROM card_price_history_daily
                    WHERE provider = ?
                      AND card_id IN ({placeholders})
                      AND price_date <= ?
                    ORDER BY card_id ASC, price_date ASC, updated_at ASC
                    """,
                    [provider, *chunk, end_date.isoformat()],
                ).fetchall()
            else:
                # Open range: read only the plotted window [start_date, end_date]
                # plus each card's single carry-in row (its latest snapshot strictly
                # before start_date) needed to value the first day when no snapshot
                # lands exactly on start_date. For a 1W open range this is ~8x fewer
                # rows than the full history, and the full read is the dominant
                # cold-disk cost of the first Collection load. The carry-in is
                # fetched via a MAX(price_date) index-aggregate (≈one row per card);
                # the outer ORDER BY (card_id, price_date, updated_at) reproduces the
                # full read's row order so the per-day resolver walk is identical.
                start_iso = start_date.isoformat()
                carry_columns = self._portfolio_history_select_columns(
                    include_raw_json=include_raw_json,
                    include_graded_json=include_graded_json,
                    alias="h",
                )
                rows = self.connection.execute(
                    f"""
                    SELECT * FROM (
                        SELECT {select_columns}
                        FROM card_price_history_daily
                        WHERE provider = ?
                          AND card_id IN ({placeholders})
                          AND price_date >= ?
                          AND price_date <= ?
                        UNION ALL
                        SELECT {carry_columns}
                        FROM card_price_history_daily AS h
                        JOIN (
                            SELECT card_id, MAX(price_date) AS carry_date
                            FROM card_price_history_daily
                            WHERE provider = ?
                              AND card_id IN ({placeholders})
                              AND price_date < ?
                            GROUP BY card_id
                        ) AS carry
                          ON carry.card_id = h.card_id
                         AND carry.carry_date = h.price_date
                        WHERE h.provider = ?
                          AND h.card_id IN ({placeholders})
                          AND h.price_date < ?
                    )
                    ORDER BY card_id ASC, price_date ASC, updated_at ASC
                    """,
                    [
                        provider, *chunk, start_iso, end_date.isoformat(),
                        provider, *chunk, start_iso,
                        provider, *chunk, start_iso,
                    ],
                ).fetchall()
            for row in rows:
                card_id = str(row["card_id"] or "").strip()
                if not card_id:
                    continue
                rows_by_card_id.setdefault(card_id, []).append(row)
        return rows_by_card_id

    def _portfolio_history_series_for_context(
        self,
        entry: dict[str, Any],
        *,
        condition_code: str | None,
        history_rows: list[sqlite3.Row],
        day_dates: list[date],
        cells_by_date: dict[str, list[Any]] | None = None,
    ) -> list[dict[str, Any] | None]:
        latest_row: sqlite3.Row | None = None
        row_index = 0
        series: list[dict[str, Any] | None] = []
        for day_value in day_dates:
            day_iso = day_value.isoformat()
            while row_index < len(history_rows) and str(history_rows[row_index]["price_date"] or "") <= day_iso:
                latest_row = history_rows[row_index]
                row_index += 1
            # Hand the resolver the pre-fetched cells for this row's date (bulk
            # path); `None` keeps the per-day-query fallback for callers that
            # don't pre-fetch.
            day_cells = (
                cells_by_date.get(str(latest_row["price_date"] or ""), [])
                if cells_by_date is not None and latest_row is not None
                else None
            )
            series.append(
                self._portfolio_history_price_row_from_history_row(
                    entry,
                    row=latest_row,
                    condition_code=condition_code,
                    day_cells=day_cells,
                )
            )
        return series

    def _yesterday_price_history_row_for_card(
        self,
        card_id: str,
        *,
        time_zone_name: str | None = None,
    ) -> sqlite3.Row | None:
        """Latest price-history row dated strictly before today (in the local tz).

        Returns ``None`` when no snapshot exists for any prior day. Local backends
        that do not run the daily snapshot job will see this naturally.
        """
        normalized_card_id = str(card_id or "").strip()
        if not normalized_card_id:
            return None
        time_zone = self._portfolio_time_zone(time_zone_name)
        today_iso = datetime.now(time_zone).date().isoformat()
        return self.connection.execute(
            """
            SELECT *
            FROM card_price_history_daily
            WHERE card_id = ? AND provider = ? AND price_date < ?
            ORDER BY price_date DESC, updated_at DESC
            LIMIT 1
            """,
            (normalized_card_id, pricing_provider(), today_iso),
        ).fetchone()

    def _latest_price_history_rows_by_card_id(
        self,
        normalized_ids: list[str],
        *,
        provider: str,
        cutoff_iso: str,
        strict: bool,
    ) -> dict[str, sqlite3.Row | None]:
        """For each card, the single latest ``card_price_history_daily`` row whose
        ``price_date`` is ``< cutoff_iso`` (``strict``) or ``<= cutoff_iso``.

        Fetches ONLY that one row per card via a ``MAX(price_date) GROUP BY card_id``
        index-aggregate joined back to the table, instead of reading the card's
        ENTIRE history and discarding all but the latest. The old "read all history,
        keep the first row per card" shape over-read ~79x (≈12k index rows for a
        151-card owner) and, cold, was an ~18s scan that dominated the Collection
        dashboard load. The ``MAX``/join reads ≈one index entry per card.

        Row shape is ``SELECT *`` — byte-identical to the per-card
        ``_yesterday_price_history_row_for_card`` this batches, in both price-history
        modes: the day-change resolver ignores the JSON blobs in cells mode, and at
        one row per card their overflow pages are negligible. Ordering the joined
        rows by (card_id, updated_at DESC) and keeping the first per card reproduces
        the per-card ``ORDER BY price_date DESC, updated_at DESC LIMIT 1`` exactly."""
        op = "<" if strict else "<="
        result: dict[str, sqlite3.Row | None] = {}
        for start in range(0, len(normalized_ids), 400):
            chunk = normalized_ids[start:start + 400]
            if not chunk:
                continue
            placeholders = ",".join("?" for _ in chunk)
            rows = self.connection.execute(
                f"""
                SELECT h.*
                FROM card_price_history_daily AS h
                JOIN (
                    SELECT card_id, MAX(price_date) AS latest_price_date
                    FROM card_price_history_daily
                    WHERE provider = ?
                      AND price_date {op} ?
                      AND card_id IN ({placeholders})
                    GROUP BY card_id
                ) AS latest
                  ON latest.card_id = h.card_id
                 AND latest.latest_price_date = h.price_date
                WHERE h.provider = ?
                  AND h.price_date {op} ?
                  AND h.card_id IN ({placeholders})
                ORDER BY h.card_id ASC, h.updated_at DESC
                """,
                (provider, cutoff_iso, *chunk, provider, cutoff_iso, *chunk),
            ).fetchall()
            for row in rows:
                cid = str(row["card_id"] or "").strip()
                if cid and cid not in result:
                    result[cid] = row
        return result

    def _yesterday_price_history_rows_by_card_id(
        self,
        card_ids: list[str],
        *,
        time_zone_name: str | None = None,
    ) -> dict[str, sqlite3.Row | None]:
        """Batched form of ``_yesterday_price_history_row_for_card``: the latest
        price-history row dated strictly before today for each card, fetching only
        that one row per card (see ``_latest_price_history_rows_by_card_id``)."""
        normalized_ids = self._normalized_unique_card_ids(list(card_ids))
        if not normalized_ids:
            return {}
        time_zone = self._portfolio_time_zone(time_zone_name)
        today_iso = datetime.now(time_zone).date().isoformat()
        return self._latest_price_history_rows_by_card_id(
            normalized_ids,
            provider=pricing_provider(),
            cutoff_iso=today_iso,
            strict=True,
        )

    def _price_history_rows_on_or_before_by_card_id(
        self,
        card_ids: list[str],
        *,
        cutoff_date_iso: str,
    ) -> dict[str, sqlite3.Row | None]:
        """Latest price-history row dated on or before ``cutoff_date_iso`` for each
        card (e.g. ~30 days ago for Insights), fetching only that one row per card
        (see ``_latest_price_history_rows_by_card_id``)."""
        normalized_ids = self._normalized_unique_card_ids(list(card_ids))
        if not normalized_ids:
            return {}
        return self._latest_price_history_rows_by_card_id(
            normalized_ids,
            provider=pricing_provider(),
            cutoff_iso=cutoff_date_iso,
            strict=False,
        )

    def _earliest_price_history_rows_by_card_id(
        self,
        card_ids: list[str],
    ) -> dict[str, sqlite3.Row | None]:
        """Each card's EARLIEST price-history row (``MIN(price_date)``), one row
        per card via the same index-aggregate shape as
        ``_latest_price_history_rows_by_card_id``. Used by the since-added
        baseline backfill: entries added before tracking began fall back to the
        first tracked price, with ``added_market_date`` carrying that honest
        date so the UI can label "since we started tracking it"."""
        normalized_ids = self._normalized_unique_card_ids(list(card_ids))
        if not normalized_ids:
            return {}
        provider = pricing_provider()
        result: dict[str, sqlite3.Row | None] = {}
        for start in range(0, len(normalized_ids), 400):
            chunk = normalized_ids[start:start + 400]
            if not chunk:
                continue
            placeholders = ",".join("?" for _ in chunk)
            rows = self.connection.execute(
                f"""
                SELECT h.*
                FROM card_price_history_daily AS h
                JOIN (
                    SELECT card_id, MIN(price_date) AS earliest_price_date
                    FROM card_price_history_daily
                    WHERE provider = ?
                      AND card_id IN ({placeholders})
                    GROUP BY card_id
                ) AS earliest
                  ON earliest.card_id = h.card_id
                 AND earliest.earliest_price_date = h.price_date
                WHERE h.provider = ?
                  AND h.card_id IN ({placeholders})
                ORDER BY h.card_id ASC, h.updated_at DESC
                """,
                (provider, *chunk, provider, *chunk),
            ).fetchall()
            for row in rows:
                cid = str(row["card_id"] or "").strip()
                if cid and cid not in result:
                    result[cid] = row
        return result

    def _price_history_cells_by_card_and_date(
        self,
        *,
        card_ids: list[str],
        price_dates: list[str],
    ) -> dict[tuple[str, str], list[Any]]:
        """All price-history cells for the given (card_id, price_date) space in ONE
        chunked query, grouped by (card_id, price_date). Used to feed ``day_cells``
        to ``_portfolio_history_price_row_from_history_row`` in a loop so it never
        falls back to a per-(card, day) cell query — the cold N+1 that made the
        Insights ``transaction_insights`` compute take ~44s for a 126-card owner.
        Daily snapshots mean cards share dates, so the date set is tiny and the
        card×date over-fetch is bounded to a single indexed scan. Empty in JSON
        mode so callers keep ``day_cells=None`` (their JSON-blob path)."""
        if not price_history_cells_enabled():
            return {}
        cards = [c for c in {str(x or "").strip() for x in card_ids} if c]
        dates = [d for d in {str(x or "").strip() for x in price_dates} if d]
        if not cards or not dates:
            return {}
        result: dict[tuple[str, str], list[Any]] = {}
        try:
            for cstart in range(0, len(cards), 400):
                cchunk = cards[cstart:cstart + 400]
                cph = ",".join("?" for _ in cchunk)
                for dstart in range(0, len(dates), 400):
                    dchunk = dates[dstart:dstart + 400]
                    dph = ",".join("?" for _ in dchunk)
                    rows = self.connection.execute(
                        f"""
                        SELECT * FROM card_price_history_cell
                        WHERE provider = ?
                          AND card_id IN ({cph})
                          AND price_date IN ({dph})
                        ORDER BY +rowid
                        """,
                        (pricing_provider(), *cchunk, *dchunk),
                    ).fetchall()
                    for row in rows:
                        key = (
                            str(row["card_id"] or "").strip(),
                            str(row["price_date"] or "").strip(),
                        )
                        result.setdefault(key, []).append(row)
        except sqlite3.OperationalError:
            # Table absent (cells flag on but not yet migrated) → let callers fall
            # back to their per-day path rather than crashing the insights payload.
            return {}
        return result

    def _latest_day_cells_by_card_id(
        self, card_ids: list[str]
    ) -> dict[str, list[Any]]:
        """``card_id -> the normalized cells for that card's LATEST price_date``,
        pre-fetched in TWO bulk queries total (one for the latest date per card,
        one for the cells across those (card, date) pairs) so the current-price
        resolver in a loop (``deck_entries``) reads no JSON blobs and issues no
        per-card cell query — i.e. no N+1. The snapshot row carries no price_date,
        so its CURRENT price corresponds to the newest ``card_price_history_daily``
        date for the card (the daily sync writes the snapshot and that day's row
        together); cells are keyed by that date. The latest-date lookup rides the
        MAX+join aggregate with a far-future cutoff (``<= 9999-12-31`` == "the
        newest row, period"). Empty in JSON mode so callers keep
        ``day_cells=None`` (their JSON-blob path)."""
        if not price_history_cells_enabled():
            return {}
        normalized_ids = self._normalized_unique_card_ids(list(card_ids))
        if not normalized_ids:
            return {}
        latest_rows = self._latest_price_history_rows_by_card_id(
            normalized_ids,
            provider=pricing_provider(),
            cutoff_iso="9999-12-31",
            strict=False,
        )
        # Map each card to its latest date, and gather the distinct dates so the
        # cell fan-out is a single bounded indexed scan (cards share daily dates).
        latest_date_by_card: dict[str, str] = {}
        for card_id, row in latest_rows.items():
            if row is None:
                continue
            price_date = str(row["price_date"] or "").strip()
            if price_date:
                latest_date_by_card[card_id] = price_date
        if not latest_date_by_card:
            return {}
        cells_by_card_date = self._price_history_cells_by_card_and_date(
            card_ids=list(latest_date_by_card.keys()),
            price_dates=list({d for d in latest_date_by_card.values()}),
        )
        result: dict[str, list[Any]] = {}
        for card_id, price_date in latest_date_by_card.items():
            result[card_id] = cells_by_card_date.get((card_id, price_date), [])
        return result

    def _day_change_for_entry(
        self,
        *,
        card_id: str,
        item_kind: str | None,
        grader: str | None,
        grade: str | None,
        variant_name: str | None,
        condition_code: str | None,
        today_pricing: dict[str, Any] | None,
        time_zone_name: str | None = None,
        yesterday_rows_by_card_id: dict[str, sqlite3.Row | None] | None = None,
    ) -> tuple[float | None, float | None]:
        """Compute (dayChangeAmount, dayChangePercent) for a single inventory entry.

        Returns ``(None, None)`` when no yesterday snapshot exists (e.g. the
        daily snapshot job has not run on this server yet) or when today's
        price is unavailable. Returns ``(amount, None)`` when yesterday's
        primary price was 0 (percent change is undefined).
        """
        today_price = self._history_primary_price_value(today_pricing)
        if today_price is None:
            return None, None
        if yesterday_rows_by_card_id is not None:
            # Batched lookup (one query for the whole page) — equivalent to the
            # per-card LIMIT-1 query; a missing card_id means "no prior snapshot".
            yesterday_row = yesterday_rows_by_card_id.get(str(card_id or "").strip())
        else:
            yesterday_row = self._yesterday_price_history_row_for_card(
                card_id,
                time_zone_name=time_zone_name,
            )
        if yesterday_row is None:
            return None, None
        # Price the day-ago snapshot for the SAME printing today's price used.
        # When the entry has no explicit variant (e.g. a raw vintage card owned
        # without a chosen printing), today's live price falls back to the
        # snapshot's default printing (e.g. "Unlimited Holofoil"), but the day-ago
        # resolver would independently re-pick a default — and its priority list is
        # modern-only, so it fell back alphabetically to "1st Edition". That diffed
        # Unlimited ($543.07) against 1st Edition ($165.50) and reported a phantom
        # +$377.57 "day change". Carry today's resolved variant forward so both
        # sides compare like-for-like (variant + condition for raw, grade + variant
        # for graded).
        today_variant = (
            str(today_pricing.get("variant") or "").strip() or None
            if isinstance(today_pricing, dict)
            else None
        )
        effective_variant = variant_name or today_variant
        # Deck-entry conditions are stored as long-form codes (e.g. ``near_mint``).
        # ``_portfolio_history_price_row_from_history_row`` expects the
        # short-form raw context key (``NM``/``LP``/...) used inside the
        # raw_contexts JSON, so normalize before lookup.
        history_entry = {
            "cardID": card_id,
            "itemKind": "slab" if str(item_kind or "").strip().lower() == "slab" else "raw",
            "grader": grader,
            "grade": grade,
            "variantName": effective_variant,
        }
        yesterday_pricing = self._portfolio_history_price_row_from_history_row(
            history_entry,
            row=yesterday_row,
            condition_code=self._portfolio_condition_code(condition_code),
            # Compare like-for-like: if yesterday can't price this exact condition,
            # report "no change" rather than diffing against the NM default.
            require_condition_match=True,
        )
        yesterday_price = self._history_primary_price_value(yesterday_pricing)
        if yesterday_price is None:
            return None, None
        amount = round(float(today_price) - float(yesterday_price), 4)
        if yesterday_price == 0:
            return amount, None
        percent = round((amount / float(yesterday_price)) * 100.0, 4)
        return amount, percent

    def _portfolio_history_entry_rows(self, owner_user_id: str) -> list[sqlite3.Row]:
        """Owner's deck entries for portfolio-history math. Single SQL source so
        the standalone path and the consolidated shared-inputs loader stay in
        lockstep."""
        return self.connection.execute(
            """
            SELECT
                id,
                item_kind,
                card_id,
                quantity,
                grader,
                grade,
                cert_number,
                variant_name,
                condition,
                cost_basis_total,
                cost_basis_currency_code,
                added_at
            FROM deck_entries
            WHERE owner_user_id = ?
            ORDER BY added_at ASC, id ASC
            """,
            (owner_user_id,),
        ).fetchall()

    def _portfolio_history_event_rows(self, owner_user_id: str) -> list[sqlite3.Row]:
        """Owner's deck-entry events (with sale cost basis) for portfolio-history
        math. Single SQL source shared by the standalone and consolidated paths."""
        return self.connection.execute(
            """
            SELECT
                deck_entry_events.id,
                deck_entry_events.deck_entry_id,
                deck_entry_events.card_id,
                deck_entry_events.event_kind,
                deck_entry_events.quantity_delta,
                deck_entry_events.unit_price,
                deck_entry_events.total_price,
                deck_entry_events.currency_code,
                deck_entry_events.payment_method,
                deck_entry_events.condition,
                deck_entry_events.grader,
                deck_entry_events.grade,
                deck_entry_events.cert_number,
                deck_entry_events.variant_name,
                deck_entry_events.sale_id,
                sale_events.cost_basis_total AS sale_cost_basis_total,
                deck_entry_events.source_scan_id,
                deck_entry_events.source_confirmation_id,
                deck_entry_events.created_at
            FROM deck_entry_events
            LEFT JOIN sale_events
                ON sale_events.id = deck_entry_events.sale_id
            WHERE deck_entry_events.owner_user_id = ?
            ORDER BY deck_entry_events.created_at ASC, deck_entry_events.id ASC
            """,
            (owner_user_id,),
        ).fetchall()

    def _range_scoped_cells_by_card_date(
        self,
        history_rows_by_card_id: dict[str, list[sqlite3.Row]],
        *,
        start_date: date,
        end_date: date,
    ) -> dict[str, dict[str, list[Any]]] | None:
        """Bulk-prefetch the price-history cells the series resolver will touch for
        THIS range only, so a single range (the dashboard's open range, or an
        on-demand range) loads ~range-window days of cells instead of every day of
        history. The dates the resolver actually hits for [start, end] are the
        daily-row dates inside the window PLUS the one carry-in row just before the
        window (it prices the range's early days). Returns None in JSON mode so the
        resolver keeps its per-day-query fallback."""
        if not price_history_cells_enabled():
            return None
        start_iso = start_date.isoformat()
        end_iso = end_date.isoformat()
        # First pass: work out, per card, exactly which dates the resolver will hit
        # (the daily-row dates inside the window plus the one carry-in row before it).
        needed_by_card: dict[str, set[str]] = {}
        all_dates: set[str] = set()
        for card_id, rows in history_rows_by_card_id.items():
            needed: set[str] = set()
            carry_in: str | None = None
            for row in rows:  # rows are sorted ascending by price_date
                price_date = str(row["price_date"] or "").strip()
                if not price_date:
                    continue
                if price_date < start_iso:
                    carry_in = price_date  # keep the latest row before the window
                elif price_date <= end_iso:
                    needed.add(price_date)
            if carry_in is not None:
                needed.add(carry_in)
            if needed:
                needed_by_card[card_id] = needed
                all_dates.update(needed)
        if not needed_by_card:
            return {}
        # One batched, projected read for the WHOLE portfolio instead of a query per
        # card (the old N+1 that pinned the box on a large collection). Daily snapshot
        # dates are shared across cards, so the union of dates is small.
        grouped = price_history_cell_portfolio_rows_by_card_date(
            self.connection,
            provider=pricing_provider(),
            card_ids=needed_by_card.keys(),
            price_dates=all_dates,
        )
        # Re-scope each card to its OWN needed dates so the output is identical to the
        # per-card read (extra union dates a card may carry are never looked up anyway).
        result: dict[str, dict[str, list[Any]]] = {}
        for card_id, needed in needed_by_card.items():
            by_date = grouped.get(card_id)
            if not by_date:
                result[card_id] = {}
                continue
            result[card_id] = {date: by_date[date] for date in needed if date in by_date}
        return result

    def _portfolio_history_window_start(
        self, range_labels: list[str] | None, *, time_zone_name: str | None
    ) -> date | None:
        """Earliest ``start_date`` across ``range_labels`` — the widest window the
        shared daily-history read must cover so every requested range can still be
        plotted from it. Computed identically to ``deck_history`` (same
        ``_portfolio_date_bounds`` + earliest-priced clamp) so the scoped read never
        drops a day a range would chart. ``None`` (read full history) when no labels
        are given — the all-six / prewarm path, where the widest range is ALL anyway."""
        if not range_labels:
            return None
        earliest_at = self._portfolio_earliest_activity_at()
        earliest_priced_date = self._portfolio_earliest_priced_date()
        window_start: date | None = None
        for label in range_labels:
            normalized = self._normalize_portfolio_range_label(label)
            earliest_for_label = (
                earliest_at
                if normalized in {"1W", "30D", "90D", "YTD", "1Y", "ALL"}
                else None
            )
            _tz, start_date, end_date = self._portfolio_date_bounds(
                days=365,
                range_label=normalized,
                time_zone_name=time_zone_name,
                earliest_at=earliest_for_label,
            )
            if earliest_priced_date is not None and earliest_priced_date > start_date:
                start_date = min(earliest_priced_date, end_date)
            window_start = start_date if window_start is None else min(window_start, start_date)
        return window_start

    def _load_portfolio_history_shared_inputs(
        self, *, time_zone_name: str | None = None, range_labels: list[str] | None = None
    ) -> dict[str, Any]:
        """Fetch the range-independent inputs deck_history needs (entries, events,
        and the daily price-history rows) ONCE so the dashboard can compute the
        requested range(s) without re-reading them per range. ``end_date`` mirrors
        _portfolio_date_bounds (always today in the resolved tz).

        When ``range_labels`` is given, the daily read is scoped to the widest of
        those ranges' windows (+ per-card carry-in) instead of full history — the
        open Collection range (1W) then reads ~8x fewer rows, which was the dominant
        cold-disk cost of the first load. ``None`` reads full history for the
        all-six / prewarm path."""
        owner_user_id = self._current_owner_user_id()
        time_zone = self._portfolio_time_zone(time_zone_name)
        end_date = datetime.now(time_zone).date()
        window_start = self._portfolio_history_window_start(
            range_labels, time_zone_name=time_zone_name
        )
        entry_rows = self._portfolio_history_entry_rows(owner_user_id)
        event_rows = self._portfolio_history_event_rows(owner_user_id)
        # Pricing mode mirrors _portfolio_history_price_row_from_history_row: slab
        # entries resolve against graded_contexts_json, everything else against
        # raw_contexts_json. Only load the blob side(s) the portfolio can use so a
        # raw-only (or slab-only) portfolio skips reading the other ~2.5KB/row blob.
        entry_kinds = {str(row["item_kind"] or "").strip().lower() for row in entry_rows}
        include_graded_json = "slab" in entry_kinds
        include_raw_json = any(kind != "slab" for kind in entry_kinds) or not entry_kinds
        history_rows_by_card_id = self._portfolio_history_rows_by_card_id(
            card_ids={str(row["card_id"] or "").strip() for row in entry_rows},
            end_date=end_date,
            provider=pricing_provider(),
            include_raw_json=include_raw_json,
            include_graded_json=include_graded_json,
            start_date=window_start,
        )
        # NOTE: the price-history CELLS are no longer prefetched here. Each
        # deck_history call now bulk-prefetches only ITS range's cells via
        # _range_scoped_cells_by_card_date, so the dashboard's open range loads a
        # small window instead of all of history. shared_inputs still shares the
        # range-independent entries/events/daily-rows across whatever ranges run.
        return {
            "entry_rows": entry_rows,
            "event_rows": event_rows,
            "history_rows_by_card_id": history_rows_by_card_id,
        }

    def deck_history(
        self,
        *,
        days: int = 30,
        range_label: str | None = None,
        time_zone_name: str | None = None,
        shared_inputs: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        normalized_range = self._normalize_portfolio_range_label(range_label)
        earliest_at: datetime | None = None
        if normalized_range in {"1W", "30D", "90D", "YTD", "1Y", "ALL"}:
            earliest_at = self._portfolio_earliest_activity_at()
        time_zone, start_date, end_date = self._portfolio_date_bounds(
            days=days,
            range_label=normalized_range,
            time_zone_name=time_zone_name,
            earliest_at=earliest_at,
        )
        # Don't plot days before price history exists: those days have no price to
        # value the portfolio, so they read $0 and crash the chart/baseline to zero
        # (e.g. a 3M window today reaches ~2 weeks before the 2026-04-16 history
        # floor). Clamp the window start up to the first priced day so over-length
        # ranges show "since data began" instead of a leading run of $0.
        earliest_priced_date = self._portfolio_earliest_priced_date()
        if earliest_priced_date is not None and earliest_priced_date > start_date:
            start_date = min(earliest_priced_date, end_date)

        entry_rows = (
            shared_inputs["entry_rows"]
            if shared_inputs is not None
            else self._portfolio_history_entry_rows(owner_user_id)
        )
        if not entry_rows:
            return {
                "range": normalized_range or "30D",
                "currencyCode": "USD",
                "summary": {
                    "currentValue": 0.0,
                    "startValue": 0.0,
                    "deltaValue": 0.0,
                    "deltaPercent": None,
                },
                "coverage": {
                    "pricedCardCount": 0,
                    "excludedCardCount": 0,
                },
                "points": [],
                "isFresh": self._scrydex_full_catalog_sync_is_fresh(),
                "refreshedAt": utc_now(),
            }

        snapshot_by_id: dict[str, dict[str, Any]] = {}
        condition_codes_by_entry_id: dict[str, set[str | None]] = {}
        for row in entry_rows:
            deck_entry_id = str(row["id"] or "").strip()
            if not deck_entry_id:
                continue
            snapshot = {
                "deckEntryID": deck_entry_id,
                "itemKind": str(row["item_kind"] or "").strip(),
                "cardID": str(row["card_id"] or "").strip(),
                "quantity": max(0, int(row["quantity"] or 0)),
                "grader": str(row["grader"] or "").strip() or None,
                "grade": str(row["grade"] or "").strip() or None,
                "certNumber": str(row["cert_number"] or "").strip() or None,
                "variantName": str(row["variant_name"] or "").strip() or None,
                "condition": str(row["condition"] or "").strip() or None,
                "costBasisTotal": float(row["cost_basis_total"] or 0.0),
                "costBasisCurrencyCode": str(row["cost_basis_currency_code"] or "").strip() or None,
                "addedAt": str(row["added_at"] or "").strip() or None,
            }
            snapshot_by_id[deck_entry_id] = snapshot
            condition_codes_by_entry_id[deck_entry_id] = {self._portfolio_condition_code(snapshot.get("condition"))}

        event_rows = (
            shared_inputs["event_rows"]
            if shared_inputs is not None
            else self._portfolio_history_event_rows(owner_user_id)
        )

        seen_event_entries: set[str] = set()
        timeline: list[dict[str, Any]] = []
        for row in event_rows:
            deck_entry_id = str(row["deck_entry_id"] or "").strip()
            if not deck_entry_id:
                continue
            created_at = self._coerce_utc_datetime(str(row["created_at"] or "").strip())
            if created_at is None:
                continue
            seen_event_entries.add(deck_entry_id)
            timeline.append(
                {
                    "id": str(row["id"] or "").strip(),
                    "deckEntryID": deck_entry_id,
                    "cardID": str(row["card_id"] or "").strip(),
                    "eventKind": str(row["event_kind"] or "").strip(),
                    "quantityDelta": int(row["quantity_delta"] or 0),
                    "unitPrice": float(row["unit_price"]) if isinstance(row["unit_price"], (int, float)) else None,
                    "totalPrice": float(row["total_price"]) if isinstance(row["total_price"], (int, float)) else None,
                    "currencyCode": str(row["currency_code"] or "").strip() or None,
                    "paymentMethod": str(row["payment_method"] or "").strip() or None,
                    "condition": str(row["condition"] or "").strip() or None,
                    "grader": str(row["grader"] or "").strip() or None,
                    "grade": str(row["grade"] or "").strip() or None,
                    "certNumber": str(row["cert_number"] or "").strip() or None,
                    "variantName": str(row["variant_name"] or "").strip() or None,
                    "saleID": str(row["sale_id"] or "").strip() or None,
                    "costBasisTotal": float(row["sale_cost_basis_total"]) if isinstance(row["sale_cost_basis_total"], (int, float)) else None,
                    "sourceScanID": str(row["source_scan_id"] or "").strip() or None,
                    "sourceConfirmationID": str(row["source_confirmation_id"] or "").strip() or None,
                    "createdAt": created_at,
                }
            )
            condition_codes_by_entry_id.setdefault(deck_entry_id, set()).add(
                self._portfolio_condition_code(str(row["condition"] or "").strip() or None)
            )

        for deck_entry_id, snapshot in snapshot_by_id.items():
            if deck_entry_id in seen_event_entries:
                continue
            quantity = max(0, int(snapshot.get("quantity") or 0))
            if quantity <= 0:
                continue
            added_at = self._coerce_utc_datetime(snapshot.get("addedAt"))
            if added_at is None:
                continue
            timeline.append(
                {
                    "id": f"seed:{deck_entry_id}",
                    "deckEntryID": deck_entry_id,
                    "cardID": snapshot["cardID"],
                    "eventKind": "seed",
                    "quantityDelta": quantity,
                    "unitPrice": None,
                    "totalPrice": float(snapshot.get("costBasisTotal") or 0.0) if snapshot.get("costBasisTotal") is not None else None,
                    "currencyCode": snapshot.get("costBasisCurrencyCode"),
                    "paymentMethod": None,
                    "condition": snapshot["condition"],
                    "grader": snapshot["grader"],
                    "grade": snapshot["grade"],
                    "certNumber": snapshot["certNumber"],
                    "variantName": snapshot["variantName"],
                    "saleID": None,
                    "sourceScanID": None,
                    "sourceConfirmationID": None,
                    "createdAt": added_at,
                }
            )

        event_priority = {
            "seed": 0,
            "add": 1,
            "buy": 1,
            "condition": 2,
            "sale": 3,
        }
        timeline.sort(key=lambda item: (item["createdAt"], event_priority.get(str(item.get("eventKind") or "").strip().lower(), 9), item["id"]))

        states: dict[str, dict[str, Any]] = {
            deck_entry_id: {
                "snapshot": snapshot,
                "quantity": 0,
                "condition": snapshot.get("condition"),
                "cost_basis_total": 0.0,
            }
            for deck_entry_id, snapshot in snapshot_by_id.items()
        }
        event_index = 0
        points: list[dict[str, Any]] = []
        last_day_value = 0.0
        last_day_priced = 0
        last_day_unpriced = 0
        day_dates: list[date] = []
        current_day = start_date
        while current_day <= end_date:
            day_dates.append(current_day)
            current_day += timedelta(days=1)

        history_rows_by_card_id = (
            shared_inputs["history_rows_by_card_id"]
            if shared_inputs is not None
            else self._portfolio_history_rows_by_card_id(
                card_ids={str(snapshot.get("cardID") or "").strip() for snapshot in snapshot_by_id.values()},
                end_date=end_date,
                provider=pricing_provider(),
                start_date=start_date,
            )
        )
        # Bulk-prefetch ONLY this range's cells (window + carry-in) so a single
        # range loads ~range-window days of cells, not all of history. None in JSON
        # mode → the resolver falls back to its per-day query.
        cells_by_card_date = self._range_scoped_cells_by_card_date(
            history_rows_by_card_id, start_date=start_date, end_date=end_date
        )
        price_series_by_context: dict[tuple[str, str, str, str, str, str], list[dict[str, Any] | None]] = {}
        for deck_entry_id, snapshot in snapshot_by_id.items():
            context_conditions = condition_codes_by_entry_id.get(deck_entry_id) or {None}
            card_id = str(snapshot.get("cardID") or "").strip()
            history_rows = history_rows_by_card_id.get(card_id, [])
            cells_by_date = cells_by_card_date.get(card_id) if cells_by_card_date else None
            for condition_code in context_conditions:
                context_key = self._portfolio_history_context_key(snapshot, condition_code=condition_code)
                if context_key is None or context_key in price_series_by_context:
                    continue
                price_series_by_context[context_key] = self._portfolio_history_series_for_context(
                    snapshot,
                    condition_code=condition_code,
                    history_rows=history_rows,
                    day_dates=day_dates,
                    cells_by_date=cells_by_date,
                )

        for day_index, current_day in enumerate(day_dates):
            day_start_utc = self._portfolio_day_start(current_day, time_zone).astimezone(timezone.utc)
            next_day_start_utc = self._portfolio_day_start(current_day + timedelta(days=1), time_zone).astimezone(timezone.utc)
            # Per-day rollup of the owner's ADDS (the chart's buy markers).
            # Counts real ledger 'add'/'buy' events only — the synthetic 'seed'
            # kind (a pre-ledger entry's opening quantity) is not a user action
            # that day, so it never marks the chart.
            day_added_count = 0
            day_added_value = 0.0
            while event_index < len(timeline) and timeline[event_index]["createdAt"] < next_day_start_utc:
                event = timeline[event_index]
                state = states.setdefault(
                    event["deckEntryID"],
                    {
                        "snapshot": snapshot_by_id.get(event["deckEntryID"], {}),
                        "quantity": 0,
                        "condition": None,
                        "cost_basis_total": 0.0,
                    },
                )
                kind = str(event["eventKind"] or "").strip().lower()
                # replace_in/replace_out move quantity between entries when a
                # replace changes identity (e.g. the PDP EN/JP swap). Ignoring
                # them froze the OLD entry's holding in the history forever and
                # never counted the new one.
                if kind in {"add", "buy", "sale", "seed", "replace_in", "replace_out"}:
                    state["quantity"] = int(state.get("quantity") or 0) + int(event.get("quantityDelta") or 0)
                if kind in {"add", "buy"}:
                    added_quantity = int(event.get("quantityDelta") or 0)
                    # The >= day_start guard only bites on the FIRST day: the
                    # window's opening pass replays every carry-in event before
                    # the range (to rebuild quantities) and those must not read
                    # as adds "on" the first plotted day.
                    if added_quantity > 0 and event["createdAt"] >= day_start_utc:
                        day_added_count += added_quantity
                        added_total_price = event.get("totalPrice")
                        if isinstance(added_total_price, (int, float)):
                            day_added_value += float(added_total_price)
                        else:
                            added_unit_price = event.get("unitPrice")
                            if isinstance(added_unit_price, (int, float)):
                                day_added_value += float(added_unit_price) * added_quantity
                if kind in {"add", "buy", "seed"}:
                    event_total_price = event.get("totalPrice")
                    if isinstance(event_total_price, (int, float)):
                        state["cost_basis_total"] = round(float(state.get("cost_basis_total") or 0.0) + float(event_total_price), 2)
                    else:
                        event_unit_price = event.get("unitPrice")
                        if isinstance(event_unit_price, (int, float)):
                            state["cost_basis_total"] = round(
                                float(state.get("cost_basis_total") or 0.0)
                                + (float(event_unit_price) * abs(int(event.get("quantityDelta") or 0))),
                                2,
                            )
                if kind == "sale":
                    sale_cost_basis_total = event.get("costBasisTotal")
                    if isinstance(sale_cost_basis_total, (int, float)):
                        state["cost_basis_total"] = round(max(0.0, float(state.get("cost_basis_total") or 0.0) - float(sale_cost_basis_total)), 2)
                if event.get("condition") is not None:
                    state["condition"] = event["condition"]
                event_index += 1

            day_total = 0.0
            day_cost_basis_total = 0.0
            priced_count = 0
            unpriced_count = 0
            for deck_entry_id, state in states.items():
                quantity = max(0, int(state.get("quantity") or 0))
                if quantity <= 0:
                    continue
                day_cost_basis_total += float(state.get("cost_basis_total") or 0.0)
                snapshot = state.get("snapshot") or {}
                condition_code = self._portfolio_condition_code(state.get("condition"))
                context_entry = {
                    "itemKind": snapshot.get("itemKind"),
                    "cardID": snapshot.get("cardID"),
                    "grader": snapshot.get("grader"),
                    "grade": snapshot.get("grade"),
                    "variantName": snapshot.get("variantName"),
                }
                context_key = self._portfolio_history_context_key(context_entry, condition_code=condition_code)
                if context_key is None:
                    row = None
                else:
                    series = price_series_by_context.get(context_key)
                    if series is None:
                        fallback_card_id = str(snapshot.get("cardID") or "").strip()
                        history_rows = history_rows_by_card_id.get(fallback_card_id, [])
                        series = self._portfolio_history_series_for_context(
                            context_entry,
                            condition_code=condition_code,
                            history_rows=history_rows,
                            day_dates=day_dates,
                            cells_by_date=(cells_by_card_date.get(fallback_card_id) if cells_by_card_date else None),
                        )
                        price_series_by_context[context_key] = series
                    row = series[day_index]
                if row is None:
                    unpriced_count += 1
                    continue
                primary_price = self._history_primary_price_value(row)
                if primary_price is None:
                    unpriced_count += 1
                    continue
                priced_count += 1
                day_total += primary_price * quantity

            last_day_value = round(day_total, 2)
            last_day_cost_basis = round(day_cost_basis_total, 2)
            last_day_priced = priced_count
            last_day_unpriced = unpriced_count
            points.append(
                {
                    "date": current_day.isoformat(),
                    "totalValue": last_day_value,
                    "marketValue": last_day_value,
                    "costBasisValue": last_day_cost_basis,
                    "pricedCardCount": priced_count,
                    "excludedCardCount": unpriced_count,
                    "addedCount": day_added_count,
                    "addedValue": round(day_added_value, 2),
                }
            )

        start_value = points[0]["totalValue"] if points else 0.0
        current_value = points[-1]["totalValue"] if points else 0.0
        start_cost_basis = points[0]["costBasisValue"] if points else 0.0
        current_cost_basis = points[-1]["costBasisValue"] if points else 0.0
        delta_value = round(current_value - start_value, 2)
        delta_percent = None if start_value == 0 else round((delta_value / start_value) * 100.0, 4)
        return {
            "range": normalized_range or "30D",
            "currencyCode": "USD",
            "summary": {
                "currentValue": current_value,
                "startValue": start_value,
                "deltaValue": delta_value,
                "deltaPercent": delta_percent,
                "currentCostBasisValue": current_cost_basis,
                "startCostBasisValue": start_cost_basis,
                "deltaCostBasisValue": round(current_cost_basis - start_cost_basis, 2),
            },
            "coverage": {
                "pricedCardCount": last_day_priced,
                "excludedCardCount": last_day_unpriced,
            },
            "points": points,
            "isFresh": self._scrydex_full_catalog_sync_is_fresh(),
            "refreshedAt": utc_now(),
        }

    def portfolio_ledger(
        self,
        *,
        days: int = 30,
        range_label: str | None = None,
        time_zone_name: str | None = None,
        limit: int = 200,
        offset: int = 0,
    ) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        normalized_range = self._normalize_portfolio_range_label(range_label)
        earliest_at: datetime | None = None
        if normalized_range in {"1W", "30D", "90D", "YTD", "1Y", "ALL"}:
            earliest_at = self._portfolio_earliest_activity_at()
        time_zone, start_date, end_date = self._portfolio_date_bounds(
            days=days,
            range_label=normalized_range,
            time_zone_name=time_zone_name,
            earliest_at=earliest_at,
        )

        start_dt = self._portfolio_day_start(start_date, time_zone).astimezone(timezone.utc).isoformat()
        end_dt = self._portfolio_day_start(end_date + timedelta(days=1), time_zone).astimezone(timezone.utc).isoformat()
        safe_limit = max(0, min(int(limit), 500))
        safe_offset = max(0, int(offset))

        buy_rows = self.connection.execute(
            """
            SELECT
                deck_entry_events.id,
                deck_entry_events.deck_entry_id,
                deck_entry_events.card_id,
                deck_entry_events.quantity_delta,
                deck_entry_events.unit_price,
                deck_entry_events.total_price,
                deck_entry_events.currency_code,
                deck_entry_events.payment_method,
                deck_entry_events.condition,
                deck_entry_events.grader,
                deck_entry_events.grade,
                deck_entry_events.cert_number,
                deck_entry_events.variant_name,
                deck_entry_events.created_at
            FROM deck_entry_events
            WHERE event_kind = 'buy'
              AND owner_user_id = ?
              AND created_at >= ?
              AND created_at < ?
            ORDER BY deck_entry_events.created_at DESC, deck_entry_events.id DESC
            """,
            (owner_user_id, start_dt, end_dt),
        ).fetchall()
        sale_rows = self.connection.execute(
            """
            SELECT
                sale_events.id,
                sale_events.deck_entry_id,
                sale_events.card_id,
                sale_events.quantity,
                sale_events.unit_price,
                sale_events.total_price,
                sale_events.currency_code,
                sale_events.payment_method,
                sale_events.cost_basis_total,
                sale_events.cost_basis_per_unit_cents,
                sale_events.profit_cents,
                sale_events.last_listing_snapshot,
                sale_events.sale_source,
                sale_events.note,
                sale_events.sold_at,
                sale_events.paid_at,
                sale_events.voided_at,
                deck_entries.condition,
                deck_entries.grader,
                deck_entries.grade,
                deck_entries.cert_number,
                deck_entries.variant_name
            FROM sale_events
            LEFT JOIN deck_entries
                ON deck_entries.id = sale_events.deck_entry_id
            WHERE sold_at >= ?
              AND sold_at < ?
              AND sale_events.owner_user_id = ?
              AND COALESCE(sale_events.sale_source, 'manual') != 'inventory_adjustment'
            ORDER BY sale_events.sold_at DESC, sale_events.id DESC
            """,
            (start_dt, end_dt, owner_user_id),
        ).fetchall()
        cards_by_id_map = cards_by_ids(
            self.connection,
            [str(row["card_id"] or "").strip() for row in [*buy_rows, *sale_rows]],
        )

        def _payload_for_transaction_row(row: sqlite3.Row) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
            card_id = str(row["card_id"] or "").strip()
            card = cards_by_id_map.get(card_id)
            if card is None:
                return None, None
            card_payload = self._candidate_base_payload(card, card)
            grader = str(row["grader"] or "").strip() or None
            grade = str(row["grade"] or "").strip() or None
            cert_number = str(row["cert_number"] or "").strip() or None
            variant_name = str(row["variant_name"] or "").strip() or None
            slab_context = None
            if any([grader, grade, cert_number]):
                slab_context = {
                    "grader": grader,
                    "grade": grade,
                    "certNumber": cert_number,
                    "variantName": variant_name,
                }
            return card_payload, slab_context

        transactions: list[dict[str, Any]] = []
        revenue = 0.0
        spend = 0.0
        gross_profit = 0.0
        daily_series: list[dict[str, Any]] = []
        daily_series_by_date: dict[str, dict[str, Any]] = {}

        current_day = start_date
        while current_day <= end_date:
            date_key = current_day.isoformat()
            bucket = {
                "date": date_key,
                "revenue": 0.0,
                "spend": 0.0,
                "realizedProfit": 0.0,
                "buyCount": 0,
                "sellCount": 0,
            }
            daily_series.append(bucket)
            daily_series_by_date[date_key] = bucket
            current_day += timedelta(days=1)

        for row in buy_rows:
            card_payload, slab_context = _payload_for_transaction_row(row)
            if card_payload is None:
                continue
            quantity = abs(int(row["quantity_delta"] or 0))
            total_price = float(row["total_price"] or 0.0)
            spend += total_price
            created_at = self._coerce_utc_datetime(str(row["created_at"] or "").strip())
            if created_at is not None:
                bucket = daily_series_by_date.get(created_at.astimezone(time_zone).date().isoformat())
                if bucket is not None:
                    bucket["spend"] += total_price
                    bucket["buyCount"] += 1
            transactions.append(
                {
                    "id": str(row["id"] or "").strip(),
                    "kind": "buy",
                    "card": card_payload,
                    "slabContext": slab_context,
                    "condition": self._normalized_deck_card_condition(row["condition"]),
                    "quantity": quantity,
                    "unitPrice": float(row["unit_price"]) if isinstance(row["unit_price"], (int, float)) else None,
                    "totalPrice": total_price,
                    "currencyCode": str(row["currency_code"] or "").strip() or "USD",
                    "paymentMethod": str(row["payment_method"] or "").strip() or None,
                    "costBasisTotal": total_price,
                    "grossProfit": None,
                    "occurredAt": str(row["created_at"] or "").strip(),
                    "note": None,
                }
            )

        for row in sale_rows:
            card_payload, slab_context = _payload_for_transaction_row(row)
            if card_payload is None:
                continue
            quantity = max(1, int(row["quantity"] or 0))
            total_price = float(row["total_price"] or 0.0)
            cost_basis_total = float(row["cost_basis_total"] or 0.0)
            gross = round(total_price - cost_basis_total, 2)
            revenue += total_price
            gross_profit += gross
            sold_at = self._coerce_utc_datetime(str(row["sold_at"] or "").strip())
            if sold_at is not None:
                bucket = daily_series_by_date.get(sold_at.astimezone(time_zone).date().isoformat())
                if bucket is not None:
                    bucket["revenue"] += total_price
                    bucket["realizedProfit"] += gross
                    bucket["sellCount"] += 1
            cost_basis_per_unit_cents_raw = (
                row["cost_basis_per_unit_cents"]
                if "cost_basis_per_unit_cents" in row.keys()
                else None
            )
            profit_cents_raw = (
                row["profit_cents"] if "profit_cents" in row.keys() else None
            )
            cost_basis_per_unit_dollars: float | None = None
            if cost_basis_per_unit_cents_raw is not None:
                try:
                    cost_basis_per_unit_dollars = round(
                        float(cost_basis_per_unit_cents_raw) / 100.0, 2
                    )
                except (TypeError, ValueError):
                    cost_basis_per_unit_dollars = None
            profit_dollars: float | None = None
            if profit_cents_raw is not None:
                try:
                    profit_dollars = round(float(profit_cents_raw) / 100.0, 2)
                except (TypeError, ValueError):
                    profit_dollars = None
            transactions.append(
                {
                    "id": str(row["id"] or "").strip(),
                    "kind": "sell",
                    "card": card_payload,
                    "slabContext": slab_context,
                    "condition": self._normalized_deck_card_condition(row["condition"]),
                    "quantity": quantity,
                    "unitPrice": float(row["unit_price"]) if isinstance(row["unit_price"], (int, float)) else None,
                    "totalPrice": total_price,
                    "currencyCode": str(row["currency_code"] or "").strip() or "USD",
                    "paymentMethod": str(row["payment_method"] or "").strip() or None,
                    "paidAt": str(row["paid_at"] or "").strip() or None,
                    "status": "voided" if str(row["voided_at"] or "").strip() else ("paid" if str(row["paid_at"] or "").strip() else "pending"),
                    "costBasisTotal": cost_basis_total,
                    "costBasisPerUnit": cost_basis_per_unit_dollars,
                    "profit": profit_dollars,
                    "grossProfit": gross,
                    "occurredAt": str(row["sold_at"] or "").strip(),
                    "note": str(row["note"] or "").strip() or None,
                }
            )

        transactions.sort(key=lambda item: (item["occurredAt"], item["id"]), reverse=True)
        # Only the summary totals are needed here, so skip the per-row day-change
        # batch entirely (was a full inventory scan + price lookups per ledger call).
        inventory_summary = self.deck_entries(
            limit=1000, offset=0, include_inactive=False, compute_day_change=False
        )["summary"]

        return {
            "range": normalized_range or "30D",
            "currencyCode": "USD",
            "summary": {
                "revenue": round(revenue, 2),
                "spend": round(spend, 2),
                "grossProfit": round(gross_profit, 2),
                "inventoryValue": round(float(inventory_summary.get("totalValue") or 0.0), 2),
                "inventoryCount": int(inventory_summary.get("count") or 0),
            },
            "dailySeries": daily_series,
            "transactions": transactions[safe_offset:safe_offset + safe_limit],
            "count": len(transactions),
            "limit": safe_limit,
            "offset": safe_offset,
            "refreshedAt": utc_now(),
        }

    def vendor_show_summary(
        self,
        *,
        since: str | None = None,
        until: str | None = None,
    ) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        now = datetime.now(timezone.utc)
        parsed_until = self._coerce_utc_datetime(str(until or "").strip()) or now
        parsed_since = (
            self._coerce_utc_datetime(str(since or "").strip())
            or parsed_until - timedelta(hours=24)
        )
        if parsed_since > parsed_until:
            parsed_since, parsed_until = parsed_until, parsed_since
        since_iso = parsed_since.astimezone(timezone.utc).isoformat()
        until_iso = parsed_until.astimezone(timezone.utc).isoformat()

        sale_rows = self.connection.execute(
            """
            SELECT id, card_id, quantity, unit_price, total_price, currency_code, sold_at
            FROM sale_events
            WHERE owner_user_id = ?
              AND sold_at >= ?
              AND sold_at < ?
              AND COALESCE(sale_source, 'manual') != 'inventory_adjustment'
            """,
            (owner_user_id, since_iso, until_iso),
        ).fetchall()

        total_sales = len(sale_rows)
        total_revenue = round(sum(float(row["total_price"] or 0.0) for row in sale_rows), 2)

        currency_counter: dict[str, int] = {}
        for row in sale_rows:
            code = str(row["currency_code"] or "").strip()
            if code:
                currency_counter[code] = currency_counter.get(code, 0) + 1
        currency_code = (
            max(currency_counter.items(), key=lambda item: item[1])[0]
            if currency_counter
            else None
        )

        card_totals: dict[str, dict[str, float]] = {}
        for row in sale_rows:
            cid = str(row["card_id"] or "").strip()
            if not cid:
                continue
            bucket = card_totals.setdefault(cid, {"quantity": 0, "totalPrice": 0.0})
            bucket["quantity"] = int(bucket["quantity"]) + max(1, int(row["quantity"] or 0))
            bucket["totalPrice"] = float(bucket["totalPrice"]) + float(row["total_price"] or 0.0)
        top_card_ids = sorted(
            card_totals.keys(),
            key=lambda cid: -float(card_totals[cid]["totalPrice"]),
        )[:3]
        card_map = cards_by_ids(self.connection, top_card_ids) if top_card_ids else {}
        top_cards: list[dict[str, Any]] = []
        for cid in top_card_ids:
            card = card_map.get(cid)
            if card is None:
                continue
            base = SpotlightScanService._candidate_base_payload(card, card)
            top_cards.append(
                {
                    "cardID": cid,
                    "name": base.get("name") or "",
                    "setName": base.get("setName") or None,
                    "imageUrl": base.get("imageLargeURL") or base.get("imageSmallURL") or None,
                    "quantity": int(card_totals[cid]["quantity"]),
                    "totalPrice": round(float(card_totals[cid]["totalPrice"]), 2),
                }
            )

        return {
            "since": since_iso,
            "until": until_iso,
            "totalSales": total_sales,
            "totalRevenue": total_revenue,
            "currencyCode": currency_code,
            "topCards": top_cards,
        }

    def _added_baseline_now(
        self,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
        cert_number: str | None = None,
        variant_name: str | None = None,
        condition: str | None = None,
    ) -> tuple[float | None, str | None]:
        """Resolve the "since you added it" baseline for a NEW deck entry or
        favorite: the market price the app would display for this exact context
        right now, plus today's date (the add date).

        Uses the same context resolution as the Collection/Wishlist list
        serializers (`_display_pricing_summary_for_context`) so the stored
        baseline equals the marketPrice the UI showed on the add day. When the
        exact context has no price, falls back to the default raw lane so a
        priced card never loses its baseline over a missing variant/condition
        cell. Best-effort: an unpriced card (or any resolver error) yields
        (None, None) and the add proceeds without a baseline."""
        try:
            pricing_context = (
                self._slab_pricing_context(
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    preferred_variant=variant_name,
                )
                if grader or grade
                else self._raw_pricing_context(
                    preferred_variant=variant_name,
                    preferred_condition=condition,
                )
            )
            pricing = self._display_pricing_summary_for_context(
                card_id,
                pricing_context=pricing_context,
            )
            price = self._history_primary_price_value(pricing)
            if price is None and (grader or grade or variant_name or condition):
                pricing = self._display_pricing_summary_for_context(
                    card_id,
                    pricing_context=self._raw_pricing_context(),
                )
                price = self._history_primary_price_value(pricing)
            if price is None:
                return None, None
            return round(float(price), 2), datetime.now(timezone.utc).date().isoformat()
        except Exception:  # noqa: BLE001 - the baseline is decorative; never block an add
            traceback.print_exc()
            return None, None

    def record_buy(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        card_id = str(payload.get("cardID") or "").strip()
        if not card_id:
            raise ValueError("cardID is required")

        slab_context = payload.get("slabContext") if isinstance(payload.get("slabContext"), dict) else {}
        grader = str(slab_context.get("grader") or "").strip() or None
        grade = str(slab_context.get("grade") or "").strip() or None
        cert_number = str(slab_context.get("certNumber") or "").strip() or None
        raw_variant_name = str(payload.get("variantName") or "").strip() or None
        slab_variant_name = str(slab_context.get("variantName") or "").strip() or None
        variant_name = (
            self._sanitize_slab_variant_name(slab_variant_name, grader, grade)
            if any([grader, grade, cert_number])
            else raw_variant_name
        )
        condition = self._normalized_deck_card_condition(payload.get("condition"))

        try:
            quantity = int(payload.get("quantity", 1))
        except (TypeError, ValueError):
            raise ValueError("quantity must be an integer") from None
        if quantity < 1:
            raise ValueError("quantity must be at least 1")

        unit_price_raw = payload.get("unitPrice")
        if unit_price_raw is None or unit_price_raw == "":
            unit_price = None
        else:
            try:
                unit_price = float(unit_price_raw)
            except (TypeError, ValueError):
                raise ValueError("unitPrice must be a number") from None
            if unit_price < 0:
                raise ValueError("unitPrice must be non-negative")

        currency_code = str(payload.get("currencyCode") or "").strip() or "USD"
        payment_method = str(payload.get("paymentMethod") or "").strip() or None
        bought_at = str(payload.get("boughtAt") or utc_now()).strip() or utc_now()
        source_scan_id = str(payload.get("sourceScanID") or "").strip() or None
        source_confirmation_id = str(payload.get("sourceConfirmationID") or "").strip() or None
        # Optional explicit per-unit cost basis (dollars). When provided, mirrors
        # into the new `cost_basis_cents` column so Insights aggregates pick it
        # up without depending on the legacy `cost_basis_total` derivation.
        cost_basis_per_unit_cents = self._parse_cost_basis_per_unit_cents(payload)
        if source_scan_id:
            scan_exists = self.connection.execute(
                "SELECT 1 FROM scan_events WHERE scan_id = ? AND owner_user_id = ? LIMIT 1",
                (source_scan_id, owner_user_id),
            ).fetchone() is not None
            if not scan_exists:
                raise FileNotFoundError("source scan not found")
        if source_confirmation_id:
            confirmation_exists = self.connection.execute(
                "SELECT 1 FROM scan_confirmations WHERE id = ? AND owner_user_id = ? LIMIT 1",
                (source_confirmation_id, owner_user_id),
            ).fetchone() is not None
            if not confirmation_exists:
                raise FileNotFoundError("source confirmation not found")
        identity_key = deck_entry_storage_key(
            card_id=card_id,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            variant_name=variant_name,
            condition=condition,
        )

        added_market_price, added_market_date = self._added_baseline_now(
            card_id,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            variant_name=variant_name,
            condition=condition,
        )

        try:
            inserted = self.connection.execute(
                "SELECT 1 FROM deck_entries WHERE owner_user_id = ? AND identity_key = ? LIMIT 1",
                (owner_user_id, identity_key),
            ).fetchone() is None
            deck_entry_id = upsert_deck_entry(
                self.connection,
                owner_user_id=owner_user_id,
                card_id=card_id,
                grader=grader,
                grade=grade,
                cert_number=cert_number,
                variant_name=variant_name,
                condition=condition,
                quantity=quantity,
                unit_price=unit_price,
                currency_code=currency_code,
                payment_method=payment_method,
                added_at=bought_at,
                updated_at=bought_at,
                source_scan_id=source_scan_id,
                source_confirmation_id=source_confirmation_id,
                event_kind="buy",
                added_market_price=added_market_price,
                added_market_date=added_market_date,
            )
            if cost_basis_per_unit_cents is not None:
                self._set_deck_entry_cost_basis_cents(
                    deck_entry_id=deck_entry_id,
                    cost_basis_cents=cost_basis_per_unit_cents,
                    updated_at=bought_at,
                )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        return {
            "deckEntryID": deck_entry_id,
            "cardID": card_id,
            "variantName": variant_name,
            "inserted": inserted,
            "quantityAdded": quantity,
            "totalSpend": round(unit_price * quantity, 2),
            "boughtAt": bought_at,
        }

    def replace_deck_entry(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        previous_deck_entry_id = str(payload.get("deckEntryID") or "").strip()
        if not previous_deck_entry_id:
            raise ValueError("deckEntryID is required")

        card_id = str(payload.get("cardID") or "").strip()
        if not card_id:
            raise ValueError("cardID is required")

        slab_context = payload.get("slabContext") if isinstance(payload.get("slabContext"), dict) else {}
        grader = str(slab_context.get("grader") or "").strip() or None
        grade = str(slab_context.get("grade") or "").strip() or None
        cert_number = str(slab_context.get("certNumber") or "").strip() or None
        raw_variant_name = str(payload.get("variantName") or "").strip() or None
        slab_variant_name = str(slab_context.get("variantName") or "").strip() or None
        variant_name = (
            self._sanitize_slab_variant_name(slab_variant_name, grader, grade)
            if any([grader, grade, cert_number])
            else raw_variant_name
        )
        condition = self._normalized_deck_card_condition(payload.get("condition"))

        try:
            quantity = int(payload.get("quantity", 1))
        except (TypeError, ValueError):
            raise ValueError("quantity must be an integer") from None
        if quantity < 1:
            raise ValueError("quantity must be at least 1")

        unit_price_raw = payload.get("unitPrice")
        if unit_price_raw is None or unit_price_raw == "":
            raise ValueError("unitPrice is required")
        try:
            unit_price = float(unit_price_raw)
        except (TypeError, ValueError):
            raise ValueError("unitPrice must be a number") from None
        if unit_price < 0:
            raise ValueError("unitPrice must be non-negative")

        currency_code = str(payload.get("currencyCode") or "").strip() or "USD"
        updated_at = str(payload.get("updatedAt") or utc_now()).strip() or utc_now()

        existing_row = self._owned_deck_entry_row_by_reference(previous_deck_entry_id)
        if existing_row is None:
            raise FileNotFoundError("deck entry not found")
        previous_deck_entry_id = str(existing_row["id"] or "").strip()

        # A card-id change is a legitimate replace: the PDP EN/JP toggle saves
        # the owned entry onto the counterpart printing. The identity-key branch
        # below already handles it generically (upsert merges into an existing
        # entry of the new identity, the old entry zeroes out with a
        # replace_out event). Just require the target card to exist locally.
        existing_card_id = str(existing_row["card_id"] or "").strip()
        if existing_card_id != card_id and not cards_by_ids(self.connection, [card_id]):
            raise ValueError("cardID does not reference a known card")

        existing_identity_key = str(existing_row["identity_key"] or "").strip()
        next_identity_key = deck_entry_storage_key(
            card_id=card_id,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            variant_name=variant_name,
            condition=condition,
        )
        existing_quantity = max(0, int(existing_row["quantity"] or 0))
        next_deck_entry_id = previous_deck_entry_id

        try:
            if next_identity_key == existing_identity_key:
                self.connection.execute(
                    """
                    UPDATE deck_entries
                    SET grader = ?,
                        grade = ?,
                        cert_number = ?,
                        variant_name = ?,
                        condition = ?,
                        quantity = ?,
                        cost_basis_total = ?,
                        cost_basis_currency_code = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        grader,
                        grade,
                        cert_number,
                        variant_name,
                        condition,
                        quantity,
                        round(unit_price * quantity, 2) if unit_price is not None else 0.0,
                        currency_code,
                        updated_at,
                        previous_deck_entry_id,
                    ),
                )
                append_deck_entry_event(
                    self.connection,
                    owner_user_id=owner_user_id,
                    deck_entry_id=previous_deck_entry_id,
                    card_id=card_id,
                    event_kind="replace",
                    quantity_delta=quantity - existing_quantity,
                    unit_price=unit_price,
                    total_price=round(unit_price * quantity, 2) if unit_price is not None else None,
                    currency_code=currency_code,
                    condition=condition,
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    variant_name=variant_name,
                    created_at=updated_at,
                )
            else:
                added_market_price, added_market_date = self._added_baseline_now(
                    card_id,
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    variant_name=variant_name,
                    condition=condition,
                )
                next_deck_entry_id = upsert_deck_entry(
                    self.connection,
                    owner_user_id=owner_user_id,
                    card_id=card_id,
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    variant_name=variant_name,
                    condition=condition,
                    quantity=quantity,
                    unit_price=unit_price,
                    currency_code=currency_code,
                    added_at=updated_at,
                    updated_at=updated_at,
                    source_scan_id=str(existing_row["source_scan_id"] or "").strip() or None,
                    source_confirmation_id=str(existing_row["source_confirmation_id"] or "").strip() or None,
                    event_kind="replace_in",
                    added_market_price=added_market_price,
                    added_market_date=added_market_date,
                )
                self.connection.execute(
                    """
                    UPDATE deck_entries
                    SET quantity = 0,
                        cost_basis_total = 0,
                        updated_at = ?
                    WHERE id = ?
                      AND owner_user_id = ?
                    """,
                    (updated_at, previous_deck_entry_id, owner_user_id),
                )
                append_deck_entry_event(
                    self.connection,
                    owner_user_id=owner_user_id,
                    deck_entry_id=previous_deck_entry_id,
                    # The OLD entry's card, not the request's: on a cross-card
                    # replace (EN/JP swap) the portfolio-history ledger must
                    # subtract the card that actually left. Writing the new
                    # card here made history net the new card to zero and keep
                    # valuing the old one forever.
                    card_id=existing_card_id or card_id,
                    event_kind="replace_out",
                    quantity_delta=-existing_quantity,
                    currency_code=currency_code,
                    condition=str(existing_row["condition"] or "").strip() or None,
                    grader=str(existing_row["grader"] or "").strip() or None,
                    grade=str(existing_row["grade"] or "").strip() or None,
                    cert_number=str(existing_row["cert_number"] or "").strip() or None,
                    variant_name=str(existing_row["variant_name"] or "").strip() or None,
                    created_at=updated_at,
                )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        # Compute the NEW identity's market price with the SAME logic deck_entries
        # uses, so the client can update its optimistic Collection row with the
        # correct price immediately. Without this the PDP reuses the card's base
        # (raw) price for a just-graded entry, so the Collection showed a stale
        # price until the slow (5-10s) dashboard refetch recomputed it. Additive
        # to the response payload — older clients ignore the extra fields.
        market_price: float | None = None
        has_market_price = False
        market_currency_code: str | None = None
        try:
            pricing_context = (
                self._slab_pricing_context(
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    preferred_variant=variant_name,
                )
                if grader or grade
                else self._raw_pricing_context(
                    preferred_variant=variant_name,
                    preferred_condition=condition,
                )
            )
            snapshot_rows = self._price_snapshot_rows_by_card_id([card_id])
            pricing = self._display_pricing_summary_for_context(
                card_id,
                pricing_context=pricing_context,
                snapshot_row=snapshot_rows.get(card_id),
            )
            if pricing is not None:
                raw_market = pricing.get("market")
                if isinstance(raw_market, (int, float)):
                    market_price = round(float(raw_market), 2)
                pricing_currency = str(pricing.get("currencyCode") or "").strip()
                if pricing_currency:
                    market_currency_code = pricing_currency
                if market_price is not None:
                    # Mirror mapDeckEntry.hasMarketPrice: graded prices always
                    # display; a raw price only counts when it matches the
                    # requested condition (else the entry shows "—").
                    if grader or grade:
                        has_market_price = True
                    else:
                        has_market_price = self._raw_pricing_matches_context(
                            pricing,
                            preferred_variant=variant_name,
                            preferred_condition=condition,
                        )
        except Exception:
            # Pricing is a best-effort optimistic hint; never fail the save on it.
            # The client reconciles against deck_entries on its next refresh.
            market_price = None
            has_market_price = False
            market_currency_code = None

        return {
            "previousDeckEntryID": previous_deck_entry_id,
            "deckEntryID": next_deck_entry_id,
            "cardID": card_id,
            "variantName": variant_name,
            "condition": condition,
            "quantity": quantity,
            "unitPrice": round(unit_price, 2) if unit_price is not None else None,
            "updatedAt": updated_at,
            "marketPrice": market_price,
            "hasMarketPrice": has_market_price,
            "currencyCode": market_currency_code,
        }

    def delete_deck_entry(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        deck_entry_id = str(payload.get("deckEntryID") or "").strip()
        if not deck_entry_id:
            raise ValueError("deckEntryID is required")

        existing_row = self._owned_deck_entry_row_by_reference(deck_entry_id)
        if existing_row is None:
            raise FileNotFoundError("deck entry not found")
        resolved_deck_entry_id = str(existing_row["id"] or "").strip()
        resolved_card_id = str(existing_row["card_id"] or "").strip()

        self.connection.execute(
            "DELETE FROM deck_entries WHERE id = ? AND owner_user_id = ?",
            (resolved_deck_entry_id, owner_user_id),
        )
        self.connection.commit()

        return {
            "deckEntryID": resolved_deck_entry_id,
            "cardID": resolved_card_id,
        }

    def delete_deck_entries(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        raw_ids = payload.get("deckEntryIDs")
        if not isinstance(raw_ids, list):
            raise ValueError("deckEntryIDs is required")

        # Coerce, drop empties, and dedupe while preserving request order.
        deck_entry_ids: list[str] = []
        seen: set[str] = set()
        for raw_id in raw_ids:
            candidate = str(raw_id).strip()
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            deck_entry_ids.append(candidate)
        if not deck_entry_ids:
            raise ValueError("deckEntryIDs is required")

        # Bulk delete stays tolerant of already-gone rows: ids that no longer
        # resolve to an owned row are skipped instead of failing the batch.
        resolved_ids: list[str] = []
        for deck_entry_id in deck_entry_ids:
            existing_row = self._owned_deck_entry_row_by_reference(deck_entry_id)
            if existing_row is None:
                continue
            resolved_ids.append(str(existing_row["id"] or "").strip())

        if resolved_ids:
            placeholders = ",".join("?" for _ in resolved_ids)
            self.connection.execute(
                f"DELETE FROM deck_entries WHERE id IN ({placeholders}) AND owner_user_id = ?",
                (*resolved_ids, owner_user_id),
            )
            self.connection.commit()

        return {
            "deletedDeckEntryIDs": resolved_ids,
            "deletedCount": len(resolved_ids),
        }

    # Ordered children-before-parents per the owner-scoped foreign-key graph so
    # the deletes never trip a foreign-key constraint while the account is torn
    # down. Every table below carries an ``owner_user_id`` column (verified via
    # the applied schema): deck_entry_events/sale_events/deck_entries reference
    # scan_events + scan_confirmations; scan_artifacts/scan_confirmations
    # reference scan_events, which must be deleted last. card_favorites,
    # card_transactions, and portfolio_import_jobs are independent owner-scoped
    # tables.
    _ACCOUNT_DELETION_TABLES: tuple[str, ...] = (
        "deck_entry_events",
        "sale_events",
        "deck_entries",
        "scan_artifacts",
        "scan_confirmations",
        "scan_events",
        "card_favorites",
        "card_views",
        "card_transactions",
        "portfolio_import_jobs",
    )

    def delete_account(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Permanently delete every owner-scoped row for the calling user, then
        best-effort delete their Supabase auth user.

        Required for App Store guideline 5.1.1(v) (in-app account deletion).
        Local data deletion runs in one transaction. The Supabase admin delete
        is best-effort: if the service-role key is missing or the call fails we
        log an ERROR (so a misconfigured deploy is visible — leaving the auth user
        alive re-triggers a 5.1.1(v) rejection) and still report success, because
        the user's app data is already gone and the auth user can be reconciled.
        """
        owner_user_id = self._current_owner_user_id()

        try:
            for table_name in self._ACCOUNT_DELETION_TABLES:
                self.connection.execute(
                    f"DELETE FROM {table_name} WHERE owner_user_id = ?",
                    (owner_user_id,),
                )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        auth_user_deleted = self._delete_supabase_auth_user(owner_user_id)

        return {"deleted": True, "authUserDeleted": auth_user_deleted}

    def _delete_supabase_auth_user(self, owner_user_id: str) -> bool:
        """Best-effort deletion of the Supabase auth user via the Admin API.

        Returns True only when the auth user was deleted. Never raises: a
        missing service-role key or a failed call logs an ERROR and returns
        False so account deletion still succeeds.
        """
        supabase_url = str(
            os.environ.get(SUPABASE_URL_ENV)
            or os.environ.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL")
            or os.environ.get("SPOTLIGHT_SUPABASE_URL")
            or ""
        ).strip()
        service_role_key = str(
            os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
            or os.environ.get("SPOTLIGHT_SUPABASE_SERVICE_ROLE_KEY")
            or ""
        ).strip()

        if not service_role_key or not supabase_url:
            self._emit_structured_log(
                {
                    "severity": "ERROR",
                    "event": "account_deletion_auth_user_skipped",
                    "ownerUserID": owner_user_id,
                    "reason": "missing_service_role_key" if not service_role_key else "missing_supabase_url",
                }
            )
            return False

        from urllib.request import Request, urlopen

        admin_url = f"{supabase_url.rstrip('/')}/auth/v1/admin/users/{owner_user_id}"
        request = Request(
            admin_url,
            method="DELETE",
            headers={
                "Authorization": f"Bearer {service_role_key}",
                "apikey": service_role_key,
            },
        )
        try:
            with urlopen(request, timeout=10) as response:
                status_code = int(getattr(response, "status", 0) or response.getcode())
            if 200 <= status_code < 300:
                return True
            self._emit_structured_log(
                {
                    "severity": "ERROR",
                    "event": "account_deletion_auth_user_failed",
                    "ownerUserID": owner_user_id,
                    "statusCode": status_code,
                }
            )
            return False
        except Exception as error:  # best-effort: never block account deletion
            self._emit_structured_log(
                {
                    "severity": "ERROR",
                    "event": "account_deletion_auth_user_error",
                    "ownerUserID": owner_user_id,
                    "error": str(error),
                }
            )
            return False

    def set_deck_entry_quantity(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        deck_entry_id = str(payload.get("deckEntryID") or "").strip()
        if not deck_entry_id:
            raise ValueError("deckEntryID is required")

        try:
            quantity = int(payload.get("quantity", 0))
        except (TypeError, ValueError):
            raise ValueError("quantity must be an integer") from None
        if quantity < 0:
            raise ValueError("quantity must be at least 0")

        existing_row = self._owned_deck_entry_row_by_reference(deck_entry_id)
        if existing_row is None:
            raise FileNotFoundError("deck entry not found")
        resolved_deck_entry_id = str(existing_row["id"] or "").strip()
        resolved_card_id = str(existing_row["card_id"] or "").strip()

        try:
            if quantity == 0:
                self.connection.execute(
                    "DELETE FROM deck_entries WHERE id = ? AND owner_user_id = ?",
                    (resolved_deck_entry_id, owner_user_id),
                )
            else:
                self.connection.execute(
                    """
                    UPDATE deck_entries
                    SET quantity = ?, updated_at = ?
                    WHERE id = ?
                      AND owner_user_id = ?
                    """,
                    (quantity, utc_now(), resolved_deck_entry_id, owner_user_id),
                )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        return {
            "deckEntryID": resolved_deck_entry_id,
            "cardID": resolved_card_id,
            "quantity": 0 if quantity == 0 else quantity,
            "deleted": quantity == 0,
        }

    def preview_portfolio_import(self, payload: dict[str, Any]) -> dict[str, Any]:
        return preview_portfolio_import(self.connection, payload, owner_user_id=self._current_owner_user_id())

    def portfolio_import_job(
        self,
        job_id: str,
        *,
        status_filter: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        return get_portfolio_import_job(
            self.connection,
            job_id,
            owner_user_id=self._current_owner_user_id(),
            status_filter=status_filter,
            limit=limit,
            offset=offset,
        )

    def resolve_portfolio_import(self, job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return resolve_portfolio_import(self.connection, job_id, payload, owner_user_id=self._current_owner_user_id())

    def commit_portfolio_import(self, job_id: str) -> dict[str, Any]:
        return commit_portfolio_import(self.connection, job_id, owner_user_id=self._current_owner_user_id())

    def _record_sale_without_commit(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        deck_entry_id = str(payload.get("deckEntryID") or "").strip()
        card_id = str(payload.get("cardID") or "").strip()
        slab_context = payload.get("slabContext") if isinstance(payload.get("slabContext"), dict) else {}
        slab_grader = str(slab_context.get("grader") or "").strip() or None
        slab_grade = str(slab_context.get("grade") or "").strip() or None
        slab_cert_number = str(slab_context.get("certNumber") or "").strip() or None
        slab_variant_name = str(slab_context.get("variantName") or "").strip() or None
        condition = str(payload.get("condition") or "").strip() or None
        sold_at = str(payload.get("soldAt") or utc_now()).strip() or utc_now()

        if not deck_entry_id:
            if not card_id:
                raise ValueError("deckEntryID or cardID is required")
            deck_entry_id = self._resolve_owned_deck_entry_id(
                card_id=card_id,
                grader=slab_grader,
                grade=slab_grade,
                cert_number=slab_cert_number,
                variant_name=slab_variant_name,
                condition=condition,
            )
            if not deck_entry_id:
                card_row = self.connection.execute(
                    "SELECT id FROM cards WHERE id = ? LIMIT 1",
                    (card_id,),
                ).fetchone()
                if card_row is None:
                    raise FileNotFoundError("card not found")
                try:
                    stub_quantity = max(1, int(payload.get("quantity", 1)))
                except (TypeError, ValueError):
                    stub_quantity = 1
                added_market_price, added_market_date = self._added_baseline_now(
                    card_id,
                    grader=slab_grader,
                    grade=slab_grade,
                    cert_number=slab_cert_number,
                    variant_name=slab_variant_name,
                    condition=condition,
                )
                deck_entry_id = upsert_deck_entry(
                    self.connection,
                    owner_user_id=owner_user_id,
                    card_id=card_id,
                    grader=slab_grader,
                    grade=slab_grade,
                    cert_number=slab_cert_number,
                    variant_name=slab_variant_name,
                    condition=condition,
                    quantity=stub_quantity,
                    unit_price=None,
                    currency_code=str(payload.get("currencyCode") or "").strip() or None,
                    added_at=sold_at,
                    updated_at=sold_at,
                    event_kind="add",
                    added_market_price=added_market_price,
                    added_market_date=added_market_date,
                )

        row = self._owned_deck_entry_row_by_reference(deck_entry_id)
        if row is None:
            raise FileNotFoundError("deck entry not found")
        deck_entry_id = str(row["id"] or "").strip()

        resolved_card_id = str(row["card_id"] or "").strip()
        if card_id and resolved_card_id and card_id != resolved_card_id:
            raise ValueError("cardID does not match the deck entry")
        card_id = resolved_card_id

        try:
            quantity = int(payload.get("quantity", 1))
        except (TypeError, ValueError):
            raise ValueError("quantity must be an integer") from None
        if quantity < 1:
            raise ValueError("quantity must be at least 1")

        current_quantity = max(0, int(row["quantity"] or 0))
        if quantity > current_quantity:
            raise ValueError("sale quantity exceeds deck quantity")

        note = str(payload.get("note") or "").strip() or None
        payment_method = str(payload.get("paymentMethod") or "").strip() or None
        sale_source = str(payload.get("saleSource") or "manual").strip() or "manual"
        show_session_id = str(payload.get("showSessionID") or "").strip() or None
        currency_code = str(payload.get("currencyCode") or "").strip() or None
        unit_price_raw = payload.get("unitPrice")
        if unit_price_raw is None or unit_price_raw == "":
            unit_price = None
        else:
            try:
                unit_price = float(unit_price_raw)
            except (TypeError, ValueError):
                raise ValueError("unitPrice must be a number") from None
        if unit_price is None or unit_price < 0:
            raise ValueError("unitPrice must be a non-negative number")

        paid_at: str | None = sold_at

        source_scan_id = str(payload.get("sourceScanID") or "").strip() or None
        source_confirmation_id = str(payload.get("sourceConfirmationID") or "").strip() or None
        if source_scan_id:
            scan_row = self.connection.execute(
                "SELECT 1 FROM scan_events WHERE scan_id = ? AND owner_user_id = ? LIMIT 1",
                (source_scan_id, owner_user_id),
            ).fetchone()
            if scan_row is None:
                raise FileNotFoundError("scan event not found")
        if source_confirmation_id:
            confirmation_row = self.connection.execute(
                "SELECT 1 FROM scan_confirmations WHERE id = ? AND owner_user_id = ? LIMIT 1",
                (source_confirmation_id, owner_user_id),
            ).fetchone()
            if confirmation_row is None:
                raise FileNotFoundError("scan confirmation not found")
        sale_id = record_sale_event(
            self.connection,
            owner_user_id=owner_user_id,
            deck_entry_id=deck_entry_id,
            card_id=card_id,
            quantity=quantity,
            unit_price=unit_price,
            currency_code=currency_code,
            payment_method=payment_method,
            sale_source=sale_source,
            show_session_id=show_session_id,
            note=note,
            sold_at=sold_at,
            paid_at=paid_at,
            source_scan_id=source_scan_id,
            source_confirmation_id=source_confirmation_id,
        )
        if sale_id is None:
            raise RuntimeError("sale events table not available")
        remaining_row = self.connection.execute(
            "SELECT quantity FROM deck_entries WHERE id = ? AND owner_user_id = ? LIMIT 1",
            (deck_entry_id, owner_user_id),
        ).fetchone()
        if remaining_row is not None:
            remaining_quantity = max(0, int(remaining_row["quantity"] or 0))
        elif paid_at is not None:
            remaining_quantity = max(0, current_quantity - quantity)
        else:
            remaining_quantity = current_quantity
        return {
            "saleID": sale_id,
            "deckEntryID": deck_entry_id,
            "remainingQuantity": remaining_quantity,
            "grossTotal": round(unit_price * quantity, 2),
            "soldAt": sold_at,
            "paidAt": paid_at,
            "status": "paid" if paid_at else "pending",
            "showSessionID": show_session_id,
        }

    def record_sale(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            sale_payload = self._record_sale_without_commit(payload)
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        return sale_payload

    def record_sales_batch(self, payload: dict[str, Any]) -> dict[str, Any]:
        sales = payload.get("sales")
        if not isinstance(sales, list) or not sales:
            raise ValueError("sales must be a non-empty list")

        results: list[dict[str, Any]] = []
        try:
            for sale_payload in sales:
                if not isinstance(sale_payload, dict):
                    raise ValueError("each sale must be an object")
                results.append(self._record_sale_without_commit(sale_payload))
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        return {"results": results}

    _CARD_TRANSACTION_KINDS = {"bought", "sold", "traded"}
    _CARD_TRANSACTION_PAYMENT_METHODS = {
        "cash",
        "venmo",
        "cashapp",
        "paypal",
        "zelle",
        "other",
    }

    @staticmethod
    def _card_transaction_occurred_at_label(occurred_at: str | None) -> str | None:
        parsed = SpotlightScanService._coerce_utc_datetime(occurred_at)
        if parsed is None:
            return None
        # e.g. "Jun 2, 2026" — leading zero on the day is stripped for display.
        return f"{parsed.strftime('%b')} {parsed.day}, {parsed.year}"

    @staticmethod
    def _card_transaction_row_to_payload(row: dict[str, Any]) -> dict[str, Any]:
        transaction_id = str(row.get("id") or "")
        upload_status = str(row.get("photo_upload_status") or "").strip()
        has_photo = bool(str(row.get("photo_object_path") or "").strip()) and upload_status == "uploaded"
        photo_url = f"/api/v1/card-transactions/{transaction_id}/photo" if has_photo else None
        occurred_at = str(row.get("occurred_at") or "") or None
        amount_value = row.get("amount_cents")
        item_count_value = row.get("item_count")
        return {
            "id": transaction_id,
            "kind": str(row.get("kind") or ""),
            "amountCents": int(amount_value) if amount_value is not None else None,
            "itemCount": int(item_count_value) if item_count_value is not None else 1,
            "currencyCode": str(row.get("currency_code") or "USD"),
            "note": str(row.get("note") or "").strip() or None,
            "occurredAt": occurred_at,
            "occurredAtLabel": SpotlightScanService._card_transaction_occurred_at_label(occurred_at),
            "createdAt": str(row.get("created_at") or "") or None,
            "photoUrl": photo_url,
            "imageUrl": (str(row.get("image_url") or "").strip() or None),
            "paymentMethod": (str(row.get("payment_method") or "").strip().lower() or None),
        }

    def create_card_transaction(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        owner_user_id = self._current_owner_user_id()

        kind = str(payload.get("kind") or "").strip().lower()
        if kind not in self._CARD_TRANSACTION_KINDS:
            raise ValueError("kind must be one of bought, sold, traded")

        # Price is optional: a missing/null amountCents stores NULL. A present
        # value must still be a non-negative integer.
        amount_raw = payload.get("amountCents")
        if amount_raw is None:
            amount_cents: int | None = None
        else:
            if isinstance(amount_raw, bool) or not isinstance(amount_raw, int):
                raise ValueError("amountCents must be an integer")
            amount_cents = int(amount_raw)
            if amount_cents < 0:
                raise ValueError("amountCents must be non-negative")

        # itemCount defaults to 1 when omitted and must be a positive integer.
        item_count_raw = payload.get("itemCount")
        if item_count_raw is None:
            item_count = 1
        else:
            if isinstance(item_count_raw, bool) or not isinstance(item_count_raw, int):
                raise ValueError("itemCount must be an integer")
            item_count = int(item_count_raw)
            if item_count < 1:
                raise ValueError("itemCount must be a positive integer")

        currency_code = str(payload.get("currencyCode") or "").strip() or "USD"
        note = str(payload.get("note") or "").strip() or None

        # Optional catalog image URL (plain absolute URL string; no base64).
        image_url = str(payload.get("imageUrl") or "").strip() or None

        # Optional payment method; missing/empty stores NULL, a present value must
        # be one of the known methods.
        payment_method = str(payload.get("paymentMethod") or "").strip().lower() or None
        if payment_method is not None and payment_method not in self._CARD_TRANSACTION_PAYMENT_METHODS:
            raise ValueError(
                "paymentMethod must be one of cash, venmo, cashapp, paypal, zelle, other"
            )

        occurred_at = str(payload.get("occurredAt") or "").strip()
        if not occurred_at:
            raise ValueError("occurredAt is required")

        # A present-but-invalid photo object is an error; a missing/null photo is allowed.
        photo_bytes, photo_width, photo_height = self._decode_scan_image_payload(
            payload, field_name="photo", optional=True
        )

        partition_datetime = self._coerce_utc_datetime(occurred_at) or datetime.now(timezone.utc)
        year = f"{partition_datetime.year:04d}"
        month = f"{partition_datetime.month:02d}"
        day = f"{partition_datetime.day:02d}"

        transaction_id = f"card-transaction:{uuid.uuid4().hex}"
        created_at = utc_now()

        photo_object_path: str | None = None
        photo_upload_status: str | None = None
        photo_uploaded_at: str | None = None
        if photo_bytes is not None:
            try:
                photo_object_path = self.artifact_store.store_transaction_photo(
                    transaction_id=transaction_id,
                    photo_bytes=photo_bytes,
                    year=year,
                    month=month,
                    day=day,
                )
                photo_upload_status = "uploaded"
                photo_uploaded_at = created_at
            except Exception as exc:  # noqa: BLE001 - never lose the transaction on a photo write failure
                self._emit_structured_log(
                    {
                        "severity": "WARNING",
                        "event": "card_transaction_photo_write_failed",
                        "transactionID": transaction_id,
                        "error": str(exc),
                    }
                )
                photo_object_path = None
                photo_upload_status = "failed"
                photo_uploaded_at = None
                photo_width = None
                photo_height = None

        try:
            insert_card_transaction(
                self.connection,
                transaction_id=transaction_id,
                owner_user_id=owner_user_id,
                kind=kind,
                amount_cents=amount_cents,
                item_count=item_count,
                currency_code=currency_code,
                occurred_at=occurred_at,
                note=note,
                photo_object_path=photo_object_path,
                photo_upload_status=photo_upload_status,
                photo_uploaded_at=photo_uploaded_at,
                photo_width=photo_width,
                photo_height=photo_height,
                image_url=image_url,
                payment_method=payment_method,
                created_at=created_at,
            )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        row = get_card_transaction(
            self.connection, transaction_id=transaction_id, owner_user_id=owner_user_id
        )
        if row is None:  # pragma: no cover - just inserted
            raise RuntimeError("card transaction not found after insert")
        return self._card_transaction_row_to_payload(row)

    def list_card_transactions(
        self, *, limit: int = 100, offset: int = 0, kind: str | None = None
    ) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        normalized_limit = max(1, min(int(limit), 500))
        normalized_offset = max(0, int(offset))
        normalized_kind = str(kind or "").strip().lower() or None
        if normalized_kind is not None and normalized_kind not in self._CARD_TRANSACTION_KINDS:
            raise ValueError("kind must be one of bought, sold, traded")
        rows = list_card_transactions(
            self.connection,
            owner_user_id=owner_user_id,
            kind=normalized_kind,
            limit=normalized_limit,
            offset=normalized_offset,
        )
        transactions = [self._card_transaction_row_to_payload(row) for row in rows]
        return {
            "transactions": transactions,
            "count": len(transactions),
            "limit": normalized_limit,
            "offset": normalized_offset,
        }

    def transaction_insights(self, *, time_zone_name: str | None = None) -> dict[str, Any]:
        """Cache-and-dogpile wrapper over the heavy insights computation.

        The compute materializes the owner's full portfolio (deck_entries) to
        derive total value + 30-day top growth — which on a cold backend reads
        ~126 cards' worth of JSON-context overflow pages off the slow disk and
        can take tens of seconds, past the 20s client timeout. Without a cache
        EVERY load recomputes that cold path and times out, so the user never
        sees data. Keyed on a cheap version token (the dashboard's inputs plus
        scan/favorite counts) so a hit serves the prior payload in ~1ms and
        auto-invalidates on any mutation or the daily price sync. A timed-out
        first call still completes here and stores the result, so the next load
        is instant — the same self-healing the portfolio dashboard relies on."""
        owner_user_id = self._current_owner_user_id()
        resolved_tz = time_zone_name or "America/Los_Angeles"
        try:
            version = self._transaction_insights_version_token(owner_user_id, resolved_tz)
        except Exception:  # noqa: BLE001 - never let cache bookkeeping break insights
            traceback.print_exc()
            version = None
        cache_key = (owner_user_id, resolved_tz, "insights")
        if version is not None:
            cached = self._dashboard_cache.get(cache_key)
            if cached is not None and cached[0] == version:
                return cached[1]
        lock = self._dashboard_cache_lock_for(cache_key)
        with lock:
            if version is not None:
                cached = self._dashboard_cache.get(cache_key)
                if cached is not None and cached[0] == version:
                    return cached[1]
            payload = self._compute_transaction_insights(time_zone_name=time_zone_name)
            if version is not None:
                self._store_dashboard_cache(cache_key, version, payload)
            return payload

    def _transaction_insights_version_token(
        self, owner_user_id: str, resolved_tz: str
    ) -> str:
        """The dashboard's version token (deck entries/events/sales + latest price
        snapshot) plus the owner's scan + favorite counts, since insights also
        surfaces scannedCount / wishlistedCount. Changes whenever any input does."""
        base = self._portfolio_dashboard_version_token(owner_user_id, resolved_tz)
        row = self.connection.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM scan_events WHERE owner_user_id = ?) AS scans,
                (SELECT COUNT(*) FROM card_favorites WHERE owner_user_id = ?) AS favs
            """,
            (owner_user_id, owner_user_id),
        ).fetchone()
        scans = str(row["scans"]) if row is not None else "0"
        favs = str(row["favs"]) if row is not None else "0"
        return f"{base}|scans={scans}|favs={favs}"

    def _compute_transaction_insights(self, *, time_zone_name: str | None = None) -> dict[str, Any]:
        """Heavy insights computation (see transaction_insights for the cache that
        wraps it). Pure analytics from the transaction memory log plus portfolio
        value + top growth; no cost basis / profit state — just what was logged."""
        owner_user_id = self._current_owner_user_id()
        time_zone = self._portfolio_time_zone(time_zone_name)
        today = datetime.now(time_zone).date()
        month_start = date(today.year, today.month, 1)

        rows = self.connection.execute(
            """
            SELECT *
            FROM card_transactions
            WHERE owner_user_id = ?
            ORDER BY occurred_at DESC, id DESC
            """,
            (owner_user_id,),
        ).fetchall()

        def empty_kinds() -> dict[str, dict[str, int]]:
            return {kind: {"count": 0, "amountCents": 0} for kind in ("sold", "bought", "traded")}

        all_time = empty_kinds()
        this_month = empty_kinds()
        biggest_sale_row: dict[str, Any] | None = None
        biggest_purchase_row: dict[str, Any] | None = None
        month_sold_rows: list[dict[str, Any]] = []

        for raw_row in rows:
            row = dict(raw_row)
            kind = str(row.get("kind") or "").strip().lower()
            if kind not in all_time:
                continue
            count = max(0, int(row.get("item_count") or 0))
            amount = int(row.get("amount_cents") or 0)
            all_time[kind]["count"] += count
            all_time[kind]["amountCents"] += amount

            occurred_dt = self._coerce_utc_datetime(row.get("occurred_at"))
            occurred_date = occurred_dt.astimezone(time_zone).date() if occurred_dt is not None else None
            in_month = occurred_date is not None and occurred_date >= month_start
            if in_month:
                this_month[kind]["count"] += count
                this_month[kind]["amountCents"] += amount

            if kind == "sold" and row.get("amount_cents") is not None:
                if biggest_sale_row is None or int(row.get("amount_cents") or 0) > int(
                    biggest_sale_row.get("amount_cents") or 0
                ):
                    biggest_sale_row = row
                if in_month:
                    month_sold_rows.append(row)

            if kind == "bought" and row.get("amount_cents") is not None:
                if biggest_purchase_row is None or int(row.get("amount_cents") or 0) > int(
                    biggest_purchase_row.get("amount_cents") or 0
                ):
                    biggest_purchase_row = row

        month_sold_rows.sort(key=lambda r: int(r.get("amount_cents") or 0), reverse=True)
        top_sales_this_month = [
            self._card_transaction_row_to_payload(r) for r in month_sold_rows[:10]
        ]

        scanned_count = 0
        try:
            scanned_row = self.connection.execute(
                "SELECT COUNT(*) AS c FROM scan_events WHERE owner_user_id = ?",
                (owner_user_id,),
            ).fetchone()
            if scanned_row is not None:
                scanned_count = int(scanned_row["c"] or 0)
        except Exception:
            scanned_count = 0

        wishlisted_count = 0
        try:
            wishlisted_row = self.connection.execute(
                "SELECT COUNT(*) AS c FROM card_favorites WHERE owner_user_id = ?",
                (owner_user_id,),
            ).fetchone()
            if wishlisted_row is not None:
                wishlisted_count = int(wishlisted_row["c"] or 0)
        except Exception:
            wishlisted_count = 0

        total_portfolio_value_cents = 0
        top_growth: list[dict[str, Any]] = []
        try:
            dashboard = self.deck_entries(limit=2000, compute_day_change=False)
            summary = dashboard.get("summary") or {}
            total_portfolio_value_cents = int(round(float(summary.get("totalValue") or 0.0) * 100))

            entries = dashboard.get("entries") or []
            entry_card_ids = [
                str((entry.get("card") or {}).get("id") or "").strip()
                for entry in entries
            ]
            cutoff_date_iso = (today - timedelta(days=30)).isoformat()
            past_rows_by_card_id = self._price_history_rows_on_or_before_by_card_id(
                entry_card_ids, cutoff_date_iso=cutoff_date_iso
            )
            # Bulk-load the cells for every past row's date up front so the resolver
            # below reads them from memory instead of issuing one cold cell query
            # per card (the N+1 that pushed cold compute to ~44s). Empty in JSON
            # mode → day_cells stays None → resolver uses its JSON-blob path.
            cells_prefetched = price_history_cells_enabled()
            cells_by_card_date = (
                self._price_history_cells_by_card_and_date(
                    card_ids=entry_card_ids,
                    price_dates=[
                        str(row["price_date"] or "").strip()
                        for row in past_rows_by_card_id.values()
                        if row is not None
                    ],
                )
                if cells_prefetched
                else {}
            )

            for entry in entries:
                card = entry.get("card") or {}
                card_id = str(card.get("id") or "").strip()
                if not card_id:
                    continue
                pricing = card.get("pricing") or {}
                current_price = self._history_primary_price_value(pricing)
                if current_price is None:
                    continue
                past_row = past_rows_by_card_id.get(card_id)
                if past_row is None:
                    continue
                slab_context = entry.get("slabContext") or {}
                history_entry = {
                    "cardID": card_id,
                    "itemKind": entry.get("itemKind"),
                    "grader": slab_context.get("grader"),
                    "grade": slab_context.get("grade"),
                    "variantName": entry.get("variantName"),
                }
                past_date = str(past_row["price_date"] or "").strip()
                past_pricing = self._portfolio_history_price_row_from_history_row(
                    history_entry,
                    row=past_row,
                    condition_code=self._portfolio_condition_code(entry.get("condition")),
                    # In cells mode pass the prefetched cells (or [] = "this date
                    # has no cells") so the resolver never runs a per-day query.
                    day_cells=(
                        cells_by_card_date.get((card_id, past_date), [])
                        if cells_prefetched
                        else None
                    ),
                )
                past_price = self._history_primary_price_value(past_pricing)
                if past_price is None or past_price <= 0:
                    continue
                if current_price <= past_price:
                    continue
                change_amount_cents = round((current_price - past_price) * 100)
                change_pct = round((current_price - past_price) / past_price * 100, 2)
                top_growth.append(
                    {
                        "cardId": card_id,
                        "name": card.get("name") or "",
                        "setName": card.get("setName") or "",
                        "cardNumber": card.get("number") or "",
                        "imageUrl": card.get("imageSmallURL") or card.get("imageLargeURL"),
                        "currencyCode": "USD",
                        "changeAmountCents": int(change_amount_cents),
                        "changePct": change_pct,
                    }
                )

            top_growth.sort(key=lambda g: g["changeAmountCents"], reverse=True)
            top_growth = top_growth[:5]
        except Exception:
            total_portfolio_value_cents = 0
            top_growth = []

        return {
            "currencyCode": "USD",
            "thisMonth": this_month,
            "allTime": all_time,
            "biggestSale": (
                self._card_transaction_row_to_payload(biggest_sale_row)
                if biggest_sale_row is not None
                else None
            ),
            "biggestPurchase": (
                self._card_transaction_row_to_payload(biggest_purchase_row)
                if biggest_purchase_row is not None
                else None
            ),
            "topSalesThisMonth": top_sales_this_month,
            "scannedCount": scanned_count,
            "wishlistedCount": wishlisted_count,
            "totalPortfolioValueCents": total_portfolio_value_cents,
            "topGrowth": top_growth,
            "refreshedAt": utc_now(),
        }

    def card_transaction_photo_object_path(self, transaction_id: str) -> str | None:
        owner_user_id = self._current_owner_user_id()
        normalized_id = str(transaction_id or "").strip()
        if not normalized_id:
            return None
        row = get_card_transaction(
            self.connection, transaction_id=normalized_id, owner_user_id=owner_user_id
        )
        if row is None:
            return None
        if str(row.get("photo_upload_status") or "").strip() != "uploaded":
            return None
        return str(row.get("photo_object_path") or "").strip() or None

    def delete_card_transaction(self, transaction_id: str) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        normalized_id = str(transaction_id or "").strip()
        if not normalized_id:
            raise ValueError("transactionID is required")
        row = get_card_transaction(
            self.connection, transaction_id=normalized_id, owner_user_id=owner_user_id
        )
        if row is None:
            raise FileNotFoundError("transaction not found")
        object_path = str(row.get("photo_object_path") or "").strip() or None
        try:
            deleted = delete_card_transaction(
                self.connection, transaction_id=normalized_id, owner_user_id=owner_user_id
            )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        if not deleted:
            raise FileNotFoundError("transaction not found")
        # Best-effort object delete; never fail the request if the blob is gone.
        if object_path:
            deleter = getattr(self.artifact_store, "delete_object", None)
            if callable(deleter):
                try:
                    deleter(object_path)
                except Exception:  # noqa: BLE001 - best-effort
                    pass
        return {"deleted": True, "id": normalized_id}

    @staticmethod
    def _should_use_scrydex_japanese_raw(evidence: RawEvidence) -> bool:
        return raw_evidence_looks_japanese(evidence)

    @staticmethod
    def _candidate_is_japanese(candidate: dict[str, Any]) -> bool:
        language = str(candidate.get("language") or "").strip().lower()
        # Accept both the resolved-candidate spellings (setID/id) and the visual
        # index entry spellings (setId/providerCardId) so this works on either.
        set_id = str(candidate.get("setID") or candidate.get("setId") or "").strip().lower()
        card_id = str(candidate.get("id") or candidate.get("providerCardId") or "").strip().lower()
        return (
            language.startswith("ja")
            or language == "japanese"
            or set_id.endswith("_ja")
            or "_ja-" in card_id
        )

    @staticmethod
    def _explicit_scan_language(payload: dict[str, Any]) -> str | None:
        """The user-selected scanner "Scanning for" language toggle, normalized
        to 'english' or 'japanese'. Returns None when the client sent no
        explicit toggle (older clients / unset), in which case candidate
        language is left to evidence inference."""
        return {
            "english": "english",
            "japanese": "japanese",
        }.get(str(payload.get("cardLanguage") or "").strip().lower())

    @staticmethod
    def _filter_candidates_by_scan_language(
        candidates: list[dict[str, Any]], scan_language: str | None
    ) -> list[dict[str, Any]]:
        """Drop candidates whose language disagrees with the explicit language
        toggle so neither the candidate list nor the top-1 pick can ever be the
        wrong language. The toggle is authoritative: an English toggle never
        surfaces Japanese candidates and a Japanese toggle surfaces only
        Japanese ones. With no explicit toggle the pool is returned unchanged."""
        if scan_language == "japanese":
            return [
                candidate
                for candidate in candidates
                if SpotlightScanService._candidate_is_japanese(candidate)
            ]
        if scan_language == "english":
            return [
                candidate
                for candidate in candidates
                if not SpotlightScanService._candidate_is_japanese(candidate)
            ]
        return list(candidates)

    @staticmethod
    def _filter_visual_matches_by_scan_language(
        matches: list[Any], scan_language: str | None
    ) -> list[Any]:
        """Same authoritative language filter as
        `_filter_candidates_by_scan_language`, but for raw visual-index match
        objects (whose card data lives on `match.entry`). With no explicit
        toggle the matches are returned unchanged."""
        if scan_language not in ("english", "japanese"):
            return list(matches)
        want_japanese = scan_language == "japanese"
        return [
            match
            for match in matches
            if SpotlightScanService._candidate_is_japanese(getattr(match, "entry", {}) or {})
            == want_japanese
        ]

    @staticmethod
    def _build_slab_evidence(payload: dict[str, Any]) -> SlabMatchEvidence:
        ocr_analysis = payload.get("ocrAnalysis") or {}
        slab_evidence = (ocr_analysis.get("slabEvidence") or {}) if isinstance(ocr_analysis, dict) else {}
        recommended_lookup_path = payload.get("slabRecommendedLookupPath")
        grader = str(slab_evidence.get("grader") or payload.get("slabGrader") or "").strip() or None
        grade = str(slab_evidence.get("grade") or payload.get("slabGrade") or "").strip() or None
        cert_number = str(slab_evidence.get("cert") or payload.get("slabCertNumber") or "").strip() or None
        parsed_label_text = tuple(
            str(text or "").strip()
            for text in (payload.get("slabParsedLabelText") or [])
            if str(text or "").strip()
        )
        label_text = str(slab_evidence.get("labelWideText") or " ".join(parsed_label_text) or "")
        card_number = str(slab_evidence.get("cardNumber") or payload.get("slabCardNumberRaw") or "").strip() or None
        alias_resolution = resolve_slab_set_aliases(
            grader=grader,
            label_text=label_text,
            parsed_label_text=parsed_label_text,
        )
        provided_set_hints = tuple(
            dict.fromkeys(
                str(token or "").strip()
                for token in (slab_evidence.get("setHints") or ())
                if str(token or "").strip()
            )
        )
        inferred_set_hints = tuple(
            SpotlightScanService._heuristic_slab_set_hints(
                label_text,
                parsed_label_text=parsed_label_text,
                card_number=card_number,
            )
        )
        # An explicit, user-selected language from the scanner "Scanning for"
        # toggle is authoritative over OCR label inference.
        explicit_card_language = str(payload.get("cardLanguage") or "").strip().lower()
        explicit_language_hint = {
            "english": "English",
            "japanese": "Japanese",
        }.get(explicit_card_language)
        language_hint = explicit_language_hint or SpotlightScanService._inferred_slab_language_hint(
            label_text,
            parsed_label_text=parsed_label_text,
        )
        set_hints = provided_set_hints or alias_resolution.scopes or inferred_set_hints
        set_hint_source = (
            "frontend"
            if provided_set_hints
            else alias_resolution.source
            if alias_resolution.scopes
            else "legacy_heuristic"
            if inferred_set_hints
            else None
        )
        raw_title_primary = str(slab_evidence.get("titleTextPrimary") or "").strip()
        raw_title_secondary = str(slab_evidence.get("titleTextSecondary") or "").strip()
        normalized_title_primary = SpotlightScanService._normalized_slab_title_text(
            raw_title_primary,
            label_text=label_text,
            parsed_label_text=parsed_label_text,
            card_number=card_number,
            set_hint_tokens=set_hints,
        )
        normalized_title_secondary = (
            SpotlightScanService._normalized_slab_title_text(
                raw_title_secondary,
                label_text=label_text,
                parsed_label_text=parsed_label_text,
                card_number=card_number,
                set_hint_tokens=set_hints,
            )
            if raw_title_secondary
            else normalized_title_primary
        )
        primary_tokens = SpotlightScanService._normalize_slab_title_tokens(
            SpotlightScanService._slab_query_tokens(normalized_title_primary)
        )
        secondary_tokens = SpotlightScanService._normalize_slab_title_tokens(
            SpotlightScanService._slab_query_tokens(normalized_title_secondary)
        )
        if (
            normalized_title_secondary
            and secondary_tokens
            and primary_tokens
            and len(primary_tokens) > len(secondary_tokens)
            and set(secondary_tokens).issubset(set(primary_tokens))
        ):
            normalized_title_primary = normalized_title_secondary
        normalized_set_hints = tuple(
            dict.fromkeys(str(token or "").strip().lower() for token in set_hints if str(token or "").strip())
        )
        variant_hints = SpotlightScanService._inferred_slab_variant_hints(label_text, parsed_label_text=parsed_label_text)
        return SlabMatchEvidence(
            title_text_primary=normalized_title_primary or raw_title_primary,
            title_text_secondary=normalized_title_secondary or raw_title_secondary,
            label_text=label_text,
            parsed_label_text=parsed_label_text,
            card_number=SpotlightScanService._normalized_slab_card_number(card_number) or card_number,
            language_hint=language_hint,
            set_hint_tokens=normalized_set_hints,
            matched_set_alias=alias_resolution.matched_alias,
            set_hint_source=set_hint_source,
            variant_hints=variant_hints,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            recommended_lookup_path=str(recommended_lookup_path or "").strip() or None,
            cross_language_set_ids=alias_resolution.cross_language_set_ids,
        )

    @staticmethod
    def _normalized_slab_card_number(value: str | None) -> str | None:
        raw = str(value or "").strip().lstrip("#").upper()
        if not raw:
            return None
        if "/" in raw:
            return canonicalize_collector_number(raw)
        cleaned = re.sub(r"[^A-Z0-9-]+", "", raw)
        if not cleaned:
            return None
        if cleaned.isdigit():
            return str(int(cleaned)) if cleaned.strip("0") else "0"
        return cleaned

    @staticmethod
    def _normalized_deck_card_condition(value: object) -> str | None:
        normalized = str(value or "").strip().lower()
        if not normalized:
            return None
        return normalized if normalized in DECK_CARD_CONDITIONS else None

    @staticmethod
    def _slab_query_tokens(value: str) -> list[str]:
        normalized = re.sub(r"[^A-Z0-9#/&+\\-]+", " ", str(value or "").upper())
        normalized = normalized.replace("-", " ").replace("/", " ")
        return [token for token in normalized.split() if token]

    @staticmethod
    def _normalize_slab_title_tokens(tokens: list[str]) -> list[str]:
        abbreviation_map = {
            "PRTD": "PRETEND",
            "MGKRP": "MAGIKARP",
        }
        merged_pair_map = {
            ("PIK", "ACHU"): "PIKACHU",
        }

        normalized_tokens: list[str] = []
        index = 0
        while index < len(tokens):
            current = str(tokens[index] or "").lstrip("#").upper()
            if not current:
                index += 1
                continue
            if index + 1 < len(tokens):
                following = str(tokens[index + 1] or "").lstrip("#").upper()
                merged = merged_pair_map.get((current, following))
                if merged:
                    normalized_tokens.append(merged)
                    index += 2
                    continue
            normalized_tokens.append(abbreviation_map.get(current, current))
            index += 1
        return normalized_tokens

    @staticmethod
    def _clean_slab_title_candidate_tokens(
        tokens: list[str],
        *,
        normalized_number: str | None,
        stop_tokens: set[str],
        drop_from_title: set[str],
        rarity_tokens: set[str],
        noise_tokens: set[str],
    ) -> list[str]:
        allowed_singletons = {"X", "V"}
        allowed_short_suffixes = {"X", "Z", "EX", "GX", "V", "VMAX", "VSTAR", "LVX"}
        cleaned: list[str] = []
        for token in tokens:
            normalized_token = str(token or "").lstrip("#").upper()
            if (
                not normalized_token
                or normalized_token in stop_tokens
                or normalized_token in {"POKEMON", "GO"}
                or normalized_token in drop_from_title
                or re.fullmatch(r"SWSH\d*", normalized_token)
                or re.fullmatch(r"\d{7,10}", normalized_token)
                or (normalized_number and (normalized_token == normalized_number or normalized_token.endswith(normalized_number)))
            ):
                continue
            if len(normalized_token) == 1 and normalized_token not in allowed_singletons:
                continue
            if normalized_token in noise_tokens:
                continue
            cleaned.append(normalized_token)
        while cleaned and cleaned[0] in rarity_tokens:
            cleaned.pop(0)
        while cleaned and cleaned[-1] in rarity_tokens:
            cleaned.pop()
        while len(cleaned) > 1 and len(cleaned[-1]) <= 3 and cleaned[-1] not in allowed_short_suffixes:
            cleaned.pop()
        return cleaned

    @staticmethod
    def _score_slab_title_candidate_tokens(
        tokens: list[str],
        *,
        rarity_tokens: set[str],
        noise_tokens: set[str],
    ) -> int:
        if not tokens:
            return -10_000
        rarity_count = sum(1 for token in tokens if token in rarity_tokens)
        noise_count = sum(1 for token in tokens if token in noise_tokens)
        duplicate_count = len(tokens) - len(set(tokens))
        meaningful_count = len(tokens) - rarity_count - noise_count
        score = 0

        if 2 <= len(tokens) <= 5:
            score += 8
        elif len(tokens) == 1:
            score += 3
        else:
            score -= max(1, len(tokens) - 5)

        if meaningful_count <= 0:
            score -= 20
        else:
            score += meaningful_count * 4

        if any(token in {"EX", "GX", "V", "VMAX", "VSTAR", "BREAK", "LVX"} for token in tokens):
            score += 8
        if "MEGA" in tokens:
            score += 6
        if any(len(token) >= 6 and token not in rarity_tokens and token not in noise_tokens for token in tokens):
            score += 4
        if tokens and tokens[0] in rarity_tokens:
            score -= 10
        if all(token in rarity_tokens for token in tokens):
            score -= 24

        score -= rarity_count * 4
        score -= noise_count * 6
        score -= duplicate_count * 10
        return score

    @staticmethod
    def _normalize_slab_variant_key(value: str | None) -> str:
        return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())

    @staticmethod
    def _slab_variant_matches(
        variant_name: str | None,
        *,
        preferred_variant: str | None = None,
        variant_hints: dict[str, Any] | None = None,
    ) -> bool:
        normalized_variant = SpotlightScanService._normalize_slab_variant_key(variant_name)
        if preferred_variant:
            return normalized_variant == SpotlightScanService._normalize_slab_variant_key(preferred_variant)
        if not variant_hints:
            return True
        if not normalized_variant:
            return False
        if bool(variant_hints.get("shadowless")) and "shadowless" not in normalized_variant:
            return False
        first_edition = variant_hints.get("firstEdition")
        if first_edition is True and "firstedition" not in normalized_variant:
            return False
        if first_edition is False and "firstedition" in normalized_variant:
            return False
        if bool(variant_hints.get("redCheeks")) and "redcheeks" not in normalized_variant:
            return False
        if bool(variant_hints.get("yellowCheeks")) and "redcheeks" in normalized_variant:
            return False
        if not bool(variant_hints.get("jumbo")) and "jumbo" in normalized_variant:
            return False
        return True

    @staticmethod
    def _slab_variant_hint_score(
        variant_name: str | None,
        *,
        variant_hints: dict[str, Any] | None = None,
    ) -> int:
        if not variant_hints:
            return 0
        normalized_variant = SpotlightScanService._normalize_slab_variant_key(variant_name)
        if not normalized_variant:
            return 0

        score = 0
        shadowless = variant_hints.get("shadowless")
        first_edition = variant_hints.get("firstEdition")
        red_cheeks = bool(variant_hints.get("redCheeks"))
        yellow_cheeks = bool(variant_hints.get("yellowCheeks"))
        jumbo = bool(variant_hints.get("jumbo"))

        if shadowless is True:
            score += 4 if "shadowless" in normalized_variant else -4
        elif shadowless is False:
            score += 1 if "shadowless" not in normalized_variant else -1

        if first_edition is True:
            score += 6 if "firstedition" in normalized_variant else -6
        elif first_edition is False:
            score += 2 if "firstedition" not in normalized_variant else -3

        if red_cheeks:
            score += 5 if "redcheeks" in normalized_variant else -5
        elif yellow_cheeks:
            score += 2 if "redcheeks" not in normalized_variant else -5

        if not jumbo and "jumbo" in normalized_variant:
            score -= 3

        return score

    @staticmethod
    def _resolve_best_graded_context_entry(
        graded_contexts: dict[str, Any],
        *,
        grader: str | None,
        grade: str | None,
        preferred_variant: str | None = None,
        variant_hints: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if preferred_variant:
            exact_variant_entry = _resolve_graded_context_entry(
                graded_contexts,
                grader=grader,
                grade=grade,
                variant=preferred_variant,
            )
            if exact_variant_entry is not None:
                return exact_variant_entry

        if not variant_hints:
            return _resolve_graded_context_entry(
                graded_contexts,
                grader=grader,
                grade=grade,
                variant=None,
            )

        grader_key = str(grader or "").strip().upper()
        grade_key = str(grade or "").strip().upper()
        if not grader_key or not grade_key:
            return None
        graders = graded_contexts.get("graders")
        if not isinstance(graders, dict):
            return None
        grade_map = graders.get(grader_key)
        if not isinstance(grade_map, dict):
            return None
        entries = grade_map.get(grade_key)
        if not isinstance(entries, list):
            return None

        ranked_entries: list[tuple[tuple[int, int, int, int, int], dict[str, Any]]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            entry_variant = str(entry.get("variant") or "").strip() or None
            hint_match = 1 if SpotlightScanService._slab_variant_matches(entry_variant, variant_hints=variant_hints) else 0
            hint_score = SpotlightScanService._slab_variant_hint_score(entry_variant, variant_hints=variant_hints)
            has_market = 1 if isinstance(entry.get("market"), (int, float)) else 0
            plain_grade = 1 if not any(bool(entry.get(flag)) for flag in ("isPerfect", "isSigned", "isError")) else 0
            has_currency = 1 if str(entry.get("currencyCode") or "").strip() else 0
            ranked_entries.append(((hint_match, hint_score, has_market, plain_grade, has_currency), entry))

        if not ranked_entries:
            return _resolve_graded_context_entry(
                graded_contexts,
                grader=grader,
                grade=grade,
                variant=None,
            )

        ranked_entries.sort(key=lambda item: item[0], reverse=True)
        return ranked_entries[0][1]

    @staticmethod
    def _resolve_best_graded_cell(
        cells: list[Any],
        *,
        grader: str | None,
        grade: str | None,
        preferred_variant: str | None = None,
        variant_hints: dict[str, Any] | None = None,
    ) -> Any | None:
        """Cells twin of ``_resolve_best_graded_context_entry`` — the RANKED
        graded resolver the current-price display path uses. Mirrors its three
        tiers exactly so a cells-backed pricing summary picks the same variant
        the JSON path picks (the June cutover attempts failed precisely because
        the cells side lacked this and fell back to the simple picker):

        1. ``preferred_variant`` short-circuit via the simple resolver (which,
           via the shared ``_pick_graded_item``, returns the exact-variant group
           when present and the base-printing default otherwise — the same
           quirk the JSON tier has; parity means replicating it).
        2. No ``variant_hints`` → the simple resolver's default pick.
        3. With hints → the same 5-factor ranked sort as the JSON tier:
           (hint match, hint score, has market, plain grade, has currency),
           evaluated on cell fields. ``_slab_variant_matches`` /
           ``_slab_variant_hint_score`` normalize internally, so the camelCase
           ``variant_key`` spelling scores identically to the JSON label.

        The cells-only corrupt-pull guard stays on tiers 1–2 (inherited from
        ``resolve_graded_entry_from_cells``); tier 3's ranked winner keeps it
        too, applied after ranking — a deliberate improvement over JSON (which
        will happily surface a garbage pull). The parity harness reports
        guard-trips separately from variant mismatches."""
        if preferred_variant:
            exact_cell = resolve_graded_entry_from_cells(
                cells,
                grader=grader,
                grade=grade,
                variant=preferred_variant,
            )
            if exact_cell is not None:
                return exact_cell

        if not variant_hints:
            return resolve_graded_entry_from_cells(
                cells,
                grader=grader,
                grade=grade,
                variant=None,
            )

        grader_key = str(grader or "").strip().upper()
        grade_key = str(grade or "").strip().upper()
        if not grader_key or not grade_key:
            return None
        matches = [
            c
            for c in cells
            if str(_cell_field(c, "lane") or "") == "graded"
            and str(_cell_field(c, "grader") or "").strip().upper() == grader_key
            and str(_cell_field(c, "grade") or "").strip().upper() == grade_key
        ]

        ranked_cells: list[tuple[tuple[int, int, int, int, int], Any]] = []
        for cell in matches:
            cell_variant = str(_cell_field(cell, "variant_key") or "").strip() or None
            hint_match = 1 if SpotlightScanService._slab_variant_matches(cell_variant, variant_hints=variant_hints) else 0
            hint_score = SpotlightScanService._slab_variant_hint_score(cell_variant, variant_hints=variant_hints)
            has_market = 1 if isinstance(_cell_field(cell, "market"), (int, float)) else 0
            plain_grade = 1 if not any(bool(_cell_field(cell, flag)) for flag in ("is_perfect", "is_signed", "is_error")) else 0
            has_currency = 1 if str(_cell_field(cell, "currency_code") or "").strip() else 0
            ranked_cells.append(((hint_match, hint_score, has_market, plain_grade, has_currency), cell))

        if not ranked_cells:
            return resolve_graded_entry_from_cells(
                cells,
                grader=grader,
                grade=grade,
                variant=None,
            )

        ranked_cells.sort(key=lambda item: item[0], reverse=True)
        chosen = ranked_cells[0][1]
        if _graded_cell_is_corrupt(chosen, cells, grade_key=grade_key, grader_key=grader_key):
            return None
        return chosen

    @staticmethod
    def _inferred_slab_variant_hints(
        label_text: str,
        *,
        parsed_label_text: tuple[str, ...],
    ) -> dict[str, Any]:
        combined_upper = " ".join(
            text.upper()
            for text in [label_text, *parsed_label_text]
            if text
        ).strip()
        explicit_first_edition = bool(re.search(r"\b(?:1ST|FIRST)\s+EDITION\b", combined_upper))
        shadowless = "SHADOWLESS" in combined_upper
        red_cheeks = bool(re.search(r"\bRED\s+CHEEKS\b", combined_upper))
        yellow_cheeks = not red_cheeks and bool(re.search(r"\bYEL(?:LOW)?\.?\s+CHEEKS\b", combined_upper))
        jumbo = "JUMBO" in combined_upper
        first_edition: bool | None = True if explicit_first_edition else (False if shadowless else None)
        return {
            "shadowless": shadowless,
            "firstEdition": first_edition,
            "redCheeks": red_cheeks,
            "yellowCheeks": yellow_cheeks,
            "jumbo": jumbo,
        }

    @staticmethod
    def _inferred_slab_language_hint(
        label_text: str,
        *,
        parsed_label_text: tuple[str, ...],
    ) -> str | None:
        combined_upper = " ".join(
            text.upper()
            for text in [label_text, *parsed_label_text]
            if text
        ).strip()
        normalized_text = re.sub(r"[^A-Z0-9]+", " ", combined_upper).strip()
        # Why: PSA cert labels use both "JPN" and "JP" as the Japanese
        # abbreviation. Accept both. Without "JP" matching, modern
        # Japanese slabs (e.g. "2023 POKEMON CLF JP CHANSEY") leak into
        # the cross-language candidate pool and waste scoring time.
        if re.search(r"\bJP[N]?\b", normalized_text) or "JPNLXY" in normalized_text:
            return "Japanese"
        language_tokens = (
            ("JAPANESE", "Japanese"),
            ("FRENCH", "French"),
            ("ENGLISH", "English"),
            ("GERMAN", "German"),
            ("ITALIAN", "Italian"),
            ("SPANISH", "Spanish"),
            ("PORTUGUESE", "Portuguese"),
            ("KOREAN", "Korean"),
            ("CHINESE", "Chinese"),
        )
        for token, label in language_tokens:
            if token in combined_upper:
                return label
        return None

    @staticmethod
    def _heuristic_slab_set_hints(
        label_text: str,
        *,
        parsed_label_text: tuple[str, ...],
        card_number: str | None,
    ) -> list[str]:
        texts = [label_text, *parsed_label_text]
        hints: list[str] = []
        seen: set[str] = set()

        def add(value: str) -> None:
            cleaned = value.strip()
            normalized = cleaned.lower()
            if not cleaned or normalized in seen:
                return
            seen.add(normalized)
            hints.append(cleaned)

        combined_upper = " ".join(text.upper() for text in texts if text).strip()

        if "POKEMON GO" in combined_upper:
            add("Pokemon GO")
            add("pgo")
            return hints

        if (
            (
                "JAPANESE" in combined_upper
                or re.search(r"\bJPN\.?\b", combined_upper)
                or "JPNLXY" in combined_upper
            )
            and "PROMO" in combined_upper
            and re.search(r"\bXY\b", combined_upper)
        ):
            add("XY Promos")
            add("xyp_ja")
            add("XY")
            return hints

        if "SHADOWLESS" in combined_upper and "POKEMON GAME" in combined_upper:
            add("Base")
            return hints

        return hints

    @staticmethod
    def _normalized_slab_title_text(
        title_text: str,
        *,
        label_text: str,
        parsed_label_text: tuple[str, ...],
        card_number: str | None,
        set_hint_tokens: tuple[str, ...],
    ) -> str:
        texts = [title_text, label_text, *parsed_label_text]
        normalized_number = SpotlightScanService._normalized_slab_card_number(card_number)
        title_candidates: list[list[str]] = []
        stop_tokens = {
            "PSA",
            "CGC",
            "BGS",
            "BECKETT",
            "SWSH",
            "NM",
            "MINT",
            "GEM",
            "MT",
            "PRISTINE",
            "PERFECT",
            "GOOD",
            "FAIR",
            "POOR",
            "DELIVERY",
            "DELIVE",
            "SHIPPING",
            "SHIP",
            "JAPANESE",
            "JPN",
            "JPNLXY",
            "GAME",
            "PROMO",
            "PROMOS",
            "XY",
            "PLAY",
            "PRIZE",
            "PACK",
            "SER",
            "SERIES",
        }
        drop_from_title = {
            "FA",
            "HOLO",
            "HOLOFOIL",
            "REVERSE",
            "FOIL",
            "SWSH",
            "YEL",
            "YELLOW",
            "CHEEKS",
            "SHADOWLESS",
            "EDITION",
            "FIRST",
            "1ST",
            "PLAY",
            "PRIZE",
            "PACK",
            "SER",
            "SERIES",
        }
        rarity_tokens = {
            "FA",
            "SPECIAL",
            "ILLUSTRATION",
            "RARE",
            "ULTRA",
            "SECRET",
            "FULL",
            "ART",
            "ALTERNATE",
            "ALT",
            "PROMO",
            "PROMOS",
            "STAR",
        }
        noise_tokens = {
            "SWSH",
            "DELIVERY",
            "SHIP",
            "SHIPPING",
            "SELL",
            "SOMETHING",
            "ELSE",
            "APR",
            "TV",
            "MIR",
            "VEV",
            "DE",
            "ON",
            "EN",
            "PFL",
            "PFLM",
            "PILM",
            "WETWENVERY",
            "WETWELVERY",
            "WRWENVERY",
            "EM",
            "ALSO",
            "VIEWED",
            "ITEMS",
            "SIMILAR",
            "EXTRA",
            "FROM",
            "OFF",
            "POKE",
            "SERIE",
            "FIND",
            "STAMP",
            "VERITYCARDVAULT",
            "FREE",
            "STAGE",
            "STAGEL",
            "TOXIC",
            "BOX",
            "FRENCH",
            "ENGLISH",
            "GERMAN",
            "ITALIAN",
            "SPANISH",
            "PORTUGUESE",
            "KOREAN",
            "CHINESE",
        }
        set_hint_drop_tokens = {
            token
            for hint in set_hint_tokens
            for token in SpotlightScanService._slab_query_tokens(hint)
            if len(token) > 1
        }
        drop_from_title.update(set_hint_drop_tokens)
        stop_tokens.update(set_hint_drop_tokens)
        noise_tokens.update({
            token
            for token in set_hint_drop_tokens
            if len(token) >= 4
        })

        direct_title_tokens = SpotlightScanService._strip_slab_condition_phrase_tokens(
            SpotlightScanService._normalize_slab_title_tokens([
                token.lstrip("#")
                for token in SpotlightScanService._slab_query_tokens(title_text)
                if token and not token.isdigit()
            ])
        )
        if normalized_number:
            number_pattern = rf"#?0*{re.escape(normalized_number)}\b" if normalized_number.isdigit() else rf"#?{re.escape(normalized_number)}\b"
            for text in texts:
                normalized_text = re.sub(r"[^A-Z0-9#/&+\\-]+", " ", text.upper()).strip()
                if not normalized_text:
                    continue
                match = re.search(rf"^(?:20\d{{2}}\s+)?(?P<pre>.*?)\s+{number_pattern}(?:\s+(?P<post>.*))?$", normalized_text)
                if not match:
                    continue
                post_tokens = SpotlightScanService._strip_slab_condition_phrase_tokens(
                    SpotlightScanService._normalize_slab_title_tokens(
                        SpotlightScanService._slab_query_tokens(match.group("post") or "")
                    )
                )
                leading_title: list[str] = []
                for token in post_tokens:
                    normalized_token = token.lstrip("#")
                    if (
                        normalized_token in stop_tokens
                        or normalized_token.isdigit()
                        or re.fullmatch(r"\d{7,10}", normalized_token)
                    ):
                        break
                    leading_title.append(normalized_token)
                if leading_title:
                    max_window = min(5, len(leading_title))
                    for window_size in range(1, max_window + 1):
                        title_candidates.append(leading_title[:window_size])

                pre_tokens = SpotlightScanService._strip_slab_condition_phrase_tokens(
                    SpotlightScanService._normalize_slab_title_tokens([
                        token.lstrip("#")
                        for token in SpotlightScanService._slab_query_tokens(match.group("pre") or "")
                        if token and not token.isdigit()
                    ])
                )
                if len(pre_tokens) >= 2:
                    for suffix_length in range(1, min(3, len(pre_tokens) - 1) + 1):
                        title_candidates.append(pre_tokens[-suffix_length:])

        cleaned_direct_title = SpotlightScanService._clean_slab_title_candidate_tokens(
            direct_title_tokens,
            normalized_number=normalized_number,
            stop_tokens=stop_tokens,
            drop_from_title=drop_from_title,
            rarity_tokens=rarity_tokens,
            noise_tokens=noise_tokens,
        )
        if cleaned_direct_title:
            max_window = min(5, len(cleaned_direct_title))
            for window_size in range(1, max_window + 1):
                for start in range(0, len(cleaned_direct_title) - window_size + 1):
                    title_candidates.append(cleaned_direct_title[start:start + window_size])

        if not title_candidates:
            tokens = SpotlightScanService._strip_slab_condition_phrase_tokens(
                SpotlightScanService._normalize_slab_title_tokens([
                    token.lstrip("#")
                    for token in SpotlightScanService._slab_query_tokens(title_text)
                    if token and not token.isdigit()
                ])
            )
            if tokens:
                title_candidates.append(tokens)

        best_tokens: list[str] | None = None
        best_score = -10_000
        for tokens in title_candidates:
            filtered = SpotlightScanService._clean_slab_title_candidate_tokens(
                tokens,
                normalized_number=normalized_number,
                stop_tokens=stop_tokens,
                drop_from_title=drop_from_title,
                rarity_tokens=rarity_tokens,
                noise_tokens=noise_tokens,
            )
            score = SpotlightScanService._score_slab_title_candidate_tokens(
                filtered,
                rarity_tokens=rarity_tokens,
                noise_tokens=noise_tokens,
            )
            if score > best_score and filtered:
                best_score = score
                best_tokens = filtered

        if best_tokens:
            return " ".join(token.title() for token in best_tokens)

        return title_text

    @staticmethod
    def _strip_slab_condition_phrase_tokens(tokens: list[str]) -> list[str]:
        cleaned: list[str] = []
        index = 0
        while index < len(tokens):
            current = str(tokens[index] or "").lstrip("#").upper()
            following = str(tokens[index + 1] or "").lstrip("#").upper() if index + 1 < len(tokens) else ""
            if (current, following) in {
                ("EX", "MT"),
                ("EX", "MINT"),
                ("VG", "EX"),
                ("GEM", "MT"),
                ("GEM", "MINT"),
                ("NM", "MT"),
                ("NM", "MINT"),
            }:
                index += 2
                continue
            cleaned.append(current)
            index += 1
        return cleaned

    @staticmethod
    def _slab_title_values(card: dict[str, Any]) -> tuple[str, ...]:
        values: list[str] = []
        seen: set[str] = set()

        def add(value: object) -> None:
            text = str(value or "").strip()
            if not text or text in seen:
                return
            seen.add(text)
            values.append(text)

        add(card.get("name"))
        for alias in card.get("titleAliases") or []:
            add(alias)
        source_payload = card.get("sourcePayload") or {}
        if isinstance(source_payload, dict):
            add(source_payload.get("name"))
            translation = source_payload.get("translation")
            if isinstance(translation, dict):
                for translation_payload in translation.values():
                    if isinstance(translation_payload, dict):
                        add(translation_payload.get("name"))
        return tuple(values)

    @staticmethod
    def _slab_set_values(card: dict[str, Any]) -> tuple[str, ...]:
        values: list[str] = []
        seen: set[str] = set()

        def add(value: object) -> None:
            text = str(value or "").strip()
            if not text or text in seen:
                return
            seen.add(text)
            values.append(text)

        add(card.get("setName"))
        add(card.get("setSeries"))
        add(card.get("setID"))
        add(card.get("setPtcgoCode"))
        source_payload = card.get("sourcePayload") or {}
        if isinstance(source_payload, dict):
            expansion = source_payload.get("expansion")
            if isinstance(expansion, dict):
                add(expansion.get("name"))
                add(expansion.get("series"))
                add(expansion.get("id"))
                add(expansion.get("code"))
        return tuple(values)

    @staticmethod
    def _slab_title_overlap(card: dict[str, Any], evidence: SlabMatchEvidence) -> float:
        query_tokens = set(tokenize(" ".join(filter(None, [evidence.title_text_primary, evidence.title_text_secondary]))))
        if not query_tokens:
            return 0.0
        candidate_tokens: set[str] = set()
        for value in SpotlightScanService._slab_title_values(card):
            candidate_tokens.update(tokenize(value))
        return len(query_tokens & candidate_tokens) / max(1, len(query_tokens))

    @staticmethod
    def _slab_set_overlap(card: dict[str, Any], evidence: SlabMatchEvidence) -> float:
        query_tokens = set(evidence.set_hint_tokens)
        if not query_tokens:
            return 0.0
        candidate_tokens: set[str] = set()
        exact_tokens: set[str] = set()
        for value in SpotlightScanService._slab_set_values(card):
            candidate_tokens.update(tokenize(value))
            exact_tokens.add(value.lower())
        overlap = len(query_tokens & candidate_tokens)
        if any(token in exact_tokens for token in query_tokens):
            overlap += 1
        return overlap / max(1, len(query_tokens))

    @staticmethod
    def _slab_set_name_in_label(card: dict[str, Any], evidence: SlabMatchEvidence) -> bool:
        """Direct tiebreaker: does the candidate's set name appear as tokens in the PSA labelText?

        The curated `slab_set_aliases.json` map is partial (e.g. "ASTRAL RADIANCE"
        isn't in it as of 2026-05), so when the PSA cert isn't cached and the
        alias fallback empty-handed, multiple candidates from different sets that
        share a card number tie at the same score and the resolver picks the
        alphabetical first. The OCR'd labelText (e.g. "2022 POKEMON SWSH
        FA/MACHAMP V ASTRAL RADIANCE #172 GEM MT 10 108468160") often contains
        the set name plainly — we just weren't using it. This boost fires only
        when ALL of the candidate setName's 4+-char alphanumeric tokens appear
        as label tokens, so noisy single-word matches ("Base", "Promo") don't
        over-fire.
        """
        label_text = (evidence.label_text or "").upper()
        if not label_text:
            return False
        set_name = str(card.get("setName") or "").strip()
        if not set_name:
            return False
        set_tokens = [token for token in re.findall(r"[A-Z0-9]+", set_name.upper()) if len(token) >= 4]
        if not set_tokens:
            return False
        label_tokens = set(re.findall(r"[A-Z0-9]+", label_text))
        return all(token in label_tokens for token in set_tokens)

    @staticmethod
    def _slab_card_number_overlap(card: dict[str, Any], evidence: SlabMatchEvidence) -> float:
        if not evidence.card_number:
            return 0.0
        expected = SpotlightScanService._normalized_slab_card_number(evidence.card_number)
        candidate = canonicalize_collector_number(str(card.get("number") or ""))
        if not expected or not candidate:
            return 0.0
        if candidate == expected:
            return 1.0
        candidate_prefix = SpotlightScanService._normalized_slab_card_number(candidate.split("/", 1)[0]) or candidate.split("/", 1)[0]
        expected_prefix = SpotlightScanService._normalized_slab_card_number(expected.split("/", 1)[0]) or expected.split("/", 1)[0]
        if candidate_prefix == expected or expected_prefix == candidate:
            return 0.9
        if candidate_prefix == expected_prefix:
            return 0.6
        if expected in candidate or candidate in expected:
            return 0.4
        return 0.0

    @staticmethod
    def _slab_label_years(evidence: SlabMatchEvidence) -> tuple[int, ...]:
        years: list[int] = []
        combined_text = " ".join(
            text
            for text in (
                evidence.label_text,
                *evidence.parsed_label_text,
                evidence.title_text_primary,
                evidence.title_text_secondary,
            )
            if text
        )
        for match in re.finditer(r"\b(19\d{2}|20\d{2})\b", combined_text):
            year = int(match.group(1))
            if 1995 <= year <= 2035 and year not in years:
                years.append(year)
        return tuple(years)

    @staticmethod
    def _slab_candidate_release_year(card: dict[str, Any]) -> int | None:
        raw_release_date = str(card.get("setReleaseDate") or card.get("set_release_date") or "").strip()
        if not raw_release_date:
            return None
        match = re.search(r"\b(19\d{2}|20\d{2})\b", raw_release_date)
        if not match:
            return None
        return int(match.group(1))

    def _slab_release_year_alignment(self, card: dict[str, Any], evidence: SlabMatchEvidence) -> tuple[float, str | None]:
        release_year = self._slab_candidate_release_year(card)
        label_years = self._slab_label_years(evidence)
        if release_year is None or not label_years:
            return 0.0, None

        closest_gap = min(abs(release_year - year) for year in label_years)
        earliest_label_year = min(label_years)
        latest_label_year = max(label_years)

        if closest_gap == 0:
            return 1.0, "release_year_exact"
        if closest_gap == 1:
            return 0.45, "release_year_near"
        if closest_gap <= 2:
            return 0.15, "release_year_near"
        if release_year > latest_label_year + 5:
            return -0.75, "release_year_modern_mismatch"
        if release_year < earliest_label_year - 5:
            return -0.35, "release_year_vintage_mismatch"
        return -0.2, "release_year_mismatch"

    def _slab_first_edition_bias(self, card: dict[str, Any], evidence: SlabMatchEvidence) -> tuple[float, str | None]:
        first_edition = evidence.variant_hints.get("firstEdition") if evidence.variant_hints else None
        if first_edition is not True:
            return 0.0, None

        release_year = self._slab_candidate_release_year(card)
        if release_year is None:
            return 0.0, None
        if release_year <= 2003:
            return 1.0, "first_edition_vintage_bias"
        if release_year >= 2010:
            return -1.0, "first_edition_modern_penalty"
        return -0.25, "first_edition_mismatch"

    def _score_slab_candidate(self, card: dict[str, Any], evidence: SlabMatchEvidence) -> tuple[float, list[str]]:
        title_overlap = self._slab_title_overlap(card, evidence)
        set_overlap = self._slab_set_overlap(card, evidence)
        card_number_overlap = self._slab_card_number_overlap(card, evidence)
        release_year_alignment, release_year_reason = self._slab_release_year_alignment(card, evidence)
        first_edition_bias, first_edition_reason = self._slab_first_edition_bias(card, evidence)
        set_name_in_label = self._slab_set_name_in_label(card, evidence)
        score = (
            (title_overlap * 50.0)
            + (card_number_overlap * 30.0)
            + (set_overlap * 20.0)
            + (release_year_alignment * 18.0)
            + (first_edition_bias * 10.0)
            # Weight above set_overlap (20) and release_year_exact (18) so a
            # direct set-name match in the OCR'd PSA label outranks the curated
            # alias signal and the year heuristic, but stays below
            # title_overlap (50) so a real title match still dominates.
            + (25.0 if set_name_in_label else 0.0)
        )
        reasons: list[str] = []
        if title_overlap > 0:
            reasons.append("title_overlap")
        if card_number_overlap >= 1.0:
            reasons.append("card_number_exact")
        elif card_number_overlap > 0:
            reasons.append("card_number_partial")
        if set_overlap > 0:
            reasons.append("set_overlap")
        if set_name_in_label:
            reasons.append("set_name_in_label_text")
        if release_year_reason and release_year_alignment != 0:
            reasons.append(release_year_reason)
        if first_edition_reason and first_edition_bias != 0:
            reasons.append(first_edition_reason)
        return round(score, 4), reasons

    @staticmethod
    def _slab_candidate_from_card(card: dict[str, Any], score_hint: float, reasons: list[str], route: str) -> dict[str, Any]:
        return {
            "id": card["id"],
            "name": card["name"],
            "setName": card["setName"],
            "number": card["number"],
            "rarity": card["rarity"],
            "variant": card["variant"],
            "language": card["language"],
            "sourceProvider": card.get("sourceProvider"),
            "sourceRecordID": card.get("sourceRecordID"),
            "setID": card.get("setID"),
            "setSeries": card.get("setSeries"),
            "setPtcgoCode": card.get("setPtcgoCode"),
            "imageURL": card.get("imageURL"),
            "imageSmallURL": card.get("imageSmallURL"),
            "sourcePayload": card.get("sourcePayload") or {},
            "_cachePresence": True,
            "_retrievalScoreHint": score_hint,
            "_retrievalRoutes": [route],
            "_reasons": reasons,
        }

    @staticmethod
    def _primary_price_value(pricing: dict[str, Any] | None) -> float | None:
        if not pricing:
            return None
        for key in ("market", "mid", "low", "trend", "high", "directLow"):
            value = pricing.get(key)
            if isinstance(value, (int, float)):
                return float(value)
        return None

    def _pricing_provenance_for_card(
        self,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
    ) -> dict[str, Any] | None:
        pricing = self._display_pricing_summary_for_card(card_id, grader=grader, grade=grade)
        if pricing is None:
            return None
        return {
            "provider": pricing.get("provider"),
            "source": pricing.get("source"),
            "variant": pricing.get("variant"),
            "currencyCode": pricing.get("currencyCode"),
            "primaryPrice": self._primary_price_value(pricing),
            "market": pricing.get("market"),
            "mid": pricing.get("mid"),
            "low": pricing.get("low"),
            "high": pricing.get("high"),
            "directLow": pricing.get("directLow"),
            "trend": pricing.get("trend"),
            "sourceUpdatedAt": pricing.get("updatedAt"),
            "refreshedAt": pricing.get("refreshedAt"),
            "sourceURL": pricing.get("sourceURL"),
        }

    def _scan_log_payload(
        self,
        request_payload: dict[str, Any],
        response_payload: dict[str, Any],
        top_candidates: list[dict[str, Any]],
    ) -> dict[str, Any]:
        top_candidate_summaries: list[dict[str, Any]] = []
        for candidate in top_candidates[:3]:
            candidate_payload = candidate["candidate"]
            pricing = candidate_payload.get("pricing") or {}
            top_candidate_summaries.append(
                {
                    "id": candidate_payload.get("id"),
                    "name": candidate_payload.get("name"),
                    "number": candidate_payload.get("number"),
                    "setName": candidate_payload.get("setName"),
                    "finalScore": round(float(candidate.get("finalScore") or 0.0), 4),
                    "pricingSource": pricing.get("source"),
                    "pricingMode": pricing.get("pricingMode"),
                    "price": self._primary_price_value(pricing),
                    "currencyCode": pricing.get("currencyCode"),
                    "variant": pricing.get("variant"),
                    "isFresh": pricing.get("isFresh"),
                }
            )

        best_candidate = top_candidate_summaries[0] if top_candidate_summaries else None
        slab_context = response_payload.get("slabContext") or {}
        best_provenance = (
            self._pricing_provenance_for_card(
                str(best_candidate["id"]),
                grader=slab_context.get("grader"),
                grade=slab_context.get("grade"),
            )
            if best_candidate and best_candidate.get("id")
            else None
        )
        if best_candidate is not None and best_provenance is not None:
            best_candidate = {
                **best_candidate,
                "provider": best_provenance.get("provider"),
                "sourceUpdatedAt": best_provenance.get("sourceUpdatedAt"),
                "refreshedAt": best_provenance.get("refreshedAt"),
                "sourceURL": best_provenance.get("sourceURL"),
            }
            top_candidate_summaries[0] = best_candidate

        payload = {
            "severity": "INFO",
            "event": "scan_match",
            "scanID": request_payload.get("scanID"),
            "capturedAt": request_payload.get("capturedAt"),
            "cropConfidence": request_payload.get("cropConfidence"),
            "resolverMode": response_payload.get("resolverMode"),
            "resolverPath": response_payload.get("resolverPath"),
            "confidence": response_payload.get("confidence"),
            "reviewDisposition": response_payload.get("reviewDisposition"),
            "reviewReason": response_payload.get("reviewReason"),
            "collectorNumber": request_payload.get("collectorNumber"),
            "setHintTokens": request_payload.get("setHintTokens") or [],
            "promoCodeHint": request_payload.get("promoCodeHint"),
            "topCandidate": best_candidate,
            "topCandidates": top_candidate_summaries,
            "ambiguityFlags": response_payload.get("ambiguityFlags") or [],
            "matcherVersion": response_payload.get("matcherVersion"),
        }
        backend_timing_debug = response_payload.get("backendTimingDebug") or {}
        if isinstance(backend_timing_debug, dict) and backend_timing_debug:
            payload["backendTimingDebug"] = backend_timing_debug
        return payload

    def _emit_structured_log(self, payload: dict[str, Any]) -> None:
        sanitized_payload = self._structured_log_value(payload)
        print(json.dumps(sanitized_payload, separators=(",", ":")), flush=True)

    @staticmethod
    def _structured_log_value(value: Any) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, (datetime, date)):
            return value.isoformat()
        if isinstance(value, Path):
            return str(value)
        if isinstance(value, sqlite3.Row):
            return {
                key: SpotlightScanService._structured_log_value(value[key])
                for key in value.keys()
            }
        if isinstance(value, dict):
            sanitized: dict[str, Any] = {}
            for key, item in value.items():
                sanitized_item = SpotlightScanService._structured_log_value(item)
                if sanitized_item is _OMIT_STRUCTURED_LOG_VALUE:
                    continue
                sanitized[str(key)] = sanitized_item
            return sanitized
        if isinstance(value, (list, tuple, set)):
            sanitized_items: list[Any] = []
            for item in value:
                sanitized_item = SpotlightScanService._structured_log_value(item)
                if sanitized_item is _OMIT_STRUCTURED_LOG_VALUE:
                    continue
                sanitized_items.append(sanitized_item)
            return sanitized_items
        if isinstance(value, (sqlite3.Connection, sqlite3.Cursor)):
            return _OMIT_STRUCTURED_LOG_VALUE
        if isinstance(value, BaseException):
            return str(value)
        if isinstance(value, bytes):
            return f"<bytes:{len(value)}>"
        return f"<{type(value).__name__}>"

    @staticmethod
    def _backend_timing_payload(response_payload: dict[str, Any]) -> dict[str, Any]:
        payload = response_payload.get("backendTimingDebug")
        if isinstance(payload, dict):
            return payload
        payload = {}
        response_payload["backendTimingDebug"] = payload
        return payload

    @staticmethod
    def _record_backend_timing(response_payload: dict[str, Any], **timings: float | int | list[dict[str, Any]] | None) -> None:
        payload = SpotlightScanService._backend_timing_payload(response_payload)
        for key, value in timings.items():
            if value is None:
                continue
            if isinstance(value, (int, float)):
                payload[key] = round(float(value), 3)
            else:
                payload[key] = value

    @staticmethod
    def _visual_matcher_timing_fields(debug: dict[str, Any] | None) -> dict[str, Any]:
        """Extract visual-matcher sub-phase timings for `backendTimingDebug` so the
        scan_match structured log can attribute the visualMatchMs tail.

        Source: `RawVisualMatcher.match_payload` returns a debug dict whose
        `timings` sub-dict carries per-phase ms values. We surface a curated
        subset here. `queryVariantCount` is also pulled because variant fanout
        is a primary tail driver (each variant runs the encoder).
        """
        if not isinstance(debug, dict):
            return {}
        timings = debug.get("timings")
        result: dict[str, Any] = {}
        if isinstance(timings, dict):
            for key in (
                "imageDecodeMs",
                "ensureRuntimeMs",
                "encoderPreprocessMs",
                "encoderForwardMs",
                "encoderPostprocessMs",
                "adapterProjectMs",
                "embeddingNormalizeMs",
                "indexSearchMs",
                "userPhotoRerankMs",
                "embeddingMs",
            ):
                value = timings.get(key)
                if isinstance(value, (int, float)):
                    result[key] = round(float(value), 3)
        variant_count = debug.get("queryVariantCount")
        if isinstance(variant_count, int):
            result["queryVariantCount"] = variant_count
        return result

    def _finalize_scan_response(
        self,
        request_payload: dict[str, Any],
        response_payload: dict[str, Any],
        top_candidates: list[dict[str, Any]],
        *,
        prediction_candidates: list[dict[str, Any]] | None = None,
    ) -> None:
        structured_log_started_at = perf_counter()
        self._emit_structured_log(self._scan_log_payload(request_payload, response_payload, top_candidates))
        structured_log_ms = (perf_counter() - structured_log_started_at) * 1000.0

        scan_log_started_at = perf_counter()
        self._log_scan(
            request_payload,
            response_payload,
            top_candidates,
            prediction_candidates=prediction_candidates,
        )
        scan_log_ms = (perf_counter() - scan_log_started_at) * 1000.0

        self._record_backend_timing(
            response_payload,
            structuredLogMs=structured_log_ms,
            scanLogMs=scan_log_ms,
            finalizeScanResponseMs=structured_log_ms + scan_log_ms,
        )

    def _scan_error_log_payload(self, request_payload: dict[str, Any], error: Exception) -> dict[str, Any]:
        return {
            "severity": "ERROR",
            "event": "scan_match_error",
            "scanID": request_payload.get("scanID"),
            "capturedAt": request_payload.get("capturedAt"),
            "cropConfidence": request_payload.get("cropConfidence"),
            "resolverModeHint": request_payload.get("resolverModeHint"),
            "collectorNumber": request_payload.get("collectorNumber"),
            "setHintTokens": request_payload.get("setHintTokens") or [],
            "promoCodeHint": request_payload.get("promoCodeHint"),
            "errorType": type(error).__name__,
            "errorText": str(error),
            "matcherVersion": MATCHER_VERSION,
        }

    def _scan_request_log_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        image = payload.get("image") or {}
        ocr_analysis = payload.get("ocrAnalysis") or {}
        raw_evidence = ocr_analysis.get("rawEvidence") or {}
        slab_evidence = ocr_analysis.get("slabEvidence") or {}
        normalized_target = ocr_analysis.get("normalizedTarget") or {}
        mode_sanity = ocr_analysis.get("modeSanitySignals") or {}
        collector_number = (
            payload.get("collectorNumber")
            or raw_evidence.get("collectorNumberExact")
            or raw_evidence.get("collectorNumberPartial")
        )
        set_hint_tokens = payload.get("setHintTokens") or raw_evidence.get("setHints") or []
        return {
            "severity": "INFO",
            "event": "scan_match_request",
            "scanID": payload.get("scanID"),
            "capturedAt": payload.get("capturedAt"),
            "resolverModeHint": payload.get("resolverModeHint"),
            "cropConfidence": payload.get("cropConfidence"),
            "imageWidth": image.get("width"),
            "imageHeight": image.get("height"),
            "recognizedTokenCount": len(payload.get("recognizedTokens") or []),
            "collectorNumber": collector_number,
            "setHintTokens": set_hint_tokens,
            "warnings": payload.get("warnings") or [],
            "ocrPipelineVersion": ocr_analysis.get("pipelineVersion"),
            "ocrSelectedMode": ocr_analysis.get("selectedMode"),
            "normalizedGeometryKind": normalized_target.get("geometryKind"),
            "normalizedUsedFallback": normalized_target.get("usedFallback"),
            "normalizedTargetQuality": ((normalized_target.get("targetQuality") or {}).get("overallScore")),
            "modeSanityWarnings": mode_sanity.get("warnings") or [],
            "rawEvidence": {
                "titleTextPrimary": raw_evidence.get("titleTextPrimary"),
                "collectorNumberExact": raw_evidence.get("collectorNumberExact"),
                "collectorNumberPartial": raw_evidence.get("collectorNumberPartial"),
                "setHints": raw_evidence.get("setHints") or [],
                "titleConfidence": ((raw_evidence.get("titleConfidence") or {}).get("score")),
                "collectorConfidence": ((raw_evidence.get("collectorConfidence") or {}).get("score")),
                "setConfidence": ((raw_evidence.get("setConfidence") or {}).get("score")),
            },
            "slabEvidence": {
                "titleTextPrimary": slab_evidence.get("titleTextPrimary"),
                "cardNumber": slab_evidence.get("cardNumber"),
                "setHints": slab_evidence.get("setHints") or [],
                "grader": slab_evidence.get("grader"),
                "grade": slab_evidence.get("grade"),
                "cert": slab_evidence.get("cert"),
            },
        }

    def _raw_resolution_log_payload(
        self,
        payload: dict[str, Any],
        debug_payload: dict[str, Any],
        *,
        local_candidate_count: int,
        remote_candidate_count: int,
        merged_candidate_count: int,
    ) -> dict[str, Any]:
        return {
            "severity": "INFO",
            "event": "scan_match_raw_resolution",
            "scanID": payload.get("scanID"),
            "resolverModeHint": payload.get("resolverModeHint"),
            "localCandidateCount": local_candidate_count,
            "remoteCandidateCount": remote_candidate_count,
            "mergedCandidateCount": merged_candidate_count,
            "evidence": debug_payload.get("evidence") or {},
            "signals": debug_payload.get("signals") or {},
            "retrievalPlan": debug_payload.get("retrievalPlan") or {},
            "remote": debug_payload.get("remote") or {},
            "topMatches": (debug_payload.get("topMatches") or [])[:3],
            "decision": debug_payload.get("decision") or {},
        }

    def health(self, *, prewarm_visual: bool = False) -> dict[str, Any]:
        active_raw_provider = self.pricing_registry.get_active_provider(for_raw=True)
        payload = {
            "status": "ok",
            "catalogCount": len(self.index),
            "matcherVersion": MATCHER_VERSION,
            "activeRawPricingProvider": active_raw_provider.get_metadata().provider_id if active_raw_provider else "none",
            "supportedScanScopes": [
                "pokemon",
                "single_card_photo",
                "raw_cards",
                "english_first",
            ],
            "experimentalScanScopes": [
                "psa_slabs",
                "graded_pricing",
            ],
            "unsupportedScanScopes": [
                "binder_pages",
                "multi_card_photo",
                "bulk_auto_detect_without_capture",
            ],
            "manualScrydexMirror": self._manual_scrydex_mirror_status(),
            "livePricing": self._live_pricing_state(),
            "scanArtifactUploads": self._scan_artifact_uploads_state(),
            "cardShowMode": self._card_show_mode_state(),
        }
        if prewarm_visual:
            payload["visualRuntime"] = self._prewarm_raw_visual_runtime(run_inference=True)
        return payload

    def provider_status(self) -> dict[str, Any]:
        provider_details: list[dict[str, Any]] = []
        scrydex_full_sync = self._scrydex_full_catalog_sync()
        scrydex_full_sync_is_fresh = self._scrydex_full_catalog_sync_is_fresh()
        for metadata in self.pricing_registry.list_providers():
            snapshot_rows = self.connection.execute(
                """
                SELECT updated_at, raw_contexts_json, graded_contexts_json
                FROM card_price_snapshots
                WHERE provider = ?
                ORDER BY updated_at DESC
                """,
                (metadata.provider_id,),
            ).fetchall()
            raw_refresh_at = None
            graded_refresh_at = None
            for row in snapshot_rows:
                if raw_refresh_at is None and _raw_context_variants(_raw_contexts_payload(row["raw_contexts_json"])):
                    raw_refresh_at = row["updated_at"]
                if graded_refresh_at is None and _graded_contexts_payload(row["graded_contexts_json"]).get("graders"):
                    graded_refresh_at = row["updated_at"]
                if raw_refresh_at is not None and graded_refresh_at is not None:
                    break
            provider_details.append(
                {
                    "providerId": metadata.provider_id,
                    "providerLabel": metadata.provider_label,
                    "isReady": metadata.is_ready,
                    "requiresCredentials": metadata.requires_credentials,
                    "supportsRawPricing": metadata.supports_raw_pricing,
                    "supportsPsaPricing": metadata.supports_psa_pricing,
                    "lastRefreshAt": raw_refresh_at,
                    "lastRawRefreshAt": raw_refresh_at,
                    "lastPsaRefreshAt": graded_refresh_at,
                    "fullCatalogSyncFresh": scrydex_full_sync_is_fresh if metadata.provider_id == SCRYDEX_PROVIDER else False,
                    "lastFullCatalogSyncAt": (
                        scrydex_full_sync.get("completedAt")
                        if metadata.provider_id == SCRYDEX_PROVIDER and scrydex_full_sync is not None
                        else None
                    ),
                }
            )
        active_raw_provider = self.pricing_registry.get_active_provider(for_raw=True)
        return {
            "providers": provider_details,
            "activeRawProvider": active_raw_provider.get_metadata().provider_id if active_raw_provider else None,
            "runtimeMode": "raw_only",
            "experimentalResolverModes": ["psa_slab"],
            "manualScrydexMirror": self._manual_scrydex_mirror_status(),
            "livePricing": self._live_pricing_state(),
            "scanArtifactUploads": self._scan_artifact_uploads_state(),
            "cardShowMode": self._card_show_mode_state(),
            "scrydexRequestStats": scrydex_request_stats_snapshot(),
            "scrydexAudit": scrydex_request_audit_summary(),
            "scrydexFullCatalogSync": scrydex_full_sync,
            "scrydexFullCatalogSyncFresh": scrydex_full_sync_is_fresh,
        }

    def scrydex_usage_summary(
        self,
        *,
        hours: int = 24,
        recent_limit: int = 25,
    ) -> dict[str, Any]:
        return scrydex_request_audit_summary(hours=hours, recent_limit=recent_limit)

    def cache_status(self) -> dict[str, Any]:
        rows = self.connection.execute(
            "SELECT raw_contexts_json, graded_contexts_json FROM card_price_snapshots",
        ).fetchall()
        raw_count = 0
        graded_count = 0
        for row in rows:
            if _raw_context_variants(_raw_contexts_payload(row["raw_contexts_json"])):
                raw_count += 1
            if _graded_contexts_payload(row["graded_contexts_json"]).get("graders"):
                graded_count += 1
        return {
            "rawSnapshots": {"count": raw_count},
            "slabSnapshots": {"count": graded_count},
        }

    def unmatched_scans(self, limit: int = 25) -> dict[str, Any]:
        rows = self.connection.execute(
            """
            SELECT
                scan_id,
                created_at,
                request_json,
                response_json,
                selected_card_id,
                correction_type,
                completed_at
            FROM scan_events
            WHERE selected_card_id IS NULL
              -- Exclude in-progress stub rows that the match handler creates
              -- up-front so /api/v1/scan-artifacts can find a FK target. They
              -- get upserted into a real row by _log_scan when the matcher
              -- finishes; if they stay at 'in_progress' beyond a few minutes
              -- it means the match crashed/timed-out — that's a separate ops
              -- signal, not an "unmatched scan that needs review."
              AND matcher_source != 'in_progress'
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        items: list[dict[str, Any]] = []
        likely_unsupported_count = 0
        abandoned_count = 0
        for row in rows:
            request_payload = json.loads(row["request_json"] or "{}")
            response_payload = json.loads(row["response_json"] or "{}")
            review_disposition = response_payload.get("reviewDisposition") or "needs_review"
            if review_disposition == "unsupported":
                likely_unsupported_count += 1
            if row["correction_type"] == "abandoned":
                abandoned_count += 1
            items.append(
                {
                    "scanID": row["scan_id"],
                    "createdAt": row["created_at"],
                    "collectorNumber": request_payload.get("collectorNumber"),
                    "confidence": response_payload.get("confidence"),
                    "resolverMode": response_payload.get("resolverMode"),
                    "resolverPath": response_payload.get("resolverPath"),
                    "reviewDisposition": review_disposition,
                    "reviewReason": response_payload.get("reviewReason"),
                    "correctionType": row["correction_type"],
                    "completedAt": row["completed_at"],
                }
            )
        return {
            "summary": {
                "openReviewCount": len(items),
                "likelyUnsupportedCount": likely_unsupported_count,
                "abandonedCount": abandoned_count,
            },
            "items": items,
        }

    def search(self, query: str, *, limit: int = 20, offset: int = 0) -> dict[str, Any]:
        offset = max(0, int(offset or 0))
        # Fetch one extra past the page to detect whether more results exist
        # (hasMore) without a second query. pool_ceiling switches search_cards
        # into paginated mode: a stable, complete candidate pool so offset pages
        # don't overlap or skip as the client scrolls.
        raw = search_cards(
            self.connection,
            query,
            limit=limit + 1,
            offset=offset,
            pool_ceiling=_MANUAL_SEARCH_POOL_CEILING,
        )
        has_more = len(raw) > limit
        results = raw[:limit]
        # Attach holo-finish options (Normal / Reverse / Poké Ball / Master Ball …)
        # so the review tool can offer a finish picker on a searched card. Additive
        # field — existing consumers ignore it.
        for card in results:
            if isinstance(card, dict):
                finishes = self._review_finishes_from_card(card)
                if finishes:
                    card["finishes"] = finishes
        return {"results": results, "hasMore": has_more}

    # ------------------------------------------------------------------
    # Reviewer-gated "label unlabeled scans" web surface (additive).
    # ------------------------------------------------------------------
    @staticmethod
    def _review_queue_safe_id(queue_id: object) -> str:
        return _REVIEW_QUEUE_ID_PATTERN.sub("", str(queue_id or "").strip())

    def _review_queue_path(self, queue_id: str) -> Path:
        safe_id = self._review_queue_safe_id(queue_id)
        if not safe_id:
            raise FileNotFoundError("review queue not found")
        # Resolve relative to the server module dir first (matches how the
        # /review page is served and how the deploy lays out backend/* on the
        # VM), then fall back to the local repo layout.
        server_dir = Path(__file__).resolve().parent
        candidates = [
            server_dir / "review_queues" / f"{safe_id}.json",
            self.repo_root / "backend" / "review_queues" / f"{safe_id}.json",
            self.repo_root / "review_queues" / f"{safe_id}.json",
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate
        return candidates[0]

    def _load_review_queue_items(self, queue_id: str) -> list[dict[str, Any]]:
        path = self._review_queue_path(queue_id)
        if not path.exists():
            raise FileNotFoundError("review queue not found")
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as error:
            raise FileNotFoundError("review queue not found") from error
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError) as error:
            raise ValueError("review queue file is not valid JSON") from error
        if isinstance(parsed, dict):
            items = parsed.get("items")
        else:
            items = parsed
        if not isinstance(items, list):
            raise ValueError("review queue file has no items list")
        normalized: list[dict[str, Any]] = []
        for item in items:
            if isinstance(item, dict) and str(item.get("scan_id") or "").strip():
                normalized.append(item)
        return normalized

    def _review_confirmed_scan_ids(self) -> set[str]:
        rows = self.connection.execute(
            "SELECT DISTINCT scan_id FROM scan_labeling_reviews WHERE label_disposition = 'confirmed'"
        ).fetchall()
        return {str(row["scan_id"]) for row in rows}

    def _review_seen_scan_ids_for_reviewer(self, reviewer_user_id: str) -> set[str]:
        rows = self.connection.execute(
            "SELECT scan_id FROM scan_labeling_reviews WHERE reviewer_user_id = ?",
            (reviewer_user_id,),
        ).fetchall()
        return {str(row["scan_id"]) for row in rows}

    # Scans this reviewer previously punted on (skip / unclear). These are the
    # "come back to it" pile — surfaced in revisit mode so they can take a
    # second look. A re-label overwrites the prior row (scan_labeling_reviews is
    # UNIQUE(scan_id, reviewer)).
    _REVIEW_REVISIT_DISPOSITIONS = ("skip", "unclear")

    def _review_reviewer_dispositions(self, reviewer_user_id: str) -> dict[str, str]:
        rows = self.connection.execute(
            "SELECT scan_id, label_disposition FROM scan_labeling_reviews "
            "WHERE reviewer_user_id = ?",
            (reviewer_user_id,),
        ).fetchall()
        return {
            str(row["scan_id"]): str(row["label_disposition"]) for row in rows
        }

    def _review_revisit_scan_ids_for_reviewer(self, reviewer_user_id: str) -> set[str]:
        placeholders = ", ".join("?" for _ in self._REVIEW_REVISIT_DISPOSITIONS)
        rows = self.connection.execute(
            "SELECT scan_id FROM scan_labeling_reviews "
            f"WHERE reviewer_user_id = ? AND label_disposition IN ({placeholders})",
            (reviewer_user_id, *self._REVIEW_REVISIT_DISPOSITIONS),
        ).fetchall()
        return {str(row["scan_id"]) for row in rows}

    def _review_pending_items(
        self, queue_id: str, reviewer_user_id: str
    ) -> list[dict[str, Any]]:
        items = self._load_review_queue_items(queue_id)
        confirmed = self._review_confirmed_scan_ids()
        seen_by_reviewer = self._review_seen_scan_ids_for_reviewer(reviewer_user_id)
        pending: list[dict[str, Any]] = []
        for item in items:
            scan_id = str(item.get("scan_id") or "").strip()
            if not scan_id:
                continue
            if scan_id in confirmed or scan_id in seen_by_reviewer:
                continue
            pending.append(item)
        return pending

    def _review_revisit_items(
        self, queue_id: str, reviewer_user_id: str
    ) -> list[dict[str, Any]]:
        """Items this reviewer earlier marked skip/unclear and can re-review.
        Anything since confirmed (by anyone) is excluded — that work is done."""
        items = self._load_review_queue_items(queue_id)
        confirmed = self._review_confirmed_scan_ids()
        revisit = self._review_revisit_scan_ids_for_reviewer(reviewer_user_id)
        pending: list[dict[str, Any]] = []
        for item in items:
            scan_id = str(item.get("scan_id") or "").strip()
            if not scan_id:
                continue
            if scan_id not in revisit or scan_id in confirmed:
                continue
            pending.append(item)
        return pending

    def _review_items_for_mode(
        self, queue_id: str, reviewer_user_id: str, mode: str
    ) -> list[dict[str, Any]]:
        if mode == "revisit":
            return self._review_revisit_items(queue_id, reviewer_user_id)
        return self._review_pending_items(queue_id, reviewer_user_id)

    @staticmethod
    def _review_card_id(card: object) -> str:
        if not isinstance(card, dict):
            return ""
        return str(card.get("card_id") or card.get("cardId") or card.get("id") or "").strip()

    _REVIEW_FINISH_LABELS = {
        "normal": "Normal",
        "holofoil": "Holo",
        "reverseHolofoil": "Reverse Holo",
        "pokeBallReverseHolofoil": "Poké Ball pattern",
        "masterBallReverseHolofoil": "Master Ball pattern",
    }

    @classmethod
    def _review_finish_label(cls, variant_name: str) -> str:
        name = str(variant_name or "").strip()
        if name in cls._REVIEW_FINISH_LABELS:
            return cls._REVIEW_FINISH_LABELS[name]
        spaced = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name)  # camelCase -> words
        return (spaced[:1].upper() + spaced[1:]) if spaced else name

    @classmethod
    def _review_finishes_from_card(cls, card: dict[str, Any]) -> list[dict[str, Any]]:
        """Finish variants (Normal / Reverse / Poké Ball / Master Ball ...) for a
        catalog card from its Scrydex payload, each with a friendly label + raw
        market price. Single-finish cards return [] so the UI skips the picker."""
        payload = card.get("sourcePayload") if isinstance(card, dict) else None
        variants = (payload or {}).get("variants") if isinstance(payload, dict) else None
        if not isinstance(variants, list):
            return []
        finishes: list[dict[str, Any]] = []
        for variant in variants:
            if not isinstance(variant, dict):
                continue
            name = str(variant.get("name") or "").strip()
            if not name:
                continue
            market = None
            for price in variant.get("prices") or []:
                if (
                    isinstance(price, dict)
                    and price.get("type") == "raw"
                    and price.get("market") is not None
                ):
                    market = price.get("market")
                    break
            finishes.append(
                {"variant": name, "label": cls._review_finish_label(name), "market": market}
            )
        return finishes if len(finishes) > 1 else []

    def _review_enrichment_map(self, card_ids: list[str]) -> dict[str, dict[str, Any]]:
        """card_id -> {image, finishes}. Scrydex image URLs are public CDN links
        (loaded directly by the browser); finishes come from the same payload."""
        unique = {cid for cid in card_ids if cid}
        if not unique:
            return {}
        out: dict[str, dict[str, Any]] = {}
        for card_id, card in cards_by_ids(self.connection, sorted(unique)).items():
            url = str(card.get("imageSmallURL") or card.get("imageURL") or "").strip()
            out[str(card_id)] = {
                "image": url or None,
                "finishes": self._review_finishes_from_card(card),
            }
        return out

    def _review_with_enrichment(
        self, card: object, enrichment_map: dict[str, dict[str, Any]]
    ) -> object:
        """Attach catalog image + finish options to a candidate / ai_label / predicted."""
        if not isinstance(card, dict):
            return card
        enrichment = enrichment_map.get(self._review_card_id(card))
        if not enrichment:
            return card
        merged = {**card}
        if enrichment.get("image"):
            merged["image"] = enrichment["image"]
        if enrichment.get("finishes"):
            merged["finishes"] = enrichment["finishes"]
        return merged

    @staticmethod
    def _review_card_brief(card_id: object, cards_map: dict[str, dict[str, Any]]) -> dict[str, Any]:
        """A {card_id,name,number,set} brief (the file-queue shape) for a card id."""
        cid = str(card_id or "").strip()
        card = cards_map.get(cid) if cid else None
        return {
            "card_id": cid,
            "name": (card or {}).get("name") or "",
            "number": (card or {}).get("number") or "",
            "set": (card or {}).get("setName") or "",
        }

    def _dynamic_review_pending(self, reviewer_user_id: str, mode: str) -> list[dict[str, Any]]:
        """Live queue: raw scans needing a label from REVIEW_DYNAMIC_SINCE onward,
        oldest first, excluding ones already confirmed (by anyone, via add-to-deck
        or the review tool) and ones this reviewer already dispositioned (pending
        mode) — or, in revisit mode, only this reviewer's skip/unclear pile."""
        params: list[Any] = [REVIEW_DYNAMIC_SINCE]
        where = (
            "FROM scan_events e JOIN scan_artifacts a ON a.scan_id = e.scan_id "
            "WHERE e.resolver_mode = 'raw_card' "
            "AND e.created_at >= ? "
            "AND a.normalized_object_path IS NOT NULL "
            "AND a.upload_status IN ('uploaded','normalized_only') "
            "AND (e.confirmed_card_id IS NULL OR e.confirmed_card_id = '') "
            "AND e.scan_id NOT IN (SELECT scan_id FROM scan_labeling_reviews "
            "WHERE label_disposition IN ('confirmed','not_a_raw_card')) "
        )
        if mode == "revisit":
            where += (
                "AND e.scan_id IN (SELECT scan_id FROM scan_labeling_reviews "
                "WHERE reviewer_user_id = ? AND label_disposition IN ('skip','unclear')) "
            )
        else:
            where += "AND e.scan_id NOT IN (SELECT scan_id FROM scan_labeling_reviews WHERE reviewer_user_id = ?) "
        params.append(reviewer_user_id)
        rows = self.connection.execute(
            "SELECT e.scan_id AS scan_id, a.normalized_object_path AS object_path, "
            "e.predicted_card_id AS predicted_card_id " + where + "ORDER BY e.created_at ASC",
            params,
        ).fetchall()
        return [
            {
                "scan_id": str(row["scan_id"]),
                "object_path": str(row["object_path"] or ""),
                "predicted_card_id": str(row["predicted_card_id"] or ""),
            }
            for row in rows
        ]

    def _dynamic_review_resolve(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Turn the lightweight pending rows for the SELECTED page into full review
        items: resolve each scan's top-10 candidates + the model's top-1 (shown as
        the AI suggestion) against the catalog. Only runs for the limited page."""
        scan_ids = [r["scan_id"] for r in rows]
        candidates_by_scan: dict[str, list[tuple[int | None, str]]] = {}
        if scan_ids:
            placeholders = ",".join("?" for _ in scan_ids)
            for cand in self.connection.execute(
                "SELECT scan_id, rank, card_id FROM scan_prediction_candidates "
                f"WHERE scan_id IN ({placeholders}) ORDER BY scan_id, rank",
                scan_ids,
            ):
                candidates_by_scan.setdefault(str(cand["scan_id"]), []).append(
                    (int(cand["rank"]) if cand["rank"] is not None else None, str(cand["card_id"] or ""))
                )
        all_card_ids: set[str] = set()
        for row in rows:
            if row["predicted_card_id"]:
                all_card_ids.add(row["predicted_card_id"])
        for cands in candidates_by_scan.values():
            all_card_ids.update(cid for _, cid in cands if cid)
        cards_map = cards_by_ids(self.connection, sorted(all_card_ids)) if all_card_ids else {}
        items: list[dict[str, Any]] = []
        for row in rows:
            predicted = self._review_card_brief(row["predicted_card_id"], cards_map) if row["predicted_card_id"] else None
            candidates = [
                {**self._review_card_brief(cid, cards_map), "rank": rank}
                for rank, cid in candidates_by_scan.get(row["scan_id"], [])[:10]
                if cid
            ]
            items.append(
                {
                    "scan_id": row["scan_id"],
                    "object_path": row["object_path"],
                    "predicted": predicted,
                    "candidates": candidates,
                    "ai_label": predicted,  # the model's top-1 — the live-queue suggestion
                }
            )
        return items

    def review_queue(
        self,
        queue_id: str,
        reviewer_user_id: str,
        *,
        limit: int = REVIEW_QUEUE_DEFAULT_LIMIT,
        mode: str = "pending",
    ) -> dict[str, Any]:
        safe_id = self._review_queue_safe_id(queue_id)
        normalized_mode = "revisit" if str(mode or "").strip() == "revisit" else "pending"
        capped_limit = max(0, int(limit))
        # In revisit mode, tell the reviewer how they previously dispositioned
        # each card so they remember why it's back in front of them.
        prior_dispositions = (
            self._review_reviewer_dispositions(reviewer_user_id)
            if normalized_mode == "revisit"
            else {}
        )
        if safe_id == REVIEW_DYNAMIC_QUEUE_ID:
            pending_rows = self._dynamic_review_pending(reviewer_user_id, normalized_mode)
            remaining = len(pending_rows)
            selected_rows = pending_rows[:capped_limit] if capped_limit else pending_rows
            selected = self._dynamic_review_resolve(selected_rows)
        else:
            pending = self._review_items_for_mode(queue_id, reviewer_user_id, normalized_mode)
            remaining = len(pending)
            selected = pending[:capped_limit] if capped_limit else pending
        items: list[dict[str, Any]] = []
        for item in selected:
            scan_id = str(item.get("scan_id") or "").strip()
            predicted = item.get("predicted")
            candidates = item.get("candidates") or []
            ai_label = item.get("ai_label")
            # Resolve catalog thumbnails for the prediction, every candidate, and
            # the AI pick so reviewers can eyeball the card art when choosing.
            card_ids = [self._review_card_id(predicted)]
            card_ids += [self._review_card_id(c) for c in candidates]
            card_ids.append(self._review_card_id(ai_label))
            enrichment_map = self._review_enrichment_map(card_ids)
            payload_item: dict[str, Any] = {
                "scan_id": scan_id,
                "predicted": self._review_with_enrichment(predicted, enrichment_map),
                "candidates": [
                    self._review_with_enrichment(c, enrichment_map) for c in candidates
                ],
                # The AI's own determination for this scan (card_id + display
                # name/tier/source/image/finishes, or {disposition:"unsure"}).
                # Surfaced so reviewers see (and can one-tap pick) the model's
                # guess. May be absent on older queues.
                "ai_label": self._review_with_enrichment(ai_label, enrichment_map),
                "image_url": f"/api/v1/review/image/{scan_id}?queue={safe_id}",
            }
            if normalized_mode == "revisit":
                payload_item["prior_disposition"] = prior_dispositions.get(scan_id)
            items.append(payload_item)
        return {"items": items, "remaining": remaining, "mode": normalized_mode}

    def review_image_object_path(self, queue_id: str, scan_id: str) -> str | None:
        target_scan_id = str(scan_id or "").strip()
        if not target_scan_id:
            return None
        if self._review_queue_safe_id(queue_id) == REVIEW_DYNAMIC_QUEUE_ID:
            row = self.connection.execute(
                "SELECT normalized_object_path FROM scan_artifacts WHERE scan_id = ?",
                (target_scan_id,),
            ).fetchone()
            path = str(row["normalized_object_path"] or "").strip() if row else ""
            return path or None
        try:
            items = self._load_review_queue_items(queue_id)
        except (FileNotFoundError, ValueError):
            return None
        for item in items:
            if str(item.get("scan_id") or "").strip() == target_scan_id:
                object_path = str(item.get("object_path") or "").strip()
                return object_path or None
        return None

    def read_scan_object_bytes(self, object_path: str) -> bytes | None:
        reader = getattr(self.artifact_store, "read_object_bytes", None)
        if not callable(reader):
            return None
        return reader(object_path)

    def record_review_label(
        self,
        *,
        scan_id: str,
        reviewer_user_id: str,
        labeled_card_id: str | None,
        label_disposition: str,
        selected_rank: int | None,
        notes: str | None,
        queue_id: str | None,
        labeled_variant: str | None = None,
        mode: str = "pending",
    ) -> dict[str, Any]:
        normalized_scan_id = str(scan_id or "").strip()
        if not normalized_scan_id:
            raise ValueError("scanID is required")
        normalized_disposition = str(label_disposition or "").strip()
        # not_a_raw_card: the capture is not a raw single — a graded slab in a
        # plastic case, or junk (a blanket, a hand, a wrapper, an empty shot)
        # that slipped into the raw queue. Like confirmed, it removes the scan
        # for EVERYONE, but it never assigns a raw card_id — so it's dropped from
        # review without poisoning the raw training corpus.
        allowed_dispositions = {"confirmed", "unclear", "not_in_top_10", "skip", "not_a_raw_card"}
        if normalized_disposition not in allowed_dispositions:
            raise ValueError(
                "labelDisposition must be one of confirmed, unclear, not_in_top_10, skip, not_a_raw_card"
            )
        normalized_card_id = str(labeled_card_id or "").strip() or None
        if normalized_disposition == "confirmed" and not normalized_card_id:
            raise ValueError("labeledCardID is required when labelDisposition is confirmed")
        normalized_rank: int | None
        if selected_rank is None:
            normalized_rank = None
        else:
            try:
                normalized_rank = int(selected_rank)
            except (TypeError, ValueError) as error:
                raise ValueError("selectedRank must be an integer") from error
        was_top_prediction = 1 if normalized_rank == 1 else 0
        normalized_notes = str(notes or "").strip() or None
        normalized_queue_id = self._review_queue_safe_id(queue_id) or None
        # Holo finish the reviewer picked (e.g. pokeBallReverseHolofoil). Only
        # meaningful for a confirmed identity; ignored otherwise.
        normalized_variant = str(labeled_variant or "").strip() or None
        if normalized_disposition != "confirmed":
            normalized_variant = None
        created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.connection.execute(
            """
            INSERT OR REPLACE INTO scan_labeling_reviews (
                id, scan_id, reviewer_user_id, reviewer_role, labeled_card_id,
                label_disposition, selected_rank, was_top_prediction, notes,
                queue_id, created_at, labeled_variant
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                uuid.uuid4().hex,
                normalized_scan_id,
                reviewer_user_id,
                "friend",
                normalized_card_id,
                normalized_disposition,
                normalized_rank,
                was_top_prediction,
                normalized_notes,
                normalized_queue_id,
                created_at,
                normalized_variant,
            ),
        )
        self.connection.commit()
        normalized_mode = "revisit" if str(mode or "").strip() == "revisit" else "pending"
        remaining = 0
        if normalized_queue_id:
            try:
                remaining = len(
                    self._review_items_for_mode(
                        normalized_queue_id, reviewer_user_id, normalized_mode
                    )
                )
            except (FileNotFoundError, ValueError):
                remaining = 0
        return {"ok": True, "remaining": remaining}

    def list_expansions(self, game: str = "pokemon", *, refresh: bool = False) -> dict[str, Any]:
        if refresh or expansion_count(self.connection) == 0:
            try:
                sync_scrydex_expansions(self.connection, game=game)
            except Exception:
                traceback.print_exc()
        expansions = list_persisted_expansions(self.connection)
        if not expansions:
            expansions = list_local_expansions(self.connection)
        return {"expansions": expansions}

    def search_expansion_cards(self, expansion_id: str, query: str = "", limit: int = 50) -> dict[str, Any]:
        cards = get_cards_by_expansion(self.connection, expansion_id, query=query, limit=limit)
        return {"results": cards}

    def _persist_mapped_catalog_card(
        self,
        *,
        mapped_card: dict[str, Any],
        sync_mode: str,
        trigger_source: str,
        query_text: str | None,
        refresh_embeddings: bool = False,
    ) -> dict[str, Any]:
        upsert_catalog_card(
            self.connection,
            mapped_card,
            self.repo_root,
            utc_now(),
            refresh_embeddings=refresh_embeddings,
        )
        self.connection.commit()
        self.refresh_index()
        return mapped_card

    def _card_exists(self, card_id: str) -> bool:
        row = self.connection.execute(
            "SELECT 1 FROM cards WHERE id = ? LIMIT 1",
            (card_id,),
        ).fetchone()
        return row is not None

    def _cached_card_by_id(self, card_id: str) -> dict[str, Any] | None:
        normalized_card_id = str(card_id or "").strip()
        if not normalized_card_id:
            return None
        # Why: lock-free. dict.get and dict.setdefault are GIL-atomic, and a
        # concurrent cache miss is benign — both threads fetch the same row
        # and setdefault converges on a single value. The old per-call lock
        # serialized every lookup, which dominated slab-scan wall time when
        # the portfolio refresh fan-out was running on a worker pool.
        sentinel = _CARD_LOOKUP_CACHE_MISS
        cached_card = self._card_lookup_cache.get(normalized_card_id, sentinel)
        if cached_card is not sentinel:
            return cached_card
        card = card_by_id(self.connection, normalized_card_id)
        return self._card_lookup_cache.setdefault(normalized_card_id, card)

    @staticmethod
    def _entry_title_aliases(entry: dict[str, Any]) -> tuple[str, ...]:
        values: list[str] = []
        seen: set[str] = set()

        def add(value: object) -> None:
            text = str(value or "").strip()
            if not text or text in seen:
                return
            seen.add(text)
            values.append(text)

        add(entry.get("name"))
        for alias in entry.get("titleAliases") or []:
            add(alias)

        source_payload = entry.get("sourcePayload") or {}
        if isinstance(source_payload, dict):
            add(source_payload.get("name"))
            translation = source_payload.get("translation")
            if isinstance(translation, dict):
                for translation_payload in translation.values():
                    if isinstance(translation_payload, dict):
                        add(translation_payload.get("name"))

        return tuple(values)

    @staticmethod
    def _with_retrieval_route(candidates: list[dict[str, Any]], route: str) -> list[dict[str, Any]]:
        annotated: list[dict[str, Any]] = []
        for candidate in candidates:
            updated = dict(candidate)
            updated["_retrievalRoutes"] = list(dict.fromkeys([route, *(candidate.get("_retrievalRoutes") or [])]))
            annotated.append(updated)
        return annotated

    @staticmethod
    def _normalized_target_quality_reasons(payload: dict[str, Any]) -> tuple[str, ...]:
        ocr_analysis = payload.get("ocrAnalysis") or {}
        normalized_target = ocr_analysis.get("normalizedTarget") or {}
        target_quality = normalized_target.get("targetQuality") or {}
        reasons = target_quality.get("reasons") or []
        return tuple(
            str(reason or "").strip().lower()
            for reason in reasons
            if str(reason or "").strip()
        )

    @classmethod
    def _uses_exact_reticle_fallback(cls, payload: dict[str, Any]) -> bool:
        return "normalization:exact_reticle_fallback" in cls._normalized_target_quality_reasons(payload)

    @classmethod
    def _should_expand_visual_hybrid_pool(
        cls,
        payload: dict[str, Any],
        evidence: RawEvidence,
    ) -> bool:
        if cls._uses_exact_reticle_fallback(payload):
            return True
        if evidence.used_fallback_normalization and evidence.target_quality_score <= 0.62:
            return True
        if evidence.crop_confidence <= 0.58 and evidence.target_quality_score <= 0.62:
            return True
        return False

    @staticmethod
    def _has_meaningful_local_ocr_rescue_signal(evidence: RawEvidence) -> bool:
        return any(
            [
                bool(str(evidence.title_text_primary or "").strip()),
                bool(str(evidence.title_text_secondary or "").strip()),
                bool(str(evidence.collector_number_exact or "").strip()),
                bool(str(evidence.collector_number_partial or "").strip()),
                bool(evidence.trusted_set_hint_tokens),
                bool(evidence.set_hint_tokens),
            ]
        )

    @classmethod
    def _visual_hybrid_top_k(
        cls,
        payload: dict[str, Any],
        evidence: RawEvidence,
    ) -> int:
        return 40 if cls._should_expand_visual_hybrid_pool(payload, evidence) else 10

    @staticmethod
    def _local_ocr_rescue_similarity(
        retrieval_score: float,
        *,
        collector_exact: bool,
        collector_partial: bool,
        title_overlap: bool,
        set_overlap: bool,
        denominator_match: bool,
    ) -> float:
        if collector_exact and title_overlap:
            base = 0.84
        elif collector_exact and (set_overlap or denominator_match):
            base = 0.80
        elif collector_exact:
            base = 0.76
        elif title_overlap and collector_partial:
            base = 0.72
        elif title_overlap and set_overlap:
            base = 0.70
        elif title_overlap:
            base = 0.64
        elif collector_partial:
            base = 0.60
        else:
            return 0.0

        bonus = min(0.02, max(0.0, retrieval_score - 30.0) / 1000.0)
        return round(min(0.86, base + bonus), 6)

    def _search_local_visual_manifest_ocr_candidates(
        self,
        evidence: RawEvidence,
        signals: RawSignalScores,
        *,
        limit: int = 24,
    ) -> list[dict[str, Any]]:
        matcher = self._raw_visual_matcher_instance()
        index = getattr(matcher, "index", None)
        if index is None:
            return []

        try:
            index.load()
            entries = list(index.entries)
        except Exception:
            return []

        query_title_tokens = set(tokenize(" ".join(filter(None, [evidence.title_text_primary, evidence.title_text_secondary]))))
        set_query_tokens = set(evidence.trusted_set_hint_tokens or evidence.set_hint_tokens)
        collector_query_values = set(evidence.collector_number_query_values)
        collector_exact = canonicalize_collector_number(evidence.collector_number_exact or "")
        printed_total_fragment = (
            f"/{evidence.collector_number_printed_total}"
            if evidence.collector_number_printed_total is not None
            else ""
        )
        prefer_japanese = raw_evidence_looks_japanese(evidence)

        if not any([query_title_tokens, set_query_tokens, collector_query_values, printed_total_fragment]):
            return []

        scored: list[tuple[float, float, float, dict[str, Any]]] = []
        for entry in entries:
            candidate_language = str(entry.get("language") or "").strip().lower()
            if prefer_japanese and candidate_language and candidate_language != "japanese":
                continue
            if not prefer_japanese and query_title_tokens and candidate_language == "japanese":
                continue

            entry_number = canonicalize_collector_number(str(entry.get("collectorNumber") or ""))
            title_overlap = False
            if query_title_tokens:
                candidate_title_tokens: set[str] = set()
                for value in self._entry_title_aliases(entry):
                    candidate_title_tokens.update(tokenize(value))
                title_overlap = bool(query_title_tokens & candidate_title_tokens)
            collector_match = False
            if collector_exact and entry_number == collector_exact:
                collector_match = True
            elif collector_query_values and any(query_value in entry_number for query_value in collector_query_values):
                collector_match = True
            elif printed_total_fragment and printed_total_fragment in entry_number:
                collector_match = True

            set_match = False
            if set_query_tokens:
                candidate_set_tokens = set(
                    tokenize(
                        " ".join(
                            part
                            for part in [
                                entry.get("setName") or "",
                                entry.get("setSeries") or "",
                                entry.get("setId") or "",
                                entry.get("setPtcgoCode") or "",
                            ]
                            if part
                        )
                    )
                )
                set_match = bool(set_query_tokens & candidate_set_tokens)

            if not (title_overlap or collector_match or set_match):
                continue

            candidate = self._visual_candidate_stub(entry)
            retrieval_score = score_raw_candidate_retrieval(candidate, evidence, signals)
            if retrieval_score <= 0.0:
                continue
            resolution_score, breakdown, reasons = score_raw_candidate_resolution(candidate, evidence)
            pseudo_similarity = self._local_ocr_rescue_similarity(
                retrieval_score,
                collector_exact=breakdown.collector_exact_score > 0.0,
                collector_partial=breakdown.collector_partial_score > 0.0,
                title_overlap=breakdown.title_overlap_score > 0.0,
                set_overlap=breakdown.set_overlap_score > 0.0,
                denominator_match=breakdown.collector_denominator_score > 0.0,
            )
            if pseudo_similarity <= 0.0:
                continue

            candidate["_visualSimilarity"] = pseudo_similarity
            candidate["_visualSimilaritySource"] = "local_ocr_rescue"
            candidate["_retrievalScoreHint"] = round(retrieval_score, 4)
            candidate["_cachePresence"] = False
            candidate["_retrievalRoutes"] = ["local_visual_manifest_ocr"]
            candidate["_ocrRescueReasons"] = list(reasons)
            candidate["_ocrRescueResolutionScore"] = round(resolution_score, 4)
            scored.append((pseudo_similarity, retrieval_score, resolution_score, candidate))

        scored.sort(
            key=lambda item: (
                -item[0],
                -item[1],
                -item[2],
                str(item[3].get("name") or ""),
                str(item[3].get("number") or ""),
            )
        )

        deduped: dict[str, dict[str, Any]] = {}
        for _, _, _, candidate in scored:
            candidate_id = str(candidate.get("id") or "")
            if not candidate_id or candidate_id in deduped:
                continue
            deduped[candidate_id] = candidate
            if len(deduped) >= limit:
                break
        return list(deduped.values())

    @classmethod
    def _should_fail_closed_for_retake(
        cls,
        payload: dict[str, Any],
        evidence: RawEvidence,
        signals: RawSignalScores,
        decision: RawDecisionResult,
    ) -> bool:
        if not (cls._uses_exact_reticle_fallback(payload) or evidence.used_fallback_normalization):
            return False
        if evidence.target_quality_score > 0.52 or evidence.crop_confidence > 0.52:
            return False
        if any([
            signals.collector_signal >= 60,
            signals.title_signal >= 35,
            signals.set_signal >= 65,
            bool(evidence.collector_number_exact),
            bool(evidence.collector_number_partial),
            bool(evidence.title_text_primary.strip()),
            bool(evidence.title_text_secondary.strip()),
            bool(evidence.trusted_set_hint_tokens),
        ]):
            return False
        return True

    def _retrieve_local_raw_candidates(
        self,
        evidence: RawEvidence,
        signals: RawSignalScores,
        plan: RawRetrievalPlan,
    ) -> list[dict[str, Any]]:
        candidate_groups: list[list[dict[str, Any]]] = []
        routes = set(plan.routes)
        has_trusted_set = bool(evidence.trusted_set_hint_tokens)

        if "collector_set_exact" in routes:
            candidate_groups.append(search_cards_local_collector_set(self.connection, evidence, limit=12))
        if "title_set_primary" in routes:
            candidate_groups.append(search_cards_local_title_set(self.connection, evidence, limit=12))
        if "title_collector" in routes:
            candidate_groups.append(self._with_retrieval_route(search_cards_local_title_only(self.connection, evidence, limit=12), "title_collector"))
            if not has_trusted_set:
                candidate_groups.append(self._with_retrieval_route(search_cards_local_collector_only(self.connection, evidence, limit=12), "title_collector"))
        else:
            if "title_only" in routes:
                candidate_groups.append(search_cards_local_title_only(self.connection, evidence, limit=12))
            if "collector_only" in routes and not has_trusted_set:
                candidate_groups.append(search_cards_local_collector_only(self.connection, evidence, limit=12))

        if "broad_text_fallback" in routes and evidence.recognized_text:
            fallback_group = self._with_retrieval_route(
                search_cards_local(self.connection, evidence.recognized_text, limit=12),
                "broad_text_fallback",
            )
            for candidate in fallback_group:
                candidate["_cachePresence"] = True
            candidate_groups.append(fallback_group)

        merged = merge_raw_candidate_pools(candidate_groups)
        if self._should_use_scrydex_japanese_raw(evidence):
            merged = [candidate for candidate in merged if self._candidate_is_japanese(candidate)]
        return merged

    def _retrieve_remote_raw_candidates(
        self,
        evidence: RawEvidence,
        signals: RawSignalScores,
        plan: RawRetrievalPlan,
        api_key: str | None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        del api_key
        if not self._live_scrydex_searches_allowed():
            return [], {
                "queries": [],
                "attempts": [],
                "resultCount": 0,
                "reason": "search_policy_blocked",
            }
        if not plan.should_query_remote:
            return [], {
                "queries": [],
                "attempts": [],
                "resultCount": 0,
                "reason": "plan_disabled",
            }
        remote_search = search_remote_scrydex_raw_candidates(evidence, signals, page_size=10)
        queries = [attempt["query"] for attempt in remote_search.attempts]
        if not queries:
            return [], {
                "queries": [],
                "attempts": [],
                "resultCount": 0,
                "reason": "no_queries",
            }
        remote_candidates = best_remote_scrydex_raw_candidates(remote_search.cards, evidence, signals, limit=12)
        return remote_candidates, {
            "queries": queries,
            "attempts": remote_search.attempts,
            "resultCount": len(remote_search.cards),
            "reason": None,
        }

    def _retrieve_local_slab_candidates(self, evidence: SlabMatchEvidence) -> list[dict[str, Any]]:
        structured_candidates = self._retrieve_structured_local_slab_candidates(evidence)
        if structured_candidates:
            return structured_candidates[:12]

        query_parts = list(dict.fromkeys(
            part
            for part in [
                evidence.title_text_primary,
                evidence.title_text_secondary,
                *evidence.set_hint_tokens,
            ]
            if part
        ))
        seen: set[str] = set()
        candidates: list[dict[str, Any]] = []
        for query in query_parts:
            for card in search_cards_local(self.connection, query, limit=12):
                card_id = str(card.get("id") or "")
                if not card_id or card_id in seen or not self._slab_candidate_matches_language_hint(card, evidence):
                    continue
                seen.add(card_id)
                score, reasons = self._score_slab_candidate(card, evidence)
                if score <= 0:
                    continue
                candidates.append(self._slab_candidate_from_card(card, score, reasons, "local_slab_lookup"))
        candidates.sort(
            key=lambda candidate: (
                -float(candidate.get("_retrievalScoreHint") or 0.0),
                str(candidate.get("name") or ""),
                str(candidate.get("number") or ""),
            )
        )
        return candidates[:12]

    @staticmethod
    def _slab_number_query_values(card_number: str | None) -> tuple[tuple[str, ...], tuple[str, ...]]:
        normalized = SpotlightScanService._normalized_slab_card_number(card_number)
        if not normalized:
            return tuple(), tuple()

        exact_values: list[str] = []
        like_values: list[str] = []
        seen_exact: set[str] = set()
        seen_like: set[str] = set()

        def add_exact(value: str) -> None:
            cleaned = str(value or "").strip().upper()
            if not cleaned or cleaned in seen_exact:
                return
            seen_exact.add(cleaned)
            exact_values.append(cleaned)

        def add_like(value: str) -> None:
            cleaned = str(value or "").strip().upper()
            if not cleaned or cleaned in seen_like:
                return
            seen_like.add(cleaned)
            like_values.append(cleaned)

        add_exact(normalized)
        prefix = normalized.split("/", 1)[0]
        add_exact(prefix)
        add_like(f"{prefix}/%")
        add_exact(f"NO.{prefix}")
        add_exact(f"NO. {prefix}")
        add_like(f"NO.{prefix}/%")
        add_like(f"NO. {prefix}/%")

        if prefix.isdigit():
            max_width = max(4, len(prefix))
            for width in range(len(prefix) + 1, max_width + 1):
                padded = prefix.zfill(width)
                add_exact(padded)
                add_like(f"{padded}/%")
                add_exact(f"NO.{padded}")
                add_exact(f"NO. {padded}")
                add_like(f"NO.{padded}/%")
                add_like(f"NO. {padded}/%")

        return tuple(exact_values), tuple(like_values)

    def _local_slab_cards_by_number(
        self,
        card_number: str | None,
        *,
        limit: int = 400,
        language_hint: str | None = None,
        label_years: tuple[int, ...] = (),
        year_window: int = 5,
    ) -> list[dict[str, Any]]:
        exact_values, like_values = self._slab_number_query_values(card_number)
        if not exact_values and not like_values:
            return []

        number_clauses: list[str] = []
        params: list[Any] = []
        for value in exact_values:
            number_clauses.append("UPPER(number) = ?")
            params.append(value)
        for value in like_values:
            number_clauses.append("UPPER(number) LIKE ?")
            params.append(value)

        where_parts: list[str] = [f"({' OR '.join(number_clauses)})"]

        # Why: pre-filter the candidate pool at the SQL layer instead of
        # scoring every card in Python. For narrow scans (e.g. Chansey
        # "#015"), the unfiltered pool was ~400 rows and dominated the
        # slab-match wall time once you multiply by GIL contention. The
        # language and year filters cut the pool to a handful for typical
        # graded modern Japanese slabs.
        language_filter = self._slab_sql_language_clause(language_hint)
        if language_filter is not None:
            clause, language_params = language_filter
            where_parts.append(clause)
            params.extend(language_params)

        year_filter = self._slab_sql_year_window_clause(label_years, year_window)
        if year_filter is not None:
            clause, year_params = year_filter
            where_parts.append(clause)
            params.extend(year_params)

        params.append(limit)

        rows = self.connection.execute(
            f"""
            SELECT id
            FROM cards
            WHERE {" AND ".join(where_parts)}
            LIMIT ?
            """,
            params,
        ).fetchall()
        all_ids = [str(row["id"] or "").strip() for row in rows if row["id"]]
        # Batch-load all missing IDs in two queries (card rows + title aliases)
        # instead of calling card_by_id once per row (2 queries × N rows).
        self._prime_card_lookup_cache(all_ids)
        cards: list[dict[str, Any]] = []
        seen: set[str] = set()
        for card_id in all_ids:
            if not card_id or card_id in seen:
                continue
            seen.add(card_id)
            cached = self._cached_card_by_id(card_id)
            if cached is not None:
                cards.append(cached)
        return cards

    def _local_cards_by_set_ids_and_number(
        self,
        set_ids: tuple[str, ...],
        card_number: str | None,
        *,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """Targeted lookup by set_id + number with no language filter.

        Why: cross-language alias entries (e.g. CLF JP → clv) explicitly name
        an English set_id that would otherwise be excluded by the language hint
        filter.  This helper bypasses that filter for the matched set only and
        is only called when evidence.cross_language_set_ids is non-empty.
        """
        if not set_ids or not card_number:
            return []
        exact_values, like_values = self._slab_number_query_values(card_number)
        if not exact_values and not like_values:
            return []
        set_placeholders = ",".join("?" for _ in set_ids)
        number_clauses: list[str] = []
        params: list[Any] = list(set_ids)
        for value in exact_values:
            number_clauses.append("UPPER(number) = ?")
            params.append(value)
        for value in like_values:
            number_clauses.append("UPPER(number) LIKE ?")
            params.append(value)
        params.append(limit)
        rows = self.connection.execute(
            f"SELECT id FROM cards WHERE set_id IN ({set_placeholders})"
            f" AND ({' OR '.join(number_clauses)}) LIMIT ?",
            params,
        ).fetchall()
        all_ids = [str(row["id"] or "").strip() for row in rows if row["id"]]
        self._prime_card_lookup_cache(all_ids)
        return [
            cached
            for card_id in all_ids
            if (cached := self._cached_card_by_id(card_id)) is not None
        ]

    @staticmethod
    def _slab_sql_language_clause(
        language_hint: str | None,
    ) -> tuple[str, list[Any]] | None:
        hint = str(language_hint or "").strip().lower()
        if not hint:
            return None
        if hint == "japanese":
            # Cards whose language is Japanese, anything starting with "ja",
            # or whose language field is NULL/empty (legacy rows) — keep the
            # last to avoid dropping rows that simply lack a language tag.
            return (
                "(LOWER(IFNULL(language, '')) IN ('japanese', 'ja') "
                "OR LOWER(IFNULL(language, '')) LIKE 'ja%' "
                "OR IFNULL(language, '') = '')",
                [],
            )
        if hint in {"english", "french", "german", "italian", "spanish", "portuguese", "korean", "chinese"}:
            # Non-Japanese hint: exclude clearly-Japanese rows; keep nulls.
            return (
                "(LOWER(IFNULL(language, '')) NOT LIKE 'ja%')",
                [],
            )
        return None

    @staticmethod
    def _slab_sql_year_window_clause(
        label_years: tuple[int, ...],
        window: int,
    ) -> tuple[str, list[Any]] | None:
        if not label_years:
            return None
        earliest = min(label_years) - window
        latest = max(label_years) + window
        # Why: cards without a release date are kept (legacy / promo rows
        # often lack one). Cards with an explicit date must fall inside the
        # slab year window. SQLite stores set_release_date as TEXT, so we
        # compare on the leading 4 chars (ISO-style 'YYYY-MM-DD').
        return (
            "(set_release_date IS NULL "
            "OR set_release_date = '' "
            "OR CAST(substr(set_release_date, 1, 4) AS INTEGER) BETWEEN ? AND ?)",
            [earliest, latest],
        )

    def _slab_candidate_matches_language_hint(self, card: dict[str, Any], evidence: SlabMatchEvidence) -> bool:
        hint = str(evidence.language_hint or "").strip().lower()
        if not hint:
            return True
        if hint == "japanese":
            return self._candidate_is_japanese(card)
        if hint in {"english", "french", "german", "italian", "spanish", "portuguese", "korean", "chinese"}:
            return not self._candidate_is_japanese(card)
        return True

    def _retrieve_structured_local_slab_candidates(self, evidence: SlabMatchEvidence) -> list[dict[str, Any]]:
        cards = self._local_slab_cards_by_number(
            evidence.card_number,
            language_hint=evidence.language_hint,
            label_years=self._slab_label_years(evidence),
        )

        candidates: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for card in cards:
            if not self._slab_candidate_matches_language_hint(card, evidence):
                continue
            score, reasons = self._score_slab_candidate(card, evidence)
            if score <= 0:
                continue
            card_id = str(card.get("id") or "")
            seen_ids.add(card_id)
            candidates.append(self._slab_candidate_from_card(card, score, reasons, "local_slab_structured"))

        # When the alias explicitly resolved to cross-language set IDs (e.g. CLF JP
        # → clv), also look up cards in those sets by number without the language
        # filter.  This lets the English Classic set stand in for the Japanese
        # variant when Scrydex has no separate Japanese entry.
        if evidence.cross_language_set_ids:
            cl_cards = self._local_cards_by_set_ids_and_number(
                evidence.cross_language_set_ids,
                evidence.card_number,
            )
            for card in cl_cards:
                card_id = str(card.get("id") or "")
                if card_id in seen_ids:
                    continue
                seen_ids.add(card_id)
                # Strip deck-specific suffix from the set name so the card
                # displays as "Pokémon TCG Classic" rather than
                # "Pokémon TCG Classic - Venusaur" etc.
                raw_set_name = str(card.get("setName") or "")
                cleaned_set_name = _strip_cross_language_set_suffix(raw_set_name)
                card = {**card, "setName": cleaned_set_name} if cleaned_set_name != raw_set_name else card
                score, reasons = self._score_slab_candidate(card, evidence)
                if score <= 0:
                    continue
                candidates.append(self._slab_candidate_from_card(card, score, reasons, "local_slab_cross_language"))

        if not candidates:
            return []
        candidates.sort(
            key=lambda candidate: (
                -float(candidate.get("_retrievalScoreHint") or 0.0),
                str(candidate.get("name") or ""),
                str(candidate.get("number") or ""),
            )
        )
        return candidates[:12]

    def _retrieve_remote_slab_candidates(self, evidence: SlabMatchEvidence) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        if not self._live_scrydex_searches_allowed():
            return [], {
                "queries": [],
                "attempts": [],
                "resultCount": 0,
                "reason": "search_policy_blocked",
            }
        title_text = evidence.title_text_primary or evidence.title_text_secondary
        search_result = search_remote_scrydex_slab_candidates(
            title_text=title_text,
            label_text=evidence.label_text,
            parsed_label_text=list(evidence.parsed_label_text),
            card_number=evidence.card_number,
            set_hint_tokens=list(evidence.set_hint_tokens),
            page_size=10,
        )
        candidates: list[dict[str, Any]] = []
        for raw_card in search_result.cards:
            mapped = map_scrydex_catalog_card(raw_card)
            candidate = {
                "id": mapped["id"],
                "name": mapped["name"],
                "setName": mapped["set_name"],
                "number": mapped["number"],
                "rarity": mapped["rarity"],
                "variant": mapped["variant"],
                "language": mapped["language"],
                "sourceProvider": mapped.get("source"),
                "sourceRecordID": mapped.get("source_record_id"),
                "setID": mapped.get("set_id"),
                "setSeries": mapped.get("set_series"),
                "setPtcgoCode": mapped.get("set_ptcgo_code"),
                "imageURL": mapped.get("reference_image_url"),
                "imageSmallURL": mapped.get("reference_image_small_url"),
                "sourcePayload": mapped.get("source_payload") or {},
                "_cachePresence": False,
                "_retrievalRoutes": ["remote_provider_scrydex_slab"],
            }
            score, reasons = self._score_slab_candidate(candidate, evidence)
            if score <= 0:
                continue
            candidate["_retrievalScoreHint"] = score
            candidate["_reasons"] = reasons
            candidates.append(candidate)
        candidates.sort(
            key=lambda candidate: (
                -float(candidate.get("_retrievalScoreHint") or 0.0),
                str(candidate.get("name") or ""),
                str(candidate.get("number") or ""),
            )
        )
        return candidates[:12], {
            "queries": [attempt["query"] for attempt in search_result.attempts],
            "attempts": search_result.attempts,
            "resultCount": len(search_result.cards),
            "reason": None if search_result.attempts else "no_queries",
        }

    def _ensure_raw_card_cached(self, card: dict[str, Any], trigger_source: str) -> dict[str, Any]:
        card_id = str(card.get("id") or "").strip()
        if not card_id:
            return card

        source_payload = card.get("sourcePayload") or card.get("source_payload") or {}
        source_provider = str(card.get("sourceProvider") or card.get("source") or "").strip().lower()
        mapped_card: dict[str, Any] | None = None
        if isinstance(source_payload, dict):
            try:
                if source_provider == "scrydex" or source_payload.get("printed_number") is not None or source_payload.get("expansion") is not None:
                    mapped_card = map_scrydex_catalog_card(source_payload)
            except Exception:
                mapped_card = None

        if mapped_card is None:
            mapped_card = {
                "id": card_id,
                "name": str(card.get("name") or ""),
                "set_name": str(card.get("setName") or ""),
                "number": str(card.get("number") or ""),
                "rarity": str(card.get("rarity") or "Unknown"),
                "variant": str(card.get("variant") or "Raw"),
                "language": str(card.get("language") or "English"),
                "reference_image_path": None,
                "reference_image_url": card.get("imageURL"),
                "reference_image_small_url": card.get("imageSmallURL"),
                "source": str(card.get("sourceProvider") or "scrydex"),
                "source_record_id": str(card.get("sourceRecordID") or card_id),
                "set_id": card.get("setID"),
                "set_series": card.get("setSeries"),
                "set_ptcgo_code": card.get("setPtcgoCode"),
                "set_release_date": None,
                "supertype": None,
                "subtypes": [],
                "types": [],
                "artist": None,
                "regulation_mark": None,
                "national_pokedex_numbers": [],
                "tcgplayer": {},
                "cardmarket": {},
                "source_payload": source_payload if isinstance(source_payload, dict) else {},
            }

        provider_prices = (((mapped_card.get("tcgplayer") or {}) if isinstance(mapped_card, dict) else {}).get("prices") or {})
        cached = card_by_id(self.connection, card_id)
        if cached is not None:
            cached_pricing = contextual_pricing_summary_for_card(self.connection, card_id)
            if cached_pricing is None and source_provider == "scrydex" and isinstance(source_payload, dict) and source_payload:
                persisted = persist_scrydex_raw_snapshot(self.connection, card_id, source_payload)
                if persisted is not None:
                    return card_by_id(self.connection, card_id) or cached
            if cached_pricing is None and provider_prices:
                self._persist_mapped_catalog_card(
                    mapped_card=mapped_card,
                    sync_mode="raw_candidate_cache",
                    trigger_source=trigger_source,
                    query_text=card_id,
                    refresh_embeddings=False,
                )
                return card_by_id(self.connection, card_id) or cached
            return cached

        self._persist_mapped_catalog_card(
            mapped_card=mapped_card,
            sync_mode="raw_candidate_cache",
            trigger_source=trigger_source,
            query_text=card_id,
            refresh_embeddings=False,
        )
        if source_provider == "scrydex" and isinstance(source_payload, dict) and source_payload:
            persist_scrydex_raw_snapshot(self.connection, card_id, source_payload)
        return card_by_id(self.connection, card_id) or card

    @staticmethod
    def _candidate_base_payload(resolved_card: dict[str, Any], original_card: dict[str, Any]) -> dict[str, Any]:
        card_id = str(resolved_card.get("id") or original_card.get("id") or "")
        return {
            "id": card_id,
            "name": str(resolved_card.get("name") or original_card.get("name") or ""),
            "setName": str(resolved_card.get("setName") or original_card.get("setName") or ""),
            "number": str(resolved_card.get("number") or original_card.get("number") or ""),
            "rarity": str(resolved_card.get("rarity") or original_card.get("rarity") or "Unknown"),
            "variant": str(resolved_card.get("variant") or original_card.get("variant") or "Raw"),
            "language": str(resolved_card.get("language") or original_card.get("language") or "English"),
            "imageSmallURL": resolved_card.get("imageSmallURL") or original_card.get("imageSmallURL"),
            "imageLargeURL": resolved_card.get("imageURL") or original_card.get("imageLargeURL") or original_card.get("imageURL"),
        }

    def _candidate_payload(
        self,
        card: dict[str, Any],
        *,
        pricing_context: PricingContext,
        trigger_source: str,
        ensure_cached: bool = False,
        api_key: str | None = None,
        refresh_pricing_if_stale: bool = False,
        refresh_pricing_if_missing: bool = False,
        force_show_mode_refresh: bool = False,
        card_show_mode_active: bool | None = None,
        snapshot_row: sqlite3.Row | None = None,
        timing_output: dict[str, float] | None = None,
    ) -> dict[str, Any]:
        candidate_started_at = perf_counter()
        ensure_cached_started_at = perf_counter()
        resolved_card = self._ensure_raw_card_cached(card, trigger_source) if ensure_cached else card
        ensure_cached_ms = (perf_counter() - ensure_cached_started_at) * 1000.0
        card_id = str(resolved_card.get("id") or "").strip()
        pricing_lookup_started_at = perf_counter()
        pricing = (
            self._display_pricing_summary_for_context(
                card_id,
                pricing_context=pricing_context,
                snapshot_row=snapshot_row,
            )
            if card_id
            else None
        )
        pricing_lookup_ms = (perf_counter() - pricing_lookup_started_at) * 1000.0
        pricing_refresh_ms = 0.0
        candidate_build_started_at = perf_counter()
        if card_show_mode_active is None:
            # Show mode gates app ACCESS only; it must NEVER force a live pricing
            # refresh (that burns Scrydex credits). Pricing refresh follows the
            # missing/stale rules + the independent live-pricing controls only.
            card_show_mode_active = False
        pricing_missing = pricing is None
        pricing_stale = pricing is not None and not self._pricing_within_live_refresh_window(pricing)
        should_force_show_mode_refresh = card_show_mode_active and force_show_mode_refresh
        should_refresh = (
            card_id
            and self._live_scrydex_pricing_refresh_allowed()
            and (
                should_force_show_mode_refresh
                or (pricing_missing and refresh_pricing_if_missing)
                or (pricing_stale and refresh_pricing_if_stale)
            )
        )

        if should_refresh:
            refresh_started_at = perf_counter()
            refreshed_detail = self._refresh_card_pricing_for_context(
                card_id,
                pricing_context=pricing_context,
                api_key=api_key,
                force_refresh=should_force_show_mode_refresh,
            )
            pricing_refresh_ms = (perf_counter() - refresh_started_at) * 1000.0
            pricing = ((refreshed_detail or {}).get("card", {}) or {}).get("pricing") if isinstance(refreshed_detail, dict) else None
            if pricing is None:
                fallback_started_at = perf_counter()
                pricing = self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context)
                pricing_lookup_ms += (perf_counter() - fallback_started_at) * 1000.0

        candidate = self._candidate_base_payload(resolved_card, card)
        if pricing is not None:
            candidate["pricing"] = pricing
        if timing_output is not None:
            timing_output.update(
                {
                    "ensureCachedMs": round(ensure_cached_ms, 3),
                    "pricingLookupMs": round(pricing_lookup_ms, 3),
                    "pricingRefreshMs": round(pricing_refresh_ms, 3),
                    "candidateBuildMs": round((perf_counter() - candidate_build_started_at) * 1000.0, 3),
                    "candidatePayloadMs": round((perf_counter() - candidate_started_at) * 1000.0, 3),
                }
            )
        return candidate

    def _scan_candidate_pricing_policy(
        self,
        *,
        refresh_top_candidate_stale: bool,
        refresh_top_candidate_missing: bool,
        force_show_mode_top_candidate_refresh: bool = False,
    ) -> PricingLoadPolicy:
        if not self._live_scrydex_pricing_refresh_allowed():
            # Scan candidate lists are intentionally SQLite-only when live
            # pricing is disabled. Ranking/alternatives must not issue hidden
            # provider requests in the default cron-backed mode.
            return PricingLoadPolicy.top_ten_cached_only()
        return PricingLoadPolicy.top_ten_live_refresh(
            refresh_stale=refresh_top_candidate_stale,
            refresh_missing=refresh_top_candidate_missing,
            force_show_mode_refresh=force_show_mode_top_candidate_refresh,
        )

    def _encode_top_candidates(
        self,
        items: list[CandidateEncodingItem],
        *,
        pricing_context: PricingContext,
        pricing_policy: PricingLoadPolicy,
        trigger_source: str,
        api_key: str | None = None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
        encode_started_at = perf_counter()
        encoded_candidates: list[dict[str, Any]] = []
        scored_candidates: list[dict[str, Any]] = []
        candidate_timings: list[dict[str, Any]] = []
        candidate_hydration_ms = 0.0
        candidate_hydration_max_ms = 0.0
        # Show mode gates app ACCESS only — it never forces live pricing refresh.
        card_show_mode_active = False
        limited_items = items[:pricing_policy.limit]
        _, price_snapshot_rows = self._batched_card_hydration_context(
            [str((item.card or {}).get("id") or "").strip() for item in limited_items]
        )

        for index, item in enumerate(limited_items, start=1):
            pricing_rule = pricing_policy.rule_for_rank(index)
            candidate_started_at = perf_counter()
            candidate_timing: dict[str, float] = {}
            card_id = str((item.card or {}).get("id") or "").strip()
            candidate_payload = self._candidate_payload(
                item.card,
                pricing_context=pricing_context,
                trigger_source=trigger_source,
                ensure_cached=pricing_rule.ensure_cached,
                api_key=api_key,
                refresh_pricing_if_stale=pricing_rule.refresh_stale,
                refresh_pricing_if_missing=pricing_rule.refresh_missing,
                force_show_mode_refresh=pricing_rule.force_show_mode_refresh,
                card_show_mode_active=card_show_mode_active,
                snapshot_row=price_snapshot_rows.get(card_id),
                timing_output=candidate_timing,
            )
            candidate_payload_ms = float(candidate_timing.get("candidatePayloadMs") or (perf_counter() - candidate_started_at) * 1000.0)
            candidate_hydration_ms += candidate_payload_ms
            candidate_hydration_max_ms = max(candidate_hydration_max_ms, candidate_payload_ms)
            scored_entry = {
                "card": item.card,
                "candidate": candidate_payload,
                "finalScore": round(item.final_score, 4),
                "reasons": list(item.reasons),
            }
            if item.scored_fields:
                scored_entry.update(item.scored_fields)
            scored_candidates.append(scored_entry)
            encoded_candidates.append(
                {
                    "rank": index,
                    "candidate": candidate_payload,
                    "imageScore": round(item.image_score, 4),
                    "collectorNumberScore": round(item.collector_number_score, 4),
                    "nameScore": round(item.name_score, 4),
                    "finalScore": round(item.final_score, 4),
                }
            )
            candidate_timings.append(
                {
                    "rank": index,
                    "candidateID": str(candidate_payload.get("id") or ""),
                    "ensureCached": pricing_rule.ensure_cached,
                    "refreshStale": pricing_rule.refresh_stale,
                    "refreshMissing": pricing_rule.refresh_missing,
                    "forceShowModeRefresh": pricing_rule.force_show_mode_refresh,
                    "ensureCachedMs": candidate_timing.get("ensureCachedMs"),
                    "pricingLookupMs": candidate_timing.get("pricingLookupMs"),
                    "pricingRefreshMs": candidate_timing.get("pricingRefreshMs"),
                    "candidateBuildMs": candidate_timing.get("candidateBuildMs"),
                    "candidatePayloadMs": candidate_timing.get("candidatePayloadMs"),
                    "totalMs": round((perf_counter() - candidate_started_at) * 1000.0, 3),
                }
            )

        return (
            encoded_candidates,
            scored_candidates,
            {
                "candidateEncodeMs": round((perf_counter() - encode_started_at) * 1000.0, 3),
                "candidateHydrationMs": round(candidate_hydration_ms, 3),
                "candidateHydrationMaxMs": round(candidate_hydration_max_ms, 3),
                "candidateHydrationCount": len(candidate_timings),
                "encodedCandidateCount": len(encoded_candidates),
                "candidateTimings": candidate_timings,
            },
        )

    @staticmethod
    def _unsupported_match_response(
        payload: dict[str, Any],
        *,
        resolver_mode: str,
        resolver_path: str,
        review_reason: str,
        ambiguity_flags: list[str],
        slab_context: dict[str, Any] | None = None,
        raw_decision_debug: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = {
            "scanID": payload["scanID"],
            "topCandidates": [],
            "confidence": "low",
            "ambiguityFlags": ambiguity_flags,
            "matcherSource": "remoteHybrid",
            "matcherVersion": MATCHER_VERSION,
            "resolverMode": resolver_mode,
            "resolverPath": resolver_path,
            "slabContext": slab_context,
            "reviewDisposition": "unsupported",
            "reviewReason": review_reason,
        }
        if raw_decision_debug is not None:
            response["rawDecisionDebug"] = raw_decision_debug
        return response

    def _build_raw_match_response(
        self,
        payload: dict[str, Any],
        decision: RawDecisionResult,
        *,
        api_key: str | None = None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        response_build_started_at = perf_counter()
        top_matches = list(decision.top_candidates)
        if not top_matches:
            response = self._unsupported_match_response(
                payload,
                resolver_mode="raw_card",
                resolver_path=decision.resolver_path,
                review_reason=decision.review_reason or "Could not identify a raw card match.",
                ambiguity_flags=list(decision.ambiguity_flags),
                raw_decision_debug=decision.debug_payload,
            )
            response["confidence"] = decision.confidence
            response["reviewDisposition"] = decision.review_disposition
            response["ambiguityDebug"] = decision.debug_payload.get("ambiguity")
            self._record_backend_timing(
                response,
                responseAssemblyMs=(perf_counter() - response_build_started_at) * 1000.0,
                responseBuildMs=(perf_counter() - response_build_started_at) * 1000.0,
            )
            return response, []

        pricing_policy = self._scan_candidate_pricing_policy(
            refresh_top_candidate_stale=True,
            refresh_top_candidate_missing=True,
            force_show_mode_top_candidate_refresh=True,
        )
        encoded_candidates, scored_candidates, encode_debug = self._encode_top_candidates(
            [
                CandidateEncodingItem(
                    card=match.card,
                    image_score=match.retrieval_score / 100.0,
                    collector_number_score=match.resolution_score / 100.0,
                    name_score=round(match.breakdown.title_overlap_score / 35.0, 4) if match.breakdown.title_overlap_score else 0.0,
                    final_score=match.final_total / 100.0,
                    reasons=match.reasons,
                    scored_fields={
                        "retrievalScore": round(match.retrieval_score / 100.0, 4),
                        "rerankScore": round(match.resolution_score / 100.0, 4),
                    },
                )
                for match in top_matches
            ],
            pricing_context=self._raw_pricing_context(),
            pricing_policy=pricing_policy,
            trigger_source="scan_match_raw",
            api_key=api_key,
        )

        response = {
            "scanID": payload["scanID"],
            "topCandidates": encoded_candidates,
            "confidence": decision.confidence,
            "ambiguityFlags": list(decision.ambiguity_flags),
            "ambiguityDebug": decision.debug_payload.get("ambiguity"),
            "matcherSource": "remoteHybrid",
            "matcherVersion": MATCHER_VERSION,
            "resolverMode": "raw_card",
            "resolverPath": decision.resolver_path,
            "slabContext": None,
            "reviewDisposition": decision.review_disposition,
            "reviewReason": decision.review_reason,
            "rawDecisionDebug": decision.debug_payload,
        }
        response_assembly_ms = (perf_counter() - response_build_started_at) * 1000.0
        self._record_backend_timing(
            response,
            candidateEncodeMs=encode_debug.get("candidateEncodeMs"),
            candidateHydrationMs=encode_debug.get("candidateHydrationMs"),
            candidateHydrationMaxMs=encode_debug.get("candidateHydrationMaxMs"),
            candidateHydrationCount=encode_debug.get("candidateHydrationCount"),
            encodedCandidateCount=encode_debug.get("encodedCandidateCount"),
            candidateTimings=encode_debug.get("candidateTimings"),
            responseAssemblyMs=response_assembly_ms,
            responseBuildMs=response_assembly_ms,
        )
        return response, scored_candidates

    def _visual_candidate_stub(self, entry: dict[str, Any]) -> dict[str, Any]:
        provider_card_id = str(entry.get("providerCardId") or "").strip()
        cached_card = self._cached_card_by_id(provider_card_id)
        image_url = entry.get("imageUrl")
        title_aliases = list(
            dict.fromkeys(
                [
                    *self._entry_title_aliases(entry),
                    *(((cached_card or {}).get("titleAliases")) or []),
                ]
            )
        )
        if cached_card is not None:
            return {
                "id": provider_card_id or str(cached_card.get("id") or ""),
                "name": str(cached_card.get("name") or entry.get("name") or ""),
                "setName": str(cached_card.get("setName") or entry.get("setName") or ""),
                "number": str(cached_card.get("number") or entry.get("collectorNumber") or ""),
                "rarity": str(cached_card.get("rarity") or "Unknown"),
                "variant": str(cached_card.get("variant") or "Raw"),
                "language": str(cached_card.get("language") or entry.get("language") or "Unknown"),
                "imageSmallURL": cached_card.get("imageSmallURL") or image_url,
                "imageURL": cached_card.get("imageURL") or image_url,
                "sourceProvider": str(cached_card.get("sourceProvider") or entry.get("sourceProvider") or "scrydex"),
                "sourceRecordID": str(
                    cached_card.get("sourceRecordID")
                    or entry.get("sourceRecordID")
                    or provider_card_id
                    or ""
                ),
                "setID": cached_card.get("setID") or entry.get("setId"),
                "setSeries": cached_card.get("setSeries") or entry.get("setSeries"),
                "setPtcgoCode": cached_card.get("setPtcgoCode") or entry.get("setPtcgoCode"),
                "sourcePayload": cached_card.get("sourcePayload") or entry.get("sourcePayload") or {},
                "titleAliases": title_aliases,
            }
        return {
            "id": provider_card_id,
            "name": str(entry.get("name") or ""),
            "setName": str(entry.get("setName") or ""),
            "number": str(entry.get("collectorNumber") or ""),
            "rarity": "Unknown",
            "variant": "Raw",
            "language": str(entry.get("language") or "Unknown"),
            "imageSmallURL": image_url,
            "imageURL": image_url,
            "sourceProvider": str(entry.get("sourceProvider") or "scrydex"),
            "sourceRecordID": str(entry.get("sourceRecordID") or entry.get("providerCardId") or ""),
            "setID": entry.get("setId"),
            "setSeries": entry.get("setSeries"),
            "setPtcgoCode": entry.get("setPtcgoCode"),
            "sourcePayload": entry.get("sourcePayload") or {},
            "titleAliases": title_aliases,
        }

    @staticmethod
    def _visual_match_summary(match: Any) -> dict[str, Any]:
        return {
            "providerCardId": str(match.entry.get("providerCardId") or ""),
            "sourceProvider": str(match.entry.get("sourceProvider") or "scrydex"),
            "name": str(match.entry.get("name") or ""),
            "collectorNumber": str(match.entry.get("collectorNumber") or ""),
            "setId": match.entry.get("setId"),
            "setName": match.entry.get("setName"),
            "setSeries": match.entry.get("setSeries"),
            "setPtcgoCode": match.entry.get("setPtcgoCode"),
            "language": match.entry.get("language"),
            "imageUrl": match.entry.get("imageUrl"),
            "similarity": round(match.similarity, 6),
            "rowIndex": match.row_index,
        }

    @staticmethod
    def _visual_confidence(
        matches: list[dict[str, Any]],
    ) -> tuple[str, list[str], dict[str, Any]]:
        if not matches:
            detail = {"top1": 0.0, "top2": 0.0, "margin": 0.0}
            return "low", ["No visual candidates were available."], detail
        top1 = float(matches[0].get("similarity") or 0.0)
        top2 = float(matches[1].get("similarity") or 0.0) if len(matches) > 1 else 0.0
        margin = top1 - top2
        # Numeric detail mirrors the categorical thresholds below; surfaced so the
        # client (and the Phase-2 collector tiebreak) can reason about "how close"
        # without re-deriving it. Scores here are post-rerank (matches are the final
        # ranked summaries), so the margin reflects any user-photo boost.
        detail = {
            "top1": round(top1, 6),
            "top2": round(top2, 6),
            "margin": round(margin, 6),
        }
        if top1 >= 0.85 and margin >= 0.05:
            return "high", [], detail
        if top1 >= 0.72 and margin >= 0.02:
            return "medium", [], detail
        flags = ["Visual match is ambiguous; review recommended."]
        if margin < 0.02:
            flags.append("Top visual candidates are very close.")
        return "low", flags, detail

    def _resolve_raw_candidates_visual_only(
        self,
        payload: dict[str, Any],
        *,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        try:
            matches, debug, visual_match_ms, other_language_matches = self._run_raw_visual_phase(
                payload, requested_top_k=SCAN_CANDIDATE_POOL_SIZE
            )
        except Exception as exc:
            response = self._unsupported_match_response(
                payload,
                resolver_mode="raw_card",
                resolver_path="visual_only_unavailable",
                review_reason="Visual-only resolver could not run.",
                ambiguity_flags=[f"Visual-only resolver unavailable: {exc}"],
                raw_decision_debug={"visualOnly": {"error": str(exc)}},
            )
            response["matcherSource"] = "visualIndex"
            self._finalize_scan_response(payload, response, [])
            return response
        response, scored_candidates, _, _ = self._build_raw_visual_only_response(
            payload,
            matches=matches,
            debug=debug,
            visual_match_ms=visual_match_ms,
            api_key=api_key,
            is_provisional=False,
            other_language_matches=other_language_matches,
        )
        return response

    def _resolve_raw_candidates_visual_hybrid_from_matches(
        self,
        payload: dict[str, Any],
        *,
        matches: list[Any],
        debug: dict[str, Any],
        requested_top_k: int,
        api_key: str | None = None,
        visual_match_ms: float | None = None,
        visual_phase_source: str = "live",
    ) -> dict[str, Any]:
        evidence_started_at = perf_counter()
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        evidence_ms = (perf_counter() - evidence_started_at) * 1000.0

        visual_matches = [self._visual_match_summary(match) for match in matches]
        self._prime_card_lookup_cache(
            [
                entry.get("providerCardId")
                for match in matches
                for entry in [getattr(match, "entry", None)]
                if isinstance(entry, dict)
            ]
        )
        badge_image_scores: dict[str, dict[str, Any]] = {}
        badge_match_error: str | None = None
        badge_match_ms = 0.0
        active_visual_model_id = getattr(
            getattr(self, "_raw_visual_matcher", None), "model_id", ""
        ) or ""
        visual_candidates = [
            {
                **self._visual_candidate_stub(match.entry),
                "_visualSimilarity": float(summary.get("similarity") or 0.0),
                "_visualSimilaritySource": visual_phase_source,
                "_retrievalScoreHint": round(
                    _calibrate_visual_similarity(
                        float(summary.get("similarity") or 0.0), active_visual_model_id
                    )
                    * 100.0,
                    4,
                ),
                "_cachePresence": False,
                "_retrievalRoutes": [visual_phase_source],
            }
            for match, summary in zip(matches, visual_matches, strict=True)
        ]
        expand_visual_pool = self._should_expand_visual_hybrid_pool(payload, evidence)
        used_local_ocr_rescue = expand_visual_pool and self._has_meaningful_local_ocr_rescue_signal(evidence)
        local_ocr_candidates: list[dict[str, Any]] = []
        local_ocr_rescue_ms = 0.0
        candidate_merge_ms = 0.0
        if used_local_ocr_rescue:
            local_ocr_rescue_started_at = perf_counter()
            local_ocr_candidates = self._search_local_visual_manifest_ocr_candidates(
                evidence,
                signals,
                limit=24,
            )
            local_ocr_rescue_ms = (perf_counter() - local_ocr_rescue_started_at) * 1000.0
            if local_ocr_candidates:
                merge_started_at = perf_counter()
                visual_candidates = merge_raw_candidate_pools([visual_candidates, local_ocr_candidates])
                candidate_merge_ms = (perf_counter() - merge_started_at) * 1000.0

        decision_started_at = perf_counter()
        ranked_matches, weights = rank_visual_hybrid_candidates(visual_candidates, evidence, signals)
        decision_rank_ms = (perf_counter() - decision_started_at) * 1000.0
        finalize_started_at = perf_counter()
        decision = finalize_raw_decision(ranked_matches, evidence, signals)
        if self._should_fail_closed_for_retake(payload, evidence, signals, decision):
            decision = RawDecisionResult(
                matches=tuple(),
                top_candidates=tuple(),
                confidence="low",
                confidence_percent=decision.confidence_percent,
                ambiguity_flags=tuple(
                    dict.fromkeys(
                        [
                            *decision.ambiguity_flags,
                            "Scan did not capture enough full-card detail",
                        ]
                    )
                ),
                resolver_path=decision.resolver_path,
                review_disposition="unsupported",
                review_reason="Try again with the card centered and filling more of the reticle.",
                fallback_reason=decision.fallback_reason or "retake_low_quality_fallback",
                selected_card_id=None,
                debug_payload=decision.debug_payload,
            )
        decision_finalize_ms = (perf_counter() - finalize_started_at) * 1000.0
        rerank_decision_ms = decision_rank_ms + decision_finalize_ms
        top_matches_debug = [
            {
                "id": match.card.get("id"),
                "name": match.card.get("name"),
                "number": match.card.get("number"),
                "visualScore": round(match.retrieval_score, 4),
                "ocrScore": round(match.resolution_score, 4),
                "finalScore": round(match.final_total, 4),
                "reasons": list(match.reasons),
                "breakdown": {
                    "titleOverlap": match.breakdown.title_overlap_score,
                    "setOverlap": match.breakdown.set_overlap_score,
                    "setBadgeImage": match.breakdown.set_badge_image_score,
                    "collectorExact": match.breakdown.collector_exact_score,
                    "collectorPartial": match.breakdown.collector_partial_score,
                    "collectorDenominator": match.breakdown.collector_denominator_score,
                    "footerSupport": match.breakdown.footer_text_support_score,
                    "promoSupport": match.breakdown.promo_support_score,
                    "contradictionPenalty": match.breakdown.contradiction_penalty,
                },
            }
            for match in ranked_matches[:10]
        ]
        debug_payload = {
            "evidence": {
                "titleTextPrimary": evidence.title_text_primary,
                "titleTextSecondary": evidence.title_text_secondary,
                "footerBandText": evidence.footer_band_text,
                "collectorNumberExact": evidence.collector_number_exact,
                "collectorNumberPartial": evidence.collector_number_partial,
                "setHintTokens": list(evidence.set_hint_tokens),
                "trustedSetHintTokens": list(evidence.trusted_set_hint_tokens),
                "promoCodeHint": evidence.promo_code_hint,
                "cropConfidence": evidence.crop_confidence,
                "setBadgeHintKind": evidence.set_badge_hint_kind,
                "setBadgeHintSource": evidence.set_badge_hint_source,
                "setBadgeHintRawValue": evidence.set_badge_hint_raw_value,
            },
            "signals": {
                "title": signals.title_signal,
                "collector": signals.collector_signal,
                "set": signals.set_signal,
                "footer": signals.footer_signal,
                "overall": signals.overall_signal,
            },
            "visualHybrid": {
                **debug,
                "candidateCount": len(visual_matches),
                "requestedTopK": requested_top_k,
                "retrievalStrategy": "fallback_local_rescue" if used_local_ocr_rescue else "standard_visual_hybrid",
                "visualPhaseSource": visual_phase_source,
                "localOCRRescueEligible": expand_visual_pool,
                "localOCRRescueUsed": used_local_ocr_rescue,
                "localOCRRescueSkippedReason": "weak_ocr_signal" if expand_visual_pool and not used_local_ocr_rescue else None,
                "localOCRCandidateCount": len(local_ocr_candidates),
                "localOCRCandidates": [
                    {
                        "id": str(candidate.get("id") or ""),
                        "name": str(candidate.get("name") or ""),
                        "number": str(candidate.get("number") or ""),
                        "pseudoSimilarity": round(float(candidate.get("_visualSimilarity") or 0.0), 4),
                        "retrievalScoreHint": round(float(candidate.get("_retrievalScoreHint") or 0.0), 4),
                    }
                    for candidate in local_ocr_candidates[:10]
                ],
                "visualWeight": weights["visualWeight"],
                "ocrWeight": weights["ocrWeight"],
                "setBadgeImageError": badge_match_error,
                "setBadgeImageScores": badge_image_scores,
                "topVisualCandidates": visual_matches[:10],
                "phaseTimings": {
                    "buildRawEvidenceMs": round(evidence_ms, 3),
                    "visualMatchMs": round(float(visual_match_ms or 0.0), 3),
                    "localOCRRescueMs": round(local_ocr_rescue_ms, 3),
                    "candidateMergeMs": round(candidate_merge_ms, 3),
                    "decisionRankMs": round(decision_rank_ms, 3),
                    "decisionFinalizeMs": round(decision_finalize_ms, 3),
                    "badgeMatchMs": round(badge_match_ms, 3),
                    "rerankDecisionMs": round(rerank_decision_ms, 3),
                },
            },
            "topMatches": top_matches_debug,
            "ambiguity": None,
            "decision": {
                "confidence": decision.confidence,
                "confidencePercent": decision.confidence_percent,
                "ambiguityFlags": list(decision.ambiguity_flags),
                "reviewDisposition": decision.review_disposition,
                "fallbackReason": decision.fallback_reason,
                "selectedCardID": decision.selected_card_id,
            },
        }
        decision = RawDecisionResult(
            matches=decision.matches,
            top_candidates=decision.top_candidates,
            confidence=decision.confidence,
            confidence_percent=decision.confidence_percent,
            ambiguity_flags=decision.ambiguity_flags,
            resolver_path="visual_hybrid_index",
            review_disposition=decision.review_disposition,
            review_reason=decision.review_reason,
            fallback_reason=decision.fallback_reason,
            selected_card_id=decision.selected_card_id,
            debug_payload=debug_payload,
        )
        response, top_candidates = self._build_raw_match_response(payload, decision, api_key=api_key)
        self._record_backend_timing(
            response,
            visualMatchMs=round(float(visual_match_ms), 3) if visual_match_ms is not None else None,
            **self._visual_matcher_timing_fields(debug),
        )
        self._finalize_scan_response(payload, response, top_candidates)
        return response

    def _resolve_raw_candidates_visual_hybrid(
        self,
        payload: dict[str, Any],
        *,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        evidence_started_at = perf_counter()
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        evidence_ms = (perf_counter() - evidence_started_at) * 1000.0

        requested_top_k = self._visual_hybrid_top_k(payload, evidence)
        visual_match_started_at = perf_counter()
        try:
            matches, debug = self._raw_visual_matcher_instance().match_payload(payload, top_k=requested_top_k)
        except Exception as exc:
            response = self._unsupported_match_response(
                payload,
                resolver_mode="raw_card",
                resolver_path="visual_hybrid_unavailable",
                review_reason="Visual+OCR resolver could not run.",
                ambiguity_flags=[f"Visual+OCR resolver unavailable: {exc}"],
                raw_decision_debug={"visualHybrid": {"error": str(exc)}},
            )
            response["matcherSource"] = "visualIndex"
            self._finalize_scan_response(payload, response, [])
            return response
        visual_match_ms = (perf_counter() - visual_match_started_at) * 1000.0
        return self._resolve_raw_candidates_visual_hybrid_from_matches(
            payload,
            matches=list(matches),
            debug=dict(debug or {}),
            requested_top_k=requested_top_k,
            api_key=api_key,
            visual_match_ms=visual_match_ms,
            visual_phase_source="live",
        )

    def visual_match_scan(
        self,
        payload: dict[str, Any],
        *,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        handler_started_at = perf_counter()
        self._emit_structured_log(self._scan_request_log_payload(payload))
        scrydex_before_total = int(scrydex_request_stats_snapshot().get("total") or 0)
        scan_id = str(payload.get("scanID") or "")
        match_started = perf_counter()
        pre_visual_setup_ms = (match_started - handler_started_at) * 1000.0
        try:
            matches, debug, visual_match_ms, other_language_matches = self._run_raw_visual_phase(
                payload, requested_top_k=SCAN_CANDIDATE_POOL_SIZE
            )
        except Exception as exc:
            response = self._unsupported_match_response(
                payload,
                resolver_mode="raw_card",
                resolver_path="visual_only_unavailable",
                review_reason="Visual-only resolver could not run.",
                ambiguity_flags=[f"Visual-only resolver unavailable: {exc}"],
                raw_decision_debug={"visualOnly": {"error": str(exc)}},
            )
            response["matcherSource"] = "visualIndex"
            response["isProvisional"] = True
            response["matchingStage"] = "visual"
            self._finalize_scan_response(payload, response, [])
            self._log_scrydex_match_usage(
                scan_id,
                before_total=scrydex_before_total,
                started_at=match_started,
                response=response,
            )
            return response

        build_response_started_at = perf_counter()
        response, scored_candidates, _, storage_candidates = self._build_raw_visual_only_response(
            payload,
            matches=matches,
            debug=debug,
            visual_match_ms=visual_match_ms,
            api_key=api_key,
            is_provisional=True,
            finalize_response=False,
            other_language_matches=other_language_matches,
        )
        build_response_total_ms = (perf_counter() - build_response_started_at) * 1000.0
        store_pending_started_at = perf_counter()
        self._store_pending_visual_scan(
            scan_id=scan_id,
            visual_matches=matches,
            visual_debug=debug,
            requested_top_k=SCAN_CANDIDATE_POOL_SIZE,
            visual_match_ms=visual_match_ms,
        )
        store_pending_ms = (perf_counter() - store_pending_started_at) * 1000.0
        self._finalize_scan_response(
            payload,
            response,
            scored_candidates,
            prediction_candidates=storage_candidates,
        )
        self._record_backend_timing(
            response,
            preVisualSetupMs=pre_visual_setup_ms,
            buildResponseTotalMs=build_response_total_ms,
            storePendingVisualScanMs=store_pending_ms,
        )
        self._log_scrydex_match_usage(
            scan_id,
            before_total=scrydex_before_total,
            started_at=match_started,
            response=response,
        )
        return response

    def rerank_visual_match(
        self,
        payload: dict[str, Any],
        *,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        self._emit_structured_log(self._scan_request_log_payload(payload))
        scrydex_before_total = int(scrydex_request_stats_snapshot().get("total") or 0)
        scan_id = str(payload.get("scanID") or "")
        owner_user_id = self._current_owner_user_id()
        match_started = perf_counter()
        cache_lookup_started_at = perf_counter()
        pending = self._take_pending_visual_scan(scan_id, owner_user_id=owner_user_id)
        cache_lookup_ms = (perf_counter() - cache_lookup_started_at) * 1000.0
        if pending is None:
            image_payload = payload.get("image") if isinstance(payload.get("image"), dict) else {}
            image_bytes = str(image_payload.get("jpegBase64") or "").strip()
            if not image_bytes:
                raise ValueError("Cached visual shortlist expired; full rerank retry requires image.jpegBase64")
            return self.match_scan(payload)
        cache_clear_ms = 0.0

        try:
            resolve_started_at = perf_counter()
            response = self._resolve_raw_candidates_visual_hybrid_from_matches(
                payload,
                matches=list(pending.visual_matches),
                debug=dict(pending.visual_debug or {}),
                requested_top_k=pending.requested_top_k,
                api_key=api_key,
                visual_match_ms=pending.visual_match_ms,
                visual_phase_source="cached",
            )
            resolve_ms = (perf_counter() - resolve_started_at) * 1000.0
        except Exception as exc:
            response = self._unsupported_match_response(
                payload,
                resolver_mode="raw_card",
                resolver_path="visual_hybrid_unavailable",
                review_reason="Visual+OCR resolver could not run.",
                ambiguity_flags=[f"Visual+OCR resolver unavailable: {exc}"],
                raw_decision_debug={"visualHybrid": {"error": str(exc)}},
            )
            response["matcherSource"] = "visualIndex"
            self._finalize_scan_response(payload, response, [])
            self._record_backend_timing(
                response,
                cacheLookupMs=cache_lookup_ms,
                cacheClearMs=cache_clear_ms,
                rerankResolveMs=None,
                rerankServiceTotalMs=(perf_counter() - match_started) * 1000.0,
            )
            self._log_scrydex_match_usage(
                scan_id,
                before_total=scrydex_before_total,
                started_at=match_started,
                response=response,
            )
            return response

        response["isProvisional"] = False
        response["matchingStage"] = "reranked"
        self._record_backend_timing(
            response,
            cacheLookupMs=cache_lookup_ms,
            cacheClearMs=cache_clear_ms,
            rerankResolveMs=resolve_ms,
            rerankServiceTotalMs=(perf_counter() - match_started) * 1000.0,
        )
        self._log_scrydex_match_usage(
            scan_id,
            before_total=scrydex_before_total,
            started_at=match_started,
            response=response,
        )
        return response

    def _slab_resolution_log_payload(
        self,
        payload: dict[str, Any],
        evidence: SlabMatchEvidence,
        *,
        local_candidate_count: int,
        remote_candidate_count: int,
        merged_candidate_count: int,
        remote_debug: dict[str, Any],
        ranked_candidates: list[dict[str, Any]],
        confidence: str,
        confidence_percent: float,
        ambiguity_flags: list[str],
        review_disposition: str,
        review_reason: str | None,
        cert_debug: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "severity": "INFO",
            "event": "scan_match_slab_resolution",
            "scanID": payload.get("scanID"),
            "resolverModeHint": payload.get("resolverModeHint"),
            "localCandidateCount": local_candidate_count,
            "remoteCandidateCount": remote_candidate_count,
            "mergedCandidateCount": merged_candidate_count,
            "evidence": {
                "titleTextPrimary": evidence.title_text_primary,
                "titleTextSecondary": evidence.title_text_secondary,
                "labelText": evidence.label_text,
                "cardNumber": evidence.card_number,
                "languageHint": evidence.language_hint,
                "setHintTokens": list(evidence.set_hint_tokens),
                "setHintSource": evidence.set_hint_source,
                "matchedSetAlias": evidence.matched_set_alias,
                "variantHints": dict(evidence.variant_hints),
                "grader": evidence.grader,
                "grade": evidence.grade,
                "cert": evidence.cert_number,
                "lookupPath": evidence.recommended_lookup_path,
            },
            "certResolution": cert_debug or {},
            "remote": remote_debug,
            "topMatches": [
                {
                    "id": candidate.get("id"),
                    "name": candidate.get("name"),
                    "number": candidate.get("number"),
                    "score": round(float(candidate.get("_retrievalScoreHint") or 0.0), 4),
                    "reasons": list(candidate.get("_reasons") or []),
                }
                for candidate in ranked_candidates[:10]
            ],
            "decision": {
                "confidence": confidence,
                "confidencePercent": confidence_percent,
                "ambiguityFlags": ambiguity_flags,
                "reviewDisposition": review_disposition,
                "reviewReason": review_reason,
            },
        }

    def _build_slab_match_response(
        self,
        payload: dict[str, Any],
        evidence: SlabMatchEvidence,
        ranked_candidates: list[dict[str, Any]],
        *,
        resolver_path: str = "psa_label",
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        response_build_started_at = perf_counter()
        pricing_context = self._slab_pricing_context(
            grader=evidence.grader,
            grade=evidence.grade,
            cert_number=evidence.cert_number,
            variant_hints=evidence.variant_hints,
        )
        slab_context = self._slab_context_payload_for_pricing_context(
            pricing_context,
            include_variant_hints=True,
        )

        if not evidence.grader or not evidence.grade:
            response = self._unsupported_match_response(
                payload,
                resolver_mode="psa_slab",
                resolver_path=resolver_path,
                review_reason="Could not extract a confident slab grader and grade.",
                ambiguity_flags=["Slab OCR is missing a confident grader or grade."],
                slab_context=slab_context,
            )
            self._record_backend_timing(
                response,
                responseBuildMs=(perf_counter() - response_build_started_at) * 1000.0,
            )
            return response, []

        if not ranked_candidates:
            response = self._unsupported_match_response(
                payload,
                resolver_mode="psa_slab",
                resolver_path=resolver_path,
                review_reason="Could not identify the slabbed card from the label OCR.",
                ambiguity_flags=["No slab candidates were available."],
                slab_context=slab_context,
            )
            self._record_backend_timing(
                response,
                responseBuildMs=(perf_counter() - response_build_started_at) * 1000.0,
            )
            return response, []

        top_score = float(ranked_candidates[0].get("_retrievalScoreHint") or 0.0)
        runner_up_score = float(ranked_candidates[1].get("_retrievalScoreHint") or 0.0) if len(ranked_candidates) > 1 else 0.0
        margin = top_score - runner_up_score
        completeness = 0.0
        if evidence.title_text_primary or evidence.title_text_secondary:
            completeness += 35.0
        if evidence.card_number:
            completeness += 20.0
        if evidence.set_hint_tokens:
            completeness += 10.0
        if evidence.grader:
            completeness += 20.0
        if evidence.grade:
            completeness += 15.0
        if evidence.cert_number:
            completeness += 10.0
        confidence_percent = round(min(100.0, (top_score * 0.70) + (completeness * 0.30)), 2)
        ambiguity_flags: list[str] = []
        if len(ranked_candidates) > 1 and margin < 10.0:
            ambiguity_flags.append("Top slab matches are close together")
        if not evidence.card_number:
            ambiguity_flags.append("Slab card number OCR is weak")
        if not evidence.set_hint_tokens:
            ambiguity_flags.append("Slab set hints are weak")

        if top_score >= 72.0 and margin >= 12.0:
            confidence = "high"
        elif top_score >= 52.0 and margin >= 6.0:
            confidence = "medium"
        else:
            confidence = "low"

        review_disposition = "ready" if confidence != "low" else "needs_review"
        # Skip live pricing refresh inline — card detail fetches fresh pricing on open.
        # Inline Scrydex pricing calls were causing 10s+ timeouts on slab scans.
        pricing_policy = self._scan_candidate_pricing_policy(
            refresh_top_candidate_stale=False,
            refresh_top_candidate_missing=False,
            force_show_mode_top_candidate_refresh=False,
        )
        encoded_candidates, scored_candidates, encode_debug = self._encode_top_candidates(
            [
                CandidateEncodingItem(
                    card=candidate,
                    image_score=round(float(candidate.get("_retrievalScoreHint") or 0.0) / 100.0, 4),
                    collector_number_score=round(float(candidate.get("_retrievalScoreHint") or 0.0) / 100.0, 4),
                    name_score=round(float(candidate.get("_retrievalScoreHint") or 0.0) / 100.0, 4),
                    final_score=round(float(candidate.get("_retrievalScoreHint") or 0.0) / 100.0, 4),
                    reasons=tuple(str(reason) for reason in (candidate.get("_reasons") or [])),
                )
                for candidate in ranked_candidates
            ],
            pricing_context=pricing_context,
            pricing_policy=pricing_policy,
            trigger_source="scan_match_slab",
        )

        if slab_context is not None and encoded_candidates:
            top_pricing = ((encoded_candidates[0].get("candidate") or {}).get("pricing") or {})
            if isinstance(top_pricing, dict):
                variant_name = str(top_pricing.get("variant") or "").strip()
                if variant_name:
                    slab_context["variantName"] = variant_name

        best_pricing = ((encoded_candidates[0].get("candidate") or {}).get("pricing") or {}) if encoded_candidates else {}

        review_reason = None if review_disposition == "ready" else "Review the slab match before relying on the result."
        if not best_pricing:
            ambiguity_flags.append("Exact graded pricing is unavailable for this slab.")
        response = {
            "scanID": payload["scanID"],
            "topCandidates": encoded_candidates,
            "confidence": confidence,
            "ambiguityFlags": list(dict.fromkeys(ambiguity_flags)),
            "matcherSource": "remoteHybrid",
            "matcherVersion": MATCHER_VERSION,
            "resolverMode": "psa_slab",
            "resolverPath": resolver_path,
            "slabContext": slab_context,
            "reviewDisposition": review_disposition,
            "reviewReason": review_reason,
        }
        self._record_backend_timing(
            response,
            candidateEncodeMs=encode_debug.get("candidateEncodeMs"),
            encodedCandidateCount=encode_debug.get("encodedCandidateCount"),
            candidateTimings=encode_debug.get("candidateTimings"),
            responseBuildMs=(perf_counter() - response_build_started_at) * 1000.0,
        )
        return response, scored_candidates

    def _resolve_psa_cert_candidate(
        self,
        payload: dict[str, Any],
        evidence: SlabMatchEvidence,
    ) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        if evidence.grader != "PSA":
            return None, {"attempted": False, "reason": "grader_not_psa"}
        if not evidence.cert_number:
            return None, {"attempted": False, "reason": "missing_cert"}

        barcode_payloads = payload.get("slabBarcodePayloads") or []
        cached_resolution = resolve_psa_cert_from_scan_cache(
            self.connection,
            evidence.cert_number,
            barcode_payloads=barcode_payloads if isinstance(barcode_payloads, list) else [],
        )
        if cached_resolution is None:
            return None, {"attempted": True, "reason": "no_scan_cache_hit"}
        if str(cached_resolution.resolver_path or "").strip() != "psa_cert_barcode":
            return None, {
                "attempted": True,
                "reason": "ocr_cert_scan_cache_hit_requires_barcode",
                "matchedScanID": cached_resolution.matched_scan_id,
                "cardID": cached_resolution.card_id,
                "resolverPath": cached_resolution.resolver_path,
            }

        cached_card = card_by_id(self.connection, cached_resolution.card_id)
        if cached_card is None:
            return None, {
                "attempted": True,
                "reason": "cached_card_missing",
                "matchedScanID": cached_resolution.matched_scan_id,
                "cardID": cached_resolution.card_id,
            }

        candidate = self._slab_candidate_from_card(
            cached_card,
            100.0,
            ["psa_cert_cache_hit", "cert_number_exact"],
            "slab_cert_cache",
        )
        return candidate, {
            "attempted": True,
            "reason": "scan_cache_hit",
            "matchedScanID": cached_resolution.matched_scan_id,
            "cardID": cached_resolution.card_id,
            "resolverPath": cached_resolution.resolver_path,
        }

    def _resolve_slab_candidates(self, payload: dict[str, Any]) -> dict[str, Any]:
        slab_started_at = perf_counter()
        deadline = slab_started_at + SLAB_MATCH_BUDGET_SECONDS
        evidence = self._build_slab_evidence(payload)
        cert_candidate, cert_debug = self._resolve_psa_cert_candidate(payload, evidence)
        if cert_candidate is not None:
            ranked_candidates = [cert_candidate]
            response, top_candidates = self._build_slab_match_response(
                payload,
                evidence,
                ranked_candidates,
                resolver_path=str(cert_debug.get("resolverPath") or "psa_label"),
            )
            remote_debug = {
                "queries": [],
                "attempts": [],
                "resultCount": 0,
                "reason": "psa_cert_scan_cache_hit",
            }
            self._emit_structured_log(
                self._slab_resolution_log_payload(
                    payload,
                    evidence,
                    local_candidate_count=1,
                    remote_candidate_count=0,
                    merged_candidate_count=1,
                    remote_debug=remote_debug,
                    ranked_candidates=ranked_candidates,
                    confidence=str(response.get("confidence") or "low"),
                    confidence_percent=100.0,
                    ambiguity_flags=list(response.get("ambiguityFlags") or []),
                    review_disposition=str(response.get("reviewDisposition") or "needs_review"),
                    review_reason=response.get("reviewReason"),
                    cert_debug=cert_debug,
                )
            )
            self._finalize_scan_response(payload, response, top_candidates)
            return response

        # Why: the cert-mode-skip-OCR policy that originally lived here was
        # too aggressive — it killed legitimate matches like the Chansey
        # `clv-15` find (correct card, correct price) just because the cert
        # cache was cold and remote was gated. With the SQL pre-filter on
        # _local_slab_cards_by_number (language hint + year window), the
        # OCR sweep is narrow enough that wrong-card collisions are rare
        # and the work fits inside the 7s budget on typical inputs.
        if perf_counter() >= deadline:
            return self._slab_no_match_response(
                payload,
                evidence,
                cert_debug=cert_debug,
                resolver_path="psa_label_timeout",
                review_reason="Slab match timed out before local lookup could run.",
                ambiguity_flag="Slab resolution exceeded the fail-fast budget.",
                remote_reason="slab_match_timeout",
            )

        local_candidates = self._retrieve_local_slab_candidates(evidence)
        if perf_counter() >= deadline:
            return self._slab_no_match_response(
                payload,
                evidence,
                cert_debug=cert_debug,
                resolver_path="psa_label_timeout",
                review_reason="Slab match timed out during local lookup.",
                ambiguity_flag="Slab resolution exceeded the fail-fast budget.",
                remote_reason="slab_match_timeout",
                local_candidate_count=len(local_candidates),
            )
        top_local_score = float(local_candidates[0].get("_retrievalScoreHint") or 0.0) if local_candidates else 0.0
        local_delta = (
            top_local_score - float(local_candidates[1].get("_retrievalScoreHint") or 0.0)
            if len(local_candidates) > 1
            else top_local_score
        )
        should_expand_remote = (
            len(local_candidates) < 3
            or top_local_score < 70.0
            or local_delta < 8.0
        )
        remote_candidates, remote_debug = (
            self._retrieve_remote_slab_candidates(evidence)
            if should_expand_remote
            else (
                [],
                {
                    "queries": [],
                    "attempts": [],
                    "resultCount": 0,
                    "reason": "remote_expansion_not_needed",
                },
            )
        )
        if perf_counter() >= deadline:
            return self._slab_no_match_response(
                payload,
                evidence,
                cert_debug=cert_debug,
                resolver_path="psa_label_timeout",
                review_reason="Slab match timed out after remote expansion.",
                ambiguity_flag="Slab resolution exceeded the fail-fast budget.",
                remote_reason="slab_match_timeout",
                local_candidate_count=len(local_candidates),
                remote_candidate_count=len(remote_candidates),
                remote_debug=remote_debug,
            )
        # Honor the language toggle on the graded lane too: local candidates are
        # already SQL-filtered by language, but remote slab candidates are not —
        # filter the merged pool so the slab top-1/candidates always match the
        # selected language.
        merged_candidates = self._filter_candidates_by_scan_language(
            merge_raw_candidate_pools([local_candidates, remote_candidates]),
            self._explicit_scan_language(payload),
        )
        ranked_candidates = sorted(
            merged_candidates,
            key=lambda candidate: (
                -float(candidate.get("_retrievalScoreHint") or 0.0),
                str(candidate.get("name") or ""),
                str(candidate.get("number") or ""),
            ),
        )
        response, top_candidates = self._build_slab_match_response(
            payload,
            evidence,
            ranked_candidates,
            resolver_path="psa_label",
        )
        self._emit_structured_log(
            self._slab_resolution_log_payload(
                payload,
                evidence,
                local_candidate_count=len(local_candidates),
                remote_candidate_count=len(remote_candidates),
                merged_candidate_count=len(merged_candidates),
                remote_debug=remote_debug,
                ranked_candidates=ranked_candidates,
                confidence=str(response.get("confidence") or "low"),
                confidence_percent=0.0 if not ranked_candidates else round(min(100.0, float(ranked_candidates[0].get("_retrievalScoreHint") or 0.0)), 2),
                ambiguity_flags=list(response.get("ambiguityFlags") or []),
                review_disposition=str(response.get("reviewDisposition") or "needs_review"),
                review_reason=response.get("reviewReason"),
                cert_debug=cert_debug,
            )
        )
        self._finalize_scan_response(payload, response, top_candidates)
        return response

    def _slab_no_match_response(
        self,
        payload: dict[str, Any],
        evidence: SlabMatchEvidence,
        *,
        cert_debug: dict[str, Any] | None,
        resolver_path: str,
        review_reason: str,
        ambiguity_flag: str,
        remote_reason: str,
        local_candidate_count: int = 0,
        remote_candidate_count: int = 0,
        remote_debug: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        pricing_context = self._slab_pricing_context(
            grader=evidence.grader,
            grade=evidence.grade,
            cert_number=evidence.cert_number,
            variant_hints=evidence.variant_hints,
        )
        slab_context = self._slab_context_payload_for_pricing_context(
            pricing_context,
            include_variant_hints=True,
        )
        response = self._unsupported_match_response(
            payload,
            resolver_mode="psa_slab",
            resolver_path=resolver_path,
            review_reason=review_reason,
            ambiguity_flags=[ambiguity_flag],
            slab_context=slab_context,
        )
        debug = remote_debug or {
            "queries": [],
            "attempts": [],
            "resultCount": 0,
            "reason": remote_reason,
        }
        self._emit_structured_log(
            self._slab_resolution_log_payload(
                payload,
                evidence,
                local_candidate_count=local_candidate_count,
                remote_candidate_count=remote_candidate_count,
                merged_candidate_count=0,
                remote_debug=debug,
                ranked_candidates=[],
                confidence="low",
                confidence_percent=0.0,
                ambiguity_flags=list(response.get("ambiguityFlags") or []),
                review_disposition=str(response.get("reviewDisposition") or "unsupported"),
                review_reason=response.get("reviewReason"),
                cert_debug=cert_debug,
            )
        )
        self._finalize_scan_response(payload, response, [])
        return response

    def _log_raw_scan_event(
        self,
        payload: dict[str, Any],
        decision: RawDecisionResult,
        response: dict[str, Any],
        top_candidates: list[dict[str, Any]],
    ) -> None:
        self._finalize_scan_response(payload, response, top_candidates)

    def _resolve_raw_candidates(self, payload: dict[str, Any], *, api_key: str | None = None) -> dict[str, Any]:
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        plan = build_raw_retrieval_plan(evidence, signals)

        local_candidates = self._retrieve_local_raw_candidates(evidence, signals, plan)
        top_local_score = float(local_candidates[0].get("_retrievalScoreHint") or 0.0) if local_candidates else 0.0
        local_delta = (
            top_local_score - float(local_candidates[1].get("_retrievalScoreHint") or 0.0)
            if len(local_candidates) > 1
            else top_local_score
        )
        should_expand_remote = plan.should_query_remote and (
            not local_candidates or top_local_score < 70.0 or local_delta < 8.0
        )
        remote_candidates, remote_debug = (
            self._retrieve_remote_raw_candidates(evidence, signals, plan, api_key)
            if should_expand_remote
            else (
                [],
                {
                    "queries": [],
                    "attempts": [],
                    "resultCount": 0,
                    "reason": "remote_expansion_not_needed",
                },
            )
        )

        # The "Scanning for" language toggle is authoritative: filter the merged
        # local+remote pool so a raw EN toggle only ever ranks/selects EN cards
        # and a raw JP toggle only ever ranks/selects JP cards.
        merged_candidates = self._filter_candidates_by_scan_language(
            merge_raw_candidate_pools([local_candidates, remote_candidates]),
            self._explicit_scan_language(payload),
        )
        matches = rank_raw_candidates(merged_candidates, evidence, signals)
        decision = finalize_raw_decision(matches, evidence, signals)
        debug_payload = raw_debug_payload(evidence, signals, plan, matches, decision, remote_debug=remote_debug)
        self._emit_structured_log(
            self._raw_resolution_log_payload(
                payload,
                debug_payload,
                local_candidate_count=len(local_candidates),
                remote_candidate_count=len(remote_candidates),
                merged_candidate_count=len(merged_candidates),
            )
        )
        decision = RawDecisionResult(
            matches=decision.matches,
            top_candidates=decision.top_candidates,
            confidence=decision.confidence,
            confidence_percent=decision.confidence_percent,
            ambiguity_flags=decision.ambiguity_flags,
            resolver_path=decision.resolver_path,
            review_disposition=decision.review_disposition,
            review_reason=decision.review_reason,
            fallback_reason=decision.fallback_reason,
            selected_card_id=decision.selected_card_id,
            debug_payload=debug_payload,
        )

        response, top_candidates = self._build_raw_match_response(payload, decision, api_key=api_key)
        self._log_raw_scan_event(payload, decision, response, top_candidates)
        return response

    def _refresh_card_pricing_for_context(
        self,
        card_id: str,
        *,
        pricing_context: PricingContext,
        api_key: str | None = None,
        force_refresh: bool = False,
    ) -> dict[str, Any] | None:
        # Show mode gates app ACCESS only — never forces live pricing refresh.
        effective_force_refresh = force_refresh
        if pricing_context.is_graded:
            if not pricing_context.grader or not pricing_context.grade:
                return self._card_detail_for_context(card_id, pricing_context=pricing_context)

            existing_pricing = self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context)
            if self._should_use_cached_pricing_snapshot(existing_pricing, force_refresh=effective_force_refresh):
                return self._card_detail_for_context(card_id, pricing_context=pricing_context)

            if not self._live_scrydex_pricing_refresh_allowed():
                return self._card_detail_for_context(card_id, pricing_context=pricing_context)

            existing_card = card_by_id(self.connection, card_id)
            provider_id = str((existing_card or {}).get("sourceProvider") or "scrydex")
            psa_provider = self.pricing_registry.get_provider(provider_id) or self.pricing_registry.get_provider("scrydex")
            if psa_provider is None or not psa_provider.is_ready() or not psa_provider.get_metadata().supports_psa_pricing:
                return self._card_detail_for_context(card_id, pricing_context=pricing_context)

            refresh_kwargs: dict[str, Any] = {}
            if pricing_context.preferred_variant:
                refresh_kwargs["preferred_variant"] = pricing_context.preferred_variant
            if pricing_context.variant_hints:
                refresh_kwargs["variant_hints"] = pricing_context.variant_hints
            psa_provider.refresh_psa_pricing(
                self.connection,
                card_id,
                pricing_context.grader,
                pricing_context.grade,
                **refresh_kwargs,
            )
            return self._card_detail_for_context(card_id, pricing_context=pricing_context)

        existing_card = card_by_id(self.connection, card_id)
        existing_pricing = self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context)
        if self._should_use_cached_pricing_snapshot(existing_pricing, force_refresh=effective_force_refresh):
            return self._card_detail_for_context(card_id, pricing_context=pricing_context)

        if not self._live_scrydex_pricing_refresh_allowed():
            return self._card_detail_for_context(card_id, pricing_context=pricing_context)

        provider_id = str((existing_card or {}).get("sourceProvider") or "scrydex")
        raw_provider = self.pricing_registry.get_provider(provider_id)
        if raw_provider is None or not raw_provider.is_ready() or not raw_provider.get_metadata().supports_raw_pricing:
            return self._card_detail_for_context(card_id, pricing_context=pricing_context)

        raw_provider.refresh_raw_pricing(self.connection, card_id)
        return self._card_detail_for_context(card_id, pricing_context=pricing_context)

    def refresh_card_pricing(
        self,
        card_id: str,
        api_key: str | None = None,
        grader: str | None = None,
        grade: str | None = None,
        cert_number: str | None = None,
        preferred_variant: str | None = None,
        variant_hints: dict[str, Any] | None = None,
        force_refresh: bool = False,
    ) -> dict[str, Any] | None:
        pricing_context = (
            self._slab_pricing_context(
                grader=grader,
                grade=grade,
                cert_number=cert_number,
                preferred_variant=preferred_variant,
                variant_hints=variant_hints,
            )
            if grader or grade
            else self._raw_pricing_context()
        )
        return self._refresh_card_pricing_for_context(
            card_id,
            pricing_context=pricing_context,
            api_key=api_key,
            force_refresh=force_refresh,
        )

    def hydrate_raw_candidate_pricing(
        self,
        card_ids: list[str],
        *,
        api_key: str | None = None,
        max_refresh_count: int = 2,
        force_refresh: bool = False,
        grader: str | None = None,
        grade: str | None = None,
        cert_number: str | None = None,
        preferred_variant: str | None = None,
    ) -> dict[str, Any]:
        pricing_context = (
            self._slab_pricing_context(
                grader=grader,
                grade=grade,
                cert_number=cert_number,
                preferred_variant=preferred_variant,
            )
            if grader or grade
            else self._raw_pricing_context()
        )
        ordered_card_ids = self._normalized_unique_card_ids(card_ids)
        preloaded_cards, price_snapshot_rows = self._batched_card_hydration_context(ordered_card_ids)
        # Cells-first current price: one bulk latest-day cell prefetch for the whole
        # batch so each card detail resolves price from cells (no cold blob read,
        # no per-card cell query). Empty in JSON mode → JSON-blob path unchanged.
        latest_day_cells_by_card_id = self._latest_day_cells_by_card_id(ordered_card_ids)

        refresh_budget = max(0, min(int(max_refresh_count), len(ordered_card_ids)))
        refreshed_count = 0
        hydrated_cards: list[dict[str, Any]] = []
        live_refresh_allowed = self._live_scrydex_pricing_refresh_allowed()

        for card_id in ordered_card_ids:
            detail = self._card_detail_for_context(
                card_id,
                pricing_context=pricing_context,
                card=preloaded_cards.get(card_id),
                snapshot_row=price_snapshot_rows.get(card_id),
                day_cells=latest_day_cells_by_card_id.get(card_id),
            )
            pricing = ((detail or {}).get("card") or {}).get("pricing") if isinstance(detail, dict) else None
            # Show mode gates app ACCESS only — never forces live pricing refresh.
            effective_force_refresh = force_refresh
            needs_refresh = live_refresh_allowed and not self._should_use_cached_pricing_snapshot(
                pricing,
                force_refresh=effective_force_refresh,
            )

            if needs_refresh and refreshed_count < refresh_budget:
                refreshed_count += 1
                try:
                    detail = self._refresh_card_pricing_for_context(
                        card_id,
                        pricing_context=pricing_context,
                        api_key=api_key,
                        force_refresh=effective_force_refresh,
                    )
                except Exception:
                    detail = self._card_detail_for_context(card_id, pricing_context=pricing_context)

            if detail is not None:
                hydrated_cards.append(detail)

        return {
            "cards": hydrated_cards,
            "requestedCount": len(ordered_card_ids),
            "returnedCount": len(hydrated_cards),
            "refreshedCount": refreshed_count,
        }

    def _card_detail_for_context(
        self,
        card_id: str,
        *,
        pricing_context: PricingContext,
        card: dict[str, Any] | None = None,
        snapshot_row: sqlite3.Row | None = None,
        owner_user_id: str | None = None,
        include_social_counts: bool = False,
        day_cells: list[Any] | None = None,
    ) -> dict[str, Any] | None:
        resolved_card = card or card_by_id(self.connection, card_id)
        if resolved_card is None:
            return None
        pricing = self._display_pricing_summary_for_context(
            card_id,
            pricing_context=pricing_context,
            snapshot_row=snapshot_row,
            day_cells=day_cells,
        )
        favorite_row = self._favorite_row(card_id, owner_user_id=owner_user_id)
        like_row = self._like_row(card_id, owner_user_id=owner_user_id)
        resolved_variant = pricing_context.preferred_variant or (str((pricing or {}).get("variant") or "").strip() or None)
        payload: dict[str, Any] = {
            "card": {
                "id": resolved_card["id"],
                "name": resolved_card["name"],
                "setName": resolved_card["setName"],
                "number": resolved_card["number"],
                "rarity": resolved_card["rarity"],
                "variant": resolved_card["variant"],
                "language": resolved_card["language"],
                "imageSmallURL": resolved_card["imageSmallURL"],
                "imageLargeURL": resolved_card["imageURL"],
                "pricing": pricing,
                "isFavorite": favorite_row is not None,
                # Compact per-printing TCGplayer product ids (NOT the full Scrydex
                # blob) so the PDP can deep-link "View on TCGplayer" to the exact
                # printing; None when the card has no TCGplayer product.
                "sourcePayload": tcgplayer_variants_subset(
                    resolved_card.get("sourcePayload"),
                    collision_guard(self.connection)["colliding_product_ids"],
                ),
            },
            "slabContext": self._slab_context_payload_for_pricing_context(
                pricing_context,
                resolved_variant=resolved_variant,
            ),
            "source": resolved_card["sourceProvider"],
            "sourceRecordID": resolved_card["sourceRecordID"],
            "setID": resolved_card["setID"],
            "setSeries": resolved_card["setSeries"],
            "setReleaseDate": resolved_card["setReleaseDate"],
            "supertype": resolved_card["supertype"],
            "artist": resolved_card["artist"],
            "regulationMark": resolved_card["regulationMark"],
            "imageSmallURL": resolved_card["imageSmallURL"],
            "imageLargeURL": resolved_card["imageURL"],
            "isFavorite": favorite_row is not None,
            "favoritedAt": favorite_row["created_at"] if favorite_row is not None else None,
            # The requester's wishlist baseline (null when unfavorited) so the
            # PDP can render "since wishlisted" for cards the viewer does not
            # own. Same serve-time arithmetic as the favorites list serializer.
            "favoriteContext": self._favorite_context_payload(favorite_row, pricing),
            "isLiked": like_row is not None,
            "likedAt": like_row["created_at"] if like_row is not None else None,
            "cardText": card_text_from_card(resolved_card),
            # GemRate population keyed by grader (PSA/BGS/CGC/SGC); {} when unsynced.
            # Drives the PDP's dynamic-by-grader population report.
            "population": self._card_population(card_id),
        }
        if include_social_counts:
            payload["likeCount"] = self._card_like_count(card_id)
            payload["watcherCount"] = self._card_watcher_count(card_id)
            # Card's own language + EN↔JP counterpart for the PDP language toggle.
            # counterpart* are None when the card has no confident link → the
            # client hides the toggle.
            payload["language"] = resolved_card["language"]
            counterpart_row = self._card_counterpart(card_id)
            payload["counterpartCardID"] = (
                counterpart_row["counterpart_card_id"] if counterpart_row is not None else None
            )
            payload["counterpartLanguage"] = (
                counterpart_row["counterpart_language"] if counterpart_row is not None else None
            )
        return payload

    def card_detail(
        self,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
        cert_number: str | None = None,
        preferred_variant: str | None = None,
    ) -> dict[str, Any] | None:
        pricing_context = (
            self._slab_pricing_context(
                grader=grader,
                grade=grade,
                cert_number=cert_number,
                preferred_variant=preferred_variant,
            )
            if grader or grade
            else self._raw_pricing_context()
        )
        owner_user_id = self._optional_owner_user_id()
        # Log the view first so this viewer is reflected in the watcher count.
        self._record_card_view(card_id, owner_user_id=owner_user_id)
        return self._card_detail_for_context(
            card_id,
            pricing_context=pricing_context,
            owner_user_id=owner_user_id,
            include_social_counts=True,
            # Single-card PDP read: the two-query prefetch collapses to two
            # tiny indexed lookups; {} in JSON mode → day_cells=None (JSON path).
            day_cells=self._latest_day_cells_by_card_id([card_id]).get(card_id),
        )

    def set_card_favorite(self, card_id: str, *, is_favorite: bool | None = None) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        normalized_card_id = str(card_id or "").strip()
        if not normalized_card_id:
            raise ValueError("cardID is required")
        if not self._card_exists(normalized_card_id):
            raise FileNotFoundError("card not found")

        existing_row = self._favorite_row(normalized_card_id, owner_user_id=owner_user_id)
        next_is_favorite = (existing_row is None) if is_favorite is None else bool(is_favorite)

        if next_is_favorite:
            if existing_row is None:
                # "Since you added it" baseline: price the card the same way the
                # wishlist list serializer will (owned copies in their owned
                # grade/condition lane, unowned favorites on the default raw
                # lane) so baseline == the marketPrice shown on the favorite day.
                owned = self._owned_deck_summary_by_card_id(
                    owner_user_id, [normalized_card_id]
                ).get(normalized_card_id)
                added_market_price, added_market_date = self._added_baseline_now(
                    normalized_card_id,
                    grader=owned["grader"] if owned else None,
                    grade=owned["grade"] if owned else None,
                    cert_number=owned["cert_number"] if owned else None,
                    variant_name=owned["variant_name"] if owned else None,
                    condition=owned["condition"] if owned else None,
                )
                self.connection.execute(
                    """
                    INSERT INTO card_favorites (
                        owner_user_id,
                        card_id,
                        created_at,
                        added_market_price,
                        added_market_date
                    )
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        owner_user_id,
                        normalized_card_id,
                        utc_now(),
                        added_market_price,
                        added_market_date,
                    ),
                )
                existing_row = self._favorite_row(normalized_card_id, owner_user_id=owner_user_id)
        else:
            self.connection.execute(
                """
                DELETE FROM card_favorites
                WHERE owner_user_id = ?
                  AND card_id = ?
                """,
                (owner_user_id, normalized_card_id),
            )
            existing_row = None

        self.connection.commit()
        return self._favorite_state_payload(normalized_card_id, existing_row)

    def set_card_like(self, card_id: str, *, is_liked: bool | None = None) -> dict[str, Any]:
        """Toggle/set the PDP heart "like" (card_likes) — the public social signal,
        separate from the wishlist (card_favorites). Mirrors set_card_favorite."""
        owner_user_id = self._current_owner_user_id()
        normalized_card_id = str(card_id or "").strip()
        if not normalized_card_id:
            raise ValueError("cardID is required")
        if not self._card_exists(normalized_card_id):
            raise FileNotFoundError("card not found")

        existing_row = self._like_row(normalized_card_id, owner_user_id=owner_user_id)
        next_is_liked = (existing_row is None) if is_liked is None else bool(is_liked)

        if next_is_liked:
            if existing_row is None:
                self.connection.execute(
                    """
                    INSERT INTO card_likes (
                        owner_user_id,
                        card_id,
                        created_at
                    )
                    VALUES (?, ?, ?)
                    """,
                    (owner_user_id, normalized_card_id, utc_now()),
                )
                existing_row = self._like_row(normalized_card_id, owner_user_id=owner_user_id)
        else:
            self.connection.execute(
                """
                DELETE FROM card_likes
                WHERE owner_user_id = ?
                  AND card_id = ?
                """,
                (owner_user_id, normalized_card_id),
            )
            existing_row = None

        self.connection.commit()
        return self._like_state_payload(normalized_card_id, existing_row)

    def card_ebay_comps(
        self,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
        variant: str | None = None,
        limit: int = DEFAULT_EBAY_LISTING_LIMIT,
    ) -> dict[str, Any] | None:
        card = card_by_id(self.connection, card_id)
        if card is None:
            return None
        normalized_grader = str(grader or "").strip().upper() or None
        normalized_grade = str(grade or "").strip() or None
        # Prefer the request-selected printing (the slab_context/variant the user is
        # viewing), fall back to the card's stored variant, so the eBay link is
        # edition-scoped (1st Edition vs Unlimited) when the card has that split.
        selected_variant = str(variant or "").strip() or str(card.get("variant") or "").strip() or None
        try:
            normalized_limit = int(limit)
        except (TypeError, ValueError):
            normalized_limit = DEFAULT_EBAY_LISTING_LIMIT
        normalized_limit = max(1, min(normalized_limit, DEFAULT_EBAY_LISTING_LIMIT))
        if normalized_grader is None and normalized_grade is not None:
            normalized_grader = "PSA"
        return fetch_graded_card_ebay_comps(
            card,
            grader=normalized_grader,
            selected_grade=normalized_grade,
            variant=selected_variant,
            limit=normalized_limit,
        )

    def card_recent_sales(
        self,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
        source: str = "ebay",
        variant: str | None = None,
        limit: int = RECENT_SALES_DEFAULT_LIMIT,
        refresh: bool = False,
    ) -> dict[str, Any] | None:
        card = card_by_id(self.connection, card_id)
        if card is None:
            return None

        normalized_source = str(source or "").strip().lower() or "ebay"
        normalized_grader = str(grader or "").strip().upper() or None
        normalized_grade = str(grade or "").strip().upper() or None
        # Prefer the request-selected printing, fall back to the card's stored
        # variant, so 1st-Edition and Unlimited comps cache under distinct keys
        # once the eBay query is edition-specific. None preserves prior behavior.
        variant_key = str(variant or "").strip() or str(card.get("variant") or "").strip() or None
        try:
            normalized_limit = int(limit)
        except (TypeError, ValueError):
            normalized_limit = RECENT_SALES_DEFAULT_LIMIT
        normalized_limit = max(1, min(normalized_limit, RECENT_SALES_MAX_LIMIT))
        if normalized_grader is None and normalized_grade is not None:
            normalized_grader = "PSA"
        # Any grader+grade (PSA / BGS / CGC) is allowed through to the cached Scrydex
        # listings fetch below — the grader is the Scrydex `company` token itself, so it
        # round-trips with no mapping. We only require both a grader and a grade.
        if normalized_grader is None or normalized_grade is None:
            return _recent_sales_payload(
                None,
                source=normalized_source,
                grader=normalized_grader or "",
                grade=normalized_grade or "",
                unavailable_reason="Recent eBay sales need both a grader and a grade.",
            )

        cached = slab_recent_sales_cache(
            self.connection,
            card_id=card_id,
            grader=normalized_grader,
            grade=normalized_grade,
            source=normalized_source,
            variant_key=variant_key,
            limit=normalized_limit,
        )
        cached_payload = _recent_sales_payload(
            cached,
            source=normalized_source,
            grader=normalized_grader,
            grade=normalized_grade,
            not_loaded=cached is None,
        )
        if not refresh:
            return cached_payload

        age_hours = _recent_sales_age_hours(str(cached.get("fetchedAt") or "").strip() or None) if cached else None
        refresh_after_hours = (
            RECENT_SALES_EMPTY_REFRESH_HOURS
            if cached is not None and str(cached.get("status") or "").strip().lower() == "no_results"
            else RECENT_SALES_FRESHNESS_HOURS
        )
        if cached is not None and age_hours is not None and age_hours < refresh_after_hours:
            return cached_payload

        remote_payload = fetch_scrydex_recent_sales(
            card_id,
            source=normalized_source,
            grader=normalized_grader,
            grade=normalized_grade,
            limit=normalized_limit,
        )
        cached = replace_slab_recent_sales_cache(
            self.connection,
            card_id=card_id,
            grader=normalized_grader,
            grade=normalized_grade,
            source=normalized_source,
            variant_key=variant_key,
            sales=list(remote_payload.get("sales") or []),
            fetched_at=utc_now(),
            source_url=str(remote_payload.get("sourceURL") or "").strip() or None,
            source_payload=dict(remote_payload.get("sourcePayload") or {}),
        )
        self.connection.commit()
        return _recent_sales_payload(
            cached,
            source=normalized_source,
            grader=normalized_grader,
            grade=normalized_grade,
        )

    def match_scan(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._emit_structured_log(self._scan_request_log_payload(payload))
        scrydex_before_total = int(scrydex_request_stats_snapshot().get("total") or 0)
        scan_id = str(payload.get("scanID") or "")
        match_started = perf_counter()
        # Pre-create the scan_events row up-front so the fire-and-forget
        # /api/v1/scan-artifacts call (which races with this match handler)
        # finds a row to attach to. Slab matches take 40-50s on staging; if
        # the row weren't written until _log_scan at the end of the matcher
        # work, the artifact upload would consistently arrive first, fail
        # its scan_events existence check, and the JPEG would never reach
        # GCS. _log_scan still upserts the same row at the end with the real
        # request/response/matcher fields via ON CONFLICT DO UPDATE, so this
        # stub is transparently replaced when the matcher completes. Rows
        # that stay at matcher_source='in_progress' for >5min indicate a
        # crashed or timed-out match — useful incident signal, not noise.
        if scan_id:
            try:
                upsert_scan_event(
                    self.connection,
                    scan_id=scan_id,
                    owner_user_id=self._current_owner_user_id(),
                    request_payload=self._request_payload_for_scan_event(payload),
                    response_payload={},
                    matcher_source="in_progress",
                    matcher_version="in_progress",
                    created_at=utc_now(),
                )
                self.connection.commit()
            except Exception as exc:  # noqa: BLE001 - never block match on stub-row write
                self._emit_structured_log(
                    {
                        "severity": "WARNING",
                        "event": "scan_event_stub_insert_failed",
                        "scanID": scan_id,
                        "error": str(exc),
                    }
                )
        resolver_mode = resolver_mode_for_payload(payload)
        if resolver_mode == "raw_card":
            raw_resolver_strategy = self._raw_resolver_strategy(payload)
            if raw_resolver_strategy == "visual":
                response = self._resolve_raw_candidates_visual_only(payload, api_key=None)
                self._log_scrydex_match_usage(
                    scan_id,
                    before_total=scrydex_before_total,
                    started_at=match_started,
                    response=response,
                )
                return response
            if raw_resolver_strategy == "hybrid":
                response = self._resolve_raw_candidates_visual_hybrid(payload, api_key=None)
                self._log_scrydex_match_usage(
                    scan_id,
                    before_total=scrydex_before_total,
                    started_at=match_started,
                    response=response,
                )
                return response
            response = self._resolve_raw_candidates(payload, api_key=None)
            self._log_scrydex_match_usage(
                scan_id,
                before_total=scrydex_before_total,
                started_at=match_started,
                response=response,
            )
            return response
        if resolver_mode == "psa_slab":
            response = self._resolve_slab_candidates(payload)
            self._log_scrydex_match_usage(
                scan_id,
                before_total=scrydex_before_total,
                started_at=match_started,
                response=response,
            )
            return response

        response = self._unsupported_match_response(
            payload,
            resolver_mode=resolver_mode,
            resolver_path="visual_fallback",
            review_reason="This scan could not be routed to a supported matcher.",
            ambiguity_flags=["Could not determine whether this scan is raw or slab."],
        )
        self._finalize_scan_response(payload, response, [])
        self._log_scrydex_match_usage(
            scan_id,
            before_total=scrydex_before_total,
            started_at=match_started,
            response=response,
        )
        return response

    def log_feedback(self, payload: dict[str, Any]) -> None:
        owner_user_id = self._current_owner_user_id()
        existing_event = self.connection.execute(
            """
            SELECT
                request_json,
                response_json,
                matcher_source,
                matcher_version,
                created_at,
                predicted_card_id,
                selected_card_id,
                selected_rank,
                was_top_prediction,
                selection_source,
                confirmed_card_id,
                confirmation_source,
                deck_entry_id,
                confidence,
                review_disposition,
                resolver_mode,
                resolver_path,
                confirmed_at
            FROM scan_events
            WHERE scan_id = ?
              AND owner_user_id = ?
            LIMIT 1
            """,
            (payload["scanID"], owner_user_id),
        ).fetchone()
        if existing_event is None:
            raise FileNotFoundError("scan event not found")

        request_payload = json.loads(existing_event["request_json"] or "{}") if existing_event else {}
        response_payload = json.loads(existing_event["response_json"] or "{}") if existing_event else {}
        feedback_selected_card_id = payload.get("selectedCardID") or (existing_event["selected_card_id"] if existing_event else None)
        predicted_card_id = (
            str(existing_event["predicted_card_id"] or "").strip()
            if existing_event
            else ""
        ) or self._predicted_card_id(response_payload)
        selected_rank = self._selected_rank_from_feedback(
            payload,
            response_payload,
            selected_card_id=feedback_selected_card_id,
        )
        selection_source = self._selection_source_from_feedback(payload)
        was_top_prediction = payload.get("wasTopPrediction")
        if not isinstance(was_top_prediction, bool):
            if selected_rank is not None:
                was_top_prediction = selected_rank == 1
            elif existing_event is not None:
                was_top_prediction = bool(existing_event["was_top_prediction"] == 1)
            else:
                was_top_prediction = None

        upsert_scan_event(
            self.connection,
            scan_id=payload["scanID"],
            owner_user_id=owner_user_id,
            request_payload=request_payload,
            response_payload=response_payload,
            matcher_source=(response_payload.get("matcherSource") or (existing_event["matcher_source"] if existing_event else None) or "remoteHybrid"),
            matcher_version=(response_payload.get("matcherVersion") or (existing_event["matcher_version"] if existing_event else None) or MATCHER_VERSION),
            created_at=(existing_event["created_at"] if existing_event else payload.get("submittedAt", utc_now())),
            predicted_card_id=predicted_card_id,
            selected_card_id=feedback_selected_card_id,
            selected_rank=selected_rank if selected_rank is not None else (existing_event["selected_rank"] if existing_event else None),
            was_top_prediction=was_top_prediction,
            selection_source=selection_source if selection_source != "unknown" else ((existing_event["selection_source"] if existing_event else None) or "unknown"),
            confirmed_card_id=(existing_event["confirmed_card_id"] if existing_event else None),
            confirmation_source=(existing_event["confirmation_source"] if existing_event else None),
            deck_entry_id=(existing_event["deck_entry_id"] if existing_event else None),
            confidence=(response_payload.get("confidence") or (existing_event["confidence"] if existing_event else None)),
            review_disposition=(response_payload.get("reviewDisposition") or (existing_event["review_disposition"] if existing_event else None)),
            correction_type=payload["correctionType"],
            resolver_mode=(response_payload.get("resolverMode") or (existing_event["resolver_mode"] if existing_event else None)),
            resolver_path=(response_payload.get("resolverPath") or (existing_event["resolver_path"] if existing_event else None)),
            completed_at=payload["submittedAt"],
            confirmed_at=(existing_event["confirmed_at"] if existing_event else None),
        )
        self.connection.commit()

    @staticmethod
    def _request_payload_for_scan_event(request_payload: dict[str, Any]) -> dict[str, Any]:
        persisted_payload = dict(request_payload or {})
        image_payload = persisted_payload.get("image")
        if isinstance(image_payload, dict) and "jpegBase64" in image_payload:
            persisted_image_payload = dict(image_payload)
            persisted_image_payload.pop("jpegBase64", None)
            persisted_payload["image"] = persisted_image_payload
        return persisted_payload

    @staticmethod
    def _predicted_card_id(response_payload: dict[str, Any]) -> str | None:
        top_candidates = response_payload.get("topCandidates") or []
        if isinstance(top_candidates, list) and top_candidates:
            top_candidate = top_candidates[0] or {}
            candidate_id = str(top_candidate.get("id") or "").strip()
            if candidate_id:
                return candidate_id
        return None

    @staticmethod
    def _selection_source_from_feedback(payload: dict[str, Any]) -> str:
        explicit_value = str(payload.get("selectionSource") or "").strip().lower()
        if explicit_value in {"top", "alternate", "manual_search", "abandoned", "unknown"}:
            return explicit_value

        correction_type = str(payload.get("correctionType") or "").strip()
        if correction_type == "acceptedTop":
            return "top"
        if correction_type == "choseAlternative":
            return "alternate"
        if correction_type == "manualSearch":
            return "manual_search"
        if correction_type == "abandoned":
            return "abandoned"
        return "unknown"

    @staticmethod
    def _selected_rank_from_feedback(
        payload: dict[str, Any],
        response_payload: dict[str, Any],
        *,
        selected_card_id: str | None,
    ) -> int | None:
        explicit_rank = payload.get("selectedRank")
        if isinstance(explicit_rank, int) and explicit_rank >= 1:
            return explicit_rank
        if isinstance(explicit_rank, str) and explicit_rank.strip().isdigit():
            return int(explicit_rank.strip())

        normalized_selected_card_id = str(selected_card_id or "").strip()
        top_candidates = response_payload.get("topCandidates") or []
        if normalized_selected_card_id and isinstance(top_candidates, list):
            for index, candidate in enumerate(top_candidates, start=1):
                if str((candidate or {}).get("id") or "").strip() == normalized_selected_card_id:
                    return index

        was_top_prediction = payload.get("wasTopPrediction")
        if was_top_prediction is True and normalized_selected_card_id:
            return 1
        return None

    @staticmethod
    def _selected_card_summary(card: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": card.get("id"),
            "name": card.get("name"),
            "setName": card.get("setName"),
            "number": card.get("number"),
            "imageURL": card.get("imageURL"),
            "imageSmallURL": card.get("imageSmallURL"),
        }

    @staticmethod
    def _json_object_payload(payload: dict[str, Any], field_name: str) -> dict[str, Any]:
        value = payload.get(field_name)
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError(f"{field_name} must be an object")
        return value

    @staticmethod
    def _json_load_object(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        try:
            decoded = json.loads(str(value or "{}"))
        except json.JSONDecodeError:
            return {}
        return decoded if isinstance(decoded, dict) else {}

    @staticmethod
    def _json_dump_object(value: dict[str, Any]) -> str:
        return json.dumps(value or {}, separators=(",", ":"), sort_keys=True)

    @staticmethod
    def _required_non_negative_int(payload: dict[str, Any], field_name: str) -> int:
        value = payload.get(field_name)
        if isinstance(value, bool) or value is None:
            raise ValueError(f"{field_name} is required")
        try:
            parsed = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field_name} must be an integer") from exc
        if parsed < 0:
            raise ValueError(f"{field_name} must be non-negative")
        return parsed

    @staticmethod
    def _optional_float(payload: dict[str, Any], field_name: str) -> float | None:
        if field_name not in payload:
            return None
        value = payload.get(field_name)
        if value is None or value == "":
            return None
        if isinstance(value, bool):
            raise ValueError(f"{field_name} must be a number")
        try:
            return float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field_name} must be a number") from exc

    def _labeling_session_row(self, session_id: str) -> sqlite3.Row | None:
        return self.connection.execute(
            """
            SELECT *
            FROM labeling_sessions
            WHERE session_id = ?
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()

    def _labeling_session_artifact_count(self, session_id: str) -> int:
        row = self.connection.execute(
            """
            SELECT COUNT(*) AS count
            FROM labeling_session_artifacts
            WHERE session_id = ?
            """,
            (session_id,),
        ).fetchone()
        return int(row["count"] or 0) if row is not None else 0

    def _labeling_session_payload(
        self,
        row: sqlite3.Row,
        *,
        artifact_count: int | None = None,
    ) -> dict[str, Any]:
        selected_card = self._json_load_object(row["selected_card_json"])
        return {
            "sessionID": row["session_id"],
            "labelerUserID": str(row["labeler_user_id"] or "").strip() or None,
            "cardID": row["card_id"],
            "providerCardID": str(row["provider_card_id"] or "").strip() or str(row["card_id"] or "").strip(),
            "status": row["status"],
            "tierAssignment": _normalize_labeling_tier(row["tier_assignment"]),
            "routedBatchID": str(row["routed_batch_id"] or "").strip() or None,
            "firstCaptureScanID": str(row["first_capture_scan_id"] or "").strip() or None,
            "selectedCard": selected_card if selected_card else None,
            "artifactCount": (
                self._labeling_session_artifact_count(str(row["session_id"]))
                if artifact_count is None
                else artifact_count
            ),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "completedAt": row["completed_at"],
            "abortedAt": row["aborted_at"],
            "abortReason": row["abort_reason"],
        }

    def _labeling_session_artifact_payload(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "artifactID": row["id"],
            "sessionID": row["session_id"],
            "cardID": row["card_id"],
            "scanID": str(row["scan_id"] or "").strip() or None,
            "angleIndex": row["angle_index"],
            "angleLabel": row["angle_label"],
            "datasetRole": _normalize_labeling_tier(row["dataset_role"]),
            "sourceObjectPath": row["source_object_path"],
            "normalizedObjectPath": row["normalized_object_path"],
            "sourceWidth": row["source_width"],
            "sourceHeight": row["source_height"],
            "normalizedWidth": row["normalized_width"],
            "normalizedHeight": row["normalized_height"],
            "nativeMetadata": self._json_load_object(row["native_metadata_json"]),
            "cropMetadata": self._json_load_object(row["crop_metadata_json"]),
            "normalizationMetadata": self._json_load_object(row["normalization_metadata_json"]),
            "sourceBranch": row["source_branch"],
            "pixelsPerCardHeight": row["pixels_per_card_height"],
            "processingMs": row["processing_ms"],
            "scannerFrontHalfVersion": row["scanner_front_half_version"],
            "submittedAt": row["submitted_at"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def create_labeling_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        card_id = str(payload.get("cardID") or "").strip()
        if not card_id:
            raise ValueError("cardID is required")

        card = card_by_id(self.connection, card_id)
        if card is None:
            raise FileNotFoundError("card not found")

        session_id = str(payload.get("sessionID") or "").strip() or f"labeling-session:{uuid.uuid4().hex}"
        if "/" in session_id:
            raise ValueError("sessionID cannot contain /")

        selected_card = payload.get("selectedCard")
        if selected_card is None:
            selected_card = self._selected_card_summary(card)
        elif not isinstance(selected_card, dict):
            raise ValueError("selectedCard must be an object")

        existing = self._labeling_session_row(session_id)
        if existing is not None:
            self._assert_labeling_session_owner(existing, owner_user_id)
            if str(existing["card_id"] or "").strip() != card_id:
                raise ValueError("sessionID already exists for another cardID")
            return self._labeling_session_payload(existing)

        created_at = str(payload.get("createdAt") or utc_now()).strip() or utc_now()
        provider_card_id = card_id
        try:
            self.connection.execute(
                """
                INSERT INTO labeling_sessions (
                    session_id, labeler_user_id, card_id, provider_card_id, status,
                    selected_card_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, 'capturing', ?, ?, ?)
                """,
                (
                    session_id,
                    owner_user_id,
                    card_id,
                    provider_card_id,
                    self._json_dump_object(selected_card),
                    created_at,
                    created_at,
                ),
            )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        row = self._labeling_session_row(session_id)
        if row is None:
            raise RuntimeError("labeling session was not persisted")
        return self._labeling_session_payload(row, artifact_count=0)

    def store_labeling_session_artifact(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            raise ValueError("sessionID is required")

        session_row = self._labeling_session_row(normalized_session_id)
        if session_row is None:
            raise FileNotFoundError("labeling session not found")
        self._assert_labeling_session_owner(session_row, owner_user_id)
        if str(session_row["status"] or "") != "capturing":
            raise ValueError("labeling session is not capturing")

        angle_index = self._required_non_negative_int(payload, "angleIndex")
        if angle_index < 1 or angle_index > LABELING_SESSION_REQUIRED_ANGLE_COUNT:
            raise ValueError(f"angleIndex must be between 1 and {LABELING_SESSION_REQUIRED_ANGLE_COUNT}")
        angle_label = str(payload.get("angleLabel") or "").strip()
        if not angle_label:
            raise ValueError("angleLabel is required")

        source_bytes, source_width, source_height = self._decode_scan_image_payload(payload, field_name="sourceImage")
        normalized_bytes, normalized_width, normalized_height = self._decode_scan_image_payload(payload, field_name="normalizedImage")
        submitted_at = str(payload.get("submittedAt") or utc_now()).strip() or utc_now()
        card_id = str(session_row["card_id"] or "").strip()
        existing_artifact_row = self.connection.execute(
            """
            SELECT *
            FROM labeling_session_artifacts
            WHERE session_id = ? AND angle_index = ?
            LIMIT 1
            """,
            (normalized_session_id, angle_index),
        ).fetchone()
        artifact_id = (
            str(existing_artifact_row["id"] or "").strip()
            if existing_artifact_row is not None
            else f"labeling-artifact:{uuid.uuid4().hex}"
        )
        scan_id = (
            str(existing_artifact_row["scan_id"] or "").strip()
            if existing_artifact_row is not None and str(existing_artifact_row["scan_id"] or "").strip()
            else self._labeling_scan_id(normalized_session_id, angle_index)
        )

        native_metadata = self._json_object_payload(payload, "nativeMetadata")
        if not native_metadata:
            native_metadata = {
                "sourceWidth": self._optional_float(payload, "nativeSourceWidth"),
                "sourceHeight": self._optional_float(payload, "nativeSourceHeight"),
            }
        crop_metadata = self._json_object_payload(payload, "cropMetadata")
        if not crop_metadata:
            crop_metadata = {
                "x": self._optional_float(payload, "cropX"),
                "y": self._optional_float(payload, "cropY"),
                "width": self._optional_float(payload, "cropWidth"),
                "height": self._optional_float(payload, "cropHeight"),
            }
        normalization_metadata = self._json_object_payload(payload, "normalizationMetadata")
        if not normalization_metadata:
            normalization_metadata = {
                "rotationDegrees": self._optional_float(payload, "normalizationRotationDegrees"),
                "reason": str(payload.get("normalizationReason") or "").strip() or None,
            }

        try:
            stored = self.artifact_store.store_labeling_session_artifact(
                session_id=normalized_session_id,
                angle_index=angle_index,
                angle_label=angle_label,
                source_bytes=source_bytes,
                normalized_bytes=normalized_bytes,
            )
            upsert_scan_event(
                self.connection,
                scan_id=scan_id,
                owner_user_id=owner_user_id,
                request_payload={
                    "sourceType": "labeling_session",
                    "labelingSessionID": normalized_session_id,
                    "angleIndex": angle_index,
                    "angleLabel": angle_label,
                    "cardID": card_id,
                },
                response_payload={
                    "labelingSessionID": normalized_session_id,
                    "selectedCardID": card_id,
                    "providerCardID": str(session_row["provider_card_id"] or "").strip() or card_id,
                },
                matcher_source="labeling_session",
                matcher_version="labeling-session-v1",
                created_at=submitted_at,
                selected_card_id=card_id,
                selection_source="labeling_session",
                resolver_mode="labeling_session",
                resolver_path="labeling_session",
                completed_at=submitted_at,
            )
            upsert_scan_artifact(
                self.connection,
                scan_id=scan_id,
                owner_user_id=owner_user_id,
                source_object_path=stored.source_object_path,
                normalized_object_path=stored.normalized_object_path,
                source_width=source_width,
                source_height=source_height,
                normalized_width=normalized_width,
                normalized_height=normalized_height,
                camera_zoom_factor=float(payload["cameraZoomFactor"]) if isinstance(payload.get("cameraZoomFactor"), (int, float)) else None,
                capture_source="labeling_session",
                uploaded_at=submitted_at,
                created_at=submitted_at,
            )
            self.connection.execute(
                """
                INSERT INTO labeling_session_artifacts (
                    id, session_id, card_id, scan_id, angle_index, angle_label, dataset_role,
                    source_object_path, normalized_object_path,
                    source_width, source_height, normalized_width, normalized_height,
                    native_metadata_json, crop_metadata_json, normalization_metadata_json,
                    source_branch, pixels_per_card_height, processing_ms,
                    scanner_front_half_version, submitted_at, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id, angle_index) DO UPDATE SET
                    card_id=excluded.card_id,
                    scan_id=excluded.scan_id,
                    angle_label=excluded.angle_label,
                    dataset_role=excluded.dataset_role,
                    source_object_path=excluded.source_object_path,
                    normalized_object_path=excluded.normalized_object_path,
                    source_width=excluded.source_width,
                    source_height=excluded.source_height,
                    normalized_width=excluded.normalized_width,
                    normalized_height=excluded.normalized_height,
                    native_metadata_json=excluded.native_metadata_json,
                    crop_metadata_json=excluded.crop_metadata_json,
                    normalization_metadata_json=excluded.normalization_metadata_json,
                    source_branch=excluded.source_branch,
                    pixels_per_card_height=excluded.pixels_per_card_height,
                    processing_ms=excluded.processing_ms,
                    scanner_front_half_version=excluded.scanner_front_half_version,
                    submitted_at=excluded.submitted_at,
                    updated_at=excluded.updated_at
                """,
                (
                    artifact_id,
                    normalized_session_id,
                    card_id,
                    scan_id,
                    angle_index,
                    angle_label,
                    _normalize_labeling_tier(existing_artifact_row["dataset_role"]) if existing_artifact_row is not None else None,
                    stored.source_object_path,
                    stored.normalized_object_path,
                    source_width,
                    source_height,
                    normalized_width,
                    normalized_height,
                    self._json_dump_object(native_metadata),
                    self._json_dump_object(crop_metadata),
                    self._json_dump_object(normalization_metadata),
                    str(payload.get("sourceBranch") or "").strip() or None,
                    self._optional_float(payload, "pixelsPerCardHeight"),
                    self._optional_float(payload, "processingMs"),
                    str(payload.get("scannerFrontHalfVersion") or "").strip() or None,
                    submitted_at,
                    submitted_at,
                    submitted_at,
                ),
            )
            self.connection.execute(
                """
                UPDATE labeling_sessions
                SET updated_at = ?,
                    first_capture_scan_id = COALESCE(first_capture_scan_id, ?)
                WHERE session_id = ?
                """,
                (submitted_at, scan_id, normalized_session_id),
            )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        row = self.connection.execute(
            """
            SELECT *
            FROM labeling_session_artifacts
            WHERE session_id = ? AND angle_index = ?
            LIMIT 1
            """,
            (normalized_session_id, angle_index),
        ).fetchone()
        if row is None:
            raise RuntimeError("labeling session artifact was not persisted")
        return self._labeling_session_artifact_payload(row)

    def complete_labeling_session(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            raise ValueError("sessionID is required")

        session_row = self._labeling_session_row(normalized_session_id)
        if session_row is None:
            raise FileNotFoundError("labeling session not found")
        self._assert_labeling_session_owner(session_row, owner_user_id)

        status = str(session_row["status"] or "")
        if status == "aborted":
            raise ValueError("labeling session already aborted")

        artifact_count = self._labeling_session_artifact_count(normalized_session_id)
        if artifact_count < LABELING_SESSION_REQUIRED_ANGLE_COUNT:
            raise ValueError(
                f"labeling session requires {LABELING_SESSION_REQUIRED_ANGLE_COUNT} artifacts"
            )

        provider_card_id = str(session_row["provider_card_id"] or "").strip() or str(session_row["card_id"] or "").strip()
        first_capture_scan_id = str(session_row["first_capture_scan_id"] or "").strip()
        if not first_capture_scan_id:
            first_capture_row = self.connection.execute(
                """
                SELECT scan_id
                FROM labeling_session_artifacts
                WHERE session_id = ? AND scan_id IS NOT NULL AND TRIM(scan_id) <> ''
                ORDER BY angle_index ASC, submitted_at ASC
                LIMIT 1
                """,
                (normalized_session_id,),
            ).fetchone()
            first_capture_scan_id = str(first_capture_row["scan_id"] or "").strip() if first_capture_row is not None else ""
        if not first_capture_scan_id:
            raise ValueError("labeling session requires linked scan artifacts")

        tier_assignment, routed_batch_id = self._route_labeling_provider_card(
            provider_card_id=provider_card_id,
            first_scan_id=first_capture_scan_id,
            labeling_session_id=normalized_session_id,
            source_type="labeling_session",
        )
        completed_at = str(payload.get("completedAt") or payload.get("submittedAt") or utc_now()).strip() or utc_now()
        try:
            scan_rows = self.connection.execute(
                """
                SELECT scan_id
                FROM labeling_session_artifacts
                WHERE session_id = ? AND scan_id IS NOT NULL AND TRIM(scan_id) <> ''
                ORDER BY angle_index ASC
                """,
                (normalized_session_id,),
            ).fetchall()
            for scan_row in scan_rows:
                linked_scan_id = str(scan_row["scan_id"] or "").strip()
                if not linked_scan_id:
                    continue
                upsert_scan_event(
                    self.connection,
                    scan_id=linked_scan_id,
                    owner_user_id=owner_user_id,
                    request_payload={
                        "sourceType": "labeling_session",
                        "labelingSessionID": normalized_session_id,
                        "cardID": str(session_row["card_id"] or "").strip(),
                    },
                    response_payload={
                        "labelingSessionID": normalized_session_id,
                        "selectedCardID": str(session_row["card_id"] or "").strip(),
                        "providerCardID": provider_card_id,
                        "tierAssignment": tier_assignment,
                    },
                    matcher_source="labeling_session",
                    matcher_version="labeling-session-v1",
                    created_at=completed_at,
                    selected_card_id=str(session_row["card_id"] or "").strip(),
                    selection_source="labeling_session",
                    confirmed_card_id=str(session_row["card_id"] or "").strip(),
                    confirmation_source="labeling_session",
                    resolver_mode="labeling_session",
                    resolver_path="labeling_session",
                    completed_at=completed_at,
                    confirmed_at=completed_at,
                )

            self.connection.execute(
                """
                UPDATE labeling_session_artifacts
                SET dataset_role = ?, updated_at = ?
                WHERE session_id = ?
                """,
                (tier_assignment, completed_at, normalized_session_id),
            )
            self.connection.execute(
                """
                UPDATE labeling_sessions
                SET status = 'completed',
                    provider_card_id = ?,
                    tier_assignment = ?,
                    routed_batch_id = ?,
                    first_capture_scan_id = COALESCE(first_capture_scan_id, ?),
                    completed_at = COALESCE(completed_at, ?),
                    updated_at = ?
                WHERE session_id = ?
                """,
                (
                    provider_card_id,
                    tier_assignment,
                    routed_batch_id,
                    first_capture_scan_id,
                    completed_at,
                    completed_at,
                    normalized_session_id,
                ),
            )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        session_row = self._labeling_session_row(normalized_session_id)
        if session_row is None:
            raise RuntimeError("labeling session was not persisted")

        return self._labeling_session_payload(session_row, artifact_count=artifact_count)

    def abort_labeling_session(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            raise ValueError("sessionID is required")

        session_row = self._labeling_session_row(normalized_session_id)
        if session_row is None:
            raise FileNotFoundError("labeling session not found")
        self._assert_labeling_session_owner(session_row, owner_user_id)

        status = str(session_row["status"] or "")
        if status == "completed":
            raise ValueError("labeling session already completed")
        if status != "aborted":
            aborted_at = str(payload.get("abortedAt") or payload.get("submittedAt") or utc_now()).strip() or utc_now()
            abort_reason = str(payload.get("abortReason") or payload.get("reason") or "").strip() or None
            try:
                self.connection.execute(
                    """
                    UPDATE labeling_sessions
                    SET status = 'aborted', aborted_at = ?, abort_reason = ?, updated_at = ?
                    WHERE session_id = ?
                    """,
                    (aborted_at, abort_reason, aborted_at, normalized_session_id),
                )
                self.connection.commit()
            except Exception:
                self.connection.rollback()
                raise
            session_row = self._labeling_session_row(normalized_session_id)
            if session_row is None:
                raise RuntimeError("labeling session was not persisted")

        return self._labeling_session_payload(session_row)

    @staticmethod
    def _decode_scan_image_payload(
        payload: dict[str, Any], *, field_name: str, optional: bool = False
    ) -> tuple[bytes | None, int | None, int | None]:
        image_payload = payload.get(field_name)
        if not isinstance(image_payload, dict):
            if optional:
                return None, None, None
            raise ValueError(f"{field_name} must be an object")
        encoded = str(image_payload.get("jpegBase64") or "").strip()
        if not encoded:
            if optional:
                return None, None, None
            raise ValueError(f"{field_name}.jpegBase64 is required")
        # A present-but-invalid value is always an error, even when optional —
        # don't silently accept garbage.
        try:
            raw_bytes = base64.b64decode(encoded, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"{field_name}.jpegBase64 is invalid") from exc
        width_value = image_payload.get("width")
        height_value = image_payload.get("height")
        width = int(width_value) if isinstance(width_value, int) else None
        height = int(height_value) if isinstance(height_value, int) else None
        return raw_bytes, width, height

    def _record_failed_scan_artifact(self, scan_id: str, owner_user_id: str | None, created_at: str) -> None:
        """Best-effort 'failed' marker so a dropped upload is visible (one row per
        attempt) instead of silently absent. Must never mask the original error."""
        try:
            upsert_scan_artifact(
                self.connection,
                scan_id=scan_id,
                owner_user_id=owner_user_id,
                source_object_path=None,
                normalized_object_path=None,
                upload_status="failed",
                uploaded_at=None,
                created_at=created_at,
            )
            self.connection.commit()
        except Exception:  # noqa: BLE001 - observability must not break the request path
            try:
                self.connection.rollback()
            except Exception:  # noqa: BLE001
                pass

    def store_scan_artifacts(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        scan_id = str(payload.get("scanID") or "").strip()
        if not scan_id:
            raise ValueError("scanID is required")

        scan_row = self.connection.execute(
            "SELECT scan_id FROM scan_events WHERE scan_id = ? AND owner_user_id = ? LIMIT 1",
            (scan_id, owner_user_id),
        ).fetchone()
        if scan_row is None:
            # The scanID has no event row for THIS user. Two cases:
            #  (a) it belongs to a DIFFERENT user → cross-user attempt; reject
            #      exactly as before (never create/hijack another user's row).
            #  (b) it exists for nobody → the match handler normally pre-creates
            #      an in_progress stub for this scanID, but the artifact upload is
            #      fired in parallel and under load that stub write can lose the
            #      race (or fail on SQLite write contention), which previously
            #      404'd here and LOST the JPEG. Make the upload self-sufficient:
            #      create our own stub so the artifact always has a row to attach
            #      to (FK + the match's later _log_scan upsert both stay
            #      satisfied; ON CONFLICT fills the real matcher fields when the
            #      match completes). This is the fix for show-scan images going
            #      missing under concurrency.
            foreign_row = self.connection.execute(
                "SELECT 1 FROM scan_events WHERE scan_id = ? LIMIT 1",
                (scan_id,),
            ).fetchone()
            if foreign_row is not None:
                raise FileNotFoundError("scan event not found")
            upsert_scan_event(
                self.connection,
                scan_id=scan_id,
                owner_user_id=owner_user_id,
                request_payload={"scanID": scan_id, "source": "scan_artifacts_stub"},
                response_payload={},
                matcher_source="in_progress",
                matcher_version="in_progress",
                created_at=utc_now(),
            )
            self.connection.commit()

        if not self._scan_artifact_uploads_enabled():
            return {
                "scanID": scan_id,
                "enabled": False,
                "skipped": True,
                "reason": "scan artifact uploads disabled",
                "storage": self.artifact_store.storage_kind,
            }

        # normalized_target is the training-critical image and is required.
        # source_capture is optional context — when the client couldn't attach it
        # (e.g. its base64 dropped under phone memory pressure) we still persist
        # the normalized image rather than discarding the whole upload.
        normalized_bytes, normalized_width, normalized_height = self._decode_scan_image_payload(
            payload, field_name="normalizedImage"
        )
        source_bytes, source_width, source_height = self._decode_scan_image_payload(
            payload, field_name="sourceImage", optional=True
        )

        submitted_at = str(payload.get("submittedAt") or utc_now()).strip() or utc_now()
        try:
            partition_datetime = datetime.fromisoformat(submitted_at.replace("Z", "+00:00"))
        except ValueError:
            partition_datetime = datetime.now(timezone.utc)
        year = f"{partition_datetime.year:04d}"
        month = f"{partition_datetime.month:02d}"
        day = f"{partition_datetime.day:02d}"
        try:
            if source_bytes is not None:
                stored = self.artifact_store.store(
                    scan_id=scan_id,
                    source_bytes=source_bytes,
                    normalized_bytes=normalized_bytes,
                    year=year,
                    month=month,
                    day=day,
                )
                upload_status = "uploaded"
            else:
                stored = self.artifact_store.store_normalized_only(
                    scan_id=scan_id,
                    normalized_bytes=normalized_bytes,
                    year=year,
                    month=month,
                    day=day,
                )
                upload_status = "normalized_only"

            upsert_scan_artifact(
                self.connection,
                scan_id=scan_id,
                owner_user_id=owner_user_id,
                source_object_path=stored.source_object_path,
                normalized_object_path=stored.normalized_object_path,
                source_width=source_width,
                source_height=source_height,
                normalized_width=normalized_width,
                normalized_height=normalized_height,
                camera_zoom_factor=float(payload["cameraZoomFactor"]) if isinstance(payload.get("cameraZoomFactor"), (int, float)) else None,
                capture_source=str(payload.get("captureSource") or "").strip() or None,
                upload_status=upload_status,
                uploaded_at=submitted_at,
                created_at=submitted_at,
            )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            # Record a visible 'failed' marker so server-side drops aren't silent.
            self._record_failed_scan_artifact(scan_id, owner_user_id, submitted_at)
            raise

        artifacts_json_object_path: str | None = None
        try:
            artifacts_document = self._build_scan_artifacts_document(
                scan_id=scan_id,
                payload=payload,
                source_object_path=stored.source_object_path,
                normalized_object_path=stored.normalized_object_path,
                source_width=source_width,
                source_height=source_height,
                normalized_width=normalized_width,
                normalized_height=normalized_height,
                created_at=submitted_at,
            )
            artifacts_json_object_path = self.artifact_store.write_artifacts_json(
                scan_id=scan_id,
                year=year,
                month=month,
                day=day,
                document=artifacts_document,
            )
        except Exception as exc:  # noqa: BLE001 - artifacts.json is best-effort
            self._emit_structured_log(
                {
                    "severity": "WARNING",
                    "event": "scan_artifacts_json_write_failed",
                    "scanID": scan_id,
                    "phase": "capture",
                    "error": str(exc),
                }
            )

        return {
            "scanID": scan_id,
            "enabled": True,
            "storage": self.artifact_store.storage_kind,
            "uploadStatus": upload_status,
            "sourceObjectPath": stored.source_object_path,
            "normalizedObjectPath": stored.normalized_object_path,
            "artifactsJsonObjectPath": artifacts_json_object_path,
            "uploadedAt": submitted_at,
        }

    _SCAN_ARTIFACTS_JSON_SCHEMA_VERSION = 1

    @staticmethod
    def _partition_from_object_path(object_path: str) -> tuple[str, str, str] | None:
        if not object_path:
            return None
        segments = [segment for segment in object_path.split("/") if segment]
        try:
            scans_index = segments.index("scans")
        except ValueError:
            return None
        if scans_index + 4 >= len(segments):
            return None
        year = segments[scans_index + 1]
        month = segments[scans_index + 2]
        day = segments[scans_index + 3]
        if not (year.isdigit() and month.isdigit() and day.isdigit()):
            return None
        return year, month, day

    def _scan_top_candidates_for_artifacts(self, scan_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            """
            SELECT rank, card_id, final_score, candidate_json
            FROM scan_prediction_candidates
            WHERE scan_id = ?
            ORDER BY rank ASC
            LIMIT 10
            """,
            (scan_id,),
        ).fetchall()
        candidates: list[dict[str, Any]] = []
        for row in rows:
            rank_value = row["rank"]
            card_id = str(row["card_id"] or "").strip()
            final_score_value = row["final_score"]
            try:
                score: float | None = float(final_score_value) if final_score_value is not None else None
            except (TypeError, ValueError):
                score = None
            candidates.append(
                {
                    "rank": int(rank_value) if isinstance(rank_value, int) else int(rank_value or 0),
                    "card_id": card_id,
                    "score": score,
                }
            )
        return candidates

    def _assert_scan_owned_by_caller(self, scan_id: str) -> None:
        """Raise FileNotFoundError unless the scan belongs to the calling identity.

        Mirrors the existing scan-scoped owner check
        (``SELECT 1 FROM scan_events WHERE scan_id = ? AND owner_user_id = ?``).
        Missing scans and cross-owner reads both surface as a 404 so we never
        confirm the existence of another user's scan.
        """
        normalized_scan_id = str(scan_id or "").strip()
        if not normalized_scan_id:
            raise FileNotFoundError("Scan not found.")
        owner_user_id = self._current_owner_user_id()
        row = self.connection.execute(
            "SELECT 1 FROM scan_events WHERE scan_id = ? AND owner_user_id = ? LIMIT 1",
            (normalized_scan_id, owner_user_id),
        ).fetchone()
        if row is None:
            raise FileNotFoundError("Scan not found.")

    def scan_candidates_window(
        self,
        scan_id: str,
        *,
        offset: int = 0,
        limit: int = SCAN_CANDIDATE_POOL_SIZE,
    ) -> dict[str, Any]:
        """Return a window of the persisted scan candidate pool.

        Used by the "load more candidates" endpoint. The live scan response already
        carries the hydrated top 10; this reads further into the persisted pool and
        hydrates pricing ON DEMAND using cached-only SQLite pricing (no Scrydex/live
        refresh), so paging never triggers a provider call.
        """
        self._assert_scan_owned_by_caller(scan_id)
        normalized_scan_id = str(scan_id or "").strip()
        clamped_limit = max(1, min(int(limit), SCAN_CANDIDATE_POOL_SIZE))
        clamped_offset = max(0, int(offset))

        total_row = self.connection.execute(
            "SELECT COUNT(*) AS total FROM scan_prediction_candidates WHERE scan_id = ?",
            (normalized_scan_id,),
        ).fetchone()
        total = int((total_row["total"] if total_row is not None else 0) or 0)

        rows = self.connection.execute(
            """
            SELECT rank, card_id, candidate_json
            FROM scan_prediction_candidates
            WHERE scan_id = ?
            ORDER BY rank ASC
            LIMIT ? OFFSET ?
            """,
            (normalized_scan_id, clamped_limit, clamped_offset),
        ).fetchall()

        pricing_context = self._raw_pricing_context()
        candidates: list[dict[str, Any]] = []
        for row in rows:
            candidate_json = row["candidate_json"]
            try:
                encoded = json.loads(candidate_json) if candidate_json else {}
            except (TypeError, ValueError, json.JSONDecodeError):
                encoded = {}
            if not isinstance(encoded, dict):
                continue
            candidate_payload = encoded.get("candidate")
            if not isinstance(candidate_payload, dict):
                candidate_payload = {}
                encoded["candidate"] = candidate_payload
            card_id = str(row["card_id"] or candidate_payload.get("id") or "").strip()
            # Enrich pricing only on demand (Load More), cached-only — never live.
            if card_id and not candidate_payload.get("pricing"):
                pricing = self._display_pricing_summary_for_context(
                    card_id,
                    pricing_context=pricing_context,
                )
                if pricing is not None:
                    candidate_payload["pricing"] = pricing
            candidates.append(encoded)

        return {"candidates": candidates, "total": total}

    def _build_scan_artifacts_document(
        self,
        *,
        scan_id: str,
        payload: dict[str, Any],
        source_object_path: str | None,
        normalized_object_path: str,
        source_width: int | None,
        source_height: int | None,
        normalized_width: int | None,
        normalized_height: int | None,
        created_at: str,
    ) -> dict[str, Any]:
        scan_event = self.connection.execute(
            """
            SELECT resolver_mode, matcher_version, predicted_card_id, selected_card_id,
                   confirmed_card_id, confirmed_at, response_json
            FROM scan_events
            WHERE scan_id = ?
            LIMIT 1
            """,
            (scan_id,),
        ).fetchone()
        response_payload: dict[str, Any] = {}
        if scan_event is not None:
            response_raw = scan_event["response_json"]
            if response_raw:
                try:
                    parsed_response = json.loads(response_raw)
                    if isinstance(parsed_response, dict):
                        response_payload = parsed_response
                except (TypeError, ValueError):
                    response_payload = {}

        mode = str((scan_event["resolver_mode"] if scan_event is not None else "") or "").strip() or None
        matcher_version = str((scan_event["matcher_version"] if scan_event is not None else "") or "").strip() or None
        predicted_card_id = str((scan_event["predicted_card_id"] if scan_event is not None else "") or "").strip() or None
        selected_card_id = str((scan_event["selected_card_id"] if scan_event is not None else "") or "").strip() or None
        confirmed_card_id = str((scan_event["confirmed_card_id"] if scan_event is not None else "") or "").strip() or None
        confirmed_at = str((scan_event["confirmed_at"] if scan_event is not None else "") or "").strip() or None

        slab_block: dict[str, Any] | None = None
        slab_context = response_payload.get("slabContext") if isinstance(response_payload, dict) else None
        if isinstance(slab_context, dict):
            cert_number = str(slab_context.get("certNumber") or slab_context.get("cert_number") or "").strip() or None
            grader = str(slab_context.get("grader") or "").strip() or None
            grade = str(slab_context.get("grade") or "").strip() or None
            variant_name = str(slab_context.get("variantName") or slab_context.get("variant_name") or "").strip() or None
            if any((cert_number, grader, grade, variant_name)):
                slab_block = {
                    "cert_number": cert_number,
                    "grader": grader,
                    "grade": grade,
                    "variant_name": variant_name,
                }

        camera_zoom: float | None = None
        if isinstance(payload.get("cameraZoomFactor"), (int, float)):
            camera_zoom = float(payload["cameraZoomFactor"])

        capture_block: dict[str, Any] = {
            "source_width": source_width,
            "source_height": source_height,
            "normalized_width": normalized_width,
            "normalized_height": normalized_height,
            "camera_zoom_factor": camera_zoom,
            "capture_source": str(payload.get("captureSource") or "").strip() or None,
        }
        device_info = payload.get("device") if isinstance(payload.get("device"), dict) else None
        if device_info:
            capture_block["device"] = {
                str(key): value for key, value in device_info.items()
            }

        document: dict[str, Any] = {
            "version": self._SCAN_ARTIFACTS_JSON_SCHEMA_VERSION,
            "scan_id": scan_id,
            "created_at": created_at,
            "mode": mode,
            "predicted_card_id": predicted_card_id,
            "selected_card_id": selected_card_id,
            "top_candidates": self._scan_top_candidates_for_artifacts(scan_id),
            "matcher_version": matcher_version,
            "slab": slab_block,
            "capture": capture_block,
            "source_capture_uri": source_object_path,
            "normalized_target_uri": normalized_object_path,
            "confirmed_card_id": confirmed_card_id,
            "confirmed_at": confirmed_at,
        }
        return document

    def _update_scan_artifacts_json_for_confirm(
        self,
        *,
        scan_id: str,
        confirmed_card_id: str,
        confirmed_at: str,
    ) -> None:
        write_artifacts_json = getattr(self.artifact_store, "write_artifacts_json", None)
        read_artifacts_json = getattr(self.artifact_store, "read_artifacts_json", None)
        if not callable(write_artifacts_json) or not callable(read_artifacts_json):
            return

        artifact_row = self.connection.execute(
            "SELECT source_object_path FROM scan_artifacts WHERE scan_id = ? LIMIT 1",
            (scan_id,),
        ).fetchone()
        if artifact_row is None:
            self._emit_structured_log(
                {
                    "severity": "WARNING",
                    "event": "scan_artifacts_json_update_skipped",
                    "scanID": scan_id,
                    "reason": "scan_artifact_row_missing",
                }
            )
            return

        partition = self._partition_from_object_path(str(artifact_row["source_object_path"] or ""))
        if partition is None:
            self._emit_structured_log(
                {
                    "severity": "WARNING",
                    "event": "scan_artifacts_json_update_skipped",
                    "scanID": scan_id,
                    "reason": "partition_unresolved",
                }
            )
            return
        year, month, day = partition

        existing_document = read_artifacts_json(
            scan_id=scan_id,
            year=year,
            month=month,
            day=day,
        )
        if not isinstance(existing_document, dict):
            self._emit_structured_log(
                {
                    "severity": "WARNING",
                    "event": "scan_artifacts_json_update_skipped",
                    "scanID": scan_id,
                    "reason": "artifacts_json_missing",
                }
            )
            return

        existing_document["confirmed_card_id"] = confirmed_card_id
        existing_document["confirmed_at"] = confirmed_at
        if not existing_document.get("version"):
            existing_document["version"] = self._SCAN_ARTIFACTS_JSON_SCHEMA_VERSION

        write_artifacts_json(
            scan_id=scan_id,
            year=year,
            month=month,
            day=day,
            document=existing_document,
        )

    def create_deck_entry(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        card_id = str(payload.get("cardID") or "").strip()
        if not card_id:
            raise ValueError("cardID is required")

        scan_id = str(payload.get("sourceScanID") or "").strip() or None
        existing_event = None
        if scan_id:
            existing_event = self.connection.execute(
                """
                SELECT request_json, response_json, matcher_source, matcher_version, created_at,
                       selected_card_id, selected_rank, was_top_prediction, selection_source,
                       confidence, review_disposition, correction_type, resolver_mode, resolver_path,
                       predicted_card_id
                FROM scan_events
                WHERE scan_id = ?
                  AND owner_user_id = ?
                LIMIT 1
                """,
                (scan_id, owner_user_id),
            ).fetchone()
            if existing_event is None:
                raise FileNotFoundError("scan event not found")

        slab_context = payload.get("slabContext") if isinstance(payload.get("slabContext"), dict) else {}
        grader = str(slab_context.get("grader") or "").strip() or None
        grade = str(slab_context.get("grade") or "").strip() or None
        cert_number = str(slab_context.get("certNumber") or "").strip() or None
        raw_variant_name = str(payload.get("variantName") or "").strip() or None
        slab_variant_name = str(slab_context.get("variantName") or "").strip() or None
        # A slab variantName equal to the grade label ("PSA 10") is not a print
        # variant; stored as-is it never matches the graded price snapshot and the
        # Collection/Wishlist value collapses to "—". Drop it so the resolver falls
        # back to the grade's real entry. Mirrors record_buy / replace_deck_entry.
        # For raw cards (no grader/grade/cert) the print variant arrives as the
        # top-level `variantName`; read it there rather than from the empty
        # slabContext, otherwise the picked variant is silently dropped on save.
        variant_name = (
            self._sanitize_slab_variant_name(slab_variant_name, grader, grade)
            if any([grader, grade, cert_number])
            else raw_variant_name
        )
        condition = self._normalized_deck_card_condition(payload.get("condition"))
        if payload.get("condition") is not None and condition is None:
            raise ValueError("condition is invalid")
        selection_source = str(payload.get("selectionSource") or "").strip() or "unknown"
        selected_rank_value = payload.get("selectedRank")
        selected_rank = int(selected_rank_value) if isinstance(selected_rank_value, int) else None
        was_top_prediction = bool(payload.get("wasTopPrediction") is True)
        added_at = str(payload.get("addedAt") or utc_now()).strip() or utc_now()

        try:
            quantity = int(payload.get("quantity", 1))
        except (TypeError, ValueError):
            raise ValueError("quantity must be an integer") from None
        if quantity < 1:
            raise ValueError("quantity must be at least 1")

        confirmation_source_map = {
            "top": "add_top",
            "alternate": "add_alternate",
            "manual_search": "add_manual_search",
        }
        confirmation_source = confirmation_source_map.get(selection_source, "add_unknown")

        cost_basis_per_unit_cents = self._parse_cost_basis_per_unit_cents(payload)

        added_market_price, added_market_date = self._added_baseline_now(
            card_id,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            variant_name=variant_name,
            condition=condition,
        )

        try:
            deck_entry_id = upsert_deck_entry(
                self.connection,
                owner_user_id=owner_user_id,
                card_id=card_id,
                grader=grader,
                grade=grade,
                cert_number=cert_number,
                variant_name=variant_name,
                condition=condition,
                quantity=quantity,
                added_at=added_at,
                updated_at=added_at,
                source_scan_id=scan_id,
                source_confirmation_id=None,
                added_market_price=added_market_price,
                added_market_date=added_market_date,
            )
            if cost_basis_per_unit_cents is not None:
                self._set_deck_entry_cost_basis_cents(
                    deck_entry_id=deck_entry_id,
                    cost_basis_cents=cost_basis_per_unit_cents,
                    updated_at=added_at,
                )

            confirmation_id = None
            if scan_id:
                confirmation_id = upsert_scan_confirmation(
                    self.connection,
                    scan_id=scan_id,
                    owner_user_id=owner_user_id,
                    confirmed_card_id=card_id,
                    confirmation_source=confirmation_source,
                    selected_rank=selected_rank,
                    was_top_prediction=was_top_prediction,
                    deck_entry_id=deck_entry_id,
                    created_at=added_at,
                )
                self.connection.execute(
                    """
                    UPDATE deck_entries
                    SET updated_at = ?, source_scan_id = ?, source_confirmation_id = ?
                    WHERE id = ?
                    """,
                    (
                        added_at,
                        scan_id,
                        confirmation_id,
                        deck_entry_id,
                    ),
                )
                request_payload = json.loads(existing_event["request_json"] or "{}")
                response_payload = json.loads(existing_event["response_json"] or "{}")
                upsert_scan_event(
                    self.connection,
                    scan_id=scan_id,
                    owner_user_id=owner_user_id,
                    request_payload=request_payload,
                    response_payload=response_payload,
                    matcher_source=str(existing_event["matcher_source"] or "remoteHybrid"),
                    matcher_version=str(existing_event["matcher_version"] or MATCHER_VERSION),
                    created_at=str(existing_event["created_at"] or added_at),
                    predicted_card_id=str(existing_event["predicted_card_id"] or "").strip() or self._predicted_card_id(response_payload),
                    selected_card_id=str(existing_event["selected_card_id"] or "").strip() or card_id,
                    selected_rank=selected_rank if selected_rank is not None else existing_event["selected_rank"],
                    was_top_prediction=was_top_prediction if payload.get("wasTopPrediction") is not None else bool(existing_event["was_top_prediction"] == 1),
                    selection_source=selection_source if selection_source != "unknown" else (existing_event["selection_source"] or "unknown"),
                    confirmed_card_id=card_id,
                    confirmation_source=confirmation_source,
                    deck_entry_id=deck_entry_id,
                    confidence=existing_event["confidence"],
                    review_disposition=existing_event["review_disposition"],
                    correction_type=existing_event["correction_type"],
                    resolver_mode=existing_event["resolver_mode"],
                    resolver_path=existing_event["resolver_path"],
                    completed_at=added_at,
                    confirmed_at=added_at,
                )

            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        if scan_id:
            try:
                self._update_scan_artifacts_json_for_confirm(
                    scan_id=scan_id,
                    confirmed_card_id=card_id,
                    confirmed_at=added_at,
                )
            except Exception as exc:  # noqa: BLE001 - artifacts.json update is best-effort
                self._emit_structured_log(
                    {
                        "severity": "WARNING",
                        "event": "scan_artifacts_json_write_failed",
                        "scanID": scan_id,
                        "phase": "confirm",
                        "error": str(exc),
                    }
                )

        return {
            "deckEntryID": deck_entry_id,
            "cardID": card_id,
            "variantName": variant_name,
            "condition": condition,
            "confirmationID": confirmation_id,
            "sourceScanID": scan_id,
            "addedAt": added_at,
        }

    def update_deck_entry_condition(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        card_id = str(payload.get("cardID") or "").strip()
        if not card_id:
            raise ValueError("cardID is required")

        condition = self._normalized_deck_card_condition(payload.get("condition"))
        if condition is None:
            if payload.get("condition") is None:
                raise ValueError("condition is required")
            raise ValueError("condition is invalid")

        slab_context = payload.get("slabContext") if isinstance(payload.get("slabContext"), dict) else {}
        grader = str(slab_context.get("grader") or "").strip() or None
        grade = str(slab_context.get("grade") or "").strip() or None
        cert_number = str(slab_context.get("certNumber") or "").strip() or None
        variant_name = str(slab_context.get("variantName") or "").strip() or None
        deck_entry_id = self._resolve_owned_deck_entry_id(
            card_id=card_id,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            variant_name=variant_name,
        )
        if not deck_entry_id:
            raise FileNotFoundError("deck entry not found")

        updated_at = str(payload.get("updatedAt") or utc_now()).strip() or utc_now()
        row = self.connection.execute(
            "SELECT id FROM deck_entries WHERE id = ? AND owner_user_id = ? LIMIT 1",
            (deck_entry_id, owner_user_id),
        ).fetchone()
        if row is None:
            raise FileNotFoundError("deck entry not found")

        self.connection.execute(
            """
            UPDATE deck_entries
            SET condition = ?, updated_at = ?
            WHERE id = ?
              AND owner_user_id = ?
            """,
            (condition, updated_at, deck_entry_id, owner_user_id),
        )
        append_deck_entry_event(
            self.connection,
            owner_user_id=owner_user_id,
            deck_entry_id=deck_entry_id,
            card_id=card_id,
            event_kind="condition",
            quantity_delta=0,
            condition=condition,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            variant_name=variant_name,
            created_at=updated_at,
        )
        self.connection.commit()
        return {
            "deckEntryID": deck_entry_id,
            "cardID": card_id,
            "condition": condition,
            "updatedAt": updated_at,
        }

    def update_deck_entry_purchase_price(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        card_id = str(payload.get("cardID") or "").strip()
        if not card_id:
            raise ValueError("cardID is required")

        unit_price_raw = payload.get("unitPrice")
        if unit_price_raw is None or unit_price_raw == "":
            raise ValueError("unitPrice is required")
        try:
            unit_price = float(unit_price_raw)
        except (TypeError, ValueError):
            raise ValueError("unitPrice must be a number") from None
        if unit_price < 0:
            raise ValueError("unitPrice must be non-negative")

        slab_context = payload.get("slabContext") if isinstance(payload.get("slabContext"), dict) else {}
        grader = str(slab_context.get("grader") or "").strip() or None
        grade = str(slab_context.get("grade") or "").strip() or None
        cert_number = str(slab_context.get("certNumber") or "").strip() or None
        variant_name = str(slab_context.get("variantName") or "").strip() or None
        deck_entry_id = self._resolve_owned_deck_entry_id(
            card_id=card_id,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            variant_name=variant_name,
        )
        if not deck_entry_id:
            raise FileNotFoundError("deck entry not found")

        updated_at = str(payload.get("updatedAt") or utc_now()).strip() or utc_now()
        currency_code = str(payload.get("currencyCode") or "").strip() or "USD"

        row = self.connection.execute(
            """
            SELECT quantity, condition, grader, grade, cert_number, variant_name
            FROM deck_entries
            WHERE id = ?
              AND owner_user_id = ?
            LIMIT 1
            """,
            (deck_entry_id, owner_user_id),
        ).fetchone()
        if row is None:
            raise FileNotFoundError("deck entry not found")

        quantity = max(1, int(row["quantity"] or 1))
        cost_basis_total = round(unit_price * quantity, 2)
        # Mirror into the new per-unit cents column when the redesign columns
        # are present. Older databases without the column path just skip this.
        cost_basis_per_unit_cents = int(round(float(unit_price) * 100.0))

        self.connection.execute(
            """
            UPDATE deck_entries
            SET cost_basis_total = ?, cost_basis_currency_code = ?, updated_at = ?
            WHERE id = ?
              AND owner_user_id = ?
            """,
            (cost_basis_total, currency_code, updated_at, deck_entry_id, owner_user_id),
        )
        self._set_deck_entry_cost_basis_cents(
            deck_entry_id=deck_entry_id,
            cost_basis_cents=cost_basis_per_unit_cents,
            updated_at=updated_at,
        )
        append_deck_entry_event(
            self.connection,
            owner_user_id=owner_user_id,
            deck_entry_id=deck_entry_id,
            card_id=card_id,
            event_kind="cost_basis",
            quantity_delta=0,
            unit_price=unit_price,
            total_price=cost_basis_total,
            currency_code=currency_code,
            condition=self._normalized_deck_card_condition(row["condition"]),
            grader=str(row["grader"] or "").strip() or None,
            grade=str(row["grade"] or "").strip() or None,
            cert_number=str(row["cert_number"] or "").strip() or None,
            variant_name=str(row["variant_name"] or "").strip() or None,
            created_at=updated_at,
        )
        self.connection.commit()
        return {
            "deckEntryID": deck_entry_id,
            "cardID": card_id,
            "unitPrice": round(unit_price, 2),
            "costBasisTotal": cost_basis_total,
            "currencyCode": currency_code,
            "updatedAt": updated_at,
        }

    # ------------------------------------------------------------------ #
    # Collections-redesign helpers + endpoints                            #
    # ------------------------------------------------------------------ #

    def _deck_entry_has_collections_columns(self) -> bool:
        try:
            columns = {
                str(row["name"])
                for row in self.connection.execute("PRAGMA table_info(deck_entries)").fetchall()
            }
        except sqlite3.OperationalError:
            return False
        return {"cost_basis_cents", "listing_url", "listing_price_cents", "listed_at"}.issubset(columns)

    def _parse_cost_basis_per_unit_cents(self, payload: dict[str, Any]) -> int | None:
        """Read either `costBasisPerUnit` (dollars float) or
        `costBasisPerUnitCents` (int) off a payload and normalize to cents.
        Returns None when neither field is present (no change requested).
        """
        if not isinstance(payload, dict):
            return None
        if "costBasisPerUnitCents" in payload:
            raw = payload.get("costBasisPerUnitCents")
            if raw is None or raw == "":
                return None
            try:
                value = int(raw)
            except (TypeError, ValueError):
                raise ValueError("costBasisPerUnitCents must be an integer") from None
            if value < 0:
                raise ValueError("costBasisPerUnitCents must be non-negative")
            return value
        if "costBasisPerUnit" in payload:
            raw = payload.get("costBasisPerUnit")
            if raw is None or raw == "":
                return None
            try:
                dollars = float(raw)
            except (TypeError, ValueError):
                raise ValueError("costBasisPerUnit must be a number") from None
            if dollars < 0:
                raise ValueError("costBasisPerUnit must be non-negative")
            return int(round(dollars * 100.0))
        return None

    def _set_deck_entry_cost_basis_cents(
        self,
        *,
        deck_entry_id: str,
        cost_basis_cents: int | None,
        updated_at: str | None = None,
    ) -> None:
        if not self._deck_entry_has_collections_columns():
            return
        owner_user_id = self._current_owner_user_id()
        self.connection.execute(
            """
            UPDATE deck_entries
            SET cost_basis_cents = ?,
                updated_at = ?
            WHERE id = ?
              AND owner_user_id = ?
            """,
            (
                cost_basis_cents,
                str(updated_at or utc_now()).strip() or utc_now(),
                deck_entry_id,
                owner_user_id,
            ),
        )

    def update_deck_entry_cost_basis(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Edit cost basis on an existing inventory row after the fact.

        Accepts `deckEntryID` plus either `costBasisPerUnit` (dollars float) or
        `costBasisPerUnitCents` (int). Pass null to clear. Persists cents and
        keeps the legacy `cost_basis_total` in sync.
        """
        owner_user_id = self._current_owner_user_id()
        deck_entry_id = str(payload.get("deckEntryID") or "").strip()
        if not deck_entry_id:
            raise ValueError("deckEntryID is required")

        explicitly_clearing = (
            "costBasisPerUnit" in payload and payload.get("costBasisPerUnit") is None
        ) or (
            "costBasisPerUnitCents" in payload and payload.get("costBasisPerUnitCents") is None
        )
        cost_basis_per_unit_cents = self._parse_cost_basis_per_unit_cents(payload)
        if cost_basis_per_unit_cents is None and not explicitly_clearing:
            raise ValueError("costBasisPerUnit or costBasisPerUnitCents is required")

        row = self.connection.execute(
            """
            SELECT id, card_id, quantity
            FROM deck_entries
            WHERE id = ? AND owner_user_id = ? LIMIT 1
            """,
            (deck_entry_id, owner_user_id),
        ).fetchone()
        if row is None:
            raise FileNotFoundError("deck entry not found")

        quantity = max(1, int(row["quantity"] or 1))
        updated_at = str(payload.get("updatedAt") or utc_now()).strip() or utc_now()
        currency_code = str(payload.get("currencyCode") or "").strip() or "USD"

        try:
            if cost_basis_per_unit_cents is None:
                # Clear path — null both the cents and the legacy total.
                self.connection.execute(
                    """
                    UPDATE deck_entries
                    SET cost_basis_cents = NULL,
                        cost_basis_total = 0,
                        updated_at = ?
                    WHERE id = ? AND owner_user_id = ?
                    """,
                    (updated_at, deck_entry_id, owner_user_id),
                )
            else:
                dollars_per_unit = round(cost_basis_per_unit_cents / 100.0, 2)
                new_total = round(dollars_per_unit * quantity, 2)
                self.connection.execute(
                    """
                    UPDATE deck_entries
                    SET cost_basis_cents = ?,
                        cost_basis_total = ?,
                        cost_basis_currency_code = ?,
                        updated_at = ?
                    WHERE id = ? AND owner_user_id = ?
                    """,
                    (
                        cost_basis_per_unit_cents,
                        new_total,
                        currency_code,
                        updated_at,
                        deck_entry_id,
                        owner_user_id,
                    ),
                )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        return {
            "deckEntryID": deck_entry_id,
            "cardID": str(row["card_id"] or "").strip(),
            "costBasisPerUnit": (
                None
                if cost_basis_per_unit_cents is None
                else round(cost_basis_per_unit_cents / 100.0, 2)
            ),
            "costBasisPerUnitCents": cost_basis_per_unit_cents,
            "currencyCode": currency_code,
            "updatedAt": updated_at,
        }

    def update_deck_entry_listing(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Set or clear the "Mark as Listed" fields on an inventory row.

        Accepts `deckEntryID` + optional `listingUrl` (string or null),
        `listingPriceCents` (int) or `listingPrice` (dollars float), and
        `listedAt` (ISO string; defaults to now() when listingUrl is being set).

        Passing `listingUrl: null` clears all three listing columns.
        """
        if not self._deck_entry_has_collections_columns():
            raise RuntimeError("collections-redesign schema patch not applied")

        owner_user_id = self._current_owner_user_id()
        deck_entry_id = str(payload.get("deckEntryID") or "").strip()
        if not deck_entry_id:
            raise ValueError("deckEntryID is required")

        listing_url_value: str | None
        if "listingUrl" in payload:
            raw_url = payload.get("listingUrl")
            if raw_url is None:
                listing_url_value = None
            else:
                listing_url_value = str(raw_url).strip() or None
        else:
            raise ValueError("listingUrl is required (use null to clear)")

        listing_price_cents: int | None = None
        if listing_url_value is not None:
            if "listingPriceCents" in payload and payload.get("listingPriceCents") is not None:
                try:
                    listing_price_cents = int(payload.get("listingPriceCents"))
                except (TypeError, ValueError):
                    raise ValueError("listingPriceCents must be an integer") from None
                if listing_price_cents < 0:
                    raise ValueError("listingPriceCents must be non-negative")
            elif "listingPrice" in payload and payload.get("listingPrice") is not None:
                try:
                    dollars = float(payload.get("listingPrice"))
                except (TypeError, ValueError):
                    raise ValueError("listingPrice must be a number") from None
                if dollars < 0:
                    raise ValueError("listingPrice must be non-negative")
                listing_price_cents = int(round(dollars * 100.0))

        if listing_url_value is None:
            listed_at_value: str | None = None
        else:
            listed_at_raw = payload.get("listedAt")
            if listed_at_raw is None or str(listed_at_raw).strip() == "":
                listed_at_value = utc_now()
            else:
                listed_at_value = str(listed_at_raw).strip()

        row = self.connection.execute(
            """
            SELECT id, card_id FROM deck_entries
            WHERE id = ? AND owner_user_id = ? LIMIT 1
            """,
            (deck_entry_id, owner_user_id),
        ).fetchone()
        if row is None:
            raise FileNotFoundError("deck entry not found")

        updated_at = str(payload.get("updatedAt") or utc_now()).strip() or utc_now()
        try:
            self.connection.execute(
                """
                UPDATE deck_entries
                SET listing_url = ?,
                    listing_price_cents = ?,
                    listed_at = ?,
                    updated_at = ?
                WHERE id = ? AND owner_user_id = ?
                """,
                (
                    listing_url_value,
                    listing_price_cents,
                    listed_at_value,
                    updated_at,
                    deck_entry_id,
                    owner_user_id,
                ),
            )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        return {
            "deckEntryID": deck_entry_id,
            "cardID": str(row["card_id"] or "").strip(),
            "listingUrl": listing_url_value,
            "listingPriceCents": listing_price_cents,
            "listedAt": listed_at_value,
            "updatedAt": updated_at,
        }

    def portfolio_insights(self) -> dict[str, Any]:
        """Aggregate inventory + sales metrics for the Insights screen.

        Returned shape matches the `insights` key the client merges into
        `PortfolioDashboard`. All money values are dollars (floats), all counts
        are ints. Fields that have no meaningful value yet (e.g. no sales)
        return 0 for sums/counts and null for derived ratios/single records.
        """
        owner_user_id = self._current_owner_user_id()
        has_columns = self._deck_entry_has_collections_columns()

        # Calendar-month bounds for "this month" aggregates.
        now_utc = datetime.now(timezone.utc)
        month_start = datetime(now_utc.year, now_utc.month, 1, tzinfo=timezone.utc)
        month_start_iso = month_start.isoformat()
        # Previous calendar-month bounds for MoM deltas (handle Jan -> Dec wrap).
        if now_utc.month == 1:
            prev_month_start = datetime(now_utc.year - 1, 12, 1, tzinfo=timezone.utc)
        else:
            prev_month_start = datetime(now_utc.year, now_utc.month - 1, 1, tzinfo=timezone.utc)

        # ---- Inventory aggregates ----
        if has_columns:
            inventory_rows = self.connection.execute(
                """
                SELECT
                    deck_entries.id,
                    deck_entries.card_id,
                    deck_entries.quantity,
                    deck_entries.cost_basis_cents,
                    deck_entries.cost_basis_total,
                    deck_entries.listing_url,
                    deck_entries.listing_price_cents,
                    deck_entries.listed_at
                FROM deck_entries
                WHERE owner_user_id = ?
                  AND quantity > 0
                """,
                (owner_user_id,),
            ).fetchall()
        else:
            inventory_rows = self.connection.execute(
                """
                SELECT
                    deck_entries.id,
                    deck_entries.card_id,
                    deck_entries.quantity,
                    deck_entries.cost_basis_total
                FROM deck_entries
                WHERE owner_user_id = ?
                  AND quantity > 0
                """,
                (owner_user_id,),
            ).fetchall()

        total_cost_basis_cents = 0
        unrealized_gain_cents = 0
        tracked_inventory_count = 0
        active_listings = 0
        unlisted_inventory = 0
        listing_price_with_value_count = 0
        listing_price_cents_sum = 0

        # Pull market-price snapshots so we can derive unrealized gain.
        inventory_card_ids = [str(row["card_id"] or "").strip() for row in inventory_rows]
        price_snapshot_rows = (
            self._price_snapshot_rows_by_card_id(inventory_card_ids)
            if inventory_card_ids
            else {}
        )

        for row in inventory_rows:
            quantity = max(0, int(row["quantity"] or 0))
            if quantity <= 0:
                continue
            card_id = str(row["card_id"] or "").strip()

            # Resolve a per-unit market price (cents) from the snapshot row.
            snapshot = price_snapshot_rows.get(card_id) if card_id else None
            market_price_dollars: float | None = None
            if snapshot is not None:
                for key in (
                    "default_raw_market_price",
                    "default_raw_mid_price",
                    "default_raw_low_price",
                    "default_raw_trend_price",
                ):
                    try:
                        value = snapshot[key]
                    except (KeyError, IndexError):
                        value = None
                    if isinstance(value, (int, float)) and value > 0:
                        market_price_dollars = float(value)
                        break

            cost_basis_per_unit_cents: int | None = None
            if has_columns and row["cost_basis_cents"] is not None:
                try:
                    cost_basis_per_unit_cents = int(row["cost_basis_cents"])
                except (TypeError, ValueError):
                    cost_basis_per_unit_cents = None
            elif row["cost_basis_total"] is not None:
                try:
                    total = float(row["cost_basis_total"] or 0.0)
                except (TypeError, ValueError):
                    total = 0.0
                if total > 0 and quantity > 0:
                    cost_basis_per_unit_cents = int(round((total / quantity) * 100.0))

            if cost_basis_per_unit_cents is not None and cost_basis_per_unit_cents > 0:
                tracked_inventory_count += 1
                row_basis_cents = cost_basis_per_unit_cents * quantity
                total_cost_basis_cents += row_basis_cents
                if market_price_dollars is not None:
                    market_cents = int(round(market_price_dollars * 100.0)) * quantity
                    unrealized_gain_cents += market_cents - row_basis_cents

            if has_columns:
                listing_url = str(row["listing_url"] or "").strip() if row["listing_url"] is not None else ""
                if listing_url:
                    active_listings += 1
                    if row["listing_price_cents"] is not None:
                        try:
                            listing_price_cents_sum += int(row["listing_price_cents"])
                            listing_price_with_value_count += 1
                        except (TypeError, ValueError):
                            pass
                else:
                    unlisted_inventory += 1
            else:
                unlisted_inventory += 1

        total_inventory_rows = active_listings + unlisted_inventory
        listing_rate = (
            round(active_listings / total_inventory_rows, 4)
            if total_inventory_rows > 0
            else 0.0
        )
        avg_listing_value_dollars = (
            round((listing_price_cents_sum / listing_price_with_value_count) / 100.0, 2)
            if listing_price_with_value_count > 0
            else None
        )

        inventory_added_this_month_row = self.connection.execute(
            """
            SELECT COUNT(*) AS added_count
            FROM deck_entries
            WHERE owner_user_id = ?
              AND quantity > 0
              AND added_at >= ?
            """,
            (owner_user_id, month_start_iso),
        ).fetchone()
        inventory_added_this_month = (
            int(inventory_added_this_month_row["added_count"] or 0)
            if inventory_added_this_month_row is not None
            else 0
        )

        # ---- Sales aggregates ----
        sale_select_columns = """
            sale_events.id,
            sale_events.deck_entry_id,
            sale_events.card_id,
            sale_events.quantity,
            sale_events.unit_price,
            sale_events.total_price,
            sale_events.currency_code,
            sale_events.cost_basis_total,
            sale_events.sold_at,
            sale_events.paid_at,
            sale_events.voided_at,
            deck_entries.grader,
            deck_entries.grade,
            deck_entries.condition
        """
        if has_columns:
            sale_select_columns += """,
            sale_events.cost_basis_per_unit_cents,
            sale_events.profit_cents
            """
        sale_rows = self.connection.execute(
            f"""
            SELECT {sale_select_columns}
            FROM sale_events
            LEFT JOIN deck_entries ON deck_entries.id = sale_events.deck_entry_id
            WHERE sale_events.owner_user_id = ?
              AND COALESCE(sale_events.sale_source, 'manual') != 'inventory_adjustment'
              AND (sale_events.voided_at IS NULL OR TRIM(sale_events.voided_at) = '')
            ORDER BY sale_events.sold_at DESC, sale_events.id DESC
            """,
            (owner_user_id,),
        ).fetchall()

        total_sales = 0
        total_revenue_cents = 0
        total_expense_cents = 0
        total_profit_cents = 0

        monthly_revenue_cents = 0
        monthly_expense_cents = 0
        monthly_profit_cents = 0
        monthly_sales_count = 0
        prev_monthly_revenue_cents = 0
        prev_monthly_profit_cents = 0
        sales_with_unit_price = 0
        sales_unit_price_sum_cents = 0
        days_to_sell_sum = 0
        days_to_sell_count = 0

        best_return_sale: dict[str, Any] | None = None
        best_return_profit_cents: int | None = None
        monthly_sale_rows: list[tuple[int, sqlite3.Row]] = []  # (revenue_cents, row)

        # Pull deck-entry added_at separately for avg-days-to-sell.
        deck_added_at_lookup: dict[str, str] = {}
        if sale_rows:
            deck_ids = [str(r["deck_entry_id"] or "").strip() for r in sale_rows]
            deck_ids = [d for d in deck_ids if d]
            if deck_ids:
                placeholders = ",".join(["?"] * len(deck_ids))
                rows_added_at = self.connection.execute(
                    f"SELECT id, added_at FROM deck_entries WHERE id IN ({placeholders})",
                    deck_ids,
                ).fetchall()
                for r in rows_added_at:
                    deck_added_at_lookup[str(r["id"] or "").strip()] = str(r["added_at"] or "").strip()

        for row in sale_rows:
            quantity = max(1, int(row["quantity"] or 1))
            try:
                unit_price = float(row["unit_price"]) if row["unit_price"] is not None else None
            except (TypeError, ValueError):
                unit_price = None
            try:
                total_price = float(row["total_price"]) if row["total_price"] is not None else (
                    unit_price * quantity if unit_price is not None else 0.0
                )
            except (TypeError, ValueError):
                total_price = 0.0

            revenue_cents = int(round(total_price * 100.0))
            total_sales += 1
            total_revenue_cents += revenue_cents
            if unit_price is not None:
                sales_with_unit_price += 1
                sales_unit_price_sum_cents += int(round(unit_price * 100.0))

            profit_cents_value: int | None = None
            cost_basis_per_unit_cents_value: int | None = None
            if has_columns:
                if row["profit_cents"] is not None:
                    try:
                        profit_cents_value = int(row["profit_cents"])
                    except (TypeError, ValueError):
                        profit_cents_value = None
                if row["cost_basis_per_unit_cents"] is not None:
                    try:
                        cost_basis_per_unit_cents_value = int(row["cost_basis_per_unit_cents"])
                    except (TypeError, ValueError):
                        cost_basis_per_unit_cents_value = None
            # Fallback: derive from legacy cost_basis_total
            if cost_basis_per_unit_cents_value is None and row["cost_basis_total"] is not None:
                try:
                    legacy_cost_basis_total = float(row["cost_basis_total"] or 0.0)
                except (TypeError, ValueError):
                    legacy_cost_basis_total = 0.0
                if legacy_cost_basis_total > 0:
                    cost_basis_per_unit_cents_value = int(
                        round((legacy_cost_basis_total / quantity) * 100.0)
                    )
            if profit_cents_value is None and cost_basis_per_unit_cents_value is not None and unit_price is not None:
                unit_price_cents = int(round(unit_price * 100.0))
                profit_cents_value = (unit_price_cents - cost_basis_per_unit_cents_value) * quantity

            if cost_basis_per_unit_cents_value is not None:
                expense_cents = cost_basis_per_unit_cents_value * quantity
                total_expense_cents += expense_cents
            else:
                expense_cents = 0

            if profit_cents_value is not None:
                total_profit_cents += profit_cents_value
                if best_return_profit_cents is None or abs(profit_cents_value) > abs(best_return_profit_cents):
                    best_return_profit_cents = profit_cents_value
                    best_return_sale = self._insights_recent_sale_payload(row)

            sold_at = self._coerce_utc_datetime(str(row["sold_at"] or "").strip())
            if sold_at is not None and sold_at >= month_start:
                monthly_sales_count += 1
                monthly_revenue_cents += revenue_cents
                if cost_basis_per_unit_cents_value is not None:
                    monthly_expense_cents += expense_cents
                if profit_cents_value is not None:
                    monthly_profit_cents += profit_cents_value
                monthly_sale_rows.append((revenue_cents, row))
            elif sold_at is not None and sold_at >= prev_month_start and sold_at < month_start:
                prev_monthly_revenue_cents += revenue_cents
                if profit_cents_value is not None:
                    prev_monthly_profit_cents += profit_cents_value

            # Days-to-sell
            deck_entry_id = str(row["deck_entry_id"] or "").strip()
            added_at_str = deck_added_at_lookup.get(deck_entry_id, "")
            added_at_dt = self._coerce_utc_datetime(added_at_str) if added_at_str else None
            if sold_at is not None and added_at_dt is not None:
                delta_days = max(0, (sold_at - added_at_dt).days)
                days_to_sell_sum += delta_days
                days_to_sell_count += 1

        # Top sellers this month: rank monthly sales by revenue_cents desc.
        monthly_sale_rows.sort(key=lambda pair: pair[0], reverse=True)
        top_sellers_this_month = [
            payload
            for payload in (
                self._insights_recent_sale_payload(row) for _, row in monthly_sale_rows[:5]
            )
            if payload is not None
        ]

        avg_sales_price_dollars = (
            round((sales_unit_price_sum_cents / sales_with_unit_price) / 100.0, 2)
            if sales_with_unit_price > 0
            else None
        )
        avg_days_to_sell = (
            round(days_to_sell_sum / days_to_sell_count, 2)
            if days_to_sell_count > 0
            else None
        )
        monthly_margin = (
            round(monthly_profit_cents / monthly_revenue_cents, 4)
            if monthly_revenue_cents > 0
            else None
        )
        # MoM % change. Null when the prior month had no activity so the
        # client can hide the trend pill rather than show a misleading
        # divide-by-zero number.
        monthly_revenue_change_percent: float | None = (
            round((monthly_revenue_cents - prev_monthly_revenue_cents) / prev_monthly_revenue_cents, 4)
            if prev_monthly_revenue_cents > 0
            else None
        )
        monthly_profit_change_percent: float | None = (
            round((monthly_profit_cents - prev_monthly_profit_cents) / prev_monthly_profit_cents, 4)
            if prev_monthly_profit_cents > 0
            else None
        )
        overall_roi = (
            round(total_profit_cents / total_expense_cents, 4)
            if total_expense_cents > 0
            else None
        )

        def _cents_to_dollars(value: int) -> float:
            return round(value / 100.0, 2)

        return {
            "totalCostBasis": _cents_to_dollars(total_cost_basis_cents),
            "unrealizedGain": _cents_to_dollars(unrealized_gain_cents),
            "trackedInventoryCount": tracked_inventory_count,
            "inventoryAddedThisMonth": inventory_added_this_month,
            "activeListings": active_listings,
            "unlistedInventory": unlisted_inventory,
            "listingRate": listing_rate,
            "avgListingValue": avg_listing_value_dollars,
            "monthlyRevenue": _cents_to_dollars(monthly_revenue_cents),
            "monthlyProfit": _cents_to_dollars(monthly_profit_cents),
            "monthlyExpense": _cents_to_dollars(monthly_expense_cents),
            "monthlyMargin": monthly_margin,
            "monthlyRevenueChangePercent": monthly_revenue_change_percent,
            "monthlyProfitChangePercent": monthly_profit_change_percent,
            "numSales": monthly_sales_count,
            "avgSalesPrice": avg_sales_price_dollars,
            "avgDaysToSell": avg_days_to_sell,
            "unsoldListings": active_listings,
            "totalSales": total_sales,
            "totalRevenue": _cents_to_dollars(total_revenue_cents),
            "totalExpense": _cents_to_dollars(total_expense_cents),
            "totalProfit": _cents_to_dollars(total_profit_cents),
            "overallROI": overall_roi,
            "bestReturnOfAllTime": best_return_sale,
            "topSellersThisMonth": top_sellers_this_month,
            "refreshedAt": utc_now(),
        }

    def prewarm_portfolio_dashboards(
        self, *, delay_seconds: float = 0.0, source: str = "startup"
    ) -> dict[str, Any]:
        """Warm the per-owner dashboard/inventory/performance caches.

        After a reboot the OS page cache is empty and the multi-GB DB lives on a
        slow disk, so the first dashboard refresh cold-reads owner rows and can
        exceed the client timeout (the exact failure seen after a VM resize).
        The daily price sync has the same effect: it moves the global
        MAX(price_date), which invalidates every owner's version-token caches,
        so the first user per owner afterwards pays a ~24.5s cold recompute.
        We proactively compute the payloads clients actually request —
        portfolio_dashboard(range=1W), deck_entries(limit=200), and
        portfolio_performance() — populating both the in-process caches AND the
        OS page cache for their rows, so the first real refresh is a ~1ms cache
        hit. Runs in a background daemon thread on its own connection; every
        owner/section is best-effort and never blocks request serving or
        startup. Tunable via PORTFOLIO_DASHBOARD_PREWARM* env vars."""
        if delay_seconds > 0:
            # Let the server finish coming up (and the visual prewarm grab the
            # disk first) before we start cold-reading owner rows.
            threading.Event().wait(delay_seconds)

        started_at = perf_counter()
        max_owners_raw = os.environ.get(PORTFOLIO_DASHBOARD_PREWARM_MAX_OWNERS_ENV)
        try:
            max_owners = (
                max(1, int(max_owners_raw))
                if max_owners_raw
                else DEFAULT_PORTFOLIO_DASHBOARD_PREWARM_MAX_OWNERS
            )
        except (TypeError, ValueError):
            max_owners = DEFAULT_PORTFOLIO_DASHBOARD_PREWARM_MAX_OWNERS

        owners: list[str] = []
        try:
            rows = self.connection.execute(
                """
                SELECT owner_user_id, COUNT(*) AS entry_count
                FROM deck_entries
                WHERE owner_user_id IS NOT NULL AND TRIM(owner_user_id) != ''
                GROUP BY owner_user_id
                ORDER BY entry_count DESC
                LIMIT ?
                """,
                (max_owners,),
            ).fetchall()
            owners = [str(row["owner_user_id"]) for row in rows]
        except Exception:  # noqa: BLE001 - prewarm is best-effort, never fatal
            traceback.print_exc()

        warmed_dashboards = 0
        warmed_entries = 0
        warmed_performance = 0
        warmed_favorites = 0
        for owner_user_id in owners:
            try:
                identity = RequestIdentity(
                    user_id=owner_user_id, auth_source="startup_prewarm"
                )
                with self.request_identity_context(identity):
                    # Warm the exact cache keys clients request. Each section is
                    # independently best-effort: one failing must not stop the
                    # others (or the remaining owners).
                    try:
                        # Collection screen opens on range=1W → key (owner, tz, "1W").
                        self.portfolio_dashboard(range_key="1W")
                        warmed_dashboards += 1
                    except Exception:  # noqa: BLE001 - best-effort per section
                        traceback.print_exc()
                    try:
                        # Inventory grid call → key (owner, 200, 0, False, False, True).
                        self.deck_entries(limit=200, offset=0)
                        warmed_entries += 1
                    except Exception:  # noqa: BLE001 - best-effort per section
                        traceback.print_exc()
                    try:
                        # Insights table → key (owner, "performance").
                        self.portfolio_performance()
                        warmed_performance += 1
                    except Exception:  # noqa: BLE001 - best-effort per section
                        traceback.print_exc()
                    try:
                        # Wishlist list call → key (owner, "card_favorites", 200, 0).
                        # Uncached+unwarmed this cold-read the sparkline batch and
                        # timed clients out post-deploy (2026-07-16).
                        self.card_favorites(limit=200, offset=0)
                        warmed_favorites += 1
                    except Exception:  # noqa: BLE001 - best-effort per section
                        traceback.print_exc()
            except Exception:  # noqa: BLE001 - one owner failing must not stop the rest
                traceback.print_exc()

        result = {
            "ownerCount": len(owners),
            "warmedDashboards": warmed_dashboards,
            "warmedEntries": warmed_entries,
            "warmedPerformance": warmed_performance,
            "warmedFavorites": warmed_favorites,
            "elapsedMs": round((perf_counter() - started_at) * 1000.0, 1),
        }
        self._emit_structured_log(
            {
                "severity": "INFO",
                "event": "portfolio_dashboard_prewarm",
                "source": source,
                **result,
            }
        )
        return result

    def backfill_added_baselines(
        self,
        *,
        dry_run: bool = False,
        source: str = "ops",
        repair_graded_variantless: bool = False,
    ) -> dict[str, Any]:
        """One-time backfill of the "since you added it" baseline columns
        (deck_entries / card_favorites ``added_market_price`` +
        ``added_market_date``) for rows that predate write-time capture.

        For every NULL-baseline row, resolves the market price nearest ON OR
        BEFORE the add/favorite date (grouped by add-date so each date is ONE
        batched history read), with the same per-entry context resolution the
        display uses (`_portfolio_history_price_row_from_history_row`). Rows
        added before tracking began — or whose card's history starts later —
        fall back to the card's EARLIEST tracked price, with
        ``added_market_date`` carrying that honest date. Nothing resolvable →
        the baseline stays NULL (the UI renders nothing).

        Guarded by the ``added_baseline_backfilled`` runtime flag so it runs
        exactly once; ``dry_run`` computes and logs counts, writes nothing, and
        does NOT set the flag. Runs on a background daemon thread (its own
        thread-local connection); best-effort, never raises out.

        ``repair_graded_variantless`` re-runs ONLY the variantless slab rows,
        overwriting their existing baselines (and bypassing the one-shot flag):
        the graded resolver's variantless default used to fall through to
        alphabetical variant order, so baselines captured before the
        base-printing-first fix (Suicune me2-26 "Gamestop Stamp" $589 vs
        "Holofoil" $106.97, 2026-07-16) were computed against the wrong
        printing. The repair recomputes them at the original baseline date with
        the fixed resolver."""
        started_at = perf_counter()
        summary: dict[str, Any] = {
            "dryRun": bool(dry_run),
            "repairGradedVariantless": bool(repair_graded_variantless),
            "skipped": False,
            "deckEntriesResolved": 0,
            "deckEntriesFallbackEarliest": 0,
            "deckEntriesUnresolved": 0,
            "favoritesResolved": 0,
            "favoritesFallbackEarliest": 0,
            "favoritesUnresolved": 0,
        }
        try:
            already = runtime_setting(self.connection, ADDED_BASELINE_BACKFILL_FLAG)
            if already is not None and not dry_run and not repair_graded_variantless:
                summary["skipped"] = True
                self._emit_structured_log(
                    {
                        "severity": "INFO",
                        "event": "added_baseline_backfill",
                        "source": source,
                        **summary,
                    }
                )
                return summary

            earliest_priced_date = self._portfolio_earliest_priced_date()

            # (kind, update_key, card_id, entry_ctx, condition, add_date_iso)
            jobs: list[dict[str, Any]] = []
            if repair_graded_variantless:
                # Repair scope: variantless slabs whose baseline exists but was
                # resolved before the base-printing-first fix. Recompute at the
                # ORIGINAL baseline date (added_market_date) so the honest date
                # semantics are preserved; the UPDATE below overwrites.
                deck_rows = self.connection.execute(
                    """
                    SELECT id, card_id, item_kind, grader, grade, variant_name, condition,
                           COALESCE(added_market_date, added_at) AS added_at
                    FROM deck_entries
                    WHERE added_market_price IS NOT NULL
                      AND item_kind = 'slab'
                      AND (variant_name IS NULL OR TRIM(variant_name) = '')
                    """
                ).fetchall()
            else:
                deck_rows = self.connection.execute(
                    """
                    SELECT id, card_id, item_kind, grader, grade, variant_name, condition, added_at
                    FROM deck_entries
                    WHERE added_market_price IS NULL
                    """
                ).fetchall()
            for row in deck_rows:
                jobs.append(
                    {
                        "kind": "deck",
                        "update_key": str(row["id"]),
                        "card_id": str(row["card_id"] or "").strip(),
                        "item_kind": str(row["item_kind"] or "").strip().lower(),
                        "grader": str(row["grader"] or "").strip() or None,
                        "grade": str(row["grade"] or "").strip() or None,
                        "variant_name": str(row["variant_name"] or "").strip() or None,
                        "condition": self._normalized_deck_card_condition(row["condition"]),
                        "added_at": str(row["added_at"] or "").strip(),
                    }
                )
            favorite_rows = self.connection.execute(
                """
                SELECT owner_user_id, card_id, created_at
                FROM card_favorites
                WHERE added_market_price IS NULL
                """
            ).fetchall() if not repair_graded_variantless else []
            for row in favorite_rows:
                # Favorites carry no grade/condition of their own; backfill on the
                # default raw lane (the lane the wishlist prices unowned rows in).
                jobs.append(
                    {
                        "kind": "favorite",
                        "update_key": (str(row["owner_user_id"] or ""), str(row["card_id"] or "")),
                        "card_id": str(row["card_id"] or "").strip(),
                        "item_kind": "raw",
                        "grader": None,
                        "grade": None,
                        "variant_name": None,
                        "condition": None,
                        "added_at": str(row["created_at"] or "").strip(),
                    }
                )

            def _resolve_from_row(job: dict[str, Any], history_row: Any) -> tuple[float | None, str | None]:
                if history_row is None:
                    return None, None
                pricing = self._portfolio_history_price_row_from_history_row(
                    {
                        "cardID": job["card_id"],
                        "itemKind": "slab" if job["item_kind"] == "slab" else "raw",
                        "grader": job["grader"],
                        "grade": job["grade"],
                        "variantName": job["variant_name"],
                    },
                    row=history_row,
                    condition_code=self._portfolio_condition_code(job["condition"]),
                )
                price = self._history_primary_price_value(pricing)
                if price is None:
                    return None, None
                return round(float(price), 2), str(history_row["price_date"] or "").strip() or None

            # Pass 1: nearest-on-or-before the add date, ONE batched read per
            # distinct add-date (add dates before tracking began clamp to the
            # earliest tracked date so the <= query can land on it).
            jobs_by_cutoff: dict[str, list[dict[str, Any]]] = {}
            for job in jobs:
                if not job["card_id"]:
                    continue
                add_date_raw = job["added_at"][:10]
                try:
                    add_date = date.fromisoformat(add_date_raw)
                except ValueError:
                    add_date = None
                if add_date is None:
                    cutoff_iso = None
                elif earliest_priced_date is not None and add_date < earliest_priced_date:
                    cutoff_iso = earliest_priced_date.isoformat()
                else:
                    cutoff_iso = add_date.isoformat()
                if cutoff_iso is None:
                    continue
                jobs_by_cutoff.setdefault(cutoff_iso, []).append(job)

            resolved: dict[int, tuple[float, str | None]] = {}
            for cutoff_iso, cutoff_jobs in sorted(jobs_by_cutoff.items()):
                rows_by_card = self._price_history_rows_on_or_before_by_card_id(
                    [job["card_id"] for job in cutoff_jobs],
                    cutoff_date_iso=cutoff_iso,
                )
                for job in cutoff_jobs:
                    price, price_date = _resolve_from_row(job, rows_by_card.get(job["card_id"]))
                    if price is not None:
                        resolved[id(job)] = (price, price_date)

            # Pass 2: still-unresolved rows (card history starts after the add
            # date) fall back to the card's earliest tracked price.
            fallback_jobs = [job for job in jobs if job["card_id"] and id(job) not in resolved]
            fallback_ids: set[int] = set()
            if fallback_jobs:
                earliest_rows_by_card = self._earliest_price_history_rows_by_card_id(
                    [job["card_id"] for job in fallback_jobs]
                )
                for job in fallback_jobs:
                    price, price_date = _resolve_from_row(
                        job, earliest_rows_by_card.get(job["card_id"])
                    )
                    if price is not None:
                        resolved[id(job)] = (price, price_date)
                        fallback_ids.add(id(job))

            for job in jobs:
                hit = resolved.get(id(job))
                prefix = "deckEntries" if job["kind"] == "deck" else "favorites"
                if hit is None:
                    summary[f"{prefix}Unresolved"] += 1
                    continue
                summary[f"{prefix}Resolved"] += 1
                if id(job) in fallback_ids:
                    summary[f"{prefix}FallbackEarliest"] += 1
                if dry_run:
                    continue
                price, price_date = hit
                if job["kind"] == "deck":
                    if repair_graded_variantless:
                        # Repair overwrites the wrong-variant baseline in place.
                        self.connection.execute(
                            """
                            UPDATE deck_entries
                            SET added_market_price = ?, added_market_date = ?
                            WHERE id = ?
                            """,
                            (price, price_date, job["update_key"]),
                        )
                    else:
                        self.connection.execute(
                            """
                            UPDATE deck_entries
                            SET added_market_price = ?, added_market_date = ?
                            WHERE id = ?
                              AND added_market_price IS NULL
                            """,
                            (price, price_date, job["update_key"]),
                        )
                else:
                    owner_user_id, card_id = job["update_key"]
                    self.connection.execute(
                        """
                        UPDATE card_favorites
                        SET added_market_price = ?, added_market_date = ?
                        WHERE owner_user_id = ?
                          AND card_id = ?
                          AND added_market_price IS NULL
                        """,
                        (price, price_date, owner_user_id, card_id),
                    )

            if not dry_run:
                if not repair_graded_variantless:
                    # Repair runs are re-runnable; only the original one-time
                    # backfill sets the one-shot flag.
                    upsert_runtime_setting(
                        self.connection,
                        key=ADDED_BASELINE_BACKFILL_FLAG,
                        value={"at": utc_now(), "source": source, **summary},
                    )
                self.connection.commit()
                # The baseline UPDATEs intentionally don't touch updated_at, so
                # the version-token deck_entries cache would keep serving null
                # sinceAdded fields until the next mutation/daily sync. Drop it
                # so the next list request recomputes with the new baselines.
                with self._dashboard_cache_locks_guard:
                    self._deck_entries_cache.clear()
        except Exception:  # noqa: BLE001 - the backfill is best-effort ops tooling
            traceback.print_exc()
            try:
                self.connection.rollback()
            except Exception:  # noqa: BLE001
                pass
        summary["elapsedMs"] = round((perf_counter() - started_at) * 1000.0, 1)
        self._emit_structured_log(
            {
                "severity": "INFO",
                "event": "added_baseline_backfill",
                "source": source,
                **summary,
            }
        )
        return summary

    def portfolio_dashboard(
        self, *, time_zone_name: str | None = None, range_key: str | None = None
    ) -> dict[str, Any]:
        """Cache-and-dogpile wrapper over the heavy dashboard computation.

        ``range_key`` (the chart's open range, e.g. "1W"/"ALL") scopes the heavy
        history/ledger work to just that range; the client fetches other ranges
        on demand. ``None`` computes all six ranges (legacy / prewarm). The cache
        is keyed per (owner, tz, range) so each range is computed at most once per
        data-version.

        The computed dashboard is a pure function of the owner's portfolio data
        plus the latest daily price snapshot — it only changes when the user
        mutates their collection or the daily Scrydex sync runs. So we key a
        per-owner cache on a cheap data-version token (a few indexed MAX/COUNT
        reads) that changes exactly when any of those inputs change: a hit serves
        the prior payload in ~1ms instead of re-running ~1.5s of GIL-bound Python.

        A per-owner lock makes a concurrent burst (e.g. 30 users hitting the same
        cold cache) compute ONCE and share the result instead of stampeding the
        single-process backend. Every call emits a structured timing log so slow
        requests are diagnosable in `journalctl -u spotlight-backend`."""
        owner_user_id = self._current_owner_user_id()
        resolved_tz = time_zone_name or "America/Los_Angeles"
        started_at = perf_counter()
        try:
            version = self._portfolio_dashboard_version_token(owner_user_id, resolved_tz)
        except Exception:  # noqa: BLE001 - never let cache bookkeeping break the dashboard
            traceback.print_exc()
            version = None

        cache_key = (owner_user_id, resolved_tz, range_key or "all")
        if version is not None:
            cached = self._dashboard_cache.get(cache_key)
            if cached is not None and cached[0] == version:
                self._log_dashboard_timing(started_at, outcome="hit")
                return cached[1]

        lock = self._dashboard_cache_lock_for(cache_key)
        with lock:
            # Re-check after acquiring: another thread in the same burst may have
            # already computed this exact version while we waited on the lock.
            if version is not None:
                cached = self._dashboard_cache.get(cache_key)
                if cached is not None and cached[0] == version:
                    self._log_dashboard_timing(started_at, outcome="hit_after_wait")
                    return cached[1]
            payload = self._compute_portfolio_dashboard(
                time_zone_name=resolved_tz,
                range_keys=[range_key] if range_key else None,
            )
            if version is not None:
                self._store_dashboard_cache(cache_key, version, payload)
            self._log_dashboard_timing(started_at, outcome="miss")
            return payload

    def _portfolio_dashboard_version_token(
        self, owner_user_id: str, resolved_tz: str
    ) -> str:
        """Cheap fingerprint of every input the dashboard depends on, so the cache
        auto-invalidates the instant any of them change — no manual invalidation
        hooks to forget. All reads hit existing indexes (owner_user_id / price
        date), so this is a few ms, not a scan. Components: the owner's deck
        entries (MAX(updated_at)+COUNT catches add/edit/sell/delete), their events
        and sales (append-only, MAX(created_at)+COUNT), and the latest global
        price snapshot date (changes when the daily sync lands new prices)."""
        row = self.connection.execute(
            """
            SELECT
                (SELECT MAX(updated_at) FROM deck_entries WHERE owner_user_id = ?) AS de_updated,
                (SELECT COUNT(*) FROM deck_entries WHERE owner_user_id = ?) AS de_count,
                (SELECT MAX(created_at) FROM deck_entry_events WHERE owner_user_id = ?) AS ev_created,
                (SELECT COUNT(*) FROM deck_entry_events WHERE owner_user_id = ?) AS ev_count,
                (SELECT MAX(created_at) FROM sale_events WHERE owner_user_id = ?) AS sale_created,
                (SELECT COUNT(*) FROM sale_events WHERE owner_user_id = ?) AS sale_count,
                (SELECT MAX(price_date) FROM card_price_history_daily) AS price_date
            """,
            (
                owner_user_id,
                owner_user_id,
                owner_user_id,
                owner_user_id,
                owner_user_id,
                owner_user_id,
            ),
        ).fetchone()
        parts = [resolved_tz] + [str(row[key]) for key in row.keys()] if row is not None else [resolved_tz]
        return "|".join(parts)

    def _dashboard_cache_lock_for(self, cache_key: tuple[str, str, str]) -> "threading.Lock":
        with self._dashboard_cache_locks_guard:
            lock = self._dashboard_cache_locks.get(cache_key)
            if lock is None:
                lock = threading.Lock()
                self._dashboard_cache_locks[cache_key] = lock
            return lock

    def _store_dashboard_cache(
        self, cache_key: tuple[str, str, str], version: str, payload: dict[str, Any]
    ) -> None:
        with self._dashboard_cache_locks_guard:
            # Simple bounded LRU-ish cap so the cache can't grow without limit as
            # users come and go (one ~265KB payload per owner). 256 owners is far
            # more than the concurrent working set; evict the oldest on overflow.
            if (
                cache_key not in self._dashboard_cache
                and len(self._dashboard_cache) >= self._dashboard_cache_max_entries
            ):
                self._dashboard_cache.pop(next(iter(self._dashboard_cache)), None)
            self._dashboard_cache[cache_key] = (version, payload)

    def _log_dashboard_timing(self, started_at: float, *, outcome: str) -> None:
        elapsed_ms = round((perf_counter() - started_at) * 1000.0, 1)
        self._emit_structured_log(
            {
                "severity": "INFO",
                "event": "portfolio_dashboard_request",
                "outcome": outcome,
                "elapsedMs": elapsed_ms,
                "slow": elapsed_ms >= 5000.0,
            }
        )

    def _compute_portfolio_dashboard(
        self, *, time_zone_name: str | None = None, range_keys: list[str] | None = None
    ) -> dict[str, Any]:
        """Single-call portfolio dashboard: bundles inventory, every history and
        ledger range, and insights into one response so the client makes ONE
        request instead of ~14. Each section is computed independently; one that
        raises is reported in ``sections`` as an error and returned as null
        instead of failing the whole payload (the client keeps its last good
        value for that slice). The per-range args mirror what the client used to
        send when it fanned out (see repository.loadPortfolioDashboard)."""
        resolved_tz = time_zone_name or "America/Los_Angeles"
        sections: dict[str, str] = {}

        def _section(label: str, fn: Any) -> Any:
            try:
                value = fn()
                sections[label] = "ok"
                return value
            except Exception as error:  # noqa: BLE001 - degrade per-section, never 500 the whole dashboard
                traceback.print_exc()
                sections[label] = f"error: {error}"
                return None

        inventory = _section("inventory", lambda: self.deck_entries(limit=200, offset=0))
        insights = _section("insights", self.portfolio_insights)

        # Client range key -> backend range_label (matches mapRangeToBackend and
        # the ledger range args in the old client fan-out).
        range_labels = {
            "1W": "1W",
            "1M": "30D",
            "3M": "90D",
            "YTD": "YTD",
            "1Y": "1Y",
            "ALL": "ALL",
        }
        # Only compute the requested range(s) — the client fetches the rest on
        # demand. Unknown keys are ignored; None means all six (legacy/prewarm).
        if range_keys is None:
            keys_to_compute = list(range_labels.keys())
            computed_labels: list[str] | None = None  # full history (all-six/prewarm)
        else:
            keys_to_compute = [key for key in range_keys if key in range_labels]
            computed_labels = [range_labels[key] for key in keys_to_compute]

        # Load the range-independent history inputs (entries, events, daily prices)
        # ONCE and share them across the computed range(s) instead of re-reading
        # per range. Scoped to the widest requested range's window so the open
        # Collection range reads a small window, not all of history. If this load
        # fails, each deck_history call falls back to fetching its own
        # (shared_inputs=None), so correctness is preserved either way.
        try:
            history_shared_inputs = self._load_portfolio_history_shared_inputs(
                time_zone_name=resolved_tz, range_labels=computed_labels
            )
        except Exception:  # noqa: BLE001 - fall back to per-call fetching
            traceback.print_exc()
            history_shared_inputs = None

        ranges: dict[str, Any] = {}
        for key in keys_to_compute:
            label = range_labels[key]
            history = _section(
                f"history.{key}",
                lambda label=label: self.deck_history(
                    days=365,
                    range_label=label,
                    time_zone_name=resolved_tz,
                    shared_inputs=history_shared_inputs,
                ),
            )
            ledger = _section(
                f"ledger.{key}",
                lambda label=label: self.portfolio_ledger(
                    days=365,
                    range_label=label,
                    time_zone_name=resolved_tz,
                    limit=50,
                    offset=0,
                ),
            )
            ranges[key] = {"history": history, "ledger": ledger}

        return {
            "currencyCode": "USD",
            "inventory": inventory,
            "insights": insights,
            "ranges": ranges,
            "sections": sections,
        }

    def _insights_recent_sale_payload(self, row: sqlite3.Row) -> dict[str, Any] | None:
        """Shape a sale row into the RecentSaleRecord-friendly payload the
        Insights screen consumes ("bestReturnOfAllTime", "topSellersThisMonth").

        The client maps this through the same path as
        `loadPortfolioDashboard.recentSales`, so the keys mirror the ledger
        transaction shape.
        """
        card_id = str(row["card_id"] or "").strip()
        if not card_id:
            return None
        card_map = cards_by_ids(self.connection, [card_id])
        card = card_map.get(card_id)
        if card is None:
            return None
        card_payload = self._candidate_base_payload(card, card)

        grader = None
        grade = None
        condition = None
        try:
            grader = str(row["grader"] or "").strip() or None
        except (IndexError, KeyError):
            pass
        try:
            grade = str(row["grade"] or "").strip() or None
        except (IndexError, KeyError):
            pass
        try:
            condition = self._normalized_deck_card_condition(row["condition"])
        except (IndexError, KeyError):
            pass

        slab_context = None
        if grader or grade:
            slab_context = {"grader": grader, "grade": grade}

        try:
            unit_price = float(row["unit_price"]) if row["unit_price"] is not None else None
        except (TypeError, ValueError):
            unit_price = None
        try:
            total_price = float(row["total_price"]) if row["total_price"] is not None else None
        except (TypeError, ValueError):
            total_price = None
        quantity = max(1, int(row["quantity"] or 1))

        cost_basis_per_unit_dollars: float | None = None
        profit_dollars: float | None = None
        try:
            cbpu_cents = row["cost_basis_per_unit_cents"]
        except (IndexError, KeyError):
            cbpu_cents = None
        try:
            profit_cents_raw = row["profit_cents"]
        except (IndexError, KeyError):
            profit_cents_raw = None
        if cbpu_cents is not None:
            try:
                cost_basis_per_unit_dollars = round(float(cbpu_cents) / 100.0, 2)
            except (TypeError, ValueError):
                cost_basis_per_unit_dollars = None
        if profit_cents_raw is not None:
            try:
                profit_dollars = round(float(profit_cents_raw) / 100.0, 2)
            except (TypeError, ValueError):
                profit_dollars = None

        return {
            "id": str(row["id"] or "").strip(),
            "kind": "sell",
            "card": card_payload,
            "slabContext": slab_context,
            "condition": condition,
            "quantity": quantity,
            "unitPrice": unit_price,
            "totalPrice": total_price,
            "currencyCode": str(row["currency_code"] or "").strip() or "USD",
            "occurredAt": str(row["sold_at"] or "").strip(),
            "costBasisPerUnit": cost_basis_per_unit_dollars,
            "profit": profit_dollars,
        }

    def _recompute_deck_entry_cost_basis_total(
        self,
        deck_entry_id: str,
        *,
        currency_code: str | None = None,
        updated_at: str | None = None,
    ) -> float:
        buy_total_row = self.connection.execute(
            """
            SELECT COALESCE(SUM(total_price), 0.0) AS total_price
            FROM deck_entry_events
            WHERE deck_entry_id = ?
              AND event_kind = 'buy'
            """,
            (deck_entry_id,),
        ).fetchone()
        sale_cost_basis_row = self.connection.execute(
            """
            SELECT COALESCE(SUM(cost_basis_total), 0.0) AS cost_basis_total
            FROM sale_events
            WHERE deck_entry_id = ?
            """,
            (deck_entry_id,),
        ).fetchone()

        buy_total = float(buy_total_row["total_price"] or 0.0) if buy_total_row is not None else 0.0
        sold_cost_basis_total = float(sale_cost_basis_row["cost_basis_total"] or 0.0) if sale_cost_basis_row is not None else 0.0
        remaining_cost_basis_total = round(max(0.0, buy_total - sold_cost_basis_total), 2)

        resolved_currency_code = currency_code
        if not resolved_currency_code:
            currency_row = self.connection.execute(
                """
                SELECT currency_code
                FROM deck_entry_events
                WHERE deck_entry_id = ?
                  AND event_kind = 'buy'
                  AND currency_code IS NOT NULL
                  AND TRIM(currency_code) != ''
                ORDER BY created_at DESC, id DESC
                LIMIT 1
                """,
                (deck_entry_id,),
            ).fetchone()
            resolved_currency_code = str(currency_row["currency_code"] or "").strip() or None if currency_row is not None else None

        self.connection.execute(
            """
            UPDATE deck_entries
            SET cost_basis_total = ?,
                cost_basis_currency_code = COALESCE(?, cost_basis_currency_code),
                updated_at = ?
            WHERE id = ?
            """,
            (
                remaining_cost_basis_total,
                resolved_currency_code,
                str(updated_at or utc_now()).strip() or utc_now(),
                deck_entry_id,
            ),
        )
        return remaining_cost_basis_total

    def update_portfolio_buy_price(self, transaction_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        normalized_transaction_id = str(transaction_id or "").strip()
        if not normalized_transaction_id:
            raise ValueError("transactionID is required")

        unit_price_raw = payload.get("unitPrice")
        if unit_price_raw is None or unit_price_raw == "":
            raise ValueError("unitPrice is required")
        try:
            unit_price = float(unit_price_raw)
        except (TypeError, ValueError):
            raise ValueError("unitPrice must be a number") from None
        if unit_price < 0:
            raise ValueError("unitPrice must be non-negative")

        currency_code = str(payload.get("currencyCode") or "").strip() or "USD"
        updated_at = str(payload.get("updatedAt") or utc_now()).strip() or utc_now()

        row = self.connection.execute(
            """
            SELECT deck_entry_id, quantity_delta
            FROM deck_entry_events
            WHERE id = ?
              AND event_kind = 'buy'
              AND owner_user_id = ?
            LIMIT 1
            """,
            (normalized_transaction_id, owner_user_id),
        ).fetchone()
        if row is None:
            raise FileNotFoundError("buy transaction not found")

        quantity = abs(int(row["quantity_delta"] or 0))
        if quantity < 1:
            raise ValueError("buy transaction quantity is invalid")

        total_price = round(unit_price * quantity, 2)
        deck_entry_id = str(row["deck_entry_id"] or "").strip()

        self.connection.execute(
            """
            UPDATE deck_entry_events
            SET unit_price = ?, total_price = ?, currency_code = ?
            WHERE id = ?
              AND owner_user_id = ?
            """,
            (unit_price, total_price, currency_code, normalized_transaction_id, owner_user_id),
        )
        remaining_cost_basis_total = self._recompute_deck_entry_cost_basis_total(
            deck_entry_id,
            currency_code=currency_code,
            updated_at=updated_at,
        )
        self.connection.commit()
        return {
            "transactionID": normalized_transaction_id,
            "deckEntryID": deck_entry_id,
            "unitPrice": round(unit_price, 2),
            "totalPrice": total_price,
            "currencyCode": currency_code,
            "costBasisTotal": remaining_cost_basis_total,
            "updatedAt": updated_at,
        }

    def update_portfolio_sale_price(self, transaction_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        normalized_transaction_id = str(transaction_id or "").strip()
        if not normalized_transaction_id:
            raise ValueError("transactionID is required")

        unit_price_raw = payload.get("unitPrice")
        if unit_price_raw is None or unit_price_raw == "":
            raise ValueError("unitPrice is required")
        try:
            unit_price = float(unit_price_raw)
        except (TypeError, ValueError):
            raise ValueError("unitPrice must be a number") from None
        if unit_price < 0:
            raise ValueError("unitPrice must be non-negative")

        currency_code = str(payload.get("currencyCode") or "").strip() or "USD"
        updated_at = str(payload.get("updatedAt") or utc_now()).strip() or utc_now()

        row = self.connection.execute(
            """
            SELECT id, deck_entry_id, quantity
            FROM sale_events
            WHERE id = ?
              AND owner_user_id = ?
            LIMIT 1
            """,
            (normalized_transaction_id, owner_user_id),
        ).fetchone()
        resolved_transaction_id = normalized_transaction_id
        if row is None:
            fallback_row = self.connection.execute(
                """
                SELECT sale_id
                FROM deck_entry_events
                WHERE id = ?
                  AND event_kind = 'sale'
                  AND owner_user_id = ?
                LIMIT 1
                """,
                (normalized_transaction_id, owner_user_id),
            ).fetchone()
            fallback_sale_id = str(fallback_row["sale_id"] or "").strip() if fallback_row is not None else ""
            if fallback_sale_id:
                row = self.connection.execute(
                    """
                    SELECT id, deck_entry_id, quantity
                    FROM sale_events
                    WHERE id = ?
                      AND owner_user_id = ?
                    LIMIT 1
                    """,
                    (fallback_sale_id, owner_user_id),
                ).fetchone()
                if row is not None:
                    resolved_transaction_id = fallback_sale_id
        if row is None:
            raise FileNotFoundError("sale transaction not found")

        quantity = max(1, int(row["quantity"] or 1))
        total_price = round(unit_price * quantity, 2)
        deck_entry_id = str(row["deck_entry_id"] or "").strip()

        self.connection.execute(
            """
            UPDATE sale_events
            SET unit_price = ?, total_price = ?, currency_code = ?
            WHERE id = ?
              AND owner_user_id = ?
            """,
            (unit_price, total_price, currency_code, resolved_transaction_id, owner_user_id),
        )
        self.connection.execute(
            """
            UPDATE deck_entry_events
            SET unit_price = ?, total_price = ?, currency_code = ?
            WHERE sale_id = ?
              AND event_kind = 'sale'
              AND owner_user_id = ?
            """,
            (unit_price, total_price, currency_code, resolved_transaction_id, owner_user_id),
        )
        self.connection.execute(
            """
            UPDATE deck_entries
            SET updated_at = ?
            WHERE id = ?
              AND owner_user_id = ?
            """,
            (updated_at, deck_entry_id, owner_user_id),
        )
        self.connection.commit()
        return {
            "transactionID": resolved_transaction_id,
            "deckEntryID": deck_entry_id,
            "unitPrice": round(unit_price, 2),
            "totalPrice": total_price,
            "currencyCode": currency_code,
            "updatedAt": updated_at,
        }

    def deck_entries(
        self,
        *,
        limit: int = 200,
        offset: int = 0,
        include_inactive: bool = False,
        favorites_only: bool = False,
        compute_day_change: bool = True,
    ) -> dict[str, Any]:
        """Cache-and-dogpile wrapper over the heavy inventory computation, the
        same pattern as ``portfolio_dashboard``. The payload is a pure function
        of the owner's deck rows, favorites, and the latest daily prices —
        `_deck_entries_version_token` fingerprints exactly those inputs, so the
        cache auto-invalidates on any collection mutation, wishlist change, or
        daily sync. Uncached, every Collection view re-ran ~1s of GIL-bound
        per-card pricing; ~30 concurrent browsers saturated the heavy-read slots
        and shed 503s (load-tested 2026-07-05). A hit serves in ~1ms."""
        owner_user_id = self._current_owner_user_id()
        started_at = perf_counter()
        try:
            version = self._deck_entries_version_token(owner_user_id)
        except Exception:  # noqa: BLE001 - cache bookkeeping must never break inventory
            traceback.print_exc()
            version = None

        cache_key = (
            owner_user_id,
            int(limit),
            int(offset),
            bool(include_inactive),
            bool(favorites_only),
            bool(compute_day_change),
        )
        if version is not None:
            cached = self._deck_entries_cache.get(cache_key)
            if cached is not None and cached[0] == version:
                self._log_deck_entries_timing(started_at, outcome="hit")
                return cached[1]

        lock = self._deck_entries_cache_lock_for(cache_key)
        with lock:
            if version is not None:
                cached = self._deck_entries_cache.get(cache_key)
                if cached is not None and cached[0] == version:
                    self._log_deck_entries_timing(started_at, outcome="hit_after_wait")
                    return cached[1]
            payload = self._compute_deck_entries(
                limit=limit,
                offset=offset,
                include_inactive=include_inactive,
                favorites_only=favorites_only,
                compute_day_change=compute_day_change,
            )
            if version is not None:
                self._store_deck_entries_cache(cache_key, version, payload)
            self._log_deck_entries_timing(started_at, outcome="miss")
            return payload

    def _deck_entries_version_token(self, owner_user_id: str) -> str:
        """The dashboard version token (deck mutations + events + sales + latest
        price date) plus the owner's wishlist state — deck_entries payloads carry
        favorite flags/filters, so a favorite add/remove must invalidate too.
        MAX(created_at) catches adds; COUNT(*) catches removals."""
        base = self._portfolio_dashboard_version_token(owner_user_id, "America/Los_Angeles")
        row = self.connection.execute(
            """
            SELECT MAX(created_at) AS fav_created, COUNT(*) AS fav_count
            FROM card_favorites
            WHERE owner_user_id = ?
            """,
            (owner_user_id,),
        ).fetchone()
        fav_parts = [str(row[key]) for key in row.keys()] if row is not None else []
        return "|".join([base, *fav_parts])

    def _deck_entries_cache_lock_for(self, cache_key: tuple[Any, ...]) -> "threading.Lock":
        with self._dashboard_cache_locks_guard:
            lock = self._deck_entries_cache_locks.get(cache_key)
            if lock is None:
                lock = threading.Lock()
                self._deck_entries_cache_locks[cache_key] = lock
            return lock

    def _store_deck_entries_cache(
        self, cache_key: tuple[Any, ...], version: str, payload: dict[str, Any]
    ) -> None:
        with self._dashboard_cache_locks_guard:
            if (
                cache_key not in self._deck_entries_cache
                and len(self._deck_entries_cache) >= self._deck_entries_cache_max_entries
            ):
                self._deck_entries_cache.pop(next(iter(self._deck_entries_cache)), None)
            self._deck_entries_cache[cache_key] = (version, payload)

    def _log_deck_entries_timing(self, started_at: float, *, outcome: str) -> None:
        elapsed_ms = round((perf_counter() - started_at) * 1000.0, 1)
        self._emit_structured_log(
            {
                "severity": "INFO",
                "event": "deck_entries_request",
                "outcome": outcome,
                "elapsedMs": elapsed_ms,
                "slow": elapsed_ms >= 5000.0,
            }
        )

    def _compute_deck_entries(
        self,
        *,
        limit: int = 200,
        offset: int = 0,
        include_inactive: bool = False,
        favorites_only: bool = False,
        compute_day_change: bool = True,
    ) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        safe_limit = max(0, min(int(limit), 1000))
        safe_offset = max(0, int(offset))
        where_clauses = ["owner_user_id = ?"]
        if not include_inactive:
            where_clauses.append("quantity > 0")
        if favorites_only:
            where_clauses.append(
                """
                EXISTS (
                    SELECT 1
                    FROM card_favorites
                    WHERE card_favorites.owner_user_id = deck_entries.owner_user_id
                      AND card_favorites.card_id = deck_entries.card_id
                )
                """
            )
        where_clause = f"WHERE {' AND '.join(where_clauses)}"
        rows = self.connection.execute(
            """
            SELECT
                id,
                item_kind,
                card_id,
                grader,
                grade,
                cert_number,
                variant_name,
                condition,
                quantity,
                cost_basis_total,
                cost_basis_currency_code,
                cost_basis_cents,
                listing_url,
                listing_price_cents,
                listed_at,
                added_at,
                updated_at,
                source_scan_id,
                source_confirmation_id,
                added_market_price,
                added_market_date
            FROM deck_entries
            {where_clause}
            ORDER BY added_at DESC, id DESC
            LIMIT ? OFFSET ?
            """.format(where_clause=where_clause),
            (owner_user_id, safe_limit, safe_offset),
        ).fetchall()
        deck_card_ids = [str(row["card_id"] or "").strip() for row in rows]
        cards_by_id_map = cards_by_ids(self.connection, deck_card_ids)
        price_snapshot_rows = self._price_snapshot_rows_by_card_id(deck_card_ids)
        # Cells-first current price: pre-fetch each card's latest-day cells in two
        # bulk queries so the per-row pricing resolver never reads the fat
        # raw/graded context blobs off cold disk and never issues a per-card cell
        # query (no N+1). Empty in JSON mode → resolver keeps its JSON-blob path.
        latest_day_cells_by_card_id = self._latest_day_cells_by_card_id(deck_card_ids)
        favorite_rows_by_card_id = self._favorite_rows_by_card_id(
            deck_card_ids,
            owner_user_id=owner_user_id,
        )
        # Batch the per-card "yesterday price" lookup into one query (was N+1, one
        # query per row). Skipped entirely when the caller only needs the summary
        # (e.g. the ledger inventory total) and not per-row day-change.
        yesterday_rows_by_card_id = (
            self._yesterday_price_history_rows_by_card_id(deck_card_ids)
            if compute_day_change
            else {}
        )

        entries: list[dict[str, Any]] = []
        total_value = 0.0
        total_cost_basis = 0.0
        raw_count = 0
        slab_count = 0
        # 30-day row sparklines: collect one batched history request per entry
        # (budget-capped), resolved in ONE call after the loop. Lives inside the
        # cached deck_entries compute, so repeat loads never re-read history.
        spark_requests: list[dict[str, Any]] = []

        for row in rows:
            card_id = str(row["card_id"] or "").strip()
            card = cards_by_id_map.get(card_id)
            if card is None:
                continue

            grader = str(row["grader"] or "").strip() or None
            grade = str(row["grade"] or "").strip() or None
            cert_number = str(row["cert_number"] or "").strip() or None
            variant_name = str(row["variant_name"] or "").strip() or None
            condition = self._normalized_deck_card_condition(row["condition"])
            quantity = max(0, int(row["quantity"] or 0))
            if quantity <= 0 and not include_inactive:
                continue
            total_cost_basis += float(row["cost_basis_total"] or 0.0)
            pricing_context = (
                self._slab_pricing_context(
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    preferred_variant=variant_name,
                )
                if grader or grade
                else self._raw_pricing_context(
                    preferred_variant=variant_name,
                    preferred_condition=condition,
                )
            )
            pricing = self._display_pricing_summary_for_context(
                card_id,
                pricing_context=pricing_context,
                snapshot_row=price_snapshot_rows.get(card_id),
                day_cells=latest_day_cells_by_card_id.get(card_id),
            )

            card_payload = self._candidate_base_payload(card, card)
            if pricing is not None:
                card_payload["pricing"] = pricing
                primary_price = pricing.get("market")
                if primary_price is None:
                    primary_price = pricing.get("mid")
                if primary_price is None:
                    primary_price = pricing.get("low")
                if primary_price is None:
                    primary_price = pricing.get("trend")
                if isinstance(primary_price, (int, float)):
                    total_value += float(primary_price) * quantity
            card_payload["isFavorite"] = card_id in favorite_rows_by_card_id

            slab_context = None
            if str(row["item_kind"] or "").strip().lower() == "slab":
                slab_context = {
                    "grader": grader,
                    "grade": grade,
                    "certNumber": cert_number,
                    "variantName": variant_name,
                }
                slab_count += 1
            else:
                raw_count += 1

            if compute_day_change:
                day_change_amount, day_change_percent = self._day_change_for_entry(
                    card_id=card_id,
                    item_kind=row["item_kind"],
                    grader=grader,
                    grade=grade,
                    variant_name=variant_name,
                    condition_code=condition,
                    today_pricing=pricing,
                    yesterday_rows_by_card_id=yesterday_rows_by_card_id,
                )
            else:
                day_change_amount, day_change_percent = None, None

            # "Since you added it": serve-time arithmetic on the stored add-day
            # baseline vs the price this row already resolved — no history read.
            since_added_amount, since_added_percent, since_added_baseline_date = (
                self._since_added_change(
                    baseline_price=row["added_market_price"],
                    baseline_date=row["added_market_date"],
                    current_price=self._history_primary_price_value(pricing),
                )
            )

            if len(spark_requests) < SINCE_ADDED_SPARK_MAX_CONTEXTS:
                is_graded_entry = bool(grader or grade)
                # Same variant carry-forward as day-change: price the history
                # window for the printing today's price resolved to.
                today_variant = (
                    str(pricing.get("variant") or "").strip() or None
                    if isinstance(pricing, dict)
                    else None
                )
                spark_requests.append(
                    {
                        "key": str(row["id"]),
                        "card_id": card_id,
                        "pricing_mode": (
                            PSA_GRADE_PRICING_MODE if is_graded_entry else RAW_PRICING_MODE
                        ),
                        "variant": variant_name or today_variant,
                        "condition": None if is_graded_entry else condition,
                        "grader": grader if is_graded_entry else None,
                        "grade": grade if is_graded_entry else None,
                    }
                )

            cost_basis_cents_raw = row["cost_basis_cents"] if "cost_basis_cents" in row.keys() else None
            cost_basis_per_unit_dollars: float | None = None
            if cost_basis_cents_raw is not None:
                try:
                    cost_basis_per_unit_dollars = round(float(cost_basis_cents_raw) / 100.0, 2)
                except (TypeError, ValueError):
                    cost_basis_per_unit_dollars = None
            listing_url_value = str(row["listing_url"] or "").strip() if "listing_url" in row.keys() else ""
            listing_price_cents_raw = row["listing_price_cents"] if "listing_price_cents" in row.keys() else None
            try:
                listing_price_cents_value = int(listing_price_cents_raw) if listing_price_cents_raw is not None else None
            except (TypeError, ValueError):
                listing_price_cents_value = None
            listed_at_value = str(row["listed_at"] or "").strip() if "listed_at" in row.keys() else ""

            entries.append(
                {
                    "id": row["id"],
                    "itemKind": row["item_kind"],
                    "card": card_payload,
                    "variantName": variant_name,
                    "slabContext": slab_context,
                    "condition": condition,
                    "quantity": quantity,
                    "costBasisTotal": round(float(row["cost_basis_total"] or 0.0), 2),
                    "costBasisCurrencyCode": str(row["cost_basis_currency_code"] or "").strip() or None,
                    "costBasisPerUnit": cost_basis_per_unit_dollars,
                    "costBasisCents": int(cost_basis_cents_raw) if cost_basis_cents_raw is not None else None,
                    "listingUrl": listing_url_value or None,
                    "listingPriceCents": listing_price_cents_value,
                    "listedAt": listed_at_value or None,
                    "addedAt": row["added_at"],
                    "updatedAt": row["updated_at"],
                    "sourceScanID": row["source_scan_id"],
                    "sourceConfirmationID": row["source_confirmation_id"],
                    "isFavorite": card_id in favorite_rows_by_card_id,
                    # When favorited, surface the favorite timestamp so the client
                    # can sort the Favorites filter by most-recently-favorited.
                    "favoritedAt": (
                        str(favorite_rows_by_card_id[card_id]["created_at"] or "").strip() or None
                        if card_id in favorite_rows_by_card_id
                        else None
                    ),
                    "dayChangeAmount": day_change_amount,
                    "dayChangePercent": day_change_percent,
                    "sinceAddedChangeAmount": since_added_amount,
                    "sinceAddedChangePercent": since_added_percent,
                    "sinceAddedBaselineDate": since_added_baseline_date,
                }
            )

        # Rows past the spark budget (or with no resolvable history) keep null
        # spark fields — the sinceAdded fields above are never truncated.
        spark_by_key = self._sparklines_for_requests(spark_requests)
        for entry in entries:
            spark = spark_by_key.get(str(entry["id"]))
            entry["sparkPoints"] = spark[0] if spark else None
            entry["sparkTrendPct"] = spark[1] if spark else None

        return {
            "entries": entries,
            "summary": {
                "count": len(entries),
                "rawCount": raw_count,
                "slabCount": slab_count,
                "totalValue": round(total_value, 2),
                "totalCostBasis": round(total_cost_basis, 2),
            },
            "limit": safe_limit,
            "offset": safe_offset,
        }

    def _sparklines_for_requests(
        self, spark_requests: list[dict[str, Any]]
    ) -> dict[str, tuple[list[float], float | None]]:
        """Resolve per-row 30-day mini sparklines for a list page in ONE batched
        history read (`price_history_rows_for_cards_batched` — two indexed
        queries per 400 cards), context-resolved with the same request shape the
        Insights table uses. Returns ``{key: (points oldest->newest, trendPct)}``;
        rows with fewer than two priced days are omitted (the caller emits null
        spark fields). Best-effort: any failure yields no sparklines, never a
        failed list response."""
        if not spark_requests:
            return {}
        try:
            history_rows_by_key = price_history_rows_for_cards_batched(
                self.connection,
                spark_requests,
                provider=pricing_provider(),
                days=SINCE_ADDED_SPARK_DAYS,
            )
        except Exception:  # noqa: BLE001 - sparklines are decorative
            traceback.print_exc()
            return {}
        result: dict[str, tuple[list[float], float | None]] = {}
        for key, resolved_rows in history_rows_by_key.items():
            values: list[float] = []
            # Resolved rows arrive newest-first; sparklines read oldest->newest.
            for resolved_row in reversed(resolved_rows):
                value = self._history_primary_price_value(resolved_row)
                if value is not None:
                    values.append(float(value))
            if len(values) < 2:
                continue
            points = self._downsample_sparkline(values, target=SINCE_ADDED_SPARK_POINTS)
            first_value, last_value = points[0], points[-1]
            trend_pct = (
                round((last_value - first_value) / first_value * 100.0, 2)
                if first_value > 0
                else None
            )
            result[str(key)] = (points, trend_pct)
        return result

    @staticmethod
    def _downsample_sparkline(values: list[float], target: int = 24) -> list[float]:
        """Pick ~``target`` evenly-spaced values (oldest->newest) from ``values``.

        Fewer points than the target are returned as-is; a longer series is
        thinned with evenly-spaced indices that always include the first and
        last point so the sparkline still spans the whole year."""
        count = len(values)
        if count <= target:
            return [round(float(v), 2) for v in values]
        # Even spacing across [0, count-1] inclusive of both endpoints.
        indices = sorted(
            {round(i * (count - 1) / (target - 1)) for i in range(target)}
        )
        return [round(float(values[i]), 2) for i in indices]

    def portfolio_performance(self) -> dict[str, Any]:
        """Cache-and-dogpile wrapper over the heavy performance-table compute,
        the same pattern as portfolio_dashboard / transaction_insights /
        deck_entries. Uncached, every Insights open recomputed current price +
        Jan-1/30-day baselines + a year-long sparkline for EVERY owned card —
        measured ~4s per call for a 140-card owner, on every view. The payload
        is a pure function of the owner's deck rows, favorites (likes chip),
        and the latest daily prices — `_deck_entries_version_token` fingerprints
        exactly those inputs, so a hit serves in ~1ms and auto-invalidates on
        any mutation, wishlist change, or daily sync."""
        owner_user_id = self._current_owner_user_id()
        started_at = perf_counter()
        try:
            version = self._deck_entries_version_token(owner_user_id)
        except Exception:  # noqa: BLE001 - cache bookkeeping must never break insights
            traceback.print_exc()
            version = None
        cache_key = (owner_user_id, "performance")
        if version is not None:
            cached = self._dashboard_cache.get(cache_key)
            if cached is not None and cached[0] == version:
                self._log_portfolio_performance_timing(started_at, outcome="hit")
                return cached[1]
        lock = self._dashboard_cache_lock_for(cache_key)
        with lock:
            if version is not None:
                cached = self._dashboard_cache.get(cache_key)
                if cached is not None and cached[0] == version:
                    self._log_portfolio_performance_timing(started_at, outcome="hit_after_wait")
                    return cached[1]
            payload = self._compute_portfolio_performance()
            if version is not None:
                self._store_dashboard_cache(cache_key, version, payload)
            self._log_portfolio_performance_timing(started_at, outcome="miss")
            return payload

    def _log_portfolio_performance_timing(self, started_at: float, *, outcome: str) -> None:
        elapsed_ms = round((perf_counter() - started_at) * 1000.0, 1)
        self._emit_structured_log(
            {
                "severity": "INFO",
                "event": "portfolio_performance_request",
                "outcome": outcome,
                "elapsedMs": elapsed_ms,
                "slow": elapsed_ms >= 5000.0,
            }
        )

    def _compute_portfolio_performance(self) -> dict[str, Any]:
        """Per-card YTD performance table for the owner's active inventory.

        One batched SQLite read: current price (same resolution as the
        Collection/deck-entries view), cost basis, a year-start (Jan 1) baseline
        price, YTD gain/loss, and a downsampled yearly price sparkline. Pure
        SQLite read — no provider refresh, no Scrydex fetch. Missing data yields
        nulls, never a live fetch (live-pricing-off invariant)."""
        owner_user_id = self._current_owner_user_id()
        now = datetime.now(timezone.utc)
        year = now.year
        jan1_str = f"{year}-01-01"
        today_str = now.date().isoformat()
        # 30-day baseline anchor for the "month" gain/loss columns, formatted the
        # same way as today_str/jan1_str.
        month_ago_str = (now.date() - timedelta(days=30)).isoformat()
        # Days from Jan 1 (inclusive) through today, plus a small buffer so the
        # DESC-ordered `days` window comfortably reaches back to Jan 1.
        year_days = (now.date() - date(year, 1, 1)).days + 8

        # Wishlist hearts ("Likes" chip): favorites are keyed by card, so every
        # entry of a liked card is liked.
        favorite_card_ids = {
            str(fav_row["card_id"])
            for fav_row in self.connection.execute(
                "SELECT card_id FROM card_favorites WHERE owner_user_id = ?",
                (owner_user_id,),
            ).fetchall()
        }

        rows = self.connection.execute(
            """
            SELECT
                id,
                item_kind,
                card_id,
                grader,
                grade,
                cert_number,
                variant_name,
                condition,
                quantity,
                cost_basis_total,
                cost_basis_cents
            FROM deck_entries
            WHERE owner_user_id = ? AND quantity > 0
            ORDER BY added_at DESC, id DESC
            """,
            (owner_user_id,),
        ).fetchall()

        card_ids = [str(row["card_id"] or "").strip() for row in rows]
        cards_by_id_map = cards_by_ids(self.connection, card_ids)
        price_snapshot_rows = self._price_snapshot_rows_by_card_id(card_ids)
        # Cells-first current price (same bulk prefetch as deck_entries) so the
        # "Current" column resolves without cold JSON-blob reads. Empty in JSON
        # mode → resolver keeps its JSON-blob path.
        latest_day_cells_by_card_id = self._latest_day_cells_by_card_id(card_ids)

        provider = pricing_provider()
        result_rows: list[dict[str, Any]] = []
        currency_code = "USD"

        # Batch all per-card price-history reads into ONE projected daily read +
        # ONE batched cell read, keyed by the deck-entry id. This replaces the
        # per-card N+1 (one `SELECT *` daily read per card, then one cell read per
        # day per card against the 27M-row cell table) that dominated the cold
        # first-load — the same access-path fix already applied to the portfolio
        # dashboard and PDP price trend. The resolved rows are byte-for-byte
        # identical to the per-card `price_history_rows_for_card` output.
        history_requests: list[dict[str, Any]] = []
        for row in rows:
            card_id = str(row["card_id"] or "").strip()
            if cards_by_id_map.get(card_id) is None:
                continue
            grader = str(row["grader"] or "").strip() or None
            grade = str(row["grade"] or "").strip() or None
            variant_name = str(row["variant_name"] or "").strip() or None
            condition = self._normalized_deck_card_condition(row["condition"])
            quantity = max(0, int(row["quantity"] or 0))
            if quantity <= 0:
                continue
            is_graded = str(row["item_kind"] or "").strip().lower() == "slab" or bool(
                grader or grade
            )
            history_requests.append(
                {
                    "key": str(row["id"]),
                    "card_id": card_id,
                    "pricing_mode": (
                        PSA_GRADE_PRICING_MODE if is_graded else RAW_PRICING_MODE
                    ),
                    "variant": variant_name,
                    "condition": None if is_graded else condition,
                    "grader": grader if is_graded else None,
                    "grade": grade if is_graded else None,
                }
            )
        history_rows_by_entry = price_history_rows_for_cards_batched(
            self.connection,
            history_requests,
            provider=provider,
            days=year_days,
        )

        for row in rows:
            card_id = str(row["card_id"] or "").strip()
            card = cards_by_id_map.get(card_id)
            if card is None:
                continue

            grader = str(row["grader"] or "").strip() or None
            grade = str(row["grade"] or "").strip() or None
            cert_number = str(row["cert_number"] or "").strip() or None
            variant_name = str(row["variant_name"] or "").strip() or None
            condition = self._normalized_deck_card_condition(row["condition"])
            quantity = max(0, int(row["quantity"] or 0))
            if quantity <= 0:
                continue

            is_graded = str(row["item_kind"] or "").strip().lower() == "slab" or bool(
                grader or grade
            )
            pricing_context = (
                self._slab_pricing_context(
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    preferred_variant=variant_name,
                )
                if is_graded
                else self._raw_pricing_context(
                    preferred_variant=variant_name,
                    preferred_condition=condition,
                )
            )
            # Current price: reuse the SAME resolution the Collection view uses so
            # this table matches what the app already shows.
            pricing = self._display_pricing_summary_for_context(
                card_id,
                pricing_context=pricing_context,
                snapshot_row=price_snapshot_rows.get(card_id),
                day_cells=latest_day_cells_by_card_id.get(card_id),
            )
            current_price = self._primary_price_value(pricing)
            if isinstance(pricing, dict):
                currency_code = str(pricing.get("currencyCode") or currency_code)
            current_value = (
                round(current_price * quantity, 2) if current_price is not None else None
            )

            # Cost basis: null when the user never entered one. Prefer the
            # authoritative per-unit `cost_basis_cents`; fall back to the legacy
            # total-dollars column when present and non-zero.
            cost_basis_total: float | None = None
            cost_basis_cents_raw = (
                row["cost_basis_cents"] if "cost_basis_cents" in row.keys() else None
            )
            if cost_basis_cents_raw is not None:
                try:
                    cost_basis_total = round(
                        float(cost_basis_cents_raw) / 100.0 * quantity, 2
                    )
                except (TypeError, ValueError):
                    cost_basis_total = None
            if cost_basis_total is None:
                legacy_total = float(row["cost_basis_total"] or 0.0)
                if legacy_total > 0.0:
                    cost_basis_total = round(legacy_total, 2)

            # Year-to-date history: read this entry's daily series in the SAME
            # pricing mode/columns it resolves to (raw vs graded). Resolved by the
            # single batched read above, keyed by deck-entry id.
            history_rows = history_rows_by_entry.get(str(row["id"]), [])
            history_rows = self._display_price_history_rows(history_rows)
            # `_history_points_payload` reverses to oldest->newest.
            points = self._history_points_payload(history_rows)
            # Only this year's points, with a resolvable price. Also track the
            # latest priced point strictly before today ("yesterday") for the
            # today-G/L columns — it may predate Jan 1 (e.g. on New Year's Day).
            year_series: list[float] = []
            prev_day_price: float | None = None
            prev_month_price: float | None = None
            for point in points:
                point_date = str(point.get("date") or "")
                value = self._history_primary_price_value(point)
                if value is None:
                    continue
                if point_date < today_str:
                    prev_day_price = float(value)
                if point_date < month_ago_str:
                    prev_month_price = float(value)
                if point_date < jan1_str:
                    continue
                year_series.append(float(value))

            if year_series:
                jan1_price = round(year_series[0], 2)
                sparkline = self._downsample_sparkline(year_series)
            else:
                jan1_price = None
                sparkline = []

            year_start_value = (
                round(jan1_price * quantity, 2) if jan1_price is not None else None
            )
            if jan1_price is not None and current_price is not None:
                ytd_gain_dollar = round((current_value or 0.0) - (year_start_value or 0.0), 2)
                ytd_gain_percent = (
                    round((current_price - jan1_price) / jan1_price * 100.0, 2)
                    if jan1_price != 0.0
                    else None
                )
            else:
                ytd_gain_dollar = None
                ytd_gain_percent = None

            if prev_day_price is not None and current_price is not None:
                today_gain_dollar = round(
                    (current_price - prev_day_price) * quantity, 2
                )
                today_gain_percent = (
                    round(
                        (current_price - prev_day_price) / prev_day_price * 100.0, 2
                    )
                    if prev_day_price != 0.0
                    else None
                )
            else:
                today_gain_dollar = None
                today_gain_percent = None

            if prev_month_price is not None and current_price is not None:
                month_gain_dollar = round(
                    (current_price - prev_month_price) * quantity, 2
                )
                month_gain_percent = (
                    round(
                        (current_price - prev_month_price) / prev_month_price * 100.0,
                        2,
                    )
                    if prev_month_price != 0.0
                    else None
                )
            else:
                month_gain_dollar = None
                month_gain_percent = None

            result_rows.append(
                {
                    "entryId": str(row["id"]),
                    "cardId": card_id,
                    "name": str(card.get("name") or ""),
                    "number": str(card.get("number") or ""),
                    "setName": str(card.get("setName") or ""),
                    "imageUrl": card.get("imageURL") or card.get("imageSmallURL"),
                    # Small variant for list thumbnails — the client's table rows
                    # load this (small-first, like the Collection tiles) instead of
                    # the full-size scan; imageUrl stays full-size for the PDP
                    # preview handoff.
                    "smallImageUrl": card.get("imageSmallURL"),
                    "quantity": quantity,
                    "kind": "graded" if is_graded else "raw",
                    "variantName": variant_name,
                    "condition": condition,
                    "grade": (
                        (f"{grader or ''} {grade or ''}".strip() or None)
                        if is_graded
                        else None
                    ),
                    "currentPrice": current_price,
                    "currentValue": current_value,
                    "costBasisTotal": cost_basis_total,
                    "jan1Price": jan1_price,
                    "yearStartValue": year_start_value,
                    "ytdGainDollar": ytd_gain_dollar,
                    "ytdGainPercent": ytd_gain_percent,
                    "todayGainDollar": today_gain_dollar,
                    "todayGainPercent": today_gain_percent,
                    "monthGainDollar": month_gain_dollar,
                    "monthGainPercent": month_gain_percent,
                    "isFavorite": card_id in favorite_card_ids,
                    "sparkline": sparkline,
                }
            )

        return {
            "itemCount": len(result_rows),
            "currencyCode": currency_code,
            "refreshedAt": utc_now(),
            "rows": result_rows,
        }

    def card_favorites(self, *, limit: int = 200, offset: int = 0) -> dict[str, Any]:
        """Cache-and-dogpile wrapper over the wishlist computation — the same
        pattern (and the same cache dict + version token) as ``deck_entries``.
        The token already fingerprints the owner's favorites, deck rows, and the
        latest price date, so a favorite toggle or daily sync invalidates.
        Uncached, every wishlist open re-ran the inline 30d sparkline batch read
        against card_price_history_cell; on a cold page cache (post-deploy) that
        exceeded the client timeout — 'Client disconnected before response write
        completed' — and the wishlist rendered empty (observed 2026-07-16)."""
        owner_user_id = self._current_owner_user_id()
        try:
            version = self._deck_entries_version_token(owner_user_id)
        except Exception:  # noqa: BLE001 - cache bookkeeping must never break the wishlist
            traceback.print_exc()
            version = None

        cache_key = (owner_user_id, "card_favorites", int(limit), int(offset))
        if version is not None:
            cached = self._deck_entries_cache.get(cache_key)
            if cached is not None and cached[0] == version:
                return cached[1]

        lock = self._deck_entries_cache_lock_for(cache_key)
        with lock:
            if version is not None:
                cached = self._deck_entries_cache.get(cache_key)
                if cached is not None and cached[0] == version:
                    return cached[1]
            payload = self._compute_card_favorites(limit=limit, offset=offset)
            if version is not None:
                self._store_deck_entries_cache(cache_key, version, payload)
            return payload

    def _compute_card_favorites(self, *, limit: int = 200, offset: int = 0) -> dict[str, Any]:
        owner_user_id = self._current_owner_user_id()
        safe_limit = max(0, min(int(limit), 1000))
        safe_offset = max(0, int(offset))
        rows = self.connection.execute(
            """
            SELECT card_id, created_at, added_market_price, added_market_date
            FROM card_favorites
            WHERE owner_user_id = ?
            ORDER BY created_at DESC, card_id ASC
            LIMIT ? OFFSET ?
            """,
            (owner_user_id, safe_limit, safe_offset),
        ).fetchall()

        card_ids_in_order = [str(row["card_id"] or "").strip() for row in rows if row["card_id"]]
        if not card_ids_in_order:
            return {"entries": [], "limit": safe_limit, "offset": safe_offset}

        cards_by_id_map = cards_by_ids(self.connection, card_ids_in_order)
        price_snapshot_rows = self._price_snapshot_rows_by_card_id(card_ids_in_order)
        # Cells-first current price (same bulk prefetch as deck_entries): no cold
        # blob read, no per-card cell query. Empty in JSON mode.
        latest_day_cells_by_card_id = self._latest_day_cells_by_card_id(card_ids_in_order)
        # Pull the owned deck entry (grade/condition/kind) per favorited card so the
        # wishlist rows + hero can mirror the Collection list: graded copies surface a
        # slab context, raw copies a condition, and the price/day-change is computed in
        # the owned lane. Unowned favorites stay on the raw lane with no grade.
        owned_summary = self._owned_deck_summary_by_card_id(owner_user_id, card_ids_in_order)

        entries: list[dict[str, Any]] = []
        # 30-day row sparklines: one batched history request per favorite
        # (budget-capped), resolved in ONE call after the loop. Favorites lists
        # are small and uncached, so inline compute is fine; the single batched
        # read keeps it two indexed queries per 400 cards.
        spark_requests: list[dict[str, Any]] = []
        for row in rows:
            card_id = str(row["card_id"] or "").strip()
            card = cards_by_id_map.get(card_id)
            if card is None:
                continue
            owned = owned_summary.get(card_id)
            grader = owned["grader"] if owned else None
            grade = owned["grade"] if owned else None
            cert_number = owned["cert_number"] if owned else None
            variant_name = owned["variant_name"] if owned else None
            condition = owned["condition"] if owned else None
            item_kind = owned["item_kind"] if owned else None

            if owned and (grader or grade):
                pricing_context = self._slab_pricing_context(
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    preferred_variant=variant_name,
                )
            else:
                pricing_context = self._raw_pricing_context(
                    preferred_variant=variant_name,
                    preferred_condition=condition,
                )
            pricing = self._display_pricing_summary_for_context(
                card_id,
                pricing_context=pricing_context,
                snapshot_row=price_snapshot_rows.get(card_id),
                day_cells=latest_day_cells_by_card_id.get(card_id),
            )
            card_payload = self._candidate_base_payload(card, card)
            if pricing is not None:
                card_payload["pricing"] = pricing
            card_payload["isFavorite"] = True

            slab_context = None
            if grader or grade:
                slab_context = {
                    "grader": grader,
                    "grade": grade,
                    "certNumber": cert_number,
                    "variantName": variant_name,
                }

            day_change_amount, day_change_percent = self._day_change_for_entry(
                card_id=card_id,
                item_kind=item_kind,
                grader=grader,
                grade=grade,
                variant_name=variant_name,
                condition_code=condition,
                today_pricing=pricing,
            )

            # "Since you added it" (vs favoritedAt): serve-time arithmetic on the
            # stored favorite-day baseline vs the price this row just resolved.
            since_added_amount, since_added_percent, since_added_baseline_date = (
                self._since_added_change(
                    baseline_price=row["added_market_price"],
                    baseline_date=row["added_market_date"],
                    current_price=self._history_primary_price_value(pricing),
                )
            )

            if len(spark_requests) < SINCE_ADDED_SPARK_MAX_CONTEXTS:
                is_graded_entry = bool(grader or grade)
                today_variant = (
                    str(pricing.get("variant") or "").strip() or None
                    if isinstance(pricing, dict)
                    else None
                )
                spark_requests.append(
                    {
                        # Favorites are unique per card for an owner.
                        "key": card_id,
                        "card_id": card_id,
                        "pricing_mode": (
                            PSA_GRADE_PRICING_MODE if is_graded_entry else RAW_PRICING_MODE
                        ),
                        "variant": variant_name or today_variant,
                        "condition": None if is_graded_entry else condition,
                        "grader": grader if is_graded_entry else None,
                        "grade": grade if is_graded_entry else None,
                    }
                )

            entries.append(
                {
                    "card": card_payload,
                    "favoritedAt": row["created_at"],
                    "isOwned": owned is not None,
                    "slabContext": slab_context,
                    "condition": condition,
                    # Owned copy's print variant (e.g. "Holofoil") so the wishlist
                    # rows can render "Variant · Condition" like the Collection.
                    "variantName": variant_name,
                    "dayChangeAmount": day_change_amount,
                    "dayChangePercent": day_change_percent,
                    "sinceAddedChangeAmount": since_added_amount,
                    "sinceAddedChangePercent": since_added_percent,
                    "sinceAddedBaselineDate": since_added_baseline_date,
                }
            )

        # Rows past the spark budget (or with no resolvable history) keep null
        # spark fields — the sinceAdded fields above are never truncated.
        spark_by_key = self._sparklines_for_requests(spark_requests)
        for entry in entries:
            spark = spark_by_key.get(str(entry["card"].get("id") or ""))
            entry["sparkPoints"] = spark[0] if spark else None
            entry["sparkTrendPct"] = spark[1] if spark else None

        return {"entries": entries, "limit": safe_limit, "offset": safe_offset}

    def _owned_card_ids_for_user(self, owner_user_id: str, card_ids: list[str]) -> set[str]:
        normalized = [card_id for card_id in card_ids if card_id]
        if not owner_user_id or not normalized:
            return set()
        placeholders = ",".join("?" for _ in normalized)
        rows = self.connection.execute(
            f"""
            SELECT DISTINCT card_id
            FROM deck_entries
            WHERE owner_user_id = ?
              AND quantity > 0
              AND card_id IN ({placeholders})
            """,
            (owner_user_id, *normalized),
        ).fetchall()
        return {str(row["card_id"] or "").strip() for row in rows if row["card_id"]}

    def _owned_deck_summary_by_card_id(
        self, owner_user_id: str, card_ids: list[str]
    ) -> dict[str, dict[str, Any]]:
        """Grade/condition/kind of the user's owned deck entry per card_id.

        Keeps the most recently added owned entry when a card has several copies
        so the wishlist shows a single, stable grade/condition per favorite.
        """
        normalized = [card_id for card_id in card_ids if card_id]
        if not owner_user_id or not normalized:
            return {}
        placeholders = ",".join("?" for _ in normalized)
        rows = self.connection.execute(
            f"""
            SELECT card_id, item_kind, grader, grade, cert_number, variant_name, condition
            FROM deck_entries
            WHERE owner_user_id = ?
              AND quantity > 0
              AND card_id IN ({placeholders})
            ORDER BY added_at DESC, id DESC
            """,
            (owner_user_id, *normalized),
        ).fetchall()
        summary: dict[str, dict[str, Any]] = {}
        for row in rows:
            card_id = str(row["card_id"] or "").strip()
            if not card_id or card_id in summary:
                continue
            summary[card_id] = {
                "item_kind": str(row["item_kind"] or "").strip() or None,
                "grader": str(row["grader"] or "").strip() or None,
                "grade": str(row["grade"] or "").strip() or None,
                "cert_number": str(row["cert_number"] or "").strip() or None,
                "variant_name": str(row["variant_name"] or "").strip() or None,
                "condition": self._normalized_deck_card_condition(row["condition"]),
            }
        return summary

    def _log_scan(
        self,
        request_payload: dict[str, Any],
        response_payload: dict[str, Any],
        top_candidates: list[dict[str, Any]],
        *,
        prediction_candidates: list[dict[str, Any]] | None = None,
    ) -> None:
        scan_id = request_payload["scanID"]
        now = utc_now()
        owner_user_id = self._current_owner_user_id()
        predicted_card_id = self._predicted_card_id(response_payload)
        if predicted_card_id is None and top_candidates:
            predicted_card_id = str(((top_candidates[0].get("candidate") or {}).get("id")) or "").strip() or None
        upsert_scan_event(
            self.connection,
            scan_id=scan_id,
            owner_user_id=owner_user_id,
            request_payload=self._request_payload_for_scan_event(request_payload),
            response_payload=response_payload,
            matcher_source=response_payload["matcherSource"],
            matcher_version=response_payload["matcherVersion"],
            created_at=now,
            predicted_card_id=predicted_card_id,
            selected_card_id=None,
            confidence=response_payload.get("confidence"),
            review_disposition=response_payload.get("reviewDisposition"),
            resolver_mode=response_payload.get("resolverMode"),
            resolver_path=response_payload.get("resolverPath"),
            completed_at=now,
        )
        # Persist the full lightweight candidate pool (up to SCAN_CANDIDATE_POOL_SIZE)
        # so "load more candidates" can page beyond the hydrated top 10. Price
        # observations stay on the hydrated top-10 candidates only: pool entries
        # beyond rank 10 are lightweight and carry no pricing.
        prediction_pool = prediction_candidates if prediction_candidates is not None else top_candidates
        replace_scan_prediction_candidates(
            self.connection,
            scan_id=scan_id,
            candidates=prediction_pool[:SCAN_CANDIDATE_POOL_SIZE],
        )
        replace_scan_price_observations(self.connection, scan_id=scan_id, candidates=top_candidates[:10], observed_at=now)
        self.connection.commit()


class SpotlightRequestHandler(BaseHTTPRequestHandler):
    service: SpotlightScanService

    def _require_request_identity(self) -> RequestIdentity | None:
        try:
            return self.service.authenticator.resolve_identity(self.headers.get("Authorization"))
        except RequestAuthError as error:
            self._write_json(HTTPStatus.UNAUTHORIZED, {"error": str(error)})
            return None

    @staticmethod
    def _reviewer_user_ids() -> set[str]:
        raw = os.environ.get(REVIEWER_USER_IDS_ENV) or ""
        return {part.strip() for part in raw.split(",") if part.strip()}

    @staticmethod
    def _reviewer_emails() -> set[str]:
        raw = os.environ.get(REVIEWER_EMAILS_ENV) or ""
        return {part.strip().lower() for part in raw.split(",") if part.strip()}

    def _require_reviewer(self, identity: RequestIdentity) -> bool:
        user_id = str(getattr(identity, "user_id", "") or "").strip()
        email = str(getattr(identity, "email", "") or "").strip().lower()
        if user_id and user_id in self._reviewer_user_ids():
            return True
        if email and email in self._reviewer_emails():
            return True
        self._write_json(
            HTTPStatus.FORBIDDEN,
            {
                "error": "Reviewer access is required.",
                "message": "Ask the admin to grant reviewer access",
                "userId": user_id,
                "email": email,
            },
        )
        return False

    def _require_access(self, identity: RequestIdentity) -> bool:
        """Public App Store ACCESS GATE (defense in depth).

        Returns True (and writes nothing) when the caller is allowed; otherwise
        writes a 403 ``access_closed`` and returns False. Call this right after the
        request identity is resolved in each PROTECTED handler.
        """
        if self.service.access_allowed(identity):
            return True
        self._write_json(
            HTTPStatus.FORBIDDEN,
            {"error": "access_closed", "message": "Ekalight is between shows."},
        )
        return False

    def _acquire_scan_inference_slot(self) -> bool:
        """Reserve a slot before running the CPU-bound encoder (queue/wait).

        Bounds how many encoder-bearing scans run at once so they take turns and
        each stays fast, instead of all thrashing the CPU (which turns a ~60ms
        forward into ~60s). A request without a free slot WAITS in line up to the
        acquire timeout; on success the caller MUST release the slot in a
        ``finally``. Only if the wait is exceeded does this write a 503 — set
        below the app's request timeout so its silent retry re-submits once the
        queue drains, keeping the UI on "scanning…" rather than an error.
        """
        if _scan_inference_semaphore.acquire(timeout=SCAN_INFERENCE_ACQUIRE_TIMEOUT_S):
            return True
        self._write_json(
            HTTPStatus.SERVICE_UNAVAILABLE,
            {
                "error": "Scanner is busy right now. Please try again.",
                "errorType": "ScannerBusy",
                "retryable": True,
            },
        )
        return False

    def _acquire_heavy_read_slot(self) -> bool:
        """Reserve a slot before an expensive portfolio/collection read.

        Caps how many heavy (disk-I/O-bound) reads run at once so a concurrency
        spike fails fast with a retryable 503 instead of all of them piling up
        and cascading the whole box into multi-second/60s hangs. A request
        without a free slot WAITS up to the acquire timeout; on success the
        caller MUST release the slot in a ``finally``.
        """
        if _heavy_read_semaphore.acquire(timeout=HEAVY_READ_ACQUIRE_TIMEOUT_S):
            return True
        self._write_json(
            HTTPStatus.SERVICE_UNAVAILABLE,
            {
                "error": "The server is busy right now. Please try again.",
                "errorType": "ServerBusy",
                "retryable": True,
            },
        )
        return False

    def _write_image(self, status: HTTPStatus, body: bytes) -> None:
        self.send_response(status.value)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            print(
                "[HTTP] Client disconnected before image write completed: "
                f"path={getattr(self, 'path', '<unknown>')} status={status.value}"
            )

    def _write_html(self, status: HTTPStatus, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            print(
                "[HTTP] Client disconnected before HTML write completed: "
                f"path={getattr(self, 'path', '<unknown>')} status={status.value}"
            )

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        # --- Public App Store ACCESS GATE: status (auth, never access-gated) ---
        if parsed.path == "/api/v1/access/status":
            identity = self._require_request_identity()
            if identity is None:
                return
            with self.service.request_identity_context(identity):
                self._write_json(HTTPStatus.OK, self.service.access_status(identity))
            return

        if parsed.path == "/api/v1/ops/access/whitelist":
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self.service._is_admin_email(getattr(identity, "email", "")):
                self._write_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
                return
            self._write_json(HTTPStatus.OK, {"emails": self.service.list_whitelist_emails()})
            return

        # --- Reviewer-gated "label unlabeled scans" web surface (additive) ---
        if parsed.path == "/api/v1/review/config":
            supabase_url = (
                os.environ.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL")
                or os.environ.get("SPOTLIGHT_SUPABASE_URL")
                or os.environ.get("SUPABASE_URL")
                or ""
            )
            supabase_anon_key = (
                os.environ.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY")
                or os.environ.get("SPOTLIGHT_SUPABASE_ANON_KEY")
                or ""
            )
            self._write_json(
                HTTPStatus.OK,
                {"supabaseUrl": supabase_url, "supabaseAnonKey": supabase_anon_key},
            )
            return

        if parsed.path == "/review":
            review_html_path = (
                Path(__file__).resolve().parent / "review_web" / "index.html"
            )
            try:
                html = review_html_path.read_text(encoding="utf-8")
            except OSError:
                self._write_json(
                    HTTPStatus.NOT_FOUND, {"error": "Review surface is not available."}
                )
                return
            self._write_html(HTTPStatus.OK, html)
            return

        if parsed.path == "/api/v1/review/queue":
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self._require_reviewer(identity):
                return
            queue_id = query.get("queue", [""])[0]
            mode = query.get("mode", ["pending"])[0]
            try:
                limit = int(query.get("limit", [str(REVIEW_QUEUE_DEFAULT_LIMIT)])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return
            try:
                with self.service.request_identity_context(identity):
                    payload = self.service.review_queue(
                        queue_id, identity.user_id, limit=limit, mode=mode
                    )
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Review queue load failed: {error}"},
                )
                return
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path.startswith("/api/v1/review/image/"):
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self._require_reviewer(identity):
                return
            scan_id = unquote(parsed.path.removeprefix("/api/v1/review/image/").strip("/"))
            queue_id = query.get("queue", [""])[0]
            if not scan_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            try:
                with self.service.request_identity_context(identity):
                    object_path = self.service.review_image_object_path(queue_id, scan_id)
                    if not object_path:
                        self._write_json(
                            HTTPStatus.NOT_FOUND, {"error": "Scan image not found"}
                        )
                        return
                    image_bytes = self.service.read_scan_object_bytes(object_path)
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Scan image load failed: {error}"},
                )
                return
            if not image_bytes:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Scan image not found"})
                return
            self._write_image(HTTPStatus.OK, image_bytes)
            return

        if (
            parsed.path.startswith("/api/v1/scan/")
            and parsed.path.endswith("/candidates")
        ):
            identity = self._require_request_identity()
            if identity is None:
                return
            scan_id = unquote(
                parsed.path.removeprefix("/api/v1/scan/").removesuffix("/candidates").strip("/")
            )
            if not scan_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Scan not found"})
                return
            try:
                offset = int(query.get("offset", ["0"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "offset must be an integer"})
                return
            try:
                limit = int(query.get("limit", [str(SCAN_CANDIDATE_POOL_SIZE)])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return
            try:
                with self.service.request_identity_context(identity):
                    payload = self.service.scan_candidates_window(
                        scan_id, offset=offset, limit=limit
                    )
            except FileNotFoundError:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Scan not found"})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Scan candidates load failed: {error}"},
                )
                return
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/v1/health":
            prewarm_visual = str(query.get("prewarm", [""])[0]).strip().lower() in {"1", "true", "visual", "all"}
            self._write_json(HTTPStatus.OK, self.service.health(prewarm_visual=prewarm_visual))
            return

        if parsed.path == "/api/v1/ops/provider-status":
            self._write_json(HTTPStatus.OK, self.service.provider_status())
            return

        if parsed.path == "/api/v1/ops/scrydex-usage":
            try:
                hours = int(query.get("hours", ["24"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "hours must be an integer"})
                return
            try:
                limit = int(query.get("limit", ["25"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return
            self._write_json(
                HTTPStatus.OK,
                self.service.scrydex_usage_summary(hours=hours, recent_limit=limit),
            )
            return

        if parsed.path == "/api/v1/ops/scan-artifact-status":
            self._write_json(HTTPStatus.OK, self.service.scan_artifact_status())
            return

        if parsed.path == "/api/v1/ops/unmatched-scans":
            limit = int(query.get("limit", ["25"])[0])
            self._write_json(HTTPStatus.OK, self.service.unmatched_scans(limit=limit))
            return

        if parsed.path == "/api/v1/card-favorites":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                limit = int(query.get("limit", ["200"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return
            try:
                offset = int(query.get("offset", ["0"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "offset must be an integer"})
                return
            with self.service.request_identity_context(identity):
                self._write_json(
                    HTTPStatus.OK,
                    self.service.card_favorites(limit=limit, offset=offset),
                )
            return

        if parsed.path == "/api/v1/deck/entries":
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self._require_access(identity):
                return
            try:
                limit = int(query.get("limit", ["200"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return
            try:
                offset = int(query.get("offset", ["0"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "offset must be an integer"})
                return
            include_inactive = str(query.get("includeInactive", ["0"])[0]).strip().lower() in {"1", "true", "yes", "on"}
            favorites_only = str(query.get("favorites", ["0"])[0]).strip().lower() in {"1", "true", "yes", "on"}
            if not favorites_only:
                favorites_only = str(query.get("favoritesOnly", ["0"])[0]).strip().lower() in {
                    "1",
                    "true",
                    "yes",
                    "on",
                }
            if not self._acquire_heavy_read_slot():
                return
            try:
                with self.service.request_identity_context(identity):
                    self._write_json(
                        HTTPStatus.OK,
                        self.service.deck_entries(
                            limit=limit,
                            offset=offset,
                            include_inactive=include_inactive,
                            favorites_only=favorites_only,
                        ),
                    )
            finally:
                _heavy_read_semaphore.release()
            return

        if parsed.path in {"/api/v1/deck/history", "/api/v1/portfolio/history"}:
            identity = self._require_request_identity()
            if identity is None:
                return
            query = parse_qs(parsed.query)
            days_value = query.get("days", ["30"])[0]
            range_value = query.get("range", [""])[0].strip() or None
            time_zone_name = query.get("timeZone", [""])[0].strip() or None
            try:
                days = int(days_value)
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "days must be an integer"})
                return
            if not self._acquire_heavy_read_slot():
                return
            try:
                with self.service.request_identity_context(identity):
                    payload = self.service.deck_history(days=days, range_label=range_value, time_zone_name=time_zone_name)
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Deck history failed: {error}"})
                return
            finally:
                _heavy_read_semaphore.release()
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/v1/vendor/show-summary":
            identity = self._require_request_identity()
            if identity is None:
                return
            query = parse_qs(parsed.query)
            since_value = query.get("since", [""])[0].strip() or None
            until_value = query.get("until", [""])[0].strip() or None
            try:
                with self.service.request_identity_context(identity):
                    summary_payload = self.service.vendor_show_summary(
                        since=since_value,
                        until=until_value,
                    )
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Show summary failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, summary_payload)
            return

        if parsed.path == "/api/v1/card-transactions":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                limit = int(query.get("limit", ["100"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return
            try:
                offset = int(query.get("offset", ["0"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "offset must be an integer"})
                return
            kind_value = query.get("kind", [""])[0].strip() or None
            try:
                with self.service.request_identity_context(identity):
                    list_payload = self.service.list_card_transactions(
                        limit=limit, offset=offset, kind=kind_value
                    )
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Card transactions load failed: {error}"},
                )
                return
            self._write_json(HTTPStatus.OK, list_payload)
            return

        if parsed.path.startswith("/api/v1/card-transactions/") and parsed.path.endswith("/photo"):
            identity = self._require_request_identity()
            if identity is None:
                return
            transaction_id = unquote(
                parsed.path.removeprefix("/api/v1/card-transactions/").removesuffix("/photo").strip("/")
            )
            if not transaction_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            try:
                with self.service.request_identity_context(identity):
                    object_path = self.service.card_transaction_photo_object_path(transaction_id)
                    if not object_path:
                        self._write_json(
                            HTTPStatus.NOT_FOUND, {"error": "Transaction photo not found"}
                        )
                        return
                    image_bytes = self.service.read_scan_object_bytes(object_path)
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Transaction photo load failed: {error}"},
                )
                return
            if not image_bytes:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Transaction photo not found"})
                return
            self._write_image(HTTPStatus.OK, image_bytes)
            return

        if parsed.path == "/api/v1/portfolio/dashboard":
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self._require_access(identity):
                return
            query = parse_qs(parsed.query)
            time_zone_name = query.get("timeZone", [""])[0].strip() or None
            # The chart's open range — compute only this one; the client fetches
            # the rest on demand via /portfolio/history. Absent → all six (legacy).
            range_key = query.get("range", [""])[0].strip() or None
            if not self._acquire_heavy_read_slot():
                return
            try:
                with self.service.request_identity_context(identity):
                    payload = self.service.portfolio_dashboard(
                        time_zone_name=time_zone_name, range_key=range_key
                    )
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Portfolio dashboard failed: {error}"},
                )
                return
            finally:
                _heavy_read_semaphore.release()
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/v1/portfolio/performance":
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self._require_access(identity):
                return
            if not self._acquire_heavy_read_slot():
                return
            try:
                with self.service.request_identity_context(identity):
                    payload = self.service.portfolio_performance()
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Portfolio performance failed: {error}"},
                )
                return
            finally:
                _heavy_read_semaphore.release()
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/v1/portfolio/transaction-insights":
            identity = self._require_request_identity()
            if identity is None:
                return
            query = parse_qs(parsed.query)
            time_zone_name = query.get("timeZone", [""])[0].strip() or None
            try:
                with self.service.request_identity_context(identity):
                    payload = self.service.transaction_insights(time_zone_name=time_zone_name)
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Transaction insights failed: {error}"},
                )
                return
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/v1/portfolio/insights":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    payload = self.service.portfolio_insights()
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Portfolio insights failed: {error}"},
                )
                return
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path in {"/api/v1/ledger", "/api/v1/portfolio/ledger", "/api/v1/deals"}:
            identity = self._require_request_identity()
            if identity is None:
                return
            query = parse_qs(parsed.query)
            days_value = query.get("days", ["30"])[0]
            range_value = query.get("range", [""])[0].strip() or None
            time_zone_name = query.get("timeZone", [""])[0].strip() or None
            try:
                days = int(days_value)
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "days must be an integer"})
                return
            try:
                limit = int(query.get("limit", ["200"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return
            try:
                offset = int(query.get("offset", ["0"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "offset must be an integer"})
                return
            if not self._acquire_heavy_read_slot():
                return
            try:
                with self.service.request_identity_context(identity):
                    payload = self.service.portfolio_ledger(
                        days=days,
                        range_label=range_value,
                        time_zone_name=time_zone_name,
                        limit=limit,
                        offset=offset,
                    )
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Portfolio ledger failed: {error}"})
                return
            finally:
                _heavy_read_semaphore.release()
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path.startswith("/api/v1/portfolio/imports/"):
            identity = self._require_request_identity()
            if identity is None:
                return
            job_id = unquote(parsed.path.removeprefix("/api/v1/portfolio/imports/").strip("/"))
            if not job_id or "/" in job_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            query_params = parse_qs(parsed.query)
            try:
                limit = int(query_params.get("limit", ["50"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return
            try:
                offset = int(query_params.get("offset", ["0"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "offset must be an integer"})
                return
            status_filter = query_params.get("filter", [""])[0].strip() or query_params.get("status", [""])[0].strip() or None
            try:
                with self.service.request_identity_context(identity):
                    payload = self.service.portfolio_import_job(
                        job_id,
                        status_filter=status_filter,
                        limit=limit,
                        offset=offset,
                    )
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Import job lookup failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/v1/cards/search":
            query_params = parse_qs(parsed.query)
            query = query_params.get("q", [""])[0]
            try:
                limit = int(query_params.get("limit", ["20"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return
            try:
                offset = int(query_params.get("offset", ["0"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "offset must be an integer"})
                return
            self._write_json(HTTPStatus.OK, self.service.search(query, limit=limit, offset=offset))
            return

        if parsed.path == "/api/v1/expansions":
            query_params = parse_qs(parsed.query)
            game = query_params.get("game", ["pokemon"])[0]
            refresh_flag = query_params.get("refresh", ["false"])[0].lower() in ("1", "true", "yes")
            self._write_json(HTTPStatus.OK, self.service.list_expansions(game=game, refresh=refresh_flag))
            return

        expansion_cards_match = re.match(r"^/api/v1/expansions/([^/]+)/cards$", parsed.path)
        if expansion_cards_match:
            expansion_id = expansion_cards_match.group(1)
            query_params = parse_qs(parsed.query)
            query = query_params.get("q", [""])[0]
            try:
                limit = int(query_params.get("limit", ["50"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return
            self._write_json(HTTPStatus.OK, self.service.search_expansion_cards(expansion_id, query=query, limit=limit))
            return

        ebay_listings_suffixes = ("/graded-comps", "/ebay-comps", "/comps", "/ebay-listings")
        matched_ebay_suffix = next(
            (suffix for suffix in ebay_listings_suffixes if parsed.path.startswith("/api/v1/cards/") and parsed.path.endswith(suffix)),
            None,
        )
        if matched_ebay_suffix is not None:
            card_id = parsed.path.removeprefix("/api/v1/cards/").removesuffix(matched_ebay_suffix).rstrip("/")
            if not card_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return

            query = parse_qs(parsed.query)
            grade = query.get("grade", [""])[0].strip() or None
            grader = query.get("grader", [""])[0].strip() or None
            variant = query.get("variant", [""])[0].strip() or None
            if grader is None and grade is not None:
                grader = "PSA"
            try:
                limit = int(query.get("limit", [str(DEFAULT_EBAY_LISTING_LIMIT)])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return

            try:
                payload = self.service.card_ebay_comps(
                    card_id,
                    grader=grader,
                    grade=grade,
                    variant=variant,
                    limit=limit,
                )
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"eBay listings failed: {error}"})
                return

            if payload is None:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Card not found"})
                return

            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path.startswith("/api/v1/cards/") and parsed.path.endswith("/recent-sales"):
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self._require_access(identity):
                return
            card_id = parsed.path.removeprefix("/api/v1/cards/").removesuffix("/recent-sales").rstrip("/")
            if not card_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return

            query = parse_qs(parsed.query)
            grade = query.get("grade", [""])[0].strip() or None
            grader = query.get("grader", [""])[0].strip() or None
            source = query.get("source", ["ebay"])[0].strip() or "ebay"
            variant = query.get("variant", [""])[0].strip() or None
            refresh = query.get("refresh", [""])[0].strip().lower() in {"1", "true", "yes", "on"}
            if grader is None and grade is not None:
                grader = "PSA"
            try:
                limit = int(query.get("limit", [str(RECENT_SALES_DEFAULT_LIMIT)])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return

            try:
                payload = self.service.card_recent_sales(
                    card_id,
                    grader=grader,
                    grade=grade,
                    source=source,
                    variant=variant,
                    limit=limit,
                    refresh=refresh,
                )
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Recent sales failed: {error}"})
                return

            if payload is None:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Card not found"})
                return

            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path.startswith("/api/v1/cards/") and parsed.path.endswith("/raw-pricing-matrix"):
            card_id = parsed.path.removeprefix("/api/v1/cards/").removesuffix("/raw-pricing-matrix").rstrip("/")
            if not card_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return

            try:
                payload = self.service.raw_pricing_matrix(card_id)
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Raw pricing matrix failed: {error}"})
                return

            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path.startswith("/api/v1/cards/") and parsed.path.endswith("/price-trends"):
            card_id = unquote(parsed.path.removeprefix("/api/v1/cards/").removesuffix("/price-trends").rstrip("/"))
            if not card_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return

            query = parse_qs(parsed.query)
            mode = (query.get("mode", ["raw"])[0] or "raw").strip().lower()
            if mode not in {"raw", "graded"}:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "mode must be 'raw' or 'graded'"})
                return
            variant = query.get("variant", [""])[0].strip() or None
            grader = query.get("grader", [""])[0].strip() or None

            try:
                payload = self.service.card_price_trends(
                    card_id,
                    mode=mode,
                    variant=variant,
                    grader=grader,
                )
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Price trends failed: {error}"})
                return

            if payload is None:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Card not found"})
                return

            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path.startswith("/api/v1/cards/") and parsed.path.endswith("/condition-history"):
            card_id = unquote(
                parsed.path.removeprefix("/api/v1/cards/").removesuffix("/condition-history").rstrip("/")
            )
            if not card_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            query = parse_qs(parsed.query)
            lane = (query.get("lane", ["raw"])[0] or "raw").strip().lower()
            if lane not in {"raw", "graded"}:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "lane must be 'raw' or 'graded'"})
                return
            try:
                days = int(query.get("days", ["365"])[0])
            except ValueError:
                days = 365
            try:
                payload = self.service.card_condition_history(card_id, lane=lane, days=days)
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Condition history failed: {error}"})
                return
            if payload is None:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Card not found"})
                return
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path.startswith("/api/v1/cards/") and parsed.path.endswith("/market-history"):
            card_id = parsed.path.removeprefix("/api/v1/cards/").removesuffix("/market-history").rstrip("/")
            if not card_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return

            query = parse_qs(parsed.query)
            grader = query.get("grader", [""])[0].strip() or None
            grade = query.get("grade", [""])[0].strip() or None
            cert_number = query.get("cert", [""])[0].strip() or None
            preferred_variant = query.get("variant", [""])[0].strip() or None
            condition = query.get("condition", [""])[0].strip() or None
            try:
                days = int(query.get("days", ["30"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "days must be an integer"})
                return

            try:
                payload = self.service.card_market_history(
                    card_id,
                    days=days,
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    preferred_variant=preferred_variant,
                    condition=condition,
                )
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Market history failed: {error}"})
                return

            if payload is None:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Card not found"})
                return

            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path.startswith("/api/v1/cards/"):
            card_id = parsed.path.removeprefix("/api/v1/cards/")
            if not card_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return

            query = parse_qs(parsed.query)
            grader = query.get("grader", [""])[0].strip() or None
            grade = query.get("grade", [""])[0].strip() or None
            cert_number = query.get("cert", [""])[0].strip() or None
            preferred_variant = query.get("variant", [""])[0].strip() or None
            identity = None
            auth_header = str(self.headers.get("Authorization") or "").strip()
            if auth_header:
                identity = self._require_request_identity()
                if identity is None:
                    return
            elif not self.service.authenticator.auth_required:
                try:
                    identity = self.service.authenticator.resolve_identity(None)
                except RequestAuthError:
                    identity = None

            with self.service.request_identity_context(identity):
                payload = self.service.card_detail(
                    card_id,
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    preferred_variant=preferred_variant,
                )
            if payload is None:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Card not found"})
                return

            self._write_json(HTTPStatus.OK, payload)
            return

        self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path.startswith("/api/v1/cards/") and parsed.path.endswith("/refresh-pricing"):
            card_id = parsed.path.removeprefix("/api/v1/cards/").removesuffix("/refresh-pricing").rstrip("/")
            if not card_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return

            query = parse_qs(parsed.query)
            force_refresh = query.get("forceRefresh", ["0"])[0].lower() in {"1", "true", "yes"}
            grader = query.get("grader", [""])[0].strip() or None
            grade = query.get("grade", [""])[0].strip() or None
            cert_number = query.get("cert", [""])[0].strip() or None
            preferred_variant = query.get("variant", [""])[0].strip() or None
            try:
                payload = self.service.refresh_card_pricing(
                    card_id,
                    api_key=os.environ.get("SCRYDEX_API_KEY"),
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    preferred_variant=preferred_variant,
                    force_refresh=force_refresh,
                )
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Pricing refresh failed: {error}"})
                return

            if payload is None:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Card not found"})
                return

            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/v1/ops/refresh-visual-index":
            query = parse_qs(parsed.query)
            expected_token = str(os.environ.get("SPOTLIGHT_OPS_REFRESH_TOKEN") or "").strip()
            provided_token = query.get("token", [""])[0].strip()
            if expected_token and provided_token != expected_token:
                self._write_json(HTTPStatus.UNAUTHORIZED, {"error": "invalid ops token"})
                return
            dry_run = query.get("dryRun", ["0"])[0].lower() in {"1", "true", "yes"}
            max_raw = query.get("max", [""])[0].strip()
            max_cards = int(max_raw) if max_raw.isdigit() else None
            try:
                result = self.service.refresh_visual_index(dry_run=dry_run, max_cards=max_cards)
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"visual index refresh failed: {error}"},
                )
                return
            self._write_json(HTTPStatus.OK, result)
            return

        if parsed.path == "/api/v1/ops/prewarm-portfolio":
            query = parse_qs(parsed.query)
            expected_token = str(os.environ.get("SPOTLIGHT_OPS_REFRESH_TOKEN") or "").strip()
            provided_token = query.get("token", [""])[0].strip()
            if expected_token and provided_token != expected_token:
                self._write_json(HTTPStatus.UNAUTHORIZED, {"error": "invalid ops token"})
                return
            # Fire-and-forget: the prewarm can take minutes (one heavy compute
            # per owner), so the caller (the daily sync script) gets an
            # immediate ack instead of blocking on the full warm.
            threading.Thread(
                target=self.service.prewarm_portfolio_dashboards,
                kwargs={"source": "ops"},
                name="portfolio-dashboard-prewarm-ops",
                daemon=True,
            ).start()
            self._write_json(HTTPStatus.OK, {"status": "started"})
            return

        if parsed.path == "/api/v1/ops/backfill-added-baselines":
            query = parse_qs(parsed.query)
            expected_token = str(os.environ.get("SPOTLIGHT_OPS_REFRESH_TOKEN") or "").strip()
            provided_token = query.get("token", [""])[0].strip()
            if expected_token and provided_token != expected_token:
                self._write_json(HTTPStatus.UNAUTHORIZED, {"error": "invalid ops token"})
                return
            dry_run = query.get("dryRun", ["0"])[0].lower() in {"1", "true", "yes"}
            # ?repair=gradedVariantless re-runs ONLY variantless slab rows,
            # overwriting baselines computed before the base-printing-first
            # graded-resolver fix (re-runnable; bypasses the one-shot flag).
            repair_mode = query.get("repair", [""])[0].strip()
            repair_graded_variantless = repair_mode in {"gradedVariantless", "graded_variantless"}
            # Fire-and-forget (same shape as prewarm-portfolio): the backfill
            # walks every NULL-baseline row, so the caller gets an immediate ack
            # instead of blocking on the full pass. One-shot guarded by the
            # added_baseline_backfilled runtime flag; dryRun writes nothing.
            threading.Thread(
                target=self.service.backfill_added_baselines,
                kwargs={
                    "dry_run": dry_run,
                    "source": "ops",
                    "repair_graded_variantless": repair_graded_variantless,
                },
                name="added-baseline-backfill-ops",
                daemon=True,
            ).start()
            self._write_json(HTTPStatus.OK, {"status": "started"})
            return

        payload = self._read_json_body()
        if payload is None:
            self._write_json(
                getattr(self, "_json_body_error_status", HTTPStatus.BAD_REQUEST),
                {"error": getattr(self, "_json_body_error_message", "Invalid JSON body")},
            )
            return

        # --- Public App Store ACCESS GATE: redeem (auth, never access-gated) ---
        if parsed.path == "/api/v1/access/redeem":
            identity = self._require_request_identity()
            if identity is None:
                return
            code = str(payload.get("code") or "")
            with self.service.request_identity_context(identity):
                try:
                    result = self.service.redeem_invite_code(identity, code)
                except ValueError:
                    self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_code"})
                    return
            self._write_json(HTTPStatus.OK, result)
            return

        # --- Public App Store ACCESS GATE: waitlist (auth, never access-gated) ---
        if parsed.path == "/api/v1/access/waitlist":
            identity = self._require_request_identity()
            if identity is None:
                return
            email = str(payload.get("email") or "")
            with self.service.request_identity_context(identity):
                result = self.service.add_waitlist_email(identity, email)
            self._write_json(HTTPStatus.OK, result)
            return

        # --- Public App Store ACCESS GATE: admin gate control (auth + admin) ---
        if parsed.path == "/api/v1/ops/card-show-mode":
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self.service._is_admin_email(getattr(identity, "email", "")):
                self._write_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
                return
            active = bool(payload.get("active"))
            # Plain on/off: ON stays on until the admin turns it OFF.
            if active:
                show_mode_state = self.service.set_card_show_mode()
            else:
                show_mode_state = self.service.clear_card_show_mode()
            self._write_json(HTTPStatus.OK, {**show_mode_state, "accessOpen": active})
            return

        if parsed.path == "/api/v1/ops/access/sync-emails":
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self.service._is_admin_email(getattr(identity, "email", "")):
                self._write_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
                return
            try:
                result = self.service.sync_user_emails_from_supabase()
            except RuntimeError as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "sync_failed"})
                return
            self._write_json(HTTPStatus.OK, result)
            return

        if parsed.path == "/api/v1/ops/access/whitelist":
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self.service._is_admin_email(getattr(identity, "email", "")):
                self._write_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
                return
            email = str(payload.get("email") or "").strip()
            action = str(payload.get("action") or "add").strip().lower()
            try:
                if action == "remove":
                    emails = self.service.remove_whitelist_email(email)
                else:
                    emails = self.service.add_whitelist_email(email)
            except ValueError:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_email"})
                return
            self._write_json(HTTPStatus.OK, {"emails": emails})
            return

        if parsed.path.startswith("/api/v1/cards/") and parsed.path.endswith("/favorite"):
            identity = self._require_request_identity()
            if identity is None:
                return
            card_id = unquote(parsed.path.removeprefix("/api/v1/cards/").removesuffix("/favorite").rstrip("/"))
            if not card_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            raw_is_favorite = payload.get("isFavorite")
            if raw_is_favorite is not None and not isinstance(raw_is_favorite, bool):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "isFavorite must be a boolean or null"})
                return
            try:
                with self.service.request_identity_context(identity):
                    favorite_payload = self.service.set_card_favorite(card_id, is_favorite=raw_is_favorite)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Card favorite update failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, favorite_payload)
            return

        if parsed.path.startswith("/api/v1/cards/") and parsed.path.endswith("/like"):
            identity = self._require_request_identity()
            if identity is None:
                return
            card_id = unquote(parsed.path.removeprefix("/api/v1/cards/").removesuffix("/like").rstrip("/"))
            if not card_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            raw_is_liked = payload.get("isLiked")
            if raw_is_liked is not None and not isinstance(raw_is_liked, bool):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "isLiked must be a boolean or null"})
                return
            try:
                with self.service.request_identity_context(identity):
                    like_payload = self.service.set_card_like(card_id, is_liked=raw_is_liked)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Card like update failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, like_payload)
            return

        if parsed.path == "/api/v1/review/label":
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self._require_reviewer(identity):
                return
            try:
                with self.service.request_identity_context(identity):
                    label_payload = self.service.record_review_label(
                        scan_id=str(payload.get("scanID") or ""),
                        reviewer_user_id=identity.user_id,
                        labeled_card_id=payload.get("labeledCardID"),
                        label_disposition=str(payload.get("labelDisposition") or ""),
                        selected_rank=payload.get("selectedRank"),
                        notes=payload.get("notes"),
                        queue_id=payload.get("queue"),
                        labeled_variant=payload.get("labeledVariant"),
                        mode=str(payload.get("mode") or "pending"),
                    )
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Review label failed: {error}"},
                )
                return
            self._write_json(HTTPStatus.OK, label_payload)
            return

        if parsed.path == "/api/v1/labeling-sessions":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    session_payload = self.service.create_labeling_session(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Labeling session creation failed: {error}"})
                return
            self._write_json(HTTPStatus.CREATED, session_payload)
            return

        labeling_artifact_session_id = _labeling_session_id_from_path(parsed.path, "/artifacts")
        if labeling_artifact_session_id is not None:
            if not labeling_artifact_session_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    artifact_payload = self.service.store_labeling_session_artifact(
                        labeling_artifact_session_id,
                        payload,
                    )
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Labeling artifact upload failed: {error}"})
                return
            self._write_json(HTTPStatus.CREATED, artifact_payload)
            return

        complete_labeling_session_id = _labeling_session_id_from_path(parsed.path, "/complete")
        if complete_labeling_session_id is not None:
            if not complete_labeling_session_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    session_payload = self.service.complete_labeling_session(
                        complete_labeling_session_id,
                        payload,
                    )
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Labeling session completion failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, session_payload)
            return

        abort_labeling_session_id = _labeling_session_id_from_path(parsed.path, "/abort")
        if abort_labeling_session_id is not None:
            if not abort_labeling_session_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    session_payload = self.service.abort_labeling_session(
                        abort_labeling_session_id,
                        payload,
                    )
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Labeling session abort failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, session_payload)
            return

        if parsed.path == "/api/v1/admin/scrydex-sync":
            try:
                page_size = int(payload.get("pageSize", 100))
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "pageSize must be an integer"})
                return
            max_pages_value = payload.get("maxPages")
            try:
                max_pages = int(max_pages_value) if max_pages_value is not None else None
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "maxPages must be an integer or null"})
                return
            language = str(payload.get("language") or "").strip() or None
            scheduled_for = str(payload.get("scheduledFor") or "").strip() or None
            try:
                summary = self.service.run_manual_scrydex_sync(
                    page_size=page_size,
                    max_pages=max_pages,
                    language=language,
                    scheduled_for=scheduled_for,
                )
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Manual Scrydex sync failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, summary)
            return

        if parsed.path == "/api/v1/admin/card-show-mode":
            enabled = payload.get("enabled")
            if enabled is False:
                summary = self.service.clear_card_show_mode()
                self._write_json(HTTPStatus.OK, summary)
                return

            until_value = payload.get("until")
            until = str(until_value or "").strip() or None
            duration_hours_value = payload.get("durationHours")
            try:
                duration_hours = float(duration_hours_value) if duration_hours_value is not None else None
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "durationHours must be a number"})
                return
            note = str(payload.get("note") or "").strip() or None
            try:
                summary = self.service.set_card_show_mode(
                    until=until,
                    duration_hours=duration_hours,
                    note=note,
                )
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            self._write_json(HTTPStatus.OK, summary)
            return

        if parsed.path == "/api/v1/admin/live-pricing":
            enabled = payload.get("enabled")
            if not isinstance(enabled, bool):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "enabled must be a boolean"})
                return
            note = str(payload.get("note") or "").strip() or None
            summary = self.service.set_live_pricing_mode(enabled=enabled, note=note)
            self._write_json(HTTPStatus.OK, summary)
            return

        if parsed.path == "/api/v1/admin/scan-artifact-uploads":
            enabled = payload.get("enabled")
            if not isinstance(enabled, bool):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "enabled must be a boolean"})
                return
            note = str(payload.get("note") or "").strip() or None
            summary = self.service.set_scan_artifact_uploads_mode(enabled=enabled, note=note)
            self._write_json(HTTPStatus.OK, summary)
            return

        if parsed.path == "/api/v1/cards/hydrate-pricing":
            raw_card_ids = payload.get("cardIDs")
            if not isinstance(raw_card_ids, list):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "cardIDs must be a list"})
                return

            slab_context = payload.get("slabContext") or {}
            if slab_context is not None and not isinstance(slab_context, dict):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "slabContext must be an object"})
                return

            try:
                max_refresh_count = int(payload.get("maxRefreshCount", 2))
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "maxRefreshCount must be an integer"})
                return

            force_refresh = bool(payload.get("forceRefresh") is True)
            grader = str(slab_context.get("grader") or "").strip() or None
            grade = str(slab_context.get("grade") or "").strip() or None
            cert_number = str(slab_context.get("certNumber") or "").strip() or None
            preferred_variant = str(slab_context.get("variantName") or "").strip() or None
            try:
                hydration_payload = self.service.hydrate_raw_candidate_pricing(
                    [str(card_id or "").strip() for card_id in raw_card_ids],
                    api_key=os.environ.get("SCRYDEX_API_KEY"),
                    max_refresh_count=max_refresh_count,
                    force_refresh=force_refresh,
                    grader=grader,
                    grade=grade,
                    cert_number=cert_number,
                    preferred_variant=preferred_variant,
                )
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Candidate pricing hydration failed: {error}"})
                return

            self._write_json(HTTPStatus.OK, hydration_payload)
            return

        if parsed.path == "/api/v1/portfolio/imports/preview":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    import_payload = self.service.preview_portfolio_import(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Import preview failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, import_payload)
            return

        if parsed.path.startswith("/api/v1/portfolio/imports/") and parsed.path.endswith("/resolve"):
            identity = self._require_request_identity()
            if identity is None:
                return
            job_id = unquote(
                parsed.path.removeprefix("/api/v1/portfolio/imports/").removesuffix("/resolve").strip("/")
            )
            if not job_id:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "jobID is required"})
                return
            try:
                with self.service.request_identity_context(identity):
                    import_payload = self.service.resolve_portfolio_import(job_id, payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Import resolve failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, import_payload)
            return

        if parsed.path.startswith("/api/v1/portfolio/imports/") and parsed.path.endswith("/commit"):
            identity = self._require_request_identity()
            if identity is None:
                return
            job_id = unquote(
                parsed.path.removeprefix("/api/v1/portfolio/imports/").removesuffix("/commit").strip("/")
            )
            if not job_id:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "jobID is required"})
                return
            try:
                with self.service.request_identity_context(identity):
                    import_payload = self.service.commit_portfolio_import(job_id)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Import commit failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, import_payload)
            return

        if parsed.path in {"/api/v1/sales/batch", "/api/v1/deck/sales/batch", "/api/v1/portfolio/sales/batch"}:
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    sale_payload = self.service.record_sales_batch(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Batch sale recording failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, sale_payload)
            return

        if parsed.path in {"/api/v1/sales", "/api/v1/deck/sales", "/api/v1/portfolio/sales"}:
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    sale_payload = self.service.record_sale(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Sale recording failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, sale_payload)
            return

        if parsed.path == "/api/v1/card-transactions":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    transaction_payload = self.service.create_card_transaction(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Card transaction create failed: {error}"},
                )
                return
            self._write_json(HTTPStatus.CREATED, transaction_payload)
            return

        if parsed.path.startswith("/api/v1/portfolio/sales/") and parsed.path.endswith("/price"):
            identity = self._require_request_identity()
            if identity is None:
                return
            transaction_id = unquote(
                parsed.path.removeprefix("/api/v1/portfolio/sales/").removesuffix("/price").strip("/")
            )
            if not transaction_id:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "transactionID is required"})
                return
            try:
                with self.service.request_identity_context(identity):
                    update_payload = self.service.update_portfolio_sale_price(transaction_id, payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Sale price update failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, update_payload)
            return

        if parsed.path in {"/api/v1/buys", "/api/v1/deck/buys", "/api/v1/portfolio/buys"}:
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    buy_payload = self.service.record_buy(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Buy recording failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, buy_payload)
            return

        if parsed.path.startswith("/api/v1/portfolio/buys/") and parsed.path.endswith("/price"):
            identity = self._require_request_identity()
            if identity is None:
                return
            transaction_id = unquote(
                parsed.path.removeprefix("/api/v1/portfolio/buys/").removesuffix("/price").strip("/")
            )
            if not transaction_id:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "transactionID is required"})
                return
            try:
                with self.service.request_identity_context(identity):
                    update_payload = self.service.update_portfolio_buy_price(transaction_id, payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Buy price update failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, update_payload)
            return

        if parsed.path == "/api/v1/scan/match":
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self._require_access(identity):
                return
            if not self._acquire_scan_inference_slot():
                return
            try:
                with self.service.request_identity_context(identity):
                    self._write_json(
                        HTTPStatus.OK,
                        self.service.match_scan(payload),
                    )
            except Exception as error:
                traceback.print_exc()
                with self.service.request_identity_context(identity):
                    self.service._emit_structured_log(self.service._scan_error_log_payload(payload, error))
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": "Scan match failed",
                        "errorType": type(error).__name__,
                    },
                )
            finally:
                _scan_inference_semaphore.release()
            return

        if parsed.path == "/api/v1/scan/visual-match":
            identity = self._require_request_identity()
            if identity is None:
                return
            if not self._acquire_scan_inference_slot():
                return
            try:
                with self.service.request_identity_context(identity):
                    self._write_json(
                        HTTPStatus.OK,
                        self.service.visual_match_scan(payload),
                    )
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": "Visual scan match failed",
                        "errorType": type(error).__name__,
                    },
                )
            finally:
                _scan_inference_semaphore.release()
            return

        if parsed.path == "/api/v1/scan/rerank":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    self._write_json(
                        HTTPStatus.OK,
                        self.service.rerank_visual_match(payload),
                    )
            except ValueError as error:
                self._write_json(
                    HTTPStatus.CONFLICT,
                    {
                        "error": str(error),
                        "errorType": type(error).__name__,
                    },
                )
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": "Scan rerank failed",
                        "errorType": type(error).__name__,
                    },
                )
            return

        if parsed.path == "/api/v1/scan-artifacts":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    artifact_payload = self.service.store_scan_artifacts(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Artifact upload failed: {error}"})
                return
            self._write_json(HTTPStatus.ACCEPTED, artifact_payload)
            return

        if parsed.path == "/api/v1/scan/feedback":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    self.service.log_feedback(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Scan feedback failed: {error}"})
                return
            self._write_json(HTTPStatus.ACCEPTED, {"status": "accepted"})
            return

        if parsed.path == "/api/v1/deck/entries":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    deck_payload = self.service.create_deck_entry(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Deck entry creation failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, deck_payload)
            return

        if parsed.path == "/api/v1/deck/entries/condition":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    update_payload = self.service.update_deck_entry_condition(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Deck condition update failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, update_payload)
            return

        if parsed.path == "/api/v1/deck/entries/replace":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    update_payload = self.service.replace_deck_entry(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Deck entry replace failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, update_payload)
            return

        if parsed.path == "/api/v1/deck/entries/delete":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    delete_payload = self.service.delete_deck_entry(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Deck entry delete failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, delete_payload)
            return

        if parsed.path == "/api/v1/deck/entries/delete-bulk":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    delete_payload = self.service.delete_deck_entries(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Deck entries bulk delete failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, delete_payload)
            return

        if parsed.path == "/api/v1/account/delete":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    account_payload = self.service.delete_account(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except RequestAuthError as error:
                self._write_json(HTTPStatus.UNAUTHORIZED, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Account deletion failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, account_payload)
            return

        if parsed.path == "/api/v1/deck/entries/quantity":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    quantity_payload = self.service.set_deck_entry_quantity(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Deck quantity update failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, quantity_payload)
            return

        if parsed.path == "/api/v1/deck/entries/purchase-price":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    update_payload = self.service.update_deck_entry_purchase_price(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Deck purchase price update failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, update_payload)
            return

        if parsed.path == "/api/v1/deck/entries/cost-basis":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    update_payload = self.service.update_deck_entry_cost_basis(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Cost basis update failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, update_payload)
            return

        if parsed.path == "/api/v1/deck/entries/listing":
            identity = self._require_request_identity()
            if identity is None:
                return
            try:
                with self.service.request_identity_context(identity):
                    update_payload = self.service.update_deck_entry_listing(payload)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Listing update failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, update_payload)
            return

        self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)

        if (
            parsed.path.startswith("/api/v1/card-transactions/")
            and not parsed.path.endswith("/photo")
        ):
            identity = self._require_request_identity()
            if identity is None:
                return
            transaction_id = unquote(
                parsed.path.removeprefix("/api/v1/card-transactions/").strip("/")
            )
            if not transaction_id or "/" in transaction_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            try:
                with self.service.request_identity_context(identity):
                    delete_payload = self.service.delete_card_transaction(transaction_id)
            except ValueError as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except FileNotFoundError as error:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                return
            except Exception as error:
                traceback.print_exc()
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Card transaction delete failed: {error}"},
                )
                return
            self._write_json(HTTPStatus.OK, delete_payload)
            return

        self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _read_json_body(self) -> dict[str, Any] | None:
        self._json_body_error_status = None
        self._json_body_error_message = None
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json_body_error_status = HTTPStatus.BAD_REQUEST
            self._json_body_error_message = "Content-Length must be an integer"
            return None
        if content_length < 0:
            self._json_body_error_status = HTTPStatus.BAD_REQUEST
            self._json_body_error_message = "Content-Length must be non-negative"
            return None
        request_path = urlparse(getattr(self, "path", "")).path
        max_body_bytes = (
            SCAN_ARTIFACT_JSON_BODY_LIMIT_BYTES
            if _is_large_image_upload_path(request_path)
            else DEFAULT_JSON_BODY_LIMIT_BYTES
        )
        if content_length > max_body_bytes:
            self._json_body_error_status = HTTPStatus.REQUEST_ENTITY_TOO_LARGE
            self._json_body_error_message = f"JSON body exceeds {max_body_bytes} bytes"
            return None

        body = self.rfile.read(content_length)
        # An absent/empty body is a valid POST — treat it as an empty object so
        # bodyless requests (e.g. /api/v1/account/delete) reach their handler
        # instead of being rejected with a 400 before dispatch.
        if not body.strip():
            return {}
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            self._json_body_error_status = HTTPStatus.BAD_REQUEST
            self._json_body_error_message = "Invalid JSON body"
            return None

    def _write_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            print(
                "[HTTP] Client disconnected before response write completed: "
                f"path={getattr(self, 'path', '<unknown>')} status={status.value}"
            )


def cli_value(flag: str) -> str | None:
    if flag not in sys.argv:
        return None
    index = sys.argv.index(flag)
    if index + 1 >= len(sys.argv):
        raise SystemExit(f"Missing value for {flag}")
    return sys.argv[index + 1]


def cli_int_value(flag: str, default: int) -> int:
    value = cli_value(flag)
    return int(value) if value is not None else default


def bootstrap_backend(
    root: Path,
    database_path_override: str | None = None,
) -> Path:
    repo_root = root.parent
    data_directory = root / "data"
    data_directory.mkdir(parents=True, exist_ok=True)

    database_path = Path(database_path_override) if database_path_override else data_directory / "spotlight_scanner.sqlite"
    schema_path = root / "schema.sql"

    connection = connect(database_path)
    apply_schema(connection, schema_path)
    connection.close()
    return database_path


def main() -> None:
    root = Path(__file__).resolve().parent
    repo_root = root.parent
    config = ServerConfig(
        host=cli_value("--host") or os.environ.get("SPOTLIGHT_HOST", "127.0.0.1"),
        port=cli_int_value("--port", int(os.environ.get("SPOTLIGHT_PORT", "8788"))),
    )
    database_path = bootstrap_backend(
        root,
        database_path_override=cli_value("--database-path") or os.environ.get("SPOTLIGHT_DATABASE_PATH"),
    )

    SpotlightRequestHandler.service = SpotlightScanService(database_path, repo_root)
    startup_visual_runtime = SpotlightRequestHandler.service._prewarm_raw_visual_runtime(run_inference=False)
    SpotlightRequestHandler.service._emit_structured_log(
        {
            "severity": "INFO",
            "event": "visual_runtime_prewarm",
            "source": "startup",
            **startup_visual_runtime,
        }
    )
    server = SpotlightThreadingHTTPServer((config.host, config.port), SpotlightRequestHandler)
    print(f"Ekalight scan service listening on http://{config.host}:{config.port}", flush=True)

    if _env_flag(PORTFOLIO_DASHBOARD_PREWARM_ENV, default=True):
        delay_raw = os.environ.get(PORTFOLIO_DASHBOARD_PREWARM_DELAY_ENV)
        try:
            prewarm_delay = (
                float(delay_raw)
                if delay_raw
                else DEFAULT_PORTFOLIO_DASHBOARD_PREWARM_DELAY_SECONDS
            )
        except (TypeError, ValueError):
            prewarm_delay = DEFAULT_PORTFOLIO_DASHBOARD_PREWARM_DELAY_SECONDS
        threading.Thread(
            target=SpotlightRequestHandler.service.prewarm_portfolio_dashboards,
            kwargs={"delay_seconds": prewarm_delay},
            name="portfolio-dashboard-prewarm",
            daemon=True,
        ).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Ekalight scan service", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
