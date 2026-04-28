from __future__ import annotations

import json
import random
import socket
import sqlite3
import sys
import time
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError

from catalog_tools import (
    PROVIDER_SYNC_STATUS_FAILED,
    PROVIDER_SYNC_STATUS_SUCCEEDED,
    apply_schema,
    connect,
    start_provider_sync_run,
    update_provider_sync_run,
    upsert_catalog_card,
    utc_now,
)
from env_loader import load_backend_env_file
from scrydex_adapter import (
    SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
    SCRYDEX_PROVIDER,
    fetch_scrydex_cards_page,
    map_scrydex_catalog_card,
    persist_scrydex_daily_history_from_card_payload,
    persist_scrydex_raw_snapshot,
    scrydex_credentials,
)

load_backend_env_file(Path(__file__).resolve().parent / ".env")

SQLITE_LOCK_RETRY_DELAYS_SECONDS = (2.0, 5.0, 10.0)
SCRYDEX_CATALOG_PAGE_MAX_ATTEMPTS = 5
SCRYDEX_CATALOG_PAGE_RETRY_BASE_DELAY_SECONDS = 2.0
SCRYDEX_CATALOG_PAGE_RETRY_MAX_DELAY_SECONDS = 30.0
SCRYDEX_CATALOG_PAGE_RETRY_JITTER_SECONDS = 1.0
SCRYDEX_TRANSIENT_HTTP_STATUS_CODES = {408, 429, 500, 502, 503, 504}


def _parse_retry_after_seconds(value: str | None) -> float | None:
    normalized = str(value or "").strip()
    if not normalized:
        return None

    try:
        return max(0.0, float(normalized))
    except ValueError:
        pass

    try:
        retry_at = parsedate_to_datetime(normalized)
    except (TypeError, ValueError):
        return None
    if retry_at.tzinfo is None:
        return None
    return max(0.0, retry_at.timestamp() - time.time())


def _retry_after_from_error(exc: BaseException) -> float | None:
    if not isinstance(exc, HTTPError):
        return None
    headers = getattr(exc, "headers", None)
    if headers is None:
        return None
    return _parse_retry_after_seconds(headers.get("Retry-After"))


def _is_transient_scrydex_catalog_error(exc: BaseException) -> bool:
    if isinstance(exc, HTTPError):
        return int(exc.code) in SCRYDEX_TRANSIENT_HTTP_STATUS_CODES
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return True
    if isinstance(exc, URLError):
        reason = getattr(exc, "reason", None)
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return True
        message = str(exc).lower()
        return (
            "timed out" in message
            or "connection reset" in message
            or "temporarily unavailable" in message
        )

    message = str(exc).lower()
    return (
        "timed out" in message
        or "connection reset" in message
        or "temporarily unavailable" in message
    )


def _scrydex_catalog_page_retry_delay_seconds(attempt: int, exc: BaseException) -> float:
    retry_after = _retry_after_from_error(exc)
    if retry_after is not None:
        return retry_after

    exponential_delay = SCRYDEX_CATALOG_PAGE_RETRY_BASE_DELAY_SECONDS * (2 ** max(0, attempt - 1))
    delay = min(SCRYDEX_CATALOG_PAGE_RETRY_MAX_DELAY_SECONDS, exponential_delay)
    jitter = random.uniform(0.0, SCRYDEX_CATALOG_PAGE_RETRY_JITTER_SECONDS)
    return min(SCRYDEX_CATALOG_PAGE_RETRY_MAX_DELAY_SECONDS, delay + jitter)


