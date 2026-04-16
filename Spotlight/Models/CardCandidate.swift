import Foundation

struct SlabContext: Codable, Hashable, Sendable {
    let grader: String
    let grade: String?
    let certNumber: String?
    let variantName: String?

    var displayBadgeTitle: String {
        let normalizedGrader = grader.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedGrade = grade?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !normalizedGrader.isEmpty, !normalizedGrade.isEmpty {
            return "\(normalizedGrader) \(normalizedGrade)"
        }
        if !normalizedGrader.isEmpty {
            return normalizedGrader
        }
        let normalizedVariant = variantName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !normalizedVariant.isEmpty {
            return normalizedVariant
        }
        return "Slab"
    }
}

struct CardPricingSummary: Codable, Hashable, Sendable {
    let source: String
    let currencyCode: String
    let variant: String?
    let low: Double?
    let market: Double?
    let mid: Double?
    let high: Double?
    let directLow: Double?
    let trend: Double?
    let updatedAt: String?
    let refreshedAt: String?
    let sourceURL: String?
    let pricingMode: String?
    let snapshotAgeHours: Double?
    let freshnessWindowHours: Int?
    let isFresh: Bool?
    let grader: String?
    let grade: String?
    let pricingTier: String?
    let confidenceLabel: String?
    let confidenceLevel: Int?
    let compCount: Int?
    let recentCompCount: Int?
    let lastSoldPrice: Double?
    let lastSoldAt: String?
    let bucketKey: String?
    let methodologySummary: String?

    var sourceLabel: String {
        if source == "psa_comp_model" {
            return "PSA comps"
        }
        if source == "tcgplayer" {
            return "TCGplayer"
        }
        if source == "cardmarket" {
            return "Cardmarket"
        }
        if source == "scrydex" {
            return "Scrydex"
        }
        if source == "pricecharting" {
            return "PriceCharting"
        }
        return source.capitalized
    }

    var sourceDetailLabel: String {
        guard let variant, !variant.isEmpty else { return sourceLabel }
        return "\(sourceLabel) • \(variant)"
    }

    var primaryDisplayPrice: Double? {
        market ?? mid ?? low ?? trend
    }

    var primaryLabel: String {
        if pricingMode == "psa_grade_estimate", let grader, let grade {
            return "\(grader) \(grade)"
        }
        if market != nil { return "Market" }
        if mid != nil { return "Mid" }
        if low != nil { return "Low" }
        return "Trend"
    }

    var pricingTierLabel: String? {
        switch pricingTier {
        case "exact_same_grade":
            return "Exact same grade"
        case "same_card_grade_ladder":
            return "Nearby grades"
        case "bucket_index_model":
            return "Bucket model"
        case "scrydex_exact_grade", "pricecharting_exact_grade":
            return "Live PSA pricing"
        default:
            return nil
        }
    }

