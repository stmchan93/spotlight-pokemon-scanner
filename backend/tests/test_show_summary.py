from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class VendorShowSummaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "show-summary.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _identity(self, user_id: str = "vendor-a") -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(self, card_id: str, name: str, set_name: str = "Base Set") -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name=set_name,
            number="1/1",
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            set_id="base1",
            set_ptcgo_code="BS",
            set_release_date="1999-01-09",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def _quick_sale(
        self,
        *,
        card_id: str,
        unit_price: float,
        payment_method: str | None = None,
        sold_at: str | None = None,
    ) -> None:
        with self.service.request_identity_context(self._identity()):
            self.service.record_quick_sale(
                {
                    "cardID": card_id,
                    "unitPrice": unit_price,
                    "currencyCode": "USD",
                    "paymentMethod": payment_method,
                    "soldAt": sold_at,
                }
            )

    def test_empty_range_returns_zeros(self) -> None:
        with self.service.request_identity_context(self._identity()):
            summary = self.service.vendor_show_summary()
        self.assertEqual(summary["totalSales"], 0)
        self.assertEqual(summary["totalRevenue"], 0.0)
        self.assertIsNone(summary["currencyCode"])
        self.assertEqual(summary["byPaymentMethod"], [])
        self.assertEqual(summary["topCards"], [])

    def test_summary_totals_and_payment_method_breakdown(self) -> None:
        self._insert_card("c-1", "Pikachu")
        self._insert_card("c-2", "Charmander")
        self._insert_card("c-3", "Bulbasaur")
        now = datetime.now(timezone.utc).isoformat()
        self._quick_sale(card_id="c-1", unit_price=100.0, payment_method="venmo", sold_at=now)
        self._quick_sale(card_id="c-2", unit_price=50.0, payment_method="cash", sold_at=now)
        self._quick_sale(card_id="c-3", unit_price=25.0, payment_method=None, sold_at=now)

        with self.service.request_identity_context(self._identity()):
            summary = self.service.vendor_show_summary()

        self.assertEqual(summary["totalSales"], 3)
        self.assertEqual(summary["totalRevenue"], 175.0)
        self.assertEqual(summary["currencyCode"], "USD")

        by_method = {bucket["paymentMethod"]: bucket for bucket in summary["byPaymentMethod"]}
        self.assertEqual(by_method["venmo"]["count"], 1)
        self.assertEqual(by_method["venmo"]["revenue"], 100.0)
        self.assertEqual(by_method["cash"]["revenue"], 50.0)
        self.assertEqual(by_method[None]["revenue"], 25.0)

    def test_top_cards_limited_and_sorted_by_revenue_desc(self) -> None:
        for idx in range(5):
            self._insert_card(f"card-{idx}", f"Card {idx}")
        now = datetime.now(timezone.utc).isoformat()
        for idx, price in enumerate([10.0, 50.0, 200.0, 75.0, 30.0]):
            self._quick_sale(card_id=f"card-{idx}", unit_price=price, sold_at=now)

        with self.service.request_identity_context(self._identity()):
            summary = self.service.vendor_show_summary()

        self.assertEqual(len(summary["topCards"]), 3)
        self.assertEqual(
            [card["cardID"] for card in summary["topCards"]],
            ["card-2", "card-3", "card-1"],
        )
        self.assertEqual(summary["topCards"][0]["totalPrice"], 200.0)

    def test_summary_date_range_excludes_out_of_range_sales(self) -> None:
        self._insert_card("c-1", "Pikachu")
        far_past = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        recent = datetime.now(timezone.utc).isoformat()
        self._quick_sale(card_id="c-1", unit_price=100.0, sold_at=far_past)
        # The old sale lives at qty=0 — second quick sale would collide. Use a second card instead.
        self._insert_card("c-2", "Charmander")
        self._quick_sale(card_id="c-2", unit_price=42.0, sold_at=recent)

        since = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        until = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        with self.service.request_identity_context(self._identity()):
            summary = self.service.vendor_show_summary(since=since, until=until)

        self.assertEqual(summary["totalSales"], 1)
        self.assertEqual(summary["totalRevenue"], 42.0)


if __name__ == "__main__":
    unittest.main()
