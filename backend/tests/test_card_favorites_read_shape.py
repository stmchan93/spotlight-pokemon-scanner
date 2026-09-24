"""Watchlist (GET /api/v1/card-favorites) cold-load read shape + legacy baseline
backfill.

A 77-watch list took ~40s on the first load after a restart: the compute read
yesterday's history row and cells ONCE PER ROW, walked every card's whole daily
history for the sparklines, and pulled every lane's cells (graded ones dominate)
for the since-watched series. These tests pin the batched shape: the number of
price-history queries does not grow with the number of watches.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

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
    upsert_price_snapshot,
)
import watch_printings  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService  # noqa: E402

HISTORY_TABLES = ("card_price_history_daily", "card_price_history_cell")


def _day(offset: int) -> str:
    return (datetime.now(timezone.utc).date() - timedelta(days=offset)).isoformat()


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        env = mock.patch.dict(
            os.environ,
            {"PRICE_HISTORY_SOURCE": "cells", "RAW_MAIN_PRICE_SOURCE": "tcgcsv"},
        )
        env.start()
        self.addCleanup(env.stop)
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        database_path = Path(self.tempdir.name) / "favorites-shape.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self.connection = self.service.connection

    def _identity(self) -> RequestIdentity:
        return RequestIdentity(user_id="user-a", auth_source="test")

    def _seed_card(self, card_id: str, *, base: float, days: int = 40, main_days: int = 20) -> None:
        cx = self.connection
        upsert_card(
            cx, card_id=card_id, name=f"Card {card_id}", set_name="Test", number="1/1",
            rarity="Rare", variant="Raw", language="English", source_provider="scrydex",
            source_record_id=card_id, set_id="tst", set_ptcgo_code="TST",
            set_release_date="2026-01-01", source_payload={"id": card_id},
        )
        upsert_price_snapshot(
            cx, card_id=card_id, provider="scrydex", pricing_mode=RAW_PRICING_MODE,
            currency_code="USD", variant="Holofoil", condition="NM",
            low_price=base - 1, market_price=base, mid_price=base, high_price=base + 1,
        )
        for offset in range(days):
            market = base + offset * 0.1
            upsert_price_history_daily(
                cx, card_id=card_id, pricing_mode=RAW_PRICING_MODE, provider="scrydex",
                price_date=_day(offset), currency_code="USD", variant="Holofoil",
                condition="NM", low_price=market - 1, market_price=market,
                mid_price=market, high_price=market + 1,
            )
            cx.execute(
                """
                INSERT OR REPLACE INTO card_price_history_cell
                    (card_id, provider, price_date, lane, cell_key, variant_key, condition,
                     grader, grade, currency_code, low, market, mid, high, updated_at)
                VALUES (?, 'scrydex', ?, 'graded', 'graded|PSA|10|holofoil', 'holofoil', NULL,
                        'PSA', '10', 'USD', ?, ?, ?, ?, '2026-01-01T00:00:00Z')
                """,
                (card_id, _day(offset), market * 5, market * 6, market * 6, market * 7),
            )
            if offset < main_days:
                cx.execute(
                    "UPDATE card_price_history_daily SET main_raw_market_price = ?, "
                    "main_raw_variant = 'Holofoil' WHERE card_id = ? AND price_date = ?",
                    (market + 0.5, card_id, _day(offset)),
                )
                for variant, value in (("Holofoil", market + 0.5), ("Reverse Holofoil", market / 2)):
                    cx.execute(
                        """
                        INSERT OR REPLACE INTO card_price_history_cell
                            (card_id, provider, price_date, lane, cell_key, variant_key,
                             condition, currency_code, low, market, updated_at)
                        VALUES (?, 'tcgcsv', ?, 'raw_main', ?, ?, 'NM', 'USD', ?, ?,
                                '2026-01-01T00:00:00Z')
                        """,
                        (card_id, _day(offset), f"raw_main|{variant}|NM", variant, value - 1, value),
                    )
        cx.commit()

    def _favorite(self, card_id: str, *, variant_key: str = "", age_days: int = 30,
                  baseline: float | None = 9.0) -> None:
        created = f"{_day(age_days)}T12:00:00Z"
        self.connection.execute(
            """
            INSERT INTO card_favorites
                (owner_user_id, card_id, variant_key, created_at, added_market_price, added_market_date)
            VALUES ('user-a', ?, ?, ?, ?, ?)
            """,
            (card_id, variant_key, created, baseline, created[:10] if baseline is not None else None),
        )
        self.connection.commit()


class CardFavoritesReadShapeTests(_Base):
    def _seed_watchlist(self, count: int, *, start: int = 0) -> None:
        for index in range(start, start + count):
            card_id = f"card-{index}"
            self._seed_card(card_id, base=10.0 + index)
            # Some watches predate the TCGCSV main lane (cells path), some are recent.
            self._favorite(card_id, age_days=5 + (index * 7) % 35)
            if index % 3 == 0:
                self._favorite(card_id, variant_key="Reverse Holofoil", baseline=4.0)
            if index % 4 == 1:
                upsert_deck_entry(
                    self.connection, owner_user_id="user-a", card_id=card_id,
                    grader="PSA", grade="10", added_market_price=50.0,
                    added_market_date=_day(30),
                )
        self.connection.commit()

    def _history_statements(self) -> tuple[dict, list[str]]:
        statements: list[str] = []
        self.connection.set_trace_callback(statements.append)
        try:
            with self.service.request_identity_context(self._identity()):
                payload = self.service._compute_card_favorites(limit=200)
        finally:
            self.connection.set_trace_callback(None)
        history = [
            " ".join(sql.split())
            for sql in statements
            if any(re.search(rf"\bFROM {table}\b", sql) for table in HISTORY_TABLES)
        ]
        return payload, history

    def test_history_query_count_does_not_grow_with_watch_count(self) -> None:
        self._seed_watchlist(4)
        _, small = self._history_statements()
        self._seed_watchlist(12, start=4)
        payload, large = self._history_statements()

        self.assertGreater(len(payload["entries"]), 16)
        self.assertEqual(len(small), len(large), "\n".join(large))
        # No single-card history lookups (the old per-row day-change reads).
        for sql in large:
            # Trace output has bound values inlined.
            self.assertNotRegex(sql, r"\bcard_id = '", sql)

    def test_rows_still_carry_day_change_sparkline_and_since_watched(self) -> None:
        self._seed_watchlist(6)
        payload, _ = self._history_statements()
        main_rows = [e for e in payload["entries"] if e["watchVariant"] is None]
        self.assertTrue(main_rows)
        for entry in main_rows:
            self.assertIsNotNone(entry["dayChangeAmount"], entry["card"]["id"])
            self.assertIsNotNone(entry["sparkPoints"], entry["card"]["id"])
            self.assertTrue(entry["sinceWatchedPoints"], entry["card"]["id"])
        printing_rows = [e for e in payload["entries"] if e["watchVariant"] is not None]
        self.assertTrue(printing_rows)
        for entry in printing_rows:
            card_id = entry["card"]["id"]
            expected = watch_printings.latest_printing_price(self.connection, card_id, "Reverse Holofoil")
            self.assertEqual(entry["marketPrice"], round(expected["market"], 2))

    def test_since_watched_cells_are_read_on_one_lane_index_only(self) -> None:
        # Watched 35 days ago: the since-watched series reaches back past the
        # 20-day main lane, so it needs Scrydex raw cells.
        self._seed_card("card-old", base=10.0)
        self._favorite("card-old", age_days=35)
        _, history = self._history_statements()
        cell_reads = [sql for sql in history if "FROM card_price_history_cell" in sql]
        lane_reads = [sql for sql in cell_reads if "AND lane = 'raw'" in sql]
        # One each for the 30-day sparkline and the since-watched series, both
        # limited to the days the main lane did not price.
        self.assertEqual(len(lane_reads), 2, "\n".join(cell_reads))
        for sql in lane_reads:
            # Market-only projection: served from idx_cell_trend_market alone.
            self.assertNotIn(" low,", sql.split(" FROM ")[0])
            self.assertNotIn(_day(0), sql)
        # Graded cells are never read for a raw-only watchlist's history.
        self.assertFalse([sql for sql in cell_reads if "AND lane = 'graded'" in sql])

    def test_request_logs_timing_with_cache_source(self) -> None:
        self._seed_watchlist(2)
        events: list[dict] = []
        with mock.patch.object(self.service, "_emit_structured_log", side_effect=events.append):
            with self.service.request_identity_context(self._identity()):
                self.service.card_favorites()
                self.service.card_favorites()
        timings = [e for e in events if e.get("event") == "card_favorites_request"]
        self.assertEqual([e["source"] for e in timings], ["computed", "memory"])
        self.assertTrue(all(isinstance(e["elapsedMs"], float) for e in timings))
        self.assertEqual(timings[0]["entryCount"], 3)
        self.assertIn("slow", timings[0])


class LatestPrintingPricesTests(_Base):
    def test_batched_matches_single_lookup(self) -> None:
        self._seed_card("card-a", base=10.0)
        self._seed_card("card-b", base=20.0, main_days=3)
        pairs = [("card-a", "Reverse Holofoil"), ("card-b", "Holofoil"), ("card-b", "1st Edition")]
        batched = watch_printings.latest_printing_prices(self.connection, pairs)
        for card_id, variant in pairs:
            single = watch_printings.latest_printing_price(self.connection, card_id, variant)
            self.assertEqual(batched.get((card_id, variant)), single)
        self.assertNotIn(("card-b", "1st Edition"), batched)


class FavoriteBaselineBackfillTests(_Base):
    def _baseline(self, card_id: str, variant_key: str = "") -> tuple:
        row = self.connection.execute(
            "SELECT added_market_price, added_market_date FROM card_favorites "
            "WHERE owner_user_id = 'user-a' AND card_id = ? AND variant_key = ?",
            (card_id, variant_key),
        ).fetchone()
        return (row["added_market_price"], row["added_market_date"])

    def test_fills_null_baselines_with_current_price_once(self) -> None:
        self._seed_card("card-a", base=10.0)
        self._seed_card("card-b", base=30.0)
        upsert_card(
            self.connection, card_id="card-unpriced", name="Unpriced", set_name="Test",
            number="2/2", rarity="Rare", variant="Raw", language="English",
            source_provider="scrydex", source_record_id="card-unpriced", set_id="tst",
            set_ptcgo_code="TST", set_release_date="2026-01-01", source_payload={},
        )
        self._favorite("card-a", baseline=None, age_days=80)
        self._favorite("card-a", variant_key="Reverse Holofoil", baseline=None)
        self._favorite("card-b", baseline=12.34)
        self._favorite("card-unpriced", baseline=None)
        today = _day(0)
        with self.service.request_identity_context(self._identity()):
            before = self.service._deck_entries_version_token("user-a")

        first = self.service.backfill_missing_favorite_baselines()

        self.assertEqual(first["candidates"], 3)
        self.assertEqual(first["filled"], 2)
        self.assertEqual(first["unpriced"], 1)
        expected_main, _ = self.service._added_baseline_now("card-a")
        self.assertEqual(self._baseline("card-a"), (expected_main, today))
        printing = watch_printings.latest_printing_price(self.connection, "card-a", "Reverse Holofoil")
        self.assertEqual(
            self._baseline("card-a", "Reverse Holofoil"), (round(printing["market"], 2), today)
        )
        # Rows that already had a baseline, and unpriced rows, are left alone.
        self.assertEqual(self._baseline("card-b")[0], 12.34)
        self.assertEqual(self._baseline("card-unpriced"), (None, None))
        # The cached wishlist payload is invalidated (memory and disk share the token).
        with self.service.request_identity_context(self._identity()):
            self.assertNotEqual(before, self.service._deck_entries_version_token("user-a"))

        second = self.service.backfill_missing_favorite_baselines()
        self.assertEqual(second["filled"], 0)
        self.assertEqual(second["candidates"], 1)
        self.assertEqual(self._baseline("card-a"), (expected_main, today))

    def test_row_with_only_a_date_is_not_touched(self) -> None:
        self._seed_card("card-a", base=10.0)
        self.connection.execute(
            "INSERT INTO card_favorites (owner_user_id, card_id, variant_key, created_at, "
            "added_market_price, added_market_date) VALUES ('user-a', 'card-a', '', ?, NULL, ?)",
            (f"{_day(3)}T00:00:00Z", _day(3)),
        )
        self.connection.commit()
        result = self.service.backfill_missing_favorite_baselines()
        self.assertEqual(result["candidates"], 0)
        self.assertEqual(self._baseline("card-a"), (None, _day(3)))


if __name__ == "__main__":
    unittest.main()
