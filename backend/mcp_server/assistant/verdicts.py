"""Server-side math for "is this a good deal?" (check_deal) and the trade checker
(compare_trade). The model only explains the numbers these return; it never
does the arithmetic. DB-only reads (0 Scrydex credits): stored daily prices,
stored graded cells and the cached eBay sold comps.

Each tool also returns a `verdict` payload for the chat's verdict/trade card
(wire contract: docs/assistant-marketable-features-plan-2026-11-21.md).
"""

from __future__ import annotations

import re
from typing import Any

from catalog_tools import GAMES, card_by_id

from mcp_server.filters import ToolInputError
from mcp_server.tools import (
    GAME,
    PRICE_STALE_DAYS,
    CollectionTools,
    distrust_japanese_anchor,
    is_japanese_card,
)

# Every band lives here (plan doc §5 Decisions 2 and 3, 2026-11-21; owner can change).
# Buying: asking as % of TCGplayer market.
DEAL_GOOD_BUY_MAX_PCT = 90.0
DEAL_FAIR_MAX_PCT = 105.0
# Selling to a vendor: their offer as % of market.
SELL_STRONG_MIN_PCT = 80.0
SELL_TYPICAL_MIN_PCT = 65.0
# Trade: gap as % of the bigger side.
TRADE_FAIR_MAX_GAP_PCT = 5.0
TRADE_SLIGHT_MAX_GAP_PCT = 15.0
# Balancing card from the user's collection: within this % of the gap.
TRADE_BALANCE_CARD_SLACK_PCT = 15.0
MAX_DEAL_ITEMS = 20
MAX_TRADE_ITEMS_PER_SIDE = 12
MAX_ITEM_QUANTITY = 999
MAX_ASKING_USD = 10_000_000
MAX_CANDIDATES = 3
CONDITIONS = ("NM", "LP", "MP", "HP", "DMG")

DEAL_LABELS = {
    "good_buy": "Good buy", "fair": "Fair price", "above_market": "Above market",
    "strong_offer": "Strong offer", "typical_offer": "Typical offer", "low_offer": "Low offer", "unknown": "No price",
}
TRADE_LABELS = {"fair": "Fair trade", "slightly_uneven": "Slightly uneven", "uneven": "Uneven", "unknown": "Can't total"}
SIDES = ("buying", "selling")

_SET_NUMBER = re.compile(r"#?\d+[a-z]?(?:/\d+)?", re.IGNORECASE)


def deal_verdict(pct_of_market: float | None, side: str = "buying") -> str:
    if pct_of_market is None:
        return "unknown"
    if side == "selling":
        if pct_of_market >= SELL_STRONG_MIN_PCT:
            return "strong_offer"
        return "typical_offer" if pct_of_market >= SELL_TYPICAL_MIN_PCT else "low_offer"
    if pct_of_market <= DEAL_GOOD_BUY_MAX_PCT:
        return "good_buy"
    return "fair" if pct_of_market <= DEAL_FAIR_MAX_PCT else "above_market"


TRADE_BANDS = {"fair_max_pct": TRADE_FAIR_MAX_GAP_PCT, "slightly_uneven_max_pct": TRADE_SLIGHT_MAX_GAP_PCT}


def deal_bands(side: str) -> dict[str, float]:
    if side == "selling":
        return {"strong_min_pct": SELL_STRONG_MIN_PCT, "typical_min_pct": SELL_TYPICAL_MIN_PCT}
    return {"good_buy_max_pct": DEAL_GOOD_BUY_MAX_PCT, "fair_max_pct": DEAL_FAIR_MAX_PCT}


def trade_gap(give_usd: float, get_usd: float) -> tuple[float, float]:
    """(gap_usd = get - give, gap_pct of the bigger side)."""
    gap = round(get_usd - give_usd, 2)
    bigger = max(give_usd, get_usd)
    return gap, round(abs(gap) / bigger * 100, 1) if bigger > 0 else 0.0


def trade_verdict(give_usd: float, get_usd: float) -> str:
    pct = trade_gap(give_usd, get_usd)[1]
    if pct <= TRADE_FAIR_MAX_GAP_PCT:
        return "fair"
    return "slightly_uneven" if pct <= TRADE_SLIGHT_MAX_GAP_PCT else "uneven"


def _money(value: float | None) -> float | None:
    return None if value is None else round(float(value), 2)


