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
import io
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

# Anthropic vision limits: a single image may not exceed 5 MB (base64) and is
# downscaled server-side above ~1568px on the long edge anyway. Full-res phone
# selfies (12MP+, several MB) blow past the 5 MB cap and get rejected with a
# persistent HTTP 400 — so we downscale + re-encode in memory before sending.
# A lookalike judgement needs no more than ~1024px; this keeps us far under the
# cap and cheaper. In-memory only — the selfie is never written to disk.
_VISION_MAX_EDGE = 1024
_VISION_JPEG_QUALITY = 85


def _register_heif_opener_once() -> None:
    """Teach Pillow to decode HEIC/HEIF (iOS's default photo format).

    iPhone captures arrive as HEIC, which stock Pillow cannot decode and which
    Anthropic's vision API rejects outright (it accepts only JPEG/PNG/GIF/WebP).
    Registering the pillow-heif opener lets ``_downscale_jpeg_for_vision``
    transcode HEIC → JPEG. Optional dependency: if it isn't installed we simply
    keep JPEG/PNG support and HEIC selfies still fail loudly in the logs.
    """
    if getattr(_register_heif_opener_once, "_done", False):
        return
    try:
        import pillow_heif  # optional; manylinux wheel bundles libheif

        pillow_heif.register_heif_opener()
    except Exception:
        pass
    _register_heif_opener_once._done = True  # type: ignore[attr-defined]


# Register at import so both the identify and share-card paths can read HEIC.
_register_heif_opener_once()


def _downscale_jpeg_for_vision(jpeg_bytes: bytes) -> bytes:
    """Return a re-encoded JPEG with its long edge capped at ``_VISION_MAX_EDGE``.

    Falls back to the original bytes if Pillow is unavailable or the image can't
    be decoded — the request still goes out, and the adapter's error logging
    will surface any resulting size rejection.

    Emits a metadata-only diagnostic line (input size, detected format, output
    size) — never the image bytes/base64 — so a decode failure is visible.
    """
    import sys

    try:
        from PIL import Image  # imported lazily; same dep the share-card path uses
    except Exception as exc:
        print(
            f"[WHOS-THAT] downscale: Pillow unavailable ({type(exc).__name__}); "
            f"passing original in={len(jpeg_bytes)}B",
            file=sys.stderr,
        )
        return jpeg_bytes
    try:
        with Image.open(io.BytesIO(jpeg_bytes)) as image:
            source_format = image.format
            image = image.convert("RGB")
            longest = max(image.size)
            if longest > _VISION_MAX_EDGE:
                scale = _VISION_MAX_EDGE / float(longest)
                new_size = (
                    max(1, round(image.size[0] * scale)),
                    max(1, round(image.size[1] * scale)),
                )
                image = image.resize(new_size, Image.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=_VISION_JPEG_QUALITY)
            out = buffer.getvalue()
            print(
                f"[WHOS-THAT] downscale ok: srcFormat={source_format} "
                f"in={len(jpeg_bytes)}B out={len(out)}B",
                file=sys.stderr,
            )
            return out
    except Exception as exc:
        print(
            f"[WHOS-THAT] downscale FELL BACK: {type(exc).__name__}: {exc} "
            f"(in={len(jpeg_bytes)}B) — Pillow could not decode the source image",
            file=sys.stderr,
        )
        return jpeg_bytes


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
            # Attach Anthropic's OWN error message (from its response body) so
            # the caller can log WHY the request was rejected. This is the API's
            # error text (e.g. "model: ... not found", "image exceeds N MB"),
            # NOT our request payload — safe to surface per the privacy rule.
            try:
                detail = exc.read().decode("utf-8", "replace")[:400]
            except Exception:
                detail = ""
            if detail:
                exc.anthropic_error_detail = detail  # type: ignore[attr-defined]
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
        "Look at this photo and pick the 3 real Pokemon this person most "
        "RESEMBLES. It is often a full-body shot, so weight their whole look — "
        "overall silhouette and body type, pose and stance, outfit style and "
        "colors, hairstyle, accessories, and general vibe — not just the face. "
        f"{hint_text} For each match give a confidence "
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

    # Cap the image well under Anthropic's 5 MB/image limit before base64 —
    # full-res phone selfies otherwise trigger a persistent HTTP 400.
    jpeg_bytes = _downscale_jpeg_for_vision(jpeg_bytes)

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
