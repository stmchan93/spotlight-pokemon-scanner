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
    "line if present. Keep '- ' bullets and **bold** as they are. Same language. No preamble."
)

NO_INTERNAL_INSTRUCTION = (
    "Do not mention tags, searches, tools, filters or how results were found. "
    "Do not mention how much price history exists or its date range. "
    "No caveats about where the data comes from (estimates, recorded sales)."
)
REWRITE_INTERNAL_ONLY = (
    "Rewrite this answer with the same facts and about the same length. Keep every number, card name, set, date "
    "and the 'not a prediction' line if present. Keep '- ' bullets and **bold** as they are. Same language. "
    "No preamble. " + NO_INTERNAL_INSTRUCTION
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
    r"|\b(?:not|isn'?t|doesn'?t\s+cover)\s+(?:a\s+|the\s+)?(?:full|whole|complete|entire)\s+year\b"
    # "so this covers about 7 months" (owner 2026-11-21, hand labels)
    r"|\b(?:covers?|covering|spans?|spanning)\s+(?:only\s+|just\s+)?(?:about\s+|roughly\s+|around\s+|nearly\s+|almost\s+)?"
    r"(?:\d+|a\s+few|two|three|four|five|six|seven|eight|nine|ten|eleven)\s*(?:[-–]\s*\d+\s*)?(?:days?|weeks?|months?)\b"
    r"|\bclosest\s+window\b",
    re.IGNORECASE,
)
# Owner 2026-11-20: no data-source caveats ("PSA 10 figures are market estimates based on recorded sales").
# Grading-fees and "not a prediction" lines are not caveats about the data and stay.
_CAVEAT = re.compile(
    r"\bmarket[-\s]estimates?\b|\bestimates?\s+based\s+on\b"
    r"|\bbased\s+on\s+(?:recorded|recent|completed|past|actual|reported)\s+sales\b"
    r"|\bdata\s+(?:may|might|could)\b|\baccording\s+to\s+(?:our|the|ekalight'?s?)\s+data\b"
    r"|\b(?:based\s+on\s+)?ekalight'?s\s+data\b"
    # How set trends are computed ("basket moves of each set's top 10 cards").
    r"|\bbaskets?\b|\btop[-\s]10\s+cards\b",
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
    r"not (?:a |financial )?(?:prediction|forecast|advice)|(?:isn|aren|wasn|weren)'?t (?:a )?(?:prediction|forecast)|"
    r"no guarantee|(?:can'?t|cannot|can not) predict|doesn'?t predict|not guaranteed|no sure bet|"
    r"not a sure thing|(?:can'?t|cannot) promise",
    re.IGNORECASE,
)
_KEEP_LINE = re.compile(r"(?:not|n'?t) (?:a )?(?:prediction|forecast)", re.IGNORECASE)
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
    if word_count(", ".join(kept)) < 3 or ends_mid_thought(", ".join(kept)):
        return ""  # nothing left but a lead-in ("That said,") or a clause cut mid-thought
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


# Owner 2026-11-20: list answers bold each bullet's name, price and % change. Deterministic backstop
# for bullets the model left plain; text already inside **...** is untouched.
_MONEY = re.compile(r"(?<![\w$*])[+\-\u2212]?\$\d[\d,]*(?:\.\d+)?")
_PERCENT = re.compile(r"(?<![\w.*])[+\-\u2212]?\d+(?:\.\d+)?%")
_BULLET_LEAD = re.compile(r"^(\s*[-*\u2022]\s+)(.*)$")
_NAME_END = re.compile(r"\s+\(|:\s|\s+[\u2013\u2014-]\s")


def _bold_figures(segment: str) -> str:
    return _PERCENT.sub(lambda m: f"**{m.group()}**", _MONEY.sub(lambda m: f"**{m.group()}**", segment))


def _bold_outside(text: str) -> str:
    """Bold money and % figures outside existing **bold** spans."""
    parts = text.split("**")
    if len(parts) % 2 == 0:  # unbalanced markup: leave the line alone
        return text
    return "**".join(_bold_figures(part) if index % 2 == 0 else part for index, part in enumerate(parts))


def _is_name(text: str) -> bool:
    """A short lead with a letter that isn't a figure ('Mega Gengar ex', not '$5' or 'Raw price is')."""
    return (
        bool(text) and "**" not in text and len(text.split()) <= 6
        and re.search(r"[^\W\d_]", text) is not None and re.match(r"[$\d+\-\u2212]", text) is None
    )


