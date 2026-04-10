from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from catalog_tools import (
    RAW_PRICING_MODE,
    RawEvidence,
    RawSignalScores,
    _set_overlap,
    _title_overlap,
    build_raw_retrieval_plan,
    canonicalize_collector_number,
    upsert_price_snapshot,
)
from pricing_provider import ProviderMetadata, PricingProvider, PsaPricingResult, RawPricingResult


SCRYDEX_PROVIDER = "scrydex"
SCRYDEX_BASE_URL = "https://api.scrydex.com"
SCRYDEX_USER_AGENT = "SpotlightScanner/0.1 (+https://local.spotlight.app)"
DEFAULT_REQUEST_TIMEOUT_SECONDS = 5


@dataclass(frozen=True)
class ScrydexRawSearchResult:
    cards: list[dict[str, Any]]
    attempts: list[dict[str, Any]]


def scrydex_credentials() -> tuple[str, str] | None:
    api_key = os.environ.get("SCRYDEX_API_KEY", "").strip()
    team_id = os.environ.get("SCRYDEX_TEAM_ID", "").strip()
    if not api_key or not team_id:
        return None
    return api_key, team_id


def scrydex_request_url(path: str, **params: str) -> str:
    base_url = os.environ.get("SCRYDEX_BASE_URL", SCRYDEX_BASE_URL).rstrip("/")
    query_string = urlencode(params)
    return f"{base_url}{path}?{query_string}" if query_string else f"{base_url}{path}"


def scrydex_api_request(
    path: str,
    *,
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    **params: str,
) -> dict[str, Any]:
    credentials = scrydex_credentials()
    if credentials is None:
        raise ValueError("Scrydex credentials are not configured")
    api_key, team_id = credentials
    request = Request(scrydex_request_url(path, **params))
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", SCRYDEX_USER_AGENT)
    request.add_header("X-Api-Key", api_key)
    request.add_header("X-Team-ID", team_id)

    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _scrydex_card_data(payload: dict[str, object]) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise ValueError("Scrydex payload must be a dictionary")

    data = payload.get("data")
    if isinstance(data, dict):
        return data

    if payload.get("id") is not None:
        return payload

    raise ValueError("Scrydex payload is missing a card data object")


def _normalize_scrydex_language(value: object) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"ja", "japanese"}:
        return "Japanese"
    if normalized in {"en", "english"}:
        return "English"
    return str(value or "Unknown")


def map_scrydex_catalog_card(payload: dict[str, object]) -> dict[str, object]:
    data = _scrydex_card_data(payload)

    expansion = data.get("expansion") if isinstance(data.get("expansion"), dict) else {}
    translation = data.get("translation") if isinstance(data.get("translation"), dict) else {}
    translation_en = translation.get("en") if isinstance(translation.get("en"), dict) else {}
    images = data.get("images") if isinstance(data.get("images"), list) else []
    front_image = next((image for image in images if isinstance(image, dict) and image.get("type") == "front"), {}) or {}

    return {
        "id": str(data.get("id") or ""),
        "name": str(translation_en.get("name") or data.get("name") or ""),
        "set_name": str(expansion.get("name") or ""),
        "number": str(data.get("printed_number") or data.get("number") or ""),
        "rarity": str(translation_en.get("rarity") or data.get("rarity") or "Unknown"),
        "variant": "Raw",
        "language": _normalize_scrydex_language(data.get("language_code") or data.get("language") or expansion.get("language")),
        "reference_image_path": None,
        "reference_image_url": front_image.get("large"),
        "reference_image_small_url": front_image.get("small"),
        "source": SCRYDEX_PROVIDER,
        "source_record_id": str(data.get("id") or ""),
        "set_id": expansion.get("id"),
        "set_series": expansion.get("series"),
        "set_ptcgo_code": expansion.get("code"),
        "set_release_date": expansion.get("release_date"),
        "supertype": str(translation_en.get("supertype") or data.get("supertype") or ""),
        "subtypes": list(translation_en.get("subtypes") or data.get("subtypes") or []),
        "types": list(translation_en.get("types") or data.get("types") or []),
        "artist": data.get("artist"),
        "regulation_mark": None,
        "national_pokedex_numbers": [],
        "tcgplayer": {},
        "cardmarket": {},
        "source_payload": data,
    }


