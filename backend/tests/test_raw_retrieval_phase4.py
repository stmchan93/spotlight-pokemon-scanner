from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    build_raw_evidence,
    build_raw_retrieval_plan,
    connect,
    merge_raw_candidate_pools,
    score_raw_signals,
    search_cards_local_collector_set,
    search_cards_local_title_set,
    upsert_catalog_card,
)
from import_pokemontcg_catalog import (  # noqa: E402
    best_remote_raw_candidates,
    build_raw_provider_queries,
)
from server import SpotlightScanService  # noqa: E402


def raw_payload(
    *,
    full_text: str = "",
    metadata_text: str = "",
    bottom_left_text: str = "",
    bottom_right_text: str = "",
    collector_number: str = "",
    set_hint_tokens: list[str] | None = None,
    crop_confidence: float = 1.0,
) -> dict[str, object]:
    return {
        "scanID": "scan-phase4",
        "resolverModeHint": "raw_card",
        "fullRecognizedText": full_text,
        "metadataStripRecognizedText": metadata_text,
        "bottomLeftRecognizedText": bottom_left_text,
        "bottomRightRecognizedText": bottom_right_text,
        "topLabelRecognizedText": "",
        "collectorNumber": collector_number,
        "setHintTokens": set_hint_tokens or [],
        "promoCodeHint": None,
        "recognizedTokens": [],
        "cropConfidence": crop_confidence,
    }


def catalog_card(
    *,
    card_id: str,
    name: str,
    set_name: str,
    number: str,
    set_id: str,
    set_series: str = "Test Series",
) -> dict[str, object]:
    return {
        "id": card_id,
        "name": name,
        "set_name": set_name,
        "number": number,
        "rarity": "Rare",
        "variant": "Raw",
        "language": "English",
        "reference_image_path": None,
        "reference_image_url": f"https://images.example/{card_id}-large.png",
        "reference_image_small_url": f"https://images.example/{card_id}-small.png",
        "source": "test_seed",
        "source_record_id": card_id,
        "set_id": set_id,
        "set_series": set_series,
        "set_ptcgo_code": set_id.upper(),
        "set_release_date": "2024-01-01",
        "supertype": "Pokémon",
        "subtypes": [],
        "types": ["Fire"],
        "artist": "Test Artist",
        "regulation_mark": None,
        "national_pokedex_numbers": [],
        "tcgplayer": {},
        "cardmarket": {},
        "source_payload": {"id": card_id, "name": name},
    }


def remote_card(
    *,
    card_id: str,
    name: str,
    set_name: str,
    set_id: str,
    printed_total: int,
    number: str,
) -> dict[str, object]:
    return {
        "id": card_id,
        "name": name,
        "number": number,
        "rarity": "Rare",
        "supertype": "Pokémon",
        "subtypes": [],
        "types": ["Fire"],
        "artist": "Test Artist",
        "images": {
            "small": f"https://images.example/{card_id}-small.png",
            "large": f"https://images.example/{card_id}-large.png",
        },
        "set": {
            "id": set_id,
            "name": set_name,
            "series": "Scarlet & Violet",
            "printedTotal": printed_total,
            "releaseDate": "2024-01-01",
        },
        "tcgplayer": {},
        "cardmarket": {},
    }


