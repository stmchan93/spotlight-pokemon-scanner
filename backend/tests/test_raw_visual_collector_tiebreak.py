from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

try:
    from raw_visual_index import RawVisualSearchMatch  # noqa: E402
    from raw_visual_matcher import RawVisualMatcher  # noqa: E402

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host-python dependency fallback
    RawVisualSearchMatch = None  # type: ignore[assignment]
    RawVisualMatcher = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


def _match(row_index: int, similarity: float, *, name: str, collector_number: str | None) -> "RawVisualSearchMatch":
    return RawVisualSearchMatch(
        row_index=row_index,
        similarity=similarity,
        entry={
            "name": name,
            "collectorNumber": collector_number,
            "providerCardId": f"prov-{row_index}",
        },
    )


@unittest.skipIf(_IMPORT_ERROR is not None, f"raw visual matcher test deps unavailable: {_IMPORT_ERROR}")
class CollectorNumberTiebreakTest(unittest.TestCase):
    def _build_matcher(self, *, enabled: bool = True, margin: float = 0.03, beta: float = 0.04) -> "RawVisualMatcher":
        matcher = object.__new__(RawVisualMatcher)
        matcher.collector_tiebreak_enabled = enabled
        matcher.collector_tiebreak_margin = margin
        matcher.collector_tiebreak_beta = beta
        return matcher

    @staticmethod
    def _payload(collector_number_exact: str | None = None) -> dict:
        return {
            "ocrAnalysis": {
                "rawEvidence": {
                    "collectorNumberExact": collector_number_exact,
                }
            }
        }

    def test_ambiguous_near_tie_promotes_ocr_match_to_rank1(self) -> None:
        # Frogadier 087 (rank 1) vs Frogadier 089 (rank 2), near tie.
        # OCR reads 089 -> rank-2 candidate should move to rank 1.
        matcher = self._build_matcher()
        matches = [
            _match(0, 0.900, name="Frogadier", collector_number="087"),
            _match(1, 0.890, name="Frogadier", collector_number="089"),
            _match(2, 0.700, name="Greninja", collector_number="091"),
        ]
        result, debug = matcher._apply_collector_number_tiebreak(
            matches, self._payload("089"), top_k=3
        )

        self.assertTrue(debug["applied"])
        self.assertEqual(debug["ocrNumber"], "089")
        self.assertEqual(debug["candidatesMatched"], 1)
        self.assertEqual(result[0].entry["collectorNumber"], "089")
        self.assertTrue(result[0].entry.get("_collectorTiebreakMatched"))
        # No candidate dropped or introduced.
        self.assertEqual(len(result), 3)
        self.assertEqual(
            {m.entry["providerCardId"] for m in result},
            {m.entry["providerCardId"] for m in matches},
        )

    def test_margin_too_wide_is_noop(self) -> None:
        # Top-1 vs top-2 gap (0.08) exceeds margin (0.03) -> not a tie.
        matcher = self._build_matcher(margin=0.03)
        matches = [
            _match(0, 0.900, name="Frogadier", collector_number="087"),
            _match(1, 0.820, name="Frogadier", collector_number="089"),
        ]
        result, debug = matcher._apply_collector_number_tiebreak(
            matches, self._payload("089"), top_k=2
        )

        self.assertFalse(debug["applied"])
        self.assertEqual(debug["reason"], "not_ambiguous")
        self.assertEqual(result[0].entry["collectorNumber"], "087")
        self.assertEqual([m.row_index for m in result], [0, 1])

    def test_no_ocr_number_is_noop(self) -> None:
        matcher = self._build_matcher()
        matches = [
            _match(0, 0.900, name="Frogadier", collector_number="087"),
            _match(1, 0.890, name="Frogadier", collector_number="089"),
        ]
        result, debug = matcher._apply_collector_number_tiebreak(
            matches, self._payload(None), top_k=2
        )

        self.assertFalse(debug["applied"])
        self.assertEqual(debug["reason"], "no_ocr_number")
        self.assertEqual([m.row_index for m in result], [0, 1])

    def test_flag_off_is_noop(self) -> None:
        matcher = self._build_matcher(enabled=False)
        matches = [
            _match(0, 0.900, name="Frogadier", collector_number="087"),
            _match(1, 0.890, name="Frogadier", collector_number="089"),
        ]
        result, debug = matcher._apply_collector_number_tiebreak(
            matches, self._payload("089"), top_k=2
        )

        self.assertFalse(debug["applied"])
        self.assertEqual(debug["reason"], "feature_disabled")
        self.assertIs(result, matches)

    def test_different_names_not_same_art_is_noop(self) -> None:
        # Near tie but different names -> not the same-art ambiguous case.
        matcher = self._build_matcher()
        matches = [
            _match(0, 0.900, name="Frogadier", collector_number="087"),
            _match(1, 0.895, name="Greninja", collector_number="089"),
        ]
        result, debug = matcher._apply_collector_number_tiebreak(
            matches, self._payload("089"), top_k=2
        )

        self.assertFalse(debug["applied"])
        self.assertEqual(debug["reason"], "not_ambiguous")
        self.assertFalse(debug["ambiguous"])
        self.assertEqual([m.row_index for m in result], [0, 1])

    def test_ocr_number_matches_slashed_candidate_number(self) -> None:
        # OCR reads bare '089'; candidate carries full '089/086'. The number
        # component ('089') must match.
        matcher = self._build_matcher()
        matches = [
            _match(0, 0.900, name="Frogadier", collector_number="087/086"),
            _match(1, 0.890, name="Frogadier", collector_number="089/086"),
        ]
        result, debug = matcher._apply_collector_number_tiebreak(
            matches, self._payload("089"), top_k=2
        )

        self.assertTrue(debug["applied"])
        self.assertEqual(debug["ocrNumber"], "089")
        self.assertEqual(debug["candidatesMatched"], 1)
        self.assertEqual(result[0].entry["collectorNumber"], "089/086")
        self.assertTrue(result[0].entry.get("_collectorTiebreakMatched"))

    def test_insufficient_candidates_is_noop(self) -> None:
        matcher = self._build_matcher()
        matches = [_match(0, 0.900, name="Frogadier", collector_number="087")]
        result, debug = matcher._apply_collector_number_tiebreak(
            matches, self._payload("087"), top_k=1
        )

        self.assertFalse(debug["applied"])
        self.assertEqual(debug["reason"], "insufficient_candidates")
        self.assertIs(result, matches)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
