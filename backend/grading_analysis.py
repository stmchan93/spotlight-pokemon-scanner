""""Worth grading?" analysis: raw Near Mint vs PSA graded outcomes after fees.

Pure math + summary helpers. The server reads the prices (the same stored rows
the card page's Price Trend lanes show) and calls ``build_analysis``; the
2-3 sentence verdict comes from a small Claude call with a rules fallback.
Contract: docs/grading-analysis-2026-11-24.md.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

SUPPORTED_GRADERS = ("PSA",)
OUTCOME_GRADES = ("10", "9", "8", "7")

# Fees are read from backend/data/grading_fees.json, the single, hand-updated source
# of truth (also used by mcp_server/grading_fees.py). Missing or invalid -> 204.
FEES_PATH = Path(__file__).resolve().parent / "data" / "grading_fees.json"
FEES_PATH_ENV = "SPOTLIGHT_GRADING_FEES_PATH"

# Overrides the whole shipping figure (inbound default + PSA return fee).
SHIPPING_ENV = "GRADING_SHIPPING_USD"

# Same small model the in-app assistant defaults to (mcp_server/assistant/config.py).
SUMMARY_MODEL = "claude-haiku-5-5"
SUMMARY_MODEL_ENV = "GRADING_ANALYSIS_MODEL"
SUMMARY_TIMEOUT_SECONDS = 8.0
SUMMARY_MAX_TOKENS = 220

CACHE_MAX_ENTRIES = 2000
# A failed AI call falls back to rules; retry the AI after this instead of all day.
FALLBACK_CACHE_TTL_SECONDS = 600.0


class NoGradingData(Exception):
    """No USD raw NM price or no USD PSA graded prices -> 204."""


@dataclass(frozen=True)
class PsaFees:
    as_of: str | None
    source_url: str | None
    inbound_shipping_usd: float
    tiers: tuple[dict[str, Any], ...]  # open single-card tiers: name, feeUsd, valueCapUsd (None = unlimited), turnaroundText
    # ((insured value cap or None, return fee for one card), ...), lowest cap first
    return_fees: tuple[tuple[float | None, float], ...]


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _turnaround_text(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return "turnaround not published"
    return f"~{text.replace('-', '–')} business days"


_INSURED_KEY = re.compile(r"up_to_(\d+)_insured_usd$")


def parse_psa_fees(raw: Any) -> PsaFees | None:
    """PSA's open single-card tiers + return fees from the fee file, or None if unusable."""
    if not isinstance(raw, dict) or not isinstance(raw.get("graders"), dict):
        return None
    psa = raw["graders"].get("PSA")
    if not isinstance(psa, dict) or not isinstance(psa.get("tiers"), list):
        return None
    tiers: list[dict[str, Any]] = []
    for item in psa["tiers"]:
        if not isinstance(item, dict) or item.get("available") is False:
            continue
        min_cards = _number(item.get("min_cards"))
        if min_cards is not None and min_cards > 1:
            continue
        fee = _number(item.get("price_usd"))
        if fee is None or fee < 0:
            continue
        tiers.append({
            "name": str(item.get("name") or item.get("id") or "").strip() or "PSA",
            "feeUsd": fee,
            "valueCapUsd": _number(item.get("max_declared_value_usd")),
            "turnaroundText": _turnaround_text(item.get("turnaround_business_days")),
        })
    if not tiers:
        return None
    inbound = _number(raw.get("shipping_usd"))
    if inbound is None or inbound < 0:
        return None
    return_fees: list[tuple[float | None, float]] = []
    shipping = psa.get("return_shipping")
    if isinstance(shipping, dict):
        for key, value in shipping.items():
            match = _INSURED_KEY.search(str(key))
            if match and isinstance(value, dict):
                fee = _number(value.get("1-4") if value.get("1-4") is not None else value.get("1"))
                if fee is not None and fee >= 0:
                    return_fees.append((float(match.group(1)), fee))
    as_of = raw.get("as_of")
    return PsaFees(
        as_of=str(as_of)[:10] if as_of else None,
        source_url=str(psa.get("source_url") or "").strip() or None,
        inbound_shipping_usd=inbound,
        tiers=tuple(tiers),
        return_fees=tuple(sorted(return_fees, key=lambda rate: (rate[0] is None, rate[0] or 0))),
    )


