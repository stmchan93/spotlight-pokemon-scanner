"""Natural-language catalog search: POST /api/v1/assistant/search.

One Claude Haiku call turns search-box text ("eevee alt arts under $50") into a
CardFilter, then CollectionTools.search_cards runs it and the rows are hydrated
exactly like /api/v1/cards/search. A body carrying `interpretation` (chip removal,
paging) skips the model. Every failure answers intent "plain" so the app falls
back to its normal search; nothing here ever blocks the search box.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import threading
import time
from collections import OrderedDict
from typing import Any

from art_search import ART_FACETS, LIST_FILTER_FACETS, THEME_LABELS
from catalog_tools import SUPPORTED_GAMES, cards_by_ids, game_display_name

from mcp_server.assistant.config import AssistantConfig, cost_usd
from mcp_server.assistant.store import AssistantStore, utc_day
from mcp_server.assistant.tools import _FILTER_SCHEMA
from mcp_server.filters import ART_FILTER_FIELDS, ALL_FIELDS, ToolInputError, normalize_card_filter
from mcp_server.tools import OWNED_MODES, PRICE_SORTS, SEARCH_SORTS, CollectionTools
from request_auth import RequestIdentity

logger = logging.getLogger("ekalight.assistant")

INTENTS = ("search", "question", "plain")
MAX_QUERY_CHARS = 200
MAX_LIMIT = 30
INTERPRET_MAX_TOKENS = 400
CACHE_SIZE = 512
TOOL_NAME = "interpret_search"
# Fields that make a filter a real search (language/product/game alone match the whole catalog).
SUBSTANTIVE_FIELDS = (
    "text", "set", "artist", "rarity_bucket", "price_min_usd", "price_max_usd", *ART_FILTER_FIELDS,
)

RARITY_LABELS = {
    "sir": "SIR", "illustration": "Illus. Rare", "ultra": "Full Art", "secret": "Secret",
    "shiny": "Shiny", "promo": "Promo", "standard": "Common", "other": "Other",
}
ALT_ART_BUCKETS = frozenset({"sir", "illustration"})
SORT_LABELS = {"price_asc": "Cheapest first", "price_desc": "Priciest first", "newest": "Newest first"}
OWNED_LABELS = {"owned": "Owned", "not_owned": "Not owned"}
ROLE_LABELS = {"main": "Main subject", "background_or_cameo": "Cameo"}


def _filter_schema() -> dict[str, Any]:
    """The chat's CardFilter schema, with art facets and themes closed to their vocabularies."""
    schema = copy.deepcopy(_FILTER_SCHEMA)
    props = schema["properties"]
    for facet in LIST_FILTER_FACETS:
        props[facet] = {"type": "array", "items": {"type": "string", "enum": list(ART_FACETS[facet])},
                        "description": "Art facet (Pokémon single cards only)."}
    props["theme"] = {"type": "string", "enum": sorted(THEME_LABELS), "description": "Curated art theme."}
    props["rarity_bucket"]["description"] = (
        "alt art / alternate art = [sir, illustration]; special illustration rare = [sir]; illustration rare = "
        "[illustration]; full art = [ultra]; secret / hyper rare = [secret]; promo = [promo]; shiny = [shiny]."
    )
    return schema


INTERPRET_TOOL: dict[str, Any] = {
    "name": TOOL_NAME,
    "description": "Record how the search text should run against the card catalog.",
    "input_schema": {
        "type": "object",
        "properties": {
            "intent": {"type": "string", "enum": list(INTENTS)},
            "filter": _filter_schema(),
            "owned": {"type": "string", "enum": list(OWNED_MODES)},
            "sort": {"type": "string", "enum": list(SEARCH_SORTS)},
        },
        "required": ["intent"],
        "additionalProperties": False,
    },
}

