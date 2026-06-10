from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import catalog_tools  # noqa: E402
from catalog_tools import (  # noqa: E402
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    _coerce_price_summary_from_entry,
    _graded_contexts_payload,
    _raw_contexts_payload,
    _resolve_graded_context_entry,
    _resolve_raw_context_summary,
    apply_schema,
    card_price_trend_list,
    connect,
    latest_price_history_update_for_context,
    price_history_cell_rows_for_day,
    price_history_cells_enabled,
    price_history_rows_for_card,
    price_history_source,
    resolve_graded_entry_from_cells,
    resolve_raw_summary_from_cells,
    upsert_card,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from server import _apply_price_history_cells_schema_patch  # noqa: E402

COMPARE_FIELDS = ("currencyCode", "low", "market", "mid", "high", "directLow", "trend")
SCRYDEX = "scrydex"


def _sig(summary):
    if summary is None:
        return None
    return tuple(summary.get(field) for field in COMPARE_FIELDS)


class PriceHistoryCellParityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "parity.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        upsert_card(
            self.connection,
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
        self.connection.commit()
        self._seed()

    def _raw(self, *, variant, condition, market, date="2026-06-01"):
        upsert_price_history_daily(
            self.connection,
            card_id="c1",
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX,
            price_date=date,
            currency_code="USD",
            variant=variant,
            condition=condition,
            low_price=market - 1,
            market_price=market,
            mid_price=market + 0.5,
            high_price=market + 1,
            direct_low_price=market - 2,
            trend_price=market + 0.25,
            payload={"provider": SCRYDEX, "variantKey": variant[:1].lower() + variant[1:].replace(" ", "")},
        )

    def _graded(self, *, grader, grade, variant, market, date="2026-06-01", **flags):
        upsert_price_history_daily(
            self.connection,
            card_id="c1",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider=SCRYDEX,
            price_date=date,
            currency_code="USD",
            variant=variant,
            grader=grader,
            grade=grade,
            low_price=market - 5,
            market_price=market,
            mid_price=market + 1,
            high_price=market + 5,
            direct_low_price=market - 6,
            trend_price=market + 2,
            payload={"provider": SCRYDEX, "variantKey": variant[:1].lower() + variant[1:].replace(" ", "")},
            **flags,
        )

    def _seed(self) -> None:
        # Raw: two variants (Holofoil label -> holofoil key; Reverse Holofoil ->
        # reverseHolofoil key) with multiple conditions, so default-fallback and
        # condition-priority both exercise.
        self._raw(variant="Holofoil", condition="NM", market=15.0)
        self._raw(variant="Holofoil", condition="LP", market=12.0)
        self._raw(variant="Reverse Holofoil", condition="NM", market=20.0)
        # Graded: a normal entry and a perfect entry on the same grade, so the
        # special-flag preference path exercises.
        self._graded(grader="PSA", grade="10", variant="Holofoil", market=500.0)
        self._graded(grader="PSA", grade="10", variant="Holofoil", market=900.0, is_perfect=True)
        self._graded(grader="PSA", grade="9", variant="Holofoil", market=140.0)
        self.connection.commit()

    # --- direct resolver parity ------------------------------------------

    def _json_raw(self, variant=None, condition=None):
        contexts = _raw_contexts_payload(
            self.connection.execute(
                "SELECT raw_contexts_json FROM card_price_history_daily WHERE card_id='c1' AND price_date='2026-06-01'"
            ).fetchone()["raw_contexts_json"]
        )
        _, _, summary = _resolve_raw_context_summary(contexts, variant=variant, condition=condition)
        return summary

    def _cells_raw(self, variant=None, condition=None):
        cells = price_history_cell_rows_for_day(self.connection, card_id="c1", price_date="2026-06-01")
        _, _, summary = resolve_raw_summary_from_cells(cells, variant=variant, condition=condition)
        return summary

    def test_raw_default_fallback_parity(self) -> None:
        self.assertEqual(_sig(self._json_raw()), _sig(self._cells_raw()))
        # Holofoil/NM is the priority winner; both paths must agree it has market 15.
        self.assertEqual(self._cells_raw()["market"], 15.0)

    def test_raw_specific_variant_condition_parity(self) -> None:
        for variant, condition in (
            ("Holofoil", "NM"),
            ("Holofoil", "LP"),
            ("Reverse Holofoil", "NM"),
        ):
            self.assertEqual(
                _sig(self._json_raw(variant, condition)),
                _sig(self._cells_raw(variant, condition)),
                msg=f"{variant}/{condition}",
            )

    def test_raw_condition_priority_fallback_parity(self) -> None:
        # Reverse Holofoil has only NM; asking for MP must fall back to NM on both.
        self.assertEqual(
            _sig(self._json_raw("Reverse Holofoil", "MP")),
            _sig(self._cells_raw("Reverse Holofoil", "MP")),
        )
        self.assertEqual(self._cells_raw("Reverse Holofoil", "MP")["market"], 20.0)

    def _json_graded(self, grader, grade, variant=None):
        contexts = _graded_contexts_payload(
            self.connection.execute(
                "SELECT graded_contexts_json FROM card_price_history_daily WHERE card_id='c1' AND price_date='2026-06-01'"
            ).fetchone()["graded_contexts_json"]
        )
        entry = _resolve_graded_context_entry(contexts, grader=grader, grade=grade, variant=variant)
        return _coerce_price_summary_from_entry(entry)

    def _cells_graded(self, grader, grade, variant=None):
        cells = price_history_cell_rows_for_day(self.connection, card_id="c1", price_date="2026-06-01")
        cell = resolve_graded_entry_from_cells(cells, grader=grader, grade=grade, variant=variant)
        return catalog_tools._cell_summary_from_row(cell) if cell is not None else None

    def test_graded_grader_grade_parity(self) -> None:
        for grader, grade, variant in (
            ("PSA", "10", "Holofoil"),
            ("PSA", "10", None),
            ("PSA", "9", "Holofoil"),
        ):
            self.assertEqual(
                _sig(self._json_graded(grader, grade, variant)),
                _sig(self._cells_graded(grader, grade, variant)),
                msg=f"{grader}/{grade}/{variant}",
            )

    def test_graded_default_picks_the_same_entry_on_both_paths(self) -> None:
        # Grade 10 has a normal (500) and a perfect (900) entry. With no variant
        # given, the JSON resolver returns the "preferred" (special) bucket first;
        # the cell resolver must replicate that EXACT choice, whichever it is.
        self.assertEqual(_sig(self._json_graded("PSA", "10")), _sig(self._cells_graded("PSA", "10")))
        # And specifying the variant returns the non-special entry on both paths.
        self.assertEqual(self._json_graded("PSA", "10", "Holofoil")["market"], 500.0)
        self.assertEqual(self._cells_graded("PSA", "10", "Holofoil")["market"], 500.0)

    # --- flag-routed reader parity ---------------------------------------

    def _rows_market(self, **kwargs):
        rows = price_history_rows_for_card(self.connection, "c1", provider=SCRYDEX, days=30, **kwargs)
        return [(r["market"], r["currencyCode"], r["variant"], r["condition"]) for r in rows]

    def test_price_history_rows_for_card_flag_parity(self) -> None:
        with patch.dict(os.environ, {"PRICE_HISTORY_SOURCE": "json"}):
            json_raw = self._rows_market(pricing_mode=RAW_PRICING_MODE, variant="Holofoil", condition="NM")
            json_graded = self._rows_market(
                pricing_mode=PSA_GRADE_PRICING_MODE, grader="PSA", grade="10", variant="Holofoil"
            )
            json_default = self._rows_market(pricing_mode=RAW_PRICING_MODE)
        with patch.dict(os.environ, {"PRICE_HISTORY_SOURCE": "cells"}):
            self.assertTrue(price_history_cells_enabled())
            cells_raw = self._rows_market(pricing_mode=RAW_PRICING_MODE, variant="Holofoil", condition="NM")
            cells_graded = self._rows_market(
                pricing_mode=PSA_GRADE_PRICING_MODE, grader="PSA", grade="10", variant="Holofoil"
            )
            cells_default = self._rows_market(pricing_mode=RAW_PRICING_MODE)
        self.assertEqual(json_raw, cells_raw)
        self.assertEqual(json_graded, cells_graded)
        self.assertEqual(json_default, cells_default)

    def test_latest_update_for_context_flag_parity(self) -> None:
        with patch.dict(os.environ, {"PRICE_HISTORY_SOURCE": "json"}):
            json_raw = latest_price_history_update_for_context(
                self.connection, card_id="c1", provider=SCRYDEX,
                pricing_mode=RAW_PRICING_MODE, variant="Holofoil", condition="NM",
            )
            json_graded = latest_price_history_update_for_context(
                self.connection, card_id="c1", provider=SCRYDEX,
                pricing_mode=PSA_GRADE_PRICING_MODE, grader="PSA", grade="10",
            )
        with patch.dict(os.environ, {"PRICE_HISTORY_SOURCE": "cells"}):
            cells_raw = latest_price_history_update_for_context(
                self.connection, card_id="c1", provider=SCRYDEX,
                pricing_mode=RAW_PRICING_MODE, variant="Holofoil", condition="NM",
            )
            cells_graded = latest_price_history_update_for_context(
                self.connection, card_id="c1", provider=SCRYDEX,
                pricing_mode=PSA_GRADE_PRICING_MODE, grader="PSA", grade="10",
            )
        self.assertEqual(json_raw, cells_raw)
        self.assertEqual(json_graded, cells_graded)
        self.assertIsNotNone(cells_raw)

    def test_card_price_trend_list_flag_parity(self) -> None:
        # Multi-day raw + graded series so the point lists are non-trivial.
        self._raw(variant="Holofoil", condition="NM", market=16.0, date="2026-06-02")
        self._graded(grader="PSA", grade="10", variant="Holofoil", market=520.0, date="2026-06-02")
        # The trend-list orders/keys its rows off the card_price_snapshots row
        # (untouched by the flag); seed it so both lanes emit real rows.
        upsert_price_snapshot(
            self.connection, card_id="c1", provider=SCRYDEX, pricing_mode=RAW_PRICING_MODE,
            currency_code="USD", variant="Holofoil", condition="NM",
            low_price=15.0, market_price=16.0, mid_price=16.5, high_price=17.0,
            payload={"provider": SCRYDEX, "variantKey": "holofoil"},
        )
        upsert_price_snapshot(
            self.connection, card_id="c1", provider=SCRYDEX, pricing_mode=PSA_GRADE_PRICING_MODE,
            currency_code="USD", variant="Holofoil", grader="PSA", grade="10",
            low_price=515.0, market_price=520.0, mid_price=521.0, high_price=525.0,
            payload={"provider": SCRYDEX, "variantKey": "holofoil"},
        )
        self.connection.commit()

        def trend(mode, **kwargs):
            return card_price_trend_list(
                self.connection, "c1", mode=mode, provider=SCRYDEX, days=90, **kwargs
            )

        with patch.dict(os.environ, {"PRICE_HISTORY_SOURCE": "json"}):
            json_raw = trend("raw")
            json_graded = trend("graded")
        with patch.dict(os.environ, {"PRICE_HISTORY_SOURCE": "cells"}):
            cells_raw = trend("raw")
            cells_graded = trend("graded")
        # Point series come from history-daily (flag-gated); compare those.
        self.assertEqual(
            [(r["key"], r["points"]) for r in json_raw["rows"]],
            [(r["key"], r["points"]) for r in cells_raw["rows"]],
        )
        self.assertEqual(
            [(r["key"], r["points"]) for r in json_graded["rows"]],
            [(r["key"], r["points"]) for r in cells_graded["rows"]],
        )

    def test_flag_default_is_json(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
            self.assertEqual(price_history_source(), "json")
            self.assertFalse(price_history_cells_enabled())


if __name__ == "__main__":
    unittest.main()
