#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import io
import json
import os
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor


API_BASE_URL = "https://api.pokemontcg.io/v2/cards"
SETS_API_BASE_URL = "https://api.pokemontcg.io/v2/sets"
USER_AGENT = "SpotlightScanner/0.1 (+https://local.spotlight.app)"
DEFAULT_FIELDS = [
    "id",
    "name",
    "number",
    "images",
    "set",
    "supertype",
]
DEFAULT_SUPERTYPES = ["pokemon", "trainer", "energy"]
SET_FIELDS = [
    "id",
    "name",
    "series",
    "releaseDate",
    "printedTotal",
    "total",
]
DEFAULT_CROP_PRESET = "none"
ARTWORK_V1_CROP_BOX = (
    30.0 / 630.0,
    80.0 / 880.0,
    570.0 / 630.0,
    440.0 / 880.0,
)


@dataclass(frozen=True)
class BuildArtifactPaths:
    npz_path: Path
    manifest_path: Path
    build_report_path: Path
    metadata_cache_path: Path
    image_cache_root: Path


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sanitize_model_slug(model_id: str) -> str:
    slug = model_id.split("/")[-1].strip().lower()
    return "".join(character if character.isalnum() or character in {"-", "_"} else "-" for character in slug)


def normalize_supertype(value: str | None) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    ascii_text = text.encode("ascii", "ignore").decode("ascii")
    return ascii_text.strip().lower()


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the full offline raw visual reference index from Pokémon TCG API images.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("backend/data/visual-index"),
        help="Directory where the index artifact, manifest, and caches should be written.",
    )
    parser.add_argument(
        "--artifact-version",
        default="v001",
        help="Version label to embed in artifact filenames and manifest metadata.",
    )
    parser.add_argument(
        "--model-id",
        default="openai/clip-vit-base-patch32",
        help="Transformers CLIP model id to use for the full index build.",
    )
    parser.add_argument(
        "--supertypes",
        nargs="+",
        default=DEFAULT_SUPERTYPES,
        help="Pokémon TCG API supertypes to fetch and combine into the full reference index.",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=250,
        help="Pokémon TCG API page size for catalog fetches.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=64,
        help="How many cached images to embed per CLIP batch.",
    )
    parser.add_argument(
        "--download-workers",
        type=int,
        default=12,
        help="How many reference images to fetch/cache in parallel per batch.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional cap on how many cards to embed after metadata fetch. Useful for smoke tests.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "mps"],
        help="Torch device for embedding inference.",
    )
    parser.add_argument(
        "--refresh-metadata",
        action="store_true",
        help="Ignore the cached provider metadata snapshot and fetch card metadata from the API again.",
    )
    parser.add_argument(
        "--crop-preset",
        default=DEFAULT_CROP_PRESET,
        help="Optional image crop preset to apply before embedding. Use 'artwork_v1' for the artwork-only experiment.",
    )
    return parser.parse_args()


def resolve_device(device_name: str) -> torch.device:
    if device_name == "cpu":
        return torch.device("cpu")
    if device_name == "mps":
        if not torch.backends.mps.is_available():
            raise SystemExit("Requested --device mps, but torch.backends.mps.is_available() is false.")
        return torch.device("mps")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def api_request(url: str, api_key: str | None, *, timeout: int = 30) -> dict[str, Any]:
    request = Request(url)
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", USER_AGENT)
    if api_key:
        request.add_header("X-Api-Key", api_key)
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def build_search_url(query: str, page_size: int, page: int) -> str:
    params = urlencode(
        {
            "q": query,
            "page": page,
            "pageSize": page_size,
            "orderBy": "set.releaseDate,name,number",
            "select": ",".join(DEFAULT_FIELDS),
        }
    )
    return f"{API_BASE_URL}?{params}"


def build_sets_url(page_size: int, page: int) -> str:
    params = urlencode(
        {
            "page": page,
            "pageSize": page_size,
            "orderBy": "releaseDate,name",
            "select": ",".join(SET_FIELDS),
        }
    )
    return f"{SETS_API_BASE_URL}?{params}"


def load_cached_metadata(metadata_cache_path: Path) -> list[dict[str, Any]] | None:
    if not metadata_cache_path.exists():
        return None
    payload = json.loads(metadata_cache_path.read_text())
    entries = payload.get("entries")
    if not isinstance(entries, list):
        return None
    return [entry for entry in entries if isinstance(entry, dict)]


def save_metadata_cache(metadata_cache_path: Path, *, supertypes: list[str], entries: list[dict[str, Any]]) -> None:
    metadata_cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": utc_now_iso(),
        "provider": "pokemontcg_api",
        "sourceQueries": [f"set.id:* filtered-supertypes:{supertype}" for supertype in supertypes],
        "entryCount": len(entries),
        "entries": entries,
    }
    metadata_cache_path.write_text(json.dumps(payload, indent=2))


