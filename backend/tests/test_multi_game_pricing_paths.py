"""Scrydex requests go to the card's own game, and games with no data spend nothing.

Every one of these paths had the same shape of bug: the card row has always
carried `game`, the handler loaded that row, and then dropped the field before
building a Scrydex path — so a One Piece or Lorcana id was asked for down
`/pokemon/v1/...`. That request cannot succeed and still bills a credit, which
makes it worse than an error: it is a silent recurring cost that returns
"no data" and looks like the game simply having none.

The capability gate is the other half. `has_listings` is a measured fact per
game, and consulting it is what stops us paying to confirm a zero we already
measured.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import scrydex_adapter  # noqa: E402
from catalog_tools import (  # noqa: E402
    GAME_LORCANA,
    GAME_ONE_PIECE,
    GAME_POKEMON,
    apply_schema,
    connect,
    game_has_listings,
    upsert_card,
)
from server import SpotlightScanService  # noqa: E402


class ScrydexPathIsPerGameTests(unittest.TestCase):
    """The request path is built from the descriptor, never a literal."""

    def _captured_path(self, **kwargs) -> str:
        seen: dict[str, str] = {}

        def fake_request(path: str, **_kwargs):
            seen["path"] = path
            return {"data": []}

        with patch.object(scrydex_adapter, "scrydex_api_request", fake_request):
            scrydex_adapter.fetch_scrydex_price_history("CARD-1", **kwargs)
        return seen["path"]

    def test_price_history_defaults_to_the_pokemon_path_for_existing_callers(self) -> None:
        # The compatibility guarantee: omitting `game` must produce the byte-
        # identical path this function has always used.
        self.assertEqual(
            self._captured_path(), "/pokemon/v1/cards/CARD-1/price_history"
        )
        self.assertEqual(
            self._captured_path(game=GAME_POKEMON), "/pokemon/v1/cards/CARD-1/price_history"
        )

    def test_price_history_follows_the_cards_game(self) -> None:
        self.assertEqual(
            self._captured_path(game=GAME_ONE_PIECE), "/onepiece/v1/cards/CARD-1/price_history"
        )
        self.assertEqual(
            self._captured_path(game=GAME_LORCANA), "/lorcana/v1/cards/CARD-1/price_history"
        )

    def test_recent_sales_reports_the_path_it_actually_requested(self) -> None:
        # `sourceURL` is stored as the row's provenance. Echoing /pokemon while
        # calling /lorcana mislabels where the data came from, which is the kind
        # of wrong that only surfaces months later during an audit.
        seen: dict[str, str] = {}

        def fake_request(path: str, **_kwargs):
            seen["path"] = path
            return {"data": []}

        with patch.object(scrydex_adapter, "scrydex_api_request", fake_request):
            payload = scrydex_adapter.fetch_scrydex_recent_sales("CARD-1", game=GAME_LORCANA)

        self.assertEqual(seen["path"], "/lorcana/v1/cards/CARD-1/listings")
        self.assertIn("/lorcana/v1/cards/CARD-1/listings", str(payload["sourceURL"]))
        self.assertNotIn("/pokemon/", str(payload["sourceURL"]))


class RecentSalesCapabilityGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "recent-sales.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

        for card_id, game in (("base1-4", GAME_POKEMON), ("OP01-001", GAME_ONE_PIECE)):
            upsert_card(
                self.service.connection,
                card_id=card_id,
                game=game,
                name="Test Card",
                set_name="Test Set",
                number="1/1",
                rarity="Rare",
                variant="Raw",
                language="English",
                source_provider="scrydex",
                source_record_id=card_id,
                set_id="tst",
                set_ptcgo_code="TST",
                set_release_date="2026-01-01",
            )
        self.service.connection.commit()

    def test_a_game_with_no_listings_source_spends_no_credit(self) -> None:
        # The point of the registry flag: we already measured that One Piece
        # returns zero rows, so paying to re-confirm it on every PDP open is
        # pure waste.
        self.assertFalse(game_has_listings(GAME_ONE_PIECE))

        def explode(*args, **kwargs):
            raise AssertionError("a game with no listings source must not be fetched")

        # refresh=True is the ONLY path that reaches Scrydex — without it the
        # handler returns the cache and the test would pass for the wrong reason.
        with patch("server.fetch_scrydex_recent_sales", explode):
            payload = self.service.card_recent_sales(
                "OP01-001", grader="PSA", grade="10", refresh=True
            )

        # NOT None: None becomes a 404 "Card not found", and the card plainly
        # exists. "unavailable" is the shape the client already renders as a
        # quiet empty drawer.
        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["sales"], [])
        self.assertIn("One Piece", str(payload["unavailableReason"]))

    def test_a_missing_card_is_still_a_404_not_an_empty_drawer(self) -> None:
        self.assertIsNone(self.service.card_recent_sales("does-not-exist"))

    def test_pokemon_still_fetches_and_is_told_its_game(self) -> None:
        captured: dict[str, object] = {}

        def fake_fetch(card_id, **kwargs):
            captured.update(kwargs)
            captured["cardID"] = card_id
            return {"sales": [], "sourceURL": None, "sourcePayload": {}}

        with patch("server.fetch_scrydex_recent_sales", fake_fetch):
            payload = self.service.card_recent_sales(
                "base1-4", grader="PSA", grade="10", refresh=True
            )

        self.assertIsNotNone(payload)
        self.assertEqual(captured["cardID"], "base1-4")
        # Explicitly passed rather than left to the adapter's default, so the
        # call site says which catalog it means.
        self.assertEqual(captured["game"], GAME_POKEMON)


if __name__ == "__main__":
    unittest.main()
