#!/usr/bin/env python3
"""Test Pokemon TCG API provider with live API key."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from import_pokemontcg_catalog import fetch_card_by_id
from pokemontcg_pricing_adapter import PokemonTcgApiProvider
from pricing_utils import normalize_price_summary
from catalog_tools import connect

API_KEY = "fb7ee110-01d4-4998-875a-aec3ef50b78a"

def test_fetch_and_normalize():
    """Test fetching a card and normalizing prices."""
    print("Testing Pokemon TCG API integration...")
    print()

    # Test fetching a modern card that should have pricing
    card_id = "sv3pt5-168"  # Charmander from Pokemon 151

    try:
        card = fetch_card_by_id(card_id, API_KEY)
        print(f"✓ Fetched card: {card.get('name')}")
        print(f"  Set: {card.get('set', {}).get('name')}")
        print(f"  Number: {card.get('number')}")
        print()

        # Check for pricing data
        tcgplayer = card.get("tcgplayer")
        cardmarket = card.get("cardmarket")

        print(f"  Has tcgplayer data: {tcgplayer is not None}")
        print(f"  Has cardmarket data: {cardmarket is not None}")
        print()

        if tcgplayer:
            prices = tcgplayer.get("prices", {})
            print(f"  TCGPlayer variants: {list(prices.keys())}")
            for variant, data in list(prices.items())[:3]:  # Show first 3
                if data and isinstance(data, dict):
                    market = data.get("market")
                    if market:
                        print(f"    {variant}: ${market}")
            print()

        # Test normalization
        price_summary = normalize_price_summary(tcgplayer, cardmarket)
        if price_summary:
            print("✓ Price normalization successful!")
            print(f"  Source: {price_summary.get('source')}")
            print(f"  Currency: {price_summary.get('currencyCode')}")
            print(f"  Variant: {price_summary.get('variant')}")
            print(f"  Low: ${price_summary.get('low')}")
            print(f"  Market: ${price_summary.get('market')}")
            print(f"  High: ${price_summary.get('high')}")
        else:
            print("✗ No pricing available for this card")

        print()
        return price_summary is not None

    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_provider():
    """Test the provider class."""
    print("Testing PokemonTcgApiProvider...")
    print()

    provider = PokemonTcgApiProvider()
    metadata = provider.get_metadata()

    print(f"  Provider ID: {metadata.provider_id}")
    print(f"  Provider Label: {metadata.provider_label}")
    print(f"  Is Ready: {metadata.is_ready}")
    print(f"  Supports Raw: {metadata.supports_raw_pricing}")
    print(f"  Supports PSA: {metadata.supports_psa_pricing}")
    print()

    # Test with database
    db_path = Path(__file__).parent / "data" / "imported_scanner.sqlite"
    if db_path.exists():
        print(f"Testing live refresh with database: {db_path}")
        connection = connect(db_path)

        # Try refreshing a card that should have pricing
        result = provider.refresh_raw_pricing(connection, "sv3pt5-168")

        print(f"  Refresh result: {'SUCCESS' if result.success else 'FAILED'}")
        if result.success:
            print(f"  Provider: {result.provider_id}")
            print("  ✓ Live pricing refresh works!")
        else:
            print(f"  Error: {result.error}")

        connection.close()
        return result.success
    else:
        print(f"⚠ Database not found: {db_path}")
        print("  Skipping live refresh test")
        return True

if __name__ == "__main__":
    success1 = test_fetch_and_normalize()
    print()
    print("=" * 60)
    print()
    success2 = test_provider()

    if success1 and success2:
        print()
        print("✓ All tests passed!")
        sys.exit(0)
    else:
        print()
        print("✗ Some tests failed")
        sys.exit(1)
