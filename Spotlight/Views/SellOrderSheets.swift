import SwiftUI
#if canImport(PhotosUI)
import PhotosUI
#endif
#if canImport(UIKit)
import UIKit
#endif

private enum SellOrderSubmitState: Equatable {
    case idle
    case processing
    case success
}

private enum SingleSellField: Hashable {
    case offerPrice
    case yourPrice
    case soldPrice
}

private enum BatchSellFieldKind: Hashable {
    case offerPrice
    case yourPrice
    case soldPrice
}

private enum BatchSellField: Hashable {
    case line(id: String, kind: BatchSellFieldKind)
}

private struct BatchSellLineState: Equatable {
    var quantity: Int
    var offerPriceText: String
    var yourPriceText: String
    var soldPriceText: String
    var revealsBoughtPrice = false
}

private let sellOrderProcessingMinimumDuration: TimeInterval = 1.6
private let sellOrderSuccessDisplayDuration: TimeInterval = 1.1
private let sellOrderFormWidth: CGFloat = 420
private let sellOrderSingleFormMaxWidth: CGFloat = 420
private let sellOrderSwipeThreshold: CGFloat = 92
private let sellOrderSwipeRailHeight: CGFloat = 48
private let sellOrderSingleLabelFont: Font = .title3.weight(.semibold)
private let sellOrderSingleValueFont: Font = .body.weight(.semibold)
private let batchSellMissingPriceErrorMessage = "Enter a sell price for every selected card."
private let batchSellEmptySelectionErrorMessage = "Choose at least one card to sell."

private struct SellOrderSwipeStatusContent: View {
    let title: String
    let headline: String
    let detail: String
    let showsProgress: Bool

    var body: some View {
        VStack(spacing: 20) {
            Group {
                if showsProgress {
                    ProgressView()
                        .tint(Color.black.opacity(0.78))
                        .scaleEffect(1.35)
                } else {
                    Image(systemName: "checkmark")
                        .font(.system(size: 32, weight: .bold))
                        .foregroundStyle(Color.black.opacity(0.84))
                }
            }
            .frame(height: 44)

            VStack(spacing: 10) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.black.opacity(0.58))

                Text(headline)
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.black.opacity(0.9))
                    .multilineTextAlignment(.center)

                Text(detail)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.black.opacity(0.66))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: 320)
    }
}

@MainActor
struct ShowSellPreviewSheet: View {
    let draft: ShowSellDraft
    var onTrade: (() -> Void)? = nil
    let onConfirm: (ShowSellSubmission) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var quantity = 1
    @State private var offerPriceText = ""
    @State private var yourPriceText: String
    @State private var soldPriceText = ""
    @State private var revealsBoughtPrice = false
    @State private var submitState: SellOrderSubmitState = .idle
    @State private var errorMessage: String?
    @State private var liveSwipeTranslation: CGFloat = 0
    @State private var confirmationSheetOffset: CGFloat = 0
    @State private var lastClosedConfirmationSheetOffset: CGFloat = 0
    @State private var hasInitializedConfirmationSheet = false
    @FocusState private var focusedField: SingleSellField?
#if canImport(PhotosUI)
    @State private var selectedPhotoItem: PhotosPickerItem?
#endif
    @State private var attachedPhoto: UIImage?

    init(
        draft: ShowSellDraft,
        onTrade: (() -> Void)? = nil,
        onConfirm: @escaping (ShowSellSubmission) async throws -> Void
    ) {
        self.draft = draft
        self.onTrade = onTrade
        self.onConfirm = onConfirm
        _yourPriceText = State(
            initialValue: draft.suggestedPrice > 0
                ? sellOrderEditableNumericText(draft.suggestedPrice)
                : ""
        )
    }

    private var currencyCode: String {
        draft.entry.card.pricing?.currencyCode ?? draft.entry.costBasisCurrencyCode ?? "USD"
    }

    private var marketPrice: Double? {
        draft.entry.primaryPrice
    }

    private var boughtPrice: Double? {
        draft.entry.costBasisPerUnit
    }

    private var parsedOfferPrice: Double? {
        sellOrderParsedPrice(from: offerPriceText)
    }

    private var parsedYourPrice: Double? {
        sellOrderParsedPrice(from: yourPriceText)
    }

    private var parsedSoldPrice: Double? {
        sellOrderParsedPrice(from: soldPriceText)
    }

    private var soldTotal: Double {
        (parsedSoldPrice ?? 0) * Double(quantity)
    }

    private var canInteract: Bool {
        submitState == .idle && focusedField == nil
    }

    private var canSubmit: Bool {
        parsedSoldPrice != nil
    }

    private var releaseToConfirmArmed: Bool {
        confirmationSheetProgress(closedOffset: lastClosedConfirmationSheetOffset) >= 0.42
    }

    private var ypPercentText: String? {
        guard let offer = parsedOfferPrice,
              let your = parsedYourPrice,
              offer > 0 else {
            return nil
        }
        let percent = (your / offer) * 100
        return "\(sellOrderFormattedPercent(percent)) YP"
    }

    private var processingHeadline: String {
        "Selling \(sellOrderFormattedPrice(soldTotal, currencyCode: currencyCode))"
    }

    private var processingDetail: String {
        quantity == 1
            ? "Locking in the sale."
            : "Locking in \(quantity) cards."
    }

    private var successHeadline: String {
        "Sale confirmed"
    }

    private var successDetail: String {
        "\(draft.entry.card.name) sold for \(sellOrderFormattedPrice(soldTotal, currencyCode: currencyCode))."
    }

    var body: some View {
        GeometryReader { proxy in
            let containerHeight = max(0, proxy.size.height - proxy.safeAreaInsets.top - proxy.safeAreaInsets.bottom)
            let closedOffset = closedConfirmationSheetOffset(containerHeight: containerHeight)
            let currentOffset = currentConfirmationSheetOffset(closedOffset: closedOffset)
            let confirmationProgress = confirmationSheetProgress(closedOffset: closedOffset)

            ZStack(alignment: .bottom) {
                Color.white.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 0) {
                        singleHeroSection

                        VStack(spacing: 16) {
                            if let errorMessage {
                                sellOrderValidationBanner(errorMessage)
                            }

                            singleDetailsCard
                                .frame(maxWidth: sellOrderSingleFormMaxWidth)

                            if let attachedPhoto {
                                sellOrderAttachedPhotoPreview(attachedPhoto)
                                    .frame(maxWidth: sellOrderSingleFormMaxWidth)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 20)
                        .padding(.top, errorMessage == nil ? -8 : 10)
                        .padding(.bottom, sellOrderSwipeRailHeight + 56)
                    }
                    .frame(minHeight: containerHeight, alignment: .top)
                }
                .offset(y: -confirmationContentLift(containerHeight: containerHeight, closedOffset: closedOffset))
                .scrollDismissesKeyboard(.interactively)

                singleConfirmationSheet(progress: confirmationProgress, closedOffset: closedOffset)
                    .offset(y: currentOffset)
                    .ignoresSafeArea(edges: .bottom)
                    .allowsHitTesting(focusedField == nil)
            }
            .onAppear {
                initializeConfirmationSheetIfNeeded(closedOffset: closedOffset)
            }
            .onChange(of: closedOffset) { _, newValue in
                updateConfirmationSheetClosedOffset(newValue)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: submitState)
        .contentShape(Rectangle())
        .onTapGesture {
            clearFocus()
        }
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onChange(of: focusedField) { _, newValue in
            guard newValue != nil else { return }
            confirmationSheetOffset = lastClosedConfirmationSheetOffset
            liveSwipeTranslation = 0
        }
#if canImport(PhotosUI)
        .onChange(of: selectedPhotoItem) { _, newItem in
            Task {
                attachedPhoto = await sellOrderLoadImage(from: newItem)
            }
        }
        #endif
    }

