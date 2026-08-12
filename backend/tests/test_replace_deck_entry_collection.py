"""`replace_deck_entry` must keep the holding in the collection it was already in.

Reported as "switching the card from EN to JP made the card disappear from the
collection". The swap is a legitimate replace, but any change to the identity key
takes the upsert branch, and that branch inserted the NEW row without a
collection_id. A scoped read (`AND collection_id = ?`) cannot match NULL, so the
card vanished from the collection the user was looking at — it survived only in
the un-scoped "All Collection" view.

card_id is only one component of identity_key, so the EN/JP toggle was just the
way it got noticed: a grade, variant or condition edit dropped the collection too.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_catalog_card  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class ReplaceDeckEntryKeepsCollectionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        database_path = Path(self.tempdir.name) / "replace-collection.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        # An EN card and its JP counterpart — the two sides of the toggle.
        for card_id, name, set_id, set_name in (
            ("sv5k-88", "Grimer", "sv5k", "Wild Force"),
            ("topsun_ja-88", "Grimer", "topsun_ja", "Topsun"),
        ):
            upsert_catalog_card(
                connection,
                {
                    "id": card_id,
                    "name": name,
                    "setName": set_name,
                    "number": "088",
                    "setId": set_id,
                },
                REPO_ROOT,
                "2026-06-17T00:00:00Z",
                refresh_embeddings=False,
            )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _collection_of(self, deck_entry_id: str) -> str | None:
        row = self.service.connection.execute(
            "SELECT collection_id FROM deck_entries WHERE id = ?",
            (deck_entry_id,),
        ).fetchone()
        self.assertIsNotNone(row)
        return str(row["collection_id"] or "").strip() or None

    def _entry_in_named_collection(self, card_id: str) -> tuple[str, str]:
        """An owned entry filed under a NON-default collection, like "Grails"."""
        created = self.service.create_collection({"name": "Grails"})
        collection_id = str(created["collection"]["id"])
        self.service.create_deck_entry(
            {
                "cardID": card_id,
                "selectionSource": "manual_search",
                "quantity": 1,
                "addedAt": "2026-06-17T07:27:30Z",
                "variantName": "Holofoil",
                "collectionID": collection_id,
            }
        )
        entry = self.service.connection.execute(
            "SELECT id FROM deck_entries WHERE card_id = ? AND collection_id = ?",
            (card_id, collection_id),
        ).fetchone()
        self.assertIsNotNone(entry)
        return str(entry["id"]), collection_id

    def test_en_to_jp_swap_stays_in_its_collection(self) -> None:
        entry_id, collection_id = self._entry_in_named_collection("sv5k-88")

        result = self.service.replace_deck_entry(
            {
                "deckEntryID": entry_id,
                # The counterpart printing — this is the EN/JP toggle saving.
                "cardID": "topsun_ja-88",
                "quantity": 1,
                "unitPrice": 0,
                "slabContext": None,
                "variantName": "Holofoil",
            }
        )

        # A card change always mints a new row; it must land in the same place.
        self.assertNotEqual(result["deckEntryID"], entry_id)
        self.assertEqual(self._collection_of(str(result["deckEntryID"])), collection_id)

    def test_grade_change_stays_in_its_collection(self) -> None:
        # The same defect, reached without touching card_id at all.
        entry_id, collection_id = self._entry_in_named_collection("sv5k-88")

        result = self.service.replace_deck_entry(
            {
                "deckEntryID": entry_id,
                "cardID": "sv5k-88",
                "quantity": 1,
                "unitPrice": 0,
                "slabContext": {"grader": "PSA", "grade": "10"},
            }
        )

        self.assertNotEqual(result["deckEntryID"], entry_id)
        self.assertEqual(self._collection_of(str(result["deckEntryID"])), collection_id)

    def test_condition_change_stays_in_its_collection(self) -> None:
        # Reported separately ("changing the condition made it disappear"), and
        # the same single cause: condition is part of identity_key too.
        entry_id, collection_id = self._entry_in_named_collection("sv5k-88")

        result = self.service.replace_deck_entry(
            {
                "deckEntryID": entry_id,
                "cardID": "sv5k-88",
                "quantity": 1,
                "unitPrice": 0,
                "slabContext": None,
                "variantName": "Holofoil",
                "condition": "lightly_played",
            }
        )

        self.assertNotEqual(result["deckEntryID"], entry_id)
        self.assertEqual(self._collection_of(str(result["deckEntryID"])), collection_id)

    def test_swapped_card_is_still_visible_when_the_collection_is_scoped(self) -> None:
        """The user-visible symptom, asserted through the read they were using."""
        entry_id, collection_id = self._entry_in_named_collection("sv5k-88")

        self.service.replace_deck_entry(
            {
                "deckEntryID": entry_id,
                "cardID": "topsun_ja-88",
                "quantity": 1,
                "unitPrice": 0,
                "slabContext": None,
                "variantName": "Holofoil",
            }
        )

        # Production's own predicate for a scoped Collection read — the thing
        # that silently excluded the row once its collection_id went NULL.
        visible = self.service.connection.execute(
            """
            SELECT card_id
            FROM deck_entries
            WHERE collection_id = ?
              AND quantity > 0
            """,
            (collection_id,),
        ).fetchall()
        self.assertEqual([str(row["card_id"]) for row in visible], ["topsun_ja-88"])


if __name__ == "__main__":
    unittest.main()
