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
    # "only singles, not sealed": two SHORT sentences; long compound pairs read as three.
    "narrowing": 40,
}
SENTENCE_LIMITS: dict[str, int] = {"narrowing": 2, "refusal": 2, "art_search": 2}
REWRITE_MAX_TOKENS = 1024  # room for adaptive thinking at low effort
REWRITE_INSTRUCTION = (
    "Rewrite to at most {limit} words{sentences}. Keep every number, card name, set, date and the 'not a prediction' "
    "line if present. Same language. No preamble."
)

NO_INTERNAL_INSTRUCTION = "Do not mention tags, searches, tools, filters or how results were found."
REWRITE_INTERNAL_ONLY = (
    "Rewrite this answer with the same facts and about the same length. Keep every number, card name, set, date "
    "and the 'not a prediction' line if present. Same language. No preamble. " + NO_INTERNAL_INSTRUCTION
)
# Internal mechanics the user shouldn't hear about; card names ("TAG TEAM", "Tool Scrapper") are masked first.
_INTERNAL = re.compile(
    r"\btag(?:s|ged|ging)?\b|\bsearch(?:es)?\b|\bmatched\b|\bmatching\b|\btools?\b|\bfilter(?:ed|s)?\s+by\b",
    re.IGNORECASE,
)
_ALWAYS_MASKED = re.compile(r"\btag\s+team\b|\bpok[eé]mon\s+tools?\b", re.IGNORECASE)

_WORD = re.compile(r"[^\s*_#>`-]\S*")  # same counting as the eval's word_count
_EXPLANATION = re.compile(
    r"\b(why|explain|how (?:does|do|is|are)|what(?:'s| is| are) (?:a|an|the difference)|difference|should i|vs\.?|versus)\b",
    re.IGNORECASE,
)
_HISTORY = re.compile(r"\b(history|trend|chart|over (?:the )?(?:past|last)|since)\b", re.IGNORECASE)
_NUMBER = re.compile(r"(?<![\w.])\d[\d,]*(?:\.\d+)?")
_SENTENCE_END = re.compile(r"[.!?]\s+(?=\S)")
# A period after these is not a sentence end ("No. 4", "St. Louis", "e.g. a").
_ABBREVIATIONS = frozenset({"no", "nos", "st", "mr", "mrs", "ms", "dr", "jr", "sr", "vs", "vol", "e.g", "i.e", "etc",
                            "approx", "ed", "pg", "pp"})
_NARROWING = re.compile(
    r"^\W*(?:(?:show|give|list|keep)\s+(?:me\s+)?)?(?:only|just)\b"
    r"|\bnot (?:the )?(?:sealed|graded|raw|japanese|english)\b",
    re.IGNORECASE,
)
DISCLAIMER_TOOLS = frozenset({"get_market_trends", "find_price_lows", "find_new_highs"})
DISCLAIMER_TEXT = "This is past price data, not a prediction."
_DISCLAIMER = re.compile(
    r"not (?:a |financial )?(?:prediction|forecast|advice)|isn'?t (?:a )?(?:prediction|forecast)|"
    r"no guarantee|(?:can'?t|cannot|can not) predict|doesn'?t predict|not guaranteed|no sure bet|"
    r"not a sure thing|(?:can'?t|cannot) promise",
    re.IGNORECASE,
)
_KEEP_LINE = re.compile(r"not (?:a )?(?:prediction|forecast)", re.IGNORECASE)
ART_FILTER_KEYS = frozenset({"pokemon", "scene", "weather_time", "activity", "mood", "art_style", "palette", "theme"})


def word_count(text: str) -> int:
    return len(_WORD.findall(str(text or "")))


def turn_kind(
    question: str, tools_used: list[str] | set[str], *, no_data: bool = False, art_search: bool = False
) -> str:
    used = set(tools_used or ())
    if no_data:
        return "no_data"
    if _EXPLANATION.search(question or ""):
        return "explanation"
    if not used:
        return "refusal"
    if art_search or "list_facets" in used:
        return "art_search"
    if "get_price_history" in used and _HISTORY.search(question or ""):
        return "price_history"
    if is_narrowing_question(question):
        return "narrowing"
    if is_collection_value_question(question) and not is_movers_question(question):
        return "collection_value"
    return "default"


def limit_for(
    question: str, tools_used: list[str] | set[str], *, no_data: bool = False, art_search: bool = False
) -> int:
    return WORD_LIMITS[turn_kind(question, tools_used, no_data=no_data, art_search=art_search)]


def sentence_limit_for(
    question: str, tools_used: list[str] | set[str], *, no_data: bool = False, art_search: bool = False
) -> int | None:
    kind = turn_kind(question, tools_used, no_data=no_data, art_search=art_search)
    if kind != "explanation" and is_narrowing_question(question):
        kind = "narrowing"  # an empty narrowed result is still a short reply
    return SENTENCE_LIMITS.get(kind)


