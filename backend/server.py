from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import threading
import traceback
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

# Load environment variables from backend/.env for local development.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass  # python-dotenv not installed, will use system env vars only

from catalog_tools import (
    DEFAULT_PRICING_FRESHNESS_HOURS,
    KNOWN_SET_ALIASES,
    KNOWN_SET_ID_ALIASES,
    MATCHER_VERSION,
    apply_schema,
    approximate_candidate_indices,
    build_query_embedding,
    candidate_has_exact_structured_match,
    catalog_sync_runs,
    canonicalize_collector_number,
    collector_number_has_alpha_hint,
    collector_number_api_query_values,
    collector_number_printed_total,
    confidence_for_candidates,
    connect,
    contextual_pricing_summary_for_card,
    collector_number_lookup_keys,
    collector_prefix,
    direct_lookup_candidate_indices,
    direct_lookup_has_exact_candidate,
    direct_lookup_has_name_support,
    direct_lookup_score,
    has_specific_artist_credit_signal,
    import_slab_sales,
    latest_catalog_sync_run,
    load_cards_json,
    load_index,
    log_catalog_sync_run,
    log_pricing_refresh_failure,
    load_slab_sales_file,
    parse_psa_grade,
    parse_psa_cert_number,
    psa_label_candidate_indices,
    psa_label_score,
    pricing_refresh_failures,
    recognized_artist_tokens,
    recognized_pokedex_number_hints,
    raw_pricing_summary_for_card,
    recognized_text_for_payload,
    recompute_all_slab_price_snapshots,
    recompute_slab_price_snapshot,
    resolver_mode_for_payload,
    resolve_catalog_json_path,
    rerank_card,
    runtime_supported_card_id,
    search_cards,
    seed_catalog,
    slab_payload_number_hints,
    slab_price_snapshot_for_card,
    slab_sales_for_card,
    slab_context_from_payload,
    structured_set_hints_for_payload,
    trusted_set_hints_for_payload,
    tokenize,
    upsert_catalog_card,
    utc_now,
)
from import_pokemontcg_catalog import fetch_card_by_id, map_card, search_cards as search_remote_cards
from pricing_provider import PricingProviderRegistry, PsaPricingResult, RawPricingResult
from pokemontcg_pricing_adapter import PokemonTcgApiProvider
from pricecharting_adapter import PriceChartingProvider
from scrydex_adapter import (
    ScrydexProvider,
    map_scrydex_catalog_card,
    normalize_scrydex_language_code,
    scrydex_card_data,
    scrydex_credentials,
    search_scrydex_cards,
)
from slab_source_sync import (
    load_sync_state,
    manifest_sync_status,
    run_slab_source_sync_loop,
    sync_slab_sources_once,
)

# Legacy in-memory provider cache (optional diagnostics only)
try:
    from price_cache import price_cache, start_background_cleanup
    CACHE_AVAILABLE = True
except ImportError:
    CACHE_AVAILABLE = False
    price_cache = None
    start_background_cleanup = None


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8787


