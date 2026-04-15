import SwiftUI

enum DeckSortOption: String, CaseIterable, Identifiable {
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

func sortedDeckEntries(_ entries: [DeckCardEntry], by sortOption: DeckSortOption) -> [DeckCardEntry] {
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

struct ScannerRootView: View {
    @ObservedObject var viewModel: ScannerViewModel
    @ObservedObject var collectionStore: CollectionStore
    @ObservedObject var showsState: ShowsMockState
    let onExitScanner: (() -> Void)?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ScannerView(
                viewModel: viewModel,
                collectionStore: collectionStore,
                showsState: showsState,
                onExitScanner: onExitScanner
            )
                .transition(.opacity)

            if viewModel.route == .resultDetail {
                ScanResultDetailView(
                    viewModel: viewModel,
                    collectionStore: collectionStore,
                    showsState: showsState
                )
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                    .zIndex(2)
            } else if viewModel.route == .alternatives {
                AlternateMatchesView(viewModel: viewModel)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                    .zIndex(3)
            }

            if let bannerMessage = viewModel.bannerMessage {
                VStack {
                    Spacer()
                    Text(bannerMessage)
                        .font(.headline)
                        .foregroundStyle(.black)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 12)
                        .background(Color(red: 0.47, green: 0.84, blue: 0.68))
                        .clipShape(Capsule())
                        .padding(.bottom, 28)
                }
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.24), value: viewModel.route)
        .animation(.easeInOut(duration: 0.2), value: viewModel.bannerMessage)
    }
}

struct DeckView: View {
    let onSelectEntry: (DeckCardEntry) -> Void
    @ObservedObject var collectionStore: CollectionStore
    let onOpenScanner: () -> Void
    let onOpenShows: () -> Void
    @State private var searchQuery = ""
    @State private var sortOption: DeckSortOption = .recentlyAdded
    @FocusState private var isSearchFieldFocused: Bool

    private let inkBackground = Color(red: 0.04, green: 0.05, blue: 0.07)
    private let surfaceBackground = Color(red: 0.10, green: 0.09, blue: 0.14)
    private let fieldBackground = Color(red: 0.15, green: 0.13, blue: 0.19)
    private let limeAccent = Color(red: 0.79, green: 0.92, blue: 0.36)
    private let outline = Color.white.opacity(0.08)

    private var filteredEntries: [DeckCardEntry] {
        sortedDeckEntries(collectionStore.searchResults(for: searchQuery), by: sortOption)
    }

