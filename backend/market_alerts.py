"""Market alerts: price-move pushes, the Sunday summary, and the ONE per-user
push limiter that watchlist deal alerts also route through.

Seams
-----
- ``expo_push`` owns delivery (message shape, batching, tickets, receipts).
  This module decides WHO gets WHICH push WHEN and writes the ledger.
- ``feed_prices.raw_price_changes`` owns the pricing lane rules (TCGCSV main
  lane first, Scrydex default-raw fallback, same source + same printing at
  both ends, glitch filter). Nothing here re-derives a price.
- Prefs live on the existing ``user_notification_prefs`` row (ABSENT ROW = ON,
  same contract as the deal lane). "Deals under market" IS the existing
  ``deal_alerts_enabled`` column, so the Account toggle and this screen can
  never disagree.

The limiter (all silent; nothing is ever surfaced to the user)
--------------------------------------------------------------
1. Quiet hours 21:00-09:00 in the user's local timezone. Nothing is dropped:
   the hourly job simply does not send, and the first run at/after 09:00 picks
   up whatever is still pending (price moves are re-derived from the day's
   prices; unsent deals stay ``push_sent_at IS NULL`` for up to 24h).
2. At most ONE push per user per local day. Pending deals win over price
   moves (a listing can sell; a price move will still be true tomorrow).
   Several price moves become one push: "Latios ☆ +12% and 2 more".
3. The weekly summary (Sunday 17:00-21:00 local) is NOT held back by rule 2:
   it is once a week, and losing it because a deal pushed that morning would
   lose the week. It still counts as that day's push, so nothing follows it.
4. The same card is pushed at most once per 3 days, unless its price has moved
   another >= 10% since the price it was last alerted at.

Every claim is a UNIQUE ledger row committed BEFORE any message is assembled
(``market_alert_pushes.dedupe_key``), so a crash or an overlapping run loses a
push rather than sending a second one — the same at-most-once rule as the
deal lane.

Owner scoping: every read is ``WHERE owner_user_id = ?`` (or an IN-list of
owners that each get only their own rows back). No push is built from another
owner's holdings, watchlist, prefs or tokens.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import expo_push
from catalog_tools import _table_columns
from feed_prices import RawPrice, _resolve, latest_price_date, raw_price_changes
from market_movers import DEFAULT_MAX_CHANGE_PCT, _as_float, _DailyRow, _jpy_usd_rate

ENABLED_ENV = "MARKET_ALERTS_ENABLED"
DEFAULT_TIMEZONE = "America/Los_Angeles"

MOVE_MIN_PCT = 10.0
MOVE_MIN_USD = 5.0
# A "now" price older than this (vs the user's local date) is not "today's" move.
MOVE_MAX_STALENESS_DAYS = 2
# "Previous day" = the card's newest earlier row, within this many days (a
# missed sync day must not hide a move; a month-old row is not "yesterday").
PREVIOUS_DAY_MAX_GAP_DAYS = 3
CARD_COOLDOWN_DAYS = 3
CARD_REARM_PCT = 10.0

QUIET_START_HOUR = 21
QUIET_END_HOUR = 9

WEEKLY_WEEKDAY = 6  # Sunday (date.weekday())
WEEKLY_HOUR = 17
WEEKLY_WINDOW_DAYS = 7

PENDING_DEAL_MAX_AGE_HOURS = 24
RECEIPT_SWEEP_DAYS = 2

KIND_PRICE_MOVE = "price_move"
KIND_WEEKLY_SUMMARY = "weekly_summary"
KIND_DEAL = "deal"
ALL_KINDS = (KIND_PRICE_MOVE, KIND_WEEKLY_SUMMARY, KIND_DEAL)

DATA_TYPE_PRICE_MOVE = "price_move"
DATA_TYPE_WEEKLY_SUMMARY = "weekly_summary"

# Created app-side (push-notifications.ts); deals keep their own channel.
MARKET_CHANNEL_ID = "market"

COLLECTION_DEEP_LINK = "/"
WATCHLIST_DEEP_LINK = expo_push.WATCHLIST_DEEP_LINK

Sender = Callable[[Sequence[expo_push.PushMessage]], expo_push.PushResult]


def is_enabled(environ: Mapping[str, str] | None = None) -> bool:
    value = (environ if environ is not None else os.environ).get(ENABLED_ENV, "")
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


# --- schema ------------------------------------------------------------------


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", (table,)
    ).fetchone()
    return row is not None


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}


def _add_column(connection: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    if _table_exists(connection, table) and column not in _columns(connection, table):
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def ensure_schema(connection: sqlite3.Connection) -> None:
    """Small tables + ALTER ADD COLUMNs only (crash-loop rule: nothing here
    rebuilds or indexes a populated big table). The prefs/token tables are
    created by server.py's deal-radar patch; this only extends them."""
    _add_column(connection, "user_notification_prefs", "price_moves_enabled", "INTEGER NOT NULL DEFAULT 1")
    _add_column(connection, "user_notification_prefs", "weekly_summary_enabled", "INTEGER NOT NULL DEFAULT 1")
    _add_column(connection, "user_notification_prefs", "timezone", "TEXT")
    # The device's IANA zone, sent with every token registration.
    _add_column(connection, "user_push_tokens", "timezone", "TEXT")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS market_alert_pushes (
            id TEXT PRIMARY KEY,
            owner_user_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            local_date TEXT NOT NULL,
            dedupe_key TEXT NOT NULL,
            timezone TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            push_ticket_id TEXT,
            push_tickets_json TEXT,
            receipts_checked_at TEXT
        )
        """
    )
    # THE claim: one daily push and one weekly push per (owner, local date).
    connection.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_market_alert_pushes_dedupe
        ON market_alert_pushes (owner_user_id, dedupe_key)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_market_alert_pushes_created
        ON market_alert_pushes (created_at)
        """
    )
    # Per-card cooldown memory: when and at what price we last pushed it.
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS market_alert_card_state (
            owner_user_id TEXT NOT NULL,
            card_id TEXT NOT NULL,
            last_alerted_at TEXT NOT NULL,
            last_price_usd REAL NOT NULL,
            PRIMARY KEY (owner_user_id, card_id)
        )
        """
    )


# --- timezone + prefs ----------------------------------------------------------


def normalize_timezone(value: Any) -> str | None:
    """A valid IANA zone name, or None."""
    name = str(value or "").strip()
    if not name or len(name) > 64:
        return None
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None
    return name


def _zone(name: str | None) -> ZoneInfo:
    return ZoneInfo(normalize_timezone(name) or DEFAULT_TIMEZONE)


DEFAULT_PREFS = {
    "priceMovesEnabled": True,
    "weeklySummaryEnabled": True,
    "dealAlertsEnabled": True,
}


def _prefs_from_row(row: Mapping[str, Any] | None) -> dict[str, Any]:
    if row is None:
        return {**DEFAULT_PREFS, "timezone": None}
    keys = set(row.keys()) if hasattr(row, "keys") else set()

    def _flag(column: str) -> bool:
        if column not in keys or row[column] is None:
            return True
        return bool(row[column])

    return {
        "priceMovesEnabled": _flag("price_moves_enabled"),
        "weeklySummaryEnabled": _flag("weekly_summary_enabled"),
        "dealAlertsEnabled": _flag("deal_alerts_enabled"),
        "timezone": row["timezone"] if "timezone" in keys else None,
    }


def get_alert_prefs(connection: sqlite3.Connection, owner_user_id: str) -> dict[str, Any]:
    """ABSENT ROW = ALL ON (never write a row just to record the default)."""
    if not _table_exists(connection, "user_notification_prefs"):
        return {**DEFAULT_PREFS, "timezone": None}
    row = connection.execute(
        "SELECT * FROM user_notification_prefs WHERE owner_user_id = ? LIMIT 1",
        (str(owner_user_id),),
    ).fetchone()
    return _prefs_from_row(row)


_PREF_COLUMNS = {
    "priceMovesEnabled": "price_moves_enabled",
    "weeklySummaryEnabled": "weekly_summary_enabled",
    "dealAlertsEnabled": "deal_alerts_enabled",
}


def set_alert_prefs(
    connection: sqlite3.Connection,
    owner_user_id: str,
    patch: Mapping[str, Any],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Partial upsert of THIS owner's row; returns the full object. Unknown
    keys are ignored; a non-bool flag or an invalid zone is a ValueError."""
    if not isinstance(patch, Mapping):
        raise ValueError("alert preferences must be a JSON object")
    ensure_schema(connection)
    updates: dict[str, Any] = {}
    for key, column in _PREF_COLUMNS.items():
        if key not in patch or patch[key] is None:
            continue
        if not isinstance(patch[key], bool):
            raise ValueError("alert preferences must be booleans")
        updates[column] = 1 if patch[key] else 0
    if patch.get("timezone") not in (None, ""):
        zone = normalize_timezone(patch.get("timezone"))
        if zone is None:
            raise ValueError("timezone must be an IANA zone name")
        updates["timezone"] = zone
    stamp = (now or datetime.now(timezone.utc)).isoformat()
    if updates:
        connection.execute(
            "INSERT OR IGNORE INTO user_notification_prefs (owner_user_id, updated_at) VALUES (?, ?)",
            (str(owner_user_id), stamp),
        )
        assignments = ", ".join(f"{column} = ?" for column in updates)
        connection.execute(
            f"UPDATE user_notification_prefs SET {assignments}, updated_at = ? WHERE owner_user_id = ?",
            (*updates.values(), stamp, str(owner_user_id)),
        )
        connection.commit()
    return get_alert_prefs(connection, owner_user_id)


