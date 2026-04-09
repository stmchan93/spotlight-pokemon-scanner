from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_card_price_summary,
    upsert_price_snapshot,
    upsert_slab_price_snapshot,
)
from server import SpotlightScanService  # noqa: E402


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
            source_provider="pokemontcg_api",
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
            payload={"provider": "pokemontcg_api", "priceSource": "tcgplayer"},
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
            provider="pokemontcg_api",
            currency_code="USD",
            variant="normal",
            low_price=100.0,
            market_price=120.0,
            mid_price=115.0,
            high_price=140.0,
            source_url="https://prices.example/raw",
            payload={"provider": "pokemontcg_api", "priceSource": "tcgplayer"},
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
        self.assertIsNotNone(providers["pokemontcg_api"]["lastRawRefreshAt"])
        self.assertIsNotNone(providers["scrydex"]["lastPsaRefreshAt"])
        self.assertEqual(cache_status["rawSnapshots"]["count"], 1)
        self.assertEqual(cache_status["slabSnapshots"]["count"], 1)


if __name__ == "__main__":
    unittest.main()
