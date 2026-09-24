"""Watchlist signals: "is this listing a deal?" plus the price-history-only
signals that feed the digest.

Pure functions over a sqlite connection (no service state), modelled on
``market_movers`` so the whole engine is unit-testable against an in-memory
catalog.

Scope / seam
------------
This module owns SIGNAL-level logic only:

  given an ALREADY-VALIDATED candidate listing price, a baseline and a current
  market price, is this a deal?  — plus the price-history-only predicates.

It owns none of the LISTING-level validation (is this the right card, is the
price real after shipping, is it a lot/proxy/bundle, is the auction inside its
final window). That lives in ``ebay_comps`` and lands here as a
``ListingCandidate``, which is the entire contract between the two halves.

Guardrails, all deliberate and each a separately named helper so it can be
tested in isolation (see ``GUARDRAIL_ORDER``):

- ``language_fence`` — on the RAW lane the card must be English. ~1028 Japanese
  raw cards carry broken Scrydex anchors (priced above their own slabs), so a
  raw-JP baseline is a garbage number to compare a real listing against. Graded
  JP stays eligible: the graded lane is not affected.
- ``price_floor`` — nothing under $5. Percentages on penny cards are noise.
- ``same_source`` — never compare a TCGCSV/USD number with a Scrydex/JPY one.
  Same reasoning as ``market_movers._same_source_pair``: mixing the two ends
  manufactures a phantom move. Applied to the baseline/market pair AND to the
  history series, which is filtered down to a single source key before any
  window stat is computed.
- ``distinct_prices`` — the series must hold >= 3 distinct rounded prices.
  Scrydex's flat JP anchors are a single repeated value that occasionally jumps;
  this keeps them out without a per-card denylist.
- ``significance`` — >= 12% under the baseline. Below that it is sync jitter.
  When the watch carries a liquidity read (every server-built baseline does)
  the bar is the TIER's instead — see "Liquidity tiers" below.
- ``liquidity_tier`` — tier ``none`` never makes a % deal.
- ``below_lowest_listing`` — tiers ``often`` / ``rarely`` must also undercut the
  printing's lowest current TCGplayer listing.
- ``too_good_floor`` — SUPPRESS anything >= 60% under market. That band is
  overwhelmingly proxies, damage and wrong-card listings; it is the single most
  important false-positive defence, and it is a suppression (not a pass) on
  purpose, so a bigger discount never wins the ranking by being more broken.
- ``rearm`` — never alert twice on the same listing id; the same card at most
  once per 7 days, unless the price improved by >= 10%.
- ``daily_cap`` — max 3 alerts per user per day, ranked by discount% x absolute
  dollars saved.

Liquidity tiers (per printing where data allows; docs/watch-printings-and-deal-
tiers-plan-2026-09-24.md). ``compute_liquidity`` reads PPT's eBay "ungraded"
velocity (per CARD — PPT keys eBay sales by product, which mixes printings)
and the printing's own raw_main TCGplayer cells:

  often   >= 10 sales / 30d     deal needs >= 10% AND below the lowest listing
  fewer   5-9 sales / 30d       ("Fewer sales") >= 20%
  rarely  1-4 sales / 90d, OR   ("Few sales") >= 25% AND below the lowest listing
          market frozen >= 7d while the lowest listing is >= 30% under it
  none    no usable data        ("Not enough sales to judge") never a % deal

Without PPT (staging) the day-over-day market CHANGES of the printing's
TCGplayer market over 30 days stand in for sales (TCGplayer's market only moves
on a sale): >= 10 -> often, 5-9 -> fewer, 1-4 -> rarely, 0 -> none. A frozen,
thin printing is capped at ``rarely`` even when PPT's per-card count is high.
Yardstick = min(printing market, PPT ungraded median when >= 3 sales).

``new_low`` (no % claim, any tier): a listing below the printing's lowest
TCGplayer low over the last 30 days AND below every listing already alerted
for that watch.

The ``min(added_market_price, current_market_price)`` baseline is load-bearing:
without it a card added during a price spike alerts on every listing forever,
and so does a card added two years ago before the market halved. See
``effective_baseline_cents``.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from statistics import median
from typing import Any, Iterable, Sequence

from catalog_tools import (
    _table_columns,
    _table_exists,
    fx_rate_snapshot_for_pair,
    price_history_rows_for_cards_batched,
    pricing_provider,
)
from fx_rates import convert_price

# --- guardrail constants -----------------------------------------------------

MIN_PRICE_CENTS = 500  # $5 floor, same as market_movers.DEFAULT_MIN_PRICE_USD
MIN_SIGNIFICANCE_PCT = 12.0
TOO_GOOD_PCT = 60.0  # >= this far under market is suppressed, not promoted
MIN_DISTINCT_PRICES = 3
MAX_ALERTS_PER_DAY = 3
CARD_REARM_DAYS = 7
CARD_REARM_IMPROVEMENT_PCT = 10.0

# Signal B (history-only, digest never push)
TRAILING_LOW_WINDOW_DAYS = 90
TRAILING_LOW_MIN_HISTORY_DAYS = 90  # ">= 3 months of history"
DRAWDOWN_WINDOW_DAYS = 30
DRAWDOWN_PCT = 12.0
SINCE_WATCHED_PCT = 5.0
TARGET_REARM_DAYS = 30

HISTORY_READ_DAYS = 400  # one batched read wide enough for every window above

LANE_RAW = "raw"
LANE_GRADED = "graded"

KIND_UNDER_ADDED = "under_added"
KIND_NEW_LOW = "new_low"
KIND_TRAILING_LOW = "trailing_low"
KIND_DRAWDOWN_30D = "drawdown_30d"
KIND_SINCE_WATCHED = "since_watched"
KIND_TARGET_HIT = "target_hit"

#: The order guardrails are applied in. Cheap, card-level rejections first so a
#: fenced or penny card never reaches the windowed statistics; the suppression
#: rules last so they always have the final word over a "better" discount.
#: ``evaluate_under_added`` walks exactly this list and names the step that
#: rejected a candidate in ``GuardrailResult.rejected_by``.
GUARDRAIL_ORDER = (
    "language_fence",
    "price_floor",
    "same_source",
    "distinct_prices",
    "liquidity_tier",
    "significance",
    "below_lowest_listing",
    "too_good_floor",
    "rearm",
    "daily_cap",
)

# --- liquidity tiers -----------------------------------------------------------

TIER_OFTEN = "often"
TIER_FEWER = "fewer"
TIER_RARELY = "rarely"
TIER_NONE = "none"
TIER_ORDER = (TIER_OFTEN, TIER_FEWER, TIER_RARELY, TIER_NONE)  # most -> least liquid
TIER_LABELS: dict[str, str | None] = {
    TIER_OFTEN: None,
    TIER_FEWER: "Fewer sales",
    TIER_RARELY: "Few sales",
    TIER_NONE: "Not enough sales to judge",
}
TIER_MIN_PCT = {TIER_OFTEN: 10.0, TIER_FEWER: 20.0, TIER_RARELY: 25.0}
TIER_NEEDS_BELOW_LOWEST_LISTING = {TIER_OFTEN: True, TIER_FEWER: False, TIER_RARELY: True}
OFTEN_MIN_SALES_30D = 10
FEWER_MIN_SALES_30D = 5
FROZEN_MARKET_DAYS = 7
THIN_LISTING_GAP_PCT = 30.0
LIQUIDITY_WINDOW_DAYS = 30
YARDSTICK_MIN_SALES = 3

NEW_LOW_WINDOW_DAYS = 30
NEW_LOW_MIN_CELL_DAYS = 7  # a week-old series has not "seen" anything yet

#: Guardrails the history-only (digest) signals apply, in order. No ``rearm`` /
#: ``daily_cap``: those are push concerns. ``target_hit`` carries its own 30-day
#: re-arm instead.
HISTORY_GUARDRAIL_ORDER = (
    "language_fence",
    "price_floor",
    "same_source",
    "distinct_prices",
)


# --- contracts ---------------------------------------------------------------


@dataclass(frozen=True)
class ListingCandidate:
    """A listing that has ALREADY passed listing-level validation upstream.

    This is the whole seam between the listing validator and this module. Money
    is integer cents, never floats; ``price_cents`` excludes shipping and
    ``shipping_cents`` is 0 for free shipping (never ``None`` — an unknown
    shipping cost is not a validated listing).
    """

    listing_id: str
    card_id: str
    price_cents: int
    shipping_cents: int
    url: str
    is_auction: bool = False
    ends_at: str | None = None  # ISO-8601 UTC; auctions only, else None
    verification_tier: str = "unverified"  # scrydex | aspects | title | unverified
    currency_code: str = "USD"
    title: str | None = None
    image_url: str | None = None

    @property
    def total_cents(self) -> int:
        """Shipping-INCLUSIVE price. Every comparison in this module uses this."""
        return int(self.price_cents) + int(self.shipping_cents)


def listing_candidate_from_validated(
    row: dict[str, Any], *, require_known_shipping: bool = True
) -> ListingCandidate | None:
    """Adapter for one validated-listing dict from the listing validator
    (``ebay_listings.validate_listing_candidates``) into this module's contract.

    The validator speaks dollars and camelCase; everything here is integer
    cents. ``shippingKnown=False`` means the total is the item price with
    shipping silently missing — a $2 card with $15 postage would read as a
    deal — so by default such a row is NOT a candidate.
    """
    if not isinstance(row, dict):
        return None
    listing_id = str(
        row.get("itemID") or row.get("legacyItemID") or row.get("itemURL") or ""
    ).strip()
    card_id = str(row.get("cardID") or row.get("card_id") or "").strip()
    price_cents = _as_cents(row.get("priceAmount"))
    if not listing_id or not card_id or price_cents is None:
        return None
    shipping_known = bool(row.get("shippingKnown"))
    if require_known_shipping and not shipping_known:
        return None
    total_cents = _as_cents(row.get("totalAmount")) or price_cents
    buying_option = str(row.get("buyingOption") or "").strip().lower()
    return ListingCandidate(
        listing_id=listing_id,
        card_id=card_id,
        price_cents=price_cents,
        shipping_cents=max(0, total_cents - price_cents),
        url=str(row.get("itemURL") or ""),
        is_auction="auction" in buying_option,
        ends_at=row.get("auctionEndAt") or None,
        verification_tier=str(row.get("verification") or "unverified"),
        currency_code=str(row.get("currencyCode") or "USD").strip().upper(),
        title=row.get("title"),
        image_url=row.get("imageURL"),
    )


@dataclass(frozen=True)
class PricePoint:
    """One day of a card's market price, normalized to USD cents and tagged with
    the source it came from so a series can be filtered to one lane."""

    price_date: str
    price_cents: int
    source_key: str


@dataclass(frozen=True)
class WatchBaseline:
    """Everything the signal engine needs about one watched (owner, card)."""

    owner_user_id: str
    card_id: str
    lane: str = LANE_RAW
    language: str | None = None
    game: str | None = None
    added_market_cents: int | None = None
    added_market_date: str | None = None
    added_source_key: str | None = None  # None on legacy rows: not checkable
    current_market_cents: int | None = None
    current_market_date: str | None = None
    market_source_key: str | None = None
    points: tuple[PricePoint, ...] = ()
    target_price_cents: int | None = None
    target_triggered_at: str | None = None
    # --- per printing (2026-09-24) ---
    variant_key: str = ""  # the watch's printing; '' = main printing
    printing: str | None = None  # resolved printing ('' -> card's main printing)
    card_printings: tuple[str, ...] = ()
    lowest_listing_cents: int | None = None  # newest TCGplayer low, this printing
    low_30d_cents: int | None = None  # lowest TCGplayer low over 30 days
    low_30d_days: int = 0  # cell days behind low_30d_cents
    liquidity: "Liquidity | None" = None  # None = legacy flat 12% bar
    lowest_alerted_cents: int | None = None  # cheapest listing alerted, this watch


@dataclass(frozen=True)
class Liquidity:
    tier: str
    source: str  # ppt | tcgplayer | none
    sales_30d: int | None = None
    sales_90d: int | None = None
    market_changes_30d: int | None = None
    frozen_thin: bool = False
    ungraded_median_cents: int | None = None
    ungraded_sales: int | None = None

    @property
    def label(self) -> str | None:
        return TIER_LABELS.get(self.tier)


@dataclass(frozen=True)
class PriorAlert:
    """An alert already delivered to this user — the re-arm state."""

    listing_id: str
    card_id: str
    total_cents: int
    created_at: str  # ISO-8601 UTC
    variant_key: str = ""


@dataclass(frozen=True)
class DealSignal:
    kind: str
    owner_user_id: str
    card_id: str
    listing_id: str
    url: str
    total_cents: int
    baseline_cents: int
    market_cents: int | None
    added_cents: int | None
    discount_pct: float | None  # None on new_low: no % claim
    savings_cents: int
    is_auction: bool = False
    ends_at: str | None = None
    verification_tier: str = "unverified"
    variant_key: str = ""
    tier: str | None = None
    tier_label: str | None = None
    lowest_seen_cents: int | None = None  # new_low: the bar it beat

    @property
    def rank_score(self) -> float:
        """discount% x absolute dollars saved — the daily-cap ranking. A new_low
        ranks on how far it sits under the bar it beat."""
        pct = self.discount_pct
        if pct is None:
            pct = discount_pct(self.total_cents, self.baseline_cents)
        return pct * (self.savings_cents / 100.0)


@dataclass(frozen=True)
class HistorySignal:
    kind: str
    owner_user_id: str
    card_id: str
    current_cents: int
    reference_cents: int
    move_pct: float
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class GuardrailResult:
    """Outcome of one candidate walking ``GUARDRAIL_ORDER``."""

    passed: bool
    rejected_by: str | None = None
    signal: DealSignal | None = None


# --- small numeric helpers ---------------------------------------------------


def _as_cents(value: Any) -> int | None:
    """Dollars (REAL) -> integer cents. Non-positive and unparseable -> None."""
    if value is None:
        return None
    try:
        cents = int(round(float(value) * 100))
    except (TypeError, ValueError):
        return None
    return cents if cents > 0 else None


def discount_pct(total_cents: int, baseline_cents: int) -> float:
    """How far ``total_cents`` sits under ``baseline_cents``, in percent.
    Negative when the listing is ABOVE the baseline."""
    if baseline_cents <= 0:
        return 0.0
    return (baseline_cents - total_cents) / baseline_cents * 100.0


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        parsed = None
        day = _parse_date(value)
        if day is not None:
            parsed = datetime(day.year, day.month, day.day)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


# --- guardrails (one named, separately testable helper each) -----------------


def passes_price_floor(*amounts_cents: int | None) -> bool:
    """Every supplied amount must be >= $5. A missing amount fails: we do not
    reason about a price we do not have."""
    for amount in amounts_cents:
        if amount is None or int(amount) < MIN_PRICE_CENTS:
            return False
    return True


def passes_language_fence(language: str | None, *, lane: str = LANE_RAW) -> bool:
    """Raw lane: English only. Graded lane: everything, including JP.

    ``cards.language`` holds human labels ("English"/"Japanese") on live rows and
    short codes ("en"/"ja") on some imports, so both spellings are accepted.
    """
    if str(lane or "").strip().lower() != LANE_RAW:
        return True
    normalized = str(language or "").strip().lower()
    return normalized in {"en", "eng", "english"}


def same_source_ok(left_source: str | None, right_source: str | None) -> bool:
    """True when two prices may be compared like-for-like.

    An unknown source on either side is tolerated (legacy ``card_favorites``
    rows were written before source tagging and carry no lineage); a KNOWN
    mismatch — e.g. a Scrydex/JPY baseline against a TCGCSV/USD market — is
    rejected, because that pair manufactures a move that never happened.
    """
    left = str(left_source or "").strip().lower()
    right = str(right_source or "").strip().lower()
    if not left or not right:
        return True
    return left == right


def same_source_points(
    points: Sequence[PricePoint], *, source_key: str | None = None
) -> tuple[PricePoint, ...]:
    """The subsequence of ``points`` that shares ONE source key, oldest→newest.

    Defaults to the newest point's source — "now" is what the user is being
    compared against, so the window is trimmed back to whatever matches it
    rather than the other way round.
    """
    ordered = sorted(points, key=lambda p: p.price_date)
    if not ordered:
        return ()
    key = str(source_key or ordered[-1].source_key or "").strip().lower()
    return tuple(p for p in ordered if str(p.source_key or "").strip().lower() == key)


def passes_distinct_prices(
    points: Sequence[PricePoint], *, minimum: int = MIN_DISTINCT_PRICES
) -> bool:
    """The series must carry >= 3 distinct prices. A flat anchor that ticks once
    has two, and is not a market."""
    return len({int(p.price_cents) for p in points}) >= minimum


def passes_significance(pct: float, *, minimum: float = MIN_SIGNIFICANCE_PCT) -> bool:
    return float(pct) >= float(minimum)


def passes_too_good_floor(pct: float, *, ceiling: float = TOO_GOOD_PCT) -> bool:
    """SUPPRESSION: False once the discount reaches ``ceiling``. Deliberately a
    hard stop rather than a demotion — that band is proxies, damage and
    wrong-card listings, and a ranked list would otherwise put them on top."""
    return float(pct) < float(ceiling)


def rearm_allows(
    candidate: ListingCandidate,
    prior_alerts: Iterable[PriorAlert],
    *,
    now: datetime | None = None,
    card_rearm_days: int = CARD_REARM_DAYS,
    improvement_pct: float = CARD_REARM_IMPROVEMENT_PCT,
    variant_key: str = "",
) -> bool:
    """False when this would repeat an alert.

    Two rules: a listing id alerts exactly once, ever; and a watch (card +
    printing) alerts at most once per ``card_rearm_days``, unless this listing is at least
    ``improvement_pct`` cheaper than the last alert for that card (a genuinely
    better deal is worth interrupting for).
    """
    moment = now or datetime.now(timezone.utc)
    cutoff = moment - timedelta(days=card_rearm_days)
    total = candidate.total_cents
    for prior in prior_alerts:
        if str(prior.listing_id) == str(candidate.listing_id):
            return False
        if str(prior.card_id) != str(candidate.card_id):
            continue
        if str(prior.variant_key or "") != str(variant_key or ""):
            continue
        created = _parse_datetime(prior.created_at)
        if created is None or created < cutoff:
            continue
        if prior.total_cents <= 0:
            return False
        improvement = (prior.total_cents - total) / prior.total_cents * 100.0
        if improvement < improvement_pct:
            return False
    return True


def rank_and_cap(
    signals: Sequence[DealSignal],
    *,
    limit: int = MAX_ALERTS_PER_DAY,
    already_sent_today: int = 0,
) -> list[DealSignal]:
    """The day's alerts for ONE user: best first, capped.

    Ranked by discount% x absolute dollars saved, so a 15%-off $400 card beats a
    30%-off $12 card. ``already_sent_today`` lets a second run of the day top up
    to the same cap instead of restarting it.
    """
    remaining = max(0, int(limit) - max(0, int(already_sent_today)))
    if remaining <= 0:
        return []
    ordered = sorted(
        signals, key=lambda s: (-s.rank_score, -s.savings_cents, str(s.listing_id))
    )
    return ordered[:remaining]


# --- the headline: under_added ----------------------------------------------


def effective_baseline_cents(
    added_cents: int | None,
    market_cents: int | None,
    *,
    added_source: str | None = None,
    market_source: str | None = None,
) -> int | None:
    """``min(added_market_price, current_market_price)`` — the deal baseline.

    The ``min`` is the whole point. Comparing against the add-time price alone
    means a card added during a spike alerts on every listing forever (the spike
    price is no longer a real market). Comparing against today's market alone
    means a card added two years ago at half today's price alerts on listings
    the user would consider expensive. The lower of the two is the only number
    that is honest in both directions.

    When the two are known to come from different sources they are not
    comparable, so the add-time number is dropped and today's market stands
    alone rather than silently winning a cross-source ``min``.
    """
    if market_cents is None:
        return added_cents
    if added_cents is None:
        return market_cents
    if not same_source_ok(added_source, market_source):
        return market_cents
    return min(int(added_cents), int(market_cents))


def compute_liquidity(
    cells: Sequence[Any],
    ungraded: Any | None = None,
) -> Liquidity:
    """The watch's liquidity tier. ``cells`` are the printing's raw_main points
    (``price_date``, ``market_cents``, ``low_cents``; oldest→newest);
    ``ungraded`` is the card's PPT eBay-ungraded row (``sales_30d``,
    ``sales_90d``, ``median_cents``, ``sales_count``) or None."""
    ordered = sorted(
        (c for c in cells if getattr(c, "market_cents", None)), key=lambda c: c.price_date
    )
    frozen_thin = _frozen_and_thin(ordered)
    changes = _market_changes(ordered, days=LIQUIDITY_WINDOW_DAYS) if ordered else None

    median_cents = getattr(ungraded, "median_cents", None) if ungraded is not None else None
    sales_30d = getattr(ungraded, "sales_30d", None) if ungraded is not None else None
    sales_90d = getattr(ungraded, "sales_90d", None) if ungraded is not None else None
    count_for_median = sales_30d if sales_30d is not None else (
        getattr(ungraded, "sales_count", None) if ungraded is not None else None
    )

    tier: str | None = None
    source = "none"
    if sales_30d is not None and (sales_30d > 0 or (sales_90d or 0) > 0):
        source = "ppt"
        if sales_30d >= OFTEN_MIN_SALES_30D:
            tier = TIER_OFTEN
        elif sales_30d >= FEWER_MIN_SALES_30D:
            tier = TIER_FEWER
        else:
            tier = TIER_RARELY
    elif changes is not None:
        source = "tcgplayer"
        if changes >= OFTEN_MIN_SALES_30D:
            tier = TIER_OFTEN
        elif changes >= FEWER_MIN_SALES_30D:
            tier = TIER_FEWER
        elif changes >= 1:
            tier = TIER_RARELY
        else:
            tier = TIER_NONE
    if frozen_thin:
        # A printing whose market has not moved in a week while copies list far
        # under it is thin, whatever PPT's per-CARD count says (it mixes printings).
        tier = _less_liquid(tier or TIER_RARELY, TIER_RARELY)
        if source == "none":
            source = "tcgplayer"
    return Liquidity(
        tier=tier or TIER_NONE,
        source=source,
        sales_30d=sales_30d,
        sales_90d=sales_90d,
        market_changes_30d=changes,
        frozen_thin=frozen_thin,
        ungraded_median_cents=(
            int(median_cents)
            if median_cents and count_for_median is not None and count_for_median >= YARDSTICK_MIN_SALES
            else None
        ),
        ungraded_sales=count_for_median,
    )


def _less_liquid(left: str, right: str) -> str:
    return left if TIER_ORDER.index(left) >= TIER_ORDER.index(right) else right


def _market_changes(cells: Sequence[Any], *, days: int) -> int:
    """Day-over-day market changes inside the trailing window (anchored on the
    newest cell). TCGplayer's market only moves on a sale."""
    anchor = _parse_date(cells[-1].price_date)
    if anchor is None:
        return 0
    cutoff = anchor - timedelta(days=int(days))
    window = [c for c in cells if (_parse_date(c.price_date) or anchor) >= cutoff]
    return sum(
        1 for before, after in zip(window, window[1:]) if before.market_cents != after.market_cents
    )