def _fetch_scrydex_cards_page_with_retries(
    *,
    page: int,
    page_size: int,
    include_prices: bool,
    language: str | None,
    request_type: str,
) -> list[dict[str, Any]]:
    for attempt in range(1, SCRYDEX_CATALOG_PAGE_MAX_ATTEMPTS + 1):
        try:
            return fetch_scrydex_cards_page(
                page=page,
                page_size=page_size,
                include_prices=include_prices,
                language=language,
                request_type=request_type,
            )
        except Exception as exc:
            is_last_attempt = attempt >= SCRYDEX_CATALOG_PAGE_MAX_ATTEMPTS
            if is_last_attempt or not _is_transient_scrydex_catalog_error(exc):
                raise

            delay_seconds = _scrydex_catalog_page_retry_delay_seconds(attempt, exc)
            print(
                json.dumps(
                    {
                        "event": "scrydex_catalog_page_retry",
                        "page": page,
                        "attempt": attempt,
                        "nextAttempt": attempt + 1,
                        "delaySeconds": round(delay_seconds, 3),
                        "errorText": str(exc),
                    }
                ),
                file=sys.stderr,
            )
            time.sleep(delay_seconds)

    raise RuntimeError("unreachable")


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


def _is_sqlite_lock_error(exc: BaseException) -> bool:
    message = str(exc).lower()
    return "database is locked" in message or "database schema is locked" in message


def _sync_scrydex_catalog_once(
    *,
    database_path: Path,
    repo_root: Path,
    page_size: int = 100,
    language: str | None = None,
    max_pages: int | None = None,
    price_date: str | None = None,
    scheduled_for: str | None = None,
) -> dict[str, Any]:
    backend_root = Path(__file__).resolve().parent
    connection = connect(database_path, timeout_seconds=30.0, busy_timeout_ms=30_000)
    apply_schema(connection, backend_root / "schema.sql")

    credentials = scrydex_credentials()
    if credentials is None:
        connection.close()
        raise SystemExit("Scrydex credentials are not configured")

    normalized_language = str(language or "").strip().lower() or "all"
    normalized_price_date = str(price_date or "").strip() or None
    notes = {
        "language": normalized_language,
        "includePrices": True,
        "sameMachineCron": True,
    }
    if normalized_price_date:
        notes["priceDate"] = normalized_price_date
    run_id = start_provider_sync_run(
        connection,
        provider=SCRYDEX_PROVIDER,
        sync_scope=SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
        page_size=page_size,
        scheduled_for=scheduled_for,
        notes=notes,
    )
    connection.commit()

    totals = {
        "pagesFetched": 0,
        "cardsSeen": 0,
        "cardsUpserted": 0,
        "rawSnapshotsUpserted": 0,
        "gradedSnapshotsUpserted": 0,
    }
    request_type = f"catalog_sync_{normalized_language}"

    try:
        page = 1
        while True:
            cards = _fetch_scrydex_cards_page_with_retries(
                page=page,
                page_size=page_size,
                include_prices=True,
                language=None if normalized_language == "all" else normalized_language,
                request_type=request_type,
            )
            if not cards:
                break

            totals["pagesFetched"] += 1
            totals["cardsSeen"] += len(cards)

            imported_at = utc_now()
            for payload in cards:
                mapped_card = map_scrydex_catalog_card(payload)
                upsert_catalog_card(
                    connection,
                    mapped_card,
                    repo_root,
                    imported_at,
                    refresh_embeddings=False,
                )
                totals["cardsUpserted"] += 1
                counts = persist_scrydex_daily_history_from_card_payload(
                    connection,
                    card_id=str(mapped_card["id"]),
                    payload=payload,
                    price_date=normalized_price_date,
                    commit=False,
                )
                if persist_scrydex_raw_snapshot(connection, str(mapped_card["id"]), payload, commit=False) is not None:
                    totals["rawSnapshotsUpserted"] += 1
                if counts.get("gradedCount"):
                    totals["gradedSnapshotsUpserted"] += 1

            connection.commit()
            update_provider_sync_run(
                connection,
                run_id,
                pages_fetched=totals["pagesFetched"],
                cards_seen=totals["cardsSeen"],
                cards_upserted=totals["cardsUpserted"],
                raw_snapshots_upserted=totals["rawSnapshotsUpserted"],
                graded_snapshots_upserted=totals["gradedSnapshotsUpserted"],
                estimated_credits_used=totals["pagesFetched"],
            )
            connection.commit()

            if len(cards) < page_size:
                break
            if max_pages is not None and totals["pagesFetched"] >= max_pages:
                break
            page += 1

        completed_at = utc_now()
        update_provider_sync_run(
            connection,
            run_id,
            status=PROVIDER_SYNC_STATUS_SUCCEEDED,
            completed_at=completed_at,
            pages_fetched=totals["pagesFetched"],
            cards_seen=totals["cardsSeen"],
            cards_upserted=totals["cardsUpserted"],
            raw_snapshots_upserted=totals["rawSnapshotsUpserted"],
            graded_snapshots_upserted=totals["gradedSnapshotsUpserted"],
            estimated_credits_used=totals["pagesFetched"],
        )
        connection.commit()
        return {
            "runID": run_id,
            "provider": SCRYDEX_PROVIDER,
            "syncScope": SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
            "language": normalized_language,
            "priceDate": normalized_price_date,
            "pageSize": page_size,
            **totals,
            "estimatedCreditsUsed": totals["pagesFetched"],
            "completedAt": completed_at,
            "databasePath": str(database_path),
        }
    except Exception as exc:
        connection.rollback()
        update_provider_sync_run(
            connection,
            run_id,
            status=PROVIDER_SYNC_STATUS_FAILED,
            completed_at=utc_now(),
            pages_fetched=totals["pagesFetched"],
            cards_seen=totals["cardsSeen"],
            cards_upserted=totals["cardsUpserted"],
            raw_snapshots_upserted=totals["rawSnapshotsUpserted"],
            graded_snapshots_upserted=totals["gradedSnapshotsUpserted"],
            estimated_credits_used=totals["pagesFetched"],
            error_text=str(exc),
        )
        connection.commit()
        raise
    finally:
        connection.close()


