"""Raw 7-day price pairs for the feed blocks (Hot on Ekalight, Set spotlight).

Same pairing rules as ``market_movers`` (TCGCSV main lane first, Scrydex
default-raw fallback, same source + same printing at both ends, JPY converted
at today's rate), exposed per card instead of as a gainers ranking:

- ``raw_price_changes`` — indexed read for a known card-id list (a set, the
  hot list); safe at request time for a few hundred ids.
- ``raw_price_changes_all`` — the whole catalog via market_movers' date scan;
  scheduled jobs only.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Iterable

from catalog_tools import _table_columns
from fx_rates import convert_price
from market_movers import (
    DEFAULT_MAX_CHANGE_PCT,
    NOW_TOLERANCE_DAYS,
    THEN_TOLERANCE_DAYS,
    _as_float,
    _DailyRow,
    _jpy_usd_rate,
    _latest_row_per_card,
    _same_source_pair,
)

DEFAULT_WINDOW_DAYS = 7
_CHUNK = 900  # under SQLite's default variable limit


@dataclass(frozen=True)
class RawPrice:
    card_id: str
    price_now: float  # USD
    price_then: float | None  # USD, same source as price_now; None = no pair
    change_pct: float | None  # None = no like-for-like pair or a glitch-sized move
    now_date: str


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


def _now_price(row: _DailyRow, jpy_usd: Decimal | None) -> float | None:
    """Headline USD price of a single row: main lane, else Scrydex default."""
    if row.main_raw is not None:
        return row.main_raw
    if row.default_raw is None:
        return None
    if row.currency == "USD":
        return row.default_raw
    if row.currency == "JPY" and jpy_usd is not None:
        return convert_price(row.default_raw, rate=jpy_usd)
    return None


def _resolve(
    now_row: _DailyRow | None,
    then_row: _DailyRow | None,
    *,
    jpy_usd: Decimal | None,
    max_change_pct: float,
) -> RawPrice | None:
    if now_row is None:
        return None
    pair = _same_source_pair(then_row, now_row, jpy_usd=jpy_usd) if then_row is not None else None
    if pair is not None:
        _, _, price_then, price_now = pair
        pct = (price_now - price_then) / price_then * 100.0 if price_then > 0 else None
        if pct is not None and abs(pct) > max_change_pct:
            pct = None
        return RawPrice(now_row.card_id, price_now, price_then, pct, now_row.price_date)
    price_now = _now_price(now_row, jpy_usd)
    if price_now is None:
        return None
    return RawPrice(now_row.card_id, price_now, None, None, now_row.price_date)


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
    jpy_usd = _jpy_usd_rate(connection)

    now_rows: dict[str, _DailyRow] = {}
    then_rows: dict[str, _DailyRow] = {}
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
            # Rows arrive newest-first per card: the first hit in each band wins.
            if now_start <= daily.price_date <= now_end:
                now_rows.setdefault(daily.card_id, daily)
            elif then_start <= daily.price_date <= then_end:
                then_rows.setdefault(daily.card_id, daily)

    out: dict[str, RawPrice] = {}
    for card_id, now_row in now_rows.items():
        resolved = _resolve(now_row, then_rows.get(card_id), jpy_usd=jpy_usd, max_change_pct=max_change_pct)
        if resolved is not None:
            out[card_id] = resolved
    return out


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
    now_rows = _latest_row_per_card(
        connection, start=now_start, end=now_end, has_main_column=has_main,
        has_main_variant_column=has_variant, expected_cards=card_count or None,
    )
    then_rows = _latest_row_per_card(
        connection, start=then_start, end=then_end, has_main_column=has_main,
        has_main_variant_column=has_variant, expected_cards=len(now_rows) or None,
    )
    jpy_usd = _jpy_usd_rate(connection)
    out: dict[str, RawPrice] = {}
    for card_id, now_row in now_rows.items():
        resolved = _resolve(now_row, then_rows.get(card_id), jpy_usd=jpy_usd, max_change_pct=max_change_pct)
        if resolved is not None:
            out[card_id] = resolved
    return out


def round_money(value: float | None) -> float | None:
    return None if value is None else round(float(value), 2)


def round_pct(value: float | None) -> float | None:
    return None if value is None else round(float(value), 1)


def as_dict(price: RawPrice | None) -> dict[str, Any]:
    if price is None:
        return {"priceNow": None, "changePercent7d": None}
    return {"priceNow": round_money(price.price_now), "changePercent7d": round_pct(price.change_pct)}
