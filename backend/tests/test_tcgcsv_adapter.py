"""TCGCSV adapter: courteous HTTP (UA, spacing, Retry-After backoff, abort on final
failure) and the main-lane subtype selection rule. No network — HTTP fully mocked.
"""

from __future__ import annotations

import io
import json
import sys
import unittest
from email.message import Message
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import tcgcsv_adapter  # noqa: E402
from tcgcsv_adapter import (  # noqa: E402
    TCGCSV_BASE_URL,
    TCGCSV_USER_AGENT,
    build_product_price_map,
    fetch_group_ids,
    fetch_group_prices,
    scrydex_variant_label_for_subtype,
    select_main_price_entry,
)
from catalog_tools import raw_variant_sort_key  # noqa: E402


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _http_error(code: int, retry_after: str | None = None) -> HTTPError:
    headers = Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return HTTPError("https://tcgcsv.com/x", code, "err", headers, io.BytesIO(b""))


class FetchTests(unittest.TestCase):
    @mock.patch("time.sleep")
    @mock.patch("urllib.request.urlopen")
    def test_fetch_group_ids_sends_user_agent_and_parses(self, urlopen, _sleep):
        urlopen.return_value = _FakeResponse({"results": [{"groupId": 604}, {"groupId": 605}, {"name": "junk"}]})
        self.assertEqual(fetch_group_ids(3), [604, 605])
        request = urlopen.call_args[0][0]
        self.assertEqual(request.full_url, f"{TCGCSV_BASE_URL}/3/groups")
        self.assertEqual(request.get_header("User-agent"), TCGCSV_USER_AGENT)

    @mock.patch("time.sleep")
    @mock.patch("urllib.request.urlopen")
    def test_retries_429_with_retry_after_then_succeeds(self, urlopen, sleep):
        urlopen.side_effect = [
            _http_error(429, retry_after="0"),
            _FakeResponse({"results": [{"productId": 1, "subTypeName": "Normal"}]}),
        ]
        rows = fetch_group_prices(3, 604)
        self.assertEqual(rows, [{"productId": 1, "subTypeName": "Normal"}])
        self.assertEqual(urlopen.call_count, 2)

    @mock.patch("time.sleep")
    @mock.patch("urllib.request.urlopen")
    def test_non_transient_error_raises_immediately(self, urlopen, _sleep):
        urlopen.side_effect = _http_error(404)
        with self.assertRaises(HTTPError):
            fetch_group_prices(3, 604)
        self.assertEqual(urlopen.call_count, 1)

    @mock.patch("time.sleep")
    @mock.patch("urllib.request.urlopen")
    def test_persistent_5xx_exhausts_attempts_and_aborts(self, urlopen, _sleep):
        urlopen.side_effect = _http_error(503)
        with self.assertRaises(HTTPError):
            fetch_group_prices(3, 604)
        self.assertEqual(urlopen.call_count, tcgcsv_adapter.TCGCSV_MAX_ATTEMPTS)

    @mock.patch("time.sleep")
    @mock.patch("urllib.request.urlopen")
    def test_build_price_and_number_maps_skips_incomplete_rows(self, urlopen, _sleep):
        urlopen.side_effect = [
            _FakeResponse({"results": [{"groupId": 604}]}),
            _FakeResponse({"results": [
                {"productId": 100, "subTypeName": "Normal", "marketPrice": 1.5},
                {"productId": 100, "subTypeName": "Reverse Holofoil", "marketPrice": 3.0},
                {"productId": None, "subTypeName": "Normal", "marketPrice": 9.0},
                {"productId": 101, "subTypeName": "", "marketPrice": 9.0},
            ]}),
            # The group's /products list, fetched in the same pass.
            _FakeResponse({"results": [
                {"productId": 100, "extendedData": [{"name": "Number", "value": "045"}]},
                {"productId": 102, "extendedData": [{"name": "Rarity", "value": "Rare"}]},
            ]}),
        ]
        by_product, numbers = tcgcsv_adapter.build_price_and_number_maps((3,))
        self.assertEqual(set(by_product), {"100"})
        self.assertEqual(set(by_product["100"]), {"Normal", "Reverse Holofoil"})
        self.assertEqual(numbers, {"100": "45"})


