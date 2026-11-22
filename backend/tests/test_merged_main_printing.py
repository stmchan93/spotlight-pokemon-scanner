"""One printing, two names: TCGplayer's subtype vs Scrydex's printing.

Computer Search base1-71 is TCGplayer product 42417 with the bare subtype
"Normal"; Scrydex calls that product "unlimited". The TCGCSV sync already
recorded the match in ``main_raw_printings_json`` (``{"Unlimited":
{"subTypeName": "Normal"}}``), yet the card page listed both "Normal" (the
headline's printing, NM only) and "Unlimited" (Scrydex's conditions + graded).

The PDP now shows ONE chip, "Unlimited": TCGplayer NM price + NM chart line,
Scrydex LP/MP/HP/DM. Genuinely different printings (Shadowless, 1st Edition,
a modern Normal/Holofoil/Reverse Holofoil) and anything the data does not
prove stay separate.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    price_snapshot_row,
    served_main_printing_alias,
    upsert_card,
    upsert_deck_entry,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from request_auth import RequestIdentity  # noqa: E402
from scrydex_adapter import SCRYDEX_PROVIDER  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402
from watch_printings import printing_labels_by_cell_key  # noqa: E402

USER = "user-merge"
CARD = "base1-71"
DAYS = 5


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dates() -> list[str]:
    today = datetime.now(timezone.utc).date()
    return [(today - timedelta(days=DAYS - 1 - i)).isoformat() for i in range(DAYS)]


class PrintingLabelsByCellKeyTests(unittest.TestCase):
    def test_inverse_of_the_sync_keying(self):
        self.assertEqual(
            printing_labels_by_cell_key(json.dumps({"Unlimited": {"subTypeName": "Normal", "market": 4.38}})),
            {"Normal": "Unlimited"},
        )
        # Shared subtype -> label-keyed cells, never a subtype alias.
        shared = {"Foil": {"subTypeName": "Foil"}, "Alt Art": {"subTypeName": "Foil"}}
        self.assertEqual(printing_labels_by_cell_key(shared), {"Foil": "Foil", "Alt Art": "Alt Art"})
        self.assertEqual(printing_labels_by_cell_key("not json"), {})


class MergedMainPrintingTests(unittest.TestCase):
    MAIN_NM = [3.01, 3.15, 3.5, 4.0, 4.38]

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "merge.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self.connection = self.service.connection
        env = patch.dict(os.environ, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv", "PRICE_HISTORY_SOURCE": "cells"})
        env.start()
        self.addCleanup(env.stop)
        self.dates = _dates()

    # --- seeding ---------------------------------------------------------

    def _card(self, card_id: str) -> None:
        upsert_card(
            self.connection,
            card_id=card_id,
            name="Card",
            set_name="Base",
            number="71/102",
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider=SCRYDEX_PROVIDER,
            source_record_id=card_id,
        )

    def _scrydex(self, card_id: str, variant: str, condition: str, market: float) -> None:
        kwargs = dict(
            currency_code="USD",
            variant=variant,
            condition=condition,
            low_price=market,
            market_price=market,
            mid_price=None,
            high_price=market,
            direct_low_price=None,
            trend_price=None,
            payload={"provider": SCRYDEX_PROVIDER},
        )
        for price_date in self.dates:
            upsert_price_history_daily(
                self.connection, card_id=card_id, pricing_mode=RAW_PRICING_MODE,
                provider=SCRYDEX_PROVIDER, price_date=price_date, **kwargs,
            )
        upsert_price_snapshot(
            self.connection, card_id=card_id, pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX_PROVIDER, **kwargs,
        )

    def _tcgcsv(self, card_id: str, *, main_sub_type: str, main_market: float,
                printings: dict, cells: dict[str, list[float]]) -> None:
        """Main lane + raw_main cells as sync_tcgcsv_prices writes them.
        ``cells``: {cell key: [market per day]}."""
        self.connection.execute(
            """
            UPDATE card_price_snapshots
            SET main_raw_market_price = ?, main_raw_low_price = 0.98, main_raw_mid_price = 3.18,
                main_raw_high_price = 96.95, main_raw_variant = ?, main_raw_updated_at = ?,
                main_raw_printings_json = ?
            WHERE card_id = ?
            """,
            (main_market, main_sub_type, _now_iso(), json.dumps(printings), card_id),
        )
        for key, markets in cells.items():
            for price_date, market in zip(self.dates, markets):
                self.connection.execute(
                    """
                    INSERT INTO card_price_history_cell (
                        card_id, provider, price_date, lane, cell_key, variant_key, condition,
                        grader, grade, is_perfect, is_signed, is_error,
                        currency_code, low, market, mid, high, direct_low, trend, updated_at
                    ) VALUES (?, 'tcgcsv', ?, 'raw_main', ?, ?, 'NM',
                              NULL, NULL, 0, 0, 0, 'USD', 0.98, ?, 3.18, 96.95, NULL, ?, ?)
                    """,
                    (card_id, price_date, f"raw_main|{key}|NM", key, market, market, _now_iso()),
                )
        self.connection.commit()

    def _seed_computer_search(self, *, printings: dict | None = None, main_market: float = 4.38) -> None:
        self._card(CARD)
        for variant, condition, market in (
            ("Unlimited", "NM", 4.0),
            ("Unlimited", "LP", 1.8),
            ("Unlimited", "MP", 1.28),
            ("Unlimited Shadowless", "NM", 9.29),
            ("Unlimited Shadowless", "LP", 3.62),
            ("First Edition Shadowless", "NM", 144.99),
        ):
            self._scrydex(CARD, variant, condition, market)
        default_printings = {
            "Unlimited": {"subTypeName": "Normal", "market": 4.38, "low": 0.98, "mid": 3.18, "high": 96.95},
        }
        self._tcgcsv(
            CARD,
            main_sub_type="Normal",
            main_market=main_market,
            printings=default_printings if printings is None else printings,
            cells={"Normal": self.MAIN_NM},
        )

    # --- reads -----------------------------------------------------------

    def _chips(self, card_id: str = CARD, **kwargs) -> list[str]:
        history = self.service.card_market_history(card_id, days=30, condition="NM", **kwargs)
        return [option["label"] for option in history["availableVariants"]]

    def _matrix(self, card_id: str = CARD) -> dict[str, dict[str, float]]:
        return {
            row["variant"]: {condition["code"]: condition["market"] for condition in row["conditions"]}
            for row in self.service.raw_pricing_matrix(card_id)["variants"]
        }

    def _series(self, card_id: str = CARD) -> dict[tuple[str, str], dict]:
        history = self.service.card_condition_history(card_id, lane="raw", days=365)
        return {(re.sub(r"[^a-z0-9]", "", s["variantKey"].lower()), s["condition"]): s for s in history["series"]}

    def _as_user(self):
        return self.service.request_identity_context(RequestIdentity(user_id=USER, auth_source="test"))

    # --- Computer Search: one chip --------------------------------------

    def test_alias_is_read_from_the_sync_match(self):
        self._seed_computer_search()
        row = price_snapshot_row(self.connection, CARD)
        self.assertEqual(served_main_printing_alias(row), ("Normal", "Unlimited"))

    def test_picker_lists_unlimited_once_and_keeps_shadowless_and_first_edition(self):
        self._seed_computer_search()
        history = self.service.card_market_history(CARD, days=30, condition="NM")
        labels = [option["label"] for option in history["availableVariants"]]
        self.assertNotIn("Normal", labels)
        self.assertEqual(labels.count("Unlimited"), 1)
        self.assertIn("Unlimited Shadowless", labels)
        self.assertIn("First Edition Shadowless", labels)
        self.assertEqual(history["selectedVariant"], "Unlimited")
        unlimited = next(o for o in history["availableVariants"] if o["label"] == "Unlimited")
        self.assertEqual(unlimited["aliases"], ["Normal"])
        self.assertNotIn("aliases", next(o for o in history["availableVariants"] if o["label"] != "Unlimited"))
        # The chart's latest point is the TCGplayer NM headline.
        self.assertAlmostEqual(history["currentPrice"], 4.38)

    def test_an_old_normal_selection_lands_on_the_merged_chip(self):
        self._seed_computer_search()
        history = self.service.card_market_history(CARD, days=30, condition="NM", preferred_variant="Normal")
        self.assertEqual(history["selectedVariant"], "Unlimited")
        self.assertAlmostEqual(history["currentPrice"], 4.38)

    def test_matrix_merges_tcgplayer_nm_with_scrydex_conditions(self):
        self._seed_computer_search()
        matrix = self._matrix()
        self.assertNotIn("Normal", matrix)
        self.assertAlmostEqual(matrix["Unlimited"]["NM"], 4.38)
        self.assertAlmostEqual(matrix["Unlimited"]["LP"], 1.8)
        self.assertAlmostEqual(matrix["Unlimited"]["MP"], 1.28)
        self.assertAlmostEqual(matrix["Unlimited Shadowless"]["NM"], 9.29)
        self.assertAlmostEqual(matrix["First Edition Shadowless"]["NM"], 144.99)

    def test_condition_history_nm_is_tcgplayer_and_lp_is_scrydex(self):
        self._seed_computer_search()
        series = self._series()
        self.assertNotIn(("normal", "NM"), series)
        nm = series[("unlimited", "NM")]
        self.assertEqual(nm["source"], "tcgcsv")
        self.assertEqual([p["market"] for p in nm["points"]], self.MAIN_NM)
        self.assertEqual(series[("unlimited", "LP")]["source"], "scrydex")
        self.assertEqual(series[("unlimitedshadowless", "NM")]["source"], "scrydex")
        self.assertEqual(
            [p["market"] for p in series[("unlimitedshadowless", "NM")]["points"]], [9.29] * DAYS
        )

    def test_trend_rows_for_the_merged_chip(self):
        self._seed_computer_search()
        for variant in ("Unlimited", "Normal", None):
            with self.subTest(variant=variant):
                trends = self.service.card_price_trends(CARD, mode="raw", variant=variant)
                rows = {row["key"]: row for row in trends["rows"]}
                self.assertAlmostEqual(rows["NM"]["currentPrice"], 4.38)
                self.assertEqual(rows["NM"]["points"], self.MAIN_NM)
                self.assertAlmostEqual(rows["LP"]["currentPrice"], 1.8)

    def test_collection_entries_under_either_name_price_the_same(self):
        self._seed_computer_search()
        for variant, condition in (("Normal", "near_mint"), ("Unlimited", "near_mint"),
                                   ("Unlimited", "lightly_played")):
            upsert_deck_entry(
                self.connection, owner_user_id=USER, card_id=CARD, variant_name=variant,
                condition=condition, quantity=1, added_at=f"{self.dates[0]}T00:00:00+00:00",
            )
        self.connection.commit()
        with self._as_user():
            entries = self.service.deck_entries_for_owner(
                USER, limit=100, offset=0, include_inactive=False, compute_day_change=True
            )["entries"]
        prices = {(e["variantName"], e["condition"]): e["card"]["pricing"]["market"] for e in entries}
        self.assertAlmostEqual(prices[("Normal", "near_mint")], 4.38)
        self.assertAlmostEqual(prices[("Unlimited", "near_mint")], 4.38)
        self.assertAlmostEqual(prices[("Unlimited", "lightly_played")], 1.8)

    def test_watching_the_merged_chip_watches_the_tcgplayer_printing(self):
        self._seed_computer_search()
        with self._as_user():
            payload = self.service.set_card_favorite(CARD, is_favorite=True, variant="Unlimited")
            detail = self.service.card_detail(CARD)
        self.assertEqual(payload["watchVariant"], "Normal")
        self.assertEqual(payload["watchPrintingLabels"], {"Normal": "Unlimited"})
        assert detail is not None
        self.assertEqual(detail["watchPrintingLabels"], {"Normal": "Unlimited"})

    # --- Base Set Charizard: shared subtype, the price decides -----------

    def _seed_charizard(self) -> str:
        card_id = "base1-4"
        self._card(card_id)
        for condition, market in (("NM", 1001.05), ("LP", 523.87), ("MP", 358.99), ("HP", 266.83), ("DM", 203.34)):
            self._scrydex(card_id, "Unlimited Holofoil", condition, market)
        for condition, market in (("NM", 290.27), ("LP", 218.75)):
            self._scrydex(card_id, "Metal", condition, market)
        self._scrydex(card_id, "Unlimited Shadowless Holofoil", "NM", 2146.38)
        self._tcgcsv(
            card_id,
            main_sub_type="Holofoil",
            main_market=1001.05,
            printings={
                "Unlimited Holofoil": {"subTypeName": "Holofoil", "market": 1001.05},
                "Metal": {"subTypeName": "Holofoil", "market": 290.27},
            },
            cells={"Unlimited Holofoil": [1001.05] * DAYS, "Metal": [290.27] * DAYS},
        )
        return card_id

    def test_shared_subtype_merges_into_the_printing_priced_at_the_main(self):
        card_id = self._seed_charizard()
        self.assertEqual(
            served_main_printing_alias(price_snapshot_row(self.connection, card_id)),
            ("Holofoil", "Unlimited Holofoil"),
        )
        matrix = self._matrix(card_id)
        # No NM-only "Holofoil" duplicate ahead of the full ladder.
        self.assertNotIn("Holofoil", matrix)
        self.assertAlmostEqual(matrix["Unlimited Holofoil"]["NM"], 1001.05)
        self.assertAlmostEqual(matrix["Unlimited Holofoil"]["LP"], 523.87)
        self.assertAlmostEqual(matrix["Metal"]["NM"], 290.27)
        self.assertEqual(next(iter(matrix)), "Unlimited Holofoil")
        self.assertNotIn("Holofoil", self._chips(card_id))

    # --- nothing proven, nothing merged ----------------------------------

    def test_unproven_matches_stay_separate(self):
        cases = {
            # Older sync shape: no Scrydex label claims the "Normal" product.
            "legacy-map": ({"Normal": {"subTypeName": "Normal", "market": 4.38}}, 4.38),
            # The map's Unlimited row is a different number from the main.
            "different-market": ({"Unlimited": {"subTypeName": "Normal", "market": 9.0}}, 4.38),
            # Two printings share the subtype and BOTH price at the main:
            # the price cannot pick one, so no alias.
            "shared-subtype-ambiguous": (
                {"Unlimited": {"subTypeName": "Normal", "market": 4.38},
                 "Unlimited Shadowless": {"subTypeName": "Normal", "market": 4.38}},
                4.38,
            ),
            # Shared subtype, neither printing at the main's price.
            "shared-subtype-no-match": (
                {"Unlimited": {"subTypeName": "Normal", "market": 4.0},
                 "Unlimited Shadowless": {"subTypeName": "Normal", "market": 9.29}},
                4.38,
            ),
            "empty-map": ({}, 4.38),
        }
        for name, (printings, main_market) in cases.items():
            with self.subTest(case=name):
                self.connection.execute("DELETE FROM card_price_history_cell")
                self._seed_computer_search(printings=printings, main_market=main_market)
                self.assertEqual(served_main_printing_alias(price_snapshot_row(self.connection, CARD)), (None, None))
                labels = self._chips()
                self.assertIn("Normal", labels)
                self.assertIn("Unlimited", labels)
                self.assertNotIn("aliases", json.dumps(
                    self.service.card_market_history(CARD, days=30, condition="NM")["availableVariants"]
                ))

    def test_modern_normal_holofoil_reverse_is_unaffected(self):
        card_id = "sv1-1"
        self._card(card_id)
        for variant, market in (("Normal", 0.25), ("Holofoil", 1.5), ("Reverse Holofoil", 0.8)):
            self._scrydex(card_id, variant, "NM", market)
            self._scrydex(card_id, variant, "LP", market * 0.8)
        self._tcgcsv(
            card_id,
            main_sub_type="Normal",
            main_market=0.3,
            printings={
                "Normal": {"subTypeName": "Normal", "market": 0.3},
                "Holofoil": {"subTypeName": "Holofoil", "market": 1.6},
                "Reverse Holofoil": {"subTypeName": "Reverse Holofoil", "market": 0.9},
            },
            cells={"Normal": [0.3] * DAYS, "Holofoil": [1.6] * DAYS, "Reverse Holofoil": [0.9] * DAYS},
        )
        self.assertEqual(served_main_printing_alias(price_snapshot_row(self.connection, card_id)), (None, None))
        self.assertEqual(sorted(self._chips(card_id)), ["Holofoil", "Normal", "Reverse Holofoil"])
        series = self._series(card_id)
        for key in ("normal", "holofoil", "reverseholofoil"):
            self.assertEqual(series[(key, "NM")]["source"], "tcgcsv")
            self.assertEqual(series[(key, "LP")]["source"], "scrydex")


if __name__ == "__main__":
    unittest.main()
