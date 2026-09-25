"""Watchlist empty state: "Suggest cards to watch" from the caller's own scans.

``build_watchlist_suggestions`` returns cards the owner scanned in the last
``WINDOW_DAYS`` that they neither own (deck_entries quantity > 0) nor already
watch (card_favorites), sealed products excluded, one row per card, newest scan
first. Every read is scoped to ``owner_user_id``; no owner → empty list.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from catalog_tools import SEALED_SUPERTYPE, _table_columns, _table_exists
from feed_prices import raw_price_changes, round_money

WINDOW_DAYS = 30
DEFAULT_LIMIT = 6
MAX_LIMIT = 12


def clamp_limit(value: Any) -> int:
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return max(1, min(limit, MAX_LIMIT))


def _suggested_card_rows(
    connection: sqlite3.Connection,
    owner_user_id: str,
    *,
    limit: int,
    since: str,
) -> list[sqlite3.Row | tuple]:
    game_col = "c.game" if "game" in _table_columns(connection, "cards") else "'pokemon'"
    # A missing favorites table (fresh test DBs) just means "watches nothing".
    not_watched = (
        "AND NOT EXISTS (SELECT 1 FROM card_favorites f "
        "WHERE f.owner_user_id = ? AND f.card_id = s.card_id)"
        if _table_exists(connection, "card_favorites")
        else ""
    )
    params: list[Any] = [owner_user_id, since, SEALED_SUPERTYPE, owner_user_id]
    if not_watched:
        params.append(owner_user_id)
    params.append(limit)
    return connection.execute(
        f"""
        SELECT s.card_id, MAX(s.created_at) AS last_scanned_at,
               c.name, c.number, c.set_name, c.language, c.image_small_url, c.image_url,
               {game_col} AS game
        FROM (
            SELECT COALESCE(
                       NULLIF(confirmed_card_id, ''),
                       NULLIF(selected_card_id, ''),
                       NULLIF(predicted_card_id, '')
                   ) AS card_id,
                   created_at
            FROM scan_events
            WHERE owner_user_id = ?
              AND created_at >= ?
        ) s
        JOIN cards c ON c.id = s.card_id
        WHERE COALESCE(c.supertype, '') <> ?
          AND NOT EXISTS (
              SELECT 1 FROM deck_entries d
              WHERE d.owner_user_id = ? AND d.card_id = s.card_id AND d.quantity > 0
          )
          {not_watched}
        GROUP BY s.card_id
        ORDER BY last_scanned_at DESC, s.card_id ASC
        LIMIT ?
        """,
        params,
    ).fetchall()


def build_watchlist_suggestions(
    connection: sqlite3.Connection,
    owner_user_id: str | None,
    *,
    limit: Any = DEFAULT_LIMIT,
    now: datetime | None = None,
) -> dict[str, Any]:
    owner = str(owner_user_id or "").strip()
    safe_limit = clamp_limit(limit)
    if not owner:
        return {"items": [], "limit": safe_limit}
    since = ((now or datetime.now(timezone.utc)) - timedelta(days=WINDOW_DAYS)).isoformat()
    rows = _suggested_card_rows(connection, owner, limit=safe_limit, since=since)
    card_ids = [str(row[0]) for row in rows]
    # Same cheap raw-main price read as the PDP "More like this" rows.
    prices = {cid: p.price_now for cid, p in raw_price_changes(connection, card_ids).items()}
    items = [
        {
            "cardId": str(row[0]),
            "name": row[2],
            "number": row[3],
            "setName": row[4],
            "language": row[5],
            "imageUrl": row[6] or row[7],
            "game": row[8] or "pokemon",
            "priceNow": round_money(prices.get(str(row[0]))),
            "currencyCode": "USD",
            "lastScannedAt": row[1],
        }
        for row in rows
    ]
    return {"items": items, "limit": safe_limit}
