#!/usr/bin/env python3
"""Two-stage rerank eval (Option D).

Stage 1: clean Scrydex-only retrieval gets top-K candidates per query.
Stage 2: for each candidate that has user photos in our pool, compute
max similarity between the query and that card's user photos. Combine
scores: final = scrydex_score + alpha * userphoto_score.

Cards without user photos are unchanged. Cards with user photos can
move within the top-K, but cannot enter from outside it. By
construction, no off-card user-photo can ever beat an on-card Scrydex
hit because user-photo signal only refines a card's existing rank.

Run with held-out fixtures and leave-one-out queries to measure cost
and benefit on the same scoring path.
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
from rerank_pool_curation import CurationParams, curate_card_embeddings  # noqa: E402


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
        "--mode",
        choices=["holdout", "leave_one_out"],
        required=True,
        help="holdout: standard held-out fixtures (uncovered cards). leave_one_out: covered cards, each photo is held out from library.",
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
        "--training-manifest",
        type=Path,
        default=Path("/Users/stephenchan/spotlight-datasets/raw-visual-train/raw_visual_training_manifest.jsonl"),
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
    parser.add_argument("--alphas", type=float, nargs="+", default=[0.0, 0.1, 0.25, 0.5, 1.0])
    parser.add_argument("--thresholds", type=float, nargs="+", default=[0.0])
    parser.add_argument("--shortlist-k", type=int, default=50, help="Stage-1 candidate count.")
    parser.add_argument(
        "--curate",
        action="store_true",
        help="Apply the shared rerank-pool curation (outlier gate + cap + prototype) to each card's "
        "exemplars before computing the rerank max — so the measured lift reflects the shipped pool.",
    )
    parser.add_argument("--max-exemplars-per-card", type=int, default=12)
    parser.add_argument("--centroid-cos-floor", type=float, default=0.80)
    parser.add_argument("--centroid-mad-k", type=float, default=2.5)
    parser.add_argument("--no-prototype", action="store_true", help="Disable the averaged prototype row.")
    parser.add_argument("--model-id", default=DEFAULT_VISUAL_MODEL_ID)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"])
    return parser.parse_args()


def load_user_photos_by_pid(
    *,
    training_manifest: Path,
    holdout_truth_keys: set[str],
    holdout_nn_keys: set[str],
) -> dict[str, list[str]]:
    by_pid: dict[str, list[str]] = {}
    with training_manifest.open() as f:
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
            by_pid.setdefault(pid, []).append(str(normalized_path.resolve()))
    return by_pid


def evaluate(
    *,
    queries: list[tuple[str, str, Path, set[str]]],  # (label, truth_pid, query_image_path, photos_to_exclude_paths)
    base_matrix: np.ndarray,
    row_to_pid: list[str],
    pid_to_rows: dict[str, list[int]],
    encoder: RawVisualFrozenEncoder,
    user_photo_paths_by_pid: dict[str, list[str]],
    alphas: list[float],
    thresholds: list[float],
    shortlist_k: int,
    curate: bool = False,
    curation_params: CurationParams | None = None,
) -> None:
    # Encode all queries
    q_paths = [q[2] for q in queries]
    q_emb = encoder.embed_image_paths(q_paths, batch_size=32)
    qn = np.linalg.norm(q_emb, axis=1, keepdims=True); qn[qn == 0] = 1.0
    q_emb = (q_emb / qn).astype(np.float32)

    # Pre-encode user photos for each pid (excluding any per-query held-out paths is handled per-query)
    # For efficiency, encode all unique photo paths once.
    unique_photo_paths = sorted({p for paths in user_photo_paths_by_pid.values() for p in paths})
    if unique_photo_paths:
        photo_emb = encoder.embed_image_paths([Path(p) for p in unique_photo_paths], batch_size=64)
        pn = np.linalg.norm(photo_emb, axis=1, keepdims=True); pn[pn == 0] = 1.0
        photo_emb = (photo_emb / pn).astype(np.float32)
        path_to_emb_idx = {p: i for i, p in enumerate(unique_photo_paths)}
    else:
        photo_emb = np.zeros((0, encoder.embedding_dim), dtype=np.float32)
        path_to_emb_idx = {}

    # Pre-compute shortlists per query (independent of alpha/threshold)
    shortlists: list[tuple[list[str], dict[str, float], dict[str, float | None]]] = []
    missing = 0
    for (label, truth_pid, qp, exclude_paths), q in zip(queries, q_emb):
        truth_rows = pid_to_rows.get(truth_pid)
        if not truth_rows:
            missing += 1
            shortlists.append(([], {}, {}))
            continue
        scores = base_matrix @ q
        sorted_idx = np.argsort(scores)[::-1]
        shortlist_pids: list[str] = []
        shortlist_scores: dict[str, float] = {}
        for ridx in sorted_idx:
            pid = row_to_pid[int(ridx)]
            if not pid or pid in shortlist_scores:
                continue
            shortlist_scores[pid] = float(scores[int(ridx)])
            shortlist_pids.append(pid)
            if len(shortlist_pids) >= shortlist_k:
                break
        # Per-pid user-photo max similarity (independent of alpha/threshold)
        up_max_by_pid: dict[str, float | None] = {}
        for pid in shortlist_pids:
            up_paths = user_photo_paths_by_pid.get(pid, [])
            eligible_paths = [p for p in up_paths if p not in exclude_paths]
            idxs = [path_to_emb_idx[p] for p in eligible_paths if p in path_to_emb_idx]
            if idxs:
                card_emb = photo_emb[idxs]
                if curate:
                    # Curate AFTER leave-one-out exclusion so the centroid/prototype
                    # never sees the held-out query photo — keeps the eval honest.
                    card_emb, _kinds, _stats = curate_card_embeddings(card_emb, curation_params)
                if card_emb.shape[0]:
                    up_sims = card_emb @ q
                    up_max_by_pid[pid] = float(up_sims.max())
                else:
                    up_max_by_pid[pid] = None
            else:
                up_max_by_pid[pid] = None
        shortlists.append((shortlist_pids, shortlist_scores, up_max_by_pid))

    # Sweep alpha × threshold
    print(f"\n  shortlist-K={shortlist_k}, queries={len(queries)}, photos in pool={len(unique_photo_paths)}")
    if missing:
        print(f"  (skipped {missing} queries — truth not in index)")
    print(f"  {'alpha':>6} {'thresh':>7}  {'top-1':>10}  {'top-5':>10}  {'top-10':>10}  median_rank")
    print(f"  {'-' * 6} {'-' * 7}  {'-' * 10}  {'-' * 10}  {'-' * 10}  -----------")

    for alpha in alphas:
        for threshold in thresholds:
            hits = {1: 0, 5: 0, 10: 0}
            ranks: list[int] = []
            for (label, truth_pid, qp, exclude_paths), (shortlist_pids, shortlist_scores, up_max_by_pid) in zip(queries, shortlists):
                if not shortlist_pids:
                    continue
                final_scores: dict[str, float] = {}
                for pid in shortlist_pids:
                    base_sc = shortlist_scores[pid]
                    up_max = up_max_by_pid.get(pid)
                    boost = 0.0
                    if alpha > 0 and up_max is not None and up_max >= threshold:
                        boost = alpha * up_max
                    final_scores[pid] = base_sc + boost
                reranked = sorted(shortlist_pids, key=lambda p: final_scores[p], reverse=True)
                try:
                    rank = reranked.index(truth_pid) + 1
                except ValueError:
                    rank = shortlist_k + 1
                ranks.append(rank)
                for k in hits:
                    if rank <= k:
                        hits[k] += 1
            total = max(1, len(ranks))
            med = sorted(ranks)[len(ranks) // 2] if ranks else 0
            def fmt(n: int) -> str: return f"{n:>3}/{total:<3}"
            print(f"  {alpha:6.2f} {threshold:7.3f}  {fmt(hits[1])}    {fmt(hits[5])}    {fmt(hits[10])}    {med}")


def main() -> None:
    args = parse_args()

    base_manifest = json.loads(args.base_manifest.resolve().read_text())
    base_entries = [e for e in base_manifest.get("entries", []) if isinstance(e, dict)]
    base_matrix = np.asarray(np.load(args.base_npz.resolve())["embeddings"], dtype=np.float32)
    bn = np.linalg.norm(base_matrix, axis=1, keepdims=True); bn[bn == 0] = 1.0
    base_matrix = (base_matrix / bn).astype(np.float32)
    row_to_pid = [str(e.get("providerCardId") or "").strip() for e in base_entries]
    pid_to_rows: dict[str, list[int]] = {}
    for idx, pid in enumerate(row_to_pid):
        if pid:
            pid_to_rows.setdefault(pid, []).append(idx)

    holdout_truth_keys, holdout_nn_keys = collect_holdout_keys([p.resolve() for p in args.holdout_roots])
    user_photos = load_user_photos_by_pid(
        training_manifest=args.training_manifest.resolve(),
        holdout_truth_keys=holdout_truth_keys,
        holdout_nn_keys=holdout_nn_keys,
    )
    print(f"user-photo cards available for rerank: {len(user_photos)}")
    print(f"total user photos in pool: {sum(len(v) for v in user_photos.values())}")

    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    print(f"encoder ready on {encoder.device}")

    curation_params = CurationParams(
        max_exemplars=args.max_exemplars_per_card,
        centroid_cos_floor=args.centroid_cos_floor,
        centroid_mad_k=args.centroid_mad_k,
        with_prototype=not args.no_prototype,
    )
    if args.curate:
        print(f"curation ON: {curation_params.as_dict()}")
    else:
        print("curation OFF (raw exemplars)")

    if args.mode == "holdout":
        # Build queries from held-out fixtures
        # Need providerCardId for truth — same logic as eval_base_clip_retrieval.py
        from collections import defaultdict
        # Build truth_key -> providerCardId from training manifest (it's the only mapping we have)
        # Actually the held-out fixtures get their providerCardId from a provider_reference_manifest.json
        # The default provider manifest at qa/raw-footer-layout-check covers ~29 cards.
        # For consistency with our prior 71-fixture eval, use the same mapping logic.
        provider_manifest = Path("qa/raw-footer-layout-check/provider_reference_manifest.json")
        provider_truth_map: dict[str, str] = {}
        if provider_manifest.exists():
            mf = json.loads(provider_manifest.read_text())
            for e in mf.get("entries", []) or []:
                tk = str(e.get("truthKey") or "")
                pid = str(e.get("providerCardId") or "").strip()
                if tk and pid:
                    provider_truth_map[tk] = pid

        queries = []
        for root in args.holdout_roots:
            root = root.resolve()
            if not root.exists():
                continue
            for tjson in root.rglob("truth.json"):
                d = tjson.parent
                truth = json.loads(tjson.read_text())
                tk = truth_key(str(truth.get("cardName") or ""), str(truth.get("collectorNumber") or ""), str(truth.get("setCode") or ""))
                pid = provider_truth_map.get(tk)
                if not pid and truth.get("providerCardId"):
                    pid = str(truth["providerCardId"]).strip()
                if not pid:
                    ls = d / "label_status.json"
                    if ls.exists():
                        ls_payload = json.loads(ls.read_text())
                        mapping = ls_payload.get("providerMapping") or {}
                        if mapping.get("providerCardId"):
                            pid = str(mapping["providerCardId"]).strip()
                qp = d / "runtime_normalized.jpg"
                if pid and qp.exists():
                    queries.append((d.name, pid, qp, set()))
        print(f"\nholdout queries: {len(queries)}")
        evaluate(
            queries=queries,
            base_matrix=base_matrix,
            row_to_pid=row_to_pid,
            pid_to_rows=pid_to_rows,
            encoder=encoder,
            user_photo_paths_by_pid=user_photos,
            alphas=args.alphas,
            thresholds=args.thresholds,
            shortlist_k=args.shortlist_k,
            curate=args.curate,
            curation_params=curation_params,
        )

    elif args.mode == "leave_one_out":
        # For each card with >=2 user photos, take photo[0] as query, exclude that path from rerank pool
        queries = []
        for pid, paths in user_photos.items():
            if len(paths) < 2:
                continue
            paths_sorted = sorted(paths)
            held = paths_sorted[0]
            queries.append((Path(held).parent.name, pid, Path(held), {held}))
        print(f"\nleave-one-out queries: {len(queries)}")
        evaluate(
            queries=queries,
            base_matrix=base_matrix,
            row_to_pid=row_to_pid,
            pid_to_rows=pid_to_rows,
            encoder=encoder,
            user_photo_paths_by_pid=user_photos,
            alphas=args.alphas,
            thresholds=args.thresholds,
            shortlist_k=args.shortlist_k,
            curate=args.curate,
            curation_params=curation_params,
        )


if __name__ == "__main__":
    main()
