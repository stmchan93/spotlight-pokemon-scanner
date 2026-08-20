"""Catalog reads are scoped to ONE game, and Pokémon did not move.

The per-game visual index (see test_multi_game_visual_index.py) stops a scan
from matching against another game's embeddings. It does nothing for the paths
that read the shared `cards` table by TEXT — catalog search, the expansion
browser, and the scanner's own OCR fallback — and those are the ones that mix
catalogs, because a card row is only as scoped as its query.

Three claims are under test:

  1. CONTAMINATION. A query scoped to one game never returns another game's
     card. Exercised with deliberately colliding names, numbers and set ids,
     because a leak on non-colliding data proves nothing.
  2. POKÉMON IS UNMOVED. Loading a second game into the same catalog must not
     change a single Pokémon result. This is the branch's hard rule, and it is
     the reason `game` is threaded rather than inferred.
  3. THE `+game` DECISION. Scoping in SQL flips SQLite onto `idx_cards_game`,
     which on a production catalog (every row 'pokemon') selects the whole
     table. These assertions pin the query plans so nobody "cleans up" the
     unary plus and turns every keystroke into a full scan.
"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    GAME_LORCANA,
    GAME_ONE_PIECE,
    GAME_POKEMON,
    apply_schema,
    connect,
    game_for_scan_payload,
    get_cards_by_expansion,
    search_cards,
    search_cards_local,
    upsert_card,
)


def _insert(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    game: str,
    name: str,
    set_name: str,
    set_id: str,
    number: str,
    rarity: str = "Rare",
    artist: str | None = None,
) -> None:
    upsert_card(
        connection,
        card_id=card_id,
        game=game,
        name=name,
        set_name=set_name,
        number=number,
        rarity=rarity,
        variant="Raw",
        language="English",
        source_provider="scrydex",
        source_record_id=card_id,
        set_id=set_id,
        set_ptcgo_code=set_id.upper(),
        set_release_date="2026-01-01",
        artist=artist,
        image_url=f"https://images.example/{card_id}/large",
        image_small_url=f"https://images.example/{card_id}/small",
    )


class _CatalogTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "catalog.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        self.addCleanup(self.connection.close)

    def _ids(self, query: str, game: str, **kwargs) -> list[str]:
        return [row["id"] for row in search_cards(self.connection, query, game=game, **kwargs)]


class CrossGameContaminationTests(_CatalogTestCase):
    """A query scoped to one game must never return another game's card."""

    def setUp(self) -> None:
        super().setUp()
        # Names chosen to COLLIDE. "Nami" is a One Piece character and also a
        # plausible Pokémon-catalog string; both catalogs really do contain
        # "Ace". If scoping is broken, these are what surface it — a test built
        # on "Charizard" vs "Monkey.D.Luffy" would pass with no scoping at all.
        _insert(self.connection, card_id="pkmn-ace", game=GAME_POKEMON, name="Ace",
                set_name="Base", set_id="base1", number="4/102")
        _insert(self.connection, card_id="OP01-001", game=GAME_ONE_PIECE, name="Ace",
                set_name="Romance Dawn", set_id="OP01", number="4/102")
        _insert(self.connection, card_id="lorcana-ace", game=GAME_LORCANA, name="Ace",
                set_name="Attack of the Vine!", set_id="AOTV", number="4/102")
        self.connection.commit()

    def test_a_name_shared_by_three_games_returns_only_the_scoped_one(self) -> None:
        self.assertEqual(self._ids("Ace", GAME_POKEMON), ["pkmn-ace"])
        self.assertEqual(self._ids("Ace", GAME_ONE_PIECE), ["OP01-001"])
        self.assertEqual(self._ids("Ace", GAME_LORCANA), ["lorcana-ace"])

    def test_a_shared_collector_number_does_not_cross_games(self) -> None:
        # Collector numbers are not namespaced at all — "4/102" is whatever the
        # printer chose. Number retrieval scores HIGHEST of any route (760), so
        # an unscoped number query is the fastest way to pull a foreign card to
        # rank 1.
        for game, expected in (
            (GAME_POKEMON, "pkmn-ace"),
            (GAME_ONE_PIECE, "OP01-001"),
            (GAME_LORCANA, "lorcana-ace"),
        ):
            self.assertEqual(self._ids("4/102", game), [expected], game)

    def test_structured_field_queries_stay_scoped(self) -> None:
        self.assertEqual(self._ids("name:Ace", GAME_ONE_PIECE), ["OP01-001"])
        self.assertEqual(self._ids("number:4/102", GAME_LORCANA), ["lorcana-ace"])

    def test_a_game_with_no_cards_returns_nothing_rather_than_pokemons(self) -> None:
        # The failure mode this guards is the worst one: an unscoped search
        # answering a brand-new game's first query with a full Pokémon catalog,
        # which looks like the feature working.
        self.assertEqual(self._ids("Ace", "riftbound"), [])
        self.assertEqual(self._ids("Charizard", "gundam"), [])

    def test_the_scanner_ocr_fallback_is_scoped_too(self) -> None:
        # search_cards_local backs the raw OCR retrieval routes. The visual
        # index is already per-game, so this helper is the remaining way a One
        # Piece scan could surface a Pokémon card.
        self.assertEqual(
            [c["id"] for c in search_cards_local(self.connection, "Ace", game=GAME_ONE_PIECE)],
            ["OP01-001"],
        )
        self.assertEqual(
            [c["id"] for c in search_cards_local(self.connection, "Ace", game=GAME_POKEMON)],
            ["pkmn-ace"],
        )

    def test_every_returned_row_carries_the_game_it_was_scoped_to(self) -> None:
        for game in (GAME_POKEMON, GAME_ONE_PIECE, GAME_LORCANA):
            rows = search_cards(self.connection, "Ace", game=game)
            self.assertTrue(rows, game)
            self.assertEqual({row["game"] for row in rows}, {game})


