"""market_analytics: the Market Analytics tab payloads (pulse/index, breadth,
heatmap, bargains, breaking out, set baskets, grading) and the card-page price
position. Guards the USD/same-printing rules, price_quality exclusion, the
collectibility filter, windowLabel honesty, the version-token skip, and the
HTTP routes' guest/owner split.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, upsert_runtime_setting, utc_now  # noqa: E402
import market_analytics  # noqa: E402
import meta_pulse  # noqa: E402
import price_lows  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

# Graded-cell freshness reads the wall clock (find_top_graded's rule), so the
# fixture lives on the real calendar.
TODAY = datetime.now(timezone.utc).date()


def _d(days_ago: int) -> str:
    return (TODAY - timedelta(days=days_ago)).isoformat()


class MarketAnalyticsFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "analytics.sqlite"
        self.connection = connect(self.database_path)
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        self.connection.commit()

    def _card(
        self, card_id: str, *, set_id: str = "sv1", name: str | None = None, language: str = "English",
        game: str = "pokemon", supertype: str = "Pokémon", rarity: str = "Special Illustration Rare",
        image: bool = True,
    ) -> None:
        upsert_card(
            self.connection, card_id=card_id, name=name or card_id.title(), set_name=f"Set {set_id}",
            number="1/100", rarity=rarity, variant="Raw", language=language, game=game,
            source_provider="scrydex", source_record_id=card_id, set_id=set_id, supertype=supertype,
            image_url=f"https://img/{card_id}.png" if image else None,
            image_small_url=f"https://img/{card_id}_s.png" if image else None,
        )

    def _daily(self, card_id: str, days_ago: int, *, main: float | None = None, default: float | None = None,
               currency: str = "USD", variant: str | None = "Holofoil") -> None:
        self.connection.execute(
            "INSERT INTO card_price_history_daily (card_id, provider, price_date, display_currency_code, "
            "default_raw_market_price, main_raw_market_price, main_raw_variant, updated_at) "
            "VALUES (?, 'scrydex', ?, ?, ?, ?, ?, ?) ON CONFLICT(card_id, price_date) DO UPDATE SET "
            "display_currency_code=excluded.display_currency_code, "
            "default_raw_market_price=excluded.default_raw_market_price, "
            "main_raw_market_price=excluded.main_raw_market_price, main_raw_variant=excluded.main_raw_variant",
            (card_id, _d(days_ago), currency, default, main, variant if main is not None else None, utc_now()),
        )

    def _path(self, card_id: str, knots: list[tuple[int, float]], *, lane: str = "main",
              variant: str | None = "Holofoil", currency: str = "USD", step: int = 1) -> None:
        """Linear between (days_ago, price) knots, one row every `step` days + today."""
        knots = sorted(knots, key=lambda p: -p[0])
        days = sorted({*range(knots[0][0], -1, -step), *(k[0] for k in knots), 0}, reverse=True)
        for day in days:
            for (d0, v0), (d1, v1) in zip(knots, knots[1:]):
                if d0 >= day >= d1:
                    value = v0 if d0 == d1 else v0 + (v1 - v0) * (d0 - day) / (d0 - d1)
                    break
            else:
                value = knots[-1][1]
            if lane == "main":
                self._daily(card_id, day, main=round(value, 2), variant=variant)
            else:
                self._daily(card_id, day, default=round(value, 2), currency=currency)

    def _graded(self, card_id: str, grade: str, market: float, *, variant: str = "Holofoil", days_ago: int = 0) -> None:
        self.connection.execute(
            "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, variant_key, "
            "grader, grade, currency_code, market, updated_at) VALUES (?, 'scrydex', ?, 'graded', ?, ?, 'PSA', ?, "
            "'USD', ?, ?)",
            (card_id, _d(days_ago), f"g|PSA|{grade}|{variant}", variant, grade, market, utc_now()),
        )

    def _set_index(self, set_id: str, change: float, *, window_days: int = 30, game: str = "pokemon") -> None:
        meta_pulse.ensure_schema(self.connection)
        for key, segment in (
            (meta_pulse.set_index_group_key(set_id), meta_pulse.SET_INDEX_SEGMENT_KEY),
            (meta_pulse.set_group_key(set_id), meta_pulse.SET_SEGMENT_KEY),
        ):
            self.connection.execute(
                "INSERT OR REPLACE INTO meta_pulse_groups (game, as_of_date, window_days, lane, group_key, segment_key, "
                "label, description, median_change_percent, value_now, value_then, value_change_usd, card_count, "
                "moved_card_count, spark_points_json, computed_at, sort_score) "
                "VALUES (?, ?, ?, 'raw', ?, ?, ?, '10 cards', ?, 100, 100, 0, 10, 8, '[]', ?, ?)",
                (game, _d(0), window_days, key, segment, f"Set {set_id}", change, utc_now(), change),
            )
        self.connection.execute(
            "INSERT OR REPLACE INTO meta_pulse_runs (game, as_of_date, window_days, lane, paired_card_count, "
            "moved_card_count, value_now, value_then, group_count, computed_at) "
            "VALUES (?, ?, ?, 'raw', 10, 8, 100, 100, 1, ?)",
            (game, _d(0), window_days, utc_now()),
        )

    def _compute(self) -> dict:
        self.connection.commit()
        _, payloads, sets = market_analytics.compute_market_analytics(self.connection, today=TODAY)
        self.sets = sets
        return payloads

    def _payload(self, game: str = "pokemon", window_days: int = 30) -> dict:
        return self._compute()[(game, window_days)]


class PulseAndHeatmapTests(MarketAnalyticsFixture):
    def test_index_breadth_sparkline_and_window_label(self) -> None:
        self._card("up")
        self._path("up", [(120, 100.0), (30, 100.0), (0, 120.0)])  # +20%
        self._card("down")
        self._path("down", [(120, 50.0), (30, 50.0), (0, 40.0)])  # -20%
        self._card("flat")
        self._path("flat", [(120, 20.0), (30, 20.0), (0, 20.1)])  # +0.5% = flat
        self._card("penny")  # under the $10 liquid floor: not in breadth/index
        self._path("penny", [(120, 2.0), (30, 2.0), (0, 4.0)])
        payload = self._payload()
        pulse = payload["pulse"]
        self.assertEqual(pulse["breadth"], {"up": 1, "down": 1, "flat": 1, "upPct": 33.3})
        self.assertEqual(pulse["indexValueUsd"], 180.1)
        self.assertAlmostEqual(pulse["changePct"], (180.1 - 170.0) / 170.0 * 100, places=1)
        self.assertEqual(pulse["sparkline"][0]["value"], 170.0)
        self.assertEqual(pulse["sparkline"][-1], {"date": _d(0), "value": 180.1})
        self.assertLessEqual(len(pulse["sparkline"]), market_analytics.SPARK_POINTS)
        self.assertEqual(payload["windowLabel"], "past 30 days")
        self.assertEqual(payload["asOf"], _d(0))
        # Never discloses coverage.
        self.assertNotIn("daysCovered", json.dumps(payload))

    def test_window_label_recently_when_history_is_short(self) -> None:
        self._card("young")
        self._path("young", [(20, 100.0), (0, 120.0)])
        payloads = self._compute()
        self.assertEqual(payloads[("pokemon", 90)]["windowLabel"], "recently")
        self.assertEqual(payloads[("pokemon", 7)]["windowLabel"], "past week")

    def test_usd_only_same_printing_and_quality_exclusions(self) -> None:
        self._card("jp-anchor", language="Japanese")  # Scrydex JP default-raw: never used
        self._path("jp-anchor", [(60, 5000.0), (0, 9000.0)], lane="default")
        self._card("jp-tcg", language="Japanese")  # JP on TCGplayer USD: fine
        self._path("jp-tcg", [(60, 30.0), (0, 33.0)])
        self._card("repoint")  # printing re-pointed: no pair, still priced now
        for days_ago in range(60, 25, -1):
            self._daily("repoint", days_ago, main=40.0, variant="Reverse Holofoil")
        self._path("repoint", [(24, 400.0), (0, 400.0)], variant="Holofoil")
        self._card("untrusted")  # raw above its own PSA 10: withheld everywhere
        self._path("untrusted", [(60, 300.0), (0, 300.0)])
        self._graded("untrusted", "10", 100.0)
        self._card("sealed", supertype="Sealed")
        self._path("sealed", [(60, 100.0), (0, 150.0)])
        payload = self._payload()
        heat = {tile["setId"]: tile for tile in payload["heatmap"]}
        self.assertEqual(heat["sv1"]["cardCount"], 2)  # jp-tcg + repoint; untrusted/sealed/jp-anchor out
        self.assertEqual(heat["sv1"]["totalValueUsd"], 433.0)
        set_cards = [c["cardId"] for c in self.sets[("pokemon", 30)]["sv1"]["cards"]]
        self.assertEqual(set_cards, ["repoint", "jp-tcg"])
        by_id = {c["cardId"]: c for c in self.sets[("pokemon", 30)]["sv1"]["cards"]}
        self.assertIsNone(by_id["repoint"]["changePct"])
        self.assertEqual(by_id["repoint"]["variant"], "Holofoil")
        self.assertAlmostEqual(by_id["jp-tcg"]["changePct"], 5.0, delta=0.6)
        self.assertNotIn("untrusted", json.dumps(payload))

    def test_glitch_pairs_and_series_stay_out_of_the_index(self) -> None:
        self._card("glitch")
        self._path("glitch", [(60, 100.0), (1, 100.0)])
        self._daily("glitch", 0, main=1000.0)  # one teleporting print
        self._card("real")
        self._path("real", [(60, 50.0), (0, 55.0)])
        pulse = self._payload()["pulse"]
        self.assertEqual(pulse["indexValueUsd"], 55.0)

    def test_heatmap_ranks_sets_by_total_value_and_thin_games_are_empty(self) -> None:
        for i, set_id in enumerate(("a", "b", "c")):
            self._card(f"{set_id}-1", set_id=set_id)
            self._path(f"{set_id}-1", [(40, 10.0 * (i + 1)), (0, 10.0 * (i + 1))])
        payloads = self._compute()
        self.assertEqual([t["setId"] for t in payloads[("pokemon", 30)]["heatmap"]], ["c", "b", "a"])
        empty = payloads[("onepiece", 30)]
        self.assertEqual(empty["heatmap"], [])
        self.assertEqual(empty["bargains"], [])
        self.assertIsNone(empty["pulse"]["changePct"])
        self.assertIsNone(empty["you"])

    def test_stale_sync_returns_empty_lists(self) -> None:
        self._card("old")
        for days_ago in range(80, 9, -1):
            self._daily("old", days_ago, main=10.0 + (80 - days_ago) / 7)
        payload = self._payload()
        self.assertEqual(payload["heatmap"], [])
        self.assertIsNone(payload["pulse"]["changePct"])


class ListsTests(MarketAnalyticsFixture):
    def test_bargains_bottom_of_range_with_flat_or_rising_set(self) -> None:
        self._card("cheap-now", set_id="rising")
        self._path("cheap-now", [(85, 100.0), (40, 140.0), (0, 80.0)])  # at the 90d low
        self._card("mid-range", set_id="rising")
        self._path("mid-range", [(85, 100.0), (40, 140.0), (0, 120.0)])  # 50th percentile
        self._card("falling-set", set_id="falling")
        self._path("falling-set", [(85, 100.0), (40, 140.0), (0, 80.0)])
        self._card("bulk-trainer", set_id="rising", supertype="Trainer", rarity="Uncommon")
        self._path("bulk-trainer", [(85, 100.0), (40, 140.0), (0, 80.0)])
        self._card("no-image", set_id="rising", image=False)
        self._path("no-image", [(85, 100.0), (40, 140.0), (0, 80.0)])
        self._set_index("rising", 4.0)
        self._set_index("falling", -8.0)
        payload = self._payload()
        self.assertEqual([b["cardId"] for b in payload["bargains"]], ["cheap-now"])
        bargain = payload["bargains"][0]
        self.assertEqual(bargain["position"], {"lowUsd": 80.0, "highUsd": 140.0, "percentile": 0})
        self.assertEqual(bargain["priceUsd"], 80.0)
        self.assertLess(bargain["changePct"], 0)
        # Set baskets come from Market Watch.
        self.assertEqual([s["setId"] for s in payload["setsRising"]], ["rising"])
        self.assertEqual([s["setId"] for s in payload["setsFalling"]], ["falling"])
        self.assertEqual(payload["setsFalling"][0]["changePct"], -8.0)

    def test_breaking_out_reads_price_highs(self) -> None:
        self._card("rocket")
        self._path("rocket", [(200, 50.0), (60, 50.0), (10, 60.0), (2, 80.0), (0, 81.0)])
        self._card("calm")
        self._path("calm", [(200, 50.0), (60, 60.0), (0, 50.0)])
        self.connection.commit()
        price_lows.refresh_price_lows(self.connection, today=TODAY)
        payload = self._payload()
        self.assertEqual([b["cardId"] for b in payload["breakingOut"]], ["rocket"])
        item = payload["breakingOut"][0]
        self.assertEqual(item["priceUsd"], 81.0)
        self.assertLess(item["previousHighUsd"], 80.0)
        self.assertEqual(item["sparkline"][-1], {"date": _d(0), "value": 81.0})
        self.assertGreater(item["changePct"], 0)

    def test_grading_net_of_fee_same_printing_positive_only(self) -> None:
        self._card("gem")
        self._path("gem", [(40, 20.0), (0, 20.0)])
        self._graded("gem", "10", 150.0)
        self._graded("gem", "9", 60.0)
        self._card("thin")  # 45 - 20 - 30 < 0
        self._path("thin", [(40, 20.0), (0, 20.0)])
        self._graded("thin", "10", 45.0)
        self._card("other-print")  # PSA 10 exists only for a different printing
        self._path("other-print", [(40, 20.0), (0, 20.0)])
        self._graded("other-print", "10", 500.0, variant="1st Edition Holofoil")
        self._card("placeholder")  # a $99,999 listing is not a price
        self._path("placeholder", [(40, 20.0), (0, 20.0)])
        self._graded("placeholder", "10", 99999.0)
        payload = self._payload()
        self.assertEqual(
            payload["grading"],
            [{
                "cardId": "gem", "name": "Gem", "setName": "Set sv1", "number": "1/100",
                "imageUrl": "https://img/gem_s.png", "game": "pokemon", "variant": "Holofoil",
                "rawUsd": 20.0, "psa10Usd": 150.0, "feeUsd": 30.0, "netGainUsd": 100.0, "owned": False,
            }],
        )
        with mock.patch.dict(os.environ, {"MARKET_GRADING_FEE_USD": "135"}):
            self.assertEqual(self._payload()["grading"], [])
        self.assertEqual(market_analytics.version_token(self.connection).split("|fee:")[1][:2], "30")


class CardMoversTests(MarketAnalyticsFixture):
    def test_rising_falling_thresholds_order_jp_rule_and_dedupe(self) -> None:
        self._card("up-big")
        self._path("up-big", [(40, 10.0), (30, 10.0), (0, 20.0)])  # +100%
        self._card("up-small")
        self._path("up-small", [(40, 50.0), (0, 55.0)])  # +10%
        self._card("dup", name="Up-Big", set_id="sv1")  # same name+set as up-big: deduped
        self._path("dup", [(40, 10.0), (0, 19.0)])
        self._card("down")
        self._path("down", [(40, 40.0), (30, 40.0), (0, 30.0)])  # -25%
        self._card("cheap-now")  # ends under $5
        self._path("cheap-now", [(40, 8.0), (0, 4.0)])
        self._card("cheap-then")  # starts under $5
        self._path("cheap-then", [(40, 3.0), (0, 6.0)])  # ~$3.75 at the window start
        self._card("fresh")  # no window-start price
        self._path("fresh", [(10, 10.0), (0, 30.0)])
        self._card("bulk", rarity="Common", supertype="Trainer")  # not collectible
        self._path("bulk", [(40, 10.0), (0, 15.0)])
        self._card("sealed-box", supertype="Sealed")
        self._path("sealed-box", [(40, 100.0), (0, 150.0)])
        self._card("jp-tcg", language="Japanese")  # JP on TCGplayer: kept
        self._path("jp-tcg", [(40, 20.0), (0, 30.0)])
        self._card("jp-anchor", language="Japanese")  # Scrydex JP default lane: never
        self._path("jp-anchor", [(40, 20.0), (0, 30.0)], lane="default")
        self._card("flat")
        self._path("flat", [(40, 20.0), (0, 20.0)])
        payload = self._payload()
        rising, falling = payload["cardsRising"], payload["cardsFalling"]
        self.assertEqual([c["cardId"] for c in rising], ["up-big", "jp-tcg", "up-small"])
        self.assertEqual([c["cardId"] for c in falling], ["down"])
        top = rising[0]
        self.assertEqual(
            {k: top[k] for k in ("priceUsd", "thenPriceUsd", "changePct", "changeUsd", "variant", "setName")},
            {"priceUsd": 20.0, "thenPriceUsd": 10.0, "changePct": 100.0, "changeUsd": 10.0, "variant": "Holofoil",
             "setName": "Set sv1"},
        )
        self.assertEqual(falling[0]["changeUsd"], -10.0)

    def test_empty_payload_has_card_mover_keys(self) -> None:
        payload = market_analytics.empty_payload("pokemon", "30d")
        self.assertEqual((payload["cardsRising"], payload["cardsFalling"]), ([], []))
        self.assertEqual(self._payload("onepiece")["cardsRising"], [])

    def test_your_movers_game_filter_sealed_and_null(self) -> None:
        self._card("pk-up")
        self._card("pk-down")
        self._card("op-up", game="onepiece")
        self._card("pk-box", supertype="Sealed")
        self.connection.commit()
        mover = lambda card_id, change: {  # noqa: E731
            "card_id": card_id, "quantity": 2, "to_usd": 50.0, "change_usd": change, "change_pct": 12.345,
            "variant": "Holofoil",
        }
        summary = {
            "top_gainers": [mover("op-up", 40.0), mover("pk-box", 30.0), mover("pk-up", 22.0)],
            "top_losers": [mover("pk-down", -8.0)],
        }
        out = market_analytics.your_movers(self.connection, summary, "pokemon")
        self.assertEqual([m["cardId"] for m in out["gainers"]], ["pk-up"])
        self.assertEqual(out["gainers"][0]["quantity"], 2)
        self.assertEqual(out["gainers"][0]["changeUsd"], 22.0)
        self.assertEqual(out["gainers"][0]["changePct"], 12.35)
        self.assertEqual(out["gainers"][0]["imageUrl"], "https://img/pk-up_s.png")
        self.assertEqual([m["cardId"] for m in out["losers"]], ["pk-down"])
        self.assertEqual([m["cardId"] for m in market_analytics.your_movers(self.connection, summary, "onepiece")["gainers"]], ["op-up"])
        self.assertIsNone(market_analytics.your_movers(self.connection, summary, "lorcana"))
        self.assertIsNone(market_analytics.your_movers(self.connection, None, "pokemon"))


class PricePositionTests(MarketAnalyticsFixture):
    def test_raw_position_over_the_covered_window(self) -> None:
        self._card("pdp")
        self._path("pdp", [(120, 150.0), (85, 100.0), (60, 200.0), (0, 125.0)])
        position = market_analytics.price_position(self.connection, "pdp", today=TODAY)
        self.assertEqual(position, {
            "currentUsd": 125.0, "lowUsd": 100.0, "highUsd": 200.0, "percentile": 25, "windowLabel": "past 90 days",
        })

    def test_spike_dropped_and_short_or_flat_history_is_none(self) -> None:
        self._card("spiky")
        self._path("spiky", [(40, 100.0), (0, 110.0)])
        self._daily("spiky", 20, main=900.0)
        position = market_analytics.price_position(self.connection, "spiky", today=TODAY)
        self.assertLess(position["highUsd"], 200.0)
        self.assertEqual(position["windowLabel"], "past 30 days")
        self._card("new")
        self._path("new", [(5, 100.0), (0, 110.0)])
        self.assertIsNone(market_analytics.price_position(self.connection, "new", today=TODAY))
        self._card("flat")
        self._path("flat", [(60, 100.0), (0, 100.0)])
        self.assertIsNone(market_analytics.price_position(self.connection, "flat", today=TODAY))
        with self.assertRaises(KeyError):
            market_analytics.price_position(self.connection, "nope", today=TODAY)

    def test_untrusted_stale_and_japanese_anchor(self) -> None:
        self._card("over-slab")
        self._path("over-slab", [(60, 300.0), (0, 320.0)])
        self._graded("over-slab", "10", 100.0)
        self.assertIsNone(market_analytics.price_position(self.connection, "over-slab", variant="Holofoil", today=TODAY))
        self._card("stale")
        for days_ago in range(90, 29, -1):
            self._daily("stale", days_ago, main=100.0 + (90 - days_ago))
        self.assertIsNone(market_analytics.price_position(self.connection, "stale", today=TODAY))
        self._card("jp", language="Japanese")
        self._path("jp", [(60, 5000.0), (0, 9000.0)], lane="default")
        self.assertIsNone(market_analytics.price_position(self.connection, "jp", today=TODAY))

    def test_graded_position(self) -> None:
        self._card("slab")
        for days_ago, value in ((40, 200.0), (25, 200.0), (20, 400.0), (10, 300.0), (0, 250.0)):
            self._graded("slab", "10", value, days_ago=days_ago)
        position = market_analytics.price_position(self.connection, "slab", grader="PSA", grade="10", today=TODAY)
        self.assertEqual((position["lowUsd"], position["highUsd"], position["percentile"]), (200.0, 400.0, 25))
        self.assertEqual(position["windowLabel"], "past 30 days")


class RefreshAndServiceTests(MarketAnalyticsFixture):
    def test_refresh_skips_when_version_unchanged_and_reads_back(self) -> None:
        self._card("x")
        self._path("x", [(40, 20.0), (0, 25.0)])
        self.connection.commit()
        first = market_analytics.refresh_market_analytics(self.connection, today=TODAY)
        self.assertEqual(first["payloads"], len(market_analytics.SUPPORTED_GAMES) * len(market_analytics.WINDOWS))
        self.assertTrue(market_analytics.refresh_market_analytics(self.connection, today=TODAY)["skipped"])
        upsert_runtime_setting(self.connection, key="pricing_sync_generation", value=9)
        self.connection.commit()
        self.assertNotIn("skipped", market_analytics.refresh_market_analytics(self.connection, today=TODAY))
        stored = market_analytics.read_payload(self.connection, "pokemon", 30)
        self.assertEqual(stored["heatmap"][0]["setId"], "sv1")
        self.assertEqual(market_analytics.read_set_payload(self.connection, "pokemon", 30, "sv1")["cards"][0]["cardId"], "x")

    def test_service_guest_owner_and_set_reads(self) -> None:
        self._card("gem")
        self._path("gem", [(40, 20.0), (0, 20.0)])
        self._graded("gem", "10", 150.0)
        self.connection.commit()
        market_analytics.refresh_market_analytics(self.connection, today=TODAY)
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(service.connection.close)
        with mock.patch.object(service, "_kick_market_analytics_refresh") as kick:
            guest = service.market_analytics(game="pokemon", window="30d", owner_user_id=None)
            kick.assert_not_called()
        self.assertIsNone(guest["you"])
        self.assertIsNone(guest["yourMovers"])
        self.assertFalse(guest["grading"][0]["owned"])
        summary = {
            "holdings_count": 2, "value_usd": 500.0, "change_pct": 4.2,
            "top_gainers": [{"card_id": "gem", "quantity": 1, "to_usd": 20.0, "change_usd": 3.0, "change_pct": 17.65}],
            "top_losers": [],
        }
        with mock.patch("mcp_server.tools.CollectionTools.get_portfolio_summary", return_value=summary):
            with mock.patch.object(service, "_market_analytics_owned_ids", return_value={"gem"}):
                mine = service.market_analytics(game="pokemon", window="30d", owner_user_id="user-1")
        self.assertTrue(mine["grading"][0]["owned"])
        self.assertEqual(mine["you"], {
            "changePct": 4.2, "valueUsd": 500.0, "marketChangePct": mine["pulse"]["changePct"],
            "beatsMarket": 4.2 > (mine["pulse"]["changePct"] or 0),
        })
        self.assertEqual([m["cardId"] for m in mine["yourMovers"]["gainers"]], ["gem"])
        self.assertEqual(mine["yourMovers"]["losers"], [])
        # Other games' movers are filtered out (null when nothing is left).
        with mock.patch("mcp_server.tools.CollectionTools.get_portfolio_summary", return_value=summary):
            other = service.market_analytics(game="onepiece", window="30d", owner_user_id="user-1")
        self.assertIsNone(other["yourMovers"])
        # The shared cached payload is never mutated by a caller's fields.
        self.assertIsNone(service.market_analytics(game="pokemon", window="30d", owner_user_id=None)["you"])
        zoom = service.market_heatmap_set(game="pokemon", set_id="sv1", window="30d")
        self.assertEqual((zoom["setId"], zoom["window"], zoom["windowLabel"]), ("sv1", "30d", "past 30 days"))
        self.assertIsNone(service.market_heatmap_set(game="pokemon", set_id="nope", window="30d"))

    def test_stale_store_kicks_a_background_refresh_and_empty_shape_when_never_computed(self) -> None:
        self._card("x")
        self._path("x", [(40, 20.0), (0, 25.0)])
        self.connection.commit()
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(service.connection.close)
        with mock.patch.object(service, "_kick_market_analytics_refresh") as kick:
            payload = service.market_analytics(game="pokemon", window="7d", owner_user_id=None)
        kick.assert_called_once()
        self.assertEqual(payload["heatmap"], [])
        self.assertEqual(payload["window"], "7d")

    def test_mirrored_constants_match_their_sources(self) -> None:
        from mcp_server.assistant import compact
        from mcp_server import tools

        self.assertEqual(market_analytics.WINDOW_PHRASES, compact.WINDOW_PHRASES)
        self.assertEqual(market_analytics.NEUTRAL_WINDOW, compact.NEUTRAL_WINDOW)
        self.assertEqual(market_analytics.COLLECTIBLE_MIN_PRICE_USD, tools.COLLECTIBLE_MIN_PRICE_USD)


if __name__ == "__main__":
    unittest.main()
