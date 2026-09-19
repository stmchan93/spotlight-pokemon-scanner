"""watch_signals: the watchlist deal/digest engine.

Every guardrail is exercised in isolation — the $5 floor, the >=12%
significance bar, the >=60% "too good" suppression, the raw-JP language fence,
the same-source rule, the flat-anchor distinct-price filter, the re-arm rules
and the 3-per-day cap — plus the load-bearing
``min(added_market_price, current_market_price)`` baseline in both directions
(added during a spike, added years ago) and the four history-only signals.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from watch_signals import (  # noqa: E402
    CARD_REARM_DAYS,
    GUARDRAIL_ORDER,
    KIND_DRAWDOWN_30D,
    KIND_SINCE_WATCHED,
    KIND_TARGET_HIT,
    KIND_TRAILING_LOW,
    KIND_UNDER_ADDED,
    LANE_GRADED,
    LANE_RAW,
    MAX_ALERTS_PER_DAY,
    DealSignal,
    ListingCandidate,
    PricePoint,
    PriorAlert,
    WatchBaseline,
    discount_pct,
    drawdown_30d_signal,
    effective_baseline_cents,
    evaluate_history_signals,
    evaluate_under_added,
    evaluate_under_added_batch,
    history_span_days,
    listing_candidate_from_validated,
    passes_distinct_prices,
    passes_language_fence,
    passes_price_floor,
    passes_significance,
    passes_too_good_floor,
    points_in_window,
    price_points_from_history_rows,
    rank_and_cap,
    rearm_allows,
    recent_alerts_for_owner,
    same_source_ok,
    same_source_points,
    since_watched_signal,
    target_hit_signal,
    trailing_low_signal,
    watched_card_baselines,
    watched_cards,
)

TODAY = date(2026, 9, 19)
NOW = datetime(2026, 9, 19, 12, 0, tzinfo=timezone.utc)
SRC = "USD|normal|nm||"
JP_SRC = "JPY|normal|nm||"


def _d(days_ago: int) -> str:
    return (TODAY - timedelta(days=days_ago)).isoformat()


def _points(values_cents, *, days_apart: int = 30, source: str = SRC) -> tuple[PricePoint, ...]:
    """A series ending today, oldest→newest, one point every ``days_apart``."""
    count = len(values_cents)
    return tuple(
        PricePoint(
            price_date=_d(days_apart * (count - 1 - i)),
            price_cents=value,
            source_key=source,
        )
        for i, value in enumerate(values_cents)
    )


def _baseline(
    *,
    owner: str = "owner-1",
    card_id: str = "card-1",
    lane: str = LANE_RAW,
    language: str = "English",
    added_cents: int | None = 10_000,
    market_cents: int | None = 10_000,
    points=None,
    source: str = SRC,
    added_source: str | None = None,
    target_price_cents: int | None = None,
    target_triggered_at: str | None = None,
) -> WatchBaseline:
    series = points if points is not None else _points([9_700, 10_300, 9_900, 10_100, market_cents or 10_000], source=source)
    return WatchBaseline(
        owner_user_id=owner,
        card_id=card_id,
        lane=lane,
        language=language,
        added_market_cents=added_cents,
        added_market_date=_d(200),
        added_source_key=added_source,
        current_market_cents=market_cents,
        current_market_date=_d(0),
        market_source_key=source,
        points=series,
        target_price_cents=target_price_cents,
        target_triggered_at=target_triggered_at,
    )


def _listing(
    total_cents: int,
    *,
    listing_id: str = "ebay-1",
    card_id: str = "card-1",
    shipping_cents: int = 0,
    currency: str = "USD",
    is_auction: bool = False,
) -> ListingCandidate:
    return ListingCandidate(
        listing_id=listing_id,
        card_id=card_id,
        price_cents=total_cents - shipping_cents,
        shipping_cents=shipping_cents,
        url=f"https://ebay/{listing_id}",
        is_auction=is_auction,
        verification_tier="scrydex",
        currency_code=currency,
    )


# --- Signal A: the min() baseline -------------------------------------------


class EffectiveBaselineTests(unittest.TestCase):
    def test_takes_the_lower_of_added_and_market(self) -> None:
        self.assertEqual(effective_baseline_cents(10_000, 4_000), 4_000)
        self.assertEqual(effective_baseline_cents(2_000, 8_000), 2_000)

    def test_missing_side_falls_back_to_the_other(self) -> None:
        self.assertEqual(effective_baseline_cents(None, 8_000), 8_000)
        self.assertEqual(effective_baseline_cents(5_000, None), 5_000)
        self.assertIsNone(effective_baseline_cents(None, None))

    def test_cross_source_drops_the_add_time_number(self) -> None:
        # A Scrydex/JPY add-time price against a TCGCSV/USD market is not a
        # comparable pair, so the min is never taken across them.
        self.assertEqual(
            effective_baseline_cents(2_000, 8_000, added_source=JP_SRC, market_source=SRC),
            8_000,
        )

    def test_added_during_a_spike_does_not_alert_forever(self) -> None:
        """Added at $100 mid-spike; the market is $40 now. Listings near $40 are
        ordinary, not deals — without the min() every one of them would alert."""
        baseline = _baseline(added_cents=10_000, market_cents=4_000)
        ordinary = evaluate_under_added(_listing(3_800), baseline, now=NOW)
        self.assertFalse(ordinary.passed)
        self.assertEqual(ordinary.rejected_by, "significance")
        real_deal = evaluate_under_added(_listing(3_000), baseline, now=NOW)
        self.assertTrue(real_deal.passed)
        self.assertEqual(real_deal.signal.baseline_cents, 4_000)
        self.assertEqual(real_deal.signal.discount_pct, 25.0)

    def test_added_years_ago_before_the_market_doubled(self) -> None:
        """Added at $20; the market is $80 now. A $60 listing is 25% under
        market but way above what the user paid attention to — not a deal."""
        baseline = _baseline(added_cents=2_000, market_cents=8_000)
        expensive = evaluate_under_added(_listing(6_000), baseline, now=NOW)
        self.assertFalse(expensive.passed)
        self.assertEqual(expensive.rejected_by, "significance")
        real_deal = evaluate_under_added(_listing(1_500), baseline, now=NOW)
        self.assertTrue(real_deal.passed)
        self.assertEqual(real_deal.signal.baseline_cents, 2_000)

    def test_shipping_is_included_in_the_comparison(self) -> None:
        baseline = _baseline(added_cents=10_000, market_cents=10_000)
        # $85 + $15 shipping = $100: exactly market, no deal.
        self.assertFalse(
            evaluate_under_added(_listing(10_000, shipping_cents=1_500), baseline, now=NOW).passed
        )
        # $80 + $5 shipping = $85: 15% under.
        result = evaluate_under_added(_listing(8_500, shipping_cents=500), baseline, now=NOW)
        self.assertTrue(result.passed)
        self.assertEqual(result.signal.total_cents, 8_500)


# --- guardrails, one at a time ----------------------------------------------


class PriceFloorTests(unittest.TestCase):
    def test_helper(self) -> None:
        self.assertTrue(passes_price_floor(500))
        self.assertFalse(passes_price_floor(499))
        self.assertFalse(passes_price_floor(None))
        self.assertFalse(passes_price_floor(10_000, 100))

    def test_penny_card_is_rejected_before_anything_else(self) -> None:
        baseline = _baseline(added_cents=400, market_cents=400, points=_points([380, 420, 400]))
        result = evaluate_under_added(_listing(100), baseline, now=NOW)
        self.assertFalse(result.passed)
        self.assertEqual(result.rejected_by, "price_floor")

    def test_listing_under_five_dollars_is_rejected(self) -> None:
        baseline = _baseline(added_cents=10_000, market_cents=10_000)
        result = evaluate_under_added(_listing(499), baseline, now=NOW)
        self.assertFalse(result.passed)
        self.assertEqual(result.rejected_by, "price_floor")


class LanguageFenceTests(unittest.TestCase):
    def test_helper_accepts_both_spellings(self) -> None:
        for value in ("en", "EN", "English", "english", "eng"):
            self.assertTrue(passes_language_fence(value, lane=LANE_RAW))
        for value in ("Japanese", "ja", None, ""):
            self.assertFalse(passes_language_fence(value, lane=LANE_RAW))

    def test_raw_jp_is_fenced_out(self) -> None:
        """~1028 Japanese raw cards carry broken Scrydex anchors (priced above
        their own slabs); a deal computed against one is garbage."""
        baseline = _baseline(language="Japanese", lane=LANE_RAW, added_cents=10_000, market_cents=10_000)
        result = evaluate_under_added(_listing(5_500), baseline, now=NOW)
        self.assertFalse(result.passed)
        self.assertEqual(result.rejected_by, "language_fence")

    def test_graded_jp_stays_eligible(self) -> None:
        baseline = _baseline(language="Japanese", lane=LANE_GRADED, added_cents=10_000, market_cents=10_000)
        result = evaluate_under_added(_listing(5_500), baseline, now=NOW)
        self.assertTrue(result.passed)
        self.assertEqual(result.signal.kind, KIND_UNDER_ADDED)

    def test_fence_also_gates_the_history_signals(self) -> None:
        raw_jp = _baseline(
            language="Japanese", lane=LANE_RAW, added_cents=10_000, market_cents=5_000,
            points=_points([10_000, 9_000, 8_000, 6_000, 5_000], days_apart=30),
        )
        self.assertEqual(evaluate_history_signals(raw_jp, today=TODAY), [])


class SameSourceTests(unittest.TestCase):
    def test_helper(self) -> None:
        self.assertTrue(same_source_ok(SRC, SRC))
        self.assertFalse(same_source_ok(SRC, JP_SRC))
        # Unknown lineage (legacy card_favorites rows) is tolerated.
        self.assertTrue(same_source_ok(None, SRC))
        self.assertTrue(same_source_ok(SRC, ""))

    def test_series_is_trimmed_to_the_newest_point_source(self) -> None:
        mixed = (
            PricePoint(_d(90), 1_000, JP_SRC),
            PricePoint(_d(60), 1_100, JP_SRC),
            PricePoint(_d(30), 9_000, SRC),
            PricePoint(_d(0), 9_500, SRC),
        )
        kept = same_source_points(mixed)
        self.assertEqual([p.price_cents for p in kept], [9_000, 9_500])

    def test_non_usd_listing_is_rejected(self) -> None:
        baseline = _baseline(added_cents=10_000, market_cents=10_000)
        result = evaluate_under_added(_listing(5_500, currency="JPY"), baseline, now=NOW)
        self.assertFalse(result.passed)
        self.assertEqual(result.rejected_by, "same_source")

    def test_lane_flip_mid_window_starves_the_series(self) -> None:
        # Only two USD points survive the trim -> the distinct filter rejects.
        mixed = (
            PricePoint(_d(90), 1_000, JP_SRC),
            PricePoint(_d(60), 1_100, JP_SRC),
            PricePoint(_d(30), 9_000, SRC),
            PricePoint(_d(0), 9_500, SRC),
        )
        baseline = _baseline(added_cents=10_000, market_cents=9_500, points=mixed)
        result = evaluate_under_added(_listing(5_000), baseline, now=NOW)
        self.assertFalse(result.passed)
        self.assertEqual(result.rejected_by, "distinct_prices")


class DistinctPriceTests(unittest.TestCase):
    def test_helper(self) -> None:
        self.assertTrue(passes_distinct_prices(_points([1, 2, 3])))
        self.assertFalse(passes_distinct_prices(_points([1, 1, 2])))
        self.assertFalse(passes_distinct_prices(()))

    def test_flat_scrydex_anchor_that_ticks_once_is_rejected(self) -> None:
        anchor = _points([3_000] * 6 + [9_000], days_apart=10)
        baseline = _baseline(added_cents=9_000, market_cents=9_000, points=anchor)
        result = evaluate_under_added(_listing(4_000), baseline, now=NOW)
        self.assertFalse(result.passed)
        self.assertEqual(result.rejected_by, "distinct_prices")


class SignificanceTests(unittest.TestCase):
    def test_helper(self) -> None:
        self.assertTrue(passes_significance(12.0))
        self.assertFalse(passes_significance(11.99))

    def test_eleven_percent_is_jitter_twelve_is_a_deal(self) -> None:
        baseline = _baseline(added_cents=10_000, market_cents=10_000)
        self.assertEqual(
            evaluate_under_added(_listing(8_900), baseline, now=NOW).rejected_by, "significance"
        )
        self.assertTrue(evaluate_under_added(_listing(8_800), baseline, now=NOW).passed)


class TooGoodFloorTests(unittest.TestCase):
    def test_helper(self) -> None:
        self.assertTrue(passes_too_good_floor(59.99))
        self.assertFalse(passes_too_good_floor(60.0))
        self.assertFalse(passes_too_good_floor(95.0))

    def test_sixty_percent_under_is_suppressed_not_promoted(self) -> None:
        """That band is proxies, damage and wrong-card listings — the single
        most important false-positive defence."""
        baseline = _baseline(added_cents=10_000, market_cents=10_000)
        just_under = evaluate_under_added(_listing(4_001), baseline, now=NOW)
        self.assertTrue(just_under.passed)
        at_the_line = evaluate_under_added(_listing(4_000), baseline, now=NOW)
        self.assertFalse(at_the_line.passed)
        self.assertEqual(at_the_line.rejected_by, "too_good_floor")
        absurd = evaluate_under_added(_listing(600), baseline, now=NOW)
        self.assertEqual(absurd.rejected_by, "too_good_floor")


class RearmTests(unittest.TestCase):
    def _prior(self, *, listing_id="ebay-1", card_id="card-1", total=9_000, days_ago=1) -> PriorAlert:
        return PriorAlert(
            listing_id=listing_id,
            card_id=card_id,
            total_cents=total,
            created_at=(NOW - timedelta(days=days_ago)).isoformat(),
        )

    def test_same_listing_never_alerts_twice(self) -> None:
        prior = self._prior(listing_id="ebay-1", total=5_000, days_ago=30)
        self.assertFalse(rearm_allows(_listing(4_500, listing_id="ebay-1"), [prior], now=NOW))

    def test_same_card_inside_seven_days_is_blocked(self) -> None:
        prior = self._prior(listing_id="ebay-old", total=9_000, days_ago=2)
        # 5% better is not enough to interrupt again.
        self.assertFalse(rearm_allows(_listing(8_550, listing_id="ebay-new"), [prior], now=NOW))

    def test_a_ten_percent_better_price_re_arms_early(self) -> None:
        prior = self._prior(listing_id="ebay-old", total=9_000, days_ago=2)
        self.assertTrue(rearm_allows(_listing(8_100, listing_id="ebay-new"), [prior], now=NOW))

    def test_after_seven_days_the_card_re_arms_on_its_own(self) -> None:
        prior = self._prior(listing_id="ebay-old", total=9_000, days_ago=CARD_REARM_DAYS + 1)
        self.assertTrue(rearm_allows(_listing(8_900, listing_id="ebay-new"), [prior], now=NOW))

    def test_other_cards_are_unaffected(self) -> None:
        prior = self._prior(listing_id="ebay-old", card_id="other", total=9_000, days_ago=1)
        self.assertTrue(rearm_allows(_listing(8_900, listing_id="ebay-new"), [prior], now=NOW))

    def test_rearm_runs_inside_the_guardrail_walk(self) -> None:
        baseline = _baseline(added_cents=10_000, market_cents=10_000)
        prior = self._prior(listing_id="ebay-1", total=9_000, days_ago=1)
        result = evaluate_under_added(_listing(8_000), baseline, prior_alerts=[prior], now=NOW)
        self.assertFalse(result.passed)
        self.assertEqual(result.rejected_by, "rearm")


class DailyCapTests(unittest.TestCase):
    @staticmethod
    def _signal(listing_id: str, *, pct: float, savings: int) -> DealSignal:
        return DealSignal(
            kind=KIND_UNDER_ADDED,
            owner_user_id="owner-1",
            card_id=f"card-{listing_id}",
            listing_id=listing_id,
            url="https://ebay/x",
            total_cents=1_000,
            baseline_cents=1_000 + savings,
            market_cents=1_000 + savings,
            added_cents=None,
            discount_pct=pct,
            savings_cents=savings,
        )

    def test_ranked_by_discount_times_absolute_dollars(self) -> None:
        signals = [
            self._signal("tiny", pct=50.0, savings=600),        # score 3
            self._signal("chase", pct=15.0, savings=20_000),    # score 3000
            self._signal("mid", pct=20.0, savings=4_000),       # score 800
            self._signal("small", pct=30.0, savings=1_200),     # score 360
            self._signal("floor", pct=13.0, savings=700),       # score 91
        ]
        kept = rank_and_cap(signals)
        self.assertEqual(len(kept), MAX_ALERTS_PER_DAY)
        self.assertEqual([s.listing_id for s in kept], ["chase", "mid", "small"])

    def test_already_sent_today_tops_up_instead_of_restarting(self) -> None:
        signals = [self._signal(f"l{i}", pct=20.0, savings=1_000 * (i + 1)) for i in range(4)]
        self.assertEqual(len(rank_and_cap(signals, already_sent_today=2)), 1)
        self.assertEqual(rank_and_cap(signals, already_sent_today=3), [])

    def test_batch_applies_the_cap_after_the_per_listing_walk(self) -> None:
        baselines = {
            f"card-{i}": _baseline(card_id=f"card-{i}", added_cents=10_000, market_cents=10_000)
            for i in range(5)
        }
        candidates = [
            _listing(8_000 - i * 100, listing_id=f"ebay-{i}", card_id=f"card-{i}") for i in range(5)
        ]
        # Plus one that the guardrails must drop before the cap sees it.
        baselines["card-jp"] = _baseline(card_id="card-jp", language="Japanese")
        candidates.append(_listing(5_000, listing_id="ebay-jp", card_id="card-jp"))
        kept = evaluate_under_added_batch(candidates, baselines, now=NOW)
        self.assertEqual(len(kept), MAX_ALERTS_PER_DAY)
        self.assertNotIn("ebay-jp", [s.listing_id for s in kept])
        # Same baseline everywhere, so the cheapest three win.
        self.assertEqual([s.listing_id for s in kept], ["ebay-4", "ebay-3", "ebay-2"])


class GuardrailOrderTests(unittest.TestCase):
    def test_order_is_explicit_and_every_name_is_reachable(self) -> None:
        self.assertEqual(
            GUARDRAIL_ORDER,
            (
                "language_fence",
                "price_floor",
                "same_source",
                "distinct_prices",
                "significance",
                "too_good_floor",
                "rearm",
                "daily_cap",
            ),
        )

    def test_the_earliest_failing_guardrail_wins(self) -> None:
        """A raw-JP penny card with a flat anchor and an absurd discount is
        rejected by the FIRST rule, not the last."""
        baseline = _baseline(
            language="Japanese", lane=LANE_RAW, added_cents=100, market_cents=100,
            points=_points([100, 100, 100]),
        )
        self.assertEqual(
            evaluate_under_added(_listing(10), baseline, now=NOW).rejected_by, "language_fence"
        )
        # Drop the fence: the floor is next.
        english = _baseline(added_cents=100, market_cents=100, points=_points([100, 100, 100]))
        self.assertEqual(
            evaluate_under_added(_listing(10), english, now=NOW).rejected_by, "price_floor"
        )


# --- Signal B: price-history-only -------------------------------------------


class WindowHelperTests(unittest.TestCase):
    def test_window_is_anchored_on_the_newest_point(self) -> None:
        points = _points([1, 2, 3, 4, 5], days_apart=30)  # -120 .. 0
        window = points_in_window(points, days=90, today=TODAY)
        self.assertEqual([p.price_date for p in window], [_d(90), _d(60), _d(30), _d(0)])

    def test_span(self) -> None:
        self.assertEqual(history_span_days(_points([1, 2, 3], days_apart=45)), 90)
        self.assertEqual(history_span_days(_points([1])), 0)


class TrailingLowTests(unittest.TestCase):
    def test_current_at_the_ninety_day_low_fires(self) -> None:
        points = _points([12_000, 11_000, 10_000, 9_000, 8_000], days_apart=30)
        baseline = _baseline(market_cents=8_000, points=points, added_cents=12_000)
        signal = trailing_low_signal(baseline, today=TODAY)
        self.assertIsNotNone(signal)
        self.assertEqual(signal.kind, KIND_TRAILING_LOW)
        self.assertEqual(signal.detail["windowLowCents"], 8_000)

    def test_above_the_low_does_not_fire(self) -> None:
        points = _points([12_000, 8_000, 10_000, 9_500, 9_000], days_apart=30)
        baseline = _baseline(market_cents=9_000, points=points)
        self.assertIsNone(trailing_low_signal(baseline, today=TODAY))

    def test_three_months_of_history_is_required(self) -> None:
        """A card tracked for a fortnight has no "low" to speak of."""
        short = _points([12_000, 11_000, 10_000, 9_000], days_apart=4)  # 12-day span
        baseline = _baseline(market_cents=9_000, points=short)
        self.assertIsNone(trailing_low_signal(baseline, today=TODAY))
        long = _points([12_000, 11_000, 10_000, 9_000], days_apart=31)  # 93-day span
        self.assertIsNotNone(
            trailing_low_signal(_baseline(market_cents=9_000, points=long), today=TODAY)
        )


class Drawdown30dTests(unittest.TestCase):
    def test_twelve_percent_under_the_thirty_day_median_fires(self) -> None:
        points = _points([10_000, 10_000, 10_200, 9_800, 8_000], days_apart=7)
        baseline = _baseline(market_cents=8_000, points=points)
        signal = drawdown_30d_signal(baseline, today=TODAY)
        self.assertIsNotNone(signal)
        self.assertEqual(signal.kind, KIND_DRAWDOWN_30D)
        self.assertEqual(signal.reference_cents, 10_000)
        self.assertEqual(signal.move_pct, 20.0)

    def test_eleven_percent_is_below_the_bar(self) -> None:
        points = _points([10_000, 10_000, 10_200, 9_800, 8_900], days_apart=7)
        baseline = _baseline(market_cents=8_900, points=points)
        self.assertIsNone(drawdown_30d_signal(baseline, today=TODAY))

    def test_median_not_mean_so_one_bad_sync_day_cannot_fabricate_it(self) -> None:
        # A single 3x spike would drag a mean up enough to fake a drawdown.
        points = _points([9_000, 30_000, 9_000, 9_100, 8_800], days_apart=7)
        baseline = _baseline(market_cents=8_800, points=points)
        self.assertIsNone(drawdown_30d_signal(baseline, today=TODAY))


class SinceWatchedTests(unittest.TestCase):
    def test_five_percent_below_the_add_time_price_fires(self) -> None:
        baseline = _baseline(added_cents=10_000, market_cents=9_500,
                             points=_points([10_000, 9_900, 9_700, 9_500]))
        signal = since_watched_signal(baseline)
        self.assertIsNotNone(signal)
        self.assertEqual(signal.kind, KIND_SINCE_WATCHED)
        self.assertEqual(signal.move_pct, 5.0)

    def test_four_percent_does_not(self) -> None:
        baseline = _baseline(added_cents=10_000, market_cents=9_600,
                             points=_points([10_000, 9_900, 9_700, 9_600]))
        self.assertIsNone(since_watched_signal(baseline))

    def test_cross_source_add_time_price_is_not_compared(self) -> None:
        baseline = _baseline(added_cents=10_000, market_cents=5_000, added_source=JP_SRC,
                             points=_points([10_000, 9_000, 7_000, 5_000]))
        self.assertIsNone(since_watched_signal(baseline))


class TargetHitTests(unittest.TestCase):
    def test_downward_crossing_fires(self) -> None:
        points = _points([12_000, 11_000, 10_500, 9_000], days_apart=10)
        baseline = _baseline(market_cents=9_000, points=points)
        signal = target_hit_signal(baseline, target_price_cents=10_000, today=TODAY)
        self.assertIsNotNone(signal)
        self.assertEqual(signal.kind, KIND_TARGET_HIT)
        self.assertEqual(signal.reference_cents, 10_000)

    def test_already_below_the_line_is_not_a_crossing(self) -> None:
        points = _points([9_500, 9_400, 9_200, 9_000], days_apart=10)
        baseline = _baseline(market_cents=9_000, points=points)
        self.assertIsNone(target_hit_signal(baseline, target_price_cents=10_000, today=TODAY))

    def test_above_the_target_does_not_fire(self) -> None:
        points = _points([12_000, 11_000, 10_500, 10_400], days_apart=10)
        baseline = _baseline(market_cents=10_400, points=points)
        self.assertIsNone(target_hit_signal(baseline, target_price_cents=10_000, today=TODAY))

    def test_thirty_day_re_arm(self) -> None:
        points = _points([12_000, 11_000, 10_500, 9_000], days_apart=10)
        baseline = _baseline(market_cents=9_000, points=points)
        self.assertIsNone(
            target_hit_signal(
                baseline, target_price_cents=10_000, target_triggered_at=_d(5), today=TODAY
            )
        )
        self.assertIsNotNone(
            target_hit_signal(
                baseline, target_price_cents=10_000, target_triggered_at=_d(31), today=TODAY
            )
        )

    def test_no_target_means_no_signal(self) -> None:
        baseline = _baseline(market_cents=9_000)
        self.assertIsNone(target_hit_signal(baseline, today=TODAY))
        self.assertIsNone(target_hit_signal(baseline, target_price_cents=0, today=TODAY))

    def test_target_is_a_parameter_not_a_column_read(self) -> None:
        """``card_favorites.target_price_cents`` does not exist yet; passing the
        target in must work regardless of what the row carries."""
        points = _points([12_000, 11_000, 10_500, 9_000], days_apart=10)
        baseline = _baseline(market_cents=9_000, points=points, target_price_cents=None)
        self.assertIsNotNone(target_hit_signal(baseline, target_price_cents=10_000, today=TODAY))


class HistorySignalBundleTests(unittest.TestCase):
    def test_a_falling_card_produces_several_digest_lines(self) -> None:
        points = _points([12_000, 11_000, 10_000, 9_000, 8_000], days_apart=30)
        baseline = _baseline(added_cents=12_000, market_cents=8_000, points=points)
        kinds = {s.kind for s in evaluate_history_signals(baseline, today=TODAY)}
        self.assertEqual(kinds, {KIND_TRAILING_LOW, KIND_SINCE_WATCHED})

    def test_flat_anchor_produces_nothing(self) -> None:
        points = _points([3_000] * 5, days_apart=30)
        baseline = _baseline(added_cents=3_000, market_cents=3_000, points=points)
        self.assertEqual(evaluate_history_signals(baseline, today=TODAY), [])


# --- the daily job's batched read -------------------------------------------


class WatchedCardBaselineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "watch.sqlite"
        self.connection = connect(self.database_path)
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        # The add-time baseline columns are runtime patches on card_favorites,
        # not part of schema.sql; mirror them here.
        for column, kind in (("added_market_price", "REAL"), ("added_market_date", "TEXT")):
            self.connection.execute(f"ALTER TABLE card_favorites ADD COLUMN {column} {kind}")
        self.connection.commit()

    def _card(self, card_id: str, *, language: str = "English") -> None:
        upsert_card(
            self.connection, card_id=card_id, name=card_id.title(), set_name="Test Set",
            number="1/100", rarity="Rare", variant="Raw", language=language, game="pokemon",
            source_provider="scrydex", source_record_id=card_id,
        )

    def _favorite(self, owner: str, card_id: str, *, added: float | None = None) -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO card_favorites "
            "(owner_user_id, card_id, created_at, added_market_price, added_market_date) "
            "VALUES (?, ?, ?, ?, ?)",
            (owner, card_id, utc_now(), added, _d(200)),
        )

    def _daily(self, card_id: str, days_ago: int, market: float) -> None:
        contexts = {
            "variants": {
                "Normal": {
                    "variant": "Normal",
                    "variantKey": "normal",
                    "conditions": {"NM": {"currencyCode": "USD", "market": market}},
                }
            }
        }
        self.connection.execute(
            "INSERT OR REPLACE INTO card_price_history_daily "
            "(card_id, provider, price_date, display_currency_code, raw_contexts_json, updated_at) "
            "VALUES (?, 'scrydex', ?, 'USD', ?, ?)",
            (card_id, _d(days_ago), json.dumps(contexts), utc_now()),
        )

    def test_baselines_carry_added_current_and_series(self) -> None:
        self._card("alpha")
        self._favorite("owner-1", "alpha", added=120.0)
        for days_ago, market in ((90, 120.0), (60, 110.0), (30, 100.0), (0, 80.0)):
            self._daily("alpha", days_ago, market)
        self.connection.commit()
        baselines = watched_card_baselines(self.connection)
        self.assertEqual(len(baselines), 1)
        baseline = baselines[0]
        self.assertEqual(baseline.owner_user_id, "owner-1")
        self.assertEqual(baseline.card_id, "alpha")
        self.assertEqual(baseline.added_market_cents, 12_000)
        self.assertEqual(baseline.current_market_cents, 8_000)
        self.assertEqual(baseline.current_market_date, _d(0))
        self.assertEqual([p.price_cents for p in baseline.points], [12_000, 11_000, 10_000, 8_000])
        self.assertTrue(baseline.market_source_key.startswith("USD|"))
        self.assertEqual(baseline.language, "English")

    def test_one_batched_history_read_for_every_watched_card(self) -> None:
        for index in range(6):
            card_id = f"card-{index}"
            self._card(card_id)
            # Two owners watch the same cards: the card_id is still read once.
            self._favorite("owner-1", card_id, added=50.0)
            self._favorite("owner-2", card_id, added=50.0)
            for days_ago, market in ((60, 50.0), (30, 45.0), (0, 40.0)):
                self._daily(card_id, days_ago, market)
        self.connection.commit()

        statements: list[str] = []
        self.connection.set_trace_callback(statements.append)
        try:
            baselines = watched_card_baselines(self.connection)
        finally:
            self.connection.set_trace_callback(None)

        self.assertEqual(len(baselines), 12)
        history_reads = [s for s in statements if "card_price_history_daily" in s]
        self.assertEqual(len(history_reads), 1, history_reads)
        self.assertNotIn("card_id = ?", history_reads[0])

    def test_missing_target_columns_are_tolerated(self) -> None:
        """card_favorites has no target_price_cents yet — the read must not
        assume the later schema patch has landed."""
        self._card("beta")
        self._favorite("owner-1", "beta", added=50.0)
        self.connection.commit()
        rows = watched_cards(self.connection)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["target_price_cents"])
        self.assertIsNone(rows[0]["target_triggered_at"])
        self.assertIsNone(watched_card_baselines(self.connection)[0].target_price_cents)

    def test_owner_scoping(self) -> None:
        self._card("gamma")
        self._favorite("owner-1", "gamma", added=50.0)
        self._favorite("owner-2", "gamma", added=50.0)
        self.connection.commit()
        rows = watched_cards(self.connection, owner_user_ids=["owner-2"])
        self.assertEqual([row["owner_user_id"] for row in rows], ["owner-2"])

    def test_recent_alerts_is_empty_until_deal_alerts_exists(self) -> None:
        self.assertEqual(recent_alerts_for_owner(self.connection, "owner-1"), [])

    def test_recent_alerts_reads_the_table_once_it_exists(self) -> None:
        self.connection.execute(
            "CREATE TABLE deal_alerts (owner_user_id TEXT, card_id TEXT, listing_id TEXT, "
            "total_cents INTEGER, created_at TEXT)"
        )
        self.connection.execute(
            "INSERT INTO deal_alerts VALUES (?, ?, ?, ?, ?)",
            ("owner-1", "alpha", "ebay-1", 8_000, (NOW - timedelta(days=1)).isoformat()),
        )
        self.connection.execute(
            "INSERT INTO deal_alerts VALUES (?, ?, ?, ?, ?)",
            ("owner-1", "alpha", "ebay-old", 8_000, (NOW - timedelta(days=90)).isoformat()),
        )
        self.connection.commit()
        alerts = recent_alerts_for_owner(self.connection, "owner-1", now=NOW)
        self.assertEqual([a.listing_id for a in alerts], ["ebay-1"])


class PricePointConversionTests(unittest.TestCase):
    def test_rows_become_usd_cents_oldest_first(self) -> None:
        rows = [
            {"date": _d(0), "market": 80.0, "currencyCode": "USD", "variant": "Normal", "condition": "NM"},
            {"date": _d(30), "market": 100.0, "currencyCode": "USD", "variant": "Normal", "condition": "NM"},
        ]
        points = price_points_from_history_rows(rows)
        self.assertEqual([p.price_date for p in points], [_d(30), _d(0)])
        self.assertEqual([p.price_cents for p in points], [10_000, 8_000])
        self.assertEqual(len({p.source_key for p in points}), 1)

    def test_unconvertible_currency_is_dropped_not_guessed(self) -> None:
        rows = [{"date": _d(0), "market": 1000.0, "currencyCode": "EUR"}]
        self.assertEqual(price_points_from_history_rows(rows), ())
        # JPY needs an FX rate; without one it is equally ineligible.
        rows = [{"date": _d(0), "market": 1000.0, "currencyCode": "JPY"}]
        self.assertEqual(price_points_from_history_rows(rows, jpy_usd=None), ())

    def test_source_key_separates_currencies(self) -> None:
        rows = [
            {"date": _d(0), "market": 80.0, "currencyCode": "USD", "variant": "Normal", "condition": "NM"},
            {"date": _d(30), "market": 80.0, "currencyCode": "JPY", "variant": "Normal", "condition": "NM"},
        ]
        points = price_points_from_history_rows(rows, jpy_usd=Decimal("0.0067"))
        self.assertEqual(len({p.source_key for p in points}), 2)
        self.assertEqual(len(same_source_points(points)), 1)


class ListingContractTests(unittest.TestCase):
    """The seam with the listing validator: dollars/camelCase -> cents."""

    VALID = {
        "cardID": "card-1",
        "itemID": "v1|123|0",
        "title": "Umbreon VMAX 215/203",
        "itemURL": "https://ebay/123",
        "imageURL": "https://img/123.jpg",
        "priceAmount": 80.0,
        "shippingAmount": 5.0,
        "shippingKnown": True,
        "totalAmount": 85.0,
        "currencyCode": "USD",
        "buyingOption": "auction",
        "auctionEndAt": "2026-09-19T18:00:00Z",
        "verification": "scrydex",
    }

    def test_maps_into_integer_cents(self) -> None:
        candidate = listing_candidate_from_validated(self.VALID)
        self.assertEqual(candidate.listing_id, "v1|123|0")
        self.assertEqual(candidate.card_id, "card-1")
        self.assertEqual(candidate.price_cents, 8_000)
        self.assertEqual(candidate.shipping_cents, 500)
        self.assertEqual(candidate.total_cents, 8_500)
        self.assertTrue(candidate.is_auction)
        self.assertEqual(candidate.verification_tier, "scrydex")

    def test_unknown_shipping_is_not_a_candidate(self) -> None:
        """A $2 card with $15 postage reads as a deal when shipping is missing."""
        row = dict(self.VALID, shippingKnown=False, shippingAmount=None, totalAmount=80.0)
        self.assertIsNone(listing_candidate_from_validated(row))
        loose = listing_candidate_from_validated(row, require_known_shipping=False)
        self.assertEqual(loose.shipping_cents, 0)

    def test_malformed_rows_are_dropped(self) -> None:
        self.assertIsNone(listing_candidate_from_validated(None))
        self.assertIsNone(listing_candidate_from_validated(dict(self.VALID, priceAmount=None)))
        self.assertIsNone(listing_candidate_from_validated(dict(self.VALID, itemID="", itemURL="")))

    def test_an_adapted_candidate_flows_straight_into_the_engine(self) -> None:
        candidate = listing_candidate_from_validated(self.VALID)
        baseline = _baseline(card_id="card-1", added_cents=12_000, market_cents=12_000)
        result = evaluate_under_added(candidate, baseline, now=NOW)
        self.assertTrue(result.passed)
        self.assertEqual(result.signal.total_cents, 8_500)
        self.assertEqual(result.signal.discount_pct, 29.17)


class DiscountMathTests(unittest.TestCase):
    def test_discount_pct(self) -> None:
        self.assertEqual(discount_pct(8_000, 10_000), 20.0)
        self.assertEqual(discount_pct(10_000, 10_000), 0.0)
        self.assertLess(discount_pct(12_000, 10_000), 0.0)
        self.assertEqual(discount_pct(100, 0), 0.0)


if __name__ == "__main__":
    unittest.main()
