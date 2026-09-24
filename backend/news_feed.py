"""Card news: RSS/Atom polling, game/set/card tagging, and the `NewsFeed` payload.

Contract: `NewsItem` / `NewsFeed` in docs/meta-feed-api-contracts-2026-09-23.md.
Sources and tagging rules: docs/meta-trends-news-feed-plan-2026-09-23.md.

Deliberate limits:
- We store headline + link + thumbnail only. Article bodies are read in memory
  (first ~300 chars, for tagging) and never persisted.
- The poller is the only thing that touches the network; the payload builder
  reads `news_items` and nothing else.
- A failing source (403, empty feed, bad XML) is logged and skipped; it never
  aborts the run. Conditional GET (ETag / Last-Modified) keeps hourly polls cheap.

set_spotlight.py reads `news_items` through `news_for_set`. Columns: id, kind,
source, title, url, image_url, published_at, game, set_id, card_ids (JSON),
tags (JSON), video (JSON), fetched_at, tag_confidence.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import html
import json
import logging
import re
import sqlite3
import sys
import unicodedata
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

LOGGER = logging.getLogger("spotlight.news_feed")

NEWS_KINDS = ("news", "market", "video", "community")
GAMES = ("pokemon", "onepiece", "lorcana", "riftbound", "gundam")

RETENTION_DAYS = 60
# Videos found by a per-set search can be years old but stay relevant while the
# search keeps returning them, so they expire on last-seen, not publish date.
VIDEO_UNSEEN_DAYS = 14
DEFAULT_MAX_ITEMS_PER_SOURCE = 25
SUMMARY_CHARS = 300
MAX_CARD_IDS = 10
MAX_TAGS = 3
DEFAULT_PAGE_LIMIT = 20
MAX_PAGE_LIMIT = 50
FETCH_TIMEOUT_SECONDS = 20
MAX_FEED_BYTES = 5 * 1024 * 1024

BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"
)
BOT_USER_AGENT = "EkalightNewsBot/1.0 (+https://ekalight.app)"


# --- source registry ---------------------------------------------------------


@dataclass(frozen=True)
class NewsSource:
    key: str
    name: str  # shown as NewsItem.source
    url: str
    kind: str  # news | market | community
    game: str | None = None  # None → resolve per item from tags/keywords
    keyword_filter: bool = False  # general-gaming feeds: keep TCG items only
    require_game: bool = False  # drop items no supported game can be resolved for
    user_agent: str = BROWSER_USER_AGENT
    max_items: int = DEFAULT_MAX_ITEMS_PER_SOURCE


# Every source was verified with a browser UA on 2026-09-23 (PokéBeach 403s
# without one), so that is the default; switch per source if a site asks.
# DotGG: the per-game /category/news/feed/ only — the root /feed/ carries spam.
NEWS_SOURCES: tuple[NewsSource, ...] = (
    NewsSource("pokebeach", "PokéBeach",
               "https://www.pokebeach.com/forums/forum/front-page-news.18/index.rss",
               "news", "pokemon"),
    NewsSource("onepiece_gg", "onepiece.gg", "https://onepiece.gg/category/news/feed/", "news", "onepiece"),
    NewsSource("lorcana_gg", "lorcana.gg", "https://lorcana.gg/category/news/feed/", "news", "lorcana"),
    NewsSource("riftbound_gg", "riftbound.gg", "https://riftbound.gg/category/news/feed/", "news", "riftbound"),
    NewsSource("gundamcard_gg", "gundamcard.gg", "https://gundamcard.gg/category/news/feed/", "news", "gundam"),
    NewsSource("polygon_pokemon", "Polygon", "https://www.polygon.com/rss/pokemon/index.xml",
               "news", "pokemon", keyword_filter=True),
    NewsSource("dexerto_pokemon", "Dexerto", "https://www.dexerto.com/pokemon/feed/",
               "news", "pokemon", keyword_filter=True),
    # Game comes from the post's category tags ("#One Piece"); Yu-Gi-Oh!/MTG posts drop out.
    NewsSource("tcgplayer_price_trends", "TCGplayer Seller Blog",
               "https://seller.tcgplayer.com/blog/tag/price-trends/rss.xml",
               "market", None, require_game=True),
    # /c/pokemon-tcg/5.rss now redirects to the "Collecting" category (id 5);
    # the Market category (id 13) is the price/low-pop chatter we want.
    NewsSource("elitefourum_market", "Elite Fourum",
               "https://www.elitefourum.com/c/price-and-market-discussion/13.rss",
               "community", "pokemon", max_items=10),
    NewsSource("elitefourum_top_weekly", "Elite Fourum",
               "https://www.elitefourum.com/top.rss?period=weekly",
               "community", "pokemon", max_items=10),
)


# --- schema ------------------------------------------------------------------


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS news_items (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            source TEXT NOT NULL,
            source_key TEXT,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            image_url TEXT,
            published_at TEXT NOT NULL,
            game TEXT,
            set_id TEXT,
            card_ids TEXT NOT NULL DEFAULT '[]',
            tags TEXT NOT NULL DEFAULT '[]',
            video TEXT,
            fetched_at TEXT NOT NULL,
            tag_confidence REAL
        );
        CREATE INDEX IF NOT EXISTS idx_news_items_published ON news_items(published_at);
        CREATE INDEX IF NOT EXISTS idx_news_items_game_published ON news_items(game, published_at);
        CREATE INDEX IF NOT EXISTS idx_news_items_set ON news_items(set_id);
        CREATE INDEX IF NOT EXISTS idx_news_items_kind ON news_items(kind);

        CREATE TABLE IF NOT EXISTS news_sources_state (
            source_key TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            etag TEXT,
            last_modified TEXT,
            last_status INTEGER,
            last_error TEXT,
            last_fetched_at TEXT,
            last_success_at TEXT,
            last_item_count INTEGER,
            consecutive_failures INTEGER NOT NULL DEFAULT 0
        );
        """
    )


