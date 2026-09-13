"""Re-project an already-projected visual index from one adapter's embedding
space into another's, without re-embedding any reference image.

    python3 tools/reproject_visual_index_adapter.py \
        --index-npz  backend/data/visual-index/visual_index_active_<slug>.npz \
        --from-adapter backend/data/visual-models/<old>.pt \
        --to-adapter   backend/data/visual-models/<new>.pt \
        --out-npz    /tmp/reprojected.npz

Both adapters are bias-free square linears (`RawVisualProjectionAdapter`), so
a stored row `e_old = normalize(base @ W_old.T)` maps to the new space by
`e_new = normalize(e_old @ inv(W_old.T) @ W_new.T)` — the normalisation makes
the lost magnitude irrelevant. This is the same adapter-composition used to
publish v003 to staging (docs/honolulu-retrain-measurement-2026-08-31.md); it
preserves rows the VM embedded itself, which a local index does not contain.

`--verify-against` checks the result row-by-row against a known-good index and
reports the worst cosine, which is how this script was validated before it was
pointed at production.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import torch


def adapter_weight(checkpoint_path: Path) -> np.ndarray:
    """The (dim, dim) projection weight out of an adapter checkpoint."""
    blob = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    state = blob
    if isinstance(blob, dict):
        for wrapper in ("adapterStateDict", "state_dict", "model_state_dict"):
            if isinstance(blob.get(wrapper), dict):
                state = blob[wrapper]
                break
    for key in ("projection.weight", "module.projection.weight"):
        if key in state:
            weight = state[key]
            break
    else:
        raise SystemExit(
            f"No projection.weight in {checkpoint_path}; keys={list(state)[:8]}"
        )
    matrix = weight.detach().cpu().to(torch.float64).numpy()
    if matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1]:
        raise SystemExit(f"Expected a square weight, got {matrix.shape}")
    return matrix


def normalize_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    return matrix / norms


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index-npz", required=True, type=Path)
    parser.add_argument("--from-adapter", required=True, type=Path)
    parser.add_argument("--to-adapter", required=True, type=Path)
    parser.add_argument("--out-npz", required=True, type=Path)
    parser.add_argument("--verify-against", type=Path)
    parser.add_argument("--embeddings-key", default="embeddings")
    args = parser.parse_args(argv)

    w_old = adapter_weight(args.from_adapter)
    w_new = adapter_weight(args.to_adapter)
    if w_old.shape != w_new.shape:
        raise SystemExit(f"Adapter dim mismatch: {w_old.shape} vs {w_new.shape}")

    # Row-vector convention: nn.Linear computes x @ W.T.
    transform = np.linalg.inv(w_old.T) @ w_new.T
    cond = np.linalg.cond(w_old.T)
    print(f"[reproject] dim={w_old.shape[0]} cond(W_old.T)={cond:.3e}")
    if not np.isfinite(cond) or cond > 1e8:
        raise SystemExit("Source adapter is ill-conditioned; refusing to invert.")

    with np.load(args.index_npz, allow_pickle=True) as source:
        arrays = {key: source[key] for key in source.files}
    if args.embeddings_key not in arrays:
        raise SystemExit(f"No '{args.embeddings_key}' in {args.index_npz}")

    original = arrays[args.embeddings_key]
    projected = normalize_rows(
        original.astype(np.float64, copy=False) @ transform
    ).astype(original.dtype, copy=False)
    arrays[args.embeddings_key] = projected
    print(f"[reproject] rows={projected.shape[0]} dim={projected.shape[1]}")

    if args.verify_against:
        with np.load(args.verify_against, allow_pickle=True) as expected_npz:
            expected = expected_npz[args.embeddings_key]
        if expected.shape != projected.shape:
            print(
                f"[verify] SHAPE MISMATCH expected={expected.shape} got={projected.shape}",
                file=sys.stderr,
            )
            return 1
        cosines = np.einsum(
            "ij,ij->i",
            normalize_rows(projected.astype(np.float64)),
            normalize_rows(expected.astype(np.float64)),
        )
        print(
            f"[verify] cosine min={cosines.min():.12f} "
            f"mean={cosines.mean():.12f} below_0.9999={(cosines < 0.9999).sum()}"
        )
        if cosines.min() < 0.9999:
            print("[verify] FAILED", file=sys.stderr)
            return 1

    args.out_npz.parent.mkdir(parents=True, exist_ok=True)
    np.savez(args.out_npz, **arrays)
    print(f"[reproject] wrote {args.out_npz}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
