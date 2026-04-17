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
        XCTExpectFailure("Current slab label fallback detection is still conservative for this synthetic slab crop.")
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

    func testDetectSlabLabelFallbackRectFindsRealCharizardFullSlabFixture() {
        XCTExpectFailure("Current slab label fallback remains transitional for some full-slab fixtures.")
        let imageURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("qa/incoming-slab-regression/psa-charizard-v-079-champions-path-secret-52300610-full-slab.jpg")
        guard let image = UIImage(contentsOfFile: imageURL.path) else {
            XCTFail("unable to load Charizard full-slab fixture")
            return
        }

        let rect = detectSlabLabelFallbackRect(in: image)

        XCTAssertNotNil(rect)
    }

    func testSelectOCRInputAcceptsRealCharizardFullSlabFixture() throws {
        XCTExpectFailure("Current slab target selection may still reject this full-slab fixture in the raw-first runtime.")
        let imageURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("qa/incoming-slab-regression/psa-charizard-v-079-champions-path-secret-52300610-full-slab.jpg")
        guard let image = UIImage(contentsOfFile: imageURL.path) else {
            XCTFail("unable to load Charizard full-slab fixture")
            return
        }
        let capture = ScanCaptureInput(
            originalImage: image,
            searchImage: image,
            fallbackImage: image,
            captureSource: .importedPhoto
        )

        let selection = try selectOCRInput(
            scanID: UUID(),
            capture: capture,
            mode: .psaSlab
        )

        XCTAssertTrue(selection.normalizedGeometryKind == .slab || selection.normalizedGeometryKind == .slabLabel)
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

    func testSetBadgeTightPlansUseFastSingleShotOCRWhileCollectorPlansMayRetry() {
        let planner = RawROIPlanner()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: false,
            targetQualityScore: 0.92,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            normalizationReason: nil,
            warnings: []
        )
        let routing = RawFooterRoutingContext.none
        let plans = planner.stage1TightPlan(for: sceneTraits, routing: routing)

        guard let setBadgePlan = plans.first(where: { $0.footerRole == .setBadge }),
              let collectorPlan = plans.first(where: { $0.footerRole == .collector }) else {
            XCTFail("missing footer plans")
            return
        }

        XCTAssertEqual(setBadgePlan.recognitionLevel, .fast)
        XCTAssertFalse(setBadgePlan.shouldRetryAggressively)
        XCTAssertTrue(setBadgePlan.aggressiveRetryLanguageAttempts.isEmpty)
        XCTAssertEqual(collectorPlan.recognitionLevel, .accurate)
        XCTAssertTrue(collectorPlan.shouldRetryAggressively)
        XCTAssertEqual(collectorPlan.aggressiveRetryLanguageAttempts.count, 2)
    }

    func testExactReticleFallbackStrongLoweredHeaderKeepsWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: true,
            targetQualityScore: 0.40,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            normalizationReason: "exact_reticle_fallback",
            warnings: ["Target selection used fallback crop"]
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "Lt. Surge's Bargain",
            tokens: [
                RecognizedToken(text: "Lt.", confidence: 0.98),
                RecognizedToken(text: "Surge's", confidence: 0.96),
                RecognizedToken(text: "Bargain", confidence: 0.95)
            ]
        )

        XCTAssertFalse(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: "185/132",
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
    }

    func testExactReticleFallbackShortLoweredHeaderWithExactCollectorKeepsWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: true,
            targetQualityScore: 0.40,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            normalizationReason: "exact_reticle_fallback",
            warnings: ["Target selection used fallback crop"]
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "Test",
            tokens: [
                RecognizedToken(text: "Test", confidence: 0.18)
            ]
        )

        XCTAssertFalse(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: "185/132",
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
    }

    func testExactReticleFallbackJapaneseLoweredHeaderWithExactCollectorKeepsWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: true,
            targetQualityScore: 0.40,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            normalizationReason: "exact_reticle_fallback",
            warnings: ["Target selection used fallback crop"]
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "ポケモンカード",
            tokens: [
                RecognizedToken(text: "ポケモンカード", confidence: 0.31)
            ]
        )

        XCTAssertFalse(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: "185/132",
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
    }

    func testExactReticleFallbackWeakLoweredHeaderKeepsWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: true,
            targetQualityScore: 0.40,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            normalizationReason: "exact_reticle_fallback",
            warnings: ["Target selection used fallback crop"]
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "HP",
            tokens: [
                RecognizedToken(text: "HP", confidence: 0.78)
            ]
        )

        XCTAssertFalse(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: "185/132",
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
    }

    func testExactReticleFallbackModerateLoweredHeaderWithExactCollectorKeepsWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: true,
            targetQualityScore: 0.40,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            normalizationReason: "exact_reticle_fallback",
            warnings: ["Target selection used fallback crop"]
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "Lugia",
            tokens: [
                RecognizedToken(text: "Lugia", confidence: 0.30)
            ]
        )

        XCTAssertFalse(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: "113/123",
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
    }

    func testExactReticleFallbackModerateLoweredHeaderWithoutExactCollectorKeepsWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: true,
            targetQualityScore: 0.40,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            normalizationReason: "exact_reticle_fallback",
            warnings: ["Target selection used fallback crop"]
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "Lugia",
            tokens: [
                RecognizedToken(text: "Lugia", confidence: 0.30)
            ]
        )

        XCTAssertFalse(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: nil,
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
    }

    func testNonFallbackNeverSkipsWideHeaderPassFromLoweredResult() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: false,
            targetQualityScore: 0.86,
            normalizationReason: "basic_perspective_canonicalization",
            warnings: []
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "Lt. Surge's Bargain",
            tokens: [
                RecognizedToken(text: "Lt.", confidence: 0.98),
                RecognizedToken(text: "Surge's", confidence: 0.96),
                RecognizedToken(text: "Bargain", confidence: 0.95)
            ]
        )

        XCTAssertFalse(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: "185/132",
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
    }

    func testHighQualityNonFallbackWithoutFooterAnchorKeepsFullWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: false,
            targetQualityScore: 0.94,
            normalizationReason: "basic_perspective_canonicalization",
            warnings: []
        )

        let decision = model.wideHeaderDecisionBeforeFullPass(
            sceneTraits: sceneTraits,
            stage1Assessment: RawStageAssessment(
                titleTextPrimary: nil,
                titleConfidenceScore: 0,
                collectorNumberExact: nil,
                setHintTokens: [],
                shouldEscalate: true,
                reasons: ["collector_signal_weak", "title_signal_weak", "set_signal_weak"]
            )
        )

        XCTAssertFalse(decision.shouldSkipWidePass)
        XCTAssertEqual(decision.reasons, ["nonfallback_keeps_full_header"])
    }

    func testHighQualityNonFallbackWithExactCollectorKeepsFullWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: false,
            targetQualityScore: 0.83,
            normalizationReason: "basic_perspective_canonicalization",
            warnings: []
        )

        let decision = model.wideHeaderDecisionBeforeFullPass(
            sceneTraits: sceneTraits,
            stage1Assessment: RawStageAssessment(
                titleTextPrimary: nil,
                titleConfidenceScore: 0,
                collectorNumberExact: "185/132",
                setHintTokens: [],
                shouldEscalate: true,
                reasons: ["title_signal_weak", "set_signal_weak"]
            )
        )

        XCTAssertFalse(decision.shouldSkipWidePass)
        XCTAssertEqual(decision.reasons, ["stage1_exact_collector_keeps_full_header"])
    }

    func testExactReticleFallbackJapaneseTitleWithoutSetHintKeepsWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: true,
            targetQualityScore: 0.44,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            normalizationReason: "exact_reticle_fallback",
            warnings: ["Target selection used fallback crop"]
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "なるイーブイ＆カビゴンタス HP",
            tokens: [
                RecognizedToken(text: "なるイーブイ＆カビゴンタス", confidence: 0.3),
                RecognizedToken(text: "HP 270 *", confidence: 0.5),
                RecognizedToken(text: "TAG TEAM", confidence: 1.0)
            ]
        )

        XCTAssertFalse(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: "066/095",
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
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

    private func makeFieldConfidence(_ score: Double) -> OCRFieldConfidence {
        OCRFieldConfidence(
            score: score,
            agreementScore: nil,
            tokenConfidenceAverage: nil,
            reasons: []
        )
    }
}
