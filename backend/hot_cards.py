"""Hot on Ekalight: cards people are checking and scanning right now.

The hourly job (``compute_hot_cards``, run by ``run_hot_cards_vm.sh``) counts
DISTINCT signed-in users per card over the last ``window_hours``, compares that
with the card's own trailing baseline, and stores a small ranked table; the
feed endpoint (``build_hot_cards_payload``) only reads it.

Signals: ``card_views`` (one row per user/card/UTC day, signed-in only) and
``scan_events`` (card = confirmed, else selected, else predicted). A person who
both viewed and scanned a card counts once.

Formula, per card:
  window_rate   = distinct_users * 24 / window_hours          (users per day)
  baseline_rate = distinct (user, day) pairs over the trailing baseline_days
                  before the window / baseline_days
  baseline_ratio = window_rate / max(baseline_rate, BASELINE_FLOOR)
  score          = distinct_users * baseline_ratio
The floor (default 1 user/day) keeps a never-seen card from getting an
infinite ratio: its ratio is then just its window rate, so a brand-new card
needs real breadth to outrank a staple that doubled.

Per-user cap: each user counts toward at most PER_USER_CAP cards per window.
A vendor scanning a 300-card binder would otherwise add +1 to 300 cards and
flatten the ranking. Capping (rather than fractional 1/n weights) keeps
``distinctUsers`` an honest integer count of people. Which cards survive the
cap is deterministic: deliberate card-page views first, then scans, earliest
first. The baseline is NOT capped — a vendor inflating a card's baseline only
lowers its ratio, which errs toward hiding it.

Gates: the whole block is ``eligible`` only when at least MIN_DISTINCT_USERS
signed-in users were active in the window, and a card is listed only with at
least MIN_CARD_USERS distinct users. Below the gate the payload has no items.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from catalog_tools import _table_exists, utc_now
from feed_prices import raw_price_changes, round_money, round_pct
from market_movers import _card_games, _card_metadata

DEFAULT_WINDOW_HOURS = 24
DEFAULT_BASELINE_DAYS = 14
DEFAULT_MIN_DISTINCT_USERS = 15
DEFAULT_MIN_CARD_USERS = 3
DEFAULT_PER_USER_CAP = 25
DEFAULT_BASELINE_FLOOR = 1.0
PAYLOAD_LIMIT = 10
STORE_LIMIT = 100  # enough for a per-game top 10 from the stored global list
KEEP_RUNS = 72

_VIEW = 0
_SCAN = 1


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
        CREATE TABLE IF NOT EXISTS hot_cards_runs (
            computed_at TEXT PRIMARY KEY,
            window_hours INTEGER NOT NULL,
            baseline_days INTEGER NOT NULL,
            min_distinct_users INTEGER NOT NULL,
            min_card_users INTEGER NOT NULL,
            per_user_cap INTEGER NOT NULL,
            active_users INTEGER NOT NULL,
            eligible INTEGER NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS hot_cards (
            computed_at TEXT NOT NULL,
            rank INTEGER NOT NULL,
            card_id TEXT NOT NULL,
            game TEXT NOT NULL,
            distinct_users INTEGER NOT NULL,
            baseline_rate REAL NOT NULL,
            baseline_ratio REAL NOT NULL,
            score REAL NOT NULL,
            price_now REAL,
            change_percent_7d REAL,
            PRIMARY KEY (computed_at, card_id)
        )
        """
    )


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _scan_card_expr() -> str:
    return (
        "COALESCE(NULLIF(confirmed_card_id, ''), NULLIF(selected_card_id, ''), "
        "NULLIF(predicted_card_id, ''))"
    )


def _window_events(
    connection: sqlite3.Connection, *, start: str, end: str
) -> dict[str, list[tuple[int, str, str]]]:
    """{user: [(kind, timestamp, card_id)]} for signed-in activity in [start, end]."""
    events: dict[str, list[tuple[int, str, str]]] = defaultdict(list)
    if _table_exists(connection, "card_views"):
        for row in connection.execute(
            "SELECT owner_user_id, card_id, viewed_at FROM card_views "
            "WHERE viewed_at >= ? AND viewed_at <= ?",
            (start, end),
        ):
            user = str(row[0] or "").strip()
            if user and row[1]:
                events[user].append((_VIEW, str(row[2]), str(row[1])))
    if _table_exists(connection, "scan_events"):
        for row in connection.execute(
            f"SELECT owner_user_id, {_scan_card_expr()}, created_at FROM scan_events "
            "WHERE created_at >= ? AND created_at <= ?",
            (start, end),
        ):
            user = str(row[0] or "").strip()
            if user and row[1]:
                events[user].append((_SCAN, str(row[2]), str(row[1])))
    return events


