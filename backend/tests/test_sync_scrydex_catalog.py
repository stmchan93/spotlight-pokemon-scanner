from __future__ import annotations

import socket
import sys
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from urllib.error import HTTPError, URLError

from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import sqlite3

import sync_scrydex_catalog
from sync_scrydex_catalog import (
    _fetch_scrydex_cards_page_with_retries,
    _is_transient_scrydex_catalog_error,
    _parse_retry_after_seconds,
    _refresh_fx_rates_for_catalog,
    _retry_after_from_error,
    _scrydex_catalog_page_retry_delay_seconds,
)


class RefreshFxRatesForCatalogTests(unittest.TestCase):
    def _connection_with_currencies(self, codes: list[str]) -> sqlite3.Connection:
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.execute(
            "CREATE TABLE card_price_snapshots (card_id TEXT PRIMARY KEY, display_currency_code TEXT NOT NULL)"
        )
        for index, code in enumerate(codes):
            connection.execute(
                "INSERT INTO card_price_snapshots (card_id, display_currency_code) VALUES (?, ?)",
                (f"card-{index}", code),
            )
        connection.commit()
        return connection

    def test_refreshes_only_non_usd_currencies(self) -> None:
        connection = self._connection_with_currencies(["USD", "JPY", "jpy", "EUR"])
        fresh = {"isFresh": True}
        with patch.object(sync_scrydex_catalog, "ensure_fx_rate_snapshot", return_value=fresh) as mock_ensure:
            summary = _refresh_fx_rates_for_catalog(connection)

        # USD is skipped; JPY/jpy collapse to one; EUR refreshed. Each fetch is allowed.
        self.assertEqual(summary["currencies"], ["EUR", "JPY"])
        self.assertEqual(summary["refreshed"], 2)
        self.assertEqual(summary["failed"], 0)
        called_currencies = sorted(call.kwargs["base_currency"] for call in mock_ensure.call_args_list)
        self.assertEqual(called_currencies, ["EUR", "JPY"])
        for call in mock_ensure.call_args_list:
            self.assertEqual(call.kwargs["allow_fetch"], True)

    def test_never_raises_when_a_currency_fetch_fails(self) -> None:
        connection = self._connection_with_currencies(["JPY"])
        with patch.object(sync_scrydex_catalog, "ensure_fx_rate_snapshot", side_effect=RuntimeError("ecb down")):
            summary = _refresh_fx_rates_for_catalog(connection)
        self.assertEqual(summary["failed"], 1)
        self.assertEqual(summary["refreshed"], 0)


class SyncScrydexCatalogHelperTests(unittest.TestCase):
    def test_parse_retry_after_seconds_supports_numeric_and_http_date_values(self) -> None:
        self.assertEqual(_parse_retry_after_seconds("12"), 12.0)
        self.assertEqual(_parse_retry_after_seconds(""), None)
        self.assertEqual(_parse_retry_after_seconds("not-a-date"), None)

        future = datetime.now(timezone.utc) + timedelta(seconds=45)
        parsed = _parse_retry_after_seconds(format_datetime(future))
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertGreaterEqual(parsed, 40.0)

    def test_retry_after_from_error_reads_http_header(self) -> None:
        error = HTTPError(
            url="https://scrydex.example/cards",
            code=429,
            msg="Too Many Requests",
            hdrs={"Retry-After": "7"},
            fp=None,
        )

        self.assertEqual(_retry_after_from_error(error), 7.0)
        self.assertIsNone(_retry_after_from_error(RuntimeError("boom")))

    def test_transient_error_detection_matches_retryable_network_failures(self) -> None:
        self.assertTrue(_is_transient_scrydex_catalog_error(HTTPError(
            url="https://scrydex.example/cards",
            code=503,
            msg="Service Unavailable",
            hdrs={},
            fp=None,
        )))
        self.assertFalse(_is_transient_scrydex_catalog_error(HTTPError(
            url="https://scrydex.example/cards",
            code=404,
            msg="Not Found",
            hdrs={},
            fp=None,
        )))
        self.assertTrue(_is_transient_scrydex_catalog_error(TimeoutError("timed out")))
        self.assertTrue(_is_transient_scrydex_catalog_error(socket.timeout("timed out")))
        self.assertTrue(_is_transient_scrydex_catalog_error(URLError(socket.timeout("timed out"))))
        self.assertFalse(_is_transient_scrydex_catalog_error(URLError("certificate verify failed")))

    def test_retry_delay_prefers_retry_after_and_otherwise_uses_exponential_backoff(self) -> None:
        retry_after_error = HTTPError(
            url="https://scrydex.example/cards",
            code=429,
            msg="Too Many Requests",
            hdrs={"Retry-After": "9"},
            fp=None,
        )
        self.assertEqual(_scrydex_catalog_page_retry_delay_seconds(3, retry_after_error), 9.0)

        with patch("sync_scrydex_catalog.random.uniform", return_value=0.5):
            self.assertEqual(
                _scrydex_catalog_page_retry_delay_seconds(2, TimeoutError("timed out")),
                4.5,
            )

    def test_fetch_page_with_retries_retries_transient_failures_and_stops_on_non_retryable_errors(self) -> None:
        with patch(
            "sync_scrydex_catalog.fetch_scrydex_cards_page",
            side_effect=[TimeoutError("timed out"), [{"id": "base1-4"}]],
        ) as fetch_page, patch("sync_scrydex_catalog.random.uniform", return_value=0.0), patch(
            "sync_scrydex_catalog.time.sleep"
        ) as sleep:
            payload = _fetch_scrydex_cards_page_with_retries(
                page=2,
                page_size=100,
                include_prices=True,
                language="en",
                request_type="catalog_sync_en",
            )

        self.assertEqual(payload, [{"id": "base1-4"}])
        self.assertEqual(fetch_page.call_count, 2)
        sleep.assert_called_once_with(2.0)

        with patch(
            "sync_scrydex_catalog.fetch_scrydex_cards_page",
            side_effect=HTTPError(
                url="https://scrydex.example/cards",
                code=404,
                msg="Not Found",
                hdrs={},
                fp=None,
            ),
        ) as fetch_page, patch("sync_scrydex_catalog.time.sleep") as sleep:
            with self.assertRaises(HTTPError):
                _fetch_scrydex_cards_page_with_retries(
                    page=1,
                    page_size=100,
                    include_prices=True,
                    language=None,
                    request_type="catalog_sync_all",
                )

        self.assertEqual(fetch_page.call_count, 1)
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
