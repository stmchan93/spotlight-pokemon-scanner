from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import urlencode
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


SCRYDEX_PROVIDER = "scrydex"
SCRYDEX_SOURCE = "scrydex"
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


def fetch_json(url: str, api_key: str, team_id: str, timeout: int = 12) -> dict[str, Any]:
    request = Request(
        url,
        headers={
            "User-Agent": "Spotlight/1.0",
            "X-Api-Key": api_key,
            "X-Team-ID": team_id,
        },
    )
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_scrydex_card(card_id: str, api_key: str, team_id: str) -> dict[str, Any]:
    return fetch_json(
        scrydex_request_url(
            f"/pokemon/v1/en/cards/{card_id}",
            include="prices",
            casing="snake",
        ),
        api_key,
        team_id,
    )


def score_variant_name(name: str) -> tuple[int, str]:
    normalized = name.lower()
    preference_order = [
        "normal",
        "unlimitednormal",
        "holofoil",
        "unlimitedholofoil",
        "reverseholofoil",
        "illustrationrare",
        "specialillustrationrare",
    ]
    for index, preferred in enumerate(preference_order):
        if preferred in normalized:
            return index, normalized
    return len(preference_order) + 1, normalized


def score_raw_condition(value: Any) -> tuple[int, str]:
    condition = str(value or "").strip().lower().replace(" ", "").replace("-", "")
    preference_order = [
        "",
        "nearmint",
        "nm",
        "lightplayed",
        "lp",
        "moderatelyplayed",
        "mp",
        "heavilyplayed",
        "hp",
        "damaged",
    ]
    for index, preferred in enumerate(preference_order):
        if condition == preferred:
            return index, condition
    return len(preference_order) + 1, condition


