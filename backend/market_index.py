"""Per-game Market Index: the Market Analytics header number ("Pokémon Market
Index 218.6 · 1Y +102.3%").

Methodology (owner, 2026-11-23; docs/market-analytics-2026-11-23.md):

- Basket: the game's top ``BASKET_SIZE`` English raw singles (no sealed, no
  Japanese; the collectibility filter and the $10 floor) by market price as of
  the selection day, each with a clean series (no >3x day-to-day step in the
  ``GUARD_LOOKBACK_DAYS`` before it). One USD source per card, fixed at
  selection: the TCGplayer main lane (same printing) when the card has one,
  else Scrydex default-raw USD.
- FIXED per calendar month: chosen on the 1st (prices as of that day), held
  all month. The first basket is chosen on the base day.
- EQUAL-weighted: each day's index change = the mean of every basket card's
  price ratio vs the previous day (last known price carried forward).
  Chain-linked across days and rebalances: on the 1st the old basket sets that
  day's level, the new basket moves it from the 2nd, so the level never jumps.
- Base = 100 on the first day of stored history inside ``BACKFILL_DAYS`` (a
  game whose prices start later begins on the first 1st it has a basket).

Persisted in ``market_index_daily`` / ``market_index_baskets`` /
``market_index_runs`` (small tables, primary keys only). ``refresh_market_index``
backfills once, then each run recomputes from the latest basket's selection
day (late prices and spike drops settle), and appends. It runs at the top of
``market_analytics.refresh_market_analytics`` (the ops prewarm hook). CLI:
``python backend/market_index.py --compute --database-path <db> [--game pokemon] [--force]``.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable

import price_lows
from catalog_tools import (
    SEALED_SUPERTYPE,
    SUPPORTED_GAMES,
    _table_columns,
    _table_exists,
    connect,
    game_display_name,
    utc_now,
)
from market_movers import (
    MAX_STEP_MULTIPLE,
    SOURCE_DEFAULT_RAW,
    SOURCE_MAIN_RAW,
    _is_japanese,
    _latest_rows_per_card,
    has_outlier_step,
)

BASKET_SIZE = 100
MIN_BASKET_SIZE = 20  # fewer qualifying cards = no index (too noisy to call a market)
BASE_VALUE = 100.0
BACKFILL_DAYS = 365
SELECT_TOLERANCE_DAYS = 7  # "price as of the 1st" = newest row in the 7 days up to it
GUARD_LOOKBACK_DAYS = 30
CANDIDATE_CHUNK = 300
MIN_PRICE_USD = 10.0  # market_analytics.LIQUID_MIN_USD / mcp_server.tools.COLLECTIBLE_MIN_PRICE_USD
INDEX_POINTS = 60


@dataclass(frozen=True)
class Member:
    card_id: str
    source: str
    variant: str | None
    price: float  # USD on the selection day


# --- schema ----------------------------------------------------------------------


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS market_index_daily (
            game TEXT NOT NULL,
            date TEXT NOT NULL,
            value REAL NOT NULL,
            basket_size INTEGER NOT NULL,
            PRIMARY KEY (game, date)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS market_index_baskets (
            game TEXT NOT NULL,
            month TEXT NOT NULL,
            selected_on TEXT NOT NULL,
            rank INTEGER NOT NULL,
            card_id TEXT NOT NULL,
            source TEXT NOT NULL,
            variant TEXT,
            price_usd REAL NOT NULL,
            PRIMARY KEY (game, month, card_id)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS market_index_runs (
            game TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            base_date TEXT,
            through_date TEXT,
            computed_at TEXT NOT NULL,
            elapsed_ms REAL NOT NULL
        )
        """
    )


def version_token(connection: sqlite3.Connection) -> str | None:
    """Changes whenever any game's index was recomputed (market_analytics' token)."""
    if not _table_exists(connection, "market_index_runs"):
        return None
    row = connection.execute("SELECT MAX(computed_at), MAX(through_date) FROM market_index_runs").fetchone()
    return None if row is None or row[0] is None else f"{row[0]}|{row[1]}"


# --- pure math ---------------------------------------------------------------------


