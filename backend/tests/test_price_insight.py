from __future__ import annotations

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import market_movers  # noqa: E402
import price_insight  # noqa: E402
from price_insight import build_insight, compute_price_insight, sales_fact, series_facts  # noqa: E402

TODAY = date(2026, 11, 20)


def _series(values: list[float], *, end: date = TODAY) -> list[tuple[str, float]]:
    """One point per day ending at ``end``, oldest first."""
    start = end - timedelta(days=len(values) - 1)
    return [((start + timedelta(days=i)).isoformat(), v) for i, v in enumerate(values)]


def _ramp(start: float, end: float, days: int) -> list[float]:
    return [start + (end - start) * i / (days - 1) for i in range(days)]


class SeriesFactsTests(unittest.TestCase):
    def test_up_and_near_high(self) -> None:
        values = [10.0] * 60 + _ramp(10.0, 11.8, 31)
        insight = compute_price_insight(_series(values), currency_code="USD", today=TODAY)
        self.assertEqual(insight["text"], "Up 18% in 30 days · near its 90-day high")
        self.assertEqual([f["kind"] for f in insight["facts"]], ["change_30d", "high_90d"])
        self.assertEqual(insight["facts"][0]["value"], 18)

    def test_down_and_lowest(self) -> None:
        values = [50.0] * 60 + _ramp(50.0, 44.0, 31)
        insight = compute_price_insight(_series(values), currency_code="USD", today=TODAY)
        self.assertEqual(insight["text"], "Down 12% in 30 days · lowest in 90 days")
        self.assertEqual(insight["facts"][0], {"kind": "change_30d", "value": -12})
        self.assertEqual(insight["facts"][1]["kind"], "low_90d")

    def test_change_below_threshold_but_near_high(self) -> None:
        # +3% in 30 days (not notable) but the 90-day range is wide.
        values = _ramp(20.0, 29.0, 60) + _ramp(29.0, 30.0, 31)
        insight = compute_price_insight(_series(values), currency_code="USD", today=TODAY)
        self.assertEqual(insight["text"], "Near its 90-day high")

    def test_flat_is_null(self) -> None:
        self.assertIsNone(compute_price_insight(_series([12.0] * 91), currency_code="USD", today=TODAY))

    def test_small_range_is_not_a_high(self) -> None:
        values = [100.0] * 60 + _ramp(100.0, 104.0, 31)  # +4%, range < 10%
        self.assertIsNone(compute_price_insight(_series(values), currency_code="USD", today=TODAY))

    def test_sparse_history_is_null(self) -> None:
        # 10 points, none ~30 days back: no change, too few for a range.
        self.assertIsNone(compute_price_insight(_series(_ramp(10.0, 20.0, 10)), currency_code="USD", today=TODAY))

    def test_change_allows_slack_around_30_days(self) -> None:
        series = [((TODAY - timedelta(days=33)).isoformat(), 10.0), (TODAY.isoformat(), 12.0)]
        facts = series_facts(series, currency_code="USD", today=TODAY)
        self.assertEqual(facts, [{"kind": "change_30d", "value": 20}])
        too_old = [((TODAY - timedelta(days=40)).isoformat(), 10.0), (TODAY.isoformat(), 12.0)]
        self.assertEqual(series_facts(too_old, currency_code="USD", today=TODAY), [])

    def test_non_usd_is_null(self) -> None:
        values = [1000.0] * 60 + _ramp(1000.0, 1500.0, 31)
        self.assertIsNone(compute_price_insight(_series(values), currency_code="JPY", today=TODAY))
        self.assertIsNone(compute_price_insight(_series(values), currency_code=None, today=TODAY))

    def test_under_one_dollar_is_null(self) -> None:
        values = [0.5] * 60 + _ramp(0.5, 0.9, 31)
        self.assertIsNone(compute_price_insight(_series(values), currency_code="USD", today=TODAY))

    def test_stale_series_is_null(self) -> None:
        values = [10.0] * 60 + _ramp(10.0, 12.0, 31)
        stale = _series(values, end=TODAY - timedelta(days=10))
        self.assertIsNone(compute_price_insight(stale, currency_code="USD", today=TODAY))

    def test_glitch_step_is_null(self) -> None:
        values = [10.0] * 60 + [10.0] * 30 + [45.0]
        self.assertIsNone(compute_price_insight(_series(values), currency_code="USD", today=TODAY))

    def test_constants_mirror_market_movers(self) -> None:
        self.assertEqual(price_insight.MAX_STEP_MULTIPLE, market_movers.MAX_STEP_MULTIPLE)
        self.assertEqual(price_insight.CHANGE_MAX_PCT, market_movers.DEFAULT_MAX_CHANGE_PCT)


