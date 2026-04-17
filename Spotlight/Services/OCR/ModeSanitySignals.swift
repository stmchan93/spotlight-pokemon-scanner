import Foundation
import UIKit

actor OCRPipelineCoordinator {
    private let rawRewritePipeline: RawPipeline
    private let slabAnalyzer: SlabScanner

    init(
        rawRewritePipeline: RawPipeline,
        slabAnalyzer: SlabScanner
    ) {
        self.rawRewritePipeline = rawRewritePipeline
        self.slabAnalyzer = slabAnalyzer
    }

    func analyze(
        scanID: UUID,
        capture: ScanCaptureInput,
        resolverModeHint: ResolverMode
    ) async throws -> AnalyzedCapture {
        switch resolverModeHint {
        case .psaSlab:
            return try await slabAnalyzer.analyze(
                scanID: scanID,
                capture: capture,
                resolverModeHint: resolverModeHint
            )
        case .rawCard, .unknownFallback:
            return try await rawRewritePipeline.analyze(
                scanID: scanID,
                capture: capture,
                resolverModeHint: resolverModeHint
            )
        }
    }

    func prepareRawTargetSelection(
        scanID: UUID,
        capture: ScanCaptureInput
    ) async throws -> OCRTargetSelectionResult {
        try await rawRewritePipeline.prepareTargetSelection(
            scanID: scanID,
            capture: capture
        )
    }

    func analyzePreparedRawScan(
        scanID: UUID,
        capture: ScanCaptureInput,
        targetSelection: OCRTargetSelectionResult,
        resolverModeHint: ResolverMode,
        targetSelectionMs: Double
    ) async throws -> AnalyzedCapture {
        try await rawRewritePipeline.analyzePrepared(
            scanID: scanID,
            capture: capture,
            targetSelection: targetSelection,
            resolverModeHint: resolverModeHint,
            targetSelectionMs: targetSelectionMs
        )
    }
}

func buildLegacyNormalizedTarget(
    from targetSelection: OCRTargetSelectionResult
) -> OCRNormalizedTarget {
    let selectedCandidate = targetSelection.chosenCandidateIndex.flatMap { chosenRank in
        targetSelection.candidates.first(where: { $0.rank == chosenRank })
    }
    let quality = buildLegacyTargetQuality(
        selectedCandidate: selectedCandidate,
        targetSelection: targetSelection
    )

    return OCRNormalizedTarget(
        selectedRectNormalized: selectedCandidate.map { candidate in
            OCRNormalizedRect(
                x: candidate.boundingBox.x,
                y: candidate.boundingBox.y,
                width: candidate.boundingBox.width,
                height: candidate.boundingBox.height
            )
        },
        contentRectNormalized: targetSelection.normalizedContentRect,
        normalizedWidth: Int(targetSelection.normalizedImage.size.width.rounded()),
        normalizedHeight: Int(targetSelection.normalizedImage.size.height.rounded()),
        usedFallback: targetSelection.usedFallback,
        geometryKind: targetSelection.normalizedGeometryKind.rawValue,
        targetQuality: quality
    )
}

func buildLegacyModeSanitySignals(
    selectedMode: OCRSelectedMode,
    targetSelection: OCRTargetSelectionResult
) -> OCRModeSanitySignals {
    let selectedCandidate = targetSelection.chosenCandidateIndex.flatMap { chosenRank in
        targetSelection.candidates.first(where: { $0.rank == chosenRank })
    }
    let referenceGeometry = targetSelection.normalizedGeometryKind == .fallback
        ? selectedCandidate?.geometryKind ?? .fallback
        : targetSelection.normalizedGeometryKind

    var looksLikeRawScore: Double
    var looksLikeSlabScore: Double

    switch referenceGeometry {
    case .rawCard:
        looksLikeRawScore = 0.88
        looksLikeSlabScore = 0.18
    case .rawHolder:
        looksLikeRawScore = 0.78
        looksLikeSlabScore = 0.24
    case .slab, .slabLabel:
        looksLikeRawScore = 0.18
        looksLikeSlabScore = 0.88
    case .fallback:
        looksLikeRawScore = selectedMode == .raw ? 0.56 : 0.36
        looksLikeSlabScore = selectedMode == .slab ? 0.56 : 0.36
    }

    if let selectedCandidate {
        looksLikeRawScore = clamp01(
            looksLikeRawScore + (selectedCandidate.geometryKind == .rawCard || selectedCandidate.geometryKind == .rawHolder ? 0.06 : -0.04)
        )
        looksLikeSlabScore = clamp01(
            looksLikeSlabScore + ((selectedCandidate.geometryKind == .slab || selectedCandidate.geometryKind == .slabLabel) ? 0.06 : -0.04)
        )
    }
    if targetSelection.usedFallback {
        looksLikeRawScore = clamp01(looksLikeRawScore - 0.08)
        looksLikeSlabScore = clamp01(looksLikeSlabScore - 0.08)
    }

    var warnings: [String] = []
    if targetSelection.usedFallback {
        warnings.append("Target selection used fallback crop")
    }
    if targetSelection.selectionConfidence < 0.58 {
        warnings.append("Target selection confidence is weak")
    }
    switch selectedMode {
    case .raw:
        if looksLikeSlabScore > looksLikeRawScore + 0.18 {
            warnings.append("Selected raw mode but target looks slab-like")
        }
    case .slab:
        if looksLikeRawScore > looksLikeSlabScore + 0.18 {
            warnings.append("Selected slab mode but target looks raw-card-like")
        }
    }

    return OCRModeSanitySignals(
        selectedMode: selectedMode,
        looksLikeRawScore: looksLikeRawScore,
        looksLikeSlabScore: looksLikeSlabScore,
        warnings: warnings
    )
}

