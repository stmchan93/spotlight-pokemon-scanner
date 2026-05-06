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
    from raw_visual_matcher import RawVisualMatcher, resolve_repo_relative_path  # noqa: E402
    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host-python dependency fallback
    RawVisualSearchMatch = None  # type: ignore[assignment]
    RawVisualMatcher = None  # type: ignore[assignment]
    raw_visual_matcher_module = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


class _FakeImage:
    def __init__(self, width: int = 630, height: int = 880) -> None:
        self.size = (width, height)
        self.crop_args = None
        self.resize_args = None
        self.copy_called = False

    def copy(self):
        copied = _FakeImage(*self.size)
        copied.copy_called = True
        return copied

    def crop(self, box):
        cropped = _FakeImage(box[2] - box[0], box[3] - box[1])
        cropped.crop_args = box
        return cropped

    def resize(self, size):
        resized = _FakeImage(*size)
        resized.resize_args = size
        resized.crop_args = self.crop_args
        return resized


@unittest.skipIf(_IMPORT_ERROR is not None, f"raw visual matcher test deps unavailable: {_IMPORT_ERROR}")
class RawVisualMatcherTests(unittest.TestCase):
    def test_resolve_repo_relative_path_prefers_absolute_and_falls_back_to_default(self) -> None:
        repo_root = Path("/tmp/repo")

        resolved_relative = resolve_repo_relative_path(repo_root, "backend/data/index.npz", repo_root / "default.npz")
        self.assertTrue(str(resolved_relative).endswith("/tmp/repo/backend/data/index.npz"))
        self.assertEqual(
            resolve_repo_relative_path(repo_root, "/var/tmp/index.npz", repo_root / "default.npz"),
            Path("/var/tmp/index.npz"),
        )
        self.assertEqual(
            resolve_repo_relative_path(repo_root, None, repo_root / "default.npz"),
            repo_root / "default.npz",
        )

    def test_language_helpers_normalize_values_and_count_characters(self) -> None:
        self.assertEqual(raw_visual_matcher_module._normalize_language(" english "), "English")
        self.assertEqual(raw_visual_matcher_module._normalize_language("JAPANESE"), "Japanese")
        self.assertIsNone(raw_visual_matcher_module._normalize_language("Spanish"))
        self.assertEqual(raw_visual_matcher_module._language_character_counts("リザA12"), (2, 1, 2))

    def test_init_uses_repo_relative_env_overrides_for_runtime_artifacts(self) -> None:
        class _FakeIndex:
            def __init__(self, *, npz_path: Path, manifest_path: Path) -> None:
                self.npz_path = npz_path
                self.manifest_path = manifest_path

            def is_available(self) -> bool:
                return True

        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            with (
                patch.dict(
                    raw_visual_matcher_module.os.environ,
                    {
                        "SPOTLIGHT_VISUAL_MODEL_ID": "clip-env-test",
                        "SPOTLIGHT_VISUAL_INDEX_NPZ_PATH": "custom/index.npz",
                        "SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH": "custom/index.json",
                        "SPOTLIGHT_VISUAL_ADAPTER_CHECKPOINT_PATH": "custom/adapter.pt",
                        "SPOTLIGHT_VISUAL_ADAPTER_METADATA_PATH": "custom/adapter.json",
                    },
                    clear=False,
                ),
                patch.object(raw_visual_matcher_module, "RawVisualIndex", _FakeIndex),
            ):
                matcher = RawVisualMatcher(repo_root=repo_root)

        self.assertEqual(matcher.model_id, "clip-env-test")
        self.assertEqual(matcher.index.npz_path, (repo_root / "custom/index.npz").resolve())
        self.assertEqual(matcher.index.manifest_path, (repo_root / "custom/index.json").resolve())
        self.assertEqual(matcher.adapter_checkpoint_path, (repo_root / "custom/adapter.pt").resolve())
        self.assertEqual(matcher.adapter_metadata_path, (repo_root / "custom/adapter.json").resolve())
        self.assertFalse(matcher._runtime_ready)
        self.assertEqual(matcher._inference_count, 0)
        self.assertIsNone(matcher._last_inference_finished_at)

    def test_prewarm_returns_unavailable_when_index_is_missing(self) -> None:
        class _UnavailableIndex:
            def is_available(self) -> bool:
                return False

        matcher = object.__new__(RawVisualMatcher)
        matcher.index = _UnavailableIndex()

        self.assertEqual(
            matcher.prewarm(),
            {
                "available": False,
                "prewarmed": False,
                "reason": "visual_index_unavailable",
            },
        )

    def test_prewarm_loads_index_runtime_and_optional_inference(self) -> None:
        class _FakeIndex:
            def __init__(self) -> None:
                self.entries = [{"providerCardId": "base1-4"}]
                self.load_called = False

            def is_available(self) -> bool:
                return True

            def load(self) -> None:
                self.load_called = True

        matcher = object.__new__(RawVisualMatcher)
        matcher.index = _FakeIndex()
        ensure_runtime_calls: list[str] = []
        matcher._ensure_runtime = lambda: ensure_runtime_calls.append("called")  # type: ignore[method-assign]
        matcher.match_payload = lambda payload, top_k, telemetry_context: (  # type: ignore[method-assign]
            [],
            {
                "telemetryContext": telemetry_context,
                "hasImagePayload": bool(payload.get("image")),
                "topK": top_k,
            },
        )

        result = matcher.prewarm(run_inference=True)

        self.assertTrue(matcher.index.load_called)
        self.assertEqual(ensure_runtime_calls, ["called"])
        self.assertTrue(result["available"])
        self.assertTrue(result["prewarmed"])
        self.assertTrue(result["inferencePrewarmed"])
        self.assertEqual(result["indexEntryCount"], 1)
        self.assertEqual(result["inferenceDebug"]["telemetryContext"], "prewarm")
        self.assertTrue(result["inferenceDebug"]["hasImagePayload"])
        self.assertEqual(result["inferenceDebug"]["topK"], 1)
        self.assertIn("inferenceMs", result["timings"])

    def test_build_prewarm_payload_contains_decodable_image(self) -> None:
        matcher = object.__new__(RawVisualMatcher)

        payload = RawVisualMatcher._build_prewarm_payload()
        decoded = matcher._load_query_image(payload)

        self.assertEqual(payload["clientContext"]["platform"], "server_prewarm")
        self.assertEqual(payload["scanID"], "visual-runtime-prewarm")
        self.assertEqual(decoded.source, "base64")
        self.assertEqual((decoded.decodedWidth, decoded.decodedHeight), (630, 880))

    def test_inference_telemetry_tracks_sequence_and_idle_window(self) -> None:
        matcher = object.__new__(RawVisualMatcher)
        matcher._telemetry_lock = Lock()
        matcher._inference_count = 0
        matcher._last_inference_finished_at = None

        self.assertEqual(matcher._begin_inference_telemetry(), (1, None))
        matcher._finish_inference_telemetry()
        self.assertIsNotNone(matcher._last_inference_finished_at)
        sequence, idle_before_ms = matcher._begin_inference_telemetry()

        self.assertEqual(sequence, 2)
        self.assertIsNotNone(idle_before_ms)
        self.assertGreaterEqual(idle_before_ms, 0.0)

    def test_ensure_runtime_loads_encoder_and_adapter_only_once(self) -> None:
        encoder_inits: list[tuple[str, str]] = []

        class _FakeEncoder:
            def __init__(self, *, model_id: str, device: str) -> None:
                encoder_inits.append((model_id, device))
                self.embedding_dim = 512
                self.device = "cpu"

        matcher = object.__new__(RawVisualMatcher)
        matcher.model_id = "clip-test"
        with tempfile.TemporaryDirectory() as tmpdir:
            checkpoint_path = Path(tmpdir) / "adapter.pt"
            checkpoint_path.write_bytes(b"adapter")
            matcher.adapter_checkpoint_path = checkpoint_path
            matcher.adapter_metadata_path = Path(tmpdir) / "adapter.json"
            matcher._runtime_lock = Lock()
            matcher._runtime_ready = False
            matcher._encoder = None
            matcher._adapter = None

            with (
                patch.object(raw_visual_matcher_module, "RawVisualFrozenEncoder", _FakeEncoder),
                patch.object(raw_visual_matcher_module, "load_projection_adapter", return_value="adapter-sentinel") as load_mock,
            ):
                matcher._ensure_runtime()
                matcher._ensure_runtime()

        self.assertEqual(encoder_inits, [("clip-test", "auto")])
        self.assertEqual(load_mock.call_count, 1)
        self.assertIsInstance(matcher._encoder, _FakeEncoder)
        self.assertEqual(matcher._adapter, "adapter-sentinel")
        self.assertTrue(matcher._runtime_ready)

    def test_ensure_runtime_skips_adapter_load_when_checkpoint_is_missing(self) -> None:
        class _FakeEncoder:
            def __init__(self, *, model_id: str, device: str) -> None:
                self.embedding_dim = 256
                self.device = "cpu"

        matcher = object.__new__(RawVisualMatcher)
        matcher.model_id = "clip-test"
        matcher.adapter_checkpoint_path = Path("/tmp/nonexistent-adapter.pt")
        matcher.adapter_metadata_path = Path("/tmp/nonexistent-adapter.json")
        matcher._runtime_lock = Lock()
        matcher._runtime_ready = False
        matcher._encoder = None
        matcher._adapter = None

        with (
            patch.object(raw_visual_matcher_module, "RawVisualFrozenEncoder", _FakeEncoder),
            patch.object(raw_visual_matcher_module, "load_projection_adapter") as load_mock,
        ):
            matcher._ensure_runtime()

        load_mock.assert_not_called()
        self.assertIsNone(matcher._adapter)
        self.assertTrue(matcher._runtime_ready)

    def test_uses_exact_reticle_fallback_detects_specific_reason(self) -> None:
        payload = {
            "ocrAnalysis": {
                "normalizedTarget": {
                    "targetQuality": {
                        "reasons": [
                            "fallback",
                            "normalization:exact_reticle_fallback",
                        ]
                    }
                }
            }
        }

        self.assertTrue(RawVisualMatcher._uses_exact_reticle_fallback(payload))

    def test_uses_exact_reticle_fallback_ignores_other_normalization_paths(self) -> None:
        payload = {
            "ocrAnalysis": {
                "normalizedTarget": {
                    "targetQuality": {
                        "reasons": [
                            "fallback",
                            "normalization:basic_perspective_canonicalization",
                        ]
                    }
                }
            }
        }

        self.assertFalse(RawVisualMatcher._uses_exact_reticle_fallback(payload))

    def test_query_variants_adds_single_center_inset_for_exact_reticle_fallback(self) -> None:
        matcher = object.__new__(RawVisualMatcher)
        image = _FakeImage()
        payload = {
            "ocrAnalysis": {
                "normalizedTarget": {
                    "targetQuality": {
                        "reasons": ["normalization:exact_reticle_fallback"]
                    }
                }
            }
        }

        variants = matcher._query_variants(payload, image)

        self.assertEqual([variant.name for variant in variants], ["base", "center_inset_4"])
        self.assertEqual([variant.inset_ratio for variant in variants], [0.0, 0.04])

    def test_merge_variant_matches_dedupes_by_provider_card_id_and_keeps_best_similarity(self) -> None:
        merged = RawVisualMatcher._merge_variant_matches(
            [
                [
                    RawVisualSearchMatch(
                        row_index=1,
                        similarity=0.70,
                        entry={"providerCardId": "gym1-60", "name": "Sabrina's Slowbro", "_visualQueryVariant": "base"},
                    ),
                    RawVisualSearchMatch(
                        row_index=2,
                        similarity=0.65,
                        entry={"providerCardId": "gym1-12", "name": "Rocket's Moltres", "_visualQueryVariant": "base"},
                    ),
                ],
                [
                    RawVisualSearchMatch(
                        row_index=3,
                        similarity=0.84,
                        entry={"providerCardId": "gym1-60", "name": "Sabrina's Slowbro", "_visualQueryVariant": "center_inset_4"},
                    )
                ],
            ],
            top_k=5,
        )

        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0].entry["providerCardId"], "gym1-60")
        self.assertEqual(merged[0].similarity, 0.84)
        self.assertEqual(merged[0].entry["_visualQueryVariant"], "center_inset_4")
        self.assertEqual(merged[0].entry["_visualQueryVariants"], ["base", "center_inset_4"])

    def test_load_query_image_supports_base64_and_path_sources(self) -> None:
        matcher = object.__new__(RawVisualMatcher)
        image = Image.new("RGB", (4, 6), color=(10, 20, 30))
        buffer = BytesIO()
        image.save(buffer, format="JPEG")
        encoded = b64encode(buffer.getvalue()).decode("ascii")

        decoded_base64 = matcher._load_query_image({"normalizedImageBase64": encoded})
        self.assertEqual(decoded_base64.source, "base64")
        self.assertEqual((decoded_base64.decodedWidth, decoded_base64.decodedHeight), (4, 6))

        with self.subTest("path"):
            path = BACKEND_ROOT / "tests" / "tmp_raw_visual_matcher_query.jpg"
            image.save(path)
            try:
                decoded_path = matcher._load_query_image({"normalizedImagePath": str(path)})
                self.assertEqual(decoded_path.source, "path")
                self.assertGreater(decoded_path.encodedBytes, 0)
            finally:
                path.unlink(missing_ok=True)

        with self.assertRaisesRegex(ValueError, "not valid base64"):
            matcher._load_query_image({"normalizedImageBase64": "not-base64!"})

        with self.assertRaisesRegex(ValueError, "Expected normalizedImageBase64"):
            matcher._load_query_image({})

    def test_query_language_preference_detects_japanese_and_english_text(self) -> None:
        matcher = object.__new__(RawVisualMatcher)

        japanese_payload = {
            "ocrAnalysis": {
                "rawEvidence": {
                    "titleTextPrimary": "リザードン",
                    "titleConfidence": {"score": 0.9},
                }
            }
        }
        english_payload = {
            "ocrAnalysis": {
                "rawEvidence": {
                    "titleTextPrimary": "Charizard",
                    "titleConfidence": {"score": 0.8},
                    "wholeCardText": "Charizard ex 223/197",
                }
            }
        }

        self.assertEqual(matcher._query_language_preference(japanese_payload)[0], "Japanese")
        self.assertEqual(matcher._query_language_preference(english_payload)[0], "English")
        self.assertEqual(matcher._query_language_preference({}), (None, 0.0, []))

    def test_apply_language_adjustments_penalizes_tcgp_and_mismatched_language(self) -> None:
        adjusted = RawVisualMatcher._apply_language_adjustments(
            [
                RawVisualSearchMatch(
                    row_index=1,
                    similarity=0.7,
                    entry={"providerCardId": "tcgp-1", "language": "English"},
                ),
                RawVisualSearchMatch(
                    row_index=2,
                    similarity=0.68,
                    entry={"providerCardId": "base1-4", "language": "Japanese"},
                ),
            ],
            preferred_language="Japanese",
            preferred_language_confidence=0.9,
            apply_language_bias=True,
            variant_name="base",
            variant_inset_ratio=0.0,
        )

        self.assertEqual(adjusted[0].entry["providerCardId"], "base1-4")
        self.assertIn("language_bonus", adjusted[0].entry["_visualLanguageAdjustmentReasons"])
        self.assertIn("tcgp_penalty", adjusted[1].entry["_visualLanguageAdjustmentReasons"])
        self.assertIn("language_penalty", adjusted[1].entry["_visualLanguageAdjustmentReasons"])

    def test_center_inset_image_crops_and_preserves_original_size(self) -> None:
        centered = RawVisualMatcher._center_inset_image(_FakeImage(100, 120), 0.10)

        self.assertEqual(centered.size, (100, 120))
        self.assertEqual(centered.resize_args, (100, 120))
        self.assertEqual(centered.crop_args, (10, 12, 90, 108))

    def test_center_inset_image_returns_copy_when_inset_is_too_small_or_too_large(self) -> None:
        copied_for_zero = RawVisualMatcher._center_inset_image(_FakeImage(100, 120), 0.0)
        copied_for_large = RawVisualMatcher._center_inset_image(_FakeImage(20, 24), 0.40)

        self.assertTrue(copied_for_zero.copy_called)
        self.assertTrue(copied_for_large.copy_called)

    def test_image_embedding_with_timing_projects_and_normalizes_embedding(self) -> None:
        class _FakeEncoder:
            device = "cpu"

            def embed_images_with_timing(self, images, batch_size: int = 1):
                self.batch_size = batch_size
                return np.array([[3.0, np.nan, 4.0]], dtype=np.float32), {
                    "preprocessMs": 1.25,
                    "modelForwardMs": 2.5,
                    "postprocessMs": 0.75,
                }

        matcher = object.__new__(RawVisualMatcher)
        matcher._encoder = _FakeEncoder()
        matcher._adapter = object()

        with patch.object(
            raw_visual_matcher_module,
            "project_embeddings_numpy",
            return_value=np.array([[6.0, 0.0, 8.0]], dtype=np.float32),
        ) as project_mock:
            embedding, timing = matcher._image_embedding_with_timing(_FakeImage())

        project_mock.assert_called_once()
        self.assertTrue(np.allclose(embedding, np.array([0.6, 0.0, 0.8], dtype=np.float32)))
        self.assertEqual(timing["encoderPreprocessMs"], 1.25)
        self.assertEqual(timing["encoderForwardMs"], 2.5)
        self.assertEqual(timing["encoderPostprocessMs"], 0.75)
        self.assertGreaterEqual(timing["adapterProjectMs"], 0.0)
        self.assertGreaterEqual(timing["embeddingNormalizeMs"], 0.0)
        self.assertGreaterEqual(timing["embeddingMs"], 0.0)

    def test_match_payload_merges_query_variants_and_returns_debug_metadata(self) -> None:
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
                        similarity=0.60,
                        entry={"providerCardId": "tcgp-1", "language": "English", "name": "TCGP Card"},
                    ),
                    RawVisualSearchMatch(
                        row_index=2,
                        similarity=0.59,
                        entry={"providerCardId": "base1-4", "language": "Japanese", "name": "Charizard"},
                    ),
                ]

        matcher = object.__new__(RawVisualMatcher)
        matcher.model_id = "clip-test"
        matcher.index = _FakeIndex()
        matcher.adapter_checkpoint_path = Path("/tmp/missing-adapter.pt")
        matcher.adapter_metadata_path = Path("/tmp/missing-adapter.json")
        matcher._encoder = SimpleNamespace(device=torch.device("cpu")) if 'torch' in globals() else SimpleNamespace(device="cpu")
        matcher._adapter = None
        matcher._runtime_lock = Lock()
        matcher._telemetry_lock = Lock()
        matcher._runtime_ready = True
        matcher._inference_count = 0
        matcher._last_inference_finished_at = None
        matcher._ensure_runtime = lambda: None  # type: ignore[method-assign]
        matcher._image_embedding_with_timing = lambda image: (  # type: ignore[method-assign]
            np.array([1.0, 0.0], dtype=np.float32),
            {
                "encoderPreprocessMs": 1.0,
                "encoderForwardMs": 2.0,
                "encoderPostprocessMs": 3.0,
                "adapterProjectMs": 0.0,
                "embeddingNormalizeMs": 0.5,
                "embeddingMs": 6.5,
            },
        )

        image = Image.new("RGB", (20, 20), color=(120, 0, 0))
        buffer = BytesIO()
        image.save(buffer, format="JPEG")
        payload = {
            "normalizedImageBase64": b64encode(buffer.getvalue()).decode("ascii"),
            "ocrAnalysis": {
                "normalizedTarget": {
                    "targetQuality": {
                        "reasons": ["normalization:exact_reticle_fallback"],
                    }
                },
                "rawEvidence": {
                    "titleTextPrimary": "リザードン",
                    "titleConfidence": {"score": 0.8},
                },
            },
        }

        matches, debug = matcher.match_payload(payload, top_k=2)

        self.assertEqual(matches[0].entry["providerCardId"], "base1-4")
        self.assertEqual(debug["preferredLanguage"], "Japanese")
        self.assertTrue(debug["languageBiasApplied"])
        self.assertEqual(debug["queryVariantCount"], 2)
        self.assertEqual(len(matcher.index.search_calls), 2)
        self.assertEqual(debug["internalTopK"], 64)

    def test_match_payload_raises_when_visual_index_is_unavailable(self) -> None:
        class _UnavailableIndex:
            def is_available(self) -> bool:
                return False

        matcher = object.__new__(RawVisualMatcher)
        matcher.index = _UnavailableIndex()

        with self.assertRaisesRegex(RuntimeError, "Visual index artifacts are not available"):
            matcher.match_payload({})


if __name__ == "__main__":
    unittest.main()
