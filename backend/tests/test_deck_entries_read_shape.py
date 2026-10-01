"""Collection list (deck entries) cold-compute read shape.

Switching collections on staging took ~a minute (2026-09-30): each deck-entries
compute ran a per-row day-change cell query, and both per-row history series
(30-day sparkline, since-added) read every lane's cells for every day. The
dashboard's ledger and the collection picker's per-collection summaries each
paid that full compute too, just to read a total. These tests pin the batched
shape, the summary-only path, and that the batched path returns the same payload
as the per-row reference.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
TESTS_ROOT = Path(__file__).resolve().parent
if str(TESTS_ROOT) not in sys.path:
    sys.path.insert(0, str(TESTS_ROOT))

from catalog_tools import upsert_deck_entry  # noqa: E402
import server  # noqa: E402
from test_card_favorites_read_shape import HISTORY_TABLES, _Base, _day  # noqa: E402


class DeckEntriesReadShapeTests(_Base):
    def _seed_collection(self, count: int, *, start: int = 0) -> None:
        for index in range(start, start + count):
            card_id = f"card-{index}"
            self._seed_card(card_id, base=10.0 + index)
            kwargs: dict = {}
            if index % 4 == 1:
                kwargs = {"grader": "PSA", "grade": "10"}
            elif index % 4 == 2:
                kwargs = {"condition": "lightly_played"}
            elif index % 4 == 3:
                kwargs = {"variant_name": "Reverse Holofoil"}
            upsert_deck_entry(
                self.connection,
                owner_user_id="user-a",
                card_id=card_id,
                added_market_price=9.0,
                added_market_date=_day(5 + (index * 7) % 35),
                **kwargs,
            )
        self.connection.commit()

    def _compute(self, **kwargs) -> tuple[dict, list[str]]:
        statements: list[str] = []
        self.connection.set_trace_callback(statements.append)
        try:
            payload = self.service._compute_deck_entries_for_owner("user-a", limit=1000, **kwargs)
        finally:
            self.connection.set_trace_callback(None)
        history = [
            " ".join(sql.split())
            for sql in statements
            if any(re.search(rf"\b(?:FROM|JOIN) {table}\b", sql) for table in HISTORY_TABLES)
        ]
        return payload, history

    def test_history_query_count_does_not_grow_with_entry_count(self) -> None:
        self._seed_collection(4)
        _, small = self._compute()
        self._seed_collection(12, start=4)
        payload, large = self._compute()

        self.assertEqual(len(payload["entries"]), 16)
        self.assertEqual(len(small), len(large), "\n".join(large))
        for sql in large:
            # No single-card history lookups (the old per-row day-change reads).
            self.assertNotRegex(sql, r"\bcard_id = '", sql)
            # Multi-day cell reads (the history series) are on the lane each row
            # resolves on, never all lanes. The one-day current-price prefetch
            # is not a series read.
            dates = re.search(r"price_date IN \(([^)]*)\)", sql)
            if "FROM card_price_history_cell" in sql and dates and "," in dates.group(1):
                self.assertRegex(sql, r"AND lane = '(raw|graded)'", sql)
            if "JOIN card_price_history_cell" in sql:
                self.assertRegex(sql, r"AND c\.lane = '(raw|graded)'", sql)

    def test_summary_only_skips_history_series(self) -> None:
        self._seed_collection(8)
        full, _ = self._compute(compute_day_change=False)
        # A Mock, not a raising side effect: the series helpers swallow errors.
        with mock.patch.object(server, "price_history_rows_for_cards_batched") as batched:
            summary_only, _ = self._compute(compute_day_change=False, include_series=False)
        batched.assert_not_called()

        self.assertEqual(summary_only["summary"], full["summary"])
        self.assertTrue(any(entry["sparkPoints"] for entry in full["entries"]))
        for entry in summary_only["entries"]:
            self.assertIsNone(entry["sparkPoints"])
            self.assertIsNone(entry["sinceAddedPoints"])

    def test_summary_callers_use_the_summary_only_key(self) -> None:
        self._seed_collection(3)
        with self.service.request_identity_context(self._identity()):
            with mock.patch.object(
                self.service,
                "_compute_deck_entries_for_owner",
                wraps=self.service._compute_deck_entries_for_owner,
            ) as compute:
                self.service.portfolio_ledger(days=30, range_label="1W")
                self.service.list_collections()
        self.assertTrue(compute.call_args_list)
        for call in compute.call_args_list:
            self.assertIs(call.kwargs.get("include_series"), False, call)

    def test_batched_payload_matches_per_row_reference(self) -> None:
        self._seed_collection(12)
        payload, _ = self._compute()

        original_batched = server.price_history_rows_for_cards_batched

        def unscoped(connection, requests, **kwargs):
            kwargs["floor_slack_days"] = None
            kwargs["lane_scoped_cells"] = False
            kwargs["market_only_cells"] = False
            # Unbounded reads; the caller's own since filter does the rest.
            requests = [{k: v for k, v in req.items() if k != "min_date"} for req in requests]
            return original_batched(connection, requests, **kwargs)

        def per_row_day_changes(jobs):
            yesterday_rows = self.service._yesterday_price_history_rows_by_card_id(
                [kwargs["card_id"] for _, kwargs in jobs]
            )
            for entry, kwargs in jobs:
                amount, percent = self.service._day_change_for_entry(
                    **kwargs, yesterday_rows_by_card_id=yesterday_rows
                )
                entry["dayChangeAmount"] = amount
                entry["dayChangePercent"] = percent

        with mock.patch.object(server, "price_history_rows_for_cards_batched", side_effect=unscoped), \
                mock.patch.object(self.service, "_apply_bulk_day_changes", side_effect=per_row_day_changes):
            reference, _ = self._compute()

        self.assertEqual(payload, reference)
        self.assertTrue(any(entry["dayChangeAmount"] is not None for entry in payload["entries"]))
        self.assertTrue(any(entry["sinceAddedPoints"] for entry in payload["entries"]))


class BatchedHistoryMinDateTests(_Base):
    """``min_date`` bounds a request's reads to its own since-baseline instead
    of the oldest one in the batch; the kept rows must be exactly the unbounded
    result filtered to ``date >= min_date``."""

    def _requests(self) -> list[dict]:
        requests = []
        for index in range(8):
            card_id = f"card-{index}"
            self._seed_card(card_id, base=10.0 + index)
            graded = index % 3 == 1
            requests.append(
                {
                    "key": f"row-{index}",
                    "card_id": card_id,
                    "pricing_mode": server.PSA_GRADE_PRICING_MODE if graded else server.RAW_PRICING_MODE,
                    "variant": "Reverse Holofoil" if index % 3 == 2 else None,
                    "condition": None if graded else "NM",
                    "grader": "PSA" if graded else None,
                    "grade": "10" if graded else None,
                    "min_date": _day(3 + index * 5),
                }
            )
        # Two requests on one card with different bounds, and an unbounded one.
        requests.append({**requests[0], "key": "row-0b", "min_date": _day(1)})
        requests.append({**requests[2], "key": "row-2-unbounded", "min_date": None})
        return requests

    def test_min_date_matches_filtered_unbounded_read(self) -> None:
        requests = self._requests()
        for options in (
            {},
            {"floor_slack_days": 0, "lane_scoped_cells": True},
            {"floor_slack_days": 0, "lane_scoped_cells": True, "market_only_cells": True},
        ):
            with self.subTest(**options):
                bounded = server.price_history_rows_for_cards_batched(
                    self.connection, requests, provider="scrydex", days=60, **options
                )
                unbounded = server.price_history_rows_for_cards_batched(
                    self.connection,
                    [{**req, "min_date": None} for req in requests],
                    provider="scrydex",
                    days=60,
                    **options,
                )
                for req in requests:
                    floor = req["min_date"] or ""
                    expected = [
                        row for row in unbounded[req["key"]] if str(row["date"])[:10] >= floor
                    ]
                    self.assertEqual(bounded[req["key"]], expected, req["key"])
                    self.assertTrue(expected, req["key"])


if __name__ == "__main__":
    unittest.main()
