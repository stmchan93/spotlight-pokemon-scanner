"""One assistant turn: Messages API manual tool loop over AssistantToolbox.

Haiku 5.5 runs adaptive thinking by default, so `thinking` is omitted; each
response's full content (thinking blocks included) is appended unchanged
within the turn. Only text is persisted across turns.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from mcp_server.assistant.config import AssistantConfig, cost_usd
from mcp_server.assistant.tools import TOOL_DEFINITIONS, AssistantToolbox

logger = logging.getLogger("ekalight.assistant")

SYSTEM_PROMPT = """You are Ekalight's card assistant inside the Ekalight app. You help collectors with their Pokémon (and other TCG) card collection, card prices, what they're missing, and finding cards.
- Use the tools for every fact about cards, prices, or the user's collection. Never invent a card, price, or holding. If a price is null, say Ekalight has no price for it.
- Prices are USD from Ekalight's daily market data, not live. Never show yen or other currencies.
- Call the user's watched cards their "Watchlist" (never "wishlist").
- To change anything (add a card, change quantity/condition, watch a card or set a price alert), call a propose_* tool. The user must tap Confirm. Never say it's done; say it's ready to confirm.
- You can't delete cards, sell, list, or buy. Say so briefly.
- Off-topic requests (not cards/collecting/this app): decline in one sentence.
- Be brief: 1-4 short sentences or a short list. Plain text; **bold** and "- " bullet lines are fine, no headings or tables. The app shows card tiles for cards you looked up, so don't repeat every detail."""

REFUSAL_TEXT = "Sorry, I can't help with that one. Ask me about your cards, prices, or collection."
TOO_LONG_TEXT = "That answer ran too long. Try a narrower question."
EMPTY_TEXT = "Sorry, I couldn't put an answer together. Try asking again."
ROUND_LIMIT_NOTE = "Tool budget for this question is used up. Answer now with what you have."


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
    tools_used: list[str] = field(default_factory=list)
    rounds: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    stop_reason: str | None = None


def _tools_payload() -> list[dict[str, Any]]:
    tools = copy.deepcopy(TOOL_DEFINITIONS)
    tools[-1]["cache_control"] = {"type": "ephemeral"}
    return tools


TOOLS_PAYLOAD = _tools_payload()
SYSTEM_PAYLOAD = [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]


def build_messages(history: list[dict[str, str]], question: str, context: str | None) -> list[dict[str, Any]]:
    """Text-only history (must start with a user turn) + this question."""
    messages: list[dict[str, Any]] = []
    for item in history:
        role = item["role"] if item["role"] in ("user", "assistant") else None
        text = str(item.get("text") or "").strip()
        if role is None or not text:
            continue
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
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(outcome.content, default=str, separators=(",", ":")),
                        **({"is_error": True} if outcome.is_error else {}),
                    }
                )
                if outcome.action is not None:
                    result.actions.append(outcome.action)
                (primary_refs if block.name.startswith("propose_") or block.name == "get_card" else other_refs).extend(
                    outcome.cards
                )
            tool_rounds += 1
            if tool_rounds >= self.config.max_tool_rounds:
                tool_results.append({"type": "text", "text": ROUND_LIMIT_NOTE})
            messages.append({"role": "user", "content": tool_results})

        result.stop_reason = getattr(response, "stop_reason", None)
        text = "\n\n".join(
            str(block.text).strip()
            for block in (response.content or [])
            if getattr(block, "type", None) == "text" and str(getattr(block, "text", "")).strip()
        )
        if result.stop_reason == "refusal":
            result.text, result.status = REFUSAL_TEXT, "error"
            result.actions = []
        elif result.stop_reason == "max_tokens" and not text:
            result.text, result.status = TOO_LONG_TEXT, "error"
        elif not text:
            result.text, result.status = EMPTY_TEXT, "error"
        else:
            result.text = text + ("…" if result.stop_reason == "max_tokens" else "")
        if result.status == "ok":
            result.cards = await asyncio.to_thread(self.toolbox.finalize_cards, primary_refs + other_refs)
        result.latency_ms = int((time.monotonic() - started) * 1000)
        return result
