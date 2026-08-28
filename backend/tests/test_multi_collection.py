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

    def test_dashboard_history_is_scoped_to_the_collection(self) -> None:
        """The BALANCE has to move with the card list.

        The client reads the Collection balance from
        `ranges['1W'].history.summary.currentValue`, and history used to be
        computed account-wide while only the entry list was scoped. So every
        collection showed the whole account's money under its own name, and a
        collection you had just created — holding nothing — opened showing the
        previous one's balance.
        """
        self._insert_card(card_id="tst-1", name="Pikachu", number="1/1")
        self._add_card(user_id="user-a", card_id="tst-1")

        with self.service.request_identity_context(self._identity("user-a")):
            main_id = self.service.list_collections()["defaultCollectionID"]
            empty_id = self.service.create_collection({"name": "Grails"})["collection"]["id"]

            account_wide = self.service.portfolio_dashboard(range_key="1W")
            main_scoped = self.service.portfolio_dashboard(range_key="1W", collection_id=main_id)
            empty_scoped = self.service.portfolio_dashboard(range_key="1W", collection_id=empty_id)

        def entry_ids(payload: dict) -> list[str]:
            return [entry["card"]["id"] for entry in payload["inventory"]["entries"]]

        # The collection holding the card reports it; the new one reports nothing.
        self.assertEqual(entry_ids(main_scoped), ["tst-1"])
        self.assertEqual(entry_ids(empty_scoped), [])

        # `points` is the discriminator, and it needs no seeded prices to be
        # meaningful: `deck_history` early-returns an empty series ONLY when it
        # sees no entry rows at all. A card with no price still plots (at $0), so
        # a non-empty series here means the read genuinely found holdings.
        #
        # That is exactly what the bug was. Before the scope reached
        # `_portfolio_history_entry_rows`, the empty collection was handed the
        # ACCOUNT's entries and produced a full series — the account's balance,
        # under a collection holding nothing.
        self.assertNotEqual(account_wide["ranges"]["1W"]["history"]["points"], [])
        self.assertNotEqual(main_scoped["ranges"]["1W"]["history"]["points"], [])

        empty_history = empty_scoped["ranges"]["1W"]["history"]
        self.assertEqual(empty_history["points"], [])
        self.assertEqual(empty_history["summary"]["currentValue"], 0.0)

        # The account-wide read is untouched, and the collection that actually
        # holds the card still agrees with it.
        self.assertEqual(
            main_scoped["ranges"]["1W"]["history"]["summary"]["currentValue"],
            account_wide["ranges"]["1W"]["history"]["summary"]["currentValue"],
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

    def test_rename_collection(self) -> None:
        with self.service.request_identity_context(self._identity("user-a")):
            created = self.service.create_collection({"name": "Grails"})["collection"]
            self.service.update_collection({"collectionID": created["id"], "name": "  Vault  "})
            names = [c["name"] for c in self.service.list_collections()["collections"]]

        self.assertIn("Vault", names)
        self.assertNotIn("Grails", names)

    def test_hidden_collections_drop_out_of_the_unscoped_total_but_stay_readable(self) -> None:
        self._insert_card(card_id="tst-1", name="Pikachu", number="1/1")
        self._insert_card(card_id="tst-2", name="Gengar", number="2/2")
        self._add_card(user_id="user-a", card_id="tst-1")

        with self.service.request_identity_context(self._identity("user-a")):
            grails_id = self.service.create_collection({"name": "Grails"})["collection"]["id"]
            self._add_card_inline(user_id="user-a", card_id="tst-2", collection_id=grails_id)

            before = self.service.list_collections()
            self.service.update_collection({"collectionID": grails_id, "hidden": True})
            after = self.service.list_collections()
            still_readable = self.service.deck_entries(limit=10, collection_id=grails_id)

        self.assertEqual(before["all"]["cardCount"], 2)
        # Hiding removes it from the aggregate...
        self.assertEqual(after["all"]["cardCount"], 1)
        hidden_row = next(c for c in after["collections"] if c["id"] == grails_id)
        self.assertTrue(hidden_row["hidden"])
        # ...but the collection itself still lists its cards, so it can be unhidden.
        self.assertEqual([e["card"]["id"] for e in still_readable["entries"]], ["tst-2"])

    def test_delete_collection_removes_its_cards(self) -> None:
        self._insert_card(card_id="tst-1", name="Pikachu", number="1/1")
        self._insert_card(card_id="tst-2", name="Gengar", number="2/2")
        self._add_card(user_id="user-a", card_id="tst-1")

        with self.service.request_identity_context(self._identity("user-a")):
            grails_id = self.service.create_collection({"name": "Grails"})["collection"]["id"]
            self._add_card_inline(user_id="user-a", card_id="tst-2", collection_id=grails_id)

            result = self.service.delete_collection({"collectionID": grails_id})
            remaining = self.service.list_collections()
            everything = self.service.deck_entries(limit=10)

        self.assertEqual(result["deletedEntryCount"], 1)
        self.assertEqual([c["name"] for c in remaining["collections"]], ["Main Collection"])
        # The deleted collection's card goes with it; the other one is untouched.
        self.assertEqual([e["card"]["id"] for e in everything["entries"]], ["tst-1"])

    def test_cannot_delete_your_only_collection(self) -> None:
        """One tap in a picker must not be able to wipe an entire portfolio."""
        self._insert_card(card_id="tst-1", name="Pikachu", number="1/1")
        self._add_card(user_id="user-a", card_id="tst-1")

        with self.service.request_identity_context(self._identity("user-a")):
            only_id = self.service.list_collections()["defaultCollectionID"]
            with self.assertRaises(ValueError):
                self.service.delete_collection({"collectionID": only_id})
            survivors = self.service.deck_entries(limit=10)

        self.assertEqual([e["card"]["id"] for e in survivors["entries"]], ["tst-1"])

    def test_entries_carry_collection_id_and_name(self) -> None:
        """Every entry DTO names its collection — scoped and unscoped reads alike —
        and a legacy NULL-collection row emits null fields instead of crashing."""
        self._insert_card(card_id="tst-1", name="Pikachu", number="1/1")
        self._insert_card(card_id="tst-2", name="Gengar", number="2/2")
        self._insert_card(card_id="tst-3", name="Snorlax", number="3/3")
        self._add_card(user_id="user-a", card_id="tst-1")

        with self.service.request_identity_context(self._identity("user-a")):
            main_id = self.service.list_collections()["defaultCollectionID"]
            grails_id = self.service.create_collection({"name": "Grails"})["collection"]["id"]
            self._add_card_inline(user_id="user-a", card_id="tst-2", collection_id=grails_id)
            self._add_card_inline(user_id="user-a", card_id="tst-3", collection_id=main_id)

        # Simulate a legacy row that predates collections, before any read so the
        # lazy default-collection adoption cannot re-file it first.
        self.service.connection.execute(
            "UPDATE deck_entries SET collection_id = NULL WHERE owner_user_id = ? AND card_id = ?",
            ("user-a", "tst-3"),
        )
        self.service.connection.commit()

        with self.service.request_identity_context(self._identity("user-a")):
            scoped_main = self.service.deck_entries(limit=10, collection_id=main_id)
            scoped_grails = self.service.deck_entries(limit=10, collection_id=grails_id)
            unscoped = self.service.deck_entries(limit=10)

        self.assertEqual(
            [(e["collectionId"], e["collectionName"]) for e in scoped_main["entries"]],
            [(main_id, "Main Collection")],
        )
        self.assertEqual(
            [(e["collectionId"], e["collectionName"]) for e in scoped_grails["entries"]],
            [(grails_id, "Grails")],
        )
        by_card = {e["card"]["id"]: e for e in unscoped["entries"]}
        self.assertEqual(set(by_card), {"tst-1", "tst-2", "tst-3"})
        self.assertEqual(by_card["tst-1"]["collectionId"], main_id)
        self.assertEqual(by_card["tst-1"]["collectionName"], "Main Collection")
        self.assertEqual(by_card["tst-2"]["collectionId"], grails_id)
        self.assertEqual(by_card["tst-2"]["collectionName"], "Grails")
        # Legacy row: fields present, both null.
        self.assertIsNone(by_card["tst-3"]["collectionId"])
        self.assertIsNone(by_card["tst-3"]["collectionName"])

    def test_cannot_mutate_another_accounts_collection(self) -> None:
        with self.service.request_identity_context(self._identity("user-b")):
            victim_id = self.service.create_collection({"name": "Victim"})["collection"]["id"]

        with self.service.request_identity_context(self._identity("user-a")):
            self.service.create_collection({"name": "Mine"})
            with self.assertRaises(FileNotFoundError):
                self.service.update_collection({"collectionID": victim_id, "name": "Pwned"})
            with self.assertRaises(FileNotFoundError):
                self.service.delete_collection({"collectionID": victim_id})

        with self.service.request_identity_context(self._identity("user-b")):
            names = [c["name"] for c in self.service.list_collections()["collections"]]
        self.assertIn("Victim", names)


if __name__ == "__main__":
    unittest.main()
