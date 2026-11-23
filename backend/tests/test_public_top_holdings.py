"""Tests for ``GET /api/v1/profiles/top-holdings`` (Search's PEOPLE cards).

- the service ranks each owner's holdings by served USD unit price, drops
  withheld (stale / untrusted), non-USD, zero-quantity and TCGplayer-only slab
  rows, and strips owner-only fields,
- every owner is read EXPLICITLY on the same cached key the public profile
  shares, with the caller's ambient identity untouched,
- the route requires auth, validates every id, and caps the batch size.
"""

from __future__ import annotations

import contextlib
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
    CLIENT_INVENTORY_PAGE_SIZE,
    PUBLIC_TOP_HOLDINGS_MAX_LIMIT,
    PUBLIC_TOP_HOLDINGS_MAX_USERS,
    SpotlightRequestHandler,
    SpotlightScanService,
)

CALLER_USER_ID = "11111111-1111-4111-8111-111111111111"
OWNER_A = "22222222-2222-4222-8222-222222222222"
OWNER_B = "33333333-3333-4333-8333-333333333333"


def _entry(
    entry_id: str,
    *,
    market: float | None,
    card_id: str = "sv1-1",
    quantity: int = 1,
    item_kind: str = "raw",
    currency: str = "USD",
    price_status: str | None = None,
) -> dict[str, object]:
    pricing: dict[str, object] = {"market": market, "currencyCode": currency}
    if price_status:
        pricing["priceStatus"] = price_status
    return {
        "id": entry_id,
        "itemKind": item_kind,
        "card": {"id": card_id, "name": entry_id, "pricing": pricing, "isFavorite": True},
        "slabContext": (
            {"grader": "PSA", "grade": "10", "certNumber": "123456", "variantName": None}
            if item_kind == "slab"
            else None
        ),
        "condition": "near_mint",
        "quantity": quantity,
        "addedAt": "2026-11-01T00:00:00Z",
        "variantName": None,
        "printingImageUrl": None,
        "printingImageSmallUrl": None,
        # Owner-only fields that must never leave this read:
        "costBasisTotal": 12.0,
        "costBasisPerUnit": 12.0,
        "costBasisCents": 1200,
        "listingUrl": "https://ebay.example/1",
        "listingPriceCents": 5000,
        "sourceScanID": "scan-1",
        "sourceConfirmationID": "confirm-1",
        "collectionId": "c1",
        "collectionName": "Secret binder",
        "isFavorite": True,
        "sinceAddedBaselinePrice": 3.0,
    }


class PublicTopHoldingsServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "top-holdings.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _fake_owner_reads(self, by_owner: dict[str, list[dict[str, object]]]) -> list[dict[str, object]]:
        calls: list[dict[str, object]] = []

        def _fake(owner_user_id: str, **kwargs: object) -> dict[str, object]:
            calls.append({"owner": owner_user_id, **kwargs})
            if owner_user_id not in by_owner:
                raise RuntimeError("boom")
            return {"entries": by_owner[owner_user_id], "summary": {}}

        self.service.deck_entries_for_owner = _fake  # type: ignore[method-assign]
        return calls

    def test_ranks_by_unit_price_and_drops_unpriced_rows(self) -> None:
        self._fake_owner_reads(
            {
                OWNER_A: [
                    _entry("cheap", market=2.0),
                    _entry("top", market=900.0),
                    _entry("stale", market=5000.0, price_status="stale"),
                    _entry("untrusted", market=4000.0, price_status="untrusted"),
                    _entry("yen", market=3000.0, currency="JPY"),
                    _entry("sold", market=2500.0, quantity=0),
                    _entry("none", market=None),
                    _entry("tcgplayer-slab", market=2000.0, item_kind="slab", card_id="tcgplayer-123"),
                    _entry("slab", market=450.0, item_kind="slab"),
                ]
            }
        )

        payload = self.service.public_top_holdings_for_owners([OWNER_A], limit=6)

        self.assertEqual(payload["currency"], "USD")
        self.assertEqual(payload["limit"], 6)
        (profile,) = payload["profiles"]
        self.assertEqual(profile["userId"], OWNER_A)
        self.assertTrue(profile["available"])
        self.assertEqual([entry["id"] for entry in profile["entries"]], ["top", "slab", "cheap"])

    def test_strips_owner_only_fields(self) -> None:
        self._fake_owner_reads({OWNER_A: [_entry("slab", market=450.0, item_kind="slab")]})

        (entry,) = self.service.public_top_holdings_for_owners([OWNER_A])["profiles"][0]["entries"]

        self.assertEqual(
            sorted(entry.keys()),
            sorted(
                [
                    "id",
                    "itemKind",
                    "card",
                    "variantName",
                    "printingImageUrl",
                    "printingImageSmallUrl",
                    "slabContext",
                    "condition",
                    "quantity",
                    "addedAt",
                ]
            ),
        )
        self.assertNotIn("isFavorite", entry["card"])
        self.assertNotIn("certNumber", entry["slabContext"])
        self.assertEqual(entry["slabContext"]["grader"], "PSA")

    def test_limit_dedupe_order_and_failure_isolation(self) -> None:
        calls = self._fake_owner_reads(
            {
                OWNER_A: [_entry(f"a{index}", market=float(index + 1)) for index in range(20)],
            }
        )

        payload = self.service.public_top_holdings_for_owners(
            [OWNER_B, OWNER_A, OWNER_A.upper(), OWNER_B], limit=999
        )

        # Request order, each owner once.
        self.assertEqual([profile["userId"] for profile in payload["profiles"]], [OWNER_B, OWNER_A])
        self.assertEqual(payload["limit"], PUBLIC_TOP_HOLDINGS_MAX_LIMIT)
        failed, ok = payload["profiles"]
        self.assertEqual(failed, {"userId": OWNER_B, "entries": [], "available": False})
        self.assertEqual(len(ok["entries"]), PUBLIC_TOP_HOLDINGS_MAX_LIMIT)
        self.assertEqual(ok["entries"][0]["id"], "a19")
        # Same cache key as the public profile grid + summary: one shared compute.
        for call in calls:
            self.assertEqual(call["limit"], CLIENT_INVENTORY_PAGE_SIZE)
            self.assertEqual(call["offset"], 0)
            self.assertIs(call["include_series"], False)
            self.assertIs(call["compute_day_change"], False)
            self.assertIs(call["include_inactive"], False)
            self.assertIs(call["favorites_only"], False)

    def test_rejects_too_many_owners(self) -> None:
        self._fake_owner_reads({})
        owners = [f"{index:08d}-1111-4111-8111-111111111111" for index in range(PUBLIC_TOP_HOLDINGS_MAX_USERS + 1)]
        with self.assertRaises(ValueError):
            self.service.public_top_holdings_for_owners(owners)

    def test_real_read_is_owner_scoped_and_keeps_the_caller_identity(self) -> None:
        upsert_card(
            self.service.connection,
            card_id="base-charizard-4",
            name="Charizard",
            set_name="Base Set",
            number="4/102",
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="base-charizard-4",
            set_id="bs",
            set_ptcgo_code="BS",
            set_release_date="1999-01-09",
            source_payload={"id": "base-charizard-4"},
        )
        self.service.connection.commit()
        with self.service.request_identity_context(RequestIdentity(user_id=OWNER_A, auth_source="test")):
            self.service.record_buy(
                {
                    "cardID": "base-charizard-4",
                    "quantity": 1,
                    "unitPrice": 5.0,
                    "currencyCode": "USD",
                    "boughtAt": "2026-07-23T10:00:00Z",
                    "condition": "near_mint",
                }
            )

        caller = RequestIdentity(user_id=CALLER_USER_ID, auth_source="test")
        with self.service.request_identity_context(caller):
            payload = self.service.public_top_holdings_for_owners([OWNER_A, OWNER_B])
            self.assertEqual(self.service._current_owner_user_id(), CALLER_USER_ID)  # noqa: SLF001

        # No price snapshot was seeded, so nothing ranks — an unpriced card never shows.
        self.assertEqual(
            payload["profiles"],
            [
                {"userId": OWNER_A, "entries": [], "available": True},
                {"userId": OWNER_B, "entries": [], "available": True},
            ],
        )


