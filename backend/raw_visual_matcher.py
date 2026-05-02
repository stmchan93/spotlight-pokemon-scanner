from __future__ import annotations

import base64
import io
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

import numpy as np

from raw_visual_index import RawVisualIndex, RawVisualSearchMatch
from raw_visual_model import RawVisualFrozenEncoder, load_projection_adapter, project_embeddings_numpy


def _is_japanese_character(value: str) -> bool:
    codepoint = ord(value)
    return (
        0x3040 <= codepoint <= 0x309F  # Hiragana
        or 0x30A0 <= codepoint <= 0x30FF  # Katakana
        or 0x31F0 <= codepoint <= 0x31FF  # Katakana phonetic extensions
        or 0x3400 <= codepoint <= 0x4DBF  # CJK Extension A
        or 0x4E00 <= codepoint <= 0x9FFF  # CJK Unified Ideographs
        or 0xFF66 <= codepoint <= 0xFF9F  # Half-width Katakana
    )


def _normalize_language(value: Any) -> str | None:
    normalized = str(value or "").strip().lower()
    if normalized == "english":
        return "English"
    if normalized == "japanese":
        return "Japanese"
    return None


def _language_character_counts(value: str) -> tuple[int, int, int]:
    japanese_chars = sum(1 for char in value if _is_japanese_character(char))
    latin_chars = sum(1 for char in value if char.isascii() and char.isalpha())
    digit_chars = sum(1 for char in value if char.isdigit())
    return japanese_chars, latin_chars, digit_chars


def resolve_repo_relative_path(repo_root: Path, value: str | Path | None, default: Path) -> Path:
    if value is None:
        return default
    candidate = Path(value)
    if candidate.is_absolute():
        return candidate
    return (repo_root / candidate).resolve()


@dataclass(frozen=True)
class RawVisualQueryVariant:
    name: str
    image: Any
    inset_ratio: float


@dataclass(frozen=True)
class DecodedQueryImage:
    image: Any
    source: str
    encodedBytes: int
    encodedBase64Chars: int
    decodedWidth: int
    decodedHeight: int


