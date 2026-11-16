"""Refill days the nightly Scrydex sync missed, one card at a time, on a budget.

The nightly sync pulls TODAY's prices in pages of 100 cards. When it fails for a
day (2026-11-06 Scrydex 521 outage, 2026-11-12..15 SQLite lock), that day's
condition and graded prices are simply absent. Scrydex keeps per-card history,
but only per card: `/cards/<id>/price_history` costs one credit per card and
returns every condition, graded grade, and day in the requested range.

So this job:
  1. finds GAP DATES in the lookback window: days where far fewer cards got a
     Scrydex price than on a normal day;
  2. finds the cards that were priced on normal days but are missing on a gap
     date, ordered owned/watched first, then cards with graded prices, then the
     rest;
  3. fetches each card's history once and writes ONLY its missing gap dates
     (never rewriting days the sync recorded), one short transaction per card;
  4. stops at a nightly request cap and a per-billing-cycle cap, and records
     every attempt so a card Scrydex has nothing for is not re-billed nightly.

TCGCSV columns and `raw_main` cells are untouched: `upsert_price_history_daily`
writes the Scrydex lanes only.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import statistics
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from catalog_tools import connect, is_tcgplayer_catalog_card_id
from scrydex_adapter import (
    SCRYDEX_PROVIDER,
    fetch_scrydex_price_history,
    persist_scrydex_price_history_payload,
)

# A day counts as a gap when fewer than this share of the window's median
# card count got a Scrydex price (normal days sit within ~1% of each other;
# the failed days were at 5-20%).
GAP_DAY_COVERAGE_THRESHOLD = 0.8
# Scrydex serves at most 100 history days per request (page_size cap, checked
# 2026-11-16), so 99 days back keeps every card at ONE credit.
DEFAULT_LOOKBACK_DAYS = 99
SCRYDEX_HISTORY_MAX_DAYS_PER_REQUEST = 100
PROGRESS_TABLE = "scrydex_history_backfill_attempts"

TIER_OWNED_OR_WATCHED = 0
TIER_GRADED = 1
TIER_REST = 2


def ensure_progress_table(connection: sqlite3.Connection) -> None:
    connection.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {PROGRESS_TABLE} (
            card_id TEXT NOT NULL,
            gap_dates TEXT NOT NULL,
            attempted_at TEXT NOT NULL,
            status TEXT NOT NULL,
            dates_written INTEGER NOT NULL DEFAULT 0,
            error_text TEXT,
            PRIMARY KEY (card_id, gap_dates)
        )
        """
    )
    connection.commit()


def find_gap_dates(
    connection: sqlite3.Connection, *, start_date: str, end_date: str
) -> tuple[list[str], dict[str, int]]:
    """Dates in [start_date, end_date] with Scrydex coverage well below normal."""
    rows = connection.execute(
        """
        SELECT price_date, COUNT(default_raw_market_price)
        FROM card_price_history_daily
        WHERE price_date BETWEEN ? AND ?
        GROUP BY price_date
        """,
        (start_date, end_date),
    ).fetchall()
    counts = {str(row[0]): int(row[1]) for row in rows}
    all_dates = _date_range(start_date, end_date)
    for day in all_dates:
        counts.setdefault(day, 0)
    observed = [count for count in counts.values() if count > 0]
    if not observed:
        return [], counts
    median = statistics.median(observed)
    gaps = [day for day in all_dates if counts[day] < median * GAP_DAY_COVERAGE_THRESHOLD]
    return gaps, counts


def _date_range(start_date: str, end_date: str) -> list[str]:
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    return [(start + timedelta(days=offset)).isoformat() for offset in range((end - start).days + 1)]


