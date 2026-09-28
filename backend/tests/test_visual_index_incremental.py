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
from visual_index_incremental import append_missing_cards, diff_missing_ids, run_refresh  # noqa: E402


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
