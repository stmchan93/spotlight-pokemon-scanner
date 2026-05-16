from __future__ import annotations

import sys
import tempfile
import unittest
from base64 import b64encode
from io import BytesIO
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

try:
    import numpy as np  # noqa: E402
    from PIL import Image  # noqa: E402
    import torch  # noqa: E402
    from raw_visual_index import RawVisualSearchMatch  # noqa: E402
    import raw_visual_matcher as raw_visual_matcher_module  # noqa: E402
    from raw_visual_matcher import RawVisualMatcher  # noqa: E402
    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host-python dependency fallback
    RawVisualSearchMatch = None  # type: ignore[assignment]
    RawVisualMatcher = None  # type: ignore[assignment]
    raw_visual_matcher_module = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


def _build_language_probe_archive(tmpdir: Path, *, embedding_dim: int = 4) -> Path:
    """Probe with simple coefficients that "flip" with embedding sign.

    classes = ["English", "Japanese"]
    coef row 0 (English): all-positive vector -> positive logits for positive
        embeddings -> EN is favored when embeddings have positive sign.
    coef row 1 (Japanese): all-negative vector with positive intercept tuned
        so a strongly-negative embedding flips the prediction to JP.
    """
    coef = np.zeros((2, embedding_dim), dtype=np.float32)
    coef[0] = np.full((embedding_dim,), 4.0, dtype=np.float32)  # English
    coef[1] = np.full((embedding_dim,), -4.0, dtype=np.float32)  # Japanese
    intercept = np.zeros((2,), dtype=np.float32)
    classes = np.asarray(["English", "Japanese"], dtype=object)
    path = tmpdir / "language_probe_v1.npz"
    np.savez_compressed(path, coef=coef, intercept=intercept, classes=classes)
    return path


def _build_matcher_with_probe(probe_path: Path | None, *, embedding_dim: int = 4) -> RawVisualMatcher:
    matcher = object.__new__(RawVisualMatcher)
    matcher.model_id = "clip-test"
    matcher.basic_energy_mini_index_path = Path("/tmp/missing-mini-index.npz")
    matcher._basic_energy_mini_index = None
    matcher.language_probe_path = probe_path or Path("/tmp/missing-language-probe.npz")
    matcher._language_probe = None
    matcher.adapter_checkpoint_path = Path("/tmp/missing-adapter.pt")
    matcher.adapter_metadata_path = Path("/tmp/missing-adapter.json")
    matcher._encoder = SimpleNamespace(device=torch.device("cpu"))
    matcher._adapter = None
    matcher._runtime_lock = Lock()
    matcher._telemetry_lock = Lock()
    matcher._runtime_ready = True
    matcher._inference_count = 0
    matcher._last_inference_finished_at = None
    matcher._ensure_runtime = lambda: None  # type: ignore[method-assign]
    matcher.user_photo_rerank_enabled = False
    matcher._user_photo_rerank_pool = None
    matcher.user_photo_rerank_shortlist_k = 10
    if probe_path is not None:
        matcher._load_language_probe()
    return matcher


def _make_fake_index() -> object:
    class _FakeIndex:
        def __init__(self) -> None:
            self.npz_path = Path("/tmp/fake-index.npz")
            self.manifest_path = Path("/tmp/fake-index-manifest.json")
            self.search_calls: list[tuple[np.ndarray, int]] = []

        def is_available(self) -> bool:
            return True

        def search(self, embedding: np.ndarray, top_k: int = 10):
            self.search_calls.append((embedding.copy(), top_k))
            return [
                RawVisualSearchMatch(
                    row_index=1,
                    similarity=0.70,
                    entry={"providerCardId": "base1-4", "language": "English", "name": "Charizard"},
                ),
                RawVisualSearchMatch(
                    row_index=2,
                    similarity=0.55,
                    entry={"providerCardId": "base1-4-jp", "language": "Japanese", "name": "リザードン"},
                ),
            ]
    return _FakeIndex()


def _build_dummy_payload(*, locale: str | None = None) -> dict[str, object]:
    image = Image.new("RGB", (20, 20), color=(120, 0, 0))
    buffer = BytesIO()
    image.save(buffer, format="JPEG")
    payload: dict[str, object] = {
        "normalizedImageBase64": b64encode(buffer.getvalue()).decode("ascii"),
    }
    if locale is not None:
        payload["clientContext"] = {"localeIdentifier": locale}
    return payload


