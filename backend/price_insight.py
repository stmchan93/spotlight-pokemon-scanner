"""Card-page price one-liner ("Up 18% in 30 days · near its 90-day high").

Pure functions over data the daily sync already stored (a row's dated price
series, cached slab sales). No provider calls, no LLM: facts are computed here
and the sentence comes from a fixed template. Every threshold lives below.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

# --- Thresholds (the single place to tune) ----------------------------------
MIN_PRICE_USD = 1.0  # below this the moves are noise
CHANGE_WINDOW_DAYS = 30
CHANGE_SLACK_DAYS = 5  # "30 days ago" point may sit 25-35 days back
CHANGE_MIN_PCT = 5.0
CHANGE_MAX_PCT = 1000.0  # mirrors market_movers.DEFAULT_MAX_CHANGE_PCT (glitch cap)
RANGE_WINDOW_DAYS = 90
RANGE_MIN_POINTS = 20
RANGE_MIN_SPREAD = 1.10  # 90-day max/min must differ by >= 10%
RANGE_NEAR_EDGE = 0.97  # within 3% of the high (or low)
MAX_STEP_MULTIPLE = 3.0  # mirrors market_movers.MAX_STEP_MULTIPLE (single-day glitch)
MAX_STALE_DAYS = 3  # newest point must be this fresh, or the series says nothing
SALES_WINDOW_DAYS = 30
SALES_MIN_COUNT = 3
MAX_FACTS = 2
SEPARATOR = " · "


def _parse_day(value: Any) -> date | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _clean_series(series: Iterable[tuple[Any, Any]]) -> list[tuple[date, float]]:
    """Positive points, one per day (the later entry wins), oldest -> newest."""
    by_day: dict[date, float] = {}
    for raw_day, raw_value in series:
        day = _parse_day(raw_day)
        if day is None or raw_value is None or isinstance(raw_value, bool):
            continue
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            continue
        if value > 0:
            by_day[day] = value
    return sorted(by_day.items())


def _has_outlier_step(values: list[float]) -> bool:
    return any(max(a, b) / min(a, b) > MAX_STEP_MULTIPLE for a, b in zip(values, values[1:]))


def series_facts(
    series: Iterable[tuple[Any, Any]],
    *,
    currency_code: str | None,
    today: date | None = None,
) -> list[dict[str, Any]]:
    """change_30d / high_90d / low_90d facts for one USD price series of
    ``(date, price)`` pairs. Empty when the series is not USD, stale, sparse,
    cheap, or glitchy."""
    if str(currency_code or "").strip().upper() != "USD":
        return []
    points = _clean_series(series)
    if len(points) < 2:
        return []
    today = today or datetime.now(timezone.utc).date()
    last_day, current = points[-1]
    if (today - last_day).days > MAX_STALE_DAYS or current < MIN_PRICE_USD:
        return []
    window = [(d, v) for d, v in points if d >= last_day - timedelta(days=RANGE_WINDOW_DAYS)]
    if _has_outlier_step([v for _, v in window]):
        return []

    facts: list[dict[str, Any]] = []
    change_pct: float | None = None
    target = last_day - timedelta(days=CHANGE_WINDOW_DAYS)
    then = [(abs((d - target).days), v) for d, v in points if abs((d - target).days) <= CHANGE_SLACK_DAYS]
    if then:
        then_value = min(then)[1]
        change_pct = (current - then_value) / then_value * 100.0
        if CHANGE_MIN_PCT <= abs(change_pct) <= CHANGE_MAX_PCT and round(change_pct) != 0:
            facts.append({"kind": "change_30d", "value": int(round(change_pct))})

    if len(window) >= RANGE_MIN_POINTS:
        high = max(v for _, v in window)
        low = min(v for _, v in window)
        if high / low >= RANGE_MIN_SPREAD:
            # A rise never reads "lowest", a fall never reads "near the high".
            if current >= high * RANGE_NEAR_EDGE and (change_pct is None or change_pct >= 0):
                facts.append({"kind": "high_90d", "value": round(high, 2)})
            elif current * RANGE_NEAR_EDGE <= low and (change_pct is None or change_pct <= 0):
                facts.append({"kind": "low_90d", "value": round(low, 2), "atLow": current <= low})
    return facts


def sales_fact(
    sales: Iterable[dict[str, Any]],
    *,
    today: date | None = None,
    capped: bool = False,
) -> dict[str, Any] | None:
    """sales_30d fact from cached, already-cleaned slab sales (USD only).
    ``capped`` = the cache read hit its row limit, so the count is a floor."""
    today = today or datetime.now(timezone.utc).date()
    cutoff = today - timedelta(days=SALES_WINDOW_DAYS)
    count = 0
    for sale in sales:
        currency = str(sale.get("currencyCode") or "USD").strip().upper()
        sold = _parse_day(sale.get("soldAt") or sale.get("sold_at"))
        try:
            price = float(sale.get("price")) if sale.get("price") is not None else 0.0
        except (TypeError, ValueError):
            price = 0.0
        if currency == "USD" and price > 0 and sold is not None and cutoff <= sold <= today:
            count += 1
    if count < SALES_MIN_COUNT:
        return None
    return {"kind": "sales_30d", "value": count, "atLeast": capped}


def _fact_phrase(fact: dict[str, Any]) -> str | None:
    kind = fact.get("kind")
    value = fact.get("value")
    if kind == "change_30d":
        return f"{'up' if value > 0 else 'down'} {abs(int(value))}% in {CHANGE_WINDOW_DAYS} days"
    if kind == "high_90d":
        return f"near its {RANGE_WINDOW_DAYS}-day high"
    if kind == "low_90d":
        return f"lowest in {RANGE_WINDOW_DAYS} days" if fact.get("atLow") else f"near its {RANGE_WINDOW_DAYS}-day low"
    if kind == "sales_30d":
        return f"{int(value)}{'+' if fact.get('atLeast') else ''} sales in the last {SALES_WINDOW_DAYS} days"
    return None


def build_insight(facts: list[dict[str, Any]], *, prefix: str | None = None) -> dict[str, Any] | None:
    """``{"text", "facts"}`` from at most MAX_FACTS facts, or None when there
    is nothing notable. ``prefix`` (e.g. "PSA 10") leads the sentence."""
    kept: list[dict[str, Any]] = []
    phrases: list[str] = []
    for fact in facts:
        phrase = _fact_phrase(fact)
        if phrase is None:
            continue
        kept.append({"kind": fact["kind"], "value": fact["value"]})
        phrases.append(phrase)
        if len(kept) == MAX_FACTS:
            break
    if not kept:
        return None
    phrases[0] = phrases[0][:1].upper() + phrases[0][1:]
    lead = [prefix.strip()] if prefix and prefix.strip() else []
    return {"text": SEPARATOR.join(lead + phrases), "facts": kept}


def compute_price_insight(
    series: Iterable[tuple[Any, Any]] | None,
    *,
    currency_code: str | None,
    sales: Iterable[dict[str, Any]] | None = None,
    sales_capped: bool = False,
    prefix: str | None = None,
    today: date | None = None,
) -> dict[str, Any] | None:
    """One row's insight: sales count first (graded), then series facts."""
    facts: list[dict[str, Any]] = []
    if sales is not None:
        fact = sales_fact(sales, today=today, capped=sales_capped)
        if fact is not None:
            facts.append(fact)
    if series is not None:
        facts.extend(series_facts(series, currency_code=currency_code, today=today))
    return build_insight(facts, prefix=prefix)
