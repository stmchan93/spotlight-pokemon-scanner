"""Sealed products: recognised from TCGCSV rows, stored as `cards` rows the
TCGCSV sync prices unchanged, searchable on their own, and kept out of card
search (and so out of the scanner's text fallback)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    card_by_id,
    connect,
    reset_collision_guard_cache,
    search_cards,
    upsert_card,
)
from market_movers import compute_top_movers  # noqa: E402
from server import _apply_price_history_cells_schema_patch  # noqa: E402
import sync_tcgcsv_prices  # noqa: E402
from sealed_products import (  # noqa: E402
    is_sealed_product,
    sealed_card_id,
    sealed_product_type,
    search_sealed_products,
    upsert_sealed_products,
)

PRE_GROUP = {"groupId": 23821, "name": "SV: Prismatic Evolutions", "abbreviation": "PRE",
             "publishedOn": "2025-01-17T00:00:00"}
JP_GROUP = {"groupId": 24207, "name": "Expansion Pack", "publishedOn": "1996-10-20T00:00:00"}


def _product(product_id: int, name: str, *fields: str) -> dict:
    return {
        "productId": product_id,
        "name": name,
        "url": f"https://www.tcgplayer.com/product/{product_id}",
        "extendedData": [{"name": field, "value": "x"} for field in fields],
    }


ETB = _product(593355, "Prismatic Evolutions Elite Trainer Box", "CardText")
ETB_CASE = _product(598487, "Prismatic Evolutions Elite Trainer Box Case", "CardText")
MINI_TIN = _product(593459, "Prismatic Evolutions Mini Tin [Umbreon]", "CardText")
CODE_CARD = _product(616163, "Code Card - Prismatic Evolutions Elite Trainer Box", "CardText", "Rarity")
CARD = _product(610000, "Umbreon ex", "Number", "Rarity", "HP")
NUMBERLESS_JP_CARD = _product(617476, "Electabuzz", "Attack 1", "CardType", "HP", "Rarity")


class SealedRecognitionTests(unittest.TestCase):
    def test_sealed_is_no_card_fields_and_not_a_code_card(self):
        self.assertTrue(is_sealed_product(ETB))
        self.assertTrue(is_sealed_product(MINI_TIN))
        self.assertTrue(is_sealed_product(_product(711385, "OP-12 Booster Box")))
        self.assertFalse(is_sealed_product(CODE_CARD))
        self.assertFalse(is_sealed_product(CARD))
        # Whole vintage JP sets are cards with no Number: not sealed.
        self.assertFalse(is_sealed_product(NUMBERLESS_JP_CARD))

    def test_product_type_prefers_the_container(self):
        cases = {
            "Prismatic Evolutions Elite Trainer Box": "Elite Trainer Box",
            "Prismatic Evolutions Elite Trainer Box Case": "Case",
            "Prismatic Evolution Booster Bundle Display Case": "Case",
            "Prismatic Evolutions Booster Bundle Display": "Display",
            "Prismatic Evolutions Mini Tin [Umbreon]": "Tin",
            "Prismatic Evolutions 2-Pack Blister [Eevee]": "Blister",
            "Prismatic Evolutions Super-Premium Collection": "Collection",
            "Prismatic Evolutions Sleeved Booster Pack Art Bundle [Set of 4]": "Booster Pack",
            "Extra Booster: One Piece Heroines Edition Vol.2 - Booster Box": "Booster Box",
            "Prismatic Evolutions Surprise Box": "Other",
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(sealed_product_type(name), expected)


class SealedCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "sealed.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        reset_collision_guard_cache()
        self.addCleanup(reset_collision_guard_cache)
        for name in ("load_tcgplayer_id_overrides", "load_tcgplayer_id_backfill"):
            patcher = mock.patch.object(sync_tcgcsv_prices, name, return_value={})
            patcher.start()
            self.addCleanup(patcher.stop)
        # A real card in the same set, so card search has something to find.
        upsert_card(
            self.connection, card_id="sv8pt5-161", name="Umbreon ex",
            set_name="Prismatic Evolutions", number="161/131", rarity="Special Illustration Rare",
            variant="Raw", language="English", source_provider="scrydex",
            supertype="Pokémon",
        )
        self.connection.commit()

    def _ingest(self):
        stats = upsert_sealed_products(
            self.connection,
            [(3, PRE_GROUP, ETB), (3, PRE_GROUP, MINI_TIN), (3, PRE_GROUP, CODE_CARD),
             (3, PRE_GROUP, CARD), (85, JP_GROUP, NUMBERLESS_JP_CARD), (999, PRE_GROUP, ETB_CASE)],
        )
        self.connection.commit()
        return stats

    def test_ingest_stores_sealed_rows_only(self):
        stats = self._ingest()
        self.assertEqual(stats["upserted"], 2)
        self.assertEqual(stats["skipped_not_sealed"], 3)
        self.assertEqual(stats["skipped_unknown_category"], 1)
        etb = card_by_id(self.connection, sealed_card_id(593355))
        self.assertEqual(etb["supertype"], "Sealed")
        self.assertEqual(etb["subtypes"], ["Elite Trainer Box"])
        self.assertEqual(etb["setName"], "SV: Prismatic Evolutions")
        self.assertIsNone(etb["setID"])  # never in a set's card grid
        self.assertEqual(etb["game"], "pokemon")
        self.assertEqual(etb["number"], "")
        self.assertIn("593355_in_1000x1000.jpg", etb["imageURL"])

    def test_the_tcgcsv_sync_prices_sealed_rows_unchanged(self):
        self._ingest()
        stats = sync_tcgcsv_prices.run_tcgcsv_price_sync(
            self.connection,
            product_price_map={"593355": {"Normal": {
                "productId": 593355, "subTypeName": "Normal", "marketPrice": 139.43,
                "lowPrice": 120.0, "midPrice": 140.0, "highPrice": 4999.99, "directLowPrice": None,
            }}},
            price_date="2026-09-23",
            last_updated="2026-09-23T20:00:00Z",
        )
        self.assertEqual(stats["priced"], 1)
        row = self.connection.execute(
            "SELECT main_raw_market_price FROM card_price_snapshots WHERE card_id = ?",
            (sealed_card_id(593355),),
        ).fetchone()
        self.assertEqual(row[0], 139.43)

    def test_the_sync_ingests_sealed_from_its_own_crawl(self):
        def fake_build(categories, group_by_product=None, failed_groups=None, product_rows_out=None):
            product_rows_out.extend([(3, PRE_GROUP, ETB), (3, PRE_GROUP, CARD)])
            return {}, {}

        with mock.patch.object(sync_tcgcsv_prices, "build_price_and_number_maps", side_effect=fake_build):
            stats = sync_tcgcsv_prices.run_tcgcsv_price_sync(
                self.connection, product_price_map=None,
                price_date="2026-09-23", last_updated="2026-09-23T20:00:00Z",
            )
        self.assertEqual(stats["sealed_upserted"], 1)
        self.assertIsNotNone(card_by_id(self.connection, sealed_card_id(593355)))

    def test_sealed_search_and_card_search_stay_apart(self):
        self._ingest()
        sealed = search_sealed_products(self.connection, "prismatic tin", game=None)
        self.assertEqual([row["id"] for row in sealed], [sealed_card_id(593459)])
        everything = search_sealed_products(self.connection, "prismatic", game="pokemon")
        self.assertEqual(len(everything), 2)
        self.assertEqual(search_sealed_products(self.connection, "prismatic", game="onepiece"), [])

        # "umbreon" names both the card and "Mini Tin [Umbreon]"; only the card comes back.
        cards = search_cards(self.connection, "umbreon", limit=20, game="pokemon")
        ids = [row["id"] for row in cards]
        self.assertIn("sv8pt5-161", ids)
        self.assertFalse(any(card_id.startswith("tcgp-sealed-") for card_id in ids))


    def test_sealed_gainers_stay_out_of_top_trends(self):
        from datetime import date, timedelta

        self._ingest()
        today = date(2026, 9, 23)
        # A clean, many-valued climb on the ETB: it would rank if it were a card.
        for index, days_ago in enumerate(range(30, -1, -5)):
            self.connection.execute(
                "INSERT INTO card_price_history_daily (card_id, provider, price_date, "
                "display_currency_code, main_raw_market_price, updated_at) "
                "VALUES (?, 'tcgcsv', ?, 'USD', ?, ?)",
                (sealed_card_id(593355), (today - timedelta(days=days_ago)).isoformat(),
                 100.0 + 20 * index, "2026-09-23T00:00:00Z"),
            )
        self.connection.commit()
        payload = compute_top_movers(self.connection, today=today)
        ids = [item["cardId"] for game in payload["games"] for item in game["items"]]
        self.assertNotIn(sealed_card_id(593355), ids)


    def test_search_kind_sealed_and_default_cards(self):
        from server import SpotlightScanService

        self._ingest()
        database_path = Path(self.tempdir.name) / "sealed.sqlite"
        service = SpotlightScanService(database_path, BACKEND_ROOT.parent)
        self.addCleanup(service.connection.close)

        sealed = service.search("prismatic", game=None, limit=1, kind="sealed")
        self.assertEqual(len(sealed["results"]), 1)
        self.assertTrue(sealed["hasMore"])
        self.assertTrue(sealed["results"][0]["id"].startswith("tcgp-sealed-"))

        cards = service.search("umbreon", game="pokemon", limit=10)
        self.assertEqual([row["id"] for row in cards["results"]], ["sv8pt5-161"])

        # The card page endpoint serves a sealed row without special-casing.
        detail = service.card_detail(sealed_card_id(593355))
        self.assertEqual(detail["card"]["productKind"], "sealed")
        self.assertEqual(detail["card"]["sealedProductType"], "Elite Trainer Box")
        history = service.card_market_history(sealed_card_id(593355), days=30)
        self.assertIsNotNone(history)


if __name__ == "__main__":
    unittest.main()