class PublicTopHoldingsRouteTests(unittest.TestCase):
    @staticmethod
    def _handler(path: str) -> SpotlightRequestHandler:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.headers = {}
        handler.service = Mock()
        handler.service.request_identity_context.return_value = contextlib.nullcontext()
        handler.service.access_allowed.return_value = True
        return handler

    def _run(self, path: str) -> tuple[list[tuple[HTTPStatus, object]], Mock]:
        caller = RequestIdentity(user_id=CALLER_USER_ID, auth_source="test")
        handler = self._handler(path)
        handler._require_request_identity = lambda: caller  # type: ignore[method-assign]
        writes: list[tuple[HTTPStatus, object]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]
        handler.do_GET()
        return writes, handler.service

    def test_reads_every_owner_explicitly_under_the_callers_identity(self) -> None:
        writes, service = self._run(
            f"/api/v1/profiles/top-holdings?userIds={OWNER_A},{OWNER_B}&limit=4"
        )

        service.public_top_holdings_for_owners.assert_called_once_with([OWNER_A, OWNER_B], limit=4)
        context_identity = service.request_identity_context.call_args.args[0]
        self.assertEqual(context_identity.user_id, CALLER_USER_ID)
        self.assertEqual(writes, [(HTTPStatus.OK, service.public_top_holdings_for_owners.return_value)])

    def test_repeated_params_are_accepted(self) -> None:
        _, service = self._run(f"/api/v1/profiles/top-holdings?userIds={OWNER_A}&userIds={OWNER_B}")
        service.public_top_holdings_for_owners.assert_called_once_with([OWNER_A, OWNER_B], limit=6)

    def test_rejects_bad_input(self) -> None:
        too_many = ",".join(
            f"{index:08d}-1111-4111-8111-111111111111" for index in range(PUBLIC_TOP_HOLDINGS_MAX_USERS + 1)
        )
        for path in (
            "/api/v1/profiles/top-holdings",
            "/api/v1/profiles/top-holdings?userIds=",
            f"/api/v1/profiles/top-holdings?userIds={OWNER_A},not-a-uuid",
            f"/api/v1/profiles/top-holdings?userIds={OWNER_A},..%2Fetc",
            f"/api/v1/profiles/top-holdings?userIds={too_many}",
            f"/api/v1/profiles/top-holdings?userIds={OWNER_A}&limit=abc",
        ):
            with self.subTest(path=path):
                writes, service = self._run(path)
                self.assertEqual([status for status, _ in writes], [HTTPStatus.BAD_REQUEST])
                service.public_top_holdings_for_owners.assert_not_called()

    def test_requires_authentication(self) -> None:
        handler = self._handler(f"/api/v1/profiles/top-holdings?userIds={OWNER_A}")
        handler.service.authenticator.resolve_identity.side_effect = RequestAuthError(
            "Authenticated request identity is required."
        )
        writes: list[tuple[HTTPStatus, object]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]

        handler.do_GET()

        self.assertEqual([status for status, _ in writes], [HTTPStatus.UNAUTHORIZED])
        handler.service.public_top_holdings_for_owners.assert_not_called()


if __name__ == "__main__":
    unittest.main()
