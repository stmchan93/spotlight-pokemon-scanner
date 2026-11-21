"""Tools the assistant model sees: the 14 CollectionTools reads (owner = the
request user, DB-only), 3 propose_* tools that validate and return a
ProposedAction without changing anything, and add_to_collection_now, which
writes a fully specified add (direct_add.py) or falls back to a proposal.

Strict mode: the API caps strict schemas at 24 optional parameters per request,
and the seven filter tools alone carry ~140 (CardFilter x 7), so those seven are
sent non-strict and validated server-side by normalize_card_filter; every other
tool (incl. all propose_* writes) is strict.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from catalog_tools import SUPPORTED_GAMES, _table_columns, _table_exists, card_by_id, game_display_name

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
    MOVERS_DESCRIPTION,
    NEW_HIGHS_DESCRIPTION,
    PRICE_LOWS_DESCRIPTION,
    PRICE_RANK_NOTE,
    PRODUCT_FILTER_NOTE,
    TOP_GRADED_DESCRIPTION,
    WATCHLIST_DESCRIPTION,
    CollectionTools,
)
from request_auth import RequestIdentity
from set_spotlight import _fallback_logo_url as scrydex_logo_fallback

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


def _swap(text: str, old: str, new: str) -> str:
    if old not in text:
        raise AssertionError(f"shared tool description changed: {old!r}")
    return text.replace(old, new)


# Owner 2026-11-20: the chat never reveals history coverage; compact.py sends window_label instead.
WINDOW_LABEL_NOTE = (
    "window_label is the phrase to use for the window ('past year' when the card's history covers it, "
    "else 'recently': then never name the window)."
)
ASSISTANT_PRICE_LOWS_DESCRIPTION = _swap(
    PRICE_LOWS_DESCRIPTION,
    "days_covered (history actually available; under a year means the '1y low' covers only that span).",
    "window_label. " + WINDOW_LABEL_NOTE,
)
ASSISTANT_NEW_HIGHS_DESCRIPTION = _swap(
    NEW_HIGHS_DESCRIPTION,
    "days_covered (history actually available; under the window means the high covers only that span).",
    "window_label. " + WINDOW_LABEL_NOTE,
)
ASSISTANT_MOVERS_DESCRIPTION = _swap(
    MOVERS_DESCRIPTION,
    "change_pct, days_covered and covers_full_window (false = history starts after the window start: say how much it covers).",
    "change_pct and window_label. " + WINDOW_LABEL_NOTE,
)
# Market/movers tool window -> get_price_history range to fetch (history has no 7d range).
SPARKLINE_RANGES = {"7d": "30d", "30d": "30d", "90d": "90d", "1y": "1y"}
MOVER_SPARKLINE_RANGES = SPARKLINE_RANGES
SPARKLINE_TOOLS = frozenset({"find_price_lows", "find_new_highs", "find_movers", "get_market_trends"})
# Tile caption ranges, longest first; a sparkline is labelled only with a range its series covers.
SPARKLINE_LABEL_DAYS = {"1y": 365, "90d": 90, "30d": 30, "7d": 7}
SPARKLINE_SLACK_DAYS = 7
# Fields the model never needs (tiles carry them); dropping them saves tokens.
MODEL_HIDDEN_KEYS = frozenset({"image_small_url", "app_url", "tcgplayer_id", "buy_links"})
# Per-call ceilings for the model (the MCP tools allow more).
MODEL_LIMITS = {
    "search_cards": 20,
    "find_missing": 20,
    "find_price_lows": 20,
    "find_new_highs": 20,
    "find_movers": 10,
    "get_my_collection": 50,
    "get_my_watchlist": 50,
    "find_top_graded": 20,
}
FILTER_TOOLS = (
    "search_cards", "get_my_collection", "find_missing", "find_price_lows", "find_new_highs", "find_top_graded",
    "find_movers",
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
            "leader AND call find_top_graded for the graded leader. If resolved_owned_card_id is set, use it: it is "
            "the one matching printing the user owns."
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
            "The user's own holdings (use only for questions about their collection) with holding_id, quantity, "
            "condition/grade, printing (variant), price_usd (one copy) and value_usd (price_usd x quantity). "
            "sort: 'price_desc' (per-copy price) for 'most valuable cards'/'priciest card I own'/'most valuable "
            "slab'; 'value_desc' (holding total) for 'top holdings' and what the collection is worth. "
            "holding_type='graded' = slabs only, 'raw' = ungraded only. total_value_usd covers all matching "
            "holdings, not just this page. Hidden collections are excluded unless collection_id names one."
        ),
        "input_schema": _obj(
            {
                "filter": _FILTER_SCHEMA,
                "collection_id": {"type": "string"},
                "sort": {"type": "string", "enum": ["value_desc", "price_desc", "gain_desc", "added_desc"]},
                "holding_type": {"type": "string", "enum": ["any", "raw", "graded"]},
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
        "description": (
            "The user's collection value in USD, how it moved over the range, top_holdings (largest by value), "
            "and top gainers/losers. focus='movers' for the user's collection gainers/losers ('my biggest gainers "
            "this month'; returns only the movers; name the dollar and percent leaders only from "
            "top_gainer_by_usd/top_gainer_by_pct/top_loser_by_usd/top_loser_by_pct); focus='value' (default) for "
            "what the collection is worth. "
            "Movers within a set, rarity or card name (incl. 'my <set> cards'): find_movers."
        ),
        "input_schema": _obj(
            {
                "range": {"type": "string", "enum": ["7d", "30d", "90d", "1y"]},
                "focus": {"type": "string", "enum": ["value", "movers"]},
            },
            [],
        ),
        "strict": True,
    },
    {
        "name": "get_price_history",
        "description": (
            "Daily USD price history for one printing of a card: raw by condition, or graded when grader and "
            "grade are both given (e.g. PSA 10). days_since_as_of says how old the newest point is. "
            "summary has the dated move (first_usd -> last_usd). " + WINDOW_LABEL_NOTE + " variant is a printing (Holofoil, Reverse "
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
        "description": ASSISTANT_PRICE_LOWS_DESCRIPTION,
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
        "description": ASSISTANT_NEW_HIGHS_DESCRIPTION,
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
        "name": "find_movers",
        "description": ASSISTANT_MOVERS_DESCRIPTION + " " + PRODUCT_FILTER_NOTE,
        "input_schema": _obj(
            {
                "filter": _FILTER_SCHEMA,
                "direction": {"type": "string", "enum": ["up", "down"], "description": "up = gainers, down = decliners."},
                "window": {"type": "string", "enum": ["7d", "30d", "90d", "1y"], "description": "Default 30d."},
                "owned": {"type": "string", "enum": ["any", "owned"]},
                "rank_by": {"type": "string", "enum": ["pct", "usd"], "description": "Default pct."},
                "limit": {"type": "integer", "description": "1-10, default 3."},
            },
            ["direction"],
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
        .replace("graded market estimate", "graded market price")
        + " Pass the user's 3 most valuable raw singles (get_my_collection sort=value_desc, product=single; skip "
        "slabs); they are the candidates to compare. For a scan tray question, pass the tray's card ids. Answer with one "
        "bullet per card (never a table) and don't call a comp an estimate or say what it's based on.",
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
    "find_movers",
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


def sparkline_fetch_range(tool: str, content: Any) -> str | None:
    """The get_price_history range behind a market/movers tool's tile sparklines."""
    if not isinstance(content, dict):
        return None
    if tool == "get_market_trends":
        days = content.get("cards_window_days")
        if not isinstance(days, int) or days <= 0:
            return None
        return "30d" if days <= 30 else "90d" if days <= 90 else "1y"
    return SPARKLINE_RANGES.get(str(content.get("window") or ""))