SYSTEM_PROMPT = """You turn the text a collector typed into the Ekalight app's card search box into a structured \
catalog search. Call interpret_search once.

intent:
- search: the text describes cards to find with something beyond a name: price, rarity, language, artist, set, \
what is in the artwork, ownership, or an ordering.
- plain: the text is just a card name, number or set ("charizard 199", "umbreon vmax", "evolving skies").
- question: advice, an opinion, a valuation, or anything the filter cannot express (grading, "is this a good \
deal", what a collection is worth, price changes over time).

Filling the filter (search intent only):
- text = the card name only ("Eevee"); never put prices, rarities, languages, sets or game names in text.
- "under/below/less than $X" = price_max_usd; "over/above/more than $X" = price_min_usd. Prices are USD.
- "cheap/cheapest/budget" = sort price_asc; "priciest/most expensive/top" = sort price_desc; "newest/latest" = \
sort newest.
- "my cards / I own / in my collection" = owned "owned"; "I don't own / I'm missing / I need" = owned "not_owned".
- Japanese / English = language. Booster boxes, ETBs, tins = product sealed.
- Artwork content ("Pikachu in the rain", "sleeping Snorlax", "cozy", "at the beach"): put the Pokémon in \
pokemon (who is shown in the art) and use the scene, weather_time, activity, mood, art_style and palette enums. \
Art fields cover Pokémon single cards only; with them, leave text empty.
- game only when the user names a game (One Piece = onepiece, Disney Lorcana = lorcana).
- Use only enum values; leave out anything the filter cannot express (a release year, a condition)."""


def _num_label(amount: float) -> str:
    return f"${amount:,.0f}" if float(amount).is_integer() else f"${amount:,.2f}"


def _words(values: list[str]) -> str:
    return ", ".join(str(value).replace("_", " ").strip().capitalize() for value in values)


def build_chips(interpretation: dict[str, Any], *, request_game: str | None) -> list[dict[str, str]]:
    """Short removable labels, one per field, derived only from the validated interpretation."""
    card_filter = interpretation.get("filter") or {}
    chips: list[dict[str, str]] = []

    def add(field: str, label: str) -> None:
        if label:
            chips.append({"id": field, "label": label, "field": field})

    if card_filter.get("text"):
        add("text", str(card_filter["text"]))
    if card_filter.get("pokemon"):
        add("pokemon", _words(card_filter["pokemon"]))
    if card_filter.get("pokemon_role") in ROLE_LABELS:
        add("pokemon_role", ROLE_LABELS[card_filter["pokemon_role"]])
    buckets = card_filter.get("rarity_bucket") or []
    if buckets:
        alt = set(buckets) == ALT_ART_BUCKETS
        add("rarity_bucket", "Alt art" if alt else ", ".join(RARITY_LABELS.get(b, b) for b in buckets))
    for facet in LIST_FILTER_FACETS:
        if card_filter.get(facet):
            add(facet, _words(card_filter[facet]))
    if card_filter.get("theme"):
        add("theme", THEME_LABELS.get(card_filter["theme"], _words([card_filter["theme"]])))
    if card_filter.get("set"):
        add("set", str(card_filter["set"]))
    if card_filter.get("artist"):
        add("artist", f"by {card_filter['artist']}")
    if card_filter.get("language"):
        add("language", str(card_filter["language"]))
    if card_filter.get("product") == "sealed":
        add("product", "Sealed")
    if card_filter.get("game") and card_filter["game"] != request_game:
        add("game", game_display_name(card_filter["game"]))
    if "price_min_usd" in card_filter:
        add("price_min_usd", f"Over {_num_label(card_filter['price_min_usd'])}")
    if "price_max_usd" in card_filter:
        add("price_max_usd", f"Under {_num_label(card_filter['price_max_usd'])}")
    if interpretation.get("owned") in OWNED_LABELS:
        add("owned", OWNED_LABELS[interpretation["owned"]])
    if interpretation.get("sort") in SORT_LABELS:
        add("sort", SORT_LABELS[interpretation["sort"]])
    return chips


def sanitize_filter(raw: Any) -> dict[str, Any]:
    """Field-by-field validation: a bad field is dropped, never fails the search."""
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, Any] = {}
    for field, value in raw.items():
        if field not in ALL_FIELDS:
            continue
        try:
            clean.update(normalize_card_filter({field: value}))
        except ToolInputError:
            continue
    for facet in LIST_FILTER_FACETS:
        if facet in clean:
            kept = [value for value in clean[facet] if value in ART_FACETS[facet]]
            if kept:
                clean[facet] = kept
            else:
                del clean[facet]
    if clean.get("theme") and clean["theme"] not in THEME_LABELS:
        del clean["theme"]
    if any(field in clean for field in ART_FILTER_FIELDS) and (
        clean.get("game", "pokemon") != "pokemon" or clean.get("product") == "sealed"
    ):
        for field in ART_FILTER_FIELDS:
            clean.pop(field, None)
    try:
        return normalize_card_filter(clean)
    except ToolInputError:
        # The only cross-field rule is min <= max: drop the range.
        clean.pop("price_min_usd", None)
        clean.pop("price_max_usd", None)
        try:
            return normalize_card_filter(clean)
        except ToolInputError:
            return {}


