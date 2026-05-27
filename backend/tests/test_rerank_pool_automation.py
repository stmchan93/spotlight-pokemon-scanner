from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
TOOLS_ROOT = REPO_ROOT / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

import rerank_pool_promote as promote  # noqa: E402


# A representative chunk of eval_rerank_with_user_photos.py stdout. The column
# format is fixed-width: "  {alpha:6.2f} {threshold:7.3f}  {n:>3}/{total:<3}    ...".
SAMPLE_EVAL_STDOUT = """\
user-photo cards available for rerank: 86
total user photos in pool: 382
encoder ready on mps
curation ON: {'maxExemplarsPerCard': 12, 'centroidCosFloor': 0.8}

leave-one-out queries: 60

  shortlist-K=50, queries=60, photos in pool=382
   alpha  thresh       top-1       top-5      top-10  median_rank
  ------ -------  ----------  ----------  ----------  -----------
    0.00   0.800   40/60       52/60       58/60       1
    0.10   0.800   45/60       54/60       59/60       1
    0.25   0.800   44/60       54/60       59/60       1
"""


class DecidePromotionTests(unittest.TestCase):
    def test_promote_when_both_metrics_hold(self) -> None:
        decision = promote.decide_promotion(45, 30, 44, 30)
        self.assertTrue(decision.promote)
        self.assertIn("PROMOTE", decision.reason)

    def test_promote_on_ties(self) -> None:
        decision = promote.decide_promotion(44, 30, 44, 30)
        self.assertTrue(decision.promote)

    def test_rollback_when_leave_one_out_regresses(self) -> None:
        decision = promote.decide_promotion(43, 31, 44, 30)
        self.assertFalse(decision.promote)
        self.assertIn("leave_one_out", decision.reason)
        self.assertIn("ROLLBACK", decision.reason)

    def test_rollback_when_holdout_regresses(self) -> None:
        decision = promote.decide_promotion(45, 29, 44, 30)
        self.assertFalse(decision.promote)
        self.assertIn("holdout", decision.reason)

    def test_rollback_when_both_regress_lists_both(self) -> None:
        decision = promote.decide_promotion(40, 25, 44, 30)
        self.assertFalse(decision.promote)
        self.assertIn("leave_one_out", decision.reason)
        self.assertIn("holdout", decision.reason)

    def test_decision_as_dict_round_trips_numbers(self) -> None:
        decision = promote.decide_promotion(45, 30, 44, 30)
        payload = decision.as_dict()
        self.assertEqual(payload["newLeaveOneOutTop1"], 45)
        self.assertEqual(payload["newHoldoutTop1"], 30)
        self.assertEqual(payload["knownGoodLeaveOneOutTop1"], 44)
        self.assertEqual(payload["knownGoodHoldoutTop1"], 30)
        self.assertTrue(payload["promote"])


class KnownGoodMarkerTests(unittest.TestCase):
    def test_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rerank_pool_known_good.json"
            marker = promote.KnownGoodMarker(
                version="20260527",
                leaveOneOutTop1=45,
                holdoutTop1=30,
                promotedAt="2026-05-27T00:00:00Z",
            )
            promote.write_known_good(marker, path)
            loaded = promote.read_known_good(path)
            self.assertIsNotNone(loaded)
            assert loaded is not None
            self.assertEqual(loaded.version, "20260527")
            self.assertEqual(loaded.leaveOneOutTop1, 45)
            self.assertEqual(loaded.holdoutTop1, 30)
            self.assertEqual(loaded.promotedAt, "2026-05-27T00:00:00Z")

    def test_read_missing_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "absent.json"
            self.assertIsNone(promote.read_known_good(path))

    def test_write_creates_parent_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "dir" / "marker.json"
            marker = promote.KnownGoodMarker("v1", 1, 2, "2026-05-27T00:00:00Z")
            promote.write_known_good(marker, path)
            self.assertTrue(path.exists())


class WatermarkTests(unittest.TestCase):
    def test_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rerank_pool_watermark.txt"
            promote.write_watermark("2026-05-27T12:00:00Z", path)
            self.assertEqual(promote.read_watermark(path), "2026-05-27T12:00:00Z")

    def test_read_missing_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(promote.read_watermark(Path(tmp) / "absent.txt"))

    def test_write_strips_and_newline_terminates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "wm.txt"
            promote.write_watermark("  2026-05-27T12:00:00Z  ", path)
            self.assertEqual(path.read_text(), "2026-05-27T12:00:00Z\n")


class ParseEvalTop1Tests(unittest.TestCase):
    def test_parses_top1_at_alpha_threshold(self) -> None:
        top1 = promote.parse_eval_top1(SAMPLE_EVAL_STDOUT, alpha=0.1, threshold=0.8)
        self.assertEqual(top1, 45)

    def test_parses_baseline_alpha_zero(self) -> None:
        top1 = promote.parse_eval_top1(SAMPLE_EVAL_STDOUT, alpha=0.0, threshold=0.8)
        self.assertEqual(top1, 40)

    def test_does_not_confuse_separator_or_header_rows(self) -> None:
        # The header/separator lines must not be parsed as data rows.
        top1 = promote.parse_eval_top1(SAMPLE_EVAL_STDOUT, alpha=0.25, threshold=0.8)
        self.assertEqual(top1, 44)

    def test_missing_row_raises(self) -> None:
        with self.assertRaises(ValueError):
            promote.parse_eval_top1(SAMPLE_EVAL_STDOUT, alpha=0.9, threshold=0.8)

    def test_tolerant_to_float_formatting(self) -> None:
        # alpha 0.1 should match the printed "0.10" row within tolerance.
        top1 = promote.parse_eval_top1(SAMPLE_EVAL_STDOUT, alpha=0.100001, threshold=0.800001)
        self.assertEqual(top1, 45)


class CurationDroppedOutlierIndicesTests(unittest.TestCase):
    def test_outlier_indices_surfaced(self) -> None:
        import numpy as np

        from rerank_pool_curation import CurationParams, curate_card_embeddings

        # 4 tightly clustered rows + 1 obvious far-from-centroid outlier.
        base = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        cluster = np.tile(base, (4, 1)) + np.random.RandomState(0).normal(0, 0.01, (4, 3))
        outlier = np.array([0.0, 1.0, 0.0], dtype=np.float32)
        emb = np.vstack([cluster, outlier]).astype(np.float32)
        params = CurationParams(centroid_cos_floor=0.8, with_prototype=False)
        _rows, _kinds, stats = curate_card_embeddings(emb, params)
        self.assertEqual(stats.droppedOutliers, 1)
        self.assertEqual(stats.droppedOutlierIndices, [4])


if __name__ == "__main__":
    unittest.main()
