import Foundation

enum OCRPipelineVersion: String, Codable, Hashable, Sendable {
    case legacyV1 = "legacy_v1"
    case rewriteV1 = "rewrite_v1"
}

enum OCRSelectedMode: String, Codable, Hashable, Sendable {
    case raw
    case slab
}

struct OCRFieldConfidence: Codable, Hashable, Sendable {
    let score: Double
    let agreementScore: Double?
    let tokenConfidenceAverage: Double?
    let reasons: [String]

    static let unknown = OCRFieldConfidence(
        score: 0,
        agreementScore: nil,
        tokenConfidenceAverage: nil,
        reasons: []
    )
}

struct OCRNormalizedRect: Codable, Hashable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OCRTargetQuality: Codable, Hashable, Sendable {
    let overallScore: Double
    let centeringScore: Double?
    let aspectScore: Double?
    let areaCoverageScore: Double?
    let glarePenalty: Double?
    let holderPenalty: Double?
    let reasons: [String]

    static let unknown = OCRTargetQuality(
        overallScore: 0,
        centeringScore: nil,
        aspectScore: nil,
        areaCoverageScore: nil,
        glarePenalty: nil,
        holderPenalty: nil,
        reasons: []
    )
}

struct OCRModeSanitySignals: Codable, Hashable, Sendable {
    let selectedMode: OCRSelectedMode
    let looksLikeRawScore: Double?
    let looksLikeSlabScore: Double?
    let warnings: [String]
}

struct OCRNormalizedTarget: Codable, Hashable, Sendable {
    let selectedRectNormalized: OCRNormalizedRect?
    let normalizedWidth: Int
    let normalizedHeight: Int
    let usedFallback: Bool
    let geometryKind: String?
    let targetQuality: OCRTargetQuality
}

struct OCRRawEvidence: Codable, Hashable, Sendable {
    let titleTextPrimary: String?
    let titleTextSecondary: String?
    let titleConfidence: OCRFieldConfidence?
    let collectorNumberExact: String?
    let collectorNumberPartial: String?
    let collectorConfidence: OCRFieldConfidence?
    let setHints: [String]
    let setConfidence: OCRFieldConfidence?
    let footerBandText: String
    let wholeCardText: String
    let warnings: [String]
}

struct OCRSlabEvidence: Codable, Hashable, Sendable {
    let titleTextPrimary: String?
    let titleTextSecondary: String?
    let titleConfidence: OCRFieldConfidence?
    let cardNumber: String?
    let cardNumberConfidence: OCRFieldConfidence?
    let setText: String?
    let setHints: [String]
    let setConfidence: OCRFieldConfidence?
    let grader: String?
    let graderConfidence: OCRFieldConfidence?
    let grade: String?
    let gradeConfidence: OCRFieldConfidence?
    let cert: String?
    let certConfidence: OCRFieldConfidence?
    let labelWideText: String
    let warnings: [String]
}

struct OCRAnalysisEnvelope: Codable, Hashable, Sendable {
    let pipelineVersion: OCRPipelineVersion
    let selectedMode: OCRSelectedMode
    let normalizedTarget: OCRNormalizedTarget?
    let modeSanitySignals: OCRModeSanitySignals?
    let rawEvidence: OCRRawEvidence?
    let slabEvidence: OCRSlabEvidence?
}
