import SwiftUI

struct AlternateMatchesView: View {
    @ObservedObject var viewModel: ScannerViewModel
    @State private var isSearchExpanded = false

    private let limeAccent = Color(red: 0.78, green: 0.92, blue: 0.47)
    private let inkBackground = Color(red: 0.04, green: 0.05, blue: 0.07)

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
            VStack(alignment: .leading, spacing: 28) {
                header
                scanPreview
                closestMatchSection
                similarMatchesSection
                manualSearchSection

                if shouldShowSearchResults {
                    searchResultsSection
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 40)
        }
        .background(background.ignoresSafeArea())
        .onAppear {
            isSearchExpanded = !viewModel.searchQuery.isEmpty || !viewModel.searchResults.isEmpty
        }
    }

    private var background: some View {
        ZStack {
            inkBackground

            LinearGradient(
                colors: [
                    Color(red: 0.19, green: 0.16, blue: 0.12).opacity(0.42),
                    Color.clear,
                    Color(red: 0.06, green: 0.07, blue: 0.10).opacity(0.8)
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            Circle()
                .fill(Color.white.opacity(0.08))
                .frame(width: 280, height: 280)
                .blur(radius: 52)
                .offset(y: 88)
        }
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
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white.opacity(0.82))
            }
            .buttonStyle(.plain)

            Spacer()

            Text(resultCountText)
                .font(.headline.weight(.semibold))
                .foregroundStyle(.white)

            Spacer()

            Color.clear
                .frame(width: 36, height: 36)
        }
    }

    private var scanPreview: some View {
        VStack(spacing: 14) {
            if let previewImage = viewModel.activeAlternativesPreviewImage {
                ZStack {
                    Circle()
                        .fill(Color.white.opacity(0.12))
                        .frame(width: 210, height: 210)
                        .blur(radius: 48)

                    Image(uiImage: previewImage)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 220, maxHeight: 290)
                        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .shadow(color: .black.opacity(0.36), radius: 22, y: 10)
                }
            } else {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color.white.opacity(0.06))
                    .frame(width: 220, height: 280)
                    .overlay(
                        Image(systemName: "photo")
                            .font(.title.weight(.semibold))
                            .foregroundStyle(Color.white.opacity(0.55))
                    )
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var closestMatchSection: some View {
        if let bestMatch {
            VStack(alignment: .leading, spacing: 12) {
                Text("Closest Match")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(limeAccent)

                Button {
                    viewModel.acceptBestMatch()
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
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.white)

                ForEach(similarMatches) { candidate in
                    Button {
                        viewModel.selectCandidate(candidate.candidate, correctionType: .choseAlternative)
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
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)

            if isSearchExpanded {
                Text("Search by name, set, or number, or go back and rescan.")
                    .font(.subheadline)
                    .foregroundStyle(Color.white.opacity(0.68))

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

            Button {
                viewModel.dismissAlternatives()
            } label: {
                Text("Back To Scanner")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.white.opacity(0.78))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.06))
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }

    private var searchResultsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Search Results")
                .font(.headline.weight(.semibold))
                .foregroundStyle(.white)

            ForEach(viewModel.searchResults) { candidate in
                Button {
                    viewModel.selectCandidate(candidate, correctionType: .manualSearch)
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
                        .foregroundStyle(Color.white.opacity(0.58))
                        .lineLimit(2)

                    Text("\(candidate.name) #\(candidate.number)")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(2)

                    Text(detailLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(emphasize ? .white : Color.white.opacity(0.78))
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.white.opacity(0.52))
                    .padding(.top, 4)
            }
            .padding(.vertical, 6)

            Rectangle()
                .fill(Color.white.opacity(0.06))
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
        .background(Color.white.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private var fallback: some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(Color.white.opacity(0.08))
            .overlay(
                Text(String(candidate.name.prefix(1)))
                    .font(.headline.weight(.bold))
                    .foregroundStyle(Color.white.opacity(0.74))
            )
    }
}
