"""Card search by SET NAME ("prismatic evolutions"), and set name + card name
("ascended heroes dragonite").

Regression for two stacked bugs:
- the set-name retrieval tier compared the lowercased query against the
  case-preserved `cards.set_name` under BINARY collation, so it never matched a
  real (capitalized) set name and set-name queries fell through to word hits on
  card names ("Evolution Incense") or to nothing;
- sealed product rows carried card-name aliases, so a set-name query retrieved
  only the set's boxes/tins, which the sealed gate then dropped — zero results.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    GAME_POKEMON,
    apply_schema,
    connect,
    search_cards,
    upsert_card,
)
from sealed_products import sealed_card_id, upsert_sealed_products  # noqa: E402


def _card(connection, card_id, name, set_name, set_id, number, *, language="English"):
    upsert_card(
        connection,
        card_id=card_id,
        name=name,
        set_name=set_name,
        number=number,
        rarity="Rare",
        variant="Raw",
        language=language,
        source_provider="scrydex",
        set_id=set_id,
        supertype="Pokémon",
    )


PRE_GROUP = {"groupId": 23821, "name": "SV: Prismatic Evolutions", "abbreviation": "PRE"}
ASC_GROUP = {"groupId": 24500, "name": "ME: Ascended Heroes", "abbreviation": "ASC"}
SEALED_KINDS = (
    "Elite Trainer Box", "Booster Box", "Booster Bundle", "Booster Pack", "Mini Tin",
    "Binder Collection", "Poster Collection", "Surprise Box", "Tech Sticker Collection",
    "Accessory Pouch Special Collection", "Premium Figure Collection", "Super-Premium Collection",
)


class SetNameSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "set-name-search.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        c = self.connection

        # The two sets under test, with enough filler that a set is bigger than
        # the non-paginated per-phrase cap.
        _card(c, "sv8pt5-161", "Umbreon ex", "Prismatic Evolutions", "sv8pt5", "161/131")
        _card(c, "sv8pt5-74", "Eevee", "Prismatic Evolutions", "sv8pt5", "74/131")
        _card(c, "sv8pt5-156", "Sylveon ex", "Prismatic Evolutions", "sv8pt5", "156/131")
        for i in range(1, 40):
            _card(c, f"sv8pt5-f{i}", f"Filler PRE {i}", "Prismatic Evolutions", "sv8pt5", f"{i}/131")
        _card(c, "me2pt5-150", "Mega Dragonite ex", "Ascended Heroes", "me2pt5", "150/217")
        _card(c, "me2pt5-1", "Pikachu", "Ascended Heroes", "me2pt5", "1/217")
        for i in range(2, 40):
            _card(c, f"me2pt5-f{i}", f"Filler ASC {i}", "Ascended Heroes", "me2pt5", f"{i}/217")

        # Look-alikes: names containing the set words, and Dragonites elsewhere.
        _card(c, "sv1-evo", "Evolution Incense", "Scarlet & Violet", "sv1", "163/198")
        _card(c, "jp-evo", "Evolution Incense", "Triplet Beat", "sv1a_ja", "70/73", language="Japanese")
        _card(c, "xy12-1", "Venusaur EX", "Evolutions", "xy12", "1/108")
        _card(c, "hero-medal", "Heroes' Medal", "Temporal Forces", "sv5", "150/162")
        _card(c, "asc-name", "Ascended Warrior", "Paldea Evolved", "sv2", "200/193")
        _card(c, "fo-4", "Dragonite", "Fossil", "base3", "4/62")
        _card(c, "sm-dragonite", "Dragonite", "Unified Minds", "sm11", "151/236")
        _card(c, "dragonite-v", "Dragonite V", "Evolving Skies", "swsh7", "192/203")

        # Sealed product for both sets — more rows than the per-phrase cap.
        rows = []
        for index, kind in enumerate(SEALED_KINDS):
            rows.append((3, PRE_GROUP, {"productId": 600000 + index, "name": f"Prismatic Evolutions {kind}"}))
            rows.append((3, ASC_GROUP, {"productId": 700000 + index, "name": f"Ascended Heroes {kind}"}))
        upsert_sealed_products(c, rows)
        c.commit()

    def _ids(self, query: str, limit: int = 5, **kwargs) -> list[str]:
        return [card["id"] for card in search_cards(self.connection, query, limit=limit, game=GAME_POKEMON, **kwargs)]

    def _both_modes(self, query: str, limit: int = 5) -> list[list[str]]:
        # Non-paginated (matcher/import callers) and the paginated endpoint mode.
        return [self._ids(query, limit), self._ids(query, limit, pool_ceiling=900)]

    def test_a_set_name_returns_that_sets_cards(self) -> None:
        for ids in self._both_modes("prismatic evolutions"):
            self.assertEqual(len(ids), 5, ids)
            self.assertTrue(all(card_id.startswith("sv8pt5-") for card_id in ids), ids)
        for ids in self._both_modes("ascended heroes"):
            self.assertEqual(len(ids), 5, ids)
            self.assertTrue(all(card_id.startswith("me2pt5-") for card_id in ids), ids)

    def test_set_name_matching_ignores_case(self) -> None:
        ids = self._ids("Prismatic Evolutions", pool_ceiling=900)
        self.assertTrue(ids and all(card_id.startswith("sv8pt5-") for card_id in ids), ids)

    def test_a_partial_set_name_still_finds_the_set(self) -> None:
        ids = self._ids("prismatic evol", pool_ceiling=900)
        self.assertTrue(ids and all(card_id.startswith("sv8pt5-") for card_id in ids), ids)

    def test_the_paginated_set_query_reaches_every_card_in_the_set(self) -> None:
        ids = self._ids("prismatic evolutions", limit=200, pool_ceiling=900)
        self.assertEqual(sum(card_id.startswith("sv8pt5-") for card_id in ids), 42)
        self.assertNotIn("sv1-evo", ids[:42])

    def test_set_name_plus_pokemon_ranks_that_card_first(self) -> None:
        for ids in self._both_modes("ascended heroes dragonite"):
            self.assertEqual(ids[0], "me2pt5-150", ids)
        for ids in self._both_modes("prismatic evolutions umbreon"):
            self.assertEqual(ids[0], "sv8pt5-161", ids)

    def test_pokemon_name_before_set_name_works_too(self) -> None:
        for ids in self._both_modes("dragonite ascended heroes"):
            self.assertEqual(ids[0], "me2pt5-150", ids)

    def test_sealed_never_takes_a_card_slot(self) -> None:
        for query in ("prismatic evolutions", "ascended heroes", "elite trainer box", "prismatic evolutions booster"):
            for ids in self._both_modes(query, limit=50):
                self.assertFalse(any(card_id.startswith("tcgp-sealed-") for card_id in ids), (query, ids))

    def test_sealed_rows_carry_no_name_aliases(self) -> None:
        count = self.connection.execute(
            "SELECT COUNT(*) FROM card_name_aliases WHERE card_id LIKE 'tcgp-sealed-%'"
        ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_apply_schema_purges_sealed_aliases_left_by_older_code(self) -> None:
        self.connection.execute(
            "INSERT INTO card_name_aliases (card_id, alias, normalized_alias, alias_language, alias_kind, created_at, updated_at) "
            "VALUES (?, 'Prismatic Evolutions Booster Box', 'prismatic evolutions booster box', 'en', 'name', 'x', 'x')",
            (sealed_card_id(600001),),
        )
        self.connection.commit()
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        count = self.connection.execute(
            "SELECT COUNT(*) FROM card_name_aliases WHERE card_id LIKE 'tcgp-sealed-%'"
        ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_name_searches_are_unchanged(self) -> None:
        self.assertEqual(self._ids("mega dragonite")[0], "me2pt5-150")
        self.assertIn(self._ids("dragonite")[0], {"fo-4", "sm-dragonite"})
        self.assertEqual(self._ids("evolution incense")[0][-3:], "evo")

    def test_a_set_name_query_does_not_trigger_typo_correction(self) -> None:
        results = search_cards(self.connection, "prismatic evolutions", limit=5, game=GAME_POKEMON)
        self.assertIsNone(getattr(results, "corrected_query", None))


if __name__ == "__main__":
    unittest.main()