# --- small helpers -----------------------------------------------------------


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now(now: datetime | None) -> datetime:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc)


def parse_datetime(value: str | None) -> datetime | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        parsed = parsedate_to_datetime(text)  # RFC 822 (RSS pubDate)
    except (TypeError, ValueError, IndexError):
        parsed = None
    if parsed is None:
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))  # Atom / dc:date
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def html_to_text(value: str | None) -> str:
    text = html.unescape(_TAG_RE.sub(" ", value or ""))
    return _WS_RE.sub(" ", text).strip()


def fold(text: str) -> str:
    """Case/accent/quote-insensitive form used on BOTH sides of every match."""
    text = (text or "").replace("’", "'").replace("‘", "'").replace("–", "-").replace("—", "-")
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return stripped.lower()


_TRACKING_PARAMS = {"fbclid", "gclid", "mc_cid", "mc_eid"}
_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}


def youtube_watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def canonical_url(url: str) -> str:
    parts = urlsplit((url or "").strip())
    host = parts.netloc.lower()
    if host in _YOUTUBE_HOSTS:
        video_id = None
        if host == "youtu.be":
            video_id = parts.path.strip("/") or None
        elif parts.path.startswith("/shorts/"):
            video_id = parts.path.split("/")[2] or None
        else:
            video_id = dict(parse_qsl(parts.query)).get("v")
        if video_id:
            return youtube_watch_url(video_id)
    query = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in _TRACKING_PARAMS
    ]
    scheme = "https" if parts.scheme in ("http", "https", "") else parts.scheme
    return urlunsplit((scheme, host, parts.path or "/", urlencode(query), ""))


def news_item_id(url: str) -> str:
    return hashlib.sha1(canonical_url(url).encode("utf-8")).hexdigest()[:20]


# --- feed parsing ------------------------------------------------------------

NS_ATOM = "http://www.w3.org/2005/Atom"
NS_MEDIA = "http://search.yahoo.com/mrss/"
NS_CONTENT = "http://purl.org/rss/1.0/modules/content/"
NS_DC = "http://purl.org/dc/elements/1.1/"
NS_YT = "http://www.youtube.com/xml/schemas/2015"

_IMG_SRC_RE = re.compile(r"<img\b[^>]*?\bsrc\s*=\s*[\"']([^\"']+)[\"']", re.IGNORECASE)
# Source badges, avatars and emoji come before the real image in several feeds
# (DotGG's first <img> is its "source-logo").
_NON_THUMBNAIL_RE = re.compile(r"(logo|icon|avatar|emoji|favicon|gravatar|/smilies/|pixel|spacer)", re.I)
_IMAGE_EXT_RE = re.compile(r"\.(jpe?g|png|webp|gif|avif)(\?|$)", re.I)


@dataclass
class FeedEntry:
    title: str
    url: str
    published_at: datetime | None
    summary: str  # plain text, <= SUMMARY_CHARS, tagging only — never stored
    image_url: str | None = None
    categories: list[str] = field(default_factory=list)
    video_id: str | None = None
    view_count: int | None = None
    channel_title: str | None = None


def _clean_image_url(raw: str | None, base: str | None) -> str | None:
    value = html.unescape((raw or "").strip())
    if not value:
        return None
    if value.startswith("//"):
        value = "https:" + value
    elif base and not value.startswith(("http://", "https://")):
        value = urljoin(base, value)
    if not value.startswith(("http://", "https://")):
        return None
    return value


def _first_img(markup: str | None, base: str | None) -> str | None:
    markup = markup or ""
    if "<img" not in markup.lower():
        markup = html.unescape(markup)  # double-escaped descriptions
    for match in _IMG_SRC_RE.finditer(markup):
        candidate = _clean_image_url(match.group(1), base)
        if candidate and not _NON_THUMBNAIL_RE.search(candidate):
            return candidate
    return None


def _media_image(element: ET.Element, base: str | None) -> str | None:
    for node in element.iter(f"{{{NS_MEDIA}}}content"):
        url = node.get("url")
        medium = (node.get("medium") or "").lower()
        mime = (node.get("type") or "").lower()
        if url and (medium == "image" or mime.startswith("image/") or _IMAGE_EXT_RE.search(url)):
            return _clean_image_url(url, base)
    for node in element.iter(f"{{{NS_MEDIA}}}thumbnail"):
        if node.get("url"):
            return _clean_image_url(node.get("url"), base)
    for node in element.findall("enclosure"):
        mime = (node.get("type") or "").lower()
        url = node.get("url")
        if url and (mime.startswith("image/") or _IMAGE_EXT_RE.search(url)):
            return _clean_image_url(url, base)
    return None


def _text(element: ET.Element, path: str) -> str:
    node = element.find(path)
    return (node.text or "") if node is not None and node.text else ""


