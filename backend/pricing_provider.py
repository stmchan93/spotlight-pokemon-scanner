"""
Pricing provider abstraction layer.

This module defines the contract for pricing providers and manages provider priority
and fallback behavior.

Current architecture notes:
- Scanner runtime freshness is DB-snapshot based in `server.py`
- Any in-memory cache here is legacy/diagnostic only, not the correctness layer
- Provider prices are NOT blended or averaged together
- One active/default provider is used for the tray
- Multiple provider results can be stored for future side-by-side display
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Protocol

try:
    from price_cache import price_cache
    CACHE_ENABLED = True
except ImportError:
    CACHE_ENABLED = False
    price_cache = None


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
    """
    Registry for pricing providers with priority-based fallback.

    The registry tries providers in priority order until one succeeds.
    Provider priority is configurable.
    """

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

    def refresh_raw_pricing(
        self, connection, card_id: str, use_cache: bool = False
    ) -> RawPricingResult:
        """
        Refresh raw pricing using the provider fallback chain.

        Tries providers in priority order until one succeeds.

        Args:
            connection: Database connection
            card_id: Card ID to refresh
            use_cache: Whether to use the legacy in-memory price cache (default: False)

        Returns:
            RawPricingResult from the first successful provider
        """
        # Check cache first if enabled
        if use_cache and CACHE_ENABLED and price_cache:
            for provider in self._providers:
                if not provider.is_ready():
                    continue
                metadata = provider.get_metadata()
                if not metadata.supports_raw_pricing:
                    continue

                cached = price_cache.get(card_id, metadata.provider_id)
                if cached:
                    print(f"✅ Cache hit: {card_id} ({metadata.provider_id})")
                    # Return cached result
                    return RawPricingResult(
                        success=True,
                        provider_id=metadata.provider_id,
                        card_id=card_id,
                        payload=cached
                    )
                # Only check first ready provider's cache
                break

        last_error = None
        for provider in self._providers:
            if not provider.is_ready():
                continue
            metadata = provider.get_metadata()
            if not metadata.supports_raw_pricing:
                continue

            print(f"⚠️  Cache miss: {card_id} ({metadata.provider_id})")
            result = provider.refresh_raw_pricing(connection, card_id)
            if result.success:
                # Cache the result if enabled
                if use_cache and CACHE_ENABLED and price_cache and result.payload:
                    price_cache.set(card_id, metadata.provider_id, result.payload, ttl_hours=24)
                return result
            last_error = result.error

        # All providers failed
        return RawPricingResult(
            success=False,
            provider_id="none",
            card_id=card_id,
            error=last_error or "No ready providers available for raw pricing",
        )

    def refresh_psa_pricing(
        self, connection, card_id: str, grade: str, use_cache: bool = False
    ) -> PsaPricingResult:
        """
        Refresh PSA pricing using the provider fallback chain.

        Tries providers in priority order until one succeeds.

        Args:
            connection: Database connection
            card_id: Card ID to refresh
            grade: PSA grade
            use_cache: Whether to use the legacy in-memory price cache (default: False)

        Returns:
            PsaPricingResult from the first successful provider
        """
        # Check cache first if enabled
        cache_key = f"{card_id}:psa:{grade}"
        if use_cache and CACHE_ENABLED and price_cache:
            for provider in self._providers:
                if not provider.is_ready():
                    continue
                metadata = provider.get_metadata()
                if not metadata.supports_psa_pricing:
                    continue

                cached = price_cache.get(cache_key, metadata.provider_id)
                if cached:
                    print(f"✅ Cache hit: {cache_key} ({metadata.provider_id})")
                    # Return cached result
                    return PsaPricingResult(
                        success=True,
                        provider_id=metadata.provider_id,
                        card_id=card_id,
                        grade=grade,
                        payload=cached
                    )
                # Only check first ready provider's cache
                break

        last_error = None
        for provider in self._providers:
            if not provider.is_ready():
                continue
            metadata = provider.get_metadata()
            if not metadata.supports_psa_pricing:
                continue

            print(f"⚠️  Cache miss: {cache_key} ({metadata.provider_id})")
            result = provider.refresh_psa_pricing(connection, card_id, grade)
            if result.success:
                # Cache the result if enabled
                if use_cache and CACHE_ENABLED and price_cache and result.payload:
                    price_cache.set(cache_key, metadata.provider_id, result.payload, ttl_hours=24)
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
