"""Raw (ungraded) active-listing lane: query construction, the listing-level
guardrails, the one-call-per-card dedupe, and per-consumer call accounting.

Every eBay call in here goes through an injected mock transport — this suite
never touches the network.
"""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from ebay_comps import _reset_ebay_token_cache  # noqa: E402
from ebay_listings import (  # noqa: E402
    AUCTION_FINAL_WINDOW_MINUTES,
    EBAY_CONSUMER_OAUTH,
    EBAY_CONSUMER_PDP_LOWEST_LISTED,
    EBAY_CONSUMER_WATCH_SCAN,
    RAW_CACHE_GRADE,
    RAW_CACHE_GRADER,
    RAW_FETCH_PAGE_SIZE,
    auction_counts_now,
    drain_ebay_usage_rows,
    ebay_usage_snapshot,
    evaluate_raw_listing,
    fetch_raw_card_ebay_listings,
    fetch_validated_raw_listing_candidates,
    filter_listings_by_variant,
    listing_is_graded,
    listing_shipping_total,
    listing_verification_tier,
    normalize_raw_listing,
    raw_listings_cache_key,
    record_ebay_cache_hit,
    reset_ebay_usage,
    set_ebay_usage_sink,
    seller_rejection_reason,
    shipping_inclusive_total,
    title_denylist_reason,
    title_not_a_card_reason,
    title_worn_condition_reason,
    validate_listing_candidates,
)

CARD = {
    "id": "gym1-60",
    "name": "Sabrina's Slowbro",
    "setName": "Gym Heroes",
    "number": "60/132",
}

BROWSE_ENV = {
    "SPOTLIGHT_EBAY_BROWSE_ENABLED": "1",
    "EBAY_CLIENT_ID": "client-id",
    "EBAY_CLIENT_SECRET": "client-secret",
    "EBAY_MARKETPLACE_ID": "EBAY_US",
}

NOW = datetime(2026, 9, 19, 12, 0, 0, tzinfo=timezone.utc)


def summary(
    *,
    item_id: str = "v1|1|0",
    title: str = "Sabrina's Slowbro Gym Heroes 60/132 Pokemon Card",
    price: str = "10.00",
    shipping: str | None = "0.00",
    shipping_cost_type: str | None = "FIXED",
    buying_options: tuple[str, ...] = ("FIXED_PRICE",),
    end_date: str | None = None,
    condition: str = "Ungraded",
    condition_id: str = "4000",
    aspects: list[dict[str, str]] | None = None,
) -> dict[str, object]:
    """An `item_summary/search` entry, shaped the way eBay Browse returns them."""
    item: dict[str, object] = {
        "itemId": item_id,
        "legacyItemId": item_id.split("|")[1] if "|" in item_id else item_id,
        "title": title,
        "price": {"value": price, "currency": "USD"},
        "itemWebUrl": f"https://www.ebay.com/itm/{item_id.split('|')[1] if '|' in item_id else item_id}",
        "buyingOptions": list(buying_options),
        "itemCreationDate": "2026-09-01T07:14:44.000Z",
        "condition": condition,
        "conditionId": condition_id,
        "image": {"imageUrl": "https://i.ebayimg.com/images/g/abc/s-l1600.jpg"},
    }
    if shipping is not None or shipping_cost_type is not None:
        option: dict[str, object] = {}
        if shipping_cost_type is not None:
            option["shippingCostType"] = shipping_cost_type
        if shipping is not None:
            option["shippingCost"] = {"value": shipping, "currency": "USD"}
        item["shippingOptions"] = [option]
    if end_date is not None:
        item["itemEndDate"] = end_date
    if aspects is not None:
        item["localizedAspects"] = aspects
    return item


def listing(**overrides: object) -> dict[str, object]:
    """A NORMALIZED raw listing (what the guardrails consume)."""
    row = normalize_raw_listing(summary())
    assert row is not None
    row.update(overrides)
    return row


