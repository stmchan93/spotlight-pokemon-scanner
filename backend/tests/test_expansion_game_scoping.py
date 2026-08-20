"""`/expansions` serves ONE game, and Pokémon's set list did not move.

`expansions` was the last catalog table with no `game` column, so a One Piece
lane browsing sets got 449 Pokémon expansions. Two separate bugs, both fixed
here and both tested:

  1. THE READ was global. Every caller listed the whole table.
  2. THE SYNC GUARD was global. `expansion_count() == 0` is false the moment
     Pokémon syncs, so `?game=onepiece` against a populated Pokémon table
     skipped its own sync and was then served Pokémon's rows.

The hard rule is the same one the rest of the branch runs on: a client that
sends no `game` must get exactly today's Pokémon list, in exactly today's order.
`ExpansionListIsUnmovedTests` is that claim, and `QueryPlanRegressionTests` is
why the column is deliberately NOT indexed — an index here flips the listing's
plan onto a different sort, which is the one thing that could reorder Pokémon.
"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    GAME_GUNDAM,
    GAME_ONE_PIECE,
    GAME_POKEMON,
    _apply_additive_runtime_migrations,
    apply_schema,
    connect,
    expansion_count,
    list_local_expansions,
    list_persisted_expansions,
    upsert_card,
    upsert_expansion,
)
from scrydex_adapter import sync_scrydex_expansions  # noqa: E402
from server import SpotlightScanService  # noqa: E402

# The `expansions` table exactly as it shipped, before the column existed. Used
# to prove the migration backfills a REAL pre-existing table rather than only
# creating a correct new one.
PRE_MIGRATION_EXPANSIONS_DDL = """
CREATE TABLE expansions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    series TEXT,
    code TEXT,
    language TEXT,
    release_date TEXT,
    logo_url TEXT,
    symbol_url TEXT,
    image_url TEXT,
    source_provider TEXT,
    source_payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


class _ExpansionTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "expansions.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        self.addCleanup(self.connection.close)

    def _pokemon_sets(self) -> None:
        """Three Pokémon sets, one of them sharing a release date with a One
        Piece set added later — a tie is where an order change would show."""
        upsert_expansion(self.connection, expansion_id="sv1", name="Scarlet & Violet",
                         release_date="2023-03-31", game=GAME_POKEMON)
        upsert_expansion(self.connection, expansion_id="obf", name="Obsidian Flames",
                         release_date="2023-08-11", game=GAME_POKEMON)
        upsert_expansion(self.connection, expansion_id="base1", name="Base Set",
                         release_date="1999-01-09", game=GAME_POKEMON)
        self.connection.commit()

    def _one_piece_sets(self) -> None:
        upsert_expansion(self.connection, expansion_id="onepiece-OP01", name="Romance Dawn",
                         release_date="2022-12-02", game=GAME_ONE_PIECE)
        # Same release date as Obsidian Flames on purpose.
        upsert_expansion(self.connection, expansion_id="onepiece-OP05", name="Awakening of the New Era",
                         release_date="2023-08-11", game=GAME_ONE_PIECE)
        self.connection.commit()


