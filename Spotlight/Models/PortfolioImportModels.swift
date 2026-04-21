import Foundation

enum PortfolioImportSourceType: String, CaseIterable, Codable, Hashable, Sendable, Identifiable {
    case collectrCSVV1 = "collectr_csv_v1"
    case tcgplayerCSVV1 = "tcgplayer_csv_v1"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .collectrCSVV1:
            return "Collectr"
        case .tcgplayerCSVV1:
            return "TCGplayer"
        }
    }

    var subtitle: String {
        switch self {
        case .collectrCSVV1:
            return "Best if your collection already lives in Collectr."
        case .tcgplayerCSVV1:
            return "Use your TCGplayer CSV export and review it before import."
        }
    }

    var buttonTitle: String {
        switch self {
        case .collectrCSVV1:
            return "Import from Collectr"
        case .tcgplayerCSVV1:
            return "Import from TCGplayer"
        }
    }

    var reviewTitle: String {
        switch self {
        case .collectrCSVV1:
            return "Collectr Import"
        case .tcgplayerCSVV1:
            return "TCGplayer Import"
        }
    }
}

struct PortfolioImportSelectedFile: Identifiable, Hashable, Sendable {
    let id: UUID
    let sourceType: PortfolioImportSourceType
    let fileName: String
    let csvText: String

    init(
        id: UUID = UUID(),
        sourceType: PortfolioImportSourceType,
        fileName: String,
        csvText: String
    ) {
        self.id = id
        self.sourceType = sourceType
        self.fileName = fileName
        self.csvText = csvText
    }
}

enum PortfolioImportJobStatus: String, Codable, Hashable, Sendable {
    case previewing
    case needsReview = "needs_review"
    case ready
    case committing
    case completed
    case failed
    case unknown

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = (try? container.decode(String.self))?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        switch rawValue {
        case "previewing", "pending", "parsing", "preview_building":
            self = .previewing
        case "needs_review", "review", "in_review", "commit_partial":
            self = .needsReview
        case "ready", "ready_to_commit", "preview_ready":
            self = .ready
        case "committing":
            self = .committing
        case "completed", "committed":
            self = .completed
        case "failed", "error":
            self = .failed
        default:
            self = .unknown
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    var title: String {
        switch self {
        case .previewing:
            return "Previewing"
        case .needsReview:
            return "Needs review"
        case .ready:
            return "Ready"
        case .committing:
            return "Importing"
        case .completed:
            return "Imported"
        case .failed:
            return "Failed"
        case .unknown:
            return "Unknown"
        }
    }
}

enum PortfolioImportRowState: String, Codable, Hashable, Sendable {
    case matched
    case review
    case unresolved
    case unsupported
    case skipped
    case ready
    case committed
    case failed
    case unknown

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = (try? container.decode(String.self))?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        switch rawValue {
        case "matched", "exact_match":
            self = .matched
        case "review", "ambiguous", "needs_review":
            self = .review
        case "unresolved", "missing":
            self = .unresolved
        case "unsupported":
            self = .unsupported
        case "skipped":
            self = .skipped
        case "ready", "ready_to_commit", "resolved":
            self = .ready
        case "committed", "imported":
            self = .committed
        case "failed", "error":
            self = .failed
        default:
            self = .unknown
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    var title: String {
        switch self {
        case .matched:
            return "Matched"
        case .review:
            return "Review"
        case .unresolved:
            return "Unresolved"
        case .unsupported:
            return "Unsupported"
        case .skipped:
            return "Skipped"
        case .ready:
            return "Ready"
        case .committed:
            return "Imported"
        case .failed:
            return "Failed"
        case .unknown:
            return "Unknown"
        }
    }

    var isReadyToCommit: Bool {
        switch self {
        case .matched, .ready:
            return true
        case .review, .unresolved, .unsupported, .skipped, .committed, .failed, .unknown:
            return false
        }
    }

    var needsResolution: Bool {
        switch self {
        case .review, .unresolved, .failed, .unknown:
            return true
        case .matched, .unsupported, .skipped, .ready, .committed:
            return false
        }
    }
}

enum PortfolioImportResolveAction: String, Codable, Hashable, Sendable {
    case match
    case skip
}

enum PortfolioImportRowFilter: String, CaseIterable, Hashable, Sendable, Identifiable {
    case all
    case ready
    case review
    case unresolved
    case unsupported
    case committed

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all:
            return "All"
        case .ready:
            return "Ready"
        case .review:
            return "Review"
        case .unresolved:
            return "Missing"
        case .unsupported:
            return "Unsupported"
        case .committed:
            return "Imported"
        }
    }
}

