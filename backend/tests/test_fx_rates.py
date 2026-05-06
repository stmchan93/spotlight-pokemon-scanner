from __future__ import annotations

import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest import mock


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import fx_rates  # noqa: E402


class FxRatesTests(unittest.TestCase):
    def test_ecb_request_url_sorts_currencies_and_excludes_eur(self) -> None:
        url = fx_rates._ecb_request_url(currencies=["usd", "EUR", "jpy", "usd"])

        self.assertIn("/D.JPY+USD.EUR.SP00.A?", url)
        self.assertIn("lastNObservations=1", url)
        self.assertIn("format=jsondata", url)

    def test_extract_ecb_reference_rates_reads_series_dimensions(self) -> None:
        payload = {
            "structure": {
                "dimensions": {
                    "series": [
                        {
                            "id": "CURRENCY",
                            "values": [{"id": "USD"}, {"id": "JPY"}],
                        }
                    ],
                    "observation": [
                        {
                            "id": "TIME_PERIOD",
                            "values": [{"id": "2026-05-05"}],
                        }
                    ],
                }
            },
            "dataSets": [
                {
                    "series": {
                        "0": {"observations": {"0": [1.12]}},
                        "1": {"observations": {"0": [163.45]}},
                    }
                }
            ],
        }

        rates, effective_at = fx_rates._extract_ecb_reference_rates(payload)

        self.assertEqual(effective_at, "2026-05-05")
        self.assertEqual(rates["EUR"], Decimal("1"))
        self.assertEqual(rates["USD"], Decimal("1.12"))
        self.assertEqual(rates["JPY"], Decimal("163.45"))

    def test_extract_ecb_reference_rates_rejects_missing_sections(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing required sections"):
            fx_rates._extract_ecb_reference_rates({})

    def test_fetch_ecb_cross_rate_returns_identity_for_same_currency(self) -> None:
        result = fx_rates.fetch_ecb_cross_rate("usd", "USD")

        self.assertEqual(result.base_currency, "USD")
        self.assertEqual(result.quote_currency, "USD")
        self.assertEqual(result.rate, Decimal("1"))
        self.assertEqual(result.payload, {"identity": True})

    @mock.patch.object(fx_rates, "_ecb_api_request")
    def test_fetch_ecb_cross_rate_computes_cross_rate_from_eur_reference(self, mock_request: mock.Mock) -> None:
        mock_request.return_value = {
            "structure": {
                "dimensions": {
                    "series": [
                        {
                            "id": "CURRENCY",
                            "values": [{"id": "USD"}, {"id": "JPY"}],
                        }
                    ],
                    "observation": [
                        {
                            "id": "TIME_PERIOD",
                            "values": [{"id": "2026-05-05"}],
                        }
                    ],
                }
            },
            "dataSets": [
                {
                    "series": {
                        "0": {"observations": {"0": [1.25]}},
                        "1": {"observations": {"0": [150.0]}},
                    }
                }
            ],
        }

        result = fx_rates.fetch_ecb_cross_rate("USD", "JPY")

        self.assertEqual(result.base_currency, "USD")
        self.assertEqual(result.quote_currency, "JPY")
        self.assertEqual(result.effective_at, "2026-05-05")
        self.assertEqual(result.rate, Decimal("120.0000000000"))
        self.assertIn("JPY+USD", result.source_url)

    @mock.patch.object(fx_rates, "fx_rate_snapshot_for_pair")
    def test_ensure_fx_rate_snapshot_returns_fresh_snapshot_without_fetch(
        self,
        mock_snapshot_for_pair: mock.Mock,
    ) -> None:
        snapshot = {"baseCurrency": "EUR", "quoteCurrency": "USD", "isFresh": True}
        mock_snapshot_for_pair.return_value = snapshot

        connection = mock.Mock()
        result = fx_rates.ensure_fx_rate_snapshot(
            connection,
            base_currency="eur",
            quote_currency="usd",
        )

        self.assertIs(result, snapshot)
        connection.commit.assert_not_called()

    @mock.patch.object(fx_rates, "upsert_fx_rate_snapshot")
    @mock.patch.object(fx_rates, "fetch_ecb_cross_rate")
    @mock.patch.object(fx_rates, "fx_rate_snapshot_for_pair")
    def test_ensure_fx_rate_snapshot_refreshes_stale_snapshot_and_commits(
        self,
        mock_snapshot_for_pair: mock.Mock,
        mock_fetch: mock.Mock,
        mock_upsert: mock.Mock,
    ) -> None:
        stale_snapshot = {"baseCurrency": "EUR", "quoteCurrency": "USD", "isFresh": False}
        refreshed_snapshot = {
            "baseCurrency": "EUR",
            "quoteCurrency": "USD",
            "rate": 1.12,
            "isFresh": True,
            "refreshedAt": "2026-05-05T12:00:00Z",
        }
        mock_snapshot_for_pair.side_effect = [stale_snapshot, refreshed_snapshot]
        mock_fetch.return_value = fx_rates.FxRateResult(
            base_currency="EUR",
            quote_currency="USD",
            rate=Decimal("1.12"),
            source=fx_rates.ECB_FX_SOURCE,
            effective_at="2026-05-05",
            source_url="https://example.test/fx",
            payload={"rates": True},
        )

        connection = mock.Mock()
        result = fx_rates.ensure_fx_rate_snapshot(
            connection,
            base_currency="eur",
            quote_currency="usd",
        )

        self.assertEqual(result, refreshed_snapshot)
        mock_fetch.assert_called_once_with("EUR", "USD")
        mock_upsert.assert_called_once_with(
            connection,
            base_currency="EUR",
            quote_currency="USD",
            rate=1.12,
            source=fx_rates.ECB_FX_SOURCE,
            effective_at="2026-05-05",
            source_url="https://example.test/fx",
            payload={"rates": True},
        )
        connection.commit.assert_called_once_with()

    @mock.patch.object(fx_rates, "fetch_ecb_cross_rate", side_effect=RuntimeError("network down"))
    @mock.patch.object(fx_rates, "fx_rate_snapshot_for_pair")
    def test_ensure_fx_rate_snapshot_returns_stale_snapshot_when_refresh_fails(
        self,
        mock_snapshot_for_pair: mock.Mock,
        _mock_fetch: mock.Mock,
    ) -> None:
        stale_snapshot = {"baseCurrency": "EUR", "quoteCurrency": "USD", "isFresh": False}
        mock_snapshot_for_pair.return_value = stale_snapshot

        connection = mock.Mock()
        result = fx_rates.ensure_fx_rate_snapshot(
            connection,
            base_currency="eur",
            quote_currency="usd",
        )

        self.assertIs(result, stale_snapshot)
        connection.commit.assert_not_called()

    def test_convert_price_rounds_half_up_to_cents(self) -> None:
        self.assertEqual(
            fx_rates.convert_price(12.345, rate=Decimal("1.2345")),
            15.24,
        )
        self.assertIsNone(fx_rates.convert_price(None, rate=Decimal("1.1")))

    @mock.patch.object(fx_rates, "ensure_fx_rate_snapshot")
    def test_decorate_pricing_summary_with_fx_converts_non_usd_raw_prices(
        self,
        mock_ensure_fx_rate_snapshot: mock.Mock,
    ) -> None:
        mock_ensure_fx_rate_snapshot.return_value = {
            "baseCurrency": "EUR",
            "quoteCurrency": "USD",
            "rate": 1.1,
            "source": "ecb",
            "effectiveAt": "2026-05-05",
            "refreshedAt": "2026-05-05T12:00:00Z",
            "isFresh": True,
        }
        pricing = {
            "currencyCode": "EUR",
            "pricingMode": "raw",
            "low": 10.0,
            "market": 12.0,
            "mid": 11.5,
            "high": 13.5,
            "directLow": 9.5,
            "trend": 12.2,
        }

        converted = fx_rates.decorate_pricing_summary_with_fx(mock.Mock(), pricing)

        self.assertEqual(converted["currencyCode"], "USD")
        self.assertEqual(converted["nativeCurrencyCode"], "EUR")
        self.assertEqual(converted["nativeLow"], 10.0)
        self.assertEqual(converted["market"], 13.2)
        self.assertEqual(converted["mid"], 12.65)
        self.assertEqual(converted["high"], 14.85)
        self.assertEqual(converted["directLow"], 10.45)
        self.assertEqual(converted["trend"], 13.42)
        self.assertTrue(converted["displayIsConverted"])
        self.assertEqual(converted["fxSource"], "ecb")

    def test_decorate_pricing_summary_with_fx_leaves_non_raw_or_usd_payloads_unchanged(self) -> None:
        pricing = {"currencyCode": "USD", "pricingMode": "raw", "market": 12.0}
        self.assertIs(fx_rates.decorate_pricing_summary_with_fx(mock.Mock(), pricing), pricing)

        graded = {"currencyCode": "EUR", "pricingMode": "psa_grade_estimate", "market": 12.0}
        self.assertIs(fx_rates.decorate_pricing_summary_with_fx(mock.Mock(), graded), graded)


if __name__ == "__main__":
    unittest.main()