def dedupe_and_sort_cards(cards: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for card in cards:
        card_id = str(card.get("id") or "").strip()
        if not card_id:
            continue
        by_id[card_id] = card
    return sorted(by_id.values(), key=lambda card: str(card.get("id") or ""))


def fetch_all_sets(api_key: str | None, page_size: int) -> list[dict[str, Any]]:
    page = 1
    sets: list[dict[str, Any]] = []
    while True:
        payload = api_request(build_sets_url(page_size=page_size, page=page), api_key)
        page_sets = [item for item in payload.get("data", []) if isinstance(item, dict)]
        sets.extend(page_sets)
        total_count = int(payload.get("totalCount") or 0)
        if page == 1 or page % 5 == 0 or not page_sets:
            print(f"[metadata] sets page={page} accumulated={len(sets)}/{total_count}", flush=True)
        if not page_sets or len(sets) >= total_count:
            break
        page += 1
    return sorted(sets, key=lambda row: (str(row.get("releaseDate") or ""), str(row.get("id") or "")))


def fetch_cards_for_set(set_id: str, api_key: str | None, page_size: int) -> list[dict[str, Any]]:
    page = 1
    cards: list[dict[str, Any]] = []
    query = f"set.id:{set_id}"
    while True:
        payload = api_request(build_search_url(query, page_size=page_size, page=page), api_key)
        page_cards = [item for item in payload.get("data", []) if isinstance(item, dict)]
        cards.extend(page_cards)
        total_count = int(payload.get("totalCount") or 0)
        if not page_cards or len(cards) >= total_count:
            break
        page += 1
    return cards


def fetch_all_catalog_cards(
    *,
    api_key: str | None,
    supertypes: list[str],
    page_size: int,
    metadata_cache_path: Path,
    refresh_metadata: bool,
    metadata_limit: int,
) -> list[dict[str, Any]]:
    if not refresh_metadata:
        cached = load_cached_metadata(metadata_cache_path)
        if cached is not None:
            print(f"[metadata] using cached card metadata from {metadata_cache_path} ({len(cached)} entries)")
            return cached

    by_id: dict[str, dict[str, Any]] = {}
    wanted_supertypes = {normalize_supertype(supertype) for supertype in supertypes}
    all_sets = fetch_all_sets(api_key, page_size=page_size)
    print(f"[metadata] discovered {len(all_sets)} sets", flush=True)
    for index, set_row in enumerate(all_sets, start=1):
        set_id = str(set_row.get("id") or "").strip()
        if not set_id:
            continue
        set_cards = fetch_cards_for_set(set_id, api_key, page_size)
        kept = 0
        for card in set_cards:
            card_supertype = normalize_supertype(card.get("supertype"))
            if wanted_supertypes and card_supertype not in wanted_supertypes:
                continue
            card_id = str(card.get("id") or "").strip()
            if card_id:
                by_id[card_id] = card
                kept += 1
        if index == 1 or index % 10 == 0 or index == len(all_sets):
            print(
                f"[metadata] set {index}/{len(all_sets)} id={set_id} fetched={len(set_cards)} kept={kept} unique_total={len(by_id)}",
                flush=True,
            )
        if metadata_limit > 0 and len(by_id) >= metadata_limit:
            print(f"[metadata] limit={metadata_limit} reached while fetching set {set_id}", flush=True)
            break

    deduped = dedupe_and_sort_cards(by_id.values())
    if metadata_limit > 0:
        deduped = deduped[:metadata_limit]
    save_metadata_cache(metadata_cache_path, supertypes=supertypes, entries=deduped)
    print(f"[metadata] wrote cache {metadata_cache_path} ({len(deduped)} unique cards)", flush=True)
    return deduped


def download_image(url: str) -> Image.Image:
    request = Request(url)
    request.add_header("Accept", "image/*")
    request.add_header("User-Agent", USER_AGENT)
    with urlopen(request, timeout=30) as response:
        return Image.open(io.BytesIO(response.read())).convert("RGB")


def load_local_image(path: Path) -> Image.Image:
    return Image.open(path).convert("RGB")


def infer_image_suffix(reference_url: str) -> str:
    normalized = reference_url.lower()
    if normalized.endswith(".jpg") or normalized.endswith(".jpeg"):
        return ".jpg"
    return ".png"


def candidate_display_number(card: dict[str, Any]) -> str:
    raw_number = str(card.get("number") or "")
    set_info = card.get("set") or {}
    printed_total = set_info.get("printedTotal")
    set_name = str(set_info.get("name") or "")
    set_series = str(set_info.get("series") or "")
    is_promo_set = "promo" in f"{set_name} {set_series}".lower()
    if printed_total and "/" not in raw_number and not is_promo_set:
        return f"{raw_number}/{printed_total}"
    return raw_number


def ensure_cached_reference_image(card: dict[str, Any], image_cache_root: Path) -> Path:
    card_id = str(card.get("id") or "").strip()
    if not card_id:
        raise ValueError("Cannot cache image for a card without an id.")
    images = card.get("images") or {}
    reference_url = str(images.get("large") or images.get("small") or "").strip()
    if not reference_url:
        raise ValueError(f"Card {card_id} does not include a usable reference image URL.")

    suffix = infer_image_suffix(reference_url)
    cache_path = image_cache_root / f"{card_id}{suffix}"
    if not cache_path.exists():
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        image = download_image(reference_url)
        image.save(cache_path)
    return cache_path


def cached_image_for_card(card: dict[str, Any], image_cache_root: Path) -> tuple[dict[str, Any], Path]:
    return card, ensure_cached_reference_image(card, image_cache_root)


def normalized_image_embeddings_batch(
    model: CLIPModel,
    processor: CLIPProcessor,
    images: list[Image.Image],
    device: torch.device,
) -> np.ndarray:
    inputs = processor(images=images, return_tensors="pt", padding=True)
    inputs = {key: value.to(device) for key, value in inputs.items()}
    with torch.inference_mode():
        features = model.get_image_features(**inputs)
        features = torch.nn.functional.normalize(features, p=2, dim=-1)
    embeddings = features.detach().cpu().numpy().astype(np.float32)
    embeddings = np.nan_to_num(embeddings, nan=0.0, posinf=0.0, neginf=0.0)
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return embeddings / norms


def batch_iterable(values: list[dict[str, Any]], batch_size: int) -> Iterable[list[dict[str, Any]]]:
    for index in range(0, len(values), batch_size):
        yield values[index : index + batch_size]


def build_artifact_paths(output_dir: Path, artifact_version: str, model_id: str) -> BuildArtifactPaths:
    model_slug = sanitize_model_slug(model_id)
    cache_root = output_dir / ".cache"
    return BuildArtifactPaths(
        npz_path=output_dir / f"visual_index_{artifact_version}_{model_slug}.npz",
        manifest_path=output_dir / f"visual_index_{artifact_version}_manifest.json",
        build_report_path=output_dir / f"visual_index_{artifact_version}_build_report.json",
        metadata_cache_path=cache_root / "pokemontcg_cards_metadata.json",
        image_cache_root=cache_root / "reference_images",
    )


def manifest_entry_for_row(
    *,
    row_index: int,
    card: dict[str, Any],
    reference_image_path: Path,
    artifact_version: str,
    model_id: str,
) -> dict[str, Any]:
    set_info = card.get("set") or {}
    images = card.get("images") or {}
    return {
        "rowIndex": row_index,
        "providerCardId": card.get("id"),
        "name": card.get("name"),
        "collectorNumber": candidate_display_number(card),
        "supertype": card.get("supertype"),
        "setId": set_info.get("id"),
        "setName": set_info.get("name"),
        "setSeries": set_info.get("series"),
        "setPtcgoCode": set_info.get("ptcgoCode"),
        "setReleaseDate": set_info.get("releaseDate"),
        "imageUrl": images.get("large") or images.get("small"),
        "referenceImagePath": str(reference_image_path),
        "embeddingModel": model_id,
        "artifactVersion": artifact_version,
    }


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))


