"""Tests for the Phase 2a public-profile READ endpoints.

Covers `GET /api/v1/profiles/{userId}/deck/entries` and
`GET /api/v1/profiles/{userId}/portfolio/summary`:

- the explicit-owner service reads return the TARGET user's rows, never the
  caller's, and never mutate the ambient (caller) request identity,
- the routes require an authenticated caller (401) and a plausible uuid in the
  path (400),
- the ambient-context service methods are now thin wrappers over the
  explicit-owner implementations, and
- no write route (do_POST / do_DELETE) accepts a target-user parameter.

See docs/portfolio-social-phase-2-public-profiles-follow-2026-07-23.md.
"""

from __future__ import annotations

import contextlib
import inspect
import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from request_auth import RequestAuthError, RequestIdentity  # noqa: E402
from server import (  # noqa: E402
    SpotlightRequestHandler,
    SpotlightScanService,
    is_plausible_user_id,
)

CALLER_USER_ID = "11111111-1111-4111-8111-111111111111"
TARGET_USER_ID = "22222222-2222-4222-8222-222222222222"


class PublicProfileReadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "public-profile-reads.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    @staticmethod
    def _identity(user_id: str) -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(self, *, card_id: str, name: str, number: str) -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name="Base Set",
            number=number,
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            set_id="bs",
            set_ptcgo_code="BS",
            set_release_date="2026-07-23",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def _record_buy(self, *, user_id: str, card_id: str, quantity: int = 1) -> str:
        with self.service.request_identity_context(self._identity(user_id)):
            return self.service.record_buy(
                {
                    "cardID": card_id,
                    "quantity": quantity,
                    "unitPrice": 5.0,
                    "currencyCode": "USD",
                    "boughtAt": "2026-07-23T10:00:00Z",
                    "condition": "near_mint",
                }
            )["deckEntryID"]

    def _seed_two_owners(self) -> tuple[str, str]:
        self._insert_card(card_id="base-pikachu-58", name="Pikachu", number="58/102")
        self._insert_card(card_id="base-charizard-4", name="Charizard", number="4/102")
        caller_entry = self._record_buy(user_id=CALLER_USER_ID, card_id="base-pikachu-58")
        target_entry = self._record_buy(
            user_id=TARGET_USER_ID, card_id="base-charizard-4", quantity=3
        )
        return caller_entry, target_entry

    # --- service layer: explicit owner wins over the ambient identity ---------

    def test_deck_entries_for_owner_returns_target_rows_not_caller_rows(self) -> None:
        caller_entry, target_entry = self._seed_two_owners()

        # The ambient identity is the CALLER for the whole read, exactly like the
        # HTTP route does it; the owner comes from the explicit argument.
        with self.service.request_identity_context(self._identity(CALLER_USER_ID)):
            public_payload = self.service.deck_entries_for_owner(
                TARGET_USER_ID, limit=10
            )
            own_payload = self.service.deck_entries(limit=10)
            # The ambient owner is untouched by the explicit-owner read.
            self.assertEqual(self.service._current_owner_user_id(), CALLER_USER_ID)  # noqa: SLF001

        self.assertEqual(
            [entry["id"] for entry in public_payload["entries"]], [target_entry]
        )
        self.assertEqual(
            [entry["card"]["id"] for entry in public_payload["entries"]],
            ["base-charizard-4"],
        )
        self.assertEqual([entry["id"] for entry in own_payload["entries"]], [caller_entry])
        self.assertEqual(
            [entry["card"]["id"] for entry in own_payload["entries"]],
            ["base-pikachu-58"],
        )

    def test_deck_entries_for_owner_payload_shape_matches_owner_read(self) -> None:
        self._seed_two_owners()

        with self.service.request_identity_context(self._identity(TARGET_USER_ID)):
            owner_payload = self.service.deck_entries(limit=10)
        with self.service.request_identity_context(self._identity(CALLER_USER_ID)):
            public_payload = self.service.deck_entries_for_owner(TARGET_USER_ID, limit=10)

        self.assertEqual(sorted(owner_payload.keys()), sorted(public_payload.keys()))
        self.assertEqual(
            sorted(owner_payload["summary"].keys()),
            sorted(public_payload["summary"].keys()),
        )
        self.assertEqual(
            sorted(owner_payload["entries"][0].keys()),
            sorted(public_payload["entries"][0].keys()),
        )

    def test_deck_entries_is_a_thin_wrapper_over_the_explicit_owner_form(self) -> None:
        captured: dict[str, object] = {}

        def _fake(owner_user_id: str, **kwargs: object) -> dict[str, object]:
            captured["owner_user_id"] = owner_user_id
            captured.update(kwargs)
            return {"entries": [], "summary": {}}

        self.service.deck_entries_for_owner = _fake  # type: ignore[method-assign]
        with self.service.request_identity_context(self._identity(CALLER_USER_ID)):
            self.service.deck_entries(limit=7, offset=3, include_inactive=True)

        self.assertEqual(
            captured,
            {
                "owner_user_id": CALLER_USER_ID,
                "limit": 7,
                "offset": 3,
                "include_inactive": True,
                "favorites_only": False,
                "compute_day_change": True,
            },
        )

    def test_explicit_owner_reads_reject_an_empty_owner(self) -> None:
        with self.assertRaises(ValueError):
            self.service.deck_entries_for_owner("   ")
        with self.assertRaises(ValueError):
            self.service.portfolio_summary_for_owner("")

    def test_portfolio_summary_for_owner_shape_and_scope(self) -> None:
        self._seed_two_owners()

        with self.service.request_identity_context(self._identity(CALLER_USER_ID)):
            summary = self.service.portfolio_summary_for_owner(TARGET_USER_ID)

        self.assertEqual(
            sorted(summary.keys()), ["cardCount", "currency", "totalValue", "userId"]
        )
        self.assertEqual(summary["userId"], TARGET_USER_ID)
        self.assertEqual(summary["currency"], "USD")
        # Quantity 3 of one card for the target; the caller's single card is not counted.
        self.assertEqual(summary["cardCount"], 3)
        self.assertIsInstance(summary["totalValue"], float)

    def test_portfolio_summary_for_owner_is_zero_for_an_unknown_user(self) -> None:
        self._seed_two_owners()
        unknown_user_id = "33333333-3333-4333-8333-333333333333"

        with self.service.request_identity_context(self._identity(CALLER_USER_ID)):
            summary = self.service.portfolio_summary_for_owner(unknown_user_id)

        self.assertEqual(
            summary,
            {
                "userId": unknown_user_id,
                "totalValue": 0.0,
                "cardCount": 0,
                "currency": "USD",
            },
        )

    # --- uuid validation helper ----------------------------------------------

    def test_is_plausible_user_id(self) -> None:
        self.assertTrue(is_plausible_user_id(TARGET_USER_ID))
        self.assertTrue(is_plausible_user_id(f"  {TARGET_USER_ID.upper()}  "))
        for bad in ("", "   ", None, "user-a", "../../etc/passwd", TARGET_USER_ID[:-1]):
            self.assertFalse(is_plausible_user_id(bad), bad)


