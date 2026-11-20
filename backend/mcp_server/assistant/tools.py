"""Tools the assistant model sees: the 13 CollectionTools reads (owner = the
request user, DB-only), 3 propose_* tools that validate and return a
ProposedAction without changing anything, and add_to_collection_now, which
writes a fully specified add (direct_add.py) or falls back to a proposal.

Strict mode: the API caps strict schemas at 24 optional parameters per request,
and the six filter tools alone carry ~120 (CardFilter x 6), so those six are
sent non-strict and validated server-side by normalize_card_filter; every other
tool (incl. all propose_* writes) is strict.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from catalog_tools import SUPPORTED_GAMES, card_by_id

from mcp_server.filters import ToolInputError, uses_art_filters
from mcp_server.policy import USER_POLICY
from mcp_server.assistant.direct_add import (
    ADD_NOW_TOOL,
    DirectAdder,
    TurnWrites,
    action_id_for,
    condition_stated,
    expires_at,
    grade_stated,
    request_key,
    resolve_variant,
)
from mcp_server.assistant.store import new_id
from mcp_server.tools import (
    DECK_CONDITION_CODES,
    GAME_FILTER_NOTE,
    GRADING_UPSIDE_DESCRIPTION,
    MARKET_TRENDS_DESCRIPTION,
    NEW_HIGHS_DESCRIPTION,
    PRICE_LOWS_DESCRIPTION,
    PRICE_RANK_NOTE,
    PRODUCT_FILTER_NOTE,
    TOP_GRADED_DESCRIPTION,
    WATCHLIST_DESCRIPTION,
    CollectionTools,
)
from request_auth import RequestIdentity

logger = logging.getLogger("ekalight.assistant")

CONDITIONS = ("NM", "LP", "MP", "HP", "DMG")
MAX_CARDS = 12
MAX_CHARTS = 2
MAX_CHART_POINTS = 90
MAX_QUANTITY = 999
MAX_LABEL_CHARS = 40
MAX_WATCHLIST_TILES = 8
MAX_SPARKLINE_POINTS = 30
MAX_GRADING_CANDIDATES = 3
# find_price_lows / find_new_highs window -> get_price_history range.
SPARKLINE_RANGES = {"90d": "90d", "1y": "1y"}
# Fields the model never needs (tiles carry them); dropping them saves tokens.
MODEL_HIDDEN_KEYS = frozenset({"image_small_url", "app_url", "tcgplayer_id", "buy_links"})
# Per-call ceilings for the model (the MCP tools allow more).
MODEL_LIMITS = {
    "search_cards": 20,
    "find_missing": 20,
    "find_price_lows": 20,
    "find_new_highs": 20,
    "get_my_collection": 50,
    "get_my_watchlist": 50,
    "find_top_graded": 20,
}
FILTER_TOOLS = (
    "search_cards", "get_my_collection", "find_missing", "find_price_lows", "find_new_highs", "find_top_graded",
)

_FILTER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "All fields optional; combined with AND. Give at least one of text/set/artist/rarity_bucket/game "
        "or an art filter (a price sort may use just {game})."
    ),
    "properties": {
        "text": {"type": "string", "description": "Card name search (case-insensitive), optionally with set or number, e.g. 'charizard ex'."},
        "set": {"type": "string", "description": "Set name or code, e.g. 'Evolving Skies'."},
        "artist": {"type": "string", "description": "Illustrator name."},
        "language": {"type": "string", "enum": ["English", "Japanese", "any"]},
        "game": {
            "type": "string",
            "enum": [*SUPPORTED_GAMES, "any"],
            "description": "TCG; default pokemon. One Piece = onepiece, Disney Lorcana = lorcana. Never put a game name in text.",
        },
        "product": {
            "type": "string",
            "enum": ["any", "single", "sealed"],
            "description": "single whenever the user says card/cards (sealed is removed before ranking); sealed for booster boxes, ETBs, bundles, tins; any (default) only for other wording.",
        },
        "rarity_bucket": {
            "type": "array",
            "items": {"type": "string", "enum": ["sir", "illustration", "ultra", "secret", "shiny", "promo", "standard", "other"]},
        },
        "price_min_usd": {"type": "number"},
        "price_max_usd": {"type": "number"},
        "pokemon": {"type": "array", "items": {"type": "string"}, "description": "Pokémon shown in the artwork (art search, incl. cameos); for card names use text."},
        "pokemon_role": {"type": "string", "enum": ["any", "main", "background_or_cameo"]},
        "scene": {"type": "array", "items": {"type": "string"}, "description": "Art facet; values from list_facets."},
        "weather_time": {"type": "array", "items": {"type": "string"}, "description": "Art facet; values from list_facets."},
        "activity": {"type": "array", "items": {"type": "string"}, "description": "Art facet; values from list_facets."},
        "mood": {"type": "array", "items": {"type": "string"}, "description": "Art facet; values from list_facets."},
        "art_style": {"type": "array", "items": {"type": "string"}, "description": "Art facet; values from list_facets."},
        "palette": {"type": "array", "items": {"type": "string"}, "description": "Art facet; values from list_facets."},
        "theme": {"type": "string", "description": "Curated theme id from list_facets.themes."},
    },
    "additionalProperties": False,
}


def _obj(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "search_cards",
        "description": (
            "Search Ekalight's card catalog. owned='owned'/'not_owned' limits to cards the user does or does "
            "not own. Prices are USD from Ekalight's stored daily market data. "
            + GAME_FILTER_NOTE + " " + PRODUCT_FILTER_NOTE + " " + PRICE_RANK_NOTE
            + " For 'most expensive cards' (any game) use product='single' with sort=price_desc for the raw "
            "leader AND call find_top_graded for the graded leader."
        ),
        "input_schema": _obj(
            {
                "filter": _FILTER_SCHEMA,
                "owned": {"type": "string", "enum": ["any", "owned", "not_owned"]},
                "sort": {"type": "string", "enum": ["relevance", "price_asc", "price_desc", "newest"]},
                "limit": {"type": "integer", "description": "1-20, default 10."},
                "cursor": {"type": "string", "description": "next_cursor from the previous call."},
            },
            ["filter"],
        ),
    },
    {
        "name": "get_my_collection",
        "description": (
            "The user's holdings with holding_id, quantity, condition/grade, printing (variant) and USD value, "
            "optionally filtered. total_value_usd covers all matching holdings, not just this page. Hidden "
            "collections are excluded unless collection_id names one."
        ),
        "input_schema": _obj(
            {
                "filter": _FILTER_SCHEMA,
                "collection_id": {"type": "string"},
                "sort": {"type": "string", "enum": ["value_desc", "gain_desc", "added_desc"]},
                "limit": {"type": "integer", "description": "1-50, default 25."},
                "cursor": {"type": "string"},
            },
            [],
        ),
    },
    {
        "name": "find_missing",
        "description": (
            "Cards matching the filter that the user does not own. sort: 'value_desc' (default here: "
            "highest-value first, for 'what am I missing', chase cards, set completion) or 'price_asc' "
            "(cheapest first: only for budget/cheap questions; budget_usd implies it). If total_is_lower_bound "
            "is true, counts are minimums: say 'at least N'. cheapest_completion_usd is set only when every "
            "missing card is priced; otherwise priced_subtotal_usd covers priced_count of missing_count cards "
            "(say e.g. '$X for Y of N missing cards'), never call it the full cost. A set name resolves to one "
            "set, English unless filter.language says otherwise (set_resolved). " + GAME_FILTER_NOTE
        ),
        "input_schema": _obj(
            {
                "filter": _FILTER_SCHEMA,
                "collection_id": {"type": "string"},
                "budget_usd": {"type": "number"},
                "sort": {"type": "string", "enum": ["value_desc", "price_asc"]},
                "limit": {"type": "integer", "description": "1-20, default 10."},
            },
            ["filter"],
        ),
    },
    {
        "name": "list_facets",
        "description": "Valid values for the art filters (scene, mood, palette, ...) and curated themes.",
        "input_schema": _obj({}, []),
        "strict": True,
    },
    {
        "name": "get_card",
        "description": (
            "One card: details, USD price, art tags, similar card ids, language_pair (the card_id of its linked "
            "Japanese/English counterpart: use it for 'is there a Japanese/English version' questions, then "
            "get_card on that id for its price), and the user's own copies (my_holdings, each with holding_id "
            "and printing)."
        ),
        "input_schema": _obj({"card_id": {"type": "string"}}, ["card_id"]),
        "strict": True,
    },
    {
        "name": "get_my_watchlist",
        "description": WATCHLIST_DESCRIPTION,
        "input_schema": _obj(
            {
                "limit": {"type": "integer", "description": "1-50, default 25."},
                "cursor": {"type": "string", "description": "next_cursor from the previous call."},
            },
            [],
        ),
        "strict": True,
    },
    {
        "name": "get_portfolio_summary",
        "description": "The user's collection value in USD, how it moved over the range, and top gainers/losers.",
        "input_schema": _obj({"range": {"type": "string", "enum": ["7d", "30d", "90d", "1y"]}}, []),
        "strict": True,
    },
    {
        "name": "get_price_history",
        "description": (
            "Daily USD price history for one printing of a card: raw by condition, or graded when grader and "
            "grade are both given (e.g. PSA 10). days_since_as_of says how old the newest point is. "
            "first_date/last_date (first_usd/last_usd) are the span actually covered; covers_full_range is "
            "false when history starts after the range start. variant is a printing (Holofoil, Reverse "
            "Holofoil, 1st Edition), never a rarity; omit it for the card's main printing."
        ),
        "input_schema": _obj(
            {
                "card_id": {"type": "string"},
                "range": {"type": "string", "enum": ["30d", "90d", "1y"]},
                "condition": {"type": "string", "enum": list(CONDITIONS)},
                "grader": {"type": "string", "description": "e.g. PSA, CGC, BGS. Needs grade."},
                "grade": {"type": "string", "description": "e.g. '10'. Needs grader."},
                "variant": {"type": "string", "description": "Printing, e.g. 'Reverse Holofoil'."},
            },
            ["card_id"],
        ),
        "strict": True,
    },
    {
        "name": "find_price_lows",
        "description": PRICE_LOWS_DESCRIPTION,
        "input_schema": _obj(
            {
                "filter": _FILTER_SCHEMA,
                "game": {"type": "string", "enum": list(SUPPORTED_GAMES)},
                "owned": {"type": "string", "enum": ["any", "owned", "not_owned"]},
                "window": {"type": "string", "enum": ["90d", "1y"]},
                "min_price_usd": {"type": "number"},
                "max_price_usd": {"type": "number"},
                "limit": {"type": "integer", "description": "1-20, default 6."},
            },
            [],
        ),
    },
    {
        "name": "find_new_highs",
        "description": NEW_HIGHS_DESCRIPTION,
        "input_schema": _obj(
            {
                "filter": _FILTER_SCHEMA,
                "game": {"type": "string", "enum": list(SUPPORTED_GAMES)},
                "owned": {"type": "string", "enum": ["any", "owned", "not_owned"]},
                "window": {"type": "string", "enum": ["90d", "1y"], "description": "Default 1y."},
                "limit": {"type": "integer", "description": "1-20, default 6."},
            },
            [],
        ),
    },
    {
        "name": "find_top_graded",
        "description": TOP_GRADED_DESCRIPTION,
        "input_schema": _obj(
            {
                "filter": _FILTER_SCHEMA,
                "grader": {"type": "string", "description": "e.g. PSA, CGC, BGS."},
                "grade": {"type": "string", "description": "e.g. '10'. Needs grader."},
                "owned": {"type": "string", "enum": ["any", "owned", "not_owned"]},
                "limit": {"type": "integer", "description": "1-20, default 10."},
            },
            [],
        ),
    },
    {
        "name": "grading_upside",
        "description": GRADING_UPSIDE_DESCRIPTION.replace("up to 10 card_ids (usually ", "up to 3 card_ids (")
        + " Pass the user's 3 most valuable raw singles (get_my_collection sort=value_desc, product=single; skip "
        "slabs); they are the candidates to compare.",
        "input_schema": _obj(
            {"card_ids": {"type": "array", "items": {"type": "string"}, "description": "1-3 card ids, most valuable first."}},
            ["card_ids"],
        ),
        "strict": True,
    },
    {
        "name": "get_market_trends",
        "description": MARKET_TRENDS_DESCRIPTION,
        "input_schema": _obj(
            {
                "game": {"type": "string", "enum": list(SUPPORTED_GAMES)},
                "window": {"type": "string", "enum": ["7d", "30d", "90d"], "description": "Set-trend window; default 30d."},
            },
            [],
        ),
        "strict": True,
    },
    {
        "name": "propose_add_to_collection",
        "description": (
            "Propose adding a card to the user's collection. Nothing changes until the user taps Confirm. "
            "Always pass quantity = the number of copies the user asked for ('add 2 ...' -> quantity 2; "
            "'a'/'one' -> 1). Pass the condition they named (near mint -> NM); default NM. Raw cards take "
            "a condition; slabs take grader + grade and no condition."
        ),
        "input_schema": _obj(
            {
                "card_id": {"type": "string"},
                "quantity": {"type": "integer", "description": "Number of copies the user asked to add (at least 1). Omitting it adds 1."},
                "condition": {"type": "string", "enum": list(CONDITIONS)},
                "variant_name": {"type": "string", "description": "Printing, e.g. '1st Edition Holofoil'."},
                "grader": {"type": "string"},
                "grade": {"type": "string"},
                "collection_id": {"type": "string"},
            },
            ["card_id"],
        ),
        "strict": True,
    },
    {
        "name": ADD_NOW_TOOL,
        "description": (
            "Add ONE card to the user's collection right away, no Confirm tap. Use only when the user's message "
            "itself asks to add it and gives all of: one exact printing (a single card_id you resolved; pass "
            "variant_name when the card has more than one printing), the quantity, and the condition (raw) or "
            "grader + grade (slab). Never infer or default the condition. If anything is missing or ambiguous, "
            "or the request covers several cards (e.g. 'add the cards in my tray'), use propose_add_to_collection "
            "(or ask) instead. Ekalight falls back to a proposal when the details aren't exact: say it's added "
            "only when the result has added=true, and say it's ready to confirm otherwise."
        ),
        "input_schema": _obj(
            {
                "card_id": {"type": "string"},
                "quantity": {"type": "integer", "description": "Copies the user asked to add ('a'/'one' -> 1)."},
                # anyOf, not type:[string,null]+enum: the API rejects enum values under a type list.
                "condition": {
                    "anyOf": [{"type": "string", "enum": list(CONDITIONS)}, {"type": "null"}],
                    "description": "The condition the user named (near mint -> NM); null for slabs.",
                },
                "variant_name": {"type": ["string", "null"], "description": "Printing, e.g. 'Reverse Holofoil'."},
                "grader": {"type": ["string", "null"]},
                "grade": {"type": ["string", "null"]},
            },
            ["card_id", "quantity", "condition", "variant_name", "grader", "grade"],
        ),
        "strict": True,
    },
    {
        "name": "propose_update_holding",
        "description": (
            "Propose changing the quantity (at least 1) and/or condition of one holding (holding_id from "
            "get_my_collection or get_card my_holdings). quantity is the NEW TOTAL copies: 'I have 3 now' -> 3; "
            "'add 2 more' to a holding of 1 -> 3. Cannot delete. Nothing changes until the user confirms."
        ),
        "input_schema": _obj(
            {
                "holding_id": {"type": "string"},
                "quantity": {"type": "integer", "description": "New total number of copies (at least 1)."},
                "condition": {"type": "string", "enum": list(CONDITIONS)},
            },
            ["holding_id"],
        ),
        "strict": True,
    },
    {
        "name": "propose_watch_card",
        "description": (
            "Propose adding a card to the user's Watchlist, optionally with a price alert when it drops to "
            "target_price_usd or below. Nothing changes until the user confirms."
        ),
        "input_schema": _obj(
            {
                "card_id": {"type": "string"},
                "variant": {"type": "string"},
                "target_price_usd": {"type": "number"},
            },
            ["card_id"],
        ),
        "strict": True,
    },
    {
        "name": "show_cards",
        "description": (
            "Choose the card tiles shown under your answer. Call it once, in the same message as your final "
            "answer, with exactly the cards the answer is about, in display order: every card you name, and "
            "nothing else. Show several candidates only when you ask the user to pick one. Use card ids from "
            "this turn's tool results, the scanned cards, or your earlier answers. Pass grader+grade for a "
            "graded price and variant for a specific printing; otherwise null. label: a short header for the "
            "tiles (e.g. 'Top holdings by value', 'Highest-value cards you're missing') or null. cards: [] "
            "shows no tiles."
        ),
        "input_schema": _obj(
            {
                "cards": {
                    "type": "array",
                    "items": _obj(
                        {
                            "card_id": {"type": "string"},
                            "variant": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                            "grader": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                            "grade": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                        },
                        ["card_id", "variant", "grader", "grade"],
                    ),
                },
                "label": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            },
            ["cards", "label"],
        ),
        "strict": True,
    },
]

READ_TOOLS = (
    "search_cards",
    "get_my_collection",
    "find_missing",
    "list_facets",
    "get_card",
    "get_my_watchlist",
    "get_portfolio_summary",
    "get_price_history",
    "find_price_lows",
    "find_new_highs",
    "get_market_trends",
    "find_top_graded",
    "grading_upside",
)


@dataclass
class ToolOutcome:
    content: Any  # JSON-able result for the model
    is_error: bool = False
    cards: list[dict[str, Any]] = field(default_factory=list)
    action: dict[str, Any] | None = None
    chart: dict[str, Any] | None = None


def strip_for_model(value: Any) -> Any:
    if isinstance(value, list):
        return [strip_for_model(item) for item in value]
    if isinstance(value, dict):
        return {key: strip_for_model(item) for key, item in value.items() if key not in MODEL_HIDDEN_KEYS}
    return value


def _quantity_owned(value: dict[str, Any]) -> int | None:
    if "holding_id" in value and isinstance(value.get("quantity"), int):
        return value["quantity"]
    holdings = value.get("my_holdings")
    if isinstance(holdings, list):
        return sum(int(item.get("quantity") or 0) for item in holdings if isinstance(item, dict))
    return None


def card_refs(value: Any) -> list[dict[str, Any]]:
    """CardRefs for every card-shaped dict (has card_id + name) in a tool result."""
    found: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        if node.get("card_id") and node.get("name"):
            found.append(
                {
                    "card_id": str(node["card_id"]),
                    "name": node.get("name"),
                    "set": node.get("set"),
                    "number": node.get("number"),
                    "language": node.get("language"),
                    "image_small_url": node.get("image_small_url"),
                    "price_usd": node.get("price_usd"),
                    "variant": node.get("variant") or node.get("watch_variant"),
                    "grader": node.get("grader"),
                    "grade": node.get("grade"),
                    "quantity_owned": _quantity_owned(node),
                    "app_url": node.get("app_url"),
                }
            )
        for key, item in node.items():
            if key != "my_holdings":
                walk(item)

    walk(value)
    return found


def price_chart(result: Any, *, name: str | None, range_key: str) -> dict[str, Any] | None:
    """Chart attachment from a get_price_history RESULT (USD points), or None
    when there is no line to draw. Downsampled to MAX_CHART_POINTS, ends kept."""
    if not isinstance(result, dict) or not result.get("card_id"):
        return None
    points = [
        {"date": str(point["date"])[:10], "usd": round(float(point["usd"]), 2)}
        for point in result.get("points") or []
        if isinstance(point, dict) and point.get("date") and isinstance(point.get("usd"), (int, float))
    ]
    if len(points) < 2:
        return None
    if len(points) > MAX_CHART_POINTS:
        step = (len(points) - 1) / (MAX_CHART_POINTS - 1)
        points = [points[round(i * step)] for i in range(MAX_CHART_POINTS)]
    return {
        "card_id": str(result["card_id"]),
        "name": name,
        "variant": result.get("variant"),
        "condition": result.get("condition"),
        "grader": result.get("grader"),
        "grade": result.get("grade"),
        "range": range_key,
        "points": points,
        "source": result.get("source"),
    }


def _optional_str(value: Any, *, limit: int = 80) -> str | None:
    text = str(value or "").strip()
    return text[:limit] if text else None


# --- tile selection ----------------------------------------------------------


def clean_label(value: Any) -> str | None:
    text = " ".join(str(value or "").split())
    if not text or any(ch in text for ch in "<>{}[]`"):
        return None
    return text[:MAX_LABEL_CHARS].rstrip()


def _slab(ref: dict[str, Any]) -> tuple[str | None, str | None]:
    grader = str(ref.get("grader") or "").strip().upper() or None
    return grader, (str(ref.get("grade") or "").strip() or None) if grader else None


def _best_ref(candidates: list[dict[str, Any]], grader: str | None, grade: str | None,
              variant: str | None) -> dict[str, Any]:
    """Exact slab + printing, then slab, then the raw ref, then whatever we have."""

    def same_slab(ref: dict[str, Any]) -> bool:
        return _slab(ref) == (grader, grade)

    def same_variant(ref: dict[str, Any]) -> bool:
        return variant is None or str(ref.get("variant") or "").casefold() == variant.casefold()

    for test in (lambda ref: same_slab(ref) and same_variant(ref), same_slab, lambda ref: _slab(ref)[0] is None):
        for ref in candidates:
            if test(ref):
                return ref
    return candidates[0]


def select_tiles(items: Any, refs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Resolve show_cards items against refs the server produced (tool results,
    scanned cards, earlier tiles). Unknown ids are dropped, never invented."""
    by_id: dict[str, list[dict[str, Any]]] = {}
    for ref in refs:
        by_id.setdefault(str(ref["card_id"]), []).append(ref)
    tiles: list[dict[str, Any]] = []
    dropped: list[str] = []
    seen: set[tuple[str, str, str]] = set()
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        card_id = _optional_str(item.get("card_id"), limit=200)
        if not card_id:
            continue
        candidates = by_id.get(card_id) or _unprefixed_match(by_id, card_id)
        if not candidates:
            dropped.append(card_id)
            continue
        grader, grade = _slab(item)
        tile = dict(_best_ref(candidates, grader, grade, _optional_str(item.get("variant"))))
        key = (card_id, *(value or "" for value in _slab(tile)))
        if key in seen:
            continue
        seen.add(key)
        tiles.append(tile)
        if len(tiles) >= MAX_CARDS:
            break
    return tiles, dropped


