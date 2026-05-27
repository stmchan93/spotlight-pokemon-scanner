from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1].parent
TOOLS_ROOT = REPO_ROOT / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from rerank_pool_curation import (  # noqa: E402
    EXEMPLAR_KIND,
    PROTOTYPE_KIND,
    CurationParams,
    curate_card_embeddings,
)


def _unit(vec: list[float]) -> np.ndarray:
    v = np.asarray(vec, dtype=np.float32)
    return v / np.linalg.norm(v)


def _cluster(center: np.ndarray, n: int, jitter: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    rows = center[None, :] + jitter * rng.standard_normal((n, center.shape[0])).astype(np.float32)
    norms = np.linalg.norm(rows, axis=1, keepdims=True)
    return (rows / norms).astype(np.float32)


class CurateCardEmbeddingsTests(unittest.TestCase):
    def test_empty_input_returns_empty(self) -> None:
        rows, kinds, stats = curate_card_embeddings(np.zeros((0, 8), dtype=np.float32))
        self.assertEqual(rows.shape[0], 0)
        self.assertEqual(kinds, [])
        self.assertEqual(stats.inputCount, 0)

    def test_single_exemplar_no_prototype(self) -> None:
        e = _unit([1, 0, 0, 0])
        rows, kinds, stats = curate_card_embeddings(e)
        self.assertEqual(rows.shape[0], 1)
        self.assertEqual(kinds, [EXEMPLAR_KIND])
        self.assertFalse(stats.prototypeAdded)

    def test_two_exemplars_below_gate_keep_both_plus_prototype(self) -> None:
        rows_in = _cluster(_unit([1, 1, 0, 0]), n=2, jitter=0.02, seed=1)
        rows, kinds, stats = curate_card_embeddings(rows_in)
        # n < MIN_FOR_GATE -> no outlier dropping
        self.assertEqual(stats.droppedOutliers, 0)
        self.assertTrue(stats.prototypeAdded)
        self.assertEqual(rows.shape[0], 3)  # 2 exemplars + prototype
        self.assertEqual(kinds[-1], PROTOTYPE_KIND)
        self.assertEqual(kinds[:2], [EXEMPLAR_KIND, EXEMPLAR_KIND])

    def test_outlier_is_dropped(self) -> None:
        tight = _cluster(_unit([1, 0, 0, 0]), n=6, jitter=0.01, seed=2)
        outlier = _unit([0, 0, 1, 0])[None, :]  # orthogonal -> far from centroid
        rows_in = np.concatenate([tight, outlier], axis=0)
        rows, kinds, stats = curate_card_embeddings(rows_in)
        self.assertGreaterEqual(stats.droppedOutliers, 1)
        # The orthogonal outlier must not survive as a kept exemplar.
        exemplar_rows = rows[[k == EXEMPLAR_KIND for k in kinds]]
        sims_to_outlier = exemplar_rows @ outlier[0]
        self.assertTrue(np.all(sims_to_outlier < 0.5))

    def test_cap_limits_exemplars(self) -> None:
        rows_in = _cluster(_unit([1, 1, 1, 0]), n=20, jitter=0.01, seed=3)
        params = CurationParams(max_exemplars=12)
        rows, kinds, stats = curate_card_embeddings(rows_in, params)
        exemplar_count = sum(1 for k in kinds if k == EXEMPLAR_KIND)
        self.assertEqual(exemplar_count, 12)
        self.assertEqual(stats.cappedRemoved, 8 - stats.droppedOutliers if stats.droppedOutliers else 8)
        self.assertTrue(stats.prototypeAdded)

    def test_gate_never_empties_card(self) -> None:
        # All mutually far apart: gate could try to drop everything.
        rows_in = np.stack([
            _unit([1, 0, 0, 0]),
            _unit([0, 1, 0, 0]),
            _unit([0, 0, 1, 0]),
            _unit([0, 0, 0, 1]),
        ])
        rows, kinds, stats = curate_card_embeddings(rows_in)
        self.assertGreaterEqual(rows.shape[0], 1)

    def test_output_is_l2_normalized(self) -> None:
        rows_in = _cluster(_unit([0.3, 0.7, 0.1, 0.2]), n=10, jitter=0.05, seed=4)
        rows, _kinds, _stats = curate_card_embeddings(rows_in)
        norms = np.linalg.norm(rows, axis=1)
        np.testing.assert_allclose(norms, 1.0, atol=1e-5)

    def test_prototype_is_centroid_of_kept(self) -> None:
        rows_in = _cluster(_unit([1, 2, 0, 0]), n=5, jitter=0.01, seed=5)
        rows, kinds, _stats = curate_card_embeddings(rows_in)
        exemplars = rows[[k == EXEMPLAR_KIND for k in kinds]]
        prototype = rows[[k == PROTOTYPE_KIND for k in kinds]][0]
        expected = exemplars.mean(axis=0)
        expected = expected / np.linalg.norm(expected)
        np.testing.assert_allclose(prototype, expected, atol=1e-5)


if __name__ == "__main__":
    unittest.main()
