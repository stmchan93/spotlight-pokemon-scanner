import Foundation
import UIKit
import Vision
import CoreImage
import Photos

// MARK: - Configuration

/// Configuration for raw Pokémon card scanning
struct RawCardScanConfiguration {
    struct CardDetection {
        let minimumConfidence: Float
        let minimumAspectRatio: Float
        let maximumAspectRatio: Float
        let edgeInsetPercentage: CGFloat

        static let `default` = CardDetection(
            minimumConfidence: 0.45,
            minimumAspectRatio: 0.6,
            maximumAspectRatio: 0.85,
            edgeInsetPercentage: 0.0  // Keep footer text that sits close to the card edge
        )
    }

    struct BottomRegionOCR {
        let bottomLeftRegion: CGRect
        let bottomRightRegion: CGRect
        let minimumTextHeight: Float
        let upscaleFactor: CGFloat

        static let `default` = BottomRegionOCR(
            // Cover the full footer band so slight reticle/card drift still captures the identifier.
            bottomLeftRegion: CGRect(x: 0.00, y: 0.80, width: 0.42, height: 0.18),
            bottomRightRegion: CGRect(x: 0.56, y: 0.80, width: 0.44, height: 0.18),
            minimumTextHeight: 0.001,  // Very sensitive
            upscaleFactor: 4.0  // Aggressive upscaling for tiny collector numbers
        )
    }

    struct Debug {
        let saveDebugImages: Bool
        let verboseLogging: Bool

        static let disabled = Debug(saveDebugImages: false, verboseLogging: false)
        static let enabled = Debug(saveDebugImages: true, verboseLogging: true)
    }

    let cardDetection: CardDetection
    let bottomRegionOCR: BottomRegionOCR
    let debug: Debug

    static let `default` = RawCardScanConfiguration(
        cardDetection: .default,
        bottomRegionOCR: .default,
        debug: .enabled  // Enable to see OCR debug output
    )
}

struct SlabScanConfiguration {
    struct LabelOCR {
        let primaryRegion: CGRect
        let expandedRegion: CGRect
        let minimumTextHeight: Float
        let upscaleFactor: CGFloat

        static let `default` = LabelOCR(
            primaryRegion: CGRect(x: 0.04, y: 0.00, width: 0.92, height: 0.20),
            expandedRegion: CGRect(x: 0.02, y: 0.00, width: 0.96, height: 0.30),
            minimumTextHeight: 0.008,
            upscaleFactor: 3.0
        )
    }

    struct Debug {
        let saveDebugImages: Bool
        let verboseLogging: Bool

        static let disabled = Debug(saveDebugImages: false, verboseLogging: false)
        static let enabled = Debug(saveDebugImages: true, verboseLogging: true)
    }

    let labelOCR: LabelOCR
    let debug: Debug

    static let `default` = SlabScanConfiguration(
        labelOCR: .default,
        debug: .enabled
    )
}

struct RawBroadOCRSignals: Equatable {
    let primaryTitleText: String
    let secondaryTitleText: String?
    let titleConfidence: Double
    let secondaryTitleConfidence: Double
    let footerBandText: String
    let footerBandConfidence: Double
    let footerCollectorNumber: String?
    let footerSetHintTokens: [String]
    let cropConfidence: Double
}

struct RawFooterConfirmationSignals: Equatable {
    let collectorNumber: String?
    let setHintTokens: [String]
}

struct RawCandidateHypothesis: Codable, Equatable {
    let titleText: String
    let collectorNumber: String?
    let setHintTokens: [String]
    let score: Double
    let reasons: [String]
    let sourceLabels: [String]
    let footerConfirmed: Bool
}

private struct RawRecognizedRegionResult {
    let label: String
    let normalizedRect: CGRect
    let text: String
    let tokens: [RecognizedToken]

    var averageConfidence: Double {
        guard !tokens.isEmpty else { return 0 }
        return Double(tokens.map(\.confidence).reduce(0, +)) / Double(tokens.count)
    }
}

func buildCoarseRawCandidateHypotheses(from signals: RawBroadOCRSignals) -> [RawCandidateHypothesis] {
    var hypotheses: [RawCandidateHypothesis] = []
    let footerHasCollector = signals.footerCollectorNumber != nil
    let footerHasSetHints = !signals.footerSetHintTokens.isEmpty
    let titleStrength = min(0.42, signals.titleConfidence * 0.42)
    let secondaryTitleStrength = min(0.30, signals.secondaryTitleConfidence * 0.30)
    let footerStrength = min(0.20, signals.footerBandConfidence * 0.20)
    let cropStrength = min(0.18, signals.cropConfidence * 0.18)
    let collectorStrength = footerHasCollector ? 0.18 : 0
    let setHintStrength = footerHasSetHints ? 0.08 : 0

    func appendHypothesis(
        titleText: String,
        titleScore: Double,
        sourceLabels: [String],
        baseBonus: Double
    ) {
        let normalizedTitle = titleText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTitle.isEmpty || !signals.footerBandText.isEmpty else { return }

        var reasons: [String] = []
        if !normalizedTitle.isEmpty {
            reasons.append("title/header candidate")
        }
        if !signals.footerBandText.isEmpty {
            reasons.append("footer band candidate")
        }
        if footerHasCollector {
            reasons.append("broad footer collector")
        }
        if footerHasSetHints {
            reasons.append("broad footer set hints")
        }

        hypotheses.append(
            RawCandidateHypothesis(
                titleText: normalizedTitle,
                collectorNumber: signals.footerCollectorNumber,
                setHintTokens: signals.footerSetHintTokens,
                score: baseBonus + titleScore + footerStrength + cropStrength + collectorStrength + setHintStrength,
                reasons: reasons,
                sourceLabels: sourceLabels,
                footerConfirmed: false
            )
        )
    }

    appendHypothesis(
        titleText: signals.primaryTitleText,
        titleScore: titleStrength,
        sourceLabels: ["title_header", "footer_full"],
        baseBonus: 0.18
    )

    if let secondaryTitleText = signals.secondaryTitleText,
       normalizedRawCollectorIdentifier(secondaryTitleText) != normalizedRawCollectorIdentifier(signals.primaryTitleText) {
        appendHypothesis(
            titleText: secondaryTitleText,
            titleScore: secondaryTitleStrength,
            sourceLabels: ["title_secondary", "footer_full"],
            baseBonus: 0.14
        )
    }

    if !signals.footerBandText.isEmpty {
        hypotheses.append(
            RawCandidateHypothesis(
                titleText: "",
                collectorNumber: signals.footerCollectorNumber,
                setHintTokens: signals.footerSetHintTokens,
                score: 0.14 + footerStrength + cropStrength + collectorStrength + setHintStrength,
                reasons: ["footer-only candidate"],
                sourceLabels: ["footer_full"],
                footerConfirmed: false
            )
        )
    }

    let deduped = Dictionary(grouping: hypotheses) { hypothesis in
        [
            normalizedRawCollectorIdentifier(hypothesis.titleText),
            normalizedRawCollectorIdentifier(hypothesis.collectorNumber ?? ""),
            hypothesis.setHintTokens.sorted().joined(separator: ",")
        ].joined(separator: "|")
    }
    .compactMap { $0.value.max(by: { $0.score < $1.score }) }

    return deduped.sorted { lhs, rhs in
        if lhs.score == rhs.score {
            return lhs.titleText < rhs.titleText
        }
        return lhs.score > rhs.score
    }
}

