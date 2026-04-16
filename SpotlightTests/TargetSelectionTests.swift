import XCTest
import UIKit
@testable import Spotlight

final class TargetSelectionTests: XCTestCase {
    func testChooseBestSelectionCandidateRankAcceptsClearLeader() {
        let candidates = [
            OCRTestSupport.makeCandidate(rank: 1, totalScore: 0.82, aspectScore: 0.83, proximityScore: 0.85),
            OCRTestSupport.makeCandidate(rank: 2, totalScore: 0.64, aspectScore: 0.72, proximityScore: 0.73),
        ]

        XCTAssertEqual(chooseBestSelectionCandidateRank(from: candidates, mode: .rawCard), 1)
        XCTAssertEqual(chooseBestSelectionCandidateRank(from: candidates, mode: .psaSlab), 1)
    }

    func testChooseBestSelectionCandidateRankRejectsAmbiguousLeader() {
        let candidates = [
            OCRTestSupport.makeCandidate(rank: 1, totalScore: 0.64, aspectScore: 0.81, proximityScore: 0.80),
            OCRTestSupport.makeCandidate(rank: 2, totalScore: 0.61, aspectScore: 0.79, proximityScore: 0.78),
        ]

        XCTAssertNil(chooseBestSelectionCandidateRank(from: candidates, mode: .rawCard))
    }

    func testChooseBestSelectionCandidateRankRejectsWeakAspectOrProximity() {
        let weakAspect = [
            OCRTestSupport.makeCandidate(rank: 1, totalScore: 0.86, aspectScore: 0.40, proximityScore: 0.92),
            OCRTestSupport.makeCandidate(rank: 2, totalScore: 0.60, aspectScore: 0.62, proximityScore: 0.63),
        ]
        let weakProximity = [
            OCRTestSupport.makeCandidate(rank: 1, totalScore: 0.86, aspectScore: 0.80, proximityScore: 0.31),
            OCRTestSupport.makeCandidate(rank: 2, totalScore: 0.60, aspectScore: 0.62, proximityScore: 0.63),
        ]

        XCTAssertNil(chooseBestSelectionCandidateRank(from: weakAspect, mode: .rawCard))
        XCTAssertNil(chooseBestSelectionCandidateRank(from: weakProximity, mode: .rawCard))
    }

    func testReticleCropLooksLikeRawCardSeparatesCardLikeAndDarkCrops() {
        let cardLike = OCRTestSupport.makeImage(size: CGSize(width: 320, height: 460)) { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))

            let cardRect = CGRect(x: 50, y: 23, width: 220, height: 414)
            UIColor(red: 0.94, green: 0.90, blue: 0.76, alpha: 1).setFill()
            context.fill(cardRect)

            UIColor(red: 0.16, green: 0.43, blue: 0.84, alpha: 1).setFill()
            context.fill(CGRect(x: 68, y: 48, width: 184, height: 88))

            UIColor(red: 0.92, green: 0.32, blue: 0.41, alpha: 1).setFill()
            context.fill(CGRect(x: 72, y: 316, width: 176, height: 94))
        }
        let darkCrop = OCRTestSupport.makeImage(size: CGSize(width: 320, height: 460)) { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))
        }

        XCTAssertTrue(reticleCropLooksLikeRawCard(cardLike))
        XCTAssertFalse(reticleCropLooksLikeRawCard(darkCrop))
    }

    func testSelectOCRInputProducesFallbackNormalizedOutputForCenteredRawFixture() throws {
        let sourceImage = try OCRTestSupport.loadFixtureImage(named: "raw_centered_clean")
        let capture = ScanCaptureInput(
            originalImage: sourceImage,
            searchImage: sourceImage,
            fallbackImage: sourceImage,
            captureSource: .importedPhoto
        )

        let result = try selectOCRInput(
            scanID: UUID(),
            capture: capture,
            mode: .rawCard
        )

        XCTAssertTrue(result.usedFallback)
        XCTAssertEqual(result.fallbackReason, "best_rectangle_aspect_mismatch")
        XCTAssertEqual(result.normalizedGeometryKind, .fallback)
        XCTAssertNil(result.chosenCandidateIndex)
        XCTAssertGreaterThanOrEqual(result.selectionConfidence, 0.55)
        XCTAssertEqual(result.normalizationReason, "exact_reticle_fallback")
        XCTAssertGreaterThan(result.normalizedImage.size.width, 600)
        XCTAssertGreaterThan(result.normalizedImage.size.height, 800)
    }

    func testSelectOCRInputFallsBackForLowConfidenceFixture() throws {
        let sourceImage = try OCRTestSupport.loadFixtureImage(named: "raw_low_confidence_fallback")
        let capture = ScanCaptureInput(
            originalImage: sourceImage,
            searchImage: sourceImage,
            fallbackImage: sourceImage,
            captureSource: .importedPhoto
        )

        let result = try selectOCRInput(
            scanID: UUID(),
            capture: capture,
            mode: .rawCard
        )

        XCTAssertTrue(result.usedFallback)
        XCTAssertEqual(result.normalizedGeometryKind, .fallback)
        XCTAssertNotNil(result.fallbackReason)
        XCTAssertEqual(result.normalizationReason, "exact_reticle_fallback")
        XCTAssertLessThan(result.selectionConfidence, 0.60)
        XCTAssertGreaterThanOrEqual(result.normalizedContentRect?.width ?? 0, 0.99)
        XCTAssertGreaterThanOrEqual(result.normalizedContentRect?.height ?? 0, 0.99)
    }
}
