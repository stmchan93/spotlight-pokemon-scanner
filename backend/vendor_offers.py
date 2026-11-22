"""Vendor price tags: buy/sell % settings and the Bought log.

Flow: the vendor's scan tray shows "market -> offer" per card from their saved
buy % (tiered by default) or sell %. When a seller accepts, the vendor taps
Bought (whole tray or one row): each line goes through the existing
`record_buy` (cost basis = the offer) and lands in `vendor_purchases` with the
price paid and the market at that moment. The Bought log reads them back with
today's value.

Everything persisted is owner-scoped (owner_user_id). USD only.
"""

from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, timezone
from typing import Any, Callable

MAX_PURCHASE_LINES = 60
MAX_LINE_QUANTITY = 99

# Plan doc §5 #4 (owner can change): tiers ON — bulk (<$5) 40%, $5-$50 60%,
# $50+ 70%, slabs 70%; sell at 100% of market, adjustable 85-120%.
# `buyPercent` is the flat rate used when a vendor turns tiers off.
# Mirrored in packages/api-client/src/spotlight/vendor-wire.ts.
DEFAULT_SETTINGS: dict[str, Any] = {
    "buyPercent": 70,
    "sellPercent": 100,
    "tiersEnabled": True,
    "tiers": {"bulk": 40, "under50": 60, "over50": 70, "slab": 70},
    "bulkMaxUsd": 5.0,
}
SELL_PERCENT_RANGE = (85, 120)
TIER_KEYS = ("bulk", "under50", "over50", "slab")
MID_TIER_BREAK_USD = 50.0

VENDOR_DDL = (
    """CREATE TABLE IF NOT EXISTS vendor_settings (
  owner_user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL
);""",
    # One row per accepted card. `batch_id` is the client's id for one Bought
    # tap, so a retried request can never record the same line twice.
    """CREATE TABLE IF NOT EXISTS vendor_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  card_id TEXT NOT NULL,
  name TEXT,
  set_name TEXT,
  number TEXT,
  image_url TEXT,
  variant_name TEXT,
  condition TEXT,
  grader TEXT,
  grade TEXT,
  cert_number TEXT,
  quantity INTEGER NOT NULL,
  paid_usd REAL NOT NULL,
  market_usd REAL,
  buy_percent REAL,
  tier TEXT,
  deck_entry_id TEXT,
  bought_at TEXT NOT NULL,
  UNIQUE (owner_user_id, batch_id, line_index)
);""",
    "CREATE INDEX IF NOT EXISTS idx_vendor_purchases_owner ON vendor_purchases (owner_user_id, bought_at);",
)

# For account deletion (server.py's owner-scoped table list).
OWNER_SCOPED_TABLES = (
    ("vendor_purchases", "owner_user_id = :owner"),
    ("vendor_settings", "owner_user_id = :owner"),
)


def ensure_schema(connection: sqlite3.Connection) -> None:
    for statement in VENDOR_DDL:
        connection.execute(statement)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- Settings ---------------------------------------------------------------


