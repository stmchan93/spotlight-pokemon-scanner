#!/usr/bin/env python3
"""
Fetch ALL Pokémon cards from Pokemon TCG API and generate identifier map.

This replaces the limited 2020+ catalog with complete coverage of all
15,000+ Pokémon cards from 1999-2024.

The identifier map contains ONLY minimal data for offline identification:
- Card ID (unique identifier)
- Name (for display)
- Set name (for display)
- Number (collector number for lookup)
- Small image URL (for display)

All other metadata (rarity, artist, pricing, etc.) comes from the API.
"""

import json
import os
import re
import time
from pathlib import Path
from typing import Dict, List, Any
import urllib.request
import urllib.error

# Pokemon TCG API base URL (no auth required!)
API_BASE = "https://api.pokemontcg.io/v2"
API_KEY = os.environ.get("POKEMONTCG_API_KEY", "")  # Optional - works without key
LOW_TRUST_CUSTOM_CARD_ID_PATTERN = re.compile(r"^me\d", re.IGNORECASE)


def runtime_supported_card_id(card_id: str) -> bool:
    return LOW_TRUST_CUSTOM_CARD_ID_PATTERN.search(card_id or "") is None


def resolved_collector_number(card: Dict[str, Any]) -> str:
    number = str(card.get("number") or "").strip()
    if not number:
        return ""

    set_info = card.get("set", {}) or {}
    printed_total = set_info.get("printedTotal")
    set_name = set_info.get("name", "")
    set_series = set_info.get("series", "")
    is_promo_set = "promo" in f"{set_name} {set_series}".lower()

    if printed_total and "/" not in number and not is_promo_set:
        prefix_match = "".join(character for character in number if character.isalpha())
        if prefix_match:
            return f"{number}/{prefix_match}{printed_total}"
        return f"{number}/{printed_total}"

    return number


def fetch_all_cards() -> List[Dict[str, Any]]:
    """
    Fetch all Pokémon cards from the API.

    Returns list of cards with minimal data needed for identifier map.
    """
    all_cards = []
    page = 1
    page_size = 250  # Max allowed by API

    print("🔍 Fetching all Pokémon cards from Pokemon TCG API...")
    print(f"📡 API: {API_BASE}")

    while True:
        url = f"{API_BASE}/cards?page={page}&pageSize={page_size}"

        try:
            # Create request with optional API key
            request = urllib.request.Request(url)
            request.add_header("User-Agent", "Spotlight-Card-Scanner/1.0")
            if API_KEY:
                request.add_header("X-Api-Key", API_KEY)

            print(f"📥 Fetching page {page}...", end=" ", flush=True)

            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode())

            cards = data.get("data", [])
            total_count = data.get("totalCount", 0)

            if not cards:
                print("(no more cards)")
                break

            # Extract minimal data for each card
            for card in cards:
                if not runtime_supported_card_id(card.get("id", "")):
                    continue

                # Only include cards with a collector number
                number = resolved_collector_number(card)
                if not number:
                    continue

                all_cards.append({
                    "id": card["id"],
                    "name": card.get("name", ""),
                    "set_name": card.get("set", {}).get("name", ""),
                    "number": number,
                    "image_url": card.get("images", {}).get("small", "")
                })

            print(f"✓ Got {len(cards)} cards (total: {len(all_cards)}/{total_count})")

            # If we got fewer cards than page size, we're done
            if len(cards) < page_size:
                break

            page += 1

            # Rate limiting - be nice to the API
            time.sleep(0.2)

        except urllib.error.HTTPError as e:
            if e.code == 429:  # Rate limited
                print(f"\n⚠️  Rate limited. Waiting 60 seconds...")
                time.sleep(60)
                continue
            else:
                print(f"\n❌ HTTP Error {e.code}: {e.reason}")
                raise
        except Exception as e:
            print(f"\n❌ Error: {e}")
            raise

    print(f"\n✅ Fetched {len(all_cards)} total cards")
    return all_cards


def generate_identifier_map(cards: List[Dict[str, Any]], output_path: Path):
    """
    Generate identifier map from card list.

    Creates mapping: collector number → card data
    Handles duplicate collector numbers across sets (creates arrays).
    """
    identifiers = {}

    print(f"\n🗺️  Generating identifier map...")

    for card in cards:
        number = card["number"]

        entry = {
            "id": card["id"],
            "name": card["name"],
            "set": card["set_name"],
            "image": card["image_url"]
        }

        # Handle duplicate numbers across sets
        if number in identifiers:
            # Convert to array if not already
            if not isinstance(identifiers[number], list):
                identifiers[number] = [identifiers[number]]
            identifiers[number].append(entry)
        else:
            identifiers[number] = entry

    # Create output directory
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write output
    output = {"identifiers": identifiers}
    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)

    size_kb = output_path.stat().st_size / 1024
    size_mb = size_kb / 1024

    # Count unique vs ambiguous entries
    unique_count = sum(1 for v in identifiers.values() if not isinstance(v, list))
    ambiguous_count = sum(1 for v in identifiers.values() if isinstance(v, list))

    print(f"✅ Generated identifier map:")
    print(f"   Total cards: {len(cards)}")
    print(f"   Unique collector numbers: {unique_count}")
    print(f"   Ambiguous collector numbers: {ambiguous_count}")
    print(f"   File size: {size_mb:.2f} MB ({size_kb:.1f} KB)")
    print(f"   Output: {output_path}")

    return output_path


def main():
    """Main execution"""
    import argparse

    parser = argparse.ArgumentParser(
        description="Fetch all Pokémon cards and generate identifier map"
    )
    parser.add_argument(
        "--output",
        default="catalog/identifiers/pokemon_complete.json",
        help="Output path for identifier map"
    )
    parser.add_argument(
        "--cache-cards",
        default="catalog/pokemontcg/all_cards_cache.json",
        help="Cache full card data (for debugging)"
    )
    parser.add_argument(
        "--use-cache",
        action="store_true",
        help="Use cached cards instead of fetching from API"
    )

    args = parser.parse_args()

    root = Path(__file__).parent
    output_path = root / args.output
    cache_path = root / args.cache_cards

    # Fetch or load cards
    if args.use_cache and cache_path.exists():
        print(f"📦 Loading cards from cache: {cache_path}")
        with open(cache_path, 'r') as f:
            cards = json.load(f)
        print(f"✅ Loaded {len(cards)} cards from cache")
    else:
        cards = fetch_all_cards()

        # Save cache for future runs
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(cache_path, 'w') as f:
            json.dump(cards, f, indent=2)
        print(f"💾 Cached cards to: {cache_path}")

    # Generate identifier map
    generate_identifier_map(cards, output_path)

    print("\n" + "="*60)
    print("✅ COMPLETE!")
    print("="*60)
    print(f"\nIdentifier map ready at:")
    print(f"  {output_path}")
    print(f"\nNext steps:")
    print(f"  1. Copy to iPhone: cp {output_path} ../Spotlight/Resources/identifiers_pokemon.json")
    print(f"  2. Add to Xcode Copy Bundle Resources")
    print(f"  3. Test with vintage cards (1999 Base Set, etc.)")


if __name__ == "__main__":
    main()
