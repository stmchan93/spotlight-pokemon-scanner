from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable


MATCHER_VERSION = "raw-backend-reset-v1"
RAW_PRICING_MODE = "raw"
PSA_GRADE_PRICING_MODE = "graded"

RAW_ROUTE_COLLECTOR_SET_EXACT = "collector_set_exact"
RAW_ROUTE_TITLE_SET_PRIMARY = "title_set_primary"
RAW_ROUTE_TITLE_COLLECTOR = "title_collector"
RAW_ROUTE_TITLE_ONLY = "title_only"
RAW_ROUTE_COLLECTOR_ONLY = "collector_only"
RAW_ROUTE_BROAD_TEXT_FALLBACK = "broad_text_fallback"


@dataclass(frozen=True)
class IndexedCard:
    id: str
    name: str
    set_name: str
    number: str
    rarity: str
    variant: str
    language: str
    set_id: str | None
    set_ptcgo_code: str | None


@dataclass(frozen=True)
class CatalogIndex:
    cards: tuple[IndexedCard, ...]

    def __len__(self) -> int:
        return len(self.cards)


@dataclass(frozen=True)
class RawEvidence:
    title_text_primary: str
    title_text_secondary: str
    recognized_text: str
    footer_band_text: str
    bottom_left_text: str
    bottom_right_text: str
    collector_number_exact: str | None
    collector_number_partial: str | None
    collector_number_query_values: tuple[str, ...]
    collector_number_printed_total: int | None
    set_hint_tokens: tuple[str, ...]
    trusted_set_hint_tokens: tuple[str, ...]
    promo_code_hint: str | None
    recognized_tokens: tuple[str, ...]
    crop_confidence: float


@dataclass(frozen=True)
class RawSignalScores:
    title_signal: int
    collector_signal: int
    set_signal: int
    footer_signal: int
    overall_signal: int


@dataclass(frozen=True)
class RawRetrievalPlan:
    routes: tuple[str, ...]
    should_query_remote: bool


@dataclass(frozen=True)
class RawCandidateScoreBreakdown:
    title_overlap_score: float
    set_overlap_score: float
    collector_exact_score: float
    collector_partial_score: float
    collector_denominator_score: float
    footer_text_support_score: float
    promo_support_score: float
    cache_presence_score: float
    contradiction_penalty: float
    retrieval_total: float
    resolution_total: float
    final_total: float


@dataclass(frozen=True)
class RawCandidateMatch:
    card: dict[str, Any]
    retrieval_score: float
    resolution_score: float
    final_total: float
    breakdown: RawCandidateScoreBreakdown
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class RawDecisionResult:
    matches: tuple[RawCandidateMatch, ...]
    top_candidates: tuple[RawCandidateMatch, ...]
    confidence: str
    confidence_percent: float
    ambiguity_flags: tuple[str, ...]
    resolver_path: str
    review_disposition: str
    review_reason: str | None
    fallback_reason: str | None
    selected_card_id: str | None
    debug_payload: dict[str, Any]


def _raw_same_exact_number_ambiguity(
    matches: list[RawCandidateMatch],
    evidence: RawEvidence,
) -> dict[str, Any] | None:
    if not evidence.collector_number_exact:
        return None

    expected = canonicalize_collector_number(evidence.collector_number_exact)
    exact_matches = [
        match for match in matches
        if canonicalize_collector_number(str(match.card.get("number") or "")) == expected
    ]
    if len(exact_matches) < 2:
        return None

    disambiguated = any(
        match.breakdown.title_overlap_score > 0.0 or match.breakdown.set_overlap_score > 0.0
        for match in exact_matches
    )
    if disambiguated:
        return None

    return {
        "kind": "same_exact_number_without_disambiguator",
        "collectorNumber": evidence.collector_number_exact,
        "candidateIDs": [str(match.card.get("id") or "") for match in exact_matches[:5]],
        "candidateNames": [str(match.card.get("name") or "") for match in exact_matches[:5]],
    }


def _raw_minimal_signal_ambiguity(
    matches: list[RawCandidateMatch],
    evidence: RawEvidence,
    signals: RawSignalScores,
) -> dict[str, Any] | None:
    if not matches:
        return None

    top_match = matches[0]
    runner_up_score = matches[1].final_total if len(matches) > 1 else top_match.final_total
    has_semantic_evidence = any([
        bool(evidence.collector_number_exact),
        bool(evidence.collector_number_partial),
        bool(evidence.trusted_set_hint_tokens),
        any(match.breakdown.title_overlap_score > 0.0 for match in matches[:3]),
    ])
    if has_semantic_evidence:
        return None
    if top_match.final_total > 0.0:
        return None
    if abs(top_match.final_total - runner_up_score) > 0.001:
        return None
    if signals.overall_signal > 35:
        return None

    return {
        "kind": "arbitrary_best_guess_minimal_signal",
        "collectorNumber": evidence.collector_number_exact,
        "candidateIDs": [str(match.card.get("id") or "") for match in matches[:3]],
        "candidateNames": [str(match.card.get("name") or "") for match in matches[:3]],
    }


def _raw_has_no_readable_signal(evidence: RawEvidence, signals: RawSignalScores) -> bool:
    if any([
        bool(evidence.title_text_primary.strip()),
        bool(evidence.title_text_secondary.strip()),
        bool(evidence.footer_band_text.strip()),
        bool(evidence.bottom_left_text.strip()),
        bool(evidence.bottom_right_text.strip()),
        bool(evidence.collector_number_exact),
        bool(evidence.collector_number_partial),
        bool(evidence.trusted_set_hint_tokens),
        bool(evidence.recognized_tokens),
    ]):
        return False
    return signals.overall_signal <= 0


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def connect(database_path: Path | str) -> sqlite3.Connection:
    connection = sqlite3.connect(str(database_path))
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _table_columns(connection: sqlite3.Connection, table_name: str) -> set[str]:
    rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {str(row["name"]) for row in rows}


