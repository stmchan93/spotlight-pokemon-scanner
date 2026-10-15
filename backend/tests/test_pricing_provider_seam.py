"""pricing_provider() names the provider whose rows the PRICE read/write paths
use. It is always Scrydex; the env var it used to read is ignored."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import pricing_provider  # noqa: E402


class PricingProviderSeamTests(unittest.TestCase):
    def setUp(self):
        self._prev = os.environ.get("PRICING_PROVIDER")
        self.addCleanup(self._restore)

    def _restore(self):
        if self._prev is None:
            os.environ.pop("PRICING_PROVIDER", None)
        else:
            os.environ["PRICING_PROVIDER"] = self._prev

    def test_default_is_scrydex(self):
        os.environ.pop("PRICING_PROVIDER", None)
        self.assertEqual(pricing_provider(), "scrydex")

    def test_stale_env_value_is_ignored(self):
        os.environ["PRICING_PROVIDER"] = "legacy-provider"
        self.assertEqual(pricing_provider(), "scrydex")


if __name__ == "__main__":
    unittest.main()