def first_of_next_month(day: date) -> date:
    return date(day.year + (day.month == 12), day.month % 12 + 1, 1)


def drop_spikes(points: list[tuple[str, float]], max_multiple: float = MAX_STEP_MULTIPLE) -> list[tuple[str, float]]:
    """Drop single points more than ``max_multiple``x off BOTH neighbours (a
    glitch print, not a move)."""
    if len(points) < 3:
        return points
    kept = [points[0]]
    for i in range(1, len(points) - 1):
        prev, cur, nxt = points[i - 1][1], points[i][1], points[i + 1][1]
        up = cur > max_multiple * prev and cur > max_multiple * nxt
        down = cur * max_multiple < prev and cur * max_multiple < nxt
        if not (up or down):
            kept.append(points[i])
    kept.append(points[-1])
    return kept


def chain_segment(
    members: list[Member],
    series: dict[str, list[tuple[str, float]]],
    *,
    start: date,
    end: date,
    start_value: float,
) -> list[tuple[str, float]]:
    """Index level for each day in (start, end]: yesterday's level x the mean of
    every member's price ratio vs yesterday. A member's price starts at its
    selection price and moves only on its own points (carried forward)."""
    if not members:
        return [((start + timedelta(days=i)).isoformat(), start_value) for i in range(1, (end - start).days + 1)]
    current = {m.card_id: m.price for m in members}
    cursors = {m.card_id: 0 for m in members}
    start_iso = start.isoformat()
    for m in members:  # skip points on/before the selection day
        points = series.get(m.card_id) or []
        index = 0
        while index < len(points) and points[index][0] <= start_iso:
            index += 1
        cursors[m.card_id] = index
    value = start_value
    out: list[tuple[str, float]] = []
    for offset in range(1, (end - start).days + 1):
        day = (start + timedelta(days=offset)).isoformat()
        ratio_sum = 0.0
        for m in members:
            points = series.get(m.card_id) or []
            index = cursors[m.card_id]
            previous = current[m.card_id]
            while index < len(points) and points[index][0] <= day:
                current[m.card_id] = points[index][1]
                index += 1
            cursors[m.card_id] = index
            ratio_sum += current[m.card_id] / previous
        value = value * ratio_sum / len(members)
        out.append((day, value))
    return out


# --- inputs ------------------------------------------------------------------------


def eligible_cards(connection: sqlite3.Connection, games: tuple[str, ...]) -> dict[str, str]:
    """card_id -> game for every card the basket may hold: the game's English
    raw singles (no sealed, no Japanese), collectible (image, not bulk
    Energy/Trainer)."""
    from mcp_server.tools import has_card_image, is_low_interest_card  # mcp_server imports server

    game_col = "game" if "game" in _table_columns(connection, "cards") else "'pokemon'"
    out: dict[str, str] = {}
    for card_id, game, supertype, rarity, image, language in connection.execute(
        f"SELECT id, {game_col}, supertype, rarity, COALESCE(NULLIF(image_small_url, ''), image_url), language "
        "FROM cards"
    ):
        game = str(game or "pokemon")
        if game not in games or supertype == SEALED_SUPERTYPE or _is_japanese(str(card_id), language):
            continue
        card = {"supertype": supertype, "rarity": rarity, "game": game, "imageSmallURL": image}
        if has_card_image(card) and not is_low_interest_card(card):
            out[str(card_id)] = game
    return out


