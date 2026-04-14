from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from time import perf_counter
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
    tokenize,
    upsert_price_snapshot,
    upsert_slab_price_snapshot,
)
from pricing_provider import ProviderMetadata, PricingProvider, PsaPricingResult, RawPricingResult


SCRYDEX_PROVIDER = "scrydex"
SCRYDEX_BASE_URL = "https://api.scrydex.com"
SCRYDEX_USER_AGENT = "SpotlightScanner/0.1 (+https://local.spotlight.app)"
DEFAULT_REQUEST_TIMEOUT_SECONDS = 5
SCRYDEX_FULL_CATALOG_SYNC_SCOPE = "raw_catalog_full"
_SCRYDEX_REQUEST_STATS_LOCK = Lock()
_SCRYDEX_REQUEST_STATS: dict[str, Any] = {
    "startedAt": datetime.now(timezone.utc).isoformat(),
    "total": 0,
    "byType": {},
    "byPath": {},
    "recent": [],
}


@dataclass(frozen=True)
class ScrydexRawSearchResult:
    cards: list[dict[str, Any]]
    attempts: list[dict[str, Any]]


@dataclass(frozen=True)
class ScrydexSlabSearchResult:
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


def _record_scrydex_request(path: str, request_type: str, params: dict[str, str]) -> dict[str, Any]:
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "type": request_type,
        "path": path,
        "query": params.get("q"),
        "include": params.get("include"),
        "pageSize": params.get("page_size"),
    }
    with _SCRYDEX_REQUEST_STATS_LOCK:
        _SCRYDEX_REQUEST_STATS["total"] = int(_SCRYDEX_REQUEST_STATS.get("total") or 0) + 1
        entry["sequence"] = int(_SCRYDEX_REQUEST_STATS["total"])
        by_type = _SCRYDEX_REQUEST_STATS.setdefault("byType", {})
        by_type[request_type] = int(by_type.get(request_type) or 0) + 1
        by_path = _SCRYDEX_REQUEST_STATS.setdefault("byPath", {})
        by_path[path] = int(by_path.get(path) or 0) + 1
        recent = _SCRYDEX_REQUEST_STATS.setdefault("recent", [])
        recent.append(entry)
        if len(recent) > 25:
            del recent[:-25]
    return dict(entry)


def _log_scrydex_request_line(
    *,
    phase: str,
    sequence: int | None,
    request_type: str,
    path: str,
    params: dict[str, str],
    elapsed_ms: float,
    result_count: int | None = None,
    error: str | None = None,
) -> None:
    query = str(params.get("q") or "").strip() or "-"
    include = str(params.get("include") or "").strip() or "-"
    page_size = str(params.get("page_size") or "").strip() or "-"
    suffix = f" results={result_count}" if result_count is not None else ""
    if error:
        suffix = f" error={error}"
    print(
        "[SCRYDEX HTTP] "
        f"{phase} "
        f"seq={sequence or '-'} "
        f"type={request_type} "
        f"path={path} "
        f"ms={elapsed_ms:.1f} "
        f"include={include} "
        f"pageSize={page_size} "
        f"q={query}{suffix}"
    )


def _scrydex_result_count(payload: dict[str, Any]) -> int | None:
    data = payload.get("data")
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        return 1
    return None


def reset_scrydex_request_stats() -> None:
    with _SCRYDEX_REQUEST_STATS_LOCK:
        _SCRYDEX_REQUEST_STATS["startedAt"] = datetime.now(timezone.utc).isoformat()
        _SCRYDEX_REQUEST_STATS["total"] = 0
        _SCRYDEX_REQUEST_STATS["byType"] = {}
        _SCRYDEX_REQUEST_STATS["byPath"] = {}
        _SCRYDEX_REQUEST_STATS["recent"] = []