    var refreshedDate: Date? {
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: refreshedAt ?? "")
    }

    var sourceUpdatedDate: Date? {
        for formatter in Self.providerFormatters() {
            if let date = formatter.date(from: updatedAt ?? "") {
                return date
            }
        }
        return nil
    }

    var freshnessLabel: String {
        if freshnessState == .unavailable {
            return "Price unavailable"
        }
        guard let refreshedDate else {
            switch freshnessState {
            case .cached:
                return "Cached"
            case .refreshedRecently:
                return "Refreshed recently"
            case .stale:
                return "Stale snapshot"
            case .unavailable:
                return "Price unavailable"
            }
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        let relative = formatter.localizedString(for: refreshedDate, relativeTo: Date())

        switch freshnessState {
        case .cached:
            return "Cached from \(relative)"
        case .refreshedRecently:
            return "Refreshed \(relative)"
        case .stale:
            return "Stale snapshot from \(relative)"
        case .unavailable:
            return "Price unavailable"
        }
    }

    var freshnessState: PricingFreshnessState {
        guard primaryDisplayPrice != nil else { return .unavailable }
        if let isFresh {
            guard isFresh else { return .stale }
            if let snapshotAgeHours, snapshotAgeHours < 0.25 {
                return .refreshedRecently
            }
            if let refreshedDate, Date().timeIntervalSince(refreshedDate) < 15 * 60 {
                return .refreshedRecently
            }
            return .cached
        }
        guard let refreshedDate else { return .cached }
        let age = Date().timeIntervalSince(refreshedDate)
        if age < 15 * 60 { return .refreshedRecently }
        if age < 24 * 60 * 60 { return .cached }
        return .stale
    }

    var freshnessTone: PricingFreshnessTone {
        switch freshnessState {
        case .unavailable:
            return .stale
        case .cached:
            return .recent
        case .refreshedRecently:
            return .fresh
        case .stale:
            return .stale
        }
    }

    var freshnessBadgeLabel: String {
        switch freshnessState {
        case .unavailable:
            return "Unavailable"
        case .cached:
            return "Cached"
        case .refreshedRecently:
            return "Fresh"
        case .stale:
            return "Stale"
        }
    }

    var sourceUpdatedLabel: String? {
        guard let sourceUpdatedDate else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return "Provider updated \(formatter.string(from: sourceUpdatedDate))"
    }

    var spreadText: String? {
        guard let low, let high else { return nil }
        return "\(Self.formatCurrency(low, currencyCode: currencyCode)) to \(Self.formatCurrency(high, currencyCode: currencyCode))"
    }

    private static func providerFormatters() -> [DateFormatter] {
        let plain = DateFormatter()
        plain.locale = Locale(identifier: "en_US_POSIX")
        plain.dateFormat = "yyyy/MM/dd"

        let timestamp = DateFormatter()
        timestamp.locale = Locale(identifier: "en_US_POSIX")
        timestamp.dateFormat = "yyyy/MM/dd HH:mm:ss"

        return [timestamp, plain]
    }

    private static func formatCurrency(_ value: Double, currencyCode: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }
}

extension CardPricingSummary {
    func applyingMarketHistory(
        _ history: CardMarketHistory,
        fallbackVariant: String? = nil
    ) -> CardPricingSummary {
        let latestPoint = history.latestRenderablePoint
        return CardPricingSummary(
            source: history.source,
            currencyCode: history.currencyCode,
            variant: history.selectedVariant ?? fallbackVariant ?? variant,
            low: latestPoint?.low,
            market: history.primaryDisplayPrice,
            mid: latestPoint?.mid,
            high: latestPoint?.high,
            directLow: directLow,
            trend: trend,
            updatedAt: updatedAt,
            refreshedAt: history.refreshedAt ?? refreshedAt,
            sourceURL: sourceURL,
            pricingMode: history.pricingMode,
            snapshotAgeHours: nil,
            freshnessWindowHours: freshnessWindowHours,
            isFresh: history.isFresh,
            grader: grader,
            grade: grade,
            pricingTier: pricingTier,
            confidenceLabel: confidenceLabel,
            confidenceLevel: confidenceLevel,
            compCount: compCount,
            recentCompCount: recentCompCount,
            lastSoldPrice: lastSoldPrice,
            lastSoldAt: lastSoldAt,
            bucketKey: bucketKey,
            methodologySummary: methodologySummary
        )
    }
}

enum PricingFreshnessTone: Equatable {
    case fresh
    case recent
    case stale
}

enum PricingFreshnessState: Equatable {
    case unavailable
    case cached
    case refreshedRecently
    case stale
}

struct CardDetail: Codable, Hashable, Sendable {
    let card: CardCandidate
    let slabContext: SlabContext?
    let source: String?
    let sourceRecordID: String?
    let setID: String?
    let setSeries: String?
    let setReleaseDate: String?
    let supertype: String?
    let artist: String?
    let regulationMark: String?
    let imageSmallURL: String?
    let imageLargeURL: String?

    var pricing: CardPricingSummary? {
        card.pricing
    }
}

