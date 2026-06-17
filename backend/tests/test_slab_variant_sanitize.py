"""Unit tests for `_sanitize_slab_variant_name`.

A slab's variant_name must be the card's print variant (e.g. "Holofoil"), which
is how graded price snapshots are keyed. Some client add paths composed
`${grader} ${grade}` (e.g. "PSA 10") into variantName; stored as the variant it
never matched the snapshot's real variant and collapsed the graded price to "—"
on the Collection/Wishlist. The sanitizer drops grade-label variants so pricing
falls back to the grade's real entry.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from server import SpotlightScanService  # noqa: E402


class SanitizeSlabVariantNameTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sanitize = SpotlightScanService._sanitize_slab_variant_name

    def test_drops_grade_label_variants(self) -> None:
        # "${grader} ${grade}" — the exact corruption seen in the wild.
        self.assertIsNone(self.sanitize("PSA 10", "PSA", "10"))
        self.assertIsNone(self.sanitize("psa 10", "PSA", "10"))  # case-insensitive
        self.assertIsNone(self.sanitize("  PSA 10  ", "PSA", "10"))  # whitespace
        self.assertIsNone(self.sanitize("BGS 10", "BGS", "10"))
        self.assertIsNone(self.sanitize("CGC 10", "CGC", "10"))
        self.assertIsNone(self.sanitize("PSA 9.5", "PSA", "9.5"))
        # grade alone or grader alone are likewise not real print variants.
        self.assertIsNone(self.sanitize("10", "PSA", "10"))
        self.assertIsNone(self.sanitize("PSA", "PSA", "10"))

    def test_keeps_real_print_variants(self) -> None:
        self.assertEqual(self.sanitize("Holofoil", "PSA", "10"), "Holofoil")
        self.assertEqual(self.sanitize("Reverse Holofoil", "PSA", "10"), "Reverse Holofoil")
        self.assertEqual(self.sanitize("1st Edition Holofoil", "PSA", "10"), "1st Edition Holofoil")
        # Trimmed but preserved.
        self.assertEqual(self.sanitize("  Holofoil  ", "PSA", "10"), "Holofoil")

    def test_empty_and_none(self) -> None:
        self.assertIsNone(self.sanitize(None, "PSA", "10"))
        self.assertIsNone(self.sanitize("", "PSA", "10"))
        self.assertIsNone(self.sanitize("   ", "PSA", "10"))


if __name__ == "__main__":
    unittest.main()
