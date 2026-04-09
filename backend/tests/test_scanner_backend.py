from __future__ import annotations

import copy
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    bucket_key_for_card,
    collector_numbers_equivalent,
    collector_number_api_query_values,
    collector_number_lookup_keys,
    connect,
    direct_lookup_candidate_indices,
    import_slab_sales,
    load_cards_json,
    load_index,
    normalized_set_hint_tokens,
    parse_psa_grade,
    parse_psa_cert_number,
    parse_slab_grader,
    recompute_slab_price_snapshot,
    resolve_catalog_json_path,
    resolver_mode_for_payload,
    slab_context_from_payload,
    runtime_supported_card_id,
    seed_catalog,
    upsert_card_price_summary,
    upsert_catalog_card,
    upsert_slab_price_snapshot,
    upsert_slab_sale,
)
from pricing_provider import PsaPricingResult, RawPricingResult  # noqa: E402
from scrydex_adapter import resolve_scrydex_psa_price, resolve_scrydex_raw_price  # noqa: E402
from server import SpotlightScanService  # noqa: E402

SAMPLE_CATALOG_PATH = BACKEND_ROOT / "catalog" / "sample_catalog.json"


def sample_scan_payload(
    *,
    collector_number: str,
    full_text: str,
    metadata_text: str,
    bottom_left_text: str,
    bottom_right_text: str = "",
    set_hint_tokens: list[str] | None = None,
    promo_code_hint: str | None = None,
    top_label_text: str = "",
    resolver_mode_hint: str | None = None,
    slab_grader: str | None = None,
    slab_grade: str | None = None,
    slab_cert_number: str | None = None,
    slab_barcode_payloads: list[str] | None = None,
    slab_grader_confidence: float | None = None,
    slab_grade_confidence: float | None = None,
    slab_cert_confidence: float | None = None,
    slab_card_number_raw: str | None = None,
    slab_classifier_reasons: list[str] | None = None,
    slab_recommended_lookup_path: str | None = None,
) -> dict[str, object]:
    label_source = " ".join(part for part in [top_label_text, full_text] if part)
    derived_slab_grader = slab_grader or (parse_slab_grader(label_source) if label_source else None)
    derived_slab_grade = slab_grade or (
        parse_psa_grade(label_source) if label_source and derived_slab_grader == "PSA" else None
    )
    derived_slab_cert = slab_cert_number or (parse_psa_cert_number(label_source) if label_source else None)
    derived_lookup_path = slab_recommended_lookup_path
    if derived_lookup_path is None:
        if derived_slab_grader == "PSA" and derived_slab_cert:
            derived_lookup_path = "psa_cert"
        elif derived_slab_grader:
            derived_lookup_path = "label_text_search"

    return {
        "scanID": str(uuid.uuid4()),
        "capturedAt": "2026-04-03T12:00:00Z",
        "clientContext": {
            "platform": "iOS",
            "appVersion": "1.0",
            "buildNumber": "1",
            "localeIdentifier": "en_US",
            "timeZoneIdentifier": "America/Los_Angeles",
        },
        "image": {
            "jpegBase64": None,
            "width": 744,
            "height": 1039,
        },
        "recognizedTokens": [],
        "fullRecognizedText": full_text,
        "metadataStripRecognizedText": metadata_text,
        "topLabelRecognizedText": top_label_text,
        "bottomLeftRecognizedText": bottom_left_text,
        "bottomRightRecognizedText": bottom_right_text,
        "collectorNumber": collector_number,
        "setHintTokens": set_hint_tokens or [],
        "promoCodeHint": promo_code_hint,
        "slabGrader": derived_slab_grader,
        "slabGrade": derived_slab_grade,
        "slabCertNumber": derived_slab_cert,
        "slabBarcodePayloads": slab_barcode_payloads or [],
        "slabGraderConfidence": slab_grader_confidence if derived_slab_grader else None,
        "slabGradeConfidence": slab_grade_confidence if derived_slab_grade else None,
        "slabCertConfidence": slab_cert_confidence if derived_slab_cert else None,
        "slabCardNumberRaw": slab_card_number_raw,
        "slabParsedLabelText": [],
        "slabClassifierReasons": slab_classifier_reasons or [],
        "slabRecommendedLookupPath": derived_lookup_path,
        "directLookupLikely": True,
        "resolverModeHint": resolver_mode_hint or ("raw_card" if collector_number else "unknown_fallback"),
        "cropConfidence": 1.0,
        "warnings": [],
    }


def cards_without_reference_images(cards: list[dict[str, object]]) -> list[dict[str, object]]:
    trimmed: list[dict[str, object]] = []
    for card in cards:
        cloned = copy.deepcopy(card)
        cloned["reference_image_path"] = None
        trimmed.append(cloned)
    return trimmed


def catalog_card(
    *,
    card_id: str,
    name: str,
    set_name: str,
    number: str,
    set_id: str,
    artist: str | None = None,
    national_pokedex_numbers: list[int] | None = None,
) -> dict[str, object]:
    return {
        "id": card_id,
        "name": name,
        "set_name": set_name,
        "number": number,
        "rarity": "Common",
        "variant": "Raw",
        "language": "English",
        "reference_image_path": None,
        "reference_image_url": f"https://images.example/{card_id}.png",
        "reference_image_small_url": f"https://images.example/{card_id}.png",
        "source": "test_seed",
        "source_record_id": card_id,
        "set_id": set_id,
        "set_series": "Test Series",
        "set_ptcgo_code": None,
        "set_release_date": "2000-01-01",
        "supertype": "Pokémon",
        "subtypes": [],
        "types": ["Psychic"],
        "artist": artist,
        "regulation_mark": None,
        "national_pokedex_numbers": national_pokedex_numbers or [],
        "tcgplayer": {},
        "cardmarket": {},
        "source_payload": {
            "id": card_id,
            "name": name,
            "number": number,
        },
        "imported_at": "2026-04-06T00:00:00Z",
    }


class SampleCatalogBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.database_path = Path(cls.tempdir.name) / "sample.sqlite"
        cls.connection = connect(cls.database_path)
        apply_schema(cls.connection, BACKEND_ROOT / "schema.sql")

        sample_cards = cards_without_reference_images(
            load_cards_json(SAMPLE_CATALOG_PATH)
        )
        seed_catalog(cls.connection, sample_cards, REPO_ROOT)
        cls.connection.commit()

        cls.index = load_index(cls.connection)
        cls.service = SpotlightScanService(cls.database_path, REPO_ROOT)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.connection.close()
        cls.tempdir.cleanup()

    def test_collector_number_lookup_keys_supports_promo_prefixes(self) -> None:
        keys = collector_number_lookup_keys("SVP 056")

        self.assertIn("svp 056", keys)
        self.assertIn("svp056", keys)
        self.assertIn("056", keys)
        self.assertIn("56", keys)

    def test_collector_number_lookup_keys_supports_left_side_of_slash(self) -> None:
        keys = collector_number_lookup_keys("146/144")

        self.assertIn("146/144", keys)
        self.assertIn("146", keys)

    def test_collector_number_lookup_keys_supports_zero_padded_simple_numbers(self) -> None:
        keys = collector_number_lookup_keys("010")

        self.assertIn("010", keys)
        self.assertIn("10", keys)

    def test_collector_number_api_query_values_supports_zero_padded_simple_numbers(self) -> None:
        values = collector_number_api_query_values("010")

        self.assertIn("010", values)
        self.assertIn("10", values)

    def test_runtime_supported_card_id_accepts_non_empty_ids(self) -> None:
        self.assertTrue(runtime_supported_card_id("me1-185"))
        self.assertTrue(runtime_supported_card_id("me2-130"))
        self.assertTrue(runtime_supported_card_id("ME3-21"))
        self.assertTrue(runtime_supported_card_id("sv8-238"))
        self.assertTrue(runtime_supported_card_id("swsh12pt5gg-GG37"))

    def test_normalized_set_hint_tokens_strips_language_suffixes(self) -> None:
        tokens = normalized_set_hint_tokens("G OBF EN 223/197 PALEN")

        self.assertIn("obf", tokens)
        self.assertIn("palen", tokens)
        self.assertIn("pal", tokens)

    def test_resolver_mode_detects_psa_label_text(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="2000 POKEMON NEO GENESIS #9 LUGIA HOLO 1ST EDITION PSA MINT 9",
            metadata_text="",
            bottom_left_text="",
            top_label_text="2000 POKEMON NEO GENESIS #9 LUGIA-HOLO 1ST EDITION PSA MINT 9",
            resolver_mode_hint="unknown_fallback",
        )

        self.assertEqual(resolver_mode_for_payload(payload), "psa_slab")

    def test_parse_psa_grade_extracts_numeric_grade(self) -> None:
        label_text = "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO 1ST EDITION PSA GEM MT 10 46408419"

        self.assertEqual(parse_psa_grade(label_text), "10")

    def test_resolve_scrydex_psa_price_supports_wrapped_payloads(self) -> None:
        payload = {
            "data": {
                "name": "Charizard",
                "variants": [
                    {
                        "name": "unlimitedHolofoil",
                        "prices": [
                            {
                                "type": "graded",
                                "company": "PSA",
                                "grade": "9",
                                "market": 199.93,
                                "low": 189.99,
                                "high": 210.00,
                                "currency": "USD",
                                "is_signed": False,
                                "is_error": False,
                                "is_perfect": False,
                            }
                        ],
                    }
                ],
            }
        }

        resolved = resolve_scrydex_psa_price(payload, "9")

        self.assertIsNotNone(resolved)
        variant, price = resolved
        self.assertEqual(variant["name"], "unlimitedHolofoil")
        self.assertEqual(price["company"], "PSA")
        self.assertEqual(str(price["grade"]), "9")

    def test_resolve_scrydex_psa_price_prefers_unlimited_over_first_edition_shadowless(self) -> None:
        payload = {
            "data": {
                "name": "Charizard",
                "variants": [
                    {
                        "name": "firstEditionShadowlessHolofoil",
                        "prices": [
                            {
                                "type": "graded",
                                "company": "PSA",
                                "grade": "9",
                                "market": 68662.16,
                                "currency": "USD",
                                "is_signed": False,
                                "is_error": False,
                                "is_perfect": False,
                            }
                        ],
                    },
                    {
                        "name": "unlimitedHolofoil",
                        "prices": [
                            {
                                "type": "graded",
                                "company": "PSA",
                                "grade": "9",
                                "market": 199.93,
                                "currency": "USD",
                                "is_signed": False,
                                "is_error": False,
                                "is_perfect": False,
                            }
                        ],
                    },
                ],
            }
        }

        resolved = resolve_scrydex_psa_price(payload, "9")

        self.assertIsNotNone(resolved)
        variant, price = resolved
        self.assertEqual(variant["name"], "unlimitedHolofoil")
        self.assertEqual(price["market"], 199.93)

    def test_resolve_scrydex_raw_price_supports_wrapped_payloads(self) -> None:
        payload = {
            "data": {
                "name": "Charizard",
                "variants": [
                    {
                        "name": "unlimitedHolofoil",
                        "prices": [
                            {
                                "type": "raw",
                                "condition": "NM",
                                "market": 497.31,
                                "low": 749.95,
                                "currency": "USD",
                                "is_signed": False,
                                "is_error": False,
                                "is_perfect": False,
                            }
                        ],
                    }
                ],
            }
        }

        resolved = resolve_scrydex_raw_price(payload)

        self.assertIsNotNone(resolved)
        variant, price = resolved
        self.assertEqual(variant["name"], "unlimitedHolofoil")
        self.assertEqual(price["type"], "raw")

    def test_parse_psa_grade_can_infer_adjective_only_grade(self) -> None:
        self.assertEqual(parse_psa_grade("2024 POKEMON SSP EN PIKACHU ex MINT 105239649"), "9")
        self.assertEqual(parse_psa_grade("2003 POKEMON SKYRIDGE CHARIZARD-HOLO GEM MT 48620163"), "10")

    def test_parse_psa_grade_supports_trailing_psa_token_layout(self) -> None:
        self.assertEqual(
            parse_psa_grade("1999 POKEMON GAME #58 PIKACHU NM YELLOW CHEEKS 7 PSA 101048532"),
            "7",
        )

    def test_parse_psa_cert_number_supports_nine_digit_values(self) -> None:
        self.assertEqual(
            parse_psa_cert_number("2024 POKEMON SSP EN PIKACHU ex SPECIAL ILLUSTRATION RARE PSA MINT 9 110045344"),
            "110045344",
        )

    def test_slab_context_prefers_explicit_payload_fields(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="PSA MINT 9",
            metadata_text="",
            bottom_left_text="",
            top_label_text="PSA MINT 9",
            resolver_mode_hint="psa_slab",
            slab_grader="PSA",
            slab_grade="9",
            slab_cert_number="110045344",
            slab_barcode_payloads=["https://www.psacard.com/cert/110045344"],
        )

        self.assertEqual(
            slab_context_from_payload(payload),
            {"grader": "PSA", "grade": "9", "certNumber": "110045344"},
        )

    def test_slab_context_supports_scored_yellow_cheeks_style_label(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="1999 POKEMON GAME #58 PIKACHU NM YELLOW CHEEKS 7 101048532",
            metadata_text="",
            bottom_left_text="",
            top_label_text="1999 POKEMON GAME #58 PIKACHU NM YELLOW CHEEKS 7 101048532",
            resolver_mode_hint="psa_slab",
            slab_grader="PSA",
            slab_grade="7",
            slab_cert_number="101048532",
            slab_grader_confidence=0.78,
            slab_grade_confidence=0.94,
            slab_cert_confidence=0.95,
            slab_card_number_raw="58",
            slab_classifier_reasons=["psa_red_band_detected", "barcode_region_detected"],
            slab_recommended_lookup_path="psa_cert",
        )

        self.assertEqual(
            slab_context_from_payload(payload),
            {"grader": "PSA", "grade": "7", "certNumber": "101048532"},
        )

    def test_slab_context_prefers_scored_psa_cert_lookup(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="1999 POKEMON GAME #58 PIKACHU NM YELLOW CHEEKS 7 101048532",
            metadata_text="",
            bottom_left_text="",
            top_label_text="1999 POKEMON GAME #58 PIKACHU NM YELLOW CHEEKS 7 101048532",
            resolver_mode_hint="psa_slab",
            slab_grader="PSA",
            slab_grade="7",
            slab_cert_number="101048532",
            slab_grader_confidence=0.78,
            slab_grade_confidence=0.94,
            slab_cert_confidence=0.95,
            slab_card_number_raw="58",
            slab_classifier_reasons=[
                "psa_red_band_detected",
                "barcode_region_detected",
                "grade_from_nm_layout",
            ],
            slab_recommended_lookup_path="psa_cert",
        )

        self.assertEqual(
            slab_context_from_payload(payload),
            {"grader": "PSA", "grade": "7", "certNumber": "101048532"},
        )

    def test_slab_context_rejects_low_confidence_scored_grader(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="1999 POKEMON GAME #58 PIKACHU NM YELLOW CHEEKS 7 101048532",
            metadata_text="",
            bottom_left_text="",
            top_label_text="1999 POKEMON GAME #58 PIKACHU NM YELLOW CHEEKS 7 101048532",
            resolver_mode_hint="psa_slab",
            slab_grader="PSA",
            slab_grade="7",
            slab_cert_number="101048532",
            slab_grader_confidence=0.41,
            slab_grade_confidence=0.94,
            slab_cert_confidence=0.95,
            slab_recommended_lookup_path="psa_cert",
        )

        self.assertIsNone(slab_context_from_payload(payload))

    def test_load_cards_json_normalizes_lightweight_cache_records(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            cache_path = Path(tempdir) / "catalog.json"
            cache_path.write_text(
                json.dumps(
                    [
                        {
                            "id": "pgo-11",
                            "name": "Radiant Charizard",
                            "set_name": "Pokémon GO",
                            "number": "11/78",
                            "image_url": "https://images.pokemontcg.io/pgo/11.png",
                        }
                    ]
                )
            )

            cards = load_cards_json(cache_path)

            self.assertEqual(cards[0]["id"], "pgo-11")
            self.assertEqual(cards[0]["set_id"], "pgo")
            self.assertEqual(cards[0]["reference_image_url"], "https://images.pokemontcg.io/pgo/11.png")
            self.assertEqual(cards[0]["reference_image_small_url"], "https://images.pokemontcg.io/pgo/11.png")
            self.assertEqual(cards[0]["variant"], "Raw")

    def test_resolve_catalog_json_path_defaults_to_sample_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            backend_root = Path(tempdir)

            resolved = resolve_catalog_json_path(backend_root)

            self.assertEqual(resolved, backend_root / "catalog" / "sample_catalog.json")

    def test_scan_log_payload_summarizes_match_without_request_blob(self) -> None:
        request_payload = sample_scan_payload(
            collector_number="SWSH286",
            full_text="Pikachu VMAX SWSH286",
            metadata_text="",
            bottom_left_text="SWSH286",
        )
        response_payload = {
            "scanID": request_payload["scanID"],
            "confidence": "high",
            "ambiguityFlags": [],
            "matcherSource": "remoteHybrid",
            "matcherVersion": "test",
            "resolverMode": "raw_card",
            "resolverPath": "direct_lookup",
            "reviewDisposition": "ready",
            "reviewReason": None,
        }
        top_candidates = [
            {
                "candidate": {
                    "id": "swshp-SWSH286",
                    "name": "Pikachu VMAX",
                    "setName": "SWSH Black Star Promos",
                    "number": "SWSH286",
                    "pricing": {
                        "source": "tcgplayer",
                        "pricingMode": "raw",
                        "market": 5.84,
                        "currencyCode": "USD",
                        "variant": "holofoil",
                        "isFresh": True,
                    },
                },
                "finalScore": 0.9921,
                "retrievalScore": 0.9,
                "rerankScore": 0.99,
                "reasons": [],
            }
        ]

        log_payload = self.service._scan_log_payload(request_payload, response_payload, top_candidates)

        self.assertEqual(log_payload["event"], "scan_match")
        self.assertEqual(log_payload["scanID"], request_payload["scanID"])
        self.assertEqual(log_payload["collectorNumber"], "SWSH286")
        self.assertEqual(log_payload["cropConfidence"], 1.0)
        self.assertTrue(log_payload["directLookupLikely"])
        self.assertEqual(log_payload["resolverMode"], "raw_card")
        self.assertEqual(log_payload["topCandidate"]["id"], "swshp-SWSH286")
        self.assertEqual(log_payload["topCandidate"]["price"], 5.84)
        self.assertNotIn("image", log_payload)

    def test_scan_error_log_payload_summarizes_scan_failure(self) -> None:
        request_payload = sample_scan_payload(
            collector_number="110/264",
            full_text="Jigglypuff 110/264 Fusion Strike",
            metadata_text="110/264",
            bottom_left_text="110/264",
            set_hint_tokens=["fusion", "strike"],
        )

        log_payload = self.service._scan_error_log_payload(
            request_payload,
            sqlite3.IntegrityError("FOREIGN KEY constraint failed"),
        )

        self.assertEqual(log_payload["event"], "scan_match_error")
        self.assertEqual(log_payload["severity"], "ERROR")
        self.assertEqual(log_payload["scanID"], request_payload["scanID"])
        self.assertEqual(log_payload["collectorNumber"], "110/264")
        self.assertEqual(log_payload["cropConfidence"], 1.0)
        self.assertTrue(log_payload["directLookupLikely"])
        self.assertEqual(log_payload["errorType"], "IntegrityError")
        self.assertIn("FOREIGN KEY constraint failed", log_payload["errorText"])
        self.assertNotIn("image", log_payload)

    def test_upsert_catalog_card_initializes_embedding_models_for_auto_import(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            database_path = Path(tempdir) / "auto_import.sqlite"
            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")

            upsert_catalog_card(
                connection,
                catalog_card(
                    card_id="swsh8-110",
                    name="Jigglypuff",
                    set_name="Fusion Strike",
                    number="110",
                    set_id="swsh8",
                    artist="Mizue",
                    national_pokedex_numbers=[39],
                ),
                REPO_ROOT,
                "2026-04-07T23:39:38Z",
                refresh_embeddings=False,
            )
            connection.commit()

            models = {
                row["id"]
                for row in connection.execute("SELECT id FROM embedding_models ORDER BY id").fetchall()
            }
            card_row = connection.execute(
                "SELECT id FROM cards WHERE id = ?",
                ("swsh8-110",),
            ).fetchone()
            metadata_embedding_row = connection.execute(
                """
                SELECT model_id
                FROM card_embeddings
                WHERE card_id = ? AND model_id = ?
                """,
                ("swsh8-110", "metadata-hash-v1"),
            ).fetchone()

            self.assertEqual(models, {"apple-vision-featureprint-v1", "metadata-hash-v1"})
            self.assertIsNotNone(card_row)
            self.assertIsNotNone(metadata_embedding_row)
            connection.close()

    def test_slab_context_extracts_grader_grade_and_cert(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="2000 POKEMON NEO GENESIS #9 LUGIA-HOLO 1ST EDITION PSA GEM MT 10 46408419",
            metadata_text="",
            bottom_left_text="",
            top_label_text="2000 POKEMON NEO GENESIS #9 LUGIA-HOLO 1ST EDITION PSA GEM MT 10 46408419",
            resolver_mode_hint="unknown_fallback",
        )

        self.assertEqual(
            slab_context_from_payload(payload),
            {"grader": "PSA", "grade": "10", "certNumber": "46408419"},
        )

    def test_direct_lookup_prefers_exact_set_and_number(self) -> None:
        payload = sample_scan_payload(
            collector_number="223/197",
            full_text="Charizard ex OBF EN 223/197",
            metadata_text="G OBF EN 223/197",
            bottom_left_text="G OBF EN 223/197",
            set_hint_tokens=["obf"],
        )

        candidate_indices = direct_lookup_candidate_indices(self.index, payload)

        self.assertGreater(len(candidate_indices), 0)
        self.assertEqual(self.index.cards[candidate_indices[0]].id, "pokemon-charizard-ex-223-197")

    def test_match_scan_uses_direct_lookup_for_set_plus_number(self) -> None:
        payload = sample_scan_payload(
            collector_number="223/197",
            full_text="Charizard ex OBF EN 223/197",
            metadata_text="G OBF EN 223/197",
            bottom_left_text="G OBF EN 223/197",
            set_hint_tokens=["obf"],
        )

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertEqual(response["resolverPath"], "direct_lookup")
        self.assertEqual(response["resolverMode"], "raw_card")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "pokemon-charizard-ex-223-197")
        self.assertIn(response["confidence"], {"high", "medium"})

    def test_match_scan_handles_promo_direct_lookup(self) -> None:
        payload = sample_scan_payload(
            collector_number="SVP 056",
            full_text="Charizard ex SVP EN 056",
            metadata_text="G SVP EN 056",
            bottom_left_text="G SVP EN 056",
            set_hint_tokens=["svp"],
            promo_code_hint="SVP",
        )

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertEqual(response["resolverPath"], "direct_lookup")
        self.assertEqual(response["resolverMode"], "raw_card")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "pokemon-charizard-ex-svp-056")
        self.assertIn(response["confidence"], {"high", "medium"})

    def test_search_normalizes_trainer_gallery_numbers(self) -> None:
        response = self.service.search("umbreon vmax tg23/tg30")
        results = response["results"]

        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["id"], "pokemon-umbreon-vmax-tg23")

    def test_health_reports_supported_and_unsupported_scopes(self) -> None:
        health = self.service.health()

        # Raw pricing can still use Pokemon TCG API without credentials.
        self.assertIn(health["activeRawPricingProvider"], ["none", "pokemontcg_api", "scrydex"])
        self.assertIn(health["activePsaPricingProvider"], ["none", "pricecharting", "scrydex"])
        self.assertIn("single_card_photo", health["supportedScanScopes"])
        self.assertIn("multi_card_photo", health["unsupportedScanScopes"])

    def test_unmatched_scans_reports_likely_unsupported_raw_scan(self) -> None:
        payload = sample_scan_payload(
            collector_number="130/094",
            full_text="Mega Charizard X PFL 130/094",
            metadata_text="PFL 130/094",
            bottom_left_text="PFL 130/094",
            set_hint_tokens=["pfl"],
        )
        payload["directLookupLikely"] = False

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)
        summary = self.service.unmatched_scans(limit=10)

        self.assertEqual(response["reviewDisposition"], "unsupported")
        self.assertGreaterEqual(summary["summary"]["openReviewCount"], 1)
        self.assertGreaterEqual(summary["summary"]["likelyUnsupportedCount"], 1)
        self.assertEqual(summary["items"][0]["reviewDisposition"], "unsupported")

    def test_provider_status_includes_unmatched_review_counts(self) -> None:
        payload = sample_scan_payload(
            collector_number="130/094",
            full_text="Mega Charizard X POR EN 130/094",
            metadata_text="J POR EN 130/094",
            bottom_left_text="J POR EN 130/094",
            set_hint_tokens=["por"],
        )
        with patch("server.search_remote_cards", return_value=[]):
            self.service.match_scan(payload)

        status = self.service.provider_status()

        # Provider status should include provider list
        self.assertIn("providers", status)
        self.assertGreater(len(status["providers"]), 0)
        self.assertIn("unmatchedScanCount", status)
        self.assertIn("likelyUnsupportedCount", status)
        self.assertGreaterEqual(status["unmatchedScanCount"], 1)

    def test_explicit_slab_mode_without_readable_psa_label_returns_unsupported(self) -> None:
        payload = sample_scan_payload(
            collector_number="223/197",
            full_text="Charizard ex OBF EN 223/197",
            metadata_text="OBF EN 223/197",
            bottom_left_text="OBF EN 223/197",
            resolver_mode_hint="psa_slab",
        )

        response = self.service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["reviewDisposition"], "unsupported")
        self.assertIn("PSA label", response["reviewReason"])
        self.assertEqual(response["topCandidates"], [])

    def test_recent_pricing_refresh_failures_can_be_reported(self) -> None:
        self.service.record_pricing_refresh_failure(
            card_id="pokemon-charizard-ex-223-197",
            grader=None,
            grade=None,
            source="scrydex",
            error_text="provider timeout",
        )

        payload = self.service.recent_pricing_refresh_failures(limit=5)

        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["items"][0]["source"], "scrydex")
        self.assertEqual(payload["items"][0]["errorText"], "provider timeout")


