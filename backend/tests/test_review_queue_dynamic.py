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
from server import REVIEW_DYNAMIC_QUEUE_ID, SpotlightScanService  # noqa: E402


class ReviewQueueDynamicTests(unittest.TestCase):
    """The live "all" queue is built directly from the scan DB (no queue file):
    raw scans with a usable normalized artifact, from REVIEW_DYNAMIC_SINCE
    onward, that nobody has confirmed and this reviewer hasn't dispositioned —
    served oldest-first, with the model's top-1 surfaced as the AI suggestion."""

    SINCE = "2026-05-19"

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "review.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        for card_id, name, number in (
            ("base1-4", "Charizard", "4/102"),
            ("base1-2", "Blastoise", "2/102"),
            ("base1-15", "Venusaur", "15/102"),
        ):
            upsert_card(
                self.service.connection,
                card_id=card_id,
                name=name,
                set_name="Base",
                number=number,
                rarity="Rare Holo",
                variant="",
                language="en",
                image_small_url=f"https://img.example/{card_id}-small.png",
            )
        self.service.connection.commit()

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _seed_scan(
        self,
        scan_id: str,
        *,
        created_at: str,
        resolver_mode: str = "raw_card",
        predicted_card_id: str | None = "base1-4",
        confirmed_card_id: str | None = None,
        normalized_object_path: str | None = None,
        upload_status: str = "uploaded",
        candidates: list[tuple[int, str]] | None = None,
    ) -> None:
        conn = self.service.connection
        conn.execute(
            "INSERT INTO scan_events (scan_id, created_at, resolver_mode, request_json, "
            "response_json, predicted_card_id, confirmed_card_id) VALUES (?,?,?,?,?,?,?)",
            (scan_id, created_at, resolver_mode, "{}", "{}", predicted_card_id, confirmed_card_id),
        )
        path = (
            normalized_object_path
            if normalized_object_path is not None
            else f"scans/2026/05/20/{scan_id}/normalized_target.jpg"
        )
        conn.execute(
            "INSERT INTO scan_artifacts (scan_id, normalized_object_path, upload_status, "
            "artifact_version, created_at) VALUES (?,?,?,?,?)",
            (scan_id, path, upload_status, "v1", created_at),
        )
        for rank, card_id in candidates or []:
            conn.execute(
                "INSERT INTO scan_prediction_candidates (scan_id, rank, card_id, candidate_json) "
                "VALUES (?,?,?,?)",
                (scan_id, rank, card_id, json.dumps({"card_id": card_id, "rank": rank})),
            )
        conn.commit()

    def test_windows_mode_limits_queue_to_configured_show_weekends(self) -> None:
        """With SPOTLIGHT_REVIEW_WINDOWS set, only scans inside a window are
        reviewable — everything between/around the shows disappears."""
        import server as server_module

        self._seed_scan("scan-honolulu", created_at="2026-06-20T18:00:00Z")
        self._seed_scan("scan-pomona", created_at="2026-07-12T20:00:00Z")
        self._seed_scan("scan-ontario", created_at="2026-08-23T01:00:00Z")
        # Outside every window: between shows, and just past a window's end.
        self._seed_scan("scan-between", created_at="2026-07-20T12:00:00Z")
        self._seed_scan("scan-after-hnl", created_at="2026-06-22T10:00:01Z")

        original = server_module.REVIEW_DYNAMIC_WINDOWS
        server_module.REVIEW_DYNAMIC_WINDOWS = server_module._parse_review_windows(
            "2026-06-20T10:00:00..2026-06-22T10:00:00,"
            "2026-07-12T07:00:00..2026-07-13T07:00:00,"
            "2026-08-22T07:00:00..2026-08-24T07:00:00"
        )
        try:
            payload = self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "reviewer-1", limit=30, mode="pending")
        finally:
            server_module.REVIEW_DYNAMIC_WINDOWS = original
        scan_ids = [item["scan_id"] for item in payload["items"]]
        self.assertEqual(scan_ids, ["scan-honolulu", "scan-pomona", "scan-ontario"])

    def test_malformed_window_entries_are_ignored(self) -> None:
        import server as server_module

        self.assertEqual(
            server_module._parse_review_windows("2026-06-20..2026-06-22, nonsense ,..broken"),
            [("2026-06-20", "2026-06-22")],
        )

    def test_only_pending_raw_scans_since_cutoff_oldest_first(self) -> None:
        # Three eligible raw scans across May 20 -> June 1 (out of order on insert).
        self._seed_scan("scan-jun", created_at="2026-06-01T10:00:00Z")
        self._seed_scan("scan-may20", created_at="2026-05-20T08:00:00Z")
        self._seed_scan("scan-may25", created_at="2026-05-25T09:00:00Z")
        # Excluded: before the cutoff.
        self._seed_scan("scan-old", created_at="2026-05-10T08:00:00Z")
        # Excluded: not a raw scan (slab lane).
        self._seed_scan("scan-slab", created_at="2026-05-22T08:00:00Z", resolver_mode="slab")
        # Excluded: already confirmed by add-to-deck.
        self._seed_scan(
            "scan-confirmed", created_at="2026-05-21T08:00:00Z", confirmed_card_id="base1-2"
        )
        # Excluded: no usable artifact (upload failed, no normalized path).
        self._seed_scan(
            "scan-noart",
            created_at="2026-05-23T08:00:00Z",
            normalized_object_path=None,
            upload_status="failed",
        )

        result = self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r1", limit=10)
        ids = [i["scan_id"] for i in result["items"]]
        self.assertEqual(ids, ["scan-may20", "scan-may25", "scan-jun"])
        self.assertEqual(result["remaining"], 3)

    def test_ai_label_is_model_top1_and_candidates_resolve(self) -> None:
        self._seed_scan(
            "scan-a",
            created_at="2026-05-20T08:00:00Z",
            predicted_card_id="base1-4",
            candidates=[(1, "base1-4"), (2, "base1-2"), (3, "base1-15")],
        )
        result = self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r1", limit=10)
        item = result["items"][0]
        # AI suggestion is the model's top-1, enriched with the catalog thumbnail.
        self.assertEqual(item["ai_label"]["card_id"], "base1-4")
        self.assertEqual(item["ai_label"]["name"], "Charizard")
        self.assertEqual(item["ai_label"]["image"], "https://img.example/base1-4-small.png")
        self.assertEqual(item["predicted"]["card_id"], "base1-4")
        # Top-10 candidates resolve to names + thumbnails, in rank order.
        self.assertEqual([c["card_id"] for c in item["candidates"]], ["base1-4", "base1-2", "base1-15"])
        self.assertEqual(item["candidates"][1]["name"], "Blastoise")
        self.assertEqual(item["candidates"][2]["image"], "https://img.example/base1-15-small.png")
        # Image is proxied through the authed review endpoint, never a public URL.
        self.assertEqual(item["image_url"], "/api/v1/review/image/scan-a?queue=all")

    def test_confirm_removes_for_everyone_skip_only_for_reviewer(self) -> None:
        self._seed_scan("scan-x", created_at="2026-05-20T08:00:00Z")
        self._seed_scan("scan-y", created_at="2026-05-21T08:00:00Z")
        self.assertEqual(
            self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r1", limit=10)["remaining"], 2
        )

        # r1 confirms scan-x -> gone for r1 AND r2.
        self.service.record_review_label(
            scan_id="scan-x",
            reviewer_user_id="r1",
            labeled_card_id="base1-4",
            label_disposition="confirmed",
            selected_rank=1,
            notes=None,
            queue_id=REVIEW_DYNAMIC_QUEUE_ID,
        )
        self.assertEqual(
            {i["scan_id"] for i in self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r1", limit=10)["items"]},
            {"scan-y"},
        )
        self.assertEqual(
            {i["scan_id"] for i in self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r2", limit=10)["items"]},
            {"scan-y"},
        )

        # r1 skips scan-y -> gone for r1 only; r2 still sees it.
        self.service.record_review_label(
            scan_id="scan-y",
            reviewer_user_id="r1",
            labeled_card_id=None,
            label_disposition="skip",
            selected_rank=None,
            notes=None,
            queue_id=REVIEW_DYNAMIC_QUEUE_ID,
        )
        self.assertEqual(
            self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r1", limit=10)["remaining"], 0
        )
        self.assertEqual(
            {i["scan_id"] for i in self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r2", limit=10)["items"]},
            {"scan-y"},
        )

    def test_revisit_mode_resurfaces_only_reviewers_skip_unclear(self) -> None:
        self._seed_scan("scan-skip", created_at="2026-05-20T08:00:00Z")
        self._seed_scan("scan-unclear", created_at="2026-05-21T08:00:00Z")
        self._seed_scan("scan-fresh", created_at="2026-05-22T08:00:00Z")
        for scan_id, disposition in (("scan-skip", "skip"), ("scan-unclear", "unclear")):
            self.service.record_review_label(
                scan_id=scan_id,
                reviewer_user_id="r1",
                labeled_card_id=None,
                label_disposition=disposition,
                selected_rank=None,
                notes=None,
                queue_id=REVIEW_DYNAMIC_QUEUE_ID,
            )

        # Default queue: only the never-seen card remains for r1.
        default_queue = self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r1", limit=10)
        self.assertEqual({i["scan_id"] for i in default_queue["items"]}, {"scan-fresh"})

        # Revisit: r1's skip + unclear pile comes back, each tagged with its prior
        # disposition; the fresh (never-dispositioned) card is NOT in revisit.
        revisit = self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r1", limit=10, mode="revisit")
        by_id = {i["scan_id"]: i for i in revisit["items"]}
        self.assertEqual(set(by_id), {"scan-skip", "scan-unclear"})
        self.assertEqual(by_id["scan-skip"]["prior_disposition"], "skip")
        self.assertEqual(by_id["scan-unclear"]["prior_disposition"], "unclear")

        # r2 has no revisit pile.
        self.assertEqual(
            self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r2", limit=10, mode="revisit")["remaining"],
            0,
        )

    def test_slab_disposition_removes_for_everyone_without_a_raw_label(self) -> None:
        """A slab that slipped into the raw queue can be marked not_a_raw_card:
        like a confirm it drops the scan for EVERY reviewer, but it stores no
        raw card_id so it can't poison the raw training corpus."""
        self._seed_scan("scan-slab", created_at="2026-05-20T08:00:00Z")
        self._seed_scan("scan-real", created_at="2026-05-21T08:00:00Z")

        self.service.record_review_label(
            scan_id="scan-slab",
            reviewer_user_id="r1",
            labeled_card_id=None,
            label_disposition="not_a_raw_card",
            selected_rank=None,
            notes=None,
            queue_id=REVIEW_DYNAMIC_QUEUE_ID,
        )

        # Gone for the reviewer who flagged it AND for everyone else.
        for reviewer in ("r1", "r2"):
            ids = {
                i["scan_id"]
                for i in self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, reviewer, limit=10)["items"]
            }
            self.assertEqual(ids, {"scan-real"})

        # It does not come back in revisit mode (it's a terminal disposition,
        # not a skip/unclear), and no raw card_id was recorded.
        self.assertEqual(
            self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r1", limit=10, mode="revisit")["remaining"],
            0,
        )
        row = self.service.connection.execute(
            "SELECT labeled_card_id, label_disposition FROM scan_labeling_reviews "
            "WHERE scan_id = 'scan-slab'"
        ).fetchone()
        self.assertIsNone(row["labeled_card_id"])
        self.assertEqual(row["label_disposition"], "not_a_raw_card")

    def test_limit_pages_but_remaining_counts_all(self) -> None:
        for day in range(20, 25):
            self._seed_scan(f"scan-{day}", created_at=f"2026-05-{day}T08:00:00Z")
        result = self.service.review_queue(REVIEW_DYNAMIC_QUEUE_ID, "r1", limit=2)
        self.assertEqual([i["scan_id"] for i in result["items"]], ["scan-20", "scan-21"])
        # remaining reflects the whole pending pool, not just the page.
        self.assertEqual(result["remaining"], 5)

    def test_image_object_path_reads_from_scan_artifacts(self) -> None:
        self._seed_scan(
            "scan-img",
            created_at="2026-05-20T08:00:00Z",
            normalized_object_path="scans/2026/05/20/scan-img/normalized_target.jpg",
        )
        self.assertEqual(
            self.service.review_image_object_path(REVIEW_DYNAMIC_QUEUE_ID, "scan-img"),
            "scans/2026/05/20/scan-img/normalized_target.jpg",
        )
        self.assertIsNone(self.service.review_image_object_path(REVIEW_DYNAMIC_QUEUE_ID, "missing"))


if __name__ == "__main__":
    unittest.main()