def _parse_rss_item(item: ET.Element) -> FeedEntry | None:
    title = html_to_text(_text(item, "title"))
    link = _text(item, "link").strip()
    if not link:
        guid = item.find("guid")
        if guid is not None and (guid.get("isPermaLink") or "true").lower() == "true":
            link = (guid.text or "").strip()
    if not title or not link.startswith(("http://", "https://")):
        return None
    description = _text(item, "description")
    content = _text(item, f"{{{NS_CONTENT}}}encoded")
    published = parse_datetime(_text(item, "pubDate") or _text(item, f"{{{NS_DC}}}date"))
    image = _media_image(item, link) or _first_img(description, link) or _first_img(content, link)
    categories = [html_to_text(node.text) for node in item.findall("category") if node.text]
    summary = html_to_text(description or content)[:SUMMARY_CHARS]
    return FeedEntry(title=title, url=link, published_at=published, summary=summary,
                     image_url=image, categories=categories)


def _parse_atom_entry(entry: ET.Element) -> FeedEntry | None:
    title = html_to_text(_text(entry, f"{{{NS_ATOM}}}title"))
    link = ""
    for node in entry.findall(f"{{{NS_ATOM}}}link"):
        if (node.get("rel") or "alternate") == "alternate" and node.get("href"):
            link = node.get("href", "").strip()
            break
    if not title or not link.startswith(("http://", "https://")):
        return None
    published = parse_datetime(_text(entry, f"{{{NS_ATOM}}}published") or _text(entry, f"{{{NS_ATOM}}}updated"))
    summary_markup = (
        _text(entry, f"{{{NS_ATOM}}}summary")
        or _text(entry, f"{{{NS_ATOM}}}content")
        or _text(entry, f"{{{NS_MEDIA}}}group/{{{NS_MEDIA}}}description")
    )
    image = _media_image(entry, link) or _first_img(summary_markup, link)
    views = entry.find(f".//{{{NS_MEDIA}}}statistics")
    view_count = None
    if views is not None and (views.get("views") or "").isdigit():
        view_count = int(views.get("views", "0"))
    author = _text(entry, f"{{{NS_ATOM}}}author/{{{NS_ATOM}}}name").strip() or None
    categories = [node.get("term", "") for node in entry.findall(f"{{{NS_ATOM}}}category") if node.get("term")]
    return FeedEntry(
        title=title, url=link, published_at=published,
        summary=html_to_text(summary_markup)[:SUMMARY_CHARS], image_url=image,
        categories=categories, video_id=_text(entry, f"{{{NS_YT}}}videoId").strip() or None,
        view_count=view_count, channel_title=author,
    )


def parse_feed(body: bytes | str) -> list[FeedEntry]:
    """RSS 2.0 or Atom → entries. Raises ValueError on anything else."""
    if isinstance(body, str):
        body = body.encode("utf-8")
    try:
        root = ET.fromstring(body.lstrip(b"\xef\xbb\xbf \t\r\n"))
    except ET.ParseError as error:
        raise ValueError(f"unparseable feed: {error}") from error
    if root.tag == "rss":
        parser, nodes = _parse_rss_item, root.findall("./channel/item")
    elif root.tag == f"{{{NS_ATOM}}}feed":
        parser, nodes = _parse_atom_entry, root.findall(f"{{{NS_ATOM}}}entry")
    else:
        raise ValueError(f"unsupported feed root <{root.tag}>")
    return [entry for entry in (parser(node) for node in nodes) if entry is not None]


# --- keyword filter, game detection, tags --------------------------------------

# General-gaming feeds (Polygon, Dexerto) also cover the video games, the anime
# and Pokémon GO; an item must mention the card game to be kept.
_TCG_KEYWORD_RE = re.compile(
    r"\b(tcg|trading cards?|cards?|booster|boosters|packs?|pack opening|pull rates?|psa|cgc|bgs"
    r"|graded|slabs?|elite trainer box|etb|promos?|expansion)\b"
)


def passes_keyword_filter(entry: FeedEntry) -> bool:
    haystack = fold(" ".join([entry.title, entry.summary, *entry.categories]))
    return bool(_TCG_KEYWORD_RE.search(haystack))


GAME_KEYWORDS: dict[str, re.Pattern[str]] = {
    "pokemon": re.compile(r"\b(pokemon|ptcg|pokeka)\b"),
    "onepiece": re.compile(r"\b(one piece|optcg)\b"),
    "lorcana": re.compile(r"\blorcana\b"),
    "riftbound": re.compile(r"\briftbound\b"),
    "gundam": re.compile(r"\bgundam\b"),
}


