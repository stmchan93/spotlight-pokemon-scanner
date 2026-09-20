"""Wiring for push notifications.

`expo_push` (message assembly, batching, tickets, receipts) has its own suite.
This one covers everything that joins it to the server: the token/prefs schema,
the four notification endpoints, and the three send steps inside the daily deal
scan — receipts first, the user lane, then the ops lane.

Every Expo call goes through an injected transport. This suite NEVER sends a
real push and never touches the network.
"""

from __future__ import annotations

import contextlib
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import ebay_listings  # noqa: E402
import expo_push  # noqa: E402
from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    upsert_card,
    upsert_runtime_setting,
    utc_now,
)
from ebay_comps import _reset_ebay_token_cache  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import (  # noqa: E402
    OPS_PUSH_USER_IDS_SETTING_KEY,
    SpotlightRequestHandler,
    SpotlightScanService,
    _apply_watch_deal_radar_schema_patch,
)

CARD_ID = "gym1-60"
CARD_NAME = "Sabrina's Slowbro"

NOW = datetime(2026, 9, 19, 12, 0, 0, tzinfo=timezone.utc)

TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]"
TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]"

BROWSE_ENV = {
    "SPOTLIGHT_EBAY_BROWSE_ENABLED": "1",
    "EBAY_CLIENT_ID": "client-id",
    "EBAY_CLIENT_SECRET": "client-secret",
    "EBAY_MARKETPLACE_ID": "EBAY_US",
}


def _summary(*, item_id: str = "v1|110000000001|0", price: str = "70.00") -> dict:
    return {
        "itemId": item_id,
        "legacyItemId": item_id.split("|")[1],
        "title": f"{CARD_NAME} Gym Heroes 60/132 Pokemon Card",
        "price": {"value": price, "currency": "USD"},
        "itemWebUrl": f"https://www.ebay.com/itm/{item_id.split('|')[1]}",
        "buyingOptions": ["FIXED_PRICE"],
        "itemCreationDate": "2026-09-01T07:14:44.000Z",
        "condition": "Ungraded",
        "conditionId": "4000",
        "shippingOptions": [
            {"shippingCostType": "FIXED", "shippingCost": {"value": "0.00", "currency": "USD"}}
        ],
        "image": {"imageUrl": "https://i.ebayimg.com/images/g/abc/s-l1600.jpg"},
    }


class _EbayTransport:
    """The eBay Browse mock. Identical in spirit to test_watch_wiring's."""

    def __init__(self) -> None:
        self.urls: list[str] = []

    def __call__(self, url: str, **kwargs: object) -> dict:
        self.urls.append(url)
        if "identity/v1/oauth2/token" in url:
            return {"access_token": "token-value", "expires_in": 7200}
        if "buy/browse/v1/item_summary/search" in url:
            return {"itemSummaries": [_summary()]}
        raise AssertionError(f"Unexpected URL: {url}")


class _PushTransport:
    """Injected Expo transport. Records every POST and hands back tickets /
    receipts; nothing here reaches exp.host."""

    def __init__(self, *, receipts: dict[str, dict] | None = None) -> None:
        self.sends: list[list[dict]] = []
        self.receipt_requests: list[list[str]] = []
        self.receipts = receipts or {}
        self.ticket_errors: dict[str, dict] = {}  # token -> error ticket
        self._counter = 0

    @property
    def messages(self) -> list[dict]:
        return [message for batch in self.sends for message in batch]

    def __call__(self, url: str, payload: object) -> dict:
        if url == expo_push.EXPO_RECEIPTS_URL:
            ids = list(payload["ids"])  # type: ignore[index]
            self.receipt_requests.append(ids)
            return {
                "data": {
                    receipt_id: self.receipts.get(receipt_id, {"status": "ok"})
                    for receipt_id in ids
                }
            }
        assert url == expo_push.EXPO_PUSH_URL, url
        batch = list(payload)  # type: ignore[arg-type]
        self.sends.append(batch)
        tickets = []
        for message in batch:
            error = self.ticket_errors.get(str(message.get("to")))
            if error is not None:
                tickets.append(error)
                continue
            self._counter += 1
            tickets.append({"status": "ok", "id": f"ticket-{self._counter}"})
        return {"data": tickets}


class PushWiringTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "push-wiring.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self.connection = self.service.connection
        ebay_listings.reset_ebay_usage()
        _reset_ebay_token_cache()
        self.addCleanup(ebay_listings.reset_ebay_usage)
        self.addCleanup(_reset_ebay_token_cache)

    # --- fixtures --------------------------------------------------------

    def _identity(self, user_id: str) -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    @contextlib.contextmanager
    def _as(self, user_id: str):
        with self.service.request_identity_context(self._identity(user_id)):
            yield

    def _card(self, *, image: bool = False) -> None:
        upsert_card(
            self.connection,
            card_id=CARD_ID,
            name=CARD_NAME,
            set_name="Gym Heroes",
            number="60/132",
            rarity="Rare",
            variant="Raw",
            language="English",
            game="pokemon",
            source_provider="scrydex",
            source_record_id=CARD_ID,
            image_url="https://img.test/large.png" if image else None,
            image_small_url="https://img.test/small.png" if image else None,
        )
        self.connection.commit()

    @staticmethod
    def _day(days_ago: int) -> str:
        return (NOW.date() - timedelta(days=days_ago)).isoformat()

    def _watch(self, owner: str, *, added: float = 100.0) -> None:
        self.connection.execute(
            """
            INSERT OR REPLACE INTO card_favorites
                (owner_user_id, card_id, created_at, added_market_price, added_market_date)
            VALUES (?, ?, ?, ?, ?)
            """,
            (owner, CARD_ID, utc_now(), added, self._day(120)),
        )
        self.connection.commit()

    def _history(self, prices: tuple[float, ...] = (100.0, 95.0, 90.0)) -> None:
        for offset, market in enumerate(prices):
            contexts = {
                "variants": {
                    "Normal": {
                        "variant": "Normal",
                        "variantKey": "normal",
                        "conditions": {"NM": {"currencyCode": "USD", "market": market}},
                    }
                }
            }
            self.connection.execute(
                """
                INSERT OR REPLACE INTO card_price_history_daily
                    (card_id, provider, price_date, display_currency_code,
                     raw_contexts_json, updated_at)
                VALUES (?, 'scrydex', ?, 'USD', ?, ?)
                """,
                (CARD_ID, self._day(len(prices) - 1 - offset), json.dumps(contexts), utc_now()),
            )
        self.connection.commit()

    def _register(self, owner: str, token: str = TOKEN_A) -> dict:
        with self._as(owner):
            return self.service.register_push_token(expo_push_token=token)

    def _run_scan(self, push_transport: object | None = None, **kwargs: object) -> dict:
        with patch.dict("os.environ", BROWSE_ENV, clear=False):
            _reset_ebay_token_cache()
            return self.service.run_deal_scan(
                now=NOW,
                fetch_json=_EbayTransport(),
                push_transport=push_transport,
                **kwargs,
            )

    def _token_row(self, owner: str, token: str = TOKEN_A):
        return self.connection.execute(
            "SELECT * FROM user_push_tokens WHERE owner_user_id = ? AND expo_push_token = ?",
            (owner, token),
        ).fetchone()


# --- schema ------------------------------------------------------------------


class PushSchemaTests(PushWiringTestCase):
    def test_patch_creates_the_push_objects(self) -> None:
        for name, kind in (
            ("user_push_tokens", "table"),
            ("user_notification_prefs", "table"),
            ("idx_user_push_tokens_live", "index"),
        ):
            self.assertIsNotNone(
                self.connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?", (kind, name)
                ).fetchone(),
                name,
            )
        for table, column in (
            ("deal_alerts", "push_ticket_id"),
            ("deal_alerts", "push_tickets_json"),
            ("ops_alerts", "sent_ticket_id"),
            ("ops_alerts", "sent_tickets_json"),
        ):
            columns = {
                str(row["name"])
                for row in self.connection.execute(f"PRAGMA table_info({table})").fetchall()
            }
            self.assertIn(column, columns, f"{table}.{column}")

    def test_patch_is_idempotent_on_re_run(self) -> None:
        before = self.connection.execute(
            "SELECT name, sql FROM sqlite_master ORDER BY name"
        ).fetchall()
        _apply_watch_deal_radar_schema_patch(self.connection)
        _apply_watch_deal_radar_schema_patch(self.connection)
        self.connection.commit()
        after = self.connection.execute(
            "SELECT name, sql FROM sqlite_master ORDER BY name"
        ).fetchall()
        self.assertEqual([tuple(row) for row in before], [tuple(row) for row in after])


