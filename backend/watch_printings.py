"""Watch per printing: the storage migration, the card's known printings, and
the per-printing TCGplayer (raw_main cell) + PPT eBay-ungraded reads that the
watchlist, the deal scan and market alerts share.

A watch is (owner, card, variant_key). ``variant_key`` is the TCGplayer printing
label used as ``card_price_history_cell.variant_key`` on lane ``raw_main``
("Holofoil", "Reverse Holofoil", "Normal", "1st Edition Holofoil", ...). ``''``
means "the card's main printing" — sealed product and every row written before
this change — and behaves exactly as a watch did before.

Plan + contract: docs/watch-printings-and-deal-tiers-plan-2026-09-24.md.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Iterable, Sequence

from tcgcsv_adapter import SUBTYPE_TO_SCRYDEX_VARIANT_LABEL

MAIN_PRINTING = ""

#: How far back a raw_main cell still proves a printing exists.
KNOWN_PRINTINGS_LOOKBACK_DAYS = 60
#: One cell read wide enough for the 30-day low and the 30-day change count.
CELL_READ_DAYS = 45

CARD_FAVORITES_COLUMNS: tuple[tuple[str, str], ...] = (
    ("owner_user_id", "TEXT NOT NULL"),
    ("card_id", "TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE"),
    ("variant_key", "TEXT NOT NULL DEFAULT ''"),
    ("created_at", "TEXT NOT NULL"),
    ("added_market_price", "REAL"),
    ("added_market_date", "TEXT"),
    ("target_price_cents", "INTEGER"),
    ("target_currency", "TEXT"),
    ("target_set_at", "TEXT"),
    ("target_triggered_at", "TEXT"),
    ("fast_lane", "INTEGER NOT NULL DEFAULT 0"),
)
CARD_FAVORITES_PK = ("owner_user_id", "card_id", "variant_key")


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", (table,)
    ).fetchone()
    return row is not None


def _table_info(connection: sqlite3.Connection, table: str) -> list[Any]:
    return connection.execute(f"PRAGMA table_info({table})").fetchall()


def _pk_columns(connection: sqlite3.Connection, table: str) -> tuple[str, ...]:
    rows = [row for row in _table_info(connection, table) if int(row[5] or 0) > 0]
    return tuple(str(row[1]) for row in sorted(rows, key=lambda row: int(row[5])))


def normalize_variant_key(value: Any) -> str:
    return str(value or "").strip()


def watch_variant_payload(variant_key: Any) -> str | None:
    """API spelling: '' (main printing) -> null."""
    return normalize_variant_key(variant_key) or None


def watch_key(card_id: Any, variant_key: Any) -> str:
    return f"{str(card_id or '').strip()}|{normalize_variant_key(variant_key)}"


# --- schema ------------------------------------------------------------------


def card_favorites_needs_rebuild(connection: sqlite3.Connection) -> bool:
    if not _table_exists(connection, "card_favorites"):
        return False
    return _pk_columns(connection, "card_favorites") != CARD_FAVORITES_PK


def migrate_card_favorites_per_printing(connection: sqlite3.Connection) -> bool:
    """Give ``card_favorites`` its ``variant_key`` column and the
    (owner_user_id, card_id, variant_key) primary key. SQLite cannot change a
    primary key in place, so the table is rebuilt ONCE — it is small (one row
    per watch). Every existing column and row is copied through; existing rows
    get ``variant_key = ''`` (main printing: behaviour unchanged). Idempotent:
    a table already on the new key is left untouched. Returns True when it
    rebuilt. Does not commit (the startup bootstrap commits)."""
    if not card_favorites_needs_rebuild(connection):
        return False
    existing = [(str(row[1]), str(row[2] or "")) for row in _table_info(connection, "card_favorites")]
    existing_names = [name for name, _ in existing]
    known = {name for name, _ in CARD_FAVORITES_COLUMNS}
    column_ddl = [f"{name} {ddl}" for name, ddl in CARD_FAVORITES_COLUMNS]
    # Anything this module does not know about still survives the rebuild.
    column_ddl.extend(f"{name} {ddl}".strip() for name, ddl in existing if name not in known)
    connection.execute("DROP TABLE IF EXISTS card_favorites__rebuild")
    connection.execute(
        "CREATE TABLE card_favorites__rebuild (\n    "
        + ",\n    ".join(column_ddl)
        + f",\n    PRIMARY KEY ({', '.join(CARD_FAVORITES_PK)})\n)"
    )
    copied = [name for name in existing_names if name != "variant_key"]
    select = ", ".join(copied)
    variant_select = (
        "COALESCE(variant_key, '')" if "variant_key" in existing_names else "''"
    )
    connection.execute(
        f"INSERT OR IGNORE INTO card_favorites__rebuild ({select}, variant_key) "
        f"SELECT {select}, {variant_select} FROM card_favorites"
    )
    connection.execute("DROP TABLE card_favorites")
    connection.execute("ALTER TABLE card_favorites__rebuild RENAME TO card_favorites")
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_card_favorites_owner_user_id
        ON card_favorites(owner_user_id, created_at DESC, card_id)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_card_favorites_card_id
        ON card_favorites(card_id, created_at DESC)
        """
    )
    return True


