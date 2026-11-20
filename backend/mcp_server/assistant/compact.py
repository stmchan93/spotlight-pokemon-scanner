"""Compact tool results for the model's tool_result blocks (input-token cost).

Only the serialized copy the model reads is compacted. Tiles, charts,
sparklines, flags, direct add, the length guard and the eval recorder all use
the FULL ToolOutcome.content; engine.py calls model_payload() at the boundary.
Key names stay stable: the system prompt and tool descriptions reference them.
"""

from __future__ import annotations

import json
from typing import Any

MAX_HISTORY_POINTS = 12
MAX_HISTORY_STEPS = 3

# Nulls that carry meaning ("Ekalight has no price", "no counterpart").
KEEP_NULL_KEYS = frozenset({
    "price_usd", "language_pair", "value_usd", "total_value_usd", "change_usd", "change_pct",
    "raw_price_usd", "comp_price_usd", "cheapest_completion_usd",
})
# Dropped everywhere: catalog codes the model never needs, provider spans, trust prose.
DROP_KEYS = frozenset({"set_code", "sources", "price_trust_reason", "price_basis"})
# The default raw provider says nothing the answer can use; others (ebay_sold vs scrydex
# on graded prices, collection) are referenced by tool descriptions and kept.
DEFAULT_PRICE_SOURCE = "tcgplayer"
# Fields every item of a list shares are sent once, under all_<list>.
HOIST_KEYS = ("language", "collection", "gain_basis")
HOIST_MIN_ITEMS = 3
LIST_KEYS = (
    "results", "items", "cards", "missing", "rising_cards",
    "top_holdings", "top_gainers", "top_losers", "top_gainers_pct", "top_losers_pct",
)
# holding_id feeds propose_update_holding; the prompt sends updates through get_my_collection/get_card.
HOLDING_ID_TOOLS = frozenset({"get_my_collection", "get_card"})


def _number(value: float) -> float | int:
    rounded = round(value, 2)
    return int(rounded) if rounded == int(rounded) and abs(rounded) < 1e15 else rounded


def _clean(value: Any, *, tool: str, depth: int, key: str | None = None, artist: bool = False) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, str):
        if key and key.endswith("_at") and len(value) > 10 and value[4:5] == "-":
            return value[:10]  # ISO timestamp -> date
        return value
    if isinstance(value, list):
        return [_clean(item, tool=tool, depth=depth + 1, artist=artist) for item in value]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if k in DROP_KEYS and not (tool == "get_card" and depth == 0 and k == "set_code"):
                continue
            if k in ("price_source", "source") and v == DEFAULT_PRICE_SOURCE:
                continue
            if depth > 0 and k == "artist" and not artist:
                continue
            if k == "holding_id" and tool not in HOLDING_ID_TOOLS:
                continue
            if v is None and k not in KEEP_NULL_KEYS:
                continue
            if depth > 0 and v in ("", [], {}):
                continue
            if v == "" and depth == 0:
                continue
            out[k] = _clean(v, tool=tool, depth=depth + 1, key=k, artist=artist)
        return out
    return value


def _hoist(result: dict[str, Any]) -> None:
    for list_key in LIST_KEYS:
        items = result.get(list_key)
        if not isinstance(items, list) or len(items) < HOIST_MIN_ITEMS or not all(isinstance(i, dict) for i in items):
            continue
        shared = {}
        for key in HOIST_KEYS:
            values = {json.dumps(item.get(key)) for item in items}
            if len(values) == 1 and items[0].get(key) is not None:
                shared[key] = items[0][key]
        if shared:
            result[list_key] = [{k: v for k, v in item.items() if k not in shared} for item in items]
            result[f"all_{list_key}"] = shared


def _drop_echoes(result: dict[str, Any]) -> None:
    """Per-card fields that repeat the result's own top-level value."""
    echoes = {"as_of": result.get("as_of") or result.get("cards_as_of"), "window_days": result.get("cards_window_days")}
    for key in ("cards", "rising_cards", "results", "items"):
        for item in result.get(key) or []:
            if isinstance(item, dict):
                for field, parent in echoes.items():
                    if parent is not None and item.get(field) == parent:
                        item.pop(field)