# --- tokens ------------------------------------------------------------------


class PushTokenTests(PushWiringTestCase):
    def test_register_stores_the_device_metadata(self) -> None:
        with self._as("owner-a"):
            payload = self.service.register_push_token(
                expo_push_token=TOKEN_A,
                platform="ios",
                device_id="device-1",
                app_version="1.2.3",
            )
        self.assertEqual(payload["expoPushToken"], TOKEN_A)
        self.assertEqual(payload["platform"], "ios")
        self.assertEqual(payload["deviceId"], "device-1")
        self.assertEqual(payload["appVersion"], "1.2.3")
        self.assertIsNone(payload["revokedAt"])

    def test_reregistering_revives_a_revoked_token(self) -> None:
        self._register("owner-a")
        with self._as("owner-a"):
            revoked = self.service.revoke_push_token(TOKEN_A)
        self.assertIsNotNone(revoked["revokedAt"])

        with self._as("owner-a"):
            revived = self.service.register_push_token(
                expo_push_token=TOKEN_A, platform="android"
            )

        # Same primary key, resurrected — a reinstall hands back the same token.
        self.assertIsNone(revived["revokedAt"])
        self.assertEqual(revived["platform"], "android")
        self.assertEqual(
            int(
                self.connection.execute(
                    "SELECT COUNT(*) FROM user_push_tokens WHERE owner_user_id = 'owner-a'"
                ).fetchone()[0]
            ),
            1,
        )

    def test_a_malformed_token_is_rejected(self) -> None:
        for bad in ("", "not-a-token", "ExponentPushToken", None):
            with self._as("owner-a"):
                with self.assertRaises(ValueError):
                    self.service.register_push_token(expo_push_token=bad)
        self.assertEqual(
            int(self.connection.execute("SELECT COUNT(*) FROM user_push_tokens").fetchone()[0]),
            0,
        )

    def test_another_owners_token_is_a_404(self) -> None:
        self._register("owner-a")
        with self._as("owner-b"):
            with self.assertRaises(FileNotFoundError):
                self.service.revoke_push_token(TOKEN_A)
        self.assertIsNone(self._token_row("owner-a")["revoked_at"])

    def test_two_owners_can_hold_the_same_token(self) -> None:
        # A shared device: the PK is (owner, token), so both rows exist and one
        # owner's revoke does not silence the other.
        self._register("owner-a")
        self._register("owner-b")
        with self._as("owner-a"):
            self.service.revoke_push_token(TOKEN_A)
        self.assertIsNotNone(self._token_row("owner-a")["revoked_at"])
        self.assertIsNone(self._token_row("owner-b")["revoked_at"])


# --- prefs -------------------------------------------------------------------


class NotificationPrefsTests(PushWiringTestCase):
    def test_an_absent_row_reads_as_on(self) -> None:
        with self._as("owner-a"):
            payload = self.service.notification_prefs()
        self.assertEqual(
            payload, {"dealAlertsEnabled": True, "targetHitsEnabled": True}
        )
        # And reading must NOT materialize a row: the default has to stay absent.
        self.assertEqual(
            int(
                self.connection.execute(
                    "SELECT COUNT(*) FROM user_notification_prefs"
                ).fetchone()[0]
            ),
            0,
        )

    def test_partial_update_returns_the_full_object(self) -> None:
        with self._as("owner-a"):
            payload = self.service.set_notification_prefs(deal_alerts_enabled=False)
        self.assertEqual(
            payload, {"dealAlertsEnabled": False, "targetHitsEnabled": True}
        )
        with self._as("owner-a"):
            payload = self.service.set_notification_prefs(target_hits_enabled=False)
        # The untouched flag keeps its stored value, not the default.
        self.assertEqual(
            payload, {"dealAlertsEnabled": False, "targetHitsEnabled": False}
        )
        with self._as("owner-a"):
            self.assertEqual(self.service.notification_prefs(), payload)

    def test_prefs_are_owner_scoped(self) -> None:
        with self._as("owner-a"):
            self.service.set_notification_prefs(deal_alerts_enabled=False)
        with self._as("owner-b"):
            self.assertTrue(self.service.notification_prefs()["dealAlertsEnabled"])

    def test_non_boolean_is_rejected(self) -> None:
        with self._as("owner-a"):
            with self.assertRaises(ValueError):
                self.service.set_notification_prefs(deal_alerts_enabled="yes")


