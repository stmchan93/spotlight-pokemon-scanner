"""MCP write tools: add_to_collection, update_holding, watch_card, move_holding,
create_collection (+ list_collections, which those need for ids).

Claude/ChatGPT have no Confirm button in Ekalight, so these execute server-side,
but only when the owner turned on "Let AI assistants edit my collection"
(user_ai_settings.allow_mcp_edits, absent row = off). Every write goes through
the same SpotlightScanService methods the app endpoints call, under the token's
identity. No delete/remove tool (owner 2026-11-21); quantity floor is 1.

Registered on the `user` tier only (policy.WRITE_TOOLS are never in the public
tier's tool list).
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Callable, Literal

import anyio
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

import user_ai_settings
from catalog_tools import utc_now
from request_auth import RequestIdentity

from mcp_server.policy import ResponsePolicy
from mcp_server.rate_limit import RateLimitExceeded, UserRateLimiter
from mcp_server.readonly_service import ReadOnlySpotlightService

logger = logging.getLogger("ekalight.mcp.write")

EDITS_OFF_MESSAGE = (
    "Turn on 'Let AI assistants edit my collection' in Ekalight → Settings → Use with AI"
)
WRITES_PER_DAY = 200
WRITES_PER_MINUTE = 30
CLAIM_STALE_SECONDS = 120

WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)

ConditionCode = Literal["NM", "LP", "MP", "HP", "DMG"]
CONDITION_TO_DECK = {
    "NM": "near_mint",
    "LP": "lightly_played",
    "MP": "moderately_played",
    "HP": "heavily_played",
    "DMG": "damaged",
}
DECK_TO_CONDITION = {value: key for key, value in CONDITION_TO_DECK.items()}


class WritableSpotlightService(ReadOnlySpotlightService):
    """Same provider lockdown as ReadOnlySpotlightService (no live pricing, no
    Scrydex refresh, no dev identity fallback); collection writes allowed.
    Only reachable from the write tools, which gate on the owner's toggle."""


class WriteToolInputError(ValueError):
    pass


