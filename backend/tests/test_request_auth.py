from __future__ import annotations

import unittest

from backend.request_auth import RequestAuthError, SupabaseRequestAuthenticator


class SupabaseRequestAuthenticatorTests(unittest.TestCase):
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
