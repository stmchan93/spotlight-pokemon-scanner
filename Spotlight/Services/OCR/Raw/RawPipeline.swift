import Foundation
import UIKit

struct RawOCRPassTimingArtifact: Codable {
    let label: String
    let kind: String
    let durationMs: Double
    let recognitionRequestCount: Int
    let usedAggressiveRetry: Bool
    let tokenCount: Int
}

struct RawPipelineTimingArtifact: Codable {
    let targetSelectionMs: Double
    let stage1BroadMs: Double
    let stage1TightMs: Double
    let stage2Ms: Double
    let synthesisMs: Double
    let totalMs: Double
    let fastRejectReason: String?
    let passTimings: [RawOCRPassTimingArtifact]
}

struct RawPipelineDebugSnapshot {
    let analyzedCapture: AnalyzedCapture
    let targetSelection: OCRTargetSelectionResult
    let sceneTraits: RawSceneTraits
    let footerRouting: RawFooterRoutingContext
    let stage1BroadPlans: [RawROIPlanItem]
    let stage1TightPlans: [RawROIPlanItem]
    let stage2Plans: [RawROIPlanItem]
    let stage1BroadPassResults: [RawOCRPassResult]
    let stage1TightPassResults: [RawOCRPassResult]
    let stage2PassResults: [RawOCRPassResult]
    let stage1Assessment: RawStageAssessment
    let timings: RawPipelineTimingArtifact

    var allPlans: [RawROIPlanItem] {
        stage1BroadPlans + stage1TightPlans + stage2Plans
    }

    var allPassResults: [RawOCRPassResult] {
        stage1BroadPassResults + stage1TightPassResults + stage2PassResults
    }
}

