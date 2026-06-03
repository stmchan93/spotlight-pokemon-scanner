from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from server import SpotlightScanService  # noqa: E402


EN_CARD = {"id": "base1-4", "name": "Charizard", "setID": "base1", "language": "English"}
EN_CARD_UNKNOWN_LANG = {"id": "swsh1-25", "name": "Snom", "setID": "swsh1", "language": ""}
JP_CARD_BY_LANGUAGE = {"id": "sv1a-1", "name": "Pikachu", "setID": "sv1a", "language": "Japanese"}
JP_CARD_BY_SET_SUFFIX = {"id": "sv1_ja-100", "name": "Mew", "setID": "sv1_ja", "language": ""}
JP_CARD_BY_ID_SUFFIX = {"id": "sv2a_ja-200", "name": "Gengar", "setID": "sv2a", "language": ""}


class ExplicitScanLanguageTests(unittest.TestCase):
    def test_maps_english_and_japanese_case_insensitively(self) -> None:
        self.assertEqual(SpotlightScanService._explicit_scan_language({"cardLanguage": "english"}), "english")
        self.assertEqual(SpotlightScanService._explicit_scan_language({"cardLanguage": "Japanese"}), "japanese")
        self.assertEqual(SpotlightScanService._explicit_scan_language({"cardLanguage": "  JAPANESE "}), "japanese")

    def test_returns_none_when_unset_or_unknown(self) -> None:
        self.assertIsNone(SpotlightScanService._explicit_scan_language({}))
        self.assertIsNone(SpotlightScanService._explicit_scan_language({"cardLanguage": ""}))
        self.assertIsNone(SpotlightScanService._explicit_scan_language({"cardLanguage": "klingon"}))


class FilterCandidatesByScanLanguageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.candidates = [
            EN_CARD,
            JP_CARD_BY_LANGUAGE,
            JP_CARD_BY_SET_SUFFIX,
            JP_CARD_BY_ID_SUFFIX,
            EN_CARD_UNKNOWN_LANG,
        ]

    def test_english_toggle_drops_every_japanese_candidate(self) -> None:
        filtered = SpotlightScanService._filter_candidates_by_scan_language(self.candidates, "english")
        self.assertEqual(filtered, [EN_CARD, EN_CARD_UNKNOWN_LANG])
        self.assertTrue(all(not SpotlightScanService._candidate_is_japanese(c) for c in filtered))

    def test_japanese_toggle_keeps_only_japanese_candidates(self) -> None:
        filtered = SpotlightScanService._filter_candidates_by_scan_language(self.candidates, "japanese")
        self.assertEqual(filtered, [JP_CARD_BY_LANGUAGE, JP_CARD_BY_SET_SUFFIX, JP_CARD_BY_ID_SUFFIX])
        self.assertTrue(all(SpotlightScanService._candidate_is_japanese(c) for c in filtered))

    def test_no_explicit_toggle_returns_pool_unchanged(self) -> None:
        filtered = SpotlightScanService._filter_candidates_by_scan_language(self.candidates, None)
        self.assertEqual(filtered, self.candidates)

    def test_top_one_can_never_be_wrong_language(self) -> None:
        # Simulates a JP card outranking the EN pick before filtering: the JP
        # entry must be removed so it can never become the top-1 under EN.
        ranked_before = [JP_CARD_BY_LANGUAGE, EN_CARD]
        filtered = SpotlightScanService._filter_candidates_by_scan_language(ranked_before, "english")
        self.assertEqual(filtered[0], EN_CARD)


class CandidateIsJapaneseKeyCasingTests(unittest.TestCase):
    def test_detects_japanese_via_visual_entry_key_spellings(self) -> None:
        # Visual index entries use setId / providerCardId (not setID / id).
        self.assertTrue(
            SpotlightScanService._candidate_is_japanese(
                {"setId": "sv1_ja", "providerCardId": "sv1_ja-100", "language": ""}
            )
        )
        self.assertTrue(
            SpotlightScanService._candidate_is_japanese(
                {"providerCardId": "sv2a_ja-7", "language": "Unknown"}
            )
        )
        self.assertFalse(
            SpotlightScanService._candidate_is_japanese(
                {"setId": "base1", "providerCardId": "base1-4", "language": "English"}
            )
        )


class FilterVisualMatchesByScanLanguageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.matches = [
            SimpleNamespace(entry={"providerCardId": "base1-4", "setId": "base1", "language": "English"}),
            SimpleNamespace(entry={"providerCardId": "sv1a-1", "setId": "sv1a", "language": "Japanese"}),
            SimpleNamespace(entry={"providerCardId": "sv2_ja-9", "setId": "sv2_ja", "language": "Unknown"}),
        ]

    def test_english_toggle_keeps_only_non_japanese_entries(self) -> None:
        filtered = SpotlightScanService._filter_visual_matches_by_scan_language(self.matches, "english")
        self.assertEqual([m.entry["providerCardId"] for m in filtered], ["base1-4"])

    def test_japanese_toggle_keeps_only_japanese_entries(self) -> None:
        filtered = SpotlightScanService._filter_visual_matches_by_scan_language(self.matches, "japanese")
        self.assertEqual([m.entry["providerCardId"] for m in filtered], ["sv1a-1", "sv2_ja-9"])

    def test_no_toggle_returns_all_matches(self) -> None:
        filtered = SpotlightScanService._filter_visual_matches_by_scan_language(self.matches, None)
        self.assertEqual(len(filtered), 3)


if __name__ == "__main__":
    unittest.main()
