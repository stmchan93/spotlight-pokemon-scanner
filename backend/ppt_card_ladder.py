"""Card Ladder–style graded valuation from PPT eBay sold listings.

Replicates Card Ladder's documented per-card method, computed from a single PPT
`/cards` payload's `ebay.soldListings` block (individual sold rows per grade,
Business tier). Pure functions over the payload + an `as_of` date so they are
deterministic and unit-testable; the daily PPT sync passes its `price_date` as
`as_of` and recomputes from fresh data each run.

Method (https://cardladder.zendesk.com/.../What-is-Card-Ladder-Value):
- value = AVERAGE of all sales on the MOST RECENT day the card sold (relists
  deduped first).
- confidence 1-5 by recency of that last-sold date: <=14d->5, <=30d->4, <=90d->3,
  <=180d->2, else 1.
- grade-ratio fallback when the card's own last sale is stale (>90d): use a higher
  grade of the SAME card that sold within 6 months, multiplied by the historical
  price ratio between the two grades (prefer the highest-grade comp).
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from statistics import median
from typing import Any

# salesByGrade / soldListings keys are "{company}{grade}" with half grades as "_5"
# (psa10, cgc9_5). Mirrors ppt_adapter's parser but kept local so this module has no
# import cycle with ppt_adapter.
_GRADE_KEY_RE = re.compile(r"^([a-z]+)(\d+(?:_\d+)?)$", re.IGNORECASE)


def grade_sort_key(grade_key: str) -> float | None:
    """Numeric grade for ranking comps (psa10->10.0, cgc9_5->9.5). None if unparseable."""
    match = _GRADE_KEY_RE.match(str(grade_key or "").strip())
    if not match:
        return None
    try:
        return float(match.group(2).replace("_", "."))
    except ValueError:
        return None


# ---- date / title helpers ---------------------------------------------------

_DATE_RE = re.compile(r"(\d{4})[-/](\d{2})[-/](\d{2})")


def parse_sold_date(value: Any) -> date | None:
    """Parse PPT `soldDate` (ISO 8601 or YYYY/MM/DD) to a date. None if unparseable."""
    text = str(value or "").strip()
    if not text:
        return None
    match = _DATE_RE.search(text)
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def coerce_as_of(as_of: Any) -> date:
    """Normalize an `as_of` (date | 'YYYY-MM-DD' | datetime) to a date."""
    if isinstance(as_of, date) and not isinstance(as_of, datetime):
        return as_of
    if isinstance(as_of, datetime):
        return as_of.date()
    parsed = parse_sold_date(as_of)
    if parsed is not None:
        return parsed
    raise ValueError(f"un-parseable as_of: {as_of!r}")


def _normalize_title(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _coerce_price(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else None
    if isinstance(value, str):
        text = value.strip().replace("$", "").replace(",", "")
        try:
            num = float(text)
        except ValueError:
            return None
        return num if num > 0 else None
    return None


# ---- core: normalize + dedupe sold listings --------------------------------

def normalize_sales(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """PPT soldListings rows -> [{price, date, title}] with usable price+date only."""
    sales: list[dict[str, Any]] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        price = _coerce_price(row.get("price"))
        sold = parse_sold_date(row.get("soldDate") or row.get("sold_at") or row.get("date"))
        if price is None or sold is None:
            continue
        sales.append({"price": price, "date": sold, "title": _normalize_title(row.get("title"))})
    return sales


def dedupe_relists(sales: list[dict[str, Any]], *, day_gap: int = 2) -> list[dict[str, Any]]:
    """Collapse the SAME normalized title + SAME price within `day_gap` days to one
    sale (a relisted/re-scraped duplicate of the same item)."""
    kept: list[dict[str, Any]] = []
    for sale in sorted(sales, key=lambda s: s["date"]):
        dup = any(
            k["title"] == sale["title"]
            and abs(k["price"] - sale["price"]) < 0.005
            and abs((sale["date"] - k["date"]).days) <= day_gap
            for k in kept
        )
        if not dup:
            kept.append(sale)
    return kept


# ---- core: last-sold value + confidence ------------------------------------

def confidence_from_recency(last_sold: date, as_of: date) -> int:
    """Card Ladder 1-5 confidence by how recent the last sale is."""
    days = (as_of - last_sold).days
    if days <= 14:
        return 5
    if days <= 30:
        return 4
    if days <= 90:
        return 3
    if days <= 180:
        return 2
    return 1


def last_sold_value(sales: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Average of all (deduped) sales on the most recent day the card sold."""
    deduped = dedupe_relists(sales)
    if not deduped:
        return None
    last_day = max(s["date"] for s in deduped)
    day_sales = [s["price"] for s in deduped if s["date"] == last_day]
    return {
        "value": round(sum(day_sales) / len(day_sales), 2),
        "lastSoldDate": last_day.isoformat(),
        "count": len(day_sales),
    }


# ---- core: grade-ratio fallback --------------------------------------------