@unittest.skipIf(_IMPORT_ERROR is not None, f"language probe test deps unavailable: {_IMPORT_ERROR}")
class LanguageProbeTests(unittest.TestCase):
    def test_predict_language_high_confidence_english_applies_and_trips_language_bias(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            probe_path = _build_language_probe_archive(Path(tmpdir))
            matcher = _build_matcher_with_probe(probe_path)
            matcher.index = _make_fake_index()
            # Strongly positive embedding -> probe favors EN with very high
            # confidence (softmax saturates well above 0.8).
            embedding = np.asarray([1.0, 1.0, 0.0, 0.0], dtype=np.float32)
            embedding = embedding / float(np.linalg.norm(embedding))
            matcher._image_embedding_with_timing = lambda image: (  # type: ignore[method-assign]
                embedding,
                {
                    "encoderPreprocessMs": 1.0,
                    "encoderForwardMs": 2.0,
                    "encoderPostprocessMs": 3.0,
                    "adapterProjectMs": 0.0,
                    "embeddingNormalizeMs": 0.5,
                    "embeddingMs": 6.5,
                },
            )
            payload = _build_dummy_payload()
            matches, debug = matcher.match_payload(payload, top_k=2)

        self.assertTrue(debug["languageProbe"]["enabled"])
        self.assertTrue(debug["languageProbe"]["applied"])
        self.assertEqual(debug["languageProbe"]["predictedLanguage"], "English")
        self.assertGreaterEqual(debug["languageProbe"]["predictedLanguageConfidence"], 0.8)
        self.assertEqual(debug["preferredLanguage"], "English")
        self.assertTrue(debug["languageBiasApplied"])

    def test_predict_language_low_confidence_does_not_apply(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            probe_path = _build_language_probe_archive(Path(tmpdir))
            matcher = _build_matcher_with_probe(probe_path)
            matcher.index = _make_fake_index()
            # Near-zero embedding -> logits very close to zero -> softmax
            # produces probabilities near 0.5 each -> confidence < 0.8 -> the
            # probe is not applied.
            embedding = np.asarray([1e-8, -1e-8, 0.0, 0.0], dtype=np.float32)
            matcher._image_embedding_with_timing = lambda image: (  # type: ignore[method-assign]
                embedding,
                {
                    "encoderPreprocessMs": 1.0,
                    "encoderForwardMs": 2.0,
                    "encoderPostprocessMs": 3.0,
                    "adapterProjectMs": 0.0,
                    "embeddingNormalizeMs": 0.5,
                    "embeddingMs": 6.5,
                },
            )
            payload = _build_dummy_payload()
            matches, debug = matcher.match_payload(payload, top_k=2)

        self.assertTrue(debug["languageProbe"]["enabled"])
        self.assertFalse(debug["languageProbe"]["applied"])
        self.assertLess(debug["languageProbe"]["predictedLanguageConfidence"], 0.8)
        # No OCR signal and no high-confidence probe -> preferred language stays None.
        self.assertIsNone(debug["preferredLanguage"])
        self.assertFalse(debug["languageBiasApplied"])

    def test_match_payload_handles_missing_probe_file_without_errors(self) -> None:
        matcher = _build_matcher_with_probe(Path("/tmp/does-not-exist-language-probe.npz"))
        matcher.index = _make_fake_index()
        embedding = np.asarray([1.0, 1.0, 0.0, 0.0], dtype=np.float32)
        embedding = embedding / float(np.linalg.norm(embedding))
        matcher._image_embedding_with_timing = lambda image: (  # type: ignore[method-assign]
            embedding,
            {
                "encoderPreprocessMs": 1.0,
                "encoderForwardMs": 2.0,
                "encoderPostprocessMs": 3.0,
                "adapterProjectMs": 0.0,
                "embeddingNormalizeMs": 0.5,
                "embeddingMs": 6.5,
            },
        )
        payload = _build_dummy_payload()
        matches, debug = matcher.match_payload(payload, top_k=2)

        self.assertFalse(debug["languageProbe"]["enabled"])
        self.assertFalse(debug["languageProbe"]["applied"])
        self.assertIsNone(debug["preferredLanguage"])
        self.assertFalse(debug["languageBiasApplied"])
        # Match flow returned cleanly.
        self.assertGreater(len(matches), 0)


if __name__ == "__main__":
    unittest.main()
