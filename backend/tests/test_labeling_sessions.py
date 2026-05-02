from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import server as server_module  # noqa: E402
from catalog_tools import apply_schema, connect  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from scan_artifact_store import SCAN_ARTIFACTS_ROOT_ENV, SCAN_ARTIFACTS_STORAGE_ENV  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402


class LabelingSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "labeling.sqlite"
        self.artifact_root = Path(self.tempdir.name) / "artifact-root"
        self.dataset_root = Path(self.tempdir.name) / "dataset-root"
        self.previous_artifact_root = os.environ.get(SCAN_ARTIFACTS_ROOT_ENV)
        self.previous_artifact_storage = os.environ.get(SCAN_ARTIFACTS_STORAGE_ENV)
        self.previous_train_root = os.environ.get("SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT")
        self.previous_labeling_batch_id = os.environ.get("SPOTLIGHT_LABELING_ACTIVE_BATCH_ID")
        self.previous_labeling_tier2_pct = os.environ.get("SPOTLIGHT_LABELING_TIER2_PERCENT")
        os.environ[SCAN_ARTIFACTS_ROOT_ENV] = str(self.artifact_root)
        os.environ[SCAN_ARTIFACTS_STORAGE_ENV] = "filesystem"
        os.environ["SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT"] = str(self.dataset_root / "raw-visual-train")
        os.environ["SPOTLIGHT_LABELING_ACTIVE_BATCH_ID"] = "test-batch-a"
        os.environ["SPOTLIGHT_LABELING_TIER2_PERCENT"] = "100"

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
        if self.previous_train_root is None:
            os.environ.pop("SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT", None)
        else:
            os.environ["SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT"] = self.previous_train_root
        if self.previous_labeling_batch_id is None:
            os.environ.pop("SPOTLIGHT_LABELING_ACTIVE_BATCH_ID", None)
        else:
            os.environ["SPOTLIGHT_LABELING_ACTIVE_BATCH_ID"] = self.previous_labeling_batch_id
        if self.previous_labeling_tier2_pct is None:
            os.environ.pop("SPOTLIGHT_LABELING_TIER2_PERCENT", None)
        else:
            os.environ["SPOTLIGHT_LABELING_TIER2_PERCENT"] = self.previous_labeling_tier2_pct
        self.tempdir.cleanup()

    def _identity(self, user_id: str = "labeler-user") -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(self, card_id: str) -> None:
        self.service.connection.execute(
            """
            INSERT INTO cards (
                id, name, set_name, number, rarity, variant, language,
                source_provider, source_record_id, set_id, set_series, set_ptcgo_code,
                set_release_date, supertype, subtypes_json, types_json, artist,
                regulation_mark, national_pokedex_numbers_json, image_url, image_small_url,
                source_payload_json, created_at, updated_at
            )
            VALUES (?, 'Label Test Card', 'Label Set', '12/99', 'Common', 'Raw', 'English',
                    'scrydex', ?, 'label-set', 'Label Series', NULL,
                    '2026-04-29', 'Pokémon', '[]', '[]', 'Artist',
                    NULL, '[]', 'https://images.example/card.png', 'https://images.example/card-small.png',
                    '{}', '2026-04-29T10:00:00+00:00', '2026-04-29T10:00:00+00:00')
            """,
            (card_id, card_id),
        )
        self.service.connection.commit()

    def test_apply_schema_backfills_legacy_labeling_tables(self) -> None:
        self.service.connection.execute("DROP TABLE IF EXISTS labeling_session_artifacts")
        self.service.connection.execute("DROP TABLE IF EXISTS labeling_sessions")
        self.service.connection.execute(
            """
            CREATE TABLE labeling_sessions (
                session_id TEXT PRIMARY KEY,
                card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                status TEXT NOT NULL CHECK(status IN ('capturing', 'completed', 'aborted')),
                selected_card_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT,
                aborted_at TEXT,
                abort_reason TEXT
            )
            """
        )
        self.service.connection.execute(
            """
            CREATE TABLE labeling_session_artifacts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES labeling_sessions(session_id) ON DELETE CASCADE,
                card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                angle_index INTEGER NOT NULL,
                angle_label TEXT NOT NULL,
                source_object_path TEXT NOT NULL,
                normalized_object_path TEXT NOT NULL,
                source_width INTEGER,
                source_height INTEGER,
                normalized_width INTEGER,
                normalized_height INTEGER,
                native_metadata_json TEXT NOT NULL DEFAULT '{}',
                crop_metadata_json TEXT NOT NULL DEFAULT '{}',
                normalization_metadata_json TEXT NOT NULL DEFAULT '{}',
                source_branch TEXT,
                pixels_per_card_height REAL,
                processing_ms REAL,
                scanner_front_half_version TEXT,
                submitted_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(session_id, angle_index)
            )
            """
        )
        self.service.connection.commit()

        apply_schema(self.service.connection, BACKEND_ROOT / "schema.sql")

        labeling_session_columns = {
            str(row["name"])
            for row in self.service.connection.execute("PRAGMA table_info(labeling_sessions)").fetchall()
        }
        self.assertTrue(
            {"labeler_user_id", "provider_card_id", "tier_assignment", "routed_batch_id", "first_capture_scan_id"}.issubset(
                labeling_session_columns
            )
        )

        labeling_artifact_columns = {
            str(row["name"])
            for row in self.service.connection.execute("PRAGMA table_info(labeling_session_artifacts)").fetchall()
        }
        self.assertTrue({"scan_id", "dataset_role"}.issubset(labeling_artifact_columns))

        provider_card_index = self.service.connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_labeling_sessions_provider_card'
            """
        ).fetchone()
        self.assertIsNotNone(provider_card_index)

        scan_id_index = self.service.connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_labeling_session_artifacts_scan_id'
            """
        ).fetchone()
        self.assertIsNotNone(scan_id_index)

    def test_create_labeling_session_validates_card_and_persists_canonical_card(self) -> None:
        self._insert_card("label-card-1")

        with self.service.request_identity_context(self._identity()):
            payload = self.service.create_labeling_session(
                {
                    "sessionID": "label-session-1",
                    "cardID": "label-card-1",
                    "selectedCard": {"id": "label-card-1", "name": "Label Test Card"},
                    "createdAt": "2026-04-29T17:00:00+00:00",
                }
            )

        self.assertEqual(payload["sessionID"], "label-session-1")
        self.assertEqual(payload["cardID"], "label-card-1")
        self.assertEqual(payload["providerCardID"], "label-card-1")
        self.assertEqual(payload["labelerUserID"], "labeler-user")
        self.assertEqual(payload["status"], "capturing")
        self.assertEqual(payload["artifactCount"], 0)
        self.assertEqual(payload["selectedCard"]["id"], "label-card-1")

        row = self.service.connection.execute(
            "SELECT labeler_user_id, card_id, provider_card_id, status, selected_card_json FROM labeling_sessions WHERE session_id = ?",
            ("label-session-1",),
        ).fetchone()
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["labeler_user_id"], "labeler-user")
        self.assertEqual(row["card_id"], "label-card-1")
        self.assertEqual(row["provider_card_id"], "label-card-1")
        self.assertEqual(row["status"], "capturing")
        self.assertEqual(json.loads(row["selected_card_json"])["id"], "label-card-1")

        with self.service.request_identity_context(self._identity()):
            with self.assertRaises(FileNotFoundError):
                self.service.create_labeling_session({"cardID": "missing-card"})

    def test_store_labeling_artifact_persists_files_metadata_and_completion(self) -> None:
        self._insert_card("label-card-2")
        with self.service.request_identity_context(self._identity()):
            self.service.create_labeling_session(
                {
                    "sessionID": "label-session-2",
                    "cardID": "label-card-2",
                    "createdAt": "2026-04-29T17:00:00+00:00",
                }
            )

            artifact = self.service.store_labeling_session_artifact(
                "label-session-2",
                {
                    "angleIndex": 1,
                    "angleLabel": "front oblique",
                    "submittedAt": "2026-04-29T17:01:00+00:00",
                    "sourceImage": {
                        "jpegBase64": base64.b64encode(b"label-source").decode("ascii"),
                        "width": 1000,
                        "height": 1400,
                    },
                    "normalizedImage": {
                        "jpegBase64": base64.b64encode(b"label-normalized").decode("ascii"),
                        "width": 630,
                        "height": 880,
                    },
                    "nativeSourceWidth": 1000,
                    "nativeSourceHeight": 1400,
                    "cropX": 25,
                    "cropY": 50,
                    "cropWidth": 600,
                    "cropHeight": 840,
                    "normalizationRotationDegrees": 0,
                    "normalizationReason": "reticle_normalized",
                    "sourceBranch": "acceptedRectangle",
                    "pixelsPerCardHeight": 872.5,
                    "processingMs": 41.25,
                    "scannerFrontHalfVersion": "front-half-test",
                },
            )

        self.assertEqual(artifact["sessionID"], "label-session-2")
        self.assertEqual(artifact["cardID"], "label-card-2")
        self.assertEqual(artifact["scanID"], "labeling-scan:label-session-2:01")
        self.assertEqual(artifact["angleIndex"], 1)
        self.assertEqual(artifact["angleLabel"], "front oblique")
        self.assertEqual(
            artifact["sourceObjectPath"],
            "labeling-sessions/label-session-2/angle_01_front_oblique/source_capture.jpg",
        )
        self.assertEqual(
            artifact["normalizedObjectPath"],
            "labeling-sessions/label-session-2/angle_01_front_oblique/normalized_target.jpg",
        )
        self.assertEqual((self.artifact_root / artifact["sourceObjectPath"]).read_bytes(), b"label-source")
        self.assertEqual((self.artifact_root / artifact["normalizedObjectPath"]).read_bytes(), b"label-normalized")

        row = self.service.connection.execute(
            """
            SELECT *
            FROM labeling_session_artifacts
            WHERE session_id = ? AND angle_index = ?
            """,
            ("label-session-2", 1),
        ).fetchone()
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["card_id"], "label-card-2")
        self.assertEqual(row["scan_id"], "labeling-scan:label-session-2:01")
        self.assertEqual(row["angle_label"], "front oblique")
        self.assertEqual(json.loads(row["native_metadata_json"]), {"sourceWidth": 1000.0, "sourceHeight": 1400.0})
        self.assertEqual(json.loads(row["crop_metadata_json"]), {"x": 25.0, "y": 50.0, "width": 600.0, "height": 840.0})
        self.assertEqual(json.loads(row["normalization_metadata_json"]), {"rotationDegrees": 0.0, "reason": "reticle_normalized"})
        self.assertEqual(row["source_branch"], "acceptedRectangle")
        self.assertEqual(row["pixels_per_card_height"], 872.5)
        self.assertEqual(row["processing_ms"], 41.25)
        self.assertEqual(row["scanner_front_half_version"], "front-half-test")
        self.assertIsNone(row["dataset_role"])

        linked_scan = self.service.connection.execute(
            """
            SELECT owner_user_id, selected_card_id, confirmed_card_id
            FROM scan_events
            WHERE scan_id = ?
            """,
            ("labeling-scan:label-session-2:01",),
        ).fetchone()
        self.assertIsNotNone(linked_scan)
        assert linked_scan is not None
        self.assertEqual(linked_scan["owner_user_id"], "labeler-user")
        self.assertEqual(linked_scan["selected_card_id"], "label-card-2")
        self.assertIsNone(linked_scan["confirmed_card_id"])

        with self.service.request_identity_context(self._identity()):
            with self.assertRaises(ValueError):
                self.service.complete_labeling_session(
                    "label-session-2",
                    {"completedAt": "2026-04-29T17:02:00+00:00"},
                )

        for angle_index, angle_label in (
            (2, "tilt_left"),
            (3, "tilt_right"),
            (4, "tilt_forward"),
        ):
            with self.service.request_identity_context(self._identity()):
                self.service.store_labeling_session_artifact(
                    "label-session-2",
                    {
                        "angleIndex": angle_index,
                        "angleLabel": angle_label,
                        "submittedAt": "2026-04-29T17:01:00+00:00",
                        "sourceImage": {
                            "jpegBase64": base64.b64encode(b"label-source").decode("ascii"),
                            "width": 1000,
                            "height": 1400,
                        },
                        "normalizedImage": {
                            "jpegBase64": base64.b64encode(b"label-normalized").decode("ascii"),
                            "width": 630,
                            "height": 880,
                        },
                    },
                )

        with self.service.request_identity_context(self._identity()):
            completed = self.service.complete_labeling_session(
                "label-session-2",
                {"completedAt": "2026-04-29T17:02:00+00:00"},
            )
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["artifactCount"], 4)
        self.assertEqual(completed["completedAt"], "2026-04-29T17:02:00+00:00")
        self.assertEqual(completed["labelerUserID"], "labeler-user")
        self.assertEqual(completed["providerCardID"], "label-card-2")
        self.assertEqual(completed["tierAssignment"], "tier2")
        self.assertEqual(completed["routedBatchID"], "test-batch-a")
        self.assertEqual(completed["firstCaptureScanID"], "labeling-scan:label-session-2:01")

        completed_row = self.service.connection.execute(
            """
            SELECT labeler_user_id, provider_card_id, tier_assignment, routed_batch_id, first_capture_scan_id
            FROM labeling_sessions
            WHERE session_id = ?
            """,
            ("label-session-2",),
        ).fetchone()
        self.assertIsNotNone(completed_row)
        assert completed_row is not None
        self.assertEqual(completed_row["labeler_user_id"], "labeler-user")
        self.assertEqual(completed_row["provider_card_id"], "label-card-2")
        self.assertEqual(completed_row["tier_assignment"], "tier2")
        self.assertEqual(completed_row["routed_batch_id"], "test-batch-a")
        self.assertEqual(completed_row["first_capture_scan_id"], "labeling-scan:label-session-2:01")

        artifact_rows = self.service.connection.execute(
            """
            SELECT angle_index, scan_id, dataset_role
            FROM labeling_session_artifacts
            WHERE session_id = ?
            ORDER BY angle_index
            """,
            ("label-session-2",),
        ).fetchall()
        self.assertEqual(
            [(row["angle_index"], row["scan_id"], row["dataset_role"]) for row in artifact_rows],
            [
                (1, "labeling-scan:label-session-2:01", "tier2"),
                (2, "labeling-scan:label-session-2:02", "tier2"),
                (3, "labeling-scan:label-session-2:03", "tier2"),
                (4, "labeling-scan:label-session-2:04", "tier2"),
            ],
        )

        confirmed_scan_rows = self.service.connection.execute(
            """
            SELECT scan_id, owner_user_id, confirmed_card_id
            FROM scan_events
            WHERE scan_id LIKE 'labeling-scan:label-session-2:%'
            ORDER BY scan_id
            """
        ).fetchall()
        self.assertEqual(len(confirmed_scan_rows), 4)
        self.assertTrue(all(row["owner_user_id"] == "labeler-user" for row in confirmed_scan_rows))
        self.assertTrue(all(row["confirmed_card_id"] == "label-card-2" for row in confirmed_scan_rows))

        registry_path = self.dataset_root / "raw-visual-train" / "raw_scan_registry.json"
        registry_payload = json.loads(registry_path.read_text())
        self.assertEqual(registry_payload["schemaVersion"], 2)
        self.assertEqual(registry_payload["providerCards"]["label-card-2"]["tier"], "tier2")
        self.assertEqual(registry_payload["providerCards"]["label-card-2"]["firstSeenBatchId"], "test-batch-a")

        with self.service.request_identity_context(self._identity()):
            with self.assertRaises(ValueError):
                self.service.store_labeling_session_artifact(
                    "label-session-2",
                    {
                        "angleIndex": 1,
                        "angleLabel": "back",
                        "sourceImage": {"jpegBase64": base64.b64encode(b"x").decode("ascii")},
                        "normalizedImage": {"jpegBase64": base64.b64encode(b"y").decode("ascii")},
                    },
                )

    def test_complete_requires_artifact_and_abort_marks_terminal_status(self) -> None:
        self._insert_card("label-card-3")
        with self.service.request_identity_context(self._identity()):
            self.service.create_labeling_session(
                {
                    "sessionID": "label-session-3",
                    "cardID": "label-card-3",
                    "createdAt": "2026-04-29T17:00:00+00:00",
                }
            )

            with self.assertRaises(ValueError):
                self.service.complete_labeling_session("label-session-3", {})

            aborted = self.service.abort_labeling_session(
                "label-session-3",
                {
                    "abortedAt": "2026-04-29T17:03:00+00:00",
                    "abortReason": "operator_cancelled",
                },
            )

        self.assertEqual(aborted["status"], "aborted")
        self.assertEqual(aborted["abortedAt"], "2026-04-29T17:03:00+00:00")
        self.assertEqual(aborted["abortReason"], "operator_cancelled")

        with self.service.request_identity_context(self._identity()):
            with self.assertRaises(ValueError):
                self.service.store_labeling_session_artifact(
                    "label-session-3",
                    {
                        "angleIndex": 1,
                        "angleLabel": "front",
                        "sourceImage": {"jpegBase64": base64.b64encode(b"x").decode("ascii")},
                        "normalizedImage": {"jpegBase64": base64.b64encode(b"y").decode("ascii")},
                    },
                )

    def test_repeated_provider_card_reuses_existing_tier_and_batch(self) -> None:
        self._insert_card("label-card-4")

        with self.service.request_identity_context(self._identity("labeler-a")):
            self.service.create_labeling_session(
                {
                    "sessionID": "label-session-4a",
                    "cardID": "label-card-4",
                    "createdAt": "2026-04-29T17:00:00+00:00",
                }
            )
            for angle_index, angle_label in (
                (1, "front"),
                (2, "tilt_left"),
                (3, "tilt_right"),
                (4, "tilt_forward"),
            ):
                self.service.store_labeling_session_artifact(
                    "label-session-4a",
                    {
                        "angleIndex": angle_index,
                        "angleLabel": angle_label,
                        "submittedAt": "2026-04-29T17:01:00+00:00",
                        "sourceImage": {"jpegBase64": base64.b64encode(b"label-source").decode("ascii")},
                        "normalizedImage": {"jpegBase64": base64.b64encode(b"label-normalized").decode("ascii")},
                    },
                )
            first_completed = self.service.complete_labeling_session(
                "label-session-4a",
                {"completedAt": "2026-04-29T17:02:00+00:00"},
            )

        os.environ["SPOTLIGHT_LABELING_ACTIVE_BATCH_ID"] = "test-batch-b"
        os.environ["SPOTLIGHT_LABELING_TIER2_PERCENT"] = "0"

        with self.service.request_identity_context(self._identity("labeler-a")):
            self.service.create_labeling_session(
                {
                    "sessionID": "label-session-4b",
                    "cardID": "label-card-4",
                    "createdAt": "2026-04-29T18:00:00+00:00",
                }
            )
            for angle_index, angle_label in (
                (1, "front"),
                (2, "tilt_left"),
                (3, "tilt_right"),
                (4, "tilt_forward"),
            ):
                self.service.store_labeling_session_artifact(
                    "label-session-4b",
                    {
                        "angleIndex": angle_index,
                        "angleLabel": angle_label,
                        "submittedAt": "2026-04-29T18:01:00+00:00",
                        "sourceImage": {"jpegBase64": base64.b64encode(b"label-source").decode("ascii")},
                        "normalizedImage": {"jpegBase64": base64.b64encode(b"label-normalized").decode("ascii")},
                    },
                )
            second_completed = self.service.complete_labeling_session(
                "label-session-4b",
                {"completedAt": "2026-04-29T18:02:00+00:00"},
            )

        self.assertEqual(first_completed["tierAssignment"], "tier2")
        self.assertEqual(second_completed["tierAssignment"], "tier2")
        self.assertEqual(first_completed["routedBatchID"], "test-batch-a")
        self.assertEqual(second_completed["routedBatchID"], "test-batch-a")

    def test_read_json_body_uses_large_limit_for_labeling_artifacts(self) -> None:
        original_default_limit = server_module.DEFAULT_JSON_BODY_LIMIT_BYTES
        original_artifact_limit = server_module.SCAN_ARTIFACT_JSON_BODY_LIMIT_BYTES
        server_module.DEFAULT_JSON_BODY_LIMIT_BYTES = 32
        server_module.SCAN_ARTIFACT_JSON_BODY_LIMIT_BYTES = 96
        try:
            body = b'{"sessionID":"' + (b"x" * 48) + b'"}'
            handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
            handler.path = "/api/v1/labeling-sessions/label-session-4/artifacts"
            handler.headers = {"Content-Length": str(len(body))}
            handler.rfile = io.BytesIO(body)

            payload = handler._read_json_body()

            self.assertEqual(payload, {"sessionID": "x" * 48})
            self.assertIsNone(handler._json_body_error_status)

            oversized_body = b'{"sessionID":"' + (b"y" * 120) + b'"}'
            handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
            handler.path = "/api/v1/labeling-sessions/label-session-4/artifacts"
            handler.headers = {"Content-Length": str(len(oversized_body))}
            handler.rfile = io.BytesIO(oversized_body)

            rejected_payload = handler._read_json_body()

            self.assertIsNone(rejected_payload)
            self.assertEqual(handler._json_body_error_status, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            self.assertEqual(handler._json_body_error_message, "JSON body exceeds 96 bytes")
        finally:
            server_module.DEFAULT_JSON_BODY_LIMIT_BYTES = original_default_limit
            server_module.SCAN_ARTIFACT_JSON_BODY_LIMIT_BYTES = original_artifact_limit

    def test_labeling_post_routes_run_inside_authenticated_request_context(self) -> None:
        identity = RequestIdentity(user_id="supabase-user", auth_source="test")
        request_payload = {"ok": True}
        cases = [
            (
                "/api/v1/labeling-sessions",
                "create_labeling_session",
                (request_payload,),
                HTTPStatus.CREATED,
            ),
            (
                "/api/v1/labeling-sessions/label-session-5/artifacts",
                "store_labeling_session_artifact",
                ("label-session-5", request_payload),
                HTTPStatus.CREATED,
            ),
            (
                "/api/v1/labeling-sessions/label-session-5/complete",
                "complete_labeling_session",
                ("label-session-5", request_payload),
                HTTPStatus.OK,
            ),
            (
                "/api/v1/labeling-sessions/label-session-5/abort",
                "abort_labeling_session",
                ("label-session-5", request_payload),
                HTTPStatus.OK,
            ),
        ]

        for path, service_method_name, expected_args, expected_status in cases:
            with self.subTest(path=path):
                handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
                handler.path = path
                handler.service = Mock()
                handler.service.request_identity_context.return_value = contextlib.nullcontext()
                getattr(handler.service, service_method_name).return_value = {"ok": True}
                handler._read_json_body = lambda: request_payload  # type: ignore[method-assign]
                handler._require_request_identity = lambda: identity  # type: ignore[method-assign]
                writes: list[tuple[HTTPStatus, dict[str, bool]]] = []
                handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]

                handler.do_POST()

                handler.service.request_identity_context.assert_called_once_with(identity)
                getattr(handler.service, service_method_name).assert_called_once_with(*expected_args)
                self.assertEqual(writes, [(expected_status, {"ok": True})])

    def test_labeling_post_routes_do_not_use_service_fallback_without_auth_identity(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/labeling-sessions"
        handler.service = Mock()
        handler._read_json_body = lambda: {"cardID": "sv9-43"}  # type: ignore[method-assign]
        handler._require_request_identity = lambda: None  # type: ignore[method-assign]
        handler._write_json = Mock()  # type: ignore[method-assign]

        handler.do_POST()

        handler.service.create_labeling_session.assert_not_called()
        handler.service.request_identity_context.assert_not_called()


if __name__ == "__main__":
    unittest.main()
