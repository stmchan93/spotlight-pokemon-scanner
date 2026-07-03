"""Regression guard: a graded owned entry whose stored slab `variant_name` has
NO price for its grade must FALL BACK to an available graded variant and SHOW
that price on the collection tile — consistent with the PDP — instead of
blanking.

Concrete bug: Registeel PSA 10 owned as variant "League Stamp", where the only
PSA-10 price is for variant "Normal" ($49). The collection tile went blank while
the PDP showed the $49 fallback. Cause: the graded variant-match guard in
`_display_pricing_summary_for_context` rejected the fallback ("Normal") because
its variant != the requested ("League Stamp"). The fix: when a non-null preferred
variant has no exact graded price and the resolver falls back to an available
graded variant, SHOW the fallback price (product-desired) instead of returning
None.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    PSA_GRADE_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_price_snapshot,
)
from server import (  # noqa: E402
    PricingContext,
    SpotlightScanService,
    _apply_price_history_cells_schema_patch,
)

CARD_ID = "gvpf-registeel-1"
GRADER = "PSA"
GRADE = "10"
PRICED_VARIANT = "normal"       # the ONLY variant with a PSA-10 price
UNPRICED_VARIANT = "League Stamp"  # owned slab's variant_name — no PSA-10 price
NORMAL_MARKET = 49.0


class GradedVariantPriceFallbackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "graded-variant-fallback.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        upsert_card(
            connection,
            card_id=CARD_ID,
            name="Registeel",
            set_name="Test Set",
            number="1",
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=CARD_ID,
        )
        # Seed a PSA-10 graded snapshot for ONLY the "Normal" printing ($49). No
        # PSA-10 price exists for "League Stamp".
        upsert_price_snapshot(
            connection,
            card_id=CARD_ID,
            provider="scrydex",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            grader=GRADER,
            grade=GRADE,
            variant=PRICED_VARIANT,
            market_price=NORMAL_MARKET,
            low_price=NORMAL_MARKET - 4,
            mid_price=NORMAL_MARKET,
            high_price=NORMAL_MARKET + 6,
            currency_code="USD",
            display_currency_code="USD",
        )
        connection.commit()
        connection.close()

        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

        self._prev_source = os.environ.get("PRICE_HISTORY_SOURCE")
        os.environ["PRICE_HISTORY_SOURCE"] = "cells"
        self.addCleanup(self._restore_source)

    def _restore_source(self) -> None:
        if self._prev_source is None:
            os.environ.pop("PRICE_HISTORY_SOURCE", None)
        else:
            os.environ["PRICE_HISTORY_SOURCE"] = self._prev_source

    def _display(self, preferred_variant: str | None) -> dict | None:
        return self.service._display_pricing_summary_for_context(
            CARD_ID,
            pricing_context=PricingContext(
                mode="graded",
                grader=GRADER,
                grade=GRADE,
                preferred_variant=preferred_variant,
            ),
        )

    def test_unpriced_variant_falls_back_to_available_graded_price(self) -> None:
        # Owned as "League Stamp" PSA 10, which has no PSA-10 price. Must fall
        # back to the "Normal" $49 graded price and SHOW it (not blank the tile).
        pricing = self._display(UNPRICED_VARIANT)
        self.assertIsNotNone(pricing)
        self.assertEqual(pricing["market"], NORMAL_MARKET)
        # The surfaced price is the available graded variant.
        self.assertEqual(str(pricing["variant"]).lower(), "normal")

    def test_exact_variant_match_unchanged(self) -> None:
        # Owned as the priced "normal" variant: exact match, still $49.
        pricing = self._display(PRICED_VARIANT)
        self.assertIsNotNone(pricing)
        self.assertEqual(pricing["market"], NORMAL_MARKET)
        self.assertEqual(str(pricing["variant"]).lower(), "normal")


if __name__ == "__main__":
    unittest.main()
