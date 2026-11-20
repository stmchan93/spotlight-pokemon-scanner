"""One assistant turn: Messages API manual tool loop over AssistantToolbox.

Haiku 5.5 runs adaptive thinking by default, so `thinking` is omitted; each
response's full content (thinking blocks included) is appended unchanged
within the turn. Across turns only text is sent, plus a provenance note per
prior answer (build_messages).
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

from mcp_server.assistant.config import AssistantConfig, cost_usd
from mcp_server.assistant.direct_add import ADD_NOW_TOOL, TurnWrites
from mcp_server.assistant import length_guard
from mcp_server.assistant.shared_answers import tool_record
from mcp_server.assistant.compact import model_payload
from mcp_server.assistant.tools import (
    SPARKLINE_TOOLS,
    sparkline_fetch_range,
    TOOL_DEFINITIONS,
    AssistantToolbox,
    asks_to_choose,
    is_collection_value_question,
    is_movers_question,
    card_refs,
    clean_label,
    select_tiles,
)

logger = logging.getLogger("ekalight.assistant")

SYSTEM_PROMPT = """You are Ekalight's card assistant inside the Ekalight app: a confident, friendly collector who knows Pokémon (and other TCG) cards, prices, grading, and the hobby. You help with the user's collection, card prices, what they're missing, finding cards, and getting the most out of Ekalight.

Accuracy (never break these):
- Use the tools for every fact about cards, prices, or the user's collection. Never invent a card, price, holding, or trend. If a card you're asked about has a null price, say Ekalight has no price for it.
- Prices are USD from Ekalight's daily market data, not live. Never show yen or other currencies.
- Call the user's watched cards their "Watchlist" (never "wishlist"). If they say "wishlist", they mean the Watchlist: read it with get_my_watchlist.
- To change anything (add a card, change quantity/condition, watch a card or set a price alert), call a propose_* tool. The user must tap Confirm. Never say it's done; say it's ready to confirm.
- Exception: when the user asks to add one card and names its exact printing, quantity, and condition (or grader + grade), call add_to_collection_now instead; it saves right away. Say it's added only if the result has added=true.
- Copy every detail the user gave into the propose_* call: always pass quantity (e.g. "add 2" means quantity 2) and the condition, printing, or grade they named.
- A price the user names for an alert ("alert me under $400") is target_price_usd in propose_watch_card, even if the card is already below it; say the $400 alert is ready to confirm.
- A span the user names for price history ("past year", "3 months", "30 days") sets get_price_history's range (1y, 90d, 30d).
- For a card's price history or trend, call get_price_history so the app shows a chart; keep the text to one sentence summarizing the move. That sentence names the printing and the price condition (e.g. "the Near Mint Holofoil price of Kyogre-EX (Dark Explorers 104/108)"); the result's summary line has them with the dated move.
- "Why did X move/go up": open with the actual move and dates from the history (e.g. "Charizard ex fell from $374 on Aug 22 to $288 on Nov 18"), then the cause only if a tool result supports it. If the history doesn't show the move the user assumed, say what it shows.
- A price question naming a card without set or number: if search_cards returns ambiguous=true, don't pick one printing's price; ask which one they mean (use its ask_which) and show the candidates. If it returns resolved_owned_card_id, use that printing (the one the user owns) without asking.
- History windows: never say how much price history Ekalight has or when it starts (no "only 40 days of history", "since August", "not a full year", "short-lived spikes", "the closest window I can check"). Name a window only as the result's window_label gives it ("past year" when covered); when window_label is "recently", say "recently", "lately", "near its recent low" or "at its lowest recorded price", never "1-year low" or "over the past year". Dated moves ("fell from $374 on Aug 22 to $288 on Nov 18") are fine.
- "Card"/"cards" means single cards: pass filter.product="single" whenever the user says card or cards. Use product "any" only for other wording.
- "Most expensive" questions (any game): give the raw leader (search_cards, sort=price_desc, product=single) and the graded leader (find_top_graded); for a singular question ("the most expensive card") name only the #1 of each; for a plural question ("most expensive cards", "PSA 10s") name the top two of each. If find_top_graded says the game has no graded prices, say so in a short clause.
- Graded prices: say "verified" only when price_verified is true (a recorded sale). Never quote excluded_untrusted prices.
- find_new_highs results are market-price highs, not completed sales: call them "market-price highs".
- Set completion: say the missing count. Name a completion cost only from cheapest_completion_usd; if only priced_subtotal_usd exists, say "$X for Y of N missing cards". Use find_missing's default value_desc for "what am I missing"/chase cards; sort=price_asc only for cheap/budget questions.
- "Worth grading": get_my_collection (sort=value_desc, product=single), pass the 3 most valuable raw singles to grading_upside, then answer with a short table, one row per card it returns: Card | Raw market price | PSA 10 comp | Gross premium ($ and %). Every card with a comp gets its real numbers; write "no comp" or "no raw price" in a row that lacks one. Name no other cards. Add that grading costs money and takes time.
- Collection worth: get_portfolio_summary; give the total value first (the tiles show the top holdings). Scoped worth ("my One Piece cards", "my Japanese cards"): get_my_collection with that filter; the first sentence states its total_value_usd.
- The user's most valuable cards or slabs: get_my_collection sort=price_desc (per-copy price; holding_type="graded" for slabs, product="single" for cards). The #1 is the highest price_usd; mention a holding's total (value_usd) only as an aside. "Top holdings" and the collection total use value_desc.
- Movers inside a set, rarity or card name ("which Evolving Skies card dropped the most this month", "biggest SIR gainers this week"): find_movers with direction and the window the user named (week=7d, month=30d, 3 months=90d, year=1y; default 30d). State the window as window_label gives it.
- Collection movers: call get_portfolio_summary with focus="movers"; name at most 3 cards. top_gainers/top_losers are ranked by dollars; top_gainers_pct/top_losers_pct by percent. Label each ranking you give ("by dollars", "in percent"); a leader ("biggest", "led", "most in %") comes only from top_gainer_by_usd/top_gainer_by_pct (losers: top_loser_by_usd/top_loser_by_pct), never inferred from the other list.
- "Japanese/English version of" a card: find the card, call get_card on it, and use its language_pair (get_card on that id for the price). Talk about the counterpart (set, number, USD price); mention the source card only if the user scanned it.
- If a tool says total_is_lower_bound, say "at least" with its counts.
- You can't delete cards, sell, list, or buy. Say so in one short sentence plus at most one offer, under 40 words. The user can delete a card themselves from its ⋯ menu in Collection or from its card page.
- General TCG questions (rarities, grading, sets, how collecting works, game basics) are welcome: answer from your knowledge, but specific prices, cards, and the user's collection must come from tools. When the question is what a kind of card is (a rarity like SIR, a card type), also look up one real example (e.g. search_cards with that rarity_bucket, product=single, sort=price_desc, limit=1), name it, and show it.
- Scanned cards in the message are optional context; the user may ask about anything else.
- Buy/sell/"investing"/"good buy"/"what's hot or trending" questions: don't refuse and don't predict or promise gains. Use get_market_trends for what's rising and which sets are moving, find_price_lows for "undervalued" or cards that dropped and now sit near their lows, and find_new_highs for "new highs", record or all-time-high prices, and "breaking out". "Likely to go up": call get_market_trends and find_price_lows, describe recent momentum and dips, and say plainly it's not a prediction. Give the takeaway in 1-2 sentences naming at most 3 cards (the tiles show the cards you name) plus one short line that it's not a prediction.
- Off-topic requests (not cards/TCG/collecting/this app): decline in one sentence, under 40 words.
- Only state what the tool results show. Never say a filter or sort was applied (e.g. "sealed products are excluded", "English only", "One Piece only") unless the tool input used it. If the results don't match the request (e.g. they still include sealed products or the wrong game), re-query with the right filter, or say plainly what the results include.

