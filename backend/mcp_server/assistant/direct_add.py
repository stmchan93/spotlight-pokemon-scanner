"""Direct add (owner review 2026-11-20, decision 2): a fully specified add
("Add two Near Mint Charizard ex 151 #199/165") is written server-side with no
Confirm tap, then offered for Undo. Anything ambiguous falls back to the
propose → Confirm flow.

The write goes through the MCP write tools' CollectionWriteTools (the same
`create_deck_entry` the app calls, selectionSource "assistant", live pricing
off) and its `mcp_write_requests` idempotency ledger, keyed by the turn's
client_message_id + the add's exact params: a retried or replayed turn finds
the stored result instead of adding again.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from catalog_tools import _normalized_variant_label, _variant_match_key

from mcp_server.write_tools import CollectionWriteTools

ADD_NOW_TOOL = "add_to_collection_now"
UNDO_WINDOW = timedelta(hours=24)
REQUEST_PREFIX = "assistant:"

# What the user must have typed for the condition to count as given, not inferred.
_CONDITION_WORDS = {
    "NM": r"near[\s-]*mint|nm|mint",
    "LP": r"lightly[\s-]*played|light[\s-]*play(?:ed)?|lp",
    "MP": r"moderately[\s-]*played|mp",
    "HP": r"heavily[\s-]*played|hp",
    "DMG": r"damaged|dmg",
}


@dataclass
class TurnWrites:
    """Per-turn state for direct adds: one fully specified card per turn."""

    client_message_id: str | None
    question: str
    executed: int = 0
    batch: bool = False
    # Cards attached to this message (scan tray / photo): check_deal's default cards.
    context_card_ids: tuple[str, ...] = ()

    def plan_round(self, tool_names: list[str]) -> None:
        # Several adds in one round = a batch ("add the cards in my tray").
        if tool_names.count(ADD_NOW_TOOL) > 1:
            self.batch = True

    def blocked_reason(self) -> str | None:
        if not self.client_message_id:
            return "direct add unavailable"
        if self.batch or self.executed:
            return "more than one card in this request"
        return None


def condition_stated(question: str, condition: str) -> bool:
    pattern = _CONDITION_WORDS.get(condition)
    return bool(pattern and re.search(rf"\b(?:{pattern})\b", question, re.IGNORECASE))


def grade_stated(question: str, grader: str, grade: str) -> bool:
    has_grader = re.search(rf"\b{re.escape(grader)}\b", question, re.IGNORECASE)
    has_grade = re.search(rf"(?<![\d.]){re.escape(grade)}(?![\d.])", question)
    return bool(has_grader and has_grade)


def request_key(client_message_id: str, params: dict[str, Any]) -> str:
    identity = {
        key: params.get(key) for key in ("card_id", "quantity", "condition", "variant_name", "grader", "grade")
    }
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]
    return f"{REQUEST_PREFIX}{client_message_id}:{digest}"


def action_id_for(key: str) -> str:
    # Stable per idempotency key, so a replayed turn returns the same action id.
    return "act_" + hashlib.sha256(key.encode()).hexdigest()[:24]


def resolve_variant(service: Any, card_id: str, variant_name: str | None) -> tuple[str | None, str | None]:
    """(variant to store, fallback reason). Several printings + none named, or a
    name that matches none of them, is ambiguous."""
    try:
        printings = [str(label) for label in service._raw_history_variants(card_id) if str(label).strip()]
    except Exception:  # noqa: BLE001 - no price data means nothing to disambiguate
        printings = []
    if not variant_name:
        if len(printings) > 1:
            return None, f"this card has {len(printings)} printings ({', '.join(printings[:4])}); ask which one"
        return None, None
    if not printings:
        return variant_name, None
    wanted = _variant_match_key(_normalized_variant_label(variant_name))
    for label in printings:
        if _variant_match_key(_normalized_variant_label(label)) == wanted:
            return label, None
    return None, f"no printing named {variant_name!r} (printings: {', '.join(printings[:4])})"


class UndoUnavailable(ValueError):
    pass


def undo_expired(action: dict[str, Any], now: datetime | None = None) -> bool:
    stamp = str((action.get("undo") or {}).get("expires_at") or "")
    try:
        expires = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return True
    return (now or datetime.now(timezone.utc)) >= expires


def expires_at(now: datetime | None = None) -> str:
    moment = (now or datetime.now(timezone.utc)) + UNDO_WINDOW
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


class DirectAdder:
    """Sync; callers hold `service.request_identity_context` for the owner."""

    def __init__(self, service: Any) -> None:
        self.service = service
        self.writer = CollectionWriteTools(service)

    def add(self, owner_user_id: str, *, key: str, params: dict[str, Any]) -> dict[str, Any]:
        return self.writer.add_to_collection(
            owner_user_id,
            card_id=params["card_id"],
            request_id=key,
            quantity=params["quantity"],
            condition=params["condition"],
            variant_name=params["variant_name"],
            grader=params["grader"],
            grade=params["grade"],
        )

    def total_owned(self, owner_user_id: str, card_id: str) -> int:
        row = self.service.connection.execute(
            "SELECT COALESCE(SUM(quantity), 0) FROM deck_entries WHERE owner_user_id = ? AND card_id = ? AND quantity > 0",
            (owner_user_id, card_id),
        ).fetchone()
        return int(row[0] or 0)

    def undo(self, owner_user_id: str, action: dict[str, Any]) -> None:
        """Take back exactly the copies this action added; a holding left at 0
        is removed (the same quantity call the app's edit sheet makes)."""
        undo = action.get("undo") or {}
        entry_id = str(undo.get("deck_entry_id") or "")
        added = int(undo.get("quantity_added") or 0)
        row = self.service.connection.execute(
            "SELECT quantity FROM deck_entries WHERE id = ? AND owner_user_id = ? AND quantity > 0",
            (entry_id, owner_user_id),
        ).fetchone()
        if row is None or added < 1:
            raise UndoUnavailable("That card is no longer in your collection.")
        remaining = max(0, int(row["quantity"] or 0) - added)
        self.service.set_deck_entry_quantity({"deckEntryID": entry_id, "quantity": remaining})
