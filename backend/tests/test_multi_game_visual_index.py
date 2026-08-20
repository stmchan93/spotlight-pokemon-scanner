"""Multi-game visual index: one index per game, Pokémon untouched.

Two things are under test here:

  1. `RawVisualMatcher` holds a map of per-game indexes. Pokémon MUST keep
     resolving the exact same artifact it resolved before per-game indexes
     existed (same active/fallback logic, same env overrides) — its top-1
     accuracy number is not allowed to move. Other games resolve lazily and
     degrade to "lane unavailable" when their index has not been built.
  2. `tools/build_raw_visual_index.py` can source cards from our own synced
     catalog SQLite instead of the Scrydex API — the only way a non-Pokémon
     card can enter the pipeline, since the API path is supertype-filtered —
     and does so without making a single billed Scrydex request.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
TOOLS_ROOT = REPO_ROOT / "tools"

for candidate in (str(BACKEND_ROOT), str(TOOLS_ROOT)):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

try:
    import numpy as np  # noqa: E402
    from PIL import Image  # noqa: E402
    import raw_visual_matcher as raw_visual_matcher_module  # noqa: E402
    from raw_visual_index import RawVisualSearchMatch  # noqa: E402
    from raw_visual_matcher import RawVisualMatcher, game_index_artifact_names, sanitize_model_slug  # noqa: E402
    _MATCHER_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host-python dependency fallback
    RawVisualMatcher = None  # type: ignore[assignment]
    _MATCHER_IMPORT_ERROR = exc

try:
    import build_raw_visual_index as builder_module  # noqa: E402
    _BUILDER_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host-python dependency fallback
    builder_module = None  # type: ignore[assignment]
    _BUILDER_IMPORT_ERROR = exc


POKEMON_ACTIVE_NPZ_NAME = "visual_index_active_clip-vit-base-patch32.npz"
POKEMON_ACTIVE_MANIFEST_NAME = "visual_index_active_manifest.json"
POKEMON_FALLBACK_NPZ_NAME = "visual_index_v003-b8_clip-vit-base-patch32.npz"
POKEMON_FALLBACK_MANIFEST_NAME = "visual_index_v003-b8_manifest.json"

# Every per-game env override this suite touches, cleared per test so a stray
# value in the developer's shell can't make a resolution test lie.
_INDEX_ENV_KEYS = (
    "SPOTLIGHT_VISUAL_MODEL_ID",
    "SPOTLIGHT_VISUAL_INDEX_NPZ_PATH",
    "SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH",
    "SPOTLIGHT_VISUAL_INDEX_NPZ_PATH_ONEPIECE",
    "SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH_ONEPIECE",
)


def _write_index_artifacts(index_dir: Path, npz_name: str, manifest_name: str) -> tuple[Path, Path]:
    """Write a tiny but REAL (loadable) npz + manifest pair."""
    index_dir.mkdir(parents=True, exist_ok=True)
    npz_path = index_dir / npz_name
    manifest_path = index_dir / manifest_name
    np.savez_compressed(npz_path, embeddings=np.eye(2, dtype=np.float32))
    manifest_path.write_text(
        json.dumps(
            {
                "entryCount": 2,
                "entries": [
                    {"rowIndex": 0, "providerCardId": f"{npz_name}-row0", "name": "Row Zero"},
                    {"rowIndex": 1, "providerCardId": f"{npz_name}-row1", "name": "Row One"},
                ],
            }
        )
    )
    return npz_path, manifest_path


@unittest.skipIf(_MATCHER_IMPORT_ERROR is not None, f"matcher deps unavailable: {_MATCHER_IMPORT_ERROR}")
class PokemonIndexResolutionIsUnchangedTests(unittest.TestCase):
    """The non-negotiable half: Pokémon still lands on today's file."""

    def setUp(self) -> None:
        self._env_patch = patch.dict(raw_visual_matcher_module.os.environ, {}, clear=False)
        self._env_patch.start()
        for key in _INDEX_ENV_KEYS:
            raw_visual_matcher_module.os.environ.pop(key, None)
        self.addCleanup(self._env_patch.stop)

    def test_pokemon_resolves_the_active_artifact_names_it_always_has(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            index_dir = repo_root / "backend" / "data" / "visual-index"
            _write_index_artifacts(index_dir, POKEMON_ACTIVE_NPZ_NAME, POKEMON_ACTIVE_MANIFEST_NAME)
            # A One Piece index sitting in the same directory must not tempt the
            # Pokémon resolution into picking it up.
            _write_index_artifacts(
                index_dir,
                "visual_index_active_onepiece_clip-vit-base-patch32.npz",
                "visual_index_active_onepiece_manifest.json",
            )

            matcher = RawVisualMatcher(repo_root=repo_root)

            self.assertEqual(matcher.index.npz_path, index_dir / POKEMON_ACTIVE_NPZ_NAME)
            self.assertEqual(matcher.index.manifest_path, index_dir / POKEMON_ACTIVE_MANIFEST_NAME)
            # …and every spelling of "Pokémon" (including 'no game given', which
            # is every pre-multi-game client) returns that same instance.
            for game in (None, "", "pokemon", "Pokemon", "unknown-game"):
                self.assertIs(matcher.index_for_game(game), matcher.index, game)
            self.assertTrue(matcher.is_available())

    def test_pokemon_falls_back_to_the_v003_artifacts_when_active_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            index_dir = repo_root / "backend" / "data" / "visual-index"
            _write_index_artifacts(index_dir, POKEMON_FALLBACK_NPZ_NAME, POKEMON_FALLBACK_MANIFEST_NAME)

            matcher = RawVisualMatcher(repo_root=repo_root)

            self.assertEqual(matcher.index.npz_path, index_dir / POKEMON_FALLBACK_NPZ_NAME)
            self.assertEqual(matcher.index.manifest_path, index_dir / POKEMON_FALLBACK_MANIFEST_NAME)

    def test_pokemon_env_overrides_still_win(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            _write_index_artifacts(
                repo_root / "backend" / "data" / "visual-index",
                POKEMON_ACTIVE_NPZ_NAME,
                POKEMON_ACTIVE_MANIFEST_NAME,
            )
            with patch.dict(
                raw_visual_matcher_module.os.environ,
                {
                    "SPOTLIGHT_VISUAL_INDEX_NPZ_PATH": "custom/index.npz",
                    "SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH": "custom/index.json",
                },
                clear=False,
            ):
                matcher = RawVisualMatcher(repo_root=repo_root)

            self.assertEqual(matcher.index.npz_path, (repo_root / "custom/index.npz").resolve())
            self.assertEqual(matcher.index.manifest_path, (repo_root / "custom/index.json").resolve())
            self.assertIs(matcher.index_for_game("pokemon"), matcher.index)

    def test_pokemon_artifact_name_does_not_follow_the_model_id(self) -> None:
        # The live Pokémon file name says "clip" for historical reasons even
        # though the active backbone is SigLIP2. Deriving it from the model id
        # would silently point production at a file that does not exist.
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            index_dir = repo_root / "backend" / "data" / "visual-index"
            _write_index_artifacts(index_dir, POKEMON_ACTIVE_NPZ_NAME, POKEMON_ACTIVE_MANIFEST_NAME)
            with patch.dict(
                raw_visual_matcher_module.os.environ,
                {"SPOTLIGHT_VISUAL_MODEL_ID": "google/siglip2-so400m-patch16-384"},
                clear=False,
            ):
                matcher = RawVisualMatcher(repo_root=repo_root)

            self.assertEqual(matcher.index.npz_path, index_dir / POKEMON_ACTIVE_NPZ_NAME)

    def test_pokemon_is_rejected_by_the_per_game_naming_convention(self) -> None:
        with self.assertRaises(ValueError):
            game_index_artifact_names("pokemon", "openai/clip-vit-base-patch32")


@unittest.skipIf(_MATCHER_IMPORT_ERROR is not None, f"matcher deps unavailable: {_MATCHER_IMPORT_ERROR}")
class PerGameIndexResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._env_patch = patch.dict(raw_visual_matcher_module.os.environ, {}, clear=False)
        self._env_patch.start()
        for key in _INDEX_ENV_KEYS:
            raw_visual_matcher_module.os.environ.pop(key, None)
        self.addCleanup(self._env_patch.stop)

    def test_naming_convention_inserts_the_game_and_model_slug(self) -> None:
        self.assertEqual(
            game_index_artifact_names("onepiece", "google/siglip2-so400m-patch16-384"),
            (
                "visual_index_active_onepiece_siglip2-so400m-patch16-384.npz",
                "visual_index_active_onepiece_manifest.json",
            ),
        )
        self.assertEqual(sanitize_model_slug("openai/clip-vit-base-patch32"), "clip-vit-base-patch32")

    def test_missing_game_index_degrades_instead_of_raising(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            _write_index_artifacts(
                repo_root / "backend" / "data" / "visual-index",
                POKEMON_ACTIVE_NPZ_NAME,
                POKEMON_ACTIVE_MANIFEST_NAME,
            )

            # Construction must not care that One Piece has no index yet — a
            # raise here would take the whole backend down at boot.
            matcher = RawVisualMatcher(repo_root=repo_root)

            self.assertIsNone(matcher.index_for_game("onepiece"))
            self.assertFalse(matcher.is_available("onepiece"))
            # Pokémon is entirely unaffected by its neighbour's absence.
            self.assertTrue(matcher.is_available())

    def test_game_index_is_resolved_lazily_and_cached(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            index_dir = repo_root / "backend" / "data" / "visual-index"
            _write_index_artifacts(index_dir, POKEMON_ACTIVE_NPZ_NAME, POKEMON_ACTIVE_MANIFEST_NAME)
            npz_path, manifest_path = _write_index_artifacts(
                index_dir,
                "visual_index_active_onepiece_clip-vit-base-patch32.npz",
                "visual_index_active_onepiece_manifest.json",
            )

            matcher = RawVisualMatcher(repo_root=repo_root)
            # Nothing resolved (and nothing read off disk) until a scan asks.
            self.assertEqual(matcher._game_indexes, {})

            index = matcher.index_for_game("onepiece")
            self.assertIsNotNone(index)
            assert index is not None
            self.assertEqual(index.npz_path, npz_path)
            self.assertEqual(index.manifest_path, manifest_path)
            self.assertIsNot(index, matcher.index)
            # Cached: the same instance comes back, and the miss answer sticks too.
            self.assertIs(matcher.index_for_game("one piece"), index)
            self.assertEqual(list(matcher._game_indexes), ["onepiece"])
            # The index itself is real and searchable.
            matches = index.search(np.array([1.0, 0.0], dtype=np.float32), top_k=1)
            self.assertEqual(len(matches), 1)

    def test_missing_game_index_answer_is_cached_too(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            _write_index_artifacts(
                repo_root / "backend" / "data" / "visual-index",
                POKEMON_ACTIVE_NPZ_NAME,
                POKEMON_ACTIVE_MANIFEST_NAME,
            )
            matcher = RawVisualMatcher(repo_root=repo_root)

            self.assertIsNone(matcher.index_for_game("onepiece"))
            with patch.object(matcher, "_resolve_game_index", side_effect=AssertionError("re-resolved")):
                self.assertIsNone(matcher.index_for_game("onepiece"))

    def test_per_game_env_overrides_are_honored(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            _write_index_artifacts(
                repo_root / "backend" / "data" / "visual-index",
                POKEMON_ACTIVE_NPZ_NAME,
                POKEMON_ACTIVE_MANIFEST_NAME,
            )
            npz_path, manifest_path = _write_index_artifacts(
                repo_root / "elsewhere", "op.npz", "op_manifest.json"
            )
            with patch.dict(
                raw_visual_matcher_module.os.environ,
                {
                    "SPOTLIGHT_VISUAL_INDEX_NPZ_PATH_ONEPIECE": "elsewhere/op.npz",
                    "SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH_ONEPIECE": "elsewhere/op_manifest.json",
                },
                clear=False,
            ):
                matcher = RawVisualMatcher(repo_root=repo_root)
                index = matcher.index_for_game("onepiece")

            self.assertIsNotNone(index)
            assert index is not None
            self.assertEqual(index.npz_path, npz_path.resolve())
            self.assertEqual(index.manifest_path, manifest_path.resolve())
            # Pokémon did not move.
            self.assertEqual(matcher.index.npz_path.name, POKEMON_ACTIVE_NPZ_NAME)


class _FakeIndex:
    def __init__(self, label: str) -> None:
        self.label = label
        self.npz_path = Path(f"/tmp/{label}.npz")
        self.manifest_path = Path(f"/tmp/{label}-manifest.json")
        self.search_calls = 0

    def is_available(self) -> bool:
        return True

    def search(self, embedding, top_k: int = 10):  # noqa: ARG002
        self.search_calls += 1
        return [
            RawVisualSearchMatch(
                row_index=0,
                similarity=0.9,
                entry={"providerCardId": f"{self.label}-1", "name": self.label, "language": "English"},
            )
        ]


@unittest.skipIf(_MATCHER_IMPORT_ERROR is not None, f"matcher deps unavailable: {_MATCHER_IMPORT_ERROR}")
class MatchPayloadGameRoutingTests(unittest.TestCase):
    def _matcher_with(self, pokemon_index, game_indexes: dict) -> RawVisualMatcher:
        matcher = object.__new__(RawVisualMatcher)
        matcher.model_id = "clip-test"
        matcher.index = pokemon_index
        matcher._game_indexes = dict(game_indexes)
        matcher._game_index_lock = Lock()
        matcher.adapter_checkpoint_path = Path("/tmp/missing-adapter.pt")
        matcher.adapter_metadata_path = Path("/tmp/missing-adapter.json")
        matcher._encoder = SimpleNamespace(device="cpu")
        matcher._adapter = None
        matcher._runtime_lock = Lock()
        matcher._telemetry_lock = Lock()
        matcher._runtime_ready = True
        matcher._inference_count = 0
        matcher._last_inference_finished_at = None
        matcher._ensure_runtime = lambda: None  # type: ignore[method-assign]
        matcher._load_query_image = lambda payload: raw_visual_matcher_module.DecodedQueryImage(  # type: ignore[method-assign]
            image=Image.new("RGB", (20, 20), color=(10, 20, 30)),
            source="test",
            encodedBytes=1,
            encodedBase64Chars=1,
            decodedWidth=20,
            decodedHeight=20,
        )
        matcher._image_embedding_with_timing = lambda image: (  # type: ignore[method-assign]
            np.array([1.0, 0.0], dtype=np.float32),
            {},
        )
        return matcher

    def test_scan_routes_to_the_index_for_its_game(self) -> None:
        pokemon_index = _FakeIndex("pokemon")
        onepiece_index = _FakeIndex("onepiece")
        matcher = self._matcher_with(pokemon_index, {"onepiece": onepiece_index})

        matches, debug = matcher.match_payload({"game": "onepiece"}, top_k=1)

        self.assertEqual(matches[0].entry["providerCardId"], "onepiece-1")
        self.assertEqual(debug["game"], "onepiece")
        self.assertEqual(debug["indexNpzPath"], str(onepiece_index.npz_path))
        self.assertEqual(pokemon_index.search_calls, 0)
        self.assertGreater(onepiece_index.search_calls, 0)

    def test_scan_without_a_game_still_uses_the_pokemon_index(self) -> None:
        pokemon_index = _FakeIndex("pokemon")
        onepiece_index = _FakeIndex("onepiece")
        matcher = self._matcher_with(pokemon_index, {"onepiece": onepiece_index})

        matches, debug = matcher.match_payload({}, top_k=1)

        self.assertEqual(matches[0].entry["providerCardId"], "pokemon-1")
        self.assertEqual(debug["game"], "pokemon")
        self.assertEqual(debug["indexNpzPath"], str(pokemon_index.npz_path))
        self.assertEqual(onepiece_index.search_calls, 0)

    def test_scan_for_a_game_without_an_index_raises_only_at_scan_time(self) -> None:
        matcher = self._matcher_with(_FakeIndex("pokemon"), {"onepiece": None})

        with self.assertRaisesRegex(RuntimeError, "Visual index artifacts are not available for game 'onepiece'"):
            matcher.match_payload({"game": "onepiece"}, top_k=1)

        # The Pokémon lane keeps serving.
        matches, _ = matcher.match_payload({}, top_k=1)
        self.assertEqual(matches[0].entry["providerCardId"], "pokemon-1")

    def test_unavailable_pokemon_index_keeps_its_historical_error(self) -> None:
        class _UnavailableIndex:
            def is_available(self) -> bool:
                return False

        matcher = object.__new__(RawVisualMatcher)
        matcher.index = _UnavailableIndex()

        with self.assertRaisesRegex(RuntimeError, "Visual index artifacts are not available"):
            matcher.match_payload({})

    def test_basic_energy_mini_index_is_pokemon_only(self) -> None:
        matcher = self._matcher_with(_FakeIndex("pokemon"), {"onepiece": _FakeIndex("onepiece")})
        matcher._maybe_route_basic_energy_mini_index = lambda **kwargs: (  # type: ignore[method-assign]
            self.fail("Pokémon basic-energy routing must not run for a non-Pokémon scan")
        )

        _, debug = matcher.match_payload({"game": "onepiece"}, top_k=1)
        self.assertIsNone(debug["miniIndexEnergyRouted"])


@unittest.skipIf(_BUILDER_IMPORT_ERROR is not None, f"builder deps unavailable: {_BUILDER_IMPORT_ERROR}")
class DatabaseSourcedIndexBuildTests(unittest.TestCase):
    def _make_catalog(self, path: Path) -> None:
        connection = sqlite3.connect(path)
        connection.execute(
            """
            CREATE TABLE cards (
                id TEXT PRIMARY KEY,
                game TEXT NOT NULL DEFAULT 'pokemon',
                name TEXT NOT NULL,
                set_name TEXT NOT NULL,
                number TEXT NOT NULL,
                rarity TEXT NOT NULL,
                variant TEXT NOT NULL,
                language TEXT NOT NULL,
                source_provider TEXT,
                source_record_id TEXT,
                set_id TEXT,
                set_series TEXT,
                set_ptcgo_code TEXT,
                set_release_date TEXT,
                supertype TEXT,
                subtypes_json TEXT NOT NULL DEFAULT '[]',
                types_json TEXT NOT NULL DEFAULT '[]',
                artist TEXT,
                regulation_mark TEXT,
                national_pokedex_numbers_json TEXT NOT NULL DEFAULT '[]',
                image_url TEXT,
                image_small_url TEXT,
                tcgplayer_id TEXT,
                source_payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        rows = [
            ("OP01-001", "onepiece", "Monkey.D.Luffy", "Romance Dawn", "OP01-001", "Leader", "Raw", "English",
             "scrydex", "OP01-001", "OP01", "Booster Pack", "OP01", "2022/12/02", "Leader",
             '["Straw Hat Crew"]', '["Red"]', None, None, "[]",
             "https://images.scrydex.com/onepiece/OP01-001/large",
             "https://images.scrydex.com/onepiece/OP01-001/small", "1", '{"id": "OP01-001"}', "now", "now"),
            ("OP01-002", "onepiece", "Roronoa Zoro", "Romance Dawn", "OP01-002", "Leader", "Raw", "English",
             "scrydex", "OP01-002", "OP01", "Booster Pack", "OP01", "2022/12/02", "Leader",
             "[]", '["Green"]', None, None, "[]",
             "https://images.scrydex.com/onepiece/OP01-002/large",
             "https://images.scrydex.com/onepiece/OP01-002/small", "2", "{}", "now", "now"),
            # No reference image -> cannot be embedded, must be skipped.
            ("OP01-003", "onepiece", "Nami", "Romance Dawn", "OP01-003", "Common", "Raw", "English",
             "scrydex", "OP01-003", "OP01", "Booster Pack", "OP01", "2022/12/02", "Character",
             "[]", "[]", None, None, "[]", None, None, None, "{}", "now", "now"),
            ("base1-4", "pokemon", "Charizard", "Base", "4", "Rare Holo", "Raw", "English",
             "scrydex", "base1-4", "base1", "Base", "BS", "1999/01/09", "Pokémon",
             "[]", '["Fire"]', "Mitsuhiro Arita", None, "[6]",
             "https://images.scrydex.com/pokemon/base1-4/large",
             "https://images.scrydex.com/pokemon/base1-4/small", "3", "{}", "now", "now"),
        ]
        connection.executemany(
            "INSERT INTO cards VALUES (" + ",".join(["?"] * 26) + ")", rows
        )
        connection.commit()
        connection.close()

    def test_reads_only_the_requested_game_and_skips_imageless_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            database_path = Path(tmpdir) / "cards.sqlite"
            self._make_catalog(database_path)

            onepiece = builder_module.load_catalog_cards_from_database(
                database_path=database_path, game="onepiece"
            )
            pokemon = builder_module.load_catalog_cards_from_database(
                database_path=database_path, game="pokemon"
            )

            self.assertEqual([card["id"] for card in onepiece], ["OP01-001", "OP01-002"])
            self.assertEqual([card["id"] for card in pokemon], ["base1-4"])
            self.assertEqual(
                builder_module.load_catalog_cards_from_database(
                    database_path=database_path, game="onepiece", limit=1
                )[0]["id"],
                "OP01-001",
            )

    def test_database_cards_have_the_same_shape_the_scrydex_path_produces(self) -> None:
        from scrydex_adapter import map_scrydex_catalog_card

        with tempfile.TemporaryDirectory() as tmpdir:
            database_path = Path(tmpdir) / "cards.sqlite"
            self._make_catalog(database_path)
            card = builder_module.load_catalog_cards_from_database(
                database_path=database_path, game="onepiece"
            )[0]

        scrydex_shape = set(map_scrydex_catalog_card({"id": "x", "name": "x"}))
        # Same keys the downstream pipeline reads, plus the routing `game`.
        self.assertEqual(set(card) - scrydex_shape, {"game"})
        self.assertEqual(scrydex_shape - set(card), set())
        self.assertEqual(card["reference_image_url"], "https://images.scrydex.com/onepiece/OP01-001/large")
        self.assertEqual(card["subtypes"], ["Straw Hat Crew"])
        self.assertEqual(card["types"], ["Red"])
        self.assertEqual(card["source_payload"], {"id": "OP01-001"})

    def test_pre_multi_game_database_cannot_serve_another_game(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            database_path = Path(tmpdir) / "legacy.sqlite"
            connection = sqlite3.connect(database_path)
            connection.execute("CREATE TABLE cards (id TEXT PRIMARY KEY, image_url TEXT)")
            connection.execute("INSERT INTO cards VALUES ('base1-4', 'https://img/large')")
            connection.commit()
            connection.close()

            with self.assertRaises(SystemExit):
                builder_module.load_catalog_cards_from_database(
                    database_path=database_path, game="onepiece"
                )

    def test_artifact_names_match_the_matcher_convention(self) -> None:
        pokemon = builder_module.build_artifact_paths(
            Path("/out"), "v011", "openai/clip-vit-base-patch32"
        )
        onepiece = builder_module.build_artifact_paths(
            Path("/out"), "v011", "openai/clip-vit-base-patch32", "onepiece"
        )

        # Pokémon names are byte-for-byte what they were before --game existed.
        self.assertEqual(pokemon.npz_path.name, "visual_index_v011_clip-vit-base-patch32.npz")
        self.assertEqual(pokemon.manifest_path.name, "visual_index_v011_manifest.json")
        self.assertEqual(pokemon.image_cache_root.name, "reference_images")
        # One Piece: same shape with the game inserted, and its own caches.
        self.assertEqual(onepiece.npz_path.name, "visual_index_v011_onepiece_clip-vit-base-patch32.npz")
        self.assertEqual(onepiece.manifest_path.name, "visual_index_v011_onepiece_manifest.json")
        self.assertEqual(onepiece.image_cache_root.name, "reference_images_onepiece")

        if _MATCHER_IMPORT_ERROR is None:
            active_npz, active_manifest = game_index_artifact_names(
                "onepiece", "openai/clip-vit-base-patch32"
            )
            self.assertEqual(
                onepiece.npz_path.name.replace("v011", "active"), active_npz
            )
            self.assertEqual(
                onepiece.manifest_path.name.replace("v011", "active"), active_manifest
            )

    def test_manifest_entry_carries_game_only_for_non_pokemon(self) -> None:
        card = {"id": "OP01-001", "name": "Luffy", "number": "OP01-001", "language": "English"}
        pokemon_entry = builder_module.manifest_entry_for_row(
            row_index=0,
            card=card,
            reference_image_path=Path("/tmp/x.png"),
            artifact_version="v011",
            model_id="openai/clip-vit-base-patch32",
        )
        onepiece_entry = builder_module.manifest_entry_for_row(
            row_index=0,
            card=card,
            reference_image_path=Path("/tmp/x.png"),
            artifact_version="v011",
            model_id="openai/clip-vit-base-patch32",
            game="onepiece",
        )

        self.assertNotIn("game", pokemon_entry)
        self.assertEqual(onepiece_entry["game"], "onepiece")
        self.assertEqual(set(onepiece_entry) - set(pokemon_entry), {"game"})

    def test_non_pokemon_build_requires_a_database(self) -> None:
        argv = ["build_raw_visual_index.py", "--game", "onepiece"]
        with patch.object(sys, "argv", argv):
            with self.assertRaisesRegex(SystemExit, "requires --database-path"):
                builder_module.main()

    def test_database_sourced_build_makes_zero_scrydex_api_calls(self) -> None:
        """The cost guarantee: a DB-sourced build must never hit the billed API.

        Runs main() end-to-end with the encoder faked and image downloads served
        locally, while `scrydex_api_request` is booby-trapped.
        """
        def _explode(*args, **kwargs):  # pragma: no cover - the point is that it never runs
            raise AssertionError("A database-sourced build must not make Scrydex API requests")

        class _FakeEncoder:
            embedding_dim = 4

            def __init__(self, *args, **kwargs) -> None:
                pass

            def embed_images(self, images, batch_size=32):  # noqa: ARG002
                return np.ones((len(images), 4), dtype=np.float32)

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            database_path = root / "cards.sqlite"
            self._make_catalog(database_path)
            output_dir = root / "index-out"

            argv = [
                "build_raw_visual_index.py",
                "--game", "onepiece",
                "--database-path", str(database_path),
                "--output-dir", str(output_dir),
                "--artifact-version", "test",
                "--batch-size", "2",
                "--device", "cpu",
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(builder_module, "scrydex_api_request", _explode),
                patch.object(builder_module, "fetch_all_catalog_cards", _explode),
                patch.object(builder_module, "RawVisualFrozenEncoder", _FakeEncoder),
                patch.object(builder_module, "download_image", lambda url: Image.new("RGB", (8, 8), (7, 7, 7))),
            ):
                self.assertEqual(builder_module.main(), 0)

            manifest = json.loads(
                (output_dir / "visual_index_test_onepiece_manifest.json").read_text()
            )
            self.assertTrue((output_dir / "visual_index_test_onepiece_clip-vit-base-patch32.npz").exists())
            self.assertEqual(manifest["game"], "onepiece")
            self.assertEqual(manifest["cardSource"], "catalog_database")
            self.assertEqual([entry["providerCardId"] for entry in manifest["entries"]], ["OP01-001", "OP01-002"])
            self.assertEqual({entry["game"] for entry in manifest["entries"]}, {"onepiece"})


if __name__ == "__main__":
    unittest.main()
