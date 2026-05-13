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
        "entries": [
            {
                "rowIndex": idx,
                "providerCardId": row["providerCardId"],
                "fixtureName": row["fixtureName"],
                "cardName": row["cardName"],
                "collectorNumber": row["collectorNumber"],
                "setCode": row["setCode"],
                "normalizedImagePath": row["normalizedImagePath"],
                "mappingConfidence": row["mappingConfidence"],
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
