"""The batched portfolio cell read only touches the graded lane for slabs.

`price_history_cell_portfolio_rows_by_card_date` pulled EVERY lane for every
card. Graded cells are over half the table (25.3M of 45.2M rows on staging), so
a collection of 180 raw cards and 8 slabs read hundreds of thousands of graded
rows a year deep and threw all of them away in Python.

Measured on the staging box for that owner, one year of dates: 428,739 rows in
2,979ms unfiltered against 142,423 rows in 944ms split by lane, and the whole
batched reader 4,518ms -> 2,064ms warm with byte-identical output. That read was
most of a 15-24s Insights cold load.

These tests pin BOTH halves: the output must not change, and the raw-only cards
must not be read on the graded lane.
"""

from __future__ import annotations

import os
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
    price_history_cell_portfolio_rows_by_card_date,
    price_history_rows_for_cards_batched,
    upsert_card,
    upsert_price_history_daily,
)
from catalog_tools import upsert_deck_entry  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import (  # noqa: E402
    SpotlightScanService,
    _apply_price_history_cells_schema_patch,
)

REPO_ROOT = BACKEND_ROOT.parent
OWNER = "owner-lane-scope"

SCRYDEX = "scrydex"
PRICE_DATE = "2026-06-01"
RAW_CARD = "raw-card"
SLAB_CARD = "slab-card"


class RecordingConnection:
    """Passes everything through, remembering the SQL it was asked to run."""

    def __init__(self, connection) -> None:
        self._connection = connection
        self.statements: list[str] = []

    def execute(self, sql, params=()):
        self.statements.append(" ".join(str(sql).split()))
        return self._connection.execute(sql, params)

    def __getattr__(self, name):
        return getattr(self._connection, name)


class PortfolioCellLaneScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "lane-scope.sqlite"
        self.connection = connect(database_path)
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)

        for card_id, name in ((RAW_CARD, "Pikachu"), (SLAB_CARD, "Charizard")):
            upsert_card(
                self.connection,
                card_id=card_id,
                name=name,
                set_name="Base Set",
                number="1/102",
                rarity="Rare Holo",
                variant="Raw",
                language="English",
                source_provider=SCRYDEX,
                source_record_id=card_id,
            )
            # Both cards carry BOTH lanes, so a lane filter is the only thing
            # that can keep the graded rows out of the raw card's read.
            upsert_price_history_daily(
                self.connection,
                card_id=card_id,
                pricing_mode=RAW_PRICING_MODE,
                provider=SCRYDEX,
                price_date=PRICE_DATE,
                currency_code="USD",
                variant="Holofoil",
                condition="NM",
                low_price=9.0,
                market_price=10.0,
                mid_price=10.5,
                high_price=11.0,
                direct_low_price=8.0,
                trend_price=10.0,
                payload={"provider": SCRYDEX, "variantKey": "holofoil"},
            )
            upsert_price_history_daily(
                self.connection,
                card_id=card_id,
                pricing_mode=PSA_GRADE_PRICING_MODE,
                provider=SCRYDEX,
                price_date=PRICE_DATE,
                currency_code="USD",
                variant="Holofoil",
                grader="PSA",
                grade="10",
                low_price=900.0,
                market_price=1000.0,
                mid_price=1050.0,
                high_price=1100.0,
                direct_low_price=800.0,
                trend_price=1000.0,
                payload={"provider": SCRYDEX, "variantKey": "holofoil"},
            )
        self.connection.commit()
        self._prev_source = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"
        self.addCleanup(self._restore_source)

    def _restore_source(self) -> None:
        if self._prev_source is None:
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
        else:
            os.environ["PRICE_HISTORY_SOURCE"] = self._prev_source

    def _grouped(self, graded_card_ids):
        return price_history_cell_portfolio_rows_by_card_date(
            self.connection,
            provider=SCRYDEX,
            card_ids=[RAW_CARD, SLAB_CARD],
            price_dates=[PRICE_DATE],
            graded_card_ids=graded_card_ids,
        )

    def test_the_slab_still_gets_its_graded_cells(self) -> None:
        grouped = self._grouped({SLAB_CARD})
        lanes = {row["lane"] for row in grouped[SLAB_CARD][PRICE_DATE]}
        self.assertIn("graded", lanes)

    def test_the_raw_card_is_not_read_on_the_graded_lane(self) -> None:
        unfiltered = self._grouped(None)
        filtered = self._grouped({SLAB_CARD})
        self.assertIn("graded", {row["lane"] for row in unfiltered[RAW_CARD][PRICE_DATE]})
        self.assertEqual({row["lane"] for row in filtered[RAW_CARD][PRICE_DATE]}, {"raw"})

    def test_the_lane_filter_reaches_sql_rather_than_being_a_python_filter(self) -> None:
        recording = RecordingConnection(self.connection)
        price_history_cell_portfolio_rows_by_card_date(
            recording,
            provider=SCRYDEX,
            card_ids=[RAW_CARD, SLAB_CARD],
            price_dates=[PRICE_DATE],
            graded_card_ids={SLAB_CARD},
        )
        cell_reads = [s for s in recording.statements if "card_price_history_cell" in s and "SELECT rowid" in s]
        self.assertEqual(len(cell_reads), 2, "expected one read for the slabs and one for the raw cards")
        self.assertEqual(sum("AND lane IN" in s for s in cell_reads), 1)

    def test_resolved_rows_are_unchanged_end_to_end(self) -> None:
        requests = [
            {"key": "raw-entry", "card_id": RAW_CARD, "pricing_mode": RAW_PRICING_MODE,
             "variant": "Holofoil", "condition": "near_mint", "grader": None, "grade": None},
            {"key": "slab-entry", "card_id": SLAB_CARD, "pricing_mode": PSA_GRADE_PRICING_MODE,
             "variant": "Holofoil", "condition": None, "grader": "PSA", "grade": "10"},
        ]
        resolved = price_history_rows_for_cards_batched(
            self.connection, requests, provider=SCRYDEX, days=30
        )
        self.assertEqual(resolved["raw-entry"][0]["market"], 10.0)
        self.assertEqual(resolved["slab-entry"][0]["market"], 1000.0)

    def test_the_chart_prices_a_raw_holding_on_a_card_that_also_has_graded_cells(self) -> None:
        """The chart takes the same lane scoping, and this is what could break it.

        `RAW_CARD` carries graded cells too. If the scoping ever let a raw
        holding fall through to a graded cell, this chart point would read
        $1,000 instead of $10.
        """
        upsert_deck_entry(
            self.connection,
            card_id=RAW_CARD,
            variant_name="Holofoil",
            condition="NM",
            quantity=2,
            owner_user_id=OWNER,
            added_at=PRICE_DATE,
        )
        self.connection.commit()
        database_path = Path(str(self.connection.execute("PRAGMA database_list").fetchone()[2]))
        self.connection.close()

        service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(service.connection.close)
        with service.request_identity_context(RequestIdentity(user_id=OWNER, auth_source="test")):
            history = service.deck_history(days=365, range_label="ALL", time_zone_name="UTC")
        priced = [point for point in history["points"] if point["pricedCardCount"] > 0]
        self.assertTrue(priced, "expected at least one priced day")
        # 10.0 raw x 2, never the 1000.0 PSA 10 price on the same card.
        self.assertAlmostEqual(priced[0]["totalValue"], 20.0, places=2)