struct MarketHistoryOption: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let label: String
    let currentPrice: Double?
}

struct MarketHistoryPoint: Codable, Hashable, Sendable, Identifiable {
    let date: String
    let market: Double?
    let low: Double?
    let mid: Double?
    let high: Double?

    var id: String { date }

    var primaryValue: Double? {
        market ?? mid ?? low ?? high
    }
}

struct MarketHistoryDelta: Codable, Hashable, Sendable {
    let days: Int
    let priceChange: Double?
    let percentChange: Double?
}

struct MarketHistoryDeltas: Codable, Hashable, Sendable {
    let days7: MarketHistoryDelta?
    let days14: MarketHistoryDelta?
    let days30: MarketHistoryDelta?
}

struct CardMarketHistory: Codable, Hashable, Sendable {
    let cardID: String
    let pricingMode: String
    let currencyCode: String
    let currentPrice: Double?
    let currentDate: String?
    let points: [MarketHistoryPoint]
    let availableVariants: [MarketHistoryOption]
    let availableConditions: [MarketHistoryOption]
    let selectedVariant: String?
    let selectedCondition: String?
    let deltas: MarketHistoryDeltas
    let source: String
    let isFresh: Bool
    let refreshedAt: String?
    let livePricingEnabled: Bool

    var latestRenderablePoint: MarketHistoryPoint? {
        points.last(where: { $0.primaryValue != nil })
    }

    var primaryDisplayPrice: Double? {
        currentPrice ?? latestRenderablePoint?.primaryValue
    }

    var hasRenderablePoints: Bool {
        latestRenderablePoint != nil
    }
}

struct GradedCardCompsGradeOption: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let label: String
    let count: Int?
    let isSelected: Bool?

    var displayLabel: String {
        label.isEmpty ? id : label
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case label
        case count
        case isSelected
    }

    private enum AlternateCodingKeys: String, CodingKey {
        case grade
        case gradeID = "grade_id"
        case gradeTabID = "grade_tab_id"
        case value
        case title
        case transactionCount = "transaction_count"
        case selected
    }

    init(
        id: String,
        label: String,
        count: Int? = nil,
        isSelected: Bool? = nil
    ) {
        self.id = id
        self.label = label
        self.count = count
        self.isSelected = isSelected
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let alternateContainer = try decoder.container(keyedBy: AlternateCodingKeys.self)

        let primaryID = try container.decodeIfPresent(String.self, forKey: .id)
        let gradeID = try alternateContainer.decodeIfPresent(String.self, forKey: .grade)
        let alternateGradeID = try alternateContainer.decodeIfPresent(String.self, forKey: .gradeID)
        let gradeTabID = try alternateContainer.decodeIfPresent(String.self, forKey: .gradeTabID)
        let valueID = try alternateContainer.decodeIfPresent(String.self, forKey: .value)
        let resolvedID = primaryID
            ?? gradeID
            ?? alternateGradeID
            ?? gradeTabID
            ?? valueID
            ?? ""

        let primaryLabel = try container.decodeIfPresent(String.self, forKey: .label)
        let titleLabel = try alternateContainer.decodeIfPresent(String.self, forKey: .title)
        let fallbackLabel = resolvedID.isEmpty ? "Unknown grade" : resolvedID
        let resolvedLabel = primaryLabel ?? titleLabel ?? fallbackLabel

        id = resolvedID.isEmpty ? resolvedLabel : resolvedID
        label = resolvedLabel
        let primaryCount = try container.decodeIfPresent(Int.self, forKey: .count)
        let alternateCount = try alternateContainer.decodeIfPresent(Int.self, forKey: .transactionCount)
        count = primaryCount ?? alternateCount

        let primarySelected = try container.decodeIfPresent(Bool.self, forKey: .isSelected)
        let alternateSelected = try alternateContainer.decodeIfPresent(Bool.self, forKey: .selected)
        isSelected = primarySelected ?? alternateSelected
    }
}

