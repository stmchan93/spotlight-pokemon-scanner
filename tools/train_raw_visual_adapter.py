#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import io
import json
import math
import random
import sys
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

from raw_visual_dataset_paths import default_raw_visual_scan_registry_path, default_raw_visual_train_manifest_path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageEnhance


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if not (BACKEND_ROOT / "server.py").exists():
    BACKEND_ROOT = REPO_ROOT
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_model import DEFAULT_VISUAL_MODEL_ID, RawVisualFrozenEncoder, RawVisualProjectionAdapter, project_embeddings_tensor, resolve_torch_device  # noqa: E402


def utc_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sanitize_model_slug(model_id: str) -> str:
    slug = model_id.split("/")[-1].strip().lower()
    return "".join(character if character.isalnum() or character in {"-", "_"} else "-" for character in slug)


@dataclass(frozen=True)
class TrainingRecord:
    fixture_name: str
    fixture_root: Path
    fixture_path: Path
    provider_card_id: str
    normalized_image_path: Path
    reference_image_path: Path
    card_name: str
    collector_number: str
    set_code: str | None
    import_batch_id: str | None
    import_bucket: str | None
    dataset_status: str | None
    expansion_holdout_selected: bool


@dataclass(frozen=True)
class HardNegativeEntry:
    provider_card_id: str
    similarity: float
    provider_name: str | None
    provider_collector_number: str | None
    provider_set_id: str | None
    provider_set_ptcgo_code: str | None
    provider_set_name: str | None


