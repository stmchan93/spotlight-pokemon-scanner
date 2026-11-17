"""`identify_card`: a photo from Claude/ChatGPT -> ranked catalog candidates + USD price.

The MCP process never loads the scanner models. It forwards the photo to the
MAIN backend's raw visual-match endpoint on loopback (the same route the app's
raw lane uses), with the caller's own bearer token so the scan is attributed to
the same user. That route records a PREDICTION only (scan_events with
predicted_card_id, selected/confirmed left NULL) and no scan_artifacts row, so
nothing reaches the training export (which joins scan_artifacts and confirmed
labels). The request carries `captureSource: "mcp_identify_card"` and an
`mcp-` scanID prefix so these rows can be told apart in scan_events.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any, Callable, Literal

import anyio
import httpx
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from mcp_server.policy import ResponsePolicy
from mcp_server.rate_limit import RateLimitExceeded

logger = logging.getLogger("ekalight.mcp.identify")

TOOL_NAME = "identify_card"
VISUAL_MATCH_PATH = "/api/v1/scan/visual-match"
CAPTURE_SOURCE = "mcp_identify_card"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
# base64 of MAX_IMAGE_BYTES plus room for a data: URL prefix / whitespace.
MAX_IMAGE_BASE64_CHARS = (MAX_IMAGE_BYTES * 4) // 3 + 1024
MAX_IMAGE_PIXELS = 50_000_000
# Downscale before forwarding: the matcher works on a ~630x880 crop, and the
# main backend caps JSON bodies at 12 MB.
FORWARD_MAX_SIDE = 1600
MAX_CANDIDATES = 5
ALLOWED_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png"}

Game = Literal["pokemon", "onepiece", "lorcana", "riftbound", "gundam"]

IDENTIFY_ANNOTATIONS = ToolAnnotations(
    read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False
)

DESCRIPTION = (
    "Identify a raw (ungraded) trading card from a photo. Pass the image as base64 JPEG or PNG "
    "(max 8 MB), ideally one card filling most of the frame. Returns up to 5 candidate cards, "
    "best first, with USD price and a 0-1 match confidence. These are guesses: confirm with the "
    "user before treating one as their card. Nothing is added to their collection. Graded slabs "
    "are not supported. Limited to a few calls per day."
)


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


class IdentifySettings:
    def __init__(
        self,
        *,
        enabled: bool = True,
        backend_url: str = "http://127.0.0.1:8788",
        daily_limit: int = 25,
        timeout_s: float = 60.0,
        busy_retry_delay_s: float = 2.0,
    ) -> None:
        self.enabled = enabled
        self.backend_url = backend_url.rstrip("/")
        self.daily_limit = max(1, int(daily_limit))
        self.timeout_s = timeout_s
        self.busy_retry_delay_s = busy_retry_delay_s

    @classmethod
    def from_env(cls) -> "IdentifySettings":
        enabled_raw = str(os.environ.get("SPOTLIGHT_MCP_IDENTIFY_ENABLED") or "1").strip().lower()
        # Main backend port: .vm-runtime.conf exports SPOTLIGHT_PORT=8788 to both processes.
        default_url = f"http://127.0.0.1:{_env_int('SPOTLIGHT_PORT', 8788)}"
        return cls(
            enabled=enabled_raw in {"1", "true", "yes", "on"},
            backend_url=(os.environ.get("SPOTLIGHT_MCP_SCAN_BACKEND_URL") or default_url).strip(),
            daily_limit=_env_int("SPOTLIGHT_MCP_IDENTIFY_DAILY_LIMIT", 25),
            # Generous: the first scan per game after a restart builds its index (~10-30s).
            timeout_s=_env_float("SPOTLIGHT_MCP_IDENTIFY_TIMEOUT_S", 60.0),
        )


class DailyCounter:
    """Per-user UTC-day counter with refunds (failed identifies don't count).
    In-process, like rate_limit.UserRateLimiter: one MCP process."""

    def __init__(self, limit: int, *, day_clock: Callable[[], str] | None = None) -> None:
        self.limit = limit
        self._day_clock = day_clock or (lambda: datetime.now(timezone.utc).date().isoformat())
        self._counts: dict[str, int] = {}
        self._day = ""
        self._lock = threading.Lock()

    def _roll(self) -> None:
        today = self._day_clock()
        if today != self._day:
            self._day = today
            self._counts = {}

    def consume(self, user_id: str) -> int:
        """Count one call; return calls remaining today. Raises RateLimitExceeded."""
        with self._lock:
            self._roll()
            used = self._counts.get(user_id, 0)
            if used >= self.limit:
                raise RateLimitExceeded(
                    f"Daily photo-identify limit reached ({self.limit} per day). Try again tomorrow (UTC), "
                    "or scan the card in the Ekalight app."
                )
            self._counts[user_id] = used + 1
            return self.limit - used - 1

    def refund(self, user_id: str) -> None:
        with self._lock:
            self._roll()
            if self._counts.get(user_id, 0) > 0:
                self._counts[user_id] -= 1


def prepare_image(image_base64: str) -> tuple[str, int, int]:
    """Validate + normalize the upload. Returns (jpeg_base64, width, height).

    Raises ToolError for anything that isn't a sane JPEG/PNG under the cap."""
    text = str(image_base64 or "").strip()
    if text.startswith("data:"):
        header, _, text = text.partition(",")
        if ";base64" not in header:
            raise ToolError("image_base64 must be base64-encoded JPEG or PNG data.")
    if not text:
        raise ToolError("image_base64 is empty.")
    if len(text) > MAX_IMAGE_BASE64_CHARS:
        raise ToolError("Image is too large; the limit is 8 MB.")
    try:
        raw = base64.b64decode("".join(text.split()), validate=True)
    except (binascii.Error, ValueError):
        raise ToolError("image_base64 is not valid base64.") from None
    if len(raw) > MAX_IMAGE_BYTES:
        raise ToolError("Image is too large; the limit is 8 MB.")

    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(raw)) as probe:
            fmt = probe.format
            width, height = probe.size
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise ToolError("Could not read the image. Send a JPEG or PNG photo.") from None
    if fmt not in ALLOWED_FORMATS:
        raise ToolError(f"Unsupported image type ({fmt or 'unknown'}). Send a JPEG or PNG photo.")
    if width < 32 or height < 32 or width * height > MAX_IMAGE_PIXELS:
        raise ToolError("Image dimensions are out of range.")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((FORWARD_MAX_SIDE, FORWARD_MAX_SIDE))
            out = io.BytesIO()
            image.save(out, format="JPEG", quality=90)
            width, height = image.size
    except (OSError, ValueError, Image.DecompressionBombError):
        raise ToolError("Could not read the image. Send a JPEG or PNG photo.") from None
    return base64.b64encode(out.getvalue()).decode("ascii"), width, height