def bold_bullet_figures(text: str) -> str:
    """In each bullet that carries a price or % figure: bold the leading name (up to ' (', ': ' or a dash)
    when nothing at its start is bold yet, and every $ / % figure not already bold."""
    out: list[str] = []
    for line in str(text or "").split("\n"):
        match = _BULLET_LEAD.match(line)
        if not match or not (_MONEY.search(match.group(2)) or _PERCENT.search(match.group(2))):
            out.append(line)
            continue
        lead, body = match.groups()
        if not body.startswith("**"):
            end = _NAME_END.search(body)
            name = body[: end.start()].strip() if end else ""
            if _is_name(name):
                body = f"**{name}**" + body[end.start():]
        out.append(lead + _bold_outside(body))
    return "\n".join(out)


def _names_in(sentence: str, names: list[str] | tuple[str, ...]) -> set[str]:
    plain = sentence.replace("**", "")
    found = set()
    for name in names:
        name = " ".join(str(name or "").split())
        if name and re.search(r"(?<!\w)" + re.escape(name) + r"(?!\w)", plain, re.IGNORECASE):
            found.add(name.casefold())
    # "Charizard" inside "Charizard ex" is the same mention, not a second card.
    return {name for name in found if not any(name != other and name in other for other in found)}


def _bold_name(sentence: str, names: list[str] | tuple[str, ...]) -> str:
    for name in sorted((" ".join(str(n or "").split()) for n in names), key=len, reverse=True):
        if not name:
            continue
        if re.search(r"\*\*" + re.escape(name) + r"\*\*", sentence, re.IGNORECASE):
            return sentence
        match = re.search(r"(?<![\w*])" + re.escape(name) + r"(?![\w*])", sentence, re.IGNORECASE)
        if match:
            return sentence[: match.start()] + f"**{match.group()}**" + sentence[match.end():]
    return sentence


def bullet_prose_cards(text: str, names: list[str] | tuple[str, ...]) -> str:
    """Owner 2026-11-20: a list answer with 2+ cards is one "- " bullet per card. When the answer has
    no bullets and 2+ of its sentences each name exactly one (different) card with a $ or % figure,
    those sentences become bullets (card name in bold); other sentences stay before/after them."""
    if not text or any(_BULLET.match(line) for line in str(text).split("\n")):
        return text
    sentences = split_sentences(text)
    picked: list[int] = []
    seen: set[str] = set()
    for index, sentence in enumerate(sentences):
        found = _names_in(sentence, names)
        if len(found) == 1 and (_MONEY.search(sentence.replace("**", "")) or _PERCENT.search(sentence.replace("**", ""))):
            name = next(iter(found))
            if name in seen:
                return text  # one card over two sentences: not a per-card list
            seen.add(name)
            picked.append(index)
    if len(picked) < 2:
        return text
    lead = [s for i, s in enumerate(sentences) if i not in picked and i < picked[0]]
    tail = [s for i, s in enumerate(sentences) if i not in picked and i > picked[0]]
    bullets = "\n".join("- " + _bold_name(sentences[i], names) for i in picked)
    return _join([part for part in (" ".join(lead), bullets, " ".join(tail)) if part])


# --- Owner hand labels 2026-11-21: deterministic text backstops (no extra call) -------------

# "Ekalight returned no price history", "the search found no ...": the answer speaks for itself.
_PLUMBING_NONE = re.compile(
    r"\b(?:Ekalight|the\s+(?:tools?|search(?:es)?|lookups?|database|catalog))\s+"
    r"(?:(?:returned|has|had|shows?|showed|found|gave|lists?|listed)\s+no"
    r"|(?:doesn'?t|does\s+not|didn'?t|did\s+not)\s+(?:have|return|show|list|find))\b",
    re.IGNORECASE,
)
_PLUMBING_FOUND = re.compile(
    r"\b(?:Ekalight|the\s+(?:tools?|search(?:es)?|lookups?))\s+(?:returned|found|turned\s+up|pulled\s+up)\b",
    re.IGNORECASE,
)
_PLUMBING_COULDNT = re.compile(
    r"\b(?:Ekalight|the\s+(?:tools?|search(?:es)?|lookups?))\s+(?:couldn'?t|could\s+not|can'?t|cannot)\b",
    re.IGNORECASE,
)


def _no_form(match: re.Match[str]) -> str:
    verb = match.group().split()[-1].casefold()
    return "I don't have" if verb in ("have", "return", "show", "list", "find") else "I have no"


