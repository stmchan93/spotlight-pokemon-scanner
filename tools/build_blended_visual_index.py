#!/usr/bin/env python3
"""Per-card-blended visual index (Option A).

For each card with user photos, replace its single Scrydex row with the
L2-normalized mean of (Scrydex_render, user_photo_1, ..., user_photo_N).
All other cards stay unchanged. Index row count is preserved (no
distractor-row contamination).

Cards without user photos in the training manifest get no change.
Held-out cards are defensively excluded from the user-photo source.
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

from raw_visual_model import DEFAULT_VISUAL_MODEL_ID, RawVisualFrozenEncoder  # noqa: E402


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
    parser.add_argument("--output-dir", type=Path, default=Path("backend/data/visual-index"))
    parser.add_argument("--artifact-version", default="v013-blended")
    parser.add_argument("--model-id", default=DEFAULT_VISUAL_MODEL_ID)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"])
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument(
        "--user-photo-weight",
        type=float,
        default=1.0,
        help="Weight on each user-photo embedding when averaging with the single Scrydex render.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    base_manifest_path = args.base_manifest.resolve()
    base_npz_path = args.base_npz.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    base_manifest = json.loads(base_manifest_path.read_text())
    base_entries = [e for e in base_manifest.get("entries", []) if isinstance(e, dict)]
    base_matrix = np.asarray(np.load(base_npz_path)["embeddings"], dtype=np.float32)
    if base_matrix.ndim != 2 or base_matrix.shape[0] != len(base_entries):
        raise SystemExit("Base index NPZ/manifest mismatch.")
    # Defensive normalize (older NPZs may have non-unit rows).
    norms = np.linalg.norm(base_matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    base_matrix = (base_matrix / norms).astype(np.float32)

    pid_to_row: dict[str, int] = {}
    for idx, entry in enumerate(base_entries):
        pid = str(entry.get("providerCardId") or "").strip()
        if pid and pid not in pid_to_row:
            pid_to_row[pid] = idx

    # Filter training entries
    holdout_truth_keys, holdout_nn_keys = collect_holdout_keys([p.resolve() for p in args.holdout_roots])
    photos_by_pid: dict[str, list[str]] = {}
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
            if pid not in pid_to_row:
                # No base row to blend with; skip.
                continue
            photos_by_pid.setdefault(pid, []).append(str(normalized_path.resolve()))

    print(f"covered cards (will blend): {len(photos_by_pid)}", flush=True)
    total_photos = sum(len(v) for v in photos_by_pid.values())
    print(f"total user photos contributing: {total_photos}", flush=True)
    if not photos_by_pid:
        raise SystemExit("No photos to blend.")

    # Encode all user photos
    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    print(f"encoder ready on {encoder.device}", flush=True)
    flat_paths: list[str] = []
    flat_pids: list[str] = []
    for pid, paths in photos_by_pid.items():
        for p in paths:
            flat_paths.append(p)
            flat_pids.append(pid)

    embeddings_chunks: list[np.ndarray] = []
    total = len(flat_paths)
    for start in range(0, total, args.batch_size):
        batch = flat_paths[start : start + args.batch_size]
        images = [Image.open(p).convert("RGB") for p in batch]
        try:
            emb = encoder.embed_images(images, batch_size=len(images))
        finally:
            for image in images:
                image.close()
        embeddings_chunks.append(emb)
        if start == 0 or (start // args.batch_size) % 5 == 0 or start + args.batch_size >= total:
            print(f"  encoded {min(start + args.batch_size, total)}/{total}", flush=True)
    user_emb = np.concatenate(embeddings_chunks, axis=0).astype(np.float32)
    norms = np.linalg.norm(user_emb, axis=1, keepdims=True); norms[norms==0]=1.0
    user_emb = (user_emb / norms).astype(np.float32)

    photo_idx_by_pid: dict[str, list[int]] = {}
    for i, pid in enumerate(flat_pids):
        photo_idx_by_pid.setdefault(pid, []).append(i)

    # Blend per covered card. Replace base row in-place (we'll write a new NPZ).
    blended_matrix = base_matrix.copy()
    blend_log: list[dict[str, Any]] = []
    for pid, photo_indices in photo_idx_by_pid.items():
        base_row = pid_to_row[pid]
        scrydex_vec = base_matrix[base_row]
        photos = user_emb[photo_indices]
        # Stack scrydex (weight 1) with weighted user photos
        weighted = np.concatenate(
            [scrydex_vec[None, :], args.user_photo_weight * photos],
            axis=0,
        )
        mean_vec = weighted.sum(axis=0) / (1.0 + args.user_photo_weight * len(photo_indices))
        n = float(np.linalg.norm(mean_vec))
        if n > 0:
            mean_vec = mean_vec / n
        blended_matrix[base_row] = mean_vec.astype(np.float32)
        blend_log.append({"providerCardId": pid, "photoCount": len(photo_indices), "rowIndex": base_row})

    # Annotate manifest entries for the blended cards
    new_entries: list[dict[str, Any]] = []
    blend_pids = set(photo_idx_by_pid.keys())
    for idx, entry in enumerate(base_entries):
        new_entry = dict(entry)
        new_entry["rowIndex"] = idx
        pid = str(entry.get("providerCardId") or "").strip()
        if pid in blend_pids:
            new_entry["rowSource"] = "blended"
            new_entry["blendedPhotoCount"] = len(photo_idx_by_pid[pid])
        else:
            new_entry["rowSource"] = "scrydex"
        new_entries.append(new_entry)

    model_slug = args.model_id.split("/")[-1].lower()
    artifact_stem = f"visual_index_{args.artifact_version}"
    npz_path = output_dir / f"{artifact_stem}_{model_slug}.npz"
    manifest_path = output_dir / f"{artifact_stem}_manifest.json"
    report_path = output_dir / f"{artifact_stem}_build_report.json"

    np.savez(npz_path, embeddings=blended_matrix.astype(np.float32))

    new_manifest = dict(base_manifest)
    new_manifest["generatedAt"] = utc_now_iso()
    new_manifest["artifactVersion"] = args.artifact_version
    new_manifest["entryCount"] = len(new_entries)
    new_manifest["baseManifestPath"] = str(base_manifest_path)
    new_manifest["blended"] = {
        "trainingManifestPath": str(args.training_manifest.resolve()),
        "holdoutRoots": [str(p.resolve()) for p in args.holdout_roots],
        "coveredCardCount": len(photo_idx_by_pid),
        "totalUserPhotos": total_photos,
        "userPhotoWeight": args.user_photo_weight,
    }
    new_manifest["entries"] = new_entries
    manifest_path.write_text(json.dumps(new_manifest, indent=2))

    report = {
        "generatedAt": utc_now_iso(),
        "artifactVersion": args.artifact_version,
        "baseManifestPath": str(base_manifest_path),
        "baseNpzPath": str(base_npz_path),
        "trainingManifestPath": str(args.training_manifest.resolve()),
        "coveredCardCount": len(photo_idx_by_pid),
        "totalUserPhotos": total_photos,
        "userPhotoWeight": args.user_photo_weight,
        "rowCount": len(new_entries),
        "modelId": args.model_id,
        "embeddingDim": int(encoder.embedding_dim),
    }
    report_path.write_text(json.dumps(report, indent=2))

    print(f"Wrote NPZ: {npz_path}")
    print(f"Wrote manifest: {manifest_path}")
    print(f"Wrote report: {report_path}")
    print(f"Blended {len(photo_idx_by_pid)} cards using {total_photos} user photos. Row count unchanged at {len(new_entries)}.")


if __name__ == "__main__":
    main()