def _unprefixed_match(by_id: dict[str, list[dict[str, Any]]], card_id: str) -> list[dict[str, Any]] | None:
    """'FBL-242' for 'lorcana~FBL-242': the model sometimes drops the game prefix.
    Only an unambiguous match counts."""
    found = [refs for ref_id, refs in by_id.items() if ref_id.partition("~")[2] == card_id]
    return found[0] if len(found) == 1 else None


def _name_key(ref: dict[str, Any]) -> str:
    return " ".join(str(ref.get("name") or "").split()).casefold()


def _number_in_text(number: Any, text: str) -> bool:
    """The full number ('199/165', '#199/165') or, after '#', its part before the
    slash with or without leading zeros ('#199', '#6' for 006/165)."""
    number = str(number or "").strip().lstrip("#")
    if not number:
        return False
    if re.search(r"(?<![\w/])#?" + re.escape(number) + r"(?!\w)", text, re.IGNORECASE):
        return True
    head = number.split("/")[0]
    return any(
        re.search(r"#" + re.escape(form) + r"(?!\w)", text, re.IGNORECASE)
        for form in {head, head.lstrip("0")} if form and form != number
    )


def _phrase_spans(phrase: str, text: str) -> list[tuple[int, int]]:
    parts = phrase.split()
    if not parts:
        return []
    pattern = r"(?<!\w)" + r"\s+".join(re.escape(part) for part in parts) + r"(?!\w)"
    return [match.span() for match in re.finditer(pattern, text, re.IGNORECASE)]