def is_narrowing_question(question: str) -> bool:
    """A short follow-up that narrows the previous results."""
    return len(str(question or "").split()) <= 10 and bool(_NARROWING.search(question or ""))


def needs_disclaimer(text: str, tools_used: list[str] | set[str]) -> bool:
    return bool(DISCLAIMER_TOOLS & set(tools_used or ())) and not _DISCLAIMER.search(text or "")


def add_disclaimer(text: str) -> str:
    return f"{text.rstrip()}\n\n{DISCLAIMER_TEXT}" if text.strip() else DISCLAIMER_TEXT


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
    parts: list[str] = []
    start = 0
    for match in _SENTENCE_END.finditer(paragraph):
        before = paragraph[start:match.start()].split()
        last = before[-1].casefold().lstrip("(\"'") if before else ""
        if len(before) == 1 and last.isdigit():
            continue  # "1. Umbreon": a numbered-list marker, not a sentence
        if match.group().startswith(".") and (last in _ABBREVIATIONS or (len(last) == 1 and last.isalpha())):
            continue
        parts.append(paragraph[start:match.start() + 1])
        start = match.end()
    parts.append(paragraph[start:])
    return [part.strip() for part in parts if part.strip()]


def _paragraphs(text: str) -> list[str]:
    return [p for p in re.split(r"\n\s*\n|\n", str(text or "")) if p.strip()]


def split_sentences(text: str) -> list[str]:
    return [sentence for paragraph in _paragraphs(text) for sentence in _sentences(paragraph)]


def sentence_count(text: str) -> int:
    return sum(len(_sentences(p)) for p in _paragraphs(text))


def over_limit(text: str, limit: int, max_sentences: int | None) -> bool:
    return word_count(text) > limit or (max_sentences is not None and sentence_count(text) > max_sentences)


def _masked(text: str, names: list[str] | tuple[str, ...]) -> str:
    out = _ALWAYS_MASKED.sub(" ", str(text or ""))
    for name in sorted({str(n).strip() for n in names or () if n and str(n).strip()}, key=len, reverse=True):
        out = re.sub(r"(?<!\w)" + re.escape(name) + r"(?!\w)", " ", out, flags=re.IGNORECASE)
    return out


def has_internal_wording(text: str, names: list[str] | tuple[str, ...] = ()) -> bool:
    """Talk of tags / search matching / tools / filters, outside card names."""
    return _INTERNAL.search(_masked(text, names)) is not None


_CLAUSE_COMMA = re.compile(r",\s+(?![^()]*\))")  # commas outside parentheses


def _scrub_sentence(sentence: str, names: list[str] | tuple[str, ...]) -> str:
    """The clauses before the first one with internal wording ('' if the first has it)."""
    if not has_internal_wording(sentence, names):
        return sentence
    kept: list[str] = []
    for clause in _CLAUSE_COMMA.split(sentence):
        if has_internal_wording(clause, names):
            break
        kept.append(clause)
    if not kept:
        return ""
    end = sentence.rstrip()[-1:] if sentence.rstrip()[-1:] in ".!?" else "."
    return ", ".join(kept).rstrip(" ,;:") + end


def drop_internal_sentences(text: str, names: list[str] | tuple[str, ...] = ()) -> str:
    """The text without clauses/sentences that mention internal mechanics (a sentence keeps
    its clauses before the offending one); unchanged if that would leave nothing."""
    kept = [
        " ".join(part for part in (_scrub_sentence(s, names) for s in _sentences(paragraph)) if part)
        for paragraph in _paragraphs(text)
    ]
    kept = [paragraph for paragraph in kept if paragraph.strip()]
    return "\n\n".join(kept) if kept else text


def trim_to_limit(text: str, limit: int, max_sentences: int | None = None) -> str:
    """Whole sentences in order until the word (and sentence) cap; a 'not a prediction'
    line is kept. A first sentence that alone runs over is cut at a word boundary."""
    paragraphs = [_sentences(p) for p in _paragraphs(text)]
    flat = [(index, sentence) for index, sentences in enumerate(paragraphs) for sentence in sentences]
    if not flat:
        return ""
    must = [item for item in flat[1:] if _KEEP_LINE.search(item[1])]
    if max_sentences is not None:
        must = must[: max(0, max_sentences - 1)]
    budget = limit - sum(word_count(sentence) for _, sentence in must)
    room = None if max_sentences is None else max(1, max_sentences - len(must))
    kept: list[tuple[int, str]] = []
    used = 0
    for item in flat:
        if item in must:
            continue
        words = word_count(item[1])
        if used + words > budget or (room is not None and len(kept) >= room):
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