class _Transport:
    """Injected mock transport. Records every URL it is asked for; raises on any
    URL the raw lane is not supposed to hit."""

    def __init__(self, summaries: list[dict[str, object]] | None = None) -> None:
        self.summaries = summaries if summaries is not None else [summary()]
        self.urls: list[str] = []

    @property
    def token_calls(self) -> int:
        return sum(1 for url in self.urls if "identity/v1/oauth2/token" in url)

    @property
    def search_calls(self) -> int:
        return sum(1 for url in self.urls if "buy/browse/v1/item_summary/search" in url)

    def __call__(self, url: str, **kwargs: object) -> dict[str, object]:
        self.urls.append(url)
        if "identity/v1/oauth2/token" in url:
            return {"access_token": "token-value", "expires_in": 7200}
        if "buy/browse/v1/item_summary/search" in url:
            return {"itemSummaries": self.summaries}
        raise AssertionError(f"Unexpected URL: {url}")


class RawListingTestCase(unittest.TestCase):
    def setUp(self) -> None:
        _reset_ebay_token_cache()
        reset_ebay_usage()
        set_ebay_usage_sink(None)

    def tearDown(self) -> None:
        _reset_ebay_token_cache()
        reset_ebay_usage()
        set_ebay_usage_sink(None)


# --------------------------------------------------------------------------
# Query construction + the one-call-per-card dedupe
# --------------------------------------------------------------------------


class RawQueryTests(RawListingTestCase):
    def test_query_is_per_card_with_no_grade_and_no_printing(self) -> None:
        transport = _Transport()
        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            payload = fetch_raw_card_ebay_listings(CARD, fetch_json=transport)

        self.assertEqual(payload["status"], "available")
        self.assertEqual(payload["searchQuery"], "Sabrina's Slowbro Gym Heroes 60/132")
        # The whole point: nothing grade- or printing-specific in the query, so
        # the one response covers every printing and condition.
        for token in ("PSA", "1st Edition", "Unlimited"):
            self.assertNotIn(token, payload["searchQuery"])

    def test_browse_url_pulls_a_full_page_sorted_by_price(self) -> None:
        transport = _Transport()
        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            fetch_raw_card_ebay_listings(CARD, limit=5, fetch_json=transport)

        search_url = next(url for url in transport.urls if "item_summary/search" in url)
        self.assertIn(f"limit={RAW_FETCH_PAGE_SIZE}", search_url)
        self.assertIn("sort=price", search_url)
        self.assertIn("priceCurrency%3AUSD", search_url)
        self.assertIn("itemLocationCountry%3AUS", search_url)

    def test_limit_returns_lowest_n_by_shipping_inclusive_total(self) -> None:
        transport = _Transport(
            [
                summary(item_id="v1|1|0", price="2.00", shipping="15.00"),
                summary(item_id="v1|2|0", price="12.00", shipping="0.00"),
                summary(item_id="v1|3|0", price="30.00", shipping="0.00"),
            ]
        )
        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            payload = fetch_raw_card_ebay_listings(CARD, limit=2, fetch_json=transport)

        self.assertEqual(payload["listingCount"], 2)
        # $12 + free beats $2 + $15, even though eBay sorted the $2 one first.
        self.assertEqual([row["itemID"] for row in payload["listings"]], ["v1|2|0", "v1|1|0"])
        self.assertEqual([row["totalAmount"] for row in payload["listings"]], [12.0, 17.0])

    def test_one_call_per_card_serves_every_printing(self) -> None:
        transport = _Transport(
            [
                summary(item_id="v1|1|0", title="Sabrina's Slowbro 1st Edition Gym Heroes 60/132", price="40.00"),
                summary(item_id="v1|2|0", title="Sabrina's Slowbro Gym Heroes 60/132 Unlimited", price="10.00"),
            ]
        )
        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            payload = fetch_raw_card_ebay_listings(CARD, fetch_json=transport)

        first_edition = filter_listings_by_variant(payload["listings"], "1st Edition Holofoil")
        unlimited = filter_listings_by_variant(payload["listings"], "Unlimited Holofoil")
        modern = filter_listings_by_variant(payload["listings"], "Holofoil")

        self.assertEqual([row["itemID"] for row in first_edition], ["v1|1|0"])
        self.assertEqual([row["itemID"] for row in unlimited], ["v1|2|0"])
        self.assertEqual(len(modern), 2)
        # Three printings answered from ONE search call. 50 watchers, one call.
        self.assertEqual(transport.search_calls, 1)

    def test_cache_key_has_no_variant_or_condition(self) -> None:
        self.assertEqual(
            raw_listings_cache_key("gym1-60"),
            ("gym1-60", RAW_CACHE_GRADER, RAW_CACHE_GRADE, ""),
        )

    def test_unavailable_when_browse_disabled_makes_no_call(self) -> None:
        transport = _Transport()
        with patch.dict(os.environ, {**BROWSE_ENV, "SPOTLIGHT_EBAY_BROWSE_ENABLED": "0"}, clear=False):
            payload = fetch_raw_card_ebay_listings(CARD, fetch_json=transport)

        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["statusReason"], "browse_disabled")
        self.assertEqual(payload["listings"], [])
        self.assertEqual(transport.urls, [])