    private let columns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14)
    ]

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                inkBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 26) {
                        profileHeader
                        cardsSection
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 18)
                    .padding(.bottom, 104 + max(proxy.safeAreaInsets.bottom, 0))
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                AppShellBottomBar(
                    selectedTab: .deck,
                    onOpenPortfolio: {},
                    onOpenScanner: onOpenScanner,
                    onOpenShows: onOpenShows
                )
            }
            .refreshable {
                await collectionStore.refreshFromBackend()
            }
        }
    }

    private var profileHeader: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 14) {
                ZStack(alignment: .bottomTrailing) {
                    Circle()
                        .fill(surfaceBackground)
                        .frame(width: 54, height: 54)
                        .overlay {
                            Text("S")
                                .font(.system(size: 22, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                        }

                    Circle()
                        .fill(fieldBackground)
                        .frame(width: 20, height: 20)
                        .overlay {
                            Image(systemName: "plus")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(.white)
                        }
                        .overlay(Circle().stroke(outline, lineWidth: 1))
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Your Portfolio")
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)

                    Text("Track cards and jump back into scanning.")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.58))
                }

                Spacer()
            }

            HStack(spacing: 12) {
                profileMetric(
                    value: "\(collectionStore.totalCardCount)",
                    label: "Cards"
                )
                profileMetric(
                    value: formattedPrice(collectionStore.totalValue),
                    label: "Value"
                )
            }
        }
    }

    private func profileMetric(value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(.system(size: 21, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.62))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 14)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private var cardsSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("All cards")
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)

            HStack(spacing: 12) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.white.opacity(0.45))

                    TextField("Search cards", text: $searchQuery)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                        .foregroundStyle(.white)
                        .focused($isSearchFieldFocused)
                }
                .padding(.horizontal, 14)
                .frame(height: 46)
                .background(fieldBackground)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .contentShape(Rectangle())
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(outline, lineWidth: 1)
                )
                .onTapGesture {
                    isSearchFieldFocused = true
                }

                sortMenu
            }

            if filteredEntries.isEmpty {
                emptyState
            } else {
                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach(filteredEntries) { entry in
                        deckCard(entry)
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(collectionStore.entries.isEmpty ? "No cards in your portfolio yet" : "No cards match that search")
                .font(.headline.weight(.semibold))
                .foregroundStyle(.white)

            Text(collectionStore.entries.isEmpty
                ? "Scan a card and tap ADD to move it into your portfolio."
                : "Try a different name, set, or card number.")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.62))
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

    private var sortMenu: some View {
        Menu {
            ForEach(DeckSortOption.allCases) { option in
                Button {
                    sortOption = option
                } label: {
                    if option == sortOption {
                        Label(option.displayName, systemImage: "checkmark")
                    } else {
                        Text(option.displayName)
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "arrow.up.arrow.down")
                    .font(.system(size: 14, weight: .semibold))
                Text(sortOption.compactLabel)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(.white.opacity(0.82))
            .padding(.horizontal, 12)
            .frame(height: 46)
            .background(fieldBackground)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(outline, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func deckCard(_ entry: DeckCardEntry) -> some View {
        Button {
            onSelectEntry(entry)
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                CardArtworkView(
                    urlString: entry.card.imageSmallURL ?? entry.card.imageLargeURL,
                    fallbackTitle: entry.card.name,
                    cornerRadius: 16,
                    contentMode: .fit
                )
                .frame(maxWidth: .infinity)
                .frame(height: 172)
                .background(Color.white.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                Text(entry.card.name)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let condition = entry.condition {
                    Text(condition.displayName)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(limeAccent)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(limeAccent.opacity(0.12))
                        .clipShape(Capsule())
                }

                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(formattedPrice(entry.primaryPrice, currencyCode: entry.card.pricing?.currencyCode ?? "USD"))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(limeAccent)

                    if entry.quantity > 1 {
                        Text("QTY \(entry.quantity)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 4)
                            .background(limeAccent)
                            .clipShape(Capsule())
                    }

                    if let grader = entry.slabContext?.grader,
                       let grade = entry.slabContext?.grade {
                        Text("\(grader) \(grade)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white.opacity(0.68))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Text("#\(entry.card.number)  \(entry.card.setName)")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.62))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .background(surfaceBackground)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(outline, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func formattedPrice(_ value: Double?, currencyCode: String = "USD") -> String {
        guard let value else {
            return "Unavailable"
        }

        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }
}

struct AppShellBottomBar: View {
    let selectedTab: AppShellTab
    let onOpenPortfolio: () -> Void
    let onOpenScanner: () -> Void
    let onOpenShows: () -> Void

    private let inkBackground = Color(red: 0.04, green: 0.05, blue: 0.07)
    private let outline = Color.white.opacity(0.08)
    private let limeAccent = Color(red: 0.79, green: 0.92, blue: 0.36)

    var body: some View {
        HStack(alignment: .center, spacing: 18) {
            shellTabItem(
                systemName: "square.stack.fill",
                title: "Portfolio",
                isSelected: selectedTab == .deck,
                action: onOpenPortfolio
            )

            Button(action: onOpenScanner) {
                VStack(spacing: 6) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 13, style: .continuous)
                            .fill(selectedTab == .scan ? limeAccent : Color.white.opacity(0.10))
                            .frame(width: 52, height: 52)

                        Image(systemName: "camera.viewfinder")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(selectedTab == .scan ? .black : .white)
                    }

                    Text("Scan")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(selectedTab == .scan ? .white : .white.opacity(0.70))
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)

            shellTabItem(
                systemName: "ticket.fill",
                title: "Shows",
                isSelected: selectedTab == .shows,
                action: onOpenShows
            )
        }
        .padding(.horizontal, 28)
        .padding(.top, 6)
        .padding(.bottom, 4)
        .background(
            Rectangle()
                .fill(inkBackground.opacity(0.98))
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(outline)
                        .frame(height: 1)
                }
                .ignoresSafeArea(edges: .bottom)
        )
    }

    private func shellTabItem(
        systemName: String,
        title: String,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemName)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(isSelected ? .white : .white.opacity(0.52))

                Text(title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(isSelected ? .white : .white.opacity(0.52))
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }
}

@MainActor
final class ShowsMockState: ObservableObject {
    @Published var activeShow: ShowSessionMock? = .sampleActive
    @Published var presentedFlow: ShowsPresentedFlow?

    let recentShows: [ShowSessionMock] = [
        .sampleActive,
        .austin,
        .anaheim
    ]

    func startSampleShow() {
        activeShow = .sampleActive
    }

    func endShow() {
        activeShow = nil
    }

    func presentSell(
        entry: DeckCardEntry,
        title: String,
        subtitle: String? = nil,
        quantityLimit: Int? = nil
    ) {
        guard let activeShow else { return }
        presentedFlow = .sell(
            ShowSellDraft(
                title: title,
                subtitle: subtitle,
                entry: entry,
                show: activeShow,
                suggestedPrice: entry.primaryPrice ?? 0,
                quantityLimit: quantityLimit ?? max(1, entry.quantity)
            )
        )
    }

    func presentTrade(previewEntry: DeckCardEntry) {
        guard let activeShow else { return }
        presentedFlow = .trade(
            ShowTradeDraft(
                show: activeShow,
                previewEntry: previewEntry
            )
        )
    }
}

struct ShowSellDraft: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String?
    let entry: DeckCardEntry
    let show: ShowSessionMock
    let suggestedPrice: Double
    let quantityLimit: Int
}

struct ShowTradeDraft: Identifiable {
    let id = UUID()
    let show: ShowSessionMock
    let previewEntry: DeckCardEntry
}

enum ShowsPresentedFlow: Identifiable {
    case sell(ShowSellDraft)
    case trade(ShowTradeDraft)

    var id: String {
        switch self {
        case .sell(let draft):
            return "sell-\(draft.id.uuidString)"
        case .trade(let draft):
            return "trade-\(draft.id.uuidString)"
        }
    }
}

enum ShowActivityKind {
    case sale
    case buy
    case trade
    case expense

    var tint: Color {
        switch self {
        case .sale:
            return Color(red: 0.30, green: 0.88, blue: 0.54)
        case .buy:
            return Color(red: 0.94, green: 0.64, blue: 0.28)
        case .trade:
            return Color(red: 0.48, green: 0.74, blue: 0.96)
        case .expense:
            return Color(red: 0.91, green: 0.39, blue: 0.41)
        }
    }

    var iconName: String {
        switch self {
        case .sale:
            return "arrow.up.right.square.fill"
        case .buy:
            return "arrow.down.left.square.fill"
        case .trade:
            return "arrow.left.arrow.right.square.fill"
        case .expense:
            return "creditcard.fill"
        }
    }
}

struct ShowActivityMock: Identifiable {
    let id = UUID()
    let kind: ShowActivityKind
    let title: String
    let subtitle: String
    let amountText: String
    let note: String?
}

struct ShowSessionMock: Identifiable {
    let id = UUID()
    let title: String
    let location: String
    let dateLabel: String
    let boothLabel: String?
    let grossSales: Double
    let cashSpent: Double
    let netCash: Double
    let cardsSold: Int
    let cardsBought: Int
    let tradeCount: Int
    let activities: [ShowActivityMock]

    static let sampleActive = ShowSessionMock(
        title: "Dallas Card Show",
        location: "Dallas, TX",
        dateLabel: "Apr 14–15 • Active now",
        boothLabel: "Table B12",
        grossSales: 1284,
        cashSpent: 420,
        netCash: 864,
        cardsSold: 16,
        cardsBought: 5,
        tradeCount: 3,
        activities: [
            ShowActivityMock(
                kind: .sale,
                title: "Sold Dark Weezing",
                subtitle: "Scan tray quick sell",
                amountText: "+$68.00",
                note: "Venmo • Qty 1"
            ),
            ShowActivityMock(
                kind: .trade,
                title: "Trade completed",
                subtitle: "Gave Umbreon V • Got Blastoise ex + cash",
                amountText: "+$40.00",
                note: "1-for-1 + cash"
            ),
            ShowActivityMock(
                kind: .buy,
                title: "Bought Sabrina's Slowbro",
                subtitle: "Manual add from binder walk",
                amountText: "-$22.00",
                note: "Cash"
            )
        ]
    )

    static let austin = ShowSessionMock(
        title: "Collect-A-Con Austin",
        location: "Austin, TX",
        dateLabel: "Mar 8 • Closed",
        boothLabel: "Walk-up deals",
        grossSales: 940,
        cashSpent: 265,
        netCash: 675,
        cardsSold: 11,
        cardsBought: 4,
        tradeCount: 2,
        activities: []
    )

    static let anaheim = ShowSessionMock(
        title: "Anaheim Trade Day",
        location: "Anaheim, CA",
        dateLabel: "Feb 11 • Closed",
        boothLabel: nil,
        grossSales: 522,
        cashSpent: 188,
        netCash: 334,
        cardsSold: 7,
        cardsBought: 3,
        tradeCount: 1,
        activities: []
    )
}

struct ShowsView: View {
    @ObservedObject var state: ShowsMockState
    @ObservedObject var collectionStore: CollectionStore
    let onOpenPortfolio: () -> Void
    let onOpenScanner: () -> Void

    private let inkBackground = Color(red: 0.04, green: 0.05, blue: 0.07)
    private let surfaceBackground = Color(red: 0.10, green: 0.09, blue: 0.14)
    private let fieldBackground = Color(red: 0.15, green: 0.13, blue: 0.19)
    private let limeAccent = Color(red: 0.79, green: 0.92, blue: 0.36)
    private let outline = Color.white.opacity(0.08)

    private var previewEntry: DeckCardEntry {
        collectionStore.entries.first ?? DeckCardEntry(
            id: "raw|base5-14",
            card: CardCandidate(
                id: "base5-14",
                name: "Dark Weezing",
                setName: "Team Rocket",
                number: "14/82",
                rarity: "Rare Holo",
                variant: "1st Edition",
                language: "English",
                imageSmallURL: nil,
                imageLargeURL: nil,
                pricing: CardPricingSummary(
                    source: "scrydex",
                    currencyCode: "USD",
                    variant: nil,
                    low: nil,
                    market: 68,
                    mid: nil,
                    high: nil,
                    directLow: nil,
                    trend: nil,
                    updatedAt: nil,
                    refreshedAt: nil,
                    sourceURL: nil,
                    pricingMode: nil,
                    snapshotAgeHours: nil,
                    freshnessWindowHours: nil,
                    isFresh: true,
                    grader: nil,
                    grade: nil,
                    pricingTier: nil,
                    confidenceLabel: nil,
                    confidenceLevel: nil,
                    compCount: nil,
                    recentCompCount: nil,
                    lastSoldPrice: nil,
                    lastSoldAt: nil,
                    bucketKey: nil,
                    methodologySummary: nil
                )
            ),
            slabContext: nil,
            condition: .nearMint,
            quantity: 2,
            addedAt: Date()
        )
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                inkBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 24) {
                        showsHeader
                        if let activeShow = state.activeShow {
                            activeShowCard(activeShow)
                            showMetrics(activeShow)
                            quickActionSection
                            activitySection(activeShow)
                        } else {
                            emptyShowState
                        }
                        pastShowsSection
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 18)
                    .padding(.bottom, 108 + max(proxy.safeAreaInsets.bottom, 0))
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                AppShellBottomBar(
                    selectedTab: .shows,
                    onOpenPortfolio: onOpenPortfolio,
                    onOpenScanner: onOpenScanner,
                    onOpenShows: {}
                )
            }
        }
    }

    private var showsHeader: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Shows")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)

                Text("Bookkeeping during a show: quick sells, trades, buys, and a running session ledger.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.64))
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 8) {
                Text("EARLY")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(limeAccent)
                    .clipShape(Capsule())

                Button(state.activeShow == nil ? "Start show" : "End show") {
                    if state.activeShow == nil {
                        state.startSampleShow()
                    } else {
                        state.endShow()
                    }
                }
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(fieldBackground)
                .clipShape(Capsule())
            }
        }
    }

    private func activeShowCard(_ show: ShowSessionMock) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(show.title)
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                    Text("\(show.location) • \(show.dateLabel)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.74))
                }

                Spacer()

                Text("SHOW MODE ON")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(limeAccent)
                    .clipShape(Capsule())
            }

            HStack(spacing: 10) {
                showChip(show.boothLabel ?? "Walking inventory", icon: "mappin.and.ellipse")
                showChip("Inventory linked", icon: "square.stack.3d.up.fill")
                showChip("Deals auto-tagged", icon: "checkmark.seal.fill")
            }

            Text("When this is active, scan and portfolio actions can feed into the current show ledger so bookkeeping stays attached to the event.")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.66))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(surfaceBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private func showChip(_ title: String, icon: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
            Text(title)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.white.opacity(0.84))
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.06))
        .clipShape(Capsule())
    }

    private func showMetrics(_ show: ShowSessionMock) -> some View {
        HStack(spacing: 12) {
            showMetric(value: formattedPrice(show.grossSales), label: "Gross sales")
            showMetric(value: formattedPrice(show.netCash), label: "Net cash")
            showMetric(value: "\(show.cardsSold + show.cardsBought + show.tradeCount)", label: "Deals")
        }
    }

    private func showMetric(value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.58))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private var quickActionSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Show actions")
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)

            VStack(spacing: 12) {
                showActionCard(
                    title: "Quick sell from scan",
                    subtitle: "Swipe the tray row, tap Sell, then confirm final price, payment, and quantity 1.",
                    icon: "arrowshape.left.fill",
                    tint: Color(red: 0.30, green: 0.88, blue: 0.54)
                ) {
                    state.presentSell(
                        entry: previewEntry,
                        title: "Sell Card",
                        quantityLimit: 1
                    )
                }

                showActionCard(
                    title: "Sell from portfolio",
                    subtitle: "Find a card in Portfolio, tap Sell, and log the exact sold price during the show.",
                    icon: "dollarsign.circle.fill",
                    tint: Color(red: 0.96, green: 0.72, blue: 0.32)
                ) {
                    state.presentSell(
                        entry: previewEntry,
                        title: "Sell Card"
                    )
                }

                showActionCard(
                    title: "Trade builder",
                    subtitle: "Track cards out, cards in, and optional cash delta in one show ticket.",
                    icon: "arrow.left.arrow.right.circle.fill",
                    tint: Color(red: 0.48, green: 0.74, blue: 0.96)
                ) {
                    state.presentTrade(previewEntry: previewEntry)
                }
            }
        }
    }

    private func showActionCard(
        title: String,
        subtitle: String,
        icon: String,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(tint.opacity(0.18))
                        .frame(width: 52, height: 52)
                    Image(systemName: icon)
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(tint)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white)
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.64))
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white.opacity(0.44))
            }
            .padding(16)
            .background(surfaceBackground)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(outline, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func activitySection(_ show: ShowSessionMock) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Recent activity")
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)

            VStack(spacing: 12) {
                ForEach(show.activities) { activity in
                    HStack(spacing: 14) {
                        ZStack {
                            Circle()
                                .fill(activity.kind.tint.opacity(0.18))
                                .frame(width: 42, height: 42)
                            Image(systemName: activity.kind.iconName)
                                .font(.system(size: 18, weight: .bold))
                                .foregroundStyle(activity.kind.tint)
                        }

                        VStack(alignment: .leading, spacing: 4) {
                            Text(activity.title)
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(.white)
                            Text(activity.subtitle)
                                .font(.caption)
                                .foregroundStyle(.white.opacity(0.62))
                            if let note = activity.note {
                                Text(note)
                                    .font(.caption2)
                                    .foregroundStyle(.white.opacity(0.48))
                            }
                        }

                        Spacer()

                        Text(activity.amountText)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(activity.kind.tint)
                    }
                    .padding(14)
                    .background(surfaceBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(outline, lineWidth: 1)
                    )
                }
            }
        }
    }

    private var emptyShowState: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("No active show")
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)

            Text("Start show mode before the event and let every sale, trade, and buy attach to a single session ledger.")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.66))

            Button("Start show") {
                state.startSampleShow()
            }
            .font(.headline.weight(.semibold))
            .foregroundStyle(.black)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .background(limeAccent)
            .clipShape(Capsule())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private var pastShowsSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Past shows")
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)

            VStack(spacing: 12) {
                ForEach(state.recentShows.filter { state.activeShow?.id != $0.id }) { show in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(show.title)
                                    .font(.headline.weight(.bold))
                                    .foregroundStyle(.white)
                                Text("\(show.location) • \(show.dateLabel)")
                                    .font(.caption)
                                    .foregroundStyle(.white.opacity(0.60))
                            }
                            Spacer()
                            Text(formattedPrice(show.netCash))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(limeAccent)
                        }

                        HStack(spacing: 12) {
                            archivedMetric("\(show.cardsSold)", "Sold")
                            archivedMetric("\(show.cardsBought)", "Bought")
                            archivedMetric("\(show.tradeCount)", "Trades")
                        }
                    }
                    .padding(16)
                    .background(surfaceBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(outline, lineWidth: 1)
                    )
                }
            }
        }
    }

    private func archivedMetric(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.white)
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.white.opacity(0.54))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func formattedPrice(_ value: Double, currencyCode: String = "USD") -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }
}

