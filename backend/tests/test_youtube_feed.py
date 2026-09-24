"""youtube_feed: no-key no-op, channel uploads → news_items (kind 'video' with the
`video` JSON contract), quota accounting and budget stops, the per-set search
with its 7-day cache, and the channel-RSS fallback. The YouTube API is a fake
backed by fixture JSON; nothing here touches the network.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import news_feed as nf  # noqa: E402
import youtube_feed as yf  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_card, upsert_expansion  # noqa: E402

FIXTURES = BACKEND_ROOT / "tests" / "fixtures" / "news"
NOW = datetime(2026, 9, 24, 3, 0, tzinfo=timezone.utc)
POKEREV = yf.YouTubeChannel("UCUHYM7gs-GZpRGEsskTEqzQ", "PokeRev", "pokemon")


def load_json(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


class FakeYouTube:
    """Answers playlistItems/videos/search from fixtures; records (endpoint, params)."""

    def __init__(self, *, fail_with: Exception | None = None) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.fail_with = fail_with
        self.videos = {item["id"]: item for item in load_json("youtube_videos.json")["items"]}
        for result in load_json("youtube_search_set.json")["items"]:
            video_id = result["id"]["videoId"]
            self.videos[video_id] = {
                "kind": "youtube#video", "id": video_id, "snippet": result["snippet"],
                "contentDetails": {"duration": "PT22M10S"}, "statistics": {"viewCount": "1000000"},
            }

    def __call__(self, endpoint: str, params):
        self.calls.append((endpoint, dict(params)))
        if self.fail_with:
            raise self.fail_with
        if endpoint == "playlistItems":
            if params["playlistId"] == "UUUHYM7gs-GZpRGEsskTEqzQ":
                return load_json("youtube_playlist_items_pokerev.json")
            return {"items": []}
        if endpoint == "videos":
            ids = params["id"].split(",")
            return {"items": [self.videos[i] for i in ids if i in self.videos]}
        if endpoint == "search":
            return load_json("youtube_search_set.json")
        raise AssertionError(f"unexpected endpoint {endpoint}")

    def endpoints(self) -> list[str]:
        return [endpoint for endpoint, _ in self.calls]


class YouTubeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(tempdir.cleanup)
        self.connection = connect(Path(tempdir.name) / "yt.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        yf.ensure_schema(self.connection)
        upsert_expansion(self.connection, expansion_id="me30", name="30th Celebration", code="M30",
                         series="Mega Evolution", language="English", release_date="2026/09/16", game="pokemon")
        upsert_expansion(self.connection, expansion_id="sv8", name="Surging Sparks", code="SSP",
                         series="Scarlet & Violet", language="English", release_date="2024/11/08", game="pokemon")
        upsert_card(self.connection, card_id="sv8-57", name="Pikachu ex", set_name="Surging Sparks",
                    number="57/191", rarity="Rare", variant="normal", language="English", set_id="sv8")
        self.connection.commit()
        env = mock.patch.dict(os.environ, {"YOUTUBE_API_KEY": "", "YOUTUBE_RSS_FALLBACK": ""})
        env.start()
        self.addCleanup(env.stop)
        yt_logger = logging.getLogger("spotlight.youtube_feed")
        previous_level = yt_logger.level
        yt_logger.setLevel(logging.ERROR)
        self.addCleanup(yt_logger.setLevel, previous_level)

    def video_rows(self):
        return self.connection.execute(
            "SELECT id, kind, source, title, url, image_url, published_at, game, set_id, card_ids, video "
            "FROM news_items WHERE kind = 'video' ORDER BY published_at DESC"
        ).fetchall()

    def quota(self, bucket: str, now: datetime = NOW) -> int:
        return yf.QuotaGuard(self.connection, now).used(bucket)


class NoKeyTests(YouTubeTestCase):
    def test_no_key_is_a_clean_no_op(self) -> None:
        http = FakeYouTube()
        self.assertEqual(yf.refresh_youtube(self.connection, http=http, now=NOW)["status"], "no_api_key")
        self.assertEqual(yf.refresh_set_videos(self.connection, "sv8", "Surging Sparks", http=http,
                                               now=NOW)["status"], "no_api_key")
        self.assertEqual(yf.refresh_recent_set_videos(self.connection, http=http, now=NOW)["status"], "no_api_key")
        self.assertEqual(http.calls, [])
        self.assertEqual(self.video_rows(), [])

    def test_env_key_is_used_when_no_argument(self) -> None:
        http = FakeYouTube()
        with mock.patch.dict(os.environ, {"YOUTUBE_API_KEY": "env-key"}):
            yf.refresh_youtube(self.connection, http=http, now=NOW, channels=[POKEREV])
        self.assertEqual(http.calls[0][1]["key"], "env-key")


class ChannelRefreshTests(YouTubeTestCase):
    def test_uploads_become_video_items(self) -> None:
        http = FakeYouTube()
        report = yf.refresh_youtube(self.connection, api_key="k", http=http, now=NOW, channels=[POKEREV])
        self.assertEqual(report["stored"], 2)  # the private upload is absent from videos.list
        self.assertEqual(http.endpoints(), ["playlistItems", "videos"])
        self.assertEqual(http.calls[0][1]["playlistId"], "UUUHYM7gs-GZpRGEsskTEqzQ")
        self.assertEqual(http.calls[1][1]["id"], "aBcDeFgHiJ1,kLmNoPqRsT2,pRiVaTeVid3")

        rows = self.video_rows()
        self.assertEqual(len(rows), 2)
        newest = rows[0]
        self.assertEqual(newest[2], "YouTube · PokeRev")
        self.assertEqual(newest[4], "https://www.youtube.com/watch?v=aBcDeFgHiJ1")
        self.assertEqual(newest[5], "https://i.ytimg.com/vi/aBcDeFgHiJ1/hqdefault.jpg")
        self.assertEqual(newest[6], "2026-09-22T19:00:07Z")
        self.assertEqual((newest[7], newest[8]), ("pokemon", "me30"))
        self.assertEqual(json.loads(newest[10]),
                         {"channelTitle": "PokeRev", "durationSeconds": 3725, "viewCount": 184230})

        item = nf.build_news_payload(self.connection, kind="video")["items"][0]
        self.assertEqual(item["video"], {"channelTitle": "PokeRev", "durationSeconds": 3725, "viewCount": 184230})

    def test_refresh_updates_view_counts_without_duplicating(self) -> None:
        http = FakeYouTube()
        yf.refresh_youtube(self.connection, api_key="k", http=http, now=NOW, channels=[POKEREV])
        http.videos["aBcDeFgHiJ1"]["statistics"]["viewCount"] = "200000"
        yf.refresh_youtube(self.connection, api_key="k", http=http, now=NOW + timedelta(hours=1), channels=[POKEREV])
        rows = self.video_rows()
        self.assertEqual(len(rows), 2)
        self.assertEqual(json.loads(rows[0][10])["viewCount"], 200000)

    def test_quota_is_charged_per_call(self) -> None:
        yf.refresh_youtube(self.connection, api_key="k", http=FakeYouTube(), now=NOW)
        # 9 channels × playlistItems + 1 videos.list
        self.assertEqual(self.quota("units"), len(yf.CHANNELS) + 1)
        self.assertEqual(self.quota("search"), 0)

    def test_budget_stops_before_spending(self) -> None:
        http = FakeYouTube()
        with mock.patch.object(yf, "DAILY_UNIT_BUDGET", 2):
            report = yf.refresh_youtube(self.connection, api_key="k", http=http, now=NOW)
        self.assertEqual(report["status"], "budget")
        self.assertEqual(self.quota("units"), 2)
        self.assertEqual(len(http.calls), 2)

    def test_quota_day_is_pacific(self) -> None:
        # 03:00 UTC on the 24th is still the 23rd in Pacific time
        self.assertEqual(yf.QuotaGuard(self.connection, NOW).day, "2026-09-23")

    def test_quota_exceeded_error_stops_the_run(self) -> None:
        http = FakeYouTube(fail_with=yf.YouTubeApiError(403, "quotaExceeded"))
        report = yf.refresh_youtube(self.connection, api_key="k", http=http, now=NOW)
        self.assertEqual(report["status"], "quota_exceeded")
        self.assertEqual(len(http.calls), 1)

    def test_network_error_skips_channel_only(self) -> None:
        http = FakeYouTube(fail_with=OSError("reset"))
        report = yf.refresh_youtube(self.connection, api_key="k", http=http, now=NOW)
        self.assertEqual(len(http.calls), len(yf.CHANNELS))
        self.assertEqual(report["stored"], 0)

    def test_shorts_and_live_are_skipped(self) -> None:
        http = FakeYouTube()
        http.videos["aBcDeFgHiJ1"]["contentDetails"]["duration"] = "PT45S"
        http.videos["kLmNoPqRsT2"]["snippet"]["liveBroadcastContent"] = "upcoming"
        report = yf.refresh_youtube(self.connection, api_key="k", http=http, now=NOW, channels=[POKEREV])
        self.assertEqual(report["stored"], 0)

    def test_parse_iso_duration(self) -> None:
        self.assertEqual(yf.parse_iso_duration("PT1H2M5S"), 3725)
        self.assertEqual(yf.parse_iso_duration("PT14M31S"), 871)
        self.assertEqual(yf.parse_iso_duration("P1DT1S"), 86401)
        self.assertIsNone(yf.parse_iso_duration("P"))
        self.assertIsNone(yf.parse_iso_duration(None))

    def test_uploads_playlist_id(self) -> None:
        self.assertEqual(POKEREV.uploads_playlist_id, "UUUHYM7gs-GZpRGEsskTEqzQ")


class SetVideoTests(YouTubeTestCase):
    def test_search_then_cache_then_expiry(self) -> None:
        http = FakeYouTube()
        first = yf.refresh_set_videos(self.connection, "sv8", "Surging Sparks", game="pokemon",
                                      api_key="k", http=http, now=NOW)
        self.assertEqual(first, {"status": "fetched", "videoIds": ["sUrGiNg0001", "sUrGiNg0002"]})
        search_params = http.calls[0][1]
        self.assertEqual(http.endpoints(), ["search", "videos"])
        self.assertEqual(search_params["order"], "viewCount")
        self.assertEqual(search_params["q"], "Surging Sparks pokemon tcg")
        self.assertEqual(self.quota("search"), 1)
        self.assertEqual(self.quota("units"), yf.SEARCH_UNIT_COST + 1)

        rows = self.video_rows()
        self.assertEqual({r[8] for r in rows}, {"sv8"})
        self.assertEqual({r[2] for r in rows}, {"YouTube · ThePokeCapital", "YouTube · Tricky Gym"})
        pikachu = next(r for r in rows if r[4].endswith("sUrGiNg0001"))
        self.assertEqual(json.loads(pikachu[9]), ["sv8-57"])  # "Pikachu ex" in the title, within the set

        cached = yf.refresh_set_videos(self.connection, "sv8", "Surging Sparks", api_key="k", http=http,
                                       now=NOW + timedelta(days=6))
        self.assertEqual(cached["status"], "cached")
        self.assertEqual(len(http.calls), 2)

        expired = yf.refresh_set_videos(self.connection, "sv8", "Surging Sparks", api_key="k", http=http,
                                        now=NOW + timedelta(days=8))
        self.assertEqual(expired["status"], "fetched")
        self.assertEqual(len(http.calls), 4)

        videos = nf.news_for_set(self.connection, "sv8", kind="video")
        self.assertEqual(len(videos), 2)

    def test_off_topic_results_are_dropped(self) -> None:
        http = FakeYouTube()
        result = yf.refresh_set_videos(self.connection, "me30", "30th Celebration", game="pokemon",
                                       api_key="k", http=http, now=NOW)
        self.assertEqual(result, {"status": "fetched", "videoIds": []})
        self.assertEqual(http.endpoints(), ["search"])  # no videos.list for nothing

    def test_search_budget(self) -> None:
        http = FakeYouTube()
        guard = yf.QuotaGuard(self.connection, NOW)
        guard._charge("search", yf.SEARCH_DAILY_BUDGET)
        result = yf.refresh_set_videos(self.connection, "sv8", "Surging Sparks", api_key="k", http=http, now=NOW)
        self.assertEqual(result["status"], "budget")
        self.assertEqual(http.calls, [])

    def test_recent_sets_only_released_english(self) -> None:
        http = FakeYouTube()
        upsert_expansion(self.connection, expansion_id="me99", name="Future Set", language="English",
                         release_date="2027/01/01", game="pokemon")
        self.connection.commit()
        report = yf.refresh_recent_set_videos(self.connection, api_key="k", http=http, now=NOW)
        self.assertEqual(set(report["sets"]), {"me30", "sv8"})
        queries = [params["q"] for endpoint, params in http.calls if endpoint == "search"]
        self.assertEqual(queries, ["30th Celebration pokemon tcg", "Surging Sparks pokemon tcg"])


class RssFallbackTests(YouTubeTestCase):
    def test_channel_rss_fallback_when_opted_in(self) -> None:
        url = f"https://www.youtube.com/feeds/videos.xml?channel_id={POKEREV.channel_id}"
        body = (FIXTURES / "youtube_channel_pokerev.atom.xml").read_bytes()

        def fetch(requested, headers):
            return nf.FetchResponse(200, body) if requested == url else nf.FetchResponse(404)

        report = yf.refresh_youtube(self.connection, rss_fallback=True, fetch=fetch, now=NOW, channels=[POKEREV])
        self.assertEqual(report["stored"], 2)
        rows = self.video_rows()
        self.assertEqual(rows[0][4], "https://www.youtube.com/watch?v=aBcDeFgHiJ1")
        self.assertEqual(json.loads(rows[0][10]),
                         {"channelTitle": "PokeRev", "durationSeconds": None, "viewCount": 184230})
        self.assertEqual(rows[1][8], None)  # "Base Set" is not seeded here


if __name__ == "__main__":
    unittest.main()