class CollidingExpansionIdTests(_CatalogTestCase):
    """`set_id` is provider-assigned per game, so it is not a safe key alone."""

    def setUp(self) -> None:
        super().setUp()
        # The same set_id in two games. Not hypothetical: short codes like "OP"
        # / "P" / "SV" are assigned independently by each provider.
        _insert(self.connection, card_id="pkmn-sv1-1", game=GAME_POKEMON, name="Sprigatito",
                set_name="Scarlet & Violet", set_id="sv1", number="13/198")
        _insert(self.connection, card_id="op-sv1-1", game=GAME_ONE_PIECE, name="Sanji",
                set_name="Some Set", set_id="sv1", number="13/198")
        self.connection.commit()

    def test_browsing_an_expansion_returns_only_the_scoped_games_cards(self) -> None:
        self.assertEqual(
            [c["id"] for c in get_cards_by_expansion(self.connection, "sv1", game=GAME_POKEMON)],
            ["pkmn-sv1-1"],
        )
        self.assertEqual(
            [c["id"] for c in get_cards_by_expansion(self.connection, "sv1", game=GAME_ONE_PIECE)],
            ["op-sv1-1"],
        )

    def test_the_in_expansion_search_branch_is_scoped_too(self) -> None:
        # get_cards_by_expansion has two SQL paths — bare browse and text
        # search. Scoping one and not the other is an easy miss.
        self.assertEqual(
            [c["id"] for c in get_cards_by_expansion(self.connection, "sv1", game=GAME_ONE_PIECE, query="Sanji")],
            ["op-sv1-1"],
        )
        self.assertEqual(
            get_cards_by_expansion(self.connection, "sv1", game=GAME_POKEMON, query="Sanji"),
            [],
        )
        # …including the number branch, which builds its own OR-list.
        self.assertEqual(
            [c["id"] for c in get_cards_by_expansion(self.connection, "sv1", game=GAME_POKEMON, query="13")],
            ["pkmn-sv1-1"],
        )