# --------------------------------------------------------------------------
# Guardrail 1 — shipping-inclusive price
# --------------------------------------------------------------------------


class ShippingInclusiveTests(RawListingTestCase):
    def test_total_adds_shipping(self) -> None:
        self.assertEqual(shipping_inclusive_total("2.00", "15.00"), 17.0)

    def test_free_shipping_is_not_unknown_shipping(self) -> None:
        total, known = listing_shipping_total(listing(priceAmount=12.0, shippingAmount=0.0))
        self.assertEqual(total, 12.0)
        self.assertTrue(known)

    def test_unknown_shipping_falls_back_to_price_and_is_flagged(self) -> None:
        row = normalize_raw_listing(summary(shipping=None, shipping_cost_type="CALCULATED"))
        self.assertIsNone(row["shippingAmount"])
        self.assertFalse(row["shippingKnown"])
        self.assertEqual(row["totalAmount"], 10.0)

        verdict = evaluate_raw_listing(row, card=CARD, now=NOW)
        self.assertTrue(verdict["ok"])
        self.assertFalse(verdict["candidate"]["shippingKnown"])

    def test_cheap_card_with_absurd_shipping_ranks_behind_a_dearer_one(self) -> None:
        rows = [
            listing(itemID="cheap-but-shipped", priceAmount=2.0, shippingAmount=15.0, totalAmount=17.0),
            listing(itemID="dearer-free-ship", priceAmount=12.0, shippingAmount=0.0, totalAmount=12.0),
        ]
        candidates = validate_listing_candidates(rows, card=CARD, now=NOW)
        self.assertEqual([row["itemID"] for row in candidates], ["dearer-free-ship", "cheap-but-shipped"])

    def test_missing_price_is_rejected(self) -> None:
        verdict = evaluate_raw_listing(listing(priceAmount=None), card=CARD, now=NOW)
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["reason"], "missing_price")


# --------------------------------------------------------------------------
# Guardrail 2 — title / lot denylist
# --------------------------------------------------------------------------


