"""A pricing REFRESH goes to the card's own game, and never buys a measured zero.

Reading stored prices was never broken — `card_detail` is a pure SQLite read, so
a One Piece PDP has always rendered its snapshot. The refresh lane is where the
game was dropped: `PricingProvider` had no `game` at all, so `ScrydexProvider`
built `/pokemon/v1/cards/{id}` for every card of every game. For a non-Pokémon id
that request cannot succeed and still bills a credit — a silent recurring cost
that returns "no data" and reads as the game simply having none.

Three separate things are pinned here, because each fails differently:

  * the PATH follows the card's game;
  * Pokémon is byte-identical, INCLUDING the `request_type` string — that is the
    GROUP BY key of `scrydex_daily_usage_rollups`, so renaming it would split the
    credit history in two at the rename and no chart would say so;
  * a game the registry says has no graded data spends NOTHING on graded, which
    is the difference between a wrong answer and a wrong answer we pay for.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import scrydex_adapter  # noqa: E402
from catalog_tools import (  # noqa: E402
    GAME_GUNDAM,
    GAME_LORCANA,
    GAME_ONE_PIECE,
    GAME_POKEMON,
    apply_schema,
    connect,
    game_has_graded_pricing,
    scrydex_request_type,
    upsert_card,
)
from pricing_provider import PsaPricingResult, RawPricingResult  # noqa: E402
from scrydex_adapter import (  # noqa: E402
    ScrydexProvider,
    persist_scrydex_all_graded_snapshots,
    persist_scrydex_psa_snapshot,
)
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402


# A single graded printing is enough: the persist helpers only need one graded
# context to reach the `source_url` write that carries the provenance.
GRADED_CARD_PAYLOAD = {
    "id": "AOTV-224",
    "name": "Mulan - Elite Archer",
    "expansion": {"name": "Azurite Sea"},
    "variants": [
        {
            "name": "holofoil",
            "prices": [
                {
                    "type": "graded",
                    "company": "PSA",
                    "grade": "10",
                    "currency": "USD",
                    "market": 140.0,
                    "mid": 138.0,
                }
            ],
        }
    ],
}


def _live_scrydex_env() -> dict[str, str]:
    """Credentials the provider checks for readiness, plus mirror off.

    `_refresh_card_pricing_for_context` returns early on an unready provider, so
    without these the gate tests would pass for the wrong reason — no request
    made because there was no provider, not because the game has no data.
    """
    return {
        "SCRYDEX_API_KEY": "test-key",
        "SCRYDEX_TEAM_ID": "test-team",
        "SPOTLIGHT_MANUAL_SCRYDEX_MIRROR": "0",
    }


class ScrydexProviderRequestsTheCardsGameTests(unittest.TestCase):
    """The provider's request path and usage label, per game."""

    def setUp(self) -> None:
        self.provider = ScrydexProvider()

    def _capture(self, call) -> dict[str, object]:
        seen: dict[str, object] = {}

        def fake_request(path: str, **kwargs):
            seen["path"] = path
            seen["request_type"] = kwargs.get("request_type")
            # A dict `data` is the shape `fetch_scrydex_card_by_id` requires; it
            # carries no variants, so persistence returns None and the refresh
            # reports "no pricing". Irrelevant here — the request already
            # happened, and the request is what is under test.
            return {"data": {"id": "CARD-1"}}

        with patch.object(scrydex_adapter, "scrydex_api_request", fake_request):
            call()
        return seen

    def test_pokemon_raw_refresh_is_byte_identical(self) -> None:
        seen = self._capture(
            lambda: self.provider.refresh_raw_pricing(None, "base1-4", game=GAME_POKEMON)
        )
        self.assertEqual(seen["path"], "/pokemon/v1/cards/base1-4")
        # The exact historical literal. This string is the GROUP BY key of
        # `scrydex_daily_usage_rollups`; a game-qualified spelling here would
        # silently fork years of credit history at the deploy.
        self.assertEqual(seen["request_type"], "raw_fetch_by_id")

    def test_pokemon_graded_refresh_is_byte_identical(self) -> None:
        seen = self._capture(
            lambda: self.provider.refresh_psa_pricing(
                None, "base1-4", "PSA", "10", game=GAME_POKEMON
            )
        )
        self.assertEqual(seen["path"], "/pokemon/v1/cards/base1-4")
        self.assertEqual(seen["request_type"], "psa_fetch_by_id")

    def test_raw_refresh_follows_the_cards_game(self) -> None:
        for game, expected_path in (
            (GAME_ONE_PIECE, "/onepiece/v1/cards/CARD-1"),
            (GAME_LORCANA, "/lorcana/v1/cards/CARD-1"),
            (GAME_GUNDAM, "/gundam/v1/cards/CARD-1"),
        ):
            with self.subTest(game=game):
                seen = self._capture(
                    lambda: self.provider.refresh_raw_pricing(None, "CARD-1", game=game)
                )
                self.assertEqual(seen["path"], expected_path)
                self.assertNotIn("/pokemon/", str(seen["path"]))

    def test_graded_refresh_follows_the_cards_game(self) -> None:
        seen = self._capture(
            lambda: self.provider.refresh_psa_pricing(
                None, "AOTV-224", "PSA", "10", game=GAME_LORCANA
            )
        )
        self.assertEqual(seen["path"], "/lorcana/v1/cards/AOTV-224")

    def test_another_games_spend_is_separable_from_pokemons(self) -> None:
        # Not cosmetic: merged into Pokémon's label, a second game's spend would
        # be invisible in the rollups exactly when we most need to see it.
        seen = self._capture(
            lambda: self.provider.refresh_raw_pricing(None, "OP01-001", game=GAME_ONE_PIECE)
        )
        self.assertEqual(seen["request_type"], "raw_fetch_by_id_onepiece")
        self.assertNotEqual(seen["request_type"], "raw_fetch_by_id")

    def test_game_is_required_never_defaulted(self) -> None:
        # A provider that guessed would build a request for the wrong catalog.
        # The caller loading the card row is the only party that knows, so the
        # contract makes forgetting a TypeError rather than a silent Pokémon.
        with self.assertRaises(TypeError):
            self.provider.refresh_raw_pricing(None, "CARD-1")  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            self.provider.refresh_psa_pricing(None, "CARD-1", "PSA", "10")  # type: ignore[call-arg]


