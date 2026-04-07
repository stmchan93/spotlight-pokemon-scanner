"""
Pokemon TCG API pricing provider adapter.

This module implements the pricing provider contract for Pokemon TCG API.
It fetches raw card pricing from the official Pokemon TCG API and normalizes
tcgplayer/cardmarket price blocks into our pricing schema.

This provider supports raw card pricing only (not PSA graded pricing).
"""

from __future__ import annotations

import os
from typing import Any

from catalog_tools import (
    card_row_for_pricing_provider,
    upsert_card_price_summary,
    upsert_external_price_mapping,
)
from import_pokemontcg_catalog import fetch_card_by_id
from pricing_provider import (
    ProviderMetadata,
    PricingProvider,
    PsaPricingResult,
    RawPricingResult,
)
from pricing_utils import normalize_price_summary


POKEMONTCG_API_PROVIDER = "pokemontcg_api"
POKEMONTCG_API_SOURCE = "pokemontcg_api"


def pokemontcg_api_credentials() -> str | None:
    """
    Get Pokemon TCG API key from environment.

    Returns:
        API key if available, None otherwise
    """
    api_key = os.environ.get("POKEMONTCG_API_KEY", "").strip()
    if not api_key:
        return None
    return api_key


def refresh_pokemontcg_raw_snapshot(
    connection, card_id: str, api_key: str
) -> dict[str, Any] | None:
    """
    Refresh raw card pricing from Pokemon TCG API.

    Args:
        connection: Database connection
        card_id: Card ID to refresh
        api_key: Pokemon TCG API key

    Returns:
        Pokemon TCG API payload if successful, None otherwise
    """
    card_row = card_row_for_pricing_provider(connection, card_id)
    if card_row is None:
        return None

    # Fetch card data from Pokemon TCG API
    try:
        payload = fetch_card_by_id(card_id, api_key)
    except Exception:
        return None

    # Extract tcgplayer and cardmarket blocks
    tcgplayer = payload.get("tcgplayer")
    cardmarket = payload.get("cardmarket")

    # Normalize using shared utilities
    price_summary = normalize_price_summary(tcgplayer, cardmarket)
    if price_summary is None:
        return None

    # Build source URL
    source_url = f"https://pokemontcg.io/card/{card_id}"

    # Store external price mapping
    upsert_external_price_mapping(
        connection,
        card_id=card_id,
        provider=POKEMONTCG_API_PROVIDER,
        external_id=card_id,
        title=str(payload.get("name") or card_row["name"]),
        url=source_url,
        payload=payload,
    )

    # Persist price summary
    upsert_card_price_summary(
        connection,
        card_id=card_id,
        source=price_summary["source"],  # "tcgplayer" or "cardmarket"
        currency_code=price_summary["currencyCode"],
        variant=price_summary.get("variant"),
        low_price=price_summary.get("low"),
        market_price=price_summary.get("market"),
        mid_price=price_summary.get("mid"),
        high_price=price_summary.get("high"),
        direct_low_price=price_summary.get("directLow"),
        trend_price=price_summary.get("trend"),
        source_updated_at=price_summary.get("updatedAt"),
        source_url=price_summary.get("sourceURL") or source_url,
        payload={
            "provider": POKEMONTCG_API_PROVIDER,
            "priceSource": price_summary["source"],
            "variant": price_summary.get("variant"),
            "cardName": payload.get("name"),
            "setName": (payload.get("set") or {}).get("name"),
        },
    )

    return payload


class PokemonTcgApiProvider(PricingProvider):
    """Pokemon TCG API pricing provider implementation."""

    def get_metadata(self) -> ProviderMetadata:
        """Return provider metadata."""
        return ProviderMetadata(
            provider_id="pokemontcg_api",
            provider_label="Pokemon TCG API",
            is_ready=self.is_ready(),
            requires_credentials=True,
            supports_raw_pricing=True,
            supports_psa_pricing=False,  # Does not support PSA pricing
        )

    def is_ready(self) -> bool:
        """Check if Pokemon TCG API key is configured."""
        return pokemontcg_api_credentials() is not None

    def refresh_raw_pricing(
        self, connection, card_id: str
    ) -> RawPricingResult:
        """Refresh raw card pricing from Pokemon TCG API."""
        api_key = pokemontcg_api_credentials()
        if api_key is None:
            return RawPricingResult(
                success=False,
                provider_id="pokemontcg_api",
                card_id=card_id,
                error="Pokemon TCG API key not configured",
            )

        try:
            payload = refresh_pokemontcg_raw_snapshot(
                connection, card_id, api_key
            )
            if payload is None:
                return RawPricingResult(
                    success=False,
                    provider_id="pokemontcg_api",
                    card_id=card_id,
                    error="No raw pricing available from Pokemon TCG API",
                )

            return RawPricingResult(
                success=True,
                provider_id="pokemontcg_api",
                card_id=card_id,
                payload=payload,
            )
        except Exception as error:
            return RawPricingResult(
                success=False,
                provider_id="pokemontcg_api",
                card_id=card_id,
                error=str(error),
            )

    def refresh_psa_pricing(
        self, connection, card_id: str, grade: str
    ) -> PsaPricingResult:
        """
        Pokemon TCG API does not support PSA graded pricing.

        This method always returns failure with an explanatory message.
        """
        return PsaPricingResult(
            success=False,
            provider_id="pokemontcg_api",
            card_id=card_id,
            grade=grade,
            error="Pokemon TCG API does not support PSA graded pricing. Use Scrydex for PSA pricing.",
        )
