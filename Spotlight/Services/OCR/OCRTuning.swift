import Foundation

struct OCRTuning: Sendable {
    let raw: Raw

    static let current = OCRTuning(raw: .default)

    struct Raw: Sendable {
        let minimumTargetQualityForEscalation: Double
        let minimumTitleLengthForStrongSignal: Int
        let minimumTitleConfidenceForStrongSignal: Double
        let minimumCollectorConfidenceForStrongSignal: Double
        let minimumSetConfidenceForStrongSignal: Double
        let minimumTargetQualityForStillPhotoRetry: Double
        let minimumOverallEvidenceForNoRetry: Double

        static let `default` = Raw(
            minimumTargetQualityForEscalation: 0.56,
            minimumTitleLengthForStrongSignal: 4,
            minimumTitleConfidenceForStrongSignal: 0.46,
            minimumCollectorConfidenceForStrongSignal: 0.78,
            minimumSetConfidenceForStrongSignal: 0.62,
            minimumTargetQualityForStillPhotoRetry: 0.68,
            minimumOverallEvidenceForNoRetry: 0.58
        )
    }
}