Earlier turns:
- Your earlier answers were based on tool results you can no longer see. The [Looked up with: ...] note after an earlier answer records what you looked up and which cards it showed; reuse those card ids instead of searching again.
- Trust your earlier answers. Never correct, retract, or disown an earlier answer unless the user says it's wrong or a new tool result contradicts it; then just give the right fact.
- Never write a [Looked up with: ...] note yourself.

How to answer:
- Takeaway first: the first sentence answers the question with a concrete number or verdict from the tools. Then add detail only if it helps.
- Short by default: 1-3 sentences, under 50 words. "Why", "explain", "should I", and grading questions may run to about 90 words.
- When the data is missing (no history, nothing found), answer in under 50 words: say what you couldn't verify and give the facts you have. No general speculation about causes.
- Answer only what was asked. No overall collection change in a gainers/losers answer; no graded or slab aside on a raw-price or scanned-card question unless asked; no comments on print language, result counts or pages unless asked.
- Art/vibe searches ("cozy", "rainy night"): 1-2 short sentences naming up to 3 of the best matches; if they only partly match (e.g. rain but not night), say so plainly ("these show rain, but not clearly at night"). Describe the artwork; never say tag, tagged, matching, or filters.
- Explain like a savvy friend at a card show, in plain English: what a price means (e.g. a market price is what copies have recently sold for), why it moved when the data shows it (e.g. "up 18% in 30 days"), and the trade-offs of condition and grading (raw vs. PSA 10 price gap, and that grading costs money and takes time). Use the real numbers from tools.
- The app shows a card tile (image, name, set, number, price) for each card you pass to show_cards, so never list cards or repeat their prices one by one. Say e.g. "Here are 5 under $20" and let the tiles show them.
- Use a bulleted list only for a comparison or steps; max 3 bullets, one short line each. Plain text; **bold** is fine, no headings, and no tables except the worth-grading table.
- No filler ("based on Ekalight's data", "great question") and no caveats unless they change the answer.
- Speak like a knowledgeable collector, not a system: never mention tools, tool calls, searches or lookups you ran, "this chat", system details, or data providers by name.

Card tiles (show_cards):
- When the answer is about specific cards, call show_cards in the same message as your answer with exactly those cards, in the order you mention them. Every card you name must be in it; never show cards the answer isn't about.
- Show several candidates only when you ask the user to choose (e.g. which Charizard?).
- For one card's price history: that one card (same printing or grade as the chart), nothing else.
- Any example you name must be one of the cards you show.
- Tiles follow your text: once you name cards, only the named cards show, unless you present a list ("Here are…", "including…") or ask the user to choose.
- Watchlist answers: up to 8 cards; the app links to the full Watchlist.
- Add a short label when it helps, e.g. "Top holdings by value", "Highest-value cards you're missing", "Chase cards you're missing".

Show off Ekalight when it helps (never spammy):
- When a feature solves the user's obvious next step, mention it in one short clause, at most once per answer. Skip it when nothing fits.
- Features you may name (only these; never invent others): the Scan tab (point the camera at a raw card, a graded slab, or a whole binder page to identify it and get prices); Collection (total value with a chart, top gainers and losers; edit or delete a card from its ⋯ menu); Watchlist with target-price alerts (a push when a card drops to the price the user set); card pages with price history and recent graded sales; Top Trends and market trends; the Events tab (upcoming card shows, vendor booths, floor maps); a Transactions log of buys and sales.
- Good: "Want me to watch it and ping you under $40?" Bad: an ad-like pitch, or a feature not on this list.

Follow-up suggestions:
- End every answer (except off-topic declines and refusals) with 1-3 tap-to-ask follow-ups in exactly this format, after the answer:
<followups>
Is it worth grading?
Add it to my Watchlist
</followups>
- Each is one line, under 40 characters, written as the user would ask it, specific to this conversation, and something you can answer or propose with your tools next (a price check, a comparison, a watch or add, a trend). Vary them; no repeats of what was just answered.
- Never mention the follow-ups in your answer text.

