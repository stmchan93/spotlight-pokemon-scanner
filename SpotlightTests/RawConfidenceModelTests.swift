import XCTest
@testable import Spotlight

final class RawConfidenceModelTests: XCTestCase {
    func testWideFooterBandBeatsSingleNoisyCornerCollector() {
        let model = RawConfidenceModel()

        let passResults = [
            RawOCRPassResult(
                kind: .footerBandWide,
                label: "13_rewrite_raw_footer_band_wide",
                normalizedRect: OCRNormalizedRect(x: 0, y: 0.78, width: 1, height: 0.22),
                text: "next turn. weakness resistance retreat cost LV. 29 #80 ilus. Ken Sugimorl 61999-2000 Viardi 60/132",
                tokens: [
                    RecognizedToken(text: "60/132", confidence: 0.5),
                ]
            ),
            RawOCRPassResult(
                kind: .footerLeft,
                label: "15_rewrite_raw_footer_left",
                normalizedRect: OCRNormalizedRect(x: 0, y: 0.8, width: 0.42, height: 0.18),
                text: "resist: 01995,0%",
                tokens: [
                    RecognizedToken(text: "resist:", confidence: 0.5),
                    RecognizedToken(text: "01995,0%", confidence: 0.3),
                ]
            ),
            RawOCRPassResult(
                kind: .footerRight,
                label: "16_rewrite_raw_footer_right",
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
}
