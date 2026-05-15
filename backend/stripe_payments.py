"""Stripe payments helpers for Spotlight payments MVP.

This module is intentionally thin: it owns env wiring and direct Stripe API
calls. Higher-level orchestration (order rows, webhook idempotency, deck
state changes) lives in `server.py`.

The `stripe` SDK is an optional dependency at import time so that backend
tests can run without it installed. Any function that actually performs a
Stripe API call will raise a clear error if the SDK is missing.
"""
from __future__ import annotations

import os
from typing import Any

try:
    import stripe as _stripe_sdk  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - exercised only when optional dep absent
    _stripe_sdk = None


STRIPE_SECRET_KEY_ENV = "STRIPE_SECRET_KEY"
STRIPE_WEBHOOK_SECRET_ENV = "STRIPE_WEBHOOK_SECRET"
STRIPE_PLATFORM_FEE_BPS_ENV = "STRIPE_PLATFORM_FEE_BPS"
PUBLIC_BASE_URL_ENV = "SPOTLIGHT_PUBLIC_BASE_URL"

DEFAULT_PLATFORM_FEE_BPS = 400  # 4%
DEFAULT_PUBLIC_BASE_URL = "https://app.looty.com"


class StripeNotConfiguredError(RuntimeError):
    """Raised when a Stripe operation is attempted without env wiring."""


class StripeSignatureError(RuntimeError):
    """Raised when a Stripe webhook signature cannot be verified."""


def stripe_secret_key() -> str | None:
    value = os.environ.get(STRIPE_SECRET_KEY_ENV)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def stripe_webhook_secret() -> str | None:
    value = os.environ.get(STRIPE_WEBHOOK_SECRET_ENV)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def platform_fee_bps() -> int:
    raw = os.environ.get(STRIPE_PLATFORM_FEE_BPS_ENV)
    if raw is None or not str(raw).strip():
        return DEFAULT_PLATFORM_FEE_BPS
    try:
        parsed = int(str(raw).strip())
    except ValueError:
        return DEFAULT_PLATFORM_FEE_BPS
    if parsed < 0:
        return DEFAULT_PLATFORM_FEE_BPS
    return parsed


def public_base_url() -> str:
    value = os.environ.get(PUBLIC_BASE_URL_ENV)
    if value is None:
        return DEFAULT_PUBLIC_BASE_URL
    stripped = value.strip().rstrip("/")
    return stripped or DEFAULT_PUBLIC_BASE_URL


def is_stripe_configured() -> bool:
    return stripe_secret_key() is not None


def compute_application_fee_cents(amount_cents: int, *, bps: int | None = None) -> int:
    """Return the platform fee, rounded down to whole cents."""
    fee_bps = platform_fee_bps() if bps is None else int(bps)
    if amount_cents <= 0 or fee_bps <= 0:
        return 0
    fee = (int(amount_cents) * int(fee_bps)) // 10_000
    return max(0, int(fee))


def _stripe_module() -> Any:
    if _stripe_sdk is None:
        raise StripeNotConfiguredError(
            "The 'stripe' Python package is not installed on this backend."
        )
    secret = stripe_secret_key()
    if not secret:
        raise StripeNotConfiguredError(
            "STRIPE_SECRET_KEY is not configured on this backend."
        )
    # Set lazily so unit tests that swap the module out can monkey-patch freely.
    _stripe_sdk.api_key = secret
    return _stripe_sdk


def verify_webhook_signature(payload_bytes: bytes, sig_header: str | None) -> dict[str, Any]:
    """Verify a Stripe webhook signature and return the parsed event dict.

    Raises `StripeSignatureError` on any failure.
    """
    secret = stripe_webhook_secret()
    if not secret:
        raise StripeSignatureError("STRIPE_WEBHOOK_SECRET is not configured.")
    if not sig_header:
        raise StripeSignatureError("Missing Stripe-Signature header.")
    stripe = _stripe_module()
    try:
        event = stripe.Webhook.construct_event(payload_bytes, sig_header, secret)
    except Exception as error:  # noqa: BLE001
        raise StripeSignatureError(f"Stripe webhook signature verification failed: {error}") from error
    if isinstance(event, dict):
        return event
    # Stripe SDK returns a StripeObject; coerce to dict.
    try:
        return dict(event)
    except Exception:  # noqa: BLE001
        # Fall back to attribute access on the object.
        return {
            "id": getattr(event, "id", None),
            "type": getattr(event, "type", None),
            "data": getattr(event, "data", None),
        }


