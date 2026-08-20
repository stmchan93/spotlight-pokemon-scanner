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

from catalog_tools import (
    GAME_POKEMON,
    _collector_components,
    game_for_scan_payload,
    normalize_game,
)
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
# Min confidence for the visual language probe to flag a TARGET MISMATCH (the
# user picked a language the card visibly is not). This gates a user-facing
# "wrong toggle" warning that removes the scan from the tray, so it is set
# deliberately HIGHER than the soft-hint threshold to keep false positives
# (a valid scan wrongly rejected) rare. Tunable via env.
_LANGUAGE_MISMATCH_DEFAULT_MIN_CONFIDENCE = 0.90


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


def detect_language_mismatch(
    selected_language: Any,
    predicted_language: Any,
    confidence: float,
    *,
    min_confidence: float,
) -> dict[str, Any] | None:
    """Return a mismatch descriptor when the user's explicitly selected scan
    language disagrees with a confident visual language prediction, else None.

    Fires only when BOTH languages are known, they differ, and the prediction
    clears `min_confidence`. Pure and O(1) so it can run on every scan with no
    measurable cost — the heavy work (the embedding + probe) already happened.

    Returns lowercase language codes ('english' | 'japanese') to match the
    client's ScannerCardLanguage type.
    """
    selected = _normalize_language(selected_language)
    predicted = _normalize_language(predicted_language)
    if selected is None or predicted is None:
        return None
    if selected == predicted:
        return None
    if float(confidence) < float(min_confidence):
        return None
    return {
        "selected": selected.lower(),
        "detected": predicted.lower(),
        "confidence": round(float(confidence), 6),
    }


def sanitize_model_slug(model_id: str) -> str:
    """Filename-safe slug for a model id ("google/siglip2-so400m-patch16-384"
    -> "siglip2-so400m-patch16-384"). Mirrors the identical helper in
    tools/build_raw_visual_index.py so the builder's output filenames and the
    matcher's expected filenames cannot drift apart.
    """
    slug = str(model_id or "").split("/")[-1].strip().lower()
    return "".join(character if character.isalnum() or character in {"-", "_"} else "-" for character in slug)