def public_prefs(prefs: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "priceMovesEnabled": bool(prefs.get("priceMovesEnabled", True)),
        "weeklySummaryEnabled": bool(prefs.get("weeklySummaryEnabled", True)),
        "dealAlertsEnabled": bool(prefs.get("dealAlertsEnabled", True)),
        "timezone": prefs.get("timezone") or None,
    }


# --- pure rules ---------------------------------------------------------------


def local_now(now_utc: datetime, zone_name: str | None) -> datetime:
    moment = now_utc if now_utc.tzinfo else now_utc.replace(tzinfo=timezone.utc)
    return moment.astimezone(_zone(zone_name))


def in_quiet_hours(local: datetime) -> bool:
    return local.hour >= QUIET_START_HOUR or local.hour < QUIET_END_HOUR


def weekly_due(local: datetime) -> bool:
    return (
        local.weekday() == WEEKLY_WEEKDAY
        and WEEKLY_HOUR <= local.hour < QUIET_START_HOUR
    )


def move_pct(price_now: float, price_then: float | None) -> float | None:
    """Signed % when the move clears BOTH bars (>= 10% and >= $5), else None."""
    if price_then is None or price_then <= 0 or price_now is None:
        return None
    delta = float(price_now) - float(price_then)
    pct = delta / float(price_then) * 100.0
    if abs(pct) < MOVE_MIN_PCT or abs(delta) < MOVE_MIN_USD:
        return None
    return pct


