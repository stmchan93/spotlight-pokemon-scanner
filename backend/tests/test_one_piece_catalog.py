from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    GAME_ONE_PIECE,
    GAME_POKEMON,
    apply_schema,
    connect,
    normalize_game,
    rarity_bucket,
    scrydex_game_segment,
    upsert_card,
)
from scrydex_adapter import map_scrydex_onepiece_card  # noqa: E402

FIXTURE = BACKEND_ROOT / "tests" / "fixtures" / "scrydex_onepiece_cards_sample.json"


def load_fixture_cards() -> list[dict]:
    """Real `/onepiece/v1/expansions/OP16/cards?include=prices` response."""
    return json.loads(FIXTURE.read_text())["data"]


class GameRoutingTests(unittest.TestCase):
    def test_normalize_game_defaults_to_pokemon(self) -> None:
        """Every pre-multi-game caller passes nothing, and an unknown value must
        not silently create a third catalog partition nothing can search."""
        for value in (None, "", "   ", "pokemon", "POKEMON", "nonsense"):
            self.assertEqual(normalize_game(value), GAME_POKEMON, value)

    def test_normalize_game_accepts_the_spellings_a_caller_might_use(self) -> None:
        for value in ("onepiece", "one-piece", "one piece", "One Piece", "OP", "op"):
            self.assertEqual(normalize_game(value), GAME_ONE_PIECE, value)

    def test_scrydex_segment_per_game(self) -> None:
        self.assertEqual(scrydex_game_segment(None), "pokemon")
        self.assertEqual(scrydex_game_segment("onepiece"), "onepiece")


class OnePieceRarityBucketTests(unittest.TestCase):
    def test_one_piece_ladder_maps_onto_the_shared_bucket_keys(self) -> None:
        # Reusing Pokémon's keys is what lets the shipped rarity filter chips
        # work for a second game with no client change.
        cases = {
            "Common": "standard",
            "Uncommon": "standard",
            "Rare": "standard",
            "Leader": "standard",
            "Super Rare": "ultra",
            "Special Card": "ultra",
            "Secret Rare": "secret",
            "Treasure Rare": "secret",
            "Manga Rare": "illustration",
            "Promo": "promo",
        }
        for rarity, expected in cases.items():
            self.assertEqual(rarity_bucket(rarity, GAME_ONE_PIECE), expected, rarity)

    def test_decorated_labels_fall_through_to_the_substring_rules(self) -> None:
        self.assertEqual(rarity_bucket("Super Rare (Alt Art)", GAME_ONE_PIECE), "ultra")
        self.assertEqual(rarity_bucket("Manga Rare Parallel", GAME_ONE_PIECE), "illustration")

    def test_unknown_rarity_is_other_not_a_crash(self) -> None:
        for value in (None, "", "???"):
            self.assertEqual(rarity_bucket(value, GAME_ONE_PIECE), "other")

    def test_pokemon_bucketing_is_untouched(self) -> None:
        self.assertEqual(rarity_bucket("Special Illustration Rare"), "sir")
        self.assertEqual(rarity_bucket("Promo"), "promo")
        # And a One Piece label must NOT be bucketed by the Pokémon map.
        self.assertEqual(rarity_bucket("Leader", GAME_ONE_PIECE), "standard")