def build_scan_payload(
    jpeg_base64: str, width: int, height: int, *, game: str, language: str | None
) -> dict[str, Any]:
    # Same wire shape as the app's raw lane (createScannerMatchPayload), minus OCR.
    return {
        "scanID": f"mcp-{uuid.uuid4()}",
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "clientContext": {"platform": "mcp", "appVersion": "mcp", "buildNumber": "0"},
        "captureSource": CAPTURE_SOURCE,
        "image": {"jpegBase64": jpeg_base64, "width": width, "height": height},
        "recognizedTokens": [],
        "collectorNumber": None,
        "setHintTokens": [],
        "resolverModeHint": "raw_card",
        "rawResolverMode": "visual",
        "game": game,
        "cardLanguage": language,
        "cropConfidence": 0,
        "warnings": [],
    }


class IdentifyCard:
    def __init__(
        self,
        runner: Any,
        settings: IdentifySettings,
        *,
        policy: ResponsePolicy,
        token_getter: Callable[[], AccessToken | None] = get_access_token,
        transport: httpx.AsyncBaseTransport | None = None,
        counter: DailyCounter | None = None,
    ) -> None:
        # `runner` is app.ToolRunner: identity/guest checks + the shared rate limiter.
        self.runner = runner
        self.settings = settings
        self.policy = policy
        self.token_getter = token_getter
        self.transport = transport
        self.counter = counter or DailyCounter(settings.daily_limit)

    async def _post(self, payload: dict[str, Any], bearer: str) -> httpx.Response:
        headers = {"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(
            base_url=self.settings.backend_url, timeout=self.settings.timeout_s, transport=self.transport
        ) as client:
            response = await client.post(VISUAL_MATCH_PATH, json=payload, headers=headers)
            if response.status_code == 503:
                # Inference queue full: one polite retry before giving up.
                await asyncio.sleep(self.settings.busy_retry_delay_s)
                response = await client.post(VISUAL_MATCH_PATH, json=payload, headers=headers)
            return response

    @staticmethod
    def _error_for_status(status: int) -> str:
        if status == 401:
            return "Ekalight did not accept this sign-in. Reconnect the Ekalight connector."
        if status == 403:
            return "Ekalight scanning is not available right now."
        if status == 503:
            return "Ekalight's scanner is busy. Try again in a minute."
        if status in (400, 413):
            return "Ekalight could not read that image. Try a clearer photo of a single card."
        return "Ekalight could not identify this card right now. Try again shortly."

    def _shape(self, response: dict[str, Any]) -> list[dict[str, Any]]:
        tools = self.runner.tools
        ranked: list[tuple[str, dict[str, Any], float | None]] = []
        for entry in response.get("topCandidates") or []:
            candidate = (entry or {}).get("candidate") or {}
            card_id = str(candidate.get("id") or "").strip()
            if not card_id or any(card_id == seen for seen, _, _ in ranked):
                continue
            score = entry.get("finalScore")
            confidence = (
                round(min(1.0, max(0.0, float(score))), 3)
                if isinstance(score, (int, float)) and not isinstance(score, bool)
                else None
            )
            ranked.append((card_id, candidate, confidence))
            if len(ranked) >= MAX_CANDIDATES:
                break
        if not ranked:
            return []
        # Price/name from the MCP's own read path so identify agrees with get_card.
        summaries = tools._summaries([card_id for card_id, _, _ in ranked])
        out: list[dict[str, Any]] = []
        for card_id, candidate, confidence in ranked:
            summary = summaries.get(card_id)
            if summary is None:
                pricing = candidate.get("pricing")
                # A graded slab comp is not the raw card's price.
                if isinstance(pricing, dict) and pricing.get("pricingMode") == "graded_reference":
                    pricing = None
                summary = tools._card_summary(candidate, pricing)
            out.append({**summary, "confidence": confidence})
        return out

    async def run(self, *, image_base64: str, game: str = "pokemon", language: str | None = None) -> dict[str, Any]:
        if not self.policy.allows_tool(TOOL_NAME):
            raise ToolError(f"{TOOL_NAME} is not available on this plan.")
        identity = self.runner._identity()
        token = self.token_getter()
        bearer = str(getattr(token, "token", "") or "").strip()
        if not bearer:
            raise ToolError("Not signed in to Ekalight. Reconnect the Ekalight connector.")
        jpeg_base64, width, height = await anyio.to_thread.run_sync(prepare_image, image_base64)
        try:
            self.runner._limiter().check(identity.user_id)
            remaining = self.counter.consume(identity.user_id)
        except RateLimitExceeded as error:
            raise ToolError(str(error)) from None

        payload = build_scan_payload(jpeg_base64, width, height, game=game, language=language)
        try:
            response = await self._post(payload, bearer)
        except httpx.HTTPError as error:
            self.counter.refund(identity.user_id)
            logger.warning("identify_card backend call failed: %s", type(error).__name__)
            message = (
                "Ekalight's scanner took too long. Try again in a minute."
                if isinstance(error, httpx.TimeoutException)
                else "Ekalight could not identify this card right now. Try again shortly."
            )
            raise ToolError(message) from None
        if response.status_code != 200:
            self.counter.refund(identity.user_id)
            logger.warning("identify_card backend returned %s", response.status_code)
            raise ToolError(self._error_for_status(response.status_code))
        try:
            body = response.json()
        except ValueError:
            self.counter.refund(identity.user_id)
            raise ToolError("Ekalight could not identify this card right now. Try again shortly.") from None
        if not isinstance(body, dict):
            body = {}

        service = self.runner.tools.service

        def shape() -> list[dict[str, Any]]:
            with service.request_identity_context(identity):
                return self._shape(body)

        try:
            candidates = await anyio.to_thread.run_sync(shape)
        except Exception:  # noqa: BLE001 - never leak internals to the model
            logger.exception("identify_card shaping failed")
            raise ToolError("Ekalight could not identify this card right now. Try again shortly.") from None

        match_confidence = str(body.get("confidence") or "").strip().lower() or None
        result = {
            "candidates": candidates,
            "match_confidence": match_confidence if match_confidence in {"high", "medium", "low"} else None,
            "needs_review": body.get("reviewDisposition") != "ready" or not candidates,
            "identify_calls_remaining_today": remaining,
            "note": (
                "Best guesses from the photo, best first. Ask the user to confirm the card before "
                "relying on it. Nothing was added to their collection."
                if candidates
                else "No match found. Ask for a closer, well-lit photo of a single card."
            ),
        }
        return self.policy.shape(result)


def register_identify_card(
    server: Any,
    policy: ResponsePolicy,
    runner: Any,
    *,
    settings: IdentifySettings | None = None,
    token_getter: Callable[[], AccessToken | None] = get_access_token,
    transport: httpx.AsyncBaseTransport | None = None,
) -> IdentifyCard | None:
    """Register on tiers whose policy lists identify_card (user tier only)."""
    settings = settings or IdentifySettings.from_env()
    if not settings.enabled or not policy.allows_tool(TOOL_NAME):
        return None
    tool = IdentifyCard(runner, settings, policy=policy, token_getter=token_getter, transport=transport)

    @server.tool(name=TOOL_NAME, description=DESCRIPTION, annotations=IDENTIFY_ANNOTATIONS)
    async def identify_card(
        image_base64: Annotated[
            str,
            Field(
                min_length=1,
                max_length=MAX_IMAGE_BASE64_CHARS,
                description="The photo as base64 (a data: URL is accepted). JPEG or PNG, max 8 MB.",
            ),
        ],
        game: Game = "pokemon",
        language: Literal["english", "japanese"] | None = None,
    ) -> dict[str, Any]:
        return await tool.run(image_base64=image_base64, game=game, language=language)

    return tool
