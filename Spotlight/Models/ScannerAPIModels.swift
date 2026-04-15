import Foundation

enum DeckCardCondition: String, CaseIterable, Codable, Hashable, Identifiable, Sendable {
    case nearMint = "near_mint"
    case lightlyPlayed = "lightly_played"
    case moderatelyPlayed = "moderately_played"
    case heavilyPlayed = "heavily_played"
    case damaged = "damaged"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .nearMint:
            "Near Mint"
        case .lightlyPlayed:
            "Lightly Played"
        case .moderatelyPlayed:
            "Moderately Played"
        case .heavilyPlayed:
            "Heavily Played"
        case .damaged:
            "Damaged"
        }
    }

    var shortLabel: String {
        switch self {
        case .nearMint:
            "NM"
        case .lightlyPlayed:
            "LP"
        case .moderatelyPlayed:
            "MP"
        case .heavilyPlayed:
            "HP"
        case .damaged:
            "DMG"
        }
    }
}

enum RawResolverMode: String, Codable, Hashable, Sendable {
    case visual
    case hybrid
}

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
    let rawResolverMode: RawResolverMode?
    let cropConfidence: Double
    let warnings: [String]
    let ocrAnalysis: OCRAnalysisEnvelope?
}

struct SearchResultsPayload: Codable, Hashable, Sendable {
    let results: [CardCandidate]
}

typealias CardDetailPayload = CardDetail

struct CandidatePricingHydrationRequestPayload: Codable, Hashable, Sendable {
    let cardIDs: [String]
    let maxRefreshCount: Int
    let forceRefresh: Bool
    let slabContext: SlabContext?
}

struct CandidatePricingHydrationResponsePayload: Codable, Hashable, Sendable {
    let cards: [CardDetail]
    let requestedCount: Int
    let returnedCount: Int
    let refreshedCount: Int
}

struct ScanFeedbackRequestPayload: Codable, Hashable, Sendable {
    let scanID: UUID
    let selectedCardID: String?
    let wasTopPrediction: Bool
    let correctionType: CorrectionType
    let submittedAt: Date
}

struct ScanArtifactUploadRequestPayload: Codable, Hashable, Sendable {
    let scanID: UUID
    let captureSource: ScanCaptureSource
    let cameraZoomFactor: Double?
    let sourceImage: ScanImagePayload
    let normalizedImage: ScanImagePayload
    let submittedAt: Date
}

struct DeckEntryCreateRequestPayload: Codable, Hashable, Sendable {
    let cardID: String
    let slabContext: SlabContext?
    let condition: DeckCardCondition?
    let sourceScanID: UUID?
    let selectionSource: ScanSelectionSource
    let selectedRank: Int?
    let wasTopPrediction: Bool
    let addedAt: Date
}

struct DeckEntryCreateResponsePayload: Codable, Hashable, Sendable {
    let entryID: String
    let inserted: Bool
}

struct DeckEntryPayload: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let card: CardCandidate
    let slabContext: SlabContext?
    let condition: DeckCardCondition?
    let quantity: Int
    let addedAt: Date

    private enum CodingKeys: String, CodingKey {
        case id
        case card
        case slabContext
        case condition
        case quantity
        case addedAt
    }

    private enum AlternateCodingKeys: String, CodingKey {
        case deckEntryID = "deckEntryID"
        case deckEntryIDSnake = "deck_entry_id"
        case slabContextSnake = "slab_context"
        case conditionSnake = "condition"
        case addedAtSnake = "added_at"
    }

    init(
        id: String,
        card: CardCandidate,
        slabContext: SlabContext?,
        condition: DeckCardCondition? = nil,
        quantity: Int = 1,
        addedAt: Date
    ) {
        self.id = id
        self.card = card
        self.slabContext = slabContext
        self.condition = condition
        self.quantity = quantity
        self.addedAt = addedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let alternateContainer = try decoder.container(keyedBy: AlternateCodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id)
            ?? alternateContainer.decodeIfPresent(String.self, forKey: .deckEntryID)
            ?? alternateContainer.decodeIfPresent(String.self, forKey: .deckEntryIDSnake)
            ?? ""
        if let candidate = try? container.decode(CardCandidate.self, forKey: .card) {
            card = candidate
        } else {
            card = try container.decode(CardDetail.self, forKey: .card).card
        }
        slabContext = try container.decodeIfPresent(SlabContext.self, forKey: .slabContext)
            ?? alternateContainer.decodeIfPresent(SlabContext.self, forKey: .slabContextSnake)
        condition = try container.decodeIfPresent(DeckCardCondition.self, forKey: .condition)
            ?? alternateContainer.decodeIfPresent(DeckCardCondition.self, forKey: .conditionSnake)
        quantity = try container.decodeIfPresent(Int.self, forKey: .quantity) ?? 1
        addedAt = try container.decodeIfPresent(Date.self, forKey: .addedAt)
            ?? alternateContainer.decodeIfPresent(Date.self, forKey: .addedAtSnake)
            ?? Date()
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(card, forKey: .card)
        try container.encodeIfPresent(slabContext, forKey: .slabContext)
        try container.encodeIfPresent(condition, forKey: .condition)
        try container.encode(quantity, forKey: .quantity)
        try container.encode(addedAt, forKey: .addedAt)
    }
}

struct DeckEntryConditionUpdateRequestPayload: Codable, Hashable, Sendable {
    let cardID: String
    let slabContext: SlabContext?
    let condition: DeckCardCondition
    let updatedAt: Date
}

struct DeckEntriesResponsePayload: Codable, Hashable, Sendable {
    let entries: [DeckEntryPayload]
}
