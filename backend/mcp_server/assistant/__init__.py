"""In-app AI chat ("Ask Ekalight"): Claude Haiku over the CollectionTools reads
plus propose-only write tools. Contract: docs/ai-chat-contracts-2026-11-17.md."""

from __future__ import annotations

import logging
from typing import Any

from mcp_server.assistant.config import AssistantConfig
from mcp_server.assistant.engine import AssistantEngine
from mcp_server.assistant.routes import AssistantAuth, assistant_validator, register_assistant_routes
from mcp_server.assistant.service import AssistantService
from mcp_server.assistant.store import AssistantStore, ensure_schema
from mcp_server.assistant.tools import AssistantToolbox

logger = logging.getLogger("ekalight.assistant")


def build_assistant_service(
    tools: Any, config: AssistantConfig | None = None, *, client: Any | None = None
) -> AssistantService:
    """Tables created idempotently; the Anthropic client only when enabled + keyed."""
    config = config or AssistantConfig.from_env()
    ensure_schema(tools.service.connection)
    toolbox = AssistantToolbox(tools)
    engine = None
    if client is None and config.enabled:
        if config.api_key:
            import anthropic

            client = anthropic.AsyncAnthropic(
                api_key=config.api_key, timeout=config.request_timeout_seconds, max_retries=2
            )
        else:
            logger.warning("ASSISTANT_ENABLED is on but ANTHROPIC_API_KEY is unset; assistant stays disabled.")
    if client is not None:
        engine = AssistantEngine(config, toolbox, client)
    return AssistantService(config, AssistantStore(tools.service), toolbox, engine)


def install_assistant(server: Any, tools: Any, mcp_config: Any, **kwargs: Any) -> AssistantService:
    """Wire /api/v1/assistant/* onto an MCPServer (user tier only)."""
    service = build_assistant_service(tools, **kwargs)
    register_assistant_routes(server, service, AssistantAuth(assistant_validator(mcp_config)))
    return service


__all__ = [
    "AssistantConfig",
    "AssistantService",
    "build_assistant_service",
    "install_assistant",
    "register_assistant_routes",
]