def _uncovered(matched: dict[str, list[tuple[int, int]]]) -> set[str]:
    """Keys with a mention not inside a longer key's mention ('Charizard' in
    'Charizard ex', set 'Base' in 'Base Set 2')."""

    def covered(key: str) -> bool:
        return all(
            any(
                other != key and len(other) > len(key) and o_start <= start and end <= o_end
                for other, other_spans in matched.items()
                for o_start, o_end in other_spans
            )
            for start, end in matched[key]
        )

    return {key for key, found in matched.items() if found and not covered(key)}


def named_refs(refs: list[dict[str, Any]], text: str) -> list[dict[str, Any]]:
    """Refs whose card name is in the answer text (a name seen only inside a
    longer matched name doesn't count); a number in the text narrows a name to
    that printing."""
    keys = {_name_key(ref) for ref in refs} - {""}
    names = _uncovered({key: _phrase_spans(key, text) for key in keys})
    named = [ref for ref in refs if _name_key(ref) in names]
    numbered = {_name_key(ref) for ref in named if _number_in_text(ref.get("number"), text)}
    return [ref for ref in named if _name_key(ref) not in numbered or _number_in_text(ref.get("number"), text)]


def _set_key(ref: dict[str, Any]) -> str:
    key = " ".join(str(ref.get("set") or "").split()).casefold()
    return key if len(key) >= 3 else ""


