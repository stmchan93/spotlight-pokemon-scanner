from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    price_history_cells_from_contexts,
    upsert_card,
    upsert_price_history_daily,
)
from server import _apply_price_history_cells_schema_patch  # noqa: E402


class PriceHistoryCellDualWriteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "cells.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        upsert_card(
            self.connection,
            card_id="c1",
            name="Pikachu",
            set_name="Base Set",
            number="58/102",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="c1",
        )
        self.connection.commit()

    def _cells(self, card_id: str, price_date: str) -> dict[str, dict]:
        rows = self.connection.execute(
            "SELECT * FROM card_price_history_cell WHERE card_id = ? AND price_date = ?",
            (card_id, price_date),
        ).fetchall()
        return {str(r["cell_key"]): {k: r[k] for k in r.keys()} for r in rows}

    def _raw_upsert(self, *, condition: str, market: float) -> None:
        upsert_price_history_daily(
            self.connection,
            card_id="c1",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            price_date="2026-06-01",
            currency_code="USD",
            variant="Holofoil",
            condition=condition,
            low_price=market - 1,
            market_price=market,
            mid_price=market,
            high_price=market + 1,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        self.connection.commit()

    def test_raw_upsert_dual_writes_a_matching_cell(self) -> None:
        self._raw_upsert(condition="NM", market=15.0)
        cells = self._cells("c1", "2026-06-01")
        self.assertIn("raw|holofoil|NM", cells)
        cell = cells["raw|holofoil|NM"]
        self.assertEqual(cell["lane"], "raw")
        self.assertEqual(cell["condition"], "NM")
        self.assertEqual(cell["variant_key"], "holofoil")
        self.assertEqual(cell["market"], 15.0)
        self.assertEqual(cell["currency_code"], "USD")

    def test_graded_only_update_preserves_existing_raw_cells_merge_semantics(self) -> None:
        # Raw NM first, then a graded-only update on the SAME (card, date).
        self._raw_upsert(condition="NM", market=15.0)
        upsert_price_history_daily(
            self.connection,
            card_id="c1",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider="scrydex",
            price_date="2026-06-01",
            currency_code="USD",
            variant="Holofoil",
            grader="PSA",
            grade="9",
            market_price=140.0,
            low_price=139.0,
            high_price=141.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        self.connection.commit()

        cells = self._cells("c1", "2026-06-01")
        # Raw cell survived the graded-only update (lane-scoped merge preserved).
        self.assertIn("raw|holofoil|NM", cells)
        self.assertEqual(cells["raw|holofoil|NM"]["market"], 15.0)
        # Graded cell was added alongside it. (The synthetic entry's variantKey
        # is the variant name "Holofoil" — the decomposition is faithful to
        # whatever variantKey the writer stored.)
        graded_key = "graded|PSA|9|Holofoil|p0s0e0"
        self.assertIn(graded_key, cells)
        self.assertEqual(cells[graded_key]["lane"], "graded")
        self.assertEqual(cells[graded_key]["grader"], "PSA")
        self.assertEqual(cells[graded_key]["grade"], "9")
        self.assertEqual(cells[graded_key]["market"], 140.0)

    def test_re_upsert_replaces_the_cell_in_place(self) -> None:
        self._raw_upsert(condition="NM", market=15.0)
        self._raw_upsert(condition="NM", market=22.5)  # price moved same day
        cells = self._cells("c1", "2026-06-01")
        self.assertEqual(len(cells), 1)  # not duplicated
        self.assertEqual(cells["raw|holofoil|NM"]["market"], 22.5)

    def test_dual_write_is_a_noop_when_the_cell_table_is_absent(self) -> None:
        # Simulate pre-migration / rolled-back state: drop the Phase-1 table.
        self.connection.execute("DROP TABLE card_price_history_cell")
        self.connection.commit()
        # The JSON write must still succeed without raising.
        self._raw_upsert(condition="NM", market=15.0)
        row = self.connection.execute(
            "SELECT raw_contexts_json FROM card_price_history_daily WHERE card_id = 'c1'"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertIn("holofoil", str(row["raw_contexts_json"]))

    def test_decompose_handles_multi_variant_graded_grade_list(self) -> None:
        # A graded grade can hold a list of entries (multiple variants); each
        # becomes its own cell keyed by variant + flags.
        graded = {
            "graders": {
                "PSA": {
                    "10": [
                        {"variantKey": "holofoil", "currencyCode": "USD", "market": 500.0, "isPerfect": False},
                        {"variantKey": "reverseHolofoil", "currencyCode": "USD", "market": 480.0, "isPerfect": True},
                    ]
                }
            }
        }
        cells = price_history_cells_from_contexts(
            card_id="c1", provider="scrydex", price_date="2026-06-01",
            currency_code="USD", raw_contexts=None, graded_contexts=graded,
            updated_at="2026-06-01T00:00:00Z",
        )
        keys = {c[4] for c in cells}  # cell_key is column index 4
        self.assertIn("graded|PSA|10|holofoil|p0s0e0", keys)
        self.assertIn("graded|PSA|10|reverseHolofoil|p1s0e0", keys)
        self.assertEqual(len(cells), 2)


if __name__ == "__main__":
    unittest.main()
