import CoreImage
import UIKit
import Vision

private let rawCanonicalCanvasSize = CGSize(width: 630, height: 880)

struct OCRTargetNormalizationResult {
    let image: UIImage
    let geometryKind: OCRTargetGeometryKind
    let reason: String?
    let normalizedContentRect: OCRNormalizedRect?
}

private struct RawCanonicalizationResult {
    let image: UIImage
    let normalizedContentRect: OCRNormalizedRect
}

private let fullNormalizedCanvasRect = OCRNormalizedRect(
    x: 0,
    y: 0,
    width: 1,
    height: 1
)

func normalizeOCRInputImage(
    _ image: UIImage,
    chosenCandidate: OCRTargetCandidateSummary,
    mode: OCRTargetMode
) -> OCRTargetNormalizationResult {
    _ = chosenCandidate
    guard mode == .rawCard else {
        return OCRTargetNormalizationResult(
            image: image,
            geometryKind: .slab,
            reason: nil,
            normalizedContentRect: nil
        )
    }

    // Keep the happy path simple: perspective-correct the accepted rectangle,
    // then canonicalize it. Do not reinterpret holder edges or infer missing card area.
    return makeRawNormalizationResult(
        image: image,
        geometryKind: .rawCard,
        reason: "basic_perspective_canonicalization"
    )
}

func normalizeFallbackOCRInputImage(
    searchImage: UIImage,
    fallbackImage: UIImage,
    mode: OCRTargetMode,
    scanID: UUID? = nil
) -> OCRTargetNormalizationResult {
    _ = searchImage
    _ = scanID
    guard mode == .rawCard else {
        let normalizedSearch = searchImage.normalizedOrientation()
        return OCRTargetNormalizationResult(
            image: normalizedSearch,
            geometryKind: .slabLabel,
            reason: "slab_label_search_fallback",
            normalizedContentRect: nil
        )
    }

    // Weak or ambiguous detection falls back to the exact reticle crop directly.
    let normalizedFallback = fallbackImage.normalizedOrientation()
    let canonicalized = canonicalizeRawCardImage(normalizedFallback) ?? RawCanonicalizationResult(
        image: normalizedFallback,
        normalizedContentRect: fullNormalizedCanvasRect
    )
    return OCRTargetNormalizationResult(
        image: canonicalized.image,
        geometryKind: .fallback,
        reason: "exact_reticle_fallback",
        normalizedContentRect: canonicalized.normalizedContentRect
    )
}

func perspectiveCorrect(_ cgImage: CGImage, observation: VNRectangleObservation) -> UIImage? {
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

func distance(from lhs: CGPoint, to rhs: CGPoint) -> CGFloat {
    let dx = lhs.x - rhs.x
    let dy = lhs.y - rhs.y
    return sqrt((dx * dx) + (dy * dy))
}

private func pointInImage(_ normalizedPoint: CGPoint, width: CGFloat, height: CGFloat) -> CGPoint {
    CGPoint(x: normalizedPoint.x * width, y: normalizedPoint.y * height)
}

func bestRawCardObservation(
    in cgImage: CGImage,
    expectedWidthHeightAspect: CGFloat,
    minimumAreaCoverage: CGFloat,
    maxCenterDistance: CGFloat,
    requestMinimumConfidence: CGFloat = 0.25,
    requestMinimumAspectRatio: CGFloat = 0.50,
    requestMaximumAspectRatio: CGFloat = 0.90,
    minimumAspectScore: CGFloat = 0.40
) throws -> VNRectangleObservation? {
    let request = VNDetectRectanglesRequest()
    request.maximumObservations = 6
    request.minimumConfidence = Float(requestMinimumConfidence)
    request.minimumAspectRatio = Float(requestMinimumAspectRatio)
    request.maximumAspectRatio = Float(requestMaximumAspectRatio)

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
        guard aspectScore >= minimumAspectScore else { return nil }

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

func enhancedRawSelectionImage(from cgImage: CGImage) -> CGImage? {
    let ciImage = CIImage(cgImage: cgImage)
    guard let adjusted = CIFilter(name: "CIColorControls", parameters: [
        kCIInputImageKey: ciImage,
        kCIInputContrastKey: 1.45,
        kCIInputBrightnessKey: 0.04,
        kCIInputSaturationKey: 0.0,
    ])?.outputImage else {
        return nil
    }

    let context = CIContext(options: [.useSoftwareRenderer: false])
    return context.createCGImage(adjusted, from: adjusted.extent)
}

private func makeRawNormalizationResult(
    image: UIImage,
    geometryKind: OCRTargetGeometryKind,
    reason: String?
) -> OCRTargetNormalizationResult {
    let normalized = image.normalizedOrientation()
    let canonicalized = canonicalizeRawCardImage(normalized) ?? RawCanonicalizationResult(
        image: normalized,
        normalizedContentRect: fullNormalizedCanvasRect
    )
    return OCRTargetNormalizationResult(
        image: canonicalized.image,
        geometryKind: geometryKind,
        reason: reason,
        normalizedContentRect: canonicalized.normalizedContentRect
    )
}

private func canonicalizeRawCardImage(_ image: UIImage) -> RawCanonicalizationResult? {
    guard image.size.width > 0, image.size.height > 0 else {
        return nil
    }

    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    if #available(iOS 12.0, *) {
        format.preferredRange = .standard
    }

    let canvasRect = CGRect(origin: .zero, size: rawCanonicalCanvasSize)
    let renderer = UIGraphicsImageRenderer(size: rawCanonicalCanvasSize, format: format)
    let drawRect = aspectFitRect(
        for: image.size,
        in: canvasRect
    )
    let renderedImage = renderer.image { _ in
        UIColor.black.setFill()
        UIRectFill(canvasRect)
        image.draw(in: drawRect)
    }
    return RawCanonicalizationResult(
        image: renderedImage,
        normalizedContentRect: normalizedRect(drawRect, within: canvasRect)
    )
}

private func aspectFitRect(for sourceSize: CGSize, in destinationRect: CGRect) -> CGRect {
    guard sourceSize.width > 0,
          sourceSize.height > 0,
          destinationRect.width > 0,
          destinationRect.height > 0 else {
        return destinationRect
    }

    let widthScale = destinationRect.width / sourceSize.width
    let heightScale = destinationRect.height / sourceSize.height
    let scale = min(widthScale, heightScale)
    let scaledSize = CGSize(
        width: sourceSize.width * scale,
        height: sourceSize.height * scale
    )

    return CGRect(
        x: destinationRect.midX - (scaledSize.width / 2),
        y: destinationRect.midY - (scaledSize.height / 2),
        width: scaledSize.width,
        height: scaledSize.height
    )
}

private func normalizedRect(_ rect: CGRect, within bounds: CGRect) -> OCRNormalizedRect {
    guard bounds.width > 0, bounds.height > 0 else {
        return fullNormalizedCanvasRect
    }

    return OCRNormalizedRect(
        x: Double((rect.minX - bounds.minX) / bounds.width),
        y: Double((rect.minY - bounds.minY) / bounds.height),
        width: Double(rect.width / bounds.width),
        height: Double(rect.height / bounds.height)
    )
}
