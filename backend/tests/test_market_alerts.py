"""market_alerts: price-move thresholds, bundling, the per-card cooldown,
quiet-hours deferral, the Sunday summary across timezones, owner scoping,
prefs, and deals routed through the same limiter.

Every push goes to a FAKE sender (or an injected fake Expo transport). Nothing
here reaches the network.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import expo_push  # noqa: E402
import market_alerts as ma  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_watch_deal_radar_schema_patch  # noqa: E402

# Tuesday 2026-09-22 18:00 UTC = 11:00 in Los Angeles.
NOW = datetime(2026, 9, 22, 18, 0, tzinfo=timezone.utc)
TODAY = "2026-09-22"
YESTERDAY = "2026-09-21"

TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]"
TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]"


class FakeSender:
    def __init__(self) -> None:
        self.messages: list[expo_push.PushMessage] = []
        self._n = 0

    def __call__(self, messages):
        tickets = []
        for message in messages:
            self.messages.append(message)
            self._n += 1
            tickets.append(expo_push.PushTicket(
                token=message.to, status="ok", ticket_id=f"t-{self._n}", reference_id=message.reference_id,
            ))
        return expo_push.PushResult(sent=len(messages), tickets=tuple(tickets))


class MarketAlertsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "alerts.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_watch_deal_radar_schema_patch(self.connection)
        ma.ensure_schema(self.connection)
        self.connection.commit()
        self.sender = FakeSender()
        self._entry = 0

    # --- fixtures -------------------------------------------------------------

    def card(self, card_id: str, name: str | None = None) -> None:
        upsert_card(
            self.connection, card_id=card_id, name=name or card_id.title(), set_name="Set",
            number="1/100", rarity="Rare", variant="Raw", language="English", game="pokemon",
            source_provider="scrydex", source_record_id=card_id, set_id="set1",
        )
        self.connection.commit()

    def price(self, card_id: str, day: str, usd: float) -> None:
        self.connection.execute(
            """
            INSERT OR REPLACE INTO card_price_history_daily
                (card_id, provider, price_date, display_currency_code, main_raw_market_price,
                 main_raw_variant, updated_at)
            VALUES (?, 'tcgcsv', ?, 'USD', ?, 'Holofoil', ?)
            """,
            (card_id, day, usd, utc_now()),
        )
        self.connection.commit()

    def move(self, card_id: str, then: float, now: float, *, name: str | None = None,
             then_day: str = YESTERDAY, now_day: str = TODAY) -> None:
        self.card(card_id, name)
        self.price(card_id, then_day, then)
        self.price(card_id, now_day, now)

    def own(self, owner: str, card_id: str, qty: int = 1, grader: str | None = None) -> None:
        self._entry += 1
        self.connection.execute(
            """
            INSERT INTO deck_entries (id, owner_user_id, item_kind, card_id, grader, quantity,
                                      added_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (f"e{self._entry}", owner, "slab" if grader else "raw", card_id, grader, qty,
             utc_now(), utc_now()),
        )
        self.connection.commit()

    def watch(self, owner: str, card_id: str) -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO card_favorites (owner_user_id, card_id, created_at) VALUES (?, ?, ?)",
            (owner, card_id, utc_now()),
        )
        self.connection.commit()

    def token(self, owner: str, token: str = TOKEN_A, tz: str | None = "America/Los_Angeles") -> None:
        self.connection.execute(
            """
            INSERT INTO user_push_tokens (owner_user_id, expo_push_token, created_at, last_seen_at, timezone)
            VALUES (?, ?, ?, ?, ?)
            """,
            (owner, token, utc_now(), utc_now(), tz),
        )
        self.connection.commit()

    def deal(self, owner: str, card_id: str, *, alert_id: str = "deal-1", pct: float = 18.0,
             created_at: datetime = NOW - timedelta(hours=1)) -> None:
        self.connection.execute(
            """
            INSERT INTO deal_alerts (id, owner_user_id, card_id, listing_id, kind, total_cents,
                                     baseline_cents, discount_pct, created_at)
            VALUES (?, ?, ?, ?, 'under_added', 4100, 5000, ?, ?)
            """,
            (alert_id, owner, card_id, f"listing-{alert_id}", pct, created_at.isoformat()),
        )
        self.connection.commit()

    def run_job(self, now: datetime = NOW, **kwargs):
        kwargs.setdefault("sender", self.sender)
        kwargs.setdefault("check_receipts", False)
        return ma.run_market_alerts(self.connection, now=now, **kwargs)

    def ledger(self, owner: str | None = None) -> list:
        query = "SELECT * FROM market_alert_pushes"
        params: tuple = ()
        if owner:
            query += " WHERE owner_user_id = ?"
            params = (owner,)
        return self.connection.execute(query + " ORDER BY created_at", params).fetchall()


