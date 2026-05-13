#!/usr/bin/env python3
"""Re-encode an existing visual index from its cached reference images.

Reads the source manifest, loads each entry's referenceImagePath, runs the
images through the current encoder (which may use updated preprocessing
such as letterbox-to-square), and writes a new NPZ + manifest pair.

Lets us A/B preprocessing changes without re-fetching from Scrydex.
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-manifest",
        type=Path,
        default=Path("backend/data/visual-index/visual_index_active_manifest.json"),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("backend/data/visual-index"),
    )
    parser.add_argument(
        "--artifact-version",
        required=True,
        help="Version label, e.g. v011-letterbox",
    )
    parser.add_argument("--model-id", default=DEFAULT_VISUAL_MODEL_ID)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"])
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--limit", type=int, default=0, help="Optional cap for smoke testing")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source_manifest_path = args.source_manifest.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    source_manifest = json.loads(source_manifest_path.read_text())
    entries = [entry for entry in source_manifest.get("entries", []) if isinstance(entry, dict)]
    if args.limit > 0:
        entries = entries[: args.limit]
    if not entries:
        raise SystemExit(f"No entries in {source_manifest_path}")

    # Verify all referenced images are present on disk before doing real work.
    missing: list[str] = []
    for entry in entries:
        ref_path = Path(str(entry.get("referenceImagePath") or "")).expanduser()
        if not ref_path.exists():
            missing.append(str(ref_path))
    if missing:
        print(f"ERROR: {len(missing)} cached reference images missing. First 5:", file=sys.stderr)
        for path in missing[:5]:
            print(f"  {path}", file=sys.stderr)
        raise SystemExit(1)

    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    print(f"Encoder ready. Device={encoder.device}. {len(entries)} entries to re-encode.", flush=True)

    embeddings_chunks: list[np.ndarray] = []
    total = len(entries)
    for start in range(0, total, args.batch_size):
        batch = entries[start : start + args.batch_size]
        images = [Image.open(Path(str(entry["referenceImagePath"]))).convert("RGB") for entry in batch]
        try:
            embeddings = encoder.embed_images(images, batch_size=len(images))
        finally:
            for image in images:
                image.close()
        embeddings_chunks.append(embeddings)
        if start == 0 or (start // args.batch_size) % 25 == 0 or start + args.batch_size >= total:
            print(f"  {min(start + args.batch_size, total)}/{total}", flush=True)
    matrix = np.concatenate(embeddings_chunks, axis=0).astype(np.float32)
    assert matrix.shape == (total, encoder.embedding_dim), f"shape mismatch: {matrix.shape}"

    model_slug = args.model_id.split("/")[-1].lower()
    artifact_stem = f"visual_index_{args.artifact_version}"
    npz_path = output_dir / f"{artifact_stem}_{model_slug}.npz"
    manifest_path = output_dir / f"{artifact_stem}_manifest.json"
    report_path = output_dir / f"{artifact_stem}_build_report.json"

    np.savez(npz_path, embeddings=matrix)
    new_manifest = {
        "generatedAt": utc_now_iso(),
        "provider": source_manifest.get("provider"),
        "artifactVersion": args.artifact_version,
        "modelId": args.model_id,
        "cropPreset": source_manifest.get("cropPreset"),
        "cropBoxNormalized": source_manifest.get("cropBoxNormalized"),
        "adapterCheckpointPath": None,
        "adapterMetadataPath": None,
        "adapterMetadata": None,
        "baseIndexNpzPath": str(source_manifest_path.parent / f"visual_index_active_{model_slug}.npz"),
        "baseIndexManifestPath": str(source_manifest_path),
        "embeddingDimension": int(encoder.embedding_dim),
        "entryCount": total,
        "reencodedFrom": str(source_manifest_path),
        "preprocessing": {
            "letterboxToSquare": True,
            "padRGB": [114, 114, 114],
        },
        "entries": [
            {
                "rowIndex": idx,
                "providerCardId": entry.get("providerCardId"),
                "sourceProvider": entry.get("sourceProvider"),
                "sourceRecordID": entry.get("sourceRecordID"),
                "name": entry.get("name"),
                "collectorNumber": entry.get("collectorNumber"),
                "supertype": entry.get("supertype"),
                "language": entry.get("language"),
                "setId": entry.get("setId"),
                "setName": entry.get("setName"),
                "setSeries": entry.get("setSeries"),
                "setPtcgoCode": entry.get("setPtcgoCode"),
                "setReleaseDate": entry.get("setReleaseDate"),
                "imageUrl": entry.get("imageUrl"),
                "referenceImagePath": entry.get("referenceImagePath"),
                "embeddingModel": args.model_id,
                "artifactVersion": args.artifact_version,
            }
            for idx, entry in enumerate(entries)
        ],
    }
    manifest_path.write_text(json.dumps(new_manifest, indent=2))
    report = {
        "generatedAt": utc_now_iso(),
        "artifactVersion": args.artifact_version,
        "sourceManifest": str(source_manifest_path),
        "modelId": args.model_id,
        "entryCount": total,
        "embeddingDimension": int(encoder.embedding_dim),
        "preprocessing": {"letterboxToSquare": True, "padRGB": [114, 114, 114]},
    }
    report_path.write_text(json.dumps(report, indent=2))

    print(f"Wrote NPZ: {npz_path}")
    print(f"Wrote manifest: {manifest_path}")
    print(f"Wrote report: {report_path}")


if __name__ == "__main__":
    main()