def detect_game(source_game: str | None, title: str, summary: str = "", categories: Sequence[str] = ()) -> str | None:
    """Source first; else categories, then title, then summary. Ambiguous → None."""
    if source_game:
        return source_game
    for text in (" ".join(categories), title, summary):
        folded = fold(text)
        hits = [game for game, pattern in GAME_KEYWORDS.items() if pattern.search(folded)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            return None
    return None


TAG_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b(ban|bans|banned|ban ?list|restricted|restriction|errata)\b"), "Ban list"),
    (re.compile(r"\b(reveal|reveals|revealed|leak|leaks|leaked|first look|spoilers?)\b"), "Set reveal"),
    (re.compile(r"\b(prices?|priced|market|value|valuable|climbing|dropping|investing)\b"), "Market"),
    (re.compile(r"\bpull rates?\b"), "Pull rates"),
    (re.compile(r"\b(tournament|regionals?|worlds|championships?|decks|decklists?|meta|standings)\b"), "Competitive"),
    (re.compile(r"\b(psa|cgc|bgs|grading|graded|slabs?)\b"), "Grading"),
    (re.compile(r"\b(promo|promos)\b"), "Promo"),
    (re.compile(r"\b(restocks?|scalpers?|sold out|preorders?|pre-orders?)\b"), "Restock"),
    (re.compile(r"\b(release|releases|released|launch|launches|prerelease|pre-release|announced)\b"), "Release"),
)


def tags_for(title: str, kind: str) -> list[str]:
    folded = fold(title)
    tags = ["Market"] if kind == "market" else []
    for pattern, tag in TAG_RULES:
        if tag not in tags and pattern.search(folded):
            tags.append(tag)
    return tags[:MAX_TAGS]


# --- set / card tagging --------------------------------------------------------

CONFIDENCE_QUOTED = 0.95
CONFIDENCE_NAME = 0.8
CONFIDENCE_CODE = 0.7
CONFIDENCE_SINGLE_WORD = 0.5
MIN_ALIAS_CHARS = 4

# One-word names that are ordinary words ("Base", "Jungle", "Fossil", ...) are
# the whole reason for the game-keyword rule; every single-word name is treated
# this way rather than maintaining a list that goes stale with each release.
_QUOTE_OPEN = "\"“‘'"
_QUOTE_CLOSE = "\"”’'"


@dataclass(frozen=True)
class SetAlias:
    alias: str  # folded
    set_id: str
    game: str
    kind: str  # 'name' | 'translation' | 'code'
    english: bool
    ambiguous: str | None  # None | 'keyword' (needs a game keyword) | 'quoted' (needs quotes)


@dataclass
class SetAliasIndex:
    names: list[SetAlias] = field(default_factory=list)  # longest first
    codes: dict[tuple[str, str], list[SetAlias]] = field(default_factory=dict)  # (game, CODE) → aliases
    set_games: dict[str, str] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.names or self.codes)


def normalize_set_code(code: str) -> str:
    return re.sub(r"[\s\-_]", "", code or "").upper()


def _code_is_distinctive(code: str) -> bool:
    # Letter-only PTCGO codes ("PRE", "TR", "SSP") collide with ordinary words.
    return len(code) >= 3 and any(ch.isdigit() for ch in code) and any(ch.isalpha() for ch in code)


def build_set_aliases(connection: sqlite3.Connection) -> SetAliasIndex:
    try:
        rows = connection.execute(
            "SELECT id, game, name, code, language, series, source_payload_json FROM expansions"
        ).fetchall()
    except sqlite3.OperationalError:
        return SetAliasIndex()
    index = SetAliasIndex()
    seen: set[tuple[str, str, str]] = set()

    def add_name(alias_text: str, set_id: str, game: str, kind: str, english: bool, series: str) -> None:
        alias = fold(alias_text).strip()
        if len(alias) < MIN_ALIAS_CHARS or (alias, set_id, kind) in seen:
            return
        seen.add((alias, set_id, kind))
        ambiguous = None
        if " " not in alias and alias.isascii():  # a one-word JP name is never an English word
            ambiguous = "keyword"
        elif alias == fold(series).strip():
            # "Mega Evolution", "Scarlet & Violet": the set shares its series'
            # name, so an unquoted mention is almost always the era, not the set.
            ambiguous = "quoted"
        index.names.append(SetAlias(alias, set_id, game, kind, english, ambiguous))

    for row in rows:
        set_id, game, name, code, language, series, payload_json = (row[i] for i in range(7))
        game = game or "pokemon"
        index.set_games[set_id] = game
        english = (language or "English").lower().startswith("en")
        add_name(name or "", set_id, game, "name", english, series or "")
        folded_name = fold(name or "").strip()
        if " " not in folded_name and folded_name.isascii() and len(folded_name) >= MIN_ALIAS_CHARS:
            add_name(f"{name} Set", set_id, game, "name", english, series or "")  # "Base Set"
        try:
            payload = json.loads(payload_json or "{}")
        except (TypeError, ValueError):
            payload = {}
        translated = ((payload.get("translation") or {}).get("en") or {}).get("name") if isinstance(payload, dict) else None
        if translated and not english:
            add_name(translated, set_id, game, "translation", english, series or "")
        normalized_code = normalize_set_code(code or "")
        if _code_is_distinctive(normalized_code):
            index.codes.setdefault((game, normalized_code), []).append(
                SetAlias(normalized_code, set_id, game, "code", english, None)
            )
    index.names.sort(key=lambda alias: len(alias.alias), reverse=True)
    return index


@dataclass
class TagResult:
    game: str | None
    set_id: str | None = None
    card_ids: list[str] = field(default_factory=list)
    confidence: float | None = None


_CODE_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9])([A-Z]{1,4})[- ]?(\d{1,3}[a-z]?)(?![A-Za-z0-9])")
_SLASH_NUMBER_RE = re.compile(r"(?<![\d/])(\d{1,3})\s?/\s?(\d{2,3})(?![\d/])")
_CODE_NUMBER_RE = re.compile(r"(?<![A-Za-z0-9])([A-Z]{1,4}-?\d{1,3}[a-z]?)-(\d{2,3})(?![0-9])")


