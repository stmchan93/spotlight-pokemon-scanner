"""Set spotlight: one set a week, with its top cards by price, movers and PSA 10.

The daily job (``compute_set_spotlight``, run by ``run_set_spotlight_vm.sh``)
keeps one pick per ISO week and re-stores that pick's payload so prices stay
current. ``build_set_spotlight_payload`` serves the stored pick, or builds any
other set on demand from indexed reads (the set's card ids → history by
``(card_id, price_date)``, graded cells by the ``lane = 'graded'`` partial
index) — never a scan of ``card_price_history_cell``.

Pick rule: among sets with >= MIN_PRICED_CARDS cards priced like-for-like at
both ends of the 7-day window (and at least MIN_SET_VALUE_USD of value), take
the biggest absolute % move in the summed raw value. Ties (to 0.1%) go to the
set more distinct users looked at or scanned in the last 7 days. Last week's
set is skipped whenever any other set qualifies.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import news_feed
from catalog_tools import _table_columns, _table_exists, utc_now
from feed_prices import (
    RawPrice,
    latest_price_date,
    raw_price_changes,
    raw_price_changes_all,
    round_money,
    round_pct,
)
from fx_rates import convert_price
from market_movers import DEFAULT_MAX_CHANGE_PCT, DEFAULT_MIN_PRICE_USD, _jpy_usd_rate

WINDOW_DAYS = 7
DEFAULT_MIN_PRICED_CARDS = 20
DEFAULT_MIN_SET_VALUE_USD = 25.0
TOP_LIMIT = 10
NEWS_LIMIT = 5
ATTENTION_DAYS = 7
# Graded cells for one grade are sparse; tolerate a stale end like the raw lane.
GRADED_NOW_TOLERANCE_DAYS = 3
GRADED_THEN_TOLERANCE_DAYS = 7
PSA10_GRADES = ("10", "10.0")
PSA_GRADERS = ("PSA", "psa")


def _env_int(name: str, default: int) -> int:
    try:
        return int(str(os.environ.get(name) or "").strip() or default)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(str(os.environ.get(name) or "").strip() or default)
    except ValueError:
        return default


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS set_spotlight_picks (
            week_start TEXT PRIMARY KEY,
            set_id TEXT NOT NULL,
            game TEXT NOT NULL,
            value_change_percent REAL,
            attention_users INTEGER NOT NULL DEFAULT 0,
            priced_cards INTEGER NOT NULL DEFAULT 0,
            picked_at TEXT NOT NULL,
            computed_at TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}'
        )
        """
    )


def week_start_for(day: date) -> str:
    return (day - timedelta(days=day.weekday())).isoformat()


# --- pick ----------------------------------------------------------------


def _card_sets(connection: sqlite3.Connection) -> dict[str, tuple[str, str]]:
    """{card_id: (set_id, game)} for every card that belongs to a set."""
    game_col = "game" if "game" in _table_columns(connection, "cards") else "'pokemon'"
    return {
        str(row[0]): (str(row[1]), str(row[2] or "pokemon"))
        for row in connection.execute(
            f"SELECT id, set_id, {game_col} FROM cards WHERE set_id IS NOT NULL AND set_id != ''"
        )
    }


def set_value_moves(
    prices: dict[str, RawPrice],
    card_sets: dict[str, tuple[str, str]],
    *,
    min_priced_cards: int,
    min_set_value_usd: float,
) -> list[dict[str, Any]]:
    """Per-set summed raw value then→now over like-for-like pairs only."""
    totals: dict[str, dict[str, Any]] = {}
    for card_id, price in prices.items():
        if price.price_then is None or price.change_pct is None:
            continue
        set_info = card_sets.get(card_id)
        if set_info is None:
            continue
        entry = totals.setdefault(set_info[0], {"setId": set_info[0], "game": set_info[1],
                                                "then": 0.0, "now": 0.0, "pricedCards": 0})
        entry["then"] += price.price_then
        entry["now"] += price.price_now
        entry["pricedCards"] += 1
    out: list[dict[str, Any]] = []
    for entry in totals.values():
        if entry["pricedCards"] < min_priced_cards or entry["then"] < min_set_value_usd:
            continue
        entry["changePercent"] = (entry["now"] - entry["then"]) / entry["then"] * 100.0
        out.append(entry)
    return out


