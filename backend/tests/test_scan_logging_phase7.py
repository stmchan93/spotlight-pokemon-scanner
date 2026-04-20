from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card_price_summary, upsert_deck_entry, upsert_price_history_daily, upsert_slab_price_snapshot  # noqa: E402
from scan_artifact_store import (  # noqa: E402
    GoogleCloudScanArtifactStore,
    SCAN_ARTIFACTS_ROOT_ENV,
    SCAN_ARTIFACTS_STORAGE_ENV,
    build_scan_artifact_store,
)
from server import CandidateEncodingItem, PricingLoadPolicy, SpotlightScanService  # noqa: E402


class FakeGCSBlob:
    def __init__(self, name: str) -> None:
        self.name = name
        self.uploads: list[dict[str, object]] = []

    def upload_from_string(self, data: bytes, content_type: str | None = None) -> None:
        self.uploads.append({"data": data, "content_type": content_type})


class FakeGCSBucket:
    def __init__(self, name: str) -> None:
        self.name = name
        self.blobs: dict[str, FakeGCSBlob] = {}

    def blob(self, name: str) -> FakeGCSBlob:
        blob = self.blobs.get(name)
        if blob is None:
            blob = FakeGCSBlob(name)
            self.blobs[name] = blob
        return blob


class FakeGCSClient:
    def __init__(self) -> None:
        self.bucket_requests: list[str] = []
        self.bucket_instance: FakeGCSBucket | None = None

    def bucket(self, name: str) -> FakeGCSBucket:
        self.bucket_requests.append(name)
        if self.bucket_instance is None:
            self.bucket_instance = FakeGCSBucket(name)
        return self.bucket_instance


