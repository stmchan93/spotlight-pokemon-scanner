"""Word-limit guard for the final answer: the prompt asks for short answers but
the model overshoots on wordy turns, so code enforces the cap after the fact.

One table (WORD_LIMITS) holds every limit; limit_for() picks the turn's kind
from the question and the tools used. Over the cap: one cheap rewrite call
(accepted only if it is shorter, non-empty and keeps every tool-backed number),
else a deterministic trim at a sentence boundary.
"""

from __future__ import annotations

import json
import re
from typing import Any

from mcp_server.assistant.tools import is_collection_value_question, is_movers_question

# Aligned with the system prompt and the eval caps (assistant_eval/cases.yaml).
WORD_LIMITS: dict[str, int] = {
    "default": 80,
    "explanation": 90,  # why / explain / knowledge / should-I
    "price_history": 60,
    "collection_value": 60,  # "what is my (One Piece) collection worth"
    "art_search": 45,
    "no_data": 50,  # a lookup failed or found nothing
    "refusal": 40,  # no tools ran and it isn't a knowledge question
}
REWRITE_MAX_TOKENS = 1024  # room for adaptive thinking at low effort
REWRITE_INSTRUCTION = (
    "Rewrite to at most {limit} words. Keep every number, card name, set, date and the 'not a prediction' "
    "line if present. Same language. No preamble."
)

_WORD = re.compile(r"[^\s*_#>`-]\S*")  # same counting as the eval's word_count
_EXPLANATION = re.compile(
    r"\b(why|explain|how (?:does|do|is|are)|what(?:'s| is| are) (?:a|an|the difference)|difference|should i|vs\.?|versus)\b",
    re.IGNORECASE,
)
_HISTORY = re.compile(r"\b(history|trend|chart|over (?:the )?(?:past|last)|since)\b", re.IGNORECASE)
_NUMBER = re.compile(r"(?<![\w.])\d[\d,]*(?:\.\d+)?")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=\S)")
_KEEP_LINE = re.compile(r"not (?:a )?(?:prediction|forecast)", re.IGNORECASE)
ART_FILTER_KEYS = frozenset({"pokemon", "scene", "weather_time", "activity", "mood", "art_style", "palette", "theme"})


def word_count(text: str) -> int:
    return len(_WORD.findall(str(text or "")))


def limit_for(
    question: str, tools_used: list[str] | set[str], *, no_data: bool = False, art_search: bool = False
) -> int:
    used = set(tools_used or ())
    if no_data:
        return WORD_LIMITS["no_data"]
    if _EXPLANATION.search(question or ""):
        return WORD_LIMITS["explanation"]
    if not used:
        return WORD_LIMITS["refusal"]
    if art_search or "list_facets" in used:
        return WORD_LIMITS["art_search"]
    if "get_price_history" in used and _HISTORY.search(question or ""):
        return WORD_LIMITS["price_history"]
    if is_collection_value_question(question) and not is_movers_question(question):
        return WORD_LIMITS["collection_value"]
    return WORD_LIMITS["default"]


def is_art_search(arguments: Any) -> bool:
    flt = arguments.get("filter") if isinstance(arguments, dict) else None
    return isinstance(flt, dict) and any(flt.get(key) for key in ART_FILTER_KEYS)


def is_empty_result(content: Any, *, is_error: bool) -> bool:
    """A failed lookup, or one whose result lists (results/items/cards/points) are all empty."""
    if is_error:
        return True
    if not isinstance(content, dict):
        return False
    lists = [content[key] for key in ("results", "items", "cards", "points") if isinstance(content.get(key), list)]
    return bool(lists) and not any(lists)


def _as_number(token: str) -> float | None:
    try:
        return round(float(token.replace(",", "")), 2)
    except ValueError:
        return None


def numbers_in(text: str) -> set[float]:
    return {value for value in (_as_number(token) for token in _NUMBER.findall(str(text or ""))) if value is not None}


def tool_numbers(tool_payloads: list[Any]) -> set[float]:
    found: set[float] = set()
    for payload in tool_payloads:
        found |= numbers_in(payload if isinstance(payload, str) else json.dumps(payload, default=str))
    return found


def keeps_numbers(original: str, rewrite: str, backed: set[float]) -> bool:
    """Every number of the original that a tool result backs is still in the rewrite."""
    return (numbers_in(original) & backed) <= numbers_in(rewrite)


def _sentences(paragraph: str) -> list[str]:
    return [part.strip() for part in _SENTENCE_END.split(paragraph) if part.strip()]


def trim_to_limit(text: str, limit: int) -> str:
    """Whole sentences in order until the cap; a 'not a prediction' line is kept.
    A first sentence that alone runs over is cut at a word boundary."""
    paragraphs = [[s for s in _sentences(p)] for p in re.split(r"\n\s*\n|\n", str(text or "")) if p.strip()]
    flat = [(index, sentence) for index, sentences in enumerate(paragraphs) for sentence in sentences]
    if not flat:
        return ""
    must = [item for item in flat[1:] if _KEEP_LINE.search(item[1])]
    budget = limit - sum(word_count(sentence) for _, sentence in must)
    kept: list[tuple[int, str]] = []
    used = 0
    for item in flat:
        if item in must:
            continue
        words = word_count(item[1])
        if used + words > budget:
            break
        kept.append(item)
        used += words
    if not kept:
        tokens = flat[0][1].split()
        cut = " ".join(tokens[: max(1, budget if budget > 0 else limit)]).rstrip(",;:")
        kept = [(flat[0][0], cut + ("" if cut.endswith((".", "!", "?")) else "…"))]
    chosen = sorted(kept + must, key=lambda item: flat.index(item) if item in flat else 0)
    out: list[str] = []
    last_index = None
    for index, sentence in chosen:
        if last_index is None:
            out.append(sentence)
        elif index == last_index:
            out[-1] += " " + sentence
        else:
            out.append(sentence)
        last_index = index
    return "\n\n".join(out)
