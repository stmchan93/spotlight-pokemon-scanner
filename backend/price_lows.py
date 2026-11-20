"""Cards near their price lows and cards hitting new highs.

- Lows: raw cards that dropped a lot inside a window and now trade at or near
  that window's low. Feeds ``find_price_lows`` ("what's a good buy right now").
- Highs: cards now at a window high first reached in the last few days, well
  above the window low. Feeds ``find_new_highs`` ("what's breaking out").

Split like ``meta_pulse``: ``compute_price_signals`` is the daily job (after the
price sync, via the ops prewarm hook or ``--compute``); ONE history scan feeds
both, written to ``price_lows`` / ``price_lows_runs`` and ``price_highs`` /
``price_highs_runs``. Request paths only read those tables.

Same guardrails as ``market_movers`` (see its docstring), applied to the whole
window series instead of two endpoints:
- one USD source per card: the TCGCSV main lane when the card has a main price
  now, else Scrydex default-raw for non-Japanese USD rows. Scrydex raw-JP values
  are JPY anchors and are never used.
- one printing: only rows with the current ``main_raw_variant`` count, so a
  variant re-point (cheap reprint -> real holo) is not a drop or a new high.
- current price >= ``min_price_usd`` (penny cards make absurd %).
- >= ``MIN_DISTINCT_PRICES`` distinct values in the window, and no day-to-day
  step above ``MAX_STEP_MULTIPLE`` (a glitch spike would fake the high).
Sealed product is skipped for lows and kept for highs (the tool filters it).
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

from catalog_tools import SEALED_SUPERTYPE, _table_columns, _table_exists, connect, utc_now
from market_movers import (
    MAX_STEP_MULTIPLE,
    MIN_DISTINCT_PRICES,
    NOW_TOLERANCE_DAYS,
    SOURCE_DEFAULT_RAW,
    SOURCE_MAIN_RAW,
    _is_japanese,
    _as_float,
    _latest_rows_per_card,
    has_outlier_step,
    market_movers_version_token,
)

WINDOWS = (90, 365)
DEFAULT_WINDOW_DAYS = 365
DEFAULT_MIN_PRICE_USD = 10.0
NEAR_LOW_PCT = 5.0  # within 5% above the window low
MIN_DROP_PCT = 25.0  # at least 25% below the window high
# "1-year low" over a week of data means nothing.
MIN_DAYS_COVERED = 30
# New highs: now within NEAR_HIGH_PCT of the window high, that high first
# reached in the last HIGH_RECENT_DAYS, and >= MIN_RISE_PCT above the window low.
NEAR_HIGH_PCT = 2.0
MIN_RISE_PCT = 15.0
HIGH_RECENT_DAYS = 7
# Highs rank by high date, known only after the per-card series read: cap the
# reads per game (biggest rise first).
MAX_HIGH_CANDIDATES_PER_GAME = 2000
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
class PriceHigh:
    card_id: str
    game: str
    source: str
    variant: str | None
    sealed: bool
    price_usd: float
    high_usd: float
    high_date: str
    low_usd: float
    pct_above_low: float
    days_covered: int
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
    sealed: bool = False


@dataclass(frozen=True)
class _WindowStats:
    low: float
    high: float
    first_date: str
    # Window high before the recent (new-high) span; None = no older points.
    older_high: float | None = None


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
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS price_highs (
            window_days INTEGER NOT NULL,
            card_id TEXT NOT NULL,
            game TEXT NOT NULL,
            source TEXT NOT NULL,
            variant TEXT,
            sealed INTEGER NOT NULL DEFAULT 0,
            price_usd REAL NOT NULL,
            high_usd REAL NOT NULL,
            high_date TEXT NOT NULL,
            low_usd REAL NOT NULL,
            pct_above_low REAL NOT NULL,
            days_covered INTEGER NOT NULL,
            rank INTEGER NOT NULL,
            as_of_date TEXT NOT NULL,
            PRIMARY KEY (window_days, card_id)
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_price_highs_rank ON price_highs(window_days, game, rank)"
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS price_highs_runs (
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


def stored_version(
    connection: sqlite3.Connection, window_days: int, *, table: str = "price_lows_runs"
) -> str | None:
    if not _table_exists(connection, table):
        return None
    row = connection.execute(
        f"SELECT version FROM {table} WHERE window_days = ?", (window_days,)
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
    history), else None. Series guards run later on the survivors."""
    if current < min_price_usd or stats.low <= 0 or stats.high <= 0:
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


