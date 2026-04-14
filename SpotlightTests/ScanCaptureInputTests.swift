import XCTest
import UIKit
@testable import Spotlight

final class ScanCaptureInputTests: XCTestCase {
    func testTrayPreviewImageUsesExactCropForLiveCaptures() {
        let original = makeImage(
            size: CGSize(width: 300, height: 420),
            color: UIColor.red
        )
        let search = makeImage(
            size: CGSize(width: 220, height: 320),
            color: UIColor.green
        )
        let fallback = makeImage(
            size: CGSize(width: 180, height: 260),
            color: UIColor.blue
        )

        let capture = ScanCaptureInput(
            originalImage: original,
            searchImage: search,
            fallbackImage: fallback,
            captureSource: .livePreviewFrame
        )

        XCTAssertEqual(capture.trayPreviewImage.pngData(), fallback.pngData())
        XCTAssertNotEqual(capture.trayPreviewImage.pngData(), original.pngData())
        XCTAssertNotEqual(capture.trayPreviewImage.pngData(), search.pngData())
    }

    func testTrayPreviewImageFallsBackToSearchCropWhenExactCropMissing() {
        let original = makeImage(
            size: CGSize(width: 300, height: 420),
            color: UIColor.red
        )
        let search = makeImage(
            size: CGSize(width: 220, height: 320),
            color: UIColor.green
        )

        let capture = ScanCaptureInput(
            originalImage: original,
            searchImage: search,
            fallbackImage: nil,
            captureSource: .liveStillPhoto
        )

        XCTAssertEqual(capture.trayPreviewImage.pngData(), search.pngData())
        XCTAssertNotEqual(capture.trayPreviewImage.pngData(), original.pngData())
    }

    func testTrayPreviewImageUsesOriginalForImportedPhotos() {
        let original = makeImage(
            size: CGSize(width: 300, height: 420),
            color: UIColor.red
        )
        let search = makeImage(
            size: CGSize(width: 220, height: 320),
            color: UIColor.green
        )

        let capture = ScanCaptureInput(
            originalImage: original,
            searchImage: search,
            fallbackImage: nil,
            captureSource: .importedPhoto
        )

        XCTAssertEqual(capture.trayPreviewImage.pngData(), original.pngData())
        XCTAssertNotEqual(capture.trayPreviewImage.pngData(), search.pngData())
    }

    private func makeImage(size: CGSize, color: UIColor) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { context in
            color.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
    }
}

final class ScanMatchResponseTests: XCTestCase {
    func testMergingCandidateDetailsUpdatesMatchingCandidatesOnly() {
        let stalePricing = makePricing(market: 12, isFresh: false)
        let freshPricing = makePricing(market: 48, isFresh: true)
        let firstCandidate = makeCandidate(id: "base1-4", pricing: stalePricing)
        let secondCandidate = makeCandidate(id: "base1-25", pricing: nil)
        let thirdCandidate = makeCandidate(id: "base1-39", pricing: nil)

        let response = ScanMatchResponse(
            scanID: UUID(),
            topCandidates: [
                ScoredCandidate(rank: 1, candidate: firstCandidate, imageScore: 0.9, collectorNumberScore: 0.8, nameScore: 0.7, finalScore: 0.85),
                ScoredCandidate(rank: 2, candidate: secondCandidate, imageScore: 0.7, collectorNumberScore: 0.6, nameScore: 0.5, finalScore: 0.65),
                ScoredCandidate(rank: 3, candidate: thirdCandidate, imageScore: 0.5, collectorNumberScore: 0.4, nameScore: 0.3, finalScore: 0.45),
            ],
            confidence: .medium,
            ambiguityFlags: [],
            matcherSource: .remoteHybrid,
            matcherVersion: "test",
            resolverMode: .rawCard,
            resolverPath: .visualHybridIndex,
            slabContext: nil,
            reviewDisposition: .ready,
            reviewReason: nil,
            performance: nil
        )

        let hydratedSecond = CardDetail(
            card: makeCandidate(id: "base1-25", pricing: freshPricing),
            slabContext: nil,
            source: "scrydex",
            sourceRecordID: "base1-25",
            setID: nil,
            setSeries: nil,
            setReleaseDate: nil,
            supertype: nil,
            artist: nil,
            regulationMark: nil,
            imageSmallURL: nil,
            imageLargeURL: nil
        )

        let merged = response.mergingCandidateDetails([hydratedSecond])

        XCTAssertEqual(merged.topCandidates[0].candidate.pricing, stalePricing)
        XCTAssertEqual(merged.topCandidates[1].candidate.pricing, freshPricing)
        XCTAssertNil(merged.topCandidates[2].candidate.pricing)
        XCTAssertEqual(merged.topCandidates[1].finalScore, response.topCandidates[1].finalScore)
    }

