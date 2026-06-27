"""End-to-end: sync_ppt_catalog joins a PPT card to our catalog by tcgplayer_id and
writes snapshot + daily + cell rows under provider 'ppt', readable by the resolvers.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    _graded_contexts_payload,
    _is_raw_phantom_price,
    _resolve_graded_context_entry,
    apply_schema,
    card_price_trend_list,
    connect,
    resolve_graded_entry_from_cells,
    upsert_card,
    upsert_fx_rate_snapshot,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from server import _apply_price_history_cells_schema_patch  # noqa: E402
from sync_ppt_catalog import (  # noqa: E402
    _coerce_signal_count,
    _coerce_signal_float,
    iter_ppt_cards_from_exports,
    parse_export_cards,
    parse_export_ebay,
    parse_export_population,
    sync_ppt_cards,
    sync_ppt_population,
    upsert_ppt_card_population,
    upsert_ppt_card_pricing,
)


class SignalCoercionTests(unittest.TestCase):
    """csv.DictReader yields strings, so the eBay export's salesCount/prices arrive
    as text ("37", "288.23"). The coercers must parse numeric strings — the old
    int/float-only guard silently dropped them, NULLing saleCount on every row."""

    def test_count_parses_numeric_strings(self):
        self.assertEqual(_coerce_signal_count("37"), 37)
        self.assertEqual(_coerce_signal_count("1,234"), 1234)
        self.assertEqual(_coerce_signal_count(37), 37)
        self.assertIsNone(_coerce_signal_count(""))
        self.assertIsNone(_coerce_signal_count(None))
        self.assertIsNone(_coerce_signal_count(True))

    def test_float_parses_numeric_strings(self):
        self.assertEqual(_coerce_signal_float("288.23"), 288.23)
        self.assertEqual(_coerce_signal_float("$1,234.5"), 1234.5)
        self.assertIsNone(_coerce_signal_float(""))
        self.assertIsNone(_coerce_signal_float("n/a"))

PPT_MOONBREON = {
    "tcgPlayerId": "246723",
    "externalCatalogId": "swsh7-215",
    "prices": {"market": 2276.45, "low": 1999.0, "primaryPrinting": "Holofoil"},
    "variants": {"Holofoil": {"Near Mint": {"price": 2276.45}}},
    "ebay": {"salesByGrade": {
        "psa10": {"medianPrice": 4524.88, "minPrice": 4100.0, "maxPrice": 4900.0, "count": 37},
        "psa9": {"medianPrice": 2305.0, "count": 12},
    }},
}


class SyncPptCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "ppt.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        # Our catalog card carrying the TCGplayer product id PPT joins on.
        upsert_card(
            self.connection, card_id="swsh7-215", name="Umbreon VMAX",
            set_name="Evolving Skies", number="215/203", rarity="Secret",
            variant="Raw", language="English", source_provider="scrydex",
            tcgplayer_id="246723",
        )
        self.connection.commit()
        self._prev_source = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"
        self.addCleanup(self._restore)

    def _restore(self):
        if self._prev_source is None:
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
        else:
            os.environ["PRICE_HISTORY_SOURCE"] = self._prev_source

    def test_sync_writes_snapshot_daily_and_cells_under_ppt(self):
        stats = sync_ppt_cards(self.connection, [PPT_MOONBREON], price_date="2026-06-25")
        self.assertEqual(stats["matched"], 1)
        self.assertEqual(stats["seen"], 1)

        # Snapshot row written under provider 'ppt' with the right graded blob.
        snap = self.connection.execute(
            "SELECT provider, graded_contexts_json, raw_contexts_json FROM card_price_snapshots WHERE card_id='swsh7-215'"
        ).fetchone()
        self.assertIsNotNone(snap)
        self.assertEqual(snap[0], "ppt")
        graded = json.loads(snap[1])["graders"]
        self.assertEqual(graded["PSA"]["10"][0]["market"], 4524.88)

        # Daily row written for the date.
        daily = self.connection.execute(
            "SELECT COUNT(*) FROM card_price_history_daily WHERE card_id='swsh7-215' AND provider='ppt' AND price_date='2026-06-25'"
        ).fetchone()[0]
        self.assertEqual(daily, 1)

        # Cells auto-decomposed; resolver surfaces the PSA 10 price.
        cell_rows = self.connection.execute(
            "SELECT lane, grader, grade, variant_key, condition, is_perfect, is_signed, is_error, market "
            "FROM card_price_history_cell WHERE card_id='swsh7-215' AND price_date='2026-06-25'"
        ).fetchall()
        cols = ("lane", "grader", "grade", "variant_key", "condition", "is_perfect", "is_signed", "is_error", "market")
        rows = [dict(zip(cols, r)) for r in cell_rows]
        chosen = resolve_graded_entry_from_cells(rows, grader="PSA", grade="10", variant=None)
        self.assertIsNotNone(chosen)
        self.assertEqual(chosen["market"], 4524.88)

    def test_unmatched_when_no_local_card(self):
        result = upsert_ppt_card_pricing(
            self.connection, {"tcgPlayerId": "999999", "prices": {"market": 5.0}}, price_date="2026-06-25"
        )
        self.assertEqual(result["matched"], 0)
        self.assertEqual(result["reason"], "no_local_card")

    def test_unmatched_when_no_tcgplayer_id(self):
        result = upsert_ppt_card_pricing(
            self.connection, {"prices": {"market": 5.0}}, price_date="2026-06-25"
        )
        self.assertEqual(result["matched"], 0)
        self.assertEqual(result["reason"], "no_tcgplayer_id")


class SignalsOnlyMergeTests(unittest.TestCase):
    """signals_only annotates an existing (Scrydex) graded entry's payload with PPT
    trust signals WITHOUT changing the displayed price, provider, or the raw lane."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "ppt.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        upsert_card(
            self.connection, card_id="swsh7-215", name="Umbreon VMAX",
            set_name="Evolving Skies", number="215/203", rarity="Secret",
            variant="Raw", language="English", source_provider="scrydex",
            tcgplayer_id="246723",
        )
        # Seed the EXISTING Scrydex snapshot: a raw NM lane + a graded PSA 10 entry,
        # both carrying scrydex provider + scrydex prices and NO trust-signal payload.
        scrydex_graded = {"graders": {"PSA": {"10": [{
            "grader": "PSA", "grade": "10", "variant": None,
            "isPerfect": False, "isSigned": False, "isError": False,
            "provider": "scrydex", "currencyCode": "USD",
            "low": 4000.0, "market": 4400.0, "mid": 4350.0, "high": 4800.0,
            "trend": 4380.0, "payload": {},
        }]}}}
        scrydex_raw = {"variants": {"Holofoil": {
            "variant": "Holofoil", "variantKey": "holofoil",
            "conditions": {"NM": {
                "condition": "NM", "variant": "Holofoil", "provider": "scrydex",
                "currencyCode": "USD", "market": 2200.0, "low": 2000.0, "payload": {},
            }},
        }}}
        upsert_price_snapshot(
            self.connection, card_id="swsh7-215", provider="scrydex",
            display_currency_code="USD",
            raw_contexts=scrydex_raw, graded_contexts=scrydex_graded,
            default_raw_market_price=2200.0, default_raw_low_price=2000.0,
        )
        self.connection.commit()

    def _snapshot(self):
        row = self.connection.execute(
            "SELECT provider, graded_contexts_json, raw_contexts_json "
            "FROM card_price_snapshots WHERE card_id='swsh7-215'"
        ).fetchone()
        return {
            "provider": row[0],
            "graded": _graded_contexts_payload(row[1]),
            "raw": json.loads(row[2]),
        }

    # Same join key as PPT_MOONBREON but with the full eBay trust-signal set on PSA 10.
    PPT_WITH_SIGNALS = {
        "tcgPlayerId": "246723",
        "ebay": {"salesByGrade": {
            "psa10": {"medianPrice": 4524.88, "smartMarketPrice": 4524.88,
                      "smartMarketConfidence": "high", "count": 37},
            "psa9": {"medianPrice": 2305.0, "count": 12},
        }},
    }

    def _signal_rows(self, card_id="swsh7-215"):
        rows = self.connection.execute(
            "SELECT grader, grade, confidence, count, smart, source, median "
            "FROM ppt_graded_signals WHERE card_id = ? ORDER BY grader, grade",
            (card_id,),
        ).fetchall()
        return [dict(zip(("grader", "grade", "confidence", "count", "smart", "source", "median"), r)) for r in rows]

    def test_signals_only_writes_signal_table_and_keeps_scrydex_price_and_provider(self):
        stats = sync_ppt_cards(
            self.connection, [self.PPT_WITH_SIGNALS], price_date="2026-06-25", signals_only=True
        )
        self.assertEqual(stats["matched"], 1)
        # One row per PPT grade (PSA 10 + PSA 9) was upserted into the side table.
        self.assertEqual(stats["annotated"], 2)

        snap = self._snapshot()
        # Snapshot provider unchanged (still scrydex — signals-only never flips it).
        self.assertEqual(snap["provider"], "scrydex")
        entry = _resolve_graded_context_entry(snap["graded"], grader="PSA", grade="10")
        # Displayed graded price (and low/high/trend/provider) is the ORIGINAL Scrydex
        # value, NOT the PPT median (4524.88) — the price cannot move.
        self.assertEqual(entry["market"], 4400.0)
        self.assertEqual(entry["low"], 4000.0)
        self.assertEqual(entry["high"], 4800.0)
        self.assertEqual(entry["trend"], 4380.0)
        self.assertEqual(entry["provider"], "scrydex")
        # The snapshot JSON payload is NOT mutated anymore — signals live in the table.
        self.assertEqual(entry["payload"], {})

        # The durable side table carries the PPT trust signals the RN trust line renders.
        signals = {(r["grader"], r["grade"]): r for r in self._signal_rows()}
        self.assertEqual(signals[("PSA", "10")]["confidence"], "high")
        self.assertEqual(signals[("PSA", "10")]["count"], 37)
        self.assertEqual(signals[("PSA", "10")]["smart"], 4524.88)

    def test_signals_only_leaves_raw_lane_untouched(self):
        sync_ppt_cards(self.connection, [self.PPT_WITH_SIGNALS], price_date="2026-06-25", signals_only=True)
        raw_nm = self._snapshot()["raw"]["variants"]["Holofoil"]["conditions"]["NM"]
        self.assertEqual(raw_nm["market"], 2200.0)
        self.assertEqual(raw_nm["provider"], "scrydex")
        self.assertEqual(raw_nm["payload"], {})

    def test_signals_only_no_snapshot_does_not_create_priced_row(self):
        # A different card with NO existing snapshot: signals-only writes signal rows
        # but never fabricates a priced snapshot row.
        upsert_card(
            self.connection, card_id="other-1", name="Other", set_name="S", number="1",
            rarity="C", variant="Raw", language="English", source_provider="scrydex",
            tcgplayer_id="246723",
        )
        sync_ppt_cards(self.connection, [self.PPT_WITH_SIGNALS], price_date="2026-06-25", signals_only=True)
        none_snap = self.connection.execute(
            "SELECT COUNT(*) FROM card_price_snapshots WHERE card_id='other-1'"
        ).fetchone()[0]
        self.assertEqual(none_snap, 0)  # no priced row fabricated for the unsnapshotted card

    def test_signals_only_upsert_overwrites_prior_signal_row(self):
        sync_ppt_cards(self.connection, [self.PPT_WITH_SIGNALS], price_date="2026-06-25", signals_only=True)
        updated = {
            "tcgPlayerId": "246723",
            "ebay": {"salesByGrade": {
                "psa10": {"medianPrice": 4600.0, "smartMarketPrice": 4600.0,
                          "smartMarketConfidence": "medium", "count": 40},
            }},
        }
        sync_ppt_cards(self.connection, [updated], price_date="2026-06-26", signals_only=True)
        signals = {(r["grader"], r["grade"]): r for r in self._signal_rows()}
        # PSA 10 row updated in place (ON CONFLICT), not duplicated.
        self.assertEqual(signals[("PSA", "10")]["confidence"], "medium")
        self.assertEqual(signals[("PSA", "10")]["count"], 40)
        # PSA 9 from the first sync is still present (separate primary key).
        self.assertIn(("PSA", "9"), signals)


class ExportParserTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.cards_path = Path(self.tempdir.name) / "cards.csv"
        self.ebay_path = Path(self.tempdir.name) / "ebay.csv"
        # Real column layout from the Business dump.
        self.cards_path.write_text(
            "tcgPlayerId,name,setName,setId,cardNumber,rarity,language,printing,marketPrice,lowPrice,sellers,lastPriceUpdate\n"
            "246723,Umbreon VMAX,Evolving Skies,1,215/203,Secret,english,Holofoil,2276.45,1250,14,2026-06-24T00:00:00Z\n"
            "600789,Basculin,BW,2,x,Common,japanese,Unlimited,0.25,0,1,2026-06-24T00:00:00Z\n"
        )
        self.ebay_path.write_text(
            "tcgPlayerId,grade,salesCount,averagePrice,medianPrice,smartMarketPrice,smartMarketConfidence,marketPrice7Day,marketTrend,salesVelocityWeekly\n"
            "246723,psa10,215,4500,3499,4525,high,4500,up,5\n"
            "246723,ungraded,92,3150,3150,1647,low,2025,flat,2\n"
        )

    def test_parse_cards_and_ebay(self):
        cards = parse_export_cards(str(self.cards_path))
        self.assertEqual(cards["246723"]["prices"]["market"], "2276.45")
        self.assertEqual(cards["246723"]["variants"]["Holofoil"]["Near Mint"]["price"], "2276.45")
        ebay = parse_export_ebay(str(self.ebay_path))
        self.assertEqual(ebay["246723"]["psa10"]["smartMarketPrice"], "4525")
        self.assertIn("ungraded", ebay["246723"])  # parsed; skipped later by grade-key regex

    def test_iter_merges_into_ppt_cards(self):
        merged = {c["tcgPlayerId"]: c for c in iter_ppt_cards_from_exports(str(self.cards_path), str(self.ebay_path))}
        moon = merged["246723"]
        self.assertEqual(moon["prices"]["market"], "2276.45")
        self.assertEqual(moon["ebay"]["salesByGrade"]["psa10"]["smartMarketPrice"], "4525")
        self.assertNotIn("ebay", merged["600789"])  # no graded rows for Basculin


