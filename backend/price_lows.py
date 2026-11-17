"""Cards near their price lows: raw cards that dropped a lot inside a window
and now trade at or near that window's low. Feeds the assistant/MCP
``find_price_lows`` tool ("what's a good buy right now").

Split like ``meta_pulse``: ``compute_price_lows`` is the daily job (after the
price sync, via the ops prewarm hook or ``--compute``); it writes small rows to
``price_lows`` / ``price_lows_runs``. Request paths only read those tables.

Same guardrails as ``market_movers`` (see its docstring), applied to the whole
window series instead of two endpoints:
- one USD source per card: the TCGCSV main lane when the card has a main price
  now, else Scrydex default-raw for non-Japanese USD rows. Scrydex raw-JP values
  are JPY anchors and are never used.
- one printing: only rows with the current ``main_raw_variant`` count, so a
  variant re-point (cheap reprint -> real holo) is not a drop.
- current price >= ``min_price_usd`` (penny cards make absurd %).
- >= ``MIN_DISTINCT_PRICES`` distinct values in the window, and no day-to-day
  step above ``MAX_STEP_MULTIPLE`` (a glitch spike would fake the high).
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from catalog_tools import _table_columns, _table_exists, connect, utc_now
from market_movers import (
    MAX_STEP_MULTIPLE,
    MIN_DISTINCT_PRICES,
    NOW_TOLERANCE_DAYS,
    SOURCE_DEFAULT_RAW,
    SOURCE_MAIN_RAW,
    _card_games_and_languages,
    _is_japanese,
    _latest_rows_per_card,
    market_movers_version_token,
    outlier_step_card_ids,
)

WINDOWS = (90, 365)
DEFAULT_WINDOW_DAYS = 365
DEFAULT_MIN_PRICE_USD = 10.0
NEAR_LOW_PCT = 5.0  # within 5% above the window low
MIN_DROP_PCT = 25.0  # at least 25% below the window high
# "1-year low" over a week of data means nothing.
MIN_DAYS_COVERED = 30
# Stored per (game, window): the tool's filters (set, owned, price) need a pool.
MAX_STORED_PER_GAME = 1000
STEP_CHECK_BATCH = 400
SQL_CHUNK = 900


@dataclass(frozen=True)
class PriceLow:
    card_id: str
    game: str
    source: str
    variant: str | None
    price_usd: float
    low_usd: float
    high_usd: float
    pct_below_high: float
    pct_above_low: float
    days_covered: int
    at_window_low: bool
    first_date: str
    now_date: str


@dataclass(frozen=True)
class _Current:
    card_id: str
    game: str
    source: str
    variant: str | None
    price: float
    now_date: str


@dataclass(frozen=True)
class _WindowStats:
    low: float
    high: float
    distinct: int
    first_date: str


def ensure_schema(connection: sqlite3.Connection) -> None:
    """Small result tables; cheap to create on a live DB."""
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS price_lows (
            window_days INTEGER NOT NULL,
            card_id TEXT NOT NULL,
            game TEXT NOT NULL,
            source TEXT NOT NULL,
            variant TEXT,
            price_usd REAL NOT NULL,
            low_usd REAL NOT NULL,
            high_usd REAL NOT NULL,
            pct_below_high REAL NOT NULL,
            pct_above_low REAL NOT NULL,
            days_covered INTEGER NOT NULL,
            at_window_low INTEGER NOT NULL,
            rank INTEGER NOT NULL,
            as_of_date TEXT NOT NULL,
            PRIMARY KEY (window_days, card_id)
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_price_lows_rank ON price_lows(window_days, game, rank)"
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS price_lows_runs (
            window_days INTEGER PRIMARY KEY,
            version TEXT NOT NULL,
            as_of_date TEXT,
            computed_at TEXT NOT NULL,
            stored_count INTEGER NOT NULL,
            elapsed_ms REAL NOT NULL
        )
        """
    )


