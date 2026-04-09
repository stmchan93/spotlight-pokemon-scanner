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
        let metadataText = fullFooter.text

        if config.debug.verboseLogging {
            if let collectorNumber {
                print("  ✅ [SCAN] Identifier after footer confirmation: \(collectorNumber)")
            } else {
                print("  ⚠️ [SCAN] Footer confirmation stayed weak; keeping coarse candidate path")
            }
        }

        ScanDebugArtifactWriter.recordRawAnalysisArtifacts(
            scanID: scanID,
            cropConfidence: cropConfidence,
            regions: [titleHeader, nameplate, fullFooter, bottomLeft, bottomRight],
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

        return AnalyzedCapture(
            scanID: scanID,
            originalImage: normalizedOriginal,
            normalizedImage: UIImage(cgImage: cardImage),
            recognizedTokens: recognizedTokens,
            fullRecognizedText: fullRecognizedText,
            metadataStripRecognizedText: metadataText,
            topLabelRecognizedText: "",
            bottomLeftRecognizedText: bottomLeft.text,
            bottomRightRecognizedText: bottomRight.text,
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
            stillPhotoRetryReason: stillPhotoRetryReason
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
        guard captureSource == .livePreviewFrame else { return false }
        guard collectorNumber == nil else { return false }
        guard setHintTokens.isEmpty else { return false }
        guard !titleEvidenceStrong else { return false }
        return cropConfidence >= 0.68
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
        ScanDebugArtifactWriter.recordRawRegionImage(scanID: scanID, image: UIImage(cgImage: targetImage), named: "\(label).jpg")

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
        let barcodePayloads = try detectVerificationPayloads(
            in: cgImage,
            regions: [config.labelOCR.primaryRegion, config.labelOCR.expandedRegion]
        )
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

        return AnalyzedCapture(
            scanID: scanID,
            originalImage: normalizedOriginal,
            normalizedImage: targetSelection.normalizedImage,
            recognizedTokens: [],
            fullRecognizedText: combinedText,
            metadataStripRecognizedText: "",
            topLabelRecognizedText: topLabelText,
            bottomLeftRecognizedText: "",
            bottomRightRecognizedText: "",
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
            stillPhotoRetryReason: nil
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

enum OCRTargetMode: String, Codable {
    case rawCard = "raw"
    case psaSlab = "psa"

    var expectedAspectRatio: CGFloat {
        switch self {
        case .rawCard:
            return 88.0 / 63.0
        case .psaSlab:
            return 5.375 / 3.25
        }
    }

    var minimumSelectionScore: Double {
        switch self {
        case .rawCard:
            return 0.62
        case .psaSlab:
            return 0.60
        }
    }

    var minimumCandidateArea: CGFloat {
        switch self {
        case .rawCard:
            return 0.10
        case .psaSlab:
            return 0.12
        }
    }
}

enum OCRTargetGeometryKind: String, Codable {
    case rawCard = "raw_card"
    case rawHolder = "raw_holder"
    case slab = "slab"
    case fallback = "fallback"
}

private struct OCRTargetSelectionCandidate {
    let observation: VNRectangleObservation
    let summary: OCRTargetCandidateSummary
}

private struct OCRTargetSelectionResult {
    let normalizedImage: UIImage
    let selectionConfidence: Double
    let usedFallback: Bool
    let fallbackReason: String?
    let chosenCandidateIndex: Int?
    let candidates: [OCRTargetCandidateSummary]
    let normalizedGeometryKind: OCRTargetGeometryKind
    let normalizationReason: String?
}

struct OCRTargetCandidateSummary: Codable {
    let rank: Int
    let confidence: Double
    let areaCoverage: Double
    let aspectRatio: Double
    let aspectScore: Double
    let proximityScore: Double
    let areaScore: Double
    let totalScore: Double
    let centerDistance: Double
    let boundingBox: ScanDebugRect
    let quadrilateral: [ScanDebugPoint]
    let geometryKind: OCRTargetGeometryKind
}

private struct OCRTargetNormalizationResult {
    let image: UIImage
    let geometryKind: OCRTargetGeometryKind
    let reason: String?
}

private func selectOCRInput(
    scanID: UUID,
    capture: ScanCaptureInput,
    mode: OCRTargetMode
) throws -> OCRTargetSelectionResult {
    let searchImage = capture.searchImage.normalizedOrientation()
    let fallbackImage = (capture.fallbackImage ?? capture.searchImage).normalizedOrientation()

    guard let searchCGImage = searchImage.cgImage else {
        throw AnalysisError.invalidImage
    }

    let candidates = try detectRectangleCandidates(in: searchCGImage, mode: mode)
    let chosenCandidate = chooseBestCandidate(from: candidates, mode: mode)
    let candidateOverlayImage = drawCandidateOverlay(on: searchImage, candidates: candidates, chosenIndex: chosenCandidate?.summary.rank)

    if let chosenCandidate,
       let normalizedCandidateImage = perspectiveCorrect(searchCGImage, observation: chosenCandidate.observation) {
        let normalizationResult = normalizeOCRInputImage(
            normalizedCandidateImage.normalizedOrientation(),
            chosenCandidate: chosenCandidate.summary,
            mode: mode
        )
        let normalizedImage = normalizationResult.image
        let fallbackReason: String? = nil
        print(
            "  🎯 [TARGET] mode=\(mode.rawValue) source=\(capture.captureSource.rawValue) " +
            "chosen=#\(chosenCandidate.summary.rank) score=\(String(format: "%.2f", chosenCandidate.summary.totalScore)) " +
            "geometry=\(normalizationResult.geometryKind.rawValue)"
        )
        ScanDebugArtifactWriter.recordSelectionArtifacts(
            scanID: scanID,
            mode: mode,
            source: capture.captureSource,
            searchImage: searchImage,
            candidateOverlayImage: candidateOverlayImage,
            normalizedImage: normalizedImage,
            chosenCandidateIndex: chosenCandidate.summary.rank,
            candidates: candidates.map(\.summary),
            fallbackReason: fallbackReason,
            normalizedGeometryKind: normalizationResult.geometryKind,
            normalizationReason: normalizationResult.reason
        )
        return OCRTargetSelectionResult(
            normalizedImage: normalizedImage,
            selectionConfidence: max(0.55, chosenCandidate.summary.totalScore),
            usedFallback: false,
            fallbackReason: fallbackReason,
            chosenCandidateIndex: chosenCandidate.summary.rank,
            candidates: candidates.map(\.summary),
            normalizedGeometryKind: normalizationResult.geometryKind,
            normalizationReason: normalizationResult.reason
        )
    }

    let fallbackReason = fallbackReason(for: candidates, mode: mode)
    print("  ⚠️ [TARGET] mode=\(mode.rawValue) fallback=\(fallbackReason)")
    ScanDebugArtifactWriter.recordSelectionArtifacts(
        scanID: scanID,
        mode: mode,
        source: capture.captureSource,
        searchImage: searchImage,
        candidateOverlayImage: candidateOverlayImage,
        normalizedImage: fallbackImage,
        chosenCandidateIndex: nil,
        candidates: candidates.map(\.summary),
        fallbackReason: fallbackReason,
        normalizedGeometryKind: .fallback,
        normalizationReason: "exact_reticle_fallback"
    )

    return OCRTargetSelectionResult(
        normalizedImage: fallbackImage,
        selectionConfidence: candidates.first?.summary.totalScore ?? 0.40,
        usedFallback: true,
        fallbackReason: fallbackReason,
        chosenCandidateIndex: nil,
        candidates: candidates.map(\.summary),
        normalizedGeometryKind: .fallback,
        normalizationReason: "exact_reticle_fallback"
    )
}

private func detectRectangleCandidates(
    in cgImage: CGImage,
    mode: OCRTargetMode
) throws -> [OCRTargetSelectionCandidate] {
    let request = VNDetectRectanglesRequest()
    request.maximumObservations = 8
    request.minimumConfidence = 0.35
    request.minimumAspectRatio = 0.5
    request.maximumAspectRatio = 0.9

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])

    let observations = request.results ?? []
    let summaries = observations.enumerated().compactMap { index, observation -> OCRTargetSelectionCandidate? in
        let areaCoverage = observation.boundingBox.width * observation.boundingBox.height
        guard areaCoverage >= mode.minimumCandidateArea else {
            return nil
        }

        let candidate = makeCandidateSummary(
            observation: observation,
            rank: index + 1,
            mode: mode
        )
        return OCRTargetSelectionCandidate(observation: observation, summary: candidate)
    }

    return summaries.sorted { lhs, rhs in
        lhs.summary.totalScore > rhs.summary.totalScore
    }
}

private func makeCandidateSummary(
    observation: VNRectangleObservation,
    rank: Int,
    mode: OCRTargetMode
) -> OCRTargetCandidateSummary {
    let center = CGPoint(x: observation.boundingBox.midX, y: observation.boundingBox.midY)
    let dx = center.x - 0.5
    let dy = center.y - 0.5
    let centerDistance = sqrt((dx * dx) + (dy * dy))
    let maxDistance = sqrt(0.5)
    let proximityScore = max(0, 1 - (centerDistance / maxDistance))

    let topWidth = distance(from: observation.topLeft, to: observation.topRight)
    let bottomWidth = distance(from: observation.bottomLeft, to: observation.bottomRight)
    let leftHeight = distance(from: observation.topLeft, to: observation.bottomLeft)
    let rightHeight = distance(from: observation.topRight, to: observation.bottomRight)
    let averageWidth = max(0.0001, (topWidth + bottomWidth) / 2)
    let averageHeight = max(0.0001, (leftHeight + rightHeight) / 2)
    let aspectRatio = averageHeight / averageWidth
    let aspectDelta = abs(aspectRatio - mode.expectedAspectRatio)
    let aspectScore = max(0, 1 - (aspectDelta / 0.45))
    let geometryKind = inferredGeometryKind(for: aspectRatio, mode: mode)

    let areaCoverage = observation.boundingBox.width * observation.boundingBox.height
    let areaScore = min(1, sqrt(areaCoverage / 0.32))

    let totalScore =
        (Double(proximityScore) * 0.46) +
        (Double(aspectScore) * 0.24) +
        (Double(observation.confidence) * 0.15) +
        (Double(areaScore) * 0.15)

    return OCRTargetCandidateSummary(
        rank: rank,
        confidence: Double(observation.confidence),
        areaCoverage: Double(areaCoverage),
        aspectRatio: Double(aspectRatio),
        aspectScore: Double(aspectScore),
        proximityScore: Double(proximityScore),
        areaScore: Double(areaScore),
        totalScore: totalScore,
        centerDistance: Double(centerDistance),
        boundingBox: ScanDebugRect(observation.boundingBox),
        quadrilateral: [
            ScanDebugPoint(observation.topLeft),
            ScanDebugPoint(observation.topRight),
            ScanDebugPoint(observation.bottomRight),
            ScanDebugPoint(observation.bottomLeft)
        ],
        geometryKind: geometryKind
    )
}

private func chooseBestCandidate(
    from candidates: [OCRTargetSelectionCandidate],
    mode: OCRTargetMode
) -> OCRTargetSelectionCandidate? {
    guard let acceptedRank = chooseBestSelectionCandidateRank(from: candidates.map(\.summary), mode: mode) else {
        return nil
    }
    return candidates.first { $0.summary.rank == acceptedRank }
}

func chooseBestSelectionCandidateRank(
    from candidates: [OCRTargetCandidateSummary],
    mode: OCRTargetMode
) -> Int? {
    guard let best = candidates.first else {
        return nil
    }

    let margin = best.totalScore - (candidates.dropFirst().first?.totalScore ?? 0)
    let holderAccepted = mode == .rawCard
        && best.geometryKind == .rawHolder
        && best.proximityScore >= 0.44
        && best.areaCoverage >= 0.18
    guard best.totalScore >= mode.minimumSelectionScore else {
        return nil
    }
    guard best.aspectScore >= 0.45 || holderAccepted else {
        return nil
    }
    guard best.proximityScore >= 0.32 else {
        return nil
    }
    guard margin >= 0.05 || candidates.count == 1 else {
        return nil
    }
    return best.rank
}

private func fallbackReason(
    for candidates: [OCRTargetSelectionCandidate],
    mode: OCRTargetMode
) -> String {
    guard let best = candidates.first else {
        return "no_rectangle_detected"
    }

    if best.summary.totalScore < mode.minimumSelectionScore {
        return "best_rectangle_score_too_low"
    }
    if best.summary.aspectScore < 0.45 {
        return "best_rectangle_aspect_mismatch"
    }
    if best.summary.proximityScore < 0.32 {
        return "best_rectangle_too_far_from_reticle"
    }
    let margin = best.summary.totalScore - (candidates.dropFirst().first?.summary.totalScore ?? 0)
    if margin < 0.05 && candidates.count > 1 {
        return "multiple_rectangles_too_close_to_call"
    }
    return "perspective_correction_failed"
}

private func inferredGeometryKind(for aspectRatio: CGFloat, mode: OCRTargetMode) -> OCRTargetGeometryKind {
    switch mode {
    case .rawCard:
        if aspectRatio >= (mode.expectedAspectRatio + 0.10), aspectRatio <= 1.95 {
            return .rawHolder
        }
        return .rawCard
    case .psaSlab:
        return .slab
    }
}

private func normalizeOCRInputImage(
    _ image: UIImage,
    chosenCandidate: OCRTargetCandidateSummary,
    mode: OCRTargetMode
) -> OCRTargetNormalizationResult {
    guard mode == .rawCard else {
        return OCRTargetNormalizationResult(image: image, geometryKind: .slab, reason: nil)
    }

    if chosenCandidate.geometryKind == .rawHolder || rawImageLooksLikeHolder(image) {
        if let innerCardImage = extractInnerRawCard(from: image) {
            return innerCardImage
        }
        return OCRTargetNormalizationResult(image: image, geometryKind: .rawHolder, reason: "holder_detected_inner_card_not_found")
    }

    return OCRTargetNormalizationResult(image: image, geometryKind: .rawCard, reason: nil)
}

private func rawImageLooksLikeHolder(_ image: UIImage) -> Bool {
    guard image.size.width > 0, image.size.height > 0 else { return false }
    return (image.size.height / image.size.width) > 1.50
}

private func extractInnerRawCard(from image: UIImage) -> OCRTargetNormalizationResult? {
    guard let correctedCGImage = image.cgImage else { return nil }

    if let innerCardObservation = try? bestRawCardObservation(
        in: correctedCGImage,
        expectedWidthHeightAspect: 63.0 / 88.0,
        minimumAreaCoverage: 0.20,
        maxCenterDistance: 0.24
    ), let normalizedInnerCard = perspectiveCorrect(correctedCGImage, observation: innerCardObservation)?.normalizedOrientation() {
        return OCRTargetNormalizationResult(
            image: normalizedInnerCard,
            geometryKind: .rawCard,
            reason: "holder_inner_card_detected"
        )
    }

    guard let heuristicCrop = heuristicInnerRawCardCrop(from: correctedCGImage) else {
        return nil
    }

    return OCRTargetNormalizationResult(
        image: UIImage(cgImage: heuristicCrop),
        geometryKind: .rawCard,
        reason: "holder_inner_card_inset_fallback"
    )
}

private func bestRawCardObservation(
    in cgImage: CGImage,
    expectedWidthHeightAspect: CGFloat,
    minimumAreaCoverage: CGFloat,
    maxCenterDistance: CGFloat
) throws -> VNRectangleObservation? {
    let request = VNDetectRectanglesRequest()
    request.maximumObservations = 6
    request.minimumConfidence = 0.25
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
        let aspectDelta = abs(widthHeightAspect - expectedWidthHeightAspect)
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

private func heuristicInnerRawCardCrop(from cgImage: CGImage) -> CGImage? {
    let width = CGFloat(cgImage.width)
    let height = CGFloat(cgImage.height)
    let containerRect = CGRect(
        x: width * 0.06,
        y: height * 0.03,
        width: width * 0.88,
        height: height * 0.91
    )
    let cropRect = centeredAspectFitRect(
        in: containerRect,
        widthHeightAspect: 63.0 / 88.0
    ).integral

    guard cropRect.width > 0, cropRect.height > 0 else { return nil }
    return cgImage.cropping(to: cropRect)
}

private func centeredAspectFitRect(in rect: CGRect, widthHeightAspect: CGFloat) -> CGRect {
    guard rect.width > 0, rect.height > 0, widthHeightAspect > 0 else { return rect }

    let containerAspect = rect.width / rect.height
    if containerAspect > widthHeightAspect {
        let height = rect.height
        let width = height * widthHeightAspect
        return CGRect(
            x: rect.midX - (width / 2),
            y: rect.minY,
            width: width,
            height: height
        )
    }

    let width = rect.width
    let height = width / widthHeightAspect
    return CGRect(
        x: rect.minX,
        y: rect.midY - (height / 2),
        width: width,
        height: height
    )
}

private func perspectiveCorrect(_ cgImage: CGImage, observation: VNRectangleObservation) -> UIImage? {
    let ciImage = CIImage(cgImage: cgImage)
    guard let filter = CIFilter(name: "CIPerspectiveCorrection") else {
        return nil
    }

    let width = CGFloat(cgImage.width)
    let height = CGFloat(cgImage.height)
    filter.setValue(ciImage, forKey: kCIInputImageKey)
    filter.setValue(CIVector(cgPoint: pointInImage(observation.topLeft, width: width, height: height)), forKey: "inputTopLeft")
    filter.setValue(CIVector(cgPoint: pointInImage(observation.topRight, width: width, height: height)), forKey: "inputTopRight")
    filter.setValue(CIVector(cgPoint: pointInImage(observation.bottomRight, width: width, height: height)), forKey: "inputBottomRight")
    filter.setValue(CIVector(cgPoint: pointInImage(observation.bottomLeft, width: width, height: height)), forKey: "inputBottomLeft")

    guard let outputImage = filter.outputImage else {
        return nil
    }

    let ciContext = CIContext()
    guard let correctedCGImage = ciContext.createCGImage(outputImage, from: outputImage.extent.integral) else {
        return nil
    }

    return UIImage(cgImage: correctedCGImage)
}

private func drawCandidateOverlay(
    on image: UIImage,
    candidates: [OCRTargetSelectionCandidate],
    chosenIndex: Int?
) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    if #available(iOS 12.0, *) {
        format.preferredRange = .standard
    }

    let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
    return renderer.image { _ in
        image.draw(in: CGRect(origin: .zero, size: image.size))

        for candidate in candidates {
            let isChosen = candidate.summary.rank == chosenIndex
            let color = isChosen ? UIColor.systemGreen : UIColor.systemYellow
            let quad = candidate.summary.quadrilateral.map { point in
                CGPoint(
                    x: point.x * image.size.width,
                    y: (1 - point.y) * image.size.height
                )
            }

            guard quad.count == 4 else { continue }
            let path = UIBezierPath()
            path.move(to: quad[0])
            path.addLine(to: quad[1])
            path.addLine(to: quad[2])
            path.addLine(to: quad[3])
            path.close()
            color.setStroke()
            path.lineWidth = isChosen ? 6 : 3
            path.stroke()

            let label = "#\(candidate.summary.rank) \(String(format: "%.2f", candidate.summary.totalScore))"
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.monospacedSystemFont(ofSize: 18, weight: .bold),
                .foregroundColor: color
            ]
            let labelPoint = CGPoint(x: quad[0].x + 8, y: quad[0].y + 8)
            label.draw(at: labelPoint, withAttributes: attributes)
        }
    }
}

