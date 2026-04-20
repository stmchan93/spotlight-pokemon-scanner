import SwiftUI

enum PortfolioSortChoice: String, CaseIterable, Identifiable {
    case recentlyAdded
    case highestValue
    case alphabetical

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .recentlyAdded:
            return "Recently added"
        case .highestValue:
            return "Highest value"
        case .alphabetical:
            return "A-Z"
        }
    }

    var compactLabel: String {
        switch self {
        case .recentlyAdded:
            return "Recent"
        case .highestValue:
            return "Value"
        case .alphabetical:
            return "A-Z"
        }
    }
}

typealias DeckSortOption = PortfolioSortChoice

func sortedDeckEntries(_ entries: [DeckCardEntry], by sortOption: DeckSortOption) -> [DeckCardEntry] {
    sortedPortfolioEntries(entries, by: sortOption)
}

func sortedPortfolioEntries(_ entries: [DeckCardEntry], by sortOption: PortfolioSortChoice) -> [DeckCardEntry] {
    entries.sorted { lhs, rhs in
        switch sortOption {
        case .recentlyAdded:
            if lhs.addedAt != rhs.addedAt {
                return lhs.addedAt > rhs.addedAt
            }
            return lhs.card.name.localizedCaseInsensitiveCompare(rhs.card.name) == .orderedAscending
        case .highestValue:
            let lhsValue = lhs.totalEntryValue ?? lhs.primaryPrice ?? -1
            let rhsValue = rhs.totalEntryValue ?? rhs.primaryPrice ?? -1
            if lhsValue != rhsValue {
                return lhsValue > rhsValue
            }
            return lhs.card.name.localizedCaseInsensitiveCompare(rhs.card.name) == .orderedAscending
        case .alphabetical:
            let comparison = lhs.card.name.localizedCaseInsensitiveCompare(rhs.card.name)
            if comparison != .orderedSame {
                return comparison == .orderedAscending
            }
            return lhs.addedAt > rhs.addedAt
        }
    }
}

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
    return history.points
}

func portfolioHasUsableHistory(_ history: PortfolioHistory?) -> Bool {
    !usablePortfolioHistoryPoints(history).isEmpty
}

func latestPricedPortfolioHistoryPointIndex(in points: [PortfolioHistoryPoint]) -> Int? {
    points.indices.last
}

func resolvedPortfolioHistorySelectionIndex(
    selectedPointIndex: Int?,
    history: PortfolioHistory?
) -> Int? {
    let points = usablePortfolioHistoryPoints(history)
    guard !points.isEmpty else { return nil }

    if let selectedPointIndex,
       points.indices.contains(selectedPointIndex) {
        return selectedPointIndex
    }

    return latestPricedPortfolioHistoryPointIndex(in: points) ?? points.indices.last
}

func chartDragShouldScrub(translation: CGSize) -> Bool {
    let horizontal = abs(translation.width)
    let vertical = abs(translation.height)
    guard horizontal >= 6 else { return false }
    return horizontal >= vertical * 0.75
}

func portfolioSwipeShouldOpenScanner(
    startLocation: CGPoint,
    translation: CGSize,
    minimumHorizontalTravel: CGFloat = 56,
    edgeActivationWidth: CGFloat = 96,
    containerWidth: CGFloat = 390
) -> Bool {
    guard startLocation.x >= containerWidth - edgeActivationWidth else { return false }
    guard abs(translation.width) > abs(translation.height) else { return false }
    guard translation.width <= -minimumHorizontalTravel else { return false }
    return true
}

func portfolioDragShouldBlockHorizontalPageSwipe(
    translation: CGSize,
    minimumVerticalTravel: CGFloat = 10,
    dominancePadding: CGFloat = 6
) -> Bool {
    let verticalTravel = abs(translation.height)
    let horizontalTravel = abs(translation.width)
    guard verticalTravel >= minimumVerticalTravel else { return false }
    return verticalTravel > horizontalTravel + dominancePadding
}

func portfolioInventoryBrowserLaunchSelectionState(
    startsInSelectionMode: Bool,
    initialSelectedEntryID: String?
) -> (isSelectionMode: Bool, selectedEntryIDs: Set<String>) {
    guard startsInSelectionMode else {
        return (false, [])
    }

    let normalizedEntryID = initialSelectedEntryID?
        .trimmingCharacters(in: .whitespacesAndNewlines)

    if let normalizedEntryID, !normalizedEntryID.isEmpty {
        return (true, [normalizedEntryID])
    }

    return (true, [])
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

func portfolioArtworkURLsToPrefetch(
    _ entries: [DeckCardEntry],
    limit: Int = 18
) -> [URL] {
    guard limit > 0 else { return [] }

    var urls: [URL] = []
    var seenURLs: Set<URL> = []

    for entry in entries {
        let rawURLString = (entry.card.imageSmallURL ?? entry.card.imageLargeURL)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let rawURLString,
              let url = URL(string: rawURLString),
              seenURLs.insert(url).inserted else {
            continue
        }
        urls.append(url)
        if urls.count >= limit {
            break
        }
    }

    return urls
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
    ]
}

struct PortfolioHoverDelta: Equatable {
    let baselineValue: Double
    let hoveredValue: Double
    let deltaDollar: Double
    let deltaPercent: Double
}

func portfolioRangeHoverDelta(
    points: [PortfolioHistoryPoint],
    hoveredIndex: Int?
) -> PortfolioHoverDelta? {
    guard !points.isEmpty else { return nil }

    let safeIndex: Int = {
        guard let hoveredIndex else {
            return points.count - 1
        }
        return min(max(hoveredIndex, 0), points.count - 1)
    }()

    let baselineValue = points[0].marketValue ?? points[0].totalValue
    let hoveredValue = points[safeIndex].marketValue ?? points[safeIndex].totalValue
    let deltaDollar = ((hoveredValue - baselineValue) * 100).rounded() / 100
    let deltaPercent: Double = {
        guard let percentBaselineIndex = points.firstIndex(where: {
            let value = $0.marketValue ?? $0.totalValue
            return $0.pricedCardCount > 0 && value > 0
        }) else {
            return 0
        }

        guard safeIndex > percentBaselineIndex else {
            return 0
        }

        let percentBaselineValue = points[percentBaselineIndex].marketValue
            ?? points[percentBaselineIndex].totalValue
        guard percentBaselineValue != 0 else {
            return 0
        }

        let rawPercent = ((hoveredValue - percentBaselineValue) / percentBaselineValue) * 100.0
        return (rawPercent * 10_000).rounded() / 10_000
    }()

    return PortfolioHoverDelta(
        baselineValue: baselineValue,
        hoveredValue: hoveredValue,
        deltaDollar: deltaDollar,
        deltaPercent: deltaPercent
    )
}

func portfolioSinglePricedHistoryDisplay(
    history: PortfolioHistory?,
    size: CGSize,
    horizontalPadding: CGFloat = 14,
    verticalPadding: CGFloat = 20
) -> (points: [CGPoint], selectionPoint: CGPoint)? {
    guard let history else { return nil }

    let pricedPoints = usablePortfolioHistoryPoints(history)
    guard pricedPoints.count == 1,
          let pricedPoint = pricedPoints.first else {
        return nil
    }

    let value = pricedPoint.marketValue ?? pricedPoint.totalValue
    guard value > 0 else {
        return nil
    }

    let allPoints = history.points
    let pointCount = max(allPoints.count, 1)
    let pricedIndex = allPoints.firstIndex(where: { $0.date == pricedPoint.date }) ?? max(0, pointCount - 1)

    let width = max(1, size.width - horizontalPadding * 2)
    let height = max(1, size.height - verticalPadding * 2)
    let baselineY = size.height - verticalPadding
    let upperBound = max(value * 1.15, 1)
    let normalized = min(max(value / upperBound, 0), 1)
    let xStep = pointCount > 1 ? width / CGFloat(pointCount - 1) : 0
    let actualX = pointCount > 1
        ? horizontalPadding + CGFloat(pricedIndex) * xStep
        : size.width - horizontalPadding
    let actualY = verticalPadding + (1 - CGFloat(normalized)) * height
    let actualPoint = CGPoint(x: actualX, y: actualY)

    var points: [CGPoint] = [
        CGPoint(x: horizontalPadding, y: baselineY)
    ]

    if pointCount > 1 {
        let transitionIndex = max(pricedIndex - 1, 0)
        let transitionX = horizontalPadding + CGFloat(transitionIndex) * xStep
        if transitionX > horizontalPadding + 0.5 {
            points.append(CGPoint(x: transitionX, y: baselineY))
        }
    }

    points.append(actualPoint)
    return (points, actualPoint)
}

