"""Price quality: when a served price is not a current, trustworthy number.

One rule set shared by the chat/MCP tools and the app's collection endpoints:

- STALE: the price's latest observation is older than ``PRICE_STALE_DAYS``.
  Clocks per lane: a TCGplayer (TCGCSV) main price uses its own refresh stamp
  (that lane is only served while fresh); a Scrydex raw price uses the newest
  ``raw`` cell day (the snapshot's ``updated_at`` also moves on graded-only
  writes); a graded price takes the newer of the newest ``graded`` cell day and
  the snapshot refresh (staging writes no graded cells).
- UNTRUSTED: a raw price above the same card's own PSA 10 for the same printing
  (``RAW_OVER_PSA10_MARGIN``, JPY converted to USD) — a raw copy can't be worth
  more than its own gem-mint slab (Scrydex raw-JP anchors).

Both are withheld: the caller shows no price and leaves the holding out of
totals. ``load_price_quality`` reads every card's facts in one query per chunk
of ids; ``assess_price`` judges one served pricing summary against them.
"""

from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta, timezone
from typing import Any

from catalog_tools import (
    RAW_MAIN_PRICE_SOURCE_TCGCSV,
    _amount_to_usd,
    _chunked_sql_values,
    _normalized_variant_label,
    _variant_match_key,
    pricing_provider,
)

PRICE_STALE_DAYS = 14
RAW_OVER_PSA10_MARGIN = 1.0

STATUS_STALE = "stale"
STATUS_UNTRUSTED = "untrusted"

# Marks the facts statement in query traces (read-shape tests tell it apart from
# history-series reads).
QUERY_MARKER = "/* price_quality */"

# Price fields nulled on a withheld summary (same set the phantom guard nulls).
_WITHHELD_PRICE_KEYS = ("market", "low", "mid", "high", "trend", "directLow", "trendsPct")


def stale_cutoff(today: date | None = None) -> str:
    """ISO day before which an observation is stale (UTC calendar)."""
    day = today or datetime.now(timezone.utc).date()
    return (day - timedelta(days=PRICE_STALE_DAYS)).isoformat()


def _has_cells_table(connection: sqlite3.Connection) -> bool:
    return (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_price_history_cell'"
        ).fetchone()
        is not None
    )


def load_price_quality(
    connection: sqlite3.Connection, card_ids: list[str] | Any
) -> dict[str, dict[str, Any]]:
    """card_id -> {raw_date, graded_date, psa10}: the newest Scrydex raw/graded
    cell day (the provider's last observation of that lane) and the USD PSA 10
    market per printing (variant match key) on the newest graded day. TCGCSV
    raw_main cells don't count: that lane carries its own clock.

    One statement per chunk of ids; the date lookups walk the
    (card_id, provider, price_date, lane, ...) covering index newest-first, and
    only the newest graded day's PSA 10 rows are fetched."""
    ids = list(dict.fromkeys(str(card_id) for card_id in card_ids if card_id))
    out: dict[str, dict[str, Any]] = {card_id: {} for card_id in ids}
    if not ids or not _has_cells_table(connection):
        return out
    provider = pricing_provider()
    # +lane keeps each lookup on the (card_id, provider, price_date) prefix, newest first.
    latest = (
        "(SELECT cell.price_date FROM card_price_history_cell cell WHERE cell.card_id = cards.id "
        "AND cell.provider = ? AND +cell.lane = ? ORDER BY cell.price_date DESC LIMIT 1)"
    )
    rates: dict[str, float | None] = {}
    for chunk in _chunked_sql_values(ids):
        rows = connection.execute(
            f"""
            /* price_quality */
            WITH latest AS (
                SELECT cards.id AS card_id, {latest} AS raw_date, {latest} AS graded_date
                FROM cards WHERE cards.id IN ({','.join('?' for _ in chunk)})
            )
            SELECT latest.card_id, latest.raw_date, latest.graded_date,
                   psa.variant_key, psa.market, psa.currency_code
            FROM latest
            LEFT JOIN card_price_history_cell psa
              ON psa.card_id = latest.card_id AND psa.provider = ? AND psa.price_date = latest.graded_date
             AND +psa.lane = 'graded' AND UPPER(psa.grader) = 'PSA' AND CAST(psa.grade AS REAL) = 10
             AND COALESCE(psa.is_perfect, 0) = 0 AND COALESCE(psa.is_signed, 0) = 0
             AND COALESCE(psa.is_error, 0) = 0 AND psa.market > 0
            """,
            (provider, "raw", provider, "graded", *chunk, provider),
        ).fetchall()
        for card_id, raw_date, graded_date, variant_key, market, currency in rows:
            facts = out.setdefault(str(card_id), {})
            facts["raw_date"] = raw_date
            facts["graded_date"] = graded_date
            if market is None:
                continue
            code = str(currency or "USD").strip().upper() or "USD"
            if code not in rates:
                rates[code] = _amount_to_usd(connection, 1.0, code)
            rate = rates[code]
            usd = float(market) if code == "USD" else (float(market) * rate if rate is not None else None)
            if usd is None or usd <= 0:
                continue
            key = _variant_match_key(_normalized_variant_label(variant_key))
            psa10 = facts.setdefault("psa10", {})
            psa10[key] = min(usd, psa10.get(key, usd))
    return out


