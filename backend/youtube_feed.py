"""YouTube videos for the feed: channel uploads + per-set searches into `news_items`.

Rows are kind='video' with `video` JSON {channelTitle, durationSeconds, viewCount}
(the `NewsItem.video` contract). Tagging reuses news_feed's tagger.

Quota (YouTube Data API v3, resets midnight Pacific): 10,000 units/day, and
search.list has its own 100/day allowance. Our budget stays far below both:
- hourly channel refresh = one playlistItems.list per channel + one videos.list
  per 50 ids ≈ 10 units/run ≈ 240/day;
- search.list is capped at SEARCH_DAILY_BUDGET calls and cached per set for 7 days.
Every call is charged to `youtube_quota_usage` BEFORE it is made, so a crash
mid-run can only over-count.

No `YOUTUBE_API_KEY` → a clean no-op (logged once per process). The channel RSS
feed is an opt-in fallback only: it was 404/500/empty for most channels when
checked on 2026-09-23.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Mapping
from zoneinfo import ZoneInfo

import news_feed
from news_feed import FeedEntry, NewsRow, fold, youtube_watch_url

LOGGER = logging.getLogger("spotlight.youtube_feed")

API_BASE = "https://www.googleapis.com/youtube/v3"
QUOTA_TIMEZONE = ZoneInfo("America/Los_Angeles")
DAILY_UNIT_BUDGET = 3000  # of 10,000
SEARCH_DAILY_BUDGET = 20  # of 100
SEARCH_UNIT_COST = 100  # also charged to the unit budget, in case search counts against both
UPLOADS_PER_CHANNEL = 10
SET_SEARCH_CACHE_DAYS = 7
SET_SEARCH_RESULTS = 6
RECENT_SETS_PER_GAME = 3
SHORTS_MAX_SECONDS = 60
HTTP_TIMEOUT_SECONDS = 20


@dataclass(frozen=True)
class YouTubeChannel:
    channel_id: str
    title: str
    game: str | None  # None → per-video keyword detection

    @property
    def uploads_playlist_id(self) -> str:
        # A channel's uploads playlist is its id with the UC prefix swapped for UU.
        return "UU" + self.channel_id[2:] if self.channel_id.startswith("UC") else self.channel_id


CHANNELS: tuple[YouTubeChannel, ...] = (
    YouTubeChannel("UCUHYM7gs-GZpRGEsskTEqzQ", "PokeRev", "pokemon"),
    YouTubeChannel("UCtX7lsVa4nZnyCLCgDJg6pw", "ThePokeCapital", "pokemon"),
    YouTubeChannel("UCBHD6Yg8R1yS9akfGm4mecQ", "Leonhart", "pokemon"),
    YouTubeChannel("UC35KRaWGA7hQ5De40GG_7Fw", "Tricky Gym", "pokemon"),
    YouTubeChannel("UCpnU-sJoltf4bbTGesV7xow", "Pokémon TCG", "pokemon"),
    YouTubeChannel("UCd7dQLqtmngtF-6cir27PtA", "Disney Lorcana", "lorcana"),
    YouTubeChannel("UCQErN2YGMuB385NlJoCRUkw", "Lorcana Academy", "lorcana"),
    YouTubeChannel("UCzWFUefhg1opYUDv6YndmYw", "Gundam Card Game", "gundam"),
    # Covers more than one game; let the title decide.
    YouTubeChannel("UCm5dQhtBpw1S3ajLVPKWs0A", "Wossy Plays", None),
)

# Appended to per-set searches so "Surging Sparks" finds the card set, not a song.
GAME_SEARCH_SUFFIX = {
    "pokemon": "pokemon tcg",
    "onepiece": "one piece card game",
    "lorcana": "lorcana",
    "riftbound": "riftbound",
    "gundam": "gundam card game",
}


class YouTubeApiError(RuntimeError):
    def __init__(self, status: int, reason: str) -> None:
        super().__init__(f"youtube api http {status}: {reason}")
        self.status = status
        self.reason = reason

    @property
    def quota_exceeded(self) -> bool:
        return self.status == 403 and "quota" in self.reason.lower()


# (endpoint, params) → parsed JSON; raises YouTubeApiError on HTTP errors.
YouTubeHttp = Callable[[str, Mapping[str, Any]], dict[str, Any]]


def urllib_http(endpoint: str, params: Mapping[str, Any]) -> dict[str, Any]:
    url = f"{API_BASE}/{endpoint}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        reason = ""
        try:
            payload = json.loads(error.read().decode("utf-8"))
            reason = ",".join(e.get("reason", "") for e in payload.get("error", {}).get("errors", []))
        except Exception:  # the body is advisory only
            pass
        raise YouTubeApiError(error.code, reason or str(error.reason)) from error


_logged_missing_key = False


def _log_missing_key_once() -> None:
    global _logged_missing_key
    if not _logged_missing_key:
        LOGGER.info("youtube_feed: YOUTUBE_API_KEY not set; video ingestion is off")
        _logged_missing_key = True


def ensure_schema(connection: sqlite3.Connection) -> None:
    news_feed.ensure_schema(connection)
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS youtube_quota_usage (
            day TEXT NOT NULL,
            bucket TEXT NOT NULL,
            units INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, bucket)
        );
        CREATE TABLE IF NOT EXISTS youtube_set_video_cache (
            set_id TEXT PRIMARY KEY,
            query TEXT NOT NULL,
            video_ids TEXT NOT NULL DEFAULT '[]',
            fetched_at TEXT NOT NULL
        );
        """
    )