def _history(result: dict[str, Any]) -> dict[str, Any]:
    points = [p for p in result.get("points") or [] if isinstance(p, dict) and isinstance(p.get("usd"), (int, float))]
    if len(points) <= MAX_HISTORY_POINTS:
        return result
    out = {key: value for key, value in result.items() if key != "points"}
    low = min(points, key=lambda p: p["usd"])
    high = max(points, key=lambda p: p["usd"])
    steps = sorted(
        (
            {"from": a.get("date"), "to": b.get("date"), "from_usd": a["usd"], "to_usd": b["usd"],
             "change_usd": _number(b["usd"] - a["usd"])}
            for a, b in zip(points, points[1:])
            if b["usd"] != a["usd"]
        ),
        key=lambda step: -abs(step["change_usd"]),
    )[:MAX_HISTORY_STEPS]
    # Evenly spaced sample, ends kept, plus the low and high days.
    stride = (len(points) - 1) / (MAX_HISTORY_POINTS - 3)
    picked = {round(i * stride) for i in range(MAX_HISTORY_POINTS - 2)} | {points.index(low), points.index(high)}
    out["points"] = [points[i] for i in sorted(picked)][:MAX_HISTORY_POINTS]
    out["point_count"] = len(points)
    out["points_note"] = "Sampled from point_count daily points; low, high and largest_steps are exact."
    out["low"] = low
    out["high"] = high
    out["largest_steps"] = steps
    return out


def _artwork(artwork: Any) -> Any:
    """Art tags without confidences/shares: just the values."""
    if not isinstance(artwork, dict):
        return artwork
    out: dict[str, Any] = {}
    for key, value in artwork.items():
        if isinstance(value, list):
            names = [
                str(item.get("value") or item.get("name") or item.get("color") or "") if isinstance(item, dict) else str(item)
                for item in value
            ]
            value = [name for name in names if name]
        if value not in (None, "", []):
            out[key] = value
    return out


def compact_result(tool: str, content: Any, arguments: Any = None) -> Any:
    if not isinstance(content, dict) or "error" in content and len(content) <= 2:
        return content
    result = dict(content)
    if tool == "get_price_history":
        result = _history(result)
    elif tool == "get_card" and "artwork" in result:
        result["artwork"] = _artwork(result["artwork"])
    elif tool == "list_facets":
        facets = result.get("facets")
        if isinstance(facets, dict):
            result["facets"] = {
                key: [item.get("value") if isinstance(item, dict) else item for item in values]
                if isinstance(values, list) else values
                for key, values in facets.items()
            }
        if isinstance(result.get("themes"), list):
            result["themes"] = [
                {k: v for k, v in theme.items() if k != "count"} if isinstance(theme, dict) else theme
                for theme in result["themes"]
            ]
    elif tool == "find_top_graded":
        if isinstance(result.get("excluded_untrusted"), list):
            # The prompt forbids quoting these prices, so the model never sees them.
            result["excluded_untrusted"] = [
                {k: v for k, v in item.items() if k not in ("listed_price_usd", "card_id")} if isinstance(item, dict) else item
                for item in result["excluded_untrusted"]
            ]
    flt = arguments.get("filter") if isinstance(arguments, dict) else None
    # Artist matters on the card page and for artist searches, nowhere else.
    artist = tool == "get_card" or (isinstance(flt, dict) and bool(flt.get("artist")))
    result = _clean(result, tool=tool, depth=0, artist=artist)
    _drop_echoes(result)
    _hoist(result)
    return result


def model_payload(tool: str, content: Any, arguments: Any = None) -> str:
    """The tool_result text the model reads."""
    return json.dumps(compact_result(tool, content, arguments), default=str, ensure_ascii=False, separators=(",", ":"))
