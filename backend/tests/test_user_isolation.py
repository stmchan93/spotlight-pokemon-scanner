from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from request_auth import RequestAuthError, RequestIdentity  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class UserIsolationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "user-isolation.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _identity(self, user_id: str) -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(
        self,
        *,
        card_id: str,
        name: str,
        set_name: str = "Test Set",
        number: str = "1/1",
        set_code: str = "TST",
        language: str = "English",
    ) -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name=set_name,
            number=number,
            rarity="Rare",
            variant="Raw",
            language=language,
            source_provider="scrydex",
            source_record_id=card_id,
            set_id=set_code.lower(),
            set_ptcgo_code=set_code,
            set_release_date="2026-04-20",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def test_same_card_identity_creates_separate_rows_per_user(self) -> None:
        self._insert_card(card_id="base-pikachu-58", name="Pikachu", set_name="Base Set", number="58/102", set_code="BS")

        with self.service.request_identity_context(self._identity("user-a")):
            first = self.service.record_buy(
                {
                    "cardID": "base-pikachu-58",
                    "quantity": 1,
                    "unitPrice": 5.0,
                    "currencyCode": "USD",
                    "boughtAt": "2026-04-20T09:00:00Z",
                    "condition": "near_mint",
                }
            )

        with self.service.request_identity_context(self._identity("user-b")):
            second = self.service.record_buy(
                {
                    "cardID": "base-pikachu-58",
                    "quantity": 1,
                    "unitPrice": 7.0,
                    "currencyCode": "USD",
                    "boughtAt": "2026-04-20T10:00:00Z",
                    "condition": "near_mint",
                }
            )

        rows = self.service.connection.execute(
            """
            SELECT id, owner_user_id, identity_key, quantity
            FROM deck_entries
            ORDER BY owner_user_id ASC, id ASC
            """
        ).fetchall()

        self.assertEqual(len(rows), 2)
        self.assertEqual([row["owner_user_id"] for row in rows], ["user-a", "user-b"])
        self.assertEqual([row["identity_key"] for row in rows], ["raw|base-pikachu-58", "raw|base-pikachu-58"])
        self.assertEqual(first["deckEntryID"], rows[0]["id"])
        self.assertEqual(second["deckEntryID"], rows[1]["id"])
        self.assertNotEqual(first["deckEntryID"], second["deckEntryID"])

        with self.service.request_identity_context(self._identity("user-a")):
            user_a_entries = self.service.deck_entries(limit=10, include_inactive=True)["entries"]
        with self.service.request_identity_context(self._identity("user-b")):
            user_b_entries = self.service.deck_entries(limit=10, include_inactive=True)["entries"]

        self.assertEqual([entry["id"] for entry in user_a_entries], [first["deckEntryID"]])
        self.assertEqual([entry["id"] for entry in user_b_entries], [second["deckEntryID"]])

    def test_local_service_ignores_legacy_owner_for_runtime_fallback_identity(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SPOTLIGHT_LEGACY_OWNER_USER_ID": "legacy-owner",
            },
            clear=False,
        ):
            previous_fallback = os.environ.pop("SPOTLIGHT_AUTH_FALLBACK_USER_ID", None)
            previous_auth_required = os.environ.pop("SPOTLIGHT_AUTH_REQUIRED", None)
            try:
                service = SpotlightScanService(self.database_path, REPO_ROOT)
                self.addCleanup(service.connection.close)
                self.assertEqual(service.authenticator.fallback_user_id, "local-dev-user")
            finally:
                if previous_fallback is not None:
                    os.environ["SPOTLIGHT_AUTH_FALLBACK_USER_ID"] = previous_fallback
                if previous_auth_required is not None:
                    os.environ["SPOTLIGHT_AUTH_REQUIRED"] = previous_auth_required

    def test_auth_required_service_does_not_use_configured_fallback_identity(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SPOTLIGHT_AUTH_REQUIRED": "1",
                "SPOTLIGHT_AUTH_FALLBACK_USER_ID": "fallback-user",
            },
            clear=False,
        ):
            service = SpotlightScanService(self.database_path, REPO_ROOT)
            self.addCleanup(service.connection.close)

        with self.assertRaises(RequestAuthError):
            service._current_request_identity()  # noqa: SLF001

    def test_cross_user_scan_ids_cannot_create_deck_entries_or_store_artifacts(self) -> None:
        self._insert_card(card_id="gym1-60", name="Sabrina's Slowbro")

        with self.service.request_identity_context(self._identity("user-a")):
            self.service._log_scan(  # noqa: SLF001
                {"scanID": "scan-user-a"},
                {
                    "scanID": "scan-user-a",
                    "topCandidates": [{"id": "gym1-60"}],
                    "confidence": "medium",
                    "ambiguityFlags": [],
                    "matcherSource": "remoteHybrid",
                    "matcherVersion": "phase7-test",
                    "resolverMode": "raw_card",
                    "resolverPath": "visual_fallback",
                    "reviewDisposition": "ready",
                    "reviewReason": None,
                },
                [{"candidate": {"id": "gym1-60"}, "finalScore": 0.9}],
            )

        with self.service.request_identity_context(self._identity("user-b")):
            with self.assertRaises(FileNotFoundError):
                self.service.create_deck_entry(
                    {
                        "cardID": "gym1-60",
                        "sourceScanID": "scan-user-a",
                        "selectionSource": "top",
                        "selectedRank": 1,
                        "wasTopPrediction": True,
                        "addedAt": "2026-04-20T20:00:00Z",
                    }
                )

            with self.assertRaises(FileNotFoundError):
                self.service.store_scan_artifacts(
                    {
                        "scanID": "scan-user-a",
                        "captureSource": "live_scan",
                        "sourceImage": {
                            "jpegBase64": "",
                            "width": 640,
                            "height": 960,
                        },
                        "normalizedImage": {
                            "jpegBase64": "",
                            "width": 630,
                            "height": 880,
                        },
                    }
                )

    def test_import_jobs_are_private_to_the_request_owner(self) -> None:
        self._insert_card(card_id="base-pikachu-58", name="Pikachu", set_name="Base Set", number="58/102", set_code="BS")

        with self.service.request_identity_context(self._identity("user-a")):
            preview = self.service.preview_portfolio_import(
                {
                    "sourceType": "tcgplayer_csv_v1",
                    "fileName": "tcgplayer.csv",
                    "csvText": "\n".join(
                        [
                            "Collection Name,Product Name,Set Name,Set Code,Number,Language,Condition,Quantity",
                            "Case A,Pikachu,Base Set,BS,58/102,English,Near Mint,1",
                        ]
                    ),
                }
            )

        with self.service.request_identity_context(self._identity("user-b")):
            with self.assertRaises(FileNotFoundError):
                self.service.portfolio_import_job(preview["jobID"])
            with self.assertRaises(FileNotFoundError):
                self.service.commit_portfolio_import(preview["jobID"])

    def test_cross_user_buy_and_sale_transaction_edits_are_rejected(self) -> None:
        self._insert_card(card_id="gym1-60", name="Sabrina's Slowbro")

        with self.service.request_identity_context(self._identity("user-a")):
            buy_payload = self.service.record_buy(
                {
                    "cardID": "gym1-60",
                    "quantity": 2,
                    "unitPrice": 6.0,
                    "currencyCode": "USD",
                    "boughtAt": "2026-04-14T09:00:00Z",
                    "condition": "near_mint",
                }
            )
            sale_payload = self.service.record_sale(
                {
                    "deckEntryID": buy_payload["deckEntryID"],
                    "quantity": 1,
                    "soldAt": "2026-04-15T20:00:00Z",
                    "unitPrice": 10.0,
                    "currencyCode": "USD",
                }
            )
            buy_event_row = self.service.connection.execute(
                """
                SELECT id
                FROM deck_entry_events
                WHERE deck_entry_id = ?
                  AND event_kind = 'buy'
                LIMIT 1
                """,
                (buy_payload["deckEntryID"],),
            ).fetchone()

        assert buy_event_row is not None

        with self.service.request_identity_context(self._identity("user-b")):
            with self.assertRaises(FileNotFoundError):
                self.service.update_portfolio_buy_price(
                    str(buy_event_row["id"]),
                    {
                        "unitPrice": 8.0,
                        "currencyCode": "USD",
                    },
                )
            with self.assertRaises(FileNotFoundError):
                self.service.update_portfolio_sale_price(
                    str(sale_payload["saleID"]),
                    {
                        "unitPrice": 12.0,
                        "currencyCode": "USD",
                    },
                )

    def test_card_transactions_are_private_to_the_request_owner(self) -> None:
        with self.service.request_identity_context(self._identity("user-a")):
            created = self.service.create_card_transaction(
                {
                    "kind": "sold",
                    "amountCents": 4200,
                    "currencyCode": "USD",
                    "occurredAt": "2026-06-01T12:00:00Z",
                    "note": None,
                    "photo": None,
                }
            )
            owned = self.service.list_card_transactions()
        transaction_id = created["id"]
        self.assertEqual(owned["count"], 1)

        with self.service.request_identity_context(self._identity("user-b")):
            # user-b cannot see user-a's ledger
            other = self.service.list_card_transactions()
            self.assertEqual(other["count"], 0)
            # cannot resolve the photo path cross-owner
            self.assertIsNone(self.service.card_transaction_photo_object_path(transaction_id))
            # cannot delete cross-owner
            with self.assertRaises(FileNotFoundError):
                self.service.delete_card_transaction(transaction_id)

        # The row still exists for the real owner.
        with self.service.request_identity_context(self._identity("user-a")):
            still_owned = self.service.list_card_transactions()
            self.assertEqual(still_owned["count"], 1)

    def _owner_row_count(self, table_name: str, owner_user_id: str) -> int:
        row = self.service.connection.execute(
            f"SELECT COUNT(*) FROM {table_name} WHERE owner_user_id = ?",
            (owner_user_id,),
        ).fetchone()
        return int(row[0])

    def test_delete_account_removes_all_owner_scoped_rows(self) -> None:
        # SUPABASE_SERVICE_ROLE_KEY is unset in the test environment, so the
        # Supabase admin delete is a no-op and never touches the network.
        self.assertIsNone(os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))

        self._insert_card(
            card_id="base-charizard-4",
            name="Charizard",
            set_name="Base Set",
            number="4/102",
            set_code="BS",
        )

        owner_tables = self.service._ACCOUNT_DELETION_TABLES

        # Populate several owner-scoped tables for user-a: a buy (deck_entries +
        # deck_entry_events + scan provenance is optional), a card transaction
        # ledger row, and a favorite.
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.record_buy(
                {
                    "cardID": "base-charizard-4",
                    "quantity": 2,
                    "unitPrice": 9.0,
                    "currencyCode": "USD",
                    "boughtAt": "2026-06-01T09:00:00Z",
                    "condition": "near_mint",
                }
            )
            self.service.create_card_transaction(
                {
                    "kind": "bought",
                    "amountCents": 1800,
                    "currencyCode": "USD",
                    "occurredAt": "2026-06-01T09:00:00Z",
                    "note": None,
                    "photo": None,
                }
            )
            self.service.set_card_favorite("base-charizard-4", is_favorite=True)

        # A second owner whose data must survive the deletion of user-a.
        with self.service.request_identity_context(self._identity("user-b")):
            self.service.record_buy(
                {
                    "cardID": "base-charizard-4",
                    "quantity": 1,
                    "unitPrice": 11.0,
                    "currencyCode": "USD",
                    "boughtAt": "2026-06-01T10:00:00Z",
                    "condition": "near_mint",
                }
            )
            self.service.set_card_favorite("base-charizard-4", is_favorite=True)

        # Sanity: user-a actually owns rows in several tables before deletion.
        self.assertGreater(self._owner_row_count("deck_entries", "user-a"), 0)
        self.assertGreater(self._owner_row_count("deck_entry_events", "user-a"), 0)
        self.assertGreater(self._owner_row_count("card_transactions", "user-a"), 0)
        self.assertGreater(self._owner_row_count("card_favorites", "user-a"), 0)

        with self.service.request_identity_context(self._identity("user-a")):
            result = self.service.delete_account({})

        self.assertEqual(result["deleted"], True)
        # No service-role key configured, so the auth user delete was skipped.
        self.assertEqual(result["authUserDeleted"], False)

        # Every owner-scoped table is empty for user-a.
        for table_name in owner_tables:
            self.assertEqual(
                self._owner_row_count(table_name, "user-a"),
                0,
                f"expected no user-a rows left in {table_name}",
            )

        # user-b's data is untouched.
        self.assertGreater(self._owner_row_count("deck_entries", "user-b"), 0)
        self.assertGreater(self._owner_row_count("card_favorites", "user-b"), 0)

    def test_delete_deck_entries_bulk_deletes_only_owned_rows(self) -> None:
        self._insert_card(card_id="base-pikachu-58", name="Pikachu", set_name="Base Set", number="58/102", set_code="BS")
        self._insert_card(card_id="base-charizard-4", name="Charizard", set_name="Base Set", number="4/102", set_code="BS")
        self._insert_card(card_id="base-blastoise-2", name="Blastoise", set_name="Base Set", number="2/102", set_code="BS")

        # Three owned deck entries for user-a (distinct cards so they don't dedupe).
        with self.service.request_identity_context(self._identity("user-a")):
            entry_ids = [
                self.service.record_buy(
                    {
                        "cardID": card_id,
                        "quantity": 1,
                        "unitPrice": 5.0,
                        "currencyCode": "USD",
                        "boughtAt": "2026-06-01T09:00:00Z",
                        "condition": "near_mint",
                    }
                )["deckEntryID"]
                for card_id in ("base-pikachu-58", "base-charizard-4", "base-blastoise-2")
            ]

        # A deck entry owned by a different user must never be touched.
        with self.service.request_identity_context(self._identity("user-b")):
            other_owner_entry = self.service.record_buy(
                {
                    "cardID": "base-pikachu-58",
                    "quantity": 1,
                    "unitPrice": 7.0,
                    "currencyCode": "USD",
                    "boughtAt": "2026-06-01T10:00:00Z",
                    "condition": "near_mint",
                }
            )["deckEntryID"]

        # Delete two of user-a's entries plus user-b's id and a duplicate; only the
        # two owned ids should be removed, and the cross-owner id must be ignored.
        with self.service.request_identity_context(self._identity("user-a")):
            result = self.service.delete_deck_entries(
                {
                    "deckEntryIDs": [
                        entry_ids[0],
                        entry_ids[1],
                        entry_ids[0],  # duplicate, must be deduped
                        other_owner_entry,  # different owner, must be skipped
                    ]
                }
            )

        self.assertEqual(result["deletedCount"], 2)
        self.assertEqual(set(result["deletedDeckEntryIDs"]), {entry_ids[0], entry_ids[1]})

        remaining = {
            row["id"]
            for row in self.service.connection.execute(
                "SELECT id FROM deck_entries"
            ).fetchall()
        }
        # user-a's untouched entry and user-b's entry both survive.
        self.assertIn(entry_ids[2], remaining)
        self.assertIn(other_owner_entry, remaining)
        self.assertNotIn(entry_ids[0], remaining)
        self.assertNotIn(entry_ids[1], remaining)
        self.assertEqual(self._owner_row_count("deck_entries", "user-b"), 1)

    def test_delete_deck_entries_requires_non_empty_list(self) -> None:
        with self.service.request_identity_context(self._identity("user-a")):
            with self.assertRaises(ValueError):
                self.service.delete_deck_entries({"deckEntryIDs": []})
            with self.assertRaises(ValueError):
                self.service.delete_deck_entries({"deckEntryIDs": ["  ", ""]})
            with self.assertRaises(ValueError):
                self.service.delete_deck_entries({})


if __name__ == "__main__":
    unittest.main()
