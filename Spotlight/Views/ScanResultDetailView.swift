import Charts
import SwiftUI

struct ScanResultDetailView: View {
    @Environment(\.openURL) private var openURL
    @ObservedObject var viewModel: ScannerViewModel
    @ObservedObject var collectionStore: CollectionStore
    @State private var marketHistory: CardMarketHistory?
    @State private var isLoadingMarketHistory = false
    @State private var selectedHistoryVariant: String?
    @State private var selectedHistoryCondition: String?
    @State private var loadedHistoryCardID: String?

    private let limeAccent = Color(red: 0.78, green: 0.92, blue: 0.47)
    private let inkBackground = Color(red: 0.04, green: 0.05, blue: 0.07)
    private let panelBackground = Color(red: 0.12, green: 0.12, blue: 0.16)
    private let secondaryPanelBackground = Color(red: 0.16, green: 0.16, blue: 0.20)

    private var item: LiveScanStackItem? {
        viewModel.activeResultItem
    }

    private var card: CardCandidate? {
        item?.displayCard
    }

    private var pricing: CardPricingSummary? {
        item?.pricing
    }

    private var historyContextKey: String {
        let cardID = card?.id ?? "none"
        let grader = item?.slabContext?.grader ?? "raw"
        let grade = item?.slabContext?.grade ?? ""
        let variant = selectedHistoryVariant ?? "default"
        let condition = selectedHistoryCondition ?? "default"
        return [cardID, grader, grade, variant, condition].joined(separator: "|")
    }

    private var portfolioQuantity: Int {
        guard let card else {
            return 0
        }
        return collectionStore.quantity(card: card, slabContext: item?.slabContext)
    }

    private var persistedCondition: DeckCardCondition? {
        guard let card else {
            return nil
        }
        return collectionStore.condition(card: card, slabContext: item?.slabContext)
    }

    private var displayedCondition: DeckCardCondition {
        persistedCondition ?? .nearMint
    }

