from __future__ import annotations

import json
import os
import re
import shlex
import sqlite3
import uuid
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

DEFAULT_RAW_CONDITION_CODE = "NM"
DEFAULT_RAW_VARIANT_PREFERENCE = (
    "normal",
    "holofoil",
    "reverseholofoil",
)


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


def connect(
    database_path: Path | str,
    *,
    timeout_seconds: float = 5.0,
    busy_timeout_ms: int | None = None,
) -> sqlite3.Connection:
    connection = sqlite3.connect(str(database_path), timeout=timeout_seconds)
    connection.row_factory = sqlite3.Row
    connection.execute(f"PRAGMA busy_timeout = {busy_timeout_ms or int(timeout_seconds * 1000)}")
    connection.execute("PRAGMA foreign_keys = ON")
    if str(database_path) != ":memory:":
        try:
            connection.execute("PRAGMA journal_mode = WAL")
        except sqlite3.DatabaseError:
            pass
    for pragma in (
        "PRAGMA synchronous = NORMAL",
        "PRAGMA temp_store = MEMORY",
        "PRAGMA wal_autocheckpoint = 1000",
    ):
        try:
            connection.execute(pragma)
        except sqlite3.DatabaseError:
            pass
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


def _relax_scan_artifacts_nullability(connection: sqlite3.Connection) -> None:
    """Drop the NOT NULL constraint on scan_artifacts.source_object_path /
    normalized_object_path on pre-existing DBs.

    SQLite cannot ALTER away a NOT NULL constraint, so we do the standard
    table-rebuild. This lets a scan persist only the normalized_target (when the
    optional source image is missing) or write a 'failed' observability row.
    Runs only when the live table still has notnull=1; idempotent afterward.
    """
    if not _table_exists(connection, "scan_artifacts"):
        return
    notnull_by_column = {
        str(row[1]): int(row[3])
        for row in connection.execute("PRAGMA table_info(scan_artifacts)").fetchall()
    }
    if not (notnull_by_column.get("source_object_path") or notnull_by_column.get("normalized_object_path")):
        return  # already relaxed

    # Copy only columns shared between the rebuilt table and the existing one so
    # the migration is robust to any columns added by earlier migration steps.
    new_columns = [
        "scan_id", "owner_user_id", "source_object_path", "normalized_object_path",
        "source_width", "source_height", "normalized_width", "normalized_height",
        "camera_zoom_factor", "capture_source", "upload_status", "uploaded_at",
        "artifact_version", "created_at",
    ]
    existing_columns = _table_columns(connection, "scan_artifacts")
    shared_columns = [column for column in new_columns if column in existing_columns]
    column_list = ", ".join(shared_columns)

    previous_fk_state = connection.execute("PRAGMA foreign_keys").fetchone()[0]
    connection.execute("PRAGMA foreign_keys = OFF")
    try:
        connection.execute("DROP TABLE IF EXISTS scan_artifacts_relaxed_migration")
        connection.execute(
            """
            CREATE TABLE scan_artifacts_relaxed_migration (
                scan_id TEXT PRIMARY KEY REFERENCES scan_events(scan_id) ON DELETE CASCADE,
                owner_user_id TEXT,
                source_object_path TEXT,
                normalized_object_path TEXT,
                source_width INTEGER,
                source_height INTEGER,
                normalized_width INTEGER,
                normalized_height INTEGER,
                camera_zoom_factor REAL,
                capture_source TEXT,
                upload_status TEXT NOT NULL,
                uploaded_at TEXT,
                artifact_version TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            f"INSERT INTO scan_artifacts_relaxed_migration ({column_list}) "
            f"SELECT {column_list} FROM scan_artifacts"
        )
        connection.execute("DROP TABLE scan_artifacts")
        connection.execute("ALTER TABLE scan_artifacts_relaxed_migration RENAME TO scan_artifacts")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_scan_artifacts_owner_user_id "
            "ON scan_artifacts(owner_user_id, created_at DESC)"
        )
    finally:
        connection.execute(f"PRAGMA foreign_keys = {previous_fk_state}")
    connection.commit()


def _apply_additive_runtime_migrations(connection: sqlite3.Connection) -> None:
    # Additive scan/dataset schema changes must not trigger the destructive reset path.
    scan_event_columns = {
        "owner_user_id": "TEXT",
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

    labeling_session_columns = {
        "labeler_user_id": "TEXT",
        "provider_card_id": "TEXT",
        "tier_assignment": "TEXT CHECK(tier_assignment IN ('tier2', 'tier3'))",
        "routed_batch_id": "TEXT",
        "first_capture_scan_id": "TEXT",
    }
    for column_name, column_sql in labeling_session_columns.items():
        _add_column_if_missing(connection, "labeling_sessions", column_name, column_sql)

    labeling_artifact_columns = {
        "scan_id": "TEXT",
        "dataset_role": "TEXT CHECK(dataset_role IN ('tier2', 'tier3'))",
    }
    for column_name, column_sql in labeling_artifact_columns.items():
        _add_column_if_missing(connection, "labeling_session_artifacts", column_name, column_sql)

    _add_column_if_missing(connection, "scan_artifacts", "owner_user_id", "TEXT")
    _relax_scan_artifacts_nullability(connection)
    _add_column_if_missing(connection, "scan_confirmations", "owner_user_id", "TEXT")
    _add_column_if_missing(connection, "deck_entries", "owner_user_id", "TEXT")
    _add_column_if_missing(connection, "deck_entries", "identity_key", "TEXT")
    _add_column_if_missing(connection, "deck_entries", "quantity", "INTEGER NOT NULL DEFAULT 1")
    _add_column_if_missing(connection, "deck_entries", "cost_basis_total", "REAL NOT NULL DEFAULT 0")
    _add_column_if_missing(connection, "deck_entries", "cost_basis_currency_code", "TEXT")
    _add_column_if_missing(connection, "deck_entries", "condition", "TEXT")
    _add_column_if_missing(connection, "sale_events", "owner_user_id", "TEXT")
    _add_column_if_missing(connection, "sale_events", "cost_basis_total", "REAL")
    _add_column_if_missing(connection, "sale_events", "cost_basis_unit_price", "REAL")
    _add_column_if_missing(connection, "sale_events", "paid_at", "TEXT")
    _add_column_if_missing(connection, "sale_events", "voided_at", "TEXT")
    _add_column_if_missing(connection, "deck_entry_events", "owner_user_id", "TEXT")
    _add_column_if_missing(connection, "deck_entry_events", "unit_price", "REAL")
    _add_column_if_missing(connection, "deck_entry_events", "total_price", "REAL")
    _add_column_if_missing(connection, "deck_entry_events", "currency_code", "TEXT")
    _add_column_if_missing(connection, "deck_entry_events", "payment_method", "TEXT")
    _add_column_if_missing(connection, "portfolio_import_jobs", "owner_user_id", "TEXT")
    if _table_exists(connection, "labeling_sessions"):
        labeling_session_table_columns = _table_columns(connection, "labeling_sessions")
        if {"provider_card_id", "created_at"}.issubset(labeling_session_table_columns):
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_labeling_sessions_provider_card
                ON labeling_sessions(provider_card_id, created_at DESC)
                """
            )
    if _table_exists(connection, "labeling_session_artifacts"):
        labeling_artifact_table_columns = _table_columns(connection, "labeling_session_artifacts")
        if "scan_id" in labeling_artifact_table_columns:
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_labeling_session_artifacts_scan_id
                ON labeling_session_artifacts(scan_id)
                """
            )
    _backfill_deck_entry_quantities(connection)
    _backfill_user_isolation_columns(connection)


def _user_isolation_backfill_owner_user_id() -> str | None:
    candidates = [
        os.environ.get("SPOTLIGHT_LEGACY_OWNER_USER_ID"),
        os.environ.get("SPOTLIGHT_AUTH_FALLBACK_USER_ID"),
    ]
    for raw_value in candidates:
        normalized = str(raw_value or "").strip()
        if normalized:
            return normalized
    return None


def _runtime_default_owner_user_id() -> str | None:
    auth_fallback_user_id = str(os.environ.get("SPOTLIGHT_AUTH_FALLBACK_USER_ID") or "").strip()
    if auth_fallback_user_id:
        return auth_fallback_user_id
    auth_required_raw = str(os.environ.get("SPOTLIGHT_AUTH_REQUIRED") or "").strip().lower()
    auth_required = auth_required_raw in {"1", "true", "yes", "on"}
    if not auth_required:
        return "local-dev-user"
    return None


def _backfill_user_isolation_columns(connection: sqlite3.Connection) -> None:
    fallback_owner_user_id = _user_isolation_backfill_owner_user_id()

    if _table_exists(connection, "deck_entries"):
        deck_entry_columns = _table_columns(connection, "deck_entries")
        if "identity_key" in deck_entry_columns:
            rows = connection.execute(
                """
                SELECT id, card_id, grader, grade, cert_number, variant_name, condition
                FROM deck_entries
                WHERE identity_key IS NULL OR TRIM(identity_key) = ''
                """
            ).fetchall()
            for row in rows:
                identity_key = deck_entry_storage_key(
                    card_id=str(row["card_id"] or "").strip(),
                    grader=str(row["grader"] or "").strip() or None,
                    grade=str(row["grade"] or "").strip() or None,
                    cert_number=str(row["cert_number"] or "").strip() or None,
                    variant_name=str(row["variant_name"] or "").strip() or None,
                    condition=str(row["condition"] or "").strip() or None,
                )
                connection.execute(
                    "UPDATE deck_entries SET identity_key = ? WHERE id = ?",
                    (identity_key, str(row["id"] or "").strip()),
                )

        if fallback_owner_user_id and "owner_user_id" in deck_entry_columns:
            connection.execute(
                """
                UPDATE deck_entries
                SET owner_user_id = ?
                WHERE owner_user_id IS NULL OR TRIM(owner_user_id) = ''
                """,
                (fallback_owner_user_id,),
            )

    owner_backfill_tables = (
        "scan_events",
        "scan_artifacts",
        "scan_confirmations",
        "sale_events",
        "deck_entry_events",
        "portfolio_import_jobs",
    )
    if fallback_owner_user_id:
        for table_name in owner_backfill_tables:
            if not _table_exists(connection, table_name):
                continue
            if "owner_user_id" not in _table_columns(connection, table_name):
                continue
            connection.execute(
                f"""
                UPDATE {table_name}
                SET owner_user_id = ?
                WHERE owner_user_id IS NULL OR TRIM(owner_user_id) = ''
                """,
                (fallback_owner_user_id,),
            )


def _rebuild_pricing_tables_if_needed(connection: sqlite3.Connection) -> None:
    required_snapshot_columns = {
        "card_id",
        "provider",
        "display_currency_code",
        "default_raw_variant",
        "default_raw_condition",
        "default_raw_low_price",
        "default_raw_market_price",
        "default_raw_mid_price",
        "default_raw_high_price",
        "default_raw_direct_low_price",
        "default_raw_trend_price",
        "raw_contexts_json",
        "graded_contexts_json",
        "source_url",
        "source_updated_at",
        "source_payload_json",
        "updated_at",
    }
    required_history_columns = {
        "card_id",
        "provider",
        "price_date",
        "display_currency_code",
        "default_raw_variant",
        "default_raw_condition",
        "default_raw_low_price",
        "default_raw_market_price",
        "default_raw_mid_price",
        "default_raw_high_price",
        "default_raw_direct_low_price",
        "default_raw_trend_price",
        "raw_contexts_json",
        "graded_contexts_json",
        "source_url",
        "source_payload_json",
        "updated_at",
    }

    rebuild_snapshot = _table_exists(connection, "card_price_snapshots") and not required_snapshot_columns.issubset(
        _table_columns(connection, "card_price_snapshots")
    )
    rebuild_history = _table_exists(connection, "card_price_history_daily") and not required_history_columns.issubset(
        _table_columns(connection, "card_price_history_daily")
    )

    if not rebuild_snapshot and not rebuild_history:
        return

    previous_fk_state = connection.execute("PRAGMA foreign_keys").fetchone()[0]
    connection.execute("PRAGMA foreign_keys = OFF")
    try:
        if rebuild_snapshot:
            connection.execute("DROP TABLE IF EXISTS card_price_snapshots")
        if rebuild_history:
            connection.execute("DROP TABLE IF EXISTS card_price_history_daily")
    finally:
        connection.execute(f"PRAGMA foreign_keys = {previous_fk_state}")
    connection.commit()


def _create_inventory_ledger_tables(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS sale_events (
            id TEXT PRIMARY KEY,
            deck_entry_id TEXT NOT NULL REFERENCES deck_entries(id) ON DELETE CASCADE,
            card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            quantity INTEGER NOT NULL DEFAULT 1,
            unit_price REAL,
            total_price REAL,
            currency_code TEXT,
            payment_method TEXT,
            cost_basis_total REAL,
            cost_basis_unit_price REAL,
            sale_source TEXT NOT NULL DEFAULT 'manual',
            show_session_id TEXT,
            note TEXT,
            sold_at TEXT NOT NULL,
            source_scan_id TEXT REFERENCES scan_events(scan_id),
            source_confirmation_id TEXT REFERENCES scan_confirmations(id),
            created_at TEXT NOT NULL
        )
        """
    )
    _add_column_if_missing(connection, "sale_events", "show_session_id", "TEXT")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS deck_entry_events (
            id TEXT PRIMARY KEY,
            deck_entry_id TEXT NOT NULL REFERENCES deck_entries(id) ON DELETE CASCADE,
            card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            event_kind TEXT NOT NULL,
            quantity_delta INTEGER NOT NULL DEFAULT 0,
            unit_price REAL,
            total_price REAL,
            currency_code TEXT,
            payment_method TEXT,
            condition TEXT,
            grader TEXT,
            grade TEXT,
            cert_number TEXT,
            variant_name TEXT,
            sale_id TEXT REFERENCES sale_events(id) ON DELETE CASCADE,
            source_scan_id TEXT REFERENCES scan_events(scan_id),
            source_confirmation_id TEXT REFERENCES scan_confirmations(id),
            created_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_deck_entries_quantity
            ON deck_entries(quantity, added_at DESC, id DESC)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_sale_events_deck_entry_id
            ON sale_events(deck_entry_id, sold_at DESC, created_at DESC)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_sale_events_sold_at
            ON sale_events(sold_at DESC, created_at DESC)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_deck_entry_events_deck_entry_id
            ON deck_entry_events(deck_entry_id, created_at DESC, id DESC)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_deck_entry_events_created_at
            ON deck_entry_events(created_at DESC, id DESC)
        """
    )


def _seed_deck_entry_events_from_existing_rows(connection: sqlite3.Connection) -> None:
    if not _table_exists(connection, "deck_entries") or not _table_exists(connection, "deck_entry_events"):
        return

    previous_fk_state = connection.execute("PRAGMA foreign_keys").fetchone()[0]
    connection.execute("PRAGMA foreign_keys = OFF")
    try:
        rows = connection.execute(
            """
            SELECT
                id,
                owner_user_id,
                card_id,
                grader,
                grade,
                cert_number,
                variant_name,
                condition,
                quantity,
                added_at,
                source_scan_id,
                source_confirmation_id
            FROM deck_entries
            WHERE quantity IS NOT NULL AND quantity > 0
            ORDER BY added_at ASC, id ASC
            """
        ).fetchall()
        for row in rows:
            deck_entry_id = str(row["id"] or "").strip()
            if not deck_entry_id:
                continue
            existing = connection.execute(
                "SELECT 1 FROM deck_entry_events WHERE deck_entry_id = ? LIMIT 1",
                (deck_entry_id,),
            ).fetchone()
            if existing is not None:
                continue
            append_deck_entry_event(
                connection,
                owner_user_id=str(row["owner_user_id"] or "").strip() or None,
                deck_entry_id=deck_entry_id,
                card_id=str(row["card_id"] or "").strip(),
                event_kind="seed",
                quantity_delta=max(0, int(row["quantity"] or 0)),
                condition=str(row["condition"] or "").strip() or None,
                grader=str(row["grader"] or "").strip() or None,
                grade=str(row["grade"] or "").strip() or None,
                cert_number=str(row["cert_number"] or "").strip() or None,
                variant_name=str(row["variant_name"] or "").strip() or None,
                source_scan_id=str(row["source_scan_id"] or "").strip() or None,
                source_confirmation_id=str(row["source_confirmation_id"] or "").strip() or None,
                created_at=str(row["added_at"] or "").strip() or utc_now(),
                event_id=f"seed:{deck_entry_id}",
            )
    finally:
        connection.execute(f"PRAGMA foreign_keys = {'ON' if previous_fk_state else 'OFF'}")


def _backfill_deck_entry_quantities(connection: sqlite3.Connection) -> None:
    if not _table_exists(connection, "deck_entries"):
        return
    if "quantity" not in _table_columns(connection, "deck_entries"):
        return

    connection.execute(
        """
        UPDATE deck_entries
        SET quantity = 1
        WHERE quantity IS NULL
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


def _reconcile_deck_entry_quantities_from_events(connection: sqlite3.Connection) -> None:
    if not _table_exists(connection, "deck_entries") or not _table_exists(connection, "deck_entry_events"):
        return
    if "quantity" not in _table_columns(connection, "deck_entries"):
        return

    rows = connection.execute(
        """
        SELECT
            deck_entry_id,
            COALESCE(SUM(quantity_delta), 0) AS computed_quantity
        FROM deck_entry_events
        GROUP BY deck_entry_id
        """
    ).fetchall()

    for row in rows:
        deck_entry_id = str(row["deck_entry_id"] or "").strip()
        if not deck_entry_id:
            continue
        computed_quantity = max(0, int(row["computed_quantity"] or 0))
        connection.execute(
            """
            UPDATE deck_entries
            SET quantity = ?
            WHERE id = ?
            """,
            (computed_quantity, deck_entry_id),
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
        "card_id",
        "provider",
        "display_currency_code",
        "default_raw_variant",
        "default_raw_condition",
        "default_raw_low_price",
        "default_raw_market_price",
        "default_raw_mid_price",
        "default_raw_high_price",
        "default_raw_direct_low_price",
        "default_raw_trend_price",
        "raw_contexts_json",
        "graded_contexts_json",
        "source_url",
        "source_updated_at",
        "source_payload_json",
        "updated_at",
    }
    required_history_columns = {
        "card_id",
        "provider",
        "price_date",
        "display_currency_code",
        "default_raw_variant",
        "default_raw_condition",
        "default_raw_low_price",
        "default_raw_market_price",
        "default_raw_mid_price",
        "default_raw_high_price",
        "default_raw_direct_low_price",
        "default_raw_trend_price",
        "raw_contexts_json",
        "graded_contexts_json",
        "source_url",
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

    if "card_price_history_daily" in tables:
        history_columns = _table_columns(connection, "card_price_history_daily")
        if not required_history_columns.issubset(history_columns):
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
    _rebuild_pricing_tables_if_needed(connection)
    if not _runtime_schema_is_compatible(connection):
        _reset_runtime_schema(connection)
    _apply_additive_runtime_migrations(connection)
    connection.executescript(schema_path.read_text())
    _create_inventory_ledger_tables(connection)
    _seed_deck_entry_events_from_existing_rows(connection)
    _reconcile_deck_entry_quantities_from_events(connection)
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


def _contains_japanese_text(value: str) -> bool:
    return bool(re.search(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]", value or ""))


def _raw_evidence_looks_japanese(evidence: RawEvidence) -> bool:
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


def _candidate_looks_japanese(card: dict[str, Any]) -> bool:
    language = str(card.get("language") or "").strip().lower()
    set_id = str(card.get("setID") or "").strip().lower()
    card_id = str(card.get("id") or "").strip().lower()
    return (
        language.startswith("ja")
        or language == "japanese"
        or set_id.endswith("_ja")
        or "_ja-" in card_id
    )


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


DEFAULT_RAW_CONDITION = "NM"
DEFAULT_RAW_VARIANT = "Normal"
RAW_VARIANT_PRIORITY = ("Normal", "Holofoil", "Reverse Holofoil")
RAW_CONDITION_PRIORITY = ("NM", "LP", "MP", "HP", "DM")


def _normalized_variant_label(value: str | None) -> str:
    text = str(value or "").strip()
    if not text:
        return DEFAULT_RAW_VARIANT
    normalized_key = re.sub(r"[^a-z0-9]+", "", text.lower())
    if normalized_key in {"", "raw", "normal", "standard"}:
        return DEFAULT_RAW_VARIANT
    if normalized_key == "holofoil":
        return "Holofoil"
    if normalized_key == "reverseholofoil":
        return "Reverse Holofoil"
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    text = re.sub(r"[_-]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text.title() or DEFAULT_RAW_VARIANT


def _normalized_condition_code(value: str | None) -> str:
    return str(value or DEFAULT_RAW_CONDITION).strip().upper() or DEFAULT_RAW_CONDITION


def _empty_raw_contexts() -> dict[str, Any]:
    return {"variants": {}}


def _empty_graded_contexts() -> dict[str, Any]:
    return {"graders": {}}


def _raw_contexts_payload(value: Any) -> dict[str, Any]:
    payload = _json_load(value, _empty_raw_contexts())
    if not isinstance(payload, dict):
        return _empty_raw_contexts()
    variants = payload.get("variants")
    if not isinstance(variants, dict):
        payload["variants"] = {}
    return payload


def _graded_contexts_payload(value: Any) -> dict[str, Any]:
    payload = _json_load(value, _empty_graded_contexts())
    if not isinstance(payload, dict):
        return _empty_graded_contexts()
    graders = payload.get("graders")
    if not isinstance(graders, dict):
        payload["graders"] = {}
    return payload


def _price_summary_payload(
    *,
    provider: str | None = None,
    currency_code: str,
    low_price: float | None,
    market_price: float | None,
    mid_price: float | None,
    high_price: float | None,
    direct_low_price: float | None = None,
    trend_price: float | None = None,
    source_url: str | None = None,
    source_updated_at: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "provider": str(provider or "").strip() or None,
        "currencyCode": str(currency_code or "USD"),
        "low": low_price,
        "market": market_price,
        "mid": mid_price,
        "high": high_price,
        "directLow": direct_low_price,
        "trend": trend_price,
        "sourceURL": str(source_url or "").strip() or None,
        "sourceUpdatedAt": str(source_updated_at or "").strip() or None,
        "payload": dict(payload or {}),
    }


def _upsert_raw_context_entry(
    raw_contexts: dict[str, Any],
    *,
    variant: str | None,
    condition: str | None,
    provider: str | None = None,
    currency_code: str,
    low_price: float | None,
    market_price: float | None,
    mid_price: float | None,
    high_price: float | None,
    direct_low_price: float | None = None,
    trend_price: float | None = None,
    source_url: str | None = None,
    source_updated_at: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    variant_label = _normalized_variant_label(variant)
    condition_code = _normalized_condition_code(condition)
    variants = raw_contexts.setdefault("variants", {})
    variant_bucket = variants.setdefault(
        variant_label,
        {
            "variant": variant_label,
            "variantKey": str((payload or {}).get("variantKey") or variant_label).strip() or variant_label,
            "conditions": {},
        },
    )
    conditions = variant_bucket.setdefault("conditions", {})
    entry = _price_summary_payload(
        provider=provider,
        currency_code=currency_code,
        low_price=low_price,
        market_price=market_price,
        mid_price=mid_price,
        high_price=high_price,
        direct_low_price=direct_low_price,
        trend_price=trend_price,
        source_url=source_url,
        source_updated_at=source_updated_at,
        payload=payload,
    )
    entry["condition"] = condition_code
    entry["variant"] = variant_label
    conditions[condition_code] = entry
    if payload and payload.get("variantKey"):
        variant_bucket["variantKey"] = str(payload.get("variantKey")).strip() or variant_bucket.get("variantKey")
    return entry


def _graded_entry_key(entry: dict[str, Any]) -> tuple[str, int, int, int]:
    return (
        _normalized_variant_label(entry.get("variant")),
        1 if bool(entry.get("isPerfect")) else 0,
        1 if bool(entry.get("isSigned")) else 0,
        1 if bool(entry.get("isError")) else 0,
    )


def _upsert_graded_context_entry(
    graded_contexts: dict[str, Any],
    *,
    grader: str,
    grade: str,
    variant: str | None,
    provider: str | None = None,
    currency_code: str,
    low_price: float | None,
    market_price: float | None,
    mid_price: float | None,
    high_price: float | None,
    direct_low_price: float | None = None,
    trend_price: float | None = None,
    source_url: str | None = None,
    source_updated_at: str | None = None,
    is_perfect: bool = False,
    is_signed: bool = False,
    is_error: bool = False,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    grader_key = str(grader or "").strip().upper()
    grade_key = str(grade or "").strip().upper()
    if not grader_key or not grade_key:
        raise ValueError("grader and grade are required for graded pricing contexts")
    graders = graded_contexts.setdefault("graders", {})
    grade_bucket = graders.setdefault(grader_key, {}).setdefault(grade_key, [])
    entry = _price_summary_payload(
        provider=provider,
        currency_code=currency_code,
        low_price=low_price,
        market_price=market_price,
        mid_price=mid_price,
        high_price=high_price,
        direct_low_price=direct_low_price,
        trend_price=trend_price,
        source_url=source_url,
        source_updated_at=source_updated_at,
        payload=payload,
    )
    entry.update(
        {
            "grader": grader_key,
            "grade": grade_key,
            "variant": _normalized_variant_label(variant),
            "isPerfect": bool(is_perfect),
            "isSigned": bool(is_signed),
            "isError": bool(is_error),
        }
    )
    key = _graded_entry_key(entry)
    replaced = False
    for index, existing in enumerate(list(grade_bucket)):
        if not isinstance(existing, dict):
            continue
        if _graded_entry_key(existing) == key:
            grade_bucket[index] = entry
            replaced = True
            break
    if not replaced:
        grade_bucket.append(entry)
    return entry


def _raw_context_variants(raw_contexts: dict[str, Any]) -> list[str]:
    variants = raw_contexts.get("variants")
    if not isinstance(variants, dict):
        return []
    return [variant for variant in variants.keys() if str(variant).strip()]


def _raw_context_conditions(raw_contexts: dict[str, Any], variant: str | None) -> list[str]:
    variants = raw_contexts.get("variants")
    if not isinstance(variants, dict):
        return []
    variant_bucket = variants.get(_normalized_variant_label(variant))
    if not isinstance(variant_bucket, dict):
        return []
    conditions = variant_bucket.get("conditions")
    if not isinstance(conditions, dict):
        return []
    return [str(condition).upper() for condition in conditions.keys() if str(condition).strip()]


def _raw_context_entry(
    raw_contexts: dict[str, Any],
    *,
    variant: str | None,
    condition: str | None,
) -> dict[str, Any] | None:
    variants = raw_contexts.get("variants")
    if not isinstance(variants, dict):
        return None
    variant_bucket = variants.get(_normalized_variant_label(variant))
    if not isinstance(variant_bucket, dict):
        return None
    conditions = variant_bucket.get("conditions")
    if not isinstance(conditions, dict):
        return None
    resolved_condition = _normalized_condition_code(condition)
    entry = conditions.get(resolved_condition)
    return entry if isinstance(entry, dict) else None


def _resolve_default_raw_context(raw_contexts: dict[str, Any]) -> tuple[str | None, str | None, dict[str, Any] | None]:
    variants = _raw_context_variants(raw_contexts)
    if not variants:
        return None, None, None

    def variant_rank(label: str) -> tuple[int, str]:
        try:
            return (RAW_VARIANT_PRIORITY.index(label), label)
        except ValueError:
            return (len(RAW_VARIANT_PRIORITY), label)

    ordered_variants = sorted(variants, key=variant_rank)
    for preferred_condition in RAW_CONDITION_PRIORITY:
        for variant in ordered_variants:
            entry = _raw_context_entry(raw_contexts, variant=variant, condition=preferred_condition)
            if entry is not None:
                return variant, preferred_condition, entry
    first_variant = ordered_variants[0]
    conditions = _raw_context_conditions(raw_contexts, first_variant)
    if not conditions:
        return first_variant, None, None
    entry = _raw_context_entry(raw_contexts, variant=first_variant, condition=conditions[0])
    return first_variant, conditions[0], entry


def _default_display_currency_code(
    *,
    raw_contexts: dict[str, Any],
    graded_contexts: dict[str, Any],
    fallback: str | None = None,
) -> str:
    _, _, raw_entry = _resolve_default_raw_context(raw_contexts)
    if raw_entry is not None:
        return str(raw_entry.get("currencyCode") or "USD")
    graders = graded_contexts.get("graders")
    if isinstance(graders, dict):
        for grade_map in graders.values():
            if not isinstance(grade_map, dict):
                continue
            for entries in grade_map.values():
                if not isinstance(entries, list):
                    continue
                for entry in entries:
                    if isinstance(entry, dict) and str(entry.get("currencyCode") or "").strip():
                        return str(entry.get("currencyCode"))
    return str(fallback or "USD")


def _coerce_price_summary_from_entry(entry: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(entry, dict):
        return None
    trends_pct_raw = entry.get("trendsPct")
    trends_pct = dict(trends_pct_raw) if isinstance(trends_pct_raw, dict) else None
    return {
        "currencyCode": entry.get("currencyCode"),
        "low": entry.get("low"),
        "market": entry.get("market"),
        "mid": entry.get("mid"),
        "high": entry.get("high"),
        "directLow": entry.get("directLow"),
        "trend": entry.get("trend"),
        "trendsPct": trends_pct,
        "payload": dict(entry.get("payload") or {}),
    }


def _resolve_raw_context_summary(
    raw_contexts: dict[str, Any],
    *,
    variant: str | None = None,
    condition: str | None = None,
) -> tuple[str | None, str | None, dict[str, Any] | None]:
    resolved_variant = _normalized_variant_label(variant) if variant else None
    resolved_condition = _normalized_condition_code(condition) if condition else None
    entry = _raw_context_entry(raw_contexts, variant=resolved_variant, condition=resolved_condition) if resolved_variant else None
    if entry is None and resolved_variant:
        for candidate in RAW_CONDITION_PRIORITY:
            entry = _raw_context_entry(raw_contexts, variant=resolved_variant, condition=candidate)
            if entry is not None:
                resolved_condition = candidate
                break
    if entry is not None:
        return resolved_variant, resolved_condition, _coerce_price_summary_from_entry(entry)
    default_variant, default_condition, default_entry = _resolve_default_raw_context(raw_contexts)
    return default_variant, default_condition, _coerce_price_summary_from_entry(default_entry)


def _default_raw_field_values(raw_contexts: dict[str, Any]) -> dict[str, Any]:
    variant, condition, entry = _resolve_default_raw_context(raw_contexts)
    summary = _coerce_price_summary_from_entry(entry) or {}
    return {
        "defaultRawVariant": variant,
        "defaultRawCondition": condition or DEFAULT_RAW_CONDITION,
        "defaultRawLowPrice": summary.get("low"),
        "defaultRawMarketPrice": summary.get("market"),
        "defaultRawMidPrice": summary.get("mid"),
        "defaultRawHighPrice": summary.get("high"),
        "defaultRawDirectLowPrice": summary.get("directLow"),
        "defaultRawTrendPrice": summary.get("trend"),
    }


def _resolve_graded_context_entry(
    graded_contexts: dict[str, Any],
    *,
    grader: str | None,
    grade: str | None,
    variant: str | None = None,
) -> dict[str, Any] | None:
    grader_key = str(grader or "").strip().upper()
    grade_key = str(grade or "").strip().upper()
    if not grader_key or not grade_key:
        return None
    graders = graded_contexts.get("graders")
    if not isinstance(graders, dict):
        return None
    grade_map = graders.get(grader_key)
    if not isinstance(grade_map, dict):
        return None
    entries = grade_map.get(grade_key)
    if not isinstance(entries, list):
        return None
    resolved_variant = _normalized_variant_label(variant) if variant else None
    preferred = []
    fallback = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        is_special = any(bool(entry.get(flag)) for flag in ("isPerfect", "isSigned", "isError"))
        entry_variant = _normalized_variant_label(entry.get("variant"))
        if resolved_variant:
            if entry_variant == resolved_variant and not is_special:
                return entry
            if entry_variant == resolved_variant:
                preferred.append(entry)
        elif not is_special:
            fallback.append(entry)
        else:
            preferred.append(entry)
    if preferred:
        return preferred[0]
    if fallback:
        return fallback[0]
    return None


def _graded_variants_for_context(
    graded_contexts: dict[str, Any],
    *,
    grader: str | None,
    grade: str | None,
) -> list[str]:
    grader_key = str(grader or "").strip().upper()
    grade_key = str(grade or "").strip().upper()
    if not grader_key or not grade_key:
        return []
    graders = graded_contexts.get("graders")
    if not isinstance(graders, dict):
        return []
    grade_map = graders.get(grader_key)
    if not isinstance(grade_map, dict):
        return []
    entries = grade_map.get(grade_key)
    if not isinstance(entries, list):
        return []
    seen: set[str] = set()
    variants: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        label = _normalized_variant_label(entry.get("variant"))
        if label and label not in seen:
            seen.add(label)
            variants.append(label)
    return variants


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


# Evolution-stage subtypes recognised for the card-text "stage" field. Anything
# else (mechanic subtypes like "EX", "VMAX", "Tag Team") is ignored here.
_POKEMON_STAGE_SUBTYPES = ("Basic", "Stage 1", "Stage 2", "VStar", "VMAX", "V", "BREAK", "Mega", "Stage 3")
_POKEMON_STAGE_PRIORITY = ("Basic", "Stage 1", "Stage 2", "Stage 3")


def _pokemon_stage_from_subtypes(subtypes: Any) -> str | None:
    if not isinstance(subtypes, (list, tuple)):
        return None
    labels = [str(value).strip() for value in subtypes if str(value or "").strip()]
    for stage in _POKEMON_STAGE_PRIORITY:
        if stage in labels:
            return stage
    return None


def _string_or_none(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [str(item).strip() for item in value if str(item or "").strip()]


def _card_text_type_values(value: Any) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    if not isinstance(value, (list, tuple)):
        return rows
    for item in value:
        if not isinstance(item, dict):
            continue
        type_label = _string_or_none(item.get("type"))
        if type_label is None:
            continue
        rows.append({"type": type_label, "value": str(item.get("value") or "").strip()})
    return rows


def card_text_from_card(card: dict[str, Any] | None) -> dict[str, Any] | None:
    """Build the camelCase ``cardText`` block from a resolved card dict.

    Returns ``None`` for non-Pokemon cards or when the source payload lacks the
    Pokemon rules-text fields. Read-only: derives entirely from the card row's
    cached ``sourcePayload`` (no provider fetches).
    """
    if not isinstance(card, dict):
        return None
    supertype = str(card.get("supertype") or "").strip().lower()
    # Scrydex stores the Pokemon supertype as "Pokémon"; tolerate ascii too.
    if supertype not in {"pokémon", "pokemon"}:
        return None
    payload = card.get("sourcePayload")
    if not isinstance(payload, dict):
        return None

    attacks: list[dict[str, Any]] = []
    for attack in payload.get("attacks") or []:
        if not isinstance(attack, dict):
            continue
        name = _string_or_none(attack.get("name"))
        if name is None:
            continue
        attacks.append(
            {
                "name": name,
                "cost": _string_list(attack.get("cost")),
                "damage": _string_or_none(attack.get("damage")),
                "text": _string_or_none(attack.get("text")),
            }
        )

    abilities: list[dict[str, Any]] = []
    for ability in payload.get("abilities") or []:
        if not isinstance(ability, dict):
            continue
        name = _string_or_none(ability.get("name"))
        if name is None:
            continue
        abilities.append(
            {
                "name": name,
                "type": _string_or_none(ability.get("type")),
                "text": _string_or_none(ability.get("text")),
            }
        )

    subtypes = payload.get("subtypes")
    if not isinstance(subtypes, (list, tuple)):
        subtypes = card.get("subtypes")

    return {
        "number": _string_or_none(payload.get("number") or card.get("number")),
        "rarity": _string_or_none(payload.get("rarity") or card.get("rarity")),
        "types": _string_list(payload.get("types") or card.get("types")),
        "hp": _string_or_none(payload.get("hp")),
        "stage": _pokemon_stage_from_subtypes(subtypes),
        "abilities": abilities,
        "attacks": attacks,
        "weaknesses": _card_text_type_values(payload.get("weaknesses")),
        "resistances": _card_text_type_values(payload.get("resistances")),
        "retreatCost": _string_list(payload.get("retreat_cost")),
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


def cards_by_ids(connection: sqlite3.Connection, card_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
    normalized_ids: list[str] = []
    seen_ids: set[str] = set()
    for raw_card_id in card_ids:
        card_id = str(raw_card_id or "").strip()
        if not card_id or card_id in seen_ids:
            continue
        seen_ids.add(card_id)
        normalized_ids.append(card_id)

    if not normalized_ids:
        return {}

    placeholders = ",".join("?" for _ in normalized_ids)
    rows = connection.execute(
        f"SELECT * FROM cards WHERE id IN ({placeholders})",
        tuple(normalized_ids),
    ).fetchall()
    alias_map = _card_title_aliases_by_card_ids(connection, normalized_ids)
    return {
        str(row["id"]): _card_row_to_dict(row, title_aliases=alias_map.get(str(row["id"]), ()))
        for row in rows
    }


def _normalized_manual_search_limit(limit: int) -> int:
    try:
        requested_limit = int(limit)
    except (TypeError, ValueError):
        requested_limit = 20
    return max(1, min(requested_limit, 100))


def _manual_search_query_phrases(tokens: list[str]) -> tuple[str, ...]:
    phrases: list[str] = []
    seen: set[str] = set()
    max_window = min(3, len(tokens))
    for window_size in range(max_window, 0, -1):
        for start in range(0, len(tokens) - window_size + 1):
            phrase = " ".join(tokens[start:start + window_size]).strip()
            if not phrase or phrase in seen:
                continue
            seen.add(phrase)
            phrases.append(phrase)
    return tuple(phrases)


def _manual_search_number_forms(value: str) -> tuple[str, ...]:
    normalized = canonicalize_collector_number(value)
    if not normalized:
        return tuple()

    forms: list[str] = []
    seen: set[str] = set()

    def add(text: str) -> None:
        cleaned = str(text or "").strip()
        if not cleaned or cleaned in seen:
            return
        seen.add(cleaned)
        forms.append(cleaned)

    add(normalized)
    if "/" in normalized:
        add(normalized.split("/", 1)[0])
    return tuple(forms)


_MANUAL_SEARCH_EXACT_NUMBER_PATTERN = re.compile(
    r"(?<![\w])#?([a-z]*\d+[a-z0-9-]*\s*[/／\\]\s*[a-z0-9-]+)(?![\w])",
    flags=re.IGNORECASE,
)


def _manual_search_exact_number_forms_from_query(
    query: str,
    structured_filters: dict[str, tuple[str, ...]],
) -> tuple[str, ...]:
    forms: list[str] = []
    seen: set[str] = set()

    def add(value: str) -> None:
        normalized = canonicalize_collector_number(value)
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        forms.append(normalized)

        match = re.fullmatch(r"(\d+)/(\d+)", normalized)
        if not match:
            return

        left, right = match.groups()
        for left_form in (left.lstrip("0") or "0", left.zfill(3)):
            for right_form in (right.lstrip("0") or "0", right.zfill(3)):
                variant = f"{left_form}/{right_form}"
                if variant and variant not in seen:
                    seen.add(variant)
                    forms.append(variant)

    for clause in structured_filters.get("number", ()):
        add(clause)

    for match in _MANUAL_SEARCH_EXACT_NUMBER_PATTERN.finditer(str(query or "")):
        add(match.group(1))

    return tuple(forms)


def _manual_search_candidate_rows_for_exact_numbers(
    connection: sqlite3.Connection,
    number_forms: tuple[str, ...],
    *,
    limit: int,
) -> list[tuple[str, float]]:
    if not number_forms:
        return []

    clause_limit = max(1, min(int(limit), 100))
    fetch_limit = min(max(clause_limit * 2, clause_limit), 100)
    best_scores: dict[str, float] = {}
    ordered_ids: list[str] = []
    seen_ids: set[str] = set()

    for number_form in number_forms:
        rows = connection.execute(
            """
            SELECT id AS id,
                   CASE WHEN number = ? COLLATE NOCASE THEN 760.0 ELSE 620.0 END AS score
            FROM cards
            WHERE number = ? COLLATE NOCASE
               OR number >= ? COLLATE NOCASE AND number < ? COLLATE NOCASE
            ORDER BY
                CASE WHEN number = ? COLLATE NOCASE THEN 0 ELSE 1 END,
                CASE WHEN language = 'English' THEN 0 ELSE 1 END,
                name,
                set_name,
                id
            LIMIT ?
            """,
            (
                number_form,
                number_form,
                *(_manual_search_prefix_bounds(f"{number_form}/")),
                number_form,
                fetch_limit,
            ),
        ).fetchall()

        for row in rows:
            card_id = str(row["id"] or "").strip()
            if not card_id:
                continue
            score = float(row["score"] or 0.0)
            if card_id not in seen_ids:
                seen_ids.add(card_id)
                ordered_ids.append(card_id)
            best_scores[card_id] = max(best_scores.get(card_id, 0.0), score)

    ordered_ids.sort(key=lambda card_id: (-best_scores.get(card_id, 0.0), card_id))
    return [(card_id, best_scores[card_id]) for card_id in ordered_ids[:clause_limit]]


def _manual_search_prefix_bounds(prefix: str) -> tuple[str, str]:
    normalized_prefix = str(prefix or "").strip()
    if not normalized_prefix:
        return "", ""
    return normalized_prefix, f"{normalized_prefix}\U0010ffff"


_MANUAL_SEARCH_FIELD_NAMES = ("name", "set", "number")
def _manual_search_unquote(value: str) -> str:
    cleaned = str(value or "").strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {'"', "'"}:
        return cleaned[1:-1].strip()
    return cleaned


def _manual_search_parse_query(query: str) -> tuple[dict[str, tuple[str, ...]], str]:
    structured: dict[str, list[str]] = {field: [] for field in _MANUAL_SEARCH_FIELD_NAMES}
    free_parts: list[str] = []

    raw_query = str(query or "")
    try:
        parts = shlex.split(raw_query)
    except ValueError:
        parts = raw_query.split()

    for raw_part in parts:
        part = raw_part.strip()
        if not part:
            continue

        field, separator, value = part.partition(":")
        if separator:
            field_key = field.strip().lower()
            if field_key in structured:
                cleaned_value = _manual_search_unquote(value)
                if cleaned_value:
                    structured[field_key].append(cleaned_value)
                continue

        cleaned_part = _manual_search_unquote(part)
        if cleaned_part:
            free_parts.append(cleaned_part)

    search_terms = free_parts[:]
    for field in _MANUAL_SEARCH_FIELD_NAMES:
        search_terms.extend(structured[field])

    return {field: tuple(values) for field, values in structured.items()}, " ".join(search_terms)


def _manual_search_clause_matches_name(card: dict[str, Any], clause: str) -> bool:
    normalized_clause = _normalized_alias_text(clause)
    if not normalized_clause:
        return False

    normalized_title_values = tuple(
        normalized
        for normalized in (_normalized_alias_text(value) for value in _candidate_title_values(card))
        if normalized
    )
    if normalized_clause in normalized_title_values:
        return True
    if any(value.startswith(normalized_clause) for value in normalized_title_values):
        return True

    clause_tokens = set(tokenize(clause))
    if not clause_tokens:
        return False

    title_tokens = set(tokenize(" ".join(_candidate_title_values(card))))
    return clause_tokens.issubset(title_tokens)


def _manual_search_clause_matches_set(card: dict[str, Any], clause: str) -> bool:
    normalized_clause = _normalized_alias_text(clause)
    if not normalized_clause:
        return False

    normalized_set_values = tuple(
        normalized
        for normalized in (
            _normalized_alias_text(value)
            for value in [
                str(card.get("setName") or ""),
                str(card.get("setID") or ""),
                str(card.get("setPtcgoCode") or ""),
            ]
        )
        if normalized
    )
    if normalized_clause in normalized_set_values:
        return True
    if any(value.startswith(normalized_clause) for value in normalized_set_values):
        return True

    clause_tokens = set(tokenize(clause))
    if not clause_tokens:
        return False

    set_tokens = set(
        tokenize(
            " ".join(
                [
                    str(card.get("setName") or ""),
                    str(card.get("setID") or ""),
                    str(card.get("setPtcgoCode") or ""),
                ]
            )
        )
    )
    return clause_tokens.issubset(set_tokens)


def _manual_search_clause_matches_number(card: dict[str, Any], clause: str) -> bool:
    clause_number = canonicalize_collector_number(clause)
    card_number = canonicalize_collector_number(str(card.get("number") or ""))
    if not clause_number or not card_number:
        return False

    if clause_number == card_number:
        return True
    if card_number.startswith(f"{clause_number}/"):
        return True
    return card_number.startswith(clause_number)


def _manual_search_card_matches_structured_filters(
    card: dict[str, Any],
    structured_filters: dict[str, tuple[str, ...]],
) -> bool:
    for clause in structured_filters["name"]:
        if not _manual_search_clause_matches_name(card, clause):
            return False

    for clause in structured_filters["set"]:
        if not _manual_search_clause_matches_set(card, clause):
            return False

    for clause in structured_filters["number"]:
        if not _manual_search_clause_matches_number(card, clause):
            return False

    return True


def _manual_search_candidate_rows_for_phrase(
    connection: sqlite3.Connection,
    phrase: str,
    *,
    limit: int,
) -> list[tuple[str, float]]:
    normalized_phrase = _normalized_alias_text(phrase)
    if not normalized_phrase:
        return []

    query_specs: list[tuple[str, tuple[object, ...]]] = [
        (
            "SELECT card_id AS id, 500.0 AS score FROM card_name_aliases WHERE normalized_alias = ? LIMIT ?",
            (normalized_phrase,),
        ),
        (
            "SELECT card_id AS id, 450.0 AS score FROM card_name_aliases WHERE normalized_alias >= ? AND normalized_alias < ? LIMIT ?",
            _manual_search_prefix_bounds(normalized_phrase),
        ),
        (
            "SELECT id AS id, 420.0 AS score FROM cards WHERE name >= ? AND name < ? LIMIT ?",
            _manual_search_prefix_bounds(normalized_phrase),
        ),
        (
            "SELECT id AS id, 380.0 AS score FROM cards WHERE set_name >= ? AND set_name < ? LIMIT ?",
            _manual_search_prefix_bounds(normalized_phrase),
        ),
    ]

    if len(normalized_phrase) <= 12:
        query_specs.extend(
            [
                (
                    "SELECT id AS id, 360.0 AS score FROM cards WHERE set_id >= ? AND set_id < ? LIMIT ?",
                    _manual_search_prefix_bounds(normalized_phrase),
                ),
                (
                    "SELECT id AS id, 360.0 AS score FROM cards WHERE set_ptcgo_code >= ? AND set_ptcgo_code < ? LIMIT ?",
                    _manual_search_prefix_bounds(normalized_phrase),
                ),
            ]
        )

    for number_form in _manual_search_number_forms(normalized_phrase):
        number_range = _manual_search_prefix_bounds(number_form)
        # Number forms are canonicalized to lowercase, but promo collector
        # numbers are stored uppercase in the catalog ("SWSH039", "TG05/TG30").
        # SQLite's default collation is case-sensitive, so a "swsh039" query
        # would never match "SWSH039". COLLATE NOCASE makes these comparisons
        # case-insensitive (ASCII), which is exactly the promo-code case.
        query_specs.extend(
            [
                (
                    "SELECT id AS id, 520.0 AS score FROM cards WHERE number = ? COLLATE NOCASE LIMIT ?",
                    (number_form,),
                ),
                (
                    "SELECT id AS id, 480.0 AS score FROM cards WHERE number >= ? COLLATE NOCASE AND number < ? COLLATE NOCASE LIMIT ?",
                    _manual_search_prefix_bounds(f"{number_form}/"),
                ),
                (
                    "SELECT id AS id, 430.0 AS score FROM cards WHERE number >= ? COLLATE NOCASE AND number < ? COLLATE NOCASE LIMIT ?",
                    number_range,
                ),
            ]
        )

    if not query_specs:
        return []

    clause_limit = max(1, min(int(limit), 100))
    # A card can have several alias rows (name variants, casing), so the alias
    # queries return more rows than distinct cards (~2x). Fetch clause_limit * 2
    # and cap at 200 so we can still collect up to clause_limit *distinct* cards
    # after dedup — a 100 cap here silently halved a 100-result request.
    fetch_limit = max(clause_limit * 2, min(clause_limit, 25))
    fetch_limit = min(fetch_limit, 200)
    best_scores: dict[str, float] = {}
    ordered_ids: list[str] = []
    seen_ids: set[str] = set()

    for sql, values in query_specs:
        rows = connection.execute(sql, (*values, fetch_limit)).fetchall()
        for row in rows:
            card_id = str(row["id"] or "").strip()
            if not card_id:
                continue
            score = float(row["score"] or 0.0)
            if card_id not in seen_ids:
                seen_ids.add(card_id)
                ordered_ids.append(card_id)
            best_scores[card_id] = max(best_scores.get(card_id, 0.0), score)

    ordered_ids.sort(key=lambda card_id: (-best_scores.get(card_id, 0.0), card_id))
    return [(card_id, best_scores[card_id]) for card_id in ordered_ids[:clause_limit]]


# Promo set codes printed on cards as a number suffix, e.g. "172/SM-P",
# "024/ADV-P", "129/SV-P". Reviewers type the code they see ("sm-p"); we target
# the matching ".../SM-P" number suffix so the right promo set surfaces.
_MANUAL_SEARCH_PROMO_CODE_PATTERN = re.compile(r"\b([a-z]{1,4}-p)\b", flags=re.IGNORECASE)


def _manual_search_promo_codes(search_text: str) -> list[str]:
    seen: list[str] = []
    for match in _MANUAL_SEARCH_PROMO_CODE_PATTERN.findall(str(search_text or "")):
        code = str(match or "").strip().upper()
        if code and code not in seen:
            seen.append(code)
    return seen


def _manual_search_candidate_rows_for_name_qualifiers(
    connection: sqlite3.Connection,
    tokens: list[str],
    search_text: str,
    *,
    limit: int,
) -> list[tuple[str, float]]:
    """Retrieve cards by a NAME token intersected with a SET/number qualifier —
    e.g. "pikachu sun moon promos" (set name words) or "pikachu sm-p" (the
    printed promo code, stored in the number as ".../SM-P").

    Why this exists: a common name has hundreds of prints (263 "Pikachu" in the
    catalog), but per-phrase retrieval caps at ~45 same-name rows in ingestion
    (rowid) order, so later-synced prints — especially Japanese promos — never
    even become candidates and can't be surfaced by name + set. This pass joins
    the name-alias index to the cards' set/number so the right print is pulled
    in regardless of ingestion order. Gated to multi-word queries so single-name
    searches keep their existing behavior.
    """
    alpha_tokens = [
        token for token in tokens if token and not any(ch.isdigit() for ch in token)
    ]
    if len(alpha_tokens) < 2:
        return []
    name_tokens = [token for token in alpha_tokens if len(token) >= 3]
    qualifier_tokens = [token for token in alpha_tokens if len(token) >= 2]
    if not name_tokens:
        return []

    clause_limit = max(8, min(int(limit), 60))
    set_sql = (
        "SELECT a.card_id AS id, 490.0 AS score "
        "FROM card_name_aliases a JOIN cards c ON c.id = a.card_id "
        "WHERE a.normalized_alias >= ? AND a.normalized_alias < ? "
        "AND (c.set_name LIKE ? OR c.set_id LIKE ? OR c.number LIKE ?) "
        "LIMIT ?"
    )
    # The exact printed promo code ("SM-P") gets a higher retrieval score so the
    # matching promo set outranks generic same-prefix prints (e.g. English "SM04").
    code_sql = (
        "SELECT a.card_id AS id, 560.0 AS score "
        "FROM card_name_aliases a JOIN cards c ON c.id = a.card_id "
        "WHERE a.normalized_alias >= ? AND a.normalized_alias < ? "
        "AND c.number LIKE ? "
        "LIMIT ?"
    )
    promo_codes = _manual_search_promo_codes(search_text)
    best_scores: dict[str, float] = {}

    def record(rows: list[Any]) -> None:
        for row in rows:
            card_id = str(row["id"] or "").strip()
            if not card_id:
                continue
            best_scores[card_id] = max(
                best_scores.get(card_id, 0.0), float(row["score"] or 0.0)
            )

    for name_token in name_tokens:
        low, high = _manual_search_prefix_bounds(name_token)
        for qualifier in qualifier_tokens:
            if qualifier == name_token:
                continue
            like = f"%{qualifier}%"
            record(
                connection.execute(
                    set_sql, (low, high, like, like, like, clause_limit)
                ).fetchall()
            )
        for code in promo_codes:
            record(
                connection.execute(
                    code_sql, (low, high, f"%{code}%", clause_limit)
                ).fetchall()
            )
    return list(best_scores.items())


def _manual_search_score(
    card: dict[str, Any],
    query: str,
    tokens: list[str],
    structured_filters: dict[str, tuple[str, ...]] | None = None,
    explicit_number_forms: tuple[str, ...] = tuple(),
) -> float:
    if structured_filters is None:
        structured_filters = {field: tuple() for field in _MANUAL_SEARCH_FIELD_NAMES}

    normalized_query = _normalized_alias_text(query)
    query_phrases = _manual_search_query_phrases(tokens)
    normalized_title_values = tuple(
        normalized
        for normalized in (_normalized_alias_text(value) for value in _candidate_title_values(card))
        if normalized
    )
    title_token_set = set(tokenize(" ".join(_candidate_title_values(card))))
    set_token_set = set(
        tokenize(
            " ".join(
                [
                    str(card.get("setName") or ""),
                    str(card.get("setID") or ""),
                    str(card.get("setPtcgoCode") or ""),
                ]
            )
        )
    )
    query_token_set = set(tokens)
    card_number = canonicalize_collector_number(str(card.get("number") or ""))
    score = 0.0
    # Number matches accumulate separately so we can down-weight them for cards
    # whose name/set matches none of the typed words. Without this, a name + a
    # mis-read number (e.g. "Cinccino 026/049") surfaces unrelated cards that
    # merely share the number (Kirlia/Tapu Lele 026/049) above the real name
    # match. A pure number search (no name typed) keeps full number weight.
    number_score = 0.0
    # Name/word tokens are the typed tokens with no digits (collector numbers
    # like "026", "049", "tg29" all contain digits). canonicalize_collector_number
    # is a passthrough normalizer, not a validator, so it can't be used here.
    name_query_tokens = {
        token for token in tokens if not any(ch.isdigit() for ch in token)
    }
    name_or_set_tokens = title_token_set | set_token_set
    name_query_present = bool(name_query_tokens)
    name_or_set_match = bool(name_query_tokens & name_or_set_tokens)
    number_weight = 0.2 if (name_query_present and not name_or_set_match) else 1.0

    if card_number and explicit_number_forms:
        if card_number in explicit_number_forms:
            number_score += 280.0
            if str(card.get("language") or "").strip().lower() == "english":
                number_score += 45.0
        elif any(card_number.startswith(f"{number_form}/") for number_form in explicit_number_forms):
            number_score += 190.0

    if normalized_query:
        if normalized_query in normalized_title_values:
            score += 220.0
        if any(value.startswith(normalized_query) for value in normalized_title_values):
            score += 160.0

    for phrase in query_phrases:
        if phrase in normalized_title_values:
            score += 100.0
        if any(value.startswith(phrase) for value in normalized_title_values):
            score += 70.0
        if phrase == _normalized_alias_text(card.get("setName") or ""):
            score += 55.0
        if phrase == _normalized_alias_text(card.get("setID") or ""):
            score += 50.0
        if phrase == _normalized_alias_text(card.get("setPtcgoCode") or ""):
            score += 50.0

    score += float(len(query_token_set & title_token_set)) * 16.0
    score += float(len(query_token_set & set_token_set)) * 12.0

    for clause in structured_filters["name"]:
        normalized_clause = _normalized_alias_text(clause)
        if not normalized_clause:
            continue
        if normalized_clause in normalized_title_values:
            score += 240.0
        elif any(value.startswith(normalized_clause) for value in normalized_title_values):
            score += 190.0
        elif set(tokenize(clause)).issubset(title_token_set):
            score += 120.0

    for clause in structured_filters["set"]:
        normalized_clause = _normalized_alias_text(clause)
        if not normalized_clause:
            continue
        set_values = tuple(
            normalized
            for normalized in (
                _normalized_alias_text(value)
                for value in [
                    str(card.get("setName") or ""),
                    str(card.get("setID") or ""),
                    str(card.get("setPtcgoCode") or ""),
                ]
            )
            if normalized
        )
        if normalized_clause in set_values:
            score += 220.0
        elif any(value.startswith(normalized_clause) for value in set_values):
            score += 170.0
        elif set(tokenize(clause)).issubset(set_token_set):
            score += 110.0

    for clause in structured_filters["number"]:
        clause_number = canonicalize_collector_number(clause)
        if not clause_number or not card_number:
            continue
        if clause_number == card_number:
            number_score += 240.0
        elif card_number.startswith(f"{clause_number}/"):
            number_score += 190.0
        elif card_number.startswith(clause_number):
            number_score += 150.0

    if card_number:
        for token in tokens:
            normalized_token = canonicalize_collector_number(token)
            if not normalized_token:
                continue
            if normalized_token == card_number:
                number_score += 180.0
            elif card_number.startswith(f"{normalized_token}/"):
                number_score += 120.0
            elif card_number.startswith(normalized_token):
                number_score += 90.0
            elif normalized_token in card_number:
                number_score += 30.0

    # Down-weight number-only matches for cards that match none of the typed
    # name/set words (keeps the right Pokémon on top despite a mis-read number).
    score += number_score * number_weight

    if str(card.get("id") or "").lower().startswith("tcgp-") or str(card.get("sourceRecordID") or "").lower().startswith("tcgp-"):
        if "tcgp" not in query_token_set and "tcgp" not in normalized_query:
            score -= 60.0

    return score


def search_cards(connection: sqlite3.Connection, query: str, limit: int = 20) -> list[dict[str, Any]]:
    structured_filters, search_text = _manual_search_parse_query(query)
    normalized_query = _normalized_alias_text(search_text)
    if not normalized_query:
        return []

    tokens = tokenize(search_text)
    # Word (non-number) tokens the user typed — used to down-weight cards that
    # match only on collector number when a name/set word was clearly typed.
    name_query_tokens = {token for token in tokens if not any(ch.isdigit() for ch in token)}
    requested_limit = _normalized_manual_search_limit(limit)
    query_phrases = _manual_search_query_phrases(tokens)
    explicit_number_forms = _manual_search_exact_number_forms_from_query(search_text, structured_filters)
    candidate_scores: dict[str, float] = {}
    candidate_order: list[str] = []
    seen_candidates: set[str] = set()

    def add_candidate(card_id: str, score: float) -> None:
        normalized_card_id = str(card_id or "").strip()
        if not normalized_card_id:
            return
        if normalized_card_id not in seen_candidates:
            seen_candidates.add(normalized_card_id)
            candidate_order.append(normalized_card_id)
        candidate_scores[normalized_card_id] = max(candidate_scores.get(normalized_card_id, 0.0), float(score))

    per_phrase_limit = max(8, min(100, requested_limit * 3))
    for card_id, score in _manual_search_candidate_rows_for_exact_numbers(
        connection,
        explicit_number_forms,
        limit=per_phrase_limit,
    ):
        add_candidate(card_id, score)

    for phrase in query_phrases:
        for card_id, score in _manual_search_candidate_rows_for_phrase(
            connection,
            phrase,
            limit=per_phrase_limit,
        ):
            add_candidate(card_id, score)

    # Name + set/code intersection (e.g. "pikachu sun moon promos", "pikachu
    # sm-p"). Pulls in prints that the per-phrase retrieval misses because a
    # common name has more prints than the per-phrase cap.
    for card_id, score in _manual_search_candidate_rows_for_name_qualifiers(
        connection,
        tokens,
        search_text,
        limit=per_phrase_limit,
    ):
        add_candidate(card_id, score)

    if not candidate_order:
        return []

    candidate_map = cards_by_ids(connection, candidate_order)
    scored_cards: list[tuple[float, dict[str, Any]]] = []
    for card_id in candidate_order:
        card = candidate_map.get(card_id)
        if card is None:
            continue
        if not _manual_search_card_matches_structured_filters(card, structured_filters):
            continue
        search_score = _manual_search_score(
            card,
            search_text,
            tokens,
            structured_filters,
            explicit_number_forms=explicit_number_forms,
        )
        retrieval_score = candidate_scores.get(card_id, 0.0)
        # If the user typed a name/set word but this card matches none of them,
        # it was pulled in only by a shared collector number — down-weight its
        # retrieval boost too so the real name match isn't buried (e.g. a
        # mis-read "Cinccino 026/049" must still rank Cinccino above Kirlia).
        if name_query_tokens:
            card_word_tokens = set(
                tokenize(
                    " ".join(
                        list(_candidate_title_values(card))
                        + [
                            str(card.get("setName") or ""),
                            str(card.get("setID") or ""),
                            str(card.get("setPtcgoCode") or ""),
                        ]
                    )
                )
            )
            if not (name_query_tokens & card_word_tokens):
                retrieval_score *= 0.2
        final_score = retrieval_score + search_score
        if final_score <= 0:
            continue
        scored_cards.append((final_score, card))

    scored_cards.sort(
        key=lambda item: (
            -item[0],
            str(item[1]["name"]),
            str(item[1]["number"]),
        )
    )
    return [card for _, card in scored_cards[:requested_limit]]


def search_cards_local(connection: sqlite3.Connection, query: str, limit: int = 20) -> list[dict[str, Any]]:
    return search_cards(connection, query, limit=limit)


def get_cards_by_expansion(
    connection: sqlite3.Connection,
    set_id: str,
    *,
    query: str = "",
    limit: int = 50,
) -> list[dict[str, Any]]:
    normalized_set_id = str(set_id or "").strip()
    if not normalized_set_id:
        return []
    clamped_limit = max(1, min(limit, 200))
    normalized_query = str(query or "").strip()

    if not normalized_query:
        rows = connection.execute(
            "SELECT * FROM cards WHERE set_id = ? ORDER BY number ASC LIMIT ?",
            (normalized_set_id, clamped_limit),
        ).fetchall()
        return [r for r in (_card_row_to_dict(row) for row in rows) if r is not None]

    clean = normalized_query.lstrip("#").strip()
    if not clean:
        return []

    number_patterns: list[str] = [clean]
    if clean.isdigit():
        for width in (2, 3):
            padded = clean.zfill(width)
            if padded not in number_patterns:
                number_patterns.append(padded)

    or_parts: list[str] = ["LOWER(name) LIKE ?"]
    params: list[str] = [f"%{clean.lower()}%"]
    for pattern in number_patterns:
        or_parts.append("number = ?")
        params.append(pattern)
        or_parts.append("number LIKE ?")
        params.append(f"{pattern}/%")

    sql = f"""
        SELECT * FROM cards
        WHERE set_id = ?
          AND ({" OR ".join(or_parts)})
        ORDER BY
          CASE WHEN LOWER(name) LIKE ? THEN 0 ELSE 1 END,
          number ASC
        LIMIT ?
    """
    final_params: list[Any] = [normalized_set_id, *params, f"{clean.lower()}%", clamped_limit]
    rows = connection.execute(sql, tuple(final_params)).fetchall()
    return [r for r in (_card_row_to_dict(row) for row in rows) if r is not None]


def list_local_expansions(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    persisted = list_persisted_expansions(connection)
    if persisted:
        return persisted
    rows = connection.execute(
        """
        SELECT set_id, set_name, set_series, set_release_date
        FROM cards
        WHERE set_id IS NOT NULL AND set_id != ''
        GROUP BY set_id
        ORDER BY set_release_date DESC
        """,
    ).fetchall()
    return [
        {
            "id": row["set_id"],
            "name": row["set_name"],
            "series": row["set_series"],
            "code": None,
            "releaseDate": row["set_release_date"],
            "imageUrl": None,
        }
        for row in rows
    ]


def list_persisted_expansions(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT id, name, series, code, release_date, logo_url, symbol_url, image_url
        FROM expansions
        ORDER BY release_date DESC NULLS LAST, name ASC
        """,
    ).fetchall()
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "series": row["series"],
            "code": row["code"],
            "releaseDate": row["release_date"],
            "imageUrl": row["logo_url"] or row["image_url"] or row["symbol_url"],
        }
        for row in rows
    ]


def expansion_count(connection: sqlite3.Connection) -> int:
    row = connection.execute("SELECT COUNT(*) AS count FROM expansions").fetchone()
    return int(row["count"]) if row else 0


def upsert_expansion(
    connection: sqlite3.Connection,
    *,
    expansion_id: str,
    name: str,
    series: str | None = None,
    code: str | None = None,
    language: str | None = None,
    release_date: str | None = None,
    logo_url: str | None = None,
    symbol_url: str | None = None,
    image_url: str | None = None,
    source_provider: str | None = None,
    source_payload: dict[str, Any] | None = None,
    imported_at: str | None = None,
) -> None:
    normalized_id = str(expansion_id or "").strip()
    if not normalized_id:
        raise ValueError("expansion_id is required")
    timestamp = imported_at or utc_now()
    payload_json = json.dumps(source_payload or {}, ensure_ascii=False)
    connection.execute(
        """
        INSERT INTO expansions (
            id, name, series, code, language, release_date,
            logo_url, symbol_url, image_url,
            source_provider, source_payload_json, created_at, updated_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            series=excluded.series,
            code=excluded.code,
            language=excluded.language,
            release_date=excluded.release_date,
            logo_url=excluded.logo_url,
            symbol_url=excluded.symbol_url,
            image_url=excluded.image_url,
            source_provider=excluded.source_provider,
            source_payload_json=excluded.source_payload_json,
            updated_at=excluded.updated_at
        """,
        (
            normalized_id,
            str(name or "").strip(),
            series,
            code,
            language,
            release_date,
            logo_url,
            symbol_url,
            image_url,
            source_provider,
            payload_json,
            timestamp,
            timestamp,
        ),
    )


def upsert_price_snapshot(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    provider: str,
    display_currency_code: str | None = None,
    raw_contexts: dict[str, Any] | None = None,
    graded_contexts: dict[str, Any] | None = None,
    default_raw_variant: str | None = None,
    default_raw_condition: str | None = None,
    default_raw_low_price: float | None = None,
    default_raw_market_price: float | None = None,
    default_raw_mid_price: float | None = None,
    default_raw_high_price: float | None = None,
    default_raw_direct_low_price: float | None = None,
    default_raw_trend_price: float | None = None,
    source_url: str | None = None,
    source_updated_at: str | None = None,
    payload: dict[str, Any] | None = None,
    pricing_mode: str | None = None,
    currency_code: str | None = None,
    grader: str | None = None,
    grade: str | None = None,
    variant: str | None = None,
    low_price: float | None = None,
    market_price: float | None = None,
    mid_price: float | None = None,
    high_price: float | None = None,
    direct_low_price: float | None = None,
    trend_price: float | None = None,
    condition: str | None = None,
    is_perfect: bool = False,
    is_signed: bool = False,
    is_error: bool = False,
) -> None:
    existing_row = connection.execute(
        """
        SELECT *
        FROM card_price_snapshots
        WHERE card_id = ?
        LIMIT 1
        """,
        (card_id,),
    ).fetchone()
    merged_raw_contexts = _raw_contexts_payload(existing_row["raw_contexts_json"] if existing_row is not None else None)
    merged_graded_contexts = _graded_contexts_payload(existing_row["graded_contexts_json"] if existing_row is not None else None)

    if raw_contexts is not None:
        merged_raw_contexts = _raw_contexts_payload(json.dumps(raw_contexts))
    elif pricing_mode == RAW_PRICING_MODE:
        _upsert_raw_context_entry(
            merged_raw_contexts,
            variant=variant,
            condition=condition or DEFAULT_RAW_CONDITION,
            currency_code=str(currency_code or display_currency_code or "USD"),
            low_price=low_price,
            market_price=market_price,
            mid_price=mid_price,
            high_price=high_price,
            direct_low_price=direct_low_price,
            trend_price=trend_price,
            payload=payload,
        )

    if graded_contexts is not None:
        merged_graded_contexts = _graded_contexts_payload(json.dumps(graded_contexts))
    elif pricing_mode == PSA_GRADE_PRICING_MODE and grader and grade:
        _upsert_graded_context_entry(
            merged_graded_contexts,
            grader=grader,
            grade=grade,
            variant=variant,
            currency_code=str(currency_code or display_currency_code or "USD"),
            low_price=low_price,
            market_price=market_price,
            mid_price=mid_price,
            high_price=high_price,
            direct_low_price=direct_low_price,
            trend_price=trend_price,
            is_perfect=is_perfect,
            is_signed=is_signed,
            is_error=is_error,
            payload=payload,
        )

    default_fields = _default_raw_field_values(merged_raw_contexts)
    has_existing_raw_contexts = bool(_raw_context_variants(merged_raw_contexts))
    graded_only_merge = graded_contexts is not None or (pricing_mode == PSA_GRADE_PRICING_MODE and grader and grade)
    resolved_provider = provider
    if existing_row is not None and graded_only_merge and has_existing_raw_contexts:
        existing_provider = str(existing_row["provider"] or "").strip()
        if existing_provider:
            resolved_provider = existing_provider
    resolved_currency_code = str(
        display_currency_code
        or _default_display_currency_code(
            raw_contexts=merged_raw_contexts,
            graded_contexts=merged_graded_contexts,
            fallback=existing_row["display_currency_code"] if existing_row is not None else currency_code,
        )
        or "USD"
    )
    connection.execute(
        """
        INSERT INTO card_price_snapshots (
            card_id, provider, display_currency_code,
            default_raw_variant, default_raw_condition,
            default_raw_low_price, default_raw_market_price, default_raw_mid_price, default_raw_high_price,
            default_raw_direct_low_price, default_raw_trend_price,
            raw_contexts_json, graded_contexts_json,
            source_url, source_updated_at, source_payload_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(card_id) DO UPDATE SET
            provider=excluded.provider,
            display_currency_code=excluded.display_currency_code,
            default_raw_variant=excluded.default_raw_variant,
            default_raw_condition=excluded.default_raw_condition,
            default_raw_low_price=excluded.default_raw_low_price,
            default_raw_market_price=excluded.default_raw_market_price,
            default_raw_mid_price=excluded.default_raw_mid_price,
            default_raw_high_price=excluded.default_raw_high_price,
            default_raw_direct_low_price=excluded.default_raw_direct_low_price,
            default_raw_trend_price=excluded.default_raw_trend_price,
            raw_contexts_json=excluded.raw_contexts_json,
            graded_contexts_json=excluded.graded_contexts_json,
            source_url=excluded.source_url,
            source_updated_at=excluded.source_updated_at,
            source_payload_json=excluded.source_payload_json,
            updated_at=excluded.updated_at
        """,
        (
            card_id,
            resolved_provider,
            resolved_currency_code,
            default_raw_variant or default_fields["defaultRawVariant"],
            default_raw_condition or default_fields["defaultRawCondition"],
            default_raw_low_price if default_raw_low_price is not None else default_fields["defaultRawLowPrice"],
            default_raw_market_price if default_raw_market_price is not None else default_fields["defaultRawMarketPrice"],
            default_raw_mid_price if default_raw_mid_price is not None else default_fields["defaultRawMidPrice"],
            default_raw_high_price if default_raw_high_price is not None else default_fields["defaultRawHighPrice"],
            default_raw_direct_low_price if default_raw_direct_low_price is not None else default_fields["defaultRawDirectLowPrice"],
            default_raw_trend_price if default_raw_trend_price is not None else default_fields["defaultRawTrendPrice"],
            json.dumps(merged_raw_contexts),
            json.dumps(merged_graded_contexts),
            source_url,
            source_updated_at,
            json.dumps(payload or {}),
            utc_now(),
        ),
    )


_PRICE_HISTORY_CELL_COLUMNS = (
    "card_id", "provider", "price_date", "lane", "cell_key",
    "variant_key", "condition", "grader", "grade",
    "is_perfect", "is_signed", "is_error",
    "currency_code", "low", "market", "mid", "high", "direct_low", "trend",
    "updated_at",
)


def _coerce_price_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


# --- Phase 4: price-history read source flag ---------------------------------
#
# ``PRICE_HISTORY_SOURCE`` selects which physical store the HISTORY readers use:
#   - "json"  (default) parse the ``card_price_history_daily`` JSON blobs.
#   - "cells" resolve from the normalized ``card_price_history_cell`` table.
# Default stays "json" so nothing changes until the flag is explicitly flipped.
# This ONLY gates ``card_price_history_daily`` JSON readers; ``card_price_snapshots``
# readers keep their own JSON regardless of this flag.
PRICE_HISTORY_SOURCE_JSON = "json"
PRICE_HISTORY_SOURCE_CELLS = "cells"


def price_history_source() -> str:
    """Active price-history read source ("json" | "cells"), from env, default json."""
    value = str(os.environ.get("PRICE_HISTORY_SOURCE") or "").strip().lower()
    return PRICE_HISTORY_SOURCE_CELLS if value == PRICE_HISTORY_SOURCE_CELLS else PRICE_HISTORY_SOURCE_JSON


def price_history_cells_enabled() -> bool:
    """True when the HISTORY readers should resolve from the normalized cell table."""
    return price_history_source() == PRICE_HISTORY_SOURCE_CELLS


def _variant_match_key(value: str | None) -> str:
    """Lowercase-alphanumeric reduction used to reconcile a variant *label*
    ("Holofoil", "Reverse Holofoil") with a stored ``variant_key``
    ("holofoil", "reverseHolofoil"). Empty/None reduces to "" (the implicit
    Normal/default bucket)."""
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


# Normalized-default variant priority (mirrors RAW_VARIANT_PRIORITY but as match
# keys, so it orders cells by their lowercase variant_key the same way the JSON
# resolver orders by variant label).
_RAW_VARIANT_PRIORITY_MATCH_KEYS = tuple(_variant_match_key(label) for label in RAW_VARIANT_PRIORITY)
# The match key for the implicit "Normal" default bucket: a cell whose
# variant_key reduces to "" or "normal"/"raw"/"standard" is treated as Normal,
# matching _normalized_variant_label.
_NORMAL_VARIANT_MATCH_KEYS = {"", "raw", "normal", "standard"}


def _cell_variant_priority_rank(variant_match_key: str) -> tuple[int, str]:
    """Rank a cell's variant match key against RAW_VARIANT_PRIORITY. The "Normal"
    bucket collapses Normal/raw/standard/empty to the same rank the JSON resolver
    gives the "Normal" label, so default-variant ordering is identical."""
    key = "normal" if variant_match_key in _NORMAL_VARIANT_MATCH_KEYS else variant_match_key
    try:
        return (_RAW_VARIANT_PRIORITY_MATCH_KEYS.index(key), key)
    except ValueError:
        return (len(_RAW_VARIANT_PRIORITY_MATCH_KEYS), key)


def _cell_summary_from_row(row: Any) -> dict[str, Any]:
    """A price summary in the same shape ``_coerce_price_summary_from_entry``
    returns, built from a cell row (sqlite Row / mapping / sequence-keyed dict).
    Cells do not persist ``trendsPct`` or ``payload`` (those live only in the JSON
    entry's ``payload``), so the JSON resolver always yields ``trendsPct=None`` and
    ``payload={}`` for the price fields the parity harness compares; the cell
    summary matches that."""
    def _get(name: str) -> Any:
        try:
            return row[name]
        except (KeyError, IndexError, TypeError):
            return None

    return {
        "currencyCode": _get("currency_code"),
        "low": _coerce_price_float(_get("low")),
        "market": _coerce_price_float(_get("market")),
        "mid": _coerce_price_float(_get("mid")),
        "high": _coerce_price_float(_get("high")),
        "directLow": _coerce_price_float(_get("direct_low")),
        "trend": _coerce_price_float(_get("trend")),
        "trendsPct": None,
        "payload": {},
    }


def price_history_cell_rows_for_day(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    price_date: str,
    lane: str | None = None,
) -> list[Any]:
    """All cell rows for one ``(card_id, price_date)``, optionally lane-filtered.
    Served by the ``(card_id, price_date, cell_key)`` UNIQUE index prefix."""
    if not _table_exists(connection, "card_price_history_cell"):
        return []
    if lane:
        return connection.execute(
            "SELECT * FROM card_price_history_cell WHERE card_id = ? AND price_date = ? AND lane = ?",
            (card_id, price_date, lane),
        ).fetchall()
    return connection.execute(
        "SELECT * FROM card_price_history_cell WHERE card_id = ? AND price_date = ?",
        (card_id, price_date),
    ).fetchall()


def resolve_raw_summary_from_cells(
    cells: list[Any],
    *,
    variant: str | None = None,
    condition: str | None = None,
) -> tuple[str | None, str | None, dict[str, Any] | None]:
    """Cell-backed twin of ``_resolve_raw_context_summary``.

    Replicates: exact (variant, condition) -> for that variant, RAW_CONDITION_PRIORITY
    -> default fallback (RAW_VARIANT_PRIORITY ordered, then condition priority, then
    first variant's first condition). Returns ``(variant_label, condition, summary)``
    where ``variant_label`` is renormalized through ``_normalized_variant_label`` so
    it matches the JSON resolver's returned variant exactly."""
    raw_cells = [c for c in cells if str(_cell_field(c, "lane") or "") == "raw"]
    if not raw_cells:
        return None, None, None

    # Index by (variant_match_key, condition) and remember the original variant_key
    # so we can re-normalize the resolved variant label identically to the JSON path.
    by_variant: dict[str, dict[str, Any]] = {}
    variant_key_by_match: dict[str, str] = {}
    for cell in raw_cells:
        vkey = str(_cell_field(cell, "variant_key") or "")
        cond = _normalized_condition_code(_cell_field(cell, "condition"))
        match_key = _variant_match_key(vkey)
        match_key = "normal" if match_key in _NORMAL_VARIANT_MATCH_KEYS else match_key
        by_variant.setdefault(match_key, {})[cond] = cell
        variant_key_by_match.setdefault(match_key, vkey)

    def _label(match_key: str) -> str:
        return _normalized_variant_label(variant_key_by_match.get(match_key))

    resolved_variant = _normalized_variant_label(variant) if variant else None
    resolved_condition = _normalized_condition_code(condition) if condition else None

    if resolved_variant:
        target_key = _variant_match_key(resolved_variant)
        target_key = "normal" if target_key in _NORMAL_VARIANT_MATCH_KEYS else target_key
        conditions = by_variant.get(target_key)
        if conditions:
            cell = conditions.get(resolved_condition) if resolved_condition else None
            if cell is None:
                for candidate in RAW_CONDITION_PRIORITY:
                    if candidate in conditions:
                        cell = conditions[candidate]
                        resolved_condition = candidate
                        break
            if cell is not None:
                return _label(target_key), resolved_condition, _cell_summary_from_row(cell)

    # Default fallback: variant-priority order, then condition priority.
    ordered_keys = sorted(by_variant.keys(), key=_cell_variant_priority_rank)
    for preferred_condition in RAW_CONDITION_PRIORITY:
        for match_key in ordered_keys:
            conditions = by_variant[match_key]
            if preferred_condition in conditions:
                return _label(match_key), preferred_condition, _cell_summary_from_row(conditions[preferred_condition])
    # No priority condition anywhere: first variant's first condition. The JSON
    # path uses dict insertion order for "first condition"; cells have no stable
    # per-day insertion order, so order conditions by RAW_CONDITION_PRIORITY then
    # natural sort to stay deterministic (the only case this differs from JSON is
    # a variant carrying ONLY non-standard condition codes, which the catalog does
    # not produce — see the parity report).
    first_key = ordered_keys[0]
    conditions = by_variant[first_key]
    if not conditions:
        return _label(first_key), None, None
    cond_order = sorted(
        conditions.keys(),
        key=lambda c: (
            RAW_CONDITION_PRIORITY.index(c) if c in RAW_CONDITION_PRIORITY else len(RAW_CONDITION_PRIORITY),
            c,
        ),
    )
    chosen = cond_order[0]
    return _label(first_key), chosen, _cell_summary_from_row(conditions[chosen])


def resolve_graded_entry_from_cells(
    cells: list[Any],
    *,
    grader: str | None,
    grade: str | None,
    variant: str | None = None,
) -> Any | None:
    """Cell-backed twin of ``_resolve_graded_context_entry``. Returns the chosen
    cell row (or ``None``); use ``_cell_summary_from_row`` to price it, or read its
    flags/variant_key directly. UPPER-cases grader/grade; among matching cells,
    prefers (variant match, not special) -> (variant match, any) -> (any, not
    special) -> first."""
    grader_key = str(grader or "").strip().upper()
    grade_key = str(grade or "").strip().upper()
    if not grader_key or not grade_key:
        return None
    matches = [
        c
        for c in cells
        if str(_cell_field(c, "lane") or "") == "graded"
        and str(_cell_field(c, "grader") or "").strip().upper() == grader_key
        and str(_cell_field(c, "grade") or "").strip().upper() == grade_key
    ]
    if not matches:
        return None
    resolved_variant = _normalized_variant_label(variant) if variant else None
    preferred: list[Any] = []
    fallback: list[Any] = []
    for cell in matches:
        is_special = any(
            bool(_cell_field(cell, flag)) for flag in ("is_perfect", "is_signed", "is_error")
        )
        cell_variant = _normalized_variant_label(_cell_field(cell, "variant_key"))
        if resolved_variant:
            if cell_variant == resolved_variant and not is_special:
                return cell
            if cell_variant == resolved_variant:
                preferred.append(cell)
        elif not is_special:
            fallback.append(cell)
        else:
            preferred.append(cell)
    if preferred:
        return preferred[0]
    if fallback:
        return fallback[0]
    return None


def raw_cell_exact_from_cells(
    cells: list[Any],
    *,
    variant: str | None,
    condition: str | None,
) -> Any | None:
    """Cell-backed twin of ``_raw_context_entry`` (EXACT match, no priority
    fallback). Reconciles a variant *label* to a stored ``variant_key`` by
    lowercase-alphanumeric match. Returns the cell row or ``None``."""
    target_variant = _normalized_variant_label(variant)
    target_key = _variant_match_key(target_variant)
    target_key = "normal" if target_key in _NORMAL_VARIANT_MATCH_KEYS else target_key
    target_condition = _normalized_condition_code(condition)
    for cell in cells:
        if str(_cell_field(cell, "lane") or "") != "raw":
            continue
        vkey = _variant_match_key(_cell_field(cell, "variant_key"))
        vkey = "normal" if vkey in _NORMAL_VARIANT_MATCH_KEYS else vkey
        if vkey != target_key:
            continue
        if _normalized_condition_code(_cell_field(cell, "condition")) == target_condition:
            return cell
    return None


def price_history_cell_rows_by_date(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    provider: str,
    price_dates: Iterable[str],
) -> dict[str, list[Any]]:
    """All cell rows for a card grouped by ``price_date`` (restricted to the given
    dates). One query (chunked) so the trend-list point series resolves from cells
    without a per-day round trip."""
    if not _table_exists(connection, "card_price_history_cell"):
        return {}
    dates = [str(d) for d in price_dates if str(d or "").strip()]
    result: dict[str, list[Any]] = {}
    for start in range(0, len(dates), 400):
        chunk = dates[start : start + 400]
        if not chunk:
            continue
        placeholders = ",".join("?" for _ in chunk)
        rows = connection.execute(
            f"""
            SELECT * FROM card_price_history_cell
            WHERE card_id = ? AND provider = ? AND price_date IN ({placeholders})
            """,
            (card_id, provider, *chunk),
        ).fetchall()
        for row in rows:
            result.setdefault(str(_cell_field(row, "price_date")), []).append(row)
    return result


def _cell_field(row: Any, name: str) -> Any:
    try:
        return row[name]
    except (KeyError, IndexError, TypeError):
        return None


def price_history_cells_from_contexts(
    *,
    card_id: str,
    provider: str,
    price_date: str,
    currency_code: str | None,
    raw_contexts: dict[str, Any] | None,
    graded_contexts: dict[str, Any] | None,
    updated_at: str,
) -> list[tuple[Any, ...]]:
    """Decompose merged raw/graded context dicts into normalized cell rows.

    Mirrors the JSON shape (migration plan Appendix A): raw =
    ``variants[<v>] -> {variantKey, conditions[<cond>] -> {prices}}``; graded =
    ``graders[<g>] -> {grade[<gr>] -> [ {variantKey, prices, flags} ]}`` (a list,
    since a grade can hold multiple variants). Returns column-ordered tuples
    matching ``_PRICE_HISTORY_CELL_COLUMNS``, deduped by ``cell_key`` (last wins)
    so a malformed duplicate can't break the PK on insert.
    """
    cells: dict[str, tuple[Any, ...]] = {}

    variants = (raw_contexts or {}).get("variants")
    if isinstance(variants, dict):
        for variant_payload in variants.values():
            if not isinstance(variant_payload, dict):
                continue
            variant_key = str(variant_payload.get("variantKey") or variant_payload.get("variant") or "")
            conditions = variant_payload.get("conditions")
            if not isinstance(conditions, dict):
                continue
            for condition_code, cell in conditions.items():
                if not isinstance(cell, dict):
                    continue
                cond = str(condition_code or "")
                cell_key = f"raw|{variant_key}|{cond}"
                cells[cell_key] = (
                    card_id, provider, price_date, "raw", cell_key,
                    variant_key or None, cond or None, None, None,
                    0, 0, 0,
                    str(cell.get("currencyCode") or currency_code or "USD"),
                    _coerce_price_float(cell.get("low")), _coerce_price_float(cell.get("market")),
                    _coerce_price_float(cell.get("mid")), _coerce_price_float(cell.get("high")),
                    _coerce_price_float(cell.get("directLow")), _coerce_price_float(cell.get("trend")),
                    updated_at,
                )

    graders = (graded_contexts or {}).get("graders")
    if isinstance(graders, dict):
        for grader_name, grades in graders.items():
            if not isinstance(grades, dict):
                continue
            for grade_value, entries in grades.items():
                entry_list = entries if isinstance(entries, list) else [entries]
                for entry in entry_list:
                    if not isinstance(entry, dict):
                        continue
                    variant_key = str(entry.get("variantKey") or entry.get("variant") or "")
                    is_perfect = 1 if entry.get("isPerfect") else 0
                    is_signed = 1 if entry.get("isSigned") else 0
                    is_error = 1 if entry.get("isError") else 0
                    grader = str(grader_name or "")
                    grade = str(grade_value or "")
                    cell_key = f"graded|{grader}|{grade}|{variant_key}|p{is_perfect}s{is_signed}e{is_error}"
                    cells[cell_key] = (
                        card_id, provider, price_date, "graded", cell_key,
                        variant_key or None, None, grader or None, grade or None,
                        is_perfect, is_signed, is_error,
                        str(entry.get("currencyCode") or currency_code or "USD"),
                        _coerce_price_float(entry.get("low")), _coerce_price_float(entry.get("market")),
                        _coerce_price_float(entry.get("mid")), _coerce_price_float(entry.get("high")),
                        _coerce_price_float(entry.get("directLow")), _coerce_price_float(entry.get("trend")),
                        updated_at,
                    )

    return list(cells.values())


def replace_price_history_cells(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    provider: str,
    price_date: str,
    currency_code: str | None,
    raw_contexts: dict[str, Any] | None,
    graded_contexts: dict[str, Any] | None,
    updated_at: str,
) -> None:
    """Phase 2 dual-write: rewrite the normalized cells for one ``(card, date)``
    to match the merged contexts just written to ``card_price_history_daily``.

    Delete-then-insert because ``merged_*`` is the COMPLETE post-merge state, so
    this preserves lane-scoped merges (a graded-only update keeps the existing raw
    cells, which are still in ``merged_raw_contexts``) and naturally drops removed
    cells. Runs in the caller's transaction, so it commits atomically with the
    JSON row. Guarded on the Phase-1 table existing: if it's absent (pre-migration
    or rolled back) this is a no-op and the JSON write remains the source of truth.
    """
    if not _table_exists(connection, "card_price_history_cell"):
        return
    cells = price_history_cells_from_contexts(
        card_id=card_id,
        provider=provider,
        price_date=price_date,
        currency_code=currency_code,
        raw_contexts=raw_contexts,
        graded_contexts=graded_contexts,
        updated_at=updated_at,
    )
    connection.execute(
        "DELETE FROM card_price_history_cell WHERE card_id = ? AND price_date = ?",
        (card_id, price_date),
    )
    if cells:
        placeholders = ",".join(["?"] * len(_PRICE_HISTORY_CELL_COLUMNS))
        connection.executemany(
            f"INSERT INTO card_price_history_cell ({', '.join(_PRICE_HISTORY_CELL_COLUMNS)}) "
            f"VALUES ({placeholders})",
            cells,
        )


def upsert_price_history_daily(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    provider: str,
    price_date: str,
    display_currency_code: str | None = None,
    raw_contexts: dict[str, Any] | None = None,
    graded_contexts: dict[str, Any] | None = None,
    default_raw_variant: str | None = None,
    default_raw_condition: str | None = None,
    default_raw_low_price: float | None = None,
    default_raw_market_price: float | None = None,
    default_raw_mid_price: float | None = None,
    default_raw_high_price: float | None = None,
    default_raw_direct_low_price: float | None = None,
    default_raw_trend_price: float | None = None,
    source_url: str | None = None,
    payload: dict[str, Any] | None = None,
    pricing_mode: str | None = None,
    currency_code: str | None = None,
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
    direct_low_price: float | None = None,
    trend_price: float | None = None,
) -> None:
    existing_row = connection.execute(
        """
        SELECT *
        FROM card_price_history_daily
        WHERE card_id = ? AND price_date = ?
        LIMIT 1
        """,
        (card_id, price_date),
    ).fetchone()
    merged_raw_contexts = _raw_contexts_payload(existing_row["raw_contexts_json"] if existing_row is not None else None)
    merged_graded_contexts = _graded_contexts_payload(existing_row["graded_contexts_json"] if existing_row is not None else None)

    if raw_contexts is not None:
        merged_raw_contexts = _raw_contexts_payload(json.dumps(raw_contexts))
    elif pricing_mode == RAW_PRICING_MODE:
        _upsert_raw_context_entry(
            merged_raw_contexts,
            variant=variant,
            condition=condition or DEFAULT_RAW_CONDITION,
            currency_code=str(currency_code or display_currency_code or "USD"),
            low_price=low_price,
            market_price=market_price,
            mid_price=mid_price,
            high_price=high_price,
            direct_low_price=direct_low_price,
            trend_price=trend_price,
            payload=payload,
        )

    if graded_contexts is not None:
        merged_graded_contexts = _graded_contexts_payload(json.dumps(graded_contexts))
    elif pricing_mode == PSA_GRADE_PRICING_MODE and grader and grade:
        _upsert_graded_context_entry(
            merged_graded_contexts,
            grader=grader,
            grade=grade,
            variant=variant,
            currency_code=str(currency_code or display_currency_code or "USD"),
            low_price=low_price,
            market_price=market_price,
            mid_price=mid_price,
            high_price=high_price,
            direct_low_price=direct_low_price,
            trend_price=trend_price,
            is_perfect=is_perfect,
            is_signed=is_signed,
            is_error=is_error,
            payload=payload,
        )

    default_fields = _default_raw_field_values(merged_raw_contexts)
    has_existing_raw_contexts = bool(_raw_context_variants(merged_raw_contexts))
    graded_only_merge = graded_contexts is not None or (pricing_mode == PSA_GRADE_PRICING_MODE and grader and grade)
    resolved_provider = provider
    if existing_row is not None and graded_only_merge and has_existing_raw_contexts:
        existing_provider = str(existing_row["provider"] or "").strip()
        if existing_provider:
            resolved_provider = existing_provider
    resolved_currency_code = str(
        display_currency_code
        or _default_display_currency_code(
            raw_contexts=merged_raw_contexts,
            graded_contexts=merged_graded_contexts,
            fallback=existing_row["display_currency_code"] if existing_row is not None else currency_code,
        )
        or "USD"
    )
    connection.execute(
        """
        INSERT INTO card_price_history_daily (
            card_id, provider, price_date, display_currency_code,
            default_raw_variant, default_raw_condition,
            default_raw_low_price, default_raw_market_price, default_raw_mid_price, default_raw_high_price,
            default_raw_direct_low_price, default_raw_trend_price,
            raw_contexts_json, graded_contexts_json,
            source_url, source_payload_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(card_id, price_date) DO UPDATE SET
            provider=excluded.provider,
            display_currency_code=excluded.display_currency_code,
            default_raw_variant=excluded.default_raw_variant,
            default_raw_condition=excluded.default_raw_condition,
            default_raw_low_price=excluded.default_raw_low_price,
            default_raw_market_price=excluded.default_raw_market_price,
            default_raw_mid_price=excluded.default_raw_mid_price,
            default_raw_high_price=excluded.default_raw_high_price,
            default_raw_direct_low_price=excluded.default_raw_direct_low_price,
            default_raw_trend_price=excluded.default_raw_trend_price,
            raw_contexts_json=excluded.raw_contexts_json,
            graded_contexts_json=excluded.graded_contexts_json,
            source_url=excluded.source_url,
            source_payload_json=excluded.source_payload_json,
            updated_at=excluded.updated_at
        """,
        (
            card_id,
            resolved_provider,
            price_date,
            resolved_currency_code,
            default_raw_variant or default_fields["defaultRawVariant"],
            default_raw_condition or default_fields["defaultRawCondition"],
            default_raw_low_price if default_raw_low_price is not None else default_fields["defaultRawLowPrice"],
            default_raw_market_price if default_raw_market_price is not None else default_fields["defaultRawMarketPrice"],
            default_raw_mid_price if default_raw_mid_price is not None else default_fields["defaultRawMidPrice"],
            default_raw_high_price if default_raw_high_price is not None else default_fields["defaultRawHighPrice"],
            default_raw_direct_low_price if default_raw_direct_low_price is not None else default_fields["defaultRawDirectLowPrice"],
            default_raw_trend_price if default_raw_trend_price is not None else default_fields["defaultRawTrendPrice"],
            json.dumps(merged_raw_contexts),
            json.dumps(merged_graded_contexts),
            source_url,
            json.dumps(payload or {}),
            utc_now(),
        ),
    )

    # Phase 2 dual-write: keep the normalized cell table in lockstep with the
    # JSON row just written, in the same transaction. No-op if the Phase-1 table
    # is absent, so the sync is unaffected pre-migration or after a rollback.
    replace_price_history_cells(
        connection,
        card_id=card_id,
        provider=resolved_provider,
        price_date=price_date,
        currency_code=resolved_currency_code,
        raw_contexts=merged_raw_contexts,
        graded_contexts=merged_graded_contexts,
        updated_at=utc_now(),
    )


def price_history_rows_for_card(
    connection: sqlite3.Connection,
    card_id: str,
    *,
    provider: str,
    days: int,
    pricing_mode: str | None = None,
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
        WHERE card_id = ? AND provider = ?
    """
    params: list[Any] = [card_id, provider]
    query += " ORDER BY price_date DESC LIMIT ?"
    params.append(max(1, int(days)))
    rows = connection.execute(query, params).fetchall()
    use_cells = price_history_cells_enabled() and _table_exists(connection, "card_price_history_cell")
    resolved_rows: list[dict[str, Any]] = []
    for row in rows:
        summary: dict[str, Any] | None = None
        resolved_variant: str | None = None
        resolved_condition: str | None = None
        resolved_mode = pricing_mode or (PSA_GRADE_PRICING_MODE if grader or grade else RAW_PRICING_MODE)
        if use_cells:
            cells = price_history_cell_rows_for_day(
                connection, card_id=card_id, price_date=str(row["price_date"])
            )
            if resolved_mode == PSA_GRADE_PRICING_MODE:
                entry = resolve_graded_entry_from_cells(
                    cells, grader=grader, grade=grade, variant=variant
                )
                summary = _cell_summary_from_row(entry) if entry is not None else None
                resolved_variant = (
                    _normalized_variant_label(_cell_field(entry, "variant_key"))
                    if entry is not None
                    else variant
                )
            else:
                resolved_variant, resolved_condition, summary = resolve_raw_summary_from_cells(
                    cells, variant=variant, condition=condition
                )
        else:
            raw_contexts = _raw_contexts_payload(row["raw_contexts_json"])
            graded_contexts = _graded_contexts_payload(row["graded_contexts_json"])
            if resolved_mode == PSA_GRADE_PRICING_MODE:
                entry = _resolve_graded_context_entry(
                    graded_contexts,
                    grader=grader,
                    grade=grade,
                    variant=variant,
                )
                summary = _coerce_price_summary_from_entry(entry)
                resolved_variant = _normalized_variant_label(entry.get("variant")) if isinstance(entry, dict) else variant
            else:
                resolved_variant, resolved_condition, summary = _resolve_raw_context_summary(
                    raw_contexts,
                    variant=variant,
                    condition=condition,
                )
        if summary is None:
            continue
        resolved_rows.append(
            {
                "id": f"{row['card_id']}:{row['price_date']}",
                "cardID": row["card_id"],
                "pricingMode": resolved_mode,
                "provider": row["provider"],
                "date": row["price_date"],
                "currencyCode": summary.get("currencyCode") or row["display_currency_code"],
                "variant": resolved_variant,
                "condition": resolved_condition,
                "grader": str(grader or "").strip().upper() or None,
                "grade": str(grade or "").strip().upper() or None,
                "isPerfect": bool(is_perfect),
                "isSigned": bool(is_signed),
                "isError": bool(is_error),
                "low": summary.get("low"),
                "market": summary.get("market"),
                "mid": summary.get("mid"),
                "high": summary.get("high"),
                "sourceURL": row["source_url"],
                "payload": summary.get("payload") or {},
                "updatedAt": row["updated_at"],
            }
        )
    return resolved_rows


def latest_price_history_update_for_context(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    provider: str,
    pricing_mode: str | None = None,
    variant: str | None = None,
    condition: str | None = None,
    grader: str | None = None,
    grade: str | None = None,
    is_perfect: bool | None = None,
    is_signed: bool | None = None,
    is_error: bool | None = None,
) -> str | None:
    query = """
        SELECT *
        FROM card_price_history_daily
        WHERE card_id = ? AND provider = ?
    """
    params: list[Any] = [card_id, provider]
    query += " ORDER BY price_date DESC, updated_at DESC"
    rows = connection.execute(query, params).fetchall()
    use_cells = price_history_cells_enabled() and _table_exists(connection, "card_price_history_cell")
    resolved_mode = pricing_mode or (PSA_GRADE_PRICING_MODE if grader or grade else RAW_PRICING_MODE)
    for row in rows:
        if use_cells:
            cells = price_history_cell_rows_for_day(
                connection, card_id=card_id, price_date=str(row["price_date"])
            )
            if resolved_mode == PSA_GRADE_PRICING_MODE:
                entry = resolve_graded_entry_from_cells(
                    cells, grader=grader, grade=grade, variant=variant
                )
                if entry is None:
                    continue
                if is_perfect is not None and bool(_cell_field(entry, "is_perfect")) != bool(is_perfect):
                    continue
                if is_signed is not None and bool(_cell_field(entry, "is_signed")) != bool(is_signed):
                    continue
                if is_error is not None and bool(_cell_field(entry, "is_error")) != bool(is_error):
                    continue
            else:
                _, _, summary = resolve_raw_summary_from_cells(
                    cells, variant=variant, condition=condition
                )
                if summary is None:
                    continue
        elif resolved_mode == PSA_GRADE_PRICING_MODE:
            entry = _resolve_graded_context_entry(
                _graded_contexts_payload(row["graded_contexts_json"]),
                grader=grader,
                grade=grade,
                variant=variant,
            )
            if entry is None:
                continue
            if is_perfect is not None and bool(entry.get("isPerfect")) != bool(is_perfect):
                continue
            if is_signed is not None and bool(entry.get("isSigned")) != bool(is_signed):
                continue
            if is_error is not None and bool(entry.get("isError")) != bool(is_error):
                continue
        else:
            _, _, summary = _resolve_raw_context_summary(
                _raw_contexts_payload(row["raw_contexts_json"]),
                variant=variant,
                condition=condition,
            )
            if summary is None:
                continue
        return str(row["updated_at"] or "").strip() or None
    return None


def price_snapshot_row(connection: sqlite3.Connection, card_id: str) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT *
        FROM card_price_snapshots
        WHERE card_id = ?
        LIMIT 1
        """,
        (card_id,),
    ).fetchone()


def latest_price_history_row_for_card(
    connection: sqlite3.Connection,
    card_id: str,
    *,
    provider: str,
    as_of_date: str | None = None,
) -> sqlite3.Row | None:
    if as_of_date:
        return connection.execute(
            """
            SELECT *
            FROM card_price_history_daily
            WHERE card_id = ? AND provider = ? AND price_date <= ?
            ORDER BY price_date DESC, updated_at DESC
            LIMIT 1
            """,
            (card_id, provider, as_of_date),
        ).fetchone()
    return connection.execute(
        """
        SELECT *
        FROM card_price_history_daily
        WHERE card_id = ? AND provider = ?
        ORDER BY price_date DESC, updated_at DESC
        LIMIT 1
        """,
        (card_id, provider),
    ).fetchone()


# --- Price-trend list (per-condition raw / per-grade graded) -----------------

# Full condition-name labels keyed by the stored short code. The data carries
# "DM" for damaged (matching RAW_CONDITION_PRIORITY); we also accept "DMG".
_RAW_CONDITION_LABELS: dict[str, str] = {
    "NM": "Near Mint",
    "LP": "Lightly Played",
    "MP": "Moderately Played",
    "HP": "Heavily Played",
    "DM": "Damaged",
    "DMG": "Damaged",
}


def _price_trend_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _grade_sort_key(grade: str) -> tuple[int, float, str]:
    """Order grades high to low; numeric grades sort by value descending."""
    try:
        return (0, -float(grade), grade)
    except (TypeError, ValueError):
        return (1, 0.0, grade)


def _trend_pct_from_points(points: list[float], entry: dict[str, Any] | None) -> float | None:
    """First->last percent change; falls back to the entry's 30-day trendsPct."""
    if len(points) >= 2 and points[0] not in (None, 0):
        try:
            return (points[-1] - points[0]) / points[0] * 100.0
        except (TypeError, ZeroDivisionError):
            pass
    if isinstance(entry, dict):
        trends_pct = entry.get("trendsPct")
        if isinstance(trends_pct, dict):
            return _price_trend_float(trends_pct.get("days30"))
    return None


def card_price_trend_list(
    connection: sqlite3.Connection,
    card_id: str,
    *,
    mode: str,
    provider: str,
    variant: str | None = None,
    grader: str | None = None,
    days: int = 90,
) -> dict[str, Any]:
    """Build a CardPriceTrendList for a card from cached pricing rows.

    Read-only: reads daily history (oldest->newest point series) plus the
    current snapshot (currentPrice / trendsPct) from SQLite. No provider fetch.
    - mode='graded' -> one row per grader/grade, label/key "<grader> <grade>".
    - mode='raw'    -> one row per condition for the chosen/default variant.
    """
    normalized_mode = PSA_GRADE_PRICING_MODE if str(mode).strip().lower() == PSA_GRADE_PRICING_MODE else RAW_PRICING_MODE
    is_graded = normalized_mode == PSA_GRADE_PRICING_MODE
    response_provider = "ebay" if is_graded else "tcgplayer"

    history_rows = connection.execute(
        """
        SELECT price_date, raw_contexts_json, graded_contexts_json
        FROM card_price_history_daily
        WHERE card_id = ? AND provider = ?
        ORDER BY price_date ASC, updated_at ASC
        LIMIT ?
        """,
        (card_id, provider, max(1, int(days))),
    ).fetchall()
    snapshot_row = price_snapshot_row(connection, card_id)

    # When the cell flag is on, the per-day POINT SERIES is resolved from the
    # normalized cell table instead of the history-daily JSON blobs (the snapshot
    # below stays on card_price_snapshots JSON regardless — out of scope for the
    # flag). Fetch all cells for the window once, grouped by date.
    use_cells = price_history_cells_enabled() and _table_exists(connection, "card_price_history_cell")
    cells_by_date: dict[str, list[Any]] = (
        price_history_cell_rows_by_date(
            connection,
            card_id=card_id,
            provider=provider,
            price_dates=[str(r["price_date"]) for r in history_rows],
        )
        if use_cells
        else {}
    )

    rows: list[dict[str, Any]] = []
    currency_code = "USD"

    if is_graded:
        grader_filter = str(grader or "").strip().upper() or None
        snapshot_graded = (
            _graded_contexts_payload(snapshot_row["graded_contexts_json"]) if snapshot_row is not None else _empty_graded_contexts()
        )
        snapshot_graders = snapshot_graded.get("graders") if isinstance(snapshot_graded.get("graders"), dict) else {}

        # Collect the (grader, grade) pairs that appear in the snapshot, in a
        # stable grader order with grades high->low.
        ordered_pairs: list[tuple[str, str]] = []
        for grader_key in sorted(snapshot_graders.keys()):
            if grader_filter and grader_key != grader_filter:
                continue
            grade_map = snapshot_graders.get(grader_key)
            if not isinstance(grade_map, dict):
                continue
            for grade_key in sorted(grade_map.keys(), key=_grade_sort_key):
                ordered_pairs.append((grader_key, grade_key))

        for grader_key, grade_key in ordered_pairs:
            points: list[float] = []
            for row in history_rows:
                if use_cells:
                    cell = resolve_graded_entry_from_cells(
                        cells_by_date.get(str(row["price_date"]), []),
                        grader=grader_key,
                        grade=grade_key,
                    )
                    market = _price_trend_float(_cell_field(cell, "market")) if cell is not None else None
                else:
                    entry = _resolve_graded_context_entry(
                        _graded_contexts_payload(row["graded_contexts_json"]),
                        grader=grader_key,
                        grade=grade_key,
                    )
                    market = _price_trend_float(entry.get("market")) if isinstance(entry, dict) else None
                if market is not None:
                    points.append(market)
            snapshot_entry = _resolve_graded_context_entry(
                snapshot_graded,
                grader=grader_key,
                grade=grade_key,
            )
            current_price = _price_trend_float(snapshot_entry.get("market")) if isinstance(snapshot_entry, dict) else None
            if not points and current_price is None:
                continue
            if isinstance(snapshot_entry, dict) and str(snapshot_entry.get("currencyCode") or "").strip():
                currency_code = str(snapshot_entry.get("currencyCode"))
            label = f"{grader_key} {grade_key}"
            rows.append(
                {
                    "label": label,
                    "key": label,
                    "currentPrice": current_price,
                    "currencyCode": currency_code,
                    "points": points,
                    "trendPct": _trend_pct_from_points(points, snapshot_entry),
                }
            )
        return {"mode": PSA_GRADE_PRICING_MODE, "provider": response_provider, "rows": rows}

    # Raw mode.
    snapshot_raw = (
        _raw_contexts_payload(snapshot_row["raw_contexts_json"]) if snapshot_row is not None else _empty_raw_contexts()
    )
    resolved_variant = _normalized_variant_label(variant) if variant else None
    if resolved_variant is None or not _raw_context_conditions(snapshot_raw, resolved_variant):
        default_variant, _, _ = _resolve_default_raw_context(snapshot_raw)
        resolved_variant = default_variant or resolved_variant

    condition_codes = _raw_context_conditions(snapshot_raw, resolved_variant) if resolved_variant else []
    # Order NM->LP->MP->HP->DM(G); unknown codes trail in their natural order.
    priority_index = {code: idx for idx, code in enumerate(RAW_CONDITION_PRIORITY)}
    ordered_conditions = sorted(
        condition_codes,
        key=lambda code: (priority_index.get(code, len(RAW_CONDITION_PRIORITY)), code),
    )

    for condition_code in ordered_conditions:
        points = []
        for row in history_rows:
            if use_cells:
                cell = raw_cell_exact_from_cells(
                    cells_by_date.get(str(row["price_date"]), []),
                    variant=resolved_variant,
                    condition=condition_code,
                )
                market = _price_trend_float(_cell_field(cell, "market")) if cell is not None else None
            else:
                entry = _raw_context_entry(
                    _raw_contexts_payload(row["raw_contexts_json"]),
                    variant=resolved_variant,
                    condition=condition_code,
                )
                market = _price_trend_float(entry.get("market")) if isinstance(entry, dict) else None
            if market is not None:
                points.append(market)
        snapshot_entry = _raw_context_entry(snapshot_raw, variant=resolved_variant, condition=condition_code)
        current_price = _price_trend_float(snapshot_entry.get("market")) if isinstance(snapshot_entry, dict) else None
        if not points and current_price is None:
            continue
        if isinstance(snapshot_entry, dict) and str(snapshot_entry.get("currencyCode") or "").strip():
            currency_code = str(snapshot_entry.get("currencyCode"))
        rows.append(
            {
                "label": _RAW_CONDITION_LABELS.get(condition_code, condition_code),
                "key": condition_code,
                "currentPrice": current_price,
                "currencyCode": currency_code,
                "points": points,
                "trendPct": _trend_pct_from_points(points, snapshot_entry),
            }
        )
    return {"mode": RAW_PRICING_MODE, "provider": response_provider, "rows": rows}


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
    condition: str | None = None,
) -> dict[str, Any] | None:
    query = """
        SELECT *
        FROM card_price_snapshots
        WHERE card_id = ?
    """
    row = connection.execute(query, (card_id,)).fetchone()
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
    raw_contexts = _raw_contexts_payload(row["raw_contexts_json"])
    graded_contexts = _graded_contexts_payload(row["graded_contexts_json"])
    payload = _json_load(row["source_payload_json"], {})
    summary: dict[str, Any] | None = None
    resolved_variant: str | None = None
    resolved_payload: dict[str, Any] = {}
    if pricing_mode == PSA_GRADE_PRICING_MODE:
        entry = _resolve_graded_context_entry(graded_contexts, grader=grader, grade=grade, variant=variant)
        summary = _coerce_price_summary_from_entry(entry)
        if summary is None:
            return None
        resolved_variant = _normalized_variant_label(entry.get("variant")) if isinstance(entry, dict) else variant
        resolved_payload = summary.get("payload") or {}
        resolved_condition = None
    else:
        resolved_variant, resolved_condition, summary = _resolve_raw_context_summary(
            raw_contexts,
            variant=variant or row["default_raw_variant"],
            condition=condition or DEFAULT_RAW_CONDITION,
        )
        if summary is None and row["default_raw_market_price"] is not None:
            summary = {
                "currencyCode": row["display_currency_code"],
                "low": row["default_raw_low_price"],
                "market": row["default_raw_market_price"],
                "mid": row["default_raw_mid_price"],
                "high": row["default_raw_high_price"],
                "directLow": row["default_raw_direct_low_price"],
                "trend": row["default_raw_trend_price"],
                "payload": {},
            }
            resolved_condition = row["default_raw_condition"]
        if summary is None:
            return None
        resolved_payload = summary.get("payload") or {}
        variant = resolved_variant
    return {
        "id": row["card_id"],
        "cardID": row["card_id"],
        "pricingMode": "psa_grade_estimate" if pricing_mode == PSA_GRADE_PRICING_MODE else pricing_mode,
        "provider": row["provider"],
        "source": row["provider"],
        "grader": str(grader or "").strip().upper() or None,
        "grade": str(grade or "").strip().upper() or None,
        "variant": resolved_variant if pricing_mode == PSA_GRADE_PRICING_MODE else (variant or row["default_raw_variant"]),
        "currencyCode": summary.get("currencyCode") or row["display_currency_code"],
        "low": summary.get("low"),
        "market": summary.get("market"),
        "mid": summary.get("mid"),
        "high": summary.get("high"),
        "directLow": summary.get("directLow"),
        "trend": summary.get("trend"),
        "trendsPct": summary.get("trendsPct"),
        "sourceURL": row["source_url"],
        "updatedAt": row["source_updated_at"],
        "refreshedAt": row["updated_at"],
        "pricingTier": resolved_payload.get("pricingTier") if resolved_payload else payload.get("pricingTier"),
        "confidenceLabel": resolved_payload.get("confidenceLabel") if resolved_payload else payload.get("confidenceLabel"),
        "confidenceLevel": resolved_payload.get("confidenceLevel") if resolved_payload else payload.get("confidenceLevel"),
        "compCount": resolved_payload.get("compCount") if resolved_payload else payload.get("compCount"),
        "recentCompCount": resolved_payload.get("recentCompCount") if resolved_payload else payload.get("recentCompCount"),
        "lastSoldPrice": resolved_payload.get("lastSalePrice") if resolved_payload else payload.get("lastSalePrice"),
        "lastSoldAt": resolved_payload.get("lastSaleDate") if resolved_payload else payload.get("lastSaleDate"),
        "bucketKey": resolved_payload.get("bucketKey") if resolved_payload else payload.get("bucketKey"),
        "methodologySummary": resolved_payload.get("summary") if resolved_payload else payload.get("summary"),
        "payload": resolved_payload if resolved_payload else payload,
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
    condition: str | None = None,
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
    return price_snapshot_for_card(
        connection,
        card_id,
        pricing_mode=RAW_PRICING_MODE,
        variant=variant,
        condition=condition,
    )


def slab_recent_sales_cache(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    grader: str,
    grade: str,
    source: str = "ebay",
    limit: int = 5,
) -> dict[str, Any] | None:
    normalized_card_id = str(card_id or "").strip()
    normalized_grader = str(grader or "").strip().upper()
    normalized_grade = str(grade or "").strip().upper()
    normalized_source = str(source or "").strip().lower()
    if not normalized_card_id or not normalized_grader or not normalized_grade or not normalized_source:
        return None
    if not _table_exists(connection, "slab_recent_sales_cache"):
        return None

    cache_row = connection.execute(
        """
        SELECT *
        FROM slab_recent_sales_cache
        WHERE card_id = ?
          AND grader = ?
          AND grade = ?
          AND source = ?
        LIMIT 1
        """,
        (normalized_card_id, normalized_grader, normalized_grade, normalized_source),
    ).fetchone()
    if cache_row is None:
        return None

    safe_limit = max(1, min(int(limit), 25))
    sale_rows = connection.execute(
        """
        SELECT *
        FROM slab_recent_sales
        WHERE card_id = ?
          AND grader = ?
          AND grade = ?
          AND source = ?
        ORDER BY rank ASC, sold_at DESC, id ASC
        LIMIT ?
        """,
        (normalized_card_id, normalized_grader, normalized_grade, normalized_source, safe_limit),
    ).fetchall() if _table_exists(connection, "slab_recent_sales") else []

    return {
        "cardID": cache_row["card_id"],
        "grader": cache_row["grader"],
        "grade": cache_row["grade"],
        "source": cache_row["source"],
        "status": cache_row["status"],
        "resultCount": int(cache_row["result_count"] or 0),
        "fetchedAt": cache_row["fetched_at"],
        "sourceURL": cache_row["source_url"],
        "sourcePayload": _json_load(cache_row["source_payload_json"], {}),
        "createdAt": cache_row["created_at"],
        "updatedAt": cache_row["updated_at"],
        "sales": [
            {
                "id": row["id"],
                "cardID": row["card_id"],
                "grader": row["grader"],
                "grade": row["grade"],
                "source": row["source"],
                "sourceSaleID": row["source_sale_id"],
                "rank": int(row["rank"] or 0),
                "title": row["title"],
                "soldAt": row["sold_at"],
                "price": row["price"],
                "currencyCode": row["currency_code"],
                "listingURL": row["listing_url"],
                "variant": row["variant"],
                "sourcePayload": _json_load(row["source_payload_json"], {}),
            }
            for row in sale_rows
        ],
    }


def replace_slab_recent_sales_cache(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    grader: str,
    grade: str,
    source: str = "ebay",
    sales: list[dict[str, Any]] | None = None,
    fetched_at: str | None = None,
    source_url: str | None = None,
    source_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_card_id = str(card_id or "").strip()
    normalized_grader = str(grader or "").strip().upper()
    normalized_grade = str(grade or "").strip().upper()
    normalized_source = str(source or "").strip().lower()
    if not normalized_card_id or not normalized_grader or not normalized_grade or not normalized_source:
        raise ValueError("card_id, grader, grade, and source are required")
    if not _card_exists(connection, normalized_card_id):
        raise ValueError("card_id does not exist")
    if not _table_exists(connection, "slab_recent_sales_cache") or not _table_exists(connection, "slab_recent_sales"):
        raise ValueError("slab recent sales schema is not installed")

    recorded_at = str(fetched_at or utc_now()).strip() or utc_now()
    normalized_sales = [dict(sale or {}) for sale in (sales or [])]
    status = "available" if normalized_sales else "no_results"
    now = utc_now()
    connection.execute(
        """
        INSERT INTO slab_recent_sales_cache (
            card_id, grader, grade, source, status, result_count, fetched_at,
            source_url, source_payload_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(card_id, grader, grade, source) DO UPDATE SET
            status=excluded.status,
            result_count=excluded.result_count,
            fetched_at=excluded.fetched_at,
            source_url=excluded.source_url,
            source_payload_json=excluded.source_payload_json,
            updated_at=excluded.updated_at
        """,
        (
            normalized_card_id,
            normalized_grader,
            normalized_grade,
            normalized_source,
            status,
            len(normalized_sales),
            recorded_at,
            str(source_url or "").strip() or None,
            json.dumps(source_payload or {}),
            now,
            now,
        ),
    )
    connection.execute(
        """
        DELETE FROM slab_recent_sales
        WHERE card_id = ?
          AND grader = ?
          AND grade = ?
          AND source = ?
        """,
        (normalized_card_id, normalized_grader, normalized_grade, normalized_source),
    )
    for index, sale in enumerate(normalized_sales, start=1):
        source_sale_id = str(sale.get("sourceSaleID") or sale.get("source_sale_id") or "").strip() or None
        sale_id = "|".join(
            [
                "slab-recent-sale",
                normalized_card_id,
                normalized_grader,
                normalized_grade,
                normalized_source,
                source_sale_id or str(index),
            ]
        )
        connection.execute(
            """
            INSERT INTO slab_recent_sales (
                id, card_id, grader, grade, source, source_sale_id, rank, title,
                sold_at, price, currency_code, listing_url, variant,
                source_payload_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sale_id,
                normalized_card_id,
                normalized_grader,
                normalized_grade,
                normalized_source,
                source_sale_id,
                int(sale.get("rank") or index),
                str(sale.get("title") or "").strip() or None,
                str(sale.get("soldAt") or sale.get("sold_at") or "").strip() or None,
                None if sale.get("price") is None else float(sale.get("price")),
                str(sale.get("currencyCode") or sale.get("currency") or "").strip().upper() or None,
                str(sale.get("listingURL") or sale.get("url") or "").strip() or None,
                str(sale.get("variant") or "").strip() or None,
                json.dumps(sale.get("sourcePayload") if isinstance(sale.get("sourcePayload"), dict) else sale),
                now,
            ),
        )
    return slab_recent_sales_cache(
        connection,
        card_id=normalized_card_id,
        grader=normalized_grader,
        grade=normalized_grade,
        source=normalized_source,
        limit=max(1, len(normalized_sales) or 1),
    ) or {
        "cardID": normalized_card_id,
        "grader": normalized_grader,
        "grade": normalized_grade,
        "source": normalized_source,
        "status": status,
        "resultCount": len(normalized_sales),
        "fetchedAt": recorded_at,
        "sourceURL": source_url,
        "sourcePayload": source_payload or {},
        "sales": [],
    }


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
        provider=source,
        pricing_mode=RAW_PRICING_MODE,
        currency_code=currency_code,
        variant=variant,
        condition=DEFAULT_RAW_CONDITION,
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
        provider=source,
        pricing_mode=PSA_GRADE_PRICING_MODE,
        grader=grader,
        grade=grade,
        variant=variant or DEFAULT_RAW_VARIANT,
        currency_code=currency_code,
        low_price=low_price,
        market_price=market_price,
        mid_price=mid_price,
        high_price=high_price,
        is_perfect=bool(snapshot_payload.get("isPerfect")),
        is_signed=bool(snapshot_payload.get("isSigned")),
        is_error=bool(snapshot_payload.get("isError")),
        source_url=source_url,
        payload=snapshot_payload,
    )


def upsert_scan_event(
    connection: sqlite3.Connection,
    *,
    scan_id: str,
    owner_user_id: str | None = None,
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
            scan_id, owner_user_id, created_at, resolver_mode, resolver_path,
            request_json, response_json, matcher_source, matcher_version,
            predicted_card_id, selected_card_id, selected_rank, was_top_prediction,
            selection_source, confirmed_card_id, confirmation_source, deck_entry_id,
            confidence, review_disposition, correction_type, completed_at, confirmed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scan_id) DO UPDATE SET
            owner_user_id=COALESCE(excluded.owner_user_id, scan_events.owner_user_id),
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
            owner_user_id,
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
    owner_user_id: str | None = None,
    source_object_path: str | None = None,
    normalized_object_path: str | None = None,
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
            scan_id, owner_user_id, source_object_path, normalized_object_path, source_width, source_height,
            normalized_width, normalized_height, camera_zoom_factor, capture_source,
            upload_status, uploaded_at, artifact_version, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scan_id) DO UPDATE SET
            owner_user_id=COALESCE(excluded.owner_user_id, scan_artifacts.owner_user_id),
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
            owner_user_id,
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


def insert_card_transaction(
    connection: sqlite3.Connection,
    *,
    transaction_id: str,
    owner_user_id: str,
    kind: str,
    amount_cents: int | None,
    currency_code: str,
    occurred_at: str,
    item_count: int = 1,
    note: str | None = None,
    photo_object_path: str | None = None,
    photo_upload_status: str | None = None,
    photo_uploaded_at: str | None = None,
    photo_width: int | None = None,
    photo_height: int | None = None,
    image_url: str | None = None,
    created_at: str | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO card_transactions (
            id, owner_user_id, kind, amount_cents, item_count, currency_code, note,
            photo_object_path, photo_upload_status, photo_uploaded_at,
            photo_width, photo_height, image_url, occurred_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            transaction_id,
            owner_user_id,
            kind,
            amount_cents,
            item_count,
            currency_code,
            note,
            photo_object_path,
            photo_upload_status,
            photo_uploaded_at,
            photo_width,
            photo_height,
            image_url,
            occurred_at,
            created_at or utc_now(),
        ),
    )


def list_card_transactions(
    connection: sqlite3.Connection,
    *,
    owner_user_id: str,
    kind: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> list[dict[str, Any]]:
    clauses = ["owner_user_id = ?"]
    params: list[Any] = [owner_user_id]
    if kind:
        clauses.append("kind = ?")
        params.append(kind)
    where = " AND ".join(clauses)
    sql = (
        "SELECT id, owner_user_id, kind, amount_cents, item_count, currency_code, note, "
        "photo_object_path, photo_upload_status, photo_uploaded_at, "
        "photo_width, photo_height, image_url, occurred_at, created_at "
        f"FROM card_transactions WHERE {where} "
        "ORDER BY occurred_at DESC, id DESC"
    )
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        params.extend([int(limit), int(offset)])
    rows = connection.execute(sql, tuple(params)).fetchall()
    return [dict(row) for row in rows]


def get_card_transaction(
    connection: sqlite3.Connection,
    *,
    transaction_id: str,
    owner_user_id: str,
) -> dict[str, Any] | None:
    row = connection.execute(
        "SELECT id, owner_user_id, kind, amount_cents, item_count, currency_code, note, "
        "photo_object_path, photo_upload_status, photo_uploaded_at, "
        "photo_width, photo_height, image_url, occurred_at, created_at "
        "FROM card_transactions WHERE id = ? AND owner_user_id = ?",
        (transaction_id, owner_user_id),
    ).fetchone()
    if row is None:
        return None
    return dict(row)


def delete_card_transaction(
    connection: sqlite3.Connection,
    *,
    transaction_id: str,
    owner_user_id: str,
) -> bool:
    cursor = connection.execute(
        "DELETE FROM card_transactions WHERE id = ? AND owner_user_id = ?",
        (transaction_id, owner_user_id),
    )
    return cursor.rowcount > 0


def deck_entry_storage_key(
    *,
    card_id: str,
    grader: str | None = None,
    grade: str | None = None,
    cert_number: str | None = None,
    variant_name: str | None = None,
    condition: str | None = None,
) -> str:
    normalized_card_id = str(card_id or "").strip()
    normalized_variant_name = str(variant_name or "").strip() or None
    normalized_condition = str(condition or "").strip().lower() or None
    is_slab_entry = any(str(value or "").strip() for value in (grader, grade, cert_number))

    if not is_slab_entry:
        if not normalized_variant_name and normalized_condition in {None, "", "near_mint"}:
            return f"raw|{normalized_card_id}"
        return "|".join(
            [
                "raw",
                normalized_card_id,
                normalized_variant_name or "",
                normalized_condition or "near_mint",
            ]
        )

    if not any(str(value or "").strip() for value in (grader, grade, cert_number, variant_name)):
        return f"raw|{normalized_card_id}"
    return "|".join(
        [
            "slab",
            normalized_card_id,
            str(grader or "").strip(),
            str(grade or "").strip(),
            str(cert_number or "").strip(),
            normalized_variant_name or "",
        ]
    )


def append_deck_entry_event(
    connection: sqlite3.Connection,
    *,
    owner_user_id: str | None = None,
    deck_entry_id: str,
    card_id: str,
    event_kind: str,
    quantity_delta: int = 0,
    unit_price: float | None = None,
    total_price: float | None = None,
    currency_code: str | None = None,
    payment_method: str | None = None,
    condition: str | None = None,
    grader: str | None = None,
    grade: str | None = None,
    cert_number: str | None = None,
    variant_name: str | None = None,
    sale_id: str | None = None,
    source_scan_id: str | None = None,
    source_confirmation_id: str | None = None,
    created_at: str | None = None,
    event_id: str | None = None,
) -> str | None:
    if not _table_exists(connection, "deck_entry_events"):
        return None

    normalized_event_id = str(event_id or "").strip() or f"{event_kind}:{uuid.uuid4().hex}"
    connection.execute(
        """
        INSERT INTO deck_entry_events (
            id, owner_user_id, deck_entry_id, card_id, event_kind, quantity_delta, unit_price,
            total_price, currency_code, payment_method, condition,
            grader, grade, cert_number, variant_name, sale_id,
            source_scan_id, source_confirmation_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            owner_user_id=COALESCE(excluded.owner_user_id, deck_entry_events.owner_user_id),
            deck_entry_id=excluded.deck_entry_id,
            card_id=excluded.card_id,
            event_kind=excluded.event_kind,
            quantity_delta=excluded.quantity_delta,
            unit_price=excluded.unit_price,
            total_price=excluded.total_price,
            currency_code=excluded.currency_code,
            payment_method=excluded.payment_method,
            condition=excluded.condition,
            grader=excluded.grader,
            grade=excluded.grade,
            cert_number=excluded.cert_number,
            variant_name=excluded.variant_name,
            sale_id=excluded.sale_id,
            source_scan_id=excluded.source_scan_id,
            source_confirmation_id=excluded.source_confirmation_id,
            created_at=excluded.created_at
        """,
        (
            normalized_event_id,
            owner_user_id,
            deck_entry_id,
            card_id,
            event_kind,
            int(quantity_delta or 0),
            None if unit_price is None else float(unit_price),
            None if total_price is None else float(total_price),
            str(currency_code or "").strip() or None,
            str(payment_method or "").strip() or None,
            str(condition or "").strip() or None,
            str(grader or "").strip() or None,
            str(grade or "").strip() or None,
            str(cert_number or "").strip() or None,
            str(variant_name or "").strip() or None,
            str(sale_id or "").strip() or None,
            str(source_scan_id or "").strip() or None,
            str(source_confirmation_id or "").strip() or None,
            created_at or utc_now(),
        ),
    )
    return normalized_event_id


def record_sale_event(
    connection: sqlite3.Connection,
    *,
    owner_user_id: str,
    deck_entry_id: str,
    card_id: str,
    quantity: int = 1,
    unit_price: float | None = None,
    currency_code: str | None = None,
    payment_method: str | None = None,
    sale_source: str = "manual",
    show_session_id: str | None = None,
    note: str | None = None,
    sold_at: str | None = None,
    paid_at: str | None = None,
    source_scan_id: str | None = None,
    source_confirmation_id: str | None = None,
) -> str | None:
    if not _table_exists(connection, "sale_events"):
        return None

    # Use the broader SELECT only when the Collections-redesign columns exist on
    # deck_entries (otherwise older test databases blow up). _table_columns is
    # cheap and called once per sale.
    deck_entry_columns = _table_columns(connection, "deck_entries")
    has_listing_columns = (
        "cost_basis_cents" in deck_entry_columns
        and "listing_url" in deck_entry_columns
        and "listing_price_cents" in deck_entry_columns
        and "listed_at" in deck_entry_columns
    )
    if has_listing_columns:
        row = connection.execute(
            """
            SELECT
                quantity,
                cost_basis_total,
                condition,
                grader,
                grade,
                cert_number,
                variant_name,
                cost_basis_cents,
                listing_url,
                listing_price_cents,
                listed_at
            FROM deck_entries
            WHERE id = ?
              AND owner_user_id = ?
            LIMIT 1
            """,
            (deck_entry_id, owner_user_id),
        ).fetchone()
    else:
        row = connection.execute(
            """
            SELECT quantity, cost_basis_total, condition, grader, grade, cert_number, variant_name
            FROM deck_entries
            WHERE id = ?
              AND owner_user_id = ?
            LIMIT 1
            """,
            (deck_entry_id, owner_user_id),
        ).fetchone()
    if row is None:
        return None

    current_quantity = max(0, int(row["quantity"] or 0))
    normalized_quantity = max(1, int(quantity))
    if normalized_quantity > current_quantity:
        raise ValueError("sale quantity exceeds deck quantity")

    current_cost_basis_total = float(row["cost_basis_total"] or 0.0)
    cost_basis_unit_price = None
    cost_basis_total = 0.0
    if current_quantity > 0 and current_cost_basis_total > 0:
        cost_basis_unit_price = current_cost_basis_total / float(current_quantity)
        cost_basis_total = round(cost_basis_unit_price * normalized_quantity, 2)
    remaining_cost_basis_total = round(max(0.0, current_cost_basis_total - cost_basis_total), 2)

    # Per-unit cents snapshot: prefer the explicit `cost_basis_cents` column on
    # the inventory row (new field). Fall back to deriving from cost_basis_total
    # / quantity only when the new field is null but the legacy total is set.
    cost_basis_per_unit_cents: int | None = None
    if has_listing_columns:
        raw_cost_basis_cents = row["cost_basis_cents"]
        if raw_cost_basis_cents is not None:
            try:
                cost_basis_per_unit_cents = int(raw_cost_basis_cents)
            except (TypeError, ValueError):
                cost_basis_per_unit_cents = None
    if cost_basis_per_unit_cents is None and cost_basis_unit_price is not None:
        try:
            cost_basis_per_unit_cents = int(round(float(cost_basis_unit_price) * 100.0))
        except (TypeError, ValueError):
            cost_basis_per_unit_cents = None

    sale_id = f"sale:{uuid.uuid4().hex}"
    normalized_sold_at = sold_at or utc_now()
    normalized_paid_at = str(paid_at or "").strip() or None
    normalized_unit_price = None if unit_price is None else float(unit_price)
    total_price = None if normalized_unit_price is None else normalized_unit_price * normalized_quantity

    # profit_cents = (sold_price_cents − cost_basis_per_unit_cents) × quantity
    profit_cents: int | None = None
    if (
        cost_basis_per_unit_cents is not None
        and normalized_unit_price is not None
    ):
        try:
            unit_price_cents = int(round(float(normalized_unit_price) * 100.0))
            profit_cents = (unit_price_cents - cost_basis_per_unit_cents) * normalized_quantity
        except (TypeError, ValueError):
            profit_cents = None

    # Listing snapshot — only captured when the deck row had an active listing.
    last_listing_snapshot_json: str | None = None
    if has_listing_columns:
        listing_url_value = str(row["listing_url"] or "").strip() if row["listing_url"] is not None else ""
        if listing_url_value:
            try:
                listing_price_cents_value = (
                    int(row["listing_price_cents"]) if row["listing_price_cents"] is not None else None
                )
            except (TypeError, ValueError):
                listing_price_cents_value = None
            listed_at_value = str(row["listed_at"] or "").strip() if row["listed_at"] is not None else None
            last_listing_snapshot_json = json.dumps(
                {
                    "listing_url": listing_url_value,
                    "listing_price_cents": listing_price_cents_value,
                    "listed_at": listed_at_value or None,
                }
            )

    sale_columns = _table_columns(connection, "sale_events")
    has_redesign_sale_columns = (
        "cost_basis_per_unit_cents" in sale_columns
        and "profit_cents" in sale_columns
        and "last_listing_snapshot" in sale_columns
    )
    if has_redesign_sale_columns:
        connection.execute(
            """
            INSERT INTO sale_events (
                id, owner_user_id, deck_entry_id, card_id, quantity, unit_price, total_price,
                currency_code, payment_method, cost_basis_total, cost_basis_unit_price,
                sale_source, show_session_id, note, sold_at, paid_at,
                source_scan_id, source_confirmation_id, created_at,
                cost_basis_per_unit_cents, profit_cents, last_listing_snapshot
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sale_id,
                owner_user_id,
                deck_entry_id,
                card_id,
                normalized_quantity,
                normalized_unit_price,
                total_price,
                str(currency_code or "").strip() or None,
                str(payment_method or "").strip() or None,
                cost_basis_total if cost_basis_total > 0 else 0.0,
                cost_basis_unit_price,
                str(sale_source or "manual").strip() or "manual",
                str(show_session_id or "").strip() or None,
                str(note or "").strip() or None,
                normalized_sold_at,
                normalized_paid_at,
                str(source_scan_id or "").strip() or None,
                str(source_confirmation_id or "").strip() or None,
                utc_now(),
                cost_basis_per_unit_cents,
                profit_cents,
                last_listing_snapshot_json,
            ),
        )
    else:
        connection.execute(
            """
            INSERT INTO sale_events (
                id, owner_user_id, deck_entry_id, card_id, quantity, unit_price, total_price,
                currency_code, payment_method, cost_basis_total, cost_basis_unit_price,
                sale_source, show_session_id, note, sold_at, paid_at,
                source_scan_id, source_confirmation_id, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sale_id,
                owner_user_id,
                deck_entry_id,
                card_id,
                normalized_quantity,
                normalized_unit_price,
                total_price,
                str(currency_code or "").strip() or None,
                str(payment_method or "").strip() or None,
                cost_basis_total if cost_basis_total > 0 else 0.0,
                cost_basis_unit_price,
                str(sale_source or "manual").strip() or "manual",
                str(show_session_id or "").strip() or None,
                str(note or "").strip() or None,
                normalized_sold_at,
                normalized_paid_at,
                str(source_scan_id or "").strip() or None,
                str(source_confirmation_id or "").strip() or None,
                utc_now(),
            ),
        )

    # Clear the active listing fields on the inventory row when we snapshotted
    # a listing into the sale (idempotent — only writes the columns that exist).
    if has_listing_columns and last_listing_snapshot_json is not None:
        connection.execute(
            """
            UPDATE deck_entries
            SET listing_url = NULL,
                listing_price_cents = NULL,
                listed_at = NULL
            WHERE id = ?
              AND owner_user_id = ?
            """,
            (deck_entry_id, owner_user_id),
        )
    if normalized_paid_at is not None:
        connection.execute(
            """
            UPDATE deck_entries
            SET quantity = quantity - ?,
                cost_basis_total = ?,
                updated_at = ?
            WHERE id = ?
              AND owner_user_id = ?
            """,
            (
                normalized_quantity,
                remaining_cost_basis_total,
                normalized_sold_at,
                deck_entry_id,
                owner_user_id,
            ),
        )
        append_deck_entry_event(
            connection,
            owner_user_id=owner_user_id,
            deck_entry_id=deck_entry_id,
            card_id=card_id,
            event_kind="sale",
            quantity_delta=-normalized_quantity,
            total_price=total_price,
            unit_price=normalized_unit_price,
            currency_code=currency_code,
            payment_method=payment_method,
            sale_id=sale_id,
            source_scan_id=source_scan_id,
            source_confirmation_id=source_confirmation_id,
            created_at=normalized_sold_at,
        )
    return sale_id


def upsert_deck_entry(
    connection: sqlite3.Connection,
    *,
    owner_user_id: str | None = None,
    card_id: str,
    grader: str | None = None,
    grade: str | None = None,
    cert_number: str | None = None,
    variant_name: str | None = None,
    condition: str | None = None,
    quantity: int = 1,
    unit_price: float | None = None,
    currency_code: str | None = None,
    payment_method: str | None = None,
    added_at: str | None = None,
    updated_at: str | None = None,
    source_scan_id: str | None = None,
    source_confirmation_id: str | None = None,
    event_kind: str = "add",
) -> str:
    normalized_owner_user_id = (
        str(owner_user_id or "").strip()
        or _runtime_default_owner_user_id()
        or _user_isolation_backfill_owner_user_id()
    )
    if not normalized_owner_user_id:
        raise ValueError("owner_user_id is required when auth is enabled")
    identity_key = deck_entry_storage_key(
        card_id=card_id,
        grader=grader,
        grade=grade,
        cert_number=cert_number,
        variant_name=variant_name,
        condition=condition,
    )
    item_kind = "slab" if any(str(value or "").strip() for value in (grader, grade, cert_number)) else "raw"
    normalized_quantity = max(1, int(quantity))
    cost_basis_total = 0.0 if unit_price is None else round(float(unit_price) * normalized_quantity, 2)
    existing_row = connection.execute(
        """
        SELECT id
        FROM deck_entries
        WHERE owner_user_id = ?
          AND identity_key = ?
        LIMIT 1
        """,
        (normalized_owner_user_id, identity_key),
    ).fetchone()
    deck_entry_id = str(existing_row["id"] or "").strip() if existing_row is not None else f"deckentry:{uuid.uuid4().hex}"
    if existing_row is None:
        connection.execute(
            """
            INSERT INTO deck_entries (
                id, owner_user_id, identity_key, item_kind, card_id, grader, grade, cert_number, variant_name,
                condition, quantity, cost_basis_total, cost_basis_currency_code,
                added_at, updated_at, source_scan_id, source_confirmation_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                deck_entry_id,
                normalized_owner_user_id,
                identity_key,
                item_kind,
                card_id,
                grader,
                grade,
                cert_number,
                variant_name,
                str(condition or "").strip() or None,
                normalized_quantity,
                cost_basis_total,
                str(currency_code or "").strip() or None,
                added_at or utc_now(),
                updated_at or utc_now(),
                source_scan_id,
                source_confirmation_id,
            ),
        )
    else:
        connection.execute(
            """
            UPDATE deck_entries
            SET card_id = ?,
                grader = ?,
                grade = ?,
                cert_number = ?,
                variant_name = ?,
                condition = COALESCE(?, condition),
                quantity = quantity + ?,
                cost_basis_total = round(COALESCE(cost_basis_total, 0) + ?, 2),
                cost_basis_currency_code = COALESCE(?, cost_basis_currency_code),
                updated_at = ?,
                source_scan_id = COALESCE(?, source_scan_id),
                source_confirmation_id = COALESCE(?, source_confirmation_id)
            WHERE id = ?
              AND owner_user_id = ?
            """,
            (
                card_id,
                grader,
                grade,
                cert_number,
                variant_name,
                str(condition or "").strip() or None,
                normalized_quantity,
                cost_basis_total,
                str(currency_code or "").strip() or None,
                updated_at or utc_now(),
                source_scan_id,
                source_confirmation_id,
                deck_entry_id,
                normalized_owner_user_id,
            ),
        )
    append_deck_entry_event(
        connection,
        owner_user_id=normalized_owner_user_id,
        deck_entry_id=deck_entry_id,
        card_id=str(card_id or "").strip(),
        event_kind=event_kind,
        quantity_delta=normalized_quantity,
        unit_price=unit_price,
        total_price=cost_basis_total if cost_basis_total > 0 else None,
        currency_code=currency_code,
        payment_method=payment_method,
        condition=str(condition or "").strip() or None,
        grader=grader,
        grade=grade,
        cert_number=cert_number,
        variant_name=variant_name,
        source_scan_id=source_scan_id,
        source_confirmation_id=source_confirmation_id,
        created_at=added_at or utc_now(),
    )
    return deck_entry_id


def upsert_scan_confirmation(
    connection: sqlite3.Connection,
    *,
    scan_id: str,
    owner_user_id: str | None = None,
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
            id, scan_id, owner_user_id, confirmed_card_id, confirmation_source,
            selected_rank, was_top_prediction, deck_entry_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            owner_user_id=COALESCE(excluded.owner_user_id, scan_confirmations.owner_user_id),
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
            owner_user_id,
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


def _raw_local_number_query_parts(evidence: RawEvidence) -> tuple[str, ...]:
    parts: list[str] = []
    seen: set[str] = set()
    for value in (
        evidence.collector_number_exact,
        evidence.collector_number_partial,
        *(evidence.collector_number_query_values or ()),
    ):
        cleaned = str(value or "").strip()
        normalized = canonicalize_collector_number(cleaned)
        if not cleaned or not normalized or normalized in seen:
            continue
        seen.add(normalized)
        parts.append(cleaned)
    return tuple(parts)


def _raw_local_shortlist_query(*parts: object) -> str:
    query_parts: list[str] = []
    seen: set[str] = set()
    for part in parts:
        cleaned = str(part or "").strip()
        normalized = cleaned.lower()
        if not cleaned or normalized in seen:
            continue
        seen.add(normalized)
        query_parts.append(cleaned)
    return " ".join(query_parts)


def _raw_local_shortlisted_cards(
    connection: sqlite3.Connection,
    *,
    query: str,
    limit: int,
) -> list[dict[str, Any]]:
    normalized_query = str(query or "").strip()
    if not normalized_query:
        return []
    shortlist_limit = min(max(int(limit) * 6, 48), 120)
    return search_cards(connection, normalized_query, limit=shortlist_limit)


def search_cards_local_title_set(connection: sqlite3.Connection, evidence: RawEvidence, limit: int = 12) -> list[dict[str, Any]]:
    scored = []
    set_tokens = evidence.trusted_set_hint_tokens or evidence.set_hint_tokens
    shortlist = _raw_local_shortlisted_cards(
        connection,
        query=_raw_local_shortlist_query(
            evidence.title_text_primary,
            evidence.title_text_secondary,
            *set_tokens,
        ),
        limit=limit,
    )
    for card in shortlist:
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
    shortlist = _raw_local_shortlisted_cards(
        connection,
        query=_raw_local_shortlist_query(
            evidence.title_text_primary,
            evidence.title_text_secondary,
        ),
        limit=limit,
    )
    for card in shortlist:
        title_score = _title_overlap(card, evidence)
        if title_score <= 0:
            continue
        score = title_score * 75.0
        scored.append((score, _candidate_from_card(card, RAW_ROUTE_TITLE_ONLY, score)))
    scored.sort(key=lambda item: (-item[0], item[1]["name"], item[1]["number"]))
    return [candidate for _, candidate in scored[:limit]]


def search_cards_local_collector_set(connection: sqlite3.Connection, evidence: RawEvidence, limit: int = 12) -> list[dict[str, Any]]:
    scored = []
    set_tokens = evidence.trusted_set_hint_tokens or evidence.set_hint_tokens
    shortlist = _raw_local_shortlisted_cards(
        connection,
        query=_raw_local_shortlist_query(
            *_raw_local_number_query_parts(evidence),
            *set_tokens,
        ),
        limit=limit,
    )
    for card in shortlist:
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
    shortlist = _raw_local_shortlisted_cards(
        connection,
        query=_raw_local_shortlist_query(*_raw_local_number_query_parts(evidence)),
        limit=limit,
    )
    for card in shortlist:
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


def _local_ocr_rescue_visual_score_cap(
    candidate: dict[str, Any],
    breakdown: RawCandidateScoreBreakdown,
    signals: RawSignalScores,
) -> float | None:
    if str(candidate.get("_visualSimilaritySource") or "") != "local_ocr_rescue":
        return None
    if signals.title_signal < 35:
        return None
    if breakdown.title_overlap_score > 0.0 or breakdown.set_overlap_score > 0.0:
        return None
    if breakdown.collector_exact_score > 0.0 and breakdown.footer_text_support_score <= 0.0:
        return 55.0
    if breakdown.collector_partial_score > 0.0:
        return 45.0
    return None


def _language_mismatch_visual_score_cap(
    candidate: dict[str, Any],
    breakdown: RawCandidateScoreBreakdown,
    evidence: RawEvidence,
) -> float | None:
    if not _raw_evidence_looks_japanese(evidence):
        return None
    if _candidate_looks_japanese(candidate):
        return None
    if any(
        [
            breakdown.title_overlap_score > 0.0,
            breakdown.set_overlap_score > 0.0,
            breakdown.collector_exact_score > 0.0,
            breakdown.collector_partial_score > 0.0,
            breakdown.footer_text_support_score > 0.0,
        ]
    ):
        return None
    return 45.0


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
        local_rescue_visual_cap = _local_ocr_rescue_visual_score_cap(candidate, breakdown, signals)
        if local_rescue_visual_cap is not None:
            visual_score = min(visual_score, local_rescue_visual_cap)
        language_mismatch_visual_cap = _language_mismatch_visual_score_cap(candidate, breakdown, evidence)
        if language_mismatch_visual_cap is not None:
            visual_score = min(visual_score, language_mismatch_visual_cap)
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
        if local_rescue_visual_cap is not None:
            reason_tokens.append("local_ocr_rescue_dampened")
        if language_mismatch_visual_cap is not None:
            reason_tokens.append("language_mismatch_dampened")
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
    # An explicit raw hint from the client (scanner "Scanning for" → Ungraded) is
    # authoritative. Trust it and skip the OCR-evidence promotion below, so a
    # stray slab token in OCR can't bounce a user-chosen raw scan into the slab
    # lane. The OCR fallback remains for older clients that send no hint.
    if hint in {"raw_card", "raw", "card"}:
        return "raw_card"
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