def load_manifest(path: Path) -> list[TrainingRecord]:
    records: list[TrainingRecord] = []
    for line_number, line in enumerate(path.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        payload = json.loads(line)
        provider_card_id = str(payload.get("providerCardId") or "").strip()
        normalized_image_path = Path(str(payload.get("normalizedImagePath") or "")).resolve()
        reference_image_path = Path(str(payload.get("referenceImagePath") or "")).resolve()
        fixture_path_value = str(payload.get("fixturePath") or "").strip()
        fixture_path = Path(fixture_path_value).resolve() if fixture_path_value else normalized_image_path.parent.resolve()
        fixture_root_value = str(payload.get("fixtureRoot") or "").strip()
        fixture_root = Path(fixture_root_value).resolve() if fixture_root_value else fixture_path.parent.resolve()
        if not provider_card_id:
            raise SystemExit(f"Missing providerCardId in {path}:{line_number}")
        if not fixture_path.exists():
            raise SystemExit(f"Missing fixture path in {path}:{line_number}: {fixture_path}")
        if not normalized_image_path.exists():
            raise SystemExit(f"Missing normalized image in {path}:{line_number}: {normalized_image_path}")
        if not reference_image_path.exists():
            raise SystemExit(f"Missing reference image in {path}:{line_number}: {reference_image_path}")
        records.append(
            TrainingRecord(
                fixture_name=str(payload.get("fixtureName") or "").strip(),
                fixture_root=fixture_root,
                fixture_path=fixture_path,
                provider_card_id=provider_card_id,
                normalized_image_path=normalized_image_path,
                reference_image_path=reference_image_path,
                card_name=str(payload.get("cardName") or "").strip(),
                collector_number=str(payload.get("collectorNumber") or "").strip(),
                set_code=(str(payload.get("setCode")).strip() or None) if payload.get("setCode") is not None else None,
                import_batch_id=(str(payload.get("importBatchId")).strip() or None)
                if payload.get("importBatchId") is not None
                else None,
                import_bucket=(str(payload.get("importBucket")).strip() or None)
                if payload.get("importBucket") is not None
                else None,
                dataset_status=(str(payload.get("datasetStatus")).strip() or None)
                if payload.get("datasetStatus") is not None
                else None,
                expansion_holdout_selected=bool(payload.get("expansionHoldoutSelected") or False),
            )
        )
    if not records:
        raise SystemExit(f"No manifest rows found in {path}")
    return records


def load_hard_negative_manifest(path: Path) -> dict[str, list[HardNegativeEntry]]:
    payload = json.loads(path.read_text())
    raw_entries = payload.get("entries") or {}
    if not isinstance(raw_entries, dict):
        raise SystemExit(f"Hard-negative manifest entries must be an object: {path}")

    output: dict[str, list[HardNegativeEntry]] = {}
    for fixture_name, items in raw_entries.items():
        if not isinstance(items, list):
            continue
        parsed_items: list[HardNegativeEntry] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            provider_card_id = str(item.get("providerCardId") or "").strip()
            if not provider_card_id:
                continue
            parsed_items.append(
                HardNegativeEntry(
                    provider_card_id=provider_card_id,
                    similarity=float(item.get("similarity") or 0.0),
                    provider_name=(str(item.get("providerName")).strip() or None) if item.get("providerName") is not None else None,
                    provider_collector_number=(
                        str(item.get("providerCollectorNumber")).strip() or None
                    )
                    if item.get("providerCollectorNumber") is not None
                    else None,
                    provider_set_id=(str(item.get("providerSetId")).strip() or None)
                    if item.get("providerSetId") is not None
                    else None,
                    provider_set_ptcgo_code=(str(item.get("providerSetPtcgoCode")).strip() or None)
                    if item.get("providerSetPtcgoCode") is not None
                    else None,
                    provider_set_name=(str(item.get("providerSetName")).strip() or None)
                    if item.get("providerSetName") is not None
                    else None,
                )
            )
        output[str(fixture_name)] = parsed_items
    return output


def load_registry_fixture_metadata(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text())
    entries = payload.get("entries") or []
    output: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        fixture_path = str(entry.get("importedFixturePath") or "").strip()
        if not fixture_path:
            continue
        output[str(Path(fixture_path).resolve())] = entry
    return output


def apply_registry_metadata(
    records: list[TrainingRecord],
    *,
    registry_fixture_metadata: dict[str, dict[str, Any]],
) -> list[TrainingRecord]:
    if not registry_fixture_metadata:
        return records
    hydrated_records: list[TrainingRecord] = []
    for record in records:
        registry_entry = registry_fixture_metadata.get(str(record.fixture_path.resolve()))
        if registry_entry is None:
            hydrated_records.append(record)
            continue
        hydrated_records.append(
            TrainingRecord(
                fixture_name=record.fixture_name,
                fixture_root=record.fixture_root,
                fixture_path=record.fixture_path,
                provider_card_id=record.provider_card_id,
                normalized_image_path=record.normalized_image_path,
                reference_image_path=record.reference_image_path,
                card_name=record.card_name,
                collector_number=record.collector_number,
                set_code=record.set_code,
                import_batch_id=record.import_batch_id or (str(registry_entry.get("batchID") or "").strip() or None),
                import_bucket=record.import_bucket or (str(registry_entry.get("bucket") or "").strip() or None),
                dataset_status=record.dataset_status or (str(registry_entry.get("datasetStatus") or "").strip() or None),
                expansion_holdout_selected=record.expansion_holdout_selected or bool(registry_entry.get("expansionHoldoutSelected") or False),
            )
        )
    return hydrated_records


def maybe_limit_provider_ids(provider_ids: list[str], limit: int) -> list[str]:
    if limit <= 0 or limit >= len(provider_ids):
        return provider_ids
    return provider_ids[:limit]


def split_provider_ids(
    provider_ids: list[str],
    *,
    val_fraction: float,
    min_validation_providers: int,
    seed: int,
) -> tuple[list[str], list[str]]:
    shuffled = list(provider_ids)
    random.Random(seed).shuffle(shuffled)
    if len(shuffled) < 2:
        raise SystemExit("Need at least 2 unique providerCardIds to build a train/validation split.")

    raw_val_count = int(round(len(shuffled) * val_fraction))
    val_count = max(min_validation_providers, raw_val_count)
    val_count = min(max(1, val_count), len(shuffled) - 1)
    val_ids = sorted(shuffled[:val_count])
    train_ids = sorted(shuffled[val_count:])
    return train_ids, val_ids


def compute_scan_embeddings(
    records: list[TrainingRecord],
    *,
    encoder: RawVisualFrozenEncoder,
    batch_size: int,
) -> dict[str, torch.Tensor]:
    scan_paths = [record.normalized_image_path for record in records]
    scan_embeddings_np = encoder.embed_image_paths(scan_paths, batch_size=batch_size)
    return {
        record.fixture_name: torch.from_numpy(scan_embeddings_np[index]).float()
        for index, record in enumerate(records)
    }


def compute_reference_embeddings(
    records: list[TrainingRecord],
    *,
    encoder: RawVisualFrozenEncoder,
    batch_size: int,
) -> tuple[dict[str, torch.Tensor], dict[str, dict[str, Any]]]:
    reference_by_provider: dict[str, Path] = {}
    reference_metadata: dict[str, dict[str, Any]] = {}
    for record in records:
        reference_by_provider.setdefault(record.provider_card_id, record.reference_image_path)
        reference_metadata.setdefault(
            record.provider_card_id,
            {
                "providerCardId": record.provider_card_id,
                "cardName": record.card_name,
                "collectorNumber": record.collector_number,
                "setCode": record.set_code,
                "referenceImagePath": str(record.reference_image_path),
            },
        )
    provider_ids = sorted(reference_by_provider)
    reference_embeddings_np = encoder.embed_image_paths(
        [reference_by_provider[provider_id] for provider_id in provider_ids],
        batch_size=batch_size,
    )
    reference_embeddings = {
        provider_id: torch.from_numpy(reference_embeddings_np[index]).float()
        for index, provider_id in enumerate(provider_ids)
    }
    return reference_embeddings, reference_metadata


def compute_base_embeddings(
    records: list[TrainingRecord],
    *,
    encoder: RawVisualFrozenEncoder,
    batch_size: int,
) -> tuple[dict[str, torch.Tensor], dict[str, torch.Tensor], dict[str, dict[str, Any]]]:
    scan_embeddings = compute_scan_embeddings(records, encoder=encoder, batch_size=batch_size)
    reference_embeddings, reference_metadata = compute_reference_embeddings(
        records, encoder=encoder, batch_size=batch_size
    )
    return scan_embeddings, reference_embeddings, reference_metadata


@dataclass(frozen=True)
class ScanAugmentationConfig:
    brightness_jitter: float = 0.15
    contrast_jitter: float = 0.15
    saturation_jitter: float = 0.10
    hue_jitter: float = 0.02
    rotation_degrees: float = 2.0
    translation_fraction: float = 0.02
    jpeg_quality_min: int = 70
    jpeg_quality_max: int = 95
    apply_probability: float = 1.0
    # Photometric lighting-robustness levers (OFF by default to preserve current behaviour).
    # Exposure/gamma: 1.0/1.0 == identity LUT == no-op. g<1 brightens (under-exposure recovery),
    # g>1 darkens (over-exposure simulation).
    gamma_min: float = 1.0
    gamma_max: float = 1.0
    # Synthetic specular glare (foil bloom). probability 0.0 == never applied == no-op.
    glare_probability: float = 0.0
    glare_min_intensity: float = 0.25
    glare_max_intensity: float = 0.7
    glare_min_radius_frac: float = 0.08
    glare_max_radius_frac: float = 0.35


class RawVisualScanAugmentor:
    """Per-epoch augmentation tuned for tightly-normalized 630x880 card crops.

    Notes:
      - DOES NOT random-crop or perspective-warp (would lose footer/title).
      - Uses PIL primitives only (no torchvision dep).
    """

    def __init__(self, config: ScanAugmentationConfig, *, seed: int) -> None:
        self.config = config
        self._rng = random.Random(seed)

    def reseed(self, seed: int) -> None:
        self._rng = random.Random(seed)

    def _sample_factor(self, jitter: float) -> float:
        if jitter <= 0.0:
            return 1.0
        return 1.0 + self._rng.uniform(-jitter, jitter)

    def _apply_color_jitter(self, image: Image.Image) -> Image.Image:
        cfg = self.config
        if cfg.brightness_jitter > 0:
            image = ImageEnhance.Brightness(image).enhance(self._sample_factor(cfg.brightness_jitter))
        if cfg.contrast_jitter > 0:
            image = ImageEnhance.Contrast(image).enhance(self._sample_factor(cfg.contrast_jitter))
        if cfg.saturation_jitter > 0:
            image = ImageEnhance.Color(image).enhance(self._sample_factor(cfg.saturation_jitter))
        if cfg.hue_jitter > 0:
            shift = int(round(self._rng.uniform(-cfg.hue_jitter, cfg.hue_jitter) * 255.0))
            if shift != 0:
                hsv = np.array(image.convert("HSV"), dtype=np.int16)
                hsv[..., 0] = (hsv[..., 0] + shift) % 256
                image = Image.fromarray(hsv.astype(np.uint8), "HSV").convert("RGB")
        return image

    def _apply_exposure_gamma(self, image: Image.Image) -> Image.Image:
        """Simulate under/over-exposure via a per-image gamma LUT.

        No-op when gamma_min == gamma_max == 1.0 (identity). g<1 brightens, g>1 darkens.
        """
        cfg = self.config
        if not (cfg.gamma_min < 1.0 or cfg.gamma_max > 1.0):
            return image
        g = self._rng.uniform(cfg.gamma_min, cfg.gamma_max)
        if abs(g - 1.0) < 1e-6:
            return image
        lut = ((np.linspace(0.0, 1.0, 256) ** g) * 255.0).clip(0, 255).astype(np.uint8)
        # PIL point() applies the 256-entry LUT per-channel across R/G/B.
        return image.point(lut.tolist() * len(image.getbands()))

    def _apply_synthetic_glare(self, image: Image.Image) -> Image.Image:
        """Add a soft, streaky specular bloom (foil glare) with prob glare_probability.

        No-op when glare_probability == 0.0. The bloom is a Gaussian-falloff bright spot,
        slightly elongated along a random angle so it reads as a foil streak rather than a
        uniform white disc. Added (not alpha-blended) and clipped to 255.
        """
        cfg = self.config
        if cfg.glare_probability <= 0.0:
            return image
        if self._rng.random() > cfg.glare_probability:
            return image

        arr = np.asarray(image, dtype=np.float32)
        height, width = arr.shape[0], arr.shape[1]
        short_side = float(min(height, width))

        intensity = self._rng.uniform(cfg.glare_min_intensity, cfg.glare_max_intensity) * 255.0
        radius = self._rng.uniform(cfg.glare_min_radius_frac, cfg.glare_max_radius_frac) * short_side
        radius = max(radius, 1.0)
        center_x = self._rng.uniform(0.0, float(width - 1))
        center_y = self._rng.uniform(0.0, float(height - 1))
        angle = self._rng.uniform(0.0, math.pi)
        # Elongation: stretch ~2.5x along the streak axis, compress across it.
        elongation = self._rng.uniform(2.0, 3.0)

        yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
        dx = xx - center_x
        dy = yy - center_y
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        # Rotate into the streak's local frame.
        u = dx * cos_a + dy * sin_a   # along-streak axis
        v = -dx * sin_a + dy * cos_a  # across-streak axis
        sigma_along = radius * elongation
        sigma_across = radius / elongation
        falloff = np.exp(
            -0.5 * ((u / sigma_along) ** 2 + (v / sigma_across) ** 2)
        ).astype(np.float32)

        bloom = (falloff * intensity)[..., None]
        out = np.clip(arr + bloom, 0.0, 255.0).astype(np.uint8)
        return Image.fromarray(out, "RGB")

    def _apply_affine(self, image: Image.Image) -> Image.Image:
        cfg = self.config
        rotation = 0.0
        if cfg.rotation_degrees > 0:
            rotation = self._rng.uniform(-cfg.rotation_degrees, cfg.rotation_degrees)
        translate_x = 0.0
        translate_y = 0.0
        if cfg.translation_fraction > 0:
            translate_x = self._rng.uniform(-cfg.translation_fraction, cfg.translation_fraction) * image.width
            translate_y = self._rng.uniform(-cfg.translation_fraction, cfg.translation_fraction) * image.height

        if abs(rotation) > 1e-3:
            image = image.rotate(rotation, resample=Image.BILINEAR, fillcolor=(0, 0, 0))
        if abs(translate_x) > 0.5 or abs(translate_y) > 0.5:
            image = image.transform(
                image.size,
                Image.AFFINE,
                (1, 0, -translate_x, 0, 1, -translate_y),
                resample=Image.BILINEAR,
                fillcolor=(0, 0, 0),
            )
        return image

    def _apply_jpeg_jitter(self, image: Image.Image) -> Image.Image:
        cfg = self.config
        if cfg.jpeg_quality_max <= 0 or cfg.jpeg_quality_min > cfg.jpeg_quality_max:
            return image
        quality = self._rng.randint(cfg.jpeg_quality_min, cfg.jpeg_quality_max)
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=quality)
        buf.seek(0)
        return Image.open(buf).convert("RGB")

    def augment(self, image: Image.Image) -> Image.Image:
        if self._rng.random() > self.config.apply_probability:
            return image
        out = image.convert("RGB") if image.mode != "RGB" else image.copy()
        out = self._apply_color_jitter(out)
        out = self._apply_exposure_gamma(out)
        out = self._apply_synthetic_glare(out)
        out = self._apply_affine(out)
        out = self._apply_jpeg_jitter(out)
        return out


