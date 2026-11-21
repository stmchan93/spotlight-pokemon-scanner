"""A holding is never dropped from a chart day just because that day lacks its cell.

The Collection chart values every holding per day from that day's price cells.
A slab whose graded cell was missing simply vanished from the day's total: on
staging (no graded cells by design) a $409K PSA 10 fell out for months, and on
prod a missing graded cell read as a one-day -$4-5K dip. The newest day priced
it live again, so the chart also ended on a spike.

Now a holding carries its last known price forward (<= 30 days), else takes the
next known price (<= 30 days), and the newest day's live price stands in for the
days before it. And the percent change is null against a token baseline.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_deck_entry,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

SCRYDEX = "scrydex"
CARD_ID = "carry-slab-1"
USER = "user-carry-forward"
TZ = "UTC"
RAW_MARKET = 50.0


class _SlabFixture(unittest.TestCase):
    """One PSA 10 slab. Raw cells land every day (so a daily row always
    exists, the prod shape); graded cells only on ``graded_days`` (0-based
    offsets from the first history day)."""

    HISTORY_DAYS = 10
    GRADED_DAYS: dict[int, float] = {}
    LIVE_GRADED: float | None = None

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "carry.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        upsert_card(
            connection,
            card_id=CARD_ID,
            name="Charizard",
            set_name="Base",
            number="4/102",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            source_provider=SCRYDEX,
            source_record_id=CARD_ID,
        )
        today = datetime.now(timezone.utc).date()
        self.first_day = today - timedelta(days=self.HISTORY_DAYS - 1)
        for offset in range(self.HISTORY_DAYS):
            price_date = (self.first_day + timedelta(days=offset)).isoformat()
            upsert_price_history_daily(
                connection,
                card_id=CARD_ID,
                pricing_mode=RAW_PRICING_MODE,
                provider=SCRYDEX,
                price_date=price_date,
                currency_code="USD",
                variant="Holofoil",
                condition="NM",
                low_price=RAW_MARKET - 1,
                market_price=RAW_MARKET,
                mid_price=RAW_MARKET,
                high_price=RAW_MARKET + 1,
                payload={"provider": SCRYDEX, "variantKey": "holofoil"},
            )
            graded = self.GRADED_DAYS.get(offset)
            if graded is not None:
                upsert_price_history_daily(
                    connection,
                    card_id=CARD_ID,
                    pricing_mode=PSA_GRADE_PRICING_MODE,
                    provider=SCRYDEX,
                    price_date=price_date,
                    currency_code="USD",
                    grader="PSA",
                    grade="10",
                    variant="Holofoil",
                    low_price=graded - 5,
                    market_price=graded,
                    mid_price=graded,
                    high_price=graded + 5,
                    payload={"provider": SCRYDEX, "variantKey": "holofoil"},
                )
        if self.LIVE_GRADED is not None:
            upsert_price_snapshot(
                connection,
                card_id=CARD_ID,
                pricing_mode=PSA_GRADE_PRICING_MODE,
                provider=SCRYDEX,
                currency_code="USD",
                variant="Holofoil",
                grader="PSA",
                grade="10",
                low_price=self.LIVE_GRADED - 5,
                market_price=self.LIVE_GRADED,
                mid_price=self.LIVE_GRADED,
                high_price=self.LIVE_GRADED + 5,
                payload={"provider": SCRYDEX, "variantKey": "holofoil"},
            )
        upsert_deck_entry(
            connection,
            card_id=CARD_ID,
            grader="PSA",
            grade="10",
            variant_name="Holofoil",
            quantity=1,
            owner_user_id=USER,
            added_at=self.first_day.isoformat(),
        )
        connection.commit()
        connection.close()

        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        previous = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"
        self.addCleanup(
            lambda: os.environ.pop("PRICE_HISTORY_SOURCE", None)
            if previous is None
            else os.environ.__setitem__("PRICE_HISTORY_SOURCE", previous)
        )

    def _identity(self) -> RequestIdentity:
        return RequestIdentity(user_id=USER, auth_source="test")

    def _history(self, label: str) -> dict:
        with self.service.request_identity_context(self._identity()):
            return self.service.deck_history(days=365, range_label=label, time_zone_name=TZ)

    def _sliced(self, label: str) -> dict:
        with self.service.request_identity_context(self._identity()):
            all_history = self.service.deck_history(days=365, range_label="ALL", time_zone_name=TZ)
            return self.service._portfolio_history_range_from_series(
                all_history,
                range_label=label,
                time_zone_name=TZ,
                earliest_at=self.service._portfolio_earliest_activity_at(),
            )

    def _values(self, label: str) -> list[float]:
        return [point["totalValue"] for point in self._history(label)["points"]]


class MissingCellsCarryForwardTests(_SlabFixture):
    HISTORY_DAYS = 10
    GRADED_DAYS = {0: 100.0, 1: 110.0, 2: 120.0, 3: 130.0, 4: 140.0}

    def test_slab_keeps_its_day5_value_through_day10(self) -> None:
        points = self._history("30D")["points"]
        self.assertEqual(len(points), 10)
        self.assertEqual([p["totalValue"] for p in points], [100.0, 110.0, 120.0, 130.0] + [140.0] * 6)
        self.assertEqual([p["staleHoldingCount"] for p in points], [0] * 5 + [1] * 5)
        self.assertTrue(all(p["excludedCardCount"] == 0 for p in points))
        # Carried, not live: no live-priced value anywhere.
        self.assertTrue(all(p["livePricedValue"] == 0.0 for p in points))

    def test_headline_is_the_last_point_and_delta_is_real(self) -> None:
        history = self._history("30D")
        self.assertEqual(history["summary"]["currentValue"], 140.0)
        self.assertEqual(history["summary"]["deltaValue"], 40.0)
        self.assertEqual(history["summary"]["deltaPercent"], 40.0)

    def test_one_week_window_stays_continuous(self) -> None:
        values = self._values("1W")
        self.assertTrue(all(value > 0 for value in values), values)
        self.assertEqual(values[-1], 140.0)

    def test_slices_match_the_direct_computation(self) -> None:
        for label in ("1W", "30D", "ALL"):
            with self.subTest(range=label):
                direct = self._history(label)
                sliced = self._sliced(label)
                self.assertEqual(
                    [p["totalValue"] for p in sliced["points"]],
                    [p["totalValue"] for p in direct["points"]],
                )
                for key in ("currentValue", "startValue", "deltaValue", "deltaPercent"):
                    self.assertEqual(sliced["summary"][key], direct["summary"][key], key)


class LookbackSeedTests(_SlabFixture):
    """The window opens with no graded cell inside it at all: the carry has to
    come from before the window (one batched lookback read)."""

    HISTORY_DAYS = 20
    GRADED_DAYS = {0: 300.0}

    def test_one_week_window_carries_a_pre_window_price(self) -> None:
        values = self._values("1W")
        self.assertEqual(values, [300.0] * len(values))

    def test_lookback_is_one_batched_read_not_per_day(self) -> None:
        calls: list[int] = []
        original = self.service._portfolio_history_rows_by_card_id

        def counting(**kwargs):
            calls.append(1)
            return original(**kwargs)

        self.service._portfolio_history_rows_by_card_id = counting  # type: ignore[method-assign]
        self.addCleanup(lambda: setattr(self.service, "_portfolio_history_rows_by_card_id", original))
        self._history("1W")
        # The window read plus ONE lookback read.
        self.assertEqual(len(calls), 2)


class CarryCapTests(_SlabFixture):
    HISTORY_DAYS = 40
    GRADED_DAYS = {0: 200.0}

    def test_carry_stops_after_30_days(self) -> None:
        points = self._history("90D")["points"]
        self.assertEqual(len(points), 40)
        values = [p["totalValue"] for p in points]
        # Day 0 plus 30 carried days, then nothing to carry (and no live price).
        self.assertEqual(values[:31], [200.0] * 31)
        self.assertEqual(values[31:], [0.0] * 9)
        self.assertEqual(points[30]["staleHoldingCount"], 1)
        self.assertEqual(points[31]["excludedCardCount"], 1)


class BackfillFromLaterPriceTests(_SlabFixture):
    HISTORY_DAYS = 10
    GRADED_DAYS = {4: 500.0, 5: 510.0, 6: 520.0, 7: 530.0, 8: 540.0, 9: 550.0}

    def test_days_before_the_first_cell_take_the_next_known_price(self) -> None:
        points = self._history("30D")["points"]
        self.assertEqual([p["totalValue"] for p in points][:5], [500.0] * 5)
        self.assertEqual([p["staleHoldingCount"] for p in points][:5], [1, 1, 1, 1, 0])


class NoEndSpikeWithLivePricingTests(_SlabFixture):
    """Older graded cells exist but end > 30 days before today, so the newest
    day prices the slab live. The live price is the known far end of the gap,
    so the older price bridges the whole gap: no hole, and the slab never
    appears only on the last point."""

    HISTORY_DAYS = 45
    GRADED_DAYS = {0: 1000.0, 1: 1000.0, 2: 1000.0, 3: 1000.0, 4: 1000.0}
    LIVE_GRADED = 5000.0

    def test_no_end_spike(self) -> None:
        points = self._history("ALL")["points"]
        values = [p["totalValue"] for p in points]
        # Bridged at the day-5 price right up to the live newest point.
        self.assertEqual(values[:-1], [1000.0] * 44)
        self.assertEqual(values[-1], 5000.0)
        self.assertEqual(points[-2]["staleHoldingCount"], 1)
        self.assertEqual(points[-1]["staleHoldingCount"], 0)

    def test_short_window_is_carried_not_absent(self) -> None:
        values = self._values("1W")
        self.assertEqual(values[:-1], [1000.0] * (len(values) - 1))
        self.assertEqual(values[-1], 5000.0)

    def test_a_live_priced_holding_never_reads_as_a_gain_or_loss(self) -> None:
        # Its live price is not comparable with the carried one at the start.
        for label in ("1W", "30D", "ALL"):
            with self.subTest(range=label):
                self.assertEqual(self._history(label)["summary"]["deltaValue"], 0.0)

    def test_slices_match_the_direct_computation(self) -> None:
        for label in ("1W", "30D", "90D", "ALL"):
            with self.subTest(range=label):
                direct = self._history(label)
                sliced = self._sliced(label)
                self.assertEqual(
                    [p["totalValue"] for p in sliced["points"]],
                    [p["totalValue"] for p in direct["points"]],
                )
                for key in ("currentValue", "startValue", "deltaValue", "deltaPercent"):
                    self.assertEqual(sliced["summary"][key], direct["summary"][key], key)


class NeverPricedLiveBackfillTests(_SlabFixture):
    """No history price at all: the live price backfills only up to the cap."""

    HISTORY_DAYS = 45
    GRADED_DAYS: dict[int, float] = {}
    LIVE_GRADED = 5000.0

    def test_live_backfill_is_capped(self) -> None:
        values = [p["totalValue"] for p in self._history("ALL")["points"]]
        self.assertEqual(values[-31:], [5000.0] * 31)
        self.assertEqual(values[:-31], [0.0] * 14)


class LongBridgedGapTests(_SlabFixture):
    """Known prices on BOTH sides of a 119-day gap: bridged in full, no cap."""

    HISTORY_DAYS = 130
    GRADED_DAYS = {0: 700.0, 120: 800.0, 121: 810.0}

    def test_gap_of_90_plus_days_is_bridged(self) -> None:
        points = self._history("ALL")["points"]
        values = [p["totalValue"] for p in points]
        self.assertEqual(values[:120], [700.0] * 120)
        self.assertEqual(values[120:122], [800.0, 810.0])
        self.assertTrue(all(p["staleHoldingCount"] == 1 for p in points[1:120]))
        self.assertTrue(all(p["excludedCardCount"] == 0 for p in points[:122]))

    def test_trailing_gap_is_still_capped(self) -> None:
        # Days 122..129 carry 810 (<= 30 days, nothing known after, no live).
        values = [p["totalValue"] for p in self._history("ALL")["points"]]
        self.assertEqual(values[122:], [810.0] * 8)

    def test_window_inside_the_gap_bridges_from_before_it(self) -> None:
        # The 30-day window sits inside the gap: the seed is ~90+ days back
        # (a deeper lookback tier) and the later cell closes the gap.
        direct = self._history("30D")
        sliced = self._sliced("30D")
        self.assertTrue(all(p["totalValue"] > 0 for p in direct["points"]))
        self.assertEqual(
            [p["totalValue"] for p in direct["points"]],
            [p["totalValue"] for p in sliced["points"]],
        )
        for label in ("90D", "1W"):
            with self.subTest(range=label):
                self.assertEqual(
                    [p["totalValue"] for p in self._history(label)["points"]],
                    [p["totalValue"] for p in self._sliced(label)["points"]],
                )


class LongTrailingGapCapTests(_SlabFixture):
    """A price 100 days ago and nothing after (no live): capped at 30 days."""

    HISTORY_DAYS = 101
    GRADED_DAYS = {0: 400.0}

    def test_trailing_cap_enforced_on_a_long_gap(self) -> None:
        points = self._history("ALL")["points"]
        values = [p["totalValue"] for p in points]
        self.assertEqual(values[:31], [400.0] * 31)
        self.assertEqual(values[31:], [0.0] * 70)
        self.assertEqual(points[-1]["excludedCardCount"], 1)


class DeltaPercentRuleTests(unittest.TestCase):
    pct = staticmethod(SpotlightScanService._portfolio_delta_percent)

    def test_token_start_has_no_percent(self) -> None:
        # 5 bulk cards ($1.68) on day one vs a $13K collection now.
        self.assertIsNone(self.pct(13000.0 - 1.68, 1.68, 13000.0))
        self.assertIsNone(self.pct(13000.0 - 1.68, 1.68))

    def test_real_start_has_a_percent(self) -> None:
        self.assertEqual(self.pct(8000.0, 5000.0, 13000.0), 160.0)

    def test_absolute_floor_is_100(self) -> None:
        self.assertIsNone(self.pct(1.0, 99.99, 100.99))
        self.assertEqual(self.pct(10.0, 100.0, 110.0), 10.0)

    def test_relative_floor_is_5_percent_of_comparable_current(self) -> None:
        # 5% of $10,000 = $500.
        self.assertIsNone(self.pct(9501.0, 499.0, 10000.0))
        self.assertIsNotNone(self.pct(9500.0, 500.0, 10000.0))


if __name__ == "__main__":
    unittest.main()
