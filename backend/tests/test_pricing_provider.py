from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any
from unittest import mock


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from pricing_provider import (  # noqa: E402
    PricingProvider,
    PricingProviderRegistry,
    ProviderMetadata,
    PsaPricingResult,
    RawPricingResult,
)


class FakePricingProvider(PricingProvider):
    def __init__(
        self,
        metadata: ProviderMetadata,
        *,
        ready: bool = True,
        raw_result: RawPricingResult | None = None,
        psa_result: PsaPricingResult | None = None,
    ) -> None:
        self._metadata = metadata
        self._ready = ready
        self._raw_result = raw_result or RawPricingResult(
            success=False,
            provider_id=metadata.provider_id,
            card_id="unknown",
            error="raw failed",
        )
        self._psa_result = psa_result or PsaPricingResult(
            success=False,
            provider_id=metadata.provider_id,
            card_id="unknown",
            grader="PSA",
            grade="10",
            error="psa failed",
        )
        self.raw_calls: list[tuple[Any, str]] = []
        self.psa_calls: list[tuple[Any, str, str, str, str | None, dict[str, Any] | None]] = []

    def get_metadata(self) -> ProviderMetadata:
        return self._metadata

    def is_ready(self) -> bool:
        return self._ready

    def refresh_raw_pricing(self, connection, card_id: str) -> RawPricingResult:
        self.raw_calls.append((connection, card_id))
        return self._raw_result

    def refresh_psa_pricing(
        self,
        connection,
        card_id: str,
        grader: str,
        grade: str,
        preferred_variant: str | None = None,
        variant_hints: dict[str, Any] | None = None,
    ) -> PsaPricingResult:
        self.psa_calls.append(
            (connection, card_id, grader, grade, preferred_variant, variant_hints)
        )
        return self._psa_result


