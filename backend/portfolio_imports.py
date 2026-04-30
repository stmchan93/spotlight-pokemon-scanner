from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from typing import Any

from catalog_tools import (
    canonicalize_collector_number,
    card_by_id,
    cards_by_ids,
    search_cards,
    tokenize,
    upsert_deck_entry,
    utc_now,
)
from import_source_adapters import parse_import_csv


DEFAULT_IMPORT_PAGE_LIMIT = 50
MAX_IMPORT_PAGE_LIMIT = 250
MAX_IMPORT_ROW_COUNT = 5000

_MATCH_STATUSES = {
    "matched",
    "ambiguous",
    "unresolved",
    "unsupported",
    "skipped",
}
_CONDITION_ALIASES = {
    "near_mint": "near_mint",
    "near mint": "near_mint",
    "nm": "near_mint",
    "lightly_played": "lightly_played",
    "lightly played": "lightly_played",
    "light played": "lightly_played",
    "lp": "lightly_played",
    "moderately_played": "moderately_played",
    "moderately played": "moderately_played",
    "moderate played": "moderately_played",
    "mp": "moderately_played",
    "heavily_played": "heavily_played",
    "heavily played": "heavily_played",
    "heavy played": "heavily_played",
    "hp": "heavily_played",
    "damaged": "damaged",
    "dmg": "damaged",
    "dm": "damaged",
}


def preview_portfolio_import(
    connection: sqlite3.Connection,
    payload: dict[str, Any],
    *,
    owner_user_id: str,
) -> dict[str, Any]:
    source_type = str(payload.get("sourceType") or "").strip()
    file_name = str(payload.get("fileName") or "").strip() or None
    csv_text = str(payload.get("csvText") or "")
    safe_limit = _page_limit(payload.get("limit"))
    safe_offset = _page_offset(payload.get("offset"))

    parsed_file = parse_import_csv(source_type=source_type, csv_text=csv_text)
    if len(parsed_file.rows) > MAX_IMPORT_ROW_COUNT:
        raise ValueError(f"CSV row count exceeds the MVP limit of {MAX_IMPORT_ROW_COUNT}")

    job_id = f"pimport:{uuid.uuid4().hex}"
    now = utc_now()
    csv_sha256 = hashlib.sha256(csv_text.encode("utf-8")).hexdigest()

    try:
        connection.execute(
            """
            INSERT INTO portfolio_import_jobs (
                id, owner_user_id, source_type, status, source_file_name, source_sha256,
                row_count, matched_count, ambiguous_count, unresolved_count,
                unsupported_count, committed_count, skipped_count, summary_json,
                error_text, created_at, updated_at, committed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, NULL, ?, ?, NULL)
            """,
            (
                job_id,
                owner_user_id,
                source_type,
                "preview_building",
                file_name,
                csv_sha256,
                json.dumps(
                    {
                        "warnings": parsed_file.warnings,
                        "headers": parsed_file.headers,
                    }
                ),
                now,
                now,
            ),
        )

        for parsed_row in parsed_file.rows:
            classification = _classify_import_row(connection, parsed_row.normalized_row)
            _insert_import_row(
                connection,
                job_id=job_id,
                raw_row=parsed_row.raw_row,
                normalized_row=parsed_row.normalized_row,
                classification=classification,
                created_at=now,
            )

        _refresh_job_counts(connection, job_id, status="preview_ready", error_text=None)
        connection.commit()
    except Exception:
        connection.rollback()
        raise

    return get_portfolio_import_job(
        connection,
        job_id,
        owner_user_id=owner_user_id,
        status_filter=None,
        limit=safe_limit,
        offset=safe_offset,
    )


