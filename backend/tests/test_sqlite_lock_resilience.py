from __future__ import annotations

import io
import json
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from http import HTTPStatus
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import sqlite_lock_diagnostics  # noqa: E402
from catalog_tools import apply_schema, connect  # noqa: E402
from server import RequestIdentity, SpotlightRequestHandler, SpotlightScanService  # noqa: E402
from sqlite_lock_diagnostics import InstrumentedConnection, check_long_transactions  # noqa: E402


class _LockFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "locks.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.logs: list[dict] = []
        self.service._emit_structured_log = self.logs.append  # type: ignore[method-assign]
        sqlite_lock_diagnostics.set_log_emitter(self.logs.append)
        self.service.connection.execute("PRAGMA busy_timeout = 100")
        self.blocker: sqlite3.Connection | None = None

    def tearDown(self) -> None:
        sqlite_lock_diagnostics.set_log_emitter(None)
        if self.blocker is not None:
            self.blocker.close()
        self.service.connection.close()
        self.tempdir.cleanup()

    def _hold_write_lock(self) -> None:
        self.blocker = sqlite3.connect(str(self.database_path), isolation_level=None)
        self.blocker.execute("BEGIN IMMEDIATE")

    def _release_write_lock(self) -> None:
        assert self.blocker is not None
        self.blocker.execute("ROLLBACK")

    def _events(self, name: str) -> list[dict]:
        return [entry for entry in self.logs if entry.get("event") == name]

    def _scan_row(self, scan_id: str) -> sqlite3.Row | None:
        return self.service.connection.execute(
            "SELECT * FROM scan_events WHERE scan_id = ?", (scan_id,)
        ).fetchone()

    def _wait_for(self, predicate, timeout: float = 15.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.05)
        return False


def _scan_payloads(scan_id: str) -> tuple[dict, dict]:
    request_payload = {"scanID": scan_id, "collectorNumber": "1/1"}
    response_payload = {
        "scanID": scan_id,
        "topCandidates": [{"id": "tst-1"}],
        "confidence": "high",
        "ambiguityFlags": [],
        "matcherSource": "visualHybrid",
        "matcherVersion": "lock-test",
        "resolverMode": "raw_card",
        "resolverPath": "visual",
        "reviewDisposition": "ready",
    }
    return request_payload, response_payload


class ScanEventDeferralTests(_LockFixture):
    def test_locked_db_does_not_fail_scan_and_deferred_write_lands(self) -> None:
        request_payload, response_payload = _scan_payloads("scan-lock-1")
        self._hold_write_lock()

        # Must not raise: the match already succeeded.
        self.service._finalize_scan_response(request_payload, response_payload, [])  # noqa: SLF001

        self.assertIn("backendTimingDebug", response_payload)
        deferred = self._events("scan_event_persist_deferred")
        self.assertEqual(len(deferred), 1)
        self.assertEqual(deferred[0]["scanID"], "scan-lock-1")
        self.assertTrue(self._events("sqlite_write_locked"))
        self.assertIsNone(self._scan_row("scan-lock-1"))

        self._release_write_lock()
        self.assertTrue(self._wait_for(lambda: bool(self._events("scan_event_persist_recovered"))))
        row = self._scan_row("scan-lock-1")
        assert row is not None
        self.assertEqual(row["matcher_source"], "visualHybrid")
        self.assertEqual(row["predicted_card_id"], "tst-1")
        self.assertIsNone(row["selected_card_id"])
        self.assertEqual(self.service._deferred_scan_events, {})  # noqa: SLF001

    def test_feedback_flushes_deferred_event_first_and_keeps_selection(self) -> None:
        request_payload, response_payload = _scan_payloads("scan-lock-2")
        self._hold_write_lock()
        # Hold the worker off so the feedback path does the flush.
        self.service._deferred_scan_events_write_lock.acquire()  # noqa: SLF001
        try:
            self.service._finalize_scan_response(request_payload, response_payload, [])  # noqa: SLF001
            self._release_write_lock()
        finally:
            self.service._deferred_scan_events_write_lock.release()  # noqa: SLF001

        self.service.log_feedback(
            {
                "scanID": "scan-lock-2",
                "selectedCardID": "tst-2",
                "wasTopPrediction": False,
                "correctionType": "wrong_card",
                "submittedAt": "2026-10-24T20:50:00Z",
            }
        )
        # Give a racing worker pass time to (wrongly) clobber, then check.
        time.sleep(0.3)
        row = self._scan_row("scan-lock-2")
        assert row is not None
        self.assertEqual(row["matcher_source"], "visualHybrid")
        self.assertEqual(row["predicted_card_id"], "tst-1")
        self.assertEqual(row["selected_card_id"], "tst-2")
        self.assertEqual(row["correction_type"], "wrong_card")
        self.assertEqual(self.service._deferred_scan_events, {})  # noqa: SLF001


