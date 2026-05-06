from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_index import RawVisualIndex  # noqa: E402


class RawVisualIndexTests(unittest.TestCase):
    def _write_index(
        self,
        tempdir: Path,
        *,
        embeddings: np.ndarray,
        entries: list[dict[str, object]],
    ) -> tuple[Path, Path]:
        npz_path = tempdir / "index.npz"
        manifest_path = tempdir / "manifest.json"
        np.savez(npz_path, embeddings=embeddings)
        manifest_path.write_text(json.dumps({"entries": entries}))
        return npz_path, manifest_path

    def test_is_available_requires_both_npz_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir_str:
            tempdir = Path(tempdir_str)
            npz_path = tempdir / "index.npz"
            manifest_path = tempdir / "manifest.json"

            index = RawVisualIndex(npz_path=npz_path, manifest_path=manifest_path)
            self.assertFalse(index.is_available())

            np.savez(npz_path, embeddings=np.eye(1, dtype=np.float32))
            self.assertFalse(index.is_available())

            manifest_path.write_text(json.dumps({"entries": [{"providerCardId": "base1-4"}]}))
            self.assertTrue(index.is_available())

    def test_load_normalizes_matrix_and_search_ranks_highest_similarity_first(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir_str:
            tempdir = Path(tempdir_str)
            npz_path, manifest_path = self._write_index(
                tempdir,
                embeddings=np.array(
                    [
                        [3.0, 0.0],
                        [0.0, 4.0],
                        [np.nan, np.inf],
                    ],
                    dtype=np.float32,
                ),
                entries=[
                    {"providerCardId": "base1-4", "name": "Charizard"},
                    {"providerCardId": "base1-2", "name": "Blastoise"},
                    {"providerCardId": "gym1-60", "name": "Sabrina's Slowbro"},
                ],
            )
            index = RawVisualIndex(npz_path=npz_path, manifest_path=manifest_path)

            matches = index.search(np.array([1.0, 0.0], dtype=np.float32), top_k=2)

            self.assertEqual([match.entry["providerCardId"] for match in matches], ["base1-4", "gym1-60"])
            self.assertAlmostEqual(matches[0].similarity, 1.0)
            self.assertEqual(index.matrix.shape, (3, 2))
            self.assertTrue(np.allclose(index.matrix[0], np.array([1.0, 0.0], dtype=np.float32)))
            self.assertTrue(np.allclose(index.matrix[2], np.array([0.0, 0.0], dtype=np.float32)))

            # Cached second load should be a no-op.
            cached_matrix = index.matrix
            index.load()
            self.assertIs(index.matrix, cached_matrix)

    def test_load_rejects_non_2d_embedding_matrix(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir_str:
            tempdir = Path(tempdir_str)
            npz_path, manifest_path = self._write_index(
                tempdir,
                embeddings=np.array([1.0, 2.0], dtype=np.float32),
                entries=[{"providerCardId": "base1-4"}],
            )
            index = RawVisualIndex(npz_path=npz_path, manifest_path=manifest_path)

            with self.assertRaisesRegex(ValueError, "Expected 2D embeddings matrix"):
                index.load()

    def test_load_rejects_manifest_and_matrix_row_count_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir_str:
            tempdir = Path(tempdir_str)
            npz_path, manifest_path = self._write_index(
                tempdir,
                embeddings=np.eye(2, dtype=np.float32),
                entries=[{"providerCardId": "base1-4"}],
            )
            index = RawVisualIndex(npz_path=npz_path, manifest_path=manifest_path)

            with self.assertRaisesRegex(ValueError, "Visual index row mismatch"):
                index.load()

    def test_search_rejects_zero_norm_query(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir_str:
            tempdir = Path(tempdir_str)
            npz_path, manifest_path = self._write_index(
                tempdir,
                embeddings=np.eye(1, dtype=np.float32),
                entries=[{"providerCardId": "base1-4"}],
            )
            index = RawVisualIndex(npz_path=npz_path, manifest_path=manifest_path)

            with self.assertRaisesRegex(ValueError, "zero norm"):
                index.search(np.array([0.0], dtype=np.float32))


if __name__ == "__main__":
    unittest.main()
