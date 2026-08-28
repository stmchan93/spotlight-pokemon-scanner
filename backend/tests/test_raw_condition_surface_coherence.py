"""Raw per-condition surfaces vs the TCGCSV main lane: with the flag on and a
FRESH main price, the main printing's NM cell serves the main-lane values and
its out-of-scale sibling conditions are hidden — on BOTH the scan price matrix
and the PDP per-condition trend rows. Other printings are never judged, and the
flag off is byte-identical to today. Covers json AND cells history modes.
"""
from __future__ import annotations

import json
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
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_fx_rate_snapshot,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from scrydex_adapter import SCRYDEX_PROVIDER  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402
from tcgcsv_adapter import scrydex_variant_label_for_subtype  # noqa: E402

PRICE_DATE = "2026-06-01"
JPY_USD_RATE = 0.00616  # 50000 JPY -> 308.00 USD; 2x the $80 main = $160 cutoff
HISTORY_SOURCES = ("json", "cells")


def _now_iso(hours_ago: float = 0.0) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat()


class _Shim(SpotlightScanService):
    """Connection-only service so pricing resolution runs without the bootstrap."""

    def __init__(self, connection: sqlite3.Connection) -> None:  # noqa: D401
        self._conn = connection

    @property
    def connection(self) -> sqlite3.Connection:  # type: ignore[override]
        return self._conn


class RawConditionSurfaceCoherenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "coherence.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        upsert_card(
            self.connection,
            card_id="c1",
            name="Mega Charizard EX",
            set_name="XY Promos",
            number="61",
            rarity="Promo",
            variant="Raw",
            language="Japanese",
            source_provider="scrydex",
            source_record_id="c1",
        )
        self.connection.commit()
        self.shim = _Shim(self.connection)

    # --- seeding helpers --------------------------------------------------

    def _seed_raw(self, *, variant, condition, market):
        kwargs = dict(
            currency_code="JPY",
            variant=variant,
            condition=condition,
            low_price=market - 100,
            market_price=market,
            mid_price=market + 50,
            high_price=market + 100,
            direct_low_price=market - 200,
            trend_price=market + 25,
            payload={"provider": SCRYDEX_PROVIDER},
        )
        upsert_price_history_daily(
            self.connection,
            card_id="c1",
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX_PROVIDER,
            price_date=PRICE_DATE,
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

    def _seed_two_printings(self, *, fe_lp_market=45000.0):
        # Two printings: First Edition (the main's printing) and Unlimited.
        self._seed_raw(variant="First Edition", condition="NM", market=50000.0)
        self._seed_raw(variant="First Edition", condition="LP", market=fe_lp_market)
        self._seed_raw(variant="Unlimited", condition="NM", market=30000.0)
        upsert_fx_rate_snapshot(
            self.connection,
            base_currency="JPY",
            quote_currency="USD",
            rate=JPY_USD_RATE,
            source="test",
        )
        self.connection.commit()

    def _set_main(self, *, market, variant="1st Edition Holofoil", updated_at=None):
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
                updated_at if updated_at is not None else (_now_iso() if market is not None else None),
            ),
        )
        self.connection.commit()

    def _set_main_printings(self, printings):
        self.connection.execute(
            "UPDATE card_price_snapshots SET main_raw_printings_json = ? WHERE card_id = 'c1'",
            (json.dumps(printings or {}),),
        )
        self.connection.commit()

    # --- read helpers -----------------------------------------------------

    def _surfaces(self):
        return {
            "matrix": self.shim.raw_pricing_matrix("c1"),
            "trends_fe": self.shim.card_price_trends("c1", mode="raw", variant="First Edition"),
            "trends_unl": self.shim.card_price_trends("c1", mode="raw", variant="Unlimited"),
        }

    @staticmethod
    def _matrix_variant(matrix, label):
        for entry in matrix["variants"]:
            if entry["variant"] == label:
                return entry
        return None

    @staticmethod
    def _condition_row(variant_entry, code):
        for row in variant_entry["conditions"]:
            if row["code"] == code:
                return row
        return None

    @staticmethod
    def _trend_row(trend_list, code):
        for row in trend_list["rows"]:
            if row["key"] == code:
                return row
        return None

    def _env(self, source, extra=None):
        env = {"PRICE_HISTORY_SOURCE": source}
        env.update(extra or {})
        return patch.dict(os.environ, env, clear=False)

    # --- mapping helper ----------------------------------------------------

    def test_subtype_to_scrydex_label_mapping(self):
        self.assertEqual(scrydex_variant_label_for_subtype("1st Edition Holofoil"), "First Edition")
        self.assertEqual(scrydex_variant_label_for_subtype("Unlimited Normal"), "Unlimited")
        self.assertEqual(scrydex_variant_label_for_subtype(" Reverse Holofoil "), "Reverse Holofoil")
        self.assertIsNone(scrydex_variant_label_for_subtype("Foil Madness"))
        self.assertIsNone(scrydex_variant_label_for_subtype(None))

    # --- 1. flag off is byte-identical ------------------------------------

    def test_flag_off_output_identical_with_or_without_main(self):
        self._seed_two_printings()
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source):
                os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
                self._set_main(market=80.0)
                with_main = self._surfaces()
                self._set_main(market=None, variant=None, updated_at=None)
                without_main = self._surfaces()
                self.assertEqual(with_main, without_main)
                fe = self._matrix_variant(with_main["matrix"], "First Edition")
                nm = self._condition_row(fe, "NM")
                self.assertAlmostEqual(nm["market"], 308.0, places=2)  # Scrydex, converted
                self.assertIsNotNone(self._condition_row(fe, "LP"))  # nothing hidden
                self.assertAlmostEqual(
                    self._trend_row(with_main["trends_fe"], "NM")["currentPrice"], 308.0, places=2
                )
                self.assertIsNotNone(self._trend_row(with_main["trends_fe"], "LP"))

    # --- 2. flag on: main NM + out-of-scale hiding ------------------------

    def test_flag_on_main_printing_nm_and_scale_rules(self):
        self._seed_two_printings()
        self._set_main(market=80.0)
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"}):
                surfaces = self._surfaces()

                fe = self._matrix_variant(surfaces["matrix"], "First Edition")
                nm = self._condition_row(fe, "NM")
                self.assertEqual(nm["market"], 80.0)  # Rule 1: main lane values
                self.assertEqual(nm["low"], 79.0)
                self.assertEqual(nm["mid"], 80.5)
                self.assertEqual(nm["high"], 81.0)
                # Rule 2: FE LP ~= $277 USD > 2 x $80 -> hidden.
                self.assertIsNone(self._condition_row(fe, "LP"))
                # Other printing untouched: Unlimited NM ~= $184.80.
                unl = self._matrix_variant(surfaces["matrix"], "Unlimited")
                self.assertAlmostEqual(self._condition_row(unl, "NM")["market"], 184.8, places=2)
                self.assertEqual(surfaces["matrix"]["currencyCode"], "USD")

                fe_trends = surfaces["trends_fe"]
                nm_row = self._trend_row(fe_trends, "NM")
                self.assertEqual(nm_row["currentPrice"], 80.0)
                self.assertEqual(nm_row["currencyCode"], "USD")
                self.assertIsNone(self._trend_row(fe_trends, "LP"))
                # Unlimited rows belong to the other printing: pure Scrydex.
                unl_nm = self._trend_row(surfaces["trends_unl"], "NM")
                self.assertAlmostEqual(unl_nm["currentPrice"], 184.8, places=2)

    # --- 3. same-printing condition within scale is kept -------------------

    def test_flag_on_in_scale_sibling_condition_kept(self):
        self._seed_two_printings(fe_lp_market=10000.0)  # ~= $61.60 < $160 cutoff
        self._set_main(market=80.0)
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"}):
                surfaces = self._surfaces()
                fe = self._matrix_variant(surfaces["matrix"], "First Edition")
                lp = self._condition_row(fe, "LP")
                self.assertIsNotNone(lp)
                self.assertAlmostEqual(lp["market"], 61.6, places=2)  # Scrydex value, converted
                lp_trend = self._trend_row(surfaces["trends_fe"], "LP")
                self.assertIsNotNone(lp_trend)
                self.assertAlmostEqual(lp_trend["currentPrice"], 61.6, places=2)

    # --- 3b. per-printing map: every priced printing gets its own rules -----

    _FE_PRINTING = {"subTypeName": "1st Edition Holofoil", "market": 80.0,
                    "low": 79.0, "mid": 80.5, "high": 81.0, "directLow": 78.0}
    _UNL_PRINTING = {"subTypeName": "Unlimited Holofoil", "market": 185.0,
                     "low": 180.0, "mid": 186.0, "high": 190.0, "directLow": 179.0}

    def _seed_two_priced_printings(self):
        self._seed_two_printings()
        # Unlimited LP ~= $400.40 USD > 2 x $185 -> out of scale for ITS printing.
        self._seed_raw(variant="Unlimited", condition="LP", market=65000.0)
        self._set_main(market=80.0)
        self._set_main_printings({"First Edition": self._FE_PRINTING,
                                  "Unlimited": self._UNL_PRINTING})

    def test_second_priced_printing_reshapes_its_own_rows(self):
        self._seed_two_priced_printings()
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"}):
                surfaces = self._surfaces()
                # Unlimited NM serves ITS printing's TCGCSV row (Rule 1)...
                unl = self._matrix_variant(surfaces["matrix"], "Unlimited")
                nm = self._condition_row(unl, "NM")
                self.assertEqual(nm["market"], 185.0)
                self.assertEqual(nm["low"], 180.0)
                self.assertEqual(nm["high"], 190.0)
                # ...and its out-of-scale LP is judged against 185, not the $80 main (Rule 2).
                self.assertIsNone(self._condition_row(unl, "LP"))
                unl_nm = self._trend_row(surfaces["trends_unl"], "NM")
                self.assertEqual(unl_nm["currentPrice"], 185.0)
                self.assertEqual(unl_nm["currencyCode"], "USD")
                self.assertIsNone(self._trend_row(surfaces["trends_unl"], "LP"))
                # The main printing still behaves exactly as before.
                fe = self._matrix_variant(surfaces["matrix"], "First Edition")
                self.assertEqual(self._condition_row(fe, "NM")["market"], 80.0)
                self.assertIsNone(self._condition_row(fe, "LP"))

    def test_printing_absent_from_json_stays_pure_scrydex(self):
        # The user decision: a printing with no TCGplayer sales keeps its
        # Scrydex rows byte-identical — never hidden, never floored.
        self._seed_two_priced_printings()
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source):
                os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
                baseline = self._surfaces()
                # Flag off is identical whether or not the main lane is stored.
                self._set_main(market=None, variant=None)
                self._set_main_printings({})
                self.assertEqual(baseline, self._surfaces())
                self._set_main(market=80.0)
            with self.subTest(history_source=source), self._env(source, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"}):
                self._set_main_printings({"First Edition": self._FE_PRINTING})
                surfaces = self._surfaces()
                self.assertEqual(
                    self._matrix_variant(surfaces["matrix"], "Unlimited"),
                    self._matrix_variant(baseline["matrix"], "Unlimited"),
                )
                self.assertEqual(surfaces["trends_unl"], baseline["trends_unl"])
                # LP kept at the Scrydex value even though it exceeds 2 x the main.
                unl_lp = self._trend_row(surfaces["trends_unl"], "LP")
                self.assertAlmostEqual(unl_lp["currentPrice"], 400.4, places=2)
                # The FE printing is still reshaped in the same response.
                fe = self._matrix_variant(surfaces["matrix"], "First Edition")
                self.assertEqual(self._condition_row(fe, "NM")["market"], 80.0)

    # --- 4. stale main -> pure Scrydex -------------------------------------

    def test_stale_main_serves_pure_scrydex(self):
        self._seed_two_printings()
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source):
                os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
                self._set_main(market=80.0, updated_at=_now_iso(hours_ago=72.0))
                baseline = self._surfaces()
            with self.subTest(history_source=source), self._env(source, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"}):
                self.assertEqual(self._surfaces(), baseline)

    # --- 5. main variant with no matching Scrydex variant -------------------

    def test_unmatched_main_variant_changes_nothing(self):
        self._seed_two_printings()
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source):
                os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
                self._set_main(market=80.0)
                baseline = self._surfaces()
            for main_variant in ("Reverse Holofoil", "Foil Madness"):
                with self.subTest(history_source=source, main_variant=main_variant), self._env(
                    source, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"}
                ):
                    # Mapped-but-absent and unmapped subtypes both leave the
                    # surfaces untouched (no crash, nothing hidden, NM Scrydex).
                    self._set_main(market=80.0, variant=main_variant)
                    self.assertEqual(self._surfaces(), baseline)

    # --- graded lane is never touched ---------------------------------------

    def test_graded_trend_rows_untouched(self):
        self._seed_two_printings()
        kwargs = dict(
            currency_code="USD",
            variant="First Edition",
            grader="PSA",
            grade="10",
            low_price=495.0,
            market_price=500.0,
            mid_price=505.0,
            high_price=510.0,
            direct_low_price=490.0,
            trend_price=502.0,
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
        self._set_main(market=80.0)
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source):
                os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
                flag_off = self.shim.card_price_trends("c1", mode="graded")
            with self.subTest(history_source=source), self._env(source, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"}):
                flag_on = self.shim.card_price_trends("c1", mode="graded")
            self.assertEqual(flag_on, flag_off)
            self.assertEqual(flag_on["rows"][0]["currentPrice"], 500.0)


if __name__ == "__main__":
    unittest.main()
