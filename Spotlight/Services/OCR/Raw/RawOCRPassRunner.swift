import CoreGraphics
import Foundation
import UIKit
import Vision

struct RawOCRPassResult: Codable, Hashable, Sendable {
    let kind: RawROIKind
    let label: String
    let normalizedRect: OCRNormalizedRect
    let text: String
    let tokens: [RecognizedToken]
    let durationMs: Double
    let recognitionRequestCount: Int
    let usedAggressiveRetry: Bool
    let footerFamily: RawFooterFamily?
    let footerRole: RawFooterFieldRole?

    init(
        kind: RawROIKind,
        label: String,
        normalizedRect: OCRNormalizedRect,
        text: String,
        tokens: [RecognizedToken],
        durationMs: Double = 0,
        recognitionRequestCount: Int = 0,
        usedAggressiveRetry: Bool = false,
        footerFamily: RawFooterFamily? = nil,
        footerRole: RawFooterFieldRole? = nil
    ) {
        self.kind = kind
        self.label = label
        self.normalizedRect = normalizedRect
        self.text = text
        self.tokens = tokens
        self.durationMs = durationMs
        self.recognitionRequestCount = recognitionRequestCount
        self.usedAggressiveRetry = usedAggressiveRetry
        self.footerFamily = footerFamily
        self.footerRole = footerRole
    }

    var averageConfidence: Double {
        guard !tokens.isEmpty else { return 0 }
        return Double(tokens.map(\.confidence).reduce(0, +)) / Double(tokens.count)
    }

    var artifactRegion: ScanStageRawRegionArtifact {
        ScanStageRawRegionArtifact(
            label: label,
            normalizedRect: ScanDebugRect(
                CGRect(
                    x: normalizedRect.x,
                    y: normalizedRect.y,
                    width: normalizedRect.width,
                    height: normalizedRect.height
                )
            ),
            text: text,
            averageConfidence: averageConfidence,
            tokens: tokens
        )
    }
}

