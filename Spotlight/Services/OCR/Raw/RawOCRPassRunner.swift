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
        guard let regionImage = cropToRect(cardImage, region: plan.cgRect) else {
            return RawOCRPassResult(
                kind: plan.kind,
                label: plan.label,
                normalizedRect: plan.normalizedRect,
                text: "",
                tokens: []
            )
        }

        let preprocessed = preprocess(regionImage, mode: plan.preprocessing) ?? regionImage
        let upscaled = upscale(preprocessed, factor: CGFloat(plan.upscaleFactor)) ?? preprocessed
        ScanStageArtifactWriter.recordRawRegionImage(
            scanID: scanID,
            image: UIImage(cgImage: upscaled),
            named: "\(plan.label).jpg"
        )

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = plan.usesLanguageCorrection
        request.minimumTextHeight = plan.minimumTextHeight
        request.recognitionLanguages = plan.recognitionLanguages
        if #available(iOS 16.0, *) {
            request.automaticallyDetectsLanguage = plan.recognitionLanguages.count > 1
        }

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

        let tokens = observations.compactMap { observation -> RecognizedToken? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return RecognizedToken(text: text, confidence: candidate.confidence)
        }

        return RawOCRPassResult(
            kind: plan.kind,
            label: plan.label,
            normalizedRect: plan.normalizedRect,
            text: tokens.map(\.text).joined(separator: " "),
            tokens: tokens
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
}
