"""Watch per printing + honest deals (docs/watch-printings-and-deal-tiers-plan-2026-09-24.md).

Covers the card_favorites rebuild onto (owner, card, variant_key), the API
(multi-printing add/remove/list, backward compatibility, 400 on an unknown
printing), the listing <-> printing title match (the Dragonite case), the
liquidity tiers and their thresholds, the `new_low` alert, per-printing price
moves, and the PPT eBay-ungraded signal table. No network: every eBay call goes
through the injected mock transport.
"""

from __future__ import annotations

import contextlib
import sqlite3
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
TESTS_ROOT = Path(__file__).resolve().parent
for path in (BACKEND_ROOT, TESTS_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import expo_push  # noqa: E402
import market_alerts as ma  # noqa: E402
import watch_printings  # noqa: E402
import watch_signals as ws  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from ebay_listings import (  # noqa: E402
    listing_matches_printing,
    printing_query_token,
    raw_listings_cache_key,
)
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402
from sync_ppt_catalog import parse_export_ebay, upsert_ppt_card_pricing  # noqa: E402
from test_watch_wiring import (  # noqa: E402
    BROWSE_ENV,
    NOW,
    WatchWiringTestCase,
    _summary,
    _Transport,
)

DRAGONITE = "pl2-2"
DRAGONITE_NAME = "Dragonite"
DRAGONITE_SET = "Legends Awakened"
DRAGONITE_NUMBER = "2/146"
HOLO = "Holofoil"
REVERSE = "Reverse Holofoil"


def _dragonite_title(printing_words: str) -> str:
    return f"{DRAGONITE_NAME} {DRAGONITE_NUMBER} {DRAGONITE_SET} {printing_words} Pokemon".replace("  ", " ")


# --- migration -------------------------------------------------------------------


class CardFavoritesMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "migrate.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            connection, card_id="c1", name="Mew", set_name="S", number="1/1", rarity="R",
            variant="Raw", language="English", source_provider="scrydex", source_record_id="c1",
        )
        # The pre-2026-09-24 shape: one row per (owner, card), plus every
        # column the later patches added and one this module has never heard of.
        connection.execute("DROP TABLE card_favorites")
        connection.execute(
            """
            CREATE TABLE card_favorites (
                owner_user_id TEXT NOT NULL,
                card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                added_market_price REAL,
                added_market_date TEXT,
                target_price_cents INTEGER,
                target_currency TEXT,
                target_set_at TEXT,
                target_triggered_at TEXT,
                fast_lane INTEGER NOT NULL DEFAULT 0,
                legacy_note TEXT,
                PRIMARY KEY (owner_user_id, card_id)
            )
            """
        )
        connection.executemany(
            """
            INSERT INTO card_favorites (owner_user_id, card_id, created_at, added_market_price,
                                        added_market_date, target_price_cents, legacy_note)
            VALUES (?, 'c1', ?, ?, '2026-09-01', ?, ?)
            """,
            [("u1", "2026-09-01T00:00:00Z", 12.5, 1000, "keep me"), ("u2", "2026-09-02T00:00:00Z", None, None, None)],
        )
        connection.commit()
        connection.close()

    def _connection(self) -> sqlite3.Connection:
        connection = connect(self.database_path)
        self.addCleanup(connection.close)
        return connection

    def test_rebuild_preserves_every_row_and_column(self) -> None:
        connection = self._connection()
        self.assertTrue(watch_printings.migrate_card_favorites_per_printing(connection))
        connection.commit()
        self.assertEqual(
            watch_printings._pk_columns(connection, "card_favorites"),
            ("owner_user_id", "card_id", "variant_key"),
        )
        rows = connection.execute(
            "SELECT owner_user_id, variant_key, added_market_price, target_price_cents, legacy_note, fast_lane "
            "FROM card_favorites ORDER BY owner_user_id"
        ).fetchall()
        self.assertEqual(
            [tuple(row) for row in rows],
            [("u1", "", 12.5, 1000, "keep me", 0), ("u2", "", None, None, None, 0)],
        )
        # The new key admits a second printing of the same card.
        connection.execute(
            "INSERT INTO card_favorites (owner_user_id, card_id, variant_key, created_at) "
            "VALUES ('u1', 'c1', 'Reverse Holofoil', ?)",
            (utc_now(),),
        )
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM card_favorites").fetchone()[0], 3)

    def test_rebuild_is_idempotent(self) -> None:
        connection = self._connection()
        watch_printings.migrate_card_favorites_per_printing(connection)
        connection.commit()
        before = connection.execute("SELECT name, sql FROM sqlite_master ORDER BY name").fetchall()
        self.assertFalse(watch_printings.migrate_card_favorites_per_printing(connection))
        after = connection.execute("SELECT name, sql FROM sqlite_master ORDER BY name").fetchall()
        self.assertEqual([tuple(r) for r in before], [tuple(r) for r in after])
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM card_favorites").fetchone()[0], 2)

    def test_service_startup_migrates_and_restarts_cleanly(self) -> None:
        for _ in range(2):  # the second start must be a no-op
            service = SpotlightScanService(self.database_path, REPO_ROOT)
            connection = service.connection
            self.assertEqual(
                watch_printings._pk_columns(connection, "card_favorites"),
                ("owner_user_id", "card_id", "variant_key"),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM card_favorites WHERE variant_key = ''"
                ).fetchone()[0],
                2,
            )
            columns = {str(r[1]) for r in connection.execute("PRAGMA table_info(deal_alerts)")}
            self.assertLessEqual({"variant_key", "tier", "tier_label", "lowest_seen_cents"}, columns)
            self.assertIsNotNone(
                connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE name = 'ppt_ungraded_signals'"
                ).fetchone()
            )
            connection.close()