def _slab_mentioned(ref: dict[str, Any], text: str) -> bool:
    grader = _slab(ref)[0]
    return grader is None or bool(_phrase_spans(grader, text))


def pin_printings(refs: list[dict[str, Any]], text: str) -> list[dict[str, Any]]:
    """Per card name, the printings the text pins (number; or set, when no
    printing of that set is pinned by number and a slab's grader is named),
    else just the first one listed. A pinned card keeps its raw ref and the
    slabs whose grader the text names. Order kept."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for ref in refs:
        groups.setdefault(_name_key(ref), []).append(ref)
    set_keys = {_set_key(ref) for ref in refs} - {""}
    named_sets = _uncovered({key: _phrase_spans(key, text) for key in set_keys})
    keep: set[int] = set()
    for group in groups.values():
        by_number = [ref for ref in group if _number_in_text(ref.get("number"), text)]
        numbered_sets = {_set_key(ref) for ref in by_number}
        by_set = [
            ref for ref in group
            if _set_key(ref) in named_sets and _set_key(ref) not in numbered_sets and _slab_mentioned(ref, text)
        ]
        pins = by_number + by_set or group[:1]
        pinned = {str(ref["card_id"]) for ref in pins}
        keep.update(id(ref) for ref in pins)
        keep.update(id(ref) for ref in group if str(ref["card_id"]) in pinned and _slab_mentioned(ref, text))
    return [ref for ref in refs if id(ref) in keep]


# The answer asks the user to pick ("Which Charizard do you mean?"): candidates stay.
_CHOICE_QUESTION = re.compile(r"[^.?!\n]*\b(which|do you mean|did you mean)\b[^.?!\n]*\?", re.IGNORECASE)
# The answer presents a list and names some of it ("Here are...", "including X", "led by X").
_LIST_MARKER = re.compile(r"\b(here are|here's|including|such as|led by)\b", re.IGNORECASE)
_COUNT_WORDS = {"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
                "ten": 10, "eleven": 11, "twelve": 12}
_COUNT = r"(\d{1,2}|" + "|".join(_COUNT_WORDS) + r")"
_LIST_COUNT = re.compile(
    r"\b(?:(?:top|my|your|these|the|next|priciest|cheapest)\s+" + _COUNT
    + r"|" + _COUNT + r"\s+(?:most|cheapest|priciest|best|biggest|highest|lowest))\b",
    re.IGNORECASE,
)


def list_count(text: str) -> int | None:
    """N in 'my 5 most valuable', 'top three', 'the priciest eight'."""
    match = _LIST_COUNT.search(text)
    if match is None:
        return None
    word = (match.group(1) or match.group(2)).casefold()
    count = int(word) if word.isdigit() else _COUNT_WORDS[word]
    return count if count >= 2 else None


def asks_to_choose(text: str) -> bool:
    return _CHOICE_QUESTION.search(text) is not None


def _same_tile(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return a.get("card_id") == b.get("card_id") and _slab(a) == _slab(b)


def _append_new(tiles: list[dict[str, Any]], items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for item in items:
        if not any(_same_tile(item, tile) for tile in tiles):
            tiles.append(item)
    return tiles


def choose_tiles(
    selection: list[dict[str, Any]] | None,
    refs: list[dict[str, Any]],
    text: str,
    charts: list[dict[str, Any]],
    *,
    extra_refs: list[dict[str, Any]] | tuple[()] = (),
    keep_ids: frozenset[str] | set[str] = frozenset(),
    always_ids: frozenset[str] | set[str] = frozenset(),
    watchlist_ids: frozenset[str] | set[str] = frozenset(),
    list_ids: frozenset[str] | set[str] = frozenset(),
    question: str = "",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(tiles, charts) = the cards the answer is about, decided in code (the model
    over-selects). refs: this turn's tool-result refs; extra_refs: scanned and
    earlier-tile refs with names. keep_ids: scanned cards (kept when selected);
    always_ids: proposal cards; list_ids: cards from list tools (search,
    find_missing, the user's collection/Watchlist), whose answers may name a few
    cards of a longer list; question: a count the user asked for ('my 5 most
    valuable') sizes the list."""
    pool = list(refs) + [ref for ref in extra_refs if ref.get("name")]
    named = pin_printings(named_refs(pool, text), text)
    named_names = {_name_key(ref) for ref in named}
    always = [ref for ref in pool if ref["card_id"] in always_ids]

    chart_ids = list(dict.fromkeys(str(chart["card_id"]) for chart in charts))
    if chart_ids:
        # A charted card: that card (and its chart) only, plus other cards the text names.
        pinned = [card_id for card_id in chart_ids if any(ref["card_id"] == card_id for ref in named)]
        if len(chart_ids) > 1 and pinned:
            chart_ids = pinned
        charts = [chart for chart in charts if chart["card_id"] in chart_ids]
        candidates_pool = list(selection or []) + pool
        tiles: list[dict[str, Any]] = []
        for chart in charts:
            candidates = [ref for ref in candidates_pool if ref["card_id"] == chart["card_id"]]
            _append_new(tiles, [dict(_best_ref(candidates, *_slab(chart), chart.get("variant"))) if candidates
                                else {"card_id": chart["card_id"]}])
        chart_names = {_name_key(ref) for ref in candidates_pool if ref["card_id"] in chart_ids and ref.get("name")}
        _append_new(tiles, [ref for ref in named if ref["card_id"] not in chart_ids and _name_key(ref) not in chart_names])
        _append_new(tiles, [tile for tile in selection or [] if tile["card_id"] in keep_ids])
        return _append_new(tiles, always), charts

    if asks_to_choose(text):
        return (list(selection) if selection else named_refs(refs, text) or list(refs)), charts
    if not named:
        return _append_new(list(selection if selection is not None else refs), always), charts
    if watchlist_ids and all(ref["card_id"] in watchlist_ids for ref in named):
        # Watchlist answers show a preview of the list, not just the cards named.
        return (list(selection) if selection else [ref for ref in refs if ref["card_id"] in watchlist_ids]), charts
    requested = list_count(question)
    if selection and requested:
        return _append_new(_append_new(list(selection[:requested]), named), always), charts
    if selection and _LIST_MARKER.search(text) and all(tile["card_id"] in list_ids for tile in selection):
        listed = _append_new(list(selection[: list_count(text) or len(selection)]), named)
        return _append_new(listed, always), charts
    kept = pin_printings([tile for tile in selection or [] if _name_key(tile) in named_names], text)
    covered = {_name_key(tile) for tile in kept}
    _append_new(kept, [ref for ref in named if _name_key(ref) not in covered])
    return _append_new(kept, always), charts


