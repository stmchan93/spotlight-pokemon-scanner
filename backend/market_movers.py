"""Catalog-wide "Top Trends": the biggest raw-price gainers per game over a
window, computed from ``card_price_history_daily``.

Pure functions over a sqlite connection (no service state) so the ranking is
unit-testable with an in-memory catalog. The service layer caches the payload
per version token (``market_movers_version_token``) and dogpile-guards the
recompute; see ``SpotlightScanService.market_top_movers``.

Guardrails, all deliberate:
- "then" and "now" must come from the SAME price source. A card with a
  TCGCSV main-lane (USD) price "now" is ranked on that lane only, resolved per
  source: Scrydex writes the next date's rows before TCGCSV does, and a newest
  row without main_raw must not demote the card to Scrydex default-raw.
- Scrydex default-raw is only a fallback for non-Japanese cards stored in USD.
  Scrydex raw-JP values are JPY anchors (sometimes labelled USD); never yen.
- price NOW must be >= ``min_price_usd`` (penny cards produce absurd %).
- gainers only; a change above ``max_change_pct`` is treated as a data glitch.
- a main-lane pair must also be the SAME printing (``main_raw_variant``): a
  variant-default fix that re-points a card from a cheap reprint to the real
  holo is a correction, not a gain (Espeon ex ex10-102, 2026-09-14: $39.69
  World Championship Deck → $362.62 Holofoil read as +812%).
- the 30-day series must contain >= ``min_distinct_prices`` distinct values —
  Scrydex's raw-JP anchors are flat single values that occasionally jump, and
  this is what keeps them out of the list without any per-card denylist.
- no single day-to-day step in the series may exceed ``MAX_STEP_MULTIPLE``
  (either direction): a real move climbs through intermediate prices, a bad
  data point teleports (Lucario ru1-12, 2026-11-09: $279.99 → $2997.81).
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from catalog_tools import (
    SEALED_SUPERTYPE,
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
MAX_STEP_MULTIPLE = 3.0
SPARKLINE_POINTS = 30
# The series-based noise filter is applied in batches down the ranked list
# until ``per_game`` survive: the very top of a raw ranking is dense with
# flat-anchor jumps (measured on prod 2026-09-08: 14 of the top 15 Pokémon
# candidates had exactly two distinct prices), so a fixed overfetch starves.
CANDIDATE_BATCH = 25
CANDIDATE_MAX_EXAMINED = 300

SOURCE_MAIN_RAW = "main_raw"
SOURCE_DEFAULT_RAW = "default_raw"
# runtime_settings copy of the env-window payload, written by the scanner
# process on each recompute so the MCP process can read Top Trends cheaply.
LATEST_PAYLOAD_SETTING_KEY = "market_movers_latest"


@dataclass(frozen=True)
class _DailyRow:
    card_id: str
    price_date: str
    currency: str
    default_raw: float | None
    main_raw: float | None
    main_variant: str | None = None


@dataclass(frozen=True)
class Candidate:
    card_id: str
    game: str
    source: str
    currency: str  # always USD
    price_then: float  # USD
    price_now: float  # USD
    then_date: str
    now_date: str
    change_pct: float = 0.0
    main_variant: str | None = None


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


def latest_persisted_payload(connection: sqlite3.Connection) -> dict[str, Any] | None:
    """The last Top Trends payload the scanner process computed, or None."""
    try:
        setting = runtime_setting(connection, LATEST_PAYLOAD_SETTING_KEY)
    except sqlite3.Error:
        return None
    value = (setting or {}).get("value") or {}
    payload = value.get("payload") if isinstance(value, dict) else None
    return payload if isinstance(payload, dict) else None


def _iso(value: date) -> str:
    return value.isoformat()


def _dates_in_window(connection: sqlite3.Connection, start: str, end: str) -> list[str]:
    rows = connection.execute(
        "SELECT DISTINCT price_date FROM card_price_history_daily "
        "WHERE price_date BETWEEN ? AND ? ORDER BY price_date DESC",
        (start, end),
    ).fetchall()
    return [str(row[0]) for row in rows]


def _latest_rows_per_card(
    connection: sqlite3.Connection,
    *,
    start: str,
    end: str,
    has_main_column: bool,
    has_main_variant_column: bool = False,
    expected_cards: int | None = None,
) -> tuple[dict[str, _DailyRow], dict[str, _DailyRow]]:
    """(newest row, newest row WITH a main_raw price) per card within
    [start, end], resolved independently: the Scrydex and TCGCSV syncs land
    on different dates. Reads one price_date at a time newest-first and stops
    once every expected card has a main-lane row."""
    main_col = "main_raw_market_price" if has_main_column else "NULL"
    variant_col = "main_raw_variant" if has_main_variant_column else "NULL"
    out: dict[str, _DailyRow] = {}
    out_main: dict[str, _DailyRow] = {}
    for price_date in _dates_in_window(connection, start, end):
        rows = connection.execute(
            "SELECT card_id, price_date, display_currency_code, "
            f"default_raw_market_price, {main_col}, {variant_col} "
            "FROM card_price_history_daily WHERE price_date = ?",
            (price_date,),
        ).fetchall()
        for row in rows:
            card_id = str(row[0])
            if card_id in out and card_id in out_main:
                continue
            daily = _DailyRow(
                card_id=card_id,
                price_date=str(row[1]),
                currency=str(row[2] or "USD").upper(),
                default_raw=_as_float(row[3]),
                main_raw=_as_float(row[4]),
                main_variant=row[5],
            )
            out.setdefault(card_id, daily)
            if daily.main_raw is not None:
                out_main.setdefault(card_id, daily)
        if expected_cards is not None and len(out_main) >= expected_cards:
            break
    return out, out_main


def _latest_row_per_card(
    connection: sqlite3.Connection,
    *,
    start: str,
    end: str,
    has_main_column: bool,
    has_main_variant_column: bool = False,
    expected_cards: int | None = None,
) -> dict[str, _DailyRow]:
    """Newest daily row per card within [start, end] (feed_prices/meta_pulse)."""
    main_col = "main_raw_market_price" if has_main_column else "NULL"
    variant_col = "main_raw_variant" if has_main_variant_column else "NULL"
    out: dict[str, _DailyRow] = {}
    for price_date in _dates_in_window(connection, start, end):
        rows = connection.execute(
            "SELECT card_id, price_date, display_currency_code, "
            f"default_raw_market_price, {main_col}, {variant_col} "
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
                main_variant=row[5],
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
    """Single-row pairing used by feed_prices; Top Trends uses ``_usd_pair``."""
    if (
        then_row.main_raw is not None
        and now_row.main_raw is not None
        and then_row.main_variant == now_row.main_variant
    ):
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


_JA_ID = re.compile(r"_ja(?:-|$)")


def _is_japanese(card_id: str, language: str | None) -> bool:
    """Scrydex JP ids look like ``adv4_ja-62``; language may be unknown."""
    lang = (language or "").strip().lower()
    return lang in ("ja", "jp", "japanese") or bool(_JA_ID.search(str(card_id).lower()))


def _usd_pair(
    *,
    then_main: _DailyRow | None,
    now_main: _DailyRow | None,
    then_row: _DailyRow | None,
    now_row: _DailyRow | None,
    japanese: bool,
) -> tuple[str, float, float] | None:
    """(source, price_then_usd, price_now_usd) or None when the two ends can't
    be compared like-for-like in USD."""
    if now_main is not None:
        # Main-lane card: TCGCSV only, same printing at both ends.
        if then_main is not None and then_main.main_variant == now_main.main_variant:
            return SOURCE_MAIN_RAW, then_main.main_raw, now_main.main_raw
        return None
    if japanese or then_row is None or now_row is None:
        return None
    if (
        then_row.default_raw is not None
        and now_row.default_raw is not None
        and then_row.currency == "USD"
        and now_row.currency == "USD"
    ):
        return SOURCE_DEFAULT_RAW, then_row.default_raw, now_row.default_raw
    return None


def has_outlier_step(points: list[float], *, max_multiple: float = MAX_STEP_MULTIPLE) -> bool:
    """True when any consecutive pair differs by more than ``max_multiple``x."""
    for prev, cur in zip(points, points[1:]):
        if prev <= 0 or cur <= 0:
            continue
        if max(prev, cur) / min(prev, cur) > max_multiple:
            return True
    return False


def outlier_step_card_ids(
    connection: sqlite3.Connection,
    specs: dict[str, tuple[str, str | None]],
    *,
    start: str,
    end: str,
    max_multiple: float = MAX_STEP_MULTIPLE,
) -> set[str]:
    """Card ids whose [start, end] USD series (``specs``: card_id -> (source,
    main variant)) has a single step above ``max_multiple``x."""
    if not specs:
        return set()
    columns = _table_columns(connection, "card_price_history_daily")
    main_col = "main_raw_market_price" if "main_raw_market_price" in columns else "NULL"
    variant_col = "main_raw_variant" if "main_raw_variant" in columns else "NULL"
    series: dict[str, list[float]] = {}
    ids = sorted(specs)
    for offset in range(0, len(ids), 900):
        chunk = ids[offset : offset + 900]
        rows = connection.execute(
            "SELECT card_id, display_currency_code, default_raw_market_price, "
            f"{main_col}, {variant_col} FROM card_price_history_daily "
            f"WHERE card_id IN ({','.join('?' for _ in chunk)}) AND price_date BETWEEN ? AND ? "
            "ORDER BY card_id, price_date ASC",
            (*chunk, start, end),
        ).fetchall()
        for card_id, currency, default_raw, main_raw, variant in rows:
            source, want_variant = specs[str(card_id)]
            if source == SOURCE_MAIN_RAW:
                if variant != want_variant:
                    continue
                value = _as_float(main_raw)
            else:
                if str(currency or "USD").upper() != "USD":
                    continue
                value = _as_float(default_raw)
            if value is not None:
                series.setdefault(str(card_id), []).append(value)
    return {card_id for card_id, points in series.items() if has_outlier_step(points, max_multiple=max_multiple)}


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
    has_main_variant_column: bool = False,
) -> dict[str, list[float]]:
    """USD daily series (oldest→newest) per candidate, read from the SAME
    source column and currency the pair was built from."""
    if not candidates:
        return {}
    by_id = {c.card_id: c for c in candidates}
    placeholders = ",".join("?" for _ in by_id)
    main_col = "main_raw_market_price" if has_main_column else "NULL"
    variant_col = "main_raw_variant" if has_main_variant_column else "NULL"
    rows = connection.execute(
        "SELECT card_id, price_date, display_currency_code, "
        f"default_raw_market_price, {main_col}, {variant_col} "
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
            if row[5] != candidate.main_variant:
                continue
            value = _as_float(row[4])
        else:
            if str(row[2] or "USD").upper() != "USD":
                continue
            value = _as_float(row[3])
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
    """{card_id: game}, sealed excluded (hot_cards)."""
    return {card_id: game for card_id, (game, _) in _card_games_and_languages(connection, card_ids).items()}


def _card_games_and_languages(
    connection: sqlite3.Connection, card_ids: list[str]
) -> dict[str, tuple[str, str | None]]:
    """{card_id: (game, language)} for the cards that have a "now" price. One
    chunked read over the primary key instead of joining cards into the
    45k-row date scan."""
    out: dict[str, tuple[str, str | None]] = {}
    game_col = "game" if "game" in _table_columns(connection, "cards") else "'pokemon'"
    chunk = 900  # under SQLite's default variable limit
    for start in range(0, len(card_ids), chunk):
        ids = card_ids[start : start + chunk]
        placeholders = ",".join("?" for _ in ids)
        for row in connection.execute(
            f"SELECT id, {game_col}, supertype, language FROM cards WHERE id IN ({placeholders})",
            tuple(ids),
        ):
            # Sealed product is priced daily too, but Top Trends is card gainers.
            if row[2] == SEALED_SUPERTYPE:
                continue
            out[str(row[0])] = (str(row[1] or "pokemon"), row[3])
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

    history_columns = _table_columns(connection, "card_price_history_daily")
    has_main_column = "main_raw_market_price" in history_columns
    has_main_variant_column = "main_raw_variant" in history_columns

    # Bound the "now" read too: once every catalog card has a row there is
    # nothing older dates can add (saves 3 more 45k-row reads on a cold disk).
    card_count = int(connection.execute("SELECT COUNT(*) FROM cards").fetchone()[0] or 0)
    now_rows, now_main_rows = _latest_rows_per_card(
        connection,
        start=_iso(ref_date - timedelta(days=NOW_TOLERANCE_DAYS)),
        end=_iso(ref_date),
        has_main_column=has_main_column,
        has_main_variant_column=has_main_variant_column,
        expected_cards=card_count or None,
    )
    then_end = ref_date - timedelta(days=window_days)
    then_rows, then_main_rows = _latest_rows_per_card(
        connection,
        start=_iso(then_end - timedelta(days=THEN_TOLERANCE_DAYS)),
        end=_iso(then_end),
        has_main_column=has_main_column,
        has_main_variant_column=has_main_variant_column,
        expected_cards=len(now_main_rows),
    )
    games = _card_games_and_languages(connection, list(now_rows.keys()))

    candidates: list[Candidate] = []
    for card_id, now_row in now_rows.items():
        card_info = games.get(card_id)
        # No game = not a card here (sealed product, or a row no longer in `cards`).
        if card_info is None:
            continue
        game, language = card_info
        now_main = now_main_rows.get(card_id)
        then_main = then_main_rows.get(card_id)
        then_row = then_rows.get(card_id)
        pair = _usd_pair(
            then_main=then_main, now_main=now_main, then_row=then_row, now_row=now_row,
            japanese=_is_japanese(card_id, language),
        )
        if pair is None:
            continue
        source, price_then, price_now = pair
        then_end_row, now_end_row = (
            (then_main, now_main) if source == SOURCE_MAIN_RAW else (then_row, now_row)
        )
        candidates.append(
            Candidate(
                card_id=card_id,
                game=game,
                source=source,
                currency="USD",
                price_then=price_then,
                price_now=price_now,
                then_date=then_end_row.price_date,
                now_date=now_end_row.price_date,
                main_variant=now_main.main_variant if source == SOURCE_MAIN_RAW else None,
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
                    has_main_column=has_main_column,
                    has_main_variant_column=has_main_variant_column,
                )
            )
            for candidate in batch:
                points = series.get(candidate.card_id) or []
                if len({round(p, 2) for p in points}) < MIN_DISTINCT_PRICES:
                    continue
                if has_outlier_step(points):
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
