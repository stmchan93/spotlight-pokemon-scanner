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


def build_ppt_graded_contexts(card: dict[str, Any], *, provider: str = PPT_PROVIDER) -> dict[str, Any]:
    """graded_contexts from `ebay.salesByGrade` (one flat entry per grader/grade)."""
    graded_contexts = _empty_graded_contexts()
    ebay = card.get("ebay") if isinstance(card.get("ebay"), dict) else {}
    sales_by_grade = ebay.get("salesByGrade") if isinstance(ebay.get("salesByGrade"), dict) else {}
    for key, value in sales_by_grade.items():
        if not isinstance(value, dict):
            continue
        parsed = parse_ppt_grade_key(key)
        if parsed is None:
            continue
        grader, grade = parsed
        median = _coerce_price(value.get("medianPrice"))
        average = _coerce_price(value.get("averagePrice"))
        smart = _coerce_price(value.get("smartMarketPrice"))
        confidence = str(value.get("smartMarketConfidence") or "").strip().lower()
        # Prefer PPT's current-market (smartMarketPrice) when it's trustworthy
        # (high/medium confidence); fall back to the lagging-but-stable median for
        # thin / low-confidence grades (low-confidence smart can be wildly off).
        if smart is not None and confidence in ("high", "medium"):
            market = smart
        elif median is not None:
            market = median
        elif average is not None:
            market = average
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
            payload={"count": value.get("count"), "source": "ppt-ebay",
                     "median": median, "smart": smart, "confidence": confidence or None},
        )
    return graded_contexts


def build_ppt_pricing_bundle(
    card: dict[str, Any], *, provider: str = PPT_PROVIDER
) -> dict[str, Any]:
    """Full PPT → contexts bundle for one card: the inputs upsert_price_snapshot /
    upsert_price_history_daily need. `tcgplayer_id` is PPT's `tcgPlayerId` — the
    join key to our cards.tcgplayer_id."""
    return {
        "tcgplayer_id": str(card.get("tcgPlayerId") or "").strip() or None,
        "external_catalog_id": str(card.get("externalCatalogId") or "").strip() or None,
        "currency_code": "USD",
        "raw_contexts": build_ppt_raw_contexts(card, provider=provider),
        "graded_contexts": build_ppt_graded_contexts(card, provider=provider),
    }


# ---------------------------------------------------------------------------
# GemRate population (PPT `/population` + Business `/export type=population`)
# ---------------------------------------------------------------------------

# `GraderPopulation` count keys are `g1`..`g10` plus half grades `g1_5`..`g9_5`.
# Everything else on that object (gemRate, totalPopulation, perfect, pristine,
# qualifiers, auth) is metadata, not a per-grade count.
_GRADE_COUNT_KEY_RE = re.compile(r"^g(\d+(?:_\d+)?)$", re.IGNORECASE)

# PPT names Beckett "BECKETT" in populationByGrader, but the app's grader chips
# (and Scrydex graded contexts) call it "BGS". Normalize so the PDP's BGS lane
# actually resolves a report. Confirmed against a live /population response.
_GRADER_ALIASES = {"BECKETT": "BGS"}


def _normalize_grader_key(grader: Any) -> str:
    key = str(grader or "").strip().upper()
    return _GRADER_ALIASES.get(key, key)


def _normalize_gem_rate(value: Any) -> float | None:
    """PPT's per-grader `gemRate` arrives as a 0–1 fraction in the live API (e.g.
    0.3489 = 34.9%), but the published spec example showed it pre-multiplied
    (20.83). Normalize both to a percentage: scale up only when it looks like a
    fraction (≤ 1)."""
    rate = _coerce_price(value)
    if rate is None:
        return None
    return rate * 100 if 0 < rate <= 1 else rate


def _coerce_count(value: Any) -> int | None:
    """Non-negative integer count, or None. Floats/strings are coerced; bools are not."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value) if value >= 0 else None
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        if not text:
            return None
        try:
            number = int(float(text))
        except ValueError:
            return None
        return number if number >= 0 else None
    return None


def build_population_entry(grader_pop: dict[str, Any]) -> dict[str, Any] | None:
    """One `GraderPopulation` dict (e.g. the PSA value of `populationByGrader`) →
    our normalized entry `{"totalPopulation", "gemRate", "grades": {"10": n, "9.5": n}}`.
    Grade keys are dotted decimals ("9.5") for direct display; gemRate is a
    percentage. Only grades with a NON-ZERO count are kept (the live API returns a
    full g1..g10 ladder mostly zeroed — storing/showing those is just noise).
    Returns None when the grader has no populated grade at all."""
    if not isinstance(grader_pop, dict):
        return None
    grades: dict[str, int] = {}
    for key, value in grader_pop.items():
        match = _GRADE_COUNT_KEY_RE.match(str(key))
        if not match:
            continue
        count = _coerce_count(value)
        if not count:  # drop None and 0 — only populated grades are meaningful
            continue
        grades[match.group(1).replace("_", ".")] = count
    if not grades:
        return None
    total = _coerce_count(grader_pop.get("totalPopulation"))
    if total is None:
        total = sum(grades.values())
    return {"totalPopulation": total, "gemRate": _normalize_gem_rate(grader_pop.get("gemRate")),
            "grades": grades}


def build_card_population(gemrate_data: dict[str, Any]) -> dict[str, Any]:
    """A `GemrateData` dict (the `/population` response's `data`, or one tcgPlayerId's
    merged export rows) → `{grader: entry}` keyed by grading company (PSA/BGS/CGC/SGC).
    Beckett is normalized to "BGS" to match the app's grader chips. Skips graders
    with no populated grade. Empty dict when nothing is usable."""
    by_grader = gemrate_data.get("populationByGrader") if isinstance(gemrate_data, dict) else None
    if not isinstance(by_grader, dict):
        return {}
    out: dict[str, Any] = {}
    for grader, grader_pop in by_grader.items():
        entry = build_population_entry(grader_pop)
        if entry is not None:
            out[_normalize_grader_key(grader)] = entry
    return out
