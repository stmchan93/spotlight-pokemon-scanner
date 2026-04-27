import SwiftUI

struct AlternateMatchesView: View {
    @Environment(\.lootyTheme) private var theme
    @ObservedObject var viewModel: ScannerViewModel
    @State private var isSearchExpanded = false

    private var accent: Color { theme.colors.brand }
    private var pageBackground: Color { theme.colors.pageLight }
    private var panelBackground: Color { theme.colors.canvasElevated }
    private var fieldBackground: Color { theme.colors.field }
    private var primaryText: Color { theme.colors.textPrimary }
    private var secondaryText: Color { theme.colors.textSecondary }
    private var rowDivider: Color { theme.colors.outlineSubtle }

    private var topCandidates: [ScoredCandidate] {
        viewModel.activeAlternativesResponse?.topCandidates ?? []
    }

    private var bestMatch: ScoredCandidate? {
        topCandidates.first
    }

    private var similarMatches: [ScoredCandidate] {
        Array(topCandidates.dropFirst())
    }

    private var resultCountText: String {
        let count = topCandidates.count
        return "\(count) \(count == 1 ? "card" : "cards") found"
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 26) {
                header
                scanPreview
                closestMatchSection
                similarMatchesSection
                manualSearchSection

                if shouldShowSearchResults {
                    searchResultsSection
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 40)
        }
        .background(background.ignoresSafeArea())
        .onAppear {
            isSearchExpanded = !viewModel.searchQuery.isEmpty || !viewModel.searchResults.isEmpty
        }
    }

    private var background: some View {
        pageBackground
    }

    private var shouldShowSearchResults: Bool {
        isSearchExpanded && !viewModel.searchResults.isEmpty
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                viewModel.dismissAlternatives()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.left")
                    Text("Back")
                }
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(secondaryText)
            }
            .buttonStyle(.plain)

            Spacer()

            Text(resultCountText)
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(primaryText)

            Spacer()

            Color.clear
                .frame(width: 36, height: 36)
        }
    }

    private var scanPreview: some View {
        VStack(spacing: 14) {
            if let previewImage = viewModel.activeAlternativesPreviewImage {
                Image(uiImage: previewImage)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 266, height: 310)
                    .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                    .shadow(color: theme.shadow.color, radius: theme.shadow.radius, y: theme.shadow.y)
            } else {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(fieldBackground)
                    .frame(width: 266, height: 310)
                    .overlay(
                        Image(systemName: "photo")
                            .font(.title.weight(.semibold))
                            .foregroundStyle(secondaryText)
                    )
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 34)
        .padding(.bottom, 14)
    }

    @ViewBuilder
    private var closestMatchSection: some View {
        if let bestMatch {
            VStack(alignment: .leading, spacing: 12) {
                Text("Closest Match")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(accent)

                Button {
                    viewModel.presentCandidateDetail(bestMatch.candidate)
                } label: {
                    candidateRow(
                        candidate: bestMatch.candidate,
                        detailLabel: estimatedValueLabel(for: bestMatch.candidate),
                        emphasize: true
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var similarMatchesSection: some View {
        if !similarMatches.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("\(similarMatches.count) similar \(similarMatches.count == 1 ? "card" : "cards")")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(primaryText)

                ForEach(similarMatches) { candidate in
                    Button {
                        viewModel.presentCandidateDetail(candidate.candidate)
                    } label: {
                        candidateRow(
                            candidate: candidate.candidate,
                            detailLabel: estimatedValueLabel(for: candidate.candidate),
                            emphasize: false
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var manualSearchSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isSearchExpanded.toggle()
                    if !isSearchExpanded {
                        viewModel.updateSearchQuery("")
                    }
                }
            } label: {
                Text("Are these wrong?")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(primaryText)
            }
            .buttonStyle(.plain)

            if isSearchExpanded {
                Text("Search by name, set, or number, or go back and rescan.")
                    .font(.subheadline)
                    .foregroundStyle(secondaryText)

                TextField("Search by name, set, or number", text: Binding(
                    get: { viewModel.searchQuery },
                    set: { viewModel.updateSearchQuery($0) }
                ))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(16)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(panelBackground)
                )
                .foregroundStyle(primaryText)
            }

            Button {
                viewModel.dismissAlternatives()
            } label: {
                Text("Back To Scanner")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(secondaryText)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(fieldBackground)
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }

    private var searchResultsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Search Results")
                .font(.headline.weight(.semibold))
                .foregroundStyle(primaryText)

            ForEach(viewModel.searchResults) { candidate in
                Button {
                    viewModel.presentCandidateDetail(candidate)
                } label: {
                    candidateRow(
                        candidate: candidate,
                        detailLabel: estimatedValueLabel(for: candidate),
                        emphasize: false
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func candidateRow(candidate: CardCandidate, detailLabel: String, emphasize: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 14) {
                CandidateThumbnail(candidate: candidate)

                VStack(alignment: .leading, spacing: 6) {
                    Text("\(candidate.setName) • \(candidate.language)".uppercased())
                        .font(.caption.weight(.bold))
                        .foregroundStyle(secondaryText)
                        .lineLimit(2)

                    Text("\(candidate.name) #\(candidate.number)")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(primaryText)
                        .lineLimit(2)

                    Text(detailLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(emphasize ? primaryText : secondaryText)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(secondaryText)
                    .padding(.top, 4)
            }
            .padding(.vertical, 6)

            Rectangle()
                .fill(rowDivider)
                .frame(height: 1)
                .padding(.leading, 78)
        }
    }

    private func estimatedValueLabel(for candidate: CardCandidate) -> String {
        guard let pricing = candidate.pricing,
              let price = pricing.primaryDisplayPrice else {
            return "EST VALUE unavailable"
        }
        return "EST VALUE \(formattedEstimatePrice(price, currencyCode: pricing.currencyCode))"
    }

    private func formattedEstimatePrice(_ value: Double, currencyCode: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 0
        formatter.minimumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }
}

private struct CandidateThumbnail: View {
    @Environment(\.lootyTheme) private var theme
    let candidate: CardCandidate

    var body: some View {
        Group {
            if let urlString = candidate.imageSmallURL ?? candidate.imageLargeURL,
               let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
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
        .frame(width: 64, height: 90)
        .background(theme.colors.field)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    @ViewBuilder
    private var fallback: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(theme.colors.field)
            .overlay(
                Text(String(candidate.name.prefix(1)))
                    .font(.headline.weight(.bold))
                    .foregroundStyle(theme.colors.textSecondary)
            )
    }
}
