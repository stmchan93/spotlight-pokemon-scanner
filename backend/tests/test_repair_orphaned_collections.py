"""`tools/repair_orphaned_deck_entry_collections.py` re-files orphaned holdings.

Builds the exact shape the old `replace_deck_entry` left behind — a zeroed
predecessor still holding the original collection, a new row with NULL — and
checks the row goes back where it came from, not merely somewhere valid.
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_catalog_card  # noqa: E402

_TOOL_PATH = REPO_ROOT / "tools" / "repair_orphaned_deck_entry_collections.py"
_spec = importlib.util.spec_from_file_location("repair_orphaned_collections", _TOOL_PATH)
assert _spec and _spec.loader
repair_tool = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(repair_tool)

OWNER = "user-1"
STAMP = "2026-08-12T00:00:00Z"


class RepairOrphanedCollectionsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "repair.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        upsert_catalog_card(
            connection,
            {"id": "sv5k-88", "name": "Grimer", "setName": "Wild Force", "number": "088", "setId": "sv5k"},
            REPO_ROOT,
            STAMP,
            refresh_embeddings=False,
        )
        for collection_id, name, sort_order in (
            ("collection:main", "Main Collection", 0),
            ("collection:grails", "Grails", 1),
        ):
            connection.execute(
                "INSERT INTO collections (id, owner_user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)",
                (collection_id, OWNER, name, sort_order, STAMP),
            )
        connection.commit()
        connection.close()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.database_path))
        con.row_factory = sqlite3.Row
        return con

    def _insert_entry(self, entry_id: str, *, collection_id: str | None, quantity: int) -> None:
        con = self._connect()
        con.execute(
            """
            INSERT INTO deck_entries (
                id, owner_user_id, card_id, item_kind, identity_key,
                quantity, added_at, updated_at, collection_id
            ) VALUES (?, ?, 'sv5k-88', 'raw', ?, ?, ?, ?, ?)
            """,
            (entry_id, OWNER, f"key-{entry_id}", quantity, STAMP, STAMP, collection_id),
        )
        con.commit()
        con.close()

    def _insert_event(self, event_id: str, entry_id: str, kind: str, created_at: str = STAMP) -> None:
        con = self._connect()
        con.execute(
            """
            INSERT INTO deck_entry_events (
                id, owner_user_id, deck_entry_id, card_id, event_kind, created_at
            ) VALUES (?, ?, ?, 'sv5k-88', ?, ?)
            """,
            (event_id, OWNER, entry_id, kind, created_at),
        )
        con.commit()
        con.close()

    def _collection_of(self, entry_id: str) -> str | None:
        con = self._connect()
        row = con.execute("SELECT collection_id FROM deck_entries WHERE id = ?", (entry_id,)).fetchone()
        con.close()
        return str(row["collection_id"]).strip() if row and row["collection_id"] else None

    def test_restores_the_original_collection_from_the_predecessor(self) -> None:
        # The zeroed predecessor still knows it was in "Grails".
        self._insert_entry("entry:old", collection_id="collection:grails", quantity=0)
        self._insert_entry("entry:new", collection_id=None, quantity=1)
        self._insert_event("event:out", "entry:old", "replace_out")
        self._insert_event("event:in", "entry:new", "replace_in")

        repair_tool.run(self.database_path, apply_changes=True)

        # Back to Grails — NOT swept into the default, which is what the
        # server's own lazy backfill would have done.
        self.assertEqual(self._collection_of("entry:new"), "collection:grails")

    def test_falls_back_to_the_default_when_no_predecessor_survives(self) -> None:
        self._insert_entry("entry:lonely", collection_id=None, quantity=1)

        repair_tool.run(self.database_path, apply_changes=True)

        self.assertEqual(self._collection_of("entry:lonely"), "collection:main")

    def test_ambiguous_pairing_falls_back_rather_than_guessing(self) -> None:
        # Two replaces at the same instant: the pairing cannot be trusted, so the
        # row takes the default instead of a coin-flip between two collections.
        self._insert_entry("entry:old-a", collection_id="collection:grails", quantity=0)
        self._insert_entry("entry:old-b", collection_id="collection:main", quantity=0)
        self._insert_entry("entry:new", collection_id=None, quantity=1)
        self._insert_event("event:out-a", "entry:old-a", "replace_out")
        self._insert_event("event:out-b", "entry:old-b", "replace_out")
        self._insert_event("event:in", "entry:new", "replace_in")

        repair_tool.run(self.database_path, apply_changes=True)

        self.assertEqual(self._collection_of("entry:new"), "collection:main")

    def test_dry_run_writes_nothing(self) -> None:
        self._insert_entry("entry:new", collection_id=None, quantity=1)

        repair_tool.run(self.database_path, apply_changes=False)

        self.assertIsNone(self._collection_of("entry:new"))

    def test_is_idempotent(self) -> None:
        self._insert_entry("entry:old", collection_id="collection:grails", quantity=0)
        self._insert_entry("entry:new", collection_id=None, quantity=1)
        self._insert_event("event:out", "entry:old", "replace_out")
        self._insert_event("event:in", "entry:new", "replace_in")

        repair_tool.run(self.database_path, apply_changes=True)
        repair_tool.run(self.database_path, apply_changes=True)

        self.assertEqual(self._collection_of("entry:new"), "collection:grails")
        # And the predecessor is left exactly as it was.
        self.assertEqual(self._collection_of("entry:old"), "collection:grails")


if __name__ == "__main__":
    unittest.main()