    private var singleHeader: some View {
        ZStack {
            Text("Sell order")
                .font(.headline.weight(.semibold))
                .foregroundStyle(Color.black.opacity(0.92))
                .frame(maxWidth: .infinity)

            HStack {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Color.black.opacity(0.72))
                        .frame(width: 34, height: 34)
                        .background(Color(uiColor: .systemGray6))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)

                Spacer()
            }
        }
        .frame(height: 40)
    }

    private var singleHeroSection: some View {
        ZStack(alignment: .top) {
            CardArtworkView(
                urlString: draft.entry.card.imageSmallURL ?? draft.entry.card.imageLargeURL,
                fallbackTitle: draft.entry.card.name,
                cornerRadius: 0,
                contentMode: .fill
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .blur(radius: 44)
            .clipped()

            Rectangle()
                .fill(.ultraThinMaterial)
                .opacity(0.34)

            LinearGradient(
                colors: [
                    Color.white.opacity(0.12),
                    Color.white.opacity(0.26),
                    Color.white.opacity(0.62),
                    Color.white
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            VStack(spacing: 0) {
                singleHeader
                    .padding(.horizontal, 20)
                    .padding(.top, 12)

                Spacer(minLength: 12)

                Text(draft.entry.card.name)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(Color.black.opacity(0.82))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .padding(.horizontal, 48)
                    .padding(.bottom, 12)

                CardArtworkView(
                    urlString: draft.entry.card.imageSmallURL ?? draft.entry.card.imageLargeURL,
                    fallbackTitle: draft.entry.card.name,
                    cornerRadius: 12,
                    contentMode: .fit
                )
                .frame(width: 138, height: 192)
                .shadow(color: Color.black.opacity(0.16), radius: 10, x: 0, y: 8)

                Spacer(minLength: 56)
            }
        }
        .frame(height: 308)
        .frame(maxWidth: .infinity)
        .clipped()
    }

    private var singleDetailsCard: some View {
        VStack(spacing: 0) {
            singleDetailRow(title: "Quantity") {
                HStack(spacing: 14) {
                    singleStepperButton(title: "-", disabled: quantity <= 1) {
                        quantity = max(1, quantity - 1)
                        errorMessage = nil
                    }

                    Text("\(quantity)")
                        .font(sellOrderSingleValueFont)
                        .foregroundStyle(Color.black.opacity(0.92))
                        .frame(minWidth: 18)

                    singleStepperButton(title: "+", disabled: quantity >= max(1, draft.quantityLimit)) {
                        quantity = min(max(1, draft.quantityLimit), quantity + 1)
                        errorMessage = nil
                    }
                }
            }

            Divider()

            singleDetailRow(title: "Market Price") {
                Text(marketPrice.map { sellOrderFormattedPrice($0, currencyCode: currencyCode) } ?? "--")
                    .font(sellOrderSingleValueFont)
                    .foregroundStyle(Color.black.opacity(0.92))
            }

            Divider()

            singleDetailRow(title: "Bought Price") {
                HStack(spacing: 10) {
                    Text(
                        sellOrderBoughtPriceLabel(
                            boughtPrice,
                            currencyCode: draft.entry.costBasisCurrencyCode ?? currencyCode,
                            revealsValue: revealsBoughtPrice
                        )
                    )
                    .font(sellOrderSingleValueFont)
                    .foregroundStyle(Color.black.opacity(0.92))

                    Button {
                        guard boughtPrice != nil else { return }
                        revealsBoughtPrice.toggle()
                    } label: {
                        Image(systemName: revealsBoughtPrice ? "eye" : "eye.slash")
                            .font(sellOrderSingleValueFont)
                            .foregroundStyle(Color.black.opacity(boughtPrice == nil ? 0.28 : 0.62))
                    }
                    .buttonStyle(.plain)
                    .disabled(boughtPrice == nil)
                }
            }

            Divider()

            singleOfferCalculatorSection

            Divider()

#if canImport(PhotosUI)
            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                sellOrderSinglePhotoRowLabel()
            }
            .buttonStyle(.plain)
#else
            sellOrderSinglePhotoRowLabel()
#endif

            Divider()

            singleDetailRow(title: "Sell Price") {
                sellOrderPriceField(
                    text: Binding(
                        get: { soldPriceText },
                        set: { newValue in
                            soldPriceText = sellOrderSanitizedPriceText(newValue)
                            errorMessage = nil
                        }
                    ),
                    placeholder: "00",
                    width: 132,
                    focus: .soldPrice,
                    focusedField: $focusedField,
                    isRequired: true,
                    showsError: parsedSoldPrice == nil && errorMessage != nil,
                    fontSize: 17,
                    minHeight: 48,
                    cornerRadius: 20,
                    horizontalPadding: 14
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .padding(.horizontal, 20)
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(.white)
                .shadow(color: Color.black.opacity(0.08), radius: 18, x: 0, y: 10)
        )
    }

    private var singleOfferCalculatorSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Offer Calculator")
                .font(sellOrderSingleLabelFont)
                .foregroundStyle(Color.black.opacity(0.92))

            HStack(alignment: .top, spacing: 12) {
                singleLabeledInputField(
                    title: "Offer Price",
                    text: Binding(
                        get: { offerPriceText },
                        set: { newValue in
                            offerPriceText = sellOrderSanitizedPriceText(newValue)
                            errorMessage = nil
                        }
                    ),
                    focus: .offerPrice
                )

                Text("/")
                    .font(.body)
                    .foregroundStyle(Color.black.opacity(0.38))
                    .padding(.top, 34)

                singleLabeledInputField(
                    title: "Your Price (YP)",
                    text: Binding(
                        get: { yourPriceText },
                        set: { newValue in
                            yourPriceText = sellOrderSanitizedPriceText(newValue)
                            errorMessage = nil
                        }
                    ),
                    focus: .yourPrice
                )
            }

            if let ypPercentText {
                Text(ypPercentText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.black.opacity(0.48))
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.vertical, 18)
    }

    private func singleLabeledInputField(
        title: String,
        text: Binding<String>,
        focus: SingleSellField
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption)
                .foregroundStyle(Color.black.opacity(0.42))

            sellOrderPriceField(
                text: text,
                placeholder: "00",
                width: nil,
                focus: focus,
                focusedField: $focusedField,
                isRequired: false,
                showsError: false,
                fontSize: 17,
                minHeight: 48,
                cornerRadius: 20,
                horizontalPadding: 14
            )
        }
        .frame(maxWidth: .infinity)
    }

    private func singleDetailRow<Content: View>(
        title: String,
        @ViewBuilder trailing: () -> Content
    ) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Text(title)
                .font(sellOrderSingleLabelFont)
                .foregroundStyle(Color.black.opacity(0.92))

            Spacer(minLength: 12)

            trailing()
                .layoutPriority(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 18)
    }

    private func singleStepperButton(
        title: String,
        disabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.black.opacity(disabled ? 0.28 : 0.82))
                .frame(width: 34, height: 34)
                .background(Color(uiColor: .systemGray6))
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func closedConfirmationSheetOffset(containerHeight: CGFloat) -> CGFloat {
        max(0, containerHeight - sellOrderSwipeRailHeight)
    }

    private func initializeConfirmationSheetIfNeeded(closedOffset: CGFloat) {
        guard !hasInitializedConfirmationSheet else { return }
        confirmationSheetOffset = closedOffset
        lastClosedConfirmationSheetOffset = closedOffset
        hasInitializedConfirmationSheet = true
    }

    private func updateConfirmationSheetClosedOffset(_ closedOffset: CGFloat) {
        if !hasInitializedConfirmationSheet {
            initializeConfirmationSheetIfNeeded(closedOffset: closedOffset)
            return
        }

        if abs(confirmationSheetOffset - lastClosedConfirmationSheetOffset) < 1 {
            confirmationSheetOffset = closedOffset
        }
        lastClosedConfirmationSheetOffset = closedOffset
    }

    private func currentConfirmationSheetOffset(closedOffset: CGFloat) -> CGFloat {
        let baseOffset = hasInitializedConfirmationSheet ? confirmationSheetOffset : closedOffset
        let translatedOffset = baseOffset + resistedSwipeTranslation(liveSwipeTranslation)
        return min(max(0, translatedOffset), closedOffset)
    }

    private func confirmationSheetProgress(closedOffset: CGFloat) -> CGFloat {
        guard closedOffset > 0 else { return 0 }
        return 1 - (currentConfirmationSheetOffset(closedOffset: closedOffset) / closedOffset)
    }

    private func confirmationContentLift(containerHeight: CGFloat, closedOffset: CGFloat) -> CGFloat {
        confirmationSheetProgress(closedOffset: closedOffset) * max(0, min(containerHeight, closedOffset + sellOrderSwipeRailHeight))
    }

    private func resistedSwipeTranslation(_ translation: CGFloat) -> CGFloat {
        if translation < 0 {
            return translation * 0.88
        }
        return translation * 0.35
    }

    private func singleConfirmationSheet(progress: CGFloat, closedOffset: CGFloat) -> some View {
        sellOrderInteractiveConfirmationSheet(
            submitState: submitState,
            processingHeadline: processingHeadline,
            processingDetail: processingDetail,
            successHeadline: successHeadline,
            successDetail: successDetail
        ) {
            sellOrderSwipeActionBar(
                title: releaseToConfirmArmed ? "Release to confirm sale" : "Swipe up to confirm sale",
                progress: progress,
                isDisabled: !canInteract
            )
            .gesture(singleSellSwipeGesture(closedOffset: closedOffset))
        }
    }

    private func singleSellSwipeGesture(closedOffset: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard canInteract else { return }
                let upwardTravel = max(0, -value.translation.height)
                guard canSubmit else {
                    if upwardTravel > 6 {
                        errorMessage = "Enter a sell price before confirming sale."
                    }
                    liveSwipeTranslation = 0
                    return
                }
                liveSwipeTranslation = value.translation.height
            }
            .onEnded { value in
                guard canInteract else { return }
                let upwardTravel = max(0, -value.translation.height)
                liveSwipeTranslation = 0
                guard canSubmit else {
                    errorMessage = "Enter a sell price before confirming sale."
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                        confirmationSheetOffset = closedOffset
                    }
                    return
                }
                if upwardTravel >= sellOrderSwipeThreshold {
                    withAnimation(.spring(response: 0.42, dampingFraction: 0.9)) {
                        confirmationSheetOffset = 0
                    }
                    submitSale(closedOffset: closedOffset)
                } else {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                        confirmationSheetOffset = closedOffset
                    }
                }
            }
    }

    private func submitSale(closedOffset: CGFloat) {
        guard let soldPrice = parsedSoldPrice else {
            errorMessage = "Enter a sell price before confirming sale."
            withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                confirmationSheetOffset = closedOffset
            }
            return
        }

        clearFocus()
        submitState = .processing
        errorMessage = nil
        let startedAt = Date()

        Task {
            do {
                try await onConfirm(
                    ShowSellSubmission(
                        quantity: quantity,
                        unitPrice: soldPrice,
                        paymentMethod: nil,
                        note: nil
                    )
                )
                let elapsed = Date().timeIntervalSince(startedAt)
                let remaining = max(0, sellOrderProcessingMinimumDuration - elapsed)
                if remaining > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
                }
                await MainActor.run {
                    submitState = .success
                }
                try? await Task.sleep(
                    nanoseconds: UInt64(sellOrderSuccessDisplayDuration * 1_000_000_000)
                )
                await MainActor.run {
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    submitState = .idle
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                        confirmationSheetOffset = closedOffset
                    }
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func clearFocus() {
        focusedField = nil
        sellOrderDismissKeyboard()
    }
}