private func pointInImage(_ normalizedPoint: CGPoint, width: CGFloat, height: CGFloat) -> CGPoint {
    CGPoint(x: normalizedPoint.x * width, y: normalizedPoint.y * height)
}

private func distance(from lhs: CGPoint, to rhs: CGPoint) -> CGFloat {
    let dx = lhs.x - rhs.x
    let dy = lhs.y - rhs.y
    return sqrt((dx * dx) + (dy * dy))
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

struct ScanDebugPoint: Codable {
    let x: Double
    let y: Double

    init(_ point: CGPoint) {
        self.x = Double(point.x)
        self.y = Double(point.y)
    }
}

struct ScanDebugRect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ rect: CGRect) {
        self.x = Double(rect.origin.x)
        self.y = Double(rect.origin.y)
        self.width = Double(rect.size.width)
        self.height = Double(rect.size.height)
    }
}

private struct CaptureArtifactManifest: Codable {
    let stage: String
    let source: ScanCaptureSource
    let exactCropRectNormalized: ScanDebugRect
    let searchCropRectNormalized: ScanDebugRect
}

private struct SelectionArtifactManifest: Codable {
    let stage: String
    let mode: OCRTargetMode
    let source: ScanCaptureSource
    let chosenCandidateIndex: Int?
    let fallbackReason: String?
    let normalizedGeometryKind: OCRTargetGeometryKind
    let normalizationReason: String?
    let candidates: [OCRTargetCandidateSummary]
}

