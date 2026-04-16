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
    let costBasisTotal: Double
    let costBasisCurrencyCode: String?
    let addedAt: Date

    private enum CodingKeys: String, CodingKey {
        case id
        case card
        case slabContext
        case condition
        case quantity
        case costBasisTotal
        case costBasisCurrencyCode
        case addedAt
    }

    private enum AlternateCodingKeys: String, CodingKey {
        case deckEntryID = "deckEntryID"
        case deckEntryIDSnake = "deck_entry_id"
        case slabContextSnake = "slab_context"
        case conditionSnake = "condition"
        case costBasisTotalSnake = "cost_basis_total"
        case costBasisCurrencyCodeSnake = "cost_basis_currency_code"
        case addedAtSnake = "added_at"
    }

    init(
        id: String,
        card: CardCandidate,
        slabContext: SlabContext?,
        condition: DeckCardCondition? = nil,
        quantity: Int = 1,
        costBasisTotal: Double = 0,
        costBasisCurrencyCode: String? = nil,
        addedAt: Date
    ) {
        self.id = id
        self.card = card
        self.slabContext = slabContext
        self.condition = condition
        self.quantity = quantity
        self.costBasisTotal = costBasisTotal
        self.costBasisCurrencyCode = costBasisCurrencyCode
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
        costBasisTotal = try container.decodeIfPresent(Double.self, forKey: .costBasisTotal)
            ?? alternateContainer.decodeIfPresent(Double.self, forKey: .costBasisTotalSnake)
            ?? 0
        costBasisCurrencyCode = try container.decodeIfPresent(String.self, forKey: .costBasisCurrencyCode)
            ?? alternateContainer.decodeIfPresent(String.self, forKey: .costBasisCurrencyCodeSnake)
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
        try container.encode(costBasisTotal, forKey: .costBasisTotal)
        try container.encodeIfPresent(costBasisCurrencyCode, forKey: .costBasisCurrencyCode)
        try container.encode(addedAt, forKey: .addedAt)
    }
}

struct DeckEntryConditionUpdateRequestPayload: Codable, Hashable, Sendable {
    let cardID: String
    let slabContext: SlabContext?
    let condition: DeckCardCondition
    let updatedAt: Date
}

struct DeckEntryPurchasePriceUpdateRequestPayload: Codable, Hashable, Sendable {
    let cardID: String
    let slabContext: SlabContext?
    let unitPrice: Double
    let currencyCode: String
    let updatedAt: Date
}

struct PortfolioTransactionPriceUpdateRequestPayload: Codable, Hashable, Sendable {
    let unitPrice: Double
    let currencyCode: String
    let updatedAt: Date
}

struct DeckEntriesResponsePayload: Codable, Hashable, Sendable {
    let entries: [DeckEntryPayload]
}

enum PortfolioHistoryRange: String, CaseIterable, Codable, Hashable, Sendable, Identifiable {
    case days7 = "7D"
    case days30 = "30D"
    case days90 = "90D"
    case all = "ALL"

    var id: String { rawValue }

    var displayLabel: String { rawValue }
}

enum PortfolioDashboardChartMode: String, CaseIterable, Codable, Hashable, Sendable, Identifiable {
    case inventory
    case business
    case activity

    var id: String { rawValue }

    var displayLabel: String {
        switch self {
        case .inventory:
            return "Inventory"
        case .business:
            return "Business"
        case .activity:
            return "Activity"
        }
    }

    var displayName: String { displayLabel }
}

struct PortfolioSaleCreateRequestPayload: Codable, Hashable, Sendable {
    let cardID: String
    let slabContext: SlabContext?
    let quantity: Int
    let unitPrice: Double
    let currencyCode: String
    let paymentMethod: String?
    let soldAt: Date
    let showSessionID: String?
    let note: String?
    let sourceScanID: UUID?
}

struct PortfolioBuyCreateRequestPayload: Codable, Hashable, Sendable {
    let cardID: String
    let slabContext: SlabContext?
    let condition: DeckCardCondition?
    let quantity: Int
    let unitPrice: Double
    let currencyCode: String
    let paymentMethod: String?
    let boughtAt: Date
    let sourceScanID: UUID?
}

