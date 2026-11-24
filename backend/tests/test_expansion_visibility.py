"""Filler sets are hidden from the sets list only (expansion_visibility.py):
their set page, card search and other games are unaffected."""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    GAME_ONE_PIECE,
    GAME_POKEMON,
    apply_schema,
    connect,
    reset_collision_guard_cache,
    upsert_card,
    upsert_expansion,
)
from expansion_visibility import filter_browse_expansions, hidden_reason  # noqa: E402
import server  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

TODAY = date(2026, 11, 23)


def _row(set_id: str, name: str, release: str = "2020/01/01") -> dict:
    return {"id": set_id, "name": name, "releaseDate": release}


class HiddenReasonTests(unittest.TestCase):
    def _reason(self, row: dict, card_count: int = 0, game: str = GAME_POKEMON) -> str | None:
        return hidden_reason(row, game=game, card_count=card_count, today=TODAY)

    def test_filler_scrydex_sets_hidden(self) -> None:
        for row in (
            _row("mee", "Mega Evolution Energies"),
            _row("sve", "Scarlet & Violet Energies"),
            _row("tk10a", "SM Trainer Kit Lycanroc"),
            _row("mbg_ja", "スターターセットMEGA メガゲンガーex"),
            _row("mp1_ja", "スタートデッキ100 バトルコレクション"),
            _row("wcs23_ja", "ポケモンワールドチャンピオンシップス2023横浜 記念デッキ「ピカチュウ」"),
        ):
            self.assertEqual(self._reason(row), "filler_name", row["name"])

    def test_real_sets_promos_and_specials_kept(self) -> None:
        for row in (
            _row("me1", "Mega Evolution"),
            _row("mep", "Mega Evolution Black Star Promos"),
            _row("sv3pt5", "151"),
            _row("swsh12pt5", "Crown Zenith"),
            _row("cel25", "Celebrations"),
            _row("mcd26", "McDonald's Collection 2026"),
            _row("xy0", "Kalos Starter Set"),  # explicit keep
            _row("swsh9tg", "Brilliant Stars Trainer Gallery"),
            _row("m2a_ja", "MEGAドリームex"),
            _row("sv2a_ja", "ポケモンカード151"),
            _row("pcg10_ja", "ワールドチャンピオンズパック"),
        ):
            self.assertIsNone(self._reason(row), row["name"])

    def test_unpaired_group_hidden_by_default(self) -> None:
        self.assertEqual(self._reason(_row("tcgplayer-group-2686", "Battle Academy")), "filler_name")
        self.assertEqual(
            self._reason(_row("tcgplayer-group-24154", "PokePark Forest", "2005/03/18"), card_count=80),
            "unpaired_tcgplayer_group",
        )
        # Allow-listed promo line.
        self.assertIsNone(self._reason(_row("tcgplayer-group-1539", "League & Championship Cards")))

    def test_new_main_set_group_kept_until_scrydex_adds_it(self) -> None:
        recent = _row("tcgplayer-group-30000", "ME07: Some New Set", "2026/11/06")
        self.assertIsNone(self._reason(recent, card_count=120))
        # Too few cards, too old, or a filler name: hidden.
        self.assertEqual(self._reason(recent, card_count=12), "unpaired_tcgplayer_group")
        old = _row("tcgplayer-group-30000", "ME07: Some New Set", "2026/05/01")
        self.assertEqual(self._reason(old, card_count=120), "unpaired_tcgplayer_group")
        deck = _row("tcgplayer-group-30001", "ME: Start Deck 100", "2026/11/06")
        self.assertEqual(self._reason(deck, card_count=120), "filler_name")

    def test_other_games_untouched(self) -> None:
        for row in (
            _row("onepiece~ST01", "Starter Deck 1: Straw Hat Crew"),
            _row("onepiece~tcgplayer-group-1", "Some Group"),
        ):
            self.assertIsNone(self._reason(row, game=GAME_ONE_PIECE))

    def test_filter_keeps_order_and_marks_hidden_on_request(self) -> None:
        rows = [_row("me1", "Mega Evolution"), _row("mee", "Mega Evolution Energies"), _row("mep", "Mega Evolution Black Star Promos")]
        self.assertEqual([r["id"] for r in filter_browse_expansions(rows, game=GAME_POKEMON, today=TODAY)], ["me1", "mep"])
        full = filter_browse_expansions(rows, game=GAME_POKEMON, include_hidden=True, today=TODAY)
        self.assertEqual([(r["id"], r.get("hidden")) for r in full], [("me1", None), ("mee", True), ("mep", None)])


class ExpansionVisibilityServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "expansion-visibility.sqlite"
        self.connection = connect(self.database_path)
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        reset_collision_guard_cache()
        self.addCleanup(reset_collision_guard_cache)
        patcher = mock.patch.object(server, "sync_scrydex_expansions", side_effect=AssertionError("network"))
        patcher.start()
        self.addCleanup(patcher.stop)

        recent = (date.today() - timedelta(days=10)).strftime("%Y/%m/%d")
        for set_id, name, provider, release in (
            ("me1", "Mega Evolution", "scrydex", "2025/09/26"),
            ("mep", "Mega Evolution Black Star Promos", "scrydex", "2025/09/26"),
            ("mee", "Mega Evolution Energies", "scrydex", "2025/09/26"),
            ("tcgplayer-group-2686", "Battle Academy", "tcgplayer", "2020/07/31"),
            ("tcgplayer-group-30000", "ME07: Brand New Set", "tcgplayer", recent),
        ):
            upsert_expansion(
                self.connection, expansion_id=set_id, name=name, language="English",
                release_date=release, source_provider=provider, game=GAME_POKEMON,
            )
        self._card("me1-1", "Bulbasaur", "1", "me1", "scrydex")
        self._card("mep-1", "Pikachu", "001", "mep", "scrydex")
        self._card("mee-1", "Basic Grass Energy", "1", "mee", "scrydex")
        self._card("tcgplayer-900", "Zapdosonic Academy", "12", "tcgplayer-group-2686", "tcgplayer")
        for index in range(60):
            self._card(f"tcgplayer-{1000 + index}", f"New Card {index}", str(index + 1), "tcgplayer-group-30000", "tcgplayer")
        self.connection.commit()
        self.service = SpotlightScanService(self.database_path, BACKEND_ROOT.parent)
        self.addCleanup(self.service.connection.close)

    def _card(self, card_id: str, name: str, number: str, set_id: str, provider: str) -> None:
        upsert_card(
            self.connection, card_id=card_id, name=name, set_name=set_id, number=number, rarity="Common",
            variant="Normal", language="English", game=GAME_POKEMON, source_provider=provider,
            set_id=set_id, supertype="Pokémon",
        )

    def test_sets_list_hides_filler_only(self) -> None:
        ids = [row["id"] for row in self.service.list_expansions(GAME_POKEMON)["expansions"]]
        self.assertIn("me1", ids)
        self.assertIn("mep", ids)
        self.assertIn("tcgplayer-group-30000", ids)  # new main set, no Scrydex twin yet
        self.assertNotIn("mee", ids)
        self.assertNotIn("tcgplayer-group-2686", ids)

    def test_include_hidden_returns_marked_records(self) -> None:
        rows = {row["id"]: row for row in self.service.list_expansions(GAME_POKEMON, include_hidden=True)["expansions"]}
        self.assertTrue(rows["mee"]["hidden"])
        self.assertTrue(rows["tcgplayer-group-2686"]["hidden"])
        self.assertNotIn("hidden", rows["me1"])
        self.assertEqual(rows["tcgplayer-group-2686"]["cardCount"], 1)

    def test_hidden_set_page_still_loads(self) -> None:
        cards = self.service.search_expansion_cards("mee", game=GAME_POKEMON, limit=100)["results"]
        self.assertEqual([card["id"] for card in cards], ["mee-1"])
        cards = self.service.search_expansion_cards("tcgplayer-group-2686", game=GAME_POKEMON, limit=100)["results"]
        self.assertEqual([card["id"] for card in cards], ["tcgplayer-900"])

    def test_hidden_sets_cards_still_in_card_search(self) -> None:
        energy = [card["id"] for card in self.service.search("Basic Grass Energy", game=GAME_POKEMON)["results"]]
        self.assertIn("mee-1", energy)
        academy = [card["id"] for card in self.service.search("Zapdosonic", game=GAME_POKEMON)["results"]]
        self.assertIn("tcgplayer-900", academy)


if __name__ == "__main__":
    unittest.main()