class PopulationOverlayTests(unittest.TestCase):
    """The GemRate population overlay writes population_json onto an existing
    snapshot WITHOUT touching its provider, prices, or raw/graded lanes."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "ppt.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            self.connection, card_id="swsh7-215", name="Umbreon VMAX",
            set_name="Evolving Skies", number="215/203", rarity="Secret",
            variant="Raw", language="English", source_provider="scrydex",
            tcgplayer_id="246723",
        )
        upsert_price_snapshot(
            self.connection, card_id="swsh7-215", provider="scrydex",
            display_currency_code="USD",
            raw_contexts={"variants": {}}, graded_contexts={"graders": {}},
            default_raw_market_price=2200.0, default_raw_low_price=2000.0,
        )
        self.connection.commit()

    def _row(self):
        return self.connection.execute(
            "SELECT provider, population_json, default_raw_market_price "
            "FROM card_price_snapshots WHERE card_id='swsh7-215'"
        ).fetchone()

    GEMRATE = {
        "tcgPlayerId": "246723",
        "populationByGrader": {
            "PSA": {"g10": 2500, "g9": 9500, "totalPopulation": 12000, "gemRate": 20.83},
            "BGS": {"g10": 100, "g9_5": 730, "totalPopulation": 1830, "gemRate": 7.1},
        },
    }

    def test_overlay_writes_population_without_touching_price(self):
        result = upsert_ppt_card_population(self.connection, self.GEMRATE)
        self.connection.commit()
        self.assertEqual(result["matched"], 1)
        self.assertEqual(result["graders"], ["BGS", "PSA"])

        provider, population_json, market = self._row()
        population = json.loads(population_json)
        self.assertEqual(population["PSA"]["grades"], {"10": 2500, "9": 9500})
        self.assertEqual(population["BGS"]["grades"], {"10": 100, "9.5": 730})
        # The price + provider are untouched by the metadata overlay.
        self.assertEqual(provider, "scrydex")
        self.assertEqual(market, 2200.0)

    def test_overlay_no_snapshot_is_noop(self):
        upsert_card(
            self.connection, card_id="other-1", name="No Snapshot",
            set_name="Set", number="1", rarity="Common", variant="Raw",
            language="English", source_provider="scrydex", tcgplayer_id="999999",
        )
        result = upsert_ppt_card_population(
            self.connection, {"tcgPlayerId": "999999", "populationByGrader": {"PSA": {"g10": 5}}}
        )
        self.assertEqual(result["matched"], 0)
        self.assertEqual(result["reason"], "no_snapshot")

    def test_parse_export_population_and_batch_sync(self):
        path = Path(self.tempdir.name) / "population.csv"
        path.write_text(
            "tcgPlayerId,grader,g10,g9,g9_5,gemRate,totalPopulation\n"
            "246723,PSA,2500,9500,,20.83,12000\n"
            "246723,BGS,100,,730,7.1,1830\n"
            "999999,PSA,5,5,,50,10\n"  # no local card → unmatched
        )
        parsed = parse_export_population(str(path))
        self.assertEqual(set(parsed["246723"]["populationByGrader"]), {"PSA", "BGS"})

        stats = sync_ppt_population(self.connection, parsed.values())
        self.connection.commit()
        self.assertEqual(stats["matched"], 1)
        self.assertEqual(stats["unmatched_no_card"], 1)
        population = json.loads(self._row()[1])
        self.assertEqual(population["PSA"]["totalPopulation"], 12000)


class PptSignalDurabilityTests(unittest.TestCase):
    """The CORE durability guarantee: PPT graded trust signals survive a daily
    Scrydex price sync that wholesale-overwrites graded_contexts_json, because the
    signals live in the SEPARATE ppt_graded_signals table and are merged at read."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "ppt.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        upsert_card(
            self.connection, card_id="swsh7-215", name="Umbreon VMAX",
            set_name="Evolving Skies", number="215/203", rarity="Secret",
            variant="Raw", language="English", source_provider="scrydex",
            tcgplayer_id="246723",
        )
        # Seed a Scrydex snapshot with a PSA 10 graded entry (no trust-signal payload).
        scrydex_graded = {"graders": {"PSA": {"10": [{
            "grader": "PSA", "grade": "10", "variant": None,
            "isPerfect": False, "isSigned": False, "isError": False,
            "provider": "scrydex", "currencyCode": "USD",
            "low": 4000.0, "market": 4400.0, "mid": 4350.0, "high": 4800.0,
            "trend": 4380.0, "payload": {},
        }]}}}
        upsert_price_snapshot(
            self.connection, card_id="swsh7-215", provider="scrydex",
            display_currency_code="USD",
            raw_contexts={"variants": {}}, graded_contexts=scrydex_graded,
        )
        # A daily history row so the trend list has a graded point to resolve.
        upsert_price_history_daily(
            self.connection, card_id="swsh7-215", provider="scrydex",
            price_date="2026-06-24", graded_contexts=scrydex_graded,
        )
        self.connection.commit()
        self._prev_source = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "json"  # read trend from graded_contexts_json
        self.addCleanup(self._restore)

    def _restore(self):
        if self._prev_source is None:
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
        else:
            os.environ["PRICE_HISTORY_SOURCE"] = self._prev_source

    PPT_WITH_SIGNALS = {
        "tcgPlayerId": "246723",
        "ebay": {"salesByGrade": {
            "psa10": {"medianPrice": 4524.88, "smartMarketPrice": 4524.88,
                      "smartMarketConfidence": "high", "count": 37},
        }},
    }

    def test_signals_survive_scrydex_overwrite(self):
        # 1) Write PPT signals (signals-only).
        sync_ppt_cards(self.connection, [self.PPT_WITH_SIGNALS], price_date="2026-06-25", signals_only=True)

        # 2) Simulate the daily Scrydex price sync: a FRESH graded_contexts blob with
        #    NO trust-signal payload, written via the same wholesale-overwrite path.
        fresh_scrydex_graded = {"graders": {"PSA": {"10": [{
            "grader": "PSA", "grade": "10", "variant": None,
            "isPerfect": False, "isSigned": False, "isError": False,
            "provider": "scrydex", "currencyCode": "USD",
            "low": 4100.0, "market": 4500.0, "mid": 4450.0, "high": 4900.0,
            "trend": 4480.0, "payload": {},
        }]}}}
        upsert_price_snapshot(
            self.connection, card_id="swsh7-215", provider="scrydex",
            display_currency_code="USD",
            raw_contexts={"variants": {}}, graded_contexts=fresh_scrydex_graded,
        )
        self.connection.commit()

        # Confirm the snapshot JSON was indeed clobbered (no signals left in it).
        snap = self.connection.execute(
            "SELECT graded_contexts_json FROM card_price_snapshots WHERE card_id='swsh7-215'"
        ).fetchone()
        entry = _resolve_graded_context_entry(_graded_contexts_payload(snap[0]), grader="PSA", grade="10")
        self.assertEqual(entry["payload"], {})  # signals are gone from the JSON

        # 3) Read via card_price_trend_list — the trust line STILL shows up because it
        #    is merged from the durable ppt_graded_signals table.
        trend = card_price_trend_list(
            self.connection, "swsh7-215", mode="graded", provider="scrydex", grader="PSA",
        )
        psa10 = next(r for r in trend["rows"] if r["key"] == "PSA 10")
        self.assertEqual(psa10["confidence"], "high")
        self.assertEqual(psa10["saleCount"], 37)
        # The displayed price/provider is unchanged: the FRESH Scrydex market, not PPT.
        self.assertEqual(psa10["currentPrice"], 4500.0)
        self.assertEqual(trend["provider"], "ebay")  # graded display provider label


