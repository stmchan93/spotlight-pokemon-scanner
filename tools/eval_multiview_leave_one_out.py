#!/usr/bin/env python3
"""Leave-one-out evaluation for the multi-view library.

For each card with >=2 user photos in the filtered training manifest,
hold out one photo as the eval query. Build two index variants and
compare base-CLIP retrieval rank for that query:

  scrydex_only: existing base index (Scrydex render only for every card)
  multiview:    base index + remaining user photos for that card (the
                held-out one removed)

Measures the BENEFIT side of multi-view. Pair with the held-out-set
eval to measure the COST side.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_model import DEFAULT_VISUAL_MODEL_ID, RawVisualFrozenEncoder  # noqa: E402


def truth_key(name: str, num: str, setc: str) -> str:
    return f"{name.strip()}|{num.strip()}|{setc.strip()}"


def name_number_key(name: str, num: str) -> str:
    return f"{name.strip().lower()}|{num.strip()}"


def collect_holdout_keys(roots: list[Path]) -> tuple[set[str], set[str]]:
    tk, nk = set(), set()
    for root in roots:
        if not root.exists():
            continue
        for tjson in root.rglob("truth.json"):
            t = json.loads(tjson.read_text())
            name = str(t.get("cardName") or "")
            num = str(t.get("collectorNumber") or "")
            setc = str(t.get("setCode") or "")
            tk.add(truth_key(name, num, setc))
            nk.add(name_number_key(name, num))
    return tk, nk


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--training-manifest",
        type=Path,
        default=Path("/Users/stephenchan/spotlight-datasets/raw-visual-train/raw_visual_training_manifest.jsonl"),
    )
    parser.add_argument(
        "--base-manifest",
        type=Path,
        default=Path("backend/data/visual-index/visual_index_active_manifest.json"),
    )
    parser.add_argument(
        "--base-npz",
        type=Path,
        default=Path("backend/data/visual-index/visual_index_active_clip-vit-base-patch32.npz"),
    )
    parser.add_argument(
        "--holdout-root",
        type=Path,
        action="append",
        dest="holdout_roots",
        default=[
            Path("qa/raw-footer-layout-check"),
            Path("/Users/stephenchan/spotlight-datasets/raw-visual-expansion-holdouts/delta-raw-20260504-audit"),
            Path("/Users/stephenchan/spotlight-datasets/raw-visual-expansion-holdouts/drive-download-20260420t172622z-3-001"),
        ],
    )
    parser.add_argument("--model-id", default=DEFAULT_VISUAL_MODEL_ID)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"])
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    random.seed(args.seed)

    # Load base index
    base_manifest = json.loads(args.base_manifest.resolve().read_text())
    base_entries = [e for e in base_manifest.get("entries", []) if isinstance(e, dict)]
    base_matrix = np.asarray(np.load(args.base_npz.resolve())["embeddings"], dtype=np.float32)
    norms = np.linalg.norm(base_matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    base_matrix = (base_matrix / norms).astype(np.float32)
    row_to_pid_base = [str(e.get("providerCardId") or "").strip() for e in base_entries]
    pid_to_rows_base: dict[str, list[int]] = {}
    for idx, pid in enumerate(row_to_pid_base):
        if pid:
            pid_to_rows_base.setdefault(pid, []).append(idx)

    holdout_truth_keys, holdout_nn_keys = collect_holdout_keys([p.resolve() for p in args.holdout_roots])

    # Load training rows, filter, group by providerCardId
    by_pid: dict[str, list[dict[str, Any]]] = {}
    with args.training_manifest.resolve().open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if not row.get("providerSupported"):
                continue
            if row.get("expansionHoldoutSelected"):
                continue
            name = str(row.get("cardName") or "")
            num = str(row.get("collectorNumber") or "")
            setc = str(row.get("setCode") or "")
            if truth_key(name, num, setc) in holdout_truth_keys:
                continue
            if name_number_key(name, num) in holdout_nn_keys:
                continue
            pid = str(row.get("providerCardId") or "").strip()
            normalized_path = Path(str(row.get("normalizedImagePath") or ""))
            if not pid or not normalized_path.exists():
                continue
            by_pid.setdefault(pid, []).append({
                "providerCardId": pid,
                "normalizedImagePath": str(normalized_path.resolve()),
                "fixtureName": row.get("fixtureName"),
            })

    multi_cards = {pid: rows for pid, rows in by_pid.items() if len(rows) >= 2}
    print(f"cards with >=2 user photos: {len(multi_cards)}", flush=True)

    # Pick one query per card (the leave-one-out)
    queries = []
    library_extras = []
    for pid, rows in multi_cards.items():
        rows_sorted = sorted(rows, key=lambda r: r["fixtureName"] or "")
        held = rows_sorted[0]  # deterministic pick: first by fixtureName
        rest = rows_sorted[1:]
        queries.append(held)
        library_extras.extend(rest)
    print(f"leave-one-out queries: {len(queries)} (held back from library)")
    print(f"library extras (user photos kept in library): {len(library_extras)}")

    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    print(f"encoder ready on {encoder.device}", flush=True)

    # Encode queries
    query_paths = [Path(q["normalizedImagePath"]) for q in queries]
    q_emb = encoder.embed_image_paths(query_paths, batch_size=32)
    qnorms = np.linalg.norm(q_emb, axis=1, keepdims=True); qnorms[qnorms==0]=1.0
    q_emb = (q_emb / qnorms).astype(np.float32)

    # Encode library extras
    lib_paths = [Path(r["normalizedImagePath"]) for r in library_extras]
    if lib_paths:
        l_emb = encoder.embed_image_paths(lib_paths, batch_size=64)
        lnorms = np.linalg.norm(l_emb, axis=1, keepdims=True); lnorms[lnorms==0]=1.0
        l_emb = (l_emb / lnorms).astype(np.float32)
    else:
        l_emb = np.zeros((0, encoder.embedding_dim), dtype=np.float32)

    # Build expanded index
    expanded_matrix = np.concatenate([base_matrix, l_emb], axis=0).astype(np.float32)
    row_to_pid_expanded = list(row_to_pid_base) + [r["providerCardId"] for r in library_extras]
    pid_to_rows_expanded: dict[str, list[int]] = {}
    for idx, pid in enumerate(row_to_pid_expanded):
        if pid:
            pid_to_rows_expanded.setdefault(pid, []).append(idx)

    def rank_in(matrix: np.ndarray, row_to_pid: list[str], pid_to_rows: dict[str, list[int]], pid: str, q: np.ndarray) -> int | None:
        truth_rows = pid_to_rows.get(pid)
        if not truth_rows:
            return None
        scores = matrix @ q
        truth_score = float(scores[truth_rows].max())
        better_cards = set()
        for row_idx in np.flatnonzero(scores > truth_score):
            other_pid = row_to_pid[row_idx]
            if other_pid and other_pid != pid:
                better_cards.add(other_pid)
        return len(better_cards) + 1

    print()
    print("                        SCRYDEX-ONLY   MULTIVIEW")
    print("                        =============   ==========")
    hits_base = {1: 0, 5: 0, 10: 0}
    hits_mv = {1: 0, 5: 0, 10: 0}
    ranks_base: list[int] = []
    ranks_mv: list[int] = []
    missing = 0
    for q, query_row in zip(q_emb, queries):
        pid = query_row["providerCardId"]
        r_base = rank_in(base_matrix, row_to_pid_base, pid_to_rows_base, pid, q)
        r_mv = rank_in(expanded_matrix, row_to_pid_expanded, pid_to_rows_expanded, pid, q)
        if r_base is None or r_mv is None:
            missing += 1
            continue
        ranks_base.append(r_base)
        ranks_mv.append(r_mv)
        for k in hits_base:
            if r_base <= k: hits_base[k] += 1
            if r_mv <= k: hits_mv[k] += 1

    total = len(ranks_base)
    def fmt(num: int) -> str:
        return f"{num:>3}/{total:<3} ({100*num/total:5.1f}%)"
    print(f"top-1:                  {fmt(hits_base[1])}   {fmt(hits_mv[1])}")
    print(f"top-5:                  {fmt(hits_base[5])}   {fmt(hits_mv[5])}")
    print(f"top-10:                 {fmt(hits_base[10])}   {fmt(hits_mv[10])}")
    print()
    import statistics
    print(f"median rank:            {statistics.median(ranks_base):>9.1f}     {statistics.median(ranks_mv):>9.1f}")
    print(f"mean rank:              {sum(ranks_base)/total:>9.1f}     {sum(ranks_mv)/total:>9.1f}")
    print(f"p90 rank:               {sorted(ranks_base)[int(0.9*total)-1]:>9}     {sorted(ranks_mv)[int(0.9*total)-1]:>9}")
    print()
    if missing:
        print(f"(missing in index: {missing} queries)")

    # Per-query rank improvement distribution
    improved = sum(1 for b, m in zip(ranks_base, ranks_mv) if m < b)
    worse = sum(1 for b, m in zip(ranks_base, ranks_mv) if m > b)
    same = sum(1 for b, m in zip(ranks_base, ranks_mv) if m == b)
    print(f"per-query rank: improved={improved}, same={same}, worse={worse}")


if __name__ == "__main__":
    main()