class _Selector:
    """Basket picks per (game, day). The per-day price read is shared by every
    game (one pass over that week of rows)."""

    def __init__(self, connection: sqlite3.Connection, cards: dict[str, str]) -> None:
        self.connection = connection
        self.cards = cards
        columns = _table_columns(connection, "card_price_history_daily")
        self.has_main = "main_raw_market_price" in columns
        self.has_variant = "main_raw_variant" in columns
        self._ranked: dict[date, dict[str, list[Member]]] = {}

    def ranked(self, day: date) -> dict[str, list[Member]]:
        cached = self._ranked.get(day)
        if cached is not None:
            return cached
        rows, main = _latest_rows_per_card(
            self.connection,
            start=(day - timedelta(days=SELECT_TOLERANCE_DAYS)).isoformat(),
            end=day.isoformat(),
            has_main_column=self.has_main,
            has_main_variant_column=self.has_variant,
        )
        by_game: dict[str, list[Member]] = {}
        for card_id, row in rows.items():
            game = self.cards.get(card_id)
            if game is None:
                continue
            main_row = main.get(card_id)
            if main_row is not None and main_row.main_raw is not None:
                member = Member(card_id, SOURCE_MAIN_RAW, main_row.main_variant, float(main_row.main_raw))
            elif row.currency == "USD" and row.default_raw is not None:
                member = Member(card_id, SOURCE_DEFAULT_RAW, None, float(row.default_raw))
            else:
                continue
            if member.price >= MIN_PRICE_USD:
                by_game.setdefault(game, []).append(member)
        for members in by_game.values():
            members.sort(key=lambda m: (-m.price, m.card_id))
        self._ranked[day] = by_game
        return by_game

    def select(self, game: str, day: date) -> list[Member]:
        """Top BASKET_SIZE by price whose lookback series has no >3x step."""
        ranked = self.ranked(day).get(game) or []
        start = (day - timedelta(days=GUARD_LOOKBACK_DAYS)).isoformat()
        basket: list[Member] = []
        for offset in range(0, len(ranked), CANDIDATE_CHUNK):
            chunk = ranked[offset : offset + CANDIDATE_CHUNK]
            series = price_lows._load_series(
                self.connection, {m.card_id: (m.source, m.variant) for m in chunk}, start=start, end=day.isoformat()
            )
            for m in chunk:
                values = [value for _, value in series.get(m.card_id) or []]
                if not has_outlier_step(values, max_multiple=MAX_STEP_MULTIPLE):
                    basket.append(m)
                    if len(basket) >= BASKET_SIZE:
                        return basket
        return basket


# --- compute -----------------------------------------------------------------------


def compute_game(
    connection: sqlite3.Connection,
    *,
    start: date,
    end: date,
    start_value: float,
    members: list[Member],
    select: Callable[[date], list[Member]],
) -> tuple[list[tuple[str, float, int]], list[tuple[date, list[Member]]]]:
    """Days (start, end] from a basket held since ``start`` at ``start_value``.
    Returns (daily rows, new baskets chosen on each 1st in (start, end]). A
    1st whose pick is too thin keeps the old basket."""
    daily: list[tuple[str, float, int]] = []
    baskets: list[tuple[date, list[Member]]] = []
    day, value = start, start_value
    while day < end:
        stop = min(first_of_next_month(day), end)
        series = price_lows._load_series(
            connection, {m.card_id: (m.source, m.variant) for m in members},
            start=day.isoformat(), end=stop.isoformat(),
        ) if members else {}
        series = {card_id: drop_spikes(points) for card_id, points in series.items()}
        for iso, level in chain_segment(members, series, start=day, end=stop, start_value=value):
            daily.append((iso, level, len(members)))
            value = level
        day = stop
        if day.day == 1:
            picked = select(day)
            if len(picked) >= MIN_BASKET_SIZE:
                members = picked
                baskets.append((day, picked))
    return daily, baskets


def _price_dates(connection: sqlite3.Connection) -> tuple[date, date] | None:
    if not _table_exists(connection, "card_price_history_daily"):
        return None
    row = connection.execute("SELECT MIN(price_date), MAX(price_date) FROM card_price_history_daily").fetchone()
    if row is None or not row[1]:
        return None
    return date.fromisoformat(str(row[0])[:10]), date.fromisoformat(str(row[1])[:10])


def _stored_run(connection: sqlite3.Connection, game: str) -> dict[str, Any] | None:
    row = connection.execute(
        "SELECT version, base_date, through_date FROM market_index_runs WHERE game = ?", (game,)
    ).fetchone()
    return None if row is None else {"version": row[0], "baseDate": row[1], "throughDate": row[2]}


