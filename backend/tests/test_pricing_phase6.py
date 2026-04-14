from __future__ import annotations

import os
import sys
import tempfile
import unittest
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
    start_provider_sync_run,
    update_provider_sync_run,
    upsert_card,
    upsert_card_price_summary,
    upsert_price_snapshot,
    upsert_slab_price_snapshot,
    utc_now,
)
from scrydex_adapter import persist_scrydex_all_graded_snapshots, reset_scrydex_request_stats  # noqa: E402
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
            "SELECT COUNT(*) AS count FROM card_price_snapshots WHERE pricing_mode = ?",
            (RAW_PRICING_MODE,),
        ).fetchone()["count"]
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
            "SELECT COUNT(*) AS count FROM card_price_snapshots WHERE pricing_mode = ?",
            (PSA_GRADE_PRICING_MODE,),
        ).fetchone()["count"]
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
        self.assertEqual(cache_status["rawSnapshots"]["count"], 1)
        self.assertEqual(cache_status["slabSnapshots"]["count"], 1)

    def test_provider_status_reports_latest_full_catalog_sync(self) -> None:
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
        try:
            provider_status = service.provider_status()
        finally:
            service.connection.close()

        self.assertTrue(provider_status["scrydexFullCatalogSyncFresh"])
        self.assertEqual(provider_status["scrydexFullCatalogSync"]["syncScope"], "raw_catalog_full")
        self.assertEqual(provider_status["scrydexFullCatalogSync"]["pagesFetched"], 203)
        self.assertTrue(provider_status["manualScrydexMirror"]["enabled"])
        self.assertTrue(provider_status["manualScrydexMirror"]["liveQueriesBlocked"])
        providers = {provider["providerId"]: provider for provider in provider_status["providers"]}
        self.assertTrue(providers["scrydex"]["fullCatalogSyncFresh"])
        self.assertIsNotNone(providers["scrydex"]["lastFullCatalogSyncAt"])

    def test_refresh_card_pricing_skips_live_raw_refresh_when_manual_mirror_sync_is_fresh(self) -> None:
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
        scrydex_provider = service.pricing_registry.get_provider("scrydex")
        assert scrydex_provider is not None
        scrydex_provider.refresh_raw_pricing = Mock()  # type: ignore[method-assign]
        try:
            detail = service.refresh_card_pricing("base1-4", force_refresh=True)
        finally:
            service.connection.close()

        scrydex_provider.refresh_raw_pricing.assert_not_called()
        self.assertIsNotNone(detail)

    def test_refresh_card_pricing_skips_live_slab_refresh_when_manual_mirror_sync_is_fresh(self) -> None:
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
        scrydex_provider = service.pricing_registry.get_provider("scrydex")
        assert scrydex_provider is not None
        scrydex_provider.refresh_psa_pricing = Mock()  # type: ignore[method-assign]
        try:
            detail = service.refresh_card_pricing("base1-4", grader="PSA", grade="9", force_refresh=True)
        finally:
            service.connection.close()

        scrydex_provider.refresh_psa_pricing.assert_not_called()
        self.assertIsNotNone(detail)

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

        rows = self.connection.execute(
            """
            SELECT grader, grade, variant
            FROM card_price_snapshots
            WHERE card_id = ? AND pricing_mode = ?
            ORDER BY grader, grade, variant
            """,
            ("base1-4", PSA_GRADE_PRICING_MODE),
        ).fetchall()

        self.assertEqual(persisted, 3)
        self.assertEqual(
            [(row["grader"], row["grade"], row["variant"]) for row in rows],
            [
                ("BGS", "9.5", "1St Edition"),
                ("PSA", "8", "Unlimited"),
                ("PSA", "9", "Unlimited"),
            ],
        )

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

        card_row = self.connection.execute(
            "SELECT id, image_small_url, image_url FROM cards WHERE id = ?",
            ("xy1-1",),
        ).fetchone()
        self.assertIsNotNone(card_row)
        self.assertEqual(card_row["image_small_url"], "https://images.scrydex.example/cards/xy1-1/small")
        self.assertEqual(card_row["image_url"], "https://images.scrydex.example/cards/xy1-1/large")

        snapshot_rows = self.connection.execute(
            """
            SELECT pricing_mode, grader, grade, provider
            FROM card_price_snapshots
            WHERE card_id = ?
            ORDER BY pricing_mode, grader, grade
            """,
            ("xy1-1",),
        ).fetchall()
        self.assertEqual(
            [(row["pricing_mode"], row["grader"], row["grade"], row["provider"]) for row in snapshot_rows],
            [
                (PSA_GRADE_PRICING_MODE, "PSA", "9", "scrydex"),
                (RAW_PRICING_MODE, None, None, "scrydex"),
            ],
        )

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

    def test_raw_candidate_payload_fetches_scrydex_once_then_reuses_cached_snapshot(self) -> None:
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

            self.assertEqual(fetch_card.call_count, 1)
            self.assertIsNotNone(first_payload.get("pricing"))
            self.assertIsNotNone(second_payload.get("pricing"))
        finally:
            service.connection.close()

    def test_shared_top_five_pricing_policy_has_explicit_rank_rules(self) -> None:
        policy = PricingLoadPolicy.top_five_refresh_top_one(refresh_top_candidate=True)

        self.assertEqual(policy.limit, 5)
        self.assertEqual(
            [(policy.rule_for_rank(index).ensure_cached, policy.rule_for_rank(index).refresh_stale) for index in range(1, 6)],
            [
                (True, True),
                (False, False),
                (False, False),
                (False, False),
                (False, False),
            ],
        )

    @staticmethod
    def _import_without_dotenv(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "dotenv":
            raise ImportError("simulated missing python-dotenv")
        return ORIGINAL_IMPORT(name, globals, locals, fromlist, level)


if __name__ == "__main__":
    unittest.main()
