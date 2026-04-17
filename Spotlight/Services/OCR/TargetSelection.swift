import UIKit
import Vision

enum OCRTargetMode: String, Codable {
    case rawCard = "raw"
    case psaSlab = "psa"

    var expectedAspectRatio: CGFloat {
        switch self {
        case .rawCard:
            // Use width/height aspect so selection scoring matches the
            // downstream raw-card perspective-correction path.
            return 63.0 / 88.0
        case .psaSlab:
            return 3.25 / 5.375
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
    case slabLabel = "slab_label"
    case fallback = "fallback"
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

struct OCRTargetSelectionResult: @unchecked Sendable {
    let normalizedImage: UIImage
    let normalizedContentRect: OCRNormalizedRect?
    let selectionConfidence: Double
    let usedFallback: Bool
    let fallbackReason: String?
    let chosenCandidateIndex: Int?
    let candidates: [OCRTargetCandidateSummary]
    let normalizedGeometryKind: OCRTargetGeometryKind
    let normalizationReason: String?
}

private struct OCRTargetSelectionCandidate {
    let observation: VNRectangleObservation
    let summary: OCRTargetCandidateSummary
}

private struct OCRRelaxedDetectionResult {
    let observation: VNRectangleObservation
    let sourceLabel: String
}

private struct OCRFallbackNormalizationSelection {
    let result: OCRTargetNormalizationResult
    let chosenCandidateIndex: Int?
}

private let fallbackSelectionConfidenceCap = 0.58
private let fallbackSelectionConfidenceFloor = 0.40
private let fallbackSelectionPenalty = 0.18

func selectOCRInput(
    scanID: UUID,
    capture: ScanCaptureInput,
    mode: OCRTargetMode
) throws -> OCRTargetSelectionResult {
    let frameSources = selectOCRFrameSources(from: capture)
    let searchImage = frameSources.searchImage
    let fallbackImage = frameSources.fallbackImage

    guard let searchCGImage = searchImage.cgImage else {
        throw AnalysisError.invalidImage
    }

    let candidates = try detectRectangleCandidates(in: searchCGImage, mode: mode)
    let chosenCandidate = chooseBestCandidate(from: candidates, mode: mode)
    let candidateOverlayImage = drawCandidateOverlay(on: searchImage, candidates: candidates, chosenIndex: chosenCandidate?.summary.rank)

    if let chosenCandidate,
       let correctedCandidateImage = perspectiveCorrect(searchCGImage, observation: chosenCandidate.observation) {
        let normalizedCandidateImage = correctedCandidateImage.normalizedOrientation()
        if mode == .psaSlab, !slabPerspectiveLooksValid(normalizedCandidateImage) {
            print(
                "  ⚠️ [TARGET] mode=\(mode.rawValue) reject chosen=#\(chosenCandidate.summary.rank) " +
                "score=\(String(format: "%.2f", chosenCandidate.summary.totalScore)) " +
                "reason=slab_candidate_not_portrait"
            )
        } else {
            // Accepted rectangle: no relaxed retries or salvage, just use the corrected crop.
            let normalizationResult = normalizeOCRInputImage(
                normalizedCandidateImage,
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
            ScanStageArtifactWriter.recordSelectionArtifacts(
                scanID: scanID,
                mode: mode,
                source: capture.captureSource,
                selectedTargetImage: normalizedCandidateImage,
                candidateOverlayImage: candidateOverlayImage,
                normalizedImage: normalizedImage,
                normalizedContentRect: normalizationResult.normalizedContentRect,
                chosenCandidateIndex: chosenCandidate.summary.rank,
                candidates: candidates.map(\.summary),
                fallbackReason: fallbackReason,
                normalizedGeometryKind: normalizationResult.geometryKind,
                normalizationReason: normalizationResult.reason
            )
            return OCRTargetSelectionResult(
                normalizedImage: normalizedImage,
                normalizedContentRect: normalizationResult.normalizedContentRect,
                selectionConfidence: max(0.55, chosenCandidate.summary.totalScore),
                usedFallback: false,
                fallbackReason: fallbackReason,
                chosenCandidateIndex: chosenCandidate.summary.rank,
                candidates: candidates.map(\.summary),
                normalizedGeometryKind: normalizationResult.geometryKind,
                normalizationReason: normalizationResult.reason
            )
        }
    }

    let selectionFailureReason = if mode == .psaSlab, chosenCandidate != nil {
        "slab_candidate_not_portrait"
    } else {
        fallbackReason(for: candidates, mode: mode)
    }

    let chosenFallbackReason = selectionFailureReason
    let fallbackSelection: OCRFallbackNormalizationSelection
    if mode == .psaSlab {
        guard let slabFallbackSelection = selectSlabFallbackNormalization(
            searchImage: searchImage,
            fallbackImage: fallbackImage,
            chosenCandidate: chosenCandidate?.summary,
            scanID: scanID
        ) else {
            throw AnalysisError.unsupportedPSASlabTarget
        }
        fallbackSelection = slabFallbackSelection
    } else {
        fallbackSelection = OCRFallbackNormalizationSelection(
            result: normalizeFallbackOCRInputImage(
                searchImage: searchImage,
                fallbackImage: fallbackImage,
                mode: mode,
                scanID: scanID
            ),
            chosenCandidateIndex: nil
        )
    }
    let normalizationResult = fallbackSelection.result
    print(
        "  ⚠️ [TARGET] mode=\(mode.rawValue) fallback=\(chosenFallbackReason) " +
        "normalized=\(normalizationResult.geometryKind.rawValue) " +
        "reason=\(normalizationResult.reason ?? "none")"
    )
    ScanStageArtifactWriter.recordSelectionArtifacts(
        scanID: scanID,
        mode: mode,
        source: capture.captureSource,
        selectedTargetImage: normalizationResult.image,
        candidateOverlayImage: candidateOverlayImage,
        normalizedImage: normalizationResult.image,
        normalizedContentRect: normalizationResult.normalizedContentRect,
        chosenCandidateIndex: nil,
        candidates: candidates.map(\.summary),
        fallbackReason: chosenFallbackReason,
        normalizedGeometryKind: normalizationResult.geometryKind,
        normalizationReason: normalizationResult.reason
    )

    return OCRTargetSelectionResult(
        normalizedImage: normalizationResult.image,
        normalizedContentRect: normalizationResult.normalizedContentRect,
        selectionConfidence: fallbackSelectionConfidence(
            candidates: candidates,
            fallbackReason: chosenFallbackReason,
            normalizationReason: normalizationResult.reason
        ),
        usedFallback: true,
        fallbackReason: chosenFallbackReason,
        chosenCandidateIndex: fallbackSelection.chosenCandidateIndex,
        candidates: candidates.map(\.summary),
        normalizedGeometryKind: normalizationResult.geometryKind,
        normalizationReason: normalizationResult.reason
    )
}

func chooseBestSelectionCandidateRank(
    from candidates: [OCRTargetCandidateSummary],
    mode: OCRTargetMode
) -> Int? {
    guard let best = candidates.first else {
        return nil
    }

    let margin = best.totalScore - (candidates.dropFirst().first?.totalScore ?? 0)
    guard best.totalScore >= mode.minimumSelectionScore else {
        return nil
    }
    guard best.aspectScore >= 0.45 else {
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

private func detectRectangleCandidates(
    in cgImage: CGImage,
    mode: OCRTargetMode
) throws -> [OCRTargetSelectionCandidate] {
    let request = VNDetectRectanglesRequest()
    request.maximumObservations = 8
    request.minimumConfidence = 0.20
    request.minimumAspectRatio = 0.35
    request.maximumAspectRatio = 0.96
    request.quadratureTolerance = 30.0

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
    let aspectRatio = averageWidth / averageHeight
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

private func recoverRelaxedRectangleCandidate(in cgImage: CGImage) throws -> OCRRelaxedDetectionResult? {
    let expectedAspect = 63.0 / 88.0
    let searchImages: [(CGImage, String)] = [
        (cgImage, "original"),
        (enhancedRawSelectionImage(from: cgImage), "enhanced")
    ].compactMap { image, sourceLabel in
        guard let image else { return nil }
        return (image, sourceLabel)
    }

    for (candidateImage, sourceLabel) in searchImages {
        if let observation = try bestRawCardObservation(
            in: candidateImage,
            expectedWidthHeightAspect: expectedAspect,
            minimumAreaCoverage: 0.025,
            maxCenterDistance: 0.48,
            requestMinimumConfidence: 0.12,
            requestMinimumAspectRatio: 0.28,
            requestMaximumAspectRatio: 0.96,
            minimumAspectScore: 0.16
        ) {
            return OCRRelaxedDetectionResult(observation: observation, sourceLabel: sourceLabel)
        }
    }

    return nil
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
        if aspectRatio <= (mode.expectedAspectRatio - 0.06), aspectRatio >= 0.45 {
            return .rawHolder
        }
        return .rawCard
    case .psaSlab:
        return .slab
    }
}

private func degradedSelectionConfidence(
    base: Double?,
    cap: Double,
    floor: Double,
    penalty: Double
) -> Double {
    min(
        cap,
        max(floor, (base ?? floor) - penalty)
    )
}

private func fallbackSelectionConfidence(
    candidates: [OCRTargetSelectionCandidate],
    fallbackReason: String,
    normalizationReason: String?
) -> Double {
    var confidence = degradedSelectionConfidence(
        base: candidates.first?.summary.totalScore,
        cap: fallbackSelectionConfidenceCap,
        floor: fallbackSelectionConfidenceFloor,
        penalty: fallbackSelectionPenalty
    )
    if fallbackReason == "no_rectangle_detected" {
        confidence = min(confidence, 0.40)
    } else if fallbackReason == "multiple_rectangles_too_close_to_call" {
        confidence = min(confidence, 0.52)
    }
    if normalizationReason?.contains("small_card_detected") == true {
        confidence = min(confidence, 0.48)
    }
    return confidence
}

private struct ReticleCropContentSummary {
    let averageLuminance: CGFloat
    let nonDarkCoverage: CGFloat
    let contentCoverage: CGFloat
    let contentAspectRatio: CGFloat?
}

func reticleCropLooksLikeRawCard(_ image: UIImage) -> Bool {
    guard image.size.width > 0, image.size.height > 0 else {
        return false
    }

    let imageAspectRatio = image.size.width / image.size.height
    guard imageAspectRatio >= 0.60, imageAspectRatio <= 0.85 else {
        return false
    }

    guard let summary = reticleCropContentSummary(for: image) else {
        return false
    }

    guard summary.averageLuminance >= 0.08 else {
        return false
    }
    guard summary.nonDarkCoverage >= 0.50 else {
        return false
    }
    guard summary.contentCoverage >= 0.50 else {
        return false
    }
    guard let contentAspectRatio = summary.contentAspectRatio,
          contentAspectRatio >= 0.60,
          contentAspectRatio <= 0.85 else {
        return false
    }
    return true
}

private func reticleCropContentSummary(for image: UIImage) -> ReticleCropContentSummary? {
    guard let cgImage = image.cgImage else {
        return nil
    }

    let sampleSize = CGSize(width: 48, height: 48)
    let width = Int(sampleSize.width)
    let height = Int(sampleSize.height)
    let bytesPerRow = width * 4
    var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)

    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else {
        return nil
    }

    context.interpolationQuality = .medium
    context.draw(cgImage, in: CGRect(origin: .zero, size: sampleSize))

    var totalLuminance: CGFloat = 0
    var nonDarkPixels = 0
    var minX = width
    var minY = height
    var maxX = -1
    var maxY = -1

    for y in 0..<height {
        for x in 0..<width {
            let offset = y * bytesPerRow + x * 4
            let red = CGFloat(pixels[offset]) / 255
            let green = CGFloat(pixels[offset + 1]) / 255
            let blue = CGFloat(pixels[offset + 2]) / 255
            let alpha = CGFloat(pixels[offset + 3]) / 255
            let luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
            totalLuminance += luminance

            guard alpha >= 0.20, luminance >= 0.10 else {
                continue
            }

            nonDarkPixels += 1
            minX = min(minX, x)
            minY = min(minY, y)
            maxX = max(maxX, x)
            maxY = max(maxY, y)
        }
    }

    let totalPixels = max(1, width * height)
    let averageLuminance = totalLuminance / CGFloat(totalPixels)
    let nonDarkCoverage = CGFloat(nonDarkPixels) / CGFloat(totalPixels)

    let contentCoverage: CGFloat
    let contentAspectRatio: CGFloat?
    if maxX >= minX, maxY >= minY {
        let contentWidth = CGFloat(maxX - minX + 1)
        let contentHeight = CGFloat(maxY - minY + 1)
        contentCoverage = (contentWidth * contentHeight) / CGFloat(totalPixels)
        contentAspectRatio = contentWidth / max(contentHeight, 1)
    } else {
        contentCoverage = 0
        contentAspectRatio = nil
    }

    return ReticleCropContentSummary(
        averageLuminance: averageLuminance,
        nonDarkCoverage: nonDarkCoverage,
        contentCoverage: contentCoverage,
        contentAspectRatio: contentAspectRatio
    )
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

private func slabPerspectiveLooksValid(_ image: UIImage) -> Bool {
    guard image.size.width > 0, image.size.height > 0 else { return false }
    let heightWidthRatio = image.size.height / image.size.width
    return heightWidthRatio >= 1.25
}

private func selectSlabFallbackNormalization(
    searchImage: UIImage,
    fallbackImage: UIImage,
    chosenCandidate: OCRTargetCandidateSummary?,
    scanID: UUID?
) -> OCRFallbackNormalizationSelection? {
    if let chosenCandidate,
       let slabCrop = normalizeSlabBoundingBoxFallbackImage(
           searchImage: searchImage,
           chosenCandidate: chosenCandidate
       ) {
        return OCRFallbackNormalizationSelection(
            result: slabCrop,
            chosenCandidateIndex: chosenCandidate.rank
        )
    }

    if let labelCrop = normalizeDetectedSlabLabelFallbackImage(
        searchImage: searchImage,
        fallbackImage: fallbackImage,
        scanID: scanID
    ) {
        return OCRFallbackNormalizationSelection(
            result: labelCrop,
            chosenCandidateIndex: nil
        )
    }

    return nil
}

private func normalizeSlabBoundingBoxFallbackImage(
    searchImage: UIImage,
    chosenCandidate: OCRTargetCandidateSummary
) -> OCRTargetNormalizationResult? {
    let normalizedRect = expandedSlabBoundingBoxCropRect(for: chosenCandidate)
    guard let cropped = cropImage(searchImage, normalizedRect: normalizedRect) else {
        return nil
    }
    return OCRTargetNormalizationResult(
        image: cropped.normalizedOrientation(),
        geometryKind: .slab,
        reason: "slab_bounding_box_fallback",
        normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1)
    )
}

private func normalizeDetectedSlabLabelFallbackImage(
    searchImage: UIImage,
    fallbackImage: UIImage,
    scanID: UUID?
) -> OCRTargetNormalizationResult? {
    _ = scanID
    let candidateImages = [
        fallbackImage.normalizedOrientation(),
        searchImage.normalizedOrientation(),
    ]
    for candidateImage in candidateImages {
        guard let labelRect = detectSlabLabelFallbackRect(in: candidateImage),
              let cropped = cropImage(candidateImage, normalizedRect: CGRect(
                  x: labelRect.x,
                  y: labelRect.y,
                  width: labelRect.width,
                  height: labelRect.height
              )) else {
            continue
        }
        return OCRTargetNormalizationResult(
            image: cropped.normalizedOrientation(),
            geometryKind: .slabLabel,
            reason: "slab_label_region_fallback",
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1)
        )
    }
    return nil
}

func detectSlabLabelFallbackRect(in image: UIImage) -> OCRNormalizedRect? {
    let normalized = image.normalizedOrientation()
    guard let cgImage = normalized.cgImage else { return nil }

    return withRenderedRGBA(cgImage) { pixels, width, height, bytesPerRow in
        let labelSearchBottom = min(0.40, PSASlabGuidance.labelDividerRatio + 0.06)
        let x0 = max(0, Int((CGFloat(width) * 0.04).rounded(.down)))
        let x1 = max(x0 + 1, min(width, Int((CGFloat(width) * 0.96).rounded(.up))))
        let y1 = max(1, min(height, Int((CGFloat(height) * labelSearchBottom).rounded(.up))))
        let xStep = max(1, (x1 - x0) / 180)
        let yStep = max(1, y1 / 120)

        var minX = width
        var minY = height
        var maxX = 0
        var maxY = 0
        var redSamples = 0

        for y in stride(from: 0, to: y1, by: yStep) {
            for x in stride(from: x0, to: x1, by: xStep) {
                let offset = (y * bytesPerRow) + (x * 4)
                let red = CGFloat(pixels[offset]) / 255.0
                let green = CGFloat(pixels[offset + 1]) / 255.0
                let blue = CGFloat(pixels[offset + 2]) / 255.0
                let maxOther = max(green, blue)
                let minOther = min(green, blue)
                let isRedDominant = red >= 0.42 && red > (maxOther * 1.22) && (red - minOther) >= 0.14
                guard isRedDominant else { continue }
                minX = min(minX, x)
                minY = min(minY, y)
                maxX = max(maxX, x)
                maxY = max(maxY, y)
                redSamples += 1
            }
        }

        guard redSamples >= 16, maxX > minX, maxY > minY else {
            return nil
        }

        let rawRect = CGRect(
            x: CGFloat(minX) / CGFloat(width),
            y: CGFloat(minY) / CGFloat(height),
            width: CGFloat(maxX - minX) / CGFloat(width),
            height: CGFloat(maxY - minY) / CGFloat(height)
        )
        let expandedRect = clampNormalizedRect(
            CGRect(
                x: rawRect.minX - max(0.02, rawRect.width * 0.05),
                y: rawRect.minY - max(0.015, rawRect.height * 0.16),
                width: rawRect.width + max(0.04, rawRect.width * 0.10),
                height: rawRect.height + max(0.03, rawRect.height * 0.32)
            )
        )

        let aspectRatio = expandedRect.width / max(0.0001, expandedRect.height)
        guard expandedRect.width >= 0.34,
              expandedRect.height >= 0.06,
              expandedRect.height <= 0.24,
              expandedRect.minY <= 0.36,
              expandedRect.maxY <= min(0.42, PSASlabGuidance.labelDividerRatio + 0.10),
              aspectRatio >= 2.2,
              aspectRatio <= 6.8 else {
            return nil
        }

        let interiorRect = clampNormalizedRect(
            expandedRect.insetBy(
                dx: max(0.01, expandedRect.width * 0.06),
                dy: max(0.01, expandedRect.height * 0.18)
            )
        )
        let brightRatio = brightSampleRatio(
            pixels: pixels,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            rect: interiorRect
        )
        guard brightRatio >= 0.34 else {
            return nil
        }

        return OCRNormalizedRect(
            x: expandedRect.minX,
            y: expandedRect.minY,
            width: expandedRect.width,
            height: expandedRect.height
        )
    }
}

private func expandedSlabBoundingBoxCropRect(for candidate: OCRTargetCandidateSummary) -> CGRect {
    let visionRect = CGRect(
        x: candidate.boundingBox.x,
        y: candidate.boundingBox.y,
        width: candidate.boundingBox.width,
        height: candidate.boundingBox.height
    )
    let imageRect = CGRect(
        x: visionRect.minX,
        y: 1.0 - visionRect.maxY,
        width: visionRect.width,
        height: visionRect.height
    )
    return clampNormalizedRect(
        CGRect(
            x: imageRect.minX - max(0.02, imageRect.width * 0.04),
            y: imageRect.minY - max(0.02, imageRect.height * 0.04),
            width: imageRect.width + max(0.04, imageRect.width * 0.08),
            height: imageRect.height + max(0.04, imageRect.height * 0.08)
        )
    )
}

private func cropImage(_ image: UIImage, normalizedRect: CGRect) -> UIImage? {
    let normalized = image.normalizedOrientation()
    guard let cgImage = normalized.cgImage else { return nil }
    let cropRect = CGRect(
        x: normalizedRect.minX * CGFloat(cgImage.width),
        y: normalizedRect.minY * CGFloat(cgImage.height),
        width: normalizedRect.width * CGFloat(cgImage.width),
        height: normalizedRect.height * CGFloat(cgImage.height)
    ).integral
    guard cropRect.width > 0,
          cropRect.height > 0,
          let cropped = cgImage.cropping(to: cropRect) else {
        return nil
    }
    return UIImage(cgImage: cropped)
}

private func clampNormalizedRect(_ rect: CGRect) -> CGRect {
    let minX = max(0, min(1, rect.minX))
    let minY = max(0, min(1, rect.minY))
    let maxX = max(minX, min(1, rect.maxX))
    let maxY = max(minY, min(1, rect.maxY))
    return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
}

private func brightSampleRatio(
    pixels: UnsafeBufferPointer<UInt8>,
    width: Int,
    height: Int,
    bytesPerRow: Int,
    rect: CGRect
) -> CGFloat {
    let x0 = max(0, min(width - 1, Int((rect.minX * CGFloat(width)).rounded(.down))))
    let x1 = max(x0 + 1, min(width, Int((rect.maxX * CGFloat(width)).rounded(.up))))
    let y0 = max(0, min(height - 1, Int((rect.minY * CGFloat(height)).rounded(.down))))
    let y1 = max(y0 + 1, min(height, Int((rect.maxY * CGFloat(height)).rounded(.up))))
    let xStep = max(1, (x1 - x0) / 80)
    let yStep = max(1, (y1 - y0) / 40)

    var totalSamples = 0
    var brightSamples = 0
    for y in stride(from: y0, to: y1, by: yStep) {
        for x in stride(from: x0, to: x1, by: xStep) {
            let offset = (y * bytesPerRow) + (x * 4)
            let red = CGFloat(pixels[offset]) / 255.0
            let green = CGFloat(pixels[offset + 1]) / 255.0
            let blue = CGFloat(pixels[offset + 2]) / 255.0
            let luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
            if luminance >= 0.62 {
                brightSamples += 1
            }
            totalSamples += 1
        }
    }

    guard totalSamples > 0 else { return 0 }
    return CGFloat(brightSamples) / CGFloat(totalSamples)
}

private func withRenderedRGBA<T>(
    _ cgImage: CGImage,
    _ body: (_ pixels: UnsafeBufferPointer<UInt8>, _ width: Int, _ height: Int, _ bytesPerRow: Int) -> T?
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
