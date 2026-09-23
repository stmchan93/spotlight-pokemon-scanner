"""Wiring for the watchlist deal radar.

`watch_signals` (the deal engine) and `ebay_listings` (the fetch + listing
validation) are tested in their own suites. This one covers everything that
joins them to the server: the schema patch, the daily scan job, the budget
governor, eBay usage persistence, the endpoints and the monetization verdict.

Every eBay call goes through an injected mock transport — this suite never
touches the network.
"""

from __future__ import annotations

import contextlib
import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import ebay_listings  # noqa: E402
from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    upsert_card,
    upsert_runtime_setting,
    utc_now,
)
from ebay_comps import _reset_ebay_token_cache  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import (  # noqa: E402
    SpotlightRequestHandler,
    SpotlightScanService,
    WATCH_BUDGET_SETTING_KEY,
    WATCH_COST_STAGE_RED,
    WATCH_DEAL_RADAR_SETTING_KEY,
    _apply_watch_deal_radar_schema_patch,
)

CARD_ID = "gym1-60"
CARD_NAME = "Sabrina's Slowbro"
CARD_SET = "Gym Heroes"
CARD_NUMBER = "60/132"

NOW = datetime(2026, 9, 19, 12, 0, 0, tzinfo=timezone.utc)

BROWSE_ENV = {
    "SPOTLIGHT_EBAY_BROWSE_ENABLED": "1",
    "EBAY_CLIENT_ID": "client-id",
    "EBAY_CLIENT_SECRET": "client-secret",
    "EBAY_MARKETPLACE_ID": "EBAY_US",
}


def _summary(
    *,
    item_id: str = "v1|110000000001|0",
    title: str | None = None,
    price: str = "70.00",
) -> dict[str, object]:
    """One `item_summary/search` entry, shaped the way eBay Browse returns it."""
    return {
        "itemId": item_id,
        "legacyItemId": item_id.split("|")[1],
        "title": title or f"{CARD_NAME} {CARD_SET} {CARD_NUMBER} Pokemon Card",
        "price": {"value": price, "currency": "USD"},
        "itemWebUrl": f"https://www.ebay.com/itm/{item_id.split('|')[1]}",
        "buyingOptions": ["FIXED_PRICE"],
        "itemCreationDate": "2026-09-01T07:14:44.000Z",
        "condition": "Ungraded",
        "conditionId": "4000",
        "shippingOptions": [
            {"shippingCostType": "FIXED", "shippingCost": {"value": "0.00", "currency": "USD"}}
        ],
        "image": {"imageUrl": "https://i.ebayimg.com/images/g/abc/s-l1600.jpg"},
    }


class _Transport:
    """Injected mock transport. Counts search calls and refuses any URL the raw
    lane is not supposed to hit."""

    def __init__(
        self,
        summaries: list[dict[str, object]] | None = None,
        *,
        card_condition: str = "Near Mint or Better",
        country: str = "US",
    ) -> None:
        self.summaries = summaries if summaries is not None else [_summary()]
        self.card_condition = card_condition
        self.country = country
        self.urls: list[str] = []

    @property
    def search_calls(self) -> int:
        return sum(1 for url in self.urls if "buy/browse/v1/item_summary/search" in url)

    @property
    def item_calls(self) -> int:
        return sum(1 for url in self.urls if "get_item_by_legacy_id" in url)

    def __call__(self, url: str, **kwargs: object) -> dict[str, object]:
        self.urls.append(url)
        if "identity/v1/oauth2/token" in url:
            return {"access_token": "token-value", "expires_in": 7200}
        if "buy/browse/v1/item_summary/search" in url:
            return {"itemSummaries": self.summaries}
        if "get_item_by_legacy_id" in url:
            legacy_id = url.split("legacy_item_id=")[1]
            return {
                "itemId": f"v1|{legacy_id}|0",
                "legacyItemId": legacy_id,
                "title": f"{CARD_NAME} {CARD_NUMBER}",
                "price": {"value": "70.00", "currency": "USD"},
                "itemLocation": {"country": self.country},
                "conditionDescriptors": [
                    {"name": "Card Condition", "values": [{"content": self.card_condition}]}
                ],
            }
        raise AssertionError(f"Unexpected URL: {url}")


class WatchWiringTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "watch-wiring.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self.connection = self.service.connection
        ebay_listings.reset_ebay_usage()
        _reset_ebay_token_cache()
        self.addCleanup(ebay_listings.reset_ebay_usage)
        self.addCleanup(_reset_ebay_token_cache)

    # --- fixtures --------------------------------------------------------

    def _identity(self, user_id: str) -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _card(
        self,
        card_id: str = CARD_ID,
        *,
        name: str = CARD_NAME,
        set_name: str = CARD_SET,
        number: str = CARD_NUMBER,
        language: str = "English",
    ) -> None:
        upsert_card(
            self.connection,
            card_id=card_id,
            name=name,
            set_name=set_name,
            number=number,
            rarity="Rare",
            variant="Raw",
            language=language,
            game="pokemon",
            source_provider="scrydex",
            source_record_id=card_id,
        )
        self.connection.commit()

    def _watch(
        self,
        owner: str,
        card_id: str = CARD_ID,
        *,
        added: float | None = 100.0,
        target_cents: int | None = None,
    ) -> None:
        self.connection.execute(
            """
            INSERT OR REPLACE INTO card_favorites
                (owner_user_id, card_id, created_at, added_market_price,
                 added_market_date, target_price_cents)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (owner, card_id, utc_now(), added, self._day(120), target_cents),
        )
        self.connection.commit()

    @staticmethod
    def _day(days_ago: int) -> str:
        return (NOW.date() - timedelta(days=days_ago)).isoformat()

    def _history(self, card_id: str = CARD_ID, *, prices: tuple[float, ...] = (100.0, 95.0, 90.0)) -> None:
        """One daily row per price, newest last. Three distinct USD prices clear
        the engine's `distinct_prices` guardrail."""
        for offset, market in enumerate(prices):
            contexts = {
                "variants": {
                    "Normal": {
                        "variant": "Normal",
                        "variantKey": "normal",
                        "conditions": {"NM": {"currencyCode": "USD", "market": market}},
                    }
                }
            }
            self.connection.execute(
                """
                INSERT OR REPLACE INTO card_price_history_daily
                    (card_id, provider, price_date, display_currency_code,
                     raw_contexts_json, updated_at)
                VALUES (?, 'scrydex', ?, 'USD', ?, ?)
                """,
                (
                    card_id,
                    self._day(len(prices) - 1 - offset),
                    json.dumps(contexts),
                    utc_now(),
                ),
            )
        self.connection.commit()

    def _run_scan(self, transport: _Transport, **kwargs: object) -> dict[str, object]:
        with patch.dict("os.environ", BROWSE_ENV, clear=False):
            _reset_ebay_token_cache()
            return self.service.run_deal_scan(now=NOW, fetch_json=transport, **kwargs)

    def _count(self, table: str) -> int:
        return int(self.connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


# --- schema ------------------------------------------------------------------


class SchemaPatchTests(WatchWiringTestCase):
    def test_patch_creates_every_object(self) -> None:
        for table in ("deal_alerts", "ebay_usage_daily", "watch_budget_daily", "ops_alerts"):
            self.assertIsNotNone(
                self.connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
                ).fetchone(),
                table,
            )
        columns = {
            str(row["name"])
            for row in self.connection.execute("PRAGMA table_info(card_favorites)").fetchall()
        }
        self.assertLessEqual(
            {
                "target_price_cents",
                "target_currency",
                "target_set_at",
                "target_triggered_at",
                "fast_lane",
            },
            columns,
        )

    def test_patch_is_idempotent_on_re_run(self) -> None:
        before = self.connection.execute(
            "SELECT name, sql FROM sqlite_master ORDER BY name"
        ).fetchall()
        # Re-running must not raise (duplicate column / table) and must not
        # change a single object: every startup applies this patch.
        _apply_watch_deal_radar_schema_patch(self.connection)
        _apply_watch_deal_radar_schema_patch(self.connection)
        self.connection.commit()
        after = self.connection.execute(
            "SELECT name, sql FROM sqlite_master ORDER BY name"
        ).fetchall()
        self.assertEqual([tuple(row) for row in before], [tuple(row) for row in after])

    def test_deal_alerts_listing_uniqueness_is_per_owner(self) -> None:
        self._card()
        created = utc_now()
        for owner in ("owner-a", "owner-b"):
            self.connection.execute(
                """
                INSERT INTO deal_alerts
                    (id, owner_user_id, card_id, listing_id, kind, total_cents,
                     baseline_cents, created_at)
                VALUES (?, ?, ?, 'listing-1', 'under_added', 100, 200, ?)
                """,
                (f"alert-{owner}", owner, CARD_ID, created),
            )
        self.connection.commit()
        # Same listing, two owners: fine. The same listing twice for ONE owner is
        # what the unique index exists to stop.
        self.assertEqual(self._count("deal_alerts"), 2)
        cursor = self.connection.execute(
            """
            INSERT OR IGNORE INTO deal_alerts
                (id, owner_user_id, card_id, listing_id, kind, total_cents,
                 baseline_cents, created_at)
            VALUES ('alert-dupe', 'owner-a', ?, 'listing-1', 'under_added', 100, 200, ?)
            """,
            (CARD_ID, created),
        )
        self.assertEqual(cursor.rowcount, 0)


# --- the daily scan job ------------------------------------------------------


class DealScanJobTests(WatchWiringTestCase):
    def test_one_ebay_fetch_for_a_card_two_owners_watch(self) -> None:
        self._card()
        self._history()
        self._watch("owner-a")
        self._watch("owner-b")
        transport = _Transport()

        summary = self._run_scan(transport)

        # THE budget-defining assertion: per-user fetching is the single thing
        # that breaks the 5k/day allocation.
        self.assertEqual(transport.search_calls, 1)
        self.assertEqual(summary["ebayCalls"], 1)
        self.assertEqual(summary["owners"], 2)
        self.assertEqual(summary["watchedCards"], 1)
        # Both owners still get their own alert off that single fetch.
        owners = {
            str(row["owner_user_id"])
            for row in self.connection.execute(
                "SELECT owner_user_id FROM deal_alerts"
            ).fetchall()
        }
        self.assertEqual(owners, {"owner-a", "owner-b"})

    def test_alert_row_carries_the_signal(self) -> None:
        self._card()
        self._history()
        self._watch("owner-a")

        self._run_scan(_Transport())

        row = self.connection.execute("SELECT * FROM deal_alerts").fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["kind"], "under_added")
        self.assertEqual(row["total_cents"], 7_000)
        # baseline = min(added 100.00, current market 90.00)
        self.assertEqual(row["baseline_cents"], 9_000)
        self.assertEqual(row["market_cents"], 9_000)
        self.assertEqual(row["savings_cents"], 2_000)
        self.assertAlmostEqual(float(row["discount_pct"]), 22.22, places=2)
        self.assertIsNone(row["seen_at"])
        self.assertIsNone(row["tapped_at"])

    def test_re_run_produces_no_duplicate_alerts(self) -> None:
        self._card()
        self._history()
        self._watch("owner-a")
        transport = _Transport()

        first = self._run_scan(transport)
        second = self._run_scan(transport)

        self.assertEqual(first["alertsCreated"], 1)
        self.assertEqual(second["alertsCreated"], 0)
        self.assertEqual(self._count("deal_alerts"), 1)
        # The second cycle reads the 1h cache instead of spending a call.
        self.assertEqual(transport.search_calls, 1)
        self.assertEqual(second["cacheHits"], 1)

    def test_cache_hit_is_recorded_so_the_hit_rate_is_not_zero(self) -> None:
        self._card()
        self._history()
        self._watch("owner-a")
        transport = _Transport()
        self._run_scan(transport)
        self._run_scan(transport)

        row = self.connection.execute(
            "SELECT api_calls, cache_hits FROM ebay_usage_daily WHERE consumer = 'watch_scan'"
        ).fetchone()
        self.assertIsNotNone(row)
        # The first scan's search + its alert's item-condition check; the
        # second scan is a cache hit and raises nothing new to check.
        self.assertEqual(int(row["api_calls"]), 2)
        self.assertEqual(int(row["cache_hits"]), 1)

    def test_deal_needs_a_near_mint_us_item_page(self) -> None:
        # Plasma Storm Charizard, 2026-09-22: a clean title over "Card
        # Condition: Heavily Played (Poor)" in the item specifics.
        for kwargs, expected in (
            ({"card_condition": "Heavily Played (Poor)"}, 0),
            ({"country": "GB"}, 0),
            ({}, 1),
        ):
            with self.subTest(**kwargs):
                self.connection.execute("DELETE FROM deal_alerts")
                self.connection.execute("DELETE FROM card_ebay_listings_cache")
                self.connection.commit()
                self._card()
                self._history()
                self._watch("owner-a")
                transport = _Transport(**kwargs)
                summary = self._run_scan(transport)
                self.assertEqual(summary["alertsCreated"], expected)
                self.assertEqual(transport.item_calls, 1)

    def test_dry_run_writes_nothing(self) -> None:
        self._card()
        self._history()
        self._watch("owner-a")
        transport = _Transport()

        summary = self._run_scan(transport, dry_run=True)

        self.assertTrue(summary["dryRun"])
        self.assertEqual(summary["watchedCards"], 1)
        self.assertEqual(summary["fetchesNeeded"], 1)
        # No eBay call, and nothing persisted anywhere.
        self.assertEqual(transport.search_calls, 0)
        self.assertEqual(summary["ebayCalls"], 0)
        for table in ("deal_alerts", "watch_budget_daily", "ebay_usage_daily", "ops_alerts"):
            self.assertEqual(self._count(table), 0, table)
        self.assertEqual(self._count("card_ebay_listings_cache"), 0)

    def test_budget_cap_stops_scanning_and_records_the_stage(self) -> None:
        for index in range(3):
            card_id = f"{CARD_ID}-{index}"
            self._card(card_id, number=f"6{index}/132")
            self._history(card_id)
            self._watch("owner-a", card_id)
        # budget 2 - reserve 1 = ONE spendable call for the whole cycle.
        upsert_runtime_setting(
            self.connection,
            key=WATCH_BUDGET_SETTING_KEY,
            value={"dailyBudget": 2, "onDemandReserve": 1, "scansPerCardPerDay": 18},
        )
        self.connection.commit()
        transport = _Transport()

        summary = self._run_scan(transport)

        self.assertTrue(summary["budgetExhausted"])
        self.assertEqual(transport.search_calls, 1)
        self.assertEqual(summary["ebayCalls"], 1)
        row = self.connection.execute("SELECT * FROM watch_budget_daily").fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["stage"], "Cap")
        self.assertEqual(int(row["distinct_watched_cards"]), 3)
        self.assertEqual(int(row["scans_per_card"]), 18)
        # 1 search + 1 OAuth token fetch. The ledger counts EVERY consumer,
        # oauth included: it is a real HTTP call against the allocation, and the
        # token cache amortizes it to a handful a day. No item-condition check:
        # the budget is spent, so the would-be alert is dropped instead.
        self.assertEqual(int(row["actual_calls"]), 2)
        self.assertEqual(transport.item_calls, 0)
        self.assertEqual(summary["alertsCreated"], 0)
        self.assertEqual(
            int(
                self.connection.execute(
                    "SELECT api_calls FROM ebay_usage_daily WHERE consumer = 'watch_scan'"
                ).fetchone()["api_calls"]
            ),
            1,
        )

    def test_target_hit_rearms_the_favorite_row(self) -> None:
        self._card()
        # Crossing, not "is under": the previous point must sit at/above target.
        self._history(prices=(100.0, 95.0, 90.0))
        self._watch("owner-a", target_cents=9_500)

        summary = self._run_scan(_Transport())

        self.assertGreaterEqual(int(summary["targetsRearmed"]), 1)
        row = self.connection.execute(
            "SELECT target_triggered_at FROM card_favorites WHERE owner_user_id = 'owner-a'"
        ).fetchone()
        self.assertIsNotNone(row["target_triggered_at"])

    def test_disabled_flag_short_circuits_the_job(self) -> None:
        self._card()
        self._history()
        self._watch("owner-a")
        upsert_runtime_setting(
            self.connection, key=WATCH_DEAL_RADAR_SETTING_KEY, value={"enabled": False}
        )
        self.connection.commit()
        transport = _Transport()

        summary = self._run_scan(transport)

        self.assertEqual(summary["status"], "disabled")
        self.assertEqual(transport.search_calls, 0)
        self.assertEqual(self._count("deal_alerts"), 0)

    def test_flag_fails_open_when_unset(self) -> None:
        self.assertTrue(self.service.watch_deal_radar_enabled())
        state = self.service.set_watch_deal_radar_mode(enabled=False, note="kill switch")
        self.assertFalse(state["enabled"])
        self.assertEqual(state["note"], "kill switch")
        self.assertTrue(self.service.set_watch_deal_radar_mode(enabled=True)["enabled"])


