from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
ORIGINAL_IMPORT = __import__

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    PSA_GRADE_PRICING_MODE,
    PROVIDER_SYNC_STATUS_SUCCEEDED,
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    price_history_rows_for_card,
    price_snapshot_for_card,
    upsert_price_history_daily,
    start_provider_sync_run,
    update_provider_sync_run,
    upsert_card,
    upsert_card_price_summary,
    upsert_price_snapshot,
    upsert_slab_price_snapshot,
    utc_now,
)
from scrydex_adapter import (  # noqa: E402
    DEFAULT_CATALOG_SYNC_TIMEOUT_SECONDS,
    fetch_scrydex_cards_page,
    persist_scrydex_all_graded_snapshots,
    persist_scrydex_daily_history_from_card_payload,
    reset_scrydex_request_stats,
    scrydex_request_audit_summary,
    store_scrydex_request_audit,
)
from server import PricingLoadPolicy, SpotlightScanService, _load_backend_env_file  # noqa: E402
from sync_scrydex_catalog import sync_scrydex_catalog  # noqa: E402


class PricingPhase6Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "phase6.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
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
            supertype="Pokemon",
        )
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_connect_enables_sqlite_runtime_pragmas(self) -> None:
        journal_mode = str(self.connection.execute("PRAGMA journal_mode").fetchone()[0]).strip().lower()
        synchronous = int(self.connection.execute("PRAGMA synchronous").fetchone()[0])
        busy_timeout = int(self.connection.execute("PRAGMA busy_timeout").fetchone()[0])

        self.assertEqual(journal_mode, "wal")
        self.assertEqual(synchronous, 1)
        self.assertGreaterEqual(busy_timeout, 5000)

    def test_price_history_lookup_uses_card_provider_index(self) -> None:
        plan_rows = self.connection.execute(
            """
            EXPLAIN QUERY PLAN
            SELECT *
            FROM card_price_history_daily
            WHERE card_id = ? AND provider = ?
            ORDER BY price_date DESC, updated_at DESC
            LIMIT 1
            """,
            ("base1-4", "scrydex"),
        ).fetchall()
        plan_detail = " ".join(str(row["detail"]) for row in plan_rows)

        self.assertIn("idx_card_price_history_daily_card_provider_lookup", plan_detail)

    def test_provider_snapshot_lookup_uses_provider_updated_index(self) -> None:
        plan_rows = self.connection.execute(
            """
            EXPLAIN QUERY PLAN
            SELECT updated_at
            FROM card_price_snapshots
            WHERE provider = ?
            ORDER BY updated_at DESC
            LIMIT 5
            """,
            ("scrydex",),
        ).fetchall()
        plan_detail = " ".join(str(row["detail"]) for row in plan_rows)

        self.assertIn("idx_card_price_snapshots_provider_updated_at", plan_detail)

    def _seed_full_catalog_sync(self, *, completed_at: str | None = None) -> None:
        run_id = start_provider_sync_run(
            self.connection,
            provider="scrydex",
            sync_scope="raw_catalog_full",
            page_size=100,
        )
        update_provider_sync_run(
            self.connection,
            run_id,
            status=PROVIDER_SYNC_STATUS_SUCCEEDED,
            completed_at=completed_at or utc_now(),
            pages_fetched=203,
            cards_seen=20237,
            cards_upserted=20237,
            raw_snapshots_upserted=20237,
            graded_snapshots_upserted=51000,
            estimated_credits_used=203,
        )
        self.connection.commit()

    def _policy_rule_matrix(self, policy: PricingLoadPolicy) -> list[tuple[bool, bool, bool, bool]]:
        return [
            (
                policy.rule_for_rank(index).ensure_cached,
                policy.rule_for_rank(index).refresh_stale,
                policy.rule_for_rank(index).refresh_missing,
                policy.rule_for_rank(index).force_show_mode_refresh,
            )
            for index in range(1, 11)
        ]

    def _assert_refresh_card_pricing_blocked(
        self,
        *,
        completed_at: str | None,
        grader: str | None,
        grade: str | None,
        force_refresh: bool,
        show_mode: bool,
        refresh_method_name: str,
    ) -> None:
        self._seed_full_catalog_sync(completed_at=completed_at)

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        scrydex_provider = service.pricing_registry.get_provider("scrydex")
        assert scrydex_provider is not None
        setattr(scrydex_provider, refresh_method_name, Mock(return_value=Mock(success=True)))  # type: ignore[method-assign]

        try:
            if show_mode:
                service.set_card_show_mode(duration_hours=8, note="show floor")
            detail = service.refresh_card_pricing(
                "base1-4",
                grader=grader,
                grade=grade,
                force_refresh=force_refresh,
            )
        finally:
            service.connection.close()

        getattr(scrydex_provider, refresh_method_name).assert_not_called()
        self.assertIsNotNone(detail)

    def test_raw_wrapper_writes_only_card_price_snapshots(self) -> None:
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
            payload={"provider": "scrydex", "priceSource": "tcgplayer"},
        )

        snapshot_count = self.connection.execute(
            "SELECT COUNT(*) AS count FROM card_price_snapshots",
        ).fetchone()["count"]
        snapshot_row = self.connection.execute(
            """
            SELECT default_raw_variant, default_raw_condition, raw_contexts_json, graded_contexts_json
            FROM card_price_snapshots
            WHERE card_id = ?
            """,
            ("base1-4",),
        ).fetchone()
        legacy_tables = {
            row["name"]
            for row in self.connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'card_price_summaries'
                """
            ).fetchall()
        }

        self.assertEqual(snapshot_count, 1)
        self.assertIsNotNone(snapshot_row)
        assert snapshot_row is not None
        raw_contexts = json.loads(snapshot_row["raw_contexts_json"])
        graded_contexts = json.loads(snapshot_row["graded_contexts_json"])
        self.assertEqual(str(snapshot_row["default_raw_variant"]).lower(), "holofoil")
        self.assertEqual(snapshot_row["default_raw_condition"], "NM")
        self.assertIn("Holofoil", raw_contexts["variants"])
        self.assertEqual(graded_contexts, {"graders": {}})
        self.assertEqual(legacy_tables, set())

    def test_slab_wrapper_writes_only_card_price_snapshots(self) -> None:
        upsert_slab_price_snapshot(
            self.connection,
            card_id="base1-4",
            grader="PSA",
            grade="9",
            pricing_tier="scrydex_exact_grade",
            currency_code="USD",
            low_price=900.0,
            market_price=1000.0,
            mid_price=980.0,
            high_price=1100.0,
            last_sale_price=None,
            last_sale_date=None,
            comp_count=0,
            recent_comp_count=0,
            confidence_level=4,
            confidence_label="High",
            bucket_key="base:pokemon:rare-holo",
            source_url="https://scrydex.example/base1-4",
            source="scrydex",
            summary="Scrydex exact PSA 9 market snapshot.",
            payload={"provider": "scrydex"},
        )

        snapshot_count = self.connection.execute(
            "SELECT COUNT(*) AS count FROM card_price_snapshots",
        ).fetchone()["count"]
        snapshot_row = self.connection.execute(
            """
            SELECT raw_contexts_json, graded_contexts_json
            FROM card_price_snapshots
            WHERE card_id = ?
            """,
            ("base1-4",),
        ).fetchone()
        legacy_tables = {
            row["name"]
            for row in self.connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'slab_price_snapshots'
                """
            ).fetchall()
        }

        self.assertEqual(snapshot_count, 1)
        self.assertIsNotNone(snapshot_row)
        assert snapshot_row is not None
        raw_contexts = json.loads(snapshot_row["raw_contexts_json"])
        graded_contexts = json.loads(snapshot_row["graded_contexts_json"])
        self.assertEqual(raw_contexts, {"variants": {}})
        self.assertIn("PSA", graded_contexts["graders"])
        self.assertIn("9", graded_contexts["graders"]["PSA"])
        self.assertEqual(legacy_tables, set())

    def test_provider_status_and_cache_status_read_card_price_snapshots(self) -> None:
        upsert_price_snapshot(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="normal",
            low_price=100.0,
            market_price=120.0,
            mid_price=115.0,
            high_price=140.0,
            source_url="https://prices.example/raw",
            payload={"provider": "scrydex"},
        )
        upsert_price_snapshot(
            self.connection,
            card_id="base1-4",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider="scrydex",
            grader="PSA",
            grade="9",
            variant="PSA 9",
            currency_code="USD",
            low_price=900.0,
            market_price=1000.0,
            mid_price=980.0,
            high_price=1100.0,
            source_url="https://prices.example/graded",
            payload={"provider": "scrydex", "pricing_tier": "scrydex_exact_grade"},
        )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            provider_status = service.provider_status()
            cache_status = service.cache_status()
        finally:
            service.connection.close()

        providers = {provider["providerId"]: provider for provider in provider_status["providers"]}
        self.assertIsNotNone(providers["scrydex"]["lastRawRefreshAt"])
        self.assertIsNotNone(providers["scrydex"]["lastPsaRefreshAt"])
        self.assertFalse(providers["pricecharting"]["supportsRawPricing"])
        self.assertFalse(providers["pricecharting"]["supportsPsaPricing"])
        self.assertEqual(provider_status["runtimeMode"], "raw_only")
        self.assertEqual(provider_status["experimentalResolverModes"], ["psa_slab"])
        self.assertIn("scrydexRequestStats", provider_status)
        self.assertIn("livePricing", provider_status)
        self.assertIn("scanArtifactUploads", provider_status)
        self.assertFalse(provider_status["livePricing"]["enabled"])
        self.assertEqual(provider_status["scanArtifactUploads"]["storage"], "filesystem")
        self.assertIsNone(provider_status["scanArtifactUploads"]["activeBucketName"])
        self.assertTrue(provider_status["scanArtifactUploads"]["filesystemRoot"].endswith("backend/data/scan-artifacts"))
        self.assertEqual(cache_status["rawSnapshots"]["count"], 1)
        self.assertEqual(cache_status["slabSnapshots"]["count"], 1)

    def test_set_live_pricing_mode_persists_runtime_gate(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            state = service.set_live_pricing_mode(enabled=True, note="beta test")
            provider_status = service.provider_status()
        finally:
            service.connection.close()

        self.assertTrue(state["enabled"])
        self.assertEqual(state["note"], "beta test")
        self.assertEqual(state["source"], "runtime_setting")
        self.assertEqual(state["refreshWindowHours"], 1.0)
        self.assertTrue(provider_status["livePricing"]["enabled"])

    def test_provider_status_reports_latest_full_catalog_sync(self) -> None:
        self._seed_full_catalog_sync()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            provider_status = service.provider_status()
        finally:
            service.connection.close()

        self.assertTrue(provider_status["scrydexFullCatalogSyncFresh"])
        self.assertEqual(provider_status["scrydexFullCatalogSync"]["syncScope"], "raw_catalog_full")
        self.assertEqual(provider_status["scrydexFullCatalogSync"]["pagesFetched"], 203)
        self.assertTrue(provider_status["manualScrydexMirror"]["enabled"])
        self.assertTrue(provider_status["manualScrydexMirror"]["liveQueriesBlocked"])
        self.assertTrue(provider_status["manualScrydexMirror"]["searchesBlocked"])
        self.assertTrue(provider_status["manualScrydexMirror"]["pricingRefreshBlocked"])
        providers = {provider["providerId"]: provider for provider in provider_status["providers"]}
        self.assertTrue(providers["scrydex"]["fullCatalogSyncFresh"])
        self.assertIsNotNone(providers["scrydex"]["lastFullCatalogSyncAt"])

    def test_scrydex_request_audit_summary_tracks_runtime_sources(self) -> None:
        audit_db_path = Path(self.tempdir.name) / "scrydex-audit.sqlite"
        with patch.dict(
            os.environ,
            {
                "SPOTLIGHT_SCRYDEX_AUDIT_DB_PATH": str(audit_db_path),
                "SPOTLIGHT_RUNTIME_LABEL": "local-backend:test",
            },
            clear=False,
        ):
            store_scrydex_request_audit(
                created_at=utc_now(),
                request_type="card_by_id",
                path="/pokemon/v1/cards/base1-4",
                params={"include": "prices"},
                elapsed_ms=42.0,
                outcome="ok",
                result_count=1,
            )
        with patch.dict(
            os.environ,
            {
                "SPOTLIGHT_SCRYDEX_AUDIT_DB_PATH": str(audit_db_path),
                "SPOTLIGHT_RUNTIME_LABEL": "vm-sync:test",
            },
            clear=False,
        ):
            store_scrydex_request_audit(
                created_at=utc_now(),
                request_type="catalog_sync_all",
                path="/pokemon/v1/cards",
                params={"page_size": "100", "include": "prices"},
                elapsed_ms=155.0,
                outcome="ok",
                result_count=100,
            )
            summary = scrydex_request_audit_summary(hours=24, recent_limit=10)

        self.assertEqual(summary["todayTotal"], 2)
        self.assertEqual(summary["last24HoursTotal"], 2)
        runtime_counts = {
            row["runtimeLabel"]: row["count"]
            for row in summary["byRuntimeLabel"]
        }
        self.assertEqual(runtime_counts["local-backend:test"], 1)
        self.assertEqual(runtime_counts["vm-sync:test"], 1)
        request_type_counts = {
            row["requestType"]: row["count"]
            for row in summary["byRequestType"]
        }
        self.assertEqual(request_type_counts["card_by_id"], 1)
        self.assertEqual(request_type_counts["catalog_sync_all"], 1)
        self.assertEqual(summary["recent"][0]["runtimeLabel"], "vm-sync:test")

    def test_provider_status_includes_scrydex_audit_summary(self) -> None:
        audit_db_path = Path(self.tempdir.name) / "provider-status-audit.sqlite"
        with patch.dict(
            os.environ,
            {
                "SPOTLIGHT_SCRYDEX_AUDIT_DB_PATH": str(audit_db_path),
                "SPOTLIGHT_RUNTIME_LABEL": "local-backend:test",
            },
            clear=False,
        ):
            store_scrydex_request_audit(
                created_at=utc_now(),
                request_type="raw_price_refresh",
                path="/pokemon/v1/cards/base1-4",
                params={"include": "prices"},
                elapsed_ms=28.0,
                outcome="ok",
                result_count=1,
            )
            service = SpotlightScanService(self.database_path, REPO_ROOT)
            try:
                provider_status = service.provider_status()
            finally:
                service.connection.close()

        self.assertIn("scrydexAudit", provider_status)
        self.assertEqual(provider_status["scrydexAudit"]["todayTotal"], 1)
        self.assertEqual(provider_status["scrydexAudit"]["byRuntimeLabel"][0]["runtimeLabel"], "local-backend:test")
        self.assertEqual(provider_status["scrydexAudit"]["detailRetentionDays"], 30)

    def test_scrydex_request_audit_rolls_up_rows_older_than_30_days(self) -> None:
        audit_db_path = Path(self.tempdir.name) / "rollup-audit.sqlite"
        old_created_at = (datetime.now(timezone.utc) - timedelta(days=35)).isoformat()
        fresh_created_at = utc_now()

        with patch.dict(
            os.environ,
            {
                "SPOTLIGHT_SCRYDEX_AUDIT_DB_PATH": str(audit_db_path),
                "SPOTLIGHT_RUNTIME_LABEL": "vm-sync:test",
            },
            clear=False,
        ):
            store_scrydex_request_audit(
                created_at=old_created_at,
                request_type="catalog_sync_all",
                path="/pokemon/v1/cards",
                params={"page_size": "100", "include": "prices"},
                elapsed_ms=180.0,
                outcome="ok",
                result_count=100,
            )
            store_scrydex_request_audit(
                created_at=fresh_created_at,
                request_type="catalog_sync_all",
                path="/pokemon/v1/cards",
                params={"page_size": "100", "include": "prices"},
                elapsed_ms=190.0,
                outcome="ok",
                result_count=100,
            )
            summary = scrydex_request_audit_summary(hours=24, recent_limit=10)

        audit_connection = sqlite3.connect(audit_db_path)
        audit_connection.row_factory = sqlite3.Row
        try:
            raw_rows = audit_connection.execute(
                "SELECT COUNT(*) AS count FROM scrydex_request_audit"
            ).fetchone()["count"]
            rollup_rows = audit_connection.execute(
                """
                SELECT usage_date, runtime_label, request_type, request_count
                FROM scrydex_daily_usage_rollups
                """
            ).fetchall()
        finally:
            audit_connection.close()

        self.assertEqual(raw_rows, 1)
        self.assertEqual(len(rollup_rows), 1)
        self.assertEqual(rollup_rows[0]["runtime_label"], "vm-sync:test")
        self.assertEqual(rollup_rows[0]["request_type"], "catalog_sync_all")
        self.assertEqual(rollup_rows[0]["request_count"], 1)
        rolled_dates = {row["usageDate"] for row in summary["dailyRollups"]}
        self.assertIn(old_created_at[:10], rolled_dates)
        self.assertIn(fresh_created_at[:10], rolled_dates)

    def test_provider_status_keeps_pricing_refresh_blocked_when_full_sync_is_stale(self) -> None:
        stale_completed_at = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
        self._seed_full_catalog_sync(completed_at=stale_completed_at)

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            provider_status = service.provider_status()
        finally:
            service.connection.close()

        self.assertFalse(provider_status["scrydexFullCatalogSyncFresh"])
        self.assertTrue(provider_status["manualScrydexMirror"]["enabled"])
        self.assertTrue(provider_status["manualScrydexMirror"]["searchesBlocked"])
        self.assertFalse(provider_status["manualScrydexMirror"]["pricingRefreshAllowed"])
        self.assertTrue(provider_status["manualScrydexMirror"]["pricingRefreshBlocked"])
        self.assertTrue(provider_status["manualScrydexMirror"]["liveQueriesBlocked"])

    def test_card_show_mode_can_be_enabled_and_cleared(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            enabled = service.set_card_show_mode(duration_hours=8, note="trade night")
            disabled = service.clear_card_show_mode()
        finally:
            service.connection.close()

        self.assertTrue(enabled["active"])
        self.assertIsNotNone(enabled["until"])
        self.assertEqual(enabled["note"], "trade night")
        self.assertFalse(disabled["active"])
        self.assertIsNone(disabled["until"])

    def test_provider_status_card_show_mode_does_not_reopen_pricing_refresh_under_manual_mirror(self) -> None:
        self._seed_full_catalog_sync()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            service.set_card_show_mode(duration_hours=8, note="show floor")
            provider_status = service.provider_status()
        finally:
            service.connection.close()

        self.assertTrue(provider_status["scrydexFullCatalogSyncFresh"])
        self.assertTrue(provider_status["cardShowMode"]["active"])
        self.assertTrue(provider_status["manualScrydexMirror"]["searchesBlocked"])
        self.assertFalse(provider_status["manualScrydexMirror"]["pricingRefreshAllowed"])
        self.assertTrue(provider_status["manualScrydexMirror"]["pricingRefreshBlocked"])

    def test_refresh_card_pricing_skips_live_raw_refresh_when_manual_mirror_sync_is_fresh(self) -> None:
        self._assert_refresh_card_pricing_blocked(
            completed_at=utc_now(),
            grader=None,
            grade=None,
            force_refresh=True,
            show_mode=False,
            refresh_method_name="refresh_raw_pricing",
        )

    def test_refresh_card_pricing_skips_live_slab_refresh_when_manual_mirror_sync_is_fresh(self) -> None:
        self._assert_refresh_card_pricing_blocked(
            completed_at=utc_now(),
            grader="PSA",
            grade="9",
            force_refresh=True,
            show_mode=False,
            refresh_method_name="refresh_psa_pricing",
        )

    def test_refresh_card_pricing_skips_live_raw_refresh_when_card_show_mode_is_active_under_manual_mirror(self) -> None:
        self._assert_refresh_card_pricing_blocked(
            completed_at=utc_now(),
            grader=None,
            grade=None,
            force_refresh=False,
            show_mode=True,
            refresh_method_name="refresh_raw_pricing",
        )

    def test_refresh_card_pricing_skips_live_raw_refresh_when_manual_mirror_sync_is_stale(self) -> None:
        stale_completed_at = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
        self._assert_refresh_card_pricing_blocked(
            completed_at=stale_completed_at,
            grader=None,
            grade=None,
            force_refresh=True,
            show_mode=False,
            refresh_method_name="refresh_raw_pricing",
        )

    def test_refresh_card_pricing_skips_live_slab_refresh_when_manual_mirror_sync_is_stale(self) -> None:
        stale_completed_at = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
        self._assert_refresh_card_pricing_blocked(
            completed_at=stale_completed_at,
            grader="PSA",
            grade="9",
            force_refresh=True,
            show_mode=False,
            refresh_method_name="refresh_psa_pricing",
        )

    def test_hydrate_candidate_pricing_skips_live_refresh_when_card_show_mode_is_active_under_manual_mirror(self) -> None:
        upsert_price_snapshot(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="normal",
            low_price=100.0,
            market_price=120.0,
            mid_price=115.0,
            high_price=140.0,
            source_url="https://prices.example/raw",
            payload={"provider": "scrydex"},
        )
        self.connection.commit()

        run_id = start_provider_sync_run(
            self.connection,
            provider="scrydex",
            sync_scope="raw_catalog_full",
            page_size=100,
        )
        update_provider_sync_run(
            self.connection,
            run_id,
            status=PROVIDER_SYNC_STATUS_SUCCEEDED,
            completed_at=utc_now(),
            pages_fetched=203,
            cards_seen=20237,
            cards_upserted=20237,
            raw_snapshots_upserted=20237,
            graded_snapshots_upserted=51000,
            estimated_credits_used=203,
        )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        service.set_card_show_mode(duration_hours=8)
        scrydex_provider = service.pricing_registry.get_provider("scrydex")
        assert scrydex_provider is not None
        scrydex_provider.refresh_raw_pricing = Mock(return_value=Mock(success=True))  # type: ignore[method-assign]
        try:
            payload = service.hydrate_raw_candidate_pricing(["base1-4"], max_refresh_count=1)
        finally:
            service.connection.close()

        scrydex_provider.refresh_raw_pricing.assert_not_called()
        self.assertEqual(payload["refreshedCount"], 0)
        self.assertEqual(payload["returnedCount"], 1)

    def test_run_manual_scrydex_sync_reuses_current_database_path(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            with patch(
                "sync_scrydex_catalog.sync_scrydex_catalog",
                return_value={"runID": "sync-1", "pagesFetched": 1},
            ) as sync_catalog:
                summary = service.run_manual_scrydex_sync(
                    page_size=25,
                    max_pages=2,
                    language="ja",
                    scheduled_for="2026-04-13T03:00:00-07:00",
                )
        finally:
            service.connection.close()

        sync_catalog.assert_called_once_with(
            database_path=self.database_path,
            repo_root=REPO_ROOT,
            page_size=25,
            language="ja",
            max_pages=2,
            scheduled_for="2026-04-13T03:00:00-07:00",
        )
        self.assertEqual(summary["runID"], "sync-1")
        self.assertTrue(summary["manualScrydexMirror"]["enabled"])

    def test_sync_scrydex_catalog_retries_sqlite_lock_errors(self) -> None:
        with patch(
            "sync_scrydex_catalog._sync_scrydex_catalog_once",
            side_effect=[
                sqlite3.OperationalError("database is locked"),
                {"runID": "sync-1", "pagesFetched": 1},
            ],
        ) as sync_once, patch("sync_scrydex_catalog.time.sleep") as sleep:
            summary = sync_scrydex_catalog(
                database_path=self.database_path,
                repo_root=REPO_ROOT,
                page_size=25,
                language="ja",
                max_pages=2,
                scheduled_for="2026-04-15T10:00:00Z",
            )

        self.assertEqual(sync_once.call_count, 2)
        sleep.assert_called_once()
        self.assertEqual(summary["runID"], "sync-1")

    def test_sync_scrydex_catalog_does_not_retry_non_lock_errors(self) -> None:
        with patch(
            "sync_scrydex_catalog._sync_scrydex_catalog_once",
            side_effect=sqlite3.OperationalError("no such table: provider_sync_runs"),
        ) as sync_once, patch("sync_scrydex_catalog.time.sleep") as sleep:
            with self.assertRaises(sqlite3.OperationalError):
                sync_scrydex_catalog(
                    database_path=self.database_path,
                    repo_root=REPO_ROOT,
                    page_size=25,
                    language="ja",
                    max_pages=2,
                    scheduled_for="2026-04-15T10:00:00Z",
                )

        self.assertEqual(sync_once.call_count, 1)
        sleep.assert_not_called()

    def test_fetch_scrydex_cards_page_uses_longer_catalog_sync_timeout(self) -> None:
        with patch("scrydex_adapter.scrydex_api_request", return_value={"data": []}) as api_request:
            cards = fetch_scrydex_cards_page(page=1, page_size=100, include_prices=True)

        self.assertEqual(cards, [])
        self.assertEqual(DEFAULT_CATALOG_SYNC_TIMEOUT_SECONDS, 30)
        api_request.assert_called_once()
        self.assertEqual(api_request.call_args.kwargs["timeout"], 30)

    def test_sync_scrydex_catalog_retries_transient_page_timeout_on_same_page(self) -> None:
        sync_payload = [
            {
                "id": "xy1-2",
                "name": "Ivysaur",
                "language_code": "en",
                "printed_number": "2",
                "number": "2",
                "rarity": "Uncommon",
                "expansion": {
                    "id": "xy1",
                    "name": "XY",
                    "series": "XY",
                    "language": "en",
                },
                "images": [],
                "variants": [],
            }
        ]

        with patch.dict(
            os.environ,
            {"SCRYDEX_API_KEY": "scrydex-key", "SCRYDEX_TEAM_ID": "team-id"},
            clear=False,
        ), patch(
            "sync_scrydex_catalog.fetch_scrydex_cards_page",
            side_effect=[TimeoutError("The read operation timed out"), sync_payload],
        ) as fetch_page, patch("sync_scrydex_catalog.random.uniform", return_value=0.0), patch(
            "sync_scrydex_catalog.time.sleep"
        ) as sleep:
            summary = sync_scrydex_catalog(
                database_path=self.database_path,
                repo_root=REPO_ROOT,
                page_size=1,
                max_pages=1,
            )

        self.assertEqual(fetch_page.call_count, 2)
        self.assertEqual([call.kwargs["page"] for call in fetch_page.call_args_list], [1, 1])
        sleep.assert_called_once_with(2.0)
        self.assertEqual(summary["pagesFetched"], 1)
        self.assertEqual(summary["cardsSeen"], 1)
        self.assertEqual(summary["estimatedCreditsUsed"], 1)

    def test_sync_scrydex_catalog_fails_after_transient_page_retries_are_exhausted(self) -> None:
        with patch.dict(
            os.environ,
            {"SCRYDEX_API_KEY": "scrydex-key", "SCRYDEX_TEAM_ID": "team-id"},
            clear=False,
        ), patch(
            "sync_scrydex_catalog.fetch_scrydex_cards_page",
            side_effect=TimeoutError("The read operation timed out"),
        ) as fetch_page, patch("sync_scrydex_catalog.random.uniform", return_value=0.0), patch(
            "sync_scrydex_catalog.time.sleep"
        ) as sleep:
            with self.assertRaises(TimeoutError):
                sync_scrydex_catalog(
                    database_path=self.database_path,
                    repo_root=REPO_ROOT,
                    page_size=100,
                    max_pages=1,
                )

        self.assertEqual(fetch_page.call_count, 5)
        self.assertEqual([call.kwargs["page"] for call in fetch_page.call_args_list], [1, 1, 1, 1, 1])
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2.0, 4.0, 8.0, 16.0])

        sync_row = self.connection.execute(
            """
            SELECT status, pages_fetched, cards_seen, estimated_credits_used, error_text
            FROM provider_sync_runs
            ORDER BY started_at DESC
            LIMIT 1
            """
        ).fetchone()
        self.assertIsNotNone(sync_row)
        assert sync_row is not None
        self.assertEqual(sync_row["status"], "failed")
        self.assertEqual(sync_row["pages_fetched"], 0)
        self.assertEqual(sync_row["cards_seen"], 0)
        self.assertEqual(sync_row["estimated_credits_used"], 0)
        self.assertIn("timed out", sync_row["error_text"])

    def test_persist_scrydex_all_graded_snapshots_writes_multiple_grade_rows(self) -> None:
        payload = {
            "id": "base1-4",
            "name": "Charizard",
            "expansion": {"name": "Base Set"},
            "variants": [
                {
                    "name": "unlimited",
                    "prices": [
                        {
                            "type": "graded",
                            "company": "PSA",
                            "grade": "8",
                            "currency": "USD",
                            "market": 700.0,
                            "mid": 690.0,
                        },
                        {
                            "type": "graded",
                            "company": "PSA",
                            "grade": "9",
                            "currency": "USD",
                            "market": 1200.0,
                            "mid": 1180.0,
                        },
                    ],
                },
                {
                    "name": "1stEdition",
                    "prices": [
                        {
                            "type": "graded",
                            "company": "BGS",
                            "grade": "9.5",
                            "currency": "USD",
                            "market": 4500.0,
                            "mid": 4400.0,
                        }
                    ],
                },
            ],
        }

        persisted = persist_scrydex_all_graded_snapshots(
            self.connection,
            card_id="base1-4",
            payload=payload,
            commit=False,
        )
        self.connection.commit()

        row_count = self.connection.execute(
            "SELECT COUNT(*) AS count FROM card_price_snapshots WHERE card_id = ?",
            ("base1-4",),
        ).fetchone()["count"]
        psa8 = price_snapshot_for_card(
            self.connection,
            "base1-4",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            grader="PSA",
            grade="8",
        )
        psa9 = price_snapshot_for_card(
            self.connection,
            "base1-4",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            grader="PSA",
            grade="9",
        )
        bgs95 = price_snapshot_for_card(
            self.connection,
            "base1-4",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            grader="BGS",
            grade="9.5",
        )

        self.assertEqual(persisted, 3)
        self.assertEqual(row_count, 1)
        self.assertEqual((bgs95 or {})["market"], 4500.0)
        self.assertEqual((psa8 or {})["market"], 700.0)
        self.assertEqual((psa9 or {})["market"], 1200.0)

    def test_backend_env_loader_falls_back_without_python_dotenv(self) -> None:
        env_path = Path(self.tempdir.name) / "backend.env"
        env_path.write_text(
            "\n".join(
                [
                    "# comment",
                    "SCRYDEX_TEAM_ID=team-id",
                    "export SCRYDEX_API_KEY='scrydex-key'",
                    'PRICECHARTING_API_KEY="quoted-value"',
                ]
            ),
            encoding="utf-8",
        )

        with patch.dict(
            os.environ,
            {
                "SCRYDEX_API_KEY": "existing-scrydex-key",
            },
            clear=True,
        ), patch("builtins.__import__", side_effect=self._import_without_dotenv):
            _load_backend_env_file(env_path)
            self.assertEqual(os.environ["SCRYDEX_TEAM_ID"], "team-id")
            self.assertEqual(os.environ["SCRYDEX_API_KEY"], "existing-scrydex-key")
            self.assertEqual(os.environ["PRICECHARTING_API_KEY"], "quoted-value")

    def test_raw_candidate_payload_skips_live_refresh_when_full_sync_is_fresh(self) -> None:
        run_id = start_provider_sync_run(
            self.connection,
            provider="scrydex",
            sync_scope="raw_catalog_full",
            page_size=100,
        )
        update_provider_sync_run(
            self.connection,
            run_id,
            status=PROVIDER_SYNC_STATUS_SUCCEEDED,
            completed_at=utc_now(),
            pages_fetched=203,
            cards_seen=20237,
            cards_upserted=20237,
            raw_snapshots_upserted=20237,
            graded_snapshots_upserted=51000,
            estimated_credits_used=203,
        )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        candidate = {
            "id": "missing-price-card",
            "name": "Test Card",
            "setName": "Test Set",
            "number": "1/1",
            "rarity": "Rare",
            "variant": "Raw",
            "language": "English",
            "imageSmallURL": "https://images.example/test-card-small.png",
            "imageURL": "https://images.example/test-card-large.png",
            "sourceProvider": "scrydex",
            "sourceRecordID": "missing-price-card",
            "setID": "test1",
            "setSeries": "Test",
            "setPtcgoCode": "TST",
            "sourcePayload": {},
        }

        try:
            with patch.object(service, "_refresh_card_pricing_for_context", side_effect=AssertionError("live refresh should not run")):
                payload = service._candidate_payload(
                    candidate,
                    pricing_context=service._raw_pricing_context(),
                    trigger_source="scan_match_raw",
                    ensure_cached=False,
                    refresh_pricing_if_stale=True,
                )
            self.assertNotIn("pricing", payload)
        finally:
            service.connection.close()

    def test_raw_candidate_payload_handles_missing_raw_price_summary_without_crashing(self) -> None:
        upsert_price_snapshot(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="normal",
            market_price=120.0,
            source_url="https://prices.example/base1-4",
            payload={"provider": "scrydex"},
        )
        self.connection.execute(
            """
            UPDATE card_price_snapshots
            SET raw_contexts_json = ?,
                default_raw_low_price = NULL,
                default_raw_market_price = NULL,
                default_raw_mid_price = NULL,
                default_raw_high_price = NULL,
                default_raw_direct_low_price = NULL,
                default_raw_trend_price = NULL
            WHERE card_id = ?
            """,
            (json.dumps({"variants": {}}), "base1-4"),
        )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        candidate = {
            "id": "base1-4",
            "name": "Charizard",
            "setName": "Base Set",
            "number": "4/102",
            "rarity": "Rare Holo",
            "variant": "Raw",
            "language": "English",
        }

        try:
            snapshot = price_snapshot_for_card(
                service.connection,
                "base1-4",
                pricing_mode=RAW_PRICING_MODE,
            )
            payload = service._candidate_payload(
                candidate,
                pricing_context=service._raw_pricing_context(),
                trigger_source="scan_match_raw",
            )
        finally:
            service.connection.close()

        self.assertIsNone(snapshot)
        self.assertEqual(payload["id"], "base1-4")
        self.assertIsNone(payload.get("pricing"))

    def test_hydrate_raw_candidate_pricing_refreshes_only_missing_or_stale_candidates_up_to_budget(self) -> None:
        upsert_card(
            self.connection,
            card_id="base1-25",
            name="Pikachu",
            set_name="Base Set",
            number="25/102",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="base1-25",
            set_id="base1",
            set_series="Base",
            supertype="Pokemon",
        )
        upsert_card(
            self.connection,
            card_id="base1-39",
            name="Jigglypuff",
            set_name="Base Set",
            number="39/102",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="base1-39",
            set_id="base1",
            set_series="Base",
            supertype="Pokemon",
        )
        upsert_price_snapshot(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="holofoil",
            market_price=150.0,
            source_url="https://prices.example/base1-4",
            payload={"provider": "scrydex"},
        )
        upsert_price_snapshot(
            self.connection,
            card_id="base1-25",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="normal",
            market_price=12.0,
            source_url="https://prices.example/base1-25",
            payload={"provider": "scrydex"},
        )
        self.connection.execute(
            "UPDATE card_price_snapshots SET updated_at = ? WHERE card_id = ?",
            ("2026-04-10T00:00:00+00:00", "base1-25"),
        )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        refreshed_cards: list[str] = []
        service.set_live_pricing_mode(enabled=True)

        def fake_refresh(card_id: str, *, pricing_context, **_: object) -> dict[str, object] | None:
            refreshed_cards.append(card_id)
            upsert_price_snapshot(
                service.connection,
                card_id=card_id,
                pricing_mode=RAW_PRICING_MODE,
                provider="scrydex",
                currency_code="USD",
                variant="normal",
                market_price=33.0 if card_id == "base1-25" else 7.0,
                source_url=f"https://prices.example/{card_id}",
                payload={"provider": "scrydex"},
            )
            service.connection.commit()
            return service._card_detail_for_context(card_id, pricing_context=pricing_context)

        try:
            with patch.object(service, "_refresh_card_pricing_for_context", side_effect=fake_refresh):
                payload = service.hydrate_raw_candidate_pricing(
                    ["base1-4", "base1-25", "base1-39"],
                    max_refresh_count=1,
                )
        finally:
            service.connection.close()

        details_by_id = {entry["card"]["id"]: entry for entry in payload["cards"]}

        self.assertEqual(payload["requestedCount"], 3)
        self.assertEqual(payload["returnedCount"], 3)
        self.assertEqual(payload["refreshedCount"], 1)
        self.assertEqual(refreshed_cards, ["base1-25"])
        self.assertIsNotNone(details_by_id["base1-4"]["card"]["pricing"])
        self.assertIsNotNone(details_by_id["base1-25"]["card"]["pricing"])
        self.assertIsNone(details_by_id["base1-39"]["card"]["pricing"])

    def test_hydrate_raw_candidate_pricing_uses_slab_context_for_exact_grade_refresh(self) -> None:
        upsert_card(
            self.connection,
            card_id="base1-25",
            name="Pikachu",
            set_name="Base Set",
            number="25/102",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="base1-25",
            set_id="base1",
            set_series="Base",
            supertype="Pokemon",
        )
        upsert_slab_price_snapshot(
            self.connection,
            card_id="base1-4",
            grader="PSA",
            grade="9",
            pricing_tier="scrydex_exact_grade",
            currency_code="USD",
            low_price=900.0,
            market_price=1000.0,
            mid_price=980.0,
            high_price=1100.0,
            last_sale_price=None,
            last_sale_date=None,
            comp_count=0,
            recent_comp_count=0,
            confidence_level=4,
            confidence_label="High",
            bucket_key=None,
            source_url="https://scrydex.example/base1-4",
            source="scrydex",
            summary="Scrydex exact PSA 9 market snapshot.",
            payload={"provider": "scrydex"},
        )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        refresh_calls: list[tuple[str, dict[str, object]]] = []
        service.set_live_pricing_mode(enabled=True)

        def fake_refresh(card_id: str, *, pricing_context, **kwargs: object) -> dict[str, object] | None:
            refresh_calls.append((card_id, {"pricing_context": pricing_context, **kwargs}))
            upsert_slab_price_snapshot(
                service.connection,
                card_id=card_id,
                grader=str(pricing_context.grader or ""),
                grade=str(pricing_context.grade or ""),
                pricing_tier="scrydex_exact_grade",
                currency_code="USD",
                low_price=120.0,
                market_price=140.0,
                mid_price=130.0,
                high_price=150.0,
                last_sale_price=None,
                last_sale_date=None,
                comp_count=0,
                recent_comp_count=0,
                confidence_level=4,
                confidence_label="High",
                bucket_key=None,
                source_url=f"https://scrydex.example/{card_id}",
                source="scrydex",
                summary="Scrydex exact PSA 9 market snapshot.",
                payload={"provider": "scrydex"},
            )
            service.connection.commit()
            return service._card_detail_for_context(
                card_id,
                pricing_context=pricing_context,
            )

        try:
            with patch.object(service, "_refresh_card_pricing_for_context", side_effect=fake_refresh):
                payload = service.hydrate_raw_candidate_pricing(
                    ["base1-4", "base1-25"],
                    max_refresh_count=1,
                    grader="PSA",
                    grade="9",
                    cert_number="12345678",
                )
        finally:
            service.connection.close()

        details_by_id = {entry["card"]["id"]: entry for entry in payload["cards"]}

        self.assertEqual(payload["requestedCount"], 2)
        self.assertEqual(payload["returnedCount"], 2)
        self.assertEqual(payload["refreshedCount"], 1)
        self.assertEqual(len(refresh_calls), 1)
        self.assertEqual(refresh_calls[0][0], "base1-25")
        pricing_context = refresh_calls[0][1]["pricing_context"]
        self.assertEqual(pricing_context.grader, "PSA")
        self.assertEqual(pricing_context.grade, "9")
        self.assertEqual(pricing_context.cert_number, "12345678")
        self.assertIsNone(pricing_context.preferred_variant)
        self.assertEqual(details_by_id["base1-25"]["slabContext"]["grader"], "PSA")
        self.assertEqual(details_by_id["base1-25"]["slabContext"]["grade"], "9")
        self.assertIsNotNone(details_by_id["base1-25"]["card"]["pricing"])

    def test_sync_scrydex_catalog_persists_one_page_of_raw_and_graded_prices(self) -> None:
        sync_payload = [
            {
                "id": "xy1-1",
                "name": "Venusaur-EX",
                "language_code": "en",
                "printed_number": "1",
                "number": "1",
                "rarity": "Ultra Rare",
                "artist": "5ban Graphics",
                "supertype": "Pokemon",
                "subtypes": ["Basic", "EX"],
                "types": ["Grass"],
                "expansion": {
                    "id": "xy1",
                    "name": "XY",
                    "code": "XY",
                    "series": "XY",
                    "release_date": "2014-02-05",
                    "language": "en",
                },
                "images": [
                    {
                        "type": "front",
                        "small": "https://images.scrydex.example/cards/xy1-1/small",
                        "large": "https://images.scrydex.example/cards/xy1-1/large",
                    }
                ],
                "variants": [
                    {
                        "name": "Unlimited",
                        "prices": [
                            {
                                "type": "raw",
                                "condition": "NM",
                                "currency": "USD",
                                "market": 24.5,
                                "mid": 23.0,
                                "low": 21.0,
                                "high": 29.0,
                            },
                            {
                                "type": "graded",
                                "company": "PSA",
                                "grade": "9",
                                "currency": "USD",
                                "market": 135.0,
                                "mid": 130.0,
                            },
                        ],
                    }
                ],
            }
        ]

        with patch.dict(
            os.environ,
            {"SCRYDEX_API_KEY": "scrydex-key", "SCRYDEX_TEAM_ID": "team-id"},
            clear=False,
        ), patch("sync_scrydex_catalog.fetch_scrydex_cards_page", return_value=sync_payload) as fetch_page:
            summary = sync_scrydex_catalog(
                database_path=self.database_path,
                repo_root=REPO_ROOT,
                page_size=1,
                max_pages=1,
                price_date="2026-04-28",
            )

        fetch_page.assert_called_once_with(
            page=1,
            page_size=1,
            include_prices=True,
            language=None,
            request_type="catalog_sync_all",
        )
        self.assertEqual(summary["pagesFetched"], 1)
        self.assertEqual(summary["cardsSeen"], 1)
        self.assertEqual(summary["cardsUpserted"], 1)
        self.assertEqual(summary["rawSnapshotsUpserted"], 1)
        self.assertEqual(summary["gradedSnapshotsUpserted"], 1)
        self.assertEqual(summary["estimatedCreditsUsed"], 1)
        self.assertEqual(summary["priceDate"], "2026-04-28")

        card_row = self.connection.execute(
            "SELECT id, image_small_url, image_url FROM cards WHERE id = ?",
            ("xy1-1",),
        ).fetchone()
        self.assertIsNotNone(card_row)
        self.assertEqual(card_row["image_small_url"], "https://images.scrydex.example/cards/xy1-1/small")
        self.assertEqual(card_row["image_url"], "https://images.scrydex.example/cards/xy1-1/large")

        history_row = self.connection.execute(
            "SELECT card_id, price_date, default_raw_market_price FROM card_price_history_daily WHERE card_id = ?",
            ("xy1-1",),
        ).fetchone()
        self.assertIsNotNone(history_row)
        assert history_row is not None
        self.assertEqual(history_row["price_date"], "2026-04-28")
        self.assertEqual(history_row["default_raw_market_price"], 24.5)

        snapshot_count = self.connection.execute(
            "SELECT COUNT(*) AS count FROM card_price_snapshots WHERE card_id = ?",
            ("xy1-1",),
        ).fetchone()["count"]
        raw_snapshot = price_snapshot_for_card(
            self.connection,
            "xy1-1",
            pricing_mode=RAW_PRICING_MODE,
        )
        graded_snapshot = price_snapshot_for_card(
            self.connection,
            "xy1-1",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            grader="PSA",
            grade="9",
        )
        self.assertEqual(snapshot_count, 1)
        self.assertEqual((raw_snapshot or {})["provider"], "scrydex")
        self.assertEqual((graded_snapshot or {})["provider"], "scrydex")
        self.assertEqual((graded_snapshot or {})["grade"], "9")

        sync_run = self.connection.execute(
            """
            SELECT status, pages_fetched, cards_seen, raw_snapshots_upserted, graded_snapshots_upserted
            FROM provider_sync_runs
            ORDER BY started_at DESC
            LIMIT 1
            """
        ).fetchone()
        self.assertEqual(sync_run["status"], PROVIDER_SYNC_STATUS_SUCCEEDED)
        self.assertEqual(sync_run["pages_fetched"], 1)
        self.assertEqual(sync_run["cards_seen"], 1)
        self.assertEqual(sync_run["raw_snapshots_upserted"], 1)
        self.assertEqual(sync_run["graded_snapshots_upserted"], 1)

    def test_raw_candidate_payload_uses_cached_snapshot_only_under_manual_mirror(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        candidate = {
            "id": "svp-194",
            "name": "Iono's Bellibolt ex",
            "setName": "Scarlet & Violet Promotional Cards",
            "number": "194",
            "rarity": "Promo",
            "variant": "Raw",
            "language": "Japanese",
            "imageSmallURL": "https://images.example/svp-194-small.png",
            "imageURL": "https://images.example/svp-194-large.png",
            "sourceProvider": "scrydex",
            "sourceRecordID": "svp-194",
            "setID": "svp_ja",
            "setSeries": "Scarlet & Violet",
            "setPtcgoCode": "SVP",
            "sourcePayload": {},
        }
        scrydex_payload = {
            "id": "svp-194",
            "name": "ナンジャモのハラバリーex",
            "language_code": "ja",
            "printed_number": "194",
            "number": "194",
            "rarity": "SR",
            "artist": "DOM",
            "supertype": "Pokémon",
            "subtypes": ["Basic", "ex"],
            "types": ["Lightning"],
            "expansion": {
                "id": "svp_ja",
                "name": "Scarlet & Violet Promotional Cards",
                "code": "SVP",
                "series": "Scarlet & Violet",
                "release_date": "2026-01-01",
                "language": "ja",
            },
            "translation": {
                "en": {
                    "name": "Iono's Bellibolt ex",
                    "rarity": "Special Illustration Rare",
                    "supertype": "Pokémon",
                    "subtypes": ["Basic", "ex"],
                    "types": ["Lightning"],
                }
            },
            "images": [
                {
                    "type": "front",
                    "small": "https://images.example/svp-194-small.png",
                    "large": "https://images.example/svp-194-large.png",
                }
            ],
            "variants": [
                {
                    "name": "raw",
                    "prices": [
                        {
                            "type": "raw",
                            "condition": "NM",
                            "currency": "USD",
                            "market": 14.25,
                            "mid": 13.75,
                            "low": 12.5,
                            "high": 16.0,
                            "trends": {"days_30": {"price_change": 0.5}},
                        }
                    ],
                }
            ],
        }
        upsert_card(
            self.connection,
            card_id="svp-194",
            name="Iono's Bellibolt ex",
            set_name="Scarlet & Violet Promotional Cards",
            number="194",
            rarity="Promo",
            variant="Raw",
            language="Japanese",
            source_provider="scrydex",
            source_record_id="svp-194",
            set_id="svp_ja",
            set_series="Scarlet & Violet",
            supertype="Pokemon",
        )
        upsert_price_snapshot(
            self.connection,
            card_id="svp-194",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="normal",
            market_price=10.0,
            source_url="https://prices.example/svp-194",
            payload={"provider": "scrydex"},
        )
        self.connection.execute(
            "UPDATE card_price_snapshots SET updated_at = ? WHERE card_id = ?",
            ("2026-04-10T00:00:00+00:00", "svp-194"),
        )
        self.connection.commit()

        reset_scrydex_request_stats()
        try:
            with patch.dict(
                os.environ,
                {"SCRYDEX_API_KEY": "scrydex-key", "SCRYDEX_TEAM_ID": "team-id"},
                clear=False,
            ), patch("scrydex_adapter.fetch_scrydex_card_by_id", return_value=scrydex_payload) as fetch_card:
                first_payload = service._candidate_payload(
                    candidate,
                    pricing_context=service._raw_pricing_context(),
                    trigger_source="scan_match_raw",
                    ensure_cached=True,
                    refresh_pricing_if_stale=True,
                )
                second_payload = service._candidate_payload(
                    candidate,
                    pricing_context=service._raw_pricing_context(),
                    trigger_source="scan_match_raw",
                    ensure_cached=True,
                    refresh_pricing_if_stale=True,
                )

            self.assertEqual(fetch_card.call_count, 0)
            self.assertIsNotNone(first_payload.get("pricing"))
            self.assertIsNotNone(second_payload.get("pricing"))
        finally:
            service.connection.close()

    def test_top_ten_pricing_policies_have_explicit_rank_rules(self) -> None:
        cases = [
            (
                "live_refresh",
                PricingLoadPolicy.top_ten_refresh_top_one(
                    refresh_top_candidate_stale=True,
                    refresh_top_candidate_missing=True,
                    force_show_mode_top_candidate_refresh=True,
                ),
                (False, True, True, True),
            ),
            ("cached_only", PricingLoadPolicy.top_ten_cached_only(), (False, False, False, False)),
        ]

        for case_name, policy, expected_rule in cases:
            with self.subTest(case_name):
                self.assertEqual(policy.limit, 10)
                self.assertEqual(self._policy_rule_matrix(policy), [expected_rule] * 10)

    def test_scan_candidate_pricing_policy_respects_live_pricing_gate(self) -> None:
        cases = [
            ("disabled", False, (False, False, False, False)),
            ("enabled", True, (False, True, True, True)),
        ]

        for case_name, enabled, expected_rule in cases:
            with self.subTest(case_name):
                service = SpotlightScanService(self.database_path, REPO_ROOT)
                try:
                    if enabled:
                        service.set_live_pricing_mode(enabled=True)
                    policy = service._scan_candidate_pricing_policy(
                        refresh_top_candidate_stale=True,
                        refresh_top_candidate_missing=True,
                        force_show_mode_top_candidate_refresh=True,
                    )
                finally:
                    service.connection.close()

                self.assertEqual(self._policy_rule_matrix(policy), [expected_rule] * 10)

    def test_hydrate_raw_candidate_pricing_with_zero_refresh_budget_uses_sqlite_only_even_when_live_pricing_is_enabled(self) -> None:
        upsert_price_snapshot(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="normal",
            low_price=100.0,
            market_price=120.0,
            mid_price=115.0,
            high_price=140.0,
            source_url="https://prices.example/raw",
            payload={"provider": "scrydex"},
        )
        self.connection.execute(
            "UPDATE card_price_snapshots SET updated_at = ? WHERE card_id = ?",
            ("2026-04-10T00:00:00+00:00", "base1-4"),
        )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            service.set_live_pricing_mode(enabled=True)
            with patch.object(
                service,
                "_refresh_card_pricing_for_context",
                side_effect=AssertionError("live refresh should not run"),
            ):
                payload = service.hydrate_raw_candidate_pricing(["base1-4"], max_refresh_count=0)
        finally:
            service.connection.close()

        self.assertEqual(payload["refreshedCount"], 0)
        self.assertEqual(payload["returnedCount"], 1)
        self.assertEqual(payload["cards"][0]["card"]["id"], "base1-4")

    def test_persist_scrydex_daily_history_from_card_payload_writes_raw_and_graded_rows(self) -> None:
        counts = persist_scrydex_daily_history_from_card_payload(
            self.connection,
            card_id="base1-4",
            payload={
                "data": {
                    "variants": [
                        {
                            "name": "holofoil",
                            "prices": [
                                {
                                    "type": "raw",
                                    "condition": "NM",
                                    "currency": "USD",
                                    "low": 100.0,
                                    "market": 120.0,
                                    "mid": 115.0,
                                    "high": 140.0,
                                },
                                {
                                    "type": "graded",
                                    "company": "PSA",
                                    "grade": "9",
                                    "currency": "USD",
                                    "low": 900.0,
                                    "market": 1000.0,
                                    "mid": 980.0,
                                    "high": 1100.0,
                                },
                            ],
                        }
                    ]
                }
            },
            price_date="2026-04-14",
            commit=False,
        )
        self.connection.commit()

        row_count = self.connection.execute(
            "SELECT COUNT(*) AS count FROM card_price_history_daily WHERE card_id = ?",
            ("base1-4",),
        ).fetchone()["count"]
        raw_rows = price_history_rows_for_card(
            self.connection,
            "base1-4",
            provider="scrydex",
            days=30,
            pricing_mode=RAW_PRICING_MODE,
            variant="Holofoil",
            condition="NM",
        )
        graded_rows = price_history_rows_for_card(
            self.connection,
            "base1-4",
            provider="scrydex",
            days=30,
            pricing_mode=PSA_GRADE_PRICING_MODE,
            grader="PSA",
            grade="9",
        )

        self.assertEqual(counts, {"rawCount": 1, "gradedCount": 1})
        self.assertEqual(row_count, 1)
        self.assertEqual(len(raw_rows), 1)
        self.assertEqual(len(graded_rows), 1)
        self.assertEqual(raw_rows[0]["variant"], "Holofoil")
        self.assertEqual(raw_rows[0]["condition"], "NM")
        self.assertEqual(raw_rows[0]["market"], 120.0)
        self.assertEqual(graded_rows[0]["grader"], "PSA")
        self.assertEqual(graded_rows[0]["grade"], "9")
        self.assertEqual(graded_rows[0]["market"], 1000.0)

    def test_card_market_history_returns_raw_points_and_deltas_from_sqlite(self) -> None:
        upsert_price_snapshot(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="Holofoil",
            condition="NM",
            low_price=14.0,
            market_price=15.0,
            mid_price=15.0,
            high_price=16.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        upsert_price_history_daily(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            price_date="2026-04-01",
            currency_code="USD",
            variant="Holofoil",
            condition="NM",
            low_price=9.0,
            market_price=10.0,
            mid_price=10.0,
            high_price=11.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        upsert_price_history_daily(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            price_date="2026-04-07",
            currency_code="USD",
            variant="Holofoil",
            condition="NM",
            low_price=11.0,
            market_price=12.0,
            mid_price=12.0,
            high_price=13.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        upsert_price_history_daily(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            price_date="2026-04-14",
            currency_code="USD",
            variant="Holofoil",
            condition="NM",
            low_price=14.0,
            market_price=15.0,
            mid_price=15.0,
            high_price=16.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            payload = service.card_market_history("base1-4", days=30)
        finally:
            service.connection.close()

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["pricingMode"], "raw")
        self.assertEqual(payload["selectedVariant"], "Holofoil")
        self.assertEqual(payload["selectedCondition"], "NM")
        self.assertEqual(len(payload["points"]), 3)
        self.assertEqual(payload["points"][0]["date"], "2026-04-01")
        self.assertEqual(payload["points"][-1]["date"], "2026-04-14")
        self.assertEqual(payload["currentPrice"], 15.0)
        self.assertEqual(payload["availableConditions"], [{"id": "NM", "label": "NM", "currentPrice": 15.0}])
        self.assertAlmostEqual(payload["deltas"]["days7"]["priceChange"], 3.0)
        self.assertAlmostEqual(payload["deltas"]["days7"]["percentChange"], 25.0)
        self.assertAlmostEqual(payload["deltas"]["days30"]["priceChange"], 5.0)
        self.assertAlmostEqual(payload["deltas"]["days30"]["percentChange"], 50.0)

    def test_card_market_history_returns_graded_points_from_sqlite(self) -> None:
        upsert_price_snapshot(
            self.connection,
            card_id="base1-4",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="Holofoil",
            grader="PSA",
            grade="10",
            low_price=1080.0,
            market_price=1125.0,
            mid_price=1125.0,
            high_price=1180.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        upsert_price_history_daily(
            self.connection,
            card_id="base1-4",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider="scrydex",
            price_date="2026-04-01",
            currency_code="USD",
            variant="Holofoil",
            grader="PSA",
            grade="10",
            low_price=900.0,
            market_price=950.0,
            mid_price=950.0,
            high_price=1000.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        upsert_price_history_daily(
            self.connection,
            card_id="base1-4",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider="scrydex",
            price_date="2026-04-14",
            currency_code="USD",
            variant="Holofoil",
            grader="PSA",
            grade="10",
            low_price=1080.0,
            market_price=1125.0,
            mid_price=1125.0,
            high_price=1180.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        self.connection.commit()

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            payload = service.card_market_history("base1-4", days=30, grader="PSA", grade="10")
        finally:
            service.connection.close()

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["pricingMode"], "graded")
        self.assertEqual(payload["selectedVariant"], "Holofoil")
        self.assertEqual(len(payload["points"]), 2)
        self.assertEqual(payload["currentPrice"], 1125.0)
        self.assertEqual(payload["availableConditions"], [])
        self.assertAlmostEqual(payload["deltas"]["days30"]["priceChange"], 175.0)

    def test_card_market_history_converts_raw_jpy_points_to_usd(self) -> None:
        upsert_price_snapshot(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="JPY",
            variant="Holofoil",
            condition="NM",
            low_price=1080.0,
            market_price=1200.0,
            mid_price=1200.0,
            high_price=1320.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        upsert_price_history_daily(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            price_date="2026-04-01",
            currency_code="JPY",
            variant="Holofoil",
            condition="NM",
            low_price=900.0,
            market_price=1000.0,
            mid_price=1000.0,
            high_price=1100.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        upsert_price_history_daily(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            price_date="2026-04-14",
            currency_code="JPY",
            variant="Holofoil",
            condition="NM",
            low_price=1080.0,
            market_price=1200.0,
            mid_price=1200.0,
            high_price=1320.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        self.connection.commit()

        with patch("fx_rates.ensure_fx_rate_snapshot", return_value={
            "baseCurrency": "JPY",
            "quoteCurrency": "USD",
            "rate": 0.0063,
            "source": "ecb",
            "effectiveAt": "2026-04-14",
            "refreshedAt": "2026-04-14T20:05:00Z",
            "isFresh": True,
        }):
            service = SpotlightScanService(self.database_path, REPO_ROOT)
            try:
                payload = service.card_market_history("base1-4", days=30)
            finally:
                service.connection.close()

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["currencyCode"], "USD")
        self.assertAlmostEqual(payload["currentPrice"], 7.56, places=2)
        self.assertAlmostEqual(payload["points"][0]["market"], 6.30, places=2)
        self.assertAlmostEqual(payload["points"][-1]["market"], 7.56, places=2)
        self.assertEqual(payload["availableConditions"], [{"id": "NM", "label": "NM", "currentPrice": 7.56}])
        self.assertAlmostEqual(payload["deltas"]["days30"]["priceChange"], 1.26, places=2)

    def test_card_market_history_skips_live_backfill_when_live_pricing_is_disabled(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            with patch("server.fetch_scrydex_price_history", side_effect=AssertionError("live history fetch should not run")):
                payload = service.card_market_history("base1-4", days=30)
        finally:
            service.connection.close()

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["points"], [])
        self.assertFalse(payload["livePricingEnabled"])

    def test_card_market_history_backfills_when_live_pricing_is_enabled(self) -> None:
        upsert_price_snapshot(
            self.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="Holofoil",
            condition="NM",
            low_price=14.0,
            market_price=15.0,
            mid_price=15.0,
            high_price=16.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        self.connection.commit()
        self.connection.close()
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            service.set_live_pricing_mode(enabled=True)
            with patch(
                "server.fetch_scrydex_price_history",
                return_value={
                    "data": [
                        {
                            "date": "2026-04-07",
                            "prices": [
                                {
                                    "type": "raw",
                                    "variant": "holofoil",
                                    "condition": "NM",
                                    "currency": "USD",
                                    "low": 11.0,
                                    "market": 12.0,
                                    "mid": 12.0,
                                    "high": 13.0,
                                }
                            ],
                        },
                        {
                            "date": "2026-04-14",
                            "prices": [
                                {
                                    "type": "raw",
                                    "variant": "holofoil",
                                    "condition": "NM",
                                    "currency": "USD",
                                    "low": 14.0,
                                    "market": 15.0,
                                    "mid": 15.0,
                                    "high": 16.0,
                                }
                            ],
                        },
                    ]
                },
            ) as fetch_history:
                payload = service.card_market_history("base1-4", days=30)
        finally:
            service.connection.close()

        self.assertIsNotNone(payload)
        assert payload is not None
        fetch_history.assert_called_once()
        self.assertEqual(payload["selectedVariant"], "Holofoil")
        self.assertEqual(payload["selectedCondition"], "NM")
        self.assertEqual(len(payload["points"]), 2)
        self.assertEqual(payload["currentPrice"], 15.0)

    @staticmethod
    def _import_without_dotenv(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "dotenv":
            raise ImportError("simulated missing python-dotenv")
        return ORIGINAL_IMPORT(name, globals, locals, fromlist, level)


if __name__ == "__main__":
    unittest.main()