def _set_attention(
    connection: sqlite3.Connection, card_sets: dict[str, tuple[str, str]], *, since: str
) -> dict[str, int]:
    """{set_id: distinct users who viewed or scanned any of its cards since ``since``}."""
    users: dict[str, set[str]] = defaultdict(set)
    if _table_exists(connection, "card_views"):
        for row in connection.execute(
            "SELECT owner_user_id, card_id FROM card_views WHERE viewed_at >= ?", (since,)
        ):
            info = card_sets.get(str(row[1]))
            if info and row[0]:
                users[info[0]].add(str(row[0]))
    if _table_exists(connection, "scan_events"):
        for row in connection.execute(
            "SELECT owner_user_id, COALESCE(NULLIF(confirmed_card_id, ''), "
            "NULLIF(selected_card_id, ''), NULLIF(predicted_card_id, '')) "
            "FROM scan_events WHERE created_at >= ?",
            (since,),
        ):
            info = card_sets.get(str(row[1] or ""))
            if info and row[0]:
                users[info[0]].add(str(row[0]))
    return {set_id: len(u) for set_id, u in users.items()}


def choose_pick(moves: list[dict[str, Any]], *, previous_set_id: str | None) -> dict[str, Any] | None:
    """Biggest |%| (to 0.1), then attention, then set id; skip last week's if possible."""
    ranked = sorted(
        moves,
        key=lambda m: (-round(abs(m["changePercent"]), 1), -int(m.get("attention", 0)), m["setId"]),
    )
    for move in ranked:
        if move["setId"] != previous_set_id:
            return move
    return ranked[0] if ranked else None


def compute_set_spotlight(
    connection: sqlite3.Connection,
    *,
    now: datetime | None = None,
    force_repick: bool = False,
    min_priced_cards: int | None = None,
    min_set_value_usd: float | None = None,
) -> dict[str, Any] | None:
    """Pick (once per week) and store this week's set + a fresh payload."""
    ensure_schema(connection)
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    min_priced_cards = (
        min_priced_cards if min_priced_cards is not None
        else _env_int("SET_SPOTLIGHT_MIN_PRICED_CARDS", DEFAULT_MIN_PRICED_CARDS)
    )
    min_set_value_usd = (
        min_set_value_usd if min_set_value_usd is not None
        else _env_float("SET_SPOTLIGHT_MIN_SET_VALUE_USD", DEFAULT_MIN_SET_VALUE_USD)
    )
    week_start = week_start_for(now.date())
    existing = connection.execute(
        "SELECT set_id, game, value_change_percent, attention_users, priced_cards, picked_at "
        "FROM set_spotlight_picks WHERE week_start = ?",
        (week_start,),
    ).fetchone()

    if existing is not None and not force_repick:
        pick = {"setId": str(existing[0]), "game": str(existing[1]), "changePercent": existing[2],
                "attention": int(existing[3]), "pricedCards": int(existing[4])}
        picked_at = str(existing[5])
    else:
        card_sets = _card_sets(connection)
        moves = set_value_moves(
            raw_price_changes_all(connection, window_days=WINDOW_DAYS), card_sets,
            min_priced_cards=min_priced_cards, min_set_value_usd=min_set_value_usd,
        )
        attention = _set_attention(
            connection, card_sets, since=(now - timedelta(days=ATTENTION_DAYS)).isoformat()
        )
        for move in moves:
            move["attention"] = attention.get(move["setId"], 0)
        previous = connection.execute(
            "SELECT set_id FROM set_spotlight_picks WHERE week_start < ? ORDER BY week_start DESC LIMIT 1",
            (week_start,),
        ).fetchone()
        pick = choose_pick(moves, previous_set_id=str(previous[0]) if previous else None)
        if pick is None:
            return None
        picked_at = now.isoformat()

    payload = _build_payload(connection, pick["setId"], computed_at=now.isoformat())
    if payload is None:
        return None
    connection.execute(
        "INSERT OR REPLACE INTO set_spotlight_picks (week_start, set_id, game, value_change_percent, "
        "attention_users, priced_cards, picked_at, computed_at, payload_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (week_start, pick["setId"], pick["game"], pick.get("changePercent"),
         int(pick.get("attention", 0)), int(pick.get("pricedCards", 0)), picked_at,
         now.isoformat(), json.dumps(payload, ensure_ascii=False)),
    )
    connection.commit()
    return {"weekStart": week_start, "setId": pick["setId"], "changePercent": pick.get("changePercent")}


