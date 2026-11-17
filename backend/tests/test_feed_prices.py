"""feed_prices: per-card raw price + 7-day change for the feed blocks. Guards
per-source resolution (a newer Scrydex-only row must not demote a TCGCSV card),
the never-yen rule for Scrydex JP default-raw, and the single-step outlier
guard on the displayed % change.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, upsert_fx_rate_snapshot, utc_now  # noqa: E402
from feed_prices import _resolve, raw_price_changes, raw_price_changes_all  # noqa: E402
from market_movers import _DailyRow  # noqa: E402
from server import _apply_price_history_cells_schema_patch  # noqa: E402

TODAY = date(2026, 11, 17)


def _d(days_ago: int) -> str:
    return (TODAY - timedelta(days=days_ago)).isoformat()


class FeedPricesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "feed.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        upsert_fx_rate_snapshot(self.connection, base_currency="JPY", quote_currency="USD",
                                rate=0.0067, source="test")

    def _card(self, card_id: str, *, language: str = "English") -> None:
        upsert_card(
            self.connection, card_id=card_id, name=card_id.title(), set_name="Test Set",
            number="1/100", rarity="Rare", variant="Raw", language=language, game="pokemon",
            source_provider="scrydex", source_record_id=card_id,
        )

    def _daily(self, card_id: str, days_ago: int, *, default: float | None = None,
               main: float | None = None, currency: str = "USD", variant: str | None = "Holofoil") -> None:
        self.connection.execute(
            "INSERT INTO card_price_history_daily (card_id, provider, price_date, "
            "display_currency_code, default_raw_market_price, main_raw_market_price, "
            "main_raw_variant, updated_at) VALUES (?, 'scrydex', ?, ?, ?, ?, ?, ?)",
            (card_id, _d(days_ago), currency, default, main, variant if main else None, utc_now()),
        )

    def _both(self) -> list[dict]:
        self.connection.commit()
        ids = [r[0] for r in self.connection.execute("SELECT id FROM cards")]
        return [
            raw_price_changes(self.connection, ids, ref_date=TODAY),
            raw_price_changes_all(self.connection, ref_date=TODAY),
        ]

    def test_newer_scrydex_only_row_keeps_the_main_lane(self) -> None:
        self._card("umbreon")
        for days_ago, price in ((8, 10.0), (7, 10.0), (4, 11.0), (1, 12.0)):
            self._daily("umbreon", days_ago, default=price * 100, main=price)
        self._daily("umbreon", 0, default=9000.0)  # Scrydex wrote the newest date first
        for prices in self._both():
            p = prices["umbreon"]
            self.assertEqual((p.price_now, p.price_then, p.now_date), (12.0, 10.0, _d(1)))
            self.assertAlmostEqual(p.change_pct, 20.0)

    def test_scrydex_jp_default_raw_is_never_shown(self) -> None:
        # Yen-sized values labelled USD (adv4_ja-62) and JPY-labelled rows.
        self._card("adv4_ja-62", language="Japanese")
        for days_ago, price in ((7, 15000.0), (3, 21000.0), (0, 90000.0)):
            self._daily("adv4_ja-62", days_ago, default=price)
        self._card("jpy-card", language="Japanese")
        for days_ago in (7, 0):
            self._daily("jpy-card", days_ago, default=3000.0, currency="JPY")
        # Japanese card on the TCGCSV lane is real USD.
        self._card("bw1w_ja-27", language="Japanese")
        for days_ago, price in ((7, 6.0), (0, 7.5)):
            self._daily("bw1w_ja-27", days_ago, main=price)
        # English Scrydex-only USD fallback still works; non-USD is dropped.
        self._card("en")
        for days_ago, price in ((7, 10.0), (3, 11.0), (0, 12.0)):
            self._daily("en", days_ago, default=price)
        self._card("en-eur")
        self._daily("en-eur", 0, default=10.0, currency="EUR")
        for prices in self._both():
            self.assertEqual(set(prices), {"bw1w_ja-27", "en"})
            self.assertEqual(prices["bw1w_ja-27"].price_now, 7.5)
            self.assertAlmostEqual(prices["en"].change_pct, 20.0)
        # The shared resolver (market_alerts) refuses a JP id even without a language.
        row = _DailyRow("adv4_ja-62", _d(0), "USD", 90000.0, None)
        then = _DailyRow("adv4_ja-62", _d(1), "USD", 15000.0, None)
        self.assertIsNone(_resolve(row, then, max_change_pct=1000.0))

    def test_single_step_outlier_hides_the_change(self) -> None:
        self._card("ru1-12")
        for days_ago in range(9, 2, -1):
            self._daily("ru1-12", days_ago, main=279.99 if days_ago > 5 else 280.48)
        for days_ago in range(2, -1, -1):
            self._daily("ru1-12", days_ago, main=2997.81 - days_ago)
        self._card("climb")
        for days_ago, price in ((7, 10.0), (5, 13.0), (3, 17.0), (0, 22.0)):
            self._daily("climb", days_ago, main=price)
        for prices in self._both():
            lucario = prices["ru1-12"]
            self.assertIsNone(lucario.change_pct)
            self.assertIsNone(lucario.price_then)
            self.assertAlmostEqual(prices["climb"].change_pct, 120.0)


if __name__ == "__main__":
    unittest.main()
