"""Market Analytics tab: one precomputed payload per (game, window).

Definitions live in docs/market-analytics-2026-11-23.md. Split like
``price_lows``: ``compute_market_analytics`` is the daily job (after the price
sync, on the ops prewarm hook, right after ``price_lows``), the request path
only reads ``market_analytics`` / ``market_analytics_sets`` and adds the
caller's own fields (``you``, ``grading[].owned``).

Prices follow the Top Trends / price_lows guardrails (``market_movers``): one
USD source per card (TCGplayer main lane, else Scrydex default-raw for
non-Japanese USD rows; never yen), the same printing at both ends, and
``price_quality`` (stale / raw-above-own-PSA-10) withholds a card everywhere.
Market-wide lists also apply the collectibility filter (``mcp_server.tools``).

Owner rule: never reveal how much price history exists. Payloads carry a
``windowLabel`` ("past 30 days", or "recently" when the store's history does
not cover the window) and no coverage fields.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from types import SimpleNamespace

import market_index
import meta_pulse
import price_lows
import price_quality
from catalog_tools import (
    GAMES,
    SEALED_SUPERTYPE,
    SUPPORTED_GAMES,
    _normalized_variant_label,
    _table_columns,
    _table_exists,
    _variant_match_key,
    connect,
    pricing_provider,
    utc_now,
)
from market_movers import (
    MAX_STEP_MULTIPLE,
    MIN_DISTINCT_PRICES,
    NOW_TOLERANCE_DAYS,
    SOURCE_DEFAULT_RAW,
    SOURCE_MAIN_RAW,
    _DailyRow,
    _as_float,
    _is_japanese,
    _latest_rows_per_card,
    _usd_pair,
    has_outlier_step,
)
# mcp_server imports server (circular at server import time): its helpers are
# imported inside the functions that use them. These mirror
# mcp_server.assistant.compact (window phrases) and mcp_server.tools
# (COLLECTIBLE_MIN_PRICE_USD); test_market_analytics pins them equal.
WINDOW_PHRASES = {7: "past week", 30: "past 30 days", 90: "past 90 days", 365: "past year"}
NEUTRAL_WINDOW = "recently"
COLLECTIBLE_MIN_PRICE_USD = 10.0

WINDOWS = {"7d": 7, "30d": 30, "90d": 90, "1y": 365}
# "then" = the newest row within this many days before the window start.
THEN_TOLERANCE_DAYS = {7: 2, 30: 7, 90: 14, 365: 30}
# The store's history must start within this slack of the window start for
# the window's own name; otherwise the label is "recently".
COVERED_SLACK_DAYS = {7: 2, 30: 7, 90: 7, 365: 30}

INDEX_SIZE = 200  # market index basket: the game's top-N priced singles
INDEX_CANDIDATES = 300  # series-guard walk for the basket
LIQUID_MIN_USD = COLLECTIBLE_MIN_PRICE_USD  # breadth set + market-wide lists
BREADTH_FLAT_PCT = 1.0  # |change| under this is flat
# A then->now pair moving more than this multiple is a data glitch, not a move.
MAX_PAIR_MULTIPLE = MAX_STEP_MULTIPLE
HEATMAP_SETS = 40
SET_TOP_CARDS = 40
SPARK_POINTS = 30

BARGAIN_RANGE_DAYS = 90
BARGAIN_MAX_PERCENTILE = 20.0
BARGAIN_MIN_SPREAD_PCT = 15.0  # (high - low) / high: a flat card has no "bottom"
BARGAIN_MIN_DAYS_COVERED = 30
BARGAIN_SET_MIN_CHANGE_PCT = -meta_pulse.SET_MIN_CHANGE_PCT  # set basket flat (inside +-3%) or rising
BARGAIN_COUNT = 12
BARGAIN_CANDIDATES = 200

BREAKOUT_COUNT = 10
BREAKOUT_HIGHS_WINDOW = 90  # price_highs window table read

SETS_EACH = 5
CARD_MOVERS_EACH = 20  # cardsRising / cardsFalling
MOVERS_MIN_PRICE_USD = 5.0  # both ends of the window: keeps penny-card % swings out
GRADING_COUNT = 10
GRADING_FEE_ENV = "MARKET_GRADING_FEE_USD"
DEFAULT_GRADING_FEE_USD = 30.0

STALE_REFRESH_MIN_INTERVAL_S = 900.0
# Bump when the stored payload's shape changes: the next read recomputes.
PAYLOAD_SCHEMA = 2

# Card-page price position.
POSITION_WINDOWS = (365, 90, 30)
POSITION_MIN_SPAN_DAYS = 14
POSITION_CONDITIONS = {"NM": "NM", "LP": "LP", "MP": "MP", "HP": "HP", "DMG": "DM", "DM": "DM"}


def grading_fee_usd() -> float:
    raw = str(os.environ.get(GRADING_FEE_ENV) or "").strip()
    try:
        value = float(raw) if raw else DEFAULT_GRADING_FEE_USD
    except ValueError:
        return DEFAULT_GRADING_FEE_USD
    return value if value >= 0 else DEFAULT_GRADING_FEE_USD


def window_label(window_days: int, *, history_start: str | None, ref_date: date) -> str:
    """The window's honest name, or "recently" when stored history starts after it."""
    if not history_start:
        return NEUTRAL_WINDOW
    start = ref_date - timedelta(days=window_days)
    covered = date.fromisoformat(history_start[:10]) <= start + timedelta(days=COVERED_SLACK_DAYS.get(window_days, 7))
    return WINDOW_PHRASES.get(window_days, NEUTRAL_WINDOW) if covered else NEUTRAL_WINDOW


def _pct(now: float, then: float) -> float:
    return (now - then) / then * 100.0