struct GradedCardCompsTransaction: Codable, Hashable, Sendable, Identifiable {
    private struct PricePayload: Codable, Hashable, Sendable {
        let amount: Double?
        let currencyCode: String?
        let display: String?

        private enum CodingKeys: String, CodingKey {
            case amount
            case currencyCode
            case display
        }

        private enum AlternateCodingKeys: String, CodingKey {
            case currencyCodeSnake = "currency_code"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let alternateContainer = try decoder.container(keyedBy: AlternateCodingKeys.self)
            amount = try container.decodeIfPresent(Double.self, forKey: .amount)
            currencyCode = try container.decodeIfPresent(String.self, forKey: .currencyCode)
                ?? alternateContainer.decodeIfPresent(String.self, forKey: .currencyCodeSnake)
            display = try container.decodeIfPresent(String.self, forKey: .display)
        }
    }

    let id: String
    let title: String
    let price: Double?
    let currencyCode: String
    let soldAt: Date?
    let grade: String?
    let saleType: String?
    let listingURL: String?

    private enum CodingKeys: String, CodingKey {
        case id
        case title
        case price
        case currencyCode
        case soldAt
        case grade
        case saleType
        case listingURL
    }

    private enum AlternateCodingKeys: String, CodingKey {
        case transactionID = "transaction_id"
        case listingID = "listing_id"
        case saleID = "sale_id"
        case listingTitle = "listing_title"
        case itemTitle = "item_title"
        case name
        case salePrice = "sale_price"
        case soldPrice = "sold_price"
        case amount
        case value
        case currencyCodeSnake = "currency_code"
        case soldAtSnake = "sold_at"
        case occurredAt = "occurred_at"
        case date
        case gradeLabel = "grade_label"
        case saleTypeSnake = "sale_type"
        case transactionType = "transaction_type"
        case listingType = "listing_type"
        case type
        case listingURLSnake = "listing_url"
        case link
        case url
    }

    init(
        id: String,
        title: String,
        price: Double?,
        currencyCode: String = "USD",
        soldAt: Date?,
        grade: String? = nil,
        saleType: String? = nil,
        listingURL: String? = nil
    ) {
        self.id = id
        self.title = title
        self.price = price
        self.currencyCode = currencyCode
        self.soldAt = soldAt
        self.grade = grade
        self.saleType = saleType
        self.listingURL = listingURL
    }