actor RawPipeline {
    private let roiPlanner = RawROIPlanner()
    private let passRunner = RawOCRPassRunner()
    private let synthesizer = RawEvidenceSynthesizer()
    private let confidenceModel = RawConfidenceModel(tuning: OCRTuning.current.raw)

    func analyze(
        scanID: UUID,
        capture: ScanCaptureInput,
        resolverModeHint: ResolverMode = .rawCard
    ) async throws -> AnalyzedCapture {
        let snapshot = try await analyzeDebug(
            scanID: scanID,
            capture: capture,
            resolverModeHint: resolverModeHint
        )
        RawPipeline.logTimingBreakdown(scanID: scanID, timings: snapshot.timings)
        return snapshot.analyzedCapture
    }

    func analyzeDebug(
        scanID: UUID,
        capture: ScanCaptureInput,
        resolverModeHint: ResolverMode = .rawCard
    ) async throws -> RawPipelineDebugSnapshot {
        let pipelineStartedAt = Date().timeIntervalSinceReferenceDate

        let targetSelectionStartedAt = Date().timeIntervalSinceReferenceDate
        let targetSelection = try selectOCRInput(
            scanID: scanID,
            capture: capture,
            mode: .rawCard
        )
        let targetSelectionMs = (Date().timeIntervalSinceReferenceDate - targetSelectionStartedAt) * 1000
        let normalizedOriginal = capture.originalImage.normalizedOrientation()

        guard let workingCGImage = targetSelection.normalizedImage.cgImage else {
            throw AnalysisError.invalidImage
        }

        let sceneTraits = RawSceneTraits.derive(from: targetSelection)
        if shouldFastRejectWeakRawTargetSelection(targetSelection) {
            let synthesisStartedAt = Date().timeIntervalSinceReferenceDate
            let synthesized = synthesizer.synthesizeFastReject(
                scanID: scanID,
                targetSelection: targetSelection,
                sceneTraits: sceneTraits,
                reason: "target_selection_small_card_fast_reject"
            )
            let synthesisMs = (Date().timeIntervalSinceReferenceDate - synthesisStartedAt) * 1000
            let timings = RawPipelineTimingArtifact(
                targetSelectionMs: targetSelectionMs,
                stage1BroadMs: 0,
                stage1TightMs: 0,
                stage2Ms: 0,
                synthesisMs: synthesisMs,
                totalMs: (Date().timeIntervalSinceReferenceDate - pipelineStartedAt) * 1000,
                fastRejectReason: "target_selection_small_card_fast_reject",
                passTimings: []
            )
            let analyzedCapture = AnalyzedCapture(
                scanID: scanID,
                originalImage: normalizedOriginal,
                normalizedImage: targetSelection.normalizedImage,
                recognizedTokens: synthesized.recognizedTokens,
                collectorNumber: synthesized.collectorNumber,
                setHintTokens: synthesized.setHintTokens,
                setBadgeHint: synthesized.setBadgeHint,
                promoCodeHint: synthesized.promoCodeHint,
                slabGrader: nil,
                slabGrade: nil,
                slabCertNumber: nil,
                slabBarcodePayloads: [],
                slabGraderConfidence: nil,
                slabGradeConfidence: nil,
                slabCertConfidence: nil,
                slabCardNumberRaw: nil,
                slabParsedLabelText: [],
                slabClassifierReasons: [],
                slabRecommendedLookupPath: nil,
                resolverModeHint: resolverModeHint,
                cropConfidence: targetSelection.selectionConfidence,
                warnings: synthesized.warnings,
                shouldRetryWithStillPhoto: synthesized.shouldRetryWithStillPhoto,
                stillPhotoRetryReason: synthesized.stillPhotoRetryReason,
                ocrAnalysis: synthesized.ocrAnalysis
            )

            ScanStageArtifactWriter.recordSynthesizedEvidenceArtifact(
                scanID: scanID,
                stage: "rewrite_raw_timing_breakdown",
                payload: timings
            )

            return RawPipelineDebugSnapshot(
                analyzedCapture: analyzedCapture,
                targetSelection: targetSelection,
                sceneTraits: sceneTraits,
                footerRouting: .none,
                stage1BroadPlans: [],
                stage1TightPlans: [],
                stage2Plans: [],
                stage1BroadPassResults: [],
                stage1TightPassResults: [],
                stage2PassResults: [],
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: nil,
                    setHintTokens: [],
                    shouldEscalate: false,
                    reasons: ["target_selection_small_card_fast_reject"]
                ),
                timings: timings
            )
        }
        let stage1BroadPlans = roiPlanner.stage1BroadPlan(for: sceneTraits)
        let stage1BroadStartedAt = Date().timeIntervalSinceReferenceDate
        let stage1BroadPassResults = try await passRunner.run(
            scanID: scanID,
            in: workingCGImage,
            plans: stage1BroadPlans
        )
        let stage1BroadMs = (Date().timeIntervalSinceReferenceDate - stage1BroadStartedAt) * 1000
        let footerRouting = confidenceModel.deriveFooterRoutingContext(from: stage1BroadPassResults)
        let shouldSkipTightFooterPasses = confidenceModel.shouldSkipTightFooterPasses(after: stage1BroadPassResults)
        let stage1TightPlans = shouldSkipTightFooterPasses
            ? []
            : roiPlanner.stage1TightPlan(
                for: sceneTraits,
                routing: footerRouting
            )
        let stage1TightStartedAt = Date().timeIntervalSinceReferenceDate
        let stage1TightPassResults = stage1TightPlans.isEmpty
            ? []
            : try await passRunner.run(
                scanID: scanID,
                in: workingCGImage,
                plans: stage1TightPlans
            )
        let stage1TightMs = stage1TightPlans.isEmpty ? 0 : (Date().timeIntervalSinceReferenceDate - stage1TightStartedAt) * 1000
        let stage1PassResults = stage1BroadPassResults + stage1TightPassResults
        let stage1Assessment = confidenceModel.assessStage1(
            passResults: stage1PassResults,
            sceneTraits: sceneTraits
        )
        let stage2CandidatePlans = stage1Assessment.shouldEscalate
            ? roiPlanner.stage2Plan(for: sceneTraits)
            : []
        let stage2StartedAt = Date().timeIntervalSinceReferenceDate
        var stage2Plans: [RawROIPlanItem] = []
        var stage2PassResults: [RawOCRPassResult] = []
        if !stage2CandidatePlans.isEmpty {
            if sceneTraits.isExactReticleFallback,
               let loweredIndex = stage2CandidatePlans.firstIndex(where: { $0.label == "12_raw_header_wide_lowered" }) {
                let loweredPlan = stage2CandidatePlans[loweredIndex]
                let loweredPassBatch = try await passRunner.run(
                    scanID: scanID,
                    in: workingCGImage,
                    plans: [loweredPlan]
                )
                stage2Plans.append(loweredPlan)
                stage2PassResults.append(contentsOf: loweredPassBatch)

                if !confidenceModel.shouldSkipWideHeaderPassAfterLowered(
                    passResults: loweredPassBatch,
                    sceneTraits: sceneTraits,
                    stage1Assessment: stage1Assessment
                ) {
                    let remainingPlans = stage2CandidatePlans.enumerated()
                        .filter { $0.offset != loweredIndex }
                        .map(\.element)
                    if !remainingPlans.isEmpty {
                        let remainingPassBatch = try await passRunner.run(
                            scanID: scanID,
                            in: workingCGImage,
                            plans: remainingPlans
                        )
                        stage2Plans.append(contentsOf: remainingPlans)
                        stage2PassResults.append(contentsOf: remainingPassBatch)
                    }
                }
            } else {
                stage2Plans = stage2CandidatePlans
                stage2PassResults = try await passRunner.run(
                    scanID: scanID,
                    in: workingCGImage,
                    plans: stage2Plans
                )
            }
        }
        let stage2Ms = stage2Plans.isEmpty ? 0 : (Date().timeIntervalSinceReferenceDate - stage2StartedAt) * 1000
        let allPassResults = stage1PassResults + stage2PassResults
        let synthesisStartedAt = Date().timeIntervalSinceReferenceDate
        let synthesized = synthesizer.synthesize(
            scanID: scanID,
            captureSource: capture.captureSource,
            targetSelection: targetSelection,
            sceneTraits: sceneTraits,
            stage1Assessment: stage1Assessment,
            routing: footerRouting,
            plans: stage1BroadPlans + stage1TightPlans + stage2Plans,
            passResults: allPassResults,
            didEscalate: !stage2Plans.isEmpty
        )
        let synthesisMs = (Date().timeIntervalSinceReferenceDate - synthesisStartedAt) * 1000
        let timings = RawPipelineTimingArtifact(
            targetSelectionMs: targetSelectionMs,
            stage1BroadMs: stage1BroadMs,
            stage1TightMs: stage1TightMs,
            stage2Ms: stage2Ms,
            synthesisMs: synthesisMs,
            totalMs: (Date().timeIntervalSinceReferenceDate - pipelineStartedAt) * 1000,
            fastRejectReason: nil,
            passTimings: allPassResults.map { result in
                RawOCRPassTimingArtifact(
                    label: result.label,
                    kind: result.kind.rawValue,
                    durationMs: result.durationMs,
                    recognitionRequestCount: result.recognitionRequestCount,
                    usedAggressiveRetry: result.usedAggressiveRetry,
                    tokenCount: result.tokens.count
                )
            }
        )

        let analyzedCapture = AnalyzedCapture(
            scanID: scanID,
            originalImage: normalizedOriginal,
            normalizedImage: targetSelection.normalizedImage,
            recognizedTokens: synthesized.recognizedTokens,
            collectorNumber: synthesized.collectorNumber,
            setHintTokens: synthesized.setHintTokens,
            setBadgeHint: synthesized.setBadgeHint,
            promoCodeHint: synthesized.promoCodeHint,
            slabGrader: nil,
            slabGrade: nil,
            slabCertNumber: nil,
            slabBarcodePayloads: [],
            slabGraderConfidence: nil,
            slabGradeConfidence: nil,
            slabCertConfidence: nil,
            slabCardNumberRaw: nil,
            slabParsedLabelText: [],
            slabClassifierReasons: [],
            slabRecommendedLookupPath: nil,
            resolverModeHint: resolverModeHint,
            cropConfidence: targetSelection.selectionConfidence,
            warnings: synthesized.warnings,
            shouldRetryWithStillPhoto: synthesized.shouldRetryWithStillPhoto,
            stillPhotoRetryReason: synthesized.stillPhotoRetryReason,
            ocrAnalysis: synthesized.ocrAnalysis
        )

        ScanStageArtifactWriter.recordSynthesizedEvidenceArtifact(
            scanID: scanID,
            stage: "rewrite_raw_timing_breakdown",
            payload: timings
        )

        return RawPipelineDebugSnapshot(
            analyzedCapture: analyzedCapture,
            targetSelection: targetSelection,
            sceneTraits: sceneTraits,
            footerRouting: footerRouting,
            stage1BroadPlans: stage1BroadPlans,
            stage1TightPlans: stage1TightPlans,
            stage2Plans: stage2Plans,
            stage1BroadPassResults: stage1BroadPassResults,
            stage1TightPassResults: stage1TightPassResults,
            stage2PassResults: stage2PassResults,
            stage1Assessment: stage1Assessment,
            timings: timings
        )
    }
}

