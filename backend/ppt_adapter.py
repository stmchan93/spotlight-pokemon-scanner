"""PokemonPriceTracker (PPT) → our pricing-contexts adapter.

Turns a PPT card record (the `/cards` JSON shape, which the Business `/export`
`cards`+`ebay` dumps mirror) into the SAME `raw_contexts` / `graded_contexts`
dicts the rest of the backend already consumes (built via catalog_tools'
`_upsert_raw_context_entry` / `_upsert_graded_context_entry`), so PPT data flows
into `card_price_snapshots` / `card_price_history_daily` / `card_price_history_cell`
with zero changes to the read path.

Mapping (from the real PPT v2 schema + a live Moonbreon probe):
- raw:  `prices.market`/`prices.low` for the primary printing, plus best-effort
  per-printing/condition prices from `variants`. PPT gives ONE price per
  variant/condition (no low/mid/high split), so we set `market` and leave the rest
  None — the UI degrades to showing market only.
- graded: `ebay.salesByGrade["{company}{grade}"]` (e.g. `psa10`, `cgc9_5`) → ONE
  entry per (grader, grade): market=medianPrice, low=minPrice, high=maxPrice,
  mid=averagePrice, trend=marketPrice7Day. PPT graded is FLAT — no signed/perfect/
  variant axis — so every entry has those flags False (the signed-leak / corrupt
  guards in the resolver simply never trigger).
"""

from __future__ import annotations

import re
from typing import Any

from catalog_tools import (
    _empty_graded_contexts,
    _empty_raw_contexts,
    _upsert_graded_context_entry,
    _upsert_raw_context_entry,
)
from ppt_card_ladder import card_ladder_values_from_card

PPT_PROVIDER = "ppt"

# PPT condition labels → our raw condition codes. Covers the TCGplayer condition
# names PPT returns plus the short/normalized forms, so `_normalized_condition_code`
# downstream gets a clean code (its own alias map only knows snake_case).
_PPT_CONDITION_TO_CODE = {
    "near mint": "NM", "near_mint": "NM", "nm": "NM", "mint": "NM",
    "lightly played": "LP", "lightly_played": "LP", "lp": "LP",
    "moderately played": "MP", "moderately_played": "MP", "mp": "MP",
    "heavily played": "HP", "heavily_played": "HP", "hp": "HP",
    "damaged": "DM", "dmg": "DM", "dm": "DM", "d": "DM",
}

# salesByGrade keys are "{company}{grade}" with half grades as "_5": psa10, cgc9_5,
# bgs9_5, tag10, ace10, sgc9. Letters = grader, trailing number(_N) = grade.
_GRADE_KEY_RE = re.compile(r"^([a-z]+)(\d+(?:_\d+)?)$", re.IGNORECASE)