def sanitize_interpretation(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    owned = raw.get("owned") if raw.get("owned") in OWNED_MODES else "any"
    sort = raw.get("sort") if raw.get("sort") in SEARCH_SORTS else "relevance"
    return {"filter": sanitize_filter(raw.get("filter")), "owned": owned, "sort": sort}


def effective_intent(intent: Any, interpretation: dict[str, Any]) -> str:
    """'search' only when the filter can run and says more than a name; else what the model said or plain."""
    if intent not in INTENTS:
        return "plain"
    if intent != "search":
        return intent
    card_filter = interpretation["filter"]
    if not any(field in card_filter for field in SUBSTANTIVE_FIELDS) and not (
        interpretation["sort"] in PRICE_SORTS or interpretation["owned"] != "any"
    ):
        return "plain"
    name_only = set(card_filter) <= {"text"} and interpretation["owned"] == "any" and (
        interpretation["sort"] == "relevance"
    )
    return "plain" if name_only else "search"


def _normalized_query(query: str) -> str:
    return " ".join(query.lower().split())


def _fallback(intent: str = "plain") -> tuple[int, dict[str, Any]]:
    return 200, {"intent": intent, "interpretation": None, "chips": [], "results": [], "nextCursor": None}


class SmartSearch:
    def __init__(
        self, config: AssistantConfig, store: AssistantStore, tools: CollectionTools, client: Any | None
    ) -> None:
        self.config = config
        self.store = store
        self.tools = tools
        self.client = client
        self._cache: OrderedDict[tuple[str, str], tuple[str, dict[str, Any]]] = OrderedDict()
        self._calls: dict[tuple[str, str], int] = {}
        self._lock = threading.Lock()

    # --- interpretation cache + per-user call counter (one MCP process) ------

    def _cache_get(self, key: tuple[str, str]) -> tuple[str, dict[str, Any]] | None:
        with self._lock:
            hit = self._cache.get(key)
            if hit is not None:
                self._cache.move_to_end(key)
            return copy.deepcopy(hit) if hit else None

    def _cache_put(self, key: tuple[str, str], value: tuple[str, dict[str, Any]]) -> None:
        with self._lock:
            self._cache[key] = copy.deepcopy(value)
            self._cache.move_to_end(key)
            while len(self._cache) > CACHE_SIZE:
                self._cache.popitem(last=False)

    def _take_call(self, user_id: str, day: str) -> bool:
        limit = self.config.search_limit_for(user_id)
        with self._lock:
            for stale in [key for key in self._calls if key[1] != day]:
                del self._calls[stale]
            used = self._calls.get((user_id, day), 0)
            if limit is not None and used >= limit:
                return False
            self._calls[(user_id, day)] = used + 1
            return True

    # --- request ---------------------------------------------------------------

    async def handle(self, caller: Any, body: Any) -> tuple[int, dict[str, Any]]:
        if not self.config.search_enabled:
            return 404, {"error": "not_found"}
        if not isinstance(body, dict):
            return 400, {"error": "invalid_request", "detail": "body must be a JSON object"}
        raw_game = str(body.get("game") or "all").strip().lower()
        if raw_game != "all" and raw_game not in SUPPORTED_GAMES:
            return 400, {"error": "invalid_request", "detail": "game must be a supported game or all"}
        game = None if raw_game == "all" else raw_game
        limit = body.get("limit", MAX_LIMIT)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_LIMIT:
            return 400, {"error": "invalid_request", "detail": f"limit must be 1..{MAX_LIMIT}"}
        cursor = body.get("cursor")
        if cursor is not None and not isinstance(cursor, str):
            return 400, {"error": "invalid_request", "detail": "cursor must be a string"}

        started = time.monotonic()
        if isinstance(body.get("interpretation"), dict):
            source = "direct"
            interpretation = sanitize_interpretation(body["interpretation"])
            intent = effective_intent("search", interpretation)
        else:
            query = body.get("query")
            if not isinstance(query, str) or not query.strip():
                return 400, {"error": "invalid_request", "detail": "query or interpretation is required"}
            if len(query) > MAX_QUERY_CHARS:
                return 400, {"error": "invalid_request", "detail": f"query must be at most {MAX_QUERY_CHARS} characters"}
            source, (intent, interpretation) = await self._interpret(caller, query.strip(), raw_game)

        if intent != "search":
            logger.info("assistant_search user=%s source=%s intent=%s latency_ms=%d", caller.user_id, source,
                        intent, int((time.monotonic() - started) * 1000))
            return _fallback(intent)
        if caller.is_guest:
            interpretation["owned"] = "any"  # a guest owns nothing worth filtering on
            intent = effective_intent("search", interpretation)
            if intent != "search":
                return _fallback()
        try:
            results, next_cursor = await asyncio.to_thread(
                self._search_sync, caller.user_id, interpretation, game, limit, cursor
            )
        except ToolInputError as error:
            logger.info("assistant_search unusable filter user=%s: %s", caller.user_id, error)
            return _fallback()
        logger.info("assistant_search user=%s source=%s intent=search fields=%s results=%d latency_ms=%d",
                    caller.user_id, source, ",".join(sorted(interpretation["filter"])) or "-", len(results),
                    int((time.monotonic() - started) * 1000))
        return 200, {
            "intent": "search",
            "interpretation": interpretation,
            "chips": build_chips(interpretation, request_game=game),
            "results": results,
            "nextCursor": next_cursor,
        }

    async def _interpret(self, caller: Any, query: str, game_key: str) -> tuple[str, tuple[str, dict[str, Any]]]:
        plain = ("plain", sanitize_interpretation(None))
        key = (_normalized_query(query), game_key)
        cached = self._cache_get(key)
        if cached is not None:
            return "cache", cached
        if self.client is None:
            return "unavailable", plain
        day = utc_day()
        spent = await asyncio.to_thread(self.store.spend_today, day)
        if spent >= self.config.daily_spend_cap_usd:
            logger.warning("assistant_search spend cap reached: %.4f", spent)
            return "spend_cap", plain
        if not self._take_call(caller.user_id, day):
            return "daily_limit", plain
        try:
            response = await asyncio.wait_for(
                self.client.messages.create(
                    model=self.config.model,
                    max_tokens=INTERPRET_MAX_TOKENS,
                    system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                    tools=[INTERPRET_TOOL],
                    # Haiku 5.5 accepts a forced tool; it skips thinking, which keeps this fast.
                    tool_choice={"type": "tool", "name": TOOL_NAME},
                    output_config={"effort": "low"},
                    messages=[{"role": "user", "content": f"Search box ({game_key}): {query}"}],
                ),
                timeout=self.config.search_timeout_seconds,
            )
        except Exception as error:  # noqa: BLE001 - any failure falls back to plain search
            logger.warning("assistant_search interpret failed: %s", type(error).__name__)
            return "error", plain
        try:
            await asyncio.to_thread(
                self.store.record_spend, caller.user_id, day, cost_usd(getattr(response, "usage", None))
            )
        except Exception:  # noqa: BLE001
            logger.exception("assistant_search spend record failed")
        raw = None
        if getattr(response, "stop_reason", None) != "refusal":
            raw = next(
                (block.input for block in response.content or []
                 if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == TOOL_NAME),
                None,
            )
        if not isinstance(raw, dict):
            return "bad_output", plain
        interpretation = sanitize_interpretation(raw)
        value = (effective_intent(raw.get("intent"), interpretation), interpretation)
        self._cache_put(key, value)
        return "model", value

    def _search_sync(
        self, user_id: str, interpretation: dict[str, Any], game: str | None, limit: int, cursor: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        card_filter = dict(interpretation["filter"])
        if game and "game" not in card_filter:
            card_filter["game"] = game
        identity = RequestIdentity(user_id=user_id, auth_source="assistant")
        with self.tools.service.request_identity_context(identity):
            found = self.tools.search_cards(
                user_id, card_filter, owned=interpretation["owned"], sort=interpretation["sort"],
                limit=limit, cursor=cursor,
            )
            ids = [str(item["card_id"]) for item in found.get("results") or [] if item.get("card_id")]
            cards = cards_by_ids(self.tools.conn, ids)
            # Same rows /api/v1/cards/search returns, so the app renders them with its catalog tiles.
            results = [cards[card_id] for card_id in ids if card_id in cards]
            self.tools.service.hydrate_search_results(results, game=card_filter.get("game"))
        return results, found.get("next_cursor")
