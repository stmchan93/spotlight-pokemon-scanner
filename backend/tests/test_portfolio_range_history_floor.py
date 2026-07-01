"""A history-bounded range (3M/1Y/ALL) must not plot days BEFORE price history
exists. Portfolio history began on a fixed floor date (the daily job's first run);
days before it have no price to value the portfolio, so they read $0 and dragged
the 3M chart (and its baseline) to zero. `deck_history` now clamps the window start
up to `_portfolio_earliest_priced_date()`, so a 90-day window whose nominal start
precedes the floor begins AT the floor instead of with a run of $0 days.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
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
    upsert_deck_entry,
    upsert_price_history_daily,
)
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

SCRYDEX = "scrydex"
CARD_ID = "floorcard"
USER = "user-floor"


class PortfolioRangeHistoryFloorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "range-floor.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)
        upsert_card(
            connection,
            card_id=CARD_ID,
            name="Pikachu",
            set_name="Base Set",
            number="58/102",
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider=SCRYDEX,
            source_record_id=CARD_ID,
        )
        # Price history begins only 20 days ago — well inside a 90-day (3M) window.
        self.floor_date = datetime.now(timezone.utc).date() - timedelta(days=20)
        for offset in range(20):
            price_date = (self.floor_date + timedelta(days=offset)).isoformat()
            upsert_price_history_daily(
                connection,
                card_id=CARD_ID,
                pricing_mode=RAW_PRICING_MODE,
                provider=SCRYDEX,
                price_date=price_date,
                currency_code="USD",
                variant="Holofoil",
                condition="NM",
                low_price=9.0,
                market_price=10.0,
                mid_price=10.5,
                high_price=11.0,
                direct_low_price=8.0,
                trend_price=10.0,
                payload={"provider": SCRYDEX, "variantKey": "holofoil"},
            )
        # Owned well before history exists, so the activity clamp can't hide the gap.
        upsert_deck_entry(
            connection,
            card_id=CARD_ID,
            variant_name="Holofoil",
            condition="NM",
            quantity=1,
            owner_user_id=USER,
            added_at=(self.floor_date - timedelta(days=60)).isoformat(),
        )
        connection.commit()
        connection.close()

        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

    def _identity(self) -> RequestIdentity:
        return RequestIdentity(user_id=USER, auth_source="test")

    def test_earliest_priced_date_is_the_floor(self) -> None:
        with self.service.request_identity_context(self._identity()):
            self.assertEqual(self.service._portfolio_earliest_priced_date(), self.floor_date)

    def test_three_month_window_starts_at_floor_not_before(self) -> None:
        with self.service.request_identity_context(self._identity()):
            bucket = self.service.deck_history(days=90, range_label="3M")
        points = bucket["points"]
        self.assertTrue(points, "3M window should still return points")
        first_iso = str(points[0]["date"])[:10]
        # No point predates the price-history floor (which would read $0).
        self.assertGreaterEqual(date.fromisoformat(first_iso), self.floor_date)
        # And every plotted day has a real (non-zero) value.
        self.assertTrue(all((point.get("totalValue") or 0) > 0 for point in points))
