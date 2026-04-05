"""
PriceCharting pricing provider adapter.

This module implements the pricing provider contract for PriceCharting.
It fetches raw and PSA graded pricing from the PriceCharting API and
persists it to the database.
"""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import quote_plus, urlencode
from urllib.request import Request, urlopen

from catalog_tools import (
    bucket_key_for_card,
    card_row_for_pricing_provider,
    normalize_grade,
    upsert_card_price_summary,
    upsert_external_price_mapping,
    upsert_slab_price_snapshot,
)
from pricing_provider import (
    ProviderMetadata,
    PricingProvider,
    PsaPricingResult,
    RawPricingResult,
)


PRICECHARTING_PROVIDER = "pricecharting"
PRICECHARTING_SOURCE = "pricecharting"
PRICECHARTING_BASE_URL = "https://www.pricecharting.com/api"


def pricecharting_credentials() -> str | None:
    """
    Get PriceCharting API key from environment.

    Returns:
        API key if available, None otherwise
    """
    api_key = os.environ.get("PRICECHARTING_API_KEY", "").strip()
    if not api_key:
        return None
    return api_key


def pricecharting_request_url(path: str, **params: str) -> str:
    """Build a PriceCharting API request URL."""
    base_url = os.environ.get(
        "PRICECHARTING_BASE_URL", PRICECHARTING_BASE_URL
    ).rstrip("/")
    query_string = urlencode(params)
    return f"{base_url}{path}?{query_string}" if query_string else f"{base_url}{path}"