def _percent(value: Any, field: str, *, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{field} must be a number")
    if value < low or value > high:
        raise ValueError(f"{field} must be between {low:g} and {high:g}")
    return round(float(value), 2)


def normalize_settings(payload: Any, base: dict[str, Any] | None = None) -> dict[str, Any]:
    """Validate a (partial) settings patch over `base` (defaults when None)."""
    if not isinstance(payload, dict):
        raise ValueError("settings must be an object")
    merged = json.loads(json.dumps(base or DEFAULT_SETTINGS))
    if "buyPercent" in payload:
        merged["buyPercent"] = _percent(payload["buyPercent"], "buyPercent", low=1, high=100)
    if "sellPercent" in payload:
        merged["sellPercent"] = _percent(
            payload["sellPercent"], "sellPercent", low=SELL_PERCENT_RANGE[0], high=SELL_PERCENT_RANGE[1]
        )
    if "tiersEnabled" in payload:
        if not isinstance(payload["tiersEnabled"], bool):
            raise ValueError("tiersEnabled must be a boolean")
        merged["tiersEnabled"] = payload["tiersEnabled"]
    if "tiers" in payload:
        tiers = payload["tiers"]
        if not isinstance(tiers, dict):
            raise ValueError("tiers must be an object")
        for key in TIER_KEYS:
            if key in tiers:
                merged["tiers"][key] = _percent(tiers[key], f"tiers.{key}", low=1, high=100)
    if "bulkMaxUsd" in payload:
        merged["bulkMaxUsd"] = _percent(payload["bulkMaxUsd"], "bulkMaxUsd", low=0, high=MID_TIER_BREAK_USD)
    return merged


def get_settings(connection: sqlite3.Connection, owner_user_id: str) -> dict[str, Any]:
    row = connection.execute(
        "SELECT settings_json FROM vendor_settings WHERE owner_user_id = ? LIMIT 1", (owner_user_id,)
    ).fetchone()
    if row is None:
        return normalize_settings({})
    try:
        return normalize_settings(json.loads(row[0]))
    except (ValueError, TypeError):
        # A row from another shape: fall back rather than 500 the tray.
        return normalize_settings({})


def set_settings(connection: sqlite3.Connection, owner_user_id: str, patch: Any) -> dict[str, Any]:
    merged = normalize_settings(patch, base=get_settings(connection, owner_user_id))
    connection.execute(
        """
        INSERT INTO vendor_settings (owner_user_id, settings_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(owner_user_id) DO UPDATE SET
            settings_json = excluded.settings_json, updated_at = excluded.updated_at
        """,
        (owner_user_id, json.dumps(merged, sort_keys=True), _iso(datetime.now(timezone.utc))),
    )
    connection.commit()
    return merged


def tier_for(market_usd: float, *, is_slab: bool, settings: dict[str, Any]) -> str:
    if not settings.get("tiersEnabled"):
        return "flat"
    if is_slab:
        return "slab"
    if market_usd < float(settings.get("bulkMaxUsd") or 0):
        return "bulk"
    return "under50" if market_usd < MID_TIER_BREAK_USD else "over50"


def offer_for_market(
    market_usd: float | None, *, is_slab: bool, settings: dict[str, Any], kind: str = "buy"
) -> tuple[float | None, str]:
    """Same math as the app (vendor-pricing.ts): whole cents, half-up."""
    if market_usd is None or not math.isfinite(market_usd) or market_usd < 0:
        return None, "none"
    if kind == "sell":
        percent, tier = float(settings["sellPercent"]), "sell"
    else:
        tier = tier_for(market_usd, is_slab=is_slab, settings=settings)
        percent = float(settings["buyPercent"]) if tier == "flat" else float(settings["tiers"][tier])
    cents = math.floor(round(market_usd * percent, 6) + 0.5)
    return cents / 100, tier


# --- Bought -----------------------------------------------------------------


def _money(value: Any, field: str, *, required: bool) -> float | None:
    if value is None or value == "":
        if required:
            raise ValueError(f"{field} is required")
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{field} must be a number")
    if value < 0 or value > 10_000_000:
        raise ValueError(f"{field} is out of range")
    return round(float(value), 2)


def _clean_text(value: Any, limit: int = 80) -> str | None:
    text = str(value or "").strip()
    return text[:limit] or None


def _catalog_rows(connection: sqlite3.Connection, card_ids: list[str]) -> dict[str, tuple]:
    ids = sorted({card_id for card_id in card_ids if card_id})
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    rows = connection.execute(
        f"SELECT id, name, set_name, number, image_small_url, image_url FROM cards WHERE id IN ({placeholders})",
        ids,
    ).fetchall()
    return {str(row[0]): tuple(row) for row in rows}


def _parse_lines(connection: sqlite3.Connection, payload: Any) -> tuple[str, list[dict[str, Any]]]:
    if not isinstance(payload, dict):
        raise ValueError("body must be an object")
    batch_id = _clean_text(payload.get("batchId"), 64)
    if not batch_id:
        raise ValueError("batchId is required")
    if str(payload.get("currencyCode") or "USD").strip().upper() != "USD":
        raise ValueError("purchases are USD only")
    raw_lines = payload.get("lines")
    if not isinstance(raw_lines, list) or not raw_lines:
        raise ValueError("lines must be a non-empty list")
    if len(raw_lines) > MAX_PURCHASE_LINES:
        raise ValueError(f"at most {MAX_PURCHASE_LINES} cards per purchase")
    catalog = _catalog_rows(
        connection, [str(line.get("cardId") or "").strip() for line in raw_lines if isinstance(line, dict)]
    )
    lines: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_lines):
        if not isinstance(raw, dict):
            raise ValueError(f"lines[{index}] must be an object")
        card_id = str(raw.get("cardId") or "").strip()
        row = catalog.get(card_id)
        if row is None:
            raise ValueError(f"lines[{index}].cardId is not a known card")
        quantity = raw.get("quantity", 1)
        if isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= MAX_LINE_QUANTITY:
            raise ValueError(f"lines[{index}].quantity must be 1-{MAX_LINE_QUANTITY}")
        grader = _clean_text(raw.get("grader"), 16)
        lines.append({
            "index": index,
            "cardId": card_id,
            # Names and art come from the catalog, never the client.
            "name": row[1],
            "setName": row[2],
            "number": row[3],
            "imageUrl": row[4] or row[5],
            "variantName": _clean_text(raw.get("variantName")),
            "condition": None if grader else _clean_text(raw.get("condition"), 32),
            "grader": grader,
            "grade": _clean_text(raw.get("grade"), 16) if grader else None,
            "certNumber": _clean_text(raw.get("certNumber"), 32) if grader else None,
            "quantity": quantity,
            "paidUsd": _money(raw.get("offerUsd"), f"lines[{index}].offerUsd", required=True),
            "marketUsd": _money(raw.get("marketUsd"), f"lines[{index}].marketUsd", required=False),
            "buyPercent": _money(raw.get("buyPercent"), f"lines[{index}].buyPercent", required=False),
            "tier": _clean_text(raw.get("tier"), 16),
        })
    return batch_id, lines