Final checks before answering:
- The first sentence answers with a number or verdict from the tools. Under 60 words (why/explain/grading: about 90).
- Name at most 3 cards. For a top-N list name the leader and let the tiles show the rest; never list cards with prices one by one.
- Gainers/losers answers: never mention the collection's overall value or change. Collection totals: no note about unpriced holdings.
- Never mention tags, filters, searches, or what was or wasn't searched, excluded or filtered. Art answers never use the words tag, tagged, or matching.
- Price history answers: the first sentence states the price condition (e.g. Near Mint) and printing, with the dated move.
- No remarks on how much price history exists or when it starts; name a window only as window_label gives it.
- Collection value (whole or scoped): the first sentence is the total in USD.
- Raw + graded leaders: the first sentence names the single priciest card overall (usually the graded one) and its price; the other side follows.
- Art answers: no print-language remarks (English/Japanese) unless the user asked.
- Several printings and no set/number given: ask which one.
- A follow-up that narrows your last answer ("only singles") gets 1-2 short sentences (under 40 words) with just the new result.
- Explaining prices: say plainly that a market price is roughly what copies have recently sold for.
- Name only app features from the list above."""

REFUSAL_TEXT = "Sorry, I can't help with that one. Ask me about your cards, prices, or collection."
TOO_LONG_TEXT = "That answer ran too long. Try a narrower question."
EMPTY_TEXT = "Sorry, I couldn't put an answer together. Try asking again."
ROUND_LIMIT_NOTE = "Tool budget for this question is used up. Answer now with what you have."

# Follow-up chips ride in the same response as a trailing <followups> block
# (no extra call, no change to the cached prefix); parsed out, never shown.
MAX_SUGGESTIONS = 3
MAX_SUGGESTION_CHARS = 40
_FOLLOWUPS_OPEN = re.compile(r"<\s*followups\s*>", re.IGNORECASE)
_FOLLOWUPS_CLOSE = re.compile(r"<\s*/\s*followups\s*>", re.IGNORECASE)
_LINE_PREFIX = re.compile(r"^(?:[-*\u2022]+|\d+[.)])\s*")
_QUOTES = "\"'\u201c\u201d\u2018\u2019`"


def _clean_suggestion(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    line = " ".join(_LINE_PREFIX.sub("", raw.strip()).split()).strip(_QUOTES).strip()
    if not line or len(line) > MAX_SUGGESTION_CHARS or any(ch in line for ch in "<>`{}[]\u00a5"):
        return None
    return line


def split_suggestions(text: str, stop_reason: str | None = None) -> tuple[str, list[str]]:
    """(visible text, follow-ups). The block and everything after its opening tag
    never reach the reply; a malformed or truncated block yields []."""
    opening = _FOLLOWUPS_OPEN.search(text)
    if opening is None:
        return _FOLLOWUPS_CLOSE.sub("", text).strip(), []
    visible = text[: opening.start()].rstrip()
    if visible.endswith("```"):
        visible = visible[:-3].rstrip()
    body = text[opening.end():]
    closing = _FOLLOWUPS_CLOSE.search(body)
    if closing is None and stop_reason == "max_tokens":
        return visible, []
    body = (body[: closing.start()] if closing else body).strip()
    items: list[Any]
    if body.startswith("["):
        try:
            parsed = json.loads(body)
        except ValueError:
            return visible, []
        items = parsed if isinstance(parsed, list) else []
    else:
        items = body.splitlines()
    suggestions: list[str] = []
    seen: set[str] = set()
    for item in items:
        line = _clean_suggestion(item)
        if line is None or line.casefold() in seen:
            continue
        seen.add(line.casefold())
        suggestions.append(line)
        if len(suggestions) == MAX_SUGGESTIONS:
            break
    return visible, suggestions


# Provenance for prior assistant turns: history is text-only, so without this
# the model sees its own numbers with no sign of the lookups behind them and
# "corrects" answers that were right.
PROVENANCE_PREFIX = "[Looked up with:"
MAX_PROVENANCE_CALLS = 6
MAX_PROVENANCE_CARDS = 8
_ARG_SKIP = frozenset({"limit", "cursor"})
_ECHOED_NOTE = re.compile(r"^\s*\[Looked up with:[^\n]*\]\s*$", re.MULTILINE)


def _arg_text(value: Any) -> str | None:
    if isinstance(value, bool) or value is None:
        return None if value is None else str(value).lower()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        value = " ".join(value.split())
        return value[:40] if value else None
    if isinstance(value, list):
        parts = [part for part in (_arg_text(item) for item in value[:3]) if part]
        return "|".join(parts) or None
    return None


def summarize_tool_call(name: str, arguments: Any) -> str:
    """Compact `name(key=value, ...)`; nested filter dicts are flattened."""
    pairs: list[str] = []

    def walk(node: Any) -> None:
        if not isinstance(node, dict):
            return
        for key, value in node.items():
            if key in _ARG_SKIP:
                continue
            if isinstance(value, dict):
                walk(value)
                continue
            rendered = _arg_text(value)
            if rendered is not None:
                pairs.append(f"{key}={rendered}")

    walk(arguments)
    call = f"{name}({', '.join(pairs)})"
    return call if len(call) <= 160 else call[:159] + "…"


def provenance_note(tool_calls: list[str], cards: list[dict[str, Any]]) -> str | None:
    """Model-only note appended to a prior assistant answer; None if nothing was looked up."""
    calls = list(dict.fromkeys(str(call) for call in tool_calls if call))[:MAX_PROVENANCE_CALLS]
    if not calls:
        return None
    note = f"{PROVENANCE_PREFIX} {'; '.join(calls)}"
    shown = []
    for card in cards[:MAX_PROVENANCE_CARDS]:
        if not isinstance(card, dict) or not card.get("card_id"):
            continue
        label = " ".join(str(card[key]) for key in ("name", "set") if card.get(key))
        if card.get("number"):
            label += f" #{card['number']}"
        if card.get("grader") and card.get("grade"):
            label += f" {card['grader']} {card['grade']}"
        shown.append(f"{label} [{card['card_id']}]" if label else f"[{card['card_id']}]")
    if shown:
        note += f". Cards shown: {'; '.join(shown)}"
    return note + "]"


def _response_text(response: Any) -> str:
    return "\n\n".join(
        str(block.text).strip()
        for block in (getattr(response, "content", None) or [])
        if getattr(block, "type", None) == "text" and str(getattr(block, "text", "")).strip()
    )


_PSEUDO_CALL = re.compile(r"\b(show_cards|get_[a-z_]+|search_cards|find_[a-z_]+|propose_[a-z_]+)\s*\(")


def strip_pseudo_calls(text: str) -> str:
    """Drop a tool call the model typed into its answer ('show_cards(cards: [...])')."""
    out = text
    while (match := _PSEUDO_CALL.search(out)) is not None:
        depth, end = 0, None
        for index in range(match.end() - 1, len(out)):
            depth += {"(": 1, ")": -1}.get(out[index], 0)
            if depth == 0:
                end = index + 1
                break
        out = out[: match.start()].rstrip() + ("\n\n" + out[end:].lstrip() if end and out[end:].strip() else "")
    # A trailing 'show_cards: ...' / 'show_cards\n{json}' block, and stray <br> lines.
    out = _TRAILING_SHOW_CARDS.sub("", out)
    return _BR_LINE.sub("", out).strip()


_TRAILING_SHOW_CARDS = re.compile(r"(?:^|\n)[ \t]*show_cards\b[\s\S]*\Z")
_BR_LINE = re.compile(r"(?m)^[ \t]*<br\s*/?>[ \t]*\n?")


_MONEY = re.compile(r"\$\s?([\d,]+(?:\.\d+)?)")


def _mentions_amount(text: str, amount: float) -> bool:
    for token in _MONEY.findall(text):
        try:
            if abs(float(token.replace(",", "")) - amount) <= max(1.0, amount * 0.01):
                return True
        except ValueError:
            continue
    return False


def ensure_total_first(text: str, question: str, totals: list[tuple[float, str | None]]) -> str:
    """A collection-value question whose answer never states the total gets it as the first sentence."""
    if not totals or not is_collection_value_question(question) or is_movers_question(question):
        return text
    total, scope = totals[-1]
    if _mentions_amount(text, total):
        return text
    subject = f"Your {scope} cards are" if scope else "Your collection is"
    return f"{subject} worth about ${total:,.2f} in total." + (f" {text}" if text else "")


def ensure_choice_question(text: str, ask_which: str | None) -> str:
    """A price lookup that matched several printings must end by asking which one."""
    if not ask_which or asks_to_choose(text):
        return text
    return f"{text}\n\n{ask_which}" if text else ask_which


# --- answer text split across rounds ------------------------------------------
# Haiku often writes the real answer next to a tool call, then a final message that
# covers only the extra lookup (or nothing). Substantive earlier text is kept.
ANSWER_NOW_NOTE = "Answer the user's question now using the tool results above. No more tools."
MIN_SUBSTANTIVE_WORDS = 12
NEAR_DUPLICATE = 0.8
_PREAMBLE = re.compile(
    r"^\W*(?:let me|let's|i'll|i will|i need to|i should|i'm going to|i am going to|now,? i|first,? i|next,? i|"
    r"checking|looking (?:up|into|at|for)|one moment|hang on|ok(?:ay)?\b|alright\b|sure\b|the search|searching)"
    r"|\blet me\b",
    re.IGNORECASE,
)
_TOKEN = re.compile(r"\$?\d[\d,]*(?:\.\d+)?%?|[^\W\d_][\w'’-]*")
_STOPWORDS = frozenset(
    "the and for are was its it's this that with from has have but not you your yours their our".split()
)


def substantive_text(raw: str) -> str:
    """Text written alongside tool calls minus 'let me check' sentences; '' unless what's
    left has a number or at least MIN_SUBSTANTIVE_WORDS words."""
    visible = strip_pseudo_calls(_ECHOED_NOTE.sub("", split_suggestions(raw)[0])).strip()
    lines: list[str] = []
    for line in visible.splitlines():
        if line.lstrip().startswith("|") or not line.strip():
            lines.append(line)
            continue
        kept = [sentence for sentence in length_guard.split_sentences(line) if not _PREAMBLE.search(sentence)]
        if kept:
            lines.append(" ".join(kept))
    out = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    if not out or not (re.search(r"\d", out) or length_guard.word_count(out) >= MIN_SUBSTANTIVE_WORDS):
        return ""
    return out


def _content_tokens(text: str) -> set[str]:
    tokens = set()
    for token in _TOKEN.findall(text.casefold()):
        token = token.replace(",", "").lstrip("$").rstrip("%")
        if token[:1].isdigit() or (len(token) >= 3 and token not in _STOPWORDS):
            tokens.add(token)
    return tokens


def _share(part: set[str], other: set[str]) -> float:
    return len(part & other) / len(part) if part else 1.0


def merge_answer_parts(parts: list[str]) -> str:
    """Earlier substantive text + the final text, in order. A part that mostly repeats a
    kept one is dropped; a kept part that a later one restates is replaced by it."""
    kept: list[tuple[str, set[str]]] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        tokens = _content_tokens(part)
        if any(_share(tokens, other) >= NEAR_DUPLICATE for _, other in kept):
            continue
        kept = [(text, other) for text, other in kept if _share(other, tokens) < NEAR_DUPLICATE]
        kept.append((part, tokens))
    return "\n\n".join(text for text, _ in kept)


# --- arguments corrected from the question ---------------------------------------
RANGE_ORDER = {"7d": 0, "30d": 1, "90d": 2, "1y": 3}
_RANGE_PATTERNS = (
    ("1y", re.compile(r"\b(?:past|last|this|previous|a|one|1)\s+year\b|\b12[\s-]*months?\b|\b1\s?y(?:r)?\b"
                      r"|\b365\s*days\b|\byear[\s-]+over[\s-]+year\b", re.IGNORECASE)),
    ("90d", re.compile(r"\b90[\s-]*days?\b|\b(?:3|three)[\s-]*months?\b|\bquarter\b", re.IGNORECASE)),
    ("30d", re.compile(r"\b30[\s-]*days?\b|\b(?:past|last|this|a|one|1)\s+month\b", re.IGNORECASE)),
)
_WATCH_WORDS = re.compile(r"\b(alert|under|below|drops?|dips?|falls?|less than|target|notify|ping)\b", re.IGNORECASE)
_TARGET_AMOUNT = re.compile(
    r"\b(?:under|below|drops?|dips?|falls?|less than|target|at)\b[^$\d]{0,20}\$\s?(\d[\d,]*(?:\.\d+)?)", re.IGNORECASE
)


def history_range_for(question: str) -> str | None:
    """'past year' -> 1y, '3 months' -> 90d, 'last month' -> 30d."""
    for key, pattern in _RANGE_PATTERNS:
        if pattern.search(question or ""):
            return key
    return None


def question_target_usd(question: str) -> float | None:
    """'alert me if it drops under $400' -> 400.0."""
    if not _WATCH_WORDS.search(question or ""):
        return None
    amounts = _MONEY.findall(question or "")
    match = _TARGET_AMOUNT.search(question or "")
    token = match.group(1) if match else (amounts[0] if len(amounts) == 1 else None)
    try:
        value = float(token.replace(",", "")) if token else None
    except ValueError:
        return None
    return value if value and value > 0 else None


def correct_tool_arguments(name: str, arguments: Any, question: str) -> dict[str, Any]:
    """Fill what the question states but the model dropped: a history range at least as
    long as asked for, and the watch target price the user named."""
    args = dict(arguments) if isinstance(arguments, dict) else {}
    if name == "get_price_history":
        wanted = history_range_for(question)
        current = args.get("range")
        if wanted and RANGE_ORDER.get(str(current), -1) < RANGE_ORDER[wanted]:
            args["range"] = wanted
    elif name == "propose_watch_card" and args.get("target_price_usd") is None:
        target = question_target_usd(question)
        if target is not None:
            args["target_price_usd"] = target
    return args


class AssistantFailed(RuntimeError):
    """LLM or network failure; the turn is not counted. `cost_usd` = tokens already spent."""

    def __init__(self, message: str, *, cost: float = 0.0) -> None:
        super().__init__(message)
        self.cost_usd = cost


@dataclass
class TurnResult:
    text: str
    status: str  # "ok" | "error" (refusal / unusable output; not counted)
    cards: list[dict[str, Any]] = field(default_factory=list)
    actions: list[dict[str, Any]] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)
    cards_label: str | None = None
    cards_view_all: dict[str, Any] | None = None
    charts: list[dict[str, Any]] = field(default_factory=list)
    tools_used: list[str] = field(default_factory=list)
    tool_calls: list[str] = field(default_factory=list)  # summarize_tool_call() per call, for history provenance
    tool_inputs: list[dict[str, Any]] = field(default_factory=list)  # shared_answers.tool_record() per call
    rounds: int = 0
    input_tokens: int = 0  # whole prompt: uncached + cache reads + cache writes
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    stop_reason: str | None = None
    tool_errors: list[str] = field(default_factory=list)  # names of tools that returned is_error
    round_limit_hit: bool = False
    word_limit: int | None = None
    sentence_limit: int | None = None
    length_guard: str | None = None  # None | "rewrite" | "trim" | "drop" (internal-wording sentences dropped)


def _usage_tokens(usage: Any, name: str) -> int:
    value = getattr(usage, name, None)
    return int(value) if isinstance(value, (int, float)) else 0


def add_usage(result: TurnResult, usage: Any) -> None:
    """Sums one response's usage into the turn (tool rounds and the length-guard rewrite alike)."""
    if usage is None:
        return
    read = _usage_tokens(usage, "cache_read_input_tokens")
    write = _usage_tokens(usage, "cache_creation_input_tokens")
    result.input_tokens += _usage_tokens(usage, "input_tokens") + read + write
    result.cache_read_tokens += read
    result.cache_write_tokens += write
    result.output_tokens += _usage_tokens(usage, "output_tokens")
    result.cost_usd += cost_usd(usage)