def _runtime_schema_is_compatible(connection: sqlite3.Connection) -> bool:
    required_cards_columns = {
        "id",
        "name",
        "set_name",
        "number",
        "rarity",
        "variant",
        "language",
        "source_provider",
        "source_record_id",
        "set_id",
        "set_series",
        "set_ptcgo_code",
        "set_release_date",
        "supertype",
        "subtypes_json",
        "types_json",
        "artist",
        "regulation_mark",
        "national_pokedex_numbers_json",
        "image_url",
        "image_small_url",
        "source_payload_json",
        "created_at",
        "updated_at",
    }
    required_snapshot_columns = {
        "id",
        "card_id",
        "pricing_mode",
        "provider",
        "grader",
        "grade",
        "variant",
        "currency_code",
        "low_price",
        "market_price",
        "mid_price",
        "high_price",
        "direct_low_price",
        "trend_price",
        "source_url",
        "source_updated_at",
        "source_payload_json",
        "updated_at",
    }
    required_scan_columns = {
        "scan_id",
        "created_at",
        "resolver_mode",
        "resolver_path",
        "request_json",
        "response_json",
        "matcher_source",
        "matcher_version",
        "selected_card_id",
        "confidence",
        "review_disposition",
        "correction_type",
        "completed_at",
    }

    tables = {
        str(row["name"])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }

    if not tables:
        return True

    if "cards" not in tables:
        return False

    cards_columns = _table_columns(connection, "cards")
    if not required_cards_columns.issubset(cards_columns):
        return False

    if "card_price_snapshots" in tables:
        snapshot_columns = _table_columns(connection, "card_price_snapshots")
        if not required_snapshot_columns.issubset(snapshot_columns):
            return False

    if "scan_events" in tables:
        scan_columns = _table_columns(connection, "scan_events")
        if not required_scan_columns.issubset(scan_columns):
            return False

    return True


