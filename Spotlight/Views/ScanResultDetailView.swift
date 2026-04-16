import Charts
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

@MainActor
private func dismissDetailKeyboard() {
#if canImport(UIKit)
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
#endif
}

struct ScanResultDetailView: View {
    @Environment(\.openURL) private var openURL
    @ObservedObject var viewModel: ScannerViewModel
    @ObservedObject var collectionStore: CollectionStore
    @ObservedObject var showsState: ShowsMockState
    @State private var marketHistory: CardMarketHistory?
    @State private var isLoadingMarketHistory = false
    @State private var selectedHistoryVariant: String?
    @State private var selectedHistoryCondition: String?
    @State private var isCollectionSectionExpanded = true
    @State private var loadedHistoryCardID: String?
    @State private var gradedComps: GradedCardComps?
    @State private var isLoadingGradedComps = false
    @State private var selectedGradedCompsGradeID: String?
    @State private var loadedGradedCompsCardID: String?
    @State private var gradedCompsStatusMessage: String?
    @State private var gradedCompsRequestKey: String?

    private let limeAccent = Color(red: 0.78, green: 0.92, blue: 0.47)
    private let inkBackground = Color(red: 0.04, green: 0.05, blue: 0.07)
    private let panelBackground = Color(red: 0.12, green: 0.12, blue: 0.16)
    private let secondaryPanelBackground = Color(red: 0.16, green: 0.16, blue: 0.20)
    private static let chartInputDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
    private static let chartAxisDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d"
        return formatter
    }()
    private static let detailDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

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

    private var gradedCompsLoadKey: String {
        guard let card, let item, shouldShowGradedComps(for: item) else {
            return "none"
        }
        let grader = resolvedGradedCompsGraderLabel(for: item)
        let grade = resolvedGradedCompsGradeID(for: item) ?? "none"
        let cert = item.slabContext?.certNumber ?? "none"
        let variant = item.slabContext?.variantName ?? "none"
        return [card.id, grader, grade, cert, variant].joined(separator: "|")
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

    private var persistedPurchasePrice: Double? {
        guard let card else {
            return nil
        }
        return collectionStore.purchasePrice(card: card, slabContext: item?.slabContext)
    }

    private var displayedCondition: DeckCardCondition {
        persistedCondition ?? .nearMint
    }

    private var sellableEntry: DeckCardEntry? {
        guard let card,
              let item,
              portfolioQuantity > 0 else {
            return nil
        }

        return collectionStore.previewEntry(
            card: card,
            slabContext: item.slabContext,
            quantityFallback: portfolioQuantity
        )
    }

    private var purchasePriceDraftKey: String {
        guard let item, let card else {
            return "none"
        }
        if let slabContext = item.slabContext {
            return [
                card.id,
                slabContext.grader,
                slabContext.grade ?? "",
                slabContext.certNumber ?? "",
                slabContext.variantName ?? "",
            ].joined(separator: "|")
        }
        return "\(card.id)|raw"
    }

    var body: some View {
        ZStack {
            background

            if let item, let card {
                ScrollView(showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        header(card: card)
                        heroSection(card: card, item: item)
                        if viewModel.hasAlternatives(for: item.id) {
                            similarCardsBanner(item: item)
                        }
                        metadataChips(card: card, item: item)
                        purchasePriceSection(card: card, item: item)
                        primaryActionsSection(card: card, item: item)
                        collectionSection(card: card, item: item)
                        marketValueSection(item: item, card: card)
                        if shouldShowMarketplaceLinks(for: item) {
                            marketplaceLinksSection(card: card, item: item)
                        }
                        gradedCompsSection(card: card, item: item)
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 14)
                    .padding(.bottom, 40)
                }
                .task(id: historyContextKey) {
                    await loadMarketHistoryIfNeeded(card: card, item: item)
                }
                .task(id: gradedCompsLoadKey) {
                    await loadGradedCompsIfNeeded(card: card, item: item)
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
        .ignoresSafeArea(.keyboard, edges: .bottom)
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

    private func heroSection(card: CardCandidate, item: LiveScanStackItem) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    if let slabBadgeTitle = slabBadgeTitle(for: item) {
                        chip(slabBadgeTitle, background: Color.white.opacity(0.08))
                    } else if portfolioQuantity > 0 {
                        chip("In your collection", background: Color(red: 0.18, green: 0.26, blue: 0.14))
                    } else {
                        chip("Scan result", background: Color.white.opacity(0.08))
                    }

                    Text(card.name)
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(2)
                        .minimumScaleFactor(0.86)

                    Text("\(card.setName) • #\(card.number)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.64))
                        .lineLimit(1)
                }

                Spacer(minLength: 12)

                VStack(alignment: .trailing, spacing: 8) {
                    if let pricing {
                        Text(formattedPrice(pricing.primaryDisplayPrice ?? 0, currencyCode: pricing.currencyCode))
                            .font(.system(size: 26, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                            .opacity(pricing.primaryDisplayPrice == nil ? 0 : 1)
                    }

                    if let note = detailSubtitleNote(for: item) {
                        Text(note)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.white.opacity(0.56))
                            .multilineTextAlignment(.trailing)
                    }
                }
            }

            heroImage(card: card)
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.07),
                            Color.white.opacity(0.035),
                            Color.white.opacity(0.02)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
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

    private func metadataChips(card: CardCandidate, item: LiveScanStackItem) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("Pokemon", background: Color(red: 0.24, green: 0.14, blue: 0.18))
                chip(card.setName, background: secondaryPanelBackground)
                chip(card.language, background: secondaryPanelBackground)
                if let slabBadgeTitle = slabBadgeTitle(for: item) {
                    chip(slabBadgeTitle, background: secondaryPanelBackground)
                } else if !card.variant.isEmpty {
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

    private func purchasePriceSection(card: CardCandidate, item: LiveScanStackItem) -> some View {
        let ownedEntry = collectionStore.entry(card: card, slabContext: item.slabContext) ?? sellableEntry
        return PurchasePriceCard(
            draftKey: purchasePriceDraftKey,
            persistedPurchasePrice: persistedPurchasePrice,
            portfolioQuantity: portfolioQuantity,
            currencyCode: purchasePriceCurrencyCode(card: card),
            accent: limeAccent,
            cardImageURL: card.imageSmallURL ?? card.imageLargeURL,
            cardTitle: card.name,
            ownedCardSummary: ownedEntry.map(collectionSummaryLine(entry:)),
            onSave: { purchasePrice in
                try await savePurchasePrice(purchasePrice, card: card, item: item)
            },
            formattedPrice: formattedPrice(_:currencyCode:)
        )
        .id(purchasePriceDraftKey)
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

    private func slabBadgeTitle(for item: LiveScanStackItem) -> String? {
        guard item.resolverMode == .psaSlab || item.slabContext != nil else {
            return nil
        }
        return item.slabContext?.displayBadgeTitle
    }

    private func shouldShowMarketplaceLinks(for item: LiveScanStackItem) -> Bool {
        item.resolverMode == .psaSlab || item.slabContext != nil
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

    @ViewBuilder
    private func gradedCompsSection(card: CardCandidate, item: LiveScanStackItem) -> some View {
        if shouldShowGradedComps(for: item) {
            let gradeOptions = displayedGradeOptions(for: item)
            let selectedGradeID = selectedGradedCompsGradeID(for: item)
            let graderLabel = resolvedGradedCompsGraderLabel(for: item)

                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                        Text("Current eBay listings")
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.white)

                        Text("\(graderLabel)-focused grade tabs and current eBay listings.")
                            .font(.footnote)
                            .foregroundStyle(.white.opacity(0.62))
                    }

                    Spacer()

                    if isLoadingGradedComps {
                        ProgressView()
                            .tint(.white.opacity(0.78))
                    } else if let comps = gradedComps, comps.isFresh == true {
                        compBadge("Fresh", background: limeAccent.opacity(0.18), foreground: limeAccent)
                    }
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(gradeOptions) { option in
                            Button {
                                selectGradedCompsGrade(option, card: card, item: item)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(option.displayLabel)
                                        .font(.caption.weight(.bold))
                                    if let count = option.count {
                                        Text("\(count) listings")
                                            .font(.caption2.weight(.medium))
                                            .opacity(0.72)
                                    }
                                }
                                .foregroundStyle(option.id == selectedGradeID ? .black : .white.opacity(0.86))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .background(option.id == selectedGradeID ? limeAccent : Color.white.opacity(0.05))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                                        .stroke(option.id == selectedGradeID ? Color.clear : Color.white.opacity(0.08), lineWidth: 1)
                                )
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if isLoadingGradedComps && gradedComps == nil {
                    HStack(spacing: 12) {
                        ProgressView()
                            .tint(.white)
                        Text("Loading eBay listings…")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.76))
                    }
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .fill(Color.white.opacity(0.05))
                    )
                } else if let comps = gradedComps {
                    if comps.transactions.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(gradedCompsEmptyStateTitle(for: comps))
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(.white)

                            Text(gradedCompsEmptyStateMessage(for: comps))
                                .font(.subheadline)
                                .foregroundStyle(.white.opacity(0.62))

                            if let searchURL = gradedCompsSearchURL(for: comps) {
                                Button {
                                    openMarketplaceURL(searchURL, failureMessage: "Could not open eBay search")
                                } label: {
                                    Label("Open eBay search", systemImage: "arrow.up.right")
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(limeAccent)
                                }
                                .buttonStyle(.plain)
                                .padding(.top, 4)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .background(
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .fill(Color.white.opacity(0.04))
                        )
                    } else {
                        LazyVStack(spacing: 10) {
                            ForEach(comps.transactions) { transaction in
                                gradedCompsRow(
                                    transaction: transaction,
                                    selectedGradeID: selectedGradeID,
                                    graderLabel: graderLabel
                                )
                            }
                        }
                    }
                } else {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("eBay listings unavailable")
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(.white)

                        Text(gradedCompsStatusMessage ?? "The backend did not return current eBay listings for this card.")
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.62))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(Color.white.opacity(0.04))
                    )
                }
            }
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color.white.opacity(0.05))
            )
        }
    }

    private func primaryActionsSection(card: CardCandidate, item: LiveScanStackItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(spacing: 12) {
                Button {
                    let previewEntry = collectionStore.previewEntry(
                        card: card,
                        slabContext: item.slabContext,
                        quantityFallback: max(1, portfolioQuantity)
                    )
                    showsState.presentBuy(
                        entry: previewEntry,
                        title: "Add to Collection",
                        subtitle: "Confirm the exact card details before adding it to your collection."
                    )
                } label: {
                    HStack {
                        Label("ADD TO COLLECTION", systemImage: "books.vertical.fill")
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(.white)
                        Spacer()
                        if portfolioQuantity > 0 {
                            Text("OWN \(portfolioQuantity)")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.white.opacity(0.76))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
                    .padding(.horizontal, 18)
                    .background(panelBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)

                Button {
                    openMarketplaceURL(
                        CardMarketplaceLinks.tcgPlayerSearchURL(card: card, slabContext: item.slabContext)
                            ?? CardMarketplaceLinks.eBaySearchURL(card: card, slabContext: item.slabContext),
                        failureMessage: "Could not open buying options"
                    )
                } label: {
                    HStack {
                        Label(
                            item.resolverMode == .rawCard ? "TCGPLAYER BUYING OPTIONS" : "SEE BUYING OPTIONS",
                            systemImage: "cart.fill"
                        )
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(.white)
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white.opacity(0.82))
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
                    .padding(.horizontal, 18)
                    .background(Color(red: 0.33, green: 0.35, blue: 0.95))
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func collectionSection(card: CardCandidate, item: LiveScanStackItem) -> some View {
        let ownedEntry = collectionStore.entry(card: card, slabContext: item.slabContext) ?? sellableEntry

        return VStack(alignment: .leading, spacing: 0) {
            Button {
                guard ownedEntry != nil else { return }
                withAnimation(.easeInOut(duration: 0.2)) {
                    isCollectionSectionExpanded.toggle()
                }
            } label: {
                HStack(spacing: 10) {
                    Text("In your collection")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(.white)

                    Spacer()

                    if ownedEntry != nil {
                        Image(systemName: "chevron.down")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white.opacity(0.58))
                            .rotationEffect(.degrees(isCollectionSectionExpanded ? 0 : -90))
                    }
                }
                .contentShape(Rectangle())
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)

            if let ownedEntry {
                if isCollectionSectionExpanded {
                    Rectangle()
                        .fill(Color.white.opacity(0.08))
                        .frame(height: 1)
                        .padding(.top, 8)

                    HStack(spacing: 12) {
                        CardArtworkView(
                            urlString: card.imageSmallURL ?? card.imageLargeURL,
                            fallbackTitle: card.name,
                            cornerRadius: 6,
                            contentMode: .fit
                        )
                        .frame(width: 24, height: 34)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

                        Text(collectionSummaryLine(entry: ownedEntry))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.9))
                            .lineLimit(1)

                        Spacer(minLength: 0)

                        if let unitPrice = ownedEntry.primaryPrice {
                            Text(formattedPrice(unitPrice, currencyCode: ownedEntry.card.pricing?.currencyCode ?? "USD"))
                                .font(.headline.weight(.bold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                        }

                        HStack(spacing: 0) {
                            Button {
                                viewModel.showBannerMessage("Removal from collection coming soon.")
                            } label: {
                                Image(systemName: "trash")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(.white.opacity(0.82))
                                    .frame(width: 30, height: 30)
                            }
                            .buttonStyle(.plain)

                            Text("\(ownedEntry.quantity)")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(.white)
                                .frame(minWidth: 26)

                            Button {
                                showsState.presentBuy(
                                    entry: ownedEntry,
                                    title: "Add to Collection"
                                )
                            } label: {
                                Image(systemName: "plus")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(.white)
                                    .frame(width: 30, height: 30)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 4)
                        .padding(.vertical, 3)
                        .background(Color.white.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .padding(.top, 12)

                    if let sellableEntry {
                        Button {
                            showsState.presentSell(
                                entry: sellableEntry,
                                title: "Sell Card"
                            )
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "dollarsign.circle.fill")
                                    .font(.subheadline.weight(.bold))
                                Text("SELL CARD")
                                    .font(.subheadline.weight(.bold))
                                Spacer()
                            }
                            .foregroundStyle(.black)
                            .padding(.horizontal, 14)
                            .frame(height: 40)
                            .background(limeAccent)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 10)
                    }

                    Color.clear
                        .frame(height: 2)
                }
            } else {
                Text("Not in your collection yet")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.64))
                    .padding(.top, 10)
            }
        }
    }

    private func gradedCompsRow(
        transaction: GradedCardCompsTransaction,
        selectedGradeID: String?,
        graderLabel: String
    ) -> some View {
        let currencyCode = transaction.currencyCode.isEmpty ? (gradedComps?.currencyCode ?? "USD") : transaction.currencyCode
        let gradeLabel = transactionGradeLabel(transaction: transaction, selectedGradeID: selectedGradeID, graderLabel: graderLabel)

        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(transaction.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)

                HStack(spacing: 6) {
                    if let gradeLabel {
                        compBadge(gradeLabel, background: Color.white.opacity(0.08), foreground: .white.opacity(0.82))
                    }

                    if let saleType = transaction.saleType?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !saleType.isEmpty {
                        compBadge(saleType, background: limeAccent.opacity(0.14), foreground: limeAccent)
                    }
                }

                if let soldAt = transaction.soldAt {
                    Text(formattedGradedCompDate(soldAt))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.white.opacity(0.52))
                }
            }

            Spacer(minLength: 0)

            VStack(alignment: .trailing, spacing: 6) {
                if let price = transaction.price {
                    Text(formattedGradedCompPrice(price, currencyCode: currencyCode))
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white)
                } else {
                    Text("Price n/a")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white.opacity(0.7))
                }

                if let urlString = transaction.listingURL, let url = URL(string: urlString) {
                    Button {
                        openMarketplaceURL(url, failureMessage: "Could not open listing")
                    } label: {
                        Text("Open listing")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(limeAccent)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color.white.opacity(0.04))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    }

    private func compBadge(_ title: String, background: Color, foreground: Color) -> some View {
        Text(title)
            .font(.caption2.weight(.bold))
            .foregroundStyle(foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(background)
            .clipShape(Capsule())
    }

    private func marketValueSection(item: LiveScanStackItem, card: CardCandidate) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center) {
                Text("Market value")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.white)

                Spacer()

                if let slabBadgeTitle = slabBadgeTitle(for: item) {
                    menuChip(slabBadgeTitle)
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
                      let primaryPrice = history.primaryDisplayPrice {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(formattedPrice(primaryPrice, currencyCode: history.currencyCode))
                            .font(.system(size: 42, weight: .bold, design: .rounded))
                            .foregroundStyle(historyPriceTint(history))
                    }

                    historyDeltaRow(history)

                    marketHistoryChart(history)

                    if !history.availableConditions.isEmpty {
                        conditionPicker(history)
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

    private func collectionSummaryLine(entry: DeckCardEntry) -> String {
        var parts: [String] = []
        if let slabContext = entry.slabContext {
            parts.append(slabContext.displayBadgeTitle)
            if let variant = slabContext.variantName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !variant.isEmpty {
                parts.append(variant)
            }
        } else {
            parts.append((entry.condition ?? displayedCondition).shortLabel)
            let normalizedVariant = entry.card.variant.trimmingCharacters(in: .whitespacesAndNewlines)
            if !normalizedVariant.isEmpty {
                parts.append(normalizedVariant)
            }
        }
        return parts.joined(separator: " • ")
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
            if !history.hasRenderablePoints {
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
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(history.availableConditions) { option in
                    Button {
                        guard selectedHistoryCondition != option.id else { return }
                        selectedHistoryCondition = option.id
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(option.label)
                                .font(.caption.weight(.bold))
                                .lineLimit(1)

                            if let optionPrice = option.currentPrice {
                                Text(formattedPrice(optionPrice, currencyCode: history.currencyCode))
                                    .lineLimit(2)
                                    .minimumScaleFactor(0.82)
                                    .font(
                                        option.id == (selectedHistoryCondition ?? history.selectedCondition)
                                            ? .headline.weight(.bold)
                                            : .subheadline.weight(.semibold)
                                    )
                            } else {
                                Text("—")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white.opacity(0.54))
                            }
                        }
                        .foregroundStyle(.white)
                        .frame(width: 86, alignment: .leading)
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
            .padding(.horizontal, 2)
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
        Self.chartInputDateFormatter.date(from: value)
    }

    private func chartAxisLabel(for date: Date) -> String {
        Self.chartAxisDateFormatter.string(from: date)
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
        Self.detailDateFormatter.string(from: date)
    }

    private func loadMarketHistoryIfNeeded(card: CardCandidate, item: LiveScanStackItem) async {
        if loadedHistoryCardID != card.id {
            loadedHistoryCardID = card.id
            selectedHistoryVariant = item.selectedVariant
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

    private func loadGradedCompsIfNeeded(
        card: CardCandidate,
        item: LiveScanStackItem,
        selectedGradeOverride: String? = nil
    ) async {
        guard shouldShowGradedComps(for: item) else {
            resetGradedCompsState()
            return
        }

        let cardChanged = loadedGradedCompsCardID != card.id
        if cardChanged {
            gradedComps = nil
            gradedCompsStatusMessage = nil
            selectedGradedCompsGradeID = nil
            loadedGradedCompsCardID = card.id
        }

        let requestedGrade = normalizedSelectedGradedCompsGradeID(
            override: selectedGradeOverride,
            item: item
        )

        if !cardChanged,
           let existingComps = gradedComps,
           selectedGradedCompsGradeID == requestedGrade,
           existingComps.selectedGrade == requestedGrade {
            return
        }

        let requestKey = [
            card.id,
            item.slabContext?.grader ?? "",
            item.slabContext?.grade ?? "",
            item.slabContext?.certNumber ?? "",
            requestedGrade ?? ""
        ].joined(separator: "|")
        gradedCompsRequestKey = requestKey
        isLoadingGradedComps = true
        gradedCompsStatusMessage = nil

        let comps = await viewModel.fetchGradedCardComps(
            cardID: card.id,
            slabContext: item.slabContext,
            selectedGrade: requestedGrade
        )

        guard item.id == viewModel.activeResultItem?.id,
              gradedCompsRequestKey == requestKey else {
            return
        }

        gradedComps = comps
        let responseSelectedGrade = comps?.selectedGrade
            ?? comps?.gradeOptions.first(where: { $0.isSelected == true })?.id
            ?? requestedGrade
        if selectedGradedCompsGradeID == nil || selectedGradeOverride != nil || cardChanged {
            selectedGradedCompsGradeID = responseSelectedGrade
        }
        if comps == nil {
            gradedCompsStatusMessage = "The backend did not return current eBay listings for this card."
        } else if let unavailableReason = comps?.unavailableReason, !unavailableReason.isEmpty {
            gradedCompsStatusMessage = unavailableReason
        }
        isLoadingGradedComps = false
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

    private func purchasePriceCurrencyCode(card: CardCandidate) -> String {
        item?.pricing?.currencyCode ?? card.pricing?.currencyCode ?? "USD"
    }

    private func savePurchasePrice(_ purchasePrice: Double, card: CardCandidate, item: LiveScanStackItem) async throws {
        let currencyCode = purchasePriceCurrencyCode(card: card)
        if portfolioQuantity > 0 {
            collectionStore.setPurchasePrice(
                card: card,
                slabContext: item.slabContext,
                unitPrice: purchasePrice,
                currencyCode: currencyCode
            )
            await collectionStore.syncPurchasePrice(
                card: card,
                slabContext: item.slabContext,
                unitPrice: purchasePrice,
                currencyCode: currencyCode
            )
            await MainActor.run {
                viewModel.showBannerMessage("Purchase price saved.")
            }
        } else {
            do {
                _ = try await collectionStore.recordBuy(
                    card: card,
                    slabContext: item.slabContext,
                    condition: persistedCondition,
                    quantity: 1,
                    unitPrice: purchasePrice,
                    currencyCode: currencyCode,
                    paymentMethod: nil,
                    boughtAt: Date(),
                    sourceScanID: item.scanID
                )
                await MainActor.run {
                    viewModel.showBannerMessage("\(card.name) added to portfolio.")
                }
            } catch {
                await MainActor.run {
                    viewModel.showBannerMessage(error.localizedDescription)
                }
                throw error
            }
        }
    }

    private func resetGradedCompsState() {
        gradedComps = nil
        isLoadingGradedComps = false
        selectedGradedCompsGradeID = nil
        loadedGradedCompsCardID = nil
        gradedCompsStatusMessage = nil
        gradedCompsRequestKey = nil
    }

    private func normalizedSelectedGradedCompsGradeID(
        override: String?,
        item: LiveScanStackItem
    ) -> String? {
        if let override = override?.trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty {
            return override
        }

        if let selected = selectedGradedCompsGradeID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !selected.isEmpty {
            return selected
        }

        if let currentGrade = gradedComps?.selectedGrade?.trimmingCharacters(in: .whitespacesAndNewlines),
           !currentGrade.isEmpty {
            return currentGrade
        }

        if let selectedFromTabs = gradedComps?.gradeOptions.first(where: { $0.isSelected == true })?.id.trimmingCharacters(in: .whitespacesAndNewlines),
           !selectedFromTabs.isEmpty {
            return selectedFromTabs
        }

        if let itemGrade = resolvedGradedCompsGradeID(for: item)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !itemGrade.isEmpty {
            return itemGrade
        }

        return fallbackGradedCompsGradeIDs().first
    }

    private func selectedGradedCompsGradeID(for item: LiveScanStackItem) -> String? {
        normalizedSelectedGradedCompsGradeID(override: nil, item: item)
    }

    private func displayedGradeOptions(for item: LiveScanStackItem) -> [GradedCardCompsGradeOption] {
        if let gradeOptions = gradedComps?.gradeOptions, !gradeOptions.isEmpty {
            return gradeOptions
        }

        let grader = resolvedGradedCompsGraderLabel(for: item)
        return fallbackGradedCompsGradeIDs().map { grade in
            GradedCardCompsGradeOption(
                id: grade,
                label: "\(grader) \(grade)",
                count: nil,
                isSelected: grade == (selectedGradedCompsGradeID(for: item) ?? resolvedGradedCompsGradeID(for: item))
            )
        }
    }

    private func shouldShowGradedComps(for item: LiveScanStackItem) -> Bool {
        if item.resolverMode == .psaSlab || item.slabContext != nil {
            return true
        }
        if let pricing, pricing.grader != nil || pricing.grade != nil {
            return true
        }
        return false
    }

    private func resolvedGradedCompsGraderLabel(for item: LiveScanStackItem) -> String {
        let slabGrader = item.slabContext?.grader.trimmingCharacters(in: .whitespacesAndNewlines)
        if let slabGrader, !slabGrader.isEmpty {
            return slabGrader
        }

        let pricingGrader = pricing?.grader?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let pricingGrader, !pricingGrader.isEmpty {
            return pricingGrader
        }

        return "PSA"
    }

    private func resolvedGradedCompsGradeID(for item: LiveScanStackItem) -> String? {
        let slabGrade = item.slabContext?.grade?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let slabGrade, !slabGrade.isEmpty {
            return slabGrade
        }

        let pricingGrade = pricing?.grade?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let pricingGrade, !pricingGrade.isEmpty {
            return pricingGrade
        }

        return nil
    }

    private func fallbackGradedCompsGradeIDs() -> [String] {
        ["10", "9", "8.5", "8"]
    }

    private func selectGradedCompsGrade(
        _ option: GradedCardCompsGradeOption,
        card: CardCandidate,
        item: LiveScanStackItem
    ) {
        guard selectedGradedCompsGradeID(for: item) != option.id else {
            return
        }
        selectedGradedCompsGradeID = option.id
        Task {
            await loadGradedCompsIfNeeded(card: card, item: item, selectedGradeOverride: option.id)
        }
    }

    private func gradedCompsEmptyStateTitle(for comps: GradedCardComps) -> String {
        switch comps.statusReason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "bot_blocked":
            return "eBay blocked the listings request"
        case "fetch_failed":
            return "Could not load eBay listings"
        default:
            return "No listings found"
        }
    }

    private func gradedCompsEmptyStateMessage(for comps: GradedCardComps) -> String {
        switch comps.statusReason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "bot_blocked":
            return "eBay is blocking automated listing requests from the backend right now. You can still open the eBay search directly."
        case "fetch_failed":
            return comps.errorMessage ?? "The backend could not reach eBay for this listing tab."
        default:
            return comps.unavailableReason ?? "Try another grade tab or check back later once eBay listings are available."
        }
    }

    private func gradedCompsSearchURL(for comps: GradedCardComps) -> URL? {
        guard let rawURL = comps.searchURL?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rawURL.isEmpty else {
            return nil
        }
        return URL(string: rawURL)
    }

    private func transactionGradeLabel(
        transaction: GradedCardCompsTransaction,
        selectedGradeID: String?,
        graderLabel: String
    ) -> String? {
        let rawGrade = transaction.grade?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedGrade = rawGrade?.isEmpty == false ? rawGrade : selectedGradeID
        guard let resolvedGrade, !resolvedGrade.isEmpty else {
            return nil
        }
        return "\(graderLabel) \(resolvedGrade)"
    }

    private func formattedGradedCompDate(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .omitted)
    }

    private func formattedGradedCompPrice(_ value: Double, currencyCode: String) -> String {
        formattedPrice(value, currencyCode: currencyCode)
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

private struct PurchasePriceCard: View {
    let draftKey: String
    let persistedPurchasePrice: Double?
    let portfolioQuantity: Int
    let currencyCode: String
    let accent: Color
    let cardImageURL: String?
    let cardTitle: String
    let ownedCardSummary: String?
    let onSave: (Double) async throws -> Void
    let formattedPrice: (Double, String) -> String

    @State private var purchasePriceTexts: [String]
    @State private var isSaving = false
    @State private var isExpanded = false
    @FocusState private var focusedPurchasePriceIndex: Int?

    init(
        draftKey: String,
        persistedPurchasePrice: Double?,
        portfolioQuantity: Int,
        currencyCode: String,
        accent: Color,
        cardImageURL: String?,
        cardTitle: String,
        ownedCardSummary: String?,
        onSave: @escaping (Double) async throws -> Void,
        formattedPrice: @escaping (Double, String) -> String
    ) {
        self.draftKey = draftKey
        self.persistedPurchasePrice = persistedPurchasePrice
        self.portfolioQuantity = portfolioQuantity
        self.currencyCode = currencyCode
        self.accent = accent
        self.cardImageURL = cardImageURL
        self.cardTitle = cardTitle
        self.ownedCardSummary = ownedCardSummary
        self.onSave = onSave
        self.formattedPrice = formattedPrice
        _purchasePriceTexts = State(
            initialValue: Self.initialPurchasePriceTexts(
                persistedPurchasePrice: persistedPurchasePrice,
                rowCount: max(1, portfolioQuantity)
            )
        )
    }

    private static func initialPurchasePriceTexts(
        persistedPurchasePrice: Double?,
        rowCount: Int
    ) -> [String] {
        let normalizedRowCount = max(1, rowCount)
        let initialText: String
        if let persistedPurchasePrice, persistedPurchasePrice > 0 {
            initialText = String(format: "%.2f", persistedPurchasePrice)
        } else {
            initialText = ""
        }
        return Array(repeating: initialText, count: normalizedRowCount)
    }

    private var rowCount: Int {
        max(1, portfolioQuantity)
    }

    private var parsedPurchasePrices: [Double?] {
        purchasePriceTexts.map { text in
            let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalized.isEmpty,
                  let value = Double(normalized),
                  value >= 0 else {
                return nil
            }
            return value
        }
    }

    private var resolvedPurchasePriceForSave: Double? {
        let validValues = parsedPurchasePrices.compactMap { $0 }
        guard !validValues.isEmpty else {
            return nil
        }
        return validValues.reduce(0, +) / Double(validValues.count)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 10) {
                    Text("Purchase price")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(.white)

                    Spacer()

                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white.opacity(0.58))
                        .rotationEffect(.degrees(isExpanded ? 0 : -90))
                }
                .contentShape(Rectangle())
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)

            if isExpanded {
                Rectangle()
                    .fill(Color.white.opacity(0.08))
                    .frame(height: 1)
                    .padding(.top, 6)

                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(purchasePriceTexts.indices), id: \.self) { index in
                        purchasePriceRow(index: index)

                        if index < purchasePriceTexts.index(before: purchasePriceTexts.endIndex) {
                            Rectangle()
                                .fill(Color.white.opacity(0.08))
                                .frame(height: 1)
                                .padding(.leading, 40)
                        }
                    }
                }
                .padding(.top, 10)

                Rectangle()
                    .fill(Color.white.opacity(0.08))
                    .frame(height: 1)
                    .padding(.top, 8)

                HStack {
                    Spacer()

                    Button {
                        savePurchasePrice()
                    } label: {
                        Group {
                            if isSaving {
                                ProgressView()
                                    .tint(.black)
                            } else {
                                Text("Save")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(.black)
                            }
                        }
                        .frame(width: 96, height: 40)
                        .background(accent)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(isSaving || resolvedPurchasePriceForSave == nil)
                    .opacity((isSaving || resolvedPurchasePriceForSave == nil) ? 0.6 : 1)
                }
                .padding(.top, 8)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white.opacity(0.05))
        )
        .onChange(of: draftKey) { _, _ in
            guard focusedPurchasePriceIndex == nil else { return }
            syncDraft()
        }
        .onChange(of: persistedPurchasePrice) { _, newValue in
            guard !isSaving, focusedPurchasePriceIndex == nil else { return }
            purchasePriceTexts = Self.initialPurchasePriceTexts(
                persistedPurchasePrice: newValue,
                rowCount: rowCount
            )
        }
        .onChange(of: portfolioQuantity) { _, _ in
            guard !isSaving, focusedPurchasePriceIndex == nil else { return }
            syncDraft()
        }
    }

    private func syncDraft() {
        purchasePriceTexts = Self.initialPurchasePriceTexts(
            persistedPurchasePrice: persistedPurchasePrice,
            rowCount: rowCount
        )
    }

    private func purchasePriceRow(index: Int) -> some View {
        HStack(spacing: 12) {
            CardArtworkView(
                urlString: cardImageURL,
                fallbackTitle: cardTitle,
                cornerRadius: 6,
                contentMode: .fit
            )
            .frame(width: 20, height: 28)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(cardTitle)
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                Text(purchasePriceRowSummary(index: index))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.66))
                    .lineLimit(1)
            }

            Spacer(minLength: 12)

            purchasePriceField(text: bindingForPurchasePriceRow(index), index: index)
        }
        .padding(.vertical, 7)
    }

    private func purchasePriceRowSummary(index: Int) -> String {
        var parts: [String] = []
        if let ownedCardSummary, !ownedCardSummary.isEmpty {
            parts.append(ownedCardSummary)
        }
        if rowCount > 1 {
            parts.append("Card \(index + 1)")
        }
        if parts.isEmpty {
            parts.append(portfolioQuantity > 0 ? "Owned card" : "New card")
        }
        return parts.joined(separator: " • ")
    }

    private func bindingForPurchasePriceRow(_ index: Int) -> Binding<String> {
        Binding(
            get: {
                guard purchasePriceTexts.indices.contains(index) else { return "" }
                return purchasePriceTexts[index]
            },
            set: { newValue in
                guard purchasePriceTexts.indices.contains(index) else { return }
                purchasePriceTexts[index] = newValue
            }
        )
    }

    private func purchasePriceField(text: Binding<String>, index: Int) -> some View {
        TextField("0.00", text: text)
            .keyboardType(.decimalPad)
            .textInputAutocapitalization(.never)
            .disableAutocorrection(true)
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .multilineTextAlignment(.trailing)
            .padding(.horizontal, 12)
            .frame(width: 96, height: 40)
            .background(Color.white.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
            .focused($focusedPurchasePriceIndex, equals: index)
    }

    private func savePurchasePrice() {
        guard let purchasePrice = resolvedPurchasePriceForSave else { return }
        focusedPurchasePriceIndex = nil
        dismissDetailKeyboard()
        isSaving = true

        Task {
            do {
                try await onSave(purchasePrice)
                await MainActor.run {
                    isSaving = false
                    purchasePriceTexts = Self.initialPurchasePriceTexts(
                        persistedPurchasePrice: purchasePrice,
                        rowCount: rowCount
                    )
                }
            } catch {
                await MainActor.run {
                    isSaving = false
                }
            }
        }
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
