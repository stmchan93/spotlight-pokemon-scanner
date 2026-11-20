"""Env config for the in-app assistant (docs/ai-chat-contracts-2026-11-17.md)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

DEFAULT_MODEL = "claude-haiku-5-5"

# Claude Haiku 5.5, USD per million tokens (prompts under 100K tokens).
INPUT_USD_PER_MTOK = 0.10
OUTPUT_USD_PER_MTOK = 0.50
CACHE_READ_MULTIPLIER = 0.10
CACHE_WRITE_MULTIPLIER = 1.25


def _env_flag(name: str, default: bool = False) -> bool:
    value = str(os.environ.get(name) or "").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(str(os.environ.get(name) or "").strip() or default)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(str(os.environ.get(name) or "").strip() or default)
    except ValueError:
        return default


def _env_ids(name: str) -> frozenset[str]:
    return frozenset(item.strip() for item in (os.environ.get(name) or "").split(",") if item.strip())


def _env_effort() -> str:
    value = (os.environ.get("ASSISTANT_EFFORT") or "low").strip().lower()
    return value if value in ("low", "medium", "high") else "low"


@dataclass(frozen=True)
class AssistantConfig:
    enabled: bool = False
    model: str = DEFAULT_MODEL
    daily_limit: int = 3
    guest_daily_limit: int = 1
    unlimited_user_ids: frozenset[str] = field(default_factory=frozenset)
    # Staging: no per-user limit for anyone; the spend cap still applies.
    unlimited_all: bool = False
    daily_spend_cap_usd: float = 5.0
    max_tool_rounds: int = 4
    max_output_tokens: int = 4000
    # Haiku 5.5 effort: low|medium|high. Trades instruction-following for latency/cost.
    effort: str = "low"
    request_timeout_seconds: float = 60.0
    api_key: str | None = None
    # Replay market-wide answers across users (shared_answers.py); ASSISTANT_SHARED_ANSWERS=0 kills it.
    shared_answers: bool = True

    @classmethod
    def from_env(cls) -> "AssistantConfig":
        return cls(
            enabled=_env_flag("ASSISTANT_ENABLED"),
            model=(os.environ.get("ASSISTANT_MODEL") or DEFAULT_MODEL).strip(),
            daily_limit=max(0, _env_int("ASSISTANT_DAILY_LIMIT", 3)),
            guest_daily_limit=max(0, _env_int("ASSISTANT_GUEST_DAILY_LIMIT", 1)),
            unlimited_user_ids=_env_ids("ASSISTANT_UNLIMITED_USER_IDS"),
            unlimited_all=_env_flag("ASSISTANT_UNLIMITED_ALL"),
            daily_spend_cap_usd=max(0.0, _env_float("ASSISTANT_DAILY_SPEND_CAP_USD", 5.0)),
            max_tool_rounds=max(1, _env_int("ASSISTANT_MAX_TOOL_ROUNDS", 4)),
            max_output_tokens=max(256, _env_int("ASSISTANT_MAX_OUTPUT_TOKENS", 4000)),
            effort=_env_effort(),
            api_key=(os.environ.get("ANTHROPIC_API_KEY") or "").strip() or None,
            shared_answers=_env_flag("ASSISTANT_SHARED_ANSWERS", True),
        )

    def limit_for(self, user_id: str, *, is_guest: bool) -> int | None:
        """Questions per UTC day; None = unlimited."""
        if self.unlimited_all or user_id in self.unlimited_user_ids:
            return None
        return self.guest_daily_limit if is_guest else self.daily_limit


def cost_usd(usage: object) -> float:
    """Cost of one Messages API response from its `usage` block."""

    def tokens(name: str) -> int:
        value = getattr(usage, name, None)
        return int(value) if isinstance(value, (int, float)) else 0

    per_input = INPUT_USD_PER_MTOK / 1_000_000
    return (
        tokens("input_tokens") * per_input
        + tokens("cache_read_input_tokens") * per_input * CACHE_READ_MULTIPLIER
        + tokens("cache_creation_input_tokens") * per_input * CACHE_WRITE_MULTIPLIER
        + tokens("output_tokens") * OUTPUT_USD_PER_MTOK / 1_000_000
    )
