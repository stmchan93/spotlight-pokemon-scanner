"""Regression guard for the collection day-change condition mismatch.

An owned Lightly Played entry showed a phantom "down" on the collection page:
the displayed price was the LP price, but the day-change diffed it against the
NM price. Cause: the yesterday-side price resolver falls back to a different
condition (NM-first priority, then the NM default_raw_* scalars) when the exact
requested condition is missing — so today's LP minus yesterday's NM produced a
fake delta.

`_portfolio_history_price_row_from_history_row(..., require_condition_match=True)`
(used by `_day_change_for_entry`) must return None instead, so a day-over-day
delta only ever compares like-for-like (LP↔LP) or reports no change.
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
CARD_ID = "gastly-1"
VARIANT = "Holofoil"


class DayChangeConditionMatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "day-change-condition.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        upsert_card(
            connection,
            card_id=CARD_ID,
            name="Gastly",
            set_name="Fossil",
            number="50/62",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=CARD_ID,
        )
        self.connection = connection
        self._seed_condition("NM", market=42.99)
        # Adversarial: corrupt the NM default scalar so the only correct LP answer
        # must come from a real LP cell — never the default_raw_* fallback.
        connection.execute(
            "UPDATE card_price_history_daily SET default_raw_market_price = 999.0 WHERE card_id = ?",
            (CARD_ID,),
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        # Mid-test seeds (e.g. adding an LP day) go through the service's live
        # connection now that the bootstrap connection is closed.
        self.connection = self.service.connection
        self._prev_source = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"
        self.addCleanup(self._restore_source)

    def _restore_source(self) -> None:
        if self._prev_source is None:
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
        else:
            os.environ["PRICE_HISTORY_SOURCE"] = self._prev_source

    def _seed_condition(self, condition: str, *, market: float) -> None:
        upsert_price_history_daily(
            self.connection,
            card_id=CARD_ID,
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX,
            price_date=PRICE_DATE,
            currency_code="USD",
            variant=VARIANT,
            condition=condition,
            low_price=market - 1,
            market_price=market,
            mid_price=market,
            high_price=market + 1,
        )
        self.connection.commit()

    def _row(self):
        rows_by_card = self.service._portfolio_history_rows_by_card_id(
            card_ids={CARD_ID},
            end_date=date(2026, 6, 2),
            provider=SCRYDEX,
        )
        rows = rows_by_card.get(CARD_ID) or []
        self.assertEqual(len(rows), 1)
        return rows[0]

    def _price(self, condition_code: str, *, require_condition_match: bool):
        return self.service._portfolio_history_price_row_from_history_row(
            {"cardID": CARD_ID, "itemKind": "raw", "variantName": VARIANT},
            row=self._row(),
            condition_code=condition_code,
            require_condition_match=require_condition_match,
        )

    def test_loose_resolution_falls_back_to_nm_for_a_missing_lp(self) -> None:
        # The pre-fix behavior: LP missing → resolver substitutes the NM price.
        loose = self._price("LP", require_condition_match=False)
        self.assertIsNotNone(loose)
        self.assertEqual(loose["market"], 42.99)

    def test_strict_resolution_returns_none_for_a_missing_lp(self) -> None:
        # The fix: an exact-match request must NOT borrow the NM price.
        self.assertIsNone(self._price("LP", require_condition_match=True))

    def test_strict_resolution_still_resolves_an_exact_condition(self) -> None:
        # NM is present, so strict matching resolves it normally.
        strict_nm = self._price("NM", require_condition_match=True)
        self.assertIsNotNone(strict_nm)
        self.assertEqual(strict_nm["market"], 42.99)

    def test_strict_resolution_returns_lp_when_lp_exists(self) -> None:
        self._seed_condition("LP", market=29.30)
        strict_lp = self._price("LP", require_condition_match=True)
        self.assertIsNotNone(strict_lp)
        self.assertEqual(strict_lp["market"], 29.30)

    def test_day_change_reports_no_phantom_drop_for_lp_without_lp_history(self) -> None:
        # today shows LP 29.30; yesterday only has NM → no like-for-like baseline,
        # so the delta is reported as unavailable rather than -13.69 (NM - LP).
        amount, percent = self.service._day_change_for_entry(
            card_id=CARD_ID,
            item_kind="raw",
            grader=None,
            grade=None,
            variant_name=VARIANT,
            condition_code="lightly_played",
            today_pricing={"market": 29.30},
            yesterday_rows_by_card_id={CARD_ID: self._row()},
        )
        self.assertIsNone(amount)
        self.assertIsNone(percent)

    def test_day_change_computes_lp_to_lp_when_lp_history_exists(self) -> None:
        self._seed_condition("LP", market=29.30)
        amount, percent = self.service._day_change_for_entry(
            card_id=CARD_ID,
            item_kind="raw",
            grader=None,
            grade=None,
            variant_name=VARIANT,
            condition_code="lightly_played",
            today_pricing={"market": 30.30},
            yesterday_rows_by_card_id={CARD_ID: self._row()},
        )
        self.assertAlmostEqual(amount, 1.0, places=2)
        self.assertAlmostEqual(percent, (1.0 / 29.30) * 100.0, places=2)


if __name__ == "__main__":
    unittest.main()