    private static func parseDate(_ value: String?) -> Date? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }

        let isoDateTimeFormatter = ISO8601DateFormatter()
        isoDateTimeFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        isoDateTimeFormatter.timeZone = TimeZone(secondsFromGMT: 0)

        let isoDateFormatter = ISO8601DateFormatter()
        isoDateFormatter.formatOptions = [.withInternetDateTime]
        isoDateFormatter.timeZone = TimeZone(secondsFromGMT: 0)

        if let parsed = isoDateTimeFormatter.date(from: value) ?? isoDateFormatter.date(from: value) {
            return parsed
        }

        for format in ["yyyy-MM-dd", "MMM d, yyyy", "MMMM d, yyyy", "M/d/yyyy", "M/d/yy"] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = format
            if let parsed = formatter.date(from: value) {
                return parsed
            }
        }

        return nil
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let alternateContainer = try decoder.container(keyedBy: AlternateCodingKeys.self)

        let primaryTitle = try container.decodeIfPresent(String.self, forKey: .title)
        let listingTitle = try alternateContainer.decodeIfPresent(String.self, forKey: .listingTitle)
        let itemTitle = try alternateContainer.decodeIfPresent(String.self, forKey: .itemTitle)
        let nameTitle = try alternateContainer.decodeIfPresent(String.self, forKey: .name)
        let resolvedTitle = primaryTitle ?? listingTitle ?? itemTitle ?? nameTitle ?? "Recent sale"

        let primaryPrice = (try? container.decodeIfPresent(Double.self, forKey: .price)) ?? nil
        let nestedPrice = (try? container.decodeIfPresent(PricePayload.self, forKey: .price)) ?? nil
        let salePrice = try alternateContainer.decodeIfPresent(Double.self, forKey: .salePrice)
        let soldPrice = try alternateContainer.decodeIfPresent(Double.self, forKey: .soldPrice)
        let amountPrice = try alternateContainer.decodeIfPresent(Double.self, forKey: .amount)
        let valuePrice = try alternateContainer.decodeIfPresent(Double.self, forKey: .value)
        let resolvedPrice = primaryPrice ?? nestedPrice?.amount ?? salePrice ?? soldPrice ?? amountPrice ?? valuePrice

        let primaryCurrencyCode = try container.decodeIfPresent(String.self, forKey: .currencyCode)
        let alternateCurrencyCode = try alternateContainer.decodeIfPresent(String.self, forKey: .currencyCodeSnake)
        let resolvedCurrencyCode = primaryCurrencyCode ?? nestedPrice?.currencyCode ?? alternateCurrencyCode ?? "USD"

        let primarySoldAt = (try? container.decodeIfPresent(Date.self, forKey: .soldAt)) ?? nil
        let primarySoldAtString = try container.decodeIfPresent(String.self, forKey: .soldAt)
        let snakeSoldAt = (try? alternateContainer.decodeIfPresent(Date.self, forKey: .soldAtSnake)) ?? nil
        let snakeSoldAtString = try alternateContainer.decodeIfPresent(String.self, forKey: .soldAtSnake)
        let occurredAt = (try? alternateContainer.decodeIfPresent(Date.self, forKey: .occurredAt)) ?? nil
        let occurredAtString = try alternateContainer.decodeIfPresent(String.self, forKey: .occurredAt)
        let dateSoldAt = (try? alternateContainer.decodeIfPresent(Date.self, forKey: .date)) ?? nil
        let dateSoldAtString = try alternateContainer.decodeIfPresent(String.self, forKey: .date)
        let resolvedSoldAt = primarySoldAt
            ?? Self.parseDate(primarySoldAtString)
            ?? snakeSoldAt
            ?? Self.parseDate(snakeSoldAtString)
            ?? occurredAt
            ?? Self.parseDate(occurredAtString)
            ?? dateSoldAt
            ?? Self.parseDate(dateSoldAtString)

        let primaryGrade = try container.decodeIfPresent(String.self, forKey: .grade)
        let alternateGrade = try alternateContainer.decodeIfPresent(String.self, forKey: .gradeLabel)
        let resolvedGrade = primaryGrade ?? alternateGrade

        let primarySaleType = try container.decodeIfPresent(String.self, forKey: .saleType)
        let snakeSaleType = try alternateContainer.decodeIfPresent(String.self, forKey: .saleTypeSnake)
        let transactionType = try alternateContainer.decodeIfPresent(String.self, forKey: .transactionType)
        let listingType = try alternateContainer.decodeIfPresent(String.self, forKey: .listingType)
        let genericType = try alternateContainer.decodeIfPresent(String.self, forKey: .type)
        let resolvedSaleType = primarySaleType ?? snakeSaleType ?? transactionType ?? listingType ?? genericType

        let primaryListingURL = try container.decodeIfPresent(String.self, forKey: .listingURL)
        let snakeListingURL = try alternateContainer.decodeIfPresent(String.self, forKey: .listingURLSnake)
        let directLink = try alternateContainer.decodeIfPresent(String.self, forKey: .link)
        let alternateURL = try alternateContainer.decodeIfPresent(String.self, forKey: .url)
        let resolvedListingURL = primaryListingURL ?? snakeListingURL ?? directLink ?? alternateURL

        let primaryID = try container.decodeIfPresent(String.self, forKey: .id)
        let transactionID = try alternateContainer.decodeIfPresent(String.self, forKey: .transactionID)
        let listingID = try alternateContainer.decodeIfPresent(String.self, forKey: .listingID)
        let saleID = try alternateContainer.decodeIfPresent(String.self, forKey: .saleID)
        let fallbackID = "\(resolvedTitle)|\(resolvedSoldAt?.timeIntervalSinceReferenceDate ?? 0)|\(resolvedPrice ?? 0)"
        let resolvedID = primaryID ?? transactionID ?? listingID ?? saleID ?? fallbackID

        id = resolvedID
        title = resolvedTitle
        price = resolvedPrice
        currencyCode = resolvedCurrencyCode
        soldAt = resolvedSoldAt
        grade = resolvedGrade
        saleType = resolvedSaleType
        listingURL = resolvedListingURL
    }
}

