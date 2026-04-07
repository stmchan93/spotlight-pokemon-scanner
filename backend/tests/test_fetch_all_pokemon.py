from __future__ import annotations

import sys
import unittest
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from fetch_all_pokemon import resolved_collector_number  # noqa: E402


class FetchAllPokemonTests(unittest.TestCase):
    def test_resolved_collector_number_uses_printed_total_for_standard_sets(self) -> None:
        card = {
            "number": "175",
            "set": {
                "name": "Brilliant Stars",
                "series": "Sword & Shield",
                "printedTotal": 172,
            },
        }

        self.assertEqual(resolved_collector_number(card), "175/172")

    def test_resolved_collector_number_preserves_prefixed_numbers(self) -> None:
        card = {
            "number": "TG29",
            "set": {
                "name": "Lost Origin Trainer Gallery",
                "series": "Sword & Shield",
                "printedTotal": 30,
            },
        }

        self.assertEqual(resolved_collector_number(card), "TG29/TG30")

    def test_resolved_collector_number_keeps_promos_without_slash(self) -> None:
        card = {
            "number": "SWSH286",
            "set": {
                "name": "SWSH Black Star Promos",
                "series": "Sword & Shield",
                "printedTotal": 307,
            },
        }

        self.assertEqual(resolved_collector_number(card), "SWSH286")


if __name__ == "__main__":
    unittest.main()
