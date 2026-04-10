from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    RawCandidateMatch,
    RawCandidateScoreBreakdown,
    RawDecisionResult,
    RawEvidence,
    RawSignalScores,
    apply_schema,
    card_by_id,
    connect,
    contextual_pricing_summary_for_card,
    price_snapshot_for_card,
    upsert_card,
    upsert_card_price_summary,
    upsert_catalog_card,
    upsert_scan_event,
    upsert_slab_price_snapshot,
)
from pokemontcg_api_client import map_card  # noqa: E402
from pricing_provider import RawPricingResult  # noqa: E402
from scrydex_adapter import map_scrydex_catalog_card  # noqa: E402
from server import SpotlightScanService  # noqa: E402


def sample_catalog_card() -> dict[str, object]:
    return {
        "id": "gym1-60",
        "name": "Sabrina's Slowbro",
        "set_name": "Gym Heroes",
        "number": "60/132",
        "rarity": "Common",
        "variant": "Raw",
        "language": "English",
        "reference_image_path": None,
        "reference_image_url": "https://images.example/gym1-60-large.png",
        "reference_image_small_url": "https://images.example/gym1-60-small.png",
        "source": "pokemontcg_api",
        "source_record_id": "gym1-60",
        "set_id": "gym1",
        "set_series": "Gym",
        "set_ptcgo_code": None,
        "set_release_date": "2000-08-14",
        "supertype": "Pokémon",
        "subtypes": ["Stage 1"],
        "types": ["Psychic"],
        "artist": "Ken Sugimori",
        "regulation_mark": None,
        "national_pokedex_numbers": [80],
        "tcgplayer": {
            "updatedAt": "2026-04-09T01:00:00Z",
            "url": "https://prices.example/gym1-60",
            "prices": {
                "normal": {
                    "low": 1.0,
                    "mid": 2.0,
                    "market": 2.5,
                    "high": 3.0,
                    "directLow": 1.8,
                }
            },
        },
        "cardmarket": {},
        "source_payload": {
            "id": "gym1-60",
            "name": "Sabrina's Slowbro",
        },
    }


def sample_provider_card() -> dict[str, object]:
    return {
        "id": "gym1-60",
        "name": "Sabrina's Slowbro",
        "number": "60",
        "rarity": "Common",
        "supertype": "Pokémon",
        "subtypes": ["Stage 1"],
        "types": ["Psychic"],
        "artist": "Ken Sugimori",
        "images": {
            "small": "https://images.example/gym1-60-small.png",
            "large": "https://images.example/gym1-60-large.png",
        },
        "set": {
            "id": "gym1",
            "name": "Gym Heroes",
            "series": "Gym",
            "printedTotal": 132,
            "releaseDate": "2000-08-14",
        },
        "tcgplayer": {
            "updatedAt": "2026-04-09T01:00:00Z",
            "url": "https://prices.example/gym1-60",
            "prices": {
                "normal": {
                    "low": 1.0,
                    "mid": 2.0,
                    "market": 2.5,
                    "high": 3.0,
                    "directLow": 1.8,
                }
            },
        },
        "cardmarket": {},
    }


def sample_scrydex_card() -> dict[str, object]:
    return {
        "id": "m2a_ja-232",
        "name": "メガカイリューex",
        "language": "ja",
        "language_code": "JA",
        "printed_number": "232/193",
        "number": "232",
        "rarity": "UR",
        "artist": "DOM",
        "supertype": "Pokémon",
        "subtypes": ["Stage 2", "Mega", "ex"],
        "types": ["Dragon"],
        "expansion": {
            "id": "m2a_ja",
            "name": "MEGAドリームex",
            "code": "M2a",
            "series": "Scarlet & Violet",
            "release_date": "2026-01-01",
            "language": "ja",
        },
        "translation": {
            "en": {
                "name": "Mega Dragonite ex",
                "rarity": "Ultra Rare",
                "supertype": "Pokémon",
                "subtypes": ["Stage 2", "Mega", "ex"],
                "types": ["Dragon"],
            }
        },
        "images": [
            {
                "type": "front",
                "small": "https://images.example/m2a_ja-232-small.png",
                "large": "https://images.example/m2a_ja-232-large.png",
            }
        ],
        "variants": [
            {
                "name": "holofoil",
                "prices": [
                    {
                        "condition": "NM",
                        "is_perfect": False,
                        "is_signed": False,
                        "is_error": False,
                        "type": "raw",
                        "low": 2400.0,
                        "mid": 2500.0,
                        "high": 2600.0,
                        "market": 2550.0,
                        "currency": "JPY",
                        "trends": {
                            "days_30": {
                                "price_change": 125.0,
                            }
                        },
                    }
                ],
            }
        ],
    }


