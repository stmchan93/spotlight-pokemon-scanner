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
    build_raw_evidence,
    build_raw_retrieval_plan,
    connect,
    merge_raw_candidate_pools,
    score_raw_signals,
    search_cards_local_collector_set,
    search_cards_local_title_set,
    upsert_catalog_card,
)
from scrydex_adapter import (  # noqa: E402
    ScrydexRawSearchResult,
    best_remote_scrydex_raw_candidates,
    search_remote_scrydex_raw_candidates,
    search_remote_scrydex_slab_candidates,
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
    set_badge_hint: dict[str, object] | None = None,
    recognized_tokens: list[str] | None = None,
    crop_confidence: float = 1.0,
) -> dict[str, object]:
    return {
        "scanID": "scan-phase4",
        "resolverModeHint": "raw_card",
        "collectorNumber": collector_number_exact or None,
        "setHintTokens": set_hint_tokens or [],
        "promoCodeHint": None,
        "recognizedTokens": [{"text": token, "confidence": 0.9} for token in (recognized_tokens or [])],
        "cropConfidence": crop_confidence,
        "ocrAnalysis": {
            "rawEvidence": {
                "titleTextPrimary": title_text_primary or None,
                "titleTextSecondary": title_text_secondary or None,
                "collectorNumberExact": collector_number_exact or None,
                "collectorNumberPartial": collector_number_partial or None,
                "setHints": set_hint_tokens or [],
                "setBadgeHint": set_badge_hint,
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


def scrydex_remote_card(
    *,
    card_id: str,
    name: str,
    printed_number: str,
    expansion_id: str,
    expansion_name: str,
    expansion_code: str | None = None,
    translation_name: str | None = None,
) -> dict[str, object]:
    return {
        "id": card_id,
        "name": name,
        "language": "ja",
        "language_code": "JA",
        "printed_number": printed_number,
        "number": printed_number.split("/", 1)[0],
        "rarity": "UR",
        "artist": "DOM",
        "supertype": "Pokémon",
        "subtypes": ["Mega", "ex"],
        "types": ["Dragon"],
        "expansion": {
            "id": expansion_id,
            "name": expansion_name,
            "code": expansion_code,
            "series": "Scarlet & Violet",
            "release_date": "2026-01-01",
            "language": "ja",
        },
        "translation": {
            "en": {
                "name": translation_name or "Mega Dragonite ex",
                "rarity": "Ultra Rare",
                "supertype": "Pokémon",
                "subtypes": ["Mega", "ex"],
                "types": ["Dragon"],
            }
        },
        "images": [
            {
                "type": "front",
                "small": f"https://images.example/{card_id}-small.png",
                "large": f"https://images.example/{card_id}-large.png",
            }
        ],
        "variants": [],
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
            title_text_primary="Charizard ex",
            whole_card_text="Charizard ex",
            footer_band_text="OBF",
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
            title_text_primary="Sabrina's Slowbro",
            whole_card_text="Sabrina's Slowbro",
            footer_band_text="GYM1 60/132",
            collector_number_exact="60/132",
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

    def test_server_local_retrieval_helper_combines_plan_routes(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        payload = raw_payload(
            title_text_primary="Charizard ex",
            whole_card_text="Charizard ex",
            footer_band_text="OBF 223/197",
            collector_number_exact="223/197",
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

    def test_server_local_retrieval_does_not_fall_back_to_wrong_set_collector_only_when_set_is_trusted(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        upsert_catalog_card(
            service.connection,
            catalog_card(card_id="sv2-232", name="Wo-Chien ex", set_name="Paldea Evolved", number="232/193", set_id="sv2"),
            REPO_ROOT,
            "2026-04-09T04:00:00Z",
            refresh_embeddings=False,
        )
        service.connection.commit()

        payload = raw_payload(
            title_text_primary="ハクリューから進化 カイリコ",
            whole_card_text="ハクリューから進化 カイリコ",
            footer_band_text="M2a 232/193 MA",
            collector_number_exact="232/193",
            set_hint_tokens=["m2a"],
        )
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        plan = build_raw_retrieval_plan(evidence, signals)

        candidates = service._retrieve_local_raw_candidates(evidence, signals, plan)
        service.connection.close()

        self.assertEqual(candidates, [])

    def test_server_remote_retrieval_routes_japanese_raw_to_scrydex(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        payload = raw_payload(
            title_text_primary="ハクリューから進化 カイリコ",
            whole_card_text="ハクリューから進化 カイリコ",
            footer_band_text="M2a 232/193 MA",
            collector_number_exact="232/193",
            set_hint_tokens=["m2a"],
        )
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        plan = build_raw_retrieval_plan(evidence, signals)

        with patch("server.search_remote_scrydex_raw_candidates") as search_scrydex:
            search_scrydex.return_value = ScrydexRawSearchResult(
                cards=[
                    scrydex_remote_card(
                        card_id="m2a_ja-232",
                        name="メガカイリューex",
                        printed_number="232/193",
                        expansion_id="m2a_ja",
                        expansion_name="MEGAドリームex",
                        expansion_code="M2a",
                    )
                ],
                attempts=[
                    {
                        "query": 'printed_number:"232/193" expansion.code:m2a',
                        "count": 1,
                        "error": None,
                    }
                ],
            )

            candidates, debug = service._retrieve_remote_raw_candidates(evidence, signals, plan, api_key="test-key")

        service.connection.close()

        search_scrydex.assert_called_once()
        self.assertEqual(candidates[0]["id"], "m2a_ja-232")
        self.assertEqual(debug["queries"], ['printed_number:"232/193" expansion.code:m2a'])

    def test_best_remote_scrydex_raw_candidates_prefers_native_japanese_title_and_set_code(self) -> None:
        payload = raw_payload(
            title_text_primary="たね カビゴン uP",
            title_text_secondary="たね カビゴン HP",
            whole_card_text="たね カビゴン HP",
            footer_band_text="S10a 077/071 CHR",
            collector_number_exact="077/071",
            set_hint_tokens=["s10a"],
        )
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)

        candidates = best_remote_scrydex_raw_candidates(
            [
                scrydex_remote_card(
                    card_id="sv2p_ja-77",
                    name="セグレイブ",
                    printed_number="077/071",
                    expansion_id="sv2p_ja",
                    expansion_name="スノーハザード",
                    expansion_code="SV2P",
                    translation_name="Baxcalibur",
                ),
                scrydex_remote_card(
                    card_id="swsh10a_ja-77",
                    name="カビゴン",
                    printed_number="077/071",
                    expansion_id="swsh10a_ja",
                    expansion_name="ダークファンタズマ",
                    expansion_code="S10a",
                    translation_name="Snorlax",
                ),
            ],
            evidence,
            signals,
            limit=5,
        )

        self.assertTrue(candidates)
        self.assertEqual(candidates[0]["id"], "swsh10a_ja-77")
        self.assertEqual(candidates[0]["setPtcgoCode"], "S10a")

    def test_remote_scrydex_raw_search_caps_attempts_to_two_queries(self) -> None:
        payload = raw_payload(
            title_text_primary="Charizard ex",
            whole_card_text="Charizard ex",
            footer_band_text="OBF 223/197",
            collector_number_exact="223/197",
            set_hint_tokens=["OBF", "Obsidian Flames"],
        )
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        observed_queries: list[tuple[str, str]] = []

        def fake_run(
            query: str,
            *,
            include_prices: bool,
            page_size: int,
            request_type: str,
        ) -> list[dict[str, object]]:
            self.assertFalse(include_prices)
            observed_queries.append((query, request_type))
            return []

        with patch("scrydex_adapter._scrydex_run_cards_query", side_effect=fake_run):
            result = search_remote_scrydex_raw_candidates(evidence, signals, page_size=10)

        self.assertEqual(result.cards, [])
        self.assertLessEqual(len(observed_queries), 2)
        self.assertEqual(len(result.attempts), len(observed_queries))
        self.assertTrue(observed_queries)
        self.assertEqual(observed_queries[0][1], "raw_search")
        self.assertIn('printed_number:"223/197"', observed_queries[0][0])

    def test_server_resolve_raw_candidates_skips_remote_when_local_match_is_strong(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        payload = raw_payload(
            title_text_primary="Charizard ex",
            whole_card_text="Charizard ex",
            footer_band_text="223/197",
            collector_number_exact="223/197",
        )

        with patch.object(
            service,
            "_retrieve_remote_raw_candidates",
            side_effect=AssertionError("remote retrieval should not run"),
        ), patch.object(
            service,
            "_build_raw_match_response",
            return_value=(
                {
                    "scanID": "scan-phase4",
                    "topCandidates": [],
                    "confidence": "high",
                    "ambiguityFlags": [],
                    "matcherSource": "remoteHybrid",
                    "matcherVersion": "test",
                    "resolverMode": "raw_card",
                    "resolverPath": "visual_fallback",
                    "slabContext": None,
                    "reviewDisposition": "ready",
                    "reviewReason": None,
                },
                [],
            ),
        ), patch.object(service, "_emit_structured_log"), patch.object(service, "_log_raw_scan_event"):
            service._resolve_raw_candidates(payload, api_key=None)

        service.connection.close()

    def test_scrydex_slab_queries_normalize_label_number_and_infer_expansion_name(self) -> None:
        observed_queries: list[str] = []

        def fake_run(
            query: str,
            *,
            include_prices: bool,
            page_size: int,
            request_type: str,
        ) -> list[dict[str, object]]:
            self.assertFalse(include_prices)
            observed_queries.append(query)
            return []

        with patch("scrydex_adapter._scrydex_run_cards_query", side_effect=fake_run):
            result = search_remote_scrydex_slab_candidates(
                title_text="Charizard",
                label_text="2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 PSA 103377816",
                parsed_label_text=[
                    "2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 PSA 103377816",
                    "2022 POKEMON GO CHARIZARD-HOLO #010 NM 7 PSA 103377816",
                ],
                card_number="010",
                set_hint_tokens=["pokemon go", "pgo"],
                page_size=10,
            )

        self.assertEqual(result.cards, [])
        self.assertIn('name:"Charizard" number:"10" expansion.name:"pokemon go"', observed_queries)
        self.assertIn('name:"Charizard" number:"10" expansion.code:pgo', observed_queries)
        self.assertNotIn('printed_number:"010"', " ".join(observed_queries))


if __name__ == "__main__":
    unittest.main()
