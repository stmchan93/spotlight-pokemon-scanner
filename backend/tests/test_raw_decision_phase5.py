from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_catalog_card  # noqa: E402
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
        "scanID": "scan-phase5",
        "capturedAt": "2026-04-09T04:00:00Z",
        "fullRecognizedText": full_text,
        "metadataStripRecognizedText": metadata_text,
        "bottomLeftRecognizedText": bottom_left_text,
        "bottomRightRecognizedText": bottom_right_text,
        "topLabelRecognizedText": "",
        "collectorNumber": collector_number,
        "setHintTokens": set_hint_tokens or [],
        "promoCodeHint": None,
        "recognizedTokens": [],
        "resolverModeHint": "raw_card",
        "cropConfidence": crop_confidence,
        "directLookupLikely": True,
        "warnings": [],
    }


def catalog_card(
    *,
    card_id: str,
    name: str,
    set_name: str,
    number: str,
    set_id: str,
    market_price: float | None = None,
) -> dict[str, object]:
    tcgplayer = {}
    if market_price is not None:
        tcgplayer = {
            "updatedAt": "2026-04-09T04:00:00Z",
            "url": f"https://prices.example/{card_id}",
            "prices": {
                "normal": {
                    "low": max(0.1, market_price - 1.0),
                    "mid": market_price - 0.5,
                    "market": market_price,
                    "high": market_price + 1.0,
                    "directLow": market_price - 0.25,
                }
            },
        }
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
        "source": "pokemontcg_api",
        "source_record_id": card_id,
        "set_id": set_id,
        "set_series": "Test Series",
        "set_ptcgo_code": set_id.upper(),
        "set_release_date": "2024-01-01",
        "supertype": "Pokémon",
        "subtypes": [],
        "types": ["Fire"],
        "artist": "Test Artist",
        "regulation_mark": None,
        "national_pokedex_numbers": [],
        "tcgplayer": tcgplayer,
        "cardmarket": {},
        "source_payload": {"id": card_id, "name": name},
    }


class RawDecisionPhase5Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "phase5.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        for card in (
            catalog_card(card_id="obf-223", name="Charizard ex", set_name="Obsidian Flames", number="223/197", set_id="obf", market_price=42.0),
            catalog_card(card_id="pal-223", name="Charizard ex", set_name="Paldea Evolved", number="223/193", set_id="pal", market_price=15.0),
            catalog_card(card_id="gym1-60", name="Sabrina's Slowbro", set_name="Gym Heroes", number="60/132", set_id="gym1", market_price=3.0),
            catalog_card(card_id="sv7-101", name="Hydrapple ex", set_name="Stellar Crown", number="101/142", set_id="scr", market_price=7.5),
        ):
            upsert_catalog_card(self.connection, card, REPO_ROOT, "2026-04-09T04:00:00Z", refresh_embeddings=False)
        self.connection.commit()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.connection.close()
        self.tempdir.cleanup()

    def test_raw_match_scan_returns_best_candidate_when_footer_is_weak_but_title_and_set_are_strong(self) -> None:
        response = self.service.match_scan(
            raw_payload(
                full_text="Charizard ex",
                metadata_text="OBF",
                bottom_left_text="",
                bottom_right_text="",
                collector_number="",
                set_hint_tokens=["OBF"],
                crop_confidence=0.91,
            )
        )

        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "obf-223")
        self.assertNotEqual(response["topCandidates"], [])
        self.assertIn(response["confidence"], {"medium", "low"})
        self.assertEqual(response["resolverMode"], "raw_card")
        self.assertIn("rawDecisionDebug", response)

    def test_footer_collector_reranks_between_same_name_candidates(self) -> None:
        response = self.service.match_scan(
            raw_payload(
                full_text="Charizard ex",
                metadata_text="OBF",
                bottom_right_text="223/197",
                collector_number="223/197",
                set_hint_tokens=["OBF"],
                crop_confidence=0.95,
            )
        )

        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "obf-223")
        self.assertGreater(response["topCandidates"][0]["finalScore"], response["topCandidates"][1]["finalScore"])
        self.assertEqual(response["reviewDisposition"], "ready")

    def test_low_confidence_raw_scan_still_returns_best_candidate(self) -> None:
        response = self.service.match_scan(
            raw_payload(
                full_text="glare pokemon card",
                metadata_text="",
                bottom_left_text="",
                bottom_right_text="",
                collector_number="",
                set_hint_tokens=[],
                crop_confidence=0.35,
            )
        )

        self.assertTrue(response["topCandidates"])
        self.assertEqual(response["confidence"], "low")
        self.assertEqual(response["reviewDisposition"], "needs_review")

    def test_raw_response_includes_cached_pricing_for_top_candidate(self) -> None:
        response = self.service.match_scan(
            raw_payload(
                full_text="Hydrapple ex",
                metadata_text="SCR 101/142",
                bottom_right_text="101/142",
                collector_number="101/142",
                set_hint_tokens=["SCR"],
                crop_confidence=0.93,
            )
        )

        candidate = response["topCandidates"][0]["candidate"]
        self.assertEqual(candidate["id"], "sv7-101")
        self.assertIn("pricing", candidate)
        self.assertEqual(candidate["pricing"]["market"], 7.5)


if __name__ == "__main__":
    unittest.main()
