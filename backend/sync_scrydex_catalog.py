from __future__ import annotations

import http.client
import json
import random
import socket
import sqlite3
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError

from catalog_tools import (
    DEFAULT_GAME,
    GAMES,
    catalog_sync_request_type,
    game_has_language_paths,
    normalize_game,
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
from fx_rates import ensure_fx_rate_snapshot
from scrydex_adapter import (
    SCRYDEX_FULL_CATALOG_SYNC_SCOPE,
    SCRYDEX_PROVIDER,
    fetch_scrydex_cards_page,
    map_scrydex_card_for_game,
    persist_scrydex_daily_history_from_card_payload,
    persist_scrydex_raw_snapshot,
    scrydex_credentials,
    sync_scrydex_expansions,
)

load_backend_env_file(Path(__file__).resolve().parent / ".env")

# Each attempt also waits busy_timeout (30s) itself. 11/12-11/14 a hung server
# held the write lock for minutes and 2/5/10s gave up inside a minute.
SQLITE_LOCK_RETRY_DELAYS_SECONDS = (15.0, 60.0, 180.0, 300.0)
SCRYDEX_CATALOG_PAGE_MAX_ATTEMPTS = 5
SCRYDEX_CATALOG_PAGE_RETRY_BASE_DELAY_SECONDS = 2.0
SCRYDEX_CATALOG_PAGE_RETRY_MAX_DELAY_SECONDS = 30.0
SCRYDEX_CATALOG_PAGE_RETRY_JITTER_SECONDS = 1.0
# 404 is included: during catalog pagination Scrydex signals end-of-pages with an EMPTY page
# (`if not cards: break`), never with a 404, so a 404 mid-sync is always a transient gateway/edge
# blip (observed 2026-06-24: an 11s stalled request immediately followed by an 80ms 404). Retrying
# with backoff recovers it; without 404 here, a single transient 404 aborts the entire nightly sync.
# 520-524 are Cloudflare origin errors; a 521 outage cost the whole 2026-11-06 sync.
SCRYDEX_TRANSIENT_HTTP_STATUS_CODES = {404, 408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524}


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
    # A body cut off mid-download (IncompleteRead, 2026-11-16 page 137) or a
    # dropped connection: the page is fine, the transfer wasn't.
    if isinstance(exc, (http.client.HTTPException, ConnectionError)):
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
    game: str = DEFAULT_GAME,
) -> list[dict[str, Any]]:
    for attempt in range(1, SCRYDEX_CATALOG_PAGE_MAX_ATTEMPTS + 1):
        try:
            return fetch_scrydex_cards_page(
                page=page,
                page_size=page_size,
                include_prices=include_prices,
                language=language,
                game=game,
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


def parse_games_list(value: str) -> list[str]:
    """Parse a comma-separated ``--games`` value into normalized, deduped game ids.

    Strict on unknown tokens: ``normalize_game`` maps anything unrecognized to
    Pokémon, so a typo'd game would silently become a second full Pokémon sync
    (and the intended game would get no history that day). Reject instead.
    """
    games: list[str] = []
    for token in value.split(","):
        stripped = token.strip()
        if not stripped:
            continue
        normalized = normalize_game(stripped)
        if normalized == DEFAULT_GAME and stripped.lower() not in (
            DEFAULT_GAME,
            *GAMES[DEFAULT_GAME].aliases,
        ):
            raise SystemExit(f"Unknown game in --games: {stripped}")
        if normalized not in games:
            games.append(normalized)
    if not games:
        raise SystemExit("--games requires at least one game")
    return games


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


def _refresh_fx_rates_for_catalog(connection: sqlite3.Connection) -> dict[str, Any]:
    """Refresh the FX snapshot for every non-USD currency the catalog prices in.

    The card pricing / price-trend READ paths take cached FX rates without ever
    blocking on a network fetch, so this scheduled refresh is what keeps those
    rates current. Best-effort and isolated: a failed fetch for one currency (or
    the whole step) never fails the catalog sync.
    """
    summary: dict[str, Any] = {"currencies": [], "refreshed": 0, "failed": 0}
    try:
        rows = connection.execute(
            """
            SELECT DISTINCT UPPER(display_currency_code) AS code
            FROM card_price_snapshots
            WHERE display_currency_code IS NOT NULL
              AND UPPER(display_currency_code) <> 'USD'
            """
        ).fetchall()
    except sqlite3.Error:
        return summary

    currencies = sorted({str(row["code"]).strip() for row in rows if str(row["code"] or "").strip()})
    summary["currencies"] = currencies
    for currency in currencies:
        try:
            snapshot = ensure_fx_rate_snapshot(
                connection,
                base_currency=currency,
                quote_currency="USD",
                allow_fetch=True,
            )
            if snapshot is not None and snapshot.get("isFresh") is True:
                summary["refreshed"] += 1
            else:
                summary["failed"] += 1
        except Exception:  # noqa: BLE001 - never let an FX refresh fail the sync
            summary["failed"] += 1
    return summary


def _sync_scrydex_catalog_once(
    *,
    database_path: Path,
    repo_root: Path,
    page_size: int = 100,
    game: str = DEFAULT_GAME,
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

    normalized_game = normalize_game(game)
    has_language_paths = game_has_language_paths(normalized_game)
    normalized_language = str(language or "").strip().lower() or "all"
    normalized_price_date = str(price_date or "").strip() or None
    notes = {
        "game": normalized_game,
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
    request_type = catalog_sync_request_type(normalized_game, normalized_language)

    try:
        page = 1
        while True:
            cards = _fetch_scrydex_cards_page_with_retries(
                page=page,
                page_size=page_size,
                include_prices=True,
                # Games without per-language Scrydex sub-paths carry language as
                # a card field instead, so asking for one would 404.
                language=(
                    None
                    if (normalized_language == "all" or not has_language_paths)
                    else normalized_language
                ),
                game=normalized_game,
                request_type=request_type,
            )
            if not cards:
                break

            totals["pagesFetched"] += 1
            totals["cardsSeen"] += len(cards)

            imported_at = utc_now()
            for payload in cards:
                mapped_card = map_scrydex_card_for_game(payload, normalized_game)
                # Stamp the game HERE, not in the mapper. Games without a
                # dedicated mapper fall back to the Pokémon one, which does not
                # set `game` — so a Lorcana sync silently wrote 3,181 rows
                # labelled 'pokemon', and the index builder then found 0 cards
                # for game='lorcana'. The sync always knows its game; a mapper
                # can forget.
                mapped_card["game"] = normalized_game
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
                    game=normalized_game,
                    commit=False,
                )
                if persist_scrydex_raw_snapshot(
                    connection,
                    str(mapped_card["id"]),
                    payload,
                    game=normalized_game,
                    commit=False,
                ) is not None:
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
        # Refresh the expansions table so newly released sets appear in the
        # app's set browser the same day (the card pages above never touch
        # it). Best-effort: a failure here must not fail the card sync.
        expansions_refreshed = 0
        expansions_refresh_error: str | None = None
        try:
            # Must follow the sync's game: hardcoding Pokémon here made a One
            # Piece sync pull 449 POKÉMON expansions into the same table.
            expansions_refreshed = sync_scrydex_expansions(connection, game=normalized_game)
            connection.commit()
        except Exception as exc:
            connection.rollback()
            expansions_refresh_error = str(exc)
        # Keep FX snapshots current for the read paths (which never fetch).
        fx_summary = _refresh_fx_rates_for_catalog(connection)
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
            "expansionsRefreshed": expansions_refreshed,
            "expansionsRefreshError": expansions_refresh_error,
            "fxRefresh": fx_summary,
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
    game: str = DEFAULT_GAME,
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
                game=game,
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


# Exit code for a catch-up run that found every game already synced today.
CATCH_UP_NOTHING_TO_DO_EXIT_CODE = 3
# A game failed but still has catch-up attempts left today: a transient upstream
# blip (e.g. one Scrydex page timing out), NOT an outage. The shell logs it to
# Healthchecks without alerting; only exhausting the attempts alerts.
RETRY_PENDING_EXIT_CODE = 4
# Catch-up re-fetches a failed game from page 1, so an all-night Scrydex outage
# must not retry forever: ~465 credits per full Pokémon attempt.
DEFAULT_CATCH_UP_MAX_ATTEMPTS_PER_DAY = 4


def game_sync_attempts_for_date(
    connection: sqlite3.Connection, *, game: str, price_date: str
) -> tuple[bool, int]:
    """(succeeded, attempts) for one game's full-catalog runs started on the
    UTC ``price_date`` — the date the sync stamps its prices with."""
    rows = connection.execute(
        """
        SELECT status
        FROM provider_sync_runs
        WHERE provider = ?
          AND sync_scope = ?
          AND substr(started_at, 1, 10) = ?
          AND COALESCE(json_extract(notes_json, '$.game'), 'pokemon') = ?
        """,
        (SCRYDEX_PROVIDER, SCRYDEX_FULL_CATALOG_SYNC_SCOPE, price_date, game),
    ).fetchall()
    succeeded = any(row[0] == PROVIDER_SYNC_STATUS_SUCCEEDED for row in rows)
    return succeeded, len(rows)


def _games_needing_catch_up(
    *, database_path: Path, games: list[str], price_date: str, max_attempts_per_day: int
) -> tuple[list[str], list[dict[str, Any]]]:
    connection = connect(database_path, timeout_seconds=30.0, busy_timeout_ms=30_000)
    try:
        pending: list[str] = []
        skipped: list[dict[str, Any]] = []
        for game in games:
            succeeded, attempts = game_sync_attempts_for_date(connection, game=game, price_date=price_date)
            if succeeded:
                skipped.append({"game": game, "reason": "already_succeeded"})
            elif attempts >= max_attempts_per_day:
                skipped.append({"game": game, "reason": "attempt_cap", "attempts": attempts})
            else:
                pending.append(game)
        return pending, skipped
    finally:
        connection.close()


def failures_still_retryable(
    *, database_path: Path, games: list[str], price_date: str, max_attempts_per_day: int
) -> bool:
    """True when every failed game is still under today's attempt cap, so the
    hourly catch-up will try it again. Any unreadable state counts as NOT
    retryable, so a real problem still alerts."""
    try:
        connection = connect(database_path, timeout_seconds=30.0, busy_timeout_ms=30_000)
    except Exception:  # noqa: BLE001
        return False
    try:
        for game in games:
            succeeded, attempts = game_sync_attempts_for_date(connection, game=game, price_date=price_date)
            if succeeded:
                continue
            if attempts >= max_attempts_per_day:
                return False
        return True
    except Exception:  # noqa: BLE001
        return False
    finally:
        connection.close()


def sync_scrydex_catalog_for_games(
    *,
    database_path: Path,
    repo_root: Path,
    games: list[str],
    page_size: int = 100,
    language: str | None = None,
    max_pages: int | None = None,
    price_date: str | None = None,
    scheduled_for: str | None = None,
    catch_up: bool = False,
    max_attempts_per_day: int = DEFAULT_CATCH_UP_MAX_ATTEMPTS_PER_DAY,
) -> dict[str, Any]:
    """Run the catalog sync once per game, sequentially, each with its own
    provider_sync_runs row. One game's outage must not cost the other games
    their daily price-history point, so failures are recorded and the loop
    continues; the caller decides the exit code from ``failures``.

    ``catch_up`` runs only the games that have not succeeded yet for today's
    price date and are under the per-day attempt cap."""
    summaries: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    if catch_up:
        games, skipped = _games_needing_catch_up(
            database_path=database_path,
            games=list(games),
            price_date=str(price_date or "").strip() or datetime.now(timezone.utc).date().isoformat(),
            max_attempts_per_day=max_attempts_per_day,
        )
        print(json.dumps({"event": "scrydex_sync_catch_up", "pending": games, "skipped": skipped}), file=sys.stderr)
    for game in games:
        try:
            summaries.append(
                sync_scrydex_catalog(
                    database_path=database_path,
                    repo_root=repo_root,
                    page_size=page_size,
                    game=game,
                    language=language,
                    max_pages=max_pages,
                    price_date=price_date,
                    scheduled_for=scheduled_for,
                )
            )
        except Exception as exc:  # noqa: BLE001 - continue-on-failure is the contract
            failures.append({"game": game, "errorText": str(exc)})
            print(
                json.dumps(
                    {
                        "event": "scrydex_sync_game_failed",
                        "game": game,
                        "errorText": str(exc),
                    }
                ),
                file=sys.stderr,
            )
    return {"games": list(games), "summaries": summaries, "failures": failures, "skipped": skipped}


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

    games_value = cli_value("--games")
    if games_value is not None:
        if cli_value("--game") is not None:
            raise SystemExit("Pass either --game or --games, not both")
        catch_up = "--catch-up" in sys.argv
        result = sync_scrydex_catalog_for_games(
            database_path=database_path,
            repo_root=repo_root,
            games=parse_games_list(games_value),
            page_size=page_size,
            language=language,
            max_pages=max_pages,
            price_date=price_date,
            scheduled_for=scheduled_for,
            catch_up=catch_up,
            max_attempts_per_day=cli_int_value("--max-attempts-per-day", DEFAULT_CATCH_UP_MAX_ATTEMPTS_PER_DAY),
        )
        print(json.dumps(result, indent=2))
        if result["failures"]:
            failed_games = [str(item.get("game")) for item in result["failures"]]
            max_attempts = cli_int_value("--max-attempts-per-day", DEFAULT_CATCH_UP_MAX_ATTEMPTS_PER_DAY)
            if failures_still_retryable(
                database_path=database_path,
                games=failed_games,
                price_date=str(price_date or "").strip() or datetime.now(timezone.utc).date().isoformat(),
                max_attempts_per_day=max_attempts,
            ):
                raise SystemExit(RETRY_PENDING_EXIT_CODE)
            raise SystemExit(1)
        if any(item.get("reason") == "attempt_cap" for item in result["skipped"]):
            # Still unsynced and out of retries: a failure the alert must see.
            raise SystemExit(1)
        if catch_up and not result["games"]:
            # Distinct from success so the shell skips the post-sync refresh.
            raise SystemExit(CATCH_UP_NOTHING_TO_DO_EXIT_CODE)
        return

    summary = sync_scrydex_catalog(
        database_path=database_path,
        repo_root=repo_root,
        page_size=page_size,
        game=cli_value("--game") or DEFAULT_GAME,
        language=language,
        max_pages=max_pages,
        price_date=price_date,
        scheduled_for=scheduled_for,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