class ThresholdTests(unittest.TestCase):
    def test_move_needs_ten_percent_and_five_dollars(self) -> None:
        self.assertAlmostEqual(ma.move_pct(56.0, 50.0), 12.0)
        self.assertIsNone(ma.move_pct(28.0, 25.0))  # 12% but only $3
        self.assertIsNone(ma.move_pct(216.0, 200.0))  # $16 but only 8%
        self.assertAlmostEqual(ma.move_pct(85.0, 100.0), -15.0)  # drops count too
        self.assertIsNone(ma.move_pct(10.0, None))

    def test_cooldown_three_days_unless_another_ten_percent(self) -> None:
        state = ma.CardAlertState(NOW - timedelta(days=1), 115.0)
        self.assertFalse(ma.cooldown_allows(state, 120.0, NOW))
        self.assertTrue(ma.cooldown_allows(state, 127.0, NOW))  # +10.4% since the alert
        self.assertTrue(ma.cooldown_allows(state, 103.0, NOW))  # -10.4% since the alert
        old = ma.CardAlertState(NOW - timedelta(days=3), 115.0)
        self.assertTrue(ma.cooldown_allows(old, 116.0, NOW))
        self.assertTrue(ma.cooldown_allows(None, 1.0, NOW))

    def test_quiet_hours_and_weekly_window(self) -> None:
        la = "America/Los_Angeles"
        self.assertTrue(ma.in_quiet_hours(ma.local_now(datetime(2026, 9, 23, 4, 0, tzinfo=timezone.utc), la)))  # 21:00
        self.assertTrue(ma.in_quiet_hours(ma.local_now(datetime(2026, 9, 22, 15, 59, tzinfo=timezone.utc), la)))  # 08:59
        self.assertFalse(ma.in_quiet_hours(ma.local_now(datetime(2026, 9, 22, 16, 0, tzinfo=timezone.utc), la)))  # 09:00
        self.assertTrue(ma.weekly_due(ma.local_now(datetime(2026, 9, 28, 0, 0, tzinfo=timezone.utc), la)))  # Sun 17:00
        self.assertFalse(ma.weekly_due(ma.local_now(datetime(2026, 9, 27, 23, 59, tzinfo=timezone.utc), la)))  # 16:59
        self.assertFalse(ma.weekly_due(ma.local_now(datetime(2026, 9, 28, 4, 0, tzinfo=timezone.utc), la)))  # 21:00

    def test_invalid_timezone_falls_back_to_los_angeles(self) -> None:
        self.assertIsNone(ma.normalize_timezone("Mars/Olympus"))
        self.assertEqual(ma.resolve_timezone([("t", "Mars/Olympus")], {"timezone": None}), ma.DEFAULT_TIMEZONE)
        self.assertEqual(ma.resolve_timezone([("t", None)], {"timezone": "Asia/Tokyo"}), "Asia/Tokyo")
        self.assertEqual(ma.resolve_timezone([("t", "Europe/London")], {"timezone": "Asia/Tokyo"}), "Europe/London")