struct GradedCardComps: Decodable, Hashable, Sendable {
    let cardID: String
    let grader: String?
    let selectedGrade: String?
    let gradeOptions: [GradedCardCompsGradeOption]
    let transactions: [GradedCardCompsTransaction]
    let currencyCode: String?
    let statusReason: String?
    let unavailableReason: String?
    let errorMessage: String?
    let isFresh: Bool?
    let refreshedAt: String?
    let searchURL: String?

    private enum CodingKeys: String, CodingKey {
        case cardID
        case grader
        case selectedGrade
        case gradeOptions
        case transactions
        case currencyCode
        case statusReason
        case unavailableReason
        case error
        case isFresh
        case refreshedAt
        case searchURL
    }

    private enum AlternateCodingKeys: String, CodingKey {
        case cardIDSnake = "card_id"
        case graderProvider = "grade_provider"
        case provider
        case selectedGradeSnake = "selected_grade"
        case selectedGradeID = "selected_grade_id"
        case availableGradeOptions
        case gradeTabs = "grade_tabs"
        case gradeTabsCamel = "gradeTabs"
        case tabs
        case recentTransactions = "recent_transactions"
        case recentTransactionsCamel = "recentTransactions"
        case recentSales = "recent_sales"
        case recentSalesCamel = "recentSales"
        case sales
        case currencyCodeSnake = "currency_code"
        case unavailableReasonSnake = "unavailable_reason"
        case statusReason
        case message
        case statusMessage = "status_message"
        case searchURLSnake = "search_url"
        case isFreshSnake = "is_fresh"
        case refreshedAtSnake = "refreshed_at"
    }

    private struct ErrorPayload: Codable, Hashable, Sendable {
        let message: String?
    }