class TitleDenylistTests(RawListingTestCase):
    def test_denylisted_titles(self) -> None:
        cases = {
            "Pokemon Card LOT of 50 Gym Heroes": "lot",
            "Gym Heroes Bundle Sabrina's Slowbro": "bundle",
            "Sabrina's Slowbro Playset Gym Heroes": "playset",
            "Sabrina's Slowbro PROXY Gym Heroes 60/132": "proxy",
            "Custom Sabrina's Slowbro Gym Heroes": "custom",
            "Sabrina's Slowbro Gym Heroes - read description": "read description",
            "Gym Heroes Booster Pack Sealed": "booster pack",
            "Mystery Pokemon Repack": "repack",
            "You Pick Gym Heroes Singles": "you pick",
        }
        for title, expected in cases.items():
            with self.subTest(title=title):
                self.assertEqual(title_denylist_reason(title), expected)

    def test_clean_single_card_title_passes(self) -> None:
        self.assertIsNone(title_denylist_reason("Sabrina's Slowbro Gym Heroes 60/132 Pokemon Card NM"))

    def test_denylist_matches_whole_words_only(self) -> None:
        # "Lotad" is a Pokemon, not a lot.
        self.assertIsNone(title_denylist_reason("Lotad 43/108 Pokemon Card"))

    def test_quantity_multiplier_is_a_quantity_not_a_single(self) -> None:
        self.assertEqual(title_denylist_reason("3x Sabrina's Slowbro Gym Heroes"), "quantity:3x")
        self.assertEqual(title_denylist_reason("Sabrina's Slowbro x 4"), "quantity:x 4")
        self.assertIsNone(title_denylist_reason("1x Sabrina's Slowbro Gym Heroes 60/132"))

    def test_denylisted_listing_is_rejected_with_its_reason(self) -> None:
        verdict = evaluate_raw_listing(
            listing(title="Pokemon LOT Sabrina's Slowbro Gym Heroes 60/132"),
            card=CARD,
            now=NOW,
        )
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["reason"], "denylist:lot")

    # Titles below are verbatim from the 2026-09-21 staging first run, where
    # 11 of 17 alerts were worn copies, thin sellers, or merch.
    def test_worn_copies_are_named_by_their_condition(self) -> None:
        cases = {
            "Raichu Base Set Holo Rare 14/102 English 1999 Wizards (HP)": "hp",
            "Raichu 14/102 Base Set Unlimited Holo Rare Pokemon WOTC 1999 Played": "played",
            "Blaine's Charizard Holo English Gym Challenge 2/132 DMG": "dmg",
            "Pokémon TCG Rayquaza v Evolving Skies Card 194/203 LP": "lp",
            "Umbreon VMAX (Alternate Art Secret, #215/203) - SWSH - Evolving Skies MP Pokemon": "mp",
            "M Charizard EX (Full Art) 101/108 Evolutions HP+": "hp",
            "Sabrina's Slowbro Gym Heroes 60/132 Lightly Played": "lightly played",
        }
        for title, expected in cases.items():
            with self.subTest(title=title):
                self.assertEqual(title_worn_condition_reason(title), expected)

    def test_clean_titles_are_not_mistaken_for_worn_ones(self) -> None:
        for title in (
            "Charizard 136/135 Holo Secret Rare Plasma Storm Pokemon",
            "Sabrina's Slowbro Gym Heroes 60/132 Never Played Pack Fresh",
            "Charizard 120 HP Base Set 4/102 Holo",
            "Alakazam 1/102 Base Set Holo",
        ):
            with self.subTest(title=title):
                self.assertIsNone(title_worn_condition_reason(title))

    def test_merch_is_not_a_card(self) -> None:
        self.assertEqual(
            title_not_a_card_reason("Pokémon Plasma Storm Charizard 136/135 2012 Secret Rare Card Novelty Keychain"),
            "keychain",
        )
        self.assertEqual(title_not_a_card_reason("Charizard 136/135 sticker"), "sticker")
        # Real singles are routinely described like this.
        for title in (
            "Charizard 4/102 Unlimited Print Holo",
            "Pinsir 9/64 Jungle Holo shipped in sleeve",
            "Blastoise 2/102 straight from binder",
        ):
            with self.subTest(title=title):
                self.assertIsNone(title_not_a_card_reason(title))

    def test_slash_joined_conditions_are_read_word_by_word(self) -> None:
        self.assertEqual(
            title_worn_condition_reason(
                "Pokemon Sun & Moon Celestial Storm Copycat 163/168 Full Art Ultra Rare MP/HP"
            ),
            "hp",
        )
        self.assertIsNone(title_worn_condition_reason("Copycat 163/168 Full Art NM/M"))

    def test_binder_inserts_are_not_cards(self) -> None:
        self.assertEqual(
            title_not_a_card_reason(
                "Pokemon Origin Forme Dialga V 177/189 Astral Radiance Extended Art Binder Insert"
            ),
            "extended art",
        )
        self.assertEqual(title_not_a_card_reason("Dialga V 177/189 binder insert"), "binder insert")

    def test_display_cases_and_customs_are_not_cards(self) -> None:
        self.assertEqual(
            title_not_a_card_reason("Oshawott 105/086 Pokémon Card Extended Art Display Case White Flare"),
            "display case",
        )
        self.assertEqual(title_not_a_card_reason("Umbreon VMAX custom card"), "custom")
        self.assertIsNone(title_not_a_card_reason("Umbreon VMAX 215/203 no customs fees"))

    def test_foreign_listings_are_rejected_and_unknown_location_passes(self) -> None:
        # 2026-09-22: an Italian Blaine's Charizard, priced in EUR and shown
        # converted, read as 58% under market.
        italian = summary(item_id="v1|137060657229|0")
        italian["itemLocation"] = {"country": "IT"}
        italian["price"] = {
            "value": "227.84", "currency": "USD",
            "convertedFromValue": "194.00", "convertedFromCurrency": "EUR",
        }
        row = normalize_raw_listing(italian)
        self.assertEqual((row["itemLocationCountry"], row["convertedFromCurrency"]), ("IT", "EUR"))
        self.assertEqual(
            evaluate_raw_listing(row, card=CARD, now=NOW)["reason"], "foreign_listing:location:IT"
        )
        self.assertEqual(
            evaluate_raw_listing(listing(convertedFromCurrency="GBP"), card=CARD, now=NOW)["reason"],
            "foreign_listing:currency:GBP",
        )
        self.assertTrue(evaluate_raw_listing(listing(itemLocationCountry="US"), card=CARD, now=NOW)["ok"])
        cached = listing()
        cached.pop("itemLocationCountry", None)
        cached.pop("convertedFromCurrency", None)
        self.assertTrue(evaluate_raw_listing(cached, card=CARD, now=NOW)["ok"])

    def test_thin_sellers_are_rejected_and_unknown_sellers_pass(self) -> None:
        self.assertEqual(
            seller_rejection_reason({"sellerFeedbackPercentage": 0.0}), "low_feedback_percentage"
        )
        self.assertEqual(
            seller_rejection_reason({"sellerFeedbackPercentage": 100.0, "sellerFeedbackScore": 3}),
            "low_feedback_score",
        )
        self.assertIsNone(seller_rejection_reason({"sellerFeedbackPercentage": 99.4, "sellerFeedbackScore": 812}))
        self.assertIsNone(seller_rejection_reason({}))

    def test_worn_listing_is_rejected_with_its_reason(self) -> None:
        verdict = evaluate_raw_listing(
            listing(title="Sabrina's Slowbro Gym Heroes 60/132 DMG"),
            card=CARD,
            now=NOW,
        )
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["reason"], "worn_condition:dmg")

    def test_zero_feedback_seller_listing_is_rejected(self) -> None:
        verdict = evaluate_raw_listing(
            listing(sellerFeedbackPercentage=0.0),
            card=CARD,
            now=NOW,
        )
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["reason"], "seller:low_feedback_percentage")

    def test_graded_slabs_do_not_belong_to_the_raw_lane(self) -> None:
        by_title = listing(title="PSA 9 Sabrina's Slowbro Gym Heroes 60/132")
        by_condition = listing(condition="Graded", conditionID="2750")
        self.assertTrue(listing_is_graded(by_title))
        self.assertTrue(listing_is_graded(by_condition))
        self.assertFalse(listing_is_graded(listing()))
        self.assertEqual(evaluate_raw_listing(by_condition, card=CARD, now=NOW)["reason"], "graded_listing")


