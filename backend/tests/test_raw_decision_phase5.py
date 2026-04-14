from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    RawCandidateMatch,
    RawCandidateScoreBreakdown,
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
    raw_resolver_mode: str | None = "ocr",
) -> dict[str, object]:
    payload = {
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
    if raw_resolver_mode is not None:
        payload["rawResolverMode"] = raw_resolver_mode
    return payload


def catalog_card(
    *,
    card_id: str,
    name: str,
    set_name: str,
    number: str,
    set_id: str,
    market_price: float | None = None,
    language: str = "English",
    source_payload: dict[str, object] | None = None,
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
        "language": language,
        "reference_image_path": None,
        "reference_image_url": f"https://images.example/{card_id}-large.png",
        "reference_image_small_url": f"https://images.example/{card_id}-small.png",
        "source": "scrydex",
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
        "source_payload": source_payload or {"id": card_id, "name": name},
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

    def test_raw_resolver_strategy_defaults_to_hybrid_when_mode_is_omitted(self) -> None:
        payload = raw_payload(raw_resolver_mode=None)

        self.assertEqual(self.service._raw_resolver_strategy(payload), "hybrid")

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

    def test_finalize_raw_decision_keeps_top_five_candidates(self) -> None:
        payload = raw_payload(
            title_text_primary="Charizard ex",
            whole_card_text="Charizard ex",
            footer_band_text="OBF 223/197",
            collector_number_exact="223/197",
            set_hint_tokens=["OBF"],
            crop_confidence=0.95,
        )
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)

        matches = [
            RawCandidateMatch(
                card={
                    "id": f"candidate-{index}",
                    "name": f"Candidate {index}",
                    "setName": "Test Set",
                    "number": f"{index}/100",
                    "rarity": "Rare",
                    "variant": "Raw",
                    "language": "English",
                },
                retrieval_score=80.0 - index,
                resolution_score=82.0 - index,
                final_total=81.0 - index,
                breakdown=RawCandidateScoreBreakdown(
                    title_overlap_score=20.0,
                    set_overlap_score=15.0,
                    set_badge_image_score=0.0,
                    collector_exact_score=10.0,
                    collector_partial_score=0.0,
                    collector_denominator_score=4.0,
                    footer_text_support_score=5.0,
                    promo_support_score=0.0,
                    cache_presence_score=0.0,
                    contradiction_penalty=0.0,
                    retrieval_total=80.0 - index,
                    resolution_total=82.0 - index,
                    final_total=81.0 - index,
                ),
                reasons=("title_overlap",),
            )
            for index in range(6)
        ]

        decision = finalize_raw_decision(matches, evidence, signals)

        self.assertEqual(len(decision.top_candidates), 5)
        self.assertEqual(decision.top_candidates[0].card["id"], "candidate-0")
        self.assertEqual(decision.top_candidates[-1].card["id"], "candidate-4")

    def test_visual_hybrid_path_handles_visual_match_objects_without_crashing(self) -> None:
        class FakeVisualMatcher:
            def prewarm(self):
                return {
                    "available": True,
                    "prewarmed": True,
                    "timings": {"indexLoadMs": 1.0, "runtimeLoadMs": 2.0, "totalMs": 3.0},
                }

            def match_payload(self, payload: dict[str, object], *, top_k: int = 10):  # noqa: ARG002
                return (
                    [
                        SimpleNamespace(
                            row_index=0,
                            similarity=0.91,
                            entry={
                                "providerCardId": "obf-223",
                                "name": "Charizard ex",
                                "collectorNumber": "223/197",
                                "setId": "obf",
                                "setName": "Obsidian Flames",
                                "setSeries": "Scarlet & Violet",
                                "setPtcgoCode": "OBF",
                                "sourceProvider": "scrydex",
                                "sourceRecordID": "obf-223",
                                "imageUrl": "https://images.example/obf-223-large.png",
                                "language": "English",
                            },
                        ),
                        SimpleNamespace(
                            row_index=1,
                            similarity=0.83,
                            entry={
                                "providerCardId": "pal-223",
                                "name": "Charizard ex",
                                "collectorNumber": "223/193",
                                "setId": "pal",
                                "setName": "Paldea Evolved",
                                "setSeries": "Scarlet & Violet",
                                "setPtcgoCode": "PAL",
                                "sourceProvider": "scrydex",
                                "sourceRecordID": "pal-223",
                                "imageUrl": "https://images.example/pal-223-large.png",
                                "language": "English",
                            },
                        ),
                    ],
                    {
                        "source": "fake",
                        "timings": {
                            "imageDecodeMs": 4.0,
                            "ensureRuntimeMs": 5.0,
                            "embeddingMs": 6.0,
                            "indexSearchMs": 7.0,
                            "matchPayloadMs": 8.0,
                        },
                    },
                )

        self.service._raw_visual_matcher = FakeVisualMatcher()

        response = self.service._resolve_raw_candidates_visual_hybrid(
            raw_payload(
                title_text_primary="Charizard ex",
                whole_card_text="Charizard ex",
                footer_band_text="OBF 223/197",
                collector_number_exact="223/197",
                set_hint_tokens=["OBF"],
                crop_confidence=0.95,
            )
        )

        self.assertEqual(response["resolverPath"], "visual_hybrid_index")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "obf-223")
        self.assertGreaterEqual(len(response["topCandidates"]), 2)
        self.assertIn("phaseTimings", response["rawDecisionDebug"]["visualHybrid"])
        self.assertEqual(response["rawDecisionDebug"]["visualHybrid"]["timings"]["matchPayloadMs"], 8.0)

    def test_visual_hybrid_weak_fallback_merges_local_manifest_ocr_candidates(self) -> None:
        class FakeIndex:
            def __init__(self) -> None:
                self.entries = [
                    {
                        "providerCardId": "gym1-60",
                        "name": "Sabrina's Slowbro",
                        "collectorNumber": "60/132",
                        "setId": "gym1",
                        "setName": "Gym Heroes",
                        "setSeries": "Gym",
                        "setPtcgoCode": "G1",
                        "sourceProvider": "scrydex",
                        "sourceRecordID": "gym1-60",
                        "imageUrl": "https://images.example/gym1-60-large.png",
                        "language": "English",
                    },
                    {
                        "providerCardId": "gym2-60",
                        "name": "Blaine's Charmander",
                        "collectorNumber": "60/132",
                        "setId": "gym2",
                        "setName": "Gym Challenge",
                        "setSeries": "Gym",
                        "setPtcgoCode": "G2",
                        "sourceProvider": "scrydex",
                        "sourceRecordID": "gym2-60",
                        "imageUrl": "https://images.example/gym2-60-large.png",
                        "language": "English",
                    },
                ]

            def load(self) -> None:
                return None

        class FakeVisualMatcher:
            def __init__(self) -> None:
                self.index = FakeIndex()

            def prewarm(self):
                return {
                    "available": True,
                    "prewarmed": True,
                    "timings": {"indexLoadMs": 1.0, "runtimeLoadMs": 2.0, "totalMs": 3.0},
                }

            def match_payload(self, payload: dict[str, object], *, top_k: int = 10):  # noqa: ARG002
                return (
                    [
                        SimpleNamespace(
                            row_index=0,
                            similarity=0.8343,
                            entry={
                                "providerCardId": "me1-156",
                                "name": "Mega Camerupt ex",
                                "collectorNumber": "156/132",
                                "setId": "me1",
                                "setName": "Mega Evolution",
                                "setSeries": "XY",
                                "setPtcgoCode": "ME1",
                                "sourceProvider": "scrydex",
                                "sourceRecordID": "me1-156",
                                "imageUrl": "https://images.example/me1-156-large.png",
                                "language": "English",
                            },
                        ),
                        SimpleNamespace(
                            row_index=1,
                            similarity=0.8243,
                            entry={
                                "providerCardId": "swsh7-19",
                                "name": "Entei",
                                "collectorNumber": "019/203",
                                "setId": "swsh7",
                                "setName": "Evolving Skies",
                                "setSeries": "Sword & Shield",
                                "setPtcgoCode": "EVS",
                                "sourceProvider": "scrydex",
                                "sourceRecordID": "swsh7-19",
                                "imageUrl": "https://images.example/swsh7-19-large.png",
                                "language": "English",
                            },
                        ),
                    ],
                    {
                        "source": "fake",
                        "internalTopK": top_k * 8,
                        "timings": {
                            "imageDecodeMs": 4.0,
                            "ensureRuntimeMs": 5.0,
                            "embeddingMs": 6.0,
                            "indexSearchMs": 7.0,
                            "matchPayloadMs": 8.0,
                        },
                    },
                )

        self.service._raw_visual_matcher = FakeVisualMatcher()

        payload = raw_payload(
            title_text_primary="Sabrina's Slowpoke Pur Sabrinali",
            whole_card_text="Evolves from Sabrina's Slowpoke Pur Sabrinali M STAGE Sabrina's Slowbro 70 M",
            footer_band_text="Illus. Ken Sugimori 60/132",
            collector_number_exact="60/132",
            crop_confidence=0.58,
        )
        payload["ocrAnalysis"]["normalizedTarget"] = {
            "usedFallback": True,
            "targetQuality": {
                "overallScore": 0.58,
                "reasons": [
                    "fallback",
                    "normalization:exact_reticle_fallback",
                ],
            },
        }

        response = self.service._resolve_raw_candidates_visual_hybrid(payload)

        self.assertEqual(response["resolverPath"], "visual_hybrid_index")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "gym1-60")
        self.assertEqual(response["rawDecisionDebug"]["visualHybrid"]["retrievalStrategy"], "fallback_local_rescue")
        self.assertGreaterEqual(response["rawDecisionDebug"]["visualHybrid"]["localOCRCandidateCount"], 1)

    def test_visual_hybrid_weak_fallback_uses_japanese_title_aliases_to_break_same_number_tie(self) -> None:
        upsert_catalog_card(
            self.service.connection,
            catalog_card(
                card_id="sv2p_ja-77",
                name="Baxcalibur",
                set_name="スノーハザード",
                number="077/071",
                set_id="sv2p_ja",
                language="Japanese",
                source_payload={
                    "id": "sv2p_ja-77",
                    "name": "セグレイブ",
                    "translation": {
                        "en": {
                            "name": "Baxcalibur",
                        }
                    },
                },
            ),
            REPO_ROOT,
            "2026-04-14T01:10:00Z",
            refresh_embeddings=False,
        )
        upsert_catalog_card(
            self.service.connection,
            catalog_card(
                card_id="swsh10a_ja-77",
                name="Snorlax",
                set_name="ダークファンタズマ",
                number="077/071",
                set_id="swsh10a_ja",
                language="Japanese",
                source_payload={
                    "id": "swsh10a_ja-77",
                    "name": "カビゴン",
                    "translation": {
                        "en": {
                            "name": "Snorlax",
                        }
                    },
                },
            ),
            REPO_ROOT,
            "2026-04-14T01:10:00Z",
            refresh_embeddings=False,
        )
        self.service.connection.commit()

        class FakeIndex:
            def __init__(self) -> None:
                self.entries = [
                    {
                        "providerCardId": "sv2p_ja-77",
                        "name": "Baxcalibur",
                        "collectorNumber": "077/071",
                        "setId": "sv2p_ja",
                        "setName": "スノーハザード",
                        "setSeries": "Scarlet & Violet",
                        "setPtcgoCode": "SV2P",
                        "sourceProvider": "scrydex",
                        "sourceRecordID": "sv2p_ja-77",
                        "imageUrl": "https://images.example/sv2p_ja-77-large.png",
                        "language": "Japanese",
                    },
                    {
                        "providerCardId": "swsh10a_ja-77",
                        "name": "Snorlax",
                        "collectorNumber": "077/071",
                        "setId": "swsh10a_ja",
                        "setName": "ダークファンタズマ",
                        "setSeries": "Sword & Shield",
                        "setPtcgoCode": "S10A",
                        "sourceProvider": "scrydex",
                        "sourceRecordID": "swsh10a_ja-77",
                        "imageUrl": "https://images.example/swsh10a_ja-77-large.png",
                        "language": "Japanese",
                    },
                ]

            def load(self) -> None:
                return None

        class FakeVisualMatcher:
            def __init__(self) -> None:
                self.index = FakeIndex()

            def match_payload(self, payload: dict[str, object], *, top_k: int = 10):  # noqa: ARG002
                return (
                    [
                        SimpleNamespace(
                            row_index=0,
                            similarity=0.82,
                            entry=self.index.entries[0],
                        )
                    ],
                    {
                        "source": "fake",
                        "internalTopK": top_k * 8,
                        "timings": {
                            "imageDecodeMs": 4.0,
                            "ensureRuntimeMs": 5.0,
                            "embeddingMs": 6.0,
                            "indexSearchMs": 7.0,
                            "matchPayloadMs": 8.0,
                        },
                    },
                )

        self.service._raw_visual_matcher = FakeVisualMatcher()

        payload = raw_payload(
            title_text_primary="たね カビゴン HP",
            whole_card_text="たね カビゴン HP 150",
            footer_band_text="s10a 077/071 CHR",
            collector_number_exact="077/071",
            crop_confidence=0.40,
        )
        payload["ocrAnalysis"]["normalizedTarget"] = {
            "usedFallback": True,
            "targetQuality": {
                "overallScore": 0.40,
                "reasons": [
                    "fallback",
                    "normalization:exact_reticle_fallback",
                ],
            },
        }

        response = self.service._resolve_raw_candidates_visual_hybrid(payload)

        self.assertEqual(response["resolverPath"], "visual_hybrid_index")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "swsh10a_ja-77")
        self.assertEqual(response["rawDecisionDebug"]["visualHybrid"]["retrievalStrategy"], "fallback_local_rescue")
        self.assertGreaterEqual(response["rawDecisionDebug"]["visualHybrid"]["localOCRCandidateCount"], 2)

    def test_visual_hybrid_weak_fallback_uses_japanese_fuzzy_title_aliases_for_noisy_tag_team_title(self) -> None:
        upsert_catalog_card(
            self.service.connection,
            catalog_card(
                card_id="sm8_ja-66",
                name="Chansey",
                set_name="超爆インパクト",
                number="066/095",
                set_id="sm8_ja",
                language="Japanese",
                source_payload={
                    "id": "sm8_ja-66",
                    "name": "ラッキー",
                    "translation": {
                        "en": {
                            "name": "Chansey",
                        }
                    },
                },
            ),
            REPO_ROOT,
            "2026-04-14T17:02:59Z",
            refresh_embeddings=False,
        )
        upsert_catalog_card(
            self.service.connection,
            catalog_card(
                card_id="sm9_ja-66",
                name="Eevee & Snorlax-GX",
                set_name="タッグボルト",
                number="066/095",
                set_id="sm9_ja",
                language="Japanese",
                source_payload={
                    "id": "sm9_ja-66",
                    "name": "イーブイ&カビゴンGX",
                    "translation": {
                        "en": {
                            "name": "Eevee & Snorlax-GX",
                        }
                    },
                },
            ),
            REPO_ROOT,
            "2026-04-14T17:02:59Z",
            refresh_embeddings=False,
        )
        self.service.connection.commit()

        class FakeIndex:
            def __init__(self) -> None:
                self.entries = [
                    {
                        "providerCardId": "sm8_ja-66",
                        "name": "Chansey",
                        "collectorNumber": "066/095",
                        "setId": "sm8_ja",
                        "setName": "超爆インパクト",
                        "setSeries": "Sun & Moon",
                        "setPtcgoCode": "SM8",
                        "sourceProvider": "scrydex",
                        "sourceRecordID": "sm8_ja-66",
                        "imageUrl": "https://images.example/sm8_ja-66-large.png",
                        "language": "Japanese",
                    },
                    {
                        "providerCardId": "sm9_ja-66",
                        "name": "Eevee & Snorlax-GX",
                        "collectorNumber": "066/095",
                        "setId": "sm9_ja",
                        "setName": "タッグボルト",
                        "setSeries": "Sun & Moon",
                        "setPtcgoCode": "SM9",
                        "sourceProvider": "scrydex",
                        "sourceRecordID": "sm9_ja-66",
                        "imageUrl": "https://images.example/sm9_ja-66-large.png",
                        "language": "Japanese",
                    },
                ]

            def load(self) -> None:
                return None

        class FakeVisualMatcher:
            def __init__(self) -> None:
                self.index = FakeIndex()

            def match_payload(self, payload: dict[str, object], *, top_k: int = 10):  # noqa: ARG002
                return (
                    [
                        SimpleNamespace(
                            row_index=0,
                            similarity=0.83,
                            entry=self.index.entries[0],
                        )
                    ],
                    {
                        "source": "fake",
                        "internalTopK": top_k * 8,
                        "timings": {
                            "imageDecodeMs": 4.0,
                            "ensureRuntimeMs": 5.0,
                            "embeddingMs": 6.0,
                            "indexSearchMs": 7.0,
                            "matchPayloadMs": 8.0,
                        },
                    },
                )

        self.service._raw_visual_matcher = FakeVisualMatcher()

        payload = raw_payload(
            title_text_primary="なるイーブイ＆カビゴンタス HP",
            whole_card_text="なるイーブイ＆カビゴンタス HP 270 TAG TEAM",
            footer_band_text="TAG TEAMルール。 066/095 RR",
            collector_number_exact="066/095",
            crop_confidence=0.44,
        )
        payload["ocrAnalysis"]["normalizedTarget"] = {
            "usedFallback": True,
            "targetQuality": {
                "overallScore": 0.44,
                "reasons": [
                    "fallback",
                    "normalization:exact_reticle_fallback",
                ],
            },
        }

        response = self.service._resolve_raw_candidates_visual_hybrid(payload)

        self.assertEqual(response["resolverPath"], "visual_hybrid_index")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "sm9_ja-66")
        self.assertEqual(response["rawDecisionDebug"]["visualHybrid"]["retrievalStrategy"], "fallback_local_rescue")
        self.assertGreater(
            response["topCandidates"][0]["nameScore"],
            response["topCandidates"][1]["nameScore"],
        )

    def test_visual_hybrid_weak_fallback_fails_closed_when_signal_is_too_weak(self) -> None:
        class FakeIndex:
            entries: list[dict[str, object]] = []

            def load(self) -> None:
                return None

        class FakeVisualMatcher:
            def __init__(self) -> None:
                self.index = FakeIndex()

            def match_payload(self, payload: dict[str, object], *, top_k: int = 10):  # noqa: ARG002
                return (
                    [
                        SimpleNamespace(
                            row_index=0,
                            similarity=0.84,
                            entry={
                                "providerCardId": "swsh7-19",
                                "name": "Entei",
                                "collectorNumber": "019/203",
                                "setId": "swsh7",
                                "setName": "Evolving Skies",
                                "setSeries": "Sword & Shield",
                                "setPtcgoCode": "EVS",
                                "sourceProvider": "scrydex",
                                "sourceRecordID": "swsh7-19",
                                "imageUrl": "https://images.example/swsh7-19-large.png",
                                "language": "English",
                            },
                        ),
                    ],
                    {
                        "source": "fake",
                        "internalTopK": top_k * 8,
                        "timings": {
                            "imageDecodeMs": 4.0,
                            "ensureRuntimeMs": 5.0,
                            "embeddingMs": 6.0,
                            "indexSearchMs": 7.0,
                            "matchPayloadMs": 8.0,
                        },
                    },
                )

        self.service._raw_visual_matcher = FakeVisualMatcher()

        payload = raw_payload(
            title_text_primary="",
            whole_card_text="",
            footer_band_text="",
            collector_number_exact="",
            crop_confidence=0.42,
        )
        payload["ocrAnalysis"]["normalizedTarget"] = {
            "usedFallback": True,
            "targetQuality": {
                "overallScore": 0.42,
                "reasons": [
                    "fallback",
                    "normalization:exact_reticle_fallback",
                ],
            },
        }

        response = self.service._resolve_raw_candidates_visual_hybrid(payload)

        self.assertEqual(response["reviewDisposition"], "unsupported")
        self.assertEqual(response["topCandidates"], [])
        self.assertIn("card centered and filling more of the reticle", response["reviewReason"])

    def test_health_can_prewarm_visual_runtime(self) -> None:
        class FakeVisualMatcher:
            def prewarm(self):
                return {
                    "available": True,
                    "prewarmed": True,
                    "timings": {"indexLoadMs": 1.0, "runtimeLoadMs": 2.0, "totalMs": 3.0},
                }

        self.service._raw_visual_matcher = FakeVisualMatcher()

        payload = self.service.health(prewarm_visual=True)

        self.assertEqual(payload["status"], "ok")
        self.assertTrue(payload["visualRuntime"]["requested"])
        self.assertTrue(payload["visualRuntime"]["prewarmed"])


if __name__ == "__main__":
    unittest.main()
