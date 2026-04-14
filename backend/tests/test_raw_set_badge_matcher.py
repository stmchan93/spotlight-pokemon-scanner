from __future__ import annotations

import base64
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path

from backend.raw_set_badge_matcher import DEFAULT_SET_BADGE_RECTS, RawSetBadgeMatcher


PIL_AVAILABLE = importlib.util.find_spec("PIL") is not None


@unittest.skipUnless(PIL_AVAILABLE, "Pillow is required for badge matcher tests.")
class RawSetBadgeMatcherTests(unittest.TestCase):
    def setUp(self) -> None:
        from PIL import Image, ImageDraw

        self.Image = Image
        self.ImageDraw = ImageDraw
        self.tempdir = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.tempdir.name)
        self.matcher = RawSetBadgeMatcher()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def _badge_rect(self, family: str, *, width: int = 630, height: int = 880) -> tuple[int, int, int, int]:
        x, y, rect_width, rect_height = DEFAULT_SET_BADGE_RECTS[family]
        left = int(round(x * width))
        top = int(round(y * height))
        right = int(round((x + rect_width) * width))
        bottom = int(round((y + rect_height) * height))
        return left, top, right, bottom

    def _draw_badge(self, image, family: str, pattern: str) -> None:
        draw = self.ImageDraw.Draw(image)
        left, top, right, bottom = self._badge_rect(family, width=image.size[0], height=image.size[1])
        draw.rectangle((left, top, right, bottom), fill=(235, 235, 235), outline=(0, 0, 0), width=2)
        if pattern == "diagonal":
            draw.line((left + 4, bottom - 4, right - 4, top + 4), fill=(0, 0, 0), width=4)
            draw.line((left + 4, top + 4, right - 12, bottom - 12), fill=(60, 60, 60), width=2)
        elif pattern == "bars":
            draw.rectangle((left + 6, top + 6, left + 16, bottom - 6), fill=(0, 0, 0))
            draw.rectangle((left + 24, top + 6, left + 34, bottom - 6), fill=(40, 40, 40))
            draw.rectangle((left + 42, top + 6, left + 52, bottom - 6), fill=(80, 80, 80))
        else:
            raise ValueError(f"Unknown pattern: {pattern}")

    def _write_reference(self, filename: str, pattern: str, family: str = "modern_left") -> Path:
        image = self.Image.new("RGB", (630, 880), (255, 255, 255))
        self._draw_badge(image, family, pattern)
        output_path = self.temp_root / filename
        image.save(output_path)
        return output_path

    def _payload_for_pattern(
        self,
        pattern: str,
        *,
        family: str = "modern_left",
        content_rect_normalized: dict[str, float] | None = None,
    ) -> dict[str, object]:
        image = self.Image.new("RGB", (630, 880), (255, 255, 255))
        self._draw_badge(image, family, pattern)
        with io.BytesIO() as buffer:
            image.save(buffer, format="JPEG")
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        payload: dict[str, object] = {
            "image": {
                "jpegBase64": encoded,
            },
            "ocrAnalysis": {
                "normalizedTarget": {},
            },
        }
        if content_rect_normalized is not None:
            payload["ocrAnalysis"] = {
                "normalizedTarget": {
                    "contentRectNormalized": content_rect_normalized,
                }
            }
        return payload

    def test_score_payload_against_entries_prefers_matching_badge_pattern(self) -> None:
        matching_reference = self._write_reference("matching.jpg", "diagonal")
        wrong_reference = self._write_reference("wrong.jpg", "bars")
        payload = self._payload_for_pattern("diagonal")

        scores = self.matcher.score_payload_against_entries(
            payload,
            [
                {"providerCardId": "match-1", "referenceImagePath": str(matching_reference)},
                {"providerCardId": "wrong-1", "referenceImagePath": str(wrong_reference)},
            ],
        )

        self.assertIn("match-1", scores)
        self.assertIn("wrong-1", scores)
        self.assertEqual(scores["match-1"]["family"], "modern_left")
        self.assertGreater(scores["match-1"]["score"], scores["wrong-1"]["score"])

    def test_score_payload_against_entries_respects_normalized_content_rect(self) -> None:
        matching_reference = self._write_reference("legacy-reference.jpg", "bars", family="legacy_right_mid")
        payload = self._payload_for_pattern(
            "bars",
            family="legacy_right_mid",
            content_rect_normalized={"x": 0.1, "y": 0.05, "width": 0.8, "height": 0.9},
        )

        scores = self.matcher.score_payload_against_entries(
            payload,
            [
                {"providerCardId": "legacy-match", "referenceImagePath": str(matching_reference)},
            ],
        )

        self.assertIn("legacy-match", scores)
        self.assertEqual(scores["legacy-match"]["family"], "legacy_right_mid")
        self.assertGreater(scores["legacy-match"]["score"], 0.5)


if __name__ == "__main__":
    unittest.main()