def _frozen_and_thin(cells: Sequence[Any]) -> bool:
    """Market unchanged for >= 7 days while the newest lowest listing sits
    >= 30% under it (the Dragonite reverse-holo pattern)."""
    if not cells:
        return False
    newest = cells[-1]
    market = newest.market_cents
    low = getattr(newest, "low_cents", None)
    if not market or not low:
        return False
    if discount_pct(int(low), int(market)) < THIN_LISTING_GAP_PCT:
        return False
    newest_day = _parse_date(newest.price_date)
    if newest_day is None:
        return False
    unchanged_since = newest_day
    for cell in reversed(cells[:-1]):
        if cell.market_cents != market:
            break
        day = _parse_date(cell.price_date)
        if day is not None:
            unchanged_since = day
    return (newest_day - unchanged_since).days >= FROZEN_MARKET_DAYS


def yardstick_cents(market_cents: int | None, liquidity: Liquidity | None) -> int | None:
    """min(printing market, PPT ungraded median when >= 3 sales)."""
    median = liquidity.ungraded_median_cents if liquidity is not None else None
    if market_cents is None:
        return median
    if median:
        return min(int(market_cents), int(median))
    return int(market_cents)


def evaluate_under_added(
    candidate: ListingCandidate,
    baseline: WatchBaseline,
    *,
    prior_alerts: Sequence[PriorAlert] = (),
    now: datetime | None = None,
) -> GuardrailResult:
    """Walk ``GUARDRAIL_ORDER`` for one validated listing against one watch.
    ``daily_cap`` is not applied here — it is a per-user decision across
    the surviving signals, applied by ``rank_and_cap``.

    ``baseline.liquidity`` None keeps the legacy flat 12% bar (hand-built
    baselines); every server-built baseline carries a tier."""
    if not passes_language_fence(baseline.language, lane=baseline.lane):
        return GuardrailResult(False, "language_fence")

    total = candidate.total_cents
    market = baseline.current_market_cents
    if not passes_price_floor(total, market):
        return GuardrailResult(False, "price_floor")

    # same_source: every price here is USD cents, so a listing quoted in another
    # currency has no comparable baseline. A baseline/market source MISMATCH is
    # not fatal — effective_baseline_cents drops the add-time number instead of
    # taking a cross-source min.
    if str(candidate.currency_code or "USD").strip().upper() != "USD":
        return GuardrailResult(False, "same_source")

    points = same_source_points(baseline.points, source_key=baseline.market_source_key)
    if not passes_distinct_prices(points):
        return GuardrailResult(False, "distinct_prices")

    liquidity = baseline.liquidity
    if liquidity is not None and liquidity.tier == TIER_NONE:
        return GuardrailResult(False, "liquidity_tier")

    reference = yardstick_cents(market, liquidity) if liquidity is not None else market
    effective = effective_baseline_cents(
        baseline.added_market_cents,
        reference,
        added_source=baseline.added_source_key,
        market_source=baseline.market_source_key,
    )
    if not passes_price_floor(effective):
        return GuardrailResult(False, "price_floor")

    pct = discount_pct(total, int(effective))
    minimum = TIER_MIN_PCT[liquidity.tier] if liquidity is not None else MIN_SIGNIFICANCE_PCT
    if not passes_significance(pct, minimum=minimum):
        return GuardrailResult(False, "significance")
    if liquidity is not None and TIER_NEEDS_BELOW_LOWEST_LISTING[liquidity.tier]:
        lowest = baseline.lowest_listing_cents
        if lowest is None or total >= int(lowest):
            return GuardrailResult(False, "below_lowest_listing")
    if not passes_too_good_floor(pct):
        return GuardrailResult(False, "too_good_floor")
    if not rearm_allows(candidate, prior_alerts, now=now, variant_key=baseline.variant_key):
        return GuardrailResult(False, "rearm")

    return GuardrailResult(
        True,
        None,
        DealSignal(
            kind=KIND_UNDER_ADDED,
            owner_user_id=baseline.owner_user_id,
            card_id=baseline.card_id,
            listing_id=candidate.listing_id,
            url=candidate.url,
            total_cents=total,
            baseline_cents=int(effective),
            market_cents=int(market),
            added_cents=baseline.added_market_cents,
            discount_pct=round(pct, 2),
            savings_cents=int(effective) - total,
            is_auction=candidate.is_auction,
            ends_at=candidate.ends_at,
            verification_tier=candidate.verification_tier,
            variant_key=baseline.variant_key,
            tier=liquidity.tier if liquidity is not None else None,
            tier_label=liquidity.label if liquidity is not None else None,
        ),
    )


