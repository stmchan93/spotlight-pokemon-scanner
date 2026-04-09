"""Thin pricing provider abstraction layer for the raw-only backend build."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass
class ProviderMetadata:
    """Metadata about a pricing provider."""

    provider_id: str
    provider_label: str
    is_ready: bool
    requires_credentials: bool
    supports_raw_pricing: bool
    supports_psa_pricing: bool


@dataclass
class RawPricingResult:
    """Result from a raw pricing refresh."""

    success: bool
    provider_id: str
    card_id: str
    payload: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class PsaPricingResult:
    """Result from a PSA pricing refresh."""

    success: bool
    provider_id: str
    card_id: str
    grade: str
    payload: dict[str, Any] | None = None
    error: str | None = None


class PricingProvider(ABC):
    """
    Abstract base class for pricing providers.

    Each provider implements this contract to provide raw and/or PSA pricing.
    Providers are responsible for:
    - Fetching pricing data from their source
    - Persisting pricing data to the database
    - Reporting readiness (credentials, network, etc.)
    """

    @abstractmethod
    def get_metadata(self) -> ProviderMetadata:
        """Return provider metadata."""
        pass

    @abstractmethod
    def is_ready(self) -> bool:
        """Return whether the provider is ready to serve requests."""
        pass

    @abstractmethod
    def refresh_raw_pricing(self, connection, card_id: str) -> RawPricingResult:
        """
        Refresh raw card pricing for a card.

        Args:
            connection: Database connection
            card_id: Card ID to refresh

        Returns:
            RawPricingResult with success status and optional payload/error
        """
        pass

    @abstractmethod
    def refresh_psa_pricing(
        self, connection, card_id: str, grade: str
    ) -> PsaPricingResult:
        """
        Refresh PSA graded pricing for a card.

        Args:
            connection: Database connection
            card_id: Card ID to refresh
            grade: PSA grade (e.g., "10", "9", "8")

        Returns:
            PsaPricingResult with success status and optional payload/error
        """
        pass


class PricingProviderRegistry:
    """Minimal provider registry used by the raw-only backend runtime."""

    def __init__(self):
        self._providers: list[PricingProvider] = []
        self._provider_map: dict[str, PricingProvider] = {}

    def register(self, provider: PricingProvider) -> None:
        """Register a provider. Providers are tried in registration order."""
        metadata = provider.get_metadata()
        if metadata.provider_id in self._provider_map:
            raise ValueError(
                f"Provider {metadata.provider_id} is already registered"
            )
        self._providers.append(provider)
        self._provider_map[metadata.provider_id] = provider

    def get_provider(self, provider_id: str) -> PricingProvider | None:
        """Get a specific provider by ID."""
        return self._provider_map.get(provider_id)

    def list_providers(self) -> list[ProviderMetadata]:
        """List all registered providers with their metadata."""
        return [provider.get_metadata() for provider in self._providers]

    def get_active_provider(
        self, *, for_raw: bool = True, for_psa: bool = False
    ) -> PricingProvider | None:
        """
        Get the first ready provider that supports the requested pricing mode.

        Args:
            for_raw: Whether to check raw pricing support
            for_psa: Whether to check PSA pricing support

        Returns:
            The first ready provider that supports the mode, or None
        """
        if not for_raw and not for_psa:
            return None

        for provider in self._providers:
            if not provider.is_ready():
                continue
            metadata = provider.get_metadata()
            if for_raw and not for_psa and metadata.supports_raw_pricing:
                return provider
            if for_psa and not for_raw and metadata.supports_psa_pricing:
                return provider
            if for_raw and for_psa and metadata.supports_raw_pricing and metadata.supports_psa_pricing:
                return provider
        return None

    def refresh_raw_pricing(self, connection, card_id: str, use_cache: bool = False) -> RawPricingResult:
        del use_cache
        last_error = None
        for provider in self._providers:
            if not provider.is_ready():
                continue
            metadata = provider.get_metadata()
            if not metadata.supports_raw_pricing:
                continue

            result = provider.refresh_raw_pricing(connection, card_id)
            if result.success:
                return result
            last_error = result.error

        # All providers failed
        return RawPricingResult(
            success=False,
            provider_id="none",
            card_id=card_id,
            error=last_error or "No ready providers available for raw pricing",
        )

    def refresh_psa_pricing(self, connection, card_id: str, grade: str, use_cache: bool = False) -> PsaPricingResult:
        del use_cache
        last_error = None
        for provider in self._providers:
            if not provider.is_ready():
                continue
            metadata = provider.get_metadata()
            if not metadata.supports_psa_pricing:
                continue

            result = provider.refresh_psa_pricing(connection, card_id, grade)
            if result.success:
                return result
            last_error = result.error

        # All providers failed
        return PsaPricingResult(
            success=False,
            provider_id="none",
            card_id=card_id,
            grade=grade,
            error=last_error or "No ready providers available for PSA pricing",
        )