class MigrationTests(unittest.TestCase):
    """Additive and defaulted: an existing table backfills in place."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.addCleanup(self.connection.close)

    def test_adds_the_column_to_a_live_table_and_backfills_every_row_to_pokemon(self) -> None:
        self.connection.execute(PRE_MIGRATION_EXPANSIONS_DDL)
        self.connection.executemany(
            "INSERT INTO expansions (id, name, created_at, updated_at) VALUES (?, ?, 't', 't')",
            [("sv1", "Scarlet & Violet"), ("obf", "Obsidian Flames")],
        )
        self.connection.commit()
        self.assertNotIn("game", _columns(self.connection, "expansions"))

        _apply_additive_runtime_migrations(self.connection)

        self.assertIn("game", _columns(self.connection, "expansions"))
        # No rewrite pass runs — the DEFAULT is what makes every pre-existing
        # row Pokémon, which is why the migration is safe on a 449-row live table.
        self.assertEqual(
            [(row["id"], row["game"]) for row in self.connection.execute(
                "SELECT id, game FROM expansions ORDER BY id")],
            [("obf", "pokemon"), ("sv1", "pokemon")],
        )

    def test_is_idempotent(self) -> None:
        self.connection.execute(PRE_MIGRATION_EXPANSIONS_DDL)
        _apply_additive_runtime_migrations(self.connection)
        _apply_additive_runtime_migrations(self.connection)  # must not raise "duplicate column"
        self.assertIn("game", _columns(self.connection, "expansions"))

    def test_the_column_is_not_indexed(self) -> None:
        # Stated as a decision, not left to inspection — see QueryPlanRegressionTests.
        self.connection.execute(PRE_MIGRATION_EXPANSIONS_DDL)
        _apply_additive_runtime_migrations(self.connection)
        indexes = [
            str(row[1])
            for row in self.connection.execute("PRAGMA index_list(expansions)")
        ]
        self.assertNotIn("idx_expansions_game", indexes)


class PerGameListingTests(_ExpansionTestCase):
    def test_each_game_gets_only_its_own_sets(self) -> None:
        self._pokemon_sets()
        self._one_piece_sets()

        pokemon = [row["id"] for row in list_persisted_expansions(self.connection, game=GAME_POKEMON)]
        one_piece = [row["id"] for row in list_persisted_expansions(self.connection, game=GAME_ONE_PIECE)]

        self.assertEqual(sorted(pokemon), ["base1", "obf", "sv1"])
        self.assertEqual(sorted(one_piece), ["onepiece-OP01", "onepiece-OP05"])

    def test_an_absent_or_unknown_game_lists_pokemon(self) -> None:
        # Absent means Pokémon everywhere. A client that predates multi-game
        # sends nothing and must not land on an empty partition.
        self._pokemon_sets()
        self._one_piece_sets()
        expected = list_persisted_expansions(self.connection, game=GAME_POKEMON)
        for spelling in (None, "", "   ", "Pokemon", "not-a-game"):
            self.assertEqual(list_persisted_expansions(self.connection, game=spelling), expected, spelling)

    def test_a_game_with_no_sets_gets_an_empty_list_not_pokemons(self) -> None:
        # The bug in one line: browsing sets in a Gundam lane used to show 449
        # Pokémon expansions.
        self._pokemon_sets()
        self.assertEqual(list_persisted_expansions(self.connection, game=GAME_GUNDAM), [])

    def test_expansion_count_is_per_game(self) -> None:
        self._pokemon_sets()
        self._one_piece_sets()
        self.assertEqual(expansion_count(self.connection, game=GAME_POKEMON), 3)
        self.assertEqual(expansion_count(self.connection, game=GAME_ONE_PIECE), 2)
        self.assertEqual(expansion_count(self.connection, game=GAME_GUNDAM), 0)
        self.assertEqual(expansion_count(self.connection), 3)  # absent -> Pokémon

    def test_the_cards_table_fallback_is_per_game_too(self) -> None:
        # With no persisted expansions the browser derives sets from `cards`.
        # That table has always had a `game` column, so the fallback must use it
        # or it reintroduces the same mixing one layer down.
        upsert_card(self.connection, card_id="obf-4", game=GAME_POKEMON, name="Charizard ex",
                    set_name="Obsidian Flames", number="125", rarity="Rare", variant="Raw",
                    language="English", source_provider="scrydex", source_record_id="obf-4",
                    set_id="obf", set_release_date="2023-08-11")
        upsert_card(self.connection, card_id="onepiece-OP01-001", game=GAME_ONE_PIECE, name="Roronoa Zoro",
                    set_name="Romance Dawn", number="001", rarity="Leader", variant="Raw",
                    language="English", source_provider="scrydex", source_record_id="OP01-001",
                    set_id="onepiece-OP01", set_release_date="2022-12-02")
        self.connection.commit()

        self.assertEqual([row["id"] for row in list_local_expansions(self.connection, game=GAME_POKEMON)], ["obf"])
        self.assertEqual(
            [row["id"] for row in list_local_expansions(self.connection, game=GAME_ONE_PIECE)],
            ["onepiece-OP01"],
        )

    def test_the_sync_stamps_the_game_it_was_asked_for(self) -> None:
        # `sync_scrydex_expansions` takes `game` with no default precisely
        # because a hardcoded Pokémon once made a One Piece sync pull 449
        # Pokémon expansions. Stamping closes the other half: rows it writes
        # have to be findable under the game that fetched them.
        with patch(
            "scrydex_adapter.fetch_scrydex_expansions_raw",
            return_value=[{"id": "OP01", "name": "Romance Dawn", "release_date": "2022/12/02"}],
        ):
            written = sync_scrydex_expansions(self.connection, game=GAME_ONE_PIECE)

        self.assertEqual(written, 1)
        self.assertEqual(expansion_count(self.connection, game=GAME_ONE_PIECE), 1)
        self.assertEqual(expansion_count(self.connection, game=GAME_POKEMON), 0)

    def test_upsert_defaults_to_pokemon_for_callers_that_pass_no_game(self) -> None:
        upsert_expansion(self.connection, expansion_id="sv1", name="Scarlet & Violet")
        self.connection.commit()
        self.assertEqual(expansion_count(self.connection, game=GAME_POKEMON), 1)


class ExpansionListIsUnmovedTests(_ExpansionTestCase):
    """The branch's hard rule: loading a second game changes nothing for Pokémon.

    Not "returns the same set" — the same LIST, in the same ORDER, field for
    field. Ordering is the part a shared table disturbs quietly, so the fixture
    deliberately gives a One Piece set the same release date as a Pokémon set:
    a tie under `ORDER BY release_date DESC NULLS LAST, name ASC` is where an
    interloper would insert itself.
    """

    def test_pokemons_list_is_identical_before_and_after_one_piece_loads(self) -> None:
        self._pokemon_sets()
        before = list_persisted_expansions(self.connection, game=GAME_POKEMON)

        self._one_piece_sets()
        after = list_persisted_expansions(self.connection, game=GAME_POKEMON)

        self.assertEqual(after, before)
        self.assertEqual([row["id"] for row in after], ["obf", "sv1", "base1"])

    def test_the_endpoint_response_is_identical_before_and_after(self) -> None:
        # Through the service, not just the query — the guard, the fallback and
        # the read all sit between a client and this list.
        self._pokemon_sets()
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        with patch("server.sync_scrydex_expansions") as sync:
            before = service.list_expansions()
            self._one_piece_sets()
            after = service.list_expansions()
        sync.assert_not_called()
        self.assertEqual(after, before)

    def test_a_game_with_no_rows_does_not_disturb_pokemon_when_its_sync_fails(self) -> None:
        # The empty-game path runs a sync and then a fallback read. Neither may
        # leak Pokémon rows into the Gundam response, and neither may change
        # Pokémon's own.
        self._pokemon_sets()
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        with patch("server.sync_scrydex_expansions", side_effect=RuntimeError("endpoint down")):
            gundam = service.list_expansions(game=GAME_GUNDAM)
        self.assertEqual(gundam["expansions"], [])

        with patch("server.sync_scrydex_expansions") as sync:
            self.assertEqual(
                [row["id"] for row in service.list_expansions()["expansions"]],
                ["obf", "sv1", "base1"],
            )
        sync.assert_not_called()


class SyncGuardTests(_ExpansionTestCase):
    """`expansion_count() == 0` had to become per game."""

    def test_a_populated_pokemon_table_no_longer_blocks_another_games_first_sync(self) -> None:
        self._pokemon_sets()
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        def fake_sync(connection, *, game):
            upsert_expansion(connection, expansion_id="onepiece-OP01", name="Romance Dawn",
                             release_date="2022-12-02", game=game)
            connection.commit()
            return 1

        with patch("server.sync_scrydex_expansions", side_effect=fake_sync) as sync:
            payload = service.list_expansions(game=GAME_ONE_PIECE)

        sync.assert_called_once()
        self.assertEqual(sync.call_args.kwargs["game"], GAME_ONE_PIECE)
        self.assertEqual([row["id"] for row in payload["expansions"]], ["onepiece-OP01"])

    def test_pokemon_still_does_not_re_sync_when_it_already_has_sets(self) -> None:
        self._pokemon_sets()
        self._one_piece_sets()
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        with patch("server.sync_scrydex_expansions") as sync:
            service.list_expansions(game=GAME_POKEMON)
        sync.assert_not_called()

    def test_the_sync_is_asked_for_the_normalized_game_not_the_raw_string(self) -> None:
        # normalize_game runs at the boundary so the fetch, the stamp and the
        # read all agree on one spelling — "One Piece" from a client must not
        # sync under a game id nothing later reads.
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        with patch("server.sync_scrydex_expansions", return_value=0) as sync:
            service.list_expansions(game="One Piece")
        self.assertEqual(sync.call_args.kwargs["game"], GAME_ONE_PIECE)


class QueryPlanRegressionTests(_ExpansionTestCase):
    """Why there is no `idx_expansions_game`, and why the predicate is `+game`.

    Measured on a 449-row table (the live Pokémon count): adding the index flips
    the listing from `SCAN … USING INDEX idx_expansions_release_date` plus a
    temp b-tree for the LAST ORDER BY term, to `SEARCH … USING INDEX
    idx_expansions_game` plus a temp b-tree for the WHOLE ORDER BY — a different
    sort, so rows tied on (release_date, name) could come back in a different
    order. There is nothing to win either way: `game` has five values over a few
    hundred rows and the listing sorts everything regardless.
    """

    LISTING_SQL = (
        "SELECT id, name, series, code, release_date, logo_url, symbol_url, image_url "
        "FROM expansions {where} ORDER BY release_date DESC NULLS LAST, name ASC"
    )

    def setUp(self) -> None:
        super().setUp()
        for index in range(449):
            upsert_expansion(self.connection, expansion_id=f"p{index}", name=f"Set {index}",
                             release_date=f"20{10 + index % 15}-01-01", game=GAME_POKEMON)
        self.connection.commit()

    def _plan(self, where: str, params: tuple) -> str:
        sql = self.LISTING_SQL.format(where=where)
        return " ".join(row[-1] for row in self.connection.execute("EXPLAIN QUERY PLAN " + sql, params))

    def test_scoping_by_game_leaves_the_shipped_plan_untouched(self) -> None:
        self.assertEqual(self._plan("", ()), self._plan("WHERE +game = ?", (GAME_POKEMON,)))

    def test_an_index_on_game_would_change_the_sort(self) -> None:
        # Documents the hazard rather than the fix. If this stops being true the
        # index could be added — but check, do not assume.
        self.connection.execute("CREATE INDEX idx_expansions_game ON expansions(game)")
        self.addCleanup(lambda: self.connection.execute("DROP INDEX IF EXISTS idx_expansions_game"))

        naive = self._plan("WHERE game = ?", (GAME_POKEMON,))
        self.assertIn("idx_expansions_game", naive)
        self.assertIn("USE TEMP B-TREE FOR ORDER BY", naive)

        # `+game` keeps the shipped plan even with the index present.
        suppressed = self._plan("WHERE +game = ?", (GAME_POKEMON,))
        self.assertNotIn("idx_expansions_game", suppressed)
        self.assertEqual(suppressed, self._plan("", ()))


if __name__ == "__main__":
    unittest.main()
