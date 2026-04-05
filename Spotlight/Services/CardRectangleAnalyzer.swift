import Foundation
import UIKit
import Vision

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
            edgeInsetPercentage: 0.10  // 10% inset to exclude thick card holders
        )
    }

    struct BottomRegionOCR {
        let bottomLeftRegion: CGRect
        let bottomRightRegion: CGRect
        let minimumTextHeight: Float
        let upscaleFactor: CGFloat

        static let `default` = BottomRegionOCR(
            // Target the VERY bottom identifier strip (last 6% of card only)
            bottomLeftRegion: CGRect(x: 0.08, y: 0.93, width: 0.40, height: 0.06),
            bottomRightRegion: CGRect(x: 0.52, y: 0.93, width: 0.40, height: 0.06),
            minimumTextHeight: 0.003,  // More sensitive
            upscaleFactor: 2.5  // Higher quality
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
        debug: .disabled
    )
}

// MARK: - Identifier Parser

/// Parsed card identifier with confidence score
private struct ParsedIdentifier {
    let identifier: String
    let confidence: Float
    let sourceRegion: String
}

/// Parser for Pokémon card bottom identifiers
private struct IdentifierParser {
    private enum Pattern {
        case prefixed       // TG23/TG30, GG37/GG70
        case standard       // 123/197
        case promo          // SVP 056, SWSH123
        case compact        // 123197 (6 digits)

        var regex: String {
            switch self {
            case .prefixed: return #"\b[A-Z]{1,3}\d{1,3}/[A-Z]{1,3}\d{1,3}\b"#
            case .standard: return #"\b\d{1,3}/\d{1,3}\b"#
            case .promo: return #"\b(?:SVP|SWSH|SM|XY|BW|DP|HGSS|POP|PR)\s?\d{1,3}\b"#
            case .compact: return #"\b\d{6}\b"#
            }
        }

        var boost: Float {
            switch self {
            case .prefixed: return 0.95
            case .standard: return 1.0
            case .promo: return 0.9
            case .compact: return 0.7
            }
        }
    }

    func parse(text: String, sourceRegion: String) -> ParsedIdentifier? {
        guard !text.isEmpty else { return nil }
        let normalized = normalize(text)

        for pattern in [Pattern.prefixed, .standard, .promo, .compact] {
            if let match = firstMatch(in: normalized, pattern: pattern.regex) {
                let cleaned = clean(match)
                let confidence = min(1.0, pattern.boost + (normalized.count < 20 ? 0.05 : 0.0))

                return ParsedIdentifier(
                    identifier: cleaned,
                    confidence: confidence,
                    sourceRegion: sourceRegion
                )
            }
        }

        return nil
    }

    func chooseBetter(_ left: ParsedIdentifier?, _ right: ParsedIdentifier?) -> ParsedIdentifier? {
        guard let left = left else { return right }
        guard let right = right else { return left }
        return left.confidence >= right.confidence ? left : right
    }

