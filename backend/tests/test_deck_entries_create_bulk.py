"""POST /api/v1/deck/entries/create-bulk — the binder-page "add all" lane.

Up to 50 single-create payloads: slow reads run first with no write lock, then
the writes land in short transactions of 10; each entry runs the single-create
write path (owner scoping, dedupe, confirmation) inside a savepoint so a bad
entry reports ``{index, error}`` while the rest commit.
"""

from __future__ import annotations

import contextlib
import sqlite3
import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest import mock
from unittest.mock import Mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, upsert_scan_event  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
import server  # noqa: E402
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

    def test_concurrent_writer_mid_batch_does_not_drop_entries(self) -> None:
        # Prod 2026-10-04: another request committed between an entry's reads
        # and its write, and SQLite failed the write instantly ("database is
        # locked", no busy wait) — 6 of 26 tray cards silently dropped.
        original_upsert = server.upsert_deck_entry
        side_writes = iter(range(100))

        def upsert_after_concurrent_commit(*args: object, **kwargs: object):
            # The entry has already read (snapshot open); now someone else commits.
            other = connect(self.database_path, timeout_seconds=0.05)
            try:
                other.execute(
                    "INSERT INTO collections (id, owner_user_id, name, created_at) VALUES (?, 'user-b', 'x', '2026-10-04')",
                    (f"collection:side-{next(side_writes)}",),
                )
                other.commit()
            except sqlite3.OperationalError:
                pass  # the bulk already holds the write lock: this writer waits its turn
            finally:
                other.close()
            return original_upsert(*args, **kwargs)

        patcher = mock.patch.object(server, "upsert_deck_entry", upsert_after_concurrent_commit)
        patcher.start()
        self.addCleanup(patcher.stop)
        with self.service.request_identity_context(self._identity("user-a")):
            response = self.service.create_deck_entries_bulk(
                {
                    "entries": [
                        self._entry("base-pikachu-58"),
                        self._entry("base-charizard-4"),
                        self._entry("base-blastoise-2"),
                        self._entry("base-pikachu-58"),
                    ]
                }
            )

        self.assertEqual(response["failedCount"], 0, response["results"])
        self.assertEqual(response["createdCount"], 4)

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

    # --- write-lock hold (prod 10/24: request writers starved for minutes) ---

    def _count_begins(self) -> list[int]:
        begins: list[int] = []
        original = self.service._begin_immediate_with_retry

        def counting(*args: object, **kwargs: object) -> None:
            begins.append(1)
            return original(*args, **kwargs)

        patcher = mock.patch.object(self.service, "_begin_immediate_with_retry", side_effect=counting)
        patcher.start()
        self.addCleanup(patcher.stop)
        return begins

    def test_bulk_reads_baseline_outside_write_txn_in_short_chunks(self) -> None:
        baseline_calls: list[bool] = []

        def baseline(*_args: object, **_kwargs: object) -> tuple[float, str]:
            # The slow pricing read must never run while we hold the write lock.
            baseline_calls.append(self.service.connection.in_transaction)
            return 1.5, "2026-11-17"

        begins = self._count_begins()
        cards = ["base-pikachu-58", "base-charizard-4", "base-blastoise-2"]
        entries = [self._entry(cards[i % 3], addedAt=f"2026-11-17T10:00:{i:02d}Z") for i in range(25)]
        with mock.patch.object(self.service, "_added_baseline_now", side_effect=baseline):
            with self.service.request_identity_context(self._identity("user-a")):
                response = self.service.create_deck_entries_bulk({"entries": entries})

        self.assertEqual(response["createdCount"], 25)
        self.assertEqual([result["index"] for result in response["results"]], list(range(25)))
        self.assertEqual(len(baseline_calls), 25)
        self.assertFalse(any(baseline_calls))
        self.assertEqual(len(begins), 3)  # 10 + 10 + 5
        self.assertFalse(self.service.connection.in_transaction)
        total = self.service.connection.execute(
            "SELECT SUM(quantity) FROM deck_entries WHERE owner_user_id = 'user-a'"
        ).fetchone()[0]
        self.assertEqual(total, 25)

    def test_later_chunk_lock_failure_reports_committed_and_failed_entries(self) -> None:
        original = self.service._begin_immediate_with_retry
        calls = {"n": 0}

        def flaky_begin(*args: object, **kwargs: object) -> None:
            calls["n"] += 1
            if calls["n"] == 2:
                raise sqlite3.OperationalError("database is locked")
            return original(*args, **kwargs)

        entries = [self._entry("base-pikachu-58") for _ in range(15)]
        entries[3] = self._entry("")  # per-entry failure inside chunk 1
        with mock.patch.object(self.service, "_begin_immediate_with_retry", side_effect=flaky_begin):
            with self.service.request_identity_context(self._identity("user-a")):
                response = self.service.create_deck_entries_bulk({"entries": entries})

        results = response["results"]
        self.assertEqual([result["index"] for result in results], list(range(15)))
        # Chunk 1 = the 14 valid entries' first 10 (indexes 0-2, 4-10).
        committed = [r["index"] for r in results if "deckEntryID" in r]
        self.assertEqual(committed, [0, 1, 2, 4, 5, 6, 7, 8, 9, 10])
        self.assertEqual(results[3]["errorType"], "ValueError")
        for index in (11, 12, 13, 14):
            self.assertEqual(results[index]["errorType"], "OperationalError")
        self.assertEqual(response["createdCount"], 10)
        self.assertEqual(response["failedCount"], 5)
        quantity = self.service.connection.execute(
            "SELECT quantity FROM deck_entries WHERE owner_user_id = 'user-a'"
        ).fetchone()[0]
        self.assertEqual(quantity, 10)

    def test_first_chunk_lock_failure_still_fails_the_request(self) -> None:
        with mock.patch.object(
            self.service,
            "_begin_immediate_with_retry",
            side_effect=sqlite3.OperationalError("database is locked"),
        ):
            with self.service.request_identity_context(self._identity("user-a")):
                with self.assertRaises(sqlite3.OperationalError):
                    self.service.create_deck_entries_bulk({"entries": [self._entry("base-pikachu-58")]})
        count = self.service.connection.execute("SELECT COUNT(*) FROM deck_entries").fetchone()[0]
        self.assertEqual(count, 0)

    def test_bulk_confirmation_keeps_predicted_selected_confirmed_separate(self) -> None:
        connection = self.service.connection
        upsert_scan_event(
            connection,
            scan_id="scan-1",
            owner_user_id="user-a",
            request_payload={"scanID": "scan-1"},
            response_payload={"topCandidates": [{"id": "base-charizard-4"}]},
            matcher_source="remoteHybrid",
            matcher_version="v-test",
            created_at="2026-11-17T09:00:00Z",
            confidence="high",
        )
        upsert_scan_event(
            connection,
            scan_id="scan-2",
            owner_user_id="user-a",
            request_payload={"scanID": "scan-2"},
            response_payload={"topCandidates": [{"id": "base-blastoise-2"}]},
            matcher_source="remoteHybrid",
            matcher_version="v-test",
            created_at="2026-11-17T09:00:00Z",
            predicted_card_id="base-blastoise-2",
            selected_card_id="base-blastoise-2",
            selected_rank=1,
            selection_source="top",
        )
        connection.commit()
        before = {
            row["scan_id"]: row["request_json"]
            for row in connection.execute("SELECT scan_id, request_json FROM scan_events")
        }

        with self.service.request_identity_context(self._identity("user-a")):
            response = self.service.create_deck_entries_bulk(
                {
                    "entries": [
                        self._entry("base-pikachu-58", sourceScanID="scan-1", selectionSource="alternate", selectedRank=2),
                        self._entry("base-pikachu-58", sourceScanID="scan-2"),
                    ]
                }
            )
        self.assertEqual(response["failedCount"], 0, response["results"])

        rows = {
            row["scan_id"]: row
            for row in connection.execute("SELECT * FROM scan_events ORDER BY scan_id")
        }
        one, two = rows["scan-1"], rows["scan-2"]
        self.assertEqual(one["predicted_card_id"], "base-charizard-4")  # from the response
        self.assertEqual(one["selected_card_id"], "base-pikachu-58")
        self.assertEqual(one["selected_rank"], 2)
        self.assertEqual(one["selection_source"], "alternate")
        self.assertEqual(one["confirmed_card_id"], "base-pikachu-58")
        self.assertEqual(one["confirmation_source"], "add_alternate")
        self.assertEqual(one["confidence"], "high")
        self.assertEqual(one["matcher_version"], "v-test")
        self.assertEqual(two["predicted_card_id"], "base-blastoise-2")
        self.assertEqual(two["selected_card_id"], "base-blastoise-2")  # earlier pick kept
        self.assertEqual(two["selected_rank"], 1)
        self.assertEqual(two["confirmed_card_id"], "base-pikachu-58")
        for scan_id, row in rows.items():
            self.assertEqual(row["request_json"], before[scan_id])  # no blob rewrite
            self.assertTrue(row["deck_entry_id"])
            self.assertEqual(row["confirmed_at"], "2026-08-30T10:00:00Z")
        confirmations = connection.execute(
            "SELECT scan_id, confirmed_card_id FROM scan_confirmations ORDER BY scan_id"
        ).fetchall()
        self.assertEqual(
            [(row["scan_id"], row["confirmed_card_id"]) for row in confirmations],
            [("scan-1", "base-pikachu-58"), ("scan-2", "base-pikachu-58")],
        )

    def test_single_create_reads_baseline_outside_write_txn(self) -> None:
        seen: list[bool] = []

        def baseline(*_args: object, **_kwargs: object) -> tuple[None, None]:
            seen.append(self.service.connection.in_transaction)
            return None, None

        with mock.patch.object(self.service, "_added_baseline_now", side_effect=baseline):
            with self.service.request_identity_context(self._identity("user-a")):
                self.service.create_deck_entry(self._entry("base-pikachu-58"))
        self.assertEqual(seen, [False])
        self.assertFalse(self.service.connection.in_transaction)


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
