#!/usr/bin/env python3
"""Shared curation for the user-photo rerank pool.

The pool stores user-photo embeddings keyed by providerCardId. Stage-2
rerank looks up a shortlisted card's pool rows and boosts the card by the
max cosine similarity between the query and any of that card's rows.

Curation makes the pool robust as it grows from real-world (often glary,
mislabeled, or off-card) confirmed scans, WITHOUT changing the matcher.
Per card, it:

1. Outlier gate (only when a card has >= MIN_FOR_GATE exemplars): drop
   exemplars whose cosine to the card centroid is below an absolute floor
   OR an adaptive (median - k*MAD) floor. This rejects a glare-blown,
   mis-cropped, or mislabeled capture that would otherwise poison the
   per-card max.
2. Cap: keep at most ``max_exemplars`` exemplars, preferring those
   closest to the centroid. Bounds per-scan rerank cost and stops one
   over-photographed card from dominating memory — the rerank cost is
   O(shortlist_K * max_exemplars), independent of total pool size.
3. Prototype: optionally append one averaged centroid row (tagged so
   callers can label it). The centroid is robust to per-capture noise and
   gives a stable signal even when no single exemplar is near the query.

Because the matcher boosts by ``max`` over a card's rows, keeping the raw
exemplars and ADDING a prototype can only raise (never lower) the boost
relative to the raw-exemplar set; the dropped outliers are the only thing
that can change a per-card max, and by construction they are the rows
least like the card.

This module is intentionally dependency-light (numpy only) and pure so it
can be unit-tested with synthetic embeddings and shared by both
``build_user_photo_rerank_pool.py`` and ``eval_rerank_with_user_photos.py``.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


# Below this many exemplars an "outlier" is not well-defined, so the gate
# is skipped (we never want to drop one of a card's only two photos).
MIN_FOR_GATE = 3

DEFAULT_MAX_EXEMPLARS = 12
DEFAULT_CENTROID_COS_FLOOR = 0.80
DEFAULT_CENTROID_MAD_K = 2.5

PROTOTYPE_KIND = "prototype"
EXEMPLAR_KIND = "exemplar"


@dataclass
class CurationParams:
    max_exemplars: int = DEFAULT_MAX_EXEMPLARS
    centroid_cos_floor: float = DEFAULT_CENTROID_COS_FLOOR
    centroid_mad_k: float = DEFAULT_CENTROID_MAD_K
    with_prototype: bool = True

    def as_dict(self) -> dict[str, float | int | bool]:
        return {
            "maxExemplarsPerCard": int(self.max_exemplars),
            "centroidCosFloor": float(self.centroid_cos_floor),
            "centroidMadK": float(self.centroid_mad_k),
            "withPrototype": bool(self.with_prototype),
        }


@dataclass
class CardCurationStats:
    inputCount: int = 0
    droppedOutliers: int = 0
    cappedRemoved: int = 0
    prototypeAdded: bool = False
    outputCount: int = 0
    keptIndices: list[int] = field(default_factory=list)


def _l2_normalize(matrix: np.ndarray) -> np.ndarray:
    matrix = np.asarray(matrix, dtype=np.float32)
    if matrix.ndim == 1:
        matrix = matrix[None, :]
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (matrix / norms).astype(np.float32)


def curate_card_embeddings(
    embeddings: np.ndarray,
    params: CurationParams | None = None,
) -> tuple[np.ndarray, list[str], CardCurationStats]:
    """Curate one card's exemplar embeddings.

    Args:
        embeddings: (n, d) array of this card's exemplar embeddings. They are
            re-normalized defensively; callers may pass un-normalized rows.
        params: curation knobs (defaults applied if None).

    Returns:
        (rows, kinds, stats) where ``rows`` is an (m, d) L2-normalized array
        of curated pool rows (kept exemplars, then an optional prototype),
        ``kinds`` is a parallel list of "exemplar"/"prototype" tags, and
        ``stats`` records what happened. For empty input, returns an empty
        (0, d?) array.
    """
    params = params or CurationParams()
    emb = np.asarray(embeddings, dtype=np.float32)
    if emb.ndim == 1:
        emb = emb[None, :]
    n = emb.shape[0]
    stats = CardCurationStats(inputCount=n)
    if n == 0:
        return emb.reshape(0, emb.shape[1] if emb.ndim == 2 else 0), [], stats

    emb = _l2_normalize(emb)
    centroid = _l2_normalize(emb.mean(axis=0))[0]
    cos_to_centroid = emb @ centroid  # (n,)

    keep_mask = np.ones(n, dtype=bool)
    if n >= MIN_FOR_GATE:
        median = float(np.median(cos_to_centroid))
        mad = float(np.median(np.abs(cos_to_centroid - median)))
        adaptive_floor = median - params.centroid_mad_k * mad
        floor = max(params.centroid_cos_floor, adaptive_floor)
        keep_mask = cos_to_centroid >= floor
        # Never let the gate empty a card: keep at least the closest exemplar.
        if not keep_mask.any():
            keep_mask[int(np.argmax(cos_to_centroid))] = True
        stats.droppedOutliers = int(n - keep_mask.sum())

    kept_idx = np.where(keep_mask)[0]
    # Order kept exemplars by closeness to centroid (best first) for capping.
    kept_idx = kept_idx[np.argsort(cos_to_centroid[kept_idx])[::-1]]

    if params.max_exemplars > 0 and kept_idx.size > params.max_exemplars:
        stats.cappedRemoved = int(kept_idx.size - params.max_exemplars)
        kept_idx = kept_idx[: params.max_exemplars]

    stats.keptIndices = [int(i) for i in kept_idx]
    kept_rows = emb[kept_idx]
    kinds = [EXEMPLAR_KIND] * kept_rows.shape[0]
    rows = kept_rows

    # A prototype is only meaningful with >= 2 kept exemplars; with one it
    # would just duplicate that exemplar.
    if params.with_prototype and kept_rows.shape[0] >= 2:
        prototype = _l2_normalize(kept_rows.mean(axis=0))  # (1, d)
        rows = np.concatenate([kept_rows, prototype], axis=0)
        kinds.append(PROTOTYPE_KIND)
        stats.prototypeAdded = True

    rows = rows.astype(np.float32)
    stats.outputCount = rows.shape[0]
    return rows, kinds, stats
