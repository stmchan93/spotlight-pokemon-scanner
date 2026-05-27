#!/usr/bin/env python3
"""Build the user-photo rerank pool used by the matcher's stage-2 rerank.

The rerank pool is a separate artifact from the main visual index. Its
rows are user-photo embeddings keyed by providerCardId. Stage 1 of the
matcher does clean Scrydex-only retrieval; stage 2 looks up rerank-pool
rows for cards in the shortlist and applies a similarity boost.

Held-out fixtures and low-confidence mappings are filtered out
defensively so the rerank pool can never be a vector for evaluation
contamination.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_model import (  # noqa: E402
    DEFAULT_VISUAL_MODEL_ID,
    RawVisualFrozenEncoder,
    load_projection_adapter,
    project_embeddings_numpy,
    resolve_torch_device,
)
from rerank_pool_curation import (  # noqa: E402
    PROTOTYPE_KIND,
    CurationParams,
    curate_card_embeddings,
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def truth_key(name: str, num: str, setc: str) -> str:
    return f"{name.strip()}|{num.strip()}|{setc.strip()}"


def name_number_key(name: str, num: str) -> str:
    return f"{name.strip().lower()}|{num.strip()}"


def collect_holdout_keys(roots: list[Path]) -> tuple[set[str], set[str]]:
    tk: set[str] = set()
    nk: set[str] = set()
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
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("backend/data/visual-index"),
    )
    parser.add_argument("--artifact-version", default="v001")
    parser.add_argument("--model-id", default=DEFAULT_VISUAL_MODEL_ID)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"])
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument(
        "--accept-mapping-confidences",
        nargs="+",
        default=["high"],
        help="Which mappingConfidence values from the training manifest to accept. Defaults to high only.",
    )
    parser.add_argument(
        "--adapter-checkpoint",
        type=Path,
        default=Path("backend/data/visual-models/raw_visual_adapter_active.pt"),
        help="Adapter checkpoint to project pool embeddings into the same space as the query encoder. Set to a missing path to skip projection (base CLIP only).",
    )
    # Curation (shared with the eval harness via tools/rerank_pool_curation.py).
    parser.add_argument(
        "--no-curate",
        action="store_true",
        help="Disable per-card curation (outlier gate + cap + prototype). Reproduces the legacy raw-exemplar pool.",
    )
    parser.add_argument("--max-exemplars-per-card", type=int, default=12)
    parser.add_argument("--centroid-cos-floor", type=float, default=0.80)
    parser.add_argument("--centroid-mad-k", type=float, default=2.5)
    parser.add_argument("--no-prototype", action="store_true", help="Disable the averaged prototype row.")
    # Ingest trust filter (opt-in; default off so current behavior is unchanged).
    # When on, the far-from-centroid exemplars curation ALREADY drops are also
    # surfaced to a review-queue CSV (instead of vanishing silently), and the
    # rejected count + queue path are recorded in the manifest.
    parser.add_argument(
        "--review-queue",
        action="store_true",
        help="Route per-card far-from-centroid curation rejects to a review-queue CSV "
        "(default: tools/state/rerank_review_queue.csv) instead of silently dropping them.",
    )
    parser.add_argument(
        "--review-queue-path",
        type=Path,
        default=REPO_ROOT / "tools" / "state" / "rerank_review_queue.csv",
        help="Where the review queue CSV is written when --review-queue is on.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    holdout_truth_keys, holdout_nn_keys = collect_holdout_keys([p.resolve() for p in args.holdout_roots])
    print(f"held-out exclusion set: {len(holdout_truth_keys)} truth keys", flush=True)

    accepted_confidences = {str(c).strip().lower() for c in args.accept_mapping_confidences}
    rejected_counts = {
        "not_provider_supported": 0,
        "expansion_holdout": 0,
        "holdout_overlap_truthkey": 0,
        "holdout_overlap_namenumber": 0,
        "low_mapping_confidence": 0,
        "missing_provider_card_id": 0,
        "missing_normalized_image": 0,
    }

    rows: list[dict[str, Any]] = []
    with args.training_manifest.resolve().open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if not row.get("providerSupported"):
                rejected_counts["not_provider_supported"] += 1
                continue
            if row.get("expansionHoldoutSelected"):
                rejected_counts["expansion_holdout"] += 1
                continue
            name = str(row.get("cardName") or "")
            num = str(row.get("collectorNumber") or "")
            setc = str(row.get("setCode") or "")
            if truth_key(name, num, setc) in holdout_truth_keys:
                rejected_counts["holdout_overlap_truthkey"] += 1
                continue
            if name_number_key(name, num) in holdout_nn_keys:
                rejected_counts["holdout_overlap_namenumber"] += 1
                continue
            confidence = str(row.get("mappingConfidence") or "").strip().lower()
            if accepted_confidences and confidence not in accepted_confidences:
                rejected_counts["low_mapping_confidence"] += 1
                continue
            pid = str(row.get("providerCardId") or "").strip()
            if not pid:
                rejected_counts["missing_provider_card_id"] += 1
                continue
            normalized_path = Path(str(row.get("normalizedImagePath") or ""))
            if not normalized_path.exists():
                rejected_counts["missing_normalized_image"] += 1
                continue
            rows.append({
                "providerCardId": pid,
                "normalizedImagePath": str(normalized_path.resolve()),
                "fixtureName": row.get("fixtureName"),
                "cardName": name,
                "collectorNumber": num,
                "setCode": setc,
                "mappingConfidence": confidence,
            })

    unique_pids = sorted({r["providerCardId"] for r in rows})
    print(f"survivors: {len(rows)} photos across {len(unique_pids)} unique cards", flush=True)
    print(f"rejection counts: {rejected_counts}", flush=True)
    if not rows:
        raise SystemExit("No surviving rows.")

    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    print(f"encoder ready on {encoder.device}", flush=True)

    embeddings_chunks: list[np.ndarray] = []
    total = len(rows)
    for start in range(0, total, args.batch_size):
        batch = rows[start : start + args.batch_size]
        images = [Image.open(r["normalizedImagePath"]).convert("RGB") for r in batch]
        try:
            embeddings = encoder.embed_images(images, batch_size=len(images))
        finally:
            for image in images:
                image.close()
        embeddings_chunks.append(embeddings)
        if start == 0 or (start // args.batch_size) % 5 == 0 or start + args.batch_size >= total:
            print(f"  encoded {min(start + args.batch_size, total)}/{total}", flush=True)
    matrix = np.concatenate(embeddings_chunks, axis=0).astype(np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    matrix = (matrix / norms).astype(np.float32)
    assert matrix.shape == (total, encoder.embedding_dim)

    # Apply the adapter so pool rows live in the same space as the live matcher's
    # query embeddings. Without this, cosine similarities at runtime are ~0.4
    # for self-match (apples-to-oranges) and the threshold gate never fires.
    adapter_path = args.adapter_checkpoint.resolve() if args.adapter_checkpoint else None
    adapter_applied = False
    if adapter_path and adapter_path.exists():
        device = resolve_torch_device(args.device)
        adapter = load_projection_adapter(
            adapter_path,
            embedding_dim=encoder.embedding_dim,
            device=device,
        )
        matrix = project_embeddings_numpy(adapter, matrix, device=device, batch_size=1024)
        # project_embeddings_numpy does L2-normalize, but be defensive in case that changes.
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        matrix = (matrix / norms).astype(np.float32)
        adapter_applied = True
        print(f"applied adapter: {adapter_path}", flush=True)
    else:
        print(f"NO adapter applied (path missing: {adapter_path})", flush=True)

    # --- Curation (shared with the eval harness) -----------------------------
    # Group rows by card and apply the outlier gate + cap + prototype so the
    # pool is robust and bounded as it grows. Done AFTER the adapter so curation
    # operates in the same space the live matcher compares in.
    curation_params = CurationParams(
        max_exemplars=args.max_exemplars_per_card,
        centroid_cos_floor=args.centroid_cos_floor,
        centroid_mad_k=args.centroid_mad_k,
        with_prototype=not args.no_prototype,
    )
    if not args.no_curate:
        pid_to_local: dict[str, list[int]] = {}
        for local_idx, row in enumerate(rows):
            pid_to_local.setdefault(row["providerCardId"], []).append(local_idx)

        curated_vectors: list[np.ndarray] = []
        curated_rows: list[dict[str, Any]] = []
        review_queue_rows: list[dict[str, Any]] = []
        agg = {"droppedOutliers": 0, "cappedRemoved": 0, "prototypesAdded": 0}
        for pid, local_idxs in pid_to_local.items():
            group = matrix[local_idxs]
            kept_rows, _kinds, stats = curate_card_embeddings(group, curation_params)
            agg["droppedOutliers"] += stats.droppedOutliers
            agg["cappedRemoved"] += stats.cappedRemoved
            agg["prototypesAdded"] += 1 if stats.prototypeAdded else 0
            # Trust filter: surface the rows curation ALREADY dropped as
            # far-from-centroid outliers to a review queue (don't recompute the
            # outlier math here — just consume curate_card_embeddings' indices).
            if args.review_queue and stats.droppedOutlierIndices:
                for dropped_local in stats.droppedOutlierIndices:
                    src = rows[local_idxs[dropped_local]]
                    review_queue_rows.append({
                        "providerCardId": pid,
                        "cardName": src.get("cardName"),
                        "collectorNumber": src.get("collectorNumber"),
                        "setCode": src.get("setCode"),
                        "normalizedImagePath": src.get("normalizedImagePath"),
                        "fixtureName": src.get("fixtureName"),
                        "mappingConfidence": src.get("mappingConfidence"),
                        "rejectReason": "far_from_centroid_outlier",
                        "artifactVersion": args.artifact_version,
                    })
            for j, kept_local in enumerate(stats.keptIndices):
                orig = dict(rows[local_idxs[kept_local]])
                orig["exemplarKind"] = "exemplar"
                curated_rows.append(orig)
                curated_vectors.append(kept_rows[j])
            if stats.prototypeAdded:
                base = rows[local_idxs[stats.keptIndices[0]]]
                curated_rows.append({
                    "providerCardId": pid,
                    "normalizedImagePath": None,
                    "fixtureName": None,
                    "cardName": base.get("cardName"),
                    "collectorNumber": base.get("collectorNumber"),
                    "setCode": base.get("setCode"),
                    "mappingConfidence": base.get("mappingConfidence"),
                    "exemplarKind": PROTOTYPE_KIND,
                })
                curated_vectors.append(kept_rows[-1])

        matrix = np.stack(curated_vectors, axis=0).astype(np.float32)
        rows = curated_rows
        total = len(rows)
        unique_pids = sorted({r["providerCardId"] for r in rows})
        curation_summary = {"applied": True, **curation_params.as_dict(), **agg}
        print(
            f"curation: {total} rows across {len(unique_pids)} cards "
            f"(dropped {agg['droppedOutliers']} outliers, capped {agg['cappedRemoved']}, "
            f"+{agg['prototypesAdded']} prototypes)",
            flush=True,
        )

        # Trust filter: persist the already-dropped outliers to a review queue.
        review_queue_summary: dict[str, Any] = {"enabled": bool(args.review_queue)}
        if args.review_queue:
            review_queue_path = args.review_queue_path.resolve()
            review_queue_path.parent.mkdir(parents=True, exist_ok=True)
            fieldnames = [
                "providerCardId", "cardName", "collectorNumber", "setCode",
                "normalizedImagePath", "fixtureName", "mappingConfidence",
                "rejectReason", "artifactVersion",
            ]
            write_header = not review_queue_path.exists()
            with review_queue_path.open("a", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=fieldnames)
                if write_header:
                    writer.writeheader()
                for queue_row in review_queue_rows:
                    writer.writerow(queue_row)
            review_queue_summary.update({
                "rejectedCount": len(review_queue_rows),
                "queuePath": str(review_queue_path),
            })
            print(
                f"trust filter: routed {len(review_queue_rows)} far-from-centroid "
                f"rejects to {review_queue_path}",
                flush=True,
            )
        curation_summary["reviewQueue"] = review_queue_summary
    else:
        for row in rows:
            row["exemplarKind"] = "exemplar"
        curation_summary = {"applied": False}
        print("curation OFF (legacy raw-exemplar pool)", flush=True)

    model_slug = args.model_id.split("/")[-1].lower()
    artifact_stem = f"visual_index_user_photos_rerank_pool_{args.artifact_version}"
    npz_path = output_dir / f"{artifact_stem}_{model_slug}.npz"
    manifest_path = output_dir / f"{artifact_stem}_manifest.json"

    np.savez(npz_path, embeddings=matrix)
    manifest = {
        "generatedAt": utc_now_iso(),
        "artifactVersion": args.artifact_version,
        "modelId": args.model_id,
        "embeddingDimension": int(encoder.embedding_dim),
        "rowCount": total,
        "uniqueCardCount": len(unique_pids),
        "trainingManifestPath": str(args.training_manifest.resolve()),
        "holdoutRoots": [str(p.resolve()) for p in args.holdout_roots],
        "acceptedMappingConfidences": sorted(accepted_confidences),
        "rejectionCounts": rejected_counts,
        "adapterCheckpointPath": str(adapter_path) if adapter_applied else None,
        "adapterApplied": adapter_applied,
        "curation": curation_summary,
        "entries": [
            {
                "rowIndex": idx,
                "providerCardId": row["providerCardId"],
                "fixtureName": row.get("fixtureName"),
                "cardName": row.get("cardName"),
                "collectorNumber": row.get("collectorNumber"),
                "setCode": row.get("setCode"),
                "normalizedImagePath": row.get("normalizedImagePath"),
                "mappingConfidence": row.get("mappingConfidence"),
                "exemplarKind": row.get("exemplarKind", "exemplar"),
            }
            for idx, row in enumerate(rows)
        ],
    }
    manifest_path.write_text(json.dumps(manifest, indent=2))

    print(f"Wrote NPZ: {npz_path}")
    print(f"Wrote manifest: {manifest_path}")
    print(f"Pool: {total} photos, {len(unique_pids)} unique cards, dim={encoder.embedding_dim}")


if __name__ == "__main__":
    main()
