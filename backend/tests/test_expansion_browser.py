from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    expansion_count,
    get_cards_by_expansion,
    list_local_expansions,
    list_persisted_expansions,
    upsert_catalog_card,
    upsert_expansion,
)
from server import SpotlightScanService  # noqa: E402


def catalog_card(
    *,
    card_id: str,
    name: str,
    set_name: str,
    number: str,
    set_id: str,
    set_release_date: str = "2024-01-01",
    language: str = "English",
) -> dict:
    return {
        "id": card_id,
        "name": name,
        "set_name": set_name,
        "number": number,
        "rarity": "Rare",
        "variant": "Raw",
        "language": language,
        "source": "scrydex",
        "source_record_id": card_id,
        "set_id": set_id,
        "set_series": "Test Series",
        "set_ptcgo_code": set_id.upper(),
        "set_release_date": set_release_date,
        "supertype": "Pokémon",
        "subtypes": [],
        "types": [],
        "artist": "Test Artist",
        "regulation_mark": None,
        "national_pokedex_numbers": [],
        "reference_image_url": f"https://images.example/{card_id}.png",
        "reference_image_small_url": f"https://images.example/{card_id}-small.png",
        "source_payload": {"name": name},
        "tcgplayer": {},
        "cardmarket": {},
    }


class GetCardsByExpansionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "expansion-test.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

        seed_cards = [
            catalog_card(card_id="base1-charizard", name="Charizard", set_name="Base Set", number="4/102", set_id="base1", set_release_date="1999-01-09"),
            catalog_card(card_id="base1-pikachu", name="Pikachu", set_name="Base Set", number="58/102", set_id="base1", set_release_date="1999-01-09"),
            catalog_card(card_id="obf-charizard", name="Charizard ex", set_name="Obsidian Flames", number="125/197", set_id="obf", set_release_date="2023-08-11"),
            catalog_card(card_id="obf-pikachu", name="Pikachu ex", set_name="Obsidian Flames", number="128/197", set_id="obf", set_release_date="2023-08-11"),
            catalog_card(card_id="obf-mewtwo", name="Mewtwo", set_name="Obsidian Flames", number="55/197", set_id="obf", set_release_date="2023-08-11"),
        ]
        for card in seed_cards:
            upsert_catalog_card(self.connection, card, REPO_ROOT, "2026-01-01T00:00:00Z", refresh_embeddings=False)
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_returns_all_cards_for_set_id_when_no_query(self) -> None:
        results = get_cards_by_expansion(self.connection, "obf")
        ids = [r["id"] for r in results]
        self.assertIn("obf-charizard", ids)
        self.assertIn("obf-pikachu", ids)
        self.assertIn("obf-mewtwo", ids)
        self.assertNotIn("base1-charizard", ids)

    def test_returns_empty_for_unknown_set_id(self) -> None:
        results = get_cards_by_expansion(self.connection, "nonexistent-set-xyz")
        self.assertEqual(results, [])

    def test_returns_empty_for_blank_set_id(self) -> None:
        results = get_cards_by_expansion(self.connection, "")
        self.assertEqual(results, [])

    def test_filters_by_query_within_expansion(self) -> None:
        results = get_cards_by_expansion(self.connection, "obf", query="charizard")
        ids = [r["id"] for r in results]
        self.assertIn("obf-charizard", ids)
        self.assertNotIn("base1-charizard", ids)

    def test_filters_by_card_number_within_expansion(self) -> None:
        results = get_cards_by_expansion(self.connection, "obf", query="125")
        ids = [r["id"] for r in results]
        self.assertIn("obf-charizard", ids)
        self.assertNotIn("obf-pikachu", ids)

    def test_filters_by_card_number_with_hash_prefix(self) -> None:
        results = get_cards_by_expansion(self.connection, "obf", query="#125")
        ids = [r["id"] for r in results]
        self.assertIn("obf-charizard", ids)

    def test_filters_by_card_number_handles_leading_zeros(self) -> None:
        upsert_catalog_card(
            self.connection,
            catalog_card(card_id="obf-leading-zero", name="Test Card", set_name="Obsidian Flames", number="001/197", set_id="obf", set_release_date="2023-08-11"),
            REPO_ROOT,
            "2026-01-01T00:00:00Z",
            refresh_embeddings=False,
        )
        self.connection.commit()
        results = get_cards_by_expansion(self.connection, "obf", query="1")
        ids = [r["id"] for r in results]
        self.assertIn("obf-leading-zero", ids)

    def test_filters_by_padded_number_match(self) -> None:
        upsert_catalog_card(
            self.connection,
            catalog_card(card_id="obf-005", name="Padded Card", set_name="Obsidian Flames", number="005/197", set_id="obf", set_release_date="2023-08-11"),
            REPO_ROOT,
            "2026-01-01T00:00:00Z",
            refresh_embeddings=False,
        )
        self.connection.commit()
        results = get_cards_by_expansion(self.connection, "obf", query="005")
        ids = [r["id"] for r in results]
        self.assertIn("obf-005", ids)

    def test_does_not_match_other_expansions_for_number_query(self) -> None:
        results = get_cards_by_expansion(self.connection, "base1", query="125")
        ids = [r["id"] for r in results]
        self.assertNotIn("obf-charizard", ids)

    def test_respects_limit(self) -> None:
        results = get_cards_by_expansion(self.connection, "obf", limit=2)
        self.assertLessEqual(len(results), 2)

    def test_result_has_expected_fields(self) -> None:
        results = get_cards_by_expansion(self.connection, "base1")
        self.assertGreater(len(results), 0)
        card = results[0]
        self.assertIn("id", card)
        self.assertIn("name", card)
        self.assertIn("setID", card)
        self.assertEqual(card["setID"], "base1")


class ExpansionPersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "expansion-persistence-test.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_expansion_count_starts_at_zero(self) -> None:
        self.assertEqual(expansion_count(self.connection), 0)

    def test_upsert_expansion_persists_metadata(self) -> None:
        upsert_expansion(
            self.connection,
            expansion_id="me3",
            name="Perfect Order",
            series="Mega Evolution",
            code="POR",
            release_date="2026-03-27",
            logo_url="https://images.example/me3-logo.png",
            symbol_url="https://images.example/me3-symbol.png",
        )
        self.connection.commit()

        self.assertEqual(expansion_count(self.connection), 1)
        rows = list_persisted_expansions(self.connection)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "me3")
        self.assertEqual(rows[0]["name"], "Perfect Order")
        self.assertEqual(rows[0]["series"], "Mega Evolution")
        self.assertEqual(rows[0]["imageUrl"], "https://images.example/me3-logo.png")

    def test_upsert_expansion_updates_existing_row(self) -> None:
        upsert_expansion(self.connection, expansion_id="me3", name="Original Name")
        upsert_expansion(self.connection, expansion_id="me3", name="Updated Name", code="POR")
        self.connection.commit()
        rows = list_persisted_expansions(self.connection)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "Updated Name")
        self.assertEqual(rows[0]["code"], "POR")

    def test_upsert_expansion_rejects_blank_id(self) -> None:
        with self.assertRaises(ValueError):
            upsert_expansion(self.connection, expansion_id="", name="No ID")

    def test_list_persisted_expansions_orders_by_release_date_desc(self) -> None:
        upsert_expansion(self.connection, expansion_id="old", name="Old Set", release_date="2020-01-01")
        upsert_expansion(self.connection, expansion_id="new", name="New Set", release_date="2025-09-01")
        upsert_expansion(self.connection, expansion_id="mid", name="Mid Set", release_date="2023-05-15")
        self.connection.commit()
        rows = list_persisted_expansions(self.connection)
        ids = [r["id"] for r in rows]
        self.assertEqual(ids, ["new", "mid", "old"])

    def test_list_local_expansions_prefers_persisted_table(self) -> None:
        upsert_expansion(
            self.connection,
            expansion_id="me3",
            name="Perfect Order",
            series="Mega Evolution",
            release_date="2026-03-27",
            logo_url="https://images.example/me3-logo.png",
        )
        self.connection.commit()
        rows = list_local_expansions(self.connection)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["imageUrl"], "https://images.example/me3-logo.png")

    def test_list_local_expansions_falls_back_to_cards_table_when_persisted_empty(self) -> None:
        upsert_catalog_card(
            self.connection,
            catalog_card(card_id="obf-charizard", name="Charizard ex", set_name="Obsidian Flames", number="125", set_id="obf", set_release_date="2023-08-11"),
            REPO_ROOT,
            "2026-01-01T00:00:00Z",
            refresh_embeddings=False,
        )
        self.connection.commit()
        rows = list_local_expansions(self.connection)
        ids = [r["id"] for r in rows]
        self.assertIn("obf", ids)


class ExpansionEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "expansion-endpoint-test.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

        seed_cards = [
            catalog_card(card_id="obf-charizard", name="Charizard ex", set_name="Obsidian Flames", number="125/197", set_id="obf", set_release_date="2023-08-11"),
            catalog_card(card_id="obf-pikachu", name="Pikachu ex", set_name="Obsidian Flames", number="128/197", set_id="obf", set_release_date="2023-08-11"),
        ]
        for card in seed_cards:
            upsert_catalog_card(self.connection, card, REPO_ROOT, "2026-01-01T00:00:00Z", refresh_embeddings=False)
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_list_expansions_returns_persisted_data_without_calling_scrydex(self) -> None:
        upsert_expansion(
            self.connection,
            expansion_id="me3",
            name="Perfect Order",
            series="Mega Evolution",
            release_date="2026-03-27",
            logo_url="https://images.example/me3-logo.png",
        )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        with patch("server.sync_scrydex_expansions") as mock_sync:
            payload = service.list_expansions(game="pokemon")

        mock_sync.assert_not_called()
        ids = [e["id"] for e in payload["expansions"]]
        self.assertIn("me3", ids)

    def test_list_expansions_triggers_scrydex_sync_when_table_empty(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        def fake_sync(connection, *, game="pokemon"):
            upsert_expansion(connection, expansion_id="me3", name="Perfect Order", release_date="2026-03-27")
            connection.commit()
            return 1

        with patch("server.sync_scrydex_expansions", side_effect=fake_sync) as mock_sync:
            payload = service.list_expansions(game="pokemon")

        mock_sync.assert_called_once()
        ids = [e["id"] for e in payload["expansions"]]
        self.assertIn("me3", ids)

    def test_list_expansions_falls_back_to_cards_table_when_no_persisted_and_sync_fails(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        with patch("server.sync_scrydex_expansions", return_value=0):
            payload = service.list_expansions(game="pokemon")

        ids = [e["id"] for e in payload["expansions"]]
        self.assertIn("obf", ids)

    def test_list_expansions_with_refresh_re_syncs_even_when_persisted_exists(self) -> None:
        upsert_expansion(self.connection, expansion_id="old", name="Old", release_date="2020-01-01")
        self.connection.commit()
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        with patch("server.sync_scrydex_expansions", return_value=0) as mock_sync:
            service.list_expansions(game="pokemon", refresh=True)

        mock_sync.assert_called_once()

    def test_search_expansion_cards_returns_results_for_known_set(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        payload = service.search_expansion_cards("obf")
        ids = [r["id"] for r in payload["results"]]
        self.assertIn("obf-charizard", ids)
        self.assertIn("obf-pikachu", ids)

    def test_search_expansion_cards_returns_empty_for_unknown_set(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        payload = service.search_expansion_cards("nonexistent-set")
        self.assertEqual(payload["results"], [])

    def test_search_expansion_cards_filters_by_query(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        payload = service.search_expansion_cards("obf", query="charizard")
        ids = [r["id"] for r in payload["results"]]
        self.assertIn("obf-charizard", ids)


class SyncScrydexExpansionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "sync-expansion-test.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_sync_persists_expansions_from_scrydex_payload(self) -> None:
        from scrydex_adapter import sync_scrydex_expansions

        fake_payload = [
            {
                "id": "me3",
                "name": "Perfect Order",
                "series": "Mega Evolution",
                "code": "POR",
                "release_date": "2026-03-27",
                "images": {"logo": "https://images.example/me3-logo.png", "symbol": "https://images.example/me3-symbol.png"},
            },
            {
                "id": "sv7",
                "name": "Stellar Crown",
                "series": "Scarlet & Violet",
                "code": "SCR",
                "release_date": "2024-09-13",
                "logo": "https://images.example/sv7-logo.png",
            },
        ]

        with patch("scrydex_adapter.fetch_scrydex_expansions_raw", return_value=fake_payload):
            count = sync_scrydex_expansions(self.connection, game="pokemon")

        self.assertEqual(count, 2)
        rows = list_persisted_expansions(self.connection)
        self.assertEqual(len(rows), 2)
        ids = [r["id"] for r in rows]
        self.assertIn("me3", ids)
        self.assertIn("sv7", ids)
        me3_row = next(r for r in rows if r["id"] == "me3")
        self.assertEqual(me3_row["imageUrl"], "https://images.example/me3-logo.png")

    def test_sync_returns_zero_when_scrydex_returns_empty(self) -> None:
        from scrydex_adapter import sync_scrydex_expansions

        with patch("scrydex_adapter.fetch_scrydex_expansions_raw", return_value=[]):
            count = sync_scrydex_expansions(self.connection, game="pokemon")

        self.assertEqual(count, 0)
        self.assertEqual(expansion_count(self.connection), 0)


if __name__ == "__main__":
    unittest.main()