def rewrite_plumbing(text: str) -> str:
    """'Ekalight returned no price history for X' -> 'I have no price history for X';
    'the search found three printings' -> 'I found three printings'; 'Ekalight couldn't' -> 'I couldn't'."""
    out = _PLUMBING_NONE.sub(_no_form, str(text or ""))
    out = _PLUMBING_FOUND.sub("I found", out)
    return _PLUMBING_COULDNT.sub(lambda m: "I " + m.group().split()[-1], out)


# "Market prices are roughly what copies have recently sold for": filler unless the user asked what a price means.
_PRICE_MEANING_ASK = re.compile(
    r"\bpric(?:e|es|ed|ing)\b[^?.]*\b(?:mean|means|work|works|calculated|determined|come\s+from|based|defined)\b"
    r"|\b(?:explain|how)\b[^?.]*\b(?:pric(?:e|es|ed|ing)|valu(?:e|es|ed|ing))\b(?!\s+(?:history|chart|trend))"
    r"|\bwhat(?:'s|\s+is|\s+are)\s+(?:a\s+|the\s+)?market\s+prices?\b",
    re.IGNORECASE,
)
_FILLER_CORE = (
    r"(?:what\s+(?:copies|cards|it|they|one)\s+(?:have\s+|has\s+)?(?:recently\s+|typically\s+|actually\s+)?"
    r"(?:sold|sell|sells|go(?:es)?|gone|traded?)\s+for(?:\s+recently|\s+lately)?"
    r"|recent\s+sale\s+(?:values?|prices?)|(?:reflects?|based\s+on)\s+recent\s+sales)"
)
_FILLER_CLAUSE = re.compile(
    r",?\s*(?:(?:which|that)\s+(?:is|are|'s)\s+|so\s+(?:it|they)\s+(?:reflects?|show)\s+|i\.e\.,?\s+)?"
    r"(?:(?:roughly|about|approximately|basically|essentially|or)\s+)?" + _FILLER_CORE,
    re.IGNORECASE,
)
_FILLER_SENTENCE = re.compile(r"\bmarket\s+prices?\b[^.!?]*" + _FILLER_CORE, re.IGNORECASE)
# Leftovers that say nothing once the explainer is gone ("Prices are market prices.", "A market price is").
_BARE_WORDS = frozenset("a an the these those this that all its their it they prices price are is were was raw "
                        "current near mint market usd".split())


# A sentence can't end on these: what's left after a clause was cut out mid-thought
# ("..., so it's." once "what copies have recently sold for" is gone). Drop the sentence instead.
_DANGLING_TAIL = re.compile(
    r"(?:^|[\s,;:(])(?:so|and|but|or|nor|yet|which|that|who|because|as|since|while|whereas|meaning|i\.e|e\.g"
    r"|it['\u2019]s|they['\u2019]re|that['\u2019]s|there['\u2019]s|is|are|was|were|be|been"
    r"|has|have|had|its|their|of|to|for|with|from|at|by|in|on|than|into|a|an|the|roughly|about|approximately"
    r"|basically|essentially|reflects?|shows?|means?|tracks?|represents?)$",
    re.IGNORECASE,
)


def ends_mid_thought(sentence: str) -> bool:
    """True when a sentence ends on a connective, pronoun+verb or article ('so it's.', 'and the.')."""
    body = re.sub(r"[*_`\s]+$", "", str(sentence or "").rstrip(".!?\u2026 ")).rstrip(" ,;:")
    return bool(body) and _DANGLING_TAIL.search(body) is not None


def asks_price_meaning(question: str) -> bool:
    return _PRICE_MEANING_ASK.search(question or "") is not None


def _without_filler(sentence: str) -> str:
    if _DISCLAIMER.search(sentence):
        return sentence  # "These are market prices, not a forecast" carries the not-a-prediction line
    stripped = _FILLER_CLAUSE.sub("", sentence)
    if stripped == sentence:
        return sentence
    stripped = re.sub(r"\s*\(\s*\)", "", stripped)  # "(roughly what copies sold for)" leaves "()"
    stripped = re.sub(r"\s+([.!?])", r"\1", stripped).strip()
    stripped = re.sub(r"[,;:\s]+([.!?])$", r"\1", stripped)
    if ends_mid_thought(stripped):
        return ""  # the cut left a dangling clause: drop the whole sentence
    body = stripped.rstrip(".!? ")
    # What's left must still say something: a figure or real words, not "Prices are market prices."
    words = re.findall(r"[\w']+", body.casefold())
    if not words or (not re.search(r"\d", body) and (set(words) <= _BARE_WORDS or len(words) < 3)):
        return ""
    return stripped if stripped[-1:] in ".!?" else stripped + "."


