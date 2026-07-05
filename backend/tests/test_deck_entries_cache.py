"""Guard for the deck_entries version-token cache (added after the 2026-07-05
load test: uncached, every Collection view re-ran ~1s of per-card pricing and
~30 concurrent browsers saturated the heavy-read slots). Pins that repeat calls
serve the cached payload, and that every input class invalidates it: deck
mutations (covered broadly by test_scan_logging_phase7) and — the token
component unique to this cache — the owner's wishlist (card_favorites).
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    upsert_card,
    upsert_deck_entry,
)
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

CARD_ID = "cachecard"
USER = "user-cache"


class DeckEntriesCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "entries-cache.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        upsert_card(
            connection,
            card_id=CARD_ID,
            name="Snorlax",
            set_name="Jungle",
            number="11/64",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=CARD_ID,
        )
        upsert_deck_entry(
            connection,
            card_id=CARD_ID,
            variant_name="Holofoil",
            condition="NM",
            quantity=1,
            owner_user_id=USER,
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

    def _identity(self) -> RequestIdentity:
        return RequestIdentity(user_id=USER, auth_source="test")

    def test_repeat_call_is_a_cache_hit(self) -> None:
        with self.service.request_identity_context(self._identity()):
            first = self.service.deck_entries(limit=200)
            self.assertEqual(len(self.service._deck_entries_cache), 1)
            second = self.service.deck_entries(limit=200)
        # Same cached object served (identity, not just equality).
        self.assertIs(first, second)

    def test_favorite_add_invalidates(self) -> None:
        with self.service.request_identity_context(self._identity()):
            first = self.service.deck_entries(limit=200)
            self.service.connection.execute(
                "INSERT INTO card_favorites (owner_user_id, card_id, created_at) VALUES (?, ?, ?)",
                (USER, CARD_ID, datetime.now(timezone.utc).isoformat()),
            )
            self.service.connection.commit()
            second = self.service.deck_entries(limit=200)
        self.assertIsNot(first, second)

    def test_favorite_remove_invalidates(self) -> None:
        with self.service.request_identity_context(self._identity()):
            self.service.connection.execute(
                "INSERT INTO card_favorites (owner_user_id, card_id, created_at) VALUES (?, ?, ?)",
                (USER, CARD_ID, datetime.now(timezone.utc).isoformat()),
            )
            self.service.connection.commit()
            first = self.service.deck_entries(limit=200)
            self.service.connection.execute(
                "DELETE FROM card_favorites WHERE owner_user_id = ? AND card_id = ?",
                (USER, CARD_ID),
            )
            self.service.connection.commit()
            second = self.service.deck_entries(limit=200)
        # COUNT(*) drops even though MAX(created_at) may not change.
        self.assertIsNot(first, second)

    def test_distinct_params_get_distinct_cache_slots(self) -> None:
        with self.service.request_identity_context(self._identity()):
            self.service.deck_entries(limit=200)
            self.service.deck_entries(limit=50)
            self.service.deck_entries(limit=200, include_inactive=True)
        self.assertEqual(len(self.service._deck_entries_cache), 3)


if __name__ == "__main__":
    unittest.main()