class PriceMoveTests(MarketAlertsTestCase):
    def test_single_move_opens_the_card(self) -> None:
        self.move("latios", 75.0, 84.0, name="Latios ☆")
        self.watch("u1", "latios")
        self.token("u1")
        summary = self.run_job()
        self.assertEqual(summary["sent"], 1)
        (message,) = self.sender.messages
        self.assertEqual(message.title, "Latios ☆ +12%")
        self.assertEqual(message.data["url"], "/cards/latios")
        self.assertEqual(message.data["type"], ma.DATA_TYPE_PRICE_MOVE)
        self.assertNotIn("alertId", message.data)  # not a deal_alerts row
        self.assertEqual(message.channel_id, ma.MARKET_CHANNEL_ID)

    def test_small_or_cheap_moves_send_nothing(self) -> None:
        self.move("cheap", 25.0, 28.0)  # 12%, $3
        self.move("slow", 200.0, 216.0)  # 8%, $16
        for card in ("cheap", "slow"):
            self.watch("u1", card)
        self.token("u1")
        self.assertEqual(self.run_job()["sent"], 0)
        self.assertEqual(self.ledger(), [])

    def test_several_moves_bundle_into_one_push(self) -> None:
        self.move("latios", 75.0, 84.0, name="Latios ☆")
        self.move("mew", 100.0, 130.0, name="Mew")
        self.move("eevee", 60.0, 50.0, name="Eevee")
        self.own("u1", "mew")
        self.watch("u1", "latios")
        self.watch("u1", "eevee")
        self.token("u1")
        self.run_job()
        (message,) = self.sender.messages
        self.assertEqual(message.title, "Mew +30% and 2 more")
        self.assertIn("own or watch", message.body)
        self.assertEqual(message.data["url"], "/")  # something owned -> Collection
        self.assertEqual(set(message.data["cardIds"]), {"latios", "mew", "eevee"})

    def test_watch_only_bundle_opens_the_wishlist(self) -> None:
        self.move("a", 50.0, 60.0)
        self.move("b", 50.0, 70.0)
        self.watch("u1", "a")
        self.watch("u1", "b")
        self.token("u1")
        self.run_job()
        self.assertEqual(self.sender.messages[0].data["url"], "/wishlist")

    def test_graded_holdings_do_not_trigger_raw_moves(self) -> None:
        self.move("mew", 100.0, 130.0)
        self.own("u1", "mew", grader="PSA")
        self.token("u1")
        self.assertEqual(self.run_job()["sent"], 0)

    def test_one_push_per_local_day(self) -> None:
        self.move("mew", 100.0, 130.0)
        self.own("u1", "mew")
        self.token("u1")
        self.run_job()
        self.move("lugia", 100.0, 150.0)
        self.own("u1", "lugia")
        self.run_job(NOW + timedelta(hours=3))
        self.assertEqual(len(self.sender.messages), 1)
        # Next local day the cap resets (lugia is still today's latest move).
        self.run_job(NOW + timedelta(days=1))
        self.assertEqual(len(self.sender.messages), 2)
        self.assertEqual(self.sender.messages[1].data["cardId"], "lugia")

    def test_same_card_waits_three_days_unless_it_moves_another_ten_percent(self) -> None:
        self.move("mew", 104.0, 116.0)  # +11.5% today, but only +0.9% vs the last alert
        self.own("u1", "mew")
        self.token("u1")
        self.connection.execute(
            "INSERT INTO market_alert_card_state VALUES ('u1', 'mew', ?, 115.0)",
            ((NOW - timedelta(days=1)).isoformat(),),
        )
        self.connection.commit()
        self.assertEqual(self.run_job()["sent"], 0)
        self.connection.execute(
            "UPDATE market_alert_card_state SET last_alerted_at = ?",
            ((NOW - timedelta(days=3)).isoformat(),),
        )
        self.connection.commit()
        self.assertEqual(self.run_job()["sent"], 1)
        row = self.connection.execute(
            "SELECT last_price_usd, last_alerted_at FROM market_alert_card_state WHERE card_id = 'mew'"
        ).fetchone()
        self.assertEqual(row[0], 116.0)
        self.assertEqual(row[1], NOW.isoformat())

    def test_quiet_hours_defer_to_nine_am_instead_of_dropping(self) -> None:
        self.move("mew", 100.0, 130.0)
        self.own("u1", "mew")
        self.token("u1")
        late = datetime(2026, 9, 23, 5, 0, tzinfo=timezone.utc)  # 22:00 LA
        summary = self.run_job(late)
        self.assertEqual(summary["sent"], 0)
        self.assertEqual(summary["skipped"].get("quiet_hours"), 1)
        self.assertEqual(self.ledger(), [])
        self.run_job(datetime(2026, 9, 23, 15, 3, tzinfo=timezone.utc))  # 08:03 LA
        self.assertEqual(self.sender.messages, [])
        self.run_job(datetime(2026, 9, 23, 16, 3, tzinfo=timezone.utc))  # 09:03 LA
        self.assertEqual(len(self.sender.messages), 1)

    def test_local_time_is_per_user(self) -> None:
        self.move("mew", 100.0, 130.0)
        self.own("la", "mew")
        self.own("tokyo", "mew")
        self.token("la", TOKEN_A, "America/Los_Angeles")
        self.token("tokyo", TOKEN_B, "Asia/Tokyo")
        self.run_job()  # 11:00 LA, 03:00 Tokyo
        self.assertEqual([m.to for m in self.sender.messages], [TOKEN_A])

    def test_prefs_off_sends_nothing(self) -> None:
        self.move("mew", 100.0, 130.0)
        self.own("u1", "mew")
        self.token("u1")
        ma.set_alert_prefs(self.connection, "u1", {"priceMovesEnabled": False})
        self.assertEqual(self.run_job()["sent"], 0)
        self.assertEqual(self.ledger(), [])

    def test_dry_run_sends_and_writes_nothing(self) -> None:
        self.move("mew", 100.0, 130.0)
        self.own("u1", "mew")
        self.token("u1")
        summary = self.run_job(dry_run=True)
        self.assertEqual(len(summary["planned"]), 1)
        self.assertEqual(self.sender.messages, [])
        self.assertEqual(self.ledger(), [])


