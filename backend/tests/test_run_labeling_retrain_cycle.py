from __future__ import annotations

import sys
import unittest
from pathlib import Path


TESTS_ROOT = Path(__file__).resolve().parent
BACKEND_ROOT = TESTS_ROOT.parent
REPO_ROOT = BACKEND_ROOT.parent

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.run_labeling_retrain_cycle import (  # noqa: E402
    CompletedSession,
    _session_cursor_payload,
    gate_import_issues,
    select_new_sessions,
)


class RunLabelingRetrainCycleTests(unittest.TestCase):
    def test_select_new_sessions_skips_boundary_sessions_at_same_timestamp(self) -> None:
        sessions = [
            CompletedSession("session-a", "2026-04-29T10:00:00Z"),
            CompletedSession("session-b", "2026-04-29T10:00:00Z"),
            CompletedSession("session-c", "2026-04-29T10:00:01Z"),
        ]

        selected = select_new_sessions(
            sessions,
            after_completed_at="2026-04-29T10:00:00Z",
            after_session_ids_at_timestamp={"session-a"},
        )

        self.assertEqual(
            [(session.session_id, session.completed_at) for session in selected],
            [
                ("session-b", "2026-04-29T10:00:00Z"),
                ("session-c", "2026-04-29T10:00:01Z"),
            ],
        )

    def test_select_new_sessions_applies_limit_after_cursor_filter(self) -> None:
        sessions = [
            CompletedSession("session-a", "2026-04-29T10:00:00Z"),
            CompletedSession("session-b", "2026-04-29T10:00:01Z"),
            CompletedSession("session-c", "2026-04-29T10:00:02Z"),
        ]

        selected = select_new_sessions(
            sessions,
            after_completed_at="2026-04-29T09:59:59Z",
            after_session_ids_at_timestamp=set(),
            limit=2,
        )

        self.assertEqual([session.session_id for session in selected], ["session-a", "session-b"])

    def test_session_cursor_payload_keeps_all_boundary_session_ids(self) -> None:
        payload = _session_cursor_payload(
            [
                CompletedSession("session-a", "2026-04-29T10:00:00Z"),
                CompletedSession("session-b", "2026-04-29T10:00:01Z"),
                CompletedSession("session-c", "2026-04-29T10:00:01Z"),
            ]
        )

        self.assertEqual(
            payload,
            {
                "completedAt": "2026-04-29T10:00:01Z",
                "sessionIDsAtTimestamp": ["session-b", "session-c"],
            },
        )

    def test_gate_import_issues_blocks_skipped_manual_review_and_heldout_blocked_rows(self) -> None:
        export_summary = {
            "skippedArtifactCount": 1,
        }
        audit_summary = {
            "unresolvedRowCount": 2,
            "invalidSourcePhotoCount": 1,
            "unreferencedPhotoCount": 1,
            "bucketSummary": {
                "manual_review": {"rows": 3},
                "heldout_blocked": {"rows": 4},
            },
        }

        failures = gate_import_issues(export_summary, audit_summary)

        self.assertEqual(
            failures,
            [
                "Export skipped 1 artifacts.",
                "Batch audit has 2 unresolved rows.",
                "Batch audit found 1 invalid source photos.",
                "Batch audit found 1 unreferenced photos.",
                "Batch audit routed 3 rows to manual_review.",
                "Batch audit routed 4 rows to heldout_blocked.",
            ],
        )


if __name__ == "__main__":
    unittest.main()