def _is_quoted(text: str, start: int, end: int) -> bool:
    before = text[:start].rstrip()
    after = text[end:].lstrip()
    after = after.lstrip("!?,.:;")
    return bool(before) and before[-1] in _QUOTE_OPEN and bool(after) and after[0] in _QUOTE_CLOSE


def _pick_set(aliases: list[SetAlias]) -> str | None:
    """One alias text can name several sets (EN name vs a JP translation)."""
    distinct = {alias.set_id for alias in aliases}
    if len(distinct) == 1:
        return next(iter(distinct))
    for preference in (
        lambda a: a.kind == "name" and a.english,
        lambda a: a.kind == "name",
        lambda a: a.english,
    ):
        narrowed = {alias.set_id for alias in aliases if preference(alias)}
        if len(narrowed) == 1:
            return next(iter(narrowed))
        if len(narrowed) > 1:
            return None
    return None


def match_set(index: SetAliasIndex, text: str, *, game: str | None) -> tuple[str | None, float | None]:
    """Longest alias wins; ambiguity rules decide whether a hit counts at all."""
    folded = fold(text)
    keyword_games = {g for g, pattern in GAME_KEYWORDS.items() if pattern.search(folded)}
    best_len = 0
    best: list[tuple[SetAlias, float]] = []
    for alias in index.names:
        if len(alias.alias) < best_len:
            break  # names are sorted longest first
        if game and alias.game != game:
            continue
        if alias.alias not in folded:
            continue
        pattern = re.compile(r"(?<!\w)" + re.escape(alias.alias) + r"(?!\w)")
        for match in pattern.finditer(folded):
            quoted = _is_quoted(folded, match.start(), match.end())
            if alias.ambiguous == "quoted" and not quoted:
                continue
            if alias.ambiguous == "keyword" and not quoted and alias.game not in keyword_games:
                continue
            if quoted:
                confidence = CONFIDENCE_QUOTED
            elif alias.ambiguous == "keyword":
                confidence = CONFIDENCE_SINGLE_WORD
            else:
                confidence = CONFIDENCE_NAME
            best_len = len(alias.alias)
            best.append((alias, confidence))
            break
    if best:
        set_id = _pick_set([alias for alias, _ in best])
        if set_id:
            return set_id, max(conf for alias, conf in best if alias.set_id == set_id)
        return None, None
    # No name hit: fall back to a distinctive set code ("[OP-17]", "OP16-001").
    code_hits: list[SetAlias] = []
    for letters, digits in _CODE_TOKEN_RE.findall(text):
        code = normalize_set_code(letters + digits)
        for code_game in ([game] if game else list(GAMES)):
            code_hits.extend(index.codes.get((code_game, code), []))
    if code_hits:
        set_id = _pick_set(code_hits)
        if set_id:
            return set_id, CONFIDENCE_CODE
    return None, None


def _slash_key(number: str) -> tuple[int, int] | None:
    match = re.fullmatch(r"\s*0*(\d{1,3})\s*/\s*0*(\d{1,3})\s*", number or "")
    return (int(match.group(1)), int(match.group(2))) if match else None


def match_cards_in_set(connection: sqlite3.Connection, set_id: str, text: str) -> list[str]:
    """Card ids in `set_id` that `text` points at: printed number first, else exact name."""
    try:
        rows = connection.execute("SELECT id, name, number FROM cards WHERE set_id = ?", (set_id,)).fetchall()
    except sqlite3.OperationalError:
        return []
    if not rows:
        return []
    cards = [(row[0], row[1] or "", row[2] or "") for row in rows]

    wanted_slash = {(int(a), int(b)) for a, b in _SLASH_NUMBER_RE.findall(text)}
    wanted_codes = {normalize_set_code(prefix) + "-" + num for prefix, num in _CODE_NUMBER_RE.findall(text)}
    by_number: list[str] = []
    for card_id, _name, number in cards:
        key = _slash_key(number)
        if key and key in wanted_slash:
            by_number.append(card_id)
            continue
        code_key = re.fullmatch(r"([A-Za-z0-9\- ]+?)-(\d{2,3})", number.strip())
        if code_key and normalize_set_code(code_key.group(1)) + "-" + code_key.group(2) in wanted_codes:
            by_number.append(card_id)
    if by_number:
        return sorted(set(by_number))[:MAX_CARD_IDS]

    folded = fold(text)
    names: dict[str, list[str]] = {}
    for card_id, name, _number in cards:
        key = fold(name).strip()
        if len(key) >= MIN_ALIAS_CHARS:
            names.setdefault(key, []).append(card_id)
    taken: list[tuple[int, int]] = []
    matched: list[str] = []
    for name in sorted(names, key=len, reverse=True):
        if name not in folded:
            continue
        for match in re.finditer(r"(?<!\w)" + re.escape(name) + r"(?!\w)", folded):
            span = (match.start(), match.end())
            # "Pikachu ex" matched → the "Pikachu" inside it is not a second card.
            if any(span[0] < end and start < span[1] for start, end in taken):
                continue
            taken.append(span)
            matched.extend(names[name])
            break
    return sorted(set(matched))[:MAX_CARD_IDS]