class PublicProfileRouteTests(unittest.TestCase):
    """Route-level dispatch tests against a mocked service (same pattern as
    ``test_card_favorites``)."""

    @staticmethod
    def _handler(path: str) -> SpotlightRequestHandler:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.headers = {}
        handler.service = Mock()
        handler.service.request_identity_context.return_value = contextlib.nullcontext()
        return handler

    def test_public_deck_entries_route_reads_the_target_owner_explicitly(self) -> None:
        caller = RequestIdentity(user_id=CALLER_USER_ID, auth_source="test")
        handler = self._handler(
            f"/api/v1/profiles/{TARGET_USER_ID}/deck/entries?limit=25&offset=10"
        )
        handler.service.deck_entries_for_owner.return_value = {
            "entries": [],
            "summary": {"count": 0},
        }
        handler._require_request_identity = lambda: caller  # type: ignore[method-assign]
        handler._write_json = Mock()  # type: ignore[method-assign]

        handler.do_GET()

        # The ambient context still holds the CALLER, not the target.
        handler.service.request_identity_context.assert_called_once_with(caller)
        handler.service.deck_entries_for_owner.assert_called_once_with(
            TARGET_USER_ID,
            limit=25,
            offset=10,
            include_inactive=False,
            favorites_only=False,
        )
        # The owner-scoped (ambient) read is never used for a public profile.
        handler.service.deck_entries.assert_not_called()
        handler._write_json.assert_called_once_with(
            HTTPStatus.OK, handler.service.deck_entries_for_owner.return_value
        )

    def test_public_portfolio_summary_route_reads_the_target_owner_explicitly(self) -> None:
        caller = RequestIdentity(user_id=CALLER_USER_ID, auth_source="test")
        handler = self._handler(f"/api/v1/profiles/{TARGET_USER_ID}/portfolio/summary")
        handler.service.portfolio_summary_for_owner.return_value = {
            "userId": TARGET_USER_ID,
            "totalValue": 12.5,
            "cardCount": 3,
            "currency": "USD",
        }
        handler._require_request_identity = lambda: caller  # type: ignore[method-assign]
        handler._write_json = Mock()  # type: ignore[method-assign]

        handler.do_GET()

        handler.service.request_identity_context.assert_called_once_with(caller)
        handler.service.portfolio_summary_for_owner.assert_called_once_with(TARGET_USER_ID)
        # The expensive per-owner dashboard/history stays owner-only.
        handler.service.portfolio_dashboard.assert_not_called()
        handler.service.deck_history.assert_not_called()
        handler._write_json.assert_called_once_with(
            HTTPStatus.OK, handler.service.portfolio_summary_for_owner.return_value
        )

    def _unauthenticated_status(self, path: str) -> tuple[HTTPStatus, Mock]:
        handler = self._handler(path)
        handler.service.authenticator.resolve_identity.side_effect = RequestAuthError(
            "Authenticated request identity is required."
        )
        writes: list[tuple[HTTPStatus, dict[str, object]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]

        handler.do_GET()

        self.assertEqual(len(writes), 1)
        return writes[0][0], handler.service

    def test_public_routes_require_authentication(self) -> None:
        for path in (
            f"/api/v1/profiles/{TARGET_USER_ID}/deck/entries",
            f"/api/v1/profiles/{TARGET_USER_ID}/portfolio/summary",
        ):
            with self.subTest(path=path):
                status, service = self._unauthenticated_status(path)
                self.assertEqual(status, HTTPStatus.UNAUTHORIZED)
                service.deck_entries_for_owner.assert_not_called()
                service.portfolio_summary_for_owner.assert_not_called()

    def _bad_request_status(self, path: str) -> tuple[HTTPStatus, Mock]:
        caller = RequestIdentity(user_id=CALLER_USER_ID, auth_source="test")
        handler = self._handler(path)
        handler._require_request_identity = lambda: caller  # type: ignore[method-assign]
        writes: list[tuple[HTTPStatus, dict[str, object]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]

        handler.do_GET()

        self.assertEqual(len(writes), 1, path)
        return writes[0][0], handler.service

    def test_public_routes_reject_a_missing_or_invalid_user_id(self) -> None:
        bad_paths = [
            "/api/v1/profiles//deck/entries",
            "/api/v1/profiles/not-a-uuid/deck/entries",
            "/api/v1/profiles/..%2F..%2Fetc/deck/entries",
            f"/api/v1/profiles/{TARGET_USER_ID}x/deck/entries",
            "/api/v1/profiles//portfolio/summary",
            "/api/v1/profiles/not-a-uuid/portfolio/summary",
        ]
        for path in bad_paths:
            with self.subTest(path=path):
                status, service = self._bad_request_status(path)
                self.assertEqual(status, HTTPStatus.BAD_REQUEST)
                service.deck_entries_for_owner.assert_not_called()
                service.portfolio_summary_for_owner.assert_not_called()

    # --- the structural guarantee: no write route takes a target user ---------

    def test_no_write_route_accepts_a_target_user_parameter(self) -> None:
        write_verbs = [
            name
            for name in dir(SpotlightRequestHandler)
            if name.startswith("do_") and name not in {"do_GET", "do_HEAD", "do_OPTIONS"}
        ]
        self.assertEqual(sorted(write_verbs), ["do_DELETE", "do_POST"])

        forbidden = (
            "PUBLIC_PROFILE_PATH_PREFIX",
            "/api/v1/profiles/",
            "_public_profile_target_user_id",
            "_for_owner(",
            "deck_entries_for_owner",
            "portfolio_summary_for_owner",
        )
        for verb in write_verbs:
            source = inspect.getsource(getattr(SpotlightRequestHandler, verb))
            for token in forbidden:
                self.assertNotIn(
                    token,
                    source,
                    f"{verb} must not accept or route on a target-user parameter ({token})",
                )

    def test_public_profile_routes_only_exist_on_do_get(self) -> None:
        get_source = inspect.getsource(SpotlightRequestHandler.do_GET)
        self.assertIn("PUBLIC_PROFILE_DECK_ENTRIES_SUFFIX", get_source)
        self.assertIn("PUBLIC_PROFILE_SUMMARY_SUFFIX", get_source)
        self.assertIn("deck_entries_for_owner", get_source)
        self.assertIn("portfolio_summary_for_owner", get_source)


if __name__ == "__main__":
    unittest.main()