# --- payload -------------------------------------------------------------


def _expansion(connection: sqlite3.Connection, set_id: str) -> dict[str, Any] | None:
    if not _table_exists(connection, "expansions"):
        return None
    game_col = "game" if "game" in _table_columns(connection, "expansions") else "'pokemon'"
    row = connection.execute(
        f"SELECT id, {game_col}, name, code, series, release_date, logo_url FROM expansions WHERE id = ?",
        (set_id,),
    ).fetchone()
    if row is None:
        return None
    return {"setId": str(row[0]), "game": str(row[1] or "pokemon"), "name": row[2], "code": row[3],
            "series": row[4], "releaseDate": row[5], "logoUrl": row[6] or _fallback_logo_url(str(row[0]), row[1])}


def _fallback_logo_url(set_id: str, game: str | None) -> str | None:
    # Staging's frozen catalog lacks expansion rows for older sets; Scrydex serves
    # Pokémon logos at a stable path keyed by the same set id (no API credits).
    if (game or "pokemon") != "pokemon" or not re.fullmatch(r"[a-z0-9_.]+", set_id):
        return None
    return f"https://images.scrydex.com/pokemon/{set_id}-logo/logo"


def _set_cards(connection: sqlite3.Connection, set_id: str) -> list[dict[str, Any]]:
    game_col = "game" if "game" in _table_columns(connection, "cards") else "'pokemon'"
    return [
        {"cardId": str(row[0]), "name": row[1], "number": row[2], "imageUrl": row[3],
         "setName": row[4], "game": row[5], "series": row[6], "releaseDate": row[7], "code": row[8]}
        for row in connection.execute(
            f"SELECT id, name, number, image_small_url, set_name, {game_col}, set_series, "
            "set_release_date, set_ptcgo_code FROM cards WHERE set_id = ?",
            (set_id,),
        )
    ]


_CELL_COLUMNS = (
    "card_id, provider, variant_key, price_date, currency_code, market, "
    "is_perfect, is_signed, is_error"
)


def _psa10_cell_rows(connection: sqlite3.Connection, card_ids: list[str], *, window_days: int) -> list[Any]:
    """PSA 10 graded cells for ~2 weeks back from the newest graded date.

    Without ANALYZE stats the planner picks ``idx_cell_identity`` (card_id
    prefix = every cell of every date), so the graded partial index is forced.
    Where that index is missing, fall back to a date-bounded identity seek."""
    grader_ph = ",".join("?" for _ in PSA_GRADERS)
    grade_ph = ",".join("?" for _ in PSA10_GRADES)
    span = window_days + GRADED_THEN_TOLERANCE_DAYS
    rows: list[Any] = []
    for offset in range(0, len(card_ids), 400):
        chunk = card_ids[offset : offset + 400]
        placeholders = ",".join("?" for _ in chunk)
        where = (
            f"card_id IN ({placeholders}) AND lane = 'graded' "
            f"AND grader IN ({grader_ph}) AND grade IN ({grade_ph})"
        )
        params = (*chunk, *PSA_GRADERS, *PSA10_GRADES)
        try:
            max_row = connection.execute(
                "SELECT MAX(price_date) FROM card_price_history_cell "
                f"INDEXED BY idx_cell_graded_lookup WHERE {where}",
                params,
            ).fetchone()
            if max_row is None or not max_row[0]:
                continue
            start = (date.fromisoformat(str(max_row[0])[:10]) - timedelta(days=span)).isoformat()
            rows.extend(
                connection.execute(
                    f"SELECT {_CELL_COLUMNS} FROM card_price_history_cell "
                    f"INDEXED BY idx_cell_graded_lookup WHERE {where} AND price_date >= ?",
                    (*params, start),
                ).fetchall()
            )
        except sqlite3.OperationalError:
            ref = latest_price_date(connection)
            if ref is None:
                return []
            rows.extend(
                connection.execute(
                    f"SELECT {_CELL_COLUMNS} FROM card_price_history_cell "
                    f"WHERE {where} AND price_date BETWEEN ? AND ?",
                    (*params, (ref - timedelta(days=span)).isoformat(), ref.isoformat()),
                ).fetchall()
            )
    return rows


