import SwiftUI

struct ManualCardSearchView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme
    
    @ObservedObject var collectionStore: CollectionStore
    @ObservedObject var scannerViewModel: ScannerViewModel
    @ObservedObject var showsState: ShowsMockState
    let onOpenScanner: () -> Void
    
    @StateObject private var viewModel: ManualCardSearchViewModel
    @FocusState private var isSearchFieldFocused: Bool
    @State private var openingCandidateID: String?
    @State private var selectedEntry: DeckCardEntry?

    init(
        collectionStore: CollectionStore,
        scannerViewModel: ScannerViewModel,
        showsState: ShowsMockState,
        onOpenScanner: @escaping () -> Void
    ) {
        self.collectionStore = collectionStore
        self.scannerViewModel = scannerViewModel
        self.showsState = showsState
        self.onOpenScanner = onOpenScanner
        _viewModel = StateObject(
            wrappedValue: ManualCardSearchViewModel { query, limit in
                await collectionStore.searchCatalogCards(query: query, limit: limit)
            }
        )
    }

    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var fieldBackground: Color { theme.colors.surface }
    private var outline: Color { theme.colors.outlineSubtle }
    private var accent: Color { theme.colors.brand }

    private var trimmedQuery: String {
        viewModel.query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var hasActiveQuery: Bool {
        trimmedQuery.count >= 2
    }

    var body: some View {
        NavigationStack {
            ZStack {
                theme.colors.pageLight.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 18) {
                        header
                        searchField

                        if viewModel.isSearching && viewModel.results.isEmpty {
                            loadingState
                        } else if let errorMessage = viewModel.errorMessage {
                            errorState(message: errorMessage)
                        } else if !hasActiveQuery {
                            EmptyView()
                        } else if viewModel.results.isEmpty {
                            emptyResultsState
                        } else {
                            resultsList
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 24)
                }
            }
            .navigationBarHidden(true)
            .onAppear {
                if !isSearchFieldFocused {
                    isSearchFieldFocused = true
                }
            }
            .navigationDestination(item: $selectedEntry) { entry in
                ManualCardSearchDetailDestination(
                    entry: entry,
                    scannerViewModel: scannerViewModel,
                    collectionStore: collectionStore,
                    showsState: showsState
                ) {
                    scannerViewModel.dismissResultDetail()
                    selectedEntry = nil
                }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("Add Card")
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(theme.colors.textPrimary)

            Spacer(minLength: 8)

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(theme.colors.textPrimary)
                    .frame(width: 38, height: 38)
                    .background(theme.colors.surfaceMuted)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close manual search")
        }
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(theme.colors.textSecondary)

            TextField("Search by name, set, or number", text: Binding(
                get: { viewModel.query },
                set: { viewModel.updateQuery($0) }
            ))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.search)
            .foregroundStyle(theme.colors.textPrimary)
            .focused($isSearchFieldFocused)
            .onSubmit {
                viewModel.submitCurrentQuery()
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(fieldBackground)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private var loadingState: some View {
        searchStateCard {
            VStack(spacing: 14) {
                ProgressView()
                    .tint(accent)

                Text("Searching catalog")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(theme.colors.textPrimary)

                Text("Looking up matching cards and inventory quantities.")
                    .font(.subheadline)
                    .foregroundStyle(theme.colors.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func errorState(message: String) -> some View {
        searchStateCard {
            VStack(alignment: .leading, spacing: 14) {
                Label("Search unavailable", systemImage: "exclamationmark.triangle.fill")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(theme.colors.textPrimary)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(theme.colors.textSecondary)

                HStack(spacing: 12) {
                    Button {
                        viewModel.submitCurrentQuery()
                    } label: {
                        Text("Retry")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(
                        LootyFilledButtonStyle(
                            fill: accent,
                            foreground: theme.colors.textInverse,
                            cornerRadius: 14,
                            minHeight: 46
                        )
                    )

                    Button {
                        dismiss()
                        Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(120))
                            onOpenScanner()
                        }
                    } label: {
                        Text("Open Scanner")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(LootySecondaryButtonStyle())
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var emptyResultsState: some View {
        searchStateCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("No matching cards")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(theme.colors.textPrimary)

                Text("Try a shorter query, a different set name, or just the collector number.")
                    .font(.subheadline)
                    .foregroundStyle(theme.colors.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var resultsList: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(viewModel.results.count) result\(viewModel.results.count == 1 ? "" : "s")")
                .font(.headline.weight(.semibold))
                .foregroundStyle(theme.colors.textPrimary)

            VStack(spacing: 10) {
                ForEach(viewModel.results) { candidate in
                    ManualCardSearchResultRow(
                        candidate: candidate,
                        ownedQuantity: collectionStore.quantity(card: candidate, slabContext: nil),
                        isLoading: openingCandidateID == candidate.id
                    ) {
                        openCandidate(candidate)
                    }
                }
            }
        }
    }

    private func searchStateCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(surfaceBackground)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(outline, lineWidth: 1)
            )
    }

    private func openCandidate(_ candidate: CardCandidate) {
        guard openingCandidateID == nil else { return }
        openingCandidateID = candidate.id

        Task {
            let detail = await collectionStore.fetchCardDetail(cardID: candidate.id, slabContext: nil)
            let resolvedCard = detail?.card ?? candidate
            let resolvedSlabContext = detail?.slabContext
            let previewEntry = await MainActor.run {
                collectionStore.previewEntry(
                    card: resolvedCard,
                    slabContext: resolvedSlabContext,
                    quantityFallback: 1
                )
            }

            await MainActor.run {
                openingCandidateID = nil
                scannerViewModel.presentResultDetail(for: previewEntry)
                selectedEntry = previewEntry
            }
        }
    }
}

private struct ManualCardSearchDetailDestination: View {
    let entry: DeckCardEntry
    @ObservedObject var scannerViewModel: ScannerViewModel
    @ObservedObject var collectionStore: CollectionStore
    @ObservedObject var showsState: ShowsMockState
    let onDismiss: () -> Void

    var body: some View {
        ScanResultDetailView(
            viewModel: scannerViewModel,
            collectionStore: collectionStore,
            showsState: showsState,
            onDismissOverride: onDismiss
        )
        .toolbar(.hidden, for: .navigationBar)
        .onAppear {
            scannerViewModel.presentResultDetail(for: entry)
        }
    }
}

private struct ManualCardSearchResultRow: View {
    @Environment(\.lootyTheme) private var theme

    let candidate: CardCandidate
    let ownedQuantity: Int
    let isLoading: Bool
    let onTap: () -> Void

    private var surfaceBackground: Color { theme.colors.surface }
    private var outline: Color { theme.colors.outlineSubtle }
    private var accent: Color { theme.colors.brand }

    private var displayNumber: String {
        let trimmed = candidate.number.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "No number" }
        return trimmed.hasPrefix("#") ? trimmed : "#\(trimmed)"
    }

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 12) {
                CardArtworkView(
                    urlString: candidate.imageSmallURL ?? candidate.imageLargeURL,
                    fallbackTitle: candidate.name,
                    cornerRadius: 14,
                    contentMode: .fit
                )
                .frame(width: 64, height: 90)
                .background(theme.colors.canvasElevated)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(outline, lineWidth: 1)
                )

                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(candidate.name)
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(theme.colors.textPrimary)
                                .lineLimit(2)

                            Text(candidate.setName)
                                .font(.subheadline)
                                .foregroundStyle(theme.colors.textSecondary)
                                .lineLimit(2)
                        }

                        Spacer(minLength: 6)

                        if ownedQuantity > 0 {
                            Text("Owned \(ownedQuantity)")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(accent)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 5)
                                .background(accent.opacity(0.14))
                                .clipShape(Capsule())
                        }
                    }

                    HStack(spacing: 8) {
                        Label(displayNumber, systemImage: "number")
                            .labelStyle(.titleAndIcon)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(theme.colors.textSecondary)

                        if let pricing = candidate.pricing,
                           let value = pricing.primaryDisplayPrice {
                            Text(formattedPrice(value, currencyCode: pricing.currencyCode))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(theme.colors.textSecondary)
                        }
                    }
                }

                if isLoading {
                    ProgressView()
                        .tint(accent)
                        .padding(.top, 2)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(theme.colors.textSecondary.opacity(0.65))
                        .padding(.top, 2)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(surfaceBackground)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(outline, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .opacity(isLoading ? 0.82 : 1)
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityLabel("\(candidate.name), \(candidate.setName), \(displayNumber)")
    }

    private func formattedPrice(_ value: Double, currencyCode: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 0
        formatter.minimumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }
}