# --- quota ---------------------------------------------------------------------


class QuotaGuard:
    """Charges units per Pacific-time day; refuses once a budget would be exceeded."""

    def __init__(self, connection: sqlite3.Connection, now: datetime,
                 unit_budget: int | None = None, search_budget: int | None = None) -> None:
        self.connection = connection
        self.day = now.astimezone(QUOTA_TIMEZONE).date().isoformat()
        self.budgets = {
            "units": DAILY_UNIT_BUDGET if unit_budget is None else unit_budget,
            "search": SEARCH_DAILY_BUDGET if search_budget is None else search_budget,
        }

    def used(self, bucket: str) -> int:
        row = self.connection.execute(
            "SELECT units FROM youtube_quota_usage WHERE day = ? AND bucket = ?", (self.day, bucket)
        ).fetchone()
        return int(row[0]) if row else 0

    def _charge(self, bucket: str, amount: int) -> None:
        self.connection.execute(
            """
            INSERT INTO youtube_quota_usage (day, bucket, units) VALUES (?, ?, ?)
            ON CONFLICT(day, bucket) DO UPDATE SET units = units + excluded.units
            """,
            (self.day, bucket, amount),
        )
        self.connection.commit()

    def try_spend(self, units: int, *, search: bool = False) -> bool:
        if self.used("units") + units > self.budgets["units"]:
            return False
        if search and self.used("search") + 1 > self.budgets["search"]:
            return False
        self._charge("units", units)
        if search:
            self._charge("search", 1)
        return True


# --- parsing helpers -------------------------------------------------------------

_DURATION_RE = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$")


def parse_iso_duration(value: str | None) -> int | None:
    match = _DURATION_RE.match((value or "").strip())
    if not match or not any(match.groups()):
        return None
    days, hours, minutes, seconds = (int(part or 0) for part in match.groups())
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def _best_thumbnail(thumbnails: Mapping[str, Any] | None) -> str | None:
    for size in ("high", "medium", "standard", "default", "maxres"):
        url = ((thumbnails or {}).get(size) or {}).get("url")
        if url:
            return str(url)
    return None


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _fetch_video_details(http: YouTubeHttp, api_key: str, quota: QuotaGuard,
                         video_ids: list[str]) -> dict[str, dict[str, Any]]:
    details: dict[str, dict[str, Any]] = {}
    for start in range(0, len(video_ids), 50):
        chunk = video_ids[start:start + 50]
        if not quota.try_spend(1):
            LOGGER.warning("youtube_feed: unit budget reached; skipping videos.list")
            break
        response = http("videos", {"part": "snippet,contentDetails,statistics",
                                   "id": ",".join(chunk), "key": api_key, "maxResults": 50})
        for item in response.get("items") or []:
            if item.get("id"):
                details[str(item["id"])] = item
    return details


