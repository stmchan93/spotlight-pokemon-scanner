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


class ReviewQueueAiLabelTests(unittest.TestCase):
    """review_queue() must surface each item's ai_label (the AI's own pick) so
    reviewers see what the model guessed, while staying backward-compatible with
    older queue files that have no ai_label."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "review.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

        queue_path = Path(self.tempdir.name) / "queue.json"
        queue_path.write_text(
            json.dumps(
                {
                    "queue_id": "test-queue",
                    "bucket": "looty-staging",
                    "items": [
                        {
                            "scan_id": "scan-confident",
                            "object_path": "scans/x/normalized_target.jpg",
                            "predicted": {"card_id": "base1-4", "name": "Charizard"},
                            "candidates": [
                                {"rank": 1, "card_id": "base1-4", "name": "Charizard"}
                            ],
                            "ai_label": {
                                "card_id": "base1-4",
                                "name": "Charizard",
                                "tier": "high",
                                "source": "candidate",
                                "in_top10": True,
                                "rank": 1,
                            },
                        },
                        {
                            "scan_id": "scan-unsure",
                            "object_path": "scans/y/normalized_target.jpg",
                            "predicted": None,
                            "candidates": [],
                            "ai_label": {"disposition": "unsure"},
                        },
                        {
                            "scan_id": "scan-legacy",
                            "object_path": "scans/z/normalized_target.jpg",
                            "predicted": {"card_id": "sv1-1"},
                            "candidates": [],
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )
        # Point the queue resolver at our temp file regardless of queue id.
        self.service._review_queue_path = lambda queue_id: queue_path  # type: ignore[assignment]

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def test_ai_label_passthrough(self) -> None:
        result = self.service.review_queue("test-queue", "reviewer-1", limit=10)
        by_id = {item["scan_id"]: item for item in result["items"]}
        self.assertEqual(result["remaining"], 3)

        confident = by_id["scan-confident"]
        self.assertEqual(confident["ai_label"]["card_id"], "base1-4")
        self.assertEqual(confident["ai_label"]["tier"], "high")
        self.assertTrue(confident["ai_label"]["in_top10"])

        unsure = by_id["scan-unsure"]
        self.assertEqual(unsure["ai_label"], {"disposition": "unsure"})

        # Older queue files without ai_label still return cleanly (None).
        legacy = by_id["scan-legacy"]
        self.assertIsNone(legacy["ai_label"])
        self.assertIn("image_url", legacy)

    def test_labeled_scans_drop_out_and_count_decreases(self) -> None:
        """As cards get labeled the queue shrinks and they don't reappear: a
        confirm removes the scan for EVERYONE; a skip removes it only for the
        reviewer who skipped (others can still take it)."""
        start = self.service.review_queue("test-queue", "r1", limit=10)
        self.assertEqual(start["remaining"], 3)

        # r1 confirms one card -> gone for r1 AND for r2 (confirmed by anyone).
        self.service.record_review_label(
            scan_id="scan-confident",
            reviewer_user_id="r1",
            labeled_card_id="base1-4",
            label_disposition="confirmed",
            selected_rank=1,
            notes=None,
            queue_id="test-queue",
        )
        after_r1 = self.service.review_queue("test-queue", "r1", limit=10)
        self.assertEqual(after_r1["remaining"], 2)
        self.assertNotIn("scan-confident", {i["scan_id"] for i in after_r1["items"]})
        after_r2 = self.service.review_queue("test-queue", "r2", limit=10)
        self.assertEqual(after_r2["remaining"], 2)
        self.assertNotIn("scan-confident", {i["scan_id"] for i in after_r2["items"]})

        # r1 skips another -> gone for r1 only; r2 still sees it.
        self.service.record_review_label(
            scan_id="scan-unsure",
            reviewer_user_id="r1",
            labeled_card_id=None,
            label_disposition="skip",
            selected_rank=None,
            notes=None,
            queue_id="test-queue",
        )
        self.assertEqual(self.service.review_queue("test-queue", "r1", limit=10)["remaining"], 1)
        self.assertEqual(self.service.review_queue("test-queue", "r2", limit=10)["remaining"], 2)


if __name__ == "__main__":
    unittest.main()
