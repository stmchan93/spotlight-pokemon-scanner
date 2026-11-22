#!/usr/bin/env python3
"""Post-deploy probe: one tiny real Anthropic call with the chat's exact system prompt
and tool definitions. Catches request-shape errors that unit tests can't (e.g. the API's
"compiled grammar is too large" 400 on 2026-11-22, which failed every chat turn).

Reads nothing from the database and writes nothing. Exits 0 when the call succeeds or
the assistant is off / has no key; 1 when the API rejects the request.

  .venv/bin/python tools/assistant_api_probe.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_server.assistant.config import AssistantConfig  # noqa: E402
from mcp_server.assistant.engine import SYSTEM_PAYLOAD, TOOLS_PAYLOAD  # noqa: E402


def main() -> int:
    config = AssistantConfig.from_env()
    if not config.enabled or not (config.api_key or os.environ.get("ANTHROPIC_API_KEY")):
        print("assistant probe: skipped (assistant disabled or no API key)")
        return 0
    import anthropic

    client = anthropic.Anthropic(api_key=config.api_key or os.environ["ANTHROPIC_API_KEY"])
    try:
        response = client.messages.create(
            model=config.model,
            max_tokens=16,
            system=SYSTEM_PAYLOAD,
            tools=TOOLS_PAYLOAD,
            tool_choice={"type": "none"},
            messages=[{"role": "user", "content": "Say ok."}],
        )
    except anthropic.APIStatusError as error:
        print(f"assistant probe: FAILED {error.status_code}: {error.message}", file=sys.stderr)
        return 1
    except anthropic.APIConnectionError as error:
        # Network blips aren't a broken deploy; report and move on.
        print(f"assistant probe: skipped (could not reach the API: {error})")
        return 0
    print(f"assistant probe: ok ({config.model}, {len(TOOLS_PAYLOAD)} tools, stop={response.stop_reason})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
