import SwiftUI

struct ScanResultDetailView: View {
    @ObservedObject var viewModel: ScannerViewModel

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
                        actionButtons()
                        pricingSection(item: item, card: card)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 40)
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

            HStack(spacing: 6) {
                Image(systemName: "photo.stack")
                    .font(.caption.weight(.bold))
                Text(card.setName)
                    .lineLimit(1)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white.opacity(0.88))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.white.opacity(0.08))
            .clipShape(Capsule())

            Spacer()

            Color.clear
                .frame(width: 80, height: 36)
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

            RemoteCardArtwork(urlString: card.imageLargeURL ?? card.imageSmallURL, fallbackTitle: card.name)
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
            } else if let note = item.pricingContextNote ?? item.statusMessage {
                Text(note)
                    .font(.subheadline)
                    .foregroundStyle(Color.white.opacity(0.66))
            }
        }
    }

    private func actionButtons() -> some View {
        VStack(spacing: 12) {
            Button {
                viewModel.showBannerMessage("Add to Collection is not implemented yet")
            } label: {
                Label("ADD TO COLLECTION", systemImage: "books.vertical.fill")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.86))
                    .frame(maxWidth: .infinity)
                    .frame(height: 54)
                    .background(panelBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .buttonStyle(.plain)

            Button {
                viewModel.showBannerMessage("Buying options are not implemented yet")
            } label: {
                Text("SEE BUYING OPTIONS")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: 54)
                    .background(Color(red: 0.34, green: 0.39, blue: 0.96))
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .buttonStyle(.plain)
        }
    }

    private func pricingSection(item: LiveScanStackItem, card: CardCandidate) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center) {
                Text("Market value")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.white)

                Spacer()

                if item.resolverMode == .rawCard {
                    menuChip("Raw")
                } else if let grader = item.slabContext?.grader, let grade = item.slabContext?.grade {
                    menuChip("\(grader) \(grade)")
                }
            }

            if let pricing,
               let primaryPrice = pricing.primaryDisplayPrice {
                VStack(alignment: .leading, spacing: 10) {
                    Text(formattedPrice(primaryPrice, currencyCode: pricing.currencyCode))
                        .font(.system(size: 42, weight: .bold, design: .rounded))
                        .foregroundStyle(Color(red: 0.32, green: 0.90, blue: 0.53))

                    HStack(spacing: 8) {
                        chip(pricing.sourceLabel, background: Color.white.opacity(0.08))
                        chip(pricing.freshnessBadgeLabel, background: Color.white.opacity(0.08))
                    }

                    if let spreadText = pricing.spreadText {
                        detailRow("Range", spreadText)
                    }

                    detailRow("Variant", card.variant)
                    detailRow("Source", pricing.sourceDetailLabel)

                    if let sourceUpdated = pricing.sourceUpdatedLabel {
                        detailRow("Provider", sourceUpdated)
                    }
                }
                .padding(18)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                )
            } else {
                Text("Market value is not implemented yet.")
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
}

private struct RemoteCardArtwork: View {
    let urlString: String?
    let fallbackTitle: String

    var body: some View {
        Group {
            if let urlString, let url = URL(string: urlString) {
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
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var fallback: some View {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
            .fill(Color.white.opacity(0.08))
            .overlay(
                Text(String(fallbackTitle.prefix(1)))
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.78))
            )
    }
}
