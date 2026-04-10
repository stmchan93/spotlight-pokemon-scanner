from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from catalog_tools import fx_rate_snapshot_for_pair, upsert_fx_rate_snapshot


ECB_FX_SOURCE = "ecb"
ECB_DATA_API_BASE_URL = "https://data-api.ecb.europa.eu/service/data/EXR"
ECB_USER_AGENT = "SpotlightScanner/0.1 (+https://local.spotlight.app)"
DEFAULT_REQUEST_TIMEOUT_SECONDS = 5


@dataclass(frozen=True)
class FxRateResult:
    base_currency: str
    quote_currency: str
    rate: Decimal
    source: str
    effective_at: str | None
    source_url: str
    payload: dict[str, Any]


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _ecb_request_url(*, currencies: list[str]) -> str:
    currency_clause = "+".join(sorted({currency.upper() for currency in currencies if currency.upper() != "EUR"}))
    query = urlencode({"lastNObservations": 1, "format": "jsondata"})
    return f"{ECB_DATA_API_BASE_URL}/D.{currency_clause}.EUR.SP00.A?{query}"


def _ecb_api_request(url: str, *, timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS) -> dict[str, Any]:
    request = Request(url)
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", ECB_USER_AGENT)
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _extract_ecb_reference_rates(payload: dict[str, Any]) -> tuple[dict[str, Decimal], str | None]:
    structure = payload.get("structure") or {}
    data_sets = payload.get("dataSets") or []
    if not isinstance(structure, dict) or not isinstance(data_sets, list) or not data_sets:
        raise ValueError("ECB FX payload is missing required sections")

    series_dimensions = (((structure.get("dimensions") or {}).get("series")) or [])
    observation_dimensions = (((structure.get("dimensions") or {}).get("observation")) or [])
    series_data = (data_sets[0] or {}).get("series") or {}
    if not isinstance(series_dimensions, list) or not isinstance(series_data, dict):
        raise ValueError("ECB FX payload is missing series data")

    time_periods = []
    if observation_dimensions:
        time_periods = [value.get("id") for value in (observation_dimensions[0].get("values") or []) if isinstance(value, dict)]
    effective_at = str(time_periods[0]) if time_periods else None

    rates: dict[str, Decimal] = {"EUR": Decimal("1")}
    for key, series_entry in series_data.items():
        indexes = [int(part) for part in str(key).split(":")]
        dimension_values: dict[str, str] = {}
        for idx, dim in enumerate(series_dimensions):
            values = dim.get("values") or []
            if idx >= len(indexes) or indexes[idx] >= len(values):
                continue
            dimension_values[str(dim.get("id"))] = str(values[indexes[idx]].get("id"))

        currency = dimension_values.get("CURRENCY")
        observations = (series_entry or {}).get("observations") or {}
        if not currency or not observations:
            continue
        first_key = sorted(observations.keys())[0]
        observation = observations.get(first_key) or []
        value = observation[0] if isinstance(observation, list) and observation else None
        rate = _decimal_or_none(value)
        if rate is None:
            continue
        rates[currency.upper()] = rate

    return rates, effective_at


def fetch_ecb_cross_rate(
    base_currency: str,
    quote_currency: str,
    *,
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> FxRateResult:
    base = base_currency.upper()
    quote = quote_currency.upper()
    if base == quote:
        return FxRateResult(
            base_currency=base,
            quote_currency=quote,
            rate=Decimal("1"),
            source=ECB_FX_SOURCE,
            effective_at=None,
            source_url="",
            payload={"identity": True},
        )

    url = _ecb_request_url(currencies=[base, quote])
    payload = _ecb_api_request(url, timeout=timeout)
    eur_rates, effective_at = _extract_ecb_reference_rates(payload)
    eur_to_base = eur_rates.get(base)
    eur_to_quote = eur_rates.get(quote)
    if eur_to_base is None or eur_to_quote is None:
        raise ValueError(f"ECB did not return both {base} and {quote} reference rates")

    rate = (eur_to_quote / eur_to_base).quantize(Decimal("0.0000000001"), rounding=ROUND_HALF_UP)
    return FxRateResult(
        base_currency=base,
        quote_currency=quote,
        rate=rate,
        source=ECB_FX_SOURCE,
        effective_at=effective_at,
        source_url=url,
        payload=payload,
    )


def ensure_fx_rate_snapshot(
    connection,
    *,
    base_currency: str,
    quote_currency: str,
) -> dict[str, Any] | None:
    base = base_currency.upper()
    quote = quote_currency.upper()
    snapshot = fx_rate_snapshot_for_pair(connection, base, quote)
    if snapshot is not None and snapshot.get("isFresh") is True:
        return snapshot

    try:
        fetched = fetch_ecb_cross_rate(base, quote)
    except Exception:
        return snapshot

    upsert_fx_rate_snapshot(
        connection,
        base_currency=base,
        quote_currency=quote,
        rate=float(fetched.rate),
        source=fetched.source,
        effective_at=fetched.effective_at,
        source_url=fetched.source_url,
        payload=fetched.payload,
    )
    connection.commit()
    return fx_rate_snapshot_for_pair(connection, base, quote)


def convert_price(value: float | None, *, rate: Decimal) -> float | None:
    if value is None:
        return None
    converted = (Decimal(str(value)) * rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return float(converted)


def decorate_pricing_summary_with_fx(connection, pricing: dict[str, Any] | None) -> dict[str, Any] | None:
    if pricing is None:
        return None

    currency_code = str(pricing.get("currencyCode") or "").upper()
    pricing_mode = str(pricing.get("pricingMode") or "")
    if not currency_code or currency_code == "USD" or pricing_mode != "raw":
        return pricing

    fx_snapshot = ensure_fx_rate_snapshot(connection, base_currency=currency_code, quote_currency="USD")
    if fx_snapshot is None or not isinstance(fx_snapshot.get("rate"), (int, float)):
        return pricing

    rate = Decimal(str(fx_snapshot["rate"]))
    converted = dict(pricing)
    converted["nativeCurrencyCode"] = currency_code
    converted["nativeLow"] = pricing.get("low")
    converted["nativeMarket"] = pricing.get("market")
    converted["nativeMid"] = pricing.get("mid")
    converted["nativeHigh"] = pricing.get("high")
    converted["nativeDirectLow"] = pricing.get("directLow")
    converted["nativeTrend"] = pricing.get("trend")
    converted["currencyCode"] = "USD"
    converted["low"] = convert_price(pricing.get("low"), rate=rate)
    converted["market"] = convert_price(pricing.get("market"), rate=rate)
    converted["mid"] = convert_price(pricing.get("mid"), rate=rate)
    converted["high"] = convert_price(pricing.get("high"), rate=rate)
    converted["directLow"] = convert_price(pricing.get("directLow"), rate=rate)
    converted["trend"] = convert_price(pricing.get("trend"), rate=rate)
    converted["displayIsConverted"] = True
    converted["fxRate"] = float(rate)
    converted["fxSource"] = fx_snapshot.get("source")
    converted["fxBaseCurrency"] = fx_snapshot.get("baseCurrency")
    converted["fxQuoteCurrency"] = fx_snapshot.get("quoteCurrency")
    converted["fxAsOf"] = fx_snapshot.get("effectiveAt")
    converted["fxRefreshedAt"] = fx_snapshot.get("refreshedAt")
    converted["fxIsFresh"] = fx_snapshot.get("isFresh")
    return converted
