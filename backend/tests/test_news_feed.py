"""news_feed: RSS/Atom parsing, thumbnails, the Polygon/Dexerto TCG keyword
filter, dedupe, conditional GET, failure isolation, retention, the set/card/game
tagger (incl. the ambiguous one-word-set rule), and the NewsFeed payload +
cursor. All feeds are fixture files; nothing here touches the network.
"""

from __future__ import annotations

import logging
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import news_feed as nf  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_card, upsert_expansion  # noqa: E402

FIXTURES = BACKEND_ROOT / "tests" / "fixtures" / "news"
NOW = datetime(2026, 9, 24, 3, 0, tzinfo=timezone.utc)

FIXTURE_BY_SOURCE = {
    "pokebeach": "pokebeach_front_page.rss.xml",
    "onepiece_gg": "onepiece_gg_news.rss.xml",
    "polygon_pokemon": "polygon_pokemon.rss.xml",
    "dexerto_pokemon": "dexerto_pokemon.rss.xml",
    "tcgplayer_price_trends": "tcgplayer_price_trends.rss.xml",
    "elitefourum_top_weekly": "elitefourum_top_weekly.rss.xml",
}


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


class FakeFetcher:
    """url → FetchResponse; unknown urls 404. Records every request's headers."""

    def __init__(self, responses: dict[str, nf.FetchResponse]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, url: str, headers):
        self.calls.append((url, dict(headers)))
        response = self.responses.get(url)
        if isinstance(response, Exception):
            raise response
        return response or nf.FetchResponse(404)


def source(key: str) -> nf.NewsSource:
    return next(s for s in nf.NEWS_SOURCES if s.key == key)


def fixture_fetcher(**overrides) -> FakeFetcher:
    responses = {
        source(key).url: nf.FetchResponse(200, fixture_bytes(name), {})
        for key, name in FIXTURE_BY_SOURCE.items()
    }
    for key, response in overrides.items():
        responses[source(key).url] = response
    return FakeFetcher(responses)


