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

NO_INTERNAL_INSTRUCTION = (
    "Do not mention tags, searches, tools, filters or how results were found. "
    "Do not mention how much price history exists or its date range. "
    "No caveats about where the data comes from (estimates, recorded sales)."
)
REWRITE_INTERNAL_ONLY = (
    "Rewrite this answer with the same facts and about the same length. Keep every number, card name, set, date "
    "and the 'not a prediction' line if present. Same language. No preamble. " + NO_INTERNAL_INSTRUCTION
)
# Internal mechanics the user shouldn't hear about; card names ("TAG TEAM", "Tool Scrapper") are masked first.
_INTERNAL = re.compile(
    r"\btag(?:s|ged|ging)?\b|\bsearch(?:es)?\b|\bmatched\b|\bmatching\b|\btools?\b|\bfilter(?:ed|s)?\s+by\b",
    re.IGNORECASE,
)
# Owner 2026-11-20: never reveal how much price history exists. Dated moves ("jumped on Oct 28") are fine.
_COVERAGE = re.compile(
    r"\bdays?\s+of\s+(?:price\s+)?(?:history|data)\b"
    r"|\b(?:price\s+)?(?:history|data|records?)\s+(?:only\s+|just\s+)?(?:goes|go|dates?|reach(?:es)?)\s+back\b"
    r"|\b(?:price\s+)?(?:history|data|records?)\s+(?:only\s+|just\s+)?(?:starts?|begins?|began|started)\b"
    r"|\bhistory\s+(?:is|was)\s+(?:only\s+|too\s+|pretty\s+|very\s+)?(?:short|limited|thin|brief)\b"
    r"|\b(?:limited|short|shorter|less|thin|brief)\s+(?:price\s+)?history\b"
    r"|\b(?:only|just)\s+(?:have|has|had|covers?|spans?)\s+(?:about\s+|roughly\s+|around\s+)?\d+(?:\s*[-–]\s*\d+)?\s*(?:days?|weeks?|months?)\b"
    r"|\bhistory\s+only\b|\bonly\s+(?:\w+\s+)?(?:\d+\s+)?(?:days?\s+|months?\s+)?of\s+history\b"
    r"|\bcovers?\s+(?:only\s+)?(?:that|this|the)\s+(?:stretch|window|span|period)\b"
    r"|\bshort[-\s]lived\s+spikes?\b"
    r"|\b(?:not|isn'?t|doesn'?t\s+cover)\s+(?:a\s+)?(?:full|whole|complete)\s+year\b"
    r"|\bclosest\s+window\b",
    re.IGNORECASE,
)
# Owner 2026-11-20: no data-source caveats ("PSA 10 figures are market estimates based on recorded sales").
# Grading-fees and "not a prediction" lines are not caveats about the data and stay.
_CAVEAT = re.compile(
    r"\bmarket[-\s]estimates?\b|\bestimates?\s+based\s+on\b"
    r"|\bbased\s+on\s+(?:recorded|recent|completed|past|actual|reported)\s+sales\b"
    r"|\bdata\s+(?:may|might|could)\b|\baccording\s+to\s+(?:our|the|ekalight'?s?)\s+data\b"
    r"|\b(?:based\s+on\s+)?ekalight'?s\s+data\b",
    re.IGNORECASE,
)
# Art-search answers whose question named no language: print-language commentary is unrequested.
NO_LANGUAGE_INSTRUCTION = "Do not mention print language (English, Japanese)."
_LANGUAGE_ASK = re.compile(r"\b(english|japanese|jp|jpn|en|language)\b", re.IGNORECASE)
_LANGUAGE = re.compile(r"\b(?:english|japanese|jpn?|language)\b", re.IGNORECASE)
_LANGUAGE_PAREN = re.compile(r"\s*\((?:english|japanese|jpn?|en)\)", re.IGNORECASE)
_LANGUAGE_ADJ = re.compile(
    r"\b(?:english|japanese|jpn?|en)\s+(?=(?:options?|prints?|printings?|versions?|cop(?:y|ies)|cards?|ones?|"
    r"releases?|picks?)\b)",
    re.IGNORECASE,
)
_ALWAYS_MASKED = re.compile(r"\btag\s+team\b|\bpok[eé]mon\s+tools?\b", re.IGNORECASE)

_WORD = re.compile(r"[^\s*_#>`-]\S*")  # same counting as the eval's word_count
_EXPLANATION = re.compile(
    r"\b(why|explain|how (?:does|do|is|are)|what(?:'s| is| are) (?:a|an|the difference)|difference|should i|vs\.?|versus)\b",
    re.IGNORECASE,
)
# The definition form alone ("what's a SIR?"); on a market-data turn "what's a good card to buy" is a pick, not a definition.
_DEFINITION_ONLY = re.compile(r"\bwhat(?:'s| is| are) (?:a|an)\b", re.IGNORECASE)
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
    if _EXPLANATION.search(question or "") and not (
        DISCLAIMER_TOOLS & used and _EXPLANATION.search(_DEFINITION_ONLY.sub(" ", question or "")) is None
    ):
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


def has_disclaimer(text: str) -> bool:
    return bool(_DISCLAIMER.search(text or ""))


def needs_disclaimer(text: str, tools_used: list[str] | set[str]) -> bool:
    return bool(DISCLAIMER_TOOLS & set(tools_used or ())) and not has_disclaimer(text)


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


