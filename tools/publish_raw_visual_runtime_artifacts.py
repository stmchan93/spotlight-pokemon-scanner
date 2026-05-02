#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if not (BACKEND_ROOT / "server.py").exists():
    BACKEND_ROOT = REPO_ROOT
DEFAULT_INDEX_DIR = BACKEND_ROOT / "data" / "visual-index"
DEFAULT_MODEL_DIR = BACKEND_ROOT / "data" / "visual-models"


def utc_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Publish versioned raw visual index/model artifacts to stable active runtime paths."
    )
    parser.add_argument(
        "--artifact-version",
        required=True,
        help="Artifact version stem, for example v004-scrydex-b8.",
    )
    parser.add_argument(
        "--base-artifact-version",
        default="",
        help="Optional base index artifact version when the adapter/index use different stems.",
    )
    parser.add_argument(
        "--index-dir",
        type=Path,
        default=DEFAULT_INDEX_DIR,
        help="Directory containing visual index artifacts.",
    )
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=DEFAULT_MODEL_DIR,
        help="Directory containing trained adapter artifacts.",
    )
    parser.add_argument(
        "--model-suffix",
        default="clip-vit-base-patch32",
        help="Visual index model suffix used in the artifact filenames.",
    )
    return parser.parse_args()


def copy_required(source: Path, destination: Path) -> None:
    if not source.exists():
        raise SystemExit(f"Missing required artifact: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def main() -> None:
    args = parse_args()

    index_dir = args.index_dir.resolve()
    model_dir = args.model_dir.resolve()
    artifact_version = args.artifact_version.strip()
    base_artifact_version = (args.base_artifact_version or artifact_version).strip()

    source_index_npz = index_dir / f"visual_index_{artifact_version}_{args.model_suffix}.npz"
    source_index_manifest = index_dir / f"visual_index_{artifact_version}_manifest.json"
    source_adapter_checkpoint = model_dir / f"raw_visual_adapter_{base_artifact_version}.pt"
    source_adapter_metadata = model_dir / f"raw_visual_adapter_{base_artifact_version}_metadata.json"

    active_index_npz = index_dir / f"visual_index_active_{args.model_suffix}.npz"
    active_index_manifest = index_dir / "visual_index_active_manifest.json"
    active_adapter_checkpoint = model_dir / "raw_visual_adapter_active.pt"
    active_adapter_metadata = model_dir / "raw_visual_adapter_active_metadata.json"
    active_runtime_metadata = model_dir / "raw_visual_runtime_active.json"

    copy_required(source_index_npz, active_index_npz)
    copy_required(source_index_manifest, active_index_manifest)
    copy_required(source_adapter_checkpoint, active_adapter_checkpoint)
    copy_required(source_adapter_metadata, active_adapter_metadata)

    active_runtime_payload = {
        "publishedAt": utc_now_iso(),
        "artifactVersion": artifact_version,
        "baseArtifactVersion": base_artifact_version,
        "modelSuffix": args.model_suffix,
        "indexNpzPath": str(active_index_npz),
        "indexManifestPath": str(active_index_manifest),
        "adapterCheckpointPath": str(active_adapter_checkpoint),
        "adapterMetadataPath": str(active_adapter_metadata),
        "sourceArtifacts": {
            "indexNpzPath": str(source_index_npz),
            "indexManifestPath": str(source_index_manifest),
            "adapterCheckpointPath": str(source_adapter_checkpoint),
            "adapterMetadataPath": str(source_adapter_metadata),
        },
    }
    active_runtime_metadata.write_text(json.dumps(active_runtime_payload, indent=2) + "\n")

    print(f"Published active index: {active_index_npz}")
    print(f"Published active manifest: {active_index_manifest}")
    print(f"Published active adapter: {active_adapter_checkpoint}")
    print(f"Published active adapter metadata: {active_adapter_metadata}")
    print(f"Wrote runtime metadata: {active_runtime_metadata}")


if __name__ == "__main__":
    main()
