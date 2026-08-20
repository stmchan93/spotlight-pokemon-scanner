"""The game descriptor table: what each supported TCG is, and what it HAS.

These tests exist because the alternative to a registry is a grep. Before this,
"does this game have graded pricing?" was answered by `game == "onepiece"`
scattered across the sync script, the adapter and the PDP — and each of those
sites could drift independently. The contract here is that a game is DATA, and
every capability question has exactly one answer.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    DEFAULT_GAME,
    GAME_GUNDAM,
    GAME_LORCANA,
    GAME_ONE_PIECE,
    GAME_POKEMON,
    GAME_RIFTBOUND,
    GAMES,
    RARITY_BUCKET_KEYS,
    SUPPORTED_GAMES,
    catalog_sync_request_type,
    game_descriptor,
    game_display_name,
    game_ebay_search_keyword,
    game_graders,
    game_has_graded_pricing,
    game_has_language_paths,
    game_has_listings,
    game_has_pop_reports,
    game_marketplace_keyword,
    normalize_game,
    rarity_bucket,
    scrydex_game_segment,
)

ALL_GAMES = (GAME_POKEMON, GAME_ONE_PIECE, GAME_LORCANA, GAME_RIFTBOUND, GAME_GUNDAM)


class GameTableShapeTests(unittest.TestCase):
    def test_every_supported_game_has_a_descriptor(self) -> None:
        self.assertEqual(set(SUPPORTED_GAMES), set(ALL_GAMES))
        self.assertEqual(set(GAMES), set(ALL_GAMES))

    def test_descriptor_lookup_works_for_all_five_games(self) -> None:
        for game in ALL_GAMES:
            descriptor = game_descriptor(game)
            self.assertEqual(descriptor.id, game)
            self.assertTrue(descriptor.display_name, game)
            self.assertTrue(descriptor.scrydex_segment, game)
            self.assertTrue(descriptor.marketplace_keyword, game)
            self.assertTrue(descriptor.rarity_buckets, game)

    def test_descriptor_id_matches_its_table_key(self) -> None:
        # A copy-paste in the table (two entries claiming the same id) would make
        # every capability lookup for one of them silently answer for the other.
        for key, descriptor in GAMES.items():
            self.assertEqual(key, descriptor.id)

    def test_scrydex_segments_are_the_documented_paths(self) -> None:
        self.assertEqual(scrydex_game_segment(GAME_POKEMON), "pokemon")
        self.assertEqual(scrydex_game_segment(GAME_ONE_PIECE), "onepiece")
        self.assertEqual(scrydex_game_segment(GAME_LORCANA), "lorcana")
        self.assertEqual(scrydex_game_segment(GAME_RIFTBOUND), "riftbound")
        self.assertEqual(scrydex_game_segment(GAME_GUNDAM), "gundam")

    def test_display_names_and_marketplace_keywords(self) -> None:
        self.assertEqual(game_display_name(GAME_ONE_PIECE), "One Piece")
        self.assertEqual(game_marketplace_keyword(GAME_ONE_PIECE), "one piece")
        self.assertEqual(game_marketplace_keyword(GAME_LORCANA), "lorcana")
        self.assertEqual(game_marketplace_keyword(GAME_RIFTBOUND), "riftbound")
        self.assertEqual(game_marketplace_keyword(GAME_GUNDAM), "gundam")


class NormalizeGameTests(unittest.TestCase):
    def test_absent_and_unknown_both_mean_pokemon(self) -> None:
        """ABSENT MEANS POKÉMON. Payloads from a backend that predates
        multi-game carry no game at all; treating that as "unknown" would strip
        PSA pricing off every Pokémon card in every collection."""
        for value in (None, "", "   ", "nonsense", "magic", "yugioh"):
            self.assertEqual(normalize_game(value), GAME_POKEMON, value)
        self.assertEqual(DEFAULT_GAME, GAME_POKEMON)

    def test_spellings_a_caller_might_plausibly_pass(self) -> None:
        cases = {
            "onepiece": GAME_ONE_PIECE,
            "one-piece": GAME_ONE_PIECE,
            "one piece": GAME_ONE_PIECE,
            "One Piece": GAME_ONE_PIECE,
            "OP": GAME_ONE_PIECE,
            "lorcana": GAME_LORCANA,
            "Disney Lorcana": GAME_LORCANA,
            "LORCANA": GAME_LORCANA,
            "riftbound": GAME_RIFTBOUND,
            "Riftbound": GAME_RIFTBOUND,
            "gundam": GAME_GUNDAM,
            "Gundam": GAME_GUNDAM,
            "gundam_card_game": GAME_GUNDAM,
            "POKEMON": GAME_POKEMON,
        }
        for value, expected in cases.items():
            self.assertEqual(normalize_game(value), expected, value)

    def test_normalizing_is_idempotent(self) -> None:
        for game in ALL_GAMES:
            self.assertEqual(normalize_game(normalize_game(game)), game)

    def test_game_descriptor_never_raises_on_garbage(self) -> None:
        self.assertEqual(game_descriptor("not-a-game").id, GAME_POKEMON)
        self.assertEqual(game_descriptor(None).id, GAME_POKEMON)


class GameCapabilityTests(unittest.TestCase):
    """The capability flags are claims about the DATA WE CAN GET, established by
    probing the live Scrydex API on 2026-08-13 — not opinions about the games."""

    def test_pokemon_and_lorcana_have_graded_pricing_and_nobody_else_does(self) -> None:
        # MEASURED against the synced catalogs, not assumed: 1,525 of 3,170
        # priced Lorcana cards carry graded contexts (AOTV-224 has a PSA 10
        # Holofoil at $140 market). One Piece, Riftbound and Gundam are all
        # flatly zero. The earlier assumption that "only Pokémon has graded
        # data" was wrong, and this test is what stops it coming back.
        self.assertTrue(game_has_graded_pricing(GAME_POKEMON))
        self.assertTrue(game_has_graded_pricing(GAME_LORCANA))
        for game in (GAME_ONE_PIECE, GAME_RIFTBOUND, GAME_GUNDAM):
            self.assertFalse(game_has_graded_pricing(game), game)

    def test_population_is_pokemon_only(self) -> None:
        # Including Lorcana: it has graded PRICES but zero population rows.
        # Our population source is GemRate via PokemonPriceTracker.
        self.assertTrue(game_has_pop_reports(GAME_POKEMON))
        for game in (GAME_ONE_PIECE, GAME_LORCANA, GAME_RIFTBOUND, GAME_GUNDAM):
            self.assertFalse(game_has_pop_reports(game), game)

    def test_graded_pricing_and_listings_are_separate_claims(self) -> None:
        # These stay separate flags because each is its own measurement against
        # its own endpoint. Lorcana came back TRUE on graded pricing and TRUE on
        # listings but FALSE on population — one "is this a graded game" boolean
        # would have hung an always-empty population panel under a real lane.
        self.assertTrue(game_has_graded_pricing(GAME_LORCANA))
        self.assertTrue(game_has_listings(GAME_LORCANA))
        self.assertFalse(game_has_pop_reports(GAME_LORCANA))

    def test_listings_claims_match_what_was_measured(self) -> None:
        # Pokémon: shipped and serving. Lorcana: measured 2026-08-14 with one
        # live request (tools/probe_scrydex_lorcana_listings.py) — the broadest
        # query for AOTV-224, a $140 PSA 10, returned a real eBay sold row.
        for game in (GAME_POKEMON, GAME_LORCANA):
            self.assertTrue(game_has_listings(game), game)
        # `/onepiece/v1/cards/{id}/listings` returns ZERO rows; Riftbound and
        # Gundam are simply unmeasured. Both cases claim nothing, because an
        # empty sold-comps drawer under a real lane reads as broken.
        for game in (GAME_ONE_PIECE, GAME_RIFTBOUND, GAME_GUNDAM):
            self.assertFalse(game_has_listings(game), game)

    def test_only_pokemon_has_per_language_scrydex_sub_paths(self) -> None:
        # Only Pokémon serves `/pokemon/v1/ja/cards`; the others carry language
        # as a card field, and asking them for a language sub-path 404s.
        self.assertTrue(game_has_language_paths(GAME_POKEMON))
        for game in (GAME_ONE_PIECE, GAME_LORCANA, GAME_RIFTBOUND, GAME_GUNDAM):
            self.assertFalse(game_has_language_paths(game), game)

    def test_capabilities_of_an_absent_game_are_pokemons(self) -> None:
        self.assertTrue(game_has_graded_pricing(None))
        self.assertTrue(game_has_pop_reports(None))
        self.assertTrue(game_has_listings(None))
        self.assertTrue(game_has_language_paths(None))
        self.assertEqual(game_graders(None), ("Raw", "PSA", "BGS", "CGC"))

    def test_graders_are_per_game_not_one_shared_constant(self) -> None:
        # PSA/BGS/CGC is a POKÉMON fact. Lorcana's priced slabs span eight
        # companies, and handing it the Pokémon four would hide most of its data.
        self.assertEqual(game_graders(GAME_POKEMON), ("Raw", "PSA", "BGS", "CGC"))
        self.assertEqual(
            game_graders(GAME_LORCANA),
            ("Raw", "PSA", "CGC", "SGC", "BGS", "TAG", "ACE", "AGS", "CCIC"),
        )
        for game in (GAME_ONE_PIECE, GAME_RIFTBOUND, GAME_GUNDAM):
            # Raw stays, so the card is still addable to a collection — it just
            # cannot claim a grade.
            self.assertEqual(game_graders(game), ("Raw",), game)

    def test_every_game_leads_its_grader_list_with_raw(self) -> None:
        for game in ALL_GAMES:
            self.assertEqual(game_graders(game)[0], "Raw", game)

    def test_a_game_offers_graders_exactly_when_it_has_graded_pricing(self) -> None:
        for game in ALL_GAMES:
            has_lanes = len(game_graders(game)) > 1
            self.assertEqual(has_lanes, game_has_graded_pricing(game), game)

    def test_pokemon_declares_no_ebay_keyword(self) -> None:
        # eBay AND-requires every keyword. Pokémon's queries are tuned around
        # NOT having a game token, and adding one could zero a sparse vintage
        # graded search — so its keyword is None and its URLs are unchanged.
        self.assertIsNone(game_ebay_search_keyword(GAME_POKEMON))
        self.assertIsNone(game_ebay_search_keyword(None))
        self.assertEqual(game_ebay_search_keyword(GAME_ONE_PIECE), "one piece")
        self.assertEqual(game_ebay_search_keyword(GAME_LORCANA), "lorcana")
        self.assertEqual(game_ebay_search_keyword(GAME_RIFTBOUND), "riftbound")
        self.assertEqual(game_ebay_search_keyword(GAME_GUNDAM), "gundam")


class PerGameRarityBucketTests(unittest.TestCase):
    def test_every_mapped_bucket_is_one_of_the_shipped_keys(self) -> None:
        # Reusing the eight shipped keys across games is what lets the rarity
        # filter chips work for a new game with ZERO client change. An invented
        # bucket would map to a chip that does not exist.
        for game_id, descriptor in GAMES.items():
            for label, bucket in descriptor.rarity_buckets.items():
                self.assertIn(bucket, RARITY_BUCKET_KEYS, f"{game_id}:{label}")
            for _needles, bucket in descriptor.rarity_substring_rules:
                self.assertIn(bucket, RARITY_BUCKET_KEYS, game_id)

    def test_pokemon_ladder_is_unchanged_by_the_registry(self) -> None:
        self.assertEqual(rarity_bucket("Special Illustration Rare"), "sir")
        self.assertEqual(rarity_bucket("Illustration Rare"), "illustration")
        self.assertEqual(rarity_bucket("Rare Holo VMAX"), "ultra")
        self.assertEqual(rarity_bucket("Hyper Rare"), "secret")
        self.assertEqual(rarity_bucket("Radiant Rare"), "shiny")
        self.assertEqual(rarity_bucket("Promo"), "promo")
        self.assertEqual(rarity_bucket("Common"), "standard")

    def test_one_piece_ladder(self) -> None:
        cases = {
            "Common": "standard",
            "Uncommon": "standard",
            "Rare": "standard",
            "Leader": "standard",
            "Super Rare": "ultra",
            "Secret Rare": "secret",
            "Manga Rare": "illustration",
            "Promo": "promo",
        }
        for label, expected in cases.items():
            self.assertEqual(rarity_bucket(label, GAME_ONE_PIECE), expected, label)

    def test_lorcana_ladder(self) -> None:
        cases = {
            "Common": "standard",
            "Uncommon": "standard",
            "Rare": "standard",
            "Super Rare": "ultra",
            # Sibling Lorcana APIs emit the underscored spelling.
            "Super_rare": "ultra",
            "Legendary": "ultra",
            "Epic": "ultra",
            # Enchanted is the alternate-ART chase, not another rarity step.
            "Enchanted": "illustration",
            "Iconic": "secret",
            "Promo": "promo",
        }
        for label, expected in cases.items():
            self.assertEqual(rarity_bucket(label, GAME_LORCANA), expected, label)

    def test_riftbound_ladder(self) -> None:
        # The GAMEPLAY ladder is only four deep. There is no "Legendary" rarity —
        # in Riftbound "Legend" is a card type — so it must not be invented.
        cases = {
            "Common": "standard",
            "Uncommon": "standard",
            "Rare": "standard",
            "Epic": "ultra",
            "Showcase": "illustration",
            "Overnumbered": "secret",
            "Promo": "promo",
        }
        for label, expected in cases.items():
            self.assertEqual(rarity_bucket(label, GAME_RIFTBOUND), expected, label)

    def test_gundam_ladder_reads_both_the_code_and_the_word(self) -> None:
        # Scrydex serves Gundam's `rarity_code` ("C") alongside a spelled-out
        # `rarity` ("Common"), so both must bucket the same.
        cases = {
            "Common": "standard",
            "C": "standard",
            "Uncommon": "standard",
            "U": "standard",
            "Rare": "standard",
            "R": "standard",
            # LR (Legend Rare) is the CEILING of this game's ladder; it has no
            # Super Rare tier at all.
            "Legend Rare": "secret",
            "LR": "secret",
            "Special": "illustration",
            "SP": "illustration",
            "Promo": "promo",
            "P": "promo",
        }
        for label, expected in cases.items():
            self.assertEqual(rarity_bucket(label, GAME_GUNDAM), expected, label)

    def test_gundam_chase_suffixes_do_not_demote_to_a_plain_rare(self) -> None:
        # "LR++" must not fall into the single-letter "r" rule and read as Rare.
        self.assertEqual(rarity_bucket("LR+", GAME_GUNDAM), "secret")
        self.assertEqual(rarity_bucket("LR++", GAME_GUNDAM), "secret")
        self.assertEqual(rarity_bucket("R+", GAME_GUNDAM), "standard")

    def test_unknown_labels_land_in_other_rather_than_a_new_bucket(self) -> None:
        for game in ALL_GAMES:
            for value in (None, "", "   ", "???", "Ultra Mega Chase Rare Zeta"):
                self.assertIn(rarity_bucket(value, game), RARITY_BUCKET_KEYS, f"{game}:{value}")
            self.assertEqual(rarity_bucket("???", game), "other", game)

    def test_a_label_is_bucketed_by_its_own_games_ladder(self) -> None:
        # "Leader" is a One Piece card role; Pokémon has no such rarity.
        self.assertEqual(rarity_bucket("Leader", GAME_ONE_PIECE), "standard")
        self.assertEqual(rarity_bucket("Leader", GAME_POKEMON), "other")
        # "Enchanted" is a Lorcana tier and means nothing to One Piece.
        self.assertEqual(rarity_bucket("Enchanted", GAME_LORCANA), "illustration")
        self.assertEqual(rarity_bucket("Enchanted", GAME_ONE_PIECE), "other")


class CatalogSyncRequestTypeTests(unittest.TestCase):
    def test_pokemon_keeps_its_exact_historical_label(self) -> None:
        # This string is the group-by key for scrydex_daily_usage_rollups.
        # Qualifying it would split years of credit history in two at the rename.
        self.assertEqual(catalog_sync_request_type(GAME_POKEMON, "all"), "catalog_sync_all")
        self.assertEqual(catalog_sync_request_type(None, "ja"), "catalog_sync_ja")
        self.assertEqual(catalog_sync_request_type(GAME_POKEMON, None), "catalog_sync_all")

    def test_other_games_get_a_separable_label(self) -> None:
        self.assertEqual(
            catalog_sync_request_type(GAME_ONE_PIECE, "all"), "catalog_sync_onepiece_all"
        )
        self.assertEqual(catalog_sync_request_type(GAME_LORCANA, None), "catalog_sync_lorcana_all")
        self.assertEqual(
            catalog_sync_request_type(GAME_GUNDAM, "all"), "catalog_sync_gundam_all"
        )


class ExplicitGameArgumentTests(unittest.TestCase):
    """A defaulted `game` is how a One Piece sync quietly pulled 449 POKÉMON
    expansions: the caller believed it had said which game and the signature
    disagreed in silence. A missing argument must be a TypeError."""

    def test_expansion_helpers_require_an_explicit_game(self) -> None:
        from scrydex_adapter import (
            fetch_scrydex_expansions,
            fetch_scrydex_expansions_raw,
            sync_scrydex_expansions,
        )

        with self.assertRaises(TypeError):
            fetch_scrydex_expansions()  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            fetch_scrydex_expansions_raw()  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            sync_scrydex_expansions(object())  # type: ignore[call-arg]


class ScrydexCardMapperRegistryTests(unittest.TestCase):
    def test_mapper_is_chosen_from_the_table_not_a_conditional(self) -> None:
        from scrydex_adapter import map_scrydex_card_for_game

        one_piece = map_scrydex_card_for_game(
            {"id": "OP16-001", "name": "Portgas.D.Ace", "type": "Leader"}, GAME_ONE_PIECE
        )
        self.assertEqual(one_piece["game"], GAME_ONE_PIECE)
        # Games with no bespoke mapper fall through to the default one rather
        # than crashing on a missing table entry. The id comes back namespaced
        # per game (see catalog_tools.namespaced_catalog_id) — Pokémon's, and
        # only Pokémon's, stays byte-identical.
        from catalog_tools import namespaced_catalog_id

        for game in (GAME_POKEMON, GAME_LORCANA, GAME_RIFTBOUND, GAME_GUNDAM, None):
            mapped = map_scrydex_card_for_game({"id": "x", "name": "x"}, game)  # type: ignore[arg-type]
            self.assertEqual(mapped["id"], namespaced_catalog_id(game, "x"), game)
        self.assertEqual(map_scrydex_card_for_game({"id": "x", "name": "x"}, GAME_POKEMON)["id"], "x")


class EbaySearchQueryGameScopingTests(unittest.TestCase):
    def test_pokemon_query_is_byte_identical_to_before(self) -> None:
        from ebay_comps import _build_search_query

        card = {"name": "Charizard", "setName": "Base Set", "number": "4/102"}
        expected = "Charizard Base Set 4/102 PSA 10"
        self.assertEqual(
            _build_search_query(card, grader="PSA", selected_grade="10"), expected
        )
        self.assertEqual(
            _build_search_query({**card, "game": "pokemon"}, grader="PSA", selected_grade="10"),
            expected,
        )

    def test_other_games_lead_with_their_keyword(self) -> None:
        from ebay_comps import _build_search_query

        query = _build_search_query(
            {"game": "onepiece", "name": "Portgas.D.Ace", "setName": "Uta", "number": "OP16-001"},
            grader="PSA",
            selected_grade="10",
        )
        self.assertTrue(query.startswith("one piece "), query)
        self.assertNotIn("pokemon", query)


if __name__ == "__main__":
    unittest.main()