class OwnerScopingTests(MarketAlertsTestCase):
    def test_pushes_are_built_only_from_the_owners_own_cards(self) -> None:
        self.move("mew", 100.0, 130.0, name="Mew")
        self.own("bob", "mew")
        self.token("alice", TOKEN_A)
        self.token("bob", TOKEN_B)
        self.run_job()
        (message,) = self.sender.messages
        self.assertEqual(message.to, TOKEN_B)
        self.assertEqual([r["owner_user_id"] for r in self.ledger()], ["bob"])

    def test_prefs_are_per_owner_and_absent_row_is_all_on(self) -> None:
        self.assertEqual(
            ma.get_alert_prefs(self.connection, "alice"),
            {"priceMovesEnabled": True, "weeklySummaryEnabled": True, "dealAlertsEnabled": True, "timezone": None},
        )
        ma.set_alert_prefs(self.connection, "alice", {"weeklySummaryEnabled": False, "timezone": "Asia/Tokyo"})
        self.assertFalse(ma.get_alert_prefs(self.connection, "alice")["weeklySummaryEnabled"])
        self.assertTrue(ma.get_alert_prefs(self.connection, "bob")["weeklySummaryEnabled"])
        # Partial: untouched flags keep their values; deals shares the existing column.
        prefs = ma.set_alert_prefs(self.connection, "alice", {"dealAlertsEnabled": False})
        self.assertFalse(prefs["weeklySummaryEnabled"])
        self.assertFalse(prefs["dealAlertsEnabled"])
        self.assertEqual(prefs["timezone"], "Asia/Tokyo")
        row = self.connection.execute(
            "SELECT deal_alerts_enabled, target_hits_enabled FROM user_notification_prefs WHERE owner_user_id = 'alice'"
        ).fetchone()
        self.assertEqual(tuple(row), (0, 1))

    def test_prefs_validation(self) -> None:
        with self.assertRaises(ValueError):
            ma.set_alert_prefs(self.connection, "alice", {"priceMovesEnabled": "yes"})
        with self.assertRaises(ValueError):
            ma.set_alert_prefs(self.connection, "alice", {"timezone": "Mars/Olympus"})
        with self.assertRaises(ValueError):
            ma.set_alert_prefs(self.connection, "alice", ["nope"])  # type: ignore[arg-type]


