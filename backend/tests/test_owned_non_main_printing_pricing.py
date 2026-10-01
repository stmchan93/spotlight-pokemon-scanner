"""Owned copies of a NON-main printing price from that printing's TCGCSV cell.

The raw headline's TCGCSV main lane only covers the card's MAIN printing. A copy
of any other printing (One Piece Alt Art / Special Alt Art, a stamped Pokémon
promo) kept quoting Scrydex — ST30-001 Alt Art at $90.14 in the Collection
while the card page for that printing showed the TCGCSV $60.23. Now the copy's
headline, portfolio total, history, day change and performance row all read
the printing's own raw_main cell, by the PDP condition ladder's rules; the main
printing is untouched.
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
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    price_history_rows_for_cards_batched,
    upsert_card,
    upsert_deck_entry,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from request_auth import RequestIdentity  # noqa: E402
from scrydex_adapter import SCRYDEX_PROVIDER  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402
from watch_printings import printing_cell_key  # noqa: E402

USER = "user-alt-art"
TZ = "UTC"
HISTORY_DAYS = 5


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dates() -> list[str]:
    today = datetime.now(timezone.utc).date()
    return [(today - timedelta(days=HISTORY_DAYS - 1 - i)).isoformat() for i in range(HISTORY_DAYS)]


class PrintingCellKeyTests(unittest.TestCase):
    """The key mirrors sync_tcgcsv_prices: subtype unless shared, then label."""

    def test_staging_shapes(self):
        # ST30-001: base Foil + Alt Art share "Foil" -> label-keyed.
        st30 = {"Foil": {"subTypeName": "Foil", "market": 3.14}, "Alt Art": {"subTypeName": "Foil", "market": 60.23}}
        self.assertEqual(printing_cell_key(json.dumps(st30), "Alt Art"), "Alt Art")
        self.assertEqual(printing_cell_key(json.dumps(st30), "Foil"), "Foil")
        # OP15-039: Alt Art is its own product with the only "Foil" -> subtype-keyed.
        op15 = {"Normal": {"subTypeName": "Normal", "market": 0.13}, "Alt Art": {"subTypeName": "Foil", "market": 15.72}}
        self.assertEqual(printing_cell_key(json.dumps(op15), "Alt Art"), "Foil")
        # OP05-091: six printings on "Foil".
        op05 = {
            label: {"subTypeName": "Foil", "market": 1.0}
            for label in ("Foil", "Alt Art", "Special Alt Art", "Reprint", "Gold Special Alt Art")
        }
        self.assertEqual(printing_cell_key(json.dumps(op05), "Special Alt Art"), "Special Alt Art")
        # sv10-170: the stamp shares "Normal" with the base card.
        sv10 = {
            "Normal": {"subTypeName": "Normal", "market": 0.23},
            "Reverse Holofoil": {"subTypeName": "Reverse Holofoil", "market": 0.32},
            "Play Pokemon Stamp": {"subTypeName": "Normal", "market": 0.18},
        }
        self.assertEqual(printing_cell_key(json.dumps(sv10), "Play Pokemon Stamp"), "Play Pokemon Stamp")
        self.assertEqual(printing_cell_key(json.dumps(sv10), "Reverse Holofoil"), "Reverse Holofoil")
        # Spelling: "1st Edition" names the "First Edition" label.
        neo = {"First Edition": {"subTypeName": "1st Edition", "market": 9.72}}
        self.assertEqual(printing_cell_key(neo, "1st Edition"), "1st Edition")
        # Unpriced printing / junk.
        self.assertIsNone(printing_cell_key(json.dumps(st30), "Manga"))
        self.assertIsNone(printing_cell_key("not json", "Alt Art"))
        self.assertIsNone(printing_cell_key("{}", "Alt Art"))


class OwnedNonMainPrintingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "alt-art.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self.connection = self.service.connection
        env = patch.dict(os.environ, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv", "PRICE_HISTORY_SOURCE": "cells"})
        env.start()
        self.addCleanup(env.stop)
        self.dates = _dates()
        self.today = self.dates[-1]

    # --- seeding ---------------------------------------------------------

    def _card(self, card_id: str, name: str = "Card") -> None:
        upsert_card(
            self.connection,
            card_id=card_id,
            name=name,
            set_name="Test Set",
            number="001",
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider=SCRYDEX_PROVIDER,
            source_record_id=card_id,
        )

    def _scrydex(self, card_id: str, *, variant: str, condition: str, market: float) -> None:
        kwargs = dict(
            currency_code="USD",
            variant=variant,
            condition=condition,
            low_price=market,
            market_price=market,
            mid_price=market,
            high_price=market,
            direct_low_price=None,
            trend_price=market,
            payload={"provider": SCRYDEX_PROVIDER},
        )
        for price_date in self.dates:
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

    def _tcgcsv(
        self,
        card_id: str,
        *,
        main_sub_type: str,
        printings: dict[str, tuple[str, list[float]]],
        main_label: str,
        fresh: bool = True,
    ) -> None:
        """Main lane + one raw_main cell per printing per day, as the sync writes
        them. ``printings``: {label: (subTypeName, [market per day])}."""
        subtype_counts: dict[str, int] = {}
        for sub_type, _ in printings.values():
            subtype_counts[sub_type] = subtype_counts.get(sub_type, 0) + 1
        today_map = {
            label: {"subTypeName": sub_type, "market": markets[-1], "low": markets[-1] - 0.5}
            for label, (sub_type, markets) in printings.items()
        }
        main_markets = printings[main_label][1]
        updated_at = _now_iso() if fresh else (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        self.connection.execute(
            """
            UPDATE card_price_snapshots
            SET main_raw_market_price = ?, main_raw_low_price = ?, main_raw_mid_price = NULL,
                main_raw_high_price = NULL, main_raw_direct_low_price = NULL,
                main_raw_variant = ?, main_raw_updated_at = ?, main_raw_printings_json = ?
            WHERE card_id = ?
            """,
            (main_markets[-1], main_markets[-1] - 0.5, main_sub_type, updated_at,
             json.dumps(today_map), card_id),
        )
        for index, price_date in enumerate(self.dates):
            self.connection.execute(
                "UPDATE card_price_history_daily SET main_raw_market_price = ?, main_raw_variant = ? "
                "WHERE card_id = ? AND price_date = ?",
                (main_markets[index], main_sub_type, card_id, price_date),
            )
            for label, (sub_type, markets) in printings.items():
                key = sub_type if subtype_counts[sub_type] == 1 else label
                market = markets[index]
                self.connection.execute(
                    """
                    INSERT INTO card_price_history_cell (
                        card_id, provider, price_date, lane, cell_key, variant_key, condition,
                        grader, grade, is_perfect, is_signed, is_error,
                        currency_code, low, market, mid, high, direct_low, trend, updated_at
                    ) VALUES (?, 'tcgcsv', ?, 'raw_main', ?, ?, 'NM',
                              NULL, NULL, 0, 0, 0, 'USD', ?, ?, NULL, NULL, NULL, ?, ?)
                    """,
                    (card_id, price_date, f"raw_main|{key}|NM", key,
                     market - 0.5, market, market, _now_iso()),
                )
        self.connection.commit()

    def _seed_st30(self, *, alt_art_lp: float = 105.10, fresh: bool = True) -> None:
        card_id = "onepiece~ST30-001"
        self._card(card_id, "Luffy")
        self._scrydex(card_id, variant="Foil", condition="NM", market=4.64)
        self._scrydex(card_id, variant="Foil", condition="LP", market=5.15)
        self._scrydex(card_id, variant="Alt Art", condition="NM", market=90.14)
        self._scrydex(card_id, variant="Alt Art", condition="LP", market=alt_art_lp)
        self._scrydex(card_id, variant="Alt Art", condition="MP", market=85.00)
        self._tcgcsv(
            card_id,
            main_sub_type="Foil",
            main_label="Foil",
            printings={
                "Foil": ("Foil", [3.00, 3.05, 3.10, 3.12, 3.14]),
                "Alt Art": ("Foil", [55.00, 57.00, 58.50, 59.00, 60.23]),
            },
            fresh=fresh,
        )

    def _own(self, card_id: str, *, variant: str | None, condition: str | None = "near_mint",
             quantity: int = 1, added_market_price: float | None = None) -> str:
        entry_id = upsert_deck_entry(
            self.connection,
            owner_user_id=USER,
            card_id=card_id,
            variant_name=variant,
            condition=condition,
            quantity=quantity,
            added_at=f"{self.dates[0]}T00:00:00+00:00",
            added_market_price=added_market_price,
            added_market_date=self.dates[0] if added_market_price is not None else None,
        )
        self.connection.commit()
        return entry_id

    # --- reads -----------------------------------------------------------

    def _as_user(self):
        return self.service.request_identity_context(RequestIdentity(user_id=USER, auth_source="test"))

    def _entries(self) -> list[dict]:
        with self._as_user():
            return self.service.deck_entries_for_owner(
                USER, limit=100, offset=0, include_inactive=False, compute_day_change=True
            )["entries"]

    def _entry(self, variant: str | None, condition: str = "near_mint") -> dict:
        for entry in self._entries():
            if entry["variantName"] == variant and entry["condition"] == condition:
                return entry
        raise AssertionError(f"no entry {variant} {condition}")

    def _price(self, card_id: str, variant: str | None, condition: str | None = None):
        pricing = self.service._display_pricing_summary_for_context(
            card_id,
            pricing_context=self.service._raw_pricing_context(
                preferred_variant=variant, preferred_condition=condition
            ),
        )
        return None if pricing is None else pricing.get("market")

    def _card_page_nm(self, card_id: str, variant: str) -> float:
        matrix = self.service.raw_pricing_matrix(card_id)
        for row in matrix["variants"]:
            if row["variant"] == variant:
                for condition in row["conditions"]:
                    if condition["code"] == "NM":
                        return condition["market"]
        raise AssertionError(f"card page has no NM row for {variant}")

    # --- tests -----------------------------------------------------------

    def test_st30_alt_art_collection_equals_card_page(self):
        self._seed_st30()
        self._own("onepiece~ST30-001", variant="Alt Art")
        entry = self._entry("Alt Art")
        pricing = entry["card"]["pricing"]
        self.assertAlmostEqual(pricing["market"], 60.23)
        self.assertEqual(pricing["condition"], "NM")
        self.assertEqual(pricing["variant"], "Alt Art")
        self.assertAlmostEqual(self._card_page_nm("onepiece~ST30-001", "Alt Art"), 60.23)
        # The on-demand (unbatched) read agrees with the batched list read.
        self.assertAlmostEqual(self._price("onepiece~ST30-001", "Alt Art"), 60.23)

    def test_main_printing_copy_is_unchanged(self):
        self._seed_st30()
        self._own("onepiece~ST30-001", variant="Foil")
        self._own("onepiece~ST30-001", variant="Foil", condition="lightly_played")
        self.assertAlmostEqual(self._entry("Foil")["card"]["pricing"]["market"], 3.14)
        # Main non-NM stays on its Scrydex condition price, exactly as before.
        self.assertAlmostEqual(self._entry("Foil", "lightly_played")["card"]["pricing"]["market"], 5.15)
        for variant, condition in (("Foil", None), ("Foil", "lightly_played"), (None, None)):
            with self.subTest(variant=variant, condition=condition):
                context = self.service._raw_pricing_context(
                    preferred_variant=variant, preferred_condition=condition
                )
                self.assertEqual(
                    self.service._display_pricing_summary_for_context("onepiece~ST30-001", pricing_context=context),
                    self.service._resolved_display_pricing_summary("onepiece~ST30-001", pricing_context=context),
                )

    def test_non_nm_conditions_follow_the_card_page_ladder(self):
        self._seed_st30()
        card_id = "onepiece~ST30-001"
        # LP: Scrydex prices it and it is in scale with the cell -> the ladder's LP.
        self.assertAlmostEqual(self._price(card_id, "Alt Art", "lightly_played"), 105.10)
        # MP: likewise.
        self.assertAlmostEqual(self._price(card_id, "Alt Art", "moderately_played"), 85.00)
        # HP: Scrydex has no HP for the printing -> the printing's NM, the cell
        # (was the Scrydex NM $90.14), and no "NM" stamp so the app keeps it.
        self._own(card_id, variant="Alt Art", condition="heavily_played")
        hp = self._entry("Alt Art", "heavily_played")["card"]["pricing"]
        self.assertAlmostEqual(hp["market"], 60.23)
        self.assertNotIn("condition", hp)

    def test_json_history_source_agrees(self):
        self._seed_st30()
        card_id = "onepiece~ST30-001"
        with patch.dict(os.environ, {"PRICE_HISTORY_SOURCE": "json"}):
            self.assertAlmostEqual(self._price(card_id, "Alt Art"), 60.23)
            self.assertAlmostEqual(self._price(card_id, "Alt Art", "lightly_played"), 105.10)
            # The JSON resolver's nearest fallback (MP) is not an exact HP price.
            self.assertAlmostEqual(self._price(card_id, "Alt Art", "heavily_played"), 60.23)

    def test_out_of_scale_condition_falls_to_the_cell(self):
        # The card page drops an LP priced > 2x the printing's cell (Rule 2).
        self._seed_st30(alt_art_lp=150.00)
        card_id = "onepiece~ST30-001"
        self.assertAlmostEqual(self._price(card_id, "Alt Art", "lightly_played"), 60.23)
        ladder = {
            row["variant"]: [c["code"] for c in row["conditions"]]
            for row in self.service.raw_pricing_matrix(card_id)["variants"]
        }
        self.assertNotIn("LP", ladder["Alt Art"])

    def test_op05_special_alt_art(self):
        card_id = "onepiece~OP05-091"
        self._card(card_id, "Rebecca")
        self._scrydex(card_id, variant="Foil", condition="NM", market=2.39)
        self._scrydex(card_id, variant="Alt Art", condition="NM", market=16.76)
        self._scrydex(card_id, variant="Special Alt Art", condition="NM", market=148.61)
        self._tcgcsv(
            card_id,
            main_sub_type="Foil",
            main_label="Foil",
            printings={
                "Foil": ("Foil", [1.0, 1.0, 1.0, 1.0, 1.02]),
                "Alt Art": ("Foil", [17.0, 17.0, 17.1, 17.1, 17.18]),
                "Special Alt Art": ("Foil", [130.0, 132.0, 134.0, 136.0, 137.19]),
            },
        )
        self._own(card_id, variant="Special Alt Art")
        self.assertAlmostEqual(self._entry("Special Alt Art")["card"]["pricing"]["market"], 137.19)
        self.assertAlmostEqual(self._card_page_nm(card_id, "Special Alt Art"), 137.19)

    def test_subtype_keyed_alt_art(self):
        # OP15-039: the alt art's cell is keyed "Foil" (its own product).
        card_id = "onepiece~OP15-039"
        self._card(card_id, "Nami")
        self._scrydex(card_id, variant="Normal", condition="NM", market=0.20)
        self._scrydex(card_id, variant="Alt Art", condition="NM", market=17.66)
        self._tcgcsv(
            card_id,
            main_sub_type="Normal",
            main_label="Normal",
            printings={
                "Normal": ("Normal", [0.1, 0.1, 0.1, 0.12, 0.13]),
                "Alt Art": ("Foil", [15.0, 15.2, 15.4, 15.6, 15.72]),
            },
        )
        self.assertAlmostEqual(self._price(card_id, "Alt Art"), 15.72)
        self.assertAlmostEqual(self._card_page_nm(card_id, "Alt Art"), 15.72)

    def test_stamped_pokemon_printing(self):
        card_id = "sv10-170"
        self._card(card_id, "Pikachu")
        self._scrydex(card_id, variant="Normal", condition="NM", market=0.18)
        self._scrydex(card_id, variant="Play Pokemon Stamp", condition="NM", market=0.24)
        self._tcgcsv(
            card_id,
            main_sub_type="Normal",
            main_label="Normal",
            printings={
                "Normal": ("Normal", [0.2, 0.2, 0.21, 0.22, 0.23]),
                "Play Pokemon Stamp": ("Normal", [0.15, 0.16, 0.17, 0.17, 0.18]),
            },
        )
        self._own(card_id, variant="Play Pokemon Stamp")
        self.assertAlmostEqual(self._entry("Play Pokemon Stamp")["card"]["pricing"]["market"], 0.18)
        self.assertAlmostEqual(self._card_page_nm(card_id, "Play Pokemon Stamp"), 0.18)

    def test_falls_back_when_no_cell_or_flag_off_or_stale(self):
        self._seed_st30()
        card_id = "onepiece~ST30-001"
        # A printing TCGCSV does not price keeps its Scrydex behaviour.
        self.assertIsNone(self._price(card_id, "Manga"))
        with patch.dict(os.environ, {"RAW_MAIN_PRICE_SOURCE": "scrydex"}):
            self.assertAlmostEqual(self._price(card_id, "Alt Art"), 90.14)

    def test_stale_main_lane_keeps_scrydex(self):
        self._seed_st30(fresh=False)
        self.assertAlmostEqual(self._price("onepiece~ST30-001", "Alt Art"), 90.14)

    def test_added_market_price_is_kept(self):
        self._seed_st30()
        self._own("onepiece~ST30-001", variant="Alt Art", added_market_price=85.0)
        entry = self._entry("Alt Art")
        self.assertEqual(entry["sinceAddedBaselinePrice"], 85.0)
        self.assertAlmostEqual(entry["sinceAddedChangeAmount"], round(60.23 - 85.0, 2), places=2)

    def test_portfolio_history_total_and_performance_agree(self):
        self._seed_st30()
        card_id = "onepiece~ST30-001"
        self._own(card_id, variant="Alt Art", quantity=2)
        self._own(card_id, variant="Foil")
        with self._as_user():
            summary = self.service.deck_entries_for_owner(
                USER, limit=100, offset=0, include_inactive=False, compute_day_change=False
            )["summary"]
            history = self.service.deck_history(days=365, range_label="1W", time_zone_name=TZ)
            performance = self.service._compute_portfolio_performance()
        expected_today = 2 * 60.23 + 3.14
        self.assertAlmostEqual(summary["totalValue"], expected_today, places=2)
        points = {p["date"]: p["totalValue"] for p in history["points"]}
        self.assertAlmostEqual(points[self.today], expected_today, places=2)
        # Every earlier day is that day's TCGCSV cells for both printings.
        alt = [55.00, 57.00, 58.50, 59.00, 60.23]
        foil = [3.00, 3.05, 3.10, 3.12, 3.14]
        for index, price_date in enumerate(self.dates):
            if price_date in points:
                self.assertAlmostEqual(points[price_date], 2 * alt[index] + foil[index], places=2)
        alt_rows = [r for r in performance["rows"] if r.get("variantName") == "Alt Art"]
        self.assertEqual(len(alt_rows), 1)
        self.assertAlmostEqual(alt_rows[0]["currentPrice"], 60.23, places=2)
        # Its yearly sparkline is the printing's series, ending on the headline.
        self.assertAlmostEqual(alt_rows[0]["sparkline"][-1], 60.23, places=2)
        self.assertNotIn(90.14, alt_rows[0]["sparkline"])

    def test_day_change_and_sparkline_use_the_printing_series(self):
        self._seed_st30()
        self._own("onepiece~ST30-001", variant="Alt Art")
        entry = self._entry("Alt Art")
        # Yesterday (in the portfolio's local zone) is one of the printing's own
        # cells — never the Scrydex $90.14, which would read as a -$29.91 drop.
        self.assertIn(round(entry["dayChangeAmount"], 2), {round(60.23 - 59.00, 2), round(60.23 - 58.50, 2)})
        self.assertEqual(entry["sparkPoints"], [55.0, 57.0, 58.5, 59.0, 60.23])

    def test_series_free_read_keeps_printing_day_change(self):
        # Without series the printing points are only needed for day change, so
        # they are read from yesterday's row date instead of a year back.
        self._seed_st30()
        self._own("onepiece~ST30-001", variant="Alt Art")
        with self._as_user():
            full = self.service._compute_deck_entries_for_owner(USER, limit=100)
            with patch.object(
                self.service,
                "_printing_points_for_copies",
                wraps=self.service._printing_points_for_copies,
            ) as points:
                lite = self.service._compute_deck_entries_for_owner(
                    USER, limit=100, include_series=False
                )
                self.assertEqual(points.call_count, 1)
                since = points.call_args.kwargs["since"]
                points.reset_mock()
                self.service._compute_deck_entries_for_owner(
                    USER, limit=100, include_series=False, compute_day_change=False
                )
                points.assert_not_called()
        self.assertIn(since, self.dates[:-1])
        self.assertNotEqual(since, self.dates[0])
        for key in ("dayChangeAmount", "dayChangePercent", "card"):
            self.assertEqual(
                [entry[key] for entry in lite["entries"]],
                [entry[key] for entry in full["entries"]],
                key,
            )
        self.assertIsNotNone(lite["entries"][0]["dayChangeAmount"])

    def test_batched_history_reader_applies_printing_points(self):
        self._seed_st30()
        card_id = "onepiece~ST30-001"
        points = self.service._printing_points_for_copies([(card_id, "Alt Art")], since=self.dates[0])
        self.assertEqual(points[(card_id, "Alt Art")][self.today]["market"], 60.23)
        base = {"card_id": card_id, "pricing_mode": RAW_PRICING_MODE, "variant": "Alt Art", "condition": None}
        rows = price_history_rows_for_cards_batched(
            self.connection,
            [
                {**base, "key": "with", "printing_points": points[(card_id, "Alt Art")]},
                {**base, "key": "without"},
            ],
            provider=SCRYDEX_PROVIDER,
            days=10,
        )
        self.assertEqual([r["market"] for r in rows["with"]], [60.23, 59.0, 58.5, 57.0, 55.0])
        self.assertTrue(all(r["market"] == 90.14 for r in rows["without"]))
        # A day without a cell keeps the Scrydex resolution (mixed series, like the main lane).
        self.connection.execute(
            "DELETE FROM card_price_history_cell WHERE lane = 'raw_main' AND price_date = ?",
            (self.dates[0],),
        )
        points = self.service._printing_points_for_copies([(card_id, "Alt Art")], since=self.dates[0])
        rows = price_history_rows_for_cards_batched(
            self.connection,
            [{**base, "key": "with", "printing_points": points[(card_id, "Alt Art")]}],
            provider=SCRYDEX_PROVIDER,
            days=10,
        )
        self.assertEqual(rows["with"][-1]["market"], 90.14)


if __name__ == "__main__":
    unittest.main()