def record_purchases(
    connection: sqlite3.Connection,
    owner_user_id: str,
    payload: Any,
    record_buy: Callable[[dict[str, Any]], dict[str, Any]],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Record accepted tray rows through the existing buy path (cost basis =
    the offer) and log each in vendor_purchases. Idempotent per
    (batchId, line): a retry skips lines already recorded."""
    batch_id, lines = _parse_lines(connection, payload)
    bought_at = _iso(now or datetime.now(timezone.utc))
    recorded: list[int] = []
    skipped: list[int] = []
    for line in lines:
        index = line["index"]
        # Claim first, so a double tap can never buy the same line twice.
        try:
            connection.execute(
                """
                INSERT INTO vendor_purchases (
                    owner_user_id, batch_id, line_index, card_id, name, set_name, number, image_url,
                    variant_name, condition, grader, grade, cert_number, quantity, paid_usd, market_usd,
                    buy_percent, tier, bought_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    owner_user_id, batch_id, index, line["cardId"], line["name"], line["setName"], line["number"],
                    line["imageUrl"], line["variantName"], line["condition"], line["grader"], line["grade"],
                    line["certNumber"], line["quantity"], line["paidUsd"], line["marketUsd"], line["buyPercent"],
                    line["tier"], bought_at,
                ),
            )
            connection.commit()
        except sqlite3.IntegrityError:
            connection.rollback()
            skipped.append(index)
            continue
        buy_payload: dict[str, Any] = {
            "cardID": line["cardId"],
            "quantity": line["quantity"],
            "unitPrice": line["paidUsd"],
            "costBasisPerUnit": line["paidUsd"],
            "currencyCode": "USD",
            "boughtAt": bought_at,
        }
        if line["grader"]:
            buy_payload["slabContext"] = {
                "grader": line["grader"],
                "grade": line["grade"],
                "certNumber": line["certNumber"],
                "variantName": line["variantName"],
            }
        else:
            buy_payload["variantName"] = line["variantName"]
            buy_payload["condition"] = line["condition"]
        try:
            result = record_buy(buy_payload)
        except Exception:
            connection.execute(
                "DELETE FROM vendor_purchases WHERE owner_user_id = ? AND batch_id = ? AND line_index = ?",
                (owner_user_id, batch_id, index),
            )
            connection.commit()
            raise
        connection.execute(
            "UPDATE vendor_purchases SET deck_entry_id = ? WHERE owner_user_id = ? AND batch_id = ? AND line_index = ?",
            (str(result.get("deckEntryID") or "") or None, owner_user_id, batch_id, index),
        )
        connection.commit()
        recorded.append(index)
    return {
        "batchId": batch_id,
        "recordedLineIndexes": recorded,
        "alreadyRecordedLineIndexes": skipped,
        "boughtAt": bought_at,
    }


