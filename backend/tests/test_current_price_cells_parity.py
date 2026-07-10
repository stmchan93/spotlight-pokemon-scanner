"""Parity tests for the cells-first CURRENT-price path.

Proves that ``SpotlightScanService._pricing_summary_from_snapshot_row`` returns
the same price-bearing summary whether it resolves from the normalized
``card_price_history_cell`` table (NEW, ``day_cells`` supplied) or the
``card_price_snapshots`` JSON-context blobs (OLD, ``day_cells=None``), for raw,
graded, and scalar-default cards.

The snapshot row carries no price_date; its CURRENT price corresponds to the
latest daily-history date, whose cells are written by the dual-write inside
``upsert_price_history_daily``. So each test seeds the snapshot AND the daily
history from the SAME provider data on the same date, then resolves both ways
against the SAME snapshot row.

2026-07 re-port additions (vs the June 936c074 version of this file):
- Graded contexts carrying ``variant_hints`` are now resolved ON the cells path
  via ``_resolve_best_graded_cell`` (the ranked resolver) instead of deferring
  to the JSON blobs — the hinted tests below pin that both paths pick the same
  hint-ranked variant.
- A preferred variant with no cell falls back internally (tier 1 of
  ``_resolve_best_graded_cell`` falls through to tiers 2/3); no explicit
  retry-without-variant remains, and the fallback test pins the parity.
- Raw phantom suppression (raw NM > own PSA 10) applies on the cells path too,
  via the ``_is_raw_phantom_price_from_cells`` twin.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    price_history_cell_rows_for_day,
    upsert_card,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from scrydex_adapter import SCRYDEX_PROVIDER  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

# The price-bearing fields the cells path must reproduce byte-for-byte.
PRICE_FIELDS = (
    "currencyCode",
    "low",
    "market",
    "mid",
    "high",
    "directLow",
    "trend",
    "variant",
    "provider",
    "grader",
    "grade",
    "pricingMode",
)
PRICE_DATE = "2026-06-01"


class _ParityShim(SpotlightScanService):
    """SpotlightScanService whose __init__ only holds a connection, so the
    pricing-resolution methods can be exercised without the heavy bootstrap."""

    def __init__(self, connection: sqlite3.Connection) -> None:  # noqa: D401
        self._conn = connection

    @property
    def connection(self) -> sqlite3.Connection:  # type: ignore[override]
        return self._conn


class CurrentPriceCellsParityTests(unittest.TestCase):
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
        # A second card that only ever gets scalar default_raw_* prices (no
        # context entries) so the scalar-fallback path is covered.
        upsert_card(
            self.connection,
            card_id="c2",
            name="Bulbasaur",
            set_name="Base Set",
            number="44/102",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="c2",
        )
        self.connection.commit()
        self.shim = _ParityShim(self.connection)

    # --- seeding helpers --------------------------------------------------

    def _seed_raw(self, card_id, *, variant, condition, market):
        kwargs = dict(
            currency_code="USD",
            variant=variant,
            condition=condition,
            low_price=market - 1,
            market_price=market,
            mid_price=market + 0.5,
            high_price=market + 1,
            direct_low_price=market - 2,
            trend_price=market + 0.25,
            payload={
                "provider": SCRYDEX_PROVIDER,
                "variantKey": variant[:1].lower() + variant[1:].replace(" ", ""),
            },
        )
        # Daily history (auto-writes cells) + snapshot from the SAME data.
        upsert_price_history_daily(
            self.connection,
            card_id=card_id,
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX_PROVIDER,
            price_date=PRICE_DATE,
            **kwargs,
        )
        upsert_price_snapshot(
            self.connection,
            card_id=card_id,
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX_PROVIDER,
            **kwargs,
        )

    def _seed_graded(self, card_id, *, grader, grade, variant, market, **flags):
        kwargs = dict(
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
            payload={
                "provider": SCRYDEX_PROVIDER,
                "variantKey": variant[:1].lower() + variant[1:].replace(" ", ""),
            },
            **flags,
        )
        upsert_price_history_daily(
            self.connection,
            card_id=card_id,
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider=SCRYDEX_PROVIDER,
            price_date=PRICE_DATE,
            **kwargs,
        )
        upsert_price_snapshot(
            self.connection,
            card_id=card_id,
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider=SCRYDEX_PROVIDER,
            **kwargs,
        )

    def _seed_scalar_only(self, card_id, *, market):
        # Write a daily row + snapshot that have ONLY default_raw_* scalars and no
        # context entries (raw_contexts stays '{}'), so the JSON path takes its
        # scalar-default branch and there are no raw cells.
        upsert_price_history_daily(
            self.connection,
            card_id=card_id,
            provider=SCRYDEX_PROVIDER,
            price_date=PRICE_DATE,
            display_currency_code="USD",
            default_raw_variant="Normal",
            default_raw_condition="NM",
            default_raw_low_price=market - 1,
            default_raw_market_price=market,
            default_raw_mid_price=market + 0.5,
            default_raw_high_price=market + 1,
            default_raw_direct_low_price=market - 2,
            default_raw_trend_price=market + 0.25,
        )
        upsert_price_snapshot(
            self.connection,
            card_id=card_id,
            provider=SCRYDEX_PROVIDER,
            display_currency_code="USD",
            default_raw_variant="Normal",
            default_raw_condition="NM",
            default_raw_low_price=market - 1,
            default_raw_market_price=market,
            default_raw_mid_price=market + 0.5,
            default_raw_high_price=market + 1,
            default_raw_direct_low_price=market - 2,
            default_raw_trend_price=market + 0.25,
        )

    # --- assertion helper -------------------------------------------------

    def _both_paths(self, card_id, pricing_context):
        snapshot_row = self.connection.execute(
            "SELECT * FROM card_price_snapshots WHERE card_id = ? LIMIT 1", (card_id,)
        ).fetchone()
        cells = price_history_cell_rows_for_day(self.connection, card_id=card_id, price_date=PRICE_DATE)
        with patch.dict(os.environ, {"PRICE_HISTORY_SOURCE": "cells"}):
            json_pricing = self.shim._pricing_summary_from_snapshot_row(
                snapshot_row, pricing_context=pricing_context, day_cells=None
            )
            cells_pricing = self.shim._pricing_summary_from_snapshot_row(
                snapshot_row, pricing_context=pricing_context, day_cells=cells
            )
        return json_pricing, cells_pricing

    def _sig(self, pricing):
        return None if pricing is None else tuple(pricing.get(f) for f in PRICE_FIELDS)

    # --- tests ------------------------------------------------------------

    def test_raw_default_variant_parity(self) -> None:
        self._seed_raw("c1", variant="Holofoil", condition="NM", market=15.0)
        self._seed_raw("c1", variant="Holofoil", condition="LP", market=12.0)
        self._seed_raw("c1", variant="Reverse Holofoil", condition="NM", market=20.0)
        self.connection.commit()
        json_pricing, cells_pricing = self._both_paths("c1", self.shim._raw_pricing_context())
        self.assertIsNotNone(cells_pricing)
        self.assertEqual(self._sig(json_pricing), self._sig(cells_pricing))
        # Holofoil/NM wins the default; both must report market 15.
        self.assertEqual(cells_pricing["market"], 15.0)

    def test_raw_specific_variant_condition_parity(self) -> None:
        self._seed_raw("c1", variant="Holofoil", condition="NM", market=15.0)
        self._seed_raw("c1", variant="Holofoil", condition="LP", market=12.0)
        self._seed_raw("c1", variant="Reverse Holofoil", condition="NM", market=20.0)
        self.connection.commit()
        for variant, condition in (
            ("Holofoil", "NM"),
            ("Holofoil", "LP"),
            ("Reverse Holofoil", "NM"),
            ("Reverse Holofoil", "MP"),  # falls back to NM on both paths
        ):
            ctx = self.shim._raw_pricing_context(
                preferred_variant=variant, preferred_condition=condition
            )
            json_pricing, cells_pricing = self._both_paths("c1", ctx)
            self.assertEqual(
                self._sig(json_pricing), self._sig(cells_pricing), msg=f"{variant}/{condition}"
            )

    def test_graded_parity(self) -> None:
        self._seed_graded("c1", grader="PSA", grade="10", variant="Holofoil", market=500.0)
        self._seed_graded(
            "c1", grader="PSA", grade="10", variant="Holofoil", market=900.0, is_perfect=True
        )
        self._seed_graded("c1", grader="PSA", grade="9", variant="Holofoil", market=140.0)
        self.connection.commit()
        for grade, variant in (("10", "Holofoil"), ("10", None), ("9", "Holofoil")):
            ctx = self.shim._slab_pricing_context(grader="PSA", grade=grade, preferred_variant=variant)
            json_pricing, cells_pricing = self._both_paths("c1", ctx)
            self.assertEqual(
                self._sig(json_pricing), self._sig(cells_pricing), msg=f"PSA {grade} {variant}"
            )
        # Variant-specified grade 10 returns the non-special entry (500) on both.
        ctx = self.shim._slab_pricing_context(grader="PSA", grade="10", preferred_variant="Holofoil")
        json_pricing, cells_pricing = self._both_paths("c1", ctx)
        self.assertEqual(cells_pricing["market"], 500.0)
        self.assertEqual(cells_pricing["grader"], "PSA")
        self.assertEqual(cells_pricing["grade"], "10")

    def test_graded_variant_hints_resolved_on_cells_path(self) -> None:
        # THE improvement over the June port: hinted graded contexts used to
        # return None from the cells helper (defer-to-JSON). They must now
        # resolve on the cells path via the ranked resolver AND pick the same
        # entry the JSON hint-ranking picks. Pool mirrors the real base1-63
        # PSA-10 shape (First Edition Shadowless vs Unlimited vs Unlimited
        # Shadowless, plus an error record that must never win).
        self._seed_graded("c1", grader="PSA", grade="10", variant="First Edition Shadowless", market=305.13)
        self._seed_graded("c1", grader="PSA", grade="10", variant="Unlimited", market=428.81)
        self._seed_graded("c1", grader="PSA", grade="10", variant="Unlimited Shadowless", market=953.21)
        self._seed_graded(
            "c1", grader="PSA", grade="10", variant="Unlimited Shadowless", market=1775.0, is_error=True
        )
        self.connection.commit()
        for hints, expected_market in (
            (
                {"shadowless": True, "firstEdition": False, "redCheeks": False, "yellowCheeks": False, "jumbo": False},
                953.21,
            ),
            (
                {"shadowless": True, "firstEdition": True, "redCheeks": False, "yellowCheeks": False, "jumbo": False},
                305.13,
            ),
            (
                {"shadowless": False, "firstEdition": None, "redCheeks": False, "yellowCheeks": False, "jumbo": False},
                428.81,
            ),
        ):
            ctx = self.shim._slab_pricing_context(
                grader="PSA", grade="10", variant_hints=hints
            )
            json_pricing, cells_pricing = self._both_paths("c1", ctx)
            self.assertIsNotNone(cells_pricing, msg=f"hints={hints}")
            self.assertEqual(self._sig(json_pricing), self._sig(cells_pricing), msg=f"hints={hints}")
            self.assertEqual(cells_pricing["market"], expected_market, msg=f"hints={hints}")
            self.assertNotEqual(cells_pricing["market"], 1775.0)

    def test_graded_missing_preferred_variant_falls_back_internally(self) -> None:
        # preferred_variant with NO cell for it: _resolve_best_graded_cell's
        # tier 1 falls through internally to the simple default pick — the June
        # code's explicit retry-without-variant is subsumed. Two layers to pin:
        # 1) the cells helper itself resolves the fallback entry (proving no
        #    explicit retry is needed), and
        # 2) the full summary is then rejected by the SAME final variant-match
        #    guard on both paths (resolved "Holofoil" != requested "League
        #    Stamp"), so parity holds; the intentional show-the-fallback-price
        #    behavior lives one level up in _display_pricing_summary_for_context
        #    (used_graded_variant_fallback), unchanged by this port.
        self._seed_graded("c1", grader="PSA", grade="10", variant="Holofoil", market=500.0)
        self.connection.commit()
        ctx = self.shim._slab_pricing_context(
            grader="PSA", grade="10", preferred_variant="League Stamp"
        )
        snapshot_row = self.connection.execute(
            "SELECT * FROM card_price_snapshots WHERE card_id = 'c1' LIMIT 1"
        ).fetchone()
        cells = price_history_cell_rows_for_day(
            self.connection, card_id="c1", price_date=PRICE_DATE
        )
        with patch.dict(os.environ, {"PRICE_HISTORY_SOURCE": "cells"}):
            resolution = self.shim._cells_summary_from_snapshot_row(
                snapshot_row, pricing_context=ctx, day_cells=cells
            )
        self.assertIsNotNone(resolution)
        resolved_variant, summary = resolution
        self.assertEqual(resolved_variant, "Holofoil")
        self.assertEqual(summary["market"], 500.0)
        # Full-path parity: the shared final guard rejects the mismatched
        # variant identically on both read sources.
        json_pricing, cells_pricing = self._both_paths("c1", ctx)
        self.assertIsNone(json_pricing)
        self.assertIsNone(cells_pricing)

    def test_raw_phantom_suppression_parity(self) -> None:
        # Single-printing card whose raw NM sits far above its own PSA 10: the
        # JSON branch nulls the price fields (phantom guard). The cells branch
        # must apply the same suppression via _is_raw_phantom_price_from_cells,
        # not silently resurface the fake number.
        self._seed_raw("c1", variant="Normal", condition="NM", market=500.0)
        self._seed_graded("c1", grader="PSA", grade="10", variant="Normal", market=100.0)
        self.connection.commit()
        json_pricing, cells_pricing = self._both_paths("c1", self.shim._raw_pricing_context())
        self.assertIsNotNone(json_pricing)
        self.assertIsNotNone(cells_pricing)
        self.assertEqual(self._sig(json_pricing), self._sig(cells_pricing))
        self.assertIsNone(cells_pricing["market"])
        self.assertEqual(cells_pricing["suppressionReason"], "phantom")
        self.assertEqual(json_pricing["suppressionReason"], "phantom")

    def test_scalar_default_only_card_parity(self) -> None:
        # Card with only default_raw_* scalars and no context entries / raw cells.
        self._seed_scalar_only("c2", market=7.5)
        self.connection.commit()
        cells = price_history_cell_rows_for_day(self.connection, card_id="c2", price_date=PRICE_DATE)
        # No raw cells exist for this card, so the cells path yields nothing and
        # both paths take the scalar-default branch -> identical output.
        self.assertEqual([c for c in cells if c["lane"] == "raw"], [])
        json_pricing, cells_pricing = self._both_paths("c2", self.shim._raw_pricing_context())
        self.assertIsNotNone(json_pricing)
        self.assertEqual(self._sig(json_pricing), self._sig(cells_pricing))
        self.assertEqual(cells_pricing["market"], 7.5)

    def test_cells_first_does_not_read_json_columns(self) -> None:
        # When cells resolve the price, the fat JSON blobs must NOT be parsed.
        # Simulate the post-migration slim row by NULLing the JSON columns on the
        # snapshot AFTER seeding cells: the cells path must still resolve, proving
        # it never touched raw_contexts_json/graded_contexts_json.
        self._seed_raw("c1", variant="Holofoil", condition="NM", market=15.0)
        self.connection.commit()
        cells = price_history_cell_rows_for_day(self.connection, card_id="c1", price_date=PRICE_DATE)
        snapshot_row = dict(
            self.connection.execute(
                "SELECT * FROM card_price_snapshots WHERE card_id = 'c1' LIMIT 1"
            ).fetchone()
        )
        # Blank out the blobs to prove they are unused on the cells path.
        snapshot_row["raw_contexts_json"] = "{}"
        snapshot_row["graded_contexts_json"] = "{}"
        with patch.dict(os.environ, {"PRICE_HISTORY_SOURCE": "cells"}):
            cells_pricing = self.shim._pricing_summary_from_snapshot_row(
                snapshot_row, pricing_context=self.shim._raw_pricing_context(), day_cells=cells
            )
        self.assertIsNotNone(cells_pricing)
        self.assertEqual(cells_pricing["market"], 15.0)

    def test_day_cells_none_uses_json_path(self) -> None:
        # day_cells=None must keep the JSON path even in cells mode (no N+1 query).
        self._seed_raw("c1", variant="Holofoil", condition="NM", market=15.0)
        self.connection.commit()
        snapshot_row = self.connection.execute(
            "SELECT * FROM card_price_snapshots WHERE card_id = 'c1' LIMIT 1"
        ).fetchone()
        with patch.dict(os.environ, {"PRICE_HISTORY_SOURCE": "cells"}):
            pricing = self.shim._pricing_summary_from_snapshot_row(
                snapshot_row, pricing_context=self.shim._raw_pricing_context(), day_cells=None
            )
        self.assertIsNotNone(pricing)
        self.assertEqual(pricing["market"], 15.0)


if __name__ == "__main__":
    unittest.main()
