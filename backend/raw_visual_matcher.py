from __future__ import annotations

import base64
import io
import json
import os
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

import numpy as np

from raw_visual_index import RawVisualIndex, RawVisualSearchMatch
from raw_visual_model import RawVisualFrozenEncoder, load_projection_adapter, project_embeddings_numpy
from raw_visual_user_photo_rerank import RawVisualUserPhotoRerankPool


# Mini-index routing thresholds:
# - 0.55 is the floor for "this query looks like a basic energy" — below it
#   we trust the main lookup. The main index covers basic energies too, so we
#   only override when the mini-index is BOTH above the floor AND ahead of the
#   main top-1.
_MINI_ENERGY_INDEX_MIN_SIMILARITY = 0.55
# Language probe min confidence to apply the soft signal as a fallback
# preferred_language. Below this we don't trust the visual probe and let
# the main matcher behave as if no language hint were available.
_LANGUAGE_PROBE_MIN_CONFIDENCE = 0.80


def _emit_matcher_log(severity: str, event: str, **fields: Any) -> None:
    payload: dict[str, Any] = {"severity": severity, "event": event}
    payload.update(fields)
    try:
        print(json.dumps(payload, separators=(",", ":")), file=sys.stderr, flush=True)
    except Exception:
        # Logging must never break inference.
        pass


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


def _language_from_client_locale(value: Any) -> str | None:
    """Map a BCP-47-ish locale identifier (e.g. 'en-US', 'ja_JP') to one of
    {"English", "Japanese"}. Defaults to English for anything non-Japanese.
    Returns None when the input is empty so callers can distinguish 'no
    locale provided' from 'locale is non-Japanese'.
    """
    normalized = str(value or "").strip()
    if not normalized:
        return None
    primary = normalized.replace("_", "-").split("-", 1)[0].lower()
    if primary == "ja":
        return "Japanese"
    return "English"


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