    private func makeCandidate(id: String, pricing: CardPricingSummary?) -> CardCandidate {
        CardCandidate(
            id: id,
            name: "Card \(id)",
            setName: "Base Set",
            number: "1/102",
            rarity: "Rare",
            variant: "Raw",
            language: "English",
            imageSmallURL: nil,
            imageLargeURL: nil,
            pricing: pricing
        )
    }

    private func makePricing(market: Double, isFresh: Bool) -> CardPricingSummary {
        CardPricingSummary(
            source: "scrydex",
            currencyCode: "USD",
            variant: "normal",
            low: nil,
            market: market,
            mid: nil,
            high: nil,
            directLow: nil,
            trend: nil,
            updatedAt: nil,
            refreshedAt: nil,
            sourceURL: nil,
            pricingMode: "raw",
            snapshotAgeHours: isFresh ? 1 : 48,
            freshnessWindowHours: 24,
            isFresh: isFresh,
            grader: nil,
            grade: nil,
            pricingTier: nil,
            confidenceLabel: nil,
            confidenceLevel: nil,
            compCount: nil,
            recentCompCount: nil,
            lastSoldPrice: nil,
            lastSoldAt: nil,
            bucketKey: nil,
            methodologySummary: nil
        )
    }
}

final class ScanTrayPricingTests: XCTestCase {
    func testNeedsReviewSlabCanAutoRefreshWhenOptedIn() {
        XCTAssertTrue(
            ScanTrayCalculator.shouldAutoRefresh(
                pricing: nil,
                phase: .needsReview,
                allowNeedsReview: true
            )
        )
    }

    func testNeedsReviewDoesNotAutoRefreshByDefault() {
        XCTAssertFalse(
            ScanTrayCalculator.shouldAutoRefresh(
                pricing: nil,
                phase: .needsReview
            )
        )
    }

    func testAlternativeHydrationRefreshCountUsesAllAlternates() {
        XCTAssertEqual(ScanTrayCalculator.alternativeHydrationRefreshCount(totalTopCandidates: 0), 0)
        XCTAssertEqual(ScanTrayCalculator.alternativeHydrationRefreshCount(totalTopCandidates: 1), 0)
        XCTAssertEqual(ScanTrayCalculator.alternativeHydrationRefreshCount(totalTopCandidates: 5), 4)
    }

    func testUserBrowsingCandidateRefreshesWhenPricingMissing() {
        XCTAssertTrue(ScanTrayCalculator.shouldRefreshOnUserCandidateBrowse(pricing: nil))
    }

    func testUserBrowsingCandidateSkipsRefreshWhenPricingIsFresh() {
        XCTAssertFalse(
            ScanTrayCalculator.shouldRefreshOnUserCandidateBrowse(
                pricing: makePricing(market: 20, isFresh: true)
            )
        )
    }

    private func makePricing(market: Double, isFresh: Bool) -> CardPricingSummary {
        CardPricingSummary(
            source: "scrydex",
            currencyCode: "USD",
            variant: "normal",
            low: nil,
            market: market,
            mid: nil,
            high: nil,
            directLow: nil,
            trend: nil,
            updatedAt: nil,
            refreshedAt: nil,
            sourceURL: nil,
            pricingMode: "raw",
            snapshotAgeHours: isFresh ? 1 : 48,
            freshnessWindowHours: 24,
            isFresh: isFresh,
            grader: nil,
            grade: nil,
            pricingTier: nil,
            confidenceLabel: nil,
            confidenceLevel: nil,
            compCount: nil,
            recentCompCount: nil,
            lastSoldPrice: nil,
            lastSoldAt: nil,
            bucketKey: nil,
            methodologySummary: nil
        )
    }
}
