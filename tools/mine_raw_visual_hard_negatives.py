#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from raw_visual_dataset_paths import (
    default_raw_visual_train_hard_negatives_path,
    default_raw_visual_train_manifest_path,
)

import numpy as np


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if not (BACKEND_ROOT / "server.py").exists():
    BACKEND_ROOT = REPO_ROOT
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_model import DEFAULT_VISUAL_MODEL_ID, RawVisualFrozenEncoder  # noqa: E402


def utc_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_manifest(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        payload = json.loads(line)
        if isinstance(payload, dict):
            rows.append(payload)
    if not rows:
        raise SystemExit(f"No training rows found in {path}")
    return rows


def search_topk(query_vector: np.ndarray, matrix: np.ndarray, top_k: int) -> list[tuple[int, float]]:
    sanitized_query = np.nan_to_num(query_vector.astype(np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    sanitized_matrix = np.nan_to_num(matrix.astype(np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    scores = np.sum(sanitized_matrix * sanitized_query[None, :], axis=1, dtype=np.float64)
    if top_k >= len(scores):
        top_indices = np.argsort(scores)[::-1]
    else:
        top_indices = np.argpartition(scores, -top_k)[-top_k:]
        top_indices = top_indices[np.argsort(scores[top_indices])[::-1]]
    return [(int(index), float(scores[index])) for index in top_indices]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Mine hard negatives for raw visual adapter training.")
    parser.add_argument(
        "--manifest-path",
        type=Path,
        default=default_raw_visual_train_manifest_path(),
        help="Accepted training manifest JSONL path.",
    )
    parser.add_argument(
        "--index-npz",
        type=Path,
        default=Path("backend/data/visual-index/visual_index_active_clip-vit-base-patch32.npz"),
        help="Base full visual index NPZ path.",
    )
    parser.add_argument(
        "--index-manifest",
        type=Path,
        default=Path("backend/data/visual-index/visual_index_active_manifest.json"),
        help="Base full visual index manifest path.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=default_raw_visual_train_hard_negatives_path(),
        help="Where to write the hard-negative manifest.",
    )
    parser.add_argument(
        "--model-id",
        default=DEFAULT_VISUAL_MODEL_ID,
        help="Frozen CLIP model id used to produce the base embeddings.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "mps"],
        help="Torch device for query embedding extraction.",
    )
    parser.add_argument(
        "--embedding-batch-size",
        type=int,
        default=16,
        help="Batch size for query embedding extraction.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=25,
        help="How many full-index matches to inspect before collecting wrong candidates.",
    )
    parser.add_argument(
        "--per-fixture-limit",
        type=int,
        default=5,
        help="How many wrong candidates to keep per fixture.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    manifest_rows = load_manifest(args.manifest_path.resolve())
    index_manifest = json.loads(args.index_manifest.resolve().read_text())
    index_rows = [entry for entry in index_manifest.get("entries", []) if isinstance(entry, dict)]
    index_matrix = np.asarray(np.load(args.index_npz.resolve())["embeddings"], dtype=np.float32)
    if index_matrix.ndim != 2 or index_matrix.shape[0] != len(index_rows):
        raise SystemExit("Full visual index NPZ/manifest mismatch.")

    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    normalized_paths = [Path(str(row["normalizedImagePath"])).resolve() for row in manifest_rows]
    query_embeddings = encoder.embed_image_paths(normalized_paths, batch_size=args.embedding_batch_size)

    output_entries: dict[str, list[dict[str, Any]]] = {}
    confusion_summary: list[dict[str, Any]] = []

    for row, query_embedding in zip(manifest_rows, query_embeddings, strict=True):
        truth_provider_id = str(row.get("providerCardId") or "")
        top_matches = search_topk(query_embedding, index_matrix, args.top_k)
        negatives: list[dict[str, Any]] = []
        for row_index, similarity in top_matches:
            candidate = index_rows[row_index]
            provider_card_id = str(candidate.get("providerCardId") or "")
            if not provider_card_id or provider_card_id == truth_provider_id:
                continue
            negatives.append(
                {
                    "providerCardId": provider_card_id,
                    "similarity": round(float(similarity), 6),
                    "providerName": candidate.get("name"),
                    "providerCollectorNumber": candidate.get("collectorNumber"),
                    "providerSetId": candidate.get("setId"),
                    "providerSetPtcgoCode": candidate.get("setPtcgoCode"),
                    "providerSetName": candidate.get("setName"),
                }
            )
            if len(negatives) >= args.per_fixture_limit:
                break
        output_entries[str(row.get("fixtureName") or "")] = negatives
        confusion_summary.append(
            {
                "fixtureName": row.get("fixtureName"),
                "truthProviderCardId": truth_provider_id,
                "hardNegativeCount": len(negatives),
                "topNegativeProviderCardId": negatives[0]["providerCardId"] if negatives else None,
                "topNegativeSimilarity": negatives[0]["similarity"] if negatives else None,
            }
        )

    payload = {
        "generatedAt": utc_now_iso(),
        "manifestPath": str(args.manifest_path.resolve()),
        "modelId": args.model_id,
        "indexNpzPath": str(args.index_npz.resolve()),
        "indexManifestPath": str(args.index_manifest.resolve()),
        "topK": args.top_k,
        "perFixtureLimit": args.per_fixture_limit,
        "fixtureCount": len(manifest_rows),
        "entries": output_entries,
        "summary": confusion_summary,
    }
    args.output.resolve().parent.mkdir(parents=True, exist_ok=True)
    args.output.resolve().write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote hard-negative manifest to {args.output.resolve()}")
    print(f"Fixtures: {len(manifest_rows)} perFixtureLimit: {args.per_fixture_limit}")


if __name__ == "__main__":
    main()