def evaluate_new_low(
    candidate: ListingCandidate,
    baseline: WatchBaseline,
    *,
    prior_alerts: Sequence[PriorAlert] = (),
    now: datetime | None = None,
) -> GuardrailResult:
    """"The lowest we've seen": below the printing's lowest TCGplayer low over
    the last 30 days AND below every listing already alerted for this watch.
    No % claim, so it is allowed in every tier (including ``none``); the
    card-level fences, the floor, the too-good suppression and re-arm still
    apply."""
    if not passes_language_fence(baseline.language, lane=baseline.lane):
        return GuardrailResult(False, "language_fence")
    total = candidate.total_cents
    if not passes_price_floor(total):
        return GuardrailResult(False, "price_floor")
    if str(candidate.currency_code or "USD").strip().upper() != "USD":
        return GuardrailResult(False, "same_source")
    low = baseline.low_30d_cents
    if low is None or baseline.low_30d_days < NEW_LOW_MIN_CELL_DAYS:
        return GuardrailResult(False, "no_low_history")
    bar = int(low)
    if baseline.lowest_alerted_cents is not None:
        bar = min(bar, int(baseline.lowest_alerted_cents))
    if total >= bar:
        return GuardrailResult(False, "not_a_new_low")
    market = baseline.current_market_cents
    if market and not passes_too_good_floor(discount_pct(total, int(market))):
        return GuardrailResult(False, "too_good_floor")
    if not rearm_allows(candidate, prior_alerts, now=now, variant_key=baseline.variant_key):
        return GuardrailResult(False, "rearm")
    liquidity = baseline.liquidity
    return GuardrailResult(
        True,
        None,
        DealSignal(
            kind=KIND_NEW_LOW,
            owner_user_id=baseline.owner_user_id,
            card_id=baseline.card_id,
            listing_id=candidate.listing_id,
            url=candidate.url,
            total_cents=total,
            # "usually $X+": the printing's 30-day TCGplayer low.
            baseline_cents=int(low),
            market_cents=int(market) if market else None,
            added_cents=baseline.added_market_cents,
            discount_pct=None,
            savings_cents=bar - total,
            is_auction=candidate.is_auction,
            ends_at=candidate.ends_at,
            verification_tier=candidate.verification_tier,
            variant_key=baseline.variant_key,
            tier=liquidity.tier if liquidity is not None else None,
            tier_label=liquidity.label if liquidity is not None else None,
            lowest_seen_cents=bar,
        ),
    )