@MainActor
struct ShowSellBatchPreviewSheet: View {
    let draft: ShowSellBatchDraft
    let onConfirm: (ShowSellBatchSubmission) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme
    @State private var lineStatesByID: [String: BatchSellLineState]
    @State private var submitState: SellOrderSubmitState = .idle
    @State private var errorMessage: String?
    @State private var liveSwipeTranslation: CGFloat = 0
    @State private var confirmationSheetOffset: CGFloat = 0
    @State private var lastClosedConfirmationSheetOffset: CGFloat = 0
    @State private var hasInitializedConfirmationSheet = false
    @FocusState private var focusedField: BatchSellField?
#if canImport(PhotosUI)
    @State private var selectedPhotoItem: PhotosPickerItem?
#endif
    @State private var attachedPhoto: UIImage?

    init(
        draft: ShowSellBatchDraft,
        onConfirm: @escaping (ShowSellBatchSubmission) async throws -> Void
    ) {
        self.draft = draft
        self.onConfirm = onConfirm
        _lineStatesByID = State(
            initialValue: Dictionary(
                uniqueKeysWithValues: draft.lines.map { line in
                    (
                        line.id,
                        BatchSellLineState(
                            quantity: line.quantityLimit,
                            offerPriceText: "",
                            yourPriceText: line.suggestedUnitPrice > 0
                                ? sellOrderEditableNumericText(line.suggestedUnitPrice)
                                : "",
                            soldPriceText: ""
                        )
                    )
                }
            )
        )
    }

    private var activeLines: [ShowSellBatchLineDraft] {
        draft.lines.filter { quantity(for: $0) > 0 }
    }

    private var totalSelectedQuantity: Int {
        activeLines.reduce(0) { $0 + quantity(for: $1) }
    }

    private var summaryCurrencyCode: String {
        draft.lines.first?.entry.card.pricing?.currencyCode
            ?? draft.lines.first?.entry.costBasisCurrencyCode
            ?? "USD"
    }

    private var grossTotal: Double {
        activeLines.reduce(0) { partialResult, line in
            partialResult + (Double(quantity(for: line)) * (soldPrice(for: line) ?? 0))
        }
    }

