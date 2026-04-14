import Foundation
import UIKit

struct RawPipelineResult {
    let recognizedTokens: [RecognizedToken]
    let collectorNumber: String?
    let collectorNumberPartial: String?
    let setHintTokens: [String]
    let setBadgeHint: OCRSetBadgeHint?
    let promoCodeHint: String?
    let warnings: [String]
    let shouldRetryWithStillPhoto: Bool
    let stillPhotoRetryReason: String?
    let ocrAnalysis: OCRAnalysisEnvelope
}

private struct RawRewriteArtifactPayload: Codable {
    let sceneTraits: RawSceneTraits
    let routing: RawFooterRoutingContext
    let stage1Assessment: RawStageAssessment
    let plans: [RawROIPlanItem]
    let regions: [ScanStageRawRegionArtifact]
    let didEscalate: Bool
    let collectorNumber: String?
    let collectorNumberPartial: String?
    let setHintTokens: [String]
    let overallEvidenceScore: Double
}

struct RawEvidenceSynthesizer {
    private let confidenceModel: RawConfidenceModel

    init(confidenceModel: RawConfidenceModel = RawConfidenceModel()) {
        self.confidenceModel = confidenceModel
    }

    func synthesize(
        scanID: UUID,
        captureSource: ScanCaptureSource,
        targetSelection: OCRTargetSelectionResult,
        sceneTraits: RawSceneTraits,
        stage1Assessment: RawStageAssessment,
        routing: RawFooterRoutingContext,
        plans: [RawROIPlanItem],
        passResults: [RawOCRPassResult],
        didEscalate: Bool
    ) -> RawPipelineResult {
        let footer = passResults.first(where: { $0.kind == .footerBandWide })
        let summary = confidenceModel.summarizeEvidence(from: passResults)

        let titleText = summary.title.primaryText
        let secondaryTitleText = summary.title.secondaryText
        let titleConfidence = summary.title.confidence
        let footerBandText = footer?.text ?? ""
        let collectorNumber = summary.collector.exact
        let collectorNumberPartial = summary.collector.partial
        let collectorConfidence = summary.collector.confidence
        let setHintTokens = summary.set.hints
        let setBadgeHint = summary.set.badgeHint
        let setConfidence = summary.set.confidence
        let recognizedTokens = mergedRecognizedTokens(
            prioritizedGroups: passResults.map(\.tokens)
        )
        let fullRecognizedText = recognizedTokens.map(\.text).joined(separator: " ")

        var warnings = sceneTraits.warnings
        if didEscalate {
            warnings.append("Rewrite raw escalation used focused ROIs")
        }
        if collectorNumber == nil && collectorNumberPartial == nil {
            if summary.title.isStrong {
                warnings.append("Rewrite raw is relying on broader title evidence")
            } else {
                warnings.append("Could not read strong raw-card clues")
            }
        }
        if summary.overallScore < 0.45 {
            warnings.append("Low-confidence rewrite raw evidence")
        }

        let shouldRetryWithStillPhoto = confidenceModel.shouldRetryWithStillPhoto(
            captureSource: captureSource,
            summary: summary,
            targetQualityScore: targetSelection.selectionConfidence
        )
        let stillPhotoRetryReason = shouldRetryWithStillPhoto
            ? "rewrite_raw_preview_frame_evidence_too_weak"
            : nil

        let rawEvidence = OCRRawEvidence(
            titleTextPrimary: titleText,
            titleTextSecondary: secondaryTitleText,
            titleConfidence: titleConfidence,
            collectorNumberExact: collectorNumber,
            collectorNumberPartial: collectorNumberPartial,
            collectorConfidence: collectorConfidence,
            setBadgeHint: setBadgeHint,
            setHints: setHintTokens,
            setConfidence: setConfidence,
            footerBandText: footerBandText,
            wholeCardText: fullRecognizedText,
            warnings: warnings
        )

        let ocrAnalysis = OCRAnalysisEnvelope(
            pipelineVersion: .rewriteV1,
            selectedMode: .raw,
            normalizedTarget: buildLegacyNormalizedTarget(from: targetSelection),
            modeSanitySignals: buildLegacyModeSanitySignals(
                selectedMode: .raw,
                targetSelection: targetSelection
            ),
            rawEvidence: rawEvidence,
            slabEvidence: nil
        )

        ScanStageArtifactWriter.recordSynthesizedEvidenceArtifact(
            scanID: scanID,
            stage: "rewrite_raw_regions",
            payload: RawRewriteArtifactPayload(
                sceneTraits: sceneTraits,
                routing: routing,
                stage1Assessment: stage1Assessment,
                plans: plans,
                regions: passResults.map(\.artifactRegion),
                didEscalate: didEscalate,
                collectorNumber: collectorNumber,
                collectorNumberPartial: collectorNumberPartial,
                setHintTokens: setHintTokens,
                overallEvidenceScore: summary.overallScore
            )
        )
        ScanStageArtifactWriter.recordSynthesizedEvidenceArtifact(
            scanID: scanID,
            stage: "rewrite_raw_ocr_analysis",
            payload: ocrAnalysis
        )

        return RawPipelineResult(
            recognizedTokens: recognizedTokens,
            collectorNumber: collectorNumber,
            collectorNumberPartial: collectorNumberPartial,
            setHintTokens: setHintTokens,
            setBadgeHint: setBadgeHint,
            promoCodeHint: extractPromoHint(from: collectorNumber ?? collectorNumberPartial),
            warnings: warnings,
            shouldRetryWithStillPhoto: shouldRetryWithStillPhoto,
            stillPhotoRetryReason: stillPhotoRetryReason,
            ocrAnalysis: ocrAnalysis
        )
    }

