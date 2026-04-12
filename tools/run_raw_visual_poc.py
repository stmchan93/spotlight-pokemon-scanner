#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import numpy as np
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor


USER_AGENT = "SpotlightScanner/0.1 (+https://local.spotlight.app)"
DEFAULT_CROP_PRESET = "none"
ARTWORK_V1_CROP_BOX = (
    30.0 / 630.0,
    80.0 / 880.0,
    570.0 / 630.0,
    440.0 / 880.0,
)


@dataclass(frozen=True)
class FixtureTruth:
    card_name: str
    collector_number: str
    set_code: str | None

    @property
    def truth_key(self) -> str:
        return f"{self.card_name}|{self.collector_number}|{self.set_code or ''}"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def truth_from_directory(directory: Path) -> FixtureTruth:
    data = load_json(directory / "truth.json")
    return FixtureTruth(
        card_name=str(data["cardName"]).strip(),
        collector_number=str(data["collectorNumber"]).strip(),
        set_code=(str(data.get("setCode")).strip() or None) if data.get("setCode") is not None else None,
    )


def rate(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return numerator / denominator


def download_image(url: str) -> Image.Image:
    request = Request(url)
    request.add_header("User-Agent", USER_AGENT)
    with urlopen(request, timeout=20) as response:
        return Image.open(io.BytesIO(response.read())).convert("RGB")


def load_local_image(path: Path) -> Image.Image:
    return Image.open(path).convert("RGB")


def crop_box_for_preset(preset: str) -> tuple[float, float, float, float] | None:
    normalized = preset.strip().lower()
    if normalized in {"", "none", "full_card"}:
        return None
    if normalized == "artwork_v1":
        return ARTWORK_V1_CROP_BOX
    raise SystemExit(f"Unsupported crop preset: {preset}")


def apply_crop_preset(image: Image.Image, preset: str) -> Image.Image:
    crop_box = crop_box_for_preset(preset)
    if crop_box is None:
        return image
    x, y, width, height = crop_box
    image_width, image_height = image.size
    left = max(0, min(image_width - 1, int(round(x * image_width))))
    top = max(0, min(image_height - 1, int(round(y * image_height))))
    right = max(left + 1, min(image_width, int(round((x + width) * image_width))))
    bottom = max(top + 1, min(image_height, int(round((y + height) * image_height))))
    return image.crop((left, top, right, bottom))


def cosine_topk(query_vector: np.ndarray, reference_vectors: np.ndarray, top_k: int) -> list[tuple[int, float]]:
    sanitized_query = np.nan_to_num(query_vector.astype(np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    sanitized_refs = np.nan_to_num(reference_vectors.astype(np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    scores = np.sum(sanitized_refs * sanitized_query[None, :], axis=1, dtype=np.float64)
    if top_k >= len(scores):
        top_indices = np.argsort(scores)[::-1]
    else:
        top_indices = np.argpartition(scores, -top_k)[-top_k:]
        top_indices = top_indices[np.argsort(scores[top_indices])[::-1]]
    return [(int(index), float(scores[index])) for index in top_indices]


def normalized_image_embedding(
    model: CLIPModel,
    processor: CLIPProcessor,
    image: Image.Image,
    device: torch.device,
) -> np.ndarray:
    inputs = processor(images=image, return_tensors="pt")
    inputs = {key: value.to(device) for key, value in inputs.items()}
    with torch.inference_mode():
        features = model.get_image_features(**inputs)
        features = torch.nn.functional.normalize(features, p=2, dim=-1)
    embedding = features[0].detach().cpu().numpy().astype(np.float32)
    embedding = np.nan_to_num(embedding, nan=0.0, posinf=0.0, neginf=0.0)
    norm = np.linalg.norm(embedding)
    if norm > 0:
        embedding = embedding / norm
    return embedding


def ensure_reference_cache(entry: dict[str, Any], cache_root: Path) -> Path:
    provider_card_id = str(entry["providerCardId"])
    suffix = ".png"
    reference_url = str(entry["referenceImageUrl"])
    if reference_url.lower().endswith(".jpg") or reference_url.lower().endswith(".jpeg"):
        suffix = ".jpg"
    cache_path = cache_root / f"{provider_card_id}{suffix}"
    if not cache_path.exists():
        image = download_image(reference_url)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(cache_path)
    return cache_path


def load_supported_manifest_entries(manifest_path: Path) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    manifest = load_json(manifest_path)
    entries = [entry for entry in manifest.get("entries", []) if entry.get("providerSupported")]
    by_truth_key = {str(entry["truthKey"]): entry for entry in entries}
    return entries, by_truth_key


def load_full_index(index_npz_path: Path, index_manifest_path: Path) -> tuple[np.ndarray, list[dict[str, Any]], dict[str, Any]]:
    manifest = load_json(index_manifest_path)
    npz = np.load(index_npz_path)
    embeddings = np.asarray(npz["embeddings"], dtype=np.float32)
    rows = [entry for entry in manifest.get("entries", []) if isinstance(entry, dict)]
    if embeddings.ndim != 2:
        raise SystemExit(f"Expected a 2D embeddings matrix in {index_npz_path}, got shape {embeddings.shape}")
    if len(rows) != int(embeddings.shape[0]):
        raise SystemExit(
            f"Index manifest row count ({len(rows)}) does not match embedding row count ({embeddings.shape[0]})"
        )
    return embeddings, rows, manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the raw visual matching proof-of-concept against normalized fixture images.")
    parser.add_argument(
        "--fixture-root",
        type=Path,
        default=Path("qa/raw-footer-layout-check"),
        help="Path to the raw footer layout check fixture root.",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("qa/raw-footer-layout-check/provider_reference_manifest.json"),
        help="Path to the provider reference manifest.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("qa/raw-footer-layout-check/raw_visual_poc_scorecard.json"),
        help="Path to write the raw visual POC scorecard JSON.",
    )
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=Path("qa/raw-footer-layout-check/.visual_reference_cache"),
        help="Cache directory for downloaded reference images.",
    )
    parser.add_argument(
        "--model-id",
        default="openai/clip-vit-base-patch32",
        help="Transformers image model id to use for the proof-of-concept.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=5,
        help="How many nearest visual matches to keep for scoring.",
    )
    parser.add_argument(
        "--index-npz",
        type=Path,
        default=None,
        help="Optional path to a prebuilt NPZ embedding matrix for full-index scoring.",
    )
    parser.add_argument(
        "--index-manifest",
        type=Path,
        default=None,
        help="Optional path to the manifest for a prebuilt full index. Must be used with --index-npz.",
    )
    parser.add_argument(
        "--crop-preset",
        default=DEFAULT_CROP_PRESET,
        help="Optional crop preset to apply before embedding query images. Use 'artwork_v1' for the artwork-only experiment.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    fixture_root = args.fixture_root.resolve()
    manifest_path = args.manifest.resolve()
    output_path = args.output.resolve()
    cache_root = args.cache_root.resolve()
    top_k = args.top_k

    manifest_entries, manifest_by_truth_key = load_supported_manifest_entries(manifest_path)
    if not manifest_entries:
        raise SystemExit(f"No provider-supported manifest entries found in {manifest_path}")
    if (args.index_npz is None) != (args.index_manifest is None):
        raise SystemExit("Use --index-npz and --index-manifest together, or omit both.")

    device = torch.device("cpu")
    processor = CLIPProcessor.from_pretrained(args.model_id, use_fast=False)
    model = CLIPModel.from_pretrained(args.model_id).to(device)
    model.eval()

    using_prebuilt_index = args.index_npz is not None
    effective_crop_preset = args.crop_preset
    if using_prebuilt_index:
        reference_matrix, manifest_rows, index_manifest = load_full_index(args.index_npz.resolve(), args.index_manifest.resolve())
        if effective_crop_preset in {"", "none", "full_card"}:
            effective_crop_preset = str(index_manifest.get("cropPreset") or DEFAULT_CROP_PRESET)
        reference_rows = [
            {
                "providerCardId": row.get("providerCardId"),
                "providerName": row.get("name"),
                "providerCollectorNumber": row.get("collectorNumber"),
                "providerSetId": row.get("setId"),
                "providerSetPtcgoCode": row.get("setPtcgoCode"),
                "providerSetName": row.get("setName"),
                "referenceImagePath": row.get("referenceImagePath"),
            }
            for row in manifest_rows
        ]
    else:
        reference_rows = []
        reference_vectors: list[np.ndarray] = []
        for entry in manifest_entries:
            cache_path = ensure_reference_cache(entry, cache_root)
            image = apply_crop_preset(load_local_image(cache_path), effective_crop_preset)
            embedding = normalized_image_embedding(model, processor, image, device)
            reference_rows.append(
                {
                    "providerCardId": entry["providerCardId"],
                    "providerName": entry["providerName"],
                    "providerCollectorNumber": entry["providerCollectorNumber"],
                    "providerSetId": entry["providerSetId"],
                    "providerSetPtcgoCode": entry["providerSetPtcgoCode"],
                    "providerSetName": entry["providerSetName"],
                    "referenceImagePath": str(cache_path),
                }
            )
            reference_vectors.append(embedding)

        reference_matrix = np.stack(reference_vectors, axis=0)

    entries: list[dict[str, Any]] = []
    supported_fixture_count = 0
    unsupported_fixture_count = 0
    top1_pass_count = 0
    topk_contains_truth_count = 0

    for directory in sorted(fixture_root.iterdir()):
        if not directory.is_dir():
            continue
        truth_path = directory / "truth.json"
        normalized_path = directory / "runtime_normalized.jpg"
        if not truth_path.exists():
            continue

        truth = truth_from_directory(directory)
        manifest_entry = manifest_by_truth_key.get(truth.truth_key)
        if manifest_entry is None:
            unsupported_fixture_count += 1
            entries.append(
                {
                    "fixtureName": directory.name,
                    "providerSupported": False,
                    "queryImage": str(normalized_path.name if normalized_path.exists() else "runtime_normalized.jpg"),
                    "truth": {
                        "cardName": truth.card_name,
                        "collectorNumber": truth.collector_number,
                        "setCode": truth.set_code,
                    },
                    "reason": "No provider-supported mapping was available for this truth key.",
                    "top1Pass": False,
                    "topKContainsTruth": False,
                    "candidateSummaries": [],
                }
            )
            continue

        if not normalized_path.exists():
            unsupported_fixture_count += 1
            entries.append(
                {
                    "fixtureName": directory.name,
                    "providerSupported": False,
                    "queryImage": "runtime_normalized.jpg",
                    "truth": {
                        "cardName": truth.card_name,
                        "collectorNumber": truth.collector_number,
                        "setCode": truth.set_code,
                    },
                    "reason": "Normalized query image is missing. Generate runtime_normalized.jpg first.",
                    "top1Pass": False,
                    "topKContainsTruth": False,
                    "candidateSummaries": [],
                }
            )
            continue

        supported_fixture_count += 1
        query_image = apply_crop_preset(load_local_image(normalized_path), effective_crop_preset)
        query_embedding = normalized_image_embedding(model, processor, query_image, device)
        ranked = cosine_topk(query_embedding, reference_matrix, top_k)

        provider_card_id = str(manifest_entry["providerCardId"])
        candidate_summaries = []
        top1_pass = False
        topk_contains_truth = False
        for rank, (index, score) in enumerate(ranked, start=1):
            row = reference_rows[index]
            is_truth = str(row["providerCardId"]) == provider_card_id
            topk_contains_truth = topk_contains_truth or is_truth
            if rank == 1 and is_truth:
                top1_pass = True
            candidate_summaries.append(
                {
                    "rank": rank,
                    "providerCardId": row["providerCardId"],
                    "providerName": row["providerName"],
                    "providerCollectorNumber": row["providerCollectorNumber"],
                    "providerSetId": row["providerSetId"],
                    "providerSetPtcgoCode": row["providerSetPtcgoCode"],
                    "providerSetName": row["providerSetName"],
                    "similarity": round(score, 6),
                    "isTruth": is_truth,
                }
            )

        if top1_pass:
            top1_pass_count += 1
        if topk_contains_truth:
            topk_contains_truth_count += 1

        entries.append(
            {
                "fixtureName": directory.name,
                "providerSupported": True,
                "queryImage": normalized_path.name,
                "truth": {
                    "cardName": truth.card_name,
                    "collectorNumber": truth.collector_number,
                    "setCode": truth.set_code,
                    "providerCardId": provider_card_id,
                },
                "top1Pass": top1_pass,
                "topKContainsTruth": topk_contains_truth,
                "candidateSummaries": candidate_summaries,
            }
        )

    scorecard = {
        "generatedAt": utc_now_iso(),
        "modelId": args.model_id,
        "embeddingDimension": int(reference_matrix.shape[1]),
        "topK": top_k,
        "cropPreset": effective_crop_preset,
        "cropBoxNormalized": crop_box_for_preset(effective_crop_preset),
        "referenceMode": "prebuilt_full_index" if using_prebuilt_index else "seed_reference_subset",
        "indexNpzPath": str(args.index_npz.resolve()) if args.index_npz else None,
        "indexManifestPath": str(args.index_manifest.resolve()) if args.index_manifest else None,
        "providerSupportedFixtureCount": supported_fixture_count,
        "providerUnsupportedFixtureCount": unsupported_fixture_count,
        "top1PassCount": top1_pass_count,
        "topKContainsTruthCount": topk_contains_truth_count,
        "top1PassRate": rate(top1_pass_count, supported_fixture_count),
        "topKContainsTruthRate": rate(topk_contains_truth_count, supported_fixture_count),
        "entries": entries,
    }
    output_path.write_text(json.dumps(scorecard, indent=2) + "\n")

    print(f"Wrote raw visual POC scorecard to {output_path}")
    print(f"Model: {args.model_id} ({reference_matrix.shape[1]} dims)")
    print(f"Provider-supported fixtures: {supported_fixture_count}")
    print(f"Provider-unsupported fixtures: {unsupported_fixture_count}")
    print(f"Top-1 accuracy: {top1_pass_count}/{supported_fixture_count} ({rate(top1_pass_count, supported_fixture_count):.1%})")
    print(
        f"Top-{top_k} contains-truth rate: "
        f"{topk_contains_truth_count}/{supported_fixture_count} ({rate(topk_contains_truth_count, supported_fixture_count):.1%})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