def fetch_json(url: str, api_key: str, timeout: int = 12) -> dict[str, Any]:
    """Fetch JSON from PriceCharting API."""
    request = Request(
        url,
        headers={
            "User-Agent": "Spotlight/1.0",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_pricecharting_product(
    card_id: str, api_key: str
) -> dict[str, Any]:
    """
    Fetch product pricing from PriceCharting.

    Args:
        card_id: Internal card ID
        api_key: PriceCharting API key

    Returns:
        PriceCharting API response payload

    Note: This uses a simplified endpoint structure.
    In production, you may need to map card_id to PriceCharting's product ID format.
    """
    # PriceCharting API endpoint structure: /product/<product-id>
    # The actual endpoint may require mapping internal card ID to PriceCharting format
    url = pricecharting_request_url(
        f"/product/{quote_plus(card_id)}",
        t="api_key",
        v=api_key,
    )
    return fetch_json(url, api_key)


def resolve_pricecharting_raw_price(
    product_payload: dict[str, Any],
) -> dict[str, Any] | None:
    """
    Extract raw card pricing from PriceCharting product response.

    Args:
        product_payload: PriceCharting API response

    Returns:
        Price dict if available, None otherwise
    """
    # PriceCharting typically provides prices in different condition states
    # Structure: {"price-ungraded": 10.00, "price-loose": 8.00, ...}
    # For raw cards, we prefer ungraded/loose pricing

    # Try to extract pricing fields
    raw_price = product_payload.get("price-ungraded") or product_payload.get(
        "price-loose"
    )
    if raw_price is None:
        return None

    # Build normalized price structure
    return {
        "low": raw_price,  # PriceCharting may provide single price or range
        "market": raw_price,
        "high": raw_price,
        "currency": "USD",
        "condition": "ungraded",
    }


def resolve_pricecharting_psa_price(
    product_payload: dict[str, Any], grade: str
) -> dict[str, Any] | None:
    """
    Extract PSA graded pricing from PriceCharting product response.

    Args:
        product_payload: PriceCharting API response
        grade: PSA grade (e.g., "10", "9", "8")

    Returns:
        Price dict if available, None otherwise
    """
    normalized_grade = normalize_grade(grade)
    if normalized_grade is None:
        return None

    # PriceCharting graded prices typically use format: "price-graded-10"
    grade_field = f"price-graded-{normalized_grade}"
    graded_price = product_payload.get(grade_field)

    if graded_price is None:
        return None

    return {
        "low": graded_price,
        "market": graded_price,
        "high": graded_price,
        "currency": "USD",
        "grade": normalized_grade,
    }


def refresh_pricecharting_raw_snapshot(
    connection, card_id: str, api_key: str
) -> dict[str, Any] | None:
    """
    Refresh raw card pricing from PriceCharting.

    Args:
        connection: Database connection
        card_id: Card ID to refresh
        api_key: PriceCharting API key

    Returns:
        PriceCharting payload if successful, None otherwise
    """
    card_row = card_row_for_pricing_provider(connection, card_id)
    if card_row is None:
        return None

    payload = fetch_pricecharting_product(card_id, api_key)
    resolved = resolve_pricecharting_raw_price(payload)
    if resolved is None:
        return None

    source_url = pricecharting_request_url(
        f"/product/{quote_plus(card_id)}",
        t="api_key",
        v=api_key,
    )

    upsert_external_price_mapping(
        connection,
        card_id=card_id,
        provider=PRICECHARTING_PROVIDER,
        external_id=str(payload.get("id") or card_id),
        title=str(payload.get("product-name") or card_row["name"]),
        url=source_url,
        payload=payload,
    )

    upsert_card_price_summary(
        connection,
        card_id=card_id,
        source=PRICECHARTING_SOURCE,
        currency_code=str(resolved.get("currency") or "USD"),
        variant="normal",
        low_price=resolved.get("low"),
        market_price=resolved.get("market"),
        mid_price=resolved.get("market"),  # Use market as mid if no separate mid
        high_price=resolved.get("high"),
        direct_low_price=None,
        trend_price=None,
        source_updated_at=None,
        source_url=source_url,
        payload={
            "provider": PRICECHARTING_PROVIDER,
            "condition": resolved.get("condition"),
            "cardName": payload.get("product-name"),
        },
    )
    return payload


def refresh_pricecharting_psa_snapshot(
    connection, card_id: str, grade: str, api_key: str
) -> dict[str, Any] | None:
    """
    Refresh PSA graded pricing from PriceCharting.

    Args:
        connection: Database connection
        card_id: Card ID to refresh
        grade: PSA grade
        api_key: PriceCharting API key

    Returns:
        PriceCharting payload if successful, None otherwise
    """
    normalized_grade = normalize_grade(grade)
    if normalized_grade is None:
        return None

    card_row = card_row_for_pricing_provider(connection, card_id)
    if card_row is None:
        return None

    payload = fetch_pricecharting_product(card_id, api_key)
    resolved = resolve_pricecharting_psa_price(payload, normalized_grade)
    if resolved is None:
        return None

    source_url = pricecharting_request_url(
        f"/product/{quote_plus(card_id)}",
        t="api_key",
        v=api_key,
    )
    bucket_key = bucket_key_for_card(connection, card_id)

    upsert_external_price_mapping(
        connection,
        card_id=card_id,
        provider=PRICECHARTING_PROVIDER,
        external_id=str(payload.get("id") or card_id),
        title=str(payload.get("product-name") or card_row["name"]),
        url=source_url,
        payload=payload,
    )

    summary = f"PriceCharting exact PSA {normalized_grade} market snapshot."
    upsert_slab_price_snapshot(
        connection,
        card_id=card_id,
        grader="PSA",
        grade=normalized_grade,
        pricing_tier="pricecharting_exact_grade",
        currency_code=str(resolved.get("currency") or "USD"),
        low_price=resolved.get("low"),
        market_price=resolved.get("market"),
        mid_price=resolved.get("market"),
        high_price=resolved.get("high"),
        last_sale_price=None,
        last_sale_date=None,
        comp_count=0,
        recent_comp_count=0,
        confidence_level=4,
        confidence_label="High",
        bucket_key=bucket_key,
        source_url=source_url,
        source=PRICECHARTING_SOURCE,
        summary=summary,
        payload={
            "provider": PRICECHARTING_PROVIDER,
            "grade": normalized_grade,
            "cardName": payload.get("product-name"),
        },
    )
    return payload


class PriceChartingProvider(PricingProvider):
    """
    PriceCharting pricing provider implementation.

    Specialized for PSA graded pricing only.
    Use Pokemon TCG API for raw card pricing.
    """

    def get_metadata(self) -> ProviderMetadata:
        """Return provider metadata."""
        return ProviderMetadata(
            provider_id="pricecharting",
            provider_label="PriceCharting",
            is_ready=self.is_ready(),
            requires_credentials=True,
            supports_raw_pricing=False,  # Changed: PSA-only provider
            supports_psa_pricing=True,
        )

    def is_ready(self) -> bool:
        """Check if PriceCharting credentials are configured."""
        return pricecharting_credentials() is not None

    def refresh_raw_pricing(
        self, connection, card_id: str
    ) -> RawPricingResult:
        """
        PriceCharting is configured for PSA pricing only.

        This method always returns failure with an explanatory message.
        Use Pokemon TCG API for raw card pricing.
        """
        return RawPricingResult(
            success=False,
            provider_id="pricecharting",
            card_id=card_id,
            error="PriceCharting is configured for PSA pricing only. Use Pokemon TCG API for raw cards.",
        )

    def refresh_psa_pricing(
        self, connection, card_id: str, grade: str
    ) -> PsaPricingResult:
        """Refresh PSA graded pricing from PriceCharting."""
        api_key = pricecharting_credentials()
        if api_key is None:
            return PsaPricingResult(
                success=False,
                provider_id="pricecharting",
                card_id=card_id,
                grade=grade,
                error="PriceCharting API key not configured",
            )

        try:
            payload = refresh_pricecharting_psa_snapshot(
                connection, card_id, grade, api_key
            )
            if payload is None:
                return PsaPricingResult(
                    success=False,
                    provider_id="pricecharting",
                    card_id=card_id,
                    grade=grade,
                    error=f"No PSA {grade} pricing available from PriceCharting",
                )

            return PsaPricingResult(
                success=True,
                provider_id="pricecharting",
                card_id=card_id,
                grade=grade,
                payload=payload,
            )
        except Exception as error:
            return PsaPricingResult(
                success=False,
                provider_id="pricecharting",
                card_id=card_id,
                grade=grade,
                error=str(error),
            )
