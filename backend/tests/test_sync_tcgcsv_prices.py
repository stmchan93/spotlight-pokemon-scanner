"""sync_tcgcsv_prices writes ONLY the main lane: main_raw_* snapshot/daily columns
plus one lane='raw_main' cell per card/day. Existing Scrydex rows keep every other
column byte-identical. No network — the product price map is injected.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    reset_collision_guard_cache,
    runtime_setting,
    upsert_card,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from server import _apply_price_history_cells_schema_patch  # noqa: E402
import sync_tcgcsv_prices  # noqa: E402
from sync_tcgcsv_prices import (  # noqa: E402
    PRICING_SYNC_GENERATION_KEY,
    _main,
    run_tcgcsv_price_sync,
    tcgcsv_sync_enabled,
)

MOONBREON_PAYLOAD = {"variants": [
    {"name": "Holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "246723"}]},
]}
MOONBREON_PRICES = {"246723": {"Holofoil": {
    "productId": 246723, "subTypeName": "Holofoil",
    "marketPrice": 2276.45, "lowPrice": 1999.0, "midPrice": 2300.0,
    "highPrice": 3200.0, "directLowPrice": 2100.0,
}}}


class SyncTcgcsvPricesTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "tcgcsv.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        reset_collision_guard_cache()
        self.addCleanup(reset_collision_guard_cache)
        # The repo's real overrides file must not leak into tests.
        overrides_patch = mock.patch.object(
            sync_tcgcsv_prices, "load_tcgplayer_id_overrides", return_value={}
        )
        overrides_patch.start()
        self.addCleanup(overrides_patch.stop)
        upsert_card(
            self.connection, card_id="swsh7-215", name="Umbreon VMAX",
            set_name="Evolving Skies", number="215/203", rarity="Secret",
            variant="Raw", language="English", source_provider="scrydex",
            source_payload=MOONBREON_PAYLOAD,
        )
        self.connection.commit()

    def _seed_scrydex_snapshot(self):
        upsert_price_snapshot(
            self.connection, card_id="swsh7-215", provider="scrydex",
            display_currency_code="USD",
            raw_contexts={"variants": {"Holofoil": {"variant": "Holofoil", "conditions": {
                "NM": {"condition": "NM", "variant": "Holofoil", "market": 2200.0, "low": 2000.0}
            }}}},
            graded_contexts={"graders": {}},
            default_raw_variant="Holofoil",
            default_raw_market_price=2200.0, default_raw_low_price=2000.0,
        )
        self.connection.commit()

    def _snapshot_row(self):
        row = self.connection.execute(
            "SELECT * FROM card_price_snapshots WHERE card_id='swsh7-215'"
        ).fetchone()
        return dict(row) if row is not None else None

    def _sync(self, **kwargs):
        kwargs.setdefault("product_price_map", MOONBREON_PRICES)
        kwargs.setdefault("price_date", "2026-08-25")
        return run_tcgcsv_price_sync(self.connection, **kwargs)

    def test_existing_scrydex_snapshot_gets_main_columns_only(self):
        self._seed_scrydex_snapshot()
        before = self._snapshot_row()

        stats = self._sync()
        self.assertEqual(stats["priced"], 1)

        after = self._snapshot_row()
        main_columns = {
            "main_raw_market_price", "main_raw_low_price", "main_raw_mid_price",
            "main_raw_high_price", "main_raw_direct_low_price",
            "main_raw_variant", "main_raw_updated_at", "main_raw_printings_json",
        }
        for column, value in before.items():
            if column not in main_columns:
                self.assertEqual(after[column], value, f"column {column} changed")
        self.assertEqual(after["provider"], "scrydex")
        self.assertEqual(after["main_raw_market_price"], 2276.45)
        self.assertEqual(after["main_raw_low_price"], 1999.0)
        self.assertEqual(after["main_raw_mid_price"], 2300.0)
        self.assertEqual(after["main_raw_high_price"], 3200.0)
        self.assertEqual(after["main_raw_direct_low_price"], 2100.0)
        self.assertEqual(after["main_raw_variant"], "Holofoil")
        self.assertIsNotNone(after["main_raw_updated_at"])
        self.assertEqual(json.loads(after["main_raw_printings_json"]), {"Holofoil": {
            "subTypeName": "Holofoil", "market": 2276.45, "low": 1999.0,
            "mid": 2300.0, "high": 3200.0, "directLow": 2100.0,
        }})

    def test_junk_high_price_below_market_is_dropped(self):
        prices = {"246723": {"Holofoil": {
            "productId": 246723, "subTypeName": "Holofoil",
            "marketPrice": 100.0, "highPrice": 40.0,
        }}}
        self._sync(product_price_map=prices)
        after = self._snapshot_row()
        self.assertEqual(after["main_raw_market_price"], 100.0)
        self.assertIsNone(after["main_raw_high_price"])

    def test_card_without_snapshot_inserts_tcgcsv_row(self):
        self._sync()
        after = self._snapshot_row()
        self.assertEqual(after["provider"], "tcgcsv")
        self.assertEqual(after["display_currency_code"], "USD")
        self.assertEqual(after["main_raw_market_price"], 2276.45)
        # JSON columns fall back to their schema defaults.
        self.assertEqual(json.loads(after["raw_contexts_json"]), {})

    def test_daily_conflict_updates_only_main_columns(self):
        upsert_price_history_daily(
            self.connection, card_id="swsh7-215", provider="scrydex",
            price_date="2026-08-25", display_currency_code="USD",
            default_raw_market_price=2200.0,
        )
        self.connection.commit()
        before = dict(self.connection.execute(
            "SELECT * FROM card_price_history_daily WHERE card_id='swsh7-215' AND price_date='2026-08-25'"
        ).fetchone())

        self._sync()
        after = dict(self.connection.execute(
            "SELECT * FROM card_price_history_daily WHERE card_id='swsh7-215' AND price_date='2026-08-25'"
        ).fetchone())
        for column, value in before.items():
            if column not in {"main_raw_market_price", "main_raw_variant"}:
                self.assertEqual(after[column], value, f"column {column} changed")
        self.assertEqual(after["provider"], "scrydex")
        self.assertEqual(after["default_raw_market_price"], 2200.0)
        self.assertEqual(after["main_raw_market_price"], 2276.45)
        self.assertEqual(after["main_raw_variant"], "Holofoil")

    def test_daily_insert_uses_pricing_provider_not_tcgcsv(self):
        self._sync()
        row = self.connection.execute(
            "SELECT provider, main_raw_market_price FROM card_price_history_daily "
            "WHERE card_id='swsh7-215' AND price_date='2026-08-25'"
        ).fetchone()
        self.assertEqual(row[0], "scrydex")  # pricing_provider() default
        self.assertEqual(row[1], 2276.45)

    def test_raw_main_cell_delete_then_insert_leaves_other_lanes(self):
        # A pre-existing Scrydex raw cell and a stale raw_main cell for the same day.
        self.connection.execute(
            "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, "
            "variant_key, condition, currency_code, market, updated_at) "
            "VALUES ('swsh7-215', 'scrydex', '2026-08-25', 'raw', 'raw|Holofoil|NM', "
            "'Holofoil', 'NM', 'USD', 2200.0, 'x')"
        )
        self.connection.execute(
            "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, "
            "variant_key, condition, currency_code, market, updated_at) "
            "VALUES ('swsh7-215', 'tcgcsv', '2026-08-25', 'raw_main', 'raw_main|Normal|NM', "
            "'Normal', 'NM', 'USD', 1.0, 'x')"
        )
        self.connection.commit()

        self._sync()
        main_cells = self.connection.execute(
            "SELECT cell_key, variant_key, condition, provider, currency_code, "
            "low, market, mid, high, direct_low, trend, is_perfect, is_signed, is_error, grader, grade "
            "FROM card_price_history_cell WHERE card_id='swsh7-215' AND price_date='2026-08-25' AND lane='raw_main'"
        ).fetchall()
        self.assertEqual(len(main_cells), 1)
        cell = main_cells[0]
        self.assertEqual(cell["cell_key"], "raw_main|Holofoil|NM")
        self.assertEqual(cell["variant_key"], "Holofoil")
        self.assertEqual(cell["condition"], "NM")
        self.assertEqual(cell["provider"], "tcgcsv")
        self.assertEqual(cell["currency_code"], "USD")
        self.assertEqual(cell["market"], 2276.45)
        self.assertEqual(cell["trend"], 2276.45)
        self.assertEqual(cell["low"], 1999.0)
        self.assertEqual((cell["is_perfect"], cell["is_signed"], cell["is_error"]), (0, 0, 0))
        self.assertIsNone(cell["grader"])
        # The Scrydex raw lane cell is untouched.
        raw_cells = self.connection.execute(
            "SELECT market FROM card_price_history_cell "
            "WHERE card_id='swsh7-215' AND price_date='2026-08-25' AND lane='raw'"
        ).fetchall()
        self.assertEqual([r[0] for r in raw_cells], [2200.0])

    def test_unchanged_last_updated_marker_skips_the_run(self):
        # Docs rule: check last-updated.txt first; one real pull per publish.
        stats = self._sync(last_updated="2026-08-25T20:00:00Z")
        self.assertEqual(stats["priced"], 1)
        marker = runtime_setting(self.connection, sync_tcgcsv_prices.TCGCSV_LAST_UPDATED_KEY)
        self.assertEqual(marker["value"], "2026-08-25T20:00:00Z")

        again = self._sync(last_updated="2026-08-25T20:00:00Z")
        self.assertEqual(again, {"skipped_not_updated": 1})
        runs = self.connection.execute(
            "SELECT COUNT(*) FROM provider_sync_runs WHERE provider='tcgcsv'"
        ).fetchone()[0]
        self.assertEqual(runs, 1)

        advanced = self._sync(last_updated="2026-08-26T20:00:00Z")
        self.assertEqual(advanced["priced"], 1)

    def test_partial_crawl_prices_but_does_not_store_marker(self):
        # One flaky group: its cards keep yesterday's main via staleness; the
        # marker stays un-advanced so the next cron attempt re-crawls the day.
        def fake_build(categories, group_by_product=None, failed_groups=None):
            failed_groups.append((3, 604, "prices"))
            return MOONBREON_PRICES, {}
        with mock.patch.object(sync_tcgcsv_prices, "build_price_and_number_maps", side_effect=fake_build):
            stats = run_tcgcsv_price_sync(
                self.connection, product_price_map=None,
                price_date="2026-08-25", last_updated="2026-08-25T20:00:00Z",
            )
        self.assertEqual(stats["priced"], 1)
        self.assertEqual(stats["failed_groups"], 1)
        self.assertIsNone(
            runtime_setting(self.connection, sync_tcgcsv_prices.TCGCSV_LAST_UPDATED_KEY)
        )

    def test_broadly_failed_crawl_aborts_the_run(self):
        def fake_build(categories, group_by_product=None, failed_groups=None):
            failed_groups.extend((3, gid, "prices") for gid in range(50))
            return {}, {}
        with mock.patch.object(sync_tcgcsv_prices, "build_price_and_number_maps", side_effect=fake_build):
            with self.assertRaises(RuntimeError):
                run_tcgcsv_price_sync(self.connection, product_price_map=None, price_date="2026-08-25")
        run = self.connection.execute(
            "SELECT status FROM provider_sync_runs WHERE provider='tcgcsv' ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
        self.assertEqual(run[0], "failed")

    def test_force_bypasses_unchanged_marker(self):
        self._sync(last_updated="2026-08-25T20:00:00Z")
        forced = self._sync(last_updated="2026-08-25T20:00:00Z", force=True)
        self.assertEqual(forced["priced"], 1)

    def test_dry_run_does_not_store_last_updated_marker(self):
        self._sync(dry_run=True, last_updated="2026-08-25T20:00:00Z")
        marker = runtime_setting(self.connection, sync_tcgcsv_prices.TCGCSV_LAST_UPDATED_KEY)
        self.assertIsNone(marker)

    def test_no_match_leaves_card_untouched(self):
        self._seed_scrydex_snapshot()
        before = self._snapshot_row()
        stats = self._sync(product_price_map={})
        self.assertEqual(stats["priced"], 0)
        self.assertEqual(stats["skipped_no_match"], 1)
        self.assertEqual(self._snapshot_row(), before)

    def test_bookkeeping_and_generation_bump(self):
        self._sync()
        run = self.connection.execute(
            "SELECT provider, sync_scope, status, raw_snapshots_upserted FROM provider_sync_runs "
            "ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
        self.assertEqual((run[0], run[1], run[2], run[3]), ("tcgcsv", "raw-main", "succeeded", 1))
        setting = runtime_setting(self.connection, PRICING_SYNC_GENERATION_KEY)
        self.assertEqual(setting["value"], 1)
        self._sync()
        self.assertEqual(runtime_setting(self.connection, PRICING_SYNC_GENERATION_KEY)["value"], 2)

    def test_fetch_failure_marks_run_failed_and_reraises(self):
        with mock.patch.object(sync_tcgcsv_prices, "build_price_and_number_maps", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                run_tcgcsv_price_sync(self.connection, product_price_map=None, price_date="2026-08-25")
        run = self.connection.execute(
            "SELECT status, error_text FROM provider_sync_runs ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
        self.assertEqual(run[0], "failed")
        self.assertIn("boom", run[1])

    def test_dry_run_writes_nothing(self):
        stats = self._sync(dry_run=True)
        self.assertEqual(stats["priced"], 1)
        self.assertIsNone(self._snapshot_row())
        runs = self.connection.execute("SELECT COUNT(*) FROM provider_sync_runs").fetchone()[0]
        self.assertEqual(runs, 0)
        self.assertIsNone(runtime_setting(self.connection, PRICING_SYNC_GENERATION_KEY))

    def test_colliding_product_id_never_prices(self):
        # A second card sharing 246723 makes the id colliding for BOTH cards.
        upsert_card(
            self.connection, card_id="other-1", name="Other", set_name="S", number="1",
            rarity="C", variant="Raw", language="English", source_provider="scrydex",
            source_payload=MOONBREON_PAYLOAD,
        )
        self.connection.commit()
        reset_collision_guard_cache()
        stats = self._sync()
        self.assertEqual(stats["priced"], 0)
        self.assertEqual(stats["skipped_no_match"], 2)

    def test_number_verified_collision_resolution_prices_the_rightful_card(self):
        # The svp-221/222 shape: svp-222's payload mis-points at Birch's product
        # (Number 221), blocking svp-221 too. The product's Number names the
        # rightful card, so 221 prices and 222 stays on the Scrydex fallback.
        upsert_card(
            self.connection, card_id="wrong-222", name="Professor's Research",
            set_name="S", number="222", rarity="C", variant="Raw", language="English",
            source_provider="scrydex", source_payload=MOONBREON_PAYLOAD,
        )
        self.connection.commit()
        reset_collision_guard_cache()
        with mock.patch(
            "tcgcsv_adapter.fetch_group_products",
            return_value=[{
                "productId": 246723,
                "name": "Umbreon VMAX (Alternate Art Secret)",
                "extendedData": [{"name": "Number", "value": "215/203"}],
            }],
        ):
            stats = self._sync(group_by_product={"246723": (3, 3026)})
        self.assertEqual(stats["collisions_resolved"], 1)
        self.assertEqual(stats["priced"], 1)
        self.assertEqual(stats["skipped_no_match"], 1)
        self.assertEqual(self._snapshot_row()["main_raw_market_price"], 2276.45)
        wrong = self.connection.execute(
            "SELECT main_raw_market_price FROM card_price_snapshots WHERE card_id='wrong-222'"
        ).fetchone()
        self.assertIsNone(wrong)

    def test_number_mismatch_skips_and_logs_suspect(self):
        # Moonbreon's number is 215/203; a product claiming Number 216 is a
        # suspected Scrydex mis-map -> no main price, suspect recorded in notes.
        stats = self._sync(product_number_map={"246723": "216"})
        self.assertEqual(stats["priced"], 0)
        self.assertEqual(stats["skipped_number_mismatch"], 1)
        self.assertIsNone(self._snapshot_row())
        notes = json.loads(self.connection.execute(
            "SELECT notes_json FROM provider_sync_runs WHERE provider='tcgcsv' "
            "ORDER BY started_at DESC LIMIT 1"
        ).fetchone()[0])
        self.assertEqual(notes["skippedNumberMismatch"], 1)
        self.assertEqual(notes["numberMismatchSuspects"][0]["cardId"], "swsh7-215")
        self.assertEqual(notes["numberMismatchSuspects"][0]["productNumber"], "216")

    def test_confirmed_mismatch_clears_previously_written_main_lane(self):
        # Day 1 (unverified) writes a main price; day 2's verification confirms
        # the join is bad -> the stale main lane is cleared immediately, not
        # left to age out through the staleness window.
        self._sync()
        self.assertEqual(self._snapshot_row()["main_raw_market_price"], 2276.45)

        stats = self._sync(product_number_map={"246723": "216"})
        self.assertEqual(stats["skipped_number_mismatch"], 1)
        after = self._snapshot_row()
        self.assertIsNone(after["main_raw_market_price"])
        self.assertIsNone(after["main_raw_updated_at"])
        self.assertEqual(json.loads(after["main_raw_printings_json"]), {})
        cells = self.connection.execute(
            "SELECT COUNT(*) FROM card_price_history_cell WHERE card_id='swsh7-215' AND lane='raw_main'"
        ).fetchone()[0]
        self.assertEqual(cells, 0)

    def test_matching_or_missing_number_still_prices(self):
        stats = self._sync(product_number_map={"246723": "215"})
        self.assertEqual(stats["priced"], 1)
        self.assertEqual(stats["skipped_number_mismatch"], 0)

        self.connection.execute("DELETE FROM card_price_snapshots")
        self.connection.commit()
        stats = self._sync(product_number_map={})
        self.assertEqual(stats["priced"], 1)

    def test_verify_kill_switch_disables_the_check(self):
        os.environ["TCGCSV_VERIFY_NUMBERS"] = "0"
        try:
            stats = self._sync(product_number_map={"246723": "999"})
        finally:
            os.environ.pop("TCGCSV_VERIFY_NUMBERS", None)
        self.assertEqual(stats["priced"], 1)
        self.assertEqual(stats["skipped_number_mismatch"], 0)

    def test_manual_override_beats_payload_collision_and_verification(self):
        # The override replaces the payload's product id and skips the number
        # check (a human verified it) — the svp-222 -> 664827 shape.
        prices = {"664827": {"Normal": {
            "productId": 664827, "subTypeName": "Normal", "marketPrice": 0.21,
        }}}
        with mock.patch.object(
            sync_tcgcsv_prices, "load_tcgplayer_id_overrides",
            return_value={"swsh7-215": "664827"},
        ):
            stats = self._sync(
                product_price_map=prices,
                product_number_map={"664827": "222"},  # mismatches 215 — override must ignore
            )
        self.assertEqual(stats["overrides_applied"], 1)
        self.assertEqual(stats["priced"], 1)
        self.assertEqual(stats["skipped_number_mismatch"], 0)
        after = self._snapshot_row()
        self.assertEqual(after["main_raw_market_price"], 0.21)
        # The printings map is built from the OVERRIDE pid, not the payload claim.
        self.assertEqual(json.loads(after["main_raw_printings_json"]), {"Normal": {
            "subTypeName": "Normal", "market": 0.21, "low": None,
            "mid": None, "high": None, "directLow": None,
        }})

    def test_kit_twins_with_same_name_and_number_both_price(self):
        # One TCGplayer product covers both kit halves of the same card.
        upsert_card(
            self.connection, card_id="tkXa-19", name="Hau", set_name="Kit A", number="19/30",
            rarity="C", variant="Raw", language="English", source_provider="scrydex",
            source_payload=MOONBREON_PAYLOAD,
        )
        upsert_card(
            self.connection, card_id="tkXb-19", name="Hau", set_name="Kit B", number="19/30",
            rarity="C", variant="Raw", language="English", source_provider="scrydex",
            source_payload=MOONBREON_PAYLOAD,
        )
        self.connection.commit()
        reset_collision_guard_cache()
        with mock.patch(
            "tcgcsv_adapter.fetch_group_products",
            return_value=[{
                "productId": 246723, "name": "Hau",
                "extendedData": [{"name": "Number", "value": "19/30"}],
            }],
        ):
            stats = self._sync(group_by_product={"246723": (3, 999)})
        # Moonbreon's own number (215/203) does not match "19/30" so only the
        # twins price; the mismatch skip covers the seed card.
        self.assertEqual(stats["collisions_resolved"], 1)
        for cid in ("tkXa-19", "tkXb-19"):
            row = self.connection.execute(
                "SELECT main_raw_market_price FROM card_price_snapshots WHERE card_id=?", (cid,)
            ).fetchone()
            self.assertEqual(row[0], 2276.45, cid)

    def test_same_number_different_names_resolved_by_product_name(self):
        upsert_card(
            self.connection, card_id="tkYa-22", name="Pokémon Collector", set_name="Kit A",
            number="22/30", rarity="C", variant="Raw", language="English",
            source_provider="scrydex", source_payload=MOONBREON_PAYLOAD,
        )
        upsert_card(
            self.connection, card_id="tkYb-22", name="Pokémon Communication", set_name="Kit B",
            number="22/30", rarity="C", variant="Raw", language="English",
            source_provider="scrydex", source_payload=MOONBREON_PAYLOAD,
        )
        self.connection.commit()
        reset_collision_guard_cache()
        with mock.patch(
            "tcgcsv_adapter.fetch_group_products",
            return_value=[{
                "productId": 246723, "name": "Pokemon Collector (#22)",
                "extendedData": [{"name": "Number", "value": "22/30"}],
            }],
        ):
            self._sync(group_by_product={"246723": (3, 999)})
        collector = self.connection.execute(
            "SELECT main_raw_market_price FROM card_price_snapshots WHERE card_id='tkYa-22'"
        ).fetchone()
        communication = self.connection.execute(
            "SELECT main_raw_market_price FROM card_price_snapshots WHERE card_id='tkYb-22'"
        ).fetchone()
        self.assertEqual(collector[0], 2276.45)
        self.assertIsNone(communication)

    def _upsert_multi_printing_card(self, card_id: str, payload: dict, number: str = "2"):
        upsert_card(
            self.connection, card_id=card_id, name="Blastoise", set_name="Base",
            number=number, rarity="Holo Rare", variant="Raw", language="English",
            source_provider="scrydex", source_payload=payload,
        )
        self.connection.commit()
        reset_collision_guard_cache()

    def _printings_json(self, card_id: str):
        row = self.connection.execute(
            "SELECT main_raw_printings_json FROM card_price_snapshots WHERE card_id=?", (card_id,)
        ).fetchone()
        return json.loads(row[0]) if row is not None else None

    def test_printings_json_one_pid_two_subtypes_null_market_excluded(self):
        # The real Blastoise 603150 shape: one product, First Edition + Unlimited
        # subtypes; only the subtype with actual sales lands in the JSON — the
        # null-market printing keeps its Scrydex rows untouched (user decision).
        self._upsert_multi_printing_card("base1-2", {"variants": [
            {"name": "First Edition", "marketplaces": [{"name": "tcgplayer", "product_id": "603150"}]},
            {"name": "Unlimited", "marketplaces": [{"name": "tcgplayer", "product_id": "603150"}]},
        ]})
        prices = {"603150": {
            "1st Edition Holofoil": {"productId": 603150, "subTypeName": "1st Edition Holofoil",
                                     "marketPrice": 1000.0, "lowPrice": 900.0},
            "Unlimited Holofoil": {"productId": 603150, "subTypeName": "Unlimited Holofoil",
                                   "marketPrice": None},
        }}
        self._sync(product_price_map=prices)
        self.assertEqual(self._printings_json("base1-2"), {"First Edition": {
            "subTypeName": "1st Edition Holofoil", "market": 1000.0, "low": 900.0,
            "mid": None, "high": None, "directLow": None,
        }})
        cells = self.connection.execute(
            "SELECT cell_key FROM card_price_history_cell "
            "WHERE card_id='base1-2' AND price_date='2026-08-25' AND lane='raw_main'"
        ).fetchall()
        self.assertEqual([c[0] for c in cells], ["raw_main|1st Edition Holofoil|NM"])

    def test_printings_json_two_pids_both_priced_writes_one_cell_each(self):
        self._upsert_multi_printing_card("sv1-1", {"variants": [
            {"name": "Holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "111"}]},
            {"name": "Reverse Holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "222"}]},
        ]})
        prices = {
            "111": {"Holofoil": {"productId": 111, "subTypeName": "Holofoil", "marketPrice": 12.0}},
            "222": {"Reverse Holofoil": {"productId": 222, "subTypeName": "Reverse Holofoil", "marketPrice": 20.0}},
        }
        self._sync(product_price_map=prices)
        printings = self._printings_json("sv1-1")
        self.assertEqual(set(printings), {"Holofoil", "Reverse Holofoil"})
        self.assertEqual(printings["Reverse Holofoil"]["market"], 20.0)
        cells = self.connection.execute(
            "SELECT cell_key, market FROM card_price_history_cell "
            "WHERE card_id='sv1-1' AND price_date='2026-08-25' AND lane='raw_main' ORDER BY cell_key"
        ).fetchall()
        self.assertEqual([(c[0], c[1]) for c in cells], [
            ("raw_main|Holofoil|NM", 12.0),
            ("raw_main|Reverse Holofoil|NM", 20.0),
        ])
        # The headline main selection is still a single printing.
        row = self.connection.execute(
            "SELECT main_raw_market_price, main_raw_variant FROM card_price_snapshots WHERE card_id='sv1-1'"
        ).fetchone()
        self.assertEqual((row[0], row[1]), (12.0, "Holofoil"))

    def test_printings_json_number_mismatched_pid_contributes_nothing(self):
        # The secondary pid claims a different card Number -> its printing is
        # excluded; the verified main pid still prices.
        self._upsert_multi_printing_card("sv1-3", {"variants": [
            {"name": "Holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "333"}]},
            {"name": "Reverse Holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "444"}]},
        ]}, number="3")
        prices = {
            "333": {"Holofoil": {"productId": 333, "subTypeName": "Holofoil", "marketPrice": 5.0}},
            "444": {"Reverse Holofoil": {"productId": 444, "subTypeName": "Reverse Holofoil", "marketPrice": 9.0}},
        }
        self._sync(product_price_map=prices, product_number_map={"333": "3", "444": "999"})
        self.assertEqual(set(self._printings_json("sv1-3")), {"Holofoil"})

    def test_printings_json_skips_blocked_colliding_pid(self):
        # pid 444 is shared with another card -> colliding -> its printing is
        # skipped, while the clean main pid still prices and fills the JSON.
        self._upsert_multi_printing_card("sv1-4", {"variants": [
            {"name": "Holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "333"}]},
            {"name": "Reverse Holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "444"}]},
        ]}, number="4")
        self._upsert_multi_printing_card("sv1-5", {"variants": [
            {"name": "Reverse Holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "444"}]},
        ]}, number="5")
        prices = {
            "333": {"Holofoil": {"productId": 333, "subTypeName": "Holofoil", "marketPrice": 5.0}},
            "444": {"Reverse Holofoil": {"productId": 444, "subTypeName": "Reverse Holofoil", "marketPrice": 9.0}},
        }
        self._sync(product_price_map=prices)
        self.assertEqual(set(self._printings_json("sv1-4")), {"Holofoil"})

    def test_ambiguous_or_unfetchable_collision_stays_blocked(self):
        upsert_card(
            self.connection, card_id="other-1", name="Other", set_name="S", number="1",
            rarity="C", variant="Raw", language="English", source_provider="scrydex",
            source_payload=MOONBREON_PAYLOAD,
        )
        self.connection.commit()
        reset_collision_guard_cache()
        # Products fetch fails -> no owner resolved -> both stay blocked.
        with mock.patch("tcgcsv_adapter.fetch_group_products", side_effect=RuntimeError("down")):
            stats = self._sync(group_by_product={"246723": (3, 3026)})
        self.assertEqual(stats["collisions_resolved"], 0)
        self.assertEqual(stats["priced"], 0)


class DisabledFlagTests(unittest.TestCase):
    def setUp(self):
        self._prev = os.environ.get("TCGCSV_SYNC_ENABLED")
        self.addCleanup(self._restore)

    def _restore(self):
        if self._prev is None:
            os.environ.pop("TCGCSV_SYNC_ENABLED", None)
        else:
            os.environ["TCGCSV_SYNC_ENABLED"] = self._prev

    def test_enabled_values(self):
        for value, expected in (("1", True), ("true", True), ("YES", True), ("on", True),
                                ("0", False), ("", False), ("no", False)):
            os.environ["TCGCSV_SYNC_ENABLED"] = value
            self.assertEqual(tcgcsv_sync_enabled(), expected, value)
        os.environ.pop("TCGCSV_SYNC_ENABLED", None)
        self.assertFalse(tcgcsv_sync_enabled())

    def test_main_is_noop_when_disabled(self):
        os.environ.pop("TCGCSV_SYNC_ENABLED", None)
        with tempfile.TemporaryDirectory() as tempdir:
            database_path = Path(tempdir) / "never-created.sqlite"
            self.assertEqual(_main(["--database-path", str(database_path)]), 0)
            self.assertFalse(database_path.exists())


if __name__ == "__main__":
    unittest.main()
