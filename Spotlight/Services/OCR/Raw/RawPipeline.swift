import Foundation
import UIKit

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
        try await analyzeDebug(
            scanID: scanID,
            capture: capture,
            resolverModeHint: resolverModeHint
        ).analyzedCapture
    }

    func analyzeDebug(
        scanID: UUID,
        capture: ScanCaptureInput,
        resolverModeHint: ResolverMode = .rawCard
    ) async throws -> RawPipelineDebugSnapshot {
        let targetSelection = try selectOCRInput(
            scanID: scanID,
            capture: capture,
            mode: .rawCard
        )
        let normalizedOriginal = capture.originalImage.normalizedOrientation()

        guard let workingCGImage = targetSelection.normalizedImage.cgImage else {
            throw AnalysisError.invalidImage
        }

        let sceneTraits = RawSceneTraits.derive(from: targetSelection)
        let stage1BroadPlans = roiPlanner.stage1BroadPlan(for: sceneTraits)
        let stage1BroadPassResults = try await passRunner.run(
            scanID: scanID,
            in: workingCGImage,
            plans: stage1BroadPlans
        )
        let footerRouting = confidenceModel.deriveFooterRoutingContext(from: stage1BroadPassResults)
        let stage1TightPlans = roiPlanner.stage1TightPlan(
            for: sceneTraits,
            routing: footerRouting
        )
        let stage1TightPassResults = try await passRunner.run(
            scanID: scanID,
            in: workingCGImage,
            plans: stage1TightPlans
        )
        let stage1PassResults = stage1BroadPassResults + stage1TightPassResults
        let stage1Assessment = confidenceModel.assessStage1(
            passResults: stage1PassResults,
            sceneTraits: sceneTraits
        )
        let stage2Plans = stage1Assessment.shouldEscalate
            ? roiPlanner.stage2Plan(for: sceneTraits)
            : []
        let stage2PassResults = stage2Plans.isEmpty
            ? []
            : try await passRunner.run(
                scanID: scanID,
                in: workingCGImage,
                plans: stage2Plans
            )
        let allPassResults = stage1PassResults + stage2PassResults
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

        let analyzedCapture = AnalyzedCapture(
            scanID: scanID,
            originalImage: normalizedOriginal,
            normalizedImage: targetSelection.normalizedImage,
            recognizedTokens: synthesized.recognizedTokens,
            collectorNumber: synthesized.collectorNumber,
            setHintTokens: synthesized.setHintTokens,
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
            stage1Assessment: stage1Assessment
        )
    }
}
