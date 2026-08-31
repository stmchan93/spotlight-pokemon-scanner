#!/usr/bin/env python3
"""Show-distribution benchmark: visual top-1/5/10 of one or more raw-visual
adapters on the FROZEN held-out card-show scans.

Why this exists: the curated `qa/raw-footer-layout-check` suite is clean /
room-quality and is MISLEADING for real card-show performance — an adapter
trained on show scans can look like a "regression" there while clearly winning
on actual show conditions (v011: curated hybrid 47->29, but show visual top-1
38%->48%). Gate model changes on THIS, not the curated suite.

What it measures: for each held-out show scan, base-CLIP-encode the normalized
image, project with the adapter, cosine-match against the BASE catalog index
projected with the SAME adapter, and check whether the truth card is top-1/5/10.
Visual-only (no OCR/hybrid) so it works on label-imported fixtures that lack the
runtime/OCR artifacts `eval_raw_visual_model.py` requires.

Truth comes from a {"entries":[{"truthKey","providerCardId"}]} manifest built
from the gold DB labels (see tools/build_show_benchmark_truthmap.py companion
note in docs). Index projection: runtime index artifacts built by
tools/build_raw_visual_index.py with --adapter-checkpoint store ALREADY-PROJECTED
embeddings (their manifest carries top-level adapterCheckpointPath). Re-projecting
such an index double-applies the adapter and silently deflates every number
(measured: 79% -> 68% top-1 on 2026-08-30). This tool now auto-detects that
marker and skips gallery projection; override with --reproject-index.

Usage:
  tools/eval_show_benchmark.py                         # active vs v011-candidate, defaults
  tools/eval_show_benchmark.py --adapter A.pt B.pt     # compare specific adapters
"""
from __future__ import annotations