def _join(paragraphs: list[str]) -> str:
    """Paragraphs back into text; consecutive bullets stay one list."""
    out = ""
    for paragraph in paragraphs:
        if out:
            out += "\n" if _BULLET.match(paragraph) and _BULLET.match(out.rsplit("\n", 1)[-1]) else "\n\n"
        out += paragraph
    return out


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


def asks_language(question: str) -> bool:
    return bool(_LANGUAGE_ASK.search(question or ""))


def strip_language_mentions(text: str) -> str:
    """'the priciest English option' -> 'the priciest option'; '(Japanese)' dropped."""
    return _LANGUAGE_ADJ.sub("", _LANGUAGE_PAREN.sub("", str(text or "")))


def has_internal_wording(text: str, names: list[str] | tuple[str, ...] = (), *, language: bool = False) -> bool:
    """Talk of tags / search matching / tools / filters (and, with language=True, print
    language), price-history coverage or data-source caveats, outside card names."""
    masked = _masked(text, names)
    return (
        _INTERNAL.search(masked) is not None
        or _COVERAGE.search(masked) is not None
        or _CAVEAT.search(masked) is not None
        or (language and _LANGUAGE.search(masked) is not None)
    )


def has_coverage_disclosure(text: str) -> bool:
    return _COVERAGE.search(str(text or "")) is not None


_BULLET = re.compile(r"^\s*[-*\u2022]\s")
_CLAUSE_COMMA = re.compile(r",\s+(?![^()]*\))")  # commas outside parentheses


def _scrub_sentence(sentence: str, names: list[str] | tuple[str, ...], language: bool = False) -> str:
    """The clauses before the first one with internal wording ('' if the first has it)."""
    if not has_internal_wording(sentence, names, language=language):
        return sentence
    kept: list[str] = []
    for clause in _CLAUSE_COMMA.split(sentence):
        if has_internal_wording(clause, names, language=language):
            break
        kept.append(clause)
    if word_count(", ".join(kept)) < 3:
        return ""  # nothing left but a lead-in ("That said,")
    end = sentence.rstrip()[-1:] if sentence.rstrip()[-1:] in ".!?" else "."
    return ", ".join(kept).rstrip(" ,;:") + end


def drop_internal_sentences(text: str, names: list[str] | tuple[str, ...] = (), *, language: bool = False) -> str:
    """The text without clauses/sentences that mention internal mechanics (a sentence keeps
    its clauses before the offending one); unchanged if that would leave nothing."""
    kept = [
        " ".join(part for part in (_scrub_sentence(s, names, language) for s in _sentences(paragraph)) if part)
        for paragraph in _paragraphs(text)
    ]
    kept = [paragraph for paragraph in kept if paragraph.strip()]
    return _join(kept) if kept else text


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
    return _join(out)


# The app renders only **bold** and "- " bullets, so a markdown table shows raw pipes (owner 2026-11-20).
_TABLE_ROW = re.compile(r"^\s*\|?(?:[^|\n]*\|){2,}[^|\n]*$")
_TABLE_SEPARATOR = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$")


def _cells(line: str) -> list[str]:
    inner = line.strip()
    inner = inner[1:] if inner.startswith("|") else inner
    inner = inner[:-1] if inner.endswith("|") else inner
    return [cell.strip() for cell in inner.split("|")]


def has_table(text: str) -> bool:
    lines = str(text or "").splitlines()
    return any(_TABLE_SEPARATOR.match(line) for line in lines) or any(
        _TABLE_ROW.match(a) and _TABLE_ROW.match(b) for a, b in zip(lines, lines[1:])
    )


def _row_bullet(cells: list[str], header: list[str] | None) -> str:
    first = cells[0].replace("**", "").strip() if cells else ""
    rest = []
    for index, cell in enumerate(cells[1:], start=1):
        if cell in ("", "-", "–", "—"):
            continue
        name = header[index].strip("* ") if header and index < len(header) else ""
        rest.append(f"{name} {cell}" if name and not cell.casefold().startswith(name.casefold()) else cell)
    name, paren, detail = first.partition(" (")
    head = f"**{name}**" + (f" ({detail}" if paren else "") if first else ""
    return "- " + (f"{head}: {' · '.join(rest)}" if head and rest else head or " · ".join(rest))


def tables_to_bullets(text: str) -> str:
    """Each markdown table becomes one '- **col1**: Header2 col2 · Header3 col3' bullet per data row."""
    if not has_table(text):
        return text
    lines = str(text).splitlines()
    out: list[str] = []
    index = 0
    while index < len(lines):
        block_end = index
        while block_end < len(lines) and _TABLE_ROW.match(lines[block_end]):
            block_end += 1
        block = lines[index:block_end]
        if len(block) < 2 and not (block and _TABLE_SEPARATOR.match(block[0])):
            out.append(lines[index])
            index += 1
            continue
        header = None
        if len(block) >= 2 and _TABLE_SEPARATOR.match(block[1]):
            header, block = _cells(block[0]), block[2:]
        bullets = [_row_bullet(_cells(row), header) for row in block if not _TABLE_SEPARATOR.match(row)]
        bullets = [bullet for bullet in bullets if bullet.strip("- ")]
        if out and out[-1].strip() and bullets:
            out.append("")
        out.extend(bullets)
        if block_end < len(lines) and lines[block_end].strip() and bullets:
            out.append("")
        index = block_end
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()