    private var canInteract: Bool {
        submitState == .idle && focusedField == nil
    }

    private var hasMissingActiveSoldPrice: Bool {
        activeLines.contains { soldPrice(for: $0) == nil }
    }

    private var showsGlobalBatchValidationBanner: Bool {
        guard let errorMessage else { return false }
        return errorMessage != batchSellMissingPriceErrorMessage
    }

    private var releaseToConfirmArmed: Bool {
        confirmationSheetProgress(closedOffset: lastClosedConfirmationSheetOffset) >= 0.42
    }

    private var processingHeadline: String {
        "Selling \(sellOrderFormattedPrice(grossTotal, currencyCode: summaryCurrencyCode))"
    }

    private var processingDetail: String {
        totalSelectedQuantity == 1
            ? "Locking in 1 card."
            : "Locking in \(totalSelectedQuantity) cards."
    }

    private var successDetail: String {
        totalSelectedQuantity == 1
            ? "1 card sold for \(sellOrderFormattedPrice(grossTotal, currencyCode: summaryCurrencyCode))."
            : "\(totalSelectedQuantity) cards sold for \(sellOrderFormattedPrice(grossTotal, currencyCode: summaryCurrencyCode))."
    }

    var body: some View {
        return GeometryReader { proxy in
            let containerHeight = max(0, proxy.size.height - proxy.safeAreaInsets.top - proxy.safeAreaInsets.bottom)
            let closedOffset = closedConfirmationSheetOffset(containerHeight: containerHeight)
            let currentOffset = currentConfirmationSheetOffset(closedOffset: closedOffset)
            let confirmationProgress = confirmationSheetProgress(closedOffset: closedOffset)

            ZStack(alignment: .bottom) {
                Color.white.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 0) {
                        batchHero

                        VStack(spacing: 16) {
                            if let errorMessage, showsGlobalBatchValidationBanner {
                                sellOrderValidationBanner(errorMessage)
                            }

                            ForEach(draft.lines) { line in
                                batchLineCard(line)
                            }

                            if let attachedPhoto {
                                sellOrderAttachedPhotoPreview(attachedPhoto)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 20)
                        .padding(.top, showsGlobalBatchValidationBanner ? 10 : -8)
                        .padding(.bottom, sellOrderSwipeRailHeight + 56)
                    }
                    .frame(minHeight: containerHeight, alignment: .top)
                }
                .offset(y: -confirmationContentLift(containerHeight: containerHeight, closedOffset: closedOffset))
                .scrollDismissesKeyboard(.interactively)

                batchConfirmationSheet(progress: confirmationProgress, closedOffset: closedOffset)
                    .offset(y: currentOffset)
                    .ignoresSafeArea(edges: .bottom)
                    .allowsHitTesting(focusedField == nil)
            }
            .onAppear {
                initializeConfirmationSheetIfNeeded(closedOffset: closedOffset)
            }
            .onChange(of: closedOffset) { _, newValue in
                updateConfirmationSheetClosedOffset(newValue)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: submitState)
        .contentShape(Rectangle())
        .onTapGesture {
            clearFocus()
        }
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .onChange(of: focusedField) { _, newValue in
            guard newValue != nil else { return }
            confirmationSheetOffset = lastClosedConfirmationSheetOffset
            liveSwipeTranslation = 0
        }
#if canImport(PhotosUI)
        .onChange(of: selectedPhotoItem) { _, newItem in
            Task {
                attachedPhoto = await sellOrderLoadImage(from: newItem)
            }
        }
#endif
    }