def _resume_point(connection: sqlite3.Connection, game: str) -> tuple[date, float, list[Member]] | None:
    """(latest basket's selection day, the level that day, that basket)."""
    row = connection.execute(
        "SELECT month, selected_on FROM market_index_baskets WHERE game = ? ORDER BY selected_on DESC LIMIT 1",
        (game,),
    ).fetchone()
    if row is None:
        return None
    month, selected_on = row
    level = connection.execute(
        "SELECT value FROM market_index_daily WHERE game = ? AND date = ?", (game, selected_on)
    ).fetchone()
    if level is None:
        return None
    members = [
        Member(str(r[0]), str(r[1]), r[2], float(r[3]))
        for r in connection.execute(
            "SELECT card_id, source, variant, price_usd FROM market_index_baskets WHERE game = ? AND month = ? "
            "ORDER BY rank",
            (game, month),
        )
    ]
    return date.fromisoformat(selected_on), float(level[0]), members


def _start_days(base: date, end: date, *, after: date | None) -> list[date]:
    """Candidate base days: the history base, then every 1st up to ``end``
    (only those after ``after`` when earlier ones already came up empty)."""
    days = [base]
    day = first_of_next_month(base)
    while day <= end:
        days.append(day)
        day = first_of_next_month(day)
    return [d for d in days if after is None or d > after]


def _write_game(
    connection: sqlite3.Connection,
    game: str,
    *,
    keep_through: date | None,
    daily: list[tuple[str, float, int]],
    baskets: list[tuple[date, list[Member]]],
    run: dict[str, Any],
) -> None:
    with connection:
        if keep_through is None:
            connection.execute("DELETE FROM market_index_daily WHERE game = ?", (game,))
            connection.execute("DELETE FROM market_index_baskets WHERE game = ?", (game,))
        else:
            connection.execute(
                "DELETE FROM market_index_daily WHERE game = ? AND date > ?", (game, keep_through.isoformat())
            )
            connection.execute(
                "DELETE FROM market_index_baskets WHERE game = ? AND selected_on > ?", (game, keep_through.isoformat())
            )
        connection.executemany(
            "INSERT OR REPLACE INTO market_index_daily (game, date, value, basket_size) VALUES (?, ?, ?, ?)",
            [(game, iso, round(level, 6), size) for iso, level, size in daily],
        )
        connection.executemany(
            "INSERT OR REPLACE INTO market_index_baskets "
            "(game, month, selected_on, rank, card_id, source, variant, price_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (game, day.strftime("%Y-%m"), day.isoformat(), rank, m.card_id, m.source, m.variant, m.price)
                for day, members in baskets
                for rank, m in enumerate(members, start=1)
            ],
        )
        connection.execute(
            "INSERT INTO market_index_runs (game, version, base_date, through_date, computed_at, elapsed_ms) "
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(game) DO UPDATE SET version = excluded.version, "
            "base_date = excluded.base_date, through_date = excluded.through_date, "
            "computed_at = excluded.computed_at, elapsed_ms = excluded.elapsed_ms",
            (game, run["version"], run["baseDate"], run["throughDate"], utc_now(), run["elapsedMs"]),
        )


