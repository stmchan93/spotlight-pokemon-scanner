from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


@dataclass(frozen=True)
class RawVisualSearchMatch:
    row_index: int
    similarity: float
    entry: dict[str, Any]


class RawVisualIndex:
    def __init__(self, npz_path: Path, manifest_path: Path) -> None:
        self.npz_path = npz_path
        self.manifest_path = manifest_path
        self._matrix: np.ndarray | None = None
        self._entries: list[dict[str, Any]] | None = None

    def is_available(self) -> bool:
        return self.npz_path.exists() and self.manifest_path.exists()

    def load(self) -> None:
        if self._matrix is not None and self._entries is not None:
            return
        manifest = json.loads(self.manifest_path.read_text())
        entries = [entry for entry in manifest.get("entries", []) if isinstance(entry, dict)]
        matrix = np.load(self.npz_path)["embeddings"].astype(np.float32)
        if matrix.ndim != 2:
            raise ValueError(f"Expected 2D embeddings matrix in {self.npz_path}, got {matrix.shape}")
        if matrix.shape[0] != len(entries):
            raise ValueError(
                f"Visual index row mismatch: matrix has {matrix.shape[0]} rows but manifest has {len(entries)} entries"
            )
        matrix = np.nan_to_num(matrix, nan=0.0, posinf=0.0, neginf=0.0)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        self._matrix = matrix / norms
        self._entries = entries

    @property
    def matrix(self) -> np.ndarray:
        self.load()
        assert self._matrix is not None
        return self._matrix

    @property
    def entries(self) -> list[dict[str, Any]]:
        self.load()
        assert self._entries is not None
        return self._entries

    def search(self, query_embedding: np.ndarray, top_k: int = 10) -> list[RawVisualSearchMatch]:
        matrix = self.matrix
        entries = self.entries
        query = np.asarray(query_embedding, dtype=np.float32)
        query = np.nan_to_num(query, nan=0.0, posinf=0.0, neginf=0.0)
        norm = np.linalg.norm(query)
        if norm == 0:
            raise ValueError("Query embedding has zero norm.")
        query = query / norm

        scores = np.sum(matrix * query[None, :], axis=1, dtype=np.float64)
        if top_k >= len(scores):
            top_indices = np.argsort(scores)[::-1]
        else:
            top_indices = np.argpartition(scores, -top_k)[-top_k:]
            top_indices = top_indices[np.argsort(scores[top_indices])[::-1]]
        return [
            RawVisualSearchMatch(
                row_index=int(index),
                similarity=float(scores[index]),
                entry=entries[int(index)],
            )
            for index in top_indices
        ]