def _reset_runtime_schema(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA foreign_keys = OFF")
    table_rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    index_rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()

    for row in index_rows:
        connection.execute(f'DROP INDEX IF EXISTS "{row["name"]}"')
    for row in table_rows:
        connection.execute(f'DROP TABLE IF EXISTS "{row["name"]}"')

    connection.execute("PRAGMA foreign_keys = ON")
    connection.commit()


def apply_schema(connection: sqlite3.Connection, schema_path: Path) -> None:
    if not _runtime_schema_is_compatible(connection):
        _reset_runtime_schema(connection)
    connection.executescript(schema_path.read_text())
    connection.commit()


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def _json_load(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def canonicalize_collector_number(value: str) -> str:
    normalized = value.strip().replace(" ", "").replace("\\", "/").replace("／", "/")
    normalized = normalized.replace("#", "")
    return normalized.lower()


def _collector_components(value: str | None) -> tuple[str | None, int | None]:
    if not value:
        return None, None
    normalized = canonicalize_collector_number(value)
    match = re.fullmatch(r"([a-z]*\d+)(?:/(\d+))?", normalized)
    if not match:
        return normalized or None, None
    query_value = match.group(1)
    printed_total = int(match.group(2)) if match.group(2) else None
    return query_value, printed_total


def _collector_hint_from_text(*values: str) -> str | None:
    for value in values:
        match = re.search(r"\b([a-z]*\d+(?:/\d+)?)\b", value, flags=re.IGNORECASE)
        if match:
            return canonicalize_collector_number(match.group(1))
    return None


def _normalized_set_tokens(tokens: Iterable[str]) -> tuple[str, ...]:
    normalized = []
    seen: set[str] = set()
    for token in tokens:
        cleaned = token.strip().lower()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        normalized.append(cleaned)
    return tuple(normalized)


def _payload_raw_evidence(payload: dict[str, Any]) -> dict[str, Any]:
    ocr_analysis = payload.get("ocrAnalysis") or {}
    if not isinstance(ocr_analysis, dict):
        return {}
    raw_evidence = ocr_analysis.get("rawEvidence") or {}
    return raw_evidence if isinstance(raw_evidence, dict) else {}


def _recognized_token_texts(payload: dict[str, Any]) -> tuple[str, ...]:
    normalized: list[str] = []
    for token in payload.get("recognizedTokens") or []:
        text = ""
        if isinstance(token, str):
            text = token
        elif isinstance(token, dict):
            text = str(token.get("text") or "")
        cleaned = text.strip().lower()
        if cleaned:
            normalized.append(cleaned)
    return tuple(normalized)


def build_raw_evidence(payload: dict[str, Any]) -> RawEvidence:
    raw_evidence = _payload_raw_evidence(payload)
    title_primary = str(raw_evidence.get("titleTextPrimary") or "").strip()
    title_secondary = str(raw_evidence.get("titleTextSecondary") or "").strip()
    whole_card_text = str(raw_evidence.get("wholeCardText") or "").strip()
    footer_band_text = str(raw_evidence.get("footerBandText") or "").strip()
    collector_number_exact = (
        str(raw_evidence.get("collectorNumberExact") or "").strip()
        or str(payload.get("collectorNumber") or "").strip()
        or None
    )
    collector_number_partial = (
        str(raw_evidence.get("collectorNumberPartial") or "").strip()
        or None
    )
    if not collector_number_exact and not collector_number_partial:
        collector_number_partial = _collector_hint_from_text(footer_band_text, whole_card_text)
    query_value, printed_total = _collector_components(collector_number_exact or collector_number_partial)
    query_values = (query_value,) if query_value else ()
    set_hint_tokens = _normalized_set_tokens(raw_evidence.get("setHints") or payload.get("setHintTokens") or [])
    trusted_set_hint_tokens = _normalized_set_tokens(payload.get("trustedSetHints") or set_hint_tokens)
    promo_code_hint = str(payload.get("promoCodeHint") or "").strip() or None
    recognized_tokens = _recognized_token_texts(payload)
    recognized_text = " ".join(part for part in [whole_card_text, footer_band_text] if part).strip()
    return RawEvidence(
        title_text_primary=title_primary,
        title_text_secondary=title_secondary,
        recognized_text=recognized_text,
        footer_band_text=footer_band_text,
        bottom_left_text="",
        bottom_right_text="",
        collector_number_exact=collector_number_exact,
        collector_number_partial=collector_number_partial,
        collector_number_query_values=query_values,
        collector_number_printed_total=printed_total,
        set_hint_tokens=set_hint_tokens,
        trusted_set_hint_tokens=trusted_set_hint_tokens,
        promo_code_hint=promo_code_hint,
        recognized_tokens=recognized_tokens,
        crop_confidence=float(payload.get("cropConfidence") or 0.0),
    )


def score_raw_signals(evidence: RawEvidence) -> RawSignalScores:
    title_tokens = tokenize(" ".join(filter(None, [evidence.title_text_primary, evidence.title_text_secondary])))
    generic_title_tokens = {"pokemon", "card", "glare"}
    title_signal = 0
    if title_tokens:
        non_generic = [token for token in title_tokens if token not in generic_title_tokens]
        title_signal = 80 if non_generic else 35
        if len(non_generic) >= 3:
            title_signal = 88

    if evidence.collector_number_exact:
        collector_signal = 95
    elif evidence.collector_number_partial:
        collector_signal = 60
    else:
        collector_signal = 0

    if evidence.trusted_set_hint_tokens:
        set_signal = 75
    elif evidence.set_hint_tokens:
        set_signal = 65
    else:
        set_signal = 0

    if evidence.collector_number_exact and evidence.footer_band_text:
        footer_signal = 85
    elif evidence.collector_number_partial and evidence.footer_band_text:
        footer_signal = 65
    elif evidence.footer_band_text:
        footer_signal = 40
    else:
        footer_signal = 0

    overall_signal = int(
        min(
            100,
            round(
                (title_signal * 0.35)
                + (collector_signal * 0.35)
                + (set_signal * 0.20)
                + (footer_signal * 0.10)
            ),
        )
    )

    return RawSignalScores(
        title_signal=title_signal,
        collector_signal=collector_signal,
        set_signal=set_signal,
        footer_signal=footer_signal,
        overall_signal=overall_signal,
    )


def build_raw_retrieval_plan(evidence: RawEvidence, signals: RawSignalScores) -> RawRetrievalPlan:
    routes: list[str] = []
    if signals.collector_signal >= 80 and signals.set_signal >= 55:
        routes.append(RAW_ROUTE_COLLECTOR_SET_EXACT)
    if signals.title_signal >= 65 and signals.set_signal >= 45:
        routes.append(RAW_ROUTE_TITLE_SET_PRIMARY)
    if signals.title_signal >= 65 and signals.collector_signal >= 45:
        routes.append(RAW_ROUTE_TITLE_COLLECTOR)
    if signals.title_signal >= 70:
        routes.append(RAW_ROUTE_TITLE_ONLY)
    if signals.collector_signal >= 70:
        routes.append(RAW_ROUTE_COLLECTOR_ONLY)
    if not routes and (evidence.recognized_text or evidence.recognized_tokens):
        routes.append(RAW_ROUTE_BROAD_TEXT_FALLBACK)
    should_query_remote = bool(routes) and (
        RAW_ROUTE_BROAD_TEXT_FALLBACK in routes
        or signals.title_signal >= 65
        or signals.collector_signal >= 70
    )
    return RawRetrievalPlan(routes=tuple(routes), should_query_remote=should_query_remote)


def _card_row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "setName": row["set_name"],
        "number": row["number"],
        "rarity": row["rarity"],
        "variant": row["variant"],
        "language": row["language"],
        "sourceProvider": row["source_provider"],
        "sourceRecordID": row["source_record_id"],
        "setID": row["set_id"],
        "setSeries": row["set_series"],
        "setPtcgoCode": row["set_ptcgo_code"],
        "setReleaseDate": row["set_release_date"],
        "supertype": row["supertype"],
        "subtypes": _json_load(row["subtypes_json"], []),
        "types": _json_load(row["types_json"], []),
        "artist": row["artist"],
        "regulationMark": row["regulation_mark"],
        "nationalPokedexNumbers": _json_load(row["national_pokedex_numbers_json"], []),
        "imageURL": row["image_url"],
        "imageSmallURL": row["image_small_url"],
        "sourcePayload": _json_load(row["source_payload_json"], {}),
    }


def upsert_card(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    name: str,
    set_name: str,
    number: str,
    rarity: str,
    variant: str,
    language: str,
    source_provider: str | None = None,
    source_record_id: str | None = None,
    set_id: str | None = None,
    set_series: str | None = None,
    set_ptcgo_code: str | None = None,
    set_release_date: str | None = None,
    supertype: str | None = None,
    subtypes: list[str] | None = None,
    types: list[str] | None = None,
    artist: str | None = None,
    regulation_mark: str | None = None,
    national_pokedex_numbers: list[int] | None = None,
    image_url: str | None = None,
    image_small_url: str | None = None,
    source_payload: dict[str, Any] | None = None,
) -> None:
    now = utc_now()
    connection.execute(
        """
        INSERT INTO cards (
            id, name, set_name, number, rarity, variant, language,
            source_provider, source_record_id, set_id, set_series, set_ptcgo_code, set_release_date,
            supertype, subtypes_json, types_json, artist, regulation_mark,
            national_pokedex_numbers_json, image_url, image_small_url, source_payload_json,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            set_name=excluded.set_name,
            number=excluded.number,
            rarity=excluded.rarity,
            variant=excluded.variant,
            language=excluded.language,
            source_provider=excluded.source_provider,
            source_record_id=excluded.source_record_id,
            set_id=excluded.set_id,
            set_series=excluded.set_series,
            set_ptcgo_code=excluded.set_ptcgo_code,
            set_release_date=excluded.set_release_date,
            supertype=excluded.supertype,
            subtypes_json=excluded.subtypes_json,
            types_json=excluded.types_json,
            artist=excluded.artist,
            regulation_mark=excluded.regulation_mark,
            national_pokedex_numbers_json=excluded.national_pokedex_numbers_json,
            image_url=excluded.image_url,
            image_small_url=excluded.image_small_url,
            source_payload_json=excluded.source_payload_json,
            updated_at=excluded.updated_at
        """,
        (
            card_id,
            name,
            set_name,
            number,
            rarity,
            variant,
            language,
            source_provider,
            source_record_id,
            set_id,
            set_series,
            set_ptcgo_code,
            set_release_date,
            supertype,
            json.dumps(subtypes or []),
            json.dumps(types or []),
            artist,
            regulation_mark,
            json.dumps(national_pokedex_numbers or []),
            image_url,
            image_small_url,
            json.dumps(source_payload or {}),
            now,
            now,
        ),
    )


def card_by_id(connection: sqlite3.Connection, card_id: str) -> dict[str, Any] | None:
    row = connection.execute("SELECT * FROM cards WHERE id = ? LIMIT 1", (card_id,)).fetchone()
    return _card_row_to_dict(row)


def search_cards(connection: sqlite3.Connection, query: str, limit: int = 25) -> list[dict[str, Any]]:
    tokens = tokenize(query)
    rows = connection.execute("SELECT * FROM cards").fetchall()
    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        card = _card_row_to_dict(row)
        if card is None:
            continue
        haystack_tokens = set(
            tokenize(" ".join([card["name"], card["setName"], card["number"], card.get("setID") or ""]))
        )
        score = float(len(set(tokens) & haystack_tokens))
        if query and query.lower() in card["name"].lower():
            score += 2.0
        if score <= 0:
            continue
        scored.append((score, card))
    scored.sort(key=lambda item: (-item[0], item[1]["name"], item[1]["number"]))
    return [card for _, card in scored[:limit]]


def search_cards_local(connection: sqlite3.Connection, query: str, limit: int = 25) -> list[dict[str, Any]]:
    return search_cards(connection, query, limit=limit)


def upsert_price_snapshot(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    pricing_mode: str,
    provider: str,
    currency_code: str,
    grader: str | None = None,
    grade: str | None = None,
    variant: str | None = None,
    low_price: float | None = None,
    market_price: float | None = None,
    mid_price: float | None = None,
    high_price: float | None = None,
    direct_low_price: float | None = None,
    trend_price: float | None = None,
    source_url: str | None = None,
    source_updated_at: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    snapshot_id = f"{card_id}:{pricing_mode}:{provider}:{grader or ''}:{grade or ''}:{variant or ''}"
    connection.execute(
        """
        INSERT INTO card_price_snapshots (
            id, card_id, pricing_mode, provider, grader, grade, variant, currency_code,
            low_price, market_price, mid_price, high_price, direct_low_price, trend_price,
            source_url, source_updated_at, source_payload_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            currency_code=excluded.currency_code,
            low_price=excluded.low_price,
            market_price=excluded.market_price,
            mid_price=excluded.mid_price,
            high_price=excluded.high_price,
            direct_low_price=excluded.direct_low_price,
            trend_price=excluded.trend_price,
            source_url=excluded.source_url,
            source_updated_at=excluded.source_updated_at,
            source_payload_json=excluded.source_payload_json,
            updated_at=excluded.updated_at
        """,
        (
            snapshot_id,
            card_id,
            pricing_mode,
            provider,
            grader,
            grade,
            variant,
            currency_code,
            low_price,
            market_price,
            mid_price,
            high_price,
            direct_low_price,
            trend_price,
            source_url,
            source_updated_at,
            json.dumps(payload or {}),
            utc_now(),
        ),
    )


def price_snapshot_for_card(
    connection: sqlite3.Connection,
    card_id: str,
    *,
    pricing_mode: str,
    grader: str | None = None,
    grade: str | None = None,
) -> dict[str, Any] | None:
    query = """
        SELECT *
        FROM card_price_snapshots
        WHERE card_id = ? AND pricing_mode = ?
    """
    params: list[Any] = [card_id, pricing_mode]
    if grader is not None:
        query += " AND grader = ?"
        params.append(grader)
    if grade is not None:
        query += " AND grade = ?"
        params.append(grade)
    query += " ORDER BY updated_at DESC LIMIT 1"
    row = connection.execute(query, params).fetchone()
    if row is None:
        return None
    updated_at = row["updated_at"]
    is_fresh = False
    if updated_at:
        try:
            refreshed = datetime.fromisoformat(str(updated_at))
            is_fresh = datetime.now(UTC) - refreshed <= timedelta(hours=24)
        except ValueError:
            is_fresh = False
    payload = _json_load(row["source_payload_json"], {})
    return {
        "id": row["id"],
        "cardID": row["card_id"],
        "pricingMode": row["pricing_mode"],
        "provider": row["provider"],
        "source": row["provider"],
        "grader": row["grader"],
        "grade": row["grade"],
        "variant": row["variant"],
        "currencyCode": row["currency_code"],
        "low": row["low_price"],
        "market": row["market_price"],
        "mid": row["mid_price"],
        "high": row["high_price"],
        "directLow": row["direct_low_price"],
        "trend": row["trend_price"],
        "sourceURL": row["source_url"],
        "updatedAt": row["source_updated_at"],
        "refreshedAt": row["updated_at"],
        "payload": payload,
        "isFresh": is_fresh,
    }


def raw_pricing_summary_for_card(connection: sqlite3.Connection, card_id: str) -> dict[str, Any] | None:
    return price_snapshot_for_card(connection, card_id, pricing_mode=RAW_PRICING_MODE)


def contextual_pricing_summary_for_card(
    connection: sqlite3.Connection,
    card_id: str,
    grader: str | None = None,
    grade: str | None = None,
) -> dict[str, Any] | None:
    if grader or grade:
        return price_snapshot_for_card(
            connection,
            card_id,
            pricing_mode=PSA_GRADE_PRICING_MODE,
            grader=grader,
            grade=grade,
        )
    return raw_pricing_summary_for_card(connection, card_id)


def upsert_card_price_summary(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    source: str,
    currency_code: str,
    variant: str | None,
    low_price: float | None,
    market_price: float | None,
    mid_price: float | None,
    high_price: float | None,
    direct_low_price: float | None,
    trend_price: float | None,
    source_updated_at: str | None,
    source_url: str | None,
    payload: dict[str, Any] | None,
) -> None:
    upsert_price_snapshot(
        connection,
        card_id=card_id,
        pricing_mode=RAW_PRICING_MODE,
        provider=source,
        currency_code=currency_code,
        variant=variant,
        low_price=low_price,
        market_price=market_price,
        mid_price=mid_price,
        high_price=high_price,
        direct_low_price=direct_low_price,
        trend_price=trend_price,
        source_updated_at=source_updated_at,
        source_url=source_url,
        payload=payload,
    )


def upsert_slab_price_snapshot(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    grader: str,
    grade: str,
    pricing_tier: str,
    currency_code: str,
    low_price: float | None,
    market_price: float | None,
    mid_price: float | None,
    high_price: float | None,
    last_sale_price: float | None,
    last_sale_date: str | None,
    comp_count: int,
    recent_comp_count: int,
    confidence_level: int,
    confidence_label: str,
    bucket_key: str | None,
    source_url: str | None,
    source: str,
    summary: str | None,
    payload: dict[str, Any] | None,
) -> None:
    snapshot_payload = dict(payload or {})
    snapshot_payload.update(
        {
            "pricingTier": pricing_tier,
            "lastSalePrice": last_sale_price,
            "lastSaleDate": last_sale_date,
            "compCount": comp_count,
            "recentCompCount": recent_comp_count,
            "confidenceLevel": confidence_level,
            "confidenceLabel": confidence_label,
            "bucketKey": bucket_key,
            "summary": summary,
        }
    )
    upsert_price_snapshot(
        connection,
        card_id=card_id,
        pricing_mode=PSA_GRADE_PRICING_MODE,
        provider=source,
        grader=grader,
        grade=grade,
        variant=f"{grader} {grade}",
        currency_code=currency_code,
        low_price=low_price,
        market_price=market_price,
        mid_price=mid_price,
        high_price=high_price,
        source_url=source_url,
        payload=snapshot_payload,
    )


def upsert_scan_event(
    connection: sqlite3.Connection,
    *,
    scan_id: str,
    request_payload: dict[str, Any],
    response_payload: dict[str, Any],
    matcher_source: str,
    matcher_version: str,
    created_at: str | None = None,
    selected_card_id: str | None = None,
    confidence: str | None = None,
    review_disposition: str | None = None,
    correction_type: str | None = None,
    resolver_mode: str | None = None,
    resolver_path: str | None = None,
    completed_at: str | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO scan_events (
            scan_id, created_at, resolver_mode, resolver_path,
            request_json, response_json, matcher_source, matcher_version,
            selected_card_id, confidence, review_disposition, correction_type, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scan_id) DO UPDATE SET
            resolver_mode=excluded.resolver_mode,
            resolver_path=excluded.resolver_path,
            request_json=excluded.request_json,
            response_json=excluded.response_json,
            matcher_source=excluded.matcher_source,
            matcher_version=excluded.matcher_version,
            selected_card_id=excluded.selected_card_id,
            confidence=excluded.confidence,
            review_disposition=excluded.review_disposition,
            correction_type=excluded.correction_type,
            completed_at=excluded.completed_at
        """,
        (
            scan_id,
            created_at or utc_now(),
            resolver_mode,
            resolver_path,
            json.dumps(request_payload or {}),
            json.dumps(response_payload or {}),
            matcher_source,
            matcher_version,
            selected_card_id,
            confidence,
            review_disposition,
            correction_type,
            completed_at,
        ),
    )


def upsert_catalog_card(
    connection: sqlite3.Connection,
    card: dict[str, Any],
    repo_root: Path,
    imported_at: str,
    refresh_embeddings: bool = False,
) -> None:
    del repo_root, imported_at, refresh_embeddings
    upsert_card(
        connection,
        card_id=str(card["id"]),
        name=str(card.get("name") or ""),
        set_name=str(card.get("set_name") or card.get("setName") or ""),
        number=str(card.get("number") or ""),
        rarity=str(card.get("rarity") or "Unknown"),
        variant=str(card.get("variant") or "Raw"),
        language=str(card.get("language") or "English"),
        source_provider=card.get("source") or card.get("sourceProvider"),
        source_record_id=card.get("source_record_id") or card.get("sourceRecordID"),
        set_id=card.get("set_id") or card.get("setID"),
        set_series=card.get("set_series") or card.get("setSeries"),
        set_ptcgo_code=card.get("set_ptcgo_code") or card.get("setPtcgoCode"),
        set_release_date=card.get("set_release_date") or card.get("setReleaseDate"),
        supertype=card.get("supertype"),
        subtypes=list(card.get("subtypes") or []),
        types=list(card.get("types") or []),
        artist=card.get("artist"),
        regulation_mark=card.get("regulation_mark") or card.get("regulationMark"),
        national_pokedex_numbers=list(card.get("national_pokedex_numbers") or card.get("nationalPokedexNumbers") or []),
        image_url=card.get("reference_image_url") or card.get("imageURL"),
        image_small_url=card.get("reference_image_small_url") or card.get("imageSmallURL"),
        source_payload=card.get("source_payload") or card.get("sourcePayload") or {},
    )

    tcgplayer = card.get("tcgplayer") or {}
    prices = (tcgplayer.get("prices") or {}) if isinstance(tcgplayer, dict) else {}
    if prices:
        variant, price_payload = next(iter(prices.items()))
        if isinstance(price_payload, dict):
            upsert_card_price_summary(
                connection,
                card_id=str(card["id"]),
                source="tcgplayer",
                currency_code="USD",
                variant=variant,
                low_price=price_payload.get("low"),
                market_price=price_payload.get("market"),
                mid_price=price_payload.get("mid"),
                high_price=price_payload.get("high"),
                direct_low_price=price_payload.get("directLow"),
                trend_price=price_payload.get("trend"),
                source_updated_at=tcgplayer.get("updatedAt"),
                source_url=tcgplayer.get("url"),
                payload={"provider": "pokemontcg_api", "priceSource": "tcgplayer"},
            )


def load_index(connection: sqlite3.Connection) -> CatalogIndex:
    rows = connection.execute(
        """
        SELECT id, name, set_name, number, rarity, variant, language, set_id, set_ptcgo_code
        FROM cards
        ORDER BY updated_at DESC, name, number
        """
    ).fetchall()
    cards = tuple(
        IndexedCard(
            id=row["id"],
            name=row["name"],
            set_name=row["set_name"],
            number=row["number"],
            rarity=row["rarity"],
            variant=row["variant"],
            language=row["language"],
            set_id=row["set_id"],
            set_ptcgo_code=row["set_ptcgo_code"],
        )
        for row in rows
    )
    return CatalogIndex(cards=cards)


def _candidate_from_card(card: dict[str, Any], route: str, score_hint: float, *, cache_presence: bool = True) -> dict[str, Any]:
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
        "_cachePresence": cache_presence,
        "_retrievalScoreHint": round(score_hint, 4),
        "_retrievalRoutes": [route],
    }


def _title_overlap(card: dict[str, Any], evidence: RawEvidence) -> float:
    query_tokens = set(tokenize(" ".join(filter(None, [evidence.title_text_primary, evidence.title_text_secondary]))))
    if not query_tokens:
        return 0.0
    candidate_tokens = set(tokenize(card["name"]))
    return len(query_tokens & candidate_tokens) / max(1, len(query_tokens))


def _set_overlap(card: dict[str, Any], evidence: RawEvidence) -> float:
    query_tokens = set(evidence.trusted_set_hint_tokens or evidence.set_hint_tokens)
    if not query_tokens:
        return 0.0
    candidate_tokens = set(
        tokenize(
            " ".join(
                part
                for part in [card.get("setName") or "", card.get("setSeries") or "", card.get("setID") or "", card.get("setPtcgoCode") or ""]
                if part
            )
        )
    )
    overlap = len(query_tokens & candidate_tokens)
    if any(token in {str(card.get("setID") or "").lower(), str(card.get("setPtcgoCode") or "").lower()} for token in query_tokens):
        overlap += 1
    return overlap / max(1, len(query_tokens))


def _collector_match(card_number: str, evidence: RawEvidence) -> tuple[float, float, float]:
    normalized = canonicalize_collector_number(card_number)
    exact = 0.0
    partial = 0.0
    denominator = 0.0
    if evidence.collector_number_exact:
        expected = canonicalize_collector_number(evidence.collector_number_exact)
        if normalized == expected:
            exact = 1.0
        elif evidence.collector_number_query_values and evidence.collector_number_query_values[0] in normalized:
            partial = 0.6
    elif evidence.collector_number_partial:
        expected = canonicalize_collector_number(evidence.collector_number_partial)
        if normalized == expected:
            partial = 1.0
        elif evidence.collector_number_query_values and evidence.collector_number_query_values[0] in normalized:
            partial = 0.6
    if evidence.collector_number_printed_total is not None and f"/{evidence.collector_number_printed_total}" in normalized:
        denominator = 1.0
    return exact, partial, denominator


def _candidate_rows(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = connection.execute("SELECT * FROM cards").fetchall()
    return [card for card in (_card_row_to_dict(row) for row in rows) if card is not None]


def search_cards_local_title_set(connection: sqlite3.Connection, evidence: RawEvidence, limit: int = 12) -> list[dict[str, Any]]:
    scored = []
    for card in _candidate_rows(connection):
        title_score = _title_overlap(card, evidence)
        set_score = _set_overlap(card, evidence)
        if title_score <= 0 or set_score <= 0:
            continue
        score = (title_score * 70.0) + (set_score * 30.0)
        scored.append((score, _candidate_from_card(card, RAW_ROUTE_TITLE_SET_PRIMARY, score)))
    scored.sort(key=lambda item: (-item[0], item[1]["name"], item[1]["number"]))
    return [candidate for _, candidate in scored[:limit]]


def search_cards_local_title_only(connection: sqlite3.Connection, evidence: RawEvidence, limit: int = 12) -> list[dict[str, Any]]:
    scored = []
    for card in _candidate_rows(connection):
        title_score = _title_overlap(card, evidence)
        if title_score <= 0:
            continue
        score = title_score * 75.0
        scored.append((score, _candidate_from_card(card, RAW_ROUTE_TITLE_ONLY, score)))
    scored.sort(key=lambda item: (-item[0], item[1]["name"], item[1]["number"]))
    return [candidate for _, candidate in scored[:limit]]


def search_cards_local_collector_set(connection: sqlite3.Connection, evidence: RawEvidence, limit: int = 12) -> list[dict[str, Any]]:
    scored = []
    for card in _candidate_rows(connection):
        exact, partial, denominator = _collector_match(card["number"], evidence)
        set_score = _set_overlap(card, evidence)
        if max(exact, partial) <= 0 or set_score <= 0:
            continue
        score = (exact * 80.0) + (partial * 55.0) + (denominator * 10.0) + (set_score * 20.0)
        scored.append((score, _candidate_from_card(card, RAW_ROUTE_COLLECTOR_SET_EXACT, score)))
    scored.sort(key=lambda item: (-item[0], item[1]["name"], item[1]["number"]))
    return [candidate for _, candidate in scored[:limit]]


def search_cards_local_collector_only(connection: sqlite3.Connection, evidence: RawEvidence, limit: int = 12) -> list[dict[str, Any]]:
    scored = []
    for card in _candidate_rows(connection):
        exact, partial, denominator = _collector_match(card["number"], evidence)
        if max(exact, partial, denominator) <= 0:
            continue
        score = (exact * 85.0) + (partial * 60.0) + (denominator * 10.0)
        scored.append((score, _candidate_from_card(card, RAW_ROUTE_COLLECTOR_ONLY, score)))
    scored.sort(key=lambda item: (-item[0], item[1]["name"], item[1]["number"]))
    return [candidate for _, candidate in scored[:limit]]


def merge_raw_candidate_pools(pools: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for pool in pools:
        for candidate in pool:
            card_id = str(candidate.get("id") or "")
            if not card_id:
                continue
            existing = merged.get(card_id)
            if existing is None:
                merged[card_id] = dict(candidate)
                merged[card_id]["_retrievalRoutes"] = list(candidate.get("_retrievalRoutes") or [])
                continue
            if float(candidate.get("_retrievalScoreHint") or 0.0) > float(existing.get("_retrievalScoreHint") or 0.0):
                existing.update({k: v for k, v in candidate.items() if not k.startswith("_")})
                existing["_retrievalScoreHint"] = candidate.get("_retrievalScoreHint")
            existing["_cachePresence"] = bool(existing.get("_cachePresence")) or bool(candidate.get("_cachePresence"))
            existing["_retrievalRoutes"] = list(
                dict.fromkeys([*(existing.get("_retrievalRoutes") or []), *(candidate.get("_retrievalRoutes") or [])])
            )
    return sorted(
        merged.values(),
        key=lambda candidate: (
            -float(candidate.get("_retrievalScoreHint") or 0.0),
            str(candidate.get("name") or ""),
            str(candidate.get("number") or ""),
        ),
    )


def score_raw_candidate_retrieval(candidate: dict[str, Any], evidence: RawEvidence, signals: RawSignalScores) -> float:
    title_score = _title_overlap(candidate, evidence) * min(35.0, signals.title_signal * 0.40)
    set_score = _set_overlap(candidate, evidence) * min(20.0, signals.set_signal * 0.30)
    exact, partial, denominator = _collector_match(str(candidate.get("number") or ""), evidence)
    collector_score = max(exact * 30.0, partial * 20.0, denominator * 8.0)
    footer_bonus = 10.0 if evidence.footer_band_text and evidence.collector_number_exact and exact > 0 else 0.0
    return round(title_score + set_score + collector_score + footer_bonus, 4)


def score_raw_candidate_resolution(candidate: dict[str, Any], evidence: RawEvidence) -> tuple[float, RawCandidateScoreBreakdown, tuple[str, ...]]:
    title_overlap_score = _title_overlap(candidate, evidence) * 35.0
    set_overlap_score = _set_overlap(candidate, evidence) * 20.0
    exact, partial, denominator = _collector_match(str(candidate.get("number") or ""), evidence)
    collector_exact_score = exact * 30.0
    collector_partial_score = partial * 18.0
    collector_denominator_score = denominator * 8.0
    footer_text_support_score = 0.0
    if evidence.footer_band_text and evidence.collector_number_query_values:
        footer_text_support_score = 7.0 if any(
            query_value in canonicalize_collector_number(evidence.footer_band_text)
            for query_value in evidence.collector_number_query_values
        ) else 0.0
    promo_support_score = 5.0 if evidence.promo_code_hint and evidence.promo_code_hint.lower() in tokenize(str(candidate.get("number") or "")) else 0.0
    cache_presence_score = 0.0
    contradiction_penalty = 0.0
    reasons: list[str] = []

    if title_overlap_score:
        reasons.append("title_overlap")
    if set_overlap_score:
        reasons.append("set_overlap")
    if collector_exact_score:
        reasons.append("collector_exact")
    elif collector_partial_score:
        reasons.append("collector_partial")
    if collector_denominator_score:
        reasons.append("collector_denominator")
    if footer_text_support_score:
        reasons.append("footer_support")

    if evidence.collector_number_exact and not (collector_exact_score or collector_partial_score):
        contradiction_penalty += 10.0
        reasons.append("collector_mismatch")
    if evidence.trusted_set_hint_tokens and set_overlap_score == 0:
        contradiction_penalty += 8.0
        reasons.append("set_mismatch")

    retrieval_total = float(candidate.get("_retrievalScoreHint") or 0.0)
    resolution_total = (
        title_overlap_score
        + set_overlap_score
        + collector_exact_score
        + collector_partial_score
        + collector_denominator_score
        + footer_text_support_score
        + promo_support_score
        + cache_presence_score
        - contradiction_penalty
    )
    final_total = max(0.0, round((retrieval_total * 0.55) + (resolution_total * 0.45), 4))
    breakdown = RawCandidateScoreBreakdown(
        title_overlap_score=round(title_overlap_score, 4),
        set_overlap_score=round(set_overlap_score, 4),
        collector_exact_score=round(collector_exact_score, 4),
        collector_partial_score=round(collector_partial_score, 4),
        collector_denominator_score=round(collector_denominator_score, 4),
        footer_text_support_score=round(footer_text_support_score, 4),
        promo_support_score=round(promo_support_score, 4),
        cache_presence_score=round(cache_presence_score, 4),
        contradiction_penalty=round(contradiction_penalty, 4),
        retrieval_total=round(retrieval_total, 4),
        resolution_total=round(resolution_total, 4),
        final_total=round(final_total, 4),
    )
    return round(resolution_total, 4), breakdown, tuple(reasons)


def rank_raw_candidates(
    candidates: list[dict[str, Any]],
    evidence: RawEvidence,
    signals: RawSignalScores,
) -> list[RawCandidateMatch]:
    ranked: list[RawCandidateMatch] = []
    for candidate in candidates:
        retrieval_score = score_raw_candidate_retrieval(candidate, evidence, signals)
        resolution_score, breakdown, reasons = score_raw_candidate_resolution(candidate, evidence)
        final_total = round((retrieval_score * 0.55) + (resolution_score * 0.45), 4)
        ranked.append(
            RawCandidateMatch(
                card=candidate,
                retrieval_score=retrieval_score,
                resolution_score=resolution_score,
                final_total=final_total,
                breakdown=RawCandidateScoreBreakdown(
                    title_overlap_score=breakdown.title_overlap_score,
                    set_overlap_score=breakdown.set_overlap_score,
                    collector_exact_score=breakdown.collector_exact_score,
                    collector_partial_score=breakdown.collector_partial_score,
                    collector_denominator_score=breakdown.collector_denominator_score,
                    footer_text_support_score=breakdown.footer_text_support_score,
                    promo_support_score=breakdown.promo_support_score,
                    cache_presence_score=breakdown.cache_presence_score,
                    contradiction_penalty=breakdown.contradiction_penalty,
                    retrieval_total=retrieval_score,
                    resolution_total=resolution_score,
                    final_total=final_total,
                ),
                reasons=reasons,
            )
        )
    ranked.sort(key=lambda match: (-match.final_total, match.card["name"], match.card["number"]))
    return ranked


def compute_raw_confidence(matches: list[RawCandidateMatch], signals: RawSignalScores) -> tuple[str, float, tuple[str, ...], str | None]:
    if not matches:
        return "low", 0.0, ("No candidates were available.",), "no_candidates"
    top_match = matches[0]
    runner_up_score = matches[1].final_total if len(matches) > 1 else 0.0
    support_percent = min(100.0, top_match.final_total)
    margin_percent = max(0.0, min(100.0, (top_match.final_total - runner_up_score) * 4.0))
    completeness_percent = min(
        100.0,
        (signals.title_signal * 0.40) + (signals.collector_signal * 0.40) + (signals.set_signal * 0.20),
    )
    penalty_percent = min(25.0, top_match.breakdown.contradiction_penalty)
    confidence_percent = max(
        0.0,
        min(
            100.0,
            (support_percent * 0.60)
            + (margin_percent * 0.25)
            + (completeness_percent * 0.15)
            - penalty_percent,
        ),
    )
    ambiguity_flags: list[str] = []
    fallback_reason: str | None = None
    if len(matches) > 1 and (top_match.final_total - runner_up_score) < 8.0:
        ambiguity_flags.append("Top matches are close together")
    if signals.collector_signal < 45:
        ambiguity_flags.append("Footer collector OCR is weak")
        fallback_reason = fallback_reason or "weak_footer"
    if signals.set_signal < 45:
        ambiguity_flags.append("Set hints are weak")
        fallback_reason = fallback_reason or "weak_set"

    if confidence_percent >= 85.0:
        confidence = "high"
    elif confidence_percent >= 65.0:
        confidence = "medium"
    else:
        confidence = "low"

    return confidence, round(confidence_percent, 2), tuple(ambiguity_flags), fallback_reason


def finalize_raw_decision(
    matches: list[RawCandidateMatch],
    evidence: RawEvidence,
    signals: RawSignalScores,
) -> RawDecisionResult:
    if not matches and _raw_has_no_readable_signal(evidence, signals):
        return RawDecisionResult(
            matches=tuple(),
            top_candidates=tuple(),
            confidence="low",
            confidence_percent=0.0,
            ambiguity_flags=(
                "Footer collector OCR is weak",
                "Set hints are weak",
                "No readable OCR signal was found",
            ),
            resolver_path="visual_fallback",
            review_disposition="unsupported",
            review_reason="No readable card signal was found. Try again with a sharper, closer scan.",
            fallback_reason="no_signal",
            selected_card_id=None,
            debug_payload={},
        )

    confidence, confidence_percent, ambiguity_flags, fallback_reason = compute_raw_confidence(matches, signals)
    ambiguity_flag_list = list(ambiguity_flags)
    ambiguity_context = (
        _raw_same_exact_number_ambiguity(matches, evidence)
        or _raw_minimal_signal_ambiguity(matches, evidence, signals)
    )
    if ambiguity_context is not None:
        kind = str(ambiguity_context.get("kind") or "")
        if kind == "same_exact_number_without_disambiguator":
            ambiguity_flag_list.append("Best guess is arbitrary among same-number matches")
        elif kind == "arbitrary_best_guess_minimal_signal":
            ambiguity_flag_list.append("Best guess is arbitrary because OCR evidence is minimal")
    top_candidates = tuple(matches[:3])
    selected_card_id = top_candidates[0].card.get("id") if top_candidates else None
    review_disposition = "ready" if confidence != "low" else "needs_review"
    review_reason = None if review_disposition == "ready" else "Review the best guess before relying on the card result."
    return RawDecisionResult(
        matches=tuple(matches),
        top_candidates=top_candidates,
        confidence=confidence,
        confidence_percent=confidence_percent,
        ambiguity_flags=tuple(dict.fromkeys(ambiguity_flag_list)),
        resolver_path="visual_fallback",
        review_disposition=review_disposition,
        review_reason=review_reason,
        fallback_reason=fallback_reason,
        selected_card_id=selected_card_id,
        debug_payload={},
    )


def raw_debug_payload(
    evidence: RawEvidence,
    signals: RawSignalScores,
    plan: RawRetrievalPlan,
    matches: list[RawCandidateMatch],
    decision: RawDecisionResult,
    *,
    remote_debug: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ambiguity_context = (
        _raw_same_exact_number_ambiguity(matches, evidence)
        or _raw_minimal_signal_ambiguity(matches, evidence, signals)
    )
    return {
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
        },
        "signals": {
            "title": signals.title_signal,
            "collector": signals.collector_signal,
            "set": signals.set_signal,
            "footer": signals.footer_signal,
            "overall": signals.overall_signal,
        },
        "retrievalPlan": {
            "routes": list(plan.routes),
            "shouldQueryRemote": plan.should_query_remote,
        },
        "remote": remote_debug or {},
        "ambiguity": ambiguity_context,
        "topMatches": [
            {
                "id": match.card.get("id"),
                "name": match.card.get("name"),
                "number": match.card.get("number"),
                "retrievalScore": match.retrieval_score,
                "resolutionScore": match.resolution_score,
                "finalScore": match.final_total,
                "reasons": list(match.reasons),
                "breakdown": {
                    "titleOverlap": match.breakdown.title_overlap_score,
                    "setOverlap": match.breakdown.set_overlap_score,
                    "collectorExact": match.breakdown.collector_exact_score,
                    "collectorPartial": match.breakdown.collector_partial_score,
                    "collectorDenominator": match.breakdown.collector_denominator_score,
                    "footerSupport": match.breakdown.footer_text_support_score,
                    "promoSupport": match.breakdown.promo_support_score,
                    "cachePresence": match.breakdown.cache_presence_score,
                    "contradictionPenalty": match.breakdown.contradiction_penalty,
                },
            }
            for match in matches[:5]
        ],
        "decision": {
            "confidence": decision.confidence,
            "confidencePercent": decision.confidence_percent,
            "ambiguityFlags": list(decision.ambiguity_flags),
            "reviewDisposition": decision.review_disposition,
            "fallbackReason": decision.fallback_reason,
            "selectedCardID": decision.selected_card_id,
        },
    }


def resolver_mode_for_payload(payload: dict[str, Any]) -> str:
    hint = str(payload.get("resolverModeHint") or "").strip().lower()
    if hint in {"psa_slab", "slab", "slab_card"}:
        return "psa_slab"
    ocr_analysis = payload.get("ocrAnalysis") or {}
    slab_evidence = (ocr_analysis.get("slabEvidence") or {}) if isinstance(ocr_analysis, dict) else {}
    if any([
        payload.get("slabGrader"),
        payload.get("slabGrade"),
        slab_evidence.get("titleTextPrimary"),
        slab_evidence.get("grader"),
        slab_evidence.get("grade"),
        slab_evidence.get("cert"),
    ]):
        return "psa_slab"
    return "raw_card"
