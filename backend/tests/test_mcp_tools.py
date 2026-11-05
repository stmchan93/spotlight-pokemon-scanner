"""MCP tool logic (mcp_server.tools) on a seeded temp SQLite DB.

No MCP SDK needed: CollectionTools is plain Python over the read-only service.
"""

from __future__ import annotations

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
from catalog_tools import RAW_PRICING_MODE, apply_schema, connect, upsert_card, upsert_price_history_daily, utc_now  # noqa: E402,E501
from mcp_server.filters import ToolInputError, decode_cursor  # noqa: E402
from mcp_server.readonly_service import ReadOnlySpotlightService  # noqa: E402
from mcp_server.tools import CollectionTools, usd_price  # noqa: E402
from request_auth import RequestAuthError, RequestIdentity  # noqa: E402

USER_A = "user-a"
USER_B = "user-b"


def _days_ago(days: int) -> str:
    return (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()


class McpToolsCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        db_path = Path(self.tempdir.name) / "mcp.sqlite"
        conn = connect(db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        conn.close()
        self.service = ReadOnlySpotlightService(db_path, REPO_ROOT)
        self.tools = CollectionTools(self.service)
        self.conn = self.service.connection
        self._seed()

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    # --- seeding -------------------------------------------------------------

    def card(self, card_id, name, *, number="1", language="English", rarity="Common", set_name="Surging Sparks",
             set_code="SSP", release="2024-11-08", dex=None, tcgplayer_id=None):
        upsert_card(
            self.conn, card_id=card_id, name=name, set_name=set_name, number=number, rarity=rarity,
            variant="Raw", language=language, source_provider="scrydex", source_record_id=card_id,
            set_id=set_code.lower(), set_ptcgo_code=set_code, set_release_date=release, artist="Mitsuhiro Arita",
            supertype="Pokémon", national_pokedex_numbers=dex or [], image_url=f"https://img.example/{card_id}.png",
            source_payload={"id": card_id},
        )
        if tcgplayer_id:
            self.conn.execute("UPDATE cards SET tcgplayer_id = ? WHERE id = ?", (tcgplayer_id, card_id))

    def price(self, card_id, amount, currency="USD"):
        self.conn.execute(
            "INSERT INTO card_price_snapshots (card_id, provider, display_currency_code, default_raw_market_price, "
            "updated_at) VALUES (?, 'scrydex', ?, ?, ?)",
            (card_id, currency, amount, utc_now()),
        )

    def history(self, card_id, points, currency="USD", condition="NM", variant="Normal"):
        for days, market in points:
            upsert_price_history_daily(
                self.conn, card_id=card_id, pricing_mode=RAW_PRICING_MODE, provider="scrydex",
                price_date=_days_ago(days), currency_code=currency, variant=variant, condition=condition,
                low_price=market, market_price=market, mid_price=market, high_price=market,
                direct_low_price=market, trend_price=market, payload={"provider": "scrydex"},
            )

    def holding(self, entry_id, owner, card_id, *, quantity=1, cost=0.0, added_days_ago=60, collection_id=None,
                grader=None, grade=None):
        added = (datetime.now(timezone.utc) - timedelta(days=added_days_ago)).isoformat()
        self.conn.execute(
            "INSERT INTO deck_entries (id, owner_user_id, identity_key, item_kind, card_id, grader, grade, condition, "
            "quantity, cost_basis_total, cost_basis_currency_code, added_at, updated_at, collection_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'near_mint', ?, ?, 'USD', ?, ?, ?)",
            (entry_id, owner, f"{card_id}|{grader or ''}|{grade or ''}", "slab" if grader else "raw", card_id,
             grader, grade, quantity, cost, added, added, collection_id),
        )

    def collection(self, collection_id, owner, name, *, hidden=False):
        self.conn.execute(
            "INSERT INTO collections (id, owner_user_id, name, created_at, hidden) VALUES (?, ?, ?, ?, ?)",
            (collection_id, owner, name, utc_now(), 1 if hidden else 0),
        )

    def _seed(self) -> None:
        self.card("ssp-1", "Pikachu ex", number="238", rarity="Special Illustration Rare", dex=[25], tcgplayer_id="590001")
        self.card("ssp-2", "Charizard ex", number="2", rarity="Double Rare", dex=[6])
        self.card("ssp-3", "Eevee", number="3", dex=[133])
        self.card("ssp-4", "Snorlax", number="4", dex=[143])
        self.card("jp-1", "Pikachu ex", number="132", language="Japanese", set_name="Super Electric Breaker",
                  set_code="SV8", rarity="Special Art Rare", dex=[25])
        self.price("ssp-1", 120.0)
        self.price("ssp-2", 8.0)
        self.price("ssp-3", 0.5)
        self.price("jp-1", 15000.0, currency="JPY")  # JPY-only
        # ssp-4: never priced
        self.history("ssp-1", [(40, 90.0), (20, 100.0), (1, 120.0)])
        self.history("ssp-2", [(40, 10.0), (1, 8.0)])
        self.history("jp-1", [(20, 14000.0), (1, 15000.0)], currency="JPY")
        self.conn.execute(
            "INSERT INTO card_language_links (card_id, counterpart_card_id, counterpart_language, match_method, "
            "created_at) VALUES (?, ?, ?, 'test', ?)",
            ("ssp-1", "jp-1", "Japanese", utc_now()),
        )
        self.collection("col-main", USER_A, "Main")
        self.collection("col-hidden", USER_A, "Trade bait", hidden=True)
        self.collection("col-b", USER_B, "B's")
        self.holding("a1", USER_A, "ssp-1", quantity=1, cost=80.0, collection_id="col-main")
        self.holding("a2", USER_A, "ssp-2", quantity=3, collection_id="col-main")
        self.holding("a3", USER_A, "jp-1", quantity=1, collection_id="col-main")
        self.holding("a4", USER_A, "ssp-3", quantity=10, collection_id="col-hidden")
        self.holding("b1", USER_B, "ssp-4", quantity=1, collection_id="col-b")
        self.holding("b2", USER_B, "ssp-3", quantity=2, collection_id="col-b")
        tag_card_art.write_tagged_groups(
            self.conn,
            [
                {"art_group_id": "g-pika", "representative_card_id": "ssp-1", "members": {"ssp-1": "self", "jp-1": "language"},
                 "tags": {"scene": ["beach"]}, "rows": [("scene", "beach", None, 0.9), ("mood", "cheerful", None, 0.9)],
                 "alt_text": "Pikachu splashes on a sunny beach."},
                {"art_group_id": "g-eevee", "representative_card_id": "ssp-3", "members": {"ssp-3": "self"},
                 "tags": {}, "rows": [("scene", "beach", None, 0.9)], "alt_text": None},
                {"art_group_id": "g-snorlax", "representative_card_id": "ssp-4", "members": {"ssp-4": "self"},
                 "tags": {}, "rows": [("scene", "forest", None, 0.9)], "alt_text": None},
            ],
            model="test",
        )
        self.conn.commit()

    def call(self, method, owner=USER_A, *args, **kwargs):
        with self.service.request_identity_context(RequestIdentity(user_id=owner, auth_source="test")):
            return getattr(self.tools, method)(owner, *args, **kwargs)

    @staticmethod
    def ids(items):
        return [item["card_id"] for item in items]


class UsdOnlyTests(unittest.TestCase):
    def test_usd_price_rejects_yen_and_fx_converted(self) -> None:
        self.assertEqual(usd_price({"currencyCode": "USD", "market": 3.456, "source": "tcgplayer"}), (3.46, "tcgplayer"))
        self.assertEqual(usd_price({"currencyCode": "JPY", "market": 1500}), (None, None))
        self.assertEqual(usd_price({"currencyCode": "USD", "market": 10.0, "displayIsConverted": True}), (None, None))
        self.assertEqual(usd_price(None), (None, None))


class SearchAndCardTests(McpToolsCase):
    def test_catalog_search_fallback_without_art_facets(self) -> None:
        result = self.call("search_cards", card_filter={"text": "pikachu"})
        self.assertEqual(sorted(self.ids(result["results"])), ["jp-1", "ssp-1"])
        by_id = {item["card_id"]: item for item in result["results"]}
        self.assertEqual(by_id["ssp-1"]["price_usd"], 120.0)
        self.assertIsNone(by_id["jp-1"]["price_usd"])  # JPY-only -> null
        self.assertEqual(by_id["ssp-1"]["rarity_bucket"], "sir")
        self.assertEqual(by_id["ssp-1"]["app_url"], "spotlight://cards/ssp-1")
        self.assertEqual(by_id["ssp-1"]["tcgplayer_id"], "590001")
        for key in ("name", "set", "number", "language", "artist", "image_small_url", "price_source"):
            self.assertIn(key, by_id["ssp-1"])

    def test_art_search_owned_modes_and_price_sort(self) -> None:
        result = self.call("search_cards", card_filter={"scene": ["beach"]}, sort="price_desc")
        self.assertEqual(self.ids(result["results"])[:2], ["ssp-1", "ssp-3"])
        owned = self.call("search_cards", card_filter={"scene": ["beach"]}, owned="owned")
        self.assertEqual(sorted(self.ids(owned["results"])), ["jp-1", "ssp-1", "ssp-3"])
        not_owned = self.call("search_cards", USER_B, card_filter={"scene": ["beach"]}, owned="not_owned")
        self.assertEqual(sorted(self.ids(not_owned["results"])), ["jp-1", "ssp-1"])

    def test_search_pagination_and_caps(self) -> None:
        first = self.call("search_cards", card_filter={"set": "Surging Sparks"}, sort="price_asc", limit=2)
        self.assertEqual(self.ids(first["results"]), ["ssp-3", "ssp-2"])
        self.assertEqual(first["total_estimate"], 4)
        second = self.call("search_cards", card_filter={"set": "Surging Sparks"}, sort="price_asc", limit=2,
                           cursor=first["next_cursor"])
        self.assertEqual(self.ids(second["results"]), ["ssp-1", "ssp-4"])  # unpriced last
        self.assertIsNone(second["next_cursor"])
        with self.assertRaises(ToolInputError):  # cursor from another query
            self.call("search_cards", card_filter={"text": "eevee"}, cursor=first["next_cursor"])
        with self.assertRaises(ToolInputError):
            self.call("search_cards", card_filter={"text": "x"}, limit=51)
        with self.assertRaises(ToolInputError):
            self.call("search_cards", card_filter={"pokemon": [str(i) for i in range(11)]})
        with self.assertRaises(ToolInputError):
            self.call("search_cards", card_filter={"text": "x" * 121})
        with self.assertRaises(ToolInputError):
            self.call("search_cards", card_filter={"scene": ["not-a-scene"]})
        with self.assertRaises(ToolInputError):
            self.call("search_cards", card_filter={})

    def test_price_filter(self) -> None:
        result = self.call("search_cards", card_filter={"set": "Surging Sparks", "price_min_usd": 1, "price_max_usd": 50})
        self.assertEqual(self.ids(result["results"]), ["ssp-2"])

    def test_get_card_with_art_pair_and_own_holdings_only(self) -> None:
        card = self.call("get_card", card_id="ssp-1")
        self.assertEqual(card["language_pair"], "jp-1")
        self.assertEqual(card["alt_text"], "Pikachu splashes on a sunny beach.")
        self.assertEqual(card["tags"], {"scene": ["beach"]})
        self.assertEqual(card["my_holdings"][0]["quantity"], 1)
        self.assertEqual(card["my_holdings"][0]["cost_basis_usd"], 80.0)
        self.assertIsInstance(card["similar"], list)
        self.assertEqual(self.call("get_card", USER_B, card_id="ssp-1")["my_holdings"], [])
        self.assertEqual(len(self.call("get_card", USER_B, card_id="ssp-3")["my_holdings"]), 1)
        with self.assertRaises(ToolInputError):
            self.call("get_card", card_id="nope")

    def test_list_facets_only_filterable(self) -> None:
        facets = self.call("list_facets")
        self.assertEqual(set(facets["facets"]), {"scene", "weather_time", "activity", "mood", "art_style", "palette"})
        self.assertIn({"value": "beach", "count": 2}, facets["facets"]["scene"])
        self.assertTrue(facets["themes"])


class CollectionTests(McpToolsCase):
    def test_collection_excludes_hidden_and_other_users(self) -> None:
        result = self.call("get_my_collection")
        self.assertEqual(self.ids(result["items"]), ["ssp-1", "ssp-2", "jp-1"])  # value_desc, unpriced last
        self.assertEqual(result["total_value_usd"], 144.0)  # 120 + 3*8; yen card unpriced
        self.assertEqual(result["unpriced_count"], 1)
        top = result["items"][0]
        self.assertEqual((top["quantity"], top["condition"], top["value_usd"], top["gain_usd"]), (1, "NM", 120.0, 40.0))
        b = self.call("get_my_collection", USER_B)
        self.assertEqual(sorted(self.ids(b["items"])), ["ssp-3", "ssp-4"])

    def test_named_collection_including_hidden_and_foreign_ids(self) -> None:
        hidden = self.call("get_my_collection", collection_id="col-hidden")
        self.assertEqual(self.ids(hidden["items"]), ["ssp-3"])
        self.assertEqual(hidden["total_value_usd"], 5.0)
        with self.assertRaises(ToolInputError):
            self.call("get_my_collection", collection_id="col-b")  # user B's collection

    def test_collection_filter_sort_and_pages(self) -> None:
        art = self.call("get_my_collection", card_filter={"scene": ["beach"]})
        self.assertEqual(sorted(self.ids(art["items"])), ["jp-1", "ssp-1"])
        page = self.call("get_my_collection", sort="added_desc", limit=2)
        self.assertEqual(len(page["items"]), 2)
        rest = self.call("get_my_collection", sort="added_desc", limit=2, cursor=page["next_cursor"])
        self.assertEqual(len(rest["items"]), 1)
        self.assertEqual(rest["total_value_usd"], page["total_value_usd"])  # totals cover all pages
        with self.assertRaises(ToolInputError):
            self.call("get_my_collection", limit=101)

    def test_portfolio_summary(self) -> None:
        summary = self.call("get_portfolio_summary", range_key="30d")
        self.assertEqual(summary["value_usd"], 144.0)
        # ssp-1: 100 (20d ago) -> 120; ssp-2 has no point inside 30d -> excluded.
        self.assertEqual(summary["change_usd"], 20.0)
        self.assertEqual(self.ids(summary["top_gainers"]), ["ssp-1"])
        self.assertEqual(summary["top_losers"], [])
        # 90d covers the 40-day-old points: ssp-1 90 -> 120 (+30), ssp-2 10 -> 8 (x3 = -6).
        wider = self.call("get_portfolio_summary", range_key="90d")
        self.assertEqual(self.ids(wider["top_losers"]), ["ssp-2"])
        self.assertEqual(wider["change_usd"], 24.0)
        self.assertEqual(self.call("get_portfolio_summary", USER_B)["top_gainers"], [])
        with self.assertRaises(ToolInputError):
            self.call("get_portfolio_summary", range_key="5y")

    def test_find_missing_cheapest_first_with_links_and_budget(self) -> None:
        result = self.call("find_missing", card_filter={"set": "Surging Sparks"})
        # A owns ssp-1/2/3 (incl. hidden collection); only Snorlax is missing.
        self.assertEqual(self.ids(result["missing"]), ["ssp-4"])
        self.assertEqual((result["owned_count"], result["total_matching"]), (3, 4))
        self.assertIsNone(result["cheapest_completion_usd"])  # Snorlax unpriced
        self.assertIn("ebay", result["missing"][0]["buy_links"])
        b = self.call("find_missing", USER_B, card_filter={"set": "Surging Sparks"})
        self.assertEqual(self.ids(b["missing"]), ["ssp-2", "ssp-1"])
        self.assertEqual(b["cheapest_completion_usd"], 128.0)
        self.assertIn("590001", b["missing"][1]["buy_links"]["tcgplayer"])
        budget = self.call("find_missing", USER_B, card_filter={"set": "Surging Sparks"}, budget_usd=10)
        self.assertEqual(self.ids(budget["missing"]), ["ssp-2"])
        art = self.call("find_missing", USER_B, card_filter={"scene": ["beach"]})
        self.assertEqual(self.ids(art["missing"]), ["ssp-1", "jp-1"])
        self.assertEqual((art["owned_count"], art["total_matching"]), (1, 3))
        with self.assertRaises(ToolInputError):
            self.call("find_missing", card_filter={})

    def test_price_history_usd_only(self) -> None:
        history = self.call("get_price_history", card_id="ssp-1", range_key="30d")
        self.assertEqual([p["usd"] for p in history["points"]], [100.0, 120.0])
        self.assertEqual(history["source"], "scrydex")
        self.assertEqual(self.call("get_price_history", card_id="jp-1")["points"], [])  # yen never returned
        with self.assertRaises(ToolInputError):
            self.call("get_price_history", card_id="ssp-1", condition="MINT")


class ReadOnlyServiceTests(McpToolsCase):
    def test_no_live_pricing_and_no_fallback_identity(self) -> None:
        self.assertFalse(self.service._live_pricing_enabled())
        self.assertFalse(self.service._live_scrydex_pricing_refresh_allowed())
        with self.assertRaises(RequestAuthError):
            self.service._current_request_identity()

    def test_tools_never_touch_providers(self) -> None:
        import scrydex_adapter

        boom = mock.Mock(side_effect=AssertionError("provider called"))
        with mock.patch.object(scrydex_adapter, "fetch_json", boom, create=True):
            self.call("search_cards", card_filter={"text": "pikachu"}, sort="price_asc")
            self.call("get_card", card_id="ssp-4")
            self.call("get_my_collection")
            self.call("find_missing", card_filter={"set": "Surging Sparks"})
        boom.assert_not_called()

    def test_cursor_is_opaque_and_kind_checked(self) -> None:
        first = self.call("search_cards", card_filter={"set": "Surging Sparks"}, limit=1)
        self.assertEqual(decode_cursor(first["next_cursor"], kind="search")["o"], 1)
        with self.assertRaises(ToolInputError):
            self.call("get_my_collection", cursor=first["next_cursor"])


if __name__ == "__main__":
    unittest.main()