func buildLegacySlabOCRAnalysisEnvelope(
    targetSelection: OCRTargetSelectionResult,
    topLabelText: String,
    combinedText: String,
    slabLabelAnalysis: SlabLabelAnalysis,
    warnings: [String]
) -> OCRAnalysisEnvelope {
    let normalizedTarget = buildLegacyNormalizedTarget(from: targetSelection)
    let modeSanitySignals = buildLegacyModeSanitySignals(
        selectedMode: .slab,
        targetSelection: targetSelection
    )

    let slabEvidence = OCRSlabEvidence(
        titleTextPrimary: trimmedNonEmpty(topLabelText),
        titleTextSecondary: nil,
        titleConfidence: trimmedNonEmpty(topLabelText).map { _ in
            OCRFieldConfidence(
                score: 0.58,
                agreementScore: nil,
                tokenConfidenceAverage: nil,
                reasons: ["legacy_slab_label_wide_text"]
            )
        },
        cardNumber: slabLabelAnalysis.cardNumberRaw,
        cardNumberConfidence: slabLabelAnalysis.cardNumberRaw.map { _ in
            OCRFieldConfidence(
                score: 0.72,
                agreementScore: nil,
                tokenConfidenceAverage: nil,
                reasons: ["legacy_slab_label_card_number"]
            )
        },
        setText: nil,
        setBadgeHint: nil,
        setHints: [],
        setConfidence: nil,
        grader: slabLabelAnalysis.grader,
        graderConfidence: slabLabelAnalysis.grader.map { _ in
            OCRFieldConfidence(
                score: Double(slabLabelAnalysis.graderConfidence),
                agreementScore: nil,
                tokenConfidenceAverage: nil,
                reasons: ["legacy_slab_label_parser"]
            )
        },
        grade: slabLabelAnalysis.grade,
        gradeConfidence: slabLabelAnalysis.grade.map { _ in
            OCRFieldConfidence(
                score: Double(slabLabelAnalysis.gradeConfidence),
                agreementScore: nil,
                tokenConfidenceAverage: nil,
                reasons: ["legacy_slab_label_parser"]
            )
        },
        cert: slabLabelAnalysis.certNumber,
        certConfidence: slabLabelAnalysis.certNumber.map { _ in
            OCRFieldConfidence(
                score: Double(slabLabelAnalysis.certConfidence),
                agreementScore: nil,
                tokenConfidenceAverage: nil,
                reasons: ["legacy_slab_label_parser"]
            )
        },
        labelWideText: combinedText,
        warnings: warnings
    )

    return OCRAnalysisEnvelope(
        pipelineVersion: .legacyV1,
        selectedMode: .slab,
        normalizedTarget: normalizedTarget,
        modeSanitySignals: modeSanitySignals,
        rawEvidence: nil,
        slabEvidence: slabEvidence
    )
}

extension ResolverMode {
    var ocrSelectedMode: OCRSelectedMode {
        switch self {
        case .psaSlab:
            return .slab
        case .rawCard, .unknownFallback:
            return .raw
        }
    }
}

private func buildLegacyTargetQuality(
    selectedCandidate: OCRTargetCandidateSummary?,
    targetSelection: OCRTargetSelectionResult
) -> OCRTargetQuality {
    var reasons = [targetSelection.normalizedGeometryKind.rawValue]
    if let fallbackReason = targetSelection.fallbackReason {
        reasons.append("fallback:\(fallbackReason)")
    }
    if let normalizationReason = targetSelection.normalizationReason {
        reasons.append("normalization:\(normalizationReason)")
    }

    return OCRTargetQuality(
        overallScore: clamp01(targetSelection.selectionConfidence),
        centeringScore: selectedCandidate?.proximityScore,
        aspectScore: selectedCandidate?.aspectScore,
        areaCoverageScore: selectedCandidate?.areaScore,
        glarePenalty: nil,
        holderPenalty: selectedCandidate?.geometryKind == .rawHolder ? 0.12 : nil,
        reasons: reasons
    )
}

private func trimmedNonEmpty(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func clamp01(_ value: Double) -> Double {
    min(max(value, 0), 1)
}