actor RawOCRPassRunner {
    private let metadataParser = CardIdentifierParser()

    func run(
        scanID: UUID,
        in cardImage: CGImage,
        plans: [RawROIPlanItem]
    ) throws -> [RawOCRPassResult] {
        try plans.map { plan in
            try recognize(plan: plan, scanID: scanID, cardImage: cardImage)
        }
    }

    private func recognize(
        plan: RawROIPlanItem,
        scanID: UUID,
        cardImage: CGImage
    ) throws -> RawOCRPassResult {
        let startedAt = Date().timeIntervalSinceReferenceDate

        guard let regionImage = cropToRect(cardImage, region: plan.cgRect) else {
            return RawOCRPassResult(
                kind: plan.kind,
                label: plan.label,
                normalizedRect: plan.normalizedRect,
                text: "",
                tokens: [],
                durationMs: (Date().timeIntervalSinceReferenceDate - startedAt) * 1000,
                recognitionRequestCount: 0,
                usedAggressiveRetry: false,
                footerFamily: plan.footerFamily,
                footerRole: plan.footerRole
            )
        }

        let preprocessed = preprocess(regionImage, mode: plan.preprocessing) ?? regionImage
        let upscaled = upscale(preprocessed, factor: CGFloat(plan.upscaleFactor)) ?? preprocessed
        ScanStageArtifactWriter.recordRawRegionImage(
            scanID: scanID,
            image: UIImage(cgImage: upscaled),
            named: "\(plan.label).jpg"
        )

        var recognitionRequestCount = 0
        var usedAggressiveRetry = false

        recognitionRequestCount += 1
        var tokens = try recognizeTokens(
            in: upscaled,
            plan: plan,
            recognitionLanguages: plan.recognitionLanguages
        )

        if tokens.isEmpty,
           shouldRetryAggressiveFooterOCR(for: plan),
           let aggressivelyPreprocessed = preprocessAggressivelyForFooterOCR(regionImage),
           let aggressivelyUpscaled = upscale(
                aggressivelyPreprocessed,
                factor: CGFloat(max(plan.upscaleFactor, 5.8))
           ) {
            usedAggressiveRetry = true
            if let aggressiveImage = UIImage(cgImage: aggressivelyUpscaled).jpegData(compressionQuality: 0.92) {
                ScanStageArtifactWriter.recordRawRegionImage(
                    scanID: scanID,
                    image: UIImage(data: aggressiveImage) ?? UIImage(cgImage: aggressivelyUpscaled),
                    named: "\(plan.label)_aggressive.jpg"
                )
            }

            for languages in aggressiveRecognitionLanguageAttempts(for: plan) {
                recognitionRequestCount += 1
                let aggressiveTokens = try recognizeTokens(
                    in: aggressivelyUpscaled,
                    plan: plan,
                    recognitionLanguages: languages
                )
                if !aggressiveTokens.isEmpty {
                    tokens = aggressiveTokens
                    break
                }
            }
        }

        return RawOCRPassResult(
            kind: plan.kind,
            label: plan.label,
            normalizedRect: plan.normalizedRect,
            text: tokens.map(\.text).joined(separator: " "),
            tokens: tokens,
            durationMs: (Date().timeIntervalSinceReferenceDate - startedAt) * 1000,
            recognitionRequestCount: recognitionRequestCount,
            usedAggressiveRetry: usedAggressiveRetry,
            footerFamily: plan.footerFamily,
            footerRole: plan.footerRole
        )
    }

    private func recognizeTokens(
        in image: CGImage,
        plan: RawROIPlanItem,
        recognitionLanguages: [String]
    ) throws -> [RecognizedToken] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = plan.usesLanguageCorrection
        request.minimumTextHeight = plan.minimumTextHeight
        request.recognitionLanguages = recognitionLanguages
        if #available(iOS 16.0, *) {
            request.automaticallyDetectsLanguage = recognitionLanguages.count > 1
        }

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])

        let observations = (request.results ?? []).sorted {
            let lhsTop = $0.boundingBox.maxY
            let rhsTop = $1.boundingBox.maxY
            if abs(lhsTop - rhsTop) > 0.05 {
                return lhsTop > rhsTop
            }
            return $0.boundingBox.minX < $1.boundingBox.minX
        }

        return observations.compactMap { observation -> RecognizedToken? in
            guard let candidate = preferredRecognizedTextCandidate(from: observation, plan: plan) else { return nil }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return RecognizedToken(
                text: text,
                confidence: candidate.confidence,
                normalizedBoundingBox: canvasNormalizedBoundingBox(
                    for: observation.boundingBox,
                    planRect: plan.normalizedRect
                )
            )
        }
    }

    private func canvasNormalizedBoundingBox(
        for localBoundingBox: CGRect,
        planRect: OCRNormalizedRect
    ) -> OCRNormalizedRect {
        let localTopLeftRect = CGRect(
            x: localBoundingBox.minX,
            y: 1 - localBoundingBox.maxY,
            width: localBoundingBox.width,
            height: localBoundingBox.height
        )

        return OCRNormalizedRect(
            x: planRect.x + (Double(localTopLeftRect.minX) * planRect.width),
            y: planRect.y + (Double(localTopLeftRect.minY) * planRect.height),
            width: Double(localTopLeftRect.width) * planRect.width,
            height: Double(localTopLeftRect.height) * planRect.height
        )
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
        let clampedScale = longestSide > maxLongestSide ? maxLongestSide / longestSide : 1.0

        let width = Int((requestedWidth * clampedScale).rounded(.toNearestOrAwayFromZero))
        let height = Int((requestedHeight * clampedScale).rounded(.toNearestOrAwayFromZero))

        guard width > 0,
              height > 0,
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

    private func preprocess(_ cgImage: CGImage, mode: RawOCRPreprocessing) -> CGImage? {
        switch mode {
        case .none:
            return cgImage
        case .contrastBoosted:
            let ciImage = CIImage(cgImage: cgImage)
            guard let enhanced = CIFilter(name: "CIColorControls", parameters: [
                kCIInputImageKey: ciImage,
                kCIInputContrastKey: 1.3,
                kCIInputBrightnessKey: 0.05,
                kCIInputSaturationKey: 0.0,
            ])?.outputImage else {
                return nil
            }
            let context = CIContext(options: [.useSoftwareRenderer: false])
            return context.createCGImage(enhanced, from: enhanced.extent)
        }
    }

    private func preprocessAggressivelyForFooterOCR(_ cgImage: CGImage) -> CGImage? {
        let ciImage = CIImage(cgImage: cgImage)
        guard let monochrome = CIFilter(name: "CIColorControls", parameters: [
            kCIInputImageKey: ciImage,
            kCIInputContrastKey: 1.7,
            kCIInputBrightnessKey: 0.08,
            kCIInputSaturationKey: 0.0,
        ])?.outputImage,
        let sharpened = CIFilter(name: "CISharpenLuminance", parameters: [
            kCIInputImageKey: monochrome,
            kCIInputSharpnessKey: 0.5,
        ])?.outputImage else {
            return nil
        }

        let context = CIContext(options: [.useSoftwareRenderer: false])
        return context.createCGImage(sharpened, from: sharpened.extent)
    }

    private func shouldRetryAggressiveFooterOCR(for plan: RawROIPlanItem) -> Bool {
        switch plan.kind {
        case .footerBandWide, .footerLeft, .footerRight, .footerMetadata:
            return true
        case .headerWide:
            return false
        }
    }

    private func aggressiveRecognitionLanguageAttempts(for plan: RawROIPlanItem) -> [[String]] {
        switch plan.kind {
        case .footerBandWide, .footerLeft, .footerRight, .footerMetadata:
            return [
                ["en-US"],
                ["ja-JP"],
                plan.recognitionLanguages
            ]
        case .headerWide:
            return [plan.recognitionLanguages]
        }
    }

    private func preferredRecognizedTextCandidate(
        from observation: VNRecognizedTextObservation,
        plan: RawROIPlanItem
    ) -> VNRecognizedText? {
        let maxCandidates = metadataCandidateLimit(for: plan.kind)
        let candidates = observation.topCandidates(maxCandidates)
        guard !candidates.isEmpty else { return nil }
        guard maxCandidates > 1 else { return candidates.first }

        return candidates.max { lhs, rhs in
            preferredCandidateScore(for: lhs, plan: plan) < preferredCandidateScore(for: rhs, plan: plan)
        }
    }

    private func metadataCandidateLimit(for kind: RawROIKind) -> Int {
        switch kind {
        case .footerBandWide, .footerLeft, .footerRight, .footerMetadata:
            return 3
        case .headerWide:
            return 1
        }
    }

    private func preferredCandidateScore(for candidate: VNRecognizedText, plan: RawROIPlanItem) -> Int {
        let trimmed = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = normalizeConfusableLatinCharacters(in: trimmed).uppercased()
        var score = Int((candidate.confidence * 100).rounded())

        if metadataParser.parse(text: trimmed, sourceRegion: "ocr_pass_runner") != nil {
            score += 180
        }
        if normalized.range(of: #"\d{1,3}\s*/+\s*\d{2,3}"#, options: .regularExpression) != nil {
            score += 120
        }
        if normalized.range(of: #"\b[A-Z]{2,5}\s*(?:EN|JP|DE|FR|IT|ES|PT)?\b"#, options: .regularExpression) != nil {
            score += 55
        }
        if plan.kind == .footerMetadata || plan.kind == .footerLeft || plan.kind == .footerRight || plan.kind == .footerBandWide {
            if normalized.contains("DRI") || normalized.contains("OBF") || normalized.contains("PAR") || normalized.contains("PAL") {
                score += 60
            }
        }
        switch plan.footerRole {
        case .collector:
            if metadataParser.parse(text: trimmed, sourceRegion: "ocr_pass_runner_collector") != nil {
                score += 120
            }
            if normalized.range(of: #"\d{1,3}\s*/+\s*\d{2,3}"#, options: .regularExpression) != nil {
                score += 80
            }
            if normalized.allSatisfy({ $0.isNumber || $0 == "/" || $0 == " " }) {
                score += 35
            }
        case .setBadge:
            if normalized.range(of: #"\b[A-Z]{3,5}\b"#, options: .regularExpression) != nil {
                score += 90
            }
            if normalized.count <= 6 {
                score += 30
            }
            if normalized.contains("/") {
                score -= 60
            }
        case nil:
            break
        }
        if normalized.contains("//") {
            score += 15
        }
        if trimmed.count < 3 {
            score -= 40
        }

        return score
    }
}