private struct RawOCRRegionArtifact: Codable {
    let label: String
    let normalizedRect: ScanDebugRect
    let text: String
    let averageConfidence: Double
    let tokens: [RecognizedToken]
}

private struct RawDecisionArtifactManifest: Codable {
    let stage: String
    let cropConfidence: Double
    let fallbackReason: String?
    let regions: [RawOCRRegionArtifact]
    let coarseCandidates: [RawCandidateHypothesis]
    let finalCandidates: [RawCandidateHypothesis]
    let finalCollectorNumber: String?
    let finalSetHintTokens: [String]
}

enum ScanDebugArtifactWriter {
    static func recordCaptureArtifacts(
        scanID: UUID,
        source: ScanCaptureSource,
        originalImage: UIImage,
        searchImage: UIImage,
        fallbackImage: UIImage,
        exactCropRectNormalized: CGRect,
        searchCropRectNormalized: CGRect
    ) {
        let manifest = CaptureArtifactManifest(
            stage: "capture",
            source: source,
            exactCropRectNormalized: ScanDebugRect(exactCropRectNormalized),
            searchCropRectNormalized: ScanDebugRect(searchCropRectNormalized)
        )

        write(image: originalImage, named: "01_original_frame.jpg", scanID: scanID)
        write(image: searchImage, named: "02_search_region.jpg", scanID: scanID)
        write(image: fallbackImage, named: "03_exact_reticle_fallback.jpg", scanID: scanID)
        write(json: manifest, named: "capture_manifest.json", scanID: scanID)
    }