struct PortfolioImportPreviewRequestPayload: Codable, Hashable, Sendable {
    let sourceType: PortfolioImportSourceType
    let fileName: String
    let csvText: String
}

struct PortfolioImportResolveRequestPayload: Encodable, Hashable, Sendable {
    let rowID: String
    let action: PortfolioImportResolveAction
    let matchedCardID: String?

    init(
        rowID: String,
        action: PortfolioImportResolveAction,
        matchedCardID: String? = nil
    ) {
        self.rowID = rowID
        self.action = action
        self.matchedCardID = matchedCardID
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(rowID, forKey: .rowID)
        switch action {
        case .match:
            try container.encodeIfPresent(matchedCardID, forKey: .cardID)
        case .skip:
            try container.encode(true, forKey: .skip)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case rowID
        case cardID
        case skip
    }
}

struct PortfolioImportSummaryPayload: Decodable, Hashable, Sendable {
    let totalRowCount: Int
    let matchedCount: Int
    let reviewCount: Int
    let unresolvedCount: Int
    let unsupportedCount: Int
    let readyToCommitCount: Int
    let committedCount: Int
    let skippedCount: Int

    static let empty = PortfolioImportSummaryPayload(
        totalRowCount: 0,
        matchedCount: 0,
        reviewCount: 0,
        unresolvedCount: 0,
        unsupportedCount: 0,
        readyToCommitCount: 0,
        committedCount: 0,
        skippedCount: 0
    )

    private enum CodingKeys: String, CodingKey {
        case totalRowCount
        case rowCount
        case matchedCount
        case reviewCount
        case ambiguousCount
        case unresolvedCount
        case unsupportedCount
        case readyToCommitCount
        case readyCount
        case committedCount
        case skippedCount
    }

    init(
        totalRowCount: Int,
        matchedCount: Int,
        reviewCount: Int,
        unresolvedCount: Int,
        unsupportedCount: Int,
        readyToCommitCount: Int,
        committedCount: Int,
        skippedCount: Int
    ) {
        self.totalRowCount = totalRowCount
        self.matchedCount = matchedCount
        self.reviewCount = reviewCount
        self.unresolvedCount = unresolvedCount
        self.unsupportedCount = unsupportedCount
        self.readyToCommitCount = readyToCommitCount
        self.committedCount = committedCount
        self.skippedCount = skippedCount
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        totalRowCount = try container.decodeIfPresent(Int.self, forKey: .totalRowCount)
            ?? container.decodeIfPresent(Int.self, forKey: .rowCount)
            ?? 0
        matchedCount = try container.decodeIfPresent(Int.self, forKey: .matchedCount) ?? 0
        reviewCount = try container.decodeIfPresent(Int.self, forKey: .reviewCount)
            ?? container.decodeIfPresent(Int.self, forKey: .ambiguousCount)
            ?? 0
        unresolvedCount = try container.decodeIfPresent(Int.self, forKey: .unresolvedCount) ?? 0
        unsupportedCount = try container.decodeIfPresent(Int.self, forKey: .unsupportedCount) ?? 0
        readyToCommitCount = try container.decodeIfPresent(Int.self, forKey: .readyToCommitCount)
            ?? container.decodeIfPresent(Int.self, forKey: .readyCount)
            ?? 0
        committedCount = try container.decodeIfPresent(Int.self, forKey: .committedCount) ?? 0
        skippedCount = try container.decodeIfPresent(Int.self, forKey: .skippedCount) ?? 0
    }
}

struct PortfolioImportRowPayload: Decodable, Hashable, Sendable, Identifiable {
    let id: String
    let rowIndex: Int
    let sourceCollectionName: String?
    let sourceCardName: String
    let setName: String?
    let collectorNumber: String?
    let quantity: Int
    let conditionLabel: String?
    let currencyCode: String?
    let acquisitionUnitPrice: Double?
    let marketUnitPrice: Double?
    let matchState: PortfolioImportRowState
    let matchStrategy: String?
    let matchedCard: CardCandidate?
    let candidateCards: [CardCandidate]
    let warnings: [String]
    let rawSummary: String?