class OnePieceCardMappingTests(unittest.TestCase):
    """Runs against a REAL captured Scrydex response, not a hand-written stub —
    a fake would have happily agreed with whatever the mapper did."""

    def setUp(self) -> None:
        self.cards = load_fixture_cards()

    def test_maps_the_fields_the_catalog_row_needs(self) -> None:
        leader = map_scrydex_onepiece_card(self.cards[0])
        self.assertEqual(leader["id"], "OP16-001")
        self.assertEqual(leader["game"], GAME_ONE_PIECE)
        self.assertEqual(leader["name"], "Portgas.D.Ace")
        self.assertEqual(leader["set_name"], "The Time Of Battle")
        self.assertEqual(leader["set_id"], "OP16")
        self.assertEqual(leader["rarity"], "Leader")
        self.assertEqual(leader["language"], "English")

    def test_number_is_what_is_printed_on_the_card(self) -> None:
        # `number` is Scrydex's sort key; `printed_number` is what a collector
        # reads off the card and searches for.
        for card in self.cards:
            mapped = map_scrydex_onepiece_card(card)
            self.assertEqual(mapped["number"], card.get("printed_number") or card.get("number"))

    def test_every_card_yields_a_reference_image_for_the_visual_index(self) -> None:
        # No image means the card cannot be indexed, which would silently punch
        # holes in a One Piece scanner lane.
        for card in self.cards:
            mapped = map_scrydex_onepiece_card(card)
            self.assertTrue(mapped["reference_image_url"], mapped["id"])

    def test_one_piece_shape_maps_onto_pokemon_columns_without_inventing_data(self) -> None:
        character = map_scrydex_onepiece_card(self.cards[1])
        # `type` is the closest thing to a supertype; `colors` to types.
        self.assertEqual(character["supertype"], "Character")
        self.assertEqual(character["types"], ["Red"])
        # Pokémon-only fields stay empty rather than being faked.
        self.assertIsNone(character["regulation_mark"])
        self.assertEqual(character["national_pokedex_numbers"], [])
        # Game stats have no column and ride along instead of being dropped.
        self.assertIn("power", character["source_payload"])

    def test_mapped_cards_persist_and_read_back_as_one_piece(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            database_path = Path(tmp) / "one-piece.sqlite"
            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")

            for card in self.cards[:5]:
                mapped = map_scrydex_onepiece_card(card)
                upsert_card(
                    connection,
                    card_id=str(mapped["id"]),
                    name=str(mapped["name"]),
                    set_name=str(mapped["set_name"]),
                    number=str(mapped["number"]),
                    rarity=str(mapped["rarity"]),
                    variant=str(mapped["variant"]),
                    language=str(mapped["language"]),
                    game=GAME_ONE_PIECE,
                    source_provider=str(mapped["source"]),
                    source_record_id=str(mapped["source_record_id"]),
                    set_id=mapped["set_id"],
                    image_url=mapped["reference_image_url"],
                    source_payload=mapped["source_payload"],
                )
            connection.commit()

            rows = connection.execute(
                "SELECT id, game, name FROM cards WHERE game = ? ORDER BY id", (GAME_ONE_PIECE,)
            ).fetchall()
            self.assertEqual([row["id"] for row in rows], ["OP16-001", "OP16-002", "OP16-003", "OP16-004", "OP16-005"])

            # The whole point of the column: a Pokémon-scoped read must not see them.
            pokemon_rows = connection.execute(
                "SELECT COUNT(*) AS total FROM cards WHERE game = ?", (GAME_POKEMON,)
            ).fetchone()
            self.assertEqual(int(pokemon_rows["total"]), 0)
            connection.close()

    def test_existing_pokemon_rows_default_to_pokemon(self) -> None:
        """The migration's DEFAULT is what backfills a live table in place — if
        it ever stopped working, every existing card would fall out of a
        game-scoped read."""
        with tempfile.TemporaryDirectory() as tmp:
            database_path = Path(tmp) / "default-game.sqlite"
            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            connection.execute(
                """
                INSERT INTO cards (id, name, set_name, number, rarity, variant, language, created_at, updated_at)
                VALUES ('base1-4', 'Charizard', 'Base', '4/102', 'Rare Holo', 'Raw', 'English', '2026-01-01', '2026-01-01')
                """
            )
            connection.commit()
            row = connection.execute("SELECT game FROM cards WHERE id = 'base1-4'").fetchone()
            self.assertEqual(row["game"], GAME_POKEMON)
            connection.close()


if __name__ == "__main__":
    unittest.main()
