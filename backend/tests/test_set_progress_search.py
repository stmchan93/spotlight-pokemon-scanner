"""Search with set progress: sets-list totals, per-user set progress, and the
whole-set card grid (docs/set-progress-search-plan-2026-11-20.md)."""

from __future__ import annotations

import sys
import tempfile
import unittest
import uuid
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    GAME_ONE_PIECE,
    GAME_POKEMON,
    apply_schema,
    collector_number_sort_key,
    connect,
    rarity_bucket,
    upsert_catalog_card,
    upsert_expansion,
)
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService  # noqa: E402


def catalog_card(*, card_id: str, number: str, set_id: str, rarity: str = "Common") -> dict:
    return {
        "id": card_id,
        "name": f"Card {card_id}",
        "set_name": f"Set {set_id}",
        "number": number,
        "rarity": rarity,
        "variant": "Raw",
        "language": "English",
        "source": "scrydex",
        "source_record_id": card_id,
        "set_id": set_id,
        "set_series": "Series",
        "set_ptcgo_code": set_id.upper(),
        "set_release_date": "2025-01-01",
        "supertype": "Pokémon",
        "subtypes": [],
        "types": [],
        "artist": "Artist",
        "regulation_mark": None,
        "national_pokedex_numbers": [],
        "reference_image_url": f"https://images.example/{card_id}.png",
        "reference_image_small_url": f"https://images.example/{card_id}-small.png",
        "source_payload": {"name": card_id},
        "tcgplayer": {},
        "cardmarket": {},
    }


# "set1" prints 3 cards (x/3) and has one secret rare numbered 4/3.
SET1 = [
    ("set1-10", "10/3"),
    ("set1-2", "2/3"),
    ("set1-1", "1/3"),
    ("set1-secret", "100/3"),
]
SET2 = [("set2-1", "1/50"), ("set2-2", "2/50")]


class SetProgressSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "set-progress.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        for set_id, date in (("set1", "2025-02-01"), ("set2", "2025-01-01"), ("set3", "2024-01-01")):
            upsert_expansion(
                self.connection,
                expansion_id=set_id,
                name=f"Set {set_id}",
                release_date=date,
                source_provider="scrydex",
                game=GAME_POKEMON,
            )
        for card_id, number in SET1:
            rarity = "Hyper Rare" if card_id == "set1-secret" else "Common"
            upsert_catalog_card(
                self.connection,
                catalog_card(card_id=card_id, number=number, set_id="set1", rarity=rarity),
                REPO_ROOT,
                "2026-01-01T00:00:00Z",
                refresh_embeddings=False,
            )
        for card_id, number in SET2:
            upsert_catalog_card(
                self.connection,
                catalog_card(card_id=card_id, number=number, set_id="set2"),
                REPO_ROOT,
                "2026-01-01T00:00:00Z",
                refresh_embeddings=False,
            )
        self.connection.commit()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def _price(self, card_id: str, market: float, currency: str = "USD") -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO card_price_snapshots ("
            " card_id, provider, display_currency_code, default_raw_variant,"
            " default_raw_condition, default_raw_market_price, updated_at"
            ") VALUES (?, 'scrydex', ?, 'Normal', 'NM', ?, '2026-01-01T00:00:00Z')",
            (card_id, currency, market),
        )
        self.connection.commit()

    def _own(self, owner: str, card_id: str, *, quantity: int = 1, **fields: object) -> None:
        self.connection.execute(
            "INSERT INTO deck_entries (id, owner_user_id, identity_key, item_kind, card_id,"
            " grader, grade, variant_name, condition, quantity, added_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01', '2026-01-01')",
            (
                uuid.uuid4().hex,
                owner,
                uuid.uuid4().hex,
                "graded" if fields.get("grader") else "raw",
                card_id,
                fields.get("grader"),
                fields.get("grade"),
                fields.get("variant_name"),
                fields.get("condition"),
                quantity,
            ),
        )
        self.connection.commit()

    def _expansions(self) -> dict[str, dict]:
        return {row["id"]: row for row in self.service.list_expansions(GAME_POKEMON)["expansions"]}

    def _progress(self, owner: str, game: str = GAME_POKEMON) -> dict:
        with self.service.request_identity_context(RequestIdentity(user_id=owner, auth_source="test")):
            return self.service.collection_set_progress(game)

    # --- /expansions totals ---------------------------------------------------

    def test_card_count_includes_secret_rares_and_matches_cards_endpoint(self) -> None:
        expansions = self._expansions()
        self.assertEqual(expansions["set1"]["cardCount"], 4)
        self.assertEqual(expansions["set2"]["cardCount"], 2)
        self.assertEqual(expansions["set3"]["cardCount"], 0)
        served = self.service.search_expansion_cards("set1", game=GAME_POKEMON, limit=1000)["results"]
        self.assertEqual(len(served), expansions["set1"]["cardCount"])

    def test_set_value_sums_served_usd_prices_and_skips_unpriced_and_jpy(self) -> None:
        self._price("set1-1", 1.25)
        self._price("set1-secret", 40.5)
        # No FX rate stored, so the served summary stays JPY: must not be summed.
        self._price("set1-2", 5000.0, currency="JPY")
        expansions = self._expansions()
        self.assertAlmostEqual(expansions["set1"]["setValue"], 41.75)
        self.assertIsNone(expansions["set2"]["setValue"])
        self.assertIsNone(expansions["set3"]["setValue"])

        # Equal to summing the per-card served summary (what the card page shows).
        context = self.service._raw_pricing_context()
        served_total = 0.0
        for card_id, _ in SET1:
            summary = self.service._display_pricing_summary_for_context(card_id, pricing_context=context)
            if summary and summary.get("currencyCode") == "USD" and summary.get("market"):
                served_total += summary["market"]
        self.assertAlmostEqual(expansions["set1"]["setValue"], round(served_total, 2))

    def test_set_totals_are_cached_until_the_pricing_version_moves(self) -> None:
        self._price("set1-1", 1.0)
        self.assertAlmostEqual(self._expansions()["set1"]["setValue"], 1.0)
        self._price("set1-1", 9.0)
        # Same version token: still the cached value.
        self.assertAlmostEqual(self._expansions()["set1"]["setValue"], 1.0)
        self.service._expansion_totals_cache.clear()
        self.assertAlmostEqual(self._expansions()["set1"]["setValue"], 9.0)

    # --- /collection/set-progress -------------------------------------------

    def test_set_progress_counts_distinct_cards_across_printings_conditions_graded(self) -> None:
        self._own("alice", "set1-1", variant_name="Normal", condition="NM")
        self._own("alice", "set1-1", variant_name="Reverse Holofoil", condition="LP")
        self._own("alice", "set1-1", grader="PSA", grade="10")
        self._own("alice", "set1-secret", grader="PSA", grade="9")
        self._own("alice", "set2-1", quantity=0)  # sold out: not owned
        self._own("bob", "set1-2")
        self._own("bob", "set2-2")

        progress = self._progress("alice")
        self.assertEqual(progress["game"], GAME_POKEMON)
        self.assertEqual(progress["sets"], [{"expansionId": "set1", "ownedCount": 2}])

        bob = {row["expansionId"]: row["ownedCount"] for row in self._progress("bob")["sets"]}
        self.assertEqual(bob, {"set1": 1, "set2": 1})
        self.assertEqual(self._progress("carol")["sets"], [])

    def test_set_progress_is_scoped_to_the_requested_game(self) -> None:
        self._own("alice", "set1-1")
        self.assertEqual(self._progress("alice", GAME_ONE_PIECE)["sets"], [])

    def test_set_progress_ids_match_expansion_ids(self) -> None:
        self._own("alice", "set2-2")
        ids = {row["expansionId"] for row in self._progress("alice")["sets"]}
        self.assertTrue(ids <= set(self._expansions()))

    # --- /expansions/<id>/cards ----------------------------------------------

    def test_whole_set_in_collector_number_order(self) -> None:
        results = self.service.search_expansion_cards("set1", game=GAME_POKEMON, limit=1000)["results"]
        self.assertEqual([card["number"] for card in results], ["1/3", "2/3", "10/3", "100/3"])
        limited = self.service.search_expansion_cards("set1", game=GAME_POKEMON, limit=2)["results"]
        self.assertEqual([card["number"] for card in limited], ["1/3", "2/3"])

    def test_collector_number_sort_key(self) -> None:
        numbers = ["TG02/TG30", "100/3", "10", "2", "TG01/TG30", "OP01-010", "OP01-002", "", "SWSH050"]
        ordered = sorted(numbers, key=collector_number_sort_key)
        self.assertEqual(ordered[:3], ["2", "10", "100/3"])
        self.assertLess(ordered.index("OP01-002"), ordered.index("OP01-010"))
        self.assertLess(ordered.index("TG01/TG30"), ordered.index("TG02/TG30"))
        self.assertEqual(ordered[-1], "")

    def test_items_carry_rarity_bucket_and_owner_scoped_owned_quantity(self) -> None:
        self._own("alice", "set1-1", quantity=2, variant_name="Normal")
        self._own("alice", "set1-1", grader="PSA", grade="10")
        self._own("bob", "set1-2", quantity=5)
        results = {
            card["id"]: card
            for card in self.service.search_expansion_cards(
                "set1", game=GAME_POKEMON, limit=1000, owner_user_id="alice"
            )["results"]
        }
        self.assertEqual(results["set1-1"]["ownedQuantity"], 3)
        self.assertEqual(results["set1-2"]["ownedQuantity"], 0)
        self.assertEqual(results["set1-secret"]["rarityBucket"], "secret")

        guest = self.service.search_expansion_cards("set1", game=GAME_POKEMON, limit=1000)["results"]
        self.assertTrue(all(card["ownedQuantity"] == 0 for card in guest))

    def test_items_carry_served_usd_market_price_summing_to_set_value(self) -> None:
        self._price("set1-1", 1.25)
        self._price("set1-secret", 40.5)
        self._price("set1-2", 5000.0, currency="JPY")  # no FX rate: null, never yen
        results = {
            card["id"]: card
            for card in self.service.search_expansion_cards("set1", game=GAME_POKEMON, limit=1000)["results"]
        }
        context = self.service._raw_pricing_context()
        for card_id in ("set1-1", "set1-secret"):
            served = self.service._display_pricing_summary_for_context(card_id, pricing_context=context)
            self.assertEqual(served["currencyCode"], "USD")
            self.assertAlmostEqual(results[card_id]["marketPrice"], served["market"])
        self.assertIsNone(results["set1-2"]["marketPrice"])
        self.assertIsNone(results["set1-10"]["marketPrice"])
        priced_sum = sum(card["marketPrice"] or 0 for card in results.values())
        self.assertAlmostEqual(priced_sum, self._expansions()["set1"]["setValue"], places=2)

    def test_hyper_rare_buckets_as_secret(self) -> None:
        self.assertEqual(rarity_bucket("Hyper Rare", GAME_POKEMON), "secret")


if __name__ == "__main__":
    unittest.main()