def encode_scan_records_with_augmentation(
    records: list[TrainingRecord],
    *,
    encoder: RawVisualFrozenEncoder,
    augmentor: RawVisualScanAugmentor,
    batch_size: int,
) -> dict[str, torch.Tensor]:
    """Re-encode scan images each epoch with augmentation applied in-memory.

    Returns a fixture_name -> base CLIP embedding dict.
    """
    if not records:
        return {}
    fixture_names: list[str] = [record.fixture_name for record in records]
    image_paths: list[Path] = [record.normalized_image_path for record in records]

    embeddings_np_chunks: list[np.ndarray] = []
    for start in range(0, len(image_paths), batch_size):
        batch_paths = image_paths[start : start + batch_size]
        batch_images: list[Image.Image] = []
        try:
            for path in batch_paths:
                with Image.open(path) as src:
                    src.load()
                    augmented = augmentor.augment(src)
                batch_images.append(augmented)
            embeddings_np_chunks.append(encoder.embed_images(batch_images, batch_size=batch_size))
        finally:
            for image in batch_images:
                try:
                    image.close()
                except Exception:
                    pass

    embeddings_np = (
        np.concatenate(embeddings_np_chunks, axis=0)
        if embeddings_np_chunks
        else np.zeros((0, encoder.embedding_dim), dtype=np.float32)
    )
    return {
        fixture_name: torch.from_numpy(embeddings_np[index]).float()
        for index, fixture_name in enumerate(fixture_names)
    }


def load_index_reference_embeddings(
    *,
    index_npz_path: Path,
    index_manifest_path: Path,
) -> tuple[dict[str, torch.Tensor], dict[str, dict[str, Any]]]:
    index_manifest = json.loads(index_manifest_path.read_text())
    index_rows = [entry for entry in index_manifest.get("entries", []) if isinstance(entry, dict)]
    matrix = np.asarray(np.load(index_npz_path)["embeddings"], dtype=np.float32)
    if matrix.ndim != 2 or matrix.shape[0] != len(index_rows):
        raise SystemExit("Full visual index NPZ/manifest mismatch while loading hard negatives.")

    reference_embeddings: dict[str, torch.Tensor] = {}
    reference_metadata: dict[str, dict[str, Any]] = {}
    for row_index, entry in enumerate(index_rows):
        provider_card_id = str(entry.get("providerCardId") or "").strip()
        if not provider_card_id or provider_card_id in reference_embeddings:
            continue
        reference_embeddings[provider_card_id] = torch.from_numpy(matrix[row_index]).float()
        reference_metadata[provider_card_id] = {
            "providerCardId": provider_card_id,
            "cardName": entry.get("name"),
            "collectorNumber": entry.get("collectorNumber"),
            "setCode": entry.get("setPtcgoCode"),
            "referenceImagePath": entry.get("referenceImagePath"),
            "setId": entry.get("setId"),
            "setName": entry.get("setName"),
        }
    return reference_embeddings, reference_metadata


def contrastive_loss(
    adapter: RawVisualProjectionAdapter,
    scan_base: torch.Tensor,
    ref_base: torch.Tensor,
    *,
    extra_ref_base: torch.Tensor | None = None,
) -> tuple[torch.Tensor, dict[str, float]]:
    scan_projected = adapter(scan_base)
    ref_projected = adapter(ref_base)
    logit_scale = adapter.current_logit_scale()
    if extra_ref_base is not None and extra_ref_base.shape[0] > 0:
        extra_ref_projected = adapter(extra_ref_base)
        ref_pool = torch.cat([ref_projected, extra_ref_projected], dim=0)
    else:
        ref_pool = ref_projected
    logits_scan = logit_scale * torch.matmul(scan_projected, ref_pool.T)
    targets = torch.arange(ref_projected.shape[0], device=logits_scan.device)
    loss_scan = F.cross_entropy(logits_scan, targets)
    logits_ref = logit_scale * torch.matmul(scan_projected, ref_projected.T)
    loss_ref = F.cross_entropy(logits_ref.T, targets)
    loss = 0.5 * (loss_scan + loss_ref)
    with torch.no_grad():
        top1 = (logits_scan.argmax(dim=1) == targets).float().mean().item()
        extra_negative_count = max(0, ref_pool.shape[0] - ref_projected.shape[0])
    return loss, {
        "logitScale": float(logit_scale.detach().cpu().item()),
        "batchTop1": float(top1),
        "extraNegativeCount": float(extra_negative_count),
    }


