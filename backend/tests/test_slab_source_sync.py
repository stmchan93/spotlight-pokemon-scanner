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

from catalog_tools import apply_schema, connect, seed_catalog  # noqa: E402
from slab_source_sync import (  # noqa: E402
    load_sync_state,
    manifest_sync_status,
    parse_ebay_sold_json,
    parse_fanatics_sales_json,
    parse_goldin_sales_json,
    parse_heritage_sales_json,
    parse_psa_auction_prices_html,
    resolve_source_url,
    sales_from_source,
    source_sync_status,
    sync_slab_sources_once,
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


class SlabSourceSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixtures_root = Path(__file__).resolve().parent / "fixtures"
        cls.apr_fixture = cls.fixtures_root / "psa_apr_neo1_9.html"
        cls.manifest_fixture = cls.fixtures_root / "slab_sources.fixture.json"
        cls.ebay_fixture = cls.fixtures_root / "ebay_sold_neo1_9.json"
        cls.goldin_fixture = cls.fixtures_root / "goldin_sales_neo1_9.json"
        cls.heritage_fixture = cls.fixtures_root / "heritage_sales_neo1_9.json"
        cls.fanatics_fixture = cls.fixtures_root / "fanatics_sales_neo1_9.json"

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "slab_sync.sqlite"
        self.state_path = Path(self.tempdir.name) / "slab_sync_state.json"

        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        seed_catalog(
            connection,
            [
                catalog_card(
                    card_id="neo1-9",
                    name="Lugia",
                    set_name="Neo Genesis",
                    number="9/111",
                    set_id="neo1",
                )
            ],
            REPO_ROOT,
        )
        connection.commit()
        connection.close()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_parse_psa_auction_prices_html_extracts_sales(self) -> None:
        html = self.apr_fixture.read_text()

        sales = parse_psa_auction_prices_html(
            html,
            source={
                "provider": "psa_apr_html",
                "cardID": "neo1-9",
                "grader": "PSA",
            },
            source_id="neo1-9-psa-apr-fixture",
            source_url="file:///tmp/psa_apr_neo1_9.html",
        )

        self.assertEqual(len(sales), 3)
        self.assertEqual(sales[0]["cardID"], "neo1-9")
        self.assertEqual(sales[0]["grader"], "PSA")
        self.assertEqual(sales[0]["grade"], "10")
        self.assertEqual(sales[0]["salePrice"], 4100.0)
        self.assertEqual(sales[1]["grade"], "10")
        self.assertEqual(sales[2]["grade"], "9")
        self.assertTrue(sales[0]["sourceURL"].startswith("file:///"))

    def test_parse_ebay_sold_json_extracts_sales(self) -> None:
        payload = self.ebay_fixture.read_text()

        sales = parse_ebay_sold_json(
            payload,
            source={
                "provider": "ebay_sold_json",
                "cardID": "neo1-9",
                "grader": "PSA",
                "recordsPath": "itemSummaries",
            },
            source_id="neo1-9-ebay-fixture",
            source_url="file:///tmp/ebay_sold_neo1_9.json",
        )

        self.assertEqual(len(sales), 2)
        self.assertEqual(sales[0]["source"], "ebay_sold")
        self.assertEqual(sales[0]["grade"], "10")
        self.assertEqual(sales[0]["salePrice"], 5250.0)

    def test_parse_goldin_sales_json_extracts_sales(self) -> None:
        payload = self.goldin_fixture.read_text()

        sales = parse_goldin_sales_json(
            payload,
            source={
                "provider": "goldin_sales_json",
                "cardID": "neo1-9",
                "grader": "PSA",
                "recordsPath": "results",
            },
            source_id="neo1-9-goldin-fixture",
            source_url="file:///tmp/goldin_sales_neo1_9.json",
        )

        self.assertEqual(len(sales), 1)
        self.assertEqual(sales[0]["source"], "goldin_auctions")
        self.assertEqual(sales[0]["grade"], "10")
        self.assertEqual(sales[0]["salePrice"], 6100.0)

    def test_parse_heritage_sales_json_extracts_sales(self) -> None:
        payload = self.heritage_fixture.read_text()

        sales = parse_heritage_sales_json(
            payload,
            source={
                "provider": "heritage_sales_json",
                "cardID": "neo1-9",
                "grader": "PSA",
                "recordsPath": "lots",
            },
            source_id="neo1-9-heritage-fixture",
            source_url="file:///tmp/heritage_sales_neo1_9.json",
        )

        self.assertEqual(len(sales), 1)
        self.assertEqual(sales[0]["source"], "heritage_auctions")
        self.assertEqual(sales[0]["grade"], "9")
        self.assertEqual(sales[0]["salePrice"], 3250.0)

    def test_parse_fanatics_sales_json_extracts_sales(self) -> None:
        payload = self.fanatics_fixture.read_text()

        sales = parse_fanatics_sales_json(
            payload,
            source={
                "provider": "fanatics_sales_json",
                "cardID": "neo1-9",
                "grader": "PSA",
                "recordsPath": "sales",
            },
            source_id="neo1-9-fanatics-fixture",
            source_url="file:///tmp/fanatics_sales_neo1_9.json",
        )

        self.assertEqual(len(sales), 1)
        self.assertEqual(sales[0]["source"], "fanatics_collect")
        self.assertEqual(sales[0]["grade"], "10")
        self.assertEqual(sales[0]["salePrice"], 5900.0)

    def test_sales_from_source_supports_local_file_manifests(self) -> None:
        manifest = json.loads(self.manifest_fixture.read_text())
        source = manifest["sources"][0]

        sales, resolved_url = sales_from_source(
            source,
            source_id=source["id"],
            manifest_root=self.fixtures_root,
        )

        self.assertEqual(len(sales), 3)
        self.assertTrue(resolved_url.startswith("file://"))

    def test_source_sync_status_reports_missing_env_vars(self) -> None:
        source = {
            "provider": "psa_apr_html",
            "cardID": "neo1-9",
            "grader": "PSA",
            "urlEnv": "PSA_APR_URL",
            "headerEnvs": {
                "Cookie": "PSA_APR_COOKIE",
            },
            "queryParamEnvs": {
                "api_key": "PSA_APR_API_KEY",
            },
        }

        with patch.dict(os.environ, {}, clear=False):
            status = source_sync_status(source, source_id="neo1-9-live", manifest_root=self.fixtures_root)

        self.assertFalse(status["authReady"])
        self.assertEqual(status["missingEnvVars"], ["PSA_APR_API_KEY", "PSA_APR_COOKIE", "PSA_APR_URL"])

    def test_resolve_source_url_supports_url_env_and_query_param_envs(self) -> None:
        source = {
            "provider": "ebay_sold_json",
            "cardID": "neo1-9",
            "urlEnv": "EBAY_SOURCE_URL",
            "queryParams": {
                "format": "json",
            },
            "queryParamEnvs": {
                "token": "EBAY_API_TOKEN",
            },
        }

        with patch.dict(
            os.environ,
            {
                "EBAY_SOURCE_URL": "https://example.com/sales",
                "EBAY_API_TOKEN": "demo-token",
            },
            clear=False,
        ):
            resolved = resolve_source_url(source)

        self.assertTrue(resolved.startswith("https://example.com/sales?"))
        self.assertIn("format=json", resolved)
        self.assertIn("token=demo-token", resolved)

    def test_manifest_sync_status_summarizes_source_readiness(self) -> None:
        manifest_path = Path(self.tempdir.name) / "manifest.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "sources": [
                        {
                            "id": "local-fixture",
                            "provider": "psa_apr_html",
                            "cardID": "neo1-9",
                            "grader": "PSA",
                            "filePath": str(self.apr_fixture),
                        },
                        {
                            "id": "live-fixture",
                            "provider": "psa_apr_html",
                            "cardID": "neo1-9",
                            "grader": "PSA",
                            "urlEnv": "PSA_APR_URL",
                            "headerEnvs": {
                                "Cookie": "PSA_APR_COOKIE",
                            },
                        },
                    ]
                }
            )
        )

        with patch.dict(os.environ, {}, clear=False):
            status = manifest_sync_status(manifest_path)

        self.assertEqual(status["sourceCount"], 2)
        self.assertEqual(status["readySourceCount"], 1)
        self.assertEqual(status["missingEnvSourceCount"], 1)

    def test_sync_slab_sources_once_imports_sales_and_writes_state(self) -> None:
        summary = sync_slab_sources_once(
            database_path=self.database_path,
            repo_root=REPO_ROOT,
            manifest_path=self.manifest_fixture,
            state_path=self.state_path,
        )

        self.assertEqual(summary["inserted"], 3)
        self.assertEqual(len(summary["sources"]), 1)
        self.assertEqual(summary["sources"][0]["status"], "ok")

        state = load_sync_state(self.state_path)
        self.assertIn("neo1-9-psa-apr-fixture", state["sources"])
        self.assertEqual(state["sources"]["neo1-9-psa-apr-fixture"]["summary"]["inserted"], 3)

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        detail = service.card_detail("neo1-9", grader="PSA", grade="10")
        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["card"]["pricing"]["pricingMode"], "psa_grade_estimate")
        self.assertEqual(detail["card"]["pricing"]["pricingTier"], "exact_same_grade")
        self.assertEqual(detail["card"]["pricing"]["grade"], "10")

    def test_sync_slab_sources_once_dedupes_repeated_runs(self) -> None:
        first = sync_slab_sources_once(
            database_path=self.database_path,
            repo_root=REPO_ROOT,
            manifest_path=self.manifest_fixture,
            state_path=self.state_path,
        )
        second = sync_slab_sources_once(
            database_path=self.database_path,
            repo_root=REPO_ROOT,
            manifest_path=self.manifest_fixture,
            state_path=self.state_path,
        )

        self.assertEqual(first["inserted"], 3)
        self.assertEqual(second["inserted"], 0)
        self.assertEqual(second["skippedDuplicates"], 3)

    def test_service_can_report_and_run_slab_sync_when_manifest_is_configured(self) -> None:
        os.environ["SPOTLIGHT_SLAB_SOURCE_MANIFEST"] = str(self.manifest_fixture)
        os.environ["SPOTLIGHT_SLAB_SYNC_STATE_PATH"] = str(self.state_path)
        service = None
        try:
            service = SpotlightScanService(self.database_path, REPO_ROOT)
            status = service.slab_sync_status()
            self.assertTrue(status["configured"])
            self.assertEqual(status["manifestStatus"]["sourceCount"], 1)
            self.assertEqual(status["manifestStatus"]["readySourceCount"], 1)

            summary = service.run_slab_source_sync_once()
            self.assertEqual(summary["inserted"], 3)

            updated_status = service.slab_sync_status()
            self.assertIn("neo1-9-psa-apr-fixture", updated_status["state"]["sources"])
        finally:
            if service is not None:
                service.connection.close()
            os.environ.pop("SPOTLIGHT_SLAB_SOURCE_MANIFEST", None)
            os.environ.pop("SPOTLIGHT_SLAB_SYNC_STATE_PATH", None)


if __name__ == "__main__":
    unittest.main()