_fees_cache: tuple[str, float, PsaFees] | None = None
_fees_lock = threading.Lock()


def fees_path() -> Path:
    override = str(os.environ.get(FEES_PATH_ENV) or "").strip()
    return Path(override) if override else FEES_PATH


def load_psa_fees() -> PsaFees:
    """Parsed once per file version (re-read only when its mtime changes). Raises NoGradingData."""
    global _fees_cache
    path = fees_path()
    try:
        mtime = path.stat().st_mtime
    except OSError as error:
        raise NoGradingData(f"grading fee file missing: {path}") from error
    with _fees_lock:
        if _fees_cache is not None and _fees_cache[0] == str(path) and _fees_cache[1] == mtime:
            return _fees_cache[2]
        try:
            fees = parse_psa_fees(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError) as error:
            raise NoGradingData(f"grading fee file unreadable: {path}") from error
        if fees is None:
            raise NoGradingData(f"grading fee file has no usable PSA tiers: {path}")
        _fees_cache = (str(path), mtime, fees)
        return fees


def select_tier(fees: PsaFees, declared_value_usd: float) -> dict[str, Any]:
    """Cheapest open tier whose cap covers the value (None = unlimited), else the highest tier."""
    fitting = [t for t in fees.tiers if t["valueCapUsd"] is None or t["valueCapUsd"] >= declared_value_usd]
    if fitting:
        return dict(min(fitting, key=lambda t: t["feeUsd"]))
    return dict(max(fees.tiers, key=lambda t: (t["valueCapUsd"] is None, t["valueCapUsd"] or 0, t["feeUsd"])))


def shipping_usd(fees: PsaFees, declared_value_usd: float) -> float:
    """Inbound default (file's shipping_usd) + PSA's published return fee covering the
    value, if any. GRADING_SHIPPING_USD replaces the whole figure."""
    override = str(os.environ.get(SHIPPING_ENV) or "").strip()
    if override:
        try:
            value = float(override)
            if value >= 0:
                return value
        except ValueError:
            pass
    return_fee = 0.0
    if fees.return_fees:
        covering = [fee for cap, fee in fees.return_fees if cap is None or declared_value_usd <= cap]
        return_fee = covering[0] if covering else fees.return_fees[-1][1]
    return fees.inbound_shipping_usd + return_fee


def normalize_grade(grade: Any) -> str | None:
    """'10' / '10.0' / 10 -> '10'; half grades and junk -> None."""
    try:
        value = float(str(grade).strip())
    except (TypeError, ValueError):
        return None
    if not value.is_integer():
        return None
    key = str(int(value))
    return key if key in OUTCOME_GRADES else None


def _money(value: float) -> float:
    return round(float(value) + 0.0, 2)