class CatalogImportFlowTests(unittest.TestCase):
    def test_catalog_miss_queries_use_printed_total_and_prefixed_numbers(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "catalog_queries.sqlite"
            cards_path = temp_path / "catalog_seed.json"
            imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)
            cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)
            queries = service._catalog_miss_queries(  # noqa: SLF001 - direct unit coverage for query builder
                sample_scan_payload(
                    collector_number="TG29/TG30",
                    full_text="Pikachu VMAX TG29/TG30",
                    metadata_text="TG29/TG30",
                    bottom_left_text="TG29/TG30",
                    set_hint_tokens=[],
                    promo_code_hint="TG",
                )
            )

            self.assertIn('set.printedTotal:30 number:"TG29"', queries)
            self.assertIn('set.ptcgoCode:TG number:"TG29"', queries)
            service.connection.close()

    def test_catalog_miss_queries_support_official_meg_set_hints(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "catalog_queries_meg.sqlite"
            cards_path = temp_path / "catalog_seed.json"
            imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)
            cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)
            queries = service._catalog_miss_queries(  # noqa: SLF001 - direct unit coverage for query builder
                sample_scan_payload(
                    collector_number="185/132",
                    full_text="Lt. Surge's Bargain 185/132 MEG",
                    metadata_text="185/132 MEG",
                    bottom_left_text="185/132",
                    set_hint_tokens=["meg"],
                    resolver_mode_hint="raw_card",
                )
            )

            self.assertIn('set.printedTotal:132 number:"185"', queries)
            self.assertIn('set.ptcgoCode:MEG number:"185"', queries)
            self.assertIn('set.id:me1 number:"185"', queries)
            service.connection.close()

    def test_match_scan_can_import_catalog_miss_and_retry(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "catalog_miss.sqlite"
            imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=None)
            remote_card = {
                "id": "sv8-238",
                "name": "Pikachu ex",
                "number": "238",
                "supertype": "Pokémon",
                "subtypes": ["Basic", "ex"],
                "types": ["Lightning"],
                "artist": "Susumu Maeya",
                "rarity": "Special Illustration Rare",
                "nationalPokedexNumbers": [25],
                "regulationMark": "H",
                "rules": [],
                "images": {
                    "small": "https://example.com/pikachu-small.png",
                    "large": "https://example.com/pikachu-large.png",
                },
                "set": {
                    "id": "sv8",
                    "name": "Surging Sparks",
                    "series": "Scarlet & Violet",
                    "printedTotal": 191,
                    "ptcgoCode": "SSP",
                    "releaseDate": "2024/11/08",
                },
                "tcgplayer": {},
                "cardmarket": {},
            }
            payload = sample_scan_payload(
                collector_number="238/191",
                full_text="Pikachu ex SSP EN 238/191",
                metadata_text="SSP EN 238/191",
                bottom_left_text="SSP EN 238/191",
                set_hint_tokens=["ssp"],
            )
            payload["directLookupLikely"] = False

            with patch("server.search_remote_cards", return_value=[remote_card]):
                response = service.match_scan(payload)

            self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "sv8-238")
            self.assertEqual(response.get("catalogMissImportedCardID"), "sv8-238")
            self.assertEqual(service.card_detail("sv8-238")["card"]["id"], "sv8-238")
            service.connection.close()

    def test_match_scan_can_import_catalog_miss_without_api_key_using_printed_total(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "catalog_miss_printed_total.sqlite"
            cards_path = temp_path / "catalog_seed.json"
            imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)
            cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)
            remote_card = {
                "id": "sv1-204",
                "name": "Slowpoke",
                "number": "204",
                "supertype": "Pokémon",
                "subtypes": ["Basic"],
                "types": ["Water"],
                "artist": "Toshinao Aoki",
                "rarity": "Illustration Rare",
                "nationalPokedexNumbers": [79],
                "regulationMark": "G",
                "rules": [],
                "images": {
                    "small": "https://example.com/slowpoke-small.png",
                    "large": "https://example.com/slowpoke-large.png",
                },
                "set": {
                    "id": "sv1",
                    "name": "Scarlet & Violet",
                    "series": "Scarlet & Violet",
                    "printedTotal": 198,
                    "ptcgoCode": "SVI",
                    "releaseDate": "2023/03/31",
                },
                "tcgplayer": {},
                "cardmarket": {},
            }
            payload = sample_scan_payload(
                collector_number="204/198",
                full_text="Illus. Toshinao Aoki 204/198",
                metadata_text="204/198",
                bottom_left_text="Illus. Toshinao Aoki 204/198",
                set_hint_tokens=[],
            )

            try:
                with patch("server.search_remote_cards", return_value=[remote_card]):
                    response = service.match_scan(payload)

                self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "sv1-204")
                self.assertEqual(response.get("catalogMissImportedCardID"), "sv1-204")
            finally:
                service.connection.close()

    def test_match_scan_does_not_live_match_from_printed_total_only_without_seeded_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "live_printed_total.sqlite"

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=None)
            payload = sample_scan_payload(
                collector_number="011/078",
                full_text="Radiant Charizard 011/078",
                metadata_text="Radiant Charizard 011/078",
                bottom_left_text="Radiant Charizard 011/078",
            )

            try:
                with patch(
                    "server.search_remote_cards",
                    side_effect=AssertionError("printed-total-only empty-db scans should not trigger live catalog search"),
                ):
                    response = service.match_scan(payload)

                self.assertEqual(response["topCandidates"], [])
                self.assertEqual(response["reviewDisposition"], "needs_review")
            finally:
                service.connection.close()

    def test_refresh_card_pricing_can_auto_import_missing_card(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "refresh_import.sqlite"
            imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=None)
            remote_card = {
                "id": "sv8-238",
                "name": "Pikachu ex",
                "number": "238",
                "supertype": "Pokémon",
                "subtypes": ["Basic", "ex"],
                "types": ["Lightning"],
                "artist": "Susumu Maeya",
                "rarity": "Special Illustration Rare",
                "images": {
                    "small": "https://example.com/pikachu-small.png",
                    "large": "https://example.com/pikachu-large.png",
                },
                "set": {
                    "id": "sv8",
                    "name": "Surging Sparks",
                    "series": "Scarlet & Violet",
                    "printedTotal": 191,
                    "ptcgoCode": "SSP",
                    "releaseDate": "2024/11/08",
                },
                "tcgplayer": {},
                "cardmarket": {},
            }

            try:
                self.assertIsNone(service.card_detail("sv8-238"))

                with patch("server.fetch_card_by_id", return_value=remote_card):
                    detail = service.refresh_card_pricing("sv8-238", api_key="token")

                self.assertIsNotNone(detail)
                assert detail is not None
                self.assertEqual(detail["card"]["id"], "sv8-238")
                self.assertEqual(service.card_detail("sv8-238")["card"]["id"], "sv8-238")
            finally:
                service.connection.close()


class ImportedCatalogPricingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.database_path = Path(cls.tempdir.name) / "imported.sqlite"
        cls.connection = connect(cls.database_path)
        apply_schema(cls.connection, BACKEND_ROOT / "schema.sql")

        seed_catalog(
            cls.connection,
            [
                catalog_card(card_id="svp-56", name="Charizard ex", set_name="Scarlet & Violet Promo", number="SVP 056", set_id="svp"),
                catalog_card(card_id="sv3-223", name="Charizard ex", set_name="Obsidian Flame", number="223/197", set_id="sv3"),
                catalog_card(card_id="sv8-238", name="Pikachu ex", set_name="Surging Sparks", number="238/191", set_id="sv8"),
                catalog_card(card_id="base1-58", name="Pikachu", set_name="Base", number="58/102", set_id="base1"),
                catalog_card(card_id="pgo-10", name="Charizard", set_name="Pokémon GO", number="10/78", set_id="pgo"),
                catalog_card(card_id="neo1-9", name="Lugia", set_name="Neo Genesis", number="9/111", set_id="neo1"),
                catalog_card(card_id="base1-2", name="Blastoise", set_name="Base", number="2/102", set_id="base1"),
                catalog_card(card_id="base1-6", name="Gyarados", set_name="Base", number="6/102", set_id="base1"),
                catalog_card(card_id="base1-12", name="Ninetales", set_name="Base", number="12/102", set_id="base1"),
                catalog_card(card_id="base6-3", name="Charizard", set_name="Legendary Collection", number="3/110", set_id="base6"),
                catalog_card(card_id="base6-64", name="Snorlax", set_name="Legendary Collection", number="64/110", set_id="base6"),
                catalog_card(card_id="ex13-103", name="Mewtwo", set_name="Holon Phantoms", number="103", set_id="ex13"),
                catalog_card(card_id="sm9-170", name="Latias & Latios GX", set_name="Team Up", number="170/181", set_id="sm9"),
                catalog_card(card_id="sv3pt5-168", name="Charmander", set_name="151", number="168/165", set_id="sv3pt5"),
                catalog_card(card_id="pop5-16", name="Espeon", set_name="POP Series 5", number="16/17", set_id="pop5"),
                catalog_card(card_id="ecard3-146", name="Charizard", set_name="Skyridge", number="146", set_id="ecard3"),
                catalog_card(card_id="swsh12pt5gg-GG37", name="Simisear VSTAR", set_name="Crown Zenith Galarian Gallery", number="GG37/GG70", set_id="swsh12pt5gg"),
                catalog_card(card_id="me1-185", name="Lt. Surge's Bargain", set_name="Mega Evolution", number="185/132", set_id="me1"),
            ],
            REPO_ROOT,
        )
        cls.connection.commit()

        upsert_card_price_summary(
            cls.connection,
            card_id="svp-56",
            source="tcgplayer",
            currency_code="USD",
            variant="holofoil",
            low_price=10.5,
            market_price=12.34,
            mid_price=12.34,
            high_price=15.0,
            direct_low_price=None,
            trend_price=12.34,
            source_updated_at="2026/04/06",
            source_url="https://prices.pokemontcg.io/tcgplayer/svp-56",
            payload={"provider": "pokemontcg_api"},
        )
        upsert_card_price_summary(
            cls.connection,
            card_id="sv3-223",
            source="tcgplayer",
            currency_code="USD",
            variant="holofoil",
            low_price=120.0,
            market_price=135.0,
            mid_price=135.0,
            high_price=160.0,
            direct_low_price=None,
            trend_price=135.0,
            source_updated_at="2026/04/06",
            source_url="https://prices.pokemontcg.io/tcgplayer/sv3-223",
            payload={"provider": "pokemontcg_api"},
        )

        neo_bucket = bucket_key_for_card(cls.connection, "neo1-9")
        base_bucket = bucket_key_for_card(cls.connection, "base1-2")

        slab_sales = [
            {
                "cardID": "neo1-9",
                "grader": "PSA",
                "grade": "10",
                "salePrice": 4100.0,
                "saleDate": "2025-12-20T00:00:00+00:00",
                "source": "test_fixture",
            },
            {
                "cardID": "neo1-9",
                "grader": "PSA",
                "grade": "10",
                "salePrice": 4550.0,
                "saleDate": "2026-02-18T00:00:00+00:00",
                "source": "test_fixture",
            },
            {
                "cardID": "neo1-9",
                "grader": "PSA",
                "grade": "9",
                "salePrice": 1180.0,
                "saleDate": "2026-01-14T00:00:00+00:00",
                "source": "test_fixture",
            },
            {
                "cardID": "neo1-9",
                "grader": "PSA",
                "grade": "9",
                "salePrice": 1265.0,
                "saleDate": "2026-03-01T00:00:00+00:00",
                "source": "test_fixture",
            },
            {
                "cardID": "ex13-103",
                "grader": "PSA",
                "grade": "9",
                "salePrice": 860.0,
                "saleDate": "2026-01-08T00:00:00+00:00",
                "source": "test_fixture",
            },
            {
                "cardID": "ex13-103",
                "grader": "PSA",
                "grade": "9",
                "salePrice": 920.0,
                "saleDate": "2026-02-21T00:00:00+00:00",
                "source": "test_fixture",
            },
            {
                "cardID": "base1-2",
                "grader": "PSA",
                "grade": "10",
                "salePrice": 9000.0,
                "saleDate": "2024-08-15T00:00:00+00:00",
                "source": "test_fixture",
            },
            {
                "cardID": "neo1-9",
                "grader": "PSA",
                "grade": "10",
                "salePrice": 3500.0,
                "saleDate": "2024-08-15T00:00:00+00:00",
                "source": "test_fixture",
                "bucketKey": neo_bucket,
            },
            {
                "cardID": "base6-3",
                "grader": "PSA",
                "grade": "10",
                "salePrice": 9600.0,
                "saleDate": "2026-01-20T00:00:00+00:00",
                "source": "test_fixture",
                "bucketKey": base_bucket,
            },
            {
                "cardID": "base6-64",
                "grader": "PSA",
                "grade": "10",
                "salePrice": 9750.0,
                "saleDate": "2026-02-07T00:00:00+00:00",
                "source": "test_fixture",
                "bucketKey": base_bucket,
            },
            {
                "cardID": "base6-3",
                "grader": "PSA",
                "grade": "10",
                "salePrice": 8200.0,
                "saleDate": "2024-08-12T00:00:00+00:00",
                "source": "test_fixture",
                "bucketKey": base_bucket,
            },
            {
                "cardID": "base6-64",
                "grader": "PSA",
                "grade": "10",
                "salePrice": 8350.0,
                "saleDate": "2024-08-18T00:00:00+00:00",
                "source": "test_fixture",
                "bucketKey": base_bucket,
            },
            {
                "cardID": "sv8-238",
                "grader": "PSA",
                "grade": "9",
                "salePrice": 298.0,
                "saleDate": "2026-04-02T00:00:00+00:00",
                "source": "psa_cert_page",
                "sourceListingID": "168111376698",
                "certNumber": "110045344",
            },
            {
                "cardID": "sv8-238",
                "grader": "PSA",
                "grade": "9",
                "salePrice": 295.0,
                "saleDate": "2026-04-02T00:00:00+00:00",
                "source": "psa_cert_page",
                "sourceListingID": "178013494631",
                "certNumber": "151934029",
            },
            {
                "cardID": "sv8-238",
                "grader": "PSA",
                "grade": "9",
                "salePrice": 300.0,
                "saleDate": "2026-04-02T00:00:00+00:00",
                "source": "psa_cert_page",
                "sourceListingID": "376966738366",
                "certNumber": "129608866",
            },
            {
                "cardID": "sv8-238",
                "grader": "PSA",
                "grade": "9",
                "salePrice": 299.99,
                "saleDate": "2026-04-02T00:00:00+00:00",
                "source": "psa_cert_page",
                "sourceListingID": "358348417611",
                "certNumber": "144553635",
            },
            {
                "cardID": "sv8-238",
                "grader": "PSA",
                "grade": "9",
                "salePrice": 285.0,
                "saleDate": "2026-04-02T00:00:00+00:00",
                "source": "psa_cert_page",
                "sourceListingID": "327075167453",
                "certNumber": "141020836",
            },
        ]
        for sale in slab_sales:
            upsert_slab_sale(cls.connection, sale)

        recompute_slab_price_snapshot(cls.connection, "neo1-9", "PSA", "10")
        recompute_slab_price_snapshot(cls.connection, "neo1-9", "PSA", "9")
        recompute_slab_price_snapshot(cls.connection, "ex13-103", "PSA", "10")
        recompute_slab_price_snapshot(cls.connection, "base1-2", "PSA", "10")
        recompute_slab_price_snapshot(cls.connection, "sv8-238", "PSA", "9")

        cls.service = SpotlightScanService(cls.database_path, REPO_ROOT)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.connection.close()
        cls.tempdir.cleanup()

    def _make_catalog_service(
        self,
        database_name: str,
        cards: list[dict[str, object]],
    ) -> SpotlightScanService:
        tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(tempdir.cleanup)

        temp_path = Path(tempdir.name)
        database_path = temp_path / f"{database_name}.sqlite"
        cards_path = temp_path / "catalog_seed.json"
        trimmed_cards = cards_without_reference_images(cards)
        cards_path.write_text(json.dumps(trimmed_cards, indent=2))

        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        seed_catalog(connection, trimmed_cards, REPO_ROOT)
        connection.commit()
        connection.close()

        service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)
        self.addCleanup(service.connection.close)
        return service

    def test_card_detail_includes_normalized_pricing(self) -> None:
        detail = self.service.card_detail("svp-56")

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["id"], "svp-56")
        self.assertEqual(detail["card"]["pricing"]["source"], "tcgplayer")
        self.assertIsNotNone(detail["card"]["pricing"]["market"])
        self.assertIsNotNone(detail["setID"])
        self.assertIsNotNone(detail["setSeries"])

    def test_imported_match_scan_returns_priced_candidate(self) -> None:
        payload = sample_scan_payload(
            collector_number="223/197",
            full_text="Charizard ex OBF EN 223/197",
            metadata_text="G OBF EN 223/197",
            bottom_left_text="G OBF EN 223/197",
            set_hint_tokens=["obf"],
        )

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertEqual(response["resolverPath"], "direct_lookup")
        self.assertEqual(response["resolverMode"], "raw_card")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "sv3-223")
        self.assertIsNotNone(response["topCandidates"][0]["candidate"]["pricing"]["market"])
        self.assertIn(response["confidence"], {"high", "medium"})

    def test_imported_match_scan_supports_psa_label_mode(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="2000 POKEMON NEO GENESIS #9 LUGIA HOLO 1ST EDITION PSA MINT 9",
            metadata_text="",
            bottom_left_text="",
            top_label_text="2000 POKEMON NEO GENESIS #9 LUGIA-HOLO 1ST EDITION PSA MINT 9 131082187",
            resolver_mode_hint="unknown_fallback",
        )

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "neo1-9")
        self.assertEqual(response["topCandidates"][0]["candidate"]["pricing"]["pricingMode"], "psa_grade_estimate")
        self.assertEqual(response["topCandidates"][0]["candidate"]["pricing"]["grade"], "9")

    def test_import_slab_sales_dedupes_listing_ids(self) -> None:
        summary = import_slab_sales(
            self.connection,
            [
                {
                    "cardID": "neo1-9",
                    "grader": "PSA",
                    "grade": "10",
                    "salePrice": 4550.0,
                    "saleDate": "2026-02-18T00:00:00+00:00",
                    "source": "test_fixture",
                    "sourceListingID": "neo1-9-psa10-2",
                },
                {
                    "cardID": "neo1-9",
                    "grader": "PSA",
                    "grade": "10",
                    "salePrice": 4550.0,
                    "saleDate": "2026-02-18T00:00:00+00:00",
                    "source": "test_fixture",
                    "sourceListingID": "neo1-9-psa10-2",
                },
            ],
        )

        self.assertEqual(summary["inserted"], 1)
        self.assertEqual(summary["skippedDuplicates"], 1)

    def test_import_slab_sales_creates_on_demand_snapshot(self) -> None:
        summary = import_slab_sales(
            self.connection,
            [
                {
                    "cardID": "sv3-223",
                    "grader": "PSA",
                    "grade": "10",
                    "salePrice": 1800.0,
                    "saleDate": "2026-03-20T00:00:00+00:00",
                    "source": "manual_import",
                    "sourceListingID": "sv3-223-psa10-1",
                }
            ],
        )

        self.assertEqual(summary["inserted"], 1)
        detail = self.service.card_detail("sv3-223", grader="PSA", grade="10")
        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["pricing"]["pricingMode"], "psa_grade_estimate")
        self.assertEqual(detail["card"]["pricing"]["pricingTier"], "exact_same_grade")

    def test_service_can_return_slab_sales_for_card(self) -> None:
        payload = self.service.slab_sales("neo1-9", grader="PSA", grade="10", limit=5)

        self.assertGreaterEqual(len(payload["sales"]), 1)
        self.assertEqual(payload["sales"][0]["grader"], "PSA")
        self.assertEqual(payload["sales"][0]["grade"], "10")

    def test_card_detail_prefers_exact_slab_snapshot_when_grade_context_exists(self) -> None:
        detail = self.service.card_detail("neo1-9", grader="PSA", grade="10")

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["pricing"]["pricingMode"], "psa_grade_estimate")
        self.assertEqual(detail["card"]["pricing"]["pricingTier"], "exact_same_grade")
        self.assertEqual(detail["card"]["pricing"]["grade"], "10")
        self.assertEqual(detail["slabContext"], {"grader": "PSA", "grade": "10"})

    def test_card_detail_does_not_fall_back_to_raw_pricing_for_psa_context(self) -> None:
        detail = self.service.card_detail("svp-56", grader="PSA", grade="10")

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertIsNone(detail["card"]["pricing"])
        self.assertEqual(detail["slabContext"], {"grader": "PSA", "grade": "10"})

    def test_card_detail_can_model_from_nearby_grades(self) -> None:
        detail = self.service.card_detail("ex13-103", grader="PSA", grade="10")

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["pricing"]["pricingMode"], "psa_grade_estimate")
        self.assertEqual(detail["card"]["pricing"]["pricingTier"], "same_card_grade_ladder")
        self.assertEqual(detail["card"]["pricing"]["grade"], "10")

    def test_card_detail_can_use_bucket_index_model(self) -> None:
        detail = self.service.card_detail("base1-2", grader="PSA", grade="10")

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["pricing"]["pricingMode"], "psa_grade_estimate")
        self.assertEqual(detail["card"]["pricing"]["pricingTier"], "bucket_index_model")
        self.assertEqual(detail["card"]["pricing"]["grade"], "10")

    def test_card_detail_supports_pikachu_surging_sparks_psa_9(self) -> None:
        detail = self.service.card_detail("sv8-238", grader="PSA", grade="9")

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["pricing"]["pricingMode"], "psa_grade_estimate")
        self.assertEqual(detail["card"]["pricing"]["pricingTier"], "exact_same_grade")
        self.assertEqual(detail["card"]["pricing"]["grade"], "9")
        self.assertEqual(detail["card"]["pricing"]["compCount"], 5)
        self.assertAlmostEqual(detail["card"]["pricing"]["market"], 295.6, places=1)

    def test_imported_match_scan_supports_more_realworld_psa_labels(self) -> None:
        cases = [
            (
                "mewtwo_gold_star",
                "2006 POKEMON MEWTWO-HOLO EX HOLON PHANT. - GLD. STAR PSA GEM MT 10 #103 20041408",
                "ex13-103",
            ),
            (
                "charizard_skyridge",
                "2003 POKEMON SKYRIDGE #146 CHARIZARD-HOLO PSA GEM MT 10 48620163",
                "ecard3-146",
            ),
            (
                "charizard_legendary_collection",
                "2002 POKEMON #3 CHARIZARD-REV. FOIL LEGENDARY COLLECTION PSA GEM MT 10 28620375",
                "base6-3",
            ),
            (
                "snorlax_legendary_collection",
                "2002 POKEMON #64 SNORLAX - REV FOIL LEGENDARY COLLECTION PSA GEM MT 10 27833377",
                "base6-64",
            ),
            (
                "latias_latios_team_up",
                "2019 POKEMON SUN & MOON #170 FA/LATIAS & LATIOS GX TEAM UP PSA GEM MT 10 107288935",
                "sm9-170",
            ),
            (
                "pikachu_surging_sparks",
                "2024 POKEMON SSP EN-SURGING SPARKS #238 PIKACHU ex SPECIAL ILLUSTRATION RARE PSA MINT 9 110045344",
                "sv8-238",
            ),
        ]

        for label, label_text, expected_id in cases:
            with self.subTest(label=label):
                payload = sample_scan_payload(
                    collector_number="",
                    full_text=label_text,
                    metadata_text="",
                    bottom_left_text="",
                    top_label_text=label_text,
                    resolver_mode_hint="unknown_fallback",
                )

                response = self.service.match_scan(payload)

                self.assertEqual(response["resolverMode"], "psa_slab")
                self.assertEqual(response["resolverPath"], "psa_label")
                self.assertEqual(response["topCandidates"][0]["candidate"]["id"], expected_id)

    def test_imported_match_scan_psa_mode_does_not_surface_raw_candidate_pricing_when_only_raw_exists(self) -> None:
        upsert_card_price_summary(
            self.connection,
            card_id="sm9-170",
            source="tcgplayer",
            currency_code="USD",
            variant="holofoil",
            low_price=210.0,
            market_price=249.56,
            mid_price=249.56,
            high_price=300.0,
            direct_low_price=None,
            trend_price=249.56,
            source_updated_at="2026/04/06",
            source_url="https://prices.pokemontcg.io/tcgplayer/sm9-170",
            payload={"provider": "pokemontcg_api"},
        )
        payload = sample_scan_payload(
            collector_number="",
            full_text="2019 POKEMON SUN & MOON #170 FA/LATIAS & LATIOS GX TEAM UP PSA GEM MT 10 107288935",
            metadata_text="",
            bottom_left_text="",
            top_label_text="2019 POKEMON SUN & MOON #170 FA/LATIAS & LATIOS GX TEAM UP PSA GEM MT 10 107288935",
            resolver_mode_hint="unknown_fallback",
        )

        response = self.service.match_scan(payload)
        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "sm9-170")
        self.assertNotIn("pricing", response["topCandidates"][0]["candidate"])

    def test_imported_match_scan_supports_explicit_psa_cert_lookup(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="PSA MINT 9",
            metadata_text="",
            bottom_left_text="",
            top_label_text="PSA MINT 9",
            resolver_mode_hint="psa_slab",
            slab_grader="PSA",
            slab_grade="9",
            slab_cert_number="110045344",
            slab_barcode_payloads=["https://www.psacard.com/cert/110045344"],
        )

        response = self.service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "sv8-238")
        self.assertEqual(response["slabContext"]["certNumber"], "110045344")

    def test_imported_match_scan_supports_scored_pikachu_yellow_cheeks_reference(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="1999 POKEMON GAME #58 PIKACHU NM YELLOW CHEEKS 7 101048532",
            metadata_text="",
            bottom_left_text="",
            top_label_text="1999 POKEMON GAME #58 PIKACHU NM YELLOW CHEEKS 7 101048532",
            resolver_mode_hint="psa_slab",
            slab_grader="PSA",
            slab_grade="7",
            slab_cert_number="101048532",
            slab_grader_confidence=0.78,
            slab_grade_confidence=0.94,
            slab_cert_confidence=0.95,
            slab_card_number_raw="58",
            slab_classifier_reasons=[
                "psa_red_band_detected",
                "barcode_region_detected",
                "grade_from_nm_layout",
            ],
            slab_recommended_lookup_path="psa_cert",
        )

        response = self.service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "base1-58")
        self.assertEqual(response["slabContext"]["grader"], "PSA")
        self.assertEqual(response["slabContext"]["grade"], "7")
        self.assertEqual(response["slabContext"]["certNumber"], "101048532")

    def test_imported_match_scan_supports_zero_padded_pokemon_go_charizard_psa_label(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 FSA 103377816",
            metadata_text="",
            bottom_left_text="",
            top_label_text="2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 FSA 103377816",
            resolver_mode_hint="psa_slab",
            slab_grader="PSA",
            slab_grade="7",
            slab_cert_number="103377816",
            slab_barcode_payloads=["103377816"],
            slab_grader_confidence=0.78,
            slab_grade_confidence=0.91,
            slab_cert_confidence=1.0,
            slab_card_number_raw="010",
            slab_classifier_reasons=[
                "barcode_region_detected",
                "pokemon_card_number_layout",
                "grade_from_nm_layout",
            ],
            slab_recommended_lookup_path="psa_cert",
        )

        response = self.service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["confidence"], "high")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "pgo-10")

    def test_imported_match_scan_identifies_cgc_ninetales_without_raw_pricing_fallback(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="YACGC CERTIFIED GUARANTY COMPANY Ninetales Pokémon (1999) GEM MINT Base Set - Unlimited - 12/102 10 Holo 4236460045",
            metadata_text="",
            bottom_left_text="",
            top_label_text="YACGC CERTIFIED GUARANTY COMPANY Ninetales Pokémon (1999) GEM MINT Base Set - Unlimited - 12/102 10 Holo 4236460045",
            resolver_mode_hint="psa_slab",
            slab_grader="CGC",
            slab_grade="10",
            slab_cert_number="4236460045",
            slab_barcode_payloads=["4236460045"],
            slab_grader_confidence=1.0,
            slab_grade_confidence=0.90,
            slab_cert_confidence=1.0,
            slab_card_number_raw="12/102",
            slab_classifier_reasons=["explicit_grader_cgc", "cert_from_barcode"],
            slab_recommended_lookup_path="label_text_search",
        )

        response = self.service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "base1-12")
        self.assertNotIn("pricing", response["topCandidates"][0]["candidate"])
        self.assertEqual(response["reviewDisposition"], "unsupported")
        self.assertIn("CGC", response["reviewReason"])

    def test_imported_match_scan_includes_exact_cgc_scrydex_pricing_when_available(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="SACGC CERTIFIED GUARANTY COMPANY Ninetales Pokémon (1999) GEM MINT Base Set - Unlimited - 12/102 10 Holo 4236460045",
            metadata_text="",
            bottom_left_text="",
            top_label_text="SACGC CERTIFIED GUARANTY COMPANY Ninetales Pokémon (1999) GEM MINT Base Set - Unlimited - 12/102 10 Holo 4236460045",
            resolver_mode_hint="psa_slab",
            slab_grader="CGC",
            slab_grade="10",
            slab_cert_number="4236460045",
            slab_barcode_payloads=["4236460045"],
            slab_grader_confidence=1.0,
            slab_grade_confidence=0.90,
            slab_cert_confidence=1.0,
            slab_card_number_raw="12/102",
            slab_classifier_reasons=["explicit_grader_cgc", "cert_from_barcode"],
            slab_recommended_lookup_path="label_text_search",
        )
        scrydex_payload = {
            "data": {
                "name": "Ninetales",
                "expansion": {"name": "Base"},
                "variants": [
                    {
                        "name": "unlimitedHolofoil",
                        "prices": [
                            {
                                "type": "graded",
                                "company": "CGC",
                                "grade": "10",
                                "currency": "USD",
                                "low": 950.0,
                                "market": 1100.0,
                                "mid": 1125.0,
                                "high": 1250.0,
                                "updated_at": "2026-04-08T17:10:00Z",
                            }
                        ],
                    }
                ],
            }
        }

        with patch.dict(os.environ, {"SCRYDEX_API_KEY": "token", "SCRYDEX_TEAM_ID": "team"}), \
             patch("scrydex_adapter.fetch_scrydex_card", return_value=scrydex_payload):
            response = self.service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["reviewDisposition"], "ready")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "base1-12")
        pricing = response["topCandidates"][0]["candidate"]["pricing"]
        self.assertEqual(pricing["source"], "scrydex")
        self.assertEqual(pricing["variant"], "CGC 10")
        self.assertEqual(pricing["grader"], "CGC")
        self.assertEqual(pricing["grade"], "10")
        self.assertEqual(pricing["market"], 1100.0)

    def test_imported_match_scan_identifies_cgc_gyarados_without_raw_pricing_fallback(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="CGC UNIVERSAL GRADE NM/Mint+ Gyarados 8.5 Pokémon (1999) Base Set - Shadowless - 6/102 Holo",
            metadata_text="",
            bottom_left_text="",
            top_label_text="CGC UNIVERSAL GRADE NM/Mint+ Gyarados 8.5 Pokémon (1999) Base Set - Shadowless - 6/102 Holo",
            resolver_mode_hint="psa_slab",
            slab_grader="CGC",
            slab_grade="8.5",
            slab_grader_confidence=1.0,
            slab_grade_confidence=0.88,
            slab_card_number_raw="6/102",
            slab_classifier_reasons=["explicit_grader_cgc", "grade_from_extended_slab_layout"],
            slab_recommended_lookup_path="label_text_search",
        )

        response = self.service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "base1-6")
        self.assertNotIn("pricing", response["topCandidates"][0]["candidate"])
        self.assertEqual(response["reviewDisposition"], "unsupported")
        self.assertIn("CGC", response["reviewReason"])

    def test_slab_charizard_live_imports_when_stale_catalog_only_has_wrong_number_matches(self) -> None:
        service = self._make_catalog_service(
            "slab_charizard_catalog_miss",
            [
                catalog_card(card_id="swsh3-10", name="Accelgor", set_name="Darkness Ablaze", number="10/189", set_id="swsh3"),
                catalog_card(card_id="sv3-10", name="Amoonguss", set_name="Obsidian Flames", number="10/197", set_id="sv3"),
                catalog_card(card_id="sve-10", name="Basic Fire Energy", set_name="Scarlet & Violet Energies", number="10/16", set_id="sve"),
            ],
        )
        remote_card = {
            "id": "pgo-10",
            "name": "Charizard",
            "number": "10",
            "supertype": "Pokémon",
            "subtypes": ["Stage 2"],
            "types": ["Fire"],
            "artist": "Mitsuhiro Arita",
            "rarity": "Rare Holo",
            "nationalPokedexNumbers": [6],
            "images": {
                "small": "https://example.com/pgo-10-small.png",
                "large": "https://example.com/pgo-10-large.png",
            },
            "set": {
                "id": "pgo",
                "name": "Pokemon GO",
                "series": "Sword & Shield",
                "printedTotal": 78,
                "ptcgoCode": "PGO",
                "releaseDate": "2022/07/01",
            },
            "tcgplayer": {},
            "cardmarket": {},
        }
        payload = sample_scan_payload(
            collector_number="",
            full_text="2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 PSA 103377816",
            metadata_text="",
            bottom_left_text="",
            top_label_text="2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 PSA 103377816",
            resolver_mode_hint="psa_slab",
            slab_grader="PSA",
            slab_grade="7",
            slab_cert_number="103377816",
            slab_barcode_payloads=["103377816"],
            slab_grader_confidence=1.0,
            slab_grade_confidence=0.96,
            slab_cert_confidence=1.0,
            slab_card_number_raw="010",
            slab_classifier_reasons=["explicit_grader_psa", "cert_from_barcode"],
            slab_recommended_lookup_path="psa_cert",
        )

        with patch.dict(os.environ, {"SCRYDEX_API_KEY": "", "SCRYDEX_TEAM_ID": ""}), \
             patch("server.search_remote_cards", return_value=[remote_card]):
            response = service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "pgo-10")
        self.assertEqual(response.get("catalogMissImportedCardID"), "pgo-10")
        self.assertEqual(service.card_detail("pgo-10")["card"]["id"], "pgo-10")

    def test_slab_cgc_ninetales_live_imports_when_stale_catalog_only_has_wrong_number_matches(self) -> None:
        service = self._make_catalog_service(
            "slab_ninetales_catalog_miss",
            [
                catalog_card(card_id="dv1-12", name="Axew", set_name="Dragon Vault", number="12/20", set_id="dv1"),
                catalog_card(card_id="sve-12", name="Basic Lightning Energy", set_name="Scarlet & Violet Energies", number="12/16", set_id="sve"),
                catalog_card(card_id="swsh3-12", name="Dartrix", set_name="Darkness Ablaze", number="12/189", set_id="swsh3"),
            ],
        )
        remote_card = {
            "id": "base1-12",
            "name": "Ninetales",
            "number": "12",
            "supertype": "Pokémon",
            "subtypes": ["Stage 1"],
            "types": ["Fire"],
            "artist": "Ken Sugimori",
            "rarity": "Holo Rare",
            "nationalPokedexNumbers": [38],
            "images": {
                "small": "https://example.com/base1-12-small.png",
                "large": "https://example.com/base1-12-large.png",
            },
            "set": {
                "id": "base1",
                "name": "Base",
                "series": "Base",
                "printedTotal": 102,
                "ptcgoCode": "BS",
                "releaseDate": "1999/01/09",
            },
            "tcgplayer": {},
            "cardmarket": {},
        }
        payload = sample_scan_payload(
            collector_number="",
            full_text="SACGC CERTIFIED GUARANTY COMPANY Ninetales Pokémon (1999) GEM MINT Base Set - Unlimited - 12/102 10 Holo 4236460045",
            metadata_text="",
            bottom_left_text="",
            top_label_text="SACGC CERTIFIED GUARANTY COMPANY Ninetales Pokémon (1999) GEM MINT Base Set - Unlimited - 12/102 10 Holo 4236460045",
            resolver_mode_hint="psa_slab",
            slab_grader="CGC",
            slab_grade="10",
            slab_cert_number="4236460045",
            slab_barcode_payloads=["4236460045"],
            slab_grader_confidence=1.0,
            slab_grade_confidence=0.90,
            slab_cert_confidence=1.0,
            slab_card_number_raw="12/102",
            slab_classifier_reasons=["explicit_grader_cgc", "cert_from_barcode"],
            slab_recommended_lookup_path="label_text_search",
        )

        with patch("server.search_remote_cards", return_value=[remote_card]):
            response = service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "base1-12")
        self.assertEqual(response.get("catalogMissImportedCardID"), "base1-12")

    def test_slab_japanese_psa_live_imports_from_scrydex_when_local_catalog_has_only_wrong_number_matches(self) -> None:
        service = self._make_catalog_service(
            "slab_japanese_catalog_miss",
            [
                catalog_card(card_id="swsh1-94", name="Hitmonlee", set_name="Sword & Shield", number="94/202", set_id="swsh1"),
                catalog_card(card_id="sv1-94", name="Dedenne", set_name="Scarlet & Violet", number="94/198", set_id="sv1"),
                catalog_card(card_id="ex6-94", name="Mt. Moon", set_name="FireRed & LeafGreen", number="94/112", set_id="ex6"),
            ],
        )
        remote_card = {
            "id": "sm12a_ja-94",
            "name": "トゲピー&ピィ&ププリンGX",
            "number": "94",
            "printed_number": "094/173",
            "language": "Japanese",
            "supertype": "ポケモン",
            "subtypes": ["たね"],
            "types": ["フェアリー"],
            "artist": "Misa Tsutsui",
            "rarity": "RR",
            "national_pokedex_numbers": [175, 173, 174],
            "images": [
                {
                    "type": "front",
                    "small": "https://example.com/sm12a_ja-94-small.png",
                    "large": "https://example.com/sm12a_ja-94-large.png",
                }
            ],
            "expansion": {
                "id": "sm12a_ja",
                "name": "Tag Team GX All Stars",
                "series": "Sun & Moon",
                "release_date": "2019-10-04",
            },
            "translation": {
                "en": {
                    "name": "Togepi & Cleffa & Igglybuff GX",
                    "supertype": "Pokémon",
                    "subtypes": ["Basic"],
                    "types": ["Fairy"],
                }
            },
            "variants": [],
        }
        payload = sample_scan_payload(
            collector_number="",
            full_text="2019 P.M. JPN. SUN & MOON #094 TGPI/CLFA/IGLYBF.GX MINT TAG TEAM GX ALL STARS PSA 132227779",
            metadata_text="",
            bottom_left_text="",
            top_label_text="2019 P.M. JPN. SUN & MOON #094 TGPI/CLFA/IGLYBF.GX MINT TAG TEAM GX ALL STARS PSA 132227779",
            resolver_mode_hint="psa_slab",
            slab_grader="PSA",
            slab_grade="9",
            slab_cert_number="132227779",
            slab_barcode_payloads=["132227779"],
            slab_grader_confidence=1.0,
            slab_grade_confidence=0.72,
            slab_cert_confidence=0.88,
            slab_card_number_raw="094",
            slab_classifier_reasons=["explicit_grader_psa", "cert_from_label_ocr"],
            slab_recommended_lookup_path="psa_cert",
        )

        with patch("server.scrydex_credentials", return_value=("demo-key", "demo-team")), \
             patch("server.search_scrydex_cards", return_value=[remote_card]) as mock_search_scrydex_cards, \
             patch("server.search_remote_cards", return_value=[]):
            response = service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "sm12a_ja-94")
        self.assertEqual(response.get("catalogMissImportedCardID"), "sm12a_ja-94")
        self.assertTrue(mock_search_scrydex_cards.called)
        self.assertEqual(mock_search_scrydex_cards.call_args_list[0].args[0], "expansion.id:sm12a_ja")
        self.assertEqual(mock_search_scrydex_cards.call_args_list[0].kwargs.get("page_size"), 100)
        self.assertEqual(mock_search_scrydex_cards.call_args_list[0].kwargs.get("language_code"), "ja")
        detail = service.card_detail("sm12a_ja-94")
        assert detail is not None
        self.assertEqual(detail["card"]["language"], "Japanese")
        self.assertEqual(detail["card"]["setName"], "Tag Team GX All Stars")

    def test_slab_psa_cert_miss_drops_to_low_confidence_when_only_wrong_number_match_exists(self) -> None:
        service = self._make_catalog_service(
            "slab_psa_cert_miss_low_confidence",
            [
                catalog_card(card_id="ex6-94", name="Mt. Moon", set_name="FireRed & LeafGreen", number="94/112", set_id="ex6"),
            ],
        )
        payload = sample_scan_payload(
            collector_number="",
            full_text="2019 P.M. JPN. SUN & MOON #094 TGPI/CLFA/IGLYBF.GX MINT TAG TEAM GX ALL STARS PSA 132227779",
            metadata_text="",
            bottom_left_text="",
            top_label_text="2019 P.M. JPN. SUN & MOON #094 TGPI/CLFA/IGLYBF.GX MINT TAG TEAM GX ALL STARS PSA 132227779",
            resolver_mode_hint="psa_slab",
            slab_grader="PSA",
            slab_grade="9",
            slab_cert_number="132227779",
            slab_barcode_payloads=["132227779"],
            slab_grader_confidence=1.0,
            slab_grade_confidence=0.72,
            slab_cert_confidence=0.88,
            slab_card_number_raw="094",
            slab_classifier_reasons=["explicit_grader_psa", "cert_from_label_ocr"],
            slab_recommended_lookup_path="psa_cert",
        )

        with patch("server.scrydex_credentials", return_value=None), \
             patch("server.search_remote_cards", return_value=[]):
            response = service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_label")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "ex6-94")
        self.assertEqual(response["confidence"], "low")
        self.assertIn("PSA cert was not found in the local slab cache", response["ambiguityFlags"])

    def test_explicit_non_psa_slab_returns_unsupported(self) -> None:
        payload = sample_scan_payload(
            collector_number="",
            full_text="CGC PRISTINE 10 CHARIZARD",
            metadata_text="",
            bottom_left_text="",
            top_label_text="CGC PRISTINE 10 CHARIZARD",
            resolver_mode_hint="psa_slab",
            slab_grader="CGC",
            slab_grade="10",
            slab_cert_number="12345678",
        )

        response = self.service.match_scan(payload)

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["reviewDisposition"], "unsupported")
        self.assertIn("CGC", response["reviewReason"])

    def test_imported_match_scan_supports_espeon_gold_star_direct_lookup(self) -> None:
        payload = sample_scan_payload(
            collector_number="16/17",
            full_text="Espeon Gold Star POP Series 5 16/17",
            metadata_text="POP SERIES 5 16/17",
            bottom_left_text="POP 5 16/17",
            set_hint_tokens=["pop", "5"],
        )

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertEqual(response["resolverPath"], "direct_lookup")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "pop5-16")

    def test_imported_match_scan_supports_charmander_direct_lookup(self) -> None:
        payload = sample_scan_payload(
            collector_number="168/165",
            full_text="Charmander MEW EN 168/165",
            metadata_text="MEW EN 168/165",
            bottom_left_text="MEW EN 168/165",
            set_hint_tokens=["mew"],
        )

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertEqual(response["resolverPath"], "direct_lookup")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "sv3pt5-168")

    def test_imported_match_scan_supports_simisear_vstar_gallery_direct_lookup(self) -> None:
        payload = sample_scan_payload(
            collector_number="GG37/GG70",
            full_text="Simisear VSTAR GG37/GG70 Crown Zenith",
            metadata_text="GG37/GG70",
            bottom_left_text="GG37/GG70",
            set_hint_tokens=["gg", "crown", "zenith"],
        )

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertEqual(response["resolverPath"], "direct_lookup")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "swsh12pt5gg-GG37")

    def test_collector_numbers_equivalent_normalizes_zero_padded_slash_values(self) -> None:
        self.assertTrue(collector_numbers_equivalent("021/088", "21/88"))
        self.assertTrue(collector_numbers_equivalent("130/094", "130/94"))
        self.assertFalse(collector_numbers_equivalent("021/088", "21/89"))

    def test_imported_match_scan_rejects_fake_raw_direct_lookup_with_unknown_set_code(self) -> None:
        payload = sample_scan_payload(
            collector_number="130/094",
            full_text="Mega Charizard X POR EN 130/094",
            metadata_text="J POR EN 130/094",
            bottom_left_text="J POR EN 130/094",
            set_hint_tokens=["por"],
            resolver_mode_hint="raw_card",
        )

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertNotEqual(response["resolverPath"], "direct_lookup")
        self.assertEqual(response["confidence"], "low")

    def test_imported_match_scan_does_not_attempt_catalog_miss_when_exact_direct_match_already_exists(self) -> None:
        payload = sample_scan_payload(
            collector_number="16/17",
            full_text="Espeon 16/17",
            metadata_text="16/17",
            bottom_left_text="16/17",
            resolver_mode_hint="raw_card",
        )

        with patch(
            "server.search_remote_cards",
            side_effect=AssertionError("catalog-miss search should not run when direct lookup already has an exact structured match"),
        ):
            response = self.service.match_scan(payload)

        self.assertEqual(response["resolverPath"], "direct_lookup")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "pop5-16")

    def test_imported_match_scan_does_not_attempt_catalog_miss_for_numeric_only_queries_without_set_or_prefix(self) -> None:
        payload = sample_scan_payload(
            collector_number="130/094",
            full_text="130/094",
            metadata_text="130/094",
            bottom_left_text="130/094",
            resolver_mode_hint="raw_card",
        )
        payload["directLookupLikely"] = False

        with patch(
            "server.search_remote_cards",
            side_effect=AssertionError("numeric-only catalog-miss search should require a set or prefix hint"),
        ):
            response = self.service.match_scan(payload)

        self.assertEqual(response["confidence"], "low")

    def test_imported_match_scan_does_not_attempt_catalog_miss_for_low_confidence_printed_total_only_queries(self) -> None:
        payload = sample_scan_payload(
            collector_number="021/088",
            full_text="021/088",
            metadata_text="021/088",
            bottom_left_text="021/088",
            resolver_mode_hint="raw_card",
        )
        payload["directLookupLikely"] = True

        with patch(
            "server.search_remote_cards",
            side_effect=AssertionError("printed-total-only low-confidence queries should fail fast"),
        ):
            response = self.service.match_scan(payload)

        self.assertEqual(response["confidence"], "low")
        self.assertIn(response["reviewDisposition"], {"needs_review", "unsupported"})

    def test_imported_match_scan_does_not_attempt_catalog_miss_for_untrusted_set_hints(self) -> None:
        payload = sample_scan_payload(
            collector_number="021/088",
            full_text="Mega Starmie eX POR EN 021/088",
            metadata_text="POR EN 021/088",
            bottom_left_text="POR EN 021/088",
            set_hint_tokens=["por", "wh"],
            resolver_mode_hint="raw_card",
        )

        with patch(
            "server.search_remote_cards",
            side_effect=AssertionError("untrusted OCR set hints should not trigger catalog-miss search"),
        ):
            response = self.service.match_scan(payload)

        self.assertEqual(response["confidence"], "low")

    def test_imported_match_scan_does_not_treat_generic_ex_overlap_as_name_support(self) -> None:
        payload = sample_scan_payload(
            collector_number="130/094",
            full_text="Mega CharizardX eX PFL 130/094",
            metadata_text="130/094",
            bottom_left_text="130/094",
            set_hint_tokens=[],
            resolver_mode_hint="raw_card",
        )
        payload["directLookupLikely"] = False

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertNotEqual(response["resolverPath"], "direct_lookup")

    def test_imported_index_keeps_official_mega_evolution_cards(self) -> None:
        index = load_index(self.connection)
        indexed_ids = {card.id for card in index.cards}

        self.assertIn("me1-185", indexed_ids)

        supported_payload = sample_scan_payload(
            collector_number="185/132",
            full_text="Lt. Surge's Bargain 185/132 MEG",
            metadata_text="185/132 MEG",
            bottom_left_text="185/132",
            set_hint_tokens=["meg"],
            resolver_mode_hint="raw_card",
        )

        supported_candidates = direct_lookup_candidate_indices(index, supported_payload)
        supported_ids = [index.cards[item].id for item in supported_candidates]
        self.assertIn("me1-185", supported_ids)

    def test_imported_match_scan_respects_direct_lookup_likely_flag_for_raw_cards(self) -> None:
        payload = sample_scan_payload(
            collector_number="130/094",
            full_text="PFL 130/094",
            metadata_text="PFL 130/094",
            bottom_left_text="PFL 130/094",
            set_hint_tokens=[],
            resolver_mode_hint="raw_card",
        )
        payload["directLookupLikely"] = False

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertNotEqual(response["resolverPath"], "direct_lookup")

    def test_imported_match_scan_can_use_name_supported_direct_lookup_when_likely_flag_is_false(self) -> None:
        payload = sample_scan_payload(
            collector_number="16/17",
            full_text="Espeon Gold Star POP Series 5 16/17",
            metadata_text="16/17",
            bottom_left_text="16/17",
            resolver_mode_hint="raw_card",
        )
        payload["directLookupLikely"] = False

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertEqual(response["resolverPath"], "direct_lookup")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "pop5-16")

    def test_imported_match_scan_can_use_unique_exact_direct_lookup_when_likely_flag_is_false(self) -> None:
        payload = sample_scan_payload(
            collector_number="16/17",
            full_text="16/17",
            metadata_text="16/17",
            bottom_left_text="16/17",
            resolver_mode_hint="raw_card",
        )
        payload["directLookupLikely"] = False

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertEqual(response["resolverPath"], "direct_lookup")
        self.assertIn(response["confidence"], {"high", "medium"})
        self.assertEqual(response["reviewDisposition"], "ready")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "pop5-16")

    def test_imported_match_scan_keeps_custom_card_low_confidence(self) -> None:
        payload = sample_scan_payload(
            collector_number="021/088",
            full_text="Mega Starmie eX POR EN 021/088",
            metadata_text="J POR EN 021/088",
            bottom_left_text="J POR EN 021/088",
            set_hint_tokens=["por"],
        )

        with patch("server.search_remote_cards", return_value=[]):
            response = self.service.match_scan(payload)

        self.assertEqual(response["confidence"], "low")
        self.assertNotEqual(response["resolverPath"], "direct_lookup")

