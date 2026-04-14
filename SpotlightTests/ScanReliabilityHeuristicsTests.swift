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

    func testDetectSlabLabelFallbackRectFindsTopLabelInNoisySlabCrop() {
        let image = makeImage(size: CGSize(width: 420, height: 720)) { context in
            UIColor(red: 0.96, green: 0.94, blue: 0.88, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 420, height: 720))

            UIColor(white: 0.85, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 420, height: 220))

            UIColor(white: 0.28, alpha: 1).setFill()
            context.fill(CGRect(x: 58, y: 210, width: 304, height: 450))

            UIColor(red: 0.89, green: 0.12, blue: 0.12, alpha: 1).setFill()
            context.fill(CGRect(x: 82, y: 248, width: 256, height: 78))

            UIColor.white.setFill()
            context.fill(CGRect(x: 96, y: 260, width: 228, height: 54))

            UIColor(white: 0.12, alpha: 1).setFill()
            context.fill(CGRect(x: 102, y: 292, width: 72, height: 10))
            context.fill(CGRect(x: 248, y: 266, width: 56, height: 30))

            UIColor(red: 0.18, green: 0.42, blue: 0.27, alpha: 1).setFill()
            context.fill(CGRect(x: 88, y: 340, width: 244, height: 282))

            UIColor(red: 0.78, green: 0.18, blue: 0.20, alpha: 1).setFill()
            context.fill(CGRect(x: 220, y: 390, width: 76, height: 120))
        }

        let rect = detectSlabLabelFallbackRect(in: image)

        XCTAssertNotNil(rect)
        XCTAssertLessThan(rect?.y ?? 1, 0.42)
        XCTAssertGreaterThan(rect?.width ?? 0, 0.40)
        XCTAssertLessThan(rect?.height ?? 1, 0.22)
    }

    func testDetectSlabLabelFallbackRectRejectsPlainDarkCrop() {
        let image = makeImage(size: CGSize(width: 420, height: 720)) { context in
            UIColor(white: 0.18, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 420, height: 720))
        }

        XCTAssertNil(detectSlabLabelFallbackRect(in: image))
    }

    func testDetectSlabLabelFallbackRectIgnoresRedCardArtBelowGuideBand() {
        let image = makeImage(size: CGSize(width: 420, height: 720)) { context in
            UIColor(red: 0.96, green: 0.94, blue: 0.88, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 420, height: 720))

            UIColor(white: 0.78, alpha: 1).setFill()
            context.fill(CGRect(x: 52, y: 86, width: 316, height: 568))

            UIColor(red: 0.89, green: 0.13, blue: 0.13, alpha: 1).setFill()
            context.fill(CGRect(x: 80, y: 112, width: 260, height: 76))

            UIColor.white.setFill()
            context.fill(CGRect(x: 96, y: 126, width: 228, height: 46))

            UIColor(white: 0.15, alpha: 1).setFill()
            context.fill(CGRect(x: 102, y: 140, width: 118, height: 10))
            context.fill(CGRect(x: 266, y: 126, width: 44, height: 30))

            UIColor(red: 0.86, green: 0.31, blue: 0.15, alpha: 1).setFill()
            context.fill(CGRect(x: 86, y: 250, width: 248, height: 220))

            UIColor(red: 0.80, green: 0.08, blue: 0.10, alpha: 1).setFill()
            context.fill(CGRect(x: 132, y: 300, width: 168, height: 180))
        }

        let rect = detectSlabLabelFallbackRect(in: image)

        XCTAssertNotNil(rect)
        XCTAssertLessThan((rect?.y ?? 1) + (rect?.height ?? 1), PSASlabGuidance.labelDividerRatio + 0.11)
        XCTAssertLessThan(rect?.height ?? 1, 0.22)
    }

    func testSelectOCRInputRejectsBroadSlabFallbackWhenNoPSASlabOrLabelIsFound() {
        let image = makeImage(size: CGSize(width: 420, height: 720)) { context in
            UIColor(white: 0.18, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 420, height: 720))
        }
        let capture = ScanCaptureInput(
            originalImage: image,
            searchImage: image,
            fallbackImage: image,
            captureSource: .importedPhoto
        )

        XCTAssertThrowsError(
            try selectOCRInput(
                scanID: UUID(),
                capture: capture,
                mode: .psaSlab
            )
        ) { error in
            XCTAssertEqual(
                error.localizedDescription,
                "Could not isolate the PSA slab or label. Fit the full slab inside the reticle and keep the label above the guide."
            )
        }
    }

    func testPSASlabGuideBandMatchesTopLabelOCRRegion() {
        XCTAssertEqual(PSASlabGuidance.labelDividerRatio, 0.28, accuracy: 0.001)
        XCTAssertEqual(
            SlabScanConfiguration.default.labelOCR.topLabelWideRegion.height,
            PSASlabGuidance.labelDividerRatio,
            accuracy: 0.001
        )
        XCTAssertEqual(SlabScanConfiguration.default.labelOCR.topLabelWideRegion.minY, 0, accuracy: 0.001)
        XCTAssertGreaterThan(
            SlabScanConfiguration.default.labelOCR.topLabelExpandedRegion.height,
            SlabScanConfiguration.default.labelOCR.topLabelWideRegion.height
        )
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

    func testSlabResponsesDoNotAutoAcceptEvenWhenHighConfidence() {
        let response = makeMatchResponse(
            confidence: .high,
            reviewDisposition: .ready,
            resolverMode: .psaSlab
        )

        XCTAssertFalse(shouldAutoAccept(response))
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

    private func shouldShortCircuitBackendMatch(_ analysis: AnalyzedCapture) -> Bool {
        guard analysis.resolverModeHint == .rawCard else {
            return false
        }

        let rawEvidence = analysis.ocrAnalysis?.rawEvidence
        let hasExactCollector = normalizedNonEmpty(analysis.collectorNumber) != nil
            || normalizedNonEmpty(rawEvidence?.collectorNumberExact) != nil
        let hasTrustedTitle = normalizedNonEmpty(rawEvidence?.titleTextPrimary) != nil
            || normalizedNonEmpty(rawEvidence?.titleTextSecondary) != nil
        let hasSetHints = !(rawEvidence?.setHints ?? analysis.setHintTokens).isEmpty
            || analysis.setBadgeHint != nil
            || rawEvidence?.setBadgeHint != nil

        guard analysis.cropConfidence <= 0.40 else {
            return false
        }

        return !hasExactCollector && !hasTrustedTitle && !hasSetHints
    }

    private func normalizedNonEmpty(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func makeMatchResponse(
        confidence: MatchConfidence,
        reviewDisposition: ReviewDisposition,
        resolverMode: ResolverMode = .rawCard
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
            resolverMode: resolverMode,
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
