from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from catalog_tools import (
    RAW_ROUTE_BROAD_TEXT_FALLBACK,
    RAW_ROUTE_COLLECTOR_ONLY,
    RAW_ROUTE_COLLECTOR_SET_EXACT,
    RAW_ROUTE_TITLE_COLLECTOR,
    RAW_ROUTE_TITLE_ONLY,
    RAW_ROUTE_TITLE_SET_PRIMARY,
    RawEvidence,
    RawSignalScores,
    build_raw_retrieval_plan,
    canonicalize_collector_number,
    tokenize,
    utc_now,
)

API_BASE_URL = "https://api.pokemontcg.io/v2/cards"
USER_AGENT = "SpotlightScanner/0.1 (+https://local.spotlight.app)"
DEFAULT_FIELDS = [
    "id",
    "name",
    "supertype",
    "subtypes",
    "types",
    "number",
    "artist",
    "rarity",
    "nationalPokedexNumbers",
    "regulationMark",
    "rules",
    "images",
    "set",
    "tcgplayer",
    "cardmarket",
]
DEFAULT_REQUEST_TIMEOUT_SECONDS = 5
DEFAULT_ORDER_BY = "set.releaseDate,name,number"
TITLE_QUERY_STOPWORDS = {
    "basic",
    "card",
    "evolves",
    "from",
    "pokemon",
    "resistance",
    "retreat",
    "stage",
    "supporter",
    "trainer",
    "weakness",
}


@dataclass(frozen=True)
class RemoteRawSearchResult:
    cards: list[dict[str, Any]]
    attempts: list[dict[str, Any]]