func portfolioCurrentMarketValue(from history: PortfolioHistory?, fallbackValue: Double) -> Double {
    guard portfolioHasUsableHistory(history) else {
        return fallbackValue
    }
    return history?.summary.currentValue ?? fallbackValue
}

func portfolioCurrentCostBasisValue(from history: PortfolioHistory?, fallbackEntries: [DeckCardEntry]) -> Double {
    if portfolioHasUsableHistory(history),
       let currentCostBasisValue = history?.summary.currentCostBasisValue {
        return currentCostBasisValue
    }
    return fallbackEntries.reduce(0) { partialResult, entry in
        partialResult + max(0, entry.costBasisTotal)
    }
}

func portfolioSelectedEntries(_ entries: [DeckCardEntry], selectedIDs: Set<String>) -> [DeckCardEntry] {
    entries.filter { selectedIDs.contains($0.id) }
}

func toggledPortfolioSelectionIDs(_ selectedIDs: Set<String>, entryID: String) -> Set<String> {
    var nextSelection = selectedIDs
    if nextSelection.contains(entryID) {
        nextSelection.remove(entryID)
    } else {
        nextSelection.insert(entryID)
    }
    return nextSelection
}

func portfolioSelectionModeShouldRemainActive(selectedIDs: Set<String>) -> Bool {
    !selectedIDs.isEmpty
}

func formattedPortfolioCardPrice(_ value: Double?, currencyCode: String = "USD") -> String {
    guard let value else {
        return "No price"
    }
    return value.formatted(.currency(code: currencyCode).precision(.fractionLength(2)))
}

func portfolioCardNumberLabel(for entry: DeckCardEntry) -> String {
    let normalizedNumber = entry.card.number.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedNumber.isEmpty else {
        return entry.card.setName
    }
    if normalizedNumber.hasPrefix("#") {
        return normalizedNumber
    }
    return "#\(normalizedNumber)"
}

func formattedPortfolioTransactionTimestamp(_ transaction: PortfolioLedgerTransaction) -> String {
    let action = transaction.kind == .sell ? "Sold" : "Bought"
    return "\(action) on \(transaction.occurredAt.formatted(date: .abbreviated, time: .omitted))"
}

struct PortfolioBatchSelectionSummary: Equatable {
    let cardCount: Int
    let quantity: Int
    let marketValue: Double
    let currencyCode: String
}