class NumberNormalizationTests(unittest.TestCase):
    def test_normalized_card_number_table(self):
        # Formats measured live in the 2026-08-25 audit.
        for raw, expected in (
            ("061/060", "61"), ("045", "45"), ("H01", "h1"), ("SVP 175", "svp175"),
            ("svp193", "svp193"), ("215/203", "215"), ("TG20/TG30", "tg20"),
            ("SWSH284", "swsh284"), ("50a", "50a"), ("", ""),
        ):
            self.assertEqual(tcgcsv_adapter.normalized_card_number(raw), expected, raw)

    def test_non_pokemon_finish_mappings(self):
        # Measured live in categories 68/71/86/89: OP/Riftbound use Foil,
        # Lorcana uses Cold Foil (Scrydex "coldFoil" -> "Coldfoil"), Gundam
        # reuses Holofoil.
        self.assertEqual(tcgcsv_adapter.subtype_for_variant_label("Foil"), "Foil")
        self.assertEqual(tcgcsv_adapter.subtype_for_variant_label("Cold Foil"), "Cold Foil")
        self.assertEqual(tcgcsv_adapter.scrydex_variant_label_for_subtype("Foil"), "Foil")
        self.assertEqual(tcgcsv_adapter.scrydex_variant_label_for_subtype("Cold Foil"), "Cold Foil")

    def test_card_numbers_match_table(self):
        match = tcgcsv_adapter.card_numbers_match
        self.assertTrue(match("175", "svp175"))       # product carries the set prefix
        self.assertTrue(match("svp175", "175"))       # or the card does
        self.assertTrue(match("h1", "h1"))            # zero-strip handled upstream
        self.assertFalse(match("50", "50a"))          # letter variants are distinct printings
        self.assertFalse(match("27", "28"))           # the V-UNION quarter mis-map
        self.assertFalse(match("", "1"))              # empty never matches
        self.assertFalse(match("175", "175a"))        # numeric+letter suffix is not a prefix match


def _row(market, **extra):
    return {"marketPrice": market, **extra}


