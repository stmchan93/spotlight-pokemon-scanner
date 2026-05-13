#!/usr/bin/env python3
"""Base-CLIP-only retrieval eval (no adapter).

Reads the same fixture roots as eval_raw_visual_model.py, encodes each
fixture's normalized scan with the current encoder, and runs raw cosine
search against the provided index NPZ. No projection adapter applied.

Lets us A/B preprocessing changes (e.g. letterbox) at the CLIP feature
level without confounding effects from a previously-trained adapter.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_model import DEFAULT_VISUAL_MODEL_ID, RawVisualFrozenEncoder  # noqa: E402


def fixture_truth_key(truth: dict[str, Any]) -> str:
    return f"{str(truth.get('cardName') or '').strip()}|{str(truth.get('collectorNumber') or '').strip()}|{str(truth.get('setCode') or '').strip()}"


def load_provider_truth_map(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    manifest = json.loads(path.read_text())
    return {
        str(entry.get("truthKey") or ""): entry
        for entry in (manifest.get("entries") or [])
        if isinstance(entry, dict) and str(entry.get("truthKey") or "").strip()
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-root", type=Path, action="append", dest="fixture_roots", required=True)
    parser.add_argument(
        "--provider-manifest",
        type=Path,
        default=Path("qa/raw-footer-layout-check/provider_reference_manifest.json"),
    )
    parser.add_argument("--index-npz", type=Path, required=True)
    parser.add_argument("--index-manifest", type=Path, required=True)
    parser.add_argument("--model-id", default=DEFAULT_VISUAL_MODEL_ID)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"])
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--label", default="run", help="Tag for stdout summary")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    provider_truth_map = load_provider_truth_map(args.provider_manifest.resolve())

    index_manifest = json.loads(args.index_manifest.resolve().read_text())
    index_rows = [e for e in index_manifest.get("entries", []) if isinstance(e, dict)]
    matrix = np.asarray(np.load(args.index_npz.resolve())["embeddings"], dtype=np.float32)
    if matrix.ndim != 2 or matrix.shape[0] != len(index_rows):
        raise SystemExit("Index NPZ/manifest mismatch.")
    # Normalize rows defensively (some old NPZs may not be normalized).
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    matrix = (matrix / norms).astype(np.float32)

    # Collect fixtures
    fixture_dirs = []
    for root in args.fixture_roots:
        root = root.resolve()
        if not root.exists():
            continue
        fixture_dirs.extend(truth_path.parent for truth_path in root.rglob("truth.json"))
    fixture_dirs = sorted({d.resolve() for d in fixture_dirs})

    # Filter to fixtures we can map to a providerCardId
    mappable: list[tuple[Path, str]] = []
    for d in fixture_dirs:
        truth = json.loads((d / "truth.json").read_text())
        pid = None
        m = provider_truth_map.get(fixture_truth_key(truth))
        if m and m.get("providerCardId"):
            pid = str(m["providerCardId"]).strip()
        elif truth.get("providerCardId"):
            pid = str(truth["providerCardId"]).strip()
        else:
            ls = d / "label_status.json"
            if ls.exists():
                ls_payload = json.loads(ls.read_text())
                mapping = ls_payload.get("providerMapping") or {}
                if mapping.get("providerCardId"):
                    pid = str(mapping["providerCardId"]).strip()
        if pid and (d / "runtime_normalized.jpg").exists():
            mappable.append((d, pid))

    print(f"[{args.label}] mappable fixtures: {len(mappable)}", flush=True)
    if not mappable:
        raise SystemExit("No mappable fixtures found.")

    # Encode all queries
    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    query_paths = [d / "runtime_normalized.jpg" for d, _ in mappable]
    query_embeddings = encoder.embed_image_paths(query_paths, batch_size=32)
    qnorms = np.linalg.norm(query_embeddings, axis=1, keepdims=True)
    qnorms[qnorms == 0] = 1.0
    query_embeddings = (query_embeddings / qnorms).astype(np.float32)

    # Build provider->rows lookup so multi-view cards score by best-matching row.
    pid_to_rows: dict[str, list[int]] = {}
    row_to_pid: list[str] = []
    for idx, entry in enumerate(index_rows):
        pid = str(entry.get("providerCardId") or "").strip()
        row_to_pid.append(pid)
        if pid:
            pid_to_rows.setdefault(pid, []).append(idx)

    hits_at = {1: 0, 5: 0, 10: 0}
    missing_truth_in_index = 0
    per_fixture: list[dict[str, Any]] = []
    for (d, pid), q in zip(mappable, query_embeddings):
        truth_rows = pid_to_rows.get(pid)
        if not truth_rows:
            missing_truth_in_index += 1
            per_fixture.append({"fixture": d.name, "pid": pid, "rank": None})
            continue
        scores = matrix @ q
        # Per-card score = max-over-rows. Truth's card score = best truth-row score.
        truth_score = float(scores[truth_rows].max())
        # Rank: how many distinct cards have a max score strictly higher than truth's?
        better_cards = set()
        # iterate only rows that could be above (cheaper than full unique pass)
        above_mask = scores > truth_score
        for row_idx in np.flatnonzero(above_mask):
            other_pid = row_to_pid[row_idx]
            if other_pid and other_pid != pid:
                better_cards.add(other_pid)
        rank = len(better_cards) + 1
        for k in hits_at:
            if rank <= k:
                hits_at[k] += 1
        per_fixture.append({"fixture": d.name, "pid": pid, "rank": rank, "truthRowCount": len(truth_rows)})

    total = len(mappable)
    print(f"[{args.label}] missing truth in index: {missing_truth_in_index}", flush=True)
    print(f"[{args.label}] visual top-1:  {hits_at[1]}/{total} ({100*hits_at[1]/total:.1f}%)")
    print(f"[{args.label}] visual top-5:  {hits_at[5]}/{total} ({100*hits_at[5]/total:.1f}%)")
    print(f"[{args.label}] visual top-10: {hits_at[10]}/{total} ({100*hits_at[10]/total:.1f}%)")

    # Mean rank of truth among matched
    matched_ranks = [e["rank"] for e in per_fixture if e["rank"] is not None]
    if matched_ranks:
        import statistics
        print(f"[{args.label}] median rank: {statistics.median(matched_ranks):.1f}, mean: {sum(matched_ranks)/len(matched_ranks):.1f}, p90: {sorted(matched_ranks)[int(0.9*len(matched_ranks))-1]}")


if __name__ == "__main__":
    main()