class RarityBrowseScopingTests(_CatalogTestCase):
    """The rarity-bucket browse pages in SQL, so it is scoped in SQL."""

    def setUp(self) -> None:
        super().setUp()
        _insert(self.connection, card_id="pkmn-sir", game=GAME_POKEMON, name="Pikachu",
                set_name="Base", set_id="base1", number="1", rarity="Special Illustration Rare")
        _insert(self.connection, card_id="OP01-secret", game=GAME_ONE_PIECE, name="Shanks",
                set_name="Romance Dawn", set_id="OP01", number="1", rarity="Secret Rare")
        _insert(self.connection, card_id="OP01-manga", game=GAME_ONE_PIECE, name="Buggy",
                set_name="Romance Dawn", set_id="OP01", number="2", rarity="Manga Rare")
        self.connection.commit()

    def test_a_bare_bucket_browse_lists_only_the_scoped_games_cards(self) -> None:
        self.assertEqual(self._ids("rarity:sir", GAME_POKEMON), ["pkmn-sir"])
        # One Piece has no "sir" tier at all — the right answer is empty, not
        # "here is Pokémon's".
        self.assertEqual(self._ids("rarity:sir", GAME_ONE_PIECE), [])
        self.assertEqual(sorted(self._ids("rarity:secret", GAME_ONE_PIECE)), ["OP01-secret"])

    def test_bucket_paging_stays_scoped_across_pages(self) -> None:
        # Paging happens in SQL here, so a Python-side filter would hand back
        # short pages. Two One Piece cards land in different buckets; ask for
        # the bucket that holds one of them and page it.
        page_one = self._ids("rarity:illustration", GAME_ONE_PIECE, limit=1, offset=0)
        self.assertEqual(page_one, ["OP01-manga"])
        self.assertEqual(self._ids("rarity:illustration", GAME_ONE_PIECE, limit=1, offset=1), [])


class PokemonIsUnmovedTests(_CatalogTestCase):
    """The hard rule: a second game in the catalog changes nothing for Pokémon."""

    def _pokemon_catalog(self) -> None:
        _insert(self.connection, card_id="base1-4", game=GAME_POKEMON, name="Charizard",
                set_name="Base", set_id="base1", number="4/102", rarity="Rare Holo",
                artist="Mitsuhiro Arita")
        _insert(self.connection, card_id="base1-58", game=GAME_POKEMON, name="Pikachu",
                set_name="Base", set_id="base1", number="58/102", rarity="Common")
        _insert(self.connection, card_id="obf-125", game=GAME_POKEMON, name="Charizard ex",
                set_name="Obsidian Flames", set_id="obf", number="125/197",
                rarity="Special Illustration Rare")
        self.connection.commit()

    def test_adding_another_game_changes_no_pokemon_result(self) -> None:
        self._pokemon_catalog()
        queries = [
            "charizard", "pikachu", "base set charizard", "4/102",
            "name:charizard", "set:base", "arita", "rarity:sir", "charizard ex",
        ]
        before = {q: self._ids(q, GAME_POKEMON) for q in queries}

        # Now load a second game whose cards collide on name, number and artist.
        _insert(self.connection, card_id="OP01-001", game=GAME_ONE_PIECE, name="Charizard",
                set_name="Base", set_id="base1", number="4/102", rarity="Secret Rare",
                artist="Mitsuhiro Arita")
        _insert(self.connection, card_id="OP01-002", game=GAME_ONE_PIECE, name="Pikachu ex",
                set_name="Obsidian Flames", set_id="obf", number="125/197", rarity="Manga Rare")
        self.connection.commit()

        after = {q: self._ids(q, GAME_POKEMON) for q in queries}
        # Identical lists, in identical ORDER — ranking is the part a shared
        # catalog would quietly disturb.
        self.assertEqual(after, before)

    def test_an_absent_or_unknown_game_still_resolves_to_pokemon(self) -> None:
        # Every pre-multi-game caller reaches search_cards through a boundary
        # that ran normalize_game, so junk lands on Pokémon rather than on an
        # empty partition nothing can search.
        self._pokemon_catalog()
        expected = self._ids("charizard", GAME_POKEMON)
        for spelling in ("pokemon", "Pokemon", "pkmn", "", None, "not-a-game"):
            self.assertEqual(self._ids("charizard", spelling), expected, spelling)


