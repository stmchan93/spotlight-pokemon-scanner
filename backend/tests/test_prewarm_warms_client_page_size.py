"""The prewarm must warm the key the CLIENT asks for.

`limit` is part of the deck-entries cache key. The prewarm warmed `limit=200`
while the app requests `limit=1000` (`inventoryPageSize`), so it was warming a
key nobody ever requested: every first Collection load after a deploy — or after
the daily price sync moves every owner's version token — paid a full cold
compute anyway, ~20s, while the prewarm's own log reported "warmed 5 of 5"
(user, 2026-09-11).

A mismatch here is invisible in every signal we have, which is why it is pinned
rather than left to the constant's comment.
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

from catalog_tools import apply_schema, connect, upsert_card, upsert_deck_entry  # noqa: E402
from server import CLIENT_INVENTORY_PAGE_SIZE, SpotlightScanService  # noqa: E402

OWNER = "owner-prewarm"


class PrewarmPageSizeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "prewarm.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            connection,
            card_id="c1",
            name="Pikachu",
            set_name="Base Set",
            number="58/102",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="c1",
        )
        upsert_deck_entry(
            connection,
            card_id="c1",
            quantity=1,
            owner_user_id=OWNER,
            added_at="2026-01-01T00:00:00Z",
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

    def test_the_client_page_size_is_what_the_api_client_sends(self) -> None:
        # The api-client's `inventoryPageSize`. If that changes, this fails and
        # the prewarm is updated with it rather than silently going stale.
        page_size = (REPO_ROOT / "packages/api-client/src/spotlight/repository.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn(f"const inventoryPageSize = {CLIENT_INVENTORY_PAGE_SIZE};", page_size)

    def test_prewarm_requests_that_page_size(self) -> None:
        seen: list[int] = []
        original = self.service.deck_entries

        def record(*args, **kwargs):
            if "limit" in kwargs:
                seen.append(int(kwargs["limit"]))
            return original(*args, **kwargs)

        self.service.deck_entries = record  # type: ignore[method-assign]
        self.service.prewarm_portfolio_dashboards(source="test")

        # The standalone Collection read — `deck/entries?limit=1000` — is the one
        # that was never warmed. (The dashboard payload's own embedded inventory
        # section still asks for 200; that is a different consumer with a
        # different cache key, and it is warmed by the dashboard call.)
        self.assertIn(CLIENT_INVENTORY_PAGE_SIZE, seen)


if __name__ == "__main__":
    unittest.main()
