from __future__ import annotations

import os
import sqlite3
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from server import (  # noqa: E402
    _default_dataset_root,
    _default_labeling_registry_path,
    _default_raw_visual_train_root,
    _deterministic_labeling_tier_bucket,
    _env_flag,
    _is_large_image_upload_path,
    _labeling_session_id_from_path,
    _normalize_labeling_tier,
    _sqlite_add_column_if_missing,
    _sqlite_table_exists,
    _recent_sales_age_hours,
    _recent_sales_payload,
    _apply_card_favorites_schema_patch,
    _apply_labeling_pipeline_schema_patch,
)


class ServerHelperTests(unittest.TestCase):
    def test_recent_sales_age_hours_handles_missing_invalid_past_and_future_timestamps(self) -> None:
        self.assertIsNone(_recent_sales_age_hours(None))
        self.assertIsNone(_recent_sales_age_hours("not-a-date"))

        past_timestamp = (datetime.now(timezone.utc) - timedelta(hours=26, minutes=15)).isoformat()
        future_timestamp = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()

        self.assertGreaterEqual(_recent_sales_age_hours(past_timestamp) or 0, 26)
        self.assertEqual(_recent_sales_age_hours(future_timestamp), 0)

    def test_recent_sales_payload_covers_not_loaded_no_results_and_available_shapes(self) -> None:
        not_loaded = _recent_sales_payload(
            None,
            source="ebay",
            grader="PSA",
            grade="9",
            not_loaded=True,
        )
        self.assertEqual(not_loaded["status"], "unavailable")
        self.assertEqual(not_loaded["statusReason"], "not_loaded")
        self.assertFalse(not_loaded["canRefresh"])

        stale_no_results = _recent_sales_payload(
            {
                "status": "no_results",
                "fetchedAt": (datetime.now(timezone.utc) - timedelta(hours=60)).isoformat(),
                "sales": [],
            },
            source="ebay",
            grader="PSA",
            grade="9",
        )
        self.assertEqual(stale_no_results["status"], "unavailable")
        self.assertEqual(stale_no_results["statusReason"], "no_results")
        self.assertTrue(stale_no_results["canRefresh"])
        self.assertEqual(
            stale_no_results["unavailableReason"],
            "No recent sold sales were returned for this slab.",
        )

        available = _recent_sales_payload(
            {
                "status": "available",
                "source": "ebay",
                "grader": "psa",
                "grade": "9",
                "fetchedAt": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
                "sales": [
                    {
                        "id": "sale-1",
                        "title": "PSA 9 Mew Black Star Promo",
                        "sold_at": "2026-05-01T12:00:00Z",
                        "price": 167.58,
                        "currencyCode": "usd",
                        "listing_url": "https://www.ebay.com/itm/123",
                    },
                ],
            },
            source="ebay",
            grader="PSA",
            grade="9",
        )
        self.assertEqual(available["status"], "available")
        self.assertFalse(available["canRefresh"])
        self.assertEqual(available["saleCount"], 1)
        self.assertEqual(available["sales"][0]["currencyCode"], "USD")
        self.assertEqual(available["sales"][0]["listingURL"], "https://www.ebay.com/itm/123")

    def test_labeling_route_and_upload_path_helpers_validate_session_ids(self) -> None:
        self.assertEqual(
            _labeling_session_id_from_path("/api/v1/labeling-sessions/session-1/artifacts", "/artifacts"),
            "session-1",
        )
        self.assertEqual(
            _labeling_session_id_from_path("/api/v1/labeling-sessions/session%201/artifacts", "/artifacts"),
            "session 1",
        )
        self.assertEqual(
            _labeling_session_id_from_path("/api/v1/labeling-sessions/session%2F1/artifacts", "/artifacts"),
            "",
        )
        self.assertIsNone(_labeling_session_id_from_path("/api/v1/cards/base1-4", "/artifacts"))
        self.assertTrue(_is_large_image_upload_path("/api/v1/scan-artifacts"))
        self.assertTrue(_is_large_image_upload_path("/api/v1/labeling-sessions/session-1/artifacts"))
        self.assertFalse(_is_large_image_upload_path("/api/v1/cards/base1-4"))

    def test_dataset_root_helpers_use_environment_overrides(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SPOTLIGHT_DATASET_ROOT": "/tmp/spotlight-datasets",
                "SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT": "/tmp/custom-raw-train",
            },
            clear=False,
        ):
            self.assertEqual(_default_dataset_root(), Path("/tmp/spotlight-datasets"))
            self.assertEqual(_default_raw_visual_train_root(), Path("/tmp/custom-raw-train"))
            self.assertEqual(
                _default_labeling_registry_path(),
                Path("/tmp/custom-raw-train/raw_scan_registry.json"),
            )

        with patch.dict(os.environ, {}, clear=True):
            self.assertTrue(str(_default_dataset_root()).endswith("spotlight-datasets"))
            self.assertTrue(str(_default_raw_visual_train_root()).endswith("spotlight-datasets/raw-visual-train"))

    def test_labeling_tier_bucket_and_env_flag_helpers_are_stable(self) -> None:
        self.assertEqual(_normalize_labeling_tier("tier2"), "tier2")
        self.assertEqual(_normalize_labeling_tier(" Tier3 "), "tier3")
        self.assertIsNone(_normalize_labeling_tier("tier1"))

        bucket_a = _deterministic_labeling_tier_bucket("base1-4", "batch-1")
        bucket_b = _deterministic_labeling_tier_bucket("base1-4", "batch-1")
        bucket_c = _deterministic_labeling_tier_bucket("base1-4", "batch-2")
        self.assertEqual(bucket_a, bucket_b)
        self.assertGreaterEqual(bucket_a, 0)
        self.assertLess(bucket_a, 100)
        self.assertNotEqual(bucket_a, bucket_c)

        with patch.dict(os.environ, {"FEATURE_ON": "yes", "FEATURE_OFF": "0"}, clear=False):
            self.assertTrue(_env_flag("FEATURE_ON"))
            self.assertFalse(_env_flag("FEATURE_OFF", default=True))
            self.assertTrue(_env_flag("MISSING_FLAG", default=True))

    def test_sqlite_table_and_schema_patch_helpers_add_expected_columns_and_tables(self) -> None:
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.execute("CREATE TABLE labeling_sessions (id TEXT PRIMARY KEY, created_at TEXT)")
        connection.execute("CREATE TABLE labeling_session_artifacts (id TEXT PRIMARY KEY, created_at TEXT)")

        self.assertTrue(_sqlite_table_exists(connection, "labeling_sessions"))
        self.assertFalse(_sqlite_table_exists(connection, "missing_table"))

        _sqlite_add_column_if_missing(connection, "labeling_sessions", "provider_card_id", "TEXT")
        _sqlite_add_column_if_missing(connection, "missing_table", "ignored", "TEXT")
        _sqlite_add_column_if_missing(connection, "labeling_sessions", "provider_card_id", "TEXT")

        columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(labeling_sessions)").fetchall()
        }
        self.assertIn("provider_card_id", columns)

        _apply_labeling_pipeline_schema_patch(connection)
        artifact_columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(labeling_session_artifacts)").fetchall()
        }
        self.assertIn("labeler_user_id", {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(labeling_sessions)").fetchall()
        })
        self.assertIn("scan_id", artifact_columns)
        self.assertIn("dataset_role", artifact_columns)

        _apply_card_favorites_schema_patch(connection)
        self.assertTrue(_sqlite_table_exists(connection, "card_favorites"))
        favorite_indexes = {
            str(row["name"])
            for row in connection.execute("PRAGMA index_list(card_favorites)").fetchall()
        }
        self.assertIn("idx_card_favorites_owner_user_id", favorite_indexes)
        self.assertIn("idx_card_favorites_card_id", favorite_indexes)


if __name__ == "__main__":
    unittest.main()
