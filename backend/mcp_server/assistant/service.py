"""Assistant request handling: limits, idempotency, persistence around the
engine. Methods return (http_status, json_payload); routes.py only does HTTP."""

from __future__ import annotations

import asyncio
import logging
import weakref
from dataclasses import dataclass
from typing import Any

from mcp_server.assistant.config import AssistantConfig
from mcp_server.assistant.engine import AssistantEngine, AssistantFailed
from mcp_server.assistant.store import AssistantStore, next_utc_midnight, utc_day
from mcp_server.assistant.tools import AssistantToolbox

logger = logging.getLogger("ekalight.assistant")

MAX_TEXT_CHARS = 1000
MAX_CONTEXT_CARDS = 20
MAX_CLIENT_ID_CHARS = 100
SOURCES = ("home", "scanner")


@dataclass(frozen=True)
class Caller:
    user_id: str
    is_guest: bool


def _bad(detail: str) -> tuple[int, dict[str, Any]]:
    return 400, {"error": "invalid_request", "detail": detail}


NOT_FOUND = (404, {"error": "not_found"})


class AssistantService:
    def __init__(
        self,
        config: AssistantConfig,
        store: AssistantStore,
        toolbox: AssistantToolbox,
        engine: AssistantEngine | None,
    ) -> None:
        self.config = config
        self.store = store
        self.toolbox = toolbox
        self.engine = engine
        # One turn at a time per user: keeps the limit check and the
        # client_message_id lookup race-free (single MCP process).
        self._locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()

    @property
    def available(self) -> bool:
        return self.config.enabled and self.engine is not None

    def _lock(self, user_id: str) -> asyncio.Lock:
        lock = self._locks.get(user_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[user_id] = lock
        return lock

    # --- usage ---------------------------------------------------------------

    def _usage_sync(self, caller: Caller) -> dict[str, Any]:
        limit = self.config.limit_for(caller.user_id, is_guest=caller.is_guest)
        used, _ = self.store.usage_row(caller.user_id, utc_day())
        return {
            "limit": limit,
            "used_today": used,
            "remaining_today": None if limit is None else max(0, limit - used),
            "resets_at": next_utc_midnight(),
            "is_guest": caller.is_guest,
        }

    async def usage(self, caller: Caller) -> tuple[int, dict[str, Any]]:
        return 200, await asyncio.to_thread(self._usage_sync, caller)

    # --- messages ------------------------------------------------------------

    @staticmethod
    def _parse_message_body(body: Any) -> tuple[dict[str, Any] | None, tuple[int, dict[str, Any]] | None]:
        if not isinstance(body, dict):
            return None, _bad("body must be a JSON object")
        thread_id = body.get("thread_id")
        if thread_id is not None and (not isinstance(thread_id, str) or not thread_id.strip()):
            return None, _bad("thread_id must be a string or null")
        client_message_id = body.get("client_message_id")
        if not isinstance(client_message_id, str) or not client_message_id.strip():
            return None, _bad("client_message_id is required")
        if len(client_message_id) > MAX_CLIENT_ID_CHARS:
            return None, _bad("client_message_id is too long")
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            return None, _bad("text is required")
        text = text.strip()
        if len(text) > MAX_TEXT_CHARS:
            return None, _bad(f"text must be at most {MAX_TEXT_CHARS} characters")
        context = body.get("context") or {}
        if not isinstance(context, dict):
            return None, _bad("context must be an object")
        source = context.get("source")
        if source is not None and source not in SOURCES:
            return None, _bad("context.source must be home or scanner")
        card_ids = context.get("card_ids") or []
        if not isinstance(card_ids, list) or not all(isinstance(item, str) for item in card_ids):
            return None, _bad("context.card_ids must be a list of card ids")
        if len(card_ids) > MAX_CONTEXT_CARDS:
            return None, _bad(f"context.card_ids holds at most {MAX_CONTEXT_CARDS} ids")
        card_ids = list(dict.fromkeys(item.strip() for item in card_ids if item.strip()))
        return {
            "thread_id": thread_id.strip() if thread_id else None,
            "client_message_id": client_message_id.strip(),
            "text": text,
            "source": source or "home",
            "card_ids": card_ids,
        }, None

    async def send(self, caller: Caller, body: Any) -> tuple[int, dict[str, Any]]:
        if not self.available:
            return 503, {"error": "assistant_disabled"}
        request, error = self._parse_message_body(body)
        if error is not None:
            return error
        assert request is not None
        async with self._lock(caller.user_id):
            return await self._send_locked(caller, request)

    async def _send_locked(self, caller: Caller, request: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        user_id = caller.user_id
        replay = await asyncio.to_thread(self.store.find_turn, user_id, request["client_message_id"])
        if replay is not None:
            question, reply = replay
            return 200, {
                "thread_id": reply["thread_id"],
                "user_message": question,
                "message": reply,
                "usage": await asyncio.to_thread(self._usage_sync, caller),
            }

        thread_id = request["thread_id"]
        if thread_id is not None and await asyncio.to_thread(self.store.owned_thread, user_id, thread_id) is None:
            return NOT_FOUND

        day = utc_day()
        usage = await asyncio.to_thread(self._usage_sync, caller)
        if usage["limit"] is not None and usage["used_today"] >= usage["limit"]:
            return 429, {"error": "daily_limit", "usage": usage}
        spent = await asyncio.to_thread(self.store.spend_today, day)
        if spent >= self.config.daily_spend_cap_usd:
            logger.warning("assistant daily spend cap reached: %.4f >= %.2f", spent, self.config.daily_spend_cap_usd)
            return 503, {"error": "assistant_busy"}

        history = await asyncio.to_thread(self.store.history, user_id, thread_id) if thread_id else []
        context = (
            await asyncio.to_thread(self.toolbox.scanner_context, request["card_ids"]) if request["card_ids"] else None
        )
        assert self.engine is not None
        try:
            turn = await self.engine.run_turn(
                owner_user_id=user_id, history=history, question=request["text"], context=context
            )
        except AssistantFailed as failure:
            await asyncio.to_thread(self.store.record_failed_cost, user_id, day, failure.cost_usd)
            logger.info(
                "assistant_turn_failed user=%s source=%s cost_usd=%.6f", user_id, request["source"], failure.cost_usd
            )
            return 502, {"error": "assistant_failed"}

        reply = {
            "text": turn.text,
            "cards": turn.cards,
            "actions": turn.actions,
            "suggestions": turn.suggestions,
            "charts": turn.charts,
            "status": turn.status,
            "input_tokens": turn.input_tokens,
            "output_tokens": turn.output_tokens,
            "cost_usd": round(turn.cost_usd, 6),
            "tools_used": turn.tools_used,
        }
        thread_id, question, message = await asyncio.to_thread(
            self.store.save_turn,
            user_id,
            thread_id=thread_id,
            client_message_id=request["client_message_id"],
            question=request["text"],
            reply=reply,
            counted=turn.status == "ok",
            day=day,
        )
        logger.info(
            "assistant_turn user=%s source=%s status=%s stop=%s rounds=%d tools=%s in=%d out=%d cost_usd=%.6f "
            "latency_ms=%d",
            user_id,
            request["source"],
            turn.status,
            turn.stop_reason,
            turn.rounds,
            ",".join(turn.tools_used) or "-",
            turn.input_tokens,
            turn.output_tokens,
            turn.cost_usd,
            turn.latency_ms,
        )
        return 200, {
            "thread_id": thread_id,
            "user_message": question,
            "message": message,
            "usage": await asyncio.to_thread(self._usage_sync, caller),
        }

    # --- threads -------------------------------------------------------------

    @staticmethod
    def _int_param(raw: str | None, *, default: int, maximum: int) -> int | None:
        if raw in (None, ""):
            return default
        try:
            value = int(raw)
        except ValueError:
            return None
        return value if 1 <= value <= maximum else None

    async def list_threads(self, caller: Caller, *, limit: str | None, cursor: str | None) -> tuple[int, dict[str, Any]]:
        size = self._int_param(limit, default=20, maximum=100)
        if size is None:
            return _bad("limit must be 1..100")
        try:
            return 200, await asyncio.to_thread(self.store.list_threads, caller.user_id, limit=size, cursor=cursor)
        except ValueError as error:
            return _bad(str(error))

    async def thread_messages(
        self, caller: Caller, thread_id: str, *, limit: str | None, before: str | None
    ) -> tuple[int, dict[str, Any]]:
        size = self._int_param(limit, default=50, maximum=200)
        if size is None:
            return _bad("limit must be 1..200")
        try:
            messages = await asyncio.to_thread(
                self.store.thread_messages, caller.user_id, thread_id, limit=size, before=before or None
            )
        except ValueError as error:
            return _bad(str(error))
        if messages is None:
            return NOT_FOUND
        return 200, {"messages": messages}

    async def delete_thread(self, caller: Caller, thread_id: str) -> tuple[int, dict[str, Any]]:
        deleted = await asyncio.to_thread(self.store.delete_thread, caller.user_id, thread_id)
        return (200, {"deleted": True}) if deleted else NOT_FOUND

    async def delete_all_threads(self, caller: Caller) -> tuple[int, dict[str, Any]]:
        return 200, {"deleted": await asyncio.to_thread(self.store.delete_all_threads, caller.user_id)}

    async def set_action_state(self, caller: Caller, action_id: str, body: Any) -> tuple[int, dict[str, Any]]:
        state = body.get("state") if isinstance(body, dict) else None
        if state not in ("confirmed", "dismissed"):
            return _bad("state must be confirmed or dismissed")
        try:
            action = await asyncio.to_thread(self.store.set_action_state, caller.user_id, action_id, state)
        except ValueError as error:
            return 409, {"error": "invalid_state", "detail": str(error)}
        if action is None:
            return NOT_FOUND
        return 200, {"action": action}
