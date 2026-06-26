"""The PRICING_PROVIDER seam: pricing_provider() selects which provider's rows the
PRICE read/write paths use. Default 'scrydex' keeps behavior identical; 'ppt' flips
the price source (PokemonPriceTracker) without touching catalog/identity/sync.
"""

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

    def test_empty_falls_back_to_scrydex(self):
        os.environ["PRICING_PROVIDER"] = "   "
        self.assertEqual(pricing_provider(), "scrydex")

    def test_ppt_flag(self):
        os.environ["PRICING_PROVIDER"] = "ppt"
        self.assertEqual(pricing_provider(), "ppt")

    def test_normalizes_case_and_whitespace(self):
        os.environ["PRICING_PROVIDER"] = "  PPT  "
        self.assertEqual(pricing_provider(), "ppt")


if __name__ == "__main__":
    unittest.main()