def evaluate_watch_listing(
    candidate: ListingCandidate,
    baseline: WatchBaseline,
    *,
    prior_alerts: Sequence[PriorAlert] = (),
    now: datetime | None = None,
) -> GuardrailResult:
    """A % deal when it is one; otherwise a new_low when it is one. Only
    server-built baselines (with a liquidity read) are eligible for new_low."""
    result = evaluate_under_added(candidate, baseline, prior_alerts=prior_alerts, now=now)
    if result.passed or baseline.liquidity is None:
        return result
    if result.rejected_by in {"language_fence", "same_source", "too_good_floor", "rearm"}:
        return result
    new_low = evaluate_new_low(candidate, baseline, prior_alerts=prior_alerts, now=now)
    return new_low if new_low.passed else result


def evaluate_watch_batch(
    pairs: Sequence[tuple[ListingCandidate, WatchBaseline]],
    *,
    prior_alerts: Sequence[PriorAlert] = (),
    already_sent_today: int = 0,
    limit: int = MAX_ALERTS_PER_DAY,
    now: datetime | None = None,
) -> list[DealSignal]:
    """One user's alerts for the day over (listing, watch) pairs that already
    passed the printing match, then the ``daily_cap``. A listing that pairs
    with two watches alerts once (the first survivor)."""
    survivors: list[DealSignal] = []
    seen: set[str] = set()
    for candidate, baseline in pairs:
        result = evaluate_watch_listing(
            candidate, baseline, prior_alerts=prior_alerts, now=now
        )
        if result.passed and result.signal is not None:
            if result.signal.listing_id in seen:
                continue
            seen.add(result.signal.listing_id)
            survivors.append(result.signal)
    return rank_and_cap(survivors, limit=limit, already_sent_today=already_sent_today)