    private enum CodingKeys: String, CodingKey {
        case id
        case rowID
        case rowIndex
        case sourceCollectionName
        case sourceCardName
        case cardName
        case setName
        case collectorNumber
        case quantity
        case conditionLabel
        case condition
        case currencyCode
        case acquisitionUnitPrice
        case marketUnitPrice
        case matchState
        case matchStatus
        case matchStrategy
        case matchedCard
        case candidateCards
        case warnings
        case rawSummary
        case errorText
        case normalizedRow
    }

    private struct NormalizedRowPayload: Codable, Hashable, Sendable {
        let cardName: String?
        let setName: String?
        let collectorNumber: String?
        let sourceCondition: String?
    }

    init(
        id: String,
        rowIndex: Int,
        sourceCollectionName: String?,
        sourceCardName: String,
        setName: String?,
        collectorNumber: String?,
        quantity: Int,
        conditionLabel: String?,
        currencyCode: String?,
        acquisitionUnitPrice: Double?,
        marketUnitPrice: Double?,
        matchState: PortfolioImportRowState,
        matchStrategy: String?,
        matchedCard: CardCandidate?,
        candidateCards: [CardCandidate],
        warnings: [String],
        rawSummary: String?
    ) {
        self.id = id
        self.rowIndex = rowIndex
        self.sourceCollectionName = sourceCollectionName
        self.sourceCardName = sourceCardName
        self.setName = setName
        self.collectorNumber = collectorNumber
        self.quantity = quantity
        self.conditionLabel = conditionLabel
        self.currencyCode = currencyCode
        self.acquisitionUnitPrice = acquisitionUnitPrice
        self.marketUnitPrice = marketUnitPrice
        self.matchState = matchState
        self.matchStrategy = matchStrategy
        self.matchedCard = matchedCard
        self.candidateCards = candidateCards
        self.warnings = warnings
        self.rawSummary = rawSummary
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let normalizedRow = try container.decodeIfPresent(NormalizedRowPayload.self, forKey: .normalizedRow)

        id = try container.decodeIfPresent(String.self, forKey: .id)
            ?? container.decodeIfPresent(String.self, forKey: .rowID)
            ?? UUID().uuidString
        rowIndex = try container.decodeIfPresent(Int.self, forKey: .rowIndex) ?? 0
        sourceCollectionName = try container.decodeIfPresent(String.self, forKey: .sourceCollectionName)
        sourceCardName = try container.decodeIfPresent(String.self, forKey: .sourceCardName)
            ?? container.decodeIfPresent(String.self, forKey: .cardName)
            ?? normalizedRow?.cardName
            ?? ""
        setName = try container.decodeIfPresent(String.self, forKey: .setName)
            ?? normalizedRow?.setName
        collectorNumber = try container.decodeIfPresent(String.self, forKey: .collectorNumber)
            ?? normalizedRow?.collectorNumber
        quantity = try container.decodeIfPresent(Int.self, forKey: .quantity) ?? 1
        conditionLabel = try container.decodeIfPresent(String.self, forKey: .conditionLabel)
            ?? container.decodeIfPresent(String.self, forKey: .condition)
            ?? normalizedRow?.sourceCondition
        currencyCode = try container.decodeIfPresent(String.self, forKey: .currencyCode)
        acquisitionUnitPrice = try container.decodeIfPresent(Double.self, forKey: .acquisitionUnitPrice)
        marketUnitPrice = try container.decodeIfPresent(Double.self, forKey: .marketUnitPrice)
        matchState = try container.decodeIfPresent(PortfolioImportRowState.self, forKey: .matchState)
            ?? container.decodeIfPresent(PortfolioImportRowState.self, forKey: .matchStatus)
            ?? .unknown
        matchStrategy = try container.decodeIfPresent(String.self, forKey: .matchStrategy)
        matchedCard = try container.decodeIfPresent(CardCandidate.self, forKey: .matchedCard)
        candidateCards = try container.decodeIfPresent([CardCandidate].self, forKey: .candidateCards) ?? []
        var decodedWarnings = try container.decodeIfPresent([String].self, forKey: .warnings) ?? []
        if let errorText = try container.decodeIfPresent(String.self, forKey: .errorText), !errorText.isEmpty, !decodedWarnings.contains(errorText) {
            decodedWarnings.append(errorText)
        }
        warnings = decodedWarnings
        rawSummary = try container.decodeIfPresent(String.self, forKey: .rawSummary)
    }

