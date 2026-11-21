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
    GAMES,
    PSA_GRADE_PRICING_MODE,
    RAW_MAIN_PRICE_SOURCE_TCGCSV,
    RAW_PRICING_MODE,
    SEALED_CARD_ID_PREFIX,
    SEALED_SUPERTYPE,
    SUPPORTED_GAMES,
    _graded_contexts_payload,
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
    slab_recent_sales_cache,
    tokenize,
)
import meta_pulse
from market_movers import NOW_TOLERANCE_DAYS, _is_japanese, latest_persisted_payload as latest_movers_payload
import scoped_movers
from sealed_products import search_sealed_products
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
PRICE_SORTS = ("price_asc", "price_desc")
# Sealed hits appended to a text search when product is "any".
SEALED_TEXT_POOL_SIZE = 50
# find_top_graded: graded cells newer than this are "current"; else the snapshot
# blobs are read (staging writes no graded cells by design).
GRADED_CELL_MAX_AGE_DAYS = 7
GRADED_CANDIDATE_ROWS = 4000
# Top candidates re-priced from cached verified sales, like the PDP headline.
GRADED_SALE_OVERLAY = 40
GRADED_SLABS_PER_CARD = 4
MAX_TOP_GRADED = 20
# Graded price outlier checks (Scrydex market only; sales-backed prices skip them).
# Vintage PSA 10 vs PSA 9 runs ~5-10x and a rare reverse holo slab can be ~4000x
# the card's main raw price, so the bars are wide.
GRADED_OUTLIER_VS_LOWER_GRADE = 25.0
GRADED_OUTLIER_VS_RAW = 10_000.0
MAX_GRADING_UPSIDE = 10
GRADING_UPSIDE_DESCRIPTION = (
    "Is it worth grading: for up to 10 card_ids (usually the user's priciest raw cards from "
    "get_my_collection), each card's raw market price next to a PSA 10 comp from stored data: comp_price_usd "
    "with comp_source ('ebay_sold' = last verified sale, comp_sale_count sales on file; 'scrydex_market' = "
    "graded market estimate), comp_as_of, and gross_premium_usd / gross_premium_pct (comp - raw, before "
    "grading fees and shipping). comp_missing = no usable PSA 10 comp for that card."
)
OWNED_MODES = ("any", "owned", "not_owned")
# find_missing: cheapest first (budgets, shopping lists) or highest value first (chase cards).
MISSING_SORTS = ("price_asc", "value_desc")
MAX_FALLBACK_PRICES = 400
COLLECTION_SORTS = ("value_desc", "price_desc", "gain_desc", "added_desc")
HOLDING_TYPES = ("any", "raw", "graded")
TOP_HOLDINGS = 8
PORTFOLIO_RANGES = {"7d": 7, "30d": 30, "90d": 90, "1y": 365}
HISTORY_RANGES = {"30d": 30, "90d": 90, "1y": 365}
# History starting within this many days of the range start counts as covering it.
HISTORY_FULL_RANGE_SLACK_DAYS = 7
PRICE_LOW_WINDOWS = {"90d": 90, "1y": 365}
MAX_PRICE_LOWS = 20
MAX_NEW_HIGHS = 20
TREND_WINDOWS = {"7d": 7, "30d": 30, "90d": 90}
MOVER_DIRECTIONS = ("up", "down")
MOVER_RANKS = ("pct", "usd")
MOVER_OWNED_MODES = ("any", "owned")
MAX_MOVERS = 10
MOVERS_ALT_COUNT = 3
MOVER_SCOPE_KEYS = ("set", "rarity_bucket", "text", "artist")
MAX_TREND_CARDS = 5
MAX_TREND_SETS = 3
# CardFilter keys that scope a query but are not art_search filter keys.
ART_SCOPE_KEYS = frozenset({"game", "product"})
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
    "invest in', 'undervalued cards', 'what's cheap right now', 'what's at its low'. Each card has "
    "low_usd, high_usd, pct_below_high, at_window_low and days_covered (history actually available; under a year means the "
    "'1y low' covers only that span). owned='owned' checks the user's own cards. Past prices only; "
    "this is not a forecast."
)
NEW_HIGHS_DESCRIPTION = (
    "Cards hitting NEW HIGHS: the current USD market price is at (within 2% of) its highest in the window "
    "(1y default, or 90d), that high was first reached in the last 7 days, and the price is at least 15% "
    "above the window low; most recent high first. Use for 'new highs', 'record prices', 'breaking out', "
    "'most recent new high sales', 'all-time high' (1y is the longest window; say so). Each card has "
    "high_usd, high_date, low_usd, pct_above_low and days_covered (history actually available; under the window means the high covers "
    "only that span). These are MARKET-PRICE highs (daily TCGplayer market price, else Scrydex), not completed "
    "sales or individual graded sales: call them 'market-price highs'. Japanese cards "
    "are left out unless filter.language is Japanese; filter.product picks singles/sealed (default both). "
    "owned='owned' checks the user's own cards. Past prices only; this is not a forecast."
)
MOVERS_DESCRIPTION = (
    "Biggest price movers INSIDE a scope: which cards of a set, a rarity, a card name, or the user's own "
    "cards rose or fell the most over a window (7d, 30d, 90d, 1y). Use for 'which <set> card dropped/fell/"
    "gained/rose the most this week/month/year', 'biggest SIR gainers', 'biggest decliners in <set>'. "
    "direction 'up' (gainers) or 'down' (decliners); window: week=7d, month=30d, 3 months=90d, year=1y. "
    "Needs a scope: filter.set, filter.rarity_bucket (with filter.game for other games), filter.text, or "
    "owned='owned' (combine owned='owned' with a set/rarity for 'my <set> cards'). Whole-game gainers without a "
    "scope: use get_market_trends. The user's whole-collection gainers/losers: use get_portfolio_summary. "
    "Each card has start_usd/end_usd (start_date/end_date), change_usd, change_pct, days_covered and "
    "covers_full_window (false = history starts after the window start: say how much it covers). cards is "
    "ranked by change_pct (ranked_by); top_by_usd is the same move ranked in dollars. Raw market price (TCGplayer, "
    "else Scrydex), one printing per card; cards under $3 and glitchy histories are left out. Japanese cards are "
    "left out unless filter.language is Japanese. A set name resolves to one set, English unless filter.language "
    "says otherwise (set_resolved). Past prices only; not a forecast."
)
MARKET_TRENDS_DESCRIPTION = (
    "What's trending: the top rising raw cards (change_pct, change_usd over cards_window_days) and the "
    "English sets rising and falling most (basket of each set's top-10 cards, window 7d/30d/90d). Use for "
    "'what's hot', 'what's trending', 'which sets are going up', and with find_price_lows for "
    "'what's a good buy' or 'what's likely to go up' (show recent momentum and dips; never predict). "
    "USD; past moves only, not a forecast."
)

