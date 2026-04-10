import Foundation
import UIKit

enum OCRPipelineRequestedRoute: String, Codable, Hashable, Sendable {
    case legacyOnly = "legacy_only"
    case rewritePreferred = "rewrite_preferred"
    case dualRunDebug = "dual_run_debug"
}

struct OCRPipelineFeatureFlags: Codable, Hashable, Sendable {
    let useNewOCRPipeline: Bool
    let runBothOCRPipelinesForDebug: Bool

    var requestedRoute: OCRPipelineRequestedRoute {
        if runBothOCRPipelinesForDebug {
            return .dualRunDebug
        }
        if useNewOCRPipeline {
            return .rewritePreferred
        }
        return .legacyOnly
    }

    static func current(
        bundle: Bundle = .main,
        processInfo: ProcessInfo = .processInfo
    ) -> OCRPipelineFeatureFlags {
        let useNewOCRPipeline =
            boolOverride(
                envKey: "SPOTLIGHT_USE_NEW_OCR_PIPELINE",
                bundleKey: "SpotlightUseNewOCRPipeline",
                bundle: bundle,
                processInfo: processInfo
            ) ?? false
        let runBothOCRPipelinesForDebug =
            boolOverride(
                envKey: "SPOTLIGHT_RUN_BOTH_OCR_PIPELINES_FOR_DEBUG",
                bundleKey: "SpotlightRunBothOCRPipelinesForDebug",
                bundle: bundle,
                processInfo: processInfo
            ) ?? false

        return OCRPipelineFeatureFlags(
            useNewOCRPipeline: useNewOCRPipeline,
            runBothOCRPipelinesForDebug: runBothOCRPipelinesForDebug
        )
    }

    private static func boolOverride(
        envKey: String,
        bundleKey: String,
        bundle: Bundle,
        processInfo: ProcessInfo
    ) -> Bool? {
        if let envValue = processInfo.environment[envKey] {
            return parseBool(envValue)
        }

        if let value = bundle.object(forInfoDictionaryKey: bundleKey) {
            if let boolValue = value as? Bool {
                return boolValue
            }
            if let numberValue = value as? NSNumber {
                return numberValue.boolValue
            }
            if let stringValue = value as? String {
                return parseBool(stringValue)
            }
        }

        return nil
    }

    private static func parseBool(_ value: String) -> Bool? {
        switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "1", "true", "yes", "on":
            return true
        case "0", "false", "no", "off":
            return false
        default:
            return nil
        }
    }
}

actor OCRPipelineCoordinator {
    private let rawAnalyzer: RawCardScanner
    private let rawRewritePipeline: RawPipeline
    private let slabAnalyzer: SlabScanner
    private let featureFlags: OCRPipelineFeatureFlags

    init(
        rawAnalyzer: RawCardScanner,
        rawRewritePipeline: RawPipeline,
        slabAnalyzer: SlabScanner,
        featureFlags: OCRPipelineFeatureFlags = .current()
    ) {
        self.rawAnalyzer = rawAnalyzer
        self.rawRewritePipeline = rawRewritePipeline
        self.slabAnalyzer = slabAnalyzer
        self.featureFlags = featureFlags
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
            switch featureFlags.requestedRoute {
            case .legacyOnly:
                return try await rawAnalyzer.analyze(
                    scanID: scanID,
                    capture: capture,
                    resolverModeHint: resolverModeHint
                )
            case .rewritePreferred:
                return try await rawRewritePipeline.analyze(
                    scanID: scanID,
                    capture: capture,
                    resolverModeHint: resolverModeHint
                )
            case .dualRunDebug:
                let legacyResult = try await rawAnalyzer.analyze(
                    scanID: scanID,
                    capture: capture,
                    resolverModeHint: resolverModeHint
                )
                let rewriteScanID = UUID()
                let rewriteResult = try await rawRewritePipeline.analyze(
                    scanID: rewriteScanID,
                    capture: capture,
                    resolverModeHint: resolverModeHint
                )
                ScanStageArtifactWriter.recordFinalDecisionArtifact(
                    scanID: scanID,
                    stage: "raw_pipeline_dual_run_debug",
                    payload: OCRPipelineDualRunArtifact(
                        requestedRoute: featureFlags.requestedRoute,
                        legacyScanID: scanID.uuidString,
                        rewriteScanID: rewriteScanID.uuidString,
                        legacy: OCRPipelineDualRunResult(
                            pipelineVersion: legacyResult.ocrAnalysis?.pipelineVersion.rawValue,
                            titleTextPrimary: legacyResult.ocrAnalysis?.rawEvidence?.titleTextPrimary,
                            collectorNumber: legacyResult.collectorNumber,
                            setHintTokens: legacyResult.setHintTokens,
                            cropConfidence: legacyResult.cropConfidence,
                            warnings: legacyResult.warnings
                        ),
                        rewrite: OCRPipelineDualRunResult(
                            pipelineVersion: rewriteResult.ocrAnalysis?.pipelineVersion.rawValue,
                            titleTextPrimary: rewriteResult.ocrAnalysis?.rawEvidence?.titleTextPrimary,
                            collectorNumber: rewriteResult.collectorNumber,
                            setHintTokens: rewriteResult.setHintTokens,
                            cropConfidence: rewriteResult.cropConfidence,
                            warnings: rewriteResult.warnings
                        )
                    )
                )
                return legacyResult
            }
        }
    }
}