def evaluate_high(
    current: float,
    stats: _WindowStats,
    *,
    now_date: str,
    min_price_usd: float = DEFAULT_MIN_PRICE_USD,
    near_high_pct: float = NEAR_HIGH_PCT,
    min_rise_pct: float = MIN_RISE_PCT,
    min_days_covered: int = MIN_DAYS_COVERED,
) -> dict[str, Any] | None:
    """Metrics when the card sits at a NEW window high (above everything before
    the recent span) well above the window low, else None. The exact high date
    and the series guards come from the per-card series read."""
    if current < min_price_usd or stats.low <= 0 or stats.high <= 0 or stats.older_high is None:
        return None
    days_covered = (date.fromisoformat(now_date[:10]) - date.fromisoformat(stats.first_date[:10])).days
    if days_covered < min_days_covered:
        return None
    low = min(stats.low, current)
    high = max(stats.high, current)
    # Matched before the recent span: an old high, not a new one.
    if round(stats.older_high, 2) >= round(high, 2):
        return None
    if current < high * (1.0 - near_high_pct / 100.0):
        return None
    pct_above_low = (current - low) / low * 100.0
    if pct_above_low < min_rise_pct:
        return None
    return {"low": low, "high": high, "pct_above_low": pct_above_low, "days_covered": days_covered}


def rank_lows(rows: list[PriceLow]) -> list[PriceLow]:
    """Biggest drop first; ties go to the pricier card."""
    return sorted(rows, key=lambda r: (-round(r.pct_below_high, 4), -r.price_usd, r.card_id))


def rank_highs(rows: list[PriceHigh]) -> list[PriceHigh]:
    """Most recent high first, then the biggest rise, then the pricier card."""
    return sorted(
        rows,
        key=lambda r: (
            -date.fromisoformat(r.high_date[:10]).toordinal(),
            -round(r.pct_above_low, 4),
            -r.price_usd,
            r.card_id,
        ),
    )


def _card_meta(connection: sqlite3.Connection, card_ids: list[str]) -> dict[str, tuple[str, str | None, bool]]:
    """{card_id: (game, language, sealed)}; one chunked primary-key read."""
    out: dict[str, tuple[str, str | None, bool]] = {}
    game_col = "game" if "game" in _table_columns(connection, "cards") else "'pokemon'"
    for start in range(0, len(card_ids), SQL_CHUNK):
        ids = card_ids[start : start + SQL_CHUNK]
        for row in connection.execute(
            f"SELECT id, {game_col}, supertype, language FROM cards WHERE id IN ({','.join('?' for _ in ids)})",
            tuple(ids),
        ):
            out[str(row[0])] = (str(row[1] or "pokemon"), row[3], row[2] == SEALED_SUPERTYPE)
    return out


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
    info = _card_meta(connection, list(now_rows))
    out: dict[str, _Current] = {}
    for card_id, row in now_rows.items():
        meta = info.get(card_id)
        if meta is None:  # no longer in `cards`
            continue
        game, language, sealed = meta
        main = now_main_rows.get(card_id)
        if main is not None:
            out[card_id] = _Current(
                card_id, game, SOURCE_MAIN_RAW, main.main_variant, main.main_raw, main.price_date, sealed
            )
        elif not _is_japanese(card_id, language) and row.currency == "USD" and row.default_raw is not None:
            out[card_id] = _Current(card_id, game, SOURCE_DEFAULT_RAW, None, row.default_raw, row.price_date, sealed)
    return out


_WindowMaps = tuple[dict[tuple[str, str | None], _WindowStats], dict[str, _WindowStats]]
_STATS_PER_VALUE = 4  # low, high, first date, older high


