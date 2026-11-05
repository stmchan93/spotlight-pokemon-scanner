"""Ekalight remote MCP server: Streamable HTTP at /mcp, Supabase bearer auth.

Run: `python -m mcp_server.app` from backend/ (or backend/run_mcp_server_vm.sh).
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path
from typing import Annotated, Any, Callable, Literal

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import anyio  # noqa: E402
from mcp.server.auth.middleware.auth_context import get_access_token  # noqa: E402
from mcp.server.auth.provider import AccessToken  # noqa: E402
from mcp.server.auth.settings import AuthSettings  # noqa: E402
from mcp.server.mcpserver import MCPServer  # noqa: E402
from mcp.server.mcpserver.exceptions import ToolError  # noqa: E402
from mcp.server.transport_security import TransportSecuritySettings  # noqa: E402
from mcp.types import ToolAnnotations  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402

from request_auth import RequestIdentity  # noqa: E402

from mcp_server.auth import GUEST_REJECTION_MESSAGE, McpConfig, validator_for  # noqa: E402
from mcp_server.filters import ToolInputError  # noqa: E402
from mcp_server.policy import USER_POLICY, ResponsePolicy  # noqa: E402
from mcp_server.rate_limit import RateLimitExceeded, UserRateLimiter  # noqa: E402
from mcp_server.tools import CollectionTools  # noqa: E402

logger = logging.getLogger("ekalight.mcp")

INSTRUCTIONS = (
    "Ekalight is the user's Pokémon card collection app. These tools read the signed-in user's "
    "collection and Ekalight's stored card catalog and market prices. All prices are USD; a null "
    "price means Ekalight has no USD price for that card. Every tool is read-only. Results are "
    "paginated: pass next_cursor back to get the next page. Use list_facets to see valid art "
    "filter values before using art filters."
)

RarityBucket = Literal["sir", "illustration", "ultra", "secret", "shiny", "promo", "standard", "other"]


class CardFilter(BaseModel):
    """All fields optional; combined with AND."""

    model_config = ConfigDict(extra="forbid")

    text: str | None = Field(None, description="Free text: card name, set, or number, e.g. 'charizard ex'.")
    pokemon: list[str] | None = Field(None, description="Pokémon shown in the artwork (art search).")
    pokemon_role: Literal["any", "main", "background_or_cameo"] | None = Field(
        None, description="Whether the pokemon must be the main subject or a background/cameo."
    )
    artist: str | None = Field(None, description="Illustrator name, e.g. 'Mitsuhiro Arita'.")
    scene: list[str] | None = Field(None, description="Art facet; values from list_facets.")
    weather_time: list[str] | None = Field(None, description="Art facet; values from list_facets.")
    activity: list[str] | None = Field(None, description="Art facet; values from list_facets.")
    mood: list[str] | None = Field(None, description="Art facet; values from list_facets.")
    art_style: list[str] | None = Field(None, description="Art facet; values from list_facets.")
    palette: list[str] | None = Field(None, description="Art facet; values from list_facets.")
    theme: str | None = Field(None, description="Curated theme id from list_facets.themes.")
    set: str | None = Field(None, description="Set name or code, e.g. 'Evolving Skies'.")
    rarity_bucket: list[RarityBucket] | None = Field(None, description="Rarity groups.")
    language: Literal["English", "Japanese", "any"] | None = Field(None, description="Card language.")
    price_min_usd: float | None = Field(None, ge=0, description="Minimum USD market price.")
    price_max_usd: float | None = Field(None, ge=0, description="Maximum USD market price.")


def _filter_dict(card_filter: CardFilter | None) -> dict[str, Any] | None:
    return None if card_filter is None else card_filter.model_dump(exclude_none=True)


class SupabaseTokenVerifier:
    """mcp TokenVerifier over a sync validator (Supabase JWT or public API key)."""

    def __init__(self, validator: Any) -> None:
        self.validator = validator

    async def verify_token(self, token: str) -> AccessToken | None:
        # JWKS fetch/caching is blocking I/O.
        verified = await anyio.to_thread.run_sync(self.validator.validate, token)
        if verified is None:
            return None
        exp = verified.claims.get("exp")
        return AccessToken(
            token=token,
            client_id=verified.client_id,
            scopes=[],
            expires_at=int(exp) if isinstance(exp, (int, float)) else None,
            subject=verified.identity.user_id,
            claims={
                "iss": verified.claims.get("iss"),
                "is_anonymous": verified.identity.is_anonymous,
                "plan": verified.plan,
            },
        )


class ToolRunner:
    """Auth gate + rate limit + policy + thread offload around CollectionTools."""

    def __init__(
        self,
        tools: CollectionTools,
        limiter: UserRateLimiter,
        *,
        policy: ResponsePolicy = USER_POLICY,
        plan_limiters: dict[str, UserRateLimiter] | None = None,
        token_getter: Callable[[], AccessToken | None] = get_access_token,
    ) -> None:
        self.tools = tools
        self.limiter = limiter
        self.policy = policy
        self.plan_limiters = plan_limiters or {}
        self.token_getter = token_getter

    def _identity(self) -> RequestIdentity:
        token = self.token_getter()
        if token is None or not str(token.subject or "").strip():
            raise ToolError("Not signed in to Ekalight. Reconnect the Ekalight connector.")
        if (token.claims or {}).get("is_anonymous") is True:
            raise ToolError(GUEST_REJECTION_MESSAGE)
        return RequestIdentity(user_id=str(token.subject).strip(), auth_source="mcp_bearer")

    def _limiter(self) -> UserRateLimiter:
        plan = ((self.token_getter() or AccessToken(token="", client_id="", scopes=[])).claims or {}).get("plan")
        if plan is None:
            return self.limiter
        if plan not in self.plan_limiters:
            raise ToolError("This API key's plan is not configured.")
        return self.plan_limiters[plan]

    async def run(self, method: str, **kwargs: Any) -> dict[str, Any]:
        if not self.policy.allows_tool(method):
            raise ToolError(f"{method} is not available on this plan.")
        identity = self._identity()
        try:
            self.policy.check_inputs(kwargs.get("card_filter"), sort=kwargs.get("sort"), owned=kwargs.get("owned"))
        except ValueError as error:
            raise ToolError(str(error)) from None
        try:
            self._limiter().check(identity.user_id)
        except RateLimitExceeded as error:
            raise ToolError(str(error)) from None
        if method == "get_card":
            kwargs["include_holdings"] = self.policy.account_data

        service = self.tools.service

        def work() -> dict[str, Any]:
            with service.request_identity_context(identity):
                return getattr(self.tools, method)(identity.user_id, **kwargs)

        try:
            return self.policy.shape(await anyio.to_thread.run_sync(work))
        except ToolInputError as error:
            raise ToolError(str(error)) from None
        except ToolError:
            raise
        except Exception:  # noqa: BLE001 - never leak internals to the model
            logger.exception("MCP tool %s failed", method)
            raise ToolError("Ekalight could not complete this request. Try again shortly.") from None


READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)

Limit50 = Annotated[int, Field(ge=1, le=50)]
Limit100 = Annotated[int, Field(ge=1, le=100)]


def protected_resource_metadata(config: McpConfig) -> dict[str, Any]:
    # No scopes_supported: Supabase's OAuth server rejects custom scopes, and its
    # default (`email`) is all we need. Matches the SDK's path-insert PRM.
    return {
        "resource": config.resource_url,
        "authorization_servers": [config.authorization_server_url],
        "bearer_methods_supported": ["header"],
        "resource_name": "Ekalight",
    }


def _register(server: MCPServer, policy: ResponsePolicy):
    """`server.tool` for tools the tier exposes; a no-op decorator otherwise."""

    def decorator(**kwargs: Any):
        def wrap(fn):
            return server.tool(**kwargs)(fn) if policy.allows_tool(fn.__name__) else fn

        return wrap

    return decorator


def build_server(
    tools: CollectionTools,
    config: McpConfig,
    *,
    limiter: UserRateLimiter | None = None,
    token_verifier: Any | None = None,
    token_getter: Callable[[], AccessToken | None] = get_access_token,
) -> MCPServer:
    """`token_verifier=None` builds an auth-less server for in-process tests only;
    `main()` always passes one."""
    policy = config.policy
    limiter = limiter or UserRateLimiter(per_minute=config.rate_per_minute, per_day=config.rate_per_day)
    plan_limiters = {
        plan: UserRateLimiter(per_minute=per_minute, per_day=per_day)
        for plan, (per_minute, per_day) in config.plan_quotas.items()
    }
    runner = ToolRunner(tools, limiter, policy=policy, plan_limiters=plan_limiters, token_getter=token_getter)
    auth = None
    if token_verifier is not None:
        oauth = policy.account_data
        auth = AuthSettings(
            # API-key tier has no OAuth AS; issuer_url is required by the model but unused
            # when resource_server_url is None (no PRM routes, plain 401).
            issuer_url=config.authorization_server_url if oauth else config.resource_url,
            resource_server_url=config.resource_url if oauth else None,
            required_scopes=None,
            # Supabase puts `resource` nowhere in the token (aud stays "authenticated");
            # the verifier checks issuer, plus aud/client_id when configured.
            validate_token_resource=False,
        )
    server = MCPServer(
        "ekalight",
        title="Ekalight",
        instructions=INSTRUCTIONS,
        token_verifier=token_verifier,
        auth=auth,
    )

    @_register(server, policy)(
        description="Valid values for the art filters (scene, mood, palette, ...) and curated themes, with card counts.",
        annotations=READ_ONLY,
    )
    async def list_facets() -> dict[str, Any]:
        return await runner.run("list_facets")

    @_register(server, policy)(
        description=(
            "Search Ekalight's card catalog with a filter. owned='owned'/'not_owned' limits to cards "
            "the user does or does not own. Prices are USD from Ekalight's stored market data."
        ),
        annotations=READ_ONLY,
    )
    async def search_cards(
        filter: CardFilter,
        owned: Literal["any", "owned", "not_owned"] = "any",
        sort: Literal["relevance", "price_asc", "price_desc", "newest"] = "relevance",
        limit: Limit50 = 20,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        return await runner.run(
            "search_cards", card_filter=_filter_dict(filter), owned=owned, sort=sort, limit=limit, cursor=cursor
        )

    @_register(server, policy)(
        description=(
            "One card: details, USD price, art tags, similar cards, its other-language counterpart, "
            "and the user's own copies (my_holdings)."
        ),
        annotations=READ_ONLY,
    )
    async def get_card(card_id: str) -> dict[str, Any]:
        return await runner.run("get_card", card_id=card_id)

    @_register(server, policy)(
        description=(
            "The user's collection holdings with quantity, condition/grade and USD value, optionally "
            "filtered. total_value_usd covers all matching holdings, not just this page. Hidden "
            "collections are excluded unless collection_id names one."
        ),
        annotations=READ_ONLY,
    )
    async def get_my_collection(
        filter: CardFilter | None = None,
        collection_id: str | None = None,
        sort: Literal["value_desc", "gain_desc", "added_desc"] = "value_desc",
        limit: Limit100 = 50,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        return await runner.run(
            "get_my_collection",
            card_filter=_filter_dict(filter),
            collection_id=collection_id,
            sort=sort,
            limit=limit,
            cursor=cursor,
        )

    @_register(server, policy)(
        description=(
            "The user's collection value in USD and how it moved over the range, with the top 5 "
            "gaining and losing holdings."
        ),
        annotations=READ_ONLY,
    )
    async def get_portfolio_summary(range: Literal["7d", "30d", "90d", "1y"] = "30d") -> dict[str, Any]:
        return await runner.run("get_portfolio_summary", range_key=range)

    @_register(server, policy)(
        description=(
            "Cards matching the filter that the user does not own, cheapest first. Use for 'what am I "
            "missing', set/theme completion, and shopping lists. Prices are USD from Ekalight's stored "
            "market data."
        ),
        annotations=READ_ONLY,
    )
    async def find_missing(
        filter: CardFilter,
        collection_id: str | None = None,
        budget_usd: Annotated[float, Field(ge=0)] | None = None,
        limit: Limit50 = 20,
    ) -> dict[str, Any]:
        return await runner.run(
            "find_missing",
            card_filter=_filter_dict(filter),
            collection_id=collection_id,
            budget_usd=budget_usd,
            limit=limit,
        )

    @_register(server, policy)(
        description="Daily USD market price history for one card (raw, by condition).",
        annotations=READ_ONLY,
    )
    async def get_price_history(
        card_id: str,
        range: Literal["30d", "90d", "1y"] = "90d",
        condition: Literal["NM", "LP", "MP", "HP", "DMG"] = "NM",
    ) -> dict[str, Any]:
        return await runner.run("get_price_history", card_id=card_id, range_key=range, condition=condition)

    if policy.account_data:

        @server.custom_route("/.well-known/oauth-protected-resource", methods=["GET"])
        async def protected_resource(_: Request) -> JSONResponse:
            # Root PRM for clients that fall back to it; the RFC 9728 path-insert
            # form (/.well-known/oauth-protected-resource/mcp) is served by the SDK.
            return JSONResponse(protected_resource_metadata(config))

    @server.custom_route("/healthz", methods=["GET"])
    async def healthz(_: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    return server


def build_app(config: McpConfig):
    """Production wiring: read-only service over the shared SQLite DB + auth."""
    from mcp_server.readonly_service import ReadOnlySpotlightService

    if config.policy.account_data and not config.authorization_server_url:
        raise SystemExit("SUPABASE_URL or SPOTLIGHT_MCP_AUTHORIZATION_SERVER_URL is required.")
    service = ReadOnlySpotlightService(Path(config.database_path), BACKEND_ROOT.parent)
    tools = CollectionTools(service, app_url_scheme=config.app_url_scheme)
    server = build_server(tools, config, token_verifier=SupabaseTokenVerifier(validator_for(config)))
    # Accept the public Host the reverse proxy forwards, not only loopback.
    transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True, allowed_hosts=config.transport_allowed_hosts()
    )
    # Stateless + JSON: no server-side sessions to pin, plain request/response.
    return server.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        transport_security=transport_security,
        host=config.host,
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Ekalight MCP server (Streamable HTTP)")
    parser.add_argument("--database-path")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    args = parser.parse_args(argv)
    if args.database_path:
        os.environ["SPOTLIGHT_DATABASE_PATH"] = args.database_path
    if args.host:
        os.environ["SPOTLIGHT_MCP_HOST"] = args.host
    if args.port:
        os.environ["SPOTLIGHT_MCP_PORT"] = str(args.port)
    logging.basicConfig(level=logging.INFO)
    config = McpConfig.from_env()
    import uvicorn

    uvicorn.run(build_app(config), host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()
