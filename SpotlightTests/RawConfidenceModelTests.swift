import XCTest
@testable import Spotlight

final class RawConfidenceModelTests: XCTestCase {
    func testWideFooterBandBeatsSingleNoisyCornerCollector() {
        let model = RawConfidenceModel()

        let passResults = [
            RawOCRPassResult(
                kind: .footerBandWide,
                label: "13_raw_footer_band",
                normalizedRect: OCRNormalizedRect(x: 0, y: 0.78, width: 1, height: 0.22),
                text: "next turn. weakness resistance retreat cost LV. 29 #80 ilus. Ken Sugimorl 61999-2000 Viardi 60/132",
                tokens: [
                    RecognizedToken(text: "60/132", confidence: 0.5),
                ]
            ),
            RawOCRPassResult(
                kind: .footerLeft,
                label: "14_raw_footer_left",
                normalizedRect: OCRNormalizedRect(x: 0, y: 0.8, width: 0.42, height: 0.18),
                text: "resist: 01995,0%",
                tokens: [
                    RecognizedToken(text: "resist:", confidence: 0.5),
                    RecognizedToken(text: "01995,0%", confidence: 0.3),
                ]
            ),
            RawOCRPassResult(
                kind: .footerRight,
                label: "15_raw_footer_right",
                normalizedRect: OCRNormalizedRect(x: 0.56, y: 0.8, width: 0.44, height: 0.18),
                text: "",
                tokens: []
            ),
        ]

        let summary = model.summarizeEvidence(from: passResults)

        XCTAssertEqual(summary.collector.exact, "60/132")
        XCTAssertEqual(summary.collector.confidence?.reasons, ["rewrite_raw_footer_band_preferred_over_single_corner"])
        XCTAssertFalse(summary.collector.wasCornerConfirmed)
    }

    func testExactCollectorWithoutSetHintsEscalatesStageTwo() {
        let model = RawConfidenceModel()

        let passResults = [
            RawOCRPassResult(
                kind: .footerBandWide,
                label: "13_raw_footer_band",
                normalizedRect: OCRNormalizedRect(x: 0, y: 0.78, width: 1, height: 0.22),
                text: "Illus. Yukihiro Tada 199/182 Pokemon Nintendo Creatures GAME FREAK",
                tokens: [
                    RecognizedToken(text: "199/182", confidence: 1),
                ]
            ),
            RawOCRPassResult(
                kind: .footerLeft,
                label: "14_raw_footer_left",
                normalizedRect: OCRNormalizedRect(x: 0, y: 0.8, width: 0.42, height: 0.18),
                text: "199/182",
                tokens: [
                    RecognizedToken(text: "199/182", confidence: 0.5),
                ]
            ),
            RawOCRPassResult(
                kind: .footerRight,
                label: "15_raw_footer_right",
                normalizedRect: OCRNormalizedRect(x: 0.56, y: 0.8, width: 0.44, height: 0.18),
                text: "",
                tokens: []
            ),
        ]

        let assessment = model.assessStage1(
            passResults: passResults,
            sceneTraits: RawSceneTraits(
                usedFallback: true,
                holderLikely: false,
                targetQualityScore: 0.80,
                warnings: ["Target selection used fallback crop"]
            )
        )

        XCTAssertTrue(assessment.shouldEscalate)
        XCTAssertEqual(assessment.collectorNumberExact, "199/182")
        XCTAssertEqual(assessment.setHintTokens, [])
    }

    func testExactCollectorFallbackStillEscalatesStageTwoWhenTargetQualityIsLow() {
        let model = RawConfidenceModel()

        let passResults = [
            RawOCRPassResult(
                kind: .footerBandWide,
                label: "13_raw_footer_band",
                normalizedRect: OCRNormalizedRect(x: 0, y: 0.78, width: 1, height: 0.22),
                text: "メガシンカeXルール Mus. DOM м2a 232/193 MA",
                tokens: [
                    RecognizedToken(text: "232/193", confidence: 0.82),
                ]
            )
        ]

        let assessment = model.assessStage1(
            passResults: passResults,
            sceneTraits: RawSceneTraits(
                usedFallback: true,
                holderLikely: false,
                targetQualityScore: 0.49,
                warnings: [
                    "Target selection used fallback crop",
                    "Target selection confidence is weak",
                ]
            )
        )

        XCTAssertTrue(assessment.shouldEscalate)
        XCTAssertEqual(assessment.collectorNumberExact, "232/193")
        XCTAssertEqual(assessment.setHintTokens, [])
        XCTAssertTrue(assessment.reasons.contains("fallback_exact_collector_allows_header_rescue"))
    }

    func testBareAlphaSetHintFromFooterMetadataIsAccepted() {
        let model = RawConfidenceModel()

        let passResults = [
            RawOCRPassResult(
                kind: .footerLeft,
                label: "14_raw_footer_left",
                normalizedRect: OCRNormalizedRect(x: 0.03, y: 0.845, width: 0.48, height: 0.105),
                text: "Illus. Yukihiro Tada DRI 199/182",
                tokens: [
                    RecognizedToken(text: "Illus. Yukihiro Tada", confidence: 0.3),
                    RecognizedToken(text: "DRI", confidence: 1),
                    RecognizedToken(text: "199/182", confidence: 1),
                ]
            )
        ]

        let summary = model.summarizeEvidence(from: passResults)

        XCTAssertEqual(summary.collector.exact, "199/182")
        XCTAssertEqual(summary.set.hints, ["dri"])
        XCTAssertEqual(summary.set.confidence?.reasons, ["rewrite_raw_footer_corners_set_hints"])
    }

    func testNearMissAlphaSetHintIsFuzzyMatched() {
        let model = RawConfidenceModel()

        let passResults = [
            RawOCRPassResult(
                kind: .footerLeft,
                label: "14_raw_footer_left",
                normalizedRect: OCRNormalizedRect(x: 0.01, y: 0.90, width: 0.42, height: 0.09),
                text: "U DRIM 199//183",
                tokens: [
                    RecognizedToken(text: "U DRIM 199//183", confidence: 0.3)
                ]
            )
        ]

        let summary = model.summarizeEvidence(from: passResults)

        XCTAssertEqual(summary.set.hints, ["dri"])
    }
}
