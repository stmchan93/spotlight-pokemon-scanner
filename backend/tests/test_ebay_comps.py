from __future__ import annotations

import os
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

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from ebay_comps import build_psa_grade_options, fetch_graded_card_ebay_comps  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402


class EbayCompsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "ebay-comps.sqlite"
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
        self._token_cache_was_reset = False

    def _reset_token_cache(self) -> None:
        from ebay_comps import _reset_ebay_token_cache  # noqa: E402

        _reset_ebay_token_cache()
        self._token_cache_was_reset = True

    def tearDown(self) -> None:
        if not self._token_cache_was_reset:
            try:
                from ebay_comps import _reset_ebay_token_cache  # noqa: E402

                _reset_ebay_token_cache()
            except Exception:
                pass
        self.tempdir.cleanup()

    def test_build_psa_grade_options_keeps_standard_tabs_in_order(self) -> None:
        options = build_psa_grade_options("9", available_grades=["7", "9.5", "8.5"])

        self.assertEqual([option["id"] for option in options[:4]], ["10", "9", "8.5", "8"])
        self.assertTrue(options[1]["selected"])
        self.assertIn("7", [option["id"] for option in options])
        self.assertIn("9.5", [option["id"] for option in options])

    def test_fetch_graded_card_ebay_comps_parses_live_listings(self) -> None:
        self._reset_token_cache()

        token_response = {
            "access_token": "token-value",
            "expires_in": 7200,
        }
        browse_response = {
            "itemSummaries": [
                {
                    "itemId": "v1|123|0",
                    "title": "PSA 9 Sabrina's Slowbro Gym Heroes 60/132",
                    "price": {"value": "123.45", "currency": "USD"},
                    "itemWebUrl": "https://www.ebay.com/itm/123456789012",
                    "buyingOptions": ["AUCTION"],
                    "itemCreationDate": "2026-04-12T07:14:44.000Z",
                },
                {
                    "itemId": "v1|124|0",
                    "title": "PSA 9 Sabrina's Slowbro Gym Heroes 60/132",
                    "price": {"value": "130.00", "currency": "USD"},
                    "itemWebUrl": "https://www.ebay.com/itm/123456789013",
                    "buyingOptions": ["FIXED_PRICE"],
                    "itemCreationDate": "2026-04-11T07:14:44.000Z",
                },
            ]
        }

        def fake_request_json(url: str, **kwargs: object) -> dict[str, object]:
            if "identity/v1/oauth2/token" in url:
                self.assertEqual(kwargs.get("method"), "POST")
                return token_response
            if "buy/browse/v1/item_summary/search" in url:
                headers = kwargs.get("headers") or {}
                self.assertIn("Authorization", headers)
                self.assertEqual(str(headers.get("X-EBAY-C-MARKETPLACE-ID")), "EBAY_US")
                self.assertIn("q=", url)
                return browse_response
            raise AssertionError(f"Unexpected URL: {url}")

        with unittest.mock.patch.dict(
            os.environ,
            {
                "SPOTLIGHT_EBAY_BROWSE_ENABLED": "1",
                "EBAY_CLIENT_ID": "client-id",
                "EBAY_CLIENT_SECRET": "client-secret",
                "EBAY_MARKETPLACE_ID": "EBAY_US",
            },
            clear=False,
        ):
            payload = fetch_graded_card_ebay_comps(
                {
                    "id": "gym1-60",
                    "name": "Sabrina's Slowbro",
                    "setName": "Gym Heroes",
                    "number": "60/132",
                },
                grader="PSA",
                selected_grade="9",
                fetch_json=fake_request_json,
            )

        self.assertEqual(payload["status"], "available")
        self.assertEqual(payload["grader"], "PSA")
        self.assertEqual(payload["selectedGrade"], "9")
        self.assertEqual([option["id"] for option in payload["availableGradeOptions"][:4]], ["10", "9", "8.5", "8"])
        self.assertEqual(payload["transactionCount"], 2)
        self.assertIn("_nkw=", payload["searchURL"])
        self.assertNotIn("LH_Sold=1", payload["searchURL"])

        first, second = payload["transactions"]
        self.assertTrue(first["id"].startswith("ebay:"))
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(first["title"], "PSA 9 Sabrina's Slowbro Gym Heroes 60/132")
        self.assertEqual(first["saleType"], "auction")
        self.assertEqual(first["soldAt"], "2026-04-12")
        self.assertEqual(first["price"]["amount"], 123.45)
        self.assertEqual(first["price"]["currencyCode"], "USD")
        self.assertEqual(second["saleType"], "fixed_price")
        self.assertEqual(second["soldAt"], "2026-04-11")
        self.assertEqual(second["price"]["amount"], 130.0)

    def test_fetch_graded_card_ebay_comps_returns_unavailable_when_disabled(self) -> None:
        self._reset_token_cache()
        payload = fetch_graded_card_ebay_comps(
            {
                "id": "gym1-60",
                "name": "Sabrina's Slowbro",
                "setName": "Gym Heroes",
                "number": "60/132",
            },
            grader="PSA",
            selected_grade="9",
        )

        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["statusReason"], "browse_disabled")
        self.assertIn("_nkw=", payload["searchURL"])
        self.assertNotIn("LH_Sold=1", payload["searchURL"])
        self.assertEqual(payload["transactions"], [])
        self.assertIsNone(payload.get("error"))

    def test_service_card_ebay_comps_wraps_helper(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            with patch("server.fetch_graded_card_ebay_comps", return_value={"status": "available"}) as mocked:
                payload = service.card_ebay_comps("gym1-60", grader="psa", grade="9", limit=12)
            self.assertEqual(payload, {"status": "available"})
            mocked.assert_called_once()
            _, kwargs = mocked.call_args
            self.assertEqual(kwargs["grader"], "PSA")
            self.assertEqual(kwargs["selected_grade"], "9")
            self.assertEqual(kwargs["limit"], 12)
        finally:
            service.connection.close()

    def test_ebay_comps_route_dispatches_to_service(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/cards/gym1-60/ebay-comps?grade=9&limit=5"
        handler.service = Mock()
        handler.service.card_ebay_comps.return_value = {"status": "available"}
        captured: dict[str, object] = {}

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._write_json = write_json  # type: ignore[method-assign]

        handler.do_GET()

        handler.service.card_ebay_comps.assert_called_once_with("gym1-60", grader="PSA", grade="9", limit=5)
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["payload"], {"status": "available"})


if __name__ == "__main__":
    unittest.main()
