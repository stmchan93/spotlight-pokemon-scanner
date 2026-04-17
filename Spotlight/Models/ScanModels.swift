import Foundation
import UIKit

enum ScannerRoute: Equatable {
    case scanner
    case resultDetail
    case alternatives
}

struct ScannerNavigationState: Equatable {
    private(set) var stack: [ScannerRoute] = [.scanner]

    var currentRoute: ScannerRoute {
        stack.last ?? .scanner
    }

    mutating func resetToScanner() {
        stack = [.scanner]
    }

    mutating func push(_ route: ScannerRoute) {
        guard currentRoute != route else { return }
        stack.append(route)
    }

    mutating func pop() {
        guard stack.count > 1 else {
            resetToScanner()
            return
        }
        stack.removeLast()
    }
}

enum ResolverPath: String, Codable, Hashable, Sendable {
    case psaLabel = "psa_label"
    case psaCertBarcode = "psa_cert_barcode"
    case psaCertOCR = "psa_cert_ocr"
    case visualFallback = "visual_fallback"
    case visualOnlyIndex = "visual_only_index"
    case visualHybridIndex = "visual_hybrid_index"
    case visualOnlyUnavailable = "visual_only_unavailable"
    case visualHybridUnavailable = "visual_hybrid_unavailable"
}

enum ResolverMode: String, Codable, Hashable, Sendable {
    case rawCard = "raw_card"
    case psaSlab = "psa_slab"
    case unknownFallback = "unknown_fallback"
}

enum ScanMatchStage: String, Codable, Hashable, Sendable {
    case visual = "visual"
    case reranked = "reranked"
    case final = "final"
    case oneShot = "one_shot"
}

extension ResolverMode {
    var runtimeRawResolverMode: RawResolverMode? {
        switch self {
        case .rawCard:
            return .hybrid
        case .psaSlab, .unknownFallback:
            return nil
        }
    }
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
    let setBadgeHint: OCRSetBadgeHint?
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
    let performance: ScanMatchPerformance?
    let isProvisional: Bool?
    let matchStage: ScanMatchStage?

    init(
        scanID: UUID,
        topCandidates: [ScoredCandidate],
        confidence: MatchConfidence,
        ambiguityFlags: [String],
        matcherSource: MatcherSource,
        matcherVersion: String,
        resolverMode: ResolverMode,
        resolverPath: ResolverPath?,
        slabContext: SlabContext?,
        reviewDisposition: ReviewDisposition?,
        reviewReason: String?,
        performance: ScanMatchPerformance?,
        isProvisional: Bool? = nil,
        matchStage: ScanMatchStage? = nil
    ) {
        self.scanID = scanID
        self.topCandidates = topCandidates
        self.confidence = confidence
        self.ambiguityFlags = ambiguityFlags
        self.matcherSource = matcherSource
        self.matcherVersion = matcherVersion
        self.resolverMode = resolverMode
        self.resolverPath = resolverPath
        self.slabContext = slabContext
        self.reviewDisposition = reviewDisposition
        self.reviewReason = reviewReason
        self.performance = performance
        self.isProvisional = isProvisional
        self.matchStage = matchStage
    }

    private enum CodingKeys: String, CodingKey {
        case scanID
        case topCandidates
        case confidence
        case ambiguityFlags
        case matcherSource
        case matcherVersion
        case resolverMode
        case resolverPath
        case slabContext
        case reviewDisposition
        case reviewReason
        case performance
        case isProvisional
        case matchStage = "matchingStage"
    }

    var bestMatch: CardCandidate? {
        topCandidates.first?.candidate
    }

    var alternateMatches: [CardCandidate] {
        Array(topCandidates.dropFirst()).map(\.candidate)
    }

    func marking(
        provisional: Bool,
        stage: ScanMatchStage
    ) -> ScanMatchResponse {
        ScanMatchResponse(
            scanID: scanID,
            topCandidates: topCandidates,
            confidence: confidence,
            ambiguityFlags: ambiguityFlags,
            matcherSource: matcherSource,
            matcherVersion: matcherVersion,
            resolverMode: resolverMode,
            resolverPath: resolverPath,
            slabContext: slabContext,
            reviewDisposition: reviewDisposition,
            reviewReason: reviewReason,
            performance: performance,
            isProvisional: provisional,
            matchStage: stage
        )
    }
}

extension ScanMatchResponse {
    func mergingCandidateDetails(_ details: [CardDetail]) -> ScanMatchResponse {
        guard !details.isEmpty else { return self }

        let detailByID = Dictionary(uniqueKeysWithValues: details.map { ($0.card.id, $0.card) })
        let mergedCandidates = topCandidates.map { scoredCandidate in
            guard let updatedCard = detailByID[scoredCandidate.candidate.id] else {
                return scoredCandidate
            }
            return ScoredCandidate(
                rank: scoredCandidate.rank,
                candidate: updatedCard,
                imageScore: scoredCandidate.imageScore,
                collectorNumberScore: scoredCandidate.collectorNumberScore,
                nameScore: scoredCandidate.nameScore,
                finalScore: scoredCandidate.finalScore
            )
        }

        return ScanMatchResponse(
            scanID: scanID,
            topCandidates: mergedCandidates,
            confidence: confidence,
            ambiguityFlags: ambiguityFlags,
            matcherSource: matcherSource,
            matcherVersion: matcherVersion,
            resolverMode: resolverMode,
            resolverPath: resolverPath,
            slabContext: slabContext,
            reviewDisposition: reviewDisposition,
            reviewReason: reviewReason,
            performance: performance,
            isProvisional: isProvisional,
            matchStage: matchStage
        )
    }
}

struct ScanMatchPerformance: Codable, Hashable, Sendable {
    let serverProcessingMs: Double?
    let scrydexRequestCount: Int?
    let scrydexRequestTypes: [String]?
}

enum CorrectionType: String, Codable, Sendable {
    case acceptedTop
    case choseAlternative
    case manualSearch
    case abandoned
}

enum ScanSelectionSource: String, Codable, Hashable, Sendable {
    case topPrediction = "top"
    case alternatePrediction = "alternate"
    case manualSearch = "manual_search"
    case abandoned = "abandoned"
    case unknown = "unknown"
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

    // Live scans should show the exact reticle crop in the tray so the pending
    // thumbnail matches the scanner composition the user saw. The broader
    // search crop is only a fallback when the exact crop is unavailable.
    var trayPreviewImage: UIImage {
        switch captureSource {
        case .livePreviewFrame, .liveStillPhoto:
            return fallbackImage ?? searchImage
        case .importedPhoto:
            return originalImage
        }
    }
}

struct LiveScanStackItem: Identifiable {
    let id: UUID
    let scanID: UUID
    var phase: LiveScanStackItemPhase
    var isProvisional: Bool = false
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
    var selectedRank: Int?
    var wasTopPrediction: Bool
    var selectionSource: ScanSelectionSource
    var availableVariants: [MarketHistoryOption] = []
    var selectedVariant: String? = nil
    var variantPricingOverride: CardPricingSummary? = nil
    var isLoadingVariants: Bool = false

    var displayCard: CardCandidate? {
        detail?.card ?? card
    }

    var basePricing: CardPricingSummary? {
        detail?.pricing ?? card?.pricing
    }

    var pricing: CardPricingSummary? {
        variantPricingOverride ?? basePricing
    }

    var metricInput: ScanTrayMetricInput {
        ScanTrayMetricInput(phase: phase, pricing: pricing)
    }
}
