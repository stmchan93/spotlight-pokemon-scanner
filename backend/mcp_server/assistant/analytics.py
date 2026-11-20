"""Server-side PostHog event per assistant turn, so chat cost is chartable.

Cost is only known here (token usage), not in the app. Fire-and-forget: a
PostHog outage must never slow or fail a chat answer.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger("ekalight.assistant")

EVENT_TURN = "assistant_turn_cost"


class TurnAnalytics:
    def __init__(self, *, api_key: str | None, host: str, environment: str) -> None:
        self.api_key = api_key
        self.host = host.rstrip("/")
        self.environment = environment
        self._tasks: set[asyncio.Task] = set()

    @classmethod
    def from_env(cls) -> "TurnAnalytics":
        return cls(
            api_key=(os.environ.get("ASSISTANT_POSTHOG_API_KEY") or "").strip() or None,
            host=(os.environ.get("ASSISTANT_POSTHOG_HOST") or "https://us.i.posthog.com").strip(),
            environment=(os.environ.get("ASSISTANT_ANALYTICS_ENV") or "unknown").strip(),
        )

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def payload(self, distinct_id: str, properties: dict[str, Any]) -> dict[str, Any]:
        return {
            "api_key": self.api_key,
            "event": EVENT_TURN,
            "distinct_id": distinct_id,
            "properties": {"environment": self.environment, **properties},
        }

    def capture(self, distinct_id: str, properties: dict[str, Any]) -> None:
        if not self.enabled:
            return
        try:
            task = asyncio.get_running_loop().create_task(self._send(self.payload(distinct_id, properties)))
        except RuntimeError:  # no loop (sync callers/tests): skip rather than block
            return
        self._tasks.add(task)  # keep a reference so the task isn't GC'd mid-flight
        task.add_done_callback(self._tasks.discard)

    async def _send(self, body: dict[str, Any]) -> None:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(f"{self.host}/i/v0/e/", json=body)
        except Exception as error:  # noqa: BLE001 - analytics must never break chat
            logger.info("assistant analytics send failed: %s", type(error).__name__)
