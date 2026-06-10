"""Regression guard for the dashboard-history JSON-blob skip.

When PRICE_HISTORY_SOURCE=cells, the per-day price resolver
(`_portfolio_history_price_row_from_history_row`) reads every price from the
normalized cell table and never touches the fat `raw_contexts_json` /
`graded_contexts_json` columns on `card_price_history_daily`. So
`_portfolio_history_rows_by_card_id` (the dashboard's bulk history reader) must
NOT select those blobs in cells mode — reading them was ~500MB+ of dead
overflow-page I/O per refresh (the cold-cache dashboard timeout).

These tests prove (a) the blobs are skipped in cells mode, (b) resolution stays
correct from a JSON-null row, and (c) JSON mode is unchanged.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_price_history_daily,
)
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

SCRYDEX = "scrydex"
PRICE_DATE = "2026-06-01"
CARD_ID = "c1"


class PortfolioHistoryCellsSkipJsonTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "history-skip-json.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        upsert_card(
            connection,
            card_id=CARD_ID,
            name="Pikachu",
            set_name="Base Set",
            number="58/102",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=CARD_ID,
        )
        # Dual-writes the daily row (with raw_contexts_json) AND the cells.
        upsert_price_history_daily(
            connection,
            card_id=CARD_ID,
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX,
            price_date=PRICE_DATE,
            currency_code="USD",
            variant="Holofoil",
            condition="NM",
            low_price=14.0,
            market_price=15.0,
            mid_price=15.5,
            high_price=16.0,
            direct_low_price=13.0,
            trend_price=15.25,
            payload={"provider": SCRYDEX, "variantKey": "holofoil"},
        )
        # Adversarial: corrupt the scalar default so the ONLY way to get the right
        # price (15.0) is via the cells. If a regression stopped reading cells (or
        # tried to read the now-null JSON), resolution would surface this 999.0.
        connection.execute(
            "UPDATE card_price_history_daily SET default_raw_market_price = 999.0 WHERE card_id = ?",
            (CARD_ID,),
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self._prev_source = os.environ.get("PRICE_HISTORY_SOURCE")
        self.addCleanup(self._restore_source)

    def _restore_source(self) -> None:
        if self._prev_source is None:
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
        else:
            os.environ["PRICE_HISTORY_SOURCE"] = self._prev_source

    def _history_row(self):
        rows_by_card = self.service._portfolio_history_rows_by_card_id(
            card_ids={CARD_ID},
            end_date=date(2026, 6, 2),
            provider=SCRYDEX,
        )
        rows = rows_by_card.get(CARD_ID) or []
        self.assertEqual(len(rows), 1, "expected exactly one history row for the seeded day")
        return rows[0]

    def test_cells_mode_skips_json_blobs(self) -> None:
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"
        row = self._history_row()
        # The fix: the fat blobs are NOT selected (NULL-aliased), so no overflow
        # pages are read.
        self.assertIsNone(row["raw_contexts_json"])
        self.assertIsNone(row["graded_contexts_json"])
        # Scalar columns still present (row shape unchanged).
        self.assertEqual(row["price_date"], PRICE_DATE)
        self.assertEqual(row["card_id"], CARD_ID)

    def test_cells_mode_resolves_correct_price_from_null_json_row(self) -> None:
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"
        row = self._history_row()
        pricing = self.service._portfolio_history_price_row_from_history_row(
            {"cardID": CARD_ID, "itemKind": "raw", "variantName": "Holofoil"},
            row=row,
            condition_code="NM",
        )
        self.assertIsNotNone(pricing)
        # 15.0 comes ONLY from the cells; the corrupted scalar default (999.0) and
        # the now-null JSON would both give the wrong answer.
        self.assertEqual(pricing["market"], 15.0)

    def test_json_mode_still_reads_blobs(self) -> None:
        os.environ["PRICE_HISTORY_SOURCE"] = "json"
        row = self._history_row()
        # JSON mode is unchanged: the blob column is still selected/populated.
        self.assertIsNotNone(row["raw_contexts_json"])
        pricing = self.service._portfolio_history_price_row_from_history_row(
            {"cardID": CARD_ID, "itemKind": "raw", "variantName": "Holofoil"},
            row=row,
            condition_code="NM",
        )
        self.assertIsNotNone(pricing)
        # JSON contexts carry the correct 15.0 (only the scalar default was corrupted).
        self.assertEqual(pricing["market"], 15.0)


if __name__ == "__main__":
    unittest.main()