extension RawPipeline {
    nonisolated static func logTimingBreakdown(
        scanID: UUID,
        timings: RawPipelineTimingArtifact
    ) {
        print(
            "⏱️ [OCR PERF] "
            + "scanID=\(scanID.uuidString) "
            + "targetSelectionMs=\(Int(timings.targetSelectionMs.rounded())) "
            + "stage1BroadMs=\(Int(timings.stage1BroadMs.rounded())) "
            + "stage1TightMs=\(Int(timings.stage1TightMs.rounded())) "
            + "stage2Ms=\(Int(timings.stage2Ms.rounded())) "
            + "synthesisMs=\(Int(timings.synthesisMs.rounded())) "
            + "totalMs=\(Int(timings.totalMs.rounded())) "
            + "fastReject=\(timings.fastRejectReason ?? "none")"
        )

        if !timings.passTimings.isEmpty {
            let passSummary = timings.passTimings
                .map { pass in
                    let aggressiveFlag = pass.usedAggressiveRetry ? "!" : ""
                    return "\(pass.label):\(Int(pass.durationMs.rounded()))ms(req=\(pass.recognitionRequestCount),tokens=\(pass.tokenCount))\(aggressiveFlag)"
                }
                .joined(separator: ", ")
            print("⏱️ [OCR PERF] passes=\(passSummary)")
        }
    }
}

func shouldFastRejectWeakRawTargetSelection(_ targetSelection: OCRTargetSelectionResult) -> Bool {
    _ = targetSelection
    return false
}
