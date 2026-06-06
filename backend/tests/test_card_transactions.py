from __future__ import annotations

import base64
import os
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
from scan_artifact_store import (  # noqa: E402
    SCAN_ARTIFACTS_ROOT_ENV,
    SCAN_ARTIFACTS_STORAGE_ENV,
)
from server import SpotlightScanService  # noqa: E402


# A tiny but valid JPEG payload is unnecessary — the store/proxy are byte-exact
# and never decode the image, so any non-empty bytes round-trip faithfully.
PHOTO_BYTES = b"\xff\xd8\xff\xe0fake-jpeg-bytes\x00\x01\x02\x03"
PHOTO_BASE64 = base64.b64encode(PHOTO_BYTES).decode("ascii")


def _photo_payload() -> dict[str, object]:
    return {"jpegBase64": PHOTO_BASE64, "width": 480, "height": 640}


class CardTransactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "card-transactions.sqlite"
        self.artifact_root = Path(self.tempdir.name) / "artifact-root"
        self.previous_artifact_root = os.environ.get(SCAN_ARTIFACTS_ROOT_ENV)
        self.previous_artifact_storage = os.environ.get(SCAN_ARTIFACTS_STORAGE_ENV)
        os.environ[SCAN_ARTIFACTS_ROOT_ENV] = str(self.artifact_root)
        os.environ.pop(SCAN_ARTIFACTS_STORAGE_ENV, None)  # filesystem store
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        if self.previous_artifact_root is None:
            os.environ.pop(SCAN_ARTIFACTS_ROOT_ENV, None)
        else:
            os.environ[SCAN_ARTIFACTS_ROOT_ENV] = self.previous_artifact_root
        if self.previous_artifact_storage is None:
            os.environ.pop(SCAN_ARTIFACTS_STORAGE_ENV, None)
        else:
            os.environ[SCAN_ARTIFACTS_STORAGE_ENV] = self.previous_artifact_storage
        self.tempdir.cleanup()

    def _identity(self, user_id: str = "owner-a") -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _create(
        self,
        *,
        user_id: str = "owner-a",
        kind: str = "sold",
        amount_cents: int | None = 4200,
        item_count: int | None = None,
        occurred_at: str = "2026-06-01T12:00:00Z",
        note: str | None = None,
        photo: dict[str, object] | None = None,
        image_url: str | None = None,
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "kind": kind,
            "amountCents": amount_cents,
            "currencyCode": "USD",
            "occurredAt": occurred_at,
            "note": note,
            "photo": photo,
        }
        if item_count is not None:
            payload["itemCount"] = item_count
        if image_url is not None:
            payload["imageUrl"] = image_url
        with self.service.request_identity_context(self._identity(user_id)):
            return self.service.create_card_transaction(payload)

    # -- create ----------------------------------------------------------------

    def test_create_with_photo_persists_row_writes_bytes_and_returns_photo_url(self) -> None:
        created = self._create(photo=_photo_payload())

        self.assertEqual(created["kind"], "sold")
        self.assertEqual(created["amountCents"], 4200)
        self.assertEqual(created["currencyCode"], "USD")
        self.assertIsNone(created["note"])
        self.assertEqual(created["occurredAt"], "2026-06-01T12:00:00Z")
        self.assertEqual(created["occurredAtLabel"], "Jun 1, 2026")
        self.assertEqual(
            created["photoUrl"], f"/api/v1/card-transactions/{created['id']}/photo"
        )

        row = self.service.connection.execute(
            "SELECT owner_user_id, kind, amount_cents, photo_object_path, "
            "photo_upload_status, photo_width, photo_height FROM card_transactions "
            "WHERE id = ?",
            (created["id"],),
        ).fetchone()
        self.assertEqual(row["owner_user_id"], "owner-a")
        self.assertEqual(row["amount_cents"], 4200)
        self.assertEqual(row["photo_upload_status"], "uploaded")
        self.assertEqual(row["photo_width"], 480)
        self.assertEqual(row["photo_height"], 640)

        object_path = str(row["photo_object_path"])
        on_disk = self.artifact_root / object_path
        self.assertTrue(on_disk.exists())
        self.assertEqual(on_disk.read_bytes(), PHOTO_BYTES)
        self.assertTrue(object_path.startswith("transactions/2026/06/01/"))
        self.assertTrue(object_path.endswith("/photo.jpg"))

    # -- imageUrl --------------------------------------------------------------

    _IMAGE_URL = "https://images.scrydex.com/pokemon/base1-4/high.webp"

    def test_create_with_image_url_persists_and_returns_it(self) -> None:
        created = self._create(image_url=self._IMAGE_URL)
        self.assertEqual(created["imageUrl"], self._IMAGE_URL)

        row = self.service.connection.execute(
            "SELECT image_url FROM card_transactions WHERE id = ?",
            (created["id"],),
        ).fetchone()
        self.assertEqual(row["image_url"], self._IMAGE_URL)

    def test_create_with_image_url_appears_in_list(self) -> None:
        created = self._create(image_url=self._IMAGE_URL)
        with self.service.request_identity_context(self._identity()):
            result = self.service.list_card_transactions()
        self.assertEqual(result["count"], 1)
        listed = result["transactions"][0]
        self.assertEqual(listed["id"], created["id"])
        self.assertEqual(listed["imageUrl"], self._IMAGE_URL)

    def test_create_without_image_url_returns_null(self) -> None:
        created = self._create()
        self.assertIsNone(created["imageUrl"])
        row = self.service.connection.execute(
            "SELECT image_url FROM card_transactions WHERE id = ?",
            (created["id"],),
        ).fetchone()
        self.assertIsNone(row["image_url"])

    def test_create_with_image_url_leaves_photo_url_unchanged(self) -> None:
        # imageUrl and photoUrl are independent: a catalog imageUrl with no photo
        # still yields a null photoUrl, and a photo with no imageUrl yields a
        # null imageUrl.
        only_image = self._create(image_url=self._IMAGE_URL)
        self.assertEqual(only_image["imageUrl"], self._IMAGE_URL)
        self.assertIsNone(only_image["photoUrl"])

        only_photo = self._create(photo=_photo_payload())
        self.assertIsNone(only_photo["imageUrl"])
        self.assertEqual(
            only_photo["photoUrl"], f"/api/v1/card-transactions/{only_photo['id']}/photo"
        )

    def test_create_each_kind(self) -> None:
        for kind in ("bought", "sold", "traded"):
            created = self._create(kind=kind)
            self.assertEqual(created["kind"], kind)

    def test_create_without_photo_returns_null_photo_url(self) -> None:
        created = self._create(photo=None)
        self.assertIsNone(created["photoUrl"])
        row = self.service.connection.execute(
            "SELECT photo_object_path, photo_upload_status FROM card_transactions WHERE id = ?",
            (created["id"],),
        ).fetchone()
        self.assertIsNone(row["photo_object_path"])
        self.assertIsNone(row["photo_upload_status"])

    def test_create_rejects_invalid_kind(self) -> None:
        with self.assertRaises(ValueError):
            self._create(kind="gifted")

    def test_create_rejects_negative_amount(self) -> None:
        with self.assertRaises(ValueError):
            self._create(amount_cents=-1)

    def test_create_defaults_item_count_to_one(self) -> None:
        created = self._create()
        self.assertEqual(created["itemCount"], 1)
        row = self.service.connection.execute(
            "SELECT item_count FROM card_transactions WHERE id = ?",
            (created["id"],),
        ).fetchone()
        self.assertEqual(row["item_count"], 1)

    def test_create_persists_item_count(self) -> None:
        created = self._create(item_count=7)
        self.assertEqual(created["itemCount"], 7)
        row = self.service.connection.execute(
            "SELECT item_count FROM card_transactions WHERE id = ?",
            (created["id"],),
        ).fetchone()
        self.assertEqual(row["item_count"], 7)

    def test_create_rejects_non_positive_item_count(self) -> None:
        with self.assertRaises(ValueError):
            self._create(item_count=0)

    def test_create_allows_null_amount(self) -> None:
        created = self._create(amount_cents=None)
        self.assertIsNone(created["amountCents"])
        row = self.service.connection.execute(
            "SELECT amount_cents FROM card_transactions WHERE id = ?",
            (created["id"],),
        ).fetchone()
        self.assertIsNone(row["amount_cents"])

    def test_create_rejects_non_integer_amount(self) -> None:
        with self.service.request_identity_context(self._identity()):
            with self.assertRaises(ValueError):
                self.service.create_card_transaction(
                    {
                        "kind": "sold",
                        "amountCents": "4200",
                        "currencyCode": "USD",
                        "occurredAt": "2026-06-01T12:00:00Z",
                    }
                )

    def test_create_rejects_missing_kind(self) -> None:
        with self.service.request_identity_context(self._identity()):
            with self.assertRaises(ValueError):
                self.service.create_card_transaction(
                    {
                        "amountCents": 4200,
                        "currencyCode": "USD",
                        "occurredAt": "2026-06-01T12:00:00Z",
                    }
                )

    def test_create_rejects_missing_occurred_at(self) -> None:
        with self.service.request_identity_context(self._identity()):
            with self.assertRaises(ValueError):
                self.service.create_card_transaction(
                    {
                        "kind": "sold",
                        "amountCents": 4200,
                        "currencyCode": "USD",
                    }
                )

    def test_create_rejects_present_but_invalid_photo(self) -> None:
        with self.service.request_identity_context(self._identity()):
            with self.assertRaises(ValueError):
                self.service.create_card_transaction(
                    {
                        "kind": "sold",
                        "amountCents": 4200,
                        "currencyCode": "USD",
                        "occurredAt": "2026-06-01T12:00:00Z",
                        "photo": {"jpegBase64": "not!base64!", "width": 1, "height": 1},
                    }
                )

    def test_create_keeps_row_with_failed_status_on_photo_write_failure(self) -> None:
        def _boom(**_kwargs: object) -> str:
            raise RuntimeError("simulated GCS outage")

        self.service.artifact_store.store_transaction_photo = _boom  # type: ignore[assignment]
        created = self._create(photo=_photo_payload())

        self.assertIsNone(created["photoUrl"])  # failed photo -> null url
        row = self.service.connection.execute(
            "SELECT photo_object_path, photo_upload_status FROM card_transactions WHERE id = ?",
            (created["id"],),
        ).fetchone()
        self.assertIsNone(row["photo_object_path"])
        self.assertEqual(row["photo_upload_status"], "failed")

    # -- list ------------------------------------------------------------------

    def test_list_is_owner_scoped_and_newest_first(self) -> None:
        self._create(user_id="owner-a", occurred_at="2026-06-01T00:00:00Z", amount_cents=100)
        self._create(user_id="owner-a", occurred_at="2026-06-03T00:00:00Z", amount_cents=300)
        self._create(user_id="owner-a", occurred_at="2026-06-02T00:00:00Z", amount_cents=200)
        self._create(user_id="owner-b", occurred_at="2026-06-05T00:00:00Z", amount_cents=999)

        with self.service.request_identity_context(self._identity("owner-a")):
            result = self.service.list_card_transactions()

        self.assertEqual(result["count"], 3)
        self.assertEqual(
            [tx["amountCents"] for tx in result["transactions"]],
            [300, 200, 100],
        )

    def test_list_is_paginated(self) -> None:
        for day in range(1, 6):
            self._create(occurred_at=f"2026-06-0{day}T00:00:00Z", amount_cents=day * 100)

        with self.service.request_identity_context(self._identity()):
            page1 = self.service.list_card_transactions(limit=2, offset=0)
            page2 = self.service.list_card_transactions(limit=2, offset=2)

        self.assertEqual(page1["count"], 2)
        self.assertEqual([tx["amountCents"] for tx in page1["transactions"]], [500, 400])
        self.assertEqual(page2["limit"], 2)
        self.assertEqual(page2["offset"], 2)
        self.assertEqual([tx["amountCents"] for tx in page2["transactions"]], [300, 200])

    def test_list_filters_by_kind(self) -> None:
        self._create(kind="bought")
        self._create(kind="sold")
        self._create(kind="traded")

        with self.service.request_identity_context(self._identity()):
            result = self.service.list_card_transactions(kind="bought")

        self.assertEqual(result["count"], 1)
        self.assertEqual(result["transactions"][0]["kind"], "bought")

    # -- photo proxy -----------------------------------------------------------

    def test_photo_proxy_returns_exact_bytes(self) -> None:
        created = self._create(photo=_photo_payload())
        with self.service.request_identity_context(self._identity()):
            object_path = self.service.card_transaction_photo_object_path(str(created["id"]))
            self.assertIsNotNone(object_path)
            image_bytes = self.service.read_scan_object_bytes(str(object_path))
        self.assertEqual(image_bytes, PHOTO_BYTES)

    def test_photo_proxy_404_cross_owner(self) -> None:
        created = self._create(user_id="owner-a", photo=_photo_payload())
        with self.service.request_identity_context(self._identity("owner-b")):
            self.assertIsNone(
                self.service.card_transaction_photo_object_path(str(created["id"]))
            )

    def test_photo_proxy_returns_none_when_no_photo(self) -> None:
        created = self._create(photo=None)
        with self.service.request_identity_context(self._identity()):
            self.assertIsNone(
                self.service.card_transaction_photo_object_path(str(created["id"]))
            )

    # -- delete ----------------------------------------------------------------

    def test_delete_removes_row_and_photo(self) -> None:
        created = self._create(photo=_photo_payload())
        row = self.service.connection.execute(
            "SELECT photo_object_path FROM card_transactions WHERE id = ?",
            (created["id"],),
        ).fetchone()
        on_disk = self.artifact_root / str(row["photo_object_path"])
        self.assertTrue(on_disk.exists())

        with self.service.request_identity_context(self._identity()):
            result = self.service.delete_card_transaction(str(created["id"]))
        self.assertEqual(result, {"deleted": True, "id": created["id"]})

        remaining = self.service.connection.execute(
            "SELECT COUNT(*) AS n FROM card_transactions WHERE id = ?",
            (created["id"],),
        ).fetchone()
        self.assertEqual(remaining["n"], 0)

    def test_delete_404_on_repeat(self) -> None:
        created = self._create()
        with self.service.request_identity_context(self._identity()):
            self.service.delete_card_transaction(str(created["id"]))
            with self.assertRaises(FileNotFoundError):
                self.service.delete_card_transaction(str(created["id"]))

    def test_delete_404_cross_owner(self) -> None:
        created = self._create(user_id="owner-a")
        with self.service.request_identity_context(self._identity("owner-b")):
            with self.assertRaises(FileNotFoundError):
                self.service.delete_card_transaction(str(created["id"]))
        # still present for the true owner
        with self.service.request_identity_context(self._identity("owner-a")):
            result = self.service.list_card_transactions()
        self.assertEqual(result["count"], 1)