    fileprivate static func recordSelectionArtifacts(
        scanID: UUID,
        mode: OCRTargetMode,
        source: ScanCaptureSource,
        searchImage: UIImage,
        candidateOverlayImage: UIImage,
        normalizedImage: UIImage,
        chosenCandidateIndex: Int?,
        candidates: [OCRTargetCandidateSummary],
        fallbackReason: String?,
        normalizedGeometryKind: OCRTargetGeometryKind,
        normalizationReason: String?
    ) {
        let manifest = SelectionArtifactManifest(
            stage: "selection",
            mode: mode,
            source: source,
            chosenCandidateIndex: chosenCandidateIndex,
            fallbackReason: fallbackReason,
            normalizedGeometryKind: normalizedGeometryKind,
            normalizationReason: normalizationReason,
            candidates: candidates
        )

        write(image: searchImage, named: "04_selection_search_input.jpg", scanID: scanID)
        write(image: candidateOverlayImage, named: "05_selection_candidates.jpg", scanID: scanID)
        write(image: normalizedImage, named: "06_ocr_input_normalized.jpg", scanID: scanID)
        write(json: manifest, named: "selection_manifest.json", scanID: scanID)
    }

    fileprivate static func recordRawRegionImage(scanID: UUID, image: UIImage, named filename: String) {
        write(image: image, named: filename, scanID: scanID)
    }

