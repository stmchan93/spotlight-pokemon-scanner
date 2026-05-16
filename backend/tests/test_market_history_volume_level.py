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
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_card_price_summary,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from server import SpotlightScanService  # noqa: E402


def _iso_date(offset_days: int) -> str:
    return (date.today() - timedelta(days=offset_days)).isoformat()


class CardVolumeLevelTests(unittest.TestCase):
    """Direct tests of SpotlightScanService._card_volume_level over the
    trailing 30 days of `card_price_history_daily` rows."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "volume.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            self.connection,
            card_id="base1-4",
            name="Charizard",
            set_name="Base Set",
            number="4/102",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="base1-4",
            set_id="base1",
            set_series="Base",
            supertype="Pokemon",
        )
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def _seed_daily_rows(self, *, prices: list[float], starting_days_ago: int = 0) -> None:
        for index, market in enumerate(prices):
            upsert_price_history_daily(
                self.connection,
                card_id="base1-4",
                pricing_mode=RAW_PRICING_MODE,
                provider="scrydex",
                price_date=_iso_date(starting_days_ago + index),
                currency_code="USD",
                variant="Holofoil",
                condition="NM",
                low_price=market - 0.5,
                market_price=market,
                mid_price=market,
                high_price=market + 0.5,
                payload={"provider": "scrydex", "variantKey": "holofoil"},
            )
        self.connection.commit()

    def _service(self) -> SpotlightScanService:
        return SpotlightScanService(self.database_path, REPO_ROOT)

    def test_card_volume_level_returns_unknown_when_under_seven_days(self) -> None:
        # 5 days of rows -> unknown.
        self._seed_daily_rows(prices=[10.0, 11.0, 12.0, 13.0, 14.0])
        service = self._service()
        try:
            self.assertEqual(service._card_volume_level("base1-4"), "unknown")
        finally:
            service.connection.close()

    def test_card_volume_level_returns_low_when_history_is_flat(self) -> None:
        # 10 days, all identical market prices -> distinct=1 -> low.
        self._seed_daily_rows(prices=[7.5] * 10)
        service = self._service()
        try:
            self.assertEqual(service._card_volume_level("base1-4"), "low")
        finally:
            service.connection.close()

    def test_card_volume_level_returns_normal_with_distinct_prices(self) -> None:
        # 10 days, two distinct prices -> normal.
        prices = [5.0, 5.0, 5.5, 5.0, 5.5, 5.0, 5.0, 5.5, 5.0, 5.5]
        self._seed_daily_rows(prices=prices)
        service = self._service()
        try:
            self.assertEqual(service._card_volume_level("base1-4"), "normal")
        finally:
            service.connection.close()


class CardMarketHistoryVolumeLevelIntegrationTests(unittest.TestCase):
    """Verifies card_market_history surfaces volumeLevel and restricts
    availableConditions to NM only when the card is illiquid."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "volume_integration.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            self.connection,
            card_id="base1-4",
            name="Charizard",
            set_name="Base Set",
            number="4/102",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="base1-4",
            set_id="base1",
            set_series="Base",
            supertype="Pokemon",
        )
        # Seed an active snapshot summary so raw context resolution finds
        # multiple condition entries that we then expect to be filtered down
        # to NM-only when volume is "low".
        upsert_card_price_summary(
            self.connection,
            card_id="base1-4",
            source="scrydex",
            currency_code="USD",
            variant="Holofoil",
            low_price=14.5,
            market_price=15.0,
            mid_price=15.0,
            high_price=15.5,
            direct_low_price=14.0,
            trend_price=15.0,
            source_updated_at="2026-04-14",
            source_url="https://prices.example/base1-4",
            payload={"provider": "scrydex", "priceSource": "scrydex"},
        )
        for condition_code, market in (("NM", 15.0), ("LP", 12.0), ("MP", 9.0)):
            upsert_price_snapshot(
                self.connection,
                card_id="base1-4",
                pricing_mode=RAW_PRICING_MODE,
                provider="scrydex",
                currency_code="USD",
                variant="Holofoil",
                condition=condition_code,
                low_price=market - 0.5,
                market_price=market,
                mid_price=market,
                high_price=market + 0.5,
                payload={"provider": "scrydex", "variantKey": "holofoil"},
            )
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def _seed_flat_daily_rows(self) -> None:
        # 10 days of flat NM pricing per condition -> distinct=1 -> low.
        for condition_code, market in (("NM", 15.0), ("LP", 12.0), ("MP", 9.0)):
            for index in range(10):
                upsert_price_history_daily(
                    self.connection,
                    card_id="base1-4",
                    pricing_mode=RAW_PRICING_MODE,
                    provider="scrydex",
                    price_date=_iso_date(index),
                    currency_code="USD",
                    variant="Holofoil",
                    condition=condition_code,
                    low_price=market - 0.5,
                    market_price=market,
                    mid_price=market,
                    high_price=market + 0.5,
                    payload={"provider": "scrydex", "variantKey": "holofoil"},
                )
        self.connection.commit()

    def test_card_market_history_filters_available_conditions_to_nm_when_low_volume(self) -> None:
        self._seed_flat_daily_rows()
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            payload = service.card_market_history("base1-4", days=30)
        finally:
            service.connection.close()

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["pricingMode"], "raw")
        self.assertEqual(payload["volumeLevel"], "low")
        available_ids = [str(option.get("id") or "").upper() for option in payload["availableConditions"]]
        self.assertEqual(available_ids, ["NM"])

    def test_card_market_history_surfaces_unknown_volume_when_history_is_thin(self) -> None:
        # Only seed 3 days of NM daily history -> volume "unknown" -> NM-only filter.
        for index in range(3):
            upsert_price_history_daily(
                self.connection,
                card_id="base1-4",
                pricing_mode=RAW_PRICING_MODE,
                provider="scrydex",
                price_date=_iso_date(index),
                currency_code="USD",
                variant="Holofoil",
                condition="NM",
                low_price=14.5,
                market_price=15.0 + index * 0.5,
                mid_price=15.0,
                high_price=15.5,
                payload={"provider": "scrydex", "variantKey": "holofoil"},
            )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            payload = service.card_market_history("base1-4", days=30)
        finally:
            service.connection.close()

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["volumeLevel"], "unknown")
        available_ids = [str(option.get("id") or "").upper() for option in payload["availableConditions"]]
        self.assertTrue(set(available_ids).issubset({"NM"}))


if __name__ == "__main__":
    unittest.main()