def price_lows_version_token(connection: sqlite3.Connection) -> str | None:
    """Same inputs as Top Trends: newest price date + pricing sync generation."""
    return market_movers_version_token(connection, window_days=0)


def stored_version(connection: sqlite3.Connection, window_days: int) -> str | None:
    if not _table_exists(connection, "price_lows_runs"):
        return None
    row = connection.execute(
        "SELECT version FROM price_lows_runs WHERE window_days = ?", (window_days,)
    ).fetchone()
    return str(row[0]) if row is not None else None


def evaluate(
    current: float,
    stats: _WindowStats,
    *,
    now_date: str,
    min_price_usd: float = DEFAULT_MIN_PRICE_USD,
    near_low_pct: float = NEAR_LOW_PCT,
    min_drop_pct: float = MIN_DROP_PCT,
    min_days_covered: int = MIN_DAYS_COVERED,
) -> dict[str, Any] | None:
    """Metrics when the card qualifies (price floor, near low, big drop, enough
    history and distinct prices), else None. Step glitches are checked later."""
    if current < min_price_usd or stats.low <= 0 or stats.high <= 0:
        return None
    if stats.distinct < MIN_DISTINCT_PRICES:
        return None
    days_covered = (date.fromisoformat(now_date[:10]) - date.fromisoformat(stats.first_date[:10])).days
    if days_covered < min_days_covered:
        return None
    # The current point is in the window, so low <= current <= high.
    low = min(stats.low, current)
    high = max(stats.high, current)
    pct_below_high = (high - current) / high * 100.0
    pct_above_low = (current - low) / low * 100.0
    if pct_above_low > near_low_pct or pct_below_high < min_drop_pct:
        return None
    return {
        "low": low,
        "high": high,
        "pct_below_high": pct_below_high,
        "pct_above_low": pct_above_low,
        "days_covered": days_covered,
        "at_window_low": round(current, 2) <= round(low, 2),
    }


def rank_lows(rows: list[PriceLow]) -> list[PriceLow]:
    """Biggest drop first; ties go to the pricier card."""
    return sorted(rows, key=lambda r: (-round(r.pct_below_high, 4), -r.price_usd, r.card_id))


def _current_prices(
    connection: sqlite3.Connection, ref_date: date, *, has_main: bool, has_variant: bool
) -> dict[str, _Current]:
    card_count = int(connection.execute("SELECT COUNT(*) FROM cards").fetchone()[0] or 0)
    now_rows, now_main_rows = _latest_rows_per_card(
        connection,
        start=(ref_date - timedelta(days=NOW_TOLERANCE_DAYS)).isoformat(),
        end=ref_date.isoformat(),
        has_main_column=has_main,
        has_main_variant_column=has_variant,
        expected_cards=card_count or None,
    )
    info = _card_games_and_languages(connection, list(now_rows))
    out: dict[str, _Current] = {}
    for card_id, row in now_rows.items():
        meta = info.get(card_id)
        if meta is None:  # sealed, or no longer in `cards`
            continue
        game, language = meta
        main = now_main_rows.get(card_id)
        if main is not None:
            out[card_id] = _Current(card_id, game, SOURCE_MAIN_RAW, main.main_variant, main.main_raw, main.price_date)
        elif not _is_japanese(card_id, language) and row.currency == "USD" and row.default_raw is not None:
            out[card_id] = _Current(card_id, game, SOURCE_DEFAULT_RAW, None, row.default_raw, row.price_date)
    return out


