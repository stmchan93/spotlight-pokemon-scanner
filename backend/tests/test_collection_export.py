"""Collection spreadsheet export: SKU merge, per-grade slab price, USD-only,
blank (not $0) cost, links, totals row, CSV escaping."""

from __future__ import annotations

import csv
import io
import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from collection_export import COLLECTION_EXPORT_COLUMNS, collection_export_csv  # noqa: E402


def _card(**overrides):
    card = {
        "id": "base1-4",
        "name": "Charizard",
        "setName": "Base Set",
        "number": "4/102",
        "rarity": "Rare Holo",
        "language": "English",
        "game": "pokemon",
        "pricing": {"currencyCode": "USD", "market": 400.0, "sourceUpdatedAt": "2026-11-21T13:00:00Z"},
    }
    card.update(overrides)
    return card


def _raw(entry_id, *, quantity=1, cost_total=0.0, cost_cents=None, condition="NM",
         variant="Unlimited Holofoil", collection="Main", card=None, added="2026-10-01T00:00:00Z",
         baseline=None):
    return {
        "id": entry_id,
        "itemKind": "raw",
        "card": card or _card(),
        "collectionId": collection.lower(),
        "collectionName": collection,
        "variantName": variant,
        "condition": condition,
        "slabContext": None,
        "quantity": quantity,
        "costBasisTotal": cost_total,
        "costBasisCents": cost_cents,
        "costBasisCurrencyCode": "USD" if cost_cents is not None else None,
        "addedAt": added,
        "sinceAddedBaselinePrice": baseline,
    }


def _slab(entry_id, *, cert, grade="10", price=9000.0):
    entry = _raw(entry_id, card=_card(pricing={"currencyCode": "USD", "market": price}))
    entry.update({"itemKind": "slab", "condition": None,
                  "slabContext": {"grader": "PSA", "grade": grade, "certNumber": cert, "variantName": "Unlimited Holofoil"}})
    return entry


def _rows(text):
    rows = list(csv.reader(io.StringIO(text)))
    header = rows[0]
    return [dict(zip(header, row)) for row in rows[1:]]


class CollectionExportTest(unittest.TestCase):
    def test_header(self):
        header = next(csv.reader(io.StringIO(collection_export_csv([]))))
        self.assertEqual(header, list(COLLECTION_EXPORT_COLUMNS))

    def test_empty_has_no_totals_row(self):
        self.assertEqual(len(_rows(collection_export_csv([]))), 0)

    def test_same_sku_merges_quantities(self):
        rows = _rows(collection_export_csv([
            _raw("a", quantity=1, cost_total=300, cost_cents=30000, added="2026-10-05T00:00:00Z"),
            _raw("b", quantity=2, cost_total=600, cost_cents=30000, added="2026-09-01T00:00:00Z"),
        ]))
        row = rows[0]
        self.assertEqual(row["Quantity"], "3")
        self.assertEqual(row["Market value"], "1200.00")
        self.assertEqual(row["Paid (total)"], "900.00")
        self.assertEqual(row["Paid (each)"], "300.00")
        self.assertEqual(row["Gain/loss $"], "300.00")
        self.assertEqual(row["Gain/loss %"], "33.3")
        self.assertEqual(row["Date added"], "2026-09-01")
        self.assertEqual(row["Condition"], "Near Mint")
        self.assertEqual(row["Price date"], "2026-11-21")
        self.assertEqual(row["Game"], "Pokémon")
        self.assertEqual(rows[-1]["Name"], "TOTAL")

    def test_different_condition_printing_or_collection_stay_separate(self):
        rows = _rows(collection_export_csv([
            _raw("a"), _raw("b", condition="LP"), _raw("c", variant="1st Edition Holofoil"),
            _raw("d", collection="Trades"),
        ]))
        self.assertEqual(len(rows), 5)  # 4 SKUs + totals

    def test_no_cost_entered_is_blank_not_zero(self):
        row = _rows(collection_export_csv([_raw("a")]))[0]
        self.assertEqual(row["Paid (total)"], "")
        self.assertEqual(row["Gain/loss $"], "")

    def test_partial_cost_across_merged_copies_is_blank(self):
        row = _rows(collection_export_csv([
            _raw("a", cost_total=300, cost_cents=30000), _raw("b"),
        ]))[0]
        self.assertEqual(row["Paid (total)"], "")

    def test_slab_uses_its_own_price_and_ebay_sold_link(self):
        rows = _rows(collection_export_csv([_slab("s1", cert="111"), _slab("s2", cert="222"), _raw("r")]))
        slab = rows[0]
        self.assertEqual(slab["Type"], "Graded")
        self.assertEqual(slab["Market price (each)"], "9000.00")
        self.assertEqual(slab["Quantity"], "2")
        self.assertEqual(slab["Cert #"], "111; 222")
        self.assertEqual(slab["Condition"], "")
        self.assertIn("ebay.com/sch", slab["Link"])
        self.assertIn("LH_Sold=1", slab["Link"])
        self.assertIn("PSA+10", slab["Link"])

    def test_tcgplayer_product_link_or_search(self):
        with_id = _rows(collection_export_csv([_raw("a", card=_card(tcgplayerProductId="42382"))]))[0]
        self.assertEqual(with_id["Link"], "https://www.tcgplayer.com/product/42382")
        without = _rows(collection_export_csv([_raw("a")]))[0]
        self.assertTrue(without["Link"].startswith("https://www.tcgplayer.com/search/all/product?q=Charizard"))
        self.assertEqual(without["Card ID"], "base1-4")

    def test_non_usd_price_is_blank(self):
        row = _rows(collection_export_csv([_raw("a", card=_card(pricing={"currencyCode": "JPY", "market": 50000}))]))[0]
        self.assertEqual(row["Market price (each)"], "")
        self.assertEqual(row["Market value"], "")

    def test_since_added_and_sort_by_value(self):
        rows = _rows(collection_export_csv([
            _raw("cheap", card=_card(id="x", name="Pikachu", pricing={"currencyCode": "USD", "market": 2.0})),
            _raw("a", baseline=320.0),
        ]))
        self.assertEqual(rows[0]["Name"], "Charizard")
        self.assertEqual(rows[0]["Price when added"], "320.00")
        self.assertEqual(rows[0]["Change since added %"], "25.0")

    def test_totals_row(self):
        rows = _rows(collection_export_csv([
            _raw("a", cost_total=300, cost_cents=30000), _raw("b", condition="LP"),
        ]))
        totals = rows[-1]
        self.assertEqual(totals["Quantity"], "2")
        self.assertEqual(totals["Market value"], "800.00")
        self.assertEqual(totals["Paid (total)"], "300.00")
        self.assertEqual(totals["Gain/loss $"], "100.00")

    def test_long_condition_codes(self):
        row = _rows(collection_export_csv([_raw("a", condition="near_mint")]))[0]
        self.assertEqual(row["Condition"], "Near Mint")

    def test_unpriced_total_is_blank(self):
        rows = _rows(collection_export_csv([_raw("a", card=_card(pricing=None))]))
        self.assertEqual(rows[-1]["Market value"], "")

    def test_escaping(self):
        text = collection_export_csv([_raw("a", card=_card(name='Pikachu, "Surfing"'))])
        self.assertEqual(_rows(text)[0]["Name"], 'Pikachu, "Surfing"')


if __name__ == "__main__":
    unittest.main()
