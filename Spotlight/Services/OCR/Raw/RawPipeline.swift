import Foundation
import UIKit

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
        let stage1Plans = roiPlanner.stage1Plan(for: sceneTraits)
        let stage1PassResults = try await passRunner.run(
            scanID: scanID,
            in: workingCGImage,
            plans: stage1Plans
        )
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
            plans: stage1Plans + stage2Plans,
            passResults: allPassResults,
            didEscalate: !stage2Plans.isEmpty
        )

        return AnalyzedCapture(
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
            directLookupLikely: synthesized.directLookupLikely,
            resolverModeHint: resolverModeHint,
            cropConfidence: targetSelection.selectionConfidence,
            warnings: synthesized.warnings,
            shouldRetryWithStillPhoto: synthesized.shouldRetryWithStillPhoto,
            stillPhotoRetryReason: synthesized.stillPhotoRetryReason,
            ocrAnalysis: synthesized.ocrAnalysis
        )
    }
}
