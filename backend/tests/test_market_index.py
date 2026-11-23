"""market_index: the per-game Market Index (basket selection fixed per month,
rebalanced on the 1st, equal-weight chain-linking, continuity across a
rebalance, base 100, resume/append, window slicing, exclusions, empty
fallback) and its place in the Market Analytics payload.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import SEALED_SUPERTYPE, apply_schema, connect, upsert_card, utc_now  # noqa: E402
import market_analytics  # noqa: E402
import market_index  # noqa: E402
from market_index import Member, chain_segment, drop_spikes  # noqa: E402
from server import _apply_price_history_cells_schema_patch  # noqa: E402

START = date(2026, 1, 15)
END = date(2026, 3, 5)


def _days(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


class ChainMathTests(unittest.TestCase):
    def test_equal_weight_mean_of_ratios_with_carry_forward(self) -> None:
        members = [Member("a", "m", None, 10.0), Member("b", "m", None, 10.0)]
        series = {
            "a": [("2026-01-01", 10.0), ("2026-01-02", 20.0)],  # selection-day point skipped
            "b": [("2026-01-03", 5.0)],  # carried at 10 on the 2nd
        }
        out = chain_segment(members, series, start=date(2026, 1, 1), end=date(2026, 1, 4), start_value=100.0)
        self.assertEqual([d for d, _ in out], ["2026-01-02", "2026-01-03", "2026-01-04"])
        # 2nd: (2 + 1) / 2 = 1.5; 3rd: (1 + 0.5) / 2 = 0.75; 4th: flat.
        self.assertAlmostEqual(out[0][1], 150.0)
        self.assertAlmostEqual(out[1][1], 112.5)
        self.assertAlmostEqual(out[2][1], 112.5)

    def test_equal_weight_not_price_weight(self) -> None:
        # A $1000 card +10% and a $10 card -10% net to flat, not +9.8%.
        members = [Member("big", "m", None, 1000.0), Member("small", "m", None, 10.0)]
        series = {"big": [("2026-01-02", 1100.0)], "small": [("2026-01-02", 9.0)]}
        out = chain_segment(members, series, start=date(2026, 1, 1), end=date(2026, 1, 2), start_value=100.0)
        self.assertAlmostEqual(out[0][1], 100.0)

    def test_data_break_step_rebases_instead_of_moving_the_index(self) -> None:
        # An 82% one-day drop that stays (a source switch) is not a market move.
        members = [Member("a", "m", None, 100.0), Member("b", "m", None, 100.0)]
        series = {"a": [("2026-01-02", 18.0), ("2026-01-03", 18.9)], "b": [("2026-01-02", 110.0)]}
        out = chain_segment(members, series, start=date(2026, 1, 1), end=date(2026, 1, 3), start_value=100.0)
        self.assertAlmostEqual(out[0][1], 105.0)  # (1.0 rebased + 1.1) / 2
        self.assertAlmostEqual(out[1][1], 105.0 * (1.05 + 1.0) / 2)  # a moves +5% from its new level

    def test_drop_spikes_removes_single_glitch_only(self) -> None:
        points = [("1", 100.0), ("2", 400.0), ("3", 100.0), ("4", 250.0), ("5", 260.0)]
        self.assertEqual(drop_spikes(points), [("1", 100.0), ("3", 100.0), ("4", 250.0), ("5", 260.0)])

    def test_first_of_next_month(self) -> None:
        self.assertEqual(market_index.first_of_next_month(date(2026, 12, 15)), date(2027, 1, 1))
        self.assertEqual(market_index.first_of_next_month(date(2026, 2, 1)), date(2026, 3, 1))


class IndexFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "index.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        self.connection.commit()
        # Small baskets so the fixture stays readable.
        for name, value in (("BASKET_SIZE", 2), ("MIN_BASKET_SIZE", 1)):
            patcher = mock.patch.object(market_index, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _card(self, card_id: str, *, game: str = "pokemon", language: str = "English",
              supertype: str = "Pokémon", image: bool = True) -> None:
        upsert_card(
            self.connection, card_id=card_id, name=card_id.title(), set_name="Set", number="1/100",
            rarity="Special Illustration Rare", variant="Raw", language=language, game=game,
            source_provider="scrydex", source_record_id=card_id, set_id="s1", supertype=supertype,
            image_url=f"https://img/{card_id}.png" if image else None,
            image_small_url=f"https://img/{card_id}_s.png" if image else None,
        )

    def _price(self, card_id: str, day: date, value: float) -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO card_price_history_daily (card_id, provider, price_date, display_currency_code, "
            "main_raw_market_price, main_raw_variant, updated_at) VALUES (?, 'scrydex', ?, 'USD', ?, 'Holofoil', ?)",
            (card_id, day.isoformat(), value, utc_now()),
        )

    def _path(self, card_id: str, fn, *, start: date = START, end: date = END) -> None:
        for day in _days(start, end):
            self._price(card_id, day, fn(day))

    def _market(self) -> None:
        """A: 100 -> 200 on 1/20 -> 220 on 3/3. B: 50 flat. C: 30 -> 85 on 2/10
        -> 90 on 3/1. D: 150 with a 600 glitch on 2/20, 165 from 3/1. Plus
        pricier cards the basket must skip (Japanese, sealed, no image)."""
        for card_id in ("a", "b", "c", "d"):
            self._card(card_id)
        self._path("a", lambda d: 100.0 if d < date(2026, 1, 20) else 200.0 if d < date(2026, 3, 3) else 220.0)
        self._path("b", lambda d: 50.0)
        self._path("c", lambda d: 30.0 if d < date(2026, 2, 10) else 85.0 if d < date(2026, 3, 1) else 90.0)
        self._path("d", lambda d: 600.0 if d == date(2026, 2, 20) else 150.0 if d < date(2026, 3, 1) else 165.0)
        self._card("jp", language="Japanese")
        self._path("jp", lambda d: 1000.0 + d.toordinal() % 7)
        self._card("sealed", supertype=SEALED_SUPERTYPE)
        self._path("sealed", lambda d: 900.0)
        self._card("noimage", image=False)
        self._path("noimage", lambda d: 800.0)
        # A graded price is not a raw price: B's $5000 PSA 10 cell must not count.
        self.connection.execute(
            "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, variant_key, "
            "grader, grade, currency_code, market, updated_at) VALUES ('b', 'scrydex', ?, 'graded', "
            "'g|PSA|10|Holofoil', 'Holofoil', 'PSA', '10', 'USD', 5000, ?)",
            (END.isoformat(), utc_now()),
        )
        self.connection.commit()

    def _levels(self, game: str = "pokemon") -> dict[str, float]:
        return {
            str(r[0]): float(r[1])
            for r in self.connection.execute("SELECT date, value FROM market_index_daily WHERE game = ?", (game,))
        }

    def _baskets(self, game: str = "pokemon") -> dict[str, tuple[str, list[str]]]:
        out: dict[str, tuple[str, list[str]]] = {}
        for month, selected_on, card_id in self.connection.execute(
            "SELECT month, selected_on, card_id FROM market_index_baskets WHERE game = ? ORDER BY month, rank", (game,)
        ):
            out.setdefault(month, (selected_on, []))[1].append(card_id)
        return out


class RefreshTests(IndexFixture):
    def test_baskets_fixed_per_month_rebalanced_on_the_first(self) -> None:
        self._market()
        report = market_index.refresh_market_index(self.connection, games=("pokemon",))
        self.assertEqual(report["games"]["pokemon"]["baseDate"], START.isoformat())
        self.assertEqual(
            self._baskets(),
            {
                # Exclusions: jp / sealed / noimage outprice everything.
                "2026-01": ("2026-01-15", ["d", "a"]),
                # C passes B in price on 2/10 but waits for March.
                "2026-02": ("2026-02-01", ["a", "d"]),
                # D's 2/20 glitch (4x) is in the 30-day lookback: skipped.
                "2026-03": ("2026-03-01", ["a", "c"]),
            },
        )

    def test_base_100_chain_link_and_continuity_across_rebalance(self) -> None:
        self._market()
        market_index.refresh_market_index(self.connection, games=("pokemon",))
        levels = self._levels()
        self.assertEqual(len(levels), (END - START).days + 1)
        self.assertAlmostEqual(levels["2026-01-15"], 100.0)
        self.assertAlmostEqual(levels["2026-01-19"], 100.0)
        self.assertAlmostEqual(levels["2026-01-20"], 150.0)  # A x2, D flat: mean 1.5
        self.assertAlmostEqual(levels["2026-02-01"], 150.0)
        self.assertAlmostEqual(levels["2026-02-20"], 150.0)  # D's glitch dropped
        self.assertAlmostEqual(levels["2026-02-28"], 150.0)
        # 3/1 still moves with the OLD basket (D +10%, C's move not counted)...
        self.assertAlmostEqual(levels["2026-03-01"], 157.5)
        # ...and the new basket (A, C) moves it from 3/2: A +10% on 3/3.
        self.assertAlmostEqual(levels["2026-03-02"], 157.5)
        self.assertAlmostEqual(levels["2026-03-03"], 165.375)
        self.assertAlmostEqual(levels["2026-03-05"], 165.375)

    def test_skip_then_resume_appends_without_rewriting_history(self) -> None:
        self._market()
        market_index.refresh_market_index(self.connection, games=("pokemon",))
        before = self._levels()
        again = market_index.refresh_market_index(self.connection, games=("pokemon",))
        self.assertEqual(again["games"]["pokemon"], {"skipped": True})

        nxt = END + timedelta(days=1)
        self._price("a", nxt, 242.0)  # +10%
        for card_id, value in (("b", 50.0), ("c", 90.0), ("d", 165.0)):
            self._price(card_id, nxt, value)
        self.connection.commit()
        report = market_index.refresh_market_index(self.connection, games=("pokemon",))
        self.assertEqual(report["games"]["pokemon"]["resumedFrom"], "2026-03-01")
        after = self._levels()
        for day, value in before.items():
            self.assertAlmostEqual(after[day], value)
        self.assertAlmostEqual(after[nxt.isoformat()], 165.375 * 1.05)
        self.assertEqual(self._baskets()["2026-03"], ("2026-03-01", ["a", "c"]))

    def test_force_rebuilds_the_same_series(self) -> None:
        self._market()
        market_index.refresh_market_index(self.connection, games=("pokemon",))
        before = self._levels()
        market_index.refresh_market_index(self.connection, games=("pokemon",), force=True)
        self.assertEqual(self._levels().keys(), before.keys())

    def test_game_with_later_prices_starts_at_100_on_its_first_rebalance(self) -> None:
        self._market()
        self._card("op1", game="onepiece")
        self._path("op1", lambda d: 40.0 if d < date(2026, 3, 4) else 44.0, start=date(2026, 2, 5))
        report = market_index.refresh_market_index(self.connection, games=("pokemon", "onepiece"))
        self.assertEqual(report["games"]["onepiece"]["baseDate"], "2026-03-01")
        levels = self._levels("onepiece")
        self.assertAlmostEqual(levels["2026-03-01"], 100.0)
        self.assertAlmostEqual(levels["2026-03-04"], 110.0)
        self.assertNotIn("2026-02-28", levels)

    def test_no_price_history_is_a_no_op(self) -> None:
        report = market_index.refresh_market_index(self.connection)
        self.assertEqual(report["games"], {})
        self.assertIsNone(market_index.index_payload(self.connection, "pokemon", 30))


class PayloadTests(IndexFixture):
    def test_window_slicing_change_and_range(self) -> None:
        self._market()
        market_index.refresh_market_index(self.connection, games=("pokemon",))
        week = market_index.index_payload(self.connection, "pokemon", 7)
        assert week is not None
        self.assertEqual(week["name"], "Pokémon Market Index")
        self.assertEqual(week["points"][0], {"date": "2026-02-26", "value": 150.0})
        self.assertEqual(week["points"][-1], {"date": "2026-03-05", "value": 165.38})
        self.assertEqual(len(week["points"]), 8)
        self.assertEqual(week["value"], 165.38)
        self.assertEqual(week["changePct"], 10.25)
        self.assertEqual((week["rangeLow"], week["rangeHigh"]), (150.0, 165.38))
        self.assertEqual(week["basketSize"], 2)
        self.assertEqual(week["rebalancedOn"], "2026-03-01")

        year = market_index.index_payload(self.connection, "pokemon", 365)
        assert year is not None
        self.assertEqual(year["points"][0], {"date": "2026-01-15", "value": 100.0})
        self.assertLessEqual(len(year["points"]), market_index.INDEX_POINTS)
        self.assertEqual(year["changePct"], 65.38)
        self.assertEqual((year["rangeLow"], year["rangeHigh"]), (100.0, 165.38))

    def test_market_analytics_payload_carries_index_and_1y(self) -> None:
        self._market()
        with mock.patch.object(market_analytics, "grading_fee_usd", return_value=30.0):
            report = market_analytics.refresh_market_analytics(self.connection, today=END)
        self.assertIn("pokemon", report["marketIndex"]["games"])
        self.assertEqual(market_analytics.WINDOWS["1y"], 365)
        year = market_analytics.read_payload(self.connection, "pokemon", 365)
        assert year is not None
        self.assertEqual(year["window"], "1y")
        self.assertEqual(year["pulse"]["index"]["changePct"], 65.38)
        # Old builds keep their fields.
        for key in ("changePct", "indexValueUsd", "breadth", "sparkline"):
            self.assertIn(key, year["pulse"])
        # A game without an index reads null, not an error.
        gundam = market_analytics.read_payload(self.connection, "gundam", 30)
        assert gundam is not None
        self.assertIsNone(gundam["pulse"]["index"])
        self.assertIsNone(market_analytics.empty_payload("pokemon", "1y")["pulse"]["index"])


if __name__ == "__main__":
    unittest.main()
