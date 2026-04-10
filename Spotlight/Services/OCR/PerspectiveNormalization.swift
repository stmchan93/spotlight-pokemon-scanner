import CoreImage
import UIKit
import Vision

struct OCRTargetNormalizationResult {
    let image: UIImage
    let geometryKind: OCRTargetGeometryKind
    let reason: String?
}

func normalizeOCRInputImage(
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
        return OCRTargetNormalizationResult(
            image: image,
            geometryKind: .rawHolder,
            reason: "holder_detected_inner_card_not_found"
        )
    }

    return OCRTargetNormalizationResult(image: image, geometryKind: .rawCard, reason: nil)
}

func normalizeFallbackOCRInputImage(
    _ image: UIImage,
    mode: OCRTargetMode
) -> OCRTargetNormalizationResult {
    guard mode == .rawCard else {
        return OCRTargetNormalizationResult(image: image, geometryKind: .fallback, reason: "exact_reticle_fallback")
    }

    if let recovered = recoverRawCardFromFallback(image) {
        return recovered
    }

    return OCRTargetNormalizationResult(
        image: image,
        geometryKind: .fallback,
        reason: "exact_reticle_fallback"
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

private func recoverRawCardFromFallback(_ image: UIImage) -> OCRTargetNormalizationResult? {
    guard let correctedCGImage = image.cgImage else { return nil }

    if let innerCardObservation = try? bestRawCardObservation(
        in: correctedCGImage,
        expectedWidthHeightAspect: 63.0 / 88.0,
        minimumAreaCoverage: 0.10,
        maxCenterDistance: 0.34
    ), let normalizedInnerCard = perspectiveCorrect(correctedCGImage, observation: innerCardObservation)?.normalizedOrientation() {
        return OCRTargetNormalizationResult(
            image: normalizedInnerCard,
            geometryKind: .rawCard,
            reason: "fallback_inner_card_detected"
        )
    }

    if let holderRecovered = extractInnerRawCard(from: image) {
        return OCRTargetNormalizationResult(
            image: holderRecovered.image,
            geometryKind: .rawCard,
            reason: "fallback_card_inset_fallback"
        )
    }

    return nil
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
