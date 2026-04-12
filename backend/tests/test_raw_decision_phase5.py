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
    connect,
    finalize_raw_decision,
    score_raw_signals,
    upsert_catalog_card,
)
from server import SpotlightScanService  # noqa: E402


def raw_payload(
    *,
    title_text_primary: str = "",
    title_text_secondary: str = "",
    whole_card_text: str = "",
    footer_band_text: str = "",
    collector_number_exact: str = "",
    collector_number_partial: str = "",
    set_hint_tokens: list[str] | None = None,
    recognized_tokens: list[str] | None = None,
    crop_confidence: float = 1.0,
) -> dict[str, object]:
    return {
        "scanID": "scan-phase5",
        "capturedAt": "2026-04-09T04:00:00Z",
        "collectorNumber": collector_number_exact or None,
        "setHintTokens": set_hint_tokens or [],
        "promoCodeHint": None,
        "recognizedTokens": [{"text": token, "confidence": 0.9} for token in (recognized_tokens or [])],
        "resolverModeHint": "raw_card",
        "cropConfidence": crop_confidence,
        "warnings": [],
        "ocrAnalysis": {
            "rawEvidence": {
                "titleTextPrimary": title_text_primary or None,
                "titleTextSecondary": title_text_secondary or None,
                "collectorNumberExact": collector_number_exact or None,
                "collectorNumberPartial": collector_number_partial or None,
                "setHints": set_hint_tokens or [],
                "footerBandText": footer_band_text,
                "wholeCardText": whole_card_text,
            }
        },
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
            catalog_card(card_id="gym2-60", name="Blaine's Charmander", set_name="Gym Challenge", number="60/132", set_id="gym2", market_price=2.0),
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
                title_text_primary="Charizard ex",
                whole_card_text="Charizard ex",
                footer_band_text="OBF",
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
                title_text_primary="Charizard ex",
                whole_card_text="Charizard ex",
                footer_band_text="OBF 223/197",
                collector_number_exact="223/197",
                set_hint_tokens=["OBF"],
                crop_confidence=0.95,
            )
        )

        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "obf-223")
        self.assertGreater(response["topCandidates"][0]["finalScore"], response["topCandidates"][1]["finalScore"])
        self.assertEqual(response["reviewDisposition"], "ready")

    def test_zero_signal_raw_scan_returns_unsupported_no_signal_result(self) -> None:
        response = self.service.match_scan(
            raw_payload(
                set_hint_tokens=[],
                crop_confidence=0.35,
            )
        )

        self.assertEqual(response["topCandidates"], [])
        self.assertEqual(response["confidence"], "low")
        self.assertEqual(response["reviewDisposition"], "unsupported")
        self.assertIn("No readable OCR signal was found", response["ambiguityFlags"])
        self.assertIsNone(response["ambiguityDebug"])

    def test_japanese_provider_gap_returns_unsupported(self) -> None:
        payload = raw_payload(
            title_text_primary="カビゴン",
            whole_card_text="カビゴン",
            footer_band_text="s10a 077/071 CHR ©2022 Pokémon/Nintendo/Creatures/GAME FREAK.",
            collector_number_exact="077/071",
            set_hint_tokens=["s10a"],
            recognized_tokens=["カビゴン", "s10a", "077/071", "CHR"],
            crop_confidence=0.81,
        )

        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        decision = finalize_raw_decision([], evidence, signals)

        self.assertEqual(decision.review_disposition, "unsupported")
        self.assertEqual(decision.fallback_reason, "provider_unsupported_japanese")
        self.assertIn("Japanese raw cards are not currently supported by the active provider.", decision.ambiguity_flags)

    def test_same_exact_number_without_disambiguator_is_explicit_in_ambiguity_debug(self) -> None:
        response = self.service.match_scan(
            raw_payload(
                whole_card_text="LV. 29 retreat cost 60/132",
                footer_band_text="60/132",
                collector_number_exact="60/132",
                set_hint_tokens=[],
                crop_confidence=0.69,
            )
        )

        self.assertEqual(response["reviewDisposition"], "needs_review")
        self.assertIn("Best guess is arbitrary among same-number matches", response["ambiguityFlags"])
        self.assertEqual(response["ambiguityDebug"]["kind"], "same_exact_number_without_disambiguator")
        self.assertEqual(response["ambiguityDebug"]["collectorNumber"], "60/132")
        self.assertEqual(response["ambiguityDebug"]["candidateIDs"][0], "gym2-60")
        self.assertGreaterEqual(len(response["ambiguityDebug"]["candidateIDs"]), 2)

    def test_raw_response_includes_cached_pricing_for_top_candidate(self) -> None:
        response = self.service.match_scan(
            raw_payload(
                title_text_primary="Hydrapple ex",
                whole_card_text="Hydrapple ex",
                footer_band_text="SCR 101/142",
                collector_number_exact="101/142",
                set_hint_tokens=["SCR"],
                crop_confidence=0.93,
            )
        )

        candidate = response["topCandidates"][0]["candidate"]
        self.assertEqual(candidate["id"], "sv7-101")
        self.assertEqual(candidate["imageSmallURL"], "https://images.example/sv7-101-small.png")
        self.assertEqual(candidate["imageLargeURL"], "https://images.example/sv7-101-large.png")
        self.assertIn("pricing", candidate)
        self.assertEqual(candidate["pricing"]["market"], 7.5)


if __name__ == "__main__":
    unittest.main()
