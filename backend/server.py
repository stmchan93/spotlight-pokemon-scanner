from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import threading
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
    psa_label_number_hints,
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
    search_cards,
    seed_catalog,
    slab_price_snapshot_for_card,
    slab_sales_for_card,
    slab_context_from_payload,
    structured_set_hints_for_payload,
    trusted_set_hints_for_payload,
    tokenize,
    upsert_catalog_card,
    upsert_card_in_catalog_snapshot,
    utc_now,
)
from import_pokemontcg_catalog import fetch_card_by_id, map_card, search_cards as search_remote_cards
from pricing_provider import PricingProviderRegistry, PsaPricingResult, RawPricingResult
from pokemontcg_pricing_adapter import PokemonTcgApiProvider
from pricecharting_adapter import PriceChartingProvider
from scrydex_adapter import ScrydexProvider
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

    def _pricing_provenance_for_card(self, card_id: str) -> dict[str, Any] | None:
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

    def _log_pricing_provenance(self, context: str, card_id: str) -> None:
        provenance = self._pricing_provenance_for_card(card_id)
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
            f"price={provenance.get('primaryPrice')} "
            f"currency={provenance.get('currencyCode') or 'USD'} "
            f"refreshedAt={provenance.get('refreshedAt') or 'n/a'} "
            f"url={provenance.get('sourceURL') or 'n/a'}"
        )

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
        started_at = utc_now()
        cards_before = len(self.index)
        file_summary = {"added": 0, "updated": 0}

        upsert_catalog_card(
            self.connection,
            mapped_card,
            self.repo_root,
            started_at,
            refresh_embeddings=refresh_embeddings,
        )

        if self.cards_path is not None:
            file_summary = upsert_card_in_catalog_snapshot(self.cards_path, mapped_card)

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
            cards_added=file_summary["added"],
            cards_updated=file_summary["updated"],
            summary={
                "cardID": mapped_card["id"],
                "setName": mapped_card["set_name"],
                "number": mapped_card["number"],
            },
        )
        return mapped_card

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

    def _catalog_miss_queries(self, payload: dict[str, Any]) -> list[str]:
        collector_number = str(payload.get("collectorNumber") or "").strip()
        if not collector_number:
            return []

        raw_set_hints = trusted_set_hints_for_payload(payload)
        api_number_values = collector_number_api_query_values(collector_number)
        printed_total = collector_number_printed_total(collector_number)
        if not api_number_values:
            return []

        queries: list[str] = []
        seen: set[str] = set()

        for api_number in api_number_values:
            if printed_total is not None:
                query = f"set.printedTotal:{printed_total} number:\"{api_number.upper()}\""
                if query not in seen:
                    seen.add(query)
                    queries.append(query)

            for set_hint in sorted(raw_set_hints):
                for query in (
                    f"set.ptcgoCode:{set_hint.upper()} number:\"{api_number.upper()}\"",
                    f"set.id:{set_hint.lower()} number:\"{api_number.lower()}\"",
                ):
                    if query in seen:
                        continue
                    seen.add(query)
                    queries.append(query)

        return queries

    def resolve_catalog_miss(self, payload: dict[str, Any], api_key: str | None = None) -> dict[str, Any] | None:
        if resolver_mode_for_payload(payload) == "psa_slab":
            return None

        recognized_text = recognized_text_for_payload(payload)
        query_tokens = {
            token
            for token in tokenize(recognized_text)
            if len(token) > 2 and token not in {"pokemon", "card", "rare", "illustration"}
        }
        raw_number_values = {value.lower() for value in collector_number_api_query_values(str(payload.get("collectorNumber") or ""))}
        printed_total = collector_number_printed_total(str(payload.get("collectorNumber") or ""))
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

        if grader and grade and grader.upper() == "PSA":
            existing_pricing = slab_price_snapshot_for_card(self.connection, card_id, grader, grade)
            if (
                existing_pricing is not None
                and not force_refresh
                and existing_pricing.get("isFresh") is True
            ):
                print(
                    f"[PRICING DEBUG] refresh_psa_cached: card={card_id} "
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
        if grader and grade and grader.upper() == "PSA":
            scrydex_provider = self.pricing_registry.get_provider("scrydex")
            if scrydex_provider is None or not scrydex_provider.is_ready():
                provider_refresh_result = PsaPricingResult(
                    success=False,
                    provider_id="scrydex",
                    card_id=card_id,
                    grade=grade,
                    error="Scrydex PSA pricing is not configured",
                )
            else:
                provider_refresh_result = scrydex_provider.refresh_psa_pricing(
                    self.connection, card_id, grade
                )
            if provider_refresh_result.success:
                self._log_pricing_provenance("refresh_psa", card_id)
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
        scored_candidates: list[dict[str, Any]] = []
        resolver_mode = resolver_mode_for_payload(payload)
        resolver_path = "visual_fallback"
        slab_context = slab_context_from_payload(payload) if resolver_mode == "psa_slab" else None
        direct_candidate_indices = direct_lookup_candidate_indices(self.index, payload)
        psa_candidate_indices = psa_label_candidate_indices(self.index, payload) if resolver_mode == "psa_slab" else []
        ambiguity_flags = list(dict.fromkeys(payload.get("warnings", [])))
        direct_lookup_name_support = direct_lookup_has_name_support(self.index, payload, direct_candidate_indices)
        direct_lookup_exact_candidate = direct_lookup_has_exact_candidate(self.index, payload, direct_candidate_indices)
        direct_lookup_set_hints = trusted_set_hints_for_payload(payload)

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
            ambiguity_flags.append("PSA label did not match a supported slab")
            return unsupported_response(
                "Could not confirm this PSA slab from the label text.",
                path="psa_label",
            )

        query_embedding = None
        # Trust direct lookup if we have strong collector number + set matches
        direct_lookup_ready = bool(direct_candidate_indices) and (
            (payload.get("directLookupLikely") and direct_lookup_exact_candidate)
            or direct_lookup_name_support
            or (direct_lookup_exact_candidate and bool(direct_lookup_set_hints))
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
            contextual_pricing = contextual_pricing_summary_for_card(
                self.connection,
                card.id,
                grader=slab_context.get("grader") if slab_context else None,
                grade=slab_context.get("grade") if slab_context else None,
            )
            if resolver_path == "direct_lookup":
                final_score, reasons, retrieval_score, rerank_score = direct_lookup_score(card, payload)
            elif resolver_path == "psa_label":
                final_score, reasons, retrieval_score, rerank_score = psa_label_score(card, payload)
            else:
                final_score, reasons, retrieval_score, rerank_score = rerank_card(card, payload, query_embedding)
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
            candidate_has_exact_structured_match(encoded_candidates[0], payload, resolver_path)
            if encoded_candidates and resolver_path in {"direct_lookup", "psa_label"}
            else False
        )

        if not payload.get("collectorNumber"):
            ambiguity_flags.append("Collector number missing")
        if len(top_candidates) > 1 and abs(top_candidates[0]["finalScore"] - top_candidates[1]["finalScore"]) < 0.08:
            ambiguity_flags.append("Top matches are close together")

        has_structured_number = bool(payload.get("collectorNumber")) or bool(
            psa_label_number_hints(payload.get("topLabelRecognizedText") or "")
        )

        confidence = confidence_for_candidates(
            encoded_candidates,
            has_structured_number,
            resolver_path=resolver_path,
            payload=payload,
        )

        # Debug logging
        if encoded_candidates:
            top = encoded_candidates[0]
            delta = top["finalScore"] - encoded_candidates[1]["finalScore"] if len(encoded_candidates) > 1 else top["finalScore"]
            print(f"[SCAN DEBUG] Resolver: {resolver_path}, Confidence: {confidence}")
            print(f"[SCAN DEBUG] Top match: {top['candidate']['name']} (score: {top['finalScore']:.3f}, delta: {delta:.3f})")
            self._log_pricing_provenance("scan_top_match", top["candidate"]["id"])

        review_disposition, review_reason = self._review_disposition_for_response(
            confidence=confidence,
            resolver_mode=resolver_mode,
            resolver_path=resolver_path,
            payload=payload,
        )

        canonical_collector_number = canonicalize_collector_number(str(payload.get("collectorNumber") or ""))
        recognized_text = recognized_text_for_payload(payload)
        trusted_set_hints = trusted_set_hints_for_payload(payload)
        has_artist_credit_signal = has_specific_artist_credit_signal(recognized_text)
        has_pokedex_signal = bool(recognized_pokedex_number_hints(recognized_text))
        should_try_live_catalog_miss = (
            allow_live_catalog_miss
            and resolver_mode != "psa_slab"
            and bool(payload.get("collectorNumber"))
            and (
                bool(trusted_set_hints)
                or bool(payload.get("promoCodeHint"))
                or collector_number_has_alpha_hint(canonical_collector_number)
                or has_artist_credit_signal
                or has_pokedex_signal
            )
            and not (resolver_path == "direct_lookup" and top_has_exact_structured_match)
            and (
                resolver_path != "direct_lookup"
                or confidence != "high"
                or not direct_lookup_exact_candidate
            )
        )
        if should_try_live_catalog_miss:
            imported = self.resolve_catalog_miss(payload, api_key=os.environ.get("POKEMONTCG_API_KEY"))
            if imported is not None:
                retry_payload = dict(payload)
                retry_payload["_allowLiveCatalogMiss"] = False
                retry_response = self.match_scan(retry_payload)
                retry_response["catalogMissImportedCardID"] = imported["card"]["id"]
                retry_response["catalogMissImportQuery"] = imported["query"]
                return retry_response

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
    ) -> tuple[str, str | None]:
        if confidence != "low":
            return "ready", None

        if resolver_mode == "psa_slab":
            return "needs_review", "Review PSA label. Card or grade could not be confirmed strongly enough."

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
            self._write_json(HTTPStatus.OK, self.service.match_scan(payload))
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
) -> tuple[Path, Path]:
    repo_root = root.parent
    data_directory = root / "data"
    data_directory.mkdir(parents=True, exist_ok=True)

    database_path = Path(database_path_override) if database_path_override else data_directory / "spotlight_scanner.sqlite"
    schema_path = root / "schema.sql"
    cards_path = resolve_catalog_json_path(
        root,
        explicit_path=cards_file or os.environ.get("SPOTLIGHT_CATALOG_PATH")
    )

    connection = connect(database_path)
    apply_schema(connection, schema_path)
    if not skip_seed:
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