class ScanArtifactsLockTests(_LockFixture):
    def _handler(self, path: str) -> tuple[SpotlightRequestHandler, dict]:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.command = "POST"
        handler.service = self.service
        handler.request_version = "HTTP/1.1"
        handler.wfile = io.BytesIO()
        sent: dict = {"headers": {}}

        def send_response(code, message=None):
            sent["status"] = code

        handler.send_response = send_response  # type: ignore[method-assign]
        handler.send_header = lambda key, value: sent["headers"].__setitem__(key, value)  # type: ignore[method-assign]
        handler.end_headers = lambda: None  # type: ignore[method-assign]
        handler._require_request_identity = lambda: RequestIdentity(user_id="lock-user", auth_source="test")  # type: ignore[method-assign]
        return handler, sent

    def test_scan_artifacts_lock_returns_retryable_503(self) -> None:
        handler, sent = self._handler("/api/v1/scan-artifacts")
        handler._read_json_body = lambda: {"scanID": "scan-lock-art"}  # type: ignore[method-assign]
        self._hold_write_lock()

        handler.do_POST()

        self.assertEqual(sent["status"], HTTPStatus.SERVICE_UNAVAILABLE.value)
        self.assertEqual(sent["headers"].get("Retry-After"), "5")
        body = json.loads(handler.wfile.getvalue())
        self.assertTrue(body["retryable"])
        self.assertEqual(body["errorCode"], "database_busy")
        self.assertTrue(self._events("scan_artifacts_db_locked"))

    def test_generic_500_from_lock_error_becomes_503(self) -> None:
        handler, sent = self._handler("/api/v1/anything")
        try:
            raise sqlite3.OperationalError("database is locked")
        except sqlite3.OperationalError:
            handler._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Thing failed: database is locked"})
        self.assertEqual(sent["status"], HTTPStatus.SERVICE_UNAVAILABLE.value)
        self.assertEqual(sent["headers"].get("Retry-After"), "5")
        self.assertEqual(json.loads(handler.wfile.getvalue())["detail"], "Thing failed: database is locked")

    def test_non_lock_500_is_unchanged(self) -> None:
        handler, sent = self._handler("/api/v1/anything")
        handler._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "boom"})
        self.assertEqual(sent["status"], HTTPStatus.INTERNAL_SERVER_ERROR.value)
        self.assertNotIn("Retry-After", sent["headers"])


class LongTransactionWatchdogTests(_LockFixture):
    def test_watchdog_reports_long_open_write_transaction_with_stack(self) -> None:
        opened = threading.Event()
        release = threading.Event()

        def hold_transaction_open() -> None:
            connection = connect(self.database_path, factory=InstrumentedConnection)
            connection.execute(
                "INSERT INTO user_emails (user_id, email, updated_at) VALUES ('u', 'e@x', 'now')"
            )
            opened.set()
            release.wait(10)
            connection.commit()
            connection.close()

        holder = threading.Thread(target=hold_transaction_open, name="long-tx-holder")
        holder.start()
        try:
            self.assertTrue(opened.wait(5))
            time.sleep(0.1)
            reports = check_long_transactions(threshold_seconds=0.05)
        finally:
            release.set()
            holder.join(10)

        mine = [report for report in reports if report["thread"] == "long-tx-holder"]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["event"], "sqlite_long_transaction")
        self.assertGreaterEqual(mine[0]["ageSeconds"], 0.1)
        self.assertTrue(any("hold_transaction_open" in line for line in mine[0]["stack"]))
        self.assertIn(mine[0], self._events("sqlite_long_transaction"))

    def test_watchdog_ignores_committed_connections(self) -> None:
        self.service.connection.execute(
            "INSERT INTO user_emails (user_id, email, updated_at) VALUES ('u2', 'e@x', 'now')"
        )
        self.service.connection.commit()
        reports = check_long_transactions(threshold_seconds=0.0)
        self.assertFalse([r for r in reports if r["thread"] == threading.current_thread().name])


if __name__ == "__main__":
    unittest.main()