def scrydex_request_stats_snapshot() -> dict[str, Any]:
    with _SCRYDEX_REQUEST_STATS_LOCK:
        return {
            "startedAt": _SCRYDEX_REQUEST_STATS.get("startedAt"),
            "total": int(_SCRYDEX_REQUEST_STATS.get("total") or 0),
            "byType": dict(_SCRYDEX_REQUEST_STATS.get("byType") or {}),
            "byPath": dict(_SCRYDEX_REQUEST_STATS.get("byPath") or {}),
            "recent": [dict(item) for item in (_SCRYDEX_REQUEST_STATS.get("recent") or [])],
        }


def scrydex_api_request(
    path: str,
    *,
    request_type: str = "generic",
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    **params: str,
) -> dict[str, Any]:
    credentials = scrydex_credentials()
    if credentials is None:
        raise ValueError("Scrydex credentials are not configured")
    api_key, team_id = credentials
    request_entry = _record_scrydex_request(path, request_type, params)
    request = Request(scrydex_request_url(path, **params))
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", SCRYDEX_USER_AGENT)
    request.add_header("X-Api-Key", api_key)
    request.add_header("X-Team-ID", team_id)

    started = perf_counter()
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        _log_scrydex_request_line(
            phase="error",
            sequence=request_entry.get("sequence"),
            request_type=request_type,
            path=path,
            params=params,
            elapsed_ms=(perf_counter() - started) * 1000.0,
            error=str(exc),
        )
        raise

    _log_scrydex_request_line(
        phase="ok",
        sequence=request_entry.get("sequence"),
        request_type=request_type,
        path=path,
        params=params,
        elapsed_ms=(perf_counter() - started) * 1000.0,
        result_count=_scrydex_result_count(payload),
    )
    return payload


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


def _scrydex_raw_title_clauses(evidence: RawEvidence) -> list[str]:
    title_text = (evidence.title_text_primary or evidence.title_text_secondary or "").strip()
    if not title_text:
        return []

    clauses = [f'name:"{_quote_query_value(title_text)}"']
    tokens = [token for token in tokenize(title_text) if len(token) >= 3]
    safe_tokens = [token for token in tokens if token.isascii()]
    if len(safe_tokens) >= 2:
        clauses.append(" ".join(f"name:{token}" for token in safe_tokens[: min(3, len(safe_tokens))]))
    elif len(safe_tokens) == 1:
        clauses.append(f"name:{safe_tokens[0]}")

    seen: set[str] = set()
    normalized: list[str] = []
    for clause in clauses:
        cleaned = clause.strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            normalized.append(cleaned)
    return normalized


def _scrydex_japanese_expansion_scopes(evidence: RawEvidence) -> list[str]:
    return _scrydex_expansion_scopes(list(evidence.trusted_set_hint_tokens or evidence.set_hint_tokens))


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


def persist_scrydex_raw_snapshot(
    connection,
    card_id: str,
    payload: dict[str, Any],
    *,
    commit: bool = True,
) -> dict[str, Any] | None:
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
    if commit:
        connection.commit()
    return _scrydex_card_data(payload)