def game_index_artifact_names(game: str, model_id: str) -> tuple[str, str]:
    """Per-game visual index artifact filenames: (npz name, manifest name).

    NAMING CONVENTION
    -----------------
    Non-Pokémon games get the game id inserted into the artifact name:

        visual_index_active_<game>_<model-slug>.npz
        visual_index_active_<game>_manifest.json

    e.g. visual_index_active_onepiece_siglip2-so400m-patch16-384.npz.

    Pokémon is deliberately NOT covered by this helper. Its live artifacts
    predate multi-game and are already deployed on every VM under the historical
    names (`visual_index_active_clip-vit-base-patch32.npz` +
    `visual_index_active_manifest.json` — the "clip" slug is frozen history, the
    file holds whatever the active backbone produced). Pokémon keeps resolving
    through the untouched active/fallback + env-override block in `__init__`, so
    its index file — and therefore its accuracy — cannot move.

    `tools/build_raw_visual_index.py --game <game>` writes the versioned form of
    these names (`visual_index_<version>_<game>_<model-slug>.npz`); promoting a
    build to live means copying it to the `active` name above, exactly as the
    Pokémon index is promoted today.
    """
    normalized_game = normalize_game(game)
    if normalized_game == GAME_POKEMON:
        raise ValueError("Pokémon resolves its index through the legacy active/fallback paths, not this convention.")
    model_slug = sanitize_model_slug(model_id)
    return (
        f"visual_index_active_{normalized_game}_{model_slug}.npz",
        f"visual_index_active_{normalized_game}_manifest.json",
    )


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
        self.visual_index_root = default_root
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
        # Per-game indexes (One Piece, …). The Pokémon index above is eager and
        # unchanged; every other game is resolved LAZILY on first scan for that
        # game and cached here — including the "not built yet" answer (None), so
        # a game whose index is missing simply has no scanner lane instead of
        # taking the whole backend down at boot. See game_index_artifact_names()
        # for the filename convention.
        self._game_indexes: dict[str, RawVisualIndex | None] = {}
        self._game_index_lock = threading.Lock()
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

        # Collector-number tiebreak (Phase 2): SECONDARY verification only. When
        # the top visual candidates are a near-tie among same-artwork /
        # different-number lookalikes (e.g. Frogadier 087 vs 089), nudge the
        # candidate whose printed collector number matches the OCR'd footer
        # number. This is NEVER a primary identifier and NEVER a hard filter
        # (no candidate is ever dropped or introduced from outside the shortlist).
        # Default OFF: it is a no-op until the client forwards the footer number,
        # and must be latency-measured on a real device before enabling.
        self.collector_tiebreak_enabled = _env_flag_enabled("SPOTLIGHT_VISUAL_COLLECTOR_TIEBREAK", default=False)
        self.collector_tiebreak_margin = _env_float("SPOTLIGHT_VISUAL_COLLECTOR_TIEBREAK_MARGIN", 0.03)
        self.collector_tiebreak_beta = _env_float("SPOTLIGHT_VISUAL_COLLECTOR_TIEBREAK_BETA", 0.04)

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
        # Default next to the RESOLVED adapter checkpoint rather than
        # repo_root/backend/data, so the probe loads with no env override even on
        # the flat VM layout (where repo_root + "backend/data" mis-resolves to
        # ~/backend/data). The adapter path is already resolved correctly above.
        default_language_probe_path = self.adapter_checkpoint_path.parent / "language_probe_v1.npz"
        self.language_probe_path = resolve_repo_relative_path(
            repo_root, language_probe_env, default_language_probe_path,
        )
        self._language_probe: dict[str, Any] | None = None
        self._load_language_probe()
        # Confidence floor for flagging a target-language mismatch (wrong toggle).
        self.language_mismatch_min_confidence = _env_float(
            "SPOTLIGHT_VISUAL_LANGUAGE_MISMATCH_MIN_CONFIDENCE",
            _LANGUAGE_MISMATCH_DEFAULT_MIN_CONFIDENCE,
        )

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

    def _resolve_game_index(self, game: str) -> RawVisualIndex | None:
        """Build (but do not load) the RawVisualIndex for a non-Pokémon game.

        Returns None — never raises — when the artifacts are missing, so an
        unbuilt game degrades to "that lane is unavailable".
        """
        try:
            npz_name, manifest_name = game_index_artifact_names(game, self.model_id)
        except ValueError:
            return None
        root = getattr(self, "visual_index_root", None) or (self.repo_root / "backend" / "data" / "visual-index")
        # Per-game env overrides mirror the Pokémon ones with a game suffix:
        # SPOTLIGHT_VISUAL_INDEX_NPZ_PATH_ONEPIECE / ..._MANIFEST_PATH_ONEPIECE.
        env_suffix = game.upper()
        npz_path = resolve_repo_relative_path(
            self.repo_root,
            os.environ.get(f"SPOTLIGHT_VISUAL_INDEX_NPZ_PATH_{env_suffix}"),
            root / npz_name,
        )
        manifest_path = resolve_repo_relative_path(
            self.repo_root,
            os.environ.get(f"SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH_{env_suffix}"),
            root / manifest_name,
        )
        index = RawVisualIndex(npz_path=npz_path, manifest_path=manifest_path)
        if not index.is_available():
            _emit_matcher_log(
                "WARNING",
                "visual_index_game_unavailable",
                game=game,
                npzPath=str(npz_path),
                manifestPath=str(manifest_path),
                reason="missing_artifacts",
            )
            return None
        _emit_matcher_log(
            "INFO",
            "visual_index_game_resolved",
            game=game,
            npzPath=str(npz_path),
            manifestPath=str(manifest_path),
        )
        return index

    def index_for_game(self, game: Any = None) -> RawVisualIndex | None:
        """The visual index for a scan's game, or None when that game has none.

        Pokémon ALWAYS returns `self.index` — the exact instance built by
        __init__ from the legacy active/fallback paths and env overrides — so
        the Pokémon lane behaves bit-for-bit as it did before per-game indexes
        existed (and tests/tools that swap `matcher.index` keep working).
        """
        normalized_game = normalize_game(game)
        if normalized_game == GAME_POKEMON:
            return getattr(self, "index", None)

        cache = getattr(self, "_game_indexes", None)
        if cache is None:
            cache = {}
            self._game_indexes = cache
        if normalized_game in cache:
            return cache[normalized_game]

        lock = getattr(self, "_game_index_lock", None)
        if lock is None:
            lock = threading.Lock()
            self._game_index_lock = lock
        with lock:
            if normalized_game in cache:
                return cache[normalized_game]
            try:
                resolved = self._resolve_game_index(normalized_game)
            except Exception as exc:  # pragma: no cover - defensive: a bad path must not break scans
                _emit_matcher_log(
                    "WARNING", "visual_index_game_resolve_failed", game=normalized_game, error=str(exc)
                )
                resolved = None
            cache[normalized_game] = resolved
            return resolved

    @staticmethod
    def game_for_payload(payload: dict[str, Any] | None) -> str:
        """Which game a scan payload is for. Absent/unknown -> Pokémon, which is
        every pre-multi-game client.

        Delegates so the OCR fallback in server.py — which cannot import this
        module without pulling in numpy/torch — reads the payload through the
        SAME code. Two readers would be free to drift apart, and the scanner
        would then search one catalog visually and another textually.
        """
        return game_for_scan_payload(payload)

    def is_available(self, game: Any = None) -> bool:
        index = self.index_for_game(game)
        return index is not None and index.is_available()

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
            # The runtime scanner defaults to the ONNX encoder (faster on the
            # CPU VM, numerically identical to torch). No env var needed; set
            # SPOTLIGHT_VISUAL_ENCODER_BACKEND=torch to force torch. The encoder
            # falls back to torch on its own if the ONNX artifact is missing.
            encoder_backend = os.environ.get("SPOTLIGHT_VISUAL_ENCODER_BACKEND") or "onnx"
            encoder = RawVisualFrozenEncoder(
                model_id=self.model_id, device="auto", backend=encoder_backend
            )
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

    def reload_index(self) -> dict[str, Any]:
        """Atomically swap in the on-disk index (no restart, no downtime).

        Used after an incremental refresh writes new rows to the active npz +
        manifest. The encoder/adapter are unchanged, so only the index reloads.
        A failed reload keeps the previously-loaded index serving.
        """
        count = self.index.reload()
        _emit_matcher_log(
            "INFO", "visual_index_reloaded", entryCount=count, npzPath=str(self.index.npz_path)
        )
        return {"reloaded": True, "entryCount": count, "npzPath": str(self.index.npz_path)}

    def embed_reference_images(self, images: list[Any]) -> np.ndarray:
        """Embed catalog reference images with the SAME encoder + adapter the
        query path uses, so incrementally-appended index rows live in the exact
        same embedding space as the existing rows.
        """
        if not images:
            return np.zeros((0, 0), dtype=np.float32)
        self._ensure_runtime()
        assert self._encoder is not None
        embeddings = self._encoder.embed_images(images, batch_size=32)
        if self._adapter is not None:
            embeddings = project_embeddings_numpy(
                self._adapter, embeddings, device=self._encoder.device, batch_size=64,
            )
        return np.asarray(embeddings, dtype=np.float32)

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

    def _language_probe_prediction(
        self, query_embedding: np.ndarray
    ) -> tuple[str | None, float]:
        """Raw top language-probe prediction + confidence, WITHOUT the soft-hint
        confidence gate. Returns (None, 0.0) when the probe is unavailable.

        This is the shared core used by both the soft preferred_language hint
        (`_predict_language`) and the target-mismatch check, which apply their
        own thresholds.
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
        return predicted, confidence

    def _predict_language(
        self, query_embedding: np.ndarray
    ) -> tuple[str | None, float]:
        """Run the logistic-regression language probe over the embedding.

        Returns (predicted_language, confidence). If the probe artifact is
        unavailable or the prediction confidence is below the threshold,
        returns (None, confidence).
        """
        predicted, confidence = self._language_probe_prediction(query_embedding)
        if predicted is None:
            return None, confidence
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

    def _apply_collector_number_tiebreak(
        self,
        matches: list[RawVisualSearchMatch],
        payload: dict[str, Any],
        *,
        top_k: int,
    ) -> tuple[list[RawVisualSearchMatch], dict[str, Any]]:
        """SECONDARY collector-number tiebreak for same-art / different-number lookalikes.

        Only fires when the visual top-1 vs top-2 similarity gap is within
        ``collector_tiebreak_margin`` AND the shortlist window contains a
        same-name group with >=2 distinct printed numbers (the ambiguous
        same-artwork case). In that case it applies a small additive ``beta``
        boost to candidates whose printed collector number matches the OCR'd
        footer number, then re-sorts. It never drops a candidate and never
        introduces one from outside ``matches``. OCR is never a primary
        identifier and never a hard filter.

        Uses getattr defaults throughout so tests built via
        ``object.__new__(RawVisualMatcher)`` work without __init__.
        """
        if not getattr(self, "collector_tiebreak_enabled", False):
            return matches, {"applied": False, "reason": "feature_disabled"}
        if len(matches) < 2:
            return matches, {"applied": False, "reason": "insufficient_candidates"}

        ocr = (payload.get("ocrAnalysis") or {}).get("rawEvidence") or {}
        if not isinstance(ocr, dict):
            ocr = {}
        raw = str(
            ocr.get("collectorNumberExact")
            or ocr.get("collectorNumberPartial")
            or payload.get("collectorNumber")
            or ""
        ).strip()
        if not raw:
            return matches, {"applied": False, "reason": "no_ocr_number"}
        ocr_num = _collector_components(raw)[0]
        if not ocr_num:
            return matches, {"applied": False, "reason": "unparseable_ocr_number"}

        margin = float(getattr(self, "collector_tiebreak_margin", 0.03))
        beta = float(getattr(self, "collector_tiebreak_beta", 0.04))

        # Ambiguity gate: look at the leading window. The gap between the top
        # two candidates must be small (near-tie) AND the window must contain a
        # same-name group with >=2 distinct printed numbers.
        window = matches[:5]
        top_gap = float(matches[0].similarity) - float(matches[1].similarity)
        numbers_by_name: dict[str, set[str]] = {}
        for match in window:
            entry = match.entry
            name_key = str(entry.get("name") or "").strip().lower()
            if not name_key:
                continue
            cand_num = _collector_components(str(entry.get("collectorNumber") or ""))[0]
            if cand_num:
                numbers_by_name.setdefault(name_key, set()).add(cand_num)
        ambiguous = any(len(nums) >= 2 for nums in numbers_by_name.values())
        ambiguous_groups = sum(1 for nums in numbers_by_name.values() if len(nums) >= 2)

        if not (top_gap < margin and ambiguous):
            return matches, {
                "applied": False,
                "reason": "not_ambiguous",
                "ocrNumber": ocr_num,
                "margin": round(margin, 6),
                "topGap": round(top_gap, 6),
                "ambiguous": ambiguous,
                "ambiguousNameGroups": ambiguous_groups,
                "windowConsidered": len(window),
                "shortlistConsidered": len(matches),
            }

        # Soft additive boost: only candidates whose printed number matches the
        # OCR'd number are nudged. No candidate is dropped or introduced.
        boosted_matches: list[RawVisualSearchMatch] = []
        candidates_matched = 0
        for match in matches:
            entry = dict(match.entry)
            cand_num = _collector_components(str(entry.get("collectorNumber") or ""))[0]
            adjusted = float(match.similarity)
            if cand_num and cand_num == ocr_num:
                adjusted = float(match.similarity) + beta
                entry["_collectorTiebreakMatched"] = True
                candidates_matched += 1
            boosted_matches.append(
                RawVisualSearchMatch(
                    row_index=match.row_index,
                    similarity=adjusted,
                    entry=entry,
                )
            )

        boosted_matches.sort(key=lambda item: item.similarity, reverse=True)
        return boosted_matches[:top_k], {
            "applied": True,
            "ocrNumber": ocr_num,
            "beta": round(beta, 6),
            "margin": round(margin, 6),
            "topGap": round(top_gap, 6),
            "ambiguousNameGroups": ambiguous_groups,
            "candidatesMatched": candidates_matched,
            "shortlistConsidered": len(matches),
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
        game = self.game_for_payload(payload)
        index = self.index_for_game(game)
        if index is None or not index.is_available():
            raise RuntimeError(f"Visual index artifacts are not available for game '{game}'.")
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
                raw_matches = index.search(embedding, top_k=internal_top_k)
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
            # Pokémon-only: the mini-index holds Pokémon basic energies, so
            # routing a non-Pokémon scan through it could only ever substitute a
            # card from the wrong game.
            mini_routed_debug = (
                self._maybe_route_basic_energy_mini_index(
                    matches=matches,
                    base_variant_embedding=base_variant_embedding,
                    payload=payload,
                    preferred_language=preferred_language,
                )
                if game == GAME_POKEMON
                else None
            )
            if mini_routed_debug is not None and mini_routed_debug.get("used"):
                replacement_match = mini_routed_debug.pop("_replacementMatch", None)
                if replacement_match is not None and matches:
                    matches = [replacement_match] + matches[1:]

            # Collector-number tiebreak (Phase 2): SECONDARY verification only.
            # Runs after the mini-index routing so it operates on the final
            # candidate ordering. No-op unless the flag is enabled AND the
            # client forwards an OCR'd footer collector number.
            collector_tiebreak_started_at = perf_counter()
            matches, collector_tiebreak_debug = self._apply_collector_number_tiebreak(
                matches,
                payload,
                top_k=top_k,
            )
            collector_tiebreak_ms = (perf_counter() - collector_tiebreak_started_at) * 1000.0

            # Target-language mismatch: compare the user's explicit toggle against a
            # confident visual language prediction so the client can warn "wrong
            # toggle" and drop the scan. Runs regardless of the explicit hint (the
            # soft-hint probe above is skipped when an explicit hint is present), and
            # is O(1) on top of the embedding that already exists.
            target_language_mismatch = None
            if base_variant_embedding is not None and getattr(self, "_language_probe", None) is not None:
                probe_predicted_language, probe_prediction_confidence = self._language_probe_prediction(
                    base_variant_embedding
                )
                language_probe_debug["rawPredictedLanguage"] = probe_predicted_language
                language_probe_debug["rawPredictionConfidence"] = round(float(probe_prediction_confidence), 6)
                target_language_mismatch = detect_language_mismatch(
                    payload.get("cardLanguage"),
                    probe_predicted_language,
                    probe_prediction_confidence,
                    min_confidence=getattr(
                        self,
                        "language_mismatch_min_confidence",
                        _LANGUAGE_MISMATCH_DEFAULT_MIN_CONFIDENCE,
                    ),
                )

            debug = {
                "modelId": self.model_id,
                "game": game,
                "indexNpzPath": str(index.npz_path),
                "indexManifestPath": str(index.manifest_path),
                "adapterCheckpointPath": str(self.adapter_checkpoint_path) if self.adapter_checkpoint_path and self.adapter_checkpoint_path.exists() else None,
                "adapterMetadataPath": str(self.adapter_metadata_path) if self.adapter_metadata_path and self.adapter_metadata_path.exists() else None,
                "topK": top_k,
                "internalTopK": internal_top_k,
                "preferredLanguage": preferred_language,
                "preferredLanguageConfidence": preferred_language_confidence,
                "languageFragments": language_fragments[:8],
                "languageBiasApplied": language_bias_applied,
                "languageProbe": language_probe_debug,
                "targetLanguageMismatch": target_language_mismatch,
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
                "collectorNumberTiebreak": collector_tiebreak_debug,
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
                    "collectorTiebreakMs": round(collector_tiebreak_ms, 3),
                    "matchPayloadMs": round((perf_counter() - match_started_at) * 1000.0, 3),
                },
            }
            return matches, debug
        finally:
            self._finish_inference_telemetry()