class BackendResetPhase1Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "phase1.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_phase1_schema_tables_exist(self) -> None:
        rows = self.connection.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
            ORDER BY name
            """
        ).fetchall()
        table_names = {row["name"] for row in rows}

        self.assertIn("cards", table_names)
        self.assertIn("card_price_snapshots", table_names)
        self.assertIn("scan_events", table_names)

    def test_upsert_card_round_trips_new_card_shape(self) -> None:
        upsert_card(
            self.connection,
            card_id="base1-4",
            name="Charizard",
            set_name="Base Set",
            number="4/102",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            source_provider="pokemontcg_api",
            source_record_id="base1-4",
            set_id="base1",
            set_series="Base",
            set_release_date="1999-01-09",
            supertype="Pokémon",
            subtypes=["Stage 2"],
            types=["Fire"],
            artist="Mitsuhiro Arita",
            national_pokedex_numbers=[6],
            image_url="https://images.example/base1-4-large.png",
            image_small_url="https://images.example/base1-4-small.png",
            source_payload={"id": "base1-4"},
        )
        self.connection.commit()

        card = card_by_id(self.connection, "base1-4")

        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["setID"], "base1")
        self.assertEqual(card["setSeries"], "Base")
        self.assertEqual(card["artist"], "Mitsuhiro Arita")
        self.assertEqual(card["imageURL"], "https://images.example/base1-4-large.png")
        self.assertEqual(card["sourceProvider"], "pokemontcg_api")

    def test_upsert_catalog_card_populates_cards_and_raw_snapshot(self) -> None:
        upsert_catalog_card(
            self.connection,
            sample_catalog_card(),
            REPO_ROOT,
            "2026-04-09T02:00:00Z",
            refresh_embeddings=False,
        )
        self.connection.commit()

        card = card_by_id(self.connection, "gym1-60")
        snapshot = price_snapshot_for_card(
            self.connection,
            "gym1-60",
            pricing_mode=RAW_PRICING_MODE,
        )

        self.assertIsNotNone(card)
        self.assertIsNotNone(snapshot)
        assert card is not None
        assert snapshot is not None
        self.assertEqual(card["setID"], "gym1")
        self.assertEqual(card["imageSmallURL"], "https://images.example/gym1-60-small.png")
        self.assertEqual(snapshot["provider"], "tcgplayer")
        self.assertEqual(snapshot["market"], 2.5)
        self.assertEqual(snapshot["variant"], "normal")

    def test_price_summary_and_slab_snapshot_write_primary_snapshot_table(self) -> None:
        upsert_card(
            self.connection,
            card_id="base1-4",
            name="Charizard",
            set_name="Base Set",
            number="4/102",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
        )
        upsert_card_price_summary(
            self.connection,
            card_id="base1-4",
            source="tcgplayer",
            currency_code="USD",
            variant="holofoil",
            low_price=120.0,
            market_price=150.0,
            mid_price=145.0,
            high_price=200.0,
            direct_low_price=140.0,
            trend_price=150.0,
            source_updated_at="2026-04-09",
            source_url="https://prices.example/base1-4",
            payload={"provider": "tcgplayer"},
        )
        upsert_slab_price_snapshot(
            self.connection,
            card_id="base1-4",
            grader="PSA",
            grade="9",
            pricing_tier="exact",
            currency_code="USD",
            low_price=900.0,
            market_price=1000.0,
            mid_price=980.0,
            high_price=1100.0,
            last_sale_price=995.0,
            last_sale_date="2026-04-01T00:00:00Z",
            comp_count=5,
            recent_comp_count=3,
            confidence_level=4,
            confidence_label="High",
            bucket_key="base:pokemon:rare-holo",
            source_url="https://scrydex.example/base1-4",
            source="scrydex",
            summary="PSA 9 comps",
            payload={"source": "scrydex"},
        )

        raw_snapshot = price_snapshot_for_card(
            self.connection,
            "base1-4",
            pricing_mode=RAW_PRICING_MODE,
        )
        graded_snapshot = price_snapshot_for_card(
            self.connection,
            "base1-4",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            grader="PSA",
            grade="9",
        )
        graded_summary = contextual_pricing_summary_for_card(
            self.connection,
            "base1-4",
            grader="PSA",
            grade="9",
        )

        self.assertIsNotNone(raw_snapshot)
        self.assertIsNotNone(graded_snapshot)
        self.assertIsNotNone(graded_summary)
        assert raw_snapshot is not None
        assert graded_snapshot is not None
        assert graded_summary is not None
        legacy_tables = {
            row["name"]
            for row in self.connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name IN ('card_price_summaries', 'slab_price_snapshots')
                """
            ).fetchall()
        }
        self.assertEqual(raw_snapshot["provider"], "tcgplayer")
        self.assertEqual(raw_snapshot["market"], 150.0)
        self.assertEqual(graded_snapshot["provider"], "scrydex")
        self.assertEqual(graded_snapshot["grade"], "9")
        self.assertEqual(graded_summary["market"], 1000.0)
        self.assertEqual(graded_summary["provider"], "scrydex")
        self.assertEqual(legacy_tables, set())

    def test_upsert_scan_event_records_phase1_fields(self) -> None:
        upsert_scan_event(
            self.connection,
            scan_id="scan-123",
            request_payload={"scanID": "scan-123", "collectorNumber": "60/132"},
            response_payload={"resolverMode": "raw_card", "confidence": "medium"},
            matcher_source="remoteHybrid",
            matcher_version="phase1-test",
            selected_card_id="gym1-60",
            confidence="medium",
            review_disposition="ready",
            resolver_mode="raw_card",
            resolver_path="phase1_foundation",
            completed_at="2026-04-09T03:00:00Z",
        )
        self.connection.commit()

        row = self.connection.execute(
            """
            SELECT *
            FROM scan_events
            WHERE scan_id = ?
            LIMIT 1
            """,
            ("scan-123",),
        ).fetchone()

        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["selected_card_id"], "gym1-60")
        self.assertEqual(row["confidence"], "medium")
        self.assertEqual(row["resolver_mode"], "raw_card")
        self.assertEqual(row["resolver_path"], "phase1_foundation")

    def test_service_card_detail_reads_phase1_card_shape(self) -> None:
        upsert_catalog_card(
            self.connection,
            sample_catalog_card(),
            REPO_ROOT,
            "2026-04-09T02:00:00Z",
            refresh_embeddings=False,
        )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        detail = service.card_detail("gym1-60")
        service.connection.close()

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["id"], "gym1-60")
        self.assertEqual(detail["setID"], "gym1")
        self.assertEqual(detail["source"], "pokemontcg_api")
        self.assertEqual(detail["imageLargeURL"], "https://images.example/gym1-60-large.png")

    def test_raw_provider_import_path_persists_primary_card_record(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        raw_payload = {
            "id": "base1-4",
            "name": "Charizard",
            "number": "4",
            "rarity": "Rare Holo",
            "supertype": "Pokémon",
            "subtypes": ["Stage 2"],
            "types": ["Fire"],
            "artist": "Mitsuhiro Arita",
            "images": {
                "small": "https://images.example/base1-4-small.png",
                "large": "https://images.example/base1-4-large.png",
            },
            "set": {
                "id": "base1",
                "name": "Base Set",
                "series": "Base",
                "printedTotal": 102,
                "releaseDate": "1999-01-09",
            },
            "tcgplayer": {},
            "cardmarket": {},
        }

        mapped = service._persist_catalog_card(
            raw_card=raw_payload,
            sync_mode="exact_card_import",
            trigger_source="test",
            query_text="base1-4",
            refresh_embeddings=False,
        )
        card = card_by_id(service.connection, "base1-4")
        detail = service.card_detail("base1-4")
        service.connection.close()

        self.assertEqual(mapped["id"], "base1-4")
        self.assertIsNotNone(card)
        self.assertIsNotNone(detail)
        assert card is not None
        assert detail is not None
        self.assertEqual(card["setID"], "base1")
        self.assertEqual(card["setSeries"], "Base")
        self.assertEqual(card["imageURL"], "https://images.example/base1-4-large.png")
        self.assertEqual(detail["source"], "pokemontcg_api")
        self.assertEqual(detail["card"]["name"], "Charizard")

    def test_ensure_raw_card_cached_persists_remote_provider_pricing(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        provider_card = sample_provider_card()
        mapped = map_card(provider_card, None)
        remote_candidate = {
            "id": mapped["id"],
            "name": mapped["name"],
            "setName": mapped["set_name"],
            "number": mapped["number"],
            "rarity": mapped["rarity"],
            "variant": mapped["variant"],
            "language": mapped["language"],
            "sourceProvider": mapped["source"],
            "sourceRecordID": mapped["source_record_id"],
            "setID": mapped["set_id"],
            "setSeries": mapped["set_series"],
            "setPtcgoCode": mapped["set_ptcgo_code"],
            "imageURL": mapped["reference_image_url"],
            "imageSmallURL": mapped["reference_image_small_url"],
            "sourcePayload": provider_card,
        }

        cached = service._ensure_raw_card_cached(remote_candidate, "test_remote_cache")
        snapshot = price_snapshot_for_card(
            service.connection,
            "gym1-60",
            pricing_mode=RAW_PRICING_MODE,
        )
        service.connection.close()

        self.assertEqual(cached["id"], "gym1-60")
        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot["provider"], "tcgplayer")
        self.assertEqual(snapshot["market"], 2.5)

    def test_low_confidence_top_candidate_still_refreshes_missing_pricing(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        upsert_card(
            service.connection,
            card_id="gym1-60",
            name="Sabrina's Slowbro",
            set_name="Gym Heroes",
            number="60/132",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="pokemontcg_api",
            source_record_id="gym1-60",
            set_id="gym1",
        )
        service.connection.commit()

        match = RawCandidateMatch(
            card={
                "id": "gym1-60",
                "name": "Sabrina's Slowbro",
                "setName": "Gym Heroes",
                "number": "60/132",
                "rarity": "Common",
                "variant": "Raw",
                "language": "English",
            },
            retrieval_score=43.0,
            resolution_score=45.0,
            final_total=44.0,
            breakdown=RawCandidateScoreBreakdown(
                title_overlap_score=4.0,
                set_overlap_score=0.0,
                collector_exact_score=30.0,
                collector_partial_score=0.0,
                collector_denominator_score=8.0,
                footer_text_support_score=7.0,
                promo_support_score=0.0,
                cache_presence_score=0.0,
                contradiction_penalty=0.0,
                retrieval_total=43.0,
                resolution_total=45.0,
                final_total=44.0,
            ),
            reasons=("collector_exact",),
        )
        decision = RawDecisionResult(
            matches=(match,),
            top_candidates=(match,),
            confidence="low",
            confidence_percent=44.0,
            ambiguity_flags=("Set hints are weak",),
            resolver_path="visual_fallback",
            review_disposition="needs_review",
            review_reason="Review the best guess before relying on the card result.",
            fallback_reason="weak_set",
            selected_card_id="gym1-60",
            debug_payload={},
        )
        service.refresh_card_pricing = Mock(return_value={  # type: ignore[method-assign]
            "card": {
                "pricing": {
                    "source": "tcgplayer",
                    "pricingMode": "raw",
                    "market": 3.25,
                    "currencyCode": "USD",
                    "variant": "normal",
                    "isFresh": True,
                }
            }
        })

        response, _ = service._build_raw_match_response({"scanID": "scan-low"}, decision, api_key="test-key")
        top_candidate = response["topCandidates"][0]["candidate"]
        service.connection.close()

        service.refresh_card_pricing.assert_called_once_with("gym1-60", api_key="test-key")
        self.assertEqual(top_candidate["id"], "gym1-60")
        self.assertIn("pricing", top_candidate)
        self.assertEqual(top_candidate["pricing"]["market"], 3.25)

    def test_scrydex_mapped_import_path_persists_primary_card_record(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        scrydex_payload = {
            "data": {
                "id": "sm12a_ja-94",
                "name": "Togepi & Cleffa & Igglybuff GX",
                "language": "ja",
                "printed_number": "094/173",
                "number": "94",
                "rarity": "RR",
                "artist": "Misa Tsutsui",
                "supertype": "Pokémon",
                "subtypes": ["Basic", "TAG TEAM", "GX"],
                "types": ["Fairy"],
                "expansion": {
                    "id": "sm12a_ja",
                    "name": "Tag Team GX All Stars",
                    "series": "Sun & Moon",
                    "release_date": "2019-10-04",
                    "language": "ja",
                },
                "translation": {
                    "en": {
                        "name": "Togepi & Cleffa & Igglybuff GX",
                        "rarity": "Rare Holo GX",
                        "supertype": "Pokémon",
                        "subtypes": ["Basic", "TAG TEAM", "GX"],
                        "types": ["Fairy"],
                    }
                },
                "images": [
                    {
                        "type": "front",
                        "small": "https://images.example/sm12a_ja-94-small.png",
                        "large": "https://images.example/sm12a_ja-94-large.png",
                    }
                ],
            }
        }

        mapped = map_scrydex_catalog_card(scrydex_payload)
        service._persist_mapped_catalog_card(
            mapped_card=mapped,
            sync_mode="slab_catalog_miss",
            trigger_source="test",
            query_text="sm12a_ja-94",
            refresh_embeddings=False,
        )
        card = card_by_id(service.connection, "sm12a_ja-94")
        detail = service.card_detail("sm12a_ja-94")
        service.connection.close()

        self.assertIsNotNone(card)
        self.assertIsNotNone(detail)
        assert card is not None
        assert detail is not None
        self.assertEqual(card["sourceProvider"], "scrydex")
        self.assertEqual(card["setID"], "sm12a_ja")
        self.assertEqual(card["setSeries"], "Sun & Moon")
        self.assertEqual(card["number"], "094/173")
        self.assertEqual(detail["source"], "scrydex")
        self.assertEqual(detail["card"]["setName"], "Tag Team GX All Stars")

    def test_ensure_raw_card_cached_persists_scrydex_search_result_pricing(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        scrydex_payload = sample_scrydex_card()
        mapped = map_scrydex_catalog_card(scrydex_payload)
        remote_candidate = {
            "id": mapped["id"],
            "name": mapped["name"],
            "setName": mapped["set_name"],
            "number": mapped["number"],
            "rarity": mapped["rarity"],
            "variant": mapped["variant"],
            "language": mapped["language"],
            "sourceProvider": mapped["source"],
            "sourceRecordID": mapped["source_record_id"],
            "setID": mapped["set_id"],
            "setSeries": mapped["set_series"],
            "setPtcgoCode": mapped["set_ptcgo_code"],
            "imageURL": mapped["reference_image_url"],
            "imageSmallURL": mapped["reference_image_small_url"],
            "sourcePayload": scrydex_payload,
        }

        cached = service._ensure_raw_card_cached(remote_candidate, "test_scrydex_cache")
        snapshot = price_snapshot_for_card(
            service.connection,
            "m2a_ja-232",
            pricing_mode=RAW_PRICING_MODE,
        )
        service.connection.close()

        self.assertEqual(cached["id"], "m2a_ja-232")
        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot["provider"], "scrydex")
        self.assertEqual(snapshot["currencyCode"], "JPY")
        self.assertEqual(snapshot["market"], 2550.0)
        self.assertEqual(snapshot["variant"], "holofoil")

    def test_refresh_card_pricing_uses_scrydex_provider_for_scrydex_raw_cards(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        service._persist_mapped_catalog_card(
            mapped_card=map_scrydex_catalog_card(sample_scrydex_card()),
            sync_mode="raw_candidate_cache",
            trigger_source="test",
            query_text="m2a_ja-232",
            refresh_embeddings=False,
        )
        scrydex_provider = service.pricing_registry.get_provider("scrydex")
        pokemontcg_provider = service.pricing_registry.get_provider("pokemontcg_api")
        assert scrydex_provider is not None
        assert pokemontcg_provider is not None
        scrydex_provider.refresh_raw_pricing = Mock(return_value=RawPricingResult(  # type: ignore[method-assign]
            success=True,
            provider_id="scrydex",
            card_id="m2a_ja-232",
            payload={"id": "m2a_ja-232"},
        ))
        pokemontcg_provider.refresh_raw_pricing = Mock(return_value=RawPricingResult(  # type: ignore[method-assign]
            success=True,
            provider_id="pokemontcg_api",
            card_id="m2a_ja-232",
            payload={"id": "m2a_ja-232"},
        ))

        service.refresh_card_pricing("m2a_ja-232")
        service.connection.close()

        scrydex_provider.refresh_raw_pricing.assert_called_once_with(service.connection, "m2a_ja-232")
        pokemontcg_provider.refresh_raw_pricing.assert_not_called()

    def test_card_detail_keeps_native_jpy_snapshot_but_returns_usd_display_pricing(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        scrydex_payload = sample_scrydex_card()
        mapped = map_scrydex_catalog_card(scrydex_payload)
        remote_candidate = {
            "id": mapped["id"],
            "name": mapped["name"],
            "setName": mapped["set_name"],
            "number": mapped["number"],
            "rarity": mapped["rarity"],
            "variant": mapped["variant"],
            "language": mapped["language"],
            "sourceProvider": mapped["source"],
            "sourceRecordID": mapped["source_record_id"],
            "setID": mapped["set_id"],
            "setSeries": mapped["set_series"],
            "setPtcgoCode": mapped["set_ptcgo_code"],
            "imageURL": mapped["reference_image_url"],
            "imageSmallURL": mapped["reference_image_small_url"],
            "sourcePayload": scrydex_payload,
        }
        service._ensure_raw_card_cached(remote_candidate, "test_scrydex_cache")

        stored_snapshot = price_snapshot_for_card(
            service.connection,
            "m2a_ja-232",
            pricing_mode=RAW_PRICING_MODE,
        )
        assert stored_snapshot is not None
        self.assertEqual(stored_snapshot["currencyCode"], "JPY")
        self.assertEqual(stored_snapshot["market"], 2550.0)

        with patch("fx_rates.ensure_fx_rate_snapshot", return_value={
            "baseCurrency": "JPY",
            "quoteCurrency": "USD",
            "rate": 0.0063,
            "source": "ecb",
            "effectiveAt": "2026-04-09",
            "refreshedAt": "2026-04-10T00:00:00Z",
            "isFresh": True,
        }):
            detail = service.card_detail("m2a_ja-232")
        service.connection.close()

        self.assertIsNotNone(detail)
        assert detail is not None
        pricing = detail["card"]["pricing"]
        self.assertIsNotNone(pricing)
        assert pricing is not None
        self.assertEqual(pricing["currencyCode"], "USD")
        self.assertEqual(pricing["nativeCurrencyCode"], "JPY")
        self.assertEqual(pricing["market"], 16.07)
        self.assertEqual(pricing["nativeMarket"], 2550.0)
        self.assertEqual(pricing["fxSource"], "ecb")

    def test_reimport_updates_existing_card_row_in_primary_cards_table(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        original = sample_catalog_card()
        updated = sample_catalog_card()
        updated["name"] = "Sabrina's Slowbro (Updated)"
        updated["set_series"] = "Gym Updated"
        updated["reference_image_url"] = "https://images.example/gym1-60-v2-large.png"

        service._persist_mapped_catalog_card(
            mapped_card=original,
            sync_mode="exact_card_import",
            trigger_source="test",
            query_text="gym1-60",
            refresh_embeddings=False,
        )
        service._persist_mapped_catalog_card(
            mapped_card=updated,
            sync_mode="refresh_existing_card",
            trigger_source="test",
            query_text="gym1-60",
            refresh_embeddings=False,
        )

        card = card_by_id(service.connection, "gym1-60")
        detail = service.card_detail("gym1-60")
        service.connection.close()

        self.assertIsNotNone(card)
        self.assertIsNotNone(detail)
        assert card is not None
        assert detail is not None
        self.assertEqual(card["name"], "Sabrina's Slowbro (Updated)")
        self.assertEqual(card["setSeries"], "Gym Updated")
        self.assertEqual(card["imageURL"], "https://images.example/gym1-60-v2-large.png")
        self.assertEqual(detail["card"]["name"], "Sabrina's Slowbro (Updated)")


if __name__ == "__main__":
    unittest.main()
