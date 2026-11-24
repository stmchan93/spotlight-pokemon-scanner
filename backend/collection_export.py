"""Collection spreadsheet export (Settings → Export collection).

Pure formatter over the owner-scoped ``entries`` the Collection view serves, so
prices, owner scope and cost basis match the app exactly. One row per SKU:
copies of the same card, printing, condition (raw) or grader + grade (slab) in
the same collection merge into one row with their quantities summed. USD only:
a price in any other currency is left blank, never converted or shown.
"""

from __future__ import annotations

import csv
import io
from typing import Any
from urllib.parse import urlencode, quote

from catalog_tools import game_display_name

COLLECTION_EXPORT_COLUMNS: tuple[str, ...] = (
    "Name",
    "Set",
    "Number",
    "Rarity",
    "Language",
    "Game",
    "Collection",
    "Type",
    "Printing",
    "Condition",
    "Grader",
    "Grade",
    "Cert #",
    "Quantity",
    "Market price (each)",
    "Market value",
    "Price date",
    "Paid (each)",
    "Paid (total)",
    "Gain/loss $",
    "Gain/loss %",
    "Price when added",
    "Change since added %",
    "Date added",
    "Link",
    "Card ID",
)

_RAW_CONDITION_LABELS: dict[str, str] = {
    "NM": "Near Mint",
    "LP": "Lightly Played",
    "MP": "Moderately Played",
    "HP": "Heavily Played",
    "DM": "Damaged",
    "DMG": "Damaged",
    "NEAR_MINT": "Near Mint",
    "LIGHTLY_PLAYED": "Lightly Played",
    "MODERATELY_PLAYED": "Moderately Played",
    "HEAVILY_PLAYED": "Heavily Played",
    "DAMAGED": "Damaged",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _money(value: float | None) -> str:
    return "" if value is None else f"{value:.2f}"


def _percent(value: float | None) -> str:
    return "" if value is None else f"{value:.1f}"


def _usd_market_price(card: dict[str, Any]) -> tuple[float | None, str]:
    """The price the Collection tile shows (market, then mid/low/trend) and its
    date. Slabs are priced for their grader + grade upstream. Blank unless USD."""
    pricing = card.get("pricing")
    if not isinstance(pricing, dict):
        return None, ""
    currency = _text(pricing.get("currencyCode")).upper() or "USD"
    if currency != "USD":
        return None, ""
    for key in ("market", "mid", "low", "trend"):
        price = _number(pricing.get(key))
        if price is not None:
            stamp = _text(
                pricing.get("sourceUpdatedAt") or pricing.get("refreshedAt") or pricing.get("updatedAt")
            )
            return price, stamp[:10]
    return None, ""


def _known_cost_total(entry: dict[str, Any]) -> float | None:
    """Total paid for the holding, or None when the user never entered a cost
    (stored as 0 with no per-unit cents — counting that as $0 paid would show
    the whole value as gain)."""
    if _text(entry.get("costBasisCurrencyCode")).upper() not in ("", "USD"):
        return None
    total = _number(entry.get("costBasisTotal"))
    if entry.get("costBasisCents") is None and not total:
        return None
    return total


def _search_query(card: dict[str, Any], *, slab: dict[str, Any] | None) -> str:
    parts = []
    if slab:
        parts.append(" ".join(p for p in (_text(slab.get("grader")), _text(slab.get("grade"))) if p))
    parts += [_text(card.get("name")), _text(card.get("number")), _text(card.get("setName"))]
    return " ".join(p for p in parts if p)


def _link(card: dict[str, Any], *, slab: dict[str, Any] | None) -> str:
    """Raw → the TCGplayer product (search when it has no product id);
    graded → eBay sold listings for that grade."""
    if slab:
        return "https://www.ebay.com/sch/i.html?" + urlencode(
            {"_nkw": _search_query(card, slab=slab), "LH_Sold": "1", "LH_Complete": "1"}
        )
    product_id = _text(card.get("tcgplayerProductId"))
    if product_id.isdigit():
        return f"https://www.tcgplayer.com/product/{product_id}"
    return "https://www.tcgplayer.com/search/all/product?q=" + quote(_search_query(card, slab=None))


def _sku_key(entry: dict[str, Any]) -> tuple[str, ...]:
    card = entry.get("card") if isinstance(entry.get("card"), dict) else {}
    slab = entry.get("slabContext") if isinstance(entry.get("slabContext"), dict) else None
    collection = _text(entry.get("collectionId") or entry.get("collectionName"))
    card_id = _text(card.get("id"))
    if slab:
        return (collection, card_id, "graded", _text(slab.get("variantName")).lower(),
                _text(slab.get("grader")).upper(), _text(slab.get("grade")).lower())
    return (collection, card_id, "raw", _text(entry.get("variantName")).lower(),
            _text(entry.get("condition")).upper(), "")


def _merge(entries: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        groups.setdefault(_sku_key(entry), []).append(entry)
    return list(groups.values())


def _quantity(entry: dict[str, Any]) -> int:
    try:
        return max(0, int(entry.get("quantity") or 0))
    except (TypeError, ValueError):
        return 0


def collection_export_rows(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merged SKU rows (as dicts keyed by column), highest market value first."""
    rows: list[dict[str, Any]] = []
    for group in _merge(entries):
        first = group[0]
        card = first.get("card") if isinstance(first.get("card"), dict) else {}
        slab = first.get("slabContext") if isinstance(first.get("slabContext"), dict) else None
        quantity = sum(_quantity(e) for e in group)
        price, price_date = _usd_market_price(card)
        value = round(price * quantity, 2) if price is not None else None

        costs = [_known_cost_total(e) for e in group]
        paid_total = round(sum(c for c in costs if c is not None), 2) if costs and all(c is not None for c in costs) else None
        paid_each = round(paid_total / quantity, 2) if paid_total is not None and quantity else None
        gain = round(value - paid_total, 2) if value is not None and paid_total is not None else None
        gain_pct = (gain / paid_total * 100) if gain is not None and paid_total else None

        # Add-day baseline, quantity-weighted across the merged copies.
        weighted, weight = 0.0, 0
        for e in group:
            baseline = _number(e.get("sinceAddedBaselinePrice"))
            if baseline is not None and baseline > 0:
                weighted += baseline * _quantity(e)
                weight += _quantity(e)
        added_price = round(weighted / weight, 2) if weight else None
        since_pct = ((price - added_price) / added_price * 100) if price is not None and added_price else None

        added_dates = sorted(_text(e.get("addedAt"))[:10] for e in group if _text(e.get("addedAt")))
        certs = sorted({_text((e.get("slabContext") or {}).get("certNumber")) for e in group} - {""})
        condition_code = _text(first.get("condition")).upper()

        rows.append({
            "Name": _text(card.get("name")),
            "Set": _text(card.get("setName")),
            "Number": _text(card.get("number")),
            "Rarity": _text(card.get("rarity")),
            "Language": _text(card.get("language")),
            "Game": game_display_name(card.get("game")) if card.get("game") else "",
            "Collection": _text(first.get("collectionName")) or "Main Collection",
            "Type": "Graded" if slab else "Raw",
            "Printing": _text((slab or {}).get("variantName") if slab else first.get("variantName")),
            "Condition": "" if slab else _RAW_CONDITION_LABELS.get(
                condition_code.replace(" ", "_").replace("-", "_"), _text(first.get("condition"))
            ),
            "Grader": _text((slab or {}).get("grader")),
            "Grade": _text((slab or {}).get("grade")),
            "Cert #": "; ".join(certs),
            "Quantity": str(quantity),
            "Market price (each)": _money(price),
            "Market value": _money(value),
            "Price date": price_date,
            "Paid (each)": _money(paid_each),
            "Paid (total)": _money(paid_total),
            "Gain/loss $": _money(gain),
            "Gain/loss %": _percent(gain_pct),
            "Price when added": _money(added_price),
            "Change since added %": _percent(since_pct),
            "Date added": added_dates[0] if added_dates else "",
            "Link": _link(card, slab=slab),
            "Card ID": _text(card.get("id")),
            "_value": value or 0.0,
            "_paid": paid_total,
            "_quantity": quantity,
        })
    rows.sort(key=lambda row: (-row["_value"], row["Name"].lower()))
    return rows


def collection_export_csv(entries: list[dict[str, Any]]) -> str:
    rows = collection_export_rows(entries)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(COLLECTION_EXPORT_COLUMNS)
    for row in rows:
        writer.writerow([row[column] for column in COLLECTION_EXPORT_COLUMNS])
    if rows:
        priced = [row for row in rows if row["Market value"]]
        value_total = round(sum(row["_value"] for row in priced), 2) if priced else None
        # Gain totals only over rows with both a cost and a price.
        both = [row for row in rows if row["_paid"] is not None and row["Market value"]]
        paid_known = round(sum(row["_paid"] for row in both), 2) if both else None
        gain_total = round(sum(row["_value"] for row in both) - paid_known, 2) if both else None
        totals = {column: "" for column in COLLECTION_EXPORT_COLUMNS}
        totals.update({
            "Name": "TOTAL",
            "Quantity": str(sum(row["_quantity"] for row in rows)),
            "Market value": _money(value_total),
            "Paid (total)": _money(paid_known),
            "Gain/loss $": _money(gain_total),
            "Gain/loss %": _percent(gain_total / paid_known * 100 if gain_total is not None and paid_known else None),
        })
        writer.writerow([totals[column] for column in COLLECTION_EXPORT_COLUMNS])
    return buffer.getvalue()