    init(
        cardID: String,
        grader: String? = nil,
        selectedGrade: String? = nil,
        gradeOptions: [GradedCardCompsGradeOption] = [],
        transactions: [GradedCardCompsTransaction] = [],
        currencyCode: String? = nil,
        statusReason: String? = nil,
        unavailableReason: String? = nil,
        errorMessage: String? = nil,
        isFresh: Bool? = nil,
        refreshedAt: String? = nil,
        searchURL: String? = nil
    ) {
        self.cardID = cardID
        self.grader = grader
        self.selectedGrade = selectedGrade
        self.gradeOptions = gradeOptions
        self.transactions = transactions
        self.currencyCode = currencyCode
        self.statusReason = statusReason
        self.unavailableReason = unavailableReason
        self.errorMessage = errorMessage
        self.isFresh = isFresh
        self.refreshedAt = refreshedAt
        self.searchURL = searchURL
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let alternateContainer = try decoder.container(keyedBy: AlternateCodingKeys.self)

        let primaryCardID = try container.decodeIfPresent(String.self, forKey: .cardID)
        let alternateCardID = try alternateContainer.decodeIfPresent(String.self, forKey: .cardIDSnake)
        cardID = primaryCardID ?? alternateCardID ?? ""

        let primaryGrader = try container.decodeIfPresent(String.self, forKey: .grader)
        let providerGrader = try alternateContainer.decodeIfPresent(String.self, forKey: .graderProvider)
        let alternateProvider = try alternateContainer.decodeIfPresent(String.self, forKey: .provider)
        grader = primaryGrader ?? providerGrader ?? alternateProvider

        let primarySelectedGrade = try container.decodeIfPresent(String.self, forKey: .selectedGrade)
        let snakeSelectedGrade = try alternateContainer.decodeIfPresent(String.self, forKey: .selectedGradeSnake)
        let alternateSelectedGrade = try alternateContainer.decodeIfPresent(String.self, forKey: .selectedGradeID)
        selectedGrade = primarySelectedGrade ?? snakeSelectedGrade ?? alternateSelectedGrade

        let primaryGradeOptions = try container.decodeIfPresent([GradedCardCompsGradeOption].self, forKey: .gradeOptions)
        let availableGradeOptions = try alternateContainer.decodeIfPresent([GradedCardCompsGradeOption].self, forKey: .availableGradeOptions)
        let snakeGradeOptions = try alternateContainer.decodeIfPresent([GradedCardCompsGradeOption].self, forKey: .gradeTabs)
        let camelGradeOptions = try alternateContainer.decodeIfPresent([GradedCardCompsGradeOption].self, forKey: .gradeTabsCamel)
        let tabGradeOptions = try alternateContainer.decodeIfPresent([GradedCardCompsGradeOption].self, forKey: .tabs)
        gradeOptions = primaryGradeOptions ?? availableGradeOptions ?? snakeGradeOptions ?? camelGradeOptions ?? tabGradeOptions ?? []

        let primaryTransactions = try container.decodeIfPresent([GradedCardCompsTransaction].self, forKey: .transactions)
        let recentTransactions = try alternateContainer.decodeIfPresent([GradedCardCompsTransaction].self, forKey: .recentTransactions)
        let recentTransactionsCamel = try alternateContainer.decodeIfPresent([GradedCardCompsTransaction].self, forKey: .recentTransactionsCamel)
        let recentSales = try alternateContainer.decodeIfPresent([GradedCardCompsTransaction].self, forKey: .recentSales)
        let recentSalesCamel = try alternateContainer.decodeIfPresent([GradedCardCompsTransaction].self, forKey: .recentSalesCamel)
        let sales = try alternateContainer.decodeIfPresent([GradedCardCompsTransaction].self, forKey: .sales)
        transactions = primaryTransactions ?? recentTransactions ?? recentTransactionsCamel ?? recentSales ?? recentSalesCamel ?? sales ?? []

        let primaryCurrencyCode = try container.decodeIfPresent(String.self, forKey: .currencyCode)
        let alternateCurrencyCode = try alternateContainer.decodeIfPresent(String.self, forKey: .currencyCodeSnake)
        currencyCode = primaryCurrencyCode ?? alternateCurrencyCode

        let primaryStatusReason = try container.decodeIfPresent(String.self, forKey: .statusReason)
        let alternateStatusReason = try alternateContainer.decodeIfPresent(String.self, forKey: .statusReason)
        statusReason = primaryStatusReason ?? alternateStatusReason

        let errorPayload = try container.decodeIfPresent(ErrorPayload.self, forKey: .error)
        errorMessage = errorPayload?.message

        let primaryUnavailableReason = try container.decodeIfPresent(String.self, forKey: .unavailableReason)
        let snakeUnavailableReason = try alternateContainer.decodeIfPresent(String.self, forKey: .unavailableReasonSnake)
        let messageUnavailableReason = try alternateContainer.decodeIfPresent(String.self, forKey: .message)
        let legacyStatusUnavailableReason = try alternateContainer.decodeIfPresent(String.self, forKey: .statusMessage)
        unavailableReason = primaryUnavailableReason
            ?? snakeUnavailableReason
            ?? errorMessage
            ?? messageUnavailableReason
            ?? legacyStatusUnavailableReason
            ?? statusReason

        let primaryIsFresh = try container.decodeIfPresent(Bool.self, forKey: .isFresh)
        let alternateIsFresh = try alternateContainer.decodeIfPresent(Bool.self, forKey: .isFreshSnake)
        isFresh = primaryIsFresh ?? alternateIsFresh

        let primaryRefreshedAt = try container.decodeIfPresent(String.self, forKey: .refreshedAt)
        let alternateRefreshedAt = try alternateContainer.decodeIfPresent(String.self, forKey: .refreshedAtSnake)
        refreshedAt = primaryRefreshedAt ?? alternateRefreshedAt

        let primarySearchURL = try container.decodeIfPresent(String.self, forKey: .searchURL)
        let alternateSearchURL = try alternateContainer.decodeIfPresent(String.self, forKey: .searchURLSnake)
        searchURL = primarySearchURL ?? alternateSearchURL
    }
}

