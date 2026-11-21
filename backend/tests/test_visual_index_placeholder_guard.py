"""Duplicate-bytes placeholder guard, auto-flagging, and in-place re-embed."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import visual_index_placeholders as placeholders  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from raw_visual_index import RawVisualIndex  # noqa: E402
from visual_index_incremental import append_missing_cards, reembed_cards  # noqa: E402
from visual_index_placeholders import (  # noqa: E402
    KNOWN_CARD_BACK_SHA256,
    REFERENCE_HASH_INDEX_FILENAME,
    ReferenceImageHashes,
    remove_from_denylist,
    sha256_hex,
)


def _image(color: tuple[int, int, int]) -> Image.Image:
    return Image.new("RGB", (8, 8), color)


def _png_sha(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return sha256_hex(buffer.getvalue())


def _embed(images) -> np.ndarray:
    # Content-dependent so a replaced row is distinguishable from the old one.
    return np.asarray(
        [[*(np.asarray(img).reshape(-1, 3).mean(axis=0) / 255.0), 1.0] for img in images], dtype=np.float32
    )


CARD_BACK = _image((10, 20, 200))
RED, GREEN, BLUE, GOLD = _image((220, 0, 0)), _image((0, 220, 0)), _image((0, 0, 220)), _image((200, 180, 0))


class _Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.npz = self.dir / "visual_index_active_test.npz"
        self.manifest = self.dir / "visual_index_active_manifest.json"
        self.cache = self.dir / ".cache" / "reference_images"
        self.cache.mkdir(parents=True)
        self.denylist = self.dir / "placeholder_card_ids.json"
        self.conn = connect(self.dir / "catalog.sqlite")
        apply_schema(self.conn, BACKEND_ROOT / "schema.sql")
        self.images: dict[str, Image.Image] = {}

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def _card(self, card_id: str, name: str) -> None:
        upsert_card(
            self.conn,
            card_id=card_id,
            name=name,
            set_name="Test Set",
            number="1",
            rarity="Rare",
            variant="Raw",
            language="English",
            supertype="Pokémon",
            image_url=f"https://images.scrydex.com/pokemon/{card_id}/large",
        )
        self.conn.commit()

    def _index(self, rows: dict[str, Image.Image]) -> RawVisualIndex:
        """Active index whose rows were embedded from (and cached as) `rows`."""
        ids = list(rows)
        np.savez_compressed(self.npz, embeddings=_embed(list(rows.values())))
        entries = [{"rowIndex": i, "providerCardId": cid, "name": cid} for i, cid in enumerate(ids)]
        self.manifest.write_text(
            json.dumps({"artifactVersion": "v-test", "entryCount": len(entries), "entries": entries})
        )
        for cid, image in rows.items():
            image.save(self.cache / f"{cid}.png")
        return RawVisualIndex(npz_path=self.npz, manifest_path=self.manifest)

    def _download(self, url: str) -> Image.Image:
        card_id = url.split("/pokemon/")[1].split("/")[0]
        return self.images[card_id]

    def _append(self, index: RawVisualIndex) -> dict:
        return append_missing_cards(
            index=index,
            connection=self.conn,
            embed_images_fn=_embed,
            model_id="test-model",
            download_image_fn=self._download,
        )

    def _denylist(self) -> dict:
        return json.loads(self.denylist.read_text()) if self.denylist.exists() else {}


class GuardTests(_Fixture):
    def test_new_card_back_hash_is_known(self) -> None:
        self.assertIn("503854c5405b9ee345438d19c80839211dc21690f41848e9ef70c03156b788e0", KNOWN_CARD_BACK_SHA256)

    def test_rejects_image_identical_to_a_different_cards_cached_image(self) -> None:
        index = self._index({"me55-R": CARD_BACK})
        self._card("me55-R", "Mew")
        self._card("mep-120", "Celebratory Fanfare")
        self.images["mep-120"] = CARD_BACK
        logs: list[str] = []
        result = append_missing_cards(
            index=index, connection=self.conn, embed_images_fn=_embed, model_id="m",
            download_image_fn=self._download, logger=lambda _sev, msg: logs.append(msg),
        )
        self.assertFalse(result["changed"])
        self.assertEqual(result["skippedIds"], ["mep-120"])
        self.assertFalse((self.cache / "mep-120.png").exists())
        self.assertEqual(len(index.entries), 1)
        self.assertTrue(any("reference_rejected" in m and "shared_across_different_cards" in m for m in logs))
        # The cached partner is a placeholder too: denylisted + hash learned.
        self.assertIn("me55-R", self._denylist()["cardIds"])
        self.assertIn(_png_sha(CARD_BACK), self._denylist()["placeholderImageSha256"])
        self.assertIn("me55-R", index.denylist_ids)

    def test_rejects_known_card_back_hash(self) -> None:
        index = self._index({"old-1": RED})
        self._card("old-1", "Old")
        self._card("new-1", "New")
        self.images["new-1"] = CARD_BACK
        with mock.patch.object(placeholders, "KNOWN_CARD_BACK_SHA256", frozenset({_png_sha(CARD_BACK)})):
            result = self._append(index)
        self.assertFalse(result["changed"])
        self.assertEqual(result["skippedIds"], ["new-1"])

    def test_rejects_learned_placeholder_hash_from_denylist(self) -> None:
        index = self._index({"old-1": RED})
        self.denylist.write_text(json.dumps({"cardIds": [], "placeholderImageSha256": [_png_sha(GOLD)]}))
        self._card("old-1", "Old")
        self._card("new-1", "New")
        self.images["new-1"] = GOLD
        self.assertEqual(self._append(index)["skippedIds"], ["new-1"])

    def test_accepts_unique_image_and_records_its_hash(self) -> None:
        index = self._index({"old-1": RED})
        self._card("old-1", "Old")
        self._card("new-1", "New")
        self.images["new-1"] = GREEN
        result = self._append(index)
        self.assertEqual(result["added"], 1)
        self.assertEqual(result["flagged"], [])
        self.assertEqual(_png_sha(Image.open(self.cache / "new-1.png")), _png_sha(GREEN))
        stored = json.loads((self.cache / REFERENCE_HASH_INDEX_FILENAME).read_text())["files"]
        self.assertEqual(stored["new-1"][2], _png_sha(GREEN))

    def test_rejected_card_is_retried_and_indexed_once_real_art_appears(self) -> None:
        index = self._index({"me55-R": CARD_BACK})
        self._card("me55-R", "Mew")
        self._card("mep-120", "Celebratory Fanfare")
        self.images["mep-120"] = CARD_BACK
        self.assertEqual(self._append(index)["added"], 0)
        self.images["mep-120"] = GOLD  # Scrydex publishes the front
        result = self._append(index)
        self.assertEqual(result["added"], 1)
        self.assertEqual([e["providerCardId"] for e in index.entries], ["me55-R", "mep-120"])

    def test_same_name_reprint_pair_is_allowed_but_a_third_copy_is_not(self) -> None:
        index = self._index({"tcgp-B4-20": RED})
        self._card("tcgp-B4-20", "Ponyta")
        self._card("tcgp-B4b-34", "Ponyta")
        self.images["tcgp-B4b-34"] = RED
        self.assertEqual(self._append(index)["added"], 1)
        self.assertNotIn("tcgp-B4-20", self._denylist().get("cardIds", []))

        self._card("tcgp-X-1", "Ponyta")
        self.images["tcgp-X-1"] = RED
        result = self._append(index)
        self.assertEqual(result["skippedIds"], ["tcgp-X-1"])
        self.assertEqual(sorted(f["cardId"] for f in result["flagged"]), ["tcgp-B4-20", "tcgp-B4b-34"])

    def test_flagging_existing_duplicates_keeps_manual_denylist_entries(self) -> None:
        index = self._index({"m6a_ja-119": BLUE, "m6a_ja-121": BLUE, "ok-1": RED})
        for cid, name in (("m6a_ja-119", "Kommo-o"), ("m6a_ja-121", "Ditto"), ("ok-1", "Ok")):
            self._card(cid, name)
        self.denylist.write_text(json.dumps({"cardIds": ["mcd14-1"], "manualAdditions": {"note": "keep"}}))
        result = self._append(index)
        payload = self._denylist()
        self.assertEqual(payload["cardIds"], ["m6a_ja-119", "m6a_ja-121", "mcd14-1"])
        self.assertEqual(payload["manualAdditions"], {"note": "keep"})
        self.assertEqual({r["reason"] for r in payload["autoFlagged"]}, {"shared_across_different_cards"})
        self.assertEqual(len(result["flagged"]), 2)
        # Search skips them without a restart.
        hits = {m.entry["providerCardId"] for m in index.search(np.array([0.0, 0.0, 0.86, 1.0]), top_k=3)}
        self.assertEqual(hits, {"ok-1"})

    def test_hash_index_only_rehashes_changed_files(self) -> None:
        RED.save(self.cache / "a.png")
        GREEN.save(self.cache / "b.png")
        ReferenceImageHashes.load(self.cache).save()
        with mock.patch.object(placeholders, "_file_sha256", wraps=placeholders._file_sha256) as hashed:
            hashes = ReferenceImageHashes.load(self.cache)
        self.assertEqual(hashed.call_count, 0)
        self.assertEqual(hashes.sha_for("a"), _png_sha(RED))


class ReembedTests(_Fixture):
    def setUp(self) -> None:
        super().setUp()
        # As on prod: the card back these rows were cached from is a known hash.
        patcher = mock.patch.object(placeholders, "KNOWN_CARD_BACK_SHA256", frozenset({_png_sha(CARD_BACK)}))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.index = self._index({"a-1": RED, "me55-R": CARD_BACK, "me55-G": CARD_BACK, "c-1": GREEN})
        for cid, name in (("a-1", "A"), ("me55-R", "Mew"), ("me55-G", "Mew"), ("c-1", "C")):
            self._card(cid, name)
        self.denylist.write_text(
            json.dumps({"cardIds": ["mcd14-1", "me55-G", "me55-R"], "manualAdditions": {"note": "keep"}})
        )
        self.before_npz = self.npz.read_bytes()
        self.before_manifest = self.manifest.read_text()

    def _reembed(self, ids, **kwargs) -> dict:
        return reembed_cards(
            index=self.index,
            connection=self.conn,
            card_ids=ids,
            embed_images_fn=_embed,
            model_id="test-model",
            download_image_fn=self._download,
            backup_suffix=".bak-test",
            **kwargs,
        )

    def test_replaces_exactly_the_target_rows_and_writes_backup(self) -> None:
        self.images["me55-R"] = GOLD
        old = np.load(self.npz)["embeddings"].copy()
        result = self._reembed(["me55-R"])
        self.assertEqual(result["replaced"], 1)
        card = result["cards"][0]
        self.assertEqual((card["oldSha256"], card["newSha256"]), (_png_sha(CARD_BACK), _png_sha(GOLD)))
        new = np.load(self.npz)["embeddings"]
        self.assertEqual(new.shape, old.shape)
        np.testing.assert_array_equal(new[[0, 2, 3]], old[[0, 2, 3]])
        np.testing.assert_allclose(new[1], _embed([GOLD])[0])
        manifest = json.loads(self.manifest.read_text())
        self.assertEqual(manifest["entryCount"], 4)
        self.assertEqual(manifest["artifactVersion"], "v-test")
        self.assertEqual([e["providerCardId"] for e in manifest["entries"]], ["a-1", "me55-R", "me55-G", "c-1"])
        self.assertEqual(Path(str(self.npz) + ".bak-test").read_bytes(), self.before_npz)
        self.assertEqual(Path(str(self.manifest) + ".bak-test").read_text(), self.before_manifest)
        self.assertEqual(_png_sha(Image.open(self.cache / "me55-R.png")), _png_sha(GOLD))
        # Denylist untouched without the flag.
        self.assertIn("me55-R", self._denylist()["cardIds"])

    def test_dry_run_changes_nothing(self) -> None:
        self.images["me55-R"] = GOLD
        cached_before = (self.cache / "me55-R.png").read_bytes()
        result = self._reembed(["me55-R"], dry_run=True, remove_from_denylist_on_success=True)
        self.assertEqual(result["cards"][0]["status"], "would_replace")
        self.assertEqual(self.npz.read_bytes(), self.before_npz)
        self.assertEqual(self.manifest.read_text(), self.before_manifest)
        self.assertFalse(Path(str(self.npz) + ".bak-test").exists())
        self.assertEqual((self.cache / "me55-R.png").read_bytes(), cached_before)
        self.assertIn("me55-R", self._denylist()["cardIds"])
        self.assertFalse((self.cache / REFERENCE_HASH_INDEX_FILENAME).exists())

    def test_still_a_card_back_is_rejected_and_row_kept(self) -> None:
        self.images["me55-R"] = CARD_BACK  # Scrydex still serves the back
        result = self._reembed(["me55-R"], remove_from_denylist_on_success=True)
        self.assertEqual(result["cards"][0]["status"], "rejected")
        self.assertEqual(result["replaced"], 0)
        self.assertEqual(self.npz.read_bytes(), self.before_npz)
        self.assertIn("me55-R", self._denylist()["cardIds"])

    def test_denylist_removal_only_removes_reembedded_ids(self) -> None:
        self.images["me55-R"] = GOLD
        self.images["me55-G"] = CARD_BACK
        result = self._reembed(["me55-R", "me55-G", "not-indexed"], remove_from_denylist_on_success=True)
        self.assertEqual([c["status"] for c in result["cards"]], ["replaced", "rejected", "not_in_index"])
        self.assertEqual(result["denylistRemoved"], ["me55-R"])
        payload = self._denylist()
        self.assertEqual(payload["cardIds"], ["mcd14-1", "me55-G"])
        self.assertEqual(payload["manualAdditions"], {"note": "keep"})
        self.assertNotIn("me55-R", self.index.denylist_ids)

    def test_remove_from_denylist_helper_leaves_other_ids(self) -> None:
        self.assertEqual(remove_from_denylist(self.denylist, ["me55-R", "absent"]), ["me55-R"])
        self.assertEqual(self._denylist()["cardIds"], ["mcd14-1", "me55-G"])


if __name__ == "__main__":
    unittest.main()