    func synthesizeFastReject(
        scanID: UUID,
        targetSelection: OCRTargetSelectionResult,
        sceneTraits: RawSceneTraits,
        reason: String
    ) -> RawPipelineResult {
        var warnings = sceneTraits.warnings
        warnings.append("Skipped expensive OCR because target selection was too weak")
        warnings.append("Could not read strong raw-card clues")
        warnings.append("Low-confidence rewrite raw evidence")

        let rawEvidence = OCRRawEvidence(
            titleTextPrimary: nil,
            titleTextSecondary: nil,
            titleConfidence: nil,
            collectorNumberExact: nil,
            collectorNumberPartial: nil,
            collectorConfidence: nil,
            setBadgeHint: nil,
            setHints: [],
            setConfidence: nil,
            footerBandText: "",
            wholeCardText: "",
            warnings: warnings
        )

        let ocrAnalysis = OCRAnalysisEnvelope(
            pipelineVersion: .rewriteV1,
            selectedMode: .raw,
            normalizedTarget: buildLegacyNormalizedTarget(from: targetSelection),
            modeSanitySignals: buildLegacyModeSanitySignals(
                selectedMode: .raw,
                targetSelection: targetSelection
            ),
            rawEvidence: rawEvidence,
            slabEvidence: nil
        )

        ScanStageArtifactWriter.recordSynthesizedEvidenceArtifact(
            scanID: scanID,
            stage: "rewrite_raw_fast_reject",
            payload: ["reason": reason]
        )
        ScanStageArtifactWriter.recordSynthesizedEvidenceArtifact(
            scanID: scanID,
            stage: "rewrite_raw_ocr_analysis",
            payload: ocrAnalysis
        )

        return RawPipelineResult(
            recognizedTokens: [],
            collectorNumber: nil,
            collectorNumberPartial: nil,
            setHintTokens: [],
            setBadgeHint: nil,
            promoCodeHint: nil,
            warnings: warnings,
            shouldRetryWithStillPhoto: false,
            stillPhotoRetryReason: nil,
            ocrAnalysis: ocrAnalysis
        )
    }

    private func mergedRecognizedTokens(prioritizedGroups: [[RecognizedToken]]) -> [RecognizedToken] {
        var merged: [RecognizedToken] = []
        var seen = Set<String>()

        for group in prioritizedGroups {
            for token in group {
                let key = token.text
                    .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
                    .lowercased()
                guard !key.isEmpty, !seen.contains(key) else { continue }
                seen.insert(key)
                merged.append(token)
            }
        }

        return merged
    }

    private func extractPromoHint(from identifier: String?) -> String? {
        guard let identifier = identifier else { return nil }
        let normalized = identifier.uppercased()

        if let match = firstMatch(in: normalized, pattern: #"\b([A-Z]{2,5})\s?\d{1,3}\b"#) {
            return match
        }

        if let match = firstMatch(in: normalized, pattern: #"\b([A-Z]{1,5})\d{1,3}/[A-Z]{1,5}\d{1,3}\b"#) {
            return match
        }

        return nil
    }

    private func firstMatch(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }

        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              match.numberOfRanges > 1,
              let captureRange = Range(match.range(at: 1), in: text) else {
            return nil
        }

        return String(text[captureRange])
    }

}