def capped_card_users(
    events: dict[str, list[tuple[int, str, str]]], *, per_user_cap: int
) -> dict[str, set[str]]:
    """{card_id: users}, each user counted on at most ``per_user_cap`` cards."""
    card_users: dict[str, set[str]] = defaultdict(set)
    for user, user_events in events.items():
        kept: list[str] = []
        seen: set[str] = set()
        for _, _, card_id in sorted(user_events):
            if card_id in seen:
                continue
            seen.add(card_id)
            kept.append(card_id)
            if len(kept) >= per_user_cap:
                break
        for card_id in kept:
            card_users[card_id].add(user)
    return card_users


def _baseline_user_days(
    connection: sqlite3.Connection, card_ids: Iterable[str], *, start: str, end: str
) -> dict[str, set[tuple[str, str]]]:
    """{card_id: {(user, day)}} over [start, end) for the candidate cards."""
    wanted = set(card_ids)
    out: dict[str, set[tuple[str, str]]] = defaultdict(set)
    if not wanted:
        return out
    if _table_exists(connection, "card_views"):
        ids = list(wanted)
        for offset in range(0, len(ids), 900):
            chunk = ids[offset : offset + 900]
            placeholders = ",".join("?" for _ in chunk)
            # (card_id, viewed_at, owner_user_id) index serves this index-only.
            for row in connection.execute(
                "SELECT card_id, owner_user_id, viewed_at FROM card_views "
                f"WHERE card_id IN ({placeholders}) AND viewed_at >= ? AND viewed_at < ?",
                (*chunk, start, end),
            ):
                user = str(row[1] or "").strip()
                if user:
                    out[str(row[0])].add((user, str(row[2])[:10]))
    if _table_exists(connection, "scan_events"):
        for row in connection.execute(
            f"SELECT owner_user_id, {_scan_card_expr()}, created_at FROM scan_events "
            "WHERE created_at >= ? AND created_at < ?",
            (start, end),
        ):
            user = str(row[0] or "").strip()
            card_id = str(row[1] or "")
            if user and card_id in wanted:
                out[card_id].add((user, str(row[2])[:10]))
    return out


def baseline_ratio(
    distinct_users: int, baseline_rate: float, *, window_hours: int, floor: float
) -> float:
    window_rate = distinct_users * 24.0 / max(window_hours, 1)
    return window_rate / max(baseline_rate, floor, 1e-9)


def compute_hot_cards(
    connection: sqlite3.Connection,
    *,
    now: datetime | None = None,
    window_hours: int = DEFAULT_WINDOW_HOURS,
    baseline_days: int = DEFAULT_BASELINE_DAYS,
    min_distinct_users: int | None = None,
    min_card_users: int | None = None,
    per_user_cap: int | None = None,
    baseline_floor: float | None = None,
) -> dict[str, Any]:
    """Compute and store one run. Returns a small summary for the job log."""
    ensure_schema(connection)
    min_distinct_users = (
        min_distinct_users if min_distinct_users is not None
        else _env_int("HOT_CARDS_MIN_DISTINCT_USERS", DEFAULT_MIN_DISTINCT_USERS)
    )
    min_card_users = (
        min_card_users if min_card_users is not None
        else _env_int("HOT_CARDS_MIN_CARD_USERS", DEFAULT_MIN_CARD_USERS)
    )
    per_user_cap = (
        per_user_cap if per_user_cap is not None
        else _env_int("HOT_CARDS_PER_USER_CAP", DEFAULT_PER_USER_CAP)
    )
    baseline_floor = (
        baseline_floor if baseline_floor is not None
        else _env_float("HOT_CARDS_BASELINE_FLOOR", DEFAULT_BASELINE_FLOOR)
    )
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    window_start = now - timedelta(hours=window_hours)
    computed_at = _iso(now)

    events = _window_events(connection, start=_iso(window_start), end=computed_at)
    active_users = len(events)
    card_users = capped_card_users(events, per_user_cap=max(per_user_cap, 1))
    candidates = {cid: len(users) for cid, users in card_users.items() if len(users) >= min_card_users}
    games = _card_games(connection, list(candidates))
    # Drop ids with no catalog row (stale predictions, deleted cards).
    known = set(_card_metadata(connection, list(candidates)))
    candidates = {cid: n for cid, n in candidates.items() if cid in known}

    baseline = _baseline_user_days(
        connection, candidates,
        start=_iso(window_start - timedelta(days=baseline_days)), end=_iso(window_start),
    )
    ranked: list[dict[str, Any]] = []
    for card_id, users in candidates.items():
        rate = len(baseline.get(card_id, ())) / max(baseline_days, 1)
        ratio = baseline_ratio(users, rate, window_hours=window_hours, floor=baseline_floor)
        ranked.append(
            {
                "card_id": card_id,
                "game": games.get(card_id, "pokemon"),
                "distinct_users": users,
                "baseline_rate": rate,
                "baseline_ratio": ratio,
                "score": users * ratio,
            }
        )
    ranked.sort(key=lambda r: (-r["score"], -r["distinct_users"], r["card_id"]))
    ranked = ranked[:STORE_LIMIT]
    prices = raw_price_changes(connection, [r["card_id"] for r in ranked])
    eligible = active_users >= min_distinct_users

    connection.execute(
        "INSERT OR REPLACE INTO hot_cards_runs (computed_at, window_hours, baseline_days, "
        "min_distinct_users, min_card_users, per_user_cap, active_users, eligible) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (computed_at, window_hours, baseline_days, min_distinct_users, min_card_users,
         per_user_cap, active_users, 1 if eligible else 0),
    )
    connection.execute("DELETE FROM hot_cards WHERE computed_at = ?", (computed_at,))
    connection.executemany(
        "INSERT INTO hot_cards (computed_at, rank, card_id, game, distinct_users, baseline_rate, "
        "baseline_ratio, score, price_now, change_percent_7d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                computed_at, rank, r["card_id"], r["game"], r["distinct_users"],
                r["baseline_rate"], r["baseline_ratio"], r["score"],
                round_money(prices[r["card_id"]].price_now) if r["card_id"] in prices else None,
                round_pct(prices[r["card_id"]].change_pct) if r["card_id"] in prices else None,
            )
            for rank, r in enumerate(ranked, start=1)
        ],
    )
    _prune_runs(connection)
    connection.commit()
    return {
        "computedAt": computed_at,
        "activeUsers": active_users,
        "eligible": eligible,
        "cards": len(ranked),
    }


