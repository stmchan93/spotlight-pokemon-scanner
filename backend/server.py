from __future__ import annotations

import json
import os
import sys
import traceback
from dataclasses import dataclass
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

from catalog_tools import (
    MATCHER_VERSION,
    RawDecisionResult,
    RawEvidence,
    RawRetrievalPlan,
    RawSignalScores,
    apply_schema,
    build_raw_evidence,
    build_raw_retrieval_plan,
    card_by_id,
    connect,
    contextual_pricing_summary_for_card,
    finalize_raw_decision,
    load_index,
    merge_raw_candidate_pools,
    rank_raw_candidates,
    raw_debug_payload,
    raw_pricing_summary_for_card,
    resolver_mode_for_payload,
    score_raw_signals,
    search_cards,
    search_cards_local,
    search_cards_local_collector_only,
    search_cards_local_collector_set,
    search_cards_local_title_only,
    search_cards_local_title_set,
    upsert_catalog_card,
    upsert_scan_event,
    utc_now,
)
from import_pokemontcg_catalog import (
    best_remote_raw_candidates,
    build_raw_provider_queries,
    fetch_card_by_id,
    map_card,
    search_remote_raw_candidates,
)
from pokemontcg_pricing_adapter import PokemonTcgApiProvider
from pricecharting_adapter import PriceChartingProvider
from pricing_provider import PricingProviderRegistry
from scrydex_adapter import ScrydexProvider


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8787