def api_request(
    url: str,
    api_key: str | None,
    *,
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    request = Request(url)
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", USER_AGENT)
    if api_key:
        request.add_header("X-Api-Key", api_key)

    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def build_search_cards_url(query: str, page_size: int, order_by: str, page: int = 1) -> str:
    query_string = urlencode(
        {
            "page": page,
            "pageSize": page_size,
            "q": query,
            "orderBy": order_by,
            "select": ",".join(DEFAULT_FIELDS),
        }
    )
    return f"{API_BASE_URL}?{query_string}"


def build_card_url(card_id: str, fields: list[str] | None = None) -> str:
    query_string = urlencode({"select": ",".join(fields or DEFAULT_FIELDS)}) if fields else ""
    base = f"{API_BASE_URL}/{card_id}"
    return f"{base}?{query_string}" if query_string else base


def fetch_card_by_id(
    card_id: str,
    api_key: str | None,
    *,
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    payload = api_request(build_card_url(card_id), api_key, timeout=timeout)
    card = payload.get("data")
    if not isinstance(card, dict):
        raise ValueError(f"Card {card_id} was not returned by the Pokemon TCG API")
    return card


def search_cards(
    query: str,
    api_key: str | None,
    *,
    page_size: int = 10,
    order_by: str = DEFAULT_ORDER_BY,
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> list[dict[str, Any]]:
    payload = api_request(
        build_search_cards_url(query, page_size=page_size, order_by=order_by),
        api_key,
        timeout=timeout,
    )
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def map_card(card: dict[str, Any], local_image_path: Path | None) -> dict[str, Any]:
    set_info = card.get("set") or {}
    images = card.get("images") or {}
    raw_number = str(card["number"])
    printed_total = set_info.get("printedTotal")
    set_name = set_info.get("name") or "Unknown Set"
    set_series = set_info.get("series")
    is_promo_set = "promo" in f"{set_name} {set_series or ''}".lower()
    resolved_number = raw_number

    if printed_total and "/" not in raw_number and not is_promo_set:
        resolved_number = f"{raw_number}/{printed_total}"

    return {
        "id": card["id"],
        "name": card["name"],
        "set_name": set_name,
        "number": resolved_number,
        "rarity": card.get("rarity") or "Unknown",
        "variant": "Raw",
        "language": "English",
        "reference_image_path": str(local_image_path) if local_image_path else None,
        "reference_image_url": images.get("large") or images.get("small"),
        "reference_image_small_url": images.get("small"),
        "source": "pokemontcg_api",
        "source_record_id": card["id"],
        "set_id": set_info.get("id"),
        "set_series": set_info.get("series"),
        "set_ptcgo_code": set_info.get("ptcgoCode"),
        "set_release_date": set_info.get("releaseDate"),
        "supertype": card.get("supertype"),
        "subtypes": card.get("subtypes") or [],
        "types": card.get("types") or [],
        "artist": card.get("artist"),
        "regulation_mark": card.get("regulationMark"),
        "national_pokedex_numbers": card.get("nationalPokedexNumbers") or [],
        "tcgplayer": card.get("tcgplayer") or {},
        "cardmarket": card.get("cardmarket") or {},
        "source_payload": card,
        "imported_at": utc_now(),
    }


def _quote_query_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _raw_title_query_text(evidence: RawEvidence) -> str:
    return evidence.title_text_primary or evidence.title_text_secondary or ""


def _raw_title_query_terms(evidence: RawEvidence) -> list[str]:
    title_text = _raw_title_query_text(evidence)
    if not title_text:
        return []
    terms: list[str] = []
    seen: set[str] = set()
    for token in tokenize(title_text):
        if not token or token in TITLE_QUERY_STOPWORDS or token in seen:
            continue
        seen.add(token)
        terms.append(token)
    return terms


def _raw_title_query_clauses(evidence: RawEvidence) -> list[str]:
    title_text = _raw_title_query_text(evidence)
    terms = _raw_title_query_terms(evidence)
    clauses: list[str] = []
    seen: set[str] = set()

    def add(clause: str) -> None:
        normalized = clause.strip()
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        clauses.append(normalized)

    if title_text:
        add(f'name:"{_quote_query_value(title_text)}"')

    if len(terms) >= 2:
        add(" ".join(f'name:{term}' for term in [terms[0], terms[-1]]))
        add(" ".join(f'name:{term}' for term in terms[: min(3, len(terms))]))
        add(" ".join(f'name:{term}' for term in terms[-min(3, len(terms)) :]))
    elif len(terms) == 1:
        add(f'name:{terms[0]}')

    return clauses


def _raw_set_query_tokens(evidence: RawEvidence) -> list[str]:
    tokens = list(evidence.trusted_set_hint_tokens or evidence.set_hint_tokens)
    return [token for token in tokens if token]


def build_raw_provider_queries(evidence: RawEvidence, signals: RawSignalScores) -> list[str]:
    plan = build_raw_retrieval_plan(evidence, signals)
    queries: list[str] = []
    seen: set[str] = set()
    title_clauses = _raw_title_query_clauses(evidence)
    set_tokens = _raw_set_query_tokens(evidence)
    query_values = list(evidence.collector_number_query_values)

    def add(query: str) -> None:
        normalized = query.strip()
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        queries.append(normalized)

    for route in plan.routes:
        if route == RAW_ROUTE_COLLECTOR_SET_EXACT:
            for number in query_values:
                add(f'number:"{number.upper()}"')
                if evidence.collector_number_printed_total is not None:
                    add(f'set.printedTotal:{evidence.collector_number_printed_total} number:"{number.upper()}"')
                for set_token in set_tokens:
                    add(f'set.ptcgoCode:{set_token.upper()} number:"{number.upper()}"')
                    add(f'set.id:{set_token.lower()} number:"{number.lower()}"')
                    add(f'set.name:"{_quote_query_value(set_token)}" number:"{number.upper()}"')

        elif route == RAW_ROUTE_TITLE_SET_PRIMARY and title_clauses:
            for clause in title_clauses:
                add(clause)
                for set_token in set_tokens:
                    add(f'{clause} set.ptcgoCode:{set_token.upper()}')
                    add(f'{clause} set.id:{set_token.lower()}')
                    add(f'{clause} set.name:"{_quote_query_value(set_token)}"')

        elif route == RAW_ROUTE_TITLE_COLLECTOR and title_clauses:
            for number in query_values:
                for clause in title_clauses:
                    add(f'{clause} number:"{number.upper()}"')
                    if evidence.collector_number_printed_total is not None:
                        add(f'{clause} number:"{number.upper()}" set.printedTotal:{evidence.collector_number_printed_total}')

        elif route == RAW_ROUTE_TITLE_ONLY and title_clauses:
            for clause in title_clauses:
                add(clause)

        elif route == RAW_ROUTE_COLLECTOR_ONLY:
            for number in query_values:
                add(f'number:"{number.upper()}"')
                if evidence.collector_number_printed_total is not None:
                    add(f'number:"{number.upper()}" set.printedTotal:{evidence.collector_number_printed_total}')

        elif route == RAW_ROUTE_BROAD_TEXT_FALLBACK:
            fallback_tokens = [token for token in evidence.recognized_tokens if token.isalpha() and len(token) > 2][:3]
            if title_clauses:
                for clause in title_clauses:
                    add(clause)
            elif fallback_tokens:
                add(" ".join(f'name:"{_quote_query_value(token)}"' for token in fallback_tokens[:2]))

    return queries


def search_remote_raw_candidates(
    queries: list[str],
    api_key: str | None,
    page_size: int = 10,
) -> RemoteRawSearchResult:
    seen: set[str] = set()
    results: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []
    for query in queries:
        try:
            cards = search_cards(query, api_key, page_size=page_size)
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
    return RemoteRawSearchResult(cards=results, attempts=attempts)


def _remote_title_overlap(candidate: dict[str, Any], evidence: RawEvidence) -> float:
    query_tokens = {
        token
        for token in tokenize(" ".join(part for part in [evidence.title_text_primary, evidence.title_text_secondary] if part))
        if token
    }
    if not query_tokens:
        return 0.0
    candidate_tokens = set(tokenize(str(candidate.get("name") or "")))
    overlap = len(query_tokens & candidate_tokens)
    return overlap / max(1, len(query_tokens))


def _remote_set_overlap(candidate: dict[str, Any], evidence: RawEvidence) -> float:
    query_tokens = set(_raw_set_query_tokens(evidence))
    if not query_tokens:
        return 0.0
    candidate_tokens = set(
        tokenize(
            " ".join(
                part
                for part in [
                    str(candidate.get("set_name") or ""),
                    str(candidate.get("set_series") or ""),
                    str(candidate.get("set_id") or ""),
                    str(candidate.get("set_ptcgo_code") or ""),
                ]
                if part
            )
        )
    )
    overlap = len(query_tokens & candidate_tokens)
    if any(
        token in {
            str(candidate.get("set_id") or "").lower(),
            str(candidate.get("set_ptcgo_code") or "").lower(),
        }
        for token in query_tokens
    ):
        overlap += 1
    return overlap / max(1, len(query_tokens))


def _remote_collector_overlap(candidate: dict[str, Any], evidence: RawEvidence) -> float:
    candidate_number = canonicalize_collector_number(str(candidate.get("number") or "")).lower()
    if evidence.collector_number_exact:
        expected = canonicalize_collector_number(evidence.collector_number_exact).lower()
        if candidate_number == expected:
            return 1.0
    if evidence.collector_number_partial:
        expected = canonicalize_collector_number(evidence.collector_number_partial).lower()
        if candidate_number == expected:
            return 0.75
    if any(value and value in candidate_number for value in evidence.collector_number_query_values):
        return 0.5
    return 0.0


def _normalized_remote_candidate(mapped: dict[str, Any]) -> dict[str, Any]:
    return {
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


def best_remote_raw_candidates(
    results: list[dict[str, Any]],
    evidence: RawEvidence,
    signals: RawSignalScores,
    limit: int = 12,
) -> list[dict[str, Any]]:
    scored: list[tuple[float, dict[str, Any]]] = []
    for raw_card in results:
        mapped = map_card(raw_card, None)
        title_score = _remote_title_overlap(mapped, evidence)
        set_score = _remote_set_overlap(mapped, evidence)
        collector_score = _remote_collector_overlap(mapped, evidence)

        if not any(score > 0.0 for score in (title_score, set_score, collector_score)):
            continue

        retrieval_score = round(
            (title_score * min(35.0, float(signals.title_signal) * 0.35))
            + (set_score * min(20.0, float(signals.set_signal) * 0.25))
            + (collector_score * min(15.0, float(signals.collector_signal) * 0.18))
            + 5.0,
            4,
        )
        candidate = _normalized_remote_candidate(mapped)
        candidate["_cachePresence"] = False
        candidate["_retrievalScoreHint"] = retrieval_score
        candidate["_retrievalRoutes"] = ["remote_provider"]
        scored.append((retrieval_score, candidate))

    scored.sort(key=lambda item: (-item[0], item[1]["name"], item[1]["number"]))
    return [candidate for _, candidate in scored[:limit]]