struct CardCandidate: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let name: String
    let setName: String
    let number: String
    let rarity: String
    let variant: String
    let language: String
    let imageSmallURL: String?
    let imageLargeURL: String?
    let pricing: CardPricingSummary?

    var subtitle: String {
        "\(setName) • \(number)"
    }

    var detailLine: String {
        "\(rarity) • \(variant) • \(language)"
    }

    var pricingLine: String? {
        guard let pricing, let primaryPrice = pricing.primaryDisplayPrice else { return nil }
        return "\(pricing.primaryLabel) \(formattedPrice(primaryPrice, currencyCode: pricing.currencyCode)) • \(pricing.sourceLabel)"
    }

    private func formattedPrice(_ value: Double, currencyCode: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }
}

enum CardMarketplaceLinks {
    static func tcgPlayerSearchURL(card: CardCandidate, slabContext: SlabContext?) -> URL? {
        searchURL(
            baseURL: "https://www.tcgplayer.com/search/pokemon/product",
            queryItems: [
                URLQueryItem(name: "q", value: tcgPlayerSearchQuery(card: card)),
                URLQueryItem(name: "view", value: "grid")
            ]
        )
    }

    static func eBaySearchURL(card: CardCandidate, slabContext: SlabContext?) -> URL? {
        searchURL(
            baseURL: "https://www.ebay.com/sch/i.html",
            queryItems: [
                URLQueryItem(name: "_nkw", value: eBaySearchQuery(card: card, slabContext: slabContext))
            ]
        )
    }

    private static func tcgPlayerSearchQuery(card: CardCandidate) -> String {
        let setToken = cleanedToken(card.setName)
        let numberToken = cleanedToken(card.number.replacingOccurrences(of: "#", with: ""))
        return [card.name, numberToken, setToken]
            .compactMap(cleanedToken)
            .joined(separator: " ")
    }

    private static func eBaySearchQuery(card: CardCandidate, slabContext: SlabContext?) -> String {
        let numberToken = cleanedToken(card.number.replacingOccurrences(of: "#", with: ""))
        let setToken = cleanedToken(card.setName)
        let graderToken = slabContext?.grader
        let gradeToken = slabContext?.grade
        let certToken = slabContext?.certNumber

        return [card.name, numberToken, setToken, graderToken, gradeToken, certToken]
            .compactMap(cleanedToken)
            .joined(separator: " ")
    }

    private static func cleanedToken(_ token: String?) -> String? {
        guard let token else {
            return nil
        }

        let trimmed = token
            .replacingOccurrences(of: "•", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func searchURL(baseURL: String, queryItems: [URLQueryItem]) -> URL? {
        guard var components = URLComponents(string: baseURL) else {
            return nil
        }
        components.queryItems = queryItems
        return components.url
    }
}

struct ScoredCandidate: Identifiable, Codable, Hashable, Sendable {
    let rank: Int
    let candidate: CardCandidate
    let imageScore: Double
    let collectorNumberScore: Double
    let nameScore: Double
    let finalScore: Double

    var id: String { candidate.id }
}

enum MatchConfidence: String, Codable, Hashable, Sendable {
    case high
    case medium
    case low

    var title: String {
        rawValue.capitalized
    }
}

enum MatcherSource: String, Codable, Hashable, Sendable {
    case remotePrototype
    case remoteHybrid
}
