from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    price_history_cells_from_contexts,
    reconstruct_graded_contexts_from_cells,
    reconstruct_raw_contexts_from_cells,
    upsert_card,
    upsert_price_history_daily,
)
from server import _apply_price_history_cells_schema_patch  # noqa: E402

# Columns kept on the slim table (everything except the 4 JSON blobs).
_SLIM_COLUMNS = (
    "card_id", "provider", "price_date", "display_currency_code",
    "default_raw_variant", "default_raw_condition",
    "default_raw_low_price", "default_raw_market_price", "default_raw_mid_price",
    "default_raw_high_price", "default_raw_direct_low_price", "default_raw_trend_price",
    "updated_at",
)

_DEFAULT_RAW_FIELDS = (
    "default_raw_variant", "default_raw_condition",
    "default_raw_low_price", "default_raw_market_price", "default_raw_mid_price",
    "default_raw_high_price", "default_raw_direct_low_price", "default_raw_trend_price",
)


def _make_db(slim: bool = False):
    tempdir = tempfile.TemporaryDirectory()
    database_path = Path(tempdir.name) / "hist.sqlite"
    connection = connect(database_path)
    apply_schema(connection, BACKEND_ROOT / "schema.sql")
    _apply_price_history_cells_schema_patch(connection)
    if slim:
        _swap_to_slim(connection)
    upsert_card(
        connection,
        card_id="c1",
        name="Pikachu",
        set_name="Base Set",
        number="58/102",
        rarity="Common",
        variant="Raw",
        language="English",
        source_provider="scrydex",
        source_record_id="c1",
    )
    connection.commit()
    return tempdir, connection


def _swap_to_slim(connection) -> None:
    """Rebuild card_price_history_daily without the 4 JSON columns, simulating the
    post-migration state the writer must tolerate."""
    cols = ",\n".join(
        {
            "card_id": "card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE",
            "provider": "provider TEXT NOT NULL",
            "price_date": "price_date TEXT NOT NULL",
            "display_currency_code": "display_currency_code TEXT NOT NULL",
            "default_raw_variant": "default_raw_variant TEXT",
            "default_raw_condition": "default_raw_condition TEXT",
            "default_raw_low_price": "default_raw_low_price REAL",
            "default_raw_market_price": "default_raw_market_price REAL",
            "default_raw_mid_price": "default_raw_mid_price REAL",
            "default_raw_high_price": "default_raw_high_price REAL",
            "default_raw_direct_low_price": "default_raw_direct_low_price REAL",
            "default_raw_trend_price": "default_raw_trend_price REAL",
            "updated_at": "updated_at TEXT NOT NULL",
        }[c]
        for c in _SLIM_COLUMNS
    )
    connection.executescript(
        f"""
        DROP TABLE card_price_history_daily;
        CREATE TABLE card_price_history_daily (
            {cols},
            PRIMARY KEY (card_id, price_date)
        );
        """
    )
    connection.commit()


class _CellsModeMixin:
    """Force cells read source so the writer sources existing lanes from cells."""

    def setUp(self) -> None:  # type: ignore[override]
        self._prev = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"

    def tearDown(self) -> None:  # type: ignore[override]
        if self._prev is None:
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
        else:
            os.environ["PRICE_HISTORY_SOURCE"] = self._prev


def _cells(connection, card_id: str, price_date: str) -> dict[str, dict]:
    rows = connection.execute(
        "SELECT * FROM card_price_history_cell WHERE card_id = ? AND price_date = ?",
        (card_id, price_date),
    ).fetchall()
    return {str(r["cell_key"]): {k: r[k] for k in r.keys()} for r in rows}


def _cells_comparable(cells: dict[str, dict]) -> dict[str, dict]:
    """Strip volatile fields (updated_at) so two cell sets can be compared."""
    out: dict[str, dict] = {}
    for key, cell in cells.items():
        out[key] = {k: v for k, v in cell.items() if k != "updated_at"}
    return out


def _default_raw_row(connection, card_id: str, price_date: str) -> dict:
    row = connection.execute(
        "SELECT * FROM card_price_history_daily WHERE card_id = ? AND price_date = ?",
        (card_id, price_date),
    ).fetchone()
    return {k: row[k] for k in _DEFAULT_RAW_FIELDS}


# Shaped like the real scrydex JSON: raw variants are keyed by *label*
# ("Holofoil"), with variantKey carrying the lowercase key the cells store.
_RAW_CONTEXTS = {
    "variants": {
        "Holofoil": {
            "variant": "Holofoil",
            "variantKey": "holofoil",
            "conditions": {
                "NM": {"currencyCode": "USD", "low": 14.0, "market": 15.0, "mid": 15.0,
                       "high": 16.0, "directLow": 13.5, "trend": 15.2},
                "LP": {"currencyCode": "USD", "low": 10.0, "market": 11.0, "mid": 11.0,
                       "high": 12.0, "directLow": None, "trend": None},
            },
        },
        "Reverse Holofoil": {
            "variant": "Reverse Holofoil",
            "variantKey": "reverseHolofoil",
            "conditions": {
                "NM": {"currencyCode": "USD", "low": 20.0, "market": 22.0, "mid": 22.0,
                       "high": 24.0, "directLow": None, "trend": None},
            },
        },
    }
}

