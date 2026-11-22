"""Pick-a-printing replies (owner decision L023, 2026-11-21).

"Add Charizard ex to my collection" matches several printings. Instead of asking
the user to type set, number, quantity and condition, the reply's tiles become
choices: the app sends a follow-up for the tapped card_id, which goes through the
normal propose → Confirm (or direct add → Undo) flow.

Decided in code, not by the model: a write-intent question + 2+ candidate cards
from this turn's lookups + no write action in the reply. The reply then carries
`choice` (older app builds ignore it and show plain tiles) and the tap hint.
"""

from __future__ import annotations

import re
from typing import Any

from mcp_server.assistant.direct_add import condition_stated

TAP_HINT = "Tap a card below to pick the right one."
KIND = "pick_printing"
CONDITION_CODES = ("NM", "LP", "MP", "HP", "DMG")

_ADD = re.compile(r"^\W*(?:(?:please|pls|can you|could you|would you|i want to|i'd like to|help me)\s+)*(?:add|put|log)\b"
                  r"|\b(?:add|put|log)\b.*\b(?:collection|binder|portfolio|inventory)\b", re.IGNORECASE)
_UPDATE = re.compile(r"\b(?:change|update|edit|set|mark|make|fix)\b.*\b(?:my|quantity|condition|cop(?:y|ies)|holding)\b",
                     re.IGNORECASE)
# "How do I add…" is a how-to, "add to my Watchlist" is a watch, "add these/all" is a batch.
_NOT_A_SINGLE_WRITE = re.compile(
    r"\bhow (?:do|can|would|should) i\b|\bwatch\s*list\b|\bwish\s*list\b|\bwatch\b|\balert\b"
    r"|\b(?:all|these|those|both|every|each|tray)\b",
    re.IGNORECASE,
)
_NUMBER_WORDS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
                 "eight": 8, "nine": 9, "ten": 10}
_COUNT = r"(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten)"
_QUANTITY_PATTERNS = (
    re.compile(rf"\b{_COUNT}\s+(?:more\s+)?cop(?:y|ies)\b", re.IGNORECASE),
    re.compile(r"(?:^|\s)[x×]\s*(\d{1,3})\b|\b(\d{1,3})\s*[x×](?:\s|$)", re.IGNORECASE),
    # "add 2 Charizard ex" — not "add 228/197".
    re.compile(r"\b(?:add|put|log)\s+(\d{1,2}|an?|one|two|three|four|five|six|seven|eight|nine|ten)\b(?!\s*[/#])",
               re.IGNORECASE),
    re.compile(r"\b(?:quantity|count)\s+(?:to\s+)?(\d{1,3})\b|\bto\s+(\d{1,3})\s+cop", re.IGNORECASE),
)
_SLAB = re.compile(r"\b(PSA|BGS|CGC|SGC|TAG)\s*(10|[1-9](?:\.5)?)\b", re.IGNORECASE)


def write_intent(question: str) -> str | None:
    q = question or ""
    if _NOT_A_SINGLE_WRITE.search(q):
        return None
    if _ADD.search(q):
        return "add"
    if _UPDATE.search(q):
        return "update"
    return None


def stated_quantity(question: str) -> int | None:
    for pattern in _QUANTITY_PATTERNS:
        match = pattern.search(question or "")
        if not match:
            continue
        word = next(group for group in match.groups() if group).casefold()
        count = int(word) if word.isdigit() else _NUMBER_WORDS.get(word)
        if count and count >= 1:
            return count
    return None


def stated_condition(question: str) -> str | None:
    # Most specific first: "mint" alone counts as NM, but "lightly played" is LP.
    for code in ("LP", "MP", "HP", "DMG", "NM"):
        if condition_stated(question or "", code):
            return code
    return None


def pick_printing_choice(
    question: str,
    *,
    cards: list[dict[str, Any]],
    actions: list[dict[str, Any]],
    turn_card_ids: set[str],
) -> dict[str, Any] | None:
    """The `choice` field for a reply whose tiles are the candidate printings, else None."""
    intent = write_intent(question)
    if intent is None or actions:
        return None
    candidates = {str(card.get("card_id")) for card in cards if str(card.get("card_id")) in turn_card_ids}
    if len(candidates) < 2:
        return None
    slab = _SLAB.search(question or "")
    quantity = stated_quantity(question)
    condition = None if slab else stated_condition(question)
    if intent == "add":
        return {
            "kind": KIND,
            "intent": intent,
            "quantity": quantity or 1,
            "condition": None if slab else condition or "NM",
            "grader": slab.group(1).upper() if slab else None,
            "grade": slab.group(2) if slab else None,
            "quantity_stated": quantity is not None,
            "condition_stated": condition is not None or slab is not None,
        }
    return {
        "kind": KIND,
        "intent": intent,
        "quantity": quantity,
        "condition": condition,
        "grader": None,
        "grade": None,
        "quantity_stated": quantity is not None,
        "condition_stated": condition is not None,
    }


def with_tap_hint(text: str) -> str:
    if "tap a card" in (text or "").casefold():
        return text
    return f"{text.rstrip()}\n\n{TAP_HINT}" if text and text.strip() else TAP_HINT