TOP_GRADED_DESCRIPTION = (
    "The most valuable GRADED cards (slabs) by stored graded market price, priciest first: use for "
    "'most expensive graded cards', 'priciest PSA 10s', and alongside search_cards sort=price_desc when "
    "the user asks for the most expensive cards (graded prices are often the better answer). Optional "
    "grader (PSA, CGC, BGS, ...) and grade ('10'); filter takes game/set/text/artist/rarity_bucket/language. "
    "Each card has graded_price_usd with its grader/grade/variant, price_source ('ebay_sold' = last verified "
    "sale within 180 days, else 'scrydex' graded market), price_verified (true only for 'ebay_sold') and "
    "as_of. Only trusted prices rank: placeholder or outlier listings (e.g. $999,999, far above the card's "
    "other grades or raw price) are left out and counted in excluded_untrusted. Japanese cards are left out "
    "unless filter.language is Japanese. Games without graded data return a note saying so. USD, stored data only."
)
GAME_FILTER_NOTE = (
    "filter.game picks the TCG: pokemon (default), onepiece (One Piece), lorcana (Disney Lorcana), "
    "riftbound, gundam. For 'One Piece cards' set game='onepiece'; do not put the game name in text."
)
PRODUCT_FILTER_NOTE = (
    "filter.product: 'single' whenever the user says card/cards (e.g. 'most expensive cards'): sealed is "
    "then removed before ranking. 'sealed' for booster boxes, ETBs, bundles, tins. 'any' (default) only "
    "for other wording (products, browsing, 'items')."
)
PRICE_RANK_NOTE = (
    "Price sorts (priciest/cheapest lists) leave out Japanese cards unless filter.language is Japanese, "
    "and then rank only TCGplayer USD prices. With sort=price_desc/price_asc and no text, the whole game "
    "is ranked (a filter of just {game} is fine)."
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


def is_sealed_card(card: dict[str, Any]) -> bool:
    return card.get("supertype") == SEALED_SUPERTYPE or str(card.get("id") or "").startswith(SEALED_CARD_ID_PREFIX)


# Collectibility (owner 2026-11-20, "nobody cares about the Fairy Energy"): market-wide rankings
# (find_movers, find_new_highs, find_price_lows, get_market_trends) leave out cards collectors don't
# chase unless the caller passes include_energy_trainers: basic/bulk Energy and Common/Uncommon
# Trainers (a premium rarity, e.g. a gold secret Energy or a full-art Supporter, keeps them in),
# cards under COLLECTIBLE_MIN_PRICE_USD when the call has no price bound, name or owned scope, and
# cards with no image (they can't be shown as a tile).
PREMIUM_RARITY_BUCKETS = frozenset({"sir", "illustration", "ultra", "secret", "shiny"})
BULK_TRAINER_RARITIES = frozenset({"common", "uncommon"})
COLLECTIBLE_MIN_PRICE_USD = 10.0
INCLUDE_ENERGY_TRAINERS_NOTE = (
    "true only when the user asks about Energy or Trainer cards. By default the ranking leaves out basic/bulk "
    "Energy, Common/Uncommon Trainers, cards under $10 (unless a price bound is given) and cards without an image."
)


def is_low_interest_card(card: dict[str, Any]) -> bool:
    """Basic/bulk Energy or a Common/Uncommon Trainer, without a premium rarity."""
    supertype = str(card.get("supertype") or "").strip().casefold()
    if supertype not in ("energy", "trainer"):
        return False
    bucket = card.get("rarityBucket") or rarity_bucket(card.get("rarity"), card.get("game") or GAME)
    if bucket in PREMIUM_RARITY_BUCKETS:
        return False
    return supertype == "energy" or str(card.get("rarity") or "").strip().casefold() in BULK_TRAINER_RARITIES


def has_card_image(card: dict[str, Any]) -> bool:
    return bool(
        str(card.get("imageSmallURL") or card.get("imageURL") or card.get("image_small_url") or "").strip()
    )


def is_japanese_card(card_id: Any, language: Any) -> bool:
    return _is_japanese(str(card_id or ""), str(language or ""))


def distrust_japanese_anchor(item: dict[str, Any]) -> dict[str, Any]:
    """A Japanese card's USD price is trusted only from TCGplayer: Scrydex raw-JP
    values are yen anchors that can be stamped USD. Others get price_usd null."""
    if is_japanese_card(item.get("card_id"), item.get("language")) and item.get("price_source") != "tcgplayer":
        item["price_usd"] = None
        item["price_source"] = None
    return item


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
        # game/product are scope checks done by the callers (art tags are Pokémon
        # singles only); art_search rejects them as unknown filter keys.
        args = tuple(
            {key: value for key, value in arg.items() if key not in ART_SCOPE_KEYS} if isinstance(arg, dict) else arg
            for arg in args
        )
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

    def _collectible_ids(self, card_ids: list[str], *, skip_types: bool) -> set[str]:
        """The ids a market-wide ranking may show: catalog cards with an image and,
        unless skip_types, not low-interest (is_low_interest_card)."""
        keep: set[str] = set()
        ids = list(dict.fromkeys(str(card_id) for card_id in card_ids if card_id))
        for chunk in _chunked_sql_values(ids):
            rows = self.conn.execute(
                "SELECT id, game, supertype, rarity, image_url AS imageURL, image_small_url AS imageSmallURL "
                f"FROM cards WHERE id IN ({','.join('?' for _ in chunk)})",
                tuple(chunk),
            ).fetchall()
            for row in rows:
                card = dict(row)
                if has_card_image(card) and (skip_types or not is_low_interest_card(card)):
                    keep.add(str(card["id"]))
        return keep

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
        game = card_filter.get("game")
        if game and (card.get("game") or GAME) != game:
            return False
        product = card_filter.get("product")
        if product and is_sealed_card(card) != (product == "sealed"):
            return False
        return True

    def _resolve_set(self, card_filter: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """Pin filter.set to one set code when the name names one set: an exact
        name ('Base Set' -> 'Base', not 'Base Set 2'), else the English set when
        no language was asked ('151' -> 151, not ポケモンカード151). Otherwise the
        filter is unchanged (substring match)."""
        set_query = card_filter.get("set")
        if not set_query:
            return card_filter, None
        needle = set_query.casefold().strip()
        needles = {needle, re.sub(r"\s+set$", "", needle).strip()} - {""}
        game = card_filter.get("game") or GAME
        # Case variants instead of NOCASE keep idx_cards_set_id / idx_cards_set_ptcgo_code usable.
        codes = list(dict.fromkeys([set_query, set_query.lower(), set_query.upper()]))
        marks = ",".join("?" for _ in codes)
        exact_code = self.conn.execute(
            f"SELECT 1 FROM cards WHERE (set_id IN ({marks}) OR set_ptcgo_code IN ({marks})) AND +game = ? LIMIT 1",
            (*codes, *codes, game),
        ).fetchone()
        if exact_code is not None:
            return card_filter, None
        names = [
            str(row[0])
            for row in self.conn.execute("SELECT DISTINCT set_name FROM cards").fetchall()
            if row[0] and any(n in str(row[0]).casefold() for n in needles)
        ]
        if not names:
            return card_filter, None
        sets = [
            {"name": str(row[0]), "set_id": str(row[1] or ""), "language": str(row[2] or "")}
            for row in self.conn.execute(
                f"SELECT DISTINCT set_name, set_id, language FROM cards WHERE set_name IN ({','.join('?' for _ in names)}) "
                "AND +game = ?",
                (*names, game),
            ).fetchall()
        ]
        language = card_filter.get("language")
        if language:
            sets = [s for s in sets if s["language"].casefold() == language.casefold()]
        exact = [s for s in sets if s["name"].casefold() in needles]
        chosen = exact or sets
        if not language and len({s["language"] for s in chosen}) > 1:
            chosen = [s for s in chosen if s["language"] == "English"] or chosen
        set_ids = {s["set_id"] for s in chosen}
        if len(set_ids) != 1 or "" in set_ids:
            return card_filter, None
        picked = chosen[0]
        resolution = {"query": set_query, "set": picked["name"], "set_code": picked["set_id"], "language": picked["language"]}
        return {**card_filter, "set": picked["set_id"]}, resolution

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
    def _is_structured(card_filter: dict[str, Any], order: str = "relevance") -> bool:
        """No text: answer straight from SQL. Text needs relevance search."""
        if card_filter.get("text"):
            return False
        return order in PRICE_SORTS or any(
            card_filter.get(field) is not None
            for field in ("artist", "set", "rarity_bucket", "game", "product", "price_min_usd", "price_max_usd")
        )

    @staticmethod
    def _price_ranked_japanese_ok(card_filter: dict[str, Any]) -> bool:
        return card_filter.get("language") == "Japanese"

    def _rarities_for_buckets(self, game: str, buckets: list[str]) -> list[str]:
        rows = self.conn.execute("SELECT DISTINCT rarity FROM cards WHERE +game = ?", (game,)).fetchall()
        return [str(row[0]) for row in rows if row[0] is not None and rarity_bucket(row[0], game) in buckets]

    def _structured_rows(
        self, card_filter: dict[str, Any], *, order: str, price_ranked: bool = False
    ) -> tuple[list[Any], bool] | None:
        """Every catalog row matching the non-text filters (+ a loose price window),
        straight from SQL, or None when the filter needs relevance search (text).
        Relevance search caps its pool by text score and breaks ties pricier-first,
        so filtering price/artist after it lost every cheap match of a prolific
        artist; this applies them before any cap."""
        if not self._is_structured(card_filter, order):
            return None
        # Japanese rows only count a TCGplayer (main lane) price: Scrydex raw-JP
        # numbers are yen anchors, sometimes stamped USD.
        approx = (
            "COALESCE(s.main_raw_market_price, CASE WHEN s.display_currency_code = 'USD' "
            "AND COALESCE(c.language, '') != 'Japanese' COLLATE NOCASE THEN s.default_raw_market_price END)"
        )
        game = card_filter.get("game") or GAME
        # Unary + keeps game/language off idx_cards_game (it selects the whole table).
        where = ["+c.game = ?"]
        params: list[Any] = [game]
        product = card_filter.get("product")
        if product == "sealed":
            where.append("c.supertype = ?")
            params.append(SEALED_SUPERTYPE)
        elif product == "single":
            where.append("COALESCE(c.supertype, '') != ?")
            params.append(SEALED_SUPERTYPE)
        if price_ranked and not self._price_ranked_japanese_ok(card_filter):
            where.append("COALESCE(c.language, '') != 'Japanese' COLLATE NOCASE")
        buckets = card_filter.get("rarity_bucket")
        if buckets:
            rarities = self._rarities_for_buckets(game, buckets)
            if not rarities:
                return [], False
            where.append(f"c.rarity IN ({','.join('?' for _ in rarities)})")
            params.extend(rarities)
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
                   c.set_id AS setID, c.set_ptcgo_code AS setPtcgoCode, c.language, c.supertype,
                   {approx} AS approx
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
        price_ranked: bool = False,
    ) -> tuple[list[dict[str, Any]], bool, int | None]:
        """Catalog candidates passing the non-price filters, plus (capped, exact
        total). `exact_total` is the full match count when it is known exactly
        (structured filter, no price filter), else None. Structured pools apply
        `owned_mode` before the cap; `keep_owned` adds every owned match on top
        of the capped not-owned side (find_missing counts owned exactly)."""
        structured = self._structured_rows(card_filter, order=order, price_ranked=price_ranked)
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
                "Give at least one of text, set, artist, rarity_bucket, game, or an art filter "
                "(pokemon, scene, mood, theme, ...)."
            )
        query = " ".join(terms)
        game = card_filter.get("game") or GAME
        product = card_filter.get("product") or "any"
        raw_results: list[dict[str, Any]] = []
        capped = False
        if product != "sealed":
            bucket_args: list[str | None] = [buckets[0]] if len(buckets) == 1 else (buckets if not terms else [None])
            for bucket in bucket_args:
                found = list(
                    catalog_search_cards(
                        self.conn,
                        query,
                        limit=size,
                        game=game,
                        offset=0,
                        pool_ceiling=_MANUAL_SEARCH_POOL_CEILING,
                        rarity_bucket_filter=bucket,
                    )
                )
                capped = capped or len(found) >= size
                raw_results.extend(found)
        if product != "single" and card_filter.get("text"):
            # Card search never returns sealed product; it has its own name search.
            sealed_size = size if product == "sealed" else SEALED_TEXT_POOL_SIZE
            sealed = search_sealed_products(self.conn, card_filter["text"], game=game, limit=sealed_size)
            capped = capped or (product == "sealed" and len(sealed) >= sealed_size)
            raw_results.extend(sealed)
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
        card_filter, set_resolved = self._resolve_set(normalize_card_filter(card_filter))
        if owned not in OWNED_MODES:
            raise ToolInputError(f"owned must be one of {', '.join(OWNED_MODES)}.")
        if sort not in SEARCH_SORTS:
            raise ToolInputError(f"sort must be one of {', '.join(SEARCH_SORTS)}.")
        limit = clamp_limit(limit, default=20, maximum=50)
        owned_ids = self._owned_card_ids(owner_user_id) if owned != "any" else None
        query_hash = self._query_hash(card_filter, owned, sort)
        price_ranked = sort in PRICE_SORTS
        japanese_ok = self._price_ranked_japanese_ok(card_filter)

        def ranked_ok(item: dict[str, Any]) -> bool:
            # Priciest/cheapest lists: no Japanese cards unless asked for.
            return japanese_ok or not is_japanese_card(item["card_id"], item.get("language"))

        if uses_art_filters(card_filter):
            if card_filter.get("game", GAME) != GAME or card_filter.get("product") == "sealed":
                raise ToolInputError("Art filters cover Pokémon single cards only.")
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
            results = [summaries[card_id] for card_id in ids if card_id in summaries]
            if price_ranked:
                results = [distrust_japanese_anchor(item) for item in results if ranked_ok(item)]
            return {
                "results": results,
                "next_cursor": encode_cursor({"k": "search_art", "q": query_hash, "c": next_art})
                if next_art
                else None,
                "total_estimate": int(result.get("total_estimate") or len(ids)),
                "art_coverage": self._art_coverage(),
                **({"set_resolved": set_resolved} if set_resolved else {}),
            }

        offset = self._offset_from_cursor(cursor, kind="search", query_hash=query_hash)
        pool, capped, exact_total = self._catalog_pool(
            card_filter, size=SEARCH_POOL_SIZE, order=sort, owned_ids=owned_ids, owned_mode=owned,
            price_ranked=price_ranked,
        )
        if owned_ids is not None:
            pool = [card for card in pool if (card["id"] in owned_ids) == (owned == "owned")]
        cards = {card["id"]: card for card in pool}
        needs_prices = sort in ("price_asc", "price_desc") or (
            "price_min_usd" in card_filter or "price_max_usd" in card_filter
        )
        if needs_prices:
            summaries = self._summaries(list(cards), cards=cards)
            items = [distrust_japanese_anchor(summaries[card["id"]]) for card in pool if card["id"] in summaries]
            if price_ranked:
                items = [item for item in items if ranked_ok(item)]
            items = [item for item in items if self._matches_price(item["price_usd"], card_filter)]
            if price_ranked:
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
            **({"set_resolved": set_resolved} if set_resolved else {}),
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
        holding_type: str = "any",
    ) -> dict[str, Any]:
        card_filter = normalize_card_filter(card_filter)
        if sort not in COLLECTION_SORTS:
            raise ToolInputError(f"sort must be one of {', '.join(COLLECTION_SORTS)}.")
        if holding_type not in HOLDING_TYPES:
            raise ToolInputError(f"holding_type must be one of {', '.join(HOLDING_TYPES)}.")
        limit = clamp_limit(limit, default=50, maximum=100)
        collection_id = self._require_collection(owner_user_id, collection_id)
        query_hash = self._query_hash(card_filter, collection_id, f"{sort}|{holding_type}")
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
            pairs = [
                (entry, card) for entry, card in pairs
                if card["id"] in allowed and self._matches_card_meta(card, card_filter)
            ]
        else:
            pairs = [(entry, card) for entry, card in pairs if self._matches_card_meta(card, card_filter)]

        items = [self._holding_summary(entry, card, tcgplayer_id=tcg_ids.get(card["id"])) for entry, card in pairs]
        items = [item for item in items if self._matches_price(item["price_usd"], card_filter)]
        if holding_type != "any":
            items = [item for item in items if bool(item["grader"] or item["grade"]) == (holding_type == "graded")]
        if sort == "value_desc":
            items = self._sort_by_price(items, descending=True, key="value_usd")
        elif sort == "price_desc":
            items = self._sort_by_price(items, descending=True)
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
            "value_basis": "price_usd is the price of one copy; value_usd = price_usd x quantity (the holding's total).",
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
        sealed_ids: set[str] = set()
        for entry, card in pairs:
            holding = self._holding_summary(entry, card)
            holdings.append(holding)
            if is_sealed_card(card):
                sealed_ids.add(str(card["id"]))
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
        # Percent leaders among single cards, so "dropped the most" in % isn't guessed from the $ list.
        # Same unit-price floor as find_movers (start and now): a $0.30 -> $0.48 card isn't a +60% "leader".
        floor = scoped_movers.MIN_PRICE_USD
        singles = [
            m for m in movers
            if m["card_id"] not in sealed_ids and m["change_pct"] is not None
            and m["baseline_price_usd"] >= floor and (m["baseline_price_usd"] + m["change_usd"] / m["quantity"]) >= floor
        ]
        pct_gainers = sorted((m for m in singles if m["change_usd"] > 0), key=lambda m: m["change_pct"], reverse=True)
        pct_losers = sorted((m for m in singles if m["change_usd"] < 0), key=lambda m: m["change_pct"])
        has_history = bool(movers)
        # change_pct is relative to the whole collection's start value (today's
        # value minus the change; holdings without history count as flat), so
        # value_usd, change_usd and change_pct agree arithmetically. The move of
        # just the covered holdings is covered_change_pct.
        start_value = value - change_total
        return {
            "range": range_key,
            "value_usd": round(value, 2),
            "change_usd": round(change_total, 2) if has_history else None,
            "change_pct": round(change_total / start_value * 100, 2) if has_history and start_value > 0 else None,
            "start_value_usd": round(start_value, 2) if has_history else None,
            "covered_start_value_usd": round(start_total, 2) if has_history else None,
            "covered_change_pct": round(change_total / start_total * 100, 2) if start_total > 0 else None,
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
            "top_gainers_pct": [self._pct_mover(m) for m in pct_gainers[:3]],
            "top_losers_pct": [self._pct_mover(m) for m in pct_losers[:3]],
            # The single leader of each ranking, so the answer never infers one from the other list.
            "top_gainer_by_usd": self._pct_mover(gainers[0]) if gainers else None,
            "top_gainer_by_pct": self._pct_mover(pct_gainers[0]) if pct_gainers else None,
            "top_loser_by_usd": self._pct_mover(losers[0]) if losers else None,
            "top_loser_by_pct": self._pct_mover(pct_losers[0]) if pct_losers else None,
            "movers_basis": (
                "top_gainers/top_losers rank all holdings (sealed included) by change_usd (dollars); "
                f"top_gainers_pct/top_losers_pct rank single cards priced at least ${floor:.0f} (start and now) "
                "by change_pct. top_gainer_by_usd/top_gainer_by_pct/top_loser_by_usd/top_loser_by_pct are the "
                "leaders of those rankings: name a leader only from these fields."
            ),
            "holdings_count": len(holdings),
            "unpriced_count": sum(1 for holding in holdings if holding["value_usd"] is None),
            # The holdings that make up most of value_usd (price_usd x quantity).
            "top_holdings": [
                {key: holding.get(key) for key in (
                    "card_id", "name", "set", "number", "language", "holding_id", "quantity", "condition",
                    "grader", "grade", "variant", "price_usd", "value_usd", "app_url", "image_small_url",
                )}
                for holding in self._sort_by_price(
                    [holding for holding in holdings if holding["value_usd"] is not None], descending=True, key="value_usd"
                )[:TOP_HOLDINGS]
            ],
            "change_basis": (
                "Market move of cards currently held (from each card's add day if added in range); excludes "
                "buys/sells. change_usd sums the change_covers_holdings holdings with price history; change_pct = "
                "change_usd / start_value_usd, where start_value_usd = value_usd - change_usd (holdings without "
                "history count as unchanged). covered_change_pct is the same move relative to only the covered "
                "holdings' start value (covered_start_value_usd)."
            ),
            **({"truncated_at": MAX_HOLDINGS_READ} if truncated else {}),
        }

    @staticmethod
    def _pct_mover(mover: dict[str, Any]) -> dict[str, Any]:
        keys = ("card_id", "name", "set", "number", "language", "grader", "grade", "variant", "change_usd", "change_pct")
        return {key: mover.get(key) for key in keys}

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
        sort: str = "price_asc",
        limit: int | None = 20,
    ) -> dict[str, Any]:
        card_filter, set_resolved = self._resolve_set(normalize_card_filter(card_filter))
        if not card_filter:
            raise ToolInputError("find_missing needs a filter, e.g. {\"set\": \"Evolving Skies\"} or a theme.")
        if sort not in MISSING_SORTS:
            raise ToolInputError(f"sort must be one of {', '.join(MISSING_SORTS)}.")
        limit = clamp_limit(limit, default=20, maximum=50)
        if budget_usd is not None:
            try:
                budget_usd = float(budget_usd)
            except (TypeError, ValueError):
                raise ToolInputError("budget_usd must be a number.") from None
            if budget_usd < 0:
                raise ToolInputError("budget_usd must be >= 0.")
            sort = "price_asc"  # a budget fills cheapest-first
        pool_order = "price_desc" if sort == "value_desc" else "price_asc"
        collection_id = self._require_collection(owner_user_id, collection_id)
        owned_ids = self._owned_card_ids(owner_user_id, collection_id=collection_id)
        exact_total: int | None = None
        games: dict[str, str] = {}

        if uses_art_filters(card_filter):
            if card_filter.get("game", GAME) != GAME or card_filter.get("product") == "sealed":
                raise ToolInputError("Art filters cover Pokémon single cards only.")
            # Ask art_search for the not-owned side directly so the pool cap only
            # bounds what we return, and count the owned side exactly.
            pool_ids, missing_total, capped = self._art_ids(
                card_filter,
                owned_card_ids=owned_ids,
                owned_mode="not_owned",
                sort=pool_order,
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
            matching = [distrust_japanese_anchor(summaries[card_id]) for card_id in pool_ids if card_id in summaries]
            self._fill_last_recorded_prices([item for item in matching if item["card_id"] not in owned_ids])
            total_matching = missing_total + int(owned_side.get("total_estimate") or 0)
            owned_count = int(owned_side.get("total_estimate") or 0)
        else:
            pool, capped, exact_total = self._catalog_pool(
                card_filter,
                size=STRUCTURED_MISSING_POOL_SIZE if self._is_structured(card_filter, pool_order) else MISSING_POOL_SIZE,
                order=pool_order,
                owned_ids=owned_ids,
                owned_mode="not_owned",
                keep_owned=True,
            )
            cards = {card["id"]: card for card in pool}
            games = {card_id: str(card.get("game") or GAME) for card_id, card in cards.items()}
            summaries = self._summaries(list(cards), cards=cards)
            matching = [distrust_japanese_anchor(summaries[card["id"]]) for card in pool if card["id"] in summaries]
            self._fill_last_recorded_prices([item for item in matching if item["card_id"] not in owned_ids])
            matching = [item for item in matching if self._matches_price(item["price_usd"], card_filter)]
            owned_count = sum(1 for item in matching if item["card_id"] in owned_ids)
            total_matching = exact_total if exact_total is not None else len(matching)
            missing_total = total_matching - owned_count
        missing = self._sort_by_price(
            [item for item in matching if item["card_id"] not in owned_ids], descending=sort == "value_desc"
        )
        priced = [item for item in missing if item["price_usd"] is not None]
        priced_subtotal = round(sum(item["price_usd"] for item in priced), 2)
        complete = bool(missing) and not capped and len(priced) == len(missing)

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
                "game": games.get(item["card_id"], GAME),
            }
            page.append({**item, "buy_links": buy_links(card, tcgplayer_product_id=item.get("tcgplayer_id"))})
        counts_exact = exact_total is not None
        missing_count = len(missing) if budget_usd is not None else max(missing_total, len(missing))
        return {
            "missing": page,
            "sort": sort,
            "missing_count": missing_count,
            "owned_count": owned_count,
            "total_matching": total_matching,
            # Only when every missing card is priced (and the list is not capped);
            # otherwise priced_subtotal_usd with its coverage.
            "cheapest_completion_usd": priced_subtotal if complete else None,
            "priced_subtotal_usd": priced_subtotal if priced else None,
            "priced_count": len(priced),
            **(
                {"completion_note": f"Partial total: ${priced_subtotal:,.2f} covers {len(priced)} of "
                                    f"{missing_count} missing cards; the rest have no usable USD price. "
                                    "Say it that way; it is not a full completion cost."}
                if priced and not complete and budget_usd is None
                else {}
            ),
            **({"budget_spent_usd": round(sum(item["price_usd"] for item in missing), 2)} if budget_usd is not None else {}),
            **({"total_is_lower_bound": True} if capped and not counts_exact else {}),
            **(
                {"note": "Too many matches to price them all: only part of the missing list was checked, "
                         "so there is no full completion cost."
                         + ("" if counts_exact else " Counts are minimums; say 'at least'.")}
                if capped
                else {}
            ),
            **({"set_resolved": set_resolved} if set_resolved else {}),
            **({"art_coverage": self._art_coverage()} if uses_art_filters(card_filter) else {}),
        }

    def _fill_last_recorded_prices(self, items: list[dict[str, Any]]) -> None:
        """Unpriced cards fall back to their own quoted printing's last NM USD point
        in the past 30 days (same card, language, printing, condition). Japanese
        cards only take a TCGplayer point."""
        for item in [item for item in items if item.get("price_usd") is None][:MAX_FALLBACK_PRICES]:
            history, basis = self._price_history(item["card_id"], range_key="30d")
            if basis != "quoted" or not history["points"]:
                continue
            if is_japanese_card(item["card_id"], item.get("language")) and history["source"] != "tcgplayer":
                continue
            last = history["points"][-1]
            item["price_usd"] = last["usd"]
            item["price_source"] = f"{history['source']} (last recorded {last['date']})"

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
        include_energy_trainers: bool = False,
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
        if card_filter.get("game"):
            if game and game != card_filter["game"]:
                raise ToolInputError("game and filter.game disagree; pass one.")
            game = card_filter["game"]
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
        skip_types = include_energy_trainers or owned == "owned" or bool(card_filter.get("text"))
        picked: list[Any] = []
        cards: dict[str, dict[str, Any]] = {}
        for offset in range(0, len(rows), 200):
            chunk = rows[offset : offset + 200]
            chunk_cards = cards_by_ids(self.conn, [str(row[0]) for row in chunk], include_source_payload=False)
            for row in chunk:
                card = chunk_cards.get(str(row[0]))
                if card is None or (meta_filter and not self._matches_card_meta(card, meta_filter)):
                    continue
                if not has_card_image(card) or (not skip_types and is_low_interest_card(card)):
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

    def find_new_highs(
        self,
        owner_user_id: str,
        card_filter: dict[str, Any] | None = None,
        *,
        game: str | None = None,
        owned: str = "any",
        window: str = "1y",
        limit: int | None = 10,
        include_energy_trainers: bool = False,
    ) -> dict[str, Any]:
        """Cards now at a window high first reached in the last few days, from
        the daily price_highs tables (price_lows.py). DB-only."""
        card_filter = normalize_card_filter(card_filter)
        if uses_art_filters(card_filter):
            raise ToolInputError("find_new_highs takes game/product/text/set/artist/rarity_bucket/language/price filters only.")
        if window not in PRICE_LOW_WINDOWS:
            raise ToolInputError(f"window must be one of {', '.join(PRICE_LOW_WINDOWS)}.")
        if owned not in OWNED_MODES:
            raise ToolInputError(f"owned must be one of {', '.join(OWNED_MODES)}.")
        game = self._game_arg(game)
        if card_filter.get("game"):
            if game and game != card_filter["game"]:
                raise ToolInputError("game and filter.game disagree; pass one.")
            game = card_filter["game"]
        limit = clamp_limit(limit, default=10, maximum=MAX_NEW_HIGHS)
        window_days = PRICE_LOW_WINDOWS[window]
        empty = {"cards": [], "window": window, "as_of": None}
        run = (
            self.conn.execute(
                "SELECT as_of_date FROM price_highs_runs WHERE window_days = ?", (window_days,)
            ).fetchone()
            if self._has_table("price_highs_runs")
            else None
        )
        if run is None:
            return {**empty, "note": "New-high data has not been computed yet."}

        sql = (
            "SELECT card_id, variant, price_usd, high_usd, high_date, low_usd, pct_above_low, days_covered, "
            "as_of_date FROM price_highs WHERE window_days = ?"
        )
        params: list[Any] = [window_days]
        if game:
            sql += " AND game = ?"
            params.append(game)
        product = card_filter.get("product")
        if product in ("single", "sealed"):
            sql += " AND sealed = ?"
            params.append(1 if product == "sealed" else 0)
        for bound, op in (("price_min_usd", ">="), ("price_max_usd", "<=")):
            if card_filter.get(bound) is not None:
                sql += f" AND price_usd {op} ?"
                params.append(card_filter[bound])
        sql += " ORDER BY high_date DESC, pct_above_low DESC, price_usd DESC, card_id"
        rows = self.conn.execute(sql, params).fetchall()
        if owned != "any":
            owned_ids = self._owned_card_ids(owner_user_id)
            rows = [row for row in rows if (str(row[0]) in owned_ids) == (owned == "owned")]

        japanese_ok = self._price_ranked_japanese_ok(card_filter)
        meta_filter = {
            key: value for key, value in card_filter.items() if key not in ("price_min_usd", "price_max_usd", "product")
        }
        skip_types = include_energy_trainers or owned == "owned" or bool(card_filter.get("text"))
        floor = not skip_types and card_filter.get("price_min_usd") is None and card_filter.get("price_max_usd") is None
        picked: list[Any] = []
        cards: dict[str, dict[str, Any]] = {}
        for offset in range(0, len(rows), 200):
            chunk = rows[offset : offset + 200]
            chunk_cards = cards_by_ids(self.conn, [str(row[0]) for row in chunk], include_source_payload=False)
            for row in chunk:
                card = chunk_cards.get(str(row[0]))
                if card is None or (meta_filter and not self._matches_card_meta(card, meta_filter)):
                    continue
                if not japanese_ok and is_japanese_card(card["id"], card.get("language")):
                    continue
                if not has_card_image(card) or (not skip_types and is_low_interest_card(card)):
                    continue
                if floor and float(row[2] or 0) < COLLECTIBLE_MIN_PRICE_USD:
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
                    "high_usd": _round_money(row[3]),
                    "high_date": row[4],
                    "low_usd": _round_money(row[5]),
                    "pct_above_low": row[6],
                    "days_covered": int(row[7]),
                    "as_of": row[8],
                }
            )
        result: dict[str, Any] = {"cards": out, "window": window, "as_of": run[0]}
        if not out:
            result["note"] = "No cards matching this hit a new high in the last week."
        elif any(item["days_covered"] < window_days - 7 for item in out):
            result["note"] = "Some cards have less history than the window; days_covered says how much."
        return result

    def find_top_graded(
        self,
        owner_user_id: str,
        card_filter: dict[str, Any] | None = None,
        *,
        grader: str | None = None,
        grade: str | None = None,
        owned: str = "any",
        limit: int | None = 10,
    ) -> dict[str, Any]:
        """Priciest graded cards from stored graded prices. DB-only: the current
        Scrydex graded cells (else the snapshot's graded contexts), with the top
        candidates re-priced from cached verified sales like the PDP headline."""
        card_filter = normalize_card_filter(card_filter)
        if uses_art_filters(card_filter):
            raise ToolInputError("find_top_graded takes game/text/set/artist/rarity_bucket/language filters only.")
        if card_filter.get("product") == "sealed":
            raise ToolInputError("Sealed product has no graded prices.")
        if owned not in OWNED_MODES:
            raise ToolInputError(f"owned must be one of {', '.join(OWNED_MODES)}.")
        limit = clamp_limit(limit, default=10, maximum=MAX_TOP_GRADED)
        grader_code = str(grader or "").strip().upper() or None
        grade_code = self._history_grade_key(grade)
        if grade_code and not grader_code:
            raise ToolInputError("grade needs grader, e.g. grader='PSA', grade='10'.")
        game = card_filter.get("game") or GAME
        result: dict[str, Any] = {"cards": [], "game": game, "grader": grader_code, "grade": grade_code}
        if not GAMES[game].has_graded_pricing:
            return {**result, "note": f"Ekalight has no graded prices for {GAMES[game].display_name}."}
        japanese_ok = self._price_ranked_japanese_ok(card_filter)

        entries = self._graded_cell_entries(game, grader_code, grade_code, japanese_ok=japanese_ok)
        from_cells = entries is not None
        if entries is None:
            entries = self._graded_snapshot_entries(game, grader_code, grade_code, japanese_ok=japanese_ok)
        owned_ids = self._owned_card_ids(owner_user_id) if owned != "any" else None
        meta_filter = {k: v for k, v in card_filter.items() if k not in ("price_min_usd", "price_max_usd")}

        # Each card's priciest few slabs; cards ranked by their best one.
        by_card: dict[str, list[dict[str, Any]]] = {}
        for entry in sorted(entries, key=lambda entry: -entry["market"]):
            slabs = by_card.setdefault(entry["card_id"], [])
            if len(slabs) < GRADED_SLABS_PER_CARD:
                slabs.append(entry)
        ranked = sorted(by_card.values(), key=lambda slabs: (-slabs[0]["market"], slabs[0]["card_id"]))
        ranked = [slabs[0] | {"_slabs": slabs} for slabs in ranked]
        if owned_ids is not None:
            ranked = [entry for entry in ranked if (entry["card_id"] in owned_ids) == (owned == "owned")]
        want = max(limit, min(GRADED_SALE_OVERLAY, limit * 3))
        picked: list[dict[str, Any]] = []
        cards: dict[str, dict[str, Any]] = {}
        for offset in range(0, len(ranked), 200):
            chunk = ranked[offset : offset + 200]
            chunk_cards = cards_by_ids(self.conn, [entry["card_id"] for entry in chunk], include_source_payload=False)
            for entry in chunk:
                card = chunk_cards.get(entry["card_id"])
                if card is None or is_sealed_card(card) or not self._matches_card_meta(card, meta_filter):
                    continue
                if not japanese_ok and is_japanese_card(card["id"], card.get("language")):
                    continue
                cards[card["id"]] = card
                picked.append(entry)
            if len(picked) >= want:
                break
        # A cached verified sale can reorder a card's slabs (PSA 10 sold above CGC 10's market).
        picked = picked[:want]
        peers = self._graded_peer_entries(game, [entry["card_id"] for entry in picked], from_cells=from_cells)
        raw_prices = {
            card_id: summary.get("price_usd")
            for card_id, summary in self._summaries([entry["card_id"] for entry in picked], cards=cards).items()
        }
        repriced = []
        untrusted: list[dict[str, Any]] = []
        for entry in picked:
            slabs = entry["_slabs"]
            for slab in slabs:
                self._overlay_last_sale(slab, cards[entry["card_id"]])
                slab["_distrust"] = self._graded_distrust_reason(
                    slab, peers.get(entry["card_id"], []), raw_prices.get(entry["card_id"])
                )
            # Only trusted prices rank; a card falls back to its best trusted slab.
            trusted = [slab for slab in slabs if slab["_distrust"] is None]
            if trusted:
                repriced.append(max(trusted, key=lambda slab: slab["market"]))
            for slab in slabs:
                if slab["_distrust"] is not None and (not trusted or slab["market"] > max(s["market"] for s in trusted)):
                    card = cards[entry["card_id"]]
                    # No "name" key: excluded records must never render as tiles.
                    untrusted.append(
                        {
                            "card_id": entry["card_id"],
                            "label": f"{card.get('name')} ({card.get('setName')} #{card.get('number')})",
                            "grader": slab["grader"],
                            "grade": slab["grade"],
                            "listed_price_usd": round(float(slab["market"]), 2),
                            "reason": slab["_distrust"],
                        }
                    )
        picked = [entry for entry in repriced if self._matches_price(entry["market"], card_filter)]
        picked.sort(key=lambda entry: (-entry["market"], entry["card_id"]))
        picked = picked[:limit]
        if untrusted:
            untrusted.sort(key=lambda item: -item["listed_price_usd"])
            result["excluded_untrusted"] = untrusted[:5]
            result["excluded_untrusted_note"] = (
                "Listed graded prices that look like placeholders or outliers; left out of the ranking. "
                "Don't quote them as prices."
            )

        summaries = self._summaries([entry["card_id"] for entry in picked], cards=cards)
        out = []
        for entry in picked:
            summary = summaries.get(entry["card_id"])
            if summary is None:
                continue
            price = round(float(entry["market"]), 2)
            out.append(
                {
                    **summary,
                    # Tiles show price_usd: the slab price here, not the raw one.
                    "price_usd": price,
                    "graded_price_usd": price,
                    "price_source": entry["source"],
                    "price_basis": "graded",
                    "price_trusted": True,
                    "price_trust_reason": "recent verified sale" if entry["source"] == "ebay_sold"
                    else "graded market price in line with the card's other grades",
                    # "verified" is only for sales-backed prices.
                    "price_verified": entry["source"] == "ebay_sold",
                    "grader": entry["grader"],
                    "grade": entry["grade"],
                    "variant": printing_name(_normalized_variant_label(entry["variant"])) if entry["variant"] else None,
                    "as_of": entry["as_of"],
                }
            )
        result["cards"] = out
        if not out:
            result["note"] = "Ekalight has no stored graded prices matching this."
        return result

    def grading_upside(
        self, owner_user_id: str, card_ids: list[str] | None, *, grader: str = "PSA", grade: str = "10"
    ) -> dict[str, Any]:
        """Raw price vs a graded comp (default PSA 10) per card, from stored data only:
        the last verified sale in the cached comps, else Scrydex's graded market."""
        if not isinstance(card_ids, list) or not card_ids:
            raise ToolInputError("card_ids needs at least one card id.")
        ids = list(dict.fromkeys(str(card_id or "").strip() for card_id in card_ids if str(card_id or "").strip()))
        ids = ids[:MAX_GRADING_UPSIDE]
        grader_code = str(grader or "PSA").strip().upper()
        grade_code = self._history_grade_key(grade) or "10"
        cards = cards_by_ids(self.conn, ids, include_source_payload=False)
        present = [card_id for card_id in ids if card_id in cards]
        summaries = self._summaries(present, cards=cards)
        owned = self._owned_card_ids(owner_user_id)
        by_game: dict[str, list[str]] = {}
        for card_id in present:
            by_game.setdefault(str(cards[card_id].get("game") or GAME), []).append(card_id)
        peers: dict[str, list[dict[str, Any]]] = {}
        for game, game_ids in by_game.items():
            if GAMES[game].has_graded_pricing:
                peers.update(self._graded_peer_entries(game, game_ids, from_cells=True))

        held_prices = self._raw_holding_prices(owner_user_id, set(present) & owned)
        out = []
        for card_id in present:
            card = cards[card_id]
            summary = distrust_japanese_anchor(dict(summaries[card_id]))
            if held_prices.get(card_id) is not None:
                # Same raw price the user's collection shows for this holding.
                summary["price_usd"] = held_prices[card_id]
                summary["price_source"] = "collection"
            raw = summary.get("price_usd")
            comp = None
            if GAMES[str(card.get("game") or GAME)].has_graded_pricing:
                comp = self._graded_comp(card, grader_code, grade_code, peers.get(card_id, []), raw)
            item = {
                **summary,
                "owned": card_id in owned,
                "raw_price_usd": raw,
                "comp_grader": grader_code,
                "comp_grade": grade_code,
                "comp_price_usd": comp["price"] if comp else None,
                "comp_source": comp["source"] if comp else None,
                "comp_sale_count": comp["sale_count"] if comp else None,
                "comp_as_of": comp["as_of"] if comp else None,
                "comp_variant": comp["variant"] if comp else None,
                "comp_missing": comp is None,
                "gross_premium_usd": None,
                "gross_premium_pct": None,
            }
            if comp and raw:
                item["gross_premium_usd"] = round(comp["price"] - raw, 2)
                item["gross_premium_pct"] = round((comp["price"] - raw) / raw * 100, 1)
            out.append(item)
        out.sort(key=lambda item: (item["gross_premium_usd"] is None, -(item["gross_premium_usd"] or 0)))
        result: dict[str, Any] = {
            "cards": out,
            "grader": grader_code,
            "grade": grade_code,
            "basis": (
                "gross_premium = comp price - raw market price (no grading fees or shipping). comp_source "
                "'ebay_sold' = last verified sale (comp_sale_count recent sales on file); 'scrydex_market' = "
                "graded market estimate, not a sale. comp_missing = no usable comp: say so for that card."
            ),
        }
        not_found = [card_id for card_id in ids if card_id not in cards]
        if not_found:
            result["not_found"] = not_found
        return result

    def _raw_holding_prices(self, owner_user_id: str, card_ids: set[str]) -> dict[str, float]:
        """card_id -> per-copy price of the user's priciest raw holding of it, as get_my_collection prices it."""
        if not card_ids:
            return {}
        pairs, tcg_ids, _ = self._owner_holdings(owner_user_id, collection_id=None)
        out: dict[str, float] = {}
        for entry, card in pairs:
            if card["id"] not in card_ids:
                continue
            item = self._holding_summary(entry, card, tcgplayer_id=tcg_ids.get(card["id"]))
            price = item.get("price_usd")
            if item.get("grader") or item.get("grade") or price is None:
                continue
            out[card["id"]] = max(price, out.get(card["id"], price))
        return out

    def _graded_comp(
        self, card: dict[str, Any], grader: str, grade: str, peers: list[dict[str, Any]], raw: float | None
    ) -> dict[str, Any] | None:
        from server import RECENT_SALES_MAX_LIMIT, _filter_recent_sales_rows  # heavy module; loaded by the service

        snapshot = price_snapshot_row(self.conn, card["id"])
        keys = snapshot.keys() if snapshot is not None else ()
        quoted = next(
            (snapshot[key] for key in ("main_raw_variant", "default_raw_variant") if key in keys and snapshot[key]),
            None,
        )
        cached = slab_recent_sales_cache(
            self.conn, card_id=card["id"], grader=grader, grade=grade, source="ebay", limit=RECENT_SALES_MAX_LIMIT,
        )
        filtered = _filter_recent_sales_rows(cached, variant_key=quoted, limit=RECENT_SALES_MAX_LIMIT, card=card)
        last = (filtered or {}).get("recentAverage")
        if last and isinstance(last.get("amount"), (int, float)) and not self._is_placeholder_price(float(last["amount"])):
            return {
                "price": round(float(last["amount"]), 2),
                "source": "ebay_sold",
                "sale_count": len((filtered or {}).get("sales") or []),
                "as_of": str(last.get("latestSoldAt") or "").replace("/", "-") or None,
                "variant": printing_name(_normalized_variant_label(quoted)) if quoted else None,
            }
        same = [peer for peer in peers if peer["grader"] == grader and peer["grade"] == grade]
        if quoted:
            want = _variant_match_key(_normalized_variant_label(quoted))
            matching = [
                peer for peer in same
                if peer.get("variant") and _variant_match_key(_normalized_variant_label(peer["variant"])) == want
            ]
            same = matching or ([] if len(same) > 1 else same)
        trusted = [peer for peer in same if self._graded_distrust_reason(peer, peers, raw) is None]
        if not trusted:
            return None
        pick = min(trusted, key=lambda peer: peer["market"])
        return {
            "price": round(float(pick["market"]), 2),
            "source": "scrydex_market",
            "sale_count": None,
            "as_of": pick.get("as_of"),
            "variant": printing_name(_normalized_variant_label(pick["variant"])) if pick.get("variant") else None,
        }

    @staticmethod
    def _grade_sql(grade_code: str | None) -> tuple[str, list[Any]]:
        if grade_code is None:
            return "", []
        try:
            return " AND CAST(cell.grade AS REAL) = ?", [float(grade_code)]
        except ValueError:
            return " AND UPPER(cell.grade) = ?", [grade_code]

    def _graded_cell_entries(
        self, game: str, grader: str | None, grade: str | None, *, japanese_ok: bool,
        card_ids: list[str] | None = None,
    ) -> list[dict[str, Any]] | None:
        """Plain USD graded cells from the newest graded day; None when that day is
        older than GRADED_CELL_MAX_AGE_DAYS or there are no graded cells."""
        # ORDER BY rides idx_cell_date backwards; +lane keeps it off the graded index.
        row = self.conn.execute(
            "SELECT price_date FROM card_price_history_cell WHERE +lane = 'graded' ORDER BY price_date DESC LIMIT 1"
        ).fetchone()
        cutoff = (datetime.now(timezone.utc).date() - timedelta(days=GRADED_CELL_MAX_AGE_DAYS)).isoformat()
        if row is None or str(row[0]) < cutoff:
            return None
        price_date = str(row[0])
        sql = (
            "SELECT cell.card_id, cell.grader, cell.grade, cell.variant_key, cell.market "
            "FROM card_price_history_cell cell JOIN cards c ON c.id = cell.card_id "
            "WHERE cell.price_date = ? AND +cell.lane = 'graded' AND cell.market > 0 "
            "AND COALESCE(cell.is_perfect, 0) = 0 AND COALESCE(cell.is_signed, 0) = 0 "
            "AND COALESCE(cell.is_error, 0) = 0 AND UPPER(COALESCE(cell.currency_code, 'USD')) = 'USD' "
            "AND +c.game = ?"
        )
        params: list[Any] = [price_date, game]
        if grader:
            sql += " AND UPPER(cell.grader) = ?"
            params.append(grader)
        grade_sql, grade_params = self._grade_sql(grade)
        sql += grade_sql
        params.extend(grade_params)
        if not japanese_ok:
            sql += " AND COALESCE(c.language, '') != 'Japanese' COLLATE NOCASE"
        if card_ids is not None:
            sql += f" AND cell.card_id IN ({','.join('?' for _ in card_ids)})"
            params.extend(card_ids)
        sql += " ORDER BY cell.market DESC LIMIT ?"
        params.append(GRADED_CANDIDATE_ROWS)
        return [
            {
                "card_id": str(r[0]),
                "grader": str(r[1] or "").strip().upper(),
                "grade": self._history_grade_key(r[2]),
                "variant": str(r[3] or "").strip() or None,
                "market": float(r[4]),
                "source": "scrydex",
                "as_of": price_date,
            }
            for r in self.conn.execute(sql, params).fetchall()
        ]

    def _graded_snapshot_entries(
        self, game: str, grader: str | None, grade: str | None, *, japanese_ok: bool,
        card_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Fallback: the graded contexts stored on each card's price snapshot."""
        sql = (
            "SELECT s.card_id, s.display_currency_code, s.graded_contexts_json, s.updated_at "
            "FROM card_price_snapshots s JOIN cards c ON c.id = s.card_id "
            "WHERE +c.game = ? AND LENGTH(COALESCE(s.graded_contexts_json, '')) > 20"
        )
        params: list[Any] = [game]
        if not japanese_ok:
            sql += " AND COALESCE(c.language, '') != 'Japanese' COLLATE NOCASE"
        if card_ids is not None:
            sql += f" AND s.card_id IN ({','.join('?' for _ in card_ids)})"
            params.extend(card_ids)
        entries: list[dict[str, Any]] = []
        for card_id, currency, blob, updated_at in self.conn.execute(sql, params).fetchall():
            graders = _graded_contexts_payload(blob).get("graders") or {}
            for grader_name, grades in graders.items():
                grader_code = str(grader_name or "").strip().upper()
                if not isinstance(grades, dict) or (grader and grader_code != grader):
                    continue
                for grade_name, items in grades.items():
                    grade_code = self._history_grade_key(grade_name)
                    if not isinstance(items, list) or (grade and grade_code != grade):
                        continue
                    for item in items:
                        if not isinstance(item, dict) or item.get("isSigned") or item.get("isPerfect") or item.get("isError"):
                            continue
                        market = item.get("market")
                        if not isinstance(market, (int, float)) or isinstance(market, bool) or market <= 0:
                            continue
                        if str(item.get("currencyCode") or currency or "USD").strip().upper() != "USD":
                            continue
                        entries.append(
                            {
                                "card_id": str(card_id),
                                "grader": grader_code,
                                "grade": grade_code,
                                "variant": str(item.get("variant") or "").strip() or None,
                                "market": float(market),
                                "source": "scrydex",
                                "as_of": str(updated_at or "")[:10] or None,
                            }
                        )
        return entries

    def _graded_peer_entries(
        self, game: str, card_ids: list[str], *, from_cells: bool
    ) -> dict[str, list[dict[str, Any]]]:
        """Every plain graded price (all graders/grades) for these cards, by card."""
        out: dict[str, list[dict[str, Any]]] = {}
        if not card_ids:
            return out
        entries = (
            self._graded_cell_entries(game, None, None, japanese_ok=True, card_ids=card_ids) if from_cells else None
        )
        if entries is None:
            entries = self._graded_snapshot_entries(game, None, None, japanese_ok=True, card_ids=card_ids)
        for entry in entries:
            out.setdefault(entry["card_id"], []).append(entry)
        return out

    @staticmethod
    def _is_placeholder_price(price: float) -> bool:
        """$99,999 / $199,999.99 / $999,999: listing placeholders, not market prices."""
        whole = int(price)
        cents = round(price - whole, 2)
        return price >= 10_000 and cents in (0.0, 0.99) and re.fullmatch(r"[1-9]?9{4,}", str(whole)) is not None

    @staticmethod
    def _grade_number(grade: Any) -> float | None:
        try:
            return float(str(grade))
        except (TypeError, ValueError):
            return None

    def _graded_distrust_reason(
        self, slab: dict[str, Any], peers: list[dict[str, Any]], raw_price: float | None
    ) -> str | None:
        """Why a graded price can't be trusted, or None. Sales-backed prices only
        face the placeholder check; Scrydex market prices also face outlier checks."""
        price = float(slab["market"])
        if self._is_placeholder_price(price):
            return "placeholder price (a round all-9s listing, not a sale)"
        if slab.get("source") == "ebay_sold":
            return None
        grade = self._grade_number(slab.get("grade"))
        variant = _variant_match_key(_normalized_variant_label(slab.get("variant"))) if slab.get("variant") else ""
        lower = [
            float(peer["market"])
            for peer in peers
            if peer["grader"] == slab["grader"]
            and grade is not None
            and (peer_grade := self._grade_number(peer.get("grade"))) is not None
            and peer_grade < grade
            and (_variant_match_key(_normalized_variant_label(peer.get("variant"))) if peer.get("variant") else "") == variant
        ]
        if lower and price > GRADED_OUTLIER_VS_LOWER_GRADE * max(lower):
            return f"over {GRADED_OUTLIER_VS_LOWER_GRADE:g}x the same card's best lower grade"
        if not lower and raw_price and price > GRADED_OUTLIER_VS_RAW * raw_price:
            return f"over {GRADED_OUTLIER_VS_RAW:,g}x the card's raw price with no lower grades to compare"
        return None

    def _overlay_last_sale(self, entry: dict[str, Any], card: dict[str, Any]) -> None:
        """The PDP's graded price of record: the last verified USD sale within
        180 days from the cached comps (never fetched here), else Scrydex."""
        from server import RECENT_SALES_MAX_LIMIT, _filter_recent_sales_rows  # heavy module; loaded by the service

        if not entry.get("grader") or not entry.get("grade"):
            return
        cached = slab_recent_sales_cache(
            self.conn, card_id=entry["card_id"], grader=entry["grader"], grade=entry["grade"],
            source="ebay", limit=RECENT_SALES_MAX_LIMIT,
        )
        filtered = _filter_recent_sales_rows(
            cached, variant_key=entry.get("variant"), limit=RECENT_SALES_MAX_LIMIT, card=card
        )
        average = (filtered or {}).get("recentAverage")
        if average and isinstance(average.get("amount"), (int, float)):
            entry["market"] = float(average["amount"])
            entry["source"] = "ebay_sold"
            entry["as_of"] = str(average.get("latestSoldAt") or "").replace("/", "-") or entry["as_of"]

    @staticmethod
    def _game_arg(game: str | None) -> str | None:
        text = str(game or "").strip().lower()
        if not text or text == "any":
            return None
        if text not in SUPPORTED_GAMES:
            raise ToolInputError(f"game must be one of {', '.join(SUPPORTED_GAMES)}.")
        return text

    def get_market_trends(
        self, owner_user_id: str, *, game: str | None = None, window: str = "30d",
        include_energy_trainers: bool = False,
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
        showable = self._collectible_ids([str(item.get("cardId")) for item in items], skip_types=include_energy_trainers)
        items = [
            item for item in items
            if str(item.get("cardId")) in showable
            and (include_energy_trainers or float(item.get("priceNow") or 0) >= COLLECTIBLE_MIN_PRICE_USD)
        ][:MAX_TREND_CARDS]
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

    def find_movers(
        self,
        owner_user_id: str,
        card_filter: dict[str, Any] | None = None,
        *,
        direction: str = "down",
        window: str = "30d",
        owned: str = "any",
        rank_by: str = "pct",
        limit: int | None = 5,
        include_energy_trainers: bool = False,
    ) -> dict[str, Any]:
        """Biggest movers inside a scope, computed on the fly from stored daily
        prices (scoped_movers.py). DB-only."""
        card_filter, set_resolved = self._resolve_set(normalize_card_filter(card_filter))
        if uses_art_filters(card_filter):
            raise ToolInputError("find_movers takes game/product/text/set/artist/rarity_bucket/language/price filters only.")
        if direction not in MOVER_DIRECTIONS:
            raise ToolInputError("direction must be 'up' (gainers) or 'down' (decliners).")
        if window not in scoped_movers.WINDOWS:
            raise ToolInputError(f"window must be one of {', '.join(scoped_movers.WINDOWS)}.")
        if owned not in MOVER_OWNED_MODES:
            raise ToolInputError("owned must be 'any' or 'owned'.")
        if rank_by not in MOVER_RANKS:
            raise ToolInputError("rank_by must be 'pct' or 'usd'.")
        limit = clamp_limit(limit, default=5, maximum=MAX_MOVERS)
        if owned != "owned" and not any(card_filter.get(key) for key in MOVER_SCOPE_KEYS):
            if direction == "up":
                raise ToolInputError(
                    "find_movers needs a scope (filter.set, filter.rarity_bucket, filter.text, or owned='owned'). "
                    "For the biggest gainers across a whole game, call get_market_trends (Top Trends) instead."
                )
            raise ToolInputError(
                "find_movers needs a scope: filter.set, filter.rarity_bucket, filter.text, or owned='owned'."
            )
        window_days = scoped_movers.WINDOWS[window]
        base: dict[str, Any] = {
            "window": window,
            "direction": direction,
            "ranked_by": rank_by,
            **({"set_resolved": set_resolved} if set_resolved else {}),
        }
        ref_date = scoped_movers.newest_price_date(self.conn)
        if ref_date is None:
            return {**base, "cards": [], "as_of": None, "note": "No stored price history yet."}

        scope, capped = self._mover_scope(owner_user_id, card_filter, owned=owned)
        moves = scoped_movers.compute_moves(self.conn, scope, window_days=window_days, ref_date=ref_date)
        low, high = card_filter.get("price_min_usd"), card_filter.get("price_max_usd")
        moves = [
            move for move in moves
            if (low is None or move.end_usd >= low) and (high is None or move.end_usd <= high)
        ]
        # Collectibility: name and owned scopes are the user's pick; others drop bulk types and sub-floor cards.
        skip_types = include_energy_trainers or owned == "owned" or bool(card_filter.get("text"))
        if not skip_types and low is None and high is None:
            moves = [move for move in moves if move.end_usd >= COLLECTIBLE_MIN_PRICE_USD]
        showable = self._collectible_ids([move.card_id for move in moves], skip_types=skip_types)
        moves = [move for move in moves if move.card_id in showable]
        ranked = scoped_movers.rank_moves(moves, direction=direction, by=rank_by)[:limit]
        alt_by = "usd" if rank_by == "pct" else "pct"
        alt = scoped_movers.rank_moves(moves, direction=direction, by=alt_by)[:MOVERS_ALT_COUNT]
        summaries = self._summaries([move.card_id for move in ranked + alt])

        def entry(move: scoped_movers.Move) -> dict[str, Any] | None:
            summary = summaries.get(move.card_id)
            if summary is None:
                return None
            return {
                **distrust_japanese_anchor(dict(summary)),
                "variant": printing_name(move.variant),
                "start_usd": _round_money(move.start_usd),
                "end_usd": _round_money(move.end_usd),
                "change_usd": _round_money(move.change_usd),
                "change_pct": round(move.change_pct, 1),
                "start_date": move.start_date,
                "end_date": move.end_date,
                "days_covered": move.days_covered,
                "covers_full_window": move.covers_full_window,
            }

        cards = [item for item in (entry(move) for move in ranked) if item is not None]
        result: dict[str, Any] = {
            **base,
            "as_of": ref_date.isoformat(),
            "window_start": (ref_date - timedelta(days=window_days)).isoformat(),
            "cards": cards,
            f"top_by_{alt_by}": [item for item in (entry(move) for move in alt) if item is not None],
            "scanned_cards": len(scope),
            "cards_with_history": len(moves),
            "min_price_usd": scoped_movers.MIN_PRICE_USD,
        }
        notes: list[str] = []
        if not cards:
            verb = "rose" if direction == "up" else "fell"
            notes.append(
                f"No card in this scope {verb} over the window (cards under ${scoped_movers.MIN_PRICE_USD:.0f} "
                "or without comparable history are left out)."
            )
        elif any(not item["covers_full_window"] for item in cards):
            notes.append(
                "Some cards' history starts after the window start: covers_full_window is false and days_covered "
                "says how much it covers."
            )
        if capped:
            result["capped_at"] = scoped_movers.MAX_SCANNED_CARDS
            notes.append(
                f"Only the {scoped_movers.MAX_SCANNED_CARDS:,} highest-priced matching cards were checked; "
                "narrow the scope for a complete answer."
            )
        if (datetime.now(timezone.utc).date() - ref_date).days > NOW_TOLERANCE_DAYS:
            notes.append(f"The newest stored prices are from {ref_date.isoformat()}.")
        if notes:
            result["note"] = " ".join(notes)
        return result

    def _mover_scope(
        self, owner_user_id: str, card_filter: dict[str, Any], *, owned: str
    ) -> tuple[dict[str, str | None], bool]:
        """({card_id: language} to compute, capped). Japanese cards only when
        filter.language is Japanese; the price filter applies to the end price later."""
        meta_filter = {k: v for k, v in card_filter.items() if k not in ("price_min_usd", "price_max_usd")}
        japanese_ok = self._price_ranked_japanese_ok(card_filter)
        capped = False
        if owned == "owned":
            owned_ids = sorted(self._owned_card_ids(owner_user_id))
            rows = [row for row in self._mover_card_rows(owned_ids) if self._matches_card_meta(row, meta_filter)]
        elif meta_filter.get("text"):
            # A name scope is the best-matching SEARCH_POOL_SIZE cards; not reported as capped.
            rows, _ = self._relevance_pool(meta_filter, size=SEARCH_POOL_SIZE)
        else:
            structured = self._structured_rows(meta_filter, order="price_desc", price_ranked=True)
            raw_rows, capped = structured if structured is not None else ([], False)
            rows = [dict(row) for row in raw_rows]
            rows = [row for row in rows if self._matches_card_meta(row, meta_filter)]
        scope: dict[str, str | None] = {}
        for row in rows:
            card_id = str(row.get("id") or "")
            if not card_id or (not japanese_ok and is_japanese_card(card_id, row.get("language"))):
                continue
            scope.setdefault(card_id, row.get("language"))
        if len(scope) > scoped_movers.MAX_SCANNED_CARDS:
            scope = dict(list(scope.items())[: scoped_movers.MAX_SCANNED_CARDS])
            capped = True
        return scope, capped

    def _mover_card_rows(self, card_ids: list[str]) -> list[dict[str, Any]]:
        """Light catalog rows (the fields _matches_card_meta reads) for owned scopes."""
        out: list[dict[str, Any]] = []
        for chunk in _chunked_sql_values(card_ids):
            rows = self.conn.execute(
                "SELECT id, game, name, number, artist, rarity, set_name AS setName, set_id AS setID, "
                f"set_ptcgo_code AS setPtcgoCode, language, supertype FROM cards WHERE id IN ({','.join('?' for _ in chunk)})",
                tuple(chunk),
            ).fetchall()
            out.extend(dict(row) for row in rows)
        return out

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
        result, _ = self._price_history(
            card_id, range_key=range_key, condition=condition, grader=grader, grade=grade, variant=variant
        )
        return result

    def _price_history(
        self,
        card_id: str,
        *,
        range_key: str = "90d",
        condition: str = "NM",
        grader: str | None = None,
        grade: str | None = None,
        variant: str | None = None,
    ) -> tuple[dict[str, Any], str | None]:
        """(result, basis): basis says how the printing was picked: 'requested',
        'quoted' (the printing the app prices), 'most_data', or None (no line)."""
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
        card = card_by_id(self.conn, card_id) if card_id else None
        if card is None:
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
        # A rarity ("Special Illustration Rare") is not a printing: treat it as unset.
        if requested and requested.casefold() == str(card.get("rarity") or "").strip().casefold():
            requested = ""
        variant_note = None
        chosen = None
        basis: str | None = None
        if requested:
            # "1st Edition Shadowless" names Scrydex's firstEditionShadowlessHolofoil.
            wanted = printing_key(requested)
            chosen = next((key for key in (wanted, f"{wanted}holofoil") if key in available), None)
            basis = "requested" if chosen else None
            if chosen is None and len(available) == 1:
                # One printing has history (sv3pt5-199 'Holofoil'): a misnamed one means it.
                chosen, basis = available[0], "quoted"
                variant_note = f"No '{requested}' printing; this card's only priced printing is {labels[chosen]}."
            elif chosen is None and available:
                variant_note = (
                    f"No '{requested}' printing has history; pick one of available_variants and call again."
                )
        else:
            # The printing the app quotes, then the stored default, then the most data.
            quoted = next(
                (printing_key(v) for v in (main_variant, default_variant) if v and printing_key(v) in available), None
            )
            if quoted is not None:
                chosen, basis = quoted, "quoted"
            elif available:
                chosen, basis = available[0], "most_data"

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
            "range_start": start_date,
            "first_date": None,
            "last_date": None,
            "covers_full_range": False,
            **({"variant_note": variant_note} if variant_note else {}),
        }
        if chosen is None:
            return result, None

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
            return result, None
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
                "first_date": days[0],
                "last_date": as_of,
                "first_usd": round(merged[days[0]][0], 2),
                "last_usd": round(merged[as_of][0], 2),
                # A window "return" is only honest when the first point is near the range start.
                "covers_full_range": days[0] <= (
                    datetime.fromisoformat(start_date).date() + timedelta(days=HISTORY_FULL_RANGE_SLACK_DAYS)
                ).isoformat(),
            }
        )
        return result, basis

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
