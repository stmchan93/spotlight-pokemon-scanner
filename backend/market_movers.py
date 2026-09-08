"""Catalog-wide "Top Trends": the biggest raw-price gainers per game over a
window, computed from ``card_price_history_daily``.

Pure functions over a sqlite connection (no service state) so the ranking is
unit-testable with an in-memory catalog. The service layer caches the payload
per version token (``market_movers_version_token``) and dogpile-guards the
recompute; see ``SpotlightScanService.market_top_movers``.

Guardrails, all deliberate:
- "then" and "now" must come from the SAME price source: both TCGCSV main-lane
  (always USD) or both Scrydex default-raw in the same display currency. Mixing
  a Scrydex-JPY→USD "then" with a TCGCSV "now" manufactures phantom moves.
- price NOW must be >= ``min_price_usd`` (penny cards produce absurd %).
- gainers only; a change above ``max_change_pct`` is treated as a data glitch.
- the 30-day series must contain >= ``min_distinct_prices`` distinct values —
  Scrydex's raw-JP anchors are flat single values that occasionally jump, and
  this is what keeps them out of the list without any per-card denylist.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from catalog_tools import (
    SUPPORTED_GAMES,
    _table_columns,
    fx_rate_snapshot_for_pair,
    runtime_setting,
    utc_now,
)
from fx_rates import convert_price

DEFAULT_WINDOW_DAYS = 30
# "now" may be a few days stale (a missed sync); "then" tolerates a week-wide
# gap so weekend/holiday holes in the history don't empty the list.
NOW_TOLERANCE_DAYS = 3
THEN_TOLERANCE_DAYS = 7
DEFAULT_PER_GAME = 5
DEFAULT_MIN_PRICE_USD = 5.0
DEFAULT_MAX_CHANGE_PCT = 1000.0
MIN_DISTINCT_PRICES = 3
SPARKLINE_POINTS = 30
# The series-based noise filter is applied in batches down the ranked list
# until ``per_game`` survive: the very top of a raw ranking is dense with
# flat-anchor jumps (measured on prod 2026-09-08: 14 of the top 15 Pokémon
# candidates had exactly two distinct prices), so a fixed overfetch starves.
CANDIDATE_BATCH = 25
CANDIDATE_MAX_EXAMINED = 300

SOURCE_MAIN_RAW = "main_raw"
SOURCE_DEFAULT_RAW = "default_raw"


@dataclass(frozen=True)
class _DailyRow:
    card_id: str
    price_date: str
    currency: str
    default_raw: float | None
    main_raw: float | None


@dataclass(frozen=True)
class Candidate:
    card_id: str
    game: str
    source: str
    currency: str  # source currency of the pair (USD or JPY)
    price_then: float  # USD
    price_now: float  # USD
    then_date: str
    now_date: str
    change_pct: float = 0.0


def market_movers_version_token(
    connection: sqlite3.Connection, *, window_days: int = DEFAULT_WINDOW_DAYS
) -> str | None:
    """Fingerprint of everything the payload depends on: the newest price
    date plus the pricing sync generation (a TCGCSV re-sync of the same day
    changes prices without moving MAX(price_date))."""
    try:
        row = connection.execute("SELECT MAX(price_date) FROM card_price_history_daily").fetchone()
    except sqlite3.Error:
        return None
    max_date = row[0] if row is not None else None
    if not max_date:
        return None
    generation = "0"
    try:
        setting = runtime_setting(connection, "pricing_sync_generation")
        if setting is not None and setting.get("value") not in (None, {}):
            generation = str(setting["value"])
    except sqlite3.Error:
        generation = "0"
    return f"{max_date}|psg:{generation}|w:{window_days}"


def _iso(value: date) -> str:
    return value.isoformat()


def _dates_in_window(connection: sqlite3.Connection, start: str, end: str) -> list[str]:
    rows = connection.execute(
        "SELECT DISTINCT price_date FROM card_price_history_daily "
        "WHERE price_date BETWEEN ? AND ? ORDER BY price_date DESC",
        (start, end),
    ).fetchall()
    return [str(row[0]) for row in rows]


def _latest_row_per_card(
    connection: sqlite3.Connection,
    *,
    start: str,
    end: str,
    has_main_column: bool,
    expected_cards: int | None = None,
) -> dict[str, _DailyRow]:
    """Newest daily row per card within [start, end]. Reads one price_date at a
    time newest-first (an index-prefix search) and stops as soon as every
    expected card is resolved — the sync writes nearly every card every day,
    so this is usually a single date's worth of rows."""
    main_col = "main_raw_market_price" if has_main_column else "NULL"
    out: dict[str, _DailyRow] = {}
    for price_date in _dates_in_window(connection, start, end):
        rows = connection.execute(
            "SELECT card_id, price_date, display_currency_code, "
            f"default_raw_market_price, {main_col} "
            "FROM card_price_history_daily WHERE price_date = ?",
            (price_date,),
        ).fetchall()
        for row in rows:
            card_id = str(row[0])
            if card_id in out:
                continue
            out[card_id] = _DailyRow(
                card_id=card_id,
                price_date=str(row[1]),
                currency=str(row[2] or "USD").upper(),
                default_raw=_as_float(row[3]),
                main_raw=_as_float(row[4]),
            )
        if expected_cards is not None and len(out) >= expected_cards:
            break
    return out


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _jpy_usd_rate(connection: sqlite3.Connection) -> Decimal | None:
    try:
        snapshot = fx_rate_snapshot_for_pair(connection, "JPY", "USD")
    except sqlite3.Error:
        return None
    if snapshot is None or snapshot.get("rate") in (None, 0):
        return None
    return Decimal(str(snapshot["rate"]))