class CatalogTestCase(unittest.TestCase):
    def setUp(self) -> None:
        # Unregistered fixture sources 404 on purpose; assertLogs re-enables where asserted.
        news_logger = logging.getLogger("spotlight.news_feed")
        previous_level = news_logger.level
        news_logger.setLevel(logging.ERROR)
        self.addCleanup(news_logger.setLevel, previous_level)
        tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(tempdir.cleanup)
        self.connection = connect(Path(tempdir.name) / "news.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        nf.ensure_schema(self.connection)
        self._seed_catalog()
        self.connection.commit()

    def _expansion(self, set_id, name, *, game="pokemon", code=None, series=None,
                   language="English", release="2024/11/08", payload=None):
        upsert_expansion(self.connection, expansion_id=set_id, name=name, series=series, code=code,
                         language=language, release_date=release, game=game, source_payload=payload)

    def _card(self, card_id, name, number, set_id, set_name, *, game="pokemon"):
        upsert_card(self.connection, card_id=card_id, name=name, set_name=set_name, number=number,
                    rarity="Rare", variant="normal", language="English", game=game, set_id=set_id)

    def _seed_catalog(self) -> None:
        self._expansion("sv8", "Surging Sparks", code="SSP", series="Scarlet & Violet")
        self._expansion("sv8pt5", "Prismatic Evolutions", code="PRE", series="Scarlet & Violet")
        self._expansion("xy12", "Evolutions", code="EVO", series="XY", release="2016/11/02")
        self._expansion("base1", "Base", series="Base", release="1999/01/09")
        self._expansion("base2", "Jungle", series="Base", release="1999/06/16")
        self._expansion("base3", "Fossil", series="Base", release="1999/10/10")
        self._expansion("me1", "Mega Evolution", code="MEG", series="Mega Evolution", release="2025/09/26")
        self._expansion("me30", "30th Celebration", code="M30", series="Mega Evolution", release="2026/09/16")
        self._expansion("m4_ja", "ニンジャスピナー", code="M4", series="Mega Evolution", language="Japanese",
                        release="2026/03/13", payload={"translation": {"en": {"name": "Ninja Spinner"}}})
        self._expansion("onepiece~OP16", "The Time Of Battle", game="onepiece", code="OP16",
                        release="2026/06/12")
        self._card("sv8-57", "Pikachu ex", "57/191", "sv8", "Surging Sparks")
        self._card("sv8-238", "Pikachu ex", "238/191", "sv8", "Surging Sparks")
        self._card("sv8-60", "Pikachu", "60/191", "sv8", "Surging Sparks")
        self._card("base1-4", "Charizard", "4/102", "base1", "Base")
        self._card("onepiece~OP16-001", "Portgas.D.Ace", "OP16-001", "onepiece~OP16", "The Time Of Battle",
                   game="onepiece")

    def rows(self, where: str = "", params=()):
        return self.connection.execute(
            f"SELECT id, kind, source, title, url, image_url, published_at, game, set_id, card_ids, tags, "
            f"source_key FROM news_items {where} ORDER BY published_at DESC",
            params,
        ).fetchall()


# --- parsing -------------------------------------------------------------------


class ParseTests(unittest.TestCase):
    def test_rss_items_titles_dates_and_content_image(self) -> None:
        entries = nf.parse_feed(fixture_bytes("pokebeach_front_page.rss.xml"))
        self.assertEqual(len(entries), 5)
        first = entries[0]
        self.assertTrue(first.title.startswith("“30th Celebration” Pull Rates"))
        self.assertEqual(first.published_at, datetime(2026, 9, 24, 0, 16, 9, tzinfo=timezone.utc))
        self.assertTrue(first.url.startswith("https://www.pokebeach.com/forums/threads/"))
        self.assertLessEqual(len(first.summary), nf.SUMMARY_CHARS)
        self.assertNotIn("<", first.summary)
        # third item: first <img> in content:encoded
        self.assertEqual(entries[2].image_url, "https://www.pokebeach.com/news/2026/09/ME06_EN_23_webp-143x200.jpg")

    def test_atom_youtube_entries(self) -> None:
        entries = nf.parse_feed(fixture_bytes("youtube_channel_pokerev.atom.xml"))
        self.assertEqual([e.video_id for e in entries], ["aBcDeFgHiJ1", "kLmNoPqRsT2"])
        self.assertEqual(entries[0].url, "https://www.youtube.com/watch?v=aBcDeFgHiJ1")
        self.assertEqual(entries[0].image_url, "https://i2.ytimg.com/vi/aBcDeFgHiJ1/hqdefault.jpg")
        self.assertEqual(entries[0].view_count, 184230)
        self.assertEqual(entries[0].channel_title, "PokeRev")
        self.assertEqual(entries[0].published_at, datetime(2026, 9, 22, 19, 0, 7, tzinfo=timezone.utc))

    def test_thumbnail_sources(self) -> None:
        polygon = nf.parse_feed(fixture_bytes("polygon_pokemon.rss.xml"))
        self.assertTrue(polygon[0].image_url.endswith("jirachi_pokemon_anime_103017.jpg"))  # <enclosure>
        dexerto = nf.parse_feed(fixture_bytes("dexerto_pokemon.rss.xml"))
        self.assertIn("avery-the-pokekid-last-pulls.jpg", dexerto[0].image_url)  # media:thumbnail
        self.assertNotIn("&amp;", dexerto[0].image_url)
        tcgplayer = nf.parse_feed(fixture_bytes("tcgplayer_price_trends.rss.xml"))
        # entity-escaped <img> inside <description>
        self.assertTrue(tcgplayer[0].image_url.startswith("https://seller.tcgplayer.com/hubfs/"))
        onepiece = nf.parse_feed(fixture_bytes("onepiece_gg_news.rss.xml"))
        # DotGG's first <img> is its source logo; the real thumbnail is next
        self.assertTrue(onepiece[0].image_url.endswith("thumbnail_03.webp"))
        elite = nf.parse_feed(fixture_bytes("elitefourum_top_weekly.rss.xml"))
        self.assertTrue(elite[1].image_url.startswith("https://efour.b-cdn.net/uploads/"))

    def test_media_content_relative_and_protocol_relative_images(self) -> None:
        body = b"""<?xml version="1.0"?>
        <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
          <item><title>A</title><link>https://example.com/a</link>
            <media:content url="https://cdn.example.com/a.jpg" medium="image"/></item>
          <item><title>B</title><link>https://example.com/posts/b</link>
            <description>&lt;p&gt;x&lt;img src="/img/b.png"&gt;&lt;/p&gt;</description></item>
          <item><title>C</title><link>https://example.com/c</link>
            <description><![CDATA[<img src="//cdn.example.com/c.webp?w=1&amp;h=2">]]></description></item>
          <item><title>No link</title></item>
        </channel></rss>"""
        entries = nf.parse_feed(body)
        self.assertEqual([e.image_url for e in entries], [
            "https://cdn.example.com/a.jpg",
            "https://example.com/img/b.png",
            "https://cdn.example.com/c.webp?w=1&h=2",
        ])

    def test_unparseable_and_unsupported_feeds_raise_value_error(self) -> None:
        with self.assertRaises(ValueError):
            nf.parse_feed(b"<html><body>Just a moment...</body></html>")
        with self.assertRaises(ValueError):
            nf.parse_feed(b"not xml at all")

    def test_canonical_url_and_stable_id(self) -> None:
        a = nf.canonical_url("http://Example.com/post?utm_source=rss&utm_medium=feed&id=3#comments")
        self.assertEqual(a, "https://example.com/post?id=3")
        self.assertEqual(nf.news_item_id("https://example.com/post?id=3&utm_campaign=x"),
                         nf.news_item_id("https://example.com/post?id=3"))
        self.assertEqual(nf.canonical_url("https://youtu.be/abc123"), "https://www.youtube.com/watch?v=abc123")
        self.assertEqual(nf.canonical_url("https://m.youtube.com/watch?v=abc123&t=30"),
                         "https://www.youtube.com/watch?v=abc123")


# --- keyword filter / game / tags --------------------------------------------------


class FilterAndTagTests(unittest.TestCase):
    def test_keyword_filter_keeps_tcg_items_only(self) -> None:
        polygon = [e.title for e in nf.parse_feed(fixture_bytes("polygon_pokemon.rss.xml"))
                   if nf.passes_keyword_filter(e)]
        self.assertEqual(len(polygon), 2)
        self.assertFalse(any("Hytale" in t or "GOTY" in t for t in polygon))
        dexerto = [e.title for e in nf.parse_feed(fixture_bytes("dexerto_pokemon.rss.xml"))
                   if nf.passes_keyword_filter(e)]
        self.assertEqual(dexerto, ["Avery The Poke Kid’s final Pokemon pack opening shared after death"])

    def test_detect_game(self) -> None:
        self.assertEqual(nf.detect_game("lorcana", "Pokémon crossover?"), "lorcana")  # source wins
        self.assertEqual(nf.detect_game(None, "Price Trends", categories=["#One Piece", "#finance"]), "onepiece")
        self.assertEqual(nf.detect_game(None, "Price Trends: Pokémon Cards Climbing"), "pokemon")
        self.assertIsNone(nf.detect_game(None, "Price Trends: Yu-Gi-Oh! Cards Climbing"))
        self.assertIsNone(nf.detect_game(None, "Pokémon vs One Piece: which sold more?"))

    def test_tags(self) -> None:
        self.assertEqual(nf.tags_for("Two cards banned in One Piece", "news"), ["Ban list"])
        self.assertEqual(nf.tags_for("20+ “Delta Reign” Card Images Revealed!", "news"), ["Set reveal"])
        self.assertEqual(nf.tags_for("Price Trends: One Piece Cards Climbing in Price", "market"), ["Market"])
        self.assertIn("Pull rates", nf.tags_for("“30th Celebration” Pull Rates", "news"))
        self.assertLessEqual(len(nf.tags_for("Banned! Revealed prices, pull rates, PSA promo restock", "news")),
                             nf.MAX_TAGS)
        self.assertNotIn("Ban list", nf.tags_for("Mercari Targets Scalpers By Banning Listings", "news"))


class TaggerTests(CatalogTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.index = nf.build_set_aliases(self.connection)

    def tag(self, title, summary="", game="pokemon"):
        return nf.tag_entry(self.connection, self.index, title=title, summary=summary, source_game=game)

    def test_quoted_name_is_high_confidence(self) -> None:
        result = self.tag("Heat Rotom ex and More English Cards Revealed from “Surging Sparks!”")
        self.assertEqual((result.set_id, result.confidence), ("sv8", nf.CONFIDENCE_QUOTED))

    def test_unquoted_multi_word_name(self) -> None:
        result = self.tag("Best cards to pull from Surging Sparks")
        self.assertEqual((result.set_id, result.confidence), ("sv8", nf.CONFIDENCE_NAME))

    def test_longest_match_wins(self) -> None:
        self.assertEqual(self.tag("Prismatic Evolutions restock at Target").set_id, "sv8pt5")

    def test_single_word_name_needs_game_keyword_or_quotes(self) -> None:
        self.assertIsNone(self.tag("Fossil hunting season opens").set_id)
        self.assertIsNone(self.tag("Evolutions of the meta").set_id)
        keyword = self.tag("Pokémon Fossil holos are climbing")
        self.assertEqual((keyword.set_id, keyword.confidence), ("base3", nf.CONFIDENCE_SINGLE_WORD))
        quoted = self.tag("Why “Jungle” still matters")
        self.assertEqual((quoted.set_id, quoted.confidence), ("base2", nf.CONFIDENCE_QUOTED))
        self.assertEqual(self.tag("Vintage market update - is Base Set cooling off?").set_id, "base1")

    def test_set_named_like_its_series_needs_quotes(self) -> None:
        self.assertIsNone(self.tag("New Mega Evolution ex cards revealed").set_id)
        self.assertEqual(self.tag("Top cards from “Mega Evolution”").set_id, "me1")

    def test_japanese_translation_alias(self) -> None:
        self.assertEqual(self.tag("“Ninja Spinner” full set list").set_id, "m4_ja")
        self.assertEqual(self.tag("ニンジャスピナー box opening").set_id, "m4_ja")

    def test_card_by_printed_number_within_set(self) -> None:
        result = self.tag("Surging Sparks Pikachu ex 238/191 hits $400")
        self.assertEqual(result.card_ids, ["sv8-238"])

    def test_card_by_exact_name_within_set_only(self) -> None:
        result = self.tag("Pikachu ex from Surging Sparks is the chase")
        self.assertEqual(result.card_ids, ["sv8-238", "sv8-57"])  # both printings, not plain "Pikachu"
        self.assertEqual(self.tag("Charizard spotted in Surging Sparks boxes").card_ids, [])
        self.assertEqual(self.tag("Charizard 4/102 is climbing").card_ids, [])  # no set matched

    def test_one_piece_code_and_card_number(self) -> None:
        result = self.tag("OP16-001 Portgas.D.Ace leader deck guide", game="onepiece")
        self.assertEqual(result.set_id, "onepiece~OP16")
        self.assertEqual(result.card_ids, ["onepiece~OP16-001"])
        self.assertEqual(self.tag("BOOSTER PACK [OP-16] has been updated.", game="onepiece").set_id,
                         "onepiece~OP16")
        # letter-only codes never match ("PRE" in PRE-ORDER)
        self.assertIsNone(self.tag("PRE-ORDER news for next month").set_id)

    def test_game_filled_from_matched_set_when_source_has_none(self) -> None:
        result = self.tag("The Time Of Battle top cards", game=None)
        self.assertEqual((result.game, result.set_id), ("onepiece", "onepiece~OP16"))


# --- polling ---------------------------------------------------------------------


class RefreshTests(CatalogTestCase):
    def test_refresh_stores_filtered_tagged_items(self) -> None:
        fetch = fixture_fetcher()
        report = nf.refresh_news(self.connection, fetch=fetch, now=NOW)
        by_source = {key: value.get("stored") for key, value in report["sources"].items()}
        self.assertEqual(by_source["pokebeach"], 5)
        self.assertEqual(by_source["polygon_pokemon"], 2)
        self.assertEqual(by_source["dexerto_pokemon"], 1)
        self.assertEqual(by_source["tcgplayer_price_trends"], 3)  # Yu-Gi-Oh! dropped
        self.assertEqual(report["sources"]["lorcana_gg"]["status"], "http_404")

        market = self.rows("WHERE kind = 'market'")
        self.assertEqual(sorted(r[7] for r in market), ["lorcana", "onepiece", "pokemon"])
        self.assertTrue(all(r[2] == "TCGplayer Seller Blog" for r in market))

        celebration = self.rows("WHERE title LIKE '“30th Celebration” Pull Rates%'")[0]
        self.assertEqual((celebration[1], celebration[2], celebration[7], celebration[8]),
                         ("news", "PokéBeach", "pokemon", "me30"))
        self.assertIn("Pull rates", celebration[10])
        community = self.rows("WHERE kind = 'community'")
        self.assertEqual({r[2] for r in community}, {"Elite Fourum"})
        # never article bodies: no column holds more than the headline
        columns = [c[1] for c in self.connection.execute("PRAGMA table_info(news_items)")]
        self.assertFalse({"body", "content", "description", "summary"} & set(columns))

    def test_dedupe_across_polls(self) -> None:
        nf.refresh_news(self.connection, fetch=fixture_fetcher(), now=NOW)
        count = len(self.rows())
        nf.refresh_news(self.connection, fetch=fixture_fetcher(), now=NOW + timedelta(hours=1))
        self.assertEqual(len(self.rows()), count)
        # first-seen publish time sticks, fetched_at moves
        fetched = {r[0] for r in self.connection.execute("SELECT fetched_at FROM news_items")}
        self.assertEqual(fetched, {nf._iso(NOW + timedelta(hours=1))})

    def test_conditional_get_round_trip(self) -> None:
        pokebeach = source("pokebeach")
        first = FakeFetcher({pokebeach.url: nf.FetchResponse(
            200, fixture_bytes("pokebeach_front_page.rss.xml"),
            {"ETag": 'W/"abc"', "Last-Modified": "Thu, 24 Sep 2026 01:50:46 GMT"})})
        nf.refresh_news(self.connection, fetch=first, now=NOW, sources=[pokebeach])
        self.assertNotIn("If-None-Match", first.calls[0][1])
        self.assertIn("Mozilla/5.0", first.calls[0][1]["User-Agent"])

        second = FakeFetcher({pokebeach.url: nf.FetchResponse(304)})
        report = nf.refresh_news(self.connection, fetch=second, now=NOW + timedelta(hours=1), sources=[pokebeach])
        headers = second.calls[0][1]
        self.assertEqual(headers["If-None-Match"], 'W/"abc"')
        self.assertEqual(headers["If-Modified-Since"], "Thu, 24 Sep 2026 01:50:46 GMT")
        self.assertEqual(report["sources"]["pokebeach"]["status"], "not_modified")
        self.assertEqual(len(self.rows()), 5)
        state = self.connection.execute(
            "SELECT etag, last_status, consecutive_failures FROM news_sources_state WHERE source_key='pokebeach'"
        ).fetchone()
        self.assertEqual(tuple(state), ('W/"abc"', 304, 0))

    def test_forbidden_empty_and_exceptions_do_not_stop_the_run(self) -> None:
        empty_feed = b'<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>'
        fetch = fixture_fetcher(
            pokebeach=nf.FetchResponse(403),
            polygon_pokemon=OSError("timed out"),
            dexerto_pokemon=nf.FetchResponse(200, empty_feed),
            elitefourum_top_weekly=nf.FetchResponse(200, b"<html>Cloudflare</html>"),
        )
        with self.assertLogs("spotlight.news_feed", level="WARNING") as logs:
            report = nf.refresh_news(self.connection, fetch=fetch, now=NOW)
        statuses = {k: v["status"] for k, v in report["sources"].items()}
        self.assertEqual(statuses["pokebeach"], "http_403")
        self.assertEqual(statuses["polygon_pokemon"], "error")
        self.assertEqual(statuses["dexerto_pokemon"], "empty")
        self.assertEqual(statuses["elitefourum_top_weekly"], "parse_error")
        self.assertEqual(statuses["onepiece_gg"], "ok")
        self.assertTrue(any("http_status=403" in line for line in logs.output))
        failures = self.connection.execute(
            "SELECT consecutive_failures FROM news_sources_state WHERE source_key='pokebeach'"
        ).fetchone()[0]
        self.assertEqual(failures, 1)
        self.assertGreater(report["stored"], 0)

    def test_per_source_cap(self) -> None:
        capped = nf.NewsSource("capped", "PokéBeach", "https://capped.test/rss", "news", "pokemon", max_items=2)
        fetch = FakeFetcher({capped.url: nf.FetchResponse(200, fixture_bytes("pokebeach_front_page.rss.xml"))})
        nf.refresh_news(self.connection, fetch=fetch, now=NOW, sources=[capped])
        titles = [r[3] for r in self.rows()]
        self.assertEqual(len(titles), 2)
        self.assertTrue(titles[0].startswith("“30th Celebration” Pull Rates"))  # newest kept

    def test_retention(self) -> None:
        pokebeach = source("pokebeach")
        fetch = FakeFetcher({pokebeach.url: nf.FetchResponse(200, fixture_bytes("pokebeach_front_page.rss.xml"))})
        later = NOW + timedelta(days=nf.RETENTION_DAYS - 5)  # "Top 5 Decks" (9/15) is now > 60 days old
        nf.refresh_news(self.connection, fetch=fetch, now=later, sources=[pokebeach])
        self.assertNotIn("The Top 5 Decks After Worlds", [r[3] for r in self.rows()])

        old = nf._iso(NOW - timedelta(days=400))
        for url, kind, fetched in (
            ("https://example.com/old-news", "news", nf._iso(NOW)),
            ("https://www.youtube.com/watch?v=oldButSeen", "video", nf._iso(NOW)),
            ("https://www.youtube.com/watch?v=oldUnseen", "video", nf._iso(NOW - timedelta(days=30))),
        ):
            nf.upsert_news_row(self.connection, nf.NewsRow(kind=kind, source="t", title=url, url=url,
                                                           published_at=old), fetched_at=fetched)
        nf.prune_news(self.connection, now=NOW)
        remaining = {r[4] for r in self.rows("WHERE published_at = ?", (old,))}
        self.assertEqual(remaining, {"https://www.youtube.com/watch?v=oldButSeen"})

    def test_future_dates_clamped_to_now(self) -> None:
        body = b"""<?xml version="1.0"?><rss version="2.0"><channel><item><title>Pokemon TCG time traveller</title>
          <link>https://example.com/future</link><pubDate>Fri, 01 Jan 2027 00:00:00 +0000</pubDate></item>
          </channel></rss>"""
        src = nf.NewsSource("future", "X", "https://future.test/rss", "news", "pokemon")
        nf.refresh_news(self.connection, fetch=FakeFetcher({src.url: nf.FetchResponse(200, body)}),
                        now=NOW, sources=[src])
        self.assertEqual(self.rows()[0][6], nf._iso(NOW))


# --- payload -----------------------------------------------------------------------


class PayloadTests(CatalogTestCase):
    def setUp(self) -> None:
        super().setUp()
        base = datetime(2026, 9, 20, tzinfo=timezone.utc)
        for i in range(7):
            nf.upsert_news_row(self.connection, nf.NewsRow(
                kind="news" if i % 2 == 0 else "market", source="PokéBeach", title=f"Item {i}",
                url=f"https://example.com/{i}", published_at=nf._iso(base + timedelta(hours=i // 2)),
                game="pokemon" if i < 5 else "onepiece", set_id="sv8" if i < 3 else None,
                card_ids=["sv8-57"] if i == 1 else [], tags=["Market"] if i % 2 else [],
            ), fetched_at=nf._iso(base))
        for views, vid in ((10, "few"), (5000, "many"), (None, "unknown")):
            nf.upsert_news_row(self.connection, nf.NewsRow(
                kind="video", source="YouTube · PokeRev", title=f"Video {vid}", url=nf.youtube_watch_url(vid),
                published_at=nf._iso(base), game="pokemon", set_id="sv8",
                video={"channelTitle": "PokeRev", "durationSeconds": 600, "viewCount": views},
            ), fetched_at=nf._iso(base))
        self.connection.commit()

    def test_payload_shape_matches_contract(self) -> None:
        payload = nf.build_news_payload(self.connection, limit=50)
        self.assertEqual(set(payload), {"items", "nextCursor"})
        self.assertIsNone(payload["nextCursor"])
        self.assertEqual(len(payload["items"]), 10)
        expected_keys = {"id", "kind", "source", "title", "url", "imageUrl", "publishedAt", "game", "setId",
                         "cardIds", "tags", "video"}
        for item in payload["items"]:
            self.assertEqual(set(item), expected_keys)
            self.assertIn(item["kind"], nf.NEWS_KINDS)
            self.assertIsInstance(item["cardIds"], list)
            self.assertIsInstance(item["tags"], list)
            self.assertRegex(item["publishedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
            if item["kind"] == "video":
                self.assertEqual(set(item["video"]), {"channelTitle", "durationSeconds", "viewCount"})
            else:
                self.assertIsNone(item["video"])
        dates = [i["publishedAt"] for i in payload["items"]]
        self.assertEqual(dates, sorted(dates, reverse=True))

    def test_cursor_pagination_walks_everything_once(self) -> None:
        seen: list[str] = []
        cursor = None
        pages = 0
        while True:
            page = nf.build_news_payload(self.connection, limit=3, cursor=cursor)
            seen.extend(item["id"] for item in page["items"])
            pages += 1
            cursor = page["nextCursor"]
            if not cursor:
                break
        self.assertEqual(pages, 4)
        self.assertEqual(len(seen), 10)
        self.assertEqual(len(set(seen)), 10)
        with self.assertRaises(ValueError):
            nf.build_news_payload(self.connection, cursor="not-a-cursor!!")

    def test_filters_and_limit_clamp(self) -> None:
        self.assertEqual(len(nf.build_news_payload(self.connection, game="onepiece")["items"]), 2)
        self.assertEqual(len(nf.build_news_payload(self.connection, kind="video")["items"]), 3)
        self.assertEqual(len(nf.build_news_payload(self.connection, set_id="sv8")["items"]), 6)
        by_card = nf.build_news_payload(self.connection, card_id="sv8-57")["items"]
        self.assertEqual([i["title"] for i in by_card], ["Item 1"])
        self.assertEqual(len(nf.build_news_payload(self.connection, limit=500)["items"]), 10)
        with self.assertRaises(ValueError):
            nf.build_news_payload(self.connection, kind="podcast")

    def test_news_for_set(self) -> None:
        videos = nf.news_for_set(self.connection, "sv8", kind="video", limit=5)
        self.assertEqual([v["title"] for v in videos], ["Video many", "Video few", "Video unknown"])
        news = nf.news_for_set(self.connection, "sv8", kind="news", limit=10)
        self.assertEqual(len(news), 3)
        self.assertTrue(all(item["kind"] != "video" for item in news))
        self.assertEqual(len(nf.news_for_set(self.connection, "sv8", kind="market")), 1)


if __name__ == "__main__":
    unittest.main()