class RawRetrievalPhase4Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "phase4.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

        cards = [
            catalog_card(card_id="obf-223", name="Charizard ex", set_name="Obsidian Flames", number="223/197", set_id="obf"),
            catalog_card(card_id="pal-223", name="Charizard ex", set_name="Paldea Evolved", number="223/193", set_id="pal"),
            catalog_card(card_id="gym1-60", name="Sabrina's Slowbro", set_name="Gym Heroes", number="60/132", set_id="gym1", set_series="Gym"),
            catalog_card(card_id="neo1-60", name="Mail from Bill", set_name="Neo Genesis", number="60/111", set_id="neo1", set_series="Neo"),
        ]
        for card in cards:
            upsert_catalog_card(self.connection, card, REPO_ROOT, "2026-04-09T04:00:00Z", refresh_embeddings=False)
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_local_title_set_retrieval_prefers_matching_set(self) -> None:
        payload = raw_payload(
            full_text="Charizard ex",
            metadata_text="OBF",
            set_hint_tokens=["OBF"],
            crop_confidence=0.9,
        )
        evidence = build_raw_evidence(payload)

        candidates = search_cards_local_title_set(self.connection, evidence, limit=5)

        self.assertTrue(candidates)
        self.assertEqual(candidates[0]["id"], "obf-223")
        self.assertIn("title_set_primary", candidates[0]["_retrievalRoutes"])

    def test_local_collector_set_retrieval_prefers_matching_number_and_set(self) -> None:
        payload = raw_payload(
            full_text="Sabrina's Slowbro",
            metadata_text="GYM1",
            bottom_right_text="60/132",
            collector_number="60/132",
            set_hint_tokens=["gym1"],
            crop_confidence=0.88,
        )
        evidence = build_raw_evidence(payload)

        candidates = search_cards_local_collector_set(self.connection, evidence, limit=5)

        self.assertTrue(candidates)
        self.assertEqual(candidates[0]["id"], "gym1-60")
        self.assertIn("collector_set_exact", candidates[0]["_retrievalRoutes"])

    def test_merge_raw_candidate_pools_dedupes_and_preserves_routes(self) -> None:
        merged = merge_raw_candidate_pools(
            [
                [
                    {"id": "obf-223", "name": "Charizard ex", "number": "223/197", "_retrievalScoreHint": 80.0, "_retrievalRoutes": ["title_only"], "_cachePresence": True},
                ],
                [
                    {"id": "obf-223", "name": "Charizard ex", "number": "223/197", "_retrievalScoreHint": 92.0, "_retrievalRoutes": ["collector_set_exact"], "_cachePresence": False},
                    {"id": "pal-223", "name": "Charizard ex", "number": "223/193", "_retrievalScoreHint": 70.0, "_retrievalRoutes": ["title_set_primary"], "_cachePresence": True},
                ],
            ]
        )

        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0]["id"], "obf-223")
        self.assertEqual(merged[0]["_retrievalScoreHint"], 92.0)
        self.assertEqual(set(merged[0]["_retrievalRoutes"]), {"title_only", "collector_set_exact"})

    def test_build_raw_provider_queries_opens_title_and_collector_queries(self) -> None:
        payload = raw_payload(
            full_text="Charizard ex",
            metadata_text="OBF 223/197",
            bottom_right_text="223/197",
            collector_number="223/197",
            set_hint_tokens=["OBF"],
        )
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)

        queries = build_raw_provider_queries(evidence, signals)

        self.assertTrue(any('name:"Charizard ex"' in query for query in queries))
        self.assertTrue(any('number:"223"' in query for query in queries))
        self.assertTrue(any("set.ptcgoCode:OBF" in query or 'set.id:obf' in query for query in queries))

    def test_best_remote_raw_candidates_prefers_title_set_match(self) -> None:
        payload = raw_payload(
            full_text="Charizard ex",
            metadata_text="OBF",
            bottom_right_text="223/197",
            collector_number="223/197",
            set_hint_tokens=["OBF"],
        )
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)

        candidates = best_remote_raw_candidates(
            [
                remote_card(card_id="pal-223", name="Charizard ex", set_name="Paldea Evolved", set_id="pal", printed_total=193, number="223"),
                remote_card(card_id="obf-223", name="Charizard ex", set_name="Obsidian Flames", set_id="obf", printed_total=197, number="223"),
            ],
            evidence,
            signals,
            limit=5,
        )

        self.assertTrue(candidates)
        self.assertEqual(candidates[0]["id"], "obf-223")
        self.assertFalse(candidates[0]["_cachePresence"])

    def test_server_local_retrieval_helper_combines_plan_routes(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        payload = raw_payload(
            full_text="Charizard ex",
            metadata_text="OBF",
            bottom_right_text="223/197",
            collector_number="223/197",
            set_hint_tokens=["OBF"],
        )
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        plan = build_raw_retrieval_plan(evidence, signals)

        candidates = service._retrieve_local_raw_candidates(evidence, signals, plan)
        service.connection.close()

        self.assertTrue(candidates)
        self.assertEqual(candidates[0]["id"], "obf-223")
        self.assertIn("collector_set_exact", candidates[0]["_retrievalRoutes"])


if __name__ == "__main__":
    unittest.main()
