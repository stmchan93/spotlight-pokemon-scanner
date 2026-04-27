from __future__ import annotations

from dataclasses import dataclass
from typing import Any

try:
    import jwt
    from jwt import PyJWKClient
except ImportError:  # pragma: no cover - exercised only when optional dependency is absent
    jwt = None
    PyJWKClient = None


class RequestAuthError(RuntimeError):
    pass


@dataclass(frozen=True)
class RequestIdentity:
    user_id: str
    auth_source: str


class SupabaseRequestAuthenticator:
    def __init__(
        self,
        *,
        supabase_url: str | None,
        jwks_url: str | None = None,
        auth_required: bool = False,
        fallback_user_id: str | None = None,
    ) -> None:
        normalized_url = str(supabase_url or "").strip().rstrip("/")
        self.supabase_url = normalized_url or None
        self.jwks_url = str(jwks_url or "").strip() or (
            f"{normalized_url}/auth/v1/.well-known/jwks.json" if normalized_url else None
        )
        self.issuer = f"{normalized_url}/auth/v1" if normalized_url else None
        self.auth_required = bool(auth_required)
        self.fallback_user_id = str(fallback_user_id or "").strip() or None
        self._jwk_client: Any | None = None

    def resolve_identity(self, authorization_header: str | None) -> RequestIdentity:
        token = self._bearer_token_from_header(authorization_header)
        if token is not None:
            return self._identity_from_token(token)

        if self.auth_required:
            raise RequestAuthError("Authentication required.")

        if self.fallback_user_id:
            return RequestIdentity(
                user_id=self.fallback_user_id,
                auth_source="dev_fallback",
            )

        raise RequestAuthError("A fallback user is not configured for unauthenticated requests.")

    def _identity_from_token(self, token: str) -> RequestIdentity:
        if jwt is None or PyJWKClient is None:
            raise RequestAuthError("PyJWT is required for bearer token verification.")
        if not self.jwks_url or not self.issuer:
            raise RequestAuthError("Supabase auth verification is not configured on the backend.")

        jwk_client = self._jwk_client_instance()
        try:
            signing_key = jwk_client.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                issuer=self.issuer,
                options={
                    "require": ["exp", "iat", "sub"],
                    "verify_aud": False,
                },
            )
        except Exception as error:  # noqa: BLE001
            raise RequestAuthError(f"Bearer token verification failed: {error}") from error

        user_id = str(claims.get("sub") or "").strip()
        if not user_id:
            raise RequestAuthError("Bearer token is missing the user subject.")

        return RequestIdentity(
            user_id=user_id,
            auth_source="supabase_jwt",
        )

    def _jwk_client_instance(self) -> Any:
        if self._jwk_client is None:
            self._jwk_client = PyJWKClient(self.jwks_url)
        return self._jwk_client

    @staticmethod
    def _bearer_token_from_header(authorization_header: str | None) -> str | None:
        normalized_header = str(authorization_header or "").strip()
        if not normalized_header:
            return None

        scheme, _, token = normalized_header.partition(" ")
        normalized_token = token.strip()
        if scheme.lower() != "bearer" or not normalized_token:
            raise RequestAuthError("Authorization header must use the Bearer scheme.")
        return normalized_token
