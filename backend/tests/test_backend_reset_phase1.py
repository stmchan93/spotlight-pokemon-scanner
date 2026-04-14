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
from pricing_provider import PsaPricingResult, RawPricingResult  # noqa: E402
from scrydex_adapter import (  # noqa: E402
    _best_scrydex_graded_price,
    map_scrydex_catalog_card,
    search_remote_scrydex_slab_candidates,
)
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
        "source": "scrydex",
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
                    ,
                    {
                        "company": "PSA",
                        "grade": "9",
                        "is_perfect": False,
                        "is_signed": False,
                        "is_error": False,
                        "type": "graded",
                        "low": 28.0,
                        "mid": 31.0,
                        "high": 44.0,
                        "market": 30.83,
                        "currency": "USD",
                    }
                ],
            }
        ],
    }


def sample_slab_scan_payload() -> dict[str, object]:
    return {
        "scanID": "scan-slab-1",
        "capturedAt": "2026-04-09T04:00:00Z",
        "resolverModeHint": "psa_slab",
        "cropConfidence": 0.91,
        "setHintTokens": ["m2a"],
        "warnings": [],
        "ocrAnalysis": {
            "slabEvidence": {
                "titleTextPrimary": "Mega Dragonite ex",
                "titleTextSecondary": None,
                "cardNumber": "232/193",
                "setHints": ["m2a"],
                "grader": "PSA",
                "grade": "9",
                "cert": "12345678",
                "labelWideText": "PSA 9 Mega Dragonite ex 232/193 M2a",
            }
        },
        "slabGrader": "PSA",
        "slabGrade": "9",
        "slabCertNumber": "12345678",
        "slabCardNumberRaw": "232/193",
    }


def sample_pgo_charizard_scrydex_card() -> dict[str, object]:
    return {
        "id": "pgo-10",
        "name": "Charizard",
        "language": "en",
        "language_code": "EN",
        "printed_number": "010/078",
        "number": "10",
        "rarity": "Rare Holo",
        "artist": "NC Empire",
        "supertype": "Pokémon",
        "subtypes": ["Stage 2"],
        "types": ["Fire"],
        "expansion": {
            "id": "pgo",
            "name": "Pokemon GO",
            "code": "PGO",
            "series": "Sword & Shield",
            "release_date": "2022-07-01",
            "language": "en",
        },
        "translation": {},
        "images": [
            {
                "type": "front",
                "small": "https://images.example/pgo-10-small.png",
                "large": "https://images.example/pgo-10-large.png",
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
                        "low": 3.0,
                        "mid": 4.0,
                        "high": 6.0,
                        "market": 4.5,
                        "currency": "USD",
                    },
                    {
                        "company": "PSA",
                        "grade": "7",
                        "is_perfect": False,
                        "is_signed": False,
                        "is_error": False,
                        "type": "graded",
                        "low": 19.0,
                        "mid": 23.0,
                        "high": 28.0,
                        "market": 24.99,
                        "currency": "USD",
                    },
                ],
            }
        ],
    }


def sample_charizard_slab_scan_payload() -> dict[str, object]:
    return {
        "scanID": "scan-slab-charizard",
        "capturedAt": "2026-04-10T04:07:49Z",
        "resolverModeHint": "psa_slab",
        "cropConfidence": 0.81,
        "setHintTokens": [],
        "warnings": ["Could not extract slab barcode payload"],
        "ocrAnalysis": {
            "slabEvidence": {
                "titleTextPrimary": "2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 PSA 103377816",
                "titleTextSecondary": None,
                "cardNumber": "010",
                "setHints": [],
                "grader": "PSA",
                "grade": "7",
                "cert": "103377816",
                "labelWideText": "2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 PSA 103377816 2022 POKEMON GO CHARIZARD-HOLO #010 NM 7 PSA 103377816",
            }
        },
        "slabGrader": "PSA",
        "slabGrade": "7",
        "slabCertNumber": "103377816",
        "slabCardNumberRaw": "010",
        "slabParsedLabelText": [
            "2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 PSA 103377816",
            "2022 POKEMON GO CHARIZARD-HOLO #010 NM 7 PSA 103377816",
        ],
        "slabRecommendedLookupPath": "psa_cert",
    }