    private func normalize(_ text: String) -> String {
        text
            .uppercased()
            // Normalize set code + EN patterns
            .replacingOccurrences(of: #"\b([A-Z]{2,4})\s*EN\s*(\d{1,3})\b"#, with: "$1 $2", options: .regularExpression)
            .replacingOccurrences(of: #"\b([A-Z]{2,4})EN\s*(\d{1,3})\b"#, with: "$1 $2", options: .regularExpression)
            // Fix common OCR mistakes
            .replacingOccurrences(of: "O", with: "0")  // O → 0 in context
            .replacingOccurrences(of: #"(?<=\d)[I|L](?=\d)"#, with: "/", options: .regularExpression)  // I or L between digits → /
            .replacingOccurrences(of: #"(?<=\d)\s+(?=\d{2,3}\b)"#, with: "/", options: .regularExpression)  // Space before 2-3 digits → /
            // Fix repeated letter patterns with missing slash: GG37GG70 → GG37/GG70
            .replacingOccurrences(of: #"([A-Z]{2})(\d{1,3})([A-Z]{2})(\d{1,3})"#, with: "$1$2/$3$4", options: .regularExpression)
    }

    private func clean(_ identifier: String) -> String {
        // Handle compact 6-digit format
        if identifier.count == 6, identifier.allSatisfy(\.isNumber) {
            return "\(identifier.prefix(3))/\(identifier.suffix(3))"
        }

        return identifier
            .replacingOccurrences(of: #"\s*/\s*"#, with: "/", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func firstMatch(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              let matchRange = Range(match.range, in: text) else {
            return nil
        }
        return String(text[matchRange])
    }
}

// MARK: - Main Scanner

/// Fast, focused scanner for raw Pokémon cards - ONLY scans bottom regions
actor RawCardScanner {
    private let config: RawCardScanConfiguration
    private let parser = IdentifierParser()

    init(config: RawCardScanConfiguration = .default) {
        self.config = config
    }

    func analyze(scanID: UUID, image: UIImage) async throws -> AnalyzedCapture {
        let startTime = Date()

        // Step 1: Normalize
        if config.debug.verboseLogging {
            print("  🔍 [SCAN] Step 1: Normalizing orientation")
        }
        let normalized = image.normalizedOrientation()
        guard let baseCGImage = normalized.cgImage else {
            throw AnalysisError.invalidImage
        }

        // Step 2: Detect and crop card
        if config.debug.verboseLogging {
            print("  🔍 [SCAN] Step 2: Detecting card rectangle")
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
        let bestParsed = parser.chooseBetter(leftParsed, rightParsed)

        if config.debug.verboseLogging {
            if let best = bestParsed {
                print("  ✅ [SCAN] Identifier: \(best.identifier) (conf: \(best.confidence), from: \(best.sourceRegion))")
            } else {
                print("  ❌ [SCAN] No identifier parsed")
            }
        }

        let collectorNumber = bestParsed?.identifier
        let directLookupLikely = collectorNumber != nil && cropConfidence >= 0.55

        let elapsed = Date().timeIntervalSince(startTime)
        if config.debug.verboseLogging {
            print("  ⏱️ [SCAN] Total: \(Int(elapsed * 1000))ms")
        }

        return AnalyzedCapture(
            scanID: scanID,
            originalImage: normalized,
            normalizedImage: UIImage(cgImage: cardImage),
            recognizedTokens: [],
            fullRecognizedText: "",
            metadataStripRecognizedText: "",
            topLabelRecognizedText: "",
            bottomLeftRecognizedText: bottomLeftText,
            bottomRightRecognizedText: bottomRightText,
            collectorNumber: collectorNumber,
            setHintTokens: [],
            promoCodeHint: extractPromoHint(from: collectorNumber),
            directLookupLikely: directLookupLikely,
            resolverModeHint: .rawCard,
            cropConfidence: cropConfidence,
            warnings: collectorNumber == nil ? ["Could not read identifier from bottom regions"] : []
        )
    }

    // MARK: - Private Methods

    private func detectAndCropCard(from cgImage: CGImage) throws -> (CGImage, Double) {
        if isLikelyCardFramed(cgImage) {
            return (cgImage, 1.0)
        }

        let request = VNDetectRectanglesRequest()
        request.maximumObservations = 1
        request.minimumConfidence = config.cardDetection.minimumConfidence
        request.minimumAspectRatio = config.cardDetection.minimumAspectRatio
        request.maximumAspectRatio = config.cardDetection.maximumAspectRatio

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try handler.perform([request])

        guard let rectangle = request.results?.first else {
            return (cgImage, 0.3)
        }

        guard let cropped = cropWithInset(cgImage, observation: rectangle) else {
            return (cgImage, Double(rectangle.confidence) * 0.5)
        }

        return (cropped, Double(rectangle.confidence))
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

        return cgImage.cropping(to: cropRect)
    }

    private func recognizeBottomRegion(in cardImage: CGImage, region: CGRect, label: String) throws -> String {
        guard let regionImage = cropToRect(cardImage, region: region) else {
            return ""
        }

        let targetImage = upscale(regionImage, factor: config.bottomRegionOCR.upscaleFactor) ?? regionImage

        if config.debug.saveDebugImages {
            saveDebugImage(targetImage, label: label)
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.minimumTextHeight = config.bottomRegionOCR.minimumTextHeight

        let handler = VNImageRequestHandler(cgImage: targetImage, options: [:])
        try handler.perform([request])

        let tokens = request.results?.compactMap { observation -> String? in
            observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
        } ?? []

        return tokens.joined(separator: " ")
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

        let size = CGSize(
            width: CGFloat(cgImage.width) * factor,
            height: CGFloat(cgImage.height) * factor
        )

        return UIGraphicsImageRenderer(size: size).image { _ in
            UIImage(cgImage: cgImage).draw(in: CGRect(origin: .zero, size: size))
        }.cgImage
    }

    private func isLikelyCardFramed(_ cgImage: CGImage) -> Bool {
        let ratio = CGFloat(cgImage.width) / CGFloat(max(cgImage.height, 1))
        return abs(ratio - 0.716) <= 0.035
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

    private func saveDebugImage(_ cgImage: CGImage, label: String) {
        let timestamp = Int(Date().timeIntervalSince1970)
        let filename = "scan_debug_\(label)_\(timestamp).png"

        guard let data = UIImage(cgImage: cgImage).pngData(),
              let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return
        }

        let filePath = path.appendingPathComponent(filename)
        try? data.write(to: filePath)
        print("  💾 [DEBUG] Saved region: \(filePath.path)")
    }
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
        return UIGraphicsImageRenderer(size: size).image { _ in
            draw(in: CGRect(origin: .zero, size: size))
        }
    }
}
