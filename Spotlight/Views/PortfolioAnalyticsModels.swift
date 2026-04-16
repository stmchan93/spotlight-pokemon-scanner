import Foundation

enum PortfolioInventoryFilter: String, CaseIterable, Identifiable {
    case all
    case raw
    case graded

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .all:
            return "All"
        case .raw:
            return "Raw"
        case .graded:
            return "Graded"
        }
    }

    var compactLabel: String {
        switch self {
        case .all:
            return "All"
        case .raw:
            return "Raw"
        case .graded:
            return "Graded"
        }
    }

    func matches(_ entry: DeckCardEntry) -> Bool {
        switch self {
        case .all:
            return true
        case .raw:
            return entry.slabContext == nil
        case .graded:
            return entry.slabContext != nil
        }
    }
}

enum PortfolioPriceCalculatorPreset: String, CaseIterable, Identifiable {
    case market
    case list
    case percentOff
    case dollarOff
    case eightyPercent

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .market:
            return "Market"
        case .list:
            return "List"
        case .percentOff:
            return "% Off"
        case .dollarOff:
            return "$ Off"
        case .eightyPercent:
            return "80%"
        }
    }
}

struct PortfolioHistoryLineSeries: Hashable {
    enum Kind: String, Hashable {
        case market
        case costBasis
    }

    let kind: Kind
    let label: String
    let values: [Double?]
}

func usablePortfolioHistoryPoints(_ history: PortfolioHistory?) -> [PortfolioHistoryPoint] {
    guard let history else { return [] }
    let points = history.points
    guard points.contains(where: { $0.pricedCardCount > 0 }) else {
        return []
    }
    return points
}

func chartDragShouldScrub(translation: CGSize) -> Bool {
    abs(translation.width) > abs(translation.height)
}

func filteredPortfolioEntries(
    _ entries: [DeckCardEntry],
    searchQuery: String,
    filter: PortfolioInventoryFilter
) -> [DeckCardEntry] {
    let normalizedQuery = searchQuery
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()

    return entries.filter { entry in
        filter.matches(entry) && (
            normalizedQuery.isEmpty ||
            entry.searchIndexText.contains(normalizedQuery)
        )
    }
}

func portfolioHistoryLineSeries(for history: PortfolioHistory?) -> [PortfolioHistoryLineSeries] {
    let points = usablePortfolioHistoryPoints(history)
    guard !points.isEmpty else { return [] }

    return [
        PortfolioHistoryLineSeries(
            kind: .market,
            label: "Market value",
            values: points.map { $0.marketValue ?? $0.totalValue }
        ),
        PortfolioHistoryLineSeries(
            kind: .costBasis,
            label: "Bought-in / cost basis",
            values: points.map { $0.costBasisValue }
        )
    ]
}

func portfolioCurrentMarketValue(from history: PortfolioHistory?, fallbackValue: Double) -> Double {
    history?.summary.currentValue ?? fallbackValue
}

func portfolioCurrentCostBasisValue(from history: PortfolioHistory?, fallbackEntries: [DeckCardEntry]) -> Double {
    if let currentCostBasisValue = history?.summary.currentCostBasisValue {
        return currentCostBasisValue
    }
    return fallbackEntries.reduce(0) { partialResult, entry in
        partialResult + max(0, entry.costBasisTotal)
    }
}

func portfolioDiscountedPrice(from marketPrice: Double, percentOff: Double) -> Double {
    max(0, marketPrice * max(0, 1 - (percentOff / 100)))
}

func portfolioPriceAfterDollarOff(from marketPrice: Double, dollarOff: Double) -> Double {
    max(0, marketPrice - max(0, dollarOff))
}

func portfolioEightyPercentPrice(from marketPrice: Double) -> Double {
    max(0, marketPrice * 0.8)
}

func portfolioResolvedCalculatorPrice(
    marketPrice: Double,
    listPrice: Double,
    percentOff: Double,
    dollarOff: Double,
    preset: PortfolioPriceCalculatorPreset
) -> Double {
    switch preset {
    case .market:
        return max(0, marketPrice)
    case .list:
        return max(0, listPrice > 0 ? listPrice : marketPrice)
    case .percentOff:
        return portfolioDiscountedPrice(from: marketPrice, percentOff: percentOff)
    case .dollarOff:
        return portfolioPriceAfterDollarOff(from: marketPrice, dollarOff: dollarOff)
    case .eightyPercent:
        return portfolioEightyPercentPrice(from: marketPrice)
    }
}
