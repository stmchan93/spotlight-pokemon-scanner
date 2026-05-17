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


class QuickSaleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "quick-sale.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _identity(self, user_id: str = "vendor-a") -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(self, card_id: str = "base-charizard-4", name: str = "Charizard") -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
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

    def test_record_quick_sale_raw_creates_sale_event_and_zero_quantity_entry(self) -> None:
        self._insert_card()
        with self.service.request_identity_context(self._identity()):
            result = self.service.record_quick_sale(
                {
                    "cardID": "base-charizard-4",
                    "unitPrice": 250.0,
                    "currencyCode": "USD",
                    "condition": "near_mint",
                    "paymentMethod": "cash",
                }
            )

        self.assertTrue(result["quickSale"])
        self.assertEqual(result["remainingQuantity"], 0)
        self.assertEqual(result["grossTotal"], 250.0)

        sale_row = self.service.connection.execute(
            "SELECT card_id, quantity, unit_price, total_price, payment_method, sale_source FROM sale_events"
        ).fetchone()
        self.assertEqual(sale_row["card_id"], "base-charizard-4")
        self.assertEqual(sale_row["quantity"], 1)
        self.assertEqual(sale_row["unit_price"], 250.0)
        self.assertEqual(sale_row["total_price"], 250.0)
        self.assertEqual(sale_row["payment_method"], "cash")
        self.assertEqual(sale_row["sale_source"], "quick")

        deck_row = self.service.connection.execute(
            "SELECT quantity FROM deck_entries WHERE card_id = ?",
            ("base-charizard-4",),
        ).fetchone()
        self.assertEqual(deck_row["quantity"], 0)

    def test_record_quick_sale_slab_populates_slab_fields(self) -> None:
        self._insert_card()
        with self.service.request_identity_context(self._identity()):
            result = self.service.record_quick_sale(
                {
                    "cardID": "base-charizard-4",
                    "unitPrice": 1200.0,
                    "currencyCode": "USD",
                    "slabContext": {
                        "grader": "PSA",
                        "grade": "10",
                        "certNumber": "12345678",
                        "variantName": None,
                    },
                }
            )

        self.assertTrue(result["quickSale"])
        deck_row = self.service.connection.execute(
            "SELECT grader, grade, cert_number, item_kind, quantity FROM deck_entries WHERE card_id = ?",
            ("base-charizard-4",),
        ).fetchone()
        self.assertEqual(deck_row["grader"], "PSA")
        self.assertEqual(deck_row["grade"], "10")
        self.assertEqual(deck_row["cert_number"], "12345678")
        self.assertEqual(deck_row["item_kind"], "slab")
        self.assertEqual(deck_row["quantity"], 0)

    def test_record_quick_sale_card_not_found_raises(self) -> None:
        with self.service.request_identity_context(self._identity()):
            with self.assertRaises(FileNotFoundError):
                self.service.record_quick_sale(
                    {"cardID": "does-not-exist", "unitPrice": 10.0}
                )

    def test_record_quick_sale_negative_unit_price_raises(self) -> None:
        self._insert_card()
        with self.service.request_identity_context(self._identity()):
            with self.assertRaises(ValueError):
                self.service.record_quick_sale(
                    {"cardID": "base-charizard-4", "unitPrice": -1.0}
                )

    def test_record_quick_sale_missing_unit_price_raises(self) -> None:
        self._insert_card()
        with self.service.request_identity_context(self._identity()):
            with self.assertRaises(ValueError):
                self.service.record_quick_sale({"cardID": "base-charizard-4"})

    def test_record_quick_sale_blocks_when_deck_entry_already_exists(self) -> None:
        self._insert_card()
        with self.service.request_identity_context(self._identity()):
            upsert_deck_entry(
                self.service.connection,
                owner_user_id="vendor-a",
                card_id="base-charizard-4",
                condition="near_mint",
                quantity=1,
                unit_price=50.0,
            )
            self.service.connection.commit()
            with self.assertRaises(ValueError):
                self.service.record_quick_sale(
                    {
                        "cardID": "base-charizard-4",
                        "unitPrice": 100.0,
                        "condition": "near_mint",
                    }
                )

    def test_record_quick_sale_scoped_per_user(self) -> None:
        self._insert_card()
        with self.service.request_identity_context(self._identity("vendor-a")):
            self.service.record_quick_sale(
                {"cardID": "base-charizard-4", "unitPrice": 100.0}
            )
        with self.service.request_identity_context(self._identity("vendor-b")):
            result = self.service.record_quick_sale(
                {"cardID": "base-charizard-4", "unitPrice": 200.0}
            )
        self.assertTrue(result["quickSale"])
        rows = self.service.connection.execute(
            "SELECT owner_user_id, total_price FROM sale_events ORDER BY total_price"
        ).fetchall()
        self.assertEqual([row["owner_user_id"] for row in rows], ["vendor-a", "vendor-b"])


if __name__ == "__main__":
    unittest.main()
