import Foundation
import UIKit

enum ScannerRoute {
    case scanner
    case alternatives
}

enum ResolverPath: String, Codable, Hashable, Sendable {
    case directLookup = "direct_lookup"
    case psaLabel = "psa_label"
    case visualFallback = "visual_fallback"
}

enum ResolverMode: String, Codable, Hashable, Sendable {
    case rawCard = "raw_card"
    case psaSlab = "psa_slab"
    case unknownFallback = "unknown_fallback"
}

enum ReviewDisposition: String, Codable, Hashable, Sendable {
    case ready
    case needsReview = "needs_review"
    case unsupported
}

struct RecognizedToken: Hashable, Sendable {
    let text: String
    let confidence: Float
    let normalizedBoundingBox: OCRNormalizedRect?

    init(
        text: String,
        confidence: Float,
        normalizedBoundingBox: OCRNormalizedRect? = nil
    ) {
        self.text = text
        self.confidence = confidence
        self.normalizedBoundingBox = normalizedBoundingBox
    }
}

struct AnalyzedCapture: @unchecked Sendable {
    let scanID: UUID
    let originalImage: UIImage
    let normalizedImage: UIImage
    let recognizedTokens: [RecognizedToken]
    let collectorNumber: String?
    let setHintTokens: [String]
    let promoCodeHint: String?
    let slabGrader: String?
    let slabGrade: String?
    let slabCertNumber: String?
    let slabBarcodePayloads: [String]
    let slabGraderConfidence: Double?
    let slabGradeConfidence: Double?
    let slabCertConfidence: Double?
    let slabCardNumberRaw: String?
    let slabParsedLabelText: [String]
    let slabClassifierReasons: [String]
    let slabRecommendedLookupPath: SlabRecommendedLookupPath?
    let directLookupLikely: Bool
    let resolverModeHint: ResolverMode
    let cropConfidence: Double
    let warnings: [String]
    let shouldRetryWithStillPhoto: Bool
    let stillPhotoRetryReason: String?
    let ocrAnalysis: OCRAnalysisEnvelope?
}

extension RecognizedToken: Codable {}

struct ScanMatchResponse: Codable, Hashable, Sendable {
    let scanID: UUID
    let topCandidates: [ScoredCandidate]
    let confidence: MatchConfidence
    let ambiguityFlags: [String]
    let matcherSource: MatcherSource
    let matcherVersion: String
    let resolverMode: ResolverMode
    let resolverPath: ResolverPath?
    let slabContext: SlabContext?
    let reviewDisposition: ReviewDisposition?
    let reviewReason: String?

    var bestMatch: CardCandidate? {
        topCandidates.first?.candidate
    }

    var alternateMatches: [CardCandidate] {
        Array(topCandidates.dropFirst()).map(\.candidate)
    }
}

enum CorrectionType: String, Codable, Sendable {
    case acceptedTop
    case choseAlternative
    case manualSearch
    case abandoned
}

struct ScanEventLog: Codable, Identifiable, Sendable {
    let id: UUID
    let createdAt: Date
    let recognizedTokens: [String]
    let collectorNumber: String?
    let cropConfidence: Double
    let warnings: [String]
    let confidence: MatchConfidence
    let matcherSource: MatcherSource
    let matcherVersion: String
    let candidates: [ScoredCandidate]
    var selectedCardID: String?
    var wasTopPrediction: Bool?
    var correctionType: CorrectionType?
    var completedAt: Date?
}

struct ScanPerformanceMetrics: Hashable, Sendable {
    let analysisMs: Double
    let matchMs: Double
    let totalMs: Double

    var summaryLabel: String {
        "Scan \(Int(totalMs.rounded())) ms"
    }
}

enum CacheStatus {
    case fresh              // < 1 hour old
    case recent(hours: Int) // 1-24 hours
    case outdated(days: Int)// 1-7 days
    case offline            // No backend connection
}

enum ScanCaptureSource: String, Codable, Hashable, Sendable {
    case livePreviewFrame = "live_preview_frame"
    case liveStillPhoto = "live_still_photo"
    case importedPhoto = "imported_photo"
}

struct ScanCaptureInput: @unchecked Sendable {
    let originalImage: UIImage
    let searchImage: UIImage
    let fallbackImage: UIImage?
    let captureSource: ScanCaptureSource
}

struct LiveScanStackItem: Identifiable {
    let id: UUID
    let scanID: UUID
    var phase: LiveScanStackItemPhase
    var card: CardCandidate?
    var detail: CardDetail?
    var previewImage: UIImage?
    var confidence: MatchConfidence
    var matcherSource: MatcherSource
    var matcherVersion: String
    var resolverMode: ResolverMode
    var resolverPath: ResolverPath?
    var slabContext: SlabContext?
    var reviewDisposition: ReviewDisposition
    var reviewReason: String?
    let addedAt: Date
    var isExpanded: Bool
    var isRefreshingPrice: Bool
    var statusMessage: String?
    var pricingContextNote: String?
    var performance: ScanPerformanceMetrics?
    var cacheStatus: CacheStatus?

    var displayCard: CardCandidate? {
        detail?.card ?? card
    }

    var pricing: CardPricingSummary? {
        detail?.pricing ?? card?.pricing
    }

    var metricInput: ScanTrayMetricInput {
        ScanTrayMetricInput(phase: phase, pricing: pricing)
    }
}