def art_groups(conn: sqlite3.Connection, card_ids: list[str]) -> dict[str, str]:
    ids = list(dict.fromkeys(str(card_id) for card_id in card_ids if card_id))
    groups: dict[str, str] = {}
    try:
        for start in range(0, len(ids), 500):
            chunk = ids[start : start + 500]
            rows = conn.execute(
                "SELECT card_id, art_group_id FROM card_art_group_members "
                f"WHERE card_id IN ({','.join('?' * len(chunk))})",
                chunk,
            ).fetchall()
            groups.update({str(row[0]): str(row[1]) for row in rows})
    except sqlite3.OperationalError:  # no art tables on this DB
        return {}
    return groups


def _language(item: dict[str, Any]) -> str:
    language = str(item.get("language") or "").strip().casefold()
    if language:
        return language
    return "japanese" if "_ja-" in str(item.get("card_id") or "") else "english"


def collapse_same_art(
    items: list[dict[str, Any]],
    groups: dict[str, str],
    *,
    preferred_language: str | None = None,
    across_languages: bool = True,
) -> tuple[list[dict[str, Any]], int]:
    """One item per artwork (art group), in the slot of its first appearance;
    within a group the preferred language wins. across_languages=False merges
    only same-language reprints, so an EN/JP counterpart pair stays."""
    preferred = (preferred_language or "").casefold() or None
    slots: dict[Any, int] = {}
    out: list[dict[str, Any]] = []
    for item in items:
        group = groups.get(str(item.get("card_id")))
        key = None if group is None else (group if across_languages else (group, _language(item)))
        if key is None or key not in slots:
            if key is not None:
                slots[key] = len(out)
            out.append(item)
            continue
        index = slots[key]
        if out[index].get("card_id") == item.get("card_id"):
            out.append(item)  # same card in another grade: not a duplicate artwork
        elif preferred and _language(out[index]) != preferred and _language(item) == preferred:
            out[index] = item
    return out, len(items) - len(out)