def _same_source_pair(
    then_row: _DailyRow, now_row: _DailyRow, *, jpy_usd: Decimal | None
) -> tuple[str, str, float, float] | None:
    """(source, currency, price_then_usd, price_now_usd) or None when the two
    ends can't be compared like-for-like."""
    if then_row.main_raw is not None and now_row.main_raw is not None:
        return SOURCE_MAIN_RAW, "USD", then_row.main_raw, now_row.main_raw
    if (
        then_row.default_raw is not None
        and now_row.default_raw is not None
        and then_row.currency == now_row.currency
    ):
        if then_row.currency == "USD":
            return SOURCE_DEFAULT_RAW, "USD", then_row.default_raw, now_row.default_raw
        if then_row.currency == "JPY" and jpy_usd is not None:
            then_usd = convert_price(then_row.default_raw, rate=jpy_usd)
            now_usd = convert_price(now_row.default_raw, rate=jpy_usd)
            if then_usd is not None and now_usd is not None:
                return SOURCE_DEFAULT_RAW, "JPY", then_usd, now_usd
    return None


def rank_candidates(
    candidates: list[Candidate],
    *,
    min_price_usd: float = DEFAULT_MIN_PRICE_USD,
    max_change_pct: float = DEFAULT_MAX_CHANGE_PCT,
    limit: int = CANDIDATE_MAX_EXAMINED,
) -> dict[str, list[Candidate]]:
    """Eligible gainers per game, best first, capped at ``limit`` per game —
    the pool the series filter walks."""
    by_game: dict[str, list[Candidate]] = {game: [] for game in SUPPORTED_GAMES}
    for candidate in candidates:
        if candidate.game not in by_game:
            continue
        if candidate.price_then <= 0 or candidate.price_now < min_price_usd:
            continue
        pct = (candidate.price_now - candidate.price_then) / candidate.price_then * 100.0
        if pct <= 0 or pct > max_change_pct:
            continue
        by_game[candidate.game].append(replace(candidate, change_pct=pct))
    return {
        game: sorted(rows, key=lambda c: (-c.change_pct, c.card_id))[:limit]
        for game, rows in by_game.items()
    }


def downsample_series(values: list[float], target: int = SPARKLINE_POINTS) -> list[float]:
    """Evenly spaced thinning that always keeps the first and last point."""
    count = len(values)
    if count <= target:
        return [round(float(v), 2) for v in values]
    indices = sorted({round(i * (count - 1) / (target - 1)) for i in range(target)})
    return [round(float(values[i]), 2) for i in indices]