def _env_flag_enabled(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "on", "yes"}


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


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
        user_photo_rerank_npz_path: Path | None = None,
        user_photo_rerank_manifest_path: Path | None = None,
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
        # User-photo rerank pool (Option D): defaults off, enable via env var.
        # Pool path defaults to the canonical artifact built by tools/build_user_photo_rerank_pool.py.
        rerank_npz_env = os.environ.get("SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_POOL_NPZ_PATH")
        rerank_manifest_env = os.environ.get("SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_POOL_MANIFEST_PATH")
        default_rerank_npz_path = default_root / "visual_index_user_photos_rerank_pool_v002_clip-vit-base-patch32.npz"
        default_rerank_manifest_path = default_root / "visual_index_user_photos_rerank_pool_v002_manifest.json"
        self.user_photo_rerank_npz_path = user_photo_rerank_npz_path or resolve_repo_relative_path(
            repo_root, rerank_npz_env, default_rerank_npz_path,
        )
        self.user_photo_rerank_manifest_path = user_photo_rerank_manifest_path or resolve_repo_relative_path(
            repo_root, rerank_manifest_env, default_rerank_manifest_path,
        )
        self.user_photo_rerank_enabled = _env_flag_enabled("SPOTLIGHT_VISUAL_USER_PHOTO_RERANK", default=False)
        self.user_photo_rerank_alpha = _env_float("SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_ALPHA", 0.1)
        # Threshold gate: only boost when user-photo similarity is high enough to be trustworthy.
        # 0.90 was chosen 2026-05-12 because:
        #   - same-card user-photo similarities cluster ~0.95 (covered queries)
        #   - cross-card lookalike similarities cluster <0.86 (the held-out umbreon vs me2-75 case)
        #   - 0.90 is between the two distributions, preserves all held-out top-1 results
        #     while still gaining +13 top-1 fixtures on covered cards
        self.user_photo_rerank_threshold = _env_float("SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_THRESHOLD", 0.90)
        self.user_photo_rerank_shortlist_k = _env_int("SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_SHORTLIST_K", 50)
        self._user_photo_rerank_pool: RawVisualUserPhotoRerankPool | None = None

        # Basic-energy mini-index: a small parallel CLIP embedding index that
        # routes obvious basic-energy queries away from the main lookup. Built
        # by tools/build_basic_energy_mini_index.py.
        mini_index_env = os.environ.get("SPOTLIGHT_VISUAL_BASIC_ENERGY_MINI_INDEX_PATH")
        default_mini_index_path = default_root / "basic_energy_mini_index.npz"
        self.basic_energy_mini_index_path = resolve_repo_relative_path(
            repo_root, mini_index_env, default_mini_index_path,
        )
        self._basic_energy_mini_index: dict[str, Any] | None = None
        self._load_basic_energy_mini_index()

        # Language probe: a small logistic regression over CLIP embeddings
        # that estimates EN vs JP. Used as a fallback preferred_language when
        # OCR-derived hints are missing.
        language_probe_env = os.environ.get("SPOTLIGHT_VISUAL_LANGUAGE_PROBE_PATH")
        default_language_probe_path = default_model_root / "language_probe_v1.npz"
        self.language_probe_path = resolve_repo_relative_path(
            repo_root, language_probe_env, default_language_probe_path,
        )
        self._language_probe: dict[str, Any] | None = None
        self._load_language_probe()

        self._encoder: RawVisualFrozenEncoder | None = None
        self._adapter = None
        self._runtime_lock = threading.Lock()
        self._telemetry_lock = threading.Lock()
        self._runtime_ready = False
        self._inference_count = 0
        self._last_inference_finished_at: float | None = None

    def _load_basic_energy_mini_index(self) -> None:
        path = getattr(self, "basic_energy_mini_index_path", None)
        if path is None or not Path(path).exists():
            _emit_matcher_log(
                "WARNING",
                "basic_energy_mini_index_unavailable",
                path=str(path) if path is not None else None,
                reason="missing_file",
            )
            self._basic_energy_mini_index = None
            return
        try:
            archive = np.load(str(path), allow_pickle=True)
            embeddings = np.asarray(archive["embeddings"], dtype=np.float32)
            card_ids = np.asarray(archive["card_ids"])
            names = np.asarray(archive["names"])
            languages = np.asarray(archive["languages"])
            set_names = np.asarray(archive["set_names"])
        except Exception as exc:
            _emit_matcher_log(
                "WARNING",
                "basic_energy_mini_index_load_failed",
                path=str(path),
                error=str(exc),
            )
            self._basic_energy_mini_index = None
            return
        if embeddings.ndim != 2 or embeddings.shape[0] == 0:
            _emit_matcher_log(
                "WARNING",
                "basic_energy_mini_index_invalid_shape",
                path=str(path),
                shape=list(embeddings.shape),
            )
            self._basic_energy_mini_index = None
            return
        self._basic_energy_mini_index = {
            "embeddings": embeddings,
            "card_ids": card_ids,
            "names": names,
            "languages": languages,
            "set_names": set_names,
            "path": str(path),
        }
        _emit_matcher_log(
            "INFO",
            "basic_energy_mini_index_loaded",
            path=str(path),
            rowCount=int(embeddings.shape[0]),
            embeddingDim=int(embeddings.shape[1]),
        )

    def _load_language_probe(self) -> None:
        path = getattr(self, "language_probe_path", None)
        if path is None or not Path(path).exists():
            _emit_matcher_log(
                "WARNING",
                "visual_language_probe_unavailable",
                path=str(path) if path is not None else None,
                reason="missing_file",
            )
            self._language_probe = None
            return
        try:
            archive = np.load(str(path), allow_pickle=True)
            coef = np.asarray(archive["coef"], dtype=np.float32)
            intercept = np.asarray(archive["intercept"], dtype=np.float32)
            classes = np.asarray(archive["classes"])
        except Exception as exc:
            _emit_matcher_log(
                "WARNING",
                "visual_language_probe_load_failed",
                path=str(path),
                error=str(exc),
            )
            self._language_probe = None
            return
        if coef.ndim != 2 or intercept.ndim != 1 or coef.shape[0] != intercept.shape[0]:
            _emit_matcher_log(
                "WARNING",
                "visual_language_probe_invalid_shape",
                path=str(path),
                coefShape=list(coef.shape),
                interceptShape=list(intercept.shape),
            )
            self._language_probe = None
            return
        self._language_probe = {
            "coef": coef,
            "intercept": intercept,
            "classes": classes,
            "path": str(path),
        }
        _emit_matcher_log(
            "INFO",
            "visual_language_probe_loaded",
            path=str(path),
            classes=[str(value) for value in classes.tolist()],
            featureDim=int(coef.shape[1]),
        )

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
            rerank_enabled = getattr(self, "user_photo_rerank_enabled", False)
            rerank_npz = getattr(self, "user_photo_rerank_npz_path", None)
            rerank_manifest = getattr(self, "user_photo_rerank_manifest_path", None)
            if (
                rerank_enabled
                and rerank_npz
                and rerank_manifest
                and rerank_npz.exists()
                and rerank_manifest.exists()
            ):
                pool = RawVisualUserPhotoRerankPool(
                    npz_path=rerank_npz,
                    manifest_path=rerank_manifest,
                )
                pool.load()
                self._user_photo_rerank_pool = pool
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
        # An explicit, user-selected language from the scanner "Scanning for"
        # toggle is authoritative: trust it over OCR character counting and the
        # visual language probe. High confidence (above the 0.65 bias threshold)
        # so the language bias is applied without further inference.
        explicit_language = _normalize_language(payload.get("cardLanguage"))
        if explicit_language is not None:
            return explicit_language, 0.99, []

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

    def _query_mini_energy_index(
        self, query_embedding: np.ndarray
    ) -> tuple[float, int] | None:
        """Return (top_similarity, top_row_index) over the basic-energy
        mini-index, or None if the index isn't loaded.

        Embeddings in the mini-index are L2-normalized so cosine similarity
        reduces to a dot product. The query embedding is expected to be
        L2-normalized as well (the main lookup already normalizes it).
        """
        mini = getattr(self, "_basic_energy_mini_index", None)
        if mini is None:
            return None
        embeddings: np.ndarray = mini["embeddings"]
        if embeddings.shape[0] == 0:
            return None
        if query_embedding.shape[-1] != embeddings.shape[1]:
            return None
        scores = embeddings @ query_embedding.astype(np.float32, copy=False)
        top_index = int(np.argmax(scores))
        return float(scores[top_index]), top_index

    def _mini_energy_rank_with_language_preference(
        self,
        query_embedding: np.ndarray,
        *,
        target_language: str | None,
    ) -> dict[str, Any] | None:
        """Return the top mini-index hit, preferring rows that match
        `target_language` when one of the top-3 matches it. Falls back to
        rank-1 otherwise.
        """
        mini = getattr(self, "_basic_energy_mini_index", None)
        if mini is None:
            return None
        embeddings: np.ndarray = mini["embeddings"]
        if embeddings.shape[0] == 0:
            return None
        if query_embedding.shape[-1] != embeddings.shape[1]:
            return None
        scores = embeddings @ query_embedding.astype(np.float32, copy=False)
        order = np.argsort(scores)[::-1]
        top_indexes = order[: min(3, order.shape[0])].tolist()
        top1_index = int(top_indexes[0])
        selected_index = top1_index
        if target_language:
            normalized_target = _normalize_language(target_language) or str(target_language).strip()
            for candidate_index in top_indexes:
                candidate_language = str(mini["languages"][int(candidate_index)] or "").strip()
                if candidate_language == normalized_target:
                    selected_index = int(candidate_index)
                    break
        return {
            "rowIndex": selected_index,
            "top1Index": top1_index,
            "top1Similarity": float(scores[top1_index]),
            "selectedSimilarity": float(scores[selected_index]),
            "cardId": str(mini["card_ids"][selected_index]),
            "name": str(mini["names"][selected_index]),
            "language": str(mini["languages"][selected_index]),
            "setName": str(mini["set_names"][selected_index]),
        }

    def _predict_language(
        self, query_embedding: np.ndarray
    ) -> tuple[str | None, float]:
        """Run the logistic-regression language probe over the embedding.

        Returns (predicted_language, confidence). If the probe artifact is
        unavailable or the prediction confidence is below the threshold,
        returns (None, confidence).
        """
        probe = getattr(self, "_language_probe", None)
        if probe is None:
            return None, 0.0
        coef: np.ndarray = probe["coef"]
        intercept: np.ndarray = probe["intercept"]
        classes: np.ndarray = probe["classes"]
        if coef.shape[1] != query_embedding.shape[-1]:
            return None, 0.0
        logits = coef @ query_embedding.astype(np.float32, copy=False) + intercept
        # Stable softmax.
        shifted = logits - float(np.max(logits))
        exp = np.exp(shifted)
        probabilities = exp / np.sum(exp)
        top = int(np.argmax(probabilities))
        confidence = float(probabilities[top])
        predicted_raw = str(classes[top])
        predicted = _normalize_language(predicted_raw) or predicted_raw
        if confidence < _LANGUAGE_PROBE_MIN_CONFIDENCE:
            return None, confidence
        return predicted, confidence

    def _maybe_route_basic_energy_mini_index(
        self,
        *,
        matches: list[RawVisualSearchMatch],
        base_variant_embedding: np.ndarray | None,
        payload: dict[str, Any],
        preferred_language: str | None,
    ) -> dict[str, Any] | None:
        """Run the mini-index against the base query embedding and, when its
        top hit is both above the floor AND ahead of the main top-1, return a
        debug dict containing a `_replacementMatch` to be substituted into
        position 0 of the main result list.

        Returns None when the mini-index is unavailable (no debug fields are
        added in that case). Returns `{enabled: true, used: false, ...}` when
        the mini-index ran but did not route.
        """
        mini = getattr(self, "_basic_energy_mini_index", None)
        if mini is None or base_variant_embedding is None:
            return None
        mini_top = self._query_mini_energy_index(base_variant_embedding)
        main_top_similarity: float | None = None
        if matches:
            # Prefer the unadjusted base similarity for the comparison so
            # language penalties on the main side don't artificially help
            # routing. Fall back to the adjusted similarity if not present.
            top_entry = matches[0].entry
            base_similarity = top_entry.get("_visualBaseSimilarity")
            main_top_similarity = (
                float(base_similarity)
                if isinstance(base_similarity, (int, float))
                else float(matches[0].similarity)
            )

        if mini_top is None:
            return {
                "enabled": True,
                "used": False,
                "miniTop1Similarity": None,
                "mainTop1Similarity": main_top_similarity,
                "reason": "mini_index_empty",
            }

        mini_top_similarity, _ = mini_top
        used = (
            mini_top_similarity > _MINI_ENERGY_INDEX_MIN_SIMILARITY
            and (main_top_similarity is None or mini_top_similarity > main_top_similarity)
        )
        if not used:
            return {
                "enabled": True,
                "used": False,
                "miniTop1Similarity": round(mini_top_similarity, 6),
                "mainTop1Similarity": (
                    round(main_top_similarity, 6) if main_top_similarity is not None else None
                ),
            }

        # Determine target language: preferredLanguage (from OCR/probe) wins,
        # else fall back to client locale.
        client_context = payload.get("clientContext") or {}
        locale_identifier = (
            client_context.get("localeIdentifier") if isinstance(client_context, dict) else None
        )
        target_language = preferred_language or _language_from_client_locale(locale_identifier)
        if target_language is None:
            target_language = "English"

        selection = self._mini_energy_rank_with_language_preference(
            base_variant_embedding, target_language=target_language,
        )
        if selection is None:
            return {
                "enabled": True,
                "used": False,
                "miniTop1Similarity": round(mini_top_similarity, 6),
                "mainTop1Similarity": (
                    round(main_top_similarity, 6) if main_top_similarity is not None else None
                ),
                "reason": "selection_unavailable",
            }

        replacement_entry: dict[str, Any] = {
            "providerCardId": selection["cardId"],
            "name": selection["name"],
            "language": selection["language"],
            "setName": selection["setName"],
            "_visualBaseSimilarity": round(float(selection["selectedSimilarity"]), 6),
            "_visualAdjustedSimilarity": round(float(selection["selectedSimilarity"]), 6),
            "_visualLanguagePreference": preferred_language,
            "_visualLanguageConfidence": 0.0,
            "_visualLanguageAdjustmentReasons": ["mini_index_energy_routed"],
            "_visualQueryVariant": "base",
            "_visualQueryInsetRatio": 0.0,
            "_visualQueryVariants": ["base"],
            "_miniIndexEnergyRouted": True,
        }
        replacement_match = RawVisualSearchMatch(
            row_index=-1,
            similarity=float(selection["selectedSimilarity"]),
            entry=replacement_entry,
        )
        return {
            "enabled": True,
            "used": True,
            "miniTop1Similarity": round(mini_top_similarity, 6),
            "mainTop1Similarity": (
                round(main_top_similarity, 6) if main_top_similarity is not None else None
            ),
            "selectedLanguage": selection["language"],
            "selectedCardId": selection["cardId"],
            "targetLanguage": target_language,
            "_replacementMatch": replacement_match,
        }

    def _apply_user_photo_rerank(
        self,
        matches: list[RawVisualSearchMatch],
        *,
        query_embedding: np.ndarray,
        top_k: int,
    ) -> tuple[list[RawVisualSearchMatch], dict[str, Any]]:
        pool = getattr(self, "_user_photo_rerank_pool", None)
        if pool is None or not matches:
            return matches[:top_k], {
                "applied": False,
                "reason": "pool_unavailable" if pool is None else "no_matches",
                "shortlistConsidered": len(matches),
                "boostsApplied": 0,
            }

        alpha = float(getattr(self, "user_photo_rerank_alpha", 0.1))
        threshold = float(getattr(self, "user_photo_rerank_threshold", 0.90))
        boost_log: list[dict[str, Any]] = []
        boosted_matches: list[RawVisualSearchMatch] = []
        for match in matches:
            provider_card_id = str(match.entry.get("providerCardId") or match.entry.get("id") or "").strip()
            adjusted_similarity = float(match.similarity)
            user_photo_max: float | None = None
            boost_value = 0.0
            if provider_card_id and pool.has_rows_for(provider_card_id):
                user_photo_max = pool.max_similarity_for(provider_card_id, query_embedding)
                if user_photo_max is not None and user_photo_max >= threshold:
                    boost_value = alpha * user_photo_max
                    adjusted_similarity += boost_value
                    boost_log.append({
                        "providerCardId": provider_card_id,
                        "userPhotoMaxSimilarity": round(user_photo_max, 6),
                        "boost": round(boost_value, 6),
                        "preBoostSimilarity": round(float(match.similarity), 6),
                        "postBoostSimilarity": round(adjusted_similarity, 6),
                    })

            entry = dict(match.entry)
            entry["_userPhotoRerankApplied"] = boost_value > 0.0
            entry["_userPhotoMaxSimilarity"] = (
                round(user_photo_max, 6) if user_photo_max is not None else None
            )
            entry["_userPhotoBoost"] = round(boost_value, 6)
            entry["_userPhotoPreBoostSimilarity"] = round(float(match.similarity), 6)
            boosted_matches.append(
                RawVisualSearchMatch(
                    row_index=match.row_index,
                    similarity=adjusted_similarity,
                    entry=entry,
                )
            )

        boosted_matches.sort(key=lambda item: item.similarity, reverse=True)
        return boosted_matches[:top_k], {
            "applied": True,
            "alpha": round(alpha, 6),
            "threshold": round(threshold, 6),
            "shortlistConsidered": len(matches),
            "boostsApplied": len(boost_log),
            "poolUniqueCardCount": pool.unique_card_count,
            "poolRowCount": pool.row_count,
            "poolArtifactVersion": pool.artifact_version,
            "boosts": boost_log[:20],
        }

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
            ocr_language_signal_present = preferred_language is not None

            embedding_ms = 0.0
            index_search_ms = 0.0
            encoder_preprocess_ms = 0.0
            encoder_forward_ms = 0.0
            encoder_postprocess_ms = 0.0
            adapter_project_ms = 0.0
            embedding_normalize_ms = 0.0
            variant_debug: list[dict[str, Any]] = []
            variant_matches: list[list[RawVisualSearchMatch]] = []
            base_variant_embedding: np.ndarray | None = None
            language_probe_debug: dict[str, Any] = {
                "enabled": getattr(self, "_language_probe", None) is not None,
                "predictedLanguage": None,
                "predictedLanguageConfidence": 0.0,
                "applied": False,
            }
            query_variants = self._query_variants(payload, decoded_query.image)
            for query_variant in query_variants:
                embedding, embedding_timing = self._image_embedding_with_timing(query_variant.image)
                if query_variant.name == "base":
                    base_variant_embedding = embedding
                    # Language probe fallback: only invoke when OCR-derived
                    # signal is absent. We need the base embedding before we
                    # can rerank, hence the inline placement.
                    if not ocr_language_signal_present and language_probe_debug["enabled"]:
                        probe_language, probe_confidence = self._predict_language(embedding)
                        language_probe_debug["predictedLanguageConfidence"] = round(float(probe_confidence), 6)
                        if probe_language is not None:
                            preferred_language = probe_language
                            preferred_language_confidence = round(float(probe_confidence), 6)
                            language_probe_debug["predictedLanguage"] = probe_language
                            language_probe_debug["applied"] = True
                embedding_ms += float(embedding_timing.get("embeddingMs") or 0.0)
                encoder_preprocess_ms += float(embedding_timing.get("encoderPreprocessMs") or 0.0)
                encoder_forward_ms += float(embedding_timing.get("encoderForwardMs") or 0.0)
                encoder_postprocess_ms += float(embedding_timing.get("encoderPostprocessMs") or 0.0)
                adapter_project_ms += float(embedding_timing.get("adapterProjectMs") or 0.0)
                embedding_normalize_ms += float(embedding_timing.get("embeddingNormalizeMs") or 0.0)

                apply_language_bias = preferred_language is not None and preferred_language_confidence >= 0.65

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

            # Use getattr defaults so tests that bypass __init__ (object.__new__)
            # don't blow up. In normal construction these are set by __init__.
            rerank_enabled = getattr(self, "user_photo_rerank_enabled", False)
            rerank_pool = getattr(self, "_user_photo_rerank_pool", None)
            rerank_shortlist_k = getattr(self, "user_photo_rerank_shortlist_k", 50)
            rerank_active = (
                rerank_enabled
                and rerank_pool is not None
                and base_variant_embedding is not None
            )
            shortlist_k = max(top_k, rerank_shortlist_k) if rerank_active else top_k
            shortlist = self._merge_variant_matches(variant_matches, top_k=shortlist_k)

            rerank_started_at = perf_counter()
            if rerank_active:
                matches, rerank_debug = self._apply_user_photo_rerank(
                    shortlist,
                    query_embedding=base_variant_embedding,  # type: ignore[arg-type]
                    top_k=top_k,
                )
            else:
                matches = shortlist[:top_k]
                rerank_debug = {
                    "applied": False,
                    "reason": (
                        "feature_disabled"
                        if not rerank_enabled
                        else (
                            "pool_unavailable"
                            if rerank_pool is None
                            else "no_base_embedding"
                        )
                    ),
                    "shortlistConsidered": len(shortlist),
                    "boostsApplied": 0,
                }
            user_photo_rerank_ms = (perf_counter() - rerank_started_at) * 1000.0

            # Final language-bias decision uses the latest signals (probe
            # may have promoted `preferred_language` mid-loop).
            language_bias_applied = (
                preferred_language is not None and preferred_language_confidence >= 0.65
            )

            # Mini-index basic-energy routing: run AFTER the main lookup so we
            # can compare similarities and override only when the mini-index is
            # both confident and beating the main top-1.
            mini_routed_debug = self._maybe_route_basic_energy_mini_index(
                matches=matches,
                base_variant_embedding=base_variant_embedding,
                payload=payload,
                preferred_language=preferred_language,
            )
            if mini_routed_debug is not None and mini_routed_debug.get("used"):
                replacement_match = mini_routed_debug.pop("_replacementMatch", None)
                if replacement_match is not None and matches:
                    matches = [replacement_match] + matches[1:]

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
                "languageBiasApplied": language_bias_applied,
                "languageProbe": language_probe_debug,
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
                "userPhotoRerank": rerank_debug,
                "miniIndexEnergyRouted": mini_routed_debug,
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
                    "userPhotoRerankMs": round(user_photo_rerank_ms, 3),
                    "matchPayloadMs": round((perf_counter() - match_started_at) * 1000.0, 3),
                },
            }
            return matches, debug
        finally:
            self._finish_inference_telemetry()
