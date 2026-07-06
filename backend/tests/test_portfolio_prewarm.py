"""Guard for prewarm_portfolio_dashboards (extended 2026-07-06).

The daily 6PM-PT price sync moves the global MAX(price_date), invalidating
every owner's version-token caches (portfolio_dashboard / deck_entries /
portfolio_performance); the first user per owner then paid a ~24.5s cold
recompute. The prewarm — run at startup and via POST
/api/v1/ops/prewarm-portfolio right after the sync — must populate the exact
cache keys clients request so those first calls are hits, not misses. These
tests pin that contract: the prewarm reports per-section warm counts, and a
client call made AFTER the prewarm (with no prior client call) serves the
cached object.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    upsert_card,
    upsert_deck_entry,
)
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

CARD_ID = "prewarmcard"
USER = "user-prewarm"


class PortfolioPrewarmTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "prewarm.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        upsert_card(
            connection,
            card_id=CARD_ID,
            name="Snorlax",
            set_name="Jungle",
            number="11/64",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=CARD_ID,
        )
        upsert_deck_entry(
            connection,
            card_id=CARD_ID,
            variant_name="Holofoil",
            condition="NM",
            quantity=1,
            owner_user_id=USER,
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

    def _identity(self) -> RequestIdentity:
        return RequestIdentity(user_id=USER, auth_source="test")

    def test_prewarm_reports_per_section_counts(self) -> None:
        result = self.service.prewarm_portfolio_dashboards()
        self.assertGreaterEqual(result["ownerCount"], 1)
        self.assertGreaterEqual(result["warmedDashboards"], 1)
        self.assertGreaterEqual(result["warmedEntries"], 1)
        self.assertGreaterEqual(result["warmedPerformance"], 1)

    def test_prewarm_populates_the_cache_keys_clients_request(self) -> None:
        self.service.prewarm_portfolio_dashboards()
        # No client call has happened yet — the prewarm alone must have
        # populated each cache, so the first client call and a repeat call
        # return the SAME cached object (identity, not just equality).
        with self.service.request_identity_context(self._identity()):
            dashboard_first = self.service.portfolio_dashboard(range_key="1W")
            dashboard_second = self.service.portfolio_dashboard(range_key="1W")
            self.assertIs(dashboard_first, dashboard_second)

            entries_first = self.service.deck_entries(limit=200)
            entries_second = self.service.deck_entries(limit=200)
            self.assertIs(entries_first, entries_second)

            performance_first = self.service.portfolio_performance()
            performance_second = self.service.portfolio_performance()
            self.assertIs(performance_first, performance_second)

        # Stronger: the prewarm itself created the exact cache keys.
        self.assertIn(
            (USER, "America/Los_Angeles", "1W"), self.service._dashboard_cache
        )
        self.assertIn((USER, "performance"), self.service._dashboard_cache)
        self.assertIn(
            (USER, 200, 0, False, False, True), self.service._deck_entries_cache
        )

    def test_prewarmed_objects_are_served_to_the_first_client_call(self) -> None:
        self.service.prewarm_portfolio_dashboards()
        # Snapshot the cached payload objects created by the prewarm, then
        # confirm the first real client call serves those exact objects.
        dashboard_cached = self.service._dashboard_cache[
            (USER, "America/Los_Angeles", "1W")
        ][1]
        performance_cached = self.service._dashboard_cache[(USER, "performance")][1]
        entries_cached = self.service._deck_entries_cache[
            (USER, 200, 0, False, False, True)
        ][1]
        with self.service.request_identity_context(self._identity()):
            self.assertIs(
                self.service.portfolio_dashboard(range_key="1W"), dashboard_cached
            )
            self.assertIs(self.service.deck_entries(limit=200), entries_cached)
            self.assertIs(self.service.portfolio_performance(), performance_cached)


if __name__ == "__main__":
    unittest.main()