import argparse
import glob
import os
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
for p in (REPO_ROOT / "tools", REPO_ROOT / "backend"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from eval_raw_visual_model import (  # noqa: E402
    load_json, load_provider_truth_map, fixture_truth_key, search_topk,
)
from raw_visual_model import (  # noqa: E402
    RawVisualFrozenEncoder, load_projection_adapter, project_embeddings_numpy, resolve_torch_device,
)

VI = REPO_ROOT / "backend" / "data" / "visual-index"
VM = REPO_ROOT / "backend" / "data" / "visual-models"
DEFAULT_BENCHMARK = Path(os.path.expanduser(
    "~/spotlight-datasets/raw-visual-expansion-holdouts/labeled-20260519-20260604"))


def main() -> int:
    ap = argparse.ArgumentParser(description="Visual top-1/5/10 on the held-out show benchmark.")
    ap.add_argument("--adapter", nargs="+", default=[
        str(VM / "raw_visual_adapter_active.pt"),
        str(VM / "raw_visual_adapter_v011-candidate.pt"),
    ], help="One or more adapter checkpoints to score (default: active + v011-candidate).")
    ap.add_argument("--labels", nargs="+", default=None,
                    help="Display labels for the adapters (default: file stems).")
    ap.add_argument("--benchmark-root", default=str(DEFAULT_BENCHMARK))
    ap.add_argument("--truthmap", default=None,
                    help="{'entries':[...]} truthKey->providerCardId manifest (default: <benchmark-root>/_truthmap_entries.json).")
    ap.add_argument("--base-index-npz", default=str(VI / "visual_index_v004-scrydex_clip-vit-base-patch32.npz"))
    ap.add_argument("--base-index-manifest", default=str(VI / "visual_index_v004-scrydex_manifest.json"))
    ap.add_argument("--model-id", default="openai/clip-vit-base-patch32")
    ap.add_argument("--device", default="mps")
    ap.add_argument("--reproject-index", choices=["auto", "always", "never"], default="auto",
                    help="Whether to project the index through the adapter. 'auto' (default) skips "
                         "projection when the index manifest carries adapterCheckpointPath (i.e. the "
                         "npz is already projected); 'always'/'never' force either behavior.")
    args = ap.parse_args()

    benchmark_root = Path(args.benchmark_root)
    truthmap_path = Path(args.truthmap or (benchmark_root / "_truthmap_entries.json"))
    truthmap = load_provider_truth_map(truthmap_path)
    if not truthmap:
        print(f"ERROR: empty/missing truthmap at {truthmap_path}", file=sys.stderr)
        return 2

    index_manifest = load_json(Path(args.base_index_manifest))
    index_rows = [e for e in index_manifest.get("entries", []) if isinstance(e, dict)]
    base_matrix = np.asarray(np.load(args.base_index_npz)["embeddings"], dtype=np.float32)
    row_ids = [str(r.get("providerCardId") or "") for r in index_rows]
    if base_matrix.shape[0] != len(row_ids):
        print("ERROR: base index npz/manifest mismatch", file=sys.stderr)
        return 2

    baked_adapter = index_manifest.get("adapterCheckpointPath")
    manifest_model = str(index_manifest.get("modelId") or "")
    if baked_adapter and manifest_model and manifest_model != args.model_id:
        # Manifest borrowed from a different backbone era (e.g. CLIP-era manifest
        # paired with a SigLIP2 base npz): its projection marker describes the
        # OTHER artifact, not this npz. Measured 2026-08-31: trusting it silently
        # cost 6 top-1 on the show holdout. Treat the npz as base.
        print(f"note: manifest modelId {manifest_model!r} != --model-id; ignoring its projection marker")
        baked_adapter = None
    if args.reproject_index == "auto":
        project_index = baked_adapter is None
    else:
        project_index = args.reproject_index == "always"
    if baked_adapter and project_index:
        print(f"WARNING: index manifest says it is ALREADY projected ({baked_adapter}) but "
              f"--reproject-index=always was passed — the gallery will be double-projected.", file=sys.stderr)
    if not project_index:
        print(f"index is pre-projected (adapter: {baked_adapter or 'assumed'}); gallery used as-stored — "
              f"per-adapter comparison applies to queries only")

    fixtures = []  # (normalized_path, truth_provider_card_id)
    for d in sorted(glob.glob(str(benchmark_root / "*") + os.sep)):
        tp = os.path.join(d, "truth.json"); npath = os.path.join(d, "runtime_normalized.jpg")
        if not (os.path.exists(tp) and os.path.exists(npath)):
            continue
        pm = truthmap.get(fixture_truth_key(load_json(Path(tp))))
        if pm and pm.get("providerCardId"):
            fixtures.append((npath, str(pm["providerCardId"])))
    n = len(fixtures)
    if not n:
        print("ERROR: no scorable fixtures (need truth.json + runtime_normalized.jpg + truthmap hit)", file=sys.stderr)
        return 2
    print(f"show benchmark: {n} held-out scans | index cards: {len(row_ids)}\n")

    device = resolve_torch_device(args.device)
    enc = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    base_q = enc.embed_image_paths([f[0] for f in fixtures], batch_size=32)

    labels = args.labels or [Path(a).stem.replace("raw_visual_adapter_", "") for a in args.adapter]
    print(f"{'adapter':32} {'top-1':>12} {'top-5':>12} {'top-10':>12}")
    for label, ckpt in zip(labels, args.adapter):
        adapter = load_projection_adapter(Path(ckpt), embedding_dim=enc.embedding_dim, device=device)
        pidx = (project_embeddings_numpy(adapter, base_matrix, device=device, batch_size=512)
                if project_index else base_matrix)
        pq = project_embeddings_numpy(adapter, base_q, device=device, batch_size=512)
        t1 = t5 = t10 = 0
        for i, (_, truth_id) in enumerate(fixtures):
            ids = [row_ids[ri] for ri, _ in search_topk(pq[i], pidx, 10)]
            t1 += ids[:1] == [truth_id]; t5 += truth_id in ids[:5]; t10 += truth_id in ids[:10]
        print(f"{label[:32]:32} {f'{t1}/{n} ({100*t1//n}%)':>12} {f'{t5}/{n} ({100*t5//n}%)':>12} {f'{t10}/{n} ({100*t10//n}%)':>12}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