struct PortfolioBuyCreateResponsePayload: Codable, Hashable, Sendable {
    let deckEntryID: String
    let cardID: String
    let inserted: Bool
    let quantityAdded: Int
    let totalSpend: Double
    let boughtAt: Date
}

struct PortfolioSaleCreateResponsePayload: Codable, Hashable, Sendable {
    let saleID: String
    let deckEntryID: String
    let remainingQuantity: Int
    let grossTotal: Double
    let soldAt: Date
    let showSessionID: String?
}

struct PortfolioHistoryCoverage: Codable, Hashable, Sendable {
    let pricedCardCount: Int
    let excludedCardCount: Int
}

struct PortfolioHistoryPoint: Codable, Hashable, Sendable, Identifiable {
    let date: String
    let totalValue: Double
    let marketValue: Double?
    let costBasisValue: Double?
    let pricedCardCount: Int
    let excludedCardCount: Int

    var id: String { date }
}

struct PortfolioHistorySummary: Codable, Hashable, Sendable {
    let currentValue: Double
    let startValue: Double
    let deltaValue: Double
    let deltaPercent: Double?
    let currentCostBasisValue: Double?
    let startCostBasisValue: Double?
    let deltaCostBasisValue: Double?
}

struct PortfolioHistory: Codable, Hashable, Sendable {
    let range: PortfolioHistoryRange
    let summary: PortfolioHistorySummary
    let coverage: PortfolioHistoryCoverage
    let currencyCode: String
    let points: [PortfolioHistoryPoint]
    let isFresh: Bool?
    let refreshedAt: String?
}

enum PortfolioTransactionKind: String, Codable, Hashable, Sendable {
    case buy
    case sell
}

struct PortfolioLedgerSummary: Codable, Hashable, Sendable {
    let revenue: Double
    let spend: Double
    let grossProfit: Double
    let inventoryValue: Double
    let inventoryCount: Int
}

struct PortfolioLedgerDailyPoint: Codable, Hashable, Sendable, Identifiable {
    let date: String
    let revenue: Double
    let spend: Double
    let realizedProfit: Double
    let buyCount: Int
    let sellCount: Int

    var id: String { date }
}

struct PortfolioLedgerTransaction: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let kind: PortfolioTransactionKind
    let card: CardCandidate
    let slabContext: SlabContext?
    let condition: DeckCardCondition?
    let quantity: Int
    let unitPrice: Double?
    let totalPrice: Double
    let currencyCode: String
    let paymentMethod: String?
    let costBasisTotal: Double?
    let grossProfit: Double?
    let occurredAt: Date
    let note: String?
}

struct PortfolioLedger: Codable, Hashable, Sendable {
    let range: PortfolioHistoryRange
    let currencyCode: String
    let summary: PortfolioLedgerSummary
    let transactions: [PortfolioLedgerTransaction]
    let dailySeries: [PortfolioLedgerDailyPoint]
    let count: Int
    let limit: Int
    let offset: Int
    let refreshedAt: String?

    private enum CodingKeys: String, CodingKey {
        case range
        case currencyCode
        case summary
        case transactions
        case dailySeries
        case count
        case limit
        case offset
        case refreshedAt
    }

    private enum AlternateCodingKeys: String, CodingKey {
        case currencyCode = "currency_code"
        case dailySeries = "daily_series"
        case refreshedAt = "refreshed_at"
    }