    private var batchHero: some View {
        ZStack(alignment: .top) {
            CardArtworkView(
                urlString: draft.lines.first?.entry.card.imageSmallURL ?? draft.lines.first?.entry.card.imageLargeURL,
                fallbackTitle: draft.lines.first?.entry.card.name ?? "Cards",
                cornerRadius: 0,
                contentMode: .fill
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .blur(radius: 44)
            .clipped()

            Rectangle()
                .fill(.ultraThinMaterial)
                .opacity(0.34)

            LinearGradient(
                colors: [
                    Color.white.opacity(0.12),
                    Color.white.opacity(0.26),
                    Color.white.opacity(0.62),
                    Color.white
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            VStack(spacing: 0) {
                sellOrderTopChrome(title: "Sell order") {
                    dismiss()
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)

                Spacer(minLength: 10)

                Text(totalSelectedQuantity == 1 ? "1 card selected" : "\(totalSelectedQuantity) cards selected")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(Color.black.opacity(0.72))

                Text(sellOrderFormattedPrice(grossTotal, currencyCode: summaryCurrencyCode))
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.black.opacity(0.88))
                    .padding(.top, 4)

                ZStack {
                    ForEach(Array(draft.lines.prefix(3).enumerated()), id: \.offset) { index, line in
                        let width: CGFloat = index == 0 ? 126 : 104
                        let height = width * 1.39
                        let xOffset: CGFloat = index == 0 ? 0 : (index == 1 ? -62 : 62)
                        let rotation: Double = index == 0 ? 0 : (index == 1 ? -8 : 8)

                        CardArtworkView(
                            urlString: line.entry.card.imageSmallURL ?? line.entry.card.imageLargeURL,
                            fallbackTitle: line.entry.card.name,
                            cornerRadius: 12,
                            contentMode: .fit
                        )
                        .frame(width: width, height: height)
                        .shadow(color: Color.black.opacity(0.16), radius: 10, x: 0, y: 8)
                        .rotationEffect(.degrees(rotation))
                        .offset(x: xOffset, y: index == 0 ? 0 : 10)
                    }
                }
                .frame(height: 202)
                .padding(.top, 14)

                Spacer(minLength: 54)
            }
        }
        .frame(height: 320)
        .frame(maxWidth: .infinity)
        .clipped()
    }

    private func batchLineCard(_ line: ShowSellBatchLineDraft) -> some View {
        let state = lineState(for: line)
        let currencyCode = line.entry.card.pricing?.currencyCode ?? line.entry.costBasisCurrencyCode ?? "USD"
        let showsSellPriceValidation = errorMessage == batchSellMissingPriceErrorMessage &&
            quantity(for: line) > 0 &&
            soldPrice(for: line) == nil

        return sellOrderCard {
            HStack(alignment: .center, spacing: 16) {
                CardArtworkView(
                    urlString: line.entry.card.imageSmallURL ?? line.entry.card.imageLargeURL,
                    fallbackTitle: line.entry.card.name,
                    cornerRadius: 10,
                    contentMode: .fit
                )
                .frame(width: 62, height: 88)

                VStack(alignment: .leading, spacing: 6) {
                    Text(line.entry.card.name)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.black.opacity(0.92))
                        .lineLimit(2)

                    Text("\(line.entry.card.setName) • #\(line.entry.card.number)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.black.opacity(0.52))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 14)

            Divider()

            batchDetailRow(title: "Quantity") {
                sellOrderQuantityStepper(
                    quantity: quantity(for: line),
                    canDecrement: quantity(for: line) > 0,
                    canIncrement: quantity(for: line) < line.quantityLimit,
                    fontSize: 17,
                    buttonSize: 34,
                    spacing: 14,
                    valueMinWidth: 18,
                    onDecrement: {
                        updateLineState(for: line) { current in
                            current.quantity = max(0, current.quantity - 1)
                        }
                        errorMessage = nil
                    },
                    onIncrement: {
                        updateLineState(for: line) { current in
                            current.quantity = min(line.quantityLimit, current.quantity + 1)
                        }
                        errorMessage = nil
                    }
                )
            }

            Divider()

            batchDetailRow(title: "Market Price") {
                batchTrailingValue(
                    line.entry.primaryPrice.map { sellOrderFormattedPrice($0, currencyCode: currencyCode) } ?? "--"
                )
            }

            Divider()

            batchDetailRow(title: "Bought Price") {
                HStack(spacing: 10) {
                    batchTrailingValue(
                        sellOrderBoughtPriceLabel(
                            line.entry.costBasisPerUnit,
                            currencyCode: line.entry.costBasisCurrencyCode ?? currencyCode,
                            revealsValue: state.revealsBoughtPrice
                        )
                    )
                    Button {
                        guard line.entry.costBasisPerUnit != nil else { return }
                        updateLineState(for: line) { current in
                            current.revealsBoughtPrice.toggle()
                        }
                    } label: {
                        Image(systemName: state.revealsBoughtPrice ? "eye" : "eye.slash")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.black.opacity(line.entry.costBasisPerUnit == nil ? 0.28 : 0.62))
                    }
                    .buttonStyle(.plain)
                    .disabled(line.entry.costBasisPerUnit == nil)
                }
            }

            Divider()

            batchOfferCalculatorSection(
                offerPriceText: binding(for: line, kind: .offerPrice),
                yourPriceText: binding(for: line, kind: .yourPrice),
                ypPercentText: ypPercentText(for: line),
                offerFocus: .line(id: line.id, kind: .offerPrice),
                yourFocus: .line(id: line.id, kind: .yourPrice),
                focusedField: $focusedField
            )

            Divider()

            batchDetailRow(title: "Sell Price") {
                sellOrderPriceField(
                    text: binding(for: line, kind: .soldPrice),
                    placeholder: "00",
                    width: 132,
                    focus: .line(id: line.id, kind: .soldPrice),
                    focusedField: $focusedField,
                    isRequired: true,
                    showsError: showsSellPriceValidation,
                    fontSize: 17,
                    minHeight: 48,
                    cornerRadius: 20,
                    horizontalPadding: 14
                )
            }

            if showsSellPriceValidation {
                sellOrderInlineValidationMessage("Enter a sell price before confirming sale.")
                    .padding(.top, 8)
            }
        }
        .opacity(quantity(for: line) == 0 ? 0.64 : 1)
        .frame(maxWidth: sellOrderFormWidth)
    }

    private func closedConfirmationSheetOffset(containerHeight: CGFloat) -> CGFloat {
        max(0, containerHeight - sellOrderSwipeRailHeight)
    }

    private func initializeConfirmationSheetIfNeeded(closedOffset: CGFloat) {
        guard !hasInitializedConfirmationSheet else { return }
        confirmationSheetOffset = closedOffset
        lastClosedConfirmationSheetOffset = closedOffset
        hasInitializedConfirmationSheet = true
    }

    private func updateConfirmationSheetClosedOffset(_ closedOffset: CGFloat) {
        if !hasInitializedConfirmationSheet {
            initializeConfirmationSheetIfNeeded(closedOffset: closedOffset)
            return
        }

        if abs(confirmationSheetOffset - lastClosedConfirmationSheetOffset) < 1 {
            confirmationSheetOffset = closedOffset
        }
        lastClosedConfirmationSheetOffset = closedOffset
    }

    private func currentConfirmationSheetOffset(closedOffset: CGFloat) -> CGFloat {
        let baseOffset = hasInitializedConfirmationSheet ? confirmationSheetOffset : closedOffset
        let translatedOffset = baseOffset + resistedSwipeTranslation(liveSwipeTranslation)
        return min(max(0, translatedOffset), closedOffset)
    }

    private func confirmationSheetProgress(closedOffset: CGFloat) -> CGFloat {
        guard closedOffset > 0 else { return 0 }
        return 1 - (currentConfirmationSheetOffset(closedOffset: closedOffset) / closedOffset)
    }

    private func confirmationContentLift(containerHeight: CGFloat, closedOffset: CGFloat) -> CGFloat {
        confirmationSheetProgress(closedOffset: closedOffset) * max(0, min(containerHeight, closedOffset + sellOrderSwipeRailHeight))
    }

    private func resistedSwipeTranslation(_ translation: CGFloat) -> CGFloat {
        if translation < 0 {
            return translation * 0.88
        }
        return translation * 0.35
    }

    private func batchConfirmationSheet(progress: CGFloat, closedOffset: CGFloat) -> some View {
        sellOrderInteractiveConfirmationSheet(
            submitState: submitState,
            processingHeadline: processingHeadline,
            processingDetail: processingDetail,
            successHeadline: "Batch sale confirmed",
            successDetail: successDetail
        ) {
            sellOrderSwipeActionBar(
                title: releaseToConfirmArmed ? "Release to confirm sale" : "Swipe up to confirm sale",
                progress: progress,
                isDisabled: !canInteract
            )
            .gesture(batchSellSwipeGesture(closedOffset: closedOffset))
        }
    }

    private func batchSellSwipeGesture(closedOffset: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard canInteract else { return }
                let upwardTravel = max(0, -value.translation.height)
                guard !activeLines.isEmpty else {
                    if upwardTravel > 6 {
                        errorMessage = batchSellEmptySelectionErrorMessage
                    }
                    liveSwipeTranslation = 0
                    return
                }
                guard !hasMissingActiveSoldPrice else {
                    if upwardTravel > 6 {
                        errorMessage = batchSellMissingPriceErrorMessage
                    }
                    liveSwipeTranslation = 0
                    return
                }
                liveSwipeTranslation = value.translation.height
            }
            .onEnded { value in
                guard canInteract else { return }
                let upwardTravel = max(0, -value.translation.height)
                liveSwipeTranslation = 0
                guard !activeLines.isEmpty else {
                    errorMessage = batchSellEmptySelectionErrorMessage
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                        confirmationSheetOffset = closedOffset
                    }
                    return
                }
                guard !hasMissingActiveSoldPrice else {
                    errorMessage = batchSellMissingPriceErrorMessage
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                        confirmationSheetOffset = closedOffset
                    }
                    return
                }
                if upwardTravel >= sellOrderSwipeThreshold {
                    withAnimation(.spring(response: 0.42, dampingFraction: 0.9)) {
                        confirmationSheetOffset = 0
                    }
                    submitBatchSale(closedOffset: closedOffset)
                } else {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                        confirmationSheetOffset = closedOffset
                    }
                }
            }
    }

    private func submitBatchSale(closedOffset: CGFloat) {
        guard !activeLines.isEmpty else {
            errorMessage = batchSellEmptySelectionErrorMessage
            withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                confirmationSheetOffset = closedOffset
            }
            return
        }
        guard !hasMissingActiveSoldPrice else {
            errorMessage = batchSellMissingPriceErrorMessage
            withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                confirmationSheetOffset = closedOffset
            }
            return
        }

        clearFocus()
        submitState = .processing
        errorMessage = nil
        let startedAt = Date()

        Task {
            do {
                try await onConfirm(
                    ShowSellBatchSubmission(
                        lines: activeLines.compactMap { line in
                            guard let soldPrice = soldPrice(for: line) else {
                                return nil
                            }
                            return ShowSellBatchLineSubmission(
                                id: line.id,
                                entry: line.entry,
                                quantity: quantity(for: line),
                                unitPrice: soldPrice,
                                sourceItemIDs: line.sourceItemIDs
                            )
                        },
                        paymentMethod: nil,
                        note: nil
                    )
                )
                let elapsed = Date().timeIntervalSince(startedAt)
                let remaining = max(0, sellOrderProcessingMinimumDuration - elapsed)
                if remaining > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
                }
                await MainActor.run {
                    submitState = .success
                }
                try? await Task.sleep(
                    nanoseconds: UInt64(sellOrderSuccessDisplayDuration * 1_000_000_000)
                )
                await MainActor.run {
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    submitState = .idle
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                        confirmationSheetOffset = closedOffset
                    }
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func lineState(for line: ShowSellBatchLineDraft) -> BatchSellLineState {
        lineStatesByID[line.id]
            ?? BatchSellLineState(quantity: line.quantityLimit, offerPriceText: "", yourPriceText: "", soldPriceText: "")
    }

    private func updateLineState(
        for line: ShowSellBatchLineDraft,
        _ update: (inout BatchSellLineState) -> Void
    ) {
        var current = lineState(for: line)
        update(&current)
        lineStatesByID[line.id] = current
    }

    private func quantity(for line: ShowSellBatchLineDraft) -> Int {
        min(max(0, lineState(for: line).quantity), line.quantityLimit)
    }

    private func soldPrice(for line: ShowSellBatchLineDraft) -> Double? {
        sellOrderParsedPrice(from: lineState(for: line).soldPriceText)
    }

    private func ypPercentText(for line: ShowSellBatchLineDraft) -> String? {
        let state = lineState(for: line)
        guard let offer = sellOrderParsedPrice(from: state.offerPriceText),
              let your = sellOrderParsedPrice(from: state.yourPriceText),
              offer > 0 else {
            return nil
        }
        return "\(sellOrderFormattedPercent((your / offer) * 100)) YP"
    }

    private func binding(
        for line: ShowSellBatchLineDraft,
        kind: BatchSellFieldKind
    ) -> Binding<String> {
        Binding(
            get: {
                let state = lineState(for: line)
                switch kind {
                case .offerPrice:
                    return state.offerPriceText
                case .yourPrice:
                    return state.yourPriceText
                case .soldPrice:
                    return state.soldPriceText
                }
            },
            set: { newValue in
                let sanitized = sellOrderSanitizedPriceText(newValue)
                updateLineState(for: line) { current in
                    switch kind {
                    case .offerPrice:
                        current.offerPriceText = sanitized
                    case .yourPrice:
                        current.yourPriceText = sanitized
                    case .soldPrice:
                        current.soldPriceText = sanitized
                    }
                }
                errorMessage = nil
            }
        )
    }

    private func clearFocus() {
        focusedField = nil
        sellOrderDismissKeyboard()
    }
}

