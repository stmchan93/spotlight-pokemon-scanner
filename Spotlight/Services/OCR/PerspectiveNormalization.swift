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
    guard mode == .rawCard else {
        return OCRTargetNormalizationResult(
            image: image,
            geometryKind: .slab,
            reason: nil,
            normalizedContentRect: nil
        )
    }

    if chosenCandidate.geometryKind == .rawHolder || rawImageLooksLikeHolder(image) {
        if let innerCardImage = extractInnerRawCard(from: image) {
            return innerCardImage
        }
        return makeRawNormalizationResult(
            image: image,
            geometryKind: .rawHolder,
            reason: "holder_detected_inner_card_not_found"
        )
    }

    return makeRawNormalizationResult(image: image, geometryKind: .rawCard, reason: nil)
}

func normalizeFallbackOCRInputImage(
    searchImage: UIImage,
    fallbackImage: UIImage,
    mode: OCRTargetMode,
    scanID: UUID? = nil
) -> OCRTargetNormalizationResult {
    guard mode == .rawCard else {
        let normalizedSearch = searchImage.normalizedOrientation()
        return OCRTargetNormalizationResult(
            image: normalizedSearch,
            geometryKind: .slabLabel,
            reason: "slab_label_search_fallback",
            normalizedContentRect: nil
        )
    }

    if let recovered = recoverRawCardFromFallback(
        searchImage,
        source: .search,
        scanID: scanID
    ) {
        return recovered
    }

    if let recovered = recoverRawCardFromFallback(
        fallbackImage,
        source: .exact,
        scanID: scanID
    ) {
        return recovered
    }

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
        return makeRawNormalizationResult(
            image: normalizedInnerCard,
            geometryKind: .rawCard,
            reason: "holder_inner_card_detected"
        )
    }

    guard let heuristicCrop = heuristicInnerRawCardCrop(from: correctedCGImage) else {
        return nil
    }

    return makeRawNormalizationResult(
        image: UIImage(cgImage: heuristicCrop),
        geometryKind: .rawCard,
        reason: "holder_inner_card_inset_fallback"
    )
}

private enum RawFallbackRecoverySource: String {
    case search
    case exact
}

private struct PartialRawCardRemnantCandidate {
    let boundingBox: CGRect
    let totalScore: Double
}

private struct PartialRawCardRecovery {
    let remnantRect: CGRect
    let fullCardRect: CGRect
}

