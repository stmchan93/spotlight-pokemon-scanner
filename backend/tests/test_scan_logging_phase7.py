from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class ScanLoggingPhase7Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "phase7.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()

        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def test_log_scan_writes_scan_events_only(self) -> None:
        request_payload = {
            "scanID": "scan-phase7-1",
            "collectorNumber": "223/197",
            "setHintTokens": ["obf"],
        }
        response_payload = {
            "scanID": "scan-phase7-1",
            "topCandidates": [],
            "confidence": "medium",
            "ambiguityFlags": [],
            "matcherSource": "remoteHybrid",
            "matcherVersion": "phase7-test",
            "resolverMode": "raw_card",
            "resolverPath": "visual_fallback",
            "reviewDisposition": "ready",
            "reviewReason": None,
        }
        top_candidates = [
            {
                "candidate": {"id": "obf-223"},
                "retrievalScore": 0.61,
                "rerankScore": 0.74,
                "finalScore": 0.82,
                "reasons": ["title_overlap", "collector_exact"],
            }
        ]

        self.service._log_scan(request_payload, response_payload, top_candidates)  # noqa: SLF001

        row = self.service.connection.execute(
            """
            SELECT request_json, response_json, selected_card_id, confidence, review_disposition
            FROM scan_events
            WHERE scan_id = ?
            LIMIT 1
            """,
            ("scan-phase7-1",),
        ).fetchone()
        legacy_tables = {
            row["name"]
            for row in self.service.connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'scan_candidates'
                """
            ).fetchall()
        }

        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(json.loads(row["request_json"])["collectorNumber"], "223/197")
        self.assertEqual(json.loads(row["response_json"])["resolverMode"], "raw_card")
        self.assertEqual(row["selected_card_id"], "obf-223")
        self.assertEqual(row["confidence"], "medium")
        self.assertEqual(row["review_disposition"], "ready")
        self.assertEqual(legacy_tables, set())

    def test_log_feedback_updates_scan_event_without_clobbering_request_response(self) -> None:
        request_payload = {
            "scanID": "scan-phase7-2",
            "collectorNumber": "60/132",
            "setHintTokens": ["gym1"],
        }
        response_payload = {
            "scanID": "scan-phase7-2",
            "topCandidates": [],
            "confidence": "low",
            "ambiguityFlags": ["Top matches are close together"],
            "matcherSource": "remoteHybrid",
            "matcherVersion": "phase7-test",
            "resolverMode": "raw_card",
            "resolverPath": "visual_fallback",
            "reviewDisposition": "needs_review",
            "reviewReason": "Scan needs review before using the price.",
        }

        self.service._log_scan(request_payload, response_payload, [])  # noqa: SLF001
        self.service.log_feedback(
            {
                "scanID": "scan-phase7-2",
                "selectedCardID": "gym1-60",
                "wasTopPrediction": False,
                "correctionType": "wrong_card",
                "submittedAt": "2026-04-09T05:30:00Z",
            }
        )

        row = self.service.connection.execute(
            """
            SELECT
                request_json,
                response_json,
                selected_card_id,
                correction_type,
                completed_at
            FROM scan_events
            WHERE scan_id = ?
            LIMIT 1
            """,
            ("scan-phase7-2",),
        ).fetchone()
        legacy_tables = {
            row["name"]
            for row in self.service.connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'scan_feedback'
                """
            ).fetchall()
        }

        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(json.loads(row["request_json"])["collectorNumber"], "60/132")
        self.assertEqual(json.loads(row["response_json"])["resolverPath"], "visual_fallback")
        self.assertEqual(row["selected_card_id"], "gym1-60")
        self.assertEqual(row["correction_type"], "wrong_card")
        self.assertEqual(row["completed_at"], "2026-04-09T05:30:00Z")
        self.assertEqual(legacy_tables, set())

    def test_unmatched_scans_still_uses_scan_events(self) -> None:
        request_payload = {
            "scanID": "scan-phase7-3",
            "collectorNumber": "130/094",
            "setHintTokens": ["pfl"],
        }
        response_payload = {
            "scanID": "scan-phase7-3",
            "topCandidates": [],
            "confidence": "low",
            "ambiguityFlags": [],
            "matcherSource": "remoteHybrid",
            "matcherVersion": "phase7-test",
            "resolverMode": "raw_card",
            "resolverPath": "visual_fallback",
            "reviewDisposition": "unsupported",
            "reviewReason": "Set/number clues do not line up with a supported Pokemon card.",
        }

        self.service._log_scan(request_payload, response_payload, [])  # noqa: SLF001

        summary = self.service.unmatched_scans(limit=10)

        self.assertEqual(summary["summary"]["openReviewCount"], 1)
        self.assertEqual(summary["summary"]["likelyUnsupportedCount"], 1)
        self.assertEqual(summary["items"][0]["scanID"], "scan-phase7-3")
        self.assertEqual(summary["items"][0]["reviewDisposition"], "unsupported")


if __name__ == "__main__":
    unittest.main()
