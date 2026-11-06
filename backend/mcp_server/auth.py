"""Resource-server side of MCP auth + process config.

User tier: Supabase-issued bearer JWTs, checked with the existing
SupabaseRequestAuthenticator (JWKS / HS secret, issuer = <SUPABASE_URL>/auth/v1)
with auth REQUIRED and no dev fallback user. Nothing here creates users or
touches sign-up.

Public tier (future): opaque API keys, stored only as SHA-256 hashes mapped to
a plan name; each plan has its own quota. No billing here.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from mcp_server.policy import TIER_PUBLIC, TIER_USER, policy_for_tier

from request_auth import RequestAuthError, RequestIdentity, SupabaseRequestAuthenticator

GUEST_REJECTION_MESSAGE = (
    "This Ekalight session is a guest account. Create a free Ekalight account in the "
    "Ekalight app first, then reconnect Ekalight here."
)


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


DEFAULT_PLAN_QUOTAS = {"free": (30, 500)}


def _parse_api_keys(raw: str) -> dict[str, str]:
    """"<sha256hex>:<plan>,..." -> {sha256hex: plan}."""
    out: dict[str, str] = {}
    for item in raw.split(","):
        digest, _, plan = item.strip().partition(":")
        digest = digest.strip().lower()
        if len(digest) == 64 and all(ch in "0123456789abcdef" for ch in digest):
            out[digest] = plan.strip() or "free"
    return out


def _parse_plan_quotas(raw: str) -> dict[str, tuple[int, int]]:
    """"free:30/500,pro:120/20000" -> {plan: (per_minute, per_day)}."""
    out: dict[str, tuple[int, int]] = {}
    for item in raw.split(","):
        plan, _, limits = item.strip().partition(":")
        per_minute, _, per_day = limits.partition("/")
        try:
            out[plan.strip()] = (int(per_minute), int(per_day))
        except ValueError:
            continue
    return out


@dataclass(frozen=True)
class McpConfig:
    database_path: str
    host: str = "127.0.0.1"
    port: int = 8790
    # Public URL of the /mcp endpoint; the OAuth "resource" identifier.
    resource_url: str = "http://localhost:8790/mcp"
    # OAuth authorization server(s) advertised in protected-resource metadata.
    authorization_server_url: str | None = None
    supabase_url: str | None = None
    supabase_jwks_url: str | None = None
    supabase_jwt_secret: str | None = None
    # Accept only tokens minted by the Supabase OAuth server (carry client_id),
    # not plain app session tokens. Off until the authorization side exists.
    require_oauth_client: bool = False
    # Optional `aud` the token must carry (Supabase sets none by default).
    token_audience: str | None = None
    rate_per_minute: int = 60
    rate_per_day: int = 2000
    allowed_hosts: tuple[str, ...] = field(default_factory=tuple)
    app_url_scheme: str = "spotlight"
    # Response policy tier: "user" (default) or "public"; see policy.py.
    tier: str = TIER_USER
    public_api_keys: dict[str, str] = field(default_factory=dict)
    plan_quotas: dict[str, tuple[int, int]] = field(default_factory=lambda: dict(DEFAULT_PLAN_QUOTAS))

    @property
    def policy(self):
        return policy_for_tier(self.tier)

    def transport_allowed_hosts(self) -> list[str]:
        """Host headers accepted by the SDK's DNS-rebinding guard: the public
        resource host (behind the reverse proxy) plus loopback."""
        hosts = list(self.allowed_hosts)
        netloc = urlsplit(self.resource_url).netloc
        if netloc and netloc not in hosts:
            hosts.append(netloc)
        for local in ("127.0.0.1:*", "localhost:*", "[::1]:*"):
            if local not in hosts:
                hosts.append(local)
        return hosts

    @classmethod
    def from_env(cls) -> "McpConfig":
        supabase_url = (
            os.environ.get("SUPABASE_URL") or os.environ.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL") or ""
        ).strip().rstrip("/") or None
        port = _env_int("SPOTLIGHT_MCP_PORT", 8790)
        return cls(
            database_path=os.environ.get("SPOTLIGHT_DATABASE_PATH")
            or os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "spotlight_scanner.sqlite"),
            host=os.environ.get("SPOTLIGHT_MCP_HOST") or "127.0.0.1",
            port=port,
            resource_url=(os.environ.get("SPOTLIGHT_MCP_RESOURCE_URL") or f"http://localhost:{port}/mcp").strip(),
            authorization_server_url=(
                os.environ.get("SPOTLIGHT_MCP_AUTHORIZATION_SERVER_URL")
                or (f"{supabase_url}/auth/v1" if supabase_url else None)
            ),
            supabase_url=supabase_url,
            supabase_jwks_url=os.environ.get("SUPABASE_JWKS_URL") or os.environ.get("SPOTLIGHT_SUPABASE_JWKS_URL"),
            supabase_jwt_secret=os.environ.get("SUPABASE_JWT_SECRET")
            or os.environ.get("SPOTLIGHT_SUPABASE_JWT_SECRET"),
            require_oauth_client=_env_flag("SPOTLIGHT_MCP_REQUIRE_OAUTH_CLIENT"),
            token_audience=(os.environ.get("SPOTLIGHT_MCP_TOKEN_AUDIENCE") or "").strip() or None,
            rate_per_minute=_env_int("SPOTLIGHT_MCP_RATE_PER_MINUTE", 60),
            rate_per_day=_env_int("SPOTLIGHT_MCP_RATE_PER_DAY", 2000),
            allowed_hosts=tuple(
                host.strip()
                for host in (os.environ.get("SPOTLIGHT_MCP_ALLOWED_HOSTS") or "").split(",")
                if host.strip()
            ),
            app_url_scheme=os.environ.get("SPOTLIGHT_MCP_APP_URL_SCHEME") or "spotlight",
            tier=(os.environ.get("SPOTLIGHT_MCP_TIER") or TIER_USER).strip().lower(),
            public_api_keys=_parse_api_keys(os.environ.get("SPOTLIGHT_MCP_PUBLIC_API_KEYS") or ""),
            plan_quotas=_parse_plan_quotas(os.environ.get("SPOTLIGHT_MCP_PLAN_QUOTAS") or "")
            or dict(DEFAULT_PLAN_QUOTAS),
        )


@dataclass(frozen=True)
class VerifiedToken:
    identity: RequestIdentity
    client_id: str
    claims: dict[str, Any]
    plan: str | None = None


class McpTokenValidator:
    """Sync validation; app.py adapts it to the SDK's async TokenVerifier."""

    def __init__(self, config: McpConfig, authenticator: SupabaseRequestAuthenticator | None = None) -> None:
        self.config = config
        self.authenticator = authenticator or SupabaseRequestAuthenticator(
            supabase_url=config.supabase_url,
            jwks_url=config.supabase_jwks_url,
            jwt_secret=config.supabase_jwt_secret,
            auth_required=True,
            fallback_user_id=None,
        )

    def validate(self, token: str) -> VerifiedToken | None:
        try:
            claims = self.authenticator.verified_claims(token)
            identity = self.authenticator.identity_from_claims(claims)
        except RequestAuthError:
            return None
        if self.config.token_audience:
            audience = claims.get("aud")
            audiences = audience if isinstance(audience, list) else [audience]
            if self.config.token_audience not in audiences:
                return None
        client_id = str(claims.get("client_id") or "").strip()
        if self.config.require_oauth_client and not client_id:
            return None
        return VerifiedToken(identity=identity, client_id=client_id or "supabase-session", claims=dict(claims))


class ApiKeyValidator:
    """Public tier: bearer value is an API key; only its SHA-256 is configured."""

    def __init__(self, config: McpConfig) -> None:
        self.config = config

    def validate(self, token: str) -> VerifiedToken | None:
        digest = hashlib.sha256(str(token or "").encode()).hexdigest()
        plan = next(
            (plan for known, plan in self.config.public_api_keys.items() if hmac.compare_digest(known, digest)),
            None,
        )
        if plan is None:
            return None
        subject = f"apikey:{digest[:16]}"
        return VerifiedToken(
            identity=RequestIdentity(user_id=subject, auth_source="mcp_api_key"),
            client_id=subject,
            claims={},
            plan=plan,
        )


def validator_for(config: McpConfig) -> McpTokenValidator | ApiKeyValidator:
    return ApiKeyValidator(config) if config.tier == TIER_PUBLIC else McpTokenValidator(config)
