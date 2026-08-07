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


class MultiCollectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "multi-collection.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _identity(self, user_id: str) -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(self, *, card_id: str, name: str, number: str) -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name="Test Set",
            number=number,
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            set_id="tst",
            set_ptcgo_code="TST",
            set_release_date="2026-04-30",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def _add_card(self, *, user_id: str, card_id: str, collection_id: str | None = None) -> None:
        payload = {"cardID": card_id, "quantity": 1, "condition": "near_mint"}
        if collection_id is not None:
            payload["collectionID"] = collection_id
        with self.service.request_identity_context(self._identity(user_id)):
            self.service.create_deck_entry(payload)

    def test_first_read_creates_the_default_collection(self) -> None:
        with self.service.request_identity_context(self._identity("user-a")):
            payload = self.service.list_collections()

        self.assertEqual(len(payload["collections"]), 1)
        default_collection = payload["collections"][0]
        self.assertEqual(default_collection["name"], "Main Collection")
        self.assertTrue(default_collection["isDefault"])
        self.assertEqual(default_collection["cardCount"], 0)
        self.assertEqual(payload["defaultCollectionID"], default_collection["id"])

    def test_pre_existing_holdings_are_adopted_by_the_default_collection(self) -> None:
        """The lazy backfill: rows written before collections existed carry a NULL
        collection_id, and must end up in Main Collection rather than vanishing
        from a collection-scoped read."""
        self._insert_card(card_id="tst-1", name="Pikachu", number="1/1")
        self._add_card(user_id="user-a", card_id="tst-1")

        # Simulate a holding that predates the migration.
        self.service.connection.execute(
            "UPDATE deck_entries SET collection_id = NULL WHERE owner_user_id = ?",
            ("user-a",),
        )
        self.service.connection.commit()

        with self.service.request_identity_context(self._identity("user-a")):
            payload = self.service.list_collections()
            default_collection_id = payload["defaultCollectionID"]
            scoped = self.service.deck_entries(limit=10, collection_id=default_collection_id)

        self.assertEqual(payload["collections"][0]["cardCount"], 1)
        self.assertEqual(payload["all"]["cardCount"], 1)
        self.assertEqual([entry["card"]["id"] for entry in scoped["entries"]], ["tst-1"])

    def test_create_collection_starts_empty_and_scopes_reads(self) -> None:
        self._insert_card(card_id="tst-1", name="Pikachu", number="1/1")
        self._insert_card(card_id="tst-2", name="Gengar", number="2/2")
        self._add_card(user_id="user-a", card_id="tst-1")

        with self.service.request_identity_context(self._identity("user-a")):
            created = self.service.create_collection({"name": "  Grails  "})
            grails_id = created["collection"]["id"]
            self._add_card_inline(user_id="user-a", card_id="tst-2", collection_id=grails_id)

            main_id = self.service.list_collections()["defaultCollectionID"]
            main_entries = self.service.deck_entries(limit=10, collection_id=main_id)
            grails_entries = self.service.deck_entries(limit=10, collection_id=grails_id)
            everything = self.service.deck_entries(limit=10)

        self.assertEqual(created["collection"]["name"], "Grails")
        self.assertEqual(created["collection"]["cardCount"], 0)
        self.assertFalse(created["collection"]["isDefault"])
        self.assertEqual([entry["card"]["id"] for entry in main_entries["entries"]], ["tst-1"])
        self.assertEqual([entry["card"]["id"] for entry in grails_entries["entries"]], ["tst-2"])
        self.assertEqual(
            sorted(entry["card"]["id"] for entry in everything["entries"]),
            ["tst-1", "tst-2"],
        )

    def _add_card_inline(self, *, user_id: str, card_id: str, collection_id: str) -> None:
        """Add while already inside a request-identity context."""
        self.service.create_deck_entry(
            {
                "cardID": card_id,
                "quantity": 1,
                "condition": "near_mint",
                "collectionID": collection_id,
            }
        )

    def test_same_card_in_two_collections_stays_separate(self) -> None:
        """Adding a card the owner already holds elsewhere must create a second
        holding, not bump the quantity of the copy in another collection."""
        self._insert_card(card_id="tst-1", name="Pikachu", number="1/1")
        self._add_card(user_id="user-a", card_id="tst-1")

        with self.service.request_identity_context(self._identity("user-a")):
            main_id = self.service.list_collections()["defaultCollectionID"]
            grails_id = self.service.create_collection({"name": "Grails"})["collection"]["id"]
            self._add_card_inline(user_id="user-a", card_id="tst-1", collection_id=grails_id)

            main_entries = self.service.deck_entries(limit=10, collection_id=main_id)
            grails_entries = self.service.deck_entries(limit=10, collection_id=grails_id)

        self.assertEqual(main_entries["summary"]["count"], 1)
        self.assertEqual(grails_entries["summary"]["count"], 1)
        self.assertEqual(main_entries["entries"][0]["quantity"], 1)
        self.assertEqual(grails_entries["entries"][0]["quantity"], 1)

    def test_collection_id_from_another_account_is_ignored(self) -> None:
        """A borrowed collection id must never file a card into someone else's
        collection — it falls back to the caller's default."""
        self._insert_card(card_id="tst-1", name="Pikachu", number="1/1")
        with self.service.request_identity_context(self._identity("user-b")):
            victim_collection_id = self.service.create_collection({"name": "Victim"})["collection"]["id"]

        self._add_card(user_id="user-a", card_id="tst-1", collection_id=victim_collection_id)

        with self.service.request_identity_context(self._identity("user-b")):
            victim_entries = self.service.deck_entries(limit=10, collection_id=victim_collection_id)
        with self.service.request_identity_context(self._identity("user-a")):
            attacker_default_id = self.service.list_collections()["defaultCollectionID"]
            attacker_entries = self.service.deck_entries(limit=10, collection_id=attacker_default_id)

        self.assertEqual(victim_entries["summary"]["count"], 0)
        self.assertEqual([entry["card"]["id"] for entry in attacker_entries["entries"]], ["tst-1"])

    def test_collections_are_scoped_per_owner(self) -> None:
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.create_collection({"name": "Grails"})
            user_a = self.service.list_collections()
        with self.service.request_identity_context(self._identity("user-b")):
            user_b = self.service.list_collections()

        self.assertEqual(
            sorted(collection["name"] for collection in user_a["collections"]),
            ["Grails", "Main Collection"],
        )
        self.assertEqual([collection["name"] for collection in user_b["collections"]], ["Main Collection"])

    def test_create_collection_rejects_an_empty_name(self) -> None:
        with self.service.request_identity_context(self._identity("user-a")):
            with self.assertRaises(ValueError):
                self.service.create_collection({"name": "   "})


if __name__ == "__main__":
    unittest.main()
