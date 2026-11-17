"""Tools the assistant model sees: the 8 CollectionTools reads (owner = the
request user, DB-only) plus 3 propose_* tools that validate and return a
ProposedAction without changing anything.

Strict mode: the API caps strict schemas at 24 optional parameters per request,
and the three filter tools alone carry ~60 (CardFilter x 3), so those three are
sent non-strict and validated server-side by normalize_card_filter; every other
tool (incl. all propose_* writes) is strict.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from catalog_tools import card_by_id

from mcp_server.filters import ToolInputError
from mcp_server.policy import USER_POLICY
from mcp_server.assistant.store import new_id
from mcp_server.tools import DECK_CONDITION_CODES, WATCHLIST_DESCRIPTION, CollectionTools
from request_auth import RequestIdentity

logger = logging.getLogger("ekalight.assistant")

CONDITIONS = ("NM", "LP", "MP", "HP", "DMG")
MAX_CARDS = 12
MAX_QUANTITY = 999
# Fields the model never needs (tiles carry them); dropping them saves tokens.
MODEL_HIDDEN_KEYS = frozenset({"image_small_url", "app_url", "tcgplayer_id", "buy_links"})
# Per-call ceilings for the model (the MCP tools allow more).
MODEL_LIMITS = {"search_cards": 20, "find_missing": 20, "get_my_collection": 50, "get_my_watchlist": 50}

_FILTER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": "All fields optional; combined with AND. Give at least one of text/set/artist/rarity_bucket or an art filter.",
    "properties": {
        "text": {"type": "string", "description": "Card name search (case-insensitive), optionally with set or number, e.g. 'charizard ex'."},
        "set": {"type": "string", "description": "Set name or code, e.g. 'Evolving Skies'."},
        "artist": {"type": "string", "description": "Illustrator name."},
        "language": {"type": "string", "enum": ["English", "Japanese", "any"]},
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
            "not own. Prices are USD from Ekalight's stored daily market data."
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
            "Cards matching the filter that the user does not own, cheapest first. Use for 'what am I missing', "
            "set/theme completion, and shopping lists. If total_is_lower_bound is true, counts are minimums: "
            "say 'at least N'. cheapest_completion_usd is null when not every missing card was priced; then "
            "don't state a completion cost."
        ),
        "input_schema": _obj(
            {
                "filter": _FILTER_SCHEMA,
                "collection_id": {"type": "string"},
                "budget_usd": {"type": "number"},
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
            "One card: details, USD price, art tags, similar card ids, its other-language counterpart, and the "
            "user's own copies (my_holdings, each with holding_id and printing)."
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
            "grade are both given (e.g. PSA 10). days_since_as_of says how old the newest point is."
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
)


@dataclass
class ToolOutcome:
    content: Any  # JSON-able result for the model
    is_error: bool = False
    cards: list[dict[str, Any]] = field(default_factory=list)
    action: dict[str, Any] | None = None


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


def _optional_str(value: Any, *, limit: int = 80) -> str | None:
    text = str(value or "").strip()
    return text[:limit] if text else None


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

    def run(self, name: str, arguments: dict[str, Any], *, owner_user_id: str) -> ToolOutcome:
        identity = RequestIdentity(user_id=owner_user_id, auth_source="assistant")
        try:
            with self.tools.service.request_identity_context(identity):
                if name in READ_TOOLS:
                    return self._read(name, dict(arguments or {}), owner_user_id)
                if name == "propose_add_to_collection":
                    return self._propose_add(dict(arguments or {}), owner_user_id)
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
        if name in ("search_cards", "get_my_collection", "find_missing"):
            kwargs["card_filter"] = args.get("filter")
        if name in MODEL_LIMITS:
            default = 25 if name in ("get_my_collection", "get_my_watchlist") else 10
            try:
                limit = int(args.get("limit") or default)
            except (TypeError, ValueError):
                limit = default
            kwargs["limit"] = max(1, min(limit, MODEL_LIMITS[name]))
        for key in ("owned", "sort", "cursor", "collection_id", "budget_usd", "card_id", "condition",
                    "grader", "grade", "variant"):
            if args.get(key) is not None:
                kwargs[key] = args[key]
        if "range" in args and args["range"] is not None:
            kwargs["range_key"] = args["range"]
        if name == "get_card":
            kwargs["include_holdings"] = True
        try:
            self.policy.check_inputs(kwargs.get("card_filter"), sort=kwargs.get("sort"), owned=kwargs.get("owned"))
        except ValueError as error:
            raise ToolInputError(str(error)) from None
        result = self.policy.shape(getattr(self.tools, name)(owner_user_id, **kwargs))
        return ToolOutcome(strip_for_model(result), cards=card_refs(result))

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
        """Dedupe (card + slab), cap at MAX_CARDS, fill image/price from the DB
        for refs that came from slim payloads (e.g. portfolio movers)."""
        seen: set[tuple[str, str, str]] = set()
        out: list[dict[str, Any]] = []
        for ref in refs:
            key = (ref["card_id"], str(ref.get("grader") or ""), str(ref.get("grade") or ""))
            if key in seen:
                continue
            seen.add(key)
            out.append(dict(ref))
            if len(out) >= MAX_CARDS:
                break
        missing = [ref["card_id"] for ref in out if not ref.get("image_small_url") or not ref.get("app_url")]
        if missing:
            summaries = self.tools._summaries(missing)
            for ref in out:
                summary = summaries.get(ref["card_id"])
                if summary is None:
                    continue
                for key in ("image_small_url", "app_url", "set", "number", "language"):
                    if not ref.get(key):
                        ref[key] = summary.get(key)
                if ref.get("price_usd") is None and not (ref.get("grader") or ref.get("grade")):
                    ref["price_usd"] = summary.get("price_usd")
        return out

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