class SpotlightScanService:
    def __init__(self, database_path: Path, repo_root: Path, cards_path: Path | None = None) -> None:
        self.database_path = database_path
        self.repo_root = repo_root
        self.cards_path = cards_path
        manifest_value = os.environ.get("SPOTLIGHT_SLAB_SOURCE_MANIFEST")
        if manifest_value:
            manifest_path = Path(manifest_value)
            self.slab_source_manifest_path = manifest_path if manifest_path.is_absolute() else repo_root / manifest_path
        else:
            self.slab_source_manifest_path = None
        self.slab_sync_state_path = Path(
            os.environ.get("SPOTLIGHT_SLAB_SYNC_STATE_PATH")
            or (repo_root / "backend" / "data" / "slab_source_sync_state.json")
        )
        self.connection = connect(database_path)
        recompute_all_slab_price_snapshots(self.connection)
        self.index = load_index(self.connection)

        # Initialize pricing providers.
        # Runtime scanner mode is strict by lane:
        # - raw scans refresh/display through Pokemon TCG API
        # - PSA slab scans refresh/display through Scrydex
        # PriceCharting remains registered for non-default/manual PSA workflows only.
        self.pricing_registry = PricingProviderRegistry()
        self.pricing_registry.register(PokemonTcgApiProvider())  # Raw only
        self.pricing_registry.register(ScrydexProvider())        # Primary PSA/slab source
        self.pricing_registry.register(PriceChartingProvider())  # Auxiliary PSA provider

    def _pricing_provenance_for_card(
        self,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
    ) -> dict[str, Any] | None:
        if grader and grade:
            return contextual_pricing_summary_for_card(
                self.connection,
                card_id,
                grader=grader,
                grade=grade,
            )

        row = self.connection.execute(
            """
            SELECT
                source,
                currency_code,
                variant,
                low_price,
                market_price,
                mid_price,
                high_price,
                direct_low_price,
                trend_price,
                source_updated_at,
                source_url,
                source_payload_json,
                updated_at
            FROM card_price_summaries
            WHERE card_id = ?
            LIMIT 1
            """,
            (card_id,),
        ).fetchone()
        if row is None:
            return None

        source_payload = json.loads(row["source_payload_json"] or "{}")
        primary_price = (
            row["market_price"]
            if row["market_price"] is not None
            else row["mid_price"]
            if row["mid_price"] is not None
            else row["low_price"]
            if row["low_price"] is not None
            else row["trend_price"]
        )
        return {
            "provider": source_payload.get("provider"),
            "source": row["source"],
            "variant": row["variant"],
            "currencyCode": row["currency_code"],
            "primaryPrice": primary_price,
            "market": row["market_price"],
            "mid": row["mid_price"],
            "low": row["low_price"],
            "high": row["high_price"],
            "directLow": row["direct_low_price"],
            "trend": row["trend_price"],
            "sourceUpdatedAt": row["source_updated_at"],
            "refreshedAt": row["updated_at"],
            "sourceURL": row["source_url"],
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

    @staticmethod
    def _primary_price_value(pricing: dict[str, Any] | None) -> float | None:
        if not pricing:
            return None
        for key in ("market", "mid", "low", "trend", "high", "directLow"):
            value = pricing.get(key)
            if isinstance(value, (int, float)):
                return float(value)
        return None

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
        best_provenance = (
            self._pricing_provenance_for_card(str(best_candidate["id"]))
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
            "directLookupLikely": request_payload.get("directLookupLikely"),
            "resolverMode": response_payload.get("resolverMode"),
            "resolverPath": response_payload.get("resolverPath"),
            "confidence": response_payload.get("confidence"),
            "reviewDisposition": response_payload.get("reviewDisposition"),
            "reviewReason": response_payload.get("reviewReason"),
            "collectorNumber": request_payload.get("collectorNumber"),
            "setHintTokens": request_payload.get("setHintTokens") or [],
            "trustedSetHints": sorted(trusted_set_hints_for_payload(request_payload)),
            "promoCodeHint": request_payload.get("promoCodeHint"),
            "topCandidate": best_candidate,
            "topCandidates": top_candidate_summaries,
            "ambiguityFlags": response_payload.get("ambiguityFlags") or [],
            "catalogMissImportedCardID": response_payload.get("catalogMissImportedCardID"),
            "matcherVersion": response_payload.get("matcherVersion"),
        }

    def _emit_structured_log(self, payload: dict[str, Any]) -> None:
        print(json.dumps(payload, separators=(",", ":"), default=str), flush=True)

    def _scan_error_log_payload(
        self,
        request_payload: dict[str, Any],
        error: Exception,
    ) -> dict[str, Any]:
        return {
            "severity": "ERROR",
            "event": "scan_match_error",
            "scanID": request_payload.get("scanID"),
            "capturedAt": request_payload.get("capturedAt"),
            "cropConfidence": request_payload.get("cropConfidence"),
            "directLookupLikely": request_payload.get("directLookupLikely"),
            "resolverModeHint": request_payload.get("resolverModeHint"),
            "collectorNumber": request_payload.get("collectorNumber"),
            "setHintTokens": request_payload.get("setHintTokens") or [],
            "trustedSetHints": sorted(trusted_set_hints_for_payload(request_payload)),
            "promoCodeHint": request_payload.get("promoCodeHint"),
            "errorType": type(error).__name__,
            "errorText": str(error),
            "matcherVersion": MATCHER_VERSION,
        }

    def refresh_index(self) -> None:
        self.index = load_index(self.connection)

    def health(self) -> dict[str, Any]:
        active_raw_provider = self.pricing_registry.get_active_provider(for_raw=True)
        active_psa_provider = self.pricing_registry.get_active_provider(for_raw=False, for_psa=True)

        return {
            "status": "ok",
            "catalogCount": len(self.index),
            "visualReferenceCount": sum(1 for card in self.index.cards if card.image_embedding is not None),
            "matcherVersion": MATCHER_VERSION,
            "activeRawPricingProvider": active_raw_provider.get_metadata().provider_id if active_raw_provider else "none",
            "activePsaPricingProvider": active_psa_provider.get_metadata().provider_id if active_psa_provider else "none",
            "supportedScanScopes": [
                "pokemon",
                "single_card_photo",
                "raw_cards",
                "psa_slabs",
                "english_first",
            ],
            "unsupportedScanScopes": [
                "binder_pages",
                "multi_card_photo",
                "bulk_auto_detect_without_capture",
                "bgs_cgc_grade_pricing",
            ],
        }

    def provider_status(self) -> dict[str, Any]:
        # Get all registered providers
        providers = self.pricing_registry.list_providers()
        provider_details = []

        for metadata in providers:
            # Get last refresh time for each provider
            raw_refresh_row = self.connection.execute(
                """
                SELECT updated_at
                FROM card_price_summaries
                WHERE source = ?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (metadata.provider_id,),
            ).fetchone()

            slab_refresh_row = self.connection.execute(
                """
                SELECT updated_at
                FROM slab_price_snapshots
                WHERE source_payload_json LIKE ?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (f'%"source": "{metadata.provider_id}"%',),
            ).fetchone()

            provider_details.append({
                "providerId": metadata.provider_id,
                "providerLabel": metadata.provider_label,
                "isReady": metadata.is_ready,
                "requiresCredentials": metadata.requires_credentials,
                "supportsRawPricing": metadata.supports_raw_pricing,
                "supportsPsaPricing": metadata.supports_psa_pricing,
                "lastRawRefreshAt": raw_refresh_row["updated_at"] if raw_refresh_row else None,
                "lastPsaRefreshAt": slab_refresh_row["updated_at"] if slab_refresh_row else None,
            })

        active_raw_provider = self.pricing_registry.get_active_provider(for_raw=True)
        active_psa_provider = self.pricing_registry.get_active_provider(for_raw=False, for_psa=True)

        unresolved = self.unmatched_scans(limit=25)
        latest_sync = latest_catalog_sync_run(self.connection)
        recent_refresh_failures = pricing_refresh_failures(self.connection, limit=10)
        slab_sync_manifest_status = manifest_sync_status(self.slab_source_manifest_path) if self.slab_source_manifest_path else None

        return {
            "providers": provider_details,
            "activeRawProvider": active_raw_provider.get_metadata().provider_id if active_raw_provider else None,
            "activePsaProvider": active_psa_provider.get_metadata().provider_id if active_psa_provider else None,
            "slabSourceSyncConfigured": self.slab_source_manifest_path is not None,
            "slabSourceAuthReady": (slab_sync_manifest_status["missingEnvSourceCount"] == 0) if slab_sync_manifest_status else False,
            "slabSourceReadyCount": slab_sync_manifest_status["readySourceCount"] if slab_sync_manifest_status else 0,
            "slabSourceMissingEnvSourceCount": slab_sync_manifest_status["missingEnvSourceCount"] if slab_sync_manifest_status else 0,
            "lastCatalogSyncAt": latest_sync["completedAt"] if latest_sync else None,
            "lastCatalogSyncStatus": latest_sync["status"] if latest_sync else None,
            "unmatchedScanCount": unresolved["summary"]["openReviewCount"],
            "likelyUnsupportedCount": unresolved["summary"]["likelyUnsupportedCount"],
            "recentPricingRefreshFailureCount": len(recent_refresh_failures),
            "lastPricingRefreshFailureAt": recent_refresh_failures[0]["createdAt"] if recent_refresh_failures else None,
        }

    def cache_status(self) -> dict[str, Any]:
        """Get runtime cache statistics plus persisted pricing freshness state."""
        stale_cutoff = (datetime.now(UTC) - timedelta(hours=DEFAULT_PRICING_FRESHNESS_HOURS)).isoformat()
        raw_snapshot_row = self.connection.execute(
            """
            SELECT
                COUNT(*) AS snapshot_count,
                SUM(CASE WHEN updated_at < ? THEN 1 ELSE 0 END) AS stale_count,
                MIN(updated_at) AS oldest_snapshot_at,
                AVG((julianday('now') - julianday(updated_at)) * 24.0) AS average_age_hours,
                MAX((julianday('now') - julianday(updated_at)) * 24.0) AS max_age_hours
            FROM card_price_summaries
            """,
            (stale_cutoff,),
        ).fetchone()
        slab_snapshot_row = self.connection.execute(
            """
            SELECT
                COUNT(*) AS snapshot_count,
                SUM(CASE WHEN updated_at < ? THEN 1 ELSE 0 END) AS stale_count,
                MIN(updated_at) AS oldest_snapshot_at,
                AVG((julianday('now') - julianday(updated_at)) * 24.0) AS average_age_hours,
                MAX((julianday('now') - julianday(updated_at)) * 24.0) AS max_age_hours
            FROM slab_price_snapshots
            """,
            (stale_cutoff,),
        ).fetchone()
        cache_payload = None
        cache_status = "disabled"
        cache_message = "Legacy in-memory provider cache is disabled by default. Persisted DB snapshots are the freshness source of truth."
        if CACHE_AVAILABLE and price_cache:
            cache_payload = price_cache.get_stats()
            cache_status = "ok"
            cache_message = None

        return {
            "status": cache_status,
            "message": cache_message,
            "cache": cache_payload,
            "freshnessWindowHours": DEFAULT_PRICING_FRESHNESS_HOURS,
            "rawSnapshots": {
                "count": raw_snapshot_row["snapshot_count"] if raw_snapshot_row else 0,
                "staleCount": raw_snapshot_row["stale_count"] if raw_snapshot_row and raw_snapshot_row["stale_count"] is not None else 0,
                "oldestSnapshotAt": raw_snapshot_row["oldest_snapshot_at"] if raw_snapshot_row else None,
                "averageAgeHours": round(raw_snapshot_row["average_age_hours"], 2) if raw_snapshot_row and raw_snapshot_row["average_age_hours"] is not None else None,
                "maxAgeHours": round(raw_snapshot_row["max_age_hours"], 2) if raw_snapshot_row and raw_snapshot_row["max_age_hours"] is not None else None,
            },
            "slabSnapshots": {
                "count": slab_snapshot_row["snapshot_count"] if slab_snapshot_row else 0,
                "staleCount": slab_snapshot_row["stale_count"] if slab_snapshot_row and slab_snapshot_row["stale_count"] is not None else 0,
                "oldestSnapshotAt": slab_snapshot_row["oldest_snapshot_at"] if slab_snapshot_row else None,
                "averageAgeHours": round(slab_snapshot_row["average_age_hours"], 2) if slab_snapshot_row and slab_snapshot_row["average_age_hours"] is not None else None,
                "maxAgeHours": round(slab_snapshot_row["max_age_hours"], 2) if slab_snapshot_row and slab_snapshot_row["max_age_hours"] is not None else None,
            },
            "timestamp": datetime.now(UTC).isoformat()
        }

    def catalog_sync_status(self) -> dict[str, Any]:
        latest_run = latest_catalog_sync_run(self.connection)
        return {
            "cardsPath": str(self.cards_path) if self.cards_path else None,
            "latestRun": latest_run,
            "recentRuns": catalog_sync_runs(self.connection, limit=10),
        }

    def recent_pricing_refresh_failures(self, limit: int = 20) -> dict[str, Any]:
        failures = pricing_refresh_failures(self.connection, limit=limit)
        return {
            "count": len(failures),
            "items": failures,
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

    def record_pricing_refresh_failure(
        self,
        *,
        card_id: str | None,
        grader: str | None,
        grade: str | None,
        source: str,
        error_text: str,
    ) -> None:
        log_pricing_refresh_failure(
            self.connection,
            card_id=card_id,
            grader=grader,
            grade=grade,
            source=source,
            error_text=error_text,
        )

    def import_slab_sales(self, sales: list[dict[str, Any]]) -> dict[str, Any]:
        summary = import_slab_sales(self.connection, sales)
        return {"summary": summary}

    def slab_sales(self, card_id: str, grader: str | None = None, grade: str | None = None, limit: int = 20) -> dict[str, Any]:
        return {
            "cardID": card_id,
            "grader": grader,
            "grade": grade,
            "sales": slab_sales_for_card(self.connection, card_id, grader=grader, grade=grade, limit=limit),
        }

    def slab_price_snapshot(self, card_id: str, grader: str, grade: str) -> dict[str, Any] | None:
        pricing = contextual_pricing_summary_for_card(self.connection, card_id, grader=grader, grade=grade)
        if pricing is None or pricing.get("pricingMode") != "psa_grade_estimate":
            return None
        return {
            "cardID": card_id,
            "grader": grader,
            "grade": grade,
            "pricing": pricing,
        }

    def slab_sync_status(self) -> dict[str, Any]:
        return {
            "configured": self.slab_source_manifest_path is not None,
            "manifestPath": str(self.slab_source_manifest_path) if self.slab_source_manifest_path else None,
            "statePath": str(self.slab_sync_state_path),
            "state": load_sync_state(self.slab_sync_state_path),
            "manifestStatus": manifest_sync_status(self.slab_source_manifest_path) if self.slab_source_manifest_path else None,
        }

    def run_slab_source_sync_once(self) -> dict[str, Any]:
        if self.slab_source_manifest_path is None:
            raise ValueError("SPOTLIGHT_SLAB_SOURCE_MANIFEST is not configured")
        return sync_slab_sources_once(
            database_path=self.database_path,
            repo_root=self.repo_root,
            manifest_path=self.slab_source_manifest_path,
            state_path=self.slab_sync_state_path,
        )

    def _persist_mapped_catalog_card(
        self,
        *,
        mapped_card: dict[str, Any],
        sync_mode: str,
        trigger_source: str,
        query_text: str | None,
        refresh_embeddings: bool = False,
    ) -> dict[str, Any]:
        started_at = utc_now()
        cards_before = len(self.index)
        card_existed_before = self._card_exists(mapped_card["id"])

        upsert_catalog_card(
            self.connection,
            mapped_card,
            self.repo_root,
            started_at,
            refresh_embeddings=refresh_embeddings,
        )

        self.connection.commit()
        self.refresh_index()

        log_catalog_sync_run(
            self.connection,
            started_at=started_at,
            completed_at=utc_now(),
            sync_mode=sync_mode,
            trigger_source=trigger_source,
            query_text=query_text,
            status="success",
            cards_before=cards_before,
            cards_after=len(self.index),
            cards_added=0 if card_existed_before else 1,
            cards_updated=1 if card_existed_before else 0,
            summary={
                "cardID": mapped_card["id"],
                "setName": mapped_card["set_name"],
                "number": mapped_card["number"],
            },
        )
        return mapped_card

    def _persist_catalog_card(
        self,
        *,
        raw_card: dict[str, Any],
        sync_mode: str,
        trigger_source: str,
        query_text: str | None,
        local_image_path: Path | None = None,
        refresh_embeddings: bool = False,
    ) -> dict[str, Any]:
        mapped_card = map_card(raw_card, local_image_path)
        return self._persist_mapped_catalog_card(
            mapped_card=mapped_card,
            sync_mode=sync_mode,
            trigger_source=trigger_source,
            query_text=query_text,
            refresh_embeddings=refresh_embeddings,
        )

    def import_catalog_card(self, card_id: str, api_key: str | None = None, *, trigger_source: str = "manual") -> dict[str, Any] | None:
        started_at = utc_now()
        cards_before = len(self.index)
        try:
            raw_card = fetch_card_by_id(card_id, api_key)
        except Exception as error:
            log_catalog_sync_run(
                self.connection,
                started_at=started_at,
                completed_at=utc_now(),
                sync_mode="exact_card_import",
                trigger_source=trigger_source,
                query_text=card_id,
                status="failed",
                cards_before=cards_before,
                cards_after=cards_before,
                cards_added=0,
                cards_updated=0,
                summary={},
                error_text=str(error),
            )
            raise

        return self._persist_catalog_card(
            raw_card=raw_card,
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

    def _slab_cert_card_ids(self, payload: dict[str, Any]) -> list[str]:
        slab_context = slab_context_from_payload(payload)
        if slab_context is None:
            return []

        grader = str(slab_context.get("grader") or "").strip().upper()
        cert_number = str(slab_context.get("certNumber") or "").strip()
        if grader != "PSA" or not cert_number:
            return []

        rows = self.connection.execute(
            """
            SELECT DISTINCT card_id
            FROM slab_sales
            WHERE grader = ? AND cert_number = ? AND accepted = 1
            ORDER BY card_id
            """,
            (grader, cert_number),
        ).fetchall()
        return [
            row["card_id"]
            for row in rows
            if row["card_id"] and runtime_supported_card_id(row["card_id"])
        ]

    def _catalog_miss_queries(self, payload: dict[str, Any]) -> list[str]:
        resolver_mode = resolver_mode_for_payload(payload)
        collector_number = str(payload.get("collectorNumber") or "").strip()
        if not collector_number and resolver_mode == "psa_slab":
            collector_number = str(payload.get("slabCardNumberRaw") or "").strip()
        if not collector_number:
            return []

        raw_set_hints = trusted_set_hints_for_payload(payload)
        api_number_values = collector_number_api_query_values(collector_number)
        printed_total = collector_number_printed_total(collector_number)
        if not api_number_values:
            return []

        queries: list[str] = []
        seen: set[str] = set()
        slab_name_tokens = self._slab_catalog_name_tokens(payload) if resolver_mode == "psa_slab" else []
        slab_set_names = self._slab_catalog_set_names(payload) if resolver_mode == "psa_slab" else []

        for api_number in api_number_values:
            if printed_total is not None:
                query = f"set.printedTotal:{printed_total} number:\"{api_number.upper()}\""
                if query not in seen:
                    seen.add(query)
                    queries.append(query)

            for set_hint in sorted(raw_set_hints):
                ptcgo_codes = {set_hint.upper()}
                set_ids = {set_hint.lower()}
                set_names: set[str] = set()

                for set_name, aliases in KNOWN_SET_ALIASES.items():
                    if set_hint == set_name or set_hint in aliases:
                        set_names.add(set_name)
                        ptcgo_codes.update(alias.upper() for alias in aliases)

                for set_id, aliases in KNOWN_SET_ID_ALIASES.items():
                    if set_hint == set_id or set_hint in aliases:
                        set_ids.add(set_id.lower())
                        ptcgo_codes.update(alias.upper() for alias in aliases)

                for query in (
                    *(f"set.ptcgoCode:{code} number:\"{api_number.upper()}\"" for code in sorted(ptcgo_codes)),
                    *(f"set.id:{set_id} number:\"{api_number.lower()}\"" for set_id in sorted(set_ids)),
                    *(f"set.name:\"{set_name}\" number:\"{api_number.upper()}\"" for set_name in sorted(set_names)),
                ):
                    if query in seen:
                        continue
                    seen.add(query)
                    queries.append(query)

            if resolver_mode == "psa_slab":
                for set_name in slab_set_names:
                    query = f"set.name:\"{set_name}\" number:\"{api_number.upper()}\""
                    if query not in seen:
                        seen.add(query)
                        queries.append(query)

                for name_token in slab_name_tokens:
                    if printed_total is not None:
                        query = f"name:\"{name_token.title()}\" set.printedTotal:{printed_total} number:\"{api_number.upper()}\""
                        if query not in seen:
                            seen.add(query)
                            queries.append(query)

                    query = f"name:\"{name_token.title()}\" number:\"{api_number.upper()}\""
                    if query not in seen:
                        seen.add(query)
                        queries.append(query)

        return queries

    def _slab_scrydex_language_codes(self, payload: dict[str, Any]) -> list[str | None]:
        recognized_text = " ".join(
            part for part in [
                payload.get("topLabelRecognizedText") or "",
                payload.get("fullRecognizedText") or "",
            ]
            if part
        ).upper()
        codes: list[str | None] = []
        if re.search(r"\b(?:JPN|JAPANESE|JP)\b", recognized_text):
            codes.append("ja")
        if re.search(r"\b(?:EN|ENGLISH)\b", recognized_text):
            codes.append("en")
        codes.append(None)

        deduped: list[str | None] = []
        seen: set[str] = set()
        for code in codes:
            key = code or "_default"
            if key in seen:
                continue
            seen.add(key)
            deduped.append(code)
        return deduped

    def _slab_catalog_series_names(self, payload: dict[str, Any]) -> list[str]:
        recognized_text = " ".join(
            part for part in [
                payload.get("topLabelRecognizedText") or "",
                payload.get("fullRecognizedText") or "",
            ]
            if part
        ).upper()
        series_names: list[str] = []
        known_series = [
            ("SCARLET & VIOLET", "Scarlet & Violet"),
            ("SWORD & SHIELD", "Sword & Shield"),
            ("SUN & MOON", "Sun & Moon"),
            ("BLACK & WHITE", "Black & White"),
            ("DIAMOND & PEARL", "Diamond & Pearl"),
            ("HEARTGOLD & SOULSILVER", "HeartGold & SoulSilver"),
            ("XY", "XY"),
            ("EX", "EX"),
        ]
        for needle, label in known_series:
            if needle in recognized_text:
                series_names.append(label)
        return list(dict.fromkeys(series_names))

    def _slab_catalog_name_tokens(self, payload: dict[str, Any]) -> list[str]:
        recognized_text = " ".join(
            part for part in [
                payload.get("topLabelRecognizedText") or "",
                payload.get("fullRecognizedText") or "",
            ]
            if part
        )
        stop_tokens = {
            "pokemon",
            "game",
            "holo",
            "psa",
            "cgc",
            "bgs",
            "certified",
            "guaranty",
            "company",
            "universal",
            "grade",
            "base",
            "set",
            "shadowless",
            "unlimited",
            "mint",
            "gem",
            "nm",
            "mt",
            "perfect",
            "pristine",
            "card",
            "rare",
            "special",
            "illustration",
            "fsa",
            "fea",
        }
        ordered: list[str] = []
        seen: set[str] = set()
        for token in tokenize(recognized_text):
            if token.isdigit() or len(token) <= 2 or token in stop_tokens:
                continue
            if token in seen:
                continue
            seen.add(token)
            ordered.append(token)
        ordered.sort(key=lambda token: (-len(token), token))
        return ordered[:3]

    def _slab_catalog_set_names(self, payload: dict[str, Any]) -> list[str]:
        recognized_text = " ".join(
            part for part in [
                payload.get("topLabelRecognizedText") or "",
                payload.get("fullRecognizedText") or "",
            ]
            if part
        ).upper()
        set_names: list[str] = []
        if "POKEMON GO" in recognized_text:
            set_names.append("Pokemon GO")
        if "BASE SET" in recognized_text or "SHADOWLESS" in recognized_text or "UNLIMITED" in recognized_text:
            set_names.append("Base")
        if "TAG TEAM GX ALL STARS" in recognized_text:
            set_names.append("Tag Team GX All Stars")

        cleaned_text = re.sub(r"\b[A-Z]{3,}(?:/[A-Z0-9.\-]{2,})+\b", " ", recognized_text)
        candidate_tokens = [
            token
            for token in tokenize(cleaned_text)
            if token
            and not token.isdigit()
            and token
            not in {
                "pokemon",
                "pm",
                "p",
                "m",
                "psa",
                "cgc",
                "bgs",
                "sgc",
                "jpn",
                "japanese",
                "english",
                "mint",
                "gem",
                "nm",
                "mt",
                "grade",
                "cert",
                "certified",
                "guaranty",
                "company",
                "holo",
                "rev",
                "foil",
            }
        ]
        for start in range(len(candidate_tokens)):
            for length in range(min(7, len(candidate_tokens) - start), 2, -1):
                phrase_tokens = candidate_tokens[start:start + length]
                if len(phrase_tokens) < 3:
                    continue
                phrase = " ".join("GX" if token == "gx" else token.title() for token in phrase_tokens)
                set_names.append(phrase)

        deduped: list[str] = []
        seen: set[str] = set()
        for name in set_names:
            normalized = name.strip().lower()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            deduped.append(name.strip())
        return deduped[:8]

    def _slab_scrydex_queries(self, payload: dict[str, Any]) -> list[tuple[str | None, str]]:
        collector_number = str(payload.get("slabCardNumberRaw") or payload.get("collectorNumber") or "").strip()
        api_number_values = collector_number_api_query_values(collector_number)
        if not api_number_values:
            return []

        set_names = self._slab_catalog_set_names(payload)
        series_names = self._slab_catalog_series_names(payload)
        language_codes = self._slab_scrydex_language_codes(payload)

        queries: list[tuple[str | None, str]] = []
        seen: set[tuple[str | None, str]] = set()

        def add_query(language_code: str | None, query: str) -> None:
            key = (language_code, query)
            if key in seen:
                return
            seen.add(key)
            queries.append(key)

        for language_code in language_codes:
            for api_number in api_number_values:
                quoted_number = f"\"{api_number}\""
                for set_name in set_names[:6]:
                    add_query(language_code, f"expansion.name:\"{set_name}\" number:{quoted_number}")
                    for series_name in series_names[:3]:
                        add_query(
                            language_code,
                            f"expansion.series:\"{series_name}\" expansion.name:\"{set_name}\" number:{quoted_number}",
                        )
                for series_name in series_names[:3]:
                    add_query(language_code, f"expansion.series:\"{series_name}\" number:{quoted_number}")
                add_query(language_code, f"number:{quoted_number}")

        return queries

    def _slab_scrydex_expansion_ids(self, payload: dict[str, Any]) -> list[str]:
        # Keep this small and explicit. These are only for high-value slab miss lookups
        # where the OCR label gives us an English set name but the Japanese Scrydex
        # endpoint expects a localized expansion search.
        manual_aliases: dict[str, tuple[str, ...]] = {
            "tag team gx all stars": ("sm12a_ja",),
        }

        expansion_ids: list[str] = []
        seen: set[str] = set()
        for set_name in self._slab_catalog_set_names(payload):
            normalized = set_name.strip().lower()
            for expansion_id in manual_aliases.get(normalized, ()):
                if expansion_id in seen:
                    continue
                seen.add(expansion_id)
                expansion_ids.append(expansion_id)
        return expansion_ids

    def _score_scrydex_slab_candidate(
        self,
        card_payload: dict[str, Any],
        payload: dict[str, Any],
    ) -> tuple[float, tuple[int, float, float, float, float]]:
        card_data = scrydex_card_data(card_payload)
        expansion = card_data.get("expansion") if isinstance(card_data.get("expansion"), dict) else {}
        translation = card_data.get("translation") if isinstance(card_data.get("translation"), dict) else {}
        translation_en = translation.get("en") if isinstance(translation.get("en"), dict) else {}

        label_text = " ".join(
            part for part in [
                payload.get("topLabelRecognizedText") or "",
                payload.get("fullRecognizedText") or "",
            ]
            if part
        )
        label_tokens = set(tokenize(label_text))
        slab_number_hints = slab_payload_number_hints(payload)

        candidate_number = str(card_data.get("printed_number") or card_data.get("number") or "")
        candidate_number_keys = collector_number_lookup_keys(candidate_number)
        number_match = 1 if slab_number_hints and not candidate_number_keys.isdisjoint(slab_number_hints) else 0

        expected_languages = {
            code for code in self._slab_scrydex_language_codes(payload)
            if code is not None
        }
        candidate_language_code = normalize_scrydex_language_code(card_data.get("language"))
        language_match = 1.0 if not expected_languages else (1.0 if candidate_language_code in expected_languages else 0.0)

        set_name = str(expansion.get("name") or "")
        set_series = str(expansion.get("series") or "")
        set_text = " ".join(part for part in [set_name, set_series] if part)
        set_tokens = set(tokenize(set_text))
        set_overlap = len(set_tokens & label_tokens) / max(len(set_tokens), 1) if set_tokens else 0.0

        candidate_set_names = {value.lower() for value in self._slab_catalog_set_names(payload)}
        set_name_exact = 1.0 if set_name and set_name.lower() in candidate_set_names else 0.0

        candidate_series_names = {value.lower() for value in self._slab_catalog_series_names(payload)}
        series_match = 1.0 if set_series and set_series.lower() in candidate_series_names else 0.0

        name_text = " ".join(
            part for part in [
                str(translation_en.get("name") or "").strip(),
                str(card_data.get("name") or "").strip(),
            ]
            if part
        )
        name_tokens = {
            token for token in tokenize(name_text)
            if len(token) > 1 and token not in {"gx", "ex", "v", "vm", "vmax", "star"}
        }
        name_overlap = len(name_tokens & label_tokens) / max(len(name_tokens), 1) if name_tokens else 0.0

        score = (
            (number_match * 8.0) +
            (set_name_exact * 5.0) +
            (series_match * 2.5) +
            (set_overlap * 3.5) +
            (name_overlap * 2.0) +
            (language_match * 1.0)
        )
        return score, (
            number_match,
            set_name_exact,
            series_match,
            set_overlap,
            name_overlap,
        )

    def resolve_slab_catalog_miss(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        credentials = scrydex_credentials()
        if credentials is None:
            return None
        api_key, team_id = credentials

        best_results_by_card_id: dict[str, tuple[float, float, dict[str, Any], str, str | None]] = {}

        def ingest_results(
            results: list[dict[str, Any]],
            *,
            query: str,
            language_code: str | None,
        ) -> None:
            for card_payload in results:
                score, components = self._score_scrydex_slab_candidate(card_payload, payload)
                exactish_score = components[1] + components[2] + components[3] + components[4]
                card_data = scrydex_card_data(card_payload)
                card_id = str(card_data.get("id") or "").strip()
                if not card_id:
                    continue

                existing = best_results_by_card_id.get(card_id)
                if existing is None or score > existing[0]:
                    best_results_by_card_id[card_id] = (score, exactish_score, card_payload, query, language_code)

        def best_importable_result() -> tuple[float, float, dict[str, Any], str, str | None] | None:
            if not best_results_by_card_id:
                return None
            ranked_results = sorted(
                best_results_by_card_id.values(),
                key=lambda item: (-item[0], -item[1], str(scrydex_card_data(item[2]).get("id") or "")),
            )
            best_score, exactish_score, best_payload, query, language_code = ranked_results[0]
            runner_up_score = ranked_results[1][0] if len(ranked_results) > 1 else 0.0
            if best_score < 10.0 or exactish_score <= 0.0:
                return None
            if runner_up_score and (best_score - runner_up_score) < 1.2:
                return None
            return best_score, exactish_score, best_payload, query, language_code

        # Phase 1: compact Japanese expansion-id lookup. This avoids dozens of
        # low-signal queries when the OCR label already gives us a strong set clue.
        language_codes = self._slab_scrydex_language_codes(payload)
        japanese_expansion_ids = self._slab_scrydex_expansion_ids(payload)
        if japanese_expansion_ids and "ja" in {code for code in language_codes if code}:
            for expansion_id in japanese_expansion_ids:
                query = f"expansion.id:{expansion_id}"
                try:
                    results = search_scrydex_cards(
                        query,
                        api_key,
                        team_id,
                        page_size=100,
                        language_code="ja",
                    )
                except Exception:
                    continue
                ingest_results(results, query=query, language_code="ja")

            compact_best_result = best_importable_result()
            if compact_best_result is not None:
                _, _, best_payload, query, _ = compact_best_result
                imported = self._persist_mapped_catalog_card(
                    mapped_card=map_scrydex_catalog_card(best_payload),
                    sync_mode="slab_catalog_miss_lookup",
                    trigger_source="scan_match",
                    query_text=query,
                )
                return {
                    "query": query,
                    "card": imported,
                }

        for language_code, query in self._slab_scrydex_queries(payload):
            try:
                results = search_scrydex_cards(
                    query,
                    api_key,
                    team_id,
                    page_size=25,
                    language_code=language_code,
                )
            except Exception:
                continue

            ingest_results(results, query=query, language_code=language_code)

        best_result = best_importable_result()
        if best_result is None:
            return None
        _, _, best_payload, query, _ = best_result

        imported = self._persist_mapped_catalog_card(
            mapped_card=map_scrydex_catalog_card(best_payload),
            sync_mode="slab_catalog_miss_lookup",
            trigger_source="scan_match",
            query_text=query,
        )
        return {
            "query": query,
            "card": imported,
        }

    def resolve_catalog_miss(self, payload: dict[str, Any], api_key: str | None = None) -> dict[str, Any] | None:
        if resolver_mode_for_payload(payload) == "psa_slab":
            imported_slab = self.resolve_slab_catalog_miss(payload)
            if imported_slab is not None:
                return imported_slab

        recognized_text = recognized_text_for_payload(payload)
        query_tokens = {
            token
            for token in tokenize(recognized_text)
            if len(token) > 2 and token not in {"pokemon", "card", "rare", "illustration"}
        }
        collector_number = str(payload.get("collectorNumber") or payload.get("slabCardNumberRaw") or "")
        raw_number_values = {value.lower() for value in collector_number_api_query_values(collector_number)}
        printed_total = collector_number_printed_total(collector_number)
        set_hints = trusted_set_hints_for_payload(payload)
        pokedex_hints = recognized_pokedex_number_hints(recognized_text)
        artist_hints = recognized_artist_tokens(recognized_text)

        for query in self._catalog_miss_queries(payload):
            results = search_remote_cards(query, api_key, page_size=5)
            if not results:
                continue

            def sort_key(raw_card: dict[str, Any]) -> tuple[int, int, int, int, int, int, str]:
                number = str(raw_card.get("number") or "").lower()
                set_info = raw_card.get("set") or {}
                set_name = str(set_info.get("name") or "")
                set_tokens = set(tokenize(set_name))
                set_codes = {
                    str(set_info.get("ptcgoCode") or "").lower(),
                    str(set_info.get("id") or "").lower(),
                }
                set_codes.discard("")
                exact_number = 1 if raw_number_values and number in raw_number_values else 0
                printed_total_match = 1 if printed_total is not None and set_info.get("printedTotal") == printed_total else 0
                set_hint_match = 1 if set_hints and not set_hints.isdisjoint(set_tokens | set_codes) else 0
                pokedex_numbers = {str(value).lstrip("0") or "0" for value in (raw_card.get("nationalPokedexNumbers") or [])}
                pokedex_match = 1 if pokedex_hints and not pokedex_hints.isdisjoint(pokedex_numbers) else 0
                artist_tokens = recognized_artist_tokens(str(raw_card.get("artist") or ""))
                artist_match = 1 if artist_hints and len(artist_hints & artist_tokens) >= min(2, len(artist_tokens) or 99) else 0
                name_tokens = set(tokenize(str(raw_card.get("name") or "")))
                name_overlap = len(name_tokens & query_tokens)
                return (
                    -exact_number,
                    -printed_total_match,
                    -set_hint_match,
                    -pokedex_match,
                    -artist_match,
                    -name_overlap,
                    set_name,
                )

            ranked = sorted(results, key=sort_key)
            best = ranked[0]
            best_number = str(best.get("number") or "").lower()
            best_set_info = best.get("set") or {}
            if raw_number_values and best_number not in raw_number_values:
                continue
            if printed_total is not None and best_set_info.get("printedTotal") != printed_total:
                continue

            imported = self._persist_catalog_card(
                raw_card=best,
                sync_mode="catalog_miss_lookup",
                trigger_source="scan_match",
                query_text=query,
            )
            return {
                "query": query,
                "card": imported,
            }

        return None

    def refresh_card_pricing(
        self,
        card_id: str,
        api_key: str | None = None,
        grader: str | None = None,
        grade: str | None = None,
        force_refresh: bool = False,
    ) -> dict[str, Any] | None:
        def fetch_card_row() -> sqlite3.Row | None:
            return self.connection.execute(
                """
                SELECT
                    cards.id,
                    card_catalog_metadata.source,
                    card_images.local_path
                FROM cards
                LEFT JOIN card_catalog_metadata ON card_catalog_metadata.card_id = cards.id
                LEFT JOIN card_images
                    ON card_images.card_id = cards.id
                   AND card_images.role = 'reference_front'
                WHERE cards.id = ?
                LIMIT 1
                """,
                (card_id,),
            ).fetchone()

        row = fetch_card_row()

        if row is None and api_key:
            try:
                imported = self.import_catalog_card(
                    card_id,
                    api_key=api_key,
                    trigger_source="refresh_pricing_auto_import",
                )
                if imported is not None:
                    row = fetch_card_row()
            except Exception:
                row = None

        if row is None:
            return None

        if grader and not grade:
            return self.card_detail(card_id, grader=grader, grade=grade)

        if grader and grade:
            existing_pricing = slab_price_snapshot_for_card(self.connection, card_id, grader, grade)
            if (
                existing_pricing is not None
                and not force_refresh
                and existing_pricing.get("isFresh") is True
            ):
                print(
                    f"[PRICING DEBUG] refresh_slab_cached: card={card_id} "
                    f"grader={grader} grade={grade} ageHours={existing_pricing.get('snapshotAgeHours')}"
                )
                return self.card_detail(card_id, grader=grader, grade=grade)
        elif not grader and not grade:
            existing_pricing = raw_pricing_summary_for_card(self.connection, card_id)
            if (
                existing_pricing is not None
                and not force_refresh
                and existing_pricing.get("isFresh") is True
            ):
                print(
                    f"[PRICING DEBUG] refresh_raw_cached: card={card_id} "
                    f"ageHours={existing_pricing.get('snapshotAgeHours')}"
                )
                return self.card_detail(card_id)

        # Try provider registry for pricing refresh
        provider_refresh_result = None
        if grader and grade:
            scrydex_provider = self.pricing_registry.get_provider("scrydex")
            if scrydex_provider is None or not scrydex_provider.is_ready():
                provider_refresh_result = PsaPricingResult(
                    success=False,
                    provider_id="scrydex",
                    card_id=card_id,
                    grade=grade,
                    error=f"Scrydex {grader} pricing is not configured",
                )
            else:
                if grader.upper() == "PSA":
                    provider_refresh_result = scrydex_provider.refresh_psa_pricing(
                        self.connection, card_id, grade
                    )
                else:
                    refresh_slab = getattr(scrydex_provider, "refresh_slab_pricing", None)
                    if callable(refresh_slab):
                        provider_refresh_result = refresh_slab(
                            self.connection, card_id, grader, grade
                        )
                    else:
                        provider_refresh_result = PsaPricingResult(
                            success=False,
                            provider_id="scrydex",
                            card_id=card_id,
                            grade=grade,
                            error=f"Scrydex {grader} pricing is not supported by this build",
                        )
            if provider_refresh_result.success:
                self._log_pricing_provenance("refresh_slab", card_id, grader=grader, grade=grade)
                return self.card_detail(card_id, grader=grader, grade=grade)
        elif not grader and not grade:
            raw_provider = self.pricing_registry.get_provider("pokemontcg_api")
            if raw_provider is None or not raw_provider.is_ready():
                provider_refresh_result = RawPricingResult(
                    success=False,
                    provider_id="pokemontcg_api",
                    card_id=card_id,
                    error="Pokemon TCG API raw pricing is not configured",
                )
            else:
                provider_refresh_result = raw_provider.refresh_raw_pricing(
                    self.connection, card_id
                )
            if provider_refresh_result.success:
                self._log_pricing_provenance("refresh_raw", card_id)
                return self.card_detail(card_id)

        # Log provider failure if we tried and failed
        if provider_refresh_result and not provider_refresh_result.success and provider_refresh_result.error:
            log_pricing_refresh_failure(
                self.connection,
                card_id=card_id,
                grader=grader,
                grade=grade,
                source=provider_refresh_result.provider_id,
                error_text=provider_refresh_result.error,
            )

        # Fallback: recompute slab snapshots from local data
        if grader and grade:
            recompute_slab_price_snapshot(self.connection, card_id, grader, grade)
            return self.card_detail(card_id, grader=grader, grade=grade)

        if row["source"] != "pokemontcg_api" or not api_key:
            return self.card_detail(card_id, grader=grader, grade=grade)

        # Fallback: refresh from Pokemon TCG API
        raw_card = fetch_card_by_id(card_id, api_key)
        local_image_path = None
        if row["local_path"]:
            local_path = Path(row["local_path"])
            if local_path.exists():
                local_image_path = local_path

        mapped_card = self._persist_catalog_card(
            raw_card=raw_card,
            local_image_path=local_image_path,
            sync_mode="refresh_existing_card",
            trigger_source="refresh_pricing",
            query_text=card_id,
            refresh_embeddings=False,
        )
        if grader and grade:
            recompute_slab_price_snapshot(self.connection, card_id, grader, grade)
        return self.card_detail(card_id, grader=grader, grade=grade)

    def card_detail(self, card_id: str, *, grader: str | None = None, grade: str | None = None) -> dict[str, Any] | None:
        row = self.connection.execute(
            """
            SELECT
                cards.id,
                cards.name,
                cards.set_name,
                cards.number,
                cards.rarity,
                cards.variant,
                cards.language,
                card_catalog_metadata.source,
                card_catalog_metadata.source_record_id,
                card_catalog_metadata.set_id,
                card_catalog_metadata.set_series,
                card_catalog_metadata.set_release_date,
                card_catalog_metadata.supertype,
                card_catalog_metadata.artist,
                card_catalog_metadata.regulation_mark,
                card_catalog_metadata.images_small_url,
                card_catalog_metadata.images_large_url,
                card_price_summaries.source AS pricing_source,
                card_price_summaries.currency_code AS pricing_currency_code,
                card_price_summaries.variant AS pricing_variant,
                card_price_summaries.low_price AS pricing_low_price,
                card_price_summaries.market_price AS pricing_market_price,
                card_price_summaries.mid_price AS pricing_mid_price,
                card_price_summaries.high_price AS pricing_high_price,
                card_price_summaries.direct_low_price AS pricing_direct_low_price,
                card_price_summaries.trend_price AS pricing_trend_price,
                card_price_summaries.source_updated_at AS pricing_updated_at,
                card_price_summaries.source_url AS pricing_source_url,
                card_price_summaries.updated_at AS pricing_refreshed_at
            FROM cards
            LEFT JOIN card_catalog_metadata ON card_catalog_metadata.card_id = cards.id
            LEFT JOIN card_price_summaries ON card_price_summaries.card_id = cards.id
            WHERE cards.id = ?
            LIMIT 1
            """,
            (card_id,),
        ).fetchone()

        if row is None:
            return None

        pricing = contextual_pricing_summary_for_card(
            self.connection,
            card_id,
            grader=grader,
            grade=grade,
        )

        return {
            "card": {
                "id": row["id"],
                "name": row["name"],
                "setName": row["set_name"],
                "number": row["number"],
                "rarity": row["rarity"],
                "variant": row["variant"],
                "language": row["language"],
                "pricing": pricing,
            },
            "slabContext": {
                "grader": grader,
                "grade": grade,
            } if grader and grade else None,
            "source": row["source"],
            "sourceRecordID": row["source_record_id"],
            "setID": row["set_id"],
            "setSeries": row["set_series"],
            "setReleaseDate": row["set_release_date"],
            "supertype": row["supertype"],
            "artist": row["artist"],
            "regulationMark": row["regulation_mark"],
            "imageSmallURL": row["images_small_url"],
            "imageLargeURL": row["images_large_url"],
        }

    def match_scan(self, payload: dict[str, Any]) -> dict[str, Any]:
        allow_live_catalog_miss = payload.get("_allowLiveCatalogMiss", True) is not False
        api_key = os.environ.get("POKEMONTCG_API_KEY")
        scored_candidates: list[dict[str, Any]] = []
        resolver_mode = resolver_mode_for_payload(payload)
        resolver_path = "visual_fallback"
        slab_context = slab_context_from_payload(payload) if resolver_mode == "psa_slab" else None
        slab_grader = str((slab_context or {}).get("grader") or "").strip().upper()
        slab_is_supported_psa = not slab_grader or slab_grader == "PSA"
        matching_payload = dict(payload)
        if resolver_mode == "psa_slab":
            matching_payload["_slabCertCardIDs"] = self._slab_cert_card_ids(payload)
        direct_candidate_indices = direct_lookup_candidate_indices(self.index, matching_payload)
        psa_candidate_indices = psa_label_candidate_indices(self.index, matching_payload) if resolver_mode == "psa_slab" else []
        ambiguity_flags = list(dict.fromkeys(payload.get("warnings", [])))
        direct_lookup_name_support = direct_lookup_has_name_support(self.index, matching_payload, direct_candidate_indices)
        direct_lookup_exact_candidate = direct_lookup_has_exact_candidate(self.index, matching_payload, direct_candidate_indices)
        direct_lookup_set_hints = trusted_set_hints_for_payload(matching_payload)

        def unsupported_response(reason: str, *, path: str | None = None) -> dict[str, Any]:
            response = {
                "scanID": payload["scanID"],
                "topCandidates": [],
                "confidence": "low",
                "ambiguityFlags": ambiguity_flags,
                "matcherSource": "remoteHybrid",
                "matcherVersion": MATCHER_VERSION,
                "resolverMode": resolver_mode,
                "resolverPath": path,
                "slabContext": slab_context,
                "reviewDisposition": "unsupported",
                "reviewReason": reason,
            }
            self._log_scan(payload, response, [])
            return response

        if resolver_mode == "psa_slab" and slab_context is None:
            ambiguity_flags.append("PSA label missing or unreadable")
            return unsupported_response(
                "Could not read the PSA label strongly enough to run a slab scan.",
                path="psa_label",
            )

        if resolver_mode == "psa_slab" and not psa_candidate_indices:
            if slab_is_supported_psa:
                ambiguity_flags.append("PSA label did not match a supported slab")
                reason = "Could not confirm this PSA slab from the label text."
            else:
                ambiguity_flags.append(f"{slab_grader} label did not match a supported slab")
                reason = f"Could not identify this {slab_grader} slab from the label text."
            return unsupported_response(
                reason,
                path="psa_label",
            )

        query_embedding = None
        # Trust direct lookup if we have strong collector number + set matches
        direct_lookup_ready = bool(direct_candidate_indices) and (
            (matching_payload.get("directLookupLikely") and direct_lookup_exact_candidate)
            or direct_lookup_name_support
            or (direct_lookup_exact_candidate and bool(direct_lookup_set_hints))
            or (direct_lookup_exact_candidate and len(direct_candidate_indices) == 1)
        )

        # Debug logging for troubleshooting
        print(f"[SCAN DEBUG] Collector: {payload.get('collectorNumber')}, Set hints: {payload.get('setHintTokens')}")
        print(f"[SCAN DEBUG] Direct candidates: {len(direct_candidate_indices)}, Ready: {direct_lookup_ready}")
        if direct_candidate_indices and len(direct_candidate_indices) <= 5:
            for idx in direct_candidate_indices[:5]:
                card = self.index.cards[idx]
                print(f"[SCAN DEBUG]   - {card.name} ({card.number}) from {card.set_name}")

        if resolver_mode == "psa_slab" and psa_candidate_indices:
            candidate_indices = psa_candidate_indices
            resolver_path = "psa_label"
        elif direct_lookup_ready:
            candidate_indices = direct_candidate_indices
            resolver_path = "direct_lookup"
        else:
            query_embedding = build_query_embedding(payload, self.repo_root)
            candidate_indices = approximate_candidate_indices(self.index, query_embedding)

        for card_index in candidate_indices:
            card = self.index.cards[card_index]
            contextual_pricing = None
            if resolver_mode != "psa_slab":
                contextual_pricing = contextual_pricing_summary_for_card(
                    self.connection,
                    card.id,
                    grader=slab_context.get("grader") if slab_context else None,
                    grade=slab_context.get("grade") if slab_context else None,
                )
            elif slab_context and slab_context.get("grade"):
                contextual_pricing = contextual_pricing_summary_for_card(
                    self.connection,
                    card.id,
                    grader=slab_context.get("grader") if slab_context else None,
                    grade=slab_context.get("grade") if slab_context else None,
                )
            if resolver_path == "direct_lookup":
                final_score, reasons, retrieval_score, rerank_score = direct_lookup_score(card, matching_payload)
            elif resolver_path == "psa_label":
                final_score, reasons, retrieval_score, rerank_score = psa_label_score(card, matching_payload)
            else:
                final_score, reasons, retrieval_score, rerank_score = rerank_card(card, matching_payload, query_embedding)
            allow_embedded_pricing = not (
                resolver_mode == "psa_slab" and contextual_pricing is None
            )
            scored_candidates.append(
                {
                    "card": card,
                    "candidate": card.as_candidate(
                        pricing_override=contextual_pricing,
                        allow_embedded_pricing=allow_embedded_pricing,
                    ),
                    "finalScore": final_score,
                    "retrievalScore": retrieval_score,
                    "rerankScore": rerank_score,
                    "reasons": reasons,
                }
            )

        scored_candidates.sort(key=lambda candidate: (-candidate["finalScore"], candidate["candidate"]["name"], candidate["candidate"]["number"]))
        top_candidates = scored_candidates[:5]

        encoded_candidates = [
            {
                "rank": index + 1,
                "candidate": candidate["candidate"],
                "imageScore": candidate["retrievalScore"],
                "collectorNumberScore": candidate["rerankScore"],
                "nameScore": 0.0,
                "finalScore": candidate["finalScore"],
            }
            for index, candidate in enumerate(top_candidates)
        ]
        top_has_exact_structured_match = (
            candidate_has_exact_structured_match(encoded_candidates[0], matching_payload, resolver_path)
            if encoded_candidates and resolver_path in {"direct_lookup", "psa_label"}
            else False
        )

        slab_number_hints = slab_payload_number_hints(matching_payload) if resolver_mode == "psa_slab" else set()
        if not payload.get("collectorNumber") and not (slab_context and slab_context.get("certNumber")) and not slab_number_hints:
            ambiguity_flags.append("Collector number missing")
        if len(top_candidates) > 1 and abs(top_candidates[0]["finalScore"] - top_candidates[1]["finalScore"]) < 0.08:
            ambiguity_flags.append("Top matches are close together")

        has_structured_number = bool(payload.get("collectorNumber")) or bool(slab_number_hints)

        confidence = confidence_for_candidates(
            encoded_candidates,
            has_structured_number,
            resolver_path=resolver_path,
            payload=matching_payload,
        )

        if (
            resolver_mode == "psa_slab"
            and slab_context is not None
            and slab_context.get("grade")
            and encoded_candidates
            and encoded_candidates[0]["candidate"].get("pricing") is None
            and confidence != "low"
        ):
            refreshed_detail = self.refresh_card_pricing(
                encoded_candidates[0]["candidate"]["id"],
                api_key=api_key,
                grader=slab_context.get("grader"),
                grade=slab_context.get("grade"),
            )
            refreshed_pricing = (
                (refreshed_detail or {}).get("card", {}).get("pricing")
                if isinstance(refreshed_detail, dict)
                else None
            )
            if refreshed_pricing is not None:
                encoded_candidates[0]["candidate"]["pricing"] = refreshed_pricing
                top_candidates[0]["candidate"]["pricing"] = refreshed_pricing

        # Debug logging
        if encoded_candidates:
            top = encoded_candidates[0]
            delta = top["finalScore"] - encoded_candidates[1]["finalScore"] if len(encoded_candidates) > 1 else top["finalScore"]
            print(f"[SCAN DEBUG] Resolver: {resolver_path}, Confidence: {confidence}")
            print(f"[SCAN DEBUG] Top match: {top['candidate']['name']} (score: {top['finalScore']:.3f}, delta: {delta:.3f})")
            self._log_pricing_provenance(
                "scan_top_match",
                top["candidate"]["id"],
                grader=slab_context.get("grader") if resolver_mode == "psa_slab" and slab_context else None,
                grade=slab_context.get("grade") if resolver_mode == "psa_slab" and slab_context else None,
            )

        canonical_collector_number = canonicalize_collector_number(str(payload.get("collectorNumber") or ""))
        recognized_text = recognized_text_for_payload(payload)
        trusted_set_hints = trusted_set_hints_for_payload(payload)
        has_artist_credit_signal = has_specific_artist_credit_signal(recognized_text)
        has_pokedex_signal = bool(recognized_pokedex_number_hints(recognized_text))
        has_printed_total_signal = collector_number_printed_total(canonical_collector_number) is not None
        raw_set_hint_tokens = {
            str(token).strip().lower()
            for token in (payload.get("setHintTokens") or [])
            if str(token).strip()
        }
        has_untrusted_set_hint_noise = bool(raw_set_hint_tokens) and not bool(trusted_set_hints)
        has_live_printed_total_signal = (
            has_printed_total_signal
            and bool(payload.get("directLookupLikely"))
            and not has_untrusted_set_hint_noise
        )
        slab_lookup_path = str(payload.get("slabRecommendedLookupPath") or "").strip().lower()
        has_live_slab_catalog_signal = (
            resolver_mode == "psa_slab"
            and bool(payload.get("slabCardNumberRaw"))
            and slab_lookup_path in {"psa_cert", "label_text_search"}
        )
        has_strong_live_catalog_signal = (
            bool(trusted_set_hints)
            or bool(payload.get("promoCodeHint"))
            or collector_number_has_alpha_hint(canonical_collector_number)
            or has_artist_credit_signal
            or has_pokedex_signal
        )
        should_try_live_catalog_miss = (
            allow_live_catalog_miss
            and (
                (
                    resolver_mode != "psa_slab"
                    and bool(payload.get("collectorNumber"))
                    and (
                        has_strong_live_catalog_signal
                        or (
                            confidence != "low"
                            and has_live_printed_total_signal
                        )
                    )
                )
                or (
                    resolver_mode == "psa_slab"
                    and has_live_slab_catalog_signal
                )
            )
            and not (resolver_mode == "psa_slab" and top_has_exact_structured_match)
            and not (resolver_path == "direct_lookup" and top_has_exact_structured_match)
            and (
                resolver_path != "direct_lookup"
                or confidence != "high"
                or not direct_lookup_exact_candidate
            )
        )
        if should_try_live_catalog_miss:
            imported = self.resolve_catalog_miss(payload, api_key=api_key)
            if imported is not None:
                retry_payload = dict(payload)
                retry_payload["_allowLiveCatalogMiss"] = False
                retry_response = self.match_scan(retry_payload)
                retry_response["catalogMissImportedCardID"] = imported["card"]["id"]
                retry_response["catalogMissImportQuery"] = imported["query"]
                return retry_response

        if (
            resolver_mode == "psa_slab"
            and slab_context is not None
            and slab_context.get("certNumber")
            and not matching_payload.get("_slabCertCardIDs")
            and not top_has_exact_structured_match
        ):
            ambiguity_flags.append("PSA cert was not found in the local slab cache")
            confidence = "low"

        review_disposition, review_reason = self._review_disposition_for_response(
            confidence=confidence,
            resolver_mode=resolver_mode,
            resolver_path=resolver_path,
            payload=payload,
            top_candidate=encoded_candidates[0] if encoded_candidates else None,
        )

        response = {
            "scanID": payload["scanID"],
            "topCandidates": encoded_candidates,
            "confidence": confidence,
            "ambiguityFlags": ambiguity_flags,
            "matcherSource": "remoteHybrid",
            "matcherVersion": MATCHER_VERSION,
            "resolverMode": resolver_mode,
            "resolverPath": resolver_path,
            "slabContext": slab_context,
            "reviewDisposition": review_disposition,
            "reviewReason": review_reason,
        }

        self._emit_structured_log(self._scan_log_payload(payload, response, top_candidates))
        self._log_scan(payload, response, top_candidates)
        return response

    def log_feedback(self, payload: dict[str, Any]) -> None:
        self.connection.execute(
            """
            INSERT OR IGNORE INTO scan_events (
                scan_id,
                created_at,
                request_json,
                response_json,
                matcher_source,
                matcher_version
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                payload["scanID"],
                payload.get("submittedAt", utc_now()),
                "{}",
                "{}",
                "remoteHybrid",
                MATCHER_VERSION,
            ),
        )

        self.connection.execute(
            """
            INSERT INTO scan_feedback (
                scan_id,
                selected_card_id,
                was_top_prediction,
                correction_type,
                submitted_at,
                feedback_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                payload["scanID"],
                payload.get("selectedCardID"),
                1 if payload.get("wasTopPrediction") else 0,
                payload["correctionType"],
                payload["submittedAt"],
                json.dumps(payload),
            ),
        )

        self.connection.execute(
            """
            UPDATE scan_events
            SET selected_card_id = ?, correction_type = ?, completed_at = ?
            WHERE scan_id = ?
            """,
            (
                payload.get("selectedCardID"),
                payload["correctionType"],
                payload["submittedAt"],
                payload["scanID"],
            ),
        )
        self.connection.commit()

    def _review_disposition_for_response(
        self,
        *,
        confidence: str,
        resolver_mode: str,
        resolver_path: str,
        payload: dict[str, Any],
        top_candidate: dict[str, Any] | None = None,
    ) -> tuple[str, str | None]:
        if resolver_mode == "psa_slab":
            slab_grader = str(payload.get("slabGrader") or "").strip().upper()
            if slab_grader and slab_grader != "PSA":
                top_pricing = ((top_candidate or {}).get("candidate", {}) or {}).get("pricing") or {}
                if top_pricing and str(top_pricing.get("grader") or "").strip().upper() == slab_grader:
                    return "ready", None
                return "unsupported", f"{slab_grader} slab pricing is unavailable from Scrydex for this grade. The underlying card was identified from the label."
            if confidence != "low":
                return "ready", None
            return "needs_review", "Review PSA label. Card or grade could not be confirmed strongly enough."

        if confidence != "low":
            return "ready", None

        has_structured_raw_hints = bool(payload.get("collectorNumber")) and bool(payload.get("setHintTokens"))
        if resolver_path == "visual_fallback" and (resolver_mode == "unknown_fallback" or has_structured_raw_hints):
            return "unsupported", "Set/number clues do not line up with a supported Pokemon card. Could be custom, fake, or missing from the catalog."

        return "needs_review", "Scan needs review before using the price."

    def _log_scan(self, request_payload: dict[str, Any], response_payload: dict[str, Any], top_candidates: list[dict[str, Any]]) -> None:
        scan_id = request_payload["scanID"]
        now = utc_now()

        self.connection.execute(
            """
            INSERT OR REPLACE INTO scan_events (
                scan_id,
                created_at,
                request_json,
                response_json,
                matcher_source,
                matcher_version
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                scan_id,
                now,
                json.dumps(request_payload),
                json.dumps(response_payload),
                response_payload["matcherSource"],
                response_payload["matcherVersion"],
            ),
        )

        self.connection.execute("DELETE FROM scan_candidates WHERE scan_id = ?", (scan_id,))

        for rank, candidate in enumerate(top_candidates, start=1):
            self.connection.execute(
                """
                INSERT INTO scan_candidates (
                    scan_id,
                    rank,
                    card_id,
                    retrieval_score,
                    rerank_score,
                    final_score,
                    reasons_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    scan_id,
                    rank,
                    candidate["candidate"]["id"],
                    candidate["retrievalScore"],
                    candidate["rerankScore"],
                    candidate["finalScore"],
                    json.dumps(candidate["reasons"]),
                ),
            )

        self.connection.commit()


class SpotlightRequestHandler(BaseHTTPRequestHandler):
    service: SpotlightScanService

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/v1/health":
            self._write_json(HTTPStatus.OK, self.service.health())
            return

        if parsed.path == "/api/v1/ops/provider-status":
            self._write_json(HTTPStatus.OK, self.service.provider_status())
            return

        if parsed.path == "/api/v1/ops/catalog-sync-status":
            self._write_json(HTTPStatus.OK, self.service.catalog_sync_status())
            return

        if parsed.path == "/api/v1/ops/pricing-refresh-failures":
            query = parse_qs(parsed.query)
            limit = int(query.get("limit", ["20"])[0])
            self._write_json(HTTPStatus.OK, self.service.recent_pricing_refresh_failures(limit=limit))
            return

        if parsed.path == "/api/v1/ops/unmatched-scans":
            query = parse_qs(parsed.query)
            limit = int(query.get("limit", ["25"])[0])
            self._write_json(HTTPStatus.OK, self.service.unmatched_scans(limit=limit))
            return

        if parsed.path == "/api/v1/ops/cache-status":
            self._write_json(HTTPStatus.OK, self.service.cache_status())
            return

        if parsed.path == "/api/v1/slab-sync/status":
            self._write_json(HTTPStatus.OK, self.service.slab_sync_status())
            return

        if parsed.path == "/api/v1/cards/search":
            query = parse_qs(parsed.query).get("q", [""])[0]
            self._write_json(HTTPStatus.OK, self.service.search(query))
            return

        if parsed.path.startswith("/api/v1/cards/"):
            if parsed.path.endswith("/slab-sales"):
                card_id = parsed.path.removeprefix("/api/v1/cards/").removesuffix("/slab-sales").rstrip("/")
                if not card_id:
                    self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                    return

                query = parse_qs(parsed.query)
                limit = int(query.get("limit", ["20"])[0])
                payload = self.service.slab_sales(
                    card_id,
                    grader=query.get("grader", [None])[0],
                    grade=query.get("grade", [None])[0],
                    limit=limit,
                )
                self._write_json(HTTPStatus.OK, payload)
                return

            if parsed.path.endswith("/slab-price-snapshot"):
                card_id = parsed.path.removeprefix("/api/v1/cards/").removesuffix("/slab-price-snapshot").rstrip("/")
                if not card_id:
                    self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                    return

                query = parse_qs(parsed.query)
                grader = query.get("grader", [None])[0]
                grade = query.get("grade", [None])[0]
                if not grader or not grade:
                    self._write_json(HTTPStatus.BAD_REQUEST, {"error": "grader and grade are required"})
                    return

                payload = self.service.slab_price_snapshot(card_id, grader=grader, grade=grade)
                if payload is None:
                    self._write_json(HTTPStatus.NOT_FOUND, {"error": "Slab price snapshot not found"})
                    return

                self._write_json(HTTPStatus.OK, payload)
                return

            card_id = parsed.path.removeprefix("/api/v1/cards/")
            if not card_id:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return

            query = parse_qs(parsed.query)
            payload = self.service.card_detail(
                card_id,
                grader=query.get("grader", [None])[0],
                grade=query.get("grade", [None])[0],
            )

            # Auto-import card from Pokemon TCG API if not in database
            if payload is None:
                api_key = os.environ.get("POKEMONTCG_API_KEY")
                try:
                    imported = self.service.import_catalog_card(
                        card_id,
                        api_key=api_key,
                        trigger_source="auto_import_on_request",
                    )
                    if imported is not None:
                        # Retry card_detail after import
                        payload = self.service.card_detail(
                            card_id,
                            grader=query.get("grader", [None])[0],
                            grade=query.get("grade", [None])[0],
                        )
                except Exception:
                    pass  # Fall through to 404

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

            try:
                query = parse_qs(parsed.query)
                force_refresh = query.get("forceRefresh", ["0"])[0].lower() in {"1", "true", "yes"}
                payload = self.service.refresh_card_pricing(
                    card_id,
                    api_key=os.environ.get("POKEMONTCG_API_KEY"),
                    grader=query.get("grader", [None])[0],
                    grade=query.get("grade", [None])[0],
                    force_refresh=force_refresh,
                )
            except Exception as error:
                self.service.record_pricing_refresh_failure(
                    card_id=card_id,
                    grader=query.get("grader", [None])[0] if "query" in locals() else None,
                    grade=query.get("grade", [None])[0] if "query" in locals() else None,
                    source="provider",
                    error_text=str(error),
                )
                self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"Pricing refresh failed: {error}"})
                return

            if payload is None:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Card not found"})
                return

            self._write_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/v1/slab-sync/run-once":
            try:
                self._write_json(HTTPStatus.OK, {"summary": self.service.run_slab_source_sync_once()})
            except Exception as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": f"Slab source sync failed: {error}"})
            return

        payload = self._read_json_body()

        if payload is None:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON body"})
            return

        if parsed.path == "/api/v1/slab-sales/import":
            sales = payload.get("sales")
            if not isinstance(sales, list):
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "sales must be a list"})
                return
            try:
                self._write_json(HTTPStatus.OK, self.service.import_slab_sales(sales))
            except Exception as error:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": f"Slab sale import failed: {error}"})
            return

        if parsed.path == "/api/v1/catalog/import-card":
            card_id = str(payload.get("cardID") or "").strip()
            if not card_id:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "cardID is required"})
                return
            try:
                imported = self.service.import_catalog_card(
                    card_id,
                    api_key=os.environ.get("POKEMONTCG_API_KEY"),
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

        if parsed.path == "/api/v1/catalog/resolve-miss":
            resolved = self.service.resolve_catalog_miss(payload, api_key=os.environ.get("POKEMONTCG_API_KEY"))
            if resolved is None:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "No live catalog match found"})
                return
            self._write_json(HTTPStatus.OK, resolved)
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
    cards_file: str | None = None,
    database_path_override: str | None = None,
    skip_seed: bool = False,
) -> tuple[Path, Path | None]:
    repo_root = root.parent
    data_directory = root / "data"
    data_directory.mkdir(parents=True, exist_ok=True)

    database_path = Path(database_path_override) if database_path_override else data_directory / "spotlight_scanner.sqlite"
    schema_path = root / "schema.sql"
    explicit_cards_path = cards_file or os.environ.get("SPOTLIGHT_CATALOG_PATH")
    cards_path: Path | None = None
    if explicit_cards_path or not skip_seed:
        cards_path = resolve_catalog_json_path(
            root,
            explicit_path=explicit_cards_path,
        )

    connection = connect(database_path)
    apply_schema(connection, schema_path)
    if not skip_seed and cards_path is not None:
        seed_catalog(connection, load_cards_json(cards_path), repo_root)
    connection.close()
    return database_path, cards_path


