"""Art-crop CARD rerank: on a near-tie between DIFFERENT cards, promote the one
whose artwork clearly matches the query's art crop better. Non-Pokémon only,
needs an all-cards art file (coverage + edge maps), never flips between two
cards whose art is the same drawing, and never drops/introduces a candidate."""

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

from raw_visual_index import RawVisualIndex  # noqa: E402

try:
    from PIL import Image  # noqa: E402
    import raw_visual_matcher as raw_visual_matcher_module  # noqa: E402
    from raw_visual_art_version import (  # noqa: E402
        EDGE_MAP_SIZE,
        art_rerank_pool,
        edge_structure_map,
        pick_art_card,
    )
    from raw_visual_matcher import RawVisualMatcher  # noqa: E402
    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host-python dependency fallback
    RawVisualMatcher = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

INDEX_VERSION = "onepiece-test-v1"
ADAPTER_VERSION = "siglip2-384-v003-candidate"
REGION = (0.10, 0.07, 0.90, 0.38)
QUERY_SIZE = (20, 20)
EDGE_DIM = EDGE_MAP_SIZE[0] * EDGE_MAP_SIZE[1]


def _entry(card_id: str, **extra) -> dict:
    return {"providerCardId": card_id, "name": card_id, "language": "English", "game": "onepiece", **extra}


def _whole(cos: float) -> list[float]:
    return [cos, float(np.sqrt(max(0.0, 1 - cos**2))), 0.0, 0.0]


def _art(cos: float) -> list[float]:
    return [0.0, 0.0, cos, float(np.sqrt(max(0.0, 1 - cos**2)))]


def _edges(seed: int) -> np.ndarray:
    return np.random.default_rng(seed).integers(-127, 128, EDGE_DIM).astype(np.int8)


