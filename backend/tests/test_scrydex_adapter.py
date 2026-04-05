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
    load_cards_json,
    raw_pricing_summary_for_card,
    seed_catalog,
    slab_price_snapshot_for_card,
)
from scrydex_adapter import refresh_scrydex_psa_snapshot, refresh_scrydex_raw_snapshot  # noqa: E402
from server import SpotlightScanService  # noqa: E402


def cards_without_reference_images(cards: list[dict[str, object]]) -> list[dict[str, object]]:
    trimmed: list[dict[str, object]] = []
    for card in cards:
        cloned = dict(card)
        cloned["reference_image_path"] = None
        trimmed.append(cloned)
    return trimmed


def fixture_payload(name: str) -> dict[str, object]:
    return json.loads((BACKEND_ROOT / "tests" / "fixtures" / name).read_text())


class ScrydexPricingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.database_path = Path(cls.tempdir.name) / "scrydex.sqlite"
        cls.connection = connect(cls.database_path)
        apply_schema(cls.connection, BACKEND_ROOT / "schema.sql")

        imported_cards = load_cards_json(BACKEND_ROOT / "catalog" / "pokemontcg" / "cards.json")
        wanted_ids = {"sv8-238", "neo1-9"}
        selected_cards = [card for card in imported_cards if card["id"] in wanted_ids]
        seed_catalog(cls.connection, cards_without_reference_images(selected_cards), REPO_ROOT)
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