def _series_for_candidates(
    connection: sqlite3.Connection,
    candidates: list[Candidate],
    *,
    start: str,
    end: str,
    has_main_column: bool,
    jpy_usd: Decimal | None,
) -> dict[str, list[float]]:
    """USD daily series (oldest→newest) per candidate, read from the SAME
    source column and currency the pair was built from."""
    if not candidates:
        return {}
    by_id = {c.card_id: c for c in candidates}
    placeholders = ",".join("?" for _ in by_id)
    main_col = "main_raw_market_price" if has_main_column else "NULL"
    rows = connection.execute(
        "SELECT card_id, price_date, display_currency_code, "
        f"default_raw_market_price, {main_col} "
        "FROM card_price_history_daily "
        f"WHERE card_id IN ({placeholders}) AND price_date BETWEEN ? AND ? "
        "ORDER BY card_id, price_date ASC",
        (*by_id.keys(), start, end),
    ).fetchall()
    series: dict[str, list[float]] = {card_id: [] for card_id in by_id}
    for row in rows:
        card_id = str(row[0])
        candidate = by_id[card_id]
        if candidate.source == SOURCE_MAIN_RAW:
            value = _as_float(row[4])
        else:
            if str(row[2] or "USD").upper() != candidate.currency:
                continue
            value = _as_float(row[3])
            if value is not None and candidate.currency == "JPY":
                value = convert_price(value, rate=jpy_usd) if jpy_usd is not None else None
        if value is not None:
            series[card_id].append(value)
    return series


