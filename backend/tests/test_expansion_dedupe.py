"""TCGplayer-only group sets that duplicate a Scrydex set are served inside it
(expansion_dedupe.py): one row in the sets list, one merged card grid, totals
and progress counted once, sealed attached to the Scrydex set."""

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
    connect,
    reset_collision_guard_cache,
    upsert_card,
    upsert_expansion,
)
from expansion_dedupe import (  # noqa: E402
    build_expansion_pairing,
    is_tcgplayer_group_set_id,
    normalize_set_name,
    pair_expansions,
)
from request_auth import RequestIdentity  # noqa: E402
from sealed_products import sealed_card_id  # noqa: E402
import server  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

OP01 = "onepiece~OP01"
OP01_GROUP = "onepiece~tcgplayer-group-3188"
OP02 = "onepiece~OP02"
# Same name as OP02's set, but Japanese: never paired across languages.
OP02_JP_GROUP = "onepiece~tcgplayer-group-99999"

# Scrydex OP01 cards, and the group's TCGplayer-only cards. tcgplayer-100
# duplicates OP01-001 (same number + name); tcgplayer-101 is new.
OP01_CARDS = [
    ("onepiece~OP01-001", "Roronoa Zoro", "OP01-001"),
    ("onepiece~OP01-002", "Trafalgar Law", "OP01-002"),
    ("onepiece~OP01-010", "Nami", "OP01-010"),
]
GROUP_CARDS = [
    ("onepiece~tcgplayer-100", "Roronoa  Zoro", "OP01-001"),
    ("onepiece~tcgplayer-101", "Monkey.D.Luffy", "OP01-005"),
    ("onepiece~tcgplayer-102", "Nami", "OP01-120"),
]


def _expansion_row(set_id: str, name: str, language: str = "English", provider: str = "scrydex") -> dict:
    return {"id": set_id, "name": name, "language": language, "source_provider": provider}


class PairingRuleTests(unittest.TestCase):
    def test_pairs_group_with_same_name_scrydex_set_only(self) -> None:
        rows = [
            _expansion_row("onepiece~OP01", "Romance Dawn"),
            _expansion_row("onepiece~tcgplayer-group-3188", "Romance  dawn", provider="tcgplayer"),
            _expansion_row("onepiece~OP02", "Paramount War"),
            # Different language: not a twin.
            _expansion_row("onepiece~tcgplayer-group-1", "Paramount War", language="Japanese", provider="tcgplayer"),
            # A group with no Scrydex namesake stays its own set.
            _expansion_row("onepiece~tcgplayer-group-2", "Promotion Cards", provider="tcgplayer"),
        ]
        self.assertEqual(pair_expansions(rows), {"onepiece~tcgplayer-group-3188": "onepiece~OP01"})

    def test_japanese_scrydex_sets_sharing_a_name_are_never_merged(self) -> None:
        rows = [
            _expansion_row("ipb_ja", "イントロパック", language="Japanese"),
            _expansion_row("ips_ja", "イントロパック", language="Japanese"),
            _expansion_row("adv1_ja", "拡張パック", language="Japanese"),
            _expansion_row("base1_ja", "拡張パック", language="Japanese"),
        ]
        self.assertEqual(pair_expansions(rows), {})
        # A group naming two Scrydex sets is ambiguous: unpaired.
        rows.append(_expansion_row("tcgplayer-group-7", "イントロパック", language="Japanese", provider="tcgplayer"))
        self.assertEqual(pair_expansions(rows), {})

    def test_only_tcgplayer_group_ids_pair_and_never_onto_tcgplayer_sets(self) -> None:
        rows = [
            # A tcgplayer-sourced set without the group id prefix is not a group.
            _expansion_row("lorcana~D23", "D23 Promos", provider="tcgplayer"),
            _expansion_row("lorcana~tcgplayer-group-17690", "D23 Promos", provider="tcgplayer"),
        ]
        self.assertEqual(pair_expansions(rows), {})
        rows[0]["source_provider"] = "scrydex"
        self.assertEqual(pair_expansions(rows), {"lorcana~tcgplayer-group-17690": "lorcana~D23"})

    def test_name_normalization(self) -> None:
        self.assertEqual(normalize_set_name("The Azure Sea's Seven"), normalize_set_name("the azure seas seven"))
        self.assertEqual(normalize_set_name("Kalos Starter Set"), normalize_set_name("Kalos  Starter-Set"))
        self.assertNotEqual(normalize_set_name("Base Set 2"), normalize_set_name("Base Set"))
        self.assertTrue(normalize_set_name("イントロパック"))
        self.assertTrue(is_tcgplayer_group_set_id("onepiece~tcgplayer-group-3188"))
        self.assertTrue(is_tcgplayer_group_set_id("tcgplayer-group-1522"))
        self.assertFalse(is_tcgplayer_group_set_id("onepiece~OP01"))


class ExpansionDedupeServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "expansion-dedupe.sqlite"
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

        for set_id, name, language, provider, payload in (
            (OP01, "Romance Dawn", "English", "scrydex", {}),
            (OP01_GROUP, "Romance Dawn", "English", "tcgplayer", {"tcgplayerGroupId": 3188}),
            (OP02, "Paramount War", "English", "scrydex", {}),
            (OP02_JP_GROUP, "Paramount War", "Japanese", "tcgplayer", {"tcgplayerGroupId": 99999}),
        ):
            upsert_expansion(
                self.connection,
                expansion_id=set_id,
                name=name,
                language=language,
                release_date="2022/12/02",
                source_provider=provider,
                source_payload=payload,
                game=GAME_ONE_PIECE,
            )
        for card_id, name, number in OP01_CARDS:
            self._card(card_id, name, number, OP01, "scrydex")
        for card_id, name, number in GROUP_CARDS:
            self._card(card_id, name, number, OP01_GROUP, "tcgplayer")
        self._card("onepiece~OP02-001", "Edward.Newgate", "OP02-001", OP02, "scrydex")
        self._card("onepiece~tcgplayer-200", "Edward.Newgate", "OP02-001", OP02_JP_GROUP, "tcgplayer", "Japanese")
        self.connection.commit()
        self.service = SpotlightScanService(self.database_path, BACKEND_ROOT.parent)
        self.addCleanup(self.service.connection.close)

    def _card(
        self, card_id: str, name: str, number: str, set_id: str, provider: str, language: str = "English"
    ) -> None:
        upsert_card(
            self.connection, card_id=card_id, name=name, set_name="Romance Dawn" if "OP01" in number else "x",
            number=number, rarity="Common", variant="Normal", language=language, game=GAME_ONE_PIECE,
            source_provider=provider, set_id=set_id, supertype="Character",
        )

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

    def _expansions(self) -> dict[str, dict]:
        return {row["id"]: row for row in self.service.list_expansions(GAME_ONE_PIECE)["expansions"]}

    def _card_ids(self, set_id: str, **kwargs) -> list[str]:
        payload = self.service.search_expansion_cards(set_id, game=GAME_ONE_PIECE, limit=1000, **kwargs)
        return [card["id"] for card in payload["results"]]

    def test_pairing_lists_duplicates(self) -> None:
        pairing = build_expansion_pairing(self.connection, game=GAME_ONE_PIECE)
        self.assertEqual(pairing.alias, {OP01_GROUP: OP01})
        self.assertEqual(pairing.duplicate_of, {"onepiece~tcgplayer-100": "onepiece~OP01-001"})

    def test_list_hides_the_paired_group_only(self) -> None:
        expansions = self._expansions()
        self.assertIn(OP01, expansions)
        self.assertNotIn(OP01_GROUP, expansions)
        self.assertIn(OP02, expansions)
        self.assertIn(OP02_JP_GROUP, expansions)  # other language: not a twin

    def test_cards_merged_duplicates_dropped_in_collector_order(self) -> None:
        self.assertEqual(
            self._card_ids(OP01),
            [
                "onepiece~OP01-001",
                "onepiece~OP01-002",
                "onepiece~tcgplayer-101",
                "onepiece~OP01-010",
                "onepiece~tcgplayer-102",
            ],
        )
        limited = self.service.search_expansion_cards(OP01, game=GAME_ONE_PIECE, limit=3)["results"]
        self.assertEqual([card["number"] for card in limited], ["OP01-001", "OP01-002", "OP01-005"])
        # Query mode keeps the name-prefix-first order across both sets.
        self.assertEqual(self._card_ids(OP01, query="Nami"), ["onepiece~OP01-010", "onepiece~tcgplayer-102"])

    def test_direct_group_request_serves_the_merged_set(self) -> None:
        self.assertEqual(self._card_ids(OP01_GROUP), self._card_ids(OP01))

    def test_unpaired_sets_unchanged(self) -> None:
        self.assertEqual(self._card_ids(OP02), ["onepiece~OP02-001"])
        self.assertEqual(self._card_ids(OP02_JP_GROUP), ["onepiece~tcgplayer-200"])

    def test_totals_count_merged_cards_once(self) -> None:
        self._price("onepiece~OP01-001", 10.0)
        self._price("onepiece~tcgplayer-100", 99.0)  # duplicate: not summed
        self._price("onepiece~tcgplayer-101", 2.5)
        expansions = self._expansions()
        self.assertEqual(expansions[OP01]["cardCount"], 5)
        self.assertAlmostEqual(expansions[OP01]["setValue"], 12.5)
        served = self.service.search_expansion_cards(OP01, game=GAME_ONE_PIECE, limit=1000)["results"]
        self.assertEqual(len(served), expansions[OP01]["cardCount"])
        self.assertAlmostEqual(sum(card["marketPrice"] or 0 for card in served), expansions[OP01]["setValue"])

    def test_set_progress_counts_under_canonical_without_double_counting(self) -> None:
        self._own("alice", "onepiece~OP01-001")
        self._own("alice", "onepiece~tcgplayer-100", quantity=2)  # same card as OP01-001
        self._own("alice", "onepiece~tcgplayer-101")
        with self.service.request_identity_context(RequestIdentity(user_id="alice", auth_source="test")):
            progress = self.service.collection_set_progress(GAME_ONE_PIECE)
        self.assertEqual(progress["sets"], [{"expansionId": OP01, "ownedCount": 2}])
        owned = {
            card["id"]: card["ownedQuantity"]
            for card in self.service.search_expansion_cards(
                OP01, game=GAME_ONE_PIECE, limit=1000, owner_user_id="alice"
            )["results"]
        }
        self.assertEqual(owned["onepiece~OP01-001"], 3)
        self.assertEqual(owned["onepiece~tcgplayer-101"], 1)

    def test_sealed_matched_to_the_group_attaches_to_canonical(self) -> None:
        for product_id, payload, set_name in (
            (1, {"matchedSetIds": [OP01_GROUP], "tcgplayerGroupId": 3188}, "Romance Dawn"),
            (2, {"tcgplayerGroupId": 3188}, "Romance Dawn"),
            # Unknown group: placed by name, which the twins now share as one set.
            (3, {"tcgplayerGroupId": 5}, "OP01: Romance Dawn"),
        ):
            upsert_card(
                self.connection, card_id=sealed_card_id(product_id), name=f"Box {product_id}",
                set_name=set_name, number="", rarity="", variant="Normal", language="English",
                game=GAME_ONE_PIECE, source_provider="tcgplayer", supertype="Sealed",
                source_payload=payload,
            )
        self.connection.commit()
        expected = {sealed_card_id(1), sealed_card_id(2), sealed_card_id(3)}
        sealed = self.service.expansion_sealed_products(OP01, game=GAME_ONE_PIECE)["results"]
        self.assertEqual({row["id"] for row in sealed}, expected)
        via_group = self.service.expansion_sealed_products(OP01_GROUP, game=GAME_ONE_PIECE)["results"]
        self.assertEqual({row["id"] for row in via_group}, expected)

    def test_search_reports_the_canonical_set_id_and_keeps_card_ids(self) -> None:
        results = self.service.search("Luffy", game=GAME_ONE_PIECE)["results"]
        luffy = [card for card in results if card["id"] == "onepiece~tcgplayer-101"]
        self.assertEqual(len(luffy), 1)
        self.assertEqual(luffy[0]["setID"], OP01)
        newgate = [card for card in self.service.search("Newgate", game=GAME_ONE_PIECE)["results"]
                   if card["id"] == "onepiece~tcgplayer-200"]
        self.assertEqual([card["setID"] for card in newgate], [OP02_JP_GROUP])

    def test_pokemon_unaffected(self) -> None:
        self.assertEqual(build_expansion_pairing(self.connection, game=GAME_POKEMON).alias, {})


if __name__ == "__main__":
    unittest.main()
