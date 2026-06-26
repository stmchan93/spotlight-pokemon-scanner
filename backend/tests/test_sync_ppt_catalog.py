"""End-to-end: sync_ppt_catalog joins a PPT card to our catalog by tcgplayer_id and
writes snapshot + daily + cell rows under provider 'ppt', readable by the resolvers.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    resolve_graded_entry_from_cells,
    upsert_card,
)
from server import _apply_price_history_cells_schema_patch  # noqa: E402
from sync_ppt_catalog import sync_ppt_cards, upsert_ppt_card_pricing  # noqa: E402

PPT_MOONBREON = {
    "tcgPlayerId": "246723",
    "externalCatalogId": "swsh7-215",
    "prices": {"market": 2276.45, "low": 1999.0, "primaryPrinting": "Holofoil"},
    "variants": {"Holofoil": {"Near Mint": {"price": 2276.45}}},
    "ebay": {"salesByGrade": {
        "psa10": {"medianPrice": 4524.88, "minPrice": 4100.0, "maxPrice": 4900.0, "count": 37},
        "psa9": {"medianPrice": 2305.0, "count": 12},
    }},
}


class SyncPptCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "ppt.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        # Our catalog card carrying the TCGplayer product id PPT joins on.
        upsert_card(
            self.connection, card_id="swsh7-215", name="Umbreon VMAX",
            set_name="Evolving Skies", number="215/203", rarity="Secret",
            variant="Raw", language="English", source_provider="scrydex",
            tcgplayer_id="246723",
        )
        self.connection.commit()
        self._prev_source = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"
        self.addCleanup(self._restore)

    def _restore(self):
        if self._prev_source is None:
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
        else:
            os.environ["PRICE_HISTORY_SOURCE"] = self._prev_source

    def test_sync_writes_snapshot_daily_and_cells_under_ppt(self):
        stats = sync_ppt_cards(self.connection, [PPT_MOONBREON], price_date="2026-06-25")
        self.assertEqual(stats["matched"], 1)
        self.assertEqual(stats["seen"], 1)

        # Snapshot row written under provider 'ppt' with the right graded blob.
        snap = self.connection.execute(
            "SELECT provider, graded_contexts_json, raw_contexts_json FROM card_price_snapshots WHERE card_id='swsh7-215'"
        ).fetchone()
        self.assertIsNotNone(snap)
        self.assertEqual(snap[0], "ppt")
        graded = json.loads(snap[1])["graders"]
        self.assertEqual(graded["PSA"]["10"][0]["market"], 4524.88)

        # Daily row written for the date.
        daily = self.connection.execute(
            "SELECT COUNT(*) FROM card_price_history_daily WHERE card_id='swsh7-215' AND provider='ppt' AND price_date='2026-06-25'"
        ).fetchone()[0]
        self.assertEqual(daily, 1)

        # Cells auto-decomposed; resolver surfaces the PSA 10 price.
        cell_rows = self.connection.execute(
            "SELECT lane, grader, grade, variant_key, condition, is_perfect, is_signed, is_error, market "
            "FROM card_price_history_cell WHERE card_id='swsh7-215' AND price_date='2026-06-25'"
        ).fetchall()
        cols = ("lane", "grader", "grade", "variant_key", "condition", "is_perfect", "is_signed", "is_error", "market")
        rows = [dict(zip(cols, r)) for r in cell_rows]
        chosen = resolve_graded_entry_from_cells(rows, grader="PSA", grade="10", variant=None)
        self.assertIsNotNone(chosen)
        self.assertEqual(chosen["market"], 4524.88)

    def test_unmatched_when_no_local_card(self):
        result = upsert_ppt_card_pricing(
            self.connection, {"tcgPlayerId": "999999", "prices": {"market": 5.0}}, price_date="2026-06-25"
        )
        self.assertEqual(result["matched"], 0)
        self.assertEqual(result["reason"], "no_local_card")

    def test_unmatched_when_no_tcgplayer_id(self):
        result = upsert_ppt_card_pricing(
            self.connection, {"prices": {"market": 5.0}}, price_date="2026-06-25"
        )
        self.assertEqual(result["matched"], 0)
        self.assertEqual(result["reason"], "no_tcgplayer_id")


if __name__ == "__main__":
    unittest.main()
