"""Art-crop VERSION rule: after the whole-card match picks the top-1 card, the
query's art crop may re-choose WHICH of that card's version rows (base vs a
TCGplayer alt-art row) represents it. It must never change the card or the
ranking, never run for Pokémon, and be a no-op without a valid art file."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from base64 import b64encode
from io import BytesIO
from pathlib import Path
from threading import Lock
from unittest.mock import patch

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_index import RawVisualIndex, matched_variant_for_entry  # noqa: E402

try:
    from PIL import Image  # noqa: E402
    import raw_visual_matcher as raw_visual_matcher_module  # noqa: E402
    from raw_visual_art_version import art_crop_query_image  # noqa: E402
    from raw_visual_matcher import RawVisualMatcher  # noqa: E402
    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host-python dependency fallback
    RawVisualMatcher = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

INDEX_VERSION = "onepiece-test-v1"
ADAPTER_VERSION = "siglip2-384-v003-candidate"
REGION = (0.10, 0.07, 0.90, 0.38)
QUERY_SIZE = (20, 20)


def _base(card_id: str) -> dict:
    return {"providerCardId": card_id, "name": card_id, "language": "English", "game": "onepiece"}


def _alt(card_id: str, product_id: str) -> dict:
    return {
        **_base(card_id),
        "referenceSource": "tcgplayer",
        "variantLabel": "Alt Art",
        "tcgplayerProductId": product_id,
    }


def _whole(cos: float) -> list[float]:
    # Whole-card space: cosine `cos` to the query e0.
    return [cos, float(np.sqrt(max(0.0, 1 - cos**2))), 0.0, 0.0]


def _art(cos: float) -> list[float]:
    # Art space: cosine `cos` to the query crop e2.
    return [0.0, 0.0, cos, float(np.sqrt(max(0.0, 1 - cos**2)))]


QUERY_WHOLE = np.asarray([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
QUERY_ART = np.asarray([0.0, 0.0, 1.0, 0.0], dtype=np.float32)


@unittest.skipIf(_IMPORT_ERROR is not None, f"raw visual matcher test deps unavailable: {_IMPORT_ERROR}")
class ArtVersionRuleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.crop_sizes: list[tuple[int, int]] = []
        self.adapter_metadata = self.dir / "adapter_metadata.json"
        self.adapter_metadata.write_text(json.dumps({"artifactVersion": ADAPTER_VERSION}))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write_index(self, entries: list[dict], embeddings: list[list[float]], *, game: str = "onepiece") -> RawVisualIndex:
        npz_path = self.dir / f"visual_index_active_{game}_siglip2-base-patch16-384.npz"
        manifest_path = self.dir / f"visual_index_active_{game}_manifest.json"
        np.savez_compressed(npz_path, embeddings=np.asarray(embeddings, dtype=np.float32))
        manifest_path.write_text(json.dumps({"artifactVersion": INDEX_VERSION, "entries": entries}))
        return RawVisualIndex(npz_path=npz_path, manifest_path=manifest_path)

    def _write_art(
        self,
        rows: list[int],
        art: list[list[float]],
        *,
        game: str = "onepiece",
        index_version: str = INDEX_VERSION,
        adapter: str = ADAPTER_VERSION,
    ) -> Path:
        path = self.dir / f"visual_index_active_{game}_artcrop.npz"
        np.savez(
            path,
            rows=np.asarray(rows, dtype=np.int32),
            embeddings=np.asarray(art, dtype=np.float16),
            region=np.asarray(REGION, dtype=np.float32),
            adapter=np.asarray(adapter),
            index_artifact_version=np.asarray(index_version),
        )
        return path

    def _embed(self, image):
        if image.size == QUERY_SIZE:
            return QUERY_WHOLE.copy(), {"embeddingMs": 0.0}
        self.crop_sizes.append(image.size)
        return QUERY_ART.copy(), {"embeddingMs": 1.5}

    def _matcher(self, index: RawVisualIndex) -> RawVisualMatcher:
        matcher = object.__new__(RawVisualMatcher)
        matcher.model_id = "test-model"
        matcher.index = index
        matcher.index_for_game = lambda game=None: index  # type: ignore[method-assign]
        matcher.adapter_checkpoint_path = None
        matcher.adapter_metadata_path = self.adapter_metadata
        matcher._adapter = object()
        matcher._encoder = None
        matcher._telemetry_lock = Lock()
        matcher._inference_count = 0
        matcher._last_inference_finished_at = None
        matcher._ensure_runtime = lambda: None  # type: ignore[method-assign]
        matcher._image_embedding_with_timing = self._embed  # type: ignore[method-assign]
        matcher.alt_reference_penalty = 0.02
        return matcher

    @staticmethod
    def _payload(game: str = "onepiece") -> dict:
        buffer = BytesIO()
        Image.new("RGB", QUERY_SIZE, color=(0, 0, 120)).save(buffer, format="JPEG")
        return {"normalizedImageBase64": b64encode(buffer.getvalue()).decode("ascii"), "game": game}

    def _scenario(self, whole: tuple[float, float], art: tuple[float, float], *, game: str = "onepiece"):
        """Card A = base row 0 + alt row 1 (product 111); card B base row 2."""
        index = self._write_index(
            [_base("A"), _alt("A", "111"), _base("B")],
            [_whole(whole[0]), _whole(whole[1]), _whole(0.5)],
            game=game,
        )
        self._write_art([0, 1, 2], [_art(art[0]), _art(art[1]), _art(0.1)], game=game)
        return index

    def _run(self, index: RawVisualIndex, *, game: str = "onepiece"):
        return self._matcher(index).match_payload(self._payload(game), top_k=10)

    @staticmethod
    def _ranking(matches):
        return [(m.entry["providerCardId"], round(m.similarity, 6)) for m in matches]

    def _baseline(self, index: RawVisualIndex):
        with patch.dict(raw_visual_matcher_module.os.environ, {"SPOTLIGHT_VISUAL_ART_VERSION_RULE": "0"}):
            matcher = self._matcher(index)
            matcher.art_version_rule_enabled = False
            return matcher.match_payload(self._payload(), top_k=10)[0]

    def test_switches_base_winner_to_alt_row_when_art_clearly_matches(self) -> None:
        # Whole-card: base 0.95 vs alt 0.96-0.02=0.94 (gap 0.01). Art: alt +0.10.
        index = self._scenario((0.95, 0.96), (0.70, 0.80))
        baseline = self._baseline(index)
        self.assertEqual(baseline[0].row_index, 0)
        matches, debug = self._run(index)
        self.assertEqual(self._ranking(matches), self._ranking(baseline))
        self.assertEqual(matches[0].row_index, 1)
        self.assertEqual(matched_variant_for_entry(matches[0].entry)["tcgplayerProductId"], "111")
        self.assertIn("art_version_switch", matches[0].entry["_visualLanguageAdjustmentReasons"])
        self.assertTrue(debug["artVersion"]["applied"])
        self.assertEqual(self.crop_sizes, [(504, 273)])

    def test_switches_alt_winner_to_base_row_and_drops_matched_variant(self) -> None:
        # Whole-card: alt 0.99-0.02=0.97 vs base 0.95 (gap 0.02). Art: base +0.05.
        index = self._scenario((0.95, 0.99), (0.85, 0.80))
        baseline = self._baseline(index)
        self.assertEqual(baseline[0].row_index, 1)
        self.assertIsNotNone(matched_variant_for_entry(baseline[0].entry))
        matches, _ = self._run(index)
        self.assertEqual(self._ranking(matches), self._ranking(baseline))
        self.assertEqual(matches[0].row_index, 0)
        self.assertIsNone(matched_variant_for_entry(matches[0].entry))

    def test_no_switch_when_art_margin_below_threshold(self) -> None:
        index = self._scenario((0.95, 0.96), (0.78, 0.80))  # art +0.02 < 0.03
        matches, debug = self._run(index)
        self.assertEqual(matches[0].row_index, 0)
        self.assertEqual(debug["artVersion"]["reason"], "kept_whole_card_choice")
        self.assertEqual(self._ranking(matches), self._ranking(self._baseline(index)))

    def test_no_switch_and_no_crop_embed_when_gap_exceeds_window(self) -> None:
        index = self._scenario((0.95, 0.90), (0.10, 0.90))  # gap 0.07 > 0.05
        matches, debug = self._run(index)
        self.assertEqual(matches[0].row_index, 0)
        self.assertEqual(debug["artVersion"]["reason"], "outside_window")
        self.assertEqual(self.crop_sizes, [])

    def test_missing_art_file_is_a_noop_with_warning(self) -> None:
        index = self._write_index([_base("A"), _alt("A", "111")], [_whole(0.95), _whole(0.96)])
        with patch.object(raw_visual_matcher_module, "_emit_matcher_log") as log:
            matches, debug = self._run(index)
        self.assertEqual(matches[0].row_index, 0)
        self.assertEqual(debug["artVersion"]["reason"], "art_index_unavailable")
        self.assertTrue(any(call.args[:2] == ("WARNING", "visual_art_version_unavailable") for call in log.call_args_list))

    def _assert_disabled(self, index: RawVisualIndex, reason: str) -> None:
        with patch.object(raw_visual_matcher_module, "_emit_matcher_log") as log:
            matches, debug = self._run(index)
        self.assertEqual(matches[0].row_index, 0)
        self.assertEqual(debug["artVersion"]["reason"], "art_index_unavailable")
        warnings = [call for call in log.call_args_list if call.args[:2] == ("WARNING", "visual_art_version_unavailable")]
        self.assertEqual([call.kwargs["reason"] for call in warnings], [reason])

    def test_stale_index_version_disables_rule(self) -> None:
        index = self._scenario((0.95, 0.96), (0.70, 0.80))
        self._write_art([0, 1], [_art(0.70), _art(0.80)], index_version="older-build")
        self._assert_disabled(index, "index_version_mismatch")

    def test_adapter_mismatch_disables_rule(self) -> None:
        index = self._scenario((0.95, 0.96), (0.70, 0.80))
        self._write_art([0, 1], [_art(0.70), _art(0.80)], adapter="siglip2-384-v004")
        self._assert_disabled(index, "adapter_mismatch")

    def test_card_with_single_covered_row_does_not_participate(self) -> None:
        index = self._scenario((0.95, 0.96), (0.70, 0.80))
        self._write_art([0, 2], [_art(0.70), _art(0.1)])
        matches, debug = self._run(index)
        self.assertEqual(matches[0].row_index, 0)
        self.assertEqual(debug["artVersion"]["reason"], "card_not_covered")

    def test_pokemon_index_untouched(self) -> None:
        index = self._scenario((0.95, 0.96), (0.70, 0.80), game="pokemon")
        matches, debug = self._run(index, game="pokemon")
        self.assertEqual(matches[0].row_index, 0)
        self.assertEqual(debug["artVersion"]["reason"], "pokemon")
        self.assertEqual(self.crop_sizes, [])

    def test_reload_revalidates_art_file(self) -> None:
        index = self._scenario((0.95, 0.96), (0.70, 0.80))
        matcher = self._matcher(index)
        self.assertEqual(matcher.match_payload(self._payload())[0][0].row_index, 1)
        # A rebuild bumps the manifest version; the old sidecar is now stale.
        manifest = json.loads(index.manifest_path.read_text())
        manifest["artifactVersion"] = "onepiece-test-v2"
        index.manifest_path.write_text(json.dumps(manifest))
        index.reload()
        matches, debug = matcher.match_payload(self._payload())
        self.assertEqual(matches[0].row_index, 0)
        self.assertEqual(debug["artVersion"]["reason"], "art_index_unavailable")

    def test_env_flags(self) -> None:
        class _FakeIndex:
            def __init__(self, *, npz_path: Path, manifest_path: Path) -> None:
                self.npz_path = npz_path
                self.manifest_path = manifest_path

        keys = (
            "SPOTLIGHT_VISUAL_ART_VERSION_RULE",
            "SPOTLIGHT_VISUAL_ART_VERSION_WINDOW",
            "SPOTLIGHT_VISUAL_ART_VERSION_MARGIN",
        )
        with patch.object(raw_visual_matcher_module, "RawVisualIndex", _FakeIndex):
            with patch.dict(raw_visual_matcher_module.os.environ, {}, clear=False) as env:
                for key in keys:
                    env.pop(key, None)
                matcher = RawVisualMatcher(repo_root=self.dir)
                self.assertTrue(matcher.art_version_rule_enabled)
                self.assertEqual((matcher.art_version_window, matcher.art_version_margin), (0.05, 0.03))
            with patch.dict(raw_visual_matcher_module.os.environ, dict(zip(keys, ("0", "0.08", "0.01")))):
                matcher = RawVisualMatcher(repo_root=self.dir)
                self.assertFalse(matcher.art_version_rule_enabled)
                self.assertEqual((matcher.art_version_window, matcher.art_version_margin), (0.08, 0.01))

        index = self._scenario((0.95, 0.96), (0.70, 0.80))
        matcher = self._matcher(index)
        matcher.art_version_rule_enabled = False
        matches, debug = matcher.match_payload(self._payload())
        self.assertEqual(matches[0].row_index, 0)
        self.assertEqual(debug["artVersion"]["reason"], "feature_disabled")
        matcher = self._matcher(index)
        matcher.art_version_margin = 0.2  # art +0.10 no longer clears the margin
        self.assertEqual(matcher.match_payload(self._payload())[0][0].row_index, 0)

    def test_query_crop_matches_experiment_geometry(self) -> None:
        crop = art_crop_query_image(Image.new("RGB", (315, 440)), REGION)
        self.assertEqual(crop.size, (int(0.90 * 630) - int(0.10 * 630), int(0.38 * 880) - int(0.07 * 880)))


if __name__ == "__main__":
    unittest.main()