_GRADED_CONTEXTS = {
    "graders": {
        "PSA": {
            "9": [
                {"grader": "PSA", "grade": "9", "variant": "Holofoil", "variantKey": "holofoil",
                 "isPerfect": False, "isSigned": False, "isError": False,
                 "currencyCode": "USD", "low": 139.0, "market": 140.0, "mid": 140.0,
                 "high": 141.0, "directLow": None, "trend": None},
            ],
            "10": [
                {"grader": "PSA", "grade": "10", "variant": "Holofoil", "variantKey": "holofoil",
                 "isPerfect": False, "isSigned": False, "isError": False,
                 "currencyCode": "USD", "low": 490.0, "market": 500.0, "mid": 500.0,
                 "high": 510.0, "directLow": None, "trend": None},
                {"grader": "PSA", "grade": "10", "variant": "Reverse Holofoil", "variantKey": "reverseHolofoil",
                 "isPerfect": True, "isSigned": False, "isError": False,
                 "currencyCode": "USD", "low": 470.0, "market": 480.0, "mid": 480.0,
                 "high": 490.0, "directLow": None, "trend": None},
            ],
        }
    }
}


class ReconstructRoundTripTests(unittest.TestCase):
    """reconstruct_*_from_cells round-trips price_history_cells_from_contexts:
    decompose -> reconstruct -> decompose == original cells."""

    def setUp(self) -> None:
        self.tempdir, self.connection = _make_db()
        self.addCleanup(self.tempdir.cleanup)

    def _seed_cells(self, raw_contexts, graded_contexts):
        cells = price_history_cells_from_contexts(
            card_id="c1", provider="scrydex", price_date="2026-06-01",
            currency_code="USD", raw_contexts=raw_contexts,
            graded_contexts=graded_contexts, updated_at="2026-06-01T00:00:00Z",
        )
        from catalog_tools import _PRICE_HISTORY_CELL_COLUMNS
        placeholders = ",".join(["?"] * len(_PRICE_HISTORY_CELL_COLUMNS))
        self.connection.executemany(
            f"INSERT INTO card_price_history_cell ({', '.join(_PRICE_HISTORY_CELL_COLUMNS)}) "
            f"VALUES ({placeholders})",
            cells,
        )
        self.connection.commit()
        return cells

    def _key(self, cell_tuple):
        return cell_tuple[4]  # cell_key column index

    def test_raw_round_trip(self) -> None:
        original = self._seed_cells(_RAW_CONTEXTS, None)
        rebuilt = reconstruct_raw_contexts_from_cells(self.connection, "c1", "2026-06-01")
        redecomposed = price_history_cells_from_contexts(
            card_id="c1", provider="scrydex", price_date="2026-06-01",
            currency_code="USD", raw_contexts=rebuilt, graded_contexts=None,
            updated_at="2026-06-01T00:00:00Z",
        )
        self.assertEqual(
            {self._key(c): c for c in original},
            {self._key(c): c for c in redecomposed},
        )

    def test_graded_round_trip_multi_variant_grade_list(self) -> None:
        original = self._seed_cells(None, _GRADED_CONTEXTS)
        rebuilt = reconstruct_graded_contexts_from_cells(self.connection, "c1", "2026-06-01")
        redecomposed = price_history_cells_from_contexts(
            card_id="c1", provider="scrydex", price_date="2026-06-01",
            currency_code="USD", raw_contexts=None, graded_contexts=rebuilt,
            updated_at="2026-06-01T00:00:00Z",
        )
        self.assertEqual(
            {self._key(c): c for c in original},
            {self._key(c): c for c in redecomposed},
        )
        # The multi-variant grade-10 list survived (both variants present).
        self.assertIn("graded|PSA|10|holofoil|p0s0e0", {self._key(c) for c in redecomposed})
        self.assertIn("graded|PSA|10|reverseHolofoil|p1s0e0", {self._key(c) for c in redecomposed})


