from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_sync import (  # noqa: E402
    CatalogSyncPaths,
    active_release_preloads,
    build_catalog_sync_plan,
    diff_catalog_snapshots,
    load_catalog_sync_state,
    run_catalog_sync_once,
)


class CatalogSyncTests(unittest.TestCase):
    def test_diff_catalog_snapshots_counts_added_and_updated(self) -> None:
        before = [
            {"id": "base1-2", "name": "Blastoise"},
            {"id": "neo1-9", "name": "Lugia"},
        ]
        after = [
            {"id": "base1-2", "name": "Blastoise"},
            {"id": "neo1-9", "name": "Lugia Holo"},
            {"id": "sv8-238", "name": "Pikachu ex"},
        ]

        diff = diff_catalog_snapshots(before, after)

        self.assertEqual(diff["beforeCount"], 2)
        self.assertEqual(diff["afterCount"], 3)
        self.assertEqual(diff["added"], 1)
        self.assertEqual(diff["updated"], 1)

    def test_active_release_preloads_filters_by_date_window(self) -> None:
        manifest = {
            "releasePreloads": [
                {"id": "future", "query": "set.series:\"Future\"", "startDate": "2026-04-05", "endDate": "2026-04-10"},
                {"id": "active", "query": "set.series:\"Scarlet & Violet\"", "startDate": "2026-04-01", "endDate": "2026-04-10"},
                {"id": "expired", "query": "set.series:\"Old\"", "startDate": "2026-03-01", "endDate": "2026-03-10"},
            ]
        }

        active = active_release_preloads(manifest, datetime(2026, 4, 3, tzinfo=UTC).date())

        self.assertEqual([item["id"] for item in active], ["active"])

    def test_build_catalog_sync_plan_honors_intervals(self) -> None:
        manifest = {
            "fullQuery": "set.series:\"Scarlet & Violet\"",
            "fullSyncIntervalHours": 24,
            "releaseSyncIntervalHours": 6,
            "releasePreloads": [
                {
                    "id": "scarlet-window",
                    "query": "set.series:\"Scarlet & Violet\"",
                    "startDate": "2026-04-01",
                    "endDate": "2026-04-10",
                }
            ],
        }
        now = datetime(2026, 4, 3, 12, 0, tzinfo=UTC)
        state = {
            "lastFullSyncAt": "2026-04-03T05:30:00+00:00",
            "releaseSyncs": {"scarlet-window": "2026-04-03T03:00:00+00:00"},
        }

        plan = build_catalog_sync_plan(manifest, state, now)

        self.assertFalse(plan["runFullSync"])
        self.assertEqual(len(plan["releaseTasks"]), 1)

    def test_run_catalog_sync_once_updates_state_when_nothing_is_due(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            temp_path = Path(tempdir)
            state_path = temp_path / "catalog_sync_state.json"
            cards_path = temp_path / "cards.json"
            cards_path.write_text(json.dumps([{"id": "base1-2", "name": "Blastoise"}]))
            manifest = {
                "fullQuery": "set.series:\"Scarlet & Violet\"",
                "fullSyncIntervalHours": 24,
                "releaseSyncIntervalHours": 6,
                "releasePreloads": [],
            }
            state = {
                "lastFullSyncAt": "2026-04-03T11:30:00+00:00",
                "releaseSyncs": {},
                "runs": [],
            }
            state_path.write_text(json.dumps(state))
            paths = CatalogSyncPaths(
                cards_path=cards_path,
                images_dir=temp_path / "images",
                database_path=temp_path / "spotlight.sqlite",
                schema_path=BACKEND_ROOT / "schema.sql",
                repo_root=REPO_ROOT,
                backend_root=BACKEND_ROOT,
            )

            with patch("catalog_sync.execute_catalog_sync_step") as execute_sync_step:
                summary = run_catalog_sync_once(
                    manifest=manifest,
                    state_path=state_path,
                    paths=paths,
                    now=datetime(2026, 4, 3, 12, 0, tzinfo=UTC),
                )

            self.assertEqual(summary["runs"][0]["syncMode"], "skipped")
            execute_sync_step.assert_not_called()
            saved_state = load_catalog_sync_state(state_path)
            self.assertEqual(len(saved_state["runs"]), 1)

