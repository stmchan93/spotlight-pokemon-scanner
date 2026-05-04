from __future__ import annotations

import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock, patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, replace_slab_recent_sales_cache, upsert_card  # noqa: E402
from scrydex_adapter import fetch_scrydex_recent_sales  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402


class CardRecentSalesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "card-recent-sales.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            connection,
            card_id="gym1-60",
            name="Sabrina's Slowbro",
            set_name="Gym Heroes",
            number="60/132",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="gym1-60",
            set_id="gym1",
            set_series="Gym",
            supertype="Pokemon",
        )
        connection.commit()
        connection.close()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_fetch_scrydex_recent_sales_parses_listing_rows(self) -> None:
        with patch(
            "scrydex_adapter.scrydex_api_request",
            return_value={
                "data": [
                    {
                        "id": "sale-1",
                        "title": "PSA 9 Sabrina's Slowbro Gym Heroes 60/132",
                        "sold_at": "2026-05-01T12:00:00Z",
                        "price": {"amount": 123.45, "currencyCode": "USD"},
                        "url": "https://www.ebay.com/itm/123",
                    },
                ],
            },
        ) as mocked:
            payload = fetch_scrydex_recent_sales("gym1-60", grader="PSA", grade="9", limit=5)

        mocked.assert_called_once()
        self.assertEqual(payload["cardID"], "gym1-60")
        self.assertEqual(payload["grader"], "PSA")
        self.assertEqual(payload["grade"], "9")
        self.assertEqual(payload["source"], "ebay")
        self.assertEqual(len(payload["sales"]), 1)
        self.assertEqual(payload["sales"][0]["title"], "PSA 9 Sabrina's Slowbro Gym Heroes 60/132")
        self.assertEqual(payload["sales"][0]["price"], 123.45)
        self.assertEqual(payload["sales"][0]["currencyCode"], "USD")
        self.assertEqual(payload["sales"][0]["listingURL"], "https://www.ebay.com/itm/123")

    def test_service_card_recent_sales_returns_not_loaded_without_refresh(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            payload = service.card_recent_sales("gym1-60", grader="PSA", grade="9", source="ebay", limit=5)
        finally:
            service.connection.close()

        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["statusReason"], "not_loaded")
        self.assertEqual(payload["saleCount"], 0)
        self.assertFalse(payload["canRefresh"])

    def test_service_card_recent_sales_refreshes_and_caches_rows(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            with patch(
                "server.fetch_scrydex_recent_sales",
                return_value={
                    "cardID": "gym1-60",
                    "grader": "PSA",
                    "grade": "9",
                    "source": "ebay",
                    "sourceURL": "https://api.scrydex.com/pokemon/v1/cards/gym1-60/listings?source=ebay&company=PSA&grade=9&page_size=5",
                    "sourcePayload": {"data": []},
                    "sales": [
                        {
                            "sourceSaleID": "sale-1",
                            "rank": 1,
                            "title": "PSA 9 Sabrina's Slowbro Gym Heroes 60/132",
                            "soldAt": "2026-05-01T12:00:00Z",
                            "price": 123.45,
                            "currencyCode": "USD",
                            "listingURL": "https://www.ebay.com/itm/123",
                            "sourcePayload": {"id": "sale-1"},
                        },
                    ],
                },
            ) as mocked:
                payload = service.card_recent_sales(
                    "gym1-60",
                    grader="PSA",
                    grade="9",
                    source="ebay",
                    limit=5,
                    refresh=True,
                )
                cached = service.card_recent_sales("gym1-60", grader="PSA", grade="9", source="ebay", limit=5)
        finally:
            service.connection.close()

        mocked.assert_called_once()
        self.assertEqual(payload["status"], "available")
        self.assertEqual(payload["saleCount"], 1)
        self.assertEqual(payload["sales"][0]["title"], "PSA 9 Sabrina's Slowbro Gym Heroes 60/132")
        self.assertEqual(cached["status"], "available")
        self.assertEqual(cached["saleCount"], 1)
        self.assertFalse(cached["canRefresh"])

    def test_service_card_recent_sales_returns_cached_no_results(self) -> None:
        connection = connect(self.database_path)
        replace_slab_recent_sales_cache(
            connection,
            card_id="gym1-60",
            grader="PSA",
            grade="9",
            source="ebay",
            sales=[],
            fetched_at="2026-05-01T12:00:00+00:00",
            source_url="https://api.scrydex.com/pokemon/v1/cards/gym1-60/listings?source=ebay",
            source_payload={"data": []},
        )
        connection.commit()
        connection.close()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            payload = service.card_recent_sales("gym1-60", grader="PSA", grade="9", source="ebay", limit=5)
        finally:
            service.connection.close()

        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["statusReason"], "no_results")
        self.assertEqual(payload["saleCount"], 0)
        self.assertEqual(payload["unavailableReason"], "No recent sold sales were returned for this slab.")

    def test_recent_sales_route_dispatches_to_service(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/cards/gym1-60/recent-sales?grader=PSA&grade=9&source=ebay&limit=5&refresh=1"
        handler.service = Mock()
        handler.service.card_recent_sales.return_value = {"status": "available", "saleCount": 1, "sales": []}
        captured: dict[str, object] = {}

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._write_json = write_json  # type: ignore[method-assign]

        handler.do_GET()

        handler.service.card_recent_sales.assert_called_once_with(
            "gym1-60",
            grader="PSA",
            grade="9",
            source="ebay",
            limit=5,
            refresh=True,
        )
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["payload"], {"status": "available", "saleCount": 1, "sales": []})


if __name__ == "__main__":
    unittest.main()
