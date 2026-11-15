"""The per-card lookup cache must stay bounded. Unbounded, it kept every card
ever viewed (each with ~36KB of source JSON) and helped grow prod to 13GB,
which hung the backend on 2026-11-15.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402


class CardLookupCacheBoundTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "card-cache.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        for index in range(12):
            upsert_card(
                connection,
                card_id=f"card-{index}",
                name=f"Card {index}",
                set_name="Jungle",
                number=f"{index}/64",
                rarity="Common",
                variant="Raw",
                language="English",
                source_provider="scrydex",
                source_record_id=f"card-{index}",
            )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self.service._card_lookup_cache_max_entries = 5

    def test_single_lookups_stay_under_cap_and_still_resolve(self) -> None:
        for index in range(12):
            card = self.service._cached_card_by_id(f"card-{index}")
            self.assertEqual(card["id"], f"card-{index}")
        self.assertLessEqual(len(self.service._card_lookup_cache), 5)
        # Evicted cards are refetched, not lost.
        self.assertEqual(self.service._cached_card_by_id("card-0")["id"], "card-0")

    def test_bulk_prime_stays_under_cap(self) -> None:
        self.service._prime_card_lookup_cache([f"card-{index}" for index in range(12)])
        self.assertLessEqual(len(self.service._card_lookup_cache), 5)
        self.assertIn("card-11", self.service._card_lookup_cache)


if __name__ == "__main__":
    unittest.main()
