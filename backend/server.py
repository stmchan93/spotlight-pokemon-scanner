from __future__ import annotations

import json
import os
import re
import sys
import traceback
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from time import perf_counter
from typing import Any
from urllib.parse import parse_qs, urlparse

from env_loader import load_backend_env_file as _load_backend_env_file


_load_backend_env_file(Path(__file__).resolve().parent / ".env")

from catalog_tools import (
    MATCHER_VERSION,
    RawDecisionResult,
    RawEvidence,
    RawRetrievalPlan,
    RawSignalScores,
    apply_schema,
    build_raw_evidence,
    build_raw_retrieval_plan,
    canonicalize_collector_number,
    card_by_id,
    connect,
    contextual_pricing_summary_for_card,
    delete_runtime_setting,
    finalize_raw_decision,
    latest_provider_sync_run,
    load_index,
    merge_raw_candidate_pools,
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
    upsert_runtime_setting,
    upsert_scan_event,
    utc_now,
)
from fx_rates import decorate_pricing_summary_with_fx
from pricecharting_adapter import PriceChartingProvider
from pricing_provider import PricingProviderRegistry
from raw_set_badge_matcher import RawSetBadgeMatcher
from scrydex_adapter import (
    SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
    SCRYDEX_PROVIDER,
    ScrydexProvider,
    best_remote_scrydex_raw_candidates,
    fetch_scrydex_card_by_id,
    map_scrydex_catalog_card,
    persist_scrydex_raw_snapshot,
    scrydex_request_stats_snapshot,
    search_remote_scrydex_raw_candidates,
    search_remote_scrydex_slab_candidates,
    raw_evidence_looks_japanese,
    search_remote_scrydex_japanese_raw_candidates,
)
from slab_cert_resolver import resolve_psa_cert_from_scan_cache
from slab_set_aliases import resolve_slab_set_aliases

