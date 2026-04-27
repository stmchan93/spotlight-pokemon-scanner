from __future__ import annotations

from base64 import b64encode
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Callable, Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen


EBAY_WEB_SEARCH_BASE_URL = "https://www.ebay.com/sch/i.html"
EBAY_BROWSE_API_BASE_URL = "https://api.ebay.com"
EBAY_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
DEFAULT_REQUEST_TIMEOUT_SECONDS = 5
DEFAULT_RESULT_LIMIT = 5
EBAY_WEB_LOWEST_PRICE_SORT = "15"
EBAY_BROWSE_LOWEST_PRICE_SORT = "price"
PSA_GRADE_OPTIONS = ("10", "9", "8.5", "8")
EBAY_BROWSE_ENABLED_ENV = "SPOTLIGHT_EBAY_BROWSE_ENABLED"
EBAY_CLIENT_ID_ENV = "EBAY_CLIENT_ID"
EBAY_CLIENT_SECRET_ENV = "EBAY_CLIENT_SECRET"
EBAY_MARKETPLACE_ID_ENV = "EBAY_MARKETPLACE_ID"
EBAY_API_BASE_URL_ENV = "EBAY_API_BASE_URL"
DEFAULT_MARKETPLACE_ID = "EBAY_US"
DEFAULT_BROWSE_FILTER = "buyingOptions:{FIXED_PRICE|AUCTION},priceCurrency:USD"
_EBAY_TOKEN_CACHE_LOCK = Lock()
_EBAY_TOKEN_CACHE: dict[str, Any] = {
    "access_token": None,
    "expires_at": 0.0,
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _env_flag(name: str, *, default: bool = False) -> bool:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    return str(raw_value).strip().lower() in {"1", "true", "yes", "on"}


def _strip_html(text: object) -> str:
    cleaned = re.sub(r"<[^>]+>", " ", str(text or ""))
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _normalize_grade_label(value: object) -> str:
    text = str(value or "").strip().upper()
    if not text:
        return ""
    try:
        numeric = float(text)
    except ValueError:
        return text
    if numeric.is_integer():
        return str(int(numeric))
    normalized = f"{numeric:.2f}".rstrip("0").rstrip(".")
    return normalized


def _grade_sort_key(value: str) -> tuple[int, float, str]:
    try:
        numeric = float(value)
    except ValueError:
        return (1, 0.0, value)
    return (0, -numeric, value)


def build_psa_grade_options(
    selected_grade: str | None = None,
    *,
    available_grades: Iterable[str] = (),
) -> list[dict[str, Any]]:
    ordered: list[str] = []
    seen: set[str] = set()

    def add(value: object) -> None:
        grade = _normalize_grade_label(value)
        if not grade or grade in seen:
            return
        seen.add(grade)
        ordered.append(grade)

    for grade in PSA_GRADE_OPTIONS:
        add(grade)

    extra_grades = sorted(
        {
            _normalize_grade_label(grade)
            for grade in available_grades
            if _normalize_grade_label(grade)
        },
        key=_grade_sort_key,
    )
    for grade in extra_grades:
        add(grade)

    normalized_selected = _normalize_grade_label(selected_grade) or ordered[0]
    if normalized_selected not in seen:
        ordered.insert(0, normalized_selected)
        seen.add(normalized_selected)

    return [
        {
            "id": grade,
            "label": grade,
            "selected": grade == normalized_selected,
        }
        for grade in ordered
    ]


def _build_search_query(card: dict[str, Any], *, grader: str, selected_grade: str | None) -> str:
    card_name = str(card.get("name") or card.get("cardName") or "").strip()
    set_name = str(card.get("setName") or card.get("set_name") or "").strip()
    card_number = str(card.get("number") or "").strip()
    parts = [part for part in [card_name, set_name, card_number, grader, selected_grade] if part]
    return " ".join(parts)


def _build_live_search_url(search_query: str, *, limit: int) -> str:
    params = {
        "_nkw": search_query,
        "_ipg": str(max(1, min(int(limit), 100))),
        "_sop": EBAY_WEB_LOWEST_PRICE_SORT,
        "rt": "nc",
    }
    return f"{EBAY_WEB_SEARCH_BASE_URL}?{urlencode(params)}"


def _build_browse_search_url(search_query: str, *, limit: int, marketplace_id: str) -> str:
    params = {
        "q": search_query,
        "limit": str(max(1, min(int(limit), 100))),
        "filter": DEFAULT_BROWSE_FILTER,
        "sort": EBAY_BROWSE_LOWEST_PRICE_SORT,
    }
    return f"{_ebay_api_base_url().rstrip('/')}/buy/browse/v1/item_summary/search?{urlencode(params)}"


def _request_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout_seconds: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    request = Request(url, data=data, method=method)
    request.add_header("Accept", "application/json")
    if headers:
        for key, value in headers.items():
            request.add_header(key, value)
    with urlopen(request, timeout=timeout_seconds) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        raw = response.read().decode(charset, errors="replace")
        payload = json.loads(raw or "{}")
        if not isinstance(payload, dict):
            raise ValueError("Expected JSON object")
        return payload


def _ebay_api_base_url() -> str:
    return os.environ.get(EBAY_API_BASE_URL_ENV, EBAY_BROWSE_API_BASE_URL).strip() or EBAY_BROWSE_API_BASE_URL


def _ebay_marketplace_id() -> str:
    return os.environ.get(EBAY_MARKETPLACE_ID_ENV, DEFAULT_MARKETPLACE_ID).strip().upper() or DEFAULT_MARKETPLACE_ID


def _ebay_client_credentials() -> tuple[str, str]:
    client_id = os.environ.get(EBAY_CLIENT_ID_ENV, "").strip()
    client_secret = os.environ.get(EBAY_CLIENT_SECRET_ENV, "").strip()
    if not client_id or not client_secret:
        return "", ""
    return client_id, client_secret


def _ebay_browse_enabled() -> bool:
    return _env_flag(EBAY_BROWSE_ENABLED_ENV, default=False)


def _browse_search_ready_reason() -> str | None:
    if not _ebay_browse_enabled():
        return "browse_disabled"
    client_id, client_secret = _ebay_client_credentials()
    if not client_id or not client_secret:
        return "missing_credentials"
    return None


def _reset_ebay_token_cache() -> None:
    with _EBAY_TOKEN_CACHE_LOCK:
        _EBAY_TOKEN_CACHE["access_token"] = None
        _EBAY_TOKEN_CACHE["expires_at"] = 0.0


def _ebay_app_access_token(
    *,
    timeout_seconds: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    request_json: Callable[..., dict[str, Any]] | None = None,
) -> str:
    client_id, client_secret = _ebay_client_credentials()
    if not client_id or not client_secret:
        raise ValueError("Missing eBay client credentials")

    now = datetime.now(timezone.utc).timestamp()
    with _EBAY_TOKEN_CACHE_LOCK:
        cached_token = str(_EBAY_TOKEN_CACHE.get("access_token") or "").strip()
        expires_at = float(_EBAY_TOKEN_CACHE.get("expires_at") or 0.0)
        if cached_token and expires_at > now + 60:
            return cached_token

    token_url = f"{_ebay_api_base_url().rstrip('/')}/identity/v1/oauth2/token"
    scope = "https://api.ebay.com/oauth/api_scope"
    body = urlencode({"grant_type": "client_credentials", "scope": scope}).encode("utf-8")
    credentials = b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    request_headers = {
        "Authorization": f"Basic {credentials}",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    fetch_json = request_json or _request_json
    payload = fetch_json(
        token_url,
        method="POST",
        headers=request_headers,
        data=body,
        timeout_seconds=timeout_seconds,
    )
    token = str(payload.get("access_token") or "").strip()
    if not token:
        raise ValueError("eBay access token response did not include access_token")

    expires_in = payload.get("expires_in")
    try:
        expires_in_seconds = int(expires_in)
    except (TypeError, ValueError):
        expires_in_seconds = 0
    expires_at = now + max(300, expires_in_seconds - 60)

    with _EBAY_TOKEN_CACHE_LOCK:
        _EBAY_TOKEN_CACHE["access_token"] = token
        _EBAY_TOKEN_CACHE["expires_at"] = expires_at
    return token


def _normalize_listing_date(value: object) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    cleaned = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(cleaned)
    except ValueError:
        return text
    return parsed.date().isoformat()


def _normalize_result_limit(limit: object) -> int:
    try:
        parsed_limit = int(limit)
    except (TypeError, ValueError):
        parsed_limit = DEFAULT_RESULT_LIMIT
    return max(1, min(parsed_limit, DEFAULT_RESULT_LIMIT))


def _browse_item_sale_type(item: dict[str, Any]) -> str | None:
    buying_options = item.get("buyingOptions")
    if not isinstance(buying_options, list):
        return None
    normalized = [str(option or "").strip().upper() for option in buying_options if str(option or "").strip()]
    if not normalized:
        return None
    if "FIXED_PRICE" in normalized:
        return "fixed_price"
    if "AUCTION" in normalized:
        return "auction"
    return normalized[0].lower()


def _browse_item_price(item: dict[str, Any]) -> tuple[float | None, str | None, str | None]:
    candidates = []
    for key in ("price", "currentBidPrice"):
        value = item.get(key)
        if isinstance(value, dict):
            candidates.append(value)
    for price_payload in candidates:
        raw_amount = price_payload.get("value")
        raw_currency = price_payload.get("currency") or price_payload.get("currencyCode")
        amount = None
        try:
            if raw_amount is not None and str(raw_amount).strip():
                amount = float(str(raw_amount).replace(",", ""))
        except ValueError:
            amount = None
        currency_code = str(raw_currency or "").strip() or None
        display = None
        if amount is not None and currency_code:
            display = f"{currency_code} {amount:,.2f}"
        if amount is not None or currency_code is not None:
            return amount, currency_code, display
    return None, None, None


def _stable_transaction_id(*, item_id: str | None, link: str | None, title: str, listing_date: str | None, price_amount: float | None) -> str:
    if item_id:
        return f"ebay:{item_id}"
    digest_source = "|".join(
        [
            link or "",
            title,
            listing_date or "",
            "" if price_amount is None else f"{price_amount:.2f}",
        ]
    )
    digest = hashlib.sha1(digest_source.encode("utf-8")).hexdigest()[:16]
    return f"ebay:{digest}"


def _transaction_payload(
    *,
    item_id: str | None,
    title: str,
    link: str | None,
    listing_date: str | None,
    price_amount: float | None,
    price_currency_code: str | None,
    price_display: str | None,
    grader: str | None,
    grade: str | None,
    sale_type: str | None,
) -> dict[str, Any] | None:
    normalized_title = _strip_html(title)
    if not normalized_title:
        return None
    payload = {
        "id": _stable_transaction_id(
            item_id=item_id,
            link=link,
            title=normalized_title,
            listing_date=listing_date,
            price_amount=price_amount,
        ),
        "title": normalized_title,
        "saleType": sale_type,
        "soldAt": listing_date,
        "listingDate": listing_date,
        "price": {
            "amount": price_amount,
            "currencyCode": price_currency_code or "USD",
            "display": price_display,
        },
        "currencyCode": price_currency_code or "USD",
        "grader": grader,
        "grade": _normalize_grade_label(grade) or None,
        "listingURL": link,
        "link": link,
    }
    return payload


def _parse_browse_items(items: object, *, selected_grade: str | None) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    transactions: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        subtitle = str(item.get("subtitle") or "").strip()
        if subtitle and subtitle.lower() not in title.lower():
            title = f"{title} - {subtitle}"
        item_id = str(item.get("itemId") or item.get("legacyItemId") or "").strip() or None
        link = str(item.get("itemWebUrl") or item.get("itemHref") or "").strip() or None
        listing_date = _normalize_listing_date(item.get("itemCreationDate") or item.get("itemOriginDate"))
        price_amount, price_currency_code, price_display = _browse_item_price(item)
        sale_type = _browse_item_sale_type(item)
        parsed_grade = _normalize_grade_label(selected_grade) or None
        transaction = _transaction_payload(
            item_id=item_id,
            title=title,
            link=link,
            listing_date=listing_date,
            price_amount=price_amount,
            price_currency_code=price_currency_code,
            price_display=price_display,
            grader="PSA" if parsed_grade else None,
            grade=parsed_grade,
            sale_type=sale_type,
        )
        if transaction is not None:
            transactions.append(transaction)
    return transactions


def _dedupe_transactions(transactions: list[dict[str, Any]], *, limit: int) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for transaction in transactions:
        transaction_id = str(transaction.get("id") or "").strip()
        if not transaction_id or transaction_id in seen:
            continue
        seen.add(transaction_id)
        deduped.append(transaction)
        if len(deduped) >= limit:
            break
    return deduped


def _transactions_currency_code(transactions: list[dict[str, Any]]) -> str:
    for transaction in transactions:
        raw_currency_code = transaction.get("currencyCode")
        if raw_currency_code is None and isinstance(transaction.get("price"), dict):
            raw_currency_code = transaction["price"].get("currencyCode")
        currency_code = str(raw_currency_code or "").strip()
        if currency_code:
            return currency_code
    return "USD"


def _unavailable_payload(
    *,
    card: dict[str, Any],
    grader: str | None,
    selected_grade: str | None,
    grade_options: list[dict[str, Any]],
    fetched_at: str,
    search_query: str,
    search_url: str,
    status_reason: str,
    unavailable_reason: str,
    error_type: str | None = None,
    error_message: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "cardID": str(card.get("id") or "").strip() or None,
        "cardName": str(card.get("name") or card.get("cardName") or "").strip() or None,
        "setName": str(card.get("setName") or card.get("set_name") or "").strip() or None,
        "number": str(card.get("number") or "").strip() or None,
        "source": "ebay",
        "status": "unavailable",
        "statusReason": status_reason,
        "unavailableReason": unavailable_reason,
        "grader": grader,
        "selectedGrade": selected_grade,
        "availableGradeOptions": grade_options,
        "transactions": [],
        "transactionCount": 0,
        "currencyCode": "USD",
        "fetchedAt": fetched_at,
        "searchURL": search_url,
        "searchQuery": search_query,
    }
    if error_type and error_message:
        payload["error"] = {
            "type": error_type,
            "message": error_message,
        }
    return payload


def fetch_graded_card_ebay_comps(
    card: dict[str, Any],
    *,
    grader: str | None = "PSA",
    selected_grade: str | None = None,
    available_grades: Iterable[str] = (),
    limit: int = DEFAULT_RESULT_LIMIT,
    fetch_json: Callable[..., dict[str, Any]] | None = None,
    timeout_seconds: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    normalized_grader = str(grader or "").strip().upper() or None
    normalized_selected_grade = _normalize_grade_label(selected_grade) or None
    if normalized_grader is None and normalized_selected_grade is not None:
        normalized_grader = "PSA"
    normalized_limit = _normalize_result_limit(limit)
    has_grade_context = bool(
        normalized_grader
        or normalized_selected_grade
        or any(_normalize_grade_label(grade) for grade in available_grades)
    )
    grade_options: list[dict[str, Any]] = []
    if has_grade_context:
        grade_options = build_psa_grade_options(
            normalized_selected_grade,
            available_grades=available_grades,
        )
        if normalized_selected_grade is None and grade_options:
            normalized_selected_grade = str(grade_options[0]["id"])
        if normalized_selected_grade and all(option["id"] != normalized_selected_grade for option in grade_options):
            grade_options = build_psa_grade_options(
                normalized_selected_grade,
                available_grades=[option["id"] for option in grade_options],
            )

    fetched_at = _utc_now()
    search_query = _build_search_query(
        card,
        grader=normalized_grader or "",
        selected_grade=normalized_selected_grade,
    )
    search_url = _build_live_search_url(search_query, limit=normalized_limit)

    browse_search_ready_reason = _browse_search_ready_reason()
    if browse_search_ready_reason is not None:
        if browse_search_ready_reason == "browse_disabled":
            reason = "eBay active listings are disabled in this environment."
        else:
            reason = "eBay active listing credentials are not configured."
        return _unavailable_payload(
            card=card,
            grader=normalized_grader,
            selected_grade=normalized_selected_grade,
            grade_options=grade_options,
            fetched_at=fetched_at,
            search_query=search_query,
            search_url=search_url,
            status_reason=browse_search_ready_reason,
            unavailable_reason=reason,
        )

    fetch_json_fn = fetch_json or _request_json

    try:
        access_token = _ebay_app_access_token(timeout_seconds=timeout_seconds, request_json=fetch_json_fn)
    except Exception as error:  # noqa: BLE001
        return _unavailable_payload(
            card=card,
            grader=normalized_grader,
            selected_grade=normalized_selected_grade,
            grade_options=grade_options,
            fetched_at=fetched_at,
            search_query=search_query,
            search_url=search_url,
            status_reason="fetch_failed",
            unavailable_reason="The backend could not authenticate with eBay Browse.",
            error_type=type(error).__name__,
            error_message=str(error),
        )

    browse_url = _build_browse_search_url(search_query, limit=normalized_limit, marketplace_id=_ebay_marketplace_id())
    browse_headers = {
        "Authorization": f"Bearer {access_token}",
        "X-EBAY-C-MARKETPLACE-ID": _ebay_marketplace_id(),
    }
    try:
        payload = fetch_json_fn(
            browse_url,
            headers=browse_headers,
            timeout_seconds=timeout_seconds,
        )
    except Exception as error:  # noqa: BLE001
        return _unavailable_payload(
            card=card,
            grader=normalized_grader,
            selected_grade=normalized_selected_grade,
            grade_options=grade_options,
            fetched_at=fetched_at,
            search_query=search_query,
            search_url=search_url,
            status_reason="fetch_failed",
            unavailable_reason="The backend could not reach eBay Browse.",
            error_type=type(error).__name__,
            error_message=str(error),
        )

    transactions = _parse_browse_items(payload.get("itemSummaries"), selected_grade=normalized_selected_grade)
    transactions = _dedupe_transactions(transactions, limit=normalized_limit)

    status_reason = None if transactions else "no_results"
    return {
        "cardID": str(card.get("id") or "").strip() or None,
        "cardName": str(card.get("name") or card.get("cardName") or "").strip() or None,
        "setName": str(card.get("setName") or card.get("set_name") or "").strip() or None,
        "number": str(card.get("number") or "").strip() or None,
        "source": "ebay",
        "status": "available",
        "statusReason": status_reason,
        "error": None,
        "grader": normalized_grader,
        "selectedGrade": normalized_selected_grade,
        "availableGradeOptions": grade_options,
        "transactions": transactions,
        "transactionCount": len(transactions),
        "currencyCode": _transactions_currency_code(transactions),
        "fetchedAt": fetched_at,
        "searchURL": search_url,
        "searchQuery": search_query,
        "marketplaceID": _ebay_marketplace_id(),
    }