def served_price(pricing: dict[str, Any] | None) -> float | None:
    """The number a holding is valued at: market, else mid, low, trend."""
    if not isinstance(pricing, dict):
        return None
    for key in ("market", "mid", "low", "trend"):
        value = pricing.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def is_tcgplayer_main(pricing: dict[str, Any] | None) -> bool:
    """The TCGCSV main lane served this summary (its own refresh clock)."""
    return (
        isinstance(pricing, dict)
        and str(pricing.get("mainPriceSource") or "").strip().lower() == RAW_MAIN_PRICE_SOURCE_TCGCSV
    )


def assess_price(
    pricing: dict[str, Any] | None,
    price: float | None,
    facts: dict[str, Any] | None,
    *,
    graded: bool,
    cutoff: str | None = None,
) -> dict[str, Any] | None:
    """None for a usable current price (or no price), else the verdict:
    {"status": "stale", "as_of": "YYYY-MM-DD"} or
    {"status": "untrusted", "psa10_usd": float}."""
    if price is None or not isinstance(pricing, dict):
        return None
    facts = facts or {}
    refreshed = str(pricing.get("refreshedAt") or "")[:10] or None
    if is_tcgplayer_main(pricing):
        observed = refreshed
    elif graded:
        observed = max((d for d in (facts.get("graded_date"), refreshed) if d), default=None)
    else:
        observed = facts.get("raw_date") or refreshed
    if observed and observed < (cutoff or stale_cutoff()):
        return {"status": STATUS_STALE, "as_of": observed}
    if not graded:
        psa10 = (facts.get("psa10") or {}).get(
            _variant_match_key(_normalized_variant_label(pricing.get("variant")))
        )
        if psa10 is not None and price > psa10 * RAW_OVER_PSA10_MARGIN:
            return {"status": STATUS_UNTRUSTED, "psa10_usd": psa10}
    return None


def withheld_pricing(pricing: dict[str, Any], verdict: dict[str, Any]) -> dict[str, Any]:
    """App shape: a copy of ``pricing`` with every price field nulled and the
    reason stamped (``priceStatus`` / ``priceAsOf``, plus ``suppressionReason``
    like the phantom guard). The input is never mutated."""
    out = dict(pricing)
    for key in _WITHHELD_PRICE_KEYS:
        if key in out:
            out[key] = None
    out["suppressionReason"] = verdict["status"]
    out["priceStatus"] = verdict["status"]
    out["priceAsOf"] = verdict.get("as_of")
    if verdict.get("psa10_usd") is not None:
        out["ownPsa10Price"] = round(float(verdict["psa10_usd"]), 2)
    return out


def verdict_from_pricing(pricing: dict[str, Any] | None) -> dict[str, Any] | None:
    """The verdict a ``withheld_pricing`` summary carries (None when served)."""
    if not isinstance(pricing, dict):
        return None
    status = pricing.get("priceStatus")
    if status not in (STATUS_STALE, STATUS_UNTRUSTED):
        return None
    verdict: dict[str, Any] = {"status": status}
    if status == STATUS_STALE:
        verdict["as_of"] = pricing.get("priceAsOf")
    else:
        verdict["psa10_usd"] = pricing.get("ownPsa10Price")
    return verdict


def apply_price_quality(
    pricing: dict[str, Any] | None,
    facts: dict[str, Any] | None,
    *,
    graded: bool,
    cutoff: str | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """(pricing to serve, verdict): the app's one-call form of ``assess_price``.
    Only an untrusted price is withheld. A stale one is still the card's last
    known value, so the app shows and counts it (owner, 2026-11-23: dropping
    23 cards from a collection total over a two-week-old price was wrong)."""
    verdict = assess_price(pricing, served_price(pricing), facts, graded=graded, cutoff=cutoff)
    if verdict is None or pricing is None or verdict.get("status") == STATUS_STALE:
        return pricing, None
    return withheld_pricing(pricing, verdict), verdict
