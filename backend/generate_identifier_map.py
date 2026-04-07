#!/usr/bin/env python3
"""
Generate minimal identifier map for iPhone app offline identification.

Extracts essential card data (ID, name, set, image URL) from the full catalog
and creates a compact JSON file for bundling with the iPhone app.

Output: ~332 KB identifier map with 2,020+ cards
Input: Full cards.json catalog (~7.9 MB)

Usage:
    python3 generate_identifier_map.py \
        --cards-file catalog/pokemontcg/cards.json \
        --output catalog/identifiers/pokemon.json
"""

import json
import re
from pathlib import Path

LOW_TRUST_CUSTOM_CARD_ID_PATTERN = re.compile(r"^me\d", re.IGNORECASE)


def runtime_supported_card_id(card_id: str) -> bool:
    return LOW_TRUST_CUSTOM_CARD_ID_PATTERN.search(card_id or "") is None


def generate_identifier_map(cards_json_path: Path, output_path: Path):
    """Generate minimal identifier map from cards.json"""
    with open(cards_json_path, 'r') as f:
        cards = json.load(f)

    identifiers = {}

    for card in cards:
        if not runtime_supported_card_id(card.get("id", "")):
            continue

        number = card.get('number', '')
        if not number:
            continue

        entry = {
            "id": card['id'],
            "name": card.get('name', ''),
            "set": card.get('set_name', ''),
            "image": card.get('reference_image_small_url', '')
        }

        # Handle duplicate numbers across sets
        if number in identifiers:
            # Convert to array if not already
            if not isinstance(identifiers[number], list):
                identifiers[number] = [identifiers[number]]
            identifiers[number].append(entry)
        else:
            identifiers[number] = entry

    # Create output directory if it doesn't exist
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write output
    output = {"identifiers": identifiers}
    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)

    size_kb = output_path.stat().st_size / 1024
    print(f"✅ Generated identifier map: {size_kb:.1f} KB")
    print(f"   Total identifiers: {len(identifiers)}")
    print(f"   Output: {output_path}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--cards-file', default='catalog/pokemontcg/cards.json')
    parser.add_argument('--output', default='catalog/identifiers/pokemon.json')
    args = parser.parse_args()

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    generate_identifier_map(Path(args.cards_file), output_path)
