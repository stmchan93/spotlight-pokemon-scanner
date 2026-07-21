"""Minimal Anthropic Messages API adapter (pure urllib, no SDK).

Transport style mirrors ``scrydex_adapter.scrydex_api_request``: build a
``urllib.request.Request``, POST JSON, parse JSON back. Used by the
"Who's That Pokemon" selfie feature.

HARD PRIVACY RULE: request payloads contain user selfie bytes (base64).
Never log, persist, or echo the payload — errors must carry only status
codes and short messages, never request bodies.
"""

from __future__ import annotations

import base64
import json
import os
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY"

LOOKALIKE_MODEL = "claude-haiku-4-5"
LOOKALIKE_MAX_TOKENS = 700
MIN_POKEDEX_ID = 1
MAX_POKEDEX_ID = 1025
_RETRY_BACKOFF_SECONDS = 0.75


class AnthropicResponseError(RuntimeError):
    """The Anthropic API answered, but the response shape was unusable."""


def anthropic_api_key() -> str | None:
    value = str(os.environ.get(ANTHROPIC_API_KEY_ENV) or "").strip()
    return value or None


def anthropic_messages_request(payload: dict[str, Any], *, timeout: int = 20) -> dict[str, Any]:
    """POST ``payload`` to the Anthropic Messages API and return the parsed JSON.

    Up to TWO retries on transient failures (network errors, timeouts, HTTP
    429/5xx) with a short backoff, then the original error is raised. Transient
    429/overloaded errors fail fast, so with the caller's tightened per-call
    ``timeout`` all three attempts still fit inside the client's request budget.
    """
    api_key = anthropic_api_key()
    if api_key is None:
        raise ValueError("ANTHROPIC_API_KEY is not configured")

    body = json.dumps(payload).encode("utf-8")
    last_attempt = 2
    for attempt in range(last_attempt + 1):
        request = Request(ANTHROPIC_MESSAGES_URL, data=body, method="POST")
        request.add_header("x-api-key", api_key)
        request.add_header("anthropic-version", ANTHROPIC_VERSION)
        request.add_header("content-type", "application/json")
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read()
        except HTTPError as exc:
            retryable = exc.code == 429 or exc.code >= 500
            if retryable and attempt < last_attempt:
                time.sleep(_RETRY_BACKOFF_SECONDS)
                continue
            raise
        except (URLError, TimeoutError, OSError):
            # URLError covers connection failures; socket timeouts surface as
            # TimeoutError / OSError depending on the Python version.
            if attempt < last_attempt:
                time.sleep(_RETRY_BACKOFF_SECONDS)
                continue
            raise
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AnthropicResponseError("Anthropic response was not valid JSON") from exc
        if not isinstance(parsed, dict):
            raise AnthropicResponseError("Anthropic response was not a JSON object")
        return parsed
    raise AnthropicResponseError("Anthropic request did not produce a response")  # pragma: no cover


_REPORT_MATCHES_TOOL: dict[str, Any] = {
    "name": "report_matches",
    "description": (
        "Report the top 3 Pokemon this person most resembles, each with a "
        "confidence between 0 and 1 and one short playful reason."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "matches": {
                "type": "array",
                "minItems": 3,
                "maxItems": 3,
                "items": {
                    "type": "object",
                    "properties": {
                        "species": {"type": "string"},
                        "pokedexId": {
                            "type": "integer",
                            "minimum": MIN_POKEDEX_ID,
                            "maximum": MAX_POKEDEX_ID,
                        },
                        "confidence": {"type": "number"},
                        "reason": {"type": "string"},
                    },
                    "required": ["species", "pokedexId", "confidence", "reason"],
                },
            },
        },
        "required": ["matches"],
    },
}


