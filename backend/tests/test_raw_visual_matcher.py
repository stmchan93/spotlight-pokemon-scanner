from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

try:
    from raw_visual_index import RawVisualSearchMatch  # noqa: E402
    from raw_visual_matcher import RawVisualMatcher  # noqa: E402
    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host-python dependency fallback
    RawVisualSearchMatch = None  # type: ignore[assignment]
    RawVisualMatcher = None  # type: ignore[assignment]
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
        return resized


@unittest.skipIf(_IMPORT_ERROR is not None, f"raw visual matcher test deps unavailable: {_IMPORT_ERROR}")
class RawVisualMatcherTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