# --- printings ---------------------------------------------------------------


def _match_key(value: Any) -> str:
    text = re.sub(r"\b1st\b", "first", str(value or ""), flags=re.IGNORECASE)
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def main_printing_key(connection: sqlite3.Connection, card_id: str) -> str | None:
    """The TCGplayer printing the card's headline price is for
    (``card_price_snapshots.main_raw_variant``), or None when unknown."""
    if not _table_exists(connection, "card_price_snapshots"):
        return None
    columns = {str(row[1]) for row in _table_info(connection, "card_price_snapshots")}
    if "main_raw_variant" not in columns:
        return None
    row = connection.execute(
        "SELECT main_raw_variant FROM card_price_snapshots WHERE card_id = ? LIMIT 1",
        (str(card_id),),
    ).fetchone()
    value = normalize_variant_key(row[0]) if row is not None else ""
    return value or None


def main_printing_keys(
    connection: sqlite3.Connection, card_ids: Sequence[str]
) -> dict[str, str]:
    ids = [str(card_id) for card_id in dict.fromkeys(card_ids) if str(card_id or "").strip()]
    if not ids or not _table_exists(connection, "card_price_snapshots"):
        return {}
    columns = {str(row[1]) for row in _table_info(connection, "card_price_snapshots")}
    if "main_raw_variant" not in columns:
        return {}
    out: dict[str, str] = {}
    for start in range(0, len(ids), 400):
        chunk = ids[start : start + 400]
        placeholders = ",".join("?" for _ in chunk)
        for row in connection.execute(
            f"SELECT card_id, main_raw_variant FROM card_price_snapshots WHERE card_id IN ({placeholders})",
            chunk,
        ).fetchall():
            value = normalize_variant_key(row[1])
            if value:
                out[str(row[0])] = value
    return out