# --- shared fixtures ---------------------------------------------------------------


class PrintingTestCase(WatchWiringTestCase):
    def _dragonite(self, *, main: str | None = HOLO) -> None:
        self._card(DRAGONITE, name=DRAGONITE_NAME, set_name=DRAGONITE_SET, number=DRAGONITE_NUMBER)
        if main:
            self.connection.execute(
                """
                INSERT OR REPLACE INTO card_price_snapshots
                    (card_id, provider, display_currency_code, main_raw_variant, updated_at)
                VALUES (?, 'scrydex', 'USD', ?, ?)
                """,
                (DRAGONITE, main, utc_now()),
            )
            self.connection.commit()

    def _watch_printing(self, owner: str, variant: str, *, added: float | None = None) -> None:
        self.connection.execute(
            """
            INSERT OR REPLACE INTO card_favorites
                (owner_user_id, card_id, variant_key, created_at, added_market_price, added_market_date)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (owner, DRAGONITE, variant, utc_now(), added, self._day(60)),
        )
        self.connection.commit()


# --- API --------------------------------------------------------------------------


class WatchPerPrintingApiTests(PrintingTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._dragonite()
        self._tcg_cells(DRAGONITE, variant=HOLO, markets=(210.0, 215.0, 217.25), low=200.0)
        self._tcg_cells(DRAGONITE, variant=REVERSE, markets=(180.0, 182.0, 184.10), low=95.0)

    def _as(self, owner: str):
        return self.service.request_identity_context(self._identity(owner))

    def test_two_printings_are_two_watches(self) -> None:
        with self._as("owner-a"):
            holo = self.service.set_card_favorite(DRAGONITE, is_favorite=True, variant=HOLO)
            reverse = self.service.set_card_favorite(DRAGONITE, is_favorite=True, variant="reverse holofoil")
            listing = self.service.card_favorites()
            detail = self.service.card_detail(DRAGONITE)

        self.assertEqual(holo["watchVariant"], HOLO)
        self.assertEqual(reverse["watchVariant"], REVERSE)  # canonicalized
        self.assertEqual(reverse["watchKey"], f"{DRAGONITE}|{REVERSE}")
        self.assertEqual(sorted(reverse["watchedVariants"]), [HOLO, REVERSE])
        by_variant = {entry["watchVariant"]: entry for entry in listing["entries"]}
        self.assertEqual(set(by_variant), {HOLO, REVERSE})
        self.assertEqual(by_variant[HOLO]["marketPrice"], 217.25)
        self.assertEqual(by_variant[REVERSE]["marketPrice"], 184.1)
        self.assertEqual(by_variant[REVERSE]["watchKey"], f"{DRAGONITE}|{REVERSE}")
        # added_market_price is THAT printing's market.
        added = dict(
            self.connection.execute(
                "SELECT variant_key, added_market_price FROM card_favorites WHERE owner_user_id = 'owner-a'"
            ).fetchall()
        )
        self.assertEqual(added, {HOLO: 217.25, REVERSE: 184.1})
        assert detail is not None
        self.assertTrue(detail["isFavorite"])
        self.assertEqual(sorted(detail["watchedVariants"]), [HOLO, REVERSE])
        self.assertEqual(detail["mainPrinting"], HOLO)
        self.assertEqual(detail["watchTargetsCents"], {HOLO: None, REVERSE: None})

    def test_removing_one_printing_keeps_the_other(self) -> None:
        with self._as("owner-a"):
            self.service.set_card_favorite(DRAGONITE, is_favorite=True, variant=HOLO)
            self.service.set_card_favorite(DRAGONITE, is_favorite=True, variant=REVERSE)
            removed = self.service.set_card_favorite(DRAGONITE, is_favorite=False, variant=REVERSE)
            listing = self.service.card_favorites()
        self.assertFalse(removed["isFavorite"])
        self.assertEqual(removed["watchedVariants"], [HOLO])
        self.assertEqual([e["watchVariant"] for e in listing["entries"]], [HOLO])

    def test_omitted_variant_is_the_main_printing_as_before(self) -> None:
        with self._as("owner-a"):
            added = self.service.set_card_favorite(DRAGONITE, is_favorite=True)
            listing = self.service.card_favorites()
            # The picker's default IS the main printing: no second watch.
            again = self.service.set_card_favorite(DRAGONITE, is_favorite=True, variant=HOLO)
            toggled = self.service.set_card_favorite(DRAGONITE)
        self.assertTrue(added["isFavorite"])
        self.assertIsNone(added["watchVariant"])
        self.assertEqual(added["watchKey"], f"{DRAGONITE}|")
        self.assertEqual(len(listing["entries"]), 1)
        self.assertIsNone(listing["entries"][0]["watchVariant"])
        self.assertIsNone(again["watchVariant"])
        self.assertEqual(again["watchedVariants"], [""])
        self.assertFalse(toggled["isFavorite"])
        self.assertEqual(self._count("card_favorites"), 0)

    def test_pdp_scrydex_label_maps_to_the_tcgplayer_key(self) -> None:
        self._card("base1-4", name="Charizard", set_name="Base", number="4/102")
        self._tcg_cells("base1-4", variant="1st Edition Holofoil", markets=(9000.0, 9100.0, 9200.0))
        self._tcg_cells("base1-4", variant="Unlimited Holofoil", markets=(400.0, 410.0, 420.0))
        with self._as("owner-a"):
            payload = self.service.set_card_favorite("base1-4", is_favorite=True, variant="First Edition")
        self.assertEqual(payload["watchVariant"], "1st Edition Holofoil")

    def test_unknown_printing_is_a_400(self) -> None:
        with self._as("owner-a"):
            with self.assertRaises(ValueError):
                self.service.set_card_favorite(DRAGONITE, is_favorite=True, variant="Shadowless")
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = f"/api/v1/cards/{DRAGONITE}/favorite"
        handler.service = self.service
        handler._read_json_body = lambda: {"isFavorite": True, "variant": "Shadowless"}  # type: ignore[method-assign]
        handler._require_request_identity = lambda: self._identity("owner-a")  # type: ignore[method-assign]
        writes: list[tuple[HTTPStatus, dict[str, object]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]
        handler.do_POST()
        self.assertEqual(writes[0][0], HTTPStatus.BAD_REQUEST)
        self.assertEqual(self._count("card_favorites"), 0)

    def test_post_route_passes_the_variant(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = f"/api/v1/cards/{DRAGONITE}/favorite"
        handler.service = self.service
        handler._read_json_body = lambda: {"isFavorite": True, "variant": REVERSE}  # type: ignore[method-assign]
        handler._require_request_identity = lambda: self._identity("owner-a")  # type: ignore[method-assign]
        writes: list[tuple[HTTPStatus, dict[str, object]]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]
        handler.do_POST()
        self.assertEqual(writes[0][0], HTTPStatus.OK)
        self.assertEqual(writes[0][1]["watchVariant"], REVERSE)

    def test_target_is_per_printing(self) -> None:
        with self._as("owner-a"):
            self.service.set_card_favorite(DRAGONITE, is_favorite=True, variant=HOLO)
            self.service.set_card_favorite(DRAGONITE, is_favorite=True, variant=REVERSE)
            result = self.service.set_card_favorite_target(
                DRAGONITE, target_price_cents=15_000, variant=REVERSE
            )
            with self.assertRaises(ValueError):
                self.service.set_card_favorite_target(DRAGONITE, target_price_cents=1, variant="Shadowless")
            with self.assertRaises(FileNotFoundError):
                # Watched printings only: the '' main-printing watch does not exist.
                self.service.set_card_favorite_target(DRAGONITE, target_price_cents=1)
            listing = self.service.card_favorites()
        self.assertEqual(result["watchVariant"], REVERSE)
        targets = {e["watchVariant"]: e["targetPriceCents"] for e in listing["entries"]}
        self.assertEqual(targets, {HOLO: None, REVERSE: 15_000})


# --- listing title <-> printing ---------------------------------------------------


class ListingPrintingMatchTests(unittest.TestCase):
    PRINTINGS = (HOLO, REVERSE)

    def test_reverse_titles_only_meet_a_reverse_watch(self) -> None:
        for title in (
            _dragonite_title("Reverse Holo"),
            _dragonite_title("Rev. Holo"),
            _dragonite_title("Reverse Foil"),
            _dragonite_title("REVERSE HOLOFOIL"),
        ):
            with self.subTest(title=title):
                self.assertFalse(listing_matches_printing(title, HOLO, self.PRINTINGS))
                self.assertTrue(listing_matches_printing(title, REVERSE, self.PRINTINGS))

    def test_holo_alone_is_not_reverse(self) -> None:
        title = _dragonite_title("Holo Rare")
        self.assertTrue(listing_matches_printing(title, HOLO, self.PRINTINGS))
        self.assertFalse(listing_matches_printing(title, REVERSE, self.PRINTINGS))

    def test_unknown_printing_meets_a_reverse_watch_only_on_a_single_printing_card(self) -> None:
        title = _dragonite_title("")
        self.assertFalse(listing_matches_printing(title, REVERSE, self.PRINTINGS))
        self.assertTrue(listing_matches_printing(title, REVERSE, (REVERSE,)))
        self.assertTrue(listing_matches_printing(title, HOLO, self.PRINTINGS))

    def test_edition_rule_still_applies(self) -> None:
        printings = ("1st Edition Holofoil", "Unlimited Holofoil")
        first = "Charizard 4/102 Base Set 1st Edition Holo"
        plain = "Charizard 4/102 Base Set Holo"
        self.assertTrue(listing_matches_printing(first, "1st Edition Holofoil", printings))
        self.assertFalse(listing_matches_printing(plain, "1st Edition Holofoil", printings))
        self.assertFalse(listing_matches_printing(first, "Unlimited Holofoil", printings))
        self.assertTrue(listing_matches_printing(plain, "Unlimited Holofoil", printings))

    def test_query_token_and_cache_key(self) -> None:
        self.assertEqual(printing_query_token(REVERSE), "reverse")
        self.assertIsNone(printing_query_token(HOLO))
        self.assertEqual(raw_listings_cache_key("x")[3], "")
        self.assertEqual(raw_listings_cache_key("x", REVERSE)[3], "q:reverse")
        self.assertEqual(raw_listings_cache_key("x", HOLO)[3], "")


# --- the deal scan: the Dragonite case ------------------------------------------------


class DragoniteDealScanTests(PrintingTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._dragonite()
        # Holofoil: a liquid market (12 changes), lowest TCGplayer listing $205.
        self._tcg_cells(
            DRAGONITE, variant=HOLO, markets=tuple(206.25 + i for i in range(12)), low=205.0
        )

    def _listings(self) -> list[dict[str, object]]:
        return [
            _summary(item_id="v1|110000000101|0", title=_dragonite_title("Reverse Holo"), price="95.00"),
            _summary(item_id="v1|110000000102|0", title=_dragonite_title("Reverse Holo Rare"), price="129.99"),
        ]

    def test_holofoil_watch_skips_reverse_holo_titles(self) -> None:
        self._tcg_cells(DRAGONITE, variant=REVERSE, markets=tuple(180.0 + i * 0.5 for i in range(12)), low=150.0)
        self._watch_printing("owner-a", HOLO, added=217.25)
        summary = self._run_scan(_Transport(self._listings()))
        self.assertEqual(summary["alertsCreated"], 0)
        self.assertEqual(self._count("deal_alerts"), 0)

    def test_legacy_main_printing_watch_also_skips_them(self) -> None:
        self._tcg_cells(DRAGONITE, variant=REVERSE, markets=tuple(180.0 + i * 0.5 for i in range(12)), low=150.0)
        # A card-level series the $95 listing would be a 56%-off "deal" against.
        self._history(DRAGONITE, prices=(230.0, 225.0, 217.25), tcg_cells=False)
        self._watch("owner-a", DRAGONITE, added=217.25)  # variant_key '' -> main = Holofoil
        self._run_scan(_Transport(self._listings()))
        self.assertEqual(self._count("deal_alerts"), 0)
        # ...and a Holofoil-titled listing still is one.
        self.connection.execute("DELETE FROM card_ebay_listings_cache")
        self.connection.commit()
        self._run_scan(
            _Transport([_summary(item_id="v1|110000000103|0", title=_dragonite_title("Holo Rare"), price="150.00")])
        )
        self.assertEqual(self._count("deal_alerts"), 1)

    def test_reverse_watch_compares_to_the_reverse_price(self) -> None:
        # A liquid reverse market ($185.50 now), lowest listing $150.
        self._tcg_cells(DRAGONITE, variant=REVERSE, markets=tuple(180.0 + i * 0.5 for i in range(12)), low=150.0)
        self._watch_printing("owner-b", REVERSE, added=190.0)
        transport = _Transport(self._listings())
        self._run_scan(transport)
        rows = self.connection.execute(
            "SELECT * FROM deal_alerts ORDER BY total_cents"
        ).fetchall()
        self.assertEqual([r["total_cents"] for r in rows], [9_500, 12_999])
        for row in rows:
            self.assertEqual(row["kind"], "under_added")
            self.assertEqual(row["variant_key"], REVERSE)
            self.assertEqual(row["baseline_cents"], 18_550)  # the REVERSE market, not $217.25
            self.assertEqual(row["tier"], "often")
            self.assertIsNone(row["tier_label"])
        # Every watcher of this card is on Reverse: the one query says so, and
        # the page is cached under its own key (the PDP never reads it).
        search_urls = [u for u in transport.urls if "item_summary/search" in u]
        self.assertEqual(len(search_urls), 1)
        self.assertIn("reverse", search_urls[0].lower())
        self.assertIsNotNone(
            self.connection.execute(
                "SELECT 1 FROM card_ebay_listings_cache WHERE card_id = ? AND variant = 'q:reverse'",
                (DRAGONITE,),
            ).fetchone()
        )
        feed = self._feed("owner-b")
        self.assertEqual(feed[0]["variantKey"], REVERSE)
        self.assertEqual(feed[0]["tier"], "often")
        self.assertIn("lowestSeenCents", feed[0])

    def test_mixed_watchers_keep_one_generic_query(self) -> None:
        self._tcg_cells(DRAGONITE, variant=REVERSE, markets=tuple(180.0 + i * 0.5 for i in range(12)), low=150.0)
        self._watch_printing("owner-a", HOLO)
        self._watch_printing("owner-b", REVERSE)
        transport = _Transport(self._listings())
        self._run_scan(transport)
        search_urls = [u for u in transport.urls if "item_summary/search" in u]
        self.assertEqual(len(search_urls), 1)
        self.assertNotIn("reverse", search_urls[0].lower())

    def test_frozen_thin_reverse_market_is_few_sales(self) -> None:
        # The real Dragonite: reverse "market" $184.10 frozen for 9 days while
        # copies list from $90 — tier `rarely` needs 25% AND the cheapest listing.
        self._tcg_cells(
            DRAGONITE, variant=REVERSE, markets=(200.0, 195.0, 190.0) + (184.10,) * 9, low=90.0
        )
        self._watch_printing("owner-b", REVERSE)
        self._run_scan(_Transport(self._listings()))
        # $95 is 48% under but not under the $90 lowest listing; $129.99 neither.
        self.assertEqual(
            self.connection.execute(
                "SELECT COUNT(*) FROM deal_alerts WHERE kind = 'under_added'"
            ).fetchone()[0],
            0,
        )
        baseline = next(
            b for b in ws.watched_card_baselines(self.connection) if b.variant_key == REVERSE
        )
        assert baseline.liquidity is not None
        self.assertEqual(baseline.liquidity.tier, ws.TIER_RARELY)
        self.assertTrue(baseline.liquidity.frozen_thin)
        self.assertEqual(baseline.liquidity.label, "Few sales")

    def test_new_low_alert_rides_the_scan(self) -> None:
        # No % deal possible (tier none: a flat market) but $95 is under every
        # TCGplayer low of the last 30 days ($120) -> "lowest we've seen".
        self._tcg_cells(DRAGONITE, variant=REVERSE, markets=(184.10,) * 12, low=120.0)
        self._watch_printing("owner-b", REVERSE)
        self._run_scan(_Transport(self._listings()[:1]))
        row = self.connection.execute("SELECT * FROM deal_alerts").fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["kind"], "new_low")
        self.assertIsNone(row["discount_pct"])
        self.assertEqual(row["lowest_seen_cents"], 12_000)
        self.assertEqual(row["baseline_cents"], 12_000)
        self.assertEqual(row["tier"], "none")
        self.assertEqual(row["tier_label"], "Not enough sales to judge")
        payload = self._feed("owner-b")[0]
        self.assertEqual(payload["kind"], "new_low")
        self.assertIsNone(payload["discountPct"])
        self.assertEqual(payload["lowestSeenCents"], 12_000)
        self.assertEqual(payload["tierLabel"], "Not enough sales to judge")

    def _feed(self, owner: str) -> list[dict[str, object]]:
        with self.service.request_identity_context(self._identity(owner)):
            return self.service.deal_alerts()["alerts"]


# --- liquidity tiers + thresholds -------------------------------------------------------

TODAY = date(2026, 9, 19)


def _cells(markets, *, low=None, lows=None):
    n = len(markets)
    return tuple(
        watch_printings.CellPoint(
            (TODAY - timedelta(days=n - 1 - i)).isoformat(),
            int(round(m * 100)),
            int(round((lows[i] if lows is not None else low) * 100)) if (lows or low) else None,
        )
        for i, m in enumerate(markets)
    )


def _ppt(velocity, *, median=None, count=None):
    return watch_printings.UngradedSales(
        sales_count=count, median_cents=int(median * 100) if median else None,
        sales_velocity_weekly=velocity,
    )


class LiquidityTierTests(unittest.TestCase):
    def test_staging_like_tcgplayer_only(self) -> None:
        cases = [
            (tuple(100.0 + i for i in range(12)), ws.TIER_OFTEN),
            ((100, 101, 102, 103, 104, 105, 105, 105), ws.TIER_FEWER),
            ((100, 101, 101, 101), ws.TIER_RARELY),
            ((100, 100, 100, 100), ws.TIER_NONE),
        ]
        for markets, tier in cases:
            with self.subTest(markets=markets):
                liquidity = ws.compute_liquidity(_cells(markets, low=95.0), None)
                self.assertEqual(liquidity.tier, tier)
                self.assertEqual(liquidity.source, "tcgplayer")
        empty = ws.compute_liquidity((), None)
        self.assertEqual(empty.tier, ws.TIER_NONE)
        self.assertEqual(empty.label, "Not enough sales to judge")

    def test_ppt_sales_velocity(self) -> None:
        cells = _cells((100, 100, 100), low=95.0)
        self.assertEqual(ws.compute_liquidity(cells, _ppt(3.0)).tier, ws.TIER_OFTEN)  # ~13 / 30d
        self.assertEqual(ws.compute_liquidity(cells, _ppt(1.5)).tier, ws.TIER_FEWER)  # ~6
        self.assertEqual(ws.compute_liquidity(cells, _ppt(0.5)).tier, ws.TIER_RARELY)  # ~2
        self.assertEqual(ws.compute_liquidity(cells, _ppt(0.2)).tier, ws.TIER_RARELY)  # 1 in 30d, 3 in 90d
        self.assertEqual(ws.compute_liquidity(cells, _ppt(3.0)).source, "ppt")
        self.assertEqual(ws.compute_liquidity(cells, _ppt(1.5)).label, "Fewer sales")

    def test_frozen_thin_printing_caps_even_a_liquid_card(self) -> None:
        cells = _cells((200.0, 184.10) + (184.10,) * 8, low=90.0)
        liquidity = ws.compute_liquidity(cells, _ppt(5.0))  # PPT's per-CARD count: often
        self.assertTrue(liquidity.frozen_thin)
        self.assertEqual(liquidity.tier, ws.TIER_RARELY)
        # Frozen but NOT thin (lowest listing close to market): not capped.
        close = ws.compute_liquidity(_cells((200.0,) + (184.10,) * 9, low=180.0), _ppt(5.0))
        self.assertFalse(close.frozen_thin)
        self.assertEqual(close.tier, ws.TIER_OFTEN)

    def test_yardstick_uses_the_ungraded_median_with_three_sales(self) -> None:
        cells = _cells(tuple(100.0 + i for i in range(12)), low=95.0)
        with_median = ws.compute_liquidity(cells, _ppt(3.0, median=90.0))
        self.assertEqual(ws.yardstick_cents(11_100, with_median), 9_000)
        thin = ws.compute_liquidity(cells, _ppt(0.3, median=50.0))  # ~1 sale / 30d
        self.assertIsNone(thin.ungraded_median_cents)
        self.assertEqual(ws.yardstick_cents(11_100, thin), 11_100)


def _baseline(*, tier_cells, ppt=None, lowest_listing=None, market=10_000, **extra):
    points = tuple(
        ws.PricePoint((TODAY - timedelta(days=2 - i)).isoformat(), p, "USD|holofoil|nm||")
        for i, p in enumerate((market + 400, market + 200, market))
    )
    return ws.WatchBaseline(
        owner_user_id="u1",
        card_id="c1",
        language="English",
        current_market_cents=market,
        market_source_key="USD|holofoil|nm||",
        points=points,
        liquidity=ws.compute_liquidity(tier_cells, ppt),
        lowest_listing_cents=lowest_listing,
        **extra,
    )


def _listing(total_cents: int, listing_id: str = "l1") -> ws.ListingCandidate:
    return ws.ListingCandidate(
        listing_id=listing_id, card_id="c1", price_cents=total_cents, shipping_cents=0,
        url="https://ebay/x",
    )


class TierThresholdTests(unittest.TestCase):
    OFTEN = _cells(tuple(100.0 + i for i in range(12)), low=95.0)
    FEWER = _cells((100, 101, 102, 103, 104, 105, 105), low=95.0)
    RARELY = _cells((100, 101, 101), low=95.0)
    NONE = _cells((100, 100, 100), low=95.0)

    def _eval(self, baseline, total):
        return ws.evaluate_under_added(_listing(total), baseline, now=NOW)

    def test_often_needs_ten_percent_and_the_cheapest_listing(self) -> None:
        b = _baseline(tier_cells=self.OFTEN, lowest_listing=9_200)
        self.assertTrue(self._eval(b, 8_900).passed)  # 11% and under $92
        self.assertEqual(self._eval(b, 9_100).rejected_by, "significance")  # 9%
        b_high_low = _baseline(tier_cells=self.OFTEN, lowest_listing=8_500)
        self.assertEqual(self._eval(b_high_low, 8_900).rejected_by, "below_lowest_listing")
        no_low = _baseline(tier_cells=self.OFTEN, lowest_listing=None)
        self.assertEqual(self._eval(no_low, 8_900).rejected_by, "below_lowest_listing")

    def test_fewer_needs_twenty_percent_only(self) -> None:
        b = _baseline(tier_cells=self.FEWER, lowest_listing=5_000)
        self.assertEqual(self._eval(b, 8_500).rejected_by, "significance")  # 15%
        result = self._eval(b, 7_900)  # 21%, above the lowest listing: still fine
        self.assertTrue(result.passed)
        self.assertEqual(result.signal.tier, ws.TIER_FEWER)
        self.assertEqual(result.signal.tier_label, "Fewer sales")

    def test_rarely_needs_twenty_five_percent_and_the_cheapest_listing(self) -> None:
        b = _baseline(tier_cells=self.RARELY, lowest_listing=7_600)
        self.assertEqual(self._eval(b, 7_800).rejected_by, "significance")  # 22%
        self.assertTrue(self._eval(b, 7_400).passed)  # 26%, under $76
        b2 = _baseline(tier_cells=self.RARELY, lowest_listing=7_000)
        self.assertEqual(self._eval(b2, 7_400).rejected_by, "below_lowest_listing")

    def test_none_is_never_a_percent_deal(self) -> None:
        b = _baseline(tier_cells=self.NONE, lowest_listing=9_000)
        self.assertEqual(self._eval(b, 5_000).rejected_by, "liquidity_tier")

    def test_existing_guardrails_stay(self) -> None:
        b = _baseline(tier_cells=self.FEWER, lowest_listing=9_000)
        self.assertEqual(self._eval(b, 3_900).rejected_by, "too_good_floor")  # 61%
        cheap = _baseline(tier_cells=self.FEWER, market=450)
        self.assertEqual(self._eval(cheap, 300).rejected_by, "price_floor")
        prior = ws.PriorAlert("l1", "c1", 7_000, NOW.isoformat())
        self.assertEqual(
            ws.evaluate_under_added(_listing(7_000), b, prior_alerts=[prior], now=NOW).rejected_by,
            "rearm",
        )

    def test_rearm_is_per_printing(self) -> None:
        b = _baseline(tier_cells=self.FEWER, variant_key=REVERSE)
        other_printing = ws.PriorAlert("other", "c1", 7_900, NOW.isoformat(), variant_key=HOLO)
        same_printing = ws.PriorAlert("other", "c1", 7_900, NOW.isoformat(), variant_key=REVERSE)
        self.assertTrue(ws.evaluate_under_added(_listing(7_800), b, prior_alerts=[other_printing], now=NOW).passed)
        self.assertEqual(
            ws.evaluate_under_added(_listing(7_800), b, prior_alerts=[same_printing], now=NOW).rejected_by,
            "rearm",
        )


class NewLowTests(unittest.TestCase):
    def _b(self, **extra):
        defaults = dict(
            tier_cells=_cells((100, 100, 100), low=95.0), market=18_410,
            low_30d_cents=12_900, low_30d_days=20,
        )
        defaults.update(extra)
        return _baseline(**defaults)

    def test_below_the_30_day_low_is_a_new_low(self) -> None:
        result = ws.evaluate_watch_listing(_listing(9_500), self._b(), now=NOW)
        self.assertTrue(result.passed)
        signal = result.signal
        self.assertEqual(signal.kind, ws.KIND_NEW_LOW)
        self.assertIsNone(signal.discount_pct)
        self.assertEqual(signal.lowest_seen_cents, 12_900)
        self.assertEqual(signal.baseline_cents, 12_900)
        self.assertEqual(signal.tier, ws.TIER_NONE)

    def test_must_beat_the_low_and_every_previous_alert(self) -> None:
        self.assertEqual(
            ws.evaluate_new_low(_listing(13_000), self._b(), now=NOW).rejected_by, "not_a_new_low"
        )
        beaten_before = self._b(lowest_alerted_cents=9_000)
        self.assertEqual(
            ws.evaluate_new_low(_listing(9_500), beaten_before, now=NOW).rejected_by, "not_a_new_low"
        )
        result = ws.evaluate_new_low(_listing(8_900), beaten_before, now=NOW)
        self.assertTrue(result.passed)
        self.assertEqual(result.signal.lowest_seen_cents, 9_000)

    def test_needs_a_month_of_lows_and_keeps_the_too_good_floor(self) -> None:
        self.assertEqual(
            ws.evaluate_new_low(_listing(9_500), self._b(low_30d_days=3), now=NOW).rejected_by,
            "no_low_history",
        )
        self.assertEqual(
            ws.evaluate_new_low(_listing(7_000), self._b(), now=NOW).rejected_by, "too_good_floor"
        )

    def test_a_percent_deal_wins_over_new_low(self) -> None:
        b = self._b(tier_cells=_cells((100, 101, 102, 103, 104, 105, 105), low=95.0))  # fewer
        result = ws.evaluate_watch_listing(_listing(12_000), b, now=NOW)  # 35% under $184.10
        self.assertEqual(result.signal.kind, ws.KIND_UNDER_ADDED)


# --- market alerts per printing ---------------------------------------------------

MA_NOW = datetime(2026, 9, 22, 18, 0, tzinfo=timezone.utc)  # 11:00 in Los Angeles


class _FakeSender:
    def __init__(self) -> None:
        self.messages: list[expo_push.PushMessage] = []

    def __call__(self, messages):
        tickets = []
        for index, message in enumerate(messages):
            self.messages.append(message)
            tickets.append(expo_push.PushTicket(
                token=message.to, status="ok", ticket_id=f"t-{len(self.messages)}-{index}",
                reference_id=message.reference_id,
            ))
        return expo_push.PushResult(sent=len(messages), tickets=tuple(tickets))


class PerPrintingMarketAlertTests(PrintingTestCase):
    TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]"

    def setUp(self) -> None:
        super().setUp()
        self._dragonite()
        # Card level (main printing, Holofoil) is flat; the reverse moved +20%.
        for day, holo, rev in (("2026-09-21", 200.0, 100.0), ("2026-09-22", 200.0, 120.0)):
            self.connection.execute(
                """
                INSERT OR REPLACE INTO card_price_history_daily
                    (card_id, provider, price_date, display_currency_code, main_raw_market_price,
                     main_raw_variant, updated_at)
                VALUES (?, 'tcgcsv', ?, 'USD', ?, ?, ?)
                """,
                (DRAGONITE, day, holo, HOLO, utc_now()),
            )
            for variant, market in ((HOLO, holo), (REVERSE, rev)):
                self.connection.execute(
                    """
                    INSERT OR REPLACE INTO card_price_history_cell
                        (card_id, provider, price_date, lane, cell_key, variant_key, condition,
                         currency_code, low, market, updated_at)
                    VALUES (?, 'tcgcsv', ?, 'raw_main', ?, ?, 'NM', 'USD', ?, ?, ?)
                    """,
                    (DRAGONITE, day, f"raw_main|{variant}|NM", variant, market, market, utc_now()),
                )
        self.connection.execute(
            """
            INSERT INTO user_push_tokens (owner_user_id, expo_push_token, created_at, last_seen_at, timezone)
            VALUES ('owner-a', ?, ?, ?, 'America/Los_Angeles')
            """,
            (self.TOKEN, utc_now(), utc_now()),
        )
        self.connection.commit()
        self.sender = _FakeSender()

    def _run(self):
        return ma.run_market_alerts(
            self.connection, now=MA_NOW, sender=self.sender, check_receipts=False
        )

    def test_a_reverse_watch_moves_on_the_reverse_price(self) -> None:
        self._watch_printing("owner-a", REVERSE)
        summary = self._run()
        self.assertEqual(summary["sent"], 1)
        # The printing rides along in the card's name, whichever wording rotates in.
        self.assertIn(f"{DRAGONITE_NAME} · {REVERSE}", self.sender.messages[0].title)
        self.assertEqual(self.sender.messages[0].body, "Up $20 since yesterday, now at $120.")
        state = self.connection.execute(
            "SELECT variant_key, last_price_usd FROM market_alert_card_state"
        ).fetchall()
        self.assertEqual([tuple(r) for r in state], [(REVERSE, 120.0)])

    def test_a_main_printing_watch_does_not_see_the_reverse_move(self) -> None:
        self._watch_printing("owner-a", "")
        self.assertEqual(self._run()["sent"], 0)

    def test_new_low_push_copy(self) -> None:
        self.connection.execute(
            """
            INSERT INTO deal_alerts (id, owner_user_id, card_id, listing_id, kind, total_cents,
                                     baseline_cents, created_at, variant_key, tier, lowest_seen_cents)
            VALUES ('a1', 'owner-a', ?, 'l1', 'new_low', 9500, 12900, ?, ?, 'none', 12900)
            """,
            (DRAGONITE, (MA_NOW - timedelta(hours=1)).isoformat(), REVERSE),
        )
        self.connection.commit()
        self.assertEqual(self._run()["byKind"], {"deal": 1})
        message = self.sender.messages[0]
        self.assertEqual(message.title, f"Lowest {DRAGONITE_NAME} · {REVERSE} price we've seen \U0001F440")
        self.assertEqual(message.body, "$95 on eBay. It usually goes for $129+.")
        self.assertNotIn("%", message.title)

    def test_target_hit_reads_the_watched_printing(self) -> None:
        self._watch_printing("owner-a", REVERSE)
        self.connection.execute(
            "UPDATE card_favorites SET target_price_cents = 11000 WHERE variant_key = ?", (REVERSE,)
        )
        self.connection.commit()
        baseline = next(b for b in ws.watched_card_baselines(self.connection) if b.variant_key == REVERSE)
        self.assertEqual(baseline.current_market_cents, 12_000)
        self.assertEqual(baseline.printing, REVERSE)


# --- PPT eBay ungraded signals ------------------------------------------------------


class PptUngradedSignalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "ppt.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            self.connection, card_id="pl2-2", name="Dragonite", set_name="Legends Awakened",
            number="2/146", rarity="Holo", variant="Raw", language="English",
            source_provider="scrydex", tcgplayer_id="90210",
        )
        self.connection.commit()

    def test_export_ungraded_row_is_persisted_per_card(self) -> None:
        csv_path = Path(self.tempdir.name) / "ebay.csv"
        csv_path.write_text(
            "tcgPlayerId,grade,salesCount,averagePrice,medianPrice,smartMarketPrice,"
            "smartMarketConfidence,marketPrice7Day,marketTrend,salesVelocityWeekly\n"
            "90210,ungraded,57,140.0,129.5,131.0,High,127.0,up,2.5\n"
            "90210,psa10,12,900,880,890,Medium,870,flat,0.4\n"
        )
        sales = parse_export_ebay(str(csv_path))
        self.assertEqual(sales["90210"]["ungraded"]["salesVelocityWeekly"], "2.5")
        for signals_only in (True, False):
            with self.subTest(signals_only=signals_only):
                upsert_ppt_card_pricing(
                    self.connection,
                    {"tcgPlayerId": "90210", "prices": {}, "variants": {}, "ebay": {"salesByGrade": sales["90210"]}},
                    price_date="2026-09-24",
                    signals_only=signals_only,
                )
                row = self.connection.execute(
                    "SELECT sales_count, median_price, sales_velocity_weekly, smart_market_price, "
                    "smart_market_confidence, market_price_7day, tcgplayer_id "
                    "FROM ppt_ungraded_signals WHERE card_id = 'pl2-2'"
                ).fetchone()
                self.assertEqual(tuple(row), (57, 129.5, 2.5, 131.0, "high", 127.0, "90210"))
        read = watch_printings.ungraded_sales_by_card(self.connection, ["pl2-2"])["pl2-2"]
        self.assertEqual(read.sales_30d, 11)
        self.assertEqual(read.median_cents, 12_950)


if __name__ == "__main__":
    unittest.main()
