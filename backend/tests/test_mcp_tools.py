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
from mcp_server import tools as tools_module  # noqa: E402
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
             set_code="SSP", release="2024-11-08", dex=None, tcgplayer_id=None, artist="Mitsuhiro Arita"):
        upsert_card(
            self.conn, card_id=card_id, name=name, set_name=set_name, number=number, rarity=rarity,
            variant="Raw", language=language, source_provider="scrydex", source_record_id=card_id,
            set_id=set_code.lower(), set_ptcgo_code=set_code, set_release_date=release, artist=artist,
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
    def test_usd_price_rejects_yen_keeps_fx_converted_usd(self) -> None:
        self.assertEqual(usd_price({"currencyCode": "USD", "market": 3.456, "source": "tcgplayer"}), (3.46, "tcgplayer"))
        self.assertEqual(usd_price({"currencyCode": "JPY", "market": 1500}), (None, None))
        # JPY cards arrive FX-converted to USD, as the app shows them, labelled.
        self.assertEqual(
            usd_price({"currencyCode": "USD", "market": 10.0, "displayIsConverted": True, "source": "scrydex"}),
            (10.0, "scrydex (converted to USD from JPY)"),
        )
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


class StructuredFilterTests(McpToolsCase):
    """Artist/set filters without text query the catalog directly, so price and
    artist apply before any pool cap (eval: 'Arita cards under $20' found none)."""

    def main_price(self, card_id, amount):
        # TCGCSV main lane, as on staging; catalog search breaks score ties on it, pricier first.
        self.price(card_id, amount)
        self.conn.execute("UPDATE card_price_snapshots SET main_raw_market_price = ? WHERE card_id = ?",
                          (amount, card_id))

    def seed_prolific_artist(self, expensive=260, cheap=5):
        for i in range(expensive):
            card_id = f"vin-{i:03d}"
            self.card(card_id, f"Vintage Holo {i}", number=str(i), set_name="Vintage", set_code="VIN",
                      artist="Mitsuhiro Arita", rarity="Rare Holo")
            self.main_price(card_id, 1000.0 + i)
        for i in range(cheap):
            card_id = f"bulk-{i}"
            self.card(card_id, f"Bulk Common {i}", number=str(i), set_name="Modern", set_code="MOD",
                      artist="Mitsuhiro Arita")
            self.main_price(card_id, 1.0 + i)
        self.card("other-1", "Other Artist Card", set_name="Modern", set_code="MOD", artist="Ken Sugimori")
        self.price("other-1", 2.0)
        self.conn.commit()

    def test_artist_with_price_max_finds_cheap_cards_among_many_expensive(self) -> None:
        self.seed_prolific_artist()
        result = self.call("search_cards", card_filter={"artist": "Mitsuhiro Arita", "price_max_usd": 20})
        ids = self.ids(result["results"])
        self.assertTrue({f"bulk-{i}" for i in range(5)} <= set(ids), ids)
        self.assertNotIn("other-1", ids)
        self.assertTrue(all(item["price_usd"] <= 20 for item in result["results"]))
        asc = self.call("search_cards", card_filter={"artist": "arita"}, sort="price_asc", limit=3)
        self.assertEqual(self.ids(asc["results"]), ["ssp-3", "bulk-0", "bulk-1"])

    def test_find_missing_by_artist_under_budget_price(self) -> None:
        self.seed_prolific_artist()
        result = self.call("find_missing", USER_B, card_filter={"artist": "Mitsuhiro Arita", "price_max_usd": 20})
        self.assertEqual(self.ids(result["missing"])[:3], ["bulk-0", "bulk-1", "bulk-2"])
        self.assertIn("ssp-2", self.ids(result["missing"]))  # $8 Surging Sparks card, not owned by B

    def test_capped_set_pool_keeps_exact_counts_and_drops_completion_cost(self) -> None:
        for i in range(6):
            self.card(f"big-{i}", f"Big Set Card {i}", number=str(i), set_name="Big Set", set_code="BIG")
            self.price(f"big-{i}", 1.0 + i)
        self.holding("a-big", USER_A, "big-5")
        self.conn.commit()
        with mock.patch.object(tools_module, "STRUCTURED_MISSING_POOL_SIZE", 3):
            result = self.call("find_missing", card_filter={"set": "Big Set"})
            self.assertEqual(self.ids(result["missing"]), ["big-0", "big-1", "big-2"])
            self.assertEqual((result["missing_count"], result["owned_count"], result["total_matching"]), (5, 1, 6))
            self.assertIsNone(result["cheapest_completion_usd"])
            self.assertNotIn("total_is_lower_bound", result)  # counts are exact
            self.assertIn("note", result)
            priced = self.call("find_missing", card_filter={"set": "Big Set", "price_max_usd": 100})
            self.assertTrue(priced["total_is_lower_bound"])
            self.assertIsNone(priced["cheapest_completion_usd"])
        full = self.call("find_missing", card_filter={"set": "Big Set"})
        self.assertEqual(full["missing_count"], 5)
        self.assertEqual(full["cheapest_completion_usd"], 15.0)
        self.assertNotIn("note", full)

    def test_relevance_pool_cap_is_detected(self) -> None:
        # catalog search returns at most CATALOG_SEARCH_MAX_RESULTS per call, below
        # MISSING_POOL_SIZE: a full page must still read as capped ("197 of 200").
        with mock.patch.object(tools_module, "CATALOG_SEARCH_MAX_RESULTS", 1):
            result = self.call("find_missing", USER_B, card_filter={"text": "pikachu"})
        self.assertTrue(result["total_is_lower_bound"])
        self.assertIsNone(result["cheapest_completion_usd"])
        self.assertIn("at least", result["note"])

    def test_set_and_language_filters(self) -> None:
        result = self.call("search_cards", card_filter={"set": "sv8"})
        self.assertEqual(self.ids(result["results"]), ["jp-1"])  # set code, any case
        result = self.call("search_cards", card_filter={"set": "Surging", "language": "Japanese"})
        self.assertEqual(result["results"], [])
        result = self.call("search_cards", card_filter={"set": "Surging Sparks", "rarity_bucket": ["sir"]})
        self.assertEqual(self.ids(result["results"]), ["ssp-1"])
        owned = self.call("search_cards", USER_B, card_filter={"set": "Surging Sparks"}, owned="not_owned")
        self.assertEqual(sorted(self.ids(owned["results"])), ["ssp-1", "ssp-2"])
        self.assertEqual(owned["total_estimate"], 2)


class WatchlistTests(McpToolsCase):
    def watch(self, owner, card_id, *, variant="", target_cents=None, created="2026-11-01T00:00:00Z"):
        self.conn.execute(
            "INSERT INTO card_favorites (owner_user_id, card_id, variant_key, created_at, target_price_cents) "
            "VALUES (?, ?, ?, ?, ?)",
            (owner, card_id, variant, created, target_cents),
        )
        self.conn.commit()

    def test_owner_scoped_newest_first_with_targets(self) -> None:
        self.watch(USER_A, "ssp-2", target_cents=650, created="2026-11-02T00:00:00Z")
        self.watch(USER_A, "ssp-1", variant="Holofoil", created="2026-11-01T00:00:00Z")
        self.watch(USER_B, "ssp-3")
        result = self.call("get_my_watchlist")
        self.assertEqual(self.ids(result["items"]), ["ssp-2", "ssp-1"])
        first, second = result["items"]
        self.assertEqual((first["target_price_usd"], first["watch_variant"], first["price_usd"]), (6.5, None, 8.0))
        self.assertEqual(first["watched_at"], "2026-11-02T00:00:00Z")
        self.assertIsNone(first["target_triggered_at"])
        self.assertEqual(second["watch_variant"], "Holofoil")
        self.assertIsNone(second["price_usd"])  # no stored cell for that printing: never the main price
        self.assertEqual(result["total_count"], 2)
        self.assertEqual(self.ids(self.call("get_my_watchlist", USER_B)["items"]), ["ssp-3"])
        self.assertEqual(self.call("get_my_watchlist", "user-c")["items"], [])

    def test_pages(self) -> None:
        for i, card_id in enumerate(("ssp-1", "ssp-2", "ssp-3")):
            self.watch(USER_A, card_id, created=f"2026-11-0{i + 1}T00:00:00Z")
        page = self.call("get_my_watchlist", limit=2)
        self.assertEqual(self.ids(page["items"]), ["ssp-3", "ssp-2"])
        rest = self.call("get_my_watchlist", limit=2, cursor=page["next_cursor"])
        self.assertEqual(self.ids(rest["items"]), ["ssp-1"])
        self.assertIsNone(rest["next_cursor"])
        with self.assertRaises(ToolInputError):
            self.call("get_my_watchlist", limit=101)


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


class RankingCorrectnessTests(McpToolsCase):
    """Owner chats 2026-11-18: One Piece missed (no game filter), sealed boxes in
    'priciest cards', Japanese Scrydex yen anchors topping price lists, and no
    graded ranking."""

    def setUp(self) -> None:
        super().setUp()
        env = mock.patch.dict("os.environ", {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"})
        env.start()
        self.addCleanup(env.stop)
        self.seed_ranking()

    def main_price(self, card_id, amount):
        self.price(card_id, amount)
        self.conn.execute(
            "UPDATE card_price_snapshots SET main_raw_market_price = ?, main_raw_updated_at = ? WHERE card_id = ?",
            (amount, utc_now(), card_id),
        )

    def game_card(self, card_id, name, game, *, supertype="Character", rarity="Super Rare", language="English",
                  set_name="Romance Dawn", set_code="OP01"):
        upsert_card(
            self.conn, card_id=card_id, name=name, set_name=set_name, number="1", rarity=rarity, variant="Raw",
            language=language, source_provider="scrydex", source_record_id=card_id, set_id=set_code.lower(),
            set_ptcgo_code=set_code, set_release_date="2022-12-02", artist=None, supertype=supertype,
            national_pokedex_numbers=[], image_url=None, source_payload={"id": card_id}, game=game,
        )

    def graded_cell(self, card_id, grader, grade, market, *, days_ago=0, currency="USD", signed=0):
        self.conn.execute(
            "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, variant_key, "
            "grader, grade, is_perfect, is_signed, is_error, currency_code, market, updated_at) "
            "VALUES (?, 'scrydex', ?, 'graded', ?, 'holofoil', ?, ?, 0, ?, 0, ?, ?, ?)",
            (card_id, _days_ago(days_ago), f"g|{grader}|{grade}|{signed}", grader, grade, signed, currency,
             market, utc_now()),
        )

    def seed_ranking(self) -> None:
        self.game_card("onepiece~OP01-001", "Monkey.D.Luffy", "onepiece")
        self.game_card("onepiece~OP01-002", "Roronoa Zoro", "onepiece")
        self.main_price("onepiece~OP01-001", 900.0)
        self.main_price("onepiece~OP01-002", 50.0)
        self.card("sv-fluffy", "Fluffy Berry", number="150", set_name="Paldea Evolved", set_code="PAL")
        self.main_price("sv-fluffy", 0.3)
        self.game_card("tcgp-sealed-513409", "151 Booster Bundle Display Case", "pokemon", supertype="Sealed",
                       rarity="Sealed", set_name="SV: Scarlet & Violet 151", set_code="MEW")
        self.main_price("tcgp-sealed-513409", 11999.95)
        # The known-bad Scrydex raw-JP anchor ($4,003 "USD") vs a TCGplayer-priced JP card.
        self.card("jp-entei", "Entei", number="105", language="Japanese", set_name="Unseen Forces JP",
                  set_code="PCG5")
        self.price("jp-entei", 4003.0)
        self.card("jp-tcg", "Lugia", number="9", language="Japanese", set_name="VSTAR Universe", set_code="S12A")
        self.main_price("jp-tcg", 300.0)
        self.conn.commit()

    # --- game ----------------------------------------------------------------

    def test_game_filter_finds_and_price_ranks_one_piece(self) -> None:
        priciest = self.call("search_cards", card_filter={"game": "One Piece"}, sort="price_desc")
        self.assertEqual(self.ids(priciest["results"]), ["onepiece~OP01-001", "onepiece~OP01-002"])
        cheapest = self.call("search_cards", card_filter={"game": "onepiece"}, sort="price_asc", limit=1)
        self.assertEqual(self.ids(cheapest["results"]), ["onepiece~OP01-002"])
        luffy = self.call("search_cards", card_filter={"text": "luffy", "game": "onepiece"})
        self.assertEqual(self.ids(luffy["results"]), ["onepiece~OP01-001"])
        # Without a game the catalog stays Pokémon: never a One Piece card.
        pokemon = self.call("search_cards", card_filter={}, sort="price_desc", limit=50)
        self.assertFalse(any(card_id.startswith("onepiece~") for card_id in self.ids(pokemon["results"])))

    def test_game_filter_on_missing_and_collection(self) -> None:
        missing = self.call("find_missing", card_filter={"game": "onepiece"})
        self.assertEqual(self.ids(missing["missing"]), ["onepiece~OP01-002", "onepiece~OP01-001"])
        self.holding("a-op", USER_A, "onepiece~OP01-001")
        self.conn.commit()
        mine = self.call("get_my_collection", card_filter={"game": "onepiece"})
        self.assertEqual(self.ids(mine["items"]), ["onepiece~OP01-001"])

    def test_filter_validation(self) -> None:
        from mcp_server.filters import normalize_card_filter

        self.assertEqual(normalize_card_filter({"game": "Disney Lorcana"}), {"game": "lorcana"})
        self.assertEqual(normalize_card_filter({"game": "any", "product": "any"}), {})
        self.assertEqual(normalize_card_filter({"text": "One Piece"}), {"game": "onepiece"})
        self.assertEqual(normalize_card_filter({"text": "luffy", "game": "onepiece"}),
                         {"text": "luffy", "game": "onepiece"})
        fluffy = self.call("search_cards", card_filter={"text": "One Piece"}, sort="price_desc")
        self.assertEqual(self.ids(fluffy["results"])[0], "onepiece~OP01-001")
        with self.assertRaises(ToolInputError):
            normalize_card_filter({"game": "magic"})
        with self.assertRaises(ToolInputError):
            normalize_card_filter({"product": "boxes"})
        with self.assertRaises(ToolInputError):
            self.call("search_cards", card_filter={"scene": ["beach"], "game": "onepiece"})

    # --- product -------------------------------------------------------------

    def test_product_default_any_single_and_sealed(self) -> None:
        both = self.call("search_cards", card_filter={}, sort="price_desc", limit=3)
        self.assertEqual(self.ids(both["results"])[0], "tcgp-sealed-513409")
        singles = self.call("search_cards", card_filter={"product": "single"}, sort="price_desc", limit=50)
        self.assertNotIn("tcgp-sealed-513409", self.ids(singles["results"]))
        self.assertEqual(self.ids(singles["results"])[0], "ssp-1")
        sealed = self.call("search_cards", card_filter={"product": "sealed"}, sort="price_desc")
        self.assertEqual(self.ids(sealed["results"]), ["tcgp-sealed-513409"])
        # Text search: sealed product joins card hits unless product=single.
        text_any = self.call("search_cards", card_filter={"text": "booster bundle"})
        self.assertIn("tcgp-sealed-513409", self.ids(text_any["results"]))
        text_single = self.call("search_cards", card_filter={"text": "booster bundle", "product": "single"})
        self.assertNotIn("tcgp-sealed-513409", self.ids(text_single["results"]))
        by_rarity = self.call("search_cards", card_filter={"rarity_bucket": ["other"], "product": "single"},
                              sort="price_desc")
        self.assertNotIn("tcgp-sealed-513409", self.ids(by_rarity["results"]))

    # --- Japanese prices -----------------------------------------------------

    def test_price_rankings_leave_out_japanese_unless_asked(self) -> None:
        priciest = self.call("search_cards", card_filter={"product": "single"}, sort="price_desc", limit=50)
        ids = self.ids(priciest["results"])
        self.assertFalse({"jp-entei", "jp-tcg", "jp-1"} & set(ids), ids)
        cheapest = self.call("search_cards", card_filter={"text": "lugia"}, sort="price_asc")
        self.assertNotIn("jp-tcg", self.ids(cheapest["results"]))
        japanese = self.call("search_cards", card_filter={"language": "Japanese"}, sort="price_desc")
        by_id = {item["card_id"]: item for item in japanese["results"]}
        self.assertEqual(self.ids(japanese["results"])[0], "jp-tcg")  # TCGplayer price ranks
        self.assertEqual(by_id["jp-tcg"]["price_usd"], 300.0)
        self.assertIsNone(by_id["jp-entei"]["price_usd"])  # Scrydex anchor: no fake number
        # Relevance search keeps Japanese cards (no ranking), and find_missing nulls the anchor.
        self.assertIn("jp-entei", self.ids(self.call("search_cards", card_filter={"text": "entei"})["results"]))
        missing = self.call("find_missing", card_filter={"set": "Unseen Forces JP"})
        self.assertIsNone(missing["missing"][0]["price_usd"])
        self.assertIsNone(missing["cheapest_completion_usd"])

    # --- graded --------------------------------------------------------------

    def seed_graded(self) -> None:
        self.graded_cell("ssp-1", "PSA", "10", 300.0)
        self.graded_cell("ssp-1", "CGC", "10", 350.0)
        self.graded_cell("ssp-1", "PSA", "10", 5000.0, signed=1)  # autograph premium: never ranks
        self.graded_cell("ssp-2", "PSA", "10", 500.0)
        self.graded_cell("ssp-3", "PSA", "9", 20.0)
        self.graded_cell("jp-1", "PSA", "10", 9000.0)
        self.graded_cell("ssp-4", "PSA", "10", 99999.0, days_ago=3, currency="JPY")
        from catalog_tools import replace_slab_recent_sales_cache

        replace_slab_recent_sales_cache(
            self.conn, card_id="ssp-1", grader="PSA", grade="10", source="ebay",
            sales=[{"sourceSaleID": "s1", "title": "Pikachu ex 238 PSA 10", "price": 700.0, "currencyCode": "USD",
                    "soldAt": _days_ago(5)}],
        )
        self.conn.commit()

    def test_top_graded_uses_last_sale_then_scrydex_and_skips_japanese(self) -> None:
        self.seed_graded()
        result = self.call("find_top_graded")
        cards = result["cards"]
        self.assertEqual(self.ids(cards), ["ssp-1", "ssp-2", "ssp-3"])
        top = cards[0]
        self.assertEqual((top["grader"], top["grade"], top["graded_price_usd"], top["price_source"]),
                         ("PSA", "10", 700.0, "ebay_sold"))
        self.assertEqual(top["price_usd"], 700.0)
        self.assertEqual(top["price_basis"], "graded")
        self.assertEqual((cards[1]["graded_price_usd"], cards[1]["price_source"]), (500.0, "scrydex"))
        cgc = self.call("find_top_graded", grader="cgc", grade="10.0")
        self.assertEqual([(c["card_id"], c["graded_price_usd"]) for c in cgc["cards"]], [("ssp-1", 350.0)])
        japanese = self.call("find_top_graded", card_filter={"language": "Japanese"})
        self.assertEqual(self.ids(japanese["cards"]), ["jp-1"])
        self.assertEqual(self.ids(self.call("find_top_graded", owned="owned")["cards"]), ["ssp-1", "ssp-2", "ssp-3"])
        self.assertEqual(self.ids(self.call("find_top_graded", USER_B, owned="owned")["cards"]), ["ssp-3"])
        none = self.call("find_top_graded", card_filter={"game": "riftbound"})
        self.assertEqual(none["cards"], [])
        self.assertIn("no graded prices", none["note"])
        with self.assertRaises(ToolInputError):
            self.call("find_top_graded", grade="10")

    def test_top_graded_falls_back_to_snapshot_contexts_without_fresh_cells(self) -> None:
        import json

        self.graded_cell("ssp-2", "PSA", "10", 500.0, days_ago=30)  # stale: staging writes none
        contexts = {"graders": {"PSA": {"10": [{"market": 250.0, "currencyCode": "USD", "variant": "Holofoil"},
                                                {"market": 9000.0, "isSigned": True}]}}}
        self.conn.execute("UPDATE card_price_snapshots SET graded_contexts_json = ? WHERE card_id = 'ssp-1'",
                          (json.dumps(contexts),))
        self.conn.commit()
        cards = self.call("find_top_graded")["cards"]
        self.assertEqual([(c["card_id"], c["graded_price_usd"], c["price_source"]) for c in cards],
                         [("ssp-1", 250.0, "scrydex")])
        self.assertEqual(cards[0]["variant"], "Holofoil")

    def test_top_graded_applies_the_card_filter_before_ranking(self) -> None:
        self.seed_graded()
        charizard = self.call("find_top_graded", card_filter={"text": "charizard"}, grader="PSA", grade="10")
        self.assertEqual(self.ids(charizard["cards"]), ["ssp-2"])
        # A name scope reaches cards past the whole-game candidate cap (it used to filter after it).
        with mock.patch.object(tools_module, "GRADED_CANDIDATE_ROWS", 1):
            eevee = self.call("find_top_graded", card_filter={"text": "eevee"})
            self.assertEqual(self.ids(eevee["cards"]), ["ssp-3"])
            by_set_number = self.call("find_top_graded", card_filter={"text": "surging 238"}, grader="PSA", grade="10")
            self.assertEqual(self.ids(by_set_number["cards"]), ["ssp-1"])
        nothing = self.call("find_top_graded", card_filter={"text": "zzznomatch"})
        self.assertEqual(nothing["cards"], [])
        self.assertNotIn("excluded_stale_count", nothing)

    def test_top_graded_stale_count_is_scoped_to_the_filter(self) -> None:
        import json

        contexts = json.dumps({"graders": {"PSA": {"10": [{"market": 250.0, "currencyCode": "USD"}]}}})
        old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        self.conn.execute(
            "UPDATE card_price_snapshots SET graded_contexts_json = ?, updated_at = ? "
            "WHERE card_id IN ('ssp-1', 'ssp-2')",
            (contexts, old),
        )
        self.conn.execute(
            "UPDATE card_price_snapshots SET graded_contexts_json = ? WHERE card_id = 'ssp-3'", (contexts,)
        )
        self.conn.commit()
        charizard = self.call("find_top_graded", card_filter={"text": "charizard"}, grader="PSA", grade="10")
        self.assertEqual(charizard["cards"], [])
        self.assertEqual(charizard["excluded_stale_count"], 1)  # ssp-2 only, not every stale card
        self.assertIn("older than 14 days", charizard["note"])
        eevee = self.call("find_top_graded", card_filter={"text": "eevee"}, grader="PSA", grade="10")
        self.assertEqual(self.ids(eevee["cards"]), ["ssp-3"])
        self.assertNotIn("excluded_stale_count", eevee)
        # Whole game: only fresh snapshots are read; the fresh card ranks, stale ones never do.
        whole = self.call("find_top_graded", grader="PSA", grade="10")
        self.assertEqual(self.ids(whole["cards"]), ["ssp-3"])
        self.conn.execute("UPDATE card_price_snapshots SET updated_at = ? WHERE card_id = 'ssp-3'", (old,))
        self.conn.commit()
        stale_game = self.call("find_top_graded", grader="PSA", grade="10")
        self.assertEqual(stale_game["cards"], [])
        self.assertIn("older than 14 days", stale_game["note"])

    def test_tier_exposure_and_strict_budget(self) -> None:
        from mcp_server.assistant.tools import TOOL_DEFINITIONS
        from mcp_server.policy import PUBLIC_POLICY, USER_POLICY

        self.assertTrue(USER_POLICY.allows_tool("find_top_graded"))
        self.assertFalse(PUBLIC_POLICY.allows_tool("find_top_graded"))
        self.seed_graded()
        shaped_user = USER_POLICY.shape(self.call("find_top_graded"))
        self.assertEqual(shaped_user["cards"][0]["graded_price_usd"], 700.0)
        shaped_public = PUBLIC_POLICY.shape(self.call("find_top_graded"))
        self.assertNotIn("graded_price_usd", shaped_public["cards"][0])
        self.assertNotIn("price_usd", shaped_public["cards"][0])
        by_name = {tool["name"]: tool for tool in TOOL_DEFINITIONS}
        self.assertFalse(by_name["find_top_graded"].get("strict"))  # takes a CardFilter
        strict = [tool for tool in TOOL_DEFINITIONS if tool.get("strict")]
        optional = sum(len(set(t["input_schema"]["properties"]) - set(t["input_schema"]["required"])) for t in strict)
        self.assertLessEqual(optional, 24)
        filter_props = by_name["search_cards"]["input_schema"]["properties"]["filter"]["properties"]
        self.assertIn("onepiece", filter_props["game"]["enum"])
        self.assertEqual(filter_props["product"]["enum"], ["any", "single", "sealed"])


if __name__ == "__main__":
    unittest.main()
