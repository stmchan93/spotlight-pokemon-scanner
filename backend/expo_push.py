"""Expo push transport: plain HTTP to ``exp.host``, no SDK.

Scope / seam
------------
This module owns DELIVERY only: assemble messages, batch them, POST them, read
the tickets back, and say which tokens are dead. It knows nothing about SQLite,
the deal-scan job, or what makes a listing a deal — callers hand it plain data
and a ``claim`` callback and get a structured result back.

Design rules, all deliberate:

- **Never raises into the caller.** Every entry point returns a ``PushResult``
  or ``ReceiptResult``; a transport blowing up becomes ``failed`` + an error
  string. A push failure must never break the scan job that produced the alert.
- **At-most-once, structurally.** Nothing is dispatched that has not first been
  claimed: ``claim(reference_id)`` must persist ``push_sent_at`` AND COMMIT,
  returning True only when this process won the claim. It is a required
  argument precisely so the ordering cannot be forgotten — a crash between the
  claim and the POST loses a push (recoverable, invisible) instead of sending a
  duplicate (the failure a user actually notices).
- **Two lanes, separated in the signature.** ``send_deal_alert_pushes`` takes
  user notification prefs; ``send_ops_alert_pushes`` has no prefs parameter at
  all, because an operator alarm is not a user preference. They share the
  transport and nothing else.
- **No global state.** Pure functions plus an injectable ``transport``; the
  tests never touch the network.

Expo's wire contract used here:

- ``POST /--/api/v2/push/send`` with a JSON ARRAY of at most 100 messages.
  Response ``{"data": [ticket, ...]}`` positionally aligned with the request.
  A ticket is ``{"status": "ok", "id": ...}`` or ``{"status": "error",
  "message": ..., "details": {"error": "DeviceNotRegistered"}}``.
- ``POST /--/api/v2/push/getReceipts`` with ``{"ids": [...]}``. Response
  ``{"data": {receipt_id: {"status": ...}}}``. A ticket is an accepted-for-
  delivery handle, NOT a delivery: the receipt is where a token discovered dead
  hours later shows up, which is why the daily job checks the previous run's
  ticket ids before it sends new ones.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.request import Request, urlopen

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"

# Expo's documented per-request limits.
MAX_MESSAGES_PER_REQUEST = 100
MAX_RECEIPT_IDS_PER_REQUEST = 1000

DEFAULT_TIMEOUT_SECONDS = 15.0

# Deep links. The alert id rides along so a tap can mark the alert tapped.
WATCHLIST_DEEP_LINK = "/wishlist"
OPS_DEEP_LINK = "/ops"

DEAL_PUSH_TITLE = "Deal on your watchlist"
OPS_PUSH_TITLE = "Spotlight ops"

# Android notification channels (created app-side; named here so both lanes
# stay separable in the OS settings too).
DEAL_CHANNEL_ID = "deals"
OPS_CHANNEL_ID = "ops"

DATA_TYPE_DEAL_ALERT = "deal_alert"
DATA_TYPE_OPS_ALERT = "ops_alert"

# Skip reasons. Named constants so callers can log/assert on them instead of
# matching prose.
SKIP_NO_SIGNALS = "no_signals"
SKIP_NO_TOKENS = "no_tokens"
SKIP_PREFS_OFF = "prefs_off"
SKIP_ALREADY_SENT = "already_sent"
SKIP_INVALID_TOKEN = "invalid_token"

# Expo's "this token is dead, stop using it" error code. The only ticket/receipt
# error that justifies revoking a token — everything else is transient.
ERROR_DEVICE_NOT_REGISTERED = "DeviceNotRegistered"

OPS_PUSH_USER_IDS_ENV = "SPOTLIGHT_OPS_PUSH_USER_IDS"

_EXPO_TOKEN_RE = re.compile(r"^Exp(?:o|onent)PushToken\[[^\]]+\]$")

# (url, json_payload) -> decoded json response. Injected in tests.
Transport = Callable[[str, Any], Any]


# --- messages ----------------------------------------------------------------


@dataclass(frozen=True)
class PushMessage:
    """One Expo message. ``reference_id`` is ours, not Expo's: it is echoed on
    the ticket so the caller can persist ticket ids against the right row."""

    to: str
    title: str
    body: str
    data: dict[str, Any] = field(default_factory=dict)
    sound: str | None = "default"
    channel_id: str | None = None
    priority: str = "default"
    reference_id: str | None = None

    def as_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "to": self.to,
            "title": self.title,
            "body": self.body,
            "priority": self.priority,
        }
        if self.data:
            payload["data"] = dict(self.data)
        if self.sound:
            payload["sound"] = self.sound
        if self.channel_id:
            payload["channelId"] = self.channel_id
        return payload


@dataclass(frozen=True)
class DealAlertPush:
    """A ``deal_alerts`` row, flattened to what the copy needs. The caller joins
    ``cards`` for the name; this module never touches SQLite."""

    alert_id: str
    owner_user_id: str
    card_name: str
    total_cents: int
    discount_pct: float | None = None
    card_id: str | None = None


@dataclass(frozen=True)
class OpsAlertPush:
    """An ``ops_alerts`` row. No owner: ops alerts go to configured admin user
    ids, never to whoever tripped the wire."""

    ops_alert_id: str
    headline: str
    kind: str | None = None
    stage: str | None = None
    detail: dict[str, Any] | None = None


@dataclass(frozen=True)
class PushTicket:
    token: str
    status: str  # "ok" | "error"
    ticket_id: str | None = None
    error_code: str | None = None
    message: str | None = None
    reference_id: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok"

    def as_dict(self) -> dict[str, Any]:
        return {
            "token": self.token,
            "status": self.status,
            "ticketId": self.ticket_id,
            "errorCode": self.error_code,
            "message": self.message,
            "referenceId": self.reference_id,
        }


@dataclass(frozen=True)
class PushResult:
    sent: int = 0
    failed: int = 0
    skipped: int = 0
    skipped_by_reason: dict[str, int] = field(default_factory=dict)
    tickets: tuple[PushTicket, ...] = ()
    tokens_to_revoke: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()

    @property
    def ticket_ids(self) -> tuple[str, ...]:
        return tuple(t.ticket_id for t in self.tickets if t.ticket_id)

    def as_dict(self) -> dict[str, Any]:
        return {
            "sent": self.sent,
            "failed": self.failed,
            "skipped": self.skipped,
            "skippedByReason": dict(self.skipped_by_reason),
            "tickets": [t.as_dict() for t in self.tickets],
            "tokensToRevoke": list(self.tokens_to_revoke),
            "errors": list(self.errors),
        }


@dataclass(frozen=True)
class ReceiptResult:
    checked: int = 0
    ok: int = 0
    failed: int = 0
    pending: tuple[str, ...] = ()
    tokens_to_revoke: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "checked": self.checked,
            "ok": self.ok,
            "failed": self.failed,
            "pending": list(self.pending),
            "tokensToRevoke": list(self.tokens_to_revoke),
            "errors": list(self.errors),
        }


# --- small helpers -----------------------------------------------------------


def is_expo_push_token(value: Any) -> bool:
    """``ExponentPushToken[...]`` / ``ExpoPushToken[...]`` only."""
    return isinstance(value, str) and bool(_EXPO_TOKEN_RE.match(value.strip()))


def format_usd_cents(cents: int | None) -> str:
    """``3400 -> "$34"``, ``3450 -> "$34.50"``. Whole dollars read better in a
    notification body than a trailing ``.00``."""
    amount = int(cents or 0)
    if amount % 100 == 0:
        return f"${amount // 100:,}"
    return f"${amount / 100:,.2f}"


def deal_push_body(
    card_name: str, total_cents: int, discount_pct: float | None
) -> str:
    """``"Mega Starmie ex — $34, 26% under"``."""
    name = (card_name or "").strip() or "A watched card"
    price = format_usd_cents(total_cents)
    pct = int(round(float(discount_pct))) if discount_pct is not None else 0
    if pct <= 0:
        return f"{name} — {price}"
    return f"{name} — {price}, {pct}% under"


def ops_push_body(alert: OpsAlertPush) -> str:
    headline = (alert.headline or "").strip() or (alert.kind or "ops alert")
    if alert.stage:
        return f"{headline} ({alert.stage})"
    return headline


def build_deal_message(token: str, push: DealAlertPush) -> PushMessage:
    return PushMessage(
        to=token,
        title=DEAL_PUSH_TITLE,
        body=deal_push_body(push.card_name, push.total_cents, push.discount_pct),
        data={
            "type": DATA_TYPE_DEAL_ALERT,
            "url": WATCHLIST_DEEP_LINK,
            "alertId": push.alert_id,
            "cardId": push.card_id,
        },
        channel_id=DEAL_CHANNEL_ID,
        reference_id=push.alert_id,
    )


def build_ops_message(token: str, alert: OpsAlertPush) -> PushMessage:
    data: dict[str, Any] = {
        "type": DATA_TYPE_OPS_ALERT,
        "url": OPS_DEEP_LINK,
        "opsAlertId": alert.ops_alert_id,
        "kind": alert.kind,
        "stage": alert.stage,
    }
    if alert.detail:
        data["detail"] = dict(alert.detail)
    return PushMessage(
        to=token,
        title=OPS_PUSH_TITLE,
        body=ops_push_body(alert),
        data=data,
        channel_id=OPS_CHANNEL_ID,
        priority="high",
        reference_id=alert.ops_alert_id,
    )


def chunk_messages(
    messages: Sequence[PushMessage], size: int = MAX_MESSAGES_PER_REQUEST
) -> list[list[PushMessage]]:
    """Expo accepts at most 100 messages per request."""
    limit = max(1, min(int(size), MAX_MESSAGES_PER_REQUEST))
    return [list(messages[i : i + limit]) for i in range(0, len(messages), limit)]


def ops_admin_user_ids(raw: str | None = None) -> tuple[str, ...]:
    """Admin user ids for the ops lane, comma-separated. Reads
    ``SPOTLIGHT_OPS_PUSH_USER_IDS`` when no value is passed."""
    value = os.environ.get(OPS_PUSH_USER_IDS_ENV, "") if raw is None else raw
    return tuple(part.strip() for part in str(value or "").split(",") if part.strip())


def prefs_allow_deal_push(
    prefs_by_owner: Mapping[str, Any] | None, owner_user_id: str
) -> bool:
    """Absent row = defaults ON (the plan's contract). A row is either a bool or
    a dict carrying ``deal_alerts_enabled``."""
    if not prefs_by_owner:
        return True
    if owner_user_id not in prefs_by_owner:
        return True
    value = prefs_by_owner[owner_user_id]
    if isinstance(value, Mapping):
        value = value.get("deal_alerts_enabled", value.get("dealAlertsEnabled", True))
    if value is None:
        return True
    return bool(value)


def _live_tokens(tokens: Iterable[str] | None) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Split into (usable, malformed). Malformed tokens are revocation
    candidates: Expo would only reject them on every future run."""
    usable: list[str] = []
    bad: list[str] = []
    for token in tokens or ():
        candidate = str(token or "").strip()
        if not candidate:
            continue
        (usable if is_expo_push_token(candidate) else bad).append(candidate)
    return tuple(dict.fromkeys(usable)), tuple(dict.fromkeys(bad))


def _default_transport(timeout_seconds: float) -> Transport:
    def _post(url: str, payload: Any) -> Any:
        body = json.dumps(payload).encode("utf-8")
        request = Request(url, data=body, method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "application/json")
        request.add_header("Accept-Encoding", "identity")
        with urlopen(request, timeout=timeout_seconds) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return json.loads(response.read().decode(charset, errors="replace") or "{}")

    return _post


# --- dispatch ----------------------------------------------------------------


def _ticket_from_entry(entry: Any, message: PushMessage) -> PushTicket:
    if not isinstance(entry, Mapping):
        return PushTicket(
            token=message.to,
            status="error",
            message="Malformed ticket",
            reference_id=message.reference_id,
        )
    status = str(entry.get("status") or "")
    if status == "ok":
        return PushTicket(
            token=message.to,
            status="ok",
            ticket_id=(str(entry["id"]) if entry.get("id") else None),
            reference_id=message.reference_id,
        )
    details = entry.get("details")
    error_code = None
    if isinstance(details, Mapping) and details.get("error"):
        error_code = str(details["error"])
    return PushTicket(
        token=message.to,
        status="error",
        error_code=error_code,
        message=str(entry.get("message") or "") or None,
        reference_id=message.reference_id,
    )


def send_messages(
    messages: Sequence[PushMessage],
    *,
    transport: Transport | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> PushResult:
    """POST already-assembled messages in <=100-message batches. Never raises:
    a transport exception fails only its own chunk, and the remaining chunks
    still go out."""
    if not messages:
        return PushResult()
    post = transport or _default_transport(timeout_seconds)
    sent = 0
    failed = 0
    tickets: list[PushTicket] = []
    revoke: list[str] = []
    errors: list[str] = []

    for chunk in chunk_messages(messages):
        payload = [message.as_payload() for message in chunk]
        try:
            response = post(EXPO_PUSH_URL, payload)
        except Exception as exc:  # transport failure is data, not an exception
            failed += len(chunk)
            errors.append(f"{type(exc).__name__}: {exc}")
            continue

        entries: list[Any] = []
        if isinstance(response, Mapping):
            data = response.get("data")
            if isinstance(data, list):
                entries = data
            top_level = response.get("errors")
            if isinstance(top_level, list):
                for item in top_level:
                    if isinstance(item, Mapping):
                        errors.append(str(item.get("message") or item))
                    else:
                        errors.append(str(item))
        elif isinstance(response, list):
            entries = response

        if not entries:
            failed += len(chunk)
            if not errors:
                errors.append("Expo returned no tickets")
            continue

        for index, message in enumerate(chunk):
            if index >= len(entries):
                failed += 1
                errors.append(f"Missing ticket for {message.to}")
                continue
            ticket = _ticket_from_entry(entries[index], message)
            tickets.append(ticket)
            if ticket.ok:
                sent += 1
                continue
            failed += 1
            if ticket.error_code == ERROR_DEVICE_NOT_REGISTERED:
                revoke.append(ticket.token)

    return PushResult(
        sent=sent,
        failed=failed,
        tickets=tuple(tickets),
        tokens_to_revoke=tuple(dict.fromkeys(revoke)),
        errors=tuple(errors),
    )


def _merge(base: PushResult, dispatched: PushResult) -> PushResult:
    return PushResult(
        sent=dispatched.sent,
        failed=base.failed + dispatched.failed,
        skipped=base.skipped,
        skipped_by_reason=dict(base.skipped_by_reason),
        tickets=dispatched.tickets,
        tokens_to_revoke=tuple(
            dict.fromkeys(base.tokens_to_revoke + dispatched.tokens_to_revoke)
        ),
        errors=base.errors + dispatched.errors,
    )


def send_deal_alert_pushes(
    pushes: Sequence[DealAlertPush],
    *,
    tokens_by_owner: Mapping[str, Sequence[str]],
    claim: Callable[[str], bool],
    prefs_by_owner: Mapping[str, Any] | None = None,
    transport: Transport | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> PushResult:
    """USER lane: one push per (alert, live token), gated on notification prefs.

    ``claim(alert_id)`` MUST set ``push_sent_at`` and COMMIT before returning
    True, and return False when the row was already claimed. It is called
    exactly once per alert, before any message for that alert is assembled — so
    a crash anywhere later cannot produce a second push.

    Nothing is dispatched for an empty ``pushes`` list: a quiet week is silent.
    """
    skips: dict[str, int] = {}
    skipped = 0
    revoke: list[str] = []

    def _skip(reason: str, count: int = 1) -> None:
        nonlocal skipped
        skips[reason] = skips.get(reason, 0) + count
        skipped += count

    if not pushes:
        _skip(SKIP_NO_SIGNALS)
        return PushResult(skipped=skipped, skipped_by_reason=skips)

    messages: list[PushMessage] = []
    for push in pushes:
        if not prefs_allow_deal_push(prefs_by_owner, push.owner_user_id):
            _skip(SKIP_PREFS_OFF)
            continue
        tokens, malformed = _live_tokens(tokens_by_owner.get(push.owner_user_id))
        if malformed:
            revoke.extend(malformed)
            _skip(SKIP_INVALID_TOKEN, len(malformed))
        if not tokens:
            _skip(SKIP_NO_TOKENS)
            continue
        # CLAIM BEFORE ASSEMBLY: push_sent_at is persisted and committed here.
        if not claim(push.alert_id):
            _skip(SKIP_ALREADY_SENT)
            continue
        messages.extend(build_deal_message(token, push) for token in tokens)

    base = PushResult(
        skipped=skipped,
        skipped_by_reason=skips,
        tokens_to_revoke=tuple(dict.fromkeys(revoke)),
    )
    if not messages:
        return base
    return _merge(
        base,
        send_messages(messages, transport=transport, timeout_seconds=timeout_seconds),
    )


def send_ops_alert_pushes(
    alerts: Sequence[OpsAlertPush],
    *,
    admin_tokens: Sequence[str],
    claim: Callable[[str], bool],
    transport: Transport | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> PushResult:
    """OPS lane: operator tripwires to configured admin devices.

    There is deliberately NO prefs parameter. An operator alarm is not a user
    preference, and ops alerts must never read ``user_notification_prefs`` or
    enter the user feed. ``claim(ops_alert_id)`` carries the same
    set-``sent_at``-then-dispatch contract as the user lane.
    """
    skips: dict[str, int] = {}
    skipped = 0

    def _skip(reason: str, count: int = 1) -> None:
        nonlocal skipped
        skips[reason] = skips.get(reason, 0) + count
        skipped += count

    if not alerts:
        _skip(SKIP_NO_SIGNALS)
        return PushResult(skipped=skipped, skipped_by_reason=skips)

    tokens, malformed = _live_tokens(admin_tokens)
    if malformed:
        _skip(SKIP_INVALID_TOKEN, len(malformed))
    if not tokens:
        _skip(SKIP_NO_TOKENS, len(alerts))
        return PushResult(
            skipped=skipped,
            skipped_by_reason=skips,
            tokens_to_revoke=tuple(malformed),
        )

    messages: list[PushMessage] = []
    for alert in alerts:
        if not claim(alert.ops_alert_id):
            _skip(SKIP_ALREADY_SENT)
            continue
        messages.extend(build_ops_message(token, alert) for token in tokens)

    base = PushResult(
        skipped=skipped, skipped_by_reason=skips, tokens_to_revoke=tuple(malformed)
    )
    if not messages:
        return base
    return _merge(
        base,
        send_messages(messages, transport=transport, timeout_seconds=timeout_seconds),
    )


# --- receipts ----------------------------------------------------------------


def chunk_receipt_ids(
    receipt_ids: Sequence[str], size: int = MAX_RECEIPT_IDS_PER_REQUEST
) -> list[list[str]]:
    limit = max(1, min(int(size), MAX_RECEIPT_IDS_PER_REQUEST))
    ids = [str(value) for value in receipt_ids if value]
    return [ids[i : i + limit] for i in range(0, len(ids), limit)]


def check_receipts(
    receipt_ids: Sequence[str],
    *,
    tokens_by_receipt_id: Mapping[str, str] | None = None,
    transport: Transport | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> ReceiptResult:
    """Check the PREVIOUS run's tickets. A ticket only means Expo accepted the
    message; the receipt is where a token that died in between shows up, so this
    is the second half of token hygiene. Never raises."""
    chunks = chunk_receipt_ids(receipt_ids)
    if not chunks:
        return ReceiptResult()
    post = transport or _default_transport(timeout_seconds)
    lookup = dict(tokens_by_receipt_id or {})
    checked = 0
    ok = 0
    failed = 0
    pending: list[str] = []
    revoke: list[str] = []
    errors: list[str] = []

    for chunk in chunks:
        try:
            response = post(EXPO_RECEIPTS_URL, {"ids": list(chunk)})
        except Exception as exc:
            errors.append(f"{type(exc).__name__}: {exc}")
            pending.extend(chunk)
            continue

        data: Any = None
        if isinstance(response, Mapping):
            data = response.get("data")
            top_level = response.get("errors")
            if isinstance(top_level, list):
                errors.extend(
                    str(item.get("message") or item)
                    if isinstance(item, Mapping)
                    else str(item)
                    for item in top_level
                )
        if not isinstance(data, Mapping):
            pending.extend(chunk)
            if not errors:
                errors.append("Expo returned no receipts")
            continue

        for receipt_id in chunk:
            entry = data.get(receipt_id)
            if not isinstance(entry, Mapping):
                # Not ready yet; Expo keeps receipts ~24h, so retry next run.
                pending.append(receipt_id)
                continue
            checked += 1
            if str(entry.get("status") or "") == "ok":
                ok += 1
                continue
            failed += 1
            details = entry.get("details")
            error_code = (
                str(details.get("error"))
                if isinstance(details, Mapping) and details.get("error")
                else None
            )
            message = str(entry.get("message") or "") or None
            if message:
                errors.append(message)
            if error_code == ERROR_DEVICE_NOT_REGISTERED:
                token = lookup.get(receipt_id)
                if token:
                    revoke.append(token)

    return ReceiptResult(
        checked=checked,
        ok=ok,
        failed=failed,
        pending=tuple(dict.fromkeys(pending)),
        tokens_to_revoke=tuple(dict.fromkeys(revoke)),
        errors=tuple(errors),
    )
