"""TCGCSV (tcgcsv.com) adapter: free daily republication of TCGplayer price data.

Feeds the "main lane" (main_raw_* snapshot columns + lane='raw_main' cells) written
by sync_tcgcsv_prices.py. Rate-limit courtesy is enforced HERE, not by callers:
strictly sequential requests with a minimum spacing, an identifying User-Agent, and
Retry-After/backoff on 429/5xx. On final failure the error propagates so the whole
run aborts — a stale main lane is handled by the read-side staleness fallback,
never by retry-storming a free mirror.
"""

from __future__ import annotations

import json
import random
import re
import socket
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.error import HTTPError, URLError

from email.utils import parsedate_to_datetime

TCGCSV_PROVIDER = "tcgcsv"
TCGCSV_BASE_URL = "https://tcgcsv.com/tcgplayer"
# TCGplayer categories: Pokemon EN = 3, Pokemon Japan = 85 (this catalog is Pokémon-only).
TCGCSV_CATEGORY_IDS = (3, 85)

TCGCSV_USER_AGENT = "Spotlight/1.1 (card scanner; contact: stmchan8953@gmail.com)"
TCGCSV_MIN_REQUEST_INTERVAL_SECONDS = 0.3
TCGCSV_REQUEST_TIMEOUT_SECONDS = 60.0
TCGCSV_MAX_ATTEMPTS = 5
TCGCSV_RETRY_BASE_DELAY_SECONDS = 2.0
TCGCSV_RETRY_MAX_DELAY_SECONDS = 30.0
TCGCSV_RETRY_JITTER_SECONDS = 1.0
TCGCSV_TRANSIENT_HTTP_STATUS_CODES = {429, 500, 502, 503, 504}

# Total HTTP attempts this process — recorded as provider_sync_runs.pages_fetched.
request_count = 0
_last_request_monotonic = 0.0


def _parse_retry_after_seconds(value: str | None) -> float | None:
    normalized = str(value or "").strip()
    if not normalized:
        return None
    try:
        return max(0.0, float(normalized))
    except ValueError:
        pass
    try:
        retry_at = parsedate_to_datetime(normalized)
    except (TypeError, ValueError):
        return None
    if retry_at.tzinfo is None:
        return None
    return max(0.0, retry_at.timestamp() - time.time())


def _retry_after_from_error(exc: BaseException) -> float | None:
    if not isinstance(exc, HTTPError):
        return None
    headers = getattr(exc, "headers", None)
    if headers is None:
        return None
    return _parse_retry_after_seconds(headers.get("Retry-After"))


def _is_transient_error(exc: BaseException) -> bool:
    if isinstance(exc, HTTPError):
        return int(exc.code) in TCGCSV_TRANSIENT_HTTP_STATUS_CODES
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return True
    if isinstance(exc, URLError):
        reason = getattr(exc, "reason", None)
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return True
        message = str(exc).lower()
        return (
            "timed out" in message
            or "connection reset" in message
            or "temporarily unavailable" in message
        )
    return False


def _retry_delay_seconds(attempt: int, exc: BaseException) -> float:
    retry_after = _retry_after_from_error(exc)
    if retry_after is not None:
        return retry_after
    exponential_delay = TCGCSV_RETRY_BASE_DELAY_SECONDS * (2 ** max(0, attempt - 1))
    delay = min(TCGCSV_RETRY_MAX_DELAY_SECONDS, exponential_delay)
    jitter = random.uniform(0.0, TCGCSV_RETRY_JITTER_SECONDS)
    return min(TCGCSV_RETRY_MAX_DELAY_SECONDS, delay + jitter)


def _fetch_bytes(url: str) -> bytes:
    global request_count, _last_request_monotonic
    for attempt in range(1, TCGCSV_MAX_ATTEMPTS + 1):
        wait = TCGCSV_MIN_REQUEST_INTERVAL_SECONDS - (time.monotonic() - _last_request_monotonic)
        if wait > 0:
            time.sleep(wait)
        request = urllib.request.Request(url, headers={"User-Agent": TCGCSV_USER_AGENT})
        try:
            request_count += 1
            with urllib.request.urlopen(request, timeout=TCGCSV_REQUEST_TIMEOUT_SECONDS) as response:
                body = response.read()
            _last_request_monotonic = time.monotonic()
            return body
        except Exception as exc:
            _last_request_monotonic = time.monotonic()
            if attempt >= TCGCSV_MAX_ATTEMPTS or not _is_transient_error(exc):
                raise
            time.sleep(_retry_delay_seconds(attempt, exc))
    raise RuntimeError("unreachable")