MANUAL_SCRYDEX_MIRROR_ENV = "SPOTLIGHT_MANUAL_SCRYDEX_MIRROR"
CARD_SHOW_MODE_SETTING_KEY = "card_show_mode"
DEFAULT_CARD_SHOW_MODE_HOURS = 8.0


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
    def top_five_refresh_top_one(
        cls,
        *,
        refresh_top_candidate_stale: bool,
        refresh_top_candidate_missing: bool,
        force_show_mode_top_candidate_refresh: bool = False,
    ) -> "PricingLoadPolicy":
        return cls(
            limit=5,
            rank_rules=(
                CandidateRankPricingRule(
                    rank=1,
                    ensure_cached=True,
                    refresh_stale=refresh_top_candidate_stale,
                    refresh_missing=refresh_top_candidate_missing,
                    force_show_mode_refresh=force_show_mode_top_candidate_refresh,
                ),
                CandidateRankPricingRule(rank=2),
                CandidateRankPricingRule(rank=3),
                CandidateRankPricingRule(rank=4),
                CandidateRankPricingRule(rank=5),
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


class SpotlightScanService:
    def __init__(self, database_path: Path, repo_root: Path) -> None:
        self.database_path = database_path
        self.repo_root = repo_root
        self.connection = connect(database_path)
        self.index = load_index(self.connection)
        self._card_lookup_cache: dict[str, dict[str, Any] | None] = {}
        self._raw_visual_matcher: Any | None = None
        self._raw_set_badge_matcher: RawSetBadgeMatcher | None = None

        self.pricing_registry = PricingProviderRegistry()
        self.pricing_registry.register(ScrydexProvider())
        self.pricing_registry.register(PriceChartingProvider())

    def refresh_index(self) -> None:
        self.index = load_index(self.connection)
        self._card_lookup_cache.clear()

    def _raw_visual_matcher_instance(self) -> Any:
        if self._raw_visual_matcher is None:
            from raw_visual_matcher import RawVisualMatcher

            self._raw_visual_matcher = RawVisualMatcher(repo_root=self.repo_root)
        return self._raw_visual_matcher

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

    def _raw_set_badge_matcher_instance(self) -> RawSetBadgeMatcher:
        if self._raw_set_badge_matcher is None:
            self._raw_set_badge_matcher = RawSetBadgeMatcher()
        return self._raw_set_badge_matcher

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

    def _live_scrydex_searches_allowed(self) -> bool:
        if self._manual_scrydex_mirror_enabled():
            return False
        return not self._scrydex_full_catalog_sync_is_fresh()

    def _live_scrydex_imports_allowed(self) -> bool:
        if self._manual_scrydex_mirror_enabled():
            return False
        return not self._scrydex_full_catalog_sync_is_fresh()

    def _live_scrydex_pricing_refresh_allowed(self) -> bool:
        if self._card_show_mode_active():
            return True
        if not self._manual_scrydex_mirror_enabled():
            return True
        return not self._scrydex_full_catalog_sync_is_fresh()

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
        response["performance"] = {
            "serverProcessingMs": round(server_processing_ms, 3),
            "scrydexRequestCount": delta,
            "scrydexRequestTypes": types,
        }
        visual_hybrid_debug = ((response.get("rawDecisionDebug") or {}).get("visualHybrid") or {})
        phase_timings = visual_hybrid_debug.get("phaseTimings") or {}
        matcher_timings = visual_hybrid_debug.get("timings") or {}
        if phase_timings or matcher_timings:
            response["performance"]["phaseTimings"] = phase_timings
            response["performance"]["matcherTimings"] = matcher_timings
        print(
            "[MATCH PERF] "
            f"scan={scan_id} "
            f"resolverPath={response.get('resolverPath') or 'unknown'} "
            f"confidence={response.get('confidence') or 'unknown'} "
            f"serverMs={server_processing_ms:.1f} "
            f"requests={delta} "
            f"types={types or ['none']} "
            f"details={details or []}"
        )
        if phase_timings or matcher_timings:
            print(
                "[MATCH PERF DETAIL] "
                f"scan={scan_id} "
                f"phases={phase_timings or {}} "
                f"matcher={matcher_timings or {}}"
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
    ) -> dict[str, Any] | None:
        pricing = contextual_pricing_summary_for_card(
            self.connection,
            card_id,
            grader=pricing_context.grader,
            grade=pricing_context.grade,
            variant=pricing_context.preferred_variant,
        )
        pricing = decorate_pricing_summary_with_fx(self.connection, pricing)
        if pricing_context.is_graded and pricing is not None and not self._slab_variant_matches(
            pricing.get("variant"),
            preferred_variant=pricing_context.preferred_variant,
            variant_hints=pricing_context.variant_hints,
        ):
            return None
        return pricing

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

        return {
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

    def _emit_structured_log(self, payload: dict[str, Any]) -> None:
        print(json.dumps(payload, separators=(",", ":"), default=str), flush=True)

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
            raw_refresh_row = self.connection.execute(
                """
                SELECT updated_at
                FROM card_price_snapshots
                WHERE provider = ? AND pricing_mode = 'raw'
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (metadata.provider_id,),
            ).fetchone()
            graded_refresh_row = self.connection.execute(
                """
                SELECT updated_at
                FROM card_price_snapshots
                WHERE provider = ? AND pricing_mode = 'graded'
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (metadata.provider_id,),
            ).fetchone()
            provider_details.append(
                {
                    "providerId": metadata.provider_id,
                    "providerLabel": metadata.provider_label,
                    "isReady": metadata.is_ready,
                    "requiresCredentials": metadata.requires_credentials,
                    "supportsRawPricing": metadata.supports_raw_pricing,
                    "supportsPsaPricing": metadata.supports_psa_pricing,
                    "lastRefreshAt": raw_refresh_row["updated_at"] if raw_refresh_row else None,
                    "lastRawRefreshAt": raw_refresh_row["updated_at"] if raw_refresh_row else None,
                    "lastPsaRefreshAt": graded_refresh_row["updated_at"] if graded_refresh_row else None,
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
            "cardShowMode": self._card_show_mode_state(),
            "scrydexRequestStats": scrydex_request_stats_snapshot(),
            "scrydexFullCatalogSync": scrydex_full_sync,
            "scrydexFullCatalogSyncFresh": scrydex_full_sync_is_fresh,
        }

    def cache_status(self) -> dict[str, Any]:
        raw_count = self.connection.execute(
            "SELECT COUNT(*) AS count FROM card_price_snapshots WHERE pricing_mode = ?",
            ("raw",),
        ).fetchone()["count"]
        graded_count = self.connection.execute(
            "SELECT COUNT(*) AS count FROM card_price_snapshots WHERE pricing_mode = ?",
            ("graded",),
        ).fetchone()["count"]
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
            candidate["_setBadgeImageScore"] = 0.0
            candidate["_setBadgeImageFamily"] = None
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
    ) -> dict[str, Any]:
        resolved_card = self._ensure_raw_card_cached(card, trigger_source) if ensure_cached else card
        card_id = str(resolved_card.get("id") or "").strip()
        pricing = self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context) if card_id else None
        card_show_mode_active = self._card_show_mode_active()
        pricing_missing = pricing is None
        pricing_stale = pricing is not None and pricing.get("isFresh") is not True
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
            refreshed_detail = self._refresh_card_pricing_for_context(
                card_id,
                pricing_context=pricing_context,
                api_key=api_key,
                force_refresh=should_force_show_mode_refresh,
            )
            pricing = ((refreshed_detail or {}).get("card", {}) or {}).get("pricing") if isinstance(refreshed_detail, dict) else None
            if pricing is None:
                pricing = self._display_pricing_summary_for_context(card_id, pricing_context=pricing_context)

        candidate = self._candidate_base_payload(resolved_card, card)
        if pricing is not None:
            candidate["pricing"] = pricing
        return candidate

    def _encode_top_candidates(
        self,
        items: list[CandidateEncodingItem],
        *,
        pricing_context: PricingContext,
        pricing_policy: PricingLoadPolicy,
        trigger_source: str,
        api_key: str | None = None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        encoded_candidates: list[dict[str, Any]] = []
        scored_candidates: list[dict[str, Any]] = []

        for index, item in enumerate(items[:pricing_policy.limit], start=1):
            pricing_rule = pricing_policy.rule_for_rank(index)
            candidate_payload = self._candidate_payload(
                item.card,
                pricing_context=pricing_context,
                trigger_source=trigger_source,
                ensure_cached=pricing_rule.ensure_cached,
                api_key=api_key,
                refresh_pricing_if_stale=pricing_rule.refresh_stale,
                refresh_pricing_if_missing=pricing_rule.refresh_missing,
                force_show_mode_refresh=pricing_rule.force_show_mode_refresh,
            )
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

        return encoded_candidates, scored_candidates

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
            return response, []

        pricing_policy = PricingLoadPolicy.top_five_refresh_top_one(
            refresh_top_candidate_stale=True,
            refresh_top_candidate_missing=decision.confidence != "low",
            force_show_mode_top_candidate_refresh=decision.confidence != "low",
        )
        encoded_candidates, scored_candidates = self._encode_top_candidates(
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
            matches, debug = self._raw_visual_matcher_instance().match_payload(payload, top_k=10)
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
            self._emit_structured_log(self._scan_log_payload(payload, response, []))
            self._log_scan(payload, response, [])
            return response

        ranked_matches = [self._visual_match_summary(match) for match in matches]
        confidence, ambiguity_flags = self._visual_confidence(ranked_matches)
        review_disposition = "ready" if confidence != "low" else "needs_review"
        pricing_policy = PricingLoadPolicy.top_five_refresh_top_one(
            refresh_top_candidate_stale=True,
            refresh_top_candidate_missing=confidence != "low",
            force_show_mode_top_candidate_refresh=confidence != "low",
        )
        encoded_candidates, scored_candidates = self._encode_top_candidates(
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
                for match, summary in zip(matches[:5], ranked_matches[:5], strict=True)
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
                    "topCandidates": ranked_matches[:5],
                }
            },
        }
        self._emit_structured_log(self._scan_log_payload(payload, response, scored_candidates))
        self._log_scan(payload, response, scored_candidates)
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
            self._emit_structured_log(self._scan_log_payload(payload, response, []))
            self._log_scan(payload, response, [])
            return response
        visual_match_ms = (perf_counter() - visual_match_started_at) * 1000.0

        visual_matches = [self._visual_match_summary(match) for match in matches]
        badge_image_scores: dict[str, dict[str, Any]] = {}
        badge_match_error: str | None = None
        badge_match_started_at = perf_counter()
        try:
            badge_image_scores = self._raw_set_badge_matcher_instance().score_payload_against_entries(
                payload,
                [match.entry for match in matches],
            )
        except Exception as exc:
            badge_match_error = str(exc)
        badge_match_ms = (perf_counter() - badge_match_started_at) * 1000.0
        visual_candidates = [
            {
                **self._visual_candidate_stub(match.entry),
                "_visualSimilarity": float(summary.get("similarity") or 0.0),
                "_visualSimilaritySource": "visual_index",
                "_retrievalScoreHint": round(float(summary.get("similarity") or 0.0) * 100.0, 4),
                "_cachePresence": False,
                "_retrievalRoutes": ["visual_index"],
                "_setBadgeImageScore": float(
                    (badge_image_scores.get(str(summary.get("providerCardId") or ""), {}) or {}).get("score") or 0.0
                ),
                "_setBadgeImageFamily": (
                    badge_image_scores.get(str(summary.get("providerCardId") or ""), {}) or {}
                ).get("family"),
            }
            for match, summary in zip(matches, visual_matches, strict=True)
        ]
        used_local_ocr_rescue = self._should_expand_visual_hybrid_pool(payload, evidence)
        local_ocr_candidates: list[dict[str, Any]] = []
        if used_local_ocr_rescue:
            local_ocr_candidates = self._search_local_visual_manifest_ocr_candidates(
                evidence,
                signals,
                limit=24,
            )
            if local_ocr_candidates:
                visual_candidates = merge_raw_candidate_pools([visual_candidates, local_ocr_candidates])

        rerank_started_at = perf_counter()
        ranked_matches, weights = rank_visual_hybrid_candidates(visual_candidates, evidence, signals)
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
        rerank_decision_ms = (perf_counter() - rerank_started_at) * 1000.0
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
            for match in ranked_matches[:5]
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
                    "visualMatchMs": round(visual_match_ms, 3),
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
        self._emit_structured_log(self._scan_log_payload(payload, response, top_candidates))
        self._log_scan(payload, response, top_candidates)
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
                for candidate in ranked_candidates[:5]
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
        pricing_policy = PricingLoadPolicy.top_five_refresh_top_one(
            refresh_top_candidate_stale=True,
            refresh_top_candidate_missing=confidence != "low",
            force_show_mode_top_candidate_refresh=confidence != "low",
        )
        encoded_candidates, scored_candidates = self._encode_top_candidates(
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
            self._emit_structured_log(self._scan_log_payload(payload, response, top_candidates))
            self._log_scan(payload, response, top_candidates)
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
        self._emit_structured_log(self._scan_log_payload(payload, response, top_candidates))
        self._log_scan(payload, response, top_candidates)
        return response

    def _log_raw_scan_event(
        self,
        payload: dict[str, Any],
        decision: RawDecisionResult,
        response: dict[str, Any],
        top_candidates: list[dict[str, Any]],
    ) -> None:
        self._emit_structured_log(self._scan_log_payload(payload, response, top_candidates))
        self._log_scan(payload, response, top_candidates)

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
            if existing_pricing is not None and not effective_force_refresh and existing_pricing.get("isFresh") is True:
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
        if existing_pricing is not None and not effective_force_refresh and existing_pricing.get("isFresh") is True:
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

        for card_id in ordered_card_ids:
            detail = self._card_detail_for_context(card_id, pricing_context=pricing_context)
            pricing = ((detail or {}).get("card") or {}).get("pricing") if isinstance(detail, dict) else None
            needs_refresh = (
                force_refresh
                or self._card_show_mode_active()
                or pricing is None
                or pricing.get("isFresh") is not True
            )

            if needs_refresh and refreshed_count < refresh_budget:
                refreshed_count += 1
                try:
                    detail = self._refresh_card_pricing_for_context(
                        card_id,
                        pricing_context=pricing_context,
                        api_key=api_key,
                        force_refresh=(force_refresh or self._card_show_mode_active()),
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
        self._emit_structured_log(self._scan_log_payload(payload, response, []))
        self._log_scan(payload, response, [])
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
                selected_card_id,
                confidence,
                review_disposition,
                resolver_mode,
                resolver_path
            FROM scan_events
            WHERE scan_id = ?
            LIMIT 1
            """,
            (payload["scanID"],),
        ).fetchone()

        request_payload = json.loads(existing_event["request_json"] or "{}") if existing_event else {}
        response_payload = json.loads(existing_event["response_json"] or "{}") if existing_event else {}
        feedback_selected_card_id = payload.get("selectedCardID") or (existing_event["selected_card_id"] if existing_event else None)

        upsert_scan_event(
            self.connection,
            scan_id=payload["scanID"],
            request_payload=request_payload,
            response_payload=response_payload,
            matcher_source=(response_payload.get("matcherSource") or (existing_event["matcher_source"] if existing_event else None) or "remoteHybrid"),
            matcher_version=(response_payload.get("matcherVersion") or (existing_event["matcher_version"] if existing_event else None) or MATCHER_VERSION),
            created_at=(existing_event["created_at"] if existing_event else payload.get("submittedAt", utc_now())),
            selected_card_id=feedback_selected_card_id,
            confidence=(response_payload.get("confidence") or (existing_event["confidence"] if existing_event else None)),
            review_disposition=(response_payload.get("reviewDisposition") or (existing_event["review_disposition"] if existing_event else None)),
            correction_type=payload["correctionType"],
            resolver_mode=(response_payload.get("resolverMode") or (existing_event["resolver_mode"] if existing_event else None)),
            resolver_path=(response_payload.get("resolverPath") or (existing_event["resolver_path"] if existing_event else None)),
            completed_at=payload["submittedAt"],
        )
        self.connection.commit()

    def _log_scan(self, request_payload: dict[str, Any], response_payload: dict[str, Any], top_candidates: list[dict[str, Any]]) -> None:
        scan_id = request_payload["scanID"]
        now = utc_now()
        upsert_scan_event(
            self.connection,
            scan_id=scan_id,
            request_payload=request_payload,
            response_payload=response_payload,
            matcher_source=response_payload["matcherSource"],
            matcher_version=response_payload["matcherVersion"],
            created_at=now,
            selected_card_id=None,
            confidence=response_payload.get("confidence"),
            review_disposition=response_payload.get("reviewDisposition"),
            resolver_mode=response_payload.get("resolverMode"),
            resolver_path=response_payload.get("resolverPath"),
            completed_at=now,
        )
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

        if parsed.path == "/api/v1/ops/unmatched-scans":
            limit = int(query.get("limit", ["25"])[0])
            self._write_json(HTTPStatus.OK, self.service.unmatched_scans(limit=limit))
            return

        if parsed.path == "/api/v1/cards/search":
            query = parse_qs(parsed.query).get("q", [""])[0]
            self._write_json(HTTPStatus.OK, self.service.search(query))
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
            try:
                self._write_json(HTTPStatus.OK, self.service.match_scan(payload))
            except Exception as error:
                traceback.print_exc()
                self.service._emit_structured_log(self.service._scan_error_log_payload(payload, error))
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": "Scan match failed",
                        "errorType": type(error).__name__,
                    },
                )
            return

        if parsed.path == "/api/v1/scan/feedback":
            self.service.log_feedback(payload)
            self._write_json(HTTPStatus.ACCEPTED, {"status": "accepted"})
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
    server = HTTPServer((config.host, config.port), SpotlightRequestHandler)
    print(f"Spotlight scan service listening on http://{config.host}:{config.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Spotlight scan service", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
