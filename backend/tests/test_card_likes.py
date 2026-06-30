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


class CardLikesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "card-likes.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _identity(self, user_id: str) -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(self, *, card_id: str, name: str) -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name="Base Set",
            number="58/102",
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            set_id="bs",
            set_ptcgo_code="BS",
            set_release_date="2026-04-30",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def test_set_card_like_toggles_and_reflects_in_card_detail(self) -> None:
        self._insert_card(card_id="base-pikachu-58", name="Pikachu")
        with self.service.request_identity_context(self._identity("user-a")):
            liked = self.service.set_card_like("base-pikachu-58", is_liked=True)
            detail = self.service.card_detail("base-pikachu-58")
            toggled = self.service.set_card_like("base-pikachu-58")
            detail_after = self.service.card_detail("base-pikachu-58")

        self.assertEqual(liked["cardID"], "base-pikachu-58")
        self.assertTrue(liked["isLiked"])
        self.assertIsNotNone(liked["likedAt"])
        assert detail is not None
        self.assertTrue(detail["isLiked"])
        self.assertEqual(detail["likeCount"], 1)
        self.assertFalse(toggled["isLiked"])
        self.assertIsNone(toggled["likedAt"])
        assert detail_after is not None
        self.assertFalse(detail_after["isLiked"])
        self.assertEqual(detail_after["likeCount"], 0)

    def test_liking_does_not_wishlist_and_count_is_distinct(self) -> None:
        # The crux of the like/wishlist split: a like must NOT create a wishlist
        # (card_favorites) row, and likeCount counts likes — not wishlisters.
        self._insert_card(card_id="base-pikachu-58", name="Pikachu")
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_like("base-pikachu-58", is_liked=True)
            detail = self.service.card_detail("base-pikachu-58")

        assert detail is not None
        self.assertTrue(detail["isLiked"])
        self.assertFalse(detail["isFavorite"])  # wishlist untouched
        self.assertEqual(detail["likeCount"], 1)

        # And a wishlist (favorite) without a like → likeCount stays 0.
        with self.service.request_identity_context(self._identity("user-b")):
            self.service.set_card_favorite("base-pikachu-58", is_favorite=True)
            detail_b = self.service.card_detail("base-pikachu-58")
        assert detail_b is not None
        self.assertTrue(detail_b["isFavorite"])
        self.assertFalse(detail_b["isLiked"])
        self.assertEqual(detail_b["likeCount"], 1)  # only user-a's like counts

    def test_likes_are_scoped_per_user(self) -> None:
        self._insert_card(card_id="base-pikachu-58", name="Pikachu")
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_like("base-pikachu-58", is_liked=True)
            a_detail = self.service.card_detail("base-pikachu-58")
        with self.service.request_identity_context(self._identity("user-b")):
            b_detail = self.service.card_detail("base-pikachu-58")
        assert a_detail is not None and b_detail is not None
        self.assertTrue(a_detail["isLiked"])
        self.assertFalse(b_detail["isLiked"])
        self.assertEqual(b_detail["likeCount"], 1)  # public count is shared

    def test_card_like_post_route_runs_inside_authenticated_request_context(self) -> None:
        identity = RequestIdentity(user_id="like-user", auth_source="test")
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/cards/base-pikachu-58/like"
        handler.service = Mock()
        handler.service.request_identity_context.return_value = contextlib.nullcontext()
        handler.service.set_card_like.return_value = {
            "cardID": "base-pikachu-58",
            "isLiked": True,
            "likedAt": "2026-04-30T12:30:00Z",
        }
        handler._read_json_body = lambda: {"isLiked": True}  # type: ignore[method-assign]
        handler._require_request_identity = lambda: identity  # type: ignore[method-assign]
        writes: list[tuple[HTTPStatus, dict[str, object]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]

        handler.do_POST()

        handler.service.request_identity_context.assert_called_once_with(identity)
        handler.service.set_card_like.assert_called_once_with("base-pikachu-58", is_liked=True)
        self.assertEqual(writes, [(HTTPStatus.OK, handler.service.set_card_like.return_value)])


if __name__ == "__main__":
    unittest.main()
