from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from raw_visual_index import RawVisualIndex  # noqa: E402
from raw_visual_art_version import load_art_crop_index  # noqa: E402
from visual_index_incremental import (  # noqa: E402
    append_missing_cards,
    diff_missing_ids,
    is_excluded_from_visual_index,
    prune_excluded_rows,
    run_refresh,
)


def _write_index(npz_path: Path, manifest_path: Path, ids, embeddings) -> None:
    np.savez_compressed(npz_path, embeddings=np.asarray(embeddings, dtype=np.float32))
    entries = [{"rowIndex": i, "providerCardId": cid, "name": cid} for i, cid in enumerate(ids)]
    manifest_path.write_text(json.dumps({"entryCount": len(entries), "entries": entries}))


class _FakeImage:
    def save(self, *_args, **_kwargs) -> None:
        return None


class VisualIndexIncrementalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.npz = self.dir / "visual_index_active_test.npz"
        self.manifest = self.dir / "visual_index_active_manifest.json"
        # Existing index: one card "old-1" at the unit vector [0, 1, 0, 0].
        _write_index(self.npz, self.manifest, ["old-1"], [[0.0, 1.0, 0.0, 0.0]])
        self.index = RawVisualIndex(npz_path=self.npz, manifest_path=self.manifest)
        self.db_path = self.dir / "catalog.sqlite"
        self.conn = connect(self.db_path)
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

    @staticmethod
    def _embed(images) -> np.ndarray:
        # Deterministic unit vector per new image (content ignored in tests).
        return np.array([[1.0, 0.0, 0.0, 0.0]] * len(images), dtype=np.float32)

    def test_reload_swaps_in_new_index_without_restart(self) -> None:
        self.index.load()
        self.assertEqual(len(self.index.entries), 1)
        _write_index(
            self.npz, self.manifest, ["old-1", "x-2"],
            [[0.0, 1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]],
        )
        count = self.index.reload()
        self.assertEqual(count, 2)
        self.assertEqual([e["providerCardId"] for e in self.index.entries], ["old-1", "x-2"])

    def test_reload_keeps_old_index_on_bad_file(self) -> None:
        self.index.load()
        original = [e["providerCardId"] for e in self.index.entries]
        # Corrupt the manifest so reload's validation raises.
        self.manifest.write_text("{ not json")
        with self.assertRaises(Exception):
            self.index.reload()
        # Live index is untouched — no downtime.
        self.assertEqual([e["providerCardId"] for e in self.index.entries], original)

    def test_append_adds_missing_card_and_preserves_existing_rows(self) -> None:
        self._add_card("old-1")
        self._add_card("new-1")
        result = append_missing_cards(
            index=self.index,
            connection=self.conn,
            embed_images_fn=self._embed,
            model_id="test-model",
            download_image_fn=lambda _url: _FakeImage(),
        )
        self.assertTrue(result["changed"])
        self.assertEqual(result["added"], 1)
        self.assertEqual(result["skipped"], 0)
        self.assertEqual(result["entryCount"], 2)
        self.assertEqual([e["providerCardId"] for e in self.index.entries], ["old-1", "new-1"])
        # Existing row is byte-identical; new row is the embedded vector.
        np.testing.assert_allclose(self.index.matrix[0], [0.0, 1.0, 0.0, 0.0], atol=1e-6)
        np.testing.assert_allclose(self.index.matrix[1], [1.0, 0.0, 0.0, 0.0], atol=1e-6)
        # Nothing missing anymore.
        self.assertEqual(diff_missing_ids(self.index, self.conn), [])

    def test_append_is_noop_when_nothing_missing(self) -> None:
        self._add_card("old-1")
        result = append_missing_cards(
            index=self.index,
            connection=self.conn,
            embed_images_fn=self._embed,
            model_id="test-model",
            download_image_fn=lambda _url: _FakeImage(),
        )
        self.assertFalse(result["changed"])
        self.assertEqual(result["added"], 0)
        self.assertEqual(result["entryCount"], 1)

    def test_append_skips_on_download_failure_without_changing_index(self) -> None:
        self._add_card("old-1")
        self._add_card("new-1")

        def _boom(_url):
            raise RuntimeError("image CDN down")

        result = append_missing_cards(
            index=self.index,
            connection=self.conn,
            embed_images_fn=self._embed,
            model_id="test-model",
            download_image_fn=_boom,
        )
        self.assertFalse(result["changed"])
        self.assertEqual(result["added"], 0)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(result["entryCount"], 1)


