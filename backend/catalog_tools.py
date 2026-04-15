from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable
import unicodedata


MATCHER_VERSION = "raw-backend-reset-v1"
RAW_PRICING_MODE = "raw"
PSA_GRADE_PRICING_MODE = "graded"
PROVIDER_SYNC_STATUS_RUNNING = "running"
PROVIDER_SYNC_STATUS_SUCCEEDED = "succeeded"
PROVIDER_SYNC_STATUS_FAILED = "failed"

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
    set_badge_hint_kind: str | None
    set_badge_hint_source: str | None
    set_badge_hint_raw_value: str | None
    set_hint_tokens: tuple[str, ...]
    trusted_set_hint_tokens: tuple[str, ...]
    promo_code_hint: str | None
    recognized_tokens: tuple[str, ...]
    crop_confidence: float
    title_confidence_score: float
    collector_confidence_score: float
    set_confidence_score: float
    used_fallback_normalization: bool
    target_quality_score: float


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
    set_badge_image_score: float
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


def _contains_japanese_text(text: str) -> bool:
    return bool(re.search(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]", text))


def _raw_looks_like_japanese_provider_gap(evidence: RawEvidence) -> bool:
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


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect(database_path: Path | str) -> sqlite3.Connection:
    connection = sqlite3.connect(str(database_path))
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _table_columns(connection: sqlite3.Connection, table_name: str) -> set[str]:
    rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {str(row["name"]) for row in rows}


def _table_exists(connection: sqlite3.Connection, table_name: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        (table_name,),
    ).fetchone()
    return row is not None


def _card_exists(connection: sqlite3.Connection, card_id: str) -> bool:
    normalized_card_id = str(card_id or "").strip()
    if not normalized_card_id:
        return False
    row = connection.execute(
        "SELECT 1 FROM cards WHERE id = ? LIMIT 1",
        (normalized_card_id,),
    ).fetchone()
    return row is not None


def _add_column_if_missing(
    connection: sqlite3.Connection,
    table_name: str,
    column_name: str,
    column_sql: str,
) -> None:
    if not _table_exists(connection, table_name):
        return
    if column_name in _table_columns(connection, table_name):
        return
    connection.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_sql}")


def _apply_additive_runtime_migrations(connection: sqlite3.Connection) -> None:
    # Additive scan/dataset schema changes must not trigger the destructive reset path.
    scan_event_columns = {
        "predicted_card_id": "TEXT",
        "selected_rank": "INTEGER",
        "was_top_prediction": "INTEGER",
        "selection_source": "TEXT",
        "confirmed_card_id": "TEXT",
        "confirmation_source": "TEXT",
        "deck_entry_id": "TEXT",
        "confirmed_at": "TEXT",
    }
    for column_name, column_sql in scan_event_columns.items():
        _add_column_if_missing(connection, "scan_events", column_name, column_sql)

    _add_column_if_missing(connection, "deck_entries", "quantity", "INTEGER NOT NULL DEFAULT 1")
    _add_column_if_missing(connection, "deck_entries", "condition", "TEXT")
    _backfill_deck_entry_quantities(connection)


def _backfill_deck_entry_quantities(connection: sqlite3.Connection) -> None:
    if not _table_exists(connection, "deck_entries"):
        return
    if "quantity" not in _table_columns(connection, "deck_entries"):
        return

    connection.execute(
        """
        UPDATE deck_entries
        SET quantity = 1
        WHERE quantity IS NULL OR quantity < 1
        """
    )

    if not _table_exists(connection, "scan_confirmations"):
        return

    rows = connection.execute(
        """
        SELECT
            deck_entry_id,
            COUNT(*) AS confirmation_count
        FROM scan_confirmations
        WHERE deck_entry_id IS NOT NULL
          AND TRIM(deck_entry_id) != ''
        GROUP BY deck_entry_id
        """
    ).fetchall()
    for row in rows:
        deck_entry_id = str(row["deck_entry_id"] or "").strip()
        if not deck_entry_id:
            continue
        confirmation_count = max(1, int(row["confirmation_count"] or 0))
        connection.execute(
            """
            UPDATE deck_entries
            SET quantity = CASE
                WHEN quantity IS NULL OR quantity < ? THEN ?
                ELSE quantity
            END
            WHERE id = ?
            """,
            (confirmation_count, confirmation_count, deck_entry_id),
        )