def tag_entry(
    connection: sqlite3.Connection,
    index: SetAliasIndex,
    *,
    title: str,
    summary: str = "",
    source_game: str | None = None,
    categories: Sequence[str] = (),
) -> TagResult:
    game = detect_game(source_game, title, summary, categories)
    text = f"{title}\n{summary[:SUMMARY_CHARS]}"
    set_id, confidence = match_set(index, text, game=game) if index else (None, None)
    if not set_id:
        return TagResult(game=game)
    game = game or index.set_games.get(set_id)
    return TagResult(game=game, set_id=set_id, card_ids=match_cards_in_set(connection, set_id, text),
                     confidence=confidence)


# --- storage -----------------------------------------------------------------


@dataclass
class NewsRow:
    kind: str
    source: str
    title: str
    url: str
    published_at: str
    source_key: str | None = None
    image_url: str | None = None
    game: str | None = None
    set_id: str | None = None
    card_ids: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    video: dict[str, Any] | None = None
    tag_confidence: float | None = None

    @property
    def id(self) -> str:
        return news_item_id(self.url)


def upsert_news_row(connection: sqlite3.Connection, row: NewsRow, *, fetched_at: str) -> str:
    """Insert or refresh one item. The first-seen publish time, kind and source stick;
    a later poll that loses the set tag keeps the earlier one."""
    item_id = row.id
    connection.execute(
        """
        INSERT INTO news_items (
            id, kind, source, source_key, title, url, image_url, published_at,
            game, set_id, card_ids, tags, video, fetched_at, tag_confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            image_url = COALESCE(excluded.image_url, news_items.image_url),
            game = COALESCE(excluded.game, news_items.game),
            card_ids = CASE WHEN excluded.set_id IS NULL AND news_items.set_id IS NOT NULL
                            THEN news_items.card_ids ELSE excluded.card_ids END,
            tag_confidence = CASE WHEN excluded.set_id IS NULL AND news_items.set_id IS NOT NULL
                                  THEN news_items.tag_confidence ELSE excluded.tag_confidence END,
            set_id = COALESCE(excluded.set_id, news_items.set_id),
            tags = excluded.tags,
            video = COALESCE(excluded.video, news_items.video),
            fetched_at = excluded.fetched_at
        """,
        (
            item_id, row.kind, row.source, row.source_key, row.title, canonical_url(row.url),
            row.image_url, row.published_at, row.game, row.set_id,
            json.dumps(row.card_ids), json.dumps(row.tags),
            json.dumps(row.video) if row.video is not None else None,
            fetched_at, row.tag_confidence,
        ),
    )
    return item_id


def prune_news(connection: sqlite3.Connection, *, now: datetime | None = None,
               retention_days: int = RETENTION_DAYS) -> int:
    current = _now(now)
    cutoff = _iso(current - timedelta(days=retention_days))
    unseen_cutoff = _iso(current - timedelta(days=VIDEO_UNSEEN_DAYS))
    cursor = connection.execute(
        """
        DELETE FROM news_items
        WHERE published_at < ?
          AND (kind != 'video' OR fetched_at < ?)
        """,
        (cutoff, unseen_cutoff),
    )
    return cursor.rowcount or 0


# --- fetching ----------------------------------------------------------------


@dataclass
class FetchResponse:
    status: int
    body: bytes = b""
    headers: dict[str, str] = field(default_factory=dict)

    def header(self, name: str) -> str | None:
        lowered = name.lower()
        return next((v for k, v in self.headers.items() if k.lower() == lowered), None)


Fetcher = Callable[[str, Mapping[str, str]], FetchResponse]


def urllib_fetch(url: str, headers: Mapping[str, str]) -> FetchResponse:
    request = urllib.request.Request(url, headers=dict(headers))
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            body = response.read(MAX_FEED_BYTES + 1)
            if len(body) > MAX_FEED_BYTES:
                raise ValueError(f"feed larger than {MAX_FEED_BYTES} bytes")
            return FetchResponse(response.status, body, dict(response.headers.items()))
    except urllib.error.HTTPError as error:  # 304 lands here too
        return FetchResponse(error.code, b"", dict(error.headers.items()) if error.headers else {})


def _load_state(connection: sqlite3.Connection, source_key: str) -> tuple[str | None, str | None, int]:
    row = connection.execute(
        "SELECT etag, last_modified, consecutive_failures FROM news_sources_state WHERE source_key = ?",
        (source_key,),
    ).fetchone()
    return (row[0], row[1], row[2] or 0) if row else (None, None, 0)


def _save_state(
    connection: sqlite3.Connection, source: NewsSource, *, status: int | None, fetched_at: str,
    ok: bool, error: str | None = None, etag: str | None = None, last_modified: str | None = None,
    item_count: int | None = None, keep_validators: bool = True,
) -> None:
    previous_etag, previous_modified, failures = _load_state(connection, source.key)
    if keep_validators:
        etag = etag or previous_etag
        last_modified = last_modified or previous_modified
    connection.execute(
        """
        INSERT INTO news_sources_state (
            source_key, url, etag, last_modified, last_status, last_error, last_fetched_at,
            last_success_at, last_item_count, consecutive_failures
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
            url = excluded.url,
            etag = excluded.etag,
            last_modified = excluded.last_modified,
            last_status = excluded.last_status,
            last_error = excluded.last_error,
            last_fetched_at = excluded.last_fetched_at,
            last_success_at = COALESCE(excluded.last_success_at, news_sources_state.last_success_at),
            last_item_count = COALESCE(excluded.last_item_count, news_sources_state.last_item_count),
            consecutive_failures = excluded.consecutive_failures
        """,
        (
            source.key, source.url, etag, last_modified, status, error, fetched_at,
            fetched_at if ok else None, item_count, 0 if ok else failures + 1,
        ),
    )