QUERY_WHOLE = np.asarray([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
QUERY_ART = np.asarray([0.0, 0.0, 1.0, 0.0], dtype=np.float32)


class RerankHelperTests(unittest.TestCase):
    @unittest.skipIf(_IMPORT_ERROR is not None, f"deps unavailable: {_IMPORT_ERROR}")
    def test_pool_trigger(self) -> None:
        kw = dict(window=0.03, top_k=3, min_similarity=0.45)
        self.assertEqual(art_rerank_pool([0.62, 0.61, 0.60, 0.40], **kw), ([0, 1, 2], "triggered"))
        self.assertEqual(art_rerank_pool([0.62, 0.61, 0.60, 0.615], **kw)[0], [0, 1, 2])  # capped at top_k
        self.assertEqual(art_rerank_pool([0.62, 0.61, 0.58], **kw)[0], [0, 1])
        self.assertEqual(art_rerank_pool([0.62, 0.58], **kw), (None, "outside_window"))
        self.assertEqual(art_rerank_pool([0.30, 0.29], **kw), (None, "below_min_similarity"))
        self.assertEqual(art_rerank_pool([0.62], **kw), (None, "insufficient_candidates"))

    @unittest.skipIf(_IMPORT_ERROR is not None, f"deps unavailable: {_IMPORT_ERROR}")
    def test_pick_needs_margin(self) -> None:
        self.assertEqual(pick_art_card({0: 0.40, 1: 0.60}, margin=0.10), 1)
        self.assertEqual(pick_art_card({0: 0.55, 1: 0.60}, margin=0.10), 0)
        self.assertEqual(pick_art_card({0: 0.60, 1: 0.40}, margin=0.10), 0)

    @unittest.skipIf(_IMPORT_ERROR is not None, f"deps unavailable: {_IMPORT_ERROR}")
    def test_edge_map_is_colour_invariant_and_drawing_specific(self) -> None:
        rng = np.random.default_rng(0)
        drawing = (rng.random((60, 90)) > 0.97).astype(np.float32)
        drawing = np.clip(drawing + np.roll(drawing, 1, 0) + np.roll(drawing, 1, 1), 0, 1)
        base = Image.fromarray((drawing * 200 + 20).astype(np.uint8)).convert("RGB")
        recoloured = Image.fromarray(np.dstack([(drawing * 120 + 90), (drawing * 60 + 30), (drawing * 180)]).astype(np.uint8))
        other = Image.fromarray(((rng.random((60, 90)) > 0.97) * 200 + 20).astype(np.uint8)).convert("RGB")
        a, b, c = (edge_structure_map(img).astype(np.float32) for img in (base, recoloured, other))
        self.assertEqual(a.shape, (EDGE_DIM,))
        unit = lambda v: v / np.linalg.norm(v)  # noqa: E731
        self.assertGreater(float(unit(a) @ unit(b)), 0.9)
        self.assertLess(float(unit(a) @ unit(c)), 0.3)


@unittest.skipIf(_IMPORT_ERROR is not None, f"raw visual matcher test deps unavailable: {_IMPORT_ERROR}")
class ArtCardRerankTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.crop_sizes: list[tuple[int, int]] = []
        self.adapter_metadata = self.dir / "adapter_metadata.json"
        self.adapter_metadata.write_text(json.dumps({"artifactVersion": ADAPTER_VERSION}))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write_index(self, entries: list[dict], whole: list[float], *, game: str = "onepiece") -> RawVisualIndex:
        npz_path = self.dir / f"visual_index_active_{game}_siglip2-base-patch16-384.npz"
        manifest_path = self.dir / f"visual_index_active_{game}_manifest.json"
        np.savez_compressed(npz_path, embeddings=np.asarray([_whole(c) for c in whole], dtype=np.float32))
        manifest_path.write_text(json.dumps({"artifactVersion": INDEX_VERSION, "entries": entries}))
        return RawVisualIndex(npz_path=npz_path, manifest_path=manifest_path)

    def _write_art(self, rows: list[int], art: list[float], edges: list[np.ndarray] | None, *, game: str = "onepiece") -> None:
        payload = dict(
            rows=np.asarray(rows, dtype=np.int32),
            embeddings=np.asarray([_art(c) for c in art], dtype=np.float16),
            region=np.asarray(REGION, dtype=np.float32),
            adapter=np.asarray(ADAPTER_VERSION),
            index_artifact_version=np.asarray(INDEX_VERSION),
        )
        if edges is not None:
            payload.update(coverage=np.asarray("all_cards"), edge_maps=np.stack(edges).astype(np.int8))
        np.savez(self.dir / f"visual_index_active_{game}_artcrop.npz", **payload)

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

    def _run(self, index: RawVisualIndex, *, game: str = "onepiece", matcher=None):
        return (matcher or self._matcher(index)).match_payload(self._payload(game), top_k=10)

    @staticmethod
    def _ids(matches) -> list[str]:
        return [m.entry["providerCardId"] for m in matches]

    def _abc(self, whole=(0.62, 0.61, 0.40), art=(0.40, 0.60, 0.10), edges=(1, 2, 3), game="onepiece") -> RawVisualIndex:
        """Cards A, B, C: one base row each."""
        index = self._write_index([_entry("A"), _entry("B"), _entry("C")], list(whole), game=game)
        self._write_art([0, 1, 2], list(art), None if edges is None else [_edges(s) for s in edges], game=game)
        return index

    def test_promotes_clearly_better_art_on_near_tie(self) -> None:
        matches, debug = self._run(self._abc())
        self.assertEqual(self._ids(matches), ["B", "A", "C"])
        self.assertAlmostEqual(matches[0].similarity, 0.62, places=5)  # takes the old top-1 score
        self.assertAlmostEqual(matches[1].similarity, 0.62, places=5)
        self.assertIn("art_card_rerank", matches[0].entry["_visualLanguageAdjustmentReasons"])
        self.assertEqual(matches[0].entry["_visualArtCardRerank"]["fromCardId"], "A")
        rerank = debug["artCardRerank"]
        self.assertTrue(rerank["applied"])
        self.assertEqual((rerank["fromCardId"], rerank["toCardId"]), ("A", "B"))
        self.assertEqual(self.crop_sizes, [(504, 273)])
        self.assertIn("artCardRerankMs", debug["timings"])

    def test_keeps_top1_when_art_margin_too_small(self) -> None:
        matches, debug = self._run(self._abc(art=(0.55, 0.60, 0.1)))
        self.assertEqual(self._ids(matches), ["A", "B", "C"])
        self.assertEqual(debug["artCardRerank"]["reason"], "kept_whole_card_choice")

    def test_no_crop_when_gap_exceeds_window(self) -> None:
        matches, debug = self._run(self._abc(whole=(0.66, 0.61, 0.40)))
        self.assertEqual(self._ids(matches)[0], "A")
        self.assertEqual(debug["artCardRerank"]["reason"], "outside_window")
        self.assertEqual(self.crop_sizes, [])

    def test_junk_scan_below_min_similarity_untouched(self) -> None:
        matches, debug = self._run(self._abc(whole=(0.30, 0.29, 0.10)))
        self.assertEqual(self._ids(matches)[0], "A")
        self.assertEqual(debug["artCardRerank"]["reason"], "below_min_similarity")

    def test_same_drawing_guard_blocks_switch(self) -> None:
        matches, debug = self._run(self._abc(edges=(7, 7, 3)))
        self.assertEqual(self._ids(matches)[0], "A")
        self.assertEqual(debug["artCardRerank"]["reason"], "same_drawing")

    def test_version_only_art_file_disables_rerank_but_not_version_rule(self) -> None:
        index = self._write_index(
            [_entry("A"), _entry("A", referenceSource="tcgplayer", variantLabel="Alt Art", tcgplayerProductId="9"), _entry("B")],
            [0.62, 0.635, 0.61],
        )
        self._write_art([0, 1], [0.40, 0.70], None)
        matches, debug = self._run(index)
        self.assertEqual(self._ids(matches)[:2], ["A", "B"])
        self.assertEqual(debug["artCardRerank"]["reason"], "art_index_unavailable")
        self.assertEqual(matches[0].row_index, 1)  # version rule still picked the alt row
        self.assertTrue(debug["artVersion"]["applied"])

    def test_uncovered_candidate_blocks_rerank(self) -> None:
        index = self._write_index([_entry("A"), _entry("B"), _entry("C")], [0.62, 0.61, 0.40])
        self._write_art([0, 2], [0.40, 0.10], [_edges(1), _edges(3)])  # B appended after the art build
        matches, debug = self._run(index)
        self.assertEqual(self._ids(matches)[0], "A")
        self.assertEqual(debug["artCardRerank"]["reason"], "candidate_not_covered")

    def test_pokemon_untouched(self) -> None:
        matches, debug = self._run(self._abc(game="pokemon"), game="pokemon")
        self.assertEqual(self._ids(matches)[0], "A")
        self.assertEqual(debug["artCardRerank"]["reason"], "pokemon")
        self.assertEqual(self.crop_sizes, [])

    def test_promoted_card_version_rule_shares_one_crop_embedding(self) -> None:
        # B has base + alt rows; after B is promoted the version rule re-chooses
        # B's version from the SAME crop embedding (one extra encoder pass total).
        index = self._write_index(
            [_entry("A"), _entry("B"), _entry("B", referenceSource="tcgplayer", variantLabel="Alt Art", tcgplayerProductId="5")],
            [0.62, 0.61, 0.625],  # B: base 0.61 beats alt 0.625-0.02 on whole card
        )
        self._write_art([0, 1, 2], [0.40, 0.55, 0.70], [_edges(1), _edges(2), _edges(4)])
        matches, debug = self._run(index)
        self.assertEqual(self._ids(matches)[:2], ["B", "A"])
        self.assertEqual(matches[0].row_index, 2)
        self.assertTrue(debug["artCardRerank"]["applied"])
        self.assertTrue(debug["artVersion"]["applied"])
        self.assertEqual(len(self.crop_sizes), 1)

    def test_rerank_error_never_fails_the_scan(self) -> None:
        index = self._abc()
        matcher = self._matcher(index)
        with patch.object(raw_visual_matcher_module, "pick_art_card", side_effect=RuntimeError("boom")):
            matches, debug = self._run(index, matcher=matcher)
        self.assertEqual(self._ids(matches)[0], "A")
        self.assertEqual(debug["artCardRerank"]["reason"], "error")

    def test_env_flags(self) -> None:
        class _FakeIndex:
            def __init__(self, *, npz_path: Path, manifest_path: Path) -> None:
                self.npz_path = npz_path
                self.manifest_path = manifest_path

        keys = (
            "SPOTLIGHT_VISUAL_ART_RERANK",
            "SPOTLIGHT_VISUAL_ART_RERANK_WINDOW",
            "SPOTLIGHT_VISUAL_ART_RERANK_K",
            "SPOTLIGHT_VISUAL_ART_RERANK_MARGIN",
            "SPOTLIGHT_VISUAL_ART_RERANK_MIN_SIMILARITY",
        )
        with patch.object(raw_visual_matcher_module, "RawVisualIndex", _FakeIndex):
            with patch.dict(raw_visual_matcher_module.os.environ, {}, clear=False) as env:
                for key in keys:
                    env.pop(key, None)
                matcher = RawVisualMatcher(repo_root=self.dir)
                self.assertTrue(matcher.art_rerank_enabled)
                self.assertEqual(
                    (matcher.art_rerank_window, matcher.art_rerank_top_k, matcher.art_rerank_margin, matcher.art_rerank_min_similarity),
                    (0.03, 3, 0.10, 0.45),
                )
            with patch.dict(raw_visual_matcher_module.os.environ, dict(zip(keys, ("0", "0.05", "5", "0.2", "0.5")))):
                matcher = RawVisualMatcher(repo_root=self.dir)
                self.assertFalse(matcher.art_rerank_enabled)
                self.assertEqual(
                    (matcher.art_rerank_window, matcher.art_rerank_top_k, matcher.art_rerank_margin, matcher.art_rerank_min_similarity),
                    (0.05, 5, 0.2, 0.5),
                )
        index = self._abc()
        matcher = self._matcher(index)
        matcher.art_rerank_enabled = False
        matches, debug = self._run(index, matcher=matcher)
        self.assertEqual(self._ids(matches)[0], "A")
        self.assertEqual(debug["artCardRerank"]["reason"], "feature_disabled")


if __name__ == "__main__":
    unittest.main()