def _normalized_alias_text(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    tokens = tokenize(text)
    if tokens:
        return " ".join(tokens)
    return text.lower()


def _normalized_alias_language(value: object) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    lowered = text.lower()
    if lowered in {"ja", "japanese"}:
        return "Japanese"
    if lowered in {"en", "english"}:
        return "English"
    return text


def derive_card_title_aliases(
    *,
    name: object,
    language: object,
    source_payload: object,
    extra_aliases: Iterable[object] = (),
) -> tuple[dict[str, str | None], ...]:
    aliases: list[dict[str, str | None]] = []
    seen: set[tuple[str, str]] = set()

    def add(value: object, *, alias_language: object, alias_kind: str) -> None:
        alias = str(value or "").strip()
        normalized_alias = _normalized_alias_text(alias)
        if not alias or not normalized_alias:
            return
        dedupe_key = (normalized_alias, alias_kind)
        if dedupe_key in seen:
            return
        seen.add(dedupe_key)
        aliases.append(
            {
                "alias": alias,
                "normalized_alias": normalized_alias,
                "alias_language": _normalized_alias_language(alias_language),
                "alias_kind": alias_kind,
            }
        )

    add(name, alias_language=language, alias_kind="canonical")

    if isinstance(source_payload, dict):
        add(source_payload.get("name"), alias_language=language, alias_kind="source_payload")
        translation = source_payload.get("translation")
        if isinstance(translation, dict):
            for translation_language, translation_payload in translation.items():
                if not isinstance(translation_payload, dict):
                    continue
                add(
                    translation_payload.get("name"),
                    alias_language=translation_language,
                    alias_kind=f"translation:{str(translation_language or '').lower()}",
                )

    for extra_alias in extra_aliases:
        add(extra_alias, alias_language=language, alias_kind="extra")

    return tuple(aliases)


def _replace_card_title_aliases(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    name: object,
    language: object,
    source_payload: object,
    extra_aliases: Iterable[object] = (),
) -> None:
    if not _table_exists(connection, "card_name_aliases"):
        return

    aliases = derive_card_title_aliases(
        name=name,
        language=language,
        source_payload=source_payload,
        extra_aliases=extra_aliases,
    )
    connection.execute("DELETE FROM card_name_aliases WHERE card_id = ?", (card_id,))
    now = utc_now()
    for alias in aliases:
        connection.execute(
            """
            INSERT INTO card_name_aliases (
                card_id, alias, normalized_alias, alias_language, alias_kind, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                card_id,
                alias["alias"],
                alias["normalized_alias"],
                alias["alias_language"],
                alias["alias_kind"],
                now,
                now,
            ),
        )


def _backfill_missing_card_title_aliases(connection: sqlite3.Connection) -> None:
    if not _table_exists(connection, "card_name_aliases"):
        return

    rows = connection.execute(
        """
        SELECT c.id, c.name, c.language, c.source_payload_json
        FROM cards c
        LEFT JOIN (
            SELECT DISTINCT card_id
            FROM card_name_aliases
        ) aliases
          ON aliases.card_id = c.id
        WHERE aliases.card_id IS NULL
        """
    ).fetchall()

    for row in rows:
        _replace_card_title_aliases(
            connection,
            card_id=str(row["id"]),
            name=row["name"],
            language=row["language"],
            source_payload=_json_load(row["source_payload_json"], {}),
        )


def _card_title_aliases_by_card_ids(
    connection: sqlite3.Connection,
    card_ids: Iterable[str],
) -> dict[str, tuple[str, ...]]:
    if not _table_exists(connection, "card_name_aliases"):
        return {}

    normalized_ids = [str(card_id or "").strip() for card_id in card_ids if str(card_id or "").strip()]
    if not normalized_ids:
        return {}

    placeholders = ", ".join("?" for _ in normalized_ids)
    rows = connection.execute(
        f"""
        SELECT card_id, alias
        FROM card_name_aliases
        WHERE card_id IN ({placeholders})
        ORDER BY card_id, alias
        """,
        normalized_ids,
    ).fetchall()

    grouped: dict[str, list[str]] = {}
    for row in rows:
        grouped.setdefault(str(row["card_id"]), []).append(str(row["alias"]))
    return {card_id: tuple(aliases) for card_id, aliases in grouped.items()}


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
    required_fx_columns = {
        "id",
        "base_currency",
        "quote_currency",
        "rate",
        "source",
        "effective_at",
        "source_url",
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

    if "fx_rate_snapshots" in tables:
        fx_columns = _table_columns(connection, "fx_rate_snapshots")
        if not required_fx_columns.issubset(fx_columns):
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
    _apply_additive_runtime_migrations(connection)
    connection.executescript(schema_path.read_text())
    _backfill_missing_card_title_aliases(connection)
    connection.commit()


def start_provider_sync_run(
    connection: sqlite3.Connection,
    *,
    provider: str,
    sync_scope: str,
    page_size: int,
    scheduled_for: str | None = None,
    started_at: str | None = None,
    usage_before: dict[str, Any] | None = None,
    notes: dict[str, Any] | None = None,
) -> str:
    started_at = started_at or utc_now()
    run_id = f"{provider}:{sync_scope}:{started_at}"
    connection.execute(
        """
        INSERT INTO provider_sync_runs (
            id, provider, sync_scope, status, scheduled_for, started_at, completed_at,
            page_size, pages_fetched, cards_seen, cards_upserted, raw_snapshots_upserted,
            graded_snapshots_upserted, estimated_credits_used, usage_before_json,
            usage_after_json, error_text, notes_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            provider,
            sync_scope,
            PROVIDER_SYNC_STATUS_RUNNING,
            scheduled_for,
            started_at,
            None,
            page_size,
            0,
            0,
            0,
            0,
            0,
            None,
            json.dumps(usage_before or {}),
            json.dumps({}),
            None,
            json.dumps(notes or {}),
        ),
    )
    return run_id


def update_provider_sync_run(
    connection: sqlite3.Connection,
    run_id: str,
    *,
    status: str | None = None,
    completed_at: str | None = None,
    pages_fetched: int | None = None,
    cards_seen: int | None = None,
    cards_upserted: int | None = None,
    raw_snapshots_upserted: int | None = None,
    graded_snapshots_upserted: int | None = None,
    estimated_credits_used: int | None = None,
    usage_after: dict[str, Any] | None = None,
    error_text: str | None = None,
    notes: dict[str, Any] | None = None,
) -> None:
    assignments: list[str] = []
    values: list[Any] = []

    def add(column: str, value: Any) -> None:
        assignments.append(f"{column} = ?")
        values.append(value)

    if status is not None:
        add("status", status)
    if completed_at is not None:
        add("completed_at", completed_at)
    if pages_fetched is not None:
        add("pages_fetched", pages_fetched)
    if cards_seen is not None:
        add("cards_seen", cards_seen)
    if cards_upserted is not None:
        add("cards_upserted", cards_upserted)
    if raw_snapshots_upserted is not None:
        add("raw_snapshots_upserted", raw_snapshots_upserted)
    if graded_snapshots_upserted is not None:
        add("graded_snapshots_upserted", graded_snapshots_upserted)
    if estimated_credits_used is not None:
        add("estimated_credits_used", estimated_credits_used)
    if usage_after is not None:
        add("usage_after_json", json.dumps(usage_after))
    if error_text is not None:
        add("error_text", error_text)
    if notes is not None:
        add("notes_json", json.dumps(notes))

    if not assignments:
        return

    values.append(run_id)
    connection.execute(
        f"""
        UPDATE provider_sync_runs
        SET {", ".join(assignments)}
        WHERE id = ?
        """,
        values,
    )


def latest_provider_sync_run(
    connection: sqlite3.Connection,
    *,
    provider: str,
    sync_scope: str | None = None,
) -> dict[str, Any] | None:
    query = """
        SELECT *
        FROM provider_sync_runs
        WHERE provider = ?
    """
    params: list[Any] = [provider]
    if sync_scope is not None:
        query += " AND sync_scope = ?"
        params.append(sync_scope)
    query += " ORDER BY started_at DESC LIMIT 1"
    row = connection.execute(query, params).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "provider": row["provider"],
        "syncScope": row["sync_scope"],
        "status": row["status"],
        "scheduledFor": row["scheduled_for"],
        "startedAt": row["started_at"],
        "completedAt": row["completed_at"],
        "pageSize": row["page_size"],
        "pagesFetched": row["pages_fetched"],
        "cardsSeen": row["cards_seen"],
        "cardsUpserted": row["cards_upserted"],
        "rawSnapshotsUpserted": row["raw_snapshots_upserted"],
        "gradedSnapshotsUpserted": row["graded_snapshots_upserted"],
        "estimatedCreditsUsed": row["estimated_credits_used"],
        "usageBefore": _json_load(row["usage_before_json"], {}),
        "usageAfter": _json_load(row["usage_after_json"], {}),
        "errorText": row["error_text"],
        "notes": _json_load(row["notes_json"], {}),
    }


def provider_sync_run_is_fresh(
    connection: sqlite3.Connection,
    *,
    provider: str,
    sync_scope: str,
    max_age_hours: float = 24.0,
) -> bool:
    latest = latest_provider_sync_run(connection, provider=provider, sync_scope=sync_scope)
    if latest is None or latest.get("status") != PROVIDER_SYNC_STATUS_SUCCEEDED:
        return False
    completed_at = str(latest.get("completedAt") or "").strip()
    if not completed_at:
        return False
    try:
        completed = datetime.fromisoformat(completed_at)
    except ValueError:
        return False
    return datetime.now(timezone.utc) - completed <= timedelta(hours=max_age_hours)


