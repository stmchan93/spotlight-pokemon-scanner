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
        jwt_secret: str | None = None,
        auth_required: bool = False,
        fallback_user_id: str | None = None,
    ) -> None:
        normalized_url = str(supabase_url or "").strip().rstrip("/")
        self.supabase_url = normalized_url or None
        self.jwks_url = str(jwks_url or "").strip() or (
            f"{normalized_url}/auth/v1/.well-known/jwks.json" if normalized_url else None
        )
        self.issuer = f"{normalized_url}/auth/v1" if normalized_url else None
        self.jwt_secret = str(jwt_secret or "").strip() or None
        self.auth_required = bool(auth_required)
        self.fallback_user_id = str(fallback_user_id or "").strip() or None
        self._jwk_client: Any | None = None

    def resolve_identity(self, authorization_header: str | None) -> RequestIdentity:
        token = self._bearer_token_from_header(authorization_header)
        if token is not None:
            try:
                return self._identity_from_token(token)
            except RequestAuthError:
                if self.auth_required or not self.fallback_user_id:
                    raise
                return RequestIdentity(
                    user_id=self.fallback_user_id,
                    auth_source="dev_fallback_bearer",
                )

        if self.auth_required:
            raise RequestAuthError("Authentication required.")

        if self.fallback_user_id:
            return RequestIdentity(
                user_id=self.fallback_user_id,
                auth_source="dev_fallback",
            )

        raise RequestAuthError("A fallback user is not configured for unauthenticated requests.")

    def _identity_from_token(self, token: str) -> RequestIdentity:
        if jwt is None:
            raise RequestAuthError("PyJWT is required for bearer token verification.")
        if not self.issuer:
            raise RequestAuthError("Supabase auth verification is not configured on the backend.")

        try:
            algorithm = self._token_algorithm(token)
            normalized_algorithm = algorithm.upper()
            verification_key: Any
            allowed_algorithms: list[str]
            if normalized_algorithm.startswith("HS"):
                if not self.jwt_secret:
                    raise RequestAuthError(
                        f"{algorithm} bearer tokens require SUPABASE_JWT_SECRET on the backend."
                    )
                verification_key = self.jwt_secret
                allowed_algorithms = [algorithm]
            else:
                if PyJWKClient is None:
                    raise RequestAuthError("PyJWT is required for bearer token verification.")
                if not self.jwks_url:
                    raise RequestAuthError("Supabase auth verification is not configured on the backend.")
                jwk_client = self._jwk_client_instance()
                signing_key = jwk_client.get_signing_key_from_jwt(token)
                verification_key = signing_key.key
                allowed_algorithms = [algorithm]
            claims = jwt.decode(
                token,
                verification_key,
                algorithms=allowed_algorithms,
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
    def _token_algorithm(token: str) -> str:
        try:
            header = jwt.get_unverified_header(token)
        except Exception as error:  # noqa: BLE001
            raise RequestAuthError(f"Bearer token verification failed: {error}") from error
        algorithm = str(header.get("alg") or "").strip()
        if not algorithm:
            raise RequestAuthError("Bearer token header is missing the signing algorithm.")
        return algorithm

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