def main() -> None:
    root = Path(__file__).resolve().parent
    repo_root = root.parent
    config = ServerConfig(
        host=cli_value("--host") or os.environ.get("SPOTLIGHT_HOST", "127.0.0.1"),
        port=cli_int_value("--port", int(os.environ.get("SPOTLIGHT_PORT", "8787"))),
    )
    database_path, cards_path = bootstrap_backend(
        root,
        cards_file=cli_value("--cards-file"),
        database_path_override=cli_value("--database-path") or os.environ.get("SPOTLIGHT_DATABASE_PATH"),
        skip_seed=("--skip-seed" in sys.argv) or (os.environ.get("SPOTLIGHT_SKIP_SEED") == "1"),
    )

    SpotlightRequestHandler.service = SpotlightScanService(database_path, repo_root, cards_path=cards_path)
    server = HTTPServer((config.host, config.port), SpotlightRequestHandler)

    if os.environ.get("SPOTLIGHT_SLAB_SOURCE_MANIFEST") and os.environ.get("SPOTLIGHT_SLAB_SYNC_INTERVAL_SECONDS"):
        interval_seconds = int(os.environ["SPOTLIGHT_SLAB_SYNC_INTERVAL_SECONDS"])
        manifest_path = Path(os.environ["SPOTLIGHT_SLAB_SOURCE_MANIFEST"])
        if not manifest_path.is_absolute():
            manifest_path = repo_root / manifest_path
        worker = threading.Thread(
            target=run_slab_source_sync_loop,
            kwargs={
                "database_path": database_path,
                "repo_root": repo_root,
                "manifest_path": manifest_path,
                "interval_seconds": interval_seconds,
                "state_path": Path(
                    os.environ.get("SPOTLIGHT_SLAB_SYNC_STATE_PATH")
                    or (root / "data" / "slab_source_sync_state.json")
                ),
            },
            daemon=True,
        )
        worker.start()

    # Legacy in-memory provider cache is opt-in only.
    if (
        CACHE_AVAILABLE
        and start_background_cleanup
        and os.environ.get("SPOTLIGHT_ENABLE_LEGACY_PROVIDER_CACHE") == "1"
    ):
        start_background_cleanup(interval_hours=1)
        print("✅ Started legacy background cache cleanup (runs every 1 hour)", flush=True)

    print(f"Spotlight scan service listening on http://{config.host}:{config.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Spotlight scan service", flush=True)
        server.server_close()


if __name__ == "__main__":
    if "--seed-only" in sys.argv:
        root = Path(__file__).resolve().parent
        database_path, _ = bootstrap_backend(
            root,
            cards_file=cli_value("--cards-file"),
            database_path_override=cli_value("--database-path") or os.environ.get("SPOTLIGHT_DATABASE_PATH"),
        )
        print(f"Catalog initialized at {database_path}")
    else:
        main()