    var displayTitle: String {
        let trimmed = sourceCardName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Row \(max(1, rowIndex))" : trimmed
    }

    var detailLine: String {
        [
            setName?.trimmingCharacters(in: .whitespacesAndNewlines),
            collectorNumber?.trimmingCharacters(in: .whitespacesAndNewlines),
            conditionLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
        ]
        .compactMap { value in
            guard let value, !value.isEmpty else { return nil }
            return value
        }
        .joined(separator: " • ")
    }

    var priceLine: String? {
        if let acquisitionUnitPrice {
            return "Cost \(Self.formatCurrency(acquisitionUnitPrice, currencyCode: currencyCode ?? "USD"))"
        }
        if let marketUnitPrice {
            return "Market \(Self.formatCurrency(marketUnitPrice, currencyCode: currencyCode ?? "USD"))"
        }
        return nil
    }

    var canResolve: Bool {
        matchState.needsResolution || matchState.isReadyToCommit
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

struct PortfolioImportJobPayload: Decodable, Hashable, Sendable, Identifiable {
    let id: String
    let sourceType: PortfolioImportSourceType
    let status: PortfolioImportJobStatus
    let sourceFileName: String
    let summary: PortfolioImportSummaryPayload
    let rows: [PortfolioImportRowPayload]
    let warnings: [String]
    let errorText: String?

    private enum CodingKeys: String, CodingKey {
        case id
        case jobID
        case sourceType
        case status
        case sourceFileName
        case fileName
        case summary
        case rows
        case warnings
        case errorText
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id)
            ?? container.decodeIfPresent(String.self, forKey: .jobID)
            ?? UUID().uuidString
        sourceType = try container.decode(PortfolioImportSourceType.self, forKey: .sourceType)
        status = try container.decodeIfPresent(PortfolioImportJobStatus.self, forKey: .status) ?? .unknown
        sourceFileName = try container.decodeIfPresent(String.self, forKey: .sourceFileName)
            ?? container.decodeIfPresent(String.self, forKey: .fileName)
            ?? ""
        summary = try container.decodeIfPresent(PortfolioImportSummaryPayload.self, forKey: .summary) ?? .empty
        rows = try container.decodeIfPresent([PortfolioImportRowPayload].self, forKey: .rows) ?? []
        warnings = try container.decodeIfPresent([String].self, forKey: .warnings) ?? []
        errorText = try container.decodeIfPresent(String.self, forKey: .errorText)
    }
}

struct PortfolioImportCommitResponsePayload: Decodable, Hashable, Sendable {
    let jobID: String
    let status: PortfolioImportJobStatus
    let summary: PortfolioImportSummaryPayload
    let job: PortfolioImportJobPayload?
    let message: String?

    private enum CodingKeys: String, CodingKey {
        case jobID
        case status
        case summary
        case job
        case message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobID = try container.decode(String.self, forKey: .jobID)
        status = try container.decodeIfPresent(PortfolioImportJobStatus.self, forKey: .status) ?? .unknown
        summary = try container.decodeIfPresent(PortfolioImportSummaryPayload.self, forKey: .summary) ?? .empty
        job = try container.decodeIfPresent(PortfolioImportJobPayload.self, forKey: .job)
        if let explicitMessage = try container.decodeIfPresent(String.self, forKey: .message), !explicitMessage.isEmpty {
            message = explicitMessage
        } else if summary.committedCount > 0 {
            message = "Imported \(summary.committedCount) row\(summary.committedCount == 1 ? "" : "s")."
        } else {
            message = nil
        }
    }
}