def sample_noisy_charizard_slab_scan_payload() -> dict[str, object]:
    return {
        "scanID": "scan-slab-charizard-noisy",
        "capturedAt": "2026-04-10T04:36:09Z",
        "resolverModeHint": "psa_slab",
        "cropConfidence": 0.72,
        "setHintTokens": [],
        "warnings": ["Could not extract slab barcode payload"],
        "ocrAnalysis": {
            "slabEvidence": {
                "titleTextPrimary": "wetwenvery + $4.99 de 2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 PSA 103377816",
                "titleTextSecondary": "Charizard",
                "cardNumber": "010",
                "setHints": [],
                "grader": "PSA",
                "grade": "7",
                "cert": "103377816",
                "labelWideText": (
                    "wrwenvery + $4.99 d 2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 "
                    "wettwelvery + $4.99 2022 POKEMON GO #010 CHARIZARD-HOLO NM "
                    "wetwenvery + $4.99 de 2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 PSA 103377816 #010"
                ),
            }
        },
        "slabGrader": "PSA",
        "slabGrade": "7",
        "slabCertNumber": "103377816",
        "slabCardNumberRaw": "010",
        "slabParsedLabelText": [
            "wrwenvery + $4.99 d 2022 POKEMON GO #010 CHARIZARD-HOLO NM 7",
            "wetwenvery + $4.99 de 2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 PSA 103377816",
        ],
        "slabRecommendedLookupPath": "psa_cert",
    }


def sample_xy_promo_pikachu_scrydex_card() -> dict[str, object]:
    return {
        "id": "xyp_ja-150",
        "name": "コイキングごっこピカチュウ",
        "language": "ja",
        "language_code": "JA",
        "printed_number": "150",
        "number": "150",
        "rarity": "Promo",
        "artist": "Naoki Saito",
        "supertype": "Pokémon",
        "subtypes": ["Basic"],
        "types": ["Lightning"],
        "expansion": {
            "id": "xyp_ja",
            "name": "XY Promos",
            "series": "XY",
            "language": "ja",
        },
        "translation": {
            "en": {
                "name": "Pretend Magikarp Pikachu",
            }
        },
        "images": [
            {
                "type": "front",
                "small": "https://images.example/xyp_ja-150-small.png",
                "large": "https://images.example/xyp_ja-150-large.png",
            }
        ],
        "variants": [],
    }


def sample_base_pikachu_scrydex_card() -> dict[str, object]:
    return {
        "id": "base1-58",
        "name": "Pikachu",
        "language": "en",
        "language_code": "EN",
        "printed_number": "58/102",
        "number": "58",
        "rarity": "Common",
        "artist": "Mitsuhiro Arita",
        "supertype": "Pokémon",
        "subtypes": ["Basic"],
        "types": ["Lightning"],
        "expansion": {
            "id": "base1",
            "name": "Base",
            "series": "Base",
            "language": "en",
        },
        "translation": {},
        "images": [
            {
                "type": "front",
                "small": "https://images.example/base1-58-small.png",
                "large": "https://images.example/base1-58-large.png",
            }
        ],
        "variants": [
            {
                "name": "firstEditionShadowless",
                "prices": [
                    {
                        "grade": "7",
                        "company": "PSA",
                        "is_perfect": False,
                        "is_signed": False,
                        "is_error": False,
                        "type": "graded",
                        "low": 173.5,
                        "mid": 195.25,
                        "high": 325.0,
                        "market": 269.73,
                        "currency": "USD",
                    }
                ],
            },
            {
                "name": "unlimitedShadowless",
                "prices": [
                    {
                        "grade": "7",
                        "company": "PSA",
                        "is_perfect": False,
                        "is_signed": False,
                        "is_error": False,
                        "type": "graded",
                        "low": 39.99,
                        "mid": 49.99,
                        "high": 95.26,
                        "market": 58.55,
                        "currency": "USD",
                    }
                ],
            },
            {
                "name": "unlimitedShadowlessRedCheeks",
                "prices": [
                    {
                        "grade": "7",
                        "company": "PSA",
                        "is_perfect": False,
                        "is_signed": False,
                        "is_error": False,
                        "type": "graded",
                        "low": 46.0,
                        "mid": 87.5,
                        "high": 133.64,
                        "market": 92.88,
                        "currency": "USD",
                    }
                ],
            },
        ],
    }