class WeeklySummaryTests(MarketAlertsTestCase):
    # Sunday 2026-09-27; 17:05 in Los Angeles = 2026-09-28 00:05 UTC.
    SUNDAY_LA_1705 = datetime(2026, 9, 28, 0, 5, tzinfo=timezone.utc)

    def setUp(self) -> None:
        super().setUp()
        self.move("mew", 100.0, 130.0, name="Mew", then_day="2026-09-20", now_day="2026-09-27")
        self.move("pika", 50.0, 45.0, name="Pikachu", then_day="2026-09-20", now_day="2026-09-27")
        # A flat yesterday so the Sunday run has no daily move to send instead.
        self.price("mew", "2026-09-26", 130.0)
        self.price("pika", "2026-09-26", 45.0)

    def test_sunday_five_pm_local_summary(self) -> None:
        self.own("u1", "mew", qty=2)
        self.own("u1", "pika")
        self.token("u1")
        self.run_job(self.SUNDAY_LA_1705)
        (message,) = self.sender.messages
        self.assertEqual(message.title, "Your collection +$55 this week")
        self.assertEqual(message.body, "Top mover: Mew +30%.")
        self.assertEqual(message.data, {"type": ma.DATA_TYPE_WEEKLY_SUMMARY, "url": "/"})
        # Once per week: the next hourly run in the window sends nothing.
        self.run_job(self.SUNDAY_LA_1705 + timedelta(hours=1))
        self.assertEqual(len(self.sender.messages), 1)

    def test_schedule_follows_each_users_timezone(self) -> None:
        for owner, token, zone in (("la", TOKEN_A, "America/Los_Angeles"), ("ldn", TOKEN_B, "Europe/London")):
            self.own(owner, "mew")
            self.token(owner, token, zone)
        self.run_job(datetime(2026, 9, 27, 16, 5, tzinfo=timezone.utc))  # 17:05 London, 09:05 LA
        self.assertEqual([m.to for m in self.sender.messages], [TOKEN_B])
        self.run_job(datetime(2026, 9, 27, 23, 5, tzinfo=timezone.utc))  # 16:05 LA: not yet
        self.assertEqual(len(self.sender.messages), 1)
        self.run_job(self.SUNDAY_LA_1705)
        self.assertEqual([m.to for m in self.sender.messages], [TOKEN_B, TOKEN_A])

    def test_weekly_still_sends_after_that_days_push_but_nothing_follows_it(self) -> None:
        self.own("u1", "mew")
        self.token("u1")
        self.deal("u1", "mew", created_at=datetime(2026, 9, 27, 18, 0, tzinfo=timezone.utc))
        self.run_job(datetime(2026, 9, 27, 18, 5, tzinfo=timezone.utc))  # Sun 11:05 LA: the deal
        self.run_job(self.SUNDAY_LA_1705)
        self.assertEqual(
            [m.data["type"] for m in self.sender.messages],
            [expo_push.DATA_TYPE_DEAL_ALERT, ma.DATA_TYPE_WEEKLY_SUMMARY],
        )
        self.deal("u1", "mew", alert_id="deal-2", created_at=self.SUNDAY_LA_1705)
        self.run_job(self.SUNDAY_LA_1705 + timedelta(hours=1))
        self.assertEqual(len(self.sender.messages), 2)

    def test_weekly_off_or_no_holdings_sends_nothing(self) -> None:
        self.token("u1")
        self.assertEqual(self.run_job(self.SUNDAY_LA_1705)["sent"], 0)  # owns nothing
        self.own("u1", "mew")
        ma.set_alert_prefs(self.connection, "u1", {"weeklySummaryEnabled": False})
        self.assertEqual(self.run_job(self.SUNDAY_LA_1705)["sent"], 0)


class DealRoutingTests(MarketAlertsTestCase):
    def test_pending_deal_wins_the_day_over_price_moves(self) -> None:
        self.move("umbreon", 50.0, 70.0, name="Umbreon ex")
        self.watch("u1", "umbreon")
        self.token("u1")
        self.deal("u1", "umbreon")
        self.run_job()
        (message,) = self.sender.messages
        self.assertEqual(message.title, "Umbreon ex listed 18% under market")
        self.assertEqual(message.data["alertId"], "deal-1")
        self.assertEqual(message.data["url"], "/wishlist")
        stamped = self.connection.execute("SELECT push_sent_at FROM deal_alerts WHERE id = 'deal-1'").fetchone()[0]
        self.assertIsNotNone(stamped)

    def test_deals_bundle_and_respect_quiet_hours(self) -> None:
        self.card("umbreon", "Umbreon ex")
        self.card("espeon", "Espeon ex")
        self.token("u1")
        late = datetime(2026, 9, 23, 5, 0, tzinfo=timezone.utc)  # 22:00 LA
        self.deal("u1", "umbreon", alert_id="d1", pct=18.0, created_at=late)
        self.deal("u1", "espeon", alert_id="d2", pct=25.0, created_at=late)
        self.run_job(late, kinds=(ma.KIND_DEAL,))
        self.assertEqual(self.sender.messages, [])
        pending = self.connection.execute("SELECT COUNT(*) FROM deal_alerts WHERE push_sent_at IS NULL").fetchone()[0]
        self.assertEqual(pending, 2)
        self.run_job(datetime(2026, 9, 23, 16, 3, tzinfo=timezone.utc))
        (message,) = self.sender.messages
        self.assertEqual(message.title, "Espeon ex listed 25% under market and 1 more")

    def test_deals_off_sends_nothing(self) -> None:
        self.card("umbreon")
        self.token("u1")
        self.deal("u1", "umbreon")
        ma.set_alert_prefs(self.connection, "u1", {"dealAlertsEnabled": False})
        self.assertEqual(self.run_job()["sent"], 0)

    def test_other_owners_deals_are_never_sent(self) -> None:
        self.card("umbreon")
        self.token("alice", TOKEN_A)
        self.deal("bob", "umbreon")
        self.assertEqual(self.run_job()["sent"], 0)


