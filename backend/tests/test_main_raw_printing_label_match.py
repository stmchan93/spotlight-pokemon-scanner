"""Printing identity on the TCGCSV main lane: ``main_raw_variant`` is a
TCGplayer subtype ("1st Edition", "1st Edition Holofoil", "Unlimited
Holofoil") while owned copies and the PDP picker carry the Scrydex label
("First Edition", "Unlimited"). Both must reach the same headline and history,
and label-keyed raw_main cells (subtype-collision printings: One Piece alt
arts, Poke Ball reverses) must feed their printing's series.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    RAW_PRICING_MODE,
    _is_default_main_raw_read,
    apply_schema,
    connect,
    main_raw_cell_points_by_variant_date,
    price_history_rows_for_card,
    price_snapshot_for_card,
    upsert_card,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from scrydex_adapter import SCRYDEX_PROVIDER  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

FLAG_ON = {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"}
DATES = ["2026-09-20", "2026-09-21", "2026-09-22"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class _Shim(SpotlightScanService):
    def __init__(self, connection: sqlite3.Connection) -> None:  # noqa: D401
        self._conn = connection

    @property
    def connection(self) -> sqlite3.Connection:  # type: ignore[override]
        return self._conn


class DefaultMainReadMatchTests(unittest.TestCase):
    def test_label_vs_subtype_truth_table(self):
        cases = [
            # (owned/requested variant, main_raw_variant, expected)
            ("First Edition", "1st Edition", True),
            ("First Edition", "1st Edition Holofoil", True),
            ("First Edition", "1st Edition Normal", True),
            ("1st Edition", "1st Edition", True),
            ("Unlimited", "Unlimited Holofoil", True),
            ("Unlimited", "Unlimited", True),
            ("First Edition Holofoil", "1st Edition Holofoil", True),
            ("Unlimited", "1st Edition", False),
            ("First Edition", "Unlimited Holofoil", False),
            ("Unlimited Holofoil", "1st Edition Holofoil", False),
            # Unchanged Pokemon defaults.
            ("Holofoil", "Holofoil", True),
            ("Reverse Holofoil", "Holofoil", False),
            ("Holofoil", "Reverse Holofoil", False),
            ("Normal", "Normal", True),
            ("Normal", None, True),
            ("Holofoil", None, False),
            (None, "1st Edition", True),
            # One Piece: the alt art is never the Foil main.
            ("Foil", "Foil", True),
            ("Alt Art", "Foil", False),
        ]
        for variant, main, expected in cases:
            with self.subTest(variant=variant, main=main):
                self.assertIs(
                    _is_default_main_raw_read(variant=variant, condition=None, main_raw_variant=main),
                    expected,
                )

    def test_non_nm_condition_still_scrydex(self):
        self.assertFalse(
            _is_default_main_raw_read(variant="First Edition", condition="LP", main_raw_variant="1st Edition")
        )


class MainPrintingLabelServingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "labels.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        self.shim = _Shim(self.connection)

    # --- seeding ---------------------------------------------------------

    def _card(self, card_id, name, number):
        upsert_card(
            self.connection,
            card_id=card_id,
            name=name,
            set_name="Test Set",
            number=number,
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
        )

    def _seed_raw(self, card_id, *, variant, market, condition="NM", dates=DATES):
        kwargs = dict(
            currency_code="USD",
            variant=variant,
            condition=condition,
            low_price=market - 1,
            market_price=market,
            mid_price=market + 0.5,
            high_price=market + 1,
            direct_low_price=market - 2,
            trend_price=market,
            payload={"provider": SCRYDEX_PROVIDER},
        )
        for price_date in dates:
            upsert_price_history_daily(
                self.connection,
                card_id=card_id,
                pricing_mode=RAW_PRICING_MODE,
                provider=SCRYDEX_PROVIDER,
                price_date=price_date,
                **kwargs,
            )
        upsert_price_snapshot(
            self.connection,
            card_id=card_id,
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX_PROVIDER,
            **kwargs,
        )

    def _set_main(self, card_id, *, sub_type, market, printings=None, daily=True):
        """Snapshot + daily main columns exactly as sync_tcgcsv_prices writes them."""
        self.connection.execute(
            """
            UPDATE card_price_snapshots
            SET main_raw_market_price = ?, main_raw_low_price = ?, main_raw_mid_price = ?,
                main_raw_high_price = ?, main_raw_direct_low_price = NULL,
                main_raw_variant = ?, main_raw_updated_at = ?, main_raw_printings_json = ?
            WHERE card_id = ?
            """,
            (market, market - 1, market + 0.5, market + 1, sub_type, _now_iso(),
             json.dumps(printings or {}), card_id),
        )
        if daily:
            self.connection.execute(
                "UPDATE card_price_history_daily SET main_raw_market_price = ?, main_raw_variant = ? "
                "WHERE card_id = ?",
                (market, sub_type, card_id),
            )

    def _cell(self, card_id, *, price_date, key, market):
        self.connection.execute(
            """
            INSERT INTO card_price_history_cell (
                card_id, provider, price_date, lane, cell_key, variant_key, condition,
                grader, grade, is_perfect, is_signed, is_error,
                currency_code, low, market, mid, high, direct_low, trend, updated_at
            ) VALUES (?, 'tcgcsv', ?, 'raw_main', ?, ?, 'NM',
                      NULL, NULL, 0, 0, 0, 'USD', ?, ?, ?, ?, NULL, ?, ?)
            """,
            (card_id, price_date, f"raw_main|{key}|NM", key,
             market - 1, market, market + 0.5, market + 1, market, _now_iso()),
        )

    def _resolve(self, card_id, variant):
        row = self.connection.execute(
            "SELECT * FROM card_price_snapshots WHERE card_id = ?", (card_id,)
        ).fetchone()
        return self.shim._pricing_summary_from_snapshot_row(
            row,
            pricing_context=self.shim._raw_pricing_context(preferred_variant=variant),
            day_cells=None,
        )

    def _seed_wooper(self):
        # Neo Genesis Wooper 82/111: bare "1st Edition" / "Unlimited" subtypes
        # (commons are non-holo), Scrydex labels First Edition / Unlimited.
        self._card("neo1-82", "Wooper", "82/111")
        self._seed_raw("neo1-82", variant="Unlimited", market=3.0)
        self._seed_raw("neo1-82", variant="First Edition", market=14.0)
        self._set_main(
            "neo1-82",
            sub_type="1st Edition",
            market=9.52,
            printings={
                "First Edition": {"subTypeName": "1st Edition", "market": 9.52},
                "Unlimited": {"subTypeName": "Unlimited", "market": 2.5},
            },
        )
        self.connection.commit()

    # --- bug 1: owned label vs main subtype ------------------------------

    def test_wooper_first_edition_owned_copy_gets_the_card_page_price(self):
        self._seed_wooper()
        with patch.dict(os.environ, FLAG_ON):
            card_page = price_snapshot_for_card(self.connection, "neo1-82", pricing_mode=RAW_PRICING_MODE)
            owned = self._resolve("neo1-82", "First Edition")
            scalar_owned = price_snapshot_for_card(
                self.connection, "neo1-82", pricing_mode=RAW_PRICING_MODE, variant="First Edition"
            )
            unlimited = self._resolve("neo1-82", "Unlimited")
        self.assertEqual(card_page["market"], 9.52)
        self.assertEqual(owned["market"], 9.52)
        self.assertEqual(owned["mainPriceSource"], "tcgcsv")
        self.assertEqual(owned["condition"], "NM")
        self.assertEqual(scalar_owned["market"], 9.52)
        # The other printing is not the main lane: Scrydex, unchanged.
        self.assertEqual(unlimited["market"], 3.0)
        self.assertNotIn("mainPriceSource", unlimited)

    def test_wooper_first_edition_history_and_portfolio_rows(self):
        self._seed_wooper()
        daily = self.connection.execute(
            "SELECT * FROM card_price_history_daily WHERE card_id = 'neo1-82' ORDER BY price_date DESC LIMIT 1"
        ).fetchone()
        entry = {"cardID": "neo1-82", "itemKind": "raw", "grader": None, "grade": None,
                 "variantName": "First Edition"}
        with patch.dict(os.environ, FLAG_ON):
            rows = price_history_rows_for_card(
                self.connection, "neo1-82", provider=SCRYDEX_PROVIDER, days=30, variant="First Edition"
            )
            portfolio_row = self.shim._portfolio_history_price_row_from_history_row(
                entry, row=daily, condition_code="NM", require_condition_match=True
            )
        self.assertEqual([r["market"] for r in rows], [9.52] * len(DATES))
        self.assertEqual(portfolio_row["market"], 9.52)

    def test_unlimited_holofoil_main_serves_unlimited_owned_copy(self):
        # Base Set Blastoise: holo rare, main subtype "Unlimited Holofoil".
        self._card("base1-2", "Blastoise", "2/102")
        self._seed_raw("base1-2", variant="Unlimited", market=180.0)
        self._seed_raw("base1-2", variant="First Edition", market=2500.0)
        self._set_main("base1-2", sub_type="Unlimited Holofoil", market=150.0)
        self.connection.commit()
        with patch.dict(os.environ, FLAG_ON):
            card_page = price_snapshot_for_card(self.connection, "base1-2", pricing_mode=RAW_PRICING_MODE)
            owned = self._resolve("base1-2", "Unlimited")
            first = self._resolve("base1-2", "First Edition")
        self.assertEqual(card_page["market"], 150.0)
        self.assertEqual(owned["market"], 150.0)
        self.assertEqual(owned["mainPriceSource"], "tcgcsv")
        self.assertEqual(first["market"], 2500.0)
        self.assertNotIn("mainPriceSource", first)

    # --- bug 2: label-keyed raw_main cells -------------------------------

    def _seed_op13_118(self):
        # OP13-118: Foil, Alt Art, Manga Alt Art all on subtype "Foil", so the
        # sync keys every cell by its Scrydex label.
        self._card("onepiece~OP13-118", "Monkey.D.Luffy", "OP13-118")
        self._seed_raw("onepiece~OP13-118", variant="Foil", market=15.0)
        self._seed_raw("onepiece~OP13-118", variant="Alt Art", market=90.0)
        self._set_main(
            "onepiece~OP13-118",
            sub_type="Foil",
            market=13.9,
            printings={
                "Foil": {"subTypeName": "Foil", "market": 13.9},
                "Alt Art": {"subTypeName": "Foil", "market": 76.63},
                "Manga Alt Art": {"subTypeName": "Foil", "market": 2116.43},
            },
        )
        for price_date, (foil, alt, manga) in zip(
            DATES[1:], [(13.5, 75.0, 2100.0), (13.9, 76.63, 2116.43)]
        ):
            self._cell("onepiece~OP13-118", price_date=price_date, key="Foil", market=foil)
            self._cell("onepiece~OP13-118", price_date=price_date, key="Alt Art", market=alt)
            self._cell("onepiece~OP13-118", price_date=price_date, key="Manga Alt Art", market=manga)
        self.connection.commit()

    def test_label_keyed_cells_are_grouped_by_their_label(self):
        self._seed_op13_118()
        with patch.dict(os.environ, FLAG_ON):
            grouped = main_raw_cell_points_by_variant_date(self.connection, card_id="onepiece~OP13-118")
        self.assertEqual(set(grouped), {"foil", "altart", "mangaaltart"})
        self.assertEqual(grouped["altart"][DATES[2]]["market"], 76.63)
        self.assertEqual(grouped["foil"][DATES[2]]["market"], 13.9)

    def test_alt_art_pdp_history_serves_its_own_cells(self):
        self._seed_op13_118()
        for source in ("json", "cells"):
            with self.subTest(history_source=source), patch.dict(
                os.environ, {**FLAG_ON, "PRICE_HISTORY_SOURCE": source}
            ):
                alt = self.shim.card_market_history(
                    "onepiece~OP13-118", days=30, preferred_variant="Alt Art", condition="NM"
                )
                foil = self.shim.card_market_history(
                    "onepiece~OP13-118", days=30, preferred_variant="Foil", condition="NM"
                )
                self.assertEqual([p["market"] for p in alt["points"]], [90.0, 75.0, 76.63])
                self.assertEqual([p["market"] for p in foil["points"]][-2:], [13.5, 13.9])

    def test_label_keyed_cell_wins_over_collapsed_subtype(self):
        # Two subtypes collapse to "First Edition"; the label-keyed cell is
        # that printing's exact identity and wins the day.
        self._card("c-fe", "Test", "1/1")
        self._cell("c-fe", price_date=DATES[0], key="First Edition", market=40.0)
        self._cell("c-fe", price_date=DATES[0], key="1st Edition Normal", market=5.0)
        self.connection.commit()
        with patch.dict(os.environ, FLAG_ON):
            grouped = main_raw_cell_points_by_variant_date(self.connection, card_id="c-fe")
        self.assertEqual(grouped["firstedition"][DATES[0]]["market"], 40.0)

    def test_poke_ball_reverse_label_keyed_cell_feeds_its_series(self):
        self._card("sv8pt5-1", "Eevee", "1/131")
        self._cell("sv8pt5-1", price_date=DATES[0], key="Reverse Holofoil", market=0.5)
        self._cell("sv8pt5-1", price_date=DATES[0], key="Poke Ball Reverse Holofoil", market=2.25)
        self.connection.commit()
        with patch.dict(os.environ, FLAG_ON):
            grouped = main_raw_cell_points_by_variant_date(self.connection, card_id="sv8pt5-1")
        self.assertEqual(grouped["reverseholofoil"][DATES[0]]["market"], 0.5)
        self.assertEqual(grouped["pokeballreverseholofoil"][DATES[0]]["market"], 2.25)


if __name__ == "__main__":
    unittest.main()