def strip_market_price_filler(text: str) -> str:
    """Drop the 'roughly what copies have recently sold for' explainer (clause or whole sentence)."""
    if _FILLER_SENTENCE.search(str(text or "")) is None and _FILLER_CLAUSE.search(str(text or "")) is None:
        return text
    paragraphs = [
        " ".join(part for part in (_without_filler(s) for s in _sentences(p)) if part) for p in _paragraphs(text)
    ]
    paragraphs = [p for p in paragraphs if p.strip()]
    return _join(paragraphs) if paragraphs else text


# Unrequested history narration (L010: "... has held at $6,100 from Oct 1 to Nov 19, with no movement").
_HISTORY_ASK = re.compile(
    r"\b(?:history|trend\w*|chart|graph|moved?|moving|movement|change[ds]?|up|down|rise|rising|rose|risen|fell|fall"
    r"|falling|drop\w*|dip\w*|spike\w*|jump\w*|climb\w*|gain\w*|los(?:e|s|ing|ers?)|over\s+(?:the\s+)?(?:past|last)"
    r"|since|lately|recently|this\s+(?:week|month|year)|why)\b",
    re.IGNORECASE,
)
_FLAT_NARRATION = re.compile(
    r"\b(?:has\s+|have\s+|had\s+)?(?:held|stayed|remained|sat|hovered|been\s+(?:flat|steady|stable|unchanged))\b"
    r"[^.!?]*\b(?:from|since|through|between)\b"
    r"|\bno\s+(?:price\s+)?(?:movement|change|moves?)\b"
    r"|\b(?:flat|unchanged|steady)\s+(?:since|from|over|through)\b",
    re.IGNORECASE,
)


def drop_unasked_history(text: str, question: str) -> str:
    """When the question isn't about movement or history, drop sentences (never the first) that
    narrate a flat price history."""
    if _HISTORY_ASK.search(question or "") or _FLAT_NARRATION.search(str(text or "")) is None:
        return text
    kept: list[str] = []
    first = True
    for paragraph in _paragraphs(text):
        sentences = []
        for sentence in _sentences(paragraph):
            if not first and _FLAT_NARRATION.search(sentence) and not _DISCLAIMER.search(sentence):
                continue
            sentences.append(sentence)
            first = False
        if sentences:
            kept.append(" ".join(sentences))
    return _join(kept) if kept else text


# Set completion (L020): "the full set would cost $X" when the user owns some of it.
_FULL_SET_COST = re.compile(
    r"\bthe\s+(?:full|whole|complete|entire)\s+set\s+would\s+(?:cost|run(?:\s+you)?)\b", re.IGNORECASE
)


_MISSING_COUNT = re.compile(r"\bmissing\s+(?:at\s+least\s+)?(\d[\d,]*)\b", re.IGNORECASE)


def fix_set_cost_wording(text: str) -> str:
    """'You're missing 251 of 252 ..., and the full set would cost about $993.80' -> '..., and the 251
    missing cards would cost about $993.80' (no count stated: 'finishing the set would cost')."""
    text = str(text or "")
    count = _MISSING_COUNT.search(text)

    def repl(match: re.Match[str]) -> str:
        phrase = f"the {count.group(1)} missing cards would cost" if count else "finishing the set would cost"
        return phrase[0].upper() + phrase[1:] if match.group()[0].isupper() else phrase

    return _FULL_SET_COST.sub(repl, text)


# Outside art searches only the clear remarks go: "(Japanese)" and "the priciest English option".
# A bare "Japanese print" can carry meaning ("the selection includes a Japanese print") and stays.
_LANGUAGE_RANKED = re.compile(
    r"\b((?:priciest|cheapest|most\s+expensive|least\s+expensive|highest[-\s]priced|top|best|only)\s+)"
    r"(?:english|japanese|jpn?|en)\s+(?=(?:options?|prints?|printings?|versions?|cop(?:y|ies)|cards?|ones?|"
    r"picks?)\b)",
    re.IGNORECASE,
)


def strip_ranked_language(text: str) -> str:
    """'the priciest English option' -> 'the priciest option'; 'Mareep (Japanese)' -> 'Mareep'."""
    return _LANGUAGE_RANKED.sub(r"\1", _LANGUAGE_PAREN.sub("", str(text or "")))


# --- shown-count consistency (L026: "Here are the first 20 by price" over 12 tiles) ---------
_NUMBER_WORDS = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
                 "sixteen seventeen eighteen nineteen twenty").split()
