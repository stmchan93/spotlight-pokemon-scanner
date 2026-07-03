"""Regression guard for the collection day-change PRINTING mismatch.

An owned raw vintage card with no chosen printing (e.g. Neo Genesis Lugia,
`variant_name = NULL`) showed a phantom +$377.57 "day change". Cause: today's
live price falls back to the snapshot's default printing ("Unlimited Holofoil",
$543.07), but the day-ago resolver independently re-picked a default — and its
variant priority is modern-only, so for a vintage card it fell back
alphabetically to "First Edition Holofoil" ($165.50). Today's Unlimited minus
yesterday's First Edition = the bogus $377.57.

`_day_change_for_entry` must carry today's RESOLVED printing into the day-ago
lookup so both sides compare like-for-like (543.07 ↔ 543.07 = no change).
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
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
# Any date strictly before "today" — the day-ago batched lookup filters on
# price_date < now(), so this must stay in the past.
PRICE_DATE = "2026-06-30"
CARD_ID = "neo1-9"
UNLIMITED = "Unlimited Holofoil"
FIRST_EDITION = "First Edition Holofoil"
UNLIMITED_NM = 543.07
FIRST_EDITION_NM = 165.50


class DayChangeVariantMatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "day-change-variant.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        upsert_card(
            connection,
            card_id=CARD_ID,
            name="Lugia",
            set_name="Neo Genesis",
            number="9/111",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=CARD_ID,
        )
        self.connection = connection
        # A vintage card with two printings priced very differently, mirroring the
        # real Scrydex data. Both are OUTSIDE the modern variant-priority list, so
        # the default picker falls back alphabetically → First Edition.
        self._seed(UNLIMITED, market=UNLIMITED_NM)
        self._seed(FIRST_EDITION, market=FIRST_EDITION_NM)
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self.connection = self.service.connection
        self._prev_source = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"
        self.addCleanup(self._restore_source)

    def _restore_source(self) -> None:
        if self._prev_source is None:
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
        else:
            os.environ["PRICE_HISTORY_SOURCE"] = self._prev_source

    def _seed(self, variant: str, *, market: float) -> None:
        upsert_price_history_daily(
            self.connection,
            card_id=CARD_ID,
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX,
            price_date=PRICE_DATE,
            currency_code="USD",
            variant=variant,
            condition="NM",
            low_price=market - 1,
            market_price=market,
            mid_price=market,
            high_price=market + 1,
        )
        self.connection.commit()

    def _yesterday_rows(self):
        return self.service._yesterday_price_history_rows_by_card_id([CARD_ID])

    def _day_change(self, today_pricing):
        return self.service._day_change_for_entry(
            card_id=CARD_ID,
            item_kind="raw",
            grader=None,
            grade=None,
            variant_name=None,  # owned without a chosen printing
            condition_code="near_mint",
            today_pricing=today_pricing,
            yesterday_rows_by_card_id=self._yesterday_rows(),
        )

    def test_default_picker_alone_would_diverge_to_first_edition(self) -> None:
        # Documents the divergence the fix bridges: with no printing hint, the
        # day-ago resolver picks First Edition ($165.50), not Unlimited ($543.07).
        row = self._yesterday_rows()[CARD_ID]
        priced = self.service._portfolio_history_price_row_from_history_row(
            {"cardID": CARD_ID, "itemKind": "raw", "variantName": None},
            row=row,
            condition_code="NM",
            require_condition_match=True,
        )
        self.assertIsNotNone(priced)
        self.assertAlmostEqual(priced["market"], FIRST_EDITION_NM, places=2)

    def test_day_change_uses_todays_printing_no_phantom_jump(self) -> None:
        # Today's price resolved to Unlimited; yesterday must too → no change,
        # NOT the phantom +$377.57 (543.07 Unlimited − 165.50 First Edition).
        amount, percent = self._day_change(
            {"market": UNLIMITED_NM, "variant": UNLIMITED}
        )
        self.assertAlmostEqual(amount, 0.0, places=2)
        self.assertAlmostEqual(percent, 0.0, places=2)

    def test_day_change_still_reports_a_real_move_on_the_same_printing(self) -> None:
        # A genuine Unlimited move is still computed like-for-like.
        amount, percent = self._day_change(
            {"market": UNLIMITED_NM + 10.0, "variant": UNLIMITED}
        )
        self.assertAlmostEqual(amount, 10.0, places=2)
        self.assertAlmostEqual(percent, (10.0 / UNLIMITED_NM) * 100.0, places=2)


if __name__ == "__main__":
    unittest.main()
