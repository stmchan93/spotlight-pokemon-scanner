"""Raw (ungraded) ACTIVE eBay listings, plus the listing-level guardrails that
decide whether a listing really is the card we asked for.

Two rules shape this module:

1. **One eBay call per `card_id`.** `item_summary/search` returns a whole page
   (up to 200) of active listings, which already covers every printing and
   condition of the card. Callers that care about a printing filter the single
   response (`filter_listings_by_variant`) instead of issuing another search.
   Fifty users watching the same card must cost one call: the app shares ONE
   ~5,000/day eBay allocation with the PDP "Lowest listed" panel.
2. **Listing-level validation only.** This module answers "is this listing this
   card, and does its price mean anything?". Whether the price is a *deal*
   against a baseline is signal-level logic and lives elsewhere.

Everything here reuses `ebay_comps` for auth, the token cache, the `_request_json`
choke point and query construction, and `recent_sales_merge` for the title-match
primitives, so there is one implementation of each.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from ebay_comps import (
    DEFAULT_BROWSE_FILTER,
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    EBAY_CONSUMER_OAUTH,
    EBAY_CONSUMER_PDP_LOWEST_LISTED,
    EBAY_CONSUMER_SOLD_COMP_ENRICHMENT,
    EBAY_CONSUMER_WATCH_SCAN,
    EBAY_CONSUMERS,
    _browse_item_image_url,
    _browse_item_price,
    _browse_item_sale_type,
    _browse_search_ready_reason,
    _build_browse_search_url,
    _build_live_search_url,
    _build_search_query,
    _call_ebay_json,
    _ebay_app_access_token,
    _ebay_marketplace_id,
    _edition_qualifiers,
    _normalize_listing_date,
    _strip_html,
    _utc_now,
    drain_ebay_usage_rows,
    ebay_usage_snapshot,
    normalize_ebay_consumer,
    record_ebay_api_call,
    record_ebay_cache_hit,
    record_ebay_error,
    reset_ebay_usage,
    set_ebay_usage_sink,
)

# Title-match primitives shared with the graded sold-comps lane. They are private
# to `recent_sales_merge` but deliberately reused: a second copy of "does this
# title name this card" would drift away from the one that has been tuned.
from recent_sales_merge import (
    _fold,
    _language_conflict,
    _name_matches,
    _number_matches,
    _set_matches,
)

__all__ = [
    "AUCTION_FINAL_WINDOW_MINUTES",
    "EBAY_CONSUMERS",
    "EBAY_CONSUMER_OAUTH",
    "EBAY_CONSUMER_PDP_LOWEST_LISTED",
    "EBAY_CONSUMER_SOLD_COMP_ENRICHMENT",
    "EBAY_CONSUMER_WATCH_SCAN",
    "DEFAULT_RAW_LISTING_LIMIT",
    "RAW_CACHE_GRADE",
    "RAW_CACHE_GRADER",
    "RAW_FETCH_PAGE_SIZE",
    "SERVABLE_VERIFICATION_TIERS",
    "auction_counts_now",
    "drain_ebay_usage_rows",
    "ebay_usage_snapshot",
    "evaluate_raw_listing",
    "fetch_raw_card_ebay_listings",
    "fetch_validated_raw_listing_candidates",
    "filter_listings_by_variant",
    "listing_is_graded",
    "listing_shipping_total",
    "listing_verification_tier",
    "normalize_ebay_consumer",
    "normalize_raw_listing",
    "raw_listings_cache_key",
    "record_ebay_api_call",
    "record_ebay_cache_hit",
    "record_ebay_error",
    "reset_ebay_usage",
    "set_ebay_usage_sink",
    "shipping_inclusive_total",
    "seller_rejection_reason",
    "title_denylist_reason",
    "title_not_a_card_reason",
    "title_worn_condition_reason",
    "validate_listing_candidates",
    "verify_raw_aspects",
    "verify_raw_title",
]

# eBay's `item_summary/search` page cap. One page per card is the whole budget.
RAW_FETCH_PAGE_SIZE = 200
# Default N returned: the whole page, because the point of the single call is
# that the caller can filter printings out of it. A display panel passes a small
# limit explicitly.
DEFAULT_RAW_LISTING_LIMIT = RAW_FETCH_PAGE_SIZE

# An auction only means something near the end. At $5 with six days left it is an
# early bid, not a price.
AUCTION_FINAL_WINDOW_MINUTES = 120

# Same tiering as the graded sold-comps lane (`recent_sales_merge`): a row is
# stored with its tier and only SERVED once it clears one. `scrydex` is listed
# for shape compatibility; the raw active lane has no Scrydex item-id list, so in
# practice a candidate is `aspects` or `title`.
SERVABLE_VERIFICATION_TIERS: frozenset[str] = frozenset({"scrydex", "aspects", "title"})

# The raw lane reuses `card_ebay_listings_cache`, whose PK is
# (card_id, grader, grade, variant). Raw rows pin the three non-card columns to
# constants so there is exactly ONE cache row per card — the dedupe, expressed in
# the key. `variant` stays '' because the single response covers every printing.
# US-located items only; see foreign_listing_reason for why.
RAW_BROWSE_FILTER = f"{DEFAULT_BROWSE_FILTER},itemLocationCountry:US"

RAW_CACHE_GRADER = "RAW"
RAW_CACHE_GRADE = "RAW"

# Phrases that mean "not a single copy of this exact card". Matched as whole
# space-delimited phrases against the folded title.
RAW_TITLE_DENYLIST_PHRASES: tuple[str, ...] = (
    "lot", "lots", "bundle", "bundles", "playset", "play set",
    "proxy", "proxies", "custom", "reprint", "reprints", "replica", "fake",
    "repack", "repacks", "mystery", "random",
    "read description", "read desc", "please read", "as is",
    "damaged", "creased", "crease", "water damage",
    "booster box", "booster pack", "booster packs", "factory sealed",
    "elite trainer", "etb", "collection box", "tin", "bulk",
    "you pick", "u pick", "pick your", "choose your", "your choice", "set of",
)
# Not a playable card at all: merch built on the card's art. The 2026-09-21
# staging review saw a $7 "Charizard 136/135 ... Novelty Keychain".
RAW_TITLE_NOT_A_CARD_PHRASES: tuple[str, ...] = (
    "keychain", "key chain", "keyring", "novelty", "sticker", "stickers",
    "magnet", "pin", "coin", "poster", "art print", "figure", "plush",
    "acrylic", "jumbo", "oversized", "oversize", "metal card", "gold plated",
    "orica", "fan art", "digital", "code card", "online code", "playmat",
    # 2026-09-23: an "Oshawott 105/086 ... Extended Art Display Case" alert.
    "display case", "extended art", "custom", "binder insert", "insert",
)
# Deliberately absent: "print", "sleeve", "binder", "display" — real singles say
# "Unlimited print", "shipped in sleeve", "straight from binder".

# Worn copies. Every deal is judged against the near-mint market price, so in
# the first staging run 9 of 17 "deals" were HP/MP/LP/DMG copies.
RAW_TITLE_WORN_CONDITION_PHRASES: tuple[str, ...] = (
    "heavily played", "moderately played", "lightly played", "played",
    "hp", "mp", "lp", "dmg", "poor", "worn", "bent", "torn", "tear",
)
# "Never played" / "not played" describe a CLEAN card.
_CONDITION_NEGATIONS: tuple[str, ...] = ("never", "not", "no", "un")

# A listing from a seller below either bar is not worth pinging anyone about:
# brand-new accounts and 0% feedback were behind the $1,700+ Umbreon "deals".
MIN_SELLER_FEEDBACK_PERCENTAGE = 95.0
MIN_SELLER_FEEDBACK_SCORE = 10

# "3x", "x 4", "12x" — a quantity, so not a single card. "1x" is fine.
_MULTIPLIER_RE = re.compile(r"\b(?:[2-9]|\d{2,})\s*x\b|\bx\s*(?:[2-9]|\d{2,})\b")

# eBay's trading-card condition taxonomy separates GRADED from UNGRADED but says
# nothing about NM/LP/MP, so a raw candidate never claims a condition grade.
_GRADED_CONDITION_IDS = {"2750"}
_GRADER_ALIAS_RE = r"(?:psa|bgs|cgc|sgc|tag|ags|ace|beckett)"
_GRADED_TITLE_RE = re.compile(
    rf"\b{_GRADER_ALIAS_RE}\s*-?\s*(?:gem\s*(?:mint|mt)\s*)?(?:10|[1-9](?:\.5)?)\b"
    r"|\bgem\s*(?:mint|mt)\s*10\b"
    r"|\bgraded\b|\bslab(?:bed)?\b|\bblack\s*label\b|\bcert(?:ification)?\s*#",
    re.IGNORECASE,
)


# --------------------------------------------------------------------------
# Listing normalization
# --------------------------------------------------------------------------


def _to_float(value: object) -> float | None:
    if value is None:
        return None
    text = str(value).replace(",", "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _listing_shipping(item: dict[str, Any]) -> tuple[float | None, str | None]:
    """`(amount, shippingCostType)`. `None` amount means eBay did not quote one
    (CALCULATED / local pickup / missing), which is NOT the same as free."""
    options = item.get("shippingOptions")
    if not isinstance(options, list):
        return None, None
    for option in options:
        if not isinstance(option, dict):
            continue
        cost_type = str(option.get("shippingCostType") or "").strip().upper() or None
        cost = option.get("shippingCost")
        amount = _to_float(cost.get("value")) if isinstance(cost, dict) else None
        if amount is not None:
            return amount, cost_type
        if cost_type:
            return None, cost_type
    return None, None


def _listing_aspects(item: dict[str, Any]) -> dict[str, str]:
    aspects: dict[str, str] = {}
    for aspect in item.get("localizedAspects") or []:
        if not isinstance(aspect, dict):
            continue
        name = str(aspect.get("name") or "").strip()
        value = str(aspect.get("value") or "").strip()
        if name and value and name not in aspects:
            aspects[name] = value
    return aspects


def normalize_raw_listing(item: dict[str, Any]) -> dict[str, Any] | None:
    """One `item_summary/search` entry -> the raw-lane listing shape."""
    if not isinstance(item, dict):
        return None
    title = _strip_html(item.get("title"))
    if not title:
        return None
    subtitle = _strip_html(item.get("subtitle"))
    if subtitle and subtitle.lower() not in title.lower():
        title = f"{title} - {subtitle}"

    price_amount, currency_code, _ = _browse_item_price(item)
    shipping_amount, shipping_type = _listing_shipping(item)
    total_amount = shipping_inclusive_total(price_amount, shipping_amount)
    bid_count = item.get("bidCount")
    try:
        bid_count = int(bid_count) if bid_count is not None else None
    except (TypeError, ValueError):
        bid_count = None

    return {
        "itemID": str(item.get("itemId") or "").strip() or None,
        "legacyItemID": str(item.get("legacyItemId") or "").strip() or None,
        "title": title,
        "itemURL": str(item.get("itemWebUrl") or item.get("itemHref") or "").strip() or None,
        "imageURL": _browse_item_image_url(item),
        "priceAmount": price_amount,
        "shippingAmount": shipping_amount,
        "shippingType": shipping_type,
        "shippingKnown": shipping_amount is not None,
        "totalAmount": total_amount,
        "currencyCode": (currency_code or "USD").upper(),
        # Where the item ships from, and the currency eBay converted the price
        # from (None when the listing is natively USD).
        "itemLocationCountry": _item_location_country(item),
        "convertedFromCurrency": _converted_from_currency(item),
        # eBay's own condition label, verbatim. Its trading-card taxonomy
        # separates graded from ungraded but has no NM/LP/MP, so we never claim
        # a raw condition match we cannot support.
        "condition": str(item.get("condition") or "").strip() or None,
        "conditionID": str(item.get("conditionId") or "").strip() or None,
        "conditionVerified": False,
        "buyingOption": _browse_item_sale_type(item),
        "auctionEndAt": str(item.get("itemEndDate") or "").strip() or None,
        "bidCount": bid_count,
        # The LISTING/creation date. Deliberately not called `soldAt`: these are
        # active listings and nothing here has sold. (`ebay_comps` still emits a
        # `soldAt` carrying this same value for its existing clients.)
        "listedAt": _normalize_listing_date(item.get("itemCreationDate") or item.get("itemOriginDate")),
        "aspects": _listing_aspects(item),
        "sellerFeedbackPercentage": _to_float(
            (item.get("seller") or {}).get("feedbackPercentage")
            if isinstance(item.get("seller"), dict)
            else None
        ),
        "sellerFeedbackScore": _to_float(
            (item.get("seller") or {}).get("feedbackScore")
            if isinstance(item.get("seller"), dict)
            else None
        ),
    }


# --------------------------------------------------------------------------
# Guardrail 1: shipping-inclusive price
# --------------------------------------------------------------------------


def shipping_inclusive_total(price_amount: object, shipping_amount: object) -> float | None:
    """A $2 card with $15 shipping is not a $2 card. Unknown shipping falls back
    to the item price alone — the caller reads `shippingKnown` before trusting it."""
    price = _to_float(price_amount)
    if price is None:
        return None
    shipping = _to_float(shipping_amount)
    if shipping is None or shipping < 0:
        return round(price, 2)
    return round(price + shipping, 2)


def listing_shipping_total(listing: dict[str, Any]) -> tuple[float | None, bool]:
    """`(shipping-inclusive total, shipping_known)` for a normalized listing."""
    shipping = listing.get("shippingAmount")
    total = shipping_inclusive_total(listing.get("priceAmount"), shipping)
    return total, shipping is not None


# --------------------------------------------------------------------------
# Guardrail 2: title / lot denylist
# --------------------------------------------------------------------------


def title_denylist_reason(title: object) -> str | None:
    """The denylisted phrase a title trips, or None. Whole-phrase match on the
    folded title so "Lotad" is not a "lot"."""
    text = _fold(title)
    if not text:
        return "empty_title"
    padded = f" {text} "
    for phrase in RAW_TITLE_DENYLIST_PHRASES:
        if f" {phrase} " in padded:
            return phrase
    match = _MULTIPLIER_RE.search(text)
    if match:
        return f"quantity:{match.group(0).strip()}"
    return None


def _item_location_country(item: dict[str, Any]) -> str | None:
    location = item.get("itemLocation")
    country = location.get("country") if isinstance(location, dict) else None
    return str(country).strip().upper() or None if country else None


def _converted_from_currency(item: dict[str, Any]) -> str | None:
    price = item.get("price")
    currency = price.get("convertedFromCurrency") if isinstance(price, dict) else None
    return str(currency).strip().upper() or None if currency else None


def foreign_listing_reason(listing: dict[str, Any]) -> str | None:
    """Why a listing is not a US listing, or None. eBay's US marketplace shows
    foreign items with the price converted to USD, so a 2026-09-22 Italian
    Blaine's Charizard read as 58% under market: exchange rate, import fees and
    a non-English condition ("Non gradata") the worn filter can't read. Unknown
    values pass (older cached pages carry neither field)."""
    country = str(listing.get("itemLocationCountry") or "").strip().upper()
    if country and country != "US":
        return f"location:{country}"
    converted = str(listing.get("convertedFromCurrency") or "").strip().upper()
    if converted and converted != "USD":
        return f"currency:{converted}"
    return None


def title_not_a_card_reason(title: object) -> str | None:
    """The merch phrase a title trips ("keychain", "sticker"…), or None."""
    padded = f" {_fold(title)} "
    for phrase in RAW_TITLE_NOT_A_CARD_PHRASES:
        if f" {phrase} " in padded:
            return phrase
    return None


def title_worn_condition_reason(title: object) -> str | None:
    """The worn-condition phrase a title states ("hp", "dmg", "played"…), or
    None. A phrase right after a negation ("never played") does not count."""
    # "/" splits too: a Copycat "... Full Art Ultra Rare MP/HP" read as one word.
    words = _fold(title).replace("/", " ").split()
    text = f" {' '.join(words)} "
    for phrase in RAW_TITLE_WORN_CONDITION_PHRASES:
        needle = f" {phrase} "
        start = text.find(needle)
        while start != -1:
            preceding = text[:start].split()
            previous = preceding[-1] if preceding else ""
            # "120 HP" is the card's hit points, not Heavily Played.
            is_hit_points = phrase == "hp" and previous.isdigit()
            if previous not in _CONDITION_NEGATIONS and not is_hit_points:
                return phrase
            start = text.find(needle, start + 1)
    return None


def seller_rejection_reason(listing: dict[str, Any]) -> str | None:
    """Why this listing's seller is too thin to trust, or None. Unknown values
    pass: eBay omits them sometimes, and the cache predates the score field."""
    percentage = _to_float(listing.get("sellerFeedbackPercentage"))
    if percentage is not None and percentage < MIN_SELLER_FEEDBACK_PERCENTAGE:
        return "low_feedback_percentage"
    score = _to_float(listing.get("sellerFeedbackScore"))
    if score is not None and score < MIN_SELLER_FEEDBACK_SCORE:
        return "low_feedback_score"
    return None


def listing_is_graded(listing: dict[str, Any]) -> bool:
    """Graded slabs are a different lane and a different price. eBay's condition
    id is authoritative when present; otherwise the title has to say so
    (grader + a grade number, "graded", "slabbed", a cert number)."""
    condition_id = str(listing.get("conditionID") or "").strip()
    if condition_id in _GRADED_CONDITION_IDS:
        return True
    condition = str(listing.get("condition") or "")
    if "graded" in condition.lower() and "ungraded" not in condition.lower():
        return True
    aspects = listing.get("aspects")
    if isinstance(aspects, dict):
        folded = {_fold(key): value for key, value in aspects.items()}
        for key in ("grade", "professional grader", "grader", "grading company", "certification number"):
            if str(folded.get(key) or "").strip():
                return True
    return bool(_GRADED_TITLE_RE.search(str(listing.get("title") or "")))


# --------------------------------------------------------------------------
# Guardrail 3: verification tier
# --------------------------------------------------------------------------


def _aspect(aspects: dict[str, str], *names: str) -> str:
    folded = {_fold(key): value for key, value in aspects.items()}
    for name in names:
        value = folded.get(_fold(name))
        if value:
            return str(value)
    return ""


def verify_raw_aspects(aspects: dict[str, str] | None, *, card: dict[str, Any]) -> bool | None:
    """True/False when eBay's item specifics can decide; None when the listing
    carries no usable specifics (fall through to the title check).

    `item_summary/search` rarely returns `localizedAspects` — this path only
    fires for listings hydrated through `getItem`."""
    if not aspects:
        return None
    number = _aspect(aspects, "Card Number", "Card #", "Number")
    if not number:
        return None
    if not _number_matches(_fold(number), card.get("number")):
        return False
    set_value = _aspect(aspects, "Set", "Expansion")
    if set_value and _set_matches(_fold(set_value), card.get("set_name") or card.get("setName")):
        return True
    name_value = _aspect(aspects, "Card Name", "Character", "Pokémon", "Pokemon")
    if name_value and _name_matches(_fold(name_value), card.get("name") or card.get("cardName")):
        return True
    return False


def verify_raw_title(title: object, *, card: dict[str, Any]) -> bool:
    """The title has to name the card AND its collector number AND its set, with
    no denylisted words and no language contradiction."""
    text = _fold(title)
    if not text or _language_conflict(text, card):
        return False
    return (
        _name_matches(text, card.get("name") or card.get("cardName"))
        and _number_matches(text, card.get("number"))
        and _set_matches(text, card.get("set_name") or card.get("setName"))
    )


def listing_verification_tier(listing: dict[str, Any], *, card: dict[str, Any]) -> str:
    """`aspects` | `title` | `unverified`. Only the first two are servable."""
    aspects = listing.get("aspects")
    by_aspects = verify_raw_aspects(aspects if isinstance(aspects, dict) else None, card=card)
    if by_aspects is True:
        return "aspects"
    if by_aspects is False:
        return "unverified"
    return "title" if verify_raw_title(listing.get("title"), card=card) else "unverified"


# --------------------------------------------------------------------------
# Guardrail 4: auction window
# --------------------------------------------------------------------------


def _parse_iso_datetime(value: object) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def auction_minutes_remaining(listing: dict[str, Any], *, now: datetime | None = None) -> float | None:
    end_at = _parse_iso_datetime(listing.get("auctionEndAt"))
    if end_at is None:
        return None
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    return round((end_at - reference).total_seconds() / 60.0, 2)


def auction_counts_now(listing: dict[str, Any], *, now: datetime | None = None) -> bool:
    """Fixed price always counts. An auction counts only inside its final
    AUCTION_FINAL_WINDOW_MINUTES: an auction at $5 with six days left is an early
    bid, not a price. An auction with no end date cannot be judged, so it is out."""
    if str(listing.get("buyingOption") or "").strip().lower() != "auction":
        return True
    remaining = auction_minutes_remaining(listing, now=now)
    if remaining is None:
        return False
    return 0 <= remaining <= AUCTION_FINAL_WINDOW_MINUTES


# --------------------------------------------------------------------------
# Candidate assembly
# --------------------------------------------------------------------------


def evaluate_raw_listing(
    listing: dict[str, Any],
    *,
    card: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, Any]:
    """Run every listing-level guardrail. Returns
    `{"ok": bool, "reason": str | None, "candidate": dict | None}`; `reason`
    names the first rule that rejected it, for logging and for tuning."""
    title = str(listing.get("title") or "").strip()
    price_amount = _to_float(listing.get("priceAmount"))
    if not title:
        return {"ok": False, "reason": "missing_title", "candidate": None}
    if price_amount is None or price_amount <= 0:
        return {"ok": False, "reason": "missing_price", "candidate": None}

    denylisted = title_denylist_reason(title)
    if denylisted:
        return {"ok": False, "reason": f"denylist:{denylisted}", "candidate": None}
    not_a_card = title_not_a_card_reason(title)
    if not_a_card:
        return {"ok": False, "reason": f"not_a_card:{not_a_card}", "candidate": None}
    worn = title_worn_condition_reason(title)
    if worn:
        return {"ok": False, "reason": f"worn_condition:{worn}", "candidate": None}
    seller = seller_rejection_reason(listing)
    if seller:
        return {"ok": False, "reason": f"seller:{seller}", "candidate": None}
    foreign = foreign_listing_reason(listing)
    if foreign:
        return {"ok": False, "reason": f"foreign_listing:{foreign}", "candidate": None}
    if listing_is_graded(listing):
        return {"ok": False, "reason": "graded_listing", "candidate": None}

    tier = listing_verification_tier(listing, card=card)
    if tier not in SERVABLE_VERIFICATION_TIERS:
        return {"ok": False, "reason": "unverified", "candidate": None}

    buying_option = str(listing.get("buyingOption") or "").strip().lower() or "fixed_price"
    if not auction_counts_now(listing, now=now):
        return {"ok": False, "reason": "auction_outside_final_window", "candidate": None}

    total_amount, shipping_known = listing_shipping_total(listing)
    candidate = {
        "cardID": str(card.get("id") or "").strip() or None,
        "itemID": listing.get("itemID"),
        "legacyItemID": listing.get("legacyItemID"),
        "title": title,
        "itemURL": listing.get("itemURL"),
        "imageURL": listing.get("imageURL"),
        "priceAmount": price_amount,
        "shippingAmount": _to_float(listing.get("shippingAmount")),
        "shippingKnown": shipping_known,
        "totalAmount": total_amount,
        "currencyCode": str(listing.get("currencyCode") or "USD").upper(),
        "buyingOption": buying_option,
        "auctionEndAt": listing.get("auctionEndAt"),
        "auctionMinutesRemaining": auction_minutes_remaining(listing, now=now),
        "bidCount": listing.get("bidCount"),
        # Listing creation date, NOT a sale date.
        "listedAt": listing.get("listedAt"),
        "condition": listing.get("condition"),
        "conditionID": listing.get("conditionID"),
        # eBay's taxonomy has no NM/LP/MP for raw cards; never claim otherwise.
        "conditionVerified": False,
        "verification": tier,
        "isGraded": False,
        "sellerFeedbackPercentage": listing.get("sellerFeedbackPercentage"),
        "sellerFeedbackScore": listing.get("sellerFeedbackScore"),
    }
    return {"ok": True, "reason": None, "candidate": candidate}


def validate_listing_candidates(
    listings: Iterable[dict[str, Any]],
    *,
    card: dict[str, Any],
    now: datetime | None = None,
    limit: int | None = None,
    include_rejected: bool = False,
) -> list[dict[str, Any]] | tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Normalized listings -> validated listing candidates, cheapest
    shipping-inclusive first. With `include_rejected`, also returns
    `[{"itemID", "title", "reason"}]` so a rejection can be explained."""
    candidates: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for listing in listings or []:
        if not isinstance(listing, dict):
            continue
        verdict = evaluate_raw_listing(listing, card=card, now=now)
        if not verdict["ok"]:
            rejected.append(
                {
                    "itemID": listing.get("itemID"),
                    "title": listing.get("title"),
                    "reason": verdict["reason"],
                }
            )
            continue
        candidate = verdict["candidate"]
        key = str(candidate.get("itemID") or candidate.get("legacyItemID") or candidate.get("itemURL") or "")
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        candidates.append(candidate)
    candidates.sort(key=lambda row: (row["totalAmount"], row["priceAmount"]))
    if limit is not None:
        candidates = candidates[: max(0, int(limit))]
    if include_rejected:
        return candidates, rejected
    return candidates


