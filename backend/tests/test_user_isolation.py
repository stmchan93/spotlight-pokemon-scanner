from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
