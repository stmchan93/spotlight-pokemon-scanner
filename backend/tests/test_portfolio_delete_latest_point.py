"""Deleting a holding must move the portfolio chart's LATEST point, not just the
headline (staging, 2026-09-29: a sealed box deleted from the Collection left the
chart's last dot — and its scrub tooltip — at the pre-delete value).

The dashboard and per-range history are cached under a data-version token; these
pin that every collection mutation (add, identity-changing edit, delete, bulk
delete, quantity) changes the token and that the recomputed newest point no
longer counts the holding — for sealed products and cards alike, scoped to a
collection and not."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import date
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
ETB = {"productId": 593355, "name": "Prismatic Evolutions Elite Trainer Box",
       "url": "https://www.tcgplayer.com/product/593355",
       "extendedData": [{"name": "CardText", "value": "x"}]}
BOOSTER = {"productId": 593356, "name": "Prismatic Evolutions Booster Bundle",
           "url": "https://www.tcgplayer.com/product/593356",
           "extendedData": [{"name": "CardText", "value": "y"}]}
ETB_ID = sealed_card_id(593355)
BOOSTER_ID = sealed_card_id(593356)
ETB_PRICE = 139.43
BOOSTER_PRICE = 55.10


def _price(product_id: int, market: float) -> dict:
    return {"Normal": {"productId": product_id, "subTypeName": "Normal", "marketPrice": market,
                       "lowPrice": market, "midPrice": market, "highPrice": market, "directLowPrice": None}}


class PortfolioDeleteMovesLatestPointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "delete-latest-point.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        env = mock.patch.dict(os.environ, {
            "RAW_MAIN_PRICE_SOURCE": "tcgcsv",
            "SPOTLIGHT_PAYLOAD_CACHE_DIR": str(Path(self.tempdir.name) / "payload-cache"),
        })
        env.start()
        self.addCleanup(env.stop)
        reset_collision_guard_cache()
        self.addCleanup(reset_collision_guard_cache)
        for name in ("load_tcgplayer_id_overrides", "load_tcgplayer_id_backfill"):
            patcher = mock.patch.object(sync_tcgcsv_prices, name, return_value={})
            patcher.start()
            self.addCleanup(patcher.stop)
        upsert_sealed_products(connection, [(3, GROUP, ETB), (3, GROUP, BOOSTER)])
        connection.commit()
        sync_tcgcsv_prices.run_tcgcsv_price_sync(
            connection,
            product_price_map={"593355": _price(593355, ETB_PRICE), "593356": _price(593356, BOOSTER_PRICE)},
            price_date=date.today().isoformat(),
            last_updated="2026-09-23T20:00:00Z",
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

    def _as_user(self):
        return self.service.request_identity_context(RequestIdentity(user_id="user-a", auth_source="test"))

    def _latest(self, collection_id: str | None = None) -> float:
        dashboard = self.service.portfolio_dashboard(
            range_key="1W", collection_id=collection_id, allow_series_compute=True
        )
        history = dashboard["ranges"]["1W"]["history"]
        if not history["points"]:  # nothing held → no series at all
            return 0.0
        self.assertAlmostEqual(history["points"][-1]["totalValue"], history["summary"]["currentValue"], places=2)
        return float(history["points"][-1]["totalValue"])

    def _history_latest(self, range_label: str) -> float:
        history = self.service.portfolio_history_cached(range_label=range_label)
        return float(history["points"][-1]["totalValue"])

    def test_deleting_a_sealed_entry_drops_it_from_the_cached_latest_point(self) -> None:
        with self._as_user():
            self.service.create_deck_entry({"cardID": BOOSTER_ID, "quantity": 1})
            box = self.service.create_deck_entry({"cardID": ETB_ID, "quantity": 1})
            self.assertAlmostEqual(self._latest(), ETB_PRICE + BOOSTER_PRICE, places=2)
            self.assertAlmostEqual(self._history_latest("1M"), ETB_PRICE + BOOSTER_PRICE, places=2)

            self.service.delete_deck_entry({"deckEntryID": box["deckEntryID"]})

            self.assertAlmostEqual(self._latest(), BOOSTER_PRICE, places=2)
            self.assertAlmostEqual(self._history_latest("1M"), BOOSTER_PRICE, places=2)

    def test_the_staging_repro_edit_then_delete_leaves_only_the_other_holdings(self) -> None:
        # The reported sequence: a quantity edit on the sealed PDP that went
        # through the identity-changing replace (seeded "Normal" variant), then
        # a delete of the row that replace created — scoped to the collection.
        with self._as_user():
            self.service.create_deck_entry({"cardID": BOOSTER_ID, "quantity": 1})
            box = self.service.create_deck_entry({"cardID": ETB_ID, "quantity": 1})
            collection_id = self.service.connection.execute(
                "SELECT collection_id FROM deck_entries WHERE id = ?", (box["deckEntryID"],)
            ).fetchone()[0]
            self.assertAlmostEqual(self._latest(collection_id), ETB_PRICE + BOOSTER_PRICE, places=2)

            replaced = self.service.replace_deck_entry({
                "deckEntryID": box["deckEntryID"], "cardID": ETB_ID, "variantName": "Normal",
                "condition": None, "quantity": 2, "unitPrice": 0,
            })
            self.assertNotEqual(replaced["deckEntryID"], box["deckEntryID"])
            self.assertAlmostEqual(self._latest(collection_id), ETB_PRICE * 2 + BOOSTER_PRICE, places=2)

            self.service.delete_deck_entry({"deckEntryID": replaced["deckEntryID"]})

            self.assertAlmostEqual(self._latest(collection_id), BOOSTER_PRICE, places=2)
            self.assertAlmostEqual(self._latest(), BOOSTER_PRICE, places=2)

    def test_bulk_delete_and_quantity_changes_move_the_latest_point(self) -> None:
        with self._as_user():
            booster = self.service.create_deck_entry({"cardID": BOOSTER_ID, "quantity": 1})
            box = self.service.create_deck_entry({"cardID": ETB_ID, "quantity": 3})
            self.assertAlmostEqual(self._latest(), ETB_PRICE * 3 + BOOSTER_PRICE, places=2)

            self.service.set_deck_entry_quantity({"deckEntryID": box["deckEntryID"], "quantity": 1})
            self.assertAlmostEqual(self._latest(), ETB_PRICE + BOOSTER_PRICE, places=2)

            self.service.delete_deck_entries({"deckEntryIDs": [booster["deckEntryID"]]})
            self.assertAlmostEqual(self._latest(), ETB_PRICE, places=2)

            self.service.set_deck_entry_quantity({"deckEntryID": box["deckEntryID"], "quantity": 0})
            self.assertAlmostEqual(self._latest(), 0.0, places=2)


    def test_same_identity_quantity_edit_moves_the_latest_point(self) -> None:
        # The sealed PDP quantity stepper saves through replace with the SAME
        # identity; its "replace" ledger event was ignored by the replay, so the
        # chart kept the old quantity while the Collection showed the new one.
        with self._as_user():
            box = self.service.create_deck_entry({"cardID": ETB_ID, "quantity": 1})
            self.assertAlmostEqual(self._latest(), ETB_PRICE, places=2)

            replaced = self.service.replace_deck_entry({
                "deckEntryID": box["deckEntryID"], "cardID": ETB_ID, "variantName": None,
                "condition": None, "quantity": 3, "unitPrice": 0,
            })
            self.assertEqual(replaced["deckEntryID"], box["deckEntryID"])
            self.assertAlmostEqual(self._latest(), ETB_PRICE * 3, places=2)

            self.service.replace_deck_entry({
                "deckEntryID": box["deckEntryID"], "cardID": ETB_ID, "variantName": None,
                "condition": None, "quantity": 2, "unitPrice": 0,
            })
            self.assertAlmostEqual(self._latest(), ETB_PRICE * 2, places=2)


if __name__ == "__main__":
    unittest.main()