def runtime_setting(connection: sqlite3.Connection, key: str) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT key, value_json, updated_at
        FROM runtime_settings
        WHERE key = ?
        LIMIT 1
        """,
        (key,),
    ).fetchone()
    if row is None:
        return None
    return {
        "key": row["key"],
        "value": _json_load(row["value_json"], {}),
        "updatedAt": row["updated_at"],
    }


def upsert_runtime_setting(
    connection: sqlite3.Connection,
    *,
    key: str,
    value: dict[str, Any] | None,
    updated_at: str | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO runtime_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        """,
        (key, json.dumps(value or {}), updated_at or utc_now()),
    )


def delete_runtime_setting(connection: sqlite3.Connection, key: str) -> None:
    connection.execute(
        """
        DELETE FROM runtime_settings
        WHERE key = ?
        """,
        (key,),
    )


def tokenize(text: str) -> list[str]:
    return re.findall(r"[^\W_]+", text.lower(), flags=re.UNICODE)


def _strip_leading_hiragana_noise(value: str) -> str:
    trimmed = re.sub(r"^[\u3041-\u3096]{1,3}(?=[\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff])", "", value)
    return trimmed if len(trimmed) >= 2 else value


def _japanese_title_components(text: str) -> tuple[str, ...]:
    normalized = unicodedata.normalize("NFKC", text or "").lower()
    normalized = re.sub(r"(tag\s*team|gx|ex|vmax|vstar|vm|hp|lv\.?|rrr|rr|sr|hr|ur|chr|csr|sar|ar|\d+)", " ", normalized)
    components = re.findall(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]+", normalized)
    stopwords = {
        "たね",
        "基本",
        "進化",
        "ポケモン",
        "トレーナー",
        "トレーナーズ",
        "サポート",
        "グッズ",
        "スタジアム",
        "エネルギー",
        "ワザ",
        "ルール",
    }
    cleaned: list[str] = []
    seen: set[str] = set()
    for component in components:
        candidate = _strip_leading_hiragana_noise(component.strip())
        if len(candidate) < 2 or candidate in stopwords or candidate in seen:
            continue
        seen.add(candidate)
        cleaned.append(candidate)
    return tuple(cleaned)


def _japanese_component_similarity(query_component: str, candidate_component: str) -> float:
    if not query_component or not candidate_component:
        return 0.0
    if query_component == candidate_component:
        return 1.0

    containment = 0.0
    if query_component in candidate_component or candidate_component in query_component:
        short_component, long_component = sorted(
            (query_component, candidate_component),
            key=len,
        )
        containment = len(short_component) / max(1, len(long_component))

    ratio = SequenceMatcher(None, query_component, candidate_component).ratio()
    return max(containment, ratio)


def _japanese_title_fuzzy_overlap(card: dict[str, Any], evidence: RawEvidence) -> float:
    query_text = " ".join(filter(None, [evidence.title_text_primary, evidence.title_text_secondary]))
    if not _contains_japanese_text(query_text):
        return 0.0

    query_components = _japanese_title_components(query_text)
    if not query_components:
        return 0.0

    candidate_components: list[str] = []
    seen_components: set[str] = set()
    for value in _candidate_title_values(card):
        for component in _japanese_title_components(value):
            if component in seen_components:
                continue
            seen_components.add(component)
            candidate_components.append(component)
    if not candidate_components:
        return 0.0

    matched_scores: list[float] = []
    for query_component in query_components:
        best_similarity = max(
            _japanese_component_similarity(query_component, candidate_component)
            for candidate_component in candidate_components
        )
        if best_similarity >= 0.72:
            matched_scores.append(best_similarity)

    if not matched_scores:
        return 0.0

    coverage = len(matched_scores) / max(1, len(query_components))
    score = (sum(matched_scores) / len(matched_scores)) * coverage
    return round(min(1.0, score), 4) if score >= 0.55 else 0.0


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
        if not cleaned or cleaned in seen or _looks_like_junk_set_token(cleaned):
            continue
        seen.add(cleaned)
        normalized.append(cleaned)
    return tuple(normalized)


def _looks_like_junk_set_token(token: str) -> bool:
    cleaned = str(token or "").strip().lower()
    if not cleaned:
        return True
    if re.fullmatch(r"hp\d{2,4}", cleaned):
        return True
    if re.fullmatch(r"p\d{2,4}", cleaned):
        return True
    if re.fullmatch(r"\d{2,4}", cleaned):
        return True
    return False


def _payload_set_badge_hint(payload: dict[str, Any]) -> dict[str, Any]:
    raw_evidence = _payload_raw_evidence(payload)
    set_badge_hint = raw_evidence.get("setBadgeHint") or payload.get("setBadgeHint") or {}
    return set_badge_hint if isinstance(set_badge_hint, dict) else {}


def _payload_raw_evidence(payload: dict[str, Any]) -> dict[str, Any]:
    ocr_analysis = payload.get("ocrAnalysis") or {}
    if not isinstance(ocr_analysis, dict):
        return {}
    raw_evidence = ocr_analysis.get("rawEvidence") or {}
    return raw_evidence if isinstance(raw_evidence, dict) else {}


def _payload_normalized_target(payload: dict[str, Any]) -> dict[str, Any]:
    ocr_analysis = payload.get("ocrAnalysis") or {}
    if not isinstance(ocr_analysis, dict):
        return {}
    normalized_target = ocr_analysis.get("normalizedTarget") or {}
    return normalized_target if isinstance(normalized_target, dict) else {}