def _round(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(float(value), digits)


def downsample(points: list[Any], target: int = SPARK_POINTS) -> list[Any]:
    count = len(points)
    if count <= target:
        return list(points)
    return [points[i] for i in sorted({round(i * (count - 1) / (target - 1)) for i in range(target)})]


# --- schema / version ----------------------------------------------------------


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS market_analytics (
            game TEXT NOT NULL,
            window_days INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (game, window_days)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS market_analytics_sets (
            game TEXT NOT NULL,
            window_days INTEGER NOT NULL,
            set_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (game, window_days, set_id)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS market_analytics_runs (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version TEXT NOT NULL,
            as_of_date TEXT,
            computed_at TEXT NOT NULL,
            elapsed_ms REAL NOT NULL
        )
        """
    )


def version_token(connection: sqlite3.Connection) -> str | None:
    """Prices (newest date + sync generation), the new-highs run, the Market
    Watch run and the fee: everything the stored payloads depend on."""
    prices = price_lows.price_lows_version_token(connection)
    if prices is None:
        return None
    highs = price_lows.stored_version(connection, BREAKOUT_HIGHS_WINDOW, table="price_highs_runs")
    meta = meta_pulse.meta_pulse_version_token(connection)
    index = market_index.version_token(connection)
    return (
        f"{prices}|highs:{highs}|meta:{meta}|idx:{index}|fee:{grading_fee_usd():g}"
        f"|q:{price_quality.PRICE_STALE_DAYS}|schema:{PAYLOAD_SCHEMA}"
    )


def stored_run(connection: sqlite3.Connection) -> dict[str, Any] | None:
    if not _table_exists(connection, "market_analytics_runs"):
        return None
    row = connection.execute(
        "SELECT version, as_of_date, computed_at, elapsed_ms FROM market_analytics_runs WHERE id = 1"
    ).fetchone()
    if row is None:
        return None
    return {"version": row[0], "asOf": row[1], "computedAt": row[2], "elapsedMs": row[3]}


# --- inputs --------------------------------------------------------------------


@dataclass(frozen=True)
class _Card:
    card_id: str
    game: str
    name: str
    set_id: str | None
    set_name: str | None
    number: str | None
    rarity: str | None
    supertype: str | None
    image_url: str | None
    language: str | None

    @property
    def sealed(self) -> bool:
        return self.supertype == SEALED_SUPERTYPE

    @property
    def japanese(self) -> bool:
        return _is_japanese(self.card_id, self.language)

    def collectible(self) -> bool:
        card = {
            "supertype": self.supertype, "rarity": self.rarity, "game": self.game,
            "imageSmallURL": self.image_url,
        }
        from mcp_server.tools import has_card_image, is_low_interest_card

        return has_card_image(card) and not is_low_interest_card(card)


@dataclass
class _Priced:
    card: _Card
    source: str
    variant: str | None
    price: float
    now_date: str
    # window_days -> then price (same source / printing), when paired and sane
    then: dict[int, float]

    def change(self, window_days: int) -> float | None:
        then = self.then.get(window_days)
        return None if then is None else _pct(self.price, then)


def _load_cards(connection: sqlite3.Connection, card_ids: list[str] | None = None) -> dict[str, _Card]:
    game_col = "game" if "game" in _table_columns(connection, "cards") else "'pokemon'"
    sql = (
        f"SELECT id, {game_col}, name, set_id, set_name, number, rarity, supertype, "
        "COALESCE(NULLIF(image_small_url, ''), image_url), language FROM cards"
    )
    params: list[str] = []
    if card_ids is not None:
        sql += f" WHERE id IN ({','.join('?' for _ in card_ids)})"
        params = list(card_ids)
    out: dict[str, _Card] = {}
    for row in connection.execute(sql, params):
        out[str(row[0])] = _Card(
            str(row[0]), str(row[1] or "pokemon"), str(row[2] or ""), row[3], row[4], row[5], row[6], row[7],
            row[8] or None, row[9],
        )
    return out


def _expansions(connection: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    if not _table_exists(connection, "expansions"):
        return {}
    return {
        str(row[0]): {"name": row[1], "logoUrl": row[2] or None}
        for row in connection.execute("SELECT id, name, logo_url FROM expansions")
    }


def _then_pairs(
    connection: sqlite3.Connection,
    *,
    ref_date: date,
    window_days: int,
    now_rows: dict[str, _DailyRow],
    now_main: dict[str, _DailyRow],
    cards: dict[str, _Card],
    has_main: bool,
    has_variant: bool,
) -> dict[str, float]:
    """card_id -> USD price at the window start, same source and printing as
    now (market_movers._usd_pair), dropped when the pair jumps by a glitch."""
    then_end = ref_date - timedelta(days=window_days)
    then_rows, then_main = _latest_rows_per_card(
        connection,
        start=(then_end - timedelta(days=THEN_TOLERANCE_DAYS.get(window_days, 7))).isoformat(),
        end=then_end.isoformat(),
        has_main_column=has_main,
        has_main_variant_column=has_variant,
        expected_cards=len(now_main) or None,
    )
    out: dict[str, float] = {}
    for card_id, now_row in now_rows.items():
        card = cards.get(card_id)
        if card is None:
            continue
        pair = _usd_pair(
            then_main=then_main.get(card_id), now_main=now_main.get(card_id),
            then_row=then_rows.get(card_id), now_row=now_row, japanese=card.japanese,
        )
        if pair is None:
            continue
        _, then_price, now_price = pair
        if then_price <= 0 or now_price <= 0:
            continue
        if max(then_price, now_price) / min(then_price, now_price) > MAX_PAIR_MULTIPLE:
            continue
        out[card_id] = then_price
    return out


def _quality_ok(connection: sqlite3.Connection, priced: dict[str, _Priced], *, today: date) -> set[str]:
    """Ids whose current price is neither stale nor untrusted (price_quality)."""
    facts = price_quality.load_price_quality(connection, list(priced))
    cutoff = price_quality.stale_cutoff(today)
    ok: set[str] = set()
    for card_id, item in priced.items():
        pricing = {"refreshedAt": item.now_date, "variant": item.variant}
        if item.source == SOURCE_MAIN_RAW:
            pricing["mainPriceSource"] = "tcgcsv"
        verdict = price_quality.assess_price(
            pricing, item.price, facts.get(card_id), graded=False, cutoff=cutoff
        )
        if verdict is None:
            ok.add(card_id)
    return ok


# --- tiles ---------------------------------------------------------------------


def card_tile(card: _Card, variant: str | None = None) -> dict[str, Any]:
    tile: dict[str, Any] = {
        "cardId": card.card_id,
        "name": card.name,
        "setName": card.set_name,
        "number": card.number,
        "imageUrl": card.image_url,
        "game": card.game,
    }
    if variant:
        tile["variant"] = variant
    return tile


def _set_tile(set_id: str, name: str | None, game: str, expansions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    exp = expansions.get(set_id) or {}
    return {"setId": set_id, "name": name or exp.get("name") or set_id, "logoUrl": exp.get("logoUrl"), "game": game}


def _distinct_key(card: _Card) -> str:
    return f"{' '.join(card.name.split()).casefold()}|{card.set_id or card.set_name or ''}"


def empty_payload(game: str, window: str, *, window_label_text: str = NEUTRAL_WINDOW, as_of: str | None = None) -> dict[str, Any]:
    return {
        "game": game,
        "window": window,
        "windowLabel": window_label_text,
        "asOf": as_of,
        "pulse": {
            "changePct": None,
            "indexValueUsd": None,
            "breadth": {"up": 0, "down": 0, "flat": 0, "upPct": None},
            "sparkline": [],
            # The per-game Market Index (market_index.py); null until computed.
            "index": None,
        },
        "you": None,
        "heatmap": [],
        "bargains": [],
        "breakingOut": [],
        "setsRising": [],
        "setsFalling": [],
        "cardsRising": [],
        "cardsFalling": [],
        "grading": [],
    }


# --- sections ------------------------------------------------------------------


def _series_sum_sparkline(
    basket: list[_Priced],
    series: dict[str, list[tuple[str, float]]],
    *,
    window_days: int,
    ref_date: date,
) -> list[dict[str, Any]]:
    """Daily basket value (each card's last known price carried forward, its
    window-start price before its first point), downsampled."""
    then_end = ref_date - timedelta(days=window_days)
    days = [(then_end + timedelta(days=i)).isoformat() for i in range(window_days + 1)]
    cursors = {item.card.card_id: 0 for item in basket}
    current = {item.card.card_id: item.then[window_days] for item in basket}
    out: list[dict[str, Any]] = []
    for day in days:
        for item in basket:
            card_id = item.card.card_id
            points = series.get(card_id) or []
            index = cursors[card_id]
            while index < len(points) and points[index][0] <= day:
                if points[index][0] > then_end.isoformat():
                    current[card_id] = points[index][1]
                index += 1
            cursors[card_id] = index
        out.append({"date": day, "value": round(sum(current.values()), 2)})
    if out:
        out[0]["value"] = round(sum(item.then[window_days] for item in basket), 2)
        out[-1]["value"] = round(sum(item.price for item in basket), 2)
    return downsample(out)


def _pulse(
    connection: sqlite3.Connection,
    liquid: list[_Priced],
    *,
    window_days: int,
    ref_date: date,
) -> dict[str, Any]:
    paired = [item for item in liquid if window_days in item.then]
    up = down = flat = 0
    for item in paired:
        change = item.change(window_days) or 0.0
        if change > BREADTH_FLAT_PCT:
            up += 1
        elif change < -BREADTH_FLAT_PCT:
            down += 1
        else:
            flat += 1
    total = up + down + flat
    breadth = {"up": up, "down": down, "flat": flat, "upPct": round(up / total * 100.0, 1) if total else None}

    candidates = sorted(paired, key=lambda item: (-item.price, item.card.card_id))[:INDEX_CANDIDATES]
    start = (ref_date - timedelta(days=window_days + THEN_TOLERANCE_DAYS.get(window_days, 7))).isoformat()
    series = price_lows._load_series(
        connection, {item.card.card_id: (item.source, item.variant) for item in candidates},
        start=start, end=ref_date.isoformat(),
    ) if candidates else {}
    basket = [
        item for item in candidates
        if not has_outlier_step([value for _, value in series.get(item.card.card_id) or []], max_multiple=MAX_STEP_MULTIPLE)
    ][:INDEX_SIZE]
    if not basket:
        return {"changePct": None, "indexValueUsd": None, "breadth": breadth, "sparkline": [], "index": None}
    value_then = sum(item.then[window_days] for item in basket)
    value_now = sum(item.price for item in basket)
    return {
        "changePct": round(_pct(value_now, value_then), 2) if value_then > 0 else None,
        "indexValueUsd": round(value_now, 2),
        "breadth": breadth,
        "sparkline": _series_sum_sparkline(basket, series, window_days=window_days, ref_date=ref_date),
        "index": None,
    }


def _heatmap_and_sets(
    singles: list[_Priced],
    *,
    window_days: int,
    expansions: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    by_set: dict[str, list[_Priced]] = defaultdict(list)
    for item in singles:
        if item.card.set_id:
            by_set[str(item.card.set_id)].append(item)
    tiles: list[dict[str, Any]] = []
    set_payloads: dict[str, dict[str, Any]] = {}
    for set_id, members in by_set.items():
        total = sum(item.price for item in members)
        paired = [item for item in members if window_days in item.then]
        then_sum = sum(item.then[window_days] for item in paired)
        now_sum = sum(item.price for item in paired)
        name = members[0].card.set_name or (expansions.get(set_id) or {}).get("name") or set_id
        game = members[0].card.game
        tiles.append(
            {
                **_set_tile(set_id, name, game, expansions),
                "totalValueUsd": round(total, 2),
                "changePct": round(_pct(now_sum, then_sum), 2) if then_sum > 0 else None,
                "cardCount": len(members),
            }
        )
        top = sorted(members, key=lambda item: (-item.price, item.card.card_id))[:SET_TOP_CARDS]
        set_payloads[set_id] = {
            "setId": set_id,
            "name": name,
            "cards": [
                {
                    **card_tile(item.card, item.variant),
                    "priceUsd": round(item.price, 2),
                    "changePct": _round(item.change(window_days)),
                }
                for item in top
            ],
        }
    tiles.sort(key=lambda tile: (-tile["totalValueUsd"], tile["setId"]))
    return tiles[:HEATMAP_SETS], set_payloads


def _set_index_changes(connection: sqlite3.Connection, game: str, window_days: int) -> dict[str, float]:
    """Market Watch's per-set basket change (every trackable set) keyed by the
    set key meta_pulse uses (set_id with "/" -> "_")."""
    if not _table_exists(connection, "meta_pulse_groups"):
        return {}
    as_of = meta_pulse._latest_as_of(connection, game) if _table_exists(connection, "meta_pulse_runs") else None
    if not as_of:
        return {}
    out: dict[str, float] = {}
    for key, change in connection.execute(
        "SELECT group_key, median_change_percent FROM meta_pulse_groups WHERE game = ? AND as_of_date = ? "
        "AND window_days = ? AND lane = ? AND segment_key = ?",
        (game, as_of, window_days, meta_pulse.LANE_RAW, meta_pulse.SET_INDEX_SEGMENT_KEY),
    ):
        parts = str(key).split(":")
        if len(parts) >= 3:
            out[":".join(parts[1:-1])] = float(change)
    return out


def _bargains(
    connection: sqlite3.Connection,
    liquid: list[_Priced],
    stats: tuple[dict, dict],
    *,
    window_days: int,
    ref_date: date,
    set_changes: dict[str, float],
) -> list[dict[str, Any]]:
    main_stats, default_stats = stats
    candidates: list[tuple[float, _Priced, float, float]] = []
    for item in liquid:
        set_key = str(item.card.set_id or item.card.set_name or "").replace("/", "_")
        set_change = set_changes.get(set_key)
        if set_change is None or set_change < BARGAIN_SET_MIN_CHANGE_PCT:
            continue
        window_stats = (
            main_stats.get((item.card.card_id, item.variant))
            if item.source == SOURCE_MAIN_RAW
            else default_stats.get(item.card.card_id)
        )
        if window_stats is None:
            continue
        if (ref_date - date.fromisoformat(window_stats.first_date[:10])).days < BARGAIN_MIN_DAYS_COVERED:
            continue
        low, high = min(window_stats.low, item.price), max(window_stats.high, item.price)
        if high <= 0 or (high - low) / high * 100.0 < BARGAIN_MIN_SPREAD_PCT:
            continue
        percentile = (item.price - low) / (high - low) * 100.0
        if percentile > BARGAIN_MAX_PERCENTILE:
            continue
        candidates.append((percentile, item, low, high))
    candidates.sort(key=lambda c: (round(c[0], 1), -c[1].price, c[1].card.card_id))
    candidates = candidates[:BARGAIN_CANDIDATES]
    series = price_lows._load_series(
        connection, {c[1].card.card_id: (c[1].source, c[1].variant) for c in candidates},
        start=(ref_date - timedelta(days=BARGAIN_RANGE_DAYS)).isoformat(), end=ref_date.isoformat(),
    ) if candidates else {}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for percentile, item, low, high in candidates:
        if price_lows._series_bad([value for _, value in series.get(item.card.card_id) or []]):
            continue
        key = _distinct_key(item.card)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                **card_tile(item.card, item.variant),
                "priceUsd": round(item.price, 2),
                "changePct": _round(item.change(window_days)),
                "position": {"lowUsd": round(low, 2), "highUsd": round(high, 2), "percentile": round(percentile)},
            }
        )
        if len(out) >= BARGAIN_COUNT:
            break
    return out


def _breaking_out(
    connection: sqlite3.Connection,
    game: str,
    priced: dict[str, _Priced],
    *,
    window_days: int,
    ref_date: date,
) -> list[dict[str, Any]]:
    """price_highs (find_new_highs' table) for the game, through the same
    collectibility + quality gates; previous high = the highest price before
    the recent new-high span."""
    if not _table_exists(connection, "price_highs"):
        return []
    rows = connection.execute(
        "SELECT card_id, source, variant, high_usd FROM price_highs WHERE window_days = ? AND game = ? "
        "AND sealed = 0 ORDER BY rank",
        (BREAKOUT_HIGHS_WINDOW, game),
    ).fetchall()
    picked: list[_Priced] = []
    seen: set[str] = set()
    for card_id, source, variant, _ in rows:
        item = priced.get(str(card_id))
        # Same lane + printing as the stored high, current price still served and collectible.
        if item is None or item.source != source or item.variant != variant:
            continue
        if item.price < LIQUID_MIN_USD or not item.card.collectible():
            continue
        if item.card.japanese and item.source != SOURCE_MAIN_RAW:
            continue
        key = _distinct_key(item.card)
        if key in seen:
            continue
        seen.add(key)
        picked.append(item)
        if len(picked) >= BREAKOUT_COUNT:
            break
    if not picked:
        return []
    start = (ref_date - timedelta(days=BREAKOUT_HIGHS_WINDOW)).isoformat()
    series = price_lows._load_series(
        connection, {item.card.card_id: (item.source, item.variant) for item in picked}, start=start,
        end=ref_date.isoformat(),
    )
    recent_start = (ref_date - timedelta(days=price_lows.HIGH_RECENT_DAYS - 1)).isoformat()
    window_start = (ref_date - timedelta(days=window_days)).isoformat()
    out: list[dict[str, Any]] = []
    for item in picked:
        points = series.get(item.card.card_id) or []
        older = [value for day, value in points if day < recent_start]
        in_window = [{"date": day, "value": round(value, 2)} for day, value in points if day >= window_start]
        out.append(
            {
                **card_tile(item.card, item.variant),
                "priceUsd": round(item.price, 2),
                "changePct": _round(item.change(window_days)),
                "previousHighUsd": round(max(older), 2) if older else None,
                "sparkline": downsample(in_window),
            }
        )
    return out


def _card_movers(singles: list[_Priced], *, window_days: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Biggest single-card % moves over the window, CARD_MOVERS_EACH each way."""
    moves: list[tuple[float, _Priced]] = []
    for item in singles:
        then = item.then.get(window_days)
        if then is None or item.price < MOVERS_MIN_PRICE_USD or then < MOVERS_MIN_PRICE_USD:
            continue
        if item.card.japanese and item.source != SOURCE_MAIN_RAW:
            continue
        if not item.card.collectible():
            continue
        moves.append((_pct(item.price, then), item))

    def pick(ranked: list[tuple[float, _Priced]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for change, item in ranked:
            key = _distinct_key(item.card)
            if key in seen:
                continue
            seen.add(key)
            then = item.then[window_days]
            out.append(
                {
                    **card_tile(item.card, item.variant),
                    "priceUsd": round(item.price, 2),
                    "thenPriceUsd": round(then, 2),
                    "changePct": round(change, 2),
                    "changeUsd": round(item.price - then, 2),
                }
            )
            if len(out) >= CARD_MOVERS_EACH:
                break
        return out

    rising = sorted((m for m in moves if m[0] > 0), key=lambda m: (-m[0], -m[1].price, m[1].card.card_id))
    falling = sorted((m for m in moves if m[0] < 0), key=lambda m: (m[0], -m[1].price, m[1].card.card_id))
    return pick(rising), pick(falling)


def _sets_rising_falling(
    connection: sqlite3.Connection, game: str, window_days: int, expansions: dict[str, dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Market Watch set baskets (get_market_trends' source), 5 each way."""
    if not _table_exists(connection, "meta_pulse_runs"):
        return [], []
    payload = meta_pulse.build_meta_pulse_payload(
        connection, game=game, window_days=window_days, lane=meta_pulse.LANE_RAW,
        kind=meta_pulse.KIND_SETS, max_groups_per_direction=SETS_EACH, top_cards_limit=0,
    )
    rising: list[dict[str, Any]] = []
    falling: list[dict[str, Any]] = []
    for group in payload.get("groups") or []:
        key = str(group.get("groupKey") or "")
        parts = key.split(":")
        if len(parts) < 3:
            continue
        set_id = ":".join(parts[1:-1])
        change = group.get("medianChangePercent")
        if change is None:
            continue
        tile = {**_set_tile(set_id, group.get("label"), game, expansions), "changePct": round(float(change), 2)}
        (rising if change >= 0 else falling).append(tile)
    rising.sort(key=lambda t: -t["changePct"])
    falling.sort(key=lambda t: t["changePct"])
    return rising[:SETS_EACH], falling[:SETS_EACH]


def _grading(
    connection: sqlite3.Connection,
    game: str,
    priced: dict[str, _Priced],
    *,
    fee_usd: float,
    today: date,
) -> list[dict[str, Any]]:
    """Own-card PSA 10 (same printing) minus raw minus a flat fee. The graded
    reads, freshness and outlier rules are find_top_graded's (CollectionTools
    over a connection-only shim)."""
    descriptor = GAMES.get(game)
    if descriptor is None or not descriptor.has_graded_pricing:
        return []
    from mcp_server.tools import CollectionTools

    tools = CollectionTools(SimpleNamespace(connection=connection))
    entries = tools._graded_cell_entries(game, "PSA", "10", japanese_ok=False)
    from_cells = entries is not None
    if entries is None:
        entries = tools._graded_snapshot_entries(
            game, "PSA", "10", japanese_ok=False, fresh_since=price_quality.stale_cutoff(today)
        )
    by_card: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in entries:
        by_card[entry["card_id"]].append(entry)
    candidates: list[tuple[float, _Priced, dict[str, Any]]] = []
    for card_id, slabs in by_card.items():
        item = priced.get(card_id)
        if item is None or item.card.japanese or not item.card.collectible():
            continue
        if item.variant:
            want = _variant_match_key(_normalized_variant_label(item.variant))
            match = [s for s in slabs if _variant_match_key(_normalized_variant_label(s.get("variant"))) == want]
        else:
            # Printing unknown (Scrydex default-raw): only a card with one PSA 10 printing compares.
            keys = {_variant_match_key(_normalized_variant_label(s.get("variant"))) for s in slabs}
            match = slabs if len(keys) == 1 else []
        if not match:
            continue
        slab = max(match, key=lambda s: s["market"])
        if slab["market"] < LIQUID_MIN_USD:
            continue
        net = slab["market"] - item.price - fee_usd
        if net > 0:
            candidates.append((net, item, slab))
    candidates.sort(key=lambda c: (-c[0], c[1].card.card_id))
    candidates = candidates[: GRADING_COUNT * 4]
    peers = tools._graded_peer_entries(game, [c[1].card.card_id for c in candidates], from_cells=from_cells)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for net, item, slab in candidates:
        if tools._graded_distrust_reason(slab, peers.get(item.card.card_id, []), item.price) is not None:
            continue
        key = _distinct_key(item.card)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                **card_tile(item.card, item.variant),
                "rawUsd": round(item.price, 2),
                "psa10Usd": round(float(slab["market"]), 2),
                "feeUsd": round(fee_usd, 2),
                "netGainUsd": round(net, 2),
                "owned": False,
            }
        )
        if len(out) >= GRADING_COUNT:
            break
    return out


YOUR_MOVERS_EACH = 5


def your_movers(connection: sqlite3.Connection, summary: dict[str, Any] | None, game: str) -> dict[str, Any] | None:
    """The caller's biggest holding moves in this game, from the portfolio
    summary's top_gainers/top_losers (ranked by the holding's change_usd).
    Sealed is left out; null when nothing in the game moved."""
    if not summary:
        return None
    gainers_in = summary.get("top_gainers") or []
    losers_in = summary.get("top_losers") or []
    ids = sorted({str(m["card_id"]) for m in (*gainers_in, *losers_in) if m.get("card_id")})
    if not ids:
        return None
    cards = _load_cards(connection, ids)

    def pick(movers: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for mover in movers:
            card = cards.get(str(mover.get("card_id")))
            if card is None or card.game != game or card.sealed:
                continue
            out.append(
                {
                    **card_tile(card, mover.get("variant")),
                    "quantity": int(mover.get("quantity") or 0),
                    "priceUsd": _round(mover.get("to_usd")),
                    "changeUsd": _round(mover.get("change_usd")),
                    "changePct": _round(mover.get("change_pct")),
                }
            )
            if len(out) >= YOUR_MOVERS_EACH:
                break
        return out

    gainers, losers = pick(gainers_in), pick(losers_in)
    if not gainers and not losers:
        return None
    return {"gainers": gainers, "losers": losers}


# --- compute -------------------------------------------------------------------


def compute_market_analytics(
    connection: sqlite3.Connection,
    *,
    today: date | None = None,
    games: tuple[str, ...] = SUPPORTED_GAMES,
) -> tuple[str | None, dict[tuple[str, int], dict[str, Any]], dict[tuple[str, int], dict[str, dict[str, Any]]]]:
    """(as_of, {(game, window_days): payload}, {(game, window_days): {set_id: set payload}})."""
    today = today or datetime.now(timezone.utc).date()
    row = connection.execute("SELECT MIN(price_date), MAX(price_date) FROM card_price_history_daily").fetchone()
    payloads: dict[tuple[str, int], dict[str, Any]] = {}
    sets_out: dict[tuple[str, int], dict[str, dict[str, Any]]] = {}
    if row is None or not row[1]:
        for game in games:
            for window, days in WINDOWS.items():
                payloads[(game, days)] = empty_payload(game, window)
        return None, payloads, sets_out
    history_start = str(row[0])[:10]
    ref_date = date.fromisoformat(str(row[1])[:10])
    as_of = ref_date.isoformat()
    labels = {days: window_label(days, history_start=history_start, ref_date=ref_date) for days in WINDOWS.values()}
    if (today - ref_date).days > NOW_TOLERANCE_DAYS:
        # A stale sync is not a market read.
        for game in games:
            for window, days in WINDOWS.items():
                payloads[(game, days)] = empty_payload(game, window, window_label_text=labels[days], as_of=as_of)
        return as_of, payloads, sets_out

    columns = _table_columns(connection, "card_price_history_daily")
    has_main = "main_raw_market_price" in columns
    has_variant = "main_raw_variant" in columns
    cards = _load_cards(connection)
    expansions = _expansions(connection)
    now_rows, now_main = _latest_rows_per_card(
        connection,
        start=(ref_date - timedelta(days=NOW_TOLERANCE_DAYS)).isoformat(),
        end=as_of,
        has_main_column=has_main,
        has_main_variant_column=has_variant,
        expected_cards=len(cards) or None,
    )
    priced: dict[str, _Priced] = {}
    for card_id, now_row in now_rows.items():
        card = cards.get(card_id)
        if card is None or card.game not in games:
            continue
        main = now_main.get(card_id)
        if main is not None:
            priced[card_id] = _Priced(card, SOURCE_MAIN_RAW, main.main_variant, main.main_raw, main.price_date, {})
        elif not card.japanese and now_row.currency == "USD" and now_row.default_raw is not None:
            priced[card_id] = _Priced(card, SOURCE_DEFAULT_RAW, None, now_row.default_raw, now_row.price_date, {})
    trusted = _quality_ok(connection, priced, today=today)
    priced = {card_id: item for card_id, item in priced.items() if card_id in trusted}
    for days in WINDOWS.values():
        pairs = _then_pairs(
            connection, ref_date=ref_date, window_days=days, now_rows=now_rows, now_main=now_main, cards=cards,
            has_main=has_main, has_variant=has_variant,
        )
        for card_id, then_price in pairs.items():
            if card_id in priced:
                priced[card_id].then[days] = then_price

    range_stats = price_lows._window_stats(
        connection,
        starts={BARGAIN_RANGE_DAYS: (ref_date - timedelta(days=BARGAIN_RANGE_DAYS)).isoformat()},
        end=as_of,
        recent_start=as_of,
        has_main=has_main,
        has_variant=has_variant,
    )[BARGAIN_RANGE_DAYS]
    fee = grading_fee_usd()

    for game in games:
        singles = [item for item in priced.values() if item.card.game == game and not item.card.sealed]
        liquid = [item for item in singles if item.price >= LIQUID_MIN_USD and item.card.collectible()]
        game_priced = {item.card.card_id: item for item in singles}
        grading = _grading(connection, game, game_priced, fee_usd=fee, today=today)
        for window, days in WINDOWS.items():
            heatmap, set_payloads = _heatmap_and_sets(singles, window_days=days, expansions=expansions)
            rising, falling = _sets_rising_falling(connection, game, days, expansions)
            cards_rising, cards_falling = _card_movers(singles, window_days=days)
            payload = empty_payload(game, window, window_label_text=labels[days], as_of=as_of)
            pulse = _pulse(connection, liquid, window_days=days, ref_date=ref_date)
            pulse["index"] = market_index.index_payload(connection, game, days)
            payload.update(
                {
                    "pulse": pulse,
                    "heatmap": heatmap,
                    "bargains": _bargains(
                        connection, liquid, range_stats, window_days=days, ref_date=ref_date,
                        set_changes=_set_index_changes(connection, game, days),
                    ),
                    "breakingOut": _breaking_out(connection, game, game_priced, window_days=days, ref_date=ref_date),
                    "setsRising": rising,
                    "setsFalling": falling,
                    "cardsRising": cards_rising,
                    "cardsFalling": cards_falling,
                    "grading": grading,
                }
            )
            payloads[(game, days)] = payload
            sets_out[(game, days)] = {
                set_id: {**set_payload, "window": window, "windowLabel": labels[days]}
                for set_id, set_payload in set_payloads.items()
            }
    return as_of, payloads, sets_out


def write_market_analytics(
    connection: sqlite3.Connection,
    *,
    as_of: str | None,
    payloads: dict[tuple[str, int], dict[str, Any]],
    sets: dict[tuple[str, int], dict[str, dict[str, Any]]],
    version: str,
    elapsed_ms: float,
) -> None:
    """Atomic swap of every stored payload."""
    ensure_schema(connection)
    with connection:
        connection.execute("DELETE FROM market_analytics")
        connection.execute("DELETE FROM market_analytics_sets")
        connection.executemany(
            "INSERT INTO market_analytics (game, window_days, payload_json) VALUES (?, ?, ?)",
            [(game, days, json.dumps(payload, separators=(",", ":"))) for (game, days), payload in payloads.items()],
        )
        connection.executemany(
            "INSERT INTO market_analytics_sets (game, window_days, set_id, payload_json) VALUES (?, ?, ?, ?)",
            [
                (game, days, set_id, json.dumps(set_payload, separators=(",", ":")))
                for (game, days), by_set in sets.items()
                for set_id, set_payload in by_set.items()
            ],
        )
        connection.execute(
            "INSERT INTO market_analytics_runs (id, version, as_of_date, computed_at, elapsed_ms) "
            "VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, "
            "as_of_date = excluded.as_of_date, computed_at = excluded.computed_at, elapsed_ms = excluded.elapsed_ms",
            (version, as_of, utc_now(), round(elapsed_ms, 1)),
        )


def refresh_market_analytics(
    connection: sqlite3.Connection, *, force: bool = False, today: date | None = None
) -> dict[str, Any]:
    """Recompute when the inputs' version changed; cheap no-op otherwise. The
    market index tables are brought up to date first (its own no-op check)."""
    ensure_schema(connection)
    connection.commit()
    try:
        index_report = market_index.refresh_market_index(connection)
    except Exception as error:  # noqa: BLE001 - the index must not block the rest of the tab
        connection.rollback()
        index_report = {"error": repr(error)}
    version = version_token(connection)
    report: dict[str, Any] = {"version": version, "marketIndex": index_report}
    if version is None:
        return report
    run = stored_run(connection)
    if not force and run is not None and run["version"] == version:
        report["skipped"] = True
        return report
    started = time.perf_counter()
    as_of, payloads, sets = compute_market_analytics(connection, today=today)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    write_market_analytics(connection, as_of=as_of, payloads=payloads, sets=sets, version=version, elapsed_ms=elapsed_ms)
    report.update({"asOf": as_of, "payloads": len(payloads), "elapsedMs": round(elapsed_ms, 1)})
    return report


# --- request-path reads ---------------------------------------------------------


def read_payload(connection: sqlite3.Connection, game: str, window_days: int) -> dict[str, Any] | None:
    if not _table_exists(connection, "market_analytics"):
        return None
    row = connection.execute(
        "SELECT payload_json FROM market_analytics WHERE game = ? AND window_days = ?", (game, window_days)
    ).fetchone()
    return json.loads(row[0]) if row is not None else None


def read_set_payload(connection: sqlite3.Connection, game: str, window_days: int, set_id: str) -> dict[str, Any] | None:
    if not _table_exists(connection, "market_analytics_sets"):
        return None
    row = connection.execute(
        "SELECT payload_json FROM market_analytics_sets WHERE game = ? AND window_days = ? AND set_id = ?",
        (game, window_days, set_id),
    ).fetchone()
    return json.loads(row[0]) if row is not None else None


# --- card-page price position ----------------------------------------------------


def _drop_spikes(points: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Drop single points more than MAX_STEP_MULTIPLE x off BOTH neighbours (a
    glitch print, not a move)."""
    return market_index.drop_spikes(points, MAX_STEP_MULTIPLE)


def _raw_main_points(
    connection: sqlite3.Connection, card_id: str, language: str | None, *, variant: str | None, start: str, end: str
) -> list[tuple[str, float]]:
    columns = _table_columns(connection, "card_price_history_daily")
    if "main_raw_market_price" not in columns:
        main_col, variant_col = "NULL", "NULL"
    else:
        main_col = "main_raw_market_price"
        variant_col = "main_raw_variant" if "main_raw_variant" in columns else "NULL"
    rows = connection.execute(
        f"SELECT price_date, display_currency_code, default_raw_market_price, {main_col}, {variant_col} "
        "FROM card_price_history_daily WHERE card_id = ? AND price_date BETWEEN ? AND ? ORDER BY price_date",
        (card_id, start, end),
    ).fetchall()
    main_rows = [(str(r[0])[:10], _as_float(r[3]), r[4]) for r in rows if _as_float(r[3]) is not None]
    if main_rows:
        if variant:
            want = _variant_match_key(_normalized_variant_label(variant))
            chosen = next(
                (v for _, _, v in reversed(main_rows) if _variant_match_key(_normalized_variant_label(v)) == want), None
            )
            if chosen is None:
                return []
        else:
            chosen = main_rows[-1][2]
        return [(day, value) for day, value, v in main_rows if v == chosen]
    if _is_japanese(card_id, language):
        return []
    return [
        (str(r[0])[:10], float(r[2]))
        for r in rows
        if str(r[1] or "USD").upper() == "USD" and _as_float(r[2]) is not None
    ]


def _cell_points(
    connection: sqlite3.Connection,
    card_id: str,
    *,
    lane: str,
    variant: str | None,
    condition: str | None,
    grader: str | None,
    grade: str | None,
    start: str,
    end: str,
) -> list[tuple[str, float]]:
    if not _table_exists(connection, "card_price_history_cell"):
        return []
    sql = (
        "SELECT price_date, variant_key, market FROM card_price_history_cell "
        "WHERE card_id = ? AND provider = ? AND price_date BETWEEN ? AND ? AND +lane = ? AND market > 0 "
        "AND COALESCE(is_perfect, 0) = 0 AND COALESCE(is_signed, 0) = 0 AND COALESCE(is_error, 0) = 0 "
        "AND UPPER(COALESCE(currency_code, 'USD')) = 'USD'"
    )
    params: list[Any] = [card_id, pricing_provider(), start, end, lane]
    if lane == "graded":
        sql += " AND UPPER(grader) = ?"
        params.append(str(grader or "").upper())
        try:
            sql += " AND CAST(grade AS REAL) = ?"
            params.append(float(str(grade)))
        except ValueError:
            sql += " AND UPPER(grade) = ?"
            params.append(str(grade or "").upper())
    else:
        sql += " AND UPPER(condition) = ?"
        params.append(str(condition or "").upper())
    rows = connection.execute(sql + " ORDER BY price_date", params).fetchall()
    if not rows:
        return []
    keys = [_variant_match_key(_normalized_variant_label(r[1])) for r in rows]
    if variant:
        chosen = _variant_match_key(_normalized_variant_label(variant))
    else:
        chosen = keys[-1]  # the newest observed printing
    by_day: dict[str, float] = {}
    for (day, _, market), key in zip(rows, keys):
        if key == chosen:
            day = str(day)[:10]
            by_day[day] = min(float(market), by_day.get(day, float(market)))
    return sorted(by_day.items())


def price_position(
    connection: sqlite3.Connection,
    card_id: str,
    *,
    variant: str | None = None,
    condition: str | None = None,
    grader: str | None = None,
    grade: str | None = None,
    today: date | None = None,
) -> dict[str, Any] | None:
    """{currentUsd, lowUsd, highUsd, percentile, windowLabel} for one card's raw
    (default) or graded price against its own recent range, or None when there
    is not enough trustworthy data. Raises KeyError for an unknown card."""
    row = connection.execute("SELECT id, language FROM cards WHERE id = ?", (card_id,)).fetchone()
    if row is None:
        raise KeyError(card_id)
    language = row[1]
    today = today or datetime.now(timezone.utc).date()
    end = today.isoformat()
    start = (today - timedelta(days=max(POSITION_WINDOWS))).isoformat()
    graded = bool(grader and grade)
    condition_code = POSITION_CONDITIONS.get(str(condition or "").strip().upper()) if condition else None
    if condition and condition_code is None:
        return None
    if graded:
        if _is_japanese(card_id, language):
            return None  # Scrydex JP graded values may be yen stamped USD
        points = _cell_points(
            connection, card_id, lane="graded", variant=variant, condition=None, grader=grader, grade=grade,
            start=start, end=end,
        )
    elif condition_code and condition_code != "NM":
        if _is_japanese(card_id, language):
            return None
        points = _cell_points(
            connection, card_id, lane="raw", variant=variant, condition=condition_code, grader=None, grade=None,
            start=start, end=end,
        )
    else:
        points = _raw_main_points(connection, card_id, language, variant=variant, start=start, end=end)
    if not points:
        return None
    # Stale: the newest observation is too old to be "the price now".
    if points[-1][0] < price_quality.stale_cutoff(today):
        return None
    # A newest point that teleported from the one before is a glitch, not a price.
    if len(points) >= 2 and has_outlier_step([points[-2][1], points[-1][1]], max_multiple=MAX_STEP_MULTIPLE):
        return None
    points = _drop_spikes(points)
    current = points[-1][1]
    if not graded and condition_code in (None, "NM"):
        facts = price_quality.load_price_quality(connection, [card_id]).get(card_id) or {}
        psa10 = (facts.get("psa10") or {}).get(_variant_match_key(_normalized_variant_label(variant)))
        if psa10 is not None and current > psa10 * price_quality.RAW_OVER_PSA10_MARGIN:
            return None
    first = date.fromisoformat(points[0][0])
    label = NEUTRAL_WINDOW
    window_points = points
    for days in POSITION_WINDOWS:
        window_start = today - timedelta(days=days)
        if first <= window_start + timedelta(days=COVERED_SLACK_DAYS.get(days, 7)):
            label = WINDOW_PHRASES.get(days, NEUTRAL_WINDOW)
            window_points = [p for p in points if p[0] >= window_start.isoformat()]
            break
    else:
        if (date.fromisoformat(points[-1][0]) - first).days < POSITION_MIN_SPAN_DAYS:
            return None
    values = [value for _, value in window_points]
    if len({round(v, 2) for v in values}) < MIN_DISTINCT_PRICES:
        return None
    low, high = min(values), max(values)
    if high <= low:
        return None
    return {
        "currentUsd": round(current, 2),
        "lowUsd": round(low, 2),
        "highUsd": round(high, 2),
        "percentile": round((current - low) / (high - low) * 100.0),
        "windowLabel": label,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compute the market_analytics tables.")
    parser.add_argument("--compute", action="store_true", required=True)
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--as-of", help="Pretend today is this date (stale local DBs).")
    args = parser.parse_args(argv)
    connection = connect(Path(args.database_path), timeout_seconds=30.0)
    today = date.fromisoformat(args.as_of) if args.as_of else None
    print(refresh_market_analytics(connection, force=args.force, today=today))
    return 0


if __name__ == "__main__":
    sys.exit(main())
