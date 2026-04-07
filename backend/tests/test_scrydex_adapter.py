from __future__ import annotations

import json
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
from scrydex_adapter import refresh_scrydex_psa_snapshot, refresh_scrydex_raw_snapshot  # noqa: E402
from server import SpotlightScanService  # noqa: E402


def catalog_card(
    *,
    card_id: str,
    name: str,
    set_name: str,
    number: str,
    set_id: str,
    types: list[str] | None = None,
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
        "types": types or ["Colorless"],
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


def fixture_payload(name: str) -> dict[str, object]:
    return json.loads((BACKEND_ROOT / "tests" / "fixtures" / name).read_text())


class ScrydexPricingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.database_path = Path(cls.tempdir.name) / "scrydex.sqlite"
        cls.connection = connect(cls.database_path)
        apply_schema(cls.connection, BACKEND_ROOT / "schema.sql")

        seed_catalog(
            cls.connection,
            [
                catalog_card(
                    card_id="sv8-238",
                    name="Pikachu ex",
                    set_name="Surging Sparks",
                    number="238/191",
                    set_id="sv8",
                    types=["Lightning"],
                ),
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

    def fake_fetch_json(self, url: str, api_key: str, team_id: str, timeout: int = 12) -> dict[str, object]:
        self.assertEqual(api_key, "demo-key")
        self.assertEqual(team_id, "demo-team")
        if "/cards/sv8-238" in url:
            return fixture_payload("scrydex_card_sv8_238.json")
        if "/cards/neo1-9" in url:
            return fixture_payload("scrydex_card_neo1_9.json")
        raise AssertionError(f"Unexpected Scrydex URL {url}")

    @patch("scrydex_adapter.fetch_json")
    def test_refresh_scrydex_psa_snapshot_uses_exact_grade_value(self, fetch_json_mock) -> None:
        fetch_json_mock.side_effect = self.fake_fetch_json

        refreshed = refresh_scrydex_psa_snapshot(
            self.connection,
            card_id="sv8-238",
            grade="9",
            api_key="demo-key",
            team_id="demo-team",
        )

        self.assertIsNotNone(refreshed)
        snapshot = slab_price_snapshot_for_card(self.connection, "sv8-238", "PSA", "9")
        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot["source"], "scrydex")
        self.assertEqual(snapshot["pricingTier"], "scrydex_exact_grade")
        self.assertEqual(snapshot["market"], 251.55)
        self.assertEqual(snapshot["mid"], 263.75)

    @patch("scrydex_adapter.fetch_json")
    def test_refresh_scrydex_raw_snapshot_updates_raw_pricing_summary(self, fetch_json_mock) -> None:
        fetch_json_mock.side_effect = self.fake_fetch_json

        refreshed = refresh_scrydex_raw_snapshot(
            self.connection,
            card_id="sv8-238",
            api_key="demo-key",
            team_id="demo-team",
        )

        self.assertIsNotNone(refreshed)
        summary = raw_pricing_summary_for_card(self.connection, "sv8-238")
        self.assertIsNotNone(summary)
        assert summary is not None
        self.assertEqual(summary["source"], "scrydex")
        self.assertEqual(summary["market"], 198.45)
        self.assertEqual(summary["low"], 184.99)
        self.assertEqual(summary["variant"], "specialIllustrationRare")

    @patch("scrydex_adapter.fetch_json")
    def test_service_refresh_card_pricing_prefers_scrydex_for_psa(self, fetch_json_mock) -> None:
        fetch_json_mock.side_effect = self.fake_fetch_json

        with patch.dict(os.environ, {"SCRYDEX_API_KEY": "demo-key", "SCRYDEX_TEAM_ID": "demo-team"}, clear=False):
            service = SpotlightScanService(self.database_path, REPO_ROOT)
            try:
                detail = service.refresh_card_pricing("sv8-238", grader="PSA", grade="9")
            finally:
                service.connection.close()

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["pricing"]["source"], "scrydex")
        self.assertEqual(detail["card"]["pricing"]["pricingTier"], "scrydex_exact_grade")
        self.assertEqual(detail["card"]["pricing"]["market"], 251.55)

    @patch("pricecharting_adapter.fetch_json")
    @patch("scrydex_adapter.fetch_json")
    def test_service_refresh_card_pricing_prefers_scrydex_for_psa_when_both_psa_providers_are_configured(
        self,
        scrydex_fetch_json_mock,
        pricecharting_fetch_json_mock,
    ) -> None:
        scrydex_fetch_json_mock.side_effect = self.fake_fetch_json
        pricecharting_fetch_json_mock.side_effect = AssertionError(
            "PriceCharting fallback should not run while Scrydex is healthy"
        )

        with patch.dict(
            os.environ,
            {
                "SCRYDEX_API_KEY": "demo-key",
                "SCRYDEX_TEAM_ID": "demo-team",
                "PRICECHARTING_API_KEY": "demo-pricecharting-key",
            },
            clear=False,
        ):
            service = SpotlightScanService(self.database_path, REPO_ROOT)
            try:
                detail = service.refresh_card_pricing("sv8-238", grader="PSA", grade="9")
            finally:
                service.connection.close()

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["pricing"]["source"], "scrydex")
        self.assertEqual(detail["card"]["pricing"]["pricingTier"], "scrydex_exact_grade")
        self.assertEqual(detail["card"]["pricing"]["market"], 251.55)
        pricecharting_fetch_json_mock.assert_not_called()

    @patch("scrydex_adapter.fetch_json")
    def test_service_refresh_card_pricing_prefers_scrydex_for_raw(self, fetch_json_mock) -> None:
        fetch_json_mock.side_effect = self.fake_fetch_json

        with patch.dict(os.environ, {"SCRYDEX_API_KEY": "demo-key", "SCRYDEX_TEAM_ID": "demo-team"}, clear=False):
            service = SpotlightScanService(self.database_path, REPO_ROOT)
            try:
                detail = service.refresh_card_pricing("sv8-238")
            finally:
                service.connection.close()

        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["pricing"]["source"], "scrydex")
        self.assertEqual(detail["card"]["pricing"]["pricingMode"], "raw_snapshot")
        self.assertEqual(detail["card"]["pricing"]["market"], 198.45)


if __name__ == "__main__":
    unittest.main()
