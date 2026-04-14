import XCTest
import UIKit
@testable import Spotlight

final class ScanReliabilityHeuristicsTests: XCTestCase {
    func testReticleCropLooksLikeRawCardRejectsBlankDarkCrop() {
        let image = makeImage(size: CGSize(width: 320, height: 460)) { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))
        }

        XCTAssertFalse(reticleCropLooksLikeRawCard(image))
    }

    func testReticleCropLooksLikeRawCardAcceptsCardLikeCrop() {
        let image = makeImage(size: CGSize(width: 320, height: 460)) { context in
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

        XCTAssertTrue(reticleCropLooksLikeRawCard(image))
    }

    func testShouldShortCircuitBackendMatchForLowSignalRawAnalysis() {
        let analysis = makeAnalyzedCapture(
            cropConfidence: 0.40,
            collectorNumber: nil,
            setHintTokens: [],
            setBadgeHint: nil,
            rawEvidence: OCRRawEvidence(
                titleTextPrimary: nil,
                titleTextSecondary: nil,
                titleConfidence: nil,
                collectorNumberExact: nil,
                collectorNumberPartial: "193",
                collectorConfidence: nil,
                setBadgeHint: nil,
                setHints: [],
                setConfidence: nil,
                footerBandText: "",
                wholeCardText: "",
                warnings: []
            )
        )

        XCTAssertTrue(shouldShortCircuitBackendMatch(analysis))
    }

    func testShouldShortCircuitBackendMatchAllowsExactCollectorSignal() {
        let analysis = makeAnalyzedCapture(
            cropConfidence: 0.40,
            collectorNumber: "057/193",
            setHintTokens: [],
            setBadgeHint: nil,
            rawEvidence: OCRRawEvidence(
                titleTextPrimary: nil,
                titleTextSecondary: nil,
                titleConfidence: nil,
                collectorNumberExact: "057/193",
                collectorNumberPartial: nil,
                collectorConfidence: OCRFieldConfidence.unknown,
                setBadgeHint: nil,
                setHints: [],
                setConfidence: nil,
                footerBandText: "",
                wholeCardText: "",
                warnings: []
            )
        )

        XCTAssertFalse(shouldShortCircuitBackendMatch(analysis))
    }

    func testDoesNotFastRejectWeakRawTargetSelectionForExactReticleFallback() {
        let image = makeImage(size: CGSize(width: 320, height: 460)) { context in
            UIColor.darkGray.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))
        }
        let targetSelection = OCRTargetSelectionResult(
            normalizedImage: image,
            normalizedContentRect: nil,
            selectionConfidence: 0.40,
            usedFallback: true,
            fallbackReason: "no_rectangle_detected",
            chosenCandidateIndex: nil,
            candidates: [],
            normalizedGeometryKind: .fallback,
            normalizationReason: "exact_reticle_fallback"
        )

        XCTAssertFalse(shouldFastRejectWeakRawTargetSelection(targetSelection))
    }

    func testDoesNotFastRejectRecoverableWeakTargetSelection() {
        let image = makeImage(size: CGSize(width: 320, height: 460)) { context in
            UIColor.darkGray.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))
        }
        let targetSelection = OCRTargetSelectionResult(
            normalizedImage: image,
            normalizedContentRect: nil,
            selectionConfidence: 0.52,
            usedFallback: true,
            fallbackReason: "multiple_rectangles_too_close_to_call",
            chosenCandidateIndex: nil,
            candidates: [],
            normalizedGeometryKind: .fallback,
            normalizationReason: "exact_reticle_fallback"
        )

        XCTAssertFalse(shouldFastRejectWeakRawTargetSelection(targetSelection))
    }

    func testLowConfidenceResponsesStayInTrayUntilTapped() {
        let response = makeMatchResponse(confidence: .low, reviewDisposition: .ready)

        XCTAssertEqual(matchedStackPhase(for: response), .needsReview)
        XCTAssertFalse(shouldPresentAlternativesImmediately(for: response))
    }

    func testNeedsReviewDispositionStaysInTrayUntilTapped() {
        let response = makeMatchResponse(confidence: .medium, reviewDisposition: .needsReview)

        XCTAssertEqual(matchedStackPhase(for: response), .needsReview)
        XCTAssertFalse(shouldPresentAlternativesImmediately(for: response))
    }

    func testMediumReadyResponseStaysResolvedInTray() {
        let response = makeMatchResponse(confidence: .medium, reviewDisposition: .ready)

        XCTAssertEqual(matchedStackPhase(for: response), .resolved)
        XCTAssertFalse(shouldPresentAlternativesImmediately(for: response))
    }

    func testUnsupportedResponsesDoNotAutoOpenAlternatives() {
        let response = makeMatchResponse(confidence: .low, reviewDisposition: .unsupported)

        XCTAssertEqual(matchedStackPhase(for: response), .unsupported)
        XCTAssertFalse(shouldPresentAlternativesImmediately(for: response))
    }

    func testResultCandidateCycleStateReportsCurrentPosition() {
        let candidates = [
            makeCardCandidate(id: "a", name: "Alpha"),
            makeCardCandidate(id: "b", name: "Beta"),
            makeCardCandidate(id: "c", name: "Gamma")
        ]

        let state = resultCandidateCycleState(
            currentCardID: "b",
            topCandidates: candidates
        )

        XCTAssertEqual(state, ResultCandidateCycleState(currentIndex: 2, totalCount: 3))
    }

    func testNextResultCandidateWrapsAround() {
        let candidates = [
            makeCardCandidate(id: "a", name: "Alpha"),
            makeCardCandidate(id: "b", name: "Beta"),
            makeCardCandidate(id: "c", name: "Gamma")
        ]

        XCTAssertEqual(nextResultCandidate(currentCardID: "c", topCandidates: candidates)?.id, "a")
    }

    func testInvalidReticleCaptureRectRejectsZeroOrInfiniteBounds() {
        XCTAssertFalse(isValidReticleCaptureRect(.zero))
        XCTAssertFalse(isValidReticleCaptureRect(CGRect(x: CGFloat.infinity, y: 0, width: 10, height: 10)))
    }

    func testValidReticleCaptureRectAcceptsFiniteSizedBounds() {
        XCTAssertTrue(isValidReticleCaptureRect(CGRect(x: 10, y: 20, width: 240, height: 340)))
    }

    func testBroadFooterExactCollectorSkipsTightFooterPasses() {
        let model = RawConfidenceModel()
        let broadPass = RawOCRPassResult(
            kind: .footerBandWide,
            label: "13_raw_footer_band",
            normalizedRect: OCRNormalizedRect(x: 0.0, y: 0.78, width: 1.0, height: 0.22),
            text: "S10 072/070",
            tokens: [
                RecognizedToken(text: "S10", confidence: 0.92),
                RecognizedToken(text: "072/070", confidence: 0.94)
            ]
        )

        XCTAssertTrue(model.shouldSkipTightFooterPasses(after: [broadPass]))
    }

    func testBroadFooterWithoutExactCollectorKeepsTightFooterPasses() {
        let model = RawConfidenceModel()
        let broadPass = RawOCRPassResult(
            kind: .footerBandWide,
            label: "13_raw_footer_band",
            normalizedRect: OCRNormalizedRect(x: 0.0, y: 0.78, width: 1.0, height: 0.22),
            text: "S10",
            tokens: [
                RecognizedToken(text: "S10", confidence: 0.92)
            ]
        )

        XCTAssertFalse(model.shouldSkipTightFooterPasses(after: [broadPass]))
    }

    func testResolvedReticleCaptureRectFallsBackToLayoutWhenPreferredBoundsAreZero() {
        let layout = ScannerReticleLayout(
            width: 260,
            height: 364,
            topSpacing: 175,
            controlsTopSpacing: 16,
            controlsHeight: 36,
            bottomClearance: 120
        )

        let resolved = resolvedReticleCaptureRect(
            preferred: .zero,
            containerFrame: CGRect(x: 0, y: 0, width: 390, height: 844),
            layout: layout
        )

        XCTAssertEqual(resolved.origin.x, 65, accuracy: 0.5)
        XCTAssertEqual(resolved.origin.y, 175, accuracy: 0.5)
        XCTAssertEqual(resolved.width, 260, accuracy: 0.5)
        XCTAssertEqual(resolved.height, 364, accuracy: 0.5)
    }

    func testResolvedReticleCaptureRectPrefersMeasuredBoundsWhenValid() {
        let preferred = CGRect(x: 64.7, y: 175.0, width: 260.6, height: 364.0)
        let layout = ScannerReticleLayout(
            width: 260,
            height: 364,
            topSpacing: 175,
            controlsTopSpacing: 16,
            controlsHeight: 36,
            bottomClearance: 120
        )

        let resolved = resolvedReticleCaptureRect(
            preferred: preferred,
            containerFrame: CGRect(x: 0, y: 0, width: 390, height: 844),
            layout: layout
        )

        XCTAssertEqual(resolved.origin.x, preferred.origin.x, accuracy: 0.001)
        XCTAssertEqual(resolved.origin.y, preferred.origin.y, accuracy: 0.001)
        XCTAssertEqual(resolved.width, preferred.width, accuracy: 0.001)
        XCTAssertEqual(resolved.height, preferred.height, accuracy: 0.001)
    }

    private func makeAnalyzedCapture(
        cropConfidence: Double,
        collectorNumber: String?,
        setHintTokens: [String],
        setBadgeHint: OCRSetBadgeHint?,
        rawEvidence: OCRRawEvidence
    ) -> AnalyzedCapture {
        let image = makeImage(size: CGSize(width: 320, height: 460)) { context in
            UIColor.darkGray.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))
        }

        return AnalyzedCapture(
            scanID: UUID(),
            originalImage: image,
            normalizedImage: image,
            recognizedTokens: [],
            collectorNumber: collectorNumber,
            setHintTokens: setHintTokens,
            setBadgeHint: setBadgeHint,
            promoCodeHint: nil,
            slabGrader: nil,
            slabGrade: nil,
            slabCertNumber: nil,
            slabBarcodePayloads: [],
            slabGraderConfidence: nil,
            slabGradeConfidence: nil,
            slabCertConfidence: nil,
            slabCardNumberRaw: nil,
            slabParsedLabelText: [],
            slabClassifierReasons: [],
            slabRecommendedLookupPath: nil,
            resolverModeHint: .rawCard,
            cropConfidence: cropConfidence,
            warnings: [],
            shouldRetryWithStillPhoto: false,
            stillPhotoRetryReason: nil,
            ocrAnalysis: OCRAnalysisEnvelope(
                pipelineVersion: .rewriteV1,
                selectedMode: .raw,
                normalizedTarget: nil,
                modeSanitySignals: nil,
                rawEvidence: rawEvidence,
                slabEvidence: nil
            )
        )
    }

    private func makeMatchResponse(
        confidence: MatchConfidence,
        reviewDisposition: ReviewDisposition
    ) -> ScanMatchResponse {
        let candidate = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro")

        return ScanMatchResponse(
            scanID: UUID(),
            topCandidates: [
                ScoredCandidate(
                    rank: 1,
                    candidate: candidate,
                    imageScore: 0.77,
                    collectorNumberScore: 0.91,
                    nameScore: 0.84,
                    finalScore: 0.82
                )
            ],
            confidence: confidence,
            ambiguityFlags: [],
            matcherSource: .remoteHybrid,
            matcherVersion: "test",
            resolverMode: .rawCard,
            resolverPath: .visualHybridIndex,
            slabContext: nil,
            reviewDisposition: reviewDisposition,
            reviewReason: nil,
            performance: nil
        )
    }

    private func makeCardCandidate(id: String, name: String) -> CardCandidate {
        CardCandidate(
            id: id,
            name: name,
            setName: "Gym Heroes",
            number: "60/132",
            rarity: "Rare",
            variant: "1st Edition",
            language: "English",
            imageSmallURL: nil,
            imageLargeURL: nil,
            pricing: nil
        )
    }

    private func makeImage(
        size: CGSize,
        draw: (CGContext) -> Void
    ) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        if #available(iOS 12.0, *) {
            format.preferredRange = .standard
        }
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { context in
            draw(context.cgContext)
        }
    }
}
