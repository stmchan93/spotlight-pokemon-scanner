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
    """THE printing-identity comparison for watches: case/punctuation-blind,
    "1st" == "First" and "Holo" == "Holofoil", so a stored "1st Edition" meets
    a "First Edition" cell and "Reverse Holo" names "Reverse Holofoil"."""
    text = re.sub(r"\b1st\b", "first", str(value or ""), flags=re.IGNORECASE)
    text = re.sub(r"\bholo\b", "holofoil", text, flags=re.IGNORECASE)
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def printing_label(variant_key: Any) -> str | None:
    """The PDP picker's (Scrydex) label for a stored watch key: "1st Edition"
    -> "First Edition", "Unlimited Holofoil" -> "Unlimited". A key that is
    already a label (subtype-collision cells key by label) is returned as is;
    '' (main printing) -> None."""
    key = normalize_variant_key(variant_key)
    if not key:
        return None
    return SUBTYPE_TO_SCRYDEX_VARIANT_LABEL.get(key) or key


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


def printing_cell_key(printings_json: Any, requested: Any) -> str | None:
    """The raw_main cell key the TCGCSV sync wrote for the printing ``requested``
    names (an owned copy's Scrydex label), from the snapshot's
    ``main_raw_printings_json`` — the same map the PDP ladder prices printings
    from. Mirrors the sync's keying: the printing's ``subTypeName`` unless
    another priced printing shares it, then its label. So OP15-039's "Alt Art"
    (its own product, subtype "Foil") is the cell "Foil", while ST30-001's
    "Alt Art" (sharing "Foil" with the base card) is the cell "Alt Art". None
    when the map does not price that printing."""
    if isinstance(printings_json, dict):
        parsed: Any = printings_json
    else:
        try:
            parsed = json.loads(printings_json or "{}")
        except (TypeError, ValueError):
            return None
    if not isinstance(parsed, dict):
        return None
    entries = {str(label): entry for label, entry in parsed.items() if isinstance(entry, dict)}
    label = canonical_printing(requested, entries)
    if label is None:
        return None
    sub_type = normalize_variant_key(entries[label].get("subTypeName"))
    if not sub_type:
        return label
    shared = sum(
        1 for entry in entries.values() if normalize_variant_key(entry.get("subTypeName")) == sub_type
    )
    return sub_type if shared == 1 else label


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


def printing_points_by_date(
    cells_by_variant: dict[str, tuple[CellPoint, ...]], printing: str | None
) -> dict[str, dict[str, float | None]]:
    """``{price_date: {market, low}}`` (dollars) for one printing's cells."""
    return {
        point.price_date: {
            "market": point.market_cents / 100.0,
            "low": point.low_cents / 100.0 if point.low_cents is not None else None,
        }
        for point in cells_for_printing(cells_by_variant, printing)
        if point.market_cents is not None
    }


def latest_printing_price(
    connection: sqlite3.Connection, card_id: str, variant_key: str
) -> dict[str, Any] | None:
    """Newest raw_main cell for one printing: ``{market, low, mid, high,
    directLow, date}`` in dollars, or None when the printing has no cell."""
    if not variant_key:
        return None
    return latest_printing_prices(connection, [(str(card_id), str(variant_key))]).get(
        (str(card_id), str(variant_key))
    )


def _optional_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def printing_pricing_summary(
    cell: dict[str, Any], *, label: str | None, base: dict[str, Any] | None = None
) -> dict[str, Any]:
    """A card ``pricing`` summary that quotes one printing's TCGplayer cell.
    ``base`` (the card-level summary) keeps its identity fields; every price
    field comes from the cell, so no other printing's number can leak through."""
    summary = {
        key: value
        for key, value in (base or {}).items()
        if not str(key).startswith("native") and not str(key).startswith("fx")
        and key not in {"displayIsConverted", "trendsPct", "suppressionReason"}
    }
    market = _optional_float(cell.get("market"))
    summary.update(
        {
            "pricingMode": summary.get("pricingMode") or "raw",
            "provider": "tcgcsv",
            "source": "tcgcsv",
            "variant": label,
            "condition": "NM",
            "currencyCode": "USD",
            "market": market,
            "low": _optional_float(cell.get("low")),
            "mid": _optional_float(cell.get("mid")),
            "high": _optional_float(cell.get("high")),
            "directLow": _optional_float(cell.get("directLow")),
            "trend": market,
            "trendsPct": None,
            "payload": {},
            "sourceURL": None,
            "updatedAt": cell.get("date"),
            "refreshedAt": cell.get("date"),
        }
    )
    return summary