def _video_row(
    connection: sqlite3.Connection,
    index: news_feed.SetAliasIndex,
    item: Mapping[str, Any],
    *,
    default_game: str | None,
    now: datetime,
) -> NewsRow | None:
    snippet = item.get("snippet") or {}
    if (snippet.get("liveBroadcastContent") or "none") != "none":
        return None  # live / upcoming premieres have no stable duration or views yet
    duration = parse_iso_duration((item.get("contentDetails") or {}).get("duration"))
    if duration is not None and duration <= SHORTS_MAX_SECONDS:
        return None  # Shorts crowd out real set videos
    video_id = str(item.get("id") or "")
    title = news_feed.html_to_text(snippet.get("title"))
    if not video_id or not title:
        return None
    channel_title = str(snippet.get("channelTitle") or "")
    entry = FeedEntry(
        title=title,
        url=youtube_watch_url(video_id),
        published_at=news_feed.parse_datetime(snippet.get("publishedAt")),
        summary=news_feed.html_to_text(snippet.get("description"))[: news_feed.SUMMARY_CHARS],
        image_url=_best_thumbnail(snippet.get("thumbnails")),
    )
    row = news_feed.entry_to_row(
        connection, index, entry, kind="video", source_name=f"YouTube · {channel_title}",
        source_key=f"youtube:{snippet.get('channelId') or ''}", source_game=default_game,
        published_fallback=now,
    )
    row.video = {
        "channelTitle": channel_title,
        "durationSeconds": duration,
        "viewCount": _int_or_none((item.get("statistics") or {}).get("viewCount")),
    }
    return row


# --- channel uploads -------------------------------------------------------------


def refresh_youtube(
    connection: sqlite3.Connection,
    *,
    api_key: str | None = None,
    http: YouTubeHttp | None = None,
    now: datetime | None = None,
    channels: Iterable[YouTubeChannel] | None = None,
    rss_fallback: bool | None = None,
    fetch: news_feed.Fetcher | None = None,
) -> dict[str, Any]:
    """Latest uploads from each channel → news_items (kind 'video')."""
    api_key = api_key if api_key is not None else os.environ.get("YOUTUBE_API_KEY", "").strip()
    if rss_fallback is None:
        rss_fallback = os.environ.get("YOUTUBE_RSS_FALLBACK", "").strip().lower() in {"1", "true", "yes", "on"}
    channel_list = tuple(channels) if channels is not None else CHANNELS
    if not api_key:
        if rss_fallback:
            return _refresh_from_channel_rss(connection, channel_list, fetch=fetch, now=now)
        _log_missing_key_once()
        return {"status": "no_api_key", "stored": 0}

    ensure_schema(connection)
    http = http or urllib_http
    current = news_feed._now(now)
    fetched_at = news_feed._iso(current)
    quota = QuotaGuard(connection, current)
    index = news_feed.build_set_aliases(connection)
    report: dict[str, Any] = {"status": "ok", "channels": {}, "stored": 0}

    channel_for_video: dict[str, YouTubeChannel] = {}
    for channel in channel_list:
        if not quota.try_spend(1):
            LOGGER.warning("youtube_feed: unit budget reached; stopping channel refresh")
            report["status"] = "budget"
            break
        try:
            response = http("playlistItems", {"part": "snippet,contentDetails",
                                              "playlistId": channel.uploads_playlist_id,
                                              "maxResults": UPLOADS_PER_CHANNEL, "key": api_key})
        except YouTubeApiError as error:
            LOGGER.warning("youtube_feed channel=%s %s", channel.title, error)
            report["channels"][channel.title] = f"http_{error.status}"
            if error.quota_exceeded:
                report["status"] = "quota_exceeded"
                break
            continue
        except Exception as error:  # network hiccup: skip this channel only
            LOGGER.warning("youtube_feed channel=%s fetch failed: %s", channel.title, error)
            report["channels"][channel.title] = "error"
            continue
        items = response.get("items") or []
        if not items:
            LOGGER.warning("youtube_feed channel=%s returned no uploads", channel.title)
        for item in items:
            video_id = ((item.get("contentDetails") or {}).get("videoId")
                        or ((item.get("snippet") or {}).get("resourceId") or {}).get("videoId"))
            if video_id:
                channel_for_video[str(video_id)] = channel
        report["channels"][channel.title] = len(items)

    if not channel_for_video:
        connection.commit()
        return report
    try:
        # Private/deleted uploads are simply absent from videos.list.
        details = _fetch_video_details(http, api_key, quota, list(channel_for_video))
    except Exception as error:
        LOGGER.warning("youtube_feed videos.list failed: %s", error)
        report["status"] = "details_failed"
        return report
    for video_id, item in details.items():
        row = _video_row(connection, index, item, default_game=channel_for_video[video_id].game, now=current)
        if row is None:
            continue
        news_feed.upsert_news_row(connection, row, fetched_at=fetched_at)
        report["stored"] += 1
    connection.commit()
    return report


