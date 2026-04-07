from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    raw_pricing_summary_for_card,
    seed_catalog,
    slab_price_snapshot_for_card,
)
from pricecharting_adapter import (  # noqa: E402
    PriceChartingProvider,
    refresh_pricecharting_psa_snapshot,
    resolve_pricecharting_psa_price,
)
from server import SpotlightScanService  # noqa: E402


def catalog_card(
    *,
    card_id: str,
    name: str,
    set_name: str,
    number: str,
    set_id: str,
) -> dict[str, object]:
    return {
        "id": card_id,
        "name": name,
        "set_name": set_name,
        "number": number,
        "rarity": "Rare Holo",
        "variant": "Raw",
        "language": "English",
        "reference_image_path": None,
        "reference_image_url": f"https://images.example/{card_id}.png",
        "reference_image_small_url": f"https://images.example/{card_id}.png",
        "source": "test_seed",
        "source_record_id": card_id,
        "set_id": set_id,
        "set_series": "Test Series",
        "set_ptcgo_code": None,
        "set_release_date": "2000-01-01",
        "supertype": "Pokémon",
        "subtypes": [],
        "types": ["Colorless"],
        "artist": "Test Artist",
        "regulation_mark": None,
        "national_pokedex_numbers": [],
        "tcgplayer": {},
        "cardmarket": {},
        "source_payload": {
            "id": card_id,
            "name": name,
            "number": number,
        },
        "imported_at": "2026-04-06T00:00:00Z",
    }


class PriceChartingPricingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.database_path = Path(cls.tempdir.name) / "pricecharting.sqlite"
        cls.connection = connect(cls.database_path)
        apply_schema(cls.connection, BACKEND_ROOT / "schema.sql")

        seed_catalog(
            cls.connection,
            [
                catalog_card(
                    card_id="neo1-9",
                    name="Lugia",
                    set_name="Neo Genesis",
                    number="9/111",
                    set_id="neo1",
                ),
            ],
            REPO_ROOT,
        )
        cls.connection.commit()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.connection.close()
        cls.tempdir.cleanup()

    @staticmethod
    def pricecharting_payload() -> dict[str, object]:
        return {
            "id": "demo-pricecharting-product",
            "product-name": "Lugia Holo 1st Edition",
            "price-ungraded": 320.0,
            "price-graded-9": 3250.0,
            "price-graded-10": 6100.0,
        }

    def fake_fetch_json(self, url: str, api_key: str, timeout: int = 12) -> dict[str, object]:
        self.assertEqual(api_key, "demo-pricecharting-key")
        self.assertIn("/product/", url)
        return self.pricecharting_payload()

    def test_resolve_pricecharting_psa_price_uses_exact_grade(self) -> None:
        resolved = resolve_pricecharting_psa_price(self.pricecharting_payload(), "9")

        self.assertIsNotNone(resolved)
        assert resolved is not None
        self.assertEqual(resolved["market"], 3250.0)
        self.assertEqual(resolved["grade"], "9")

    @patch("pricecharting_adapter.fetch_json")
    def test_refresh_pricecharting_psa_snapshot_persists_slab_snapshot(self, fetch_json_mock) -> None:
        fetch_json_mock.side_effect = self.fake_fetch_json

        refreshed = refresh_pricecharting_psa_snapshot(
            self.connection,
            card_id="neo1-9",
            grade="9",
            api_key="demo-pricecharting-key",
        )

        self.assertIsNotNone(refreshed)
        snapshot = slab_price_snapshot_for_card(self.connection, "neo1-9", "PSA", "9")
        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot["source"], "pricecharting")
        self.assertEqual(snapshot["pricingTier"], "pricecharting_exact_grade")
        self.assertEqual(snapshot["market"], 3250.0)

    def test_pricecharting_provider_rejects_raw_pricing_requests(self) -> None:
        provider = PriceChartingProvider()

        result = provider.refresh_raw_pricing(self.connection, "neo1-9")

        self.assertFalse(result.success)
        self.assertEqual(result.provider_id, "pricecharting")
        self.assertIn("PSA pricing only", result.error or "")
        self.assertIsNone(raw_pricing_summary_for_card(self.connection, "neo1-9"))

    @patch("pricecharting_adapter.fetch_json")
    def test_service_refresh_card_pricing_prefers_pricecharting_for_psa(self, fetch_json_mock) -> None:
        fetch_json_mock.side_effect = self.fake_fetch_json

        with patch.dict(os.environ, {"PRICECHARTING_API_KEY": "demo-pricecharting-key"}, clear=False):
            service = SpotlightScanService(self.database_path, REPO_ROOT)
            try:
                detail = service.refresh_card_pricing("neo1-9", grader="PSA", grade="9")
            finally:
                service.connection.close()

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["pricing"]["source"], "pricecharting")
        self.assertEqual(detail["card"]["pricing"]["pricingMode"], "psa_grade_estimate")
        self.assertEqual(detail["card"]["pricing"]["market"], 3250.0)
