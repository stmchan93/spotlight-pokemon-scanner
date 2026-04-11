import Foundation

struct RawSceneTraits: Codable, Hashable, Sendable {
    let holderLikely: Bool
    let usedFallback: Bool
    let targetQualityScore: Double
    let normalizedContentRect: OCRNormalizedRect?
    let warnings: [String]

    init(
        holderLikely: Bool,
        usedFallback: Bool,
        targetQualityScore: Double,
        normalizedContentRect: OCRNormalizedRect? = nil,
        warnings: [String]
    ) {
        self.holderLikely = holderLikely
        self.usedFallback = usedFallback
        self.targetQualityScore = targetQualityScore
        self.normalizedContentRect = normalizedContentRect
        self.warnings = warnings
    }

    static func derive(from targetSelection: OCRTargetSelectionResult) -> RawSceneTraits {
        let holderLikely =
            targetSelection.normalizedGeometryKind == .rawHolder ||
            targetSelection.normalizationReason?.contains("holder") == true

        var warnings: [String] = []
        if holderLikely {
            warnings.append("Raw scene looks holder-like")
        }
        if targetSelection.usedFallback {
            warnings.append("Target selection used fallback crop")
        }
        if targetSelection.selectionConfidence < 0.58 {
            warnings.append("Target selection confidence is weak")
        }

        return RawSceneTraits(
            holderLikely: holderLikely,
            usedFallback: targetSelection.usedFallback,
            targetQualityScore: targetSelection.selectionConfidence,
            normalizedContentRect: targetSelection.normalizedContentRect,
            warnings: warnings
        )
    }
}