def _refresh_from_channel_rss(
    connection: sqlite3.Connection,
    channels: Iterable[YouTubeChannel],
    *,
    fetch: news_feed.Fetcher | None,
    now: datetime | None,
) -> dict[str, Any]:
    """Best-effort fallback: no key needed, but no durations and often 404s."""
    ensure_schema(connection)
    fetch = fetch or news_feed.urllib_fetch
    current = news_feed._now(now)
    fetched_at = news_feed._iso(current)
    index = news_feed.build_set_aliases(connection)
    report: dict[str, Any] = {"status": "rss_fallback", "channels": {}, "stored": 0}
    for channel in channels:
        url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel.channel_id}"
        try:
            response = fetch(url, {"User-Agent": news_feed.BROWSER_USER_AGENT})
            entries = news_feed.parse_feed(response.body) if response.status == 200 else []
        except Exception as error:
            LOGGER.warning("youtube_feed rss channel=%s failed: %s", channel.title, error)
            report["channels"][channel.title] = "error"
            continue
        if response.status != 200:
            report["channels"][channel.title] = f"http_{response.status}"
            continue
        for entry in entries[:UPLOADS_PER_CHANNEL]:
            if entry.video_id:
                entry.url = youtube_watch_url(entry.video_id)
            channel_title = entry.channel_title or channel.title
            row = news_feed.entry_to_row(
                connection, index, entry, kind="video", source_name=f"YouTube · {channel_title}",
                source_key=f"youtube:{channel.channel_id}", source_game=channel.game,
                published_fallback=current,
            )
            row.video = {"channelTitle": channel_title, "durationSeconds": None, "viewCount": entry.view_count}
            news_feed.upsert_news_row(connection, row, fetched_at=fetched_at)
            report["stored"] += 1
        report["channels"][channel.title] = len(entries)
    connection.commit()
    return report


# --- per-set search ----------------------------------------------------------------