# --- eBay usage persistence ---------------------------------------------------


class EbayUsagePersistenceTests(WatchWiringTestCase):
    def test_drain_upsert_is_additive(self) -> None:
        ebay_listings.record_ebay_api_call("watch_scan", count=3)
        ebay_listings.record_ebay_cache_hit("watch_scan", count=2)
        self.service._flush_ebay_usage(self.connection, date="2026-09-19")
        # A drain RESETS the counters, so the second batch is a DELTA. An
        # overwriting upsert would lose the first three calls here.
        ebay_listings.record_ebay_api_call("watch_scan", count=4)
        ebay_listings.record_ebay_error("watch_scan", count=1)
        self.service._flush_ebay_usage(self.connection, date="2026-09-19")

        row = self.connection.execute(
            "SELECT * FROM ebay_usage_daily WHERE date = '2026-09-19' AND consumer = 'watch_scan'"
        ).fetchone()
        self.assertEqual(int(row["api_calls"]), 7)
        self.assertEqual(int(row["cache_hits"]), 2)
        self.assertEqual(int(row["errors"]), 1)
        self.assertEqual(self._count("ebay_usage_daily"), 1)

    def test_flush_is_a_no_op_without_counters(self) -> None:
        self.assertEqual(self.service._flush_ebay_usage(self.connection), [])
        self.assertEqual(self._count("ebay_usage_daily"), 0)

    def test_governor_counts_todays_spend_against_the_budget(self) -> None:
        self.connection.execute(
            """
            INSERT INTO ebay_usage_daily (date, consumer, api_calls, cache_hits, errors, updated_at)
            VALUES (?, 'pdp_lowest_listed', 4700, 0, 0, ?)
            """,
            (NOW.date().isoformat(), utc_now()),
        )
        self.connection.commit()
        self._card()
        self._history()
        self._watch("owner-a")
        transport = _Transport()

        summary = self._run_scan(transport)

        # 5000 budget - 300 reserve - 4700 already spent = 0 calls left.
        self.assertEqual(summary["budget"]["remainingCalls"], 0)
        self.assertTrue(summary["budgetExhausted"])
        self.assertEqual(transport.search_calls, 0)


