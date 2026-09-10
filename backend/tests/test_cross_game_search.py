"""`?game=all`: the catalog search's cross-game mode.

The scoping this opts out of was itself a fix — before it, a One Piece lane
searched the POKÉMON catalog and came back empty. The fix then became the bug:
typed queries inherited the SCANNER's lane, so searching "Darkrai" with the lane
on One Piece returned "No matching cards", and nothing on screen said a filter
was applied at all.

So both directions have to hold at once, and that is what this file pins: an
absent `game` still means Pokémon (no old client can fall into a cross-game
search by saying nothing), a named game still scopes, and only the literal
`all` searches everything.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from backend.tests.test_multi_game_catalog_scoping import _CatalogTestCase, _insert  # noqa: E402
from catalog_tools import GAME_LORCANA, GAME_ONE_PIECE, GAME_POKEMON  # noqa: E402


class CrossGameSearchTests(_CatalogTestCase):
    def setUp(self) -> None:
        super().setUp()
        # One name in three catalogs, so every assertion below is about scoping
        # rather than about which catalog happens to hold the word.
        _insert(self.connection, card_id="pkmn-ace", game=GAME_POKEMON, name="Ace",
                set_name="Base", set_id="base1", number="4/102")
        _insert(self.connection, card_id="OP01-001", game=GAME_ONE_PIECE, name="Ace",
                set_name="Romance Dawn", set_id="OP01", number="4/102")
        _insert(self.connection, card_id="lorcana-ace", game=GAME_LORCANA, name="Ace",
                set_name="Attack of the Vine!", set_id="AOTV", number="4/102")
        self.connection.commit()

    def _all_game_ids(self, query: str, *, limit: int = 20, offset: int = 0) -> list[str]:
        """Ids from the all-games merge.

        Straight at `_search_every_game` rather than through `search`, which
        decorates every row with finishes and pricing — machinery this fixture
        has no reason to stand up, and none of it is what scoping is about.
        """
        import threading

        from server import SpotlightScanService

        service = SpotlightScanService.__new__(SpotlightScanService)
        # `connection` is a lazy per-thread property; hand it this fixture's
        # open connection rather than letting it open a second one on the file.
        service._thread_local = threading.local()
        service._thread_local.connection = self.connection
        rows, _ = SpotlightScanService._search_every_game(
            service, query, limit=limit, offset=offset, rarity_bucket_filter=None,
        )
        return [str(row["id"]) for row in rows]

    def test_all_games_returns_every_catalogs_match(self) -> None:
        self.assertEqual(
            sorted(self._all_game_ids("Ace")),
            ["OP01-001", "lorcana-ace", "pkmn-ace"],
        )

    def test_each_game_gets_a_slot_on_the_first_screen(self) -> None:
        """Round-robin, not concatenation.

        Give Pokémon three matches and One Piece one; a concatenating merge puts
        the One Piece card fourth, behind two weaker Pokémon rows. That ordering
        is the bug in miniature — the card someone typed the name of should not
        rank below every same-named card from the game they are not in.
        """
        _insert(self.connection, card_id="pkmn-ace-2", game=GAME_POKEMON, name="Ace Trainer",
                set_name="Base", set_id="base1", number="5/102")
        _insert(self.connection, card_id="pkmn-ace-3", game=GAME_POKEMON, name="Ace Spec",
                set_name="Base", set_id="base1", number="6/102")
        self.connection.commit()

        top_two = self._all_game_ids("Ace")[:2]
        self.assertIn("OP01-001", top_two)

    def test_paging_never_repeats_or_skips_a_row(self) -> None:
        first = self._all_game_ids("Ace", limit=2, offset=0)
        second = self._all_game_ids("Ace", limit=2, offset=2)
        self.assertEqual(len(first), 2)
        self.assertEqual(len(second), 1)
        self.assertEqual(sorted(first + second), ["OP01-001", "lorcana-ace", "pkmn-ace"])


class BoundaryTests(_CatalogTestCase):
    """Only the literal `all` opts in — the HTTP layer owns that decision."""

    def test_absent_game_is_still_pokemon_and_all_is_the_only_opt_in(self) -> None:
        from catalog_tools import normalize_game

        def resolve(raw: str) -> str | None:
            # The one line from the `/cards/search` handler this file exists to
            # pin; kept in step with it by name, not by import, because the
            # handler is a 40-line request block.
            cleaned = raw.strip().lower()
            return None if cleaned == "all" else normalize_game(cleaned)

        self.assertIsNone(resolve("all"))
        self.assertIsNone(resolve("  ALL  "))
        self.assertEqual(resolve(""), GAME_POKEMON)
        self.assertEqual(resolve("onepiece"), GAME_ONE_PIECE)
        # Junk still lands on Pokémon rather than opening the catalog up.
        self.assertEqual(resolve("everything"), GAME_POKEMON)
        self.assertEqual(resolve("*"), GAME_POKEMON)


if __name__ == "__main__":
    unittest.main()
