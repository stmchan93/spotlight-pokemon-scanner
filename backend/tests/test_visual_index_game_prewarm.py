"""Startup prewarms EVERY game's visual index, not just Pokémon.

Pokémon is `matcher.index` and has always been warmed at startup. The other
games are built lazily by `index_for_game` and cached on the instance, so a
backend RESTART throws them away and the next scan of that game pays the build
INSIDE the request.

Measured on staging 2026-09-10, right after a deploy: that build pushed a raw
match to 12-16s against a 10s client timeout, so the server logged
`status=200` and the app showed "Photo captured, but matches could not load".
Every retry hit the same cold build and failed the same way.

Production carries only the Pokémon index today, so this must also be a no-op
when a game's artifacts are absent — never an error, never a startup failure.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import GAME_POKEMON, SUPPORTED_GAMES  # noqa: E402
from raw_visual_matcher import RawVisualMatcher  # noqa: E402


class FakeIndex:
    def __init__(self, entry_count: int, *, fails: bool = False) -> None:
        self.entries = list(range(entry_count))
        self.loaded = 0
        self._fails = fails

    def load(self) -> None:
        if self._fails:
            raise RuntimeError("corrupt npz")
        self.loaded += 1


class PrewarmHarness:
    """Only the two methods `_prewarm_game_indexes` actually touches."""

    def __init__(self, available: dict[str, FakeIndex]) -> None:
        self._available = available
        self.asked: list[str] = []

    def index_for_game(self, game: Any = None) -> FakeIndex | None:
        self.asked.append(str(game))
        return self._available.get(str(game))

    _prewarm_game_indexes = RawVisualMatcher._prewarm_game_indexes


class VisualIndexGamePrewarmTests(unittest.TestCase):
    def test_loads_every_non_pokemon_index_that_exists(self) -> None:
        lorcana = FakeIndex(1200)
        onepiece = FakeIndex(900)
        harness = PrewarmHarness({'lorcana': lorcana, 'onepiece': onepiece})

        counts = harness._prewarm_game_indexes()

        self.assertEqual(counts, {'lorcana': 1200, 'onepiece': 900})
        self.assertEqual(lorcana.loaded, 1)
        self.assertEqual(onepiece.loaded, 1)

    def test_never_asks_for_pokemon(self) -> None:
        # Pokémon is `self.index`; `prewarm` loads it directly, and routing it
        # through `index_for_game` here would double-load the 133MB index.
        harness = PrewarmHarness({})
        harness._prewarm_game_indexes()
        self.assertNotIn(GAME_POKEMON, harness.asked)
        self.assertEqual(set(harness.asked), {game for game in SUPPORTED_GAMES if game != GAME_POKEMON})

    def test_absent_artifacts_are_skipped_rather_than_failing(self) -> None:
        # Production ships only the Pokémon index — this must be a quiet no-op.
        harness = PrewarmHarness({})
        self.assertEqual(harness._prewarm_game_indexes(), {})

    def test_one_bad_index_does_not_block_the_others_or_startup(self) -> None:
        harness = PrewarmHarness({
            'lorcana': FakeIndex(5, fails=True),
            'gundam': FakeIndex(7),
        })

        counts = harness._prewarm_game_indexes()

        self.assertNotIn('lorcana', counts)
        self.assertEqual(counts['gundam'], 7)


if __name__ == "__main__":
    unittest.main()