# raw_main cells are only ever written by the TCGCSV sync, under this provider.
_RAW_MAIN_CELL_PROVIDER = "tcgcsv"


def latest_printing_prices(
    connection: sqlite3.Connection, pairs: Iterable[tuple[str, str]]
) -> dict[tuple[str, str], dict[str, Any]]:
    """Batched ``latest_printing_price`` for a list page: ``{(card_id,
    variant_key): {market, low, mid, high, directLow, date}}``, pairs without a
    cell omitted.

    Two queries total instead of one per printing watch. The per-watch query
    has no provider, so it walks the card's cells newest-first through the
    identity index and fetches every table row to test the lane — every graded
    cell of the day, and the card's ENTIRE history when the printing has no
    cell. Pinning ``provider`` lets ``idx_cell_trend_market`` answer step 1
    from the index alone; step 2 then reads one table row per hit."""
    wanted: dict[str, set[str]] = {}
    for card_id, variant_key in pairs:
        if card_id and variant_key:
            wanted.setdefault(str(card_id), set()).add(str(variant_key))
    if not wanted or not _table_exists(connection, "card_price_history_cell"):
        return {}
    # The stored key normally IS the cell key, but the sync keys a cell by its
    # Scrydex label once two printings collide on one subtype ("1st Edition"
    # -> "First Edition"), so a key that misses exactly still matches by
    # printing identity. An exact cell always beats a spelling match.
    stored_by_match: dict[tuple[str, str], str] = {
        (card_id, _match_key(key)): key for card_id, keys in wanted.items() for key in keys
    }

    def _stored_key(card_id: str, cell_key: str) -> tuple[str, bool] | None:
        if cell_key in wanted.get(card_id, ()):
            return cell_key, True
        stored = stored_by_match.get((card_id, _match_key(cell_key)))
        return (stored, False) if stored else None

    latest_date: dict[tuple[str, str], str] = {}
    cell_for_stored: dict[tuple[str, str], tuple[str, bool]] = {}
    card_ids = sorted(wanted)
    for start in range(0, len(card_ids), 400):
        chunk = card_ids[start : start + 400]
        placeholders = ",".join("?" for _ in chunk)
        for row in connection.execute(
            f"""
            SELECT card_id, variant_key, MAX(price_date) FROM card_price_history_cell
            WHERE card_id IN ({placeholders}) AND provider = ? AND lane = 'raw_main'
              AND market IS NOT NULL
            GROUP BY card_id, variant_key
            """,
            (*chunk, _RAW_MAIN_CELL_PROVIDER),
        ):
            card_id, cell_key = str(row[0]), str(row[1] or "")
            resolved = _stored_key(card_id, cell_key) if row[2] else None
            if resolved is None:
                continue
            stored, exact = resolved
            current = cell_for_stored.get((card_id, stored))
            if current is not None:
                current_date = latest_date[(card_id, current[0])]
                # Exact spelling wins; between two spellings, the newer cell.
                if (current[1], current_date) >= (exact, str(row[2])):
                    continue
                latest_date.pop((card_id, current[0]), None)
            cell_for_stored[(card_id, stored)] = (cell_key, exact)
            latest_date[(card_id, cell_key)] = str(row[2])
    if not latest_date:
        return {}
    stored_for_cell = {
        (card_id, cell_key): stored for (card_id, stored), (cell_key, _) in cell_for_stored.items()
    }
    result: dict[tuple[str, str], dict[str, Any]] = {}
    hit_cards = sorted({card_id for card_id, _ in latest_date})
    hit_dates = sorted(set(latest_date.values()))
    for start in range(0, len(hit_cards), 400):
        chunk = hit_cards[start : start + 400]
        card_ph = ",".join("?" for _ in chunk)
        date_ph = ",".join("?" for _ in hit_dates)
        for row in connection.execute(
            f"""
            SELECT card_id, variant_key, price_date, market, low, mid, high, direct_low
            FROM card_price_history_cell
            WHERE card_id IN ({card_ph}) AND provider = ? AND price_date IN ({date_ph})
              AND lane = 'raw_main' AND market IS NOT NULL
            """,
            (*chunk, _RAW_MAIN_CELL_PROVIDER, *hit_dates),
        ):
            key = (str(row[0]), str(row[1] or ""))
            if latest_date.get(key) != str(row[2]):
                continue
            market = _optional_float(row[3])
            if market is None:
                continue
            result[(key[0], stored_for_cell[key])] = {
                "date": str(row[2])[:10],
                "market": market,
                "low": _optional_float(row[4]),
                "mid": _optional_float(row[5]),
                "high": _optional_float(row[6]),
                "directLow": _optional_float(row[7]),
            }
    return result


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