class SalesFactTests(unittest.TestCase):
    def _sale(self, days_ago: int, price: float = 100.0, currency: str = "USD") -> dict:
        return {"soldAt": (TODAY - timedelta(days=days_ago)).isoformat(), "price": price, "currencyCode": currency}

    def test_graded_sales_count(self) -> None:
        sales = [self._sale(d) for d in (1, 3, 5, 8, 12, 20, 29)] + [self._sale(45), self._sale(2, currency="JPY")]
        insight = compute_price_insight(None, currency_code="USD", sales=sales, prefix="PSA 10", today=TODAY)
        self.assertEqual(insight["text"], "PSA 10 · 7 sales in the last 30 days")
        self.assertEqual(insight["facts"], [{"kind": "sales_30d", "value": 7}])

    def test_too_few_sales_is_null(self) -> None:
        sales = [self._sale(1), self._sale(2), self._sale(60)]
        self.assertIsNone(compute_price_insight(None, currency_code="USD", sales=sales, prefix="PSA 10", today=TODAY))

    def test_capped_count_reads_as_a_floor(self) -> None:
        fact = sales_fact([self._sale(1)] * 25, today=TODAY, capped=True)
        self.assertEqual(build_insight([fact])["text"], "25+ sales in the last 30 days")

    def test_at_most_two_facts(self) -> None:
        facts = [
            {"kind": "sales_30d", "value": 5},
            {"kind": "change_30d", "value": 9},
            {"kind": "high_90d", "value": 12.0},
        ]
        self.assertEqual(build_insight(facts)["text"], "5 sales in the last 30 days · up 9% in 30 days")


class TrendListWiringTests(unittest.TestCase):
    """The insight rides on the price-trends rows the endpoint already builds."""

    def setUp(self) -> None:
        import json
        import tempfile
        from datetime import datetime, timezone

        from catalog_tools import apply_schema, connect, upsert_card

        self.tempdir = tempfile.TemporaryDirectory()
        self.connection = connect(Path(self.tempdir.name) / "insight.sqlite")
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            self.connection, card_id="i1", name="Insight Mon", set_name="Set", number="1",
            rarity="Rare", variant="Raw", language="English", supertype="Pokémon", source_payload={},
        )

        def raw(nm: float, currency: str = "USD") -> str:
            return json.dumps({"variants": {"Normal": {"variant": "Normal", "variantKey": "normal", "conditions": {
                "NM": {"market": nm, "currencyCode": currency},
                "LP": {"market": nm * 0.8, "currencyCode": currency},
            }}}})

        today = datetime.now(timezone.utc).date()
        now = datetime.now(timezone.utc).isoformat()
        values = [10.0] * 60 + _ramp(10.0, 11.8, 31)
        for offset, nm in enumerate(values):
            day = today - timedelta(days=len(values) - 1 - offset)
            self.connection.execute(
                "INSERT INTO card_price_history_daily (card_id, provider, price_date, graded_contexts_json,"
                " raw_contexts_json, display_currency_code, updated_at) VALUES (?,?,?,?,?,?,?)",
                ("i1", "scrydex", day.isoformat(), "{}", raw(nm), "USD", now),
            )
        self.connection.execute(
            "INSERT INTO card_price_snapshots (card_id, provider, graded_contexts_json, raw_contexts_json,"
            " display_currency_code, updated_at) VALUES (?,?,?,?,?,?)",
            ("i1", "scrydex", "{}", raw(11.8), "USD", now),
        )
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_raw_rows_carry_their_own_insight(self) -> None:
        from catalog_tools import card_price_trend_list

        result = card_price_trend_list(self.connection, "i1", mode="raw", provider="scrydex")
        by_key = {row["key"]: row for row in result["rows"]}
        self.assertEqual(by_key["NM"]["insight"]["text"], "Up 18% in 30 days · near its 90-day high")
        self.assertEqual(by_key["LP"]["insight"]["facts"][0], {"kind": "change_30d", "value": 18})

    def test_graded_rows_carry_the_cached_sales_count(self) -> None:
        from unittest import mock

        import server

        service = server.SpotlightScanService.__new__(server.SpotlightScanService)
        service._thread_local = type("T", (), {})()
        service._thread_local.connection = object()
        trend_list = {"mode": "psa", "rows": [
            {"key": "PSA 10", "currentPrice": 300.0, "currencyCode": "USD"},
            {"key": "PSA 9", "currentPrice": 150.0, "currencyCode": "USD"},
        ]}
        today = date.today()
        sales = [
            {"soldAt": (today - timedelta(days=d)).isoformat(), "price": p, "currencyCode": "USD",
             "title": "Insight Mon PSA 10", "sourcePayload": {}}
            for d, p in ((1, 300.0), (4, 310.0), (9, 295.0), (15, 305.0))
        ]

        def fake_cache(_conn, *, card_id, grader, grade, source, limit):
            return {"sales": sales, "status": "available"} if grade == "10" else None

        card = {"id": "i1", "name": "Insight Mon", "number": "1", "set_name": "Set", "language": "English"}
        with mock.patch.object(server, "card_by_id", return_value=card), \
             mock.patch.object(server, "slab_recent_sales_cache", side_effect=fake_cache):
            result = service._apply_recent_sales_average_to_graded_trend_rows("i1", trend_list, variant=None)
        self.assertEqual(result["rows"][0]["insight"], {
            "text": "PSA 10 · 4 sales in the last 30 days",
            "facts": [{"kind": "sales_30d", "value": 4}],
        })
        self.assertIsNone(result["rows"][1]["insight"])


if __name__ == "__main__":
    unittest.main()
