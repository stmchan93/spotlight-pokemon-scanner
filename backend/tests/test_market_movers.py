"""market_movers: catalog-wide Top Trends ranking. Guards the same-source
rule (never compare a Scrydex-JPY "then" with a TCGCSV "now"), the $5 floor on
the CURRENT price, the noise filters that keep Scrydex's flat JP anchors out,
top-5-per-game ordering, and the service cache's version-token invalidation.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    SUPPORTED_GAMES,
    apply_schema,
    connect,
    upsert_card,
    upsert_expansion,
    upsert_fx_rate_snapshot,
    upsert_runtime_setting,
    utc_now,
)
from market_movers import (  # noqa: E402
    compute_top_movers,
    downsample_series,
    market_movers_version_token,
)
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

TODAY = date(2026, 9, 8)
JPY_USD = 0.0067


def _d(days_ago: int) -> str:
    return (TODAY - timedelta(days=days_ago)).isoformat()


class MarketMoversTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "movers.sqlite"
        self.connection = connect(self.database_path)
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        upsert_fx_rate_snapshot(
            self.connection, base_currency="JPY", quote_currency="USD",
            rate=JPY_USD, source="test",
        )
        self.connection.commit()

    # --- seeding helpers --------------------------------------------------

    def _card(self, card_id: str, *, game: str = "pokemon", language: str = "English",
              name: str | None = None, set_id: str | None = None, ptcgo: str | None = None) -> None:
        upsert_card(
            self.connection, card_id=card_id, name=name or card_id.title(),
            set_name="Test Set", number="1/100", rarity="Rare", variant="Raw",
            language=language, game=game, source_provider="scrydex",
            source_record_id=card_id, set_id=set_id, set_ptcgo_code=ptcgo,
            image_small_url=f"https://img/{card_id}.png",
        )

    def _daily(self, card_id: str, days_ago: int, *, default: float | None = None,
               main: float | None = None, currency: str = "USD") -> None:
        self.connection.execute(
            "INSERT INTO card_price_history_daily (card_id, provider, price_date, "
            "display_currency_code, default_raw_market_price, main_raw_market_price, updated_at) "
            "VALUES (?, 'scrydex', ?, ?, ?, ?, ?) "
            "ON CONFLICT(card_id, price_date) DO UPDATE SET "
            "display_currency_code=excluded.display_currency_code, "
            "default_raw_market_price=excluded.default_raw_market_price, "
            "main_raw_market_price=excluded.main_raw_market_price",
            (card_id, _d(days_ago), currency, default, main, utc_now()),
        )

    def _series(self, card_id: str, then: float, now: float, *, main: bool = False,
                currency: str = "USD", steps: int = 6) -> None:
        """A monotone ramp from `then` (30d ago) to `now` (today) with `steps`
        distinct values, so the series filter passes."""
        for i in range(steps):
            days_ago = 30 - round(i * 30 / (steps - 1))
            value = then + (now - then) * i / (steps - 1)
            if main:
                self._daily(card_id, days_ago, main=value, currency="USD")
            else:
                self._daily(card_id, days_ago, default=value, currency=currency)

    def _compute(self, **kwargs):
        self.connection.commit()
        return compute_top_movers(self.connection, today=TODAY, **kwargs)

    @staticmethod
    def _items(payload, game="pokemon"):
        return next(g["items"] for g in payload["games"] if g["game"] == game)

    # --- tests --------------------------------------------------------------

    def test_same_source_pair_required(self) -> None:
        # A: then has only default_raw, now has both -> default_raw pair.
        self._card("a")
        self._series("a", 10.0, 15.0)
        self._daily("a", 0, default=15.0, main=99.0)
        # B: currency flips JPY -> USD between the ends -> excluded.
        self._card("b", language="Japanese")
        self._series("b", 1000.0, 1000.0, currency="JPY")
        self._daily("b", 0, default=50.0, currency="USD")
        # C: both ends main_raw -> main pair, default_raw ignored.
        self._card("c")
        self._series("c", 20.0, 30.0, main=True)
        self._daily("c", 30, default=1.0, main=20.0)
        self._daily("c", 0, default=500.0, main=30.0)
        items = self._items(self._compute())
        by_id = {item["cardId"]: item for item in items}
        self.assertEqual(set(by_id), {"a", "c"})
        self.assertEqual(by_id["a"]["source"], "default_raw")
        self.assertEqual(by_id["a"]["changePercent"], 50.0)
        self.assertEqual(by_id["c"]["source"], "main_raw")
        self.assertEqual((by_id["c"]["priceThen"], by_id["c"]["priceNow"]), (20.0, 30.0))

    def test_five_dollar_floor_applies_to_price_now(self) -> None:
        self._card("cheap")
        self._series("cheap", 3.0, 4.99)   # +66%, but ends under $5
        self._card("edge")
        self._series("edge", 4.0, 5.0)     # +25%, exactly $5
        items = self._items(self._compute())
        self.assertEqual([item["cardId"] for item in items], ["edge"])

    def test_jpy_pair_converted_with_a_single_rate(self) -> None:
        self._card("jp", language="Japanese")
        self._series("jp", 1000.0, 1500.0, currency="JPY")
        item = self._items(self._compute())[0]
        self.assertEqual(item["currencyCode"], "USD")
        self.assertEqual(item["priceThen"], 6.7)
        self.assertEqual(item["priceNow"], 10.05)
        self.assertEqual(item["changePercent"], 50.0)
        # Without an FX row the JPY pair is simply ineligible.
        self.connection.execute("DELETE FROM fx_rate_snapshots")
        self.assertEqual(self._items(self._compute()), [])

    def test_noise_filters(self) -> None:
        # Flat anchor that jumps once: only two distinct prices -> excluded.
        self._card("anchor", language="Japanese")
        for days_ago in range(30, 0, -1):
            self._daily("anchor", days_ago, default=3000.0, currency="JPY")
        self._daily("anchor", 0, default=9000.0, currency="JPY")
        # Glitch: +2000% -> excluded even with a smooth series.
        self._card("glitch")
        self._series("glitch", 10.0, 210.0)
        # Genuine mover with several distinct values -> included.
        self._card("real")
        self._series("real", 10.0, 16.0)
        # Loser -> excluded (gainers only).
        self._card("loser")
        self._series("loser", 20.0, 10.0)
        items = self._items(self._compute())
        self.assertEqual([item["cardId"] for item in items], ["real"])
        self.assertEqual(items[0]["changePercent"], 60.0)

    def test_top_five_per_game_in_game_order(self) -> None:
        for i in range(7):
            self._card(f"p{i}", language="Japanese" if i % 2 else "English")
            self._series(f"p{i}", 10.0, 10.0 + i + 1)
        self._card("op1", game="onepiece")
        self._series("op1", 10.0, 12.0)
        self._card("op2", game="onepiece")
        self._series("op2", 10.0, 30.0)
        payload = self._compute()
        self.assertEqual([g["game"] for g in payload["games"]], list(SUPPORTED_GAMES))
        pokemon = self._items(payload, "pokemon")
        self.assertEqual([item["cardId"] for item in pokemon], ["p6", "p5", "p4", "p3", "p2"])
        self.assertEqual([item["cardId"] for item in self._items(payload, "onepiece")], ["op2", "op1"])
        self.assertEqual(self._items(payload, "lorcana"), [])
        self.assertTrue(all(item["changePercent"] > 0 for item in pokemon))

    def test_then_anchor_tolerance(self) -> None:
        # Only a row 38 days back -> outside the 30..37 window -> no pair.
        self._card("far")
        self._daily("far", 38, default=10.0)
        for days_ago in (2, 1, 0):
            self._daily("far", days_ago, default=15.0 + days_ago)
        # Rows at -36 and -33 -> the -33 one anchors "then".
        self._card("near")
        self._daily("near", 36, default=8.0)
        self._daily("near", 33, default=10.0)
        for days_ago in (2, 1, 0):
            self._daily("near", days_ago, default=13.0 + days_ago)
        items = self._items(self._compute())
        self.assertEqual([item["cardId"] for item in items], ["near"])
        self.assertEqual(items[0]["thenDate"], _d(33))
        self.assertEqual(items[0]["nowDate"], _d(0))
        self.assertEqual(items[0]["priceThen"], 10.0)

    def test_stale_sync_yields_empty_games(self) -> None:
        self._card("old")
        self._series("old", 10.0, 20.0)
        payload = compute_top_movers(self.connection, today=TODAY + timedelta(days=10))
        self.assertEqual(payload["asOfDate"], _d(0))
        self.assertTrue(all(g["items"] == [] for g in payload["games"]))

    def test_sparkline_shape(self) -> None:
        self._card("spark")
        for days_ago in range(30, -1, -1):
            self._daily("spark", days_ago, default=10.0 + (30 - days_ago) * 0.5)
        item = self._items(self._compute())[0]
        self.assertLessEqual(len(item["sparkPoints"]), 30)
        self.assertEqual(item["sparkPoints"][0], item["priceThen"])
        self.assertEqual(item["sparkPoints"][-1], item["priceNow"])
        self.assertEqual(len(downsample_series([float(i) for i in range(45)])), 30)

    def test_item_fields_and_set_code(self) -> None:
        upsert_expansion(
            self.connection, expansion_id="op01", name="Romance Dawn", code="OP-01",
            game="onepiece", language="English",
        )
        self._card("zoro", game="onepiece", name="Roronoa Zoro", set_id="op01")
        self._series("zoro", 12.95, 41.16)
        self._card("noexp", game="onepiece", set_id="missing", ptcgo="PTC")
        self._series("noexp", 10.0, 12.0)
        items = {item["cardId"]: item for item in self._items(self._compute(), "onepiece")}
        self.assertEqual(items["zoro"]["setCode"], "OP-01")
        self.assertEqual(items["zoro"]["setName"], "Test Set")
        self.assertEqual(items["zoro"]["imageUrl"], "https://img/zoro.png")
        self.assertEqual(items["zoro"]["name"], "Roronoa Zoro")
        self.assertEqual(items["noexp"]["setCode"], "PTC")

    def test_service_cache_invalidates_on_new_price_date_or_generation(self) -> None:
        self._card("svc")
        self._series("svc", 10.0, 15.0)
        self.connection.commit()
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(service.connection.close)
        first = service.market_top_movers()
        self.assertIs(service.market_top_movers(), first)
        upsert_runtime_setting(service.connection, key="pricing_sync_generation", value=7)
        service.connection.commit()
        second = service.market_top_movers()
        self.assertIsNot(second, first)
        token = market_movers_version_token(service.connection)
        self.assertIn("psg:7", token)
        result = service.prewarm_market_movers(source="test")
        self.assertTrue(result["warmed"])
        self.assertIn(30, service._market_movers_cache)


if __name__ == "__main__":
    unittest.main()