def find_candidate_cards(
    connection: sqlite3.Connection,
    *,
    gap_dates: list[str],
    good_dates: list[str],
) -> list[dict[str, Any]]:
    """Cards with a Scrydex price on some normal day but none on >=1 gap date,
    with the gap dates each one is missing, in priority order."""
    if not gap_dates or not good_dates:
        return []

    def priced_on(dates: list[str]) -> dict[str, set[str]]:
        placeholders = ",".join("?" * len(dates))
        by_card: dict[str, set[str]] = {}
        for card_id, price_date in connection.execute(
            f"""
            SELECT card_id, price_date
            FROM card_price_history_daily
            WHERE price_date IN ({placeholders}) AND default_raw_market_price IS NOT NULL
            """,
            dates,
        ):
            by_card.setdefault(card_id, set()).add(price_date)
        return by_card

    priced_good = priced_on(good_dates)
    priced_gap = priced_on(gap_dates)
    gap_set = set(gap_dates)

    games = dict(connection.execute("SELECT id, game FROM cards").fetchall())
    owned_or_watched = {
        row[0]
        for row in connection.execute(
            "SELECT card_id FROM deck_entries UNION SELECT card_id FROM card_favorites"
        )
    }
    latest_good = max(good_dates)
    graded = {
        row[0]
        for row in connection.execute(
            """
            SELECT DISTINCT card_id
            FROM card_price_history_cell
            WHERE price_date = ? AND provider = ? AND lane = 'graded'
            """,
            (latest_good, SCRYDEX_PROVIDER),
        )
    }

    candidates: list[dict[str, Any]] = []
    for card_id in priced_good:
        if is_tcgplayer_catalog_card_id(card_id) or card_id not in games:
            continue
        missing = sorted(gap_set - priced_gap.get(card_id, set()))
        if not missing:
            continue
        if card_id in owned_or_watched:
            tier = TIER_OWNED_OR_WATCHED
        elif card_id in graded:
            tier = TIER_GRADED
        else:
            tier = TIER_REST
        candidates.append({"cardId": card_id, "game": games[card_id], "missingDates": missing, "tier": tier})
    candidates.sort(key=lambda item: (item["tier"], item["cardId"]))
    return candidates


def _progress_table_exists(connection: sqlite3.Connection) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (PROGRESS_TABLE,)
    ).fetchone() is not None


def attempted_cards(connection: sqlite3.Connection, gap_key: str) -> set[str]:
    if not _progress_table_exists(connection):
        return set()
    return {
        row[0]
        for row in connection.execute(
            # Errors (timeouts, 5xx) retry next night; ok / no_data are settled.
            f"SELECT card_id FROM {PROGRESS_TABLE} WHERE gap_dates = ? AND status <> 'error'", (gap_key,)
        )
    }


def billing_cycle_start(today: date, cycle_day: int) -> date:
    if today.day >= cycle_day:
        return today.replace(day=cycle_day)
    first_of_month = today.replace(day=1)
    previous_month_end = first_of_month - timedelta(days=1)
    return previous_month_end.replace(day=min(cycle_day, previous_month_end.day))


def requests_this_cycle(connection: sqlite3.Connection, cycle_start: date) -> int:
    if not _progress_table_exists(connection):
        return 0
    row = connection.execute(
        f"SELECT COUNT(*) FROM {PROGRESS_TABLE} WHERE attempted_at >= ?",
        (cycle_start.isoformat(),),
    ).fetchone()
    return int(row[0])


def _normalize_history_date(value: Any) -> str:
    # Scrydex returns `2026/11/14`; history rows are keyed `2026-11-14`.
    return str(value or "").strip().replace("/", "-")


def filter_payload_to_dates(payload: dict[str, Any], wanted: Iterable[str]) -> dict[str, Any]:
    wanted_set = set(wanted)
    entries = payload.get("data") if isinstance(payload.get("data"), list) else []
    kept = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        normalized = _normalize_history_date(entry.get("date"))
        if normalized in wanted_set:
            kept.append({**entry, "date": normalized})
    return {**payload, "data": kept}


def backfill_card(
    connection: sqlite3.Connection,
    candidate: dict[str, Any],
    *,
    today: date,
    fetch: Callable[..., dict[str, Any]] = fetch_scrydex_price_history,
) -> int:
    """One request; writes only the card's missing gap dates. Returns dates written."""
    earliest = date.fromisoformat(candidate["missingDates"][0])
    days = min((today - earliest).days + 1, SCRYDEX_HISTORY_MAX_DAYS_PER_REQUEST)
    payload = fetch(candidate["cardId"], game=candidate["game"], days=days)
    filtered = filter_payload_to_dates(payload, candidate["missingDates"])
    if not filtered["data"]:
        return 0
    persist_scrydex_price_history_payload(
        connection, card_id=candidate["cardId"], payload=filtered, game=candidate["game"], commit=True
    )
    return len(filtered["data"])


