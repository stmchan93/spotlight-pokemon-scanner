"""PDP "More like this": similar_cards.py + GET /api/v1/cards/{id}/similar.

Synthetic indexes and a temp DB only; no network, no real visual index.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import date
from http import HTTPStatus
from pathlib import Path
from typing import Any
from unittest import mock

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import similar_cards  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from similar_cards import (  # noqa: E402
    base_name,
    base_name_key,
    build_similar_cards_payload,
    compute_similar_cards,
    nearest_neighbours,
    resolve_index_paths_by_game,
    split_neighbours,
)


class BaseNameTests(unittest.TestCase):
    def test_pokemon_markers_and_owner_prefixes(self) -> None:
        cases = {
            "Latios ☆": "Latios",
            "Latios☆": "Latios",
            "Umbreon ex": "Umbreon",
            "Umbreon VMAX": "Umbreon",
            "Umbreon V": "Umbreon",
            "Arceus VSTAR": "Arceus",
            "Mewtwo-GX": "Mewtwo",
            "Mewtwo-EX": "Mewtwo",
            "M Charizard-EX": "Charizard",
            "Mega Charizard X ex": "Charizard",
            "Dark Charizard": "Charizard",
            "Shining Mew": "Mew",
            "Radiant Charizard": "Charizard",
            "Rocket's Mewtwo": "Mewtwo",
            "Team Rocket's Mewtwo ex": "Mewtwo",
            "Lt. Surge's Electabuzz": "Electabuzz",
            "Misty's Psyduck": "Psyduck",
            "Latios ex δ": "Latios",
            "Pikachu ◇": "Pikachu",
            "Garchomp C LV.X": "Garchomp",
            "Rayquaza BREAK": "Rayquaza",
            "Charizard (Tera)": "Charizard",
            "Pikachu & Zekrom-GX": "Pikachu & Zekrom",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(base_name(raw), expected)

    def test_hyphenated_names_and_apostrophes_survive(self) -> None:
        self.assertEqual(base_name("Ho-Oh ex"), "Ho-Oh")
        self.assertEqual(base_name("Porygon-Z"), "Porygon-Z")
        self.assertEqual(base_name("Farfetch'd"), "Farfetch'd")
        self.assertEqual(base_name("Mr. Mime"), "Mr. Mime")
        self.assertEqual(base_name("Mew"), "Mew")

    def test_trainers_keep_full_name_and_other_games_drop_subtitle(self) -> None:
        self.assertEqual(base_name("Professor's Research", supertype="Trainer"), "Professor's Research")
        self.assertEqual(base_name("Dark Patch", supertype="Trainer"), "Dark Patch")
        self.assertEqual(base_name("Elsa - Snow Queen", game="lorcana"), "Elsa")
        self.assertEqual(base_name("Jinx, Loose Cannon", game="riftbound"), "Jinx")
        self.assertEqual(base_name("Monkey.D.Luffy", game="onepiece"), "Monkey.D.Luffy")

    def test_key_is_case_insensitive(self) -> None:
        self.assertEqual(base_name_key("LATIOS ☆"), base_name_key("latios ex"))
        self.assertEqual(base_name_key(None), "")


def _brute_force(matrix: np.ndarray, ids: list[str], top_k: int, exclude: set[str]) -> dict[str, list[str]]:
    unit = matrix / np.linalg.norm(matrix, axis=1, keepdims=True)
    scores = unit @ unit.T
    out: dict[str, list[str]] = {}
    for i, cid in enumerate(ids):
        if cid in exclude:
            continue
        order = [j for j in np.argsort(-scores[i]) if j != i and ids[j] not in exclude]
        out[cid] = [ids[j] for j in order[:top_k]]
    return out


class NearestNeighbourTests(unittest.TestCase):
    def setUp(self) -> None:
        rng = np.random.default_rng(7)
        self.matrix = rng.normal(size=(53, 16)).astype(np.float32)
        self.ids = [f"c{i}" for i in range(53)]

    def test_chunked_matches_brute_force_for_any_chunk_size(self) -> None:
        expected = _brute_force(self.matrix, self.ids, 5, set())
        for chunk in (1, 7, 16, 53, 500):
            with self.subTest(chunk=chunk):
                got = nearest_neighbours(self.matrix, self.ids, top_k=5, chunk_rows=chunk)
                self.assertEqual({k: [n for n, _ in v] for k, v in got.items()}, expected)

    def test_excludes_self_and_placeholders_as_queries_and_neighbours(self) -> None:
        exclude = frozenset({"c3", "c10"})
        # Make c3 a near-copy of c0 so it WOULD be c0's best neighbour.
        self.matrix[3] = self.matrix[0] * 1.01
        got = nearest_neighbours(self.matrix, self.ids, top_k=6, exclude_ids=exclude, chunk_rows=4)
        self.assertNotIn("c3", got)
        self.assertNotIn("c10", got)
        for card_id, rows in got.items():
            neighbour_ids = [n for n, _ in rows]
            self.assertNotIn(card_id, neighbour_ids)
            self.assertFalse(set(neighbour_ids) & exclude)
            self.assertEqual(len(rows), 6)
            scores = [s for _, s in rows]
            self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertEqual(
            {k: [n for n, _ in v] for k, v in got.items()},
            _brute_force(self.matrix, self.ids, 6, set(exclude)),
        )

    def test_caller_matrix_untouched_by_default(self) -> None:
        before = self.matrix.copy()
        nearest_neighbours(self.matrix, self.ids, top_k=3)
        np.testing.assert_array_equal(self.matrix, before)

    def test_small_index_and_duplicate_rows(self) -> None:
        matrix = np.array([[1, 0], [1, 0.1], [1, 0.1], [0, 1]], dtype=np.float32)
        got = nearest_neighbours(matrix, ["a", "b", "b", "c"], top_k=5)
        self.assertEqual([n for n, _ in got["a"]], ["b", "c"])
        self.assertEqual([n for n, _ in got["b"]], ["a", "c"])  # never itself via its twin


def _write_index(root: Path, name: str, matrix: np.ndarray, ids: list[str], denylist: list[str]) -> tuple[Path, Path]:
    npz = root / f"{name}.npz"
    manifest = root / f"{name}_manifest.json"
    np.savez(npz, embeddings=matrix)
    manifest.write_text(json.dumps({"entries": [{"providerCardId": cid} for cid in ids]}))
    (root / "placeholder_card_ids.json").write_text(json.dumps({"cardIds": denylist}))
    return npz, manifest


class ComputeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.connection = sqlite3.connect(self.root / "db.sqlite")
        self.addCleanup(self.connection.close)

    def test_writes_ranked_rows_and_replaces_per_game(self) -> None:
        rng = np.random.default_rng(1)
        ids = [f"p{i}" for i in range(12)] + ["back-1"]
        paths = _write_index(self.root, "poke", rng.normal(size=(13, 8)).astype(np.float32), ids, ["back-1"])
        self.connection.execute("CREATE TABLE IF NOT EXISTS card_similar (card_id TEXT, rank INTEGER, "
                                "neighbour_id TEXT, score REAL, game TEXT, computed_at TEXT, "
                                "PRIMARY KEY (card_id, rank)) WITHOUT ROWID")
        self.connection.execute("INSERT INTO card_similar VALUES ('stale', 1, 'x', 0.9, 'pokemon', 't')")
        self.connection.execute("INSERT INTO card_similar VALUES ('op1', 1, 'op2', 0.9, 'onepiece', 't')")
        self.connection.commit()
        summary = compute_similar_cards(
            self.connection, index_paths_by_game={"pokemon": paths}, top_k=3, chunk_rows=5
        )
        self.assertEqual(summary["games"]["pokemon"]["cards"], 12)
        self.assertEqual(summary["games"]["pokemon"]["rows"], 36)
        rows = self.connection.execute(
            "SELECT card_id, rank, neighbour_id FROM card_similar WHERE game='pokemon' ORDER BY card_id, rank"
        ).fetchall()
        self.assertEqual(len(rows), 36)
        self.assertFalse(any(r[0] in {"stale", "back-1"} or r[2] == "back-1" for r in rows))
        self.assertEqual({r[1] for r in rows}, {1, 2, 3})
        # A game not in this run keeps its rows.
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM card_similar WHERE game='onepiece'").fetchone()[0], 1
        )

    def test_resolve_index_paths_uses_env_overrides_and_skips_missing(self) -> None:
        npz, manifest = _write_index(self.root, "poke", np.eye(2, dtype=np.float32), ["a", "b"], [])
        op_npz, op_manifest = _write_index(self.root, "op", np.eye(2, dtype=np.float32), ["x", "y"], [])
        env = {
            "SPOTLIGHT_VISUAL_INDEX_NPZ_PATH": str(npz),
            "SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH": str(manifest),
            "SPOTLIGHT_VISUAL_INDEX_NPZ_PATH_ONEPIECE": str(op_npz),
            "SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH_ONEPIECE": str(op_manifest),
        }
        paths = resolve_index_paths_by_game(self.root / "no-repo", env)
        self.assertEqual(paths, {"pokemon": (npz, manifest), "onepiece": (op_npz, op_manifest)})


def _card(card_id: str, name: str, set_id: str, *, supertype: str = "Pokémon") -> dict[str, Any]:
    return {"cardId": card_id, "name": name, "setName": set_id.upper(), "number": "1", "language": "English",
            "imageUrl": None, "setId": set_id, "supertype": supertype, "game": "pokemon"}


class SplitRuleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.card = _card("ex8-106", "Latios ☆", "ex8")
        self.cards = {c["cardId"]: c for c in [
            self.card,
            _card("ex8-105", "Latias ☆", "ex8"),
            _card("pcg2_ja-66", "Latios ☆", "pcg2_ja"),
            _card("ex3-94", "Latios ex", "ex3"),
            _card("sv8-1", "Latias ex", "sv8"),
            _card("sv8-2", "Rayquaza", "sv8"),
            _card("ex8-50", "Deoxys", "ex8"),
        ]}

    def test_pair_same_name_and_cheaper(self) -> None:
        neighbours = [("ex8-105", 0.86), ("pcg2_ja-66", 0.6), ("sv8-1", 0.58), ("ex3-94", 0.55),
                      ("sv8-2", 0.5), ("ex8-50", 0.45), ("gone-1", 0.44)]
        prices = {"ex8-106": 2600.0, "ex8-105": 1700.0, "pcg2_ja-66": 1150.0, "sv8-1": 165.0, "sv8-2": 3000.0,
                  "ex8-50": 12.0}
        payload = split_neighbours(self.card, neighbours, self.cards, prices)
        self.assertEqual(payload["baseName"], "Latios")
        self.assertEqual(payload["goesWith"]["cardId"], "ex8-105")
        self.assertEqual(payload["goesWith"]["priceNow"], 1700.0)
        self.assertEqual([c["cardId"] for c in payload["sameName"]], ["pcg2_ja-66", "ex3-94"])
        self.assertIsNone(payload["sameName"][1]["priceNow"])
        # sv8-2 is dearer; ex8-50 is same set but below the pair score, so it is just "cheaper".
        self.assertEqual([c["cardId"] for c in payload["sameLookCheaper"]], ["sv8-1", "ex8-50"])
        self.assertEqual(set(payload["goesWith"]), {"cardId", "name", "setName", "number", "language",
                                                     "imageUrl", "priceNow", "currencyCode"})

    def test_no_pair_below_threshold_or_from_other_set(self) -> None:
        payload = split_neighbours(self.card, [("ex8-105", 0.74), ("sv8-1", 0.9)], self.cards, {})
        self.assertIsNone(payload["goesWith"])

    def test_unpriced_card_has_no_cheaper_row(self) -> None:
        payload = split_neighbours(self.card, [("sv8-1", 0.6)], self.cards, {"sv8-1": 1.0})
        self.assertEqual(payload["sameLookCheaper"], [])

    def test_rows_capped_at_ten(self) -> None:
        cards = dict(self.cards)
        neighbours = []
        for i in range(15):
            cards[f"l{i}"] = _card(f"l{i}", "Latios", f"s{i}")
            neighbours.append((f"l{i}", 0.5 - i / 100))
        payload = split_neighbours(self.card, neighbours, cards, {})
        self.assertEqual(len(payload["sameName"]), 10)


class PayloadAndRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "similar.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        for card_id, name, set_id in [("ex8-106", "Latios ☆", "ex8"), ("ex8-105", "Latias ☆", "ex8"),
                                      ("pcg2_ja-66", "Latios ☆", "pcg2_ja"), ("sv8-1", "Latias ex", "sv8")]:
            upsert_card(connection, card_id=card_id, name=name, set_name=set_id.upper(), number="1",
                        rarity="Rare", variant="Raw", language="English", set_id=set_id, supertype="Pokémon",
                        image_small_url=f"https://img/{card_id}/small")
        today = date.today().isoformat()
        for card_id, price in [("ex8-106", 2600.0), ("ex8-105", 1700.0), ("sv8-1", 165.0)]:
            connection.execute(
                "INSERT INTO card_price_history_daily (card_id, provider, price_date, display_currency_code, "
                "main_raw_market_price, updated_at) VALUES (?, 'scrydex', ?, 'USD', ?, ?)",
                (card_id, today, price, utc_now()),
            )
        similar_cards.ensure_schema(connection)
        for rank, (neighbour, score) in enumerate([("ex8-105", 0.86), ("pcg2_ja-66", 0.59), ("sv8-1", 0.55)], 1):
            connection.execute("INSERT INTO card_similar VALUES ('ex8-106', ?, ?, ?, 'pokemon', 't')",
                               (rank, neighbour, score))
        connection.commit()
        self.connection = connection
        self.addCleanup(connection.close)

    def test_payload_from_db(self) -> None:
        payload = build_similar_cards_payload(self.connection, "ex8-106")
        self.assertEqual(payload["goesWith"]["cardId"], "ex8-105")
        self.assertEqual(payload["goesWith"]["imageUrl"], "https://img/ex8-105/small")
        self.assertEqual([c["cardId"] for c in payload["sameName"]], ["pcg2_ja-66"])
        self.assertEqual([(c["cardId"], c["priceNow"]) for c in payload["sameLookCheaper"]], [("sv8-1", 165.0)])

    def test_unknown_card_and_missing_table_are_empty(self) -> None:
        empty = {"cardId": "nope", "baseName": None, "goesWith": None, "sameName": [], "sameLookCheaper": []}
        self.assertEqual(build_similar_cards_payload(self.connection, "nope"), empty)
        bare = sqlite3.connect(":memory:")
        self.addCleanup(bare.close)
        self.assertEqual(build_similar_cards_payload(bare, "nope"), empty)

    def _get(self, path: str, *, enabled: bool) -> tuple[HTTPStatus, dict[str, Any]]:
        from server import SpotlightRequestHandler, SpotlightScanService

        with mock.patch.dict(os.environ, {"SPOTLIGHT_PAYLOAD_CACHE_DIR": ""}):
            service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(service.connection.close)
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.service = service
        writes: list[tuple[HTTPStatus, dict[str, Any]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]
        with mock.patch.dict(os.environ, {"SIMILAR_CARDS_ENABLED": "1" if enabled else "0"}):
            handler.do_GET()
        self.assertEqual(len(writes), 1, writes)
        return writes[0]

    def test_route_flag_off_is_404_disabled(self) -> None:
        status, payload = self._get("/api/v1/cards/ex8-106/similar", enabled=False)
        self.assertEqual(status, HTTPStatus.NOT_FOUND)
        self.assertEqual(payload, {"error": "disabled"})

    def test_route_serves_rows_and_empty_for_unknown(self) -> None:
        status, payload = self._get("/api/v1/cards/ex8-106/similar", enabled=True)
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(payload["goesWith"]["cardId"], "ex8-105")
        status, payload = self._get("/api/v1/cards/unknown-1/similar", enabled=True)
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual((payload["goesWith"], payload["sameName"], payload["sameLookCheaper"]), (None, [], []))


if __name__ == "__main__":
    unittest.main()
