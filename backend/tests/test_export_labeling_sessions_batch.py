from __future__ import annotations

import base64
import csv
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from scan_artifact_store import SCAN_ARTIFACTS_ROOT_ENV, SCAN_ARTIFACTS_STORAGE_ENV  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class ExportLabelingSessionsBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "labeling.sqlite"
        self.artifact_root = Path(self.tempdir.name) / "artifact-root"
        self.output_root = Path(self.tempdir.name) / "export"
        self.previous_artifact_root = os.environ.get(SCAN_ARTIFACTS_ROOT_ENV)
        self.previous_artifact_storage = os.environ.get(SCAN_ARTIFACTS_STORAGE_ENV)
        self.previous_train_root = os.environ.get("SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT")
        self.previous_labeling_batch_id = os.environ.get("SPOTLIGHT_LABELING_ACTIVE_BATCH_ID")
        self.previous_labeling_tier2_pct = os.environ.get("SPOTLIGHT_LABELING_TIER2_PERCENT")
        os.environ[SCAN_ARTIFACTS_ROOT_ENV] = str(self.artifact_root)
        os.environ[SCAN_ARTIFACTS_STORAGE_ENV] = "filesystem"
        os.environ["SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT"] = str(Path(self.tempdir.name) / "raw-visual-train")
        os.environ["SPOTLIGHT_LABELING_ACTIVE_BATCH_ID"] = "export-batch-a"
        os.environ["SPOTLIGHT_LABELING_TIER2_PERCENT"] = "100"

        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()

        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self._insert_card()

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

    def _identity(self) -> RequestIdentity:
        return RequestIdentity(user_id="export-labeler", auth_source="test")

    def _insert_card(self) -> None:
        self.service.connection.execute(
            """
            INSERT INTO cards (
                id, name, set_name, number, rarity, variant, language,
                source_provider, source_record_id, set_id, set_series, set_ptcgo_code,
                set_release_date, supertype, subtypes_json, types_json, artist,
                regulation_mark, national_pokedex_numbers_json, image_url, image_small_url,
                source_payload_json, created_at, updated_at
            )
            VALUES ('label-card-export', 'Export Test Card', 'Export Set', '7/42', 'Rare', 'Raw', 'English',
                    'scrydex', 'scrydex-export-card', 'export-set-id', 'Export Series', 'EXP',
                    '2026-04-29', 'Pokémon', '[]', '[]', 'Artist',
                    NULL, '[]', 'https://images.example/card.png', 'https://images.example/card-small.png',
                    '{}', '2026-04-29T10:00:00+00:00', '2026-04-29T10:00:00+00:00')
            """
        )
        self.service.connection.commit()

    def _complete_session(self) -> None:
        with self.service.request_identity_context(self._identity()):
            self.service.create_labeling_session(
                {
                    "sessionID": "label-session-export",
                    "cardID": "label-card-export",
                    "createdAt": "2026-04-29T17:00:00+00:00",
                },
            )
            for angle_index, angle_label in (
                (1, "front"),
                (2, "tilt_left"),
                (3, "tilt_right"),
                (4, "tilt_forward"),
            ):
                self.service.store_labeling_session_artifact(
                    "label-session-export",
                    {
                        "angleIndex": angle_index,
                        "angleLabel": angle_label,
                        "submittedAt": f"2026-04-29T17:0{angle_index}:00+00:00",
                        "sourceImage": {
                            "jpegBase64": base64.b64encode(f"source-{angle_index}".encode("ascii")).decode("ascii"),
                            "width": 1000,
                            "height": 1400,
                        },
                        "normalizedImage": {
                            "jpegBase64": base64.b64encode(f"normalized-{angle_index}".encode("ascii")).decode("ascii"),
                            "width": 630,
                            "height": 880,
                        },
                    },
                )
            self.service.complete_labeling_session(
                "label-session-export",
                {"completedAt": "2026-04-29T17:05:00+00:00"},
            )

    def test_export_completed_session_writes_batch_photos_tsv_and_summary(self) -> None:
        self._complete_session()

        result = subprocess.run(
            [
                sys.executable,
                "tools/export_labeling_sessions_batch.py",
                "--database-path",
                str(self.database_path),
                "--artifact-root",
                str(self.artifact_root),
                "--output-root",
                str(self.output_root),
                "--batch-id",
                "test-labeling-export",
            ],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        summary = json.loads(result.stdout)

        self.assertEqual(summary["exportedArtifactCount"], 4)
        self.assertEqual(summary["skippedArtifactCount"], 0)
        resolved_output_root = self.output_root.resolve()
        self.assertEqual(summary["photoRoot"], str(resolved_output_root / "photos"))
        self.assertEqual(summary["spreadsheetPath"], str(resolved_output_root / "cards.tsv"))

        with (self.output_root / "cards.tsv").open(newline="") as handle:
            rows = list(csv.DictReader(handle, delimiter="\t"))

        self.assertEqual(len(rows), 4)
        first_row = rows[0]
        self.assertEqual(first_row["card_name"], "Export Test Card")
        self.assertEqual(first_row["number"], "7/42")
        self.assertEqual(first_row["set"], "EXP")
        self.assertEqual(first_row["provider"], "scrydex")
        self.assertEqual(first_row["provider_card_id"], "label-card-export")
        self.assertEqual(first_row["tier_assignment"], "tier2")
        self.assertEqual(first_row["routed_batch_id"], "export-batch-a")
        self.assertEqual(first_row["angle_index"], "1")
        self.assertEqual(first_row["scan_id"], "labeling-scan:label-session-export:01")
        self.assertEqual(first_row["dataset_role"], "tier2")
        self.assertEqual((self.output_root / "photos" / first_row["file_name"]).read_bytes(), b"normalized-1")
        self.assertEqual(
            (self.output_root / "source-captures" / first_row["source_capture_file_name"]).read_bytes(),
            b"source-1",
        )

        saved_summary = json.loads((self.output_root / "export_summary.json").read_text())
        self.assertEqual(saved_summary["processBatchCommand"][1], "tools/process_raw_visual_batch.py")
        self.assertEqual(saved_summary["processBatchCommand"][7], "test-labeling-export")


if __name__ == "__main__":
    unittest.main()
