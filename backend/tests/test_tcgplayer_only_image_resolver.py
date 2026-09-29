"""TCGplayer-only REVIEW rows resolved by picture (tcgplayer_only_image_resolver):
same art as a candidate -> shadow_linked, different from all -> shadow_missing,
anything unsure stays review with a reason. Synthetic embeddings, no network."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect  # noqa: E402
import tcgplayer_only_catalog as tpo  # noqa: E402
import tcgplayer_only_image_resolver as res  # noqa: E402

T = res.Thresholds(same_art=0.93, different_art=0.80, tie_margin=0.01)


def unit(*values: float) -> np.ndarray:
    v = np.zeros(8, dtype=np.float32)
    v[: len(values)] = values
    return v / np.linalg.norm(v)


def at_cosine(base: np.ndarray, cosine: float, axis: int = 7) -> np.ndarray:
    """A unit vector with exactly `cosine` to `base` (base must be 0 on `axis`)."""
    other = np.zeros_like(base)
    other[axis] = 1.0
    return (cosine * base + np.sqrt(1 - cosine ** 2) * other).astype(np.float32)


class DecideTests(unittest.TestCase):
    def setUp(self):
        self.p = unit(1, 0, 0)

    def test_same_art_links_to_best(self):
        d = res.decide(self.p, {"a": at_cosine(self.p, 0.97), "b": at_cosine(self.p, 0.70, 6)}, thresholds=T)
        self.assertEqual((d.status, d.card_id, d.reason), (tpo.STATUS_SHADOW_LINKED, "a", res.REASON_LINKED))
        self.assertAlmostEqual(d.max_cosine, 0.97, places=3)

    def test_different_art_everywhere_is_missing(self):
        d = res.decide(self.p, {"a": at_cosine(self.p, 0.60), "b": at_cosine(self.p, 0.79, 6)}, thresholds=T)
        self.assertEqual((d.status, d.card_id, d.reason), (tpo.STATUS_SHADOW_MISSING, None, res.REASON_MISSING))

    def test_between_thresholds_stays_review(self):
        d = res.decide(self.p, {"a": at_cosine(self.p, 0.88)}, thresholds=T)
        self.assertEqual((d.status, d.reason), (tpo.STATUS_REVIEW, res.REASON_AMBIGUOUS))

    def test_boundaries_are_inclusive(self):
        self.assertEqual(res.decide(self.p, {"a": at_cosine(self.p, 0.93)}, thresholds=T).status, tpo.STATUS_SHADOW_LINKED)
        self.assertEqual(res.decide(self.p, {"a": at_cosine(self.p, 0.80)}, thresholds=T).status, tpo.STATUS_SHADOW_MISSING)

    def test_tie_between_two_same_art_cards_stays_review(self):
        d = res.decide(self.p, {"a": at_cosine(self.p, 0.975), "b": at_cosine(self.p, 0.970, 6)}, thresholds=T)
        self.assertEqual((d.status, d.reason), (tpo.STATUS_REVIEW, res.REASON_TIE))

    def test_tie_broken_by_a_unique_number_match(self):
        d = res.decide(
            self.p, {"a": at_cosine(self.p, 0.975), "b": at_cosine(self.p, 0.970, 6)}, thresholds=T,
            product_number="003/032", candidate_numbers={"a": "3", "b": "003/032"},
        )
        # Both numbers normalise to 3: no unique match, still a tie.
        self.assertEqual(d.reason, res.REASON_TIE)
        d = res.decide(
            self.p, {"a": at_cosine(self.p, 0.975), "b": at_cosine(self.p, 0.970, 6)}, thresholds=T,
            product_number="021/021", candidate_numbers={"a": "53", "b": "21"},
        )
        self.assertEqual((d.status, d.card_id, d.reason), (tpo.STATUS_SHADOW_LINKED, "b", res.REASON_LINKED_NUMBER_TIEBREAK))

    def test_clear_winner_over_second_same_art_card_links(self):
        d = res.decide(self.p, {"a": at_cosine(self.p, 0.99), "b": at_cosine(self.p, 0.94, 6)}, thresholds=T)
        self.assertEqual((d.status, d.card_id), (tpo.STATUS_SHADOW_LINKED, "a"))

    def test_candidate_without_picture_blocks_missing_but_not_link(self):
        d = res.decide(self.p, {"a": at_cosine(self.p, 0.5), "b": None}, thresholds=T)
        self.assertEqual((d.status, d.reason, d.uncompared), (tpo.STATUS_REVIEW, res.REASON_UNCOMPARED_CANDIDATES, ["b"]))
        d = res.decide(self.p, {"a": at_cosine(self.p, 0.98), "b": None}, thresholds=T)
        self.assertEqual((d.status, d.card_id), (tpo.STATUS_SHADOW_LINKED, "a"))

    def test_banner_classes_link_but_never_go_missing(self):
        low = {"a": at_cosine(self.p, 0.60)}
        for klass in ("world_championship_deck", "oversized"):
            d = res.decide(self.p, low, thresholds=T, product_class=klass)
            self.assertEqual((d.status, d.reason), (tpo.STATUS_REVIEW, res.REASON_BANNER_CLASS))
            d = res.decide(self.p, {"a": at_cosine(self.p, 0.95)}, thresholds=T, product_class=klass)
            self.assertEqual(d.status, tpo.STATUS_SHADOW_LINKED)
        self.assertEqual(res.decide(self.p, low, thresholds=T, product_class="card").status, tpo.STATUS_SHADOW_MISSING)

    def test_no_candidates_or_no_pictures(self):
        self.assertEqual(res.decide(self.p, {}, thresholds=T).reason, res.REASON_NO_CANDIDATES)
        self.assertEqual(res.decide(self.p, {"a": None}, thresholds=T).reason, res.REASON_CANDIDATE_IMAGES_MISSING)


class ImageGuardTests(unittest.TestCase):
    def test_reasons(self):
        self.assertIsNone(res.image_guard_reason((600, 836)))
        self.assertEqual(res.image_guard_reason(None, exists=False), res.IMAGE_MISSING)
        self.assertEqual(res.image_guard_reason(None), res.IMAGE_UNREADABLE)
        self.assertEqual(res.image_guard_reason((1000, 700)), res.IMAGE_LANDSCAPE)
        self.assertEqual(res.image_guard_reason((300, 418)), res.IMAGE_LOW_RES)
        self.assertEqual(res.image_guard_reason((600, 836), shared_count=3), res.IMAGE_PLACEHOLDER)
        self.assertIsNone(res.image_guard_reason((600, 836), shared_count=2))


# --- end-to-end on a temp database -------------------------------------------

COLORS = {
    # product / card pictures are solid colours; the fake embedder maps colour -> vector.
    "same": (200, 10, 10),
    "other": (10, 200, 10),
    "far": (10, 10, 200),
    "grey": (120, 120, 120),
}
P = unit(1, 0, 0)
VECTORS = {
    COLORS["same"]: P,
    COLORS["other"]: at_cosine(P, 0.60, 6),
    COLORS["far"]: at_cosine(P, 0.10, 5),
    COLORS["grey"]: at_cosine(P, 0.87, 4),
}


def png(color, size=(600, 836)) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def fake_embedder(paths):
    from PIL import Image

    out = []
    for path in paths:
        with Image.open(path) as image:
            out.append(VECTORS[image.convert("RGB").getpixel((0, 0))])
    return np.stack(out)


class ResolveReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.conn = connect(root / "db.sqlite")
        self.addCleanup(self.conn.close)
        apply_schema(self.conn, BACKEND_ROOT / "schema.sql")
        self.images: dict[str, bytes] = {}
        self.fetches: list[str] = []
        # Catalog: two Pikachu (EN), one Raichu; JP Lillie in two sets.
        self._card("sv1-25", "Pikachu", "025/198", "sv1", "https://img/sv1-25", COLORS["same"])
        self._card("sv2-40", "Pikachu", "040/193", "sv2", "https://img/sv2-40", COLORS["other"])
        self._card("sv1-26", "Raichu", "026/198", "sv1", "https://img/sv1-26", COLORS["far"])
        self._card("sm8_ja-91", "Lillie", "091/095", "sm8_ja", "https://img/sm8-91", COLORS["same"], language="Japanese")
        self._card("sm10_ja-53", "Lillie", "053/054", "sm10_ja", "https://img/sm10-53", COLORS["same"], language="Japanese")
        self._card("sv1-30", "Eevee", "030/198", "sv1", "https://img/sv1-30", COLORS["other"])
        # Review rows.
        self._row("900001", 3, "pokemon", "Pikachu", "025", COLORS["same"])            # -> linked sv1-25
        self._row("900002", 3, "pokemon", "Pikachu", "099", COLORS["far"])             # -> missing
        self._row("900003", 3, "pokemon", "Pikachu", "100", COLORS["grey"])            # -> review (between)
        self._row("900004", 85, "pokemon-jp", "Lillie", "021/021", COLORS["same"])     # -> review (tie)
        self._row("900005", 3, "pokemon", "Pikachu", "101", COLORS["same"], size=(300, 418))  # low-res
        self._row("900006", 3, "pokemon", "Eevee", "031", None)                         # no picture (403)
        self._row("900007", 3, "pokemon", "Pikachu", "102", COLORS["far"], size=(300, 419))  # low-res, no match
        # Non-review rows: must never change.
        self._raw_row("800001", 3, "pokemon", tpo.STATUS_SHADOW_MISSING, {"name": "Pikachu", "reason": "x"})
        self._raw_row("800002", 3, "pokemon", tpo.STATUS_IGNORED, {"name": "Pikachu", "reason": "code_card"})
        self.conn.commit()
        self.store = res.ImageStore(root / "images", opener=self._open, retries=1)
        self.cache = res.EmbeddingCache(root / "emb.npz", "test-model")

    def _open(self, url, timeout):
        from urllib.error import HTTPError

        self.fetches.append(url)
        if url not in self.images:
            raise HTTPError(url, 403, "forbidden", None, None)
        return self.images[url]

    def _card(self, card_id, name, number, set_id, url, color, language="English"):
        self.conn.execute(
            "INSERT INTO cards (id, game, name, set_name, number, rarity, variant, language, source_provider, set_id, "
            "image_url, created_at, updated_at) VALUES (?, 'pokemon', ?, ?, ?, 'Common', 'Raw', ?, 'scrydex', ?, ?, 'now', 'now')",
            (card_id, name, set_id, number, language, set_id, url),
        )
        # Distinct bytes per card: identical pictures shared by 3+ URLs are placeholders.
        self.images[url] = png(color, (600 + len(self.images), 836))

    def _raw_row(self, pid, category, game, status, evidence):
        self.conn.execute(
            "INSERT INTO tcgplayer_product_classifications (product_id, category_id, group_id, game, status, "
            "evidence_json, first_seen_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, 'then', 'then')",
            (pid, category, game, status, json.dumps(evidence)),
        )

    def _row(self, pid, category, game, name, number, color, size=(600, 836)):
        self._raw_row(pid, category, game, tpo.STATUS_REVIEW, {
            "name": name, "number": number, "rarity": "None", "reason": "unmapped-same-name-rarity-in-game",
            "mappedSets": [], "candidates": [], "groupName": "Deck Kit",
        })
        if color is not None:
            self.images[res.TCGPLAYER_IMAGE_URL.format(pid=pid)] = png(color, size)

    def _status(self):
        return {pid: (status, card_id, proposed, json.loads(ev), label) for pid, status, card_id, proposed, ev, label in self.conn.execute(
            "SELECT product_id, status, card_id, proposed_card_id, evidence_json, version_label FROM tcgplayer_product_classifications")}

    def _run(self, **kwargs):
        result = res.resolve_review(self.conn, store=self.store, cache=self.cache, embedder=fake_embedder,
                                    thresholds=T, log=lambda m: None, **kwargs)
        self.conn.commit()
        return result

    def test_resolves_and_leaves_non_review_rows_alone(self):
        before = self._status()
        result = self._run()
        after = self._status()
        self.assertEqual(after["900001"][:3], (tpo.STATUS_SHADOW_LINKED, "sv1-25", None))
        self.assertEqual(after["900001"][3]["resolvedBy"], "image")
        self.assertEqual(after["900001"][4], "Deck Kit")  # version label filled from the group
        self.assertIn("sv2-40", after["900001"][3]["imageResolution"]["comparedCardIds"])
        self.assertEqual(after["900002"][:3], (tpo.STATUS_SHADOW_MISSING, None, "tcgplayer-900002"))
        self.assertEqual(after["900002"][3]["resolvedBy"], "image")
        self.assertEqual(after["900003"][0], tpo.STATUS_REVIEW)
        self.assertEqual(after["900003"][3]["imageResolution"]["reason"], res.REASON_AMBIGUOUS)
        self.assertNotIn("resolvedBy", after["900003"][3])
        self.assertEqual(after["900004"][3]["imageResolution"]["reason"], res.REASON_TIE)
        # Low-res same art still links (a blurry match is still a match) ...
        self.assertEqual(after["900005"][:2], (tpo.STATUS_SHADOW_LINKED, "sv1-25"))
        # ... but a low-res picture that matches nothing stays in review.
        self.assertEqual(after["900007"][0], tpo.STATUS_REVIEW)
        self.assertEqual(after["900007"][3]["imageResolution"]["reason"], "product-image-low-res")
        self.assertIsNotNone(after["900007"][3]["imageResolution"]["maxCosine"])
        self.assertEqual(after["900006"][3]["imageResolution"]["reason"], "product-image-missing")
        for pid in ("800001", "800002"):
            self.assertEqual(after[pid], before[pid])
        self.assertEqual(result.written, 7)
        self.assertEqual(result.counts["pokemon"][tpo.STATUS_SHADOW_LINKED], 2)

    def test_idempotent_rerun_only_touches_rows_still_in_review(self):
        self._run()
        first = self._status()
        embedded_before = dict(self.cache.rows)
        fetches_before = len(self.fetches)
        result = self._run()
        second = self._status()
        for pid in ("900001", "900002", "900005", "800001", "800002"):
            self.assertEqual(second[pid], first[pid])
        self.assertEqual(len(result.resolutions), 4)  # only the undecided rows (3, 4, 6, 7)
        self.assertEqual(set(self.cache.rows), set(embedded_before))  # nothing re-embedded
        # Nothing is downloaded again: pictures are cached and a 403 (no picture)
        # is only re-asked after a week.
        self.assertEqual(self.fetches[fetches_before:], [])
        self.store.missing_recheck_sec = 0
        self._run()
        self.assertEqual(self.fetches[fetches_before:], [res.TCGPLAYER_IMAGE_URL.format(pid="900006")])

    def test_dry_run_writes_nothing(self):
        before = self._status()
        result = self._run(dry_run=True)
        self.assertEqual(result.written, 0)
        self.assertEqual(self._status(), before)

    def test_index_rows_replace_downloads_and_placeholder_cards_are_uncompared(self):
        index = {"sv1-25": at_cosine(P, 0.5, 3)}
        self._run(product_ids=["900001"], index_vectors=index, placeholder_card_ids={"sv2-40"})
        row = self._status()["900001"]
        self.assertEqual(row[0], tpo.STATUS_REVIEW)
        self.assertEqual(row[3]["imageResolution"]["reason"], res.REASON_UNCOMPARED_CANDIDATES)
        self.assertNotIn("https://img/sv1-25", self.fetches)

    def test_shared_bytes_are_placeholders(self):
        for pid in ("900011", "900012", "900013"):
            self._row(pid, 3, "pokemon", "Raichu", "500", COLORS["far"], size=(500, 700))
        self.conn.commit()
        self._run(product_ids=["900011", "900012", "900013"])
        for pid in ("900011", "900012", "900013"):
            self.assertEqual(self._status()[pid][3]["imageResolution"]["reason"], "product-image-placeholder")

    def test_apply_guard_skips_rows_moved_on(self):
        row = res.load_review_rows(self.conn, ["900001"])[0]
        resolution = res.build_resolution(row, candidates=["sv1-25"], decision=res.Decision(
            tpo.STATUS_SHADOW_LINKED, "sv1-25", res.REASON_LINKED, 0.99, {"sv1-25": 0.99}),
            product_image_reason=None, thresholds=T, model_tag="m", now="now")
        self.conn.execute("UPDATE tcgplayer_product_classifications SET status = 'linked' WHERE product_id = '900001'")
        self.assertEqual(res.apply_resolutions(self.conn, [resolution]), 0)


class CandidateTests(unittest.TestCase):
    def test_widens_to_every_same_name_card_in_game(self):
        index = tpo.CatalogIndex([
            {"id": "a-1", "game": "pokemon", "language": "English", "name": "Pikachu", "number": "1", "rarity": "Common", "set_id": "a"},
            {"id": "b-9", "game": "pokemon", "language": "English", "name": "Pikachu", "number": "9", "rarity": "Rare", "set_id": "b"},
            {"id": "c-1", "game": "pokemon", "language": "English", "name": "Raichu", "number": "1", "rarity": "Common", "set_id": "c"},
            {"id": "j-1", "game": "pokemon", "language": "Japanese", "name": "Pikachu", "number": "1", "rarity": "Common", "set_id": "j"},
        ])
        row = res.ReviewRow("1", 3, "pokemon", "", {
            "name": "Pikachu (Prize Pack)", "number": "1", "rarity": "Common", "mappedSets": ["a"],
            "candidates": ["a-1", "missing-card"], "reason": "number+name-multiple",
        })
        self.assertEqual(sorted(res.review_candidates(row, index)), ["a-1", "b-9"])


if __name__ == "__main__":
    unittest.main()