def known_printings(
    connection: sqlite3.Connection,
    card_id: str,
    *,
    today: date | None = None,
) -> list[str]:
    """The card's printings as raw_main ``variant_key`` labels: every printing
    with a raw_main cell in the last 60 days, plus the TCGCSV printings map and
    main printing on the snapshot. Ordered main-first, then alphabetically."""
    card_id = str(card_id or "").strip()
    found: dict[str, None] = {}
    main = main_printing_key(connection, card_id)
    if main:
        found[main] = None
    if _table_exists(connection, "card_price_history_cell"):
        params: list[Any] = [card_id]
        query = (
            "SELECT DISTINCT variant_key FROM card_price_history_cell "
            "WHERE card_id = ? AND lane = 'raw_main'"
        )
        if today is not None:
            query += " AND price_date >= ?"
            params.append((today - timedelta(days=KNOWN_PRINTINGS_LOOKBACK_DAYS)).isoformat())
        rows = connection.execute(query, params).fetchall()
        for key in sorted(normalize_variant_key(row[0]) for row in rows):
            if key:
                found.setdefault(key, None)
    if _table_exists(connection, "card_price_snapshots"):
        columns = {str(row[1]) for row in _table_info(connection, "card_price_snapshots")}
        if "main_raw_printings_json" in columns:
            row = connection.execute(
                "SELECT main_raw_printings_json FROM card_price_snapshots WHERE card_id = ? LIMIT 1",
                (card_id,),
            ).fetchone()
            try:
                parsed = json.loads(row[0] or "{}") if row is not None else {}
            except (TypeError, ValueError):
                parsed = {}
            if isinstance(parsed, dict):
                for label, entry in sorted(parsed.items()):
                    sub_type = normalize_variant_key(
                        (entry or {}).get("subTypeName") if isinstance(entry, dict) else None
                    )
                    key = sub_type or normalize_variant_key(label)
                    # Two labels on one subtype key by label (see the TCGCSV sync).
                    if key and not any(_match_key(k) == _match_key(key) for k in found):
                        found[key] = None
    return list(found)


def canonical_printing(
    requested: Any, printings: Iterable[str]
) -> str | None:
    """Map a client's printing label onto one of the card's known printing
    keys. Accepts the exact raw_main key ("1st Edition Holofoil") or the Scrydex
    label the PDP picker shows ("First Edition"), case/punctuation-insensitive.
    None when it names no known printing."""
    wanted = _match_key(requested)
    if not wanted:
        return None
    options = list(printings)
    for key in options:
        if _match_key(key) == wanted:
            return key
    for key in options:
        label = SUBTYPE_TO_SCRYDEX_VARIANT_LABEL.get(key)
        if label and _match_key(label) == wanted:
            return key
    return None


# --- raw_main cells ----------------------------------------------------------


@dataclass(frozen=True)
class CellPoint:
    price_date: str
    market_cents: int | None
    low_cents: int | None


def _cents(value: Any) -> int | None:
    try:
        cents = int(round(float(value) * 100))
    except (TypeError, ValueError):
        return None
    return cents if cents > 0 else None


def raw_main_cells_by_card(
    connection: sqlite3.Connection,
    card_ids: Sequence[str],
    *,
    since: str | None = None,
) -> dict[str, dict[str, tuple[CellPoint, ...]]]:
    """``{card_id: {variant_key: (CellPoint oldest→newest, ...)}}`` for lane
    raw_main — one indexed read per 400 cards."""
    ids = [str(card_id) for card_id in dict.fromkeys(card_ids) if str(card_id or "").strip()]
    if not ids or not _table_exists(connection, "card_price_history_cell"):
        return {}
    out: dict[str, dict[str, list[CellPoint]]] = {}
    for start in range(0, len(ids), 400):
        chunk = ids[start : start + 400]
        placeholders = ",".join("?" for _ in chunk)
        query = (
            "SELECT card_id, variant_key, price_date, market, low FROM card_price_history_cell "
            f"WHERE lane = 'raw_main' AND card_id IN ({placeholders})"
        )
        params: list[Any] = list(chunk)
        if since:
            query += " AND price_date >= ?"
            params.append(since)
        for row in connection.execute(query, params).fetchall():
            variant = normalize_variant_key(row[1])
            if not variant:
                continue
            out.setdefault(str(row[0]), {}).setdefault(variant, []).append(
                CellPoint(str(row[2])[:10], _cents(row[3]), _cents(row[4]))
            )
    result: dict[str, dict[str, tuple[CellPoint, ...]]] = {}
    for card_id, by_variant in out.items():
        result[card_id] = {}
        for variant, points in by_variant.items():
            by_date: dict[str, CellPoint] = {}
            for point in points:
                by_date[point.price_date] = point
            result[card_id][variant] = tuple(sorted(by_date.values(), key=lambda p: p.price_date))
    return result


