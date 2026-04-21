import SwiftUI

struct PortfolioImportView: View {
    @Environment(\.lootyTheme) private var theme

    @ObservedObject var collectionStore: CollectionStore
    @StateObject private var viewModel: PortfolioImportViewModel
    @State private var selectedRowForResolution: PortfolioImportRowPayload?

    init(
        selectedFile: PortfolioImportSelectedFile,
        collectionStore: CollectionStore,
        matcher: any CardMatchingService
    ) {
        self.collectionStore = collectionStore
        _viewModel = StateObject(
            wrappedValue: PortfolioImportViewModel(
                selectedFile: selectedFile,
                previewRequest: { payload in
                    try await matcher.previewPortfolioImport(payload)
                },
                fetchJobRequest: { jobID in
                    try await matcher.fetchPortfolioImportJob(jobID: jobID)
                },
                resolveRowRequest: { jobID, payload in
                    try await matcher.resolvePortfolioImportRow(jobID: jobID, payload: payload)
                },
                commitJobRequest: { jobID in
                    try await matcher.commitPortfolioImportJob(jobID: jobID)
                },
                refreshCollection: {
                    await collectionStore.refreshDashboardData()
                },
                searchCatalog: { query, limit in
                    await collectionStore.searchCatalogCards(query: query, limit: limit)
                }
            )
        )
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: theme.spacing.lg) {
                heroCard

                if let bannerMessage = viewModel.bannerMessage, !bannerMessage.isEmpty {
                    messageCard(
                        title: "Updated",
                        message: bannerMessage,
                        systemImage: "checkmark.circle.fill",
                        fill: theme.colors.brand.opacity(0.16)
                    )
                }

                if let errorMessage = viewModel.errorMessage, !errorMessage.isEmpty {
                    messageCard(
                        title: "Import issue",
                        message: errorMessage,
                        systemImage: "exclamationmark.triangle.fill",
                        fill: theme.colors.danger.opacity(0.12)
                    )
                }

                if viewModel.isLoadingPreview && viewModel.job == nil {
                    loadingCard
                } else if viewModel.job == nil {
                    retryCard
                } else {
                    summarySection
                    if let job = viewModel.job, !job.warnings.isEmpty {
                        warningsCard(warnings: job.warnings)
                    }
                    filterSection
                    rowsSection
                }
            }
            .padding(.horizontal, theme.spacing.xs)
            .padding(.top, theme.spacing.lg)
            .padding(.bottom, 120)
        }
        .background(theme.colors.canvas.ignoresSafeArea())
        .navigationTitle(viewModel.sourceType.reviewTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if viewModel.isRefreshing {
                    ProgressView()
                        .tint(theme.colors.brand)
                } else {
                    Button("Refresh") {
                        Task {
                            await viewModel.refresh()
                        }
                    }
                    .foregroundStyle(theme.colors.textPrimary)
                    .disabled(viewModel.isLoadingPreview || viewModel.job == nil)
                }
            }
        }
        .task {
            await viewModel.loadIfNeeded()
        }
        .safeAreaInset(edge: .bottom) {
            if viewModel.canCommit {
                commitBar
            }
        }
        .sheet(item: $selectedRowForResolution) { row in
            PortfolioImportResolveSheet(
                row: row,
                search: { query, limit in
                    await viewModel.searchCatalogCards(query: query, limit: limit)
                },
                ownedQuantity: { candidate in
                    collectionStore.quantity(card: candidate, slabContext: nil)
                },
                onResolve: { candidate in
                    await viewModel.resolve(row: row, with: candidate)
                },
                onSkip: {
                    await viewModel.skip(row: row)
                }
            )
        }
    }

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: theme.spacing.md) {
            HStack(alignment: .top, spacing: theme.spacing.md) {
                VStack(alignment: .leading, spacing: theme.spacing.xxxs) {
                    Text(viewModel.sourceType.reviewTitle)
                        .font(theme.typography.titleCompact)
                        .foregroundStyle(theme.colors.textPrimary)

                    Text(viewModel.sourceFileName)
                        .font(theme.typography.caption)
                        .foregroundStyle(theme.colors.textSecondary)
                        .lineLimit(2)
                }

                Spacer(minLength: theme.spacing.md)

                Text(viewModel.status.title)
                    .font(theme.typography.caption.weight(.bold))
                    .foregroundStyle(theme.colors.textInverse)
                    .padding(.horizontal, theme.spacing.sm)
                    .padding(.vertical, theme.spacing.xs)
                    .background(Capsule().fill(theme.colors.brand))
            }

            Text("Review every row before anything touches your inventory. Ready rows can be imported immediately, and the rest can be fixed in place.")
                .font(theme.typography.body)
                .foregroundStyle(theme.colors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lootySurface(.dark, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
    }

    private var loadingCard: some View {
        VStack(spacing: theme.spacing.md) {
            ProgressView()
                .tint(theme.colors.brand)

            Text("Building your preview")
                .font(theme.typography.headline)
                .foregroundStyle(theme.colors.textPrimary)

            Text("Parsing the CSV, matching cards locally, and sorting rows into clean review buckets.")
                .font(theme.typography.body)
                .foregroundStyle(theme.colors.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .lootySurface(.dark, padding: 24, cornerRadius: theme.radius.xl)
    }

    private var retryCard: some View {
        VStack(alignment: .leading, spacing: theme.spacing.md) {
            Text("Preview not loaded")
                .font(theme.typography.headline)
                .foregroundStyle(theme.colors.textPrimary)

            Text("Pick a file again or retry the preview request.")
                .font(theme.typography.body)
                .foregroundStyle(theme.colors.textSecondary)

            Button {
                Task {
                    await viewModel.retryPreview()
                }
            } label: {
                Text("Retry preview")
            }
            .buttonStyle(
                LootyFilledButtonStyle(
                    fill: theme.colors.brand,
                    foreground: theme.colors.textInverse,
                    cornerRadius: theme.radius.md,
                    minHeight: 48
                )
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lootySurface(.dark, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
    }

    private var summarySection: some View {
        VStack(alignment: .leading, spacing: theme.spacing.md) {
            LootySectionHeader(
                title: "Review Summary",
                subtitle: "Start with the rows that still need a decision."
            )

            let columns = [
                GridItem(.flexible(), spacing: theme.spacing.sm),
                GridItem(.flexible(), spacing: theme.spacing.sm)
            ]
            LazyVGrid(columns: columns, spacing: theme.spacing.sm) {
                summaryCard(title: "Rows", value: viewModel.summary.totalRowCount)
                summaryCard(title: "Ready", value: viewModel.readyRowCount)
                summaryCard(title: "Review", value: viewModel.summary.reviewCount + viewModel.summary.unresolvedCount)
                summaryCard(title: "Unsupported", value: viewModel.summary.unsupportedCount)
            }
        }
    }

    private func summaryCard(title: String, value: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(theme.typography.caption)
                .foregroundStyle(theme.colors.textSecondary)

            Text("\(max(0, value))")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(theme.colors.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lootySurface(.muted, padding: theme.spacing.lg, cornerRadius: theme.radius.lg)
    }

    private func warningsCard(warnings: [String]) -> some View {
        VStack(alignment: .leading, spacing: theme.spacing.sm) {
            Text("Source warnings")
                .font(theme.typography.headline)
                .foregroundStyle(theme.colors.textPrimary)

            ForEach(warnings, id: \.self) { warning in
                Text(warning)
                    .font(theme.typography.body)
                    .foregroundStyle(theme.colors.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lootySurface(.muted, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
    }

    private var filterSection: some View {
        VStack(alignment: .leading, spacing: theme.spacing.sm) {
            LootySectionHeader(
                title: "Rows",
                subtitle: "Focus on the buckets that matter first."
            )

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: theme.spacing.sm) {
                    ForEach(PortfolioImportRowFilter.allCases) { filter in
                        Button {
                            viewModel.selectedFilter = filter
                        } label: {
                            LootyPill(
                                title: "\(filter.title) \(viewModel.filterCount(filter))",
                                isSelected: viewModel.selectedFilter == filter
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private var rowsSection: some View {
        VStack(alignment: .leading, spacing: theme.spacing.sm) {
            if viewModel.filteredRows.isEmpty {
                Text("No rows in this bucket right now.")
                    .font(theme.typography.body)
                    .foregroundStyle(theme.colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lootySurface(.muted, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
            } else {
                ForEach(viewModel.filteredRows) { row in
                    PortfolioImportRowCard(row: row) {
                        selectedRowForResolution = row
                    }
                }
            }
        }
    }

    private var commitBar: some View {
        VStack(spacing: theme.spacing.sm) {
            Divider()
                .opacity(0.12)

            HStack(spacing: theme.spacing.md) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Ready to import")
                        .font(theme.typography.headline)
                        .foregroundStyle(theme.colors.textPrimary)

                    Text("\(viewModel.readyRowCount) row\(viewModel.readyRowCount == 1 ? "" : "s") can be added now.")
                        .font(theme.typography.caption)
                        .foregroundStyle(theme.colors.textSecondary)
                }

                Button {
                    Task {
                        _ = await viewModel.commitReadyRows()
                    }
                } label: {
                    if viewModel.isCommitting {
                        ProgressView()
                            .tint(theme.colors.textInverse)
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Import Ready Rows")
                    }
                }
                .buttonStyle(
                    LootyFilledButtonStyle(
                        fill: theme.colors.brand,
                        foreground: theme.colors.textInverse,
                        cornerRadius: theme.radius.md,
                        minHeight: 52
                    )
                )
                .frame(maxWidth: 220)
                .disabled(viewModel.isCommitting)
            }
            .padding(.horizontal, theme.spacing.lg)
            .padding(.top, theme.spacing.sm)
            .padding(.bottom, theme.spacing.sm)
        }
        .background(theme.colors.canvas.opacity(0.98))
    }

    private func messageCard(
        title: String,
        message: String,
        systemImage: String,
        fill: Color
    ) -> some View {
        HStack(alignment: .top, spacing: theme.spacing.md) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(theme.colors.textPrimary)
                .padding(10)
                .background(Circle().fill(fill))

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(theme.typography.headline)
                    .foregroundStyle(theme.colors.textPrimary)

                Text(message)
                    .font(theme.typography.body)
                    .foregroundStyle(theme.colors.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lootySurface(.dark, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
    }
}

private struct PortfolioImportRowCard: View {
    @Environment(\.lootyTheme) private var theme

    let row: PortfolioImportRowPayload
    let onResolve: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: theme.spacing.md) {
            HStack(alignment: .top, spacing: theme.spacing.md) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.displayTitle)
                        .font(theme.typography.headline)
                        .foregroundStyle(theme.colors.textPrimary)
                        .lineLimit(2)

                    if !row.detailLine.isEmpty {
                        Text(row.detailLine)
                            .font(theme.typography.body)
                            .foregroundStyle(theme.colors.textSecondary)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: theme.spacing.md)

                Text(row.matchState.title)
                    .font(theme.typography.caption.weight(.bold))
                    .foregroundStyle(badgeForeground)
                    .padding(.horizontal, theme.spacing.sm)
                    .padding(.vertical, theme.spacing.xs)
                    .background(Capsule().fill(badgeFill))
            }

            HStack(spacing: theme.spacing.sm) {
                LootyPill(
                    title: "Qty \(max(1, row.quantity))",
                    fill: theme.colors.surfaceMuted,
                    foreground: theme.colors.textPrimary
                )

                if let sourceCollectionName = row.sourceCollectionName,
                   !sourceCollectionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    LootyPill(
                        title: sourceCollectionName,
                        fill: theme.colors.surfaceMuted,
                        foreground: theme.colors.textPrimary
                    )
                }

                if let priceLine = row.priceLine {
                    LootyPill(
                        title: priceLine,
                        fill: theme.colors.surfaceMuted,
                        foreground: theme.colors.textPrimary
                    )
                }
            }

            if let matchedCard = row.matchedCard {
                HStack(spacing: theme.spacing.md) {
                    CardArtworkView(
                        urlString: matchedCard.imageSmallURL ?? matchedCard.imageLargeURL,
                        fallbackTitle: matchedCard.name,
                        cornerRadius: 14,
                        contentMode: .fit
                    )
                    .frame(width: 56, height: 78)
                    .background(theme.colors.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

                    VStack(alignment: .leading, spacing: 4) {
                        Text(matchedCard.name)
                            .font(theme.typography.body.weight(.semibold))
                            .foregroundStyle(theme.colors.textPrimary)
                            .lineLimit(2)

                        Text([matchedCard.setName, matchedCard.number].filter { !$0.isEmpty }.joined(separator: " • "))
                            .font(theme.typography.caption)
                            .foregroundStyle(theme.colors.textSecondary)
                            .lineLimit(2)
                    }

                    Spacer(minLength: 0)
                }
                .padding(theme.spacing.sm)
                .background(theme.colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }

            if let warning = row.warnings.first, !warning.isEmpty {
                Text(warning)
                    .font(theme.typography.caption)
                    .foregroundStyle(theme.colors.textSecondary)
            }

            if row.canResolve {
                Button {
                    onResolve()
                } label: {
                    Text(row.matchState.isReadyToCommit ? "Change Match" : "Resolve Row")
                }
                .buttonStyle(LootySecondaryButtonStyle())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lootySurface(.dark, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
    }

    private var badgeFill: Color {
        switch row.matchState {
        case .matched, .ready, .committed:
            return theme.colors.brand
        case .review, .unresolved, .failed:
            return Color.orange
        case .unsupported, .skipped, .unknown:
            return theme.colors.surfaceMuted
        }
    }

    private var badgeForeground: Color {
        switch row.matchState {
        case .unsupported, .skipped, .unknown:
            return theme.colors.textPrimary
        case .matched, .ready, .review, .unresolved, .committed, .failed:
            return theme.colors.textInverse
        }
    }
}

private struct PortfolioImportResolveSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme

    let row: PortfolioImportRowPayload
    let search: @MainActor @Sendable (String, Int) async -> [CardCandidate]
    let ownedQuantity: (CardCandidate) -> Int
    let onResolve: (CardCandidate) async -> Bool
    let onSkip: () async -> Bool

    @StateObject private var searchViewModel: ManualCardSearchViewModel
    @FocusState private var isSearchFocused: Bool
    @State private var isSubmitting = false
    @State private var localErrorMessage: String?

    init(
        row: PortfolioImportRowPayload,
        search: @escaping @MainActor @Sendable (String, Int) async -> [CardCandidate],
        ownedQuantity: @escaping (CardCandidate) -> Int,
        onResolve: @escaping (CardCandidate) async -> Bool,
        onSkip: @escaping () async -> Bool
    ) {
        self.row = row
        self.search = search
        self.ownedQuantity = ownedQuantity
        self.onResolve = onResolve
        self.onSkip = onSkip
        _searchViewModel = StateObject(
            wrappedValue: ManualCardSearchViewModel(
                resultLimit: 16,
                search: search
            )
        )
    }

    private var hasTypedQuery: Bool {
        searchViewModel.query.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2
    }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: theme.spacing.lg) {
                    rowCard
                    searchField

                    if let localErrorMessage, !localErrorMessage.isEmpty {
                        Text(localErrorMessage)
                            .font(theme.typography.body)
                            .foregroundStyle(theme.colors.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lootySurface(.muted, padding: theme.spacing.lg, cornerRadius: theme.radius.lg)
                    }

                    if !row.candidateCards.isEmpty && !hasTypedQuery {
                        candidateSection(title: "Suggested Matches", candidates: row.candidateCards)
                    }

                    if searchViewModel.isSearching {
                        ProgressView()
                            .tint(theme.colors.brand)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.vertical, theme.spacing.lg)
                    } else if hasTypedQuery && !searchViewModel.results.isEmpty {
                        candidateSection(title: "Search Results", candidates: searchViewModel.results)
                    } else if hasTypedQuery {
                        Text("No cards match that search yet.")
                            .font(theme.typography.body)
                            .foregroundStyle(theme.colors.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lootySurface(.muted, padding: theme.spacing.lg, cornerRadius: theme.radius.lg)
                    }

                    Button(role: .destructive) {
                        guard !isSubmitting else { return }
                        isSubmitting = true
                        localErrorMessage = nil
                        Task {
                            let didSkip = await onSkip()
                            await MainActor.run {
                                isSubmitting = false
                                if didSkip {
                                    dismiss()
                                } else {
                                    localErrorMessage = "This row could not be skipped right now."
                                }
                            }
                        }
                    } label: {
                        Text("Skip This Row")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(LootySecondaryButtonStyle())
                    .disabled(isSubmitting)
                }
                .padding(.horizontal, theme.spacing.xs)
                .padding(.top, theme.spacing.lg)
                .padding(.bottom, theme.spacing.xl)
            }
            .background(theme.colors.canvas.ignoresSafeArea())
            .navigationTitle("Resolve Row")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") {
                        dismiss()
                    }
                    .foregroundStyle(theme.colors.textPrimary)
                }
            }
            .onAppear {
                if searchViewModel.query.isEmpty {
                    searchViewModel.updateQuery(row.sourceCardName)
                }
                if !isSearchFocused {
                    isSearchFocused = true
                }
            }
        }
    }

    private var rowCard: some View {
        VStack(alignment: .leading, spacing: theme.spacing.sm) {
            Text(row.displayTitle)
                .font(theme.typography.titleCompact)
                .foregroundStyle(theme.colors.textPrimary)

            if !row.detailLine.isEmpty {
                Text(row.detailLine)
                    .font(theme.typography.body)
                    .foregroundStyle(theme.colors.textSecondary)
            }

            HStack(spacing: theme.spacing.sm) {
                LootyPill(
                    title: "Qty \(max(1, row.quantity))",
                    fill: theme.colors.surfaceMuted,
                    foreground: theme.colors.textPrimary
                )

                if let sourceCollectionName = row.sourceCollectionName,
                   !sourceCollectionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    LootyPill(
                        title: sourceCollectionName,
                        fill: theme.colors.surfaceMuted,
                        foreground: theme.colors.textPrimary
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lootySurface(.dark, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(theme.colors.textSecondary)

            TextField(
                "Search by name, set, or number",
                text: Binding(
                    get: { searchViewModel.query },
                    set: { searchViewModel.updateQuery($0) }
                )
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.search)
            .focused($isSearchFocused)
            .foregroundStyle(theme.colors.textPrimary)
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(theme.colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(theme.colors.outlineSubtle, lineWidth: 1)
        )
    }

    private func candidateSection(title: String, candidates: [CardCandidate]) -> some View {
        VStack(alignment: .leading, spacing: theme.spacing.sm) {
            Text(title)
                .font(theme.typography.headline)
                .foregroundStyle(theme.colors.textPrimary)

            VStack(spacing: theme.spacing.sm) {
                ForEach(candidates) { candidate in
                    candidateRow(candidate)
                }
            }
        }
    }

    private func candidateRow(_ candidate: CardCandidate) -> some View {
        Button {
            guard !isSubmitting else { return }
            isSubmitting = true
            localErrorMessage = nil
            Task {
                let didResolve = await onResolve(candidate)
                await MainActor.run {
                    isSubmitting = false
                    if didResolve {
                        dismiss()
                    } else {
                        localErrorMessage = "That card could not be applied to this row."
                    }
                }
            }
        } label: {
            HStack(alignment: .top, spacing: theme.spacing.md) {
                CardArtworkView(
                    urlString: candidate.imageSmallURL ?? candidate.imageLargeURL,
                    fallbackTitle: candidate.name,
                    cornerRadius: 14,
                    contentMode: .fit
                )
                .frame(width: 58, height: 82)
                .background(theme.colors.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(theme.colors.outlineSubtle, lineWidth: 1)
                )

                VStack(alignment: .leading, spacing: 6) {
                    Text(candidate.name)
                        .font(theme.typography.body.weight(.semibold))
                        .foregroundStyle(theme.colors.textPrimary)
                        .lineLimit(2)

                    Text([candidate.setName, candidate.number].filter { !$0.isEmpty }.joined(separator: " • "))
                        .font(theme.typography.caption)
                        .foregroundStyle(theme.colors.textSecondary)
                        .lineLimit(2)

                    let owned = ownedQuantity(candidate)
                    if owned > 0 {
                        Text("Owned \(owned)")
                            .font(theme.typography.caption.weight(.bold))
                            .foregroundStyle(theme.colors.brand)
                    }
                }

                Spacer(minLength: 0)

                if isSubmitting {
                    ProgressView()
                        .tint(theme.colors.brand)
                } else {
                    Text("Use")
                        .font(theme.typography.caption.weight(.bold))
                        .foregroundStyle(theme.colors.brand)
                }
            }
            .padding(theme.spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(theme.colors.outlineSubtle, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting)
    }
}