class RawVisualMatcher:
    def __init__(
        self,
        *,
        repo_root: Path,
        model_id: str | None = None,
        index_npz_path: Path | None = None,
        index_manifest_path: Path | None = None,
        adapter_checkpoint_path: Path | None = None,
        adapter_metadata_path: Path | None = None,
    ) -> None:
        self.repo_root = repo_root
        default_root = repo_root / "backend" / "data" / "visual-index"
        default_model_root = repo_root / "backend" / "data" / "visual-models"
        self.model_id = model_id or os.environ.get("SPOTLIGHT_VISUAL_MODEL_ID", "openai/clip-vit-base-patch32")
        active_index_npz_path = default_root / "visual_index_active_clip-vit-base-patch32.npz"
        active_index_manifest_path = default_root / "visual_index_active_manifest.json"
        fallback_index_npz_path = default_root / "visual_index_v003-b8_clip-vit-base-patch32.npz"
        fallback_index_manifest_path = default_root / "visual_index_v003-b8_manifest.json"
        default_index_npz_path = active_index_npz_path if active_index_npz_path.exists() else fallback_index_npz_path
        default_index_manifest_path = (
            active_index_manifest_path if active_index_manifest_path.exists() else fallback_index_manifest_path
        )
        self.index = RawVisualIndex(
            npz_path=index_npz_path
            or resolve_repo_relative_path(
                repo_root,
                os.environ.get("SPOTLIGHT_VISUAL_INDEX_NPZ_PATH"),
                default_index_npz_path,
            ),
            manifest_path=index_manifest_path
            or resolve_repo_relative_path(
                repo_root,
                os.environ.get("SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH"),
                default_index_manifest_path,
            ),
        )
        adapter_checkpoint_value = os.environ.get("SPOTLIGHT_VISUAL_ADAPTER_CHECKPOINT_PATH")
        adapter_metadata_value = os.environ.get("SPOTLIGHT_VISUAL_ADAPTER_METADATA_PATH")
        active_adapter_checkpoint_path = default_model_root / "raw_visual_adapter_active.pt"
        active_adapter_metadata_path = default_model_root / "raw_visual_adapter_active_metadata.json"
        fallback_adapter_checkpoint_path = default_model_root / "raw_visual_adapter_v003-b8.pt"
        fallback_adapter_metadata_path = default_model_root / "raw_visual_adapter_v003-b8_metadata.json"
        default_adapter_checkpoint_path = (
            active_adapter_checkpoint_path if active_adapter_checkpoint_path.exists() else fallback_adapter_checkpoint_path
        )
        default_adapter_metadata_path = (
            active_adapter_metadata_path if active_adapter_metadata_path.exists() else fallback_adapter_metadata_path
        )
        self.adapter_checkpoint_path = adapter_checkpoint_path or resolve_repo_relative_path(
            repo_root,
            adapter_checkpoint_value,
            default_adapter_checkpoint_path,
        )
        self.adapter_metadata_path = adapter_metadata_path or resolve_repo_relative_path(
            repo_root,
            adapter_metadata_value,
            default_adapter_metadata_path,
        )
        self._encoder: RawVisualFrozenEncoder | None = None
        self._adapter = None
        self._runtime_lock = threading.Lock()
        self._telemetry_lock = threading.Lock()
        self._runtime_ready = False
        self._inference_count = 0
        self._last_inference_finished_at: float | None = None

    def is_available(self) -> bool:
        return self.index.is_available()

    def prewarm(self, *, run_inference: bool = False) -> dict[str, Any]:
        if not self.is_available():
            return {
                "available": False,
                "prewarmed": False,
                "reason": "visual_index_unavailable",
            }

        started_at = perf_counter()
        index_started_at = perf_counter()
        self.index.load()
        index_load_ms = (perf_counter() - index_started_at) * 1000.0

        runtime_started_at = perf_counter()
        self._ensure_runtime()
        runtime_load_ms = (perf_counter() - runtime_started_at) * 1000.0

        result: dict[str, Any] = {
            "available": True,
            "prewarmed": True,
            "indexEntryCount": len(self.index.entries),
            "timings": {
                "indexLoadMs": round(index_load_ms, 3),
                "runtimeLoadMs": round(runtime_load_ms, 3),
                "totalMs": round((perf_counter() - started_at) * 1000.0, 3),
            },
        }
        if run_inference:
            inference_started_at = perf_counter()
            _, inference_debug = self.match_payload(
                self._build_prewarm_payload(),
                top_k=1,
                telemetry_context="prewarm",
            )
            result["inferencePrewarmed"] = True
            result["inferenceDebug"] = inference_debug
            result["timings"]["inferenceMs"] = round((perf_counter() - inference_started_at) * 1000.0, 3)
            result["timings"]["totalMs"] = round((perf_counter() - started_at) * 1000.0, 3)
        return result

    @staticmethod
    def _build_prewarm_payload() -> dict[str, Any]:
        try:
            from PIL import Image
        except ImportError as exc:
            raise RuntimeError("Pillow is required for visual query image decoding.") from exc

        image = Image.new("RGB", (630, 880), color=(127, 127, 127))
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=82, optimize=True)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return {
            "image": {
                "jpegBase64": encoded,
                "width": 630,
                "height": 880,
            },
            "clientContext": {
                "platform": "server_prewarm",
            },
            "scanID": "visual-runtime-prewarm",
        }

    def _begin_inference_telemetry(self) -> tuple[int, float | None]:
        started_at = perf_counter()
        with self._telemetry_lock:
            self._inference_count += 1
            idle_before_ms = None
            if self._last_inference_finished_at is not None:
                idle_before_ms = max(0.0, (started_at - self._last_inference_finished_at) * 1000.0)
            return self._inference_count, idle_before_ms

    def _finish_inference_telemetry(self) -> None:
        finished_at = perf_counter()
        with self._telemetry_lock:
            self._last_inference_finished_at = finished_at

    def _ensure_runtime(self) -> None:
        if self._runtime_ready:
            return
        with self._runtime_lock:
            if self._runtime_ready:
                return
            encoder = RawVisualFrozenEncoder(model_id=self.model_id, device="auto")
            adapter = None
            if self.adapter_checkpoint_path and self.adapter_checkpoint_path.exists():
                adapter = load_projection_adapter(
                    self.adapter_checkpoint_path,
                    embedding_dim=encoder.embedding_dim,
                    device=encoder.device,
                )
            self._encoder = encoder
            self._adapter = adapter
            self._runtime_ready = True

    def _load_query_image(self, payload: dict[str, Any]) -> DecodedQueryImage:
        try:
            from PIL import Image
        except ImportError as exc:
            raise RuntimeError("Pillow is required for visual query image decoding.") from exc

        image_payload = payload.get("image") or {}
        normalized_image_base64 = str(
            payload.get("normalizedImageBase64")
            or (image_payload.get("jpegBase64") if isinstance(image_payload, dict) else "")
            or ""
        ).strip()
        if normalized_image_base64:
            try:
                raw_bytes = base64.b64decode(normalized_image_base64, validate=True)
            except Exception as exc:
                raise ValueError("normalizedImageBase64 is not valid base64.") from exc
            decoded = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
            return DecodedQueryImage(
                image=decoded,
                source="base64",
                encodedBytes=len(raw_bytes),
                encodedBase64Chars=len(normalized_image_base64),
                decodedWidth=int(decoded.size[0]),
                decodedHeight=int(decoded.size[1]),
            )

        normalized_image_path = str(
            payload.get("normalizedImagePath")
            or (image_payload.get("path") if isinstance(image_payload, dict) else "")
            or ""
        ).strip()
        if normalized_image_path:
            path = Path(normalized_image_path)
            decoded = Image.open(path).convert("RGB")
            encoded_bytes = path.stat().st_size if path.exists() else 0
            return DecodedQueryImage(
                image=decoded,
                source="path",
                encodedBytes=int(encoded_bytes),
                encodedBase64Chars=0,
                decodedWidth=int(decoded.size[0]),
                decodedHeight=int(decoded.size[1]),
            )

        raise ValueError(
            "Payload does not include a normalized image. Expected "
            "normalizedImageBase64/normalizedImagePath or image.jpegBase64."
        )

    def _query_language_preference(self, payload: dict[str, Any]) -> tuple[str | None, float, list[str]]:
        ocr_analysis = payload.get("ocrAnalysis") or {}
        raw_evidence = ocr_analysis.get("rawEvidence") or {}
        title_confidence = raw_evidence.get("titleConfidence") or {}
        title_confidence_score = float(title_confidence.get("score") or 0.0)
        title_text_primary = str(raw_evidence.get("titleTextPrimary") or "").strip()

        text_fragments: list[str] = []
        for value in (
            title_text_primary,
            raw_evidence.get("titleTextSecondary"),
            raw_evidence.get("wholeCardText"),
            raw_evidence.get("footerBandText"),
            payload.get("wholeCardText"),
        ):
            text = str(value or "").strip()
            if text:
                text_fragments.append(text)

        for item in payload.get("recognizedTokens") or []:
            text = str(item or "").strip()
            if text:
                text_fragments.append(text)

        combined = " ".join(text_fragments)
        if not combined:
            return None, 0.0, []

        if title_text_primary:
            title_japanese_chars, title_latin_chars, _ = _language_character_counts(title_text_primary)
            if title_japanese_chars >= 1:
                confidence = min(1.0, 0.85 + min(0.10, title_japanese_chars * 0.02))
                return "Japanese", round(confidence, 4), text_fragments
            if title_latin_chars >= 6:
                confidence = max(0.70, min(1.0, 0.75 + min(0.15, title_latin_chars * 0.01) + (title_confidence_score * 0.10)))
                return "English", round(confidence, 4), text_fragments

        japanese_chars, latin_chars, digit_chars = _language_character_counts(combined)

        if japanese_chars >= 4 and japanese_chars * 4 >= max(1, latin_chars):
            confidence = min(1.0, 0.80 + min(0.15, japanese_chars * 0.02))
            return "Japanese", round(confidence, 4), text_fragments

        if latin_chars >= 8 and japanese_chars == 0 and latin_chars >= max(4, digit_chars):
            confidence = max(0.65, min(1.0, 0.70 + min(0.20, latin_chars * 0.01) + (title_confidence_score * 0.10)))
            return "English", round(confidence, 4), text_fragments

        return None, 0.0, text_fragments

    def _image_embedding_with_timing(self, image) -> tuple[np.ndarray, dict[str, float]]:
        assert self._encoder is not None
        encoder_started_at = perf_counter()
        embeddings, encoder_timing = self._encoder.embed_images_with_timing([image], batch_size=1)
        embedding = embeddings[0]
        adapter_project_ms = 0.0
        if self._adapter is not None:
            adapter_started_at = perf_counter()
            embedding = project_embeddings_numpy(
                self._adapter,
                embedding[None, :],
                device=self._encoder.device,
                batch_size=1,
            )[0]
            adapter_project_ms = (perf_counter() - adapter_started_at) * 1000.0
        normalize_started_at = perf_counter()
        embedding = np.nan_to_num(embedding, nan=0.0, posinf=0.0, neginf=0.0)
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        normalize_ms = (perf_counter() - normalize_started_at) * 1000.0
        total_ms = (perf_counter() - encoder_started_at) * 1000.0
        return embedding, {
            "encoderPreprocessMs": round(float(encoder_timing.get("preprocessMs") or 0.0), 3),
            "encoderForwardMs": round(float(encoder_timing.get("modelForwardMs") or 0.0), 3),
            "encoderPostprocessMs": round(float(encoder_timing.get("postprocessMs") or 0.0), 3),
            "adapterProjectMs": round(adapter_project_ms, 3),
            "embeddingNormalizeMs": round(normalize_ms, 3),
            "embeddingMs": round(total_ms, 3),
        }

    @staticmethod
    def _uses_exact_reticle_fallback(payload: dict[str, Any]) -> bool:
        ocr_analysis = payload.get("ocrAnalysis") or {}
        normalized_target = ocr_analysis.get("normalizedTarget") or {}
        target_quality = normalized_target.get("targetQuality") or {}
        reasons = target_quality.get("reasons") or []
        return any(str(reason or "").strip().lower() == "normalization:exact_reticle_fallback" for reason in reasons)

    @staticmethod
    def _center_inset_image(image, inset_ratio: float):
        width, height = image.size
        inset_x = int(round(width * inset_ratio))
        inset_y = int(round(height * inset_ratio))
        if inset_x <= 0 or inset_y <= 0:
            return image.copy()
        if (width - (inset_x * 2)) < max(16, int(width * 0.25)):
            return image.copy()
        if (height - (inset_y * 2)) < max(16, int(height * 0.25)):
            return image.copy()
        return image.crop((inset_x, inset_y, width - inset_x, height - inset_y)).resize((width, height))

    def _query_variants(self, payload: dict[str, Any], image) -> list[RawVisualQueryVariant]:
        variants = [RawVisualQueryVariant(name="base", image=image, inset_ratio=0.0)]
        if self._uses_exact_reticle_fallback(payload):
            variants.append(
                RawVisualQueryVariant(
                    name="center_inset_4",
                    image=self._center_inset_image(image, 0.04),
                    inset_ratio=0.04,
                )
            )
        return variants

    @staticmethod
    def _apply_language_adjustments(
        raw_matches: list[RawVisualSearchMatch],
        *,
        preferred_language: str | None,
        preferred_language_confidence: float,
        apply_language_bias: bool,
        variant_name: str,
        variant_inset_ratio: float,
    ) -> list[RawVisualSearchMatch]:
        adjusted_matches: list[RawVisualSearchMatch] = []
        for match in raw_matches:
            adjusted_similarity = float(match.similarity)
            adjustment_reasons: list[str] = []
            candidate_language = _normalize_language(match.entry.get("language"))
            provider_card_id = str(match.entry.get("providerCardId") or "")

            if provider_card_id.lower().startswith("tcgp-"):
                adjusted_similarity -= 0.06
                adjustment_reasons.append("tcgp_penalty")

            if apply_language_bias and candidate_language:
                if candidate_language == preferred_language:
                    adjusted_similarity += 0.01
                    adjustment_reasons.append("language_bonus")
                else:
                    adjusted_similarity -= 0.08
                    adjustment_reasons.append("language_penalty")

            adjusted_entry = dict(match.entry)
            adjusted_entry["_visualBaseSimilarity"] = round(float(match.similarity), 6)
            adjusted_entry["_visualAdjustedSimilarity"] = round(adjusted_similarity, 6)
            adjusted_entry["_visualLanguagePreference"] = preferred_language
            adjusted_entry["_visualLanguageConfidence"] = preferred_language_confidence
            adjusted_entry["_visualLanguageAdjustmentReasons"] = adjustment_reasons
            adjusted_entry["_visualQueryVariant"] = variant_name
            adjusted_entry["_visualQueryInsetRatio"] = round(variant_inset_ratio, 4)
            adjusted_matches.append(
                RawVisualSearchMatch(
                    row_index=match.row_index,
                    similarity=adjusted_similarity,
                    entry=adjusted_entry,
                )
            )
        adjusted_matches.sort(key=lambda item: item.similarity, reverse=True)
        return adjusted_matches

    @staticmethod
    def _merge_variant_matches(
        variant_matches: list[list[RawVisualSearchMatch]],
        *,
        top_k: int,
    ) -> list[RawVisualSearchMatch]:
        merged_by_key: dict[str, RawVisualSearchMatch] = {}
        variant_names_by_key: dict[str, set[str]] = {}
        for matches in variant_matches:
            for match in matches:
                provider_card_id = str(match.entry.get("providerCardId") or match.entry.get("id") or "").strip()
                entry_key = provider_card_id or f"row:{match.row_index}"
                variant_name = str(match.entry.get("_visualQueryVariant") or "base")
                variant_names_by_key.setdefault(entry_key, set()).add(variant_name)
                current = merged_by_key.get(entry_key)
                if current is None or match.similarity > current.similarity:
                    merged_by_key[entry_key] = match

        merged_matches: list[RawVisualSearchMatch] = []
        for key, match in merged_by_key.items():
            merged_entry = dict(match.entry)
            merged_entry["_visualQueryVariants"] = sorted(variant_names_by_key.get(key) or [])
            merged_matches.append(
                RawVisualSearchMatch(
                    row_index=match.row_index,
                    similarity=match.similarity,
                    entry=merged_entry,
                )
            )
        merged_matches.sort(key=lambda item: item.similarity, reverse=True)
        return merged_matches[:top_k]

    def match_payload(
        self,
        payload: dict[str, Any],
        *,
        top_k: int = 10,
        telemetry_context: str = "live_scan",
    ) -> tuple[list[RawVisualSearchMatch], dict[str, Any]]:
        if not self.is_available():
            raise RuntimeError("Visual index artifacts are not available.")
        match_started_at = perf_counter()
        inference_sequence, idle_before_ms = self._begin_inference_telemetry()

        try:
            decode_started_at = perf_counter()
            decoded_query = self._load_query_image(payload)
            image_decode_ms = (perf_counter() - decode_started_at) * 1000.0

            runtime_started_at = perf_counter()
            self._ensure_runtime()
            ensure_runtime_ms = (perf_counter() - runtime_started_at) * 1000.0

            internal_top_k = max(top_k * 8, 64)
            preferred_language, preferred_language_confidence, language_fragments = self._query_language_preference(payload)
            apply_language_bias = preferred_language is not None and preferred_language_confidence >= 0.65

            embedding_ms = 0.0
            index_search_ms = 0.0
            encoder_preprocess_ms = 0.0
            encoder_forward_ms = 0.0
            encoder_postprocess_ms = 0.0
            adapter_project_ms = 0.0
            embedding_normalize_ms = 0.0
            variant_debug: list[dict[str, Any]] = []
            variant_matches: list[list[RawVisualSearchMatch]] = []
            query_variants = self._query_variants(payload, decoded_query.image)
            for query_variant in query_variants:
                embedding, embedding_timing = self._image_embedding_with_timing(query_variant.image)
                embedding_ms += float(embedding_timing.get("embeddingMs") or 0.0)
                encoder_preprocess_ms += float(embedding_timing.get("encoderPreprocessMs") or 0.0)
                encoder_forward_ms += float(embedding_timing.get("encoderForwardMs") or 0.0)
                encoder_postprocess_ms += float(embedding_timing.get("encoderPostprocessMs") or 0.0)
                adapter_project_ms += float(embedding_timing.get("adapterProjectMs") or 0.0)
                embedding_normalize_ms += float(embedding_timing.get("embeddingNormalizeMs") or 0.0)

                index_started_at = perf_counter()
                raw_matches = self.index.search(embedding, top_k=internal_top_k)
                index_search_ms += (perf_counter() - index_started_at) * 1000.0

                adjusted_matches = self._apply_language_adjustments(
                    raw_matches,
                    preferred_language=preferred_language,
                    preferred_language_confidence=preferred_language_confidence,
                    apply_language_bias=apply_language_bias,
                    variant_name=query_variant.name,
                    variant_inset_ratio=query_variant.inset_ratio,
                )
                variant_matches.append(adjusted_matches)
                top_match = adjusted_matches[0] if adjusted_matches else None
                variant_debug.append(
                    {
                        "name": query_variant.name,
                        "insetRatio": round(query_variant.inset_ratio, 4),
                        "topCandidateProviderCardId": (
                            str((top_match.entry.get("providerCardId") or top_match.entry.get("id") or "")) if top_match else None
                        ),
                        "topCandidateName": top_match.entry.get("name") if top_match else None,
                        "topSimilarity": round(float(top_match.similarity), 6) if top_match else None,
                    }
                )

            matches = self._merge_variant_matches(variant_matches, top_k=top_k)
            debug = {
                "modelId": self.model_id,
                "indexNpzPath": str(self.index.npz_path),
                "indexManifestPath": str(self.index.manifest_path),
                "adapterCheckpointPath": str(self.adapter_checkpoint_path) if self.adapter_checkpoint_path and self.adapter_checkpoint_path.exists() else None,
                "adapterMetadataPath": str(self.adapter_metadata_path) if self.adapter_metadata_path and self.adapter_metadata_path.exists() else None,
                "topK": top_k,
                "internalTopK": internal_top_k,
                "preferredLanguage": preferred_language,
                "preferredLanguageConfidence": preferred_language_confidence,
                "languageFragments": language_fragments[:8],
                "languageBiasApplied": apply_language_bias,
                "queryVariants": variant_debug,
                "queryVariantCount": len(query_variants),
                "queryVariantStrategy": "best_similarity_dedupe",
                "inferenceContext": telemetry_context,
                "inferenceSequence": inference_sequence,
                "idleBeforeMs": round(idle_before_ms, 3) if idle_before_ms is not None else None,
                "queryImage": {
                    "source": decoded_query.source,
                    "encodedBytes": decoded_query.encodedBytes,
                    "encodedBase64Chars": decoded_query.encodedBase64Chars,
                    "decodedWidth": decoded_query.decodedWidth,
                    "decodedHeight": decoded_query.decodedHeight,
                },
                "timings": {
                    "imageDecodeMs": round(image_decode_ms, 3),
                    "ensureRuntimeMs": round(ensure_runtime_ms, 3),
                    "embeddingMs": round(embedding_ms, 3),
                    "encoderPreprocessMs": round(encoder_preprocess_ms, 3),
                    "encoderForwardMs": round(encoder_forward_ms, 3),
                    "encoderPostprocessMs": round(encoder_postprocess_ms, 3),
                    "adapterProjectMs": round(adapter_project_ms, 3),
                    "embeddingNormalizeMs": round(embedding_normalize_ms, 3),
                    "indexSearchMs": round(index_search_ms, 3),
                    "matchPayloadMs": round((perf_counter() - match_started_at) * 1000.0, 3),
                },
            }
            return matches, debug
        finally:
            self._finish_inference_telemetry()
