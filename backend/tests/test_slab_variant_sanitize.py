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
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_catalog_card  # noqa: E402
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


class CreateDeckEntrySlabVariantTest(unittest.TestCase):
    """The ADD ITEM direct-add path (`create_deck_entry`) must sanitize a
    grade-label variantName too — not just record_buy / replace_deck_entry. A
    regression here re-introduced the "—" Collection price for graded slabs.
    """

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        database_path = Path(self.tempdir.name) / "deck-entry.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        upsert_catalog_card(
            connection,
            {
                "id": "topsun_ja-88",
                "name": "Grimer",
                "setName": "Topsun",
                "number": "088",
                "setId": "topsun_ja",
            },
            REPO_ROOT,
            "2026-06-17T00:00:00Z",
            refresh_embeddings=False,
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def test_grade_label_variant_is_dropped_on_add(self) -> None:
        self.service.create_deck_entry(
            {
                "cardID": "topsun_ja-88",
                "selectionSource": "manual_search",
                "quantity": 1,
                "addedAt": "2026-06-17T07:27:30Z",
                "slabContext": {"grader": "PSA", "grade": "10", "variantName": "PSA 10"},
            }
        )
        row = self.service.connection.execute(
            "SELECT variant_name, identity_key FROM deck_entries WHERE card_id = ?",
            ("topsun_ja-88",),
        ).fetchone()
        self.assertIsNotNone(row)
        # variant_name stored as NULL so the graded snapshot resolver falls back
        # to the grade's real entry instead of collapsing to "—".
        self.assertIsNone(row["variant_name"])
        self.assertNotIn("PSA 10", row["identity_key"])

    def test_real_print_variant_is_preserved_on_add(self) -> None:
        self.service.create_deck_entry(
            {
                "cardID": "topsun_ja-88",
                "selectionSource": "manual_search",
                "quantity": 1,
                "addedAt": "2026-06-17T07:30:00Z",
                "slabContext": {"grader": "PSA", "grade": "10", "variantName": "Blue Back"},
            }
        )
        row = self.service.connection.execute(
            "SELECT variant_name FROM deck_entries WHERE card_id = ?",
            ("topsun_ja-88",),
        ).fetchone()
        self.assertEqual(row["variant_name"], "Blue Back")

    def test_raw_top_level_variant_is_persisted_on_add(self) -> None:
        # A raw card (no slabContext) sends its print variant as the top-level
        # `variantName`. It must be written — regression guard for the save that
        # silently dropped the picked variant because create_deck_entry only read
        # slabContext.variantName.
        self.service.create_deck_entry(
            {
                "cardID": "topsun_ja-88",
                "selectionSource": "manual_search",
                "quantity": 1,
                "addedAt": "2026-06-17T07:33:00Z",
                "variantName": "Holofoil",
            }
        )
        row = self.service.connection.execute(
            "SELECT variant_name FROM deck_entries WHERE card_id = ?",
            ("topsun_ja-88",),
        ).fetchone()
        self.assertEqual(row["variant_name"], "Holofoil")


if __name__ == "__main__":
    unittest.main()
