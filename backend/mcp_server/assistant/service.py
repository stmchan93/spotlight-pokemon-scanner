"""Assistant request handling: limits, idempotency, persistence around the
engine. Methods return (http_status, json_payload); routes.py only does HTTP."""

from __future__ import annotations

import asyncio
import logging
import weakref
from dataclasses import dataclass
from typing import Any

from mcp_server.assistant.analytics import EVENT_FEEDBACK, TurnAnalytics
from mcp_server.assistant.config import AssistantConfig
from mcp_server.assistant.direct_add import UndoUnavailable, undo_expired
from mcp_server.assistant import shared_answers
from mcp_server.assistant.engine import SYSTEM_PROMPT, AssistantEngine, AssistantFailed, cache_hit_ratio
from mcp_server.assistant.flags import flag_turn
from mcp_server.assistant.store import (
    FEEDBACK_NOTE_CHARS,
    FEEDBACK_RATINGS,
    FEEDBACK_REASONS,
    AssistantStore,
    next_utc_midnight,
    utc_day,
)
from mcp_server.assistant.tools import AssistantToolbox

logger = logging.getLogger("ekalight.assistant")

MAX_TEXT_CHARS = 1000
MAX_CONTEXT_CARDS = 20
MAX_CLIENT_ID_CHARS = 100
SOURCES = ("home", "scanner")
DIRECT_ADD_CAPABILITY = "direct_add"
# PostHog review table: enough text to judge an answer without opening the DB.
ANALYTICS_QUESTION_CHARS = 200
ANALYTICS_ANSWER_CHARS = 300


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
        analytics: TurnAnalytics | None = None,
    ) -> None:
        self.config = config
        self.analytics = analytics or TurnAnalytics.from_env()
        self.store = store
        self.toolbox = toolbox
        self.engine = engine
        # One turn at a time per user: keeps the limit check and the
        # client_message_id lookup race-free (single MCP process).
        self._locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()
        self.shared = shared_answers.SharedAnswerStore(lambda: self.store.conn)

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
            # Older app builds render any action as a Confirm card; a direct add
            # there would be added twice on Confirm, so they only get proposals.
            "direct_add": isinstance(capabilities := body.get("capabilities"), list)
            and DIRECT_ADD_CAPABILITY in capabilities,
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
        # A shared answer costs nothing, so it is served before the spend cap check.
        shared_key, shared_version, question_norm, knowledge_key = None, None, "", None
        if self.config.shared_answers and shared_answers.request_eligible(request):
            question_norm = shared_answers.normalize_question(request["text"])
            fingerprint = shared_answers.engine_fingerprint(self.config.model, SYSTEM_PROMPT)
            # Knowledge answers don't depend on prices, so they are looked up without a version read.
            knowledge_key = shared_answers.cache_key(
                question_norm, version=shared_answers.KNOWLEDGE_VERSION, fingerprint=fingerprint,
                scope=shared_answers.KNOWLEDGE_SCOPE,
            )
            cached = await asyncio.to_thread(self.shared.get, knowledge_key, shared_answers.KNOWLEDGE_VERSION)
            if cached is not None:
                return await self._send_cached(caller, request, cached, day)
            try:
                # Resolve the connection inside the worker: connections are per-thread
                # (check_same_thread), so one fetched on the loop thread fails there.
                shared_version = await asyncio.to_thread(lambda: shared_answers.data_version(self.store.conn))
            except Exception:  # noqa: BLE001 - the cache must never fail a question
                logger.exception("assistant shared answer version failed")
            if shared_version:
                shared_key = shared_answers.cache_key(question_norm, version=shared_version, fingerprint=fingerprint)
                cached = await asyncio.to_thread(self.shared.get, shared_key, shared_version)
                if cached is not None:
                    return await self._send_cached(caller, request, cached, day)
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
                owner_user_id=user_id, history=history, question=request["text"], context=context,
                context_card_ids=request["card_ids"],
                client_message_id=request["client_message_id"] if request["direct_add"] else None,
            )
        except AssistantFailed as failure:
            await asyncio.to_thread(self.store.record_failed_cost, user_id, day, failure.cost_usd)
            logger.info(
                "assistant_turn_failed user=%s source=%s cost_usd=%.6f", user_id, request["source"], failure.cost_usd
            )
            self.analytics.capture(
                user_id,
                {"status": "failed", "cost_usd": round(failure.cost_usd, 6), "source": request["source"],
                 "is_guest": caller.is_guest, "model": self.config.model,
                 "flags": ["refusal_or_error"], "flag_count": 1,
                 "question": request["text"][:ANALYTICS_QUESTION_CHARS], "thread_id": thread_id},
            )
            return 502, {"error": "assistant_failed"}

        try:
            flags = flag_turn(request["text"], turn, request)
        except Exception:  # noqa: BLE001 - review flags must never fail an answer
            logger.exception("assistant flag_turn failed")
            flags = []
        reply = {
            "flags": flags,
            "text": turn.text,
            "cards": turn.cards,
            "cards_label": turn.cards_label,
            "cards_view_all": turn.cards_view_all,
            "actions": turn.actions,
            "suggestions": turn.suggestions,
            "charts": turn.charts,
            "sets": turn.sets,
            "status": turn.status,
            "input_tokens": turn.input_tokens,
            "output_tokens": turn.output_tokens,
            "cache_read_tokens": turn.cache_read_tokens,
            "cache_write_tokens": turn.cache_write_tokens,
            "cost_usd": round(turn.cost_usd, 6),
            "tools_used": turn.tools_used,
            "tool_calls": turn.tool_calls,
        }
        try:
            if knowledge_key and shared_answers.knowledge_cacheable(request["text"], turn, flags):
                await asyncio.to_thread(
                    self.shared.put, knowledge_key, question_norm=question_norm,
                    version=shared_answers.KNOWLEDGE_VERSION, reply=shared_answers.shared_reply(turn),
                    ttl=shared_answers.KNOWLEDGE_TTL,
                )
            elif shared_key and shared_answers.turn_cacheable(turn, flags):
                await asyncio.to_thread(
                    self.shared.put, shared_key, question_norm=question_norm, version=shared_version,
                    reply=shared_answers.shared_reply(turn),
                )
        except Exception:  # noqa: BLE001
            logger.exception("assistant shared answer store failed")
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
            "assistant_turn user=%s source=%s status=%s stop=%s rounds=%d tools=%s in=%d out=%d cache_read=%d "
            "cache_write=%d cache_hit=%.2f cost_usd=%.6f latency_ms=%d flags=%s",
            user_id,
            request["source"],
            turn.status,
            turn.stop_reason,
            turn.rounds,
            ",".join(turn.tools_used) or "-",
            turn.input_tokens,
            turn.output_tokens,
            turn.cache_read_tokens,
            turn.cache_write_tokens,
            cache_hit_ratio(turn.input_tokens, turn.cache_read_tokens),
            turn.cost_usd,
            turn.latency_ms,
            ",".join(flags) or "-",
        )
        self.analytics.capture(
            user_id,
            {
                "status": turn.status,
                "cost_usd": round(turn.cost_usd, 6),
                "input_tokens": turn.input_tokens,
                "output_tokens": turn.output_tokens,
                "cache_read_tokens": turn.cache_read_tokens,
                "cache_write_tokens": turn.cache_write_tokens,
                "cache_hit_ratio": cache_hit_ratio(turn.input_tokens, turn.cache_read_tokens),
                "rounds": turn.rounds,
                "tools": list(turn.tools_used),
                "latency_ms": turn.latency_ms,
                "source": request["source"],
                "is_guest": caller.is_guest,
                "model": self.config.model,
                "flags": flags,
                "flag_count": len(flags),
                "question": request["text"][:ANALYTICS_QUESTION_CHARS],
                "answer_preview": turn.text[:ANALYTICS_ANSWER_CHARS],
                "thread_id": thread_id,
                "message_id": message["id"],
                "cached": False,
            },
        )
        return 200, {
            "thread_id": thread_id,
            "user_message": question,
            "message": message,
            "usage": await asyncio.to_thread(self._usage_sync, caller),
        }

    async def _send_cached(
        self, caller: Caller, request: dict[str, Any], cached: dict[str, Any], day: str
    ) -> tuple[int, dict[str, Any]]:
        """Replay a shared market answer: no LLM call, still a counted question."""
        user_id = caller.user_id
        reply = shared_answers.replay(cached)
        thread_id, question, message = await asyncio.to_thread(
            self.store.save_turn,
            user_id,
            thread_id=None,
            client_message_id=request["client_message_id"],
            question=request["text"],
            reply=reply,
            counted=True,
            day=day,
        )
        await asyncio.to_thread(self.store.mark_cached, user_id, message["id"])
        logger.info(
            "assistant_turn user=%s source=%s status=ok cached=1 tools=%s cost_usd=0",
            user_id, request["source"], ",".join(reply["tools_used"]) or "-",
        )
        self.analytics.capture(
            user_id,
            {
                "status": "ok",
                "cached": True,
                "cost_usd": 0.0,
                "input_tokens": 0,
                "output_tokens": 0,
                "rounds": 0,
                "tools": list(reply["tools_used"]),
                "latency_ms": 0,
                "source": request["source"],
                "is_guest": caller.is_guest,
                "model": self.config.model,
                "flags": [],
                "flag_count": 0,
                "question": request["text"][:ANALYTICS_QUESTION_CHARS],
                "answer_preview": reply["text"][:ANALYTICS_ANSWER_CHARS],
                "thread_id": thread_id,
                "message_id": message["id"],
            },
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

    def _undo_sync(self, user_id: str, action_id: str) -> tuple[int, dict[str, Any]]:
        found = self.store.find_action(user_id, action_id)
        if found is None:
            return NOT_FOUND
        message_id, actions, action = found
        if action.get("state") == "undone":
            return 200, {"action": action}
        if action.get("state") != "done" or action.get("type") != "add_to_collection" or not action.get("undo"):
            return 409, {"error": "not_undoable", "detail": "Only an add the assistant made can be undone."}
        if undo_expired(action):
            return 409, {"error": "undo_expired", "detail": "Undo is only available for 24 hours."}
        # State first: a crash between the two writes loses the undo instead of
        # letting a retry take the copies back twice.
        action["state"] = "undone"
        self.store.save_actions(user_id, message_id, actions)
        try:
            self.toolbox.undo_add(user_id, action)
        except Exception as error:
            action["state"] = "done"
            self.store.save_actions(user_id, message_id, actions)
            if isinstance(error, UndoUnavailable):
                return 409, {"error": "cannot_undo", "detail": str(error)}
            raise
        return 200, {"action": action}

    async def undo_action(self, caller: Caller, action_id: str) -> tuple[int, dict[str, Any]]:
        # Same per-user lock as turns: an undo never interleaves with a retried add.
        async with self._lock(caller.user_id):
            return await asyncio.to_thread(self._undo_sync, caller.user_id, action_id)

    # --- feedback ------------------------------------------------------------

    @staticmethod
    def _parse_feedback(body: Any) -> tuple[dict[str, Any] | None, tuple[int, dict[str, Any]] | None]:
        if not isinstance(body, dict) or "rating" not in body:
            return None, _bad("body must be an object with rating")
        rating = body.get("rating")
        if rating is not None and rating not in FEEDBACK_RATINGS:
            return None, _bad("rating must be up, down, or null")
        reason = body.get("reason")
        if reason is not None and reason not in FEEDBACK_REASONS:
            return None, _bad(f"reason must be one of {', '.join(FEEDBACK_REASONS)}")
        note = body.get("note")
        if note is not None and not isinstance(note, str):
            return None, _bad("note must be a string")
        note = (note or "").strip() or None
        if note is not None and len(note) > FEEDBACK_NOTE_CHARS:
            return None, _bad(f"note must be at most {FEEDBACK_NOTE_CHARS} characters")
        if rating is None:
            reason, note = None, None
        return {"rating": rating, "reason": reason, "note": note}, None

    async def set_feedback(self, caller: Caller, message_id: str, body: Any) -> tuple[int, dict[str, Any]]:
        parsed, error = self._parse_feedback(body)
        if error is not None:
            return error
        assert parsed is not None
        target = await asyncio.to_thread(self.store.feedback_target, caller.user_id, message_id)
        if target is None:
            return NOT_FOUND
        if target["role"] != "assistant":
            return _bad("only assistant messages take feedback")
        feedback, changed = await asyncio.to_thread(
            self.store.set_feedback, caller.user_id, message_id, target["thread_id"], **parsed
        )
        if changed:
            self.analytics.capture(caller.user_id, feedback_event_properties(target, parsed), EVENT_FEEDBACK)
        return 200, {"message_id": message_id, "feedback": feedback}


def _truncate(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def feedback_event_properties(target: dict[str, Any], parsed: dict[str, Any]) -> dict[str, Any]:
    """PostHog `assistant_feedback` properties (environment is added by TurnAnalytics)."""
    return {
        "rating": parsed["rating"],
        "reason": parsed["reason"],
        "message_id": target["id"],
        "thread_id": target["thread_id"],
        "tools": list(target["tools_used"]),
        "cost_usd": target["cost_usd"],
        "question": _truncate(target["question"], 200),
        "answer": _truncate(target["text"], 400),
    }