def refresh_set_videos(
    connection: sqlite3.Connection,
    set_id: str,
    set_name: str,
    *,
    game: str | None = None,
    api_key: str | None = None,
    http: YouTubeHttp | None = None,
    now: datetime | None = None,
    max_results: int = SET_SEARCH_RESULTS,
    force: bool = False,
) -> dict[str, Any]:
    """Most-viewed videos about one set, cached SET_SEARCH_CACHE_DAYS per set.

    Returns {"status": "cached"|"fetched"|"no_api_key"|"budget"|"error", "videoIds": [...]}.
    Rows land in news_items with set_id pinned to `set_id`.
    """
    api_key = api_key if api_key is not None else os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not api_key:
        _log_missing_key_once()
        return {"status": "no_api_key", "videoIds": []}
    ensure_schema(connection)
    current = news_feed._now(now)
    cached = connection.execute(
        "SELECT video_ids, fetched_at FROM youtube_set_video_cache WHERE set_id = ?", (set_id,)
    ).fetchone()
    if cached and not force:
        cached_at = news_feed.parse_datetime(cached[1])
        if cached_at and current - cached_at < timedelta(days=SET_SEARCH_CACHE_DAYS):
            return {"status": "cached", "videoIds": json.loads(cached[0] or "[]")}

    http = http or urllib_http
    quota = QuotaGuard(connection, current)
    if not quota.try_spend(SEARCH_UNIT_COST, search=True):
        LOGGER.warning("youtube_feed: search budget reached; set=%s not refreshed", set_id)
        return {"status": "budget", "videoIds": json.loads(cached[0] or "[]") if cached else []}

    game = game or news_feed.build_set_aliases(connection).set_games.get(set_id)
    query = f"{set_name} {GAME_SEARCH_SUFFIX.get(game or '', 'tcg')}".strip()
    try:
        response = http("search", {"part": "snippet", "type": "video", "order": "viewCount",
                                   "q": query, "maxResults": max(1, min(max_results * 2, 25)),
                                   "relevanceLanguage": "en", "safeSearch": "moderate", "key": api_key})
        # viewCount ordering surfaces huge off-topic videos; keep ones that name the set.
        wanted = fold(set_name)
        video_ids = []
        for item in response.get("items") or []:
            video_id = (item.get("id") or {}).get("videoId")
            snippet = item.get("snippet") or {}
            text = fold(f"{snippet.get('title') or ''} {snippet.get('description') or ''}")
            if video_id and wanted in text:
                video_ids.append(str(video_id))
        video_ids = video_ids[:max_results]
        details = _fetch_video_details(http, api_key, quota, video_ids) if video_ids else {}
    except Exception as error:
        LOGGER.warning("youtube_feed set=%s search failed: %s", set_id, error)
        return {"status": "error", "videoIds": []}

    index = news_feed.build_set_aliases(connection)
    fetched_at = news_feed._iso(current)
    stored: list[str] = []
    for video_id in video_ids:
        item = details.get(video_id)
        if not item:
            continue
        row = _video_row(connection, index, item, default_game=game, now=current)
        if row is None:
            continue
        # The search itself is the set evidence; keep card ids only if the tagger agreed.
        if row.set_id != set_id:
            row.card_ids = news_feed.match_cards_in_set(
                connection, set_id, f"{row.title}\n{(item.get('snippet') or {}).get('description') or ''}"
            )
            row.set_id = set_id
            row.tag_confidence = news_feed.CONFIDENCE_CODE
        row.game = row.game or game
        news_feed.upsert_news_row(connection, row, fetched_at=fetched_at)
        stored.append(video_id)
    connection.execute(
        """
        INSERT INTO youtube_set_video_cache (set_id, query, video_ids, fetched_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(set_id) DO UPDATE SET query = excluded.query, video_ids = excluded.video_ids,
                                          fetched_at = excluded.fetched_at
        """,
        (set_id, query, json.dumps(stored), fetched_at),
    )
    connection.commit()
    return {"status": "fetched", "videoIds": stored}


def refresh_recent_set_videos(
    connection: sqlite3.Connection,
    *,
    api_key: str | None = None,
    http: YouTubeHttp | None = None,
    now: datetime | None = None,
    per_game: int = RECENT_SETS_PER_GAME,
) -> dict[str, Any]:
    """Set videos for the newest released English sets per game (cache keeps this ~2 searches/day)."""
    api_key = api_key if api_key is not None else os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not api_key:
        _log_missing_key_once()
        return {"status": "no_api_key"}
    current = news_feed._now(now)
    today = current.date().isoformat()
    results: dict[str, Any] = {}
    for game in news_feed.GAMES:
        try:
            rows = connection.execute(
                """
                SELECT id, name FROM expansions
                WHERE game = ? AND COALESCE(language, 'English') LIKE 'En%'
                  AND release_date IS NOT NULL AND REPLACE(release_date, '/', '-') <= ?
                ORDER BY REPLACE(release_date, '/', '-') DESC
                LIMIT ?
                """,
                (game, today, per_game),
            ).fetchall()
        except sqlite3.OperationalError:
            return {"status": "no_expansions"}
        for set_id, name in rows:
            outcome = refresh_set_videos(connection, set_id, name, game=game, api_key=api_key,
                                         http=http, now=current)
            results[set_id] = outcome["status"]
            if outcome["status"] == "budget":
                return {"status": "budget", "sets": results}
    return {"status": "ok", "sets": results}