def psa10_price_changes(
    connection: sqlite3.Connection, card_ids: list[str], *, window_days: int = WINDOW_DAYS
) -> dict[str, dict[str, float | None]]:
    """{card_id: {priceNow, priceThen, changePct}} for plain PSA 10 cells (no
    perfect/signed/error), same variant at both ends. Empty when the cell table
    is absent or has no graded rows (staging writes none by design)."""
    if not card_ids or not _table_exists(connection, "card_price_history_cell"):
        return {}
    rows = _psa10_cell_rows(connection, card_ids, window_days=window_days)
    if not rows:
        return {}
    ref = max(date.fromisoformat(str(r[3])[:10]) for r in rows)
    now_start = (ref - timedelta(days=GRADED_NOW_TOLERANCE_DAYS)).isoformat()
    then_end_date = ref - timedelta(days=window_days)
    then_end = then_end_date.isoformat()
    then_start = (then_end_date - timedelta(days=GRADED_THEN_TOLERANCE_DAYS)).isoformat()
    jpy_usd: Decimal | None = _jpy_usd_rate(connection)

    # {(card, variant): {"now": usd, "then": usd}}; Scrydex rows win over others.
    series: dict[tuple[str, str], dict[str, Any]] = {}
    for row in sorted(rows, key=lambda r: (str(r[1] or "") != "scrydex",)):
        if row[6] or row[7] or row[8]:
            continue
        market = row[5]
        if market is None or float(market) <= 0:
            continue
        currency = str(row[4] or "USD").upper()
        if currency == "JPY":
            usd = convert_price(float(market), rate=jpy_usd) if jpy_usd is not None else None
        elif currency == "USD":
            usd = float(market)
        else:
            usd = None
        if usd is None:
            continue
        key = (str(row[0]), str(row[2] or ""))
        entry = series.setdefault(key, {"provider": row[1], "now": None, "then": None,
                                        "now_date": "", "then_date": ""})
        if entry["provider"] != row[1]:
            continue
        price_date = str(row[3])
        if now_start <= price_date and price_date > entry["now_date"]:
            entry["now"], entry["now_date"] = usd, price_date
        elif then_start <= price_date <= then_end and price_date > entry["then_date"]:
            entry["then"], entry["then_date"] = usd, price_date

    out: dict[str, dict[str, float | None]] = {}
    for (card_id, _variant), entry in series.items():
        if entry["now"] is None:
            continue
        current = out.get(card_id)
        # One variant per card: the most valuable PSA 10 printing.
        if current is not None and current["priceNow"] >= entry["now"]:
            continue
        then = entry["then"]
        pct = (entry["now"] - then) / then * 100.0 if then else None
        if pct is not None and abs(pct) > DEFAULT_MAX_CHANGE_PCT:
            pct = None
        out[card_id] = {"priceNow": entry["now"], "priceThen": then, "changePct": pct}
    return out