# --------------------------------------------------------------------------
# Guardrail 3 — verification tier
# --------------------------------------------------------------------------


class VerificationTierTests(RawListingTestCase):
    def test_title_naming_card_number_and_set_is_the_title_tier(self) -> None:
        self.assertEqual(listing_verification_tier(listing(), card=CARD), "title")

    def test_title_missing_the_set_is_unverified(self) -> None:
        row = listing(title="Sabrina's Slowbro 60/132 Pokemon Card")
        self.assertEqual(listing_verification_tier(row, card=CARD), "unverified")

    def test_title_naming_a_different_card_is_unverified(self) -> None:
        row = listing(title="Sabrina's Gengar Gym Heroes 20/132")
        self.assertEqual(listing_verification_tier(row, card=CARD), "unverified")

    def test_item_specifics_outrank_the_title(self) -> None:
        row = normalize_raw_listing(
            summary(
                title="Slowbro card gym set nice condition",
                aspects=[
                    {"name": "Card Number", "value": "60/132"},
                    {"name": "Set", "value": "Gym Heroes"},
                ],
            )
        )
        self.assertEqual(listing_verification_tier(row, card=CARD), "aspects")

    def test_item_specifics_that_disagree_reject_outright(self) -> None:
        row = normalize_raw_listing(
            summary(
                title="Sabrina's Slowbro Gym Heroes 60/132",
                aspects=[
                    {"name": "Card Number", "value": "12/132"},
                    {"name": "Set", "value": "Gym Heroes"},
                ],
            )
        )
        self.assertEqual(listing_verification_tier(row, card=CARD), "unverified")

    def test_unverified_listings_are_not_served(self) -> None:
        rows = [listing(itemID="ok"), listing(itemID="vague", title="Pokemon card holo rare vintage")]
        candidates, rejected = validate_listing_candidates(
            rows, card=CARD, now=NOW, include_rejected=True
        )
        self.assertEqual([row["itemID"] for row in candidates], ["ok"])
        self.assertEqual([row["reason"] for row in rejected], ["unverified"])