def bought_log(
    connection: sqlite3.Connection,
    owner_user_id: str,
    current_value: Callable[[dict[str, Any]], float | None],
    *,
    limit: int = 200,
) -> dict[str, Any]:
    """Newest first. `current_value(line)` resolves today's per-unit market for
    the line's exact printing/condition/grade (None when unpriced)."""
    rows = connection.execute(
        """
        SELECT batch_id, line_index, card_id, name, set_name, number, image_url, variant_name, condition,
               grader, grade, cert_number, quantity, paid_usd, market_usd, bought_at
        FROM vendor_purchases
        WHERE owner_user_id = ?
        ORDER BY bought_at DESC, batch_id, line_index
        LIMIT ?
        """,
        (owner_user_id, max(1, min(int(limit), 500))),
    ).fetchall()
    entries: list[dict[str, Any]] = []
    totals = {"paidUsd": 0.0, "marketAtBuyUsd": 0.0, "currentValueUsd": 0.0}
    for (batch_id, line_index, card_id, name, set_name, number, image_url, variant_name, condition,
         grader, grade, cert_number, quantity, paid, market, bought_at) in rows:
        quantity = int(quantity)
        current = current_value({
            "cardId": card_id, "variantName": variant_name, "condition": condition,
            "grader": grader, "grade": grade, "certNumber": cert_number,
        })
        paid_total = round(float(paid) * quantity, 2)
        current_total = round(current * quantity, 2) if current is not None else None
        entries.append({
            "batchId": batch_id,
            "lineIndex": int(line_index),
            "cardId": card_id,
            "name": name,
            "setName": set_name,
            "number": number,
            "imageUrl": image_url,
            "variantName": variant_name,
            "condition": condition,
            "grader": grader,
            "grade": grade,
            "quantity": quantity,
            "paidUsd": paid_total,
            "marketAtBuyUsd": round(float(market) * quantity, 2) if market is not None else None,
            "currentValueUsd": current_total,
            "profitUsd": round(current_total - paid_total, 2) if current_total is not None else None,
            "boughtAt": bought_at,
        })
        totals["paidUsd"] += paid_total
        if market is not None:
            totals["marketAtBuyUsd"] += float(market) * quantity
        if current_total is not None:
            totals["currentValueUsd"] += current_total
    summary: dict[str, Any] = {key: round(value, 2) for key, value in totals.items()}
    summary["count"] = len(entries)
    return {"entries": entries, "summary": summary, "currencyCode": "USD"}


# --- HTTP ---------------------------------------------------------------------
#
# server.py calls `handle_http(handler, method, parsed)` first thing in do_GET /
# do_POST; it returns True when it answered, so the shared server file only
# carries the hook.

SETTINGS_PATH = "/api/v1/me/vendor-settings"
BOUGHT_PATH = "/api/v1/vendor/bought"


def handle_http(handler: Any, method: str, parsed: Any) -> bool:
    from http import HTTPStatus  # noqa: PLC0415

    path = parsed.path
    if path not in (SETTINGS_PATH, BOUGHT_PATH) or method not in ("GET", "POST"):
        return False
    identity = handler._require_request_identity()
    if identity is None:
        return True
    payload: Any = None
    if method == "POST":
        payload = handler._read_json_body()
        if payload is None:
            handler._write_json(
                getattr(handler, "_json_body_error_status", None) or HTTPStatus.BAD_REQUEST,
                {"error": getattr(handler, "_json_body_error_message", None) or "Invalid JSON body"},
            )
            return True
    service = handler.service
    try:
        with service.request_identity_context(identity):
            owner = service._current_owner_user_id()
            connection = service.connection
            if path == SETTINGS_PATH:
                settings = (
                    get_settings(connection, owner) if method == "GET" else set_settings(connection, owner, payload)
                )
                result: dict[str, Any] = {"settings": settings}
            elif method == "GET":
                result = bought_log(connection, owner, lambda line: _current_unit_value(service, line))
            else:
                result = record_purchases(connection, owner, payload, service.record_buy)
    except ValueError as error:
        handler._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        return True
    except FileNotFoundError as error:
        handler._write_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
        return True
    except Exception as error:  # noqa: BLE001
        import traceback  # noqa: PLC0415

        traceback.print_exc()
        handler._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Vendor request failed: {error}"})
        return True
    handler._write_json(HTTPStatus.OK, result)
    return True


def _current_unit_value(service: Any, line: dict[str, Any]) -> float | None:
    if not line.get("cardId"):
        return None
    price, _ = service._added_baseline_now(
        line["cardId"],
        grader=line.get("grader"),
        grade=line.get("grade"),
        cert_number=line.get("certNumber"),
        variant_name=line.get("variantName"),
        condition=line.get("condition"),
    )
    return price