private func sellOrderBackdrop(
    artworkURL: String?,
    fallbackTitle: String
) -> some View {
    ZStack {
        Color.white

        CardArtworkView(
            urlString: artworkURL,
            fallbackTitle: fallbackTitle,
            cornerRadius: 0,
            contentMode: .fill
        )
        .frame(maxWidth: .infinity)
        .frame(maxHeight: .infinity)
        .clipped()
        .blur(radius: 32)
        .scaleEffect(1.22)
        .saturation(1.05)
        .opacity(0.55)

        Rectangle()
            .fill(.ultraThinMaterial)
            .opacity(0.34)

        LinearGradient(
            colors: [
                Color.white.opacity(0.08),
                Color.white.opacity(0.36),
                Color.white.opacity(0.82),
                Color.white
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }
    .ignoresSafeArea()
}

@MainActor
private func sellOrderTopChrome(
    title: String,
    onClose: @MainActor @escaping () -> Void
) -> some View {
    HStack(alignment: .top) {
        Button {
            onClose()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Color.black.opacity(0.72))
                .frame(width: 30, height: 30)
                .background(Color.white.opacity(0.92))
                .clipShape(Circle())
        }
        .buttonStyle(.plain)

        Spacer()

        VStack(spacing: 8) {
            Capsule(style: .continuous)
                .fill(Color.white.opacity(0.96))
                .frame(width: 56, height: 5)

            Text(title)
                .font(.system(size: 16, weight: .bold, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.88))
        }

        Spacer()

        Color.clear.frame(width: 30, height: 30)
    }
    .padding(.horizontal, 4)
    .padding(.top, 10)
}

private func sellOrderCard<Content: View>(
    @ViewBuilder content: () -> Content
) -> some View {
    VStack(spacing: 0) {
        content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 20)
    .padding(.vertical, 20)
    .background(Color.white)
    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    .shadow(color: Color.black.opacity(0.08), radius: 18, x: 0, y: 10)
}

private func sellOrderFormRow<Trailing: View>(
    title: String,
    alignsTop: Bool = false,
    @ViewBuilder trailing: () -> Trailing
) -> some View {
    VStack(spacing: 16) {
        HStack(alignment: alignsTop ? .top : .center, spacing: 12) {
            Text(title)
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.black.opacity(0.92))

            Spacer(minLength: 0)

            trailing()
        }

        sellOrderDivider()
    }
}

private func sellOrderDivider() -> some View {
    Rectangle()
        .fill(Color.black.opacity(0.08))
        .frame(height: 1)
}

private func sellOrderTrailingValue(_ value: String) -> some View {
    Text(value)
        .font(.body.weight(.semibold))
        .foregroundStyle(Color.black.opacity(0.92))
}

