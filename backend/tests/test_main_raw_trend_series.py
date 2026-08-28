"""Price-trend GRAPH SERIES vs the TCGCSV main lane: with the flag on, every
default/NM series of a printing that has lane='raw_main' cells serves those
per-day points, and days WITHOUT a cell keep the Scrydex value — the accepted
mixed series (no backfill before the cell epoch). Covers all three surfaces
(PDP market-history chart, per-condition trend list, condition-history series),
both history modes, and pins flag-off as byte-identical.
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
    RAW_PRICING_MODE,
    apply_schema,
    card_price_trend_list,
    connect,
    main_raw_cell_points_by_variant_date,
    upsert_card,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from scrydex_adapter import SCRYDEX_PROVIDER  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

DATES = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]
MAIN_DATES = DATES[3:]  # raw_main cells exist only for the last 2 days
HOLO_NM = [12.0, 13.0, 14.0, 15.0, 16.0]
HOLO_LP = [9.0, 9.0, 9.0, 9.0, 9.0]
RH_NM = [30.0, 31.0, 32.0, 33.0, 34.0]
UNL_NM = [5.0, 5.0, 5.0, 5.0, 5.0]
MAIN_HOLO = {MAIN_DATES[0]: 10.0, MAIN_DATES[1]: 11.0}
MAIN_RH = {MAIN_DATES[0]: 20.0, MAIN_DATES[1]: 21.0}
HISTORY_SOURCES = ("json", "cells")
FLAG_ON = {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class _Shim(SpotlightScanService):
    """Connection-only service so pricing resolution runs without the bootstrap."""

    def __init__(self, connection: sqlite3.Connection) -> None:  # noqa: D401
        self._conn = connection

    @property
    def connection(self) -> sqlite3.Connection:  # type: ignore[override]
        return self._conn


class MainRawTrendSeriesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "series.sqlite")
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
        self._seed_scrydex()

    # --- seeding helpers --------------------------------------------------

    def _raw_kwargs(self, *, variant, condition, market):
        return dict(
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

    def _seed_scrydex(self):
        series = (
            ("Holofoil", "NM", HOLO_NM),
            ("Holofoil", "LP", HOLO_LP),
            ("Reverse Holofoil", "NM", RH_NM),
            ("Unlimited", "NM", UNL_NM),
        )
        for variant, condition, markets in series:
            for price_date, market in zip(DATES, markets):
                upsert_price_history_daily(
                    self.connection,
                    card_id="c1",
                    pricing_mode=RAW_PRICING_MODE,
                    provider=SCRYDEX_PROVIDER,
                    price_date=price_date,
                    **self._raw_kwargs(variant=variant, condition=condition, market=market),
                )
            upsert_price_snapshot(
                self.connection,
                card_id="c1",
                pricing_mode=RAW_PRICING_MODE,
                provider=SCRYDEX_PROVIDER,
                **self._raw_kwargs(variant=variant, condition=condition, market=markets[-1]),
            )
        self.connection.commit()

    def _insert_main_cell(self, *, price_date, sub_type, market):
        self.connection.execute(
            """
            INSERT INTO card_price_history_cell (
                card_id, provider, price_date, lane, cell_key, variant_key, condition,
                grader, grade, is_perfect, is_signed, is_error,
                currency_code, low, market, mid, high, direct_low, trend, updated_at
            ) VALUES ('c1', 'tcgcsv', ?, 'raw_main', ?, ?, 'NM',
                      NULL, NULL, 0, 0, 0, 'USD', ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                price_date,
                f"raw_main|{sub_type}|NM",
                sub_type,
                market - 1,
                market,
                market + 0.5,
                market + 1,
                market - 2,
                market,
                _now_iso(),
            ),
        )

    def _add_main(self):
        """The main lane exactly as sync_tcgcsv_prices writes it for the last 2
        days: snapshot columns + printings map, daily main columns, raw_main cells."""
        printings = {
            "Holofoil": {"subTypeName": "Holofoil", "market": 11.0, "low": 10.0,
                         "mid": 11.5, "high": 12.0, "directLow": 9.0},
            "Reverse Holofoil": {"subTypeName": "Reverse Holofoil", "market": 21.0,
                                 "low": 20.0, "mid": 21.5, "high": 22.0, "directLow": 19.0},
        }
        self.connection.execute(
            """
            UPDATE card_price_snapshots
            SET main_raw_market_price = 11.0, main_raw_low_price = 10.0,
                main_raw_mid_price = 11.5, main_raw_high_price = 12.0,
                main_raw_direct_low_price = 9.0, main_raw_variant = 'Holofoil',
                main_raw_updated_at = ?, main_raw_printings_json = ?
            WHERE card_id = 'c1'
            """,
            (_now_iso(), json.dumps(printings)),
        )
        for price_date in MAIN_DATES:
            self.connection.execute(
                "UPDATE card_price_history_daily SET main_raw_market_price = ?, main_raw_variant = 'Holofoil' "
                "WHERE card_id = 'c1' AND price_date = ?",
                (MAIN_HOLO[price_date], price_date),
            )
            self._insert_main_cell(price_date=price_date, sub_type="Holofoil", market=MAIN_HOLO[price_date])
            self._insert_main_cell(price_date=price_date, sub_type="Reverse Holofoil", market=MAIN_RH[price_date])
        self.connection.commit()

    def _remove_main(self):
        self.connection.execute(
            """
            UPDATE card_price_snapshots
            SET main_raw_market_price = NULL, main_raw_low_price = NULL,
                main_raw_mid_price = NULL, main_raw_high_price = NULL,
                main_raw_direct_low_price = NULL, main_raw_variant = NULL,
                main_raw_updated_at = NULL, main_raw_printings_json = '{}'
            WHERE card_id = 'c1'
            """
        )
        self.connection.execute(
            "UPDATE card_price_history_daily SET main_raw_market_price = NULL, main_raw_variant = NULL "
            "WHERE card_id = 'c1'"
        )
        self.connection.execute(
            "DELETE FROM card_price_history_cell WHERE card_id = 'c1' AND lane = 'raw_main'"
        )
        self.connection.commit()

    # --- read helpers -----------------------------------------------------

    def _surfaces(self):
        return {
            "market_holo_nm": self.shim.card_market_history(
                "c1", days=30, preferred_variant="Holofoil", condition="NM"
            ),
            "market_rh_nm": self.shim.card_market_history(
                "c1", days=30, preferred_variant="Reverse Holofoil", condition="NM"
            ),
            "market_holo_lp": self.shim.card_market_history(
                "c1", days=30, preferred_variant="Holofoil", condition="LP"
            ),
            "market_unl_nm": self.shim.card_market_history(
                "c1", days=30, preferred_variant="Unlimited", condition="NM"
            ),
            "trends_holo": self.shim.card_price_trends("c1", mode="raw", variant="Holofoil"),
            "trends_rh": self.shim.card_price_trends("c1", mode="raw", variant="Reverse Holofoil"),
            "trends_unl": self.shim.card_price_trends("c1", mode="raw", variant="Unlimited"),
            "condition_history": self.shim.card_condition_history("c1", lane="raw", days=365),
        }

    @staticmethod
    def _trend_row(trend_list, code):
        for row in trend_list["rows"]:
            if row["key"] == code:
                return row
        return None

    @staticmethod
    def _series(history, *, variant_key, condition):
        def _key(value):
            return "".join(ch for ch in str(value or "").lower() if ch.isalnum())

        for entry in history["series"]:
            if _key(entry.get("variantKey")) == _key(variant_key) and entry.get("condition") == condition:
                return entry
        return None

    @staticmethod
    def _point_markets(points):
        return [p["market"] for p in points]

    def _env(self, source, extra=None):
        env = {"PRICE_HISTORY_SOURCE": source}
        env.update(extra or {})
        return patch.dict(os.environ, env, clear=False)

    # --- helper: the grouped cell fetch itself ------------------------------

    def test_cell_fetch_grouping_and_flag_gate(self):
        self._add_main()
        with self._env("cells"):
            os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
            self.assertEqual(
                main_raw_cell_points_by_variant_date(self.connection, card_id="c1"), {}
            )
        with self._env("cells", FLAG_ON):
            grouped = main_raw_cell_points_by_variant_date(
                self.connection, card_id="c1", start_date=DATES[0]
            )
            self.assertEqual(set(grouped), {"holofoil", "reverseholofoil"})
            self.assertEqual(
                grouped["holofoil"][MAIN_DATES[1]],
                {"market": 11.0, "low": 10.0, "mid": 11.5, "high": 12.0},
            )
            # Date-range bound uses the (card_id, price_date, ...) index prefix.
            bounded = main_raw_cell_points_by_variant_date(
                self.connection, card_id="c1", start_date=MAIN_DATES[1]
            )
            self.assertEqual(list(bounded["reverseholofoil"]), [MAIN_DATES[1]])

    # --- 1. flag off is byte-identical on all three surfaces ----------------

    def test_flag_off_byte_identical_on_all_surfaces(self):
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source):
                os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
                self._add_main()
                with_main = self._surfaces()
                self._remove_main()
                without_main = self._surfaces()
                self.assertEqual(with_main, without_main)
                # Sanity: the Scrydex series is what's served.
                self.assertEqual(
                    self._point_markets(with_main["market_holo_nm"]["points"]), HOLO_NM
                )
                self.assertEqual(self._trend_row(with_main["trends_holo"], "NM")["points"], HOLO_NM)
                holo_nm = self._series(
                    with_main["condition_history"], variant_key="holofoil", condition="NM"
                )
                self.assertEqual(self._point_markets(holo_nm["points"]), HOLO_NM)

    # --- 2. flag on: PDP market-history chart -------------------------------

    def test_flag_on_market_history_mixed_series(self):
        self._add_main()
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source):
                os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
                baseline = self._surfaces()
            with self.subTest(history_source=source), self._env(source, FLAG_ON):
                surfaces = self._surfaces()
                # Main printing: old days Scrydex, last 2 days main-lane (mixed).
                holo = surfaces["market_holo_nm"]
                self.assertEqual(
                    self._point_markets(holo["points"]), [12.0, 13.0, 14.0, 10.0, 11.0]
                )
                # The overridden day serves the FULL cell (low/mid/high too).
                last = holo["points"][-1]
                self.assertEqual(
                    (last["date"], last["low"], last["mid"], last["high"]),
                    (MAIN_DATES[1], 10.0, 11.5, 12.0),
                )
                self.assertEqual(holo["currencyCode"], "USD")
                # Second TCGCSV-priced printing gets ITS cells, not the main's.
                self.assertEqual(
                    self._point_markets(surfaces["market_rh_nm"]["points"]),
                    [30.0, 31.0, 32.0, 20.0, 21.0],
                )
                # Non-NM and no-main-data printings: byte-identical to flag off.
                self.assertEqual(surfaces["market_holo_lp"], baseline["market_holo_lp"])
                self.assertEqual(surfaces["market_unl_nm"], baseline["market_unl_nm"])

    # --- 3. flag on: per-condition trend list --------------------------------

    def test_flag_on_trend_list_mixed_points_and_trend_pct(self):
        self._add_main()
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source):
                os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
                baseline = self._surfaces()
            with self.subTest(history_source=source), self._env(source, FLAG_ON):
                surfaces = self._surfaces()
                nm = self._trend_row(surfaces["trends_holo"], "NM")
                self.assertEqual(nm["points"], [12.0, 13.0, 14.0, 10.0, 11.0])
                # trendPct recomputed FROM the mixed points (first -> last).
                self.assertAlmostEqual(nm["trendPct"], (11.0 - 12.0) / 12.0 * 100.0, places=6)
                rh_nm = self._trend_row(surfaces["trends_rh"], "NM")
                self.assertEqual(rh_nm["points"], [30.0, 31.0, 32.0, 20.0, 21.0])
                self.assertAlmostEqual(rh_nm["trendPct"], (21.0 - 30.0) / 30.0 * 100.0, places=6)
                # LP row and the printing without main data stay byte-identical.
                self.assertEqual(
                    self._trend_row(surfaces["trends_holo"], "LP"),
                    self._trend_row(baseline["trends_holo"], "LP"),
                )
                self.assertEqual(surfaces["trends_unl"], baseline["trends_unl"])

    def test_trend_list_direct_reader_merges_points(self):
        # card_price_trend_list itself (pre-FX, pre-overlay) carries the merge,
        # so every caller of the reader gets the mixed series.
        self._add_main()
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source, FLAG_ON):
                trend_list = card_price_trend_list(
                    self.connection, "c1", mode="raw", provider=SCRYDEX_PROVIDER, variant="Holofoil"
                )
                self.assertEqual(
                    self._trend_row(trend_list, "NM")["points"], [12.0, 13.0, 14.0, 10.0, 11.0]
                )
                self.assertEqual(self._trend_row(trend_list, "LP")["points"], HOLO_LP)

    # --- 4. flag on: condition-history series --------------------------------

    def test_flag_on_condition_history_mixed_series(self):
        self._add_main()
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source):
                os.environ.pop("RAW_MAIN_PRICE_SOURCE", None)
                baseline = self._surfaces()["condition_history"]
            with self.subTest(history_source=source), self._env(source, FLAG_ON):
                history = self._surfaces()["condition_history"]
                holo_nm = self._series(history, variant_key="holofoil", condition="NM")
                self.assertEqual(
                    self._point_markets(holo_nm["points"]), [12.0, 13.0, 14.0, 10.0, 11.0]
                )
                # Full cell values on the overridden day; dates stay ordered.
                self.assertEqual(
                    holo_nm["points"][-1],
                    {"date": MAIN_DATES[1], "market": 11.0, "low": 10.0, "mid": 11.5, "high": 12.0},
                )
                self.assertEqual([p["date"] for p in holo_nm["points"]], DATES)
                rh_nm = self._series(history, variant_key="reverseHolofoil", condition="NM")
                self.assertEqual(
                    self._point_markets(rh_nm["points"]), [30.0, 31.0, 32.0, 20.0, 21.0]
                )
                # LP and the no-main-data printing: identical to flag off.
                self.assertEqual(
                    self._series(history, variant_key="holofoil", condition="LP"),
                    self._series(baseline, variant_key="holofoil", condition="LP"),
                )
                self.assertEqual(
                    self._series(history, variant_key="unlimited", condition="NM"),
                    self._series(baseline, variant_key="unlimited", condition="NM"),
                )

    # --- 5. per-day rule: a TCGCSV-only day still gets a point ---------------

    def test_main_only_day_appears_in_series(self):
        # Day 6 exists only on the main lane (TCGCSV synced before Scrydex).
        self._add_main()
        extra_date = "2026-06-06"
        upsert_price_history_daily(
            self.connection,
            card_id="c1",
            provider=SCRYDEX_PROVIDER,
            price_date=extra_date,
            display_currency_code="USD",
        )
        self.connection.execute(
            "UPDATE card_price_history_daily SET main_raw_market_price = 12.5, main_raw_variant = 'Holofoil' "
            "WHERE card_id = 'c1' AND price_date = ?",
            (extra_date,),
        )
        self._insert_main_cell(price_date=extra_date, sub_type="Holofoil", market=12.5)
        self._insert_main_cell(price_date=extra_date, sub_type="Reverse Holofoil", market=22.5)
        self.connection.commit()
        for source in HISTORY_SOURCES:
            with self.subTest(history_source=source), self._env(source, FLAG_ON):
                surfaces = self._surfaces()
                # The RH printing has no Scrydex data that day: the raw_main cell
                # alone supplies the point on every surface.
                self.assertEqual(
                    self._point_markets(surfaces["market_rh_nm"]["points"])[-1], 22.5
                )
                self.assertEqual(surfaces["market_rh_nm"]["points"][-1]["date"], extra_date)
                self.assertEqual(
                    self._trend_row(surfaces["trends_rh"], "NM")["points"],
                    [30.0, 31.0, 32.0, 20.0, 21.0, 22.5],
                )
                rh_nm = self._series(
                    surfaces["condition_history"], variant_key="reverseHolofoil", condition="NM"
                )
                self.assertEqual([p["date"] for p in rh_nm["points"]], DATES + [extra_date])


if __name__ == "__main__":
    unittest.main()
