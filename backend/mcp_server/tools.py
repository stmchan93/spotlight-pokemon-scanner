"""Owner-scoped, read-only tool logic for the MCP server.

Every public method takes the caller's `owner_user_id` explicitly and only reads
that owner's account rows. Catalog/pricing reads come from SQLite through the
existing SpotlightScanService helpers (no provider calls). Prices are USD or
null: a JPY-only card (native yen, or yen FX-converted for display) has no
price here.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import art_search

from catalog_tools import (
    PSA_GRADE_PRICING_MODE,
    RAW_MAIN_PRICE_SOURCE_TCGCSV,
    RAW_PRICING_MODE,
    SEALED_SUPERTYPE,
    SUPPORTED_GAMES,
    _MANUAL_SEARCH_POOL_CEILING,
    _normalized_variant_label,
    _variant_match_key,
    _chunked_sql_values,
    card_by_id,
    cards_by_ids,
    main_raw_cell_points_by_variant_date,
    price_snapshot_row,
    rarity_bucket,
    search_cards as catalog_search_cards,
    tokenize,
)
import meta_pulse
from market_movers import latest_persisted_payload as latest_movers_payload
from similar_cards import build_similar_cards_payload
from tcgcsv_adapter import TCGCSV_PROVIDER
import watch_printings

from .filters import (
    ToolInputError,
    clamp_limit,
    decode_cursor,
    encode_cursor,
    normalize_card_filter,
    uses_art_filters,
)
from .marketplace_links import buy_links

GAME = "pokemon"
# Catalog candidates gathered per search before post-filtering/sorting. Pages are
# slices of this stable pool, so totals past it are lower bounds.
SEARCH_POOL_SIZE = 200
MISSING_POOL_SIZE = 300
# catalog_tools.search_cards returns at most this many per call, whatever limit asks.
CATALOG_SEARCH_MAX_RESULTS = 200
# Artist/set filters without text skip relevance search and query the catalog
# directly, so the pool is exhaustive up to these bounds. A set has <~400 cards,
# so find_missing sees every card of a set.
STRUCTURED_MISSING_POOL_SIZE = 500
STRUCTURED_ROW_CEILING = 5000
# The SQL price window is loose (snapshot price vs. the served price can differ);
# the exact served price is re-checked in Python.
PRICE_WINDOW_SLACK = 2.0
MAX_WATCHLIST_READ = 200
ART_PAGE_SIZE = 100
# Holdings read per call; collections larger than this are reported truncated.
MAX_HOLDINGS_READ = 1000
MAX_SIMILAR = 10
MAX_HISTORY_POINTS = 120

SEARCH_SORTS = ("relevance", "price_asc", "price_desc", "newest")
OWNED_MODES = ("any", "owned", "not_owned")
COLLECTION_SORTS = ("value_desc", "gain_desc", "added_desc")
PORTFOLIO_RANGES = {"7d": 7, "30d": 30, "90d": 90, "1y": 365}
HISTORY_RANGES = {"30d": 30, "90d": 90, "1y": 365}
PRICE_LOW_WINDOWS = {"90d": 90, "1y": 365}
MAX_PRICE_LOWS = 20
TREND_WINDOWS = {"7d": 7, "30d": 30, "90d": 90}
MAX_TREND_CARDS = 5
MAX_TREND_SETS = 3
# Tool condition code -> card_price_history_cell condition code.
HISTORY_CONDITIONS = {"NM": "NM", "LP": "LP", "MP": "MP", "HP": "HP", "DMG": "DM"}
DECK_CONDITION_CODES = {
    "near_mint": "NM",
    "lightly_played": "LP",
    "moderately_played": "MP",
    "heavily_played": "HP",
    "damaged": "DMG",
}

# Shared by the MCP tool and the in-app assistant tool.
WATCHLIST_DESCRIPTION = (
    "The user's Watchlist: cards they are watching (not owned), newest first, with the watched printing "
    "(watch_variant, null = main printing), stored USD price, their price-alert target (target_price_usd, "
    "null = no alert) and when they started watching. Use this when the user asks about their watchlist, "
    "wishlist, watched cards or price alerts — in Ekalight it is called the Watchlist."
)

PRICE_LOWS_DESCRIPTION = (
    "Cards whose raw USD price dropped at least 25% from their high in the window and now sit at or near "
    "(within 5% of) that window's low, biggest drop first. Use for 'what's a good buy', 'what should I "
    "invest in', 'what's cheap right now', 'what's at its low'. Each card has low_usd, high_usd, "
    "pct_below_high, at_window_low and days_covered (history actually available; under a year means the "
    "'1y low' covers only that span). owned='owned' checks the user's own cards. Past prices only; "
    "this is not a forecast."
)
MARKET_TRENDS_DESCRIPTION = (
    "What's trending: the top rising raw cards (change_pct, change_usd over cards_window_days) and the "
    "English sets rising and falling most (basket of each set's top-10 cards, window 7d/30d/90d). Use for "
    "'what's hot', 'what's trending', 'which sets are going up', and with find_price_lows for "
    "'what's a good buy'. USD; past moves only, not a forecast."
)

# Art facets the CardFilter can filter on (list_facets hides the rest).
FILTERABLE_FACETS = art_search.LIST_FILTER_FACETS


def usd_price(pricing: dict[str, Any] | None) -> tuple[float | None, str | None]:
    """(price, source) for a USD summary, else (None, None).

    Never yen. JPY-priced cards come back FX-converted to USD, exactly as the
    app shows them; the source says so."""
    if not isinstance(pricing, dict):
        return None, None
    if str(pricing.get("currencyCode") or "").strip().upper() != "USD":
        return None, None
    for key in ("market", "mid", "low", "trend"):
        value = pricing.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            source = price_source_label(pricing)
            if pricing.get("displayIsConverted"):
                source += " (converted to USD from JPY)"
            return round(float(value), 2), source
    return None, None


def price_source_label(pricing: dict[str, Any]) -> str:
    """Who supplied the served number. `source`/`provider` name the snapshot ROW's
    provider (Scrydex) even when the TCGCSV main lane served the raw headline;
    `mainPriceSource` is the per-read stamp that says which lane actually won."""
    if str(pricing.get("mainPriceSource") or "").strip().lower() == RAW_MAIN_PRICE_SOURCE_TCGCSV:
        return "tcgplayer"
    source = str(pricing.get("source") or pricing.get("provider") or "").strip().lower()
    if source == TCGCSV_PROVIDER:  # printing-cell summaries stamp the provider directly
        return "tcgplayer"
    return source or "ekalight"


def printing_name(value: Any) -> str | None:
    """Human printing name for a stored variant: "First Edition Shadowless Holofoil"
    -> "1st Edition Shadowless Holofoil"; blank -> None."""
    text = " ".join(str(value or "").split())
    if not text:
        return None
    return re.sub(r"^first edition\b", "1st Edition", text, flags=re.IGNORECASE)


def _round_money(value: float | None) -> float | None:
    return None if value is None else round(float(value), 2)


class CollectionTools:
    def __init__(self, service: Any, *, app_url_scheme: str = "spotlight") -> None:
        self.service = service
        self.app_url_scheme = app_url_scheme.strip().rstrip(":/") or "spotlight"

    @property
    def conn(self):
        return self.service.connection

    # ------------------------------------------------------------------
    # Shared helpers
    # ------------------------------------------------------------------

    def _art_call(self, fn_name: str, *args: Any, **kwargs: Any) -> Any:
        try:
            return getattr(art_search, fn_name)(*args, **kwargs)
        except art_search.ArtFilterError as error:
            raise ToolInputError(str(error)) from None

    def app_url(self, card_id: str) -> str:
        # RN route: app/(stack)/cards/[cardId].tsx — groups are not in the URL.
        return f"{self.app_url_scheme}://cards/{quote(str(card_id), safe='')}"

    def _card_summary(
        self, card: dict[str, Any], pricing: dict[str, Any] | None, *, tcgplayer_id: str | None = None
    ) -> dict[str, Any]:
        # Full internal shape; policy.ResponsePolicy decides what leaves the server.
        price, source = usd_price(pricing)
        game = card.get("game") or GAME
        return {
            "card_id": card["id"],
            "name": card.get("name"),
            "set": card.get("setName"),
            "set_code": card.get("setPtcgoCode") or card.get("setID"),
            "number": card.get("number"),
            "language": card.get("language"),
            "rarity_bucket": card.get("rarityBucket") or rarity_bucket(card.get("rarity"), game),
            "artist": card.get("artist"),
            "image_small_url": card.get("imageSmallURL") or card.get("imageURL"),
            "price_usd": price,
            "price_source": source,
            "app_url": self.app_url(card["id"]),
            "tcgplayer_id": tcgplayer_id,
        }

    def _tcgplayer_ids(self, card_ids: list[str]) -> dict[str, str]:
        out: dict[str, str] = {}
        for chunk in _chunked_sql_values(card_ids):
            rows = self.conn.execute(
                f"SELECT id, tcgplayer_id FROM cards WHERE id IN ({','.join('?' for _ in chunk)})",
                tuple(chunk),
            ).fetchall()
            for row in rows:
                value = str(row[1] or "").strip()
                if value:
                    out[str(row[0])] = value
        return out

    def _raw_pricing_by_id(self, card_ids: list[str]) -> dict[str, dict[str, Any] | None]:
        service = self.service
        snapshots = service._price_snapshot_rows_by_card_id(card_ids)
        day_cells = service._latest_day_cells_by_card_id(card_ids)
        context = service._raw_pricing_context()
        return {
            card_id: service._display_pricing_summary_for_context(
                card_id,
                pricing_context=context,
                snapshot_row=snapshots.get(card_id),
                day_cells=day_cells.get(card_id),
            )
            for card_id in card_ids
        }

    def _summaries(
        self, card_ids: list[str], *, cards: dict[str, dict[str, Any]] | None = None
    ) -> dict[str, dict[str, Any]]:
        ids = list(dict.fromkeys(str(card_id) for card_id in card_ids if card_id))
        if not ids:
            return {}
        if cards is None:
            cards = cards_by_ids(self.conn, ids, include_source_payload=False)
        present = [card_id for card_id in ids if card_id in cards]
        pricing = self._raw_pricing_by_id(present)
        tcg_ids = self._tcgplayer_ids(present)
        return {
            card_id: self._card_summary(cards[card_id], pricing.get(card_id), tcgplayer_id=tcg_ids.get(card_id))
            for card_id in present
        }

    def _owned_card_ids(self, owner_user_id: str, *, collection_id: str | None = None) -> set[str]:
        # Ownership counts hidden collections too (you still own those cards);
        # only value totals follow the hidden-collection exclusion.
        sql = "SELECT DISTINCT card_id FROM deck_entries WHERE owner_user_id = ? AND quantity > 0"
        params: list[Any] = [owner_user_id]
        if collection_id:
            sql += " AND collection_id = ?"
            params.append(collection_id)
        return {str(row[0]) for row in self.conn.execute(sql, params).fetchall()}

    def _require_collection(self, owner_user_id: str, collection_id: str | None) -> str | None:
        collection_id = str(collection_id or "").strip() or None
        if collection_id is None:
            return None
        row = self.conn.execute(
            "SELECT 1 FROM collections WHERE id = ? AND owner_user_id = ?",
            (collection_id, owner_user_id),
        ).fetchone()
        if row is None:
            raise ToolInputError("Collection not found.")
        return collection_id

    @staticmethod
    def _query_hash(*parts: Any) -> str:
        raw = json.dumps(parts, sort_keys=True, default=str).encode()
        return hashlib.sha256(raw).hexdigest()[:12]

    @staticmethod
    def _offset_from_cursor(cursor: str | None, *, kind: str, query_hash: str) -> int:
        payload = decode_cursor(cursor, kind=kind)
        if payload is None:
            return 0
        if payload.get("q") != query_hash:
            raise ToolInputError("cursor belongs to a different query; start again without cursor.")
        offset = payload.get("o")
        if not isinstance(offset, int) or offset < 0:
            raise ToolInputError("cursor is invalid; pass next_cursor from the previous call.")
        return offset

    @staticmethod
    def _matches_card_meta(card: dict[str, Any], card_filter: dict[str, Any]) -> bool:
        """Non-art, non-price filter fields against a catalog card dict."""
        text = card_filter.get("text")
        if text:
            haystack = " ".join(
                str(card.get(key) or "") for key in ("name", "setName", "number", "artist")
            ).casefold()
            if not all(token in haystack for token in text.casefold().split()):
                return False
        artist = card_filter.get("artist")
        if artist and artist.casefold() not in str(card.get("artist") or "").casefold():
            return False
        set_query = card_filter.get("set")
        if set_query:
            needle = set_query.casefold()
            set_name = str(card.get("setName") or "").casefold()
            exact_codes = {
                str(card.get("setID") or "").casefold(),
                str(card.get("setPtcgoCode") or "").casefold(),
            }
            if needle not in set_name and needle not in exact_codes:
                return False
        language = card_filter.get("language")
        if language and str(card.get("language") or "").casefold() != language.casefold():
            return False
        buckets = card_filter.get("rarity_bucket")
        if buckets:
            bucket = card.get("rarityBucket") or rarity_bucket(card.get("rarity"), card.get("game"))
            if bucket not in buckets:
                return False
        return True

    @staticmethod
    def _matches_price(price: float | None, card_filter: dict[str, Any]) -> bool:
        low = card_filter.get("price_min_usd")
        high = card_filter.get("price_max_usd")
        if low is None and high is None:
            return True
        if price is None:
            return False
        if low is not None and price < low:
            return False
        if high is not None and price > high:
            return False
        return True

    @staticmethod
    def _is_structured(card_filter: dict[str, Any]) -> bool:
        return not card_filter.get("text") and bool(card_filter.get("artist") or card_filter.get("set"))

    def _structured_rows(self, card_filter: dict[str, Any], *, order: str) -> tuple[list[Any], bool] | None:
        """Every catalog row matching artist/set/language (+ a loose price window),
        straight from SQL, or None when the filter needs relevance search (text, or
        neither artist nor set). Relevance search caps its pool by text score and
        breaks ties pricier-first, so filtering price/artist after it lost every
        cheap match of a prolific artist; this applies them before any cap."""
        if not self._is_structured(card_filter):
            return None
        approx = (
            "COALESCE(s.main_raw_market_price, "
            "CASE WHEN s.display_currency_code = 'USD' THEN s.default_raw_market_price END)"
        )
        # Unary + keeps game/language off idx_cards_game (it selects the whole table).
        where = ["+c.game = ?", "COALESCE(c.supertype, '') != ?"]
        params: list[Any] = [GAME, SEALED_SUPERTYPE]
        artist = card_filter.get("artist")
        if artist:
            tokens = tokenize(artist)
            if tokens and self._has_table("card_artist_aliases"):
                for token in tokens:
                    where.append(
                        "c.id IN (SELECT card_id FROM card_artist_aliases "
                        "WHERE normalized_token >= ? AND normalized_token < ?)"
                    )
                    params.extend([token, token + "\U0010ffff"])
            else:
                where.append("c.artist LIKE ?")
                params.append(f"%{artist}%")
        set_query = card_filter.get("set")
        if set_query:
            needle = set_query.casefold()
            # DISTINCT over idx_cards_set_name is index-only; the substring match
            # mirrors _matches_card_meta.
            names = [
                str(row[0])
                for row in self.conn.execute("SELECT DISTINCT set_name FROM cards").fetchall()
                if row[0] and needle in str(row[0]).casefold()
            ]
            codes = list(dict.fromkeys([set_query, set_query.lower(), set_query.upper()]))
            marks = ",".join("?" for _ in codes)
            clauses = [f"c.set_id IN ({marks})", f"c.set_ptcgo_code IN ({marks})"]
            if names:
                clauses.append(f"c.set_name IN ({','.join('?' for _ in names)})")
            where.append("(" + " OR ".join(clauses) + ")")
            params.extend(codes + codes + names)
        if card_filter.get("language"):
            where.append("+c.language = ? COLLATE NOCASE")
            params.append(card_filter["language"])
        low = card_filter.get("price_min_usd")
        high = card_filter.get("price_max_usd")
        if low is not None:
            where.append(f"({approx} IS NULL OR {approx} >= ?)")
            params.append(low / PRICE_WINDOW_SLACK)
        if high is not None:
            where.append(f"({approx} IS NULL OR {approx} <= ?)")
            params.append(high * PRICE_WINDOW_SLACK + 1.0)
        # The ceiling keeps the end the caller pages from: cheapest for price_asc.
        direction = "ASC" if order == "price_asc" else "DESC"
        rows = self.conn.execute(
            f"""
            SELECT c.id, c.game, c.rarity, c.set_release_date, c.artist, c.set_name AS setName,
                   c.set_id AS setID, c.set_ptcgo_code AS setPtcgoCode, c.language, {approx} AS approx
            FROM cards c LEFT JOIN card_price_snapshots s ON s.card_id = c.id
            WHERE {' AND '.join(where)}
            ORDER BY (approx IS NULL), approx {direction}, c.id
            LIMIT ?
            """,
            (*params, STRUCTURED_ROW_CEILING + 1),
        ).fetchall()
        return rows[:STRUCTURED_ROW_CEILING], len(rows) > STRUCTURED_ROW_CEILING

    def _catalog_pool(
        self,
        card_filter: dict[str, Any],
        *,
        size: int,
        order: str = "relevance",
        owned_ids: set[str] | None = None,
        owned_mode: str = "any",
        keep_owned: bool = False,
    ) -> tuple[list[dict[str, Any]], bool, int | None]:
        """Catalog candidates passing the non-price filters, plus (capped, exact
        total). `exact_total` is the full match count when it is known exactly
        (structured filter, no price filter), else None. Structured pools apply
        `owned_mode` before the cap; `keep_owned` adds every owned match on top
        of the capped not-owned side (find_missing counts owned exactly)."""
        structured = self._structured_rows(card_filter, order=order)
        if structured is not None:
            return self._structured_pool(
                card_filter, structured, size=size, order=order,
                owned_ids=owned_ids or set(), owned_mode=owned_mode, keep_owned=keep_owned,
            )
        pool, capped = self._relevance_pool(card_filter, size=size)
        return pool, capped, None

    def _structured_pool(
        self,
        card_filter: dict[str, Any],
        structured: tuple[list[Any], bool],
        *,
        size: int,
        order: str,
        owned_ids: set[str],
        owned_mode: str,
        keep_owned: bool,
    ) -> tuple[list[dict[str, Any]], bool, int | None]:
        rows, ceiling_hit = structured
        # The SQL is a superset (token prefixes, code case variants); the exact
        # meta check here keeps exact_total exact. Rarity buckets apply here too.
        meta_filter = {k: v for k, v in card_filter.items() if k != "text"}
        rows = [row for row in rows if self._matches_card_meta(dict(row), meta_filter)]
        if order == "newest":
            rows = sorted(rows, key=lambda row: str(row["set_release_date"] or ""), reverse=True)
        owned_rows = [row for row in rows if row["id"] in owned_ids]
        if owned_mode == "owned":
            candidates = owned_rows
        elif owned_mode == "not_owned":
            candidates = [row for row in rows if row["id"] not in owned_ids]
        else:
            candidates = rows
        extra = owned_rows if keep_owned and owned_mode == "not_owned" else []
        capped = ceiling_hit or len(candidates) > size
        has_price_filter = "price_min_usd" in card_filter or "price_max_usd" in card_filter
        exact_total = None if (has_price_filter or ceiling_hit) else len(candidates) + len(extra)
        ids = [str(row["id"]) for row in candidates[:size] + extra]
        cards = cards_by_ids(self.conn, ids, include_source_payload=False)
        return [cards[card_id] for card_id in ids if card_id in cards], capped, exact_total

    def _relevance_pool(self, card_filter: dict[str, Any], *, size: int) -> tuple[list[dict[str, Any]], bool]:
        """Catalog search candidates (search order) passing the non-price filters.
        Second value: True when the underlying search hit its pool cap."""
        size = min(size, CATALOG_SEARCH_MAX_RESULTS)
        terms: list[str] = []
        if card_filter.get("text"):
            terms.append(card_filter["text"])
        if card_filter.get("artist"):
            # Artist tokens are indexed by catalog search (card_artist_aliases).
            terms.append(card_filter["artist"])
        if card_filter.get("set"):
            terms.append('set:"{}"'.format(card_filter["set"].replace('"', "")))
        buckets = card_filter.get("rarity_bucket") or []
        if not terms and not buckets:
            raise ToolInputError(
                "Give at least one of text, set, artist, rarity_bucket, or an art filter "
                "(pokemon, scene, mood, theme, ...)."
            )
        query = " ".join(terms)
        raw_results: list[dict[str, Any]] = []
        capped = False
        bucket_args: list[str | None] = [buckets[0]] if len(buckets) == 1 else (buckets if not terms else [None])
        for bucket in bucket_args:
            found = list(
                catalog_search_cards(
                    self.conn,
                    query,
                    limit=size,
                    game=GAME,
                    offset=0,
                    pool_ceiling=_MANUAL_SEARCH_POOL_CEILING,
                    rarity_bucket_filter=bucket,
                )
            )
            capped = capped or len(found) >= size
            raw_results.extend(found)
        seen: set[str] = set()
        pool: list[dict[str, Any]] = []
        for card in raw_results:
            card_id = str(card.get("id") or "")
            if not card_id or card_id in seen:
                continue
            seen.add(card_id)
            # `text` already drove retrieval; re-checking it here would drop alias/typo hits.
            if self._matches_card_meta(card, {k: v for k, v in card_filter.items() if k != "text"}):
                pool.append(card)
        return pool, capped

    def _art_ids(
        self,
        card_filter: dict[str, Any],
        *,
        owned_card_ids: set[str] | None,
        owned_mode: str,
        sort: str,
        max_ids: int,
    ) -> tuple[list[str], int, bool]:
        """Page art_search up to `max_ids`. Returns (ids, total_estimate, capped)."""
        ids: list[str] = []
        cursor: str | None = None
        total = 0
        while len(ids) < max_ids:
            result = self._art_call(
                "search_card_ids",
                self.conn,
                card_filter,
                owned_card_ids=owned_card_ids,
                owned_mode=owned_mode,
                sort=sort,
                limit=min(ART_PAGE_SIZE, max_ids - len(ids)),
                cursor=cursor,
            )
            ids.extend(str(card_id) for card_id in result.get("card_ids") or [])
            total = int(result.get("total_estimate") or len(ids))
            cursor = result.get("next_cursor")
            if not cursor:
                return list(dict.fromkeys(ids)), total, False
        return list(dict.fromkeys(ids))[:max_ids], total, True

    @staticmethod
    def _sort_by_price(items: list[dict[str, Any]], *, descending: bool, key: str = "price_usd") -> list[dict[str, Any]]:
        priced = [item for item in items if item.get(key) is not None]
        unpriced = [item for item in items if item.get(key) is None]
        priced.sort(key=lambda item: item[key], reverse=descending)
        return priced + unpriced

    # ------------------------------------------------------------------
    # Tools
    # ------------------------------------------------------------------

    def _art_coverage(self) -> dict[str, Any]:
        tagged = self.conn.execute("SELECT COUNT(*) FROM card_art_group_members").fetchone()[0] if self._has_table(
            "card_art_group_members"
        ) else 0
        total = self.conn.execute("SELECT COUNT(*) FROM cards WHERE game = ?", (GAME,)).fetchone()[0]
        return {
            "tagged_cards": int(tagged),
            "catalog_cards": int(total),
            "note": f"Art tags cover {tagged:,} of {total:,} cards so far; untagged cards never match art filters.",
        }

    def _has_table(self, name: str) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
        ).fetchone() is not None

    def list_facets(self, owner_user_id: str) -> dict[str, Any]:
        del owner_user_id  # catalog-wide; no account data
        result = self._art_call("list_facets", self.conn, game=GAME)
        facets = result.get("facets") or {}
        return {
            "facets": {facet: facets.get(facet) or [] for facet in FILTERABLE_FACETS},
            "themes": result.get("themes") or [],
            "art_coverage": self._art_coverage(),
        }

    def search_cards(
        self,
        owner_user_id: str,
        card_filter: dict[str, Any] | None,
        *,
        owned: str = "any",
        sort: str = "relevance",
        limit: int | None = 20,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        card_filter = normalize_card_filter(card_filter)
        if owned not in OWNED_MODES:
            raise ToolInputError(f"owned must be one of {', '.join(OWNED_MODES)}.")
        if sort not in SEARCH_SORTS:
            raise ToolInputError(f"sort must be one of {', '.join(SEARCH_SORTS)}.")
        limit = clamp_limit(limit, default=20, maximum=50)
        owned_ids = self._owned_card_ids(owner_user_id) if owned != "any" else None
        query_hash = self._query_hash(card_filter, owned, sort)

        if uses_art_filters(card_filter):
            payload = decode_cursor(cursor, kind="search_art")
            if payload is not None and payload.get("q") != query_hash:
                raise ToolInputError("cursor belongs to a different query; start again without cursor.")
            result = self._art_call(
                "search_card_ids",
                self.conn,
                card_filter,
                owned_card_ids=owned_ids,
                owned_mode=owned,
                sort=sort,
                limit=limit,
                cursor=(payload or {}).get("c"),
            )
            ids = [str(card_id) for card_id in (result.get("card_ids") or [])][:limit]
            summaries = self._summaries(ids)
            next_art = result.get("next_cursor")
            return {
                "results": [summaries[card_id] for card_id in ids if card_id in summaries],
                "next_cursor": encode_cursor({"k": "search_art", "q": query_hash, "c": next_art})
                if next_art
                else None,
                "total_estimate": int(result.get("total_estimate") or len(ids)),
                "art_coverage": self._art_coverage(),
            }

        offset = self._offset_from_cursor(cursor, kind="search", query_hash=query_hash)
        pool, capped, exact_total = self._catalog_pool(
            card_filter, size=SEARCH_POOL_SIZE, order=sort, owned_ids=owned_ids, owned_mode=owned
        )
        if owned_ids is not None:
            pool = [card for card in pool if (card["id"] in owned_ids) == (owned == "owned")]
        cards = {card["id"]: card for card in pool}
        needs_prices = sort in ("price_asc", "price_desc") or (
            "price_min_usd" in card_filter or "price_max_usd" in card_filter
        )
        if needs_prices:
            summaries = self._summaries(list(cards), cards=cards)
            items = [summaries[card["id"]] for card in pool if card["id"] in summaries]
            items = [item for item in items if self._matches_price(item["price_usd"], card_filter)]
            if sort in ("price_asc", "price_desc"):
                items = self._sort_by_price(items, descending=sort == "price_desc")
            page = items[offset : offset + limit]
            total = len(items)
        else:
            ordered = pool
            if sort == "newest":
                ordered = sorted(pool, key=lambda card: str(card.get("setReleaseDate") or ""), reverse=True)
            page_ids = [card["id"] for card in ordered[offset : offset + limit]]
            summaries = self._summaries(page_ids, cards=cards)
            page = [summaries[card_id] for card_id in page_ids if card_id in summaries]
            total = len(ordered)
        next_offset = offset + limit
        return {
            "results": page,
            "next_cursor": encode_cursor({"k": "search", "q": query_hash, "o": next_offset})
            if next_offset < total
            else None,
            # Pages stop at the pool; the count need not when it is known exactly.
            "total_estimate": exact_total if exact_total is not None else total,
            **({"total_is_lower_bound": True} if capped and exact_total is None else {}),
        }

    def _holdings_for_card(self, owner_user_id: str, card_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT id, condition, grader, grade, quantity, variant_name, cost_basis_total,
                   cost_basis_currency_code, cost_basis_cents
            FROM deck_entries
            WHERE owner_user_id = ? AND card_id = ? AND quantity > 0
            ORDER BY added_at, id
            LIMIT 50
            """,
            (owner_user_id, card_id),
        ).fetchall()
        holdings = []
        default_raw_variant: str | None = None
        for row in rows:
            grader = str(row["grader"] or "").strip() or None
            grade = str(row["grade"] or "").strip() or None
            quantity = int(row["quantity"] or 0)
            if quantity <= 0:
                continue
            variant = printing_name(row["variant_name"])
            if variant is None and not (grader or grade):
                # A raw copy with no stored printing is valued as the card's
                # served (main) printing; name that one.
                if default_raw_variant is None:
                    served = self._raw_pricing_by_id([card_id]).get(card_id) or {}
                    default_raw_variant = printing_name(served.get("variant")) or ""
                variant = default_raw_variant or None
            holdings.append(
                {
                    "holding_id": str(row["id"]),
                    "condition": None
                    if (grader or grade)
                    else DECK_CONDITION_CODES.get(str(row["condition"] or "").strip().lower()),
                    "grader": grader,
                    "grade": grade,
                    "variant": variant,
                    "quantity": quantity,
                    "cost_basis_usd": self._cost_basis_usd(
                        total=row["cost_basis_total"],
                        cents_per_unit=row["cost_basis_cents"],
                        currency=row["cost_basis_currency_code"],
                        quantity=quantity,
                    ),
                }
            )
        return holdings

    @staticmethod
    def _cost_basis_usd(*, total: Any, cents_per_unit: Any, currency: Any, quantity: int) -> float | None:
        if str(currency or "USD").strip().upper() not in ("", "USD"):
            return None
        try:
            total_value = float(total or 0.0)
        except (TypeError, ValueError):
            total_value = 0.0
        if total_value > 0:
            return round(total_value, 2)
        if cents_per_unit is not None:
            try:
                return round(float(cents_per_unit) * max(quantity, 0) / 100.0, 2)
            except (TypeError, ValueError):
                return None
        return None

    def get_card(self, owner_user_id: str, card_id: str, *, include_holdings: bool = True) -> dict[str, Any]:
        card_id = str(card_id or "").strip()
        card = card_by_id(self.conn, card_id) if card_id else None
        if card is None:
            raise ToolInputError(f"Card not found: {card_id or '(empty)'}.")
        summary = self._summaries([card_id], cards={card_id: card})[card_id]

        art = art_search.get_card_art(self.conn, card_id)

        similar_payload = build_similar_cards_payload(self.conn, card_id)
        similar: list[str] = []
        goes_with = similar_payload.get("goesWith")
        for entry in ([goes_with] if isinstance(goes_with, dict) else []) + list(
            similar_payload.get("sameName") or []
        ) + list(similar_payload.get("sameLookCheaper") or []):
            neighbour = str((entry or {}).get("cardId") or "")
            if neighbour and neighbour != card_id and neighbour not in similar:
                similar.append(neighbour)

        counterpart = self.service._card_counterpart(card_id)
        return {
            **summary,
            "tags": (art or {}).get("tags"),
            "alt_text": (art or {}).get("alt_text"),
            "similar": similar[:MAX_SIMILAR],
            "language_pair": counterpart["counterpart_card_id"] if counterpart is not None else None,
            "my_holdings": self._holdings_for_card(owner_user_id, card_id) if include_holdings else [],
        }

    def _holding_summary(
        self, entry: dict[str, Any], card: dict[str, Any], *, tcgplayer_id: str | None = None
    ) -> dict[str, Any]:
        # The entry's own pricing: graded holdings carry their slab price.
        pricing = (entry.get("card") or {}).get("pricing")
        summary = self._card_summary(card, pricing, tcgplayer_id=tcgplayer_id)
        quantity = int(entry.get("quantity") or 0)
        slab = entry.get("slabContext") or {}
        grader = slab.get("grader")
        grade = slab.get("grade")
        unit = summary["price_usd"]
        value = round(unit * quantity, 2) if unit is not None else None
        cost = self._cost_basis_usd(
            total=entry.get("costBasisTotal"),
            cents_per_unit=entry.get("costBasisCents"),
            currency=entry.get("costBasisCurrencyCode"),
            quantity=quantity,
        )
        gain, gain_basis = None, None
        if value is not None and cost:
            gain, gain_basis = round(value - cost, 2), "cost_basis"
        elif value is not None and isinstance(entry.get("sinceAddedChangeAmount"), (int, float)):
            # No cost basis recorded: market move since the card was added.
            gain, gain_basis = round(float(entry["sinceAddedChangeAmount"]) * quantity, 2), "since_added"
        return {
            **summary,
            "holding_id": str(entry["id"]) if entry.get("id") is not None else None,
            "quantity": quantity,
            "condition": None
            if (grader or grade)
            else DECK_CONDITION_CODES.get(str(entry.get("condition") or "").lower()),
            "grader": grader,
            "grade": grade,
            # The owned printing; else the one the entry was priced as.
            "variant": printing_name(entry.get("variantName"))
            or printing_name((pricing or {}).get("variant")),
            "value_usd": value,
            "gain_usd": gain,
            "gain_basis": gain_basis,
            "collection": entry.get("collectionName"),
            "added_at": entry.get("addedAt"),
        }

    def _owner_holdings(
        self, owner_user_id: str, *, collection_id: str | None
    ) -> tuple[list[tuple[dict[str, Any], dict[str, Any]]], dict[str, str], bool]:
        """[(deck entry payload, catalog card)] via the app's own cached inventory
        compute. Un-scoped reads exclude hidden collections, like "All Collection"."""
        payload = self.service.deck_entries_for_owner(
            owner_user_id,
            limit=MAX_HOLDINGS_READ,
            offset=0,
            include_inactive=False,
            compute_day_change=False,
            collection_id=collection_id,
            include_series=False,
            log_surface="mcp",
        )
        raw_entries = list(payload.get("entries") or [])
        # Zero/NULL-quantity duplicate rows are not holdings and carry no value.
        entries = [entry for entry in raw_entries if int(entry.get("quantity") or 0) > 0]
        card_ids = [str((entry.get("card") or {}).get("id") or "") for entry in entries]
        cards = cards_by_ids(self.conn, card_ids, include_source_payload=False)
        pairs = [
            (entry, cards[card_id])
            for entry, card_id in zip(entries, card_ids)
            if card_id in cards
        ]
        return pairs, self._tcgplayer_ids(list(cards)), len(raw_entries) >= MAX_HOLDINGS_READ

    def get_my_collection(
        self,
        owner_user_id: str,
        card_filter: dict[str, Any] | None = None,
        *,
        collection_id: str | None = None,
        sort: str = "value_desc",
        limit: int | None = 50,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        card_filter = normalize_card_filter(card_filter)
        if sort not in COLLECTION_SORTS:
            raise ToolInputError(f"sort must be one of {', '.join(COLLECTION_SORTS)}.")
        limit = clamp_limit(limit, default=50, maximum=100)
        collection_id = self._require_collection(owner_user_id, collection_id)
        query_hash = self._query_hash(card_filter, collection_id, sort)
        offset = self._offset_from_cursor(cursor, kind="collection", query_hash=query_hash)

        pairs, tcg_ids, truncated = self._owner_holdings(owner_user_id, collection_id=collection_id)
        if uses_art_filters(card_filter):
            owned_ids = {card["id"] for _, card in pairs}
            art_ids, _, _ = self._art_ids(
                card_filter,
                owned_card_ids=owned_ids,
                owned_mode="owned",
                sort="relevance",
                max_ids=MAX_HOLDINGS_READ,
            )
            allowed = set(art_ids) & owned_ids
            pairs = [(entry, card) for entry, card in pairs if card["id"] in allowed]
        else:
            pairs = [(entry, card) for entry, card in pairs if self._matches_card_meta(card, card_filter)]

        items = [self._holding_summary(entry, card, tcgplayer_id=tcg_ids.get(card["id"])) for entry, card in pairs]
        items = [item for item in items if self._matches_price(item["price_usd"], card_filter)]
        if sort == "value_desc":
            items = self._sort_by_price(items, descending=True, key="value_usd")
        elif sort == "gain_desc":
            items = self._sort_by_price(items, descending=True, key="gain_usd")
        else:
            items.sort(key=lambda item: str(item.get("added_at") or ""), reverse=True)

        total_value = sum(item["value_usd"] for item in items if item["value_usd"] is not None)
        next_offset = offset + limit
        return {
            "items": items[offset : offset + limit],
            "total_value_usd": round(total_value, 2),
            "total_count": len(items),
            "unpriced_count": sum(1 for item in items if item["value_usd"] is None),
            "next_cursor": encode_cursor({"k": "collection", "q": query_hash, "o": next_offset})
            if next_offset < len(items)
            else None,
            **({"truncated_at": MAX_HOLDINGS_READ} if truncated else {}),
        }

    def get_my_watchlist(
        self, owner_user_id: str, *, limit: int | None = 50, cursor: str | None = None
    ) -> dict[str, Any]:
        """The owner's Watchlist (`card_favorites`), newest first. DB-only: a
        printing watch is priced from its stored TCGplayer cell, everything else
        from the card's stored main price."""
        limit = clamp_limit(limit, default=50, maximum=100)
        query_hash = self._query_hash("watchlist")
        offset = self._offset_from_cursor(cursor, kind="watchlist", query_hash=query_hash)
        columns = {str(row[1]) for row in self.conn.execute("PRAGMA table_info(card_favorites)").fetchall()}
        optional = [name for name in ("target_price_cents", "target_triggered_at") if name in columns]
        variant_sql = "variant_key" if "variant_key" in columns else "'' AS variant_key"
        rows = self.conn.execute(
            f"""
            SELECT card_id, {variant_sql}, created_at{''.join(', ' + name for name in optional)}
            FROM card_favorites
            WHERE owner_user_id = ?
            ORDER BY created_at DESC, card_id ASC
            LIMIT ?
            """,
            (owner_user_id, MAX_WATCHLIST_READ + 1),
        ).fetchall()
        truncated = len(rows) > MAX_WATCHLIST_READ
        rows = rows[:MAX_WATCHLIST_READ]
        page_rows = rows[offset : offset + limit]
        summaries = self._summaries([str(row["card_id"]) for row in page_rows])
        variant_keys = [
            (str(row["card_id"]), key)
            for row in page_rows
            if (key := watch_printings.normalize_variant_key(row["variant_key"]))
        ]
        printing_prices = watch_printings.latest_printing_prices(self.conn, variant_keys) if variant_keys else {}
        items = []
        for row in page_rows:
            card_id = str(row["card_id"])
            summary = summaries.get(card_id)
            if summary is None:
                continue
            key = watch_printings.normalize_variant_key(row["variant_key"])
            item = dict(summary)
            if key:
                market = (printing_prices.get((card_id, key)) or {}).get("market")
                # A printing watch quotes its own printing, never the main one.
                item["price_usd"] = round(float(market), 2) if isinstance(market, (int, float)) else None
                item["price_source"] = "tcgplayer" if item["price_usd"] is not None else None
            cents = row["target_price_cents"] if "target_price_cents" in optional else None
            item.update(
                {
                    "watch_variant": printing_name(watch_printings.printing_label(key)) if key else None,
                    "target_price_usd": round(int(cents) / 100.0, 2) if cents is not None else None,
                    "target_triggered_at": row["target_triggered_at"] if "target_triggered_at" in optional else None,
                    "watched_at": row["created_at"],
                }
            )
            items.append(item)
        next_offset = offset + limit
        return {
            "items": items,
            "total_count": len(rows),
            "next_cursor": encode_cursor({"k": "watchlist", "q": query_hash, "o": next_offset})
            if next_offset < len(rows)
            else None,
            **({"truncated_at": MAX_WATCHLIST_READ} if truncated else {}),
        }

    def get_portfolio_summary(self, owner_user_id: str, *, range_key: str = "30d") -> dict[str, Any]:
        if range_key not in PORTFOLIO_RANGES:
            raise ToolInputError(f"range must be one of {', '.join(PORTFOLIO_RANGES)}.")
        start_date = (datetime.now(timezone.utc).date() - timedelta(days=PORTFOLIO_RANGES[range_key])).isoformat()
        pairs, _, truncated = self._owner_holdings(owner_user_id, collection_id=None)

        holdings: list[dict[str, Any]] = []
        requests: list[dict[str, Any]] = []
        for entry, card in pairs:
            holding = self._holding_summary(entry, card)
            holdings.append(holding)
            pricing = (entry.get("card") or {}).get("pricing") or {}
            # FX-converted prices have native-currency history; no USD start point.
            if holding["price_usd"] is None or pricing.get("displayIsConverted"):
                continue
            slab = entry.get("slabContext") or {}
            is_graded = bool(slab.get("grader") or slab.get("grade"))
            added = str(entry.get("addedAt") or "")[:10]
            requests.append(
                {
                    "key": str(entry["id"]),
                    "card_id": card["id"],
                    "pricing_mode": PSA_GRADE_PRICING_MODE if is_graded else RAW_PRICING_MODE,
                    "variant": entry.get("variantName") or (str(pricing.get("variant") or "").strip() or None),
                    "condition": None if is_graded else entry.get("condition"),
                    "grader": slab.get("grader") if is_graded else None,
                    "grade": slab.get("grade") if is_graded else None,
                    # Cards added mid-range are measured from their add day.
                    "since": max(start_date, added) if added else start_date,
                    "printing_points": None,
                }
            )
            holding["_key"] = str(entry["id"])

        series = self.service._since_baseline_points_for_requests(requests, lane_scoped=True) if requests else {}
        graded_keys = {req["key"] for req in requests if req["pricing_mode"] == PSA_GRADE_PRICING_MODE}
        movers: list[dict[str, Any]] = []
        excluded = 0
        change_total = 0.0
        start_total = 0.0
        for holding in holdings:
            key = holding.pop("_key", None) or ""
            # USD days only: JP cards' older days are Scrydex JPY cells.
            points = [p for p in series.get(key) or [] if p.get("currency") == "USD"]
            if len(points) < 2 or holding["price_usd"] is None:
                continue
            start_unit = float(points[0]["value"])
            if not self._trusted_baseline(
                holding["card_id"],
                points[0]["date"],
                start_unit,
                current=holding["price_usd"],
                graded=key in graded_keys,
            ):
                excluded += 1
                continue
            change = (holding["price_usd"] - start_unit) * holding["quantity"]
            change_total += change
            start_total += start_unit * holding["quantity"]
            movers.append(
                {
                    **{k: holding[k] for k in ("card_id", "name", "set", "number", "language", "app_url")},
                    "holding_id": holding.get("holding_id"),
                    "quantity": holding["quantity"],
                    "condition": holding["condition"],
                    "grader": holding["grader"],
                    "grade": holding["grade"],
                    "variant": holding.get("variant"),
                    "value_usd": holding["value_usd"],
                    "baseline_date": points[0]["date"],
                    "baseline_price_usd": round(start_unit, 2),
                    "change_usd": round(change, 2),
                    "change_pct": round(change / (start_unit * holding["quantity"]) * 100, 2)
                    if start_unit > 0 and holding["quantity"] > 0
                    else None,
                }
            )
        value = sum(holding["value_usd"] for holding in holdings if holding["value_usd"] is not None)
        gainers = sorted((m for m in movers if m["change_usd"] > 0), key=lambda m: m["change_usd"], reverse=True)
        losers = sorted((m for m in movers if m["change_usd"] < 0), key=lambda m: m["change_usd"])
        has_history = bool(movers)
        return {
            "range": range_key,
            "value_usd": round(value, 2),
            "change_usd": round(change_total, 2) if has_history else None,
            "change_pct": round(change_total / start_total * 100, 2) if start_total > 0 else None,
            "change_covers_holdings": len(movers),
            "change_excluded_holdings": excluded,
            **({} if has_history else {"change_note": "No price history for these holdings in this range, so change is unknown (not zero)."}),
            **(
                {"change_excluded_note": "Holdings whose start price is implausible next to today's (bad provider history point) are left out of change."}
                if excluded
                else {}
            ),
            "top_gainers": gainers[:5],
            "top_losers": losers[:5],
            "holdings_count": len(holdings),
            "unpriced_count": sum(1 for holding in holdings if holding["value_usd"] is None),
            "change_basis": "market move of cards currently held (from each card's add day if added in range); excludes buys/sells",
            **({"truncated_at": MAX_HOLDINGS_READ} if truncated else {}),
        }

    # A start price more than this many times off today's is a bad history point
    # (JP Scrydex yen stamped USD, broken JP anchors) unless TCGplayer printed it.
    BASELINE_MAX_RATIO = 20.0

    def _trusted_baseline(
        self, card_id: str, price_date: str, baseline: float, *, current: float, graded: bool
    ) -> bool:
        if baseline <= 0 or current <= 0:
            return False
        ratio = baseline / current
        if 1 / self.BASELINE_MAX_RATIO <= ratio <= self.BASELINE_MAX_RATIO:
            return True
        if graded:
            return False  # graded history is Scrydex-only
        # Trust it only if it is that day's TCGCSV (TCGplayer) main-lane price.
        row = self.conn.execute(
            "SELECT main_raw_market_price FROM card_price_history_daily WHERE card_id = ? AND price_date = ?",
            (card_id, price_date),
        ).fetchone()
        main = row[0] if row is not None else None
        return isinstance(main, (int, float)) and abs(float(main) - baseline) < 0.005

    def find_missing(
        self,
        owner_user_id: str,
        card_filter: dict[str, Any] | None,
        *,
        collection_id: str | None = None,
        budget_usd: float | None = None,
        limit: int | None = 20,
    ) -> dict[str, Any]:
        card_filter = normalize_card_filter(card_filter)
        if not card_filter:
            raise ToolInputError("find_missing needs a filter, e.g. {\"set\": \"Evolving Skies\"} or a theme.")
        limit = clamp_limit(limit, default=20, maximum=50)
        if budget_usd is not None:
            try:
                budget_usd = float(budget_usd)
            except (TypeError, ValueError):
                raise ToolInputError("budget_usd must be a number.") from None
            if budget_usd < 0:
                raise ToolInputError("budget_usd must be >= 0.")
        collection_id = self._require_collection(owner_user_id, collection_id)
        owned_ids = self._owned_card_ids(owner_user_id, collection_id=collection_id)
        exact_total: int | None = None

        if uses_art_filters(card_filter):
            # Ask art_search for the not-owned side directly so the pool cap only
            # bounds what we return, and count the owned side exactly.
            pool_ids, missing_total, capped = self._art_ids(
                card_filter,
                owned_card_ids=owned_ids,
                owned_mode="not_owned",
                sort="price_asc",
                max_ids=MISSING_POOL_SIZE,
            )
            owned_side = self._art_call(
                "search_card_ids",
                self.conn,
                card_filter,
                owned_card_ids=owned_ids,
                owned_mode="owned",
                sort="relevance",
                limit=1,
            )
            summaries = self._summaries(pool_ids)
            matching = [summaries[card_id] for card_id in pool_ids if card_id in summaries]
            total_matching = missing_total + int(owned_side.get("total_estimate") or 0)
            owned_count = int(owned_side.get("total_estimate") or 0)
        else:
            pool, capped, exact_total = self._catalog_pool(
                card_filter,
                size=STRUCTURED_MISSING_POOL_SIZE if self._is_structured(card_filter) else MISSING_POOL_SIZE,
                order="price_asc",
                owned_ids=owned_ids,
                owned_mode="not_owned",
                keep_owned=True,
            )
            cards = {card["id"]: card for card in pool}
            summaries = self._summaries(list(cards), cards=cards)
            matching = [summaries[card["id"]] for card in pool if card["id"] in summaries]
            matching = [item for item in matching if self._matches_price(item["price_usd"], card_filter)]
            owned_count = sum(1 for item in matching if item["card_id"] in owned_ids)
            total_matching = exact_total if exact_total is not None else len(matching)
            missing_total = total_matching - owned_count
        missing = self._sort_by_price(
            [item for item in matching if item["card_id"] not in owned_ids], descending=False
        )
        cheapest_completion = None
        if missing and not capped and all(item["price_usd"] is not None for item in missing):
            cheapest_completion = round(sum(item["price_usd"] for item in missing), 2)

        if budget_usd is not None:
            # Cheapest-first greedy fill; unpriced cards can't be budgeted.
            picked, spent = [], 0.0
            for item in missing:
                if item["price_usd"] is None or spent + item["price_usd"] > budget_usd:
                    continue
                picked.append(item)
                spent += item["price_usd"]
            missing = picked

        page = []
        for item in missing[:limit]:
            card = {
                "id": item["card_id"],
                "name": item["name"],
                "setName": item["set"],
                "number": item["number"],
                "language": item["language"],
                "game": GAME,
            }
            page.append({**item, "buy_links": buy_links(card, tcgplayer_product_id=item.get("tcgplayer_id"))})
        counts_exact = exact_total is not None
        return {
            "missing": page,
            "missing_count": len(missing) if budget_usd is not None else max(missing_total, len(missing)),
            "owned_count": owned_count,
            "total_matching": total_matching,
            # None when capped: a completion cost over a partial list would understate it.
            "cheapest_completion_usd": cheapest_completion,
            **({"budget_spent_usd": round(sum(item["price_usd"] for item in missing), 2)} if budget_usd is not None else {}),
            **({"total_is_lower_bound": True} if capped and not counts_exact else {}),
            **(
                {"note": "Too many matches to price them all: only the cheapest missing cards were checked, "
                         "so there is no full completion cost."
                         + ("" if counts_exact else " Counts are minimums; say 'at least'.")}
                if capped
                else {}
            ),
            **({"art_coverage": self._art_coverage()} if uses_art_filters(card_filter) else {}),
        }

    def find_price_lows(
        self,
        owner_user_id: str,
        card_filter: dict[str, Any] | None = None,
        *,
        game: str | None = None,
        owned: str = "any",
        window: str = "1y",
        min_price_usd: float | None = None,
        max_price_usd: float | None = None,
        limit: int | None = 10,
    ) -> dict[str, Any]:
        """Raw cards that dropped and now sit at/near their window low, from the
        daily price_lows tables (price_lows.py). DB-only."""
        card_filter = normalize_card_filter(card_filter)
        if uses_art_filters(card_filter):
            raise ToolInputError("find_price_lows takes text/set/artist/rarity_bucket/language/price filters only.")
        if window not in PRICE_LOW_WINDOWS:
            raise ToolInputError(f"window must be one of {', '.join(PRICE_LOW_WINDOWS)}.")
        if owned not in OWNED_MODES:
            raise ToolInputError(f"owned must be one of {', '.join(OWNED_MODES)}.")
        game = self._game_arg(game)
        limit = clamp_limit(limit, default=10, maximum=MAX_PRICE_LOWS)
        low_bound, high_bound = card_filter.get("price_min_usd"), card_filter.get("price_max_usd")
        for name, value in (("min_price_usd", min_price_usd), ("max_price_usd", max_price_usd)):
            if value is None:
                continue
            try:
                amount = float(value)
            except (TypeError, ValueError):
                raise ToolInputError(f"{name} must be a number.") from None
            if amount < 0:
                raise ToolInputError(f"{name} must be >= 0.")
            if name == "min_price_usd":
                low_bound = amount if low_bound is None else max(low_bound, amount)
            else:
                high_bound = amount if high_bound is None else min(high_bound, amount)
        window_days = PRICE_LOW_WINDOWS[window]
        empty = {"cards": [], "window": window, "as_of": None}
        if not self._has_table("price_lows_runs"):
            return {**empty, "note": "Price-low data has not been computed yet."}
        run = self.conn.execute(
            "SELECT as_of_date FROM price_lows_runs WHERE window_days = ?", (window_days,)
        ).fetchone()
        if run is None:
            return {**empty, "note": "Price-low data has not been computed yet."}

        sql = (
            "SELECT card_id, variant, price_usd, low_usd, high_usd, pct_below_high, pct_above_low, "
            "days_covered, at_window_low, as_of_date FROM price_lows WHERE window_days = ?"
        )
        params: list[Any] = [window_days]
        if game:
            sql += " AND game = ?"
            params.append(game)
        if low_bound is not None:
            sql += " AND price_usd >= ?"
            params.append(low_bound)
        if high_bound is not None:
            sql += " AND price_usd <= ?"
            params.append(high_bound)
        sql += " ORDER BY pct_below_high DESC, price_usd DESC, card_id"
        rows = self.conn.execute(sql, params).fetchall()
        if owned != "any":
            owned_ids = self._owned_card_ids(owner_user_id)
            rows = [row for row in rows if (str(row[0]) in owned_ids) == (owned == "owned")]

        meta_filter = {key: value for key, value in card_filter.items() if key not in ("price_min_usd", "price_max_usd")}
        picked: list[Any] = []
        cards: dict[str, dict[str, Any]] = {}
        for offset in range(0, len(rows), 200):
            chunk = rows[offset : offset + 200]
            chunk_cards = cards_by_ids(self.conn, [str(row[0]) for row in chunk], include_source_payload=False)
            for row in chunk:
                card = chunk_cards.get(str(row[0]))
                if card is None or (meta_filter and not self._matches_card_meta(card, meta_filter)):
                    continue
                cards[card["id"]] = card
                picked.append(row)
                if len(picked) >= limit:
                    break
            if len(picked) >= limit:
                break
        summaries = self._summaries([str(row[0]) for row in picked], cards=cards)
        out: list[dict[str, Any]] = []
        for row in picked:
            summary = summaries.get(str(row[0]))
            if summary is None:
                continue
            if summary.get("price_usd") is None:
                summary["price_usd"] = _round_money(row[2])
            out.append(
                {
                    **summary,
                    "variant": printing_name(row[1]),
                    "low_usd": _round_money(row[3]),
                    "high_usd": _round_money(row[4]),
                    "pct_below_high": row[5],
                    "pct_above_low": row[6],
                    "days_covered": int(row[7]),
                    "at_window_low": bool(row[8]),
                    "as_of": row[9],
                }
            )
        result: dict[str, Any] = {"cards": out, "window": window, "as_of": run[0]}
        if any(item["days_covered"] < window_days - 7 for item in out):
            result["note"] = "Some cards have less history than the window; days_covered says how much."
        return result

    @staticmethod
    def _game_arg(game: str | None) -> str | None:
        text = str(game or "").strip().lower()
        if not text or text == "any":
            return None
        if text not in SUPPORTED_GAMES:
            raise ToolInputError(f"game must be one of {', '.join(SUPPORTED_GAMES)}.")
        return text

    def get_market_trends(
        self, owner_user_id: str, *, game: str | None = None, window: str = "30d"
    ) -> dict[str, Any]:
        """What's rising: Top Trends card gainers (the scanner process's cached
        payload) and Market Watch set trends (meta_pulse tables). DB-only."""
        del owner_user_id  # catalog-wide market data
        if window not in TREND_WINDOWS:
            raise ToolInputError(f"window must be one of {', '.join(TREND_WINDOWS)}.")
        game = self._game_arg(game)

        movers = latest_movers_payload(self.conn) or {}
        items: list[dict[str, Any]] = []
        for block in movers.get("games") or []:
            if game and block.get("game") != game:
                continue
            items.extend(item for item in block.get("items") or [] if item.get("currencyCode") == "USD")
        items.sort(key=lambda item: (-float(item.get("changePercent") or 0), str(item.get("cardId"))))
        items = items[:MAX_TREND_CARDS]
        summaries = self._summaries([str(item["cardId"]) for item in items])
        rising_cards = []
        for item in items:
            summary = summaries.get(str(item["cardId"]))
            if summary is None:
                continue
            now, then = item.get("priceNow"), item.get("priceThen")
            rising_cards.append(
                {
                    **summary,
                    "change_pct": item.get("changePercent"),
                    "change_usd": _round_money(now - then) if now is not None and then is not None else None,
                    "window_days": movers.get("windowDays"),
                }
            )

        set_game = game or GAME
        rising_sets: list[dict[str, Any]] = []
        falling_sets: list[dict[str, Any]] = []
        sets_as_of = None
        if self._has_table("meta_pulse_runs"):
            payload = meta_pulse.build_meta_pulse_payload(
                self.conn, game=set_game, window_days=TREND_WINDOWS[window], lane=meta_pulse.LANE_RAW,
                kind=meta_pulse.KIND_SETS, max_groups_per_direction=MAX_TREND_SETS, top_cards_limit=0,
            )
            sets_as_of = payload.get("asOfDate")
            for group in payload.get("groups") or []:
                entry = {
                    "set": group.get("label"),
                    "change_pct": group.get("medianChangePercent"),
                    "release_year": (group.get("releaseDate") or "")[:4] or None,
                    "card_count": group.get("cardCount"),
                }
                (rising_sets if (group.get("medianChangePercent") or 0) >= 0 else falling_sets).append(entry)
            falling_sets.sort(key=lambda entry: entry["change_pct"])

        return {
            "rising_cards": rising_cards,
            "cards_window_days": movers.get("windowDays"),
            "cards_as_of": movers.get("asOfDate"),
            "rising_sets": rising_sets[:MAX_TREND_SETS],
            "falling_sets": falling_sets[:MAX_TREND_SETS],
            "sets_game": set_game,
            "sets_window": window,
            "sets_as_of": sets_as_of,
            "note": "Sets are English main sets ranked by their top-10 cards' basket change.",
        }

    def get_price_history(
        self,
        owner_user_id: str,
        card_id: str,
        *,
        range_key: str = "90d",
        condition: str = "NM",
        grader: str | None = None,
        grade: str | None = None,
        variant: str | None = None,
    ) -> dict[str, Any]:
        """Daily USD history for one printing of a card, from stored cells only.

        Raw NM mirrors the PDP chart: the TCGplayer (TCGCSV raw_main) series for
        the printing, with Scrydex days only before the first TCGplayer day.
        Other conditions are Scrydex. Graded (grader + grade) is the Scrydex
        graded lane, plain slabs only (no signed/perfect/error cells)."""
        del owner_user_id  # catalog-wide; no account data
        if range_key not in HISTORY_RANGES:
            raise ToolInputError(f"range must be one of {', '.join(HISTORY_RANGES)}.")
        grader_code = str(grader or "").strip().upper() or None
        grade_code = self._history_grade_key(grade)
        if bool(grader_code) != bool(grade_code):
            raise ToolInputError("grader and grade must be given together, e.g. grader='PSA', grade='10'.")
        graded = grader_code is not None
        condition_code = str(condition or "NM").strip().upper()
        if not graded and condition_code not in HISTORY_CONDITIONS:
            raise ToolInputError(f"condition must be one of {', '.join(HISTORY_CONDITIONS)}.")
        card_id = str(card_id or "").strip()
        if not card_id or card_by_id(self.conn, card_id) is None:
            raise ToolInputError(f"Card not found: {card_id or '(empty)'}.")

        start_date = (datetime.now(timezone.utc).date() - timedelta(days=HISTORY_RANGES[range_key])).isoformat()
        snapshot = price_snapshot_row(self.conn, card_id)
        snapshot_keys = snapshot.keys() if snapshot is not None else ()
        main_variant = snapshot["main_raw_variant"] if "main_raw_variant" in snapshot_keys else None
        default_variant = snapshot["default_raw_variant"] if "default_raw_variant" in snapshot_keys else None

        if graded:
            scrydex = self._graded_history_cells(card_id, grader_code, grade_code, start_date)
            tcgplayer: dict[str, dict[str, Any]] = {}
        else:
            scrydex = self._raw_history_cells(card_id, HISTORY_CONDITIONS[condition_code], start_date)
            # TCGCSV is NM-only; {} when RAW_MAIN_PRICE_SOURCE is not tcgcsv (same gate as the app).
            tcgplayer = (
                main_raw_cell_points_by_variant_date(self.conn, card_id=card_id, start_date=start_date)
                if condition_code == "NM"
                else {}
            )

        editioned = any(
            self._history_has_edition(key)
            for key in [*scrydex, *tcgplayer, main_variant, default_variant]
        )

        def printing_key(value: Any) -> str:
            return self._history_printing_key(value, editioned=editioned)

        labels: dict[str, str] = {}
        scrydex_by_printing: dict[str, dict[str, float]] = {}
        for variant_key, by_date in scrydex.items():
            key = printing_key(variant_key)
            labels.setdefault(key, _normalized_variant_label(variant_key))
            scrydex_by_printing.setdefault(key, {}).update(by_date)
        # Two TCGCSV subtypes can name one printing (base1-4: "Holofoil" until
        # 9/13, "Unlimited Holofoil" after); the snapshot's current one wins a shared day.
        main_match = _variant_match_key(_normalized_variant_label(main_variant)) if main_variant else None
        tcgplayer_by_printing: dict[str, dict[str, float]] = {}
        for match_key in sorted(tcgplayer, key=lambda k: k == main_match):
            key = printing_key(match_key)
            by_date = {
                day: float(point["market"])
                for day, point in tcgplayer[match_key].items()
                if isinstance(point.get("market"), (int, float))
            }
            tcgplayer_by_printing.setdefault(key, {}).update(by_date)
        for value in (default_variant, main_variant):  # Scrydex spelling first
            if value:
                labels.setdefault(printing_key(value), _normalized_variant_label(value))
        for key in tcgplayer_by_printing:
            labels.setdefault(key, _normalized_variant_label(key))

        available = [key for key in labels if scrydex_by_printing.get(key) or tcgplayer_by_printing.get(key)]

        def point_count(key: str) -> int:
            return len(set(scrydex_by_printing.get(key, {})) | set(tcgplayer_by_printing.get(key, {})))

        available.sort(key=lambda key: (-point_count(key), labels[key]))
        requested = str(variant or "").strip()
        if requested:
            # "1st Edition Shadowless" names Scrydex's firstEditionShadowlessHolofoil.
            wanted = printing_key(requested)
            chosen = next((key for key in (wanted, f"{wanted}holofoil") if key in available), None)
        else:
            # The printing the app quotes, then the stored default, then the most data.
            chosen = next(
                (printing_key(v) for v in (main_variant, default_variant) if v and printing_key(v) in available),
                available[0] if available else None,
            )

        result: dict[str, Any] = {
            "card_id": card_id,
            "condition": None if graded else condition_code,
            "grader": grader_code,
            "grade": grade_code,
            "variant": labels.get(chosen) if chosen else (requested or None),
            "available_variants": [labels[key] for key in available],
            "points": [],
            "source": None,
            "sources": [],
            "as_of": None,
            "days_since_as_of": None,
        }
        if chosen is None:
            return result

        tcg_points = tcgplayer_by_printing.get(chosen, {})
        first_tcg_day = min(tcg_points) if tcg_points else None
        merged: dict[str, tuple[float, str]] = {
            day: (usd, "scrydex")
            for day, usd in scrydex_by_printing.get(chosen, {}).items()
            if first_tcg_day is None or day < first_tcg_day
        }
        merged.update({day: (usd, "tcgplayer") for day, usd in tcg_points.items()})
        days = sorted(merged)
        if not days:
            return result
        sources = []
        for name in ("scrydex", "tcgplayer"):
            source_days = [day for day in days if merged[day][1] == name]
            if source_days:
                sources.append({"source": name, "from": source_days[0], "through": source_days[-1]})
        points = [{"date": day, "usd": round(merged[day][0], 2)} for day in days]
        if len(points) > MAX_HISTORY_POINTS:
            step = (len(points) - 1) / (MAX_HISTORY_POINTS - 1)
            points = [points[round(i * step)] for i in range(MAX_HISTORY_POINTS)]
        as_of = days[-1]
        result.update(
            {
                "points": points,
                "source": merged[as_of][1],
                "sources": sources,
                "as_of": as_of,
                "days_since_as_of": (datetime.now(timezone.utc).date() - datetime.fromisoformat(as_of[:10]).date()).days,
            }
        )
        return result

    def _raw_history_cells(self, card_id: str, condition: str, start_date: str) -> dict[str, dict[str, float]]:
        """Scrydex raw cells for one condition: {variant_key: {date: usd}}. USD only."""
        rows = self.conn.execute(
            """
            SELECT variant_key, price_date, market FROM card_price_history_cell
            WHERE card_id = ? AND lane = 'raw' AND condition = ? AND price_date >= ?
              AND UPPER(COALESCE(currency_code, '')) = 'USD'
            ORDER BY price_date, updated_at
            """,
            (card_id, condition, start_date),
        ).fetchall()
        return self._history_cells_by_variant(rows)

    def _graded_history_cells(
        self, card_id: str, grader: str, grade: str, start_date: str
    ) -> dict[str, dict[str, float]]:
        """Scrydex graded cells for one grader/grade: {variant_key: {date: usd}}.
        Plain slabs only (signed/perfect/error cells would leak a premium). USD only."""
        rows = self.conn.execute(
            """
            SELECT variant_key, grade, price_date, market FROM card_price_history_cell
            WHERE card_id = ? AND lane = 'graded' AND UPPER(COALESCE(grader, '')) = ? AND price_date >= ?
              AND COALESCE(is_perfect, 0) = 0 AND COALESCE(is_signed, 0) = 0 AND COALESCE(is_error, 0) = 0
              AND UPPER(COALESCE(currency_code, '')) = 'USD'
            ORDER BY price_date, updated_at
            """,
            (card_id, grader, start_date),
        ).fetchall()
        return self._history_cells_by_variant([row for row in rows if self._history_grade_key(row["grade"]) == grade])

    @staticmethod
    def _history_cells_by_variant(rows: list[Any]) -> dict[str, dict[str, float]]:
        out: dict[str, dict[str, float]] = {}
        for row in rows:
            market = row["market"]
            if isinstance(market, (int, float)) and not isinstance(market, bool) and market > 0:
                # Later rows win a shared day (ORDER BY updated_at).
                out.setdefault(str(row["variant_key"] or ""), {})[str(row["price_date"])] = float(market)
        return out

    @staticmethod
    def _history_grade_key(value: Any) -> str | None:
        """'10', '10.0' and ' 10 ' are one grade; non-numeric grades compare upper-cased."""
        text = str(value or "").strip().upper()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return text
        return str(int(number)) if number.is_integer() else str(number)

    @staticmethod
    def _history_has_edition(value: Any) -> bool:
        key = _variant_match_key(_normalized_variant_label(value)) if value else ""
        return key.startswith(("firstedition", "unlimited", "shadowless"))

    @staticmethod
    def _history_printing_key(value: Any, *, editioned: bool) -> str:
        """One key per printing across Scrydex variant keys ('unlimitedHolofoil'),
        TCGCSV subtypes ('Unlimited Holofoil', '1st Edition Holofoil'), their
        Scrydex labels ('Unlimited', 'First Edition') and user input ('holo').
        On a card with editions, a bare Holofoil/Normal is the Unlimited print
        (TCGplayer's Base Set Charizard is 'Holofoil'; Scrydex's is 'unlimitedHolofoil')."""
        key = _variant_match_key(_normalized_variant_label(value))
        key = re.sub(r"holo(?!foil)", "holofoil", key)
        if key in {"", "raw", "normal", "standard"}:
            key = "normal"
        elif key in {"unlimitedholofoil", "unlimitednormal"}:
            key = "unlimited"
        elif key in {"firsteditionholofoil", "firsteditionnormal"}:
            key = "firstedition"
        if editioned and key in {"holofoil", "normal"}:
            key = "unlimited"
        return key