def main() -> int:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    artifact_paths = build_artifact_paths(output_dir, args.artifact_version, args.model_id)
    api_key = os.environ.get("POKEMONTCG_API_KEY", "").strip() or None
    device = resolve_device(args.device)

    print(f"[build] output_dir={output_dir}", flush=True)
    print(f"[build] artifact_version={args.artifact_version}", flush=True)
    print(f"[build] model_id={args.model_id}", flush=True)
    print(f"[build] device={device}", flush=True)
    print(f"[build] crop_preset={args.crop_preset}", flush=True)

    catalog_cards = fetch_all_catalog_cards(
        api_key=api_key,
        supertypes=[value.lower() for value in args.supertypes],
        page_size=args.page_size,
        metadata_cache_path=artifact_paths.metadata_cache_path,
        refresh_metadata=args.refresh_metadata,
        metadata_limit=args.limit,
    )
    if args.limit > 0:
        catalog_cards = catalog_cards[: args.limit]
        print(f"[build] applying limit={args.limit}; embedding {len(catalog_cards)} cards", flush=True)

    processor = CLIPProcessor.from_pretrained(args.model_id, use_fast=False)
    model = CLIPModel.from_pretrained(args.model_id).to(device)
    model.eval()

    manifest_entries: list[dict[str, Any]] = []
    embeddings: list[np.ndarray] = []
    skipped: list[dict[str, Any]] = []

    total_cards = len(catalog_cards)
    for batch_number, batch_cards in enumerate(batch_iterable(catalog_cards, args.batch_size), start=1):
        batch_cards_with_images: list[tuple[dict[str, Any], Path]] = []

        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.download_workers)) as executor:
            future_to_card = {
                executor.submit(cached_image_for_card, card, artifact_paths.image_cache_root): card for card in batch_cards
            }
            for future in concurrent.futures.as_completed(future_to_card):
                card = future_to_card[future]
                try:
                    resolved_card, reference_image_path = future.result()
                    batch_cards_with_images.append((resolved_card, reference_image_path))
                except Exception as exc:
                    skipped.append(
                        {
                            "providerCardId": card.get("id"),
                            "reason": f"image_error: {exc}",
                        }
                    )

        batch_cards_with_images.sort(key=lambda row: str(row[0].get("id") or ""))
        loaded_batch_cards_with_images: list[tuple[dict[str, Any], Path]] = []
        batch_images: list[Image.Image] = []
        for card, reference_image_path in batch_cards_with_images:
            try:
                batch_images.append(apply_crop_preset(load_local_image(reference_image_path), args.crop_preset))
                loaded_batch_cards_with_images.append((card, reference_image_path))
            except Exception as exc:
                skipped.append(
                    {
                        "providerCardId": card.get("id"),
                        "reason": f"image_load_error: {exc}",
                    }
                )
        batch_cards_with_images = loaded_batch_cards_with_images

        if not batch_cards_with_images:
            continue

        try:
            batch_embeddings = normalized_image_embeddings_batch(model, processor, batch_images, device)
        except Exception as exc:
            for card, _ in batch_cards_with_images:
                skipped.append(
                    {
                        "providerCardId": card.get("id"),
                        "reason": f"embedding_error: {exc}",
                    }
                )
            continue

        for (card, reference_image_path), embedding in zip(batch_cards_with_images, batch_embeddings):
            row_index = len(manifest_entries)
            manifest_entries.append(
                manifest_entry_for_row(
                    row_index=row_index,
                    card=card,
                    reference_image_path=reference_image_path,
                    artifact_version=args.artifact_version,
                    model_id=args.model_id,
                )
            )
            embeddings.append(embedding)

        processed = min(batch_number * args.batch_size, total_cards)
        if batch_number == 1 or batch_number % 10 == 0 or processed >= total_cards:
            print(
                f"[build] embedded {processed}/{total_cards} catalog rows ({len(manifest_entries)} successful, {len(skipped)} skipped)",
                flush=True,
            )

    if not embeddings:
        raise SystemExit("No embeddings were produced. Cannot write an empty visual index.")

    embedding_matrix = np.stack(embeddings, axis=0).astype(np.float32)
    np.savez_compressed(artifact_paths.npz_path, embeddings=embedding_matrix)
    save_json(
        artifact_paths.manifest_path,
        {
            "generatedAt": utc_now_iso(),
            "provider": "pokemontcg_api",
            "artifactVersion": args.artifact_version,
            "modelId": args.model_id,
            "cropPreset": args.crop_preset,
            "cropBoxNormalized": crop_box_for_preset(args.crop_preset),
            "embeddingDimension": int(embedding_matrix.shape[1]),
            "entryCount": len(manifest_entries),
            "entries": manifest_entries,
        },
    )
    save_json(
        artifact_paths.build_report_path,
        {
            "generatedAt": utc_now_iso(),
            "provider": "pokemontcg_api",
            "artifactVersion": args.artifact_version,
            "modelId": args.model_id,
            "cropPreset": args.crop_preset,
            "cropBoxNormalized": crop_box_for_preset(args.crop_preset),
            "device": str(device),
            "requestedSupertypes": [value.lower() for value in args.supertypes],
            "pageSize": args.page_size,
            "batchSize": args.batch_size,
            "downloadWorkers": args.download_workers,
            "catalogCardCount": total_cards,
            "embeddedEntryCount": len(manifest_entries),
            "skippedCount": len(skipped),
            "npzPath": str(artifact_paths.npz_path),
            "manifestPath": str(artifact_paths.manifest_path),
            "metadataCachePath": str(artifact_paths.metadata_cache_path),
            "imageCacheRoot": str(artifact_paths.image_cache_root),
            "skipped": skipped,
        },
    )

    print(f"[build] wrote {artifact_paths.npz_path}", flush=True)
    print(f"[build] wrote {artifact_paths.manifest_path}", flush=True)
    print(f"[build] wrote {artifact_paths.build_report_path}", flush=True)
    print(f"[build] final embedded entries={len(manifest_entries)} skipped={len(skipped)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
