from __future__ import annotations

import os
from urllib.parse import urlencode

from pricing_provider import ProviderMetadata, PricingProvider, PsaPricingResult, RawPricingResult


PRICECHARTING_PROVIDER = "pricecharting"
PRICECHARTING_BASE_URL = "https://www.pricecharting.com/api"


def pricecharting_credentials() -> str | None:
    api_key = os.environ.get("PRICECHARTING_API_KEY", "").strip()
    return api_key or None


def pricecharting_request_url(path: str, **params: str) -> str:
    base_url = os.environ.get("PRICECHARTING_BASE_URL", PRICECHARTING_BASE_URL).rstrip("/")
    query_string = urlencode(params)
    return f"{base_url}{path}?{query_string}" if query_string else f"{base_url}{path}"


class PriceChartingProvider(PricingProvider):
    def get_metadata(self) -> ProviderMetadata:
        return ProviderMetadata(
            provider_id=PRICECHARTING_PROVIDER,
            provider_label="PriceCharting",
            is_ready=self.is_ready(),
            requires_credentials=True,
            supports_raw_pricing=True,
            supports_psa_pricing=True,
        )

    def is_ready(self) -> bool:
        return pricecharting_credentials() is not None

    def refresh_raw_pricing(self, connection, card_id: str) -> RawPricingResult:
        return RawPricingResult(
            success=False,
            provider_id=PRICECHARTING_PROVIDER,
            card_id=card_id,
            error="PriceCharting is preserved only as a thin provider shell in the raw-only backend build.",
        )

    def refresh_psa_pricing(self, connection, card_id: str, grade: str) -> PsaPricingResult:
        return PsaPricingResult(
            success=False,
            provider_id=PRICECHARTING_PROVIDER,
            card_id=card_id,
            grade=grade,
            error="Graded pricing is intentionally removed from the raw-only backend build.",
        )
