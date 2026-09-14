from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from catalog_tools import (  # noqa: E402
    _default_raw_field_values,
    _raw_variant_fallback_penalty,
    _resolve_default_raw_context,
)


def _entry(market: float) -> dict:
    return {"currencyCode": "USD", "low": None, "market": market, "mid": None, "high": None}


def _contexts(variants_nm: dict[str, float]) -> dict:
    return {
        "variants": {
            name: {"conditions": {"NM": _entry(market)}} for name, market in variants_nm.items()
        }
    }


class RawVariantDefaultTests(unittest.TestCase):
    def test_vintage_defaults_to_unlimited_holofoil_not_first_edition(self) -> None:
        # base1-4 Charizard: Scrydex stores both; Unlimited Holofoil is the correct default.
        contexts = _contexts(
            {
                "First Edition Shadowless Holofoil": 310.0,
                "Unlimited Holofoil": 630.39,
                "Unlimited Shadowless Holofoil": 2146.38,
                "Jumbo": 400.0,
                "Metal": 311.26,
            }
        )
        variant, condition, entry = _resolve_default_raw_context(contexts)
        self.assertEqual(variant, "Unlimited Holofoil")
        self.assertEqual(condition, "NM")
        self.assertEqual(entry["market"], 630.39)

        fields = _default_raw_field_values(contexts)
        self.assertEqual(fields["defaultRawVariant"], "Unlimited Holofoil")
        self.assertEqual(fields["defaultRawMarketPrice"], 630.39)

    def test_unlimited_preferred_even_when_first_edition_is_pricier(self) -> None:
        # neo4 Light Arcanine style: 1st-ed genuinely higher, but a scanned card is most likely
        # Unlimited, so the default should still be Unlimited.
        contexts = _contexts(
            {"First Edition Holofoil": 650.0, "Unlimited Holofoil": 333.13}
        )
        variant, _, entry = _resolve_default_raw_context(contexts)
        self.assertEqual(variant, "Unlimited Holofoil")
        self.assertEqual(entry["market"], 333.13)

    def test_one_piece_quotes_the_base_foil_not_the_alt_art(self) -> None:
        """OP13-118 Luffy, the live case.

        One Piece commons print FOIL, so Foil is that game's base printing the
        way Normal is Pokémon's. None of this game's labels matched any keyword,
        so every printing tied and the ranking fell through to alphabetical,
        where "Alt Art" beats "Foil". The card quoted $102.13 and deep-linked to
        a different card's TCGplayer page, for a card whose base is $28.60
        (user, 2026-09-13). It affected 480 of 2,633 One Piece cards.
        """
        contexts = _contexts(
            {
                "Foil": 28.60,
                "Alt Art": 102.13,
                "Manga Alt Art": 2116.43,
                "Red Manga Alt Art": 19999.0,
                "Wanted Poster": 337.31,
            }
        )
        variant, _, entry = _resolve_default_raw_context(contexts)
        self.assertEqual(variant, "Foil")
        self.assertEqual(entry["market"], 28.60)

    def test_a_base_printing_always_outranks_a_parallel(self) -> None:
        """The rule, stated once, rather than card by card."""
        for base, parallel in (
            ("Normal", "Alt Art"),
            ("Foil", "Full Art"),
            ("Foil", "Championship Stamp"),
            ("Normal", "Textured Foil"),
            ("Holofoil", "Premium Alt Art"),
        ):
            with self.subTest(base=base, parallel=parallel):
                variant, _, _ = _resolve_default_raw_context(_contexts({parallel: 500.0, base: 5.0}))
                self.assertEqual(variant, base)

    def test_vintage_pokemon_ranking_is_untouched(self) -> None:
        """The parallel rules must not disturb the rule they were added beside."""
        contexts = _contexts(
            {"First Edition Holofoil": 650.0, "Unlimited Holofoil": 333.13, "Jumbo": 400.0}
        )
        variant, _, _ = _resolve_default_raw_context(contexts)
        self.assertEqual(variant, "Unlimited Holofoil")

    def test_modern_priority_is_unchanged(self) -> None:
        # Modern cards must still rank Holofoil/Reverse via the explicit priority tuple.
        contexts = _contexts({"Reverse Holofoil": 5.0, "Holofoil": 9.0, "Normal": 1.0})
        variant, _, _ = _resolve_default_raw_context(contexts)
        self.assertEqual(variant, "Normal")

    def test_single_printing_card_is_unaffected(self) -> None:
        contexts = _contexts({"First Edition Holofoil": 42.0})
        variant, _, entry = _resolve_default_raw_context(contexts)
        self.assertEqual(variant, "First Edition Holofoil")
        self.assertEqual(entry["market"], 42.0)

    def test_penalty_ordering(self) -> None:
        self.assertLess(
            _raw_variant_fallback_penalty("Unlimited Holofoil"),
            _raw_variant_fallback_penalty("First Edition Shadowless Holofoil"),
        )
        self.assertLess(
            _raw_variant_fallback_penalty("Unlimited Holofoil"),
            _raw_variant_fallback_penalty("Unlimited Shadowless Holofoil"),
        )


if __name__ == "__main__":
    unittest.main()