@dataclass(frozen=True)
class CardAlertState:
    last_alerted_at: datetime
    last_price_usd: float


def cooldown_allows(state: CardAlertState | None, price_now: float, now_utc: datetime) -> bool:
    """Once per 3 days per card, unless it moved another >= 10% since then."""
    if state is None:
        return True
    if now_utc - state.last_alerted_at >= timedelta(days=CARD_COOLDOWN_DAYS):
        return True
    if state.last_price_usd <= 0:
        return True
    since = abs(float(price_now) - state.last_price_usd) / state.last_price_usd * 100.0
    return since >= CARD_REARM_PCT


@dataclass(frozen=True)
class PriceMove:
    card_id: str
    card_name: str
    price_now: float
    price_then: float
    change_pct: float
    owned: bool


@dataclass(frozen=True)
class PendingDeal:
    alert_id: str
    card_id: str
    card_name: str
    total_cents: int
    discount_pct: float | None


@dataclass(frozen=True)
class WeeklySummary:
    delta_usd: float
    top_card_id: str | None = None
    top_card_name: str | None = None
    top_change_pct: float | None = None


@dataclass(frozen=True)
class PlannedPush:
    kind: str
    title: str
    body: str
    data: dict[str, Any]
    channel_id: str
    card_ids: tuple[str, ...] = ()
    deal_alert_ids: tuple[str, ...] = ()
    move_prices: dict[str, float] = field(default_factory=dict)


def format_pct(pct: float) -> str:
    rounded = int(round(pct))
    return f"+{rounded}%" if rounded >= 0 else f"-{abs(rounded)}%"


def format_signed_usd(amount: float) -> str:
    rounded = int(round(amount))
    return f"+${rounded:,}" if rounded >= 0 else f"-${abs(rounded):,}"


def _name(value: str | None, fallback: str = "A card") -> str:
    return (value or "").strip() or fallback


def build_price_move_push(moves: Sequence[PriceMove]) -> PlannedPush | None:
    if not moves:
        return None
    ranked = sorted(moves, key=lambda m: (-abs(m.change_pct), m.card_id))
    lead = ranked[0]
    headline = f"{_name(lead.card_name)} {format_pct(lead.change_pct)}"
    card_ids = tuple(m.card_id for m in ranked)
    prices = {m.card_id: m.price_now for m in ranked}
    data: dict[str, Any] = {"type": DATA_TYPE_PRICE_MOVE, "cardIds": list(card_ids)}
    if len(ranked) == 1:
        direction = "up" if lead.change_pct >= 0 else "down"
        delta = abs(lead.price_now - lead.price_then)
        body = f"Now {expo_push.format_usd_cents(round(lead.price_now * 100))}, {direction} {expo_push.format_usd_cents(round(delta * 100))} since yesterday."
        data.update({"url": f"/cards/{lead.card_id}", "cardId": lead.card_id})
        return PlannedPush(KIND_PRICE_MOVE, headline, body, data, MARKET_CHANNEL_ID, card_ids, (), prices)
    owned = any(m.owned for m in ranked)
    watched = any(not m.owned for m in ranked)
    who = "own or watch" if owned and watched else ("own" if owned else "watch")
    title = f"{headline} and {len(ranked) - 1} more"
    body = f"Cards you {who} moved today. Tap to see all {len(ranked)}."
    # Bundled: land on the list those cards live in.
    data["url"] = COLLECTION_DEEP_LINK if owned else WATCHLIST_DEEP_LINK
    return PlannedPush(KIND_PRICE_MOVE, title, body, data, MARKET_CHANNEL_ID, card_ids, (), prices)