def run_backfill(
    connection: sqlite3.Connection,
    *,
    today: date,
    lookback_days: int,
    max_requests: int,
    cycle_budget: int,
    cycle_day: int,
    max_tier: int = TIER_REST,
    dry_run: bool = False,
    fetch: Callable[..., dict[str, Any]] = fetch_scrydex_price_history,
    sleep_seconds: float = 0.2,
) -> dict[str, Any]:
    if not dry_run:
        ensure_progress_table(connection)
    # Yesterday back: today's own row may still be on its way from the sync.
    end_date = (today - timedelta(days=1)).isoformat()
    start_date = (today - timedelta(days=lookback_days)).isoformat()
    gap_dates, counts = find_gap_dates(connection, start_date=start_date, end_date=end_date)
    good_dates = [day for day in _date_range(start_date, end_date) if day not in gap_dates and counts.get(day, 0) > 0]
    gap_key = ",".join(gap_dates)
    summary: dict[str, Any] = {
        "gapDates": gap_dates,
        "dryRun": dry_run,
        "requests": 0,
        "datesWritten": 0,
        "errors": 0,
    }
    if not gap_dates:
        return summary

    candidates = [
        candidate
        # The five most recent normal days are enough to tell "priced" from
        # "never priced", and keep the scan of the daily table small.
        for candidate in find_candidate_cards(connection, gap_dates=gap_dates, good_dates=good_dates[-5:])
        if candidate["tier"] <= max_tier
    ]
    already = attempted_cards(connection, gap_key)
    pending = [candidate for candidate in candidates if candidate["cardId"] not in already]
    cycle_start = billing_cycle_start(today, cycle_day)
    cycle_used = requests_this_cycle(connection, cycle_start)
    allowance = max(0, min(max_requests, cycle_budget - cycle_used))
    summary.update(
        {
            "candidates": len(candidates),
            "pending": len(pending),
            "pendingByTier": {
                str(tier): sum(1 for item in pending if item["tier"] == tier) for tier in (0, 1, 2)
            },
            "cycleStart": cycle_start.isoformat(),
            "cycleUsedBefore": cycle_used,
            "allowance": allowance,
        }
    )
    if dry_run:
        return summary

    for candidate in pending[:allowance]:
        status = "ok"
        error_text = None
        written = 0
        try:
            written = backfill_card(connection, candidate, today=today, fetch=fetch)
            if written == 0:
                status = "no_data"
        except sqlite3.OperationalError as exc:
            # A lock is ours, not the card's: leave it unrecorded so tomorrow retries.
            connection.rollback()
            summary["errors"] += 1
            summary["stoppedOn"] = str(exc)
            break
        except Exception as exc:  # noqa: BLE001 - one bad card must not stop the night
            connection.rollback()
            status = "error"
            error_text = str(exc)[:500]
            summary["errors"] += 1
        summary["requests"] += 1
        summary["datesWritten"] += written
        connection.execute(
            f"""
            INSERT OR REPLACE INTO {PROGRESS_TABLE}
                (card_id, gap_dates, attempted_at, status, dates_written, error_text)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (candidate["cardId"], gap_key, datetime.now(timezone.utc).isoformat(), status, written, error_text),
        )
        connection.commit()
        if sleep_seconds:
            time.sleep(sleep_seconds)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--max-requests", type=int, required=True, help="Hard cap on Scrydex requests this run.")
    parser.add_argument("--cycle-budget", type=int, required=True, help="Cap on backfill requests per billing cycle.")
    parser.add_argument("--cycle-day", type=int, default=7, help="Day of month the Scrydex billing cycle starts.")
    parser.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS)
    parser.add_argument("--max-tier", type=int, default=TIER_REST, help="0=owned/watched, 1=+graded, 2=all.")
    parser.add_argument("--dry-run", action="store_true", help="Report what would be fetched; no Scrydex calls.")
    args = parser.parse_args(argv)

    connection = connect(Path(args.database_path), timeout_seconds=30.0, busy_timeout_ms=30_000)
    try:
        summary = run_backfill(
            connection,
            today=datetime.now(timezone.utc).date(),
            lookback_days=args.lookback_days,
            max_requests=max(0, args.max_requests),
            cycle_budget=max(0, args.cycle_budget),
            cycle_day=args.cycle_day,
            max_tier=args.max_tier,
            dry_run=args.dry_run,
        )
    finally:
        connection.close()
    print(json.dumps({"event": "scrydex_history_backfill", **summary}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
