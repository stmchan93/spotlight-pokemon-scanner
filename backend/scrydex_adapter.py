from __future__ import annotations

import os
from urllib.parse import urlencode

from pricing_provider import ProviderMetadata, PricingProvider, PsaPricingResult, RawPricingResult


SCRYDEX_PROVIDER = "scrydex"
SCRYDEX_BASE_URL = "https://api.scrydex.com"


def scrydex_credentials() -> tuple[str, str] | None:
    api_key = os.environ.get("SCRYDEX_API_KEY", "").strip()
    team_id = os.environ.get("SCRYDEX_TEAM_ID", "").strip()
    if not api_key or not team_id:
        return None
    return api_key, team_id


def scrydex_request_url(path: str, **params: str) -> str:
    base_url = os.environ.get("SCRYDEX_BASE_URL", SCRYDEX_BASE_URL).rstrip("/")
    query_string = urlencode(params)
    return f"{base_url}{path}?{query_string}" if query_string else f"{base_url}{path}"


def map_scrydex_catalog_card(payload: dict[str, object]) -> dict[str, object]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise ValueError("Scrydex payload is missing a top-level data object")

    expansion = data.get("expansion") if isinstance(data.get("expansion"), dict) else {}
    translation = data.get("translation") if isinstance(data.get("translation"), dict) else {}
    translation_en = translation.get("en") if isinstance(translation.get("en"), dict) else {}
    images = data.get("images") if isinstance(data.get("images"), list) else []
    front_image = next((image for image in images if isinstance(image, dict) and image.get("type") == "front"), {}) or {}

    return {
        "id": str(data.get("id") or ""),
        "name": str(translation_en.get("name") or data.get("name") or ""),
        "set_name": str(expansion.get("name") or ""),
        "number": str(data.get("printed_number") or data.get("number") or ""),
        "rarity": str(translation_en.get("rarity") or data.get("rarity") or "Unknown"),
        "variant": "Raw",
        "language": str(data.get("language") or expansion.get("language") or "Unknown"),
        "reference_image_path": None,
        "reference_image_url": front_image.get("large"),
        "reference_image_small_url": front_image.get("small"),
        "source": SCRYDEX_PROVIDER,
        "source_record_id": str(data.get("id") or ""),
        "set_id": expansion.get("id"),
        "set_series": expansion.get("series"),
        "set_ptcgo_code": None,
        "set_release_date": expansion.get("release_date"),
        "supertype": str(translation_en.get("supertype") or data.get("supertype") or ""),
        "subtypes": list(translation_en.get("subtypes") or data.get("subtypes") or []),
        "types": list(translation_en.get("types") or data.get("types") or []),
        "artist": data.get("artist"),
        "regulation_mark": None,
        "national_pokedex_numbers": [],
        "tcgplayer": {},
        "cardmarket": {},
        "source_payload": data,
    }


class ScrydexProvider(PricingProvider):
    def get_metadata(self) -> ProviderMetadata:
        return ProviderMetadata(
            provider_id=SCRYDEX_PROVIDER,
            provider_label="Scrydex",
            is_ready=self.is_ready(),
            requires_credentials=True,
            supports_raw_pricing=False,
            supports_psa_pricing=True,
        )

    def is_ready(self) -> bool:
        return scrydex_credentials() is not None

    def refresh_raw_pricing(self, connection, card_id: str) -> RawPricingResult:
        return RawPricingResult(
            success=False,
            provider_id=SCRYDEX_PROVIDER,
            card_id=card_id,
            error="Scrydex is preserved only as a thin provider shell in the raw-only backend build.",
        )

    def refresh_psa_pricing(self, connection, card_id: str, grade: str) -> PsaPricingResult:
        return PsaPricingResult(
            success=False,
            provider_id=SCRYDEX_PROVIDER,
            card_id=card_id,
            grade=grade,
            error="Slab pricing is intentionally removed from the raw-only backend build.",
        )