def fetch_scrydex_card_by_id(
    card_id: str,
    *,
    include_prices: bool = False,
    request_type: str = "card_fetch",
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    params = {"include": "prices"} if include_prices else {}
    payload = scrydex_api_request(
        f"/pokemon/v1/cards/{card_id}",
        request_type=request_type,
        timeout=timeout,
        **params,
    )
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError(f"Card {card_id} was not returned by Scrydex")
    return data


def fetch_scrydex_cards_page(
    *,
    page: int,
    page_size: int = 100,
    include_prices: bool = False,
    language: str | None = None,
    request_type: str = "catalog_sync_page",
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> list[dict[str, Any]]:
    normalized_language = str(language or "").strip().lower()
    if normalized_language in {"", "all", "default"}:
        path = "/pokemon/v1/cards"
    else:
        path = f"/pokemon/v1/{normalized_language}/cards"
    params = {
        "page": str(page),
        "page_size": str(page_size),
    }
    if include_prices:
        params["include"] = "prices"
    payload = scrydex_api_request(
        path,
        request_type=request_type,
        timeout=timeout,
        **params,
    )
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def _scrydex_run_cards_query(
    query: str,
    *,
    include_prices: bool,
    page_size: int,
    request_type: str,
) -> list[dict[str, Any]]:
    params = {
        "q": query,
        "page_size": str(page_size),
    }
    if include_prices:
        params["include"] = "prices"
    payload = scrydex_api_request("/pokemon/v1/cards", request_type=request_type, **params)
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def _scrydex_run_japanese_query(
    query: str,
    *,
    include_prices: bool,
    page_size: int,
    request_type: str,
) -> list[dict[str, Any]]:
    params = {
        "q": query,
        "page_size": str(page_size),
    }
    if include_prices:
        params["include"] = "prices"
    payload = scrydex_api_request("/pokemon/v1/ja/cards", request_type=request_type, **params)
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def _scrydex_slab_title_clauses(title_text: str) -> list[str]:
    title = title_text.strip()
    if not title:
        return []

    clauses = [f'name:"{_quote_query_value(title)}"']
    tokens = [token for token in tokenize(title) if len(token) >= 3]
    if len(tokens) >= 2:
        clauses.append(" ".join(f"name:{token}" for token in tokens[:5]))
    elif len(tokens) == 1:
        clauses.append(f"name:{tokens[0]}")
    return clauses


def _scrydex_expansion_scopes(tokens: list[str] | tuple[str, ...]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        raw_value = str(token or "").strip()
        cleaned = raw_value.lower()
        if not cleaned:
            continue
        if " " in raw_value:
            scope = f'expansion.name:"{_quote_query_value(raw_value)}"'
        elif cleaned.isalpha() and len(cleaned) > 3:
            scope = f'expansion.name:"{_quote_query_value(raw_value)}"'
        else:
            scope = f"expansion.id:{cleaned}" if cleaned.endswith("_ja") else f"expansion.code:{cleaned}"
        if scope in seen:
            continue
        seen.add(scope)
        normalized.append(scope)
    return normalized


def _normalize_slab_card_number(card_number: str | None) -> str | None:
    raw = str(card_number or "").strip().lstrip("#").upper()
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


def _scrydex_slab_number_queries(card_number: str | None) -> list[str]:
    normalized = _normalize_slab_card_number(card_number)
    if not normalized:
        return []
    values: list[str] = []
    seen: set[str] = set()

    def add(query: str) -> None:
        if query in seen:
            return
        seen.add(query)
        values.append(query)

    if "/" in normalized:
        add(f'printed_number:"{_quote_query_value(normalized)}"')
        number_prefix = normalized.split("/", 1)[0]
        add(f'number:"{_quote_query_value(number_prefix)}"')
    else:
        add(f'number:"{_quote_query_value(normalized)}"')
        add(f'printed_number:"{_quote_query_value(normalized)}"')

    return values


def _search_remote_scrydex_raw_candidates(
    evidence: RawEvidence,
    signals: RawSignalScores,
    *,
    japanese_only: bool,
    page_size: int = 10,
) -> ScrydexRawSearchResult:
    plan = build_raw_retrieval_plan(evidence, signals)
    printed_number = evidence.collector_number_exact or evidence.collector_number_partial
    title_clauses = _scrydex_japanese_title_clauses(evidence) if japanese_only else _scrydex_raw_title_clauses(evidence)
    expansion_scopes = _scrydex_expansion_scopes(list(evidence.trusted_set_hint_tokens or evidence.set_hint_tokens))
    primary_title_clause = title_clauses[0] if title_clauses else None
    primary_expansion_scope = expansion_scopes[0] if expansion_scopes else None

    def build_broad_query() -> str | None:
        if "broad_text_fallback" not in plan.routes or not evidence.recognized_tokens:
            return None
        fallback_tokens = [
            token
            for token in evidence.recognized_tokens
            if token.isascii() and token.isalpha() and len(token) > 2
        ][:2]
        if not fallback_tokens:
            return None
        return " ".join(f'name:"{_quote_query_value(token)}"' for token in fallback_tokens)

    query_attempts: list[str] = []

    def add_query(query: str | None) -> None:
        cleaned = str(query or "").strip()
        if not cleaned or cleaned in query_attempts:
            return
        query_attempts.append(cleaned)

    normalized_printed_number = _quote_query_value(str(printed_number or "").upper()) if printed_number else None

    if normalized_printed_number and primary_expansion_scope:
        add_query(f'printed_number:"{normalized_printed_number}" {primary_expansion_scope}')
        if primary_title_clause and "title_collector" in plan.routes:
            add_query(f'{primary_title_clause} printed_number:"{normalized_printed_number}"')
        else:
            add_query(f'printed_number:"{normalized_printed_number}"')
    elif normalized_printed_number and primary_title_clause and "title_collector" in plan.routes:
        add_query(f'{primary_title_clause} printed_number:"{normalized_printed_number}"')
        add_query(f'printed_number:"{normalized_printed_number}"')
    elif primary_title_clause and primary_expansion_scope:
        add_query(f"{primary_title_clause} {primary_expansion_scope}")
        add_query(primary_title_clause if "title_only" in plan.routes else build_broad_query())
    elif primary_title_clause:
        add_query(primary_title_clause)
        add_query(build_broad_query())
    elif normalized_printed_number:
        add_query(f'printed_number:"{normalized_printed_number}"')
    else:
        add_query(build_broad_query())

    query_attempts = query_attempts[:2]

    seen: set[str] = set()
    results: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []

    request_type = "raw_search_japanese" if japanese_only else "raw_search"

    for query in query_attempts:
        try:
            cards = (
                _scrydex_run_japanese_query(
                    query,
                    include_prices=False,
                    page_size=page_size,
                    request_type=request_type,
                )
                if japanese_only
                else _scrydex_run_cards_query(
                    query,
                    include_prices=False,
                    page_size=page_size,
                    request_type=request_type,
                )
            )
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
        for card in cards:
            card_id = str(card.get("id") or "").strip()
            if not card_id or card_id in seen:
                continue
            seen.add(card_id)
            results.append(card)
        if cards:
            break

    return ScrydexRawSearchResult(cards=results, attempts=attempts)


def search_remote_scrydex_raw_candidates(
    evidence: RawEvidence,
    signals: RawSignalScores,
    *,
    page_size: int = 10,
) -> ScrydexRawSearchResult:
    return _search_remote_scrydex_raw_candidates(
        evidence,
        signals,
        japanese_only=raw_evidence_looks_japanese(evidence),
        page_size=page_size,
    )


def search_remote_scrydex_japanese_raw_candidates(
    evidence: RawEvidence,
    signals: RawSignalScores,
    *,
    page_size: int = 10,
) -> ScrydexRawSearchResult:
    return _search_remote_scrydex_raw_candidates(
        evidence,
        signals,
        japanese_only=True,
        page_size=page_size,
    )


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
        candidate["_retrievalRoutes"] = ["remote_provider_scrydex_raw"]
        scored.append((retrieval_score, candidate))

    scored.sort(key=lambda item: (-item[0], item[1]["name"], item[1]["number"]))
    return [candidate for _, candidate in scored[:limit]]


def search_remote_scrydex_slab_candidates(
    *,
    title_text: str,
    label_text: str,
    parsed_label_text: list[str] | tuple[str, ...],
    card_number: str | None,
    set_hint_tokens: list[str] | tuple[str, ...],
    page_size: int = 10,
) -> ScrydexSlabSearchResult:
    title_source = title_text.strip()
    if not title_source and label_text.strip():
        title_source = label_text.strip()
    elif label_text.strip():
        title_source = f"{title_source} {label_text.strip()}".strip()
    if parsed_label_text:
        title_source = " ".join([title_source, *[str(text).strip() for text in parsed_label_text if str(text).strip()]]).strip()

    title_clauses = _scrydex_slab_title_clauses(title_text.strip() or title_source)
    expansion_scopes = _scrydex_expansion_scopes(set_hint_tokens)
    number_queries = _scrydex_slab_number_queries(card_number)
    combined_label_text = " ".join(
        part for part in [label_text.strip(), *[str(text).strip() for text in parsed_label_text if str(text).strip()]] if part
    ).upper()
    prefer_japanese = "JAPANESE" in combined_label_text or any(str(token or "").strip().lower().endswith("_ja") for token in set_hint_tokens)
    primary_title_clause = title_clauses[0] if title_clauses else None
    primary_number_query = number_queries[0] if number_queries else None
    primary_expansion_scope = expansion_scopes[0] if expansion_scopes else None

    def bounded_query_attempts() -> list[str]:
        attempts: list[str] = []
        seen_queries: set[str] = set()

        def add(query: str | None) -> None:
            cleaned = str(query or "").strip()
            if not cleaned or cleaned in seen_queries:
                return
            seen_queries.add(cleaned)
            attempts.append(cleaned)

        if primary_number_query:
            if prefer_japanese and primary_expansion_scope:
                add(f"{primary_number_query} {primary_expansion_scope}")
                add(primary_number_query)
                return attempts[:2]

            if primary_title_clause and primary_expansion_scope:
                add(f"{primary_title_clause} {primary_number_query} {primary_expansion_scope}")
                add(f"{primary_title_clause} {primary_number_query}")
                return attempts[:2]

            if primary_title_clause:
                add(f"{primary_title_clause} {primary_number_query}")
                return attempts[:1]

            if primary_expansion_scope:
                add(f"{primary_number_query} {primary_expansion_scope}")
                add(primary_number_query)
                return attempts[:2]

        if primary_title_clause and primary_expansion_scope:
            add(f"{primary_title_clause} {primary_expansion_scope}")
        add(primary_title_clause)
        return attempts[:2]

    query_attempts = bounded_query_attempts()

    seen: set[str] = set()
    results: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []

    query_runner = _scrydex_run_japanese_query if prefer_japanese else _scrydex_run_cards_query
    request_type = "slab_search_japanese" if prefer_japanese else "slab_search"

    for query in query_attempts:
        try:
            cards = query_runner(
                query,
                include_prices=False,
                page_size=page_size,
                request_type=request_type,
            )
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
        for card in cards:
            card_id = str(card.get("id") or "").strip()
            if not card_id or card_id in seen:
                continue
            seen.add(card_id)
            results.append(card)
        if results:
            break

    return ScrydexSlabSearchResult(cards=results, attempts=attempts)


def _normalize_variant_key(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _humanize_scrydex_variant_name(value: str) -> str:
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(value or "").strip())
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    return text.title()


def _scrydex_variant_hint_score(variant_name: str, variant_hints: dict[str, Any] | None) -> int:
    if not variant_hints:
        return 0

    score = 0
    normalized = _normalize_variant_key(variant_name)
    shadowless = bool(variant_hints.get("shadowless"))
    red_cheeks = bool(variant_hints.get("redCheeks"))
    yellow_cheeks = bool(variant_hints.get("yellowCheeks"))
    jumbo = bool(variant_hints.get("jumbo"))
    first_edition = variant_hints.get("firstEdition")

    if shadowless:
        score += 4 if "shadowless" in normalized else -4
    if first_edition is True:
        score += 4 if "firstedition" in normalized else -4
    elif first_edition is False:
        score += 2 if "firstedition" not in normalized else -3
    if red_cheeks:
        score += 5 if "redcheeks" in normalized else -5
    elif yellow_cheeks:
        score += 2 if "redcheeks" not in normalized else -5
    if not jumbo and "jumbo" in normalized:
        score -= 3

    return score


def _best_scrydex_graded_price(
    payload: dict[str, Any],
    *,
    grader: str,
    grade: str,
    preferred_variant: str | None = None,
    variant_hints: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]] | None:
    data = _scrydex_card_data(payload)
    variants = data.get("variants") if isinstance(data.get("variants"), list) else []
    target_company = grader.strip().upper()
    target_grade = grade.strip().upper()
    requested_variant_key = _normalize_variant_key(preferred_variant)
    ranked: list[tuple[tuple[int, int, int, int, int, int], str, dict[str, Any]]] = []
    for variant in variants:
        if not isinstance(variant, dict):
            continue
        variant_name = str(variant.get("name") or "graded")
        variant_key = _normalize_variant_key(variant_name)
        prices = variant.get("prices") if isinstance(variant.get("prices"), list) else []
        for price in prices:
            if not isinstance(price, dict):
                continue
            if str(price.get("type") or "").lower() != "graded":
                continue
            if str(price.get("company") or "").strip().upper() != target_company:
                continue
            if str(price.get("grade") or "").strip().upper() != target_grade:
                continue
            has_market = 1 if isinstance(price.get("market"), (int, float)) else 0
            plain_grade = 1 if not bool(price.get("is_signed")) and not bool(price.get("is_error")) and not bool(price.get("is_perfect")) else 0
            has_currency = 1 if price.get("currency") else 0
            has_mid = 1 if isinstance(price.get("mid"), (int, float)) else 0
            exact_variant_match = 1 if requested_variant_key and variant_key == requested_variant_key else 0
            variant_hint_score = _scrydex_variant_hint_score(variant_name, variant_hints)
            ranked.append(((exact_variant_match, variant_hint_score, has_market, plain_grade, has_currency, has_mid), variant_name, price))
    if not ranked:
        return None
    ranked.sort(key=lambda item: item[0], reverse=True)
    _, variant_name, price = ranked[0]
    return variant_name, price


def persist_scrydex_psa_snapshot(
    connection,
    *,
    card_id: str,
    payload: dict[str, Any],
    grader: str,
    grade: str,
    preferred_variant: str | None = None,
    variant_hints: dict[str, Any] | None = None,
    commit: bool = True,
) -> dict[str, Any] | None:
    selected = _best_scrydex_graded_price(
        payload,
        grader=grader,
        grade=grade,
        preferred_variant=preferred_variant,
        variant_hints=variant_hints,
    )
    if selected is None:
        return None

    variant_name, price = selected
    display_variant = _humanize_scrydex_variant_name(variant_name) or variant_name
    source_url = scrydex_request_url(f"/pokemon/v1/cards/{card_id}", include="prices")
    upsert_slab_price_snapshot(
        connection,
        card_id=card_id,
        grader=grader,
        grade=grade,
        variant=display_variant,
        pricing_tier="scrydex_exact_grade",
        currency_code=str(price.get("currency") or "USD"),
        low_price=price.get("low"),
        market_price=price.get("market"),
        mid_price=price.get("mid"),
        high_price=price.get("high"),
        last_sale_price=None,
        last_sale_date=None,
        comp_count=0,
        recent_comp_count=0,
        confidence_level=4,
        confidence_label="High",
        bucket_key=None,
        source_url=source_url,
        source=SCRYDEX_PROVIDER,
        summary=f"Scrydex exact {grader} {grade} {display_variant} market snapshot.",
        payload={
            "provider": SCRYDEX_PROVIDER,
            "priceSource": SCRYDEX_PROVIDER,
            "variant": display_variant,
            "variantKey": variant_name,
            "company": price.get("company"),
            "grade": price.get("grade"),
            "isSigned": bool(price.get("is_signed")),
            "isPerfect": bool(price.get("is_perfect")),
            "isError": bool(price.get("is_error")),
            "cardName": _scrydex_card_data(payload).get("name"),
            "setName": ((_scrydex_card_data(payload).get("expansion") or {}).get("name")),
        },
    )
    if commit:
        connection.commit()
    return _scrydex_card_data(payload)


def persist_scrydex_all_graded_snapshots(
    connection,
    *,
    card_id: str,
    payload: dict[str, Any],
    commit: bool = True,
) -> int:
    data = _scrydex_card_data(payload)
    variants = data.get("variants") if isinstance(data.get("variants"), list) else []
    source_url = scrydex_request_url(f"/pokemon/v1/cards/{card_id}", include="prices")
    persisted_keys: set[tuple[str, str, str]] = set()
    persisted_count = 0

    for variant in variants:
        if not isinstance(variant, dict):
            continue
        variant_name = str(variant.get("name") or "graded")
        display_variant = _humanize_scrydex_variant_name(variant_name) or variant_name
        prices = variant.get("prices") if isinstance(variant.get("prices"), list) else []
        for price in prices:
            if not isinstance(price, dict):
                continue
            if str(price.get("type") or "").lower() != "graded":
                continue
            grader = str(price.get("company") or "").strip().upper()
            grade = str(price.get("grade") or "").strip().upper()
            if not grader or not grade:
                continue
            if not any(isinstance(price.get(field), (int, float)) for field in ("low", "market", "mid", "high")):
                continue

            qualifiers: list[str] = []
            if bool(price.get("is_signed")):
                qualifiers.append("Signed")
            if bool(price.get("is_error")):
                qualifiers.append("Error")
            if bool(price.get("is_perfect")):
                qualifiers.append("Perfect")
            variant_label = display_variant
            if qualifiers:
                variant_label = f"{display_variant} ({', '.join(qualifiers)})"

            dedupe_key = (grader, grade, variant_label)
            if dedupe_key in persisted_keys:
                continue
            persisted_keys.add(dedupe_key)

            upsert_slab_price_snapshot(
                connection,
                card_id=card_id,
                grader=grader,
                grade=grade,
                variant=variant_label,
                pricing_tier="scrydex_full_sync",
                currency_code=str(price.get("currency") or "USD"),
                low_price=price.get("low"),
                market_price=price.get("market"),
                mid_price=price.get("mid"),
                high_price=price.get("high"),
                last_sale_price=None,
                last_sale_date=None,
                comp_count=0,
                recent_comp_count=0,
                confidence_level=4,
                confidence_label="High",
                bucket_key=None,
                source_url=source_url,
                source=SCRYDEX_PROVIDER,
                summary=f"Scrydex full-sync {grader} {grade} {variant_label} snapshot.",
                payload={
                    "provider": SCRYDEX_PROVIDER,
                    "priceSource": SCRYDEX_PROVIDER,
                    "variant": variant_label,
                    "variantKey": variant_name,
                    "company": price.get("company"),
                    "grade": price.get("grade"),
                    "isSigned": bool(price.get("is_signed")),
                    "isPerfect": bool(price.get("is_perfect")),
                    "isError": bool(price.get("is_error")),
                    "cardName": data.get("name"),
                    "setName": ((data.get("expansion") or {}).get("name") if isinstance(data.get("expansion"), dict) else None),
                },
            )
            persisted_count += 1

    if commit:
        connection.commit()
    return persisted_count


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
            payload = fetch_scrydex_card_by_id(card_id, include_prices=True, request_type="raw_fetch_by_id")
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

    def refresh_psa_pricing(
        self,
        connection,
        card_id: str,
        grader: str,
        grade: str,
        preferred_variant: str | None = None,
        variant_hints: dict[str, Any] | None = None,
    ) -> PsaPricingResult:
        try:
            payload = fetch_scrydex_card_by_id(card_id, include_prices=True, request_type="psa_fetch_by_id")
        except Exception as exc:
            return PsaPricingResult(
                success=False,
                provider_id=SCRYDEX_PROVIDER,
                card_id=card_id,
                grader=grader,
                grade=grade,
                error=str(exc),
            )

        persisted = persist_scrydex_psa_snapshot(
            connection,
            card_id=card_id,
            payload=payload,
            grader=grader,
            grade=grade,
            preferred_variant=preferred_variant,
            variant_hints=variant_hints,
        )
        if persisted is None:
            return PsaPricingResult(
                success=False,
                provider_id=SCRYDEX_PROVIDER,
                card_id=card_id,
                grader=grader,
                grade=grade,
                error="No graded pricing available from Scrydex for that grader and grade",
            )

        return PsaPricingResult(
            success=True,
            provider_id=SCRYDEX_PROVIDER,
            card_id=card_id,
            grader=grader,
            grade=grade,
            payload=payload,
        )
