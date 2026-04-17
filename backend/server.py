from __future__ import annotations

import base64
import json
import os
import re
import sqlite3
import sys
import traceback
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from time import perf_counter
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
from zoneinfo import ZoneInfo

from env_loader import load_backend_env_file as _load_backend_env_file


_load_backend_env_file(Path(__file__).resolve().parent / ".env")

from catalog_tools import (
    _coerce_price_summary_from_entry,
    _graded_contexts_payload,
    _graded_variants_for_context,
    _raw_context_conditions,
    _raw_context_entry,
    _raw_context_variants,
    _raw_contexts_payload,
    _resolve_graded_context_entry,
    _resolve_raw_context_summary,
    DEFAULT_RAW_CONDITION,
    MATCHER_VERSION,
    RAW_PRICING_MODE,
    RawDecisionResult,
    RawEvidence,
    RawRetrievalPlan,
    RawSignalScores,
    apply_schema,
    build_raw_evidence,
    build_raw_retrieval_plan,
    canonicalize_collector_number,
    card_by_id,
    cards_by_ids,
    append_deck_entry_event,
    connect,
    contextual_pricing_summary_for_card,
    deck_entry_storage_key,
    delete_runtime_setting,
    finalize_raw_decision,
    latest_price_history_update_for_context,
    latest_price_history_row_for_card,
    latest_provider_sync_run,
    load_index,
    merge_raw_candidate_pools,
    price_history_rows_for_card,
    price_snapshot_row,
    provider_sync_run_is_fresh,
    rank_raw_candidates,
    raw_debug_payload,
    rank_visual_hybrid_candidates,
    resolver_mode_for_payload,
    score_raw_candidate_resolution,
    score_raw_candidate_retrieval,
    score_raw_signals,
    search_cards,
    search_cards_local,
    search_cards_local_collector_only,
    search_cards_local_collector_set,
    search_cards_local_title_only,
    search_cards_local_title_set,
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
    record_sale_event,
    utc_now,
)
from fx_rates import decorate_pricing_summary_with_fx
from ebay_comps import fetch_graded_card_ebay_comps
from pricecharting_adapter import PriceChartingProvider
from pricing_provider import PricingProviderRegistry
from scrydex_adapter import (
    SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
    SCRYDEX_PROVIDER,
    ScrydexProvider,
    best_remote_scrydex_raw_candidates,
    fetch_scrydex_card_by_id,
    fetch_scrydex_price_history,
    map_scrydex_catalog_card,
    persist_scrydex_price_history_payload,
    persist_scrydex_raw_snapshot,
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

_OMIT_STRUCTURED_LOG_VALUE = object()

MANUAL_SCRYDEX_MIRROR_ENV = "SPOTLIGHT_MANUAL_SCRYDEX_MIRROR"
LIVE_PRICING_ENABLED_ENV = "SPOTLIGHT_LIVE_PRICING_ENABLED"
SCAN_ARTIFACT_UPLOADS_ENABLED_ENV = "SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED"
CARD_SHOW_MODE_SETTING_KEY = "card_show_mode"
LIVE_PRICING_SETTING_KEY = "live_pricing"
SCAN_ARTIFACT_UPLOADS_SETTING_KEY = "scan_artifact_uploads"
DEFAULT_CARD_SHOW_MODE_HOURS = 8.0
LIVE_PRICING_REFRESH_WINDOW_HOURS = 1.0
DECK_CARD_CONDITIONS = {
    "near_mint",
    "lightly_played",
    "moderately_played",
    "heavily_played",
    "damaged",
}


def _env_flag(name: str, *, default: bool = False) -> bool:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    return str(raw_value).strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8787


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


@dataclass(frozen=True)
class PricingContext:
    mode: str
    grader: str | None = None
    grade: str | None = None
    cert_number: str | None = None
    preferred_variant: str | None = None
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
    created_at: float
    request_payload: dict[str, Any]
    visual_matches: list[Any]
    visual_debug: dict[str, Any]
    requested_top_k: int
    visual_match_ms: float


class SpotlightScanService:
    def __init__(self, database_path: Path, repo_root: Path) -> None:
        self.database_path = database_path
        self.repo_root = repo_root
        self.connection = connect(database_path)
        self.index = load_index(self.connection)
        self._card_lookup_cache: dict[str, dict[str, Any] | None] = {}
        self._raw_visual_matcher: Any | None = None
        self._pending_visual_scans: dict[str, PendingVisualScan] = {}
        self._pending_visual_scan_ttl_seconds: float = 90.0
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

    def refresh_index(self) -> None:
        self.index = load_index(self.connection)
        self._card_lookup_cache.clear()

    def _raw_visual_matcher_instance(self) -> Any:
        if self._raw_visual_matcher is None:
            from raw_visual_matcher import RawVisualMatcher

            self._raw_visual_matcher = RawVisualMatcher(repo_root=self.repo_root)
        return self._raw_visual_matcher

    def _prune_pending_visual_scans(self) -> None:
        cutoff = perf_counter() - self._pending_visual_scan_ttl_seconds
        for scan_id, pending in list(self._pending_visual_scans.items()):
            if pending.created_at < cutoff:
                self._pending_visual_scans.pop(scan_id, None)

    def _store_pending_visual_scan(
        self,
        *,
        scan_id: str,
        request_payload: dict[str, Any],
        visual_matches: list[Any],
        visual_debug: dict[str, Any],
        requested_top_k: int,
        visual_match_ms: float,
    ) -> None:
        scan_id = str(scan_id or "").strip()
        if not scan_id:
            return
        self._prune_pending_visual_scans()
        pending = PendingVisualScan(
            scan_id=scan_id,
            created_at=perf_counter(),
            request_payload=dict(request_payload or {}),
            visual_matches=list(visual_matches),
            visual_debug=dict(visual_debug or {}),
            requested_top_k=max(1, int(requested_top_k)),
            visual_match_ms=float(visual_match_ms),
        )
        self._pending_visual_scans[scan_id] = pending
        top_candidate_id = ""
        if pending.visual_matches:
            top_candidate_id = str(getattr(pending.visual_matches[0].entry, "card_id", "") or "")
        print(
            "[SCAN CACHE] Stored visual shortlist: "
            f"scanID={scan_id} "
            f"topK={pending.requested_top_k} "
            f"matches={len(pending.visual_matches)} "
            f"visualMatchMs={pending.visual_match_ms:.1f} "
            f"top1={top_candidate_id or '<none>'}"
        )

    def _pending_visual_scan(self, scan_id: str) -> PendingVisualScan | None:
        scan_id = str(scan_id or "").strip()
        if not scan_id:
            return None
        self._prune_pending_visual_scans()
        pending = self._pending_visual_scans.get(scan_id)
        if pending is None:
            print(f"[SCAN CACHE] Missed visual shortlist: scanID={scan_id}")
            return None
        age_ms = (perf_counter() - pending.created_at) * 1000.0
        print(
            "[SCAN CACHE] Reusing visual shortlist: "
            f"scanID={scan_id} "
            f"ageMs={age_ms:.1f} "
            f"matches={len(pending.visual_matches)} "
            f"visualMatchMs={pending.visual_match_ms:.1f}"
        )
        return pending

    def _clear_pending_visual_scan(self, scan_id: str) -> None:
        scan_id = str(scan_id or "").strip()
        if scan_id:
            self._pending_visual_scans.pop(scan_id, None)

    def _run_raw_visual_phase(
        self,
        payload: dict[str, Any],
        *,
        requested_top_k: int,
    ) -> tuple[list[Any], dict[str, Any], float]:
        started_at = perf_counter()
        matches, debug = self._raw_visual_matcher_instance().match_payload(payload, top_k=requested_top_k)
        visual_match_ms = (perf_counter() - started_at) * 1000.0
        return list(matches), dict(debug or {}), visual_match_ms

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
    ) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
        ranked_matches = [self._visual_match_summary(match) for match in matches]
        confidence, ambiguity_flags = self._visual_confidence(ranked_matches)
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

        response = {
            "scanID": payload["scanID"],
            "topCandidates": encoded_candidates,
            "confidence": confidence,
            "ambiguityFlags": ambiguity_flags,
            "matcherSource": "visualIndex",
            "matcherVersion": MATCHER_VERSION,
            "resolverMode": "raw_card",
            "resolverPath": "visual_only_index",
            "slabContext": None,
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
        }
        self._record_backend_timing(
            response,
            visualMatchMs=round(float(visual_match_ms), 3),
            candidateEncodeMs=encode_debug.get("candidateEncodeMs"),
            encodedCandidateCount=encode_debug.get("encodedCandidateCount"),
            candidateTimings=encode_debug.get("candidateTimings"),
            responseBuildMs=(perf_counter() - response_build_started_at) * 1000.0,
        )
        if finalize_response:
            self._finalize_scan_response(payload, response, scored_candidates)
        return response, scored_candidates, ranked_matches

    def _prewarm_raw_visual_runtime(self) -> dict[str, Any]:
        started_at = perf_counter()
        try:
            matcher = self._raw_visual_matcher_instance()
            if hasattr(matcher, "prewarm"):
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
        normalized_range = str(range_label or "").strip().upper() or None
        if normalized_range == "7D":
            start_date = end_date - timedelta(days=6)
        elif normalized_range == "30D":
            start_date = end_date - timedelta(days=29)
        elif normalized_range == "90D":
            start_date = end_date - timedelta(days=89)
        elif normalized_range == "ALL" and earliest_at is not None:
            start_date = earliest_at.astimezone(time_zone).date()
        return time_zone, start_date, end_date

    def _card_show_mode_record(self) -> dict[str, Any] | None:
        return runtime_setting(self.connection, CARD_SHOW_MODE_SETTING_KEY)

    def _card_show_mode_state(self) -> dict[str, Any]:
        record = self._card_show_mode_record()
        payload = (record or {}).get("value") if isinstance(record, dict) else {}
        if not isinstance(payload, dict):
            payload = {}

        until_raw = str(payload.get("until") or "").strip() or None
        set_at = str(payload.get("setAt") or "").strip() or None
        note = str(payload.get("note") or "").strip() or None

        now = datetime.now(timezone.utc)
        until_at = self._coerce_utc_datetime(until_raw)
        active = bool(until_at is not None and until_at > now)
        remaining_seconds = max(0, int((until_at - now).total_seconds())) if until_at is not None else 0

        return {
            "active": active,
            "until": until_at.isoformat() if until_at is not None else until_raw,
            "setAt": set_at,
            "note": note,
            "remainingSeconds": remaining_seconds,
        }

    def _card_show_mode_active(self) -> bool:
        return bool(self._card_show_mode_state().get("active"))

    def set_card_show_mode(
        self,
        *,
        until: str | None = None,
        duration_hours: float | None = None,
        note: str | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        if until is not None:
            until_at = self._coerce_utc_datetime(until)
            if until_at is None:
                raise ValueError("until must be an ISO-8601 timestamp")
        else:
            hours = float(duration_hours if duration_hours is not None else DEFAULT_CARD_SHOW_MODE_HOURS)
            if hours <= 0:
                raise ValueError("durationHours must be greater than 0")
            until_at = now + timedelta(hours=hours)

        upsert_runtime_setting(
            self.connection,
            key=CARD_SHOW_MODE_SETTING_KEY,
            value={
                "until": until_at.isoformat(),
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

    def _live_scrydex_imports_allowed(self) -> bool:
        if self._manual_scrydex_mirror_enabled():
            return False
        return not self._scrydex_full_catalog_sync_is_fresh()

    def _live_scrydex_pricing_refresh_allowed(self) -> bool:
        return self._live_pricing_enabled()

    def _live_scrydex_queries_blocked(self) -> bool:
        return not (
            self._live_scrydex_searches_allowed()
            or self._live_scrydex_imports_allowed()
            or self._live_scrydex_pricing_refresh_allowed()
        )

    def live_scrydex_queries_allowed(self) -> bool:
        return not self._live_scrydex_queries_blocked()

    def _manual_scrydex_mirror_status(self) -> dict[str, Any]:
        full_sync_fresh = self._scrydex_full_catalog_sync_is_fresh()
        searches_allowed = self._live_scrydex_searches_allowed()
        imports_allowed = self._live_scrydex_imports_allowed()
        pricing_refresh_allowed = self._live_scrydex_pricing_refresh_allowed()
        return {
            "enabled": self._manual_scrydex_mirror_enabled(),
            "fullCatalogSyncFresh": full_sync_fresh,
            "searchesAllowed": searches_allowed,
            "searchesBlocked": not searches_allowed,
            "importsAllowed": imports_allowed,
            "importsBlocked": not imports_allowed,
            "pricingRefreshAllowed": pricing_refresh_allowed,
            "pricingRefreshBlocked": not pricing_refresh_allowed,
            "liveQueriesBlocked": not (searches_allowed or imports_allowed or pricing_refresh_allowed),
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
        details = [
            {
                "type": str(entry.get("type") or "unknown"),
                "path": str(entry.get("path") or ""),
                "query": str(entry.get("query") or "").strip() or None,
            }
            for entry in recent_entries
        ]
        server_processing_ms = max(0.0, (perf_counter() - started_at) * 1000.0)
        matching_stage = str(response.get("matchingStage") or "").strip() or "unknown"
        response["performance"] = {
            "serverProcessingMs": round(server_processing_ms, 3),
            "scrydexRequestCount": delta,
            "scrydexRequestTypes": types,
        }
        visual_hybrid_debug = ((response.get("rawDecisionDebug") or {}).get("visualHybrid") or {})
        phase_timings = visual_hybrid_debug.get("phaseTimings") or {}
        matcher_timings = visual_hybrid_debug.get("timings") or {}
        backend_timings = response.get("backendTimingDebug") or {}
        backend_timing_summary = {
            key: round(float(value), 3)
            for key, value in backend_timings.items()
            if isinstance(value, (int, float))
        }
        if phase_timings or matcher_timings:
            response["performance"]["phaseTimings"] = phase_timings
            response["performance"]["matcherTimings"] = matcher_timings
        if backend_timings:
            response["performance"]["backendTimings"] = backend_timings
        print(
            "[MATCH PERF] "
            f"scan={scan_id} "
            f"stage={matching_stage} "
            f"resolverPath={response.get('resolverPath') or 'unknown'} "
            f"confidence={response.get('confidence') or 'unknown'} "
            f"serverMs={server_processing_ms:.1f} "
            f"requests={delta} "
            f"types={types or ['none']} "
            f"details={details or []}"
        )
        if backend_timing_summary:
            print(
                "[MATCH PERF TIMING] "
                f"scan={scan_id} "
                f"stage={matching_stage} "
                f"backend={backend_timing_summary}"
            )
        if phase_timings or matcher_timings or backend_timings:
            print(
                "[MATCH PERF DETAIL] "
                f"scan={scan_id} "
                f"phases={phase_timings or {}} "
                f"matcher={matcher_timings or {}} "
                f"backend={backend_timings or {}}"
            )

    def _display_pricing_summary_for_card(
        self,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
        preferred_variant: str | None = None,
    ) -> dict[str, Any] | None:
        pricing_context = (
            self._slab_pricing_context(
                grader=grader,
                grade=grade,
                preferred_variant=preferred_variant,
            )
            if grader or grade
            else self._raw_pricing_context()
        )
        return self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context)

    @staticmethod
    def _raw_pricing_context() -> PricingContext:
        return PricingContext(mode="raw")

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
    ) -> dict[str, Any] | None:
        if snapshot_row is not None:
            pricing = self._pricing_summary_from_snapshot_row(
                snapshot_row,
                pricing_context=pricing_context,
            )
            if pricing is not None:
                return pricing

        pricing = contextual_pricing_summary_for_card(
            self.connection,
            card_id,
            grader=pricing_context.grader,
            grade=pricing_context.grade,
            variant=pricing_context.preferred_variant,
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

    def _pricing_summary_from_snapshot_row(
        self,
        snapshot_row: sqlite3.Row,
        *,
        pricing_context: PricingContext,
    ) -> dict[str, Any] | None:
        updated_at = snapshot_row["updated_at"]
        is_fresh = False
        if updated_at:
            try:
                refreshed = datetime.fromisoformat(str(updated_at))
                is_fresh = datetime.now(timezone.utc) - refreshed <= timedelta(hours=24)
            except ValueError:
                is_fresh = False

        raw_contexts = _raw_contexts_payload(snapshot_row["raw_contexts_json"])
        graded_contexts = _graded_contexts_payload(snapshot_row["graded_contexts_json"])

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

        if pricing_context.is_graded:
            entry = _resolve_graded_context_entry(
                graded_contexts,
                grader=pricing_context.grader,
                grade=pricing_context.grade,
                variant=pricing_context.preferred_variant,
            )
            summary = _coerce_price_summary_from_entry(entry)
            if summary is None:
                entry = _resolve_graded_context_entry(
                    graded_contexts,
                    grader=pricing_context.grader,
                    grade=pricing_context.grade,
                    variant=None,
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
                condition=DEFAULT_RAW_CONDITION,
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

    def _price_snapshot_rows_by_card_id(self, card_ids: list[str]) -> dict[str, sqlite3.Row]:
        normalized_ids = [str(card_id or "").strip() for card_id in card_ids if str(card_id or "").strip()]
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
            return _raw_contexts_payload(row["raw_contexts_json"])
        history_row = latest_price_history_row_for_card(
            self.connection,
            card_id,
            provider=SCRYDEX_PROVIDER,
        )
        if history_row is None:
            return {}
        return _raw_contexts_payload(history_row["raw_contexts_json"])

    def _snapshot_graded_contexts(self, card_id: str) -> dict[str, Any]:
        row = price_snapshot_row(self.connection, card_id)
        if row is not None:
            return _graded_contexts_payload(row["graded_contexts_json"])
        history_row = latest_price_history_row_for_card(
            self.connection,
            card_id,
            provider=SCRYDEX_PROVIDER,
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
                provider=SCRYDEX_PROVIDER,
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
                provider=SCRYDEX_PROVIDER,
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
                    provider=SCRYDEX_PROVIDER,
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
                    provider=SCRYDEX_PROVIDER,
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
                "source": SCRYDEX_PROVIDER,
                "isFresh": self._history_is_fresh(refreshed_at),
                "refreshedAt": refreshed_at,
                "livePricingEnabled": self._live_pricing_enabled(),
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
            provider=SCRYDEX_PROVIDER,
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
            provider=SCRYDEX_PROVIDER,
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
        points = self._history_points_payload(rows)
        latest_point = points[-1] if points else None
        current_price = self._history_primary_price_value(latest_point) or self._primary_price_value(pricing_summary)
        currency_code = str((rows[0].get("currencyCode") if rows else None) or (pricing_summary or {}).get("currencyCode") or "USD")
        refreshed_at = latest_price_history_update_for_context(
            self.connection,
            card_id=card_id,
            pricing_mode="raw",
            provider=SCRYDEX_PROVIDER,
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
            "source": SCRYDEX_PROVIDER,
            "isFresh": self._history_is_fresh(refreshed_at),
            "refreshedAt": refreshed_at,
            "livePricingEnabled": self._live_pricing_enabled(),
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

        pricing_mode = "graded" if str(entry.get("itemKind") or "").strip().lower() == "slab" else "raw"
        grader = str(entry.get("grader") or "").strip() or None
        grade = str(entry.get("grade") or "").strip() or None
        variant_name = str(entry.get("variantName") or "").strip() or None
        row = latest_price_history_row_for_card(
            self.connection,
            card_id,
            provider=SCRYDEX_PROVIDER,
            as_of_date=as_of_date.isoformat(),
        )
        if row is None:
            return None

        if pricing_mode == "graded":
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

        _, _, summary = _resolve_raw_context_summary(
            _raw_contexts_payload(row["raw_contexts_json"]),
            variant=variant_name,
            condition=condition_code,
        )
        if summary is None and self._history_primary_price_value(
            {
                "market": row["default_raw_market_price"],
                "mid": row["default_raw_mid_price"],
                "low": row["default_raw_low_price"],
                "high": row["default_raw_high_price"],
            }
        ) is not None:
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

    def deck_history(
        self,
        *,
        days: int = 30,
        range_label: str | None = None,
        time_zone_name: str | None = None,
    ) -> dict[str, Any]:
        normalized_range = str(range_label or "").strip().upper() or None
        earliest_at: datetime | None = None
        if normalized_range == "ALL":
            earliest_row = self.connection.execute(
                """
                SELECT MIN(created_at) AS earliest_at
                FROM deck_entry_events
                """
            ).fetchone()
            earliest_raw = str(earliest_row["earliest_at"] if earliest_row is not None else "").strip()
            earliest_at = self._coerce_utc_datetime(earliest_raw)
            if earliest_at is None:
                earliest_row = self.connection.execute(
                    """
                    SELECT MIN(added_at) AS earliest_at
                    FROM deck_entries
                    """
                ).fetchone()
                earliest_raw = str(earliest_row["earliest_at"] if earliest_row is not None else "").strip()
                earliest_at = self._coerce_utc_datetime(earliest_raw)
        time_zone, start_date, end_date = self._portfolio_date_bounds(
            days=days,
            range_label=normalized_range,
            time_zone_name=time_zone_name,
            earliest_at=earliest_at,
        )

        entry_rows = self.connection.execute(
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
                cost_basis_total,
                cost_basis_currency_code,
                added_at
            FROM deck_entries
            ORDER BY added_at ASC, id ASC
            """
        ).fetchall()
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
        for row in entry_rows:
            deck_entry_id = str(row["id"] or "").strip()
            if not deck_entry_id:
                continue
            snapshot_by_id[deck_entry_id] = {
                "deckEntryID": deck_entry_id,
                "itemKind": str(row["item_kind"] or "").strip(),
                "cardID": str(row["card_id"] or "").strip(),
                "grader": str(row["grader"] or "").strip() or None,
                "grade": str(row["grade"] or "").strip() or None,
                "certNumber": str(row["cert_number"] or "").strip() or None,
                "variantName": str(row["variant_name"] or "").strip() or None,
                "condition": str(row["condition"] or "").strip() or None,
                "costBasisTotal": float(row["cost_basis_total"] or 0.0),
                "costBasisCurrencyCode": str(row["cost_basis_currency_code"] or "").strip() or None,
                "addedAt": str(row["added_at"] or "").strip() or None,
            }

        event_rows = self.connection.execute(
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
            ORDER BY deck_entry_events.created_at ASC, deck_entry_events.id ASC
            """
        ).fetchall()

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

        for deck_entry_id, snapshot in snapshot_by_id.items():
            if deck_entry_id in seen_event_entries:
                continue
            quantity_row = self.connection.execute(
                "SELECT quantity FROM deck_entries WHERE id = ? LIMIT 1",
                (deck_entry_id,),
            ).fetchone()
            quantity = max(0, int(quantity_row["quantity"] if quantity_row is not None else 0))
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
        current_day = start_date
        last_day_value = 0.0
        last_day_priced = 0
        last_day_unpriced = 0

        while current_day <= end_date:
            next_day_start_utc = self._portfolio_day_start(current_day + timedelta(days=1), time_zone).astimezone(timezone.utc)
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
                if kind in {"add", "buy", "sale", "seed"}:
                    state["quantity"] = int(state.get("quantity") or 0) + int(event.get("quantityDelta") or 0)
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
                row = self._portfolio_history_price_row_for_entry_on_day(
                    {
                        "itemKind": snapshot.get("itemKind"),
                        "cardID": snapshot.get("cardID"),
                        "grader": snapshot.get("grader"),
                        "grade": snapshot.get("grade"),
                        "variantName": snapshot.get("variantName"),
                    },
                    as_of_date=current_day,
                    condition_code=condition_code,
                )
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
                }
            )
            current_day += timedelta(days=1)

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
        normalized_range = str(range_label or "").strip().upper() or None
        earliest_at: datetime | None = None
        if normalized_range == "ALL":
            earliest_row = self.connection.execute(
                """
                SELECT MIN(created_at) AS earliest_at
                FROM (
                    SELECT created_at FROM deck_entry_events WHERE event_kind = 'buy'
                    UNION ALL
                    SELECT sold_at AS created_at FROM sale_events
                )
                """
            ).fetchone()
            earliest_raw = str(earliest_row["earliest_at"] if earliest_row is not None else "").strip()
            earliest_at = self._coerce_utc_datetime(earliest_raw)
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
              AND created_at >= ?
              AND created_at < ?
            ORDER BY deck_entry_events.created_at DESC, deck_entry_events.id DESC
            """,
            (start_dt, end_dt),
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
                sale_events.note,
                sale_events.sold_at,
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
            ORDER BY sale_events.sold_at DESC, sale_events.id DESC
            """,
            (start_dt, end_dt),
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
            if any([grader, grade, cert_number, variant_name]):
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
                    "costBasisTotal": cost_basis_total,
                    "grossProfit": gross,
                    "occurredAt": str(row["sold_at"] or "").strip(),
                    "note": str(row["note"] or "").strip() or None,
                }
            )

        transactions.sort(key=lambda item: (item["occurredAt"], item["id"]), reverse=True)
        inventory_summary = self.deck_entries(limit=1000, offset=0, include_inactive=False)["summary"]

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

    def record_buy(self, payload: dict[str, Any]) -> dict[str, Any]:
        card_id = str(payload.get("cardID") or "").strip()
        if not card_id:
            raise ValueError("cardID is required")

        slab_context = payload.get("slabContext") if isinstance(payload.get("slabContext"), dict) else {}
        grader = str(slab_context.get("grader") or "").strip() or None
        grade = str(slab_context.get("grade") or "").strip() or None
        cert_number = str(slab_context.get("certNumber") or "").strip() or None
        variant_name = str(slab_context.get("variantName") or "").strip() or None
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
        payment_method = str(payload.get("paymentMethod") or "").strip() or None
        bought_at = str(payload.get("boughtAt") or utc_now()).strip() or utc_now()
        source_scan_id = str(payload.get("sourceScanID") or "").strip() or None
        source_confirmation_id = str(payload.get("sourceConfirmationID") or "").strip() or None
        deck_entry_id = deck_entry_storage_key(
            card_id=card_id,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            variant_name=variant_name,
        )

        try:
            inserted = self.connection.execute(
                "SELECT 1 FROM deck_entries WHERE id = ? LIMIT 1",
                (deck_entry_id,),
            ).fetchone() is None
            deck_entry_id = upsert_deck_entry(
                self.connection,
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
            )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

        return {
            "deckEntryID": deck_entry_id,
            "cardID": card_id,
            "inserted": inserted,
            "quantityAdded": quantity,
            "totalSpend": round(unit_price * quantity, 2),
            "boughtAt": bought_at,
        }

    def record_sale(self, payload: dict[str, Any]) -> dict[str, Any]:
        deck_entry_id = str(payload.get("deckEntryID") or "").strip()
        card_id = str(payload.get("cardID") or "").strip()
        slab_context = payload.get("slabContext") if isinstance(payload.get("slabContext"), dict) else {}
        if not deck_entry_id:
            if not card_id:
                raise ValueError("deckEntryID or cardID is required")
            deck_entry_id = deck_entry_storage_key(
                card_id=card_id,
                grader=str(slab_context.get("grader") or "").strip() or None,
                grade=str(slab_context.get("grade") or "").strip() or None,
                cert_number=str(slab_context.get("certNumber") or "").strip() or None,
                variant_name=str(slab_context.get("variantName") or "").strip() or None,
            )

        row = self.connection.execute(
            """
            SELECT id, card_id, quantity, item_kind, grader, grade, cert_number, variant_name, condition
            FROM deck_entries
            WHERE id = ?
            LIMIT 1
            """,
            (deck_entry_id,),
        ).fetchone()
        if row is None:
            raise FileNotFoundError("deck entry not found")

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

        sold_at = str(payload.get("soldAt") or utc_now()).strip() or utc_now()
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

        source_scan_id = str(payload.get("sourceScanID") or "").strip() or None
        source_confirmation_id = str(payload.get("sourceConfirmationID") or "").strip() or None
        try:
            sale_id = record_sale_event(
                self.connection,
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
                source_scan_id=source_scan_id,
                source_confirmation_id=source_confirmation_id,
            )
            if sale_id is None:
                raise RuntimeError("sale events table not available")
            remaining_row = self.connection.execute(
                "SELECT quantity FROM deck_entries WHERE id = ? LIMIT 1",
                (deck_entry_id,),
            ).fetchone()
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        return {
            "saleID": sale_id,
            "deckEntryID": deck_entry_id,
            "remainingQuantity": max(0, int(remaining_row["quantity"] if remaining_row is not None else current_quantity - quantity)),
            "grossTotal": round(unit_price * quantity, 2),
            "soldAt": sold_at,
            "showSessionID": show_session_id,
        }

    @staticmethod
    def _should_use_scrydex_japanese_raw(evidence: RawEvidence) -> bool:
        return raw_evidence_looks_japanese(evidence)

    @staticmethod
    def _candidate_is_japanese(candidate: dict[str, Any]) -> bool:
        language = str(candidate.get("language") or "").strip().lower()
        set_id = str(candidate.get("setID") or "").strip().lower()
        card_id = str(candidate.get("id") or "").strip().lower()
        return (
            language.startswith("ja")
            or language == "japanese"
            or set_id.endswith("_ja")
            or "_ja-" in card_id
        )

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
        language_hint = SpotlightScanService._inferred_slab_language_hint(
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

        if "JAPANESE" in combined_upper and "PROMO" in combined_upper and re.search(r"\bXY\b", combined_upper):
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
                    title_candidates.append(leading_title)

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

    def _score_slab_candidate(self, card: dict[str, Any], evidence: SlabMatchEvidence) -> tuple[float, list[str]]:
        title_overlap = self._slab_title_overlap(card, evidence)
        set_overlap = self._slab_set_overlap(card, evidence)
        card_number_overlap = self._slab_card_number_overlap(card, evidence)
        score = (title_overlap * 50.0) + (card_number_overlap * 30.0) + (set_overlap * 20.0)
        reasons: list[str] = []
        if title_overlap > 0:
            reasons.append("title_overlap")
        if card_number_overlap >= 1.0:
            reasons.append("card_number_exact")
        elif card_number_overlap > 0:
            reasons.append("card_number_partial")
        if set_overlap > 0:
            reasons.append("set_overlap")
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

    def _log_pricing_provenance(
        self,
        context: str,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
    ) -> None:
        provenance = self._pricing_provenance_for_card(card_id, grader=grader, grade=grade)
        if provenance is None:
            print(f"[PRICING DEBUG] {context}: card={card_id} has no stored pricing snapshot")
            return
        print(
            "[PRICING DEBUG] "
            f"{context}: "
            f"card={card_id} "
            f"provider={provenance.get('provider') or 'unknown'} "
            f"source={provenance.get('source') or 'unknown'} "
            f"variant={provenance.get('variant') or 'n/a'} "
            f"price={provenance.get('primaryPrice', self._primary_price_value(provenance))} "
            f"currency={provenance.get('currencyCode') or 'USD'} "
            f"refreshedAt={provenance.get('refreshedAt') or 'n/a'} "
            f"url={provenance.get('sourceURL') or 'n/a'}"
        )

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

    def _finalize_scan_response(
        self,
        request_payload: dict[str, Any],
        response_payload: dict[str, Any],
        top_candidates: list[dict[str, Any]],
    ) -> None:
        structured_log_started_at = perf_counter()
        self._emit_structured_log(self._scan_log_payload(request_payload, response_payload, top_candidates))
        structured_log_ms = (perf_counter() - structured_log_started_at) * 1000.0

        scan_log_started_at = perf_counter()
        self._log_scan(request_payload, response_payload, top_candidates)
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
            payload["visualRuntime"] = self._prewarm_raw_visual_runtime()
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
            "scrydexFullCatalogSync": scrydex_full_sync,
            "scrydexFullCatalogSyncFresh": scrydex_full_sync_is_fresh,
        }

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

    def search(self, query: str) -> dict[str, Any]:
        return {"results": search_cards(self.connection, query)}

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

    def import_catalog_card(self, card_id: str, api_key: str | None = None, *, trigger_source: str = "manual") -> dict[str, Any] | None:
        del api_key
        scrydex_provider = self.pricing_registry.get_provider("scrydex")
        if scrydex_provider is None or not scrydex_provider.is_ready():
            return None
        raw_card = fetch_scrydex_card_by_id(card_id, include_prices=True, request_type="card_import")
        mapped_card = map_scrydex_catalog_card(raw_card)
        return self._persist_mapped_catalog_card(
            mapped_card=mapped_card,
            sync_mode="exact_card_import",
            trigger_source=trigger_source,
            query_text=card_id,
        )

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
        if normalized_card_id not in self._card_lookup_cache:
            self._card_lookup_cache[normalized_card_id] = card_by_id(self.connection, normalized_card_id)
        return self._card_lookup_cache[normalized_card_id]

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

        if prefix.isdigit():
            max_width = max(4, len(prefix))
            for width in range(len(prefix) + 1, max_width + 1):
                padded = prefix.zfill(width)
                add_exact(padded)
                add_like(f"{padded}/%")

        return tuple(exact_values), tuple(like_values)

    def _local_slab_cards_by_number(self, card_number: str | None, *, limit: int = 400) -> list[dict[str, Any]]:
        exact_values, like_values = self._slab_number_query_values(card_number)
        if not exact_values and not like_values:
            return []

        clauses: list[str] = []
        params: list[Any] = []
        for value in exact_values:
            clauses.append("UPPER(number) = ?")
            params.append(value)
        for value in like_values:
            clauses.append("UPPER(number) LIKE ?")
            params.append(value)
        params.append(limit)

        rows = self.connection.execute(
            f"""
            SELECT id
            FROM cards
            WHERE {" OR ".join(clauses)}
            LIMIT ?
            """,
            params,
        ).fetchall()
        cards: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in rows:
            card_id = str(row["id"] or "").strip()
            if not card_id or card_id in seen:
                continue
            seen.add(card_id)
            cached = self._cached_card_by_id(card_id)
            if cached is not None:
                cards.append(cached)
        return cards

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
        cards = self._local_slab_cards_by_number(evidence.card_number)
        if not cards:
            return []

        candidates: list[dict[str, Any]] = []
        for card in cards:
            if not self._slab_candidate_matches_language_hint(card, evidence):
                continue
            score, reasons = self._score_slab_candidate(card, evidence)
            if score <= 0:
                continue
            candidates.append(self._slab_candidate_from_card(card, score, reasons, "local_slab_structured"))
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
        timing_output: dict[str, float] | None = None,
    ) -> dict[str, Any]:
        candidate_started_at = perf_counter()
        ensure_cached_started_at = perf_counter()
        resolved_card = self._ensure_raw_card_cached(card, trigger_source) if ensure_cached else card
        ensure_cached_ms = (perf_counter() - ensure_cached_started_at) * 1000.0
        card_id = str(resolved_card.get("id") or "").strip()
        pricing_lookup_started_at = perf_counter()
        pricing = self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context) if card_id else None
        pricing_lookup_ms = (perf_counter() - pricing_lookup_started_at) * 1000.0
        pricing_refresh_ms = 0.0
        candidate_build_started_at = perf_counter()
        if card_show_mode_active is None:
            card_show_mode_active = self._card_show_mode_active()
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
        card_show_mode_active = self._card_show_mode_active()

        for index, item in enumerate(items[:pricing_policy.limit], start=1):
            pricing_rule = pricing_policy.rule_for_rank(index)
            candidate_started_at = perf_counter()
            candidate_timing: dict[str, float] = {}
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
    def _visual_confidence(matches: list[dict[str, Any]]) -> tuple[str, list[str]]:
        if not matches:
            return "low", ["No visual candidates were available."]
        top1 = float(matches[0].get("similarity") or 0.0)
        top2 = float(matches[1].get("similarity") or 0.0) if len(matches) > 1 else 0.0
        margin = top1 - top2
        if top1 >= 0.85 and margin >= 0.05:
            return "high", []
        if top1 >= 0.72 and margin >= 0.02:
            return "medium", []
        flags = ["Visual match is ambiguous; review recommended."]
        if margin < 0.02:
            flags.append("Top visual candidates are very close.")
        return "low", flags

    def _resolve_raw_candidates_visual_only(
        self,
        payload: dict[str, Any],
        *,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        try:
            matches, debug, visual_match_ms = self._run_raw_visual_phase(payload, requested_top_k=10)
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
        response, _, _ = self._build_raw_visual_only_response(
            payload,
            matches=matches,
            debug=debug,
            visual_match_ms=visual_match_ms,
            api_key=api_key,
            is_provisional=False,
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
        badge_image_scores: dict[str, dict[str, Any]] = {}
        badge_match_error: str | None = None
        badge_match_ms = 0.0
        visual_candidates = [
            {
                **self._visual_candidate_stub(match.entry),
                "_visualSimilarity": float(summary.get("similarity") or 0.0),
                "_visualSimilaritySource": visual_phase_source,
                "_retrievalScoreHint": round(float(summary.get("similarity") or 0.0) * 100.0, 4),
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
        self._emit_structured_log(self._scan_request_log_payload(payload))
        scrydex_before_total = int(scrydex_request_stats_snapshot().get("total") or 0)
        scan_id = str(payload.get("scanID") or "")
        match_started = perf_counter()
        try:
            matches, debug, visual_match_ms = self._run_raw_visual_phase(payload, requested_top_k=10)
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
            self._log_scrydex_match_usage(
                scan_id,
                before_total=scrydex_before_total,
                started_at=match_started,
                response=response,
            )
            return response

        response, _, _ = self._build_raw_visual_only_response(
            payload,
            matches=matches,
            debug=debug,
            visual_match_ms=visual_match_ms,
            api_key=api_key,
            is_provisional=True,
            finalize_response=False,
        )
        self._store_pending_visual_scan(
            scan_id=scan_id,
            request_payload=payload,
            visual_matches=matches,
            visual_debug=debug,
            requested_top_k=10,
            visual_match_ms=visual_match_ms,
        )
        print(
            "[SCAN CACHE] Visual phase ready for rerank: "
            f"scanID={scan_id} "
            f"visualMatchMs={visual_match_ms:.1f} "
            f"resolverPath={response.get('resolverPath') or '<none>'} "
            f"provisional={bool(response.get('isProvisional'))}"
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
        match_started = perf_counter()
        cache_lookup_started_at = perf_counter()
        pending = self._pending_visual_scan(scan_id)
        cache_lookup_ms = (perf_counter() - cache_lookup_started_at) * 1000.0
        if pending is None:
            print(f"[SCAN CACHE] Cache unavailable for rerank, falling back live: scanID={scan_id}")
            return self.match_scan(payload)
        cache_clear_started_at = perf_counter()
        self._clear_pending_visual_scan(scan_id)
        cache_clear_ms = (perf_counter() - cache_clear_started_at) * 1000.0

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
            print(f"[SCAN CACHE] Cached rerank failed, returning unavailable response: scanID={scan_id} error={exc}")
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
        print(
            "[SCAN CACHE] Cached rerank completed: "
            f"scanID={scan_id} "
            f"resolverPath={response.get('resolverPath') or '<none>'} "
            f"confidence={response.get('confidence') or '<none>'} "
            f"cacheLookupMs={cache_lookup_ms:.1f} "
            f"cacheClearMs={cache_clear_ms:.1f} "
            f"resolveMs={resolve_ms:.1f}"
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
        pricing_policy = self._scan_candidate_pricing_policy(
            refresh_top_candidate_stale=True,
            refresh_top_candidate_missing=True,
            force_show_mode_top_candidate_refresh=True,
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

        local_candidates = self._retrieve_local_slab_candidates(evidence)
        top_local_score = float(local_candidates[0].get("_retrievalScoreHint") or 0.0) if local_candidates else 0.0
        local_delta = (
            top_local_score - float(local_candidates[1].get("_retrievalScoreHint") or 0.0)
            if len(local_candidates) > 1
            else top_local_score
        )
        should_expand_remote = len(local_candidates) < 3 or top_local_score < 70.0 or local_delta < 8.0
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
        merged_candidates = merge_raw_candidate_pools([local_candidates, remote_candidates])
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

        merged_candidates = merge_raw_candidate_pools([local_candidates, remote_candidates])
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
        effective_force_refresh = force_refresh or self._card_show_mode_active()
        if pricing_context.is_graded:
            if not pricing_context.grader or not pricing_context.grade:
                return self._card_detail_for_context(card_id, pricing_context=pricing_context)

            existing_pricing = self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context)
            if self._should_use_cached_pricing_snapshot(existing_pricing, force_refresh=effective_force_refresh):
                self._log_pricing_provenance(
                    "refresh_slab_cached",
                    card_id,
                    grader=pricing_context.grader,
                    grade=pricing_context.grade,
                )
                return self._card_detail_for_context(card_id, pricing_context=pricing_context)

            if not self._live_scrydex_pricing_refresh_allowed():
                self._log_pricing_provenance(
                    "refresh_slab_manual_mirror_cached_only",
                    card_id,
                    grader=pricing_context.grader,
                    grade=pricing_context.grade,
                )
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
            refresh_result = psa_provider.refresh_psa_pricing(
                self.connection,
                card_id,
                pricing_context.grader,
                pricing_context.grade,
                **refresh_kwargs,
            )
            if refresh_result.success:
                self._log_pricing_provenance(
                    "refresh_slab",
                    card_id,
                    grader=pricing_context.grader,
                    grade=pricing_context.grade,
                )
            return self._card_detail_for_context(card_id, pricing_context=pricing_context)

        existing_card = card_by_id(self.connection, card_id)
        if existing_card is None and api_key and self._live_scrydex_imports_allowed():
            try:
                self.import_catalog_card(card_id, api_key=api_key, trigger_source="refresh_pricing_auto_import")
            except Exception:
                return None
            existing_card = card_by_id(self.connection, card_id)

        existing_pricing = self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context)
        if self._should_use_cached_pricing_snapshot(existing_pricing, force_refresh=effective_force_refresh):
            self._log_pricing_provenance("refresh_raw_cached", card_id)
            return self._card_detail_for_context(card_id, pricing_context=pricing_context)

        if not self._live_scrydex_pricing_refresh_allowed():
            self._log_pricing_provenance("refresh_raw_manual_mirror_cached_only", card_id)
            return self._card_detail_for_context(card_id, pricing_context=pricing_context)

        provider_id = str((existing_card or {}).get("sourceProvider") or "scrydex")
        raw_provider = self.pricing_registry.get_provider(provider_id)
        if raw_provider is None or not raw_provider.is_ready() or not raw_provider.get_metadata().supports_raw_pricing:
            return self._card_detail_for_context(card_id, pricing_context=pricing_context)

        provider_refresh_result = raw_provider.refresh_raw_pricing(self.connection, card_id)
        if provider_refresh_result.success:
            self._log_pricing_provenance("refresh_raw", card_id)
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
        ordered_card_ids: list[str] = []
        seen_card_ids: set[str] = set()
        for raw_card_id in card_ids:
            card_id = str(raw_card_id or "").strip()
            if not card_id or card_id in seen_card_ids:
                continue
            seen_card_ids.add(card_id)
            ordered_card_ids.append(card_id)

        refresh_budget = max(0, min(int(max_refresh_count), len(ordered_card_ids)))
        refreshed_count = 0
        hydrated_cards: list[dict[str, Any]] = []
        live_refresh_allowed = self._live_scrydex_pricing_refresh_allowed()

        for card_id in ordered_card_ids:
            detail = self._card_detail_for_context(card_id, pricing_context=pricing_context)
            pricing = ((detail or {}).get("card") or {}).get("pricing") if isinstance(detail, dict) else None
            effective_force_refresh = force_refresh or (self._card_show_mode_active() and live_refresh_allowed)
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
    ) -> dict[str, Any] | None:
        card = card_by_id(self.connection, card_id)
        if card is None:
            return None
        pricing = self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context)
        resolved_variant = pricing_context.preferred_variant or (str((pricing or {}).get("variant") or "").strip() or None)
        return {
            "card": {
                "id": card["id"],
                "name": card["name"],
                "setName": card["setName"],
                "number": card["number"],
                "rarity": card["rarity"],
                "variant": card["variant"],
                "language": card["language"],
                "imageSmallURL": card["imageSmallURL"],
                "imageLargeURL": card["imageURL"],
                "pricing": pricing,
            },
            "slabContext": self._slab_context_payload_for_pricing_context(
                pricing_context,
                resolved_variant=resolved_variant,
            ),
            "source": card["sourceProvider"],
            "sourceRecordID": card["sourceRecordID"],
            "setID": card["setID"],
            "setSeries": card["setSeries"],
            "setReleaseDate": card["setReleaseDate"],
            "supertype": card["supertype"],
            "artist": card["artist"],
            "regulationMark": card["regulationMark"],
            "imageSmallURL": card["imageSmallURL"],
            "imageLargeURL": card["imageURL"],
        }

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
        return self._card_detail_for_context(card_id, pricing_context=pricing_context)

    def card_ebay_comps(
        self,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
        limit: int = 25,
    ) -> dict[str, Any] | None:
        card = card_by_id(self.connection, card_id)
        if card is None:
            return None
        normalized_grader = str(grader or "PSA").strip().upper() or "PSA"
        return fetch_graded_card_ebay_comps(
            card,
            grader=normalized_grader,
            selected_grade=grade,
            limit=limit,
        )

    def match_scan(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._emit_structured_log(self._scan_request_log_payload(payload))
        scrydex_before_total = int(scrydex_request_stats_snapshot().get("total") or 0)
        scan_id = str(payload.get("scanID") or "")
        match_started = perf_counter()
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
            LIMIT 1
            """,
            (payload["scanID"],),
        ).fetchone()

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
    def _decode_scan_image_payload(payload: dict[str, Any], *, field_name: str) -> tuple[bytes, int | None, int | None]:
        image_payload = payload.get(field_name)
        if not isinstance(image_payload, dict):
            raise ValueError(f"{field_name} must be an object")
        encoded = str(image_payload.get("jpegBase64") or "").strip()
        if not encoded:
            raise ValueError(f"{field_name}.jpegBase64 is required")
        try:
            raw_bytes = base64.b64decode(encoded, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"{field_name}.jpegBase64 is invalid") from exc
        width_value = image_payload.get("width")
        height_value = image_payload.get("height")
        width = int(width_value) if isinstance(width_value, int) else None
        height = int(height_value) if isinstance(height_value, int) else None
        return raw_bytes, width, height

    def store_scan_artifacts(self, payload: dict[str, Any]) -> dict[str, Any]:
        scan_id = str(payload.get("scanID") or "").strip()
        if not scan_id:
            raise ValueError("scanID is required")

        scan_row = self.connection.execute(
            "SELECT scan_id FROM scan_events WHERE scan_id = ? LIMIT 1",
            (scan_id,),
        ).fetchone()
        if scan_row is None:
            raise FileNotFoundError("scan event not found")

        if not self._scan_artifact_uploads_enabled():
            return {
                "scanID": scan_id,
                "enabled": False,
                "skipped": True,
                "reason": "scan artifact uploads disabled",
                "storage": self.artifact_store.storage_kind,
            }

        source_bytes, source_width, source_height = self._decode_scan_image_payload(payload, field_name="sourceImage")
        normalized_bytes, normalized_width, normalized_height = self._decode_scan_image_payload(payload, field_name="normalizedImage")

        submitted_at = str(payload.get("submittedAt") or utc_now()).strip() or utc_now()
        try:
            partition_datetime = datetime.fromisoformat(submitted_at.replace("Z", "+00:00"))
        except ValueError:
            partition_datetime = datetime.now(timezone.utc)
        try:
            stored = self.artifact_store.store(
                scan_id=scan_id,
                source_bytes=source_bytes,
                normalized_bytes=normalized_bytes,
                year=f"{partition_datetime.year:04d}",
                month=f"{partition_datetime.month:02d}",
                day=f"{partition_datetime.day:02d}",
            )

            upsert_scan_artifact(
                self.connection,
                scan_id=scan_id,
                source_object_path=stored.source_object_path,
                normalized_object_path=stored.normalized_object_path,
                source_width=source_width,
                source_height=source_height,
                normalized_width=normalized_width,
                normalized_height=normalized_height,
                camera_zoom_factor=float(payload["cameraZoomFactor"]) if isinstance(payload.get("cameraZoomFactor"), (int, float)) else None,
                capture_source=str(payload.get("captureSource") or "").strip() or None,
                uploaded_at=submitted_at,
                created_at=submitted_at,
            )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        return {
            "scanID": scan_id,
            "enabled": True,
            "storage": self.artifact_store.storage_kind,
            "sourceObjectPath": stored.source_object_path,
            "normalizedObjectPath": stored.normalized_object_path,
            "uploadedAt": submitted_at,
        }

    def create_deck_entry(self, payload: dict[str, Any]) -> dict[str, Any]:
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
                LIMIT 1
                """,
                (scan_id,),
            ).fetchone()
            if existing_event is None:
                raise FileNotFoundError("scan event not found")

        slab_context = payload.get("slabContext") if isinstance(payload.get("slabContext"), dict) else {}
        grader = str(slab_context.get("grader") or "").strip() or None
        grade = str(slab_context.get("grade") or "").strip() or None
        cert_number = str(slab_context.get("certNumber") or "").strip() or None
        variant_name = str(slab_context.get("variantName") or "").strip() or None
        condition = self._normalized_deck_card_condition(payload.get("condition"))
        if payload.get("condition") is not None and condition is None:
            raise ValueError("condition is invalid")
        selection_source = str(payload.get("selectionSource") or "").strip() or "unknown"
        selected_rank_value = payload.get("selectedRank")
        selected_rank = int(selected_rank_value) if isinstance(selected_rank_value, int) else None
        was_top_prediction = bool(payload.get("wasTopPrediction") is True)
        added_at = str(payload.get("addedAt") or utc_now()).strip() or utc_now()

        confirmation_source_map = {
            "top": "add_top",
            "alternate": "add_alternate",
            "manual_search": "add_manual_search",
        }
        confirmation_source = confirmation_source_map.get(selection_source, "add_unknown")

        try:
            deck_entry_id = upsert_deck_entry(
                self.connection,
                card_id=card_id,
                grader=grader,
                grade=grade,
                cert_number=cert_number,
                variant_name=variant_name,
                condition=condition,
                added_at=added_at,
                updated_at=added_at,
                source_scan_id=scan_id,
                source_confirmation_id=None,
            )

            confirmation_id = None
            if scan_id:
                confirmation_id = upsert_scan_confirmation(
                    self.connection,
                    scan_id=scan_id,
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
        return {
            "deckEntryID": deck_entry_id,
            "cardID": card_id,
            "condition": condition,
            "confirmationID": confirmation_id,
            "sourceScanID": scan_id,
            "addedAt": added_at,
        }

    def update_deck_entry_condition(self, payload: dict[str, Any]) -> dict[str, Any]:
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
        deck_entry_id = deck_entry_storage_key(
            card_id=card_id,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            variant_name=variant_name,
        )

        updated_at = str(payload.get("updatedAt") or utc_now()).strip() or utc_now()
        row = self.connection.execute(
            "SELECT id FROM deck_entries WHERE id = ? LIMIT 1",
            (deck_entry_id,),
        ).fetchone()
        if row is None:
            raise FileNotFoundError("deck entry not found")

        self.connection.execute(
            """
            UPDATE deck_entries
            SET condition = ?, updated_at = ?
            WHERE id = ?
            """,
            (condition, updated_at, deck_entry_id),
        )
        append_deck_entry_event(
            self.connection,
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
        deck_entry_id = deck_entry_storage_key(
            card_id=card_id,
            grader=grader,
            grade=grade,
            cert_number=cert_number,
            variant_name=variant_name,
        )

        updated_at = str(payload.get("updatedAt") or utc_now()).strip() or utc_now()
        currency_code = str(payload.get("currencyCode") or "").strip() or "USD"

        row = self.connection.execute(
            """
            SELECT quantity, condition, grader, grade, cert_number, variant_name
            FROM deck_entries
            WHERE id = ?
            LIMIT 1
            """,
            (deck_entry_id,),
        ).fetchone()
        if row is None:
            raise FileNotFoundError("deck entry not found")

        quantity = max(1, int(row["quantity"] or 1))
        cost_basis_total = round(unit_price * quantity, 2)

        self.connection.execute(
            """
            UPDATE deck_entries
            SET cost_basis_total = ?, cost_basis_currency_code = ?, updated_at = ?
            WHERE id = ?
            """,
            (cost_basis_total, currency_code, updated_at, deck_entry_id),
        )
        append_deck_entry_event(
            self.connection,
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
            LIMIT 1
            """,
            (normalized_transaction_id,),
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
            """,
            (unit_price, total_price, currency_code, normalized_transaction_id),
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
            LIMIT 1
            """,
            (normalized_transaction_id,),
        ).fetchone()
        resolved_transaction_id = normalized_transaction_id
        if row is None:
            fallback_row = self.connection.execute(
                """
                SELECT sale_id
                FROM deck_entry_events
                WHERE id = ?
                  AND event_kind = 'sale'
                LIMIT 1
                """,
                (normalized_transaction_id,),
            ).fetchone()
            fallback_sale_id = str(fallback_row["sale_id"] or "").strip() if fallback_row is not None else ""
            if fallback_sale_id:
                row = self.connection.execute(
                    """
                    SELECT id, deck_entry_id, quantity
                    FROM sale_events
                    WHERE id = ?
                    LIMIT 1
                    """,
                    (fallback_sale_id,),
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
            """,
            (unit_price, total_price, currency_code, resolved_transaction_id),
        )
        self.connection.execute(
            """
            UPDATE deck_entry_events
            SET unit_price = ?, total_price = ?, currency_code = ?
            WHERE sale_id = ?
              AND event_kind = 'sale'
            """,
            (unit_price, total_price, currency_code, resolved_transaction_id),
        )
        self.connection.execute(
            """
            UPDATE deck_entries
            SET updated_at = ?
            WHERE id = ?
            """,
            (updated_at, deck_entry_id),
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

    def deck_entries(self, *, limit: int = 200, offset: int = 0, include_inactive: bool = False) -> dict[str, Any]:
        safe_limit = max(0, min(int(limit), 1000))
        safe_offset = max(0, int(offset))
        where_clause = ""
        if not include_inactive:
            where_clause = "WHERE quantity > 0"
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
                added_at,
                updated_at,
                source_scan_id,
                source_confirmation_id
            FROM deck_entries
            {where_clause}
            ORDER BY added_at DESC, id DESC
            LIMIT ? OFFSET ?
            """.format(where_clause=where_clause),
            (safe_limit, safe_offset),
        ).fetchall()
        cards_by_id_map = cards_by_ids(
            self.connection,
            [str(row["card_id"] or "").strip() for row in rows],
        )
        price_snapshot_rows = self._price_snapshot_rows_by_card_id(
            [str(row["card_id"] or "").strip() for row in rows]
        )

        entries: list[dict[str, Any]] = []
        total_value = 0.0
        total_cost_basis = 0.0
        raw_count = 0
        slab_count = 0

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
                else self._raw_pricing_context()
            )
            pricing = self._display_pricing_summary_for_context(
                card_id,
                pricing_context=pricing_context,
                snapshot_row=price_snapshot_rows.get(card_id),
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

            slab_context = None
            if any([grader, grade, cert_number, variant_name]):
                slab_context = {
                    "grader": grader,
                    "grade": grade,
                    "certNumber": cert_number,
                    "variantName": variant_name,
                }
                slab_count += 1
            else:
                raw_count += 1

            entries.append(
                {
                    "id": row["id"],
                    "itemKind": row["item_kind"],
                    "card": card_payload,
                    "slabContext": slab_context,
                    "condition": condition,
                    "quantity": quantity,
                    "costBasisTotal": round(float(row["cost_basis_total"] or 0.0), 2),
                    "costBasisCurrencyCode": str(row["cost_basis_currency_code"] or "").strip() or None,
                    "addedAt": row["added_at"],
                    "updatedAt": row["updated_at"],
                    "sourceScanID": row["source_scan_id"],
                    "sourceConfirmationID": row["source_confirmation_id"],
                }
            )

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

    def _log_scan(self, request_payload: dict[str, Any], response_payload: dict[str, Any], top_candidates: list[dict[str, Any]]) -> None:
        scan_id = request_payload["scanID"]
        now = utc_now()
        predicted_card_id = self._predicted_card_id(response_payload)
        if predicted_card_id is None and top_candidates:
            predicted_card_id = str(((top_candidates[0].get("candidate") or {}).get("id")) or "").strip() or None
        upsert_scan_event(
            self.connection,
            scan_id=scan_id,
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
        replace_scan_prediction_candidates(self.connection, scan_id=scan_id, candidates=top_candidates[:10])
        replace_scan_price_observations(self.connection, scan_id=scan_id, candidates=top_candidates[:10], observed_at=now)
        self.connection.commit()


class SpotlightRequestHandler(BaseHTTPRequestHandler):
    service: SpotlightScanService

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        if parsed.path == "/api/v1/health":
            prewarm_visual = str(query.get("prewarm", [""])[0]).strip().lower() in {"1", "true", "visual", "all"}
            self._write_json(HTTPStatus.OK, self.service.health(prewarm_visual=prewarm_visual))
            return

        if parsed.path == "/api/v1/ops/provider-status":
            self._write_json(HTTPStatus.OK, self.service.provider_status())
            return

        if parsed.path == "/api/v1/ops/scan-artifact-status":
            self._write_json(HTTPStatus.OK, self.service.scan_artifact_status())
            return

        if parsed.path == "/api/v1/ops/unmatched-scans":
            limit = int(query.get("limit", ["25"])[0])
            self._write_json(HTTPStatus.OK, self.service.unmatched_scans(limit=limit))
            return

        if parsed.path == "/api/v1/deck/entries":
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
            self._write_json(
                HTTPStatus.OK,
                self.service.deck_entries(limit=limit, offset=offset, include_inactive=include_inactive),
            )
            return

        if parsed.path in {"/api/v1/deck/history", "/api/v1/portfolio/history"}:
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
                payload = self.service.deck_history(days=days, range_label=range_value, time_zone_name=time_zone_name)
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Deck history failed: {error}"})
                return
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path in {"/api/v1/ledger", "/api/v1/portfolio/ledger", "/api/v1/deals"}:
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
            try:
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
            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/v1/cards/search":
            query = parse_qs(parsed.query).get("q", [""])[0]
            self._write_json(HTTPStatus.OK, self.service.search(query))
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
            grader = query.get("grader", ["PSA"])[0].strip() or "PSA"
            grade = query.get("grade", [""])[0].strip() or None
            try:
                limit = int(query.get("limit", ["25"])[0])
            except (TypeError, ValueError):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return

            try:
                payload = self.service.card_ebay_comps(
                    card_id,
                    grader=grader,
                    grade=grade,
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

            payload = self.service.card_detail(
                card_id,
                grader=grader,
                grade=grade,
                cert_number=cert_number,
                preferred_variant=preferred_variant,
            )
            if payload is None and self.service._live_scrydex_imports_allowed():
                api_key = os.environ.get("SCRYDEX_API_KEY")
                try:
                    imported = self.service.import_catalog_card(
                        card_id,
                        api_key=api_key,
                        trigger_source="auto_import_on_request",
                    )
                    if imported is not None:
                        payload = self.service.card_detail(
                            card_id,
                            grader=grader,
                            grade=grade,
                            cert_number=cert_number,
                            preferred_variant=preferred_variant,
                        )
                except Exception:
                    pass

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

        payload = self._read_json_body()
        if payload is None:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON body"})
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

        if parsed.path in {"/api/v1/sales", "/api/v1/deck/sales", "/api/v1/portfolio/sales"}:
            try:
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

        if parsed.path.startswith("/api/v1/portfolio/sales/") and parsed.path.endswith("/price"):
            transaction_id = unquote(
                parsed.path.removeprefix("/api/v1/portfolio/sales/").removesuffix("/price").strip("/")
            )
            if not transaction_id:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "transactionID is required"})
                return
            try:
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
            try:
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
            transaction_id = unquote(
                parsed.path.removeprefix("/api/v1/portfolio/buys/").removesuffix("/price").strip("/")
            )
            if not transaction_id:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "transactionID is required"})
                return
            try:
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

        if parsed.path == "/api/v1/catalog/import-card":
            card_id = str(payload.get("cardID") or "").strip()
            if not card_id:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "cardID is required"})
                return
            try:
                imported = self.service.import_catalog_card(
                    card_id,
                    api_key=os.environ.get("SCRYDEX_API_KEY"),
                    trigger_source="manual_endpoint",
                )
            except Exception as error:
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Catalog import failed: {error}"})
                return
            if imported is None:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Card not found"})
                return
            self._write_json(HTTPStatus.OK, {"card": imported})
            return

        if parsed.path == "/api/v1/scan/match":
            request_started_at = perf_counter()
            try:
                self._write_json_timed(
                    HTTPStatus.OK,
                    self.service.match_scan(payload),
                    label="scan_match",
                    started_at=request_started_at,
                )
            except Exception as error:
                traceback.print_exc()
                self.service._emit_structured_log(self.service._scan_error_log_payload(payload, error))
                self._write_json_timed(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": "Scan match failed",
                        "errorType": type(error).__name__,
                    },
                    label="scan_match",
                    started_at=request_started_at,
                )
            return

        if parsed.path == "/api/v1/scan/visual-match":
            request_started_at = perf_counter()
            try:
                self._write_json_timed(
                    HTTPStatus.OK,
                    self.service.visual_match_scan(payload),
                    label="scan_visual_match",
                    started_at=request_started_at,
                )
            except Exception as error:
                traceback.print_exc()
                self._write_json_timed(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": "Visual scan match failed",
                        "errorType": type(error).__name__,
                    },
                    label="scan_visual_match",
                    started_at=request_started_at,
                )
            return

        if parsed.path == "/api/v1/scan/rerank":
            request_started_at = perf_counter()
            try:
                self._write_json_timed(
                    HTTPStatus.OK,
                    self.service.rerank_visual_match(payload),
                    label="scan_rerank",
                    started_at=request_started_at,
                )
            except Exception as error:
                traceback.print_exc()
                self._write_json_timed(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": "Scan rerank failed",
                        "errorType": type(error).__name__,
                    },
                    label="scan_rerank",
                    started_at=request_started_at,
                )
            return

        if parsed.path == "/api/v1/scan-artifacts":
            try:
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
            self.service.log_feedback(payload)
            self._write_json(HTTPStatus.ACCEPTED, {"status": "accepted"})
            return

        if parsed.path == "/api/v1/deck/entries":
            try:
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
            try:
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

        if parsed.path == "/api/v1/deck/entries/purchase-price":
            try:
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

        self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _read_json_body(self) -> dict[str, Any] | None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None

        body = self.rfile.read(content_length)
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            return None

    def _write_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_json_timed(
        self,
        status: HTTPStatus,
        payload: dict[str, Any],
        *,
        label: str,
        started_at: float,
    ) -> None:
        write_started_at = perf_counter()
        self._write_json(status, payload)
        write_ms = (perf_counter() - write_started_at) * 1000.0
        total_ms = (perf_counter() - started_at) * 1000.0
        print(
            "[HTTP PERF] "
            f"label={label} "
            f"status={status.value} "
            f"writeJsonMs={write_ms:.1f} "
            f"totalMs={total_ms:.1f}"
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
        port=cli_int_value("--port", int(os.environ.get("SPOTLIGHT_PORT", "8787"))),
    )
    database_path = bootstrap_backend(
        root,
        database_path_override=cli_value("--database-path") or os.environ.get("SPOTLIGHT_DATABASE_PATH"),
    )

    SpotlightRequestHandler.service = SpotlightScanService(database_path, repo_root)
    startup_visual_runtime = SpotlightRequestHandler.service._prewarm_raw_visual_runtime()
    SpotlightRequestHandler.service._emit_structured_log(
        {
            "severity": "INFO",
            "event": "visual_runtime_prewarm",
            "source": "startup",
            **startup_visual_runtime,
        }
    )
    server = HTTPServer((config.host, config.port), SpotlightRequestHandler)
    print(f"Looty scan service listening on http://{config.host}:{config.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Looty scan service", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
