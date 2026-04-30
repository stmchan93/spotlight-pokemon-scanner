from __future__ import annotations

import base64
import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

VALID_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aOoAAAAASUVORK5CYII="


class ProcessRawVisualBatchTrustedCaptureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.photo_root = self.root / "photos"
        self.photo_root.mkdir(parents=True, exist_ok=True)
        self.spreadsheet_path = self.root / "cards.tsv"
        self.training_root = self.root / "raw-visual-train"
        self.expansion_holdout_root = self.root / "raw-visual-expansion-holdouts"
        self.excluded_root = self.root / "raw-visual-train-excluded"
        self.heldout_root = self.root / "raw-footer-layout-check"
        self.audit_root = self.root / "batch-audits"
        self.registry_path = self.root / "raw_scan_registry.json"

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def _write_png(self, file_name: str, suffix: str) -> None:
        png_bytes = base64.b64decode(VALID_PNG_BASE64) + suffix.encode("utf-8")
        (self.photo_root / file_name).write_bytes(png_bytes)

    def _write_spreadsheet(self) -> None:
        rows = [
            {
                "file_name": "tier2-front.png",
                "card_name": "Trusted Tier Two",
                "number": "7/42",
                "set": "EXP",
                "Promo": "",
                "provider_card_id": "provider-tier2-card",
                "tier_assignment": "tier2",
                "routed_batch_id": "trusted-batch-a",
                "labeling_session_id": "labeling-session-tier2",
                "scan_id": "labeling-scan:tier2:01",
            },
            {
                "file_name": "tier2-tilt.png",
                "card_name": "Trusted Tier Two",
                "number": "7/42",
                "set": "EXP",
                "Promo": "",
                "provider_card_id": "provider-tier2-card",
                "tier_assignment": "tier2",
                "routed_batch_id": "trusted-batch-a",
                "labeling_session_id": "labeling-session-tier2",
                "scan_id": "labeling-scan:tier2:02",
            },
            {
                "file_name": "tier3-front.png",
                "card_name": "Trusted Tier Three",
                "number": "9/99",
                "set": "EXP",
                "Promo": "",
                "provider_card_id": "provider-tier3-card",
                "tier_assignment": "tier3",
                "routed_batch_id": "trusted-batch-a",
                "labeling_session_id": "labeling-session-tier3",
                "scan_id": "labeling-scan:tier3:01",
            },
            {
                "file_name": "tier3-tilt.png",
                "card_name": "Trusted Tier Three",
                "number": "9/99",
                "set": "EXP",
                "Promo": "",
                "provider_card_id": "provider-tier3-card",
                "tier_assignment": "tier3",
                "routed_batch_id": "trusted-batch-a",
                "labeling_session_id": "labeling-session-tier3",
                "scan_id": "labeling-scan:tier3:02",
            },
        ]
        with self.spreadsheet_path.open("w", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=[
                    "file_name",
                    "card_name",
                    "number",
                    "set",
                    "Promo",
                    "provider_card_id",
                    "tier_assignment",
                    "routed_batch_id",
                    "labeling_session_id",
                    "scan_id",
                ],
                delimiter="\t",
            )
            writer.writeheader()
            writer.writerows(rows)

    def test_trusted_capture_rows_bypass_image_level_holdout_split(self) -> None:
        self._write_png("tier2-front.png", "tier2-front")
        self._write_png("tier2-tilt.png", "tier2-tilt")
        self._write_png("tier3-front.png", "tier3-front")
        self._write_png("tier3-tilt.png", "tier3-tilt")
        self._write_spreadsheet()
        self.registry_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "updatedAt": "2026-04-29T00:00:00Z",
                    "providerCards": {
                        "provider-tier2-card": {
                            "providerCardId": "provider-tier2-card",
                            "tier": "tier2",
                            "firstSeenBatchId": "trusted-batch-a",
                        }
                    },
                    "entries": [],
                }
            )
            + "\n"
        )

        subprocess.run(
            [
                sys.executable,
                "tools/process_raw_visual_batch.py",
                "--spreadsheet",
                str(self.spreadsheet_path),
                "--photo-root",
                str(self.photo_root),
                "--batch-id",
                "trusted-batch-a",
                "--training-root",
                str(self.training_root),
                "--expansion-holdout-root",
                str(self.expansion_holdout_root),
                "--excluded-root",
                str(self.excluded_root),
                "--heldout-root",
                str(self.heldout_root),
                "--audit-root",
                str(self.audit_root),
                "--registry-path",
                str(self.registry_path),
            ],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )

        batch_root = self.audit_root / "trusted-batch-a"
        with (batch_root / "safe_import.tsv").open(newline="") as handle:
            safe_import_rows = list(csv.DictReader(handle, delimiter="\t"))
        with (batch_root / "expansion_holdout.tsv").open(newline="") as handle:
            holdout_rows = list(csv.DictReader(handle, delimiter="\t"))

        self.assertEqual(
            sorted(row["provider_card_id"] for row in safe_import_rows),
            ["provider-tier3-card", "provider-tier3-card"],
        )
        self.assertEqual(
            sorted(row["provider_card_id"] for row in holdout_rows),
            ["provider-tier2-card", "provider-tier2-card"],
        )
        self.assertTrue(all(row["tier_assignment"] == "tier3" for row in safe_import_rows))
        self.assertTrue(all(row["tier_assignment"] == "tier2" for row in holdout_rows))

        registry_payload = json.loads(self.registry_path.read_text())
        self.assertEqual(registry_payload["schemaVersion"], 2)
        self.assertIn("providerCards", registry_payload)
        self.assertEqual(
            registry_payload["providerCards"]["provider-tier2-card"]["tier"],
            "tier2",
        )


if __name__ == "__main__":
    unittest.main()