func rerankRawCandidateHypotheses(
    _ hypotheses: [RawCandidateHypothesis],
    footerConfirmation: RawFooterConfirmationSignals
) -> [RawCandidateHypothesis] {
    let footerHintSet = Set(footerConfirmation.setHintTokens)

    return hypotheses
        .map { hypothesis in
            var score = hypothesis.score
            var reasons = hypothesis.reasons
            var collectorNumber = hypothesis.collectorNumber
            var setHintTokens = hypothesis.setHintTokens
            var footerConfirmed = hypothesis.footerConfirmed

            if let confirmedCollector = footerConfirmation.collectorNumber {
                if let existingCollector = collectorNumber {
                    if normalizedRawCollectorIdentifier(existingCollector) == normalizedRawCollectorIdentifier(confirmedCollector) {
                        score += 0.22
                        reasons.append("footer corners confirm collector")
                        footerConfirmed = true
                    } else {
                        score -= 0.10
                        collectorNumber = confirmedCollector
                        reasons.append("footer corners override collector")
                    }
                } else {
                    collectorNumber = confirmedCollector
                    score += 0.24
                    footerConfirmed = true
                    reasons.append("footer corners supply collector")
                }
            }

            if !footerHintSet.isEmpty {
                let existingHints = Set(setHintTokens)
                if existingHints.isEmpty {
                    setHintTokens = footerConfirmation.setHintTokens.sorted()
                    score += 0.08
                    reasons.append("footer corners supply set hints")
                } else if !existingHints.isDisjoint(with: footerHintSet) {
                    score += 0.06
                    reasons.append("footer corners confirm set hints")
                }
            }

            return RawCandidateHypothesis(
                titleText: hypothesis.titleText,
                collectorNumber: collectorNumber,
                setHintTokens: setHintTokens,
                score: score,
                reasons: reasons,
                sourceLabels: hypothesis.sourceLabels,
                footerConfirmed: footerConfirmed
            )
        }
        .sorted { lhs, rhs in
            if lhs.score == rhs.score {
                return lhs.titleText < rhs.titleText
            }
            return lhs.score > rhs.score
        }
}

func normalizedRawCollectorIdentifier(_ value: String) -> String {
    value
        .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        .uppercased()
        .replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"\s*/\s*"#, with: "/", options: .regularExpression)
}

// MARK: - Main Scanner

