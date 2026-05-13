"""User-photo rerank pool for the matcher's stage-2 reranking.

The pool is a separate artifact from the main visual index. Each row is
the embedding of a user-captured photo of a card, keyed by the same
providerCardId used in the main index. At query time the matcher takes
its stage-1 shortlist (clean Scrydex-only retrieval), then for each
shortlisted card looks up any rerank-pool rows for that providerCardId
and computes max similarity to the query. The result is a per-card
"user-photo confidence" that gets folded into the final ranking.

This file is intentionally minimal: file IO + lookup. The matcher owns
the policy (alpha, threshold, shortlist size).
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import numpy as np


class RawVisualUserPhotoRerankPool:
    def __init__(self, npz_path: Path, manifest_path: Path) -> None:
        self.npz_path = npz_path
        self.manifest_path = manifest_path
        self._matrix: np.ndarray | None = None
        self._row_indices_by_pid: dict[str, list[int]] | None = None
        self._embedding_dim: int | None = None
        self._unique_card_count: int = 0
        self._row_count: int = 0
        self._artifact_version: str | None = None
        self._model_id: str | None = None
        self._load_lock = threading.Lock()

    def is_available(self) -> bool:
        return self.npz_path.exists() and self.manifest_path.exists()

    def load(self) -> None:
        if self._matrix is not None:
            return
        with self._load_lock:
            if self._matrix is not None:
                return
            manifest = json.loads(self.manifest_path.read_text())
            entries = [entry for entry in manifest.get("entries", []) if isinstance(entry, dict)]
            matrix = np.load(self.npz_path)["embeddings"].astype(np.float32)
            if matrix.ndim != 2:
                raise ValueError(f"Expected 2D rerank pool matrix in {self.npz_path}, got {matrix.shape}")
            if matrix.shape[0] != len(entries):
                raise ValueError(
                    f"Rerank pool row mismatch: matrix has {matrix.shape[0]} rows but manifest has {len(entries)} entries"
                )
            matrix = np.nan_to_num(matrix, nan=0.0, posinf=0.0, neginf=0.0)
            norms = np.linalg.norm(matrix, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            matrix = (matrix / norms).astype(np.float32)

            row_indices_by_pid: dict[str, list[int]] = {}
            for entry in entries:
                pid = str(entry.get("providerCardId") or "").strip()
                row_index = entry.get("rowIndex")
                if not pid or not isinstance(row_index, int):
                    continue
                row_indices_by_pid.setdefault(pid, []).append(row_index)

            self._matrix = matrix
            self._row_indices_by_pid = row_indices_by_pid
            self._embedding_dim = int(matrix.shape[1])
            self._unique_card_count = len(row_indices_by_pid)
            self._row_count = int(matrix.shape[0])
            self._artifact_version = str(manifest.get("artifactVersion") or "")
            self._model_id = str(manifest.get("modelId") or "")

    @property
    def matrix(self) -> np.ndarray:
        self.load()
        assert self._matrix is not None
        return self._matrix

    @property
    def embedding_dim(self) -> int:
        self.load()
        assert self._embedding_dim is not None
        return self._embedding_dim

    @property
    def row_count(self) -> int:
        self.load()
        return self._row_count

    @property
    def unique_card_count(self) -> int:
        self.load()
        return self._unique_card_count

    @property
    def artifact_version(self) -> str | None:
        self.load()
        return self._artifact_version

    def has_rows_for(self, provider_card_id: str) -> bool:
        self.load()
        assert self._row_indices_by_pid is not None
        return provider_card_id in self._row_indices_by_pid

    def max_similarity_for(self, provider_card_id: str, query_embedding: np.ndarray) -> float | None:
        """Return max cosine similarity between query and this card's user photos.

        Returns None if no photos exist for this card. The query embedding
        is expected to already be L2-normalized; rows in the pool are
        normalized at load time.
        """
        self.load()
        assert self._row_indices_by_pid is not None
        assert self._matrix is not None
        row_indices = self._row_indices_by_pid.get(provider_card_id)
        if not row_indices:
            return None
        rows = self._matrix[row_indices]
        sims = rows @ query_embedding
        return float(sims.max())
