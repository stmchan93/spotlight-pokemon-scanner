from __future__ import annotations

import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.request_auth import RequestAuthError, SupabaseRequestAuthenticator, jwt


class SupabaseRequestAuthenticatorTests(unittest.TestCase):
    @unittest.skipIf(jwt is None, "PyJWT is not installed in the test environment")
    def test_hs256_bearer_verification_succeeds_with_configured_jwt_secret(self) -> None:
        issuer = "https://example.supabase.co/auth/v1"
        jwt_secret = "0123456789abcdef0123456789abcdef"
        token = jwt.encode(
            {
                "sub": "user-123",
                "iss": issuer,
                "iat": int(time.time()),
                "exp": int(time.time()) + 3600,
            },
            jwt_secret,
            algorithm="HS256",
        )
        authenticator = SupabaseRequestAuthenticator(
            supabase_url="https://example.supabase.co",
            jwt_secret=jwt_secret,
            auth_required=True,
        )

        identity = authenticator.resolve_identity(f"Bearer {token}")

        self.assertEqual(identity.user_id, "user-123")
        self.assertEqual(identity.auth_source, "supabase_jwt")

    @unittest.skipIf(jwt is None, "PyJWT is not installed in the test environment")
    def test_hs256_bearer_verification_requires_configured_jwt_secret_when_auth_required(self) -> None:
        issuer = "https://example.supabase.co/auth/v1"
        jwt_secret = "0123456789abcdef0123456789abcdef"
        token = jwt.encode(
            {
                "sub": "user-123",
                "iss": issuer,
                "iat": int(time.time()),
                "exp": int(time.time()) + 3600,
            },
            jwt_secret,
            algorithm="HS256",
        )
        authenticator = SupabaseRequestAuthenticator(
            supabase_url="https://example.supabase.co",
            auth_required=True,
        )

        with self.assertRaisesRegex(RequestAuthError, "SUPABASE_JWT_SECRET"):
            authenticator.resolve_identity(f"Bearer {token}")

    @unittest.skipIf(jwt is None, "PyJWT is not installed in the test environment")
    def test_asymmetric_algorithm_case_is_preserved_for_decode(self) -> None:
        authenticator = SupabaseRequestAuthenticator(
            supabase_url="https://example.supabase.co",
            auth_required=True,
        )
        mock_signing_key = SimpleNamespace(key="public-key")
        mock_jwk_client = SimpleNamespace(get_signing_key_from_jwt=lambda token: mock_signing_key)

        with (
            patch("backend.request_auth.jwt.get_unverified_header", return_value={"alg": "EdDSA"}),
            patch("backend.request_auth.jwt.decode") as mock_decode,
            patch.object(authenticator, "_jwk_client_instance", return_value=mock_jwk_client),
        ):
            mock_decode.return_value = {
                "sub": "user-123",
                "iss": "https://example.supabase.co/auth/v1",
                "iat": int(time.time()),
                "exp": int(time.time()) + 3600,
            }

            identity = authenticator.resolve_identity("Bearer token-value")

        self.assertEqual(identity.user_id, "user-123")
        self.assertEqual(identity.auth_source, "supabase_jwt")
        self.assertEqual(mock_decode.call_args.kwargs["algorithms"], ["EdDSA"])

    def test_bearer_verification_failure_falls_back_in_local_dev(self) -> None:
        authenticator = SupabaseRequestAuthenticator(
            supabase_url="https://example.supabase.co",
            auth_required=False,
            fallback_user_id="local-dev-user",
        )

        identity = authenticator.resolve_identity("Bearer not-a-real-token")

        self.assertEqual(identity.user_id, "local-dev-user")
        self.assertEqual(identity.auth_source, "dev_fallback_bearer")

    def test_bearer_verification_failure_stays_strict_when_auth_required(self) -> None:
        authenticator = SupabaseRequestAuthenticator(
            supabase_url="https://example.supabase.co",
            auth_required=True,
            fallback_user_id="local-dev-user",
        )

        with self.assertRaises(RequestAuthError):
            authenticator.resolve_identity("Bearer not-a-real-token")


if __name__ == "__main__":
    unittest.main()
