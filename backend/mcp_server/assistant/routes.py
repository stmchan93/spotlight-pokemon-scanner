"""HTTP routes for the in-app assistant, served by the MCP process as Starlette
custom routes under /api/v1/assistant/*.

Auth is the app's Supabase session JWT (Authorization: Bearer), validated by
mcp_server.auth with its own config: no OAuth client_id required, guests
(is_anonymous) allowed. The MCP SDK's global bearer middleware may also see the
header; it never rejects, so these handlers decide on their own.
"""

from __future__ import annotations

import dataclasses
import json
import logging
from typing import Any, Awaitable, Callable

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse

from mcp_server.assistant.service import AssistantService, Caller
from mcp_server.auth import McpConfig, McpTokenValidator

logger = logging.getLogger("ekalight.assistant")

PREFIX = "/api/v1/assistant"
NO_STORE = {"Cache-Control": "no-store"}
_INVALID_JSON = object()


def assistant_validator(config: McpConfig, authenticator: Any | None = None) -> McpTokenValidator:
    """Session-token validator: same Supabase checks, no client_id/audience gate."""
    session_config = dataclasses.replace(config, require_oauth_client=False, token_audience=None)
    return McpTokenValidator(session_config, authenticator=authenticator)


class AssistantAuth:
    def __init__(self, validator: Any) -> None:
        self.validator = validator

    async def caller(self, request: Request) -> Caller | None:
        header = request.headers.get("authorization") or ""
        if not header.lower().startswith("bearer "):
            return None
        token = header[7:].strip()
        if not token:
            return None
        verified = await anyio.to_thread.run_sync(self.validator.validate, token)
        if verified is None or not str(verified.identity.user_id or "").strip():
            return None
        return Caller(user_id=str(verified.identity.user_id).strip(), is_guest=bool(verified.identity.is_anonymous))


def _json(status: int, payload: dict[str, Any]) -> JSONResponse:
    return JSONResponse(payload, status_code=status, headers=NO_STORE)


async def _body(request: Request) -> Any:
    raw = await request.body()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return _INVALID_JSON


def register_assistant_routes(server: Any, service: AssistantService, auth: AssistantAuth) -> None:
    """Adds the /api/v1/assistant/* routes to an MCPServer via custom_route."""

    def authed(handler: Callable[[Request, Caller], Awaitable[tuple[int, dict[str, Any]]]]):
        async def endpoint(request: Request) -> JSONResponse:
            caller = await auth.caller(request)
            if caller is None:
                return _json(401, {"error": "unauthorized"})
            try:
                status, payload = await handler(request, caller)
            except Exception:  # noqa: BLE001
                logger.exception("assistant route %s failed", request.url.path)
                return _json(500, {"error": "internal_error"})
            return _json(status, payload)

        return endpoint

    async def post_message(request: Request, caller: Caller):
        body = await _body(request)
        if body is _INVALID_JSON:
            return 400, {"error": "invalid_request", "detail": "body must be JSON"}
        return await service.send(caller, body)

    async def get_usage(request: Request, caller: Caller):
        del request
        return await service.usage(caller)

    async def threads(request: Request, caller: Caller):
        if request.method == "DELETE":
            return await service.delete_all_threads(caller)
        return await service.list_threads(
            caller, limit=request.query_params.get("limit"), cursor=request.query_params.get("cursor")
        )

    async def thread(request: Request, caller: Caller):
        return await service.delete_thread(caller, request.path_params["thread_id"])

    async def thread_messages(request: Request, caller: Caller):
        return await service.thread_messages(
            caller,
            request.path_params["thread_id"],
            limit=request.query_params.get("limit"),
            before=request.query_params.get("before"),
        )

    async def action(request: Request, caller: Caller):
        body = await _body(request)
        if body is _INVALID_JSON:
            return 400, {"error": "invalid_request", "detail": "body must be JSON"}
        return await service.set_action_state(caller, request.path_params["action_id"], body)

    async def feedback(request: Request, caller: Caller):
        body = await _body(request)
        if body is _INVALID_JSON:
            return 400, {"error": "invalid_request", "detail": "body must be JSON"}
        return await service.set_feedback(caller, request.path_params["message_id"], body)

    routes = (
        (f"{PREFIX}/messages", ["POST"], post_message),
        (f"{PREFIX}/usage", ["GET"], get_usage),
        (f"{PREFIX}/threads", ["GET", "DELETE"], threads),
        (f"{PREFIX}/threads/{{thread_id}}", ["DELETE"], thread),
        (f"{PREFIX}/threads/{{thread_id}}/messages", ["GET"], thread_messages),
        (f"{PREFIX}/actions/{{action_id}}", ["POST"], action),
        (f"{PREFIX}/messages/{{message_id}}/feedback", ["POST"], feedback),
    )
    for path, methods, handler in routes:
        server.custom_route(path, methods=methods)(authed(handler))
