from __future__ import annotations

import json
import os
import re
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
    canonicalize_collector_number,
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
    tokenize,
    upsert_catalog_card,
    upsert_scan_event,
    utc_now,
)
from fx_rates import decorate_pricing_summary_with_fx
from pokemontcg_api_client import (
    best_remote_raw_candidates,
    build_raw_provider_queries,
    fetch_card_by_id,
    map_card,
    search_remote_raw_candidates,
)
from pokemontcg_pricing_adapter import PokemonTcgApiProvider
from pricecharting_adapter import PriceChartingProvider
from pricing_provider import PricingProviderRegistry
from scrydex_adapter import (
    ScrydexProvider,
    best_remote_scrydex_raw_candidates,
    map_scrydex_catalog_card,
    persist_scrydex_raw_snapshot,
    search_remote_scrydex_slab_candidates,
    raw_evidence_looks_japanese,
    search_remote_scrydex_japanese_raw_candidates,
)


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
    set_hint_tokens: tuple[str, ...]
    variant_hints: dict[str, Any]
    grader: str | None
    grade: str | None
    cert_number: str | None
    recommended_lookup_path: str | None


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

    def _display_pricing_summary_for_card(
        self,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
        preferred_variant: str | None = None,
    ) -> dict[str, Any] | None:
        pricing = contextual_pricing_summary_for_card(
            self.connection,
            card_id,
            grader=grader,
            grade=grade,
            variant=preferred_variant,
        )
        return decorate_pricing_summary_with_fx(self.connection, pricing)

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
        parsed_label_text = tuple(
            str(text or "").strip()
            for text in (payload.get("slabParsedLabelText") or [])
            if str(text or "").strip()
        )
        label_text = str(slab_evidence.get("labelWideText") or " ".join(parsed_label_text) or "")
        card_number = str(slab_evidence.get("cardNumber") or payload.get("slabCardNumberRaw") or "").strip() or None
        raw_title_primary = str(slab_evidence.get("titleTextPrimary") or "").strip()
        raw_title_secondary = str(slab_evidence.get("titleTextSecondary") or "").strip()
        normalized_title_primary = SpotlightScanService._normalized_slab_title_text(
            raw_title_primary,
            label_text=label_text,
            parsed_label_text=parsed_label_text,
            card_number=card_number,
        )
        normalized_title_secondary = SpotlightScanService._normalized_slab_title_text(
            raw_title_secondary,
            label_text=label_text,
            parsed_label_text=parsed_label_text,
            card_number=card_number,
        )
        set_hints = slab_evidence.get("setHints") or SpotlightScanService._inferred_slab_set_hints(
            label_text,
            parsed_label_text=parsed_label_text,
            card_number=card_number,
        )
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
            set_hint_tokens=normalized_set_hints,
            variant_hints=variant_hints,
            grader=str(slab_evidence.get("grader") or payload.get("slabGrader") or "").strip() or None,
            grade=str(slab_evidence.get("grade") or payload.get("slabGrade") or "").strip() or None,
            cert_number=str(slab_evidence.get("cert") or payload.get("slabCertNumber") or "").strip() or None,
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
        normalized = normalized.replace("-", " ")
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
    def _inferred_slab_set_hints(
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

        normalized_number = SpotlightScanService._normalized_slab_card_number(card_number)
        generic_tokens = {"P", "M", "PM", "POKEMON", "GAME", "CARD", "CARDS", "JAPANESE"}
        if normalized_number:
            number_pattern = rf"#?0*{re.escape(normalized_number)}\b" if normalized_number.isdigit() else rf"#?{re.escape(normalized_number)}\b"
            for text in texts:
                normalized_text = re.sub(r"[^A-Z0-9#/&+\\-]+", " ", text.upper()).strip()
                if not normalized_text:
                    continue
                match = re.search(rf"^(?:20\d{{2}}\s+)?(?P<pre>.*?)\s+{number_pattern}(?:\s+|$)", normalized_text)
                if not match:
                    continue
                pre_tokens = [
                    token
                    for token in match.group("pre").split()
                    if token and not token.isdigit()
                ]
                for prefix_length in range(2, min(4, len(pre_tokens)) + 1):
                    prefix_tokens = pre_tokens[:prefix_length]
                    if not any(token not in generic_tokens for token in prefix_tokens):
                        continue
                    add(" ".join(token.title() for token in prefix_tokens))

        return hints

    @staticmethod
    def _normalized_slab_title_text(
        title_text: str,
        *,
        label_text: str,
        parsed_label_text: tuple[str, ...],
        card_number: str | None,
    ) -> str:
        texts = [title_text, label_text, *parsed_label_text]
        normalized_number = SpotlightScanService._normalized_slab_card_number(card_number)
        title_candidates: list[list[str]] = []
        stop_tokens = {
            "PSA",
            "CGC",
            "BGS",
            "BECKETT",
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
        }
        drop_from_title = {"HOLO", "HOLOFOIL", "REVERSE", "FOIL"}

        direct_title_tokens = SpotlightScanService._normalize_slab_title_tokens([
            token.lstrip("#")
            for token in SpotlightScanService._slab_query_tokens(title_text)
            if token and not token.isdigit()
        ])
        if normalized_number:
            number_pattern = rf"#?0*{re.escape(normalized_number)}\b" if normalized_number.isdigit() else rf"#?{re.escape(normalized_number)}\b"
            for text in texts:
                normalized_text = re.sub(r"[^A-Z0-9#/&+\\-]+", " ", text.upper()).strip()
                if not normalized_text:
                    continue
                match = re.search(rf"^(?:20\d{{2}}\s+)?(?P<pre>.*?)\s+{number_pattern}(?:\s+(?P<post>.*))?$", normalized_text)
                if not match:
                    continue
                post_tokens = SpotlightScanService._normalize_slab_title_tokens(
                    SpotlightScanService._slab_query_tokens(match.group("post") or "")
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

                pre_tokens = SpotlightScanService._normalize_slab_title_tokens([
                    token.lstrip("#")
                    for token in SpotlightScanService._slab_query_tokens(match.group("pre") or "")
                    if token and not token.isdigit()
                ])
                if len(pre_tokens) >= 2:
                    for suffix_length in range(1, min(3, len(pre_tokens) - 1) + 1):
                        title_candidates.append(pre_tokens[-suffix_length:])

        cleaned_direct_title = [
            token
            for token in direct_title_tokens
            if token not in stop_tokens
            and not re.fullmatch(r"\d{7,10}", token)
            and (not normalized_number or token != normalized_number and not token.endswith(normalized_number))
            and token not in {"POKEMON", "GO"}
            and token not in drop_from_title
        ]
        if cleaned_direct_title and len(cleaned_direct_title) <= 4:
            title_candidates.append(cleaned_direct_title)

        if not title_candidates:
            tokens = SpotlightScanService._normalize_slab_title_tokens([
                token.lstrip("#")
                for token in SpotlightScanService._slab_query_tokens(title_text)
                if token and not token.isdigit()
            ])
            if tokens:
                title_candidates.append(tokens)

        for tokens in title_candidates:
            filtered = [
                token
                for token in tokens
                if token not in stop_tokens
                and not re.fullmatch(r"\d{7,10}", token)
                and token not in {"POKEMON", "GO"}
            ]
            filtered = [token for token in filtered if token not in drop_from_title]
            if filtered:
                return " ".join(token.title() for token in filtered)

        return title_text

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
        source_payload = card.get("sourcePayload") or {}
        if isinstance(source_payload, dict):
            add(source_payload.get("name"))
            translation = source_payload.get("translation")
            if isinstance(translation, dict):
                translation_en = translation.get("en")
                if isinstance(translation_en, dict):
                    add(translation_en.get("name"))
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
                "psa_slabs",
                "graded_pricing",
            ],
            "unsupportedScanScopes": [
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
            "runtimeMode": "raw_and_slab",
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
        if not plan.should_query_remote:
            return [], {
                "queries": [],
                "attempts": [],
                "resultCount": 0,
                "reason": "plan_disabled",
            }
        if self._should_use_scrydex_japanese_raw(evidence):
            remote_search = search_remote_scrydex_japanese_raw_candidates(evidence, signals, page_size=10)
            remote_candidates = best_remote_scrydex_raw_candidates(remote_search.cards, evidence, signals, limit=12)
            queries = [attempt["query"] for attempt in remote_search.attempts]
            if not queries:
                return [], {
                    "queries": [],
                    "attempts": [],
                    "resultCount": 0,
                    "reason": "no_queries",
                }
            return remote_candidates, {
                "queries": queries,
                "attempts": remote_search.attempts,
                "resultCount": len(remote_search.cards),
                "reason": None,
            }

        queries = build_raw_provider_queries(evidence, signals)
        if not queries:
            return [], {
                "queries": [],
                "attempts": [],
                "resultCount": 0,
                "reason": "no_queries",
            }
        remote_search = search_remote_raw_candidates(queries, api_key, page_size=10)
        remote_candidates = best_remote_raw_candidates(remote_search.cards, evidence, signals, limit=12)
        return remote_candidates, {
            "queries": queries,
            "attempts": remote_search.attempts,
            "resultCount": len(remote_search.cards),
            "reason": None,
        }

    def _retrieve_local_slab_candidates(self, evidence: SlabMatchEvidence) -> list[dict[str, Any]]:
        query_parts = [
            evidence.title_text_primary,
            evidence.title_text_secondary,
            evidence.card_number,
            *evidence.set_hint_tokens,
        ]
        seen: set[str] = set()
        candidates: list[dict[str, Any]] = []
        for query in [part for part in query_parts if part]:
            for card in search_cards_local(self.connection, query, limit=12):
                card_id = str(card.get("id") or "")
                if not card_id or card_id in seen:
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

    def _retrieve_remote_slab_candidates(self, evidence: SlabMatchEvidence) -> tuple[list[dict[str, Any]], dict[str, Any]]:
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
                elif source_payload.get("id") and source_payload.get("number") is not None:
                    mapped_card = map_card(source_payload, None)
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
                "source_payload": source_payload if isinstance(source_payload, dict) else {},
            }

        provider_prices = (((mapped_card.get("tcgplayer") or {}) if isinstance(mapped_card, dict) else {}).get("prices") or {})
        cached = card_by_id(self.connection, card_id)
        if cached is not None:
            cached_pricing = contextual_pricing_summary_for_card(self.connection, card_id)
            if cached_pricing is None and source_provider == "scrydex" and isinstance(source_payload, dict):
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
        if source_provider == "scrydex" and isinstance(source_payload, dict):
            persist_scrydex_raw_snapshot(self.connection, card_id, source_payload)
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
        pricing = self._display_pricing_summary_for_card(card_id) if card_id else None

        if card_id and refresh_pricing_if_missing and pricing is None:
            refreshed_detail = self.refresh_card_pricing(card_id, api_key=api_key)
            pricing = ((refreshed_detail or {}).get("card", {}) or {}).get("pricing") if isinstance(refreshed_detail, dict) else None
            if pricing is None:
                pricing = self._display_pricing_summary_for_card(card_id)

        candidate = {
            "id": card_id or str(card.get("id") or ""),
            "name": str(resolved_card.get("name") or card.get("name") or ""),
            "setName": str(resolved_card.get("setName") or card.get("setName") or ""),
            "number": str(resolved_card.get("number") or card.get("number") or ""),
            "rarity": str(resolved_card.get("rarity") or card.get("rarity") or "Unknown"),
            "variant": str(resolved_card.get("variant") or card.get("variant") or "Raw"),
            "language": str(resolved_card.get("language") or card.get("language") or "English"),
            "imageSmallURL": resolved_card.get("imageSmallURL") or card.get("imageSmallURL"),
            "imageLargeURL": resolved_card.get("imageURL") or card.get("imageLargeURL") or card.get("imageURL"),
        }
        if pricing is not None:
            candidate["pricing"] = pricing
        return candidate

    def _slab_candidate_payload(
        self,
        card: dict[str, Any],
        *,
        slab_context: dict[str, Any],
        ensure_cached: bool = False,
        refresh_pricing_if_missing: bool = False,
    ) -> dict[str, Any]:
        resolved_card = self._ensure_raw_card_cached(card, "scan_match_slab") if ensure_cached else card
        card_id = str(resolved_card.get("id") or "").strip()
        grader = str(slab_context.get("grader") or "").strip() or None
        grade = str(slab_context.get("grade") or "").strip() or None
        preferred_variant = str(slab_context.get("variantName") or "").strip() or None
        variant_hints = slab_context.get("variantHints")
        pricing = (
            self._display_pricing_summary_for_card(card_id, grader=grader, grade=grade, preferred_variant=preferred_variant)
            if card_id and grader and grade
            else None
        )
        if pricing is not None and not self._slab_variant_matches(
            pricing.get("variant"),
            preferred_variant=preferred_variant,
            variant_hints=variant_hints if isinstance(variant_hints, dict) else None,
        ):
            pricing = None

        if card_id and grader and grade and refresh_pricing_if_missing and pricing is None:
            refreshed_detail = self.refresh_card_pricing(
                card_id,
                grader=grader,
                grade=grade,
                preferred_variant=preferred_variant,
                variant_hints=variant_hints if isinstance(variant_hints, dict) else None,
            )
            pricing = ((refreshed_detail or {}).get("card", {}) or {}).get("pricing") if isinstance(refreshed_detail, dict) else None
            if pricing is None:
                pricing = self._display_pricing_summary_for_card(
                    card_id,
                    grader=grader,
                    grade=grade,
                    preferred_variant=preferred_variant,
                )

        candidate = {
            "id": card_id or str(card.get("id") or ""),
            "name": str(resolved_card.get("name") or card.get("name") or ""),
            "setName": str(resolved_card.get("setName") or card.get("setName") or ""),
            "number": str(resolved_card.get("number") or card.get("number") or ""),
            "rarity": str(resolved_card.get("rarity") or card.get("rarity") or "Unknown"),
            "variant": str(resolved_card.get("variant") or card.get("variant") or "Raw"),
            "language": str(resolved_card.get("language") or card.get("language") or "English"),
            "imageSmallURL": resolved_card.get("imageSmallURL") or card.get("imageSmallURL"),
            "imageLargeURL": resolved_card.get("imageURL") or card.get("imageLargeURL") or card.get("imageURL"),
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
                "ambiguityDebug": decision.debug_payload.get("ambiguity"),
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
                refresh_pricing_if_missing=index == 0,
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
                "setHintTokens": list(evidence.set_hint_tokens),
                "variantHints": dict(evidence.variant_hints),
                "grader": evidence.grader,
                "grade": evidence.grade,
                "cert": evidence.cert_number,
                "lookupPath": evidence.recommended_lookup_path,
            },
            "remote": remote_debug,
            "topMatches": [
                {
                    "id": candidate.get("id"),
                    "name": candidate.get("name"),
                    "number": candidate.get("number"),
                    "score": round(float(candidate.get("_retrievalScoreHint") or 0.0), 4),
                    "reasons": list(candidate.get("_reasons") or []),
                }
                for candidate in ranked_candidates[:3]
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
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        slab_context = {
            "grader": evidence.grader,
            "grade": evidence.grade,
            "certNumber": evidence.cert_number,
            "variantHints": dict(evidence.variant_hints),
        } if evidence.grader else None

        if not evidence.grader or not evidence.grade:
            response = {
                "scanID": payload["scanID"],
                "topCandidates": [],
                "confidence": "low",
                "ambiguityFlags": ["Slab OCR is missing a confident grader or grade."],
                "matcherSource": "remoteHybrid",
                "matcherVersion": MATCHER_VERSION,
                "resolverMode": "psa_slab",
                "resolverPath": "psa_label",
                "slabContext": slab_context,
                "reviewDisposition": "unsupported",
                "reviewReason": "Could not extract a confident slab grader and grade.",
            }
            return response, []

        if not ranked_candidates:
            response = {
                "scanID": payload["scanID"],
                "topCandidates": [],
                "confidence": "low",
                "ambiguityFlags": ["No slab candidates were available."],
                "matcherSource": "remoteHybrid",
                "matcherVersion": MATCHER_VERSION,
                "resolverMode": "psa_slab",
                "resolverPath": "psa_label",
                "slabContext": slab_context,
                "reviewDisposition": "unsupported",
                "reviewReason": "Could not identify the slabbed card from the label OCR.",
            }
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

        scored_candidates: list[dict[str, Any]] = []
        encoded_candidates: list[dict[str, Any]] = []
        for index, candidate in enumerate(ranked_candidates[:3]):
            candidate_payload = self._slab_candidate_payload(
                candidate,
                slab_context=slab_context or {},
                ensure_cached=index == 0,
                refresh_pricing_if_missing=index == 0,
            )
            score_hint = round(float(candidate.get("_retrievalScoreHint") or 0.0) / 100.0, 4)
            scored_entry = {
                "card": candidate,
                "candidate": candidate_payload,
                "finalScore": score_hint,
                "reasons": list(candidate.get("_reasons") or []),
            }
            scored_candidates.append(scored_entry)
            encoded_candidates.append(
                {
                    "rank": index + 1,
                    "candidate": candidate_payload,
                    "imageScore": score_hint,
                    "collectorNumberScore": score_hint,
                    "nameScore": score_hint,
                    "finalScore": score_hint,
                }
            )

        if slab_context is not None and encoded_candidates:
            top_pricing = ((encoded_candidates[0].get("candidate") or {}).get("pricing") or {})
            if isinstance(top_pricing, dict):
                variant_name = str(top_pricing.get("variant") or "").strip()
                if variant_name:
                    slab_context["variantName"] = variant_name

        best_pricing = ((encoded_candidates[0].get("candidate") or {}).get("pricing") or {}) if encoded_candidates else {}
        if not best_pricing:
            response = {
                "scanID": payload["scanID"],
                "topCandidates": encoded_candidates,
                "confidence": "low",
                "ambiguityFlags": list(dict.fromkeys([*ambiguity_flags, "No exact graded price was available for this slab."])),
                "matcherSource": "remoteHybrid",
                "matcherVersion": MATCHER_VERSION,
                "resolverMode": "psa_slab",
                "resolverPath": "psa_label",
                "slabContext": slab_context,
                "reviewDisposition": "unsupported",
                "reviewReason": "Could not find exact graded pricing for this slab.",
            }
            return response, scored_candidates

        review_disposition = "ready" if confidence != "low" else "needs_review"
        review_reason = None if review_disposition == "ready" else "Review the slab match before relying on the result."
        response = {
            "scanID": payload["scanID"],
            "topCandidates": encoded_candidates,
            "confidence": confidence,
            "ambiguityFlags": list(dict.fromkeys(ambiguity_flags)),
            "matcherSource": "remoteHybrid",
            "matcherVersion": MATCHER_VERSION,
            "resolverMode": "psa_slab",
            "resolverPath": "psa_label",
            "slabContext": slab_context,
            "reviewDisposition": review_disposition,
            "reviewReason": review_reason,
        }
        return response, scored_candidates

    def _resolve_slab_candidates(self, payload: dict[str, Any]) -> dict[str, Any]:
        evidence = self._build_slab_evidence(payload)
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
        response, top_candidates = self._build_slab_match_response(payload, evidence, ranked_candidates)
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
            len(local_candidates) < 3 or top_local_score < 70.0 or local_delta < 8.0
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

    def refresh_card_pricing(
        self,
        card_id: str,
        api_key: str | None = None,
        grader: str | None = None,
        grade: str | None = None,
        preferred_variant: str | None = None,
        variant_hints: dict[str, Any] | None = None,
        force_refresh: bool = False,
    ) -> dict[str, Any] | None:
        if grader or grade:
            if not grader or not grade:
                return self.card_detail(card_id, grader=grader, grade=grade, preferred_variant=preferred_variant)

            existing_pricing = contextual_pricing_summary_for_card(
                self.connection,
                card_id,
                grader=grader,
                grade=grade,
                variant=preferred_variant,
            )
            if existing_pricing is not None and not self._slab_variant_matches(
                existing_pricing.get("variant"),
                preferred_variant=preferred_variant,
                variant_hints=variant_hints,
            ):
                existing_pricing = None
            if existing_pricing is not None and not force_refresh and existing_pricing.get("isFresh") is True:
                self._log_pricing_provenance("refresh_slab_cached", card_id, grader=grader, grade=grade)
                return self.card_detail(card_id, grader=grader, grade=grade, preferred_variant=preferred_variant)

            existing_card = card_by_id(self.connection, card_id)
            provider_id = str((existing_card or {}).get("sourceProvider") or "scrydex")
            psa_provider = self.pricing_registry.get_provider(provider_id) or self.pricing_registry.get_provider("scrydex")
            if psa_provider is None or not psa_provider.is_ready() or not psa_provider.get_metadata().supports_psa_pricing:
                return self.card_detail(card_id, grader=grader, grade=grade, preferred_variant=preferred_variant)

            refresh_kwargs: dict[str, Any] = {}
            if preferred_variant:
                refresh_kwargs["preferred_variant"] = preferred_variant
            if variant_hints:
                refresh_kwargs["variant_hints"] = variant_hints
            refresh_result = psa_provider.refresh_psa_pricing(
                self.connection,
                card_id,
                grader,
                grade,
                **refresh_kwargs,
            )
            if refresh_result.success:
                self._log_pricing_provenance("refresh_slab", card_id, grader=grader, grade=grade)
            return self.card_detail(card_id, grader=grader, grade=grade, preferred_variant=preferred_variant)

        existing_card = card_by_id(self.connection, card_id)
        if existing_card is None and api_key:
            try:
                self.import_catalog_card(card_id, api_key=api_key, trigger_source="refresh_pricing_auto_import")
            except Exception:
                return None
            existing_card = card_by_id(self.connection, card_id)

        existing_pricing = raw_pricing_summary_for_card(self.connection, card_id)
        if existing_pricing is not None and not force_refresh and existing_pricing.get("isFresh") is True:
            self._log_pricing_provenance("refresh_raw_cached", card_id)
            return self.card_detail(card_id)

        provider_id = str((existing_card or {}).get("sourceProvider") or "pokemontcg_api")
        raw_provider = self.pricing_registry.get_provider(provider_id)
        if raw_provider is None or not raw_provider.is_ready() or not raw_provider.get_metadata().supports_raw_pricing:
            return self.card_detail(card_id)

        provider_refresh_result = raw_provider.refresh_raw_pricing(self.connection, card_id)
        if provider_refresh_result.success:
            self._log_pricing_provenance("refresh_raw", card_id)
        return self.card_detail(card_id)

    def card_detail(
        self,
        card_id: str,
        *,
        grader: str | None = None,
        grade: str | None = None,
        preferred_variant: str | None = None,
    ) -> dict[str, Any] | None:
        card = card_by_id(self.connection, card_id)
        if card is None:
            return None
        pricing = self._display_pricing_summary_for_card(
            card_id,
            grader=grader,
            grade=grade,
            preferred_variant=preferred_variant,
        )
        resolved_variant = preferred_variant or (str((pricing or {}).get("variant") or "").strip() or None)
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
            "slabContext": {
                "grader": grader,
                "grade": grade,
                "certNumber": None,
                "variantName": resolved_variant,
            } if grader else None,
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
        self._emit_structured_log(self._scan_request_log_payload(payload))
        resolver_mode = resolver_mode_for_payload(payload)
        if resolver_mode == "raw_card":
            return self._resolve_raw_candidates(payload, api_key=os.environ.get("POKEMONTCG_API_KEY"))
        if resolver_mode == "psa_slab":
            return self._resolve_slab_candidates(payload)

        response = {
            "scanID": payload["scanID"],
            "topCandidates": [],
            "confidence": "low",
            "ambiguityFlags": ["Could not determine whether this scan is raw or slab."],
            "matcherSource": "remoteHybrid",
            "matcherVersion": MATCHER_VERSION,
            "resolverMode": resolver_mode,
            "resolverPath": "visual_fallback",
            "slabContext": None,
            "reviewDisposition": "unsupported",
            "reviewReason": "This scan could not be routed to a supported matcher.",
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

            query = parse_qs(parsed.query)
            grader = query.get("grader", [""])[0].strip() or None
            grade = query.get("grade", [""])[0].strip() or None
            preferred_variant = query.get("variant", [""])[0].strip() or None

            payload = self.service.card_detail(
                card_id,
                grader=grader,
                grade=grade,
                preferred_variant=preferred_variant,
            )
            if payload is None:
                api_key = os.environ.get("POKEMONTCG_API_KEY")
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
            preferred_variant = query.get("variant", [""])[0].strip() or None
            try:
                payload = self.service.refresh_card_pricing(
                    card_id,
                    api_key=os.environ.get("POKEMONTCG_API_KEY"),
                    grader=grader,
                    grade=grade,
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