def _prune_runs(connection: sqlite3.Connection) -> None:
    rows = connection.execute(
        "SELECT computed_at FROM hot_cards_runs ORDER BY computed_at DESC LIMIT -1 OFFSET ?",
        (KEEP_RUNS,),
    ).fetchall()
    for row in rows:
        connection.execute("DELETE FROM hot_cards WHERE computed_at = ?", (row[0],))
        connection.execute("DELETE FROM hot_cards_runs WHERE computed_at = ?", (row[0],))


def build_hot_cards_payload(connection: sqlite3.Connection, *, game: str | None = None) -> dict[str, Any]:
    """``HotCards`` from the newest stored run; ``game`` None = all games."""
    empty = {
        "computedAt": utc_now(),
        "windowHours": DEFAULT_WINDOW_HOURS,
        "minDistinctUsers": _env_int("HOT_CARDS_MIN_CARD_USERS", DEFAULT_MIN_CARD_USERS),
        "eligible": False,
        "items": [],
    }
    if not _table_exists(connection, "hot_cards_runs"):
        return empty
    run = connection.execute(
        "SELECT computed_at, window_hours, min_card_users, eligible FROM hot_cards_runs "
        "ORDER BY computed_at DESC LIMIT 1"
    ).fetchone()
    if run is None:
        return empty
    payload = {
        "computedAt": str(run[0]),
        "windowHours": int(run[1]),
        "minDistinctUsers": int(run[2]),
        "eligible": bool(run[3]),
        "items": [],
    }
    if not payload["eligible"]:
        return payload
    sql = (
        "SELECT card_id, game, distinct_users, baseline_ratio, price_now, change_percent_7d "
        "FROM hot_cards WHERE computed_at = ?"
    )
    params: list[Any] = [run[0]]
    if game:
        sql += " AND game = ?"
        params.append(game)
    sql += " ORDER BY rank LIMIT ?"
    params.append(PAYLOAD_LIMIT)
    rows = connection.execute(sql, params).fetchall()
    metadata = _card_metadata(connection, [str(r[0]) for r in rows])
    for row in rows:
        meta = metadata.get(str(row[0]))
        if meta is None:
            continue
        payload["items"].append(
            {
                "cardId": str(row[0]),
                "game": str(row[1]),
                "name": meta["name"],
                "number": meta["number"],
                "setName": meta["setName"],
                "imageUrl": meta["imageUrl"],
                "distinctUsers": int(row[2]),
                "baselineRatio": round(float(row[3]), 1),
                "priceNow": row[4],
                "changePercent7d": row[5],
                "currencyCode": "USD",
            }
        )
    return payload


def main() -> int:
    from catalog_tools import connect

    parser = argparse.ArgumentParser(description="Compute the Hot on Ekalight table")
    parser.add_argument("--database-path", required=True, type=Path)
    parser.add_argument("--window-hours", type=int, default=DEFAULT_WINDOW_HOURS)
    parser.add_argument("--baseline-days", type=int, default=DEFAULT_BASELINE_DAYS)
    args = parser.parse_args()
    connection = connect(args.database_path)
    try:
        summary = compute_hot_cards(
            connection, window_hours=args.window_hours, baseline_days=args.baseline_days
        )
    finally:
        connection.close()
    print(f"[hot-cards] {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