def _fetch_json(url: str) -> Any:
    return json.loads(_fetch_bytes(url).decode("utf-8"))


def fetch_last_updated() -> str:
    """The site's publish marker (https://tcgcsv.com/last-updated.txt). Their docs:
    "Check last-updated.txt first before syncing" / "Limit your pulls to once every
    24 hours" — the sync skips the full crawl when this hasn't advanced since the
    last successful run."""
    return _fetch_bytes("https://tcgcsv.com/last-updated.txt").decode("utf-8", "replace").strip()


def _results(payload: Any) -> list[dict[str, Any]]:
    results = payload.get("results") if isinstance(payload, dict) else None
    return [row for row in results if isinstance(row, dict)] if isinstance(results, list) else []


def fetch_group_ids(category_id: int) -> list[int]:
    group_ids: list[int] = []
    for row in _results(_fetch_json(f"{TCGCSV_BASE_URL}/{category_id}/groups")):
        group_id = row.get("groupId")
        if isinstance(group_id, int):
            group_ids.append(group_id)
    return group_ids


def fetch_group_prices(category_id: int, group_id: int) -> list[dict[str, Any]]:
    return _results(_fetch_json(f"{TCGCSV_BASE_URL}/{category_id}/{group_id}/prices"))


def fetch_group_products(category_id: int, group_id: int) -> list[dict[str, Any]]:
    return _results(_fetch_json(f"{TCGCSV_BASE_URL}/{category_id}/{group_id}/products"))


def build_price_and_number_maps(
    categories: tuple[int, ...] = TCGCSV_CATEGORY_IDS,
    group_by_product: dict[str, tuple[int, int]] | None = None,
    failed_groups: list[tuple[int, int, str]] | None = None,
) -> tuple[dict[str, dict[str, dict[str, Any]]], dict[str, str]]:
    """({productId(str): {subTypeName: price_row}}, {productId: normalized card
    Number}) over every group in every category. The Number map (from each
    group's /products) is the trust-but-verify side of the join: a product whose
    own Number disagrees with the card must not price it. When
    ``group_by_product`` is supplied it is filled with productId ->
    (category_id, group_id).

    When ``failed_groups`` is supplied, a group whose fetch exhausts its retries
    is recorded there and skipped instead of aborting the crawl — one flaky group
    must not cost the other ~380 their daily price. Without it (back-compat),
    any failure propagates. Group-LIST fetches always propagate: without the
    list there is no crawl to salvage."""
    by_product: dict[str, dict[str, dict[str, Any]]] = {}
    number_by_product: dict[str, str] = {}
    for category_id in categories:
        for group_id in fetch_group_ids(category_id):
            try:
                price_rows = fetch_group_prices(category_id, group_id)
            except Exception:
                if failed_groups is None:
                    raise
                failed_groups.append((category_id, group_id, "prices"))
                continue
            for row in price_rows:
                product_id = row.get("productId")
                sub_type_name = str(row.get("subTypeName") or "").strip()
                if product_id is None or not str(product_id).strip() or not sub_type_name:
                    continue
                key = str(product_id).strip()
                by_product.setdefault(key, {})[sub_type_name] = row
                if group_by_product is not None:
                    group_by_product.setdefault(key, (category_id, group_id))
            try:
                product_rows = fetch_group_products(category_id, group_id)
            except Exception:
                if failed_groups is None:
                    raise
                failed_groups.append((category_id, group_id, "products"))
                product_rows = []
            for row in product_rows:
                product_id = str(row.get("productId") or "").strip()
                if not product_id:
                    continue
                number = product_number(row)
                if number:
                    number_by_product[product_id] = number
    return by_product, number_by_product


def build_product_price_map(
    categories: tuple[int, ...] = TCGCSV_CATEGORY_IDS,
    group_by_product: dict[str, tuple[int, int]] | None = None,
) -> dict[str, dict[str, dict[str, Any]]]:
    prices, _numbers = build_price_and_number_maps(categories, group_by_product)
    return prices


def normalized_card_number(value: Any) -> str:
    """"061/060" -> "61", "045" -> "45", "H01" -> "h1", "SVP 175" -> "svp175":
    the part before "/", spaces removed, lowercased, leading zeros stripped from
    the digit run after an optional alpha prefix (measured against the real
    TCGCSV product-number formats in the 2026-08-25 parity audit)."""
    text = str(value or "").strip().split("/", 1)[0].strip().lower().replace(" ", "")
    return re.sub(r"^([a-z]*)0+(?=\d)", r"\1", text)