def _window_stats(
    connection: sqlite3.Connection,
    *,
    starts: dict[int, str],
    end: str,
    recent_start: str,
    has_main: bool,
    has_variant: bool,
) -> dict[int, _WindowMaps]:
    """Per window: (main lane per (card, printing), default-raw USD per card)
    low/high/first date + the high before ``recent_start``. ONE sequential
    table scan for every window and both signals (NOT INDEXED: a year of the
    date index is random row I/O, ~3.5x slower on a 16M-row synthetic year).
    Distinct counts are left to the series guard."""
    main_col = "main_raw_market_price" if has_main else "NULL"
    variant_col = "main_raw_variant" if has_variant else "NULL"
    usd_default = (
        "(CASE WHEN default_raw_market_price > 0 AND UPPER(display_currency_code) = 'USD' "
        "THEN default_raw_market_price END)"
    )
    main_value = f"(CASE WHEN {main_col} > 0 THEN {main_col} END)"
    windows = sorted(starts)
    select: list[str] = []
    params: list[Any] = []
    for window in windows:
        in_window = "price_date >= ?"
        for value in (main_value, usd_default):
            select.append(f"MIN(CASE WHEN {in_window} THEN {value} END)")
            select.append(f"MAX(CASE WHEN {in_window} THEN {value} END)")
            select.append(f"MIN(CASE WHEN {in_window} AND {value} IS NOT NULL THEN price_date END)")
            select.append(f"MAX(CASE WHEN {in_window} AND price_date < ? THEN {value} END)")
            params.extend([*[starts[window]] * 4, recent_start])
    sql = (
        f"SELECT card_id, {variant_col}, {', '.join(select)} "
        "FROM card_price_history_daily NOT INDEXED WHERE price_date BETWEEN ? AND ? "
        f"GROUP BY card_id, {variant_col}"
    )
    out: dict[int, _WindowMaps] = {window: ({}, {}) for window in windows}
    for row in connection.execute(sql, (*params, min(starts.values()), end)):
        card_id = str(row[0])
        for index, window in enumerate(windows):
            base = 2 + index * 2 * _STATS_PER_VALUE
            main, default = out[window]
            if row[base] is not None:
                main[(card_id, row[1])] = _WindowStats(
                    float(row[base]), float(row[base + 1]), str(row[base + 2]), _as_float(row[base + 3])
                )
            d = base + _STATS_PER_VALUE
            if row[d] is not None:
                # Default-raw rows are split across main-variant groups; fold them.
                low, high, first = float(row[d]), float(row[d + 1]), str(row[d + 2])
                older = _as_float(row[d + 3])
                prev = default.get(card_id)
                if prev is not None:
                    low, high, first = min(low, prev.low), max(high, prev.high), min(first, prev.first_date)
                    olders = [v for v in (older, prev.older_high) if v is not None]
                    older = max(olders) if olders else None
                default[card_id] = _WindowStats(low, high, first, older)
    return out


def _load_series(
    connection: sqlite3.Connection,
    specs: dict[str, tuple[str, str | None]],
    *,
    start: str,
    end: str,
) -> dict[str, list[tuple[str, float]]]:
    """Per card: the window's (date, USD value) points, oldest first, on the
    same source / printing / USD rule as ``specs`` (card_id -> (source, main
    variant)). Indexed per-card reads, only for candidates."""
    columns = _table_columns(connection, "card_price_history_daily")
    main_col = "main_raw_market_price" if "main_raw_market_price" in columns else "NULL"
    variant_col = "main_raw_variant" if "main_raw_variant" in columns else "NULL"
    series: dict[str, list[tuple[str, float]]] = {card_id: [] for card_id in specs}
    ids = sorted(specs)
    for offset in range(0, len(ids), SQL_CHUNK):
        chunk = ids[offset : offset + SQL_CHUNK]
        rows = connection.execute(
            "SELECT card_id, price_date, display_currency_code, default_raw_market_price, "
            f"{main_col}, {variant_col} FROM card_price_history_daily "
            f"WHERE card_id IN ({','.join('?' for _ in chunk)}) AND price_date BETWEEN ? AND ? "
            "ORDER BY card_id, price_date ASC",
            (*chunk, start, end),
        ).fetchall()
        for card_id, price_date, currency, default_raw, main_raw, variant in rows:
            source, want_variant = specs[str(card_id)]
            if source == SOURCE_MAIN_RAW:
                value = _as_float(main_raw) if variant == want_variant else None
            else:
                value = _as_float(default_raw) if str(currency or "USD").upper() == "USD" else None
            if value is not None and value > 0:
                series[str(card_id)].append((str(price_date)[:10], value))
    return series