def _window_stats(
    connection: sqlite3.Connection,
    *,
    start: str,
    end: str,
    has_main: bool,
    has_variant: bool,
) -> tuple[dict[tuple[str, str | None], _WindowStats], dict[str, _WindowStats]]:
    """(main lane per (card, printing), default-raw USD per card) aggregates in
    SQL, so the year-long scan stays in SQLite instead of Python."""
    main: dict[tuple[str, str | None], _WindowStats] = {}
    if has_main:
        variant_col = "main_raw_variant" if has_variant else "NULL"
        for row in connection.execute(
            f"SELECT card_id, {variant_col}, MIN(main_raw_market_price), MAX(main_raw_market_price), "
            "COUNT(DISTINCT ROUND(main_raw_market_price, 2)), MIN(price_date) "
            "FROM card_price_history_daily "
            "WHERE price_date BETWEEN ? AND ? AND main_raw_market_price > 0 "
            f"GROUP BY card_id, {variant_col}",
            (start, end),
        ):
            main[(str(row[0]), row[1])] = _WindowStats(float(row[2]), float(row[3]), int(row[4]), str(row[5]))
    default: dict[str, _WindowStats] = {}
    for row in connection.execute(
        "SELECT card_id, MIN(default_raw_market_price), MAX(default_raw_market_price), "
        "COUNT(DISTINCT ROUND(default_raw_market_price, 2)), MIN(price_date) "
        "FROM card_price_history_daily "
        "WHERE price_date BETWEEN ? AND ? AND default_raw_market_price > 0 "
        "AND UPPER(display_currency_code) = 'USD' "
        "GROUP BY card_id",
        (start, end),
    ):
        default[str(row[0])] = _WindowStats(float(row[1]), float(row[2]), int(row[3]), str(row[4]))
    return main, default


def compute_price_lows(
    connection: sqlite3.Connection,
    *,
    window_days: int = DEFAULT_WINDOW_DAYS,
    today: date | None = None,
    min_price_usd: float = DEFAULT_MIN_PRICE_USD,
    near_low_pct: float = NEAR_LOW_PCT,
    min_drop_pct: float = MIN_DROP_PCT,
    min_days_covered: int = MIN_DAYS_COVERED,
    max_per_game: int = MAX_STORED_PER_GAME,
) -> tuple[str | None, list[PriceLow]]:
    """(as_of_date, ranked qualifying cards). Empty when the sync is stale."""
    today = today or datetime.now(timezone.utc).date()
    row = connection.execute("SELECT MAX(price_date) FROM card_price_history_daily").fetchone()
    if row is None or not row[0]:
        return None, []
    try:
        ref_date = date.fromisoformat(str(row[0])[:10])
    except ValueError:
        return None, []
    if (today - ref_date).days > NOW_TOLERANCE_DAYS:
        return ref_date.isoformat(), []

    columns = _table_columns(connection, "card_price_history_daily")
    has_main = "main_raw_market_price" in columns
    has_variant = "main_raw_variant" in columns
    current = _current_prices(connection, ref_date, has_main=has_main, has_variant=has_variant)
    start = (ref_date - timedelta(days=window_days)).isoformat()
    end = ref_date.isoformat()
    main_stats, default_stats = _window_stats(
        connection, start=start, end=end, has_main=has_main, has_variant=has_variant
    )

    qualifying: list[PriceLow] = []
    for cur in current.values():
        if cur.price < min_price_usd:
            continue
        stats = (
            main_stats.get((cur.card_id, cur.variant))
            if cur.source == SOURCE_MAIN_RAW
            else default_stats.get(cur.card_id)
        )
        if stats is None:
            continue
        metrics = evaluate(
            cur.price, stats, now_date=cur.now_date, min_price_usd=min_price_usd,
            near_low_pct=near_low_pct, min_drop_pct=min_drop_pct, min_days_covered=min_days_covered,
        )
        if metrics is None:
            continue
        qualifying.append(
            PriceLow(
                card_id=cur.card_id, game=cur.game, source=cur.source, variant=cur.variant,
                price_usd=cur.price, low_usd=metrics["low"], high_usd=metrics["high"],
                pct_below_high=metrics["pct_below_high"], pct_above_low=metrics["pct_above_low"],
                days_covered=metrics["days_covered"], at_window_low=metrics["at_window_low"],
                first_date=stats.first_date, now_date=cur.now_date,
            )
        )

    # Glitch guard on the full window series, walked down the ranking per game
    # until max_per_game survive (only the kept pool is ever read back).
    by_game: dict[str, list[PriceLow]] = {}
    for item in rank_lows(qualifying):
        by_game.setdefault(item.game, []).append(item)
    kept: list[PriceLow] = []
    for game_rows in by_game.values():
        survivors: list[PriceLow] = []
        for offset in range(0, len(game_rows), STEP_CHECK_BATCH):
            batch = game_rows[offset : offset + STEP_CHECK_BATCH]
            bad = outlier_step_card_ids(
                connection,
                {item.card_id: (item.source, item.variant) for item in batch},
                start=start,
                end=end,
                max_multiple=MAX_STEP_MULTIPLE,
            )
            survivors.extend(item for item in batch if item.card_id not in bad)
            if len(survivors) >= max_per_game:
                break
        kept.extend(survivors[:max_per_game])
    return ref_date.isoformat(), rank_lows(kept)