class ScanLoggingPhase7Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "phase7.sqlite"
        self.artifact_root = Path(self.tempdir.name) / "artifact-root"
        self.previous_artifact_root = os.environ.get(SCAN_ARTIFACTS_ROOT_ENV)
        self.previous_artifact_storage = os.environ.get(SCAN_ARTIFACTS_STORAGE_ENV)
        self.previous_artifact_uploads_enabled = os.environ.get("SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED")
        os.environ[SCAN_ARTIFACTS_ROOT_ENV] = str(self.artifact_root)
        os.environ["SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED"] = "1"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()

        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        if self.previous_artifact_root is None:
            os.environ.pop(SCAN_ARTIFACTS_ROOT_ENV, None)
        else:
            os.environ[SCAN_ARTIFACTS_ROOT_ENV] = self.previous_artifact_root
        if self.previous_artifact_storage is None:
            os.environ.pop(SCAN_ARTIFACTS_STORAGE_ENV, None)
        else:
            os.environ[SCAN_ARTIFACTS_STORAGE_ENV] = self.previous_artifact_storage
        if self.previous_artifact_uploads_enabled is None:
            os.environ.pop("SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED", None)
        else:
            os.environ["SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED"] = self.previous_artifact_uploads_enabled
        self.tempdir.cleanup()

    def _insert_card(self, card_id: str, *, name: str = "Test Card") -> None:
        self.service.connection.execute(
            """
            INSERT INTO cards (
                id, name, set_name, number, rarity, variant, language,
                source_provider, source_record_id, set_id, set_series, set_ptcgo_code,
                set_release_date, supertype, subtypes_json, types_json, artist,
                regulation_mark, national_pokedex_numbers_json, image_url, image_small_url,
                source_payload_json, created_at, updated_at
            )
            VALUES (?, ?, 'Test Set', '1/1', 'Common', 'Raw', 'English',
                    'scrydex', ?, 'tst', 'Test', NULL,
                    '2026-04-14', 'Pokémon', '[]', '[]', 'Artist',
                    NULL, '[]', NULL, NULL,
                    '{}', '2026-04-14T20:00:00Z', '2026-04-14T20:00:00Z')
            """,
            (card_id, name, card_id),
        )

    def test_log_scan_writes_scan_events_only(self) -> None:
        self._insert_card("obf-223")
        request_payload = {
            "scanID": "scan-phase7-1",
            "collectorNumber": "223/197",
            "setHintTokens": ["obf"],
            "image": {
                "jpegBase64": "abc123",
                "width": 630,
                "height": 880,
            },
        }
        response_payload = {
            "scanID": "scan-phase7-1",
            "topCandidates": [],
            "confidence": "medium",
            "ambiguityFlags": [],
            "matcherSource": "remoteHybrid",
            "matcherVersion": "phase7-test",
            "resolverMode": "raw_card",
            "resolverPath": "visual_fallback",
            "reviewDisposition": "ready",
            "reviewReason": None,
        }
        top_candidates = [
            {
                "candidate": {"id": "obf-223"},
                "retrievalScore": 0.61,
                "rerankScore": 0.74,
                "finalScore": 0.82,
                "reasons": ["title_overlap", "collector_exact"],
            }
        ]

        self.service._log_scan(request_payload, response_payload, top_candidates)  # noqa: SLF001

        row = self.service.connection.execute(
            """
            SELECT request_json, response_json, predicted_card_id, selected_card_id, confidence, review_disposition
            FROM scan_events
            WHERE scan_id = ?
            LIMIT 1
            """,
            ("scan-phase7-1",),
        ).fetchone()
        legacy_tables = {
            row["name"]
            for row in self.service.connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'scan_candidates'
                """
            ).fetchall()
        }

        self.assertIsNotNone(row)
        assert row is not None
        stored_request = json.loads(row["request_json"])
        self.assertEqual(stored_request["collectorNumber"], "223/197")
        self.assertEqual(stored_request["image"]["width"], 630)
        self.assertEqual(stored_request["image"]["height"], 880)
        self.assertNotIn("jpegBase64", stored_request["image"])
        self.assertEqual(json.loads(row["response_json"])["resolverMode"], "raw_card")
        self.assertEqual(row["predicted_card_id"], "obf-223")
        self.assertIsNone(row["selected_card_id"])
        self.assertEqual(row["confidence"], "medium")
        self.assertEqual(row["review_disposition"], "ready")
        self.assertEqual(legacy_tables, set())

        candidate_rows = self.service.connection.execute(
            """
            SELECT rank, card_id
            FROM scan_prediction_candidates
            WHERE scan_id = ?
            ORDER BY rank ASC
            """,
            ("scan-phase7-1",),
        ).fetchall()
        price_rows = self.service.connection.execute(
            """
            SELECT rank, card_id
            FROM scan_price_observations
            WHERE scan_id = ?
            ORDER BY rank ASC
            """,
            ("scan-phase7-1",),
        ).fetchall()
        self.assertEqual([(row["rank"], row["card_id"]) for row in candidate_rows], [(1, "obf-223")])
        self.assertEqual([(row["rank"], row["card_id"]) for row in price_rows], [(1, "obf-223")])

    def test_encode_top_candidates_caches_show_mode_lookup_and_exposes_hydration_timings(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_card_price_summary(
            self.service.connection,
            card_id="gym1-60",
            source="scrydex",
            currency_code="USD",
            variant="normal",
            low_price=1.0,
            market_price=2.5,
            mid_price=2.0,
            high_price=3.0,
            direct_low_price=1.5,
            trend_price=2.25,
            source_updated_at="2026-04-14T19:00:00Z",
            source_url="https://prices.example/gym1-60",
            payload={"source": "scrydex"},
        )
        items = [
            CandidateEncodingItem(
                card={"id": "gym1-60", "name": "Sabrina's Slowbro"},
                image_score=0.9,
                collector_number_score=0.8,
                name_score=0.7,
                final_score=0.95,
                reasons=("title_overlap",),
            ),
            CandidateEncodingItem(
                card={"id": "gym1-60", "name": "Sabrina's Slowbro"},
                image_score=0.8,
                collector_number_score=0.7,
                name_score=0.6,
                final_score=0.85,
                reasons=("collector_exact",),
            ),
        ]

        with patch.object(self.service, "_card_show_mode_active", wraps=self.service._card_show_mode_active) as show_mode_mock:
            encoded_candidates, scored_candidates, encode_debug = self.service._encode_top_candidates(
                items,
                pricing_context=self.service._raw_pricing_context(),
                pricing_policy=PricingLoadPolicy.top_ten_cached_only(),
                trigger_source="scan_match_raw",
            )

        self.assertEqual(show_mode_mock.call_count, 1)
        self.assertEqual(len(encoded_candidates), 2)
        self.assertEqual(len(scored_candidates), 2)
        self.assertIn("candidateHydrationMs", encode_debug)
        self.assertIn("candidateHydrationMaxMs", encode_debug)
        self.assertEqual(encode_debug["candidateHydrationCount"], 2)
        self.assertEqual(len(encode_debug["candidateTimings"]), 2)
        self.assertIn("ensureCachedMs", encode_debug["candidateTimings"][0])
        self.assertIn("pricingLookupMs", encode_debug["candidateTimings"][0])
        self.assertIn("candidatePayloadMs", encode_debug["candidateTimings"][0])

    def test_log_scrydex_match_usage_includes_cached_rerank_timing_summary(self) -> None:
        response_payload = {
            "scanID": "scan-phase7-rerank",
            "confidence": "medium",
            "resolverPath": "visual_hybrid_index",
            "matchingStage": "reranked",
            "rawDecisionDebug": {
                "visualHybrid": {
                    "phaseTimings": {
                        "buildRawEvidenceMs": 4.25,
                        "visualMatchMs": 87.5,
                        "badgeMatchMs": 12.0,
                        "rerankDecisionMs": 3.75,
                    },
                    "timings": {
                        "imageDecodeMs": 5.0,
                        "ensureRuntimeMs": 2.0,
                        "embeddingMs": 8.5,
                        "indexSearchMs": 9.0,
                        "matchPayloadMs": 24.5,
                    },
                }
            },
            "backendTimingDebug": {
                "cacheLookupMs": 1.25,
                "cacheClearMs": 0.25,
                "rerankResolveMs": 18.5,
                "rerankServiceTotalMs": 20.0,
                "candidateHydrationMs": 42.5,
                "candidateHydrationMaxMs": 21.5,
                "responseAssemblyMs": 4.0,
            },
        }

        with (
            patch("server.scrydex_request_stats_snapshot", return_value={"total": 9, "recent": []}),
            patch("builtins.print") as print_mock,
        ):
            SpotlightScanService._log_scrydex_match_usage(  # noqa: SLF001
                "scan-phase7-rerank",
                before_total=9,
                started_at=perf_counter(),
                response=response_payload,
            )

        logged_lines = "\n".join(str(call.args[0]) for call in print_mock.call_args_list)
        self.assertIn("[MATCH PERF] scan=scan-phase7-rerank stage=reranked", logged_lines)
        self.assertIn("[MATCH PERF TIMING] scan=scan-phase7-rerank stage=reranked", logged_lines)
        self.assertIn("cacheLookupMs", logged_lines)
        self.assertIn("rerankResolveMs", logged_lines)
        self.assertIn("candidateHydrationMs", logged_lines)
        self.assertIn("responseAssemblyMs", logged_lines)
        self.assertIn("backendTimings", response_payload["performance"])
        self.assertEqual(response_payload["performance"]["scrydexRequestCount"], 0)

    def test_emit_structured_log_omits_sqlite_connection_repr(self) -> None:
        with patch("builtins.print") as print_mock:
            self.service._emit_structured_log(  # noqa: SLF001
                {
                    "event": "scan_match",
                    "debug": {
                        "connection": self.service.connection,
                    },
                }
            )

        logged_payload = print_mock.call_args.args[0]
        self.assertNotIn("<sqlite3.Connection object", logged_payload)
        self.assertEqual(
            json.loads(logged_payload),
            {
                "event": "scan_match",
                "debug": {},
            },
        )

    def test_log_feedback_updates_scan_event_without_clobbering_request_response(self) -> None:
        request_payload = {
            "scanID": "scan-phase7-2",
            "collectorNumber": "60/132",
            "setHintTokens": ["gym1"],
        }
        response_payload = {
            "scanID": "scan-phase7-2",
            "topCandidates": [{"id": "gym1-60"}],
            "confidence": "low",
            "ambiguityFlags": ["Top matches are close together"],
            "matcherSource": "remoteHybrid",
            "matcherVersion": "phase7-test",
            "resolverMode": "raw_card",
            "resolverPath": "visual_fallback",
            "reviewDisposition": "needs_review",
            "reviewReason": "Scan needs review before using the price.",
        }

        self.service._log_scan(request_payload, response_payload, [])  # noqa: SLF001
        self.service.log_feedback(
            {
                "scanID": "scan-phase7-2",
                "selectedCardID": "gym1-60",
                "wasTopPrediction": False,
                "correctionType": "wrong_card",
                "submittedAt": "2026-04-09T05:30:00Z",
            }
        )

        row = self.service.connection.execute(
            """
            SELECT
                request_json,
                response_json,
                predicted_card_id,
                selected_card_id,
                selected_rank,
                was_top_prediction,
                selection_source,
                correction_type,
                completed_at
            FROM scan_events
            WHERE scan_id = ?
            LIMIT 1
            """,
            ("scan-phase7-2",),
        ).fetchone()
        legacy_tables = {
            row["name"]
            for row in self.service.connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'scan_feedback'
                """
            ).fetchall()
        }

        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(json.loads(row["request_json"])["collectorNumber"], "60/132")
        self.assertEqual(json.loads(row["response_json"])["resolverPath"], "visual_fallback")
        self.assertEqual(row["predicted_card_id"], "gym1-60")
        self.assertEqual(row["selected_card_id"], "gym1-60")
        self.assertEqual(row["selected_rank"], 1)
        self.assertEqual(row["was_top_prediction"], 0)
        self.assertEqual(row["selection_source"], "unknown")
        self.assertEqual(row["correction_type"], "wrong_card")
        self.assertEqual(row["completed_at"], "2026-04-09T05:30:00Z")
        self.assertEqual(legacy_tables, set())

    def test_unmatched_scans_still_uses_scan_events(self) -> None:
        request_payload = {
            "scanID": "scan-phase7-3",
            "collectorNumber": "130/094",
            "setHintTokens": ["pfl"],
        }
        response_payload = {
            "scanID": "scan-phase7-3",
            "topCandidates": [],
            "confidence": "low",
            "ambiguityFlags": [],
            "matcherSource": "remoteHybrid",
            "matcherVersion": "phase7-test",
            "resolverMode": "raw_card",
            "resolverPath": "visual_fallback",
            "reviewDisposition": "unsupported",
            "reviewReason": "Set/number clues do not line up with a supported Pokemon card.",
        }

        self.service._log_scan(request_payload, response_payload, [])  # noqa: SLF001

        summary = self.service.unmatched_scans(limit=10)

        self.assertEqual(summary["summary"]["openReviewCount"], 1)
        self.assertEqual(summary["summary"]["likelyUnsupportedCount"], 1)
        self.assertEqual(summary["items"][0]["scanID"], "scan-phase7-3")
        self.assertEqual(summary["items"][0]["reviewDisposition"], "unsupported")

    def test_store_scan_artifacts_persists_files_and_metadata(self) -> None:
        self.service._log_scan(  # noqa: SLF001
            {"scanID": "scan-phase7-4"},
            {
                "scanID": "scan-phase7-4",
                "topCandidates": [],
                "confidence": "low",
                "ambiguityFlags": [],
                "matcherSource": "remoteHybrid",
                "matcherVersion": "phase7-test",
                "resolverMode": "raw_card",
                "resolverPath": "visual_fallback",
                "reviewDisposition": "needs_review",
                "reviewReason": None,
            },
            [],
        )

        payload = self.service.store_scan_artifacts(
            {
                "scanID": "scan-phase7-4",
                "captureSource": "live_scan",
                "cameraZoomFactor": 1.5,
                "submittedAt": "2026-04-14T20:00:00+00:00",
                "sourceImage": {
                    "jpegBase64": base64.b64encode(b"source-image").decode("ascii"),
                    "width": 640,
                    "height": 960,
                },
                "normalizedImage": {
                    "jpegBase64": base64.b64encode(b"normalized-image").decode("ascii"),
                    "width": 630,
                    "height": 880,
                },
            }
        )

        row = self.service.connection.execute(
            """
            SELECT *
            FROM scan_artifacts
            WHERE scan_id = ?
            LIMIT 1
            """,
            ("scan-phase7-4",),
        ).fetchone()

        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(payload["storage"], "filesystem")
        self.assertEqual(row["capture_source"], "live_scan")
        self.assertEqual(row["camera_zoom_factor"], 1.5)
        self.assertEqual((self.artifact_root / row["source_object_path"]).read_bytes(), b"source-image")
        self.assertEqual((self.artifact_root / row["normalized_object_path"]).read_bytes(), b"normalized-image")

        artifact_status = self.service.scan_artifact_status()
        self.assertTrue(artifact_status["scanArtifactUploads"]["enabled"])
        self.assertEqual(artifact_status["scanArtifactUploads"]["storage"], "filesystem")
        self.assertEqual(artifact_status["scanArtifactUploads"]["filesystemRoot"], str(self.artifact_root))
        self.assertIsNone(artifact_status["scanArtifactUploads"]["activeBucketName"])
        self.assertEqual(artifact_status["storedArtifactCount"], 1)
        self.assertEqual(artifact_status["latestUploadedAt"], "2026-04-14T20:00:00+00:00")

    def test_store_scan_artifacts_skips_when_runtime_gate_disabled(self) -> None:
        self.service._log_scan(  # noqa: SLF001
            {"scanID": "scan-phase7-4-disabled"},
            {
                "scanID": "scan-phase7-4-disabled",
                "topCandidates": [],
                "confidence": "low",
                "ambiguityFlags": [],
                "matcherSource": "remoteHybrid",
                "matcherVersion": "phase7-test",
                "resolverMode": "raw_card",
                "resolverPath": "visual_fallback",
                "reviewDisposition": "needs_review",
                "reviewReason": None,
            },
            [],
        )
        self.service.set_scan_artifact_uploads_mode(enabled=False, note="debug kill switch")

        payload = self.service.store_scan_artifacts(
            {
                "scanID": "scan-phase7-4-disabled",
                "captureSource": "live_scan",
                "cameraZoomFactor": 1.5,
                "submittedAt": "2026-04-14T20:00:00+00:00",
                "sourceImage": {
                    "jpegBase64": base64.b64encode(b"source-image").decode("ascii"),
                    "width": 640,
                    "height": 960,
                },
                "normalizedImage": {
                    "jpegBase64": base64.b64encode(b"normalized-image").decode("ascii"),
                    "width": 630,
                    "height": 880,
                },
            }
        )

        row = self.service.connection.execute(
            """
            SELECT *
            FROM scan_artifacts
            WHERE scan_id = ?
            LIMIT 1
            """,
            ("scan-phase7-4-disabled",),
        ).fetchone()

        self.assertIsNone(row)
        self.assertFalse(payload["enabled"])
        self.assertTrue(payload["skipped"])
        self.assertEqual(payload["reason"], "scan artifact uploads disabled")

    def test_build_scan_artifact_store_uses_gcs_when_configured(self) -> None:
        fake_client = FakeGCSClient()

        store = build_scan_artifact_store(
            repo_root=REPO_ROOT,
            storage_override="gcs",
            gcs_bucket_override="artifact-bucket",
            gcs_client=fake_client,
        )

        self.assertIsInstance(store, GoogleCloudScanArtifactStore)
        self.assertEqual(
            store.debug_status(),
            {
                "storage": "gcs",
                "filesystemRoot": None,
                "activeBucketName": "artifact-bucket",
                "objectPrefix": None,
                "activeTarget": "gs://artifact-bucket",
            },
        )
        stored = store.store(
            scan_id="scan-phase7-gcs",
            source_bytes=b"source-image",
            normalized_bytes=b"normalized-image",
            year="2026",
            month="04",
            day="14",
        )

        self.assertEqual(fake_client.bucket_requests, ["artifact-bucket"])
        self.assertEqual(stored.source_object_path, "scans/2026/04/14/scan-phase7-gcs/source_capture.jpg")
        self.assertEqual(stored.normalized_object_path, "scans/2026/04/14/scan-phase7-gcs/normalized_target.jpg")
        self.assertEqual(
            fake_client.bucket_instance.blobs[stored.source_object_path].uploads[0],
            {"data": b"source-image", "content_type": "image/jpeg"},
        )
        self.assertEqual(
            fake_client.bucket_instance.blobs[stored.normalized_object_path].uploads[0],
            {"data": b"normalized-image", "content_type": "image/jpeg"},
        )

    def test_create_deck_entry_confirms_scan_and_dedupes_raw_entries(self) -> None:
        self.service.connection.execute(
            """
            INSERT INTO cards (
                id, name, set_name, number, rarity, variant, language,
                source_provider, source_record_id, set_id, set_series, set_ptcgo_code,
                set_release_date, supertype, subtypes_json, types_json, artist,
                regulation_mark, national_pokedex_numbers_json, image_url, image_small_url,
                source_payload_json, created_at, updated_at
            )
            VALUES (
                'gym1-60', 'Sabrina''s Slowbro', 'Gym Heroes', '60/132', 'Common', 'Raw', 'English',
                'scrydex', 'gym1-60', 'gym1', 'Gym', NULL,
                '2000-08-14', 'Pokémon', '[]', '[]', 'Ken Sugimori',
                NULL, '[]', NULL, NULL,
                '{}', '2026-04-14T20:00:00Z', '2026-04-14T20:00:00Z'
            )
            """
        )
        self.service._log_scan(  # noqa: SLF001
            {"scanID": "scan-phase7-5"},
            {
                "scanID": "scan-phase7-5",
                "topCandidates": [{"id": "gym1-60"}],
                "confidence": "medium",
                "ambiguityFlags": [],
                "matcherSource": "remoteHybrid",
                "matcherVersion": "phase7-test",
                "resolverMode": "raw_card",
                "resolverPath": "visual_fallback",
                "reviewDisposition": "ready",
                "reviewReason": None,
            },
            [{"candidate": {"id": "gym1-60"}, "finalScore": 0.9}],
        )

        first = self.service.create_deck_entry(
            {
                "cardID": "gym1-60",
                "sourceScanID": "scan-phase7-5",
                "selectionSource": "top",
                "selectedRank": 1,
                "wasTopPrediction": True,
                "addedAt": "2026-04-14T20:10:00Z",
            }
        )
        second = self.service.create_deck_entry(
            {
                "cardID": "gym1-60",
                "sourceScanID": "scan-phase7-5",
                "selectionSource": "top",
                "selectedRank": 1,
                "wasTopPrediction": True,
                "addedAt": "2026-04-14T20:11:00Z",
            }
        )

        deck_rows = self.service.connection.execute("SELECT * FROM deck_entries").fetchall()
        event_row = self.service.connection.execute(
            """
            SELECT confirmed_card_id, confirmation_source, deck_entry_id, confirmed_at
            FROM scan_events
            WHERE scan_id = ?
            LIMIT 1
            """,
            ("scan-phase7-5",),
        ).fetchone()
        confirmation_row = self.service.connection.execute(
            "SELECT * FROM scan_confirmations WHERE scan_id = ? LIMIT 1",
            ("scan-phase7-5",),
        ).fetchone()

        self.assertEqual(first["deckEntryID"], "raw|gym1-60")
        self.assertEqual(second["deckEntryID"], "raw|gym1-60")
        self.assertEqual(len(deck_rows), 1)
        self.assertEqual(deck_rows[0]["quantity"], 2)
        assert event_row is not None
        assert confirmation_row is not None
        self.assertEqual(event_row["confirmed_card_id"], "gym1-60")
        self.assertEqual(event_row["confirmation_source"], "add_top")
        self.assertEqual(event_row["deck_entry_id"], "raw|gym1-60")
        self.assertEqual(confirmation_row["deck_entry_id"], "raw|gym1-60")

    def test_deck_entries_reads_sql_backed_cards_and_summary(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        self._insert_card("base1-4", name="Charizard")
        upsert_card_price_summary(
            self.service.connection,
            card_id="gym1-60",
            source="scrydex",
            currency_code="USD",
            variant="normal",
            low_price=1.0,
            market_price=2.5,
            mid_price=2.0,
            high_price=3.0,
            direct_low_price=1.5,
            trend_price=2.25,
            source_updated_at="2026-04-14T19:00:00Z",
            source_url="https://prices.example/gym1-60",
            payload={"source": "scrydex"},
        )
        upsert_slab_price_snapshot(
            self.service.connection,
            card_id="base1-4",
            grader="PSA",
            grade="10",
            variant="Holofoil",
            pricing_tier="exact_same_grade",
            currency_code="USD",
            low_price=90.0,
            market_price=100.0,
            mid_price=95.0,
            high_price=110.0,
            last_sale_price=100.0,
            last_sale_date="2026-04-01T00:00:00Z",
            comp_count=12,
            recent_comp_count=4,
            confidence_level=4,
            confidence_label="High",
            bucket_key="test:base1-4",
            source_url="https://prices.example/base1-4",
            source="scrydex",
            summary="Exact PSA 10 slab pricing",
            payload={"source": "scrydex"},
        )
        upsert_deck_entry(
            self.service.connection,
            card_id="gym1-60",
            added_at="2026-04-14T20:00:00Z",
            updated_at="2026-04-14T20:00:00Z",
        )
        upsert_deck_entry(
            self.service.connection,
            card_id="base1-4",
            grader="PSA",
            grade="10",
            cert_number="12345",
            variant_name="Holofoil",
            added_at="2026-04-14T20:10:00Z",
            updated_at="2026-04-14T20:10:00Z",
        )
        self.service.connection.commit()

        payload = self.service.deck_entries(limit=10)

        self.assertEqual(payload["summary"]["count"], 2)
        self.assertEqual(payload["summary"]["rawCount"], 1)
        self.assertEqual(payload["summary"]["slabCount"], 1)
        self.assertAlmostEqual(payload["summary"]["totalValue"], 102.5, places=2)
        self.assertEqual(payload["limit"], 10)
        self.assertEqual(payload["offset"], 0)

        entries = payload["entries"]
        self.assertEqual(entries[0]["id"], "slab|base1-4|PSA|10|12345|Holofoil")
        self.assertEqual(entries[0]["itemKind"], "slab")
        self.assertEqual(entries[0]["quantity"], 1)
        self.assertEqual(
            entries[0]["slabContext"],
            {
                "grader": "PSA",
                "grade": "10",
                "certNumber": "12345",
                "variantName": "Holofoil",
            },
        )
        self.assertEqual(entries[0]["card"]["pricing"]["market"], 100.0)
        self.assertEqual(entries[1]["id"], "raw|gym1-60")
        self.assertEqual(entries[1]["quantity"], 1)
        self.assertIsNone(entries[1]["slabContext"])
        self.assertEqual(entries[1]["card"]["pricing"]["market"], 2.5)

    def test_record_sale_decrements_quantity_and_hides_inactive_entries(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_card_price_summary(
            self.service.connection,
            card_id="gym1-60",
            source="scrydex",
            currency_code="USD",
            variant="normal",
            low_price=1.0,
            market_price=2.5,
            mid_price=2.0,
            high_price=3.0,
            direct_low_price=1.5,
            trend_price=2.25,
            source_updated_at="2026-04-14T19:00:00Z",
            source_url="https://prices.example/gym1-60",
            payload={"source": "scrydex"},
        )
        upsert_deck_entry(
            self.service.connection,
            card_id="gym1-60",
            quantity=1,
            added_at="2026-04-14T20:00:00Z",
            updated_at="2026-04-14T20:00:00Z",
        )
        self.service.connection.commit()

        sale_payload = self.service.record_sale(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "soldAt": "2026-04-15T20:00:00Z",
                "unitPrice": 3.5,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "note": "show floor",
            }
        )

        deck_row = self.service.connection.execute(
            "SELECT quantity FROM deck_entries WHERE id = ? LIMIT 1",
            ("raw|gym1-60",),
        ).fetchone()
        sale_row = self.service.connection.execute(
            "SELECT * FROM sale_events WHERE id = ? LIMIT 1",
            (sale_payload["saleID"],),
        ).fetchone()
        event_row = self.service.connection.execute(
            "SELECT * FROM deck_entry_events WHERE sale_id = ? LIMIT 1",
            (sale_payload["saleID"],),
        ).fetchone()

        self.assertIsNotNone(deck_row)
        self.assertIsNotNone(sale_row)
        self.assertIsNotNone(event_row)
        assert deck_row is not None
        assert sale_row is not None
        assert event_row is not None
        self.assertEqual(deck_row["quantity"], 0)
        self.assertEqual(sale_row["card_id"], "gym1-60")
        self.assertEqual(sale_row["quantity"], 1)
        self.assertEqual(float(sale_row["cost_basis_total"] or 0.0), 0.0)
        self.assertEqual(event_row["event_kind"], "sale")
        self.assertEqual(event_row["quantity_delta"], -1)
        self.assertEqual(len(self.service.deck_entries(limit=10)["entries"]), 0)
        inactive_payload = self.service.deck_entries(limit=10, include_inactive=True)
        self.assertEqual(len(inactive_payload["entries"]), 1)
        self.assertEqual(inactive_payload["entries"][0]["quantity"], 0)
        self.assertEqual(inactive_payload["summary"]["count"], 1)

    def test_record_sales_batch_commits_multiple_sales_in_one_transaction(self) -> None:
        self._insert_card("base1-4", name="Charizard")
        self._insert_card("base1-2", name="Blastoise")
        upsert_deck_entry(
            self.service.connection,
            card_id="base1-4",
            quantity=1,
            added_at="2026-04-14T20:00:00Z",
            updated_at="2026-04-14T20:00:00Z",
        )
        upsert_deck_entry(
            self.service.connection,
            card_id="base1-2",
            quantity=2,
            added_at="2026-04-14T20:05:00Z",
            updated_at="2026-04-14T20:05:00Z",
        )
        self.service.connection.commit()

        batch_payload = self.service.record_sales_batch(
            {
                "sales": [
                    {
                        "cardID": "base1-4",
                        "quantity": 1,
                        "soldAt": "2026-04-15T20:00:00Z",
                        "unitPrice": 240.0,
                        "currencyCode": "USD",
                        "paymentMethod": "cash",
                    },
                    {
                        "cardID": "base1-2",
                        "quantity": 2,
                        "soldAt": "2026-04-15T20:05:00Z",
                        "unitPrice": 85.0,
                        "currencyCode": "USD",
                        "paymentMethod": "cash",
                    },
                ]
            }
        )

        self.assertEqual(len(batch_payload["results"]), 2)
        remaining_rows = self.service.connection.execute(
            "SELECT id, quantity FROM deck_entries ORDER BY id"
        ).fetchall()
        sale_rows = self.service.connection.execute(
            "SELECT card_id, quantity, unit_price FROM sale_events ORDER BY sold_at, id"
        ).fetchall()

        self.assertEqual(
            [(row["id"], row["quantity"]) for row in remaining_rows],
            [("raw|base1-2", 0), ("raw|base1-4", 0)],
        )
        self.assertEqual(
            [(row["card_id"], row["quantity"], float(row["unit_price"])) for row in sale_rows],
            [("base1-4", 1, 240.0), ("base1-2", 2, 85.0)],
        )

    def test_apply_schema_keeps_sold_entries_inactive(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_deck_entry(
            self.service.connection,
            card_id="gym1-60",
            quantity=1,
            added_at="2026-04-14T20:00:00Z",
            updated_at="2026-04-14T20:00:00Z",
        )
        self.service.connection.commit()

        self.service.record_sale(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "soldAt": "2026-04-15T20:00:00Z",
                "unitPrice": 3.5,
                "currencyCode": "USD",
            }
        )

        apply_schema(self.service.connection, BACKEND_ROOT / "schema.sql")

        deck_row = self.service.connection.execute(
            "SELECT quantity FROM deck_entries WHERE id = ? LIMIT 1",
            ("raw|gym1-60",),
        ).fetchone()
        active_payload = self.service.deck_entries(limit=10)
        inactive_payload = self.service.deck_entries(limit=10, include_inactive=True)

        self.assertIsNotNone(deck_row)
        assert deck_row is not None
        self.assertEqual(deck_row["quantity"], 0)
        self.assertEqual(len(active_payload["entries"]), 0)
        self.assertEqual(len(inactive_payload["entries"]), 1)
        self.assertEqual(inactive_payload["entries"][0]["quantity"], 0)

    def test_deck_history_aggregates_daily_collection_value_from_ledger_and_price_history(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_price_history_daily(
            self.service.connection,
            card_id="gym1-60",
            pricing_mode="raw",
            provider="scrydex",
            price_date="2026-04-14",
            currency_code="USD",
            variant="Normal",
            condition="NM",
            low_price=9.0,
            market_price=10.0,
            mid_price=10.0,
            high_price=11.0,
            source_url="https://prices.example/gym1-60/2026-04-14",
            payload={"source": "scrydex"},
        )
        upsert_price_history_daily(
            self.service.connection,
            card_id="gym1-60",
            pricing_mode="raw",
            provider="scrydex",
            price_date="2026-04-15",
            currency_code="USD",
            variant="Normal",
            condition="NM",
            low_price=11.0,
            market_price=12.0,
            mid_price=12.0,
            high_price=13.0,
            source_url="https://prices.example/gym1-60/2026-04-15",
            payload={"source": "scrydex"},
        )
        upsert_deck_entry(
            self.service.connection,
            card_id="gym1-60",
            quantity=1,
            condition="near_mint",
            unit_price=8.0,
            currency_code="USD",
            event_kind="buy",
            added_at="2026-04-14T09:00:00Z",
            updated_at="2026-04-14T09:00:00Z",
        )
        self.service.connection.commit()

        self.service.record_sale(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "soldAt": "2026-04-15T10:00:00Z",
                "unitPrice": 11.0,
                "currencyCode": "USD",
            }
        )

        history = self.service.deck_history(days=2, range_label="ALL")

        points_by_date = {point["date"]: point for point in history["points"]}
        self.assertIn("2026-04-14", points_by_date)
        self.assertIn("2026-04-15", points_by_date)
        self.assertAlmostEqual(points_by_date["2026-04-14"]["totalValue"], 10.0, places=2)
        self.assertAlmostEqual(points_by_date["2026-04-15"]["totalValue"], 0.0, places=2)
        self.assertAlmostEqual(points_by_date["2026-04-14"]["costBasisValue"], 8.0, places=2)
        self.assertAlmostEqual(points_by_date["2026-04-15"]["costBasisValue"], 0.0, places=2)
        self.assertEqual(points_by_date["2026-04-14"]["pricedCardCount"], 1)
        self.assertEqual(points_by_date["2026-04-15"]["pricedCardCount"], 0)
        self.assertEqual(history["coverage"]["pricedCardCount"], 0)
        self.assertEqual(history["coverage"]["excludedCardCount"], 0)
        self.assertEqual(history["summary"]["currentValue"], 0.0)
        self.assertEqual(history["summary"]["startValue"], 10.0)
        self.assertEqual(history["summary"]["deltaValue"], -10.0)
        self.assertEqual(history["summary"]["currentCostBasisValue"], 0.0)
        self.assertEqual(history["summary"]["startCostBasisValue"], 8.0)

    def test_record_buy_and_portfolio_ledger_return_real_summary(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_card_price_summary(
            self.service.connection,
            card_id="gym1-60",
            source="scrydex",
            currency_code="USD",
            variant="normal",
            low_price=1.0,
            market_price=12.5,
            mid_price=12.0,
            high_price=13.0,
            direct_low_price=1.5,
            trend_price=12.25,
            source_updated_at="2026-04-14T19:00:00Z",
            source_url="https://prices.example/gym1-60",
            payload={"source": "scrydex"},
        )

        buy_payload = self.service.record_buy(
            {
                "cardID": "gym1-60",
                "quantity": 2,
                "unitPrice": 6.0,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "boughtAt": "2026-04-14T09:00:00Z",
                "condition": "near_mint",
            }
        )
        sale_payload = self.service.record_sale(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "soldAt": "2026-04-15T20:00:00Z",
                "unitPrice": 10.0,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "note": "binder deal",
            }
        )

        ledger = self.service.portfolio_ledger(days=7)

        self.assertEqual(buy_payload["quantityAdded"], 2)
        self.assertEqual(sale_payload["remainingQuantity"], 1)
        self.assertEqual(ledger["summary"]["revenue"], 10.0)
        self.assertEqual(ledger["summary"]["spend"], 12.0)
        self.assertEqual(ledger["summary"]["grossProfit"], 4.0)
        self.assertEqual(ledger["summary"]["inventoryCount"], 1)
        self.assertEqual(len(ledger["transactions"]), 2)
        self.assertEqual([entry["kind"] for entry in ledger["transactions"]], ["sell", "buy"])

    def test_update_portfolio_buy_price_updates_transaction_and_remaining_cost_basis(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")

        buy_payload = self.service.record_buy(
            {
                "cardID": "gym1-60",
                "quantity": 2,
                "unitPrice": 6.0,
                "currencyCode": "USD",
                "boughtAt": "2026-04-14T09:00:00Z",
                "condition": "near_mint",
            }
        )
        self.assertEqual(buy_payload["quantityAdded"], 2)

        buy_row = self.service.connection.execute(
            """
            SELECT id
            FROM deck_entry_events
            WHERE deck_entry_id = ?
              AND event_kind = 'buy'
            LIMIT 1
            """,
            ("raw|gym1-60",),
        ).fetchone()
        assert buy_row is not None

        update_payload = self.service.update_portfolio_buy_price(
            str(buy_row["id"]),
            {
                "unitPrice": 8.0,
                "currencyCode": "USD",
                "updatedAt": "2026-04-16T12:00:00Z",
            },
        )

        updated_buy_row = self.service.connection.execute(
            "SELECT unit_price, total_price, currency_code FROM deck_entry_events WHERE id = ? LIMIT 1",
            (str(buy_row["id"]),),
        ).fetchone()
        deck_row = self.service.connection.execute(
            "SELECT cost_basis_total, cost_basis_currency_code FROM deck_entries WHERE id = ? LIMIT 1",
            ("raw|gym1-60",),
        ).fetchone()
        ledger = self.service.portfolio_ledger(days=7)

        assert updated_buy_row is not None
        assert deck_row is not None
        self.assertAlmostEqual(float(updated_buy_row["unit_price"] or 0.0), 8.0, places=2)
        self.assertAlmostEqual(float(updated_buy_row["total_price"] or 0.0), 16.0, places=2)
        self.assertAlmostEqual(float(deck_row["cost_basis_total"] or 0.0), 16.0, places=2)
        self.assertEqual(deck_row["cost_basis_currency_code"], "USD")
        self.assertAlmostEqual(update_payload["costBasisTotal"], 16.0, places=2)
        self.assertAlmostEqual(ledger["summary"]["spend"], 16.0, places=2)
        self.assertAlmostEqual(ledger["transactions"][0]["unitPrice"], 8.0, places=2)

    def test_update_portfolio_sale_price_updates_transaction_and_ledger_summary(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")

        self.service.record_buy(
            {
                "cardID": "gym1-60",
                "quantity": 2,
                "unitPrice": 6.0,
                "currencyCode": "USD",
                "boughtAt": "2026-04-14T09:00:00Z",
                "condition": "near_mint",
            }
        )
        sale_payload = self.service.record_sale(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "soldAt": "2026-04-15T20:00:00Z",
                "unitPrice": 10.0,
                "currencyCode": "USD",
            }
        )

        update_payload = self.service.update_portfolio_sale_price(
            str(sale_payload["saleID"]),
            {
                "unitPrice": 12.5,
                "currencyCode": "USD",
                "updatedAt": "2026-04-16T12:00:00Z",
            },
        )

        sale_row = self.service.connection.execute(
            "SELECT unit_price, total_price, currency_code FROM sale_events WHERE id = ? LIMIT 1",
            (str(sale_payload["saleID"]),),
        ).fetchone()
        event_row = self.service.connection.execute(
            "SELECT unit_price, total_price, currency_code FROM deck_entry_events WHERE sale_id = ? LIMIT 1",
            (str(sale_payload["saleID"]),),
        ).fetchone()
        ledger = self.service.portfolio_ledger(days=7)

        assert sale_row is not None
        assert event_row is not None
        self.assertAlmostEqual(float(sale_row["unit_price"] or 0.0), 12.5, places=2)
        self.assertAlmostEqual(float(sale_row["total_price"] or 0.0), 12.5, places=2)
        self.assertAlmostEqual(float(event_row["unit_price"] or 0.0), 12.5, places=2)
        self.assertAlmostEqual(float(event_row["total_price"] or 0.0), 12.5, places=2)
        self.assertAlmostEqual(update_payload["totalPrice"], 12.5, places=2)
        self.assertAlmostEqual(ledger["summary"]["revenue"], 12.5, places=2)
        self.assertAlmostEqual(ledger["summary"]["grossProfit"], 6.5, places=2)
        self.assertAlmostEqual(ledger["transactions"][0]["unitPrice"], 12.5, places=2)

    def test_update_portfolio_sale_price_accepts_linked_sale_event_row_id(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")

        self.service.record_buy(
            {
                "cardID": "gym1-60",
                "quantity": 2,
                "unitPrice": 6.0,
                "currencyCode": "USD",
                "boughtAt": "2026-04-14T09:00:00Z",
                "condition": "near_mint",
            }
        )
        sale_payload = self.service.record_sale(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "soldAt": "2026-04-15T20:00:00Z",
                "unitPrice": 10.0,
                "currencyCode": "USD",
            }
        )
        event_row = self.service.connection.execute(
            """
            SELECT id, sale_id
            FROM deck_entry_events
            WHERE sale_id = ?
              AND event_kind = 'sale'
            LIMIT 1
            """,
            (str(sale_payload["saleID"]),),
        ).fetchone()

        assert event_row is not None

        update_payload = self.service.update_portfolio_sale_price(
            str(event_row["id"]),
            {
                "unitPrice": 13.25,
                "currencyCode": "USD",
                "updatedAt": "2026-04-16T12:00:00Z",
            },
        )

        sale_row = self.service.connection.execute(
            "SELECT unit_price, total_price FROM sale_events WHERE id = ? LIMIT 1",
            (str(sale_payload["saleID"]),),
        ).fetchone()
        linked_event_row = self.service.connection.execute(
            "SELECT unit_price, total_price FROM deck_entry_events WHERE id = ? LIMIT 1",
            (str(event_row["id"]),),
        ).fetchone()

        assert sale_row is not None
        assert linked_event_row is not None
        self.assertEqual(update_payload["transactionID"], str(sale_payload["saleID"]))
        self.assertAlmostEqual(float(sale_row["unit_price"] or 0.0), 13.25, places=2)
        self.assertAlmostEqual(float(sale_row["total_price"] or 0.0), 13.25, places=2)
        self.assertAlmostEqual(float(linked_event_row["unit_price"] or 0.0), 13.25, places=2)
        self.assertAlmostEqual(float(linked_event_row["total_price"] or 0.0), 13.25, places=2)

    def test_portfolio_ledger_daily_series_buckets_by_timezone(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_card_price_summary(
            self.service.connection,
            card_id="gym1-60",
            source="scrydex",
            currency_code="USD",
            variant="normal",
            low_price=1.0,
            market_price=12.5,
            mid_price=12.0,
            high_price=13.0,
            direct_low_price=1.5,
            trend_price=12.25,
            source_updated_at="2026-04-14T19:00:00Z",
            source_url="https://prices.example/gym1-60",
            payload={"source": "scrydex"},
        )

        self.service.record_buy(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "unitPrice": 12.0,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "boughtAt": "2026-04-15T06:30:00Z",
                "condition": "near_mint",
            }
        )
        self.service.record_sale(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "soldAt": "2026-04-15T08:30:00Z",
                "unitPrice": 18.0,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "note": "tz bucket check",
            }
        )

        ledger = self.service.portfolio_ledger(days=2, range_label="ALL", time_zone_name="America/Los_Angeles")
        daily_by_date = {point["date"]: point for point in ledger["dailySeries"]}

        self.assertIn("2026-04-14", daily_by_date)
        self.assertIn("2026-04-15", daily_by_date)
        self.assertAlmostEqual(daily_by_date["2026-04-14"]["spend"], 12.0, places=2)
        self.assertAlmostEqual(daily_by_date["2026-04-14"]["revenue"], 0.0, places=2)
        self.assertEqual(daily_by_date["2026-04-14"]["buyCount"], 1)
        self.assertEqual(daily_by_date["2026-04-14"]["sellCount"], 0)
        self.assertAlmostEqual(daily_by_date["2026-04-15"]["revenue"], 18.0, places=2)
        self.assertAlmostEqual(daily_by_date["2026-04-15"]["spend"], 0.0, places=2)
        self.assertAlmostEqual(daily_by_date["2026-04-15"]["realizedProfit"], 6.0, places=2)
        self.assertEqual(daily_by_date["2026-04-15"]["buyCount"], 0)
        self.assertEqual(daily_by_date["2026-04-15"]["sellCount"], 1)

    def test_portfolio_ledger_range_labels_override_day_window_size(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        self.service.record_buy(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "unitPrice": 12.0,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "boughtAt": "2026-04-15T06:30:00Z",
                "condition": "near_mint",
            }
        )

        ledger_7d = self.service.portfolio_ledger(days=365, range_label="7D", time_zone_name="UTC")
        ledger_30d = self.service.portfolio_ledger(days=365, range_label="30D", time_zone_name="UTC")
        ledger_90d = self.service.portfolio_ledger(days=365, range_label="90D", time_zone_name="UTC")
        ledger_all = self.service.portfolio_ledger(days=365, range_label="ALL", time_zone_name="UTC")

        self.assertEqual(len(ledger_7d["dailySeries"]), 7)
        self.assertEqual(len(ledger_30d["dailySeries"]), 30)
        self.assertEqual(len(ledger_90d["dailySeries"]), 90)
        self.assertGreaterEqual(len(ledger_all["dailySeries"]), 1)
        self.assertEqual(ledger_all["dailySeries"][0]["date"], "2026-04-15")
        self.assertAlmostEqual(ledger_all["dailySeries"][0]["spend"], 12.0, places=2)
        self.assertEqual(ledger_all["dailySeries"][0]["buyCount"], 1)

    def test_deck_history_buckets_by_timezone(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_price_history_daily(
            self.service.connection,
            card_id="gym1-60",
            pricing_mode="raw",
            provider="scrydex",
            price_date="2026-04-14",
            currency_code="USD",
            variant="Normal",
            condition="NM",
            low_price=9.0,
            market_price=10.0,
            mid_price=10.0,
            high_price=11.0,
            source_url="https://prices.example/gym1-60/2026-04-14",
            payload={"source": "scrydex"},
        )
        upsert_price_history_daily(
            self.service.connection,
            card_id="gym1-60",
            pricing_mode="raw",
            provider="scrydex",
            price_date="2026-04-15",
            currency_code="USD",
            variant="Normal",
            condition="NM",
            low_price=11.0,
            market_price=12.0,
            mid_price=12.0,
            high_price=13.0,
            source_url="https://prices.example/gym1-60/2026-04-15",
            payload={"source": "scrydex"},
        )
        upsert_deck_entry(
            self.service.connection,
            card_id="gym1-60",
            quantity=1,
            condition="near_mint",
            unit_price=8.0,
            currency_code="USD",
            event_kind="buy",
            added_at="2026-04-15T06:30:00Z",
            updated_at="2026-04-15T06:30:00Z",
        )
        self.service.connection.commit()

        self.service.record_sale(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "soldAt": "2026-04-15T08:30:00Z",
                "unitPrice": 18.0,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "note": "tz bucket check",
            }
        )

        history = self.service.deck_history(days=2, range_label="ALL", time_zone_name="America/Los_Angeles")
        points_by_date = {point["date"]: point for point in history["points"]}

        self.assertIn("2026-04-14", points_by_date)
        self.assertIn("2026-04-15", points_by_date)
        self.assertAlmostEqual(points_by_date["2026-04-14"]["totalValue"], 10.0, places=2)
        self.assertAlmostEqual(points_by_date["2026-04-15"]["totalValue"], 0.0, places=2)
        self.assertEqual(points_by_date["2026-04-14"]["pricedCardCount"], 1)
        self.assertEqual(points_by_date["2026-04-15"]["pricedCardCount"], 0)

    def test_deck_entries_total_value_respects_quantity(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_card_price_summary(
            self.service.connection,
            card_id="gym1-60",
            source="scrydex",
            currency_code="USD",
            variant="normal",
            low_price=1.0,
            market_price=2.5,
            mid_price=2.0,
            high_price=3.0,
            direct_low_price=1.5,
            trend_price=2.25,
            source_updated_at="2026-04-14T19:00:00Z",
            source_url="https://prices.example/gym1-60",
            payload={"source": "scrydex"},
        )
        upsert_deck_entry(
            self.service.connection,
            card_id="gym1-60",
            quantity=3,
            added_at="2026-04-14T20:00:00Z",
            updated_at="2026-04-14T20:00:00Z",
        )
        self.service.connection.commit()

        payload = self.service.deck_entries(limit=10)

        self.assertEqual(payload["entries"][0]["quantity"], 3)
        self.assertAlmostEqual(payload["summary"]["totalValue"], 7.5, places=2)

    def test_deck_entries_convert_raw_jpy_pricing_to_usd(self) -> None:
        self._insert_card("m2a_ja-232", name="Mega Dragonite ex")
        upsert_card_price_summary(
            self.service.connection,
            card_id="m2a_ja-232",
            source="scrydex",
            currency_code="JPY",
            variant="Holofoil",
            low_price=2400.0,
            market_price=2550.0,
            mid_price=2500.0,
            high_price=2600.0,
            direct_low_price=None,
            trend_price=2550.0,
            source_updated_at="2026-04-14T19:00:00Z",
            source_url="https://api.scrydex.com/pokemon/v1/cards/m2a_ja-232?include=prices",
            payload={"source": "scrydex"},
        )
        upsert_deck_entry(
            self.service.connection,
            card_id="m2a_ja-232",
            quantity=2,
            added_at="2026-04-14T20:00:00Z",
            updated_at="2026-04-14T20:00:00Z",
        )
        self.service.connection.commit()

        with patch("fx_rates.ensure_fx_rate_snapshot", return_value={
            "baseCurrency": "JPY",
            "quoteCurrency": "USD",
            "rate": 0.0063,
            "source": "ecb",
            "effectiveAt": "2026-04-14",
            "refreshedAt": "2026-04-14T20:05:00Z",
            "isFresh": True,
        }):
            payload = self.service.deck_entries(limit=10)

        pricing = payload["entries"][0]["card"]["pricing"]
        self.assertEqual(pricing["currencyCode"], "USD")
        self.assertEqual(pricing["nativeCurrencyCode"], "JPY")
        self.assertAlmostEqual(pricing["market"], 16.07, places=2)
        self.assertAlmostEqual(payload["summary"]["totalValue"], 32.14, places=2)

    def test_create_and_update_deck_entry_condition_round_trip(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")

        create_payload = self.service.create_deck_entry(
            {
                "cardID": "gym1-60",
                "condition": "near_mint",
                "selectionSource": "top",
                "wasTopPrediction": True,
                "addedAt": "2026-04-14T20:00:00Z",
            }
        )

        self.assertEqual(create_payload["condition"], "near_mint")

        update_payload = self.service.update_deck_entry_condition(
            {
                "cardID": "gym1-60",
                "condition": "lightly_played",
                "updatedAt": "2026-04-14T20:05:00Z",
            }
        )

        self.assertEqual(update_payload["condition"], "lightly_played")

        deck_payload = self.service.deck_entries(limit=10)
        self.assertEqual(deck_payload["entries"][0]["condition"], "lightly_played")


if __name__ == "__main__":
    unittest.main()