private func batchDetailRow<Trailing: View>(
    title: String,
    @ViewBuilder trailing: () -> Trailing
) -> some View {
    HStack(alignment: .center, spacing: 12) {
        Text(title)
            .font(sellOrderSingleLabelFont)
            .foregroundStyle(Color.black.opacity(0.92))

        Spacer(minLength: 12)

        trailing()
            .layoutPriority(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 18)
}

private func batchTrailingValue(_ value: String) -> some View {
    Text(value)
        .font(sellOrderSingleValueFont)
        .foregroundStyle(Color.black.opacity(0.92))
}

private func sellOrderBoughtPriceLabel(
    _ value: Double?,
    currencyCode: String,
    revealsValue: Bool
) -> String {
    guard let value else { return "--" }
    if revealsValue {
        return sellOrderFormattedPrice(value, currencyCode: currencyCode)
    }
    return "*****"
}

@MainActor
private func sellOrderQuantityStepper(
    quantity: Int,
    canDecrement: Bool,
    canIncrement: Bool,
    fontSize: CGFloat = 16,
    buttonSize: CGFloat = 30,
    spacing: CGFloat = 14,
    valueMinWidth: CGFloat = 16,
    incrementEmphasis: Bool = false,
    onDecrement: @escaping () -> Void,
    onIncrement: @escaping () -> Void
) -> some View {
    HStack(spacing: spacing) {
        sellOrderStepperButton(
            title: "-",
            isDisabled: !canDecrement,
            buttonSize: buttonSize,
            fontSize: fontSize,
            action: onDecrement
        )

        Text("\(quantity)")
            .font(.system(size: fontSize, weight: .semibold, design: .rounded))
            .foregroundStyle(Color.black.opacity(0.92))
            .frame(minWidth: valueMinWidth)

        sellOrderStepperButton(
            title: "+",
            isDisabled: !canIncrement,
            buttonSize: buttonSize,
            fontSize: fontSize,
            emphasis: incrementEmphasis,
            action: onIncrement
        )
    }
}

@MainActor
private func sellOrderStepperButton(
    title: String,
    isDisabled: Bool,
    buttonSize: CGFloat = 24,
    fontSize: CGFloat = 12,
    emphasis: Bool = false,
    action: @escaping () -> Void
) -> some View {
    Button(action: action) {
        Text(title)
            .font(.system(size: fontSize, weight: .semibold, design: .rounded))
            .foregroundStyle(
                emphasis
                    ? Color(red: 0.24, green: 0.49, blue: 0.95).opacity(isDisabled ? 0.28 : 1)
                    : Color.black.opacity(isDisabled ? 0.28 : 0.88)
            )
            .frame(width: buttonSize, height: buttonSize)
            .background(
                RoundedRectangle(cornerRadius: emphasis ? 7 : (buttonSize / 2), style: .continuous)
                    .fill(Color.white.opacity(emphasis ? 0.98 : 0.96))
            )
            .overlay(
                RoundedRectangle(cornerRadius: emphasis ? 7 : (buttonSize / 2), style: .continuous)
                    .stroke(
                        emphasis
                            ? Color(red: 0.24, green: 0.49, blue: 0.95).opacity(isDisabled ? 0.18 : 0.9)
                            : Color.black.opacity(0.04),
                        lineWidth: emphasis ? 1.4 : 1
                    )
            )
    }
    .buttonStyle(.plain)
    .disabled(isDisabled)
}

private func sellOrderOfferCalculator<Focus: Hashable>(
    offerPriceText: Binding<String>,
    yourPriceText: Binding<String>,
    ypPercentText: String?,
    offerFocus: Focus,
    yourFocus: Focus,
    focusedField: FocusState<Focus?>.Binding
) -> some View {
    VStack(alignment: .leading, spacing: 14) {
        Text("Offer Calculator")
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.black.opacity(0.92))

        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 0) {
                Text("Offer Price")
                Spacer()
                Text("Your Price (YP)")
            }
            .font(.caption)
            .foregroundStyle(Color.black.opacity(0.42))

            HStack(alignment: .top, spacing: 12) {
                sellOrderPriceField(
                    text: offerPriceText,
                    placeholder: "00",
                    width: nil,
                    focus: offerFocus,
                    focusedField: focusedField,
                    isRequired: false,
                    showsError: false,
                    fontSize: 17,
                    minHeight: 48,
                    cornerRadius: 20,
                    horizontalPadding: 14
                )

                Text("/")
                    .font(.body)
                    .foregroundStyle(Color.black.opacity(0.38))
                    .padding(.top, 12)

                sellOrderPriceField(
                    text: yourPriceText,
                    placeholder: "00",
                    width: nil,
                    focus: yourFocus,
                    focusedField: focusedField,
                    isRequired: false,
                    showsError: false,
                    fontSize: 17,
                    minHeight: 48,
                    cornerRadius: 20,
                    horizontalPadding: 14
                )
            }
        }

        HStack {
            Spacer()
            Text(ypPercentText ?? "")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.black.opacity(0.48))
        }
    }
}

private func batchOfferCalculatorSection<Focus: Hashable>(
    offerPriceText: Binding<String>,
    yourPriceText: Binding<String>,
    ypPercentText: String?,
    offerFocus: Focus,
    yourFocus: Focus,
    focusedField: FocusState<Focus?>.Binding
) -> some View {
    VStack(alignment: .leading, spacing: 14) {
        Text("Offer Calculator")
            .font(sellOrderSingleLabelFont)
            .foregroundStyle(Color.black.opacity(0.92))

        HStack(alignment: .top, spacing: 12) {
            batchLabeledInputField(
                title: "Offer Price",
                text: offerPriceText,
                focus: offerFocus,
                focusedField: focusedField
            )

            Text("/")
                .font(.body)
                .foregroundStyle(Color.black.opacity(0.38))
                .padding(.top, 12)

            batchLabeledInputField(
                title: "Your Price (YP)",
                text: yourPriceText,
                focus: yourFocus,
                focusedField: focusedField
            )
        }

        if let ypPercentText {
            Text(ypPercentText)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.black.opacity(0.48))
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
    .padding(.vertical, 18)
}

private func batchLabeledInputField<Focus: Hashable>(
    title: String,
    text: Binding<String>,
    focus: Focus,
    focusedField: FocusState<Focus?>.Binding
) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        Text(title)
            .font(.caption)
            .foregroundStyle(Color.black.opacity(0.42))

        sellOrderPriceField(
            text: text,
            placeholder: "00",
            width: nil,
            focus: focus,
            focusedField: focusedField,
            isRequired: false,
            showsError: false,
            fontSize: 17,
            minHeight: 48,
            cornerRadius: 20,
            horizontalPadding: 14
        )
    }
    .frame(maxWidth: .infinity)
}

private func sellOrderSinglePhotoRowLabel() -> some View {
    HStack(alignment: .center, spacing: 12) {
        Text("Photo (optional)")
            .font(sellOrderSingleLabelFont)
            .foregroundStyle(Color.black.opacity(0.92))

        Spacer(minLength: 12)

        Image(systemName: "camera")
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.black.opacity(0.6))
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 18)
    .contentShape(Rectangle())
}

private func sellOrderScreenshotCard<Content: View>(
    @ViewBuilder content: () -> Content
) -> some View {
    VStack(spacing: 0) {
        content()
    }
    .padding(.horizontal, 18)
    .padding(.top, 22)
    .padding(.bottom, 12)
    .background(Color.white.opacity(0.92))
    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    .overlay(
        RoundedRectangle(cornerRadius: 24, style: .continuous)
            .stroke(Color.white.opacity(0.55), lineWidth: 1)
    )
    .shadow(color: Color.black.opacity(0.1), radius: 24, x: 0, y: 14)
}

private func sellOrderScreenshotRow<Content: View>(
    title: String,
    @ViewBuilder content: () -> Content
) -> some View {
    HStack(alignment: .center, spacing: 14) {
        Text(title)
            .font(.system(size: 16, weight: .regular))
            .foregroundStyle(Color.black.opacity(0.9))

        Spacer(minLength: 10)

        content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 12)
}

private func sellOrderScreenshotDivider() -> some View {
    Rectangle()
        .fill(Color.black.opacity(0.08))
        .frame(height: 1)
}

private func sellOrderScreenshotTrailingValue(_ value: String) -> some View {
    Text(value)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(Color.black.opacity(0.92))
}