def grade_ratio_value(
    target_key: str,
    sales_by_grade: dict[str, list[dict[str, Any]]],
    as_of: date,
    *,
    comp_recent_days: int = 183,
    pair_window_days: int = 183,
) -> dict[str, Any] | None:
    """Estimate a stale grade's value from a higher grade that sold recently.

    Pick the highest-grade comp whose most-recent sale is within ~6 months; the ratio
    is the median of (target_past_price / comp_past_price) over historical pairs that
    sold within ~6 months of each other; value = comp_last_sold * ratio.
    """
    target_sales = dedupe_relists(sales_by_grade.get(target_key, []))
    if not target_sales:
        return None

    comps: list[tuple[Any, str, list[dict[str, Any]]]] = []
    for key, rows in sales_by_grade.items():
        if key == target_key:
            continue
        comp_sales = dedupe_relists(rows)
        if not comp_sales:
            continue
        comp_last = max(s["date"] for s in comp_sales)
        if (as_of - comp_last).days > comp_recent_days:
            continue
        sort_key = grade_sort_key(key)
        if sort_key is None:
            continue
        comps.append((sort_key, key, comp_sales))
    if not comps:
        return None

    # Prefer the highest grade (most liquid / least volatile).
    comps.sort(key=lambda c: c[0], reverse=True)
    for _, comp_key, comp_sales in comps:
        ratios = [
            t["price"] / c["price"]
            for t in target_sales
            for c in comp_sales
            if c["price"] > 0 and abs((t["date"] - c["date"]).days) <= pair_window_days
        ]
        if not ratios:
            continue
        comp_last_day = max(s["date"] for s in comp_sales)
        comp_last_prices = [s["price"] for s in comp_sales if s["date"] == comp_last_day]
        comp_last_value = sum(comp_last_prices) / len(comp_last_prices)
        return {
            "value": round(comp_last_value * median(ratios), 2),
            "sourceGrade": comp_key,
            "ratio": round(median(ratios), 4),
        }
    return None


# ---- top-level: per (grader, grade) Card Ladder value ----------------------

def card_ladder_value_for_grade(
    target_key: str,
    sales_by_grade: dict[str, list[dict[str, Any]]],
    as_of: date,
) -> dict[str, Any] | None:
    """Card Ladder value for one grade key (e.g. 'psa10'): last-sold day average +
    recency confidence, falling back to a grade-ratio estimate when stale."""
    sales = normalize_sales(sales_by_grade.get(target_key, []))
    direct = last_sold_value(sales)
    if direct is not None:
        last = parse_sold_date(direct["lastSoldDate"])
        confidence = confidence_from_recency(last, as_of) if last else 1
        if confidence >= 3:  # own sale is recent enough (<=90d) — use it
            return {
                "value": direct["value"],
                "confidence": confidence,
                "method": "last_sold",
                "lastSoldDate": direct["lastSoldDate"],
                "count": direct["count"],
            }
        # Stale own sale: try a grade-ratio estimate; prefer it if available.
        normalized = {k: normalize_sales(v) for k, v in sales_by_grade.items()}
        ratio = grade_ratio_value(target_key, normalized, as_of)
        if ratio is not None:
            return {
                "value": ratio["value"],
                "confidence": min(confidence + 1, 3),
                "method": "grade_ratio",
                "lastSoldDate": direct["lastSoldDate"],
                "sourceGrade": ratio["sourceGrade"],
                "ratio": ratio["ratio"],
            }
        # No eligible comp: keep the stale own value at its low confidence.
        return {
            "value": direct["value"],
            "confidence": confidence,
            "method": "last_sold",
            "lastSoldDate": direct["lastSoldDate"],
            "count": direct["count"],
        }

    # Never sold in this grade: try a grade-ratio estimate only.
    normalized = {k: normalize_sales(v) for k, v in sales_by_grade.items()}
    ratio = grade_ratio_value(target_key, normalized, as_of)
    if ratio is not None:
        return {
            "value": ratio["value"],
            "confidence": 1,
            "method": "grade_ratio",
            "lastSoldDate": None,
            "sourceGrade": ratio["sourceGrade"],
            "ratio": ratio["ratio"],
        }
    return None


def card_ladder_values_from_card(card: dict[str, Any], as_of: Any) -> dict[str, dict[str, Any]]:
    """All Card Ladder graded values for a PPT card payload, keyed by the PPT grade
    key (e.g. 'psa10'). Empty when the card has no `ebay.soldListings`."""
    as_of_date = coerce_as_of(as_of)
    ebay = card.get("ebay") if isinstance(card.get("ebay"), dict) else {}
    sold_listings = ebay.get("soldListings") if isinstance(ebay.get("soldListings"), dict) else {}
    sales_by_grade: dict[str, list[dict[str, Any]]] = {
        str(k): v for k, v in sold_listings.items() if isinstance(v, list)
    }
    out: dict[str, dict[str, Any]] = {}
    for key in sales_by_grade:
        value = card_ladder_value_for_grade(key, sales_by_grade, as_of_date)
        if value is not None:
            out[key] = value
    return out