def sync_scrydex_catalog(
    *,
    database_path: Path,
    repo_root: Path,
    page_size: int = 100,
    language: str | None = None,
    max_pages: int | None = None,
    price_date: str | None = None,
    scheduled_for: str | None = None,
) -> dict[str, Any]:
    for attempt, delay_seconds in enumerate((0.0, *SQLITE_LOCK_RETRY_DELAYS_SECONDS), start=1):
        if delay_seconds > 0:
            print(
                json.dumps(
                    {
                        "event": "scrydex_sync_retry_wait",
                        "attempt": attempt,
                        "delaySeconds": delay_seconds,
                        "reason": "sqlite_lock",
                        "databasePath": str(database_path),
                    }
                ),
                file=sys.stderr,
            )
            time.sleep(delay_seconds)

        try:
            return _sync_scrydex_catalog_once(
                database_path=database_path,
                repo_root=repo_root,
                page_size=page_size,
                language=language,
                max_pages=max_pages,
                price_date=price_date,
                scheduled_for=scheduled_for,
            )
        except sqlite3.OperationalError as exc:
            if not _is_sqlite_lock_error(exc) or attempt > len(SQLITE_LOCK_RETRY_DELAYS_SECONDS):
                raise
            print(
                json.dumps(
                    {
                        "event": "scrydex_sync_retry",
                        "attempt": attempt,
                        "reason": "sqlite_lock",
                        "errorText": str(exc),
                        "databasePath": str(database_path),
                    }
                ),
                file=sys.stderr,
            )

    raise RuntimeError("unreachable")


def main() -> None:
    backend_root = Path(__file__).resolve().parent
    repo_root = backend_root.parent
    database_path = Path(
        cli_value("--database-path")
        or str((backend_root / "data" / "spotlight_scanner.sqlite").resolve())
    )
    page_size = cli_int_value("--page-size", 100)
    max_pages_value = cli_value("--max-pages")
    max_pages = int(max_pages_value) if max_pages_value is not None else None
    language = cli_value("--language")
    price_date = cli_value("--price-date")
    scheduled_for = cli_value("--scheduled-for")
    summary = sync_scrydex_catalog(
        database_path=database_path,
        repo_root=repo_root,
        page_size=page_size,
        language=language,
        max_pages=max_pages,
        price_date=price_date,
        scheduled_for=scheduled_for,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
