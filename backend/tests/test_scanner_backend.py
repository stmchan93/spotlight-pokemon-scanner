from __future__ import annotations

import copy
import json
import os
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
    collector_number_lookup_keys,
    connect,
    direct_lookup_candidate_indices,
    import_slab_sales,
    load_cards_json,
    load_index,
    normalized_set_hint_tokens,
    parse_psa_grade,
    recompute_slab_price_snapshot,
    resolver_mode_for_payload,
    runtime_supported_card_id,
    seed_catalog,
    slab_context_from_payload,
    upsert_card_price_summary,
    upsert_slab_price_snapshot,
    upsert_slab_sale,
)
from pricing_provider import PsaPricingResult, RawPricingResult  # noqa: E402
from server import SpotlightScanService  # noqa: E402


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
) -> dict[str, object]:
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
            load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
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

    def test_runtime_supported_card_id_filters_low_trust_custom_mega_family(self) -> None:
        self.assertFalse(runtime_supported_card_id("me2-130"))
        self.assertFalse(runtime_supported_card_id("ME3-21"))
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

    def test_parse_psa_grade_can_infer_adjective_only_grade(self) -> None:
        self.assertEqual(parse_psa_grade("2024 POKEMON SSP EN PIKACHU ex MINT 105239649"), "9")
        self.assertEqual(parse_psa_grade("2003 POKEMON SKYRIDGE CHARIZARD-HOLO GEM MT 48620163"), "10")

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
            cards_path = temp_path / "cards.json"
            imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
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

    def test_match_scan_can_import_catalog_miss_and_retry(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "catalog_miss.sqlite"
            cards_path = temp_path / "cards.json"
            imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
            cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)
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
            persisted_cards = json.loads(cards_path.read_text())
            self.assertTrue(any(card["id"] == "sv8-238" for card in persisted_cards))
            service.connection.close()

    def test_match_scan_can_import_catalog_miss_without_api_key_using_printed_total(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "catalog_miss_printed_total.sqlite"
            cards_path = temp_path / "cards.json"
            imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
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

    def test_refresh_card_pricing_can_auto_import_missing_card(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            database_path = temp_path / "refresh_import.sqlite"
            cards_path = temp_path / "cards.json"
            imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
            cards_path.write_text(json.dumps(cards_without_reference_images(imported_cards), indent=2))

            connection = connect(database_path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            seed_catalog(connection, cards_without_reference_images(imported_cards), REPO_ROOT)
            connection.commit()
            connection.close()

            service = SpotlightScanService(database_path, REPO_ROOT, cards_path=cards_path)
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
                persisted_cards = json.loads(cards_path.read_text())
                self.assertTrue(any(card["id"] == "sv8-238" for card in persisted_cards))
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
                catalog_card(card_id="neo1-9", name="Lugia", set_name="Neo Genesis", number="9/111", set_id="neo1"),
                catalog_card(card_id="base1-2", name="Blastoise", set_name="Base", number="2/102", set_id="base1"),
                catalog_card(card_id="base6-3", name="Charizard", set_name="Legendary Collection", number="3/110", set_id="base6"),
                catalog_card(card_id="base6-64", name="Snorlax", set_name="Legendary Collection", number="64/110", set_id="base6"),
                catalog_card(card_id="ex13-103", name="Mewtwo", set_name="Holon Phantoms", number="103", set_id="ex13"),
                catalog_card(card_id="sm9-170", name="Latias & Latios GX", set_name="Team Up", number="170/181", set_id="sm9"),
                catalog_card(card_id="sv3pt5-168", name="Charmander", set_name="151", number="168/165", set_id="sv3pt5"),
                catalog_card(card_id="pop5-16", name="Espeon", set_name="POP Series 5", number="16/17", set_id="pop5"),
                catalog_card(card_id="ecard3-146", name="Charizard", set_name="Skyridge", number="146", set_id="ecard3"),
                catalog_card(card_id="swsh12pt5gg-GG37", name="Simisear VSTAR", set_name="Crown Zenith Galarian Gallery", number="GG37/GG70", set_id="swsh12pt5gg"),
                catalog_card(card_id="me2-130", name="Mega Charizard X ex", set_name="Phantasmal Flames", number="130/94", set_id="me2"),
                catalog_card(card_id="me3-21", name="Mega Starmie ex", set_name="Perfect Order", number="21/88", set_id="me3"),
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

    def test_imported_index_excludes_low_trust_custom_mega_cards(self) -> None:
        index = load_index(self.connection)
        indexed_ids = {card.id for card in index.cards}

        self.assertNotIn("me2-130", indexed_ids)
        self.assertNotIn("me3-21", indexed_ids)

        payload = sample_scan_payload(
            collector_number="130/094",
            full_text="Mega Charizard X ex 130/094",
            metadata_text="130/094",
            bottom_left_text="130/094",
            resolver_mode_hint="raw_card",
        )

        self.assertEqual(direct_lookup_candidate_indices(index, payload), [])

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
        cards_path = temp_path / "cards.json"
        imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
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
            cards_path = temp_path / "cards.json"
            imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
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
            cards_path = temp_path / "cards.json"
            imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
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
            cards_path = temp_path / "cards.json"
            imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
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
            cards_path = temp_path / "cards.json"
            imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
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
            cards_path = temp_path / "cards.json"
            imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
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
            cards_path = temp_path / "cards.json"
            imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "cards.sample.json")
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
