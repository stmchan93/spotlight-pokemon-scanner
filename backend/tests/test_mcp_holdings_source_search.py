"""MCP fixes: holdings carry their printing (variant), zero-quantity duplicate deck
rows never count, price_source names the lane that actually served the number
(TCGCSV main lane -> "tcgplayer"), and `name`/`query` alias the `text` filter.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
for path in (BACKEND_ROOT, BACKEND_ROOT / "tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import tag_card_art  # noqa: E402

from catalog_tools import (  # noqa: E402
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_price_snapshot,
    utc_now,
)
from mcp_server.filters import ToolInputError, normalize_card_filter  # noqa: E402
from mcp_server.policy import USER_POLICY  # noqa: E402
from mcp_server.readonly_service import ReadOnlySpotlightService  # noqa: E402
from mcp_server.tools import CollectionTools, printing_name, usd_price  # noqa: E402

USER = "user-a"
SHADOWLESS = "First Edition Shadowless Holofoil"
FLAG_ON = {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"}


class _Case(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, FLAG_ON)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        db_path = Path(self.tempdir.name) / "mcp.sqlite"
        conn = connect(db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        conn.close()
        self.service = ReadOnlySpotlightService(db_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)
        self.tools = CollectionTools(self.service)
        self.conn = self.service.connection
        self._seed()

    def _price(self, card_id, *, mode, market, variant, grader=None, grade=None):
        upsert_price_snapshot(
            self.conn, card_id=card_id, pricing_mode=mode, provider="scrydex", currency_code="USD",
            variant=variant, grader=grader, grade=grade, condition=None if grader else "NM",
            low_price=market, market_price=market, mid_price=market, high_price=market,
            direct_low_price=market, trend_price=market, payload={"provider": "scrydex"},
        )

    def _deck(self, entry_id, card_id, *, quantity, grader=None, grade=None, variant=None, identity=None):
        added = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        self.conn.execute(
            "INSERT INTO deck_entries (id, owner_user_id, identity_key, item_kind, card_id, grader, grade, "
            "variant_name, condition, quantity, cost_basis_total, cost_basis_currency_code, added_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'near_mint', ?, 0, 'USD', ?, ?)",
            (entry_id, USER, identity or entry_id, "slab" if grader else "raw", card_id, grader, grade, variant,
             quantity, added, added),
        )

    def _seed(self) -> None:
        upsert_card(
            self.conn, card_id="base1-4", name="Charizard", set_name="Base", number="4/102", rarity="Rare Holo",
            variant="Raw", language="English", source_provider="scrydex", source_record_id="base1-4",
            set_id="base1", set_ptcgo_code="BS", set_release_date="1999-01-09", artist="Mitsuhiro Arita",
            supertype="Pokémon", national_pokedex_numbers=[6], image_url="https://img.example/base1-4.png",
            source_payload={"id": "base1-4"},
        )
        upsert_card(
            self.conn, card_id="sv-1", name="Pidgey", set_name="Scarlet & Violet", number="1", rarity="Common",
            variant="Raw", language="English", source_provider="scrydex", source_record_id="sv-1",
            set_id="sv1", set_ptcgo_code="SVI", set_release_date="2023-03-31", artist="Someone",
            supertype="Pokémon", national_pokedex_numbers=[16], image_url="https://img.example/sv-1.png",
            source_payload={"id": "sv-1"},
        )
        # Scrydex raw (the default printing) + PSA 10 per-printing slab price.
        self._price("base1-4", mode=RAW_PRICING_MODE, market=1500.0, variant="Holofoil")
        self._price("base1-4", mode=PSA_GRADE_PRICING_MODE, market=409539.86, variant=SHADOWLESS,
                    grader="PSA", grade="10")
        # TCGCSV/TCGplayer main lane wins the raw headline.
        self.conn.execute(
            "UPDATE card_price_snapshots SET main_raw_market_price = 987.13, main_raw_low_price = 900, "
            "main_raw_mid_price = 950, main_raw_high_price = 1000, main_raw_variant = 'Holofoil', "
            "main_raw_updated_at = ? WHERE card_id = 'base1-4'",
            (utc_now(),),
        )
        # Scrydex-only card: no main lane.
        self._price("sv-1", mode=RAW_PRICING_MODE, market=0.25, variant="Normal")

        self._deck("slab", "base1-4", quantity=1, grader="PSA", grade="10", variant=SHADOWLESS)
        self._deck("raw", "base1-4", quantity=2)
        # Zero/NULL-quantity duplicates of the slab: never holdings, never value.
        self._deck("dup0", "base1-4", quantity=0, grader="PSA", grade="10", variant=SHADOWLESS, identity="d0")
        self._deck("dupnull", "base1-4", quantity=0, identity="dn")
        # Art tables exist on every real DB; get_card reads them.
        tag_card_art.write_tagged_groups(self.conn, [], model="test")
        self.conn.commit()


class PrintingTests(_Case):
    def test_printing_name(self) -> None:
        self.assertEqual(printing_name(SHADOWLESS), "1st Edition Shadowless Holofoil")
        self.assertEqual(printing_name("  Unlimited   Holofoil "), "Unlimited Holofoil")
        self.assertIsNone(printing_name(None))
        self.assertIsNone(printing_name(""))

    def test_get_card_holdings_have_variant_and_skip_zero_quantity(self) -> None:
        card = self.tools.get_card(USER, "base1-4")
        holdings = card["my_holdings"]
        self.assertEqual(len(holdings), 2)
        slab = next(h for h in holdings if h["grader"] == "PSA")
        self.assertEqual(slab["variant"], "1st Edition Shadowless Holofoil")
        self.assertEqual(slab["grade"], "10")
        raw = next(h for h in holdings if h["grader"] is None)
        self.assertEqual(raw["quantity"], 2)
        self.assertEqual(raw["variant"], "Holofoil")  # the served main printing
        shaped = USER_POLICY.shape(card)
        self.assertEqual(shaped["my_holdings"][0]["variant"], slab["variant"])

    def test_collection_items_have_variant_and_value_ignores_duplicates(self) -> None:
        result = self.tools.get_my_collection(USER)
        self.assertEqual(result["total_count"], 2)
        by_grader = {item["grader"]: item for item in result["items"]}
        slab = by_grader["PSA"]
        self.assertEqual(slab["variant"], "1st Edition Shadowless Holofoil")
        self.assertEqual(slab["value_usd"], 409539.86)
        self.assertEqual(slab["price_source"], "scrydex")  # graded lane = Scrydex
        raw = by_grader[None]
        self.assertEqual(raw["value_usd"], round(987.13 * 2, 2))
        self.assertEqual(raw["price_source"], "tcgplayer")
        self.assertEqual(result["total_value_usd"], round(409539.86 + 987.13 * 2, 2))
        # The policy lets variant out for the user tier.
        shaped = USER_POLICY.shape(result)
        self.assertTrue(all("variant" in item for item in shaped["items"]))

    def test_portfolio_value_ignores_zero_quantity_rows(self) -> None:
        summary = self.tools.get_portfolio_summary(USER)
        self.assertEqual(summary["holdings_count"], 2)
        self.assertEqual(summary["value_usd"], round(409539.86 + 987.13 * 2, 2))


class PriceSourceTests(_Case):
    def test_tcgcsv_main_lane_labelled_tcgplayer(self) -> None:
        card = self.tools.get_card(USER, "base1-4")
        self.assertEqual(card["price_usd"], 987.13)
        self.assertEqual(card["price_source"], "tcgplayer")

    def test_scrydex_only_card_stays_scrydex(self) -> None:
        card = self.tools.get_card(USER, "sv-1")
        self.assertEqual(card["price_usd"], 0.25)
        self.assertEqual(card["price_source"], "scrydex")

    def test_flag_off_falls_back_to_scrydex(self) -> None:
        with mock.patch.dict(os.environ, {"RAW_MAIN_PRICE_SOURCE": "scrydex"}):
            card = self.tools.get_card(USER, "base1-4")
        self.assertEqual(card["price_usd"], 1500.0)
        self.assertEqual(card["price_source"], "scrydex")

    def test_usd_price_labels(self) -> None:
        self.assertEqual(
            usd_price({"currencyCode": "USD", "market": 5, "source": "scrydex", "mainPriceSource": "tcgcsv"}),
            (5.0, "tcgplayer"),
        )
        self.assertEqual(
            usd_price({"currencyCode": "USD", "market": 5, "source": "scrydex", "mainPriceSource": "scrydex"}),
            (5.0, "scrydex"),
        )
        self.assertEqual(usd_price({"currencyCode": "USD", "market": 5, "provider": "tcgcsv"}), (5.0, "tcgplayer"))


class NameSearchTests(_Case):
    def test_name_and_query_alias_text(self) -> None:
        self.assertEqual(normalize_card_filter({"name": "charizard"}), {"text": "charizard"})
        self.assertEqual(normalize_card_filter({"query": "Charizard"}), {"text": "Charizard"})
        self.assertEqual(normalize_card_filter({"text": "charizard", "name": "CHARIZARD"}), {"text": "charizard"})
        for key in ("name", "query", "text"):
            result = self.tools.search_cards(USER, {key: "CHARIZARD"})
            self.assertEqual([item["card_id"] for item in result["results"]], ["base1-4"], key)
        owned = self.tools.get_my_collection(USER, {"name": "charizard"})
        self.assertEqual(owned["total_count"], 2)

    def test_unknown_field_lists_accepted_fields(self) -> None:
        with self.assertRaises(ToolInputError) as ctx:
            normalize_card_filter({"title": "charizard"})
        self.assertIn("Accepted:", str(ctx.exception))
        self.assertIn("name", str(ctx.exception))

    def test_pydantic_filter_accepts_aliases(self) -> None:
        try:
            from mcp_server.app import CardFilter, _filter_dict
        except ImportError:  # MCP SDK not installed in this env
            self.skipTest("mcp SDK not installed")
        self.assertEqual(_filter_dict(CardFilter(name="charizard")), {"name": "charizard"})


if __name__ == "__main__":
    unittest.main()