def evaluate_under_added_batch(
    candidates: Sequence[ListingCandidate],
    baselines_by_card: dict[str, WatchBaseline],
    *,
    prior_alerts: Sequence[PriorAlert] = (),
    already_sent_today: int = 0,
    limit: int = MAX_ALERTS_PER_DAY,
    now: datetime | None = None,
) -> list[DealSignal]:
    """One user's alerts for the day: evaluate every validated listing, then
    apply the ``daily_cap`` guardrail across the survivors. (One watch per
    card; the scan job uses ``evaluate_watch_batch`` for per-printing pairs.)"""
    pairs = [
        (candidate, baselines_by_card[str(candidate.card_id)])
        for candidate in candidates
        if str(candidate.card_id) in baselines_by_card
    ]
    return evaluate_watch_batch(
        pairs,
        prior_alerts=prior_alerts,
        already_sent_today=already_sent_today,
        limit=limit,
        now=now,
    )


# --- Signal B: price-history-only (digest, never push) ----------------------


def points_in_window(
    points: Sequence[PricePoint], *, days: int, today: date | None = None
) -> tuple[PricePoint, ...]:
    """Points within the trailing ``days`` window, oldest→newest. The window is
    anchored on the newest point, not on the wall clock, so a sync that is a day
    or two behind does not silently empty every window."""
    ordered = sorted(points, key=lambda p: p.price_date)
    if not ordered:
        return ()
    anchor = _parse_date(ordered[-1].price_date)
    if anchor is None:
        return ()
    if today is not None and today < anchor:
        anchor = today
    cutoff = anchor - timedelta(days=int(days))
    kept = []
    for point in ordered:
        day = _parse_date(point.price_date)
        if day is not None and day >= cutoff:
            kept.append(point)
    return tuple(kept)