def create_express_account(email: str | None, *, country: str = "US") -> dict[str, Any]:
    """Create a Stripe Connect Express account for a US seller.

    Returns the raw account dict so callers can persist whichever fields they
    care about.
    """
    stripe = _stripe_module()
    kwargs: dict[str, Any] = {
        "type": "express",
        "country": country,
        "capabilities": {
            "card_payments": {"requested": True},
            "transfers": {"requested": True},
        },
    }
    cleaned_email = (email or "").strip()
    if cleaned_email:
        kwargs["email"] = cleaned_email
    account = stripe.Account.create(**kwargs)
    return _ensure_dict(account)


def create_account_link(
    account_id: str,
    *,
    refresh_url: str,
    return_url: str,
) -> dict[str, Any]:
    stripe = _stripe_module()
    link = stripe.AccountLink.create(
        account=account_id,
        refresh_url=refresh_url,
        return_url=return_url,
        type="account_onboarding",
    )
    return _ensure_dict(link)


def fetch_account_status(account_id: str) -> dict[str, Any]:
    """Return a compact account status dict for persistence."""
    stripe = _stripe_module()
    account = stripe.Account.retrieve(account_id)
    account_dict = _ensure_dict(account)
    requirements = account_dict.get("requirements") or {}
    if not isinstance(requirements, dict):
        requirements = _ensure_dict(requirements)
    currently_due = requirements.get("currently_due") or []
    if not isinstance(currently_due, list):
        currently_due = list(currently_due or [])
    return {
        "charges_enabled": bool(account_dict.get("charges_enabled")),
        "payouts_enabled": bool(account_dict.get("payouts_enabled")),
        "requirements_due": [str(item) for item in currently_due],
        "country": str(account_dict.get("country") or "US"),
    }


def create_checkout_session(
    *,
    seller_stripe_account_id: str,
    amount_cents: int,
    fee_cents: int,
    success_url: str,
    cancel_url: str,
    card_name: str,
    image_url: str | None = None,
    metadata: dict[str, Any] | None = None,
    currency_code: str = "USD",
) -> dict[str, Any]:
    """Create a Checkout Session using the destination-charges pattern."""
    stripe = _stripe_module()
    line_item: dict[str, Any] = {
        "price_data": {
            "currency": currency_code.lower(),
            "unit_amount": int(amount_cents),
            "product_data": {
                "name": card_name,
            },
        },
        "quantity": 1,
    }
    if image_url:
        line_item["price_data"]["product_data"]["images"] = [image_url]

    payment_intent_data: dict[str, Any] = {
        "application_fee_amount": int(fee_cents),
        "transfer_data": {"destination": seller_stripe_account_id},
    }

    kwargs: dict[str, Any] = {
        "mode": "payment",
        "line_items": [line_item],
        "success_url": success_url,
        "cancel_url": cancel_url,
        "payment_intent_data": payment_intent_data,
    }
    if metadata:
        kwargs["metadata"] = {str(k): str(v) for k, v in metadata.items()}
        # Mirror metadata onto the PaymentIntent for downstream visibility.
        kwargs["payment_intent_data"]["metadata"] = dict(kwargs["metadata"])
    session = stripe.checkout.Session.create(**kwargs)
    return _ensure_dict(session)


def expire_checkout_session(session_id: str) -> dict[str, Any]:
    stripe = _stripe_module()
    result = stripe.checkout.Session.expire(session_id)
    return _ensure_dict(result)


def _ensure_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    try:
        return dict(value)
    except Exception:  # noqa: BLE001
        # StripeObject usually exposes to_dict_recursive() / to_dict().
        for attr in ("to_dict_recursive", "to_dict"):
            converter = getattr(value, attr, None)
            if callable(converter):
                try:
                    return converter()
                except Exception:  # noqa: BLE001
                    continue
        return {"value": value}
