from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import backfill_scrydex_history_gaps as backfill  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_price_history_daily  # noqa: E402

TODAY = date(2026, 11, 16)


def _raw(condition: str, market: float) -> dict:
    # Shape copied from a live /price_history response (sm7-1, 2026-11-15).
    return {
        "variant": "normal", "condition": condition, "grade": None, "company": None, "type": "raw",
        "low": market * 0.5, "mid": None, "high": market * 2, "market": market, "currency": "USD",
        "source_currency": "USD", "is_perfect": False, "is_signed": False, "is_error": False,
    }


def _graded(company: str, grade: str, market: float) -> dict:
    return {
        "variant": "normal", "condition": None, "grade": grade, "company": company, "type": "graded",
        "low": market, "mid": None, "high": market, "market": market, "currency": "USD",
        "source_currency": "USD", "is_perfect": False, "is_signed": False, "is_error": False,
    }


def _history_payload(days: list[str], market: float) -> dict:
    return {
        "data": [
            {"date": day.replace("-", "/"), "prices": [_raw("NM", market), _raw("LP", market * 0.8), _graded("PSA", "10", market * 5)]}
            for day in days
        ]
    }


class BackfillScrydexHistoryGapsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.connection = connect(Path(self.tmp.name) / "t.sqlite")
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        from server import _apply_price_history_cells_schema_patch

        _apply_price_history_cells_schema_patch(self.connection)
        self.dates = [(TODAY - timedelta(days=offset)).isoformat() for offset in range(10, 0, -1)]
        self.gap_dates = {"2026-11-12", "2026-11-13"}
        # 20 normal cards priced every day except the gap days, plus one card
        # that is only on TCGplayer and must never hit Scrydex.
        self.card_ids = [f"sv1-{index}" for index in range(20)]
        for card_id in self.card_ids:
            self._insert_card(card_id)
            for day in self.dates:
                if day not in self.gap_dates:
                    self._write_day(card_id, day, 10.0)
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS card_favorites (card_id TEXT)"
        ) if not self._has_table("card_favorites") else None
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS deck_entries (card_id TEXT)"
        ) if not self._has_table("deck_entries") else None
        self.connection.commit()
        self.fetch_calls: list[tuple[str, int]] = []

    def tearDown(self) -> None:
        self.connection.close()
        self.tmp.cleanup()

    def _has_table(self, name: str) -> bool:
        return self.connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone() is not None

    def _insert_card(self, card_id: str) -> None:
        columns = [row[1] for row in self.connection.execute("PRAGMA table_info(cards)")]
        values = {column: "" for column in columns}
        values.update({"id": card_id, "name": card_id, "game": "pokemon"})
        required = {
            row[1]: row for row in self.connection.execute("PRAGMA table_info(cards)") if row[3] and row[4] is None
        }
        payload = {column: values[column] for column in columns if column in required or column in ("id", "name", "game")}
        placeholders = ",".join("?" * len(payload))
        self.connection.execute(
            f"INSERT INTO cards ({','.join(payload)}) VALUES ({placeholders})", list(payload.values())
        )

    def _write_day(self, card_id: str, day: str, market: float) -> None:
        from scrydex_adapter import persist_scrydex_price_history_payload

        persist_scrydex_price_history_payload(
            self.connection, card_id=card_id, payload=_history_payload([day], market), commit=False
        )

    def _fake_fetch(self, card_id: str, *, game: str, days: int) -> dict:
        self.fetch_calls.append((card_id, days))
        # Scrydex returns the WHOLE window, including days we already have, at a
        # different price, so a rewrite would be visible.
        window = [(TODAY - timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1)]
        return _history_payload(window, 99.0)

    def _run(self, **overrides):
        options = dict(
            today=TODAY, lookback_days=10, max_requests=100, cycle_budget=1000, cycle_day=7,
            fetch=self._fake_fetch, sleep_seconds=0,
        )
        options.update(overrides)
        return backfill.run_backfill(self.connection, **options)

    def test_detects_only_the_failed_days_as_gaps(self) -> None:
        gaps, _ = backfill.find_gap_dates(self.connection, start_date=self.dates[0], end_date=self.dates[-1])
        self.assertEqual(gaps, ["2026-11-12", "2026-11-13"])

    def test_writes_only_missing_days_with_every_condition_and_grade(self) -> None:
        summary = self._run()
        self.assertEqual(summary["requests"], 20)
        self.assertEqual(summary["datesWritten"], 40)

        lanes = self.connection.execute(
            """
            SELECT price_date, lane, condition, grader, grade, market
            FROM card_price_history_cell WHERE card_id = 'sv1-0' AND price_date IN ('2026-11-12', '2026-11-13')
            ORDER BY price_date, lane, condition
            """
        ).fetchall()
        kinds = {(row[0], row[1], row[2] or f"{row[3]} {row[4]}") for row in lanes}
        for day in ("2026-11-12", "2026-11-13"):
            self.assertIn((day, "raw", "NM"), kinds)
            self.assertIn((day, "raw", "LP"), kinds)
            self.assertIn((day, "graded", "PSA 10"), kinds)

        # A day the sync recorded keeps its own price (10.0), not the fetched 99.0.
        kept = self.connection.execute(
            "SELECT default_raw_market_price FROM card_price_history_daily WHERE card_id='sv1-0' AND price_date='2026-11-11'"
        ).fetchone()[0]
        self.assertEqual(kept, 10.0)
        # No slash-dated rows.
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM card_price_history_daily WHERE price_date LIKE '%/%'").fetchone()[0], 0
        )

    def test_one_request_per_card_covers_every_gap_day(self) -> None:
        self._run()
        self.assertEqual(len(self.fetch_calls), 20)
        self.assertEqual({days for _, days in self.fetch_calls}, {(TODAY - date(2026, 11, 12)).days + 1})

    def test_nightly_cap_and_rerun_resumes_without_refetching(self) -> None:
        first = self._run(max_requests=5)
        self.assertEqual(first["requests"], 5)
        second = self._run(max_requests=100)
        self.assertEqual(second["requests"], 15)
        self.assertEqual(len({card for card, _ in self.fetch_calls}), 20)
        third = self._run(max_requests=100)
        self.assertEqual(third.get("requests"), 0)

    def test_billing_cycle_budget_is_a_hard_ceiling(self) -> None:
        summary = self._run(max_requests=100, cycle_budget=7)
        self.assertEqual(summary["requests"], 7)
        again = self._run(max_requests=100, cycle_budget=7)
        self.assertEqual(again["requests"], 0)

    def test_dry_run_makes_no_requests(self) -> None:
        summary = self._run(dry_run=True)
        self.assertEqual(self.fetch_calls, [])
        self.assertEqual(summary["pending"], 20)

    def test_owned_and_watched_cards_go_first_and_tier_cap_applies(self) -> None:
        columns = {row[1] for row in self.connection.execute("PRAGMA table_info(card_favorites)")}
        if "owner_user_id" in columns:
            self.connection.execute(
                "INSERT INTO card_favorites (owner_user_id, card_id, created_at) VALUES ('owner-1', 'sv1-19', '2026-11-01')"
            )
        else:
            self.connection.execute("INSERT INTO card_favorites (card_id) VALUES ('sv1-19')")
        self.connection.commit()
        summary = self._run(max_requests=1)
        self.assertEqual(self.fetch_calls[0][0], "sv1-19")
        self.assertEqual(summary["pendingByTier"]["0"], 1)
        only_owned = self._run(max_tier=backfill.TIER_OWNED_OR_WATCHED)
        self.assertEqual(only_owned["requests"], 0)

    def test_card_with_no_history_is_recorded_and_not_rebilled(self) -> None:
        def empty_fetch(card_id: str, *, game: str, days: int) -> dict:
            self.fetch_calls.append((card_id, days))
            return {"data": []}

        self._run(fetch=empty_fetch, max_requests=3)
        statuses = {row[0] for row in self.connection.execute(f"SELECT status FROM {backfill.PROGRESS_TABLE}")}
        self.assertEqual(statuses, {"no_data"})
        self._run(fetch=empty_fetch, max_requests=100)
        self.assertEqual(len(self.fetch_calls), 20)

    def test_billing_cycle_start(self) -> None:
        self.assertEqual(backfill.billing_cycle_start(date(2026, 11, 16), 7), date(2026, 11, 7))
        self.assertEqual(backfill.billing_cycle_start(date(2026, 12, 3), 7), date(2026, 11, 7))
        self.assertEqual(backfill.billing_cycle_start(date(2026, 3, 2), 31), date(2026, 2, 28))


if __name__ == "__main__":
    unittest.main()
