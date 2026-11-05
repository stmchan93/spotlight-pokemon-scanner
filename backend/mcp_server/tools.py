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
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import art_search

from catalog_tools import (
    PSA_GRADE_PRICING_MODE,
    RAW_PRICING_MODE,
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
)
from similar_cards import build_similar_cards_payload

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
# Tool condition code -> card_price_history_cell condition code.
HISTORY_CONDITIONS = {"NM": "NM", "LP": "LP", "MP": "MP", "HP": "HP", "DMG": "DM"}
DECK_CONDITION_CODES = {
    "near_mint": "NM",
    "lightly_played": "LP",
    "moderately_played": "MP",
    "heavily_played": "HP",
    "damaged": "DMG",
}

# Art facets the CardFilter can filter on (list_facets hides the rest).
FILTERABLE_FACETS = art_search.LIST_FILTER_FACETS


def usd_price(pricing: dict[str, Any] | None) -> tuple[float | None, str | None]:
    """(price, source) for a native-USD summary, else (None, None).

    Never yen, and never yen FX-converted to USD: a JPY-only card is unpriced."""
    if not isinstance(pricing, dict):
        return None, None
    if str(pricing.get("currencyCode") or "").strip().upper() != "USD" or pricing.get("displayIsConverted"):
        return None, None
    for key in ("market", "mid", "low", "trend"):
        value = pricing.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            source = str(pricing.get("source") or pricing.get("provider") or "").strip() or "ekalight"
            return round(float(value), 2), source
    return None, None


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

    def _catalog_pool(self, card_filter: dict[str, Any], *, size: int) -> tuple[list[dict[str, Any]], bool]:
        """Catalog search candidates (search order) passing the non-price filters.
        Second value: True when the underlying search hit its pool cap."""
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

    def list_facets(self, owner_user_id: str) -> dict[str, Any]:
        del owner_user_id  # catalog-wide; no account data
        result = self._art_call("list_facets", self.conn, game=GAME)
        facets = result.get("facets") or {}
        return {
            "facets": {facet: facets.get(facet) or [] for facet in FILTERABLE_FACETS},
            "themes": result.get("themes") or [],
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
            }

        offset = self._offset_from_cursor(cursor, kind="search", query_hash=query_hash)
        pool, capped = self._catalog_pool(card_filter, size=SEARCH_POOL_SIZE)
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
            "total_estimate": total,
            **({"total_is_lower_bound": True} if capped else {}),
        }

    def _holdings_for_card(self, owner_user_id: str, card_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT condition, grader, grade, quantity, cost_basis_total,
                   cost_basis_currency_code, cost_basis_cents
            FROM deck_entries
            WHERE owner_user_id = ? AND card_id = ? AND quantity > 0
            ORDER BY added_at, id
            LIMIT 50
            """,
            (owner_user_id, card_id),
        ).fetchall()
        holdings = []
        for row in rows:
            grader = str(row["grader"] or "").strip() or None
            grade = str(row["grade"] or "").strip() or None
            quantity = int(row["quantity"] or 0)
            holdings.append(
                {
                    "condition": None
                    if (grader or grade)
                    else DECK_CONDITION_CODES.get(str(row["condition"] or "").strip().lower()),
                    "grader": grader,
                    "grade": grade,
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
            "quantity": quantity,
            "condition": None
            if (grader or grade)
            else DECK_CONDITION_CODES.get(str(entry.get("condition") or "").lower()),
            "grader": grader,
            "grade": grade,
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
        entries = list(payload.get("entries") or [])
        card_ids = [str((entry.get("card") or {}).get("id") or "") for entry in entries]
        cards = cards_by_ids(self.conn, card_ids, include_source_payload=False)
        pairs = [
            (entry, cards[card_id])
            for entry, card_id in zip(entries, card_ids)
            if card_id in cards
        ]
        return pairs, self._tcgplayer_ids(list(cards)), len(entries) >= MAX_HOLDINGS_READ

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

        series = self.service._since_baseline_series_for_requests(requests, lane_scoped=True) if requests else {}
        movers: list[dict[str, Any]] = []
        change_total = 0.0
        start_total = 0.0
        for holding in holdings:
            points = series.get(holding.pop("_key", None) or "")
            if not points or holding["price_usd"] is None:
                continue
            start_unit = float(points[0])
            change = (holding["price_usd"] - start_unit) * holding["quantity"]
            change_total += change
            start_total += start_unit * holding["quantity"]
            movers.append(
                {
                    **{k: holding[k] for k in ("card_id", "name", "set", "number", "language", "app_url")},
                    "quantity": holding["quantity"],
                    "condition": holding["condition"],
                    "grader": holding["grader"],
                    "grade": holding["grade"],
                    "value_usd": holding["value_usd"],
                    "change_usd": round(change, 2),
                    "change_pct": round(change / (start_unit * holding["quantity"]) * 100, 2)
                    if start_unit > 0 and holding["quantity"] > 0
                    else None,
                }
            )
        value = sum(holding["value_usd"] for holding in holdings if holding["value_usd"] is not None)
        gainers = sorted((m for m in movers if m["change_usd"] > 0), key=lambda m: m["change_usd"], reverse=True)
        losers = sorted((m for m in movers if m["change_usd"] < 0), key=lambda m: m["change_usd"])
        return {
            "range": range_key,
            "value_usd": round(value, 2),
            "change_usd": round(change_total, 2),
            "change_pct": round(change_total / start_total * 100, 2) if start_total > 0 else None,
            "top_gainers": gainers[:5],
            "top_losers": losers[:5],
            "holdings_count": len(holdings),
            "unpriced_count": sum(1 for holding in holdings if holding["value_usd"] is None),
            "change_basis": "market move of cards currently held (from each card's add day if added in range); excludes buys/sells",
            **({"truncated_at": MAX_HOLDINGS_READ} if truncated else {}),
        }

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
            pool, capped = self._catalog_pool(card_filter, size=MISSING_POOL_SIZE)
            cards = {card["id"]: card for card in pool}
            summaries = self._summaries(list(cards), cards=cards)
            matching = [summaries[card["id"]] for card in pool if card["id"] in summaries]
            matching = [item for item in matching if self._matches_price(item["price_usd"], card_filter)]
            total_matching = len(matching)
            owned_count = sum(1 for item in matching if item["card_id"] in owned_ids)
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
        return {
            "missing": page,
            "missing_count": len(missing),
            "owned_count": owned_count,
            "total_matching": total_matching,
            "cheapest_completion_usd": cheapest_completion,
            **({"budget_spent_usd": round(sum(item["price_usd"] for item in missing), 2)} if budget_usd is not None else {}),
            **({"total_is_lower_bound": True} if capped else {}),
        }

    def get_price_history(
        self, owner_user_id: str, card_id: str, *, range_key: str = "90d", condition: str = "NM"
    ) -> dict[str, Any]:
        del owner_user_id  # catalog-wide; no account data
        if range_key not in HISTORY_RANGES:
            raise ToolInputError(f"range must be one of {', '.join(HISTORY_RANGES)}.")
        condition_code = str(condition or "NM").strip().upper()
        if condition_code not in HISTORY_CONDITIONS:
            raise ToolInputError(f"condition must be one of {', '.join(HISTORY_CONDITIONS)}.")
        cell_condition = HISTORY_CONDITIONS[condition_code]
        card_id = str(card_id or "").strip()
        history = self.service.card_condition_history(card_id, lane="raw", days=HISTORY_RANGES[range_key])
        if history is None:
            raise ToolInputError(f"Card not found: {card_id or '(empty)'}.")

        candidates = [
            series for series in history.get("series") or []
            if str(series.get("condition") or "").upper() == cell_condition
        ]
        empty = {"card_id": card_id, "condition": condition_code, "variant": None, "points": [], "source": None}
        if not candidates:
            return empty
        snapshot = price_snapshot_row(self.conn, card_id)
        main_variant = None
        if snapshot is not None:
            keys = snapshot.keys()
            main_variant = (snapshot["main_raw_variant"] if "main_raw_variant" in keys else None) or snapshot[
                "default_raw_variant"
            ]
        target_key = _variant_match_key(_normalized_variant_label(main_variant)) if main_variant else None
        chosen = next(
            (
                series for series in candidates
                if target_key and _variant_match_key(_normalized_variant_label(series.get("variantKey"))) == target_key
            ),
            None,
        ) or max(candidates, key=lambda series: len(series.get("points") or []))

        start_date = (datetime.now(timezone.utc).date() - timedelta(days=HISTORY_RANGES[range_key])).isoformat()
        variant_key = chosen.get("variantKey") or ""
        # card_condition_history reports one majority currency; drop non-USD days
        # (Scrydex JPY) unless the TCGCSV main lane (USD) overrode that day.
        non_usd_dates = {
            str(row[0])
            for row in self.conn.execute(
                """
                SELECT price_date FROM card_price_history_cell
                WHERE card_id = ? AND lane = 'raw' AND variant_key = ? AND condition = ?
                  AND price_date >= ? AND UPPER(COALESCE(currency_code, '')) <> 'USD'
                """,
                (card_id, variant_key, cell_condition, start_date),
            ).fetchall()
        }
        main_dates: set[str] = set()
        if cell_condition == "NM":
            main_points = main_raw_cell_points_by_variant_date(self.conn, card_id=card_id, start_date=start_date)
            main_dates = set(
                (main_points.get(_variant_match_key(_normalized_variant_label(variant_key))) or {}).keys()
            )
        points = [
            {"date": str(point["date"]), "usd": round(float(point["market"]), 2)}
            for point in chosen.get("points") or []
            if isinstance(point.get("market"), (int, float))
            and (str(point["date"]) not in non_usd_dates or str(point["date"]) in main_dates)
        ]
        if len(points) > MAX_HISTORY_POINTS:
            step = (len(points) - 1) / (MAX_HISTORY_POINTS - 1)
            points = [points[round(i * step)] for i in range(MAX_HISTORY_POINTS)]
        used_main = any(point["date"] in main_dates for point in points)
        return {
            "card_id": card_id,
            "condition": condition_code,
            "variant": chosen.get("variantKey"),
            "points": points,
            "source": ("tcgplayer" if used_main else "scrydex") if points else None,
        }
