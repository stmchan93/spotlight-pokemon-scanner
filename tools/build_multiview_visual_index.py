#!/usr/bin/env python3
"""Build a multi-view visual index.

Starts from an existing base index (one Scrydex render per card) and
appends user-photo rows from the training manifest, after defensively
excluding any photo whose truth key overlaps the held-out fixture sets.

Each appended row gets its own embedding but reuses the same
providerCardId. Downstream retrieval should score each card by the
best-matching row.
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


def truth_key(card_name: str, collector_number: str, set_code: str) -> str:
    return f"{card_name.strip()}|{collector_number.strip()}|{set_code.strip()}"


def name_number_key(card_name: str, collector_number: str) -> str:
    return f"{card_name.strip().lower()}|{collector_number.strip()}"


def collect_holdout_keys(holdout_roots: list[Path]) -> tuple[set[str], set[str]]:
    truth_keys: set[str] = set()
    name_number_keys: set[str] = set()
    for root in holdout_roots:
        if not root.exists():
            continue
        for tjson in root.rglob("truth.json"):
            payload = json.loads(tjson.read_text())
            name = str(payload.get("cardName") or "")
            num = str(payload.get("collectorNumber") or "")
            setc = str(payload.get("setCode") or "")
            truth_keys.add(truth_key(name, num, setc))
            name_number_keys.add(name_number_key(name, num))
    return truth_keys, name_number_keys


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
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("backend/data/visual-index"),
    )
    parser.add_argument(
        "--artifact-version",
        default="v012-multiview",
    )
    parser.add_argument("--model-id", default=DEFAULT_VISUAL_MODEL_ID)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"])
    parser.add_argument("--batch-size", type=int, default=64)
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

    holdout_truth_keys, holdout_name_number_keys = collect_holdout_keys(
        [p.resolve() for p in args.holdout_roots]
    )
    print(f"[multiview] held-out exclusion set: {len(holdout_truth_keys)} truth keys", flush=True)

    # Load training manifest, filter to keep
    training_rows = []
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
            if name_number_key(name, num) in holdout_name_number_keys:
                continue
            pid = str(row.get("providerCardId") or "").strip()
            normalized_path = Path(str(row.get("normalizedImagePath") or ""))
            if not pid or not normalized_path.exists():
                continue
            training_rows.append({
                "providerCardId": pid,
                "normalizedImagePath": str(normalized_path.resolve()),
                "fixtureName": row.get("fixtureName"),
                "cardName": name,
                "collectorNumber": num,
                "setCode": setc,
            })

    unique_pids = {r["providerCardId"] for r in training_rows}
    print(f"[multiview] survivors: {len(training_rows)} photos across {len(unique_pids)} unique cards", flush=True)
    if not training_rows:
        raise SystemExit("No surviving training rows to add.")

    # Encode the survivors
    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    print(f"[multiview] encoder ready on {encoder.device}", flush=True)

    new_embeddings_chunks: list[np.ndarray] = []
    total = len(training_rows)
    for start in range(0, total, args.batch_size):
        batch = training_rows[start : start + args.batch_size]
        images = [Image.open(r["normalizedImagePath"]).convert("RGB") for r in batch]
        try:
            embeddings = encoder.embed_images(images, batch_size=len(images))
        finally:
            for image in images:
                image.close()
        new_embeddings_chunks.append(embeddings)
        if start == 0 or (start // args.batch_size) % 5 == 0 or start + args.batch_size >= total:
            print(f"  {min(start + args.batch_size, total)}/{total}", flush=True)
    new_matrix = np.concatenate(new_embeddings_chunks, axis=0).astype(np.float32)
    assert new_matrix.shape[0] == total

    # Build provider->base-entry lookup so user-photo entries can copy provider metadata
    base_by_pid: dict[str, dict[str, Any]] = {}
    for entry in base_entries:
        pid = str(entry.get("providerCardId") or "").strip()
        if pid and pid not in base_by_pid:
            base_by_pid[pid] = entry

    # Build the new manifest: base rows kept verbatim, then training rows
    new_entries: list[dict[str, Any]] = []
    for idx, entry in enumerate(base_entries):
        new_entry = dict(entry)
        new_entry["rowIndex"] = idx
        new_entry["rowSource"] = "scrydex"
        new_entries.append(new_entry)

    base_count = len(base_entries)
    for offset, row in enumerate(training_rows):
        idx = base_count + offset
        base_meta = base_by_pid.get(row["providerCardId"], {})
        entry = {
            "rowIndex": idx,
            "providerCardId": row["providerCardId"],
            "sourceProvider": base_meta.get("sourceProvider", "scrydex"),
            "sourceRecordID": base_meta.get("sourceRecordID", row["providerCardId"]),
            "name": base_meta.get("name", row["cardName"]),
            "collectorNumber": base_meta.get("collectorNumber", row["collectorNumber"]),
            "supertype": base_meta.get("supertype"),
            "language": base_meta.get("language"),
            "setId": base_meta.get("setId"),
            "setName": base_meta.get("setName"),
            "setSeries": base_meta.get("setSeries"),
            "setPtcgoCode": base_meta.get("setPtcgoCode") or row["setCode"],
            "setReleaseDate": base_meta.get("setReleaseDate"),
            "imageUrl": base_meta.get("imageUrl"),
            "referenceImagePath": row["normalizedImagePath"],
            "embeddingModel": args.model_id,
            "artifactVersion": args.artifact_version,
            "rowSource": "user_photo",
            "fixtureName": row["fixtureName"],
        }
        new_entries.append(entry)

    combined_matrix = np.concatenate([base_matrix, new_matrix], axis=0).astype(np.float32)
    assert combined_matrix.shape[0] == len(new_entries)

    model_slug = args.model_id.split("/")[-1].lower()
    artifact_stem = f"visual_index_{args.artifact_version}"
    npz_path = output_dir / f"{artifact_stem}_{model_slug}.npz"
    manifest_path = output_dir / f"{artifact_stem}_manifest.json"
    report_path = output_dir / f"{artifact_stem}_build_report.json"

    np.savez(npz_path, embeddings=combined_matrix)

    new_manifest = dict(base_manifest)
    new_manifest["generatedAt"] = utc_now_iso()
    new_manifest["artifactVersion"] = args.artifact_version
    new_manifest["entryCount"] = len(new_entries)
    new_manifest["baseManifestPath"] = str(base_manifest_path)
    new_manifest["multiview"] = {
        "trainingManifestPath": str(args.training_manifest.resolve()),
        "holdoutRoots": [str(p.resolve()) for p in args.holdout_roots],
        "scrydexRowCount": base_count,
        "userPhotoRowCount": total,
        "uniqueUserPhotoCardCount": len(unique_pids),
    }
    new_manifest["entries"] = new_entries
    manifest_path.write_text(json.dumps(new_manifest, indent=2))

    report = {
        "generatedAt": utc_now_iso(),
        "artifactVersion": args.artifact_version,
        "baseManifestPath": str(base_manifest_path),
        "baseNpzPath": str(base_npz_path),
        "trainingManifestPath": str(args.training_manifest.resolve()),
        "holdoutRoots": [str(p.resolve()) for p in args.holdout_roots],
        "scrydexRowCount": base_count,
        "userPhotoRowCount": total,
        "uniqueUserPhotoCardCount": len(unique_pids),
        "totalRowCount": len(new_entries),
        "modelId": args.model_id,
        "embeddingDim": int(encoder.embedding_dim),
    }
    report_path.write_text(json.dumps(report, indent=2))

    print(f"Wrote NPZ: {npz_path}")
    print(f"Wrote manifest: {manifest_path}")
    print(f"Wrote report: {report_path}")
    print(f"Total rows: {len(new_entries)}  (scrydex={base_count}, user_photo={total})")


if __name__ == "__main__":
    main()