class SpotlightScanService:
    def __init__(self, database_path: Path, repo_root: Path) -> None:
        self.database_path = database_path
        self.repo_root = repo_root
        self.connection = connect(database_path)
        self.index = load_index(self.connection)

        self.pricing_registry = PricingProviderRegistry()
        self.pricing_registry.register(PokemonTcgApiProvider())
        self.pricing_registry.register(ScrydexProvider())
        self.pricing_registry.register(PriceChartingProvider())

    def refresh_index(self) -> None:
        self.index = load_index(self.connection)

    @staticmethod
    def _primary_price_value(pricing: dict[str, Any] | None) -> float | None:
        if not pricing:
            return None
        for key in ("market", "mid", "low", "trend", "high", "directLow"):
            value = pricing.get(key)
            if isinstance(value, (int, float)):
                return float(value)
        return None

    def _pricing_provenance_for_card(self, card_id: str) -> dict[str, Any] | None:
        pricing = contextual_pricing_summary_for_card(self.connection, card_id)
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
            "directLookupLikely": request_payload.get("directLookupLikely"),
            "resolverModeHint": request_payload.get("resolverModeHint"),
            "collectorNumber": request_payload.get("collectorNumber"),
            "setHintTokens": request_payload.get("setHintTokens") or [],
            "promoCodeHint": request_payload.get("promoCodeHint"),
            "errorType": type(error).__name__,
            "errorText": str(error),
            "matcherVersion": MATCHER_VERSION,
        }

    def health(self) -> dict[str, Any]:
        active_raw_provider = self.pricing_registry.get_active_provider(for_raw=True)
        return {
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
            "unsupportedScanScopes": [
                "psa_slabs",
                "graded_pricing",
                "binder_pages",
                "multi_card_photo",
                "bulk_auto_detect_without_capture",
            ],
        }

    def provider_status(self) -> dict[str, Any]:
        provider_details: list[dict[str, Any]] = []
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
                }
            )
        active_raw_provider = self.pricing_registry.get_active_provider(for_raw=True)
        return {
            "providers": provider_details,
            "activeRawProvider": active_raw_provider.get_metadata().provider_id if active_raw_provider else None,
            "runtimeMode": "raw_only",
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
        raw_card = fetch_card_by_id(card_id, api_key)
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

    @staticmethod
    def _with_retrieval_route(candidates: list[dict[str, Any]], route: str) -> list[dict[str, Any]]:
        annotated: list[dict[str, Any]] = []
        for candidate in candidates:
            updated = dict(candidate)
            updated["_retrievalRoutes"] = list(dict.fromkeys([route, *(candidate.get("_retrievalRoutes") or [])]))
            annotated.append(updated)
        return annotated

    def _best_effort_local_raw_candidates(self, limit: int = 5) -> list[dict[str, Any]]:
        candidates: list[dict[str, Any]] = []
        for card in self.index.cards[:limit]:
            candidates.append(
                {
                    "id": card.id,
                    "name": card.name,
                    "setName": card.set_name,
                    "number": card.number,
                    "rarity": card.rarity,
                    "variant": card.variant,
                    "language": card.language,
                    "sourceProvider": None,
                    "sourceRecordID": card.id,
                    "setID": card.set_id,
                    "setSeries": None,
                    "setPtcgoCode": card.set_ptcgo_code,
                    "imageURL": None,
                    "imageSmallURL": None,
                    "sourcePayload": {},
                    "_cachePresence": True,
                    "_retrievalScoreHint": 0.0,
                    "_retrievalRoutes": ["no_signal_best_guess"],
                }
            )
        return candidates

    def _retrieve_local_raw_candidates(
        self,
        evidence: RawEvidence,
        signals: RawSignalScores,
        plan: RawRetrievalPlan,
    ) -> list[dict[str, Any]]:
        candidate_groups: list[list[dict[str, Any]]] = []
        routes = set(plan.routes)

        if "collector_set_exact" in routes:
            candidate_groups.append(search_cards_local_collector_set(self.connection, evidence, limit=12))
        if "title_set_primary" in routes:
            candidate_groups.append(search_cards_local_title_set(self.connection, evidence, limit=12))
        if "title_collector" in routes:
            candidate_groups.append(self._with_retrieval_route(search_cards_local_title_only(self.connection, evidence, limit=12), "title_collector"))
            candidate_groups.append(self._with_retrieval_route(search_cards_local_collector_only(self.connection, evidence, limit=12), "title_collector"))
        else:
            if "title_only" in routes:
                candidate_groups.append(search_cards_local_title_only(self.connection, evidence, limit=12))
            if "collector_only" in routes:
                candidate_groups.append(search_cards_local_collector_only(self.connection, evidence, limit=12))

        if "broad_text_fallback" in routes and evidence.recognized_text:
            fallback_group = self._with_retrieval_route(
                search_cards_local(self.connection, evidence.recognized_text, limit=12),
                "broad_text_fallback",
            )
            for candidate in fallback_group:
                candidate["_cachePresence"] = True
            candidate_groups.append(fallback_group)

        return merge_raw_candidate_pools(candidate_groups)

    def _retrieve_remote_raw_candidates(
        self,
        evidence: RawEvidence,
        signals: RawSignalScores,
        plan: RawRetrievalPlan,
        api_key: str | None,
    ) -> list[dict[str, Any]]:
        if not plan.should_query_remote:
            return []
        queries = build_raw_provider_queries(evidence, signals)
        if not queries:
            return []
        remote_results = search_remote_raw_candidates(queries, api_key, page_size=10)
        return best_remote_raw_candidates(remote_results, evidence, signals, limit=12)

    def _ensure_raw_card_cached(self, card: dict[str, Any], trigger_source: str) -> dict[str, Any]:
        card_id = str(card.get("id") or "").strip()
        if not card_id:
            return card
        cached = card_by_id(self.connection, card_id)
        if cached is not None:
            return cached

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
            "source": str(card.get("sourceProvider") or "pokemontcg_api"),
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
            "source_payload": card.get("sourcePayload") or {},
        }
        self._persist_mapped_catalog_card(
            mapped_card=mapped_card,
            sync_mode="raw_candidate_cache",
            trigger_source=trigger_source,
            query_text=card_id,
            refresh_embeddings=False,
        )
        return card_by_id(self.connection, card_id) or card

    def _raw_candidate_payload(
        self,
        card: dict[str, Any],
        *,
        ensure_cached: bool = False,
        api_key: str | None = None,
        refresh_pricing_if_missing: bool = False,
    ) -> dict[str, Any]:
        resolved_card = self._ensure_raw_card_cached(card, "scan_match_raw") if ensure_cached else card
        card_id = str(resolved_card.get("id") or "").strip()
        pricing = contextual_pricing_summary_for_card(self.connection, card_id) if card_id else None

        if card_id and refresh_pricing_if_missing and pricing is None:
            refreshed_detail = self.refresh_card_pricing(card_id, api_key=api_key)
            pricing = ((refreshed_detail or {}).get("card", {}) or {}).get("pricing") if isinstance(refreshed_detail, dict) else None
            if pricing is None:
                pricing = contextual_pricing_summary_for_card(self.connection, card_id)

        candidate = {
            "id": card_id or str(card.get("id") or ""),
            "name": str(resolved_card.get("name") or card.get("name") or ""),
            "setName": str(resolved_card.get("setName") or card.get("setName") or ""),
            "number": str(resolved_card.get("number") or card.get("number") or ""),
            "rarity": str(resolved_card.get("rarity") or card.get("rarity") or "Unknown"),
            "variant": str(resolved_card.get("variant") or card.get("variant") or "Raw"),
            "language": str(resolved_card.get("language") or card.get("language") or "English"),
        }
        if pricing is not None:
            candidate["pricing"] = pricing
        return candidate

    def _build_raw_match_response(
        self,
        payload: dict[str, Any],
        decision: RawDecisionResult,
        *,
        api_key: str | None = None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        top_matches = list(decision.top_candidates)
        if not top_matches:
            return ({
                "scanID": payload["scanID"],
                "topCandidates": [],
                "confidence": decision.confidence,
                "ambiguityFlags": list(decision.ambiguity_flags),
                "matcherSource": "remoteHybrid",
                "matcherVersion": MATCHER_VERSION,
                "resolverMode": "raw_card",
                "resolverPath": decision.resolver_path,
                "slabContext": None,
                "reviewDisposition": decision.review_disposition,
                "reviewReason": decision.review_reason,
                "rawDecisionDebug": decision.debug_payload,
            }, [])

        scored_candidates: list[dict[str, Any]] = []
        encoded_candidates: list[dict[str, Any]] = []
        for index, match in enumerate(top_matches):
            candidate_payload = self._raw_candidate_payload(
                match.card,
                ensure_cached=index == 0,
                api_key=api_key,
                refresh_pricing_if_missing=index == 0 and decision.confidence != "low",
            )
            scored_entry = {
                "card": match.card,
                "candidate": candidate_payload,
                "finalScore": round(match.final_total / 100.0, 4),
                "retrievalScore": round(match.retrieval_score / 100.0, 4),
                "rerankScore": round(match.resolution_score / 100.0, 4),
                "reasons": list(match.reasons),
            }
            scored_candidates.append(scored_entry)
            encoded_candidates.append(
                {
                    "rank": index + 1,
                    "candidate": candidate_payload,
                    "imageScore": scored_entry["retrievalScore"],
                    "collectorNumberScore": scored_entry["rerankScore"],
                    "nameScore": round(match.breakdown.title_overlap_score / 35.0, 4) if match.breakdown.title_overlap_score else 0.0,
                    "finalScore": scored_entry["finalScore"],
                }
            )

        response = {
            "scanID": payload["scanID"],
            "topCandidates": encoded_candidates,
            "confidence": decision.confidence,
            "ambiguityFlags": list(decision.ambiguity_flags),
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
            len(local_candidates) < 3 or top_local_score < 70.0 or local_delta < 8.0
        )
        remote_candidates = (
            self._retrieve_remote_raw_candidates(evidence, signals, plan, api_key)
            if should_expand_remote
            else []
        )

        merged_candidates = merge_raw_candidate_pools([local_candidates, remote_candidates])
        if not merged_candidates:
            merged_candidates = self._best_effort_local_raw_candidates()
        matches = rank_raw_candidates(merged_candidates, evidence, signals)
        decision = finalize_raw_decision(matches, evidence, signals)
        debug_payload = raw_debug_payload(evidence, signals, plan, matches, decision)
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

    def refresh_card_pricing(
        self,
        card_id: str,
        api_key: str | None = None,
        grader: str | None = None,
        grade: str | None = None,
        force_refresh: bool = False,
    ) -> dict[str, Any] | None:
        if grader or grade:
            return None

        if card_by_id(self.connection, card_id) is None and api_key:
            try:
                self.import_catalog_card(card_id, api_key=api_key, trigger_source="refresh_pricing_auto_import")
            except Exception:
                return None

        existing_pricing = raw_pricing_summary_for_card(self.connection, card_id)
        if existing_pricing is not None and not force_refresh and existing_pricing.get("isFresh") is True:
            self._log_pricing_provenance("refresh_raw_cached", card_id)
            return self.card_detail(card_id)

        raw_provider = self.pricing_registry.get_provider("pokemontcg_api")
        if raw_provider is None or not raw_provider.is_ready():
            return self.card_detail(card_id)

        provider_refresh_result = raw_provider.refresh_raw_pricing(self.connection, card_id)
        if provider_refresh_result.success:
            self._log_pricing_provenance("refresh_raw", card_id)
        return self.card_detail(card_id)

    def card_detail(self, card_id: str, *, grader: str | None = None, grade: str | None = None) -> dict[str, Any] | None:
        card = card_by_id(self.connection, card_id)
        if card is None:
            return None
        pricing = contextual_pricing_summary_for_card(self.connection, card_id)
        return {
            "card": {
                "id": card["id"],
                "name": card["name"],
                "setName": card["setName"],
                "number": card["number"],
                "rarity": card["rarity"],
                "variant": card["variant"],
                "language": card["language"],
                "pricing": pricing,
            },
            "slabContext": None,
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

    def match_scan(self, payload: dict[str, Any]) -> dict[str, Any]:
        resolver_mode = resolver_mode_for_payload(payload)
        if resolver_mode == "raw_card":
            return self._resolve_raw_candidates(payload, api_key=os.environ.get("POKEMONTCG_API_KEY"))

        response = {
            "scanID": payload["scanID"],
            "topCandidates": [],
            "confidence": "low",
            "ambiguityFlags": ["Runtime is raw-only. Slab matching was intentionally removed."],
            "matcherSource": "remoteHybrid",
            "matcherVersion": MATCHER_VERSION,
            "resolverMode": resolver_mode,
            "resolverPath": "visual_fallback",
            "slabContext": None,
            "reviewDisposition": "unsupported",
            "reviewReason": "This backend build only supports raw card matching right now.",
        }
        self._emit_structured_log(self._scan_log_payload(payload, response, []))
        self._log_scan(payload, response, [])
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
        selected_card_id = None
        if top_candidates:
            selected_card_id = ((top_candidates[0].get("candidate") or {}).get("id"))
        upsert_scan_event(
            self.connection,
            scan_id=scan_id,
            request_payload=request_payload,
            response_payload=response_payload,
            matcher_source=response_payload["matcherSource"],
            matcher_version=response_payload["matcherVersion"],
            created_at=now,
            selected_card_id=selected_card_id,
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

        if parsed.path == "/api/v1/health":
            self._write_json(HTTPStatus.OK, self.service.health())
            return

        if parsed.path == "/api/v1/ops/provider-status":
            self._write_json(HTTPStatus.OK, self.service.provider_status())
            return

        if parsed.path == "/api/v1/ops/unmatched-scans":
            query = parse_qs(parsed.query)
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

            payload = self.service.card_detail(card_id)
            if payload is None:
                api_key = os.environ.get("POKEMONTCG_API_KEY")
                try:
                    imported = self.service.import_catalog_card(
                        card_id,
                        api_key=api_key,
                        trigger_source="auto_import_on_request",
                    )
                    if imported is not None:
                        payload = self.service.card_detail(card_id)
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
            try:
                payload = self.service.refresh_card_pricing(
                    card_id,
                    api_key=os.environ.get("POKEMONTCG_API_KEY"),
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