def entry_to_row(
    connection: sqlite3.Connection,
    index: SetAliasIndex,
    entry: FeedEntry,
    *,
    kind: str,
    source_name: str,
    source_key: str | None,
    source_game: str | None,
    published_fallback: datetime,
) -> NewsRow:
    tagged = tag_entry(connection, index, title=entry.title, summary=entry.summary,
                       source_game=source_game, categories=entry.categories)
    published = entry.published_at or published_fallback
    # A feed clock in the future would pin an item to the top of the feed.
    published = min(published, published_fallback)
    return NewsRow(
        kind=kind, source=source_name, source_key=source_key, title=entry.title[:300],
        url=entry.url, published_at=_iso(published), image_url=entry.image_url,
        game=tagged.game, set_id=tagged.set_id, card_ids=tagged.card_ids,
        tags=tags_for(entry.title, kind), tag_confidence=tagged.confidence,
    )


def refresh_news(
    connection: sqlite3.Connection,
    *,
    fetch: Fetcher | None = None,
    now: datetime | None = None,
    sources: Iterable[NewsSource] | None = None,
) -> dict[str, Any]:
    """Poll every source once. Never raises for a single bad source."""
    ensure_schema(connection)
    fetch = fetch or urllib_fetch
    current = _now(now)
    fetched_at = _iso(current)
    cutoff = current - timedelta(days=RETENTION_DAYS)
    index = build_set_aliases(connection)
    report: dict[str, Any] = {"sources": {}, "stored": 0}

    for source in sources if sources is not None else NEWS_SOURCES:
        etag, last_modified, _failures = _load_state(connection, source.key)
        headers = {"User-Agent": source.user_agent,
                   "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8"}
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        try:
            response = fetch(source.url, headers)
        except Exception as error:  # network errors must not stop the other sources
            LOGGER.warning("news_feed source=%s fetch failed: %s", source.key, error)
            _save_state(connection, source, status=None, fetched_at=fetched_at, ok=False, error=str(error)[:300])
            connection.commit()
            report["sources"][source.key] = {"status": "error", "error": str(error)[:300]}
            continue

        if response.status == 304:
            _save_state(connection, source, status=304, fetched_at=fetched_at, ok=True)
            connection.commit()
            report["sources"][source.key] = {"status": "not_modified", "stored": 0}
            continue
        if response.status != 200:
            # 403 is the usual "site started bot-walling us" signal; alert on it.
            LOGGER.warning("news_feed source=%s http_status=%s", source.key, response.status)
            _save_state(connection, source, status=response.status, fetched_at=fetched_at, ok=False,
                        error=f"http {response.status}")
            connection.commit()
            report["sources"][source.key] = {"status": f"http_{response.status}"}
            continue

        try:
            entries = parse_feed(response.body)
        except ValueError as error:
            LOGGER.warning("news_feed source=%s parse failed: %s", source.key, error)
            _save_state(connection, source, status=200, fetched_at=fetched_at, ok=False,
                        error=str(error)[:300], keep_validators=False)
            connection.commit()
            report["sources"][source.key] = {"status": "parse_error"}
            continue
        if not entries:
            LOGGER.warning("news_feed source=%s returned an empty feed", source.key)

        if source.keyword_filter:
            entries = [entry for entry in entries if passes_keyword_filter(entry)]
        entries = [entry for entry in entries if entry.published_at is None or entry.published_at >= cutoff]
        entries.sort(key=lambda e: e.published_at or current, reverse=True)
        entries = entries[: source.max_items]

        stored = 0
        for entry in entries:
            row = entry_to_row(connection, index, entry, kind=source.kind, source_name=source.name,
                               source_key=source.key, source_game=source.game, published_fallback=current)
            if source.require_game and not row.game:
                continue
            upsert_news_row(connection, row, fetched_at=fetched_at)
            stored += 1
        _save_state(connection, source, status=200, fetched_at=fetched_at, ok=True,
                    etag=response.header("ETag"), last_modified=response.header("Last-Modified"),
                    item_count=stored, keep_validators=False)
        connection.commit()
        report["sources"][source.key] = {"status": "ok" if entries else "empty", "stored": stored}
        report["stored"] += stored

    report["pruned"] = prune_news(connection, now=current)
    connection.commit()
    return report


# --- payload -----------------------------------------------------------------

_SELECT_COLUMNS = (
    "id, kind, source, title, url, image_url, published_at, game, set_id, card_ids, tags, video"
)


def _json_list(value: Any) -> list[Any]:
    try:
        parsed = json.loads(value or "[]")
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def row_to_news_item(row: Sequence[Any]) -> dict[str, Any]:
    video = None
    if row[11]:
        try:
            raw = json.loads(row[11])
        except (TypeError, ValueError):
            raw = None
        if isinstance(raw, dict):
            video = {
                "channelTitle": str(raw.get("channelTitle") or ""),
                "durationSeconds": raw.get("durationSeconds"),
                "viewCount": raw.get("viewCount"),
            }
    return {
        "id": row[0],
        "kind": row[1],
        "source": row[2],
        "title": row[3],
        "url": row[4],
        "imageUrl": row[5],
        "publishedAt": row[6],
        "game": row[7],
        "setId": row[8],
        "cardIds": [str(v) for v in _json_list(row[9])],
        "tags": [str(v) for v in _json_list(row[10])],
        "video": video,
    }