func portfolioBatchSelectionSummary(for entries: [DeckCardEntry]) -> PortfolioBatchSelectionSummary {
    let quantity = entries.reduce(0) { $0 + max(1, $1.quantity) }
    let marketValue = entries.reduce(0) { partial, entry in
        partial + (entry.totalEntryValue ?? 0)
    }
    let currencyCode = entries.first?.card.pricing?.currencyCode ?? "USD"
    return PortfolioBatchSelectionSummary(
        cardCount: entries.count,
        quantity: quantity,
        marketValue: marketValue,
        currencyCode: currencyCode
    )
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

private struct PortfolioInventoryEntryTile: View {
    @Environment(\.lootyTheme) private var theme

    let entry: DeckCardEntry
    let isSelectionMode: Bool
    let isSelected: Bool
    let onTap: () -> Void
    let onLongPress: (() -> Void)?

    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var outline: Color { theme.colors.outlineSubtle }
    private var limeAccent: Color { theme.colors.brand }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            CardArtworkView(
                urlString: entry.card.imageSmallURL ?? entry.card.imageLargeURL,
                fallbackTitle: entry.card.name,
                cornerRadius: 14,
                contentMode: .fit
            )
            .frame(maxWidth: .infinity)
            .frame(height: 144)
            .background(theme.colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(alignment: .topTrailing) {
                if isSelectionMode {
                    selectionBadge
                        .padding(10)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(entry.card.name)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(theme.colors.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Text(formattedPortfolioCardPrice(entry.primaryPrice, currencyCode: entry.card.pricing?.currencyCode ?? "USD"))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(entry.primaryPrice == nil ? theme.colors.textSecondary : theme.colors.textPrimary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 6) {
                    Text(portfolioCardNumberLabel(for: entry))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(theme.colors.textSecondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 4) {
                        Image(systemName: "square.stack.3d.up.fill")
                            .font(.system(size: 9, weight: .bold))
                        Text("\(entry.quantity)")
                            .font(.caption2.weight(.bold))
                    }
                    .foregroundStyle(theme.colors.textPrimary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(8)
        .background(isSelected ? limeAccent.opacity(0.12) : surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(isSelected ? limeAccent : outline, lineWidth: isSelected ? 1.5 : 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onTapGesture(perform: onTap)
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.35)
                .onEnded { _ in
                    onLongPress?()
                }
        )
    }

    private var selectionBadge: some View {
        ZStack {
                Circle()
                    .fill(isSelected ? limeAccent : theme.colors.canvas)
                    .frame(width: 28, height: 28)

                Circle()
                    .stroke(isSelected ? limeAccent : theme.colors.outlineStrong, lineWidth: 1)
                    .frame(width: 28, height: 28)

            if isSelected {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.black)
            }
        }
    }
}

private struct PortfolioSectionHeader: View {
    @Environment(\.lootyTheme) private var theme

    let title: String
    let subtitle: String?
    let isExpanded: Bool
    var trailing: AnyView? = nil
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: theme.spacing.xs) {
                VStack(alignment: .leading, spacing: theme.spacing.xxxs) {
                    Text(title)
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundStyle(theme.colors.textPrimary)

                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(theme.typography.caption)
                            .foregroundStyle(theme.colors.textSecondary)
                    }
                }

                Spacer(minLength: theme.spacing.sm)

                if let trailing {
                    trailing
                }

                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(theme.colors.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct PortfolioLatestTransactionCard: View {
    @Environment(\.lootyTheme) private var theme

    let transaction: PortfolioLedgerTransaction
    let onTap: () -> Void

    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var outline: Color { theme.colors.outlineSubtle }
    var body: some View {
        HStack(alignment: .top, spacing: theme.spacing.sm) {
            CardArtworkView(
                urlString: transaction.card.imageSmallURL ?? transaction.card.imageLargeURL,
                fallbackTitle: transaction.card.name,
                cornerRadius: 12,
                contentMode: .fit
            )
            .frame(width: 72, height: 96)
            .background(theme.colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: theme.spacing.xxxs) {
                if let grader = transaction.slabContext?.grader,
                   let grade = transaction.slabContext?.grade {
                    Text("\(grader) \(grade)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(theme.colors.textSecondary)
                }

                Text(transaction.card.name)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(theme.colors.textPrimary)

                Text("#\(transaction.card.number) • \(transaction.card.setName)")
                    .font(.caption)
                    .foregroundStyle(theme.colors.textSecondary)

                if let note = visibleTransactionNote(transaction) {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(theme.colors.textSecondary)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 0)

            VStack(alignment: .trailing, spacing: theme.spacing.xxxs) {
                Text(transaction.totalPrice.formatted(.currency(code: transaction.currencyCode).precision(.fractionLength(2))))
                    .font(.headline.weight(.bold))
                    .foregroundStyle(theme.colors.textPrimary)

                Text(formattedPortfolioTransactionTimestamp(transaction))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(theme.colors.textSecondary)
                    .multilineTextAlignment(.trailing)

                Image(systemName: "pencil")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(theme.colors.textSecondary)
            }
        }
        .padding(theme.spacing.sm)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .onTapGesture(perform: onTap)
    }
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

struct PortfolioValueChartCard: View {
    @Environment(\.lootyTheme) private var theme
    let history: PortfolioHistory?
    let fallbackCurrentValue: Double
    let isLoading: Bool
    let selectedRange: PortfolioHistoryRange
    let onSelectRange: (PortfolioHistoryRange) -> Void

    @State private var selectedPointIndex: Int?

    private var inkBackground: Color { theme.colors.canvas }
    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var fieldBackground: Color { theme.colors.surface }
    private var limeAccent: Color { theme.colors.brand }

    private var visiblePoints: [PortfolioHistoryPoint] { usablePortfolioHistoryPoints(history) }
    private var visibleSeries: [PortfolioHistoryLineSeries] { portfolioHistoryLineSeries(for: history) }
    private var hasUsableHistory: Bool { !visiblePoints.isEmpty }
    private var resolvedSelectionIndex: Int? {
        resolvedPortfolioHistorySelectionIndex(
            selectedPointIndex: selectedPointIndex,
            history: history
        )
    }

    private var selectedPoint: PortfolioHistoryPoint? {
        guard let resolvedSelectionIndex,
              visiblePoints.indices.contains(resolvedSelectionIndex) else {
            return visiblePoints[safe: latestPricedPortfolioHistoryPointIndex(in: visiblePoints) ?? (visiblePoints.indices.last ?? 0)]
        }
        return visiblePoints[resolvedSelectionIndex]
    }

    private var displayedPointValue: Double? {
        selectedPoint?.marketValue
            ?? selectedPoint?.totalValue
    }

    private var displayedValue: Double {
        displayedPointValue
            ?? (hasUsableHistory ? history?.summary.currentValue : nil)
            ?? fallbackCurrentValue
    }

    private var displayedDateLabel: String {
        guard hasUsableHistory else {
            return fallbackCurrentValue > 0 ? "Current snapshot" : (isLoading ? "Loading daily history" : "Daily dashboard view")
        }
        guard let dateString = selectedPoint?.date ?? visiblePoints.last?.date else {
            return isLoading ? "Loading daily history" : "Daily dashboard view"
        }
        return formattedDisplayDate(from: dateString)
    }

    private var hoverDelta: PortfolioHoverDelta? {
        portfolioRangeHoverDelta(
            points: visiblePoints,
            hoveredIndex: resolvedSelectionIndex
        )
    }

    private var displayedDelta: Double? {
        hoverDelta?.deltaDollar
    }

    private var displayedDeltaPercent: Double? {
        hoverDelta?.deltaPercent
    }

    private var displayCurrencyCode: String {
        history?.currencyCode ?? "USD"
    }

    private var displayedDeltaLabel: String? {
        guard let displayedDelta else { return nil }
        let positive = displayedDelta >= 0
        let sign = positive ? "+" : "-"
        let deltaText = "\(sign)\(formattedPrice(abs(displayedDelta), currencyCode: displayCurrencyCode))"
        if let displayedDeltaPercent {
            return "\(deltaText) • \(String(format: "%.2f", abs(displayedDeltaPercent)))%"
        }
        return deltaText
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            summaryRow
            chartArea
            footerRow
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(theme.colors.canvas.opacity(0.92))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(theme.colors.outlineSubtle.opacity(0.6), lineWidth: 1)
        )
    }

    private var summaryRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(formattedPrice(displayedValue, currencyCode: displayCurrencyCode))
                .font(.system(size: 35, weight: .bold, design: .rounded))
                .foregroundStyle(theme.colors.textPrimary)

            HStack(spacing: 10) {
                Text(displayedDateLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(theme.colors.textPrimary)

                if let displayedDeltaLabel {
                    Text(displayedDeltaLabel)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(theme.colors.textPrimary)
                }
            }
        }
    }

    private var chartArea: some View {
        GeometryReader { geometry in
            let chartLines = chartLineCoordinates(in: geometry.size)
            let syntheticSinglePointChart = portfolioSinglePricedHistoryDisplay(
                history: history,
                size: geometry.size
            )
            let hasSelection = resolvedSelectionIndex != nil && visiblePoints.indices.contains(resolvedSelectionIndex ?? -1)
            let displayedMarketPoints: [CGPoint]? = {
                if let syntheticSinglePointChart {
                    return syntheticSinglePointChart.points
                }
                guard let marketPoints = chartLines.market else { return nil }
                guard marketPoints.count == 1, let point = marketPoints.first else {
                    return marketPoints
                }
                let leftPoint = CGPoint(x: 14, y: point.y)
                let rightPoint = CGPoint(x: max(14, geometry.size.width - 14), y: point.y)
                return [leftPoint, rightPoint]
            }()
            let selectionPoint: CGPoint? = {
                if let syntheticSinglePointChart {
                    return syntheticSinglePointChart.selectionPoint
                }
                guard hasSelection else { return nil }
                if let marketPoints = chartLines.market,
                   marketPoints.count == 1,
                   let point = marketPoints.first {
                    return CGPoint(x: max(14, geometry.size.width - 14), y: point.y)
                }
                guard let selectionIndex = resolvedSelectionIndex,
                      let displayedMarketPoints,
                      displayedMarketPoints.indices.contains(selectionIndex) else {
                    return nil
                }
                return displayedMarketPoints[selectionIndex]
            }()

            ZStack {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(surfaceBackground.opacity(0.68))

                if visiblePoints.isEmpty {
                    emptyChartState
                } else {
                    chartGrid

                    if let marketPoints = displayedMarketPoints, marketPoints.count > 1 {
                        chartFill(points: marketPoints, size: geometry.size)
                        chartLine(points: marketPoints, color: limeAccent)
                    } else if let point = displayedMarketPoints?.first {
                        Circle()
                            .fill(limeAccent)
                            .frame(width: 10, height: 10)
                            .position(point)
                    }

                    if let selectionPoint {
                        selectionOverlay(
                            point: selectionPoint,
                            size: geometry.size
                        )
                    }
                }
            }
            .contentShape(Rectangle())
            .simultaneousGesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { value in
                        guard !visiblePoints.isEmpty, chartDragShouldScrub(translation: value.translation) else { return }
                        selectedPointIndex = nearestPointIndex(for: value.location, size: geometry.size)
                    }
                    .onEnded { value in
                        guard !visiblePoints.isEmpty, chartDragShouldScrub(translation: value.translation) else { return }
                        selectedPointIndex = nearestPointIndex(for: value.location, size: geometry.size)
                    }
            )
            .simultaneousGesture(
                SpatialTapGesture()
                    .onEnded { value in
                        guard !visiblePoints.isEmpty else { return }
                        selectedPointIndex = nearestPointIndex(for: value.location, size: geometry.size)
                    }
            )
            .onAppear {
                seedSelectionIfNeeded()
            }
        }
        .frame(height: 212)
        .onChange(of: selectedRange, initial: false) {
            selectedPointIndex = nil
        }
        .onChange(of: visiblePoints, initial: false) { _, newPoints in
            selectedPointIndex = latestPricedPortfolioHistoryPointIndex(in: newPoints)
        }
        .onChange(of: history?.summary.currentValue, initial: false) {
            selectedPointIndex = latestPricedPortfolioHistoryPointIndex(in: visiblePoints)
        }
    }

    private var emptyChartState: some View {
        VStack(spacing: 10) {
            Image(systemName: isLoading ? "chart.line.uptrend.xyaxis" : "clock.arrow.circlepath")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(theme.colors.textSecondary)

            Text(
                isLoading
                    ? "Loading inventory history..."
                    : (fallbackCurrentValue > 0
                        ? "Current inventory value is loaded. Daily history will appear after historical pricing is seeded."
                        : "Your inventory chart will appear after pricing snapshots build up.")
            )
                .font(.footnote.weight(.semibold))
                .foregroundStyle(theme.colors.textSecondary.opacity(0.8))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)
        }
    }

    private var chartGrid: some View {
        VStack {
            ForEach(0..<4, id: \.self) { index in
                Spacer()
                Rectangle()
                    .fill(theme.colors.outlineSubtle.opacity(index == 3 ? 0.62 : 0.42))
                    .frame(height: 1)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 18)
    }

    private func chartFill(points: [CGPoint], size: CGSize) -> some View {
        Canvas { context, canvasSize in
            guard !points.isEmpty else { return }

            let baseline = canvasSize.height - 20
            var path = Path()
            path.move(to: CGPoint(x: points[0].x, y: baseline))
            path.addLine(to: points[0])
            for point in points.dropFirst() {
                path.addLine(to: point)
            }
            path.addLine(to: CGPoint(x: points.last?.x ?? 0, y: baseline))
            path.closeSubpath()

            context.fill(
                path,
                with: .linearGradient(
                    Gradient(colors: [
                        limeAccent.opacity(0.18),
                        limeAccent.opacity(0.04),
                        .clear
                    ]),
                    startPoint: CGPoint(x: 0, y: 0),
                    endPoint: CGPoint(x: 0, y: canvasSize.height)
                )
            )
        }
        .mask(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(theme.colors.canvasElevated)
        )
    }

    private func chartLine(points: [CGPoint], color: Color, dash: [CGFloat] = []) -> some View {
        Canvas { context, _ in
            guard !points.isEmpty else { return }

            var path = Path()
            path.move(to: points[0])
            for point in points.dropFirst() {
                path.addLine(to: point)
            }

            context.addFilter(.shadow(color: color.opacity(0.16), radius: 4, x: 0, y: 1))
            context.stroke(
                path,
                with: .color(color),
                style: StrokeStyle(
                    lineWidth: 2.2,
                    lineCap: .round,
                    lineJoin: .round,
                    dash: dash
                )
            )
        }
    }

    private func selectionOverlay(point: CGPoint, size: CGSize) -> some View {
        return ZStack {
            Rectangle()
                .fill(theme.colors.textPrimary.opacity(0.20))
                .frame(width: 1)
                .position(x: point.x, y: size.height / 2)

            Circle()
                .fill(inkBackground)
                .frame(width: 14, height: 14)
                .overlay(
                    Circle()
                        .stroke(limeAccent, lineWidth: 2.5)
                )
                .position(point)
        }
    }

    private var footerRow: some View {
        HStack(spacing: 8) {
            ForEach(PortfolioHistoryRange.allCases) { option in
                Button {
                    onSelectRange(option)
                } label: {
                    Text(option.displayLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(selectedRange == option ? theme.colors.textInverse : theme.colors.textPrimary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .frame(maxWidth: .infinity)
                        .background(selectedRange == option ? limeAccent : fieldBackground)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(5)
        .background(theme.colors.surfaceMuted)
        .clipShape(Capsule())
    }

    private func chartCoordinates(in size: CGSize) -> [CGPoint] {
        guard !visiblePoints.isEmpty else { return [] }
        if visiblePoints.count == 1 {
            return [CGPoint(x: size.width / 2, y: size.height / 2)]
        }

        let horizontalPadding: CGFloat = 14
        let verticalPadding: CGFloat = 20
        let width = max(1, size.width - horizontalPadding * 2)
        let height = max(1, size.height - verticalPadding * 2)

        let minValue: Double = 0
        let maxValue = max(visiblePoints.map(\.totalValue).max() ?? 1, 1)
        let valueRange = max(maxValue - minValue, max(maxValue * 0.08, 1))
        let xStep = width / CGFloat(visiblePoints.count - 1)

        return visiblePoints.enumerated().map { index, point in
            let normalized = (point.totalValue - minValue) / valueRange
            let x = horizontalPadding + CGFloat(index) * xStep
            let y = verticalPadding + (1 - CGFloat(normalized)) * height
            return CGPoint(x: x, y: y)
        }
    }

    private func chartLineCoordinates(in size: CGSize) -> (market: [CGPoint]?, costBasis: [CGPoint]?) {
        guard !visiblePoints.isEmpty else { return (nil, nil) }
        let lineSeries = visibleSeries
        guard !lineSeries.isEmpty else { return (nil, nil) }

        let values = lineSeries.flatMap { $0.values }.compactMap { $0 }
        guard !values.isEmpty else {
            return (nil, nil)
        }

        let minValue: Double = 0
        let maxValue: Double
        if values.count == 1, let onlyValue = values.first {
            maxValue = max(onlyValue * 1.15, 1)
        } else {
            guard let resolvedMaxValue = values.max() else {
                return (nil, nil)
            }
            maxValue = max(resolvedMaxValue, 1)
        }

        let valueRange = max(maxValue - minValue, max(maxValue * 0.08, 1))
        let horizontalPadding: CGFloat = 14
        let verticalPadding: CGFloat = 20
        let width = max(1, size.width - horizontalPadding * 2)
        let height = max(1, size.height - verticalPadding * 2)
        let xStep = visiblePoints.count > 1 ? width / CGFloat(visiblePoints.count - 1) : 0

        func makePoints(values: [Double?]) -> [CGPoint] {
            values.enumerated().compactMap { index, value in
                guard let value else { return nil }
                let normalized = (value - minValue) / valueRange
                let x = visiblePoints.count > 1 ? horizontalPadding + CGFloat(index) * xStep : size.width / 2
                let y = verticalPadding + (1 - CGFloat(normalized)) * height
                return CGPoint(x: x, y: y)
            }
        }

        let marketPoints = makePoints(values: lineSeries.first(where: { $0.kind == .market })?.values ?? [])
        let costBasisPoints = makePoints(values: lineSeries.first(where: { $0.kind == .costBasis })?.values ?? [])
        return (market: marketPoints, costBasis: costBasisPoints)
    }

    private func nearestPointIndex(for location: CGPoint, size: CGSize) -> Int {
        let points = chartCoordinates(in: size)
        guard !points.isEmpty else { return 0 }

        var nearestIndex = 0
        var nearestDistance = CGFloat.greatestFiniteMagnitude
        for (index, point) in points.enumerated() {
            let distance = abs(point.x - location.x)
            if distance < nearestDistance {
                nearestDistance = distance
                nearestIndex = index
            }
        }
        return nearestIndex
    }

    private func seedSelectionIfNeeded() {
        guard selectedPointIndex == nil, !visiblePoints.isEmpty else { return }
        selectedPointIndex = latestPricedPortfolioHistoryPointIndex(in: visiblePoints) ?? visiblePoints.indices.last
    }

    private func formattedPrice(_ value: Double, currencyCode: String = "USD") -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }

    private func formattedDisplayDate(from dateString: String) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        let parsedDate = Self.parseISO8601Date(dateString) ?? Date()
        return formatter.string(from: parsedDate)
    }

    private static func parseISO8601Date(_ dateString: String) -> Date? {
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withDashSeparatorInDate, .withColonSeparatorInTime]
        if let fullDate = isoFormatter.date(from: dateString) {
            return fullDate
        }
        let dayFormatter = DateFormatter()
        dayFormatter.calendar = Calendar(identifier: .iso8601)
        dayFormatter.locale = Locale(identifier: "en_US_POSIX")
        dayFormatter.dateFormat = "yyyy-MM-dd"
        return dayFormatter.date(from: dateString)
    }
}

private extension Array {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

private struct PortfolioInventoryBrowserPresentation: Identifiable {
    let id = UUID()
    let startsInSelectionMode: Bool
    let initialSelectedEntryID: String?

    static func browse() -> Self {
        Self(startsInSelectionMode: false, initialSelectedEntryID: nil)
    }

    static func sell(initialSelectedEntryID: String? = nil) -> Self {
        Self(startsInSelectionMode: true, initialSelectedEntryID: initialSelectedEntryID)
    }
}

struct PortfolioSurfaceView: View {
    @Environment(\.lootyTheme) private var theme
    let onSelectEntry: (DeckCardEntry) -> Void
    @ObservedObject var collectionStore: CollectionStore
    @ObservedObject var scannerViewModel: ScannerViewModel
    @ObservedObject var showsState: ShowsMockState
    let accountMonogram: String
    let isVisible: Bool
    let isHorizontalPageSwipeActive: Bool
    let onEnsureEntries: () -> Void
    let onOpenScanner: () -> Void
    let onOpenAccount: () -> Void
    let onVerticalScrollGestureActiveChanged: (Bool) -> Void
    @State private var searchQuery = ""
    @State private var isShowingManualCardSearch = false
    @State private var displayedEntries: [DeckCardEntry] = []
    @State private var displayedEntriesRefreshID = 0
    @State private var inventoryBrowserPresentation: PortfolioInventoryBrowserPresentation?
    @State private var isInventorySectionExpanded = true
    @State private var isTransactionsSectionExpanded = true
    @State private var editingTransaction: PortfolioLedgerTransaction?

    private var inkBackground: Color { theme.colors.canvas }
    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var fieldBackground: Color { theme.colors.surface }
    private var limeAccent: Color { theme.colors.brand }
    private var outline: Color { theme.colors.outlineSubtle }
    private var latestTransactions: [PortfolioLedgerTransaction] {
        (collectionStore.portfolioLedger?.transactions ?? [])
            .filter { $0.kind == .sell }
            .sorted { $0.occurredAt > $1.occurredAt }
    }

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                inkBackground.ignoresSafeArea()

                ScrollView(showsIndicators: true) {
                    VStack(alignment: .leading, spacing: 16) {
                        pageHeader
                        portfolioOverviewSection
                        inventorySection
                        transactionsSection
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
                    .padding(.bottom, 104 + max(proxy.safeAreaInsets.bottom, 0))
                }
                .scrollDisabled(isHorizontalPageSwipeActive)
                .simultaneousGesture(
                    DragGesture(minimumDistance: 8)
                        .onChanged { value in
                            guard portfolioDragShouldBlockHorizontalPageSwipe(translation: value.translation) else { return }
                            onVerticalScrollGestureActiveChanged(true)
                        }
                        .onEnded { _ in
                            onVerticalScrollGestureActiveChanged(false)
                        }
                )
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                AppShellBottomBar(
                    selectedTab: .portfolio,
                    onOpenPortfolio: {},
                    onOpenScanner: onOpenScanner,
                    onOpenLedger: {}
                )
            }
            .fullScreenCover(item: $inventoryBrowserPresentation) { presentation in
                PortfolioInventoryBrowserView(
                    collectionStore: collectionStore,
                    searchQuery: $searchQuery,
                    startsInSelectionMode: presentation.startsInSelectionMode,
                    initialSelectedEntryID: presentation.initialSelectedEntryID,
                    onSelectEntry: onSelectEntry
                )
            }
            .fullScreenCover(isPresented: $isShowingManualCardSearch) {
                ManualCardSearchView(
                    collectionStore: collectionStore,
                    scannerViewModel: scannerViewModel,
                    showsState: showsState,
                    onOpenScanner: onOpenScanner
                )
            }
            .refreshable {
                async let entriesRefresh: Void = collectionStore.refreshFromBackend()
                async let historyRefresh: Void = collectionStore.refreshPortfolioHistory()
                async let ledgerRefresh: Void = collectionStore.refreshPortfolioLedger(range: .all)
                _ = await (entriesRefresh, historyRefresh, ledgerRefresh)
            }
            .onChange(of: isVisible, initial: true) { _, visible in
                spotlightFlowLog("Portfolio isVisible -> \(visible) entries=\(collectionStore.entries.count) displayed=\(displayedEntries.count) historyLoaded=\(collectionStore.portfolioHistory != nil)")
                if !visible {
                    onVerticalScrollGestureActiveChanged(false)
                }
                guard visible else { return }
                if collectionStore.entries.isEmpty {
                    spotlightFlowLog("Portfolio requesting ensured entries because store is empty")
                    onEnsureEntries()
                }
                scheduleDisplayedEntriesRefresh()
                if collectionStore.portfolioHistory == nil,
                   !collectionStore.isLoadingPortfolioHistory {
                    spotlightFlowLog("Portfolio requesting history load on first visibility")
                    Task {
                        await collectionStore.refreshPortfolioHistory()
                    }
                }
                if collectionStore.portfolioLedger == nil,
                   !collectionStore.isLoadingPortfolioLedger {
                    spotlightFlowLog("Portfolio requesting ledger load on first visibility")
                    Task {
                        await collectionStore.refreshPortfolioLedger(range: .all)
                    }
                }
            }
            .onChange(of: searchQuery, initial: true) { _, _ in
                guard isVisible else { return }
                scheduleDisplayedEntriesRefresh()
            }
            .onChange(of: collectionStore.entries, initial: true) { _, _ in
                spotlightFlowLog("Portfolio store entries changed count=\(collectionStore.entries.count) visible=\(isVisible)")
                prefetchArtwork(for: collectionStore.entries)
                guard isVisible else { return }
                scheduleDisplayedEntriesRefresh()
            }
            .sheet(item: $editingTransaction) { transaction in
                LedgerTransactionPriceEditorSheet(transaction: transaction) { updatedUnitPrice in
                    switch transaction.kind {
                    case .buy:
                        try await collectionStore.updatePortfolioBuyTransactionPrice(
                            transactionID: transaction.id,
                            unitPrice: updatedUnitPrice,
                            currencyCode: transaction.currencyCode
                        )
                    case .sell:
                        try await collectionStore.updatePortfolioSaleTransactionPrice(
                            transactionID: transaction.id,
                            unitPrice: updatedUnitPrice,
                            currencyCode: transaction.currencyCode
                        )
                    }
                }
            }
        }
    }

    private var pageHeader: some View {
        HStack(alignment: .top, spacing: theme.spacing.sm) {
            VStack(alignment: .leading, spacing: theme.spacing.xxxs) {
                Text("Portfolio")
                    .font(theme.typography.display)
                    .foregroundStyle(theme.colors.textPrimary)

                Text("Track value, inventory, and recent sales in one place.")
                    .font(theme.typography.body)
                    .foregroundStyle(theme.colors.textSecondary)
            }

            Spacer(minLength: theme.spacing.sm)

            Button(action: onOpenAccount) {
                Circle()
                    .fill(theme.colors.brand)
                    .frame(width: 40, height: 40)
                    .overlay(
                        Text(accountMonogram)
                            .font(theme.typography.caption)
                            .foregroundStyle(theme.colors.textInverse)
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open account")
        }
    }

    private var portfolioOverviewSection: some View {
        PortfolioValueChartCard(
            history: collectionStore.portfolioHistory,
            fallbackCurrentValue: currentMarketValue,
            isLoading: collectionStore.isLoadingPortfolioHistory,
            selectedRange: collectionStore.selectedPortfolioHistoryRange,
            onSelectRange: { range in
                Task {
                    await collectionStore.refreshPortfolioHistory(range: range)
                }
            }
        )
    }

    private var inventorySection: some View {
        VStack(alignment: .leading, spacing: theme.spacing.xs) {
            HStack(spacing: theme.spacing.xs) {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        isInventorySectionExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: theme.spacing.xs) {
                        Text("Inventory")
                            .font(.system(size: 26, weight: .bold, design: .rounded))
                            .foregroundStyle(theme.colors.textPrimary)
                            .lineLimit(1)

                        if !collectionStore.entries.isEmpty {
                            Text("(\(collectionStore.totalCardCount))")
                                .font(.title3.weight(.bold))
                                .foregroundStyle(theme.colors.textSecondary)
                                .lineLimit(1)
                        }

                        Image(systemName: isInventorySectionExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(theme.colors.textSecondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .layoutPriority(1)

                Spacer(minLength: 0)
            }

            HStack(alignment: .center, spacing: theme.spacing.sm) {
                Button {
                    isShowingManualCardSearch = true
                } label: {
                    Text("Add Card")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(theme.colors.textInverse)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(theme.colors.brand)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)

                Spacer(minLength: 0)

                if !collectionStore.entries.isEmpty {
                    Button {
                        presentInventoryBrowser(selectionMode: true)
                    } label: {
                        Text("Sell")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(theme.colors.textPrimary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(fieldBackground)
                            .overlay(
                                Capsule()
                                    .stroke(outline, lineWidth: 1)
                            )
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)

                    Button {
                        presentInventoryBrowser()
                    } label: {
                        Text("See more")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(theme.colors.textPrimary)
                    }
                    .buttonStyle(.plain)
                }
            }

            if isInventorySectionExpanded {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 12) {
                        HStack(spacing: 10) {
                            Image(systemName: "magnifyingglass")
                                .foregroundStyle(theme.colors.textSecondary)

                            TextField("Search inventory cards", text: $searchQuery)
                                .textInputAutocapitalization(.never)
                                .disableAutocorrection(true)
                                .foregroundStyle(theme.colors.textPrimary)
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 44)
                        .background(fieldBackground)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .contentShape(Rectangle())
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(outline, lineWidth: 1)
                        )
                    }

                    if displayedEntries.isEmpty {
                        emptyState
                    } else {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(Array(displayedEntries.prefix(9))) { entry in
                                PortfolioInventoryEntryTile(
                                    entry: entry,
                                    isSelectionMode: false,
                                    isSelected: false,
                                    onTap: {
                                        onSelectEntry(entry)
                                    },
                                    onLongPress: {
                                        presentInventoryBrowser(selectionMode: true, initialSelectedEntryID: entry.id)
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 10) {
                Text(emptyStateTitle)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(theme.colors.textPrimary)

                Text(emptyStateMessage)
                    .font(.subheadline)
                    .foregroundStyle(theme.colors.textSecondary)
            }

            if !collectionStore.entries.isEmpty {
                HStack(spacing: 12) {
                    Button {
                        isShowingManualCardSearch = true
                    } label: {
                        Text("Add Card")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(
                        LootyFilledButtonStyle(
                            fill: theme.colors.brand,
                            foreground: theme.colors.textInverse,
                            cornerRadius: 16,
                            minHeight: 50
                        )
                    )

                    Button {
                        onOpenScanner()
                    } label: {
                        Text("Open Scanner")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(
                        LootySecondaryButtonStyle()
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private var transactionsSection: some View {
        VStack(alignment: .leading, spacing: theme.spacing.xs) {
            PortfolioSectionHeader(
                title: "Latest Sales",
                subtitle: latestTransactions.isEmpty ? "Completed sales will show up here." : nil,
                isExpanded: isTransactionsSectionExpanded,
                trailing: collectionStore.isLoadingPortfolioLedger
                    ? AnyView(ProgressView().tint(theme.colors.textSecondary))
                    : nil
            ) {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isTransactionsSectionExpanded.toggle()
                }
            }

            if isTransactionsSectionExpanded {
                if latestTransactions.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("No sales yet")
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(theme.colors.textPrimary)

                        Text("Completed sales will appear here as soon as you start moving inventory.")
                            .font(.subheadline)
                            .foregroundStyle(theme.colors.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(surfaceBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(outline, lineWidth: 1)
                    )
                } else {
                    LazyVStack(spacing: theme.spacing.xs) {
                        ForEach(latestTransactions) { transaction in
                            PortfolioLatestTransactionCard(transaction: transaction) {
                                editingTransaction = transaction
                            }
                        }
                    }
                }
            }
        }
    }

    private func scheduleDisplayedEntriesRefresh() {
        displayedEntriesRefreshID += 1
        let refreshID = displayedEntriesRefreshID
        let entries = collectionStore.entries
        let query = searchQuery
        let startedAt = ProcessInfo.processInfo.systemUptime
        spotlightFlowLog("Portfolio scheduleDisplayedEntriesRefresh id=\(refreshID) entries=\(entries.count) query=\(query) previewLimit=9")

        DispatchQueue.global(qos: .userInitiated).async {
            let refreshedEntries = sortedPortfolioEntries(
                filteredPortfolioEntries(
                    entries,
                    searchQuery: query,
                    filter: .all
                ),
                by: .recentlyAdded
            )

            DispatchQueue.main.async {
                guard refreshID == displayedEntriesRefreshID else { return }
                displayedEntries = refreshedEntries
                prefetchArtwork(for: refreshedEntries)
                let elapsed = ProcessInfo.processInfo.systemUptime - startedAt
                spotlightFlowLog("Portfolio displayedEntries ready id=\(refreshID) displayed=\(refreshedEntries.count) elapsed=\(String(format: "%.3f", elapsed))s")
            }
        }
    }

    private func presentInventoryBrowser(
        selectionMode: Bool = false,
        initialSelectedEntryID: String? = nil
    ) {
        if selectionMode {
            searchQuery = ""
        }
        inventoryBrowserPresentation = selectionMode
            ? .sell(initialSelectedEntryID: initialSelectedEntryID)
            : .browse()
    }

    private func prefetchArtwork(for entries: [DeckCardEntry]) {
        let urls = entries
            .prefix(18)
            .compactMap { entry in
                let urlString = entry.card.imageSmallURL ?? entry.card.imageLargeURL
                let trimmed = urlString?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return trimmed.isEmpty ? nil : trimmed
            }
        guard !urls.isEmpty else { return }
#if canImport(UIKit)
        Task {
            await CardArtworkPipeline.shared.prefetch(urlStrings: urls)
        }
#endif
    }

    private var emptyStateTitle: String {
        if collectionStore.isLoadingEntries && collectionStore.entries.isEmpty {
            return "Loading your inventory..."
        }
        return collectionStore.entries.isEmpty
            ? "No cards in your inventory yet"
            : "No cards match that search"
    }

    private var emptyStateMessage: String {
        if collectionStore.isLoadingEntries && collectionStore.entries.isEmpty {
            return "Fetching your deck entries and artwork."
        }
        return collectionStore.entries.isEmpty
            ? "Scan a card and it will appear here."
            : "Try a different name, set, or card number."
    }

    private var currentMarketValue: Double {
        portfolioCurrentMarketValue(
            from: collectionStore.portfolioHistory,
            fallbackValue: collectionStore.totalValue
        )
    }

    private var currentBoughtInValue: Double {
        portfolioCurrentCostBasisValue(
            from: collectionStore.portfolioHistory,
            fallbackEntries: collectionStore.entries
        )
    }
}

private struct PortfolioInventoryBrowserView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme

    @ObservedObject var collectionStore: CollectionStore
    @Binding var searchQuery: String
    let startsInSelectionMode: Bool
    let initialSelectedEntryID: String?
    let onSelectEntry: (DeckCardEntry) -> Void

    @State private var sortOption: PortfolioSortChoice = .recentlyAdded
    @State private var inventoryFilter: PortfolioInventoryFilter = .all
    @State private var displayedEntries: [DeckCardEntry] = []
    @State private var displayedEntriesRefreshID = 0
    @State private var isSelectionMode = false
    @State private var selectedEntryIDs: Set<String> = []
    @State private var presentedBatchSellDraft: ShowSellBatchDraft?
    @State private var didCompleteBatchSell = false

    private var inkBackground: Color { theme.colors.canvas }
    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var fieldBackground: Color { theme.colors.surface }
    private var limeAccent: Color { theme.colors.brand }
    private var outline: Color { theme.colors.outlineSubtle }
    private var launchSelectionStateKey: String {
        "\(startsInSelectionMode)|\(initialSelectedEntryID ?? "")"
    }

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                inkBackground.ignoresSafeArea()

                ScrollView(showsIndicators: true) {
                    VStack(alignment: .leading, spacing: 18) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("All cards")
                                    .font(.system(size: 28, weight: .bold, design: .rounded))
                                    .foregroundStyle(theme.colors.textPrimary)

                                Text("\(displayedEntries.count) shown")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(theme.colors.textSecondary)
                            }

                            Spacer()
                        }

                        HStack(spacing: 12) {
                            HStack(spacing: 10) {
                                Image(systemName: "magnifyingglass")
                                    .foregroundStyle(theme.colors.textSecondary)

                                TextField("Search inventory cards", text: $searchQuery)
                                    .textInputAutocapitalization(.never)
                                    .disableAutocorrection(true)
                                    .foregroundStyle(theme.colors.textPrimary)
                            }
                            .padding(.horizontal, 14)
                            .frame(height: 44)
                            .background(fieldBackground)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .contentShape(Rectangle())
                            .overlay(
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .stroke(outline, lineWidth: 1)
                            )
                        }

                        VStack(alignment: .leading, spacing: 10) {
                            portfolioControlRow(
                            title: "Sort",
                                chips: PortfolioSortChoice.allCases.map { option in
                                    PortfolioControlChip(
                                        title: option.compactLabel,
                                        isSelected: sortOption == option
                                    ) {
                                        sortOption = option
                                    }
                                }
                            )

                            portfolioControlRow(
                            title: "Filter",
                                chips: PortfolioInventoryFilter.allCases.map { filter in
                                    PortfolioControlChip(
                                        title: filter.displayName,
                                        isSelected: inventoryFilter == filter
                                    ) {
                                        inventoryFilter = filter
                                    }
                                }
                            )
                        }

                        if displayedEntries.isEmpty {
                            emptyState
                        } else {
                            LazyVGrid(columns: columns, spacing: 12) {
                                ForEach(displayedEntries) { entry in
                                    PortfolioInventoryEntryTile(
                                        entry: entry,
                                        isSelectionMode: isSelectionMode,
                                        isSelected: selectedEntryIDs.contains(entry.id),
                                        onTap: {
                                            if isSelectionMode {
                                                toggleSelection(for: entry.id)
                                            } else {
                                                openEntry(entry)
                                            }
                                        },
                                        onLongPress: {
                                            if !isSelectionMode {
                                                isSelectionMode = true
                                                selectedEntryIDs = [entry.id]
                                            } else {
                                                toggleSelection(for: entry.id)
                                            }
                                        }
                                    )
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 18)
                    .padding(.bottom, isSelectionMode ? 110 : 32)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if isSelectionMode {
                    batchSelectionBar
                }
            }
            .sheet(item: $presentedBatchSellDraft, onDismiss: handleBatchSellPreviewDismissal) { draft in
                ShowSellBatchPreviewSheet(draft: draft) { submission in
                    let requests = submission.lines.map { line in
                        PortfolioSaleBatchLineRequest(
                            card: line.entry.card,
                            slabContext: line.entry.slabContext,
                            quantity: line.quantity,
                            unitPrice: line.unitPrice,
                            currencyCode: line.entry.card.pricing?.currencyCode ?? "USD",
                            paymentMethod: submission.paymentMethod,
                            soldAt: Date(),
                            showSessionID: nil,
                            note: submission.note,
                            sourceScanID: nil
                        )
                    }
                    _ = try await collectionStore.recordSalesBatch(requests)
                    AppFeedback.saleCompleted()
                    await MainActor.run {
                        didCompleteBatchSell = true
                    }
                }
            }
            .toolbarBackground(inkBackground, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .navigationTitle("Inventory")
            .navigationBarTitleDisplayMode(.inline)
                            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(theme.colors.textPrimary)
                    }
                }
            }
            .task(id: launchSelectionStateKey) {
                syncLaunchSelectionState()
            }
            .onAppear {
                scheduleDisplayedEntriesRefresh()
            }
            .onChange(of: searchQuery, initial: false) { _, _ in
                scheduleDisplayedEntriesRefresh()
            }
            .onChange(of: sortOption, initial: false) { _, _ in
                scheduleDisplayedEntriesRefresh()
            }
            .onChange(of: inventoryFilter, initial: false) { _, _ in
                scheduleDisplayedEntriesRefresh()
            }
            .onChange(of: collectionStore.entries, initial: true) { _, _ in
                scheduleDisplayedEntriesRefresh()
            }
        }
    }

    private func openEntry(_ entry: DeckCardEntry) {
        dismiss()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
            onSelectEntry(entry)
        }
    }

    private func syncLaunchSelectionState() {
        let launchState = portfolioInventoryBrowserLaunchSelectionState(
            startsInSelectionMode: startsInSelectionMode,
            initialSelectedEntryID: initialSelectedEntryID
        )
        isSelectionMode = launchState.isSelectionMode
        selectedEntryIDs = launchState.selectedEntryIDs
    }

    private func handleBatchSellPreviewDismissal() {
        presentedBatchSellDraft = nil
        if didCompleteBatchSell {
            exitSelectionMode()
        }
        didCompleteBatchSell = false
    }

    private func scheduleDisplayedEntriesRefresh() {
        displayedEntriesRefreshID += 1
        let refreshID = displayedEntriesRefreshID
        let entries = collectionStore.entries
        let query = searchQuery
        let filter = inventoryFilter
        let sort = sortOption

        DispatchQueue.global(qos: .userInitiated).async {
            let refreshedEntries = sortedPortfolioEntries(
                filteredPortfolioEntries(
                    entries,
                    searchQuery: query,
                    filter: filter
                ),
                by: sort
            )

            DispatchQueue.main.async {
                guard refreshID == displayedEntriesRefreshID else { return }
                displayedEntries = refreshedEntries
            }
        }
    }

    private var selectedEntries: [DeckCardEntry] {
        portfolioSelectedEntries(collectionStore.entries, selectedIDs: selectedEntryIDs)
    }

    private var selectedBatchSellDraft: ShowSellBatchDraft? {
        guard !selectedEntries.isEmpty else { return nil }
        return ShowSellBatchDraft(
            title: "Sell selected cards",
            subtitle: "\(selectedEntries.count) card\(selectedEntries.count == 1 ? "" : "s") from inventory",
            lines: selectedEntries.map { entry in
                ShowSellBatchLineDraft(
                    id: entry.id,
                    entry: entry,
                    sourceItemIDs: [],
                    scannedCount: 0,
                    quantityLimit: max(1, entry.quantity),
                    suggestedUnitPrice: entry.primaryPrice ?? 0
                )
            }
        )
    }

    private var batchSelectionBar: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(outline)
                .frame(height: 1)

            HStack(spacing: 14) {
                Button {
                    exitSelectionMode()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(theme.colors.textPrimary)
                        .frame(width: 44, height: 44)
                        .background(fieldBackground)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)

                Spacer()

                Button {
                    guard let draft = selectedBatchSellDraft else { return }
                    presentedBatchSellDraft = draft
                } label: {
                    Text("Sell selected")
                }
                .buttonStyle(
                    LootyFilledButtonStyle(
                        fill: selectedEntries.isEmpty ? fieldBackground : limeAccent,
                        foreground: selectedEntries.isEmpty ? theme.colors.textPrimary.opacity(0.40) : theme.colors.textInverse,
                        cornerRadius: theme.radius.pill
                    )
                )
                .disabled(selectedEntries.isEmpty)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .background(inkBackground)
        }
    }

    private func toggleSelection(for entryID: String) {
        selectedEntryIDs = toggledPortfolioSelectionIDs(selectedEntryIDs, entryID: entryID)
        if !portfolioSelectionModeShouldRemainActive(selectedIDs: selectedEntryIDs) {
            exitSelectionMode()
        }
    }

    private func exitSelectionMode() {
        isSelectionMode = false
        selectedEntryIDs.removeAll()
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(emptyStateTitle)
                .font(.headline.weight(.semibold))
                .foregroundStyle(theme.colors.textPrimary)

            Text(emptyStateMessage)
                .font(.subheadline)
                .foregroundStyle(theme.colors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private var emptyStateTitle: String {
        if collectionStore.isLoadingEntries && collectionStore.entries.isEmpty {
            return "Loading your inventory..."
        }
        return collectionStore.entries.isEmpty
            ? "No cards in your inventory yet"
            : "No cards match that search"
    }

    private var emptyStateMessage: String {
        if collectionStore.isLoadingEntries && collectionStore.entries.isEmpty {
            return "Fetching your deck entries and artwork."
        }
        return collectionStore.entries.isEmpty
            ? "Scan a card or add one manually."
            : "Try a different name, set, card number, or raw/graded filter."
    }

    private func portfolioControlRow(
        title: String,
        chips: [PortfolioControlChip]
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(theme.colors.textSecondary)
                .tracking(1.0)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(chips.enumerated()), id: \.offset) { _, chip in
                        chip
                    }
                }
            }
        }
    }

    private struct PortfolioControlChip: View {
        let title: String
        let isSelected: Bool
        let action: () -> Void

        @Environment(\.lootyTheme) private var theme

        var body: some View {
            Button(action: action) {
                Text(title)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(isSelected ? theme.colors.textInverse : theme.colors.textPrimary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(isSelected ? theme.colors.brand : theme.colors.surface)
                    .overlay(
                        Capsule()
                            .stroke(isSelected ? Color.clear : theme.colors.outlineSubtle, lineWidth: 1)
                    )
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }
}

struct PortfolioBatchSellPreviewSheet: View {
    let entries: [DeckCardEntry]
    let summary: PortfolioBatchSelectionSummary

    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme

    private var inkBackground: Color { theme.colors.canvas }
    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var fieldBackground: Color { theme.colors.surface }
    private var limeAccent: Color { theme.colors.brand }
    private var outline: Color { theme.colors.outlineSubtle }

    var body: some View {
        NavigationStack {
            ZStack {
                inkBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 18) {
                        summaryCard

                        VStack(alignment: .leading, spacing: 12) {
                            Text("Selected cards")
                                .font(.headline.weight(.bold))
                                .foregroundStyle(.white)

                            ForEach(entries) { entry in
                                row(entry)
                            }
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            Text("UI preview")
                                .font(.caption2.weight(.bold))
                                .tracking(0.7)
                                .foregroundStyle(.white.opacity(0.56))
                            Text("This is the batch-sell selection surface only. Wire the real sale mutation in your other tab, then we can connect this sheet to it.")
                                .font(.subheadline)
                                .foregroundStyle(.white.opacity(0.68))
                        }
                        .padding(16)
                        .lootySurface(.dark, padding: 16, cornerRadius: 20)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 18)
                    .padding(.bottom, 110)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    Rectangle()
                        .fill(outline)
                        .frame(height: 1)

                    Button {
                        dismiss()
                    } label: {
                        Text("Continue later")
                    }
                    .buttonStyle(
                        LootyFilledButtonStyle(
                            fill: limeAccent,
                            foreground: theme.colors.textInverse,
                            cornerRadius: 16,
                            minHeight: 52
                        )
                    )
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 12)
                    .background(inkBackground)
                }
            }
            .toolbarBackground(inkBackground, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .navigationTitle("Batch sell")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var summaryCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("SELECTION SUMMARY")
                .font(.caption2.weight(.bold))
                .tracking(0.7)
                .foregroundStyle(.white.opacity(0.56))

            HStack(spacing: 12) {
                metric(title: "Cards", value: "\(summary.cardCount)")
                metric(title: "Qty", value: "\(summary.quantity)")
                metric(
                    title: "Market value",
                    value: summary.marketValue > 0
                        ? summary.marketValue.formatted(.currency(code: summary.currencyCode).precision(.fractionLength(2)))
                        : "Unavailable"
                )
            }
        }
        .padding(16)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private func metric(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.56))
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.white)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(fieldBackground)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func row(_ entry: DeckCardEntry) -> some View {
        HStack(spacing: 12) {
            CardArtworkView(
                urlString: entry.card.imageSmallURL ?? entry.card.imageLargeURL,
                fallbackTitle: entry.card.name,
                cornerRadius: 12,
                contentMode: .fit
            )
            .frame(width: 56, height: 78)
            .background(Color.white.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: 5) {
                Text(entry.card.name)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                    .lineLimit(2)

                Text("#\(entry.card.number) • Qty \(entry.quantity)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.62))

                Text(
                    (entry.totalEntryValue ?? 0) > 0
                        ? (entry.totalEntryValue ?? 0).formatted(.currency(code: entry.card.pricing?.currencyCode ?? "USD").precision(.fractionLength(2)))
                        : "Market value unavailable"
                )
                .font(.caption.weight(.bold))
                .foregroundStyle((entry.totalEntryValue ?? 0) > 0 ? theme.colors.textPrimary : .white.opacity(0.54))
            }

            Spacer(minLength: 0)
        }
        .padding(12)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }
}

struct PortfolioPricingCalculatorCard: View {
    @Environment(\.lootyTheme) private var theme
    let currencyCode: String

    @State private var marketPriceText = ""
    @State private var listPriceText = ""
    @State private var percentOffText = ""
    @State private var dollarOffText = ""
    @State private var activePreset: PortfolioPriceCalculatorPreset = .eightyPercent

    private var inkBackground: Color { theme.colors.canvas }
    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var fieldBackground: Color { theme.colors.surface }
    private var limeAccent: Color { theme.colors.brand }
    private var outline: Color { theme.colors.outlineSubtle }

    private var marketPrice: Double { Double(marketPriceText) ?? 0 }
    private var listPrice: Double { Double(listPriceText) ?? 0 }
    private var percentOff: Double { Double(percentOffText) ?? 0 }
    private var dollarOff: Double { Double(dollarOffText) ?? 0 }

    private var resolvedPrice: Double {
        portfolioResolvedCalculatorPrice(
            marketPrice: marketPrice,
            listPrice: listPrice,
            percentOff: percentOff,
            dollarOff: dollarOff,
            preset: activePreset
        )
    }

    private var eightyPercentPriceValue: Double {
        portfolioEightyPercentPrice(from: marketPrice)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("QUICK PRICING")
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(theme.colors.textSecondary.opacity(0.76))

                Text("Market, list, % off, $ off, and an 80% quick target")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(theme.colors.textPrimary.opacity(0.82))
            }

            VStack(spacing: 12) {
                pricingInputGrid
                presetRow
                previewCard
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(inkBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private var pricingInputGrid: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                pricingField(title: "Market", text: $marketPriceText, placeholder: "0.00")
                pricingField(title: "List", text: $listPriceText, placeholder: "0.00")
            }

            HStack(spacing: 12) {
                pricingField(title: "% Off", text: $percentOffText, placeholder: "0")
                pricingField(title: "$ Off", text: $dollarOffText, placeholder: "0.00")
            }
        }
    }

    private var presetRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(PortfolioPriceCalculatorPreset.allCases) { preset in
                    Button {
                        activePreset = preset
                    } label: {
                        Text(preset.displayName)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(activePreset == preset ? .black : .white.opacity(0.82))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(activePreset == preset ? limeAccent : fieldBackground)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var previewCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Target price")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.56))
                    Text(formattedPrice(resolvedPrice))
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 4) {
                    Text("80% quick target")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.56))
                    Text(formattedPrice(eightyPercentPriceValue))
                        .font(.headline.weight(.bold))
                        .foregroundStyle(theme.colors.textPrimary)
                }
            }

            Divider()
                .overlay(Color.white.opacity(0.08))

            HStack(spacing: 10) {
                calculatorStat(title: "Market", value: formattedPrice(marketPrice))
                calculatorStat(title: "List", value: formattedPrice(listPrice))
                calculatorStat(title: "% Off", value: percentOffText.isEmpty ? "—" : "\(percentOffText)%")
                calculatorStat(title: "$ Off", value: formattedPrice(dollarOff))
            }
        }
        .padding(14)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private func pricingField(title: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white.opacity(0.56))

            TextField(placeholder, text: text)
                .keyboardType(.decimalPad)
                .textInputAutocapitalization(.never)
                .disableAutocorrection(true)
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .frame(height: 42)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(fieldBackground)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(outline, lineWidth: 1)
                )
        }
        .frame(maxWidth: .infinity)
    }

    private func calculatorStat(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white.opacity(0.56))
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func formattedPrice(_ value: Double) -> String {
        value.formatted(.currency(code: currencyCode).precision(.fractionLength(2)))
    }
}