def sample_xy_promo_pikachu_slab_scan_payload() -> dict[str, object]:
    return {
        "scanID": "scan-slab-pikachu-jp-promo",
        "capturedAt": "2026-04-10T04:42:28Z",
        "resolverModeHint": "psa_slab",
        "cropConfidence": 0.77,
        "setHintTokens": [],
        "warnings": ["Could not extract slab barcode payload"],
        "ocrAnalysis": {
            "slabEvidence": {
                "titleTextPrimary": "2015 P.M. JAPANESE XY #150 PRTD.MGKRP. PIKACHU GEM MT PROMO - HOLO 10 PA 24925641",
                "titleTextSecondary": None,
                "cardNumber": "150",
                "setHints": [],
                "grader": "PSA",
                "grade": "10",
                "cert": "24925641",
                "labelWideText": (
                    "2015 P.M. JAPANESE XY #150 PRTD.MGKRP. PIKACHU GEM MT PROMO - HOLO 10 PA 24925641 "
                    "2015 P.M. JAPANESE XY #150 PRTD.MGKRP. PIKACHU GEM MT PROMO - HOLO 10 24925641"
                ),
            }
        },
        "slabGrader": "PSA",
        "slabGrade": "10",
        "slabCertNumber": "24925641",
        "slabCardNumberRaw": "150",
        "slabParsedLabelText": [
            "2015 P.M. JAPANESE XY #150 PRTD.MGKRP. PIKACHU GEM MT PROMO - HOLO 10 PA 24925641",
            "2015 P.M. JAPANESE XY #150 PRTD.MGKRP. PIKACHU GEM MT PROMO - HOLO 10 24925641",
            "E XY # 150 HU GEM MT 10 24925641",
        ],
        "slabRecommendedLookupPath": "psa_cert",
    }