private func recoverRawCardFromFallback(
    _ image: UIImage,
    source: RawFallbackRecoverySource,
    scanID: UUID? = nil
) -> OCRTargetNormalizationResult? {
    guard let correctedCGImage = image.cgImage else { return nil }

    if let innerCardObservation = try? bestRawCardObservation(
        in: correctedCGImage,
        expectedWidthHeightAspect: 63.0 / 88.0,
        minimumAreaCoverage: 0.10,
        maxCenterDistance: 0.34
    ), let normalizedInnerCard = perspectiveCorrect(correctedCGImage, observation: innerCardObservation)?.normalizedOrientation() {
        return makeRawNormalizationResult(
            image: normalizedInnerCard,
            geometryKind: .rawCard,
            reason: "fallback_\(source.rawValue)_inner_card_detected"
        )
    }

    if let recoveredSmallCard = try? recoverLowSignalRawCardFromFallback(
        correctedCGImage,
        source: source
    ) {
        return recoveredSmallCard
    }

    if let recovered = try? recoverPartialRawCardFromRemnants(
        correctedCGImage,
        sourceImage: image,
        source: source,
        scanID: scanID
    ) {
        return recovered
    }

    if rawImageLooksLikeHolder(image),
       let holderRecovered = extractInnerRawCard(from: image) {
        return OCRTargetNormalizationResult(
            image: holderRecovered.image,
            geometryKind: .rawCard,
            reason: source == .search
                ? "fallback_search_card_inset_fallback"
                : "fallback_card_inset_fallback",
            normalizedContentRect: holderRecovered.normalizedContentRect
        )
    }

    return nil
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

private func recoverLowSignalRawCardFromFallback(
    _ cgImage: CGImage,
    source: RawFallbackRecoverySource
) throws -> OCRTargetNormalizationResult? {
    let expectedAspect = 63.0 / 88.0
    let searchImages = [cgImage, enhancedRawSelectionImage(from: cgImage)].compactMap { $0 }

    for candidateImage in searchImages {
        if let observation = try bestRawCardObservation(
            in: candidateImage,
            expectedWidthHeightAspect: expectedAspect,
            minimumAreaCoverage: 0.025,
            maxCenterDistance: 0.48,
            requestMinimumConfidence: 0.12,
            requestMinimumAspectRatio: 0.28,
            requestMaximumAspectRatio: 0.96,
            minimumAspectScore: 0.16
        ), let corrected = perspectiveCorrect(cgImage, observation: observation)?.normalizedOrientation() {
            return makeRawNormalizationResult(
                image: corrected,
                geometryKind: .rawCard,
                reason: "fallback_\(source.rawValue)_small_card_detected"
            )
        }
    }

    return nil
}

private func recoverPartialRawCardFromRemnants(
    _ cgImage: CGImage,
    sourceImage: UIImage,
    source: RawFallbackRecoverySource,
    scanID: UUID?
) throws -> OCRTargetNormalizationResult? {
    guard let recovery = try bestPartialRawCardRecovery(in: cgImage),
          let recoveredImage = renderRecoveredRawCardImage(from: cgImage, fullCardRect: recovery.fullCardRect) else {
        return nil
    }

    let remnantInRecoveredImage = recovery.remnantRect.offsetBy(
        dx: -recovery.fullCardRect.minX,
        dy: -recovery.fullCardRect.minY
    )
    let canonicalImage = canonicalizeRecoveredRawCardImage(
        recoveredImage,
        remnantRect: remnantInRecoveredImage
    ) ?? recoveredImage

    if let scanID {
        let overlay = drawPartialRawCardRecoveryOverlay(
            on: sourceImage,
            remnantRect: recovery.remnantRect,
            fullCardRect: recovery.fullCardRect
        )
        ScanStageArtifactWriter.recordRawRegionImage(
            scanID: scanID,
            image: overlay,
            named: source == .search
                ? "07_fallback_search_remnant_overlay.jpg"
                : "08_fallback_exact_remnant_overlay.jpg"
        )
    }

    return makeRawNormalizationResult(
        image: canonicalImage,
        geometryKind: .rawCard,
        reason: "fallback_\(source.rawValue)_partial_card_salvaged"
    )
}

private func bestPartialRawCardRecovery(in cgImage: CGImage) throws -> PartialRawCardRecovery? {
    let request = VNDetectRectanglesRequest()
    request.maximumObservations = 8
    request.minimumConfidence = 0.20
    request.minimumAspectRatio = 0.35
    request.maximumAspectRatio = 0.95

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])

    let imageBounds = CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height)
    let expectedAspect = 63.0 / 88.0
    let candidates = (request.results ?? []).compactMap { observation -> PartialRawCardRemnantCandidate? in
        let box = CGRect(
            x: observation.boundingBox.minX * imageBounds.width,
            y: (1 - observation.boundingBox.maxY) * imageBounds.height,
            width: observation.boundingBox.width * imageBounds.width,
            height: observation.boundingBox.height * imageBounds.height
        ).integral

        guard box.width > 0,
              box.height > 0 else {
            return nil
        }

        let areaCoverage = (box.width * box.height) / max(1, imageBounds.width * imageBounds.height)
        guard areaCoverage >= 0.06 else {
            return nil
        }

        let widthHeightAspect = box.width / max(1, box.height)
        let aspectDelta = abs(widthHeightAspect - expectedAspect)
        let aspectScore = max(0, 1 - (aspectDelta / 0.32))

        let center = CGPoint(x: box.midX / imageBounds.width, y: box.midY / imageBounds.height)
        let centerDistance = distance(from: center, to: CGPoint(x: 0.5, y: 0.5))
        let proximityScore = max(0, 1 - (centerDistance / 0.48))

        let edgeThresholdX = imageBounds.width * 0.08
        let edgeThresholdY = imageBounds.height * 0.08
        let touchesEdge =
            box.minX <= edgeThresholdX ||
            box.maxX >= imageBounds.width - edgeThresholdX ||
            box.minY <= edgeThresholdY ||
            box.maxY >= imageBounds.height - edgeThresholdY
        let edgeBonus = touchesEdge ? 0.10 : 0.0
        let areaScore = min(1.0, sqrt(areaCoverage / 0.34))

        let totalScore =
            (Double(proximityScore) * 0.28) +
            (Double(aspectScore) * 0.26) +
            (Double(observation.confidence) * 0.18) +
            (Double(areaScore) * 0.18) +
            edgeBonus

        guard totalScore >= 0.34 else {
            return nil
        }

        return PartialRawCardRemnantCandidate(
            boundingBox: box,
            totalScore: totalScore
        )
    }.sorted { lhs, rhs in
        lhs.totalScore > rhs.totalScore
    }

    guard let best = candidates.first else {
        return nil
    }

    var consensusRect = best.boundingBox
    for candidate in candidates.dropFirst() {
        guard candidate.totalScore >= best.totalScore - 0.08 else { continue }
        let overlapWithMerged = rectIntersectionOverUnion(consensusRect, candidate.boundingBox)
        if overlapWithMerged >= 0.42 {
            let intersection = consensusRect.intersection(candidate.boundingBox)
            if !intersection.isNull, intersection.width >= 40, intersection.height >= 60 {
                consensusRect = intersection.integral
            }
        }
    }

    let paddedRemnantRect = consensusRect.insetBy(
        dx: -max(6, consensusRect.width * 0.025),
        dy: -max(8, consensusRect.height * 0.03)
    )
    let fullCardRect = inferredFullRawCardRect(
        from: paddedRemnantRect,
        within: imageBounds,
        widthHeightAspect: expectedAspect
    )

    guard fullCardRect.width >= 120,
          fullCardRect.height >= 160 else {
        return nil
    }

    return PartialRawCardRecovery(
        remnantRect: paddedRemnantRect,
        fullCardRect: fullCardRect
    )
}