def refresh_market_index(
    connection: sqlite3.Connection,
    *,
    games: tuple[str, ...] = SUPPORTED_GAMES,
    force: bool = False,
) -> dict[str, Any]:
    """Backfill (first run / --force) or resume each game's index; no-op for a
    game whose stored run matches the current price version."""
    ensure_schema(connection)
    connection.commit()
    version = price_lows.price_lows_version_token(connection)
    span = _price_dates(connection)
    report: dict[str, Any] = {"version": version, "games": {}}
    if version is None or span is None:
        return report
    history_start, end = span
    base = max(history_start, end - timedelta(days=BACKFILL_DAYS))
    selector: _Selector | None = None
    for game in games:
        run = _stored_run(connection, game)
        if not force and run is not None and run["version"] == version:
            report["games"][game] = {"skipped": True}
            continue
        started = time.perf_counter()
        if selector is None:
            selector = _Selector(connection, eligible_cards(connection, games))

        def select(day: date, _game: str = game, _selector: _Selector = selector) -> list[Member]:
            return _selector.select(_game, day)

        resume = None if force else _resume_point(connection, game)
        if resume is not None and resume[0] > end:
            resume = None  # stored past the newest price date: rebuild
        baskets: list[tuple[date, list[Member]]] = []
        daily: list[tuple[str, float, int]] = []
        keep_through: date | None = None
        base_date: str | None = run["baseDate"] if run and resume is not None else None
        if resume is not None:
            keep_through, start_value, members = resume
            daily, baskets = compute_game(
                connection, start=keep_through, end=end, start_value=start_value, members=members, select=select
            )
        else:
            # A game with no stored index: base on the first day it has a basket.
            tried_through = (
                date.fromisoformat(run["throughDate"])
                if not force and run is not None and run["baseDate"] is None and run["throughDate"]
                else None
            )
            for start in _start_days(base, end, after=tried_through):
                members = select(start)
                if len(members) >= MIN_BASKET_SIZE:
                    base_date = start.isoformat()
                    baskets = [(start, members)]
                    daily = [(start.isoformat(), BASE_VALUE, len(members))]
                    more_daily, more_baskets = compute_game(
                        connection, start=start, end=end, start_value=BASE_VALUE, members=members, select=select
                    )
                    daily += more_daily
                    baskets += more_baskets
                    break
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        _write_game(
            connection, game, keep_through=keep_through, daily=daily, baskets=baskets,
            run={"version": version, "baseDate": base_date, "throughDate": end.isoformat(),
                 "elapsedMs": round(elapsed_ms, 1)},
        )
        report["games"][game] = {
            "baseDate": base_date,
            "throughDate": end.isoformat(),
            "days": len(daily),
            "baskets": len(baskets),
            "resumedFrom": keep_through.isoformat() if keep_through else None,
            "elapsedMs": round(elapsed_ms, 1),
        }
    return report


# --- request-path read -----------------------------------------------------------------


def index_payload(connection: sqlite3.Connection, game: str, window_days: int) -> dict[str, Any] | None:
    """``pulse.index`` for (game, window): the window's points (downsampled),
    level, change first->last point, range, basket size and last rebalance.
    None when the game has fewer than two stored days in the window."""
    if not _table_exists(connection, "market_index_daily"):
        return None
    row = connection.execute("SELECT MAX(date) FROM market_index_daily WHERE game = ?", (game,)).fetchone()
    if row is None or not row[0]:
        return None
    last = date.fromisoformat(str(row[0]))
    rows = connection.execute(
        "SELECT date, value, basket_size FROM market_index_daily WHERE game = ? AND date >= ? ORDER BY date",
        (game, (last - timedelta(days=window_days)).isoformat()),
    ).fetchall()
    if len(rows) < 2:
        return None
    values = [float(r[1]) for r in rows]
    first_value, last_value = values[0], values[-1]
    rebalanced = connection.execute(
        "SELECT MAX(selected_on) FROM market_index_baskets WHERE game = ? AND selected_on <= ?",
        (game, last.isoformat()),
    ).fetchone()
    from market_analytics import downsample  # market_analytics imports this module

    return {
        "name": f"{game_display_name(game)} Market Index",
        "points": downsample([{"date": str(r[0]), "value": round(float(r[1]), 2)} for r in rows], INDEX_POINTS),
        "value": round(last_value, 2),
        "changePct": round((last_value - first_value) / first_value * 100.0, 2) if first_value > 0 else None,
        "rangeLow": round(min(values), 2),
        "rangeHigh": round(max(values), 2),
        "basketSize": int(rows[-1][2]),
        "rebalancedOn": rebalanced[0] if rebalanced else None,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compute the per-game market index tables.")
    parser.add_argument("--compute", action="store_true", required=True)
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--game", action="append", choices=SUPPORTED_GAMES, help="Repeatable; default every game.")
    parser.add_argument("--force", action="store_true", help="Rebuild from the base day (drops stored rows).")
    args = parser.parse_args(argv)
    connection = connect(Path(args.database_path), timeout_seconds=30.0)
    games = tuple(args.game) if args.game else SUPPORTED_GAMES
    print(refresh_market_index(connection, games=games, force=args.force))
    return 0


if __name__ == "__main__":
    sys.exit(main())