# --- routes ------------------------------------------------------------------


class NotificationRouteTests(PushWiringTestCase):
    def _handler(self, path: str, body: dict, identity_user: str = "owner-a"):
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.service = self.service
        handler._read_json_body = lambda: body  # type: ignore[method-assign]
        handler._require_request_identity = lambda: self._identity(  # type: ignore[method-assign]
            identity_user
        )
        handler.writes = []  # type: ignore[attr-defined]
        handler._write_json = lambda status, payload: handler.writes.append(  # type: ignore[method-assign]
            (status, payload)
        )
        return handler

    def test_register_route_round_trip(self) -> None:
        handler = self._handler(
            "/api/v1/notifications/push-tokens",
            {"expoPushToken": TOKEN_A, "platform": "ios", "deviceId": "d1"},
        )
        handler.do_POST()
        self.assertEqual(handler.writes[0][0], HTTPStatus.OK)
        self.assertEqual(handler.writes[0][1]["expoPushToken"], TOKEN_A)

    def test_register_route_rejects_a_malformed_token_with_400(self) -> None:
        handler = self._handler(
            "/api/v1/notifications/push-tokens", {"expoPushToken": "nope"}
        )
        handler.do_POST()
        self.assertEqual(handler.writes[0][0], HTTPStatus.BAD_REQUEST)

    def test_revoke_route_is_owner_scoped(self) -> None:
        self._register("owner-a")
        handler = self._handler(
            "/api/v1/notifications/push-tokens/revoke",
            {"expoPushToken": TOKEN_A},
            identity_user="owner-b",
        )
        handler.do_POST()
        self.assertEqual(handler.writes[0][0], HTTPStatus.NOT_FOUND)

        handler = self._handler(
            "/api/v1/notifications/push-tokens/revoke", {"expoPushToken": TOKEN_A}
        )
        handler.do_POST()
        self.assertEqual(handler.writes[0][0], HTTPStatus.OK)
        self.assertIsNotNone(handler.writes[0][1]["revokedAt"])

    def test_prefs_routes(self) -> None:
        handler = self._handler("/api/v1/notifications/prefs", {})
        handler.do_GET()
        self.assertEqual(
            handler.writes[0][1], {"dealAlertsEnabled": True, "targetHitsEnabled": True}
        )

        handler = self._handler(
            "/api/v1/notifications/prefs", {"dealAlertsEnabled": False}
        )
        handler.do_POST()
        self.assertEqual(
            handler.writes[0][1],
            {"dealAlertsEnabled": False, "targetHitsEnabled": True},
        )

    def test_every_notification_route_requires_identity(self) -> None:
        for path, method in (
            ("/api/v1/notifications/prefs", "do_GET"),
            ("/api/v1/notifications/prefs", "do_POST"),
            ("/api/v1/notifications/push-tokens", "do_POST"),
            ("/api/v1/notifications/push-tokens/revoke", "do_POST"),
        ):
            handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
            handler.path = path
            handler.service = Mock()
            handler._read_json_body = lambda: {}  # type: ignore[method-assign]
            # An unauthenticated request: _require_request_identity has already
            # written its own 401 and returns None.
            handler._require_request_identity = lambda: None  # type: ignore[method-assign]
            handler._write_json = Mock()  # type: ignore[method-assign]
            getattr(handler, method)()
            handler.service.register_push_token.assert_not_called()
            handler.service.notification_prefs.assert_not_called()


