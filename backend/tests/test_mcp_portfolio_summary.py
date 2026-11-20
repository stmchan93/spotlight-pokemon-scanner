"""get_portfolio_summary baselines: USD-only, and implausible start prices are
excluded (staging 1y showed PokéPark's Munchlax at a ~$60,000 "USD" start —
Scrydex JPY history days read as dollars)."""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_tools import USER_A, McpToolsCase, _days_ago  # noqa: E402


class PortfolioSummaryBaselineTests(McpToolsCase):
    def _seed(self) -> None:
        # JP card now priced in USD (TCGCSV), older days Scrydex JPY.
        self.card("jp-munchlax", "PokéPark's Munchlax", language="Japanese", set_name="PCG Promos")
        self.price("jp-munchlax", 60.0)
        self.history("jp-munchlax", [(300, 60000.0), (200, 59000.0)], currency="JPY")
        self.history("jp-munchlax", [(30, 62.0), (1, 60.0)])
        # Yen-sized point stamped USD: no trustworthy baseline.
        self.card("jp-dragonite", "Mega Dragonite ex", language="Japanese", set_name="MEGA Dream ex")
        self.price("jp-dragonite", 150.0)
        self.history("jp-dragonite", [(300, 45000.0), (1, 150.0)])
        # Real crash printed by TCGplayer (main lane): trusted despite the ratio.
        self.card("en-crash", "Crashed Card")
        self.price("en-crash", 10.0)
        self.history("en-crash", [(300, 400.0), (1, 10.0)])
        self.conn.execute(
            "UPDATE card_price_history_daily SET main_raw_market_price = 400.0 WHERE card_id = ? AND price_date = ?",
            ("en-crash", _days_ago(300)),
        )
        # Ordinary card.
        self.card("en-plain", "Plain Card")
        self.price("en-plain", 12.0)
        self.history("en-plain", [(300, 10.0), (1, 12.0)])
        for entry_id, card_id in (
            ("h1", "jp-munchlax"),
            ("h2", "jp-dragonite"),
            ("h3", "en-crash"),
            ("h4", "en-plain"),
        ):
            self.holding(entry_id, USER_A, card_id, added_days_ago=400)
        self.conn.commit()

    def movers(self, summary):
        return {m["card_id"]: m for m in summary["top_gainers"] + summary["top_losers"]}

    def test_one_year_ignores_yen_and_implausible_baselines(self) -> None:
        summary = self.call("get_portfolio_summary", range_key="1y")
        movers = self.movers(summary)
        # Munchlax measured from its first USD day (62 -> 60), never from yen.
        self.assertEqual(movers["jp-munchlax"]["baseline_price_usd"], 62.0)
        self.assertEqual(movers["jp-munchlax"]["baseline_date"], _days_ago(30))
        self.assertEqual(movers["jp-munchlax"]["change_usd"], -2.0)
        self.assertNotIn("jp-dragonite", movers)
        self.assertEqual(movers["en-crash"]["change_usd"], -390.0)
        self.assertEqual(movers["en-plain"]["change_usd"], 2.0)
        self.assertEqual(summary["change_covers_holdings"], 3)
        self.assertEqual(summary["change_excluded_holdings"], 1)
        self.assertIn("change_excluded_note", summary)
        self.assertEqual(summary["change_usd"], -390.0)
        self.assertEqual(summary["value_usd"], 232.0)

    def test_percent_leaders_are_ranked_by_percent(self) -> None:
        summary = self.call("get_portfolio_summary", range_key="1y")
        self.assertEqual([m["card_id"] for m in summary["top_losers_pct"]], ["en-crash", "jp-munchlax"])
        self.assertEqual([m["card_id"] for m in summary["top_gainers_pct"]], ["en-plain"])
        self.assertEqual(summary["top_gainers_pct"][0]["change_pct"], 20.0)
        self.assertIn("change_pct", summary["movers_basis"])

    def test_short_range_unaffected(self) -> None:
        summary = self.call("get_portfolio_summary", range_key="30d")
        movers = self.movers(summary)
        self.assertEqual(movers["jp-munchlax"]["change_usd"], -2.0)
        self.assertEqual(summary["change_excluded_holdings"], 0)
        self.assertNotIn("change_excluded_note", summary)

    def test_app_since_series_keeps_only_current_currency(self) -> None:
        def request(key, card_id):
            return {
                "key": key, "card_id": card_id, "pricing_mode": "raw", "variant": None, "condition": None,
                "grader": None, "grade": None, "since": _days_ago(365), "printing_points": None,
            }

        self.card("jp-only", "Yen Card", language="Japanese")
        self.history("jp-only", [(100, 1500.0), (1, 1600.0)], currency="JPY")
        self.conn.commit()
        series = self.service._since_baseline_series_for_requests(
            [request("a", "jp-munchlax"), request("b", "jp-only")], lane_scoped=True
        )
        self.assertEqual(series["a"], [62.0, 60.0])  # yen days dropped
        self.assertEqual(series["b"], [1500.0, 1600.0])  # all-JPY series unchanged


if __name__ == "__main__":
    import unittest

    unittest.main()
