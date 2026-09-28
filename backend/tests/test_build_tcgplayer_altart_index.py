from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1].parent
TOOLS_ROOT = REPO_ROOT / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

try:
    import numpy as np  # noqa: E402
    import build_tcgplayer_altart_index as tool  # noqa: E402
    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host-python dependency fallback
    np = None  # type: ignore[assignment]
    tool = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


def _unit(values: list[float]) -> "np.ndarray":
    v = np.asarray(values, dtype=np.float32)
    return v / np.linalg.norm(v)


@unittest.skipIf(_IMPORT_ERROR is not None, f"numpy unavailable: {_IMPORT_ERROR}")
class BuildTcgplayerAltArtIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.images = Path(self.tmp.name)
        # base index: two cards, one row each
        self.base_entries = [
            {"rowIndex": 0, "providerCardId": "g~A-1", "name": "A", "artifactVersion": "v1"},
            {"rowIndex": 1, "providerCardId": "g~B-1", "name": "B", "artifactVersion": "v1"},
        ]
        self.base_matrix = np.stack([_unit([1, 0, 0, 0]), _unit([0, 1, 0, 0])])
        self.vectors = {
            "100": _unit([1, 0, 0, 0]),  # base product of A
            "101": _unit([1, 0.05, 0, 0]),  # same art as A (stamp)
            "102": _unit([0, 0, 1, 0]),  # genuine alt art of A
            "103": _unit([0, 0, 1, 0.01]),  # second product with the same alt art
            "104": _unit([0, 0, 0, 1]),  # "Foil" of B with unrelated art -> suspect mapping
            "105": _unit([1, 1, 0, 0]),  # card not in index
        }
        for pid in self.vectors:
            (self.images / f"{pid}.jpg").write_bytes(pid.encode())
        self.mapping = [
            {"card_id": "g~A-1", "product_id": "100", "variant_label": "Normal", "ordinal": 0, "tcgplayer_id": "100"},
            {"card_id": "g~A-1", "product_id": "101", "variant_label": "Winner Stamp", "ordinal": 1, "tcgplayer_id": "100"},
            {"card_id": "g~A-1", "product_id": "102", "variant_label": "Alt Art", "ordinal": 2, "tcgplayer_id": "100"},
            {"card_id": "g~A-1", "product_id": "103", "variant_label": "Alt Art Stamp", "ordinal": 3, "tcgplayer_id": "100"},
            {"card_id": "g~B-1", "product_id": "104", "variant_label": "Foil", "ordinal": 1, "tcgplayer_id": "200"},
            {"card_id": "g~Z-9", "product_id": "105", "variant_label": "Alt Art", "ordinal": 1, "tcgplayer_id": "300"},
            ["tcgp-sealed-1", 0, "106", "Normal", "106"],
        ]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _select(self, entries, matrix):
        candidates = tool.group_candidates(tool.load_mapping_rows(self.mapping))
        return tool.select_alt_art_rows(
            base_entries=entries,
            base_matrix=matrix,
            candidates=candidates,
            image_path_for=lambda pid: self.images / f"{pid}.jpg",
            embed_products=lambda pids: np.stack([self.vectors[p] for p in pids]),
            threshold=0.97,
            suspect_threshold=0.80,
            finish_only_labels=set(tool.DEFAULT_FINISH_ONLY_LABELS),
        )

    def test_selection_outcomes(self) -> None:
        result = self._select(self.base_entries, self.base_matrix)
        outcomes = {d.candidate.product_id: d.outcome for d in result.decisions}
        self.assertEqual(outcomes["100"], tool.SKIP_BASE)
        self.assertEqual(outcomes["101"], tool.SKIP_SAME_ART)
        self.assertEqual(outcomes["102"], tool.ADDED)
        self.assertEqual(outcomes["103"], tool.SKIP_DUP_PRODUCT)
        self.assertEqual(outcomes["104"], tool.SKIP_SUSPECT)
        self.assertEqual(outcomes["105"], tool.SKIP_NOT_IN_INDEX)
        self.assertEqual(outcomes["106"], tool.SKIP_SEALED)
        self.assertEqual([c.product_id for c, _ in result.added], ["102"])

    def test_assembly_and_idempotent_rerun(self) -> None:
        def build(entries, matrix, manifest):
            entries, matrix, _ = tool.strip_tcgplayer_rows(entries, matrix)
            result = self._select(entries, matrix)
            return tool.build_augmented_index(
                base_manifest=manifest,
                base_entries=entries,
                base_matrix=matrix,
                added=result.added,
                image_path_for=lambda pid: self.images / f"{pid}.jpg",
                version_suffix="+tcgp-test",
                augmentation_summary={"addedRowCount": len(result.added)},
            )

        manifest1, matrix1 = build(self.base_entries, self.base_matrix, {"artifactVersion": "v1", "entries": self.base_entries})
        self.assertEqual(matrix1.shape, (3, 4))
        self.assertEqual(matrix1.dtype, np.float32)
        self.assertTrue(np.array_equal(matrix1[:2], self.base_matrix))  # base rows untouched
        added = manifest1["entries"][2]
        self.assertEqual(added["providerCardId"], "g~A-1")
        self.assertEqual(added["rowIndex"], 2)
        self.assertEqual(added["referenceSource"], "tcgplayer")
        self.assertEqual(added["tcgplayerProductId"], "102")
        self.assertEqual(added["variantLabel"], "Alt Art")
        self.assertEqual(manifest1["artifactVersion"], "v1+tcgp-test")
        self.assertEqual(manifest1["entryCount"], 3)

        manifest2, matrix2 = build(manifest1["entries"], matrix1, manifest1)
        self.assertEqual(matrix2.shape, matrix1.shape)
        self.assertEqual(manifest2["artifactVersion"], "v1+tcgp-test")
        self.assertEqual([e["rowIndex"] for e in manifest2["entries"]], [0, 1, 2])

    def test_labels_merge_per_product(self) -> None:
        rows = tool.load_mapping_rows(
            [
                {"card_id": "g~A-1", "product_id": "7", "variant_label": "Normal", "ordinal": 2, "tcgplayer_id": "1"},
                {"card_id": "g~A-1", "product_id": "7", "variant_label": "Cold Foil", "ordinal": 1, "tcgplayer_id": "1"},
            ]
        )
        (candidate,) = tool.group_candidates(rows)
        self.assertEqual(candidate.label, "Cold Foil/Normal")
        self.assertEqual(candidate.ordinal, 1)
        self.assertTrue(tool.is_finish_only(candidate, set(tool.DEFAULT_FINISH_ONLY_LABELS)))


if __name__ == "__main__":
    unittest.main()