class PricingProviderRegistryTests(unittest.TestCase):
    def test_register_rejects_duplicate_provider_ids(self) -> None:
        registry = PricingProviderRegistry()
        metadata = ProviderMetadata(
            provider_id="scrydex",
            provider_label="Scrydex",
            is_ready=True,
            requires_credentials=False,
            supports_raw_pricing=True,
            supports_psa_pricing=True,
        )
        registry.register(FakePricingProvider(metadata))

        with self.assertRaisesRegex(ValueError, "already registered"):
            registry.register(FakePricingProvider(metadata))

    def test_list_and_get_provider_expose_registered_metadata(self) -> None:
        registry = PricingProviderRegistry()
        provider = FakePricingProvider(
            ProviderMetadata(
                provider_id="scrydex",
                provider_label="Scrydex",
                is_ready=True,
                requires_credentials=False,
                supports_raw_pricing=True,
                supports_psa_pricing=False,
            )
        )
        registry.register(provider)

        self.assertIs(registry.get_provider("scrydex"), provider)
        self.assertIsNone(registry.get_provider("missing"))
        self.assertEqual(registry.list_providers(), [provider.get_metadata()])

    def test_get_active_provider_filters_by_mode_and_readiness(self) -> None:
        registry = PricingProviderRegistry()
        registry.register(
            FakePricingProvider(
                ProviderMetadata(
                    provider_id="not-ready",
                    provider_label="Not Ready",
                    is_ready=False,
                    requires_credentials=False,
                    supports_raw_pricing=True,
                    supports_psa_pricing=True,
                ),
                ready=False,
            )
        )
        raw_only = FakePricingProvider(
            ProviderMetadata(
                provider_id="raw",
                provider_label="Raw",
                is_ready=True,
                requires_credentials=False,
                supports_raw_pricing=True,
                supports_psa_pricing=False,
            )
        )
        psa_only = FakePricingProvider(
            ProviderMetadata(
                provider_id="psa",
                provider_label="PSA",
                is_ready=True,
                requires_credentials=False,
                supports_raw_pricing=False,
                supports_psa_pricing=True,
            )
        )
        both = FakePricingProvider(
            ProviderMetadata(
                provider_id="both",
                provider_label="Both",
                is_ready=True,
                requires_credentials=False,
                supports_raw_pricing=True,
                supports_psa_pricing=True,
            )
        )
        registry.register(raw_only)
        registry.register(psa_only)
        registry.register(both)

        self.assertIs(registry.get_active_provider(for_raw=True), raw_only)
        self.assertIs(registry.get_active_provider(for_raw=False, for_psa=True), psa_only)
        self.assertIs(registry.get_active_provider(for_raw=True, for_psa=True), both)
        self.assertIsNone(registry.get_active_provider(for_raw=False, for_psa=False))

    def test_refresh_raw_pricing_skips_unready_and_returns_first_success(self) -> None:
        registry = PricingProviderRegistry()
        skipped = FakePricingProvider(
            ProviderMetadata(
                provider_id="skip",
                provider_label="Skip",
                is_ready=False,
                requires_credentials=False,
                supports_raw_pricing=True,
                supports_psa_pricing=False,
            ),
            ready=False,
        )
        failed = FakePricingProvider(
            ProviderMetadata(
                provider_id="fail",
                provider_label="Fail",
                is_ready=True,
                requires_credentials=False,
                supports_raw_pricing=True,
                supports_psa_pricing=False,
            ),
            raw_result=RawPricingResult(
                success=False,
                provider_id="fail",
                card_id="base1-4",
                error="upstream timeout",
            ),
        )
        succeeded = FakePricingProvider(
            ProviderMetadata(
                provider_id="ok",
                provider_label="OK",
                is_ready=True,
                requires_credentials=False,
                supports_raw_pricing=True,
                supports_psa_pricing=False,
            ),
            raw_result=RawPricingResult(
                success=True,
                provider_id="ok",
                card_id="base1-4",
                payload={"market": 199.0},
            ),
        )
        registry.register(skipped)
        registry.register(failed)
        registry.register(succeeded)

        result = registry.refresh_raw_pricing(object(), "base1-4")

        self.assertTrue(result.success)
        self.assertEqual(result.provider_id, "ok")
        self.assertEqual(failed.raw_calls, [(mock.ANY, "base1-4")])
        self.assertEqual(succeeded.raw_calls, [(mock.ANY, "base1-4")])
        self.assertEqual(skipped.raw_calls, [])

    def test_refresh_raw_pricing_returns_last_error_when_all_providers_fail(self) -> None:
        registry = PricingProviderRegistry()
        registry.register(
            FakePricingProvider(
                ProviderMetadata(
                    provider_id="fail-a",
                    provider_label="Fail A",
                    is_ready=True,
                    requires_credentials=False,
                    supports_raw_pricing=True,
                    supports_psa_pricing=False,
                ),
                raw_result=RawPricingResult(
                    success=False,
                    provider_id="fail-a",
                    card_id="xy1-1",
                    error="first failure",
                ),
            )
        )
        registry.register(
            FakePricingProvider(
                ProviderMetadata(
                    provider_id="fail-b",
                    provider_label="Fail B",
                    is_ready=True,
                    requires_credentials=False,
                    supports_raw_pricing=True,
                    supports_psa_pricing=False,
                ),
                raw_result=RawPricingResult(
                    success=False,
                    provider_id="fail-b",
                    card_id="xy1-1",
                    error="second failure",
                ),
            )
        )

        result = registry.refresh_raw_pricing(object(), "xy1-1")

        self.assertFalse(result.success)
        self.assertEqual(result.provider_id, "none")
        self.assertEqual(result.error, "second failure")

    def test_refresh_psa_pricing_passes_variant_arguments_and_returns_success(self) -> None:
        registry = PricingProviderRegistry()
        provider = FakePricingProvider(
            ProviderMetadata(
                provider_id="scrydex",
                provider_label="Scrydex",
                is_ready=True,
                requires_credentials=False,
                supports_raw_pricing=False,
                supports_psa_pricing=True,
            ),
            psa_result=PsaPricingResult(
                success=True,
                provider_id="scrydex",
                card_id="basep-9",
                grader="PSA",
                grade="10",
                payload={"market": 167.58},
            ),
        )
        registry.register(provider)

        result = registry.refresh_psa_pricing(
            object(),
            "basep-9",
            "PSA",
            "10",
            preferred_variant="Holofoil",
            variant_hints={"language": "en"},
        )

        self.assertTrue(result.success)
        self.assertEqual(result.provider_id, "scrydex")
        self.assertEqual(
            provider.psa_calls,
            [
                (
                    mock.ANY,
                    "basep-9",
                    "PSA",
                    "10",
                    "Holofoil",
                    {"language": "en"},
                )
            ],
        )

    def test_refresh_psa_pricing_returns_default_error_when_no_provider_is_ready(self) -> None:
        registry = PricingProviderRegistry()

        result = registry.refresh_psa_pricing(object(), "basep-9", "PSA", "9")

        self.assertFalse(result.success)
        self.assertEqual(result.provider_id, "none")
        self.assertEqual(result.error, "No ready providers available for PSA pricing")


if __name__ == "__main__":
    unittest.main()