def _card_metadata(connection: sqlite3.Connection, card_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not card_ids:
        return {}
    placeholders = ",".join("?" for _ in card_ids)
    game_col = "c.game" if "game" in _table_columns(connection, "cards") else "'pokemon'"
    rows = connection.execute(
        f"SELECT c.id, {game_col}, c.name, c.number, c.set_name, c.language, c.image_small_url, "
        "COALESCE(e.code, c.set_ptcgo_code) AS set_code "
        "FROM cards c LEFT JOIN expansions e ON e.id = c.set_id "
        f"WHERE c.id IN ({placeholders})",
        tuple(card_ids),
    ).fetchall()
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        out[str(row[0])] = {
            "game": row[1],
            "name": row[2],
            "number": row[3],
            "setName": row[4],
            "language": row[5],
            "imageUrl": row[6],
            "setCode": row[7],
        }
    return out


def _card_games(connection: sqlite3.Connection, card_ids: list[str]) -> dict[str, str]:
    """{card_id: game} for the cards that have a "now" price. One chunked read
    over the primary key instead of joining cards into the 45k-row date scan."""
    out: dict[str, str] = {}
    if "game" not in _table_columns(connection, "cards"):
        # Pre-multi-game catalog: everything is Pokémon.
        return {card_id: "pokemon" for card_id in card_ids}
    chunk = 900  # under SQLite's default variable limit
    for start in range(0, len(card_ids), chunk):
        ids = card_ids[start : start + chunk]
        placeholders = ",".join("?" for _ in ids)
        for row in connection.execute(
            f"SELECT id, game FROM cards WHERE id IN ({placeholders})", tuple(ids)
        ):
            out[str(row[0])] = str(row[1] or "pokemon")
    return out


def compute_top_movers(
    connection: sqlite3.Connection,
    *,
    window_days: int = DEFAULT_WINDOW_DAYS,
    today: date | None = None,
    per_game: int = DEFAULT_PER_GAME,
    min_price_usd: float = DEFAULT_MIN_PRICE_USD,
    max_change_pct: float = DEFAULT_MAX_CHANGE_PCT,
) -> dict[str, Any]:
    today = today or datetime.now(timezone.utc).date()
    empty = {
        "windowDays": window_days,
        "computedAt": utc_now(),
        "asOfDate": None,
        "games": [{"game": game, "items": []} for game in SUPPORTED_GAMES],
    }
    row = connection.execute("SELECT MAX(price_date) FROM card_price_history_daily").fetchone()
    max_date_raw = row[0] if row is not None else None
    if not max_date_raw:
        return empty
    try:
        ref_date = date.fromisoformat(str(max_date_raw)[:10])
    except ValueError:
        return empty
    empty["asOfDate"] = _iso(ref_date)
    if (today - ref_date).days > NOW_TOLERANCE_DAYS:
        # The sync is stale; a "now" that is a week old is not a trend.
        return empty

    has_main_column = "main_raw_market_price" in _table_columns(connection, "card_price_history_daily")
    jpy_usd = _jpy_usd_rate(connection)

    # Bound the "now" read too: once every catalog card has a row there is
    # nothing older dates can add (saves 3 more 45k-row reads on a cold disk).
    card_count = int(connection.execute("SELECT COUNT(*) FROM cards").fetchone()[0] or 0)
    now_rows = _latest_row_per_card(
        connection,
        start=_iso(ref_date - timedelta(days=NOW_TOLERANCE_DAYS)),
        end=_iso(ref_date),
        has_main_column=has_main_column,
        expected_cards=card_count or None,
    )
    then_end = ref_date - timedelta(days=window_days)
    then_rows = _latest_row_per_card(
        connection,
        start=_iso(then_end - timedelta(days=THEN_TOLERANCE_DAYS)),
        end=_iso(then_end),
        has_main_column=has_main_column,
        expected_cards=len(now_rows),
    )
    games = _card_games(connection, list(now_rows.keys()))

    candidates: list[Candidate] = []
    for card_id, now_row in now_rows.items():
        then_row = then_rows.get(card_id)
        if then_row is None:
            continue
        pair = _same_source_pair(then_row, now_row, jpy_usd=jpy_usd)
        if pair is None:
            continue
        source, currency, price_then, price_now = pair
        candidates.append(
            Candidate(
                card_id=card_id,
                game=games.get(card_id, "pokemon"),
                source=source,
                currency=currency,
                price_then=price_then,
                price_now=price_now,
                then_date=then_row.price_date,
                now_date=now_row.price_date,
            )
        )

    ranked = rank_candidates(candidates, min_price_usd=min_price_usd, max_change_pct=max_change_pct)
    series_start = _iso(then_end - timedelta(days=THEN_TOLERANCE_DAYS))
    series: dict[str, list[float]] = {}
    winners: dict[str, list[Candidate]] = {}
    for game, rows in ranked.items():
        kept: list[Candidate] = []
        for offset in range(0, len(rows), CANDIDATE_BATCH):
            batch = rows[offset : offset + CANDIDATE_BATCH]
            series.update(
                _series_for_candidates(
                    connection, batch, start=series_start, end=_iso(ref_date),
                    has_main_column=has_main_column, jpy_usd=jpy_usd,
                )
            )
            for candidate in batch:
                points = series.get(candidate.card_id) or []
                if len({round(p, 2) for p in points}) < MIN_DISTINCT_PRICES:
                    continue
                kept.append(candidate)
                if len(kept) >= per_game:
                    break
            if len(kept) >= per_game:
                break
        winners[game] = kept

    metadata = _card_metadata(connection, [c.card_id for rows in winners.values() for c in rows])
    payload_games: list[dict[str, Any]] = []
    for game in SUPPORTED_GAMES:
        items: list[dict[str, Any]] = []
        for candidate in winners.get(game, []):
            meta = metadata.get(candidate.card_id)
            if meta is None:
                continue
            items.append(
                {
                    "cardId": candidate.card_id,
                    "game": game,
                    "name": meta["name"],
                    "number": meta["number"],
                    "setCode": meta["setCode"],
                    "setName": meta["setName"],
                    "language": meta["language"],
                    "imageUrl": meta["imageUrl"],
                    "priceNow": round(candidate.price_now, 2),
                    "priceThen": round(candidate.price_then, 2),
                    "changePercent": round(candidate.change_pct, 1),
                    "currencyCode": "USD",
                    "sparkPoints": downsample_series(series.get(candidate.card_id) or []),
                    "source": candidate.source,
                    "thenDate": candidate.then_date,
                    "nowDate": candidate.now_date,
                }
            )
        payload_games.append({"game": game, "items": items})

    return {
        "windowDays": window_days,
        "computedAt": utc_now(),
        "asOfDate": _iso(ref_date),
        "games": payload_games,
    }