def _ocr_confidence_score(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        score = value.get("score")
        if isinstance(score, (int, float)):
            return float(score)
    return 0.0


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
    normalized_target = _payload_normalized_target(payload)
    set_badge_hint = _payload_set_badge_hint(payload)
    title_primary = str(raw_evidence.get("titleTextPrimary") or payload.get("titleTextPrimary") or "").strip()
    title_secondary = str(raw_evidence.get("titleTextSecondary") or payload.get("titleTextSecondary") or "").strip()
    whole_card_text = str(raw_evidence.get("wholeCardText") or payload.get("wholeCardText") or "").strip()
    footer_band_text = str(raw_evidence.get("footerBandText") or payload.get("footerBandText") or "").strip()
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
    set_badge_kind = str(set_badge_hint.get("kind") or "").strip().lower() or None
    set_badge_source = str(set_badge_hint.get("source") or "").strip().lower() or None
    set_badge_raw_value = str(set_badge_hint.get("rawValue") or "").strip() or None
    badge_canonical_tokens = _normalized_set_tokens(set_badge_hint.get("canonicalTokens") or [])
    set_hint_tokens = badge_canonical_tokens or _normalized_set_tokens(raw_evidence.get("setHints") or payload.get("setHintTokens") or [])
    explicit_trusted_tokens = _normalized_set_tokens(payload.get("trustedSetHints") or [])
    set_badge_confidence = _ocr_confidence_score(set_badge_hint.get("confidence"))
    if explicit_trusted_tokens:
        trusted_set_hint_tokens = explicit_trusted_tokens
    elif set_badge_kind in {"text", "icon"} and badge_canonical_tokens and set_badge_confidence >= 0.40:
        trusted_set_hint_tokens = badge_canonical_tokens
    else:
        trusted_set_hint_tokens = ()
    promo_code_hint = str(payload.get("promoCodeHint") or "").strip() or None
    recognized_tokens = _recognized_token_texts(payload)
    recognized_text = " ".join(part for part in [whole_card_text, footer_band_text] if part).strip()
    target_quality_payload = normalized_target.get("targetQuality") or {}
    target_quality_score = 0.0
    if isinstance(target_quality_payload, dict):
        overall_score = target_quality_payload.get("overallScore")
        if isinstance(overall_score, (int, float)):
            target_quality_score = float(overall_score)
    if target_quality_score <= 0.0:
        target_quality_score = float(payload.get("cropConfidence") or 0.0)
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
        set_badge_hint_kind=set_badge_kind,
        set_badge_hint_source=set_badge_source,
        set_badge_hint_raw_value=set_badge_raw_value,
        set_hint_tokens=set_hint_tokens,
        trusted_set_hint_tokens=trusted_set_hint_tokens,
        promo_code_hint=promo_code_hint,
        recognized_tokens=recognized_tokens,
        crop_confidence=float(payload.get("cropConfidence") or 0.0),
        title_confidence_score=_ocr_confidence_score(raw_evidence.get("titleConfidence") or payload.get("titleConfidence")),
        collector_confidence_score=_ocr_confidence_score(raw_evidence.get("collectorConfidence") or payload.get("collectorConfidence")),
        set_confidence_score=_ocr_confidence_score(raw_evidence.get("setConfidence") or payload.get("setConfidence")),
        used_fallback_normalization=bool(normalized_target.get("usedFallback") or False),
        target_quality_score=target_quality_score,
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


def _card_row_to_dict(
    row: sqlite3.Row | None,
    *,
    title_aliases: Iterable[str] = (),
) -> dict[str, Any] | None:
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
        "titleAliases": list(title_aliases),
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
    _replace_card_title_aliases(
        connection,
        card_id=card_id,
        name=name,
        language=language,
        source_payload=source_payload or {},
    )


def card_by_id(connection: sqlite3.Connection, card_id: str) -> dict[str, Any] | None:
    row = connection.execute("SELECT * FROM cards WHERE id = ? LIMIT 1", (card_id,)).fetchone()
    alias_map = _card_title_aliases_by_card_ids(connection, [card_id])
    return _card_row_to_dict(row, title_aliases=alias_map.get(card_id, ()))


def search_cards(connection: sqlite3.Connection, query: str, limit: int = 25) -> list[dict[str, Any]]:
    tokens = tokenize(query)
    scored: list[tuple[float, dict[str, Any]]] = []
    for card in _candidate_rows(connection):
        haystack_tokens = set(
            tokenize(
                " ".join(
                    [
                        *(_candidate_title_values(card)),
                        card["setName"],
                        card["number"],
                        card.get("setID") or "",
                    ]
                )
            )
        )
        score = float(len(set(tokens) & haystack_tokens))
        if query and any(query.lower() in value.lower() for value in _candidate_title_values(card)):
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


def upsert_price_history_daily(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    pricing_mode: str,
    provider: str,
    price_date: str,
    currency_code: str,
    variant: str | None = None,
    condition: str | None = None,
    grader: str | None = None,
    grade: str | None = None,
    is_perfect: bool = False,
    is_signed: bool = False,
    is_error: bool = False,
    low_price: float | None = None,
    market_price: float | None = None,
    mid_price: float | None = None,
    high_price: float | None = None,
    source_url: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    history_id = ":".join(
        [
            card_id,
            pricing_mode,
            provider,
            price_date,
            (variant or "").strip(),
            (condition or "").strip(),
            (grader or "").strip(),
            (grade or "").strip(),
            "1" if is_perfect else "0",
            "1" if is_signed else "0",
            "1" if is_error else "0",
        ]
    )
    connection.execute(
        """
        INSERT INTO card_price_history_daily (
            id, card_id, pricing_mode, provider, price_date, currency_code, variant, condition,
            grader, grade, is_perfect, is_signed, is_error, low_price, market_price, mid_price,
            high_price, source_url, source_payload_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            currency_code=excluded.currency_code,
            low_price=excluded.low_price,
            market_price=excluded.market_price,
            mid_price=excluded.mid_price,
            high_price=excluded.high_price,
            source_url=excluded.source_url,
            source_payload_json=excluded.source_payload_json,
            updated_at=excluded.updated_at
        """,
        (
            history_id,
            card_id,
            pricing_mode,
            provider,
            price_date,
            currency_code,
            variant,
            condition,
            grader,
            grade,
            1 if is_perfect else 0,
            1 if is_signed else 0,
            1 if is_error else 0,
            low_price,
            market_price,
            mid_price,
            high_price,
            source_url,
            json.dumps(payload or {}),
            utc_now(),
        ),
    )


def price_history_rows_for_card(
    connection: sqlite3.Connection,
    card_id: str,
    *,
    pricing_mode: str,
    provider: str,
    days: int,
    variant: str | None = None,
    condition: str | None = None,
    grader: str | None = None,
    grade: str | None = None,
    is_perfect: bool | None = None,
    is_signed: bool | None = None,
    is_error: bool | None = None,
) -> list[dict[str, Any]]:
    query = """
        SELECT *
        FROM card_price_history_daily
        WHERE card_id = ? AND pricing_mode = ? AND provider = ?
    """
    params: list[Any] = [card_id, pricing_mode, provider]
    if variant is not None:
        query += " AND variant = ?"
        params.append(variant)
    if condition is not None:
        query += " AND condition = ?"
        params.append(condition)
    if grader is not None:
        query += " AND grader = ?"
        params.append(grader)
    if grade is not None:
        query += " AND grade = ?"
        params.append(grade)
    if is_perfect is not None:
        query += " AND is_perfect = ?"
        params.append(1 if is_perfect else 0)
    if is_signed is not None:
        query += " AND is_signed = ?"
        params.append(1 if is_signed else 0)
    if is_error is not None:
        query += " AND is_error = ?"
        params.append(1 if is_error else 0)
    query += " ORDER BY price_date DESC LIMIT ?"
    params.append(max(1, int(days)))
    rows = connection.execute(query, params).fetchall()
    return [
        {
            "id": row["id"],
            "cardID": row["card_id"],
            "pricingMode": row["pricing_mode"],
            "provider": row["provider"],
            "date": row["price_date"],
            "currencyCode": row["currency_code"],
            "variant": row["variant"],
            "condition": row["condition"],
            "grader": row["grader"],
            "grade": row["grade"],
            "isPerfect": bool(row["is_perfect"]),
            "isSigned": bool(row["is_signed"]),
            "isError": bool(row["is_error"]),
            "low": row["low_price"],
            "market": row["market_price"],
            "mid": row["mid_price"],
            "high": row["high_price"],
            "sourceURL": row["source_url"],
            "payload": _json_load(row["source_payload_json"], {}),
            "updatedAt": row["updated_at"],
        }
        for row in rows
    ]


def latest_price_history_update_for_context(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    pricing_mode: str,
    provider: str,
    variant: str | None = None,
    condition: str | None = None,
    grader: str | None = None,
    grade: str | None = None,
    is_perfect: bool | None = None,
    is_signed: bool | None = None,
    is_error: bool | None = None,
) -> str | None:
    query = """
        SELECT updated_at
        FROM card_price_history_daily
        WHERE card_id = ? AND pricing_mode = ? AND provider = ?
    """
    params: list[Any] = [card_id, pricing_mode, provider]
    if variant is not None:
        query += " AND variant = ?"
        params.append(variant)
    if condition is not None:
        query += " AND condition = ?"
        params.append(condition)
    if grader is not None:
        query += " AND grader = ?"
        params.append(grader)
    if grade is not None:
        query += " AND grade = ?"
        params.append(grade)
    if is_perfect is not None:
        query += " AND is_perfect = ?"
        params.append(1 if is_perfect else 0)
    if is_signed is not None:
        query += " AND is_signed = ?"
        params.append(1 if is_signed else 0)
    if is_error is not None:
        query += " AND is_error = ?"
        params.append(1 if is_error else 0)
    query += " ORDER BY updated_at DESC LIMIT 1"
    row = connection.execute(query, params).fetchone()
    if row is None:
        return None
    return str(row["updated_at"] or "").strip() or None


def upsert_fx_rate_snapshot(
    connection: sqlite3.Connection,
    *,
    base_currency: str,
    quote_currency: str,
    rate: float,
    source: str,
    effective_at: str | None = None,
    source_url: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    snapshot_id = f"{base_currency.upper()}:{quote_currency.upper()}:{source}"
    connection.execute(
        """
        INSERT INTO fx_rate_snapshots (
            id, base_currency, quote_currency, rate, source, effective_at,
            source_url, source_payload_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            rate=excluded.rate,
            effective_at=excluded.effective_at,
            source_url=excluded.source_url,
            source_payload_json=excluded.source_payload_json,
            updated_at=excluded.updated_at
        """,
        (
            snapshot_id,
            base_currency.upper(),
            quote_currency.upper(),
            rate,
            source,
            effective_at,
            source_url,
            json.dumps(payload or {}),
            utc_now(),
        ),
    )


def fx_rate_snapshot_for_pair(
    connection: sqlite3.Connection,
    base_currency: str,
    quote_currency: str,
) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT *
        FROM fx_rate_snapshots
        WHERE base_currency = ? AND quote_currency = ?
        ORDER BY updated_at DESC
        LIMIT 1
        """,
        (base_currency.upper(), quote_currency.upper()),
    ).fetchone()
    if row is None:
        return None
    updated_at = row["updated_at"]
    is_fresh = False
    if updated_at:
        try:
            refreshed = datetime.fromisoformat(str(updated_at))
            is_fresh = datetime.now(timezone.utc) - refreshed <= timedelta(hours=24)
        except ValueError:
            is_fresh = False
    return {
        "id": row["id"],
        "baseCurrency": row["base_currency"],
        "quoteCurrency": row["quote_currency"],
        "rate": row["rate"],
        "source": row["source"],
        "effectiveAt": row["effective_at"],
        "sourceURL": row["source_url"],
        "refreshedAt": row["updated_at"],
        "payload": _json_load(row["source_payload_json"], {}),
        "isFresh": is_fresh,
    }


def price_snapshot_for_card(
    connection: sqlite3.Connection,
    card_id: str,
    *,
    pricing_mode: str,
    grader: str | None = None,
    grade: str | None = None,
    variant: str | None = None,
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
    if variant is not None:
        query += " AND variant = ?"
        params.append(variant)
    query += " ORDER BY updated_at DESC LIMIT 1"
    row = connection.execute(query, params).fetchone()
    if row is None:
        return None
    updated_at = row["updated_at"]
    is_fresh = False
    if updated_at:
        try:
            refreshed = datetime.fromisoformat(str(updated_at))
            is_fresh = datetime.now(timezone.utc) - refreshed <= timedelta(hours=24)
        except ValueError:
            is_fresh = False
    payload = _json_load(row["source_payload_json"], {})
    pricing_mode = row["pricing_mode"]
    return {
        "id": row["id"],
        "cardID": row["card_id"],
        "pricingMode": "psa_grade_estimate" if pricing_mode == PSA_GRADE_PRICING_MODE else pricing_mode,
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
        "pricingTier": payload.get("pricingTier"),
        "confidenceLabel": payload.get("confidenceLabel"),
        "confidenceLevel": payload.get("confidenceLevel"),
        "compCount": payload.get("compCount"),
        "recentCompCount": payload.get("recentCompCount"),
        "lastSoldPrice": payload.get("lastSalePrice"),
        "lastSoldAt": payload.get("lastSaleDate"),
        "bucketKey": payload.get("bucketKey"),
        "methodologySummary": payload.get("summary"),
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
    variant: str | None = None,
) -> dict[str, Any] | None:
    if grader or grade:
        return price_snapshot_for_card(
            connection,
            card_id,
            pricing_mode=PSA_GRADE_PRICING_MODE,
            grader=grader,
            grade=grade,
            variant=variant,
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
    variant: str | None = None,
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
        variant=variant or f"{grader} {grade}",
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
    predicted_card_id: str | None = None,
    selected_card_id: str | None = None,
    selected_rank: int | None = None,
    was_top_prediction: bool | None = None,
    selection_source: str | None = None,
    confirmed_card_id: str | None = None,
    confirmation_source: str | None = None,
    deck_entry_id: str | None = None,
    confidence: str | None = None,
    review_disposition: str | None = None,
    correction_type: str | None = None,
    resolver_mode: str | None = None,
    resolver_path: str | None = None,
    completed_at: str | None = None,
    confirmed_at: str | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO scan_events (
            scan_id, created_at, resolver_mode, resolver_path,
            request_json, response_json, matcher_source, matcher_version,
            predicted_card_id, selected_card_id, selected_rank, was_top_prediction,
            selection_source, confirmed_card_id, confirmation_source, deck_entry_id,
            confidence, review_disposition, correction_type, completed_at, confirmed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scan_id) DO UPDATE SET
            resolver_mode=excluded.resolver_mode,
            resolver_path=excluded.resolver_path,
            request_json=excluded.request_json,
            response_json=excluded.response_json,
            matcher_source=excluded.matcher_source,
            matcher_version=excluded.matcher_version,
            predicted_card_id=excluded.predicted_card_id,
            selected_card_id=excluded.selected_card_id,
            selected_rank=excluded.selected_rank,
            was_top_prediction=excluded.was_top_prediction,
            selection_source=excluded.selection_source,
            confirmed_card_id=excluded.confirmed_card_id,
            confirmation_source=excluded.confirmation_source,
            deck_entry_id=excluded.deck_entry_id,
            confidence=excluded.confidence,
            review_disposition=excluded.review_disposition,
            correction_type=excluded.correction_type,
            completed_at=excluded.completed_at,
            confirmed_at=excluded.confirmed_at
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
            predicted_card_id,
            selected_card_id,
            selected_rank,
            None if was_top_prediction is None else (1 if was_top_prediction else 0),
            selection_source,
            confirmed_card_id,
            confirmation_source,
            deck_entry_id,
            confidence,
            review_disposition,
            correction_type,
            completed_at,
            confirmed_at,
        ),
    )


def replace_scan_prediction_candidates(
    connection: sqlite3.Connection,
    *,
    scan_id: str,
    candidates: list[dict[str, Any]],
) -> None:
    if not _table_exists(connection, "scan_prediction_candidates"):
        return

    connection.execute("DELETE FROM scan_prediction_candidates WHERE scan_id = ?", (scan_id,))
    for rank, candidate in enumerate(candidates, start=1):
        candidate_payload = candidate.get("candidate") or {}
        card_id = str(candidate_payload.get("id") or "").strip()
        if not _card_exists(connection, card_id):
            continue
        connection.execute(
            """
            INSERT INTO scan_prediction_candidates (
                scan_id, rank, card_id, final_score, candidate_json
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                scan_id,
                rank,
                card_id,
                float(candidate.get("finalScore") or 0.0),
                json.dumps(candidate),
            ),
        )


def replace_scan_price_observations(
    connection: sqlite3.Connection,
    *,
    scan_id: str,
    candidates: list[dict[str, Any]],
    observed_at: str | None = None,
) -> None:
    if not _table_exists(connection, "scan_price_observations"):
        return

    connection.execute("DELETE FROM scan_price_observations WHERE scan_id = ?", (scan_id,))
    recorded_at = observed_at or utc_now()
    for rank, candidate in enumerate(candidates, start=1):
        candidate_payload = candidate.get("candidate") or {}
        card_id = str(candidate_payload.get("id") or "").strip()
        if not _card_exists(connection, card_id):
            continue
        pricing = candidate_payload.get("pricing") or {}
        connection.execute(
            """
            INSERT INTO scan_price_observations (
                scan_id, rank, card_id, pricing_source, pricing_mode, grader, grade,
                variant, currency_code, low_price, market_price, mid_price, high_price,
                trend_price, source_updated_at, snapshot_updated_at, observed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                scan_id,
                rank,
                card_id,
                pricing.get("source"),
                pricing.get("pricingMode"),
                pricing.get("grader"),
                pricing.get("grade"),
                pricing.get("variant"),
                pricing.get("currencyCode"),
                pricing.get("low"),
                pricing.get("market"),
                pricing.get("mid"),
                pricing.get("high"),
                pricing.get("trend"),
                pricing.get("updatedAt") or pricing.get("sourceUpdatedAt"),
                pricing.get("refreshedAt"),
                recorded_at,
            ),
        )


def upsert_scan_artifact(
    connection: sqlite3.Connection,
    *,
    scan_id: str,
    source_object_path: str,
    normalized_object_path: str,
    source_width: int | None = None,
    source_height: int | None = None,
    normalized_width: int | None = None,
    normalized_height: int | None = None,
    camera_zoom_factor: float | None = None,
    capture_source: str | None = None,
    upload_status: str = "uploaded",
    uploaded_at: str | None = None,
    artifact_version: str = "v1",
    created_at: str | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO scan_artifacts (
            scan_id, source_object_path, normalized_object_path, source_width, source_height,
            normalized_width, normalized_height, camera_zoom_factor, capture_source,
            upload_status, uploaded_at, artifact_version, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scan_id) DO UPDATE SET
            source_object_path=excluded.source_object_path,
            normalized_object_path=excluded.normalized_object_path,
            source_width=excluded.source_width,
            source_height=excluded.source_height,
            normalized_width=excluded.normalized_width,
            normalized_height=excluded.normalized_height,
            camera_zoom_factor=excluded.camera_zoom_factor,
            capture_source=excluded.capture_source,
            upload_status=excluded.upload_status,
            uploaded_at=excluded.uploaded_at,
            artifact_version=excluded.artifact_version
        """,
        (
            scan_id,
            source_object_path,
            normalized_object_path,
            source_width,
            source_height,
            normalized_width,
            normalized_height,
            camera_zoom_factor,
            capture_source,
            upload_status,
            uploaded_at or utc_now(),
            artifact_version,
            created_at or utc_now(),
        ),
    )


def deck_entry_storage_key(
    *,
    card_id: str,
    grader: str | None = None,
    grade: str | None = None,
    cert_number: str | None = None,
    variant_name: str | None = None,
) -> str:
    normalized_card_id = str(card_id or "").strip()
    if not any(str(value or "").strip() for value in (grader, grade, cert_number, variant_name)):
        return f"raw|{normalized_card_id}"
    return "|".join(
        [
            "slab",
            normalized_card_id,
            str(grader or "").strip(),
            str(grade or "").strip(),
            str(cert_number or "").strip(),
            str(variant_name or "").strip(),
        ]
    )


def upsert_deck_entry(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    grader: str | None = None,
    grade: str | None = None,
    cert_number: str | None = None,
    variant_name: str | None = None,
    condition: str | None = None,
    quantity: int = 1,
    added_at: str | None = None,
    updated_at: str | None = None,
    source_scan_id: str | None = None,
    source_confirmation_id: str | None = None,
) -> str:
    deck_entry_id = deck_entry_storage_key(
        card_id=card_id,
        grader=grader,
        grade=grade,
        cert_number=cert_number,
        variant_name=variant_name,
    )
    item_kind = "slab" if deck_entry_id.startswith("slab|") else "raw"
    normalized_quantity = max(1, int(quantity))
    connection.execute(
        """
        INSERT INTO deck_entries (
            id, item_kind, card_id, grader, grade, cert_number, variant_name,
            condition, quantity, added_at, updated_at, source_scan_id, source_confirmation_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            card_id=excluded.card_id,
            grader=excluded.grader,
            grade=excluded.grade,
            cert_number=excluded.cert_number,
            variant_name=excluded.variant_name,
            condition=COALESCE(excluded.condition, deck_entries.condition),
            quantity=deck_entries.quantity + excluded.quantity,
            updated_at=excluded.updated_at,
            source_scan_id=excluded.source_scan_id,
            source_confirmation_id=excluded.source_confirmation_id
        """,
        (
            deck_entry_id,
            item_kind,
            card_id,
            grader,
            grade,
            cert_number,
            variant_name,
            str(condition or "").strip() or None,
            normalized_quantity,
            added_at or utc_now(),
            updated_at or utc_now(),
            source_scan_id,
            source_confirmation_id,
        ),
    )
    return deck_entry_id


def upsert_scan_confirmation(
    connection: sqlite3.Connection,
    *,
    scan_id: str,
    confirmed_card_id: str,
    confirmation_source: str,
    selected_rank: int | None = None,
    was_top_prediction: bool = False,
    deck_entry_id: str | None = None,
    created_at: str | None = None,
) -> str:
    confirmation_id = scan_id
    connection.execute(
        """
        INSERT INTO scan_confirmations (
            id, scan_id, confirmed_card_id, confirmation_source,
            selected_rank, was_top_prediction, deck_entry_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            confirmed_card_id=excluded.confirmed_card_id,
            confirmation_source=excluded.confirmation_source,
            selected_rank=excluded.selected_rank,
            was_top_prediction=excluded.was_top_prediction,
            deck_entry_id=excluded.deck_entry_id,
            created_at=excluded.created_at
        """,
        (
            confirmation_id,
            scan_id,
            confirmed_card_id,
            confirmation_source,
            selected_rank,
            1 if was_top_prediction else 0,
            deck_entry_id,
            created_at or utc_now(),
        ),
    )
    return confirmation_id


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
                payload={
                    "provider": str(card.get("source") or card.get("sourceProvider") or "scrydex"),
                    "priceSource": "tcgplayer",
                },
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


def _candidate_title_values(card: dict[str, Any]) -> tuple[str, ...]:
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


def _candidate_source_expansion_values(card: dict[str, Any]) -> tuple[str, ...]:
    source_payload = card.get("sourcePayload") or {}
    if not isinstance(source_payload, dict):
        return tuple()
    expansion = source_payload.get("expansion")
    if not isinstance(expansion, dict):
        return tuple()
    return tuple(
        str(value).strip()
        for value in [
            expansion.get("name"),
            expansion.get("series"),
            expansion.get("id"),
            expansion.get("code"),
        ]
        if str(value or "").strip()
    )


def _title_overlap(card: dict[str, Any], evidence: RawEvidence) -> float:
    query_tokens = set(tokenize(" ".join(filter(None, [evidence.title_text_primary, evidence.title_text_secondary]))))
    if not query_tokens:
        return _japanese_title_fuzzy_overlap(card, evidence)
    candidate_tokens: set[str] = set()
    for value in _candidate_title_values(card):
        candidate_tokens.update(tokenize(value))
    exact_overlap = len(query_tokens & candidate_tokens) / max(1, len(query_tokens))
    if exact_overlap > 0.0:
        return exact_overlap
    return _japanese_title_fuzzy_overlap(card, evidence)


def _set_overlap(card: dict[str, Any], evidence: RawEvidence) -> float:
    query_tokens = set(evidence.trusted_set_hint_tokens or evidence.set_hint_tokens)
    if not query_tokens:
        return 0.0
    exact_candidate_tokens = {
        str(card.get("setID") or "").lower(),
        str(card.get("setPtcgoCode") or "").lower(),
    }
    source_payload = card.get("sourcePayload") or {}
    if isinstance(source_payload, dict):
        expansion = source_payload.get("expansion")
        if isinstance(expansion, dict):
            exact_candidate_tokens.update({
                str(expansion.get("id") or "").lower(),
                str(expansion.get("code") or "").lower(),
            })
    candidate_tokens = set(
        tokenize(
            " ".join(
                part
                for part in [
                    card.get("setName") or "",
                    card.get("setSeries") or "",
                    card.get("setID") or "",
                    card.get("setPtcgoCode") or "",
                    *(_candidate_source_expansion_values(card)),
                ]
                if part
            )
        )
    )
    overlap = len(query_tokens & candidate_tokens)
    if any(token in exact_candidate_tokens for token in query_tokens):
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
    alias_map = _card_title_aliases_by_card_ids(connection, [str(row["id"]) for row in rows])
    return [
        card
        for card in (
            _card_row_to_dict(row, title_aliases=alias_map.get(str(row["id"]), ()))
            for row in rows
        )
        if card is not None
    ]


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
    set_badge_image_score = 0.0
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
        + set_badge_image_score
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
        set_badge_image_score=round(set_badge_image_score, 4),
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
                    set_badge_image_score=breakdown.set_badge_image_score,
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


def visual_hybrid_weights(signals: RawSignalScores) -> tuple[float, float]:
    ocr_weight = 0.12
    if signals.collector_signal >= 95:
        ocr_weight += 0.08
    elif signals.collector_signal >= 60:
        ocr_weight += 0.05
    if signals.set_signal >= 75:
        ocr_weight += 0.05
    elif signals.set_signal >= 65:
        ocr_weight += 0.03
    if signals.title_signal >= 80:
        ocr_weight += 0.05
    elif signals.title_signal >= 35:
        ocr_weight += 0.02

    ocr_weight = min(0.30, max(0.12, ocr_weight))
    visual_weight = round(1.0 - ocr_weight, 4)
    return visual_weight, round(ocr_weight, 4)


def _hybrid_visual_leader_state(candidates: list[dict[str, Any]]) -> tuple[str | None, float, float, bool]:
    if not candidates:
        return None, 0.0, 0.0, False
    ranked = sorted(
        candidates,
        key=lambda candidate: -float(candidate.get("_visualSimilarity") or 0.0),
    )
    leader = ranked[0]
    leader_id = str(leader.get("id") or "")
    leader_similarity = float(leader.get("_visualSimilarity") or 0.0)
    runner_up_similarity = float(ranked[1].get("_visualSimilarity") or 0.0) if len(ranked) > 1 else 0.0
    leader_margin = max(0.0, leader_similarity - runner_up_similarity)
    is_protected = leader_similarity >= 0.80 and leader_margin >= 0.01
    return leader_id or None, leader_similarity, leader_margin, is_protected


def _has_strong_hybrid_corroboration(breakdown: RawCandidateScoreBreakdown) -> bool:
    if breakdown.collector_exact_score > 0.0:
        return True
    if breakdown.title_overlap_score > 0.0 and (
        breakdown.collector_partial_score > 0.0
        or breakdown.footer_text_support_score > 0.0
    ):
        return True
    return False


def _cap_hybrid_resolution_breakdown(
    breakdown: RawCandidateScoreBreakdown,
    retrieval_total: float,
    resolution_total: float,
    final_total: float,
    cap: float,
) -> RawCandidateScoreBreakdown:
    if resolution_total <= cap or resolution_total <= 0.0:
        return RawCandidateScoreBreakdown(
            title_overlap_score=breakdown.title_overlap_score,
            set_overlap_score=breakdown.set_overlap_score,
            set_badge_image_score=breakdown.set_badge_image_score,
            collector_exact_score=breakdown.collector_exact_score,
            collector_partial_score=breakdown.collector_partial_score,
            collector_denominator_score=breakdown.collector_denominator_score,
            footer_text_support_score=breakdown.footer_text_support_score,
            promo_support_score=breakdown.promo_support_score,
            cache_presence_score=breakdown.cache_presence_score,
            contradiction_penalty=breakdown.contradiction_penalty,
            retrieval_total=round(retrieval_total, 4),
            resolution_total=round(resolution_total, 4),
            final_total=round(final_total, 4),
        )

    factor = cap / max(resolution_total, 0.0001)
    return RawCandidateScoreBreakdown(
        title_overlap_score=round(breakdown.title_overlap_score * factor, 4),
        set_overlap_score=round(breakdown.set_overlap_score * factor, 4),
        set_badge_image_score=round(breakdown.set_badge_image_score * factor, 4),
        collector_exact_score=round(breakdown.collector_exact_score * factor, 4),
        collector_partial_score=round(breakdown.collector_partial_score * factor, 4),
        collector_denominator_score=round(breakdown.collector_denominator_score * factor, 4),
        footer_text_support_score=round(breakdown.footer_text_support_score * factor, 4),
        promo_support_score=round(breakdown.promo_support_score * factor, 4),
        cache_presence_score=round(breakdown.cache_presence_score * factor, 4),
        contradiction_penalty=round(breakdown.contradiction_penalty * factor, 4),
        retrieval_total=round(retrieval_total, 4),
        resolution_total=round(cap, 4),
        final_total=round(final_total, 4),
    )


def _hybrid_set_confidence_multiplier(evidence: RawEvidence, breakdown: RawCandidateScoreBreakdown) -> float:
    if breakdown.set_overlap_score <= 0.0:
        return 1.0
    if evidence.set_confidence_score <= 0.30:
        return 0.25
    if evidence.set_confidence_score < 0.48:
        return 0.60
    return 1.0


def _apply_hybrid_set_confidence(
    breakdown: RawCandidateScoreBreakdown,
    resolution_total: float,
    evidence: RawEvidence,
) -> tuple[RawCandidateScoreBreakdown, float, float]:
    multiplier = _hybrid_set_confidence_multiplier(evidence, breakdown)
    if abs(multiplier - 1.0) < 0.0001:
        return breakdown, resolution_total, 1.0

    adjusted_set_overlap = round(breakdown.set_overlap_score * multiplier, 4)
    adjusted_resolution_total = round(
        resolution_total - breakdown.set_overlap_score + adjusted_set_overlap,
        4,
    )
    return (
        RawCandidateScoreBreakdown(
            title_overlap_score=breakdown.title_overlap_score,
            set_overlap_score=adjusted_set_overlap,
            set_badge_image_score=breakdown.set_badge_image_score,
            collector_exact_score=breakdown.collector_exact_score,
            collector_partial_score=breakdown.collector_partial_score,
            collector_denominator_score=breakdown.collector_denominator_score,
            footer_text_support_score=breakdown.footer_text_support_score,
            promo_support_score=breakdown.promo_support_score,
            cache_presence_score=breakdown.cache_presence_score,
            contradiction_penalty=breakdown.contradiction_penalty,
            retrieval_total=breakdown.retrieval_total,
            resolution_total=adjusted_resolution_total,
            final_total=breakdown.final_total,
        ),
        adjusted_resolution_total,
        multiplier,
    )


def rank_visual_hybrid_candidates(
    candidates: list[dict[str, Any]],
    evidence: RawEvidence,
    signals: RawSignalScores,
) -> tuple[list[RawCandidateMatch], dict[str, float]]:
    visual_weight, ocr_weight = visual_hybrid_weights(signals)
    visual_leader_id, visual_leader_similarity, visual_leader_margin, leader_protection_active = _hybrid_visual_leader_state(candidates)
    ranked: list[RawCandidateMatch] = []
    protected_candidate_cap = 12.0

    for candidate in candidates:
        visual_similarity = float(candidate.get("_visualSimilarity") or 0.0)
        visual_score = max(0.0, min(100.0, round(visual_similarity * 100.0, 4)))
        resolution_score, breakdown, reasons = score_raw_candidate_resolution(candidate, evidence)
        breakdown, resolution_score, set_confidence_multiplier = _apply_hybrid_set_confidence(
            breakdown,
            resolution_score,
            evidence,
        )
        protection_applied = False
        if (
            leader_protection_active
            and str(candidate.get("id") or "") != visual_leader_id
            and not _has_strong_hybrid_corroboration(breakdown)
            and resolution_score > protected_candidate_cap
        ):
            resolution_score = protected_candidate_cap
            protection_applied = True
        final_total = max(
            0.0,
            min(
                100.0,
                round((visual_score * visual_weight) + (resolution_score * ocr_weight), 4),
            ),
        )
        adjusted_breakdown = _cap_hybrid_resolution_breakdown(
            breakdown,
            retrieval_total=visual_score,
            resolution_total=resolution_score,
            final_total=final_total,
            cap=protected_candidate_cap if protection_applied else resolution_score,
        )
        reason_tokens = ["visual_similarity", *reasons]
        if set_confidence_multiplier < 1.0:
            reason_tokens.append("set_confidence_dampened")
        if protection_applied:
            reason_tokens.append("visual_leader_protected")
        ranked.append(
            RawCandidateMatch(
                card=candidate,
                retrieval_score=visual_score,
                resolution_score=round(resolution_score, 4),
                final_total=final_total,
                breakdown=adjusted_breakdown,
                reasons=tuple(dict.fromkeys(reason_tokens)),
            )
        )

    ranked.sort(key=lambda match: (-match.final_total, match.card["name"], match.card["number"]))
    return ranked, {
        "visualWeight": visual_weight,
        "ocrWeight": ocr_weight,
        "visualLeaderProtectionActive": 1.0 if leader_protection_active else 0.0,
        "visualLeaderSimilarity": round(visual_leader_similarity, 6),
        "visualLeaderMargin": round(visual_leader_margin, 6),
        "setConfidenceMultiplier": _hybrid_set_confidence_multiplier(
            evidence,
            RawCandidateScoreBreakdown(
                title_overlap_score=0.0,
                set_overlap_score=1.0,
                set_badge_image_score=0.0,
                collector_exact_score=0.0,
                collector_partial_score=0.0,
                collector_denominator_score=0.0,
                footer_text_support_score=0.0,
                promo_support_score=0.0,
                cache_presence_score=0.0,
                contradiction_penalty=0.0,
                retrieval_total=0.0,
                resolution_total=0.0,
                final_total=0.0,
            ),
        ),
    }


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

    if not matches and _raw_looks_like_japanese_provider_gap(evidence):
        return RawDecisionResult(
            matches=tuple(),
            top_candidates=tuple(),
            confidence="low",
            confidence_percent=0.0,
            ambiguity_flags=(
                "No candidates were available.",
                "Japanese raw cards are not currently supported by the active provider.",
            ),
            resolver_path="visual_fallback",
            review_disposition="unsupported",
            review_reason="Japanese raw cards are not currently supported by the active raw provider.",
            fallback_reason="provider_unsupported_japanese",
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
    top_candidates = tuple(matches[:10])
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
            "setBadgeHintKind": evidence.set_badge_hint_kind,
            "setBadgeHintSource": evidence.set_badge_hint_source,
            "setBadgeHintRawValue": evidence.set_badge_hint_raw_value,
            "setHintTokens": list(evidence.set_hint_tokens),
            "trustedSetHintTokens": list(evidence.trusted_set_hint_tokens),
            "promoCodeHint": evidence.promo_code_hint,
            "cropConfidence": evidence.crop_confidence,
            "titleConfidenceScore": evidence.title_confidence_score,
            "collectorConfidenceScore": evidence.collector_confidence_score,
            "setConfidenceScore": evidence.set_confidence_score,
            "usedFallbackNormalization": evidence.used_fallback_normalization,
            "targetQualityScore": evidence.target_quality_score,
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
                    "setBadgeImage": match.breakdown.set_badge_image_score,
                    "collectorExact": match.breakdown.collector_exact_score,
                    "collectorPartial": match.breakdown.collector_partial_score,
                    "collectorDenominator": match.breakdown.collector_denominator_score,
                    "footerSupport": match.breakdown.footer_text_support_score,
                    "promoSupport": match.breakdown.promo_support_score,
                    "cachePresence": match.breakdown.cache_presence_score,
                    "contradictionPenalty": match.breakdown.contradiction_penalty,
                },
            }
            for match in matches[:10]
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
