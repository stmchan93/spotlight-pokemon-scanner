from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class CardSocialCountsTests(unittest.TestCase):
    """likeCount (public wishlist count) and watcherCount (recent viewers) on
    the card-detail payload."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "card-social.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self._insert_card(card_id="base-pikachu-58", name="Pikachu")

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

    def _detail(self, user_id: str) -> dict:
        with self.service.request_identity_context(self._identity(user_id)):
            detail = self.service.card_detail("base-pikachu-58")
        assert detail is not None
        return detail

    def test_like_count_reflects_number_of_favoriting_users(self) -> None:
        # No favorites yet — opening the detail reports zero likes.
        self.assertEqual(self._detail("user-a")["likeCount"], 0)

        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_favorite("base-pikachu-58", is_favorite=True)
        with self.service.request_identity_context(self._identity("user-b")):
            self.service.set_card_favorite("base-pikachu-58", is_favorite=True)
        self.assertEqual(self._detail("user-a")["likeCount"], 2)

        # Un-favoriting drops the count back down.
        with self.service.request_identity_context(self._identity("user-b")):
            self.service.set_card_favorite("base-pikachu-58", is_favorite=False)
        self.assertEqual(self._detail("user-a")["likeCount"], 1)

    def test_watcher_count_dedupes_per_user_per_day(self) -> None:
        # First viewer (self) is counted once...
        self.assertEqual(self._detail("user-a")["watcherCount"], 1)
        # ...and reopening the same day does not double-count.
        self.assertEqual(self._detail("user-a")["watcherCount"], 1)
        # A distinct viewer increments the count.
        self.assertEqual(self._detail("user-b")["watcherCount"], 2)

    def test_watcher_count_excludes_views_outside_window(self) -> None:
        # Seed an old view directly (8 days ago) — outside the 7-day window.
        old = "2000-01-01T00:00:00+00:00"
        self.service.connection.execute(
            """
            INSERT INTO card_views (owner_user_id, card_id, viewed_on, viewed_at)
            VALUES (?, ?, ?, ?)
            """,
            ("user-stale", "base-pikachu-58", old[:10], old),
        )
        self.service.connection.commit()

        # A fresh view by user-a is the only one inside the window.
        self.assertEqual(self._detail("user-a")["watcherCount"], 1)

    def test_account_deletion_clears_card_views(self) -> None:
        self._detail("user-a")
        row = self.service.connection.execute(
            "SELECT COUNT(*) FROM card_views WHERE owner_user_id = ?",
            ("user-a",),
        ).fetchone()
        self.assertEqual(int(row[0]), 1)

        with self.service.request_identity_context(self._identity("user-a")):
            self.service.delete_account({})

        row = self.service.connection.execute(
            "SELECT COUNT(*) FROM card_views WHERE owner_user_id = ?",
            ("user-a",),
        ).fetchone()
        self.assertEqual(int(row[0]), 0)


if __name__ == "__main__":
    unittest.main()