def build_batch_hard_negative_tensor(
    *,
    batch_records: list[TrainingRecord],
    hard_negative_map: dict[str, list[HardNegativeEntry]],
    reference_embeddings: dict[str, torch.Tensor],
) -> tuple[torch.Tensor | None, int]:
    positive_provider_ids = {record.provider_card_id for record in batch_records}
    ordered_negative_provider_ids: list[str] = []
    seen: set[str] = set()

    for record in batch_records:
        for item in hard_negative_map.get(record.fixture_name, []):
            provider_card_id = item.provider_card_id
            if provider_card_id in positive_provider_ids or provider_card_id in seen:
                continue
            if provider_card_id not in reference_embeddings:
                continue
            seen.add(provider_card_id)
            ordered_negative_provider_ids.append(provider_card_id)

    if not ordered_negative_provider_ids:
        return None, 0
    tensor = torch.stack([reference_embeddings[provider_card_id] for provider_card_id in ordered_negative_provider_ids])
    return tensor, len(ordered_negative_provider_ids)


def group_train_records_by_provider(records: list[TrainingRecord]) -> dict[str, list[TrainingRecord]]:
    grouped: dict[str, list[TrainingRecord]] = {}
    for record in records:
        grouped.setdefault(record.provider_card_id, []).append(record)
    for provider_id in grouped:
        grouped[provider_id] = sorted(grouped[provider_id], key=lambda record: record.fixture_name)
    return grouped


def is_focus_batch_record(record: TrainingRecord, focus_batch_ids: set[str]) -> bool:
    return (
        bool(focus_batch_ids)
        and record.import_batch_id in focus_batch_ids
        and record.import_bucket == "safe_new"
        and not record.expansion_holdout_selected
    )


def build_epoch_train_records(
    *,
    train_records_by_provider: dict[str, list[TrainingRecord]],
    seed: int,
    epoch: int,
    max_train_images_per_provider_per_epoch: int,
    focus_batch_ids: set[str],
    focus_batch_provider_ratio: float | None,
) -> tuple[list[TrainingRecord], dict[str, Any]]:
    rng = random.Random(seed + epoch)
    provider_ids = sorted(train_records_by_provider)
    focus_provider_ids = sorted(
        provider_id
        for provider_id, records in train_records_by_provider.items()
        if any(is_focus_batch_record(record, focus_batch_ids) for record in records)
    )
    focus_provider_set = set(focus_provider_ids)
    legacy_provider_ids = sorted(provider_id for provider_id in provider_ids if provider_id not in focus_provider_set)

    epoch_records: list[TrainingRecord] = []
    focus_pool_records: list[TrainingRecord] = []
    legacy_pool_records: list[TrainingRecord] = []

    for provider_id in provider_ids:
        provider_records = list(train_records_by_provider[provider_id])
        rng.shuffle(provider_records)
        if max_train_images_per_provider_per_epoch > 0:
            provider_records = provider_records[:max_train_images_per_provider_per_epoch]
        epoch_records.extend(provider_records)
        if provider_id in focus_provider_set:
            focus_pool_records.extend(provider_records)
        else:
            legacy_pool_records.extend(provider_records)

    target_focus_ratio = focus_batch_provider_ratio
    extra_records_added = 0
    if (
        target_focus_ratio is not None
        and 0.0 < target_focus_ratio < 1.0
        and focus_pool_records
        and legacy_pool_records
    ):
        focus_count = len(focus_pool_records)
        legacy_count = len(legacy_pool_records)
        total_count = focus_count + legacy_count
        actual_focus_ratio = focus_count / total_count if total_count else 0.0

        extra_pool: list[TrainingRecord] = []
        if target_focus_ratio < actual_focus_ratio:
            desired_total = int(np.ceil(focus_count / target_focus_ratio))
            extra_records_added = max(0, desired_total - total_count)
            extra_pool = legacy_pool_records
        elif target_focus_ratio > actual_focus_ratio:
            desired_total = int(np.ceil(legacy_count / (1.0 - target_focus_ratio)))
            extra_records_added = max(0, desired_total - total_count)
            extra_pool = focus_pool_records

        if extra_records_added > 0 and extra_pool:
            epoch_records.extend(rng.choice(extra_pool) for _ in range(extra_records_added))

    rng.shuffle(epoch_records)
    epoch_focus_records = sum(1 for record in epoch_records if record.provider_card_id in focus_provider_set)
    epoch_legacy_records = len(epoch_records) - epoch_focus_records
    metrics = {
        "providerCount": len(provider_ids),
        "focusProviderCount": len(focus_provider_ids),
        "legacyProviderCount": len(legacy_provider_ids),
        "baseFocusRecordCount": len(focus_pool_records),
        "baseLegacyRecordCount": len(legacy_pool_records),
        "epochRecordCount": len(epoch_records),
        "epochFocusRecordCount": epoch_focus_records,
        "epochLegacyRecordCount": epoch_legacy_records,
        "extraReplayRecordCount": extra_records_added,
        "focusBatchProviderRatioTarget": target_focus_ratio,
        "epochFocusRecordRatio": (epoch_focus_records / len(epoch_records)) if epoch_records else 0.0,
        "maxTrainImagesPerProviderPerEpoch": max_train_images_per_provider_per_epoch,
    }
    return epoch_records, metrics