# --------------------------------------------------------------------------
# Guardrail 4 — auction window
# --------------------------------------------------------------------------


def _auction(minutes_from_now: float | None, **overrides: object) -> dict[str, object]:
    end_at = None if minutes_from_now is None else (NOW + timedelta(minutes=minutes_from_now)).isoformat()
    return listing(buyingOption="auction", auctionEndAt=end_at, **overrides)


class AuctionWindowTests(RawListingTestCase):
    def test_fixed_price_always_counts(self) -> None:
        self.assertTrue(auction_counts_now(listing(buyingOption="fixed_price"), now=NOW))

    def test_auction_with_six_days_left_is_an_early_bid_not_a_deal(self) -> None:
        self.assertFalse(auction_counts_now(_auction(6 * 24 * 60), now=NOW))

    def test_auction_inside_the_final_window_counts(self) -> None:
        self.assertTrue(auction_counts_now(_auction(AUCTION_FINAL_WINDOW_MINUTES - 1), now=NOW))

    def test_auction_exactly_at_the_window_edge_counts(self) -> None:
        self.assertTrue(auction_counts_now(_auction(AUCTION_FINAL_WINDOW_MINUTES), now=NOW))

    def test_auction_that_already_ended_does_not_count(self) -> None:
        self.assertFalse(auction_counts_now(_auction(-5), now=NOW))

    def test_auction_without_an_end_date_cannot_be_judged(self) -> None:
        self.assertFalse(auction_counts_now(_auction(None), now=NOW))

    def test_early_auction_is_rejected_from_the_candidate_list(self) -> None:
        verdict = evaluate_raw_listing(_auction(6 * 24 * 60), card=CARD, now=NOW)
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["reason"], "auction_outside_final_window")

    def test_late_auction_candidate_carries_its_remaining_minutes(self) -> None:
        verdict = evaluate_raw_listing(_auction(30), card=CARD, now=NOW)
        self.assertTrue(verdict["ok"])
        self.assertEqual(verdict["candidate"]["buyingOption"], "auction")
        self.assertEqual(verdict["candidate"]["auctionMinutesRemaining"], 30.0)


# --------------------------------------------------------------------------
# Candidate shape
# --------------------------------------------------------------------------


