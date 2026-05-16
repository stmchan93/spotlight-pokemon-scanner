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


def _normalize_row(values: list[float]) -> np.ndarray:
    arr = np.asarray(values, dtype=np.float32)
    norm = float(np.linalg.norm(arr))
    if norm > 0:
        arr = arr / norm
    return arr


def _build_mini_index_archive(tmpdir: Path) -> Path:
    """Build a 4-row mini-index npz fixture with EN/JP Metal and Lightning."""
    embeddings = np.stack(
        [
            _normalize_row([1.0, 0.0, 0.0, 0.0]),  # Basic Metal Energy (English)
            _normalize_row([0.95, 0.05, 0.0, 0.0]),  # Basic Metal Energy (Japanese) — very close
            _normalize_row([0.0, 0.0, 1.0, 0.0]),  # Basic Lightning Energy (English)
            _normalize_row([0.0, 0.0, 0.95, 0.05]),  # Basic Lightning Energy (Japanese)
        ]
    ).astype(np.float32)
    card_ids = np.asarray(["sve-metal-en", "sve-metal-jp", "sve-lightning-en", "sve-lightning-jp"], dtype=object)
    names = np.asarray(
        ["Basic Metal Energy", "Basic Metal Energy", "Basic Lightning Energy", "Basic Lightning Energy"],
        dtype=object,
    )
    languages = np.asarray(["English", "Japanese", "English", "Japanese"], dtype=object)
    set_names = np.asarray(["SVE", "SVE-JP", "SVE", "SVE-JP"], dtype=object)
    path = tmpdir / "basic_energy_mini_index.npz"
    np.savez_compressed(
        path,
        embeddings=embeddings,
        card_ids=card_ids,
        names=names,
        languages=languages,
        set_names=set_names,
    )
    return path


def _build_matcher_with_mini_index(mini_index_path: Path | None) -> RawVisualMatcher:
    matcher = object.__new__(RawVisualMatcher)
    matcher.model_id = "clip-test"
    matcher.basic_energy_mini_index_path = mini_index_path
    matcher._basic_energy_mini_index = None
    matcher._language_probe = None
    matcher.language_probe_path = Path("/tmp/missing-language-probe.npz")
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
    if mini_index_path is not None:
        matcher._load_basic_energy_mini_index()
    return matcher