class PerGameRefreshTests(unittest.TestCase):
    """The nightly refresh must reach the per-game indexes, not just Pokémon's."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.poke_npz = self.dir / "visual_index_active_test.npz"
        self.poke_manifest = self.dir / "visual_index_active_manifest.json"
        _write_index(self.poke_npz, self.poke_manifest, ["poke-1"], [[0.0, 1.0, 0.0, 0.0]])
        self.op_npz = self.dir / "visual_index_active_onepiece_test.npz"
        self.op_manifest = self.dir / "visual_index_active_onepiece_manifest.json"
        # One Piece index: base row + a TCGplayer alt-art row for the same card.
        np.savez_compressed(
            self.op_npz, embeddings=np.asarray([[0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]], dtype=np.float32)
        )
        self.op_manifest.write_text(json.dumps({
            "game": "onepiece",
            "entryCount": 2,
            "entries": [
                {"rowIndex": 0, "providerCardId": "onepiece~OP01-001", "game": "onepiece"},
                {"rowIndex": 1, "providerCardId": "onepiece~OP01-001", "game": "onepiece",
                 "referenceSource": "tcgplayer", "tcgplayerProductId": "111", "variantLabel": "Alt Art"},
            ],
        }))
        self.poke_index = RawVisualIndex(npz_path=self.poke_npz, manifest_path=self.poke_manifest)
        self.op_index = RawVisualIndex(npz_path=self.op_npz, manifest_path=self.op_manifest)
        self.conn = connect(self.dir / "catalog.sqlite")
        apply_schema(self.conn, BACKEND_ROOT / "schema.sql")
        self._add("poke-1", game="pokemon", supertype="Pokémon")
        self._add("onepiece~OP01-001", game="onepiece", supertype="Leader")
        self._add("onepiece~OP17-079", game="onepiece", supertype="Character")
        self._add("onepiece~OP17-001", game="onepiece", supertype="Leader")
        self._add("onepiece~OP17-BOX", game="onepiece", supertype="Sealed")
        self._add("tcgp-sealed-999", game="onepiece", supertype="")
        # Lorcana card with no Lorcana index on this box: must be ignored.
        self._add("lorcana~AOTV-1", game="lorcana", supertype="Character")

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def _add(self, card_id: str, *, game: str, supertype: str) -> None:
        upsert_card(
            self.conn,
            card_id=card_id,
            game=game,
            name=card_id,
            set_name="Test Set",
            number="001",
            rarity="Rare",
            variant="Raw",
            language="English",
            supertype=supertype,
            image_url=f"https://images.scrydex.com/x/{card_id}/large",
        )
        self.conn.commit()

    @staticmethod
    def _embed(images) -> np.ndarray:
        return np.array([[1.0, 0.0, 0.0, 0.0]] * len(images), dtype=np.float32)

    def _refresh(self, **kwargs):
        return run_refresh(
            index=self.poke_index,
            connection=self.conn,
            embed_images_fn=self._embed,
            model_id="test-model",
            download_image_fn=lambda _url: _FakeImage(),
            game_indexes={"onepiece": self.op_index, "lorcana": None},
            **kwargs,
        )

    def test_dry_run_reports_missing_per_game(self) -> None:
        result = self._refresh(dry_run=True)
        self.assertEqual(result["missing"], 0)
        self.assertEqual(result["games"]["onepiece"]["missing"], 2)
        self.assertEqual(
            sorted(result["games"]["onepiece"]["missingSample"]),
            ["onepiece~OP17-001", "onepiece~OP17-079"],
        )
        self.assertNotIn("lorcana", result["games"])

    def test_refresh_appends_missing_game_cards_to_that_game_only(self) -> None:
        poke_before = self.poke_npz.read_bytes()
        result = self._refresh()

        # Pokémon: nothing missing, artifacts untouched, top-level shape unchanged.
        self.assertFalse(result["changed"])
        self.assertEqual(result["entryCount"], 1)
        self.assertEqual(self.poke_npz.read_bytes(), poke_before)

        op = result["games"]["onepiece"]
        self.assertTrue(op["changed"])
        self.assertEqual(op["added"], 2)
        self.assertEqual(op["entryCount"], 4)
        entries = self.op_index.entries  # hot-reloaded in place
        ids = [e["providerCardId"] for e in entries]
        # Existing base + tcgplayer rows preserved in place; sealed never added.
        self.assertEqual(ids[:2], ["onepiece~OP01-001", "onepiece~OP01-001"])
        self.assertEqual(entries[1]["referenceSource"], "tcgplayer")
        self.assertEqual(sorted(ids[2:]), ["onepiece~OP17-001", "onepiece~OP17-079"])
        self.assertTrue(all(e["game"] == "onepiece" for e in entries[2:]))
        np.testing.assert_allclose(self.op_index.matrix[1], [0.0, 0.0, 0.0, 1.0], atol=1e-6)
        self.assertNotIn("onepiece~OP17-079", [e["providerCardId"] for e in self.poke_index.entries])

        # Second run is a no-op for every index.
        again = self._refresh()
        self.assertFalse(again["changed"])
        self.assertFalse(again["games"]["onepiece"]["changed"])

    def test_one_game_failing_does_not_block_the_others(self) -> None:
        self.op_manifest.write_text("{ not json")
        self._add("poke-2", game="pokemon", supertype="Trainer")
        result = self._refresh()
        self.assertTrue(result["changed"])
        self.assertEqual(result["added"], 1)
        self.assertIn("error", result["games"]["onepiece"])


class OnePieceDonExclusionTests(unittest.TestCase):
    """DON!! cards stay in the catalog but never in the One Piece scanner."""

    VERSION = "onepiece-v001+tcgp-altart"

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.poke_npz = self.dir / "visual_index_active_test.npz"
        self.poke_manifest = self.dir / "visual_index_active_manifest.json"
        _write_index(self.poke_npz, self.poke_manifest, ["poke-1"], [[0.0, 1.0, 0.0, 0.0]])
        self.op_npz = self.dir / "visual_index_active_onepiece_test.npz"
        self.op_manifest = self.dir / "visual_index_active_onepiece_manifest.json"
        self.art = self.dir / "visual_index_active_onepiece_artcrop.npz"
        # Rows: 0 base Luffy, 1 DON!! (tcgplayer-only), 2 Luffy alt art,
        # 3 DON!! by name only, 4 Zoro base, 5 Zoro alt art.
        self.entries = [
            {"rowIndex": 0, "providerCardId": "onepiece~OP01-001", "name": "Monkey.D.Luffy",
             "supertype": "Leader", "game": "onepiece"},
            {"rowIndex": 1, "providerCardId": "onepiece~tcgplayer-593814", "name": "DON!! Card",
             "supertype": "DON!!", "game": "onepiece", "catalogSource": "tcgplayer"},
            {"rowIndex": 2, "providerCardId": "onepiece~OP01-001", "name": "Monkey.D.Luffy",
             "supertype": "Leader", "game": "onepiece", "referenceSource": "tcgplayer",
             "tcgplayerProductId": "111", "variantLabel": "Alt Art"},
            {"rowIndex": 3, "providerCardId": "onepiece~tcgplayer-600000",
             "name": "DON!! Card // Green Compass", "supertype": None, "game": "onepiece"},
            {"rowIndex": 4, "providerCardId": "onepiece~OP01-025", "name": "Roronoa Zoro",
             "supertype": "Character", "game": "onepiece"},
            {"rowIndex": 5, "providerCardId": "onepiece~OP01-025", "name": "Roronoa Zoro",
             "supertype": "Character", "game": "onepiece", "referenceSource": "tcgplayer",
             "tcgplayerProductId": "222", "variantLabel": "Alt Art"},
        ]
        # Filler single-version rows 6..11 (keeps the prune under its 25% cap).
        self.entries += [
            {"rowIndex": i, "providerCardId": f"onepiece~ST01-{i:03d}", "name": f"Filler {i}",
             "supertype": "Character", "game": "onepiece"}
            for i in range(6, 12)
        ]
        rng = np.random.default_rng(7)
        self.matrix = rng.standard_normal((12, 4)).astype(np.float32)
        np.savez_compressed(self.op_npz, embeddings=self.matrix)
        self.op_manifest.write_text(json.dumps({
            "game": "onepiece", "artifactVersion": self.VERSION, "modelId": "m",
            "entryCount": 12, "entries": self.entries,
        }))
        # Art sidecar covers the multi-version cards: Luffy rows 0,2 and Zoro 4,5.
        self.art_embeddings = rng.standard_normal((4, 3)).astype(np.float16)
        np.savez(
            self.art,
            rows=np.asarray([0, 2, 4, 5], dtype=np.int32),
            embeddings=self.art_embeddings,
            region=np.asarray([0.1, 0.1, 0.9, 0.6], dtype=np.float32),
            adapter=np.array("adapter-v003"),
            index_artifact_version=np.array(self.VERSION),
        )
        self.poke_index = RawVisualIndex(npz_path=self.poke_npz, manifest_path=self.poke_manifest)
        self.op_index = RawVisualIndex(npz_path=self.op_npz, manifest_path=self.op_manifest)
        self.conn = connect(self.dir / "catalog.sqlite")
        apply_schema(self.conn, BACKEND_ROOT / "schema.sql")
        self._add("poke-1", game="pokemon", name="DON!! Pikachu", supertype="Pokémon")
        self._add("onepiece~OP01-001", game="onepiece", name="Monkey.D.Luffy", supertype="Leader")
        self._add("onepiece~OP01-025", game="onepiece", name="Roronoa Zoro", supertype="Character")
        self._add("onepiece~tcgplayer-593814", game="onepiece", name="DON!! Card", supertype="DON!!")
        self._add("onepiece~tcgplayer-600000", game="onepiece", name="DON!! Card // Green Compass", supertype="")
        self._add("onepiece~tcgplayer-700000", game="onepiece", name="DON!! Card", supertype="DON!!")

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def _add(self, card_id: str, *, game: str, name: str, supertype: str) -> None:
        upsert_card(
            self.conn, card_id=card_id, game=game, name=name, set_name="Test Set", number="001",
            rarity="Rare", variant="Raw", language="English", supertype=supertype,
            image_url=f"https://images.example.com/{card_id}.jpg",
        )
        self.conn.commit()

    def _refresh(self, **kwargs):
        return run_refresh(
            index=self.poke_index,
            connection=self.conn,
            embed_images_fn=lambda images: np.ones((len(images), 4), dtype=np.float32),
            model_id="test-model",
            download_image_fn=lambda _url: _FakeImage(),
            game_indexes={"onepiece": self.op_index},
            **kwargs,
        )

    def test_predicate_is_one_piece_only(self) -> None:
        self.assertTrue(is_excluded_from_visual_index({"name": "DON!! Card", "supertype": "DON!!"}, "onepiece"))
        self.assertTrue(is_excluded_from_visual_index({"name": "x", "supertype": "DON!!"}, "onepiece"))
        self.assertTrue(is_excluded_from_visual_index({"name": "DON!! Card // Promo"}, "onepiece"))
        self.assertFalse(is_excluded_from_visual_index({"name": "Donquixote Doflamingo"}, "onepiece"))
        self.assertFalse(is_excluded_from_visual_index({"name": "DON!! Card", "supertype": "DON!!"}, "pokemon"))
        self.assertFalse(is_excluded_from_visual_index({"name": "DON!! Card", "supertype": "DON!!"}, None))

    def test_diff_skips_don_cards(self) -> None:
        dry = self._refresh(dry_run=True)
        op = dry["games"]["onepiece"]
        self.assertEqual(op["missing"], 0)  # tcgplayer-700000 is DON!!: never "missing"
        self.assertEqual(op["wouldPrune"], 2)
        self.assertEqual(dry["wouldPrune"], 0)
        self.assertEqual(diff_missing_ids(self.op_index, self.conn, game="onepiece"), [])
        # Pokémon keeps its own eligibility; a Pokémon name starting "DON!!" is untouched.
        self.assertEqual(diff_missing_ids(self.poke_index, self.conn), [])

    def test_refresh_prunes_don_rows_and_remaps_art_sidecar(self) -> None:
        poke_before = (self.poke_npz.read_bytes(), self.poke_manifest.read_bytes())
        result = self._refresh()

        self.assertEqual(result["pruned"], 0)
        self.assertEqual((self.poke_npz.read_bytes(), self.poke_manifest.read_bytes()), poke_before)

        op = result["games"]["onepiece"]
        self.assertTrue(op["changed"])
        self.assertEqual(op["pruned"], 2)
        self.assertEqual(op["added"], 0)
        self.assertEqual(op["artCrop"], "remapped")
        self.assertEqual(op["entryCount"], 10)

        # Kept rows: old 0, 2, 4..11 -> new 0..9, embeddings byte-identical,
        # entries identical apart from the renumbered rowIndex.
        kept = [0, 2] + list(range(4, 12))
        raw = np.load(self.op_npz)["embeddings"]
        self.assertEqual(raw.dtype, np.float32)
        self.assertEqual(raw.tobytes(), self.matrix[kept].tobytes())
        manifest = json.loads(self.op_manifest.read_text())
        self.assertEqual(manifest["entryCount"], 10)
        for new, old in enumerate(kept):
            expected = dict(self.entries[old], rowIndex=new)
            self.assertEqual(manifest["entries"][new], expected)
        self.assertTrue(manifest["artifactVersion"].startswith(self.VERSION + "+pruned-"))
        self.assertEqual(manifest["lastPruneRemovedCount"], 2)
        self.assertEqual(manifest["modelId"], "m")
        self.assertTrue(Path(str(self.op_npz) + ".pre-prune.bak").exists())
        self.assertEqual(self.op_index.artifact_version, manifest["artifactVersion"])
        self.assertNotIn("DON!! Card", [e.get("name") for e in self.op_index.entries])

        # Art sidecar: rows renumbered, embeddings untouched, stamped with the new
        # version, and it still validates against the hot-reloaded index.
        with np.load(self.art) as art:
            self.assertEqual(art["rows"].tolist(), [0, 1, 2, 3])
            self.assertEqual(art["rows"].dtype, np.int32)
            self.assertEqual(art["embeddings"].tobytes(), self.art_embeddings.tobytes())
            self.assertEqual(str(art["index_artifact_version"].item()), manifest["artifactVersion"])
        logs: list = []
        loaded = load_art_crop_index(
            self.art,
            index_artifact_version=self.op_index.artifact_version,
            adapter_version="adapter-v003",
            entries=self.op_index.entries,
            log=lambda *a, **k: logs.append((a, k)),
            game="onepiece",
        )
        self.assertIsNotNone(loaded, logs)
        self.assertEqual(loaded.rows_by_card, {"onepiece~OP01-001": [0, 1], "onepiece~OP01-025": [2, 3]})

        # Second run: nothing to prune, no DON re-added, artifacts untouched.
        before = (self.op_npz.read_bytes(), self.art.read_bytes())
        again = self._refresh()
        self.assertFalse(again["games"]["onepiece"]["changed"])
        self.assertEqual(again["games"]["onepiece"]["pruned"], 0)
        self.assertEqual((self.op_npz.read_bytes(), self.art.read_bytes()), before)

    def test_old_sidecar_is_rejected_by_pruned_index(self) -> None:
        old_art = self.art.read_bytes()
        prune_excluded_rows(index=self.op_index, game="onepiece")
        # A process still holding the pre-prune sidecar must skip the art rule,
        # not read shifted rows.
        stale = self.dir / "stale_artcrop.npz"
        stale.write_bytes(old_art)
        logs: list = []
        loaded = load_art_crop_index(
            stale,
            index_artifact_version=self.op_index.artifact_version,
            adapter_version="adapter-v003",
            entries=self.op_index.entries,
            log=lambda *a, **k: logs.append(k.get("reason")),
            game="onepiece",
        )
        self.assertIsNone(loaded)
        self.assertIn("index_version_mismatch", logs)

    def test_stale_sidecar_is_left_alone(self) -> None:
        np.savez(
            self.art,
            rows=np.asarray([0, 2], dtype=np.int32),
            embeddings=self.art_embeddings[:2],
            region=np.asarray([0.1, 0.1, 0.9, 0.6], dtype=np.float32),
            adapter=np.array("adapter-v003"),
            index_artifact_version=np.array("some-older-index"),
        )
        before = self.art.read_bytes()
        result = prune_excluded_rows(index=self.op_index, game="onepiece")
        self.assertEqual(result["pruned"], 2)
        self.assertEqual(result["artCrop"], "stale_left_disabled")
        self.assertEqual(self.art.read_bytes(), before)

    def test_missing_sidecar_still_prunes(self) -> None:
        self.art.unlink()
        result = prune_excluded_rows(index=self.op_index, game="onepiece")
        self.assertEqual(result["pruned"], 2)
        self.assertEqual(result["artCrop"], "missing")
        self.assertEqual(len(self.op_index.entries), 10)

    def test_prune_refuses_to_gut_the_index(self) -> None:
        entries = [dict(e, name="DON!! Card", supertype="DON!!") for e in self.entries]
        self.op_manifest.write_text(json.dumps({"artifactVersion": self.VERSION, "entries": entries}))
        self.op_index.reload()
        before = self.op_npz.read_bytes()
        with self.assertRaises(RuntimeError):
            prune_excluded_rows(index=self.op_index, game="onepiece")
        self.assertEqual(self.op_npz.read_bytes(), before)

    def _write_all_cards_art(self, rows: list[int], version: str) -> np.ndarray:
        edges = np.stack([np.full(1536, r, dtype=np.int8) for r in rows])
        np.savez(
            self.art,
            rows=np.asarray(rows, dtype=np.int32),
            embeddings=np.eye(len(rows), 4, dtype=np.float16),
            region=np.asarray([0.1, 0.1, 0.9, 0.6], dtype=np.float32),
            adapter=np.array("adapter-v003"),
            index_artifact_version=np.array(version),
            coverage=np.array("all_cards"),
            edge_maps=edges,
        )
        return edges

    def test_prune_remaps_edge_maps_with_rows(self) -> None:
        self._write_all_cards_art(list(range(12)), self.VERSION)
        result = prune_excluded_rows(index=self.op_index, game="onepiece")
        self.assertEqual(result["artCrop"], "remapped")
        kept = [0, 2] + list(range(4, 12))
        with np.load(self.art) as art:
            self.assertEqual(art["rows"].tolist(), list(range(10)))
            self.assertEqual(art["edge_maps"][:, 0].tolist(), kept)  # each map followed its row
            self.assertEqual(str(art["coverage"].item()), "all_cards")

    def _append_new_card(self):
        from PIL import Image

        self._add("onepiece~OP02-001", game="onepiece", name="Edward.Newgate", supertype="Leader")
        return append_missing_cards(
            index=self.op_index,
            connection=self.conn,
            embed_images_fn=lambda images: np.full((len(images), 4), 2.0, dtype=np.float32),
            model_id="m",
            download_image_fn=lambda _url: Image.new("RGB", (630, 880), (90, 20, 20)),
            image_cache_root=self.dir / "refs",
            game="onepiece",
        )

    def test_append_extends_all_cards_sidecar(self) -> None:
        prune_excluded_rows(index=self.op_index, game="onepiece")
        edges_before = self._write_all_cards_art(list(range(10)), str(self.op_index.artifact_version))
        result = self._append_new_card()
        self.assertEqual(result["added"], 1)
        self.assertEqual(result["artCropAppend"], "appended")
        with np.load(self.art) as art:
            self.assertEqual(art["rows"].tolist(), list(range(11)))
            self.assertEqual(art["embeddings"].shape, (11, 4))
            np.testing.assert_allclose(art["embeddings"][10].astype(np.float32), [0.5] * 4, atol=1e-3)
            self.assertEqual(art["edge_maps"].shape, (11, 1536))
            self.assertEqual(art["edge_maps"][:10].tobytes(), edges_before.tobytes())
        loaded = load_art_crop_index(
            self.art,
            index_artifact_version=self.op_index.artifact_version,
            adapter_version="adapter-v003",
            entries=self.op_index.entries,
            log=lambda *a, **k: None,
            game="onepiece",
        )
        self.assertTrue(loaded.supports_card_rerank)
        self.assertIn("onepiece~OP02-001", loaded.card_rows)

    def test_append_leaves_version_only_sidecar_alone(self) -> None:
        prune_excluded_rows(index=self.op_index, game="onepiece")
        before = self.art.read_bytes()
        result = self._append_new_card()
        self.assertEqual(result["added"], 1)
        self.assertEqual(result["artCropAppend"], "not_all_cards")
        self.assertEqual(self.art.read_bytes(), before)


class ServiceRefreshWiringTests(unittest.TestCase):
    def test_service_passes_every_non_pokemon_game_index(self) -> None:
        from types import SimpleNamespace
        from unittest.mock import patch

        from server import SpotlightScanService

        seen: list[str] = []

        def _index_for_game(game):
            seen.append(game)
            return f"index-{game}"

        matcher = SimpleNamespace(
            index="pokemon-index",
            index_for_game=_index_for_game,
            embed_reference_images=lambda images: None,
            model_id="m",
        )
        service = SimpleNamespace(
            _raw_visual_matcher_instance=lambda: matcher,
            connection=None,
            _emit_structured_log=lambda payload: None,
        )
        with patch("visual_index_incremental.run_refresh", return_value={"ok": True}) as fake:
            SpotlightScanService.refresh_visual_index(service, dry_run=True)
        kwargs = fake.call_args.kwargs
        self.assertEqual(kwargs["index"], "pokemon-index")
        self.assertNotIn("pokemon", kwargs["game_indexes"])
        self.assertEqual(
            kwargs["game_indexes"],
            {"onepiece": "index-onepiece", "lorcana": "index-lorcana",
             "riftbound": "index-riftbound", "gundam": "index-gundam"},
        )


if __name__ == "__main__":
    unittest.main()