    fileprivate static func recordRawAnalysisArtifacts(
        scanID: UUID,
        cropConfidence: Double,
        regions: [RawRecognizedRegionResult],
        coarseCandidates: [RawCandidateHypothesis],
        finalCandidates: [RawCandidateHypothesis],
        finalCollectorNumber: String?,
        finalSetHintTokens: [String],
        fallbackReason: String?
    ) {
        let manifest = RawDecisionArtifactManifest(
            stage: "raw_analysis",
            cropConfidence: cropConfidence,
            fallbackReason: fallbackReason,
            regions: regions.map { region in
                RawOCRRegionArtifact(
                    label: region.label,
                    normalizedRect: ScanDebugRect(region.normalizedRect),
                    text: region.text,
                    averageConfidence: region.averageConfidence,
                    tokens: region.tokens
                )
            },
            coarseCandidates: Array(coarseCandidates.prefix(3)),
            finalCandidates: Array(finalCandidates.prefix(3)),
            finalCollectorNumber: finalCollectorNumber,
            finalSetHintTokens: finalSetHintTokens
        )

        write(json: manifest, named: "raw_analysis_manifest.json", scanID: scanID)
    }

    private static func write(image: UIImage, named filename: String, scanID: UUID) {
        guard let data = image.jpegData(compressionQuality: 0.9) else {
            return
        }
        write(data: data, named: filename, scanID: scanID)
    }

    private static func write<T: Encodable>(json payload: T, named filename: String, scanID: UUID) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(payload) else {
            return
        }
        write(data: data, named: filename, scanID: scanID)
    }

    private static func write(data: Data, named filename: String, scanID: UUID) {
        guard let directoryURL = scanDirectoryURL(for: scanID) else {
            return
        }
        let fileURL = directoryURL.appendingPathComponent(filename)
        try? data.write(to: fileURL, options: .atomic)
    }

    private static func scanDirectoryURL(for scanID: UUID) -> URL? {
        let fileManager = FileManager.default
        let baseURL = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
        guard let baseURL else { return nil }

        let directoryURL = baseURL
            .appendingPathComponent("Spotlight", isDirectory: true)
            .appendingPathComponent("ScanDebug", isDirectory: true)
            .appendingPathComponent(scanID.uuidString, isDirectory: true)

        try? fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        print("  🧪 [DEBUG] Scan artifacts directory: \(directoryURL.path)")
        return directoryURL
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