    var body: some View {
        ZStack {
            background

            if let item, let card {
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 24) {
                        header(card: card)
                        similarCardsBanner(item: item)
                        heroImage(card: card)
                        metadataChips(card: card)
                        titleBlock(card: card, item: item)
                        conditionSection(card: card, item: item)
                        marketplaceLinksSection(card: card, item: item)
                        actionButtons(card: card, item: item)
                        pricingSection(item: item, card: card)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 40)
                }
                .task(id: historyContextKey) {
                    await loadMarketHistoryIfNeeded(card: card, item: item)
                }
            } else {
                VStack(spacing: 16) {
                    Text("Result unavailable")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(.white)

                    Button("Back") {
                        viewModel.dismissResultDetail()
                    }
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(Color(red: 0.78, green: 0.92, blue: 0.47))
                    .clipShape(Capsule())
                }
            }
        }
    }

    private var background: some View {
        ZStack {
            inkBackground.ignoresSafeArea()

            LinearGradient(
                colors: [
                    Color(red: 0.21, green: 0.19, blue: 0.15).opacity(0.62),
                    Color.clear,
                    Color(red: 0.06, green: 0.07, blue: 0.10).opacity(0.85)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            Circle()
                .fill(Color(red: 0.58, green: 0.72, blue: 0.32).opacity(0.09))
                .frame(width: 320, height: 320)
                .blur(radius: 48)
                .offset(x: 0, y: -250)
        }
    }

    private func header(card: CardCandidate) -> some View {
        HStack(spacing: 12) {
            Button {
                viewModel.dismissResultDetail()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Color.white.opacity(0.06))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .frame(width: 40, alignment: .leading)

            Spacer()
        }
    }

    @ViewBuilder
    private func similarCardsBanner(item: LiveScanStackItem) -> some View {
        if viewModel.hasAlternatives(for: item.id) {
            Button {
                viewModel.showAlternatives(for: item.id)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "photo.stack.fill")
                        .foregroundStyle(limeAccent)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(viewModel.similarMatchCount(for: item.id)) similar cards found")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)

                        if item.phase == .needsReview {
                            Text("Best guess only. Check similar matches.")
                                .font(.caption)
                                .foregroundStyle(Color.white.opacity(0.66))
                        }
                    }

                    Spacer()

                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color.white.opacity(0.56))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(Color(red: 0.14, green: 0.17, blue: 0.10).opacity(0.88))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(limeAccent.opacity(0.78), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
        }
    }

    private func heroImage(card: CardCandidate) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.18, green: 0.15, blue: 0.12).opacity(0.9),
                            Color(red: 0.07, green: 0.07, blue: 0.08)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .frame(height: 330)

            Ellipse()
                .fill(Color.white.opacity(0.16))
                .frame(width: 176, height: 30)
                .blur(radius: 14)
                .offset(y: 112)

            Circle()
                .fill(limeAccent.opacity(0.12))
                .frame(width: 250, height: 250)
                .blur(radius: 32)
                .offset(y: -8)

            CardArtworkView(
                urlString: card.imageLargeURL ?? card.imageSmallURL,
                fallbackTitle: card.name,
                cornerRadius: 20,
                contentMode: .fit
            )
                .frame(width: 220, height: 308)
                .shadow(color: .black.opacity(0.42), radius: 28, y: 16)
        }
    }

    private func metadataChips(card: CardCandidate) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("Pokemon", background: Color(red: 0.24, green: 0.14, blue: 0.18))
                chip(card.setName, background: secondaryPanelBackground)
                chip(card.language, background: secondaryPanelBackground)
                if !card.variant.isEmpty {
                    chip(card.variant, background: secondaryPanelBackground)
                }
            }
        }
    }

    private func chip(_ title: String, background: Color) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white.opacity(0.82))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(background)
            .clipShape(Capsule())
    }

    private func titleBlock(card: CardCandidate, item: LiveScanStackItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(card.name) #\(card.number)")
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(2)

            if item.phase == .needsReview {
                Text(item.reviewReason ?? "Best guess only. Check similar cards before relying on this result.")
                    .font(.subheadline)
                    .foregroundStyle(Color(red: 0.96, green: 0.82, blue: 0.45))
            } else if let note = detailSubtitleNote(for: item) {
                Text(note)
                    .font(.subheadline)
                    .foregroundStyle(Color.white.opacity(0.66))
            }
        }
    }

    @ViewBuilder
    private func conditionSection(card: CardCandidate, item: LiveScanStackItem) -> some View {
        if item.resolverMode == .rawCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Card condition")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white)

                    Spacer()

                    if persistedCondition != nil {
                        Text(displayedCondition.shortLabel)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(limeAccent)
                            .clipShape(Capsule())
                    }
                }

                Menu {
                    ForEach(DeckCardCondition.allCases) { condition in
                        Button {
                            saveCondition(condition, card: card, item: item)
                        } label: {
                            if displayedCondition == condition {
                                Label(condition.displayName, systemImage: "checkmark")
                            } else {
                                Text(condition.displayName)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 12) {
                        Text(displayedCondition.displayName)
                            .font(.system(size: 18, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white)

                        Spacer()

                        Image(systemName: "chevron.down")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white.opacity(0.76))
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color.white.opacity(0.04))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(Color.white.opacity(0.08), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            }
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color.white.opacity(0.05))
            )
        }
    }

    private func detailSubtitleNote(for item: LiveScanStackItem) -> String? {
        let note = item.pricingContextNote ?? item.statusMessage
        guard let note, note != item.pricing?.freshnessLabel else {
            return nil
        }
        return note
    }

    private func marketplaceLinksSection(card: CardCandidate, item: LiveScanStackItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let pricing {
                Text("Pricing source: \(pricing.sourceLabel)")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.62))
            }

            VStack(spacing: 10) {
                marketplaceLinkRow(
                    title: "TCGplayer",
                    icon: "cart.fill",
                    action: {
                        openMarketplaceURL(
                            CardMarketplaceLinks.tcgPlayerSearchURL(card: card, slabContext: item.slabContext),
                            failureMessage: "Could not open TCGplayer"
                        )
                    }
                )

                marketplaceLinkRow(
                    title: "eBay",
                    icon: "shippingbox.fill",
                    action: {
                        openMarketplaceURL(
                            CardMarketplaceLinks.eBaySearchURL(card: card, slabContext: item.slabContext),
                            failureMessage: "Could not open eBay"
                        )
                    }
                )
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color.white.opacity(0.05))
        )
    }

    private func marketplaceLinkRow(
        title: String,
        icon: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(limeAccent)
                    .frame(width: 30, height: 30)
                    .background(Color.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                Text(title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .layoutPriority(1)

                Spacer()

                Text("View all listings")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(limeAccent)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)

                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(limeAccent)
            }
            .padding(.horizontal, 14)
            .frame(height: 54)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(0.04))
            )
        }
        .buttonStyle(.plain)
    }

    private func actionButtons(card: CardCandidate, item: LiveScanStackItem) -> some View {
        Button {
            let appliedCondition = persistedCondition ?? .nearMint
            let quantity = collectionStore.add(card: card, slabContext: item.slabContext, condition: appliedCondition)
            viewModel.recordDeckAddition(itemID: item.id, card: card, slabContext: item.slabContext, condition: appliedCondition)
            viewModel.showBannerMessage("\(card.name) added to portfolio • Qty \(quantity)")
        } label: {
            HStack {
                Label("ADD TO PORTFOLIO", systemImage: "plus.square.fill")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.86))
                Spacer()
                if portfolioQuantity > 0 {
                    Text("QTY \(portfolioQuantity)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color(red: 0.78, green: 0.92, blue: 0.47))
                        .clipShape(Capsule())
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .padding(.horizontal, 18)
            .background(panelBackground)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func pricingSection(item: LiveScanStackItem, card: CardCandidate) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center) {
                Text("Market value")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.white)

                Spacer()

                if let grader = item.slabContext?.grader, let grade = item.slabContext?.grade {
                    menuChip("\(grader) \(grade)")
                }
            }

            if isLoadingMarketHistory && marketHistory == nil {
                HStack(spacing: 12) {
                    ProgressView()
                        .tint(.white)
                    Text("Loading market history…")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.76))
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                )
            } else if let history = marketHistory,
                      let primaryPrice = history.currentPrice {
                VStack(alignment: .leading, spacing: 10) {
                    Text(formattedPrice(primaryPrice, currencyCode: history.currencyCode))
                        .font(.system(size: 42, weight: .bold, design: .rounded))
                        .foregroundStyle(historyPriceTint(history))

                    historyDeltaRow(history)

                    marketHistoryChart(history)

                    if !history.availableConditions.isEmpty {
                        conditionPicker(history)
                    }
                    if let selectedCondition = history.selectedCondition {
                        detailRow("Condition", selectedCondition)
                    }
                }
                .padding(18)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                )
            } else if let pricing,
                      let primaryPrice = pricing.primaryDisplayPrice {
                VStack(alignment: .leading, spacing: 10) {
                    Text(formattedPrice(primaryPrice, currencyCode: pricing.currencyCode))
                        .font(.system(size: 42, weight: .bold, design: .rounded))
                        .foregroundStyle(Color(red: 0.32, green: 0.90, blue: 0.53))

                    if let spreadText = pricing.spreadText {
                        detailRow("Range", spreadText)
                    }
                }
                .padding(18)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                )
            } else {
                Text("Market value is unavailable.")
                    .font(.subheadline)
                    .foregroundStyle(Color.white.opacity(0.68))
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                )
            }
        }
    }

    private func historyDeltaRow(_ history: CardMarketHistory) -> some View {
        HStack(spacing: 16) {
            historyDeltaLabel(title: "this week", delta: history.deltas.days7, currencyCode: history.currencyCode)
            historyDeltaLabel(title: "last 2 weeks", delta: history.deltas.days14, currencyCode: history.currencyCode)
            historyDeltaLabel(title: "last month", delta: history.deltas.days30, currencyCode: history.currencyCode)
        }
    }

    private func historyDeltaLabel(title: String, delta: MarketHistoryDelta?, currencyCode: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let delta,
               let priceChange = delta.priceChange {
                let positive = priceChange >= 0
                let prefix = positive ? "+" : "-"
                let absolutePrice = abs(priceChange)
                let absolutePercent = abs(delta.percentChange ?? 0)
                Text("\(prefix)\(formattedPrice(absolutePrice, currencyCode: currencyCode)) (\(String(format: "%.2f", absolutePercent))%)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(positive ? Color(red: 0.32, green: 0.90, blue: 0.53) : Color(red: 0.94, green: 0.46, blue: 0.46))
                Text(title)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.58))
            } else {
                Text("—")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white.opacity(0.46))
                Text(title)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.58))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func marketHistoryChart(_ history: CardMarketHistory) -> some View {
        Group {
            if history.points.isEmpty {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.white.opacity(0.03))
                    .overlay {
                        VStack(spacing: 8) {
                            Image(systemName: "chart.line.uptrend.xyaxis")
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(Color.white.opacity(0.72))
                            Text("Chart history is still populating.")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white.opacity(0.78))
                            Text("It will appear automatically as local price history builds.")
                                .font(.caption)
                                .foregroundStyle(.white.opacity(0.56))
                        }
                        .multilineTextAlignment(.center)
                        .padding(20)
                    }
            } else {
                Chart(history.points) { point in
                    if let value = point.primaryValue,
                       let date = chartDate(for: point.date) {
                        AreaMark(
                            x: .value("Date", date),
                            y: .value("Price", value)
                        )
                        .foregroundStyle(
                            LinearGradient(
                                colors: [
                                    historyPriceTint(history).opacity(0.38),
                                    historyPriceTint(history).opacity(0.14),
                                    Color.clear
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )

                        LineMark(
                            x: .value("Date", date),
                            y: .value("Price", value)
                        )
                        .interpolationMethod(.catmullRom)
                        .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                        .foregroundStyle(historyPriceTint(history))

                        PointMark(
                            x: .value("Date", date),
                            y: .value("Price", value)
                        )
                        .symbolSize(history.points.count == 1 ? 72 : 20)
                        .foregroundStyle(historyPriceTint(history))
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 3)) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            .foregroundStyle(Color.white.opacity(0.08))
                        AxisValueLabel {
                            if let date = value.as(Date.self) {
                                Text(chartAxisLabel(for: date))
                                    .font(.caption2)
                                    .foregroundStyle(Color.white.opacity(0.55))
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            .foregroundStyle(Color.white.opacity(0.08))
                        AxisValueLabel {
                            if let price = value.as(Double.self) {
                                Text(compactPrice(price, currencyCode: history.currencyCode))
                                    .font(.caption2)
                                    .foregroundStyle(Color.white.opacity(0.55))
                            }
                        }
                    }
                }
                .chartPlotStyle { plot in
                    plot
                        .background(Color.white.opacity(0.03))
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }
        }
        .frame(height: 210)
    }

    private func conditionPicker(_ history: CardMarketHistory) -> some View {
        HStack(spacing: 10) {
            ForEach(history.availableConditions) { option in
                Button {
                    guard selectedHistoryCondition != option.id else { return }
                    selectedHistoryCondition = option.id
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(option.label)
                            .font(.caption.weight(.bold))
                        if let optionPrice = option.currentPrice {
                            Text(formattedPrice(optionPrice, currencyCode: history.currencyCode))
                                .font(
                                    option.id == (selectedHistoryCondition ?? history.selectedCondition)
                                        ? .headline.weight(.bold)
                                        : .subheadline.weight(.semibold)
                                )
                        }
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(option.id == (selectedHistoryCondition ?? history.selectedCondition)
                                ? Color.white.opacity(0.12)
                                : Color.white.opacity(0.05))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(option.id == (selectedHistoryCondition ?? history.selectedCondition)
                                ? Color.white.opacity(0.42)
                                : Color.white.opacity(0.08),
                                    lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func historyPriceTint(_ history: CardMarketHistory) -> Color {
        guard let days30 = history.deltas.days30?.priceChange else {
            return Color(red: 0.32, green: 0.90, blue: 0.53)
        }
        return days30 >= 0
            ? Color(red: 0.32, green: 0.90, blue: 0.53)
            : Color(red: 0.94, green: 0.46, blue: 0.46)
    }

    private func chartDate(for value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: value)
    }

    private func chartAxisLabel(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d"
        return formatter.string(from: date)
    }

    private func compactPrice(_ value: Double, currencyCode: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = value < 10 ? 2 : 0
        formatter.minimumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }

    private func formattedChartDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    private func loadMarketHistoryIfNeeded(card: CardCandidate, item: LiveScanStackItem) async {
        if loadedHistoryCardID != card.id {
            loadedHistoryCardID = card.id
            selectedHistoryVariant = nil
            selectedHistoryCondition = nil
            marketHistory = nil
        }
        if item.resolverMode == .rawCard,
           selectedHistoryCondition == nil {
            selectedHistoryCondition = "NM"
        }
        let requestedVariant = selectedHistoryVariant
        let requestedCondition = item.resolverMode == .rawCard ? selectedHistoryCondition : nil
        if let existingHistory = marketHistory,
           loadedHistoryCardID == card.id,
           existingHistory.selectedVariant == requestedVariant,
           existingHistory.selectedCondition == requestedCondition {
            return
        }
        isLoadingMarketHistory = true
        let history = await viewModel.fetchMarketHistory(
            cardID: card.id,
            slabContext: item.slabContext,
            days: 30,
            variant: requestedVariant,
            condition: requestedCondition
        )
        guard item.id == viewModel.activeResultItem?.id else {
            isLoadingMarketHistory = false
            return
        }
        marketHistory = history
        if selectedHistoryVariant == nil {
            selectedHistoryVariant = history?.selectedVariant
        }
        if item.resolverMode == .rawCard {
            if selectedHistoryCondition == nil || !(history?.availableConditions.contains(where: { $0.id == selectedHistoryCondition }) ?? false) {
                selectedHistoryCondition = history?.selectedCondition
            }
        } else {
            selectedHistoryCondition = nil
        }
        isLoadingMarketHistory = false
    }

    private func saveCondition(_ condition: DeckCardCondition, card: CardCandidate, item: LiveScanStackItem) {
        guard persistedCondition != condition else {
            return
        }

        let mutation = collectionStore.setCondition(
            card: card,
            slabContext: item.slabContext,
            condition: condition
        )
        if mutation.inserted {
            viewModel.recordDeckAddition(
                itemID: item.id,
                card: card,
                slabContext: item.slabContext,
                condition: condition
            )
            viewModel.showBannerMessage("\(card.name) saved • \(condition.displayName)")
        } else if mutation.pendingBackendCreate {
            viewModel.updatePendingDeckAdditionCondition(
                itemID: item.id,
                card: card,
                slabContext: item.slabContext,
                condition: condition
            )
            viewModel.showBannerMessage("Condition saved • \(condition.displayName)")
        } else {
            Task {
                await collectionStore.syncCondition(
                    card: card,
                    slabContext: item.slabContext,
                    condition: condition
                )
            }
            viewModel.showBannerMessage("Condition saved • \(condition.displayName)")
        }
    }

    private func menuChip(_ title: String) -> some View {
        HStack(spacing: 6) {
            Text(title)
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.bold))
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.white.opacity(0.82))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.08))
        .clipShape(Capsule())
    }

    private func detailRow(_ title: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(Color.white.opacity(0.42))
                .frame(width: 72, alignment: .leading)

            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            Spacer(minLength: 0)
        }
    }

    private func formattedPrice(_ value: Double, currencyCode: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }

    private func openMarketplaceURL(_ url: URL?, failureMessage: String) {
        guard let url else {
            viewModel.showBannerMessage(failureMessage)
            return
        }
        openURL(url)
    }
}

struct CardArtworkView: View {
    let urlString: String?
    let fallbackTitle: String
    var cornerRadius: CGFloat = 20
    var contentMode: ContentMode = .fit

    var body: some View {
        Group {
            if let urlString, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: contentMode)
                    case .failure(_):
                        fallback
                    case .empty:
                        fallback
                    @unknown default:
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }

    private var fallback: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Color.white.opacity(0.08))
            .overlay(
                Text(String(fallbackTitle.prefix(1)))
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.78))
            )
    }
}
