from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    RAW_ROUTE_BROAD_TEXT_FALLBACK,
    RAW_ROUTE_COLLECTOR_ONLY,
    RAW_ROUTE_COLLECTOR_SET_EXACT,
    RAW_ROUTE_TITLE_COLLECTOR,
    RAW_ROUTE_TITLE_ONLY,
    RAW_ROUTE_TITLE_SET_PRIMARY,
    build_raw_evidence,
    build_raw_retrieval_plan,
    score_raw_signals,
)


def raw_payload(
    *,
    full_text: str = "",
    metadata_text: str = "",
    bottom_left_text: str = "",
    bottom_right_text: str = "",
    collector_number: str = "",
    set_hint_tokens: list[str] | None = None,
    promo_code_hint: str | None = None,
    recognized_tokens: list[str] | None = None,
    crop_confidence: float = 1.0,
) -> dict[str, object]:
    return {
        "scanID": "scan-phase3",
        "resolverModeHint": "raw_card",
        "fullRecognizedText": full_text,
        "metadataStripRecognizedText": metadata_text,
        "bottomLeftRecognizedText": bottom_left_text,
        "bottomRightRecognizedText": bottom_right_text,
        "topLabelRecognizedText": "",
        "collectorNumber": collector_number,
        "setHintTokens": set_hint_tokens or [],
        "promoCodeHint": promo_code_hint,
        "recognizedTokens": recognized_tokens or [],
        "cropConfidence": crop_confidence,
    }


class RawEvidencePhase3Tests(unittest.TestCase):
    def test_build_raw_evidence_extracts_title_footer_and_structured_fields(self) -> None:
        payload = raw_payload(
            full_text="Charizard ex\nAbility: Infernal Reign",
            metadata_text="OBF 223/197",
            bottom_left_text="Basic Pokemon",
            bottom_right_text="223/197",
            collector_number="223/197",
            set_hint_tokens=["OBF"],
            crop_confidence=0.92,
        )

        evidence = build_raw_evidence(payload)

        self.assertEqual(evidence.title_text_primary, "Charizard ex")
        self.assertEqual(evidence.collector_number_exact, "223/197")
        self.assertEqual(evidence.collector_number_query_values, ("223",))
        self.assertEqual(evidence.collector_number_printed_total, 197)
        self.assertIn("obf", evidence.set_hint_tokens)
        self.assertIn("obf", evidence.trusted_set_hint_tokens)
        self.assertIn("223/197", evidence.footer_band_text)

    def test_score_raw_signals_prefers_title_and_set_when_footer_is_weak(self) -> None:
        payload = raw_payload(
            full_text="Charizard ex\nAbility: Infernal Reign",
            metadata_text="OBF",
            bottom_left_text="",
            bottom_right_text="",
            collector_number="",
            set_hint_tokens=["OBF"],
            crop_confidence=0.88,
        )

        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        plan = build_raw_retrieval_plan(evidence, signals)

        self.assertGreaterEqual(signals.title_signal, 70)
        self.assertLess(signals.collector_signal, 45)
        self.assertGreaterEqual(signals.set_signal, 60)
        self.assertIn(RAW_ROUTE_TITLE_SET_PRIMARY, plan.routes)
        self.assertIn(RAW_ROUTE_TITLE_ONLY, plan.routes)
        self.assertNotIn(RAW_ROUTE_COLLECTOR_SET_EXACT, plan.routes)

    def test_score_raw_signals_handles_exact_collector_and_set_path(self) -> None:
        payload = raw_payload(
            full_text="Mew ex",
            metadata_text="MEW 151/165",
            bottom_right_text="151/165",
            collector_number="151/165",
            set_hint_tokens=["MEW"],
            crop_confidence=0.95,
        )

        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        plan = build_raw_retrieval_plan(evidence, signals)

        self.assertGreaterEqual(signals.collector_signal, 80)
        self.assertGreaterEqual(signals.set_signal, 55)
        self.assertIn(RAW_ROUTE_COLLECTOR_SET_EXACT, plan.routes)
        self.assertIn(RAW_ROUTE_COLLECTOR_ONLY, plan.routes)

    def test_build_raw_evidence_derives_partial_collector_from_footer_when_explicit_missing(self) -> None:
        payload = raw_payload(
            full_text="Sabrina's Slowbro",
            metadata_text="LV.29 #80",
            bottom_right_text="60/132",
            collector_number="",
            set_hint_tokens=[],
            crop_confidence=0.84,
        )

        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        plan = build_raw_retrieval_plan(evidence, signals)

        self.assertIsNone(evidence.collector_number_exact)
        self.assertEqual(evidence.collector_number_partial, "60/132")
        self.assertGreaterEqual(signals.collector_signal, 60)
        self.assertIn(RAW_ROUTE_TITLE_COLLECTOR, plan.routes)

    def test_build_raw_evidence_keeps_promo_hint_and_query_values(self) -> None:
        payload = raw_payload(
            full_text="Pikachu",
            metadata_text="SWSH101",
            bottom_right_text="SWSH101",
            collector_number="SWSH101",
            promo_code_hint="SWSH",
            crop_confidence=0.9,
        )

        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        plan = build_raw_retrieval_plan(evidence, signals)

        self.assertEqual(evidence.promo_code_hint, "SWSH")
        self.assertEqual(evidence.collector_number_query_values, ("swsh101",))
        self.assertEqual(evidence.collector_number_printed_total, None)
        self.assertIn(RAW_ROUTE_COLLECTOR_ONLY, plan.routes)

    def test_build_raw_retrieval_plan_falls_back_to_broad_text_when_all_specific_signals_are_weak(self) -> None:
        payload = raw_payload(
            full_text="pokemon card",
            metadata_text="",
            bottom_left_text="",
            bottom_right_text="",
            collector_number="",
            set_hint_tokens=[],
            recognized_tokens=["pokemon", "card", "glare"],
            crop_confidence=0.4,
        )

        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        plan = build_raw_retrieval_plan(evidence, signals)

        self.assertEqual(plan.routes, (RAW_ROUTE_BROAD_TEXT_FALLBACK,))
        self.assertTrue(plan.should_query_remote)


if __name__ == "__main__":
    unittest.main()
