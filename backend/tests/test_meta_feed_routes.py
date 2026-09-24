"""Social-feed market routes in server.py: /api/v1/market/meta, /market/hot,
/market/set-spotlight, /market/sets/{id}/spotlight and /feed/news.

Each route is flag-gated (404 {"error": "disabled"} when off), validates its
query params (400), and serves the module payload builders' contract shape.
Handlers run against a real SpotlightScanService over a temp DB; no network.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from typing import Any
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    upsert_card,
    upsert_expansion,
    upsert_runtime_setting,
    utc_now,
)
from request_auth import RequestAuthError, RequestIdentity  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402

FLAGS = ("META_PULSE_ENABLED", "HOT_CARDS_ENABLED", "SET_SPOTLIGHT_ENABLED", "NEWS_FEED_ENABLED")

META_PULSE_KEYS = {
    "game", "windowDays", "lane", "availableWindows", "availableGames", "computedAt",
    "asOfDate", "headline", "summary", "groups", "ladders",
}
HOT_CARDS_KEYS = {"computedAt", "windowHours", "minDistinctUsers", "eligible", "items"}
HOT_CARD_KEYS = {
    "cardId", "game", "name", "number", "setName", "imageUrl", "distinctUsers",
    "baselineRatio", "priceNow", "changePercent7d", "currencyCode",
}
SET_SPOTLIGHT_KEYS = {"computedAt", "set", "topByPrice", "topMovers", "topPsa10", "callout", "videos", "news"}
NEWS_ITEM_KEYS = {
    "id", "kind", "source", "title", "url", "imageUrl", "publishedAt", "game", "setId",
    "cardIds", "tags", "video",
}


class MetaFeedRoutesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "meta-feed.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        env = mock.patch.dict(os.environ, {"SPOTLIGHT_PAYLOAD_CACHE_DIR": ""})
        env.start()
        self.addCleanup(env.stop)
        for flag in FLAGS:
            os.environ.pop(flag, None)
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(lambda: self.service.connection.close())
        self.conn = self.service.connection

    # --- harness ------------------------------------------------------------

    def _get(self, path: str, *, flags: tuple[str, ...] = FLAGS) -> tuple[HTTPStatus, dict[str, Any]]:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.headers = {}
        handler.service = self.service
        writes: list[tuple[HTTPStatus, dict[str, Any]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]
        with mock.patch.dict(os.environ, {flag: "1" for flag in flags}):
            handler.do_GET()
        self.assertEqual(len(writes), 1, writes)
        return writes[0]

    # --- seeding ------------------------------------------------------------

    def _seed_meta(self, *, computed_at: str = "2026-09-23T07:10:00+00:00") -> None:
        as_of = "2026-09-22"
        self.conn.execute(
            "INSERT OR REPLACE INTO meta_pulse_runs VALUES ('pokemon', ?, 7, 'raw', 40, 20, 1100, 1000, 1, ?)",
            (as_of, computed_at),
        )
        self.conn.execute(
            "INSERT OR REPLACE INTO meta_pulse_groups VALUES ('pokemon', ?, 7, 'raw', 'vintage:raw', "
            "'vintage', 'Vintage', 'pre-2003 · 40 cards', 12.5, 1100, 1000, 100, 40, 20, '[1, 2]', ?)",
            (as_of, computed_at),
        )
        upsert_runtime_setting(
            self.conn, key="meta_pulse_last_run", value={"asOfDate": as_of, "computedAt": computed_at}
        )
        self.conn.commit()

    def _seed_card(self, card_id: str, *, set_id: str = "sv8", game: str = "pokemon") -> None:
        upsert_card(
            self.conn, card_id=card_id, name=f"Card {card_id}", set_name="Surging Sparks",
            number="1/191", rarity="Rare", variant="Raw", language="English", game=game,
            source_provider="scrydex", source_record_id=card_id, set_id=set_id,
            image_small_url=f"https://img/{card_id}.png",
        )

    def _seed_hot(self, *, computed_at: str = "2026-09-23T10:41:00+00:00") -> None:
        self._seed_card("sv8-1")
        self.conn.execute(
            "INSERT INTO hot_cards_runs VALUES (?, 24, 14, 15, 3, 25, 40, 1)", (computed_at,)
        )
        self.conn.execute(
            "INSERT INTO hot_cards VALUES (?, 1, 'sv8-1', 'pokemon', 7, 1.0, 4.2, 9.0, 12.5, 3.0)",
            (computed_at,),
        )
        self.conn.commit()

    def _seed_set(self) -> None:
        upsert_expansion(
            self.conn, expansion_id="sv8", name="Surging Sparks", series="Scarlet & Violet",
            code="SSP", release_date="2024-11-08", logo_url="https://logo/sv8.png", game="pokemon",
        )
        for i in range(3):
            self._seed_card(f"sv8-{i}")
        self.conn.commit()

    def _seed_news(self) -> None:
        import news_feed

        news_feed.ensure_schema(self.conn)
        rows = [
            ("a1", "news", "PokéBeach", "Set reveal", "2026-09-22T10:00:00+00:00", "pokemon", "sv8"),
            ("a2", "market", "TCGplayer", "Prices", "2026-09-21T10:00:00+00:00", "pokemon", None),
            ("a3", "news", "onepiece.gg", "Ban list", "2026-09-20T10:00:00+00:00", "onepiece", None),
        ]
        self.conn.executemany(
            "INSERT INTO news_items (id, kind, source, title, url, published_at, game, set_id, fetched_at) "
            "VALUES (?, ?, ?, ?, 'https://example.test/x', ?, ?, ?, ?)",
            [(*row, utc_now()) for row in rows],
        )
        self.conn.commit()

    # --- flags --------------------------------------------------------------

    def test_every_route_is_404_disabled_when_its_flag_is_off(self) -> None:
        paths = {
            "/api/v1/market/meta": "META_PULSE_ENABLED",
            "/api/v1/market/hot": "HOT_CARDS_ENABLED",
            "/api/v1/market/set-spotlight": "SET_SPOTLIGHT_ENABLED",
            "/api/v1/market/sets/sv8/spotlight": "SET_SPOTLIGHT_ENABLED",
            "/api/v1/feed/news": "NEWS_FEED_ENABLED",
        }
        for path, flag in paths.items():
            with self.subTest(path=path):
                # Every OTHER flag on: only its own flag gates it.
                others = tuple(f for f in FLAGS if f != flag)
                self.assertEqual(self._get(path, flags=others), (HTTPStatus.NOT_FOUND, {"error": "disabled"}))

    def test_startup_creates_feed_tables(self) -> None:
        tables = {
            row[0]
            for row in self.conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        }
        for table in ("meta_pulse_groups", "meta_pulse_cards", "meta_pulse_runs", "hot_cards_runs",
                      "hot_cards", "set_spotlight_picks", "news_items", "youtube_quota_usage"):
            self.assertIn(table, tables)

    # --- meta ---------------------------------------------------------------

    def test_meta_returns_contract_shape(self) -> None:
        self._seed_meta()
        status, payload = self._get("/api/v1/market/meta?game=pokemon&window=7&lane=raw")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(set(payload), META_PULSE_KEYS)
        self.assertEqual((payload["game"], payload["windowDays"], payload["lane"]), ("pokemon", 7, "raw"))
        self.assertEqual([g["groupKey"] for g in payload["groups"]], ["vintage:raw"])
        # Defaults: pokemon / 7 / all.
        status, payload = self._get("/api/v1/market/meta")
        self.assertEqual((status, payload["game"], payload["windowDays"], payload["lane"]),
                         (HTTPStatus.OK, "pokemon", 7, "all"))

    def test_meta_rejects_bad_params(self) -> None:
        for query in ("window=14", "window=abc", "lane=slab", "game=yugioh"):
            with self.subTest(query=query):
                status, payload = self._get(f"/api/v1/market/meta?{query}")
                self.assertEqual(status, HTTPStatus.BAD_REQUEST)
                self.assertIn("error", payload)

    def test_meta_cache_follows_the_version_token(self) -> None:
        self._seed_meta()
        first = self.service.market_meta_pulse(game="pokemon", window_days=7, lane="all")
        self.assertIs(self.service.market_meta_pulse(game="pokemon", window_days=7, lane="all"), first)
        self._seed_meta(computed_at="2026-09-24T07:10:00+00:00")
        self.assertIsNot(self.service.market_meta_pulse(game="pokemon", window_days=7, lane="all"), first)

    # --- meta v4: group page + exposure --------------------------------------

    def _seed_meta_v4(self) -> None:
        self._seed_meta()
        as_of, computed_at = "2026-09-22", "2026-09-23T07:10:00+00:00"
        rows = [
            ("pokemon", as_of, 7, "raw", "vintage:raw", rank, f"old-{rank}", f"Old {rank}", None, None, None,
             None, None, None, 10.0 + rank, 10.0, float(rank) * 10.0)
            for rank in range(1, 21)
        ]
        self.conn.executemany(
            "INSERT INTO meta_pulse_cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows
        )
        upsert_card(
            self.conn, card_id="base-4", name="Charizard", set_name="Base Set", number="4/102",
            rarity="Rare Holo", variant="Raw", language="English", game="pokemon",
            source_provider="scrydex", source_record_id="base-4", set_release_date="1999/01/09",
            image_small_url="https://img/base-4.png",
        )
        for price_date, price in (("2026-09-15", 300.0), ("2026-09-22", 330.0)):
            self.conn.execute(
                "INSERT INTO card_price_history_daily (card_id, provider, price_date, display_currency_code, "
                "main_raw_market_price, main_raw_variant, updated_at) VALUES ('base-4', 'scrydex', ?, 'USD', ?, "
                "'Holofoil', ?)",
                (price_date, price, utc_now()),
            )
        self.conn.execute(
            "INSERT INTO deck_entries (id, owner_user_id, identity_key, item_kind, card_id, quantity, "
            "added_at, updated_at) VALUES ('e1', 'alice', 'base-4|raw', 'raw', 'base-4', 1, ?, ?)",
            (utc_now(), utc_now()),
        )
        self.conn.commit()

    def _get_as(self, path: str, user_id: str | None) -> tuple[HTTPStatus, dict[str, Any]]:
        auth = self.service.authenticator
        if user_id is None:
            side_effect: Any = RequestAuthError("Authentication required.")
            resolver = mock.patch.object(auth, "resolve_identity", side_effect=side_effect)
        else:
            resolver = mock.patch.object(
                auth, "resolve_identity",
                return_value=RequestIdentity(user_id=user_id, auth_source="test", email=""),
            )
        with resolver, mock.patch.object(self.service, "access_allowed", return_value=True):
            return self._get(path)

    def test_meta_v4_routes_are_404_disabled_when_flag_off(self) -> None:
        others = tuple(f for f in FLAGS if f != "META_PULSE_ENABLED")
        for path in ("/api/v1/market/meta/groups/vintage:raw", "/api/v1/market/meta/me"):
            with self.subTest(path=path):
                self.assertEqual(self._get(path, flags=others), (HTTPStatus.NOT_FOUND, {"error": "disabled"}))

    def test_meta_group_detail_route(self) -> None:
        self._seed_meta_v4()
        status, payload = self._get("/api/v1/market/meta/groups/vintage%3Araw?game=pokemon&window=7&lane=raw")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(set(payload), {"game", "windowDays", "group", "asOfDate"})
        self.assertEqual(payload["group"]["groupKey"], "vintage:raw")
        cards = payload["group"]["topCards"]
        self.assertEqual(len(cards), 20)
        self.assertEqual(cards[0]["cardId"], "old-20")  # riser: changePercent desc
        # The feed keeps only the first five stored cards.
        status, feed = self._get("/api/v1/market/meta")
        self.assertEqual([c["cardId"] for c in feed["groups"][0]["topCards"]], [f"old-{r}" for r in range(1, 6)])
        self.assertEqual(self._get("/api/v1/market/meta/groups/nope:raw"), (HTTPStatus.NOT_FOUND, {"error": "not_found"}))
        self.assertEqual(self._get("/api/v1/market/meta/groups/"), (HTTPStatus.NOT_FOUND, {"error": "not_found"}))
        self.assertEqual(self._get("/api/v1/market/meta/groups/vintage:raw?window=14")[0], HTTPStatus.BAD_REQUEST)

    def test_meta_group_cache_follows_the_version_token(self) -> None:
        self._seed_meta_v4()
        first = self.service.market_meta_group(game="pokemon", window_days=7, lane="all", group_key="vintage:raw")
        self.assertIs(
            self.service.market_meta_group(game="pokemon", window_days=7, lane="all", group_key="vintage:raw"), first
        )
        self._seed_meta(computed_at="2026-09-24T07:10:00+00:00")
        self.assertIsNot(
            self.service.market_meta_group(game="pokemon", window_days=7, lane="all", group_key="vintage:raw"), first
        )

    def test_meta_exposure_requires_auth_and_is_owner_scoped(self) -> None:
        self._seed_meta_v4()
        status, payload = self._get_as("/api/v1/market/meta/me", None)
        self.assertEqual(status, HTTPStatus.UNAUTHORIZED)
        status, payload = self._get_as("/api/v1/market/meta/me?game=pokemon&window=7", "alice")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(set(payload), {"game", "windowDays", "callout", "groups"})
        owned = payload["groups"]["vintage:raw"]
        self.assertEqual((owned["ownedCount"], owned["valueChangeUsd"]), (1, 30.0))
        self.assertEqual(payload["callout"]["title"], "Your vintage is up +$30 this week")
        # bob owns nothing: alice's card never shows up for him (and the cache is per owner).
        status, payload = self._get_as("/api/v1/market/meta/me", "bob")
        self.assertEqual((status, payload["groups"], payload["callout"]), (HTTPStatus.OK, {}, None))
        self.assertEqual(self._get_as("/api/v1/market/meta/me?window=5", "alice")[0], HTTPStatus.BAD_REQUEST)
        with self.assertRaises(ValueError):
            self.service.market_meta_exposure(owner_user_id="", game="pokemon", window_days=7)


    # --- hot ----------------------------------------------------------------

    def test_hot_empty_is_ineligible(self) -> None:
        status, payload = self._get("/api/v1/market/hot")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(set(payload), HOT_CARDS_KEYS)
        self.assertEqual((payload["eligible"], payload["items"]), (False, []))

    def test_hot_serves_newest_run_and_filters_by_game(self) -> None:
        self._seed_hot()
        status, payload = self._get("/api/v1/market/hot?game=pokemon")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertTrue(payload["eligible"])
        self.assertEqual([i["cardId"] for i in payload["items"]], ["sv8-1"])
        self.assertEqual(set(payload["items"][0]), HOT_CARD_KEYS)
        status, payload = self._get("/api/v1/market/hot?game=lorcana")
        self.assertEqual((status, payload["items"]), (HTTPStatus.OK, []))
        self.assertEqual(self._get("/api/v1/market/hot?game=bogus")[0], HTTPStatus.BAD_REQUEST)

    def test_hot_cache_follows_the_newest_run(self) -> None:
        self._seed_hot()
        first = self.service.market_hot_cards(game=None)
        self.assertIs(self.service.market_hot_cards(game=None), first)
        self.conn.execute("INSERT INTO hot_cards_runs VALUES ('2026-09-23T11:41:00+00:00', 24, 14, 15, 3, 25, 1, 0)")
        self.conn.commit()
        refreshed = self.service.market_hot_cards(game=None)
        self.assertFalse(refreshed["eligible"])

    # --- set spotlight ------------------------------------------------------

    def test_set_spotlight_without_pick_or_unknown_set_is_not_found(self) -> None:
        self.assertEqual(self._get("/api/v1/market/set-spotlight"), (HTTPStatus.NOT_FOUND, {"error": "not_found"}))
        self.assertEqual(
            self._get("/api/v1/market/sets/nope/spotlight"), (HTTPStatus.NOT_FOUND, {"error": "not_found"})
        )
        self.assertEqual(self._get("/api/v1/market/sets//spotlight")[0], HTTPStatus.NOT_FOUND)

    def test_set_spotlight_by_id_and_stored_pick(self) -> None:
        self._seed_set()
        status, payload = self._get("/api/v1/market/sets/sv8/spotlight")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(set(payload), SET_SPOTLIGHT_KEYS)
        self.assertEqual((payload["set"]["setId"], payload["set"]["cardCount"]), ("sv8", 3))
        # Non-pick sets are TTL-cached.
        self.assertIs(self.service.market_set_spotlight(set_id="sv8"),
                      self.service.market_set_spotlight(set_id="sv8"))

        stored = dict(payload, computedAt="stored")
        import json

        self.conn.execute(
            "INSERT INTO set_spotlight_picks (week_start, set_id, game, picked_at, computed_at, payload_json) "
            "VALUES ('2026-09-21', 'sv8', 'pokemon', ?, ?, ?)",
            (utc_now(), "2026-09-23T07:25:00+00:00", json.dumps(stored)),
        )
        self.conn.commit()
        status, pick = self._get("/api/v1/market/set-spotlight")
        self.assertEqual((status, pick["computedAt"]), (HTTPStatus.OK, "stored"))

    # --- news ---------------------------------------------------------------

    def test_news_filters_and_contract_shape(self) -> None:
        self._seed_news()
        status, payload = self._get("/api/v1/feed/news?game=pokemon&limit=1")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(set(payload), {"items", "nextCursor"})
        self.assertEqual([i["id"] for i in payload["items"]], ["a1"])
        self.assertEqual(set(payload["items"][0]), NEWS_ITEM_KEYS)
        self.assertIsNotNone(payload["nextCursor"])
        status, page2 = self._get(f"/api/v1/feed/news?game=pokemon&limit=1&cursor={payload['nextCursor']}")
        self.assertEqual([i["id"] for i in page2["items"]], ["a2"])
        status, by_set = self._get("/api/v1/feed/news?setId=sv8&kind=news")
        self.assertEqual([i["id"] for i in by_set["items"]], ["a1"])

    def test_news_rejects_bad_params(self) -> None:
        for query in ("kind=podcast", "cursor=!!!notacursor", "limit=abc", "game=bogus"):
            with self.subTest(query=query):
                status, payload = self._get(f"/api/v1/feed/news?{query}")
                self.assertEqual(status, HTTPStatus.BAD_REQUEST)
                self.assertIn("error", payload)

    # --- calendar -----------------------------------------------------------

    def test_calendar_flag_params_and_contract_shape(self) -> None:
        import calendar_feed

        calendar_feed.clear_cache()
        self.addCleanup(calendar_feed.clear_cache)
        path = "/api/v1/market/calendar"
        self.assertEqual(self._get(path, flags=FLAGS), (HTTPStatus.NOT_FOUND, {"error": "disabled"}))
        on = ("CALENDAR_ENABLED",)
        for query in ("game=bogus", "limit=abc", "limit=0", "limit=101"):
            with self.subTest(query=query):
                status, payload = self._get(f"{path}?{query}", flags=on)
                self.assertEqual(status, HTTPStatus.BAD_REQUEST)
                self.assertIn("error", payload)
        upsert_expansion(self.conn, expansion_id="far", name="Far Set", release_date="2099/01/02", game="pokemon")
        upsert_expansion(self.conn, expansion_id="gone", name="Gone Set", release_date="2001/01/02", game="pokemon")
        self.conn.commit()
        with mock.patch.object(calendar_feed, "load_events", return_value=[]):
            status, payload = self._get(f"{path}?game=pokemon&limit=5", flags=on)
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(set(payload), {"items"})
        self.assertEqual([i["id"] for i in payload["items"]], ["release:far"])
        self.assertEqual(
            set(payload["items"][0]), {"id", "date", "kind", "game", "title", "subtitle", "setId", "url"}
        )
        self.assertEqual(payload["items"][0]["date"], "2099-01-02")


if __name__ == "__main__":
    unittest.main()