class QueryPlanRegressionTests(_CatalogTestCase):
    """Why `+game` and not `game`.

    `idx_cards_game` exists, and SQLite reads an equality constraint as more
    selective than a range. Given `WHERE name >= ? AND name < ? AND game = ?`
    it therefore picks the game index — which, in a catalog where every row is
    'pokemon', means reading the entire table on every retrieval statement.
    The unary plus suppresses index use for that ONE term and leaves the plan
    exactly as it was.
    """

    def setUp(self) -> None:
        super().setUp()
        for i in range(400):
            _insert(self.connection, card_id=f"base1-{i}", game=GAME_POKEMON,
                    name=f"Charizard{i}", set_name="Base", set_id="base1", number=str(i))
        self.connection.commit()

    def _plan(self, sql: str, params: tuple) -> str:
        return " ".join(row[-1] for row in self.connection.execute("EXPLAIN QUERY PLAN " + sql, params))

    def test_a_naive_game_predicate_would_hijack_the_index(self) -> None:
        # Documents the hazard rather than the fix. If this ever stops being
        # true, the `+` can go — but check, do not assume.
        naive = self._plan(
            "SELECT id FROM cards WHERE name >= ? AND name < ? AND game = ? LIMIT ?",
            ("Char", "Chas", GAME_POKEMON, 10),
        )
        self.assertIn("idx_cards_game", naive)

    def test_plus_game_keeps_the_name_index(self) -> None:
        suppressed = self._plan(
            "SELECT id FROM cards WHERE name >= ? AND name < ? AND +game = ? LIMIT ?",
            ("Char", "Chas", GAME_POKEMON, 10),
        )
        self.assertNotIn("idx_cards_game", suppressed)
        self.assertIn("idx_cards_name_set_number", suppressed)

    def test_the_expansion_browse_still_uses_the_set_id_index(self) -> None:
        plan = self._plan(
            "SELECT * FROM cards WHERE set_id = ? AND +game = ? ORDER BY number ASC LIMIT ?",
            ("base1", GAME_POKEMON, 50),
        )
        self.assertIn("idx_cards_set_id", plan)
        self.assertNotIn("idx_cards_game", plan)

    def test_retrieval_sql_never_learned_about_game(self) -> None:
        # The main search filters in Python at the one point rows materialize,
        # precisely so the dozen retrieval statements (several of which read the
        # alias tables, which have no game column) keep their existing plans.
        # If a `game` predicate ever appears in them, this is the alarm.
        statements: list[str] = []
        self.connection.set_trace_callback(statements.append)
        try:
            search_cards(self.connection, "charizard1", game=GAME_POKEMON)
        finally:
            self.connection.set_trace_callback(None)
        retrieval = [
            " ".join(s.lower().split())
            for s in statements
            if " from cards" in s.lower() or "card_name_aliases" in s.lower()
        ]
        self.assertTrue(retrieval)
        for statement in retrieval:
            self.assertNotIn("game = ?", statement, statement)


class ScanPayloadGameReaderTests(unittest.TestCase):
    """One reader for "which game is this scan", shared by index and fallback."""

    def test_reads_both_client_spellings_and_defaults_to_pokemon(self) -> None:
        self.assertEqual(game_for_scan_payload({"game": "onepiece"}), GAME_ONE_PIECE)
        self.assertEqual(game_for_scan_payload({"cardGame": "One Piece"}), GAME_ONE_PIECE)
        # `game` wins when a client sends both.
        self.assertEqual(
            game_for_scan_payload({"game": "lorcana", "cardGame": "onepiece"}), GAME_LORCANA
        )
        for payload in ({}, None, {"game": None}, {"game": "nonsense"}, "not-a-dict"):
            self.assertEqual(game_for_scan_payload(payload), GAME_POKEMON, payload)

    def test_the_visual_matcher_reads_scans_through_the_same_function(self) -> None:
        # Two readers would be free to drift, and the scanner would then match
        # visually against one catalog and text-search another.
        try:
            from raw_visual_matcher import RawVisualMatcher
        except Exception as exc:  # pragma: no cover - host-python dependency fallback
            self.skipTest(f"matcher deps unavailable: {exc}")
        for payload in ({"game": "onepiece"}, {"cardGame": "lorcana"}, {}, None):
            self.assertEqual(
                RawVisualMatcher.game_for_payload(payload),
                game_for_scan_payload(payload),
                payload,
            )


if __name__ == "__main__":
    unittest.main()
