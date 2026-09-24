"""hot_cards: Hot on Ekalight. Guards the distinct-user union (a view + a scan
by one person counts once), the per-user cap, the global/per-card gates, the
baseline-ratio floor, price attachment and the exact HotCards payload keys.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from hot_cards import (  # noqa: E402
    baseline_ratio,
    build_hot_cards_payload,
    capped_card_users,
    compute_hot_cards,
    ensure_schema,
)

NOW = datetime(2026, 9, 23, 18, 0, tzinfo=timezone.utc)

HOT_CARDS_KEYS = {"computedAt", "windowHours", "minDistinctUsers", "eligible", "items"}
HOT_CARD_KEYS = {
    "cardId", "game", "name", "number", "setName", "imageUrl", "distinctUsers",
    "baselineRatio", "priceNow", "changePercent7d", "currencyCode",
}


class HotCardsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "hot.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        ensure_schema(self.connection)
        self._scan_seq = 0

    # --- seeding ------------------------------------------------------------

    def _card(self, card_id: str, *, game: str = "pokemon") -> None:
        upsert_card(
            self.connection, card_id=card_id, name=card_id.title(), set_name="Test Set",
            number="1/100", rarity="Rare", variant="Raw", language="English", game=game,
            source_provider="scrydex", source_record_id=card_id, set_id="set1",
            image_small_url=f"https://img/{card_id}.png",
        )

    def _view(self, user: str, card_id: str, *, hours_ago: float) -> None:
        at = NOW - timedelta(hours=hours_ago)
        self.connection.execute(
            "INSERT OR REPLACE INTO card_views (owner_user_id, card_id, viewed_on, viewed_at) "
            "VALUES (?, ?, ?, ?)",
            (user, card_id, at.date().isoformat(), at.isoformat()),
        )

    def _scan(self, user: str | None, *, hours_ago: float, predicted: str | None = None,
              selected: str | None = None, confirmed: str | None = None) -> None:
        self._scan_seq += 1
        self.connection.execute(
            "INSERT INTO scan_events (scan_id, owner_user_id, created_at, request_json, "
            "response_json, predicted_card_id, selected_card_id, confirmed_card_id) "
            "VALUES (?, ?, ?, '{}', '{}', ?, ?, ?)",
            (f"scan-{self._scan_seq}", user, (NOW - timedelta(hours=hours_ago)).isoformat(),
             predicted, selected, confirmed),
        )

    def _background_users(self, count: int) -> None:
        """Active users who touch an unrelated card, to clear the global gate."""
        self._card("filler")
        for i in range(count):
            self._view(f"bg{i}", "filler", hours_ago=2)

    def _compute(self, **kwargs):
        self.connection.commit()
        kwargs.setdefault("min_distinct_users", 5)
        kwargs.setdefault("min_card_users", 3)
        kwargs.setdefault("per_user_cap", 25)
        kwargs.setdefault("baseline_floor", 1.0)
        return compute_hot_cards(self.connection, now=NOW, **kwargs)

    def _items(self, game=None):
        return build_hot_cards_payload(self.connection, game=game)["items"]

    # --- tests --------------------------------------------------------------

    def test_view_and_scan_by_same_user_count_once(self) -> None:
        self._card("pika")
        self._background_users(5)
        for user in ("u1", "u2", "u3"):
            self._view(user, "pika", hours_ago=1)
            self._scan(user, hours_ago=3, confirmed="pika")
        self._compute()
        items = self._items()
        pika = next(i for i in items if i["cardId"] == "pika")
        self.assertEqual(pika["distinctUsers"], 3)

    def test_scan_card_prefers_confirmed_then_selected_then_predicted(self) -> None:
        for cid in ("a", "b", "c"):
            self._card(cid)
        self._background_users(5)
        for user in ("u1", "u2", "u3"):
            self._scan(user, hours_ago=1, predicted="c", selected="b", confirmed="a")
        self._compute()
        ids = [i["cardId"] for i in self._items()]
        self.assertIn("a", ids)
        self.assertNotIn("b", ids)
        self.assertNotIn("c", ids)

    def test_window_excludes_old_activity_and_anonymous_scans(self) -> None:
        self._card("pika")
        self._background_users(5)
        self._view("u1", "pika", hours_ago=1)
        self._view("u2", "pika", hours_ago=2)
        self._view("u3", "pika", hours_ago=30)  # outside the 24h window
        self._scan(None, hours_ago=1, confirmed="pika")
        self._scan("", hours_ago=1, confirmed="pika")
        self._compute()
        self.assertNotIn("pika", [i["cardId"] for i in self._items()])

    def test_per_user_cap_limits_a_binder_scanner(self) -> None:
        events = {"vendor": [(1, f"2026-09-23T10:{i:02d}:00", f"card{i:03d}") for i in range(40)]}
        events["vendor"].append((0, "2026-09-23T12:00:00", "card039"))  # a deliberate view
        capped = capped_card_users(events, per_user_cap=25)
        self.assertEqual(len(capped), 25)
        # Views outrank scans; then the earliest scans fill the cap.
        self.assertIn("card039", capped)
        self.assertIn("card000", capped)
        self.assertNotIn("card030", capped)

    def test_per_user_cap_applied_in_compute(self) -> None:
        for i in range(5):
            self._card(f"c{i}")
        self._background_users(5)
        for user in ("u1", "u2", "u3"):
            for i in range(5):
                self._scan(user, hours_ago=5 - i, confirmed=f"c{i}")
        self._compute(per_user_cap=2)
        ids = sorted(i["cardId"] for i in self._items() if i["cardId"] != "filler")
        self.assertEqual(ids, ["c0", "c1"])

    def test_gate_below_min_active_users_returns_no_items(self) -> None:
        self._card("pika")
        for user in ("u1", "u2", "u3"):
            self._view(user, "pika", hours_ago=1)
        summary = self._compute(min_distinct_users=15)
        self.assertFalse(summary["eligible"])
        payload = build_hot_cards_payload(self.connection)
        self.assertFalse(payload["eligible"])
        self.assertEqual(payload["items"], [])

    def test_card_below_min_card_users_is_not_listed(self) -> None:
        self._card("pika")
        self._card("eevee")
        self._background_users(5)
        for user in ("u1", "u2", "u3"):
            self._view(user, "pika", hours_ago=1)
        for user in ("u1", "u2"):
            self._view(user, "eevee", hours_ago=1)
        self._compute()
        ids = [i["cardId"] for i in self._items()]
        self.assertIn("pika", ids)
        self.assertNotIn("eevee", ids)

    def test_baseline_ratio_floor(self) -> None:
        # Never-seen card: ratio is the window rate, not infinity.
        self.assertEqual(baseline_ratio(4, 0.0, window_hours=24, floor=1.0), 4.0)
        # Busy staple: its own baseline governs.
        self.assertEqual(baseline_ratio(10, 5.0, window_hours=24, floor=1.0), 2.0)

    def test_new_spike_outranks_steady_staple(self) -> None:
        self._card("staple")
        self._card("spike")
        self._background_users(5)
        # staple: 6 users today and 6 distinct users every day for 14 days
        for day in range(1, 15):
            for u in range(6):
                self._view(f"s{u}", "staple", hours_ago=24 * day + 1)
        for u in range(6):
            self._view(f"s{u}", "staple", hours_ago=1)
        for u in range(4):
            self._view(f"p{u}", "spike", hours_ago=1)
        self._compute()
        items = [i for i in self._items() if i["cardId"] != "filler"]
        self.assertEqual([i["cardId"] for i in items], ["spike", "staple"])
        self.assertAlmostEqual(items[0]["baselineRatio"], 4.0)
        self.assertAlmostEqual(items[1]["baselineRatio"], 1.0)

    def test_price_attached_from_main_lane(self) -> None:
        self._card("pika")
        self._background_users(5)
        for user in ("u1", "u2", "u3"):
            self._view(user, "pika", hours_ago=1)
        today = NOW.date()
        for days_ago, price in ((0, 12.0), (7, 10.0)):
            self.connection.execute(
                "INSERT INTO card_price_history_daily (card_id, provider, price_date, "
                "display_currency_code, main_raw_market_price, updated_at) "
                "VALUES ('pika', 'scrydex', ?, 'USD', ?, ?)",
                ((today - timedelta(days=days_ago)).isoformat(), price, utc_now()),
            )
        self._compute()
        pika = next(i for i in self._items() if i["cardId"] == "pika")
        self.assertEqual(pika["priceNow"], 12.0)
        self.assertEqual(pika["changePercent7d"], 20.0)

    def test_game_filter_and_payload_keys(self) -> None:
        self._card("pika")
        self._card("luffy", game="onepiece")
        self._background_users(5)
        for user in ("u1", "u2", "u3"):
            self._view(user, "pika", hours_ago=1)
            self._view(user, "luffy", hours_ago=1)
        self._compute()
        payload = build_hot_cards_payload(self.connection)
        self.assertEqual(set(payload), HOT_CARDS_KEYS)
        self.assertTrue(payload["eligible"])
        self.assertEqual(payload["windowHours"], 24)
        self.assertEqual(payload["minDistinctUsers"], 3)
        for item in payload["items"]:
            self.assertEqual(set(item), HOT_CARD_KEYS)
            self.assertEqual(item["currencyCode"], "USD")
        self.assertIsNone(next(i for i in payload["items"] if i["cardId"] == "pika")["priceNow"])
        self.assertEqual([i["cardId"] for i in self._items("onepiece")], ["luffy"])

    def test_empty_database_payload(self) -> None:
        payload = build_hot_cards_payload(self.connection)
        self.assertEqual(set(payload), HOT_CARDS_KEYS)
        self.assertFalse(payload["eligible"])
        self.assertEqual(payload["items"], [])


if __name__ == "__main__":
    unittest.main()
