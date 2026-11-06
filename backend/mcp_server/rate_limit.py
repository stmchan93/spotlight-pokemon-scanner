"""Per-user call limits: a token bucket (per minute) plus a UTC-day counter.

In-process only. With more than one MCP worker process each keeps its own
counters, so the effective limit is N x the configured one — run one process
(the VM script does) or move this to a shared store before scaling out.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable


@dataclass
class _UserState:
    tokens: float
    refilled_at: float
    day: str
    day_count: int


class RateLimitExceeded(RuntimeError):
    pass


class UserRateLimiter:
    def __init__(
        self,
        *,
        per_minute: int = 60,
        per_day: int = 2000,
        clock: Callable[[], float] = time.monotonic,
        day_clock: Callable[[], str] | None = None,
        max_users: int = 50_000,
    ) -> None:
        self.per_minute = max(1, int(per_minute))
        self.per_day = max(1, int(per_day))
        self._clock = clock
        self._day_clock = day_clock or (lambda: datetime.now(timezone.utc).date().isoformat())
        self._max_users = max_users
        self._states: dict[str, _UserState] = {}
        self._lock = threading.Lock()

    def check(self, user_id: str) -> None:
        """Consume one call for `user_id` or raise RateLimitExceeded."""
        now = self._clock()
        today = self._day_clock()
        rate = self.per_minute / 60.0
        with self._lock:
            state = self._states.get(user_id)
            if state is None:
                if len(self._states) >= self._max_users:
                    # Bounded memory: drop everyone idle long enough to be full again.
                    cutoff = now - 60.0
                    self._states = {
                        key: value for key, value in self._states.items() if value.refilled_at > cutoff
                    }
                state = _UserState(tokens=float(self.per_minute), refilled_at=now, day=today, day_count=0)
                self._states[user_id] = state
            if state.day != today:
                state.day = today
                state.day_count = 0
            state.tokens = min(float(self.per_minute), state.tokens + (now - state.refilled_at) * rate)
            state.refilled_at = now
            if state.day_count >= self.per_day:
                raise RateLimitExceeded(
                    f"Daily limit reached ({self.per_day} Ekalight tool calls per day). Try again tomorrow (UTC)."
                )
            if state.tokens < 1.0:
                wait = (1.0 - state.tokens) / rate
                raise RateLimitExceeded(
                    f"Rate limit reached ({self.per_minute} calls per minute). Retry in {wait:.0f}s."
                )
            state.tokens -= 1.0
            state.day_count += 1
