import UIKit
import Vision

enum OCRTargetMode: String, Codable {
    case rawCard = "raw"
    case psaSlab = "psa"

    var expectedAspectRatio: CGFloat {
        switch self {
        case .rawCard:
            // Use width/height aspect so scoring matches the downstream
            // fallback-recovery logic in PerspectiveNormalization.
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

struct OCRTargetSelectionResult {
    let normalizedImage: UIImage
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
    }

    let chosenFallbackReason = if mode == .psaSlab, chosenCandidate != nil {
        "slab_candidate_not_portrait"
    } else {
        fallbackReason(for: candidates, mode: mode)
    }
    let normalizationResult = normalizeFallbackOCRInputImage(fallbackImage, mode: mode)
    print(
        "  ⚠️ [TARGET] mode=\(mode.rawValue) fallback=\(chosenFallbackReason) " +
        "normalized=\(normalizationResult.geometryKind.rawValue) " +
        "reason=\(normalizationResult.reason ?? "none")"
    )
    ScanStageArtifactWriter.recordSelectionArtifacts(
        scanID: scanID,
        mode: mode,
        source: capture.captureSource,
        searchImage: searchImage,
        candidateOverlayImage: candidateOverlayImage,
        normalizedImage: normalizationResult.image,
        chosenCandidateIndex: nil,
        candidates: candidates.map(\.summary),
        fallbackReason: chosenFallbackReason,
        normalizedGeometryKind: normalizationResult.geometryKind,
        normalizationReason: normalizationResult.reason
    )

    return OCRTargetSelectionResult(
        normalizedImage: normalizationResult.image,
        selectionConfidence: candidates.first?.summary.totalScore ?? 0.40,
        usedFallback: true,
        fallbackReason: chosenFallbackReason,
        chosenCandidateIndex: nil,
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