def sample_shadowless_pikachu_slab_scan_payload() -> dict[str, object]:
    return {
        "scanID": "scan-slab-pikachu-shadowless",
        "capturedAt": "2026-04-10T04:46:41Z",
        "resolverModeHint": "psa_slab",
        "cropConfidence": 0.77,
        "setHintTokens": [],
        "warnings": ["Could not extract slab barcode payload"],
        "ocrAnalysis": {
            "slabEvidence": {
                "titleTextPrimary": "1999 POKEMON GAME #58 PIK ACHU NM YEL. CHEEKS - SHADOWLESS 7 FEA 53447910",
                "titleTextSecondary": None,
                "cardNumber": "58",
                "setHints": [],
                "grader": "PSA",
                "grade": "7",
                "cert": "53447910",
                "labelWideText": (
                    "1999 POKEMON GAME #58 PIK ACHU NM YEL CHEEKS - SHADOWLESS 7 PEA 53447910 "
                    "1999 POKEMON GAME #58 PIKACHU NM YEL CHEEKS - SHADOWLESS 7 PEA 53447910 "
                    "1999 POKEMON GAME #58 PIK ACHU NM YEL. CHEEKS - SHADOWLESS 7 FEA 53447910"
                ),
            }
        },
        "slabGrader": "PSA",
        "slabGrade": "7",
        "slabCertNumber": "53447910",
        "slabCardNumberRaw": "58",
        "slabParsedLabelText": [
            "1999 POKEMON GAME #58 PIK ACHU NM YEL CHEEKS - SHADOWLESS 7 PEA 53447910",
            "1999 POKEMON GAME #58 PIKACHU NM YEL CHEEKS - SHADOWLESS 7 PEA 53447910",
            "1999 POKEMON GAME #58 PIK ACHU NM YEL. CHEEKS - SHADOWLESS 7 FEA 53447910",
            "#58 NM NLESS 7 53447910",
        ],
        "slabRecommendedLookupPath": "psa_cert",
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
            source_provider="scrydex",
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
        self.assertEqual(card["sourceProvider"], "scrydex")

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
        self.assertEqual(detail["source"], "scrydex")
        self.assertEqual(detail["imageLargeURL"], "https://images.example/gym1-60-large.png")

    def test_import_catalog_card_uses_scrydex_exact_import_path(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        with patch("server.fetch_scrydex_card_by_id", return_value=sample_scrydex_card()):
            mapped = service.import_catalog_card("m2a_ja-232", trigger_source="test")
        card = card_by_id(service.connection, "m2a_ja-232")
        detail = service.card_detail("m2a_ja-232")
        service.connection.close()

        self.assertEqual(mapped["id"], "m2a_ja-232")
        self.assertIsNotNone(card)
        self.assertIsNotNone(detail)
        assert card is not None
        assert detail is not None
        self.assertEqual(card["setID"], "m2a_ja")
        self.assertEqual(card["setSeries"], "Scarlet & Violet")
        self.assertEqual(card["imageURL"], "https://images.example/m2a_ja-232-large.png")
        self.assertEqual(detail["source"], "scrydex")
        self.assertEqual(detail["card"]["name"], "Mega Dragonite ex")

    def test_low_confidence_top_candidate_skips_live_pricing_refresh(self) -> None:
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
            source_provider="scrydex",
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
                set_badge_image_score=0.0,
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

        service.refresh_card_pricing.assert_not_called()
        self.assertEqual(top_candidate["id"], "gym1-60")
        self.assertNotIn("pricing", top_candidate)

    def test_medium_confidence_ready_top_candidate_still_refreshes_missing_pricing(self) -> None:
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
            source_provider="scrydex",
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
            retrieval_score=68.0,
            resolution_score=72.0,
            final_total=70.0,
            breakdown=RawCandidateScoreBreakdown(
                title_overlap_score=12.0,
                set_overlap_score=15.0,
                set_badge_image_score=0.0,
                collector_exact_score=30.0,
                collector_partial_score=0.0,
                collector_denominator_score=8.0,
                footer_text_support_score=7.0,
                promo_support_score=0.0,
                cache_presence_score=0.0,
                contradiction_penalty=0.0,
                retrieval_total=68.0,
                resolution_total=72.0,
                final_total=70.0,
            ),
            reasons=("collector_exact", "set_overlap"),
        )
        decision = RawDecisionResult(
            matches=(match,),
            top_candidates=(match,),
            confidence="medium",
            confidence_percent=70.0,
            ambiguity_flags=tuple(),
            resolver_path="visual_fallback",
            review_disposition="ready",
            review_reason=None,
            fallback_reason=None,
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

        response, _ = service._build_raw_match_response({"scanID": "scan-medium"}, decision, api_key="test-key")
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
        assert scrydex_provider is not None
        self.assertIsNone(service.pricing_registry.get_provider("pokemontcg_api"))
        scrydex_provider.refresh_raw_pricing = Mock(return_value=RawPricingResult(  # type: ignore[method-assign]
            success=True,
            provider_id="scrydex",
            card_id="m2a_ja-232",
            payload={"id": "m2a_ja-232"},
        ))

        service.refresh_card_pricing("m2a_ja-232")
        service.connection.close()

        scrydex_provider.refresh_raw_pricing.assert_called_once_with(service.connection, "m2a_ja-232")

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

    def test_refresh_card_pricing_uses_scrydex_provider_for_exact_slab_grade(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        service._persist_mapped_catalog_card(
            mapped_card=map_scrydex_catalog_card(sample_scrydex_card()),
            sync_mode="slab_candidate_cache",
            trigger_source="test",
            query_text="m2a_ja-232",
            refresh_embeddings=False,
        )
        scrydex_provider = service.pricing_registry.get_provider("scrydex")
        assert scrydex_provider is not None
        scrydex_provider.refresh_psa_pricing = Mock(return_value=PsaPricingResult(  # type: ignore[method-assign]
            success=True,
            provider_id="scrydex",
            card_id="m2a_ja-232",
            grader="PSA",
            grade="9",
            payload={"id": "m2a_ja-232"},
        ))

        service.refresh_card_pricing("m2a_ja-232", grader="PSA", grade="9")
        service.connection.close()

        scrydex_provider.refresh_psa_pricing.assert_called_once_with(service.connection, "m2a_ja-232", "PSA", "9")

    def test_match_scan_resolves_psa_slab_and_returns_exact_grade_pricing(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        with patch("server.search_remote_scrydex_slab_candidates") as search_scrydex:
            search_scrydex.return_value = type("SlabSearchResult", (), {
                "cards": [sample_scrydex_card()],
                "attempts": [
                    {
                        "query": 'name:"Mega Dragonite ex" printed_number:"232/193" expansion.code:m2a',
                        "count": 1,
                        "error": None,
                    }
                ],
            })()

            response = service.match_scan(sample_slab_scan_payload())

        service.connection.close()

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["reviewDisposition"], "ready")
        self.assertEqual(response["slabContext"]["grader"], "PSA")
        self.assertEqual(response["slabContext"]["grade"], "9")
        self.assertEqual(response["slabContext"]["certNumber"], "12345678")
        top_candidate = response["topCandidates"][0]["candidate"]
        self.assertEqual(top_candidate["id"], "m2a_ja-232")
        self.assertEqual(top_candidate["pricing"]["pricingMode"], "psa_grade_estimate")
        self.assertEqual(top_candidate["pricing"]["grader"], "PSA")
        self.assertEqual(top_candidate["pricing"]["grade"], "9")
        self.assertEqual(top_candidate["pricing"]["provider"], "scrydex")
        self.assertEqual(top_candidate["pricing"]["market"], 30.83)

    def test_build_slab_evidence_normalizes_card_number_and_infers_set_and_title(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        evidence = service._build_slab_evidence(sample_charizard_slab_scan_payload())
        service.connection.close()

        self.assertEqual(evidence.card_number, "10")
        self.assertEqual(evidence.title_text_primary, "Charizard")
        self.assertIn("pokemon go", evidence.set_hint_tokens)
        self.assertIn("pgo", evidence.set_hint_tokens)

    def test_build_slab_evidence_ignores_noisy_marketplace_prefixes_when_set_is_explicit(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        evidence = service._build_slab_evidence(sample_noisy_charizard_slab_scan_payload())
        service.connection.close()

        self.assertEqual(evidence.card_number, "10")
        self.assertEqual(evidence.title_text_primary, "Charizard")
        self.assertEqual(evidence.title_text_secondary, "Charizard")
        self.assertEqual(evidence.set_hint_tokens, ("pokemon go", "pgo"))

    def test_build_slab_evidence_infers_japanese_xy_promo_scope_and_expands_title_abbreviations(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        evidence = service._build_slab_evidence(sample_xy_promo_pikachu_slab_scan_payload())
        service.connection.close()

        self.assertEqual(evidence.card_number, "150")
        self.assertEqual(evidence.title_text_primary, "Pretend Magikarp Pikachu")
        self.assertEqual(evidence.title_text_secondary, "Pretend Magikarp Pikachu")
        self.assertIn("xy promos", evidence.set_hint_tokens)
        self.assertIn("xyp_ja", evidence.set_hint_tokens)

    def test_build_slab_evidence_merges_split_pikachu_and_skips_generic_pokemon_game_hint(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        evidence = service._build_slab_evidence(sample_shadowless_pikachu_slab_scan_payload())
        service.connection.close()

        self.assertEqual(evidence.card_number, "58")
        self.assertEqual(evidence.title_text_primary, "Pikachu")
        self.assertEqual(evidence.title_text_secondary, "Pikachu")
        self.assertEqual(evidence.set_hint_tokens, ("base",))
        self.assertEqual(
            evidence.variant_hints,
            {
                "shadowless": True,
                "firstEdition": False,
                "redCheeks": False,
                "yellowCheeks": True,
                "jumbo": False,
            },
        )

    def test_best_scrydex_graded_price_prefers_yellow_cheeks_shadowless_variant(self) -> None:
        selected = _best_scrydex_graded_price(
            sample_base_pikachu_scrydex_card(),
            grader="PSA",
            grade="7",
            variant_hints={
                "shadowless": True,
                "firstEdition": False,
                "redCheeks": False,
                "yellowCheeks": True,
                "jumbo": False,
            },
        )

        self.assertIsNotNone(selected)
        assert selected is not None
        variant_name, price = selected
        self.assertEqual(variant_name, "unlimitedShadowless")
        self.assertEqual(price["market"], 58.55)

    def test_best_scrydex_graded_price_prefers_exact_requested_variant(self) -> None:
        selected = _best_scrydex_graded_price(
            sample_base_pikachu_scrydex_card(),
            grader="PSA",
            grade="7",
            preferred_variant="Unlimited Shadowless Red Cheeks",
            variant_hints={
                "shadowless": True,
                "firstEdition": False,
                "redCheeks": False,
                "yellowCheeks": True,
                "jumbo": False,
            },
        )

        self.assertIsNotNone(selected)
        assert selected is not None
        variant_name, price = selected
        self.assertEqual(variant_name, "unlimitedShadowlessRedCheeks")
        self.assertEqual(price["market"], 92.88)

    def test_search_remote_scrydex_slab_candidates_uses_japanese_route_for_japanese_promos(self) -> None:
        with patch("scrydex_adapter._scrydex_run_japanese_query") as run_ja, patch(
            "scrydex_adapter._scrydex_run_cards_query"
        ) as run_cards:
            run_ja.side_effect = lambda query, include_prices, page_size, request_type: (
                [sample_xy_promo_pikachu_scrydex_card()]
                if query == 'number:"150" expansion.name:"XY Promos"'
                else []
            )
            run_cards.return_value = []

            result = search_remote_scrydex_slab_candidates(
                title_text="Pretend Magikarp Pikachu",
                label_text="2015 P.M. JAPANESE XY #150 PRTD.MGKRP. PIKACHU GEM MT PROMO - HOLO 10",
                parsed_label_text=[],
                card_number="150",
                set_hint_tokens=["XY Promos", "xyp_ja"],
            )

        self.assertEqual([card["id"] for card in result.cards], ["xyp_ja-150"])
        self.assertGreaterEqual(run_ja.call_count, 1)
        run_cards.assert_not_called()

    def test_search_remote_scrydex_slab_candidates_uses_name_scope_for_plain_english_set_names(self) -> None:
        with patch("scrydex_adapter._scrydex_run_cards_query") as run_cards:
            run_cards.side_effect = lambda query, include_prices, page_size, request_type: (
                [{
                    "id": "base1-58",
                    "name": "Pikachu",
                    "number": "58",
                    "expansion": {"id": "base1", "name": "Base"},
                }]
                if query == 'name:"Pikachu" number:"58" expansion.name:"Base"'
                else []
            )

            result = search_remote_scrydex_slab_candidates(
                title_text="Pikachu",
                label_text="1999 POKEMON GAME #58 PIKACHU NM YEL CHEEKS SHADOWLESS 7 53447910",
                parsed_label_text=[],
                card_number="58",
                set_hint_tokens=["Base"],
            )

        self.assertEqual([card["id"] for card in result.cards], ["base1-58"])
        self.assertEqual(result.attempts[0]["query"], 'name:"Pikachu" number:"58" expansion.name:"Base"')

    def test_refresh_card_pricing_passes_preferred_slab_variant_to_provider(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        mapped = map_scrydex_catalog_card(sample_base_pikachu_scrydex_card())
        service._persist_mapped_catalog_card(
            mapped_card=mapped,
            sync_mode="raw_candidate_cache",
            trigger_source="test",
            query_text="base1-58",
            refresh_embeddings=False,
        )
        scrydex_provider = service.pricing_registry.get_provider("scrydex")
        assert scrydex_provider is not None
        scrydex_provider.refresh_psa_pricing = Mock(return_value=PsaPricingResult(  # type: ignore[method-assign]
            success=True,
            provider_id="scrydex",
            card_id="base1-58",
            grader="PSA",
            grade="7",
            payload={"id": "base1-58"},
        ))

        service.refresh_card_pricing(
            "base1-58",
            grader="PSA",
            grade="7",
            preferred_variant="Unlimited Shadowless",
        )
        service.connection.close()

        scrydex_provider.refresh_psa_pricing.assert_called_once_with(
            service.connection,
            "base1-58",
            "PSA",
            "7",
            preferred_variant="Unlimited Shadowless",
        )

    def test_match_scan_resolves_psa_slab_with_cleaned_label_number(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        with patch("server.search_remote_scrydex_slab_candidates") as search_scrydex:
            search_scrydex.return_value = type("SlabSearchResult", (), {
                "cards": [sample_pgo_charizard_scrydex_card()],
                "attempts": [
                    {
                        "query": 'name:"Charizard" number:"10" expansion.name:"pokemon go"',
                        "count": 1,
                        "error": None,
                    }
                ],
            })()

            response = service.match_scan(sample_charizard_slab_scan_payload())

        service.connection.close()

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["reviewDisposition"], "ready")
        self.assertEqual(response["slabContext"]["grader"], "PSA")
        self.assertEqual(response["slabContext"]["grade"], "7")
        top_candidate = response["topCandidates"][0]["candidate"]
        self.assertEqual(top_candidate["id"], "pgo-10")
        self.assertEqual(top_candidate["name"], "Charizard")
        self.assertEqual(top_candidate["pricing"]["pricingMode"], "psa_grade_estimate")
        self.assertEqual(top_candidate["pricing"]["grader"], "PSA")
        self.assertEqual(top_candidate["pricing"]["grade"], "7")
        self.assertEqual(top_candidate["pricing"]["provider"], "scrydex")
        self.assertIsNotNone(top_candidate["pricing"]["market"])

    def test_match_scan_uses_cached_psa_cert_resolution_from_prior_scan(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        scrydex_provider = service.pricing_registry.get_provider("scrydex")
        assert scrydex_provider is not None
        scrydex_provider.refresh_psa_pricing = Mock(return_value=PsaPricingResult(  # type: ignore[method-assign]
            success=False,
            provider_id="scrydex",
            card_id="m2a_ja-232",
            grader="PSA",
            grade="9",
            error="skip live pricing refresh in cert cache test",
        ))

        service._persist_mapped_catalog_card(
            mapped_card=map_scrydex_catalog_card(sample_scrydex_card()),
            sync_mode="raw_candidate_cache",
            trigger_source="test",
            query_text="m2a_ja-232",
            refresh_embeddings=False,
        )
        upsert_scan_event(
            service.connection,
            scan_id="prior-slab-cert-scan",
            request_payload={
                "scanID": "prior-slab-cert-scan",
                "resolverModeHint": "psa_slab",
                "slabCertNumber": "12345678",
                "slabBarcodePayloads": [],
            },
            response_payload={
                "scanID": "prior-slab-cert-scan",
                "resolverMode": "psa_slab",
                "resolverPath": "psa_label",
                "reviewDisposition": "ready",
                "slabContext": {
                    "grader": "PSA",
                    "grade": "9",
                    "certNumber": "12345678",
                },
            },
            matcher_source="remoteHybrid",
            matcher_version="test",
            created_at="2026-04-10T00:00:00+00:00",
            selected_card_id="m2a_ja-232",
            confidence="high",
            review_disposition="ready",
            resolver_mode="psa_slab",
            resolver_path="psa_label",
            completed_at="2026-04-10T00:00:02+00:00",
        )
        service.connection.commit()

        with patch("server.search_remote_scrydex_slab_candidates", side_effect=AssertionError("remote slab lookup should be bypassed")):
            response = service.match_scan(sample_slab_scan_payload())

        service.connection.close()

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["resolverPath"], "psa_cert_ocr")
        self.assertEqual(response["reviewDisposition"], "ready")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "m2a_ja-232")

    def test_match_scan_marks_barcode_backed_cached_psa_cert_resolution(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        scrydex_provider = service.pricing_registry.get_provider("scrydex")
        assert scrydex_provider is not None
        scrydex_provider.refresh_psa_pricing = Mock(return_value=PsaPricingResult(  # type: ignore[method-assign]
            success=False,
            provider_id="scrydex",
            card_id="m2a_ja-232",
            grader="PSA",
            grade="9",
            error="skip live pricing refresh in cert cache test",
        ))

        service._persist_mapped_catalog_card(
            mapped_card=map_scrydex_catalog_card(sample_scrydex_card()),
            sync_mode="raw_candidate_cache",
            trigger_source="test",
            query_text="m2a_ja-232",
            refresh_embeddings=False,
        )
        upsert_scan_event(
            service.connection,
            scan_id="prior-slab-barcode-cert-scan",
            request_payload={
                "scanID": "prior-slab-barcode-cert-scan",
                "resolverModeHint": "psa_slab",
                "slabCertNumber": "12345678",
                "slabBarcodePayloads": ["12345678"],
            },
            response_payload={
                "scanID": "prior-slab-barcode-cert-scan",
                "resolverMode": "psa_slab",
                "resolverPath": "psa_label",
                "reviewDisposition": "ready",
                "slabContext": {
                    "grader": "PSA",
                    "grade": "9",
                    "certNumber": "12345678",
                },
            },
            matcher_source="remoteHybrid",
            matcher_version="test",
            created_at="2026-04-10T00:10:00+00:00",
            selected_card_id="m2a_ja-232",
            confidence="high",
            review_disposition="ready",
            resolver_mode="psa_slab",
            resolver_path="psa_label",
            completed_at="2026-04-10T00:10:02+00:00",
        )
        service.connection.commit()

        payload = dict(sample_slab_scan_payload())
        payload["slabBarcodePayloads"] = ["12345678"]

        with patch("server.search_remote_scrydex_slab_candidates", side_effect=AssertionError("remote slab lookup should be bypassed")):
            response = service.match_scan(payload)

        service.connection.close()

        self.assertEqual(response["resolverPath"], "psa_cert_barcode")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "m2a_ja-232")

    def test_match_scan_returns_slab_identity_even_without_exact_grade_pricing(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        scrydex_provider = service.pricing_registry.get_provider("scrydex")
        assert scrydex_provider is not None
        scrydex_provider.refresh_psa_pricing = Mock(return_value=PsaPricingResult(  # type: ignore[method-assign]
            success=False,
            provider_id="scrydex",
            card_id="m2a_ja-232",
            grader="PSA",
            grade="9",
            error="no exact grade price",
        ))

        priceless_card = sample_scrydex_card()
        priceless_card["variants"] = [
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
                    }
                ],
            }
        ]

        with patch("server.search_remote_scrydex_slab_candidates") as search_scrydex:
            search_scrydex.return_value = type("SlabSearchResult", (), {
                "cards": [priceless_card],
                "attempts": [
                    {
                        "query": 'name:"Mega Dragonite ex" printed_number:"232/193" expansion.code:m2a',
                        "count": 1,
                        "error": None,
                    }
                ],
            })()

            response = service.match_scan(sample_slab_scan_payload())

        service.connection.close()

        self.assertEqual(response["resolverMode"], "psa_slab")
        self.assertEqual(response["reviewDisposition"], "ready")
        self.assertIn("Exact graded pricing is unavailable for this slab.", response["ambiguityFlags"])
        top_candidate = response["topCandidates"][0]["candidate"]
        self.assertEqual(top_candidate["id"], "m2a_ja-232")
        self.assertNotIn("pricing", top_candidate)

    def test_card_detail_preserves_slab_cert_number(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)

        service._persist_mapped_catalog_card(
            mapped_card=map_scrydex_catalog_card(sample_scrydex_card()),
            sync_mode="raw_candidate_cache",
            trigger_source="test",
            query_text="m2a_ja-232",
            refresh_embeddings=False,
        )

        detail = service.card_detail(
            "m2a_ja-232",
            grader="PSA",
            grade="9",
            cert_number="12345678",
        )
        service.connection.close()

        assert detail is not None
        self.assertEqual(detail["slabContext"]["grader"], "PSA")
        self.assertEqual(detail["slabContext"]["grade"], "9")
        self.assertEqual(detail["slabContext"]["certNumber"], "12345678")

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