class ScrydexRequestTypeTests(unittest.TestCase):
    def test_pokemon_keeps_its_exact_label_and_others_are_qualified(self) -> None:
        self.assertEqual(scrydex_request_type("raw_fetch_by_id", GAME_POKEMON), "raw_fetch_by_id")
        # Absent/unknown means Pokémon everywhere, and a pre-multi-game caller
        # must not have its history renamed either.
        self.assertEqual(scrydex_request_type("raw_fetch_by_id", None), "raw_fetch_by_id")
        self.assertEqual(
            scrydex_request_type("psa_fetch_by_id", GAME_LORCANA), "psa_fetch_by_id_lorcana"
        )


class GradedSnapshotProvenanceTests(unittest.TestCase):
    """`source_url` records which catalog the row actually came from."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "graded-provenance.sqlite"
        self.connection = connect(database_path)
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            self.connection,
            card_id="AOTV-224",
            game=GAME_LORCANA,
            name="Mulan - Elite Archer",
            set_name="Azurite Sea",
            number="224/204",
            rarity="Legendary",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="AOTV-224",
            set_id="aotv",
            set_ptcgo_code="AOTV",
            set_release_date="2026-01-01",
        )
        self.connection.commit()

    def _source_url(self) -> str:
        row = self.connection.execute(
            "SELECT source_url FROM card_price_snapshots WHERE card_id = ?",
            ("AOTV-224",),
        ).fetchone()
        assert row is not None
        return str(row["source_url"])

    def test_exact_grade_snapshot_records_the_games_own_path(self) -> None:
        persisted = persist_scrydex_psa_snapshot(
            self.connection,
            card_id="AOTV-224",
            payload=GRADED_CARD_PAYLOAD,
            grader="PSA",
            grade="10",
            game=GAME_LORCANA,
        )
        self.assertIsNotNone(persisted)
        self.assertIn("/lorcana/v1/cards/AOTV-224", self._source_url())
        self.assertNotIn("/pokemon/", self._source_url())

    def test_full_graded_sync_snapshot_records_the_games_own_path(self) -> None:
        persisted = persist_scrydex_all_graded_snapshots(
            self.connection,
            card_id="AOTV-224",
            payload=GRADED_CARD_PAYLOAD,
            game=GAME_LORCANA,
        )
        self.assertEqual(persisted, 1)
        self.assertIn("/lorcana/v1/cards/AOTV-224", self._source_url())
        self.assertNotIn("/pokemon/", self._source_url())


class _PricingRefreshServiceCase(unittest.TestCase):
    """Shared fixture: one card per game, live pricing on, mirror off."""

    CARDS = (
        ("base1-4", GAME_POKEMON),
        ("OP01-001", GAME_ONE_PIECE),
        ("AOTV-224", GAME_LORCANA),
    )

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "pricing-refresh.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

        for card_id, game in self.CARDS:
            upsert_card(
                self.service.connection,
                card_id=card_id,
                game=game,
                name="Test Card",
                set_name="Test Set",
                number="1/1",
                rarity="Rare",
                variant="Raw",
                language="English",
                source_provider="scrydex",
                source_record_id=card_id,
                set_id="tst",
                set_ptcgo_code="TST",
                set_release_date="2026-01-01",
            )
        self.service.connection.commit()
        self.service.set_live_pricing_mode(enabled=True)

        self.provider = self.service.pricing_registry.get_provider("scrydex")
        assert self.provider is not None

    def _mock_raw(self) -> Mock:
        mock = Mock(
            return_value=RawPricingResult(
                success=True, provider_id="scrydex", card_id="x", payload={}
            )
        )
        self.provider.refresh_raw_pricing = mock  # type: ignore[method-assign]
        return mock

    def _mock_psa(self) -> Mock:
        mock = Mock(
            return_value=PsaPricingResult(
                success=True,
                provider_id="scrydex",
                card_id="x",
                grader="PSA",
                grade="10",
                payload={},
            )
        )
        self.provider.refresh_psa_pricing = mock  # type: ignore[method-assign]
        return mock


class CardDetailRefreshIsPerGameTests(_PricingRefreshServiceCase):
    def test_a_one_piece_card_refreshes_on_its_own_path_not_pokemons(self) -> None:
        # The end-to-end shape of the original bug: open a One Piece PDP, force a
        # refresh, and the request went to /pokemon/v1.
        seen: dict[str, object] = {}

        def fake_request(path: str, **kwargs):
            seen["path"] = path
            return {"data": {"id": "OP01-001"}}

        with patch.dict(os.environ, _live_scrydex_env(), clear=False):
            with patch.object(scrydex_adapter, "scrydex_api_request", fake_request):
                payload = self.service.refresh_card_pricing("OP01-001")

        self.assertIsNotNone(payload)
        self.assertEqual(seen["path"], "/onepiece/v1/cards/OP01-001")

    def test_pokemon_still_refreshes_on_the_pokemon_path(self) -> None:
        raw = self._mock_raw()
        with patch.dict(os.environ, _live_scrydex_env(), clear=False):
            self.service.refresh_card_pricing("base1-4")
        raw.assert_called_once_with(self.service.connection, "base1-4", game=GAME_POKEMON)

    def test_an_unknown_id_has_no_game_and_falls_back_to_pokemon(self) -> None:
        # Documenting, not endorsing: an id with no row has no game to follow, and
        # "absent means Pokémon" is the repo-wide rule (a payload from an older
        # client carries no game and must still price). Pinned so a future change
        # to that fallback is a deliberate edit, not a surprise.
        raw = self._mock_raw()
        with patch.dict(os.environ, _live_scrydex_env(), clear=False):
            self.assertIsNone(self.service.refresh_card_pricing("does-not-exist"))
        raw.assert_called_once_with(
            self.service.connection, "does-not-exist", game=GAME_POKEMON
        )


class GradedRefreshCapabilityGateTests(_PricingRefreshServiceCase):
    def test_a_game_with_no_graded_data_spends_no_credit(self) -> None:
        # Measured, not assumed: One Piece returns zero graded rows, so asking is
        # pure waste. The gate reads the registry, which is why adding a game
        # stays a data change.
        self.assertFalse(game_has_graded_pricing(GAME_ONE_PIECE))
        psa = self._mock_psa()

        def explode(*args, **kwargs):
            raise AssertionError("a game with no graded pricing must not be fetched")

        with patch.dict(os.environ, _live_scrydex_env(), clear=False):
            with patch.object(scrydex_adapter, "scrydex_api_request", explode):
                payload = self.service.refresh_card_pricing(
                    "OP01-001", grader="PSA", grade="10"
                )

        psa.assert_not_called()
        # NOT None: the card exists and its stored raw snapshot still renders.
        # None would surface as a 404 on a PDP that is plainly there.
        self.assertIsNotNone(payload)

    def test_lorcana_does_get_its_graded_refresh(self) -> None:
        # The gate must be the registry flag, not "non-Pokémon". Lorcana has real
        # graded data (1,525 priced cards, eight companies) and would be the first
        # casualty of an `if game == "pokemon"` written here.
        self.assertTrue(game_has_graded_pricing(GAME_LORCANA))
        psa = self._mock_psa()
        with patch.dict(os.environ, _live_scrydex_env(), clear=False):
            self.service.refresh_card_pricing("AOTV-224", grader="PSA", grade="10")
        psa.assert_called_once_with(
            self.service.connection, "AOTV-224", "PSA", "10", game=GAME_LORCANA
        )

    def test_pokemon_graded_refresh_is_unchanged(self) -> None:
        psa = self._mock_psa()
        with patch.dict(os.environ, _live_scrydex_env(), clear=False):
            self.service.refresh_card_pricing("base1-4", grader="PSA", grade="9")
        psa.assert_called_once_with(
            self.service.connection, "base1-4", "PSA", "9", game=GAME_POKEMON
        )


class HydratePricingMixedBatchTests(_PricingRefreshServiceCase):
    def test_a_graded_context_over_two_games_is_rejected_not_guessed(self) -> None:
        # One slabContext describes ONE physical slab. "PSA 10" asked of a Pokémon
        # card and a Lorcana card in the same request cannot be attributed to
        # either, and there is no per-game graded context to group by — so
        # "grouping" would just be applying the one context to everything, which
        # is the bug. Loud beats silent.
        psa = self._mock_psa()
        with patch.dict(os.environ, _live_scrydex_env(), clear=False):
            with self.assertRaises(ValueError) as caught:
                self.service.hydrate_raw_candidate_pricing(
                    ["base1-4", "AOTV-224"], grader="PSA", grade="10"
                )
        self.assertIn("Pokémon", str(caught.exception))
        self.assertIn("Lorcana", str(caught.exception))
        psa.assert_not_called()

    def test_a_graded_context_over_one_game_still_works(self) -> None:
        psa = self._mock_psa()
        with patch.dict(os.environ, _live_scrydex_env(), clear=False):
            payload = self.service.hydrate_raw_candidate_pricing(
                ["base1-4"], grader="PSA", grade="10"
            )
        self.assertEqual(payload["returnedCount"], 1)
        psa.assert_called_once_with(
            self.service.connection, "base1-4", "PSA", "10", game=GAME_POKEMON
        )

    def test_a_raw_batch_may_span_games_and_each_card_keeps_its_own(self) -> None:
        # The raw context says nothing game-specific, so a mixed batch is legal —
        # and each card must still be refreshed on ITS game, which is the whole
        # point of resolving per card rather than per request.
        raw = self._mock_raw()
        with patch.dict(os.environ, _live_scrydex_env(), clear=False):
            payload = self.service.hydrate_raw_candidate_pricing(
                ["base1-4", "OP01-001"], max_refresh_count=2
            )

        self.assertEqual(payload["returnedCount"], 2)
        self.assertEqual(
            [(call.args[1], call.kwargs["game"]) for call in raw.call_args_list],
            [("base1-4", GAME_POKEMON), ("OP01-001", GAME_ONE_PIECE)],
        )


class HydratePricingRouteTests(unittest.TestCase):
    def _writes(self, error: Exception) -> list[tuple[HTTPStatus, dict[str, object]]]:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/cards/hydrate-pricing"
        handler.service = Mock()
        handler.service.hydrate_raw_candidate_pricing.side_effect = error
        handler._read_json_body = lambda: {  # type: ignore[method-assign]
            "cardIDs": ["base1-4", "AOTV-224"],
            "slabContext": {"grader": "PSA", "grade": "10"},
        }
        writes: list[tuple[HTTPStatus, dict[str, object]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]
        handler.do_POST()
        return writes

    def test_a_rejected_mixed_batch_is_a_400_not_a_502(self) -> None:
        # 502 would send the client hunting Scrydex for a bug in its own payload.
        # The batch it sent is the thing that is wrong, so say so.
        writes = self._writes(ValueError("A graded slabContext cannot be applied"))
        self.assertEqual(len(writes), 1)
        status, payload = writes[0]
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)
        self.assertIn("graded slabContext", str(payload["error"]))

    def test_a_genuine_upstream_failure_is_still_a_502(self) -> None:
        writes = self._writes(RuntimeError("scrydex timed out"))
        self.assertEqual(writes[0][0], HTTPStatus.BAD_GATEWAY)


if __name__ == "__main__":
    unittest.main()