def retrieval_metrics(
    *,
    adapter: RawVisualProjectionAdapter,
    query_provider_ids: list[str],
    query_base: torch.Tensor,
    gallery_provider_ids: list[str],
    gallery_base: torch.Tensor,
    gallery_already_projected: bool = False,
    query_chunk_size: int = 256,
) -> tuple[dict[str, float], list[dict[str, Any]]]:
    """Compute recall@k for query embeddings against a (possibly large) gallery.

    Args:
      gallery_already_projected: when True, gallery_base is treated as already
        projected through the adapter (used for the full visual index path so
        we don't reproject ~44k rows every epoch).
      query_chunk_size: queries are scored in chunks to bound peak memory on
        large galleries (~44k rows x 256 queries x 4 bytes ~ 45MB per chunk).
    """
    adapter.eval()
    device = query_base.device
    if gallery_base.device != device:
        gallery_base = gallery_base.to(device)
    with torch.inference_mode():
        query_projected = adapter(query_base)
        if gallery_already_projected:
            gallery_projected = gallery_base
        else:
            gallery_projected = adapter(gallery_base)

    gallery_index_lookup: dict[str, list[int]] = {}
    for index, provider_id in enumerate(gallery_provider_ids):
        gallery_index_lookup.setdefault(provider_id, []).append(index)

    gallery_size = len(gallery_provider_ids)
    top_k_keep = min(10, gallery_size)
    details: list[dict[str, Any]] = []
    hit1 = 0
    hit5 = 0
    hit10 = 0
    reciprocal_rank_sum = 0.0
    skipped_query_count = 0

    with torch.inference_mode():
        for chunk_start in range(0, query_projected.shape[0], query_chunk_size):
            chunk = query_projected[chunk_start : chunk_start + query_chunk_size]
            scores_chunk = torch.matmul(chunk, gallery_projected.T)
            top_scores, top_indices = torch.topk(scores_chunk, k=top_k_keep, dim=1, largest=True, sorted=True)
            top_indices_cpu = top_indices.cpu()
            top_scores_cpu = top_scores.cpu()
            scores_cpu = scores_chunk.cpu()
            for offset in range(scores_chunk.shape[0]):
                row_index = chunk_start + offset
                provider_id = query_provider_ids[row_index]
                truth_indices = gallery_index_lookup.get(provider_id) or []
                if not truth_indices:
                    skipped_query_count += 1
                    details.append(
                        {
                            "providerCardId": provider_id,
                            "rank": None,
                            "skipped": True,
                            "skippedReason": "providerCardIdMissingFromGallery",
                            "topCandidates": [
                                {
                                    "providerCardId": gallery_provider_ids[int(top_indices_cpu[offset, k].item())],
                                    "similarity": round(float(top_scores_cpu[offset, k].item()), 6),
                                }
                                for k in range(top_k_keep)
                            ],
                        }
                    )
                    continue
                truth_score_max = max(float(scores_cpu[offset, idx].item()) for idx in truth_indices)
                rank = int((scores_cpu[offset] > truth_score_max).sum().item()) + 1
                reciprocal_rank_sum += 1.0 / rank
                hit1 += int(rank <= 1)
                hit5 += int(rank <= min(5, gallery_size))
                hit10 += int(rank <= min(10, gallery_size))

                top_candidates = []
                for k in range(top_k_keep):
                    cand_index = int(top_indices_cpu[offset, k].item())
                    top_candidates.append(
                        {
                            "providerCardId": gallery_provider_ids[cand_index],
                            "similarity": round(float(top_scores_cpu[offset, k].item()), 6),
                        }
                    )
                details.append(
                    {
                        "providerCardId": provider_id,
                        "rank": rank,
                        "topCandidates": top_candidates,
                    }
                )

    total = max(1, len(query_provider_ids) - skipped_query_count)
    metrics = {
        "recallAt1": hit1 / total,
        "recallAt5": hit5 / total,
        "recallAt10": hit10 / total,
        "meanReciprocalRank": reciprocal_rank_sum / total,
        "queryCount": float(total),
        "galleryCount": float(gallery_size),
        "skippedQueryCount": float(skipped_query_count),
    }
    return metrics, details