# --- the send steps inside the scan job --------------------------------------


class DealPushSendTests(PushWiringTestCase):
    def _armed(self, owner: str = "owner-a") -> None:
        self._card()
        self._history()
        self._watch(owner)

    def test_dry_run_sends_nothing(self) -> None:
        self._armed()
        self._register("owner-a")
        push_transport = _PushTransport()

        summary = self._run_scan(push_transport, dry_run=True)

        self.assertTrue(summary["dryRun"])
        self.assertNotIn("push", summary)
        self.assertEqual(push_transport.sends, [])
        self.assertEqual(push_transport.receipt_requests, [])
        self.assertEqual(
            int(self.connection.execute("SELECT COUNT(*) FROM deal_alerts").fetchone()[0]),
            0,
        )

    def test_a_deal_alert_pushes_once_and_persists_the_ticket(self) -> None:
        self._armed()
        self._register("owner-a")
        push_transport = _PushTransport()

        summary = self._run_scan(push_transport)

        self.assertEqual(summary["push"]["deals"]["sent"], 1)
        message = push_transport.messages[0]
        self.assertEqual(message["to"], TOKEN_A)
        self.assertIn(CARD_NAME, message["body"])
        self.assertEqual(message["data"]["type"], "deal_alert")

        row = self.connection.execute("SELECT * FROM deal_alerts").fetchone()
        self.assertIsNotNone(row["push_sent_at"])
        self.assertEqual(row["push_ticket_id"], "ticket-1")
        self.assertEqual(json.loads(row["push_tickets_json"]), {"ticket-1": TOKEN_A})

    def test_one_alert_fans_out_to_every_live_device(self) -> None:
        self._armed()
        self._register("owner-a", TOKEN_A)
        self._register("owner-a", TOKEN_B)
        push_transport = _PushTransport()

        summary = self._run_scan(push_transport)

        self.assertEqual(summary["push"]["deals"]["sent"], 2)
        self.assertEqual(
            {message["to"] for message in push_transport.messages}, {TOKEN_A, TOKEN_B}
        )
        # One row, one claim, two tickets: the {ticketId: token} map is what the
        # next run's receipt sweep needs to revoke the RIGHT device.
        row = self.connection.execute("SELECT * FROM deal_alerts").fetchone()
        self.assertEqual(
            set(json.loads(row["push_tickets_json"]).values()), {TOKEN_A, TOKEN_B}
        )

    def test_prefs_off_silences_the_user_lane(self) -> None:
        self._armed()
        self._register("owner-a")
        with self._as("owner-a"):
            self.service.set_notification_prefs(deal_alerts_enabled=False)
        push_transport = _PushTransport()

        summary = self._run_scan(push_transport)

        self.assertEqual(push_transport.sends, [])
        self.assertEqual(
            summary["push"]["deals"]["skippedByReason"].get(expo_push.SKIP_PREFS_OFF), 1
        )
        # The alert still exists in the feed; only the PUSH was suppressed.
        self.assertEqual(
            int(self.connection.execute("SELECT COUNT(*) FROM deal_alerts").fetchone()[0]),
            1,
        )
        self.assertIsNone(
            self.connection.execute("SELECT push_sent_at FROM deal_alerts").fetchone()[0]
        )

    def test_a_second_scan_does_not_resend_the_same_alert(self) -> None:
        self._armed()
        self._register("owner-a")
        push_transport = _PushTransport()

        self._run_scan(push_transport)
        self._run_scan(push_transport)

        self.assertEqual(len(push_transport.messages), 1)

    def test_the_claim_stamps_commits_and_wins_exactly_once(self) -> None:
        """The structural at-most-once contract: claim() must persist
        push_sent_at, COMMIT it, and return True only for the winner."""
        self._armed()
        self._register("owner-a")
        captured: dict[str, object] = {}

        def _capture(pushes, **kwargs):
            captured["claim"] = kwargs["claim"]
            captured["alert_ids"] = [push.alert_id for push in pushes]
            return expo_push.PushResult()

        with patch.object(expo_push, "send_deal_alert_pushes", _capture):
            self._run_scan(_PushTransport())

        claim = captured["claim"]
        alert_id = captured["alert_ids"][0]  # type: ignore[index]
        self.assertTrue(claim(alert_id))
        # Committed, not just staged: a separate connection must see the stamp.
        other = connect(self.database_path)
        try:
            stamped = other.execute(
                "SELECT push_sent_at FROM deal_alerts WHERE id = ?", (alert_id,)
            ).fetchone()[0]
        finally:
            other.close()
        self.assertIsNotNone(stamped)
        # The second caller loses; expo_push dispatches nothing it has not claimed.
        self.assertFalse(claim(alert_id))

    def test_a_dead_token_from_the_ticket_is_revoked(self) -> None:
        self._armed()
        self._register("owner-a")
        push_transport = _PushTransport()
        push_transport.ticket_errors[TOKEN_A] = {
            "status": "error",
            "message": "not registered",
            "details": {"error": "DeviceNotRegistered"},
        }

        summary = self._run_scan(push_transport)

        self.assertEqual(summary["push"]["deals"]["tokensRevoked"], 1)
        self.assertIsNotNone(self._token_row("owner-a")["revoked_at"])


