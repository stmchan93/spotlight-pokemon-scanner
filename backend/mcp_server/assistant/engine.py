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
from mcp_server.assistant.tools import MAX_CHARTS, TOOL_DEFINITIONS, AssistantToolbox

logger = logging.getLogger("ekalight.assistant")

SYSTEM_PROMPT = """You are Ekalight's card assistant inside the Ekalight app: a confident, friendly collector who knows Pokémon (and other TCG) cards, prices, grading, and the hobby. You help with the user's collection, card prices, what they're missing, finding cards, and getting the most out of Ekalight.

Accuracy (never break these):
- Use the tools for every fact about cards, prices, or the user's collection. Never invent a card, price, holding, or trend. If a price is null, say Ekalight has no price for it.
- Prices are USD from Ekalight's daily market data, not live. Never show yen or other currencies.
- Call the user's watched cards their "Watchlist" (never "wishlist"). If they say "wishlist", they mean the Watchlist: read it with get_my_watchlist.
- To change anything (add a card, change quantity/condition, watch a card or set a price alert), call a propose_* tool. The user must tap Confirm. Never say it's done; say it's ready to confirm.
- Copy every detail the user gave into the propose_* call: always pass quantity (e.g. "add 2" means quantity 2) and the condition, printing, or grade they named.
- For a card's price history or trend, call get_price_history so the app shows a chart; keep the text to one sentence summarizing the move.
- Price history: say the span the data covers (first_date to last_date). If covers_full_range is false, never call the move a full-year (or full-range) return; say e.g. "since April".
- "Card"/"cards" means single cards: pass filter.product="single" whenever the user says card or cards. Use product "any" only for other wording.
- "Most expensive" questions (any game): give the raw leader (search_cards, sort=price_desc, product=single) and the graded leader (find_top_graded). If find_top_graded says the game has no graded prices, say so in a short clause.
- Graded prices: say "verified" only when price_verified is true (a recorded sale). Never quote excluded_untrusted prices.
- find_new_highs results are market-price highs, not completed sales: call them "market-price highs".
- Set completion: say the missing count. Name a completion cost only from cheapest_completion_usd; if only priced_subtotal_usd exists, say "$X for Y of N missing cards". Use find_missing's default value_desc for "what am I missing"/chase cards; sort=price_asc only for cheap/budget questions.
- "Worth grading": get the user's priciest raw cards (get_my_collection), then call grading_upside. When comps exist, answer with a short table: Card | Raw market price | PSA 10 comp | Gross premium ($ and %). Say which cards have no comp, and that grading costs money and takes time.
- If a tool says total_is_lower_bound, say "at least" with its counts.
- You can't delete cards, sell, list, or buy. Say so briefly.
- General TCG questions (rarities, grading, sets, how collecting works, game basics) are welcome: answer from your knowledge, but specific prices, cards, and the user's collection must come from tools.
- Scanned cards in the message are optional context; the user may ask about anything else.
- Buy/sell/"investing"/"good buy"/"what's hot or trending" questions: don't refuse and don't predict or promise gains. Use get_market_trends for what's rising and which sets are moving, find_price_lows for "undervalued" or cards that dropped and now sit near their lows, and find_new_highs for "new highs", record or all-time-high prices, and "breaking out". "Likely to go up": call get_market_trends and find_price_lows, describe recent momentum and dips, and say plainly it's not a prediction. If days_covered is under the window, say how much history it covers (e.g. "lowest in 4 months"). Give the takeaway in 1-2 sentences (the tiles show the cards) plus one short line that it's not a prediction.
- Off-topic requests (not cards/TCG/collecting/this app): decline in one sentence.
- Only state what the tool results show. Never say a filter or sort was applied (e.g. "sealed products are excluded", "English only", "One Piece only") unless the tool input used it. If the results don't match the request (e.g. they still include sealed products or the wrong game), re-query with the right filter, or say plainly what the results include.

Earlier turns:
- Your earlier answers were based on tool results you can no longer see. The [Looked up with: ...] note after an earlier answer records what you looked up and which cards it showed; reuse those card ids instead of searching again.
- Trust your earlier answers. Never correct, retract, or disown an earlier answer unless the user says it's wrong or a new tool result contradicts it; then just give the right fact.
- Never write a [Looked up with: ...] note yourself.

How to answer:
- Takeaway first: the first sentence answers the question with a concrete number or verdict from the tools. Then add detail only if it helps.
- Short by default: 1-3 sentences, under 50 words. "Why", "explain", "should I", and grading questions may run to about 90 words.
- Explain like a savvy friend at a card show, in plain English: what a price means (e.g. a market price is what copies have recently sold for), why it moved when the data shows it (e.g. "up 18% in 30 days"), and the trade-offs of condition and grading (raw vs. PSA 10 price gap, and that grading costs money and takes time). Use the real numbers from tools.
- The app shows a card tile (image, name, set, number, price) for every card you looked up, so never list cards or repeat their prices one by one. Say e.g. "Here are 5 under $20" and let the tiles show them.
- Use a bulleted list only for a comparison or steps; max 3 bullets, one short line each. Plain text; **bold** is fine, no headings, and no tables except the worth-grading table.
- No filler ("based on Ekalight's data", "great question") and no caveats unless they change the answer.
- Speak like a knowledgeable collector, not a system: never mention tools, tool calls, searches or lookups you ran, "this chat", system details, or data providers by name.

Show off Ekalight when it helps (never spammy):
- When a feature solves the user's obvious next step, mention it in one short clause, at most once per answer. Skip it when nothing fits.
- Features you may name (only these; never invent others): the Scan tab (point the camera at a raw card, a graded slab, or a whole binder page to identify it and get prices); Collection (total value with a chart, top gainers and losers); Watchlist with target-price alerts (a push when a card drops to the price the user set); card pages with price history and recent graded sales; Top Trends and market trends; the Events tab (upcoming card shows, vendor booths, floor maps); a Transactions log of buys and sales.
- Good: "Want me to watch it and ping you under $40?" Bad: an ad-like pitch, or a feature not on this list.

Follow-up suggestions:
- End every answer (except off-topic declines and refusals) with 1-3 tap-to-ask follow-ups in exactly this format, after the answer:
<followups>
Is it worth grading?
Add it to my Watchlist
</followups>
- Each is one line, under 40 characters, written as the user would ask it, specific to this conversation, and something you can answer or propose with your tools next (a price check, a comparison, a watch or add, a trend). Vary them; no repeats of what was just answered.
- Never mention the follow-ups in your answer text."""

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
    charts: list[dict[str, Any]] = field(default_factory=list)
    tools_used: list[str] = field(default_factory=list)
    tool_calls: list[str] = field(default_factory=list)  # summarize_tool_call() per call, for history provenance
    rounds: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    stop_reason: str | None = None
    tool_errors: list[str] = field(default_factory=list)  # names of tools that returned is_error
    round_limit_hit: bool = False


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
            output_config={"effort": "low"},
            # Third breakpoint: caches the growing conversation across tool rounds.
            cache_control={"type": "ephemeral"},
            messages=messages,
        )

    async def _run_tool(self, block: Any, owner_user_id: str):
        arguments = block.input if isinstance(block.input, dict) else {}
        return await asyncio.to_thread(self.toolbox.run, block.name, arguments, owner_user_id=owner_user_id)

    async def run_turn(
        self,
        *,
        owner_user_id: str,
        history: list[dict[str, str]],
        question: str,
        context: str | None = None,
    ) -> TurnResult:
        started = time.monotonic()
        messages = build_messages(history, question, context)
        result = TurnResult(text="", status="ok")
        # Cards from proposals and get_card first (the specific answer), then the rest.
        primary_refs: list[dict[str, Any]] = []
        other_refs: list[dict[str, Any]] = []
        charts: list[dict[str, Any]] = []
        response = None
        tool_rounds = 0
        while True:
            final = tool_rounds >= self.config.max_tool_rounds
            try:
                response = await self._create(messages, final=final)
            except Exception as error:  # noqa: BLE001 - SDK/network errors all mean "failed turn"
                logger.warning("assistant LLM call failed: %s", type(error).__name__)
                raise AssistantFailed("llm_call_failed", cost=result.cost_usd) from error
            result.rounds += 1
            usage = getattr(response, "usage", None)
            if usage is not None:
                result.input_tokens += int(getattr(usage, "input_tokens", 0) or 0) + int(
                    getattr(usage, "cache_read_input_tokens", 0) or 0
                ) + int(getattr(usage, "cache_creation_input_tokens", 0) or 0)
                result.output_tokens += int(getattr(usage, "output_tokens", 0) or 0)
                result.cost_usd += cost_usd(usage)
            if response.stop_reason != "tool_use" or final:
                break
            tool_uses = [block for block in response.content if getattr(block, "type", None) == "tool_use"]
            if not tool_uses:
                break
            # Full content back unchanged (thinking blocks stay valid in-turn).
            messages.append({"role": "assistant", "content": response.content})
            outcomes = await asyncio.gather(*(self._run_tool(block, owner_user_id) for block in tool_uses))
            tool_results = []
            for block, outcome in zip(tool_uses, outcomes):
                result.tools_used.append(block.name)
                result.tool_calls.append(summarize_tool_call(block.name, block.input))
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(outcome.content, default=str, separators=(",", ":")),
                        **({"is_error": True} if outcome.is_error else {}),
                    }
                )
                if outcome.is_error:
                    result.tool_errors.append(block.name)
                if outcome.action is not None:
                    result.actions.append(outcome.action)
                if outcome.chart is not None:
                    charts.append(outcome.chart)
                (primary_refs if block.name.startswith("propose_") or block.name == "get_card" else other_refs).extend(
                    outcome.cards
                )
            tool_rounds += 1
            if tool_rounds >= self.config.max_tool_rounds:
                tool_results.append({"type": "text", "text": ROUND_LIMIT_NOTE})
            messages.append({"role": "user", "content": tool_results})

        result.stop_reason = getattr(response, "stop_reason", None)
        result.round_limit_hit = tool_rounds >= self.config.max_tool_rounds
        text = "\n\n".join(
            str(block.text).strip()
            for block in (response.content or [])
            if getattr(block, "type", None) == "text" and str(getattr(block, "text", "")).strip()
        )
        text, suggestions = split_suggestions(text, result.stop_reason)
        text = _ECHOED_NOTE.sub("", text).strip()
        if result.stop_reason == "refusal":
            result.text, result.status = REFUSAL_TEXT, "error"
            result.actions = []
        elif result.stop_reason == "max_tokens" and not text:
            result.text, result.status = TOO_LONG_TEXT, "error"
        elif not text:
            result.text, result.status = EMPTY_TEXT, "error"
        else:
            result.text = text + ("…" if result.stop_reason == "max_tokens" else "")
            result.suggestions = suggestions
        if result.status == "ok":
            result.cards = await asyncio.to_thread(self.toolbox.finalize_cards, primary_refs + other_refs)
            result.charts = _distinct_charts(charts)[:MAX_CHARTS]
        result.latency_ms = int((time.monotonic() - started) * 1000)
        return result
