"""A set's sealed products on the set page: which TCGplayer group is which set
(voted at ingest by the group's own cards, else group id, else group name),
served beside — never inside — the card grid, completion and set value."""

from __future__ import annotations

import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    GAME_ONE_PIECE,
    GAME_POKEMON,
    apply_schema,
    card_by_id,
    connect,
    reset_collision_guard_cache,
    upsert_card,
    upsert_expansion,
)
from request_auth import RequestIdentity  # noqa: E402
from sealed_products import (  # noqa: E402
    normalize_group_name,
    sealed_card_id,
    sealed_set_index,
    upsert_sealed_products,
)
import server  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

SSP_GROUP = {"groupId": 23651, "name": "SV08: Surging Sparks", "publishedOn": "2024-11-08T00:00:00"}
# Its cards are not claimed by any of ours: the name has to place its sealed.
PAL_GROUP = {"groupId": 23120, "name": "SV02: Paldea Evolved", "publishedOn": "2023-06-09T00:00:00"}
# A TCGplayer-only set: the expansion's payload names the group.
TCGP_GROUP = {"groupId": 24999, "name": "Trick or Trade BOOster Bundle 2024"}
# Matches no set at all.
MISC_GROUP = {"groupId": 1539, "name": "Miscellaneous Cards & Products"}


def _product(product_id: int, name: str, *fields: str) -> dict:
    return {
        "productId": product_id,
        "name": name,
        "extendedData": [{"name": field, "value": "x"} for field in fields],
    }


SSP_CARD_A = _product(560001, "Pikachu ex - 057/191", "Number", "Rarity")
SSP_CARD_B = _product(560002, "Latias ex - 076/191", "Number", "Rarity")
SSP_ETB = _product(565000, "Surging Sparks Elite Trainer Box")
SSP_BOX = _product(565001, "Surging Sparks Booster Box")
PAL_ETB = _product(500000, "Paldea Evolved Elite Trainer Box")
TCGP_BUNDLE = _product(570000, "Trick or Trade BOOster Bundle 2024")
MISC_TIN = _product(100000, "Pokemon Mystery Tin")


def _tcgplayer_payload(product_id: int) -> dict:
    return {"variants": [{"name": "holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": product_id}]}]}


class ExpansionSealedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "expansion-sealed.sqlite"
        self.connection = connect(self.database_path)
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        reset_collision_guard_cache()
        self.addCleanup(reset_collision_guard_cache)
        # Never reach Scrydex, whatever key the environment holds.
        patcher = mock.patch.object(server, "sync_scrydex_expansions", side_effect=AssertionError("network"))
        patcher.start()
        self.addCleanup(patcher.stop)

        expansions = (
            ("sv8", "Surging Sparks", "2024-11-08", None),
            ("sv2", "Paldea Evolved", "2023-06-09", None),
            ("sv1", "Scarlet & Violet", "2023-03-31", None),
            ("tcgplayer-group-24999", "Trick or Trade BOOster Bundle 2024", "2024-09-01", 24999),
        )
        for set_id, name, date, group_id in expansions:
            upsert_expansion(
                self.connection,
                expansion_id=set_id,
                name=name,
                language="English",
                release_date=date,
                source_provider="scrydex" if group_id is None else "tcgplayer",
                source_payload={"tcgplayerGroupId": group_id} if group_id else {},
                game=GAME_POKEMON,
            )
        for card_id, number, product_id in (("sv8-57", "57/191", 560001), ("sv8-76", "76/191", 560002)):
            upsert_card(
                self.connection, card_id=card_id, name=f"Card {card_id}", set_name="Surging Sparks",
                number=number, rarity="Double Rare", variant="Raw", language="English",
                source_provider="scrydex", set_id="sv8", supertype="Pokémon",
                source_payload=_tcgplayer_payload(product_id),
            )
        upsert_card(
            self.connection, card_id="sv1-1", name="Sprigatito", set_name="Scarlet & Violet",
            number="1/198", rarity="Common", variant="Raw", language="English",
            source_provider="scrydex", set_id="sv1", supertype="Pokémon",
        )
        upsert_sealed_products(
            self.connection,
            [
                (3, SSP_GROUP, SSP_CARD_A), (3, SSP_GROUP, SSP_CARD_B),
                (3, SSP_GROUP, SSP_ETB), (3, SSP_GROUP, SSP_BOX),
                (3, PAL_GROUP, PAL_ETB),
                (3, TCGP_GROUP, TCGP_BUNDLE),
                (3, MISC_GROUP, MISC_TIN),
            ],
        )
        self.connection.commit()
        self.service = SpotlightScanService(self.database_path, BACKEND_ROOT.parent)
        self.addCleanup(self.service.connection.close)

    def _price(self, card_id: str, market: float) -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO card_price_snapshots ("
            " card_id, provider, display_currency_code, default_raw_variant,"
            " default_raw_condition, default_raw_market_price, updated_at"
            ") VALUES (?, 'tcgcsv', 'USD', 'Normal', 'NM', ?, '2026-01-01T00:00:00Z')",
            (card_id, market),
        )
        self.connection.commit()

    def _own(self, owner: str, card_id: str, quantity: int = 1) -> None:
        self.connection.execute(
            "INSERT INTO deck_entries (id, owner_user_id, identity_key, item_kind, card_id,"
            " quantity, added_at, updated_at)"
            " VALUES (?, ?, ?, 'raw', ?, ?, '2026-01-01', '2026-01-01')",
            (uuid.uuid4().hex, owner, uuid.uuid4().hex, card_id, quantity),
        )
        self.connection.commit()

    def _sealed_ids(self, set_id: str, owner: str | None = None) -> list[str]:
        payload = self.service.expansion_sealed_products(set_id, game=GAME_POKEMON, owner_user_id=owner)
        return [row["id"] for row in payload["results"]]

    # --- set -> group matching -------------------------------------------------

    def test_ingest_stamps_the_set_its_group_cards_voted_for(self) -> None:
        etb = card_by_id(self.connection, sealed_card_id(565000))
        self.assertEqual(etb["sourcePayload"]["matchedSetIds"], ["sv8"])
        self.assertIsNone(etb["setID"])  # still never in the card grid
        # No claimed cards in the group: nothing stamped.
        pal = card_by_id(self.connection, sealed_card_id(500000))
        self.assertEqual(pal["sourcePayload"]["matchedSetIds"], [])

    def test_matched_by_vote_by_name_and_by_group_id(self) -> None:
        self.assertCountEqual(
            self._sealed_ids("sv8"), [sealed_card_id(565000), sealed_card_id(565001)]
        )
        self.assertEqual(self._sealed_ids("sv2"), [sealed_card_id(500000)])
        self.assertEqual(self._sealed_ids("tcgplayer-group-24999"), [sealed_card_id(570000)])

    def test_unmatched_set_and_unmatched_group_get_no_sealed(self) -> None:
        self.assertEqual(self._sealed_ids("sv1"), [])
        self.assertEqual(self._sealed_ids("does-not-exist"), [])
        index = sealed_set_index(self.connection, game=GAME_POKEMON)
        everywhere = {card_id for ids in index.values() for card_id in ids}
        self.assertNotIn(sealed_card_id(100000), everywhere)

    def test_scoped_to_the_requested_game(self) -> None:
        payload = self.service.expansion_sealed_products("sv8", game=GAME_ONE_PIECE)
        self.assertEqual(payload["results"], [])

    def test_group_name_normalization(self) -> None:
        self.assertEqual(normalize_group_name("SV08: Surging Sparks"), normalize_group_name("Surging Sparks"))
        self.assertEqual(
            normalize_group_name("SWSH01: Sword & Shield Base Set"), normalize_group_name("Sword & Shield")
        )
        self.assertEqual(normalize_group_name("Base Set"), normalize_group_name("Base"))
        self.assertEqual(normalize_group_name("SM - Burning Shadows"), normalize_group_name("Burning Shadows"))
        self.assertNotEqual(normalize_group_name("Base Set 2"), normalize_group_name("Base"))

    # --- served shape ----------------------------------------------------------

    def test_items_carry_usd_price_and_owner_scoped_quantity(self) -> None:
        self._price(sealed_card_id(565000), 54.99)
        self._own("alice", sealed_card_id(565000), quantity=2)
        self._own("bob", sealed_card_id(565001))
        rows = {
            row["id"]: row
            for row in self.service.expansion_sealed_products("sv8", game=GAME_POKEMON, owner_user_id="alice")[
                "results"
            ]
        }
        etb = rows[sealed_card_id(565000)]
        self.assertAlmostEqual(etb["marketPrice"], 54.99)
        self.assertEqual(etb["pricing"]["currencyCode"], "USD")
        self.assertEqual(etb["ownedQuantity"], 2)
        self.assertEqual(etb["supertype"], "Sealed")
        box = rows[sealed_card_id(565001)]
        self.assertIsNone(box["marketPrice"])
        self.assertEqual(box["ownedQuantity"], 0)  # bob's copy is not alice's

    # --- never part of completion / value -------------------------------------

    def test_sealed_never_counts_toward_completion_or_set_value(self) -> None:
        self._price("sv8-57", 10.0)
        self._price(sealed_card_id(565000), 54.99)
        self._price(sealed_card_id(565001), 250.0)
        self._own("alice", "sv8-57")
        self._own("alice", sealed_card_id(565000))
        expansions = {row["id"]: row for row in self.service.list_expansions(GAME_POKEMON)["expansions"]}
        self.assertEqual(expansions["sv8"]["cardCount"], 2)
        self.assertAlmostEqual(expansions["sv8"]["setValue"], 10.0)
        cards = self.service.search_expansion_cards("sv8", game=GAME_POKEMON, limit=1000)["results"]
        self.assertEqual({row["id"] for row in cards}, {"sv8-57", "sv8-76"})
        with self.service.request_identity_context(RequestIdentity(user_id="alice", auth_source="test")):
            progress = self.service.collection_set_progress(GAME_POKEMON)
        self.assertEqual(progress["sets"], [{"expansionId": "sv8", "ownedCount": 1}])

    # --- Search landing: sealed search scoped to the game ----------------------

    def test_sealed_search_is_game_scoped_and_newest_first(self) -> None:
        upsert_sealed_products(
            self.connection,
            [(68, {"groupId": 3188, "name": "Romance Dawn"}, _product(455000, "Romance Dawn Elite Box"))],
        )
        self.connection.commit()
        pokemon = self.service.search("elite", game=GAME_POKEMON, limit=10, kind="sealed")["results"]
        self.assertEqual(
            [row["id"] for row in pokemon], [sealed_card_id(565000), sealed_card_id(500000)]
        )
        one_piece = self.service.search("elite", game=GAME_ONE_PIECE, limit=10, kind="sealed")["results"]
        self.assertEqual([row["id"] for row in one_piece], [sealed_card_id(455000)])
        # The card search never returns sealed rows.
        cards = self.service.search("surging", game=GAME_POKEMON, limit=10)["results"]
        self.assertTrue(all(row.get("supertype") != "Sealed" for row in cards))


if __name__ == "__main__":
    unittest.main()