def encode_cursor(published_at: str, item_id: str) -> str:
    raw = json.dumps([published_at, item_id], separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(cursor: str) -> tuple[str, str]:
    """Raises ValueError on a malformed cursor (the route should answer 400)."""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except (binascii.Error, UnicodeError, ValueError) as error:
        raise ValueError("invalid cursor") from error
    if not (isinstance(value, list) and len(value) == 2 and all(isinstance(v, str) for v in value)):
        raise ValueError("invalid cursor")
    return value[0], value[1]


def _ensure_read_schema(connection: sqlite3.Connection) -> None:
    # Request path: executescript commits, so only run it when the table is missing.
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'news_items'"
    ).fetchone()
    if exists is None:
        ensure_schema(connection)


def build_news_payload(
    connection: sqlite3.Connection,
    *,
    game: str | None = None,
    kind: str | None = None,
    set_id: str | None = None,
    card_id: str | None = None,
    limit: int = DEFAULT_PAGE_LIMIT,
    cursor: str | None = None,
) -> dict[str, Any]:
    """`NewsFeed`, newest first. Raises ValueError for a bad kind or cursor."""
    _ensure_read_schema(connection)
    if kind and kind not in NEWS_KINDS:
        raise ValueError(f"unknown kind: {kind}")
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = DEFAULT_PAGE_LIMIT
    limit = max(1, min(limit, MAX_PAGE_LIMIT))
    clauses: list[str] = []
    params: list[Any] = []
    if game:
        clauses.append("game = ?")
        params.append(game)
    if kind:
        clauses.append("kind = ?")
        params.append(kind)
    if set_id:
        clauses.append("set_id = ?")
        params.append(set_id)
    if card_id:
        clauses.append("EXISTS (SELECT 1 FROM json_each(news_items.card_ids) WHERE json_each.value = ?)")
        params.append(card_id)
    if cursor:
        cursor_published, cursor_id = decode_cursor(cursor)
        clauses.append("(published_at < ? OR (published_at = ? AND id < ?))")
        params.extend([cursor_published, cursor_published, cursor_id])
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = connection.execute(
        f"SELECT {_SELECT_COLUMNS} FROM news_items {where} ORDER BY published_at DESC, id DESC LIMIT ?",
        (*params, limit + 1),
    ).fetchall()
    items = [row_to_news_item(row) for row in rows[:limit]]
    next_cursor = encode_cursor(items[-1]["publishedAt"], items[-1]["id"]) if len(rows) > limit else None
    return {"items": items, "nextCursor": next_cursor}


def news_for_set(connection: sqlite3.Connection, set_id: str, *, kind: str = "news", limit: int = 10) -> list[dict[str, Any]]:
    """Items tagged to one set, for the Set spotlight payload.

    kind="video" → videos, most-viewed first; kind="news" → every non-video kind,
    newest first; any other NewsKind → exactly that kind.
    """
    _ensure_read_schema(connection)
    limit = max(1, min(int(limit), MAX_PAGE_LIMIT))
    if kind == "video":
        sql = (f"SELECT {_SELECT_COLUMNS} FROM news_items WHERE set_id = ? AND kind = 'video' "
               "ORDER BY COALESCE(json_extract(video, '$.viewCount'), -1) DESC, published_at DESC LIMIT ?")
        params: tuple[Any, ...] = (set_id, limit)
    elif kind == "news":
        sql = (f"SELECT {_SELECT_COLUMNS} FROM news_items WHERE set_id = ? AND kind != 'video' "
               "ORDER BY published_at DESC, id DESC LIMIT ?")
        params = (set_id, limit)
    else:
        sql = (f"SELECT {_SELECT_COLUMNS} FROM news_items WHERE set_id = ? AND kind = ? "
               "ORDER BY published_at DESC, id DESC LIMIT ?")
        params = (set_id, kind, limit)
    return [row_to_news_item(row) for row in connection.execute(sql, params).fetchall()]


# --- CLI (VM runner) -----------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Poll news RSS + YouTube into news_items.")
    parser.add_argument("--database-path", required=True, type=Path)
    parser.add_argument("--skip-youtube", action="store_true")
    parser.add_argument("--skip-rss", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    from catalog_tools import connect  # local: keep the module importable without the catalog stack

    connection = connect(args.database_path, timeout_seconds=30.0)
    try:
        ensure_schema(connection)
        if not args.skip_rss:
            report = refresh_news(connection)
            LOGGER.info("news_feed rss report=%s", json.dumps(report, sort_keys=True))
        if not args.skip_youtube:
            import youtube_feed

            yt_report = youtube_feed.refresh_youtube(connection)
            LOGGER.info("news_feed youtube report=%s", json.dumps(yt_report, sort_keys=True))
            set_report = youtube_feed.refresh_recent_set_videos(connection)
            LOGGER.info("news_feed set-videos report=%s", json.dumps(set_report, sort_keys=True))
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
