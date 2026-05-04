#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from tools.mobile_env_resolver import resolve_mobile_env_values
except ModuleNotFoundError:  # pragma: no cover - direct script execution path
    from mobile_env_resolver import resolve_mobile_env_values


SMOKE_CONDITION = "near_mint"
SMOKE_CURRENCY = "USD"
SMOKE_PRICE = 0.01
FIXTURE_TARGETS = {
    "sv3pt5-63": 100,  # Abra
    "swsh10-32": 100,  # Piloswine
}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def require_env(name: str) -> str:
    value = str(os.environ.get(name) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def request_json(
    method: str,
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout_seconds: float = 30.0,
) -> Any:
    encoded_payload = None
    request_headers = dict(headers or {})
    if payload is not None:
        encoded_payload = json.dumps(payload).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=encoded_payload, headers=request_headers, method=method.upper())
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method.upper()} {url} failed with HTTP {error.code}: {body}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"{method.upper()} {url} failed: {error}") from error


def authenticate_smoke_user(*, supabase_url: str, anon_key: str, email: str, password: str) -> str:
    payload = {"email": email, "password": password}
    response = request_json(
        "POST",
        f"{supabase_url.rstrip('/')}/auth/v1/token?grant_type=password",
        payload=payload,
        headers={"apikey": anon_key},
        timeout_seconds=20.0,
    )
    access_token = str(response.get("access_token") or "").strip()
    if not access_token:
        raise RuntimeError("Supabase auth response did not include access_token.")
    return access_token