def _coerce_price(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip().replace("$", "").replace(",", "")
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            return None
    return None


def _ppt_condition_code(label: Any) -> str:
    return _PPT_CONDITION_TO_CODE.get(str(label or "").strip().lower(), "NM")


def parse_ppt_grade_key(key: str) -> tuple[str, str] | None:
    """`"psa10"` -> `("PSA","10")`, `"cgc9_5"` -> `("CGC","9.5")`. None if unparseable."""
    match = _GRADE_KEY_RE.match(str(key or "").strip())
    if not match:
        return None
    grader = match.group(1).upper()
    grade = match.group(2).replace("_", ".")
    return grader, grade


def build_ppt_raw_contexts(card: dict[str, Any], *, provider: str = PPT_PROVIDER) -> dict[str, Any]:
    """raw_contexts from a PPT card's `prices` (headline) + `variants` (per-printing)."""
    raw_contexts = _empty_raw_contexts()
    currency = "USD"  # PPT raw prices are USD (Cardmarket EUR is a separate field).

    prices = card.get("prices") if isinstance(card.get("prices"), dict) else {}
    primary_printing = str(prices.get("primaryPrinting") or "").strip() or None
    headline_market = _coerce_price(prices.get("market"))
    headline_low = _coerce_price(prices.get("low"))

    # Per-printing / per-condition prices (best-effort; PPT gives one price each).
    variants = card.get("variants") if isinstance(card.get("variants"), dict) else {}
    seen_primary_nm = False
    for printing, printing_value in variants.items():
        if not isinstance(printing_value, dict):
            continue
        for condition_label, condition_value in printing_value.items():
            price = _coerce_price(
                condition_value.get("price") if isinstance(condition_value, dict) else condition_value
            )
            if price is None:
                continue
            code = _ppt_condition_code(condition_label)
            _upsert_raw_context_entry(
                raw_contexts,
                variant=printing,
                condition=code,
                provider=provider,
                currency_code=currency,
                low_price=None,
                market_price=price,
                mid_price=None,
                high_price=None,
                payload={"variantKey": str(printing).strip()},
            )
            if primary_printing and str(printing).strip().lower() == primary_printing.lower() and code == "NM":
                seen_primary_nm = True

    # Always carry the headline market as the primary printing's NM price so the
    # app's main raw number is populated even when `variants` is sparse/absent.
    if headline_market is not None and not seen_primary_nm:
        _upsert_raw_context_entry(
            raw_contexts,
            variant=primary_printing,
            condition="NM",
            provider=provider,
            currency_code=currency,
            low_price=headline_low,
            market_price=headline_market,
            mid_price=None,
            high_price=None,
            payload={"variantKey": str(primary_printing or "").strip()} if primary_printing else None,
        )
    return raw_contexts


def build_ppt_graded_contexts(
    card: dict[str, Any], *, provider: str = PPT_PROVIDER, as_of: Any = None
) -> dict[str, Any]:
    """graded_contexts for a PPT card (one flat entry per grader/grade).

    Prefers a **Card Ladder value** (last-sold-day average + recency confidence +
    grade-ratio fallback) computed from individual `ebay.soldListings` — present only
    on the per-card `includeBoth` path. Where soldListings are absent (the aggregate
    `/export` path), falls back to `salesByGrade` (smartMarketPrice when confident,
    else median). `as_of` (the sync's price_date) anchors the recency math.
    """
    graded_contexts = _empty_graded_contexts()
    ebay = card.get("ebay") if isinstance(card.get("ebay"), dict) else {}
    sales_by_grade = ebay.get("salesByGrade") if isinstance(ebay.get("salesByGrade"), dict) else {}

    cl_values: dict[str, Any] = {}
    if as_of is not None:
        try:
            cl_values = card_ladder_values_from_card(card, as_of)
        except (ValueError, TypeError):
            cl_values = {}

    for key in set(sales_by_grade) | set(cl_values):
        parsed = parse_ppt_grade_key(key)
        if parsed is None:
            continue
        grader, grade = parsed
        value = sales_by_grade.get(key) if isinstance(sales_by_grade.get(key), dict) else {}
        median = _coerce_price(value.get("medianPrice"))
        average = _coerce_price(value.get("averagePrice"))
        smart = _coerce_price(value.get("smartMarketPrice"))
        smart_confidence = str(value.get("smartMarketConfidence") or "").strip().lower()
        cl = cl_values.get(key)

        if cl is not None:
            # Card Ladder: last-sold day average (relists deduped) + 1-5 recency
            # confidence, grade-ratio fallback when stale. Takes precedence.
            market = cl["value"]
            payload = {
                "source": "ppt-cardladder",
                "method": cl["method"],
                "confidence": cl["confidence"],
                "lastSoldDate": cl.get("lastSoldDate"),
                "sourceGrade": cl.get("sourceGrade"),
                "count": cl.get("count"),
            }
        elif smart is not None and smart_confidence in ("high", "medium"):
            market = smart
            payload = {"count": value.get("count"), "source": "ppt-ebay",
                       "median": median, "smart": smart, "confidence": smart_confidence or None}
        elif median is not None or average is not None:
            market = median if median is not None else average
            payload = {"count": value.get("count"), "source": "ppt-ebay",
                       "median": median, "smart": smart, "confidence": smart_confidence or None}
        else:
            continue  # no usable graded price for this grade

        _upsert_graded_context_entry(
            graded_contexts,
            grader=grader,
            grade=grade,
            variant=None,
            provider=provider,
            currency_code="USD",
            low_price=_coerce_price(value.get("minPrice")),
            market_price=market,
            mid_price=median if median is not None else average,
            high_price=_coerce_price(value.get("maxPrice")),
            trend_price=_coerce_price(value.get("marketPrice7Day")) or smart,
            is_perfect=False,
            is_signed=False,
            is_error=False,
            payload=payload,
        )
    return graded_contexts


def build_ppt_pricing_bundle(
    card: dict[str, Any], *, provider: str = PPT_PROVIDER, as_of: Any = None
) -> dict[str, Any]:
    """Full PPT → contexts bundle for one card: the inputs upsert_price_snapshot /
    upsert_price_history_daily need. `tcgplayer_id` is PPT's `tcgPlayerId` — the
    join key to our cards.tcgplayer_id. `as_of` (price_date) anchors the Card Ladder
    recency math for graded values."""
    return {
        "tcgplayer_id": str(card.get("tcgPlayerId") or "").strip() or None,
        "external_catalog_id": str(card.get("externalCatalogId") or "").strip() or None,
        "currency_code": "USD",
        "raw_contexts": build_ppt_raw_contexts(card, provider=provider),
        "graded_contexts": build_ppt_graded_contexts(card, provider=provider, as_of=as_of),
    }
