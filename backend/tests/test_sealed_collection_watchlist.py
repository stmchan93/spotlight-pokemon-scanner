"""Sealed product in the collection and the watchlist: a sealed `cards` row
is added as a single condition-less entry, valued at its TCGplayer market
price in the inventory and portfolio totals, and watched like a card."""

from __future__ import annotations

import os
from datetime import date
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, reset_collision_guard_cache  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402
import sync_tcgcsv_prices  # noqa: E402
from sealed_products import sealed_card_id, upsert_sealed_products  # noqa: E402

GROUP = {"groupId": 23821, "name": "SV: Prismatic Evolutions", "abbreviation": "PRE",
         "publishedOn": "2025-01-17T00:00:00"}
ETB = {
    "productId": 593355,
    "name": "Prismatic Evolutions Elite Trainer Box",
    "url": "https://www.tcgplayer.com/product/593355",
    "extendedData": [{"name": "CardText", "value": "x"}],
}
ETB_ID = sealed_card_id(593355)
ETB_PRICE = 139.43


class SealedCollectionWatchlistTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "sealed-owned.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        # Sealed is priced only by the TCGCSV main lane (live on staging).
        env = mock.patch.dict(os.environ, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"})
        env.start()
        self.addCleanup(env.stop)
        reset_collision_guard_cache()
        self.addCleanup(reset_collision_guard_cache)
        for name in ("load_tcgplayer_id_overrides", "load_tcgplayer_id_backfill"):
            patcher = mock.patch.object(sync_tcgcsv_prices, name, return_value={})
            patcher.start()
            self.addCleanup(patcher.stop)
        upsert_sealed_products(connection, [(3, GROUP, ETB)])
        connection.commit()
        sync_tcgcsv_prices.run_tcgcsv_price_sync(
            connection,
            product_price_map={"593355": {"Normal": {
                "productId": 593355, "subTypeName": "Normal", "marketPrice": ETB_PRICE,
                "lowPrice": 120.0, "midPrice": 140.0, "highPrice": 4999.99, "directLowPrice": None,
            }}},
            price_date=date.today().isoformat(),
            last_updated="2026-09-23T20:00:00Z",
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

    def _as_user(self):
        return self.service.request_identity_context(RequestIdentity(user_id="user-a", auth_source="test"))

    def test_sealed_entry_is_added_and_valued_at_market(self) -> None:
        with self._as_user():
            created = self.service.create_deck_entry(
                {"cardID": ETB_ID, "condition": None, "variantName": None, "quantity": 2}
            )
            entries = self.service.deck_entries(limit=10)
            summary = self.service.portfolio_summary_for_owner("user-a")

        self.assertEqual(created["cardID"], ETB_ID)
        self.assertIsNone(created["condition"])
        self.assertEqual(len(entries["entries"]), 1)
        entry = entries["entries"][0]
        self.assertEqual(entry["card"]["id"], ETB_ID)
        self.assertEqual(entry["quantity"], 2)
        self.assertEqual(entry["card"]["pricing"]["market"], ETB_PRICE)
        self.assertAlmostEqual(entries["summary"]["totalValue"], ETB_PRICE * 2, places=2)
        self.assertAlmostEqual(summary["totalValue"], ETB_PRICE * 2, places=2)
        self.assertEqual(summary["cardCount"], 2)

    def test_sealed_entry_counts_in_the_portfolio_dashboard(self) -> None:
        with self._as_user():
            self.service.create_deck_entry({"cardID": ETB_ID, "quantity": 1})
            dashboard = self.service.portfolio_dashboard(range_key="1W", allow_series_compute=True)
        self.assertAlmostEqual(dashboard["inventory"]["summary"]["totalValue"], ETB_PRICE, places=2)
        # The Collection balance reads the chart's current value.
        self.assertAlmostEqual(dashboard["ranges"]["1W"]["history"]["summary"]["currentValue"], ETB_PRICE, places=2)

    def test_sealed_product_can_be_watched_with_its_price(self) -> None:
        with self._as_user():
            favorite = self.service.set_card_favorite(ETB_ID, is_favorite=True)
            detail = self.service.card_detail(ETB_ID)
            watchlist = self.service.card_favorites(limit=10)

        self.assertTrue(favorite["isFavorite"])
        assert detail is not None
        self.assertTrue(detail["isFavorite"])
        self.assertEqual([row["card"]["id"] for row in watchlist["entries"]], [ETB_ID])
        self.assertEqual(watchlist["entries"][0]["card"]["pricing"]["market"], ETB_PRICE)


if __name__ == "__main__":
    unittest.main()
