from __future__ import annotations

import os
from typing import Any

from catalog_tools import RAW_PRICING_MODE, card_by_id, upsert_price_snapshot
from import_pokemontcg_catalog import fetch_card_by_id
from pricing_provider import ProviderMetadata, PricingProvider, PsaPricingResult, RawPricingResult
from pricing_utils import normalize_price_summary


POKEMONTCG_API_PROVIDER = "pokemontcg_api"


def pokemontcg_api_credentials() -> str | None:
    api_key = os.environ.get("POKEMONTCG_API_KEY", "").strip()
    return api_key or None


def refresh_pokemontcg_raw_snapshot(connection, card_id: str, api_key: str) -> dict[str, Any] | None:
    if card_by_id(connection, card_id) is None:
        return None

    try:
        payload = fetch_card_by_id(card_id, api_key)
    except Exception:
        return None

    tcgplayer = payload.get("tcgplayer")
    cardmarket = payload.get("cardmarket")
    price_summary = normalize_price_summary(tcgplayer, cardmarket)
    if price_summary is None:
        return None

    source_url = price_summary.get("sourceURL") or f"https://pokemontcg.io/card/{card_id}"
    upsert_price_snapshot(
        connection,
        card_id=card_id,
        pricing_mode=RAW_PRICING_MODE,
        provider=str(price_summary["source"]),
        currency_code=str(price_summary["currencyCode"]),
        variant=price_summary.get("variant"),
        low_price=price_summary.get("low"),
        market_price=price_summary.get("market"),
        mid_price=price_summary.get("mid"),
        high_price=price_summary.get("high"),
        direct_low_price=price_summary.get("directLow"),
        trend_price=price_summary.get("trend"),
        source_updated_at=price_summary.get("updatedAt"),
        source_url=source_url,
        payload={
            "provider": POKEMONTCG_API_PROVIDER,
            "priceSource": price_summary["source"],
            "variant": price_summary.get("variant"),
            "cardName": payload.get("name"),
            "setName": (payload.get("set") or {}).get("name"),
        },
    )
    connection.commit()
    return payload


class PokemonTcgApiProvider(PricingProvider):
    def get_metadata(self) -> ProviderMetadata:
        return ProviderMetadata(
            provider_id=POKEMONTCG_API_PROVIDER,
            provider_label="Pokemon TCG API",
            is_ready=self.is_ready(),
            requires_credentials=True,
            supports_raw_pricing=True,
            supports_psa_pricing=False,
        )

    def is_ready(self) -> bool:
        return pokemontcg_api_credentials() is not None

    def refresh_raw_pricing(self, connection, card_id: str) -> RawPricingResult:
        api_key = pokemontcg_api_credentials()
        if api_key is None:
            return RawPricingResult(
                success=False,
                provider_id=POKEMONTCG_API_PROVIDER,
                card_id=card_id,
                error="Pokemon TCG API key not configured",
            )

        payload = refresh_pokemontcg_raw_snapshot(connection, card_id, api_key)
        if payload is None:
            return RawPricingResult(
                success=False,
                provider_id=POKEMONTCG_API_PROVIDER,
                card_id=card_id,
                error="No raw pricing available from Pokemon TCG API",
            )

        return RawPricingResult(
            success=True,
            provider_id=POKEMONTCG_API_PROVIDER,
            card_id=card_id,
            payload=payload,
        )

    def refresh_psa_pricing(self, connection, card_id: str, grade: str) -> PsaPricingResult:
        return PsaPricingResult(
            success=False,
            provider_id=POKEMONTCG_API_PROVIDER,
            card_id=card_id,
            grade=grade,
            error="Pokemon TCG API does not support graded pricing in the raw-only backend build.",
        )
