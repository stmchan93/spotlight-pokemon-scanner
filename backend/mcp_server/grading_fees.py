"""Grading fee table for the "should I grade this?" math.

Source of truth: backend/data/grading_fees.json (hand-maintained, has an as-of
date, editable without an OTA). Until that file exists, or if it can't be read,
PLACEHOLDER_TABLE is used and every result says placeholder=True.

The loader accepts a few JSON shapes, all normalized to FeeTable:
  {"as_of": "...", "shipping_usd": 20, "graders": {"PSA": {"tiers": [{"name", "fee_usd", "max_value_usd"}]}}}
  {"as_of": "...", "shipping": {"round_trip_usd": 20}, "PSA": [{"tier", "price_usd", "max_declared_value_usd"}]}
A tier without a value cap is the catch-all. The cheapest tier whose cap covers
the card's graded value is used (graders price by declared value).
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger("ekalight.grading_fees")

FEES_PATH = Path(__file__).resolve().parents[1] / "data" / "grading_fees.json"
FEES_PATH_ENV = "SPOTLIGHT_GRADING_FEES_PATH"
GRADERS = ("PSA", "BGS", "CGC")
DEFAULT_SHIPPING_USD = 20.0

# Clearly labelled placeholder until data/grading_fees.json lands. Not quoted as current fees.
PLACEHOLDER_TABLE: dict[str, Any] = {
    "as_of": None,
    "placeholder": True,
    "shipping_usd": DEFAULT_SHIPPING_USD,
    "graders": {
        "PSA": {"tiers": [
            {"name": "Standard", "fee_usd": 59.99, "max_value_usd": 1000},
            {"name": "Priority", "fee_usd": 79.99, "max_value_usd": 1500},
            {"name": "Express", "fee_usd": 199.0, "max_value_usd": 2500},
            {"name": "Super Express", "fee_usd": 349.0, "max_value_usd": None},
        ]},
        "BGS": {"tiers": [{"name": "Express", "fee_usd": 79.95, "max_value_usd": None}]},
        "CGC": {"tiers": [
            {"name": "Economy", "fee_usd": 20.0, "max_value_usd": 1000},
            {"name": "Standard", "fee_usd": 55.0, "max_value_usd": 3000},
            {"name": "Express", "fee_usd": 100.0, "max_value_usd": None},
        ]},
    },
}


@dataclass(frozen=True)
class FeeTier:
    name: str
    fee_usd: float
    max_value_usd: float | None  # None = no cap
    turnaround: str | None = None


@dataclass(frozen=True)
class FeeTable:
    as_of: str | None
    placeholder: bool
    shipping_usd: float
    graders: dict[str, tuple[FeeTier, ...]] = field(default_factory=dict)
    # grader -> ((insured value cap or None, return fee for 1 card), ...), cheapest cap first
    return_shipping: dict[str, tuple[tuple[float | None, float], ...]] = field(default_factory=dict)

    def shipping_for(self, grader: str, value_usd: float | None) -> float:
        """The grader's published return fee covering value_usd, else the default."""
        rates = self.return_shipping.get(str(grader or "").strip().upper()) or ()
        value = float(value_usd or 0.0)
        for cap, fee in rates:
            if cap is None or value <= cap:
                return fee
        return rates[-1][1] if rates else self.shipping_usd

    def fee_for(self, grader: str, value_usd: float | None) -> FeeTier | None:
        """Cheapest tier whose value cap covers value_usd; None = grader unknown."""
        tiers = self.graders.get(str(grader or "").strip().upper())
        if not tiers:
            return None
        value = float(value_usd or 0.0)
        fitting = [tier for tier in tiers if tier.max_value_usd is None or value <= tier.max_value_usd]
        pool = fitting or [max(tiers, key=lambda tier: tier.fee_usd)]
        return min(pool, key=lambda tier: tier.fee_usd)

    def summary(self) -> dict[str, Any]:
        return {"as_of": self.as_of, "placeholder": self.placeholder, "shipping_usd": self.shipping_usd}


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).replace("$", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _first(raw: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if raw.get(key) is not None:
            return raw[key]
    return None


def _tier(raw: Any) -> FeeTier | None:
    if not isinstance(raw, dict) or raw.get("available") is False:
        return None
    min_cards = _number(raw.get("min_cards"))
    if min_cards is not None and min_cards > 1:
        return None  # one card can't use a minimum-count tier
    fee = _number(_first(raw, ("fee_usd", "price_usd", "fee", "price", "cost_usd", "per_card_usd")))
    if fee is None or fee < 0:
        return None
    cap = _number(_first(raw, ("max_value_usd", "max_declared_value_usd", "declared_value_max_usd",
                                "max_value", "value_cap_usd")))
    name = str(_first(raw, ("name", "tier", "service", "label", "id")) or "Standard").strip()
    turnaround = _first(raw, ("turnaround", "turnaround_days", "turnaround_business_days"))
    return FeeTier(name=name, fee_usd=round(fee, 2), max_value_usd=cap, turnaround=str(turnaround) if turnaround else None)


def _grader_tiers(raw: Any) -> tuple[FeeTier, ...]:
    if isinstance(raw, dict):
        items = _first(raw, ("tiers", "services", "levels"))
        if items is None:
            items = [raw] if _tier(raw) else [
                {**value, "name": value.get("name") or key} for key, value in raw.items() if isinstance(value, dict)
            ]
    else:
        items = raw
    tiers = [tier for tier in (_tier(item) for item in items or []) if tier is not None]
    return tuple(sorted(tiers, key=lambda tier: (tier.max_value_usd is None, tier.max_value_usd or 0, tier.fee_usd)))


def parse_table(raw: Any, *, placeholder: bool = False) -> FeeTable | None:
    if not isinstance(raw, dict):
        return None
    graders_raw = raw.get("graders") if isinstance(raw.get("graders"), dict) else raw
    graders: dict[str, tuple[FeeTier, ...]] = {}
    return_shipping: dict[str, tuple[tuple[float | None, float], ...]] = {}
    for key, value in graders_raw.items():
        code = str(key).strip().upper()
        if code in GRADERS or code in ("SGC", "TAG", "ACE"):
            tiers = _grader_tiers(value)
            if tiers:
                graders[code] = tiers
            rates = _return_rates(value.get("return_shipping") if isinstance(value, dict) else None)
            if rates:
                return_shipping[code] = rates
    if not graders:
        return None
    shipping_raw = raw.get("shipping")
    shipping = _number(_first(raw, ("shipping_usd", "shipping_round_trip_usd", "round_trip_shipping_usd")))
    if shipping is None and isinstance(shipping_raw, dict):
        shipping = _number(_first(shipping_raw, ("round_trip_usd", "usd", "default_usd", "amount_usd")))
    elif shipping is None:
        shipping = _number(shipping_raw)
    as_of = _first(raw, ("as_of", "asOf", "updated_at", "last_verified"))
    return FeeTable(
        as_of=str(as_of)[:10] if as_of else None,
        placeholder=placeholder or bool(raw.get("placeholder")),
        shipping_usd=round(shipping if shipping is not None and shipping >= 0 else DEFAULT_SHIPPING_USD, 2),
        graders=graders,
        return_shipping=return_shipping,
    )


_INSURED_KEY = re.compile(r"up_to_(\d+)_insured_usd$")


def _return_rates(raw: Any) -> tuple[tuple[float | None, float], ...]:
    """{"domestic_cards_up_to_2000_insured_usd": {"1-4": 19.99}, ...} or {"usd": 20} -> ((cap, fee), ...)."""
    if not isinstance(raw, dict):
        return ()
    rates: list[tuple[float | None, float]] = []
    for key, value in raw.items():
        match = _INSURED_KEY.search(str(key))
        if match and isinstance(value, dict):
            fee = _number(value.get("1-4") if value.get("1-4") is not None else value.get("1"))
            if fee is not None:
                rates.append((float(match.group(1)), round(fee, 2)))
    if not rates:
        flat = _number(_first(raw, ("usd", "flat_usd", "fee_usd", "price_usd")))
        if flat is not None:
            rates.append((None, round(flat, 2)))
    return tuple(sorted(rates, key=lambda rate: (rate[0] is None, rate[0] or 0)))


PLACEHOLDER = parse_table(PLACEHOLDER_TABLE, placeholder=True)
_cache: tuple[str, float, FeeTable] | None = None


def fees_path() -> Path:
    override = os.environ.get(FEES_PATH_ENV, "").strip()
    return Path(override) if override else FEES_PATH


def load_fee_table() -> FeeTable:
    """The JSON table (re-read when its mtime changes), else the placeholder."""
    global _cache
    path = fees_path()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return PLACEHOLDER  # type: ignore[return-value]
    if _cache is not None and _cache[0] == str(path) and _cache[1] == mtime:
        return _cache[2]
    try:
        table = parse_table(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError) as error:
        logger.warning("grading fees unreadable (%s): %s", path, error)
        table = None
    if table is None:
        logger.warning("grading fees file %s has no usable grader tiers; using placeholder", path)
        return PLACEHOLDER  # type: ignore[return-value]
    _cache = (str(path), mtime, table)
    return table