class CardTransactionsMigrationTests(unittest.TestCase):
    """The legacy table had amount_cents NOT NULL and no item_count. The
    startup schema patch must rebuild it to make price optional and backfill
    item_count to 1, without losing existing rows."""

    def test_rebuild_relaxes_not_null_and_backfills_item_count(self) -> None:
        from catalog_tools import connect  # local import; mirrors module idiom
        from server import _apply_card_transactions_schema_patch

        with tempfile.TemporaryDirectory() as tempdir:
            database_path = Path(tempdir) / "legacy.sqlite"
            connection = connect(database_path)
            # Legacy table shape: amount_cents NOT NULL, no item_count column.
            connection.execute(
                """
                CREATE TABLE card_transactions (
                    id TEXT PRIMARY KEY,
                    owner_user_id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('bought','sold','traded')),
                    amount_cents BIGINT NOT NULL,
                    currency_code TEXT NOT NULL DEFAULT 'USD',
                    note TEXT,
                    photo_object_path TEXT,
                    photo_upload_status TEXT,
                    photo_uploaded_at TEXT,
                    photo_width INTEGER,
                    photo_height INTEGER,
                    occurred_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "INSERT INTO card_transactions (id, owner_user_id, kind, amount_cents, "
                "currency_code, occurred_at, created_at) VALUES "
                "('legacy-1', 'owner-a', 'sold', 4200, 'USD', "
                "'2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')"
            )
            connection.commit()

            _apply_card_transactions_schema_patch(connection)
            connection.commit()

            columns = {
                str(row["name"]): bool(row["notnull"])
                for row in connection.execute(
                    "PRAGMA table_info(card_transactions)"
                ).fetchall()
            }
            self.assertIn("item_count", columns)
            self.assertIn("image_url", columns)  # additive nullable column added
            self.assertFalse(columns["amount_cents"])  # NOT NULL relaxed

            row = connection.execute(
                "SELECT amount_cents, item_count FROM card_transactions WHERE id = 'legacy-1'"
            ).fetchone()
            self.assertEqual(row["amount_cents"], 4200)
            self.assertEqual(row["item_count"], 1)  # backfilled default

            # A NULL price is now insertable on the migrated table.
            connection.execute(
                "INSERT INTO card_transactions (id, owner_user_id, kind, amount_cents, "
                "currency_code, occurred_at, created_at) VALUES "
                "('legacy-2', 'owner-a', 'traded', NULL, 'USD', "
                "'2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z')"
            )
            connection.commit()
            null_row = connection.execute(
                "SELECT amount_cents FROM card_transactions WHERE id = 'legacy-2'"
            ).fetchone()
            self.assertIsNone(null_row["amount_cents"])
            connection.close()


if __name__ == "__main__":
    unittest.main()
