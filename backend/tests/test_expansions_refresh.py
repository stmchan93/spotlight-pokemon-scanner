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

from scrydex_adapter import fetch_scrydex_expansions_raw  # noqa: E402
from sync_scrydex_catalog import sync_scrydex_catalog  # noqa: E402


def _expansion_items(start: int, count: int) -> list[dict]:
    return [
        {"id": f"set-{index}", "name": f"Set {index}"}
        for index in range(start, start + count)
    ]


class FetchScrydexExpansionsRawTests(unittest.TestCase):
    def test_pages_until_a_short_page(self) -> None:
        pages = {
            "1": {"data": _expansion_items(0, 100)},
            "2": {"data": _expansion_items(100, 100)},
            "3": {"data": _expansion_items(200, 8)},
        }

        def fake_request(path, *, request_type, **params):
            return pages[params["page"]]

        with patch("scrydex_adapter.scrydex_api_request", side_effect=fake_request) as api_request:
            items = fetch_scrydex_expansions_raw("pokemon")

        self.assertEqual(len(items), 208)
        self.assertEqual(api_request.call_count, 3)
        self.assertEqual(
            [call.kwargs["page"] for call in api_request.call_args_list],
            ["1", "2", "3"],
        )

    def test_stops_when_api_ignores_pagination_and_repeats_a_page(self) -> None:
        with patch(
            "scrydex_adapter.scrydex_api_request",
            return_value={"data": _expansion_items(0, 100)},
        ) as api_request:
            items = fetch_scrydex_expansions_raw("pokemon")

        # Same 100 ids every page: keep one copy and stop instead of looping.
        self.assertEqual(len(items), 100)
        self.assertEqual(api_request.call_count, 2)

    def test_keeps_earlier_pages_when_a_later_page_fails(self) -> None:
        with patch(
            "scrydex_adapter.scrydex_api_request",
            side_effect=[{"data": _expansion_items(0, 100)}, RuntimeError("boom")],
        ):
            items = fetch_scrydex_expansions_raw("pokemon")

        self.assertEqual(len(items), 100)

    def test_skips_items_without_ids(self) -> None:
        with patch(
            "scrydex_adapter.scrydex_api_request",
            return_value={"data": [{"id": "sv1", "name": "ok"}, {"name": "no id"}, "junk"]},
        ):
            items = fetch_scrydex_expansions_raw("pokemon")

        self.assertEqual([item["id"] for item in items], ["sv1"])


class CatalogSyncExpansionsRefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "sync.sqlite"

    def _run_sync(self, expansions_patch):
        with patch.dict(
            os.environ,
            {"SCRYDEX_API_KEY": "scrydex-key", "SCRYDEX_TEAM_ID": "team-id"},
            clear=False,
        ), patch(
            "sync_scrydex_catalog.fetch_scrydex_cards_page", return_value=[]
        ), expansions_patch as refresh:
            summary = sync_scrydex_catalog(
                database_path=self.database_path,
                repo_root=REPO_ROOT,
                page_size=1,
                max_pages=1,
            )
        return summary, refresh

    def test_daily_sync_refreshes_expansions_and_reports_count(self) -> None:
        summary, refresh = self._run_sync(
            patch("sync_scrydex_catalog.sync_scrydex_expansions", return_value=275)
        )

        refresh.assert_called_once()
        self.assertEqual(summary["expansionsRefreshed"], 275)
        self.assertIsNone(summary["expansionsRefreshError"])

    def test_expansions_refresh_failure_does_not_fail_the_card_sync(self) -> None:
        summary, refresh = self._run_sync(
            patch(
                "sync_scrydex_catalog.sync_scrydex_expansions",
                side_effect=RuntimeError("expansions endpoint down"),
            )
        )

        refresh.assert_called_once()
        self.assertEqual(summary["expansionsRefreshed"], 0)
        self.assertIn("expansions endpoint down", summary["expansionsRefreshError"])


if __name__ == "__main__":
    unittest.main()