class ServiceWiringTests(unittest.TestCase):
    """The server seam: prefs endpoints' service methods, timezone on token
    registration, and the deal scan's user lane routed through the limiter."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        path = Path(self.tempdir.name) / "svc.sqlite"
        connection = connect(path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self.connection = self.service.connection

    def _as(self, user: str):
        return self.service.request_identity_context(RequestIdentity(user_id=user, auth_source="test"))

    def test_alert_prefs_round_trip_is_owner_scoped(self) -> None:
        with self._as("alice"):
            out = self.service.set_alert_prefs({"priceMovesEnabled": False, "timezone": "Europe/London"})
            self.assertEqual(out["priceMovesEnabled"], False)
            self.assertEqual(self.service.alert_prefs()["timezone"], "Europe/London")
            # The existing deal toggle and the Alerts screen share one column.
            self.assertTrue(self.service.notification_prefs()["dealAlertsEnabled"])
        with self._as("bob"):
            self.assertTrue(self.service.alert_prefs()["priceMovesEnabled"])

    def test_token_registration_stores_the_device_timezone(self) -> None:
        with self._as("alice"):
            self.service.register_push_token(expo_push_token=TOKEN_A, time_zone="Asia/Tokyo")
            self.service.register_push_token(expo_push_token=TOKEN_B, time_zone="Not/AZone")
        rows = dict(self.connection.execute(
            "SELECT expo_push_token, timezone FROM user_push_tokens WHERE owner_user_id = 'alice'"
        ).fetchall())
        self.assertEqual(rows, {TOKEN_A: "Asia/Tokyo", TOKEN_B: None})

    def test_deal_scan_user_lane_uses_the_limiter_when_enabled(self) -> None:
        upsert_card(
            self.connection, card_id="umbreon", name="Umbreon ex", set_name="S", number="1",
            rarity="R", variant="Raw", language="English", game="pokemon",
            source_provider="scrydex", source_record_id="umbreon",
        )
        with self._as("alice"):
            self.service.register_push_token(expo_push_token=TOKEN_A, time_zone="America/Los_Angeles")
        late = datetime(2026, 9, 23, 5, 0, tzinfo=timezone.utc)  # 22:00 LA
        self.connection.execute(
            """
            INSERT INTO deal_alerts (id, owner_user_id, card_id, listing_id, kind, total_cents,
                                     baseline_cents, discount_pct, created_at)
            VALUES ('d1', 'alice', 'umbreon', 'l1', 'under_added', 4100, 5000, 18.0, ?)
            """,
            (late.isoformat(),),
        )
        self.connection.commit()
        posts: list = []

        def transport(url, payload):
            posts.append((url, payload))
            return {"data": [{"status": "ok", "id": f"t{i}"} for i, _ in enumerate(payload)]}

        with patch.dict("os.environ", {ma.ENABLED_ENV: "1"}):
            self.service._send_deal_alert_pushes(self.connection, created_at=late.isoformat(), transport=transport)
        self.assertEqual(posts, [])  # quiet hours: deferred, still pending
        pending = self.connection.execute("SELECT push_sent_at FROM deal_alerts WHERE id = 'd1'").fetchone()[0]
        self.assertIsNone(pending)
        # The hourly job's 09:00 run delivers it.
        ma.run_market_alerts(
            self.connection, now=datetime(2026, 9, 23, 16, 3, tzinfo=timezone.utc), transport=transport
        )
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0][0], expo_push.EXPO_PUSH_URL)
        self.assertEqual(posts[0][1][0]["to"], TOKEN_A)


if __name__ == "__main__":
    unittest.main()
