"""Alt-art reference rows (one per TCGplayer product whose art differs from the
card's Scrydex image) in the visual index: the per-row penalty, the per-card
collapse, and the incremental refresh's handling of those rows."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from base64 import b64encode
from io import BytesIO
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from raw_visual_index import (  # noqa: E402
    RawVisualIndex,
    RawVisualSearchMatch,
    is_alt_reference_entry,
    matched_variant_for_entry,
)
from visual_index_incremental import append_missing_cards, diff_missing_ids  # noqa: E402

try:
    from PIL import Image  # noqa: E402
    import raw_visual_matcher as raw_visual_matcher_module  # noqa: E402
    from raw_visual_matcher import RawVisualMatcher  # noqa: E402
    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host-python dependency fallback
    RawVisualMatcher = None  # type: ignore[assignment]
    raw_visual_matcher_module = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


def _base_entry(card_id: str) -> dict:
    return {"providerCardId": card_id, "name": card_id, "language": "English"}


def _alt_entry(card_id: str, product_id: str, label: str = "Manga Alt Art") -> dict:
    return {
        **_base_entry(card_id),
        "referenceSource": "tcgplayer",
        "variantLabel": label,
        "tcgplayerProductId": product_id,
        "tcgplayerOrdinal": 1,
    }


def _unit(angle_degrees: float) -> list[float]:
    radians = np.deg2rad(angle_degrees)
    return [float(np.cos(radians)), float(np.sin(radians))]


def _write_index(directory: Path, entries: list[dict], embeddings: list[list[float]]) -> RawVisualIndex:
    npz_path = directory / "visual_index_active_test.npz"
    manifest_path = directory / "visual_index_active_manifest.json"
    np.savez_compressed(npz_path, embeddings=np.asarray(embeddings, dtype=np.float32))
    manifest_path.write_text(json.dumps({"entryCount": len(entries), "entries": entries}))
    return RawVisualIndex(npz_path=npz_path, manifest_path=manifest_path)


class MatchedVariantHelperTests(unittest.TestCase):
    def test_base_rows_have_no_variant(self) -> None:
        self.assertFalse(is_alt_reference_entry(_base_entry("onepiece~OP05-119")))
        self.assertFalse(is_alt_reference_entry({**_base_entry("x"), "referenceSource": "scrydex"}))
        self.assertIsNone(matched_variant_for_entry(_base_entry("onepiece~OP05-119")))

    def test_tcgplayer_row_maps_to_matched_variant(self) -> None:
        entry = _alt_entry("onepiece~OP05-119", "527026")
        self.assertTrue(is_alt_reference_entry(entry))
        self.assertEqual(
            matched_variant_for_entry(entry),
            {
                "label": "Manga Alt Art",
                "tcgplayerProductId": "527026",
                "imageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/527026_in_1000x1000.jpg",
                "source": "tcgplayer",
            },
        )

    def test_loader_keeps_extra_entry_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            index = _write_index(
                Path(tmp),
                [_base_entry("a"), _alt_entry("a", "111")],
                [_unit(0), _unit(10)],
            )
            matches = index.search(np.asarray(_unit(10), dtype=np.float32), top_k=2)
        self.assertEqual(matches[0].row_index, 1)
        self.assertEqual(matches[0].entry["tcgplayerProductId"], "111")
        self.assertEqual(matches[0].entry["providerCardId"], "a")


@unittest.skipIf(_IMPORT_ERROR is not None, f"raw visual matcher test deps unavailable: {_IMPORT_ERROR}")
class AltReferencePenaltyMatcherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def _payload() -> dict:
        buffer = BytesIO()
        Image.new("RGB", (20, 20), color=(0, 0, 120)).save(buffer, format="JPEG")
        return {"normalizedImageBase64": b64encode(buffer.getvalue()).decode("ascii")}

    def _matcher(self, index: RawVisualIndex, *, penalty: float | None = None) -> RawVisualMatcher:
        matcher = object.__new__(RawVisualMatcher)
        matcher.model_id = "test-model"
        matcher.index = index
        matcher.index_for_game = lambda game=None: index  # type: ignore[method-assign]
        matcher.adapter_checkpoint_path = None
        matcher.adapter_metadata_path = None
        matcher._encoder = SimpleNamespace(device="cpu")
        matcher._telemetry_lock = Lock()
        matcher._inference_count = 0
        matcher._last_inference_finished_at = None
        matcher._ensure_runtime = lambda: None  # type: ignore[method-assign]
        matcher._image_embedding_with_timing = lambda image: (  # type: ignore[method-assign]
            np.asarray(_unit(0), dtype=np.float32),
            {"embeddingMs": 0.0},
        )
        if penalty is not None:
            matcher.alt_reference_penalty = penalty
        return matcher

    def _run(self, entries, embeddings, *, penalty: float | None = None, top_k: int = 10):
        index = _write_index(self.dir, entries, embeddings)
        return self._matcher(index, penalty=penalty).match_payload(self._payload(), top_k=top_k)

    def test_penalty_applies_only_to_tcgplayer_rows(self) -> None:
        adjusted = RawVisualMatcher._apply_language_adjustments(
            [
                RawVisualSearchMatch(row_index=0, similarity=0.90, entry=_alt_entry("a", "1")),
                RawVisualSearchMatch(row_index=1, similarity=0.89, entry=_base_entry("b")),
            ],
            preferred_language=None,
            preferred_language_confidence=0.0,
            apply_language_bias=False,
            variant_name="base",
            variant_inset_ratio=0.0,
            alt_reference_penalty=0.02,
        )
        by_id = {match.entry["providerCardId"]: match for match in adjusted}
        self.assertAlmostEqual(by_id["a"].similarity, 0.88)
        self.assertEqual(by_id["a"].entry["_visualLanguageAdjustmentReasons"], ["alt_reference_penalty"])
        self.assertEqual(by_id["a"].entry["_visualBaseSimilarity"], 0.9)
        self.assertAlmostEqual(by_id["b"].similarity, 0.89)
        self.assertEqual(by_id["b"].entry["_visualLanguageAdjustmentReasons"], [])
        self.assertEqual([match.entry["providerCardId"] for match in adjusted], ["b", "a"])

    def test_alt_row_of_other_card_must_beat_base_row_by_margin(self) -> None:
        # Card A's alt row is 0.01 closer than card B's base row: inside the
        # penalty, so B keeps top-1.
        cos_alt, cos_base = 0.90, 0.89
        matches, _ = self._run(
            [_base_entry("a"), _alt_entry("a", "111"), _base_entry("b")],
            [_unit(60), [cos_alt, float(np.sqrt(1 - cos_alt**2))], [cos_base, -float(np.sqrt(1 - cos_base**2))]],
            penalty=0.02,
        )
        self.assertEqual(matches[0].entry["providerCardId"], "b")
        self.assertIsNone(matched_variant_for_entry(matches[0].entry))

    def test_alt_row_that_genuinely_wins_reports_its_variant(self) -> None:
        matches, _ = self._run(
            [_base_entry("a"), _alt_entry("a", "527026"), _base_entry("b")],
            [_unit(40), _unit(5), _unit(30)],
            penalty=0.02,
        )
        self.assertEqual([m.entry["providerCardId"] for m in matches], ["a", "b"])
        winner = matches[0]
        self.assertEqual(winner.row_index, 1)
        self.assertAlmostEqual(winner.similarity, float(np.cos(np.deg2rad(5))) - 0.02, places=5)
        self.assertEqual(matched_variant_for_entry(winner.entry)["tcgplayerProductId"], "527026")

    def test_base_row_win_collapses_alt_row_and_reports_no_variant(self) -> None:
        matches, _ = self._run(
            [_base_entry("a"), _alt_entry("a", "527026"), _base_entry("b")],
            [_unit(2), _unit(20), _unit(50)],
            penalty=0.02,
        )
        self.assertEqual([m.entry["providerCardId"] for m in matches], ["a", "b"])
        self.assertEqual(matches[0].row_index, 0)
        self.assertIsNone(matched_variant_for_entry(matches[0].entry))

    def test_index_without_alt_rows_is_unchanged_by_penalty(self) -> None:
        entries = [_base_entry(f"sv{i}") for i in range(6)]
        embeddings = [_unit(angle) for angle in (3, 9, 14, 27, 33, 71)]
        with_penalty, _ = self._run(entries, embeddings, penalty=0.02)
        without_penalty, _ = self._run(entries, embeddings, penalty=0.0)
        self.assertEqual(
            [(m.row_index, m.similarity, m.entry) for m in with_penalty],
            [(m.row_index, m.similarity, m.entry) for m in without_penalty],
        )
        for match in with_penalty:
            self.assertEqual(match.entry["_visualLanguageAdjustmentReasons"], [])
            self.assertAlmostEqual(match.similarity, match.entry["_visualBaseSimilarity"], places=6)

    def test_penalty_default_and_env_override(self) -> None:
        class _FakeIndex:
            def __init__(self, *, npz_path: Path, manifest_path: Path) -> None:
                self.npz_path = npz_path
                self.manifest_path = manifest_path

            def is_available(self) -> bool:
                return True

        with patch.object(raw_visual_matcher_module, "RawVisualIndex", _FakeIndex):
            with patch.dict(raw_visual_matcher_module.os.environ, {}, clear=False) as env:
                env.pop("SPOTLIGHT_VISUAL_ALT_REFERENCE_PENALTY", None)
                self.assertEqual(RawVisualMatcher(repo_root=self.dir).alt_reference_penalty, 0.02)
            with patch.dict(
                raw_visual_matcher_module.os.environ,
                {"SPOTLIGHT_VISUAL_ALT_REFERENCE_PENALTY": "0.03"},
                clear=False,
            ):
                self.assertEqual(RawVisualMatcher(repo_root=self.dir).alt_reference_penalty, 0.03)


class _FakeImage:
    def save(self, *_args, **_kwargs) -> None:
        return None


class IncrementalRefreshAltRowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.conn = connect(self.dir / "catalog.sqlite")
        apply_schema(self.conn, BACKEND_ROOT / "schema.sql")

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def _add_card(self, card_id: str) -> None:
        upsert_card(
            self.conn,
            card_id=card_id,
            name=card_id.title(),
            set_name="Test Set",
            number="001/100",
            rarity="Rare",
            variant="Raw",
            language="English",
            supertype="Pokémon",
            image_url=f"https://images.scrydex.com/pokemon/{card_id}/large",
        )
        self.conn.commit()

    def test_card_with_only_alt_rows_still_needs_its_base_row(self) -> None:
        index = _write_index(
            self.dir,
            [_base_entry("old-1"), _alt_entry("old-1", "111"), _alt_entry("alt-only", "222")],
            [_unit(0), _unit(5), _unit(10)],
        )
        for card_id in ("old-1", "alt-only"):
            self._add_card(card_id)
        self.assertEqual(diff_missing_ids(index, self.conn), ["alt-only"])

    def test_append_preserves_alt_rows_and_their_fields(self) -> None:
        existing = [_base_entry("old-1"), _alt_entry("old-1", "111")]
        index = _write_index(self.dir, existing, [_unit(0), _unit(5)])
        self._add_card("old-1")
        self._add_card("new-1")

        result = append_missing_cards(
            index=index,
            connection=self.conn,
            embed_images_fn=lambda images: np.asarray([_unit(90)] * len(images), dtype=np.float32),
            model_id="test-model",
            download_image_fn=lambda _url: _FakeImage(),
        )

        self.assertTrue(result["changed"])
        self.assertEqual(result["added"], 1)
        self.assertEqual(index.entries[:2], existing)
        self.assertEqual(index.entries[2]["providerCardId"], "new-1")
        np.testing.assert_allclose(index.matrix[1], _unit(5), atol=1e-6)
        self.assertEqual(diff_missing_ids(index, self.conn), [])


if __name__ == "__main__":
    unittest.main()