def resolve_scrydex_raw_price(card_payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    matches: list[tuple[tuple[int, str], tuple[int, str], dict[str, Any], dict[str, Any]]] = []
    for variant in card_payload.get("variants", []):
        if not isinstance(variant, dict):
            continue
        variant_name = str(variant.get("name") or "normal")
        for price in variant.get("prices", []):
            if not isinstance(price, dict):
                continue
            if str(price.get("type") or "").lower() != "raw":
                continue
            if price.get("is_signed") or price.get("is_error") or price.get("is_perfect"):
                continue
            if not any(price.get(field) is not None for field in ("low", "market", "mid", "high")):
                continue
            matches.append((score_variant_name(variant_name), score_raw_condition(price.get("condition")), variant, price))

    if not matches:
        return None

    matches.sort(key=lambda item: (item[0], item[1]))
    _, _, variant, price = matches[0]
    return variant, price


def resolve_scrydex_psa_price(card_payload: dict[str, Any], grade: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    normalized_grade = normalize_grade(grade)
    if normalized_grade is None:
        return None

    matches: list[tuple[tuple[int, str], dict[str, Any], dict[str, Any]]] = []
    for variant in card_payload.get("variants", []):
        if not isinstance(variant, dict):
            continue
        variant_name = str(variant.get("name") or "normal")
        for price in variant.get("prices", []):
            if not isinstance(price, dict):
                continue
            if str(price.get("type") or "").lower() != "graded":
                continue
            if str(price.get("company") or "").upper() != "PSA":
                continue
            if normalize_grade(price.get("grade")) != normalized_grade:
                continue
            if price.get("is_signed") or price.get("is_error") or price.get("is_perfect"):
                continue
            matches.append((score_variant_name(variant_name), variant, price))

    if not matches:
        return None

    matches.sort(key=lambda item: item[0])
    _, variant, price = matches[0]
    return variant, price


def refresh_scrydex_raw_snapshot(
    connection,
    card_id: str,
    api_key: str,
    team_id: str,
) -> dict[str, Any] | None:
    card_row = card_row_for_pricing_provider(connection, card_id)
    if card_row is None:
        return None

    payload = fetch_scrydex_card(card_id, api_key, team_id)
    resolved = resolve_scrydex_raw_price(payload)
    if resolved is None:
        return None

    variant, price = resolved
    variant_name = str(variant.get("name") or "normal")
    source_url = scrydex_request_url(f"/pokemon/v1/en/cards/{card_id}", include="prices", casing="snake")

    upsert_external_price_mapping(
        connection,
        card_id=card_id,
        provider=SCRYDEX_PROVIDER,
        external_id=card_id,
        title=str(payload.get("name") or card_row["name"]),
        url=source_url,
        payload=payload,
    )

    trends = price.get("trends") if isinstance(price.get("trends"), dict) else {}
    trend_30 = trends.get("days_30") if isinstance(trends, dict) else None
    updated_at = None
    if isinstance(price.get("updated_at"), str):
        updated_at = price.get("updated_at")
    elif isinstance(payload.get("updated_at"), str):
        updated_at = payload.get("updated_at")

    upsert_card_price_summary(
        connection,
        card_id=card_id,
        source=SCRYDEX_SOURCE,
        currency_code=str(price.get("currency") or "USD"),
        variant=variant_name,
        low_price=price.get("low"),
        market_price=price.get("market"),
        mid_price=price.get("mid"),
        high_price=price.get("high"),
        direct_low_price=None,
        trend_price=trend_30,
        source_updated_at=updated_at,
        source_url=source_url,
        payload={
            "provider": SCRYDEX_PROVIDER,
            "variant": variant_name,
            "condition": price.get("condition"),
            "type": price.get("type"),
            "trend30": trend_30,
            "cardName": payload.get("name"),
            "expansionName": (payload.get("expansion") or {}).get("name"),
        },
    )
    return payload


def refresh_scrydex_psa_snapshot(
    connection,
    card_id: str,
    grade: str,
    api_key: str,
    team_id: str,
) -> dict[str, Any] | None:
    normalized_grade = normalize_grade(grade)
    if normalized_grade is None:
        return None

    card_row = card_row_for_pricing_provider(connection, card_id)
    if card_row is None:
        return None

    payload = fetch_scrydex_card(card_id, api_key, team_id)
    resolved = resolve_scrydex_psa_price(payload, normalized_grade)
    if resolved is None:
        return None

    variant, price = resolved
    variant_name = str(variant.get("name") or "normal")
    source_url = scrydex_request_url(f"/pokemon/v1/en/cards/{card_id}", include="prices", casing="snake")
    bucket_key = bucket_key_for_card(connection, card_id)

    upsert_external_price_mapping(
        connection,
        card_id=card_id,
        provider=SCRYDEX_PROVIDER,
        external_id=card_id,
        title=str(payload.get("name") or card_row["name"]),
        url=source_url,
        payload=payload,
    )

    trends = price.get("trends") if isinstance(price.get("trends"), dict) else {}
    trend_30 = trends.get("days_30") if isinstance(trends, dict) else None

    summary = f"Scrydex exact PSA {normalized_grade} market snapshot."
    upsert_slab_price_snapshot(
        connection,
        card_id=card_id,
        grader="PSA",
        grade=normalized_grade,
        pricing_tier="scrydex_exact_grade",
        currency_code=str(price.get("currency") or "USD"),
        low_price=price.get("low"),
        market_price=price.get("market"),
        mid_price=price.get("mid"),
        high_price=price.get("high"),
        last_sale_price=None,
        last_sale_date=None,
        comp_count=0,
        recent_comp_count=0,
        confidence_level=4,
        confidence_label="High",
        bucket_key=bucket_key,
        source_url=source_url,
        source=SCRYDEX_SOURCE,
        summary=summary,
        payload={
            "provider": SCRYDEX_PROVIDER,
            "variant": variant_name,
            "company": price.get("company"),
            "grade": price.get("grade"),
            "trend30": trend_30,
            "cardName": payload.get("name"),
            "expansionName": (payload.get("expansion") or {}).get("name"),
        },
    )
    return payload


class ScrydexProvider(PricingProvider):
    """Scrydex pricing provider implementation."""

    def get_metadata(self) -> ProviderMetadata:
        """Return provider metadata."""
        return ProviderMetadata(
            provider_id="scrydex",
            provider_label="Scrydex",
            is_ready=self.is_ready(),
            requires_credentials=True,
            supports_raw_pricing=True,
            supports_psa_pricing=True,
        )

    def is_ready(self) -> bool:
        """Check if Scrydex credentials are configured."""
        return scrydex_credentials() is not None

    def refresh_raw_pricing(
        self, connection, card_id: str
    ) -> RawPricingResult:
        """Refresh raw card pricing from Scrydex."""
        credentials = scrydex_credentials()
        if credentials is None:
            return RawPricingResult(
                success=False,
                provider_id="scrydex",
                card_id=card_id,
                error="Scrydex API key or team ID not configured",
            )

        api_key, team_id = credentials
        try:
            payload = refresh_scrydex_raw_snapshot(
                connection, card_id, api_key, team_id
            )
            if payload is None:
                return RawPricingResult(
                    success=False,
                    provider_id="scrydex",
                    card_id=card_id,
                    error="No raw pricing available from Scrydex",
                )

            return RawPricingResult(
                success=True,
                provider_id="scrydex",
                card_id=card_id,
                payload=payload,
            )
        except Exception as error:
            return RawPricingResult(
                success=False,
                provider_id="scrydex",
                card_id=card_id,
                error=str(error),
            )

    def refresh_psa_pricing(
        self, connection, card_id: str, grade: str
    ) -> PsaPricingResult:
        """Refresh PSA graded pricing from Scrydex."""
        credentials = scrydex_credentials()
        if credentials is None:
            return PsaPricingResult(
                success=False,
                provider_id="scrydex",
                card_id=card_id,
                grade=grade,
                error="Scrydex API key or team ID not configured",
            )

        api_key, team_id = credentials
        try:
            payload = refresh_scrydex_psa_snapshot(
                connection, card_id, grade, api_key, team_id
            )
            if payload is None:
                return PsaPricingResult(
                    success=False,
                    provider_id="scrydex",
                    card_id=card_id,
                    grade=grade,
                    error=f"No PSA {grade} pricing available from Scrydex",
                )

            return PsaPricingResult(
                success=True,
                provider_id="scrydex",
                card_id=card_id,
                grade=grade,
                payload=payload,
            )
        except Exception as error:
            return PsaPricingResult(
                success=False,
                provider_id="scrydex",
                card_id=card_id,
                grade=grade,
                error=str(error),
            )
