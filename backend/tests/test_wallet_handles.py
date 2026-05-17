from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class WalletHandlesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "wallet-handles.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _identity(self, user_id: str = "vendor-a") -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def test_get_when_no_row_returns_all_null_fields(self) -> None:
        with self.service.request_identity_context(self._identity()):
            payload = self.service.vendor_wallet_handles()
        self.assertEqual(
            payload,
            {
                "venmoHandle": None,
                "cashappHandle": None,
                "paypalMeSlug": None,
                "zelleEmailOrPhone": None,
                "updatedAt": None,
            },
        )

    def test_put_new_record_returns_and_persists(self) -> None:
        with self.service.request_identity_context(self._identity()):
            payload = self.service.update_vendor_wallet_handles(
                {
                    "venmoHandle": "stephen-chan",
                    "cashappHandle": "$stephenchan",
                    "paypalMeSlug": "stephenchan",
                    "zelleEmailOrPhone": "you@email.com",
                }
            )
        self.assertEqual(payload["venmoHandle"], "stephen-chan")
        self.assertEqual(payload["cashappHandle"], "$stephenchan")
        self.assertEqual(payload["paypalMeSlug"], "stephenchan")
        self.assertEqual(payload["zelleEmailOrPhone"], "you@email.com")
        self.assertIsNotNone(payload["updatedAt"])

        with self.service.request_identity_context(self._identity()):
            fetched = self.service.vendor_wallet_handles()
        self.assertEqual(fetched["venmoHandle"], "stephen-chan")
        self.assertEqual(fetched["cashappHandle"], "$stephenchan")
        self.assertEqual(fetched["paypalMeSlug"], "stephenchan")
        self.assertEqual(fetched["zelleEmailOrPhone"], "you@email.com")

    def test_put_updates_existing_record(self) -> None:
        with self.service.request_identity_context(self._identity()):
            self.service.update_vendor_wallet_handles(
                {"venmoHandle": "first-handle"}
            )
            updated = self.service.update_vendor_wallet_handles(
                {
                    "venmoHandle": "new-handle",
                    "cashappHandle": "$new",
                }
            )
        self.assertEqual(updated["venmoHandle"], "new-handle")
        self.assertEqual(updated["cashappHandle"], "$new")
        self.assertIsNone(updated["paypalMeSlug"])
        self.assertIsNone(updated["zelleEmailOrPhone"])

    def test_handles_are_owner_scoped(self) -> None:
        with self.service.request_identity_context(self._identity("vendor-a")):
            self.service.update_vendor_wallet_handles(
                {"venmoHandle": "vendor-a-handle"}
            )
        with self.service.request_identity_context(self._identity("vendor-b")):
            payload_b = self.service.vendor_wallet_handles()
            self.assertIsNone(payload_b["venmoHandle"])
            self.service.update_vendor_wallet_handles(
                {"venmoHandle": "vendor-b-handle"}
            )
        with self.service.request_identity_context(self._identity("vendor-a")):
            payload_a = self.service.vendor_wallet_handles()
        self.assertEqual(payload_a["venmoHandle"], "vendor-a-handle")


if __name__ == "__main__":
    unittest.main()