def build_analysis(
    *,
    card_id: str,
    variant: str | None,
    raw_price_usd: float | None,
    grade_prices_usd: dict[str, float],
    prices_as_of: str | None,
    fees: PsaFees | None = None,
) -> dict[str, Any]:
    """Everything but the summary. Raises NoGradingData when inputs or fees are missing."""
    if raw_price_usd is None or raw_price_usd <= 0:
        raise NoGradingData("no raw Near Mint USD price")
    prices = {
        grade: float(price)
        for grade, price in grade_prices_usd.items()
        if grade in OUTCOME_GRADES and price is not None and float(price) > 0
    }
    if not prices:
        raise NoGradingData("no PSA USD graded prices")

    # PSA prices by declared value; the 10 is the ceiling. Without a 10, the best priced grade.
    declared_value = prices.get("10", max(prices.values()))
    fees = fees or load_psa_fees()
    tier = select_tier(fees, declared_value)
    ship = shipping_usd(fees, declared_value)
    total_cost = _money(tier["feeUsd"] + ship)
    raw = _money(raw_price_usd)

    outcomes: list[dict[str, Any]] = []
    for grade in OUTCOME_GRADES:
        if grade not in prices:
            continue
        price = _money(prices[grade])
        net = _money(price - total_cost)
        gain = _money(net - raw)
        outcomes.append({"grade": grade, "priceUsd": price, "netUsd": net, "gainVsRawUsd": gain, "worthIt": gain > 0})

    worth = [o["grade"] for o in outcomes if o["worthIt"]]
    break_even = worth[-1] if worth else None  # outcomes are best-first
    if not worth:
        verdict = "not_worth_it"
    elif worth == ["10"]:
        verdict = "only_at_10"
    else:
        verdict = "worth_it"

    return {
        "cardId": card_id,
        "grader": "PSA",
        "variant": variant,
        "currencyCode": "USD",
        "rawPriceUsd": raw,
        "tier": {
            "name": tier["name"],
            "feeUsd": _money(tier["feeUsd"]),
            "valueCapUsd": _money(tier["valueCapUsd"]) if tier["valueCapUsd"] is not None else None,
            "turnaroundText": tier["turnaroundText"],
        },
        "shippingUsd": _money(ship),
        "totalCostUsd": total_cost,
        "outcomes": outcomes,
        "breakEvenGrade": break_even,
        "verdict": verdict,
        "summary": "",
        "summarySource": "rules",
        "pricesAsOf": prices_as_of,
        "feesAsOf": fees.as_of,
        "feesSourceUrl": fees.source_url,
    }


def _usd(value: float) -> str:
    return f"${value:,.0f}" if abs(value) >= 100 else f"${value:,.2f}"


def rules_summary(analysis: dict[str, Any]) -> str:
    tier = analysis["tier"]
    cost = (
        f"Grading costs about {_usd(analysis['totalCostUsd'])} "
        f"({tier['name']} {_usd(tier['feeUsd'])} plus {_usd(analysis['shippingUsd'])} shipping) "
        f"and takes {tier['turnaroundText']}."
    )
    raw = _usd(analysis["rawPriceUsd"])
    outcomes = {o["grade"]: o for o in analysis["outcomes"]}
    verdict = analysis["verdict"]
    if verdict == "worth_it":
        grade = analysis["breakEvenGrade"]
        return f"Worth grading: a PSA {grade} or better beats selling it raw at {raw}. {cost}"
    if verdict == "only_at_10":
        gain = _usd(outcomes["10"]["gainVsRawUsd"])
        return (
            f"Worth grading only if you're confident it's a 10. A PSA 10 comes out about {gain} ahead of "
            f"selling raw at {raw}; anything lower leaves you behind. {cost}"
        )
    best = analysis["outcomes"][0]
    return (
        f"Not worth grading at current prices. Even a PSA {best['grade']} comes out "
        f"{_usd(abs(best['gainVsRawUsd']))} behind selling raw at {raw}. {cost}"
    )


_SYSTEM_PROMPT = (
    "You write the verdict line for a trading-card app's 'Worth grading?' panel. "
    "Use ONLY the numbers given. Plain English, at most 3 short sentences. "
    "Lead with the verdict, e.g. \"Worth grading only if you're confident it's a 10.\" "
    "Mention the break-even grade (the lowest PSA grade that beats selling raw) and the wait. "
    "Never state probabilities, odds or percentages of getting a grade. Never invent facts "
    "(population, condition, centering, history). All money is US dollars; write it as $. "
    "Output only the sentences, no heading, no markdown."
)

_VERDICT_TEXT = {
    "worth_it": "worth grading (a grade below 10 also beats selling raw)",
    "only_at_10": "worth grading only at PSA 10",
    "not_worth_it": "not worth grading (no grade beats selling raw)",
}

_BANNED = re.compile(r"%|\bodds\b|\bprobab|\bchance|¥|\bJPY\b|\byen\b|\*\*|^#", re.IGNORECASE | re.MULTILINE)


