from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scrydex_adapter import map_scrydex_catalog_card  # noqa: E402


def payload(expansion_id: str, expansion_name: str) -> dict[str, object]:
    return {
        "data": {
            "id": f"{expansion_id}-38",
            "name": "Magneton",
            "printed_number": "038/088",
            "language_code": "JA",
            "expansion": {"id": expansion_id, "name": expansion_name, "language_code": "JA"},
            "images": [],
        }
    }


class ScrydexSetNameOverrideTests(unittest.TestCase):
    def test_mysterious_mountains_gets_its_own_name(self) -> None:
        # Scrydex names ecard5_ja (Mysterious Mountains) after ecard4_ja (Split Earth).
        mapped = map_scrydex_catalog_card(payload("ecard5_ja", "裂けた大地"))
        self.assertEqual(mapped["set_name"], "神秘なる山")

    def test_other_sets_keep_the_scrydex_name(self) -> None:
        mapped = map_scrydex_catalog_card(payload("ecard4_ja", "裂けた大地"))
        self.assertEqual(mapped["set_name"], "裂けた大地")


if __name__ == "__main__":
    unittest.main()
