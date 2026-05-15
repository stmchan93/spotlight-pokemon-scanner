from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
import unittest
from http import HTTPStatus
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, upsert_deck_entry  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
import server as server_module  # noqa: E402
from server import (  # noqa: E402
    ORDER_STATUS_CANCELLED,
    ORDER_STATUS_FAILED,
    ORDER_STATUS_PAID,
    ORDER_STATUS_PENDING,
    SpotlightRequestHandler,
    SpotlightScanService,
    StripePaymentsService,
)
import stripe_payments as stripe_payments_module  # noqa: E402


def _identity(user_id: str) -> RequestIdentity:
    return RequestIdentity(user_id=user_id, auth_source="test")


class _MockHandler(SpotlightRequestHandler):
    """A request handler instance that skips network setup."""

    def __init__(self, path: str, body: bytes = b"", headers: dict | None = None) -> None:
        # Avoid BaseHTTPRequestHandler.__init__ (would try to read from a real socket).
        self.path = path
        self.rfile = BytesIO(body)
        self.wfile = BytesIO()
        self.headers = headers or {"Content-Length": str(len(body))}
        self._json_writes: list[tuple[HTTPStatus, dict]] = []
        self._html_writes: list[tuple[HTTPStatus, str]] = []
        self._sent_headers: list[tuple[str, str]] = []
        self._sent_response_code: int | None = None

    # Stub out the response-writing primitives.
    def send_response(self, code, message=None):  # noqa: D401
        self._sent_response_code = int(code)

    def send_header(self, keyword, value):
        self._sent_headers.append((str(keyword), str(value)))

    def end_headers(self):
        pass

    def _write_json(self, status, payload):  # type: ignore[override]
        self._json_writes.append((status, payload))

    def _write_html(self, status, body):  # type: ignore[override]
        self._html_writes.append((status, body))


class StripePaymentsServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "stripe-payments.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.payments = StripePaymentsService(self.service)
        # Pretend Stripe is fully wired so handler-level 503 checks pass.
        os.environ["STRIPE_SECRET_KEY"] = "sk_test_dummy"
        os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_test_dummy"

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()
        for key in ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"):
            os.environ.pop(key, None)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _insert_card(self, card_id: str = "base-charizard-4") -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name="Charizard",
            set_name="Base Set",
            number="4/102",
            rarity="Holo Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            set_id="bs",
            set_ptcgo_code="BS",
            set_release_date="1999-01-09",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def _seed_deck_entry(self, *, owner_user_id: str, card_id: str) -> str:
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id=owner_user_id,
            card_id=card_id,
            quantity=1,
            unit_price=10.0,
            currency_code="USD",
            added_at="2026-05-15T00:00:00Z",
            updated_at="2026-05-15T00:00:00Z",
            event_kind="buy",
        )
        self.service.connection.commit()
        return deck_entry_id

    def _seed_stripe_account(self, owner_user_id: str, *, payouts_enabled: bool = True) -> None:
        with self.service.request_identity_context(_identity(owner_user_id)):
            self.payments._persist_stripe_account_status(
                owner_user_id=owner_user_id,
                stripe_account_id=f"acct_{owner_user_id}",
                charges_enabled=True,
                payouts_enabled=payouts_enabled,
                requirements_due=[],
                country="US",
            )

    # ------------------------------------------------------------------
    # Onboarding
    # ------------------------------------------------------------------

    def test_onboard_creates_account_and_returns_link(self) -> None:
        mock_create = patch(
            "server.stripe_create_express_account",
            return_value={"id": "acct_NEW1", "country": "US", "charges_enabled": False, "payouts_enabled": False},
        )
        mock_link = patch(
            "server.stripe_create_account_link",
            return_value={"url": "https://stripe.test/onboard/acct_NEW1"},
        )
        with mock_create as create_mock, mock_link as link_mock:
            with self.service.request_identity_context(_identity("seller-1")):
                payload = self.payments.onboard_stripe_connect(
                    {"refresh_url": "https://looty.app/r", "return_url": "https://looty.app/done"}
                )
        self.assertEqual(payload["onboarding_url"], "https://stripe.test/onboard/acct_NEW1")
        self.assertEqual(payload["stripe_account_id"], "acct_NEW1")
        create_mock.assert_called_once()
        link_mock.assert_called_once()
        row = self.service.connection.execute(
            "SELECT * FROM stripe_accounts WHERE owner_user_id = ?", ("seller-1",)
        ).fetchone()
        self.assertEqual(str(row["stripe_account_id"]), "acct_NEW1")

    def test_onboard_reuses_existing_account(self) -> None:
        self._seed_stripe_account("seller-1", payouts_enabled=False)
        with patch("server.stripe_create_express_account") as create_mock, patch(
            "server.stripe_create_account_link", return_value={"url": "https://stripe.test/onboard/again"}
        ) as link_mock:
            with self.service.request_identity_context(_identity("seller-1")):
                payload = self.payments.onboard_stripe_connect(
                    {"refresh_url": "https://looty.app/r", "return_url": "https://looty.app/done"}
                )
        create_mock.assert_not_called()
        link_mock.assert_called_once()
        self.assertEqual(payload["stripe_account_id"], "acct_seller-1")
        self.assertEqual(payload["onboarding_url"], "https://stripe.test/onboard/again")

    def test_status_endpoint_mirrors_stripe_and_persists(self) -> None:
        self._seed_stripe_account("seller-1", payouts_enabled=False)
        with patch(
            "server.stripe_fetch_account_status",
            return_value={
                "charges_enabled": True,
                "payouts_enabled": True,
                "requirements_due": ["legal_entity.dob"],
                "country": "US",
            },
        ):
            with self.service.request_identity_context(_identity("seller-1")):
                status = self.payments.stripe_connect_status()
        self.assertTrue(status["onboarded"])
        self.assertTrue(status["payouts_enabled"])
        self.assertEqual(status["requirements_due"], ["legal_entity.dob"])
        row = self.service.connection.execute(
            "SELECT * FROM stripe_accounts WHERE owner_user_id = ?", ("seller-1",)
        ).fetchone()
        self.assertEqual(int(row["payouts_enabled"]), 1)
        self.assertIn("legal_entity.dob", json.loads(row["requirements_due_json"]))

    # ------------------------------------------------------------------
    # Orders
    # ------------------------------------------------------------------

    def test_create_order_requires_onboarded_seller(self) -> None:
        self._insert_card()
        self._seed_stripe_account("seller-1", payouts_enabled=False)
        deck_entry_id = self._seed_deck_entry(owner_user_id="seller-1", card_id="base-charizard-4")
        with self.service.request_identity_context(_identity("seller-1")):
            with self.assertRaises(ValueError):
                self.payments.create_order({"deck_entry_id": deck_entry_id, "amount_cents": 4000})

    def test_create_order_persists_row_and_returns_qr_url(self) -> None:
        self._insert_card()
        self._seed_stripe_account("seller-1", payouts_enabled=True)
        deck_entry_id = self._seed_deck_entry(owner_user_id="seller-1", card_id="base-charizard-4")
        with patch(
            "server.stripe_create_checkout_session",
            return_value={
                "id": "cs_test_123",
                "url": "https://checkout.stripe.test/cs_test_123",
                "payment_intent": "pi_test_123",
            },
        ) as session_mock:
            with self.service.request_identity_context(_identity("seller-1")):
                payload = self.payments.create_order(
                    {"deck_entry_id": deck_entry_id, "amount_cents": 4000, "condition": "near_mint"}
                )
        session_mock.assert_called_once()
        self.assertTrue(payload["qr_url"].endswith(payload["qr_token"]))
        self.assertEqual(payload["checkout_url"], "https://checkout.stripe.test/cs_test_123")
        row = self.service.connection.execute(
            "SELECT * FROM orders WHERE order_id = ?", (payload["order_id"],)
        ).fetchone()
        self.assertEqual(str(row["status"]), ORDER_STATUS_PENDING)
        self.assertEqual(str(row["stripe_checkout_session_id"]), "cs_test_123")
        self.assertEqual(int(row["amount_cents"]), 4000)
        # Default fee_bps is 400 -> 4% of 4000 = 160.
        self.assertEqual(int(row["application_fee_cents"]), 160)

    def test_get_order_requires_seller_or_buyer(self) -> None:
        self._insert_card()
        order_id, _ = self._create_pending_order("seller-1")
        with self.service.request_identity_context(_identity("intruder")):
            with self.assertRaises(PermissionError):
                self.payments.get_order(order_id)
        with self.service.request_identity_context(_identity("seller-1")):
            payload = self.payments.get_order(order_id)
        self.assertEqual(payload["orderID"], order_id)

    def _create_pending_order(self, seller_user_id: str) -> tuple[str, str]:
        self._seed_stripe_account(seller_user_id, payouts_enabled=True)
        deck_entry_id = self._seed_deck_entry(owner_user_id=seller_user_id, card_id="base-charizard-4")
        with patch(
            "server.stripe_create_checkout_session",
            return_value={"id": "cs_pending", "url": "https://checkout.stripe.test/cs_pending"},
        ):
            with self.service.request_identity_context(_identity(seller_user_id)):
                payload = self.payments.create_order(
                    {"deck_entry_id": deck_entry_id, "amount_cents": 4000}
                )
        return payload["order_id"], deck_entry_id

    # ------------------------------------------------------------------
    # QR redirect
    # ------------------------------------------------------------------

    def test_qr_redirect_route_returns_302(self) -> None:
        self._insert_card()
        order_id, _ = self._create_pending_order("seller-1")
        row = self.service.connection.execute(
            "SELECT qr_token FROM orders WHERE order_id = ?", (order_id,)
        ).fetchone()
        qr_token = str(row["qr_token"])

        handler = _MockHandler(path=f"/o/{qr_token}")
        SpotlightRequestHandler.service = self.service
        SpotlightRequestHandler.payments_service = self.payments
        handler.do_GET()
        self.assertEqual(handler._sent_response_code, HTTPStatus.FOUND.value)
        location_headers = [v for k, v in handler._sent_headers if k.lower() == "location"]
        self.assertEqual(location_headers, ["https://checkout.stripe.test/cs_pending"])

    # ------------------------------------------------------------------
    # Webhook
    # ------------------------------------------------------------------

    def test_webhook_rejects_bad_signature(self) -> None:
        with patch(
            "server.stripe_verify_webhook_signature",
            side_effect=stripe_payments_module.StripeSignatureError("bad sig"),
        ):
            with self.assertRaises(stripe_payments_module.StripeSignatureError):
                self.payments.handle_webhook(b"{}", "bad")

    def test_webhook_is_idempotent_for_repeated_event_id(self) -> None:
        event = {"id": "evt_dup_1", "type": "account.updated", "data": {"object": {"id": "acct_x"}}}
        with patch("server.stripe_verify_webhook_signature", return_value=event):
            first = self.payments.handle_webhook(b"{}", "sig")
            second = self.payments.handle_webhook(b"{}", "sig")
        self.assertFalse(first.get("duplicate"))
        self.assertTrue(second.get("duplicate"))
        rows = self.service.connection.execute(
            "SELECT COUNT(*) AS count FROM stripe_events WHERE event_id = ?", ("evt_dup_1",)
        ).fetchone()
        self.assertEqual(int(rows["count"]), 1)

    def test_checkout_session_completed_marks_paid_and_decrements_quantity(self) -> None:
        self._insert_card()
        order_id, deck_entry_id = self._create_pending_order("seller-1")
        # Pre-check quantity is 1.
        starting_qty = int(
            self.service.connection.execute(
                "SELECT quantity FROM deck_entries WHERE id = ?", (deck_entry_id,)
            ).fetchone()["quantity"]
        )
        self.assertEqual(starting_qty, 1)

        event = {
            "id": "evt_completed_1",
            "type": "checkout.session.completed",
            "data": {"object": {"id": "cs_pending", "payment_intent": "pi_pending_1"}},
        }
        with patch("server.stripe_verify_webhook_signature", return_value=event):
            self.payments.handle_webhook(b"{}", "sig")

        row = self.service.connection.execute(
            "SELECT * FROM orders WHERE order_id = ?", (order_id,)
        ).fetchone()
        self.assertEqual(str(row["status"]), ORDER_STATUS_PAID)
        self.assertEqual(str(row["stripe_payment_intent_id"]), "pi_pending_1")
        new_qty = int(
            self.service.connection.execute(
                "SELECT quantity FROM deck_entries WHERE id = ?", (deck_entry_id,)
            ).fetchone()["quantity"]
        )
        self.assertEqual(new_qty, 0)
        sale_count = int(
            self.service.connection.execute(
                "SELECT COUNT(*) AS count FROM sale_events WHERE deck_entry_id = ?",
                (deck_entry_id,),
            ).fetchone()["count"]
        )
        self.assertEqual(sale_count, 1)
        sale_row = self.service.connection.execute(
            "SELECT payment_method, total_price FROM sale_events WHERE deck_entry_id = ?",
            (deck_entry_id,),
        ).fetchone()
        self.assertEqual(str(sale_row["payment_method"]), "stripe")
        self.assertAlmostEqual(float(sale_row["total_price"] or 0.0), 40.0)

    def test_checkout_session_expired_marks_order_cancelled(self) -> None:
        self._insert_card()
        order_id, _ = self._create_pending_order("seller-1")
        event = {
            "id": "evt_expired_1",
            "type": "checkout.session.expired",
            "data": {"object": {"id": "cs_pending"}},
        }
        with patch("server.stripe_verify_webhook_signature", return_value=event):
            self.payments.handle_webhook(b"{}", "sig")
        row = self.service.connection.execute(
            "SELECT * FROM orders WHERE order_id = ?", (order_id,)
        ).fetchone()
        self.assertEqual(str(row["status"]), ORDER_STATUS_CANCELLED)

    def test_payment_intent_failed_marks_order_failed(self) -> None:
        self._insert_card()
        order_id, _ = self._create_pending_order("seller-1")
        # Stamp the payment_intent on the order (create_order doesn't until session has one).
        self.service.connection.execute(
            "UPDATE orders SET stripe_payment_intent_id = ? WHERE order_id = ?",
            ("pi_fail_1", order_id),
        )
        self.service.connection.commit()
        event = {
            "id": "evt_failed_1",
            "type": "payment_intent.payment_failed",
            "data": {"object": {"id": "pi_fail_1"}},
        }
        with patch("server.stripe_verify_webhook_signature", return_value=event):
            self.payments.handle_webhook(b"{}", "sig")
        row = self.service.connection.execute(
            "SELECT * FROM orders WHERE order_id = ?", (order_id,)
        ).fetchone()
        self.assertEqual(str(row["status"]), ORDER_STATUS_FAILED)

    # ------------------------------------------------------------------
    # Claim
    # ------------------------------------------------------------------

    def test_claim_endpoint_creates_deck_entry_for_buyer(self) -> None:
        self._insert_card()
        order_id, _ = self._create_pending_order("seller-1")
        # Mark order paid via webhook.
        event = {
            "id": "evt_paid_for_claim",
            "type": "checkout.session.completed",
            "data": {"object": {"id": "cs_pending", "payment_intent": "pi_claim_1"}},
        }
        with patch("server.stripe_verify_webhook_signature", return_value=event):
            self.payments.handle_webhook(b"{}", "sig")
        with self.service.request_identity_context(_identity("buyer-1")):
            result = self.payments.claim_order(
                order_id, {"stripe_session_id": "cs_pending"}
            )
        self.assertEqual(result["buyerUserID"], "buyer-1")
        deck_rows = self.service.connection.execute(
            "SELECT id, card_id, cost_basis_total FROM deck_entries WHERE owner_user_id = ?",
            ("buyer-1",),
        ).fetchall()
        self.assertEqual(len(deck_rows), 1)
        self.assertEqual(str(deck_rows[0]["card_id"]), "base-charizard-4")
        self.assertAlmostEqual(float(deck_rows[0]["cost_basis_total"]), 40.0)

    # ------------------------------------------------------------------
    # Claim page (HTML) + OAuth flow
    # ------------------------------------------------------------------

    def _render_claim_page(self, order_id: str) -> str:
        SpotlightRequestHandler.service = self.service
        SpotlightRequestHandler.payments_service = self.payments
        handler = _MockHandler(path=f"/claim/{order_id}")
        handler.do_GET()
        # The /claim route writes HTML, not JSON.
        self.assertTrue(handler._html_writes, "Expected /claim/<id> to render HTML")
        status, body = handler._html_writes[-1]
        self.assertEqual(status, HTTPStatus.OK)
        return body

    def test_claim_page_renders_oauth_buttons_when_supabase_configured(self) -> None:
        self._insert_card()
        order_id, _ = self._create_pending_order("seller-1")
        os.environ["SUPABASE_URL"] = "https://example.supabase.co"
        os.environ["SUPABASE_ANON_KEY"] = "anon-key-public-test-value"
        try:
            body = self._render_claim_page(order_id)
        finally:
            os.environ.pop("SUPABASE_URL", None)
            os.environ.pop("SUPABASE_ANON_KEY", None)
        # Supabase JS CDN is loaded.
        self.assertIn("cdn.jsdelivr.net/npm/@supabase/supabase-js", body)
        # Apple + Google OAuth buttons are present.
        self.assertIn('data-oauth="apple"', body)
        self.assertIn('data-oauth="google"', body)
        self.assertIn("Continue with Apple", body)
        self.assertIn("Continue with Google", body)
        # The config block contains the supabase URL and anon key.
        self.assertIn('"https://example.supabase.co"', body)
        self.assertIn('"anon-key-public-test-value"', body)
        # The claim API path is wired in for the post-redirect POST.
        self.assertIn(f'/api/v1/payments/orders/{order_id}/claim', body)
        # "Maybe later" fallback link exists.
        self.assertIn('data-action="maybe-later"', body)

    def test_claim_page_renders_fallback_when_supabase_unconfigured(self) -> None:
        self._insert_card()
        order_id, _ = self._create_pending_order("seller-1")
        # Ensure both env vars are unset.
        os.environ.pop("SUPABASE_URL", None)
        os.environ.pop("SUPABASE_ANON_KEY", None)
        os.environ.pop("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL", None)
        os.environ.pop("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY", None)
        body = self._render_claim_page(order_id)
        # Page still renders.
        self.assertIn("<title>Save to Spotlight</title>", body)
        # No OAuth buttons or Supabase JS CDN.
        self.assertNotIn("cdn.jsdelivr.net/npm/@supabase/supabase-js", body)
        self.assertNotIn('data-oauth="apple"', body)
        self.assertNotIn('data-oauth="google"', body)
        # Falls back to "Open Spotlight" deep link + App Store link.
        self.assertIn("looty://order/", body)
        self.assertIn("apps.apple.com/app/looty", body)

    def test_claim_endpoint_accepts_valid_supabase_jwt_via_oauth_flow(self) -> None:
        """Simulate the post-OAuth POST from the claim page with a bearer token."""
        self._insert_card()
        order_id, _ = self._create_pending_order("seller-1")
        event = {
            "id": "evt_paid_for_oauth_claim",
            "type": "checkout.session.completed",
            "data": {"object": {"id": "cs_pending", "payment_intent": "pi_oauth_claim"}},
        }
        with patch("server.stripe_verify_webhook_signature", return_value=event):
            self.payments.handle_webhook(b"{}", "sig")

        SpotlightRequestHandler.service = self.service
        SpotlightRequestHandler.payments_service = self.payments
        body = json.dumps({"stripe_session_id": "cs_pending"}).encode()
        handler = _MockHandler(
            path=f"/api/v1/payments/orders/{order_id}/claim",
            body=body,
            headers={
                "Content-Length": str(len(body)),
                "Authorization": "Bearer eyJhbGciOiJSUzI1NiJ9.fake.sig",
                "Content-Type": "application/json",
            },
        )

        # Mock the authenticator to accept the bearer token and return a
        # RequestIdentity for the buyer. The OAuth round-trip is verified at
        # the Supabase layer in production; here we only assert that the
        # handler honours the Bearer header.
        with patch.object(
            self.service.authenticator,
            "resolve_identity",
            return_value=RequestIdentity(user_id="buyer-oauth-1", auth_source="supabase_jwt"),
        ) as resolve_mock:
            handler.do_POST()

        resolve_mock.assert_called_once()
        bearer_arg = resolve_mock.call_args[0][0]
        self.assertTrue(bearer_arg.startswith("Bearer "))
        self.assertEqual(handler._json_writes[-1][0], HTTPStatus.OK)
        payload = handler._json_writes[-1][1]
        self.assertEqual(payload["buyerUserID"], "buyer-oauth-1")
        # The buyer's deck now contains the claimed card.
        deck_rows = self.service.connection.execute(
            "SELECT card_id FROM deck_entries WHERE owner_user_id = ?", ("buyer-oauth-1",)
        ).fetchall()
        self.assertEqual([str(r["card_id"]) for r in deck_rows], ["base-charizard-4"])

    # ------------------------------------------------------------------
    # 503 / auth tests on the request handler
    # ------------------------------------------------------------------

    def test_returns_503_when_stripe_unconfigured(self) -> None:
        os.environ.pop("STRIPE_SECRET_KEY", None)
        os.environ.pop("STRIPE_WEBHOOK_SECRET", None)
        SpotlightRequestHandler.service = self.service
        SpotlightRequestHandler.payments_service = self.payments

        body = b'{"refresh_url":"https://x","return_url":"https://y"}'
        handler = _MockHandler(
            path="/api/v1/payments/stripe/connect/onboard",
            body=body,
            headers={"Content-Length": str(len(body))},
        )
        handler.do_POST()
        self.assertEqual(handler._json_writes[-1][0], HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertEqual(handler._json_writes[-1][1], {"error": "Stripe not configured on this backend"})

    def test_handler_requires_auth_on_non_webhook_endpoints(self) -> None:
        SpotlightRequestHandler.service = self.service
        SpotlightRequestHandler.payments_service = self.payments
        os.environ["STRIPE_SECRET_KEY"] = "sk_test_dummy"

        body = b'{"refresh_url":"https://x","return_url":"https://y"}'
        handler = _MockHandler(
            path="/api/v1/payments/stripe/connect/onboard",
            body=body,
            headers={"Content-Length": str(len(body))},
        )
        # Force the authenticator to demand a real bearer token.
        original_auth_required = self.service.authenticator.auth_required
        self.service.authenticator.auth_required = True
        try:
            handler.do_POST()
        finally:
            self.service.authenticator.auth_required = original_auth_required
        self.assertEqual(handler._json_writes[-1][0], HTTPStatus.UNAUTHORIZED)

    def test_webhook_route_does_not_require_jwt(self) -> None:
        SpotlightRequestHandler.service = self.service
        SpotlightRequestHandler.payments_service = self.payments
        os.environ["STRIPE_SECRET_KEY"] = "sk_test_dummy"
        os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_test_dummy"
        event = {"id": "evt_no_auth_1", "type": "account.updated", "data": {"object": {"id": "acct_x"}}}
        body = json.dumps(event).encode()
        with patch("server.stripe_verify_webhook_signature", return_value=event):
            handler = _MockHandler(
                path="/api/v1/payments/stripe/webhook",
                body=body,
                headers={"Content-Length": str(len(body)), "Stripe-Signature": "t=1,v1=stub"},
            )
            # auth_required=True should not block this route.
            original_auth_required = self.service.authenticator.auth_required
            self.service.authenticator.auth_required = True
            try:
                handler.do_POST()
            finally:
                self.service.authenticator.auth_required = original_auth_required
        self.assertEqual(handler._json_writes[-1][0], HTTPStatus.OK)
        self.assertTrue(handler._json_writes[-1][1].get("received"))


if __name__ == "__main__":
    unittest.main()
