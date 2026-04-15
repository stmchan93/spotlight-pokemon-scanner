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
    let onExitScanner: (() -> Void)?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ScannerView(
                viewModel: viewModel,
                collectionStore: collectionStore,
                onExitScanner: onExitScanner
            )
                .transition(.opacity)

            if viewModel.route == .resultDetail {
                ScanResultDetailView(viewModel: viewModel, collectionStore: collectionStore)
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
                deckTabBar()
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

    private func deckTabBar() -> some View {
        HStack(alignment: .center, spacing: 18) {
            deckTabItem(systemName: "square.stack.fill", title: "Portfolio", isSelected: true)

            Button(action: onOpenScanner) {
                VStack(spacing: 6) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 13, style: .continuous)
                            .fill(limeAccent)
                            .frame(width: 52, height: 52)

                        Image(systemName: "camera.viewfinder")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(.black)
                    }

                    Text("Scan")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
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

    private func deckTabItem(systemName: String, title: String, isSelected: Bool) -> some View {
        Button(action: {}) {
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
