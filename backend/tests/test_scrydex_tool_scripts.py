from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import unittest
from unittest.mock import patch

from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import summarize_scrydex_usage  # noqa: E402
import validate_scrydex  # noqa: E402


class ScrydexToolScriptTests(unittest.TestCase):
    def test_validate_cli_value_reads_flags_and_rejects_missing_values(self) -> None:
        with patch.object(sys, "argv", ["validate_scrydex.py", "--card-id", "base1-4"]):
            self.assertEqual(validate_scrydex.cli_value("--card-id"), "base1-4")
            self.assertIsNone(validate_scrydex.cli_value("--database-path"))

        with patch.object(sys, "argv", ["validate_scrydex.py", "--card-id"]):
            with self.assertRaisesRegex(SystemExit, "Missing value for --card-id"):
                validate_scrydex.cli_value("--card-id")

    def test_validate_main_prints_runtime_summary(self) -> None:
        with (
            patch.object(sys, "argv", ["validate_scrydex.py", "--database-path", "/tmp/cards.sqlite", "--card-id", "gym1-60"]),
            patch.object(validate_scrydex, "scrydex_credentials", return_value=("key", "team")),
            patch.dict(os.environ, {"SCRYDEX_BASE_URL": "https://api.scrydex.test"}, clear=False),
        ):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                validate_scrydex.main()

        payload = json.loads(buffer.getvalue())
        self.assertTrue(payload["scrydexConfigured"])
        self.assertEqual(payload["databasePath"], "/tmp/cards.sqlite")
        self.assertEqual(
            payload["sampleCardURL"],
            "https://api.scrydex.test/pokemon/v1/cards/gym1-60?include=prices&casing=snake",
        )

    def test_summarize_main_passes_cli_args_through_and_prints_json(self) -> None:
        with (
            patch.object(sys, "argv", ["summarize_scrydex_usage.py", "--hours", "12", "--limit", "7"]),
            patch.object(
                summarize_scrydex_usage,
                "scrydex_request_audit_summary",
                return_value={"recent": [{"path": "/pokemon/v1/cards"}], "hours": 12},
            ) as audit_summary,
        ):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                summarize_scrydex_usage.main()

        audit_summary.assert_called_once_with(hours=12, recent_limit=7)
        self.assertEqual(json.loads(buffer.getvalue())["hours"], 12)


if __name__ == "__main__":
    unittest.main()
