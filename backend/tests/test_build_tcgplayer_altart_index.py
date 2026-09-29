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
    import build_visual_artcrop_index as artcrop  # noqa: E402
    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host-python dependency fallback
    np = None  # type: ignore[assignment]
    tool = None  # type: ignore[assignment]
    artcrop = None  # type: ignore[assignment]
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

    def test_image_shape_guards(self) -> None:
        from PIL import Image

        sizes = {"102": (300, 419), "103": (1000, 573), "104": (600, 838)}
        for pid, size in sizes.items():
            Image.new("RGB", size, (int(pid) % 255, 0, 0)).save(self.images / f"{pid}.jpg")
        self.assertEqual(tool.image_size(self.images / "103.jpg"), (1000, 573))
        self.assertIsNone(tool.image_size(self.images / "100.jpg"))  # not a real image

        candidates = tool.group_candidates(tool.load_mapping_rows(self.mapping))
        result = tool.select_alt_art_rows(
            base_entries=self.base_entries,
            base_matrix=self.base_matrix,
            candidates=candidates,
            image_path_for=lambda pid: self.images / f"{pid}.jpg",
            embed_products=lambda pids: np.stack([self.vectors[p] for p in pids]),
            threshold=0.97,
            suspect_threshold=0.80,
            finish_only_labels=set(tool.DEFAULT_FINISH_ONLY_LABELS),
            image_size_for=lambda pid: tool.image_size(self.images / f"{pid}.jpg"),
            min_width=400,
        )
        decisions = {d.candidate.product_id: d for d in result.decisions}
        self.assertEqual(decisions["102"].outcome, tool.SKIP_LOW_RES)
        self.assertEqual(decisions["102"].note, "300x419")
        self.assertEqual(decisions["103"].outcome, tool.SKIP_PLACEHOLDER)
        self.assertEqual(decisions["103"].note, "landscape 1000x573")
        # normal portrait image still reaches the art comparison (Foil w/ unrelated art -> suspect)
        self.assertEqual(decisions["104"].outcome, tool.SKIP_SUSPECT)
        self.assertEqual(decisions["101"].outcome, tool.SKIP_MISSING_IMAGE)  # undecodable bytes
        self.assertEqual(result.added, [])


