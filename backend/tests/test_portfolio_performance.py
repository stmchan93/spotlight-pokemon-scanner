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
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_price_history_daily,
    upsert_price_snapshot,
    utc_now,
)
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class PortfolioPerformanceTests(unittest.TestCase):
    """GET /api/v1/portfolio/performance — per-card 2026 YTD performance table."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "performance.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.owner = "owner-user"

        self.year = date.today().year
        self.jan1 = date(self.year, 1, 1)
        # A mid-year point that is guaranteed on-or-before today (clamped), used
        # to exercise the oldest->newest sparkline series.
        self.mid = min(self.jan1 + timedelta(days=30), date.today())

        # --- Card 1: RAW with history + cost basis ---
        self._insert_card("base1-4", "Charizard", "4/102", "Base Set")
        upsert_price_snapshot(
            self.service.connection,
            card_id="base1-4",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="Holofoil",
            condition="NM",
            low_price=129.0,
            market_price=130.0,
            mid_price=130.0,
            high_price=131.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        self._seed_raw_history("base1-4", self.mid, 110.0)
        # jan1 written LAST so it wins if mid==jan1 (run-on-Jan-1 safety).
        self._seed_raw_history("base1-4", self.jan1, 100.0)

        # --- Card 2: GRADED with history, no cost basis ---
        self._insert_card("swsh1-25", "Zacian V", "195/202", "Sword & Shield")
        upsert_price_snapshot(
            self.service.connection,
            card_id="swsh1-25",
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            grader="PSA",
            grade="10",
            variant="Holofoil",
            low_price=490.0,
            market_price=500.0,
            mid_price=500.0,
            high_price=510.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )
        self._seed_graded_history("swsh1-25", self.mid, 420.0)
        self._seed_graded_history("swsh1-25", self.jan1, 400.0)

        # --- Card 3: RAW with NO history ---
        self._insert_card("base1-58", "Pikachu", "58/102", "Base Set")
        upsert_price_snapshot(
            self.service.connection,
            card_id="base1-58",
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            currency_code="USD",
            variant="Holofoil",
            condition="NM",
            low_price=9.0,
            market_price=10.0,
            mid_price=10.0,
            high_price=11.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )

        self.service.connection.commit()

        # Inventory: raw (qty 2, cost basis set), graded (qty 1, no cost basis),
        # raw-no-history (qty 3, no cost basis).
        self._add_deck_entry(
            entry_id="e-raw",
            item_kind="raw",
            card_id="base1-4",
            variant_name="Holofoil",
            condition="nm",
            quantity=2,
            cost_basis_cents=5000,  # $50/unit
        )
        self._add_deck_entry(
            entry_id="e-graded",
            item_kind="slab",
            card_id="swsh1-25",
            grader="PSA",
            grade="10",
            variant_name="Holofoil",
            quantity=1,
        )
        self._add_deck_entry(
            entry_id="e-nohist",
            item_kind="raw",
            card_id="base1-58",
            variant_name="Holofoil",
            condition="nm",
            quantity=3,
        )
        self.service.connection.commit()

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _insert_card(self, card_id: str, name: str, number: str, set_name: str) -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name=set_name,
            number=number,
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            set_id="set",
            source_payload={"id": card_id},
        )

    def _seed_raw_history(self, card_id: str, when: date, market: float) -> None:
        upsert_price_history_daily(
            self.service.connection,
            card_id=card_id,
            pricing_mode=RAW_PRICING_MODE,
            provider="scrydex",
            price_date=when.isoformat(),
            currency_code="USD",
            variant="Holofoil",
            condition="NM",
            low_price=market - 0.5,
            market_price=market,
            mid_price=market,
            high_price=market + 0.5,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )

    def _seed_graded_history(self, card_id: str, when: date, market: float) -> None:
        upsert_price_history_daily(
            self.service.connection,
            card_id=card_id,
            pricing_mode=PSA_GRADE_PRICING_MODE,
            provider="scrydex",
            price_date=when.isoformat(),
            currency_code="USD",
            grader="PSA",
            grade="10",
            variant="Holofoil",
            low_price=market - 5.0,
            market_price=market,
            mid_price=market,
            high_price=market + 5.0,
            payload={"provider": "scrydex", "variantKey": "holofoil"},
        )

    def _add_deck_entry(
        self,
        *,
        entry_id: str,
        item_kind: str,
        card_id: str,
        quantity: int,
        variant_name: str | None = None,
        condition: str | None = None,
        grader: str | None = None,
        grade: str | None = None,
        cost_basis_cents: int | None = None,
    ) -> None:
        now = utc_now()
        self.service.connection.execute(
            """
            INSERT INTO deck_entries (
                id, owner_user_id, item_kind, card_id, grader, grade,
                cert_number, variant_name, condition, quantity,
                cost_basis_total, cost_basis_cents, added_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry_id,
                self.owner,
                item_kind,
                card_id,
                grader,
                grade,
                None,
                variant_name,
                condition,
                quantity,
                0,
                cost_basis_cents,
                now,
                now,
            ),
        )

    def _performance(self) -> dict:
        identity = RequestIdentity(user_id=self.owner, auth_source="test")
        with self.service.request_identity_context(identity):
            return self.service.portfolio_performance()

    def _row(self, payload: dict, entry_id: str) -> dict:
        for row in payload["rows"]:
            if row["entryId"] == entry_id:
                return row
        raise AssertionError(f"row {entry_id} not found")

    def test_top_level_shape(self) -> None:
        payload = self._performance()
        self.assertEqual(payload["itemCount"], 3)
        self.assertEqual(payload["currencyCode"], "USD")
        self.assertEqual(len(payload["rows"]), 3)
        # refreshedAt is a parseable ISO8601 timestamp.
        datetime.fromisoformat(payload["refreshedAt"].replace("Z", "+00:00"))

    def test_raw_entry_ytd_math_and_sparkline(self) -> None:
        row = self._row(self._performance(), "e-raw")
        self.assertEqual(row["kind"], "raw")
        self.assertIsNone(row["grade"])
        self.assertEqual(row["name"], "Charizard")
        self.assertEqual(row["number"], "4/102")
        self.assertEqual(row["quantity"], 2)
        self.assertEqual(row["currentPrice"], 130.0)
        self.assertEqual(row["currentValue"], 260.0)
        self.assertEqual(row["costBasisTotal"], 100.0)  # $50/unit * 2
        self.assertEqual(row["jan1Price"], 100.0)
        self.assertEqual(row["yearStartValue"], 200.0)
        self.assertEqual(row["ytdGainDollar"], 60.0)  # 260 - 200
        self.assertEqual(row["ytdGainPercent"], 30.0)  # (130-100)/100*100
        self.assertTrue(row["sparkline"])  # non-empty when history exists
        self.assertEqual(row["sparkline"][0], 100.0)  # oldest first

    def test_graded_entry_grade_label_and_null_cost_basis(self) -> None:
        row = self._row(self._performance(), "e-graded")
        self.assertEqual(row["kind"], "graded")
        self.assertEqual(row["grade"], "PSA 10")
        self.assertEqual(row["currentPrice"], 500.0)
        self.assertEqual(row["currentValue"], 500.0)
        self.assertIsNone(row["costBasisTotal"])  # never entered
        self.assertEqual(row["jan1Price"], 400.0)
        self.assertEqual(row["yearStartValue"], 400.0)
        self.assertEqual(row["ytdGainDollar"], 100.0)
        self.assertEqual(row["ytdGainPercent"], 25.0)
        self.assertTrue(row["sparkline"])

    def test_no_history_entry_nulls(self) -> None:
        row = self._row(self._performance(), "e-nohist")
        self.assertEqual(row["currentPrice"], 10.0)  # still resolves from snapshot
        self.assertEqual(row["currentValue"], 30.0)
        self.assertEqual(row["sparkline"], [])
        self.assertIsNone(row["jan1Price"])
        self.assertIsNone(row["yearStartValue"])
        self.assertIsNone(row["ytdGainDollar"])
        self.assertIsNone(row["ytdGainPercent"])
        self.assertIsNone(row["todayGainDollar"])
        self.assertIsNone(row["todayGainPercent"])
        self.assertIsNone(row["costBasisTotal"])

    def test_variant_and_condition_fields(self) -> None:
        # A raw entry with a recognized condition surfaces its normalized label.
        self._add_deck_entry(
            entry_id="e-raw-nm",
            item_kind="raw",
            card_id="base1-4",
            variant_name="Holofoil",
            condition="near_mint",
            quantity=1,
        )
        self.service.connection.commit()

        payload = self._performance()
        raw = self._row(payload, "e-raw-nm")
        self.assertEqual(raw["variantName"], "Holofoil")
        self.assertEqual(raw["condition"], "near_mint")
        graded = self._row(payload, "e-graded")
        self.assertEqual(graded["variantName"], "Holofoil")
        # Graded slabs carry no raw condition.
        self.assertIsNone(graded["condition"])

    def test_month_gain_computed_from_30_day_baseline(self) -> None:
        # Seed a priced point strictly before (today - 30 days) so the "month"
        # baseline resolves. Use today-45d to stay clear of the boundary.
        baseline_day = date.today() - timedelta(days=45)
        self._seed_raw_history("base1-4", baseline_day, 90.0)
        self.service.connection.commit()

        row = self._row(self._performance(), "e-raw")
        # current 130.0, qty 2, month baseline 90.0
        self.assertEqual(row["monthGainDollar"], round((130.0 - 90.0) * 2, 2))
        self.assertEqual(
            row["monthGainPercent"], round((130.0 - 90.0) / 90.0 * 100.0, 2)
        )

    def test_month_gain_null_without_baseline(self) -> None:
        # e-nohist has no price history at all, so no 30-day baseline exists.
        row = self._row(self._performance(), "e-nohist")
        self.assertIsNone(row["monthGainDollar"])
        self.assertIsNone(row["monthGainPercent"])

    def test_raw_entry_today_gain(self) -> None:
        row = self._row(self._performance(), "e-raw")
        if date.today() == self.jan1:
            # No point strictly before today exists on Jan 1.
            self.assertIsNone(row["todayGainDollar"])
            self.assertIsNone(row["todayGainPercent"])
            return
        # "Yesterday" = the latest priced point strictly before today: the mid
        # point when it has passed, else the Jan 1 baseline.
        prev = 110.0 if self.mid < date.today() else 100.0
        self.assertEqual(row["todayGainDollar"], round((130.0 - prev) * 2, 2))
        self.assertEqual(
            row["todayGainPercent"], round((130.0 - prev) / prev * 100.0, 2)
        )

    def test_is_favorite_flag(self) -> None:
        self.service.connection.execute(
            "INSERT INTO card_favorites (owner_user_id, card_id, created_at) VALUES (?, ?, ?)",
            (self.owner, "base1-4", utc_now()),
        )
        self.service.connection.commit()
        payload = self._performance()
        self.assertTrue(self._row(payload, "e-raw")["isFavorite"])
        self.assertFalse(self._row(payload, "e-graded")["isFavorite"])
        self.assertFalse(self._row(payload, "e-nohist")["isFavorite"])

    # Cache guards (added with the version-token cache after Insights measured
    # ~4s per open, EVERY open, for a 140-card owner): repeat calls serve the
    # cached payload; any deck mutation or wishlist change invalidates it.
    def test_repeat_call_is_a_cache_hit(self) -> None:
        first = self._performance()
        second = self._performance()
        self.assertIs(first, second)

    def test_deck_mutation_invalidates_cache(self) -> None:
        first = self._performance()
        self.service.connection.execute(
            "UPDATE deck_entries SET quantity = quantity + 1, updated_at = ? WHERE id = ?",
            (utc_now(), "e-raw"),
        )
        self.service.connection.commit()
        second = self._performance()
        self.assertIsNot(first, second)
        self.assertEqual(self._row(second, "e-raw")["quantity"], 3)

    def test_favorite_add_invalidates_cache(self) -> None:
        first = self._performance()
        self.assertFalse(self._row(first, "e-raw")["isFavorite"])
        self.service.connection.execute(
            "INSERT INTO card_favorites (owner_user_id, card_id, created_at) VALUES (?, ?, ?)",
            (self.owner, "base1-4", utc_now()),
        )
        self.service.connection.commit()
        second = self._performance()
        self.assertIsNot(first, second)
        self.assertTrue(self._row(second, "e-raw")["isFavorite"])


if __name__ == "__main__":
    unittest.main()