class CandidateShapeTests(RawListingTestCase):
    def test_candidate_fields(self) -> None:
        verdict = evaluate_raw_listing(listing(), card=CARD, now=NOW)
        candidate = verdict["candidate"]
        self.assertEqual(
            sorted(candidate),
            sorted(
                [
                    "cardID", "itemID", "legacyItemID", "title", "itemURL", "imageURL",
                    "priceAmount", "shippingAmount", "shippingKnown", "totalAmount",
                    "currencyCode", "buyingOption", "auctionEndAt", "auctionMinutesRemaining",
                    "bidCount", "listedAt", "condition", "conditionID", "conditionVerified",
                    "verification", "isGraded", "sellerFeedbackPercentage",
                    "sellerFeedbackScore",
                ]
            ),
        )
        self.assertEqual(candidate["cardID"], "gym1-60")
        self.assertEqual(candidate["buyingOption"], "fixed_price")
        self.assertEqual(candidate["verification"], "title")
        self.assertFalse(candidate["isGraded"])

    def test_raw_condition_is_never_claimed_as_verified(self) -> None:
        candidate = evaluate_raw_listing(listing(), card=CARD, now=NOW)["candidate"]
        # eBay's taxonomy separates graded from ungraded but has no NM/LP/MP.
        self.assertEqual(candidate["condition"], "Ungraded")
        self.assertFalse(candidate["conditionVerified"])

    def test_listed_at_is_a_listing_date_not_a_sale_date(self) -> None:
        candidate = evaluate_raw_listing(listing(), card=CARD, now=NOW)["candidate"]
        self.assertEqual(candidate["listedAt"], "2026-09-01")
        self.assertNotIn("soldAt", candidate)

    def test_fetch_and_validate_reports_candidates_and_rejections(self) -> None:
        transport = _Transport(
            [
                summary(item_id="v1|1|0", price="9.00"),
                summary(item_id="v1|2|0", title="Pokemon Gym Heroes LOT", price="1.00"),
            ]
        )
        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            payload = fetch_validated_raw_listing_candidates(CARD, now=NOW, fetch_json=transport)

        self.assertEqual(payload["candidateCount"], 1)
        self.assertEqual(payload["candidates"][0]["itemID"], "v1|1|0")
        self.assertEqual(payload["rejected"][0]["reason"], "denylist:lot")
        self.assertEqual(transport.search_calls, 1)


# --------------------------------------------------------------------------
# Per-consumer call accounting
# --------------------------------------------------------------------------


