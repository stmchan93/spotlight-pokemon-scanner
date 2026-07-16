"""Every `deck_history` point carries a per-day rollup of the owner's card ADDS
(`addedCount` / `addedValue`) so the portfolio chart can mark buy-days without a
second endpoint. Rules under test:

- only real ledger 'add'/'buy' events with quantity_delta > 0 count;
- the synthetic 'seed' kind (a pre-ledger entry's opening quantity) never counts;
- bucketing uses the SAME timezone day-boundaries as the points themselves
  (an 03:00-UTC add belongs to the PREVIOUS Los Angeles day);
- addedValue prefers total_price, falls back to unit_price * quantity_delta,
  and contributes 0 when both are null;
- carry-in events replayed to rebuild quantities for days BEFORE the window
  never read as adds on the window's first plotted day;
- rollups are owner-scoped (owner B's adds never appear in owner A's points).
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    append_deck_entry_event,
    apply_schema,
    connect,
    upsert_card,
    upsert_deck_entry,
)
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

SCRYDEX = "scrydex"
CARD_ID = "rollupcard"
OWNER_A = "user-rollup-a"
OWNER_B = "user-rollup-b"
LA = ZoneInfo("America/Los_Angeles")


def _utc_iso(day, hour_local, tz=LA) -> str:
    """UTC isoformat for `day` at `hour_local` o'clock in `tz`."""
    local = datetime.combine(day, time(hour_local, 0), tzinfo=tz)
    return local.astimezone(timezone.utc).isoformat()


class PortfolioHistoryAddedRollupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "added-rollup.sqlite"
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

        today_la = datetime.now(LA).date()
        self.window_start = today_la - timedelta(days=29)  # first plotted day of a 30-day window
        self.add_day = today_la - timedelta(days=5)  # the busy day: add + buy
        self.free_day = today_la - timedelta(days=3)  # add with no price info
        self.seed_day = today_la - timedelta(days=8)  # synthetic-seed day (must stay 0)
        self.carry_in_day = today_la - timedelta(days=60)  # before the window

        # Owner A entry 1: opened BEFORE the window (its auto 'add' event is the
        # carry-in that must not mark the window's first day), then two adds and
        # a buy inside the window.
        entry_a = upsert_deck_entry(
            connection,
            card_id=CARD_ID,
            variant_name="Holofoil",
            condition="NM",
            quantity=1,
            owner_user_id=OWNER_A,
            added_at=_utc_iso(self.carry_in_day, 12),
        )
        # 20:00 LA == 03:00 UTC the NEXT day — the timezone-boundary probe:
        # correct LA bucketing lands it on add_day, naive UTC bucketing would not.
        # total_price null -> falls back to unit_price * quantity_delta = 20.0.
        append_deck_entry_event(
            connection,
            owner_user_id=OWNER_A,
            deck_entry_id=entry_a,
            card_id=CARD_ID,
            event_kind="add",
            quantity_delta=2,
            unit_price=10.0,
            total_price=None,
            created_at=_utc_iso(self.add_day, 20),
        )
        # 'buy' counts exactly like 'add'; total_price wins over unit_price.
        append_deck_entry_event(
            connection,
            owner_user_id=OWNER_A,
            deck_entry_id=entry_a,
            card_id=CARD_ID,
            event_kind="buy",
            quantity_delta=1,
            unit_price=1000.0,  # decoy: must be ignored because total_price is set
            total_price=55.5,
            created_at=_utc_iso(self.add_day, 12),
        )
        # Priceless add: counts toward addedCount, contributes 0 to addedValue.
        append_deck_entry_event(
            connection,
            owner_user_id=OWNER_A,
            deck_entry_id=entry_a,
            card_id=CARD_ID,
            event_kind="add",
            quantity_delta=1,
            unit_price=None,
            total_price=None,
            created_at=_utc_iso(self.free_day, 12),
        )

        # Owner A entry 2: strip its ledger so deck_history synthesizes a 'seed'
        # event (with a cost-basis totalPrice) on seed_day — it must NOT count.
        entry_seed = upsert_deck_entry(
            connection,
            card_id=CARD_ID,
            variant_name="Holofoil",
            condition="LP",
            quantity=1,
            unit_price=100.0,
            owner_user_id=OWNER_A,
            added_at=_utc_iso(self.seed_day, 12),
        )
        connection.execute(
            "DELETE FROM deck_entry_events WHERE deck_entry_id = ?", (entry_seed,)
        )

        # Owner B: an add on the SAME day as owner A's — must stay invisible to A.
        upsert_deck_entry(
            connection,
            card_id=CARD_ID,
            variant_name="Holofoil",
            condition="NM",
            quantity=1,
            unit_price=999.0,
            owner_user_id=OWNER_B,
            added_at=_utc_iso(self.add_day, 12),
        )

        connection.commit()
        connection.close()

        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

    def _points_by_date(self, owner: str, *, time_zone_name: str = "America/Los_Angeles") -> dict:
        identity = RequestIdentity(user_id=owner, auth_source="test")
        with self.service.request_identity_context(identity):
            bucket = self.service.deck_history(days=30, time_zone_name=time_zone_name)
        points = bucket["points"]
        self.assertTrue(points, "30-day window should return points")
        return {str(point["date"]): point for point in points}

    def test_adds_and_buys_roll_up_on_the_owner_local_day(self) -> None:
        by_date = self._points_by_date(OWNER_A)
        busy = by_date[self.add_day.isoformat()]
        # 2 (boundary add) + 1 (buy) — the 03:00-UTC event bucketed onto the LA day.
        self.assertEqual(busy["addedCount"], 3)
        # 2 * $10 unit-price fallback + $55.50 total_price (decoy unit ignored).
        self.assertAlmostEqual(busy["addedValue"], 75.5)
        # And nothing leaked onto the UTC calendar day after the boundary event.
        day_after = by_date.get((self.add_day + timedelta(days=1)).isoformat())
        self.assertIsNotNone(day_after)
        self.assertEqual(day_after["addedCount"], 0)

    def test_utc_caller_buckets_the_boundary_add_on_the_utc_day(self) -> None:
        # Same ledger, UTC timezone: the 20:00-LA add is 03:00 UTC the NEXT day.
        by_date = self._points_by_date(OWNER_A, time_zone_name="UTC")
        self.assertEqual(by_date[self.add_day.isoformat()]["addedCount"], 1)  # the buy only
        self.assertEqual(
            by_date[(self.add_day + timedelta(days=1)).isoformat()]["addedCount"], 2
        )

    def test_priceless_add_counts_with_zero_value(self) -> None:
        point = self._points_by_date(OWNER_A)[self.free_day.isoformat()]
        self.assertEqual(point["addedCount"], 1)
        self.assertEqual(point["addedValue"], 0.0)

    def test_synthetic_seed_never_counts_as_an_add(self) -> None:
        point = self._points_by_date(OWNER_A)[self.seed_day.isoformat()]
        self.assertEqual(point["addedCount"], 0)
        self.assertEqual(point["addedValue"], 0.0)

    def test_carry_in_event_does_not_mark_the_first_plotted_day(self) -> None:
        point = self._points_by_date(OWNER_A)[self.window_start.isoformat()]
        self.assertEqual(point["addedCount"], 0)
        self.assertEqual(point["addedValue"], 0.0)

    def test_quiet_days_emit_explicit_zeros_on_every_point(self) -> None:
        by_date = self._points_by_date(OWNER_A)
        event_days = {self.add_day.isoformat(), self.free_day.isoformat()}
        for iso_day, point in by_date.items():
            self.assertIn("addedCount", point)
            self.assertIn("addedValue", point)
            if iso_day not in event_days:
                self.assertEqual(point["addedCount"], 0, iso_day)
                self.assertEqual(point["addedValue"], 0.0, iso_day)

    def test_rollup_is_owner_scoped(self) -> None:
        # Owner B sees only their own $999 add; owner A's totals (asserted above)
        # already prove B's add did not leak in.
        by_date = self._points_by_date(OWNER_B)
        point = by_date[self.add_day.isoformat()]
        self.assertEqual(point["addedCount"], 1)
        self.assertAlmostEqual(point["addedValue"], 999.0)
        # And A's events are invisible to B everywhere else.
        self.assertEqual(by_date[self.free_day.isoformat()]["addedCount"], 0)