def _series_bad(values: list[float]) -> bool:
    return len({round(v, 2) for v in values}) < MIN_DISTINCT_PRICES or has_outlier_step(
        values, max_multiple=MAX_STEP_MULTIPLE
    )


def series_guard_failures(
    connection: sqlite3.Connection,
    specs: dict[str, tuple[str, str | None]],
    *,
    start: str,
    end: str,
) -> set[str]:
    """Card ids whose window series has fewer than MIN_DISTINCT_PRICES values
    or a step above MAX_STEP_MULTIPLE."""
    if not specs:
        return set()
    series = _load_series(connection, specs, start=start, end=end)
    return {card_id for card_id, points in series.items() if _series_bad([v for _, v in points])}


def compute_price_lows(
    connection: sqlite3.Connection,
    *,
    window_days: int = DEFAULT_WINDOW_DAYS,
    today: date | None = None,
    **kwargs: Any,
) -> tuple[str | None, list[PriceLow]]:
    """(as_of_date, ranked qualifying cards) for one window."""
    as_of, by_window = compute_price_lows_windows(connection, windows=(window_days,), today=today, **kwargs)
    return as_of, by_window.get(window_days, [])


def compute_price_highs(
    connection: sqlite3.Connection,
    *,
    window_days: int = DEFAULT_WINDOW_DAYS,
    today: date | None = None,
    **kwargs: Any,
) -> tuple[str | None, list[PriceHigh]]:
    """(as_of_date, ranked new highs) for one window."""
    as_of, _, highs = compute_price_signals(connection, windows=(window_days,), today=today, **kwargs)
    return as_of, highs.get(window_days, [])


def compute_price_lows_windows(
    connection: sqlite3.Connection, **kwargs: Any
) -> tuple[str | None, dict[int, list[PriceLow]]]:
    as_of, lows, _ = compute_price_signals(connection, **kwargs)
    return as_of, lows


def _guarded_lows(
    connection: sqlite3.Connection,
    qualifying: list[PriceLow],
    *,
    start: str,
    end: str,
    max_per_game: int,
) -> list[PriceLow]:
    """Series guards walk down the ranking per game until max_per_game survive
    (only the stored pool is ever read back)."""
    by_game: dict[str, list[PriceLow]] = {}
    for item in rank_lows(qualifying):
        by_game.setdefault(item.game, []).append(item)
    kept: list[PriceLow] = []
    for game_rows in by_game.values():
        survivors: list[PriceLow] = []
        for offset in range(0, len(game_rows), STEP_CHECK_BATCH):
            batch = game_rows[offset : offset + STEP_CHECK_BATCH]
            bad = series_guard_failures(
                connection, {item.card_id: (item.source, item.variant) for item in batch}, start=start, end=end
            )
            survivors.extend(item for item in batch if item.card_id not in bad)
            if len(survivors) >= max_per_game:
                break
        kept.extend(survivors[:max_per_game])
    return rank_lows(kept)


