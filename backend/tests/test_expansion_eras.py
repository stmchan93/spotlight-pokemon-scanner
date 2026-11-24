"""Sets list era grouping + promo detection + online-only hiding (expansion_eras.py)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import GAME_ONE_PIECE, GAME_POKEMON, apply_schema, connect, upsert_expansion  # noqa: E402
from expansion_eras import classify_expansions  # noqa: E402
from server import SpotlightScanService  # noqa: E402


def record(set_id: str, name: str, series: str | None, date: str | None, language: str = "English") -> dict:
    return {"id": set_id, "name": name, "series": series, "language": language, "releaseDate": date}


SCRYDEX = {"source_provider": "scrydex", "payload": {"is_online_only": False}}
TCGPLAYER = {"source_provider": "tcgplayer", "payload": {"isSupplemental": False, "tcgplayerGroupId": 1}}


class ClassifyExpansionsTests(unittest.TestCase):
    def _classify(self, rows: list[tuple[dict, dict]]) -> dict[str, dict]:
        out = classify_expansions([r for r, _ in rows], {r["id"]: m for r, m in rows})
        return {row["id"]: row for row in out}

    def test_online_only_sets_are_dropped(self) -> None:
        out = self._classify(
            [
                (record("me1", "Mega Evolution", "Mega Evolution", "2025/09/26"), SCRYDEX),
                (
                    record("tcgp-A1", "Genetic Apex", "Pokémon TCG Pocket", "2024/10/29"),
                    {"source_provider": "scrydex", "payload": {"is_online_only": True}},
                ),
                # Pocket by series name alone (payload without the flag).
                (record("tcgp-B1", "Mega Rising", "Pokémon TCG Pocket", "2025/10/29"), {}),
                # Online-only flag on a non-Pocket series.
                (
                    record("dig1", "Digital Thing", "Mega Evolution", "2025/10/01"),
                    {"source_provider": "scrydex", "payload": '{"is_online_only": true}'},
                ),
            ]
        )
        self.assertEqual(set(out), {"me1"})

    def test_promo_detection(self) -> None:
        out = self._classify(
            [
                (record("me1", "Mega Evolution", "Mega Evolution", "2025/09/26"), SCRYDEX),
                (record("mep", "Mega Evolution Black Star Promos", "Mega Evolution", "2025/09/26"), SCRYDEX),
                (record("mcd24", "McDonald's Collection 2024", "Other", "2025/01/21"), SCRYDEX),
                (record("tcgplayer-group-24831", "ME06: Delta Reign", None, "2026/11/06"), TCGPLAYER),
                (record("tk1", "SM Trainer Kit: Lycanroc", "Sun & Moon", "2018/03/01"), SCRYDEX),
            ]
        )
        self.assertFalse(out["me1"]["isPromo"])
        self.assertTrue(out["mep"]["isPromo"])
        self.assertTrue(out["mcd24"]["isPromo"])
        self.assertTrue(out["tcgplayer-group-24831"]["isPromo"])
        # Conservative: a Trainer Kit is not a promo.
        self.assertFalse(out["tk1"]["isPromo"])
        # A Scrydex promo keeps its own series as era.
        self.assertEqual(out["mep"]["era"], "Mega Evolution")

    def test_seriesless_sets_take_the_era_of_the_latest_main_set_on_or_before_them(self) -> None:
        out = self._classify(
            [
                (record("me2", "Phantasmal Flames", "Mega Evolution", "2025/11/14"), SCRYDEX),
                (record("me1", "Mega Evolution", "Mega Evolution", "2025/09/26"), SCRYDEX),
                (record("sv10", "Destined Rivals", "Scarlet & Violet", "2025/05/30"), SCRYDEX),
                (record("swsh12", "Silver Tempest", "Sword & Shield", "2022/11/11"), SCRYDEX),
                # Promo-named set in a newer era must NOT anchor older dates.
                (record("svp", "SV Black Star Promos", "Scarlet & Violet", "2023/01/01"), SCRYDEX),
                # After me2 → Mega Evolution.
                (record("tcgplayer-group-1", "ME06: Delta Reign", None, "2026/11/06"), TCGPLAYER),
                # Same day as me1 → Mega Evolution (on or before).
                (record("tcgplayer-group-2", "ME: Mega Evolution Promo", None, "2025/09/26"), TCGPLAYER),
                # Between sv10 and me1 → Scarlet & Violet.
                (record("tcgplayer-group-3", "Player Placement Promos", None, "2025/07/01"), TCGPLAYER),
                # Series "Other" is a bucket, not an era.
                (record("mcd22", "McDonald's Collection 2022", "Other", "2022/12/01"), SCRYDEX),
                # Older than every main set → the oldest era.
                (record("tcgplayer-group-4", "XY Promos", None, "2013/12/16"), TCGPLAYER),
                (record("tcgplayer-group-5", "Undated", None, None), TCGPLAYER),
            ]
        )
        self.assertEqual(out["tcgplayer-group-1"]["era"], "Mega Evolution")
        self.assertEqual(out["tcgplayer-group-2"]["era"], "Mega Evolution")
        self.assertEqual(out["tcgplayer-group-3"]["era"], "Scarlet & Violet")
        self.assertEqual(out["mcd22"]["era"], "Sword & Shield")
        self.assertEqual(out["tcgplayer-group-4"]["era"], "Sword & Shield")
        self.assertEqual(out["tcgplayer-group-5"]["era"], "Sword & Shield")

    def test_era_assignment_is_per_language(self) -> None:
        out = self._classify(
            [
                (record("me1", "Mega Evolution", "Mega Evolution", "2025/09/26"), SCRYDEX),
                (record("sv11_ja", "Black Bolt JP", "Scarlet & Violet", "2025/06/06", "Japanese"), SCRYDEX),
                (record("tcgplayer-group-9", "JP Promo Pack", None, "2025/12/01", "Japanese"), TCGPLAYER),
            ]
        )
        # The newest JAPANESE main set is Scarlet & Violet; English's Mega
        # Evolution set does not count.
        self.assertEqual(out["tcgplayer-group-9"]["era"], "Scarlet & Violet")

    def test_games_without_series_stay_flat_and_tcgplayer_groups_stay_main(self) -> None:
        out = self._classify(
            [
                (record("onepiece~op10", "Royal Blood", None, "2025/03/21"), SCRYDEX),
                (record("onepiece~tcgplayer-group-3188", "Romance Dawn", None, "2022/12/02"), TCGPLAYER),
                (record("onepiece~tcgplayer-group-17675", "One Piece Promotion Cards", None, "2022/09/30"), TCGPLAYER),
            ]
        )
        self.assertTrue(all(row["era"] is None for row in out.values()))
        # A TCGplayer-only group is often a real set Scrydex lacks in these games.
        self.assertFalse(out["onepiece~tcgplayer-group-3188"]["isPromo"])
        self.assertFalse(out["onepiece~op10"]["isPromo"])
        self.assertTrue(out["onepiece~tcgplayer-group-17675"]["isPromo"])

    def test_order_is_preserved(self) -> None:
        rows = [
            (record("me2", "Phantasmal Flames", "Mega Evolution", "2025/11/14"), SCRYDEX),
            (record("mep", "ME Black Star Promos", "Mega Evolution", "2025/09/26"), SCRYDEX),
            (record("me1", "Mega Evolution", "Mega Evolution", "2025/09/26"), SCRYDEX),
        ]
        out = classify_expansions([r for r, _ in rows], {r["id"]: m for r, m in rows})
        self.assertEqual([row["id"] for row in out], ["me2", "mep", "me1"])


class ListExpansionsEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "eras.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        for set_id, name, series, date, provider, payload, game in (
            ("me1", "Mega Evolution", "Mega Evolution", "2025/09/26", "scrydex", {"is_online_only": False}, GAME_POKEMON),
            ("tcgp-A1", "Genetic Apex", "Pokémon TCG Pocket", "2024/10/29", "scrydex", {"is_online_only": True}, GAME_POKEMON),
            ("tcgplayer-group-24938", "McDonald's Promos 2026", None, "2026/11/06", "tcgplayer", {"isSupplemental": True}, GAME_POKEMON),
            ("onepiece~op01", "Romance Dawn", None, "2022/12/02", "tcgplayer", {}, GAME_ONE_PIECE),
        ):
            upsert_expansion(
                self.connection,
                expansion_id=set_id,
                name=name,
                series=series,
                release_date=date,
                source_provider=provider,
                source_payload=payload,
                game=game,
            )
        self.connection.commit()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        # Never reach Scrydex from a unit test: with a key in the environment the
        # endpoint's empty-game sync pulled the LIVE One Piece set list (and spent credits).
        sync_patch = patch("server.sync_scrydex_expansions", return_value=None)
        sync_patch.start()
        self.addCleanup(sync_patch.stop)

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_pokemon_payload_hides_pocket_and_carries_era_and_promo(self) -> None:
        # The unpaired group is browse-hidden (expansion_visibility.py); its
        # classification still rides on the include-hidden payload.
        listed = self.service.list_expansions(game="pokemon")["expansions"]
        self.assertEqual({row["id"] for row in listed}, {"me1"})
        expansions = self.service.list_expansions(game="pokemon", include_hidden=True)["expansions"]
        by_id = {row["id"]: row for row in expansions}
        self.assertEqual(set(by_id), {"me1", "tcgplayer-group-24938"})
        self.assertEqual(by_id["me1"]["era"], "Mega Evolution")
        self.assertFalse(by_id["me1"]["isPromo"])
        self.assertEqual(by_id["tcgplayer-group-24938"]["era"], "Mega Evolution")
        self.assertTrue(by_id["tcgplayer-group-24938"]["isPromo"])

    def test_seriesless_game_is_unaffected(self) -> None:
        expansions = self.service.list_expansions(game="onepiece")["expansions"]
        self.assertEqual([row["id"] for row in expansions], ["onepiece~op01"])
        self.assertIsNone(expansions[0]["era"])
        self.assertFalse(expansions[0]["isPromo"])


if __name__ == "__main__":
    unittest.main()