def extract_deck_entries(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [entry for entry in payload if isinstance(entry, dict)]
    if isinstance(payload, dict) and isinstance(payload.get("entries"), list):
        return [entry for entry in payload["entries"] if isinstance(entry, dict)]
    return []


def normalize_condition(value: object) -> str:
    return str(value or "").strip().lower()


def card_id_for_entry(entry: dict[str, Any]) -> str:
    nested_card = entry.get("card") if isinstance(entry.get("card"), dict) else {}
    return str(
        entry.get("cardID")
        or entry.get("cardId")
        or nested_card.get("cardID")
        or nested_card.get("cardId")
        or nested_card.get("id")
        or ""
    ).strip()


def find_raw_entry(entries: list[dict[str, Any]], *, card_id: str, condition: str) -> dict[str, Any] | None:
    matches: list[dict[str, Any]] = []
    for entry in entries:
        if card_id_for_entry(entry) != card_id:
            continue
        if normalize_condition(entry.get("condition")) != condition:
            continue
        matches.append(entry)
    if not matches:
        return None
    if len(matches) > 1:
        raise RuntimeError(f"Smoke fixture reset found multiple raw entries for {card_id} / {condition}.")
    return matches[0]


def fetch_inventory(base_url: str, auth_headers: dict[str, str]) -> list[dict[str, Any]]:
    return extract_deck_entries(
        request_json("GET", f"{base_url}/api/v1/deck/entries", headers=auth_headers)
    )


def fetch_ledger(base_url: str, auth_headers: dict[str, str]) -> dict[str, Any]:
    query = urllib.parse.urlencode(
        {
            "range": "ALL",
            "timeZone": "America/Los_Angeles",
            "limit": "50",
            "offset": "0",
        }
    )
    payload = request_json("GET", f"{base_url}/api/v1/portfolio/ledger?{query}", headers=auth_headers)
    return payload if isinstance(payload, dict) else {}


def buy_quantity(
    *,
    base_url: str,
    auth_headers: dict[str, str],
    card_id: str,
    quantity: int,
) -> None:
    if quantity <= 0:
        return
    request_json(
        "POST",
        f"{base_url}/api/v1/portfolio/buys",
        payload={
            "cardID": card_id,
            "slabContext": None,
            "variantName": None,
            "condition": SMOKE_CONDITION,
            "quantity": quantity,
            "unitPrice": SMOKE_PRICE,
            "currencyCode": SMOKE_CURRENCY,
            "paymentMethod": None,
            "boughtAt": now_iso(),
            "sourceScanID": None,
        },
        headers=auth_headers,
    )


def sell_quantity(
    *,
    base_url: str,
    auth_headers: dict[str, str],
    deck_entry_id: str,
    card_id: str,
    quantity: int,
) -> None:
    if quantity <= 0:
        return
    request_json(
        "POST",
        f"{base_url}/api/v1/portfolio/sales",
        payload={
            "deckEntryID": deck_entry_id,
            "cardID": card_id,
            "slabContext": None,
            "quantity": quantity,
            "unitPrice": SMOKE_PRICE,
            "currencyCode": SMOKE_CURRENCY,
            "paymentMethod": None,
            "soldAt": now_iso(),
            "saleSource": "smoke_reset",
            "showSessionID": None,
            "note": "staging smoke fixture reset",
            "sourceScanID": None,
        },
        headers=auth_headers,
    )


def enforce_fixture_quantity(
    *,
    base_url: str,
    auth_headers: dict[str, str],
    card_id: str,
    target_quantity: int,
) -> dict[str, Any]:
    entries = fetch_inventory(base_url, auth_headers)
    entry = find_raw_entry(entries, card_id=card_id, condition=SMOKE_CONDITION)
    current_quantity = max(0, int(entry.get("quantity") or 0)) if entry is not None else 0

    if current_quantity < target_quantity:
        buy_quantity(
            base_url=base_url,
            auth_headers=auth_headers,
            card_id=card_id,
            quantity=target_quantity - current_quantity,
        )
    elif current_quantity > target_quantity:
        if entry is None:
            raise RuntimeError(f"Smoke reset expected a deck entry for {card_id} before selling down quantity.")
        sell_quantity(
            base_url=base_url,
            auth_headers=auth_headers,
            deck_entry_id=str(entry.get("id") or "").strip(),
            card_id=card_id,
            quantity=current_quantity - target_quantity,
        )

    refreshed_entries = fetch_inventory(base_url, auth_headers)
    refreshed_entry = find_raw_entry(refreshed_entries, card_id=card_id, condition=SMOKE_CONDITION)
    final_quantity = max(0, int(refreshed_entry.get("quantity") or 0)) if refreshed_entry is not None else 0
    if final_quantity != target_quantity:
        raise RuntimeError(
            f"Smoke fixture reset failed for {card_id}: expected quantity {target_quantity}, got {final_quantity}."
        )

    return {
        "cardID": card_id,
        "targetQuantity": target_quantity,
        "finalQuantity": final_quantity,
        "deckEntryID": str(refreshed_entry.get("id") or "").strip() if refreshed_entry is not None else None,
    }


def clear_inventory(
    *,
    base_url: str,
    auth_headers: dict[str, str],
) -> list[dict[str, Any]]:
    entries = fetch_inventory(base_url, auth_headers)
    cleared_entries: list[dict[str, Any]] = []

    for entry in entries:
        deck_entry_id = str(entry.get("id") or "").strip()
        card_id = card_id_for_entry(entry)
        quantity = max(0, int(entry.get("quantity") or 0))
        if not deck_entry_id or not card_id or quantity < 1:
            continue

        sell_quantity(
            base_url=base_url,
            auth_headers=auth_headers,
            deck_entry_id=deck_entry_id,
            card_id=card_id,
            quantity=quantity,
        )
        cleared_entries.append(
            {
                "deckEntryID": deck_entry_id,
                "cardID": card_id,
                "quantityCleared": quantity,
            }
        )

    remaining_entries = fetch_inventory(base_url, auth_headers)
    if remaining_entries:
        remaining_summary = [
            {
                "deckEntryID": str(entry.get("id") or "").strip(),
                "cardID": card_id_for_entry(entry),
                "quantity": int(entry.get("quantity") or 0),
            }
            for entry in remaining_entries
        ]
        raise RuntimeError(
            f"Smoke fixture reset failed to clear inventory fully. Remaining entries: {json.dumps(remaining_summary)}"
        )

    return cleared_entries


def ensure_sale_history(
    *,
    base_url: str,
    auth_headers: dict[str, str],
) -> bool:
    ledger = fetch_ledger(base_url, auth_headers)
    transactions = ledger.get("transactions")
    if isinstance(transactions, list) and len(transactions) > 0:
        return False

    first_card_id = next(iter(FIXTURE_TARGETS.keys()))
    sell_state = enforce_fixture_quantity(
        base_url=base_url,
        auth_headers=auth_headers,
        card_id=first_card_id,
        target_quantity=FIXTURE_TARGETS[first_card_id],
    )
    deck_entry_id = str(sell_state.get("deckEntryID") or "").strip()
    if not deck_entry_id:
        raise RuntimeError("Smoke fixture reset could not locate a seeded deck entry for sale history.")

    sell_quantity(
        base_url=base_url,
        auth_headers=auth_headers,
        deck_entry_id=deck_entry_id,
        card_id=first_card_id,
        quantity=1,
    )
    buy_quantity(
        base_url=base_url,
        auth_headers=auth_headers,
        card_id=first_card_id,
        quantity=1,
    )
    return True


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    mobile_env = resolve_mobile_env_values(repo_root, "staging", "staging")
    base_url = str(mobile_env.get("EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL") or "").strip().rstrip("/")
    supabase_url = str(mobile_env.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL") or "").strip().rstrip("/")
    anon_key = str(mobile_env.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY") or "").strip()
    if not base_url or not supabase_url or not anon_key:
        raise RuntimeError(
            "Staging mobile env must define EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL, EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL, and EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY."
        )

    email = require_env("SPOTLIGHT_STAGING_SMOKE_EMAIL")
    password = require_env("SPOTLIGHT_STAGING_SMOKE_PASSWORD")
    access_token = authenticate_smoke_user(
        supabase_url=supabase_url,
        anon_key=anon_key,
        email=email,
        password=password,
    )
    auth_headers = {"Authorization": f"Bearer {access_token}"}

    cleared_entries = clear_inventory(base_url=base_url, auth_headers=auth_headers)
    fixture_results = [
        enforce_fixture_quantity(
            base_url=base_url,
            auth_headers=auth_headers,
            card_id=card_id,
            target_quantity=target_quantity,
        )
        for card_id, target_quantity in FIXTURE_TARGETS.items()
    ]
    synthesized_sale = ensure_sale_history(base_url=base_url, auth_headers=auth_headers)

    print(
        json.dumps(
            {
                "clearedInventory": cleared_entries,
                "fixtureEntries": fixture_results,
                "saleHistorySynthesized": synthesized_sale,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
