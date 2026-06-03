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

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
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
        upsert_card(
            self.service.connection,
            card_id="base1-4",
            name="Charizard",
            set_name="Base",
            number="4/102",
            rarity="Rare Holo",
            variant="",
            language="en",
            image_small_url="https://img.example/base1-4-small.png",
        )
        self.service.connection.commit()

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
        # Catalog thumbnails are attached to the candidate + the AI pick so
        # reviewers can eyeball the art.
        self.assertEqual(
            confident["candidates"][0]["image"], "https://img.example/base1-4-small.png"
        )
        self.assertEqual(confident["ai_label"]["image"], "https://img.example/base1-4-small.png")

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

    def test_finishes_surface_and_chosen_variant_is_stored(self) -> None:
        """A card with multiple Scrydex finishes exposes a finish list on its
        candidate + AI pick, and the reviewer's chosen finish is persisted."""
        self.service.connection.execute(
            "UPDATE cards SET source_payload_json = ? WHERE id = 'base1-4'",
            (
                json.dumps(
                    {
                        "variants": [
                            {"name": "normal", "prices": [{"type": "raw", "market": 0.07}]},
                            {"name": "reverseHolofoil", "prices": [{"type": "raw", "market": 0.08}]},
                            {"name": "pokeBallReverseHolofoil", "prices": [{"type": "raw", "market": 0.27}]},
                            {"name": "masterBallReverseHolofoil", "prices": [{"type": "raw", "market": 2.61}]},
                        ]
                    }
                ),
            ),
        )
        self.service.connection.commit()

        result = self.service.review_queue("test-queue", "r-finish", limit=10)
        confident = next(i for i in result["items"] if i["scan_id"] == "scan-confident")
        finishes = confident["candidates"][0]["finishes"]
        labels = {f["label"] for f in finishes}
        self.assertEqual(len(finishes), 4)
        self.assertIn("Poké Ball pattern", labels)
        self.assertIn("Master Ball pattern", labels)
        # AI pick carries finishes too.
        self.assertEqual(len(confident["ai_label"]["finishes"]), 4)

        self.service.record_review_label(
            scan_id="scan-confident",
            reviewer_user_id="r-finish",
            labeled_card_id="base1-4",
            label_disposition="confirmed",
            selected_rank=1,
            notes=None,
            queue_id="test-queue",
            labeled_variant="pokeBallReverseHolofoil",
        )
        row = self.service.connection.execute(
            "SELECT labeled_variant FROM scan_labeling_reviews "
            "WHERE scan_id = 'scan-confident' AND reviewer_user_id = 'r-finish'"
        ).fetchone()
        self.assertEqual(row["labeled_variant"], "pokeBallReverseHolofoil")

    def test_revisit_mode_resurfaces_skipped_and_unclear(self) -> None:
        """Skip/unclear cards vanish from the default (new-cards) queue but come
        back in revisit mode so the reviewer can take another look, carrying
        their prior disposition. A confirmed card never returns."""
        # r1 skips one, marks another unclear, confirms the third.
        self.service.record_review_label(
            scan_id="scan-confident",
            reviewer_user_id="r1",
            labeled_card_id="base1-4",
            label_disposition="confirmed",
            selected_rank=1,
            notes=None,
            queue_id="test-queue",
        )
        self.service.record_review_label(
            scan_id="scan-unsure",
            reviewer_user_id="r1",
            labeled_card_id=None,
            label_disposition="skip",
            selected_rank=None,
            notes=None,
            queue_id="test-queue",
        )
        self.service.record_review_label(
            scan_id="scan-legacy",
            reviewer_user_id="r1",
            labeled_card_id=None,
            label_disposition="unclear",
            selected_rank=None,
            notes=None,
            queue_id="test-queue",
        )

        # Default queue is now empty for r1 (everything is seen).
        default_queue = self.service.review_queue("test-queue", "r1", limit=10)
        self.assertEqual(default_queue["remaining"], 0)
        self.assertEqual(default_queue["mode"], "pending")

        # Revisit mode brings back only the skip + unclear cards (not confirmed).
        revisit = self.service.review_queue("test-queue", "r1", limit=10, mode="revisit")
        self.assertEqual(revisit["mode"], "revisit")
        by_id = {i["scan_id"]: i for i in revisit["items"]}
        self.assertEqual(set(by_id), {"scan-unsure", "scan-legacy"})
        self.assertEqual(by_id["scan-unsure"]["prior_disposition"], "skip")
        self.assertEqual(by_id["scan-legacy"]["prior_disposition"], "unclear")

        # Re-reviewing a skipped card as confirmed drops it from the revisit pool
        # and the remaining count reflects the revisit mode, not the new queue.
        result = self.service.record_review_label(
            scan_id="scan-unsure",
            reviewer_user_id="r1",
            labeled_card_id="base1-4",
            label_disposition="confirmed",
            selected_rank=1,
            notes=None,
            queue_id="test-queue",
            mode="revisit",
        )
        self.assertEqual(result["remaining"], 1)
        revisit_after = self.service.review_queue("test-queue", "r1", limit=10, mode="revisit")
        self.assertEqual({i["scan_id"] for i in revisit_after["items"]}, {"scan-legacy"})

        # Another reviewer's revisit pool is independent (empty here).
        self.assertEqual(
            self.service.review_queue("test-queue", "r2", limit=10, mode="revisit")["remaining"],
            0,
        )


if __name__ == "__main__":
    unittest.main()