def covered_range(
    points: list[dict[str, Any]], *, max_days: int, today: date | None = None
) -> tuple[str | None, list[dict[str, Any]]]:
    """(longest standard range <= max_days that the series covers, that range's points);
    (None, []) when it covers none with at least 2 points."""
    today = today or datetime.now(timezone.utc).date()
    dated = [p for p in points if isinstance(p, dict) and p.get("date")]
    if not dated:
        return None, []
    first = date.fromisoformat(str(dated[0]["date"])[:10])
    for label, days in SPARKLINE_LABEL_DAYS.items():
        if days > max_days:
            continue
        start = today - timedelta(days=days)
        if first > start + timedelta(days=min(SPARKLINE_SLACK_DAYS, max(1, days // 4))):
            continue
        series = [p for p in dated if str(p["date"])[:10] >= start.isoformat()]
        if len(series) >= 2:
            return label, series
    return None, []


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
    keep, _ = _pins(refs, text)
    return [ref for ref in refs if id(ref) in keep]


def explicit_pins(refs: list[dict[str, Any]], text: str) -> list[dict[str, Any]]:
    """Refs the text pins by number or set (not the first-listed fallback)."""
    _, explicit = _pins(refs, text)
    return [ref for ref in refs if id(ref) in explicit]


def _pins(refs: list[dict[str, Any]], text: str) -> tuple[set[int], set[int]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for ref in refs:
        groups.setdefault(_name_key(ref), []).append(ref)
    set_keys = {_set_key(ref) for ref in refs} - {""}
    named_sets = _uncovered({key: _phrase_spans(key, text) for key in set_keys})
    keep: set[int] = set()
    explicit: set[int] = set()
    for group in groups.values():
        by_number = [ref for ref in group if _number_in_text(ref.get("number"), text)]
        numbered_sets = {_set_key(ref) for ref in by_number}
        by_set = [
            ref for ref in group
            if _set_key(ref) in named_sets and _set_key(ref) not in numbered_sets and _slab_mentioned(ref, text)
        ]
        explicit.update(id(ref) for ref in by_number + by_set)
        pins = by_number + by_set or group[:1]
        pinned = {str(ref["card_id"]) for ref in pins}
        keep.update(id(ref) for ref in pins)
        keep.update(id(ref) for ref in group if str(ref["card_id"]) in pinned and _slab_mentioned(ref, text))
    return keep, explicit


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
        picked = list(selection) if selection else named_refs(refs, text) or list(refs)
        return picked[:MAX_CHOICE_TILES], charts
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
    # A selected name hides its other printings unless the text pins one ('CGC 9.5 Mickey Mouse from Challenge Promos').
    explicit = {id(ref) for ref in explicit_pins(named, text)}
    _append_new(kept, [ref for ref in named if _name_key(ref) not in covered or id(ref) in explicit])
    return _append_new(kept, always), charts


# --- question-shaped tile rules (deterministic; the model over-selects) -------

MAX_RANKED_TILES = 3  # movers / highs / lows / trends answers name at most three cards
MAX_HOLDING_TILES = 8
HOLDINGS_LABEL = "Top holdings by value"
RANKING_TOOLS = frozenset({"find_new_highs", "find_price_lows", "find_movers", "get_market_trends"})
_VALUE_WORDS = re.compile(r"\b(worth|value|valued)\b", re.IGNORECASE)
_COLLECTION_WORDS = re.compile(r"\b(collection|portfolio|holdings|binder)\b", re.IGNORECASE)
_SINGULAR_TOP = re.compile(
    r"\bthe\s+(most expensive|priciest|most valuable)\s+(?:[\w.'\u2019-]+\s+){0,3}?(card|single|slab)\b(?!s)",
    re.IGNORECASE,
)
_COUNTERPART = re.compile(
    r"\b(japanese|english|jp|en)\s+(version|counterpart|printing|equivalent|release)s?\b"
    r"|\b(version|counterpart|printing|equivalent|release)s?\s+in\s+(japanese|english)\b",
    re.IGNORECASE,
)


def is_collection_value_question(question: str) -> bool:
    """'What's my collection worth?', 'How much is my One Piece collection worth?'."""
    return bool(_VALUE_WORDS.search(question or "")) and bool(_COLLECTION_WORDS.search(question or ""))


def asks_for_single_leader(question: str) -> bool:
    """'What's the most expensive One Piece card?' (singular): one leader per kind (raw, graded)."""
    return bool(_SINGULAR_TOP.search(question or ""))


def counterpart_language(question: str) -> str | None:
    """'Is there a Japanese version of X?' -> 'japanese'; None if not a counterpart question."""
    match = _COUNTERPART.search(question or "")
    if match is None:
        return None
    word = (match.group(1) or match.group(4) or "").casefold()
    return "japanese" if word in ("japanese", "jp") else "english"


def holding_value(ref: dict[str, Any]) -> float:
    price = ref.get("price_usd")
    if not isinstance(price, (int, float)) or isinstance(price, bool):
        return -1.0
    return float(price) * float(ref.get("quantity_owned") or 1)


def order_by_mention(tiles: list[dict[str, Any]], text: str) -> list[dict[str, Any]]:
    """Named cards in the order the text names them; un-named tiles after (stable)."""

    def first(tile: dict[str, Any]) -> int:
        spans = _phrase_spans(_name_key(tile), text) if _name_key(tile) else []
        return min((start for start, _ in spans), default=len(text) + 1)

    return sorted(tiles, key=first)


def _named_ids(tiles: list[dict[str, Any]], text: str) -> set[int]:
    return {id(tile) for tile in pin_printings(named_refs(tiles, text), text)}


def single_leaders(tiles: list[dict[str, Any]], text: str = "") -> list[dict[str, Any]]:
    """The first raw tile and the first graded tile, plus every tile the text names."""
    raw = next((tile for tile in tiles if _slab(tile)[0] is None), None)
    graded = next((tile for tile in tiles if _slab(tile)[0] is not None), None)
    keep = {id(tile) for tile in (raw, graded) if tile is not None} | _named_ids(tiles, text)
    return [tile for tile in tiles if id(tile) in keep]


def cap_unnamed(tiles: list[dict[str, Any]], text: str, cap: int) -> list[dict[str, Any]]:
    """Every named tile (in mention order), then unnamed ones while under the cap."""
    named = _named_ids(tiles, text)
    room = cap - sum(1 for tile in tiles if id(tile) in named)
    out: list[dict[str, Any]] = []
    for tile in order_by_mention(tiles, text):
        if id(tile) in named:
            out.append(tile)
        elif room > 0:
            out.append(tile)
            room -= 1
    return out


def _slab_phrase(ref: dict[str, Any], text: str) -> bool:
    grader, grade = _slab(ref)
    return bool(grader and grade) and bool(
        re.search(r"(?<!\w)" + re.escape(grader) + r"\s*" + re.escape(grade) + r"(?!\w|\.\d)", text, re.IGNORECASE)
    )


def named_slabs(tiles: list[dict[str, Any]], pool: list[dict[str, Any]], text: str) -> list[dict[str, Any]]:
    """Tiles plus graded refs the text names with their slab ('CGC 9.5 ... Mickey Mouse')."""
    names = {_name_key(ref) for ref in named_refs(pool, text)}
    out = list(tiles)
    for ref in pool:
        if _name_key(ref) in names and _slab_phrase(ref, text) and not any(
            _name_key(tile) == _name_key(ref) and _slab(tile) == _slab(ref) for tile in out
        ):
            out.append(ref)
    return out


MISSING_LABEL = "Highest-value cards you're missing"
# A budget/cheapest ask sorts find_missing price_asc: those tiles aren't the highest-value ones.
_CHEAP_ASK = re.compile(r"\b(cheap\w*|under|below|less than|budget|afford\w*|least)\b|\$\s*\d", re.IGNORECASE)


def apply_question_rules(
    tiles: list[dict[str, Any]],
    charts: list[dict[str, Any]],
    label: str | None,
    *,
    question: str,
    text: str,
    pool: list[dict[str, Any]],
    holding_refs: list[dict[str, Any]],
    language_pairs: dict[str, str],
    keep_ids: frozenset[str] | set[str] = frozenset(),
    always_ids: frozenset[str] | set[str] = frozenset(),
    tools_used: frozenset[str] | set[str] = frozenset(),
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None]:
    """Owner rules keyed on the question shape, applied after choose_tiles:
    collection value -> top holdings by value; counterpart -> the counterpart
    (+ the scanned source); movers/highs/lows/trends -> at most 3 cards; a
    singular 'the most expensive card' -> one raw + one graded leader. Caps
    only drop tiles the text doesn't name."""
    if always_ids:
        return tiles, charts, label  # proposals decide their own tiles
    if label is None and tiles and "find_missing" in tools_used and not _CHEAP_ASK.search(question or ""):
        label = MISSING_LABEL
    wanted = counterpart_language(question)
    if wanted and language_pairs:
        refs_by_id: dict[str, dict[str, Any]] = {}
        for ref in [*tiles, *pool]:
            if _slab(ref)[0] is None:
                refs_by_id.setdefault(str(ref["card_id"]), ref)
        counterparts = [
            target for source, target in language_pairs.items()
            if _language(refs_by_id.get(target) or {"card_id": target}) == wanted
            and _language(refs_by_id.get(source) or {"card_id": source}) != wanted
        ]
        if counterparts:
            sources = [source for source, target in language_pairs.items() if target in counterparts and source in keep_ids]
            ids = list(dict.fromkeys([*sources, *counterparts]))
            picked = [dict(refs_by_id.get(card_id) or {"card_id": card_id}) for card_id in ids]
            return picked, [chart for chart in charts if chart["card_id"] in ids], label
    if holding_refs and is_collection_value_question(question) and not is_movers_question(question) and not charts:
        holding_ids = {ref["card_id"] for ref in holding_refs}
        named_holdings = [tile for tile in tiles if tile["card_id"] in holding_ids]
        ranked = _append_new(list(holding_refs), named_holdings)
        ranked.sort(key=holding_value, reverse=True)
        return ranked[:MAX_HOLDING_TILES], charts, HOLDINGS_LABEL
    if is_movers_question(question) or tools_used & RANKING_TOOLS:
        if len(tiles) > MAX_RANKED_TILES:
            tiles = cap_unnamed(tiles, text, MAX_RANKED_TILES)
        return tiles, charts, label
    if "find_top_graded" in tools_used and not charts:
        tiles = named_slabs(tiles, pool, text)
    if asks_for_single_leader(question) and tools_used & {"search_cards", "find_top_graded"} and not charts:
        return single_leaders(tiles, text), charts, label
    return tiles, charts, label


# --- set tiles (set-level answers show sets, not cards) ----------------------

MAX_SET_TILES = 6
SET_TREND_KEYS = ("rising_sets", "falling_sets")


def trend_set_refs(content: Any) -> list[dict[str, Any]]:
    """SetRefs from a get_market_trends result (rising then falling)."""
    if not isinstance(content, dict):
        return []
    game = _optional_str(content.get("sets_game"), limit=40)
    window = _optional_str(content.get("sets_window"), limit=10)
    refs: list[dict[str, Any]] = []
    for key in SET_TREND_KEYS:
        for entry in content.get(key) or []:
            if not isinstance(entry, dict) or not entry.get("set_id") or not entry.get("set"):
                continue
            change = entry.get("change_pct")
            refs.append({
                "set_id": str(entry["set_id"]),
                "name": str(entry["set"]),
                "game": game,
                "change_pct": float(change) if isinstance(change, (int, float)) and not isinstance(change, bool) else None,
                "window": window,
                "release_year": _optional_str(entry.get("release_year"), limit=4),
            })
    return refs


def _set_name_key(ref: dict[str, Any]) -> str:
    return " ".join(str(ref.get("name") or "").split()).casefold()


def named_sets(refs: list[dict[str, Any]], text: str) -> list[dict[str, Any]]:
    """Set refs the answer names, in mention order, one per set ('Base' inside
    'Base Set 2' doesn't count)."""
    spans = {key: _phrase_spans(key, text) for key in {_set_name_key(ref) for ref in refs} - {""}}
    names = _uncovered(spans)
    out: list[dict[str, Any]] = []
    for ref in refs:
        key = _set_name_key(ref)
        if key in names and not any(item["set_id"] == ref["set_id"] for item in out):
            out.append(ref)
    out.sort(key=lambda ref: min(start for start, _ in spans[_set_name_key(ref)]))
    return out[:MAX_SET_TILES]


def cards_beside_sets(
    cards: list[dict[str, Any]], sets: list[dict[str, Any]], text: str, *, keep_ids: frozenset[str] | set[str] = frozenset()
) -> list[dict[str, Any]]:
    """With set tiles showing, only the cards the text names itself stay (a card
    name seen only inside a set name doesn't count), plus keep_ids (charted cards)."""
    set_keys = {_set_name_key(ref) for ref in sets} - {""}
    card_keys = {_name_key(card) for card in cards} - {""}
    names = _uncovered({key: _phrase_spans(key, text) for key in card_keys | set_keys})
    return [
        card for card in cards
        if str(card.get("card_id")) in keep_ids or (_name_key(card) in names and _name_key(card) not in set_keys)
    ]


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


def artwork_groups(conn: sqlite3.Connection, card_ids: list[str]) -> dict[str, str]:
    """art_groups plus EN<->JP linked pairs (card_language_links) merged into one group,
    since a pair tagged before its link landed sits in two groups."""
    ids = list(dict.fromkeys(str(card_id) for card_id in card_ids if card_id))
    groups = art_groups(conn, ids)
    if not ids:
        return groups
    try:
        rows = conn.execute(
            "SELECT card_id, counterpart_card_id FROM card_language_links "
            f"WHERE card_id IN ({','.join('?' * len(ids))})",
            ids,
        ).fetchall()
    except sqlite3.OperationalError:
        return groups
    wanted = set(ids)
    for source, target in rows:
        source, target = str(source), str(target)
        if target not in wanted:
            continue
        key = groups.get(source) or groups.get(target) or source
        stale = {groups.get(source), groups.get(target)} - {None, key}
        for card_id, group in list(groups.items()):
            if group in stale:
                groups[card_id] = key
        groups[source] = groups[target] = key
    return groups


MAX_ART_TILES = 3
_ASKS_JAPANESE = re.compile(r"\b(japanese|jp|jpn)\b", re.IGNORECASE)


def art_search_tiles(
    tiles: list[dict[str, Any]], groups: dict[str, str], *, question: str, text: str
) -> list[dict[str, Any]]:
    """Art/vibe answers: one tile per artwork across languages (English unless the
    user asked for Japanese), named cards first, at most MAX_ART_TILES."""
    preferred = "japanese" if _ASKS_JAPANESE.search(question or "") else "english"
    tiles = collapse_same_art(tiles, groups, preferred_language=preferred)[0]
    named = _named_ids(tiles, text)
    ordered = [tile for tile in order_by_mention(tiles, text) if id(tile) in named]
    ordered += [tile for tile in tiles if id(tile) not in named]
    return ordered[:MAX_ART_TILES]


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


_MOVERS_QUESTION = re.compile(
    r"\b(gainers?|losers?|movers?|biggest (gain|drop|jump|loss|fall|mover)s?|"
    r"(up|down|risen|fallen|grown|gained|lost|dropped|fell|rose|climbed|jumped) the most)\b",
    re.IGNORECASE,
)
MAX_MOVERS = 3
MOVER_LEADER_KEYS = ("top_gainer_by_usd", "top_gainer_by_pct", "top_loser_by_usd", "top_loser_by_pct")
MOVER_KEYS = ("range", *MOVER_LEADER_KEYS, "top_gainers", "top_losers", "top_gainers_pct", "top_losers_pct",
              "movers_basis", "change_note")


# --- answer-shaping hints in tool results ---------------------------------------

MAX_CHOICE_TILES = 6
_PRICE_QUESTION = re.compile(r"\b(how much|price|priced|worth|value|cost|costs|going for)\b", re.IGNORECASE)
# Rankings, history, the user's own cards, lists: not a single-card price lookup.
_NOT_SINGLE_LOOKUP = re.compile(
    r"\b(most|cheapest|priciest|expensive|top|best|highest|lowest|history|trend|chart|over time|why|all|every|"
    r"cards|list|show|my|i own|under|over|below|above)\b|\d",
    re.IGNORECASE,
)
# Rankings and lists span printings: owning one doesn't make it the card meant.
_RANKING_QUESTION = re.compile(
    r"\b(most|cheapest|priciest|expensive|top|best|highest|lowest|all|every|list|under|over|below|above)\b",
    re.IGNORECASE,
)
CONDITION_NAMES = {"NM": "Near Mint", "LP": "Lightly Played", "MP": "Moderately Played", "HP": "Heavily Played",
                   "DMG": "Damaged"}


def _printing_label(item: dict[str, Any]) -> str:
    where = str(item.get("set") or "").strip()
    if item.get("number"):
        where = f"{where} #{item['number']}".strip()
    return where


def _named_printings(result: dict[str, Any], card_filter: Any, question: str) -> list[dict[str, Any]]:
    """One item per (set, number) of the card the filter names (no set filter); [] otherwise."""
    flt = card_filter if isinstance(card_filter, dict) else {}
    text = str(flt.get("text") or "").strip()
    if not text or flt.get("set"):
        return []
    items = [item for item in result.get("results") or [] if isinstance(item, dict) and item.get("card_id")]
    exact = [item for item in items if str(item.get("name") or "").casefold() == text.casefold()]
    candidates = exact or items
    lowered = (question or "").casefold()
    named_sets = [item for item in candidates if item.get("set") and str(item["set"]).casefold() in lowered]
    if named_sets:
        candidates = named_sets
    printings: dict[tuple[str, str], dict[str, Any]] = {}
    for item in candidates:
        printings.setdefault((str(item.get("set") or ""), str(item.get("number") or "")), item)
    return list(printings.values())


def owned_printing_hint(conn: Any, owner_user_id: str, result: dict[str, Any], card_filter: Any,
                        question: str) -> dict[str, Any]:
    """Several printings match but the user owns exactly one: that one is the card they mean."""
    if _RANKING_QUESTION.search(question or ""):
        return {}
    printings = _named_printings(result, card_filter, question)
    if len(printings) < 2:
        return {}
    ids =[str(item["card_id"]) for item in printings]
    marks = ",".join("?" for _ in ids)
    owned = [str(row[0]) for row in conn.execute(
        f"SELECT DISTINCT card_id FROM deck_entries WHERE owner_user_id = ? AND quantity > 0 AND card_id IN ({marks})",
        [owner_user_id, *ids],
    ).fetchall()]
    if len(owned) != 1:
        return {}
    item = next(item for item in printings if str(item["card_id"]) == owned[0])
    return {
        "resolved_owned_card_id": owned[0],
        "resolved_owned_note": f"The user owns only {item.get('name')} ({_printing_label(item)}): use this printing.",
    }


def ambiguity_hint(result: dict[str, Any], card_filter: Any, question: str) -> dict[str, Any]:
    """{ambiguous, ask_which} when a price question names a card (no set/number) and the
    lookup found several printings; {} when one printing clearly matches."""
    if not _PRICE_QUESTION.search(question or "") or _NOT_SINGLE_LOOKUP.search(question or ""):
        return {}
    candidates = _named_printings(result, card_filter, question)
    if len(candidates) < 2:
        return {}
    text = str((card_filter or {}).get("text") or "").strip()
    options = [_printing_label(item) for item in candidates[:3]]
    name = str(candidates[0].get("name") or text)
    return {
        "ambiguous": True,
        "ask_which": f"Which {name} do you mean: {', '.join(options[:-1])} or {options[-1]}?",
        "ambiguity_note": "Several printings match. Ask which one (set and number) instead of quoting one price.",
    }


def collection_total_first(result: dict[str, Any], card_filter: Any, question: str) -> dict[str, Any]:
    """Scoped collection-value answers lead with the scope's total: put it first and name the scope."""
    flt = card_filter if isinstance(card_filter, dict) else {}
    game = flt.get("game") if flt.get("game") not in (None, "any") else None
    head: dict[str, Any] = {"total_value_usd": result.get("total_value_usd"), "total_count": result.get("total_count")}
    if game:
        head["scope_label"] = game_display_name(game)
    if is_collection_value_question(question):
        head["answer_first"] = "Give total_value_usd first: it is the value of every matching holding."
    return {**head, **{key: value for key, value in result.items() if key not in head}}


def neutral_art_coverage(coverage: dict[str, Any]) -> dict[str, Any]:
    """Coverage stats without tag wording, so the answer never talks about 'tags'."""
    covered, total = coverage.get("tagged_cards"), coverage.get("catalog_cards")
    out: dict[str, Any] = {"described_cards": covered, "catalog_cards": total}
    if isinstance(covered, int) and isinstance(total, int):
        out["note"] = f"Artwork descriptions cover {covered:,} of {total:,} cards so far."
    return out


def history_summary(result: dict[str, Any], card: dict[str, Any] | None) -> str:
    """'Charizard ex (151 #199/165), Near Mint Holofoil: $374.44 on 2026-08-22 -> $287.93 on 2026-11-18 (-23.1%).'"""
    if result.get("grader"):
        basis = f"{result['grader']} {result.get('grade')}"
    else:
        code = str(result.get("condition") or "NM")
        basis = CONDITION_NAMES.get(code, code)
    if result.get("variant"):
        basis += f" {result['variant']}"
    who = ""
    if card:
        where = " ".join(p for p in (str(card.get("setName") or ""), f"#{card['number']}" if card.get("number") else "") if p)
        who = f"{card.get('name')}" + (f" ({where})" if where else "") + ", "
    first, last = result.get("first_usd"), result.get("last_usd")
    if not isinstance(first, (int, float)) or not isinstance(last, (int, float)):
        return f"{who}{basis}."
    move = f" ({(last - first) / first * 100:+.1f}%)" if first else ""
    return f"{who}{basis}: ${first:,.2f} on {result.get('first_date')} -> ${last:,.2f} on {result.get('last_date')}{move}."


def is_movers_question(question: str) -> bool:
    return bool(_MOVERS_QUESTION.search(question or ""))


def movers_only(summary: dict[str, Any]) -> dict[str, Any]:
    """Gainers/losers questions: just the top movers, no collection value or overall change to mention."""
    out = {key: summary[key] for key in MOVER_KEYS if key in summary}
    for key in ("top_gainers", "top_losers", "top_gainers_pct", "top_losers_pct"):
        if isinstance(out.get(key), list):
            out[key] = out[key][:MAX_MOVERS]
    return out


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
                    return self._read(name, dict(arguments or {}), owner_user_id, question=turn.question if turn else "")
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

    def _read(self, name: str, args: dict[str, Any], owner_user_id: str, *, question: str = "") -> ToolOutcome:
        kwargs: dict[str, Any] = {}
        if name in FILTER_TOOLS:
            kwargs["card_filter"] = args.get("filter")
        if name in MODEL_LIMITS:
            default = {
                # Investing answers name at most 3 cards: the model sees about that many.
                "get_my_collection": 25, "get_my_watchlist": 25, "find_price_lows": 3, "find_new_highs": 3,
                "find_movers": 3,
            }.get(name, 10)
            try:
                limit = int(args.get("limit") or default)
            except (TypeError, ValueError):
                limit = default
            kwargs["limit"] = max(1, min(limit, MODEL_LIMITS[name]))
        for key in ("owned", "sort", "cursor", "collection_id", "budget_usd", "card_id", "card_ids", "condition",
                    "grader", "grade", "variant", "game", "window", "min_price_usd", "max_price_usd", "holding_type",
                    "direction", "rank_by"):
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
            result = self._collapse_art_results(result, kwargs.get("card_filter") or {}, question)
        if name == "get_portfolio_summary" and isinstance(result, dict):
            movers = args.get("focus") == "movers" or is_movers_question(question)
            result = movers_only(result) if movers else result
        if name in ("get_portfolio_summary", "get_my_collection") and isinstance(result, dict):
            result.pop("unpriced_count", None)  # owner (L001): no unpriced-holdings note
        if name == "get_my_collection" and isinstance(result, dict):
            result = collection_total_first(result, kwargs.get("card_filter"), question)
        if name == "search_cards" and isinstance(result, dict) and not uses_art_filters(kwargs.get("card_filter") or {}):
            owned_hint = owned_printing_hint(self.conn, owner_user_id, result, kwargs.get("card_filter"), question)
            result = {**result, **(owned_hint or ambiguity_hint(result, kwargs.get("card_filter"), question))}
        if name == "search_cards" and isinstance(result, dict) and isinstance(result.get("art_coverage"), dict):
            result = {**result, "art_coverage": neutral_art_coverage(result["art_coverage"])}
        if name == "get_card" and isinstance(result, dict) and "tags" in result:
            result = {("artwork" if key == "tags" else key): value for key, value in result.items()}
        if name == "get_price_history" and isinstance(result, dict) and result.get("points"):
            summary_card = card_by_id(self.conn, str(result.get("card_id") or ""))
            result = {**result, "summary": history_summary(result, summary_card)}
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

    def _collapse_art_results(
        self, result: dict[str, Any], card_filter: dict[str, Any], question: str = ""
    ) -> dict[str, Any]:
        """Art searches show one printing per artwork so the user sees more distinct scenes."""
        items = [item for item in result.get("results") or [] if isinstance(item, dict)]
        language = str(card_filter.get("language") or "")
        if language not in ("English", "Japanese"):
            language = "Japanese" if _ASKS_JAPANESE.search(question or "") else "English"
        kept, hidden = collapse_same_art(
            items, artwork_groups(self.conn, [str(item.get("card_id")) for item in items]), preferred_language=language
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
        holding_refs: list[dict[str, Any]] | None = None,
        language_pairs: dict[str, str] | None = None,
        tools_used: set[str] | frozenset[str] = frozenset(),
        art_search: bool = False,
    ) -> tuple[list[dict[str, Any]], str | None, dict[str, Any] | None, list[dict[str, Any]]]:
        """(cards, cards_label, cards_view_all, charts). fixed=True (an executed
        direct add) shows the selection as is; otherwise choose_tiles decides,
        then the question-shaped rules (apply_question_rules)."""
        if fixed:
            tiles = list(selection or [])
        else:
            if selection is None:
                label = None
            extra_refs = self._named_extra_refs(extra_refs or [])
            tiles, charts = choose_tiles(
                selection, list(turn_refs), text, charts, extra_refs=extra_refs, keep_ids=keep_ids or set(),
                always_ids=always_ids or set(), watchlist_ids=watchlist_ids, list_ids=list_ids or set(),
                question=question,
            )
            tiles, charts, label = apply_question_rules(
                tiles, charts, label, question=question, text=text,
                pool=list(turn_refs) + [ref for ref in extra_refs if ref.get("name")],
                holding_refs=holding_refs or [], language_pairs=language_pairs or {},
                keep_ids=keep_ids or set(), always_ids=always_ids or set(), tools_used=tools_used,
            )
            # Counterpart questions keep their EN/JP pair; other art answers show one tile per artwork.
            if art_search and not always_ids and not charts and counterpart_language(question) is None:
                groups = artwork_groups(self.conn, [str(tile["card_id"]) for tile in tiles])
                tiles = art_search_tiles(tiles, groups, question=question, text=text)
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

    def build_set_tiles(
        self,
        set_refs: list[dict[str, Any]],
        text: str,
        cards: list[dict[str, Any]],
        charts: list[dict[str, Any]] | None = None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """(sets, cards): the sets the answer names become set tiles (logo, name,
        % change) and replace the card tiles, except cards the text names too."""
        sets = named_sets(set_refs, text)
        if not sets:
            return [], cards
        charted = {str(chart.get("card_id")) for chart in charts or []}
        return [self._set_tile(ref) for ref in sets], cards_beside_sets(cards, sets, text, keep_ids=charted)

    def _set_tile(self, ref: dict[str, Any]) -> dict[str, Any]:
        game = ref.get("game") or "pokemon"
        row = None
        if _table_exists(self.conn, "expansions"):
            has_game = "game" in _table_columns(self.conn, "expansions")
            game_sql = " AND game = ?" if has_game else ""
            select = "SELECT id, name, logo_url, symbol_url, image_url FROM expansions"
            row = self.conn.execute(f"{select} WHERE id = ?{game_sql}", (ref["set_id"], *((game,) if has_game else ()))).fetchone()
            if row is None:
                # Older group keys carry the label, not the id.
                row = self.conn.execute(
                    f"{select} WHERE name = ?{game_sql} ORDER BY (language = 'en') DESC, release_date DESC LIMIT 1",
                    (ref["name"], *((game,) if has_game else ())),
                ).fetchone()
        set_id = str(row[0]) if row is not None else ref["set_id"]
        logo = (row[2] or row[4]) if row is not None else None
        return {
            "set_id": set_id,
            "name": ref["name"],
            "game": game,
            "logo_url": logo or scrydex_logo_fallback(set_id, game),
            "symbol_url": row[3] if row is not None else None,
            "change_pct": ref.get("change_pct"),
            "window": ref.get("window"),
            "release_year": ref.get("release_year"),
        }

    def _named_extra_refs(self, refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Scanned-card refs arrive as bare ids: add name/set/number so the
        answer's text can name them (and they become tiles)."""
        bare = [str(ref["card_id"]) for ref in refs if not ref.get("name")]
        if not bare:
            return refs
        summaries = self.tools._summaries(bare)
        out = []
        for ref in refs:
            summary = summaries.get(str(ref["card_id"])) if not ref.get("name") else None
            if summary is None:
                out.append(ref)
                continue
            out.append({**ref, **{key: summary.get(key) for key in (
                "name", "set", "number", "language", "price_usd", "image_small_url", "app_url",
            )}})
        return out

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
        label, series = covered_range(chart["points"], max_days=SPARKLINE_LABEL_DAYS.get(range_key, 365))
        if label is None:
            return None
        points = downsample([point["usd"] for point in series], MAX_SPARKLINE_POINTS)
        first, last = points[0], points[-1]
        return {
            "range": label,
            "points": points,
            "change_pct": round((last - first) / first * 100, 1) if first else None,
        }

    def scanner_context(self, card_ids: list[str]) -> str | None:
        """The scan tray lines for the model ("The user's scan tray contains: …")."""
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
        return "The user's scan tray contains:\n" + "\n".join(lines)
