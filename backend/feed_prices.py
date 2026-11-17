"""Raw 7-day price pairs for the feed blocks (Hot on Ekalight, Set spotlight).

Same pairing rules as ``market_movers``, exposed per card instead of as a
gainers ranking: the TCGCSV main lane (USD) wins whenever a card has one,
resolved per source (the Scrydex sync can write a newer row without main_raw);
Scrydex default-raw is a fallback for non-Japanese cards stored in USD only —
never JPY, never a JP anchor labelled USD. A % change whose series has a
single-step jump above ``MAX_STEP_MULTIPLE`` is hidden (change_pct None).

- ``raw_price_changes`` — indexed read for a known card-id list (a set, the
  hot list); safe at request time for a few hundred ids.
- ``raw_price_changes_all`` — the whole catalog via market_movers' date scan;
  scheduled jobs only.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, replace
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Iterable

from catalog_tools import _table_columns
from market_movers import (
    DEFAULT_MAX_CHANGE_PCT,
    NOW_TOLERANCE_DAYS,
    SOURCE_DEFAULT_RAW,
    SOURCE_MAIN_RAW,
    THEN_TOLERANCE_DAYS,
    _as_float,
    _DailyRow,
    _is_japanese,
    _latest_rows_per_card,
    outlier_step_card_ids,
)

DEFAULT_WINDOW_DAYS = 7
_CHUNK = 900  # under SQLite's default variable limit
# Only moves at least this big can hide a >3x single step that didn't revert.
STEP_CHECK_MIN_PCT = 25.0


@dataclass(frozen=True)
class RawPrice:
    card_id: str
    price_now: float  # USD
    price_then: float | None  # USD, same source as price_now; None = no pair
    change_pct: float | None  # None = no like-for-like pair or a glitch-sized move
    now_date: str
    source: str | None = None
    variant: str | None = None


def latest_price_date(connection: sqlite3.Connection) -> date | None:
    try:
        row = connection.execute("SELECT MAX(price_date) FROM card_price_history_daily").fetchone()
    except sqlite3.Error:
        return None
    if row is None or not row[0]:
        return None
    try:
        return date.fromisoformat(str(row[0])[:10])
    except ValueError:
        return None


def _now_price(row: _DailyRow, jpy_usd: Decimal | None = None, *, japanese: bool | None = None) -> float | None:
    """Headline USD price of a single row: main lane, else Scrydex default in
    USD for a non-Japanese card. Never JPY."""
    if row.main_raw is not None:
        return row.main_raw
    if japanese is None:
        japanese = _is_japanese(row.card_id, None)
    if japanese or row.default_raw is None or row.currency != "USD":
        return None
    return row.default_raw


def _pct(price_then: float, price_now: float, max_change_pct: float) -> float | None:
    if price_then <= 0:
        return None
    pct = (price_now - price_then) / price_then * 100.0
    return None if abs(pct) > max_change_pct else pct


def _resolve(
    now_row: _DailyRow | None,
    then_row: _DailyRow | None,
    *,
    jpy_usd: Decimal | None = None,
    max_change_pct: float,
    now_main: _DailyRow | None = None,
    then_main: _DailyRow | None = None,
    japanese: bool | None = None,
) -> RawPrice | None:
    """``now_main``/``then_main`` are the newest rows WITH a main_raw price per
    band; without them the plain rows stand in. ``jpy_usd`` is unused (kept
    for callers): JPY is never shown."""
    if now_main is None and now_row is not None and now_row.main_raw is not None:
        now_main = now_row
    if then_main is None and then_row is not None and then_row.main_raw is not None:
        then_main = then_row
    if now_main is not None:
        price_now = now_main.main_raw
        if then_main is not None and then_main.main_variant == now_main.main_variant:
            return RawPrice(
                now_main.card_id, price_now, then_main.main_raw,
                _pct(then_main.main_raw, price_now, max_change_pct), now_main.price_date,
                SOURCE_MAIN_RAW, now_main.main_variant,
            )
        return RawPrice(now_main.card_id, price_now, None, None, now_main.price_date,
                        SOURCE_MAIN_RAW, now_main.main_variant)
    if now_row is None:
        return None
    if japanese is None:
        japanese = _is_japanese(now_row.card_id, None)
    price_now = _now_price(now_row, japanese=japanese)
    if price_now is None:
        return None
    if then_row is not None and _now_price(then_row, japanese=japanese) is not None:
        return RawPrice(
            now_row.card_id, price_now, then_row.default_raw,
            _pct(then_row.default_raw, price_now, max_change_pct), now_row.price_date,
            SOURCE_DEFAULT_RAW,
        )
    return RawPrice(now_row.card_id, price_now, None, None, now_row.price_date, SOURCE_DEFAULT_RAW)


def _japanese_ids(connection: sqlite3.Connection, card_ids: Iterable[str]) -> set[str]:
    ids = list(card_ids)
    out: set[str] = set()
    for offset in range(0, len(ids), _CHUNK):
        chunk = ids[offset : offset + _CHUNK]
        for card_id, language in connection.execute(
            f"SELECT id, language FROM cards WHERE id IN ({','.join('?' for _ in chunk)})", tuple(chunk)
        ):
            if _is_japanese(str(card_id), language):
                out.add(str(card_id))
    return {c for c in ids if c in out or _is_japanese(c, None)}


def _hide_outlier_moves(
    connection: sqlite3.Connection, prices: dict[str, RawPrice], *, start: str, end: str
) -> dict[str, RawPrice]:
    """Null the % of any big move whose series jumps >MAX_STEP_MULTIPLE in one step."""
    specs = {
        card_id: (p.source or SOURCE_DEFAULT_RAW, p.variant)
        for card_id, p in prices.items()
        if p.change_pct is not None and abs(p.change_pct) >= STEP_CHECK_MIN_PCT
    }
    for card_id in outlier_step_card_ids(connection, specs, start=start, end=end):
        prices[card_id] = replace(prices[card_id], price_then=None, change_pct=None)
    return prices


def _window_bounds(ref_date: date, window_days: int) -> tuple[str, str, str, str]:
    then_end = ref_date - timedelta(days=window_days)
    return (
        (ref_date - timedelta(days=NOW_TOLERANCE_DAYS)).isoformat(),
        ref_date.isoformat(),
        (then_end - timedelta(days=THEN_TOLERANCE_DAYS)).isoformat(),
        then_end.isoformat(),
    )


def raw_price_changes(
    connection: sqlite3.Connection,
    card_ids: Iterable[str],
    *,
    ref_date: date | None = None,
    window_days: int = DEFAULT_WINDOW_DAYS,
    max_change_pct: float = DEFAULT_MAX_CHANGE_PCT,
) -> dict[str, RawPrice]:
    """{card_id: RawPrice} for cards with a "now" price, via the
    (card_id, price_date) history index — never a date-wide scan."""
    ids = list(dict.fromkeys(str(c) for c in card_ids if c))
    ref_date = ref_date or latest_price_date(connection)
    if not ids or ref_date is None:
        return {}
    columns = _table_columns(connection, "card_price_history_daily")
    main_col = "main_raw_market_price" if "main_raw_market_price" in columns else "NULL"
    variant_col = "main_raw_variant" if "main_raw_variant" in columns else "NULL"
    now_start, now_end, then_start, then_end = _window_bounds(ref_date, window_days)

    now_rows: dict[str, _DailyRow] = {}
    then_rows: dict[str, _DailyRow] = {}
    now_main: dict[str, _DailyRow] = {}
    then_main: dict[str, _DailyRow] = {}
    for offset in range(0, len(ids), _CHUNK):
        chunk = ids[offset : offset + _CHUNK]
        placeholders = ",".join("?" for _ in chunk)
        rows = connection.execute(
            "SELECT card_id, price_date, display_currency_code, "
            f"default_raw_market_price, {main_col}, {variant_col} "
            "FROM card_price_history_daily "
            f"WHERE card_id IN ({placeholders}) AND price_date BETWEEN ? AND ? "
            "ORDER BY card_id, price_date DESC",
            (*chunk, then_start, now_end),
        ).fetchall()
        for row in rows:
            daily = _DailyRow(
                card_id=str(row[0]),
                price_date=str(row[1]),
                currency=str(row[2] or "USD").upper(),
                default_raw=_as_float(row[3]),
                main_raw=_as_float(row[4]),
                main_variant=row[5],
            )
            # Rows arrive newest-first per card: the first hit per band and source wins.
            if now_start <= daily.price_date <= now_end:
                band, band_main = now_rows, now_main
            elif then_start <= daily.price_date <= then_end:
                band, band_main = then_rows, then_main
            else:
                continue
            band.setdefault(daily.card_id, daily)
            if daily.main_raw is not None:
                band_main.setdefault(daily.card_id, daily)

    return _finish(
        connection, now_rows, then_rows, now_main, then_main,
        max_change_pct=max_change_pct, start=then_start, end=now_end,
    )


def _finish(
    connection: sqlite3.Connection,
    now_rows: dict[str, _DailyRow],
    then_rows: dict[str, _DailyRow],
    now_main: dict[str, _DailyRow],
    then_main: dict[str, _DailyRow],
    *,
    max_change_pct: float,
    start: str,
    end: str,
) -> dict[str, RawPrice]:
    japanese = _japanese_ids(connection, now_rows)
    out: dict[str, RawPrice] = {}
    for card_id, now_row in now_rows.items():
        resolved = _resolve(
            now_row, then_rows.get(card_id), max_change_pct=max_change_pct,
            now_main=now_main.get(card_id), then_main=then_main.get(card_id),
            japanese=card_id in japanese,
        )
        if resolved is not None:
            out[card_id] = resolved
    return _hide_outlier_moves(connection, out, start=start, end=end)


def raw_price_changes_all(
    connection: sqlite3.Connection,
    *,
    ref_date: date | None = None,
    window_days: int = DEFAULT_WINDOW_DAYS,
    max_change_pct: float = DEFAULT_MAX_CHANGE_PCT,
) -> dict[str, RawPrice]:
    """Whole-catalog variant for scheduled jobs (market_movers' date scan)."""
    ref_date = ref_date or latest_price_date(connection)
    if ref_date is None:
        return {}
    columns = _table_columns(connection, "card_price_history_daily")
    has_main = "main_raw_market_price" in columns
    has_variant = "main_raw_variant" in columns
    now_start, now_end, then_start, then_end = _window_bounds(ref_date, window_days)
    card_count = int(connection.execute("SELECT COUNT(*) FROM cards").fetchone()[0] or 0)
    now_rows, now_main = _latest_rows_per_card(
        connection, start=now_start, end=now_end, has_main_column=has_main,
        has_main_variant_column=has_variant, expected_cards=card_count or None,
    )
    then_rows, then_main = _latest_rows_per_card(
        connection, start=then_start, end=then_end, has_main_column=has_main,
        has_main_variant_column=has_variant, expected_cards=len(now_main) or None,
    )
    return _finish(
        connection, now_rows, then_rows, now_main, then_main,
        max_change_pct=max_change_pct, start=then_start, end=now_end,
    )


def round_money(value: float | None) -> float | None:
    return None if value is None else round(float(value), 2)


def round_pct(value: float | None) -> float | None:
    return None if value is None else round(float(value), 1)


def as_dict(price: RawPrice | None) -> dict[str, Any]:
    if price is None:
        return {"priceNow": None, "changePercent7d": None}
    return {"priceNow": round_money(price.price_now), "changePercent7d": round_pct(price.change_pct)}