def build_deal_push(deals: Sequence[PendingDeal]) -> PlannedPush | None:
    if not deals:
        return None
    ranked = sorted(deals, key=lambda d: (-(d.discount_pct or 0.0), d.alert_id))
    lead = ranked[0]
    pct = int(round(lead.discount_pct or 0))
    name = _name(lead.card_name, "A watched card")
    headline = f"{name} listed {pct}% under market" if pct > 0 else f"{name} listed under market"
    title = headline if len(ranked) == 1 else f"{headline} and {len(ranked) - 1} more"
    body = f"{expo_push.format_usd_cents(lead.total_cents)} on eBay, a card you watch."
    data = {
        "type": expo_push.DATA_TYPE_DEAL_ALERT,
        "url": WATCHLIST_DEEP_LINK,
        "alertId": lead.alert_id,
        "cardId": lead.card_id,
    }
    return PlannedPush(
        KIND_DEAL, title, body, data, expo_push.DEAL_CHANNEL_ID,
        tuple(d.card_id for d in ranked), tuple(d.alert_id for d in ranked),
    )


def build_weekly_push(summary: WeeklySummary | None) -> PlannedPush | None:
    if summary is None:
        return None
    if int(round(summary.delta_usd)) == 0 and summary.top_card_id is None:
        return None
    title = f"Your collection {format_signed_usd(summary.delta_usd)} this week"
    if summary.top_card_id and summary.top_change_pct is not None:
        body = f"Top mover: {_name(summary.top_card_name)} {format_pct(summary.top_change_pct)}."
    else:
        body = "Your Sunday summary."
    data = {"type": DATA_TYPE_WEEKLY_SUMMARY, "url": COLLECTION_DEEP_LINK}
    return PlannedPush(KIND_WEEKLY_SUMMARY, title, body, data, MARKET_CHANNEL_ID)


@dataclass
class OwnerPlanInput:
    prefs: Mapping[str, Any]
    local: datetime
    pushed_today: bool
    weekly_sent_today: bool
    deals: Sequence[PendingDeal] = ()
    moves: Sequence[PriceMove] = ()
    weekly: WeeklySummary | None = None


def plan_push(item: OwnerPlanInput, kinds: Iterable[str] = ALL_KINDS) -> PlannedPush | None:
    """The limiter, as one pure decision. See the module docstring for rules."""
    allowed = set(kinds)
    if in_quiet_hours(item.local):
        return None  # deferred, not dropped: the 09:00 run re-plans
    if (
        KIND_WEEKLY_SUMMARY in allowed
        and item.prefs.get("weeklySummaryEnabled", True)
        and weekly_due(item.local)
        and not item.weekly_sent_today
    ):
        weekly = build_weekly_push(item.weekly)
        if weekly is not None:
            return weekly  # exempt from the daily cap (rule 3)
    if item.pushed_today:
        return None
    if KIND_DEAL in allowed and item.prefs.get("dealAlertsEnabled", True) and item.deals:
        return build_deal_push(item.deals)
    if KIND_PRICE_MOVE in allowed and item.prefs.get("priceMovesEnabled", True) and item.moves:
        return build_price_move_push(item.moves)
    return None


# --- sqlite reads (all owner-scoped) ---------------------------------------------


def _chunks(values: Sequence[str], size: int = 400) -> Iterable[list[str]]:
    for start in range(0, len(values), size):
        yield list(values[start : start + size])


def live_tokens_by_owner(
    connection: sqlite3.Connection, owner_user_ids: Sequence[str] | None = None
) -> dict[str, list[tuple[str, str | None]]]:
    """{owner: [(token, device timezone), ...]} newest device first."""
    if not _table_exists(connection, "user_push_tokens"):
        return {}
    tz_col = "timezone" if "timezone" in _columns(connection, "user_push_tokens") else "NULL"
    query = (
        f"SELECT owner_user_id, expo_push_token, {tz_col} AS timezone FROM user_push_tokens "
        "WHERE revoked_at IS NULL"
    )
    rows: list[Any] = []
    owners = [str(o) for o in (owner_user_ids or []) if str(o or "").strip()]
    if owner_user_ids is not None:
        for chunk in _chunks(owners):
            placeholders = ",".join("?" for _ in chunk)
            rows.extend(connection.execute(
                f"{query} AND owner_user_id IN ({placeholders}) ORDER BY last_seen_at DESC", chunk
            ).fetchall())
    else:
        rows = connection.execute(f"{query} ORDER BY last_seen_at DESC").fetchall()
    out: dict[str, list[tuple[str, str | None]]] = {}
    for row in rows:
        out.setdefault(str(row[0]), []).append((str(row[1]), row[2]))
    return out