def _lookalike_prompt(palette_hints: list[str] | None) -> str:
    hint_text = ""
    if palette_hints:
        cleaned = [str(hint).strip() for hint in palette_hints if str(hint or "").strip()]
        if cleaned:
            hint_text = (
                " Detected clothing/palette hints for extra inspiration: "
                + ", ".join(cleaned[:8])
                + "."
            )
    return (
        "We're playing \"Who's That Pokemon?\" — a lighthearted party game. "
        "Look at this selfie and pick the 3 real Pokemon this person most "
        "RESEMBLES, judging by face shape, expression, hairstyle, accessories, "
        f"and outfit colors.{hint_text} For each match give a confidence "
        "between 0 and 1 and ONE short playful reason a friend would laugh at. "
        "Keep it warm and PG: never mean-spirited, and never comment "
        "negatively on anyone's body or skin. Species must be real Pokemon "
        "with their correct National Pokedex ids. Report exactly 3 matches "
        "via the report_matches tool."
    )


def _normalized_match(entry: Any) -> dict[str, Any]:
    if not isinstance(entry, dict):
        raise AnthropicResponseError("report_matches entry was not an object")

    species = str(entry.get("species") or "").strip()
    reason = str(entry.get("reason") or "").strip()
    if not species or not reason:
        raise AnthropicResponseError("report_matches entry was missing species or reason")

    pokedex_raw = entry.get("pokedexId")
    if isinstance(pokedex_raw, bool) or not isinstance(pokedex_raw, (int, float, str)):
        raise AnthropicResponseError("report_matches entry had an invalid pokedexId")
    try:
        pokedex_id = int(pokedex_raw)
    except (TypeError, ValueError) as exc:
        raise AnthropicResponseError("report_matches entry had an invalid pokedexId") from exc
    if not (MIN_POKEDEX_ID <= pokedex_id <= MAX_POKEDEX_ID):
        raise AnthropicResponseError("report_matches entry had an out-of-range pokedexId")

    try:
        confidence = float(entry.get("confidence"))
    except (TypeError, ValueError) as exc:
        raise AnthropicResponseError("report_matches entry had an invalid confidence") from exc
    confidence = min(1.0, max(0.0, confidence))

    return {
        "species": species,
        "pokedexId": pokedex_id,
        "confidence": confidence,
        "reason": reason,
    }


def identify_pokemon_lookalike(
    jpeg_bytes: bytes, *, palette_hints: list[str] | None = None
) -> list[dict[str, Any]]:
    """Ask Claude vision which 3 Pokemon the selfie most resembles.

    The selfie bytes live only in this request payload (memory) — they are
    never written to disk, a database, or logs.
    """
    if not jpeg_bytes:
        raise ValueError("selfie image bytes are required")

    payload = {
        "model": LOOKALIKE_MODEL,
        "max_tokens": LOOKALIKE_MAX_TOKENS,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": base64.b64encode(jpeg_bytes).decode("ascii"),
                        },
                    },
                    {"type": "text", "text": _lookalike_prompt(palette_hints)},
                ],
            }
        ],
        "tools": [_REPORT_MATCHES_TOOL],
        "tool_choice": {"type": "tool", "name": "report_matches"},
    }

    # Tighter per-call timeout (Haiku vision on a small selfie normally answers
    # in a few seconds) so all THREE attempts fit inside the 30s client budget:
    # 3 x 9s + 2 x 0.75s backoff ~= 28.5s.
    response = anthropic_messages_request(payload, timeout=9)

    tool_input: dict[str, Any] | None = None
    for block in response.get("content") or []:
        if (
            isinstance(block, dict)
            and block.get("type") == "tool_use"
            and block.get("name") == "report_matches"
            and isinstance(block.get("input"), dict)
        ):
            tool_input = block["input"]
            break
    if tool_input is None:
        raise AnthropicResponseError("Anthropic response had no report_matches tool_use block")

    matches_raw = tool_input.get("matches")
    if not isinstance(matches_raw, list) or len(matches_raw) != 3:
        raise AnthropicResponseError("report_matches did not return exactly 3 matches")

    return [_normalized_match(entry) for entry in matches_raw]
