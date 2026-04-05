import SwiftUI

struct AlternateMatchesView: View {
    @ObservedObject var viewModel: ScannerViewModel

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 20) {
                header
                searchField
                alternateMatchesSection

                if !viewModel.searchResults.isEmpty {
                    searchResultsSection
                }
            }
            .padding(20)
            .padding(.bottom, 32)
        }
        .background(Color(red: 0.04, green: 0.05, blue: 0.07).ignoresSafeArea())
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Fix This Match")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                Text("The scan was weak. Pick a better match or search manually without leaving the scanner flow.")
                    .font(.subheadline)
                    .foregroundStyle(Color.white.opacity(0.7))
            }

            Spacer()

            Button("Dismiss") {
                viewModel.dismissAlternatives()
            }
            .foregroundStyle(Color.white.opacity(0.78))
        }
    }

    private var searchField: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Search")
                .font(.headline)
                .foregroundStyle(.white)

            TextField("Search by name, set, or number", text: Binding(
                get: { viewModel.searchQuery },
                set: { viewModel.updateSearchQuery($0) }
            ))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(red: 0.12, green: 0.16, blue: 0.20))
            )
            .foregroundStyle(.white)
        }
    }

    private var alternateMatchesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let bestMatch = viewModel.matchResponse?.bestMatch {
                Button {
                    viewModel.acceptBestMatch()
                } label: {
                    matchCell(
                        title: bestMatch.name,
                        subtitle: bestMatch.subtitle,
                        detail: bestMatch.pricingLine ?? bestMatch.detailLine,
                        score: viewModel.matchResponse?.topCandidates.first?.finalScore,
                        badge: "Use Top"
                    )
                }
                .buttonStyle(.plain)
            }

            Text("Likely Alternatives")
                .font(.headline)
                .foregroundStyle(.white)

            if let topCandidates = viewModel.matchResponse?.topCandidates.dropFirst() {
                ForEach(topCandidates) { candidate in
                    Button {
                        let correctionType: CorrectionType = candidate.rank == 1 ? .acceptedTop : .choseAlternative
                        viewModel.selectCandidate(candidate.candidate, correctionType: correctionType)
                    } label: {
                    matchCell(
                        title: candidate.candidate.name,
                        subtitle: candidate.candidate.subtitle,
                        detail: candidate.candidate.pricingLine ?? "\(candidate.candidate.rarity) • \(candidate.candidate.variant)",
                        score: candidate.finalScore,
                        badge: candidate.rank == 1 ? "Top" : "Alt"
                    )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var searchResultsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Search Results")
                .font(.headline)
                .foregroundStyle(.white)

            ForEach(viewModel.searchResults) { candidate in
                Button {
                    viewModel.selectCandidate(candidate, correctionType: .manualSearch)
                } label: {
                    matchCell(
                        title: candidate.name,
                        subtitle: candidate.subtitle,
                        detail: candidate.pricingLine ?? candidate.detailLine,
                        score: nil,
                        badge: "Search"
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func matchCell(
        title: String,
        subtitle: String,
        detail: String,
        score: Double?,
        badge: String
    ) -> some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(red: 0.22, green: 0.28, blue: 0.35))
                .frame(width: 64, height: 90)
                .overlay(
                    Text(badge)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                )

            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(.white)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(Color.white.opacity(0.76))
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Color.white.opacity(0.62))
            }

            Spacer()

            if let score {
                Text(String(format: "%.2f", score))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color(red: 0.46, green: 0.85, blue: 0.68))
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(red: 0.12, green: 0.16, blue: 0.20))
        )
    }
}