def history_span_days(points: Sequence[PricePoint]) -> int:
    """Calendar days between the oldest and newest point."""
    ordered = sorted(points, key=lambda p: p.price_date)
    if len(ordered) < 2:
        return 0
    first = _parse_date(ordered[0].price_date)
    last = _parse_date(ordered[-1].price_date)
    if first is None or last is None:
        return 0
    return (last - first).days


def _history_guardrails(baseline: WatchBaseline) -> tuple[PricePoint, ...] | None:
    """``HISTORY_GUARDRAIL_ORDER`` applied once; the same-source series, or None
    when the card is not eligible for any history signal."""
    if not passes_language_fence(baseline.language, lane=baseline.lane):
        return None
    if not passes_price_floor(baseline.current_market_cents):
        return None
    points = same_source_points(baseline.points, source_key=baseline.market_source_key)
    if not passes_distinct_prices(points):
        return None
    return points


def trailing_low_signal(
    baseline: WatchBaseline, *, today: date | None = None
) -> HistorySignal | None:
    """Current market is at or below the 90-day window low. Requires >= 3 months
    of history, so a card we have tracked for a fortnight is never called a low."""
    points = _history_guardrails(baseline)
    if not points:
        return None
    current = baseline.current_market_cents
    if current is None:
        return None
    window = points_in_window(points, days=TRAILING_LOW_WINDOW_DAYS, today=today)
    if len(window) < MIN_DISTINCT_PRICES:
        return None
    if history_span_days(points) < TRAILING_LOW_MIN_HISTORY_DAYS:
        return None
    low = min(p.price_cents for p in window)
    if current > low:
        return None
    high = max(p.price_cents for p in window)
    return HistorySignal(
        kind=KIND_TRAILING_LOW,
        owner_user_id=baseline.owner_user_id,
        card_id=baseline.card_id,
        current_cents=current,
        reference_cents=high,
        move_pct=round(discount_pct(current, high), 2),
        detail={
            "windowDays": TRAILING_LOW_WINDOW_DAYS,
            "windowLowCents": low,
            "windowHighCents": high,
            "historyDays": history_span_days(points),
        },
    )


def drawdown_30d_signal(
    baseline: WatchBaseline, *, today: date | None = None
) -> HistorySignal | None:
    """Current market is >= 12% below the 30-day median. Median, not mean, so a
    single bad sync day cannot fabricate a drawdown."""
    points = _history_guardrails(baseline)
    if not points:
        return None
    current = baseline.current_market_cents
    if current is None:
        return None
    window = points_in_window(points, days=DRAWDOWN_WINDOW_DAYS, today=today)
    if len(window) < MIN_DISTINCT_PRICES:
        return None
    reference = int(round(median(p.price_cents for p in window)))
    if reference <= 0:
        return None
    pct = discount_pct(current, reference)
    if pct < DRAWDOWN_PCT:
        return None
    return HistorySignal(
        kind=KIND_DRAWDOWN_30D,
        owner_user_id=baseline.owner_user_id,
        card_id=baseline.card_id,
        current_cents=current,
        reference_cents=reference,
        move_pct=round(pct, 2),
        detail={"windowDays": DRAWDOWN_WINDOW_DAYS, "medianCents": reference},
    )


def since_watched_signal(baseline: WatchBaseline) -> HistorySignal | None:
    """Market is >= 5% below what it was when the user added the card. Lower bar
    than the deal signals on purpose: this is a digest line, not a push."""
    points = _history_guardrails(baseline)
    if not points:
        return None
    current = baseline.current_market_cents
    added = baseline.added_market_cents
    if current is None or added is None:
        return None
    if not same_source_ok(baseline.added_source_key, baseline.market_source_key):
        return None
    pct = discount_pct(current, added)
    if pct < SINCE_WATCHED_PCT:
        return None
    return HistorySignal(
        kind=KIND_SINCE_WATCHED,
        owner_user_id=baseline.owner_user_id,
        card_id=baseline.card_id,
        current_cents=current,
        reference_cents=added,
        move_pct=round(pct, 2),
        detail={"addedOn": baseline.added_market_date},
    )


def target_hit_signal(
    baseline: WatchBaseline,
    *,
    target_price_cents: int | None = None,
    target_triggered_at: str | None = None,
    today: date | None = None,
) -> HistorySignal | None:
    """Market crossed BELOW the user's target.

    Crossing, not "is under": the previous same-source point must have been at
    or above the target, so a card that has sat under its target for a month
    does not re-announce itself every run. A 30-day re-arm covers the case where
    the price oscillates across the line.

    The target is a PARAMETER, not a column read: ``card_favorites`` has no
    target column yet (a later agent adds ``target_price_cents``), so nothing
    here depends on the schema catching up.
    """
    target = target_price_cents if target_price_cents is not None else baseline.target_price_cents
    if target is None or int(target) <= 0:
        return None
    triggered_at = target_triggered_at or baseline.target_triggered_at
    points = _history_guardrails(baseline)
    if not points:
        return None
    current = baseline.current_market_cents
    if current is None or current > int(target):
        return None
    if len(points) < 2 or points[-2].price_cents < int(target):
        return None  # already below the line on the previous point: not a crossing
    last = _parse_date(triggered_at)
    if last is not None:
        anchor = _parse_date(points[-1].price_date) or (today or datetime.now(timezone.utc).date())
        if (anchor - last).days < TARGET_REARM_DAYS:
            return None
    return HistorySignal(
        kind=KIND_TARGET_HIT,
        owner_user_id=baseline.owner_user_id,
        card_id=baseline.card_id,
        current_cents=current,
        reference_cents=int(target),
        move_pct=round(discount_pct(current, int(target)), 2),
        detail={"targetCents": int(target), "previousCents": points[-2].price_cents},
    )