def resolve_timezone(tokens: Sequence[tuple[str, str | None]], prefs: Mapping[str, Any]) -> str:
    """Newest device's zone, then the prefs zone, then Los Angeles."""
    for _token, zone in tokens:
        if normalize_timezone(zone):
            return str(zone)
    return normalize_timezone(prefs.get("timezone")) or DEFAULT_TIMEZONE


def _pushes_on(connection: sqlite3.Connection, owner: str, local_date: str) -> set[str]:
    rows = connection.execute(
        "SELECT kind FROM market_alert_pushes WHERE owner_user_id = ? AND local_date = ?",
        (owner, local_date),
    ).fetchall()
    return {str(row[0]) for row in rows}


def pending_deals(
    connection: sqlite3.Connection, owner: str, now_utc: datetime
) -> list[PendingDeal]:
    if not _table_exists(connection, "deal_alerts"):
        return []
    cutoff = (now_utc - timedelta(hours=PENDING_DEAL_MAX_AGE_HOURS)).isoformat()
    dismissed = "AND d.dismissed_at IS NULL" if "dismissed_at" in _columns(connection, "deal_alerts") else ""
    rows = connection.execute(
        f"""
        SELECT d.id, d.card_id, d.total_cents, d.discount_pct, c.name
        FROM deal_alerts d LEFT JOIN cards c ON c.id = d.card_id
        WHERE d.owner_user_id = ? AND d.push_sent_at IS NULL AND d.created_at >= ? {dismissed}
        ORDER BY d.created_at ASC, d.id ASC
        """,
        (owner, cutoff),
    ).fetchall()
    return [
        PendingDeal(
            alert_id=str(r[0]), card_id=str(r[1]), total_cents=int(r[2] or 0),
            discount_pct=float(r[3]) if r[3] is not None else None, card_name=str(r[4] or ""),
        )
        for r in rows
    ]


def owned_raw_quantities(connection: sqlite3.Connection, owner: str) -> dict[str, int]:
    """Raw holdings only: a raw price move says nothing about a slab's value."""
    if not _table_exists(connection, "deck_entries"):
        return {}
    rows = connection.execute(
        """
        SELECT card_id, SUM(quantity) FROM deck_entries
        WHERE owner_user_id = ? AND (grader IS NULL OR TRIM(grader) = '') AND quantity > 0
        GROUP BY card_id
        """,
        (owner,),
    ).fetchall()
    return {str(r[0]): int(r[1] or 0) for r in rows if int(r[1] or 0) > 0}


def watched_card_ids(connection: sqlite3.Connection, owner: str) -> list[str]:
    if not _table_exists(connection, "card_favorites"):
        return []
    rows = connection.execute(
        "SELECT card_id FROM card_favorites WHERE owner_user_id = ? ORDER BY card_id", (owner,)
    ).fetchall()
    return [str(r[0]) for r in rows]


