import Foundation

struct ScanClientContext: Codable, Hashable, Sendable {
    let platform: String
    let appVersion: String
    let buildNumber: String
    let localeIdentifier: String
    let timeZoneIdentifier: String

    static func current(
        bundle: Bundle = .main,
        locale: Locale = .current,
        timeZone: TimeZone = .current
    ) -> ScanClientContext {
        ScanClientContext(
            platform: "iOS",
            appVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
            buildNumber: bundle.object(forInfoDictionaryKey: kCFBundleVersionKey as String) as? String ?? "0",
            localeIdentifier: "en_US",  // Force US locale for TCGPlayer/USD pricing
            timeZoneIdentifier: timeZone.identifier
        )
    }
}

struct ScanImagePayload: Codable, Hashable, Sendable {
    let jpegBase64: String?
    let width: Int
    let height: Int
}

struct ScanMatchRequestPayload: Codable, Hashable, Sendable {
    let scanID: UUID
    let capturedAt: Date
    let clientContext: ScanClientContext
    let image: ScanImagePayload
    let recognizedTokens: [RecognizedToken]
    let fullRecognizedText: String
    let metadataStripRecognizedText: String
    let topLabelRecognizedText: String
    let bottomLeftRecognizedText: String
    let bottomRightRecognizedText: String
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
}

struct SearchResultsPayload: Codable, Hashable, Sendable {
    let results: [CardCandidate]
}

typealias CardDetailPayload = CardDetail

struct ScanFeedbackRequestPayload: Codable, Hashable, Sendable {
    let scanID: UUID
    let selectedCardID: String?
    let wasTopPrediction: Bool
    let correctionType: CorrectionType
    let submittedAt: Date
}