class WriterCellsVsJsonParityTests(unittest.TestCase):
    """The writer must produce identical cells + default_raw_* whether the existing
    lane is sourced from JSON (json-mode) or reconstructed from cells (cells-mode),
    including the graded-only-update-preserves-raw case."""

    def _run_full_scenario(self, *, cells_mode: bool):
        prev = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "cells" if cells_mode else "json"
        try:
            tempdir, connection = _make_db()
            try:
                # 1) full raw lane write.
                upsert_price_history_daily(
                    connection, card_id="c1", provider="scrydex",
                    price_date="2026-06-01", display_currency_code="USD",
                    raw_contexts=_RAW_CONTEXTS,
                )
                connection.commit()
                # 2) graded-only update on the SAME (card, date). The existing raw
                #    lane must be preserved via the merge — sourced from JSON in
                #    json-mode, from cells in cells-mode.
                upsert_price_history_daily(
                    connection, card_id="c1", provider="scrydex",
                    price_date="2026-06-01", display_currency_code="USD",
                    graded_contexts=_GRADED_CONTEXTS,
                )
                connection.commit()
                cells = _cells_comparable(_cells(connection, "c1", "2026-06-01"))
                defaults = _default_raw_row(connection, "c1", "2026-06-01")
                return cells, defaults
            finally:
                connection.close()
                tempdir.cleanup()
        finally:
            if prev is None:
                os.environ.pop("PRICE_HISTORY_SOURCE", None)
            else:
                os.environ["PRICE_HISTORY_SOURCE"] = prev

    def test_cells_and_defaults_identical_json_vs_cells_sourced(self) -> None:
        json_cells, json_defaults = self._run_full_scenario(cells_mode=False)
        cell_cells, cell_defaults = self._run_full_scenario(cells_mode=True)

        # The raw lane survived the graded-only update in BOTH modes.
        self.assertIn("raw|holofoil|NM", json_cells)
        self.assertIn("raw|holofoil|NM", cell_cells)
        # Graded cells were added in BOTH modes.
        self.assertIn("graded|PSA|9|holofoil|p0s0e0", json_cells)
        self.assertIn("graded|PSA|9|holofoil|p0s0e0", cell_cells)

        self.assertEqual(json_cells, cell_cells)
        self.assertEqual(json_defaults, cell_defaults)


class WriterAgainstSlimTableTests(_CellsModeMixin, unittest.TestCase):
    """The writer works against a table whose JSON columns are gone (slim table):
    no crash, cells still written, default_raw_* still set."""

    def test_writer_no_json_columns(self) -> None:
        tempdir, connection = _make_db(slim=True)
        self.addCleanup(tempdir.cleanup)
        self.addCleanup(connection.close)

        # Sanity: the JSON columns really are gone.
        daily_cols = {r["name"] for r in connection.execute("PRAGMA table_info(card_price_history_daily)").fetchall()}
        self.assertNotIn("raw_contexts_json", daily_cols)
        self.assertNotIn("graded_contexts_json", daily_cols)
        self.assertNotIn("source_url", daily_cols)
        self.assertNotIn("source_payload_json", daily_cols)

        # Full raw write, then graded-only update (must preserve raw via cells).
        upsert_price_history_daily(
            connection, card_id="c1", provider="scrydex",
            price_date="2026-06-01", display_currency_code="USD",
            raw_contexts=_RAW_CONTEXTS,
        )
        connection.commit()
        upsert_price_history_daily(
            connection, card_id="c1", provider="scrydex",
            price_date="2026-06-01", display_currency_code="USD",
            graded_contexts=_GRADED_CONTEXTS,
        )
        connection.commit()

        cells = _cells(connection, "c1", "2026-06-01")
        self.assertIn("raw|holofoil|NM", cells)        # raw preserved
        self.assertIn("raw|holofoil|LP", cells)
        self.assertIn("graded|PSA|9|holofoil|p0s0e0", cells)
        self.assertIn("graded|PSA|10|reverseHolofoil|p1s0e0", cells)

        # default_raw_* still computed and written on the slim row.
        defaults = _default_raw_row(connection, "c1", "2026-06-01")
        self.assertEqual(defaults["default_raw_variant"], "Holofoil")
        self.assertEqual(defaults["default_raw_condition"], "NM")
        self.assertEqual(defaults["default_raw_market_price"], 15.0)

        # And it matches what the JSON-columns path would have produced.
        os.environ["PRICE_HISTORY_SOURCE"] = "json"
        try:
            tempdir2, connection2 = _make_db(slim=False)
            self.addCleanup(tempdir2.cleanup)
            self.addCleanup(connection2.close)
            upsert_price_history_daily(
                connection2, card_id="c1", provider="scrydex",
                price_date="2026-06-01", display_currency_code="USD",
                raw_contexts=_RAW_CONTEXTS,
            )
            connection2.commit()
            upsert_price_history_daily(
                connection2, card_id="c1", provider="scrydex",
                price_date="2026-06-01", display_currency_code="USD",
                graded_contexts=_GRADED_CONTEXTS,
            )
            connection2.commit()
            self.assertEqual(
                _cells_comparable(cells),
                _cells_comparable(_cells(connection2, "c1", "2026-06-01")),
            )
            self.assertEqual(defaults, _default_raw_row(connection2, "c1", "2026-06-01"))
        finally:
            os.environ["PRICE_HISTORY_SOURCE"] = "cells"


if __name__ == "__main__":
    unittest.main()