def _collectors_count(connection: sqlite3.Connection, card_ids: list[str]) -> int:
    if not card_ids or not _table_exists(connection, "deck_entries"):
        return 0
    owners: set[str] = set()
    for offset in range(0, len(card_ids), 900):
        chunk = card_ids[offset : offset + 900]
        placeholders = ",".join("?" for _ in chunk)
        for row in connection.execute(
            f"SELECT DISTINCT owner_user_id FROM deck_entries WHERE card_id IN ({placeholders}) "
            "AND quantity > 0 AND owner_user_id IS NOT NULL AND owner_user_id != ''",
            tuple(chunk),
        ):
            owners.add(str(row[0]))
    return len(owners)


def _value_change(pairs: list[tuple[float, float]]) -> float | None:
    then_total = sum(t for t, _ in pairs)
    if not pairs or then_total <= 0:
        return None
    return (sum(n for _, n in pairs) - then_total) / then_total * 100.0


def _spot_card(card: dict[str, Any], *, lane: str, price_now: float, pct: float | None) -> dict[str, Any]:
    graded = lane == "graded"
    return {
        "cardId": card["cardId"],
        "name": card["name"],
        "number": card["number"],
        "imageUrl": card["imageUrl"],
        "lane": lane,
        "grader": "PSA" if graded else None,
        "grade": "10" if graded else None,
        "priceNow": round_money(price_now),
        "changePercent7d": round_pct(pct),
        "currencyCode": "USD",
    }


def _direction(pct: float) -> str:
    return "up" if pct >= 0 else "down"


def build_callout(
    set_name: str,
    top_psa10: list[dict[str, Any]],
    top_movers: list[dict[str, Any]],
    raw_by_id: dict[str, dict[str, Any]],
    value_change_pct: float | None,
) -> dict[str, str] | None:
    """Template text (no LLM): the biggest PSA 10 mover, else the biggest raw mover."""
    psa_moved = [c for c in top_psa10 if c["changePercent7d"] not in (None, 0)]
    if psa_moved:
        card = max(psa_moved, key=lambda c: abs(c["changePercent7d"]))
        pct = card["changePercent7d"]
        title = f"{card['name']} PSA 10 is {_direction(pct)} {abs(pct):.0f}% this week"
        raw = raw_by_id.get(card["cardId"])
        if raw and raw.get("changePercent7d") is not None:
            body = f"Raw copies {raw['changePercent7d']:+.1f}%."
        else:
            body = f"Now ${card['priceNow']:,.2f} for a PSA 10."
    else:
        raw_moved = [c for c in top_movers if c["changePercent7d"] not in (None, 0)]
        if not raw_moved:
            return None
        card = raw_moved[0]
        pct = card["changePercent7d"]
        title = f"{card['name']} is {_direction(pct)} {abs(pct):.0f}% this week"
        body = f"Now ${card['priceNow']:,.2f} raw."
    if value_change_pct is not None:
        body += f" {set_name} is {value_change_pct:+.1f}% overall over 7 days."
    return {"cardId": card["cardId"], "title": title, "body": body}


def _news_for_set(connection: sqlite3.Connection, set_id: str) -> tuple[list[Any], list[Any]]:
    """(videos by view count, non-video news newest first) tagged to the set.
    No table yet (poller never ran) → empty, without creating it on a read."""
    if not _table_exists(connection, "news_items"):
        return [], []
    return (
        news_feed.news_for_set(connection, set_id, kind="video", limit=NEWS_LIMIT),
        news_feed.news_for_set(connection, set_id, kind="news", limit=NEWS_LIMIT),
    )