def get_portfolio_import_job(
    connection: sqlite3.Connection,
    job_id: str,
    *,
    owner_user_id: str,
    status_filter: str | None,
    limit: int | None = None,
    offset: int | None = None,
) -> dict[str, Any]:
    job_row = _job_row(connection, job_id, owner_user_id=owner_user_id)
    if job_row is None:
        raise FileNotFoundError("import job not found")

    safe_limit = _page_limit(limit)
    safe_offset = _page_offset(offset)
    filter_clause, filter_params = _row_filter_clause(status_filter)

    count_row = connection.execute(
        f"""
        SELECT COUNT(*) AS count
        FROM portfolio_import_rows
        WHERE job_id = ?
        {filter_clause}
        """,
        (job_id, *filter_params),
    ).fetchone()
    filtered_count = int((count_row["count"] if count_row is not None else 0) or 0)

    rows = connection.execute(
        f"""
        SELECT *
        FROM portfolio_import_rows
        WHERE job_id = ?
        {filter_clause}
        ORDER BY row_index ASC, id ASC
        LIMIT ? OFFSET ?
        """,
        (job_id, *filter_params, safe_limit, safe_offset),
    ).fetchall()
    ready_count = _ready_row_count(connection, job_id)
    summary_json = _json_load(job_row["summary_json"], {})
    cards_map = _row_cards_map(connection, rows)

    return {
        "id": job_row["id"],
        "jobID": job_row["id"],
        "sourceType": job_row["source_type"],
        "status": job_row["status"],
        "sourceFileName": job_row["source_file_name"],
        "fileName": job_row["source_file_name"],
        "summary": {
            "totalRowCount": int(job_row["row_count"] or 0),
            "rowCount": int(job_row["row_count"] or 0),
            "matchedCount": int(job_row["matched_count"] or 0),
            "reviewCount": int(job_row["ambiguous_count"] or 0),
            "ambiguousCount": int(job_row["ambiguous_count"] or 0),
            "unresolvedCount": int(job_row["unresolved_count"] or 0),
            "unsupportedCount": int(job_row["unsupported_count"] or 0),
            "skippedCount": int(job_row["skipped_count"] or 0),
            "committedCount": int(job_row["committed_count"] or 0),
            "readyToCommitCount": ready_count,
            "readyCount": ready_count,
        },
        "warnings": list(summary_json.get("warnings") or []),
        "headers": list(summary_json.get("headers") or []),
        "rows": [_serialize_import_row(row, cards_map) for row in rows],
        "filter": status_filter or "all",
        "filteredCount": filtered_count,
        "limit": safe_limit,
        "offset": safe_offset,
        "createdAt": job_row["created_at"],
        "updatedAt": job_row["updated_at"],
        "committedAt": job_row["committed_at"],
        "errorText": job_row["error_text"],
    }


def resolve_portfolio_import(
    connection: sqlite3.Connection,
    job_id: str,
    payload: dict[str, Any],
    *,
    owner_user_id: str,
) -> dict[str, Any]:
    if _job_row(connection, job_id, owner_user_id=owner_user_id) is None:
        raise FileNotFoundError("import job not found")

    raw_updates = payload.get("rows")
    if isinstance(raw_updates, list):
        updates = raw_updates
    else:
        updates = [payload]
    if not updates:
        raise ValueError("at least one row update is required")

    updated_row_ids: list[str] = []
    try:
        for raw_update in updates:
            if not isinstance(raw_update, dict):
                raise ValueError("each resolve row update must be an object")
            row = _find_job_row(connection, job_id, raw_update, owner_user_id=owner_user_id)
            if row is None:
                raise FileNotFoundError("import row not found")
            if str(row["commit_result_json"] or "").strip():
                raise ValueError("cannot resolve a committed row")

            normalized_row = _json_load(row["normalized_row_json"], {})
            _apply_row_overrides(normalized_row, raw_update)

            action = str(raw_update.get("action") or "").strip().lower()
            if action == "skip":
                raw_update = {**raw_update, "skip": True}
            elif action == "match" and raw_update.get("matchedCardID") is not None and raw_update.get("cardID") is None:
                raw_update = {**raw_update, "cardID": raw_update.get("matchedCardID")}

            if bool(raw_update.get("skip") is True):
                classification = {
                    "match_status": "skipped",
                    "matched_card_id": None,
                    "match_strategy": "manual_skip",
                    "candidate_card_ids": [],
                    "commit_action": None,
                    "error_text": None,
                }
            elif str(raw_update.get("cardID") or "").strip():
                selected_card_id = str(raw_update.get("cardID") or "").strip()
                selected_card = card_by_id(connection, selected_card_id)
                if selected_card is None or not _is_physical_card(selected_card):
                    raise ValueError("cardID is invalid")
                classification = {
                    "match_status": "matched",
                    "matched_card_id": selected_card_id,
                    "match_strategy": "manual_resolve",
                    "candidate_card_ids": [selected_card_id],
                    "commit_action": _commit_action_for_normalized_row(
                        {
                            "match_status": "matched",
                            "matched_card_id": selected_card_id,
                            "quantity": normalized_row.get("quantity"),
                            "acquisitionUnitPrice": normalized_row.get("acquisitionUnitPrice"),
                            "acquisitionTotalPrice": normalized_row.get("acquisitionTotalPrice"),
                        }
                    ),
                    "error_text": None,
                }
            else:
                classification = _classify_import_row(connection, normalized_row)

            _update_import_row(
                connection,
                row_id=str(row["id"]),
                normalized_row=normalized_row,
                classification=classification,
            )
            updated_row_ids.append(str(row["id"]))

        _refresh_job_counts(connection, job_id, status="preview_ready", error_text=None)
        connection.commit()
    except Exception:
        connection.rollback()
        raise

    updated_rows = _rows_by_ids(connection, updated_row_ids)
    cards_map = _row_cards_map(connection, updated_rows)
    summary_payload = get_portfolio_import_job(
        connection,
        job_id,
        owner_user_id=owner_user_id,
        status_filter=None,
        limit=DEFAULT_IMPORT_PAGE_LIMIT,
        offset=0,
    )
    summary_payload["updatedRows"] = [_serialize_import_row(row, cards_map) for row in updated_rows]
    return summary_payload