private struct OCRPipelineDualRunResult: Codable, Hashable, Sendable {
    let pipelineVersion: String?
    let titleTextPrimary: String?
    let collectorNumber: String?
    let setHintTokens: [String]
    let cropConfidence: Double
    let warnings: [String]
}

private struct OCRPipelineDualRunArtifact: Codable, Hashable, Sendable {
    let requestedRoute: OCRPipelineRequestedRoute
    let legacyScanID: String
    let rewriteScanID: String
    let legacy: OCRPipelineDualRunResult
    let rewrite: OCRPipelineDualRunResult
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
    let referenceGeometry = targetSelection.usedFallback
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
    case .slab:
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
            looksLikeSlabScore + (selectedCandidate.geometryKind == .slab ? 0.06 : -0.04)
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

func buildLegacyRawOCRAnalysisEnvelope(
    targetSelection: OCRTargetSelectionResult,
    primaryTitleText: String,
    secondaryTitleText: String?,
    titleConfidence: Double,
    footerBandText: String,
    wholeCardText: String,
    collectorNumber: String?,
    collectorWasFooterConfirmed: Bool,
    setHintTokens: [String],
    warnings: [String]
) -> OCRAnalysisEnvelope {
    let normalizedTarget = buildLegacyNormalizedTarget(from: targetSelection)
    let modeSanitySignals = buildLegacyModeSanitySignals(
        selectedMode: .raw,
        targetSelection: targetSelection
    )
    let titleConfidenceValue = trimmedNonEmpty(primaryTitleText).map { _ in
        OCRFieldConfidence(
            score: clamp01(titleConfidence),
            agreementScore: secondaryTitleText == nil ? nil : clamp01(titleConfidence * 0.82),
            tokenConfidenceAverage: clamp01(titleConfidence),
            reasons: secondaryTitleText == nil
                ? ["legacy_raw_primary_title_region"]
                : ["legacy_raw_primary_title_region", "legacy_raw_secondary_title_region"]
        )
    }
    let collectorConfidence = collectorNumber.map { _ in
        OCRFieldConfidence(
            score: collectorWasFooterConfirmed ? 0.92 : 0.68,
            agreementScore: collectorWasFooterConfirmed ? 0.88 : nil,
            tokenConfidenceAverage: nil,
            reasons: collectorWasFooterConfirmed
                ? ["legacy_raw_footer_confirmation"]
                : ["legacy_raw_footer_band"]
        )
    }
    let setConfidence = setHintTokens.isEmpty ? nil : OCRFieldConfidence(
        score: 0.56,
        agreementScore: nil,
        tokenConfidenceAverage: nil,
        reasons: ["legacy_raw_footer_set_hints"]
    )

    let rawEvidence = OCRRawEvidence(
        titleTextPrimary: trimmedNonEmpty(primaryTitleText),
        titleTextSecondary: trimmedNonEmpty(secondaryTitleText),
        titleConfidence: titleConfidenceValue,
        collectorNumberExact: collectorNumber,
        collectorNumberPartial: nil,
        collectorConfidence: collectorConfidence,
        setHints: setHintTokens,
        setConfidence: setConfidence,
        footerBandText: footerBandText,
        wholeCardText: wholeCardText,
        warnings: warnings
    )

    return OCRAnalysisEnvelope(
        pipelineVersion: .legacyV1,
        selectedMode: .raw,
        normalizedTarget: normalizedTarget,
        modeSanitySignals: modeSanitySignals,
        rawEvidence: rawEvidence,
        slabEvidence: nil
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