def _iso_seconds_ago(seconds: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


class CollectionWriteTools:
    """Owner-scoped write logic. Callers hold `service.request_identity_context`."""

    def __init__(self, service: Any) -> None:
        self.service = service

    @property
    def conn(self) -> sqlite3.Connection:
        return self.service.connection

    def edits_allowed(self, owner_user_id: str) -> bool:
        return user_ai_settings.allow_mcp_edits(self.conn, owner_user_id)

    def _card(self, card_id: str) -> sqlite3.Row:
        row = self.conn.execute(
            "SELECT id, name, set_name, number FROM cards WHERE id = ? LIMIT 1", (card_id,)
        ).fetchone()
        if row is None:
            raise WriteToolInputError(f"No Ekalight card with id {card_id!r}. Use search_cards to find the card_id.")
        return row

    def _holding(self, owner_user_id: str, holding_id: str) -> sqlite3.Row | None:
        # By id only and owner-scoped: another account's id reads as not found.
        return self.conn.execute(
            "SELECT * FROM deck_entries WHERE id = ? AND owner_user_id = ? AND quantity > 0 LIMIT 1",
            (holding_id, owner_user_id),
        ).fetchone()

    def _holding_payload(self, owner_user_id: str, holding_id: str) -> dict[str, Any]:
        row = self._holding(owner_user_id, holding_id)
        if row is None:
            return {"holding_id": holding_id, "quantity": 0}
        card = self._card(str(row["card_id"]))
        graded = bool(row["grader"] or row["grade"])
        return {
            "holding_id": str(row["id"]),
            "card_id": str(row["card_id"]),
            "name": card["name"],
            "set": card["set_name"],
            "number": card["number"],
            "quantity": int(row["quantity"] or 0),
            "condition": None if graded else DECK_TO_CONDITION.get(str(row["condition"] or "near_mint"), "NM"),
            "variant": row["variant_name"],
            "grader": row["grader"],
            "grade": row["grade"],
            "collection_id": row["collection_id"] if "collection_id" in row.keys() else None,
        }

    # ------------------------------------------------------------------
    # Idempotency ledger (mcp_write_requests)
    # ------------------------------------------------------------------

    def _claim_request(self, owner_user_id: str, request_id: str, tool: str) -> dict[str, Any] | None:
        """None = claimed, go ahead; a dict = the stored result of an earlier call."""
        cursor = self.conn.execute(
            "INSERT OR IGNORE INTO mcp_write_requests (owner_user_id, request_id, tool, response_json, created_at) "
            "VALUES (?, ?, ?, NULL, ?)",
            (owner_user_id, request_id, tool, utc_now()),
        )
        self.conn.commit()
        if cursor.rowcount == 1:
            return None
        row = self.conn.execute(
            "SELECT tool, response_json FROM mcp_write_requests WHERE owner_user_id = ? AND request_id = ?",
            (owner_user_id, request_id),
        ).fetchone()
        if row is not None and row["response_json"] is None:
            # A claim left by a crashed call goes stale; take it over.
            taken = self.conn.execute(
                "UPDATE mcp_write_requests SET created_at = ? WHERE owner_user_id = ? AND request_id = ? "
                "AND response_json IS NULL AND created_at < ?",
                (utc_now(), owner_user_id, request_id, _iso_seconds_ago(CLAIM_STALE_SECONDS)),
            )
            self.conn.commit()
            if taken.rowcount == 1 and row["tool"] == tool:
                return None
        if row is None or row["response_json"] is None:
            raise WriteToolInputError("This request is still being processed. Wait a moment, then check the collection.")
        if row["tool"] != tool:
            raise WriteToolInputError("request_id was already used for a different action. Use a new request_id.")
        stored = json.loads(row["response_json"])
        return {**stored, "already_done": True}

    def _finish_request(self, owner_user_id: str, request_id: str, result: dict[str, Any] | None) -> None:
        if result is None:
            self.conn.execute(
                "DELETE FROM mcp_write_requests WHERE owner_user_id = ? AND request_id = ? AND response_json IS NULL",
                (owner_user_id, request_id),
            )
        else:
            self.conn.execute(
                "UPDATE mcp_write_requests SET response_json = ? WHERE owner_user_id = ? AND request_id = ?",
                (json.dumps(result), owner_user_id, request_id),
            )
        self.conn.commit()

    # ------------------------------------------------------------------
    # Tools
    # ------------------------------------------------------------------

    def add_to_collection(
        self,
        owner_user_id: str,
        *,
        card_id: str,
        request_id: str,
        quantity: int = 1,
        condition: str | None = "NM",
        variant_name: str | None = None,
        grader: str | None = None,
        grade: str | None = None,
        collection_id: str | None = None,
    ) -> dict[str, Any]:
        card_id = str(card_id or "").strip()
        request_id = str(request_id or "").strip()
        if not request_id:
            raise WriteToolInputError("request_id is required.")
        if quantity < 1:
            raise WriteToolInputError("quantity must be at least 1.")
        grader = str(grader or "").strip() or None
        grade = str(grade or "").strip() or None
        if bool(grader) != bool(grade):
            raise WriteToolInputError("A graded card needs both grader and grade.")
        self._card(card_id)
        collection_id = str(collection_id or "").strip() or None
        if collection_id is not None:
            owned = self.conn.execute(
                "SELECT 1 FROM collections WHERE id = ? AND owner_user_id = ? LIMIT 1",
                (collection_id, owner_user_id),
            ).fetchone()
            if owned is None:
                raise WriteToolInputError("Collection not found.")

        stored = self._claim_request(owner_user_id, request_id, "add_to_collection")
        if stored is not None:
            return stored
        payload: dict[str, Any] = {
            "cardID": card_id,
            "quantity": quantity,
            "selectionSource": "assistant",
            "collectionID": collection_id,
        }
        if grader:
            # Slabs carry no condition.
            payload["slabContext"] = {"grader": grader, "grade": grade, "variantName": variant_name}
        else:
            payload["condition"] = CONDITION_TO_DECK[str(condition or "NM").upper()]
            payload["variantName"] = variant_name
        try:
            created = self.service.create_deck_entry(payload)
        except BaseException:
            self._finish_request(owner_user_id, request_id, None)
            raise
        result = {"added_quantity": quantity, **self._holding_payload(owner_user_id, str(created["deckEntryID"]))}
        self._finish_request(owner_user_id, request_id, result)
        return result

    def update_holding(
        self,
        owner_user_id: str,
        *,
        holding_id: str,
        quantity: int | None = None,
        condition: str | None = None,
    ) -> dict[str, Any]:
        holding_id = str(holding_id or "").strip()
        if quantity is None and condition is None:
            raise WriteToolInputError("Give a new quantity, a new condition, or both.")
        if quantity is not None and quantity < 1:
            raise WriteToolInputError("quantity must be at least 1. Removing cards isn't available here.")
        row = self._holding(owner_user_id, holding_id)
        if row is None:
            raise WriteToolInputError("Holding not found. Use get_my_collection to find the holding_id.")

        if condition is None:
            result = self.service.set_deck_entry_quantity({"deckEntryID": holding_id, "quantity": quantity})
            return self._holding_payload(owner_user_id, str(result["deckEntryID"]))

        if row["grader"] or row["grade"] or row["cert_number"]:
            raise WriteToolInputError("Graded cards have no condition; only quantity can change.")
        # Same call the app's edit sheet makes: replace with the stored identity
        # and cost basis, new condition.
        existing_quantity = int(row["quantity"] or 0)
        next_quantity = quantity if quantity is not None else existing_quantity
        cents = row["cost_basis_cents"] if "cost_basis_cents" in row.keys() else None
        if cents is not None:
            unit_price = int(cents) / 100.0
        elif existing_quantity > 0:
            unit_price = float(row["cost_basis_total"] or 0) / existing_quantity
        else:
            unit_price = 0.0
        next_condition = CONDITION_TO_DECK[str(condition).upper()]
        merge_target = self.service._resolve_owned_deck_entry_id(
            card_id=str(row["card_id"]), variant_name=row["variant_name"], condition=next_condition
        )
        result = self.service.replace_deck_entry(
            {
                "deckEntryID": holding_id,
                "cardID": str(row["card_id"]),
                "slabContext": None,
                "variantName": row["variant_name"],
                "condition": next_condition,
                "quantity": next_quantity,
                "unitPrice": round(unit_price, 2),
                "currencyCode": str(row["cost_basis_currency_code"] or "USD"),
                "updatedAt": utc_now(),
            }
        )
        next_id = str(result["deckEntryID"])
        # Keep the per-unit cents exact, unless the edit merged into another
        # holding that has its own cost basis.
        if cents is not None and merge_target in (None, holding_id):
            self.service.update_deck_entry_cost_basis({"deckEntryID": next_id, "costBasisPerUnitCents": int(cents)})
        return {"previous_holding_id": holding_id, **self._holding_payload(owner_user_id, next_id)}

    def list_collections(self, owner_user_id: str) -> dict[str, Any]:
        rows = self.conn.execute(
            """
            SELECT c.id, c.name, c.hidden,
                   (SELECT COALESCE(SUM(d.quantity), 0) FROM deck_entries d
                    WHERE d.owner_user_id = c.owner_user_id AND d.collection_id = c.id AND d.quantity > 0) AS cards
            FROM collections c WHERE c.owner_user_id = ? ORDER BY c.sort_order, c.created_at, c.id
            """,
            (owner_user_id,),
        ).fetchall()
        return {
            "collections": [
                {"collection_id": str(row["id"]), "name": row["name"], "card_count": int(row["cards"] or 0),
                 "hidden": bool(row["hidden"])}
                for row in rows
            ]
        }

    def move_holding(
        self, owner_user_id: str, *, holding_id: str, collection_id: str, quantity: int | None = None
    ) -> dict[str, Any]:
        holding_id = str(holding_id or "").strip()
        if self._holding(owner_user_id, holding_id) is None:
            raise WriteToolInputError("Holding not found. Use get_my_collection to find the holding_id.")
        result = self.service.move_deck_entry(
            {"deckEntryID": holding_id, "collectionID": str(collection_id or "").strip(), "quantity": quantity}
        )
        return {"moved_quantity": result["movedQuantity"], **self._holding_payload(owner_user_id, result["deckEntryID"])}

    def create_collection(self, owner_user_id: str, *, name: str, request_id: str) -> dict[str, Any]:
        name = " ".join(str(name or "").split())
        request_id = str(request_id or "").strip()
        if not name:
            raise WriteToolInputError("name is required.")
        if not request_id:
            raise WriteToolInputError("request_id is required.")
        stored = self._claim_request(owner_user_id, request_id, "create_collection")
        if stored is not None:
            return stored
        try:
            created = self.service.create_collection({"name": name})["collection"]
        except BaseException:
            self._finish_request(owner_user_id, request_id, None)
            raise
        result = {"collection_id": created["id"], "name": created["name"]}
        self._finish_request(owner_user_id, request_id, result)
        return result

    def watch_card(
        self,
        owner_user_id: str,
        *,
        card_id: str,
        variant: str | None = None,
        target_price_usd: float | None = None,
    ) -> dict[str, Any]:
        card_id = str(card_id or "").strip()
        card = self._card(card_id)
        if target_price_usd is not None and target_price_usd <= 0:
            raise WriteToolInputError("target_price_usd must be greater than 0.")
        favorite = self.service.set_card_favorite(card_id, is_favorite=True, variant=variant)
        target_cents = None
        if target_price_usd is not None:
            target_cents = int(round(float(target_price_usd) * 100))
            self.service.set_card_favorite_target(card_id, target_price_cents=target_cents, variant=variant)
        return {
            "card_id": card_id,
            "name": card["name"],
            "set": card["set_name"],
            "number": card["number"],
            "watching": True,
            "variant": variant,
            "target_price_usd": None if target_cents is None else target_cents / 100.0,
            "watched_at": favorite.get("favoritedAt"),
        }


class WriteToolRunner:
    """Identity + edit toggle + write rate limit + thread offload."""

    def __init__(
        self,
        tools: CollectionWriteTools,
        identity: Callable[[], RequestIdentity],
        *,
        policy: ResponsePolicy,
        limiter: UserRateLimiter | None = None,
    ) -> None:
        self.tools = tools
        self.identity = identity
        self.policy = policy
        self.limiter = limiter or UserRateLimiter(per_minute=WRITES_PER_MINUTE, per_day=WRITES_PER_DAY)

    async def run(self, method: str, **kwargs: Any) -> dict[str, Any]:
        if not self.policy.allows_tool(method) or not self.policy.account_data:
            raise ToolError(f"{method} is not available on this plan.")
        identity = self.identity()
        service = self.tools.service

        def allowed() -> bool:
            with service.request_identity_context(identity):
                return self.tools.edits_allowed(identity.user_id)

        # Checked before the limiter: a refused write never spends quota.
        if not await anyio.to_thread.run_sync(allowed):
            raise ToolError(EDITS_OFF_MESSAGE)
        try:
            self.limiter.check(identity.user_id)
        except RateLimitExceeded as error:
            raise ToolError(str(error).replace("tool calls", "edits")) from None

        def work() -> dict[str, Any]:
            with service.request_identity_context(identity):
                return getattr(self.tools, method)(identity.user_id, **kwargs)

        try:
            return await anyio.to_thread.run_sync(work)
        except WriteToolInputError as error:
            raise ToolError(str(error)) from None
        except FileNotFoundError:
            raise ToolError("Not found in this Ekalight account.") from None
        except ValueError as error:
            # Service validation messages (bad variant, bad condition) are user-safe.
            raise ToolError(str(error)) from None
        except ToolError:
            raise
        except Exception:  # noqa: BLE001 - never leak internals to the model
            logger.exception("MCP write tool %s failed", method)
            raise ToolError("Ekalight could not save this change. Try again shortly.") from None


RequestId = Annotated[
    str,
    Field(
        min_length=8,
        max_length=100,
        description="A unique id you generate for this one add (e.g. a UUID). Reuse it only to retry the same add.",
    ),
]


def register_write_tools(
    server: MCPServer,
    policy: ResponsePolicy,
    service: Any,
    identity: Callable[[], RequestIdentity],
    *,
    limiter: UserRateLimiter | None = None,
) -> WriteToolRunner | None:
    """Register the write tools when the tier allows them (user tier only)."""
    from mcp_server.policy import WRITE_TOOLS

    if not policy.account_data or not any(policy.allows_tool(name) for name in WRITE_TOOLS):
        return None
    runner = WriteToolRunner(CollectionWriteTools(service), identity, policy=policy, limiter=limiter)

    @server.tool(
        description=(
            "Add a card to the user's Ekalight collection. Ask the user before calling. Raw cards take a "
            "condition (default NM); graded slabs take grader + grade and no condition. Adding a card the "
            "user already holds in the same condition/variant increases that holding's quantity. Works only "
            "if the user turned on 'Let AI assistants edit my collection' in the Ekalight app."
        ),
        annotations=WRITE,
    )
    async def add_to_collection(
        card_id: str,
        request_id: RequestId,
        quantity: Annotated[int, Field(ge=1, le=999)] = 1,
        condition: ConditionCode = "NM",
        variant_name: Annotated[str, Field(max_length=80)] | None = None,
        grader: Literal["PSA", "CGC", "SGC", "BGS", "TAG", "ACE", "AGS", "CCIC"] | None = None,
        grade: Annotated[str, Field(max_length=20)] | None = None,
        collection_id: str | None = None,
    ) -> dict[str, Any]:
        return await runner.run(
            "add_to_collection",
            card_id=card_id,
            request_id=request_id,
            quantity=quantity,
            condition=condition,
            variant_name=variant_name,
            grader=grader,
            grade=grade,
            collection_id=collection_id,
        )

    @server.tool(
        description=(
            "Change the quantity (1 or more) and/or the condition of one of the user's holdings, by the "
            "holding_id from get_my_collection or get_card's my_holdings. Ask the user before calling. "
            "Cards can't be removed with this tool. Works only if the user turned on 'Let AI assistants "
            "edit my collection' in the Ekalight app."
        ),
        annotations=WRITE,
    )
    async def update_holding(
        holding_id: str,
        quantity: Annotated[int, Field(ge=1, le=999)] | None = None,
        condition: ConditionCode | None = None,
    ) -> dict[str, Any]:
        return await runner.run("update_holding", holding_id=holding_id, quantity=quantity, condition=condition)

    @server.tool(
        description=(
            "Add a card to the user's Watchlist, optionally with a USD target price: Ekalight sends a push "
            "alert when the market price drops to the target. Ask the user before calling. Works only if "
            "the user turned on 'Let AI assistants edit my collection' in the Ekalight app."
        ),
        annotations=WRITE,
    )
    async def watch_card(
        card_id: str,
        variant: Annotated[str, Field(max_length=80)] | None = None,
        target_price_usd: Annotated[float, Field(gt=0, le=1_000_000)] | None = None,
    ) -> dict[str, Any]:
        return await runner.run("watch_card", card_id=card_id, variant=variant, target_price_usd=target_price_usd)

    @server.tool(
        description=(
            "List the user's named collections (collection_id, name, card_count, hidden = left out of totals). "
            "Use it to find the collection_id for move_holding or add_to_collection. Works only if the user turned "
            "on 'Let AI assistants edit my collection' in the Ekalight app."
        ),
        annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False),
    )
    async def list_collections() -> dict[str, Any]:
        return await runner.run("list_collections")

    @server.tool(
        description=(
            "Move one of the user's holdings (holding_id) into another of their collections (collection_id from "
            "list_collections). quantity = copies to move; omit to move all. Ask the user before calling. Cards "
            "can't be removed with these tools. Works only if the user turned on 'Let AI assistants edit my "
            "collection' in the Ekalight app."
        ),
        annotations=WRITE,
    )
    async def move_holding(
        holding_id: str,
        collection_id: str,
        quantity: Annotated[int, Field(ge=1, le=999)] | None = None,
    ) -> dict[str, Any]:
        return await runner.run("move_holding", holding_id=holding_id, collection_id=collection_id, quantity=quantity)

    @server.tool(
        description=(
            "Create a new, empty named collection for the user; returns its collection_id. Ask the user before "
            "calling. Works only if the user turned on 'Let AI assistants edit my collection' in the Ekalight app."
        ),
        annotations=WRITE,
    )
    async def create_collection(
        name: Annotated[str, Field(min_length=1, max_length=60)],
        request_id: RequestId,
    ) -> dict[str, Any]:
        return await runner.run("create_collection", name=name, request_id=request_id)

    return runner
