"""The RAW_MAIN_PRICE_SOURCE seam: with the flag on, a card whose snapshot has a
FRESH TCGCSV ``main_raw_market_price`` serves that main lane for the DEFAULT raw
read (condition unset/NM, variant unset/main's own); every other read — non-NM
conditions, other variants, the whole graded lane — stays on the Scrydex
resolution, and the flag off is byte-identical to today.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    DEFAULT_RAW_CONDITION,
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    price_history_rows_for_card,
    price_snapshot_for_card,
    raw_main_price_enabled,
    raw_main_price_source,
    tcgcsv_stale_hours,
    upsert_card,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from scrydex_adapter import SCRYDEX_PROVIDER  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

PRICE_DATE = "2026-06-01"
FLAG_ON = {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"}


def _now_iso(hours_ago: float = 0.0) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat()


class _Shim(SpotlightScanService):
    """Connection-only service so pricing resolution runs without the bootstrap."""

    def __init__(self, connection: sqlite3.Connection) -> None:  # noqa: D401
        self._conn = connection

    @property
    def connection(self) -> sqlite3.Connection:  # type: ignore[override]
        return self._conn


class MainRawPriceServingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "main_raw.sqlite")
        self.addCleanup(self.connection.close)
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
        self.shim = _Shim(self.connection)

    # --- seeding helpers --------------------------------------------------

    def _seed_raw(self, *, variant, condition, market, price_date=PRICE_DATE):
        kwargs = dict(
            currency_code="USD",
            variant=variant,
            condition=condition,
            low_price=market - 1,
            market_price=market,
            mid_price=market + 0.5,
            high_price=market + 1,
            direct_low_price=market - 2,
            trend_price=market + 0.25,
            payload={"provider": SCRYDEX_PROVIDER},
        )
        upsert_price_history_daily(
            self.connection,
            card_id="c1",
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX_PROVIDER,
            price_date=price_date,
            **kwargs,
        )
        upsert_price_snapshot(
            self.connection,
            card_id="c1",
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX_PROVIDER,
            **kwargs,
        )
        self.connection.commit()

    def _seed_graded(self, *, grader, grade, variant, market):
        kwargs = dict(
            currency_code="USD",
            variant=variant,
            grader=grader,
            grade=grade,
            low_price=market - 5,
            market_price=market,
            mid_price=market + 1,
            high_price=market + 5,
            direct_low_price=market - 6,
            trend_price=market + 2,
            payload={"provider": SCRYDEX_PROVIDER},
        )
        upsert_price_history_daily(
            self.connection,
            card_id="c1",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider=SCRYDEX_PROVIDER,
            price_date=PRICE_DATE,
            **kwargs,
        )
        upsert_price_snapshot(
            self.connection,
            card_id="c1",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider=SCRYDEX_PROVIDER,
            **kwargs,
        )
        self.connection.commit()

    def _set_main_snapshot(self, *, market, variant="Holofoil", updated_at=None):
        self.connection.execute(
            """
            UPDATE card_price_snapshots
            SET main_raw_market_price = ?,
                main_raw_low_price = ?,
                main_raw_mid_price = ?,
                main_raw_high_price = ?,
                main_raw_direct_low_price = ?,
                main_raw_variant = ?,
                main_raw_updated_at = ?
            WHERE card_id = 'c1'
            """,
            (
                market,
                None if market is None else market - 1,
                None if market is None else market + 0.5,
                None if market is None else market + 1,
                None if market is None else market - 2,
                variant,
                updated_at if updated_at is not None else _now_iso(),
            ),
        )
        self.connection.commit()

    def _set_main_daily(self, *, market, variant="Holofoil", price_date=PRICE_DATE):
        self.connection.execute(
            "UPDATE card_price_history_daily SET main_raw_market_price = ?, main_raw_variant = ? "
            "WHERE card_id = 'c1' AND price_date = ?",
            (market, variant, price_date),
        )
        self.connection.commit()

    def _snapshot_row(self):
        return self.connection.execute(
            "SELECT * FROM card_price_snapshots WHERE card_id = 'c1' LIMIT 1"
        ).fetchone()

    def _resolve(self, pricing_context=None):
        return self.shim._pricing_summary_from_snapshot_row(
            self._snapshot_row(),
            pricing_context=pricing_context or self.shim._raw_pricing_context(),
            day_cells=None,
        )

    # --- flag plumbing ----------------------------------------------------

    def test_flag_defaults(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
            os.environ.pop("TCGCSV_STALE_HOURS", None)
            self.assertEqual(raw_main_price_source(), "scrydex")
            self.assertFalse(raw_main_price_enabled())
            self.assertEqual(tcgcsv_stale_hours(), 48.0)
        with patch.dict(os.environ, {"RAW_MAIN_PRICE_SOURCE": "  TCGCSV ", "TCGCSV_STALE_HOURS": "12"}):
            self.assertTrue(raw_main_price_enabled())
            self.assertEqual(tcgcsv_stale_hours(), 12.0)
        with patch.dict(os.environ, {"RAW_MAIN_PRICE_SOURCE": "nonsense", "TCGCSV_STALE_HOURS": "junk"}):
            self.assertFalse(raw_main_price_enabled())
            self.assertEqual(tcgcsv_stale_hours(), 48.0)

    # --- headline serving -------------------------------------------------

    def test_flag_off_is_byte_identical(self):
        self._seed_raw(variant="Holofoil", condition="NM", market=15.0)
        with_main = None
        without_main = None
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
            self._set_main_snapshot(market=99.0)
            with_main = self._resolve()
            self._set_main_snapshot(market=None, variant=None, updated_at=None)
            without_main = self._resolve()
            scalar = price_snapshot_for_card(self.connection, "c1", pricing_mode=RAW_PRICING_MODE)
        self.assertEqual(with_main, without_main)
        self.assertEqual(with_main["market"], 15.0)
        self.assertNotIn("mainPriceSource", with_main)
        self.assertNotIn("condition", with_main)
        self.assertNotIn("mainPriceSource", scalar)
        self.assertNotIn("condition", scalar)

    def test_flag_on_fresh_main_serves_tcgcsv(self):
        self._seed_raw(variant="Holofoil", condition="NM", market=15.0)
        self._set_main_snapshot(market=10.0, variant="Holofoil")
        with patch.dict(os.environ, FLAG_ON):
            for pricing in (
                self._resolve(),
                price_snapshot_for_card(self.connection, "c1", pricing_mode=RAW_PRICING_MODE),
            ):
                self.assertEqual(pricing["market"], 10.0)
                self.assertEqual(pricing["low"], 9.0)
                self.assertEqual(pricing["mid"], 10.5)
                self.assertEqual(pricing["high"], 11.0)
                self.assertEqual(pricing["directLow"], 8.0)
                self.assertEqual(pricing["trend"], 10.0)
                self.assertEqual(pricing["currencyCode"], "USD")
                self.assertEqual(pricing["condition"], DEFAULT_RAW_CONDITION)
                self.assertEqual(pricing["variant"], "Holofoil")
                self.assertEqual(pricing["pricingMode"], "raw")
                self.assertEqual(pricing["mainPriceSource"], "tcgcsv")

    def test_flag_on_null_main_falls_back_to_scrydex(self):
        self._seed_raw(variant="Holofoil", condition="NM", market=15.0)
        with patch.dict(os.environ, FLAG_ON):
            pricing = self._resolve()
        self.assertEqual(pricing["market"], 15.0)
        self.assertEqual(pricing["mainPriceSource"], "scrydex")
        self.assertNotIn("condition", pricing)

    def test_flag_on_stale_main_falls_back_to_scrydex(self):
        self._seed_raw(variant="Holofoil", condition="NM", market=15.0)
        self._set_main_snapshot(market=10.0, updated_at=_now_iso(hours_ago=72.0))
        with patch.dict(os.environ, FLAG_ON):
            pricing = self._resolve()
            self.assertEqual(pricing["market"], 15.0)
            self.assertEqual(pricing["mainPriceSource"], "scrydex")
        # Widening the window via TCGCSV_STALE_HOURS re-freshens the same row.
        with patch.dict(os.environ, {**FLAG_ON, "TCGCSV_STALE_HOURS": "100"}):
            pricing = self._resolve()
            self.assertEqual(pricing["market"], 10.0)
            self.assertEqual(pricing["mainPriceSource"], "tcgcsv")

    def test_unparseable_main_updated_at_is_stale(self):
        self._seed_raw(variant="Holofoil", condition="NM", market=15.0)
        self._set_main_snapshot(market=10.0, updated_at="not-a-timestamp")
        with patch.dict(os.environ, FLAG_ON):
            pricing = self._resolve()
        self.assertEqual(pricing["market"], 15.0)
        self.assertEqual(pricing["mainPriceSource"], "scrydex")

    def test_condition_scoped_read_stays_scrydex(self):
        self._seed_raw(variant="Holofoil", condition="NM", market=15.0)
        self._seed_raw(variant="Holofoil", condition="LP", market=12.0)
        self._set_main_snapshot(market=10.0, variant="Holofoil")
        with patch.dict(os.environ, FLAG_ON):
            pricing = self._resolve(self.shim._raw_pricing_context(preferred_condition="LP"))
        self.assertEqual(pricing["market"], 12.0)
        self.assertNotIn("mainPriceSource", pricing)
        self.assertNotIn("condition", pricing)

    def test_variant_scoped_read_stays_scrydex(self):
        self._seed_raw(variant="Holofoil", condition="NM", market=15.0)
        self._seed_raw(variant="Reverse Holofoil", condition="NM", market=20.0)
        self._set_main_snapshot(market=10.0, variant="Holofoil")
        with patch.dict(os.environ, FLAG_ON):
            other = self._resolve(self.shim._raw_pricing_context(preferred_variant="Reverse Holofoil"))
            same = self._resolve(self.shim._raw_pricing_context(preferred_variant="Holofoil"))
        self.assertEqual(other["market"], 20.0)
        self.assertNotIn("mainPriceSource", other)
        # The main lane's own printing IS the default read.
        self.assertEqual(same["market"], 10.0)
        self.assertEqual(same["mainPriceSource"], "tcgcsv")

    def test_graded_read_untouched(self):
        self._seed_raw(variant="Holofoil", condition="NM", market=15.0)
        self._seed_graded(grader="PSA", grade="10", variant="Holofoil", market=500.0)
        self._set_main_snapshot(market=10.0, variant="Holofoil")
        ctx = self.shim._slab_pricing_context(grader="PSA", grade="10", preferred_variant="Holofoil")
        with patch.dict(os.environ, FLAG_ON):
            flag_on = self._resolve(ctx)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
            flag_off = self._resolve(ctx)
        self.assertEqual(flag_on, flag_off)
        self.assertEqual(flag_on["market"], 500.0)
        self.assertNotIn("mainPriceSource", flag_on)

    # --- phantom guard ----------------------------------------------------

    def test_phantom_guard_evaluates_served_main_price(self):
        # Single printing, Scrydex NM $30 vs own PSA 10 $25: NOT phantom today
        # (30 < 25*1.5). A $100 TCGCSV main IS phantom and must be suppressed.
        self._seed_raw(variant="Normal", condition="NM", market=30.0)
        self._seed_graded(grader="PSA", grade="10", variant="Normal", market=25.0)
        self._set_main_snapshot(market=100.0, variant="Normal")
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
            baseline = self._resolve()
            self.assertEqual(baseline["market"], 30.0)
            self.assertIsNone(baseline.get("suppressionReason"))
        with patch.dict(os.environ, FLAG_ON):
            pricing = self._resolve()
            self.assertIsNone(pricing["market"])
            self.assertEqual(pricing["suppressionReason"], "phantom")
            self.assertEqual(pricing["mainPriceSource"], "tcgcsv")

    def test_phantom_guard_served_main_on_cells_path(self):
        self._seed_raw(variant="Normal", condition="NM", market=30.0)
        self._seed_graded(grader="PSA", grade="10", variant="Normal", market=25.0)
        self._set_main_snapshot(market=100.0, variant="Normal")
        day_cells = self.connection.execute(
            "SELECT * FROM card_price_history_cell WHERE card_id = 'c1' AND price_date = ? ORDER BY +rowid",
            (PRICE_DATE,),
        ).fetchall()
        with patch.dict(os.environ, {**FLAG_ON, "PRICE_HISTORY_SOURCE": "cells"}):
            pricing = self.shim._pricing_summary_from_snapshot_row(
                self._snapshot_row(),
                pricing_context=self.shim._raw_pricing_context(),
                day_cells=day_cells,
            )
        self.assertIsNone(pricing["market"])
        self.assertEqual(pricing["suppressionReason"], "phantom")

    def test_honest_main_price_is_not_suppressed(self):
        self._seed_raw(variant="Normal", condition="NM", market=30.0)
        self._seed_graded(grader="PSA", grade="10", variant="Normal", market=25.0)
        self._set_main_snapshot(market=28.0, variant="Normal")
        with patch.dict(os.environ, FLAG_ON):
            pricing = self._resolve()
        self.assertEqual(pricing["market"], 28.0)
        self.assertIsNone(pricing.get("suppressionReason"))

    # --- writer protection ------------------------------------------------

    def test_replace_price_history_cells_keeps_raw_main_lane(self):
        self._seed_raw(variant="Holofoil", condition="NM", market=15.0)
        self.connection.execute(
            """
            INSERT INTO card_price_history_cell (
                card_id, provider, price_date, lane, cell_key, variant_key, condition,
                grader, grade, is_perfect, is_signed, is_error,
                currency_code, low, market, mid, high, direct_low, trend, updated_at
            ) VALUES ('c1', 'tcgcsv', ?, 'raw_main', 'raw_main|Holofoil|NM', 'holofoil', 'NM',
                      '', '', 0, 0, 0, 'USD', 9.0, 10.0, 10.5, 11.0, 8.0, 10.0, ?)
            """,
            (PRICE_DATE, _now_iso()),
        )
        self.connection.commit()
        # The Scrydex rewrite of the same (card, day) replaces raw/graded cells...
        self._seed_raw(variant="Holofoil", condition="NM", market=16.0)
        rows = self.connection.execute(
            "SELECT lane, market FROM card_price_history_cell WHERE card_id = 'c1' AND price_date = ?",
            (PRICE_DATE,),
        ).fetchall()
        lanes = {str(row["lane"]) for row in rows}
        # ...but the raw_main cell survives.
        self.assertIn("raw_main", lanes)
        self.assertIn("raw", lanes)
        raw_main_markets = [row["market"] for row in rows if str(row["lane"]) == "raw_main"]
        self.assertEqual(raw_main_markets, [10.0])
        raw_markets = [row["market"] for row in rows if str(row["lane"]) == "raw"]
        self.assertEqual(raw_markets, [16.0])

    # --- history / volume readers -----------------------------------------

    def test_history_rows_coalesce_main_market(self):
        self._seed_raw(variant="Holofoil", condition="NM", market=15.0)
        self._seed_raw(variant="Holofoil", condition="LP", market=12.0)
        self._set_main_daily(market=10.0, variant="Holofoil")
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
            rows = price_history_rows_for_card(
                self.connection, "c1", provider=SCRYDEX_PROVIDER, days=30
            )
            self.assertEqual(rows[0]["market"], 15.0)
        with patch.dict(os.environ, FLAG_ON):
            rows = price_history_rows_for_card(
                self.connection, "c1", provider=SCRYDEX_PROVIDER, days=30
            )
            self.assertEqual(rows[0]["market"], 10.0)
            self.assertEqual(rows[0]["condition"], DEFAULT_RAW_CONDITION)
            self.assertEqual(rows[0]["variant"], "Holofoil")
            # Condition-scoped history stays on the Scrydex LP cell.
            lp_rows = price_history_rows_for_card(
                self.connection, "c1", provider=SCRYDEX_PROVIDER, days=30, condition="LP"
            )
            self.assertEqual(lp_rows[0]["market"], 12.0)

    def test_portfolio_history_row_condition_gate(self):
        self._seed_raw(variant="Holofoil", condition="NM", market=15.0)
        self._seed_raw(variant="Holofoil", condition="LP", market=12.0)
        self._set_main_daily(market=10.0, variant="Holofoil")
        row = self.connection.execute(
            "SELECT * FROM card_price_history_daily WHERE card_id = 'c1' LIMIT 1"
        ).fetchone()
        entry = {"cardID": "c1", "itemKind": "raw", "grader": None, "grade": None, "variantName": None}
        with patch.dict(os.environ, FLAG_ON):
            nm = self.shim._portfolio_history_price_row_from_history_row(
                entry, row=row, condition_code="NM", require_condition_match=True
            )
            lp = self.shim._portfolio_history_price_row_from_history_row(
                entry, row=row, condition_code="LP", require_condition_match=True
            )
        self.assertEqual(nm["market"], 10.0)
        self.assertEqual(lp["market"], 12.0)

    def test_card_volume_level_coalesces_main(self):
        today = datetime.now(timezone.utc).date()
        for offset in range(8):
            price_date = (today - timedelta(days=offset)).isoformat()
            upsert_price_history_daily(
                self.connection,
                card_id="c1",
                provider=SCRYDEX_PROVIDER,
                price_date=price_date,
                display_currency_code="USD",
                default_raw_variant="Holofoil",
                default_raw_condition="NM",
                default_raw_market_price=5.0,
            )
            self._set_main_daily(market=10.0 + offset, price_date=price_date)
        self.connection.commit()
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
            self.assertEqual(self.shim._card_volume_level("c1"), "low")
        with patch.dict(os.environ, FLAG_ON):
            self.assertEqual(self.shim._card_volume_level("c1"), "normal")


if __name__ == "__main__":
    unittest.main()