class ReceiptSweepTests(PushWiringTestCase):
    def _sent_alert(
        self,
        ticket_id: str = "ticket-1",
        token: str = TOKEN_A,
        owner: str = "owner-a",
    ) -> None:
        self._card()
        self.connection.execute(
            """
            INSERT INTO deal_alerts
                (id, owner_user_id, card_id, listing_id, kind, total_cents,
                 baseline_cents, created_at, push_sent_at, push_ticket_id,
                 push_tickets_json)
            VALUES ('a1', ?, ?, 'listing-1', 'under_added', 7000, 9000,
                    ?, ?, ?, ?)
            """,
            (
                owner,
                CARD_ID,
                NOW.isoformat(),
                NOW.isoformat(),
                ticket_id,
                json.dumps({ticket_id: token}),
            ),
        )
        self.connection.commit()

    def test_receipts_revoke_a_token_that_died_after_the_ticket(self) -> None:
        self._register("owner-a")
        self._sent_alert()
        push_transport = _PushTransport(
            receipts={
                "ticket-1": {
                    "status": "error",
                    "message": "not registered",
                    "details": {"error": "DeviceNotRegistered"},
                }
            }
        )

        result = self.service._check_previous_push_receipts(
            self.connection, now=NOW, transport=push_transport
        )

        self.assertEqual(push_transport.receipt_requests, [["ticket-1"]])
        self.assertEqual(result["tokensRevoked"], 1)
        self.assertIsNotNone(self._token_row("owner-a")["revoked_at"])

    def test_an_ok_receipt_leaves_the_token_alone(self) -> None:
        self._register("owner-a")
        self._sent_alert()
        result = self.service._check_previous_push_receipts(
            self.connection, now=NOW, transport=_PushTransport()
        )
        self.assertEqual(result["ok"], 1)
        self.assertEqual(result["tokensRevoked"], 0)
        self.assertIsNone(self._token_row("owner-a")["revoked_at"])

    def test_tickets_older_than_two_days_are_not_re_checked(self) -> None:
        self._register("owner-a")
        self._sent_alert()
        self.connection.execute(
            "UPDATE deal_alerts SET created_at = ?",
            ((NOW - timedelta(days=5)).isoformat(),),
        )
        self.connection.commit()
        push_transport = _PushTransport()
        self.service._check_previous_push_receipts(
            self.connection, now=NOW, transport=push_transport
        )
        self.assertEqual(push_transport.receipt_requests, [])

    def test_the_sweep_runs_before_the_user_lane_fans_out(self) -> None:
        """A token Expo already declared dead must be gone BEFORE this run picks
        its recipients — otherwise today's deal pushes at a corpse."""
        # The dead ticket belongs to ANOTHER owner who shares the device token,
        # so owner-a's own cooldown is untouched and a fresh deal still fires.
        self._register("owner-a")
        self._register("owner-z")
        self._sent_alert(owner="owner-z")
        self._history()
        self._watch("owner-a")
        push_transport = _PushTransport(
            receipts={
                "ticket-1": {
                    "status": "error",
                    "details": {"error": "DeviceNotRegistered"},
                }
            }
        )

        summary = self._run_scan(push_transport)

        # Revocation is by TOKEN, not by owner: a dead device is dead for every
        # account registered on it, so both rows are retired.
        self.assertEqual(summary["push"]["receipts"]["tokensRevoked"], 2)
        self.assertEqual(push_transport.sends, [])
        self.assertEqual(
            summary["push"]["deals"]["skippedByReason"].get(expo_push.SKIP_NO_TOKENS), 1
        )