def commit_portfolio_import(
    connection: sqlite3.Connection,
    job_id: str,
    *,
    owner_user_id: str,
) -> dict[str, Any]:
    job = _job_row(connection, job_id, owner_user_id=owner_user_id)
    if job is None:
        raise FileNotFoundError("import job not found")

    ready_rows = connection.execute(
        """
        SELECT *
        FROM portfolio_import_rows
        WHERE job_id = ?
          AND match_status = 'matched'
          AND matched_card_id IS NOT NULL
          AND commit_result_json IS NULL
        ORDER BY row_index ASC, id ASC
        """,
        (job_id,),
    ).fetchall()

    committed_rows: list[dict[str, Any]] = []
    failed_rows: list[dict[str, Any]] = []

    try:
        for index, row in enumerate(ready_rows, start=1):
            savepoint_name = f"portfolio_import_row_{index}"
            connection.execute(f"SAVEPOINT {savepoint_name}")
            try:
                commit_result = _commit_ready_row(connection, row, owner_user_id=owner_user_id)
                connection.execute(f"RELEASE SAVEPOINT {savepoint_name}")
                committed_rows.append(commit_result)
            except Exception as error:
                connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint_name}")
                connection.execute(f"RELEASE SAVEPOINT {savepoint_name}")
                error_text = str(error)
                connection.execute(
                    """
                    UPDATE portfolio_import_rows
                    SET error_text = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (error_text, utc_now(), str(row["id"])),
                )
                failed_rows.append(
                    {
                        "rowID": row["id"],
                        "rowIndex": int(row["row_index"] or 0),
                        "errorText": error_text,
                    }
                )

        committed_at = utc_now() if committed_rows else None
        _refresh_job_counts(
            connection,
            job_id,
            status="commit_partial" if failed_rows else "committed",
            error_text=None,
            committed_at=committed_at,
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise

    summary_payload = get_portfolio_import_job(
        connection,
        job_id,
        owner_user_id=owner_user_id,
        status_filter=None,
        limit=DEFAULT_IMPORT_PAGE_LIMIT,
        offset=0,
    )
    committed_count = int(summary_payload["summary"].get("committedCount") or 0)
    return {
        "jobID": job_id,
        "status": summary_payload["status"],
        "summary": summary_payload["summary"],
        "job": summary_payload,
        "message": f"Imported {committed_count} row{'s' if committed_count != 1 else ''}.",
        "committedRows": committed_rows,
        "failedRows": failed_rows,
        "refreshedAt": utc_now(),
    }


def _insert_import_row(
    connection: sqlite3.Connection,
    *,
    job_id: str,
    raw_row: dict[str, Any],
    normalized_row: dict[str, Any],
    classification: dict[str, Any],
    created_at: str,
) -> None:
    connection.execute(
        """
        INSERT INTO portfolio_import_rows (
            id, job_id, row_index, source_collection_name, raw_row_json,
            normalized_row_json, match_status, matched_card_id, match_strategy,
            candidate_card_ids_json, quantity, condition, variant_name,
            currency_code, acquisition_unit_price, acquisition_total_price,
            market_unit_price, commit_action, commit_result_json, error_text,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        """,
        (
            f"pirow:{uuid.uuid4().hex}",
            job_id,
            int(normalized_row.get("sourceRowIndex") or 0),
            normalized_row.get("sourceCollectionName"),
            json.dumps(raw_row or {}),
            json.dumps(normalized_row or {}),
            classification["match_status"],
            classification.get("matched_card_id"),
            classification.get("match_strategy"),
            json.dumps(classification.get("candidate_card_ids") or []),
            normalized_row.get("quantity"),
            normalized_row.get("condition"),
            normalized_row.get("variant"),
            normalized_row.get("currencyCode"),
            normalized_row.get("acquisitionUnitPrice"),
            normalized_row.get("acquisitionTotalPrice"),
            normalized_row.get("marketUnitPrice"),
            classification.get("commit_action"),
            classification.get("error_text"),
            created_at,
            created_at,
        ),
    )


def _update_import_row(
    connection: sqlite3.Connection,
    *,
    row_id: str,
    normalized_row: dict[str, Any],
    classification: dict[str, Any],
) -> None:
    connection.execute(
        """
        UPDATE portfolio_import_rows
        SET normalized_row_json = ?,
            match_status = ?,
            matched_card_id = ?,
            match_strategy = ?,
            candidate_card_ids_json = ?,
            quantity = ?,
            condition = ?,
            variant_name = ?,
            currency_code = ?,
            acquisition_unit_price = ?,
            acquisition_total_price = ?,
            market_unit_price = ?,
            commit_action = ?,
            error_text = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (
            json.dumps(normalized_row or {}),
            classification["match_status"],
            classification.get("matched_card_id"),
            classification.get("match_strategy"),
            json.dumps(classification.get("candidate_card_ids") or []),
            normalized_row.get("quantity"),
            normalized_row.get("condition"),
            normalized_row.get("variant"),
            normalized_row.get("currencyCode"),
            normalized_row.get("acquisitionUnitPrice"),
            normalized_row.get("acquisitionTotalPrice"),
            normalized_row.get("marketUnitPrice"),
            classification.get("commit_action"),
            classification.get("error_text"),
            utc_now(),
            row_id,
        ),
    )


def _classify_import_row(connection: sqlite3.Connection, normalized_row: dict[str, Any]) -> dict[str, Any]:
    quantity = normalized_row.get("quantity")
    acquisition_unit_price = normalized_row.get("acquisitionUnitPrice")
    acquisition_total_price = normalized_row.get("acquisitionTotalPrice")

    if not _row_has_identity(normalized_row):
        return {
            "match_status": "skipped",
            "matched_card_id": None,
            "match_strategy": "empty_identity",
            "candidate_card_ids": [],
            "commit_action": None,
            "error_text": "row is missing card identity fields",
        }

    if quantity is None or int(quantity) < 1:
        return {
            "match_status": "skipped",
            "matched_card_id": None,
            "match_strategy": "invalid_quantity",
            "candidate_card_ids": [],
            "commit_action": None,
            "error_text": "quantity must be at least 1",
        }

    if _is_negative_number(acquisition_unit_price) or _is_negative_number(acquisition_total_price):
        return {
            "match_status": "skipped",
            "matched_card_id": None,
            "match_strategy": "invalid_acquisition_price",
            "candidate_card_ids": [],
            "commit_action": None,
            "error_text": "acquisition price must be non-negative",
        }

    if _looks_slab_like(normalized_row):
        return {
            "match_status": "unsupported",
            "matched_card_id": None,
            "match_strategy": "slab_like_row",
            "candidate_card_ids": [],
            "commit_action": None,
            "error_text": "slab-like rows are unsupported in this MVP",
        }

    internal_card_id = str(normalized_row.get("internalCardID") or "").strip()
    if internal_card_id:
        card = card_by_id(connection, internal_card_id)
        if card is not None and _is_physical_card(card):
            return _matched_classification(
                matched_card_id=internal_card_id,
                match_strategy="exact_internal_card_id",
                normalized_row=normalized_row,
            )

    external_match = _external_ref_match(connection, normalized_row)
    if external_match is not None:
        return _matched_classification(
            matched_card_id=external_match["card_id"],
            match_strategy=external_match["match_strategy"],
            normalized_row=normalized_row,
        )

    exact_candidate_ids = _exact_structured_candidates(connection, normalized_row)
    if len(exact_candidate_ids) == 1:
        return _matched_classification(
            matched_card_id=exact_candidate_ids[0],
            match_strategy="exact_structured",
            normalized_row=normalized_row,
        )
    if len(exact_candidate_ids) > 1:
        return {
            "match_status": "ambiguous",
            "matched_card_id": None,
            "match_strategy": "exact_structured_multi",
            "candidate_card_ids": exact_candidate_ids[:10],
            "commit_action": None,
            "error_text": "multiple exact local matches require review",
        }

    shortlist_ids = _shortlist_candidate_ids(connection, normalized_row)
    if shortlist_ids:
        return {
            "match_status": "ambiguous",
            "matched_card_id": None,
            "match_strategy": "local_shortlist",
            "candidate_card_ids": shortlist_ids[:10],
            "commit_action": None,
            "error_text": "review required before committing this row",
        }

    return {
        "match_status": "unresolved",
        "matched_card_id": None,
        "match_strategy": "no_local_match",
        "candidate_card_ids": [],
        "commit_action": None,
        "error_text": "no local catalog match found",
    }


def _matched_classification(
    *,
    matched_card_id: str,
    match_strategy: str,
    normalized_row: dict[str, Any],
) -> dict[str, Any]:
    return {
        "match_status": "matched",
        "matched_card_id": matched_card_id,
        "match_strategy": match_strategy,
        "candidate_card_ids": [matched_card_id],
        "commit_action": _commit_action_for_normalized_row(
            {
                "match_status": "matched",
                "matched_card_id": matched_card_id,
                "quantity": normalized_row.get("quantity"),
                "acquisitionUnitPrice": normalized_row.get("acquisitionUnitPrice"),
                "acquisitionTotalPrice": normalized_row.get("acquisitionTotalPrice"),
            }
        ),
        "error_text": None,
    }


def _commit_action_for_normalized_row(row_like: dict[str, Any]) -> str | None:
    if str(row_like.get("match_status") or "") != "matched":
        return None
    if not str(row_like.get("matched_card_id") or "").strip():
        return None
    if row_like.get("acquisitionUnitPrice") is not None or row_like.get("acquisitionTotalPrice") is not None:
        return "import_buy"
    return "import_seed"


def _external_ref_match(connection: sqlite3.Connection, normalized_row: dict[str, Any]) -> dict[str, str] | None:
    external_ids = normalized_row.get("externalIDs")
    if not isinstance(external_ids, dict):
        return None

    provider_checks: list[tuple[str, str, str]] = []
    tcgplayer_product_id = str(external_ids.get("tcgplayerProductID") or "").strip()
    if tcgplayer_product_id:
        provider_checks.append(("tcgplayer", tcgplayer_product_id, "external_ref:tcgplayer"))
    collectr_record_id = str(external_ids.get("collectrRecordID") or "").strip()
    if collectr_record_id:
        provider_checks.append(("collectr", collectr_record_id, "external_ref:collectr"))

    for provider, external_id, match_strategy in provider_checks:
        row = connection.execute(
            """
            SELECT card_id
            FROM card_external_refs
            WHERE provider = ? AND external_id = ?
            LIMIT 1
            """,
            (provider, external_id),
        ).fetchone()
        if row is None:
            continue
        card_id = str(row["card_id"] or "").strip()
        if not card_id:
            continue
        card = card_by_id(connection, card_id)
        if card is None or not _is_physical_card(card):
            continue
        return {
            "card_id": card_id,
            "match_strategy": match_strategy,
        }
    return None


def _exact_structured_candidates(connection: sqlite3.Connection, normalized_row: dict[str, Any]) -> list[str]:
    shortlist = _shortlist_cards(connection, normalized_row, limit=12)
    return [
        str(candidate["id"])
        for candidate in shortlist
        if _candidate_exact_match(candidate, normalized_row)
    ]


def _shortlist_candidate_ids(connection: sqlite3.Connection, normalized_row: dict[str, Any]) -> list[str]:
    shortlist = _shortlist_cards(connection, normalized_row, limit=10)
    candidate_ids: list[str] = []
    seen: set[str] = set()
    for candidate in shortlist:
        card_id = str(candidate.get("id") or "").strip()
        if not card_id or card_id in seen or not _is_physical_card(candidate):
            continue
        seen.add(card_id)
        candidate_ids.append(card_id)
    return candidate_ids


def _shortlist_cards(connection: sqlite3.Connection, normalized_row: dict[str, Any], *, limit: int) -> list[dict[str, Any]]:
    query_parts: list[str] = []
    card_name = str(normalized_row.get("cardName") or "").strip()
    set_name = str(normalized_row.get("setName") or "").strip()
    collector_number = str(normalized_row.get("collectorNumber") or "").strip()

    if card_name:
        query_parts.append(card_name)
    if set_name:
        query_parts.append(f'set:"{set_name}"')
    if collector_number:
        query_parts.append(f"number:{collector_number}")

    search_query = " ".join(query_parts).strip()
    if not search_query:
        token_parts = [
            str(normalized_row.get("setName") or "").strip(),
            str(normalized_row.get("collectorNumber") or "").strip(),
        ]
        fallback = " ".join(part for part in token_parts if part)
        if not fallback:
            return []
        search_query = fallback

    return search_cards(connection, search_query, limit=limit)


def _candidate_exact_match(candidate: dict[str, Any], normalized_row: dict[str, Any]) -> bool:
    if not _is_physical_card(candidate):
        return False

    target_name = _normalized_identity_text(normalized_row.get("cardName"))
    if target_name:
        candidate_names = {
            _normalized_identity_text(candidate.get("name")),
            *{
                _normalized_identity_text(alias)
                for alias in list(candidate.get("titleAliases") or [])
            },
        }
        if target_name not in candidate_names:
            return False

    target_number = _normalized_collector_number(normalized_row.get("collectorNumber"))
    if target_number:
        candidate_number = _normalized_collector_number(candidate.get("number"))
        if candidate_number != target_number:
            return False

    target_set_name = _normalized_identity_text(normalized_row.get("setName"))
    target_set_code = _normalized_identity_text(normalized_row.get("setCode"))
    if target_set_name or target_set_code:
        candidate_values = {
            _normalized_identity_text(candidate.get("setName")),
            _normalized_identity_text(candidate.get("setID")),
            _normalized_identity_text(candidate.get("setPtcgoCode")),
        }
        if target_set_name and target_set_name not in candidate_values:
            return False
        if target_set_code and target_set_code not in candidate_values:
            return False

    target_language = str(normalized_row.get("language") or "").strip().lower()
    if target_language:
        candidate_language = str(candidate.get("language") or "").strip().lower()
        if candidate_language:
            mapped_candidate = {
                "english": "en",
                "japanese": "ja",
            }.get(candidate_language, candidate_language)
            if mapped_candidate != target_language:
                return False

    return True


def _commit_ready_row(
    connection: sqlite3.Connection,
    row: sqlite3.Row,
    *,
    owner_user_id: str,
) -> dict[str, Any]:
    matched_card_id = str(row["matched_card_id"] or "").strip()
    if not matched_card_id:
        raise ValueError("matched card is required")

    normalized_row = _json_load(row["normalized_row_json"], {})
    quantity = int(normalized_row.get("quantity") or row["quantity"] or 0)
    if quantity < 1:
        raise ValueError("quantity must be at least 1")

    acquisition_unit_price = normalized_row.get("acquisitionUnitPrice")
    acquisition_total_price = normalized_row.get("acquisitionTotalPrice")
    if acquisition_unit_price is None and acquisition_total_price not in {None, ""}:
        acquisition_unit_price = round(float(acquisition_total_price) / quantity, 2)
    elif acquisition_total_price is None and acquisition_unit_price not in {None, ""}:
        acquisition_total_price = round(float(acquisition_unit_price) * quantity, 2)

    event_kind = "import_buy" if acquisition_unit_price is not None or acquisition_total_price is not None else "import_seed"
    currency_code = str(normalized_row.get("currencyCode") or row["currency_code"] or "").strip() or None
    if event_kind == "import_seed":
        currency_code = None
    deck_entry_id = upsert_deck_entry(
        connection,
        owner_user_id=owner_user_id,
        card_id=matched_card_id,
        condition=_normalized_condition(normalized_row.get("condition")),
        quantity=quantity,
        unit_price=float(acquisition_unit_price) if acquisition_unit_price is not None else None,
        currency_code=currency_code,
        added_at=utc_now(),
        updated_at=utc_now(),
        event_kind=event_kind,
    )
    commit_payload = {
        "deckEntryID": deck_entry_id,
        "cardID": matched_card_id,
        "eventKind": event_kind,
        "quantity": quantity,
        "acquisitionUnitPrice": acquisition_unit_price,
        "acquisitionTotalPrice": acquisition_total_price,
    }
    connection.execute(
        """
        UPDATE portfolio_import_rows
        SET commit_result_json = ?, error_text = NULL, updated_at = ?
        WHERE id = ?
        """,
        (json.dumps(commit_payload), utc_now(), str(row["id"])),
    )
    return {
        "rowID": row["id"],
        "rowIndex": int(row["row_index"] or 0),
        "deckEntryID": deck_entry_id,
        "cardID": matched_card_id,
        "eventKind": event_kind,
        "quantity": quantity,
    }


def _row_has_identity(normalized_row: dict[str, Any]) -> bool:
    has_fields = any(
        str(normalized_row.get(key) or "").strip()
        for key in ("internalCardID", "cardName", "setName", "setCode", "collectorNumber")
    )
    if has_fields:
        return True
    external_ids = normalized_row.get("externalIDs")
    if not isinstance(external_ids, dict):
        return False
    return any(str(value or "").strip() for value in external_ids.values())


def _is_negative_number(value: Any) -> bool:
    try:
        return value is not None and float(value) < 0
    except (TypeError, ValueError):
        return False


def _normalized_identity_text(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    return "".join(character for character in text if character.isalnum())


def _normalized_collector_number(value: Any) -> str:
    normalized = canonicalize_collector_number(str(value or "").strip())
    return str(normalized or "").strip().lower()


def _normalized_condition(value: Any) -> str | None:
    cleaned = str(value or "").strip().lower()
    if not cleaned:
        return None
    return _CONDITION_ALIASES.get(cleaned)


def _is_physical_card(card: dict[str, Any]) -> bool:
    card_id = str(card.get("id") or "").strip().lower()
    source_record_id = str(card.get("sourceRecordID") or "").strip().lower()
    return not (card_id.startswith("tcgp-") or source_record_id.startswith("tcgp-"))


def _looks_slab_like(normalized_row: dict[str, Any]) -> bool:
    if any(str(normalized_row.get(key) or "").strip() for key in ("grader", "grade", "certNumber")):
        return True
    variant = str(normalized_row.get("variant") or "").strip().lower()
    if not variant:
        return False
    slab_tokens = ("graded", "slab", "psa", "bgs", "cgc", "sgc")
    return any(token in variant for token in slab_tokens)


def _ready_row_count(connection: sqlite3.Connection, job_id: str) -> int:
    row = connection.execute(
        """
        SELECT COUNT(*) AS count
        FROM portfolio_import_rows
        WHERE job_id = ?
          AND match_status = 'matched'
          AND matched_card_id IS NOT NULL
          AND commit_result_json IS NULL
        """,
        (job_id,),
    ).fetchone()
    return int((row["count"] if row is not None else 0) or 0)


def _row_filter_clause(status_filter: str | None) -> tuple[str, tuple[Any, ...]]:
    normalized_filter = str(status_filter or "").strip().lower()
    if not normalized_filter or normalized_filter == "all":
        return "", ()
    if normalized_filter == "ready_to_commit":
        return "AND match_status = 'matched' AND matched_card_id IS NOT NULL AND commit_result_json IS NULL", ()
    if normalized_filter == "committed":
        return "AND commit_result_json IS NOT NULL", ()
    if normalized_filter not in _MATCH_STATUSES:
        raise ValueError("filter is invalid")
    return "AND match_status = ?", (normalized_filter,)


def _job_row(
    connection: sqlite3.Connection,
    job_id: str,
    *,
    owner_user_id: str,
) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT *
        FROM portfolio_import_jobs
        WHERE id = ?
          AND owner_user_id = ?
        LIMIT 1
        """,
        (job_id, owner_user_id),
    ).fetchone()


def _refresh_job_counts(
    connection: sqlite3.Connection,
    job_id: str,
    *,
    status: str | None,
    error_text: str | None,
    committed_at: str | None = None,
) -> None:
    stats = connection.execute(
        """
        SELECT
            COUNT(*) AS row_count,
            SUM(CASE WHEN match_status = 'matched' THEN 1 ELSE 0 END) AS matched_count,
            SUM(CASE WHEN match_status = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous_count,
            SUM(CASE WHEN match_status = 'unresolved' THEN 1 ELSE 0 END) AS unresolved_count,
            SUM(CASE WHEN match_status = 'unsupported' THEN 1 ELSE 0 END) AS unsupported_count,
            SUM(CASE WHEN match_status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
            SUM(CASE WHEN commit_result_json IS NOT NULL THEN 1 ELSE 0 END) AS committed_count
        FROM portfolio_import_rows
        WHERE job_id = ?
        """,
        (job_id,),
    ).fetchone()
    connection.execute(
        """
        UPDATE portfolio_import_jobs
        SET status = COALESCE(?, status),
            row_count = ?,
            matched_count = ?,
            ambiguous_count = ?,
            unresolved_count = ?,
            unsupported_count = ?,
            committed_count = ?,
            skipped_count = ?,
            error_text = ?,
            updated_at = ?,
            committed_at = COALESCE(?, committed_at)
        WHERE id = ?
        """,
        (
            status,
            int(stats["row_count"] or 0),
            int(stats["matched_count"] or 0),
            int(stats["ambiguous_count"] or 0),
            int(stats["unresolved_count"] or 0),
            int(stats["unsupported_count"] or 0),
            int(stats["committed_count"] or 0),
            int(stats["skipped_count"] or 0),
            error_text,
            utc_now(),
            committed_at,
            job_id,
        ),
    )


def _row_cards_map(connection: sqlite3.Connection, rows: list[sqlite3.Row]) -> dict[str, dict[str, Any]]:
    card_ids: list[str] = []
    seen: set[str] = set()
    for row in rows:
        matched_card_id = str(row["matched_card_id"] or "").strip()
        if matched_card_id and matched_card_id not in seen:
            seen.add(matched_card_id)
            card_ids.append(matched_card_id)
        for candidate_card_id in _json_load(row["candidate_card_ids_json"], []):
            normalized_card_id = str(candidate_card_id or "").strip()
            if normalized_card_id and normalized_card_id not in seen:
                seen.add(normalized_card_id)
                card_ids.append(normalized_card_id)
    return cards_by_ids(connection, card_ids)


def _serialize_import_row(row: sqlite3.Row, cards_map: dict[str, dict[str, Any]]) -> dict[str, Any]:
    normalized_row = _json_load(row["normalized_row_json"], {})
    candidate_ids = [str(value or "").strip() for value in _json_load(row["candidate_card_ids_json"], []) if str(value or "").strip()]
    matched_card_id = str(row["matched_card_id"] or "").strip() or None
    commit_result = _json_load(row["commit_result_json"], None)
    warnings = [str(row["error_text"] or "").strip()] if str(row["error_text"] or "").strip() else []
    source_card_name = str(normalized_row.get("cardName") or "").strip()
    condition_label = _display_condition(row["condition"], normalized_row.get("sourceCondition"))
    return {
        "id": row["id"],
        "rowID": row["id"],
        "rowIndex": int(row["row_index"] or 0),
        "sourceCollectionName": row["source_collection_name"],
        "sourceCardName": source_card_name,
        "cardName": source_card_name,
        "setName": normalized_row.get("setName"),
        "collectorNumber": normalized_row.get("collectorNumber"),
        "matchStatus": row["match_status"],
        "matchState": row["match_status"],
        "matchStrategy": row["match_strategy"],
        "matchedCardID": matched_card_id,
        "matchedCard": _compact_card_payload(cards_map.get(matched_card_id)) if matched_card_id else None,
        "candidateCardIDs": candidate_ids,
        "candidateCards": [_compact_card_payload(cards_map.get(card_id)) for card_id in candidate_ids if cards_map.get(card_id) is not None],
        "quantity": row["quantity"],
        "conditionLabel": condition_label,
        "condition": row["condition"],
        "variantName": row["variant_name"],
        "currencyCode": row["currency_code"],
        "acquisitionUnitPrice": row["acquisition_unit_price"],
        "acquisitionTotalPrice": row["acquisition_total_price"],
        "marketUnitPrice": row["market_unit_price"],
        "commitAction": row["commit_action"],
        "readyToCommit": _row_is_ready_to_commit(row),
        "committed": bool(str(row["commit_result_json"] or "").strip()),
        "commitResult": commit_result,
        "warnings": warnings,
        "rawSummary": _row_raw_summary(normalized_row, condition_label),
        "normalizedRow": {
            key: value
            for key, value in normalized_row.items()
            if key not in {"grader", "grade", "certNumber"}
        },
        "errorText": row["error_text"],
        "updatedAt": row["updated_at"],
    }


def _compact_card_payload(card: dict[str, Any] | None) -> dict[str, Any] | None:
    if card is None:
        return None
    return {
        "id": card.get("id"),
        "name": card.get("name"),
        "setName": card.get("setName"),
        "number": card.get("number"),
        "rarity": card.get("rarity") or "",
        "variant": card.get("variant") or "Raw",
        "language": card.get("language") or "English",
        "imageSmallURL": card.get("imageSmallURL"),
        "imageLargeURL": card.get("imageURL"),
    }


def _row_is_ready_to_commit(row: sqlite3.Row) -> bool:
    return (
        str(row["match_status"] or "") == "matched"
        and str(row["matched_card_id"] or "").strip() != ""
        and str(row["commit_result_json"] or "").strip() == ""
    )


def _find_job_row(
    connection: sqlite3.Connection,
    job_id: str,
    payload: dict[str, Any],
    *,
    owner_user_id: str,
) -> sqlite3.Row | None:
    if _job_row(connection, job_id, owner_user_id=owner_user_id) is None:
        raise FileNotFoundError("import job not found")
    row_id = str(payload.get("rowID") or "").strip()
    if row_id:
        return connection.execute(
            """
            SELECT *
            FROM portfolio_import_rows
            WHERE job_id = ? AND id = ?
            LIMIT 1
            """,
            (job_id, row_id),
        ).fetchone()
    row_index_raw = payload.get("rowIndex")
    if row_index_raw is None:
        raise ValueError("rowID or rowIndex is required")
    try:
        row_index = int(row_index_raw)
    except (TypeError, ValueError):
        raise ValueError("rowIndex must be an integer") from None
    return connection.execute(
        """
        SELECT *
        FROM portfolio_import_rows
        WHERE job_id = ? AND row_index = ?
        LIMIT 1
        """,
        (job_id, row_index),
    ).fetchone()


def _apply_row_overrides(normalized_row: dict[str, Any], payload: dict[str, Any]) -> None:
    if "quantity" in payload:
        quantity_raw = payload.get("quantity")
        try:
            quantity = int(quantity_raw)
        except (TypeError, ValueError):
            raise ValueError("quantity must be an integer") from None
        if quantity < 1:
            raise ValueError("quantity must be at least 1")
        normalized_row["quantity"] = quantity

    if "condition" in payload:
        provided_condition = payload.get("condition")
        normalized_condition = _normalized_condition(provided_condition)
        if provided_condition not in (None, "") and normalized_condition is None:
            raise ValueError("condition is invalid")
        normalized_row["condition"] = normalized_condition

    if "acquisitionUnitPrice" in payload:
        acquisition_unit_price = payload.get("acquisitionUnitPrice")
        if acquisition_unit_price in (None, ""):
            normalized_row["acquisitionUnitPrice"] = None
        else:
            try:
                normalized_value = float(acquisition_unit_price)
            except (TypeError, ValueError):
                raise ValueError("acquisitionUnitPrice must be a number") from None
            if normalized_value < 0:
                raise ValueError("acquisitionUnitPrice must be non-negative")
            normalized_row["acquisitionUnitPrice"] = normalized_value


def _display_condition(condition: Any, source_condition: Any) -> str | None:
    raw_source_condition = str(source_condition or "").strip()
    if raw_source_condition:
        return raw_source_condition
    normalized = str(condition or "").strip().lower()
    if not normalized:
        return None
    return {
        "near_mint": "Near Mint",
        "lightly_played": "Lightly Played",
        "moderately_played": "Moderately Played",
        "heavily_played": "Heavily Played",
        "damaged": "Damaged",
    }.get(normalized, normalized.replace("_", " ").title())


def _row_raw_summary(normalized_row: dict[str, Any], condition_label: str | None) -> str | None:
    summary_parts = [
        str(normalized_row.get("setName") or "").strip() or None,
        str(normalized_row.get("collectorNumber") or "").strip() or None,
        condition_label,
    ]
    compact_parts = [part for part in summary_parts if part]
    if not compact_parts:
        return None
    return " • ".join(compact_parts)


def _rows_by_ids(connection: sqlite3.Connection, row_ids: list[str]) -> list[sqlite3.Row]:
    normalized_ids = [str(row_id or "").strip() for row_id in row_ids if str(row_id or "").strip()]
    if not normalized_ids:
        return []
    placeholders = ",".join("?" for _ in normalized_ids)
    rows = connection.execute(
        f"""
        SELECT *
        FROM portfolio_import_rows
        WHERE id IN ({placeholders})
        ORDER BY row_index ASC, id ASC
        """,
        tuple(normalized_ids),
    ).fetchall()
    row_order = {row_id: index for index, row_id in enumerate(normalized_ids)}
    return sorted(rows, key=lambda row: row_order.get(str(row["id"]), len(row_order)))


def _page_limit(value: Any) -> int:
    try:
        requested = int(value)
    except (TypeError, ValueError):
        requested = DEFAULT_IMPORT_PAGE_LIMIT
    return max(1, min(requested, MAX_IMPORT_PAGE_LIMIT))


def _page_offset(value: Any) -> int:
    try:
        requested = int(value)
    except (TypeError, ValueError):
        requested = 0
    return max(0, requested)


def _json_load(value: Any, default: Any) -> Any:
    if value in {None, ""}:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return default