def _build_payload(
    connection: sqlite3.Connection, set_id: str, *, computed_at: str | None = None
) -> dict[str, Any] | None:
    cards = _set_cards(connection, set_id)
    header = _expansion(connection, set_id)
    if header is None:
        if not cards:
            return None
        first = cards[0]
        header = {"setId": set_id, "game": first["game"] or "pokemon", "name": first["setName"],
                  "code": first["code"], "series": first["series"],
                  "releaseDate": first["releaseDate"],
                  "logoUrl": _fallback_logo_url(set_id, first["game"])}
    by_id = {c["cardId"]: c for c in cards}
    card_ids = list(by_id)

    raw = raw_price_changes(connection, card_ids, window_days=WINDOW_DAYS)
    psa10 = psa10_price_changes(connection, card_ids)

    value_now = sum(p.price_now for p in raw.values())
    raw_pct = _value_change([(p.price_then, p.price_now) for p in raw.values()
                             if p.price_then is not None and p.change_pct is not None])
    psa_now = sum(p["priceNow"] for p in psa10.values()) if psa10 else None
    psa_pct = _value_change([(p["priceThen"], p["priceNow"]) for p in psa10.values()
                             if p["priceThen"] is not None and p["changePct"] is not None])

    raw_cards = {
        cid: _spot_card(by_id[cid], lane="raw", price_now=p.price_now, pct=p.change_pct)
        for cid, p in raw.items() if cid in by_id
    }
    top_by_price = sorted(raw_cards.values(), key=lambda c: (-c["priceNow"], c["cardId"]))[:TOP_LIMIT]
    top_movers = sorted(
        (c for c in raw_cards.values()
         if c["changePercent7d"] is not None and c["priceNow"] >= DEFAULT_MIN_PRICE_USD),
        key=lambda c: (-abs(c["changePercent7d"]), c["cardId"]),
    )[:TOP_LIMIT]
    top_psa10 = sorted(
        (_spot_card(by_id[cid], lane="graded", price_now=p["priceNow"], pct=p["changePct"])
         for cid, p in psa10.items() if cid in by_id),
        key=lambda c: (-c["priceNow"], c["cardId"]),
    )[:TOP_LIMIT]
    videos, news = _news_for_set(connection, set_id)

    return {
        "computedAt": computed_at or utc_now(),
        "set": {
            "setId": header["setId"],
            "game": header["game"],
            "name": header["name"],
            "code": header["code"],
            "series": header["series"],
            "releaseDate": header["releaseDate"],
            "logoUrl": header["logoUrl"],
            "cardCount": len(cards),
            "valueNow": round(value_now, 2),
            "valueChangePercent7d": round_pct(raw_pct),
            "psa10ValueNow": round_money(psa_now),
            "psa10ChangePercent7d": round_pct(psa_pct),
            "collectorsCount": _collectors_count(connection, card_ids),
        },
        "topByPrice": top_by_price,
        "topMovers": top_movers,
        "topPsa10": top_psa10,
        "callout": build_callout(str(header["name"] or ""), top_psa10, top_movers, raw_cards, raw_pct),
        "videos": videos,
        "news": news,
    }


def build_set_spotlight_payload(
    connection: sqlite3.Connection, *, set_id: str | None = None
) -> dict[str, Any] | None:
    """``SetSpotlight`` for ``set_id`` (None → this week's stored pick).
    Returns None when there is no pick yet or the set is unknown (→ 404)."""
    stored = None
    if _table_exists(connection, "set_spotlight_picks"):
        stored = connection.execute(
            "SELECT set_id, payload_json FROM set_spotlight_picks ORDER BY week_start DESC LIMIT 1"
        ).fetchone()
    if set_id is None:
        if stored is None:
            return None
        set_id = str(stored[0])
    if stored is not None and str(stored[0]) == set_id:
        try:
            payload = json.loads(stored[1] or "{}")
        except ValueError:
            payload = {}
        if payload.get("set"):
            return payload
    return _build_payload(connection, set_id)


def main() -> int:
    from catalog_tools import connect

    parser = argparse.ArgumentParser(description="Pick and store this week's Set spotlight")
    parser.add_argument("--database-path", required=True, type=Path)
    parser.add_argument("--force-repick", action="store_true",
                        help="choose a new set even if this week already has one")
    args = parser.parse_args()
    connection = connect(args.database_path)
    try:
        summary = compute_set_spotlight(connection, force_repick=args.force_repick)
    finally:
        connection.close()
    print(f"[set-spotlight] {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