def summary_prompt(analysis: dict[str, Any], card: dict[str, Any] | None) -> str:
    card = card or {}
    facts = {
        "card": {
            "name": card.get("name"),
            "set": card.get("setName"),
            "number": card.get("number"),
            "printing": analysis.get("variant"),
        },
        "rawNearMintPriceUsd": analysis["rawPriceUsd"],
        "tier": analysis["tier"],
        "shippingUsd": analysis["shippingUsd"],
        "totalGradingCostUsd": analysis["totalCostUsd"],
        "outcomes": analysis["outcomes"],
        "breakEvenGrade": analysis["breakEvenGrade"],
        "verdict": _VERDICT_TEXT[analysis["verdict"]],
    }
    return (
        "Numbers (netUsd = graded price minus grading cost; gainVsRawUsd = netUsd minus the raw price; "
        "selling fees ignored):\n" + json.dumps(facts, ensure_ascii=False)
    )


def _response_text(response: dict[str, Any]) -> str:
    blocks = response.get("content") if isinstance(response, dict) else None
    parts = [
        str(block.get("text") or "")
        for block in blocks or []
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    return " ".join(" ".join(parts).split())


def _acceptable(text: str) -> bool:
    if not text or len(text) > 600 or _BANNED.search(text):
        return False
    return len(re.findall(r"[.!?](?:\s|$)", text)) <= 3


_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="grading-summary")


def ai_summary(
    analysis: dict[str, Any],
    card: dict[str, Any] | None,
    *,
    request_fn: Callable[..., dict[str, Any]] | None = None,
    api_key: str | None = None,
    timeout_seconds: float = SUMMARY_TIMEOUT_SECONDS,
) -> str | None:
    """Claude's 2-3 sentences, or None on a missing key / error / timeout / bad output."""
    if request_fn is None:
        from anthropic_adapter import anthropic_api_key, anthropic_messages_request

        if (api_key if api_key is not None else anthropic_api_key()) is None:
            return None
        request_fn = anthropic_messages_request
    payload = {
        "model": (os.environ.get(SUMMARY_MODEL_ENV) or SUMMARY_MODEL).strip(),
        "max_tokens": SUMMARY_MAX_TOKENS,
        "system": _SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": summary_prompt(analysis, card)}],
    }
    future = _executor.submit(request_fn, payload, timeout=max(1, int(timeout_seconds) - 1))
    try:
        response = future.result(timeout=timeout_seconds)
    except FutureTimeoutError:
        future.cancel()
        return None
    except Exception:  # noqa: BLE001 - any failure falls back to rules
        return None
    text = _response_text(response)
    return text if _acceptable(text) else None


@dataclass
class _Entry:
    payload: dict[str, Any]
    expires_at: float | None


class GradingAnalysisCache:
    """In-memory, bounded FIFO. The key carries the UTC day and a price fingerprint."""

    def __init__(self, max_entries: int = CACHE_MAX_ENTRIES) -> None:
        self._entries: dict[tuple[Any, ...], _Entry] = {}
        self._lock = threading.Lock()
        self._max_entries = max_entries

    @staticmethod
    def key(analysis: dict[str, Any], *, day: str) -> tuple[Any, ...]:
        variant = str(analysis.get("variant") or "").strip().lower()
        fingerprint = (
            analysis["rawPriceUsd"],
            tuple((o["grade"], o["priceUsd"]) for o in analysis["outcomes"]),
            analysis["totalCostUsd"],
            analysis["tier"]["name"],
            analysis.get("feesAsOf"),
            analysis.get("pricesAsOf"),
        )
        return (analysis["cardId"], variant, day, fingerprint)

    def get(self, key: tuple[Any, ...]) -> dict[str, Any] | None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            if entry.expires_at is not None and time.monotonic() >= entry.expires_at:
                self._entries.pop(key, None)
                return None
            return entry.payload

    def put(self, key: tuple[Any, ...], payload: dict[str, Any], *, ttl_seconds: float | None = None) -> None:
        expires_at = time.monotonic() + ttl_seconds if ttl_seconds is not None else None
        with self._lock:
            if key not in self._entries and len(self._entries) >= self._max_entries:
                self._entries.pop(next(iter(self._entries)), None)
            self._entries[key] = _Entry(payload, expires_at)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