class CallAccountingTests(RawListingTestCase):
    def test_consumer_label_is_attributed_per_lane(self) -> None:
        transport = _Transport()
        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            fetch_raw_card_ebay_listings(CARD, fetch_json=transport, consumer=EBAY_CONSUMER_WATCH_SCAN)

        snapshot = ebay_usage_snapshot()
        self.assertEqual(snapshot[EBAY_CONSUMER_WATCH_SCAN]["api_calls"], 1)
        # The token fetch is its own consumer, not charged to the search lane.
        self.assertEqual(snapshot[EBAY_CONSUMER_OAUTH]["api_calls"], 1)

    def test_unknown_consumer_falls_back_to_the_default_lane(self) -> None:
        transport = _Transport()
        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            payload = fetch_raw_card_ebay_listings(CARD, fetch_json=transport, consumer="nonsense")

        self.assertEqual(payload["consumer"], EBAY_CONSUMER_PDP_LOWEST_LISTED)
        self.assertEqual(ebay_usage_snapshot()[EBAY_CONSUMER_PDP_LOWEST_LISTED]["api_calls"], 1)

    def test_injected_transport_is_handed_the_consumer_when_it_asks_for_it(self) -> None:
        seen: list[str] = []

        def transport(url: str, *, consumer: str = "", **kwargs: object) -> dict[str, object]:
            seen.append(consumer)
            if "identity/v1/oauth2/token" in url:
                return {"access_token": "token-value", "expires_in": 7200}
            return {"itemSummaries": [summary()]}

        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            fetch_raw_card_ebay_listings(CARD, fetch_json=transport, consumer=EBAY_CONSUMER_WATCH_SCAN)

        self.assertEqual(seen, [EBAY_CONSUMER_OAUTH, EBAY_CONSUMER_WATCH_SCAN])

    def test_reused_oauth_token_is_a_cache_hit_not_a_second_api_call(self) -> None:
        transport = _Transport()
        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            fetch_raw_card_ebay_listings(CARD, fetch_json=transport, consumer=EBAY_CONSUMER_WATCH_SCAN)
            fetch_raw_card_ebay_listings(CARD, fetch_json=transport, consumer=EBAY_CONSUMER_WATCH_SCAN)

        self.assertEqual(transport.token_calls, 1)
        oauth = ebay_usage_snapshot()[EBAY_CONSUMER_OAUTH]
        self.assertEqual(oauth["api_calls"], 1)
        self.assertEqual(oauth["cache_hits"], 1)

    def test_cache_hits_are_counted_separately_from_api_calls(self) -> None:
        transport = _Transport()
        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            fetch_raw_card_ebay_listings(CARD, fetch_json=transport, consumer=EBAY_CONSUMER_PDP_LOWEST_LISTED)
        # 24 more PDP opens inside the 1h cache window cost nothing.
        record_ebay_cache_hit(EBAY_CONSUMER_PDP_LOWEST_LISTED, count=24)

        pdp = ebay_usage_snapshot()[EBAY_CONSUMER_PDP_LOWEST_LISTED]
        self.assertEqual(pdp["api_calls"], 1)
        self.assertEqual(pdp["cache_hits"], 24)
        self.assertEqual(pdp["requests"], 25)
        self.assertEqual(pdp["cache_hit_rate"], 0.96)

    def test_failed_calls_are_counted_as_errors(self) -> None:
        def transport(url: str, **kwargs: object) -> dict[str, object]:
            if "identity/v1/oauth2/token" in url:
                return {"access_token": "token-value", "expires_in": 7200}
            raise OSError("rate limited")

        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            payload = fetch_raw_card_ebay_listings(CARD, fetch_json=transport, consumer=EBAY_CONSUMER_WATCH_SCAN)

        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["statusReason"], "fetch_failed")
        watch = ebay_usage_snapshot()[EBAY_CONSUMER_WATCH_SCAN]
        self.assertEqual(watch["api_calls"], 1)
        self.assertEqual(watch["errors"], 1)

    def test_drain_returns_ebay_usage_daily_rows_and_resets(self) -> None:
        record_ebay_cache_hit(EBAY_CONSUMER_WATCH_SCAN, count=3)
        rows = drain_ebay_usage_rows(date="2026-09-19")

        self.assertEqual(
            rows,
            [
                {
                    "date": "2026-09-19",
                    "consumer": EBAY_CONSUMER_WATCH_SCAN,
                    "api_calls": 0,
                    "cache_hits": 3,
                    "errors": 0,
                }
            ],
        )
        self.assertEqual(ebay_usage_snapshot(), {})

    def test_usage_sink_receives_every_event(self) -> None:
        events: list[tuple[str, str, int]] = []
        set_ebay_usage_sink(lambda consumer, event, count: events.append((consumer, event, count)))
        record_ebay_cache_hit(EBAY_CONSUMER_WATCH_SCAN)
        self.assertEqual(events, [(EBAY_CONSUMER_WATCH_SCAN, "cache_hits", 1)])

    def test_a_throwing_sink_never_breaks_a_call(self) -> None:
        def boom(consumer: str, event: str, count: int) -> None:
            raise RuntimeError("sink is down")

        set_ebay_usage_sink(boom)
        transport = _Transport()
        with patch.dict(os.environ, BROWSE_ENV, clear=False):
            payload = fetch_raw_card_ebay_listings(CARD, fetch_json=transport)
        self.assertEqual(payload["status"], "available")


if __name__ == "__main__":
    unittest.main()