class SelectMainPriceEntryTests(unittest.TestCase):
    def test_exact_default_variant_subtype_wins(self):
        prices = {"100": {"Normal": _row(1.0), "Reverse Holofoil": _row(3.0)}}
        result = select_main_price_entry(
            {"Reverse Holofoil": "100", "Normal": "100"}, "Reverse Holofoil", prices, frozenset()
        )
        self.assertIsNotNone(result)
        row, sub_type_name, product_id = result
        self.assertEqual(sub_type_name, "Reverse Holofoil")
        self.assertEqual(product_id, "100")
        self.assertEqual(row["marketPrice"], 3.0)

    def test_first_edition_maps_to_1st_edition_holofoil(self):
        prices = {"100": {"Normal": _row(1.0), "1st Edition Holofoil": _row(40.0)}}
        result = select_main_price_entry({"First Edition": "100"}, "First Edition", prices, frozenset())
        self.assertEqual(result[1], "1st Edition Holofoil")

    def test_null_market_price_falls_to_next_subtype(self):
        prices = {"100": {"Holofoil": _row(None), "Reverse Holofoil": _row(5.0)}}
        result = select_main_price_entry({"Holofoil": "100"}, "Holofoil", prices, frozenset())
        self.assertEqual(result[1], "Reverse Holofoil")

    def test_zero_market_price_is_skipped(self):
        prices = {"100": {"Normal": _row(0)}}
        self.assertIsNone(select_main_price_entry({"Normal": "100"}, "Normal", prices, frozenset()))

    def test_bare_vintage_editions_pick_the_default_edition(self):
        # Neo Genesis Wooper (90632): TCGCSV lists the editions BARE, and the
        # default is Unlimited. The old map knew only "Unlimited Holofoil", so
        # the pick fell through to row order and quoted 1st Edition.
        prices = {"90632": {"1st Edition": _row(9.52), "Unlimited": _row(3.2)}}
        result = select_main_price_entry(
            {"First Edition": "90632", "Unlimited": "90632"}, "Unlimited", prices, frozenset()
        )
        self.assertEqual(result[1], "Unlimited")
        self.assertEqual(result[0]["marketPrice"], 3.2)
        self.assertEqual(scrydex_variant_label_for_subtype("Unlimited"), "Unlimited")
        self.assertEqual(scrydex_variant_label_for_subtype("1st Edition"), "First Edition")

    def test_any_fallback_never_prefers_first_edition(self):
        # Nothing maps; the "any" tail must still put a 1st Edition row last.
        prices = {"100": {"1st Edition Exotic": _row(9.0), "Exotic Foil": _row(7.0)}}
        result = select_main_price_entry({"Normal": "100"}, "Normal", prices, frozenset())
        self.assertEqual(result[1], "Exotic Foil")

    def test_unlisted_subtype_falls_to_any(self):
        prices = {"100": {"Exotic Foil": _row(7.0)}}
        result = select_main_price_entry({"Normal": "100"}, "Normal", prices, frozenset())
        self.assertEqual(result[1], "Exotic Foil")

    def test_colliding_product_id_skipped_entirely(self):
        prices = {"100": {"Normal": _row(9.0)}, "200": {"Normal": _row(2.0)}}
        result = select_main_price_entry(
            {"Normal": "100", "Holofoil": "200"}, "Normal", prices, frozenset({"100"})
        )
        self.assertEqual(result[2], "200")
        self.assertIsNone(
            select_main_price_entry({"Normal": "100"}, "Normal", prices, frozenset({"100"}))
        )

    def test_unpriced_default_product_falls_to_other_product(self):
        prices = {"200": {"Holofoil": _row(12.0)}}
        result = select_main_price_entry(
            {"Normal": "100", "Holofoil": "200"}, "Normal", prices, frozenset()
        )
        self.assertEqual(result[2], "200")
        self.assertEqual(result[1], "Holofoil")

    def test_no_match_returns_none(self):
        self.assertIsNone(select_main_price_entry({"Normal": "100"}, "Normal", {}, frozenset()))
        self.assertIsNone(select_main_price_entry({}, "Normal", {"100": {"Normal": _row(1.0)}}, frozenset()))

    def test_two_printings_on_one_product_are_ranked_not_taken_from_the_default(self):
        """One Piece P-043: TCGplayer sells the Normal ($89.78) and the Foil
        ($460.66) as ONE product (552131), so the product walk cannot separate
        them and the stale Scrydex default ("Foil") decided the subtype outright.
        The card in hand is the Normal; the page quoted $460.66 (user,
        2026-09-14). The ranking has to reach INSIDE a product, not just order
        products."""
        prices = {"552131": {"Normal": _row(89.78), "Foil": _row(460.66)}}
        variant_product_ids = {"Normal": "552131", "Foil": "552131"}

        # Precondition: one product id, so the product-level ranking is inert.
        self.assertEqual(set(variant_product_ids.values()), {"552131"})

        result = select_main_price_entry(
            variant_product_ids, "Foil", prices, frozenset(), variant_rank=raw_variant_sort_key
        )
        self.assertEqual(result[1], "Normal")
        self.assertEqual(result[0]["marketPrice"], 89.78)

    def test_without_a_ranking_the_stored_default_still_decides(self):
        # Back-compat: callers that pass no ranking keep the old behavior, so a
        # flag-off/legacy path stays byte-identical.
        prices = {"552131": {"Normal": _row(89.78), "Foil": _row(460.66)}}
        result = select_main_price_entry(
            {"Normal": "552131", "Foil": "552131"}, "Foil", prices, frozenset()
        )
        self.assertEqual(result[1], "Foil")

    def test_ranking_still_skips_an_unpriced_better_printing(self):
        # Rank order does not override "must have a market price".
        prices = {"100": {"Normal": _row(None), "Foil": _row(4.0)}}
        result = select_main_price_entry(
            {"Normal": "100", "Foil": "100"}, "Foil", prices, frozenset(),
            variant_rank=raw_variant_sort_key,
        )
        self.assertEqual(result[1], "Foil")


if __name__ == "__main__":
    unittest.main()
