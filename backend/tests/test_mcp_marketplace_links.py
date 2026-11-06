"""Parity tests for backend/mcp_server/marketplace_links.py.

Expected URLs mirror apps/spotlight-rn/__tests__/features/cards/marketplace-urls-test.ts
(the raw-card cases) so the Python port and the TS stay byte-identical.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from mcp_server.marketplace_links import (  # noqa: E402
    buy_links,
    ebay_search_url,
    tcgplayer_product_id_from_card_id,
    tcgplayer_product_url,
    tcgplayer_search_url,
)

_CONFIG_KEYS = (
    "SPOTLIGHT_TCGPLAYER_AFFILIATE_BASE_URL",
    "EXPO_PUBLIC_TCGPLAYER_AFFILIATE_BASE_URL",
    "SPOTLIGHT_EBAY_EPN_CAMPAIGN_ID",
    "EXPO_PUBLIC_EBAY_EPN_CAMPAIGN_ID",
    "SPOTLIGHT_EBAY_EPN_ROTATION_ID",
    "EXPO_PUBLIC_EBAY_EPN_ROTATION_ID",
)


def _clean_env():
    env = {k: v for k, v in os.environ.items() if k not in _CONFIG_KEYS}
    return mock.patch.dict(os.environ, env, clear=True)


def _q(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


def _tcg(set_name: str, name: str, number: str, **kw) -> str | None:
    return tcgplayer_search_url(name=name, set_name=set_name, card_number=number, **kw)


def _ebay(set_name: str, name: str, number: str, **kw) -> str | None:
    return ebay_search_url(name=name, set_name=set_name, card_number=number, **kw)


class _CleanEnvCase(unittest.TestCase):
    def setUp(self) -> None:
        patcher = _clean_env()
        patcher.start()
        self.addCleanup(patcher.stop)


class TcgPlayerSearchUrlTests(_CleanEnvCase):
    def test_rare_candy_format_with_apostrophe(self):
        self.assertEqual(
            _tcg("Gym Heroes", "Sabrina's Slowbro", "60/132"),
            "https://www.tcgplayer.com/search/all/product?q=pokemon+gym+heroes+sabrina's+slowbro+60/132&view=grid",
        )

    def test_strips_accents_and_dedupes_pokemon_prefix(self):
        self.assertEqual(
            _tcg("Pokémon Card 151", "Mega Charizard X ex", "110/080"),
            "https://www.tcgplayer.com/search/all/product?q=pokemon+card+151+mega+charizard+x+ex+110/080&view=grid",
        )

    def test_number_slash_and_hash(self):
        url = _tcg("Base Set", "Charizard", "#4/102")
        self.assertIn("charizard+4/102", url)
        self.assertNotIn("4%2F102", url)
        self.assertRegex(_tcg("Jungle", "Scyther", "10/64"), r"q=pokemon\+jungle\+scyther\+10/64")

    def test_empty_and_whitespace_return_none(self):
        self.assertIsNone(_tcg("", "", ""))
        self.assertIsNone(_tcg("  ", "  ", " "))
        self.assertIsNone(_tcg("", "", "", game="onepiece"))
        self.assertIsNone(_tcg(" ", " ", " ", game="lorcana"))
        self.assertIn("pokemon+pikachu", _tcg("", "Pikachu", ""))

    def test_condition_filters(self):
        for code, label in (
            ("Near Mint", "Near+Mint"),
            ("NM", "Near+Mint"),
            ("LP", "Lightly+Played"),
            ("MP", "Moderately+Played"),
            ("HP", "Heavily+Played"),
            ("D", "Damaged"),
            ("near_mint", "Near+Mint"),
            ("lightly_played", "Lightly+Played"),
        ):
            self.assertIn(f"&Condition={label}", _tcg("Base Set", "Charizard", "4/102", condition=code))
        for code in ("Brand New", None):
            self.assertNotIn("Condition=", _tcg("Base Set", "Charizard", "4/102", condition=code))

    def test_printing_filters(self):
        for printing, label in (
            ("Holofoil", "Holofoil"),
            ("Normal", "Normal"),
            ("Reverse Holofoil", "Reverse+Holofoil"),
            ("First Edition Holofoil", "1st+Edition+Holofoil"),
            ("reverse_holo", "Reverse+Holofoil"),
        ):
            self.assertIn(f"&Printing={label}", _tcg("Base Set", "Charizard", "4/102", printing=printing))
        self.assertNotIn("Printing=", _tcg("Base Set", "Charizard", "4/102", printing="Cosmos Holo"))
        self.assertIn(
            "&Condition=Near+Mint&Printing=Holofoil",
            _tcg("Base Set", "Charizard", "4/102", condition="Near Mint", printing="Holofoil"),
        )

    def test_glyphs(self):
        self.assertIn("aerodactyl+delta+species", _tcg("EX Delta Species", "Aerodactyl δ", "1/113"))
        self.assertIn("arceus+prism+star", _tcg("Ultra Prism", "Arceus ◇", "95/156"))
        self.assertIn("alakazam+gold+star", _tcg("EX Team Rocket Returns", "Alakazam ★", "108/109"))
        self.assertIn("nidoran+male", _tcg("Gym Challenge", "Nidoran ♂", "83/132"))
        self.assertIn("q=pokemon+promo+cafe+master+1", _tcg("Promo", "Café Master", "1"))
        # Curly apostrophe → straight, kept unencoded.
        self.assertIn("sabrina's+slowbro", _tcg("Gym Heroes", "Sabrina’s Slowbro", "60/132"))

    def test_game_scoping(self):
        url = _tcg("The Time Of Battle", "Portgas.D.Ace", "OP16-001", game="onepiece")
        self.assertNotIn("pokemon", url)
        self.assertIn("q=one+piece+the+time+of+battle+portgas+d+ace+op16+001", url)
        for game in ("lorcana", "riftbound", "gundam"):
            self.assertIn(f"q={game}+some+set+some+card+001", _tcg("Some Set", "Some Card", "001", game=game))
        url = _tcg("One Piece Card Game Romance Dawn", "Monkey.D.Luffy", "OP01-001", game="onepiece")
        self.assertIn("q=one+piece+card+game+romance+dawn", url)
        self.assertEqual(url.count("one+piece"), 1)


class TcgPlayerProductUrlTests(_CleanEnvCase):
    def test_product_urls(self):
        self.assertEqual(tcgplayer_product_url("12345"), "https://www.tcgplayer.com/product/12345")
        self.assertEqual(
            tcgplayer_product_url("12345", condition="Near Mint"),
            "https://www.tcgplayer.com/product/12345?Condition=Near+Mint",
        )
        self.assertEqual(
            tcgplayer_product_url("12345", condition="lightly_played"),
            "https://www.tcgplayer.com/product/12345?Condition=Lightly+Played",
        )
        self.assertEqual(
            tcgplayer_product_url("12345", condition="Brand New"), "https://www.tcgplayer.com/product/12345"
        )
        self.assertIsNone(tcgplayer_product_url(""))
        self.assertIsNone(tcgplayer_product_url("   "))

    def test_product_id_from_card_id(self):
        self.assertEqual(tcgplayer_product_id_from_card_id("tcgplayer-552137"), "552137")
        self.assertEqual(tcgplayer_product_id_from_card_id("onepiece~tcgplayer-552137"), "552137")
        self.assertIsNone(tcgplayer_product_id_from_card_id("base1-4"))
        self.assertIsNone(tcgplayer_product_id_from_card_id(None))


class TcgPlayerAffiliateTests(_CleanEnvCase):
    BASE = "https://tcgplayer.pxf.io/c/1234567/1780961/21018"

    def test_blank_or_non_https_base_is_absent(self):
        untagged = "https://www.tcgplayer.com/product/42382"
        for value in ("   ", "http://tcgplayer.pxf.io/c/1/2/3", "not a url"):
            with mock.patch.dict(os.environ, {"EXPO_PUBLIC_TCGPLAYER_AFFILIATE_BASE_URL": value}):
                self.assertEqual(tcgplayer_product_url("42382"), untagged)
            self.assertEqual(tcgplayer_product_url("42382", affiliate_base_url=value), untagged)

    def test_wraps_destination_when_configured(self):
        untagged_search = _tcg("Base Set", "Charizard", "4/102")
        for env_key in ("SPOTLIGHT_TCGPLAYER_AFFILIATE_BASE_URL", "EXPO_PUBLIC_TCGPLAYER_AFFILIATE_BASE_URL"):
            with mock.patch.dict(os.environ, {env_key: f"{self.BASE}/"}):
                product = tcgplayer_product_url("42382", condition="NM")
                self.assertEqual(
                    product,
                    f"{self.BASE}?u=https%3A%2F%2Fwww.tcgplayer.com%2Fproduct%2F42382%3FCondition%3DNear%2BMint",
                )
                self.assertEqual(
                    _q(product)["u"], "https://www.tcgplayer.com/product/42382?Condition=Near+Mint"
                )
                search = _tcg("Base Set", "Charizard", "4/102")
                self.assertTrue(search.startswith(f"{self.BASE}?u="))
                self.assertEqual(_q(search)["u"], untagged_search)
        # Explicit argument works without env.
        self.assertTrue(tcgplayer_product_url("1", affiliate_base_url=self.BASE).startswith(self.BASE + "?u="))


class EbaySearchUrlTests(_CleanEnvCase):
    def test_raw_sold_url_exact(self):
        self.assertEqual(
            _ebay("Base Set", "Charizard", "4/102"),
            "https://www.ebay.com/sch/i.html?_nkw=Charizard+4%2F102+Base+Set&LH_Sold=1&LH_Complete=1&_sop=13",
        )

    def test_active_listings(self):
        url = _ebay("Base Set", "Charizard", "4/102", listing_type="active")
        self.assertEqual(url, "https://www.ebay.com/sch/i.html?_nkw=Charizard+4%2F102+Base+Set&_sop=15")
        self.assertNotIn("LH_Sold", url)
        self.assertNotIn("LH_Complete", url)

    def test_collector_number_dezeroed_fraction(self):
        self.assertEqual(_q(_ebay("Promo", "Pikachu", "004/020"))["_nkw"], "Pikachu 4/20 Promo")
        self.assertEqual(_q(_ebay("XY Promos", "Ditto", "#XY177"))["_nkw"], "Ditto XY177 XY Promos")

    def test_japanese_keyword(self):
        nkw = _q(_ebay("ポケモン", "Growlithe", "004/020", language="Japanese"))["_nkw"]
        self.assertEqual(nkw, "Growlithe Japanese 4/20")

    def test_graded_drops_number_and_keeps_half_grade(self):
        self.assertEqual(
            _q(_ebay("Obsidian Flames", "Charizard ex", "125/197", grader="PSA", grade="10"))["_nkw"],
            "PSA 10 Charizard ex Obsidian Flames",
        )
        url = _ebay("XY Promos", "Ditto", "XY177", grader="CGC", grade="9.5")
        self.assertIn("_nkw=CGC+9.5+Ditto", url)

    def test_glyphs_and_accents(self):
        url = _ebay("EX Delta Species", "Aerodactyl δ", "1/113")
        self.assertIn("Aerodactyl+Delta+Species", url)
        self.assertNotIn("%CE%B4", url)
        url = _ebay("Ultra Prism", "Arceus ◇", "95/156")
        self.assertIn("Arceus+Prism+Star", url)
        url = _ebay("EX Team Rocket Returns", "Alakazam ☆", "108/109")
        self.assertIn("Alakazam+Gold+Star", url)
        self.assertNotIn("%E2%98%86", url)
        self.assertIn("Alakazam+Gold+Star", _ebay("EX Team Rocket Returns", "Alakazam ★", "108/109"))
        self.assertIn("Nidoran+Male", _ebay("Gym Challenge", "Giovanni's Nidoran ♂", "83/132"))
        url = _ebay("Promo", "Café Master", "1")
        self.assertIn("Cafe", url)
        self.assertNotIn("%C3%A9", url)

    def test_game_keyword(self):
        url = _ebay("Romance Dawn", "Monkey.D.Luffy", "OP01-001", game="onepiece")
        self.assertEqual(_q(url)["_nkw"], "one piece Monkey D Luffy OP01 001 Romance Dawn")
        self.assertEqual(_ebay("Base Set", "Charizard", "4/102", game="pokemon"), _ebay("Base Set", "Charizard", "4/102"))

    def test_empty_returns_none(self):
        self.assertIsNone(_ebay("", "", ""))


class EbayEpnTests(_CleanEnvCase):
    def test_blank_campaign_is_absent(self):
        untagged = _ebay("Base Set", "Charizard", "4/102")
        with mock.patch.dict(os.environ, {"EXPO_PUBLIC_EBAY_EPN_CAMPAIGN_ID": "   "}):
            self.assertEqual(_ebay("Base Set", "Charizard", "4/102", epn_custom_id="pdp_recent_sales"), untagged)

    def test_tags_url_when_configured(self):
        with mock.patch.dict(os.environ, {"EXPO_PUBLIC_EBAY_EPN_CAMPAIGN_ID": "5338999999"}):
            url = _ebay("Base Set", "Charizard", "4/102")
        self.assertEqual(
            url,
            "https://www.ebay.com/sch/i.html?_nkw=Charizard+4%2F102+Base+Set&LH_Sold=1&LH_Complete=1&_sop=13"
            "&mkevt=1&mkcid=1&mkrid=711-53200-19255-0&campid=5338999999&toolid=10001",
        )
        self.assertNotIn("customid", url)

    def test_rotation_custom_id_and_explicit_args(self):
        url = _ebay(
            "Base Set",
            "Charizard",
            "4/102",
            listing_type="active",
            epn_campaign_id="5338999999",
            epn_rotation_id="710-53481-19255-0",
            epn_custom_id=" pdp recent/sales! ",
        )
        q = _q(url)
        self.assertEqual(q["mkrid"], "710-53481-19255-0")
        self.assertEqual(q["customid"], "pdp-recent-sales")
        self.assertEqual(q["_sop"], "15")
        self.assertNotIn("LH_Sold", q)
        with mock.patch.dict(
            os.environ,
            {"SPOTLIGHT_EBAY_EPN_CAMPAIGN_ID": "111", "EXPO_PUBLIC_EBAY_EPN_CAMPAIGN_ID": "222"},
        ):
            self.assertEqual(_q(_ebay("Base Set", "Charizard", "4/102"))["campid"], "111")


class BuyLinksTests(_CleanEnvCase):
    CARD = {
        "id": "base1-4",
        "name": "Charizard",
        "setName": "Base Set",
        "number": "4/102",
        "language": "English",
        "game": "pokemon",
    }

    def test_raw_with_product_id(self):
        self.assertEqual(
            buy_links(self.CARD, tcgplayer_product_id="42382"),
            {
                "tcgplayer": "https://www.tcgplayer.com/product/42382?Condition=Near+Mint",
                "ebay": "https://www.ebay.com/sch/i.html?_nkw=Charizard+4%2F102+Base+Set&_sop=15",
            },
        )

    def test_raw_search_fallback_and_card_id_product(self):
        links = buy_links(self.CARD, tcgplayer_product_id=None)
        self.assertEqual(
            links["tcgplayer"],
            "https://www.tcgplayer.com/search/all/product?q=pokemon+base+set+charizard+4/102&view=grid&Condition=Near+Mint",
        )
        links = buy_links({**self.CARD, "id": "onepiece~tcgplayer-552137", "game": "onepiece"}, tcgplayer_product_id=None)
        self.assertEqual(links["tcgplayer"], "https://www.tcgplayer.com/product/552137?Condition=Near+Mint")
        self.assertIn("_nkw=one+piece+Charizard", links["ebay"])

    def test_epn_custom_id_and_sold_option(self):
        with mock.patch.dict(os.environ, {"SPOTLIGHT_EBAY_EPN_CAMPAIGN_ID": "5338999999"}):
            links = buy_links(self.CARD, tcgplayer_product_id=None)
        self.assertEqual(_q(links["ebay"])["customid"], "mcp")
        sold = buy_links(self.CARD, tcgplayer_product_id=None, ebay_listing_type="sold")["ebay"]
        self.assertIn("LH_Sold=1", sold)

    def test_graded_has_no_tcgplayer(self):
        links = buy_links(self.CARD, tcgplayer_product_id="42382", grader="PSA", grade="10")
        self.assertEqual(set(links), {"ebay"})
        self.assertEqual(_q(links["ebay"])["_nkw"], "PSA 10 Charizard Base Set")

    def test_empty_card(self):
        self.assertEqual(buy_links({}, tcgplayer_product_id=None), {})


if __name__ == "__main__":
    unittest.main()