struct ShowSellPreviewSheet: View {
    let draft: ShowSellDraft

    @Environment(\.dismiss) private var dismiss
    @State private var quantity = 1
    @State private var soldPriceText: String
    @State private var note = ""
    @State private var paymentMethod = "Cash"

    init(draft: ShowSellDraft) {
        self.draft = draft
        _soldPriceText = State(initialValue: String(format: "%.2f", draft.suggestedPrice))
    }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 14) {
                        CardArtworkView(
                            urlString: draft.entry.card.imageSmallURL ?? draft.entry.card.imageLargeURL,
                            fallbackTitle: draft.entry.card.name,
                            cornerRadius: 16,
                            contentMode: .fit
                        )
                        .frame(width: 86, height: 120)
                        .background(Color.white.opacity(0.05))
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                        VStack(alignment: .leading, spacing: 8) {
                            Text(draft.entry.card.name)
                                .font(.headline.weight(.bold))
                            Text("\(draft.entry.card.setName) • #\(draft.entry.card.number)")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Text(draft.show.title)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text("Available Qty \(draft.entry.quantity)")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.secondary)
                        }
                    }

                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Quantity")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.secondary)
                            Stepper(value: $quantity, in: 1...max(1, draft.quantityLimit)) {
                                Text("\(quantity)")
                                    .font(.headline.weight(.bold))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)

                        VStack(alignment: .leading, spacing: 8) {
                            Text("Sell price")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.secondary)
                            TextField("0.00", text: $soldPriceText)
                                .keyboardType(.decimalPad)
                                .textFieldStyle(.roundedBorder)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Payment method")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.secondary)
                        HStack(spacing: 8) {
                            ForEach(["Cash", "Venmo", "PayPal"], id: \.self) { method in
                                Button(method) {
                                    paymentMethod = method
                                }
                                .font(.caption.weight(.bold))
                                .foregroundStyle(paymentMethod == method ? .black : .primary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(paymentMethod == method ? Color(red: 0.79, green: 0.92, blue: 0.36) : Color(.secondarySystemBackground))
                                .clipShape(Capsule())
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Note")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.secondary)
                        TextField("Buyer, booth, or bundle detail", text: $note)
                            .textFieldStyle(.roundedBorder)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 12)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    Divider()
                    Button {
                        dismiss()
                    } label: {
                        Text("CONFIRM SALE")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.black)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color(red: 0.79, green: 0.92, blue: 0.36))
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 12)
                    .background(.ultraThinMaterial)
                }
            }
            .navigationTitle("Sell Card")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

