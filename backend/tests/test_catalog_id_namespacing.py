"""Card and expansion ids carry their game, so two games can share a code.

The bug these exist for is not hypothetical and it was not loud. One Piece and
Gundam both ship an expansion literally called EB01 numbered from 001:

    EB01-001 = "Kouzuki Oden"                        (One Piece)
    EB01-001 = "Gundam Astray Red Frame Custom (EX)" (Gundam)

`cards.id` is a TEXT PRIMARY KEY with no game component, so syncing both games
into one catalog UPSERTed one over the other and dropped 211 Gundam cards
(947 -> 736) without raising anything. 11 expansion ids collide the same way.

The fix namespaces every NON-Pokémon id at ingest. Pokémon ids must stay
byte-identical — the live catalog, every collection row and the shipped visual
index are all keyed on them — so "Pokémon is untouched" is asserted here as
hard as "the collision is gone".
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote, unquote

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    GAME_GUNDAM,
    GAME_ID_NAMESPACE_SEPARATOR,
    GAME_LORCANA,
    GAME_ONE_PIECE,
    GAME_POKEMON,
    GAME_RIFTBOUND,
    _manual_search_clause_matches_set,
    _set_overlap,
    apply_schema,
    bare_catalog_id,
    build_raw_evidence,
    connect,
    game_for_catalog_id,
    game_id_namespace_prefix,
    get_cards_by_expansion,
    namespaced_catalog_id,
    search_cards,
    split_namespaced_catalog_id,
    upsert_card,
    upsert_expansion,
    utc_now,
)
from scrydex_adapter import map_scrydex_card_for_game  # noqa: E402

FIXTURE = BACKEND_ROOT / "tests" / "fixtures" / "scrydex_onepiece_cards_sample.json"

# Real ids from the live catalogs, not invented ones. `sv3pt5-25` in particular
# is the shape that makes "just split on the separator" wrong for Pokémon.
POKEMON_IDS = ("base1-4", "sv3pt5-25", "swshp-SWSH039", "sv8pt5-1", "base1-4_ja")

# The actual collision, as measured.
COLLIDING_CARD_ID = "EB01-001"
COLLIDING_EXPANSION_ID = "EB01"


def _one_piece_fixture_cards() -> list[dict]:
    """Real `/onepiece/v1/expansions/OP16/cards` response."""
    return json.loads(FIXTURE.read_text())["data"]


def _gundam_payload(card_id: str, name: str, expansion_id: str) -> dict:
    """Minimum Gundam card in the Scrydex envelope shape.

    Gundam has no dedicated mapper — it falls through to the default (Pokémon)
    one — which is exactly why it is used here: it proves the namespacing sits
    on the shared seam and not inside a per-game mapper that a new game would
    have to remember to copy.
    """
    return {
        "id": card_id,
        "name": name,
        "printed_number": card_id,
        "rarity": "Common",
        "expansion": {"id": expansion_id, "name": "Eternal Nexus", "code": expansion_id},
        "images": [{"type": "front", "large": f"https://images.example/{card_id}/large"}],
    }


class SeparatorChoiceTests(unittest.TestCase):
    """The separator is load-bearing, so its properties are asserted, not assumed."""

    def test_separator_survives_url_percent_encoding_unchanged(self) -> None:
        # `/api/v1/cards/{id}` is served by a hand-rolled http.server handler and
        # only SOME of its routes call unquote(). A separator that a client
        # percent-encodes would therefore work on four routes and 404 on seven.
        # "~" is RFC 3986 unreserved: quote() leaves it alone, so encoded and
        # unencoded are the same bytes and every route behaves identically.
        namespaced = namespaced_catalog_id(GAME_GUNDAM, COLLIDING_CARD_ID)
        self.assertEqual(quote(namespaced, safe=""), namespaced)
        self.assertEqual(unquote(namespaced), namespaced)

    def test_separator_is_a_legal_filename_on_this_filesystem(self) -> None:
        # Reference images are cached as `{card_id}{suffix}` by
        # tools/build_raw_visual_index.py, and the id is recovered from the stem
        # elsewhere. Both directions have to work.
        namespaced = namespaced_catalog_id(GAME_GUNDAM, COLLIDING_CARD_ID)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"{namespaced}.png"
            path.write_bytes(b"x")
            self.assertTrue(path.exists())
            self.assertEqual(path.stem, namespaced)

    def test_separator_does_not_occur_inside_any_real_id(self) -> None:
        # A separator that already appears in provider ids would make the split
        # ambiguous. Measured against all five synced catalogs: zero occurrences.
        for card_id in POKEMON_IDS + ("OP16-001", "AOTV-1", "VEN-1", "GD05-001"):
            self.assertNotIn(GAME_ID_NAMESPACE_SEPARATOR, card_id, card_id)

    def test_separator_is_not_the_hyphen_that_ids_already_use(self) -> None:
        # "-" is what a set code is recovered by in several places; reusing it
        # would hand those sites the game name as the set.
        self.assertNotEqual(GAME_ID_NAMESPACE_SEPARATOR, "-")


class PokemonIsUntouchedTests(unittest.TestCase):
    def test_pokemon_ids_come_back_byte_identical(self) -> None:
        for card_id in POKEMON_IDS:
            self.assertEqual(namespaced_catalog_id(GAME_POKEMON, card_id), card_id)
            # Absent game means Pokémon everywhere else in the codebase; it must
            # mean it here too, or an older caller silently renames a live id.
            self.assertEqual(namespaced_catalog_id(None, card_id), card_id)
            self.assertEqual(namespaced_catalog_id("", card_id), card_id)
            self.assertEqual(namespaced_catalog_id("nonsense", card_id), card_id)

    def test_pokemon_has_no_namespace_prefix_at_all(self) -> None:
        self.assertEqual(game_id_namespace_prefix(GAME_POKEMON), "")
        self.assertEqual(game_id_namespace_prefix(None), "")

    def test_a_pokemon_id_round_trips_to_pokemon(self) -> None:
        for card_id in POKEMON_IDS:
            self.assertEqual(split_namespaced_catalog_id(card_id), (GAME_POKEMON, card_id))
            self.assertEqual(bare_catalog_id(card_id), card_id)
            self.assertEqual(game_for_catalog_id(card_id), GAME_POKEMON)

    def test_the_pokemon_mapper_seam_does_not_rewrite_ids(self) -> None:
        payload = {
            "id": "base1-4",
            "name": "Charizard",
            "expansion": {"id": "base1", "name": "Base"},
            "images": [{"type": "front", "large": "https://images.example/base1-4/large"}],
        }
        mapped = map_scrydex_card_for_game(payload, GAME_POKEMON)
        self.assertEqual(mapped["id"], "base1-4")
        self.assertEqual(mapped["set_id"], "base1")


class NamespacingShapeTests(unittest.TestCase):
    def test_non_pokemon_ids_take_their_game_as_a_prefix(self) -> None:
        self.assertEqual(
            namespaced_catalog_id(GAME_GUNDAM, COLLIDING_CARD_ID), "gundam~EB01-001"
        )
        self.assertEqual(
            namespaced_catalog_id(GAME_ONE_PIECE, COLLIDING_CARD_ID), "onepiece~EB01-001"
        )
        self.assertEqual(namespaced_catalog_id(GAME_LORCANA, "AOTV-1"), "lorcana~AOTV-1")
        self.assertEqual(namespaced_catalog_id(GAME_RIFTBOUND, "VEN-1"), "riftbound~VEN-1")

    def test_the_alias_spellings_a_caller_might_pass_all_land_on_one_prefix(self) -> None:
        # `normalize_game` is forgiving; the id must not be. "One Piece", "op"
        # and "onepiece" cannot each mint their own catalog partition.
        for spelling in ("onepiece", "One Piece", "one-piece", "OP", "optcg"):
            self.assertEqual(
                namespaced_catalog_id(spelling, COLLIDING_CARD_ID), "onepiece~EB01-001"
            )

    def test_namespacing_is_idempotent_including_across_games(self) -> None:
        once = namespaced_catalog_id(GAME_GUNDAM, COLLIDING_CARD_ID)
        self.assertEqual(namespaced_catalog_id(GAME_GUNDAM, once), once)
        # Re-running a sync, or handing an already-namespaced id to the wrong
        # game, must never produce "onepiece~gundam~EB01-001".
        self.assertEqual(namespaced_catalog_id(GAME_ONE_PIECE, once), once)

    def test_an_empty_id_stays_empty_rather_than_becoming_a_bare_prefix(self) -> None:
        # "gundam~" would be a row keyed on nothing, and it would compare equal
        # to every other empty id in the game.
        for empty in (None, "", "   "):
            self.assertEqual(namespaced_catalog_id(GAME_GUNDAM, empty), "")

    def test_a_namespaced_id_round_trips_to_its_game_and_provider_id(self) -> None:
        for game, provider_id in (
            (GAME_GUNDAM, COLLIDING_CARD_ID),
            (GAME_ONE_PIECE, COLLIDING_CARD_ID),
            (GAME_LORCANA, "AOTV-1"),
            (GAME_RIFTBOUND, "VEN-1"),
        ):
            stored = namespaced_catalog_id(game, provider_id)
            self.assertEqual(split_namespaced_catalog_id(stored), (game, provider_id))
            self.assertEqual(bare_catalog_id(stored), provider_id)
            self.assertEqual(game_for_catalog_id(stored), game)


class MapperSeamTests(unittest.TestCase):
    """Namespacing happens where ids ENTER, not where they are displayed."""

    def test_the_one_piece_mapper_emits_namespaced_card_and_set_ids(self) -> None:
        mapped = map_scrydex_card_for_game(_one_piece_fixture_cards()[0], GAME_ONE_PIECE)
        self.assertEqual(mapped["id"], "onepiece~OP16-001")
        self.assertEqual(mapped["set_id"], "onepiece~OP16")

    def test_a_game_with_no_dedicated_mapper_is_namespaced_too(self) -> None:
        mapped = map_scrydex_card_for_game(
            _gundam_payload(COLLIDING_CARD_ID, "Gundam Astray Red Frame Custom (EX)", "EB01"),
            GAME_GUNDAM,
        )
        self.assertEqual(mapped["id"], "gundam~EB01-001")
        self.assertEqual(mapped["set_id"], "gundam~EB01")

    def test_source_record_id_keeps_the_providers_own_id(self) -> None:
        # This is provenance and the key you hand back to Scrydex. Namespacing
        # it would make the row unable to say where it came from.
        mapped = map_scrydex_card_for_game(_one_piece_fixture_cards()[0], GAME_ONE_PIECE)
        self.assertEqual(mapped["source_record_id"], "OP16-001")
        self.assertNotEqual(mapped["id"], mapped["source_record_id"])


class CollidingIdsCoexistTests(unittest.TestCase):
    """The bug itself: one `cards` table, both EB01-001s, nothing dropped."""

    def _catalog(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        connection = connect(Path(self._tmp.name) / "multigame.sqlite")
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        self.addCleanup(connection.close)
        return connection

    def _insert(self, connection, payload: dict, game: str) -> str:
        mapped = map_scrydex_card_for_game(payload, game)
        upsert_card(
            connection,
            card_id=str(mapped["id"]),
            name=str(mapped["name"]),
            set_name=str(mapped["set_name"]),
            number=str(mapped["number"]),
            rarity=str(mapped["rarity"]),
            variant=str(mapped["variant"]),
            language=str(mapped["language"]),
            game=game,
            source_provider=str(mapped["source"]),
            source_record_id=str(mapped["source_record_id"]),
            set_id=mapped["set_id"],
            image_url=mapped["reference_image_url"],
            source_payload=mapped["source_payload"] or {},
        )
        return str(mapped["id"])

    def test_one_piece_and_gundam_eb01_001_are_two_rows_not_one(self) -> None:
        connection = self._catalog()
        one_piece_id = self._insert(
            connection,
            {
                "id": COLLIDING_CARD_ID,
                "name": "Kouzuki Oden",
                "printed_number": COLLIDING_CARD_ID,
                "rarity": "Leader",
                "expansion": {"id": COLLIDING_EXPANSION_ID, "name": "Memorial Collection"},
                "images": [{"large": "https://images.example/op-eb01-001/large"}],
            },
            GAME_ONE_PIECE,
        )
        gundam_id = self._insert(
            connection,
            _gundam_payload(
                COLLIDING_CARD_ID, "Gundam Astray Red Frame Custom (EX)", COLLIDING_EXPANSION_ID
            ),
            GAME_GUNDAM,
        )
        connection.commit()

        self.assertNotEqual(one_piece_id, gundam_id)
        rows = connection.execute("SELECT id, game, name FROM cards ORDER BY id").fetchall()
        self.assertEqual(
            [(row["id"], row["game"], row["name"]) for row in rows],
            [
                ("gundam~EB01-001", GAME_GUNDAM, "Gundam Astray Red Frame Custom (EX)"),
                ("onepiece~EB01-001", GAME_ONE_PIECE, "Kouzuki Oden"),
            ],
        )

    def test_the_bare_provider_id_is_what_would_have_collided(self) -> None:
        # Stated explicitly so the test still describes the bug if the separator
        # ever changes: the two rows are distinct ONLY because of the namespace.
        connection = self._catalog()
        one_piece_id = namespaced_catalog_id(GAME_ONE_PIECE, COLLIDING_CARD_ID)
        gundam_id = namespaced_catalog_id(GAME_GUNDAM, COLLIDING_CARD_ID)
        self.assertEqual(bare_catalog_id(one_piece_id), bare_catalog_id(gundam_id))
        del connection

    def test_the_colliding_expansions_stay_two_expansions(self) -> None:
        connection = self._catalog()
        for game, name in ((GAME_ONE_PIECE, "Memorial Collection"), (GAME_GUNDAM, "Eternal Nexus")):
            upsert_expansion(
                connection,
                expansion_id=namespaced_catalog_id(game, COLLIDING_EXPANSION_ID),
                name=name,
                code=COLLIDING_EXPANSION_ID,
                imported_at=utc_now(),
            )
        connection.commit()
        rows = connection.execute("SELECT id, name FROM expansions ORDER BY id").fetchall()
        self.assertEqual(
            [(row["id"], row["name"]) for row in rows],
            [("gundam~EB01", "Eternal Nexus"), ("onepiece~EB01", "Memorial Collection")],
        )

    def test_set_browsing_joins_the_right_games_cards(self) -> None:
        # cards.set_id and expansions.id are namespaced with the SAME prefix, so
        # browsing an expansion must not spill the other game's EB01.
        connection = self._catalog()
        self._insert(
            connection,
            {
                "id": COLLIDING_CARD_ID,
                "name": "Kouzuki Oden",
                "printed_number": COLLIDING_CARD_ID,
                "rarity": "Leader",
                "expansion": {"id": COLLIDING_EXPANSION_ID, "name": "Memorial Collection"},
                "images": [{"large": "https://images.example/op/large"}],
            },
            GAME_ONE_PIECE,
        )
        self._insert(
            connection,
            _gundam_payload(
                COLLIDING_CARD_ID, "Gundam Astray Red Frame Custom (EX)", COLLIDING_EXPANSION_ID
            ),
            GAME_GUNDAM,
        )
        connection.commit()

        gundam_cards = get_cards_by_expansion(
            connection, "gundam~EB01", game=GAME_GUNDAM, limit=50
        )
        self.assertEqual(
            [card["name"] for card in gundam_cards], ["Gundam Astray Red Frame Custom (EX)"]
        )
        one_piece_cards = get_cards_by_expansion(
            connection, "onepiece~EB01", game=GAME_ONE_PIECE, limit=50
        )
        self.assertEqual([card["name"] for card in one_piece_cards], ["Kouzuki Oden"])


class IdParsingStillWorksTests(unittest.TestCase):
    """Every place that reads INTO an id has to cope with the namespace."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.connection = connect(Path(self._tmp.name) / "gundam.sqlite")
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        self.addCleanup(self.connection.close)
        upsert_card(
            self.connection,
            card_id="gundam~EB01-001",
            name="Gundam Astray Red Frame Custom",
            set_name="Eternal Nexus",
            number="EB01-001",
            rarity="Common",
            variant="Raw",
            language="English",
            game=GAME_GUNDAM,
            set_id="gundam~EB01",
            set_ptcgo_code="EB01",
        )
        self.connection.commit()

    def test_the_outbound_scrydex_url_carries_the_providers_bare_id(self) -> None:
        # Scrydex has never heard of "gundam~EB01-001"; the /gundam/v1 path
        # segment is what disambiguates on that side, so the namespace comes off.
        from scrydex_adapter import scrydex_request_url

        url = scrydex_request_url(f"/gundam/v1/cards/{bare_catalog_id('gundam~EB01-001')}")
        self.assertIn("/gundam/v1/cards/EB01-001", url)
        self.assertNotIn(GAME_ID_NAMESPACE_SEPARATOR, url)

    def test_a_structured_set_clause_matches_the_printed_code(self) -> None:
        # The user types what is on the card ("set:eb01"), never our namespace.
        card = {"setName": "Eternal Nexus", "setID": "gundam~EB01", "setPtcgoCode": None}
        self.assertTrue(_manual_search_clause_matches_set(card, "eb01"))
        self.assertTrue(_manual_search_clause_matches_set(card, "eternal nexus"))
        # And the namespace is not itself a set the user can name.
        self.assertFalse(_manual_search_clause_matches_set(card, "gundam"))

    def test_ocr_set_evidence_still_scores_against_a_namespaced_set_id(self) -> None:
        # The scanner's set badge reads "EB01" off the card. If the overlap
        # scorer compared that to the stored "gundam~EB01" it would score zero
        # and the set evidence would silently stop counting.
        card = {"setName": "Eternal Nexus", "setID": "gundam~EB01", "setPtcgoCode": None}
        evidence = build_raw_evidence({"setHintTokens": ["EB01"]})
        self.assertEqual(evidence.set_hint_tokens, ("eb01",))
        self.assertGreater(_set_overlap(card, evidence), 0.0)

    def test_the_game_name_is_not_searchable_text(self) -> None:
        # The namespace lives inside set_id, which several search tiers tokenize
        # and score. Left unstripped, the query "gundam" scored a set-token hit
        # on EVERY Gundam card and reordered results by nothing at all.
        results = search_cards(self.connection, "gundam", limit=10, game=GAME_GUNDAM)
        self.assertEqual([card["id"] for card in results], ["gundam~EB01-001"])
        by_number = search_cards(self.connection, "EB01-001", limit=10, game=GAME_GUNDAM)
        self.assertEqual([card["id"] for card in by_number], ["gundam~EB01-001"])


if __name__ == "__main__":
    unittest.main()
