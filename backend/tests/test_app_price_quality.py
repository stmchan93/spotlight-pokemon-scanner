"""The app's collection surfaces withhold the same prices the chat tools do
(price_quality): a stale price (no observation in 14 days) or a raw price above
the card's own PSA 10 shows no price, is left out of the total, and is left out
of EVERY chart point (no cliff)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_price_quality import PriceQualityCase  # noqa: E402
from test_mcp_tools import USER_A, _days_ago  # noqa: E402
import price_quality  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import utc_now  # noqa: E402


class AppPriceQualityTests(PriceQualityCase):
    def _seed(self) -> None:
        self.any_card("fresh", "Fresh Card")
        self.scrydex_price("fresh", 50.0)
        self.history("fresh", [(day, 50.0) for day in range(0, 40)], variant="Holofoil")
        # Scrydex raw cells stopped 125 days ago; the snapshot clock is fresh.
        self.any_card("stale", "Stale Card")
        self.scrydex_price("stale", 461.96)
        self.history("stale", [(day, 461.96) for day in range(125, 200)], variant="Holofoil")
        # Raw $500 vs its own PSA 10 $351.94 (1.42x: under the old 1.5x guard).
        self.any_card("phantom", "Phantom Card")
        self.scrydex_price("phantom", 500.0)
        self.history("phantom", [(day, 500.0) for day in range(0, 40)], variant="Holofoil")
        self.psa10_cell("phantom", 0, 351.94)
        self.holding("h-fresh", USER_A, "fresh", quantity=2, added_days_ago=60)
        self.holding("h-stale", USER_A, "stale", added_days_ago=60)
        self.holding("h-phantom", USER_A, "phantom", added_days_ago=60)
        self.conn.commit()

    def as_user(self):
        return self.service.request_identity_context(RequestIdentity(user_id=USER_A, auth_source="test"))

    def entries_by_id(self, payload):
        return {entry["id"]: entry for entry in payload["entries"]}

    def test_collection_rows_and_total(self) -> None:
        payload = self.service.deck_entries_for_owner(USER_A)
        # A stale price is still the last known value: shown and counted.
        self.assertEqual(payload["summary"]["totalValue"], 561.96)
        self.assertEqual(payload["summary"]["stalePriceCount"], 0)
        self.assertEqual(payload["summary"]["untrustedPriceCount"], 1)
        rows = self.entries_by_id(payload)
        stale = rows["h-stale"]["card"]["pricing"]
        self.assertEqual(stale["market"], 461.96)
        self.assertNotIn("priceStatus", stale)
        phantom = rows["h-phantom"]["card"]["pricing"]
        self.assertIsNone(phantom["market"])
        self.assertEqual((phantom["priceStatus"], phantom["ownPsa10Price"]), ("untrusted", 351.94))
        self.assertIsNone(rows["h-phantom"]["sparkPoints"])
        self.assertIsNone(rows["h-phantom"]["sinceAddedChangeAmount"])
        fresh = rows["h-fresh"]["card"]["pricing"]
        self.assertEqual(fresh["market"], 50.0)
        self.assertNotIn("priceStatus", fresh)

    def test_chart_leaves_untrusted_holdings_out_of_every_point(self) -> None:
        with self.as_user():
            history = self.service.deck_history(range_label="30D", time_zone_name="UTC")
        values = {point["totalValue"] for point in history["points"]}
        # No cliff: the untrusted holding is out of every day; the stale one counts.
        self.assertEqual(values, {561.96})
        self.assertEqual(history["summary"]["currentValue"], 561.96)
        self.assertEqual(history["summary"]["deltaValue"], 0.0)
        self.assertEqual(history["coverage"]["stalePriceCount"], 0)
        self.assertEqual(history["coverage"]["untrustedPriceCount"], 1)

    def test_chart_keeps_a_card_whose_price_is_current_again(self) -> None:
        # A gap in observations that ended is not stale: the holding counts.
        self.history("stale", [(day, 461.96) for day in range(0, 3)], variant="Holofoil")
        self.conn.commit()
        with self.as_user():
            history = self.service.deck_history(range_label="30D", time_zone_name="UTC")
        self.assertEqual(history["summary"]["currentValue"], 561.96)
        self.assertEqual(history["coverage"]["stalePriceCount"], 0)

    def test_watchlist_row(self) -> None:
        self.conn.execute(
            "INSERT INTO card_favorites (owner_user_id, card_id, variant_key, created_at) VALUES (?, ?, '', ?)",
            ("user-b", "stale", utc_now()),
        )
        self.conn.commit()
        entry = self.service._compute_card_favorites_for_owner("user-b")["entries"][0]
        self.assertEqual(entry["marketPrice"], 461.96)
        self.assertNotIn("priceStatus", entry["card"]["pricing"])

    def test_insights_tracker_row(self) -> None:
        with self.as_user():
            rows = {row["entryId"]: row for row in self.service._compute_portfolio_performance()["rows"]}
        self.assertEqual(rows["h-stale"]["currentPrice"], 461.96)
        self.assertIsNone(rows["h-stale"]["priceStatus"])
        self.assertEqual(rows["h-phantom"]["priceStatus"], "untrusted")
        self.assertEqual(rows["h-fresh"]["currentPrice"], 50.0)
        self.assertIsNone(rows["h-fresh"]["priceStatus"])

    def test_card_detail(self) -> None:
        context = self.service._raw_pricing_context()
        detail = self.service._card_detail_for_context("stale", pricing_context=context)
        self.assertEqual(detail["card"]["pricing"]["market"], 461.96)
        self.assertNotIn("priceStatus", detail["card"]["pricing"])
        fresh = self.service._card_detail_for_context("fresh", pricing_context=context)
        self.assertEqual(fresh["card"]["pricing"]["market"], 50.0)

    def test_chat_counts_match_the_app(self) -> None:
        result = self.call("get_my_collection")
        self.assertEqual(result["total_value_usd"], 100.0)
        self.assertEqual((result["stale_price_count"], result["untrusted_price_count"]), (1, 1))


class AssessPriceTests(unittest.TestCase):
    CUTOFF = "2026-11-08"

    def assess(self, pricing, facts, *, graded=False):
        return price_quality.assess_price(
            pricing, price_quality.served_price(pricing), facts, graded=graded, cutoff=self.CUTOFF
        )

    def test_scrydex_raw_uses_the_raw_cell_clock(self) -> None:
        pricing = {"market": 10.0, "refreshedAt": "2026-11-21T00:00:00+00:00"}
        self.assertEqual(self.assess(pricing, {"raw_date": "2026-07-19"}), {"status": "stale", "as_of": "2026-07-19"})
        self.assertIsNone(self.assess(pricing, {"raw_date": "2026-11-20"}))
        self.assertIsNone(self.assess(pricing, {}))  # no cells: the snapshot clock

    def test_tcgplayer_main_uses_its_own_stamp(self) -> None:
        pricing = {"market": 10.0, "mainPriceSource": "tcgcsv", "refreshedAt": "2026-11-21T00:00:00+00:00"}
        self.assertIsNone(self.assess(pricing, {"raw_date": "2026-07-19"}))

    def test_graded_takes_the_newer_clock(self) -> None:
        pricing = {"market": 300.0, "refreshedAt": "2026-11-21T00:00:00+00:00"}
        self.assertIsNone(self.assess(pricing, {"graded_date": "2026-07-19"}, graded=True))
        pricing = {"market": 300.0, "refreshedAt": "2026-07-01T00:00:00+00:00"}
        self.assertEqual(self.assess(pricing, {"graded_date": "2026-07-19"}, graded=True)["status"], "stale")

    def test_untrusted_is_same_printing_only(self) -> None:
        facts = {"raw_date": "2026-11-20", "psa10": {"holofoil": 351.94}}
        pricing = {"market": 461.96, "variant": "Holofoil"}
        self.assertEqual(self.assess(pricing, facts), {"status": "untrusted", "psa10_usd": 351.94})
        self.assertIsNone(self.assess({"market": 461.96, "variant": "Reverse Holofoil"}, facts))
        self.assertIsNone(self.assess({"market": 351.94, "variant": "Holofoil"}, facts))
        self.assertIsNone(self.assess(pricing, facts, graded=True))

    def test_app_serves_stale_prices(self) -> None:
        pricing = {"market": 10.0, "low": 9.0, "variant": "Holofoil"}
        served, verdict = price_quality.apply_price_quality(
            pricing, {"raw_date": "2026-01-01"}, graded=False, cutoff=self.CUTOFF
        )
        self.assertIs(served, pricing)
        self.assertIsNone(verdict)

    def test_withheld_pricing_does_not_mutate(self) -> None:
        pricing = {"market": 10.0, "low": 9.0, "variant": "Holofoil"}
        verdict = {"status": "stale", "as_of": "2026-01-01"}
        served = price_quality.withheld_pricing(pricing, verdict)
        self.assertEqual(pricing["market"], 10.0)
        self.assertEqual((served["market"], served["low"], served["priceStatus"]), (None, None, "stale"))
        self.assertEqual(price_quality.verdict_from_pricing(served), verdict)


if __name__ == "__main__":
    unittest.main()