def evaluate_history_signals(
    baseline: WatchBaseline,
    *,
    target_price_cents: int | None = None,
    target_triggered_at: str | None = None,
    today: date | None = None,
) -> list[HistorySignal]:
    """Every history-only signal for one watched card, digest order."""
    signals = [
        trailing_low_signal(baseline, today=today),
        drawdown_30d_signal(baseline, today=today),
        since_watched_signal(baseline),
        target_hit_signal(
            baseline,
            target_price_cents=target_price_cents,
            target_triggered_at=target_triggered_at,
            today=today,
        ),
    ]
    return [signal for signal in signals if signal is not None]


# --- the daily job's single batched read ------------------------------------


def _source_key_for_row(row: dict[str, Any]) -> str:
    """The lineage tag for one resolved history row.

    ``price_history_rows_for_cards_batched`` does not label which physical lane
    produced a row, but the fields it DOES return separate them in practice: the
    TCGCSV main lane is always USD with its own variant label, while a Scrydex
    default-raw JP row carries JPY. Currency is the part that matters — it is
    where a phantom move is manufactured — so it leads the key.
    """
    currency = str(row.get("currencyCode") or "USD").strip().upper()
    variant = str(row.get("variant") or "").strip().lower()
    condition = str(row.get("condition") or "").strip().lower()
    grader = str(row.get("grader") or "").strip().upper()
    grade = str(row.get("grade") or "").strip().upper()
    return f"{currency}|{variant}|{condition}|{grader}|{grade}"


def _jpy_usd_rate(connection: sqlite3.Connection) -> Decimal | None:
    try:
        snapshot = fx_rate_snapshot_for_pair(connection, "JPY", "USD")
    except sqlite3.Error:
        return None
    if snapshot is None or snapshot.get("rate") in (None, 0):
        return None
    return Decimal(str(snapshot["rate"]))


def _usd_cents(value: Any, currency: str, *, jpy_usd: Decimal | None) -> int | None:
    """Market price -> USD cents. USD passes through; JPY converts at the stored
    snapshot rate (same path market_movers uses); anything else is ineligible
    rather than guessed at."""
    code = str(currency or "USD").strip().upper()
    if code == "USD":
        return _as_cents(value)
    if code == "JPY" and jpy_usd is not None:
        return _as_cents(convert_price(_float_or_none(value), rate=jpy_usd))
    return None