private func sellOrderScreenshotOfferCalculator<Focus: Hashable>(
    offerPriceText: Binding<String>,
    yourPriceText: Binding<String>,
    ypPercentText: String?,
    offerFocus: Focus,
    yourFocus: Focus,
    focusedField: FocusState<Focus?>.Binding
) -> some View {
    VStack(alignment: .leading, spacing: 12) {
        Text("Offer Calculator")
            .font(.system(size: 16, weight: .regular))
            .foregroundStyle(Color.black.opacity(0.92))

        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 12) {
                Text("Offer Price")
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Your Price (YP)")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Color(red: 0.68, green: 0.68, blue: 0.68))

            HStack(spacing: 12) {
                sellOrderPriceField(
                    text: offerPriceText,
                    placeholder: "00",
                    width: nil,
                    focus: offerFocus,
                    focusedField: focusedField,
                    isRequired: false,
                    showsError: false,
                    fontSize: 16,
                    minHeight: 34,
                    cornerRadius: 14,
                    horizontalPadding: 12
                )

                Text("/")
                    .font(.system(size: 30, weight: .regular))
                    .foregroundStyle(Color(red: 0.83, green: 0.83, blue: 0.83))

                sellOrderPriceField(
                    text: yourPriceText,
                    placeholder: "00",
                    width: nil,
                    focus: yourFocus,
                    focusedField: focusedField,
                    isRequired: false,
                    showsError: false,
                    fontSize: 16,
                    minHeight: 34,
                    cornerRadius: 14,
                    horizontalPadding: 12
                )
            }
        }

        Text(ypPercentText ?? " ")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Color(red: 0.56, green: 0.56, blue: 0.56))
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

private func sellOrderPriceField<Focus: Hashable>(
    text: Binding<String>,
    placeholder: String,
    width: CGFloat?,
    focus: Focus,
    focusedField: FocusState<Focus?>.Binding,
    isRequired: Bool,
    showsError: Bool,
    fontSize: CGFloat = 12,
    minHeight: CGFloat = 32,
    cornerRadius: CGFloat = 12,
    horizontalPadding: CGFloat = 8
) -> some View {
    TextField("", text: text, prompt: Text(placeholder).foregroundStyle(Color(red: 0.88, green: 0.88, blue: 0.88)))
        .keyboardType(.decimalPad)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .multilineTextAlignment(.center)
        .font(.system(size: fontSize, weight: .semibold, design: .rounded))
        .foregroundStyle(Color.black.opacity(0.92))
        .focused(focusedField, equals: focus)
        .padding(.horizontal, horizontalPadding)
        .frame(maxWidth: width == nil ? .infinity : width, minHeight: minHeight, maxHeight: minHeight)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .stroke(showsError ? Color.red.opacity(0.45) : Color(red: 0.93, green: 0.93, blue: 0.93), lineWidth: 1)
        )
}

private func sellOrderSwipeActionBar(
    title: String,
    progress: CGFloat,
    isDisabled: Bool,
) -> some View {
    ZStack {
        VStack(spacing: 10) {
            Image(systemName: "chevron.up")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Color.black.opacity(0.7))

            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.black.opacity(0.86))
        }
        .frame(maxWidth: .infinity)
        .frame(height: sellOrderSwipeRailHeight)
        .offset(y: 4)
        .opacity(isDisabled ? 0.42 : 1)
    }
    .overlay(alignment: .top) {
        Rectangle()
            .fill(Color.black.opacity(0.05))
            .frame(height: 1)
    }
    .opacity(max(0.16, 1 - (progress * 1.15)))
    .scaleEffect(max(0.9, 1 - (progress * 0.1)))
    .contentShape(Rectangle())
}

private func sellOrderInteractiveConfirmationSheet<ActionBar: View>(
    submitState: SellOrderSubmitState,
    processingHeadline: String,
    processingDetail: String,
    successHeadline: String,
    successDetail: String,
    @ViewBuilder actionBar: () -> ActionBar
) -> some View {
    ZStack(alignment: .top) {
        if submitState != .idle {
            SellOrderSwipeStatusContent(
                title: submitState == .success ? "Congrats!" : "Processing sale",
                headline: submitState == .success ? successHeadline : processingHeadline,
                detail: submitState == .success ? successDetail : processingDetail,
                showsProgress: submitState == .processing
            )
            .padding(.horizontal, 28)
            .padding(.top, 148)
            .padding(.bottom, 96)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .transition(.opacity.combined(with: .scale(scale: 0.96)))
        }

        VStack(spacing: 0) {
            actionBar()
            Spacer(minLength: 0)
        }
        .opacity(submitState == .idle ? 1 : 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(Color(red: 0.99, green: 0.90, blue: 0.28))
    .animation(.spring(response: 0.28, dampingFraction: 0.88), value: submitState)
}

private func sellOrderValidationBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
        Image(systemName: "exclamationmark.circle.fill")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(Color.red.opacity(0.72))

        Text(message)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Color.black.opacity(0.76))
            .fixedSize(horizontal: false, vertical: true)

        Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .background(Color.red.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
}

private func sellOrderInlineValidationMessage(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 8) {
        Image(systemName: "exclamationmark.circle.fill")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(Color.red.opacity(0.78))

        Text(message)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.black.opacity(0.72))
            .fixedSize(horizontal: false, vertical: true)

        Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(Color.red.opacity(0.07))
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
}

private func sellOrderAttachedPhotoPreview(_ image: UIImage) -> some View {
    Image(uiImage: image)
        .resizable()
        .scaledToFill()
        .frame(height: 112)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
}

private func sellOrderFormattedPrice(_ value: Double, currencyCode: String = "USD") -> String {
    value.formatted(
        .currency(code: currencyCode)
            .precision(.fractionLength(2))
    )
}

private func sellOrderFormattedPercent(_ value: Double) -> String {
    let rounded = (value * 100).rounded() / 100
    if abs(rounded.rounded() - rounded) < 0.005 {
        return String(format: "%.0f%%", rounded)
    }
    return String(format: "%.2f%%", rounded)
}

private func sellOrderEditableNumericText(_ value: Double) -> String {
    formattedEditableNumericText(value, maximumFractionDigits: 2)
}

private func sellOrderParsedPrice(from text: String) -> Double? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty,
          let value = Double(trimmed),
          value >= 0 else {
        return nil
    }
    return value
}

private func sellOrderSanitizedPriceText(_ text: String, maximumFractionDigits: Int = 2) -> String {
    let allowed = Set("0123456789.")
    var result = ""
    var hasDecimalSeparator = false
    var fractionDigits = 0

    for scalar in text.unicodeScalars {
        let character = Character(scalar)
        guard allowed.contains(character) else { continue }

        if character == "." {
            guard !hasDecimalSeparator else { continue }
            hasDecimalSeparator = true
            if result.isEmpty {
                result = "0."
            } else {
                result.append(character)
            }
            continue
        }

        if hasDecimalSeparator {
            guard fractionDigits < maximumFractionDigits else { continue }
            fractionDigits += 1
        }

        if result == "0", !hasDecimalSeparator {
            result = String(character)
        } else {
            result.append(character)
        }
    }

    return result
}

@MainActor
private func sellOrderDismissKeyboard() {
#if canImport(UIKit)
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
#endif
}

#if canImport(PhotosUI) && canImport(UIKit)
private func sellOrderLoadImage(from item: PhotosPickerItem?) async -> UIImage? {
    guard let item,
          let data = try? await item.loadTransferable(type: Data.self),
          let image = UIImage(data: data) else {
        return nil
    }
    return image
}
#endif
