"""Tests for the holdings-snapshot CSV export formatter.

`deck_entries_export_csv` renders the owner-scoped `entries` shape produced by
`_compute_deck_entries` into CSV text. These pin the header/column order, a raw
entry, a graded entry, gain/loss arithmetic, and RFC-4180 escaping of fields
containing commas and quotes.
"""

from __future__ import annotations

import csv
import io
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    DECK_ENTRIES_EXPORT_COLUMNS,
    deck_entries_export_csv,
)


EXPECTED_HEADER = [
    "name",
    "set",
    "number",
    "language",
    "kind",
    "printing",
    "condition",
    "grader",
    "grade",
    "cert_number",
    "quantity",
    "market_price",
    "currency",
    "cost_basis_per_unit",
    "cost_basis_total",
    "gain_loss",
    "added_at",
]


def _rows(csv_text: str) -> list[list[str]]:
    return list(csv.reader(io.StringIO(csv_text)))


def _raw_entry() -> dict:
    return {
        "id": 1,
        "itemKind": "raw",
        "card": {
            "name": "Charizard",
            "setName": "Base Set",
            "number": "4/102",
            "language": "English",
            "pricing": {"market": 630.0},
        },
        "variantName": "Unlimited",
        "slabContext": None,
        "condition": "LP",
        "quantity": 2,
        "costBasisTotal": 400.0,
        "costBasisCurrencyCode": "USD",
        "costBasisPerUnit": 200.0,
        "addedAt": "2026-01-02T03:04:05Z",
    }


def _graded_entry() -> dict:
    return {
        "id": 2,
        "itemKind": "slab",
        "card": {
            "name": "Umbreon VMAX",
            "setName": "Evolving Skies",
            "number": "215/203",
            "language": "English",
            "pricing": {"market": 1200.0},
        },
        "variantName": "PSA 10",
        "slabContext": {
            "grader": "PSA",
            "grade": "10",
            "certNumber": "12345678",
            "variantName": "Holofoil",
        },
        "condition": None,
        "quantity": 1,
        "costBasisTotal": 900.0,
        "costBasisCurrencyCode": "USD",
        "costBasisPerUnit": 900.0,
        "addedAt": "2026-02-03T04:05:06Z",
    }


def test_header_row_matches_contract() -> None:
    rows = _rows(deck_entries_export_csv([]))
    assert rows == [EXPECTED_HEADER]
    assert list(DECK_ENTRIES_EXPORT_COLUMNS) == EXPECTED_HEADER


def test_raw_entry_row() -> None:
    rows = _rows(deck_entries_export_csv([_raw_entry()]))
    assert rows[0] == EXPECTED_HEADER
    row = dict(zip(EXPECTED_HEADER, rows[1]))
    assert row["name"] == "Charizard"
    assert row["set"] == "Base Set"
    assert row["number"] == "4/102"
    assert row["language"] == "English"
    assert row["kind"] == "raw"
    assert row["printing"] == "Unlimited"
    assert row["condition"] == "Lightly Played"
    # Grader/grade/cert are blank for raw entries.
    assert row["grader"] == ""
    assert row["grade"] == ""
    assert row["cert_number"] == ""
    assert row["quantity"] == "2"
    assert row["market_price"] == "630"
    assert row["currency"] == "USD"
    assert row["cost_basis_per_unit"] == "200"
    assert row["cost_basis_total"] == "400"
    # gain_loss = 630*2 - 400 = 860.
    assert row["gain_loss"] == "860"
    assert row["added_at"] == "2026-01-02T03:04:05Z"


def test_graded_entry_row() -> None:
    rows = _rows(deck_entries_export_csv([_graded_entry()]))
    row = dict(zip(EXPECTED_HEADER, rows[1]))
    assert row["kind"] == "graded"
    # printing comes from slabContext.variantName, not the top-level PSA label.
    assert row["printing"] == "Holofoil"
    assert row["condition"] == ""
    assert row["grader"] == "PSA"
    assert row["grade"] == "10"
    assert row["cert_number"] == "12345678"
    # gain_loss = 1200*1 - 900 = 300.
    assert row["gain_loss"] == "300"


def test_gain_loss_blank_without_market_or_cost() -> None:
    entry = _raw_entry()
    entry["card"]["pricing"] = {}  # no priced value
    rows = _rows(deck_entries_export_csv([entry]))
    row = dict(zip(EXPECTED_HEADER, rows[1]))
    assert row["market_price"] == ""
    assert row["gain_loss"] == ""

    entry2 = _raw_entry()
    entry2["costBasisTotal"] = None
    rows2 = _rows(deck_entries_export_csv([entry2]))
    row2 = dict(zip(EXPECTED_HEADER, rows2[1]))
    assert row2["cost_basis_total"] == ""
    assert row2["gain_loss"] == ""


def test_escaping_of_comma_and_quote_in_name() -> None:
    entry = _raw_entry()
    entry["card"]["name"] = 'Ho-Oh, "Shining" star'
    csv_text = deck_entries_export_csv([entry])
    # The raw text must quote the field and double the embedded quotes.
    assert '"Ho-Oh, ""Shining"" star"' in csv_text
    # And it must round-trip back to the original value via the csv reader.
    rows = _rows(csv_text)
    row = dict(zip(EXPECTED_HEADER, rows[1]))
    assert row["name"] == 'Ho-Oh, "Shining" star'


def test_multiple_entries_produce_one_row_each() -> None:
    rows = _rows(deck_entries_export_csv([_raw_entry(), _graded_entry()]))
    assert len(rows) == 3  # header + 2 entries
