"""Biggest price movers inside a scope (a set, a rarity, a name, the user's
cards) over 7d/30d/90d/1y, computed on the fly from ``card_price_history_daily``
for the ``find_movers`` tool. DB-only.

Same guardrails as ``market_movers`` / ``price_lows``, applied per card:
- one USD source: the TCGCSV main lane when the card has a main price "now",
  else Scrydex default-raw for non-Japanese USD rows. Scrydex raw-JP values are
  JPY anchors and are never used, so Japanese cards only move on TCGplayer USD.
- one printing: only rows with the current ``main_raw_variant`` count. A
  variant re-point leaves the old printing's rows out, so its series starts
  later (``covers_full_window`` false) instead of reading as a move.
- start AND end >= ``min_price_usd`` (penny cards make absurd %).
- >= ``MIN_DISTINCT_PRICES`` distinct values, no day-to-day step above
  ``MAX_STEP_MULTIPLE``, and no change above ``MAX_CHANGE_PCT`` (glitches).
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from market_movers import (
    DEFAULT_MAX_CHANGE_PCT,
    MAX_STEP_MULTIPLE,
    MIN_DISTINCT_PRICES,
    NOW_TOLERANCE_DAYS,
    SOURCE_DEFAULT_RAW,
    SOURCE_MAIN_RAW,
    _as_float,
    _is_japanese,
    has_outlier_step,
)
from catalog_tools import _table_columns

WINDOWS = {"7d": 7, "30d": 30, "90d": 90, "1y": 365}
# A first point this close to the window start counts as covering the window.
START_TOLERANCE_DAYS = {7: 2, 30: 7, 90: 14, 365: 30}
MIN_PRICE_USD = 3.0
MAX_SCANNED_CARDS = 2000
SQL_CHUNK = 900


@dataclass(frozen=True)
class Move:
    card_id: str
    source: str
    variant: str | None
    start_usd: float
    end_usd: float
    start_date: str
    end_date: str
    days_covered: int
    covers_full_window: bool

    @property
    def change_usd(self) -> float:
        return self.end_usd - self.start_usd

    @property
    def change_pct(self) -> float:
        return (self.end_usd - self.start_usd) / self.start_usd * 100.0


def newest_price_date(connection: sqlite3.Connection) -> date | None:
    row = connection.execute("SELECT MAX(price_date) FROM card_price_history_daily").fetchone()
    if row is None or not row[0]:
        return None
    try:
        return date.fromisoformat(str(row[0])[:10])
    except ValueError:
        return None


def min_days_covered(window_days: int) -> int:
    """Shorter history than this is not a move over the window at all."""
    return max(3, min(window_days // 2, 14))


def _load_rows(
    connection: sqlite3.Connection, card_ids: list[str], *, start: str, end: str
) -> dict[str, list[tuple[str, str, float | None, float | None, str | None]]]:
    """(date, currency, default_raw, main_raw, main_variant) per card, oldest
    first. Indexed per-card reads (card_id, price_date)."""
    columns = _table_columns(connection, "card_price_history_daily")
    main_col = "main_raw_market_price" if "main_raw_market_price" in columns else "NULL"
    variant_col = "main_raw_variant" if "main_raw_variant" in columns else "NULL"
    out: dict[str, list[tuple[str, str, float | None, float | None, str | None]]] = {}
    for offset in range(0, len(card_ids), SQL_CHUNK):
        chunk = card_ids[offset : offset + SQL_CHUNK]
        rows = connection.execute(
            "SELECT card_id, price_date, display_currency_code, default_raw_market_price, "
            f"{main_col}, {variant_col} FROM card_price_history_daily "
            f"WHERE card_id IN ({','.join('?' for _ in chunk)}) AND price_date BETWEEN ? AND ? "
            "ORDER BY card_id, price_date ASC",
            (*chunk, start, end),
        ).fetchall()
        for card_id, price_date, currency, default_raw, main_raw, variant in rows:
            out.setdefault(str(card_id), []).append(
                (str(price_date)[:10], str(currency or "USD").upper(), _as_float(default_raw), _as_float(main_raw), variant)
            )
    return out


def card_move(
    card_id: str,
    language: str | None,
    rows: list[tuple[str, str, float | None, float | None, str | None]],
    *,
    window_days: int,
    ref_date: date,
    min_price_usd: float = MIN_PRICE_USD,
    max_change_pct: float = DEFAULT_MAX_CHANGE_PCT,
) -> Move | None:
    """The card's guarded move over the window, or None when it can't be
    compared like-for-like in USD."""
    now_floor = (ref_date - timedelta(days=NOW_TOLERANCE_DAYS)).isoformat()
    recent = [row for row in rows if row[0] >= now_floor]
    if not recent:
        return None
    now_main = next((row for row in reversed(recent) if row[3] is not None), None)
    if now_main is not None:
        source, variant = SOURCE_MAIN_RAW, now_main[4]
        series = [(row[0], row[3]) for row in rows if row[3] is not None and row[4] == variant and row[0] <= now_main[0]]
    else:
        newest = recent[-1]
        if _is_japanese(card_id, language) or newest[1] != "USD" or newest[2] is None:
            return None
        source, variant = SOURCE_DEFAULT_RAW, None
        series = [(row[0], row[2]) for row in rows if row[1] == "USD" and row[2] is not None and row[0] <= newest[0]]
    if len(series) < 2:
        return None
    values = [value for _, value in series]
    if len({round(v, 2) for v in values}) < MIN_DISTINCT_PRICES or has_outlier_step(values, max_multiple=MAX_STEP_MULTIPLE):
        return None
    (start_day, start_usd), (end_day, end_usd) = series[0], series[-1]
    if start_usd < min_price_usd or end_usd < min_price_usd:
        return None
    days_covered = (date.fromisoformat(end_day) - date.fromisoformat(start_day)).days
    if days_covered < min_days_covered(window_days):
        return None
    if abs((end_usd - start_usd) / start_usd * 100.0) > max_change_pct:
        return None
    window_start = ref_date - timedelta(days=window_days)
    covers = date.fromisoformat(start_day) <= window_start + timedelta(days=START_TOLERANCE_DAYS.get(window_days, 7))
    return Move(card_id, source, variant, start_usd, end_usd, start_day, end_day, days_covered, covers)


def compute_moves(
    connection: sqlite3.Connection,
    cards: dict[str, str | None],
    *,
    window_days: int,
    ref_date: date,
    min_price_usd: float = MIN_PRICE_USD,
) -> list[Move]:
    """Guarded moves for ``cards`` (card_id -> language), unranked."""
    if not cards:
        return []
    start = (ref_date - timedelta(days=window_days)).isoformat()
    rows = _load_rows(connection, sorted(cards), start=start, end=ref_date.isoformat())
    moves: list[Move] = []
    for card_id, language in cards.items():
        move = card_move(
            card_id, language, rows.get(card_id) or [], window_days=window_days, ref_date=ref_date,
            min_price_usd=min_price_usd,
        )
        if move is not None and round(move.change_usd, 2) != 0:
            moves.append(move)
    return moves


def rank_moves(moves: list[Move], *, direction: str, by: str = "pct") -> list[Move]:
    """Gainers ('up') or decliners ('down'), biggest first by % or by dollars."""
    sign = 1.0 if direction == "up" else -1.0
    picked = [move for move in moves if move.change_usd * sign > 0]

    def key(move: Move) -> tuple[Any, ...]:
        primary = move.change_pct if by == "pct" else move.change_usd
        return (-round(primary * sign, 4), -move.end_usd, move.card_id)

    return sorted(picked, key=key)