def cache_hit_ratio(input_tokens: int, cache_read_tokens: int) -> float:
    return round(cache_read_tokens / input_tokens, 4) if input_tokens > 0 else 0.0


def _distinct_charts(charts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One chart per series; a repeat call keeps its first result."""
    seen: set[tuple[Any, ...]] = set()
    out: list[dict[str, Any]] = []
    for chart in charts:
        key = tuple(chart.get(k) for k in ("card_id", "variant", "condition", "grader", "grade", "range"))
        if key not in seen:
            seen.add(key)
            out.append(chart)
    return out


SHOW_CARDS = "show_cards"
# Their results are lists the answer may present, naming only a few of them.
LIST_TOOLS = frozenset({"search_cards", "find_missing", "get_my_collection", "get_my_watchlist"})


def _history_refs(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Tiles from earlier answers: show_cards may reuse them without a new lookup."""
    refs = []
    for item in history:
        for card in item.get("cards") or []:
            if isinstance(card, dict) and card.get("card_id"):
                refs.append({key: card.get(key) for key in ("card_id", "name", "set", "number", "language", "grader", "grade")})
    return refs


def _tools_payload() -> list[dict[str, Any]]:
    tools = copy.deepcopy(TOOL_DEFINITIONS)
    tools[-1]["cache_control"] = {"type": "ephemeral"}
    return tools


TOOLS_PAYLOAD = _tools_payload()
SYSTEM_PAYLOAD = [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]


def build_messages(history: list[dict[str, Any]], question: str, context: str | None) -> list[dict[str, Any]]:
    """Text history (must start with a user turn) + this question. Prior assistant
    answers carry a provenance note built from their stored tool calls + tiles."""
    messages: list[dict[str, Any]] = []
    for item in history:
        role = item["role"] if item["role"] in ("user", "assistant") else None
        text = str(item.get("text") or "").strip()
        if role is None or not text:
            continue
        if role == "assistant":
            note = provenance_note(item.get("tool_calls") or [], item.get("cards") or [])
            if note:
                text += "\n\n" + note
        if not messages and role != "user":
            continue
        if messages and messages[-1]["role"] == role:
            messages[-1]["content"] += "\n\n" + text
        else:
            messages.append({"role": role, "content": text})
    content: list[dict[str, Any]] = []
    if context:
        content.append({"type": "text", "text": context})
    content.append({"type": "text", "text": question})
    if messages and messages[-1]["role"] == "user":
        # A stored question with no answer (shouldn't happen); fold it in.
        messages[-1] = {"role": "user", "content": [{"type": "text", "text": messages[-1]["content"]}, *content]}
    else:
        messages.append({"role": "user", "content": content})
    return messages


def with_history_breakpoint(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Copy with every prior message as text blocks and a breakpoint on the last one, so a
    follow-up turn reads the history the previous turn wrote. Block form for all of them keeps
    a once-marked message byte-identical when it later sits mid-history."""
    if len(messages) < 2:
        return messages
    prior = [
        {"role": m["role"], "content": [dict(block) for block in m["content"]] if isinstance(m["content"], list)
         else [{"type": "text", "text": m["content"]}]}
        for m in messages[:-1]
    ]
    prior[-1]["content"][-1]["cache_control"] = {"type": "ephemeral"}
    return [*prior, messages[-1]]


class AssistantEngine:
    def __init__(self, config: AssistantConfig, toolbox: AssistantToolbox, client: Any) -> None:
        self.config = config
        self.toolbox = toolbox
        self.client = client  # anthropic.AsyncAnthropic (or a test double)

    async def _create(self, messages: list[dict[str, Any]], *, final: bool) -> Any:
        return await self.client.messages.create(
            model=self.config.model,
            max_tokens=self.config.max_output_tokens,
            system=SYSTEM_PAYLOAD,
            tools=TOOLS_PAYLOAD,
            tool_choice={"type": "none"} if final else {"type": "auto"},
            output_config={"effort": self.config.effort},
            # Breakpoints (max 4): tools, system, end of history (with_history_breakpoint), and this
            # automatic one on the last block, so round 2+ reads round 1.
            cache_control={"type": "ephemeral"},
            messages=messages,
        )

    async def _enforce_length(
        self, text: str, result: TurnResult, tool_payloads: list[str], *, reserve: int = 0, reserve_sentences: int = 0,
        names: list[str] | tuple[str, ...] = (), no_language: bool = False,
    ) -> str:
        """Over the turn's word (or sentence) limit, or talking about tags/searches/tools/filters:
        one low-effort rewrite covering both, kept only if it fixes them and every tool-backed
        number survives; else drop the internal sentences, then a sentence-boundary trim.
        Tables are left alone."""
        limit = max(10, result.word_limit - reserve) if result.word_limit else None
        sentences = max(1, result.sentence_limit - reserve_sentences) if result.sentence_limit else None
        if not limit or "\n|" in "\n" + text:
            return text
        if no_language:
            text = length_guard.strip_language_mentions(text)
        over = length_guard.over_limit(text, limit, sentences)
        internal = length_guard.has_internal_wording(text, names, language=no_language)
        if not over and not internal:
            return text
        if over:
            system = length_guard.REWRITE_INSTRUCTION.format(
                limit=limit, sentences=f" and {sentences} sentences" if sentences else ""
            ) + (" " + length_guard.NO_INTERNAL_INSTRUCTION if internal else "")
        else:
            system = length_guard.REWRITE_INTERNAL_ONLY
        if internal and no_language:
            system += " " + length_guard.NO_LANGUAGE_INSTRUCTION
        rewrite = ""
        try:
            response = await self.client.messages.create(
                model=self.config.model,
                max_tokens=length_guard.REWRITE_MAX_TOKENS,
                system=system,
                output_config={"effort": "low"},
                messages=[{"role": "user", "content": text}],
            )
            add_usage(result, getattr(response, "usage", None))
            if getattr(response, "stop_reason", None) == "end_turn":
                rewrite = _response_text(response).strip()
        except Exception as error:  # noqa: BLE001 - the trim below is the fallback
            logger.warning("assistant length rewrite failed: %s", type(error).__name__)
        backed = length_guard.tool_numbers(tool_payloads)
        shorter = not over or (
            not length_guard.over_limit(rewrite, limit, sentences)
            and (
                length_guard.word_count(rewrite) < length_guard.word_count(text)
                or length_guard.sentence_count(rewrite) < length_guard.sentence_count(text)
            )
        )
        if (
            rewrite
            and shorter
            and not (internal and length_guard.has_internal_wording(rewrite, names, language=no_language))
            and not (length_guard.has_disclaimer(text) and not length_guard.has_disclaimer(rewrite))
            and length_guard.keeps_numbers(text, rewrite, backed)
        ):
            result.length_guard = "rewrite"
            return rewrite
        if internal:
            text = length_guard.drop_internal_sentences(text, names, language=no_language)
        if length_guard.over_limit(text, limit, sentences):
            result.length_guard = "trim"
            return length_guard.trim_to_limit(text, limit, sentences)
        result.length_guard = "drop"
        return text

    @staticmethod
    def _account(result: TurnResult, response: Any) -> None:
        result.rounds += 1
        add_usage(result, getattr(response, "usage", None))

    async def _answer_now(self, messages: list[dict[str, Any]], result: TurnResult) -> Any | None:
        """One tools-off call after an empty final message; None if it fails."""
        last = messages[-1]
        content = last["content"] if isinstance(last["content"], list) else [{"type": "text", "text": last["content"]}]
        retry = [*messages[:-1], {**last, "content": [*content, {"type": "text", "text": ANSWER_NOW_NOTE}]}]
        try:
            response = await self._create(retry, final=True)
        except Exception as error:  # noqa: BLE001 - the generic error text is the fallback
            logger.warning("assistant answer-now call failed: %s", type(error).__name__)
            return None
        self._account(result, response)
        return response

    async def _run_tool(self, name: str, arguments: dict[str, Any], owner_user_id: str, writes: TurnWrites):
        return await asyncio.to_thread(
            self.toolbox.run, name, arguments, owner_user_id=owner_user_id, turn=writes
        )

    async def run_turn(
        self,
        *,
        owner_user_id: str,
        history: list[dict[str, str]],
        question: str,
        context: str | None = None,
        context_card_ids: list[str] | None = None,
        client_message_id: str | None = None,
    ) -> TurnResult:
        started = time.monotonic()
        messages = with_history_breakpoint(build_messages(history, question, context))
        result = TurnResult(text="", status="ok")
        writes = TurnWrites(client_message_id=client_message_id, question=question)
        executed_refs: list[dict[str, Any]] = []
        # Cards from proposals and get_card first (the specific answer), then the rest.
        primary_refs: list[dict[str, Any]] = []
        other_refs: list[dict[str, Any]] = []
        charts: list[dict[str, Any]] = []
        # Beyond this turn's results, show_cards may use scanned cards and earlier tiles.
        extra_refs = [{"card_id": card_id} for card_id in context_card_ids or []] + _history_refs(history)
        selection: list[dict[str, Any]] | None = None
        cards_label: str | None = None
        watchlist_ids: set[str] = set()
        watchlist_total: int | None = None
        sparkline_windows: dict[str, tuple[str, str | None]] = {}
        proposal_ids: set[str] = set()
        list_ids: set[str] = set()
        holding_refs: list[dict[str, Any]] = []
        language_pairs: dict[str, str] = {}
        tool_payloads: list[str] = []
        empty_flags: list[bool] = []
        history_empty: list[bool] = []
        art_search = False
        ask_which: str | None = None
        collection_totals: list[tuple[float, str | None]] = []
        # Substantive text the model wrote next to tool calls (raw, with any follow-ups block).
        earlier_texts: list[str] = []
        answered_with_selection = False
        free_selection_round_used = False
        response = None
        tool_rounds = 0
        while True:
            final = tool_rounds >= self.config.max_tool_rounds
            try:
                response = await self._create(messages, final=final)
            except Exception as error:  # noqa: BLE001 - SDK/network errors all mean "failed turn"
                logger.warning("assistant LLM call failed: %s", type(error).__name__)
                raise AssistantFailed("llm_call_failed", cost=result.cost_usd) from error
            self._account(result, response)
            if response.stop_reason != "tool_use" or final:
                break
            tool_uses = [block for block in response.content if getattr(block, "type", None) == "tool_use"]
            if not tool_uses:
                break
            # Full content back unchanged (thinking blocks stay valid in-turn).
            messages.append({"role": "assistant", "content": response.content})
            work = [block for block in tool_uses if block.name != SHOW_CARDS]
            arguments_by_id = {block.id: correct_tool_arguments(block.name, block.input, question) for block in work}
            writes.plan_round([block.name for block in work])
            outcomes = await asyncio.gather(
                *(self._run_tool(block.name, arguments_by_id[block.id], owner_user_id, writes) for block in work)
            )
            results_by_id: dict[str, dict[str, Any]] = {}
            for block, outcome in zip(work, outcomes):
                arguments = arguments_by_id[block.id]
                result.tools_used.append(block.name)
                result.tool_calls.append(summarize_tool_call(block.name, arguments))
                result.tool_inputs.append(tool_record(block.name, arguments, outcome.content, outcome.cards))
                # Guard numbers come from the full result; the model reads the compact copy.
                tool_payloads.append(json.dumps(outcome.content, default=str, separators=(",", ":")))
                results_by_id[block.id] = {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": model_payload(block.name, outcome.content, arguments),
                    **({"is_error": True} if outcome.is_error else {}),
                }
                empty = length_guard.is_empty_result(outcome.content, is_error=outcome.is_error)
                if block.name != "list_facets":
                    empty_flags.append(empty)
                if block.name == "get_price_history":
                    history_empty.append(empty)
                if block.name == "search_cards" and length_guard.is_art_search(arguments):
                    art_search = True
                if outcome.is_error:
                    result.tool_errors.append(block.name)
                if outcome.action is not None:
                    result.actions.append(outcome.action)
                    if outcome.action.get("state") == "done":
                        executed_refs.extend(outcome.cards)
                if outcome.chart is not None:
                    charts.append(outcome.chart)
                primary = block.name.startswith("propose_") or block.name in ("get_card", ADD_NOW_TOOL)
                (primary_refs if primary else other_refs).extend(outcome.cards)
                if outcome.action is not None:
                    proposal_ids.update(ref["card_id"] for ref in outcome.cards)
                if block.name in LIST_TOOLS:
                    list_ids.update(ref["card_id"] for ref in outcome.cards)
                content = outcome.content if isinstance(outcome.content, dict) else {}
                if block.name == "search_cards" and content.get("ambiguous") and content.get("ask_which"):
                    ask_which = str(content["ask_which"])
                total_key = {"get_my_collection": "total_value_usd", "get_portfolio_summary": "value_usd"}.get(block.name)
                if total_key and not outcome.is_error and isinstance(content.get(total_key), (int, float)):
                    collection_totals.append((float(content[total_key]), content.get("scope_label")))
                if block.name == "get_my_collection" and not outcome.is_error:
                    holding_refs.extend(outcome.cards)
                if block.name == "get_portfolio_summary" and not outcome.is_error:
                    holding_refs.extend(card_refs(content.get("top_holdings") or []))
                if block.name == "get_card" and not outcome.is_error and content.get("language_pair"):
                    language_pairs[str(content["card_id"])] = str(content["language_pair"])
                if block.name == "get_my_watchlist" and not outcome.is_error:
                    watchlist_ids.update(ref["card_id"] for ref in outcome.cards)
                    if isinstance(content.get("total_count"), int):
                        watchlist_total = content["total_count"]
                if block.name in SPARKLINE_TOOLS and not outcome.is_error:
                    spark_range = sparkline_fetch_range(block.name, content)
                    for ref in outcome.cards if spark_range else ():
                        sparkline_windows.setdefault(ref["card_id"], (spark_range, ref.get("variant")))
            # Selections resolve after this round's lookups, so a parallel call can name their cards.
            for block in tool_uses:
                if block.name != SHOW_CARDS:
                    continue
                result.tools_used.append(SHOW_CARDS)
                arguments = block.input if isinstance(block.input, dict) else {}
                selection, dropped = select_tiles(arguments.get("cards"), primary_refs + other_refs + extra_refs)
                cards_label = clean_label(arguments.get("label"))
                reply: dict[str, Any] = {"shown": len(selection)}
                if dropped:
                    reply["not_shown"] = dropped
                    reply["note"] = "Only cards from this turn's results, the scanned cards, or earlier answers can be shown."
                results_by_id[block.id] = {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(reply, separators=(",", ":")),
                }
            tool_results = [results_by_id[block.id] for block in tool_uses]
            # Answer text + show_cards in one message: that is the final answer, no extra round.
            if not work and any(
                getattr(block, "type", None) == "text" and str(getattr(block, "text", "")).strip()
                for block in response.content
            ):
                answered_with_selection = True
                break
            earlier_texts.append(_response_text(response))
            if not work and not free_selection_round_used:
                # A lone show_cards round (once) doesn't spend the lookup budget.
                free_selection_round_used = True
                messages.append({"role": "user", "content": tool_results})
                continue
            tool_rounds += 1
            if tool_rounds >= self.config.max_tool_rounds:
                tool_results.append({"type": "text", "text": ROUND_LIMIT_NOTE})
            messages.append({"role": "user", "content": tool_results})

        result.stop_reason = "end_turn" if answered_with_selection else getattr(response, "stop_reason", None)
        result.round_limit_hit = tool_rounds >= self.config.max_tool_rounds
        text, suggestions = split_suggestions(_response_text(response), result.stop_reason)
        text = strip_pseudo_calls(_ECHOED_NOTE.sub("", text)).strip()
        executed = [action for action in result.actions if action.get("state") == "done"]
        if result.stop_reason != "refusal":
            earlier = [part for part in (substantive_text(raw) for raw in earlier_texts) if part]
            if not suggestions:
                suggestions = next((s for raw in reversed(earlier_texts) if (s := split_suggestions(raw)[1])), [])
            text = merge_answer_parts([*earlier, text])
            if not text and not executed and result.stop_reason in ("end_turn", "tool_use"):
                retry = await self._answer_now(messages, result)
                if retry is not None and getattr(retry, "stop_reason", None) != "refusal":
                    result.stop_reason = getattr(retry, "stop_reason", None)
                    text, retry_suggestions = split_suggestions(_response_text(retry), result.stop_reason)
                    text = strip_pseudo_calls(_ECHOED_NOTE.sub("", text)).strip()
                    suggestions = retry_suggestions or suggestions
        if executed and (result.stop_reason == "refusal" or not text):
            # The write already happened: the reply must say so and carry Undo.
            result.text = "\n".join(f"{action['summary']}." for action in executed)
            result.actions = executed
        elif result.stop_reason == "refusal":
            result.text, result.status = REFUSAL_TEXT, "error"
            result.actions = []
        elif result.stop_reason == "max_tokens" and not text:
            result.text, result.status = TOO_LONG_TEXT, "error"
        elif not text:
            result.text, result.status = EMPTY_TEXT, "error"
        else:
            text = ensure_total_first(text, question, collection_totals)
            no_data = bool(empty_flags) and all(empty_flags) or bool(history_empty) and all(history_empty)
            looked_up = [name for name in result.tools_used if name != SHOW_CARDS]
            result.word_limit = length_guard.limit_for(question, looked_up, no_data=no_data, art_search=art_search)
            result.sentence_limit = length_guard.sentence_limit_for(
                question, looked_up, no_data=no_data, art_search=art_search
            )
            # The disclaimer goes in BEFORE the guard (whose trim keeps the 'not a prediction' line), so the
            # final text is within the limit; the appended choice question still reserves its words.
            if length_guard.needs_disclaimer(text, looked_up):
                text = length_guard.add_disclaimer(text)
            appended = ensure_choice_question(text, ask_which) != text
            reserve = length_guard.word_count(ask_which or "") if appended else 0
            text = await self._enforce_length(
                text, result, tool_payloads, reserve=reserve, reserve_sentences=int(appended),
                names=[str(ref["name"]) for ref in primary_refs + other_refs + extra_refs if ref.get("name")],
                no_language=(art_search or "list_facets" in looked_up) and not length_guard.asks_language(question),
            )
            if length_guard.needs_disclaimer(text, looked_up):
                # The guard dropped a model-worded disclaimer: re-add ours and re-trim around it.
                text = length_guard.add_disclaimer(text)
                words = max(10, (result.word_limit or 0) - reserve)
                sentences = max(1, result.sentence_limit - int(appended)) if result.sentence_limit else None
                if result.word_limit and length_guard.over_limit(text, words, sentences):
                    text = length_guard.trim_to_limit(text, words, sentences)
            text = ensure_choice_question(text, ask_which)
            result.text = text + ("…" if result.stop_reason == "max_tokens" else "")
            result.suggestions = suggestions
        if result.status == "ok":
            if executed_refs:
                # A direct add shows just the card it added, with the new quantity.
                selection, cards_label = executed_refs, None
            result.cards, result.cards_label, result.cards_view_all, result.charts = await asyncio.to_thread(
                lambda: self.toolbox.build_tiles(
                    owner_user_id=owner_user_id,
                    turn_refs=primary_refs + other_refs,
                    selection=selection,
                    label=cards_label,
                    text=result.text,
                    charts=_distinct_charts(charts),
                    watchlist_ids=watchlist_ids,
                    watchlist_total=watchlist_total,
                    sparkline_windows=sparkline_windows,
                    extra_refs=extra_refs,
                    keep_ids=set(context_card_ids or []),
                    always_ids=proposal_ids,
                    list_ids=list_ids,
                    question=question,
                    fixed=bool(executed_refs),
                    holding_refs=holding_refs,
                    language_pairs=language_pairs,
                    tools_used=set(result.tools_used),
                    art_search=art_search,
                )
            )
        result.latency_ms = int((time.monotonic() - started) * 1000)
        return result
