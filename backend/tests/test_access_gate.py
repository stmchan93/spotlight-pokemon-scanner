"""Tests for the public App Store ACCESS GATE.

Covers the service-level gate logic added for the public-store rollout:

- closed gate (card-show-mode inactive) blocks a non-allowed user,
- the admin email is always allowed,
- redeeming the hardcoded invite code grants persistent per-account access
  (a fresh identity for the same user_id stays allowed),
- a wrong code is rejected, and
- when card-show-mode is active everyone is allowed.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class AccessGateTests(unittest.TestCase):
    def setUp(self) -> None:
        # Admin emails + invite codes are configured via environment (not source),
        # so provide the fixtures the gate logic reads.
        self._env_patch = patch.dict(
            os.environ,
            {
                "SPOTLIGHT_ACCESS_ADMIN_EMAILS": "stmchan8953@gmail.com",
                "SPOTLIGHT_ACCESS_INVITE_CODES": "ekalight_special_guest",
            },
        )
        self._env_patch.start()
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "access-gate.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        # Ensure the gate starts CLOSED for the default fixtures.
        self.service.clear_card_show_mode()

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()
        self._env_patch.stop()

    @staticmethod
    def _identity(user_id: str, email: str = "") -> RequestIdentity:
        return RequestIdentity(user_id=user_id, email=email, auth_source="test")

    # (a) closed gate blocks a non-allowed user
    def test_closed_gate_blocks_non_allowed_user(self) -> None:
        identity = self._identity("user-nobody", "nobody@example.com")
        with self.service.request_identity_context(identity):
            self.assertFalse(self.service._card_show_mode_active())
            self.assertFalse(self.service.access_allowed(identity))
            status = self.service.access_status(identity)
        self.assertFalse(status["allowed"])
        self.assertFalse(status["accessOpen"])
        self.assertFalse(status["isAdmin"])

    # (b) admin email always allowed
    def test_admin_email_always_allowed(self) -> None:
        # Case-insensitive admin match, gate still closed.
        identity = self._identity("user-admin", "STMchan8953@gmail.com")
        with self.service.request_identity_context(identity):
            self.assertFalse(self.service._card_show_mode_active())
            self.assertTrue(self.service.access_allowed(identity))
            status = self.service.access_status(identity)
        self.assertTrue(status["allowed"])
        self.assertTrue(status["isAdmin"])

    # (b') whitelisted email allowed via runtime setting
    def test_whitelisted_email_allowed(self) -> None:
        from catalog_tools import upsert_runtime_setting
        from server import ACCESS_WHITELIST_SETTING_KEY

        upsert_runtime_setting(
            self.service.connection,
            key=ACCESS_WHITELIST_SETTING_KEY,
            value={"emails": ["Friend@Example.com"]},
        )
        self.service.connection.commit()
        identity = self._identity("user-friend", "friend@example.com")
        with self.service.request_identity_context(identity):
            self.assertTrue(self.service.access_allowed(identity))

    # (c) redeeming the invite code grants persistent access
    def test_redeem_invite_code_grants_persistent_access(self) -> None:
        identity = self._identity("user-guest", "guest@example.com")
        with self.service.request_identity_context(identity):
            self.assertFalse(self.service.access_allowed(identity))
            result = self.service.redeem_invite_code(identity, "  EKALIGHT_SPECIAL_GUEST  ")
            self.assertEqual(result, {"redeemed": True, "allowed": True})
            self.assertTrue(self.service.access_allowed(identity))

        # A fresh identity object for the same user_id is still allowed
        # (the grant is persisted to the account, not the in-memory identity).
        fresh_identity = self._identity("user-guest", "guest@example.com")
        with self.service.request_identity_context(fresh_identity):
            self.assertTrue(self.service._access_has_grant("user-guest"))
            self.assertTrue(self.service.access_allowed(fresh_identity))

    # (d) a wrong code raises invalid
    def test_wrong_code_rejected(self) -> None:
        identity = self._identity("user-guest2", "guest2@example.com")
        with self.service.request_identity_context(identity):
            with self.assertRaises(ValueError) as ctx:
                self.service.redeem_invite_code(identity, "not-a-real-code")
            self.assertEqual(str(ctx.exception), "invalid_code")
            self.assertFalse(self.service._access_has_grant("user-guest2"))
            self.assertFalse(self.service.access_allowed(identity))

    # (e) when card-show-mode is active everyone is allowed
    def test_card_show_mode_open_allows_everyone(self) -> None:
        self.service.set_card_show_mode(duration_hours=8)
        identity = self._identity("user-random", "random@example.com")
        with self.service.request_identity_context(identity):
            self.assertTrue(self.service._card_show_mode_active())
            self.assertTrue(self.service.access_allowed(identity))
            status = self.service.access_status(identity)
        self.assertTrue(status["allowed"])
        self.assertTrue(status["accessOpen"])

    def test_waitlist_email_stored(self) -> None:
        identity = self._identity("user-wait", "wait@example.com")
        with self.service.request_identity_context(identity):
            result = self.service.add_waitlist_email(identity, "wait@example.com")
        self.assertEqual(result, {"ok": True})
        row = self.service.connection.execute(
            "SELECT email, user_id FROM access_waitlist WHERE user_id = ?",
            ("user-wait",),
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["email"], "wait@example.com")

    def test_backfill_grants_existing_users_once(self) -> None:
        # A user with existing data should be auto-granted access (so current
        # users aren't locked out when the gate goes live); a brand-new user is not.
        tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(tempdir.cleanup)
        db_path = Path(tempdir.name) / "backfill.sqlite"
        conn = connect(db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        conn.execute(
            """
            INSERT INTO scan_events (scan_id, owner_user_id, created_at, request_json, response_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("scan-1", "existing-user", "2026-01-01T00:00:00Z", "{}", "{}"),
        )
        conn.commit()
        conn.close()

        # Creating the service runs the one-time backfill over existing data.
        service = SpotlightScanService(db_path, REPO_ROOT)
        self.addCleanup(service.connection.close)
        service.clear_card_show_mode()  # gate CLOSED

        existing = self._identity("existing-user", "someone@example.com")
        fresh = self._identity("brand-new-user", "new@example.com")
        with service.request_identity_context(existing):
            self.assertTrue(service.access_allowed(existing))
        with service.request_identity_context(fresh):
            self.assertFalse(service.access_allowed(fresh))

    def test_access_status_mirrors_user_email(self) -> None:
        # We only receive emails live from the JWT; checking access should mirror
        # the user's email into user_emails so we can list/manage users by email.
        identity = self._identity("user-em", "person@gmail.com")
        with self.service.request_identity_context(identity):
            self.service.access_status(identity)
        row = self.service.connection.execute(
            "SELECT email FROM user_emails WHERE user_id = ?", ("user-em",)
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["email"], "person@gmail.com")

    def test_whitelist_email_add_remove_controls_access(self) -> None:
        # Whitelisting by email (case-insensitive) lets that user in even with the
        # gate closed; removing it locks them out again; bad input is rejected.
        self.service.add_whitelist_email("Friend@Example.com")
        self.assertEqual(self.service.list_whitelist_emails(), ["friend@example.com"])

        identity = self._identity("user-friend", "friend@example.com")
        with self.service.request_identity_context(identity):
            self.assertTrue(self.service.access_allowed(identity))

        self.service.remove_whitelist_email("friend@example.com")
        with self.service.request_identity_context(identity):
            self.assertFalse(self.service.access_allowed(identity))

        with self.assertRaises(ValueError):
            self.service.add_whitelist_email("not-an-email")

    # The mandatory-@handle gate flag rides access_status. It must default OFF
    # (the client fails open on a missing/false flag) and flip via the setter.
    def test_handle_claim_required_defaults_off_and_toggles(self) -> None:
        identity = self._identity("user-handle", "handle@example.com")
        with self.service.request_identity_context(identity):
            status = self.service.access_status(identity)
        self.assertFalse(status["handleClaimRequired"])

        summary = self.service.set_handle_claim_required_mode(enabled=True, note="show prep")
        self.assertTrue(summary["enabled"])
        self.assertEqual(summary["note"], "show prep")
        with self.service.request_identity_context(identity):
            status = self.service.access_status(identity)
        self.assertTrue(status["handleClaimRequired"])

        summary = self.service.set_handle_claim_required_mode(enabled=False)
        self.assertFalse(summary["enabled"])
        with self.service.request_identity_context(identity):
            status = self.service.access_status(identity)
        self.assertFalse(status["handleClaimRequired"])


if __name__ == "__main__":
    unittest.main()