def write_price_lows(
    connection: sqlite3.Connection,
    *,
    window_days: int,
    as_of_date: str | None,
    rows: list[PriceLow],
    version: str,
    elapsed_ms: float,
) -> None:
    """Atomic swap of one window's rows."""
    ensure_schema(connection)
    ranks: dict[str, int] = {}
    with connection:
        connection.execute("DELETE FROM price_lows WHERE window_days = ?", (window_days,))
        for item in rows:
            ranks[item.game] = ranks.get(item.game, 0) + 1
            connection.execute(
                "INSERT INTO price_lows (window_days, card_id, game, source, variant, price_usd, low_usd, "
                "high_usd, pct_below_high, pct_above_low, days_covered, at_window_low, rank, as_of_date) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    window_days, item.card_id, item.game, item.source, item.variant,
                    round(item.price_usd, 2), round(item.low_usd, 2), round(item.high_usd, 2),
                    round(item.pct_below_high, 1), round(item.pct_above_low, 1), item.days_covered,
                    1 if item.at_window_low else 0, ranks[item.game], item.now_date or as_of_date or "",
                ),
            )
        connection.execute(
            "INSERT INTO price_lows_runs (window_days, version, as_of_date, computed_at, stored_count, elapsed_ms) "
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(window_days) DO UPDATE SET version = excluded.version, "
            "as_of_date = excluded.as_of_date, computed_at = excluded.computed_at, "
            "stored_count = excluded.stored_count, elapsed_ms = excluded.elapsed_ms",
            (window_days, version, as_of_date, utc_now(), len(rows), round(elapsed_ms, 1)),
        )


def refresh_price_lows(
    connection: sqlite3.Connection,
    *,
    windows: tuple[int, ...] = WINDOWS,
    force: bool = False,
    today: date | None = None,
) -> dict[str, Any]:
    """Recompute each window whose stored version is stale. Cheap no-op when
    nothing changed since the last run."""
    ensure_schema(connection)
    connection.commit()
    version = price_lows_version_token(connection)
    report: dict[str, Any] = {"version": version, "windows": {}}
    if version is None:
        return report
    for window_days in windows:
        if not force and stored_version(connection, window_days) == version:
            report["windows"][window_days] = {"skipped": True}
            continue
        started = time.perf_counter()
        as_of, rows = compute_price_lows(connection, window_days=window_days, today=today)
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        write_price_lows(
            connection, window_days=window_days, as_of_date=as_of, rows=rows,
            version=version, elapsed_ms=elapsed_ms,
        )
        report["windows"][window_days] = {"stored": len(rows), "asOf": as_of, "elapsedMs": round(elapsed_ms, 1)}
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compute the price_lows tables.")
    parser.add_argument("--compute", action="store_true", required=True)
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--force", action="store_true", help="Recompute even if the version is unchanged.")
    parser.add_argument("--as-of", help="Pretend today is this date (stale local DBs).")
    args = parser.parse_args(argv)
    connection = connect(Path(args.database_path), timeout_seconds=30.0)
    today = date.fromisoformat(args.as_of) if args.as_of else None
    report = refresh_price_lows(connection, force=args.force, today=today)
    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
