"""Response policy: the ONE place that decides what each tier may see.

`user` (default): an Ekalight account holder — their own collection plus the
catalog with names, images and USD prices.

`public` (future API-key tier): catalog-only. No account tools, no prices,
no catalog names/images, no buy links; a card is reduced to the ids that let a
caller join against their own data (tcgplayer_id, set code, number) plus
Ekalight's own art tags. Price filters/sorts are refused so price ordering
can't leak either.

Tools build full dicts; `ResponsePolicy.shape()` projects them on the way out.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

TIER_USER = "user"
TIER_PUBLIC = "public"

READ_TOOLS = (
    "list_facets",
    "search_cards",
    "get_card",
    "get_my_collection",
    "get_my_watchlist",
    "get_portfolio_summary",
    "find_missing",
    "get_price_history",
    "identify_card",
    "find_price_lows",
    "find_new_highs",
    "find_movers",
    "get_market_trends",
    "find_top_graded",
)
# Change the account; user tier only, and only while the owner's
# "Let AI assistants edit my collection" toggle is on (mcp_server/write_tools.py).
WRITE_TOOLS = ("add_to_collection", "update_holding", "watch_card")
ALL_TOOLS = READ_TOOLS + WRITE_TOOLS

# Keys of a card-shaped dict (CardSummary / HoldingSummary / get_card / movers).
USER_CARD_FIELDS = frozenset(
    {
        "card_id",
        "name",
        "set",
        "set_code",
        "number",
        "language",
        "rarity_bucket",
        "artist",
        "image_small_url",
        "price_usd",
        "price_source",
        # price_usd withheld: no observation in 14 days / raw above own PSA 10
        "price_stale",
        "price_as_of",
        "price_untrusted",
        "price_untrusted_reason",
        "app_url",
        "tcgplayer_id",
        # get_card
        "tags",
        "alt_text",
        "similar",
        "language_pair",
        "my_holdings",
        # HoldingSummary / movers; holding_id = deck entry id (user tier only)
        "holding_id",
        "quantity",
        "condition",
        "grader",
        "grade",
        "variant",
        "value_usd",
        "gain_usd",
        "gain_basis",
        "cost_basis_usd",
        "change_usd",
        "change_pct",
        "collection",
        "added_at",
        # find_missing
        "buy_links",
        # get_price_history (its payload has card_id, so it is shaped as a card)
        "points",
        "source",
        "sources",
        "as_of",
        "days_since_as_of",
        "available_variants",
        # portfolio movers
        "baseline_date",
        "baseline_price_usd",
        # identify_card (0-1 visual match score)
        "confidence",
        # get_my_watchlist
        "watch_variant",
        "target_price_usd",
        "target_triggered_at",
        "watched_at",
        # find_price_lows / get_market_trends
        "low_usd",
        "high_usd",
        "pct_below_high",
        "pct_above_low",
        "days_covered",
        "at_window_low",
        # find_new_highs
        "high_date",
        # find_movers
        "start_usd",
        "end_usd",
        "start_date",
        "end_date",
        "covers_full_window",
        "window_days",
        # find_top_graded
        "graded_price_usd",
        "price_basis",
        "price_trusted",
        "price_trust_reason",
        "price_verified",
        "label",
        "listed_price_usd",
        "reason",
        "range_start",
        "first_date",
        "last_date",
        "first_usd",
        "last_usd",
        "covers_full_range",
        "variant_note",
        "owned",
        "raw_price_usd",
        "comp_grader",
        "comp_grade",
        "comp_price_usd",
        "comp_source",
        "comp_sale_count",
        "comp_as_of",
        "comp_variant",
        "comp_missing",
        "gross_premium_usd",
        "gross_premium_pct",
    }
)
PUBLIC_CARD_FIELDS = frozenset(
    {
        "card_id",
        "tcgplayer_id",
        "set_code",
        "number",
        "language",
        "rarity_bucket",
        "tags",
        "similar",
        "language_pair",
    }
)

PRICE_FILTER_FIELDS = ("price_min_usd", "price_max_usd")
PRICE_SORTS = ("price_asc", "price_desc")


@dataclass(frozen=True)
class ResponsePolicy:
    tier: str
    tools: tuple[str, ...]
    card_fields: frozenset[str]
    allow_price_inputs: bool
    # Account tools need a real end-user identity (guest rejection, owner scoping).
    account_data: bool

    def allows_tool(self, name: str) -> bool:
        return name in self.tools

    def check_inputs(
        self, card_filter: dict[str, Any] | None, *, sort: str | None = None, owned: str | None = None
    ) -> None:
        """Raise ValueError for inputs the tier may not use."""
        if not self.account_data and owned not in (None, "any"):
            raise ValueError("owned filters need a signed-in Ekalight account.")
        if self.allow_price_inputs:
            return
        used = [field for field in PRICE_FILTER_FIELDS if (card_filter or {}).get(field) is not None]
        if used or sort in PRICE_SORTS:
            raise ValueError("Price filters and price sorts are not available on this plan.")

    def shape(self, value: Any) -> Any:
        """Project every card-shaped dict (has `card_id`) to the tier's allowlist."""
        if isinstance(value, list):
            return [self.shape(item) for item in value]
        if not isinstance(value, dict):
            return value
        if "card_id" in value:
            return {key: self.shape(item) for key, item in value.items() if key in self.card_fields}
        return {key: self.shape(item) for key, item in value.items()}


USER_POLICY = ResponsePolicy(
    tier=TIER_USER,
    tools=ALL_TOOLS,
    card_fields=USER_CARD_FIELDS,
    allow_price_inputs=True,
    account_data=True,
)
PUBLIC_POLICY = ResponsePolicy(
    tier=TIER_PUBLIC,
    tools=("list_facets", "search_cards", "get_card"),
    card_fields=PUBLIC_CARD_FIELDS,
    allow_price_inputs=False,
    account_data=False,
)
POLICIES = {TIER_USER: USER_POLICY, TIER_PUBLIC: PUBLIC_POLICY}


def policy_for_tier(tier: str | None) -> ResponsePolicy:
    key = str(tier or TIER_USER).strip().lower()
    if key not in POLICIES:
        raise ValueError(f"Unknown MCP tier {tier!r}; use one of {', '.join(POLICIES)}.")
    return POLICIES[key]
