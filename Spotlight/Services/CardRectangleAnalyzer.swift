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

// MARK: - Main Scanner

/// Fast, focused scanner for raw Pokémon cards - ONLY scans bottom regions
actor RawCardScanner {
    private let config: RawCardScanConfiguration
    private let parser = CardIdentifierParser()
    private let footerFallbackRegion = CGRect(x: 0.00, y: 0.78, width: 1.00, height: 0.22)

    init(config: RawCardScanConfiguration = .default) {
        self.config = config
    }

    func analyze(
        scanID: UUID,
        image: UIImage,
        resolverModeHint: ResolverMode = .rawCard
    ) async throws -> AnalyzedCapture {
        let startTime = Date()

        // Step 1: Normalize
        if config.debug.verboseLogging {
            print("  🔍 [SCAN] Step 1: Normalizing orientation")
        }
        let normalized = image.normalizedOrientation()
        guard let baseCGImage = normalized.cgImage else {
            throw AnalysisError.invalidImage
        }

        // Step 2: Tighten the reticle crop to the actual card when possible.
        // The captured photo can still include desk/background even when the preview reticle looks correct.
        if config.debug.verboseLogging {
            print("  🔍 [SCAN] Step 2: Refining reticle crop to card bounds")
        }
        let (cardImage, cropConfidence) = try detectAndCropCard(from: baseCGImage)

        // Step 3: OCR bottom regions ONLY
        if config.debug.verboseLogging {
            print("  🔍 [SCAN] Step 3: OCR bottom-left region")
        }
        let bottomLeftText = try recognizeBottomRegion(
            in: cardImage,
            region: config.bottomRegionOCR.bottomLeftRegion,
            label: "bottom_left"
        )

        if config.debug.verboseLogging {
            print("  🔍 [SCAN] Step 4: OCR bottom-right region")
        }
        let bottomRightText = try recognizeBottomRegion(
            in: cardImage,
            region: config.bottomRegionOCR.bottomRightRegion,
            label: "bottom_right"
        )

        // Step 4: Parse identifier
        if config.debug.verboseLogging {
            print("  📋 [SCAN] Bottom-left: \"\(bottomLeftText)\"")
            print("  📋 [SCAN] Bottom-right: \"\(bottomRightText)\"")
        }

        let leftParsed = parser.parse(text: bottomLeftText, sourceRegion: "bottom-left")
        let rightParsed = parser.parse(text: bottomRightText, sourceRegion: "bottom-right")

        var footerTexts = [bottomLeftText, bottomRightText]
        var bestParsed = bestParsedIdentifier(left: leftParsed, right: rightParsed)

        if bestParsed == nil {
            let footerText = try recognizeBottomRegion(
                in: cardImage,
                region: footerFallbackRegion,
                label: "bottom_full"
            )
            if !footerText.isEmpty {
                footerTexts.append(footerText)
                if let footerParsed = parser.parse(text: footerText, sourceRegion: "bottom-full"),
                   isPlausibleCollectorNumber(footerParsed.identifier) {
                    bestParsed = footerParsed
                }
            }
        }

        let metadataText = footerTexts
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        let setHintTokens = extractSetHintTokens(from: footerTexts)

        if config.debug.verboseLogging {
            if let best = bestParsed {
                print("  ✅ [SCAN] Identifier: \(best.identifier) (conf: \(best.confidence), from: \(best.sourceRegion))")
            } else {
                print("  ❌ [SCAN] No identifier parsed")
            }
        }

        let collectorNumber = bestParsed?.identifier
        let directLookupLikely = collectorNumber != nil && cropConfidence >= 0.55

        print("  🔍 [OCR] Parsed collector number: \(collectorNumber ?? "<none>")")
        print("  🔍 [OCR] Parsed set hints: \(setHintTokens)")

        let elapsed = Date().timeIntervalSince(startTime)
        if config.debug.verboseLogging {
            print("  ⏱️ [SCAN] Total: \(Int(elapsed * 1000))ms")
        }

        return AnalyzedCapture(
            scanID: scanID,
            originalImage: normalized,
            normalizedImage: UIImage(cgImage: cardImage),
            recognizedTokens: [],
            fullRecognizedText: metadataText,
            metadataStripRecognizedText: metadataText,
            topLabelRecognizedText: "",
            bottomLeftRecognizedText: bottomLeftText,
            bottomRightRecognizedText: bottomRightText,
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
            warnings: collectorNumber == nil ? ["Could not read identifier from bottom regions"] : []
        )
    }

    // MARK: - Private Methods

    private func detectAndCropCard(from cgImage: CGImage) throws -> (CGImage, Double) {
        let request = VNDetectRectanglesRequest()
        request.maximumObservations = 1
        request.minimumConfidence = config.cardDetection.minimumConfidence
        request.minimumAspectRatio = config.cardDetection.minimumAspectRatio
        request.maximumAspectRatio = config.cardDetection.maximumAspectRatio

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try handler.perform([request])

        guard let rectangle = request.results?.first else {
            if config.debug.verboseLogging {
                print("  ⚠️ [SCAN] No card rectangle detected inside reticle crop; using original crop")
            }
            return (cgImage, 1.0)
        }

        let areaCoverage = rectangle.boundingBox.width * rectangle.boundingBox.height
        if config.debug.verboseLogging {
            print("  🔍 [SCAN] Rectangle box: \(rectangle.boundingBox), confidence: \(rectangle.confidence), area: \(areaCoverage)")
        }

        guard areaCoverage >= 0.45 else {
            if config.debug.verboseLogging {
                print("  ⚠️ [SCAN] Rectangle too small to trust for footer OCR; using original crop")
            }
            return (cgImage, 1.0)
        }

        guard let cropped = cropWithInset(cgImage, observation: rectangle) else {
            if config.debug.verboseLogging {
                print("  ⚠️ [SCAN] Rectangle crop failed; using original crop")
            }
            return (cgImage, 1.0)
        }

        let croppedAspectRatio = cardAspectRatio(for: cropped)
        let minimumAcceptedAspectRatio = max(0, CGFloat(config.cardDetection.minimumAspectRatio) - 0.03)
        let maximumAcceptedAspectRatio = min(1, CGFloat(config.cardDetection.maximumAspectRatio) + 0.03)
        guard croppedAspectRatio >= minimumAcceptedAspectRatio,
              croppedAspectRatio <= maximumAcceptedAspectRatio else {
            if config.debug.verboseLogging {
                print("  ⚠️ [SCAN] Refined crop aspect ratio \(croppedAspectRatio) looks wrong; using original crop")
            }
            return (cgImage, 1.0)
        }

        if config.debug.verboseLogging {
            print("  ✅ [SCAN] Refined card crop to \(cropped.width)x\(cropped.height)")
        }

        return (cropped, max(0.75, Double(rectangle.confidence)))
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

    private func recognizeBottomRegion(in cardImage: CGImage, region: CGRect, label: String) throws -> String {
        print("  🔍 [OCR] Card size: \(cardImage.width)x\(cardImage.height)")
        print("  🔍 [OCR] Region: \(region)")

        guard let regionImage = cropToRect(cardImage, region: region) else {
            print("  ❌ [OCR] Failed to crop region!")
            return ""
        }

        print("  🔍 [OCR] Cropped region size: \(regionImage.width)x\(regionImage.height)")

        // Upscale only - no preprocessing (aggressive filters make text unreadable)
        let upscaled = upscale(regionImage, factor: config.bottomRegionOCR.upscaleFactor) ?? regionImage
        print("  🔍 [OCR] After \(config.bottomRegionOCR.upscaleFactor)x upscale: \(upscaled.width)x\(upscaled.height)")

        let targetImage = upscaled  // Use raw upscaled image

        if config.debug.saveDebugImages {
            saveDebugImage(targetImage, label: label)
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.minimumTextHeight = config.bottomRegionOCR.minimumTextHeight
        request.recognitionLanguages = ["en-US"]  // English only for better accuracy

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

        let tokens = observations.compactMap { observation -> String? in
            let text = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if let text = text {
                print("  🔍 [OCR] Detected: '\(text)' (confidence: \(observation.confidence))")
            }
            return text
        }

        return tokens.joined(separator: " ")
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
        image: UIImage,
        resolverModeHint: ResolverMode = .psaSlab
    ) async throws -> AnalyzedCapture {
        let startTime = Date()
        let normalized = image.normalizedOrientation()
        guard let cgImage = normalized.cgImage else {
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
            originalImage: normalized,
            normalizedImage: normalized,
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
            cropConfidence: 1.0,
            warnings: warnings
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

private extension UIImage {
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