def compute_price_signals(
    connection: sqlite3.Connection,
    *,
    windows: tuple[int, ...] = WINDOWS,
    today: date | None = None,
    min_price_usd: float = DEFAULT_MIN_PRICE_USD,
    near_low_pct: float = NEAR_LOW_PCT,
    min_drop_pct: float = MIN_DROP_PCT,
    near_high_pct: float = NEAR_HIGH_PCT,
    min_rise_pct: float = MIN_RISE_PCT,
    high_recent_days: int = HIGH_RECENT_DAYS,
    min_days_covered: int = MIN_DAYS_COVERED,
    max_per_game: int = MAX_STORED_PER_GAME,
) -> tuple[str | None, dict[int, list[PriceLow]], dict[int, list[PriceHigh]]]:
    """(as_of_date, {window: lows}, {window: new highs}); one history scan for
    all windows and both signals. Empty lists when the sync is stale."""
    today = today or datetime.now(timezone.utc).date()
    empty_lows: dict[int, list[PriceLow]] = {window: [] for window in windows}
    empty_highs: dict[int, list[PriceHigh]] = {window: [] for window in windows}
    row = connection.execute("SELECT MAX(price_date) FROM card_price_history_daily").fetchone()
    if row is None or not row[0]:
        return None, empty_lows, empty_highs
    try:
        ref_date = date.fromisoformat(str(row[0])[:10])
    except ValueError:
        return None, empty_lows, empty_highs
    if (today - ref_date).days > NOW_TOLERANCE_DAYS or not windows:
        return ref_date.isoformat(), empty_lows, empty_highs

    columns = _table_columns(connection, "card_price_history_daily")
    has_main = "main_raw_market_price" in columns
    has_variant = "main_raw_variant" in columns
    current = {
        card_id: cur
        for card_id, cur in _current_prices(connection, ref_date, has_main=has_main, has_variant=has_variant).items()
        if cur.price >= min_price_usd
    }
    end = ref_date.isoformat()
    # A high "first reached" on/after this date is new.
    recent_start = (ref_date - timedelta(days=high_recent_days - 1)).isoformat()
    starts = {window: (ref_date - timedelta(days=window)).isoformat() for window in windows}
    stats_by_window = _window_stats(
        connection, starts=starts, end=end, recent_start=recent_start, has_main=has_main, has_variant=has_variant
    )

    lows_out: dict[int, list[PriceLow]] = {}
    high_candidates: dict[int, list[tuple[_Current, _WindowStats, dict[str, Any]]]] = {}
    for window in windows:
        main_stats, default_stats = stats_by_window[window]
        qualifying: list[PriceLow] = []
        highs: list[tuple[_Current, _WindowStats, dict[str, Any]]] = []
        for cur in current.values():
            stats = (
                main_stats.get((cur.card_id, cur.variant))
                if cur.source == SOURCE_MAIN_RAW
                else default_stats.get(cur.card_id)
            )
            if stats is None:
                continue
            high_metrics = evaluate_high(
                cur.price, stats, now_date=cur.now_date, min_price_usd=min_price_usd,
                near_high_pct=near_high_pct, min_rise_pct=min_rise_pct, min_days_covered=min_days_covered,
            )
            if high_metrics is not None:
                highs.append((cur, stats, high_metrics))
            if cur.sealed:
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
        lows_out[window] = _guarded_lows(
            connection, qualifying, start=starts[window], end=end, max_per_game=max_per_game
        )
        by_game: dict[str, list[tuple[_Current, _WindowStats, dict[str, Any]]]] = {}
        for item in sorted(highs, key=lambda h: (-h[2]["pct_above_low"], h[0].card_id)):
            by_game.setdefault(item[0].game, []).append(item)
        high_candidates[window] = [
            item for game_items in by_game.values() for item in game_items[:MAX_HIGH_CANDIDATES_PER_GAME]
        ]

    # One series read for every window's candidates (the widest window), sliced per window.
    specs = {cur.card_id: (cur.source, cur.variant) for items in high_candidates.values() for cur, _, _ in items}
    series = _load_series(connection, specs, start=min(starts.values()), end=end) if specs else {}
    highs_out: dict[int, list[PriceHigh]] = {}
    for window in windows:
        rows: list[PriceHigh] = []
        for cur, stats, metrics in high_candidates[window]:
            points = [(day, value) for day, value in series.get(cur.card_id, []) if day >= starts[window]]
            if not points or _series_bad([value for _, value in points]):
                continue
            high = max(value for _, value in points)
            high_date = next(day for day, value in points if value >= high - 0.005)
            if high_date < recent_start:
                continue
            rows.append(
                PriceHigh(
                    card_id=cur.card_id, game=cur.game, source=cur.source, variant=cur.variant, sealed=cur.sealed,
                    price_usd=cur.price, high_usd=high, high_date=high_date, low_usd=metrics["low"],
                    pct_above_low=metrics["pct_above_low"], days_covered=metrics["days_covered"],
                    first_date=stats.first_date, now_date=cur.now_date,
                )
            )
        kept: list[PriceHigh] = []
        per_game: dict[str, int] = {}
        for item in rank_highs(rows):
            if per_game.get(item.game, 0) < max_per_game:
                per_game[item.game] = per_game.get(item.game, 0) + 1
                kept.append(item)
        highs_out[window] = kept
    return ref_date.isoformat(), lows_out, highs_out