private func inferredFullRawCardRect(
    from remnantRect: CGRect,
    within imageBounds: CGRect,
    widthHeightAspect: CGFloat
) -> CGRect {
    var fullWidth = max(remnantRect.width, remnantRect.height * widthHeightAspect)
    var fullHeight = fullWidth / widthHeightAspect
    if fullHeight < remnantRect.height {
        fullHeight = remnantRect.height
        fullWidth = fullHeight * widthHeightAspect
    }

    let edgeThresholdX = imageBounds.width * 0.06
    let edgeThresholdY = imageBounds.height * 0.06
    let touchesLeft = remnantRect.minX <= edgeThresholdX
    let touchesRight = remnantRect.maxX >= imageBounds.width - edgeThresholdX
    let touchesTop = remnantRect.minY <= edgeThresholdY
    let touchesBottom = remnantRect.maxY >= imageBounds.height - edgeThresholdY

    let originX: CGFloat
    if touchesLeft && !touchesRight {
        originX = remnantRect.maxX - fullWidth
    } else if touchesRight && !touchesLeft {
        originX = remnantRect.minX
    } else {
        originX = remnantRect.midX - (fullWidth / 2)
    }

    let originY: CGFloat
    if touchesTop && !touchesBottom {
        originY = remnantRect.maxY - fullHeight
    } else if touchesBottom && !touchesTop {
        originY = remnantRect.minY
    } else {
        originY = remnantRect.midY - (fullHeight / 2)
    }

    return CGRect(
        x: originX,
        y: originY,
        width: fullWidth,
        height: fullHeight
    ).integral
}

private func rectIntersectionOverUnion(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
    let intersection = lhs.intersection(rhs)
    guard !intersection.isNull else { return 0 }

    let intersectionArea = intersection.width * intersection.height
    let unionArea = lhs.width * lhs.height + rhs.width * rhs.height - intersectionArea
    guard unionArea > 0 else { return 0 }
    return intersectionArea / unionArea
}