def _card_names(connection: sqlite3.Connection, card_ids: Sequence[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for chunk in _chunks(list(card_ids)):
        placeholders = ",".join("?" for _ in chunk)
        for row in connection.execute(
            f"SELECT id, name FROM cards WHERE id IN ({placeholders})", chunk
        ).fetchall():
            out[str(row[0])] = str(row[1] or "")
    return out


def _card_states(connection: sqlite3.Connection, owner: str) -> dict[str, CardAlertState]:
    rows = connection.execute(
        "SELECT card_id, last_alerted_at, last_price_usd FROM market_alert_card_state WHERE owner_user_id = ?",
        (owner,),
    ).fetchall()
    out: dict[str, CardAlertState] = {}
    for row in rows:
        try:
            at = datetime.fromisoformat(str(row[1]))
        except ValueError:
            continue
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        out[str(row[0])] = CardAlertState(at, float(row[2] or 0.0))
    return out


def day_over_day_changes(
    connection: sqlite3.Connection, card_ids: Sequence[str], *, ref_date: date
) -> dict[str, RawPrice]:
    """Each card's newest row (<= ref_date) vs its previous row, through
    feed_prices' resolver: same source + same printing at both ends, JPY at
    today's rate, glitch-sized jumps dropped (change_pct None)."""
    ids = list(dict.fromkeys(str(c) for c in card_ids if c))
    if not ids:
        return {}
    columns = _table_columns(connection, "card_price_history_daily")
    main_col = "main_raw_market_price" if "main_raw_market_price" in columns else "NULL"
    variant_col = "main_raw_variant" if "main_raw_variant" in columns else "NULL"
    start = (ref_date - timedelta(days=MOVE_MAX_STALENESS_DAYS + PREVIOUS_DAY_MAX_GAP_DAYS)).isoformat()
    rows_by_card: dict[str, list[_DailyRow]] = {}
    for chunk in _chunks(ids, 900):
        placeholders = ",".join("?" for _ in chunk)
        for row in connection.execute(
            "SELECT card_id, price_date, display_currency_code, "
            f"default_raw_market_price, {main_col}, {variant_col} "
            "FROM card_price_history_daily "
            f"WHERE card_id IN ({placeholders}) AND price_date BETWEEN ? AND ? "
            "ORDER BY card_id, price_date DESC",
            (*chunk, start, ref_date.isoformat()),
        ).fetchall():
            daily = _DailyRow(
                card_id=str(row[0]), price_date=str(row[1])[:10],
                currency=str(row[2] or "USD").upper(), default_raw=_as_float(row[3]),
                main_raw=_as_float(row[4]), main_variant=row[5],
            )
            bucket = rows_by_card.setdefault(daily.card_id, [])
            if len(bucket) < 2 and (not bucket or bucket[-1].price_date != daily.price_date):
                bucket.append(daily)
    jpy_usd = _jpy_usd_rate(connection)
    out: dict[str, RawPrice] = {}
    for card_id, (now_row, *rest) in rows_by_card.items():
        then_row = rest[0] if rest else None
        if then_row is not None:
            gap = (date.fromisoformat(now_row.price_date) - date.fromisoformat(then_row.price_date)).days
            if gap > PREVIOUS_DAY_MAX_GAP_DAYS:
                then_row = None
        resolved = _resolve(now_row, then_row, jpy_usd=jpy_usd, max_change_pct=DEFAULT_MAX_CHANGE_PCT)
        if resolved is not None:
            out[card_id] = resolved
    return out


def price_moves_for_owner(
    connection: sqlite3.Connection,
    owner: str,
    *,
    now_utc: datetime,
    local_date: date,
    ref_date: date | None,
) -> list[PriceMove]:
    owned = owned_raw_quantities(connection, owner)
    card_ids = list(dict.fromkeys([*owned.keys(), *watched_card_ids(connection, owner)]))
    if not card_ids or ref_date is None:
        return []
    changes = day_over_day_changes(connection, card_ids, ref_date=ref_date)
    states = _card_states(connection, owner)
    stale_before = (local_date - timedelta(days=MOVE_MAX_STALENESS_DAYS)).isoformat()
    candidates: list[tuple[str, float, float, float]] = []
    for card_id, price in changes.items():
        if price.change_pct is None or price.now_date < stale_before:
            continue  # no like-for-like pair, a glitch-sized jump, or old news
        pct = move_pct(price.price_now, price.price_then)
        if pct is None or not cooldown_allows(states.get(card_id), price.price_now, now_utc):
            continue
        candidates.append((card_id, price.price_now, float(price.price_then or 0.0), pct))
    names = _card_names(connection, [c[0] for c in candidates])
    return [
        PriceMove(card_id, names.get(card_id, ""), now, then, pct, card_id in owned)
        for card_id, now, then, pct in candidates
    ]


def weekly_summary_for_owner(
    connection: sqlite3.Connection, owner: str, *, ref_date: date | None
) -> WeeklySummary | None:
    """Raw holdings x same-source 7-day price pairs. Cards without a pair add
    nothing (never a guess)."""
    owned = owned_raw_quantities(connection, owner)
    if not owned or ref_date is None:
        return None
    changes = raw_price_changes(connection, list(owned), ref_date=ref_date, window_days=WEEKLY_WINDOW_DAYS)
    delta = 0.0
    paired = 0
    top: tuple[str, float] | None = None
    for card_id, price in changes.items():
        if price.price_then is None or price.change_pct is None:
            continue
        paired += 1
        delta += (price.price_now - price.price_then) * owned[card_id]
        if price.price_now >= MOVE_MIN_USD and (top is None or abs(price.change_pct) > abs(top[1])):
            top = (card_id, price.change_pct)
    if paired == 0:
        return None
    if top is None:
        return WeeklySummary(delta_usd=delta)
    name = _card_names(connection, [top[0]]).get(top[0], "")
    return WeeklySummary(delta, top[0], name, top[1])


# --- claim + send -----------------------------------------------------------------


def _claim(
    connection: sqlite3.Connection,
    owner: str,
    plan: PlannedPush,
    *,
    local_date: str,
    zone: str,
    now_utc: datetime,
) -> str | None:
    """Commit the ledger row FIRST. Returns its id, or None when another run
    already owns this (owner, day/week) slot."""
    dedupe = f"{'week' if plan.kind == KIND_WEEKLY_SUMMARY else 'day'}:{local_date}"
    push_id = f"mkt-{uuid.uuid4().hex}"
    cursor = connection.execute(
        """
        INSERT OR IGNORE INTO market_alert_pushes
            (id, owner_user_id, kind, local_date, dedupe_key, timezone, title, body,
             payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            push_id, owner, plan.kind, local_date, dedupe, zone, plan.title, plan.body,
            json.dumps({"data": plan.data, "cardIds": list(plan.card_ids)}), now_utc.isoformat(),
        ),
    )
    if int(cursor.rowcount or 0) != 1:
        connection.commit()
        return None
    stamp = now_utc.isoformat()
    if plan.kind == KIND_DEAL:
        for alert_id in plan.deal_alert_ids:
            connection.execute(
                "UPDATE deal_alerts SET push_sent_at = ? WHERE id = ? AND owner_user_id = ? AND push_sent_at IS NULL",
                (stamp, alert_id, owner),
            )
    if plan.kind == KIND_PRICE_MOVE:
        for card_id, price in plan.move_prices.items():
            connection.execute(
                """
                INSERT INTO market_alert_card_state (owner_user_id, card_id, last_alerted_at, last_price_usd)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(owner_user_id, card_id) DO UPDATE SET
                    last_alerted_at = excluded.last_alerted_at,
                    last_price_usd = excluded.last_price_usd
                """,
                (owner, card_id, stamp, float(price)),
            )
    connection.commit()
    return push_id


def _revoke_tokens(connection: sqlite3.Connection, tokens: Iterable[str], now_utc: datetime) -> int:
    revoked = 0
    for token in dict.fromkeys(t for t in tokens if t):
        cursor = connection.execute(
            "UPDATE user_push_tokens SET revoked_at = ? WHERE expo_push_token = ? AND revoked_at IS NULL",
            (now_utc.isoformat(), token),
        )
        revoked += int(cursor.rowcount or 0)
    if revoked:
        connection.commit()
    return revoked


def _persist_tickets(connection: sqlite3.Connection, result: expo_push.PushResult) -> None:
    by_ref: dict[str, dict[str, str]] = {}
    for ticket in result.tickets:
        if ticket.ok and ticket.ticket_id and ticket.reference_id:
            by_ref.setdefault(str(ticket.reference_id), {})[str(ticket.ticket_id)] = ticket.token
    for ref, tickets in by_ref.items():
        connection.execute(
            "UPDATE market_alert_pushes SET push_ticket_id = ?, push_tickets_json = ? WHERE id = ?",
            (next(iter(tickets)), json.dumps(tickets), ref),
        )
    if by_ref:
        connection.commit()


def sweep_receipts(
    connection: sqlite3.Connection,
    *,
    now_utc: datetime,
    transport: expo_push.Transport | None = None,
) -> dict[str, Any]:
    """Last runs' tickets -> receipts -> revoke dead tokens. Rows are marked
    checked once nothing is pending, so the hourly job asks Expo once each."""
    cutoff = (now_utc - timedelta(days=RECEIPT_SWEEP_DAYS)).isoformat()
    rows = connection.execute(
        """
        SELECT id, push_tickets_json FROM market_alert_pushes
        WHERE push_ticket_id IS NOT NULL AND receipts_checked_at IS NULL AND created_at >= ?
        """,
        (cutoff,),
    ).fetchall()
    ids: list[str] = []
    token_by_id: dict[str, str] = {}
    ids_by_row: dict[str, list[str]] = {}
    for row in rows:
        try:
            mapping = json.loads(row[1] or "{}")
        except (TypeError, ValueError):
            mapping = {}
        if not isinstance(mapping, dict):
            mapping = {}
        ids_by_row[str(row[0])] = [str(k) for k in mapping]
        for ticket_id, token in mapping.items():
            ids.append(str(ticket_id))
            token_by_id[str(ticket_id)] = str(token)
    if not ids:
        return expo_push.ReceiptResult().as_dict()
    result = expo_push.check_receipts(ids, tokens_by_receipt_id=token_by_id, transport=transport)
    pending = set(result.pending)
    for row_id, ticket_ids in ids_by_row.items():
        if not pending.intersection(ticket_ids):
            connection.execute(
                "UPDATE market_alert_pushes SET receipts_checked_at = ? WHERE id = ?",
                (now_utc.isoformat(), row_id),
            )
    connection.commit()
    payload = result.as_dict()
    payload["tokensRevoked"] = _revoke_tokens(connection, result.tokens_to_revoke, now_utc)
    return payload


def run_market_alerts(
    connection: sqlite3.Connection,
    *,
    now: datetime | None = None,
    kinds: Iterable[str] = ALL_KINDS,
    owner_user_ids: Sequence[str] | None = None,
    sender: Sender | None = None,
    transport: expo_push.Transport | None = None,
    dry_run: bool = False,
    check_receipts: bool = True,
) -> dict[str, Any]:
    """One pass of the limiter over every owner with a live push token.

    ``sender`` receives assembled ``PushMessage``s and returns a PushResult;
    tests inject a fake. The default posts through ``expo_push.send_messages``
    (with ``transport`` when given).
    """
    now_utc = now or datetime.now(timezone.utc)
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)
    kinds = tuple(kinds)
    summary: dict[str, Any] = {"owners": 0, "sent": 0, "planned": [], "byKind": {}, "skipped": {}}
    if not _table_exists(connection, "user_push_tokens"):
        summary["skipped"]["no_token_table"] = 1
        return summary
    ensure_schema(connection)
    send = sender or (lambda messages: expo_push.send_messages(messages, transport=transport))

    if check_receipts and not dry_run:
        try:
            summary["receipts"] = sweep_receipts(connection, now_utc=now_utc, transport=transport)
        except Exception as error:  # noqa: BLE001 - a sweep failure must not stop the sends
            summary["receipts"] = {"error": f"{type(error).__name__}: {error}"}

    tokens_by_owner = live_tokens_by_owner(connection, owner_user_ids)
    ref_date = latest_price_date(connection) if KIND_PRICE_MOVE in kinds or KIND_WEEKLY_SUMMARY in kinds else None

    def _skip(reason: str) -> None:
        summary["skipped"][reason] = summary["skipped"].get(reason, 0) + 1

    revoke: list[str] = []
    for owner, device_rows in sorted(tokens_by_owner.items()):
        summary["owners"] += 1
        prefs = get_alert_prefs(connection, owner)
        zone = resolve_timezone(device_rows, prefs)
        local = local_now(now_utc, zone)
        if in_quiet_hours(local):
            _skip("quiet_hours")
            continue
        local_date = local.date()
        sent_kinds = _pushes_on(connection, owner, local_date.isoformat())
        weekly_sent = KIND_WEEKLY_SUMMARY in sent_kinds
        item = OwnerPlanInput(
            prefs=prefs, local=local, pushed_today=bool(sent_kinds), weekly_sent_today=weekly_sent,
        )
        # Lazy loads: only compute what the limiter could actually send.
        if (
            KIND_WEEKLY_SUMMARY in kinds and prefs["weeklySummaryEnabled"]
            and weekly_due(local) and not weekly_sent
        ):
            item.weekly = weekly_summary_for_owner(connection, owner, ref_date=ref_date)
        if not item.pushed_today:
            if KIND_DEAL in kinds and prefs["dealAlertsEnabled"]:
                item.deals = pending_deals(connection, owner, now_utc)
            if KIND_PRICE_MOVE in kinds and prefs["priceMovesEnabled"] and not item.deals:
                item.moves = price_moves_for_owner(
                    connection, owner, now_utc=now_utc, local_date=local_date, ref_date=ref_date
                )
        plan = plan_push(item, kinds)
        if plan is None:
            _skip("daily_cap" if item.pushed_today else "nothing_to_send")
            continue
        summary["planned"].append({"owner": owner, "kind": plan.kind, "title": plan.title, "timezone": zone})
        if dry_run:
            continue
        push_id = _claim(connection, owner, plan, local_date=local_date.isoformat(), zone=zone, now_utc=now_utc)
        if push_id is None:
            _skip("already_claimed")
            continue
        usable = [t for t, _ in device_rows if expo_push.is_expo_push_token(t)]
        revoke.extend(t for t, _ in device_rows if not expo_push.is_expo_push_token(t))
        messages = [
            expo_push.PushMessage(
                to=token, title=plan.title, body=plan.body, data=dict(plan.data),
                channel_id=plan.channel_id, reference_id=push_id,
            )
            for token in usable
        ]
        if not messages:
            continue
        try:
            result = send(messages)
        except Exception as error:  # noqa: BLE001 - never let one owner stop the run
            summary.setdefault("errors", []).append(f"{type(error).__name__}: {error}")
            continue
        _persist_tickets(connection, result)
        revoke.extend(result.tokens_to_revoke)
        summary["sent"] += 1
        summary["byKind"][plan.kind] = summary["byKind"].get(plan.kind, 0) + 1
    if revoke and not dry_run:
        summary["tokensRevoked"] = _revoke_tokens(connection, revoke, now_utc)
    return summary


# --- CLI (the hourly VM job) ----------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Hourly market-alert pushes (price moves, weekly summary, deals)")
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--dry-run", action="store_true", help="plan only; send and write nothing")
    parser.add_argument("--force", action="store_true", help=f"run even when {ENABLED_ENV} is off")
    parser.add_argument("--now", help="ISO timestamp override (testing)")
    args = parser.parse_args(argv)
    if not is_enabled() and not args.force:
        print(f"[market-alerts] {ENABLED_ENV} is off; skipping")
        return 0
    from catalog_tools import connect  # local import keeps the module import-light

    connection = connect(args.database_path, timeout_seconds=30.0)
    try:
        now = datetime.fromisoformat(args.now) if args.now else None
        summary = run_market_alerts(connection, now=now, dry_run=args.dry_run)
    finally:
        connection.close()
    print(
        f"[market-alerts] owners={summary['owners']} sent={summary['sent']} "
        f"byKind={summary['byKind']} skipped={summary['skipped']}"
        + (" (dry run)" if args.dry_run else "")
    )
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