def _float_or_none(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def price_points_from_history_rows(
    rows: Sequence[dict[str, Any]], *, jpy_usd: Decimal | None = None
) -> tuple[PricePoint, ...]:
    """Resolved history rows (newest-first, as the batched reader returns them)
    -> USD-cents ``PricePoint``s, oldest→newest, one per date."""
    by_date: dict[str, PricePoint] = {}
    for row in rows:
        price_date = str(row.get("date") or "")
        if not price_date or price_date in by_date:
            continue
        cents = _usd_cents(row.get("market"), row.get("currencyCode"), jpy_usd=jpy_usd)
        if cents is None:
            continue
        by_date[price_date] = PricePoint(
            price_date=price_date,
            price_cents=cents,
            source_key=_source_key_for_row(row),
        )
    return tuple(sorted(by_date.values(), key=lambda p: p.price_date))


def watched_cards(
    connection: sqlite3.Connection, *, owner_user_ids: Sequence[str] | None = None
) -> list[dict[str, Any]]:
    """Every watch (owner, card, printing) with its card-level fence inputs.

    One query joining ``card_favorites`` to ``cards``. The add-time baseline,
    target and ``variant_key`` columns are selected only when present, so this
    reads correctly both before and after the schema patches that add them.
    """
    if not _table_exists(connection, "card_favorites"):
        return []
    favorite_columns = _table_columns(connection, "card_favorites")
    card_columns = _table_columns(connection, "cards")

    def _favorite(name: str, fallback: str = "NULL") -> str:
        return f"f.{name}" if name in favorite_columns else f"{fallback} AS {name}"

    def _card(name: str, fallback: str = "NULL") -> str:
        return f"c.{name}" if name in card_columns else f"{fallback} AS {name}"

    select = ", ".join(
        [
            "f.owner_user_id",
            "f.card_id",
            _favorite("variant_key", "''"),
            _favorite("added_market_price"),
            _favorite("added_market_date"),
            _favorite("target_price_cents"),
            _favorite("target_triggered_at"),
            _card("language"),
            _card("game", "'pokemon'"),
        ]
    )
    query = (
        f"SELECT {select} FROM card_favorites f "
        "JOIN cards c ON c.id = f.card_id"
    )
    params: list[Any] = []
    owners = [str(owner) for owner in (owner_user_ids or []) if str(owner or "").strip()]
    if owners:
        placeholders = ",".join("?" for _ in owners)
        query += f" WHERE f.owner_user_id IN ({placeholders})"
        params.extend(owners)
    order_variant = ", f.variant_key" if "variant_key" in favorite_columns else ""
    query += f" ORDER BY f.owner_user_id, f.card_id{order_variant}"
    rows = [dict(row) for row in connection.execute(query, params).fetchall()]
    for row in rows:
        row["variant_key"] = str(row.get("variant_key") or "").strip()
    return rows


def _cell_price_points(cells: Sequence[Any], printing: str) -> tuple[PricePoint, ...]:
    source_key = f"USD|{str(printing or '').strip().lower()}|nm||"
    return tuple(
        PricePoint(price_date=c.price_date, price_cents=int(c.market_cents), source_key=source_key)
        for c in cells
        if c.market_cents
    )


def _low_window(cells: Sequence[Any], *, days: int) -> tuple[int | None, int]:
    """(lowest TCGplayer low, number of cell days with a low) over the trailing
    ``days`` window anchored on the newest cell."""
    if not cells:
        return None, 0
    anchor = _parse_date(cells[-1].price_date)
    if anchor is None:
        return None, 0
    cutoff = anchor - timedelta(days=int(days))
    lows = [
        int(c.low_cents)
        for c in cells
        if c.low_cents and (_parse_date(c.price_date) or anchor) >= cutoff
    ]
    return (min(lows) if lows else None), len(lows)


def lowest_alerted_by_watch(
    connection: sqlite3.Connection, owner_user_ids: Sequence[str] | None = None
) -> dict[tuple[str, str, str], int]:
    """(owner, card, variant_key) -> the cheapest listing ever alerted for that
    watch (the new_low bar). {} before ``deal_alerts`` exists."""
    if not _table_exists(connection, "deal_alerts"):
        return {}
    has_variant = "variant_key" in _table_columns(connection, "deal_alerts")
    variant = "COALESCE(variant_key, '')" if has_variant else "''"
    query = (
        f"SELECT owner_user_id, card_id, {variant} AS variant_key, MIN(total_cents) "
        "FROM deal_alerts"
    )
    params: list[Any] = []
    owners = [str(owner) for owner in (owner_user_ids or []) if str(owner or "").strip()]
    if owners:
        query += f" WHERE owner_user_id IN ({','.join('?' for _ in owners)})"
        params.extend(owners)
    query += " GROUP BY owner_user_id, card_id, 3"
    return {
        (str(row[0]), str(row[1]), str(row[2] or "")): int(row[3])
        for row in connection.execute(query, params).fetchall()
        if row[3] is not None
    }


def watched_card_baselines(
    connection: sqlite3.Connection,
    *,
    owner_user_ids: Sequence[str] | None = None,
    lane: str = LANE_RAW,
    provider: str | None = None,
    days: int = HISTORY_READ_DAYS,
    today: date | None = None,
) -> list[WatchBaseline]:
    """The daily job's driver: every watch (owner, card, printing) with its
    baseline, current market, same-source history series and liquidity read.

    ONE batched history read for the DISTINCT watched card ids — the per-card
    N+1 this replaces is what made the Insights cold path 15-24s — plus one
    batched raw_main cell read and one PPT read. A main-printing watch ('')
    keeps today's card-level series; a printing watch reads its own
    raw_main cells.
    """
    import watch_printings  # local: keeps this module importable standalone

    rows = watched_cards(connection, owner_user_ids=owner_user_ids)
    if not rows:
        return []
    distinct_card_ids = sorted({str(row["card_id"]) for row in rows if row.get("card_id")})
    history = price_history_rows_for_cards_batched(
        connection,
        [{"key": card_id, "card_id": card_id, "pricing_mode": None} for card_id in distinct_card_ids],
        provider=provider or pricing_provider(),
        days=max(1, int(days)),
    )
    jpy_usd = _jpy_usd_rate(connection)
    points_by_card = {
        card_id: price_points_from_history_rows(history.get(card_id) or [], jpy_usd=jpy_usd)
        for card_id in distinct_card_ids
    }
    # Trimmed per printing (anchored on its own newest cell) below.
    cells_by_card = watch_printings.raw_main_cells_by_card(
        connection,
        distinct_card_ids,
        since=(
            (today - timedelta(days=watch_printings.CELL_READ_DAYS + 7)).isoformat()
            if today is not None
            else None
        ),
    )
    main_by_card = watch_printings.main_printing_keys(connection, distinct_card_ids)
    ungraded_by_card = watch_printings.ungraded_sales_by_card(connection, distinct_card_ids)
    lowest_alerted = lowest_alerted_by_watch(connection, owner_user_ids)

    baselines: list[WatchBaseline] = []
    for row in rows:
        card_id = str(row["card_id"])
        variant_key = str(row.get("variant_key") or "").strip()
        card_cells = cells_by_card.get(card_id) or {}
        main = main_by_card.get(card_id)
        card_printings = tuple(dict.fromkeys([*([main] if main else []), *sorted(card_cells)]))
        printing = variant_key or main or (
            card_printings[0] if len(card_printings) == 1 else None
        )
        cells = _trim_cells(
            watch_printings.cells_for_printing(card_cells, printing),
            days=watch_printings.CELL_READ_DAYS,
        )
        if variant_key:
            points = _cell_price_points(cells, variant_key)
        else:
            points = points_by_card.get(card_id) or ()
        newest = points[-1] if points else None
        target = row.get("target_price_cents")
        low_30d, low_days = _low_window(cells, days=NEW_LOW_WINDOW_DAYS)
        lowest_listing = cells[-1].low_cents if cells else None
        baselines.append(
            WatchBaseline(
                owner_user_id=str(row["owner_user_id"]),
                card_id=card_id,
                lane=lane,
                language=row.get("language"),
                game=row.get("game"),
                added_market_cents=_as_cents(row.get("added_market_price")),
                added_market_date=row.get("added_market_date"),
                added_source_key=None,  # legacy rows carry no lineage
                current_market_cents=newest.price_cents if newest else None,
                current_market_date=newest.price_date if newest else None,
                market_source_key=newest.source_key if newest else None,
                points=points,
                target_price_cents=int(target) if target not in (None, "") else None,
                target_triggered_at=row.get("target_triggered_at"),
                variant_key=variant_key,
                printing=printing,
                card_printings=card_printings,
                lowest_listing_cents=lowest_listing,
                low_30d_cents=low_30d,
                low_30d_days=low_days,
                liquidity=compute_liquidity(cells, ungraded_by_card.get(card_id)),
                lowest_alerted_cents=lowest_alerted.get(
                    (str(row["owner_user_id"]), card_id, variant_key)
                ),
            )
        )
    return baselines


def _trim_cells(cells: Sequence[Any], *, days: int) -> tuple[Any, ...]:
    """The trailing ``days`` of a printing's cells, anchored on its newest."""
    if not cells:
        return ()
    anchor = _parse_date(cells[-1].price_date)
    if anchor is None:
        return tuple(cells)
    cutoff = anchor - timedelta(days=int(days))
    return tuple(c for c in cells if (_parse_date(c.price_date) or anchor) >= cutoff)


def recent_alerts_for_owner(
    connection: sqlite3.Connection,
    owner_user_id: str,
    *,
    since_days: int = CARD_REARM_DAYS,
    now: datetime | None = None,
) -> list[PriorAlert]:
    """The re-arm state for one user, or [] when ``deal_alerts`` does not exist
    yet (the wiring agent adds it; nothing here breaks in the meantime)."""
    if not _table_exists(connection, "deal_alerts"):
        return []
    moment = now or datetime.now(timezone.utc)
    cutoff = (moment - timedelta(days=max(1, int(since_days)))).isoformat()
    variant = (
        "COALESCE(variant_key, '')"
        if "variant_key" in _table_columns(connection, "deal_alerts")
        else "''"
    )
    rows = connection.execute(
        f"SELECT listing_id, card_id, total_cents, created_at, {variant} AS variant_key "
        "FROM deal_alerts WHERE owner_user_id = ? AND created_at >= ? ORDER BY created_at DESC",
        (str(owner_user_id), cutoff),
    ).fetchall()
    return [
        PriorAlert(
            listing_id=str(row["listing_id"]),
            card_id=str(row["card_id"]),
            total_cents=int(row["total_cents"] or 0),
            created_at=str(row["created_at"]),
            variant_key=str(row["variant_key"] or ""),
        )
        for row in rows
    ]
