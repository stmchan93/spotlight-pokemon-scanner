from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
for path in (BACKEND_ROOT, REPO_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from tools.build_card_language_links import (  # noqa: E402
    CardMeta,
    build_candidate_index,
    build_links,
    prune_candidates,
    select_counterpart,
)


class LinkerCoreTests(unittest.TestCase):
    def _meta(self, cid, lang, name="charizard", artist="arita", dex=(6,), reg=None):
        return CardMeta(cid, lang, name, artist, frozenset(dex), reg)

    def test_prune_matches_other_language_same_name_artist(self) -> None:
        en = self._meta("en", "English")
        jp = self._meta("jp", "Japanese")
        other_artist = self._meta("jp2", "Japanese", artist="someone-else")
        same_lang = self._meta("en2", "English")
        index = build_candidate_index([en, jp, other_artist, same_lang])
        pruned = prune_candidates(en, index)
        self.assertEqual([c.card_id for c in pruned], ["jp"])

    def test_prune_excludes_on_pokedex_and_regmark_conflict(self) -> None:
        en = self._meta("en", "English", dex=(6,), reg="g")
        jp_dex_conflict = self._meta("jp1", "Japanese", dex=(7,), reg="g")
        jp_reg_conflict = self._meta("jp2", "Japanese", dex=(6,), reg="h")
        jp_ok = self._meta("jp3", "Japanese", dex=(6,), reg="g")
        index = build_candidate_index([en, jp_dex_conflict, jp_reg_conflict, jp_ok])
        self.assertEqual([c.card_id for c in prune_candidates(en, index)], ["jp3"])

    def test_select_counterpart_respects_threshold_and_tiebreak(self) -> None:
        # Below threshold → no link.
        self.assertEqual(select_counterpart(["a"], {"a": 0.5}, threshold=0.9), (None, None))
        # Highest above threshold wins.
        self.assertEqual(select_counterpart(["a", "b"], {"a": 0.91, "b": 0.95}, threshold=0.9), ("b", 0.95))
        # Equal scores → lowest id (deterministic).
        self.assertEqual(select_counterpart(["b", "a"], {"a": 0.95, "b": 0.95}, threshold=0.9), ("a", 0.95))


class LinkerBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        db = Path(self.tempdir.name) / "linker.sqlite"
        con = connect(db)
        apply_schema(con, BACKEND_ROOT / "schema.sql")
        con.close()
        self.conn = connect(db)
        # EN Charizard + two JP candidates (one close art, one different) + a lonely EN card.
        for cid, lang in (("en-char", "English"), ("jp-char-a", "Japanese"), ("jp-char-b", "Japanese")):
            self._card(cid, "Charizard", lang, artist="Mitsuhiro Arita")
        self._card("en-lonely", "Lonely Promo", "English", artist="Someone")

    def tearDown(self) -> None:
        self.conn.close()
        self.tempdir.cleanup()

    def _card(self, cid, name, lang, artist):
        upsert_card(
            self.conn, card_id=cid, name=name, set_name="S", number="4",
            rarity="Rare", variant="Raw", language=lang, source_provider="scrydex",
            source_record_id=cid, set_id="s", set_ptcgo_code="S", set_release_date="1999-01-09",
            artist=artist, national_pokedex_numbers=[6] if name == "Charizard" else [],
            source_payload={"id": cid},
        )
        self.conn.commit()

    def test_build_links_writes_thresholded_bidirectional_rows(self) -> None:
        # jp-char-a embeds near en-char; jp-char-b far. Lonely card never embeds.
        fake_vecs = {
            "en-char": [1.0, 0.0],
            "jp-char-a": [0.99, 0.14],   # cosine ~0.99 with en-char
            "jp-char-b": [0.20, 0.98],   # cosine ~0.20 with en-char
        }
        written = build_links(
            self.conn,
            embed_art_crops=lambda ids: {i: fake_vecs[i] for i in ids if i in fake_vecs},
            threshold=0.9,
            now="2026-06-27T00:00:00+00:00",
        )
        rows = dict(
            (r[0], r[1])
            for r in self.conn.execute(
                "SELECT card_id, counterpart_card_id FROM card_language_links"
            )
        )
        self.assertEqual(written, 2)
        self.assertEqual(rows.get("en-char"), "jp-char-a")   # closest art wins
        self.assertEqual(rows.get("jp-char-a"), "en-char")   # bidirectional
        self.assertNotIn("jp-char-b", rows)                  # below threshold
        self.assertNotIn("en-lonely", rows)                  # no candidate


if __name__ == "__main__":
    unittest.main()