@unittest.skipIf(_IMPORT_ERROR is not None, f"mini-index test deps unavailable: {_IMPORT_ERROR}")
class BasicEnergyMiniIndexTests(unittest.TestCase):
    def _make_fake_index_with_low_top1(self) -> object:
        class _FakeIndex:
            def __init__(self) -> None:
                self.npz_path = Path("/tmp/fake-index.npz")
                self.manifest_path = Path("/tmp/fake-index-manifest.json")
                self.search_calls: list[tuple[np.ndarray, int]] = []

            def is_available(self) -> bool:
                return True

            def search(self, embedding: np.ndarray, top_k: int = 10):
                self.search_calls.append((embedding.copy(), top_k))
                # Main top-1 similarity is intentionally lower than the mini-index
                # match so routing should fire.
                return [
                    RawVisualSearchMatch(
                        row_index=42,
                        similarity=0.30,
                        entry={"providerCardId": "weak-1", "language": "English", "name": "Weak Match"},
                    )
                ]
        return _FakeIndex()

    def _make_fake_index_with_high_top1(self) -> object:
        class _FakeIndex:
            def __init__(self) -> None:
                self.npz_path = Path("/tmp/fake-index.npz")
                self.manifest_path = Path("/tmp/fake-index-manifest.json")
                self.search_calls: list[tuple[np.ndarray, int]] = []

            def is_available(self) -> bool:
                return True

            def search(self, embedding: np.ndarray, top_k: int = 10):
                self.search_calls.append((embedding.copy(), top_k))
                # Main top-1 similarity is higher than the mini-index top-1 (0.95).
                return [
                    RawVisualSearchMatch(
                        row_index=42,
                        similarity=0.999,
                        entry={"providerCardId": "strong-1", "language": "English", "name": "Strong Match"},
                    )
                ]
        return _FakeIndex()

    def _build_dummy_payload(self) -> dict[str, object]:
        image = Image.new("RGB", (20, 20), color=(120, 0, 0))
        buffer = BytesIO()
        image.save(buffer, format="JPEG")
        return {
            "normalizedImageBase64": b64encode(buffer.getvalue()).decode("ascii"),
            "clientContext": {"localeIdentifier": "en-US"},
        }

    def test_query_mini_energy_index_returns_top_similarity_and_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            mini_path = _build_mini_index_archive(Path(tmpdir))
            matcher = _build_matcher_with_mini_index(mini_path)
            query = _normalize_row([1.0, 0.0, 0.0, 0.0])
            result = matcher._query_mini_energy_index(query)
            self.assertIsNotNone(result)
            assert result is not None
            similarity, row_index = result
            self.assertAlmostEqual(similarity, 1.0, places=4)
            self.assertEqual(row_index, 0)

    def test_match_payload_routes_to_mini_index_when_main_is_weaker_and_picks_english(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            mini_path = _build_mini_index_archive(Path(tmpdir))
            matcher = _build_matcher_with_mini_index(mini_path)
            matcher.index = self._make_fake_index_with_low_top1()
            # Force the base embedding to highly match Metal (row 0 EN, row 1 JP).
            metal_embedding = _normalize_row([1.0, 0.0, 0.0, 0.0])
            matcher._image_embedding_with_timing = lambda image: (  # type: ignore[method-assign]
                metal_embedding,
                {
                    "encoderPreprocessMs": 1.0,
                    "encoderForwardMs": 2.0,
                    "encoderPostprocessMs": 3.0,
                    "adapterProjectMs": 0.0,
                    "embeddingNormalizeMs": 0.5,
                    "embeddingMs": 6.5,
                },
            )
            payload = self._build_dummy_payload()
            matches, debug = matcher.match_payload(payload, top_k=3)

        self.assertTrue(debug["miniIndexEnergyRouted"]["enabled"])
        self.assertTrue(debug["miniIndexEnergyRouted"]["used"])
        self.assertEqual(debug["miniIndexEnergyRouted"]["selectedLanguage"], "English")
        self.assertEqual(debug["miniIndexEnergyRouted"]["selectedCardId"], "sve-metal-en")
        self.assertGreaterEqual(matches[0].entry["_visualBaseSimilarity"], 0.55)
        self.assertEqual(matches[0].entry["providerCardId"], "sve-metal-en")
        self.assertTrue(matches[0].entry.get("_miniIndexEnergyRouted"))

    def test_match_payload_does_not_route_when_main_top1_beats_mini(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            mini_path = _build_mini_index_archive(Path(tmpdir))
            matcher = _build_matcher_with_mini_index(mini_path)
            matcher.index = self._make_fake_index_with_high_top1()
            # Misalign the query so mini-index top-1 is ~0.81 (well below the
            # main-index top-1 of 0.999). main wins => no routing.
            metal_embedding = _normalize_row([0.7, 0.5, 0.3, 0.0])
            matcher._image_embedding_with_timing = lambda image: (  # type: ignore[method-assign]
                metal_embedding,
                {
                    "encoderPreprocessMs": 1.0,
                    "encoderForwardMs": 2.0,
                    "encoderPostprocessMs": 3.0,
                    "adapterProjectMs": 0.0,
                    "embeddingNormalizeMs": 0.5,
                    "embeddingMs": 6.5,
                },
            )
            payload = self._build_dummy_payload()
            matches, debug = matcher.match_payload(payload, top_k=3)

        self.assertTrue(debug["miniIndexEnergyRouted"]["enabled"])
        self.assertFalse(debug["miniIndexEnergyRouted"]["used"])
        # Mini-index top similarity surfaced even when not routed.
        self.assertIsNotNone(debug["miniIndexEnergyRouted"]["miniTop1Similarity"])
        self.assertLess(
            float(debug["miniIndexEnergyRouted"]["miniTop1Similarity"]),
            float(debug["miniIndexEnergyRouted"]["mainTop1Similarity"]),
        )
        # Main top-1 is preserved.
        self.assertEqual(matches[0].entry["providerCardId"], "strong-1")

    def test_match_payload_skips_mini_index_when_artifact_missing(self) -> None:
        matcher = _build_matcher_with_mini_index(Path("/tmp/does-not-exist.npz"))
        matcher.index = self._make_fake_index_with_high_top1()
        metal_embedding = _normalize_row([1.0, 0.0, 0.0, 0.0])
        matcher._image_embedding_with_timing = lambda image: (  # type: ignore[method-assign]
            metal_embedding,
            {
                "encoderPreprocessMs": 1.0,
                "encoderForwardMs": 2.0,
                "encoderPostprocessMs": 3.0,
                "adapterProjectMs": 0.0,
                "embeddingNormalizeMs": 0.5,
                "embeddingMs": 6.5,
            },
        )
        payload = self._build_dummy_payload()
        matches, debug = matcher.match_payload(payload, top_k=3)

        # No mini-index loaded -> the helper returns None, surfaced as None.
        self.assertIsNone(debug["miniIndexEnergyRouted"])
        # Main top-1 untouched.
        self.assertEqual(matches[0].entry["providerCardId"], "strong-1")


if __name__ == "__main__":
    unittest.main()