    init(
        range: PortfolioHistoryRange,
        currencyCode: String,
        summary: PortfolioLedgerSummary,
        transactions: [PortfolioLedgerTransaction],
        dailySeries: [PortfolioLedgerDailyPoint] = [],
        count: Int,
        limit: Int,
        offset: Int,
        refreshedAt: String?
    ) {
        self.range = range
        self.currencyCode = currencyCode
        self.summary = summary
        self.transactions = transactions
        self.dailySeries = dailySeries
        self.count = count
        self.limit = limit
        self.offset = offset
        self.refreshedAt = refreshedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let alternateContainer = try decoder.container(keyedBy: AlternateCodingKeys.self)
        range = try container.decode(PortfolioHistoryRange.self, forKey: .range)
        currencyCode = try container.decodeIfPresent(String.self, forKey: .currencyCode)
            ?? alternateContainer.decodeIfPresent(String.self, forKey: .currencyCode)
            ?? "USD"
        summary = try container.decode(PortfolioLedgerSummary.self, forKey: .summary)
        transactions = try container.decodeIfPresent([PortfolioLedgerTransaction].self, forKey: .transactions) ?? []
        dailySeries = try container.decodeIfPresent([PortfolioLedgerDailyPoint].self, forKey: .dailySeries)
            ?? alternateContainer.decodeIfPresent([PortfolioLedgerDailyPoint].self, forKey: .dailySeries)
            ?? []
        count = try container.decodeIfPresent(Int.self, forKey: .count) ?? transactions.count
        limit = try container.decodeIfPresent(Int.self, forKey: .limit) ?? transactions.count
        offset = try container.decodeIfPresent(Int.self, forKey: .offset) ?? 0
        refreshedAt = try container.decodeIfPresent(String.self, forKey: .refreshedAt)
            ?? alternateContainer.decodeIfPresent(String.self, forKey: .refreshedAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(range, forKey: .range)
        try container.encode(currencyCode, forKey: .currencyCode)
        try container.encode(summary, forKey: .summary)
        try container.encode(transactions, forKey: .transactions)
        try container.encode(dailySeries, forKey: .dailySeries)
        try container.encode(count, forKey: .count)
        try container.encode(limit, forKey: .limit)
        try container.encode(offset, forKey: .offset)
        try container.encodeIfPresent(refreshedAt, forKey: .refreshedAt)
    }
}

struct PortfolioLedgerCumulativeBusinessPoint: Hashable, Sendable, Identifiable {
    let date: String
    let cumulativeSpend: Double
    let cumulativeRevenue: Double
    let cumulativeRealizedProfit: Double

    var id: String { date }
}

func portfolioCumulativeBusinessSeries(
    from dailySeries: [PortfolioLedgerDailyPoint]
) -> [PortfolioLedgerCumulativeBusinessPoint] {
    let orderedSeries = dailySeries.enumerated().sorted { lhs, rhs in
        let lhsDate = lhs.element.date.trimmingCharacters(in: .whitespacesAndNewlines)
        let rhsDate = rhs.element.date.trimmingCharacters(in: .whitespacesAndNewlines)
        if lhsDate != rhsDate {
            return lhsDate < rhsDate
        }
        return lhs.offset < rhs.offset
    }

    var cumulativeSpend = 0.0
    var cumulativeRevenue = 0.0
    var cumulativeRealizedProfit = 0.0
    var points: [PortfolioLedgerCumulativeBusinessPoint] = []
    points.reserveCapacity(orderedSeries.count)

    for element in orderedSeries {
        let date = element.element.date.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !date.isEmpty else { continue }
        cumulativeSpend = roundedPortfolioCurrencyValue(cumulativeSpend + element.element.spend)
        cumulativeRevenue = roundedPortfolioCurrencyValue(cumulativeRevenue + element.element.revenue)
        cumulativeRealizedProfit = roundedPortfolioCurrencyValue(cumulativeRealizedProfit + element.element.realizedProfit)
        points.append(
            PortfolioLedgerCumulativeBusinessPoint(
                date: date,
                cumulativeSpend: cumulativeSpend,
                cumulativeRevenue: cumulativeRevenue,
                cumulativeRealizedProfit: cumulativeRealizedProfit
            )
        )
    }

    return points
}

extension PortfolioLedger {
    var cumulativeBusinessSeries: [PortfolioLedgerCumulativeBusinessPoint] {
        portfolioCumulativeBusinessSeries(from: dailySeries)
    }
}

private func roundedPortfolioCurrencyValue(_ value: Double) -> Double {
    (value * 100).rounded() / 100
}