class OpsPushTests(PushWiringTestCase):
    def _ops_alert(self, alert_id: str = "ops-1") -> None:
        self.connection.execute(
            """
            INSERT INTO ops_alerts (id, created_at, kind, stage, payload_json, sent_at)
            VALUES (?, ?, 'watch_cost_stage', 'Amber', ?, NULL)
            """,
            (alert_id, NOW.isoformat(), json.dumps({"from": "Green", "to": "Amber"})),
        )
        self.connection.commit()

    def _admins(self, *user_ids: str) -> None:
        upsert_runtime_setting(
            self.connection,
            key=OPS_PUSH_USER_IDS_SETTING_KEY,
            value={"userIds": list(user_ids)},
        )
        self.connection.commit()

    def test_ops_sends_ignore_notification_prefs(self) -> None:
        self._register("admin-1")
        with self._as("admin-1"):
            # Every user-facing switch OFF. An operator alarm is not a user
            # preference, so this must change nothing on the ops lane.
            self.service.set_notification_prefs(
                deal_alerts_enabled=False, target_hits_enabled=False
            )
        self._admins("admin-1")
        self._ops_alert()
        push_transport = _PushTransport()

        result = self.service._send_ops_alert_pushes(
            self.connection, transport=push_transport
        )

        self.assertEqual(result["sent"], 1)
        message = push_transport.messages[0]
        self.assertEqual(message["to"], TOKEN_A)
        self.assertEqual(message["data"]["type"], "ops_alert")
        row = self.connection.execute("SELECT * FROM ops_alerts").fetchone()
        self.assertIsNotNone(row["sent_at"])
        self.assertEqual(row["sent_ticket_id"], "ticket-1")

    def test_ops_alerts_never_reach_the_user_feed(self) -> None:
        self._register("admin-1")
        self._admins("admin-1")
        self._ops_alert()
        self.service._send_ops_alert_pushes(self.connection, transport=_PushTransport())
        with self._as("admin-1"):
            feed = self.service.deal_alerts()
        self.assertEqual(feed["alerts"], [])
        self.assertEqual(feed["unseenCount"], 0)

    def test_a_claimed_ops_alert_is_not_sent_twice(self) -> None:
        self._register("admin-1")
        self._admins("admin-1")
        self._ops_alert()
        push_transport = _PushTransport()
        self.service._send_ops_alert_pushes(self.connection, transport=push_transport)
        self.service._send_ops_alert_pushes(self.connection, transport=push_transport)
        self.assertEqual(len(push_transport.messages), 1)

    def test_admin_ids_fall_back_to_the_environment(self) -> None:
        self._register("admin-env")
        self._ops_alert()
        with patch.dict(
            "os.environ", {expo_push.OPS_PUSH_USER_IDS_ENV: "admin-env"}, clear=False
        ):
            result = self.service._send_ops_alert_pushes(
                self.connection, transport=_PushTransport()
            )
        self.assertEqual(result["sent"], 1)

    def test_the_scan_job_pushes_the_tripwire_edge(self) -> None:
        self._register("admin-1")
        self._admins("admin-1")
        push_transport = _PushTransport()

        summary = self._run_scan(push_transport)

        # First cycle: both stages cross from "unknown", so the edge-trigger
        # writes two ops rows and the ops lane sends both.
        self.assertEqual(len(summary["opsAlerts"]), 2)
        self.assertEqual(summary["push"]["ops"]["sent"], 2)
        self.assertTrue(
            all(m["data"]["type"] == "ops_alert" for m in push_transport.messages)
        )


if __name__ == "__main__":
    unittest.main()