/// Focused scanner for raw Pokémon cards with broader OCR evidence before footer confirmation.
actor RawCardScanner {
    private let config: RawCardScanConfiguration
    private let parser = CardIdentifierParser()
    private let titleHeaderRegion = CGRect(x: 0.04, y: 0.00, width: 0.92, height: 0.18)
    private let nameplateRegion = CGRect(x: 0.16, y: 0.02, width: 0.62, height: 0.14)
    private let footerFallbackRegion = CGRect(x: 0.00, y: 0.78, width: 1.00, height: 0.22)
    private let rawCardWidthHeightAspect = 63.0 / 88.0

    init(config: RawCardScanConfiguration = .default) {
        self.config = config
    }

    func analyze(
        scanID: UUID,
        capture: ScanCaptureInput,
        resolverModeHint: ResolverMode = .rawCard
    ) async throws -> AnalyzedCapture {
        let startTime = Date()

        // Step 1: Select the OCR target from a larger search region around the reticle.
        if config.debug.verboseLogging {
            print("  🔍 [SCAN] Step 1: Selecting raw-card OCR target")
        }
        let targetSelection = try selectOCRInput(
            scanID: scanID,
            capture: capture,
            mode: .rawCard
        )
        let normalizedOriginal = capture.originalImage.normalizedOrientation()
        let workingImage = targetSelection.normalizedImage

        guard let workingCGImage = workingImage.cgImage else {
            throw AnalysisError.invalidImage
        }

        // Preserve the old aligned-card path if rectangle selection was inconclusive.
        let (cardImage, cropConfidence): (CGImage, Double)
        if targetSelection.usedFallback {
            if config.debug.verboseLogging {
                print("  🔍 [SCAN] Step 2: Refining fallback crop to card bounds")
            }
            (cardImage, cropConfidence) = try detectAndCropCard(from: workingCGImage)
        } else {
            cardImage = workingCGImage
            cropConfidence = targetSelection.selectionConfidence
        }

        if config.debug.verboseLogging {
            print("  🔍 [SCAN] Step 3: OCR broader raw-card regions")
        }
        let titleHeader = try recognizeRawRegion(
            scanID: scanID,
            in: cardImage,
            region: titleHeaderRegion,
            label: "07_raw_title_header",
            minimumTextHeight: 0.012,
            upscaleFactor: 2.4
        )
        let nameplate = try recognizeRawRegion(
            scanID: scanID,
            in: cardImage,
            region: nameplateRegion,
            label: "08_raw_nameplate",
            minimumTextHeight: 0.015,
            upscaleFactor: 2.2
        )
        let fullFooter = try recognizeRawRegion(
            scanID: scanID,
            in: cardImage,
            region: footerFallbackRegion,
            label: "09_raw_footer_full",
            minimumTextHeight: 0.004,
            upscaleFactor: 3.6
        )

        let primaryTitleText = !nameplate.text.isEmpty ? nameplate.text : titleHeader.text
        let secondaryTitleText: String? = {
            let candidate = titleHeader.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !candidate.isEmpty,
                  normalizedRawCollectorIdentifier(candidate) != normalizedRawCollectorIdentifier(primaryTitleText) else {
                return nil
            }
            return candidate
        }()

        let footerBandParsed = parser.parse(text: fullFooter.text, sourceRegion: "bottom-full")
        let broadFooterCollector = footerBandParsed.flatMap { parsed in
            isPlausibleCollectorNumber(parsed.identifier) ? parsed.identifier : nil
        }
        let broadFooterSetHints = extractSetHintTokens(from: [fullFooter.text])
        let coarseSignals = RawBroadOCRSignals(
            primaryTitleText: primaryTitleText,
            secondaryTitleText: secondaryTitleText,
            titleConfidence: max(titleHeader.averageConfidence, nameplate.averageConfidence),
            secondaryTitleConfidence: titleHeader.averageConfidence,
            footerBandText: fullFooter.text,
            footerBandConfidence: fullFooter.averageConfidence,
            footerCollectorNumber: broadFooterCollector,
            footerSetHintTokens: broadFooterSetHints,
            cropConfidence: cropConfidence
        )
        let coarseCandidates = buildCoarseRawCandidateHypotheses(from: coarseSignals)

        if config.debug.verboseLogging {
            print("  🔍 [SCAN] Step 4: OCR footer confirmation regions")
        }
        let bottomLeft = try recognizeRawRegion(
            scanID: scanID,
            in: cardImage,
            region: config.bottomRegionOCR.bottomLeftRegion,
            label: "10_raw_bottom_left",
            minimumTextHeight: config.bottomRegionOCR.minimumTextHeight,
            upscaleFactor: config.bottomRegionOCR.upscaleFactor
        )
        let bottomRight = try recognizeRawRegion(
            scanID: scanID,
            in: cardImage,
            region: config.bottomRegionOCR.bottomRightRegion,
            label: "11_raw_bottom_right",
            minimumTextHeight: config.bottomRegionOCR.minimumTextHeight,
            upscaleFactor: config.bottomRegionOCR.upscaleFactor
        )

        if config.debug.verboseLogging {
            print("  📋 [SCAN] Title header: \"\(titleHeader.text)\"")
            print("  📋 [SCAN] Nameplate: \"\(nameplate.text)\"")
            print("  📋 [SCAN] Footer full: \"\(fullFooter.text)\"")
            print("  📋 [SCAN] Bottom-left: \"\(bottomLeft.text)\"")
            print("  📋 [SCAN] Bottom-right: \"\(bottomRight.text)\"")
        }

        let leftParsed = parser.parse(text: bottomLeft.text, sourceRegion: "bottom-left")
        let rightParsed = parser.parse(text: bottomRight.text, sourceRegion: "bottom-right")
        let cornerBestParsed = bestParsedIdentifier(left: leftParsed, right: rightParsed)
        let cornerSetHintTokens = extractSetHintTokens(from: [bottomLeft.text, bottomRight.text])
        let finalCandidates = rerankRawCandidateHypotheses(
            coarseCandidates,
            footerConfirmation: RawFooterConfirmationSignals(
                collectorNumber: cornerBestParsed?.identifier,
                setHintTokens: cornerSetHintTokens
            )
        )
        let finalBestCandidate = finalCandidates.first
        let collectorNumber = cornerBestParsed?.identifier ?? finalBestCandidate?.collectorNumber ?? broadFooterCollector
        let setHintTokens = finalBestCandidate?.setHintTokens ?? broadFooterSetHints
        let recognizedTokens = mergedRecognizedTokens(
            prioritizedGroups: [
                nameplate.tokens,
                titleHeader.tokens,
                fullFooter.tokens,
                bottomLeft.tokens,
                bottomRight.tokens
            ]
        )
        let fullRecognizedText = recognizedTokens.map(\.text).joined(separator: " ")

        if config.debug.verboseLogging {
            if let collectorNumber {
                print("  ✅ [SCAN] Identifier after footer confirmation: \(collectorNumber)")
            } else {
                print("  ⚠️ [SCAN] Footer confirmation stayed weak; keeping coarse candidate path")
            }
        }

        ScanStageArtifactWriter.recordRawAnalysisArtifacts(
            scanID: scanID,
            cropConfidence: cropConfidence,
            regions: [titleHeader, nameplate, fullFooter, bottomLeft, bottomRight].map { region in
                ScanStageRawRegionArtifact(
                    label: region.label,
                    normalizedRect: ScanDebugRect(region.normalizedRect),
                    text: region.text,
                    averageConfidence: region.averageConfidence,
                    tokens: region.tokens
                )
            },
            coarseCandidates: coarseCandidates,
            finalCandidates: finalCandidates,
            finalCollectorNumber: collectorNumber,
            finalSetHintTokens: setHintTokens,
            fallbackReason: targetSelection.usedFallback ? targetSelection.fallbackReason : nil
        )

        let directLookupLikely = collectorNumber != nil && cropConfidence >= 0.55
        let shouldRetryWithStillPhoto = shouldRetryRawScanWithStillPhoto(
            captureSource: capture.captureSource,
            collectorNumber: collectorNumber,
            setHintTokens: setHintTokens,
            cropConfidence: cropConfidence,
            titleEvidenceStrong: rawTitleEvidenceLooksStrong(primaryTitleText: primaryTitleText, titleConfidence: coarseSignals.titleConfidence)
        )
        let stillPhotoRetryReason = shouldRetryWithStillPhoto ? "preview_frame_footer_ocr_too_weak" : nil

        print("  🔍 [OCR] Parsed collector number: \(collectorNumber ?? "<none>")")
        print("  🔍 [OCR] Parsed set hints: \(setHintTokens)")
        if let stillPhotoRetryReason {
            print("  🔁 [OCR] Recommended still-photo retry: \(stillPhotoRetryReason)")
        }

        let elapsed = Date().timeIntervalSince(startTime)
        if config.debug.verboseLogging {
            print("  ⏱️ [SCAN] Total: \(Int(elapsed * 1000))ms")
        }

        var warnings: [String] = []
        if collectorNumber == nil {
            if rawTitleEvidenceLooksStrong(primaryTitleText: primaryTitleText, titleConfidence: coarseSignals.titleConfidence) {
                warnings.append("Footer OCR weak; relying on broader raw-card text")
            } else {
                warnings.append("Could not read strong raw-card clues")
            }
        }
        if (finalBestCandidate?.score ?? 0) < 0.40 {
            warnings.append("Low-confidence raw candidate set")
        }

        let ocrAnalysis = buildLegacyRawOCRAnalysisEnvelope(
            targetSelection: targetSelection,
            primaryTitleText: primaryTitleText,
            secondaryTitleText: secondaryTitleText,
            titleConfidence: coarseSignals.titleConfidence,
            footerBandText: fullFooter.text,
            wholeCardText: fullRecognizedText,
            collectorNumber: collectorNumber,
            collectorWasFooterConfirmed: cornerBestParsed?.identifier != nil,
            setHintTokens: setHintTokens,
            warnings: warnings
        )
        ScanStageArtifactWriter.recordSynthesizedEvidenceArtifact(
            scanID: scanID,
            stage: "legacy_raw_ocr_analysis",
            payload: ocrAnalysis
        )

        return AnalyzedCapture(
            scanID: scanID,
            originalImage: normalizedOriginal,
            normalizedImage: UIImage(cgImage: cardImage),
            recognizedTokens: recognizedTokens,
            collectorNumber: collectorNumber,
            setHintTokens: setHintTokens,
            promoCodeHint: extractPromoHint(from: collectorNumber),
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
            directLookupLikely: directLookupLikely,
            resolverModeHint: resolverModeHint,
            cropConfidence: cropConfidence,
            warnings: warnings,
            shouldRetryWithStillPhoto: shouldRetryWithStillPhoto,
            stillPhotoRetryReason: stillPhotoRetryReason,
            ocrAnalysis: ocrAnalysis
        )
    }

    // MARK: - Private Methods

    private func detectAndCropCard(from cgImage: CGImage) throws -> (CGImage, Double) {
        guard let rectangle = try bestRawCardObservation(
            in: cgImage,
            minimumAreaCoverage: 0.28,
            maxCenterDistance: 0.30
        ) else {
            if config.debug.verboseLogging {
                print("  ⚠️ [SCAN] No card rectangle detected inside reticle crop; using original crop")
            }
            return (cgImage, 0.45)
        }

        let areaCoverage = rectangle.boundingBox.width * rectangle.boundingBox.height
        if config.debug.verboseLogging {
            print("  🔍 [SCAN] Rectangle box: \(rectangle.boundingBox), confidence: \(rectangle.confidence), area: \(areaCoverage)")
        }

        guard areaCoverage >= 0.45 else {
            if config.debug.verboseLogging {
                print("  ⚠️ [SCAN] Rectangle too small to trust for footer OCR; using original crop")
            }
            return (cgImage, 0.50)
        }

        let correctedCGImage = perspectiveCorrect(cgImage, observation: rectangle)?.cgImage
        let cropped: CGImage?
        if let correctedCGImage {
            cropped = correctedCGImage
        } else {
            cropped = cropWithInset(cgImage, observation: rectangle)
        }

        guard let cropped else {
            if config.debug.verboseLogging {
                print("  ⚠️ [SCAN] Rectangle crop failed; using original crop")
            }
            return (cgImage, 0.50)
        }

        let croppedAspectRatio = cardAspectRatio(for: cropped)
        let minimumAcceptedAspectRatio = max(0, CGFloat(config.cardDetection.minimumAspectRatio) - 0.03)
        let maximumAcceptedAspectRatio = min(1, CGFloat(config.cardDetection.maximumAspectRatio) + 0.03)
        guard croppedAspectRatio >= minimumAcceptedAspectRatio,
              croppedAspectRatio <= maximumAcceptedAspectRatio else {
            if config.debug.verboseLogging {
                print("  ⚠️ [SCAN] Refined crop aspect ratio \(croppedAspectRatio) looks wrong; using original crop")
            }
            return (cgImage, 0.52)
        }

        if config.debug.verboseLogging {
            print("  ✅ [SCAN] Refined card crop to \(cropped.width)x\(cropped.height)")
        }

        return (cropped, max(0.72, Double(rectangle.confidence)))
    }

    private func cardAspectRatio(for cgImage: CGImage) -> CGFloat {
        let width = CGFloat(cgImage.width)
        let height = CGFloat(cgImage.height)
        guard width > 0, height > 0 else { return 0 }
        return min(width, height) / max(width, height)
    }

    private func cropWithInset(_ cgImage: CGImage, observation: VNRectangleObservation) -> CGImage? {
        let width = CGFloat(cgImage.width)
        let height = CGFloat(cgImage.height)
        let box = observation.boundingBox

        let inset = box.insetBy(
            dx: box.width * config.cardDetection.edgeInsetPercentage,
            dy: box.height * config.cardDetection.edgeInsetPercentage
        )

        let cropRect = CGRect(
            x: inset.minX * width,
            y: (1 - inset.maxY) * height,
            width: inset.width * width,
            height: inset.height * height
        ).integral

        let clampedRect = cropRect.intersection(CGRect(x: 0, y: 0, width: width, height: height))
        guard !clampedRect.isEmpty else { return nil }
        return cgImage.cropping(to: clampedRect)
    }

    private func bestRawCardObservation(
        in cgImage: CGImage,
        minimumAreaCoverage: CGFloat,
        maxCenterDistance: CGFloat
    ) throws -> VNRectangleObservation? {
        let request = VNDetectRectanglesRequest()
        request.maximumObservations = 6
        request.minimumConfidence = max(0.25, config.cardDetection.minimumConfidence - 0.15)
        request.minimumAspectRatio = 0.50
        request.maximumAspectRatio = 0.90

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try handler.perform([request])

        let scoredCandidates: [(Double, VNRectangleObservation)] = (request.results ?? []).compactMap { observation in
            let areaCoverage = observation.boundingBox.width * observation.boundingBox.height
            guard areaCoverage >= minimumAreaCoverage else { return nil }

            let center = CGPoint(x: observation.boundingBox.midX, y: observation.boundingBox.midY)
            let centerDistance = distance(from: center, to: CGPoint(x: 0.5, y: 0.5))
            guard centerDistance <= maxCenterDistance else { return nil }

            let topWidth = distance(from: observation.topLeft, to: observation.topRight)
            let bottomWidth = distance(from: observation.bottomLeft, to: observation.bottomRight)
            let leftHeight = distance(from: observation.topLeft, to: observation.bottomLeft)
            let rightHeight = distance(from: observation.topRight, to: observation.bottomRight)
            let averageWidth = max(0.0001, (topWidth + bottomWidth) / 2)
            let averageHeight = max(0.0001, (leftHeight + rightHeight) / 2)
            let widthHeightAspect = averageWidth / averageHeight
            let aspectDelta = abs(widthHeightAspect - rawCardWidthHeightAspect)
            let aspectScore = max(0, 1 - (aspectDelta / 0.18))
            guard aspectScore >= 0.40 else { return nil }

            let proximityScore = max(0, 1 - (centerDistance / maxCenterDistance))
            let areaScore = min(1, sqrt(areaCoverage / 0.50))
            let totalScore =
                (Double(proximityScore) * 0.46) +
                (Double(aspectScore) * 0.29) +
                (Double(observation.confidence) * 0.10) +
                (Double(areaScore) * 0.15)

            return (totalScore, observation)
        }

        return scoredCandidates.max { lhs, rhs in
            lhs.0 < rhs.0
        }?.1
    }

    private func shouldRetryRawScanWithStillPhoto(
        captureSource: ScanCaptureSource,
        collectorNumber: String?,
        setHintTokens: [String],
        cropConfidence: Double,
        titleEvidenceStrong: Bool
    ) -> Bool {
        // Temporary debugging mode: disable automatic still-photo retries so the
        // original preview-frame capture remains the only scan input.
        _ = captureSource
        _ = collectorNumber
        _ = setHintTokens
        _ = cropConfidence
        _ = titleEvidenceStrong
        return false
    }

    private func rawTitleEvidenceLooksStrong(primaryTitleText: String, titleConfidence: Double) -> Bool {
        let trimmedTitle = primaryTitleText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedTitle.count >= 4 && titleConfidence >= 0.33
    }

    private func recognizeRawRegion(
        scanID: UUID,
        in cardImage: CGImage,
        region: CGRect,
        label: String,
        minimumTextHeight: Float,
        upscaleFactor: CGFloat
    ) throws -> RawRecognizedRegionResult {
        print("  🔍 [OCR] Card size: \(cardImage.width)x\(cardImage.height)")
        print("  🔍 [OCR] Region: \(region)")

        guard let regionImage = cropToRect(cardImage, region: region) else {
            print("  ❌ [OCR] Failed to crop region!")
            return RawRecognizedRegionResult(label: label, normalizedRect: region, text: "", tokens: [])
        }

        print("  🔍 [OCR] Cropped region size: \(regionImage.width)x\(regionImage.height)")

        let upscaled = upscale(regionImage, factor: upscaleFactor) ?? regionImage
        print("  🔍 [OCR] After \(upscaleFactor)x upscale: \(upscaled.width)x\(upscaled.height)")

        let targetImage = upscaled
        ScanStageArtifactWriter.recordRawRegionImage(scanID: scanID, image: UIImage(cgImage: targetImage), named: "\(label).jpg")

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.minimumTextHeight = minimumTextHeight
        request.recognitionLanguages = ["en-US"]

        let handler = VNImageRequestHandler(cgImage: targetImage, options: [:])
        try handler.perform([request])

        let observations = (request.results ?? []).sorted {
            let lhsTop = $0.boundingBox.maxY
            let rhsTop = $1.boundingBox.maxY
            if abs(lhsTop - rhsTop) > 0.05 {
                return lhsTop > rhsTop
            }
            return $0.boundingBox.minX < $1.boundingBox.minX
        }
        print("  🔍 [OCR] Found \(observations.count) text observations")

        let tokens = observations.compactMap { observation -> RecognizedToken? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            print("  🔍 [OCR] Detected: '\(text)' (confidence: \(observation.confidence))")
            return RecognizedToken(text: text, confidence: candidate.confidence)
        }

        return RawRecognizedRegionResult(
            label: label,
            normalizedRect: region,
            text: tokens.map(\.text).joined(separator: " "),
            tokens: tokens
        )
    }

    private func mergedRecognizedTokens(prioritizedGroups: [[RecognizedToken]]) -> [RecognizedToken] {
        var merged: [RecognizedToken] = []
        var seen = Set<String>()

        for group in prioritizedGroups {
            for token in group {
                let key = token.text
                    .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
                    .lowercased()
                guard !key.isEmpty, !seen.contains(key) else { continue }
                seen.insert(key)
                merged.append(token)
            }
        }

        return merged
    }

    /// Preprocess image for better OCR - gentle enhancement only
    private func preprocessForOCR(_ cgImage: CGImage) -> CGImage? {
        let ciImage = CIImage(cgImage: cgImage)

        // Gentle contrast boost only - don't over-process or text becomes unreadable
        guard let enhanced = CIFilter(name: "CIColorControls", parameters: [
            kCIInputImageKey: ciImage,
            kCIInputContrastKey: 1.3,      // Mild contrast (was 2.0 - too aggressive)
            kCIInputBrightnessKey: 0.05    // Very slight brightness
        ])?.outputImage else { return nil }

        // Render back to CGImage
        let context = CIContext(options: [.useSoftwareRenderer: false])
        let extent = enhanced.extent
        return context.createCGImage(enhanced, from: extent)
    }

    private func cropToRect(_ cgImage: CGImage, region: CGRect) -> CGImage? {
        let cropRect = CGRect(
            x: region.minX * CGFloat(cgImage.width),
            y: region.minY * CGFloat(cgImage.height),
            width: region.width * CGFloat(cgImage.width),
            height: region.height * CGFloat(cgImage.height)
        ).integral

        guard cropRect.width > 0, cropRect.height > 0 else { return nil }
        return cgImage.cropping(to: cropRect)
    }

    private func upscale(_ cgImage: CGImage, factor: CGFloat) -> CGImage? {
        guard factor > 1 else { return cgImage }

        let requestedWidth = CGFloat(cgImage.width) * factor
        let requestedHeight = CGFloat(cgImage.height) * factor
        let maxLongestSide: CGFloat = 4096
        let longestSide = max(requestedWidth, requestedHeight)
        let clampedScale = longestSide > maxLongestSide
            ? maxLongestSide / longestSide
            : 1.0

        let width = Int((requestedWidth * clampedScale).rounded(.toNearestOrAwayFromZero))
        let height = Int((requestedHeight * clampedScale).rounded(.toNearestOrAwayFromZero))

        // Some camera crops come through with extended-range color spaces that cannot back
        // a standard 8-bit bitmap context. Always render OCR intermediates into plain sRGB.
        guard width > 0, height > 0,
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            return nil
        }

        context.interpolationQuality = .high
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    private func extractPromoHint(from identifier: String?) -> String? {
        guard let identifier = identifier else { return nil }
        let normalized = identifier.uppercased()

        if let match = firstMatch(in: normalized, pattern: #"\b([A-Z]{2,5})\s?\d{1,3}\b"#) {
            return match
        }

        if let match = firstMatch(in: normalized, pattern: #"\b([A-Z]{1,5})\d{1,3}/[A-Z]{1,5}\d{1,3}\b"#) {
            return match
        }

        return nil
    }

    private func extractSetHintTokens(from texts: [String]) -> [String] {
        var hints = Set<String>()
        let alphanumericPattern = #"\b([A-Z]{1,4}\d{1,3}[A-Z]{0,2})\b"#
        let spacedLanguagePattern = #"\b([A-Z]{2,5})\s+(?:EN|JP|DE|FR|IT|ES|PT)\b"#

        for text in texts {
            let normalizedText = normalizedSetHintText(text)

            for match in captureGroups(in: normalizedText, pattern: alphanumericPattern) {
                if let hint = normalizedSetHintToken(match) {
                    hints.insert(hint)
                }
            }

            for match in captureGroups(in: normalizedText, pattern: spacedLanguagePattern) {
                if let hint = normalizedSetHintToken(match) {
                    hints.insert(hint)
                }
            }
        }

        return hints.sorted()
    }

    private func normalizedSetHintText(_ text: String) -> String {
        normalizeConfusableLatinCharacters(in: text)
            .uppercased()
            .replacingOccurrences(of: #"[§$](?=\d{1,3}[A-Z]{0,2}\b)"#, with: "S", options: .regularExpression)
    }

    private func normalizedSetHintToken(_ token: String) -> String? {
        let knownAlphaOnlyHints = Set([
            "dri", "obf", "pal", "mew", "gg", "crz", "svp", "prsv", "pr-sv",
            "par", "svi", "brs", "lor", "ssp", "meg",
        ])
        var normalized = token
            .uppercased()
            .replacingOccurrences(of: #"[^A-Z0-9]"#, with: "", options: .regularExpression)

        guard !normalized.isEmpty else { return nil }

        for suffix in ["EN", "JP", "DE", "FR", "IT", "ES", "PT"] where normalized.hasSuffix(suffix) && normalized.count > suffix.count + 1 {
            normalized.removeLast(suffix.count)
            break
        }

        guard normalized.count >= 3 else { return nil }
        guard normalized.contains(where: \.isLetter) else { return nil }

        if normalized.hasPrefix("X"), normalized.dropFirst().allSatisfy(\.isNumber) {
            return nil
        }

        if normalized.allSatisfy(\.isLetter) {
            let lowercased = normalized.lowercased()
            return knownAlphaOnlyHints.contains(lowercased) ? lowercased : nil
        }

        guard normalized.range(of: #"^[A-Z]{1,3}\d{1,2}[A-Z]{0,2}$"#, options: .regularExpression) != nil else {
            return nil
        }

        return normalized.lowercased()
    }

    private func bestParsedIdentifier(left: ParsedCardIdentifier?, right: ParsedCardIdentifier?) -> ParsedCardIdentifier? {
        [left, right]
            .compactMap { $0 }
            .filter { isPlausibleCollectorNumber($0.identifier) }
            .sorted { lhs, rhs in
                if lhs.confidence == rhs.confidence {
                    return lhs.sourceRegion < rhs.sourceRegion
                }
                return lhs.confidence > rhs.confidence
            }
            .first
    }

    private func isPlausibleCollectorNumber(_ identifier: String) -> Bool {
        let parts = identifier.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2 else {
            return true
        }

        guard let numerator = Int(parts[0]),
              let denominator = Int(parts[1]) else {
            return true
        }

        guard denominator >= 10 else { return false }
        guard numerator > 0 else { return false }
        return true
    }

    private func firstMatch(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }

        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              match.numberOfRanges > 1,
              let captureRange = Range(match.range(at: 1), in: text) else {
            return nil
        }

        return String(text[captureRange])
    }

    private func captureGroups(in text: String, pattern: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return []
        }

        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, options: [], range: range).compactMap { match in
            guard match.numberOfRanges > 1,
                  let captureRange = Range(match.range(at: 1), in: text) else {
                return nil
            }
            return String(text[captureRange])
        }
    }

    private func saveDebugImage(_ cgImage: CGImage, label: String) {
        let image = UIImage(cgImage: cgImage)

        PHPhotoLibrary.requestAuthorization { status in
            guard status == .authorized else {
                print("  ⚠️ [DEBUG] Photos permission denied")
                return
            }

            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            }) { success, error in
                if success {
                    print("  💾 [DEBUG] Saved \(label) region to Photos library")
                } else if let error = error {
                    print("  ❌ [DEBUG] Failed to save \(label): \(error.localizedDescription)")
                }
            }
        }
    }
}