# --- endpoints ---------------------------------------------------------------


class TargetEndpointTests(WatchWiringTestCase):
    def test_set_and_clear_target(self) -> None:
        self._card()
        self._watch("owner-a")
        with self.service.request_identity_context(self._identity("owner-a")):
            set_payload = self.service.set_card_favorite_target(
                CARD_ID, target_price_cents=8_000
            )
            self.assertEqual(set_payload["targetPriceCents"], 8_000)
            self.assertEqual(set_payload["targetCurrency"], "USD")
            self.assertIsNotNone(set_payload["targetSetAt"])

            cleared = self.service.set_card_favorite_target(CARD_ID, target_price_cents=None)
        self.assertIsNone(cleared["targetPriceCents"])
        row = self.connection.execute(
            "SELECT target_price_cents FROM card_favorites WHERE owner_user_id = 'owner-a'"
        ).fetchone()
        self.assertIsNone(row["target_price_cents"])

    def test_changing_the_target_clears_the_rearm_clock(self) -> None:
        self._card()
        self._watch("owner-a", target_cents=9_000)
        self.connection.execute(
            "UPDATE card_favorites SET target_triggered_at = ? WHERE owner_user_id = 'owner-a'",
            (utc_now(),),
        )
        self.connection.commit()
        with self.service.request_identity_context(self._identity("owner-a")):
            # Same value: nothing changed, the 30-day clock survives.
            self.service.set_card_favorite_target(CARD_ID, target_price_cents=9_000)
        self.assertIsNotNone(
            self.connection.execute(
                "SELECT target_triggered_at FROM card_favorites WHERE owner_user_id = 'owner-a'"
            ).fetchone()["target_triggered_at"]
        )
        with self.service.request_identity_context(self._identity("owner-a")):
            self.service.set_card_favorite_target(CARD_ID, target_price_cents=7_500)
        self.assertIsNone(
            self.connection.execute(
                "SELECT target_triggered_at FROM card_favorites WHERE owner_user_id = 'owner-a'"
            ).fetchone()["target_triggered_at"]
        )

    def test_other_owners_watchlist_row_is_a_404(self) -> None:
        self._card()
        self._watch("owner-a")
        with self.service.request_identity_context(self._identity("owner-b")):
            with self.assertRaises(FileNotFoundError):
                self.service.set_card_favorite_target(CARD_ID, target_price_cents=8_000)

    def test_non_positive_target_is_rejected(self) -> None:
        self._card()
        self._watch("owner-a")
        with self.service.request_identity_context(self._identity("owner-a")):
            with self.assertRaises(ValueError):
                self.service.set_card_favorite_target(CARD_ID, target_price_cents=0)

    def test_card_favorites_list_carries_target_price_cents(self) -> None:
        self._card()
        self._watch("owner-a")
        with self.service.request_identity_context(self._identity("owner-a")):
            self.service.set_card_favorite_target(CARD_ID, target_price_cents=8_000)
            payload = self.service.card_favorites()
        self.assertEqual(payload["entries"][0]["targetPriceCents"], 8_000)

    def test_target_change_invalidates_the_cached_wishlist(self) -> None:
        self._card()
        self._watch("owner-a")
        with self.service.request_identity_context(self._identity("owner-a")):
            first = self.service.card_favorites()
            self.assertIsNone(first["entries"][0]["targetPriceCents"])
            self.service.set_card_favorite_target(CARD_ID, target_price_cents=8_000)
            second = self.service.card_favorites()
        self.assertEqual(second["entries"][0]["targetPriceCents"], 8_000)

    def test_put_route_is_owner_scoped(self) -> None:
        identity = self._identity("owner-a")
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/card-favorites/gym1-60/target"
        handler.service = Mock()
        handler.service.request_identity_context.return_value = contextlib.nullcontext()
        handler.service.set_card_favorite_target.return_value = {
            "cardID": CARD_ID,
            "targetPriceCents": 8_000,
        }
        handler._read_json_body = lambda: {"targetPriceCents": 8000}  # type: ignore[method-assign]
        handler._require_request_identity = lambda: identity  # type: ignore[method-assign]
        writes: list[tuple[HTTPStatus, dict[str, object]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]

        handler.do_PUT()

        handler.service.request_identity_context.assert_called_once_with(identity)
        handler.service.set_card_favorite_target.assert_called_once_with(
            CARD_ID, target_price_cents=8000
        )
        self.assertEqual(writes[0][0], HTTPStatus.OK)

    def test_put_route_translates_a_missing_row_to_404(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/card-favorites/gym1-60/target"
        handler.service = Mock()
        handler.service.request_identity_context.return_value = contextlib.nullcontext()
        handler.service.set_card_favorite_target.side_effect = FileNotFoundError("nope")
        handler._read_json_body = lambda: {"targetPriceCents": None}  # type: ignore[method-assign]
        handler._require_request_identity = lambda: self._identity("owner-b")  # type: ignore[method-assign]
        writes: list[tuple[HTTPStatus, dict[str, object]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]

        handler.do_PUT()

        self.assertEqual(writes[0][0], HTTPStatus.NOT_FOUND)


class DealAlertFeedTests(WatchWiringTestCase):
    def _alert(self, alert_id: str, owner: str, *, created_at: str | None = None) -> None:
        self.connection.execute(
            """
            INSERT INTO deal_alerts
                (id, owner_user_id, card_id, listing_id, kind, total_cents,
                 baseline_cents, market_cents, discount_pct, savings_cents,
                 url, verification_tier, created_at)
            VALUES (?, ?, ?, ?, 'under_added', 7000, 9000, 9000, 22.22, 2000,
                    'https://ebay.test/1', 'title', ?)
            """,
            (alert_id, owner, CARD_ID, f"listing-{alert_id}", created_at or utc_now()),
        )
        self.connection.commit()

    def test_feed_is_owner_scoped_and_newest_first(self) -> None:
        self._card()
        self._alert("a1", "owner-a", created_at="2026-09-17T00:00:00+00:00")
        self._alert("a2", "owner-a", created_at="2026-09-18T00:00:00+00:00")
        self._alert("b1", "owner-b")
        with self.service.request_identity_context(self._identity("owner-a")):
            payload = self.service.deal_alerts()
        self.assertEqual([alert["id"] for alert in payload["alerts"]], ["a2", "a1"])
        self.assertEqual(payload["unseenCount"], 2)

    def test_seen_and_tapped_stamp_once(self) -> None:
        self._card()
        self._alert("a1", "owner-a")
        with self.service.request_identity_context(self._identity("owner-a")):
            seen = self.service.mark_deal_alert("a1", field="seen_at")
            self.assertIsNotNone(seen["seenAt"])
            tapped = self.service.mark_deal_alert("a1", field="tapped_at")
            self.assertIsNotNone(tapped["tappedAt"])
            # tapped_at is load-bearing for the monetization verdict: a second
            # tap must not move the first timestamp.
            again = self.service.mark_deal_alert("a1", field="tapped_at")
        self.assertEqual(again["tappedAt"], tapped["tappedAt"])

    def test_other_owners_alert_is_a_404(self) -> None:
        self._card()
        self._alert("a1", "owner-a")
        with self.service.request_identity_context(self._identity("owner-b")):
            with self.assertRaises(FileNotFoundError):
                self.service.mark_deal_alert("a1", field="tapped_at")
        self.assertIsNone(
            self.connection.execute(
                "SELECT tapped_at FROM deal_alerts WHERE id = 'a1'"
            ).fetchone()["tapped_at"]
        )

    def test_alerts_are_self_describing(self) -> None:
        """An alert carries its own name + thumbnail. The band must NOT have to
        join it against the loaded watchlist: a deal on a card the user just
        un-watched would then render as an invisible row."""
        upsert_card(
            self.connection,
            card_id=CARD_ID,
            name=CARD_NAME,
            set_name=CARD_SET,
            number=CARD_NUMBER,
            rarity="Rare",
            variant="Raw",
            language="English",
            game="pokemon",
            source_provider="scrydex",
            source_record_id=CARD_ID,
            image_url="https://img.test/large.png",
            image_small_url="https://img.test/small.png",
        )
        self.connection.commit()
        self._alert("a1", "owner-a")
        with self.service.request_identity_context(self._identity("owner-a")):
            payload = self.service.deal_alerts()
            marked = self.service.mark_deal_alert("a1", field="seen_at")
        alert = payload["alerts"][0]
        self.assertEqual(alert["cardName"], CARD_NAME)
        # The thumbnail, not the full-size art: this renders in a compact row.
        self.assertEqual(alert["imageUrl"], "https://img.test/small.png")
        # Existing fields are untouched — the client normalizers tolerate
        # additions, not removals.
        self.assertEqual(alert["cardID"], CARD_ID)
        self.assertEqual(alert["totalCents"], 7_000)
        self.assertEqual(alert["listingID"], "listing-a1")
        # The seen/tapped responses carry the same enriched shape.
        self.assertEqual(marked["cardName"], CARD_NAME)
        self.assertEqual(marked["imageUrl"], "https://img.test/small.png")

    def test_post_route_maps_suffix_to_column(self) -> None:
        identity = self._identity("owner-a")
        for suffix, field in (("/seen", "seen_at"), ("/tapped", "tapped_at")):
            handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
            handler.path = f"/api/v1/deal-alerts/a1{suffix}"
            handler.service = Mock()
            handler.service.request_identity_context.return_value = contextlib.nullcontext()
            handler.service.mark_deal_alert.return_value = {"id": "a1"}
            handler._read_json_body = lambda: {}  # type: ignore[method-assign]
            handler._require_request_identity = lambda: identity  # type: ignore[method-assign]
            handler._write_json = Mock()  # type: ignore[method-assign]

            handler.do_POST()

            handler.service.mark_deal_alert.assert_called_once_with("a1", field=field)


class RawListingsEndpointTests(WatchWiringTestCase):
    def test_variant_shapes_the_response_without_a_second_fetch(self) -> None:
        self._card()
        transport = _Transport(
            [
                _summary(
                    item_id="v1|1|0",
                    title=f"{CARD_NAME} 1st Edition {CARD_SET} {CARD_NUMBER}",
                    price="80.00",
                ),
                _summary(item_id="v1|2|0", price="70.00"),
            ]
        )
        with patch.dict("os.environ", BROWSE_ENV, clear=False):
            _reset_ebay_token_cache()
            unfiltered = self.service.card_raw_ebay_listings(
                CARD_ID, fetch_json=transport
            )
            first_edition = self.service.card_raw_ebay_listings(
                CARD_ID, variant="1st Edition", fetch_json=transport
            )
            unlimited = self.service.card_raw_ebay_listings(
                CARD_ID, variant="Unlimited", fetch_json=transport
            )

        # ONE call for three differently-shaped responses: `variant` filters the
        # single cached page and never reaches the cache key or the query.
        self.assertEqual(transport.search_calls, 1)
        self.assertFalse(unfiltered["cached"])
        self.assertTrue(first_edition["cached"])
        self.assertEqual(unfiltered["candidateCount"], 2)
        self.assertEqual(
            [row["itemID"] for row in first_edition["candidates"]], ["v1|1|0"]
        )
        self.assertEqual([row["itemID"] for row in unlimited["candidates"]], ["v1|2|0"])
        self.assertEqual(first_edition["variant"], "1st Edition")

        # ONE cache row, pinned to the raw key regardless of printing.
        rows = self.connection.execute(
            "SELECT card_id, grader, grade, variant FROM card_ebay_listings_cache"
        ).fetchall()
        self.assertEqual(
            [tuple(row) for row in rows],
            [(CARD_ID, ebay_listings.RAW_CACHE_GRADER, ebay_listings.RAW_CACHE_GRADE, "")],
        )

    def test_cache_hits_are_attributed_to_the_pdp_consumer(self) -> None:
        self._card()
        transport = _Transport()
        with patch.dict("os.environ", BROWSE_ENV, clear=False):
            _reset_ebay_token_cache()
            self.service.card_raw_ebay_listings(CARD_ID, fetch_json=transport)
            self.service.card_raw_ebay_listings(CARD_ID, fetch_json=transport)
        snapshot = ebay_listings.ebay_usage_snapshot()
        self.assertEqual(snapshot["pdp_lowest_listed"]["api_calls"], 1)
        self.assertEqual(snapshot["pdp_lowest_listed"]["cache_hits"], 1)

    def test_limit_caps_the_served_candidates(self) -> None:
        self._card()
        transport = _Transport(
            [_summary(item_id=f"v1|{index}|0", price=f"{60 + index}.00") for index in range(5)]
        )
        with patch.dict("os.environ", BROWSE_ENV, clear=False):
            _reset_ebay_token_cache()
            payload = self.service.card_raw_ebay_listings(
                CARD_ID, limit=2, fetch_json=transport
            )
        self.assertEqual(payload["candidateCount"], 2)

    def test_unknown_card_is_none(self) -> None:
        self.assertIsNone(self.service.card_raw_ebay_listings("does-not-exist"))


# --- tripwires + monetization -------------------------------------------------


class TripwireTests(WatchWiringTestCase):
    def _cost(self, headroom: float) -> dict[str, object]:
        return {"headroom": headroom, "stage": self.service._watch_cost_stage(headroom)}

    def _value(
        self,
        *,
        tap_through: float = 0.0,
        reliance: int = 0,
        per_week: float = 0.0,
        concentration: float = 0.0,
    ) -> dict[str, object]:
        return {
            "tapThroughRate": tap_through,
            "relianceUsers": reliance,
            "alertsPerWatcherPerWeek": per_week,
            "tapConcentrationTop10Pct": concentration,
        }

    def test_cost_stages(self) -> None:
        self.assertEqual(self.service._watch_cost_stage(0.10), "Green")
        self.assertEqual(self.service._watch_cost_stage(0.49), "Green")
        self.assertEqual(self.service._watch_cost_stage(0.50), "Amber")
        self.assertEqual(self.service._watch_cost_stage(0.74), "Amber")
        self.assertEqual(self.service._watch_cost_stage(0.75), "Red")
        self.assertEqual(self.service._watch_cost_stage(0.99), "Red")
        self.assertEqual(self.service._watch_cost_stage(1.00), "Cap")
        self.assertEqual(self.service._watch_cost_stage(4.20), "Cap")

    def test_headroom_uses_budget_minus_reserve(self) -> None:
        upsert_runtime_setting(
            self.connection,
            key=WATCH_BUDGET_SETTING_KEY,
            value={"dailyBudget": 5000, "onDemandReserve": 300, "scansPerCardPerDay": 18},
        )
        self.connection.commit()
        cost = self.service._watch_cost_tripwire(self.connection, distinct_watched_cards=100)
        self.assertEqual(cost["projectedDailyCalls"], 1800)
        self.assertEqual(cost["spendableCalls"], 4700)
        self.assertAlmostEqual(float(cost["headroom"]), 1800 / 4700, places=4)
        self.assertEqual(cost["stage"], "Green")

    def test_every_monetization_stage(self) -> None:
        thresholds = self.service._watch_monetization_thresholds(self.connection)

        not_ready = self.service._watch_monetization_verdict(
            cost=self._cost(0.10),
            value=self._value(tap_through=0.05, per_week=0.2),
            thresholds=thresholds,
        )
        self.assertEqual(not_ready["stage"], "not_ready")

        prove_value = self.service._watch_monetization_verdict(
            cost=self._cost(0.10),
            value=self._value(tap_through=0.20, reliance=3, per_week=2.0),
            thresholds=thresholds,
        )
        self.assertEqual(prove_value["stage"], "prove_value")

        ready = self.service._watch_monetization_verdict(
            cost=self._cost(0.10),
            value=self._value(tap_through=0.30, reliance=25, per_week=2.0),
            thresholds=thresholds,
        )
        self.assertEqual(ready["stage"], "ready_to_charge")

        # Cost beats every value stage: at Red the lever has to move regardless.
        must_ration = self.service._watch_monetization_verdict(
            cost=self._cost(0.80),
            value=self._value(tap_through=0.30, reliance=25, per_week=2.0),
            thresholds=thresholds,
        )
        self.assertEqual(must_ration["stage"], "must_ration")
        self.assertTrue(must_ration["reasons"])

    def test_recommended_lever_follows_concentration(self) -> None:
        thresholds = self.service._watch_monetization_thresholds(self.connection)
        concentrated = self.service._watch_monetization_verdict(
            cost=self._cost(0.10),
            value=self._value(tap_through=0.30, reliance=25, per_week=2.0, concentration=0.9),
            thresholds=thresholds,
        )
        spread = self.service._watch_monetization_verdict(
            cost=self._cost(0.10),
            value=self._value(tap_through=0.30, reliance=25, per_week=2.0, concentration=0.1),
            thresholds=thresholds,
        )
        self.assertEqual(concentrated["recommendedLever"], "slots")
        self.assertEqual(spread["recommendedLever"], "speed")

    def test_value_tripwire_reads_taps(self) -> None:
        self._card()
        self._watch("owner-a")
        self._watch("owner-b")
        created = utc_now()
        rows = [
            ("a1", "owner-a", created, created),
            ("a2", "owner-a", created, created),
            ("a3", "owner-a", created, None),
            ("b1", "owner-b", created, created),
            ("b2", "owner-b", created, None),
        ]
        for alert_id, owner, created_at, tapped_at in rows:
            self.connection.execute(
                """
                INSERT INTO deal_alerts
                    (id, owner_user_id, card_id, listing_id, kind, total_cents,
                     baseline_cents, created_at, tapped_at)
                VALUES (?, ?, ?, ?, 'under_added', 7000, 9000, ?, ?)
                """,
                (alert_id, owner, CARD_ID, f"listing-{alert_id}", created_at, tapped_at),
            )
        self.connection.commit()

        value = self.service._watch_value_tripwire(self.connection)
        self.assertEqual(value["alertsSent"], 5)
        self.assertEqual(value["taps"], 3)
        self.assertEqual(value["watchers"], 2)
        self.assertEqual(value["usersWithTap"], 2)
        # RELIANCE: only owner-a tapped twice.
        self.assertEqual(value["relianceUsers"], 1)
        self.assertAlmostEqual(float(value["tapThroughRate"]), 0.6, places=4)

    def test_stage_changes_are_edge_triggered(self) -> None:
        first = self.service._record_tripwire_stage_change(
            self.connection, cost_stage="Amber", value_stage="not_ready"
        )
        self.assertEqual(len(first), 2)
        # Same stages again: no new ops_alerts row. A month at Amber is one alert.
        repeat = self.service._record_tripwire_stage_change(
            self.connection, cost_stage="Amber", value_stage="not_ready"
        )
        self.assertEqual(repeat, [])
        self.assertEqual(self._count("ops_alerts"), 2)
        moved = self.service._record_tripwire_stage_change(
            self.connection, cost_stage="Red", value_stage="not_ready"
        )
        self.assertEqual([alert["kind"] for alert in moved], ["watch_cost_stage"])
        self.assertEqual(self._count("ops_alerts"), 3)

    def test_ops_alerts_never_reach_the_user_feed(self) -> None:
        self._card()
        self.service._record_tripwire_stage_change(
            self.connection, cost_stage="Red", value_stage="must_ration"
        )
        self.assertGreater(self._count("ops_alerts"), 0)
        with self.service.request_identity_context(self._identity("owner-a")):
            payload = self.service.deal_alerts()
        self.assertEqual(payload["alerts"], [])
        self.assertEqual(payload["unseenCount"], 0)

    def test_weeks_to_red_needs_a_prior_week_and_growth(self) -> None:
        settings = self.service._watch_budget_settings(self.connection)
        self.assertIsNone(
            self.service._watch_weeks_to_red(
                self.connection, distinct_watched_cards=100, settings=settings
            )
        )
        old = (datetime.now(timezone.utc) - timedelta(days=8)).date().isoformat()
        self.connection.execute(
            """
            INSERT INTO watch_budget_daily
                (date, distinct_watched_cards, scans_per_card, projected_calls,
                 actual_calls, budget, stage, updated_at)
            VALUES (?, 80, 18, 1440, 10, 5000, 'Green', ?)
            """,
            (old, utc_now()),
        )
        self.connection.commit()
        # Derived, not hardcoded, so a change to the scans-per-day default (it
        # tracks the cron, which skips the Scrydex window) moves the expectation
        # with it instead of failing this test.
        cards_at_red = (
            WATCH_COST_STAGE_RED
            * (settings["dailyBudget"] - settings["onDemandReserve"])
            / settings["scansPerCardPerDay"]
        )
        expected_weeks = (cards_at_red - 100) / 20  # +20 cards/week, from 80 to 100
        weeks = self.service._watch_weeks_to_red(
            self.connection, distinct_watched_cards=100, settings=settings
        )
        self.assertIsNotNone(weeks)
        self.assertAlmostEqual(float(weeks), expected_weeks, places=1)


class OpsEndpointTests(WatchWiringTestCase):
    def test_ebay_usage_summary_shape(self) -> None:
        self.connection.execute(
            """
            INSERT INTO ebay_usage_daily (date, consumer, api_calls, cache_hits, errors, updated_at)
            VALUES (?, 'watch_scan', 120, 380, 2, ?)
            """,
            (date.today().isoformat(), utc_now()),
        )
        self.connection.commit()
        payload = self.service.ebay_usage_summary(days=7)
        self.assertTrue(payload["featureEnabled"])
        self.assertEqual(payload["byConsumer"][0]["consumer"], "watch_scan")
        self.assertEqual(payload["byConsumer"][0]["apiCalls"], 120)
        self.assertAlmostEqual(
            float(payload["byConsumer"][0]["cacheHitRate"]), 380 / 500, places=4
        )
        for key in ("cost", "value", "monetization", "thresholds", "daily"):
            self.assertIn(key, payload)
        self.assertIn("weeksToRed", payload["cost"])
        self.assertIn("recommendedLever", payload["monetization"])

    def test_run_deal_scan_route_is_token_gated_and_fire_and_forget(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/ops/run-deal-scan?token=wrong&dryRun=1"
        handler.service = Mock()
        handler._read_json_body = lambda: {}  # type: ignore[method-assign]
        writes: list[tuple[HTTPStatus, dict[str, object]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]
        with patch.dict("os.environ", {"SPOTLIGHT_OPS_REFRESH_TOKEN": "secret"}, clear=False):
            handler.do_POST()
        self.assertEqual(writes[0][0], HTTPStatus.UNAUTHORIZED)

        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/ops/run-deal-scan?token=secret&dryRun=1"
        handler.service = Mock()
        handler._read_json_body = lambda: {}  # type: ignore[method-assign]
        writes = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]
        with patch.dict("os.environ", {"SPOTLIGHT_OPS_REFRESH_TOKEN": "secret"}, clear=False):
            handler.do_POST()
        self.assertEqual(writes, [(HTTPStatus.OK, {"status": "started"})])
        handler.service.run_deal_scan_worker.assert_called_once_with(dry_run=True, source="ops")

    def test_ebay_usage_route_is_token_gated(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/ops/ebay-usage?days=7&token=wrong"
        handler.service = Mock()
        writes: list[tuple[HTTPStatus, dict[str, object]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]
        with patch.dict("os.environ", {"SPOTLIGHT_OPS_REFRESH_TOKEN": "secret"}, clear=False):
            handler.do_GET()
        self.assertEqual(writes[0][0], HTTPStatus.UNAUTHORIZED)
        handler.service.ebay_usage_summary.assert_not_called()


if __name__ == "__main__":
    unittest.main()