def better_metrics(candidate: dict[str, float], incumbent: dict[str, float] | None) -> bool:
    if incumbent is None:
        return True
    candidate_key = (
        candidate.get("recallAt10", 0.0),
        candidate.get("recallAt5", 0.0),
        candidate.get("recallAt1", 0.0),
        candidate.get("meanReciprocalRank", 0.0),
    )
    incumbent_key = (
        incumbent.get("recallAt10", 0.0),
        incumbent.get("recallAt5", 0.0),
        incumbent.get("recallAt1", 0.0),
        incumbent.get("meanReciprocalRank", 0.0),
    )
    return candidate_key > incumbent_key


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train the first raw visual projection adapter on top of frozen CLIP embeddings.")
    parser.add_argument(
        "--manifest-path",
        type=Path,
        default=default_raw_visual_train_manifest_path(),
        help="Training manifest JSONL path.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("backend/data/visual-models"),
        help="Directory where the trained adapter artifact and metadata should be written.",
    )
    parser.add_argument(
        "--artifact-version",
        default="v001",
        help="Version label for the adapter artifact filenames.",
    )
    parser.add_argument(
        "--model-id",
        default=DEFAULT_VISUAL_MODEL_ID,
        help="Frozen CLIP model id to use for base embeddings.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "mps"],
        help="Torch device to use for base embedding extraction and adapter training.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=32,
        help="Training batch size for the adapter.",
    )
    parser.add_argument(
        "--embedding-batch-size",
        type=int,
        default=32,
        help="Batch size for frozen CLIP base-embedding extraction.",
    )
    parser.add_argument(
        "--max-train-images-per-provider-per-epoch",
        type=int,
        default=4,
        help="Identity-balanced per-provider image cap for each epoch. Set 0 to keep every image for a provider.",
    )
    parser.add_argument(
        "--epochs",
        type=int,
        default=12,
        help="Maximum adapter training epochs.",
    )
    parser.add_argument(
        "--learning-rate",
        type=float,
        default=1e-3,
        help="AdamW learning rate.",
    )
    parser.add_argument(
        "--weight-decay",
        type=float,
        default=1e-4,
        help="AdamW weight decay.",
    )
    parser.add_argument(
        "--validation-fraction",
        type=float,
        default=0.2,
        help="Fraction of providerCardIds to reserve for validation.",
    )
    parser.add_argument(
        "--min-validation-providers",
        type=int,
        default=5,
        help="Minimum number of providerCardIds to reserve for validation.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for the train/validation split and training order.",
    )
    parser.add_argument(
        "--patience",
        type=int,
        default=3,
        help="Early stopping patience on validation recall@10.",
    )
    parser.add_argument(
        "--provider-limit",
        type=int,
        default=0,
        help="Optional cap on distinct providerCardIds. Useful for smoke tests.",
    )
    parser.add_argument(
        "--hard-negatives-path",
        type=Path,
        default=None,
        help="Optional hard-negative manifest path. When provided, mined confusing wrong candidates are appended to the scan->reference loss.",
    )
    parser.add_argument(
        "--scan-registry-path",
        type=Path,
        default=default_raw_visual_scan_registry_path(),
        help="Raw scan registry used to backfill batch provenance for replay weighting.",
    )
    parser.add_argument(
        "--focus-batch-id",
        action="append",
        default=[],
        help="Batch id to treat as the new-batch replay group. Repeatable.",
    )
    parser.add_argument(
        "--focus-batch-provider-ratio",
        type=float,
        default=None,
        help="Target share of per-epoch sampled records coming from focus-batch safe_new providers.",
    )
    parser.add_argument(
        "--index-npz",
        type=Path,
        default=Path("backend/data/visual-index/visual_index_active_clip-vit-base-patch32.npz"),
        help="Base visual index NPZ path used to resolve hard-negative embeddings.",
    )
    parser.add_argument(
        "--index-manifest",
        type=Path,
        default=Path("backend/data/visual-index/visual_index_active_manifest.json"),
        help="Base visual index manifest path used to resolve hard-negative embeddings.",
    )
    parser.add_argument(
        "--augment-scans",
        dest="augment_scans",
        action="store_true",
        default=True,
        help="Re-encode scans with per-epoch augmentation. ON by default for v011.",
    )
    parser.add_argument(
        "--no-augment-scans",
        dest="augment_scans",
        action="store_false",
        help="Disable per-epoch scan augmentation; pre-compute scan embeddings once (legacy behaviour).",
    )
    parser.add_argument(
        "--augmentation-brightness",
        type=float,
        default=0.15,
        help="ColorJitter brightness range (image_factor uniformly in [1 - x, 1 + x]).",
    )
    parser.add_argument(
        "--augmentation-contrast",
        type=float,
        default=0.15,
        help="ColorJitter contrast range.",
    )
    parser.add_argument(
        "--augmentation-saturation",
        type=float,
        default=0.10,
        help="ColorJitter saturation range.",
    )
    parser.add_argument(
        "--augmentation-hue",
        type=float,
        default=0.02,
        help="ColorJitter hue shift fraction (0..0.5).",
    )
    parser.add_argument(
        "--augmentation-rotation-degrees",
        type=float,
        default=2.0,
        help="Random rotation in +/- degrees. Mild because scans are tightly normalized.",
    )
    parser.add_argument(
        "--augmentation-translation-fraction",
        type=float,
        default=0.02,
        help="Random translation as fraction of width/height.",
    )
    parser.add_argument(
        "--augmentation-jpeg-quality-min",
        type=int,
        default=70,
        help="Minimum JPEG re-encode quality used for augmentation.",
    )
    parser.add_argument(
        "--augmentation-jpeg-quality-max",
        type=int,
        default=95,
        help="Maximum JPEG re-encode quality used for augmentation.",
    )
    parser.add_argument(
        "--augmentation-gamma-min",
        type=float,
        default=1.0,
        help=(
            "Exposure/gamma LUT lower bound. 1.0/1.0 == identity == OFF (preserves baseline). "
            "g<1 brightens (under-exposure recovery)."
        ),
    )
    parser.add_argument(
        "--augmentation-gamma-max",
        type=float,
        default=1.0,
        help=(
            "Exposure/gamma LUT upper bound. 1.0/1.0 == identity == OFF (preserves baseline). "
            "g>1 darkens (over-exposure simulation)."
        ),
    )
    parser.add_argument(
        "--augmentation-glare-probability",
        type=float,
        default=0.0,
        help="Probability of adding a synthetic specular foil bloom per image. 0.0 == OFF (no-op).",
    )
    parser.add_argument(
        "--augmentation-glare-min-intensity",
        type=float,
        default=0.25,
        help="Synthetic glare minimum peak intensity (fraction of 255 added at the bloom center).",
    )
    parser.add_argument(
        "--augmentation-glare-max-intensity",
        type=float,
        default=0.7,
        help="Synthetic glare maximum peak intensity (fraction of 255 added at the bloom center).",
    )
    parser.add_argument(
        "--augmentation-glare-min-radius-frac",
        type=float,
        default=0.08,
        help="Synthetic glare minimum radius as a fraction of the image short side.",
    )
    parser.add_argument(
        "--augmentation-glare-max-radius-frac",
        type=float,
        default=0.35,
        help="Synthetic glare maximum radius as a fraction of the image short side.",
    )
    parser.add_argument(
        "--validation-gallery",
        choices=["train_only", "full_index"],
        default="full_index",
        help=(
            "Which gallery to score validation queries against. 'train_only' uses just the "
            "training providers (~221, saturates quickly). 'full_index' uses the full active "
            "visual index (~44k rows) so validation R@k reflects deployment-scale ranking."
        ),
    )
    parser.add_argument(
        "--validation-query-chunk-size",
        type=int,
        default=256,
        help="Chunk size used when scoring validation queries against a large gallery.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    if args.focus_batch_provider_ratio is not None and not (0.0 < args.focus_batch_provider_ratio < 1.0):
        raise SystemExit("--focus-batch-provider-ratio must be between 0 and 1.")

    manifest_path = args.manifest_path.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    records = load_manifest(manifest_path)
    registry_fixture_metadata = load_registry_fixture_metadata(args.scan_registry_path.resolve())
    records = apply_registry_metadata(records, registry_fixture_metadata=registry_fixture_metadata)
    unique_provider_ids = sorted({record.provider_card_id for record in records})
    limited_provider_ids = set(maybe_limit_provider_ids(unique_provider_ids, args.provider_limit))
    if args.provider_limit > 0:
        records = [record for record in records if record.provider_card_id in limited_provider_ids]
    provider_ids = sorted({record.provider_card_id for record in records})

    train_provider_ids, val_provider_ids = split_provider_ids(
        provider_ids,
        val_fraction=args.validation_fraction,
        min_validation_providers=args.min_validation_providers,
        seed=args.seed,
    )
    train_provider_set = set(train_provider_ids)
    val_provider_set = set(val_provider_ids)

    train_records = [record for record in records if record.provider_card_id in train_provider_set]
    val_records = [record for record in records if record.provider_card_id in val_provider_set]
    if not train_records or not val_records:
        raise SystemExit("Train/validation split produced an empty partition.")
    train_records_by_provider = group_train_records_by_provider(train_records)
    focus_batch_ids = {batch_id.strip() for batch_id in args.focus_batch_id if batch_id.strip()}
    focus_train_provider_ids = sorted(
        provider_id
        for provider_id, provider_records in train_records_by_provider.items()
        if any(is_focus_batch_record(record, focus_batch_ids) for record in provider_records)
    )

    print(
        f"Training records={len(train_records)} validation records={len(val_records)} "
        f"train providers={len(train_provider_ids)} validation providers={len(val_provider_ids)}",
        flush=True,
    )

    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    reference_embeddings, reference_metadata = compute_reference_embeddings(
        records,
        encoder=encoder,
        batch_size=args.embedding_batch_size,
    )
    # When augmentation is OFF we precompute scan embeddings once (legacy behaviour).
    # When augmentation is ON we compute a clean baseline (used for validation queries)
    # and re-encode with augmentation each epoch for training.
    clean_scan_embeddings = compute_scan_embeddings(
        records,
        encoder=encoder,
        batch_size=args.embedding_batch_size,
    )
    hard_negative_map: dict[str, list[HardNegativeEntry]] = {}
    hard_negative_reference_embeddings: dict[str, torch.Tensor] = {}
    hard_negative_reference_metadata: dict[str, dict[str, Any]] = {}
    hard_negative_fixture_count = 0
    hard_negative_reference_count = 0
    if args.hard_negatives_path:
        hard_negative_map = load_hard_negative_manifest(args.hard_negatives_path.resolve())
        hard_negative_reference_embeddings, hard_negative_reference_metadata = load_index_reference_embeddings(
            index_npz_path=args.index_npz.resolve(),
            index_manifest_path=args.index_manifest.resolve(),
        )
        hard_negative_fixture_count = sum(1 for record in train_records if hard_negative_map.get(record.fixture_name))
        referenced_provider_ids = {
            item.provider_card_id
            for record in train_records
            for item in hard_negative_map.get(record.fixture_name, [])
            if item.provider_card_id in hard_negative_reference_embeddings
        }
        hard_negative_reference_count = len(referenced_provider_ids)
        for provider_card_id, metadata in hard_negative_reference_metadata.items():
            reference_metadata.setdefault(provider_card_id, metadata)

    device = resolve_torch_device(args.device)
    adapter = RawVisualProjectionAdapter(embedding_dim=encoder.embedding_dim).to(device)
    optimizer = torch.optim.AdamW(adapter.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)

    augmentor: RawVisualScanAugmentor | None = None
    if args.augment_scans:
        augmentor = RawVisualScanAugmentor(
            ScanAugmentationConfig(
                brightness_jitter=args.augmentation_brightness,
                contrast_jitter=args.augmentation_contrast,
                saturation_jitter=args.augmentation_saturation,
                hue_jitter=args.augmentation_hue,
                rotation_degrees=args.augmentation_rotation_degrees,
                translation_fraction=args.augmentation_translation_fraction,
                jpeg_quality_min=args.augmentation_jpeg_quality_min,
                jpeg_quality_max=args.augmentation_jpeg_quality_max,
                gamma_min=args.augmentation_gamma_min,
                gamma_max=args.augmentation_gamma_max,
                glare_probability=args.augmentation_glare_probability,
                glare_min_intensity=args.augmentation_glare_min_intensity,
                glare_max_intensity=args.augmentation_glare_max_intensity,
                glare_min_radius_frac=args.augmentation_glare_min_radius_frac,
                glare_max_radius_frac=args.augmentation_glare_max_radius_frac,
            ),
            seed=args.seed,
        )

    # Validation gallery: either the small train-only provider set (legacy)
    # or the full active visual index (~44k rows) projected through the adapter.
    full_index_base_matrix: np.ndarray | None = None
    full_index_provider_ids: list[str] | None = None
    if args.validation_gallery == "full_index":
        index_manifest = json.loads(args.index_manifest.resolve().read_text())
        index_rows = [entry for entry in index_manifest.get("entries", []) if isinstance(entry, dict)]
        full_index_base_matrix = np.asarray(np.load(args.index_npz.resolve())["embeddings"], dtype=np.float32)
        if full_index_base_matrix.ndim != 2 or full_index_base_matrix.shape[0] != len(index_rows):
            raise SystemExit("Visual index NPZ/manifest mismatch while building full-gallery validation.")
        full_index_provider_ids = [str(entry.get("providerCardId") or "").strip() for entry in index_rows]
        # Sanity check: every validation provider should resolve in the full index.
        full_index_provider_set = set(full_index_provider_ids)
        missing_validation_providers = sorted(set(val_provider_ids) - full_index_provider_set)
        if missing_validation_providers:
            print(
                f"WARNING: {len(missing_validation_providers)} validation providers are not in the "
                f"full visual index and will be skipped from recall calculations. "
                f"First few: {missing_validation_providers[:5]}",
                flush=True,
            )
        gallery_size_for_log = len(full_index_provider_ids)
    else:
        full_index_provider_ids = sorted(reference_embeddings)
        gallery_size_for_log = len(full_index_provider_ids)

    print(
        f"Validation gallery mode={args.validation_gallery} galleryCount={gallery_size_for_log} "
        f"augment_scans={args.augment_scans}",
        flush=True,
    )

    val_query_provider_ids = [record.provider_card_id for record in val_records]
    val_query_base = torch.stack([clean_scan_embeddings[record.fixture_name] for record in val_records]).to(device)

    # Pre-stage the full-index base matrix on the training device so we can project it
    # through the adapter once per epoch (cheap O(N*d^2)) without re-loading every time.
    full_index_base_tensor: torch.Tensor | None = None
    if args.validation_gallery == "full_index" and full_index_base_matrix is not None:
        full_index_base_tensor = torch.from_numpy(full_index_base_matrix).to(device)

    history: list[dict[str, Any]] = []
    best_epoch = 0
    best_state_dict: dict[str, Any] | None = None
    best_metrics: dict[str, float] | None = None
    best_details: list[dict[str, Any]] = []
    patience_remaining = args.patience

    for epoch in range(1, args.epochs + 1):
        adapter.train()
        if augmentor is not None:
            # Re-seed each epoch so augmentations vary epoch-to-epoch but stay reproducible.
            augmentor.reseed(args.seed * 1000 + epoch)

        train_scan_records, epoch_sampling = build_epoch_train_records(
            train_records_by_provider=train_records_by_provider,
            seed=args.seed,
            epoch=epoch,
            max_train_images_per_provider_per_epoch=args.max_train_images_per_provider_per_epoch,
            focus_batch_ids=focus_batch_ids,
            focus_batch_provider_ratio=args.focus_batch_provider_ratio,
        )

        # Compute the scan embeddings used for THIS epoch's training. With augmentation
        # we must re-encode every scan record in train_scan_records. Without augmentation
        # we reuse the precomputed clean embeddings.
        epoch_scan_encode_started_at = perf_counter()
        if augmentor is not None:
            unique_records_for_encode: dict[str, TrainingRecord] = {}
            for record in train_scan_records:
                unique_records_for_encode.setdefault(record.fixture_name, record)
            epoch_scan_embeddings = encode_scan_records_with_augmentation(
                list(unique_records_for_encode.values()),
                encoder=encoder,
                augmentor=augmentor,
                batch_size=args.embedding_batch_size,
            )
        else:
            epoch_scan_embeddings = clean_scan_embeddings
        epoch_scan_encode_seconds = perf_counter() - epoch_scan_encode_started_at

        train_batches = max(1, (len(train_scan_records) + args.batch_size - 1) // args.batch_size)
        batch_losses: list[float] = []
        batch_top1_values: list[float] = []
        batch_logit_scales: list[float] = []
        batch_extra_negative_counts: list[float] = []

        for batch_index in range(train_batches):
            batch_records = train_scan_records[batch_index * args.batch_size : (batch_index + 1) * args.batch_size]
            scan_base = torch.stack([epoch_scan_embeddings[record.fixture_name] for record in batch_records]).to(device)
            ref_base = torch.stack([reference_embeddings[record.provider_card_id] for record in batch_records]).to(device)
            extra_ref_base, extra_negative_count = build_batch_hard_negative_tensor(
                batch_records=batch_records,
                hard_negative_map=hard_negative_map,
                reference_embeddings=hard_negative_reference_embeddings,
            )
            if extra_ref_base is not None:
                extra_ref_base = extra_ref_base.to(device)

            optimizer.zero_grad(set_to_none=True)
            loss, batch_metrics = contrastive_loss(adapter, scan_base, ref_base, extra_ref_base=extra_ref_base)
            loss.backward()
            optimizer.step()

            batch_losses.append(float(loss.detach().cpu().item()))
            batch_top1_values.append(batch_metrics["batchTop1"])
            batch_logit_scales.append(batch_metrics["logitScale"])
            batch_extra_negative_counts.append(float(extra_negative_count))

        # Validation: build the gallery for this epoch.
        val_started_at = perf_counter()
        if args.validation_gallery == "full_index" and full_index_base_tensor is not None:
            adapter.eval()
            with torch.inference_mode():
                gallery_projected = project_embeddings_tensor(adapter, full_index_base_tensor, batch_size=4096)
            val_metrics, val_details = retrieval_metrics(
                adapter=adapter,
                query_provider_ids=val_query_provider_ids,
                query_base=val_query_base,
                gallery_provider_ids=full_index_provider_ids or [],
                gallery_base=gallery_projected,
                gallery_already_projected=True,
                query_chunk_size=args.validation_query_chunk_size,
            )
        else:
            train_only_gallery_provider_ids = sorted(reference_embeddings)
            train_only_gallery_base = torch.stack(
                [reference_embeddings[provider_id] for provider_id in train_only_gallery_provider_ids]
            ).to(device)
            val_metrics, val_details = retrieval_metrics(
                adapter=adapter,
                query_provider_ids=val_query_provider_ids,
                query_base=val_query_base,
                gallery_provider_ids=train_only_gallery_provider_ids,
                gallery_base=train_only_gallery_base,
                gallery_already_projected=False,
                query_chunk_size=args.validation_query_chunk_size,
            )
        val_seconds = perf_counter() - val_started_at

        epoch_summary = {
            "epoch": epoch,
            "trainLoss": sum(batch_losses) / max(1, len(batch_losses)),
            "trainBatchTop1": sum(batch_top1_values) / max(1, len(batch_top1_values)),
            "trainLogitScale": sum(batch_logit_scales) / max(1, len(batch_logit_scales)),
            "trainExtraNegativeCount": sum(batch_extra_negative_counts) / max(1, len(batch_extra_negative_counts)),
            "sampling": epoch_sampling,
            "validation": val_metrics,
            "epochScanEncodeSeconds": round(epoch_scan_encode_seconds, 3),
            "validationSeconds": round(val_seconds, 3),
            "scanAugmentationApplied": augmentor is not None,
        }
        history.append(epoch_summary)
        print(
            f"epoch={epoch} "
            f"loss={epoch_summary['trainLoss']:.4f} "
            f"train_top1={epoch_summary['trainBatchTop1']:.4f} "
            f"extra_negs={epoch_summary['trainExtraNegativeCount']:.2f} "
            f"epoch_records={epoch_sampling['epochRecordCount']} "
            f"focus_ratio={epoch_sampling['epochFocusRecordRatio']:.4f} "
            f"val_r1={val_metrics['recallAt1']:.4f} "
            f"val_r5={val_metrics['recallAt5']:.4f} "
            f"val_r10={val_metrics['recallAt10']:.4f} "
            f"val_mrr={val_metrics['meanReciprocalRank']:.4f} "
            f"scan_encode_s={epoch_scan_encode_seconds:.1f} "
            f"val_s={val_seconds:.1f}",
            flush=True,
        )

        if better_metrics(val_metrics, best_metrics):
            best_epoch = epoch
            best_metrics = copy.deepcopy(val_metrics)
            best_details = copy.deepcopy(val_details)
            best_state_dict = copy.deepcopy(adapter.state_dict())
            patience_remaining = args.patience
        else:
            patience_remaining -= 1
            if patience_remaining <= 0:
                print(f"Early stopping at epoch {epoch} (patience exhausted).", flush=True)
                break

    if best_state_dict is None or best_metrics is None:
        raise SystemExit("Training did not produce a best checkpoint.")

    artifact_stem = f"raw_visual_adapter_{args.artifact_version}"
    checkpoint_path = output_dir / f"{artifact_stem}.pt"
    metadata_path = output_dir / f"{artifact_stem}_metadata.json"
    metrics_path = output_dir / f"{artifact_stem}_metrics.json"
    split_path = output_dir / f"{artifact_stem}_split.json"

    checkpoint_payload = {
        "generatedAt": utc_now_iso(),
        "artifactVersion": args.artifact_version,
        "modelId": args.model_id,
        "embeddingDim": encoder.embedding_dim,
        "adapterStateDict": best_state_dict,
        "bestEpoch": best_epoch,
    }
    torch.save(checkpoint_payload, checkpoint_path)

    metadata_payload = {
        "generatedAt": utc_now_iso(),
        "artifactVersion": args.artifact_version,
        "artifactStem": artifact_stem,
        "artifactPath": str(checkpoint_path),
        "modelId": args.model_id,
        "modelSlug": sanitize_model_slug(args.model_id),
        "embeddingDim": encoder.embedding_dim,
        "device": str(device),
        "manifestPath": str(manifest_path),
        "hardNegativesPath": str(args.hard_negatives_path.resolve()) if args.hard_negatives_path else None,
        "hardNegativesApplied": bool(args.hard_negatives_path),
        "hardNegativeFixtureCount": hard_negative_fixture_count,
        "hardNegativeReferenceCount": hard_negative_reference_count,
        "hardNegativeIndexNpzPath": str(args.index_npz.resolve()) if args.hard_negatives_path else None,
        "hardNegativeIndexManifestPath": str(args.index_manifest.resolve()) if args.hard_negatives_path else None,
        "recordCount": len(records),
        "trainRecordCount": len(train_records),
        "validationRecordCount": len(val_records),
        "providerCount": len(provider_ids),
        "trainProviderCount": len(train_provider_ids),
        "validationProviderCount": len(val_provider_ids),
        "scanRegistryPath": str(args.scan_registry_path.resolve()),
        "focusBatchIds": sorted(focus_batch_ids),
        "focusBatchTrainProviderCount": len(focus_train_provider_ids),
        "focusBatchProviderRatio": args.focus_batch_provider_ratio,
        "maxTrainImagesPerProviderPerEpoch": args.max_train_images_per_provider_per_epoch,
        "bestEpoch": best_epoch,
        "bestValidation": best_metrics,
        "outputMetricsPath": str(metrics_path),
        "outputSplitPath": str(split_path),
        "augmentScans": bool(args.augment_scans),
        "augmentation": {
            "brightness": args.augmentation_brightness,
            "contrast": args.augmentation_contrast,
            "saturation": args.augmentation_saturation,
            "hue": args.augmentation_hue,
            "rotationDegrees": args.augmentation_rotation_degrees,
            "translationFraction": args.augmentation_translation_fraction,
            "jpegQualityMin": args.augmentation_jpeg_quality_min,
            "jpegQualityMax": args.augmentation_jpeg_quality_max,
        } if args.augment_scans else None,
        "validationGallery": args.validation_gallery,
        "validationGalleryCount": gallery_size_for_log,
        "validationIndexNpzPath": str(args.index_npz.resolve()) if args.validation_gallery == "full_index" else None,
        "validationIndexManifestPath": str(args.index_manifest.resolve()) if args.validation_gallery == "full_index" else None,
    }
    train_only_gallery_provider_ids = sorted(reference_embeddings)
    metrics_payload = {
        "generatedAt": utc_now_iso(),
        "artifactVersion": args.artifact_version,
        "history": history,
        "bestEpoch": best_epoch,
        "bestValidation": best_metrics,
        "bestValidationDetails": best_details,
        "validationGallery": args.validation_gallery,
        "validationGalleryCount": gallery_size_for_log,
        "referenceGallery": {
            "providerCount": len(train_only_gallery_provider_ids),
            "providers": [
                {
                    "providerCardId": provider_id,
                    **reference_metadata.get(provider_id, {}),
                }
                for provider_id in train_only_gallery_provider_ids
            ],
        },
    }
    split_payload = {
        "generatedAt": utc_now_iso(),
        "artifactVersion": args.artifact_version,
        "seed": args.seed,
        "manifestPath": str(manifest_path),
        "focusBatchIds": sorted(focus_batch_ids),
        "focusBatchProviderRatio": args.focus_batch_provider_ratio,
        "maxTrainImagesPerProviderPerEpoch": args.max_train_images_per_provider_per_epoch,
        "trainProviderIds": train_provider_ids,
        "validationProviderIds": val_provider_ids,
        "trainFixtureNames": sorted(record.fixture_name for record in train_records),
        "validationFixtureNames": sorted(record.fixture_name for record in val_records),
    }

    metadata_path.write_text(json.dumps(metadata_payload, indent=2) + "\n")
    metrics_path.write_text(json.dumps(metrics_payload, indent=2) + "\n")
    split_path.write_text(json.dumps(split_payload, indent=2) + "\n")

    print(f"Wrote adapter checkpoint to {checkpoint_path}")
    print(f"Wrote adapter metadata to {metadata_path}")
    print(f"Wrote adapter metrics to {metrics_path}")
    print(f"Wrote train/validation split to {split_path}")


if __name__ == "__main__":
    main()
