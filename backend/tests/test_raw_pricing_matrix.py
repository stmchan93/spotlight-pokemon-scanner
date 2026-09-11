from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_price_snapshot,
)
from server import SpotlightScanService  # noqa: E402


class RawPricingMatrixTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "matrix.sqlite"
        self.connection = connect(self.database_path)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            self.connection,
            card_id="cl1-15",
            name="Chansey",
            set_name="Celebrations: Classic Collection",
            number="15/034",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="cl1-15",
            set_id="cl1",
            set_series="Celebrations",
            supertype="Pokemon",
        )
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def _seed_raw_contexts(self, raw_contexts: dict) -> None:
        upsert_price_snapshot(
            self.connection,
            card_id="cl1-15",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="holofoil",
            market_price=7.36,
            source_url="https://prices.example/cl1-15",
            payload={"provider": "scrydex"},
        )
        self.connection.execute(
            "UPDATE card_price_snapshots SET raw_contexts_json = ? WHERE card_id = ?",
            (json.dumps(raw_contexts), "cl1-15"),
        )
        self.connection.commit()

    def test_returns_flattened_variant_condition_rows_in_priority_order(self) -> None:
        self._seed_raw_contexts(
            {
                "variants": {
                    "Reverse Holofoil": {
                        "variant": "Reverse Holofoil",
                        "variantKey": "reverseHolofoil",
                        "conditions": {
                            "NM": {"currencyCode": "USD", "market": 4.20, "low": 3.00, "mid": 3.80, "high": 5.10},
                            "LP": {"currencyCode": "USD", "market": 2.95, "low": 2.10, "mid": 2.70, "high": 3.60},
                        },
                    },
                    "Holofoil": {
                        "variant": "Holofoil",
                        "variantKey": "holofoil",
                        "conditions": {
                            "NM": {"currencyCode": "USD", "market": 7.36, "low": 6.10, "mid": 6.80, "high": 9.00},
                            "LP": {"currencyCode": "USD", "market": 5.10, "low": 4.20, "mid": 4.70, "high": 6.20},
                            "MP": {"currencyCode": "USD", "market": 3.40, "low": 2.50, "mid": 3.00, "high": 4.10},
                        },
                    },
                    "Normal": {
                        "variant": "Normal",
                        "variantKey": "normal",
                        "conditions": {
                            "NM": {"currencyCode": "USD", "market": 1.10, "low": 0.80, "mid": 1.00, "high": 1.50},
                        },
                    },
                },
            }
        )

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            payload = service.raw_pricing_matrix("cl1-15")
        finally:
            service.connection.close()

        self.assertEqual(payload["cardID"], "cl1-15")
        self.assertEqual(payload["currencyCode"], "USD")
        variants = payload["variants"]
        self.assertEqual([variant["variant"] for variant in variants], ["Normal", "Holofoil", "Reverse Holofoil"])

        holofoil = next(variant for variant in variants if variant["variant"] == "Holofoil")
        self.assertEqual(holofoil["variantKey"], "holofoil")
        self.assertEqual([condition["code"] for condition in holofoil["conditions"]], ["NM", "LP", "MP"])
        nm_row = holofoil["conditions"][0]
        self.assertEqual(nm_row["label"], "Near Mint")
        self.assertEqual(nm_row["market"], 7.36)
        lp_row = holofoil["conditions"][1]
        self.assertEqual(lp_row["label"], "Lightly Played")
        self.assertEqual(lp_row["market"], 5.10)

    def test_returns_empty_variants_when_no_cached_data(self) -> None:
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            payload = service.raw_pricing_matrix("cl1-15")
        finally:
            service.connection.close()

        self.assertEqual(payload["cardID"], "cl1-15")
        self.assertEqual(payload["variants"], [])

    def test_skips_variants_with_no_priced_conditions(self) -> None:
        self._seed_raw_contexts(
            {
                "variants": {
                    "Holofoil": {
                        "variant": "Holofoil",
                        "variantKey": "holofoil",
                        "conditions": {},
                    },
                    "Normal": {
                        "variant": "Normal",
                        "variantKey": "normal",
                        "conditions": {
                            "NM": {"currencyCode": "USD", "market": 1.25},
                        },
                    },
                },
            }
        )

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            payload = service.raw_pricing_matrix("cl1-15")
        finally:
            service.connection.close()

        variants = payload["variants"]
        self.assertEqual([variant["variant"] for variant in variants], ["Normal"])

    def test_vintage_leads_with_unlimited_not_first_edition(self) -> None:
        """The tray quotes whatever lands first here.

        Vintage printings are none of Normal / Holofoil / Reverse Holofoil, so
        this sort used to fall through to the label itself — a plain
        alphabetical order, where "First Edition" beats "Unlimited". Neo Genesis
        Wooper stored its default as Unlimited at $3.09 while the scan tray
        quoted First Edition at $9.12 for the same card (user, 2026-09-10). The
        scanner reads artwork and cannot see an edition stamp, so a printing it
        never detected must never be the one quoted, and it errs HIGH, which at
        a show is what someone gets offered.
        """
        self._seed_raw_contexts(
            {
                "variants": {
                    "First Edition": {
                        "variant": "First Edition",
                        "variantKey": "firstEdition",
                        "conditions": {"NM": {"currencyCode": "USD", "market": 9.12}},
                    },
                    "Unlimited": {
                        "variant": "Unlimited",
                        "variantKey": "unlimited",
                        "conditions": {"NM": {"currencyCode": "USD", "market": 3.09}},
                    },
                },
            }
        )

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            payload = service.raw_pricing_matrix("cl1-15")
        finally:
            service.connection.close()

        variants = payload["variants"]
        self.assertEqual(
            [variant["variant"] for variant in variants],
            ["Unlimited", "First Edition"],
        )
        # First Edition is still one tap away — suppressed as the DEFAULT, not
        # hidden from someone who knows what they are holding.
        self.assertEqual(variants[1]["conditions"][0]["market"], 9.12)

    def test_the_matrix_and_the_stored_default_agree_on_the_leading_printing(self) -> None:
        """Two rankings for one decision is what let them drift apart.

        Asserted against `_resolve_default_raw_context` rather than against a
        hard-coded name, so a future change to the ordering has to move BOTH or
        fail here.
        """
        from catalog_tools import _resolve_default_raw_context

        raw_contexts = {
            "variants": {
                "First Edition Shadowless Holofoil": {
                    "variant": "First Edition Shadowless Holofoil",
                    "variantKey": "firstEditionShadowlessHolofoil",
                    "conditions": {"NM": {"currencyCode": "USD", "market": 310.0}},
                },
                "Unlimited Holofoil": {
                    "variant": "Unlimited Holofoil",
                    "variantKey": "unlimitedHolofoil",
                    "conditions": {"NM": {"currencyCode": "USD", "market": 630.39}},
                },
                "Metal": {
                    "variant": "Metal",
                    "variantKey": "metal",
                    "conditions": {"NM": {"currencyCode": "USD", "market": 311.26}},
                },
            },
        }
        self._seed_raw_contexts(raw_contexts)

        service = SpotlightScanService(self.database_path, REPO_ROOT)
        try:
            payload = service.raw_pricing_matrix("cl1-15")
        finally:
            service.connection.close()

        default_variant, _, _ = _resolve_default_raw_context(raw_contexts)
        self.assertEqual(payload["variants"][0]["variant"], default_variant)
        self.assertEqual(default_variant, "Unlimited Holofoil")


if __name__ == "__main__":
    unittest.main()
