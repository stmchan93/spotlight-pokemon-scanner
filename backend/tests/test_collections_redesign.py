"""Tests for the Collections-tab-redesign backend changes.

Covers the additive schema columns on `deck_entries` and `sale_events`, the
sell-flow snapshot logic (cost basis + listing), the new inventory mutation
routes (cost basis edit + listing toggle), and the `portfolio_insights`
aggregates surfaced under the dashboard `insights` key.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, upsert_deck_entry  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class CollectionsRedesignTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "collections-redesign.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _identity(self, user_id: str = "vendor-a") -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(self, card_id: str = "base-charizard-4") -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name="Charizard",
            set_name="Base Set",
            number="4/102",
            rarity="Holo Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            set_id="base1",
            set_ptcgo_code="BS",
            set_release_date="1999-01-09",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def _seed_deck_entry(self, *, quantity: int = 1, user_id: str = "vendor-a") -> str:
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id=user_id,
            card_id="base-charizard-4",
            condition="near_mint",
            quantity=quantity,
            unit_price=50.0,
            currency_code="USD",
        )
        self.service.connection.commit()
        return deck_entry_id

    # ----- Schema -------------------------------------------------------- #

    def test_schema_patch_adds_collections_columns_to_deck_entries(self) -> None:
        columns = {
            row["name"]
            for row in self.service.connection.execute(
                "PRAGMA table_info(deck_entries)"
            ).fetchall()
        }
        self.assertIn("cost_basis_cents", columns)
        self.assertIn("listing_url", columns)
        self.assertIn("listing_price_cents", columns)
        self.assertIn("listed_at", columns)

    def test_schema_patch_adds_collections_columns_to_sale_events(self) -> None:
        columns = {
            row["name"]
            for row in self.service.connection.execute(
                "PRAGMA table_info(sale_events)"
            ).fetchall()
        }
        self.assertIn("cost_basis_per_unit_cents", columns)
        self.assertIn("profit_cents", columns)
        self.assertIn("last_listing_snapshot", columns)

    def test_dashboard_computes_only_requested_range(self) -> None:
        # Open-range optimization: portfolio_dashboard(range_key=...) returns a
        # partial ranges map (just that range), while no range computes all six.
        self._insert_card()
        self._seed_deck_entry(quantity=1)
        with self.service.request_identity_context(self._identity()):
            single = self.service.portfolio_dashboard(range_key="1W")
            full = self.service.portfolio_dashboard()
        self.assertEqual(set(single["ranges"].keys()), {"1W"})
        self.assertEqual(
            set(full["ranges"].keys()),
            {"1W", "1M", "3M", "YTD", "1Y", "ALL"},
        )
        # Inventory + insights are still bundled in the scoped response.
        self.assertIn("inventory", single)
        self.assertIn("insights", single)
        self.assertIsNotNone(single["ranges"]["1W"]["history"])

    def test_deck_entries_surfaces_favorited_at_for_favorited_cards(self) -> None:
        self._insert_card()
        self._seed_deck_entry(quantity=1)
        with self.service.request_identity_context(self._identity()):
            self.service.set_card_favorite("base-charizard-4", is_favorite=True)
            entries = self.service.deck_entries(limit=200, offset=0)["entries"]
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertTrue(entry["isFavorite"])
        self.assertIsInstance(entry["favoritedAt"], str)
        self.assertTrue(entry["favoritedAt"])

    def test_deck_entries_favorited_at_is_none_when_not_favorited(self) -> None:
        self._insert_card()
        self._seed_deck_entry(quantity=1)
        with self.service.request_identity_context(self._identity()):
            entries = self.service.deck_entries(limit=200, offset=0)["entries"]
        self.assertEqual(len(entries), 1)
        self.assertFalse(entries[0]["isFavorite"])
        self.assertIsNone(entries[0]["favoritedAt"])

    # ----- Inventory mutation routes ------------------------------------- #

    def test_record_buy_persists_cost_basis_per_unit_in_cents(self) -> None:
        self._insert_card()
        with self.service.request_identity_context(self._identity()):
            self.service.record_buy(
                {
                    "cardID": "base-charizard-4",
                    "quantity": 1,
                    "unitPrice": 100.0,
                    "currencyCode": "USD",
                    "costBasisPerUnit": 87.5,
                }
            )
        row = self.service.connection.execute(
            "SELECT cost_basis_cents FROM deck_entries LIMIT 1"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["cost_basis_cents"], 8750)

    def test_update_deck_entry_cost_basis_writes_cents_and_total(self) -> None:
        self._insert_card()
        deck_entry_id = self._seed_deck_entry(quantity=2)
        with self.service.request_identity_context(self._identity()):
            payload = self.service.update_deck_entry_cost_basis(
                {
                    "deckEntryID": deck_entry_id,
                    "costBasisPerUnit": 42.25,
                    "currencyCode": "USD",
                }
            )
        self.assertEqual(payload["costBasisPerUnit"], 42.25)
        self.assertEqual(payload["costBasisPerUnitCents"], 4225)
        row = self.service.connection.execute(
            "SELECT cost_basis_cents, cost_basis_total FROM deck_entries WHERE id = ?",
            (deck_entry_id,),
        ).fetchone()
        self.assertEqual(row["cost_basis_cents"], 4225)
        # cost_basis_total mirrors the per-unit × quantity in dollars.
        self.assertAlmostEqual(float(row["cost_basis_total"]), 84.50, places=2)

    def test_update_deck_entry_cost_basis_supports_clear(self) -> None:
        self._insert_card()
        deck_entry_id = self._seed_deck_entry(quantity=1)
        with self.service.request_identity_context(self._identity()):
            # Set a value first.
            self.service.update_deck_entry_cost_basis(
                {"deckEntryID": deck_entry_id, "costBasisPerUnit": 30.0}
            )
            # Then clear by passing null.
            cleared = self.service.update_deck_entry_cost_basis(
                {"deckEntryID": deck_entry_id, "costBasisPerUnit": None}
            )
        self.assertIsNone(cleared["costBasisPerUnit"])
        row = self.service.connection.execute(
            "SELECT cost_basis_cents, cost_basis_total FROM deck_entries WHERE id = ?",
            (deck_entry_id,),
        ).fetchone()
        self.assertIsNone(row["cost_basis_cents"])
        self.assertEqual(float(row["cost_basis_total"]), 0.0)

    def test_update_deck_entry_listing_sets_and_clears(self) -> None:
        self._insert_card()
        deck_entry_id = self._seed_deck_entry()
        with self.service.request_identity_context(self._identity()):
            set_payload = self.service.update_deck_entry_listing(
                {
                    "deckEntryID": deck_entry_id,
                    "listingUrl": "https://ebay.com/itm/abc",
                    "listingPrice": 199.99,
                }
            )
        self.assertEqual(set_payload["listingUrl"], "https://ebay.com/itm/abc")
        self.assertEqual(set_payload["listingPriceCents"], 19999)
        self.assertIsNotNone(set_payload["listedAt"])
        row = self.service.connection.execute(
            "SELECT listing_url, listing_price_cents, listed_at FROM deck_entries WHERE id = ?",
            (deck_entry_id,),
        ).fetchone()
        self.assertEqual(row["listing_url"], "https://ebay.com/itm/abc")
        self.assertEqual(row["listing_price_cents"], 19999)
        self.assertTrue(str(row["listed_at"] or "").strip())

        # Now clear.
        with self.service.request_identity_context(self._identity()):
            cleared = self.service.update_deck_entry_listing(
                {"deckEntryID": deck_entry_id, "listingUrl": None}
            )
        self.assertIsNone(cleared["listingUrl"])
        row = self.service.connection.execute(
            "SELECT listing_url, listing_price_cents, listed_at FROM deck_entries WHERE id = ?",
            (deck_entry_id,),
        ).fetchone()
        self.assertIsNone(row["listing_url"])
        self.assertIsNone(row["listing_price_cents"])
        self.assertIsNone(row["listed_at"])

    # ----- Sell-flow snapshot ------------------------------------------- #

    def test_record_sale_snapshots_cost_basis_and_computes_profit(self) -> None:
        self._insert_card()
        deck_entry_id = self._seed_deck_entry(quantity=2)
        with self.service.request_identity_context(self._identity()):
            self.service.update_deck_entry_cost_basis(
                {"deckEntryID": deck_entry_id, "costBasisPerUnit": 40.0}
            )
            sale = self.service.record_sale(
                {
                    "deckEntryID": deck_entry_id,
                    "unitPrice": 100.0,
                    "quantity": 2,
                    "currencyCode": "USD",
                    "paymentMethod": "cash",
                }
            )
        sale_row = self.service.connection.execute(
            "SELECT cost_basis_per_unit_cents, profit_cents, last_listing_snapshot "
            "FROM sale_events WHERE id = ?",
            (sale["saleID"],),
        ).fetchone()
        self.assertEqual(sale_row["cost_basis_per_unit_cents"], 4000)
        # (10000 - 4000) * 2 = 12000 cents = $120 profit
        self.assertEqual(sale_row["profit_cents"], 12000)
        self.assertIsNone(sale_row["last_listing_snapshot"])

    def test_record_sale_snapshots_listing_and_clears_inventory_listing(self) -> None:
        self._insert_card()
        deck_entry_id = self._seed_deck_entry(quantity=1)
        with self.service.request_identity_context(self._identity()):
            self.service.update_deck_entry_listing(
                {
                    "deckEntryID": deck_entry_id,
                    "listingUrl": "https://ebay.com/itm/xyz",
                    "listingPriceCents": 12500,
                    "listedAt": "2026-05-01T12:00:00+00:00",
                }
            )
            sale = self.service.record_sale(
                {
                    "deckEntryID": deck_entry_id,
                    "unitPrice": 130.0,
                    "quantity": 1,
                    "currencyCode": "USD",
                    "paymentMethod": "cash",
                }
            )
        sale_row = self.service.connection.execute(
            "SELECT last_listing_snapshot FROM sale_events WHERE id = ?",
            (sale["saleID"],),
        ).fetchone()
        snapshot = json.loads(sale_row["last_listing_snapshot"])
        self.assertEqual(snapshot["listing_url"], "https://ebay.com/itm/xyz")
        self.assertEqual(snapshot["listing_price_cents"], 12500)
        self.assertEqual(snapshot["listed_at"], "2026-05-01T12:00:00+00:00")

        # The inventory row's listing fields should be cleared after the sale.
        deck_row = self.service.connection.execute(
            "SELECT listing_url, listing_price_cents, listed_at FROM deck_entries WHERE id = ?",
            (deck_entry_id,),
        ).fetchone()
        self.assertIsNone(deck_row["listing_url"])
        self.assertIsNone(deck_row["listing_price_cents"])
        self.assertIsNone(deck_row["listed_at"])

    def test_record_sale_profit_is_null_when_no_cost_basis(self) -> None:
        self._insert_card()
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id="vendor-a",
            card_id="base-charizard-4",
            condition="near_mint",
            quantity=1,
            unit_price=None,  # no cost basis at all
            currency_code="USD",
        )
        self.service.connection.commit()
        with self.service.request_identity_context(self._identity()):
            sale = self.service.record_sale(
                {
                    "deckEntryID": deck_entry_id,
                    "unitPrice": 50.0,
                    "currencyCode": "USD",
                    "paymentMethod": "cash",
                }
            )
        sale_row = self.service.connection.execute(
            "SELECT cost_basis_per_unit_cents, profit_cents FROM sale_events WHERE id = ?",
            (sale["saleID"],),
        ).fetchone()
        self.assertIsNone(sale_row["cost_basis_per_unit_cents"])
        self.assertIsNone(sale_row["profit_cents"])

    # ----- Insights endpoint -------------------------------------------- #

    def test_portfolio_insights_exposes_expected_keys_and_types(self) -> None:
        self._insert_card()
        deck_entry_id = self._seed_deck_entry(quantity=3)
        with self.service.request_identity_context(self._identity()):
            self.service.update_deck_entry_cost_basis(
                {"deckEntryID": deck_entry_id, "costBasisPerUnit": 25.0}
            )
            self.service.update_deck_entry_listing(
                {
                    "deckEntryID": deck_entry_id,
                    "listingUrl": "https://ebay.com/itm/aaa",
                    "listingPrice": 75.00,
                }
            )
            payload = self.service.portfolio_insights()

        expected_keys = {
            "totalCostBasis",
            "unrealizedGain",
            "trackedInventoryCount",
            "inventoryAddedThisMonth",
            "activeListings",
            "unlistedInventory",
            "listingRate",
            "avgListingValue",
            "monthlyRevenue",
            "monthlyProfit",
            "monthlyExpense",
            "monthlyMargin",
            "numSales",
            "avgSalesPrice",
            "avgDaysToSell",
            "unsoldListings",
            "totalSales",
            "totalRevenue",
            "totalExpense",
            "totalProfit",
            "overallROI",
            "bestReturnOfAllTime",
            "topSellersThisMonth",
            "refreshedAt",
        }
        self.assertTrue(expected_keys.issubset(set(payload.keys())))
        # 1 row × 3 qty × $25 = $75
        self.assertAlmostEqual(payload["totalCostBasis"], 75.0, places=2)
        self.assertEqual(payload["activeListings"], 1)
        self.assertEqual(payload["unlistedInventory"], 0)
        self.assertEqual(payload["unsoldListings"], 1)
        self.assertEqual(payload["listingRate"], 1.0)
        self.assertEqual(payload["avgListingValue"], 75.0)
        # Seeded deck entry was added "now" → counted in this month's adds.
        self.assertEqual(payload["inventoryAddedThisMonth"], 1)
        # No sales yet → all sales-side aggregates are zero/null.
        self.assertEqual(payload["totalSales"], 0)
        self.assertEqual(payload["totalRevenue"], 0)
        self.assertIsNone(payload["bestReturnOfAllTime"])
        self.assertEqual(payload["topSellersThisMonth"], [])

    def test_portfolio_dashboard_bundles_all_sections(self) -> None:
        self._insert_card()
        self._seed_deck_entry(quantity=2)
        with self.service.request_identity_context(self._identity()):
            payload = self.service.portfolio_dashboard()

        self.assertEqual(
            set(payload.keys()),
            {"currencyCode", "inventory", "insights", "ranges", "sections"},
        )
        # Every range carries both a history and a ledger section.
        self.assertEqual(
            set(payload["ranges"].keys()),
            {"1W", "1M", "3M", "YTD", "1Y", "ALL"},
        )
        for key, section in payload["ranges"].items():
            self.assertIn("history", section, key)
            self.assertIn("ledger", section, key)
        # Inventory came back with the seeded entry.
        self.assertEqual(len(payload["inventory"]["entries"]), 1)
        # Every section computed without error.
        self.assertTrue(
            all(status == "ok" for status in payload["sections"].values()),
            payload["sections"],
        )
        self.assertEqual(payload["sections"]["inventory"], "ok")
        self.assertEqual(payload["sections"]["history.1W"], "ok")

    def test_portfolio_dashboard_matches_standalone_sections(self) -> None:
        # The consolidated path shares pre-fetched rows across ranges; prove it
        # produces byte-identical sections to calling each method standalone.
        self._insert_card()
        self._seed_deck_entry(quantity=3)

        def strip_refreshed(value: Any) -> Any:
            if isinstance(value, dict):
                return {k: strip_refreshed(v) for k, v in value.items() if k != "refreshedAt"}
            if isinstance(value, list):
                return [strip_refreshed(v) for v in value]
            return value

        history_labels = {"1W": "1W", "1M": "30D", "3M": "90D", "YTD": "YTD", "1Y": "1Y", "ALL": "ALL"}

        with self.service.request_identity_context(self._identity()):
            payload = self.service.portfolio_dashboard()
            for key, label in history_labels.items():
                standalone_history = self.service.deck_history(days=365, range_label=label)
                self.assertEqual(
                    strip_refreshed(payload["ranges"][key]["history"]),
                    strip_refreshed(standalone_history),
                    f"history mismatch for {key}",
                )
                standalone_ledger = self.service.portfolio_ledger(
                    days=365, range_label=label, limit=50, offset=0
                )
                self.assertEqual(
                    strip_refreshed(payload["ranges"][key]["ledger"]),
                    strip_refreshed(standalone_ledger),
                    f"ledger mismatch for {key}",
                )
            self.assertEqual(
                strip_refreshed(payload["inventory"]),
                strip_refreshed(self.service.deck_entries(limit=200, offset=0)),
            )
            self.assertEqual(
                strip_refreshed(payload["insights"]),
                strip_refreshed(self.service.portfolio_insights()),
            )

    def test_transaction_insights_aggregates_the_memory_log(self) -> None:
        owner = "vendor-a"
        now = datetime.now(timezone.utc)
        this_month_iso = now.isoformat()
        old_iso = (now - timedelta(days=400)).isoformat()

        def insert_txn(txn_id, kind, amount_cents, item_count, occurred_at, note):
            self.service.connection.execute(
                """
                INSERT INTO card_transactions (
                    id, owner_user_id, kind, amount_cents, item_count,
                    currency_code, note, occurred_at, created_at
                ) VALUES (?,?,?,?,?,?,?,?,?)
                """,
                (txn_id, owner, kind, amount_cents, item_count, "USD", note, occurred_at, this_month_iso),
            )

        insert_txn("t1", "sold", 45000, 1, this_month_iso, "Charizard")
        insert_txn("t2", "sold", 12000, 2, this_month_iso, "Gengar")
        insert_txn("t3", "bought", 8000, 1, this_month_iso, "Pikachu")
        insert_txn("t4", "traded", None, 1, this_month_iso, "Trade")
        insert_txn("t5", "sold", 99999, 1, old_iso, "Old Moonbreon")  # biggest all-time, not this month
        self.service.connection.commit()

        with self.service.request_identity_context(self._identity(owner)):
            payload = self.service.transaction_insights()

        # All-time sold = 1+2+1 cards, $450+$120+$999.99.
        self.assertEqual(payload["allTime"]["sold"]["count"], 4)
        self.assertEqual(payload["allTime"]["sold"]["amountCents"], 45000 + 12000 + 99999)
        # This month excludes the 400-day-old sale.
        self.assertEqual(payload["thisMonth"]["sold"]["count"], 3)
        self.assertEqual(payload["thisMonth"]["sold"]["amountCents"], 45000 + 12000)
        self.assertEqual(payload["thisMonth"]["bought"]["count"], 1)
        self.assertEqual(payload["thisMonth"]["bought"]["amountCents"], 8000)
        self.assertEqual(payload["thisMonth"]["traded"]["count"], 1)
        # Biggest sale all-time is the old high-value one.
        self.assertIsNotNone(payload["biggestSale"])
        self.assertEqual(payload["biggestSale"]["amountCents"], 99999)
        # Top sales this month: sold rows in month, ranked by amount desc.
        self.assertEqual(
            [t["amountCents"] for t in payload["topSalesThisMonth"]],
            [45000, 12000],
        )
        self.assertEqual(payload["topSalesThisMonth"][0]["note"], "Charizard")

    def test_batched_yesterday_rows_match_per_card_query(self) -> None:
        self._insert_card()
        for price_date in ("2026-06-05", "2026-06-06"):
            self.service.connection.execute(
                """
                INSERT INTO card_price_history_daily (
                    card_id, provider, price_date,
                    graded_contexts_json, raw_contexts_json,
                    display_currency_code, updated_at
                ) VALUES (?,?,?,?,?,?,?)
                """,
                ("base-charizard-4", "scrydex", price_date, "{}", "{}", "USD", "2026-06-06T00:00:00Z"),
            )
        self.service.connection.commit()

        per_card = self.service._yesterday_price_history_row_for_card("base-charizard-4")
        batched = self.service._yesterday_price_history_rows_by_card_id(["base-charizard-4"])
        self.assertIsNotNone(per_card)
        self.assertIn("base-charizard-4", batched)
        self.assertEqual(dict(batched["base-charizard-4"]), dict(per_card))
        # It picks the latest day strictly before today.
        self.assertEqual(per_card["price_date"], "2026-06-06")

    def test_deck_entries_skips_day_change_when_disabled_but_keeps_summary(self) -> None:
        self._insert_card()
        self._seed_deck_entry(quantity=2)
        with self.service.request_identity_context(self._identity()):
            full = self.service.deck_entries(limit=200, offset=0)
            summary_only = self.service.deck_entries(limit=200, offset=0, compute_day_change=False)

        self.assertEqual(full["summary"], summary_only["summary"])
        for entry in summary_only["entries"]:
            self.assertIsNone(entry["dayChangeAmount"])
            self.assertIsNone(entry["dayChangePercent"])

    def test_portfolio_insights_picks_best_return_by_absolute_profit(self) -> None:
        self._insert_card("base-charizard-4")
        self._insert_card("base-blastoise-2")
        # Two distinct deck entries with different cost bases / sale prices.
        with self.service.request_identity_context(self._identity()):
            charizard_entry = self.service.record_buy(
                {
                    "cardID": "base-charizard-4",
                    "quantity": 1,
                    "unitPrice": 40.0,
                    "currencyCode": "USD",
                    "costBasisPerUnit": 40.0,
                }
            )["deckEntryID"]
            blastoise_entry = self.service.record_buy(
                {
                    "cardID": "base-blastoise-2",
                    "quantity": 1,
                    "unitPrice": 20.0,
                    "currencyCode": "USD",
                    "costBasisPerUnit": 20.0,
                }
            )["deckEntryID"]
            self.service.record_sale(
                {
                    "deckEntryID": charizard_entry,
                    "unitPrice": 500.0,  # profit ~ $460
                    "currencyCode": "USD",
                    "paymentMethod": "cash",
                }
            )
            self.service.record_sale(
                {
                    "deckEntryID": blastoise_entry,
                    "unitPrice": 30.0,  # profit ~ $10
                    "currencyCode": "USD",
                    "paymentMethod": "cash",
                }
            )
            insights = self.service.portfolio_insights()

        best = insights["bestReturnOfAllTime"]
        self.assertIsNotNone(best)
        self.assertEqual(best["card"]["id"], "base-charizard-4")
        self.assertEqual(best["profit"], 460.0)
        # Total sales (lifetime) should be 2.
        self.assertEqual(insights["totalSales"], 2)
        self.assertGreaterEqual(insights["totalProfit"], 470.0)


class PortfolioDashboardPrewarmTests(unittest.TestCase):
    """The startup prewarm should warm the per-owner dashboard cache so the
    first real refresh after a reboot is a cache hit instead of a cold read."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "dashboard-prewarm.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _identity(self, user_id: str = "vendor-a") -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(self) -> None:
        upsert_card(
            self.service.connection,
            card_id="base-charizard-4",
            name="Charizard",
            set_name="Base Set",
            number="4/102",
            rarity="Holo Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id="base-charizard-4",
            set_id="base1",
            set_ptcgo_code="BS",
            set_release_date="1999-01-09",
            source_payload={"id": "base-charizard-4"},
        )
        self.service.connection.commit()

    def _seed_deck_entry(self, *, quantity: int = 1, user_id: str = "vendor-a") -> str:
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id=user_id,
            card_id="base-charizard-4",
            condition="near_mint",
            quantity=quantity,
            unit_price=50.0,
            currency_code="USD",
        )
        self.service.connection.commit()
        return deck_entry_id

    def test_prewarm_warms_each_active_owner(self) -> None:
        self._insert_card()
        self._seed_deck_entry(quantity=2, user_id="vendor-a")
        self._seed_deck_entry(quantity=1, user_id="vendor-b")

        result = self.service.prewarm_portfolio_dashboards()

        self.assertEqual(result["ownerCount"], 2)
        self.assertEqual(result["warmedCount"], 2)
        # Both owners now have a populated dashboard cache entry.
        cached_owners = {key[0] for key in self.service._dashboard_cache}
        self.assertEqual(cached_owners, {"vendor-a", "vendor-b"})

    def test_prewarmed_owner_serves_a_cache_hit(self) -> None:
        self._insert_card()
        self._seed_deck_entry(quantity=2, user_id="vendor-a")

        self.service.prewarm_portfolio_dashboards()

        # A subsequent request for the prewarmed owner is served from cache.
        timings: list[str] = []
        original = self.service._log_dashboard_timing
        self.service._log_dashboard_timing = (  # type: ignore[method-assign]
            lambda started_at, *, outcome: timings.append(outcome)
        )
        try:
            with self.service.request_identity_context(self._identity("vendor-a")):
                self.service.portfolio_dashboard()
        finally:
            self.service._log_dashboard_timing = original  # type: ignore[method-assign]

        self.assertEqual(timings, ["hit"])

    def test_prewarm_with_no_owners_is_a_noop(self) -> None:
        result = self.service.prewarm_portfolio_dashboards()
        self.assertEqual(result["ownerCount"], 0)
        self.assertEqual(result["warmedCount"], 0)


if __name__ == "__main__":
    unittest.main()