struct ShowTradePreviewSheet: View {
    let draft: ShowTradeDraft

    @Environment(\.dismiss) private var dismiss
    @State private var cashDeltaText = "40"
    @State private var note = "Umbreon V trade-up"

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Trade builder")
                        .font(.title3.weight(.bold))
                    Text("One ticket for cards out, cards in, and optional cash delta during \(draft.show.title).")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 12) {
                    tradeColumn(
                        title: "You gave",
                        cards: [draft.previewEntry.card.name, "Umbreon V #95"],
                        tint: Color(red: 0.91, green: 0.39, blue: 0.41)
                    )
                    tradeColumn(
                        title: "You got",
                        cards: ["Blastoise ex #009", "Cash"],
                        tint: Color(red: 0.30, green: 0.88, blue: 0.54)
                    )
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Cash delta")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                    TextField("0", text: $cashDeltaText)
                        .keyboardType(.decimalPad)
                        .textFieldStyle(.roundedBorder)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Note")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                    TextField("Add trade context", text: $note)
                        .textFieldStyle(.roundedBorder)
                }

                Button {
                    dismiss()
                } label: {
                    Text("COMPLETE TRADE")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color(red: 0.79, green: 0.92, blue: 0.36))
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }

                Spacer(minLength: 0)
            }
            .padding(20)
            .navigationTitle("Trade flow")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") {
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func tradeColumn(title: String, cards: [String], tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline.weight(.bold))
                .foregroundStyle(.white)
            ForEach(cards, id: \.self) { card in
                Text(card)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.84))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color.white.opacity(0.05))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(tint.opacity(0.18))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
