from __future__ import annotations

import base64
import io
import math
from pathlib import Path
from typing import Any

DEFAULT_SET_BADGE_RECTS: dict[str, tuple[float, float, float, float]] = {
    "modern_left": (0.118, 0.845, 0.138, 0.098),
    "legacy_right_mid": (0.665, 0.842, 0.125, 0.102),
    "legacy_right_corner": (0.705, 0.836, 0.115, 0.105),
}


def _normalized_rect(payload: dict[str, Any]) -> tuple[float, float, float, float] | None:
    try:
        x = float(payload.get("x"))
        y = float(payload.get("y"))
        width = float(payload.get("width"))
        height = float(payload.get("height"))
    except (TypeError, ValueError):
        return None
    if width <= 0.0 or height <= 0.0:
        return None
    return (x, y, width, height)


def _content_rect_from_payload(payload: dict[str, Any]) -> tuple[float, float, float, float]:
    normalized_target = (((payload.get("ocrAnalysis") or {}) if isinstance(payload.get("ocrAnalysis"), dict) else {}).get("normalizedTarget") or {})
    if isinstance(normalized_target, dict):
        content_rect = normalized_target.get("contentRectNormalized") or {}
        if isinstance(content_rect, dict):
            normalized = _normalized_rect(content_rect)
            if normalized is not None:
                return normalized
    return (0.0, 0.0, 1.0, 1.0)


def _crop_rect(
    image,
    *,
    content_rect: tuple[float, float, float, float],
    family_rect: tuple[float, float, float, float],
) -> Any | None:
    image_width, image_height = image.size
    content_x, content_y, content_width, content_height = content_rect
    family_x, family_y, family_width, family_height = family_rect
    x = content_x + (family_x * content_width)
    y = content_y + (family_y * content_height)
    width = family_width * content_width
    height = family_height * content_height
    left = max(0, min(image_width - 1, int(round(x * image_width))))
    top = max(0, min(image_height - 1, int(round(y * image_height))))
    right = max(left + 1, min(image_width, int(round((x + width) * image_width))))
    bottom = max(top + 1, min(image_height, int(round((y + height) * image_height))))
    if right - left < 4 or bottom - top < 4:
        return None
    return image.crop((left, top, right, bottom))


def _descriptor_from_crop(image) -> list[float]:
    from PIL import ImageOps

    grayscale = ImageOps.autocontrast(image.convert("L"))
    resized = grayscale.resize((24, 24))
    values = [float(pixel) / 255.0 for pixel in resized.getdata()]
    if not values:
        return []
    mean_value = sum(values) / float(len(values))
    centered = [value - mean_value for value in values]
    norm = math.sqrt(sum(value * value for value in centered))
    if norm > 0.0:
        return [value / norm for value in centered]
    return centered


def _cosine_similarity(lhs: list[float], rhs: list[float]) -> float:
    if len(lhs) != len(rhs) or not lhs:
        return 0.0
    similarity = sum(left * right for left, right in zip(lhs, rhs, strict=True))
    if not math.isfinite(similarity):
        return 0.0
    return max(0.0, min(1.0, similarity))


class RawSetBadgeMatcher:
    def __init__(self) -> None:
        self._reference_descriptor_cache: dict[tuple[str, str], list[float]] = {}

    def _load_payload_image(self, payload: dict[str, Any]):
        from PIL import Image

        image_payload = payload.get("image") or {}
        normalized_image_base64 = str(
            payload.get("normalizedImageBase64")
            or (image_payload.get("jpegBase64") if isinstance(image_payload, dict) else "")
            or ""
        ).strip()
        if normalized_image_base64:
            raw_bytes = base64.b64decode(normalized_image_base64, validate=True)
            return Image.open(io.BytesIO(raw_bytes)).convert("RGB")

        normalized_image_path = str(
            payload.get("normalizedImagePath")
            or (image_payload.get("path") if isinstance(image_payload, dict) else "")
            or ""
        ).strip()
        if normalized_image_path:
            return Image.open(Path(normalized_image_path)).convert("RGB")

        raise ValueError("Payload does not include a normalized image for set badge matching.")

    def _query_descriptors(self, payload: dict[str, Any]) -> dict[str, list[float]]:
        image = self._load_payload_image(payload)
        content_rect = _content_rect_from_payload(payload)
        descriptors: dict[str, list[float]] = {}
        for family, family_rect in DEFAULT_SET_BADGE_RECTS.items():
            crop = _crop_rect(image, content_rect=content_rect, family_rect=family_rect)
            if crop is None:
                continue
            descriptors[family] = _descriptor_from_crop(crop)
        return descriptors

    def _reference_descriptor(self, entry: dict[str, Any], family: str) -> list[float] | None:
        from PIL import Image

        reference_image_path = str(entry.get("referenceImagePath") or "").strip()
        if not reference_image_path:
            return None
        cache_key = (reference_image_path, family)
        if cache_key in self._reference_descriptor_cache:
            return self._reference_descriptor_cache[cache_key]

        image = Image.open(Path(reference_image_path)).convert("RGB")
        crop = _crop_rect(image, content_rect=(0.0, 0.0, 1.0, 1.0), family_rect=DEFAULT_SET_BADGE_RECTS[family])
        if crop is None:
            return None
        descriptor = _descriptor_from_crop(crop)
        self._reference_descriptor_cache[cache_key] = descriptor
        return descriptor

    def score_payload_against_entries(
        self,
        payload: dict[str, Any],
        entries: list[dict[str, Any]],
    ) -> dict[str, dict[str, Any]]:
        query_descriptors = self._query_descriptors(payload)
        if not query_descriptors:
            return {}

        scores: dict[str, dict[str, Any]] = {}
        for entry in entries:
            provider_card_id = str(entry.get("providerCardId") or entry.get("id") or "").strip()
            if not provider_card_id:
                continue

            best_family: str | None = None
            best_similarity = 0.0
            for family, query_descriptor in query_descriptors.items():
                reference_descriptor = self._reference_descriptor(entry, family)
                if reference_descriptor is None:
                    continue
                similarity = _cosine_similarity(query_descriptor, reference_descriptor)
                if similarity > best_similarity:
                    best_similarity = similarity
                    best_family = family

            if best_family is not None:
                scores[provider_card_id] = {
                    "score": round(best_similarity, 6),
                    "family": best_family,
                }
        return scores
