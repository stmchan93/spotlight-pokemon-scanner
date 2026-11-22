"""Pick-a-printing replies (owner decision L023, 2026-11-21).

"Add Charizard ex to my collection" matches several printings. Instead of asking
the user to type set, number, quantity and condition, the reply's tiles become
choices: the app sends a follow-up for the tapped card_id, which goes through the
normal propose → Confirm (or direct add → Undo) flow.

Decided in code, not by the model: a write-intent question + 2+ candidate cards
from this turn's lookups + no write action in the reply. The reply then carries
`choice` (older app builds ignore it and show plain tiles) and the tap hint.

Owner 2026-11-22: any other answer that asks the user to pick one of this turn's
candidates ("Which Lucario do you mean?", "Tap a card below to pick it" in a trade,
value or compare) is a choice too, with intent "pick": the app sends "I mean <card>"
with that card_id and the conversation carries on for exactly that card.
"""

from __future__ import annotations

import re
from typing import Any

from mcp_server.assistant import length_guard
from mcp_server.assistant.direct_add import condition_stated

TAP_HINT = "Tap a card below to pick the right one."
KIND = "pick_printing"
PICK = "pick"  # intent of a choice that isn't an add/update: the tap just names the card
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
    asks_to_pick: bool = False,
) -> dict[str, Any] | None:
    """The `choice` field for a reply whose tiles are the candidate printings, else None.
    asks_to_pick: the answer asks the user which card they mean (any intent)."""
    intent = write_intent(question)
    if actions or (intent is None and not asks_to_pick):
        return None
    candidates = {str(card.get("card_id")) for card in cards if str(card.get("card_id")) in turn_card_ids}
    if len(candidates) < 2:
        return None
    if intent is None:
        return {
            "kind": KIND,
            "intent": PICK,
            "quantity": None,
            "condition": None,
            "grader": None,
            "grade": None,
            "quantity_stated": False,
            "condition_stated": False,
        }
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


# "tell me the quantity and condition if they're not 1 copy in Near Mint": an add defaults to
# 1 copy in Near Mint, editable on the Confirm card, so a pick-a-printing reply asks for nothing else.
_DETAIL_ASK = re.compile(
    r"(?:,?\s*(?:and|then|also|plus)\s+|,\s*|;\s*)?"
    r"\b(?:(?:please\s+)?(?:tell|let)\s+me(?:\s+know)?|what(?:'s|\s+is|\s+are)?|how\s+many|which|confirm|share|give\s+me"
    r"|(?:i'?ll|i\s+will|i)\s+(?:also\s+)?need|do\s+you\s+(?:want|have))\b"
    r"[^.!?]*\b(?:quantity|quantities|condition|conditions|cop(?:y|ies)|how\s+many|near\s+mint|grades?)\b[^.!?]*",
    re.IGNORECASE,
)
_TAP = re.compile(r"\btap a card\b", re.IGNORECASE)


def _without_detail_ask(sentence: str) -> str:
    match = _DETAIL_ASK.search(sentence)
    if match is None:
        return sentence
    if not _TAP.search(sentence[: match.start()]):
        return ""  # the whole sentence is the extra ask
    kept = sentence[: match.start()].rstrip(" ,;:")
    if length_guard.ends_mid_thought(kept):
        return TAP_HINT
    return kept + (sentence.rstrip()[-1:] if sentence.rstrip()[-1:] in ".!?" else ".")


def strip_detail_asks(text: str, choice: dict[str, Any] | None) -> str:
    """Owner 2026-11-22: a pick-a-printing reply for an add asks only which printing (the tap hint):
    no ask for quantity or condition, which default to 1 copy in Near Mint on the Confirm card."""
    if not text or not choice or choice.get("intent") != "add":
        return text
    paragraphs = [
        " ".join(part for part in (_without_detail_ask(s) for s in length_guard._sentences(p)) if part)
        for p in length_guard._paragraphs(text)
    ]
    out = length_guard._join([p for p in paragraphs if p.strip()])
    return out or text
