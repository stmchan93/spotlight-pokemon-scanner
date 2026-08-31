"""POST /api/v1/deck/entries/create-bulk — the binder-page "add all" lane.

Up to 50 single-create payloads land in ONE transaction; each entry runs the
exact single-create path (owner scoping, dedupe, confirmation) inside a
savepoint so a bad entry reports ``{index, error}`` while the rest commit.
"""

from __future__ import annotations

import contextlib
import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402


class DeckEntriesCreateBulkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "create-bulk.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        for card_id, name in (
            ("base-pikachu-58", "Pikachu"),
            ("base-charizard-4", "Charizard"),
            ("base-blastoise-2", "Blastoise"),
        ):
            self._insert_card(card_id=card_id, name=name)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _identity(self, user_id: str) -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(self, *, card_id: str, name: str) -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name="Base Set",
            number="1/102",
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            set_id="bs",
            set_ptcgo_code="BS",
            set_release_date="1999-01-09",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    @staticmethod
    def _entry(card_id: str, **overrides: object) -> dict[str, object]:
        entry: dict[str, object] = {
            "cardID": card_id,
            "slabContext": None,
            "condition": "near_mint",
            "quantity": 1,
            "sourceScanID": None,
            "selectionSource": "top",
            "addedAt": "2026-08-30T10:00:00Z",
        }
        entry.update(overrides)
        return entry

    def test_bulk_creates_all_entries_with_per_entry_results(self) -> None:
        with self.service.request_identity_context(self._identity("user-a")):
            response = self.service.create_deck_entries_bulk(
                {
                    "entries": [
                        self._entry("base-pikachu-58"),
                        self._entry("base-charizard-4"),
                        self._entry("base-blastoise-2"),
                    ]
                }
            )

        self.assertEqual(response["createdCount"], 3)
        self.assertEqual(response["failedCount"], 0)
        results = response["results"]
        self.assertEqual([result["index"] for result in results], [0, 1, 2])
        for result in results:
            self.assertTrue(result["deckEntryID"])
            self.assertEqual(result["addedAt"], "2026-08-30T10:00:00Z")
            self.assertNotIn("error", result)

        rows = self.service.connection.execute(
            "SELECT owner_user_id, card_id FROM deck_entries ORDER BY card_id"
        ).fetchall()
        self.assertEqual(len(rows), 3)
        self.assertEqual({row["owner_user_id"] for row in rows}, {"user-a"})

    def test_bad_entry_reports_error_and_does_not_fail_the_batch(self) -> None:
        with self.service.request_identity_context(self._identity("user-a")):
            response = self.service.create_deck_entries_bulk(
                {
                    "entries": [
                        self._entry("base-pikachu-58"),
                        self._entry(""),  # missing cardID -> ValueError
                        self._entry(
                            "base-charizard-4",
                            # Unknown scan id -> FileNotFoundError from the
                            # single-create path's owner-scoped scan lookup.
                            sourceScanID="scan-that-does-not-exist",
                        ),
                        self._entry("base-blastoise-2"),
                    ]
                }
            )

        self.assertEqual(response["createdCount"], 2)
        self.assertEqual(response["failedCount"], 2)
        results = response["results"]
        self.assertNotIn("error", results[0])
        self.assertEqual(results[1]["error"], "cardID is required")
        self.assertEqual(results[1]["errorType"], "ValueError")
        self.assertEqual(results[2]["errorType"], "FileNotFoundError")
        self.assertNotIn("error", results[3])

        # The failed entries left no partial rows behind.
        rows = self.service.connection.execute(
            "SELECT card_id FROM deck_entries ORDER BY card_id"
        ).fetchall()
        self.assertEqual([row["card_id"] for row in rows], ["base-blastoise-2", "base-pikachu-58"])

    def test_bulk_is_owner_scoped_like_single_create(self) -> None:
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.create_deck_entries_bulk({"entries": [self._entry("base-pikachu-58")]})
        with self.service.request_identity_context(self._identity("user-b")):
            self.service.create_deck_entries_bulk({"entries": [self._entry("base-pikachu-58")]})

        rows = self.service.connection.execute(
            "SELECT owner_user_id FROM deck_entries ORDER BY owner_user_id"
        ).fetchall()
        self.assertEqual([row["owner_user_id"] for row in rows], ["user-a", "user-b"])

        # Same owner + same identity dedupes into one row (quantity bump),
        # exactly like repeated single creates.
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.create_deck_entries_bulk({"entries": [self._entry("base-pikachu-58")]})
        row = self.service.connection.execute(
            "SELECT quantity FROM deck_entries WHERE owner_user_id = 'user-a'"
        ).fetchone()
        self.assertEqual(row["quantity"], 2)

    def test_bulk_validation(self) -> None:
        with self.service.request_identity_context(self._identity("user-a")):
            with self.assertRaisesRegex(ValueError, "entries is required"):
                self.service.create_deck_entries_bulk({})
            with self.assertRaisesRegex(ValueError, "entries is required"):
                self.service.create_deck_entries_bulk({"entries": []})
            with self.assertRaisesRegex(ValueError, "at most 50"):
                self.service.create_deck_entries_bulk(
                    {"entries": [self._entry("base-pikachu-58")] * 51}
                )
            # A non-dict entry is a per-entry error, not a batch failure.
            response = self.service.create_deck_entries_bulk(
                {"entries": ["nope", self._entry("base-pikachu-58")]}
            )
            self.assertEqual(response["createdCount"], 1)
            self.assertEqual(response["results"][0]["error"], "entry must be an object")

    def test_single_create_still_commits_and_returns_same_shape(self) -> None:
        # The bulk refactor must not change the single path's behavior.
        with self.service.request_identity_context(self._identity("user-a")):
            response = self.service.create_deck_entry(self._entry("base-pikachu-58"))
        self.assertTrue(response["deckEntryID"])
        self.assertEqual(response["cardID"], "base-pikachu-58")
        row = self.service.connection.execute(
            "SELECT owner_user_id FROM deck_entries LIMIT 1"
        ).fetchone()
        self.assertEqual(row["owner_user_id"], "user-a")


class DeckEntriesCreateBulkRouteTests(unittest.TestCase):
    @staticmethod
    def _handler(captured: dict[str, object], body: dict[str, object]) -> SpotlightRequestHandler:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/deck/entries/create-bulk"
        handler.service = Mock()
        handler.service.request_identity_context.return_value = contextlib.nullcontext()
        handler.service.create_deck_entries_bulk.return_value = {
            "results": [],
            "createdCount": 0,
            "failedCount": 0,
        }

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._read_json_body = lambda: body  # type: ignore[method-assign]
        handler._require_request_identity = lambda: object()  # type: ignore[method-assign]
        handler._write_json = write_json  # type: ignore[method-assign]
        return handler

    def test_route_dispatches_to_bulk_create(self) -> None:
        captured: dict[str, object] = {}
        body = {"entries": [{"cardID": "base-pikachu-58"}]}
        handler = self._handler(captured, body)
        handler.do_POST()
        handler.service.create_deck_entries_bulk.assert_called_once_with(body)
        self.assertEqual(captured["status"], HTTPStatus.OK)

    def test_route_maps_value_error_to_400(self) -> None:
        captured: dict[str, object] = {}
        handler = self._handler(captured, {})
        handler.service.create_deck_entries_bulk.side_effect = ValueError("entries is required")
        handler.do_POST()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(captured["payload"], {"error": "entries is required"})


if __name__ == "__main__":
    unittest.main()
