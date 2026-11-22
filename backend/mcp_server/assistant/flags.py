"""Automatic quality flags per assistant turn, so the owner only reads likely-bad
answers. Pure, deterministic string/shape checks; no LLM, no I/O."""

from __future__ import annotations

import re
from typing import Any

from mcp_server.assistant import length_guard

LONG_ANSWER_WORDS = 90
SLOW_LATENCY_MS = 15_000
EXPENSIVE_COST_USD = 0.005
BAD_STOP_REASONS = frozenset({"refusal", "max_tokens"})

# Canonical order; flag_turn returns codes in this order.
FLAG_CODES = (
    "refusal_or_error",
    "tool_error",
    "round_limit",
    "no_results",
    "no_tiles_for_card_question",
    "game_mismatch",
    "claims_unapplied_filter",
    "currency_leak",
    "wrong_naming",
    "self_correction",
    "mentions_internals",
    "shown_count_mismatch",
    "unnamed_tiles",
    "long_answer",
    "slow",
    "expensive",
)

_NO_RESULTS = re.compile(
    r"\b(?:couldn't find|could not find|can't find|cannot find|didn't find|did not find|no results"
    r"|no matches|doesn't have|does not have|not in the catalog)\b",
    re.IGNORECASE,
)
_SELF_CORRECTION = re.compile(
    r"\b(?:correct my last|I (?:didn't|did not) (?:run|pull))\b", re.IGNORECASE
)
_INTERNALS = re.compile(
    r"\b(?:tools?|tool calls?|search I ran|this chat)\b"
    # Owner 2026-11-21: plumbing phrases ("Ekalight returned no price history").
    r"|\bEkalight\s+(?:returned|found|gave|has\s+no|had\s+no|doesn'?t\s+have|does\s+not\s+have)\b",
    re.IGNORECASE,
)
_CURRENCY = re.compile(r"[¥￥]|\byen\b|\bJPY\b", re.IGNORECASE)
_WISHLIST = re.compile(r"\bwish[\s-]?list", re.IGNORECASE)
_CARD_QUESTION = re.compile(
    r"\b(?:prices?|priced|pricing|worth|values?|cost|how much|cards?|trend(?:s|ing)?|charts?|sell|buy)\b",
    re.IGNORECASE,
)
_CLAIMS_NO_SEALED = re.compile(
    r"\b(?:(?:excluding|excluded|exclude|without|no|skipping|skipped) sealed|sealed (?:products? )?(?:are |is )?excluded"
    r"|singles only|only singles|just singles)\b",
    re.IGNORECASE,
)
_CLAIMS_ENGLISH = re.compile(
    r"\b(?:english[\s-]only|only english|just english|(?:excluding|excluded|exclude|without|no|skipping) japanese)\b",
    re.IGNORECASE,
)
_SEALED_NAME = re.compile(r"\b(?:booster|box|case)\b", re.IGNORECASE)
_BOOSTER_ENERGY = re.compile(r"\bbooster energy\b", re.IGNORECASE)  # a Pokémon trainer card, not sealed

# Question text -> game key; card ids for non-Pokémon games are `<game>~...`.
_GAME_NAMES = (
    ("onepiece", re.compile(r"\bone[\s-]?piece\b", re.IGNORECASE)),
    ("lorcana", re.compile(r"\blorcana\b", re.IGNORECASE)),
    ("riftbound", re.compile(r"\briftbound\b", re.IGNORECASE)),
    ("gundam", re.compile(r"\bgundam\b", re.IGNORECASE)),
    ("pokemon", re.compile(r"\bpok[eé]mon\b", re.IGNORECASE)),
)


def _normalize(text: str) -> str:
    return str(text or "").replace("’", "'").replace("‘", "'")


def card_game(card_id: str) -> str:
    card_id = str(card_id or "")
    return card_id.split("~", 1)[0].lower() if "~" in card_id else "pokemon"


def games_named(question: str) -> set[str]:
    return {game for game, pattern in _GAME_NAMES if pattern.search(question)}


def _is_sealed(card: dict[str, Any]) -> bool:
    if "tcgp-sealed-" in str(card.get("card_id") or ""):
        return True
    for key in ("set", "name"):
        value = _BOOSTER_ENERGY.sub("", str(card.get(key) or ""))
        if _SEALED_NAME.search(value):
            return True
    return False


def _is_japanese(card: dict[str, Any]) -> bool:
    return "_ja-" in str(card.get("card_id") or "") or str(card.get("language") or "").lower() == "japanese"


def _get(turn: Any, name: str, default: Any = None) -> Any:
    if isinstance(turn, dict):
        return turn.get(name, default)
    return getattr(turn, name, default)


def flag_turn(question: str, turn: Any, request: dict[str, Any] | None = None) -> list[str]:
    """Flag codes (FLAG_CODES order) for one answered turn. `turn` is a
    TurnResult (or a dict with the same field names); `request` is the parsed
    request body and is optional."""
    question = _normalize(question)
    text = _normalize(_get(turn, "text", ""))
    status = _get(turn, "status", "ok")
    stop_reason = _get(turn, "stop_reason")
    cards = [card for card in (_get(turn, "cards") or []) if isinstance(card, dict)]
    charts = _get(turn, "charts") or []
    found: set[str] = set()

    if status != "ok" or stop_reason in BAD_STOP_REASONS:
        found.add("refusal_or_error")
    if _get(turn, "tool_errors"):
        found.add("tool_error")
    if _get(turn, "round_limit_hit"):
        found.add("round_limit")
    if _NO_RESULTS.search(text):
        found.add("no_results")
    if status == "ok" and not cards and not charts and not _get(turn, "sets") and _CARD_QUESTION.search(question):
        found.add("no_tiles_for_card_question")
    named = games_named(question)
    if named and any(card_game(card.get("card_id")) not in named for card in cards):
        found.add("game_mismatch")
    if (_CLAIMS_NO_SEALED.search(text) and any(_is_sealed(card) for card in cards)) or (
        _CLAIMS_ENGLISH.search(text) and any(_is_japanese(card) for card in cards)
    ):
        found.add("claims_unapplied_filter")
    if _CURRENCY.search(text):
        found.add("currency_leak")
    if _WISHLIST.search(text):
        found.add("wrong_naming")
    if _SELF_CORRECTION.search(text):
        found.add("self_correction")
    if _INTERNALS.search(text):
        found.add("mentions_internals")
    # Owner 2026-11-21: "Here are the first 20" over 12 tiles; tiles the text never names.
    if cards and not _get(turn, "sets") and any(n != len(cards) for n in length_guard.stated_shown_counts(text)):
        found.add("shown_count_mismatch")
    if (status == "ok" and not _get(turn, "sets") and not _get(turn, "actions")
            and length_guard.unnamed_tiles(cards, text, question)):
        found.add("unnamed_tiles")
    if len(text.split()) > LONG_ANSWER_WORDS:
        found.add("long_answer")
    if int(_get(turn, "latency_ms", 0) or 0) > SLOW_LATENCY_MS:
        found.add("slow")
    if float(_get(turn, "cost_usd", 0.0) or 0.0) > EXPENSIVE_COST_USD:
        found.add("expensive")
    return [code for code in FLAG_CODES if code in found]


