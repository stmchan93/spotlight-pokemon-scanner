"""price_lows: cards that dropped and sit near their window low (assistant /
MCP find_price_lows), plus get_market_trends over the existing Top Trends and
Market Watch set data. Guards the market_movers guardrails (USD-only, same
printing, glitch steps, penny cards), the near-low / drop thresholds,
days_covered, the version-token skip, owner-scoped owned filters, and
per-tier tool exposure.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    upsert_card,
    upsert_runtime_setting,
    utc_now,
)
import price_lows  # noqa: E402
from market_movers import LATEST_PAYLOAD_SETTING_KEY  # noqa: E402
from mcp_server.assistant.tools import TOOL_DEFINITIONS, AssistantToolbox  # noqa: E402
from mcp_server.filters import ToolInputError  # noqa: E402
from mcp_server.policy import PUBLIC_POLICY, USER_POLICY  # noqa: E402
from mcp_server.readonly_service import ReadOnlySpotlightService  # noqa: E402
from mcp_server.tools import CollectionTools, is_low_interest_card  # noqa: E402
from server import _apply_price_history_cells_schema_patch  # noqa: E402

TODAY = date(2026, 11, 17)


def _d(days_ago: int) -> str:
    return (TODAY - timedelta(days=days_ago)).isoformat()


class PriceLowsComputeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "lows.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        self.connection.commit()

    def _card(self, card_id: str, *, language: str = "English", game: str = "pokemon") -> None:
        upsert_card(
            self.connection, card_id=card_id, name=card_id.title(), set_name="Test Set", number="1/100",
            rarity="Rare", variant="Raw", language=language, game=game, source_provider="scrydex",
            source_record_id=card_id,
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

    def _path(self, card_id: str, points: list[tuple[int, float]], *, lane: str = "main",
              currency: str = "USD", variant: str | None = "Holofoil") -> None:
        """Linear interpolation between (days_ago, price) knots, one row every 5 days + today."""
        points = sorted(points, key=lambda p: -p[0])
        days = sorted({*range(points[0][0], -1, -5), *(p[0] for p in points), 0}, reverse=True)
        for day in days:
            for (d0, v0), (d1, v1) in zip(points, points[1:]):
                if d0 >= day >= d1:
                    value = v0 if d0 == d1 else v0 + (v1 - v0) * (d0 - day) / (d0 - d1)
                    break
            else:
                value = points[-1][1]
            if lane == "main":
                self._daily(card_id, day, main=round(value, 2), variant=variant)
            else:
                self._daily(card_id, day, default=round(value, 2), currency=currency)

    def _compute(self, **kwargs):
        self.connection.commit()
        return price_lows.compute_price_lows(self.connection, today=TODAY, **kwargs)

    def _ids(self, **kwargs) -> list[str]:
        return [item.card_id for item in self._compute(**kwargs)[1]]

    def test_drop_and_near_low_thresholds(self) -> None:
        self._card("at-low")
        self._path("at-low", [(200, 100.0), (0, 60.0)])  # -40%, at the low
        self._card("near-low")
        self._path("near-low", [(200, 100.0), (10, 50.0), (0, 52.0)])  # -48%, 4% above low
        self._card("bounced")
        self._path("bounced", [(200, 100.0), (20, 50.0), (0, 60.0)])  # 20% above low
        self._card("small-drop")
        self._path("small-drop", [(200, 100.0), (0, 80.0)])  # only -20%
        as_of, rows = self._compute()
        self.assertEqual(as_of, TODAY.isoformat())
        self.assertEqual([r.card_id for r in rows], ["near-low", "at-low"])
        at_low = rows[1]
        self.assertTrue(at_low.at_window_low)
        self.assertAlmostEqual(at_low.pct_below_high, 40.0, places=1)
        self.assertEqual((at_low.low_usd, at_low.high_usd), (60.0, 100.0))
        self.assertFalse(rows[0].at_window_low)
        self.assertAlmostEqual(rows[0].pct_above_low, 4.0, places=1)

    def test_days_covered_is_actual_history_and_short_history_excluded(self) -> None:
        self._card("young")
        self._path("young", [(100, 100.0), (0, 60.0)])
        self._card("too-young")
        self._path("too-young", [(10, 100.0), (0, 60.0)])
        rows = self._compute()[1]
        self.assertEqual([r.card_id for r in rows], ["young"])
        self.assertEqual(rows[0].days_covered, 100)

    def test_window_bounds_the_high(self) -> None:
        self._card("old-high")
        self._path("old-high", [(300, 100.0), (120, 62.0), (60, 61.0), (0, 60.0)])
        self.assertEqual(self._ids(), ["old-high"])
        self.assertEqual(self._ids(window_days=90), [])

    def test_penny_cards_excluded(self) -> None:
        self._card("penny")
        self._path("penny", [(200, 9.0), (0, 4.0)])
        self.assertEqual(self._ids(), [])
        self.assertEqual(self._ids(min_price_usd=1.0), ["penny"])

    def test_jpy_and_japanese_default_raw_excluded(self) -> None:
        self._card("jp-yen", language="Japanese")
        self._path("jp-yen", [(200, 20000.0), (0, 9000.0)], lane="default", currency="JPY")
        # Scrydex raw-JP anchors sometimes come labelled USD; still never used.
        self._card("adv4_ja-62", language="Unknown")
        self._path("adv4_ja-62", [(200, 200.0), (0, 90.0)], lane="default", currency="USD")
        self._card("en-scrydex")
        self._path("en-scrydex", [(200, 200.0), (0, 90.0)], lane="default", currency="USD")
        rows = self._compute()[1]
        self.assertEqual([r.card_id for r in rows], ["en-scrydex"])
        self.assertEqual(rows[0].source, price_lows.SOURCE_DEFAULT_RAW)

    def test_printing_switch_is_not_a_drop(self) -> None:
        self._card("espeon")
        self._path("espeon", [(300, 360.0), (60, 362.0)], variant="Holofoil")
        self._path("espeon", [(55, 40.0), (20, 41.0), (0, 39.0)], variant="World Championship Deck")
        self.assertEqual(self._ids(), [])

    def test_glitch_step_excluded(self) -> None:
        self._card("lucario")
        self._path("lucario", [(200, 60.0), (0, 40.0)])
        self._daily("lucario", 100, main=900.0)  # one teleporting point
        self._card("clean")
        self._path("clean", [(200, 60.0), (0, 40.0)])
        self.assertEqual(self._ids(), ["clean"])

    def test_flat_series_excluded_by_distinct_prices(self) -> None:
        self._card("flat")
        for day in (200, 100):
            self._daily("flat", day, main=100.0)
        self._daily("flat", 0, main=60.0)
        self.assertEqual(self._ids(), [])

    def test_rank_tie_breaks_by_price(self) -> None:
        self._card("cheap")
        self._path("cheap", [(200, 100.0), (0, 60.0)])
        self._card("pricey")
        self._path("pricey", [(200, 1000.0), (0, 600.0)])
        self.assertEqual(self._ids(), ["pricey", "cheap"])

    def test_stale_sync_returns_nothing(self) -> None:
        self._card("old")
        self._path("old", [(200, 100.0), (0, 60.0)])
        self.connection.commit()
        _, rows = price_lows.compute_price_lows(self.connection, today=TODAY + timedelta(days=10))
        self.assertEqual(rows, [])

    def test_refresh_writes_tables_and_skips_unchanged_version(self) -> None:
        self._card("at-low")
        self._path("at-low", [(200, 100.0), (0, 60.0)])
        self.connection.commit()
        first = price_lows.refresh_price_lows(self.connection, today=TODAY)
        self.assertEqual(first["windows"][365]["stored"], 1)
        row = self.connection.execute(
            "SELECT card_id, rank, low_usd, days_covered, at_window_low FROM price_lows WHERE window_days = 365"
        ).fetchone()
        self.assertEqual(tuple(row), ("at-low", 1, 60.0, 200, 1))
        second = price_lows.refresh_price_lows(self.connection, today=TODAY)
        self.assertTrue(second["windows"][365]["skipped"])
        upsert_runtime_setting(self.connection, key="pricing_sync_generation", value={"value": 2})
        self.connection.commit()
        third = price_lows.refresh_price_lows(self.connection, today=TODAY)
        self.assertIn("stored", third["windows"][365])


    # --- new highs (same job, same scan) -------------------------------------

    def _highs(self, **kwargs):
        self.connection.commit()
        return price_lows.compute_price_highs(self.connection, today=TODAY, **kwargs)[1]

    def test_high_thresholds_recency_and_rank(self) -> None:
        self._card("fresh")
        self._path("fresh", [(200, 50.0), (10, 60.0), (0, 80.0)])  # high today, +60%
        self._card("fresh-small")
        self._path("fresh-small", [(200, 60.0), (10, 62.0), (0, 72.0)])  # high today, +20%
        self._card("three-days")
        self._path("three-days", [(200, 50.0), (10, 60.0), (3, 80.0), (0, 79.0)])  # high 3 days ago, 1.25% off
        self._card("old-high")
        self._path("old-high", [(200, 50.0), (30, 80.0), (0, 79.5)])  # near the high, but it was set 30 days ago
        self._card("pulled-back")
        self._path("pulled-back", [(200, 50.0), (10, 60.0), (3, 80.0), (0, 75.0)])  # 6% off the high
        self._card("small-rise")
        self._path("small-rise", [(200, 70.0), (10, 72.0), (0, 79.0)])  # only +12.9% over the low
        rows = self._highs()
        self.assertEqual([r.card_id for r in rows], ["fresh", "fresh-small", "three-days"])
        fresh, _, three = rows
        self.assertEqual((fresh.high_usd, fresh.high_date, fresh.low_usd), (80.0, TODAY.isoformat(), 50.0))
        self.assertAlmostEqual(fresh.pct_above_low, 60.0, places=1)
        self.assertEqual(fresh.days_covered, 200)
        self.assertEqual((three.high_date, three.high_usd, three.price_usd), (_d(3), 80.0, 79.0))
        # The 90d window has a higher low, so a smaller rise, but the same new high.
        self.assertIn("fresh", [r.card_id for r in self._highs(window_days=90)])

    def test_high_short_history_and_penny_excluded(self) -> None:
        self._card("young")
        self._path("young", [(20, 50.0), (10, 60.0), (0, 80.0)])
        self._card("penny")
        self._path("penny", [(200, 3.0), (10, 4.0), (0, 8.0)])
        self.assertEqual(self._highs(), [])

    def test_high_jpy_and_japanese_default_raw_excluded(self) -> None:
        self._card("jp-yen", language="Japanese")
        self._path("jp-yen", [(200, 5000.0), (10, 6000.0), (0, 9000.0)], lane="default", currency="JPY")
        self._card("adv4_ja-62", language="Unknown")
        self._path("adv4_ja-62", [(200, 50.0), (10, 60.0), (0, 90.0)], lane="default", currency="USD")
        self._card("en-scrydex")
        self._path("en-scrydex", [(200, 50.0), (10, 60.0), (0, 90.0)], lane="default", currency="USD")
        rows = self._highs()
        self.assertEqual([r.card_id for r in rows], ["en-scrydex"])
        self.assertEqual(rows[0].source, price_lows.SOURCE_DEFAULT_RAW)

    def test_high_printing_switch_is_not_a_new_high(self) -> None:
        # Blended, $40 holo -> $105 championship deck reads as +160%; per printing it's +5%.
        self._card("espeon")
        self._path("espeon", [(300, 40.0), (60, 41.0)], variant="Holofoil")
        self._path("espeon", [(55, 100.0), (10, 101.0), (0, 105.0)], variant="World Championship Deck")
        self.assertEqual(self._highs(), [])

    def test_high_glitch_spike_is_not_a_new_high(self) -> None:
        self._card("spike")
        self._path("spike", [(200, 50.0), (10, 52.0), (0, 52.5)])
        self._daily("spike", 0, main=300.0)  # one-day teleport today
        self._card("clean")
        self._path("clean", [(200, 50.0), (10, 60.0), (0, 80.0)])
        self.assertEqual([r.card_id for r in self._highs()], ["clean"])

    def test_sealed_counts_for_highs_not_lows(self) -> None:
        upsert_card(
            self.connection, card_id="tcgp-sealed-1", name="Booster Box", set_name="Test Set", number="",
            rarity="Sealed", variant="Raw", language="English", game="pokemon", source_provider="tcgcsv",
            source_record_id="tcgp-sealed-1", supertype="Sealed",
        )
        self._path("tcgp-sealed-1", [(200, 100.0), (10, 120.0), (0, 160.0)])
        highs = self._highs()
        self.assertEqual([(r.card_id, r.sealed) for r in highs], [("tcgp-sealed-1", True)])
        self.connection.execute("DELETE FROM card_price_history_daily")
        self._path("tcgp-sealed-1", [(200, 100.0), (0, 60.0)])
        self.assertEqual(self._ids(), [])

    def test_one_history_scan_feeds_lows_and_highs(self) -> None:
        self._card("at-low")
        self._path("at-low", [(200, 100.0), (0, 60.0)])
        self._card("fresh")
        self._path("fresh", [(200, 50.0), (10, 60.0), (0, 80.0)])
        self.connection.commit()
        statements: list[str] = []
        self.connection.set_trace_callback(statements.append)
        try:
            _, lows, highs = price_lows.compute_price_signals(self.connection, windows=(90, 365), today=TODAY)
        finally:
            self.connection.set_trace_callback(None)
        self.assertEqual(sum("NOT INDEXED" in sql for sql in statements), 1)
        self.assertEqual([r.card_id for r in lows[365]], ["at-low"])
        self.assertEqual([r.card_id for r in highs[365]], ["fresh"])
        self.assertEqual([r.card_id for r in highs[90]], ["fresh"])

    def test_refresh_writes_highs_and_backfills_missing_highs_run(self) -> None:
        self._card("fresh")
        self._path("fresh", [(200, 50.0), (10, 60.0), (0, 80.0)])
        self.connection.commit()
        first = price_lows.refresh_price_lows(self.connection, today=TODAY)
        self.assertEqual(first["windows"][365]["highs"], 1)
        row = self.connection.execute(
            "SELECT card_id, rank, high_usd, high_date, low_usd, pct_above_low, sealed FROM price_highs "
            "WHERE window_days = 365"
        ).fetchone()
        self.assertEqual(tuple(row), ("fresh", 1, 80.0, TODAY.isoformat(), 50.0, 60.0, 0))
        self.assertTrue(price_lows.refresh_price_lows(self.connection, today=TODAY)["windows"][365]["skipped"])
        # A DB whose lows were computed before highs existed recomputes once.
        self.connection.execute("DELETE FROM price_highs_runs")
        self.connection.commit()
        self.assertEqual(price_lows.refresh_price_lows(self.connection, today=TODAY)["windows"][365]["highs"], 1)

    def test_service_refresh_and_movers_copy_for_mcp(self) -> None:
        from market_movers import latest_persisted_payload
        from server import SpotlightScanService

        self._card("at-low")
        self._path("at-low", [(200, 100.0), (0, 60.0)])
        self.connection.commit()
        service = SpotlightScanService(Path(self.tempdir.name) / "lows.sqlite", REPO_ROOT)
        self.addCleanup(service.connection.close)
        result = service.refresh_price_lows(source="test")
        self.assertEqual(result["outcome"], "ok")
        self.assertIn("365", result["windows"])
        service.market_top_movers()
        payload = latest_persisted_payload(self.connection)
        self.assertIsNotNone(payload)
        self.assertIn("games", payload)


class FindPriceLowsToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        db_path = Path(self.tempdir.name) / "tools.sqlite"
        conn = connect(db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        conn.close()
        self.service = ReadOnlySpotlightService(db_path, REPO_ROOT)
        self.addCleanup(lambda: self.service.connection.close())
        self.tools = CollectionTools(self.service)
        self.conn = self.service.connection

    def card(self, card_id: str, *, set_name: str = "Evolving Skies", language: str = "English",
             game: str = "pokemon", rarity: str = "Rare", supertype: str | None = None, image: bool = True,
             name: str | None = None) -> None:
        upsert_card(
            self.conn, card_id=card_id, name=name or f"Card {card_id}", set_name=set_name, number="1", rarity=rarity,
            variant="Raw", language=language, game=game, source_provider="scrydex", source_record_id=card_id,
            image_url=f"https://img.example/{card_id}.png" if image else None, source_payload={"id": card_id},
            supertype=supertype,
        )
        self.conn.execute(
            "INSERT INTO card_price_snapshots (card_id, provider, display_currency_code, default_raw_market_price, "
            "updated_at) VALUES (?, 'scrydex', 'USD', 50.0, ?)",
            (card_id, utc_now()),
        )

    def low(self, card_id: str, *, pct: float, price: float = 50.0, game: str = "pokemon", days: int = 365,
            window_days: int = 365) -> price_lows.PriceLow:
        return price_lows.PriceLow(
            card_id=card_id, game=game, source="main_raw", variant="Holofoil", price_usd=price,
            low_usd=price, high_usd=round(price / (1 - pct / 100), 2), pct_below_high=pct, pct_above_low=0.0,
            days_covered=days, at_window_low=True, first_date="2025-11-17", now_date="2026-11-17",
        )

    def seed_lows(self, rows: list[price_lows.PriceLow], window_days: int = 365) -> None:
        price_lows.write_price_lows(
            self.conn, window_days=window_days, as_of_date="2026-11-17",
            rows=price_lows.rank_lows(rows), version="v1", elapsed_ms=1.0,
        )

    def holding(self, owner: str, card_id: str) -> None:
        self.conn.execute(
            "INSERT INTO deck_entries (id, owner_user_id, identity_key, item_kind, card_id, condition, quantity, "
            "cost_basis_total, cost_basis_currency_code, added_at, updated_at) "
            "VALUES (?, ?, ?, 'raw', ?, 'near_mint', 1, 0, 'USD', ?, ?)",
            (f"{owner}-{card_id}", owner, f"{card_id}||", card_id, utc_now(), utc_now()),
        )

    def test_not_computed_yet(self) -> None:
        result = self.tools.find_price_lows("user-a")
        self.assertEqual(result["cards"], [])
        self.assertIn("not been computed", result["note"])

    def test_returns_ranked_summaries_with_low_fields(self) -> None:
        for card_id in ("a", "b", "c"):
            self.card(card_id)
        self.seed_lows([self.low("a", pct=30.0), self.low("b", pct=60.0, days=120), self.low("c", pct=45.0)])
        result = self.tools.find_price_lows("user-a", limit=2)
        self.assertEqual([c["card_id"] for c in result["cards"]], ["b", "c"])
        first = result["cards"][0]
        self.assertEqual(first["name"], "Card b")
        self.assertEqual(first["days_covered"], 120)
        self.assertEqual(first["pct_below_high"], 60.0)
        self.assertEqual(first["low_usd"], 50.0)
        self.assertEqual(first["high_usd"], 125.0)
        self.assertEqual(first["as_of"], "2026-11-17")
        self.assertEqual(first["variant"], "Holofoil")
        self.assertIn("days_covered", result["note"])
        shaped = USER_POLICY.shape(result)
        self.assertEqual(shaped["cards"][0]["days_covered"], 120)
        self.assertEqual(shaped["cards"][0]["high_usd"], 125.0)

    def test_owned_filter_is_owner_scoped(self) -> None:
        for card_id in ("a", "b"):
            self.card(card_id)
        self.seed_lows([self.low("a", pct=30.0), self.low("b", pct=40.0)])
        self.holding("user-a", "a")
        self.holding("user-b", "b")
        ids = lambda **kw: [c["card_id"] for c in self.tools.find_price_lows("user-a", **kw)["cards"]]  # noqa: E731
        self.assertEqual(ids(owned="owned"), ["a"])
        self.assertEqual(ids(owned="not_owned"), ["b"])
        self.assertEqual(ids(), ["b", "a"])

    def test_card_filter_game_price_and_window(self) -> None:
        self.card("es", set_name="Evolving Skies")
        self.card("bs", set_name="Base Set")
        self.card("jp", set_name="VSTAR Universe", language="Japanese")
        self.card("op", set_name="Romance Dawn", game="onepiece")
        self.seed_lows([
            self.low("es", pct=30.0, price=20.0), self.low("bs", pct=40.0, price=200.0),
            self.low("jp", pct=50.0), self.low("op", pct=60.0, game="onepiece"),
        ])
        self.seed_lows([self.low("es", pct=26.0, price=20.0)], window_days=90)
        ids = lambda *a, **kw: [c["card_id"] for c in self.tools.find_price_lows("user-a", *a, **kw)["cards"]]  # noqa: E731
        self.assertEqual(ids({"set": "Evolving Skies"}), ["es"])
        self.assertEqual(ids({"language": "Japanese"}), ["jp"])
        self.assertEqual(ids(game="onepiece"), ["op"])
        self.assertEqual(ids(game="pokemon", min_price_usd=100), ["bs"])
        self.assertEqual(ids({"price_max_usd": 30}), ["es"])
        self.assertEqual(ids(window="90d"), ["es"])
        with self.assertRaises(ToolInputError):
            self.tools.find_price_lows("user-a", window="5y")
        with self.assertRaises(ToolInputError):
            self.tools.find_price_lows("user-a", game="magic")
        with self.assertRaises(ToolInputError):
            self.tools.find_price_lows("user-a", {"scene": ["beach"]})
        with self.assertRaises(ToolInputError):
            self.tools.find_price_lows("user-a", limit=21)

    def test_assistant_tool_returns_tiles(self) -> None:
        self.card("a")
        self.seed_lows([self.low("a", pct=30.0)])
        outcome = AssistantToolbox(self.tools).run("find_price_lows", {"window": "1y"}, owner_user_id="user-a")
        self.assertFalse(outcome.is_error)
        self.assertEqual([c["card_id"] for c in outcome.cards], ["a"])
        self.assertNotIn("image_small_url", outcome.content["cards"][0])
        self.assertEqual(outcome.content["cards"][0]["days_covered"], 365)

    def _seed_trends(self) -> None:
        for card_id in ("up1", "up2", "op1"):
            self.card(card_id)
        payload = {
            "windowDays": 30, "asOfDate": "2026-11-17",
            "games": [
                {"game": "pokemon", "items": [
                    {"cardId": "up1", "priceNow": 30.0, "priceThen": 20.0, "changePercent": 50.0, "currencyCode": "USD"},
                    {"cardId": "up2", "priceNow": 12.0, "priceThen": 10.0, "changePercent": 20.0, "currencyCode": "USD"},
                    {"cardId": "yen", "priceNow": 9000.0, "priceThen": 1000.0, "changePercent": 800.0, "currencyCode": "JPY"},
                ]},
                {"game": "onepiece", "items": [
                    {"cardId": "op1", "priceNow": 40.0, "priceThen": 20.0, "changePercent": 100.0, "currencyCode": "USD"},
                ]},
            ],
        }
        upsert_runtime_setting(self.conn, key=LATEST_PAYLOAD_SETTING_KEY, value={"version": "v", "payload": payload})
        now = utc_now()
        self.conn.execute(
            "INSERT INTO meta_pulse_runs (game, as_of_date, window_days, lane, paired_card_count, moved_card_count, "
            "value_now, value_then, group_count, computed_at) VALUES ('pokemon', '2026-11-16', 30, 'raw', 500, 300, "
            "1000, 900, 5, ?)",
            (now,),
        )
        sets = [("Evolving Skies", 12.0, 11.0), ("Fossil", 8.0, 7.0), ("Jungle", 5.0, 4.0), ("Neo", 4.0, 3.5),
                ("Base Set", -6.0, -5.0), ("Gym", -12.0, -10.0)]
        for label, pct, score in sets:
            self.conn.execute(
                "INSERT INTO meta_pulse_groups (game, as_of_date, window_days, lane, group_key, segment_key, label, "
                "description, median_change_percent, value_now, value_then, value_change_usd, card_count, "
                "moved_card_count, spark_points_json, computed_at, sort_score, release_date) "
                "VALUES ('pokemon', '2026-11-16', 30, 'raw', ?, 'set', ?, '100 cards', ?, 100, 90, 10, 100, 8, '[]', "
                "?, ?, '2021-08-27')",
                (f"set:{label}:raw", label, pct, now, score),
            )

    def test_market_trends_reads_cached_movers_and_sets(self) -> None:
        self._seed_trends()
        result = self.tools.get_market_trends("user-a")
        self.assertEqual([c["card_id"] for c in result["rising_cards"]], ["op1", "up1", "up2"])
        up1 = result["rising_cards"][1]
        self.assertEqual((up1["change_pct"], up1["change_usd"], up1["window_days"]), (50.0, 10.0, 30))
        self.assertEqual([s["set"] for s in result["rising_sets"]], ["Evolving Skies", "Fossil", "Jungle"])
        self.assertEqual([s["set"] for s in result["falling_sets"]], ["Gym", "Base Set"])
        self.assertEqual(result["sets_as_of"], "2026-11-16")
        self.assertEqual(result["falling_sets"][0]["release_year"], "2021")
        poke = self.tools.get_market_trends("user-a", game="pokemon")
        self.assertEqual([c["card_id"] for c in poke["rising_cards"]], ["up1", "up2"])
        with self.assertRaises(ToolInputError):
            self.tools.get_market_trends("user-a", window="1y")
        outcome = AssistantToolbox(self.tools).run("get_market_trends", {"game": "pokemon"}, owner_user_id="user-a")
        self.assertFalse(outcome.is_error)
        self.assertEqual([c["card_id"] for c in outcome.cards], ["up1", "up2"])

    def test_market_trends_empty_before_any_compute(self) -> None:
        result = self.tools.get_market_trends("user-a")
        self.assertEqual(result["rising_cards"], [])
        self.assertEqual(result["rising_sets"], [])

    # --- find_new_highs -------------------------------------------------------

    def high(self, card_id: str, *, high_date: str = "2026-11-17", pct: float = 30.0, price: float = 50.0,
             game: str = "pokemon", sealed: bool = False, days: int = 365) -> price_lows.PriceHigh:
        return price_lows.PriceHigh(
            card_id=card_id, game=game, source="main_raw", variant="Holofoil", sealed=sealed, price_usd=price,
            high_usd=price, high_date=high_date, low_usd=round(price / (1 + pct / 100), 2), pct_above_low=pct,
            days_covered=days, first_date="2025-11-17", now_date="2026-11-17",
        )

    def seed_highs(self, rows: list[price_lows.PriceHigh], window_days: int = 365) -> None:
        price_lows.write_price_highs(
            self.conn, window_days=window_days, as_of_date="2026-11-17",
            rows=price_lows.rank_highs(rows), version="v1", elapsed_ms=1.0,
        )

    def test_new_highs_not_computed_yet(self) -> None:
        result = self.tools.find_new_highs("user-a")
        self.assertEqual(result["cards"], [])
        self.assertIn("not been computed", result["note"])

    def test_new_highs_ranked_by_date_then_rise_with_fields(self) -> None:
        for card_id in ("a", "b", "c"):
            self.card(card_id)
        self.seed_highs([
            self.high("a", high_date="2026-11-14", pct=90.0),
            self.high("b", high_date="2026-11-17", pct=20.0, days=120),
            self.high("c", high_date="2026-11-17", pct=40.0),
        ])
        result = self.tools.find_new_highs("user-a")
        self.assertEqual([c["card_id"] for c in result["cards"]], ["c", "b", "a"])
        b = result["cards"][1]
        self.assertEqual((b["high_date"], b["high_usd"], b["pct_above_low"], b["days_covered"]),
                         ("2026-11-17", 50.0, 20.0, 120))
        self.assertEqual(b["low_usd"], round(50.0 / 1.2, 2))
        self.assertEqual((b["as_of"], b["variant"]), ("2026-11-17", "Holofoil"))
        self.assertIn("days_covered", result["note"])
        shaped = USER_POLICY.shape(result)
        self.assertEqual(shaped["cards"][1]["high_date"], "2026-11-17")
        self.assertEqual(shaped["cards"][1]["low_usd"], b["low_usd"])
        self.assertEqual([c["card_id"] for c in self.tools.find_new_highs("user-a", limit=1)["cards"]], ["c"])

    def test_new_highs_filters(self) -> None:
        self.card("es", set_name="Evolving Skies")
        self.card("jp", set_name="VSTAR Universe", language="Japanese")
        self.card("op", set_name="Romance Dawn", game="onepiece")
        self.card("box", set_name="Evolving Skies")
        self.conn.execute("UPDATE cards SET supertype = 'Sealed' WHERE id = 'box'")
        self.seed_highs([
            self.high("es", pct=20.0, price=20.0), self.high("jp", pct=50.0), self.high("op", pct=60.0, game="onepiece"),
            self.high("box", pct=30.0, price=200.0, sealed=True),
        ])
        self.seed_highs([self.high("es", pct=16.0, price=20.0)], window_days=90)
        self.holding("user-a", "es")
        self.holding("user-b", "box")
        ids = lambda *a, **kw: [c["card_id"] for c in self.tools.find_new_highs("user-a", *a, **kw)["cards"]]  # noqa: E731
        self.assertEqual(ids(), ["op", "box", "es"])  # Japanese left out by default
        self.assertEqual(ids({"language": "Japanese"}), ["jp"])
        self.assertEqual(ids({"product": "sealed"}), ["box"])
        self.assertEqual(ids({"product": "single", "game": "pokemon"}), ["es"])
        self.assertEqual(ids(game="onepiece"), ["op"])
        self.assertEqual(ids({"set": "Evolving Skies", "price_max_usd": 100}), ["es"])
        self.assertEqual(ids(owned="owned"), ["es"])
        self.assertEqual(ids(owned="not_owned"), ["op", "box"])
        self.assertEqual(ids(window="90d"), ["es"])
        for bad in ({"window": "5y"}, {"game": "magic"}, {"card_filter": {"scene": ["beach"]}}, {"limit": 21},
                    {"owned": "mine"}):
            with self.assertRaises(ToolInputError):
                self.tools.find_new_highs("user-a", **bad)

    def test_new_highs_assistant_tool_returns_tiles(self) -> None:
        self.card("a")
        self.seed_highs([self.high("a")])
        outcome = AssistantToolbox(self.tools).run(
            "find_new_highs", {"filter": {"product": "single"}, "window": "1y"}, owner_user_id="user-a"
        )
        self.assertFalse(outcome.is_error)
        self.assertEqual([c["card_id"] for c in outcome.cards], ["a"])
        self.assertEqual(outcome.content["cards"][0]["high_date"], "2026-11-17")
        self.assertNotIn("image_small_url", outcome.content["cards"][0])

    def test_tier_exposure(self) -> None:
        for name in ("find_price_lows", "find_new_highs", "get_market_trends"):
            self.assertTrue(USER_POLICY.allows_tool(name))
            self.assertFalse(PUBLIC_POLICY.allows_tool(name))

    # --- collectibility (owner 2026-11-20, "nobody cares about the Fairy Energy"): market-wide rankings
    # leave out bulk Energy/Trainers, sub-$10 cards and image-less cards unless asked.

    def test_rule(self) -> None:
        self.assertTrue(is_low_interest_card({"supertype": "Energy", "rarity": "Common"}))
        self.assertTrue(is_low_interest_card({"supertype": "Energy", "rarity": None}))
        self.assertTrue(is_low_interest_card({"supertype": "Trainer", "rarity": "Uncommon"}))
        self.assertFalse(is_low_interest_card({"supertype": "Trainer", "rarity": "Rare Holo"}))
        self.assertFalse(is_low_interest_card({"supertype": "Energy", "rarity": "Hyper Rare"}))  # gold energy
        self.assertFalse(is_low_interest_card({"supertype": "Trainer", "rarity": "Special Illustration Rare"}))
        self.assertFalse(is_low_interest_card({"supertype": "Pokémon", "rarity": "Common"}))

    def test_lows_skip_energy_and_imageless_unless_asked(self) -> None:
        self.card("mon")
        self.card("energy", supertype="Energy", rarity="Common", name="Fairy Energy")
        self.card("blank", image=False)
        self.seed_lows([self.low("energy", pct=80.0), self.low("blank", pct=70.0), self.low("mon", pct=30.0)])
        ids = lambda *a, **kw: [c["card_id"] for c in self.tools.find_price_lows("user-a", *a, **kw)["cards"]]  # noqa: E731
        self.assertEqual(ids(), ["mon"])
        self.assertEqual(ids(include_energy_trainers=True), ["energy", "mon"])
        self.assertEqual(ids({"text": "fairy energy"}), ["energy"])  # a name scope is the user's pick
        outcome = AssistantToolbox(self.tools).run(
            "find_price_lows", {"include_energy_trainers": True}, owner_user_id="user-a"
        )
        self.assertEqual([c["card_id"] for c in outcome.cards], ["energy", "mon"])

    def test_highs_floor_and_energy(self) -> None:
        self.card("cheap")
        self.card("energy", supertype="Energy", rarity="Common")
        self.card("big")
        self.seed_highs([self.high("cheap", price=5.0), self.high("energy", price=40.0), self.high("big", price=60.0)])
        ids = lambda *a, **kw: [c["card_id"] for c in self.tools.find_new_highs("user-a", *a, **kw)["cards"]]  # noqa: E731
        self.assertEqual(ids(), ["big"])
        self.assertEqual(ids({"price_max_usd": 10}), ["cheap"])  # an explicit price bound wins
        self.assertEqual(sorted(ids(include_energy_trainers=True)), ["big", "cheap", "energy"])

    def test_trends_skip_energy_and_cheap_cards(self) -> None:
        self._seed_trends()
        self.conn.execute("UPDATE cards SET supertype = 'Energy', rarity = 'Common' WHERE id = 'up1'")
        result = self.tools.get_market_trends("user-a", game="pokemon")
        # up1 is basic Energy; up2 at $12 clears the $10 floor.
        self.assertEqual([c["card_id"] for c in result["rising_cards"]], ["up2"])
        both = self.tools.get_market_trends("user-a", game="pokemon", include_energy_trainers=True)
        self.assertEqual([c["card_id"] for c in both["rising_cards"]], ["up1", "up2"])
        schema = {t["name"]: t for t in TOOL_DEFINITIONS}["get_market_trends"]["input_schema"]
        self.assertEqual(schema["properties"]["include_energy_trainers"]["type"], "boolean")


if __name__ == "__main__":
    unittest.main()