@unittest.skipIf(_IMPORT_ERROR is not None, f"numpy unavailable: {_IMPORT_ERROR}")
class ArtCropSidecarTests(unittest.TestCase):
    def setUp(self) -> None:
        from PIL import Image

        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.images = root / "img"
        self.images.mkdir()
        self.scrydex = root / "scry"
        (self.scrydex / "g").mkdir(parents=True)
        # A has base + 2 alt-art rows, B is single-row, C has base + 1 alt-art row.
        self.entries = [
            {"rowIndex": 0, "providerCardId": "g~A-1", "imageUrl": "https://x/A"},
            {"rowIndex": 1, "providerCardId": "g~B-1", "imageUrl": "https://x/B"},
            {"rowIndex": 2, "providerCardId": "g~C-1", "imageUrl": "https://x/C"},
            {"rowIndex": 3, "providerCardId": "g~A-1", "referenceSource": "tcgplayer", "tcgplayerProductId": "10"},
            {"rowIndex": 4, "providerCardId": "g~A-1", "referenceSource": "tcgplayer", "tcgplayerProductId": "11"},
            {"rowIndex": 5, "providerCardId": "g~C-1", "referenceSource": "tcgplayer", "tcgplayerProductId": "12"},
        ]
        self.manifest = {"artifactVersion": "g-v1+tcgp-test", "entries": self.entries}
        for i, cid in enumerate(("g~A-1", "g~B-1", "g~C-1")):
            Image.new("RGB", (630, 880), (40 * i, 10, 10)).save(self.scrydex / "g" / f"{cid}.img", format="PNG")
        for pid in ("10", "11", "12"):
            # white product-shot margin around a dark card body
            canvas = Image.new("RGB", (700, 1000), (255, 255, 255))
            canvas.paste(Image.new("RGB", (630, 880), (int(pid), 60, 60)), (35, 60))
            canvas.save(self.images / f"{pid}.jpg")
        self.loader = artcrop.ReferenceImages(game="g", images_dirs=[self.images], scrydex_cache=self.scrydex, download=False)
        self.embedded: list[tuple[str, tuple[int, int]]] = []

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _embed(self, keys, crops):
        self.embedded.extend((k, c.size) for k, c in zip(keys, crops))
        out = np.zeros((len(keys), 768), np.float32)
        for i, key in enumerate(keys):
            out[i, sum(map(ord, key)) % 768] = 3.0  # un-normalised on purpose
        return out

    def test_sidecar_contract(self) -> None:
        out = Path(self.tmp.name) / "idx" / artcrop.artcrop_path_for(Path("."), "g").name
        self.assertEqual(out.name, "visual_index_active_g_artcrop.npz")
        summary = artcrop.emit_artcrop(
            game="g", manifest=self.manifest, out_path=out, region=(0.1, 0.07, 0.9, 0.38),
            adapter_version="siglip2-384-v003-candidate", load_image=self.loader, embed_crops=self._embed,
        )
        self.assertEqual(summary["artRows"], 5)
        data = np.load(out, allow_pickle=False)
        self.assertEqual(sorted(data.files), ["adapter", "embeddings", "index_artifact_version", "region", "rows"])
        self.assertEqual(data["rows"].dtype, np.int32)
        self.assertEqual(data["rows"].tolist(), [0, 2, 3, 4, 5])  # single-row card B excluded
        self.assertEqual(data["embeddings"].dtype, np.float16)
        self.assertEqual(data["embeddings"].shape, (5, 768))
        np.testing.assert_allclose(np.linalg.norm(data["embeddings"].astype(np.float32), axis=1), 1.0, atol=1e-3)
        self.assertEqual(data["region"].dtype, np.float32)
        np.testing.assert_allclose(data["region"], [0.1, 0.07, 0.9, 0.38])
        self.assertEqual(data["adapter"].shape, ())
        self.assertEqual(str(data["adapter"]), "siglip2-384-v003-candidate")
        self.assertEqual(str(data["index_artifact_version"]), "g-v1+tcgp-test")
        # crops come from the 630x880 canvas: (0.1..0.9)*630 x (0.07..0.38)*880
        self.assertTrue(all(size == (504, 273) for _, size in self.embedded))
        self.assertEqual(sorted(k for k, _ in self.embedded),
                         ["scrydex:g~A-1", "scrydex:g~C-1", "tcgplayer:10", "tcgplayer:11", "tcgplayer:12"])

    def test_tcgplayer_margin_is_trimmed(self) -> None:
        from PIL import Image

        image = Image.open(self.images / "10.jpg")
        self.assertEqual(artcrop.card_edge_bbox(image), (35, 60, 665, 940))
        prepared = artcrop.prepare_reference(image, "tcgplayer")
        self.assertEqual(prepared.size, (630, 880))
        self.assertLess(prepared.getpixel((2, 2))[1], 120)  # corner is card body, not white margin

    def test_missing_image_fails_unless_allowed(self) -> None:
        (self.images / "11.jpg").unlink()
        out = Path(self.tmp.name) / "art.npz"
        kwargs = dict(game="g", manifest=self.manifest, out_path=out, region=None,
                      adapter_version="v", load_image=self.loader, embed_crops=self._embed)
        with self.assertRaises(SystemExit):
            artcrop.emit_artcrop(**kwargs)
        self.assertFalse(out.exists())
        artcrop.emit_artcrop(**{**kwargs, "region": (0, 0, 1, 1)}, allow_missing=True)
        self.assertEqual(np.load(out)["rows"].tolist(), [0, 2, 3, 5])

    def test_no_versions_writes_nothing_and_clears_stale_file(self) -> None:
        out = Path(self.tmp.name) / "art.npz"
        out.write_bytes(b"stale")
        manifest = {"artifactVersion": "v", "entries": self.entries[:3]}
        summary = artcrop.emit_artcrop(game="lorcana", manifest=manifest, out_path=out, region=None,
                                       adapter_version="v", load_image=self.loader, embed_crops=self._embed)
        self.assertEqual(summary["artRows"], 0)
        self.assertFalse(out.exists())
        self.assertEqual(self.embedded, [])

    def test_default_regions_and_adapter_version(self) -> None:
        self.assertEqual(artcrop.ARTCROP_REGIONS["onepiece"], (0.10, 0.07, 0.90, 0.38))
        self.assertEqual(artcrop.ARTCROP_REGIONS["gundam"], (0.15, 0.10, 0.90, 0.40))
        adapter = Path(self.tmp.name) / "raw_visual_adapter_x.pt"
        adapter.write_bytes(b"")
        adapter.with_name("raw_visual_adapter_x_metadata.json").write_text('{"artifactVersion": "x-v9"}')
        self.assertEqual(artcrop.adapter_artifact_version(adapter), "x-v9")
        self.assertTrue(tool.parse_args(["--game", "g", "--base-npz", "a", "--base-manifest", "b", "--mapping", "c",
                                         "--images-dir", "d", "--adapter", "e", "--out-dir", "f"]).emit_artcrop)


if __name__ == "__main__":
    unittest.main()