class PricingProviderTests(unittest.TestCase):
    """Tests for pricing provider abstraction."""

    def _make_seeded_service(self, database_name: str) -> tuple[SpotlightScanService, list[dict[str, object]]]:
        tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(tempdir.cleanup)

        temp_path = Path(tempdir.name)
        database_path = temp_path / f"{database_name}.sqlite"
        cards_path = temp_path / "catalog_seed.json"
        imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)
        cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
        connection.commit()
        connection.close()

        service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)
        self.addCleanup(service.connection.close)
        return service, imported_cards

    def _set_raw_snapshot_age(self, service: SpotlightScanService, card_id: str, *, hours_ago: int) -> None:
        stale_at = (datetime.now(UTC) - timedelta(hours=hours_ago)).isoformat()
        service.connection.execute(
            "UPDATE card_price_summaries SET updated_at = ? WHERE card_id = ?",
            (stale_at, card_id),
        )
        service.connection.commit()

    def _set_slab_snapshot_age(
        self,
        service: SpotlightScanService,
        card_id: str,
        *,
        grader: str,
        grade: str,
        hours_ago: int,
    ) -> None:
        stale_at = (datetime.now(UTC) - timedelta(hours=hours_ago)).isoformat()
        service.connection.execute(
            "UPDATE slab_price_snapshots SET updated_at = ? WHERE card_id = ? AND grader = ? AND grade = ?",
            (stale_at, card_id, grader, grade),
        )
        service.connection.commit()

    def _seed_raw_snapshot(self, service: SpotlightScanService, card_id: str) -> None:
        upsert_card_price_summary(
            service.connection,
            card_id=card_id,
            source="tcgplayer",
            currency_code="USD",
            variant="normal",
            low_price=1.25,
            market_price=1.75,
            mid_price=2.0,
            high_price=3.0,
            direct_low_price=1.5,
            trend_price=1.75,
            source_updated_at="2026/04/07",
            source_url="https://prices.example/raw",
            payload={"provider": "pokemontcg_api"},
        )

    def _seed_slab_snapshot(self, service: SpotlightScanService, card_id: str, *, grade: str) -> None:
        upsert_slab_price_snapshot(
            service.connection,
            card_id=card_id,
            grader="PSA",
            grade=grade,
            pricing_tier="scrydex_exact_grade",
            currency_code="USD",
            low_price=14.0,
            market_price=18.0,
            mid_price=18.5,
            high_price=20.0,
            last_sale_price=18.0,
            last_sale_date="2026-04-06T00:00:00+00:00",
            comp_count=6,
            recent_comp_count=3,
            confidence_level=90,
            confidence_label="high",
            bucket_key=None,
            source_url="https://prices.example/slab",
            source="scrydex",
            summary="Seeded PSA snapshot",
            payload={"source": "scrydex"},
        )

    def test_provider_registry_initialization(self) -> None:
        """Test that provider registry initializes with Pokemon TCG API, Scrydex, and PriceCharting."""
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "provider_test.sqlite"
            cards_path = temp_path / "catalog_seed.json"
            imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)
            cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)

            # Registry should have three providers
            providers = service.pricing_registry.list_providers()
            self.assertEqual(len(providers), 3)

            # Pokemon TCG API should be first (raw pricing)
            self.assertEqual(providers[0].provider_id, "pokemontcg_api")
            self.assertEqual(providers[0].provider_label, "Pokemon TCG API")
            self.assertTrue(providers[0].supports_raw_pricing)
            self.assertFalse(providers[0].supports_psa_pricing)

            # Scrydex should be second (primary PSA pricing)
            self.assertEqual(providers[1].provider_id, "scrydex")
            self.assertEqual(providers[1].provider_label, "Scrydex")
            self.assertTrue(providers[1].supports_raw_pricing)
            self.assertTrue(providers[1].supports_psa_pricing)

            # PriceCharting should be third (PSA fallback)
            self.assertEqual(providers[2].provider_id, "pricecharting")
            self.assertEqual(providers[2].provider_label, "PriceCharting")
            self.assertFalse(providers[2].supports_raw_pricing)
            self.assertTrue(providers[2].supports_psa_pricing)

            service.connection.close()

    def test_provider_status_endpoint_shows_all_providers(self) -> None:
        """Test that provider status endpoint returns info about all providers."""
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "provider_status_test.sqlite"
            cards_path = temp_path / "catalog_seed.json"
            imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)
            cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)
            status = service.provider_status()

            # Should have provider list
            self.assertIn("providers", status)
            self.assertEqual(len(status["providers"]), 3)

            # Should show active providers
            self.assertIn("activeRawProvider", status)
            self.assertIn("activePsaProvider", status)

            # Pokemon TCG API should be for raw pricing
            pokemontcg_provider = next(
                (p for p in status["providers"] if p["providerId"] == "pokemontcg_api"),
                None
            )
            self.assertIsNotNone(pokemontcg_provider)
            self.assertEqual(pokemontcg_provider["providerLabel"], "Pokemon TCG API")
            self.assertTrue(pokemontcg_provider["requiresCredentials"])
            self.assertTrue(pokemontcg_provider["supportsRawPricing"])
            self.assertFalse(pokemontcg_provider["supportsPsaPricing"])

            # PriceCharting should be for PSA pricing only
            pricecharting_provider = next(
                (p for p in status["providers"] if p["providerId"] == "pricecharting"),
                None
            )
            self.assertIsNotNone(pricecharting_provider)
            self.assertEqual(pricecharting_provider["providerLabel"], "PriceCharting")
            self.assertTrue(pricecharting_provider["requiresCredentials"])
            self.assertFalse(pricecharting_provider["supportsRawPricing"])
            self.assertTrue(pricecharting_provider["supportsPsaPricing"])

            service.connection.close()

    def test_health_endpoint_shows_active_provider(self) -> None:
        """Test that health endpoint shows the active provider."""
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "health_test.sqlite"
            cards_path = temp_path / "catalog_seed.json"
            imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)
            cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)
            health = service.health()

            # Should show active providers in health
            self.assertIn("activeRawPricingProvider", health)
            self.assertIn("activePsaPricingProvider", health)

            # Raw pricing can still use Pokemon TCG API without credentials.
            self.assertIn(health["activeRawPricingProvider"], ["none", "pokemontcg_api", "scrydex"])
            self.assertIn(health["activePsaPricingProvider"], ["none", "pricecharting", "scrydex"])

            service.connection.close()

    def test_provider_fallback_order(self) -> None:
        """Test that providers are tried in order until one succeeds."""
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "fallback_test.sqlite"
            cards_path = temp_path / "catalog_seed.json"
            imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)
            cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)

            # Try refreshing without credentials - should fail gracefully
            # All providers will fail, but should try them in order
            result = service.pricing_registry.refresh_raw_pricing(
                service.connection, "base1-4"
            )

            # Result should indicate failure
            self.assertFalse(result.success)
            # When all providers fail, provider_id should be "none"
            self.assertEqual(result.provider_id, "none")

            service.connection.close()

    def test_refresh_card_pricing_uses_only_pokemontcg_for_raw_runtime_flow(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "raw_provider_flow.sqlite"
            cards_path = temp_path / "catalog_seed.json"
            imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)
            cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)
            card_id = str(imported_cards[0]["id"])
            raw_provider = service.pricing_registry.get_provider("pokemontcg_api")
            scrydex_provider = service.pricing_registry.get_provider("scrydex")

            assert raw_provider is not None
            assert scrydex_provider is not None

            with patch.object(raw_provider, "is_ready", return_value=True), \
                 patch.object(
                     raw_provider,
                     "refresh_raw_pricing",
                     return_value=RawPricingResult(
                         success=False,
                         provider_id="pokemontcg_api",
                         card_id=card_id,
                         error="Pokemon TCG API unavailable",
                     ),
                 ) as raw_refresh, \
                 patch.object(scrydex_provider, "is_ready", return_value=True), \
                 patch.object(
                     scrydex_provider,
                     "refresh_raw_pricing",
                     side_effect=AssertionError("raw runtime flow should not fall back to Scrydex"),
                 ):
                detail = service.refresh_card_pricing(card_id)

            raw_refresh.assert_called_once()
            self.assertIsNotNone(detail)
            service.connection.close()

    def test_refresh_card_pricing_uses_only_scrydex_for_psa_runtime_flow(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "psa_provider_flow.sqlite"
            cards_path = temp_path / "catalog_seed.json"
            imported_cards = load_cards_json(SAMPLE_CATALOG_PATH)
            cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)
            card_id = str(imported_cards[0]["id"])
            scrydex_provider = service.pricing_registry.get_provider("scrydex")
            pricecharting_provider = service.pricing_registry.get_provider("pricecharting")

            assert scrydex_provider is not None
            assert pricecharting_provider is not None

            with patch.object(scrydex_provider, "is_ready", return_value=True), \
                 patch.object(
                     scrydex_provider,
                     "refresh_psa_pricing",
                     return_value=PsaPricingResult(
                         success=False,
                         provider_id="scrydex",
                         card_id=card_id,
                         grade="10",
                         error="Scrydex unavailable",
                     ),
                 ) as psa_refresh, \
                 patch.object(pricecharting_provider, "is_ready", return_value=True), \
                 patch.object(
                     pricecharting_provider,
                     "refresh_psa_pricing",
                     side_effect=AssertionError("PSA runtime flow should not fall back to PriceCharting"),
                 ):
                detail = service.refresh_card_pricing(card_id, grader="PSA", grade="10")

            psa_refresh.assert_called_once()
            self.assertIsNotNone(detail)
            assert detail is not None
            self.assertIsNone(detail["card"]["pricing"])

    def test_refresh_card_pricing_skips_raw_provider_when_snapshot_is_fresh(self) -> None:
        service, imported_cards = self._make_seeded_service("raw_fresh_snapshot")
        card_id = str(imported_cards[0]["id"])
        self._seed_raw_snapshot(service, card_id)
        raw_provider = service.pricing_registry.get_provider("pokemontcg_api")

        assert raw_provider is not None

        with patch.object(
            raw_provider,
            "refresh_raw_pricing",
            side_effect=AssertionError("fresh raw snapshot should not trigger provider refresh"),
        ):
            detail = service.refresh_card_pricing(card_id)

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertTrue(detail["card"]["pricing"]["isFresh"])

    def test_refresh_card_pricing_refreshes_raw_provider_when_snapshot_is_stale(self) -> None:
        service, imported_cards = self._make_seeded_service("raw_stale_snapshot")
        card_id = str(imported_cards[0]["id"])
        self._seed_raw_snapshot(service, card_id)
        self._set_raw_snapshot_age(service, card_id, hours_ago=30)
        raw_provider = service.pricing_registry.get_provider("pokemontcg_api")

        assert raw_provider is not None

        with patch.object(raw_provider, "is_ready", return_value=True), \
             patch.object(
                 raw_provider,
                 "refresh_raw_pricing",
                 return_value=RawPricingResult(
                     success=False,
                     provider_id="pokemontcg_api",
                     card_id=card_id,
                     error="provider unavailable",
                 ),
             ) as raw_refresh:
            detail = service.refresh_card_pricing(card_id)

        raw_refresh.assert_called_once()
        self.assertIsNotNone(detail)

    def test_refresh_card_pricing_force_refresh_bypasses_fresh_raw_snapshot(self) -> None:
        service, imported_cards = self._make_seeded_service("raw_force_refresh")
        card_id = str(imported_cards[0]["id"])
        self._seed_raw_snapshot(service, card_id)
        raw_provider = service.pricing_registry.get_provider("pokemontcg_api")

        assert raw_provider is not None

        with patch.object(raw_provider, "is_ready", return_value=True), \
             patch.object(
                 raw_provider,
                 "refresh_raw_pricing",
                 return_value=RawPricingResult(
                     success=False,
                     provider_id="pokemontcg_api",
                     card_id=card_id,
                     error="provider unavailable",
                 ),
             ) as raw_refresh:
            detail = service.refresh_card_pricing(card_id, force_refresh=True)

        raw_refresh.assert_called_once()
        self.assertIsNotNone(detail)

    def test_refresh_card_pricing_skips_psa_provider_when_snapshot_is_fresh(self) -> None:
        service, imported_cards = self._make_seeded_service("psa_fresh_snapshot")
        card_id = str(imported_cards[0]["id"])
        self._seed_slab_snapshot(service, card_id, grade="10")
        scrydex_provider = service.pricing_registry.get_provider("scrydex")

        assert scrydex_provider is not None

        with patch.object(
            scrydex_provider,
            "refresh_psa_pricing",
            side_effect=AssertionError("fresh slab snapshot should not trigger provider refresh"),
        ):
            detail = service.refresh_card_pricing(card_id, grader="PSA", grade="10")

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertTrue(detail["card"]["pricing"]["isFresh"])

    def test_refresh_card_pricing_refreshes_psa_provider_when_snapshot_is_stale(self) -> None:
        service, imported_cards = self._make_seeded_service("psa_stale_snapshot")
        card_id = str(imported_cards[0]["id"])
        self._seed_slab_snapshot(service, card_id, grade="10")
        self._set_slab_snapshot_age(service, card_id, grader="PSA", grade="10", hours_ago=30)
        scrydex_provider = service.pricing_registry.get_provider("scrydex")

        assert scrydex_provider is not None

        with patch.object(scrydex_provider, "is_ready", return_value=True), \
             patch.object(
                 scrydex_provider,
                 "refresh_psa_pricing",
                 return_value=PsaPricingResult(
                     success=False,
                     provider_id="scrydex",
                     card_id=card_id,
                     grade="10",
                     error="provider unavailable",
                 ),
             ) as psa_refresh:
            detail = service.refresh_card_pricing(card_id, grader="PSA", grade="10")

        psa_refresh.assert_called_once()
        self.assertIsNotNone(detail)

    def test_refresh_card_pricing_force_refresh_bypasses_fresh_psa_snapshot(self) -> None:
        service, imported_cards = self._make_seeded_service("psa_force_refresh")
        card_id = str(imported_cards[0]["id"])
        self._seed_slab_snapshot(service, card_id, grade="10")
        scrydex_provider = service.pricing_registry.get_provider("scrydex")

        assert scrydex_provider is not None

        with patch.object(scrydex_provider, "is_ready", return_value=True), \
             patch.object(
                 scrydex_provider,
                 "refresh_psa_pricing",
                 return_value=PsaPricingResult(
                     success=False,
                     provider_id="scrydex",
                     card_id=card_id,
                     grade="10",
                     error="provider unavailable",
                 ),
             ) as psa_refresh:
            detail = service.refresh_card_pricing(
                card_id,
                grader="PSA",
                grade="10",
                force_refresh=True,
            )

        psa_refresh.assert_called_once()
        self.assertIsNotNone(detail)

    def test_cache_status_reports_snapshot_freshness_metrics(self) -> None:
        service, imported_cards = self._make_seeded_service("cache_status_metrics")
        card_id = str(imported_cards[0]["id"])
        self._seed_raw_snapshot(service, card_id)
        self._seed_slab_snapshot(service, card_id, grade="10")
        self._set_raw_snapshot_age(service, card_id, hours_ago=30)

        status = service.cache_status()

        self.assertIn("freshnessWindowHours", status)
        self.assertEqual(status["freshnessWindowHours"], 24)
        self.assertGreaterEqual(status["rawSnapshots"]["count"], 1)
        self.assertGreaterEqual(status["slabSnapshots"]["count"], 1)
        self.assertGreaterEqual(status["rawSnapshots"]["staleCount"], 1)


class VintageDirectLookupDisambiguationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.database_path = Path(cls.tempdir.name) / "vintage.sqlite"
        cls.connection = connect(cls.database_path)
        apply_schema(cls.connection, BACKEND_ROOT / "schema.sql")

        vintage_cards = [
            catalog_card(
                card_id="gym1-60",
                name="Sabrina's Slowbro",
                set_name="Gym Heroes",
                number="60/132",
                set_id="gym1",
                artist="Ken Sugimori",
                national_pokedex_numbers=[80],
            ),
            catalog_card(
                card_id="gym2-60",
                name="Blaine's Charmander",
                set_name="Gym Challenge",
                number="60/132",
                set_id="gym2",
                artist="Ken Sugimori",
                national_pokedex_numbers=[4],
            ),
            catalog_card(
                card_id="swsh35-60",
                name="Pokémon Center Lady",
                set_name="Champion's Path",
                number="60/73",
                set_id="swsh35",
                artist="kirisAki",
            ),
        ]

        seed_catalog(cls.connection, vintage_cards, REPO_ROOT)
        cls.connection.commit()

        cls.index = load_index(cls.connection)
        cls.service = SpotlightScanService(cls.database_path, REPO_ROOT)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.connection.close()
        cls.tempdir.cleanup()

    def test_direct_lookup_prefers_exact_slash_candidates(self) -> None:
        payload = sample_scan_payload(
            collector_number="60/132",
            full_text="LV. 29 #80 Illus. Ken Sugimori 60/132",
            metadata_text="LV. 29 #80",
            bottom_left_text="Illus. Ken Sugimori",
            bottom_right_text="60/132",
        )

        candidate_indices = direct_lookup_candidate_indices(self.index, payload)
        candidate_ids = [self.index.cards[index].id for index in candidate_indices]

        self.assertGreaterEqual(len(candidate_ids), 2)
        self.assertEqual(candidate_ids[:2], ["gym1-60", "gym2-60"])
        self.assertNotIn("swsh35-60", candidate_ids[:2])

    def test_match_scan_uses_pokedex_hint_to_pick_sabrinas_slowbro(self) -> None:
        payload = sample_scan_payload(
            collector_number="60/132",
            full_text="weakness resistance retreat cost LV. 29 #80 Illus. Ken Sugimori 60/132",
            metadata_text="LV. 29 #80",
            bottom_left_text="Illus. Ken Sugimori",
            bottom_right_text="60/132",
        )

        response = self.service.match_scan(payload)

        self.assertEqual(response["resolverPath"], "direct_lookup")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "gym1-60")
        self.assertIn(response["confidence"], {"high", "medium"})


if __name__ == "__main__":
    unittest.main()