def cells_for_printing(
    cells_by_variant: dict[str, tuple[CellPoint, ...]], printing: str | None
) -> tuple[CellPoint, ...]:
    if not printing:
        return ()
    exact = cells_by_variant.get(printing)
    if exact is not None:
        return exact
    wanted = _match_key(printing)
    for key, points in cells_by_variant.items():
        if _match_key(key) == wanted:
            return points
    return ()


def latest_printing_price(
    connection: sqlite3.Connection, card_id: str, variant_key: str
) -> dict[str, Any] | None:
    """Newest raw_main cell for one printing: ``{market, low, date}`` in
    dollars, or None when the printing has no cell."""
    if not variant_key or not _table_exists(connection, "card_price_history_cell"):
        return None
    row = connection.execute(
        """
        SELECT price_date, market, low FROM card_price_history_cell
        WHERE card_id = ? AND lane = 'raw_main' AND variant_key = ?
          AND market IS NOT NULL
        ORDER BY price_date DESC LIMIT 1
        """,
        (str(card_id), str(variant_key)),
    ).fetchone()
    if row is None:
        return None
    try:
        market = float(row[1])
    except (TypeError, ValueError):
        return None
    low = row[2]
    try:
        low = float(low) if low is not None else None
    except (TypeError, ValueError):
        low = None
    return {"date": str(row[0])[:10], "market": market, "low": low}


# --- PPT eBay "ungraded" signals --------------------------------------------


@dataclass(frozen=True)
class UngradedSales:
    """PPT's eBay "ungraded" row for a card. PER CARD, not per printing: the
    export keys eBay sales by TCGplayer product id, and one Pokémon product
    carries every printing (Holofoil / Reverse Holofoil) as subtypes, so these
    sales mix printings. Used only as a liquidity/yardstick signal."""

    sales_count: int | None = None  # PPT: lifetime count
    median_cents: int | None = None
    sales_velocity_weekly: float | None = None
    smart_market_cents: int | None = None
    smart_market_confidence: str | None = None
    market_7day_cents: int | None = None

    @property
    def sales_30d(self) -> int | None:
        if self.sales_velocity_weekly is None:
            return None
        return int(round(max(0.0, self.sales_velocity_weekly) * 30.0 / 7.0))

    @property
    def sales_90d(self) -> int | None:
        if self.sales_velocity_weekly is None:
            return None
        return int(round(max(0.0, self.sales_velocity_weekly) * 90.0 / 7.0))


def ungraded_sales_by_card(
    connection: sqlite3.Connection, card_ids: Sequence[str]
) -> dict[str, UngradedSales]:
    ids = [str(card_id) for card_id in dict.fromkeys(card_ids) if str(card_id or "").strip()]
    if not ids or not _table_exists(connection, "ppt_ungraded_signals"):
        return {}
    out: dict[str, UngradedSales] = {}
    for start in range(0, len(ids), 400):
        chunk = ids[start : start + 400]
        placeholders = ",".join("?" for _ in chunk)
        for row in connection.execute(
            "SELECT card_id, sales_count, median_price, sales_velocity_weekly, "
            "smart_market_price, smart_market_confidence, market_price_7day "
            f"FROM ppt_ungraded_signals WHERE card_id IN ({placeholders})",
            chunk,
        ).fetchall():
            velocity = row[3]
            try:
                velocity = float(velocity) if velocity is not None else None
            except (TypeError, ValueError):
                velocity = None
            count = row[1]
            try:
                count = int(count) if count is not None else None
            except (TypeError, ValueError):
                count = None
            out[str(row[0])] = UngradedSales(
                sales_count=count,
                median_cents=_cents(row[2]),
                sales_velocity_weekly=velocity,
                smart_market_cents=_cents(row[4]),
                smart_market_confidence=(str(row[5]).strip().lower() or None) if row[5] is not None else None,
                market_7day_cents=_cents(row[6]),
            )
    return out