_NUM = r"(?P<n>\d{1,3}|" + "|".join(_NUMBER_WORDS[2:]) + r")"
_SHOWN_COUNT = re.compile(
    r"\b(?:here(?:'s|\s+is|\s+are)|showing|i'?m\s+showing|below\s+are|these\s+are)\s+"
    r"(?:(?:the|my|your|some|all)\s+)?"
    r"(?:(?:first|top|next|last|cheapest|priciest|most\s+valuable|highest[-\s]value|lowest[-\s]priced)\s+)?"
    + _NUM + r"\b(?!\s*(?:%|percent|days?|weeks?|months?|years?|/|\.\d))",
    re.IGNORECASE,
)


def _count_value(token: str) -> int:
    return int(token) if token.isdigit() else _NUMBER_WORDS.index(token.casefold())


def stated_shown_counts(text: str) -> list[int]:
    return [_count_value(m.group("n")) for m in _SHOWN_COUNT.finditer(str(text or ""))]


def fix_shown_count(text: str, shown: int) -> str:
    """A stated count of shown cards ('Here are the first 20') that disagrees with the tiles is set to
    the tile count, in the same style (digits or words)."""
    if shown < 2:
        return text

    def repl(match: re.Match[str]) -> str:
        token = match.group("n")
        if _count_value(token) < 2 or _count_value(token) == shown:
            return match.group()
        if token.isdigit() or shown >= len(_NUMBER_WORDS):
            new = str(shown)
        else:
            new = _NUMBER_WORDS[shown].capitalize() if token[0].isupper() else _NUMBER_WORDS[shown]
        start, end = match.start("n") - match.start(), match.end("n") - match.start()
        return match.group()[:start] + new + match.group()[end:]

    return _SHOWN_COUNT.sub(repl, str(text or ""))


# --- every tile named (L004: three tiles, the text named one) ------------------------------
MAX_NAMED_TILES = 3  # answers name at most 3 cards; longer lists are framed ("Here are 8 ...")
_PARTIAL_LIST = re.compile(r"\b(?:here are|here's|including|such as|led by|among them)\b", re.IGNORECASE)


def _tile_name_variants(name: Any) -> list[str]:
    base = " ".join(str(name or "").split())
    plain = " ".join(re.sub(r"[^\w\s.&'’-]", " ", base).split())
    return [variant for variant in dict.fromkeys((base, plain)) if variant]


def tile_named(tile: dict[str, Any], text: str) -> bool:
    return any(
        re.search(r"(?<!\w)" + r"\s+".join(re.escape(part) for part in variant.split()) + r"(?!\w)", text or "", re.I)
        for variant in _tile_name_variants(tile.get("name"))
    )


def unnamed_tiles(tiles: list[dict[str, Any]], text: str, question: str = "") -> list[dict[str, Any]]:
    """Tiles whose card name neither the text nor the question mentions ('Pikachu ex price?' -> '$120.'
    is fine), for short replies (at most MAX_NAMED_TILES tiles) that don't frame a partial list
    ('Here are...', 'including X')."""
    if not tiles or len(tiles) > MAX_NAMED_TILES or _PARTIAL_LIST.search(text or ""):
        return []
    return [tile for tile in tiles if tile.get("name") and not tile_named(tile, f"{text}\n{question}")]


def _tile_phrase(tile: dict[str, Any]) -> str:
    label = str(tile["name"])
    if tile.get("grader") and tile.get("grade"):
        label += f" {tile['grader']} {tile['grade']}"
    price = tile.get("price_usd")
    return f"{label} (${price:,.2f})" if isinstance(price, (int, float)) and not isinstance(price, bool) else label


def name_tiles_instruction(tiles: list[dict[str, Any]], limit: int | None) -> str:
    cap = f" Stay under {limit} words." if limit else ""
    return (
        "The app shows these cards under the answer, but the text never names them: "
        + "; ".join(_tile_phrase(tile) for tile in tiles) + ". Rewrite the answer so it also names each of them "
        "briefly, with its price if given, in the same voice. Keep every number, card name, set and date already "
        "there, '- ' bullets and **bold** as they are, and the 'not a prediction' line if present. Same language. "
        "No preamble." + cap + " " + NO_INTERNAL_INSTRUCTION
    )


def append_tile_names(text: str, tiles: list[dict[str, Any]]) -> str:
    """Deterministic fallback: '... Also shown: Karoo ($4.19) and Izo ($0.06).'"""
    phrases = [_tile_phrase(tile) for tile in tiles]
    if not phrases:
        return text
    joined = phrases[0] if len(phrases) == 1 else ", ".join(phrases[:-1]) + " and " + phrases[-1]
    return f"{text.rstrip()} Also shown: {joined}."