def _upsert_run(
    connection: sqlite3.Connection, table: str, *, window_days: int, version: str, as_of_date: str | None,
    stored: int, elapsed_ms: float,
) -> None:
    connection.execute(
        f"INSERT INTO {table} (window_days, version, as_of_date, computed_at, stored_count, elapsed_ms) "
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(window_days) DO UPDATE SET version = excluded.version, "
        "as_of_date = excluded.as_of_date, computed_at = excluded.computed_at, "
        "stored_count = excluded.stored_count, elapsed_ms = excluded.elapsed_ms",
        (window_days, version, as_of_date, utc_now(), stored, round(elapsed_ms, 1)),
    )


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
        _upsert_run(
            connection, "price_lows_runs", window_days=window_days, version=version, as_of_date=as_of_date,
            stored=len(rows), elapsed_ms=elapsed_ms,
        )


def write_price_highs(
    connection: sqlite3.Connection,
    *,
    window_days: int,
    as_of_date: str | None,
    rows: list[PriceHigh],
    version: str,
    elapsed_ms: float,
) -> None:
    """Atomic swap of one window's new-high rows."""
    ensure_schema(connection)
    ranks: dict[str, int] = {}
    with connection:
        connection.execute("DELETE FROM price_highs WHERE window_days = ?", (window_days,))
        for item in rows:
            ranks[item.game] = ranks.get(item.game, 0) + 1
            connection.execute(
                "INSERT INTO price_highs (window_days, card_id, game, source, variant, sealed, price_usd, "
                "high_usd, high_date, low_usd, pct_above_low, days_covered, rank, as_of_date) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    window_days, item.card_id, item.game, item.source, item.variant, 1 if item.sealed else 0,
                    round(item.price_usd, 2), round(item.high_usd, 2), item.high_date, round(item.low_usd, 2),
                    round(item.pct_above_low, 1), item.days_covered, ranks[item.game],
                    item.now_date or as_of_date or "",
                ),
            )
        _upsert_run(
            connection, "price_highs_runs", window_days=window_days, version=version, as_of_date=as_of_date,
            stored=len(rows), elapsed_ms=elapsed_ms,
        )


def refresh_price_lows(
    connection: sqlite3.Connection,
    *,
    windows: tuple[int, ...] = WINDOWS,
    force: bool = False,
    today: date | None = None,
) -> dict[str, Any]:
    """Recompute lows + highs for each window whose stored version is stale.
    Cheap no-op when nothing changed since the last run."""
    ensure_schema(connection)
    connection.commit()
    version = price_lows_version_token(connection)
    report: dict[str, Any] = {"version": version, "windows": {}}
    if version is None:
        return report
    stale = tuple(
        w
        for w in windows
        if force
        or stored_version(connection, w) != version
        or stored_version(connection, w, table="price_highs_runs") != version
    )
    for window_days in windows:
        if window_days not in stale:
            report["windows"][window_days] = {"skipped": True}
    if not stale:
        return report
    started = time.perf_counter()
    as_of, lows, highs = compute_price_signals(connection, windows=stale, today=today)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    for window_days in stale:
        low_rows = lows.get(window_days, [])
        high_rows = highs.get(window_days, [])
        write_price_lows(
            connection, window_days=window_days, as_of_date=as_of, rows=low_rows,
            version=version, elapsed_ms=elapsed_ms,
        )
        write_price_highs(
            connection, window_days=window_days, as_of_date=as_of, rows=high_rows,
            version=version, elapsed_ms=elapsed_ms,
        )
        report["windows"][window_days] = {"stored": len(low_rows), "highs": len(high_rows), "asOf": as_of}
    report["elapsedMs"] = round(elapsed_ms, 1)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compute the price_lows / price_highs tables.")
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
