"""SpotlightScanService with every path that could spend provider credits off.

The MCP process imports the backend's service directly (no HTTP hop) but must
stay SQLite-only regardless of the shared DB's `live_pricing` runtime setting
or env flags, and must never fall back to a dev identity.
"""

from __future__ import annotations

from pathlib import Path

from pricing_provider import PricingProviderRegistry
from request_auth import RequestAuthError, RequestIdentity
from server import SpotlightScanService


class ReadOnlySpotlightService(SpotlightScanService):
    def __init__(self, database_path: Path, repo_root: Path) -> None:
        super().__init__(database_path, repo_root)
        # No providers registered: any refresh path that slipped through finds nothing to call.
        self.pricing_registry = PricingProviderRegistry()
        # The on-disk payload mirror belongs to the main server process.
        self._payload_cache_root = None

    def _live_pricing_enabled(self) -> bool:
        return False

    def _live_scrydex_searches_allowed(self) -> bool:
        return False

    def _live_scrydex_pricing_refresh_allowed(self) -> bool:
        return False

    def _current_request_identity(self) -> RequestIdentity:
        identity = getattr(self._thread_local, "request_identity", None)
        if isinstance(identity, RequestIdentity):
            return identity
        # Never the dev fallback user: every read here is on behalf of a token.
        raise RequestAuthError("Authenticated request identity is required.")