class RawPhantomSuppressionTests(unittest.TestCase):
    """_is_raw_phantom_price: suppress a raw NM market that exceeds the card's OWN
    PSA 10 (currency-aware)."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "phantom.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        # JPY->USD rate (~0.0061861) for the currency-aware case.
        upsert_fx_rate_snapshot(
            self.connection, base_currency="JPY", quote_currency="USD",
            rate=0.0061861, source="test",
        )
        self.connection.commit()

    @staticmethod
    def _raw(market, currency="USD"):
        return {"variants": {"Holofoil": {"variant": "Holofoil", "conditions": {
            "NM": {"condition": "NM", "variant": "Holofoil", "currencyCode": currency, "market": market}
        }}}}

    @staticmethod
    def _graded(psa10_market, currency="USD"):
        if psa10_market is None:
            return {"graders": {}}
        return {"graders": {"PSA": {"10": [{
            "grader": "PSA", "grade": "10", "variant": None,
            "isPerfect": False, "isSigned": False, "isError": False,
            "currencyCode": currency, "market": psa10_market,
        }]}}}

    def test_raw_above_psa10_is_phantom(self):
        # raw NM $50 > PSA10 $100? no — use raw $50 vs PSA10 $40 -> raw>slab -> phantom.
        self.assertTrue(_is_raw_phantom_price(self.connection, self._raw(50.0), self._graded(40.0)))

    def test_raw_below_psa10_not_phantom(self):
        # raw $5 vs PSA10 $50 -> raw < slab -> NOT phantom (also below $20 floor anyway).
        self.assertFalse(_is_raw_phantom_price(self.connection, self._raw(5.0), self._graded(50.0)))

    def test_raw_no_psa10_not_phantom(self):
        # Conservative: no PSA10 to compare against -> never suppress.
        self.assertFalse(_is_raw_phantom_price(self.connection, self._raw(500.0), self._graded(None)))

    def test_below_min_floor_not_phantom(self):
        # raw $15 > PSA10 $10 but raw is under the $20 trivia floor -> not suppressed.
        self.assertFalse(_is_raw_phantom_price(self.connection, self._raw(15.0), self._graded(10.0)))

    def test_jpy_raw_converts_below_psa10_not_phantom(self):
        # raw 1000 JPY (~$6.19) converts BELOW PSA10 $16 -> not phantom.
        self.assertFalse(
            _is_raw_phantom_price(self.connection, self._raw(1000.0, "JPY"), self._graded(16.0))
        )

    def test_jpy_raw_converts_above_psa10_is_phantom(self):
        # raw 4000 JPY (~$24.7) > PSA10 $16 -> phantom (currency-aware compare).
        self.assertTrue(
            _is_raw_phantom_price(self.connection, self._raw(4000.0, "JPY"), self._graded(16.0))
        )

    def test_summary_suppression_via_trend_raw_mode(self):
        # End-to-end raw trend: a phantom card's raw row nulls currentPrice + flags it.
        upsert_card(
            self.connection, card_id="dp-016", name="Pikachu", set_name="DPt-P",
            number="016", rarity="Promo", variant="Raw", language="Japanese",
            source_provider="scrydex", tcgplayer_id=None,
        )
        upsert_price_snapshot(
            self.connection, card_id="dp-016", provider="scrydex",
            display_currency_code="USD",
            raw_contexts=self._raw(2474.0), graded_contexts=self._graded(70.0),
            default_raw_market_price=2474.0,
        )
        self.connection.commit()
        trend = card_price_trend_list(self.connection, "dp-016", mode="raw", provider="scrydex")
        self.assertTrue(trend["rows"])
        for row in trend["rows"]:
            self.assertIsNone(row["currentPrice"])
            self.assertEqual(row["suppressionReason"], "phantom")


if __name__ == "__main__":
    unittest.main()
