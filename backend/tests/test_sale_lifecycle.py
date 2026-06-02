from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, upsert_deck_entry  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class SaleLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "sale-lifecycle.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _identity(self, user_id: str = "vendor-a") -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(self, card_id: str = "base-charizard-4") -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name="Charizard",
            set_name="Base Set",
            number="4/102",
            rarity="Holo Rare",
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

    def _seed_deck_entry(self, *, user_id: str = "vendor-a", quantity: int = 2) -> str:
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id=user_id,
            card_id="base-charizard-4",
            condition="near_mint",
            quantity=quantity,
            unit_price=50.0,
            currency_code="USD",
        )
        self.service.connection.commit()
        return deck_entry_id

    def test_sale_is_paid_immediately_and_decrements_deck(self) -> None:
        self._insert_card()
        deck_entry_id = self._seed_deck_entry()
        with self.service.request_identity_context(self._identity()):
            result = self.service.record_sale(
                {
                    "deckEntryID": deck_entry_id,
                    "unitPrice": 100.0,
                    "currencyCode": "USD",
                    "paymentMethod": "cash",
                }
            )
        self.assertEqual(result["status"], "paid")
        self.assertEqual(result["remainingQuantity"], 1)
        self.assertIsNotNone(result["paidAt"])
        self.assertEqual(result["paidAt"], result["soldAt"])

        sale_row = self.service.connection.execute(
            "SELECT paid_at, voided_at FROM sale_events WHERE id = ?",
            (result["saleID"],),
        ).fetchone()
        self.assertIsNotNone(sale_row["paid_at"])
        self.assertIsNone(sale_row["voided_at"])

    def test_sale_paid_immediately_regardless_of_payment_method(self) -> None:
        # Payment deferral (venmo/cashapp/paypal/zelle -> pending) was removed.
        # Every recorded sale is paid immediately and decrements the deck.
        self._insert_card()
        deck_entry_id = self._seed_deck_entry()
        with self.service.request_identity_context(self._identity()):
            result = self.service.record_sale(
                {
                    "deckEntryID": deck_entry_id,
                    "unitPrice": 75.0,
                    "currencyCode": "USD",
                    "paymentMethod": "venmo",
                }
            )
        self.assertEqual(result["status"], "paid")
        self.assertIsNotNone(result["paidAt"])
        self.assertEqual(result["remainingQuantity"], 1)

        sale_row = self.service.connection.execute(
            "SELECT paid_at FROM sale_events WHERE id = ?",
            (result["saleID"],),
        ).fetchone()
        self.assertIsNotNone(sale_row["paid_at"])


if __name__ == "__main__":
    unittest.main()
