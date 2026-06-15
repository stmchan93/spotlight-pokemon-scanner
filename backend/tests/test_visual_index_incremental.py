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
from visual_index_incremental import append_missing_cards, diff_missing_ids  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
