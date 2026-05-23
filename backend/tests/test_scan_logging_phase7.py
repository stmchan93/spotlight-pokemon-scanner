from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card_price_summary, upsert_deck_entry, upsert_price_history_daily, upsert_price_snapshot, upsert_scan_event, upsert_slab_price_snapshot  # noqa: E402
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

    def _freeze_runtime_now(self, iso_timestamp: str):
        fixed_now = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))

        class FrozenDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                if tz is None:
                    return cls(
                        fixed_now.year,
                        fixed_now.month,
                        fixed_now.day,
                        fixed_now.hour,
                        fixed_now.minute,
                        fixed_now.second,
                        fixed_now.microsecond,
                    )
                return fixed_now.astimezone(tz)

        return patch("server.datetime", FrozenDateTime)

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

        with (
            patch.object(self.service, "_card_show_mode_active", wraps=self.service._card_show_mode_active) as show_mode_mock,
            patch.object(
                self.service,
                "_batched_card_hydration_context",
                wraps=self.service._batched_card_hydration_context,
            ) as hydration_context_mock,
        ):
            encoded_candidates, scored_candidates, encode_debug = self.service._encode_top_candidates(
                items,
                pricing_context=self.service._raw_pricing_context(),
                pricing_policy=PricingLoadPolicy.top_ten_cached_only(),
                trigger_source="scan_match_raw",
            )

        self.assertEqual(show_mode_mock.call_count, 1)
        self.assertEqual(hydration_context_mock.call_count, 1)
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

    def test_visual_matcher_timing_fields_extracts_sub_phases(self) -> None:
        debug = {
            "queryVariantCount": 3,
            "timings": {
                "imageDecodeMs": 12.345,
                "ensureRuntimeMs": 0.5,
                "encoderPreprocessMs": 8.1,
                "encoderForwardMs": 187.2,
                "encoderPostprocessMs": 3.4,
                "adapterProjectMs": 1.1,
                "embeddingNormalizeMs": 0.2,
                "indexSearchMs": 14.0,
                "userPhotoRerankMs": 6.7,
                "embeddingMs": 200.0,
                "matchPayloadMs": 220.0,  # not in the surfaced subset
            },
        }
        fields = SpotlightScanService._visual_matcher_timing_fields(debug)  # noqa: SLF001
        # Sub-phase timings should be present.
        self.assertEqual(fields["imageDecodeMs"], 12.345)
        self.assertEqual(fields["encoderForwardMs"], 187.2)
        self.assertEqual(fields["indexSearchMs"], 14.0)
        self.assertEqual(fields["queryVariantCount"], 3)
        # `matchPayloadMs` is intentionally not surfaced; it's the matcher's outer
        # timer and duplicates `visualMatchMs` already at the top level.
        self.assertNotIn("matchPayloadMs", fields)

    def test_visual_matcher_timing_fields_handles_missing_or_invalid_input(self) -> None:
        self.assertEqual(SpotlightScanService._visual_matcher_timing_fields(None), {})  # noqa: SLF001
        self.assertEqual(SpotlightScanService._visual_matcher_timing_fields({}), {})  # noqa: SLF001
        self.assertEqual(
            SpotlightScanService._visual_matcher_timing_fields({"timings": "not-a-dict"}),  # noqa: SLF001
            {},
        )
        # Non-numeric values get dropped silently.
        fields = SpotlightScanService._visual_matcher_timing_fields({  # noqa: SLF001
            "timings": {"imageDecodeMs": "bad", "encoderForwardMs": 5.0},
        })
        self.assertEqual(fields, {"encoderForwardMs": 5.0})

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

    def test_store_scan_artifacts_succeeds_when_match_only_wrote_in_progress_stub(self) -> None:
        # Regression test for the race introduced by c3300a8: the mobile
        # client fires /scan/match and /scan-artifacts in parallel using the
        # same client-generated scanID. Before the match_scan() handler was
        # taught to upsert an in_progress stub row up-front, the artifact
        # upload would consistently arrive at the backend before _log_scan()
        # finished (slab matches take 40-50s on staging), fail its
        # scan_events existence check, and the JPEG would never reach GCS.
        # This test reproduces that race by:
        #   1) simulating match_scan()'s early stub upsert
        #   2) calling store_scan_artifacts BEFORE _log_scan
        #   3) asserting the upload succeeded and persisted to the FS
        #   4) calling _log_scan to simulate the match finishing
        #   5) asserting _log_scan replaces the stub fields with real data
        scan_id = "scan-race-fix-1"
        owner_user_id = self.service._current_owner_user_id()  # noqa: SLF001

        # Step 1: match_scan()'s early stub insert.
        upsert_scan_event(
            self.service.connection,
            scan_id=scan_id,
            owner_user_id=owner_user_id,
            request_payload={"scanID": scan_id, "stub": True},
            response_payload={},
            matcher_source="in_progress",
            matcher_version="in_progress",
            created_at="2026-05-23T20:00:00+00:00",
        )
        self.service.connection.commit()

        # Step 2: artifact upload arrives BEFORE the match completes.
        payload = self.service.store_scan_artifacts(
            {
                "scanID": scan_id,
                "captureSource": "live_scan",
                "cameraZoomFactor": 1.0,
                "submittedAt": "2026-05-23T20:00:00.500+00:00",
                "sourceImage": {
                    "jpegBase64": base64.b64encode(b"race-source").decode("ascii"),
                    "width": 1080,
                    "height": 1620,
                },
                "normalizedImage": {
                    "jpegBase64": base64.b64encode(b"race-normalized").decode("ascii"),
                    "width": 630,
                    "height": 880,
                },
            }
        )

        # Step 3: upload landed despite the stub row only having placeholder
        # matcher fields. JPEGs are on disk, scan_artifacts row is keyed to
        # the same scanID, FK to scan_events.scan_id is satisfied.
        self.assertTrue(payload["enabled"])
        artifact_row = self.service.connection.execute(
            "SELECT * FROM scan_artifacts WHERE scan_id = ? LIMIT 1",
            (scan_id,),
        ).fetchone()
        self.assertIsNotNone(artifact_row)
        assert artifact_row is not None
        self.assertEqual(
            (self.artifact_root / artifact_row["source_object_path"]).read_bytes(),
            b"race-source",
        )
        self.assertEqual(
            (self.artifact_root / artifact_row["normalized_object_path"]).read_bytes(),
            b"race-normalized",
        )

        # Step 4: match finishes ~40s later — _log_scan upserts the real
        # request/response/matcher fields onto the same scan_id (ON CONFLICT
        # DO UPDATE), replacing the placeholder.
        self.service._log_scan(  # noqa: SLF001
            {"scanID": scan_id, "collectorNumber": "001/100"},
            {
                "scanID": scan_id,
                "topCandidates": [{"id": "sv1-1", "name": "Sample"}],
                "confidence": "medium",
                "ambiguityFlags": [],
                "matcherSource": "remoteHybrid",
                "matcherVersion": "phase7-test",
                "resolverMode": "raw_card",
                "resolverPath": "visual_hybrid",
                "reviewDisposition": "needs_review",
                "reviewReason": None,
            },
            [],
        )

        # Step 5: stub fields were replaced; the artifact row is untouched
        # and still pointed at the right blobs.
        final_event = self.service.connection.execute(
            "SELECT matcher_source, matcher_version, response_json FROM scan_events WHERE scan_id = ? LIMIT 1",
            (scan_id,),
        ).fetchone()
        self.assertIsNotNone(final_event)
        assert final_event is not None
        self.assertEqual(final_event["matcher_source"], "remoteHybrid")
        self.assertEqual(final_event["matcher_version"], "phase7-test")
        self.assertIn("sv1-1", final_event["response_json"])

        # And unmatched_scans should NOT have surfaced this scan during the
        # in_progress window (it now has real matcher data, but more
        # importantly the filter would have excluded it earlier anyway).
        post_match_summary = self.service.unmatched_scans(limit=10)
        post_match_scan_ids = {item["scanID"] for item in post_match_summary["items"]}
        self.assertIn(scan_id, post_match_scan_ids)  # selected_card_id is NULL → still "open review"

    def test_unmatched_scans_excludes_in_progress_stub_rows(self) -> None:
        # The match handler upserts a stub row with matcher_source='in_progress'
        # at the start of /scan/match so the artifact upload race can land.
        # That row must NOT appear on the /api/v1/ops/unmatched-scans dashboard
        # — it's not "an unmatched scan that needs review", it's an
        # in-flight match. (Stale rows that stay 'in_progress' are a separate
        # ops signal, not a review queue item.)
        upsert_scan_event(
            self.service.connection,
            scan_id="scan-stub-only",
            owner_user_id=self.service._current_owner_user_id(),  # noqa: SLF001
            request_payload={"scanID": "scan-stub-only", "stub": True},
            response_payload={},
            matcher_source="in_progress",
            matcher_version="in_progress",
            created_at="2026-05-23T20:00:00+00:00",
        )
        self.service.connection.commit()

        summary = self.service.unmatched_scans(limit=25)
        scan_ids = {item["scanID"] for item in summary["items"]}
        self.assertNotIn("scan-stub-only", scan_ids)

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

    def _seed_scan_event_for_artifacts_json(
        self,
        *,
        scan_id: str,
        card_id: str = "obf-223",
        mode: str = "raw_card",
        matcher_version: str = "phase7-test",
        slab_context: dict[str, str] | None = None,
    ) -> None:
        self._insert_card(card_id)
        response_payload = {
            "scanID": scan_id,
            "topCandidates": [],
            "confidence": "medium",
            "ambiguityFlags": [],
            "matcherSource": "remoteHybrid",
            "matcherVersion": matcher_version,
            "resolverMode": mode,
            "resolverPath": "visual_fallback",
            "reviewDisposition": "ready",
            "reviewReason": None,
        }
        if slab_context is not None:
            response_payload["slabContext"] = slab_context
        self.service._log_scan(  # noqa: SLF001
            {"scanID": scan_id},
            response_payload,
            [
                {
                    "candidate": {"id": card_id},
                    "finalScore": 0.91,
                    "retrievalScore": 0.8,
                    "rerankScore": 0.85,
                }
            ],
        )

    def _scan_artifacts_payload(
        self,
        *,
        scan_id: str,
        submitted_at: str = "2026-04-14T20:00:00+00:00",
        capture_source: str = "live_scan",
        camera_zoom_factor: float = 1.5,
    ) -> dict[str, object]:
        return {
            "scanID": scan_id,
            "captureSource": capture_source,
            "cameraZoomFactor": camera_zoom_factor,
            "submittedAt": submitted_at,
            "device": {"model": "iPhone15,3", "osVersion": "iOS 18.1"},
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

    def test_scan_artifacts_json_written_alongside_jpegs_with_expected_schema(self) -> None:
        scan_id = "scan-artifacts-json-1"
        self._seed_scan_event_for_artifacts_json(scan_id=scan_id)

        response = self.service.store_scan_artifacts(
            self._scan_artifacts_payload(scan_id=scan_id),
        )

        self.assertEqual(
            response["artifactsJsonObjectPath"],
            f"scans/2026/04/14/{scan_id}/artifacts.json",
        )
        artifacts_path = self.artifact_root / response["artifactsJsonObjectPath"]
        self.assertTrue(artifacts_path.exists())
        document = json.loads(artifacts_path.read_text(encoding="utf-8"))

        self.assertEqual(document["version"], 1)
        self.assertEqual(document["scan_id"], scan_id)
        self.assertEqual(document["created_at"], "2026-04-14T20:00:00+00:00")
        self.assertEqual(document["mode"], "raw_card")
        self.assertEqual(document["predicted_card_id"], "obf-223")
        self.assertIsNone(document["selected_card_id"])
        self.assertEqual(document["matcher_version"], "phase7-test")
        self.assertIsNone(document["slab"])
        self.assertEqual(
            document["source_capture_uri"],
            f"scans/2026/04/14/{scan_id}/source_capture.jpg",
        )
        self.assertEqual(
            document["normalized_target_uri"],
            f"scans/2026/04/14/{scan_id}/normalized_target.jpg",
        )
        self.assertIsNone(document["confirmed_card_id"])
        self.assertIsNone(document["confirmed_at"])
        self.assertEqual(len(document["top_candidates"]), 1)
        self.assertEqual(
            document["top_candidates"][0],
            {"rank": 1, "card_id": "obf-223", "score": 0.91},
        )
        capture = document["capture"]
        self.assertEqual(capture["source_width"], 640)
        self.assertEqual(capture["source_height"], 960)
        self.assertEqual(capture["normalized_width"], 630)
        self.assertEqual(capture["normalized_height"], 880)
        self.assertEqual(capture["camera_zoom_factor"], 1.5)
        self.assertEqual(capture["capture_source"], "live_scan")
        self.assertEqual(capture["device"], {"model": "iPhone15,3", "osVersion": "iOS 18.1"})

    def test_create_deck_entry_updates_artifacts_json_confirm_fields(self) -> None:
        scan_id = "scan-artifacts-json-2"
        self._seed_scan_event_for_artifacts_json(scan_id=scan_id, card_id="gym1-60")
        self.service.store_scan_artifacts(self._scan_artifacts_payload(scan_id=scan_id))

        artifacts_path = self.artifact_root / "scans" / "2026" / "04" / "14" / scan_id / "artifacts.json"
        initial_document = json.loads(artifacts_path.read_text(encoding="utf-8"))
        self.assertIsNone(initial_document["confirmed_card_id"])
        self.assertIsNone(initial_document["confirmed_at"])

        self.service.create_deck_entry(
            {
                "cardID": "gym1-60",
                "sourceScanID": scan_id,
                "selectionSource": "top",
                "selectedRank": 1,
                "wasTopPrediction": True,
                "addedAt": "2026-04-14T20:10:00Z",
            }
        )

        updated_document = json.loads(artifacts_path.read_text(encoding="utf-8"))
        self.assertEqual(updated_document["confirmed_card_id"], "gym1-60")
        self.assertEqual(updated_document["confirmed_at"], "2026-04-14T20:10:00Z")
        # Preserve all the existing fields
        self.assertEqual(updated_document["version"], 1)
        self.assertEqual(updated_document["scan_id"], scan_id)
        self.assertEqual(updated_document["predicted_card_id"], "gym1-60")
        self.assertEqual(updated_document["matcher_version"], "phase7-test")
        self.assertEqual(
            updated_document["source_capture_uri"],
            f"scans/2026/04/14/{scan_id}/source_capture.jpg",
        )

    def test_create_deck_entry_succeeds_when_artifacts_json_missing(self) -> None:
        # No store_scan_artifacts call before this — artifacts.json should be absent.
        scan_id = "scan-artifacts-json-3"
        self._seed_scan_event_for_artifacts_json(scan_id=scan_id, card_id="gym1-60")

        payload = self.service.create_deck_entry(
            {
                "cardID": "gym1-60",
                "sourceScanID": scan_id,
                "selectionSource": "top",
                "selectedRank": 1,
                "wasTopPrediction": True,
                "addedAt": "2026-04-14T20:11:00Z",
            }
        )

        self.assertEqual(payload["cardID"], "gym1-60")
        # SQLite confirm still happened
        event_row = self.service.connection.execute(
            "SELECT confirmed_card_id, confirmed_at FROM scan_events WHERE scan_id = ? LIMIT 1",
            (scan_id,),
        ).fetchone()
        assert event_row is not None
        self.assertEqual(event_row["confirmed_card_id"], "gym1-60")
        self.assertEqual(event_row["confirmed_at"], "2026-04-14T20:11:00Z")

    def test_store_scan_artifacts_returns_when_artifacts_json_write_fails(self) -> None:
        scan_id = "scan-artifacts-json-4"
        self._seed_scan_event_for_artifacts_json(scan_id=scan_id)

        original_write = self.service.artifact_store.write_artifacts_json

        def _boom(**_kwargs):
            raise RuntimeError("simulated gcs failure")

        self.service.artifact_store.write_artifacts_json = _boom  # type: ignore[assignment]
        try:
            response = self.service.store_scan_artifacts(self._scan_artifacts_payload(scan_id=scan_id))
        finally:
            self.service.artifact_store.write_artifacts_json = original_write  # type: ignore[assignment]

        # SQLite writes happened — scan_artifacts row exists and the JPEG paths were returned.
        self.assertEqual(response["enabled"], True)
        self.assertIsNone(response["artifactsJsonObjectPath"])
        artifact_row = self.service.connection.execute(
            "SELECT source_object_path, normalized_object_path FROM scan_artifacts WHERE scan_id = ? LIMIT 1",
            (scan_id,),
        ).fetchone()
        assert artifact_row is not None
        self.assertEqual(
            artifact_row["source_object_path"],
            f"scans/2026/04/14/{scan_id}/source_capture.jpg",
        )

        # Now also assert confirm-time failure does not break create_deck_entry.
        self.service.artifact_store.write_artifacts_json = _boom  # type: ignore[assignment]
        try:
            deck_payload = self.service.create_deck_entry(
                {
                    "cardID": "obf-223",
                    "sourceScanID": scan_id,
                    "selectionSource": "top",
                    "selectedRank": 1,
                    "wasTopPrediction": True,
                    "addedAt": "2026-04-14T20:12:00Z",
                }
            )
        finally:
            self.service.artifact_store.write_artifacts_json = original_write  # type: ignore[assignment]

        self.assertEqual(deck_payload["cardID"], "obf-223")
        event_row = self.service.connection.execute(
            "SELECT confirmed_card_id, confirmed_at FROM scan_events WHERE scan_id = ? LIMIT 1",
            (scan_id,),
        ).fetchone()
        assert event_row is not None
        self.assertEqual(event_row["confirmed_card_id"], "obf-223")
        self.assertEqual(event_row["confirmed_at"], "2026-04-14T20:12:00Z")

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

        self.assertEqual(first["deckEntryID"], second["deckEntryID"])
        self.assertEqual(len(deck_rows), 1)
        self.assertEqual(deck_rows[0]["quantity"], 2)
        assert event_row is not None
        assert confirmation_row is not None
        self.assertEqual(event_row["confirmed_card_id"], "gym1-60")
        self.assertEqual(event_row["confirmation_source"], "add_top")
        self.assertEqual(event_row["deck_entry_id"], first["deckEntryID"])
        self.assertEqual(confirmation_row["deck_entry_id"], first["deckEntryID"])

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
        slab_entry = next(entry for entry in entries if entry["itemKind"] == "slab")
        raw_entry = next(entry for entry in entries if entry["itemKind"] == "raw")
        self.assertEqual(slab_entry["card"]["id"], "base1-4")
        self.assertEqual(slab_entry["itemKind"], "slab")
        self.assertEqual(slab_entry["quantity"], 1)
        self.assertEqual(
            slab_entry["slabContext"],
            {
                "grader": "PSA",
                "grade": "10",
                "certNumber": "12345",
                "variantName": "Holofoil",
            },
        )
        self.assertEqual(slab_entry["card"]["pricing"]["market"], 100.0)
        self.assertEqual(raw_entry["card"]["id"], "gym1-60")
        self.assertEqual(raw_entry["quantity"], 1)
        self.assertIsNone(raw_entry["slabContext"])
        self.assertEqual(raw_entry["card"]["pricing"]["market"], 2.5)

    def test_record_buy_splits_raw_entries_by_condition_and_variant(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")

        self.service.record_buy(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "unitPrice": 6.0,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "boughtAt": "2026-04-14T09:00:00Z",
                "condition": "near_mint",
                "variantName": None,
            }
        )
        variant_payload = self.service.record_buy(
            {
                "cardID": "gym1-60",
                "quantity": 2,
                "unitPrice": 5.5,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "boughtAt": "2026-04-14T10:00:00Z",
                "condition": "lightly_played",
                "variantName": "Reverse Holo",
            }
        )

        payload = self.service.deck_entries(limit=10)
        entry_by_identity = {
            (entry["card"]["id"], entry["variantName"], entry["condition"]): entry
            for entry in payload["entries"]
        }

        self.assertEqual(payload["summary"]["count"], 2)
        self.assertEqual(payload["summary"]["rawCount"], 2)
        self.assertEqual(payload["summary"]["slabCount"], 0)
        self.assertIn(("gym1-60", None, "near_mint"), entry_by_identity)
        self.assertIn(("gym1-60", "Reverse Holo", "lightly_played"), entry_by_identity)
        self.assertEqual(entry_by_identity[("gym1-60", None, "near_mint")]["condition"], "near_mint")
        self.assertIsNone(entry_by_identity[("gym1-60", None, "near_mint")]["variantName"])
        self.assertEqual(entry_by_identity[("gym1-60", "Reverse Holo", "lightly_played")]["condition"], "lightly_played")
        self.assertEqual(entry_by_identity[("gym1-60", "Reverse Holo", "lightly_played")]["variantName"], "Reverse Holo")
        self.assertIsNone(entry_by_identity[("gym1-60", "Reverse Holo", "lightly_played")]["slabContext"])
        self.assertTrue(str(variant_payload["deckEntryID"]).startswith("deckentry:"))

    def test_record_buy_rejects_invalid_optional_scan_id(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")

        with self.assertRaisesRegex(FileNotFoundError, "source scan not found"):
            self.service.record_buy(
                {
                    "cardID": "gym1-60",
                    "quantity": 1,
                    "unitPrice": 6.0,
                    "currencyCode": "USD",
                    "paymentMethod": None,
                    "boughtAt": "2026-04-14T09:00:00Z",
                    "condition": "near_mint",
                    "sourceScanID": "local-capture-id-not-in-scan-events",
                }
            )

    def test_create_deck_entry_rejects_missing_scan_event(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")

        with self.assertRaisesRegex(FileNotFoundError, "scan event not found"):
            self.service.create_deck_entry(
                {
                    "cardID": "gym1-60",
                    "sourceScanID": "scan-id-not-in-scan-events",
                    "selectionSource": "top",
                    "selectedRank": 1,
                    "wasTopPrediction": True,
                    "addedAt": "2026-04-14T20:10:00Z",
                }
            )

    def test_deck_entries_use_condition_specific_raw_market_price(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_price_snapshot(
            self.service.connection,
            card_id="gym1-60",
            provider="scrydex",
            pricing_mode="raw",
            currency_code="USD",
            variant="Holofoil",
            condition="near_mint",
            low_price=10.0,
            market_price=12.5,
            mid_price=12.0,
            high_price=13.0,
            direct_low_price=9.5,
            trend_price=12.25,
            payload={"variant": "Holofoil", "condition": "NM"},
        )
        upsert_price_snapshot(
            self.service.connection,
            card_id="gym1-60",
            provider="scrydex",
            pricing_mode="raw",
            currency_code="USD",
            variant="Holofoil",
            condition="lightly_played",
            low_price=7.0,
            market_price=8.75,
            mid_price=8.5,
            high_price=9.0,
            direct_low_price=6.5,
            trend_price=8.6,
            payload={"variant": "Holofoil", "condition": "LP"},
        )
        self.service.record_buy(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "unitPrice": 12.5,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "boughtAt": "2026-04-14T09:00:00Z",
                "condition": "near_mint",
                "variantName": "Holofoil",
            }
        )
        self.service.record_buy(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "unitPrice": 8.75,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "boughtAt": "2026-04-14T10:00:00Z",
                "condition": "lightly_played",
                "variantName": "Holofoil",
            }
        )

        payload = self.service.deck_entries(limit=10)
        entry_by_identity = {
            (entry["card"]["id"], entry["variantName"], entry["condition"]): entry
            for entry in payload["entries"]
        }

        self.assertAlmostEqual(entry_by_identity[("gym1-60", "Holofoil", "near_mint")]["card"]["pricing"]["market"], 12.5, places=2)
        self.assertAlmostEqual(entry_by_identity[("gym1-60", "Holofoil", "lightly_played")]["card"]["pricing"]["market"], 8.75, places=2)

    def test_deck_entries_do_not_fallback_to_near_mint_for_other_raw_conditions(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_price_snapshot(
            self.service.connection,
            card_id="gym1-60",
            provider="scrydex",
            pricing_mode="raw",
            currency_code="USD",
            variant="Holofoil",
            condition="near_mint",
            low_price=10.0,
            market_price=12.5,
            mid_price=12.0,
            high_price=13.0,
            direct_low_price=9.5,
            trend_price=12.25,
            payload={"variant": "Holofoil", "condition": "NM"},
        )
        self.service.record_buy(
            {
                "cardID": "gym1-60",
                "quantity": 1,
                "unitPrice": 8.75,
                "currencyCode": "USD",
                "paymentMethod": "cash",
                "boughtAt": "2026-04-14T10:00:00Z",
                "condition": "lightly_played",
                "variantName": "Holofoil",
            }
        )

        payload = self.service.deck_entries(limit=10)
        entry = payload["entries"][0]

        self.assertEqual(entry["card"]["id"], "gym1-60")
        self.assertEqual(entry["variantName"], "Holofoil")
        self.assertEqual(entry["condition"], "lightly_played")
        self.assertIsNone(entry["card"].get("pricing"))

    def test_replace_deck_entry_moves_raw_entry_to_specific_variant_row(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")

        original_payload = self.service.record_buy(
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

        replace_payload = self.service.replace_deck_entry(
            {
                "deckEntryID": original_payload["deckEntryID"],
                "cardID": "gym1-60",
                "slabContext": None,
                "variantName": "Reverse Holo",
                "condition": "lightly_played",
                "quantity": 2,
                "unitPrice": 7.0,
                "currencyCode": "USD",
                "updatedAt": "2026-04-14T11:00:00Z",
            }
        )

        active_payload = self.service.deck_entries(limit=10)
        inactive_payload = self.service.deck_entries(limit=10, include_inactive=True)
        active_entry = active_payload["entries"][0]
        inactive_entry_by_id = {entry["id"]: entry for entry in inactive_payload["entries"]}

        self.assertEqual(replace_payload["previousDeckEntryID"], original_payload["deckEntryID"])
        self.assertNotEqual(replace_payload["deckEntryID"], original_payload["deckEntryID"])
        self.assertEqual(active_payload["summary"]["count"], 1)
        self.assertEqual(active_entry["id"], replace_payload["deckEntryID"])
        self.assertEqual(active_entry["card"]["id"], "gym1-60")
        self.assertEqual(active_entry["variantName"], "Reverse Holo")
        self.assertEqual(active_entry["condition"], "lightly_played")
        self.assertEqual(active_entry["quantity"], 2)
        self.assertEqual(inactive_entry_by_id[original_payload["deckEntryID"]]["quantity"], 0)
        self.assertEqual(inactive_entry_by_id[replace_payload["deckEntryID"]]["quantity"], 2)

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
        deck_entry_id = upsert_deck_entry(
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
            (deck_entry_id,),
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
        base1_4_entry_id = upsert_deck_entry(
            self.service.connection,
            card_id="base1-4",
            quantity=1,
            added_at="2026-04-14T20:00:00Z",
            updated_at="2026-04-14T20:00:00Z",
        )
        base1_2_entry_id = upsert_deck_entry(
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
            "SELECT id, card_id, quantity FROM deck_entries ORDER BY card_id, id"
        ).fetchall()
        sale_rows = self.service.connection.execute(
            "SELECT card_id, quantity, unit_price FROM sale_events ORDER BY sold_at, id"
        ).fetchall()

        self.assertEqual(
            [(row["card_id"], row["id"], row["quantity"]) for row in remaining_rows],
            [("base1-2", base1_2_entry_id, 0), ("base1-4", base1_4_entry_id, 0)],
        )
        self.assertEqual(
            [(row["card_id"], row["quantity"], float(row["unit_price"])) for row in sale_rows],
            [("base1-4", 1, 240.0), ("base1-2", 2, 85.0)],
        )

    def test_portfolio_ledger_excludes_inventory_adjustment_sales(self) -> None:
        today = datetime.now(timezone.utc).date()
        added_at = (today - timedelta(days=3)).isoformat() + "T20:00:00Z"
        adjustment_date = today - timedelta(days=2)
        manual_date = today - timedelta(days=1)
        adjustment_at = adjustment_date.isoformat() + "T20:00:00Z"
        manual_at = manual_date.isoformat() + "T20:00:00Z"

        self._insert_card("neo1-1", name="Ampharos")
        upsert_deck_entry(
            self.service.connection,
            card_id="neo1-1",
            quantity=2,
            added_at=added_at,
            updated_at=added_at,
        )
        self.service.connection.commit()

        self.service.record_sale(
            {
                "cardID": "neo1-1",
                "quantity": 1,
                "soldAt": adjustment_at,
                "unitPrice": 0.0,
                "currencyCode": "USD",
                "saleSource": "inventory_adjustment",
                "note": "Inventory decrement from card detail trash control.",
            }
        )
        self.service.record_sale(
            {
                "cardID": "neo1-1",
                "quantity": 1,
                "soldAt": manual_at,
                "unitPrice": 12.5,
                "currencyCode": "USD",
                "saleSource": "manual",
            }
        )

        ledger = self.service.portfolio_ledger(range_label="30D")
        self.assertAlmostEqual(ledger["summary"]["revenue"], 12.5, places=2)
        self.assertEqual(len(ledger["transactions"]), 1)
        self.assertEqual(ledger["transactions"][0]["kind"], "sell")
        self.assertEqual(ledger["transactions"][0]["totalPrice"], 12.5)

        daily_by_date = {point["date"]: point for point in ledger["dailySeries"]}
        self.assertAlmostEqual(daily_by_date[adjustment_date.isoformat()]["revenue"], 0.0, places=2)
        self.assertEqual(daily_by_date[adjustment_date.isoformat()]["sellCount"], 0)
        self.assertAlmostEqual(daily_by_date[manual_date.isoformat()]["revenue"], 12.5, places=2)
        self.assertEqual(daily_by_date[manual_date.isoformat()]["sellCount"], 1)

    def test_apply_schema_keeps_sold_entries_inactive(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        deck_entry_id = upsert_deck_entry(
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
            (deck_entry_id,),
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

    def test_deck_history_uses_preloaded_price_history_instead_of_day_by_day_queries(self) -> None:
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

        with patch("server.latest_price_history_row_for_card", side_effect=AssertionError("deck_history should not query day-by-day price history")):
            history = self.service.deck_history(days=2, range_label="ALL")

        points_by_date = {point["date"]: point for point in history["points"]}
        self.assertAlmostEqual(points_by_date["2026-04-14"]["totalValue"], 10.0, places=2)
        self.assertAlmostEqual(points_by_date["2026-04-15"]["totalValue"], 0.0, places=2)

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

        ledger = self.service.portfolio_ledger(range_label="ALL")

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
        deck_entry_id = buy_payload["deckEntryID"]

        buy_row = self.service.connection.execute(
            """
            SELECT id
            FROM deck_entry_events
            WHERE deck_entry_id = ?
              AND event_kind = 'buy'
            LIMIT 1
            """,
            (deck_entry_id,),
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
            (deck_entry_id,),
        ).fetchone()
        ledger = self.service.portfolio_ledger(range_label="ALL")

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
        deck_entry_id = buy_payload["deckEntryID"]
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
        ledger = self.service.portfolio_ledger(range_label="ALL")

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
        deck_entry_id = buy_payload["deckEntryID"]
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
              AND deck_entry_id = ?
            LIMIT 1
            """,
            (str(sale_payload["saleID"]), deck_entry_id),
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

    def test_portfolio_ledger_clamps_longer_ranges_to_first_portfolio_activity(self) -> None:
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

        with self._freeze_runtime_now("2026-04-26T12:00:00Z"):
            ledger_1w = self.service.portfolio_ledger(days=365, range_label="1W", time_zone_name="UTC")
            ledger_7d_alias = self.service.portfolio_ledger(days=365, range_label="7D", time_zone_name="UTC")
            ledger_30d = self.service.portfolio_ledger(days=365, range_label="30D", time_zone_name="UTC")
            ledger_90d = self.service.portfolio_ledger(days=365, range_label="90D", time_zone_name="UTC")
            ledger_ytd = self.service.portfolio_ledger(days=365, range_label="YTD", time_zone_name="UTC")
            ledger_1y = self.service.portfolio_ledger(days=30, range_label="1Y", time_zone_name="UTC")
            ledger_all = self.service.portfolio_ledger(days=365, range_label="ALL", time_zone_name="UTC")

        self.assertEqual(len(ledger_1w["dailySeries"]), 7)
        # `7D` continues to work as a backward-compat alias for `1W`.
        self.assertEqual(ledger_1w["range"], "1W")
        self.assertEqual(ledger_7d_alias["range"], "1W")
        self.assertEqual(
            len(ledger_7d_alias["dailySeries"]),
            len(ledger_1w["dailySeries"]),
        )
        self.assertEqual(len(ledger_30d["dailySeries"]), 12)
        self.assertEqual(len(ledger_90d["dailySeries"]), 12)
        self.assertEqual(len(ledger_1y["dailySeries"]), 12)
        # YTD nominally spans Jan 1 → frozen-now (2026-04-26), but here it gets
        # clamped to the earliest portfolio activity (2026-04-15).
        self.assertEqual(ledger_ytd["range"], "YTD")
        self.assertEqual(ledger_ytd["dailySeries"][0]["date"], "2026-04-15")
        self.assertEqual(ledger_ytd["dailySeries"][-1]["date"], "2026-04-26")
        self.assertGreaterEqual(len(ledger_all["dailySeries"]), 1)
        self.assertEqual(ledger_30d["dailySeries"][0]["date"], "2026-04-15")
        self.assertEqual(ledger_90d["dailySeries"][0]["date"], "2026-04-15")
        self.assertEqual(ledger_1y["dailySeries"][0]["date"], "2026-04-15")
        self.assertEqual(ledger_1y["dailySeries"][-1]["date"], "2026-04-26")
        self.assertEqual(ledger_all["dailySeries"][0]["date"], "2026-04-15")
        self.assertAlmostEqual(ledger_all["dailySeries"][0]["spend"], 12.0, places=2)
        self.assertEqual(ledger_all["dailySeries"][0]["buyCount"], 1)

    def test_deck_history_clamps_longer_ranges_to_first_portfolio_activity(self) -> None:
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

        with self._freeze_runtime_now("2026-04-26T12:00:00Z"):
            history_1y = self.service.deck_history(days=30, range_label="1Y", time_zone_name="UTC")

        self.assertEqual(len(history_1y["points"]), 12)
        self.assertEqual(history_1y["points"][0]["date"], "2026-04-15")
        self.assertEqual(history_1y["points"][-1]["date"], "2026-04-26")

    def test_portfolio_ranges_clamp_1w_when_first_activity_is_newer_than_a_week(self) -> None:
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
            source_updated_at="2026-04-22T19:00:00Z",
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
                "boughtAt": "2026-04-23T06:30:00Z",
                "condition": "near_mint",
            }
        )

        with self._freeze_runtime_now("2026-04-26T12:00:00Z"):
            ledger_1w = self.service.portfolio_ledger(days=365, range_label="1W", time_zone_name="UTC")
            history_1w = self.service.deck_history(days=365, range_label="1W", time_zone_name="UTC")
            # Backward-compat: legacy `7D` clients should produce the same shape.
            ledger_7d = self.service.portfolio_ledger(days=365, range_label="7D", time_zone_name="UTC")
            history_7d = self.service.deck_history(days=365, range_label="7D", time_zone_name="UTC")

        self.assertEqual(ledger_1w["dailySeries"][0]["date"], "2026-04-23")
        self.assertEqual(ledger_1w["dailySeries"][-1]["date"], "2026-04-26")
        self.assertEqual(len(ledger_1w["dailySeries"]), 4)
        self.assertEqual(history_1w["points"][0]["date"], "2026-04-23")
        self.assertEqual(history_1w["points"][-1]["date"], "2026-04-26")
        self.assertEqual(len(history_1w["points"]), 4)
        self.assertEqual(ledger_7d["range"], "1W")
        self.assertEqual(history_7d["range"], "1W")
        self.assertEqual(len(ledger_7d["dailySeries"]), len(ledger_1w["dailySeries"]))
        self.assertEqual(len(history_7d["points"]), len(history_1w["points"]))

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


class DeckEntriesDayChangeTests(ScanLoggingPhase7Tests):
    """Day-over-day change fields on inventory entries.

    Inherits the in-memory SQLite + service fixture from the phase-7 suite.
    """

    def _seed_raw_entry(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_price_snapshot(
            self.service.connection,
            card_id="gym1-60",
            provider="scrydex",
            pricing_mode="raw",
            currency_code="USD",
            variant="Normal",
            condition="near_mint",
            low_price=9.0,
            market_price=12.5,
            mid_price=12.0,
            high_price=13.0,
            direct_low_price=8.5,
            trend_price=12.25,
            payload={"variant": "Normal", "condition": "NM"},
        )
        upsert_deck_entry(
            self.service.connection,
            card_id="gym1-60",
            quantity=1,
            condition="near_mint",
            variant_name="Normal",
            unit_price=8.0,
            currency_code="USD",
            event_kind="buy",
            added_at="2026-04-20T09:00:00Z",
            updated_at="2026-04-20T09:00:00Z",
        )
        self.service.connection.commit()

    def _seed_yesterday_history(self, *, market_price: float) -> None:
        upsert_price_history_daily(
            self.service.connection,
            card_id="gym1-60",
            pricing_mode="raw",
            provider="scrydex",
            price_date="2026-04-25",
            currency_code="USD",
            variant="Normal",
            condition="NM",
            low_price=max(market_price - 1.0, 0.0),
            market_price=market_price,
            mid_price=market_price,
            high_price=market_price + 1.0,
            source_url="https://prices.example/gym1-60/2026-04-25",
            payload={"source": "scrydex"},
        )

    def test_deck_entries_includes_day_change_when_yesterday_snapshot_exists(self) -> None:
        self._seed_raw_entry()
        self._seed_yesterday_history(market_price=10.0)

        with self._freeze_runtime_now("2026-04-26T12:00:00Z"):
            payload = self.service.deck_entries(limit=10)

        entry = payload["entries"][0]
        self.assertIn("dayChangeAmount", entry)
        self.assertIn("dayChangePercent", entry)
        # Today price = 12.5, yesterday market = 10.0 -> +2.5, +25%
        assert entry["dayChangeAmount"] is not None
        assert entry["dayChangePercent"] is not None
        self.assertAlmostEqual(entry["dayChangeAmount"], 2.5, places=2)
        self.assertAlmostEqual(entry["dayChangePercent"], 25.0, places=2)

    def test_deck_entries_returns_null_day_change_when_no_yesterday_snapshot(self) -> None:
        # Mirrors the user's local backend, which does not run the daily
        # snapshot job. We must return null rather than crash.
        self._seed_raw_entry()

        with self._freeze_runtime_now("2026-04-26T12:00:00Z"):
            payload = self.service.deck_entries(limit=10)

        entry = payload["entries"][0]
        self.assertIsNone(entry["dayChangeAmount"])
        self.assertIsNone(entry["dayChangePercent"])

    def test_deck_entries_returns_null_percent_when_yesterday_price_is_zero(self) -> None:
        self._seed_raw_entry()
        self._seed_yesterday_history(market_price=0.0)

        with self._freeze_runtime_now("2026-04-26T12:00:00Z"):
            payload = self.service.deck_entries(limit=10)

        entry = payload["entries"][0]
        # Today's price = 12.5, yesterday market is 0 (use mid 0 then low 0 then high 1.0)
        # so primary is 0 and percent is undefined; amount is the raw delta vs 0.
        # _history_primary_price_value walks market -> mid -> low -> high and
        # short-circuits on the first numeric, so primary = 0 here.
        self.assertIsNotNone(entry["dayChangeAmount"])
        self.assertIsNone(entry["dayChangePercent"])

    def test_deck_history_ytd_starts_at_jan_first(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        # Seed activity on Jan 1 so the YTD bound is not clamped forward by
        # earliest_activity_at logic.
        upsert_price_history_daily(
            self.service.connection,
            card_id="gym1-60",
            pricing_mode="raw",
            provider="scrydex",
            price_date="2026-01-01",
            currency_code="USD",
            variant="Normal",
            condition="NM",
            low_price=4.0,
            market_price=5.0,
            mid_price=5.0,
            high_price=6.0,
            source_url="https://prices.example/gym1-60/2026-01-01",
            payload={"source": "scrydex"},
        )
        upsert_deck_entry(
            self.service.connection,
            card_id="gym1-60",
            quantity=1,
            condition="near_mint",
            unit_price=4.0,
            currency_code="USD",
            event_kind="buy",
            added_at="2026-01-01T00:00:00Z",
            updated_at="2026-01-01T00:00:00Z",
        )
        self.service.connection.commit()

        with self._freeze_runtime_now("2026-04-26T12:00:00Z"):
            history = self.service.deck_history(days=30, range_label="YTD", time_zone_name="UTC")

        self.assertEqual(history["range"], "YTD")
        # Jan 1 → Apr 26 inclusive = 116 days.
        self.assertEqual(history["points"][0]["date"], "2026-01-01")
        self.assertEqual(history["points"][-1]["date"], "2026-04-26")
        self.assertEqual(len(history["points"]), 116)

    def test_portfolio_history_treats_legacy_7d_as_1w_alias(self) -> None:
        self._insert_card("gym1-60", name="Sabrina's Slowbro")
        upsert_deck_entry(
            self.service.connection,
            card_id="gym1-60",
            quantity=1,
            condition="near_mint",
            unit_price=4.0,
            currency_code="USD",
            event_kind="buy",
            added_at="2026-04-22T00:00:00Z",
            updated_at="2026-04-22T00:00:00Z",
        )
        self.service.connection.commit()

        with self._freeze_runtime_now("2026-04-26T12:00:00Z"):
            history_legacy = self.service.deck_history(days=30, range_label="7D", time_zone_name="UTC")
            history_canonical = self.service.deck_history(days=30, range_label="1W", time_zone_name="UTC")

        # Both inputs must yield the same canonical `1W` output.
        self.assertEqual(history_legacy["range"], "1W")
        self.assertEqual(history_canonical["range"], "1W")
        self.assertEqual(
            [point["date"] for point in history_legacy["points"]],
            [point["date"] for point in history_canonical["points"]],
        )


if __name__ == "__main__":
    unittest.main()
