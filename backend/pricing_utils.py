"""
Shared pricing utilities for normalizing price data from various sources.

This module provides reusable functions for parsing and normalizing pricing data
from different APIs (Pokemon TCG API, PriceCharting, etc.) into a consistent format.
"""

from __future__ import annotations

from typing import Any


def cleaned_price(value: Any) -> float | None:
    """
    Clean and validate a price value.

    Args:
        value: Raw price value (could be string, float, int, or None)

    Returns:
        Float price if valid and positive, None otherwise
    """
    if value is None:
        return None
    try:
        price = float(value)
        return price if price > 0 else None
    except (ValueError, TypeError):
        return None


def cleaned_high_price(value: Any, reference: float | None) -> float | None:
    """
    Clean high price with sanity check against reference price.

    Args:
        value: Raw high price value
        reference: Reference price (market or mid) for sanity checking

    Returns:
        Float price if valid, None otherwise
    """
    high = cleaned_price(value)
    if high is None:
        return None
    if reference is not None and high < reference:
        return None
    return high


def preferred_tcgplayer_price_entry(
    prices: dict[str, Any]
) -> tuple[str, dict[str, Any]] | None:
    """
    Select the preferred price variant from tcgplayer prices.

    Prefers variants in this order: normal, holofoil, reverseHolofoil, etc.

    Args:
        prices: tcgplayer prices dict with variant keys

    Returns:
        Tuple of (variant_name, price_dict) if found, None otherwise
    """
    if not prices:
        return None

    ordered_variants = [
        "normal",
        "holofoil",
        "reverseHolofoil",
        "unlimitedNormal",
        "unlimitedHolofoil",
        "1stEditionNormal",
        "1stEditionHolofoil",
    ]

    for variant in ordered_variants:
        if variant in prices and prices[variant]:
            return variant, prices[variant]

    # Fallback: return any available variant
    for variant, payload in prices.items():
        if payload:
            return variant, payload

    return None


def normalize_tcgplayer_prices(
    tcgplayer: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """
    Normalize tcgplayer price block to our schema.

    Args:
        tcgplayer: Raw tcgplayer data from Pokemon TCG API

    Returns:
        Normalized price dict with keys: source, currencyCode, variant, low,
        market, mid, high, directLow, trend, updatedAt, sourceURL
        Returns None if no valid prices found.
    """
    if not tcgplayer:
        return None

    tcgplayer_prices = tcgplayer.get("prices") or {}
    preferred_tcgplayer = preferred_tcgplayer_price_entry(tcgplayer_prices)

    if preferred_tcgplayer is None:
        return None

    variant, payload = preferred_tcgplayer
    market_price = cleaned_price(payload.get("market"))
    mid_price = cleaned_price(payload.get("mid"))
    low_price = cleaned_price(payload.get("low"))
    direct_low_price = cleaned_price(payload.get("directLow"))
    reference = market_price or mid_price or low_price
    high_price = cleaned_high_price(payload.get("high"), reference)

    summary = {
        "source": "tcgplayer",
        "currencyCode": "USD",
        "variant": variant,
        "low": low_price,
        "market": market_price,
        "mid": mid_price,
        "high": high_price,
        "directLow": direct_low_price,
        "trend": market_price,
        "updatedAt": tcgplayer.get("updatedAt"),
        "sourceURL": tcgplayer.get("url"),
    }

    # Only return if at least one price field is present
    if any(
        summary[key] is not None
        for key in ("low", "market", "mid", "high", "directLow", "trend")
    ):
        return summary

    return None


def normalize_cardmarket_prices(
    cardmarket: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """
    Normalize cardmarket price block to our schema.

    Args:
        cardmarket: Raw cardmarket data from Pokemon TCG API

    Returns:
        Normalized price dict with keys: source, currencyCode, variant, low,
        market, mid, high, directLow, trend, updatedAt, sourceURL
        Returns None if no valid prices found.
    """
    if not cardmarket:
        return None

    cardmarket_prices = cardmarket.get("prices") or {}
    if not cardmarket_prices:
        return None

    trend_price = cleaned_price(cardmarket_prices.get("trendPrice"))
    mid_price = (
        cleaned_price(cardmarket_prices.get("averageSellPrice"))
        or cleaned_price(cardmarket_prices.get("avg30"))
        or cleaned_price(cardmarket_prices.get("avg7"))
    )
    low_price = cleaned_price(
        cardmarket_prices.get("lowPriceExPlus")
    ) or cleaned_price(cardmarket_prices.get("lowPrice"))
    high_price = cleaned_price(cardmarket_prices.get("suggestedPrice"))

    summary = {
        "source": "cardmarket",
        "currencyCode": "EUR",
        "variant": "normal",
        "low": low_price,
        "market": mid_price,
        "mid": mid_price,
        "high": high_price,
        "directLow": None,
        "trend": trend_price,
        "updatedAt": cardmarket.get("updatedAt"),
        "sourceURL": cardmarket.get("url"),
    }

    # Only return if at least one price field is present
    if any(
        summary[key] is not None
        for key in ("low", "market", "mid", "high", "trend")
    ):
        return summary

    return None


def normalize_price_summary(
    tcgplayer: dict[str, Any] | None, cardmarket: dict[str, Any] | None
) -> dict[str, Any] | None:
    """
    Normalize price summary from Pokemon TCG API response.

    Prefers tcgplayer prices, falls back to cardmarket if tcgplayer unavailable.

    Args:
        tcgplayer: Raw tcgplayer data from Pokemon TCG API
        cardmarket: Raw cardmarket data from Pokemon TCG API

    Returns:
        Normalized price summary dict, or None if no prices available
    """
    # Prefer tcgplayer
    tcgplayer_summary = normalize_tcgplayer_prices(tcgplayer)
    if tcgplayer_summary is not None:
        return tcgplayer_summary

    # Fallback to cardmarket
    cardmarket_summary = normalize_cardmarket_prices(cardmarket)
    if cardmarket_summary is not None:
        return cardmarket_summary

    return None