def filter_listings_by_variant(
    listings: Iterable[dict[str, Any]],
    variant: str | None,
) -> list[dict[str, Any]]:
    """Printing filter applied to the SINGLE per-card response — this is why one
    call serves every printing. Mirrors `_edition_qualifiers`: a First Edition
    printing keeps only titles that say so, Unlimited keeps only those that do
    not, anything else (modern Holofoil/Normal) keeps everything."""
    rows = [row for row in listings or [] if isinstance(row, dict)]
    positive, negative = _edition_qualifiers(variant)
    if not positive and not negative:
        return rows

    def says_first_edition(row: dict[str, Any]) -> bool:
        text = _fold(row.get("title"))
        return "1st edition" in text or "first edition" in text

    if positive:
        return [row for row in rows if says_first_edition(row)]
    return [row for row in rows if not says_first_edition(row)]


def raw_listings_cache_key(card_id: str) -> tuple[str, str, str, str]:
    """The `card_ebay_listings_cache` PK for the raw lane. Grader/grade/variant
    are pinned constants so there is ONE row — and therefore one call — per card,
    no matter how many printings, conditions or users are interested."""
    return (str(card_id or "").strip(), RAW_CACHE_GRADER, RAW_CACHE_GRADE, "")


# --------------------------------------------------------------------------
# Fetch
# --------------------------------------------------------------------------