def watchlist_order(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Cards with a target first (closest to it first), then by market price, unpriced last."""

    def key(item: dict[str, Any]) -> tuple[int, float]:
        price, target = item.get("price_usd"), item.get("target_price_usd")
        priced = isinstance(price, (int, float)) and not isinstance(price, bool)
        if isinstance(target, (int, float)) and target > 0:
            return (0, price / target) if priced else (1, 0.0)
        return (2, -float(price)) if priced else (3, 0.0)

    return sorted(items, key=key)


def downsample(values: list[Any], size: int) -> list[Any]:
    if len(values) <= size:
        return values
    step = (len(values) - 1) / (size - 1)
    return [values[round(i * step)] for i in range(size)]


def _card_label(card: dict[str, Any]) -> str:
    where = " ".join(part for part in (str(card.get("setName") or "").strip(), str(card.get("number") or "").strip()) if part)
    return f"{card.get('name')} ({where})" if where else str(card.get("name"))


class AssistantToolbox:
    """Sync tool execution; the engine runs each call in a worker thread."""

    def __init__(self, tools: CollectionTools) -> None:
        self.tools = tools
        self.policy = USER_POLICY

    @property
    def conn(self):
        return self.tools.conn

    def run(
        self, name: str, arguments: dict[str, Any], *, owner_user_id: str, turn: TurnWrites | None = None
    ) -> ToolOutcome:
        identity = RequestIdentity(user_id=owner_user_id, auth_source="assistant")
        try:
            with self.tools.service.request_identity_context(identity):
                if name in READ_TOOLS:
                    return self._read(name, dict(arguments or {}), owner_user_id)
                if name == "propose_add_to_collection":
                    return self._propose_add(dict(arguments or {}), owner_user_id)
                if name == ADD_NOW_TOOL:
                    return self._add_now(dict(arguments or {}), owner_user_id, turn)
                if name == "propose_update_holding":
                    return self._propose_update(dict(arguments or {}), owner_user_id)
                if name == "propose_watch_card":
                    return self._propose_watch(dict(arguments or {}), owner_user_id)
            return ToolOutcome({"error": f"Unknown tool {name}."}, is_error=True)
        except ToolInputError as error:
            return ToolOutcome({"error": str(error)}, is_error=True)
        except Exception:  # noqa: BLE001 - never leak internals to the model
            logger.exception("assistant tool %s failed", name)
            return ToolOutcome({"error": "Ekalight could not complete this lookup."}, is_error=True)

    # --- reads ---------------------------------------------------------------

    def _read(self, name: str, args: dict[str, Any], owner_user_id: str) -> ToolOutcome:
        kwargs: dict[str, Any] = {}
        if name in FILTER_TOOLS:
            kwargs["card_filter"] = args.get("filter")
        if name in MODEL_LIMITS:
            default = {
                "get_my_collection": 25, "get_my_watchlist": 25, "find_price_lows": 6, "find_new_highs": 6,
            }.get(name, 10)
            try:
                limit = int(args.get("limit") or default)
            except (TypeError, ValueError):
                limit = default
            kwargs["limit"] = max(1, min(limit, MODEL_LIMITS[name]))
        for key in ("owned", "sort", "cursor", "collection_id", "budget_usd", "card_id", "card_ids", "condition",
                    "grader", "grade", "variant", "game", "window", "min_price_usd", "max_price_usd"):
            if args.get(key) is not None:
                kwargs[key] = args[key]
        if "range" in args and args["range"] is not None:
            kwargs["range_key"] = args["range"]
        if name == "grading_upside" and isinstance(kwargs.get("card_ids"), list):
            # The answer compares every candidate in a table; three keep it readable.
            kwargs["card_ids"] = kwargs["card_ids"][:MAX_GRADING_CANDIDATES]
        if name == "get_card":
            kwargs["include_holdings"] = True
        if name == "find_missing" and "sort" not in kwargs and "budget_usd" not in kwargs:
            kwargs["sort"] = "value_desc"  # chase cards first; cheapest only for budget questions
        try:
            self.policy.check_inputs(kwargs.get("card_filter"), sort=kwargs.get("sort"), owned=kwargs.get("owned"))
        except ValueError as error:
            raise ToolInputError(str(error)) from None
        result = self.policy.shape(getattr(self.tools, name)(owner_user_id, **kwargs))
        if name == "search_cards" and isinstance(result, dict) and uses_art_filters(kwargs.get("card_filter") or {}):
            result = self._collapse_art_results(result, kwargs.get("card_filter") or {})
        if name == "get_my_watchlist" and isinstance(result, dict) and isinstance(result.get("items"), list):
            result["items"] = watchlist_order(result["items"])
            result["order"] = "target price set first (closest to target first), then market price high to low"
        chart = None
        if name == "get_price_history" and isinstance(result, dict):
            card = card_by_id(self.conn, str(result.get("card_id") or ""))
            chart = price_chart(
                result, name=card.get("name") if card else None, range_key=kwargs.get("range_key") or "90d"
            )
        return ToolOutcome(strip_for_model(result), cards=card_refs(result), chart=chart)

    def _collapse_art_results(self, result: dict[str, Any], card_filter: dict[str, Any]) -> dict[str, Any]:
        """Art searches show one printing per artwork so the user sees more distinct scenes."""
        items = [item for item in result.get("results") or [] if isinstance(item, dict)]
        language = str(card_filter.get("language") or "")
        preferred = language if language in ("English", "Japanese") else "English"
        kept, hidden = collapse_same_art(
            items, art_groups(self.conn, [str(item.get("card_id")) for item in items]), preferred_language=preferred
        )
        if not hidden:
            return result
        return {**result, "results": kept, "same_art_printings_hidden": hidden}

    # --- proposals -----------------------------------------------------------

    def _card(self, card_id: Any) -> dict[str, Any]:
        card_id = str(card_id or "").strip()
        card = card_by_id(self.conn, card_id) if card_id else None
        if card is None:
            raise ToolInputError(f"Card not found: {card_id or '(empty)'}. Look it up with search_cards first.")
        return card

    def _card_tile(self, card_id: str) -> list[dict[str, Any]]:
        summaries = self.tools._summaries([card_id])
        return card_refs(self.policy.shape(list(summaries.values())))

    @staticmethod
    def _quantity(value: Any, *, default: int | None) -> int | None:
        if value is None:
            return default
        if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
            raise ToolInputError("quantity must be a whole number.")
        quantity = int(value)
        if quantity < 1:
            raise ToolInputError("quantity must be at least 1 (removing cards is not supported here).")
        if quantity > MAX_QUANTITY:
            raise ToolInputError(f"quantity must be at most {MAX_QUANTITY}.")
        return quantity

    @staticmethod
    def _condition(value: Any) -> str | None:
        if value is None:
            return None
        code = str(value).strip().upper()
        if code not in CONDITIONS:
            raise ToolInputError(f"condition must be one of {', '.join(CONDITIONS)}.")
        return code

    @staticmethod
    def _action(action_type: str, summary: str, params: dict[str, Any]) -> dict[str, Any]:
        return {"id": new_id("act"), "type": action_type, "summary": summary, "params": params, "state": "proposed"}

    @staticmethod
    def _proposed(action: dict[str, Any], cards: list[dict[str, Any]]) -> ToolOutcome:
        return ToolOutcome(
            {
                "proposed": True,
                "action_id": action["id"],
                "summary": action["summary"],
                "note": "Shown to the user with a Confirm button. Nothing has changed yet.",
            },
            cards=cards,
            action=action,
        )

    def _propose_add(self, args: dict[str, Any], owner_user_id: str) -> ToolOutcome:
        card = self._card(args.get("card_id"))
        quantity = self._quantity(args.get("quantity"), default=1)
        grader = _optional_str(args.get("grader"), limit=12)
        grade = _optional_str(args.get("grade"), limit=12)
        if bool(grader) != bool(grade):
            raise ToolInputError("A slab needs both grader and grade, e.g. grader='PSA', grade='10'.")
        grader = grader.upper() if grader else None
        condition = self._condition(args.get("condition"))
        if grader:
            condition = None  # slabs carry a grade, not a condition
        elif condition is None:
            condition = "NM"
        variant_name = _optional_str(args.get("variant_name"))
        collection_id = self.tools._require_collection(owner_user_id, args.get("collection_id"))
        collection_name = None
        if collection_id:
            row = self.conn.execute(
                "SELECT name FROM collections WHERE id = ? AND owner_user_id = ?", (collection_id, owner_user_id)
            ).fetchone()
            collection_name = str(row["name"]) if row and row["name"] else None
        parts = [f"Add {_card_label(card)}"]
        if variant_name:
            parts.append(variant_name)
        parts.append(f"{grader} {grade}" if grader else str(condition))
        parts.append(f"×{quantity}")
        if collection_name:
            parts.append(f"to {collection_name}")
        action = self._action(
            "add_to_collection",
            " · ".join(parts),
            {
                "card_id": card["id"],
                "quantity": quantity,
                "condition": condition,
                "variant_name": variant_name,
                "grader": grader,
                "grade": grade,
                "collection_id": collection_id,
            },
        )
        return self._proposed(action, self._card_tile(card["id"]))

    def _add_now(self, args: dict[str, Any], owner_user_id: str, turn: TurnWrites | None) -> ToolOutcome:
        card = self._card(args.get("card_id"))
        quantity = self._quantity(args.get("quantity"), default=None)
        grader = _optional_str(args.get("grader"), limit=12)
        grade = _optional_str(args.get("grade"), limit=12)
        grader = grader.upper() if grader else None
        condition = self._condition(args.get("condition"))
        variant_name = _optional_str(args.get("variant_name"))
        question = turn.question if turn else ""
        reason = turn.blocked_reason() if turn else "direct add unavailable"
        if reason is None and quantity is None:
            reason = "quantity not given"
        if reason is None:
            if grader or grade:
                if not (grader and grade):
                    reason = "a slab needs both grader and grade"
                elif not grade_stated(question, grader, grade):
                    reason = "the user didn't state this grader and grade"
                condition = None
            elif condition is None:
                reason = "condition not given"
            elif not condition_stated(question, condition):
                reason = "the user didn't state this condition"
        if reason is None:
            variant_name, reason = resolve_variant(self.tools.service, card["id"], variant_name)
        if reason is not None or turn is None or not turn.client_message_id:
            return self._add_fallback(args, owner_user_id, reason or "direct add unavailable")

        params = {
            "card_id": card["id"], "quantity": quantity, "condition": condition, "variant_name": variant_name,
            "grader": grader, "grade": grade, "collection_id": None,
        }
        key = request_key(turn.client_message_id, params)
        adder = DirectAdder(self.tools.service)
        try:
            stored = adder.add(owner_user_id, key=key, params=params)
        except (ValueError, FileNotFoundError) as error:
            return ToolOutcome({"added": False, "error": f"Not added: {error}"}, is_error=True)
        except Exception:  # noqa: BLE001 - the write rolled back; never leak internals
            logger.exception("assistant direct add failed")
            return ToolOutcome({"added": False, "error": "Ekalight couldn't save this add. Nothing was added."}, is_error=True)
        turn.executed += 1
        parts = [f"Added {_card_label(card)}"]
        if variant_name:
            parts.append(variant_name)
        parts.append(f"{grader} {grade}" if grader else str(condition))
        parts.append(f"×{quantity}")
        action = {
            "id": action_id_for(key),
            "type": "add_to_collection",
            "summary": " · ".join(parts),
            "params": params,
            "state": "done",
            "undo": {
                "deck_entry_id": str(stored["holding_id"]),
                "quantity_added": int(stored["added_quantity"]),
                "expires_at": expires_at(),
            },
        }
        owned_now = adder.total_owned(owner_user_id, card["id"])
        tiles = self._card_tile(card["id"])[:1]
        for tile in tiles:
            tile.update({"quantity_owned": owned_now, "variant": variant_name or tile.get("variant")})
            if grader:
                tile.update({"grader": grader, "grade": grade, "price_usd": None})
        return ToolOutcome(
            {
                "added": True,
                "action_id": action["id"],
                "summary": action["summary"],
                "quantity_added": quantity,
                "quantity_owned_now": owned_now,
                "note": "Saved. Tell the user it was added; the app shows an Undo button.",
            },
            cards=tiles,
            action=action,
        )

    def _add_fallback(self, args: dict[str, Any], owner_user_id: str, reason: str) -> ToolOutcome:
        outcome = self._propose_add(args, owner_user_id)
        outcome.content = {
            **outcome.content,
            "added": False,
            "reason": reason,
            "note": f"Not added ({reason}). Shown with a Confirm button; nothing has changed yet.",
        }
        return outcome

    def undo_add(self, owner_user_id: str, action: dict[str, Any]) -> None:
        identity = RequestIdentity(user_id=owner_user_id, auth_source="assistant")
        with self.tools.service.request_identity_context(identity):
            DirectAdder(self.tools.service).undo(owner_user_id, action)

    def _propose_update(self, args: dict[str, Any], owner_user_id: str) -> ToolOutcome:
        holding_id = str(args.get("holding_id") or "").strip()
        row = (
            self.conn.execute(
                """
                SELECT id, card_id, quantity, condition, grader, grade FROM deck_entries
                WHERE id = ? AND owner_user_id = ? AND quantity > 0
                """,
                (holding_id, owner_user_id),
            ).fetchone()
            if holding_id
            else None
        )
        if row is None:
            raise ToolInputError("Holding not found in the user's collection. Use holding_id from get_my_collection.")
        quantity = self._quantity(args.get("quantity"), default=None)
        condition = self._condition(args.get("condition"))
        if quantity is None and condition is None:
            raise ToolInputError("Give a new quantity and/or condition.")
        is_slab = bool(str(row["grader"] or "").strip() or str(row["grade"] or "").strip())
        if condition is not None and is_slab:
            raise ToolInputError("Graded slabs have a grade, not a condition.")
        card = self._card(row["card_id"])
        old_condition = DECK_CONDITION_CODES.get(str(row["condition"] or "").strip().lower())
        parts = [f"Update {_card_label(card)}"]
        if is_slab:
            parts.append(f"{str(row['grader']).strip()} {str(row['grade']).strip()}")
        if quantity is not None:
            parts.append(f"×{int(row['quantity'])} → ×{quantity}")
        if condition is not None:
            parts.append(f"{old_condition or '?'} → {condition}")
        action = self._action(
            "update_holding",
            " · ".join(parts),
            {"holding_id": str(row["id"]), "quantity": quantity, "condition": condition},
        )
        return self._proposed(action, self._card_tile(card["id"]))

    def _propose_watch(self, args: dict[str, Any], owner_user_id: str) -> ToolOutcome:
        del owner_user_id  # the card is catalog-wide; the app writes the user's Watchlist
        card = self._card(args.get("card_id"))
        variant = _optional_str(args.get("variant"))
        target = args.get("target_price_usd")
        if target is not None:
            if isinstance(target, bool) or not isinstance(target, (int, float)) or target <= 0:
                raise ToolInputError("target_price_usd must be a positive USD amount.")
            if target > 1_000_000:
                raise ToolInputError("target_price_usd is too large.")
            target = round(float(target), 2)
        parts = [f"Add {_card_label(card)} to Watchlist"]
        if variant:
            parts.append(variant)
        if target is not None:
            parts.append(f"alert at ${target:,.2f} or less")
        action = self._action(
            "watch_card",
            " · ".join(parts),
            {"card_id": card["id"], "variant": variant, "target_price_usd": target},
        )
        return self._proposed(action, self._card_tile(card["id"]))

    # --- tiles ---------------------------------------------------------------

    def finalize_cards(self, refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Dedupe (card + slab, then same-language reprints of one artwork), cap
        at MAX_CARDS, fill name/image/price from the DB for slim refs."""
        seen: set[tuple[str, str, str]] = set()
        unique: list[dict[str, Any]] = []
        for ref in refs:
            key = (ref["card_id"], str(ref.get("grader") or ""), str(ref.get("grade") or ""))
            if key in seen:
                continue
            seen.add(key)
            unique.append(dict(ref))
        groups = art_groups(self.conn, [ref["card_id"] for ref in unique])
        out = collapse_same_art(unique, groups, across_languages=False)[0][:MAX_CARDS]
        missing = [
            ref["card_id"] for ref in out if not ref.get("image_small_url") or not ref.get("app_url") or not ref.get("name")
        ]
        if missing:
            summaries = self.tools._summaries(missing)
            for ref in out:
                summary = summaries.get(ref["card_id"])
                if summary is None:
                    continue
                for key in ("name", "image_small_url", "app_url", "set", "number", "language"):
                    if not ref.get(key):
                        ref[key] = summary.get(key)
                if ref.get("price_usd") is None and not (ref.get("grader") or ref.get("grade")):
                    ref["price_usd"] = summary.get("price_usd")
        # A scanned/earlier id that no longer resolves has no name: no tile.
        return [ref for ref in out if ref.get("name")]

    def build_tiles(
        self,
        *,
        owner_user_id: str,
        turn_refs: list[dict[str, Any]],
        selection: list[dict[str, Any]] | None,
        label: str | None,
        text: str,
        charts: list[dict[str, Any]],
        watchlist_ids: set[str],
        watchlist_total: int | None,
        sparkline_windows: dict[str, tuple[str, str | None]],
        extra_refs: list[dict[str, Any]] | None = None,
        keep_ids: set[str] | None = None,
        always_ids: set[str] | None = None,
        list_ids: set[str] | None = None,
        question: str = "",
        fixed: bool = False,
    ) -> tuple[list[dict[str, Any]], str | None, dict[str, Any] | None, list[dict[str, Any]]]:
        """(cards, cards_label, cards_view_all, charts). fixed=True (an executed
        direct add) shows the selection as is; otherwise choose_tiles decides."""
        if fixed:
            tiles = list(selection or [])
        else:
            if selection is None:
                label = None
            tiles, charts = choose_tiles(
                selection, list(turn_refs), text, charts, extra_refs=extra_refs or [], keep_ids=keep_ids or set(),
                always_ids=always_ids or set(), watchlist_ids=watchlist_ids, list_ids=list_ids or set(),
                question=question,
            )
        charts = charts[:MAX_CHARTS]
        on_watchlist = bool(watchlist_ids) and bool(tiles) and all(tile["card_id"] in watchlist_ids for tile in tiles)
        if on_watchlist:
            tiles = tiles[:MAX_WATCHLIST_TILES]
        cards = self.finalize_cards(tiles)
        view_all = None
        if on_watchlist and watchlist_total and watchlist_total > len(cards):
            view_all = {"screen": "watchlist", "total": int(watchlist_total)}
        for card in cards[:MAX_WATCHLIST_TILES]:
            window = sparkline_windows.get(card["card_id"])
            if window and not card.get("grader"):
                line = self.sparkline(owner_user_id, card["card_id"], range_key=window[0], variant=window[1])
                if line is not None:
                    card["sparkline"] = line
        return cards, label, view_all, charts

    def sparkline(
        self, owner_user_id: str, card_id: str, *, range_key: str, variant: str | None
    ) -> dict[str, Any] | None:
        """Compact stored-history series for a tile (DB-only), or None."""
        identity = RequestIdentity(user_id=owner_user_id, auth_source="assistant")
        chart = None
        try:
            with self.tools.service.request_identity_context(identity):
                for wanted in dict.fromkeys((variant, None)):
                    result = self.tools.get_price_history(owner_user_id, card_id, range_key=range_key, variant=wanted)
                    chart = price_chart(result, name=None, range_key=range_key)
                    if chart is not None:
                        break
        except Exception:  # noqa: BLE001 - a missing sparkline never fails an answer
            logger.debug("assistant sparkline failed for %s", card_id, exc_info=True)
            return None
        if chart is None:
            return None
        points = downsample([point["usd"] for point in chart["points"]], MAX_SPARKLINE_POINTS)
        first, last = points[0], points[-1]
        return {
            "range": range_key,
            "points": points,
            "change_pct": round((last - first) / first * 100, 1) if first else None,
        }

    def scanner_context(self, card_ids: list[str]) -> str | None:
        """'The user is looking at these scanned cards: …' line for the model."""
        summaries = self.tools._summaries(card_ids)
        if not summaries:
            return None
        lines = []
        for card_id in card_ids:
            summary = summaries.get(card_id)
            if summary is None:
                continue
            price = summary.get("price_usd")
            lines.append(
                f"- {summary.get('name')} · {summary.get('set') or '?'} · #{summary.get('number') or '?'} · "
                f"{'$' + format(price, ',.2f') if price is not None else 'no price'} (card_id: {card_id})"
            )
        if not lines:
            return None
        return "The user is looking at these scanned cards:\n" + "\n".join(lines)