def card_numbers_match(card_number: str, product_number: str) -> bool:
    """True when two normalized numbers name the same card. Exact match, or one
    side carries an alphabetic set prefix the other omits ("svp175" vs "175").
    Letter-suffix variants ("50a" vs "50") deliberately do NOT match — those are
    distinct printings and must fail closed."""
    if not card_number or not product_number:
        return False
    if card_number == product_number:
        return True
    for longer, shorter in ((card_number, product_number), (product_number, card_number)):
        if longer.endswith(shorter):
            prefix = longer[: -len(shorter)]
            if prefix and prefix.isalpha():
                return True
    return False


def product_number(product_row: dict[str, Any]) -> str | None:
    """The card Number from a TCGCSV product's extendedData, normalized."""
    for entry in product_row.get("extendedData") or []:
        if isinstance(entry, dict) and str(entry.get("name") or "").strip() == "Number":
            normalized = normalized_card_number(entry.get("value"))
            return normalized or None
    return None


# Scrydex variant label -> the TCGCSV subTypeName it maps to.
_VARIANT_LABEL_TO_SUBTYPE = {
    "Normal": "Normal",
    "Holofoil": "Holofoil",
    "Reverse Holofoil": "Reverse Holofoil",
    "First Edition": "1st Edition Holofoil",
    "Unlimited": "Unlimited Holofoil",
}
_SUBTYPE_FALLBACK_ORDER = (
    "Normal",
    "Holofoil",
    "Reverse Holofoil",
    "Unlimited Normal",
    "Unlimited Holofoil",
    "1st Edition Normal",
    "1st Edition Holofoil",
)

# TCGCSV subTypeName -> the Scrydex variant label whose per-condition cells it
# prices (inverse of _VARIANT_LABEL_TO_SUBTYPE, widened with the Normal-print
# editions, which collapse to the same Scrydex edition label as their Holofoils).
SUBTYPE_TO_SCRYDEX_VARIANT_LABEL = {
    "Normal": "Normal",
    "Holofoil": "Holofoil",
    "Reverse Holofoil": "Reverse Holofoil",
    "1st Edition Holofoil": "First Edition",
    "1st Edition Normal": "First Edition",
    "Unlimited Holofoil": "Unlimited",
    "Unlimited Normal": "Unlimited",
}


def subtype_for_variant_label(label: Any) -> str | None:
    """TCGCSV subTypeName for a Scrydex variant label; None when unmapped (never guess)."""
    return _VARIANT_LABEL_TO_SUBTYPE.get(str(label or "").strip())


def scrydex_variant_label_for_subtype(sub_type_name: Any) -> str | None:
    """Scrydex variant label for a TCGCSV subTypeName; None when unmapped (never guess)."""
    return SUBTYPE_TO_SCRYDEX_VARIANT_LABEL.get(str(sub_type_name or "").strip())


def _market_price(row: dict[str, Any]) -> float | None:
    value = row.get("marketPrice")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value > 0 else None


def select_main_price_entry(
    variant_product_ids: dict[str, str],
    default_raw_variant: str | None,
    prices_by_product: dict[str, dict[str, dict[str, Any]]],
    colliding_product_ids: frozenset[str] | set[str],
) -> tuple[dict[str, Any], str, str] | None:
    """Pick the one TCGCSV entry that becomes the card's main-lane price.

    Walk the default variant's product id first (preferring its mapped subTypeName,
    then the fixed fallback order, then any), then the card's other product ids.
    Only an entry with marketPrice > 0 qualifies; None means no main price
    (the read path falls back to Scrydex — never guess)."""
    default_label = str(default_raw_variant or "").strip()
    ordered_product_ids: list[str] = []
    default_product_id = variant_product_ids.get(default_label)
    if default_product_id:
        ordered_product_ids.append(default_product_id)
    for product_id in variant_product_ids.values():
        if product_id not in ordered_product_ids:
            ordered_product_ids.append(product_id)

    preferred_subtype = _VARIANT_LABEL_TO_SUBTYPE.get(default_label)
    for product_id in ordered_product_ids:
        if product_id in colliding_product_ids:
            continue
        subtypes = prices_by_product.get(product_id)
        if not subtypes:
            continue
        candidate_order: list[str] = []
        if preferred_subtype:
            candidate_order.append(preferred_subtype)
        candidate_order.extend(_SUBTYPE_FALLBACK_ORDER)
        candidate_order.extend(subtypes.keys())
        seen: set[str] = set()
        for sub_type_name in candidate_order:
            if sub_type_name in seen or sub_type_name not in subtypes:
                continue
            seen.add(sub_type_name)
            row = subtypes[sub_type_name]
            if _market_price(row) is not None:
                return row, sub_type_name, product_id
    return None