private func renderRecoveredRawCardImage(
    from cgImage: CGImage,
    fullCardRect: CGRect
) -> UIImage? {
    let canvasRect = fullCardRect.integral
    guard canvasRect.width > 0,
          canvasRect.height > 0,
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
            data: nil,
            width: Int(canvasRect.width),
            height: Int(canvasRect.height),
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else {
        return nil
    }

    context.setFillColor(UIColor.black.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: canvasRect.width, height: canvasRect.height))

    let sourceBounds = CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height)
    let visibleRect = canvasRect.intersection(sourceBounds).integral
    guard visibleRect.width > 0,
          visibleRect.height > 0,
          let visibleCrop = cgImage.cropping(to: visibleRect) else {
        return nil
    }

    let destinationRect = CGRect(
        x: visibleRect.minX - canvasRect.minX,
        y: visibleRect.minY - canvasRect.minY,
        width: visibleRect.width,
        height: visibleRect.height
    )
    context.interpolationQuality = .high
    context.draw(visibleCrop, in: destinationRect)

    guard let recovered = context.makeImage() else {
        return nil
    }

    return UIImage(cgImage: recovered)
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

private func canonicalizeRecoveredRawCardImage(
    _ image: UIImage,
    remnantRect: CGRect
) -> UIImage? {
    guard let recoveredCGImage = image.cgImage else {
        return nil
    }

    if let recoveredObservation = try? bestRawCardObservation(
        in: recoveredCGImage,
        expectedWidthHeightAspect: 63.0 / 88.0,
        minimumAreaCoverage: 0.16,
        maxCenterDistance: 0.42
    ), let normalizedRecovered = perspectiveCorrect(
        recoveredCGImage,
        observation: recoveredObservation
    )?.normalizedOrientation() {
        return normalizedRecovered
    }

    guard let heuristicCrop = heuristicRecoveredRawCardCrop(
        from: recoveredCGImage,
        remnantRect: remnantRect
    ) else {
        return nil
    }

    return UIImage(cgImage: heuristicCrop)
}

private func drawPartialRawCardRecoveryOverlay(
    on image: UIImage,
    remnantRect: CGRect,
    fullCardRect: CGRect
) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    if #available(iOS 12.0, *) {
        format.preferredRange = .standard
    }

    let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
    return renderer.image { _ in
        image.draw(in: CGRect(origin: .zero, size: image.size))

        let remnantPath = UIBezierPath(rect: remnantRect)
        UIColor.systemYellow.setStroke()
        remnantPath.lineWidth = 4
        remnantPath.stroke()

        let fullCardPath = UIBezierPath(rect: fullCardRect)
        UIColor.systemGreen.setStroke()
        fullCardPath.lineWidth = 4
        let dashPattern: [CGFloat] = [12, 8]
        fullCardPath.setLineDash(dashPattern, count: dashPattern.count, phase: 0)
        fullCardPath.stroke()
    }
}

private func heuristicRecoveredRawCardCrop(
    from cgImage: CGImage,
    remnantRect: CGRect
) -> CGImage? {
    let imageBounds = CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height)
    let paddedRemnant = remnantRect.insetBy(
        dx: -max(6, remnantRect.width * 0.03),
        dy: -max(8, remnantRect.height * 0.035)
    )
    let desiredCrop = centeredAspectFitRect(
        in: paddedRemnant,
        widthHeightAspect: 63.0 / 88.0
    )
    let clampedCrop = shiftRectToFit(desiredCrop.integral, within: imageBounds)

    guard clampedCrop.width > 0,
          clampedCrop.height > 0,
          let cropped = cgImage.cropping(to: clampedCrop) else {
        return nil
    }

    return cropped
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

private func shiftRectToFit(_ rect: CGRect, within bounds: CGRect) -> CGRect {
    guard rect.width > 0, rect.height > 0 else { return .null }

    var shifted = rect
    if shifted.width > bounds.width || shifted.height > bounds.height {
        return bounds.integral
    }

    if shifted.minX < bounds.minX {
        shifted.origin.x = bounds.minX
    }
    if shifted.maxX > bounds.maxX {
        shifted.origin.x = bounds.maxX - shifted.width
    }
    if shifted.minY < bounds.minY {
        shifted.origin.y = bounds.minY
    }
    if shifted.maxY > bounds.maxY {
        shifted.origin.y = bounds.maxY - shifted.height
    }

    return shifted.integral
}