actor SlabScanner {
    private let config: SlabScanConfiguration

    init(config: SlabScanConfiguration = .default) {
        self.config = config
    }

    func analyze(
        scanID: UUID,
        capture: ScanCaptureInput,
        resolverModeHint: ResolverMode = .psaSlab
    ) async throws -> AnalyzedCapture {
        let startTime = Date()
        let targetSelection = try selectOCRInput(
            scanID: scanID,
            capture: capture,
            mode: .psaSlab
        )
        let normalizedOriginal = capture.originalImage.normalizedOrientation()
        guard let cgImage = targetSelection.normalizedImage.cgImage else {
            throw AnalysisError.invalidImage
        }

        guard let primaryLabelImage = cropToRect(cgImage, region: config.labelOCR.primaryRegion),
              let expandedLabelImage = cropToRect(cgImage, region: config.labelOCR.expandedRegion) else {
            throw AnalysisError.invalidImage
        }

        let primaryText = try recognizeLabelRegion(
            croppedImage: primaryLabelImage,
            sourceImage: cgImage,
            region: config.labelOCR.primaryRegion,
            label: "slab_top_label"
        )
        let expandedText = try recognizeLabelRegion(
            croppedImage: expandedLabelImage,
            sourceImage: cgImage,
            region: config.labelOCR.expandedRegion,
            label: "slab_top_expanded"
        )
        let barcodePayloads: [String]
        do {
            barcodePayloads = try detectVerificationPayloads(
                in: cgImage,
                regions: [config.labelOCR.primaryRegion, config.labelOCR.expandedRegion]
            )
        } catch {
            print("  ⚠️ [OCR] Slab barcode detection failed: \(error.localizedDescription)")
            barcodePayloads = []
        }
        let visualSignals = extractVisualSignals(from: primaryLabelImage)

        let topLabelText = preferredSlabLabelText(primary: primaryText, expanded: expandedText)
        let combinedText = [topLabelText, expandedText]
            .filter { !$0.isEmpty }
            .reduce(into: [String]()) { unique, text in
                if !unique.contains(text) {
                    unique.append(text)
                }
            }
            .joined(separator: " ")
        let slabLabelAnalysis = SlabLabelParser.analyze(
            labelTexts: [topLabelText, expandedText],
            barcodePayloads: barcodePayloads,
            visualSignals: visualSignals
        )
        var warnings: [String] = []
        if topLabelText.isEmpty {
            warnings.append("Could not read slab label text")
        }
        if slabLabelAnalysis.certNumber == nil {
            warnings.append("Could not extract slab cert number")
        }
        if barcodePayloads.isEmpty {
            warnings.append("Could not extract slab barcode payload")
        }

        print("  🔍 [OCR] Slab top label: '\(topLabelText)'")
        print("  🔍 [OCR] Slab combined text: '\(combinedText)'")
        if !barcodePayloads.isEmpty {
            print("  🔍 [OCR] Slab barcode payloads: \(barcodePayloads.joined(separator: " | "))")
        }
        print("  🔍 [OCR] Slab grader: \(slabLabelAnalysis.grader ?? "<none>")")
        print("  🔍 [OCR] Slab grader confidence: \(String(format: "%.2f", slabLabelAnalysis.graderConfidence))")
        print("  🔍 [OCR] Slab grade: \(slabLabelAnalysis.grade ?? "<none>")")
        print("  🔍 [OCR] Slab grade confidence: \(String(format: "%.2f", slabLabelAnalysis.gradeConfidence))")
        print("  🔍 [OCR] Slab cert: \(slabLabelAnalysis.certNumber ?? "<none>")")
        print("  🔍 [OCR] Slab cert confidence: \(String(format: "%.2f", slabLabelAnalysis.certConfidence))")
        print("  🔍 [OCR] Slab lookup path: \(slabLabelAnalysis.recommendedLookupPath.rawValue)")
        print(
            "  🔍 [OCR] Slab signals: red=\(String(format: "%.2f", visualSignals.redBandConfidence)) " +
            "barcode=\(String(format: "%.2f", visualSignals.barcodeRegionConfidence)) " +
            "right=\(String(format: "%.2f", visualSignals.rightColumnConfidence)) " +
            "white=\(String(format: "%.2f", visualSignals.whitePanelConfidence))"
        )
        if !slabLabelAnalysis.reasons.isEmpty {
            print("  🔍 [OCR] Slab reasons: \(slabLabelAnalysis.reasons.joined(separator: ", "))")
        }

        let elapsed = Date().timeIntervalSince(startTime)
        if config.debug.verboseLogging {
            print("  ⏱️ [SCAN] Slab OCR total: \(Int(elapsed * 1000))ms")
        }

        let ocrAnalysis = buildLegacySlabOCRAnalysisEnvelope(
            targetSelection: targetSelection,
            topLabelText: topLabelText,
            combinedText: combinedText,
            slabLabelAnalysis: slabLabelAnalysis,
            warnings: warnings
        )
        ScanStageArtifactWriter.recordSynthesizedEvidenceArtifact(
            scanID: scanID,
            stage: "legacy_slab_ocr_analysis",
            payload: ocrAnalysis
        )

        return AnalyzedCapture(
            scanID: scanID,
            originalImage: normalizedOriginal,
            normalizedImage: targetSelection.normalizedImage,
            recognizedTokens: [],
            collectorNumber: nil,
            setHintTokens: [],
            promoCodeHint: nil,
            slabGrader: slabLabelAnalysis.grader,
            slabGrade: slabLabelAnalysis.grade,
            slabCertNumber: slabLabelAnalysis.certNumber,
            slabBarcodePayloads: slabLabelAnalysis.barcodePayloads,
            slabGraderConfidence: Double(slabLabelAnalysis.graderConfidence),
            slabGradeConfidence: Double(slabLabelAnalysis.gradeConfidence),
            slabCertConfidence: Double(slabLabelAnalysis.certConfidence),
            slabCardNumberRaw: slabLabelAnalysis.cardNumberRaw,
            slabParsedLabelText: slabLabelAnalysis.parsedLabelText,
            slabClassifierReasons: slabLabelAnalysis.reasons,
            slabRecommendedLookupPath: slabLabelAnalysis.recommendedLookupPath,
            directLookupLikely: slabLabelAnalysis.recommendedLookupPath != .needsReview,
            resolverModeHint: resolverModeHint,
            cropConfidence: targetSelection.selectionConfidence,
            warnings: warnings,
            shouldRetryWithStillPhoto: false,
            stillPhotoRetryReason: nil,
            ocrAnalysis: ocrAnalysis
        )
    }

    private func preferredSlabLabelText(primary: String, expanded: String) -> String {
        let texts = [primary, expanded].filter { !$0.isEmpty }
        guard !texts.isEmpty else { return "" }

        return texts.max { lhs, rhs in
            slabLabelScore(lhs) < slabLabelScore(rhs)
        } ?? ""
    }

    private func slabLabelScore(_ text: String) -> Int {
        let normalized = text.uppercased()
        var score = normalized.count
        if normalized.contains("PSA") { score += 100 }
        if normalized.range(of: #"\b(10|[1-9])\b"#, options: .regularExpression) != nil { score += 20 }
        if normalized.range(of: #"\b\d{7,8}\b"#, options: .regularExpression) != nil { score += 20 }
        if normalized.contains("#") { score += 10 }
        return score
    }

    private func recognizeLabelRegion(croppedImage: CGImage, sourceImage: CGImage, region: CGRect, label: String) throws -> String {
        print("  🔍 [OCR] Slab image size: \(sourceImage.width)x\(sourceImage.height)")
        print("  🔍 [OCR] Slab region: \(region)")

        print("  🔍 [OCR] Slab cropped region size: \(croppedImage.width)x\(croppedImage.height)")

        let upscaled = upscale(croppedImage, factor: config.labelOCR.upscaleFactor) ?? croppedImage
        print("  🔍 [OCR] Slab after \(config.labelOCR.upscaleFactor)x upscale: \(upscaled.width)x\(upscaled.height)")

        if config.debug.saveDebugImages {
            saveDebugImage(upscaled, label: label)
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.minimumTextHeight = config.labelOCR.minimumTextHeight
        request.recognitionLanguages = ["en-US"]

        let handler = VNImageRequestHandler(cgImage: upscaled, options: [:])
        try handler.perform([request])

        let observations = (request.results ?? []).sorted {
            let lhsTop = $0.boundingBox.maxY
            let rhsTop = $1.boundingBox.maxY
            if abs(lhsTop - rhsTop) > 0.05 {
                return lhsTop > rhsTop
            }
            return $0.boundingBox.minX < $1.boundingBox.minX
        }
        print("  🔍 [OCR] Slab found \(observations.count) text observations")

        let tokens = observations.compactMap { observation -> String? in
            let text = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if let text {
                print("  🔍 [OCR] Slab detected: '\(text)' (confidence: \(observation.confidence))")
            }
            return text
        }

        return tokens.joined(separator: " ")
    }

    private func extractVisualSignals(from labelImage: CGImage) -> SlabVisualSignals {
        guard let signals = withRenderedRGBA(labelImage, computeVisualSignals) else {
            return .none
        }
        return signals
    }

    private func computeVisualSignals(
        pixels: UnsafeBufferPointer<UInt8>,
        width: Int,
        height: Int,
        bytesPerRow: Int
    ) -> SlabVisualSignals {
        let topBand = regionMetrics(
            pixels: pixels,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            rect: CGRect(x: 0.0, y: 0.0, width: 1.0, height: 0.16)
        )
        let bottomBand = regionMetrics(
            pixels: pixels,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            rect: CGRect(x: 0.0, y: 0.70, width: 1.0, height: 0.28)
        )
        let barcodeRegion = regionMetrics(
            pixels: pixels,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            rect: CGRect(x: 0.03, y: 0.48, width: 0.30, height: 0.42)
        )
        let rightColumn = regionMetrics(
            pixels: pixels,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            rect: CGRect(x: 0.69, y: 0.08, width: 0.28, height: 0.80)
        )
        let whitePanel = regionMetrics(
            pixels: pixels,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            rect: CGRect(x: 0.06, y: 0.10, width: 0.88, height: 0.78)
        )

        return SlabVisualSignals(
            redBandConfidence: min(1, max(topBand.redDominantRatio * 1.35, bottomBand.redDominantRatio * 1.20)),
            barcodeRegionConfidence: min(1, (barcodeRegion.transitionConfidence * 0.72) + (barcodeRegion.darkRatio * 0.28)),
            rightColumnConfidence: min(1, (rightColumn.textBandConfidence * 0.70) + (rightColumn.darkRatio * 0.30)),
            whitePanelConfidence: min(1, whitePanel.brightRatio * 1.08)
        )
    }

    private func regionMetrics(
        pixels: UnsafeBufferPointer<UInt8>,
        width: Int,
        height: Int,
        bytesPerRow: Int,
        rect: CGRect
    ) -> SlabRegionMetrics {
        let x0 = max(0, min(width - 1, Int((rect.minX * CGFloat(width)).rounded(.down))))
        let x1 = max(x0 + 1, min(width, Int((rect.maxX * CGFloat(width)).rounded(.up))))
        let y0 = max(0, min(height - 1, Int((rect.minY * CGFloat(height)).rounded(.down))))
        let y1 = max(y0 + 1, min(height, Int((rect.maxY * CGFloat(height)).rounded(.up))))
        let xStep = max(1, (x1 - x0) / 96)
        let yStep = max(1, (y1 - y0) / 72)

        var totalSamples = 0
        var redDominantSamples = 0
        var brightSamples = 0
        var darkSamples = 0
        var transitionCount = 0
        var rowBandClusters = 0
        var previousBandRow = false

        for y in stride(from: y0, to: y1, by: yStep) {
            var previousBinary: Int?
            var rowSamples = 0
            var rowDarkSamples = 0

            for x in stride(from: x0, to: x1, by: xStep) {
                let offset = (y * bytesPerRow) + (x * 4)
                let red = Float(pixels[offset]) / 255.0
                let green = Float(pixels[offset + 1]) / 255.0
                let blue = Float(pixels[offset + 2]) / 255.0
                let luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
                let maxOther = max(green, blue)

                if red >= 0.42, red > (maxOther * 1.30) {
                    redDominantSamples += 1
                }
                if luminance >= 0.72 {
                    brightSamples += 1
                }
                if luminance <= 0.30 {
                    darkSamples += 1
                    rowDarkSamples += 1
                }

                let binary = luminance < 0.45 ? 1 : 0
                if let previousBinary, previousBinary != binary {
                    transitionCount += 1
                }
                previousBinary = binary
                rowSamples += 1
                totalSamples += 1
            }

            let rowDarkRatio = rowSamples > 0 ? Float(rowDarkSamples) / Float(rowSamples) : 0
            let isBandRow = rowDarkRatio >= 0.14
            if isBandRow, !previousBandRow {
                rowBandClusters += 1
            }
            previousBandRow = isBandRow
        }

        guard totalSamples > 0 else { return .zero }

        let transitionBaseline = Float(max(1, ((y1 - y0) / yStep) * 8))
        return SlabRegionMetrics(
            redDominantRatio: Float(redDominantSamples) / Float(totalSamples),
            brightRatio: Float(brightSamples) / Float(totalSamples),
            darkRatio: Float(darkSamples) / Float(totalSamples),
            transitionConfidence: min(1, Float(transitionCount) / transitionBaseline),
            textBandConfidence: min(1, Float(rowBandClusters) / 3.0)
        )
    }

    private func withRenderedRGBA<T>(
        _ cgImage: CGImage,
        _ body: (_ pixels: UnsafeBufferPointer<UInt8>, _ width: Int, _ height: Int, _ bytesPerRow: Int) -> T
    ) -> T? {
        let width = cgImage.width
        let height = cgImage.height
        let bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)
        let pixelCount = pixels.count

        return pixels.withUnsafeMutableBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress,
                  let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(
                    data: baseAddress,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
                  ) else {
                return nil
            }

            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            let buffer = UnsafeBufferPointer(
                start: rawBuffer.bindMemory(to: UInt8.self).baseAddress,
                count: pixelCount
            )
            return body(buffer, width, height, bytesPerRow)
        }
    }

    private func detectVerificationPayloads(in image: CGImage, regions: [CGRect]) throws -> [String] {
        var payloads: [String] = []

        for region in regions {
            guard let regionImage = cropToRect(image, region: region) else { continue }

            let request = VNDetectBarcodesRequest()
            request.symbologies = [.QR, .Code128, .Code39, .Code93, .DataMatrix, .Aztec, .EAN13]

            let handler = VNImageRequestHandler(cgImage: regionImage, options: [:])
            try handler.perform([request])

            for observation in request.results ?? [] {
                guard let payload = observation.payloadStringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !payload.isEmpty else {
                    continue
                }
                print("  🔍 [OCR] Slab barcode payload: '\(payload)'")
                payloads.append(payload)
            }
        }

        var seen = Set<String>()
        return payloads.filter { payload in
            guard !seen.contains(payload) else { return false }
            seen.insert(payload)
            return true
        }
    }

    private func cropToRect(_ cgImage: CGImage, region: CGRect) -> CGImage? {
        let cropRect = CGRect(
            x: region.minX * CGFloat(cgImage.width),
            y: region.minY * CGFloat(cgImage.height),
            width: region.width * CGFloat(cgImage.width),
            height: region.height * CGFloat(cgImage.height)
        ).integral

        guard cropRect.width > 0, cropRect.height > 0 else { return nil }
        return cgImage.cropping(to: cropRect)
    }

    private func upscale(_ cgImage: CGImage, factor: CGFloat) -> CGImage? {
        guard factor > 1 else { return cgImage }

        let requestedWidth = CGFloat(cgImage.width) * factor
        let requestedHeight = CGFloat(cgImage.height) * factor
        let maxLongestSide: CGFloat = 4096
        let longestSide = max(requestedWidth, requestedHeight)
        let clampedScale = longestSide > maxLongestSide
            ? maxLongestSide / longestSide
            : 1.0

        let width = Int((requestedWidth * clampedScale).rounded(.toNearestOrAwayFromZero))
        let height = Int((requestedHeight * clampedScale).rounded(.toNearestOrAwayFromZero))

        guard width > 0, height > 0,
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            return nil
        }

        context.interpolationQuality = .high
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    private func saveDebugImage(_ cgImage: CGImage, label: String) {
        let image = UIImage(cgImage: cgImage)

        PHPhotoLibrary.requestAuthorization { status in
            guard status == .authorized else {
                print("  ⚠️ [DEBUG] Photos permission denied")
                return
            }

            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            }) { success, error in
                if success {
                    print("  💾 [DEBUG] Saved \(label) region to Photos library")
                } else if let error = error {
                    print("  ❌ [DEBUG] Failed to save \(label): \(error.localizedDescription)")
                }
            }
        }
    }
}

private struct SlabRegionMetrics {
    let redDominantRatio: Float
    let brightRatio: Float
    let darkRatio: Float
    let transitionConfidence: Float
    let textBandConfidence: Float

    static let zero = SlabRegionMetrics(
        redDominantRatio: 0,
        brightRatio: 0,
        darkRatio: 0,
        transitionConfidence: 0,
        textBandConfidence: 0
    )
}

// MARK: - Supporting Types

enum AnalysisError: LocalizedError {
    case invalidImage

    var errorDescription: String? {
        switch self {
        case .invalidImage:
            "The selected image could not be processed."
        }
    }
}

extension UIImage {
    func normalizedOrientation() -> UIImage {
        guard imageOrientation != .up else { return self }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        if #available(iOS 12.0, *) {
            format.preferredRange = .standard
        }

        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: size))
        }
    }
}