def _unavailable_raw_payload(
    *,
    card: dict[str, Any],
    fetched_at: str,
    search_query: str,
    search_url: str,
    status_reason: str,
    unavailable_reason: str,
    consumer: str,
    error_type: str | None = None,
    error_message: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "cardID": str(card.get("id") or "").strip() or None,
        "cardName": str(card.get("name") or card.get("cardName") or "").strip() or None,
        "setName": str(card.get("setName") or card.get("set_name") or "").strip() or None,
        "number": str(card.get("number") or "").strip() or None,
        "source": "ebay",
        "lane": "raw",
        "status": "unavailable",
        "statusReason": status_reason,
        "unavailableReason": unavailable_reason,
        "listings": [],
        "listingCount": 0,
        "currencyCode": "USD",
        "fetchedAt": fetched_at,
        "searchURL": search_url,
        "searchQuery": search_query,
        "consumer": consumer,
        "error": None,
    }
    if error_type and error_message:
        payload["error"] = {"type": error_type, "message": error_message}
    return payload


def fetch_raw_card_ebay_listings(
    card: dict[str, Any],
    *,
    limit: int = DEFAULT_RAW_LISTING_LIMIT,
    fetch_json: Callable[..., dict[str, Any]] | None = None,
    timeout_seconds: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    consumer: str = EBAY_CONSUMER_WATCH_SCAN,
) -> dict[str, Any]:
    """The raw (ungraded) counterpart to `fetch_graded_card_ebay_comps`.

    ONE `item_summary/search` call per card: the query carries no grader, no
    grade, no printing and no condition, so the single response covers every
    printing and condition of the card and callers filter it locally.

    Returns the lowest `limit` listings by shipping-inclusive total."""
    normalized_consumer = normalize_ebay_consumer(consumer)
    try:
        normalized_limit = int(limit)
    except (TypeError, ValueError):
        normalized_limit = DEFAULT_RAW_LISTING_LIMIT
    normalized_limit = max(1, min(normalized_limit, RAW_FETCH_PAGE_SIZE))

    fetched_at = _utc_now()
    # No grader/grade/variant: this is the per-CARD query, shared by every
    # printing and condition, which is what makes one call enough.
    search_query = _build_search_query(card, grader="", selected_grade=None, variant=None)
    search_url = _build_live_search_url(search_query, limit=min(normalized_limit, 100))

    ready_reason = _browse_search_ready_reason()
    if ready_reason is not None:
        reason = (
            "eBay active listings are disabled in this environment."
            if ready_reason == "browse_disabled"
            else "eBay active listing credentials are not configured."
        )
        return _unavailable_raw_payload(
            card=card,
            fetched_at=fetched_at,
            search_query=search_query,
            search_url=search_url,
            status_reason=ready_reason,
            unavailable_reason=reason,
            consumer=normalized_consumer,
        )

    try:
        access_token = _ebay_app_access_token(timeout_seconds=timeout_seconds, request_json=fetch_json)
    except Exception as error:  # noqa: BLE001
        return _unavailable_raw_payload(
            card=card,
            fetched_at=fetched_at,
            search_query=search_query,
            search_url=search_url,
            status_reason="fetch_failed",
            unavailable_reason="The backend could not authenticate with eBay Browse.",
            consumer=normalized_consumer,
            error_type=type(error).__name__,
            error_message=str(error),
        )

    marketplace_id = _ebay_marketplace_id()
    browse_url = _build_browse_search_url(
        search_query,
        # Always pull the full page: a second call to see more printings is the
        # exact cost we are avoiding.
        limit=RAW_FETCH_PAGE_SIZE,
        marketplace_id=marketplace_id,
        max_page_size=RAW_FETCH_PAGE_SIZE,
        filter_expression=RAW_BROWSE_FILTER,
    )
    headers = {
        "Authorization": f"Bearer {access_token}",
        "X-EBAY-C-MARKETPLACE-ID": marketplace_id,
    }
    try:
        payload = _call_ebay_json(
            fetch_json,
            browse_url,
            consumer=normalized_consumer,
            headers=headers,
            timeout_seconds=timeout_seconds,
        )
    except Exception as error:  # noqa: BLE001
        return _unavailable_raw_payload(
            card=card,
            fetched_at=fetched_at,
            search_query=search_query,
            search_url=search_url,
            status_reason="fetch_failed",
            unavailable_reason="The backend could not reach eBay Browse.",
            consumer=normalized_consumer,
            error_type=type(error).__name__,
            error_message=str(error),
        )

    summaries = payload.get("itemSummaries")
    listings: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in summaries if isinstance(summaries, list) else []:
        listing = normalize_raw_listing(item)
        if listing is None:
            continue
        key = str(listing.get("itemID") or listing.get("legacyItemID") or listing.get("itemURL") or "")
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        listings.append(listing)

    # eBay sorts by item price; the honest order is by shipping-inclusive total.
    listings.sort(
        key=lambda row: (
            row["totalAmount"] if row["totalAmount"] is not None else float("inf"),
            row["priceAmount"] if row["priceAmount"] is not None else float("inf"),
        )
    )
    listings = listings[:normalized_limit]

    currency_code = next(
        (str(row.get("currencyCode") or "").strip() for row in listings if row.get("currencyCode")),
        "USD",
    )
    return {
        "cardID": str(card.get("id") or "").strip() or None,
        "cardName": str(card.get("name") or card.get("cardName") or "").strip() or None,
        "setName": str(card.get("setName") or card.get("set_name") or "").strip() or None,
        "number": str(card.get("number") or "").strip() or None,
        "source": "ebay",
        "lane": "raw",
        "status": "available",
        "statusReason": None if listings else "no_results",
        "error": None,
        "listings": listings,
        "listingCount": len(listings),
        "currencyCode": currency_code or "USD",
        "fetchedAt": fetched_at,
        "searchURL": search_url,
        "searchQuery": search_query,
        "marketplaceID": marketplace_id,
        "consumer": normalized_consumer,
    }


def fetch_validated_raw_listing_candidates(
    card: dict[str, Any],
    *,
    limit: int | None = None,
    variant: str | None = None,
    now: datetime | None = None,
    fetch_json: Callable[..., dict[str, Any]] | None = None,
    timeout_seconds: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    consumer: str = EBAY_CONSUMER_WATCH_SCAN,
) -> dict[str, Any]:
    """Fetch once, then validate — the shape the signal lane consumes. `variant`
    filters the SINGLE response locally; it never changes the query or the call
    count."""
    payload = fetch_raw_card_ebay_listings(
        card,
        fetch_json=fetch_json,
        timeout_seconds=timeout_seconds,
        consumer=consumer,
    )
    listings = payload.get("listings") if payload.get("status") == "available" else []
    listings = filter_listings_by_variant(listings or [], variant)
    candidates, rejected = validate_listing_candidates(
        listings,
        card=card,
        now=now,
        limit=limit,
        include_rejected=True,
    )
    payload["candidates"] = candidates
    payload["candidateCount"] = len(candidates)
    payload["rejected"] = rejected
    payload["variant"] = str(variant or "").strip() or None
    return payload