def _quote_query_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _contains_japanese_text(text: str) -> bool:
    return bool(re.search(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]", text))


def raw_evidence_looks_japanese(evidence: RawEvidence) -> bool:
    return any(
        _contains_japanese_text(text)
        for text in [
            evidence.title_text_primary,
            evidence.title_text_secondary,
            evidence.footer_band_text,
            evidence.recognized_text,
        ]
        if text
    )


def _scrydex_japanese_title_clauses(evidence: RawEvidence) -> list[str]:
    title_text = (evidence.title_text_primary or evidence.title_text_secondary or "").strip()
    if not title_text:
        return []
    return [f'name:"{_quote_query_value(title_text)}"']


def _scrydex_japanese_expansion_scopes(evidence: RawEvidence) -> list[str]:
    tokens = list(evidence.trusted_set_hint_tokens or evidence.set_hint_tokens)
    normalized: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        cleaned = token.strip().lower()
        if not cleaned:
            continue
        scope = f"expansion.id:{cleaned}" if cleaned.endswith("_ja") else f"expansion.code:{cleaned}"
        if scope in seen:
            continue
        seen.add(scope)
        normalized.append(scope)
    return normalized


def _best_scrydex_raw_price(payload: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    data = _scrydex_card_data(payload)
    variants = data.get("variants") if isinstance(data.get("variants"), list) else []
    ranked: list[tuple[tuple[int, int, int, int], str, dict[str, Any]]] = []
    for variant in variants:
        if not isinstance(variant, dict):
            continue
        variant_name = str(variant.get("name") or "raw")
        prices = variant.get("prices") if isinstance(variant.get("prices"), list) else []
        for price in prices:
            if not isinstance(price, dict):
                continue
            if str(price.get("type") or "").lower() != "raw":
                continue
            if bool(price.get("is_error")) or bool(price.get("is_signed")) or bool(price.get("is_perfect")):
                continue
            has_market = 1 if isinstance(price.get("market"), (int, float)) else 0
            condition = str(price.get("condition") or "").upper()
            is_nm = 1 if condition == "NM" else 0
            has_currency = 1 if price.get("currency") else 0
            has_mid = 1 if isinstance(price.get("mid"), (int, float)) else 0
            ranked.append(((has_market, is_nm, has_currency, has_mid), variant_name, price))
    if not ranked:
        return None
    ranked.sort(key=lambda item: item[0], reverse=True)
    _, variant_name, price = ranked[0]
    return variant_name, price


def persist_scrydex_raw_snapshot(connection, card_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    selected = _best_scrydex_raw_price(payload)
    if selected is None:
        return None

    variant_name, price = selected
    source_url = scrydex_request_url(f"/pokemon/v1/cards/{card_id}", include="prices")
    upsert_price_snapshot(
        connection,
        card_id=card_id,
        pricing_mode=RAW_PRICING_MODE,
        provider=SCRYDEX_PROVIDER,
        currency_code=str(price.get("currency") or "USD"),
        variant=variant_name,
        low_price=price.get("low"),
        market_price=price.get("market"),
        mid_price=price.get("mid"),
        high_price=price.get("high"),
        trend_price=((price.get("trends") or {}).get("days_30") or {}).get("price_change"),
        source_updated_at=None,
        source_url=source_url,
        payload={
            "provider": SCRYDEX_PROVIDER,
            "priceSource": SCRYDEX_PROVIDER,
            "variant": variant_name,
            "condition": price.get("condition"),
            "cardName": _scrydex_card_data(payload).get("name"),
            "setName": ((_scrydex_card_data(payload).get("expansion") or {}).get("name")),
        },
    )
    connection.commit()
    return _scrydex_card_data(payload)


def fetch_scrydex_card_by_id(
    card_id: str,
    *,
    include_prices: bool = False,
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    params = {"include": "prices"} if include_prices else {}
    payload = scrydex_api_request(f"/pokemon/v1/cards/{card_id}", timeout=timeout, **params)
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError(f"Card {card_id} was not returned by Scrydex")
    return data


def _scrydex_run_japanese_query(query: str, *, include_prices: bool, page_size: int) -> list[dict[str, Any]]:
    params = {
        "q": query,
        "page_size": str(page_size),
    }
    if include_prices:
        params["include"] = "prices"
    payload = scrydex_api_request("/pokemon/v1/ja/cards", **params)
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def search_remote_scrydex_japanese_raw_candidates(
    evidence: RawEvidence,
    signals: RawSignalScores,
    *,
    page_size: int = 10,
) -> ScrydexRawSearchResult:
    plan = build_raw_retrieval_plan(evidence, signals)
    printed_number = evidence.collector_number_exact or evidence.collector_number_partial
    title_clauses = _scrydex_japanese_title_clauses(evidence)
    expansion_scopes = _scrydex_japanese_expansion_scopes(evidence)
    query_groups: list[list[str]] = []

    if printed_number and "collector_set_exact" in plan.routes and expansion_scopes:
        query_groups.append([
            f'printed_number:"{_quote_query_value(printed_number.upper())}" {expansion_scope}'
            for expansion_scope in expansion_scopes
        ])
    if printed_number and "collector_only" in plan.routes:
        query_groups.append([f'printed_number:"{_quote_query_value(printed_number.upper())}"'])
    if title_clauses and "title_set_primary" in plan.routes and expansion_scopes:
        query_groups.append([
            f"{clause} {expansion_scope}"
            for clause in title_clauses
            for expansion_scope in expansion_scopes
        ])
    if title_clauses and "title_only" in plan.routes:
        query_groups.append(title_clauses)

    seen: set[str] = set()
    results: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []

    for group in query_groups:
        group_hits = 0
        for query in group:
            try:
                cards = _scrydex_run_japanese_query(query, include_prices=True, page_size=page_size)
            except Exception as exc:
                attempts.append({
                    "query": query,
                    "count": 0,
                    "error": str(exc),
                })
                continue
            attempts.append({
                "query": query,
                "count": len(cards),
                "error": None,
            })
            if cards:
                group_hits += len(cards)
            for card in cards:
                card_id = str(card.get("id") or "").strip()
                if not card_id or card_id in seen:
                    continue
                seen.add(card_id)
                results.append(card)
        if group_hits > 0:
            break

    return ScrydexRawSearchResult(cards=results, attempts=attempts)


def best_remote_scrydex_raw_candidates(
    results: list[dict[str, Any]],
    evidence: RawEvidence,
    signals: RawSignalScores,
    *,
    limit: int = 12,
) -> list[dict[str, Any]]:
    scored: list[tuple[float, dict[str, Any]]] = []

    for raw_card in results:
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
        }
        title_overlap = _title_overlap(candidate, evidence)
        set_overlap = _set_overlap(candidate, evidence)

        collector_overlap = 0.0
        candidate_number = canonicalize_collector_number(str(mapped.get("number") or ""))
        if evidence.collector_number_exact and candidate_number == canonicalize_collector_number(evidence.collector_number_exact):
            collector_overlap = 1.0
        elif evidence.collector_number_partial and candidate_number == canonicalize_collector_number(evidence.collector_number_partial):
            collector_overlap = 0.75
        elif printed_query := next(iter(evidence.collector_number_query_values), None):
            if printed_query in candidate_number:
                collector_overlap = 0.5

        if not any(score > 0.0 for score in (title_overlap, set_overlap, collector_overlap)):
            continue

        retrieval_score = round(
            (title_overlap * min(35.0, float(signals.title_signal) * 0.35))
            + (set_overlap * min(20.0, float(signals.set_signal) * 0.25))
            + (collector_overlap * min(15.0, float(signals.collector_signal) * 0.18))
            + 5.0,
            4,
        )
        candidate["_cachePresence"] = False
        candidate["_retrievalScoreHint"] = retrieval_score
        candidate["_retrievalRoutes"] = ["remote_provider_scrydex_ja"]
        scored.append((retrieval_score, candidate))

    scored.sort(key=lambda item: (-item[0], item[1]["name"], item[1]["number"]))
    return [candidate for _, candidate in scored[:limit]]


class ScrydexProvider(PricingProvider):
    def get_metadata(self) -> ProviderMetadata:
        return ProviderMetadata(
            provider_id=SCRYDEX_PROVIDER,
            provider_label="Scrydex",
            is_ready=self.is_ready(),
            requires_credentials=True,
            supports_raw_pricing=True,
            supports_psa_pricing=True,
        )

    def is_ready(self) -> bool:
        return scrydex_credentials() is not None

    def refresh_raw_pricing(self, connection, card_id: str) -> RawPricingResult:
        try:
            payload = fetch_scrydex_card_by_id(card_id, include_prices=True)
        except Exception as exc:
            return RawPricingResult(
                success=False,
                provider_id=SCRYDEX_PROVIDER,
                card_id=card_id,
                error=str(exc),
            )

        persisted = persist_scrydex_raw_snapshot(connection, card_id, payload)
        if persisted is None:
            return RawPricingResult(
                success=False,
                provider_id=SCRYDEX_PROVIDER,
                card_id=card_id,
                error="No raw pricing available from Scrydex",
            )

        return RawPricingResult(
            success=True,
            provider_id=SCRYDEX_PROVIDER,
            card_id=card_id,
            payload=payload,
        )

    def refresh_psa_pricing(self, connection, card_id: str, grade: str) -> PsaPricingResult:
        return PsaPricingResult(
            success=False,
            provider_id=SCRYDEX_PROVIDER,
            card_id=card_id,
            grade=grade,
            error="Slab pricing is intentionally removed from the raw-only backend build.",
        )
