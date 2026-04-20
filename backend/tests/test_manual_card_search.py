from __future__ import annotations

import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, search_cards, upsert_catalog_card  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402


def catalog_card(
    *,
    card_id: str,
    name: str,
    set_name: str,
    number: str,
    set_id: str,
    source_provider: str = "scrydex",
) -> dict[str, object]:
    return {
        "id": card_id,
        "name": name,
        "set_name": set_name,
        "number": number,
        "rarity": "Rare",
        "variant": "Raw",
        "language": "English",
        "source": source_provider,
        "source_record_id": card_id,
        "set_id": set_id,
        "set_series": "Test Series",
        "set_ptcgo_code": set_id.upper(),
        "set_release_date": "2024-01-01",
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


class ManualCardSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "manual-card-search.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

        seed_cards = [
            catalog_card(
                card_id="base-charizard-4",
                name="Charizard",
                set_name="Base Set",
                number="4/102",
                set_id="base1",
            ),
            catalog_card(
                card_id="base-charizard-5",
                name="Charizard",
                set_name="Base Set",
                number="5/102",
                set_id="base1",
            ),
            catalog_card(
                card_id="obf-charizard",
                name="Charizard ex",
                set_name="Obsidian Flames",
                number="223/197",
                set_id="obf",
            ),
            catalog_card(
                card_id="tcgp-charizard",
                name="Charizard",
                set_name="TCGP Digital",
                number="4/102",
                set_id="tcgp-digital",
            ),
        ]

        for index in range(1, 61):
            seed_cards.append(
                catalog_card(
                    card_id=f"pikachu-{index:02d}",
                    name=f"Pikachu {index:02d}",
                    set_name="Promo Pack",
                    number=f"{index}/60",
                    set_id="svp",
                )
            )

        for card in seed_cards:
            upsert_catalog_card(self.connection, card, REPO_ROOT, "2026-04-20T12:00:00Z", refresh_embeddings=False)
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_search_returns_backward_compatible_payload_and_prefers_exact_name(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        payload = service.search("charizard", limit=10)

        self.assertIn("results", payload)
        self.assertLessEqual(len(payload["results"]), 10)
        self.assertGreater(len(payload["results"]), 0)
        self.assertEqual(payload["results"][0]["id"], "base-charizard-4")

    def test_search_prefers_set_match_for_multitoken_queries(self) -> None:
        results = search_cards(self.connection, "base set charizard", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "base-charizard-4")

    def test_search_prefers_exact_number_match_for_number_queries(self) -> None:
        results = search_cards(self.connection, "charizard 4/102", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "base-charizard-4")

    def test_search_supports_structured_name_queries(self) -> None:
        results = search_cards(self.connection, "name:charizard", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "base-charizard-4")

    def test_search_supports_structured_set_queries(self) -> None:
        results = search_cards(self.connection, 'set:"base set"', limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "base-charizard-4")
        self.assertTrue(all(result["setName"] == "Base Set" for result in results[:3]))

    def test_search_supports_quoted_structured_name_queries(self) -> None:
        results = search_cards(self.connection, 'name:"charizard ex"', limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "obf-charizard")

    def test_search_supports_structured_number_queries(self) -> None:
        results = search_cards(self.connection, "number:4/102", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "base-charizard-4")
        self.assertEqual(results[0]["number"], "4/102")

    def test_search_supports_combined_structured_and_free_text_queries(self) -> None:
        results = search_cards(self.connection, "set:obf charizard", limit=10)

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "obf-charizard")

    def test_search_deprioritizes_tcgp_digital_entries(self) -> None:
        results = search_cards(self.connection, "charizard", limit=10)

        self.assertGreater(len(results), 0)
        self.assertNotEqual(results[0]["id"], "tcgp-charizard")

    def test_search_clamps_limit_and_stays_off_full_table_scan(self) -> None:
        with patch("catalog_tools._candidate_rows", side_effect=AssertionError("full table scan path should not be used")):
            default_results = search_cards(self.connection, "pikachu")
            limited_results = search_cards(self.connection, "pikachu", limit=999)

        self.assertEqual(len(default_results), 20)
        self.assertEqual(len(limited_results), 50)
        self.assertEqual(default_results[0]["name"].startswith("Pikachu"), True)

    def test_search_route_keeps_backward_compatible_results_payload(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/cards/search?q=charizard&limit=7"
        handler.service = SpotlightScanService(self.database_path, REPO_ROOT)
        captured: dict[str, object] = {}

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._write_json = write_json  # type: ignore[method-assign]

        try:
            handler.do_GET()
        finally:
            handler.service.connection.close()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertIn("results", captured["payload"])
        self.assertLessEqual(len(captured["payload"]["results"]), 7)
        self.assertGreater(len(captured["payload"]["results"]), 0)


if __name__ == "__main__":
    unittest.main()
