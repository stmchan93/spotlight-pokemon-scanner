"""Tests for the PokemonPriceTracker join anchor: cards.tcgplayer_id.

PPT keys cards by TCGplayer product id (`tcgPlayerId`). Scrydex stores the same id
in each card's payload at variants[].marketplaces[name=tcgplayer].product_id, and
the two are identical (verified live: swsh7-215 -> 246723 on both). So
`extract_tcgplayer_product_id` + the persisted `cards.tcgplayer_id` column give a
deterministic, language-independent join (works for Japanese, where PPT's
externalCatalogId is null). These tests pin the extraction, that upsert_card
auto-populates it, and that the backfill fills existing rows.
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
    apply_schema,
    backfill_cards_tcgplayer_id,
    connect,
    extract_tcgplayer_product_id,
    upsert_card,
)


def _payload(product_id, *, marketplace_name="tcgplayer"):
    # Mirrors the real Scrydex card payload shape (variants -> marketplaces).
    return {
        "id": "swsh7-215",
        "variants": [
            {
                "name": "normal",
                "marketplaces": (
                    [{"name": marketplace_name, "product_id": product_id, "purchase_url": "https://x"}]
                    if product_id is not None
                    else []
                ),
                "prices": [{"condition": "NM", "type": "raw", "market": 2276.45}],
            }
        ],
    }


class ExtractTcgplayerProductIdTests(unittest.TestCase):
    def test_extracts_product_id_from_marketplaces(self):
        self.assertEqual(extract_tcgplayer_product_id(_payload("246723")), "246723")

    def test_coerces_numeric_product_id_to_string(self):
        self.assertEqual(extract_tcgplayer_product_id(_payload(246723)), "246723")

    def test_none_when_no_tcgplayer_marketplace(self):
        self.assertIsNone(extract_tcgplayer_product_id(_payload("99", marketplace_name="cardmarket")))

    def test_none_when_no_marketplaces(self):
        self.assertIsNone(extract_tcgplayer_product_id(_payload(None)))

    def test_none_on_garbage_input(self):
        self.assertIsNone(extract_tcgplayer_product_id(None))
        self.assertIsNone(extract_tcgplayer_product_id({}))
        self.assertIsNone(extract_tcgplayer_product_id({"variants": "nope"}))

    def test_picks_first_tcgplayer_across_variants(self):
        payload = {
            "variants": [
                {"name": "normal", "marketplaces": []},
                {"name": "holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "555"}]},
            ]
        }
        self.assertEqual(extract_tcgplayer_product_id(payload), "555")


class UpsertCardTcgplayerIdTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "cards.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

    def _insert(self, card_id, payload, *, tcgplayer_id=None):
        upsert_card(
            self.connection,
            card_id=card_id,
            name="Umbreon VMAX",
            set_name="Evolving Skies",
            number="215/203",
            rarity="Secret",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            tcgplayer_id=tcgplayer_id,
            source_payload=payload,
        )
        self.connection.commit()

    def _stored(self, card_id):
        return self.connection.execute(
            "SELECT tcgplayer_id FROM cards WHERE id = ?", (card_id,)
        ).fetchone()[0]

    def test_auto_derives_from_payload(self):
        self._insert("swsh7-215", _payload("246723"))
        self.assertEqual(self._stored("swsh7-215"), "246723")

    def test_explicit_arg_wins_over_payload(self):
        self._insert("swsh7-215", _payload("246723"), tcgplayer_id="111")
        self.assertEqual(self._stored("swsh7-215"), "111")

    def test_null_when_no_product_id(self):
        self._insert("swsh7-214", _payload(None))
        self.assertIsNone(self._stored("swsh7-214"))

    def test_upsert_refreshes_tcgplayer_id(self):
        self._insert("swsh7-215", _payload(None))
        self.assertIsNone(self._stored("swsh7-215"))
        self._insert("swsh7-215", _payload("246723"))  # re-sync now has the id
        self.assertEqual(self._stored("swsh7-215"), "246723")


class BackfillTcgplayerIdTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "cards.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        # Insert cards then NULL out tcgplayer_id to simulate pre-migration rows.
        for cid, pid in (("c1", "100"), ("c2", "200"), ("c3", None)):
            upsert_card(
                self.connection, card_id=cid, name="N", set_name="S", number="1",
                rarity="R", variant="Raw", language="Japanese",
                source_payload=_payload(pid),
            )
        self.connection.execute("UPDATE cards SET tcgplayer_id = NULL")
        self.connection.commit()

    def test_backfill_fills_from_payload(self):
        stats = backfill_cards_tcgplayer_id(self.connection, batch_size=2)
        self.assertEqual(stats["scanned"], 3)
        self.assertEqual(stats["updated"], 2)   # c1, c2
        self.assertEqual(stats["missing"], 1)   # c3 has no tcgplayer product
        got = dict(self.connection.execute("SELECT id, tcgplayer_id FROM cards").fetchall())
        self.assertEqual(got, {"c1": "100", "c2": "200", "c3": None})

    def test_backfill_is_idempotent(self):
        backfill_cards_tcgplayer_id(self.connection)
        again = backfill_cards_tcgplayer_id(self.connection)
        self.assertEqual(again["updated"], 2)  # re-writes same ids harmlessly
        self.assertEqual(self.connection.execute(
            "SELECT tcgplayer_id FROM cards WHERE id = 'c1'").fetchone()[0], "100")


if __name__ == "__main__":
    unittest.main()
