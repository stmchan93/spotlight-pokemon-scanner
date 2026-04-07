#!/usr/bin/env python3
"""
Unit tests for generate_identifier_map.py

Tests identifier map generation including:
- Correct extraction of card data
- Handling of duplicate collector numbers
- Output format validation
"""

import unittest
import json
import tempfile
from pathlib import Path
from generate_identifier_map import generate_identifier_map


class TestIdentifierMapGeneration(unittest.TestCase):
    """Test identifier map generation functionality"""

    def setUp(self):
        """Create temporary files for testing"""
        self.temp_dir = tempfile.mkdtemp()
        self.cards_file = Path(self.temp_dir) / "cards.json"
        self.output_file = Path(self.temp_dir) / "identifiers.json"

    def tearDown(self):
        """Clean up temporary files"""
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_basic_card_extraction(self):
        """Test extraction of basic card information"""
        # Create test cards file
        cards = [
            {
                "id": "test-1",
                "name": "Pikachu",
                "set_name": "Base Set",
                "number": "25/102",
                "reference_image_small_url": "https://example.com/pikachu.png"
            },
            {
                "id": "test-2",
                "name": "Charizard",
                "set_name": "Base Set",
                "number": "4/102",
                "reference_image_small_url": "https://example.com/charizard.png"
            }
        ]

        with open(self.cards_file, 'w') as f:
            json.dump(cards, f)

        # Generate identifier map
        generate_identifier_map(self.cards_file, self.output_file)

        # Verify output
        self.assertTrue(self.output_file.exists())

        with open(self.output_file, 'r') as f:
            result = json.load(f)

        identifiers = result["identifiers"]
        self.assertEqual(len(identifiers), 2)
        self.assertIn("25/102", identifiers)
        self.assertIn("4/102", identifiers)

    def test_card_data_fields(self):
        """Test that all required fields are included"""
        cards = [
            {
                "id": "test-1",
                "name": "Pikachu",
                "set_name": "Base Set",
                "number": "25/102",
                "reference_image_small_url": "https://example.com/pikachu.png"
            }
        ]

        with open(self.cards_file, 'w') as f:
            json.dump(cards, f)

        generate_identifier_map(self.cards_file, self.output_file)

        with open(self.output_file, 'r') as f:
            result = json.load(f)

        card_data = result["identifiers"]["25/102"]
        self.assertEqual(card_data["id"], "test-1")
        self.assertEqual(card_data["name"], "Pikachu")
        self.assertEqual(card_data["set"], "Base Set")
        self.assertEqual(card_data["image"], "https://example.com/pikachu.png")

    def test_duplicate_numbers_creates_array(self):
        """Test that duplicate collector numbers create an array"""
        cards = [
            {
                "id": "test-1",
                "name": "Pikachu",
                "set_name": "Base Set",
                "number": "25/102",
                "reference_image_small_url": "https://example.com/pikachu1.png"
            },
            {
                "id": "test-2",
                "name": "Pikachu",
                "set_name": "Base Set 2",
                "number": "25/102",
                "reference_image_small_url": "https://example.com/pikachu2.png"
            }
        ]

        with open(self.cards_file, 'w') as f:
            json.dump(cards, f)

        generate_identifier_map(self.cards_file, self.output_file)

        with open(self.output_file, 'r') as f:
            result = json.load(f)

        card_data = result["identifiers"]["25/102"]
        self.assertIsInstance(card_data, list)
        self.assertEqual(len(card_data), 2)
        self.assertEqual(card_data[0]["id"], "test-1")
        self.assertEqual(card_data[1]["id"], "test-2")

    def test_cards_without_number_skipped(self):
        """Test that cards without collector numbers are skipped"""
        cards = [
            {
                "id": "test-1",
                "name": "Pikachu",
                "set_name": "Base Set",
                "number": "25/102",
                "reference_image_small_url": "https://example.com/pikachu.png"
            },
            {
                "id": "test-2",
                "name": "Mystery Card",
                "set_name": "Base Set",
                "number": "",  # Empty number
                "reference_image_small_url": "https://example.com/mystery.png"
            },
            {
                "id": "test-3",
                "name": "Another Card",
                "set_name": "Base Set"
                # No number field at all
            }
        ]

        with open(self.cards_file, 'w') as f:
            json.dump(cards, f)

        generate_identifier_map(self.cards_file, self.output_file)

        with open(self.output_file, 'r') as f:
            result = json.load(f)

        identifiers = result["identifiers"]
        # Only the first card should be included
        self.assertEqual(len(identifiers), 1)
        self.assertIn("25/102", identifiers)

    def test_missing_optional_fields(self):
        """Test handling of missing optional fields"""
        cards = [
            {
                "id": "test-1",
                "number": "25/102"
                # Missing name, set_name, reference_image_small_url
            }
        ]

        with open(self.cards_file, 'w') as f:
            json.dump(cards, f)

        generate_identifier_map(self.cards_file, self.output_file)

        with open(self.output_file, 'r') as f:
            result = json.load(f)

        card_data = result["identifiers"]["25/102"]
        self.assertEqual(card_data["id"], "test-1")
        self.assertEqual(card_data["name"], "")
        self.assertEqual(card_data["set"], "")
        self.assertEqual(card_data["image"], "")

    def test_output_directory_created(self):
        """Test that output directory is created if it doesn't exist"""
        nested_output = Path(self.temp_dir) / "nested" / "path" / "identifiers.json"
        cards = [
            {
                "id": "test-1",
                "name": "Pikachu",
                "set_name": "Base Set",
                "number": "25/102",
                "reference_image_small_url": "https://example.com/pikachu.png"
            }
        ]

        with open(self.cards_file, 'w') as f:
            json.dump(cards, f)

        # Should create nested directories
        generate_identifier_map(self.cards_file, nested_output)

        self.assertTrue(nested_output.exists())
        self.assertTrue(nested_output.parent.exists())

    def test_large_dataset(self):
        """Test with a larger dataset (100 cards)"""
        cards = []
        for i in range(100):
            cards.append({
                "id": f"card-{i}",
                "name": f"Card {i}",
                "set_name": "Test Set",
                "number": f"{i}/100",
                "reference_image_small_url": f"https://example.com/{i}.png"
            })

        with open(self.cards_file, 'w') as f:
            json.dump(cards, f)

        generate_identifier_map(self.cards_file, self.output_file)

        with open(self.output_file, 'r') as f:
            result = json.load(f)

        identifiers = result["identifiers"]
        self.assertEqual(len(identifiers), 100)

    def test_special_characters_in_collector_number(self):
        """Test handling of special characters in collector numbers"""
        cards = [
            {
                "id": "test-1",
                "name": "Promo Card",
                "set_name": "Promo",
                "number": "TG30/TG30",
                "reference_image_small_url": "https://example.com/promo.png"
            },
            {
                "id": "test-2",
                "name": "Secret Rare",
                "set_name": "Set",
                "number": "SV001/SV122",
                "reference_image_small_url": "https://example.com/secret.png"
            }
        ]

        with open(self.cards_file, 'w') as f:
            json.dump(cards, f)

        generate_identifier_map(self.cards_file, self.output_file)

        with open(self.output_file, 'r') as f:
            result = json.load(f)

        identifiers = result["identifiers"]
        self.assertIn("TG30/TG30", identifiers)
        self.assertIn("SV001/SV122", identifiers)


def run_tests():
    """Run all tests and return results"""
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromTestCase(TestIdentifierMapGeneration)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return result.wasSuccessful()


if __name__ == "__main__":
    success = run_tests()
    exit(0 if success else 1)
