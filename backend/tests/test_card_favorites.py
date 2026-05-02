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
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402


class CardFavoritesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "card-favorites.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _identity(self, user_id: str) -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(
        self,
        *,
        card_id: str,
        name: str,
        set_name: str = "Test Set",
        number: str = "1/1",
        set_code: str = "TST",
    ) -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name=set_name,
            number=number,
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            set_id=set_code.lower(),
            set_ptcgo_code=set_code,
            set_release_date="2026-04-30",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def _record_buy(self, *, user_id: str, card_id: str, bought_at: str) -> None:
        with self.service.request_identity_context(self._identity(user_id)):
            self.service.record_buy(
                {
                    "cardID": card_id,
                    "quantity": 1,
                    "unitPrice": 5.0,
                    "currencyCode": "USD",
                    "boughtAt": bought_at,
                    "condition": "near_mint",
                }
            )

    def test_set_card_favorite_updates_card_detail_and_inventory_entries(self) -> None:
        self._insert_card(card_id="base-pikachu-58", name="Pikachu", set_name="Base Set", number="58/102", set_code="BS")
        self._insert_card(card_id="base-charmander-46", name="Charmander", set_name="Base Set", number="46/102", set_code="BS")
        self._record_buy(user_id="user-a", card_id="base-pikachu-58", bought_at="2026-04-30T10:00:00Z")
        self._record_buy(user_id="user-a", card_id="base-charmander-46", bought_at="2026-04-30T10:05:00Z")

        with self.service.request_identity_context(self._identity("user-a")):
            favorite_payload = self.service.set_card_favorite("base-pikachu-58", is_favorite=True)
            detail = self.service.card_detail("base-pikachu-58")
            entries = self.service.deck_entries(limit=10, include_inactive=True)
            toggled_payload = self.service.set_card_favorite("base-pikachu-58")
            detail_after_toggle = self.service.card_detail("base-pikachu-58")

        self.assertEqual(favorite_payload["cardID"], "base-pikachu-58")
        self.assertEqual(favorite_payload["isFavorite"], True)
        self.assertIsNotNone(favorite_payload["favoritedAt"])
        assert detail is not None
        self.assertEqual(detail["isFavorite"], True)
        self.assertEqual(detail["card"]["isFavorite"], True)
        entries_by_card_id = {
            entry["card"]["id"]: entry
            for entry in entries["entries"]
        }
        self.assertEqual(entries_by_card_id["base-pikachu-58"]["isFavorite"], True)
        self.assertEqual(entries_by_card_id["base-charmander-46"]["isFavorite"], False)
        self.assertEqual(toggled_payload["isFavorite"], False)
        self.assertIsNone(toggled_payload["favoritedAt"])
        assert detail_after_toggle is not None
        self.assertEqual(detail_after_toggle["isFavorite"], False)
        self.assertEqual(detail_after_toggle["card"]["isFavorite"], False)

    def test_deck_entries_favorites_only_filter_returns_only_favorited_cards(self) -> None:
        self._insert_card(card_id="base-pikachu-58", name="Pikachu", set_name="Base Set", number="58/102", set_code="BS")
        self._insert_card(card_id="gym1-60", name="Sabrina's Slowbro", set_name="Gym Heroes", number="60/132", set_code="GYM1")
        self._record_buy(user_id="user-a", card_id="base-pikachu-58", bought_at="2026-04-30T11:00:00Z")
        self._record_buy(user_id="user-a", card_id="gym1-60", bought_at="2026-04-30T11:05:00Z")

        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_favorite("gym1-60", is_favorite=True)
            payload = self.service.deck_entries(limit=10, include_inactive=True, favorites_only=True)

        self.assertEqual(payload["summary"]["count"], 1)
        self.assertEqual([entry["card"]["id"] for entry in payload["entries"]], ["gym1-60"])
        self.assertEqual(payload["entries"][0]["isFavorite"], True)

    def test_card_favorites_are_scoped_per_user(self) -> None:
        self._insert_card(card_id="base-pikachu-58", name="Pikachu", set_name="Base Set", number="58/102", set_code="BS")
        self._record_buy(user_id="user-a", card_id="base-pikachu-58", bought_at="2026-04-30T12:00:00Z")
        self._record_buy(user_id="user-b", card_id="base-pikachu-58", bought_at="2026-04-30T12:05:00Z")

        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_favorite("base-pikachu-58", is_favorite=True)
            user_a_detail = self.service.card_detail("base-pikachu-58")
            user_a_entries = self.service.deck_entries(limit=10, include_inactive=True)

        with self.service.request_identity_context(self._identity("user-b")):
            user_b_detail = self.service.card_detail("base-pikachu-58")
            user_b_entries = self.service.deck_entries(limit=10, include_inactive=True)

        assert user_a_detail is not None
        assert user_b_detail is not None
        self.assertEqual(user_a_detail["isFavorite"], True)
        self.assertEqual(user_b_detail["isFavorite"], False)
        self.assertEqual(user_a_entries["entries"][0]["isFavorite"], True)
        self.assertEqual(user_b_entries["entries"][0]["isFavorite"], False)

    def test_card_favorite_post_route_runs_inside_authenticated_request_context(self) -> None:
        identity = RequestIdentity(user_id="favorite-user", auth_source="test")
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/cards/base-pikachu-58/favorite"
        handler.service = Mock()
        handler.service.request_identity_context.return_value = contextlib.nullcontext()
        handler.service.set_card_favorite.return_value = {
            "cardID": "base-pikachu-58",
            "isFavorite": True,
            "favoritedAt": "2026-04-30T12:30:00Z",
        }
        handler._read_json_body = lambda: {"isFavorite": True}  # type: ignore[method-assign]
        handler._require_request_identity = lambda: identity  # type: ignore[method-assign]
        writes: list[tuple[HTTPStatus, dict[str, object]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]

        handler.do_POST()

        handler.service.request_identity_context.assert_called_once_with(identity)
        handler.service.set_card_favorite.assert_called_once_with("base-pikachu-58", is_favorite=True)
        self.assertEqual(writes, [(HTTPStatus.OK, handler.service.set_card_favorite.return_value)])

    def test_deck_entries_get_route_passes_favorites_filter(self) -> None:
        identity = RequestIdentity(user_id="favorite-user", auth_source="test")
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/deck/entries?favorites=1&includeInactive=1&limit=25&offset=10"
        handler.service = Mock()
        handler.service.request_identity_context.return_value = contextlib.nullcontext()
        handler.service.deck_entries.return_value = {"entries": [], "summary": {"count": 0}}
        handler._require_request_identity = lambda: identity  # type: ignore[method-assign]
        handler._write_json = Mock()  # type: ignore[method-assign]

        handler.do_GET()

        handler.service.request_identity_context.assert_called_once_with(identity)
        handler.service.deck_entries.assert_called_once_with(
            limit=25,
            offset=10,
            include_inactive=True,
            favorites_only=True,
        )

    def test_card_detail_get_route_uses_authenticated_identity_when_present(self) -> None:
        identity = RequestIdentity(user_id="favorite-user", auth_source="test")
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/cards/base-pikachu-58"
        handler.headers = {"Authorization": "Bearer token"}
        handler.service = Mock()
        handler.service.authenticator = Mock(auth_required=True)
        handler.service.request_identity_context.return_value = contextlib.nullcontext()
        handler.service.card_detail.return_value = {
            "card": {
                "id": "base-pikachu-58",
            }
        }
        handler._require_request_identity = lambda: identity  # type: ignore[method-assign]
        handler._write_json = Mock()  # type: ignore[method-assign]

        handler.do_GET()

        handler.service.request_identity_context.assert_called_once_with(identity)
        handler.service.card_detail.assert_called_once_with(
            "base-pikachu-58",
            grader=None,
            grade=None,
            cert_number=None,
            preferred_variant=None,
        )


if __name__ == "__main__":
    unittest.main()