def _clean_text(value: Any, limit: int = 120) -> str | None:
    text = " ".join(str(value or "").split())
    return text[:limit] if text and text.casefold() not in ("null", "none") else None


class VerdictTools:
    """check_deal / compare_trade over CollectionTools (owner = the request user)."""

    def __init__(self, tools: CollectionTools) -> None:
        self.tools = tools

    @property
    def conn(self):
        return self.tools.conn

    # --- input -------------------------------------------------------------------

    def _item_input(self, raw: Any, *, with_asking: bool) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise ToolInputError("Each card is an object with card_id or name.")
        card_id = _clean_text(raw.get("card_id"), 200)
        name = _clean_text(raw.get("name"))
        if not card_id and not name:
            raise ToolInputError("Each card needs a card_id (scanned or from search) or a name.")
        quantity = raw.get("quantity")
        if quantity is None:
            quantity = 1
        if isinstance(quantity, bool) or not isinstance(quantity, (int, float)) or int(quantity) != quantity:
            raise ToolInputError("quantity must be a whole number.")
        quantity = int(quantity)
        if not 1 <= quantity <= MAX_ITEM_QUANTITY:
            raise ToolInputError(f"quantity must be 1-{MAX_ITEM_QUANTITY}.")
        grader = (_clean_text(raw.get("grader"), 12) or "").upper() or None
        grade = _clean_text(raw.get("grade"), 12)
        if bool(grader) != bool(grade):
            raise ToolInputError("A slab needs both grader and grade, e.g. grader='PSA', grade='10'.")
        condition = (_clean_text(raw.get("condition"), 8) or "").upper() or None
        if condition and condition not in CONDITIONS:
            raise ToolInputError(f"condition must be one of {', '.join(CONDITIONS)}.")
        item = {
            "card_id": card_id,
            "query": name,
            "quantity": quantity,
            "grader": grader,
            "grade": self.tools._history_grade_key(grade) if grade else None,
            "condition": None if grader else (condition or "NM"),
            "condition_assumed": not grader and condition is None,
            "variant": _clean_text(raw.get("variant"), 80),
        }
        if with_asking:
            item["asking_price_usd"] = _asking(raw.get("asking_price_usd"), "asking_price_usd")
        return item

    # --- resolution --------------------------------------------------------------

    def _resolve(self, owner_user_id: str, item: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        """(catalog card, None) or (None, problem) where problem is not_found / ambiguous."""
        if item["card_id"]:
            card = card_by_id(self.conn, item["card_id"])
            if card is None and "~" not in item["card_id"]:
                # The model sometimes drops the game prefix ('FBL-242' for 'lorcana~FBL-242').
                row = self.conn.execute(
                    "SELECT id FROM cards WHERE id LIKE ? LIMIT 2", (f"%~{item['card_id']}",)
                ).fetchall()
                card = card_by_id(self.conn, str(row[0][0])) if len(row) == 1 else None
            if card is not None:
                return card, None
            if not item["query"]:
                return None, {"query": item["card_id"], "problem": "not_found"}
        from mcp_server.assistant.tools import owned_printing_hint  # circular at import time

        query = item["query"] or ""
        result = self.tools.search_cards(
            owner_user_id, card_filter={"text": query, "product": "single"}, limit=10
        )
        results = [r for r in result.get("results") or [] if isinstance(r, dict) and r.get("card_id")]
        if not results:
            return None, {"query": query, "problem": "not_found"}
        owned = owned_printing_hint(self.conn, owner_user_id, result, {"text": query}, query)
        if owned.get("resolved_owned_card_id"):
            return card_by_id(self.conn, owned["resolved_owned_card_id"]), None
        exact = [r for r in results if str(r.get("name") or "").casefold() == query.casefold()]
        pool = exact or results
        if _SET_NUMBER.search(query):
            # "Kyogre-EX 104/108", "charizard ex 151 199": the number pins the printing.
            pool = [r for r in pool if _numbered(r, query)] or pool
        printings: dict[tuple[str, str], dict[str, Any]] = {}
        for r in pool:
            printings.setdefault((str(r.get("set") or ""), str(r.get("number") or "")), r)
        if len(printings) == 1:
            return card_by_id(self.conn, str(next(iter(printings.values()))["card_id"])), None
        candidates = list(printings.values())[:MAX_CANDIDATES]
        options = [f"{c.get('set') or '?'} #{c.get('number') or '?'}" for c in candidates]
        label = str(candidates[0].get("name") or query)
        return None, {
            "query": query,
            "problem": "ambiguous",
            "ask_which": f"Which {label} do you mean: {', '.join(options[:-1])} or {options[-1]}?"
            if len(options) > 1 else f"Which {label} do you mean?",
            "candidates": [
                {"card_id": c["card_id"], "name": c.get("name"), "set": c.get("set"), "number": c.get("number"),
                 "price_usd": c.get("price_usd"), "image_small_url": c.get("image_small_url")}
                for c in candidates
            ],
        }

    # --- pricing -----------------------------------------------------------------

    def _price(self, card: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
        """Unit market price for the item's printing/condition or slab, with its age,
        30-day move and cached solds (slabs). price_usd null = no current USD price."""
        tools = self.tools
        card_id = card["id"]
        summary = distrust_japanese_anchor(dict(tools._summaries([card_id], cards={card_id: card})[card_id]))
        out: dict[str, Any] = {
            "card_id": card_id,
            "name": summary.get("name"),
            "set": summary.get("set"),
            "number": summary.get("number"),
            "language": summary.get("language"),
            "image_small_url": summary.get("image_small_url"),
            "app_url": summary.get("app_url"),
            "quantity": item["quantity"],
            "condition": item["condition"],
            "condition_assumed": item["condition_assumed"],
            "grader": item["grader"],
            "grade": item["grade"],
            "variant": item["variant"],
            "price_usd": None,
            "price_as_of": None,
            "change_30d_pct": None,
            "solds": None,
            "price_note": None,
        }
        game = str(card.get("game") or GAME)
        history: dict[str, Any] = {}
        try:
            history, _ = tools._price_history(
                card_id, range_key="30d", condition=item["condition"] or "NM", grader=item["grader"],
                grade=item["grade"], variant=item["variant"],
            )
        except ToolInputError:
            history = {}
        if history.get("variant"):
            out["variant"] = history["variant"]
        if history.get("variant_note"):
            out["price_note"] = f"No {item['variant']} price; used the main printing ({history.get('variant')})."
        first, last = history.get("first_usd"), history.get("last_usd")
        if history.get("covers_full_range") and isinstance(first, (int, float)) and first > 0 and isinstance(last, (int, float)):
            out["change_30d_pct"] = round((last - first) / first * 100, 1)

        if item["grader"]:
            if not GAMES[game].has_graded_pricing:
                out["price_note"] = "No graded prices for this game."
                return out
            peers = tools._graded_peer_entries(game, [card_id], from_cells=True).get(card_id, [])
            comp = tools._graded_comp(card, item["grader"], item["grade"], peers, summary.get("price_usd"))
            out["solds"] = tools.cached_sold_summary(card, item["grader"], item["grade"])
            if comp is None:
                out["price_note"] = f"No current {item['grader']} {item['grade']} price."
                return out
            out.update({"price_usd": comp["price"], "price_as_of": comp["as_of"],
                        "price_source": "sold" if comp["source"] == "ebay_sold" else "market"})
            return out

        if item["condition"] == "NM" and not item["variant"]:
            # The same headline price the app (and the card tile) shows.
            out["price_usd"] = summary.get("price_usd")
            out["price_as_of"] = history.get("as_of")
            if summary.get("price_stale") or summary.get("price_untrusted"):
                out["price_note"] = "No current trustworthy price."
            if out["variant"] is None:
                out["variant"] = history.get("variant")
            return out
        stale = history.get("days_since_as_of")
        japanese_untrusted = is_japanese_card(card_id, card.get("language")) and history.get("source") != "tcgplayer"
        if isinstance(last, (int, float)) and last > 0 and isinstance(stale, int) and stale <= PRICE_STALE_DAYS \
                and not japanese_untrusted:
            out["price_usd"] = round(float(last), 2)
            out["price_as_of"] = history.get("as_of")
        else:
            out["price_note"] = f"No current {item['condition']} price for this printing."
        return out

    def _priced_items(
        self, owner_user_id: str, raw_items: list[Any], *, with_asking: bool, limit: int
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        """(priced items incl. unpriced ones, problems, tile refs)."""
        if len(raw_items) > limit:
            raise ToolInputError(f"At most {limit} cards per call.")
        items, problems, refs = [], [], []
        for raw in raw_items:
            item = self._item_input(raw, with_asking=with_asking)
            card, problem = self._resolve(owner_user_id, item)
            if problem is not None:
                problems.append(problem)
                continue
            assert card is not None
            priced = self._price(card, item)
            if with_asking:
                priced["asking_price_usd"] = item["asking_price_usd"]
            priced["market_total_usd"] = (
                _money(priced["price_usd"] * item["quantity"]) if priced["price_usd"] is not None else None
            )
            items.append(priced)
            refs.append(_ref(priced))
        return items, problems, refs

    # --- check_deal --------------------------------------------------------------

    def check_deal(
        self, owner_user_id: str, *, cards: list[Any] | None, asking_total_usd: Any = None,
        side: str | None = None, context_card_ids: list[str] | tuple[str, ...] = (),
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        side = side if side in SIDES else "buying"
        raw_items = list(cards or [])
        if not raw_items and context_card_ids:
            raw_items = [{"card_id": card_id} for card_id in context_card_ids]
        if not raw_items:
            raise ToolInputError("Give the card(s): the scanned card ids, or a card_id/name per card.")
        total_ask = _asking(asking_total_usd, "asking_total_usd")
        items, problems, refs = self._priced_items(owner_user_id, raw_items, with_asking=True, limit=MAX_DEAL_ITEMS)
        per_item = [item.get("asking_price_usd") for item in items]
        if total_ask is None and items and all(value is not None for value in per_item):
            total_ask = _money(sum(float(value) * item["quantity"] for value, item in zip(per_item, items)))
        if total_ask is None:
            raise ToolInputError("Give the asking price: asking_total_usd for the lot, or asking_price_usd per card.")

        market_total = sum(item["market_total_usd"] or 0.0 for item in items)
        unpriced = [item for item in items if item["price_usd"] is None]
        complete = bool(items) and not unpriced and not problems
        pct = round(total_ask / market_total * 100, 1) if complete and market_total > 0 else None
        verdict = deal_verdict(pct, side)
        for item in items:
            # Per card: its own asking price, else the lot total split by market value.
            if item.get("asking_price_usd") is not None:
                item["asking_usd"] = _money(float(item["asking_price_usd"]) * item["quantity"])
            elif complete and market_total > 0:
                item["asking_usd"] = _money(total_ask * (item["market_total_usd"] or 0.0) / market_total)
            else:
                item["asking_usd"] = None
            item["pct_of_market"] = (
                round(item["asking_usd"] / item["market_total_usd"] * 100, 1)
                if item["asking_usd"] is not None and item["market_total_usd"] else None
            )
            item.pop("asking_price_usd", None)
        result: dict[str, Any] = {
            "verdict": verdict,
            "verdict_label": DEAL_LABELS[verdict],
            "asking_usd": total_ask,
            "market_usd": _money(market_total) if complete else None,
            "pct_of_market": pct,
            "diff_usd": _money(total_ask - market_total) if complete else None,
            "side": side,
            "good_buy_up_to_usd": _money(market_total * DEAL_GOOD_BUY_MAX_PCT / 100)
            if complete and side == "buying" else None,
            "fair_up_to_usd": _money(market_total * DEAL_FAIR_MAX_PCT / 100) if complete and side == "buying" else None,
            "strong_offer_from_usd": _money(market_total * SELL_STRONG_MIN_PCT / 100)
            if complete and side == "selling" else None,
            "bands": deal_bands(side),
            "card_count": sum(item["quantity"] for item in items),
            "items": items,
        }
        if unpriced:
            result["unpriced"] = [item["name"] for item in unpriced]
            result["note"] = (
                f"{len(unpriced)} card(s) have no current USD price: verdict unknown. Say there's no price for "
                "them; never estimate one."
            )
        _add_problems(result, problems)
        return result, refs

    # --- compare_trade -----------------------------------------------------------

    def compare_trade(
        self, owner_user_id: str, *, side_a: list[Any] | None, side_b: list[Any] | None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        if not side_a or not side_b:
            raise ToolInputError("Both sides need at least one card: side_a = what the user gives, side_b = what they get.")
        give, give_problems, give_refs = self._priced_items(
            owner_user_id, list(side_a), with_asking=False, limit=MAX_TRADE_ITEMS_PER_SIDE
        )
        get, get_problems, get_refs = self._priced_items(
            owner_user_id, list(side_b), with_asking=False, limit=MAX_TRADE_ITEMS_PER_SIDE
        )
        sides = {"side_a": _side("You give", give, give_problems), "side_b": _side("You get", get, get_problems)}
        complete = all(side["complete"] for side in sides.values())
        result: dict[str, Any] = {**sides}
        if complete:
            give_total, get_total = sides["side_a"]["total_usd"], sides["side_b"]["total_usd"]
            gap, gap_pct = trade_gap(give_total, get_total)
            verdict = trade_verdict(give_total, get_total)
            favors = None if gap == 0 else ("you" if gap > 0 else "them")
            result.update({
                "verdict": verdict,
                "verdict_label": TRADE_LABELS[verdict],
                "gap_usd": abs(gap),
                "gap_pct": gap_pct,
                "favors": favors,
                "bands": TRADE_BANDS,
                "balance": self._balance(owner_user_id, abs(gap), favors, verdict, give + get),
            })
        else:
            result.update({
                "verdict": "unknown",
                "verdict_label": TRADE_LABELS["unknown"],
                "gap_usd": None,
                "gap_pct": None,
                "favors": None,
                "bands": TRADE_BANDS,
                "note": (
                    "A side has an unpriced, unknown or ambiguous card, so its total is incomplete: say which, ask "
                    "which printing when ambiguous, and give no gap or verdict."
                ),
            })
        problems = give_problems + get_problems
        _add_problems(result, problems)
        return result, give_refs + get_refs

    def _balance(
        self, owner_user_id: str, gap: float, favors: str | None, verdict: str, traded: list[dict[str, Any]]
    ) -> dict[str, Any] | None:
        """Who adds what to even it out: cash = the gap; when the user is short (favors
        'you'), up to 2 of the user's own cards priced within ±15% of the gap."""
        if verdict == "fair" or favors is None or gap <= 0:
            return None
        balance: dict[str, Any] = {"who_adds": "them" if favors == "them" else "you", "cash_usd": gap, "cards": []}
        if favors != "you":
            return balance
        traded_ids = {item["card_id"] for item in traded}
        try:
            pairs, tcg_ids, _ = self.tools._owner_holdings(owner_user_id, collection_id=None)
        except Exception:  # noqa: BLE001 - the suggestion is optional
            return balance
        low, high = gap * (1 - TRADE_BALANCE_CARD_SLACK_PCT / 100), gap * (1 + TRADE_BALANCE_CARD_SLACK_PCT / 100)
        picks = []
        for entry, card in pairs:
            if card["id"] in traded_ids:
                continue
            summary = self.tools._holding_summary(entry, card, tcgplayer_id=tcg_ids.get(card["id"]))
            price = summary.get("price_usd")
            if isinstance(price, (int, float)) and low <= price <= high:
                picks.append({
                    "card_id": summary["card_id"], "name": summary.get("name"), "set": summary.get("set"),
                    "number": summary.get("number"), "price_usd": price, "holding_id": summary.get("holding_id"),
                    "grader": summary.get("grader"), "grade": summary.get("grade"),
                })
        picks.sort(key=lambda pick: abs(pick["price_usd"] - gap))
        balance["cards"] = picks[:2]
        return balance


def _numbered(result: dict[str, Any], query: str) -> bool:
    number = str(result.get("number") or "").split("/")[0].lstrip("0")
    return bool(number) and re.search(rf"(?<!\d)0*{re.escape(number)}(?!\d)", query) is not None


def _asking(value: Any, name: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, str):
        value = value.replace("$", "").replace(",", "").strip()
        try:
            value = float(value)
        except ValueError:
            raise ToolInputError(f"{name} must be a USD amount.") from None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise ToolInputError(f"{name} must be a USD amount (0 or more).")
    if value > MAX_ASKING_USD:
        raise ToolInputError(f"{name} is too large.")
    return round(float(value), 2)


def _ref(item: dict[str, Any]) -> dict[str, Any]:
    """A tile ref for the card (graded items carry their slab)."""
    return {
        "card_id": item["card_id"],
        "name": item.get("name"),
        "set": item.get("set"),
        "number": item.get("number"),
        "language": item.get("language"),
        "image_small_url": item.get("image_small_url"),
        "price_usd": item.get("price_usd"),
        "variant": item.get("variant"),
        "grader": item.get("grader"),
        "grade": item.get("grade"),
        "quantity_owned": None,
        "app_url": item.get("app_url"),
    }


def _side(label: str, items: list[dict[str, Any]], problems: list[dict[str, Any]]) -> dict[str, Any]:
    unpriced = [item for item in items if item["price_usd"] is None]
    total = sum(item["market_total_usd"] or 0.0 for item in items)
    complete = bool(items) and not unpriced and not problems
    return {
        "label": label,
        "total_usd": _money(total) if complete else None,
        "priced_subtotal_usd": None if complete else _money(total),
        "complete": complete,
        "unpriced_count": len(unpriced) + sum(1 for problem in problems if problem["problem"] == "not_found"),
        "card_count": sum(item["quantity"] for item in items),
        "items": items,
    }


def _add_problems(result: dict[str, Any], problems: list[dict[str, Any]]) -> None:
    ambiguous = [problem for problem in problems if problem["problem"] == "ambiguous"]
    missing = [problem["query"] for problem in problems if problem["problem"] == "not_found"]
    if ambiguous:
        result["ambiguous"] = ambiguous
        result["ask_which"] = ambiguous[0]["ask_which"]
    if missing:
        result["not_found"] = missing


# --- wire payloads for the chat cards -------------------------------------------

_ITEM_WIRE_KEYS = (
    "card_id", "name", "set", "number", "image_small_url", "variant", "condition", "condition_assumed", "grader",
    "grade", "quantity", "price_usd", "market_total_usd", "asking_usd", "pct_of_market", "change_30d_pct",
    "price_as_of", "solds",
)


def _wire_item(item: dict[str, Any]) -> dict[str, Any]:
    return {key: item.get(key) for key in _ITEM_WIRE_KEYS if key in item}


def deal_card(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "deal",
        "verdict": result["verdict"],
        "label": result["verdict_label"],
        "asking_usd": result.get("asking_usd"),
        "market_usd": result.get("market_usd"),
        "pct_of_market": result.get("pct_of_market"),
        "diff_usd": result.get("diff_usd"),
        "side": result.get("side") or "buying",
        "bands": result.get("bands"),
        "items": [_wire_item(item) for item in result.get("items") or []],
        "unpriced_count": len(result.get("unpriced") or []),
    }


def trade_card(result: dict[str, Any]) -> dict[str, Any]:
    def side(key: str) -> dict[str, Any]:
        data = result.get(key) or {}
        return {
            "label": data.get("label"),
            "total_usd": data.get("total_usd"),
            "unpriced_count": data.get("unpriced_count", 0),
            "items": [_wire_item(item) for item in data.get("items") or []],
        }

    balance = result.get("balance") or None
    return {
        "kind": "trade",
        "verdict": result["verdict"],
        "label": result["verdict_label"],
        "side_a": side("side_a"),
        "side_b": side("side_b"),
        "gap_usd": result.get("gap_usd"),
        "gap_pct": result.get("gap_pct"),
        "favors": result.get("favors"),
        "bands": result.get("bands"),
        "balance": {"who_adds": balance["who_adds"], "cash_usd": balance["cash_usd"]} if balance else None,
    }


def grading_card(result: dict[str, Any]) -> dict[str, Any] | None:
    cards = []
    for card in result.get("cards") or []:
        if not isinstance(card, dict):
            continue
        cards.append({
            "card_id": card.get("card_id"),
            "name": card.get("name"),
            "set": card.get("set"),
            "number": card.get("number"),
            "image_small_url": card.get("image_small_url"),
            "raw_price_usd": card.get("raw_price_usd"),
            "recommendation": card.get("recommendation"),
            "break_even": card.get("break_even") or {},
            "scenarios": [
                {key: row.get(key) for key in ("grader", "grade", "comp_price_usd", "comp_source", "fee_usd",
                                                 "shipping_usd", "net_usd")}
                for row in card.get("scenarios") or [] if isinstance(row, dict)
            ],
        })
    if not cards or not any(card["scenarios"] for card in cards):
        return None
    fees = result.get("fees") or {}
    return {
        "kind": "grading",
        "cards": cards,
        "fees": {"as_of": fees.get("as_of"), "placeholder": bool(fees.get("placeholder")),
                 "shipping_usd": fees.get("shipping_usd")},
    }
