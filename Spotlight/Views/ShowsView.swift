import Charts
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

private struct DashboardInventoryPoint: Identifiable {
    let id: String
    let date: Date
    let marketValue: Double
    let costBasisValue: Double?
}

private struct DashboardBusinessPoint: Identifiable {
    let id: String
    let date: Date
    let cumulativeRevenue: Double
    let cumulativeSpend: Double
    let cumulativeRealizedProfit: Double
}

struct DashboardOverviewPoint: Identifiable, Hashable {
    let id: String
    let date: Date
    let marketValue: Double?
    let costBasisValue: Double?
    let cumulativeRevenue: Double?
}

func dashboardOverviewPointHasVisibleValue(_ point: DashboardOverviewPoint) -> Bool {
    point.marketValue != nil || point.costBasisValue != nil || point.cumulativeRevenue != nil
}

func latestDisplayableOverviewPointIndex(in points: [DashboardOverviewPoint]) -> Int? {
    points.lastIndex(where: dashboardOverviewPointHasVisibleValue)
}

func resolvedOverviewSelectionIndex(
    selectedIndex: Int?,
    points: [DashboardOverviewPoint]
) -> Int? {
    guard !points.isEmpty else { return nil }

    if let selectedIndex,
       points.indices.contains(selectedIndex),
       dashboardOverviewPointHasVisibleValue(points[selectedIndex]) {
        return selectedIndex
    }

    return latestDisplayableOverviewPointIndex(in: points) ?? points.indices.last
}

enum SellOrderReviewUIState: Equatable {
    case edit(buttonTitle: String)
    case review(trayTitle: String)
}

private enum SwipeSellOverlayState: Equatable {
    case idle
    case processing
    case success
}

private let sellSubmissionMinimumProcessingDuration: TimeInterval = 2
private let sellSubmissionSuccessDisplayDuration: TimeInterval = 2

func sellOrderReviewUIState(isReviewingSale: Bool, isSubmitting: Bool) -> SellOrderReviewUIState {
    if isReviewingSale {
        return .review(trayTitle: isSubmitting ? "SELLING…" : "Swipe up to sell")
    }

    return .edit(buttonTitle: "Review sale")
}

private struct SwipeSellStatusContent: View {
    let title: String
    let headline: String
    let detail: String
    let showsProgress: Bool

    @Environment(\.lootyTheme) private var theme

    var body: some View {
        VStack(spacing: 20) {
            Group {
                if showsProgress {
                    ProgressView()
                        .tint(theme.colors.textInverse)
                        .scaleEffect(1.35)
                } else {
                    Image(systemName: "checkmark")
                        .font(.system(size: 32, weight: .bold))
                        .foregroundStyle(theme.colors.textInverse)
                }
            }
            .frame(height: 44)

            VStack(spacing: 10) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(theme.colors.textInverse.opacity(0.72))

                Text(headline)
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(theme.colors.textInverse)
                    .multilineTextAlignment(.center)

                Text(detail)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(theme.colors.textInverse.opacity(0.78))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: 320)
    }
}

@MainActor
private func dismissKeyboard() {
#if canImport(UIKit)
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
#endif
}

@MainActor
private func currentBottomSafeAreaInset() -> CGFloat {
#if canImport(UIKit)
    let scenes = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
    for scene in scenes {
        if let window = scene.windows.first(where: \.isKeyWindow) {
            return window.safeAreaInsets.bottom
        }
    }
#endif
    return 0
}

private func interactionUptimeString() -> String {
    String(format: "%.6f", ProcessInfo.processInfo.systemUptime)
}

private func textFieldInstanceID(_ textField: UITextField) -> String {
    String(describing: Unmanaged.passUnretained(textField).toOpaque())
}

private func scheduleMainThreadPing(label: String, context: String) {
    let scheduledAt = ProcessInfo.processInfo.systemUptime
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.05) {
        DispatchQueue.main.async {
            let executedAt = ProcessInfo.processInfo.systemUptime
            let delayMs = (executedAt - scheduledAt) * 1000
            let scheduledAtText = String(format: "%.6f", scheduledAt)
            let executedAtText = String(format: "%.6f", executedAt)
            let delayMsText = String(format: "%.1f", delayMs)
            print("⚫ MAIN THREAD PING \(label): scheduled=\(scheduledAtText) executed=\(executedAtText) delayMs=\(delayMsText) [\(context)]")
        }
    }
}

func formattedEditableNumericText(_ value: Double, maximumFractionDigits: Int = 2) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.minimumFractionDigits = 0
    formatter.maximumFractionDigits = maximumFractionDigits
    return formatter.string(from: NSNumber(value: value)) ?? String(value)
}

func clampedDiscountInputText(_ text: String, maximum: Double, maximumFractionDigits: Int = 2) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let value = Double(trimmed) else {
        return text
    }

    let clampedValue = min(max(0, value), max(0, maximum))
    guard abs(clampedValue - value) > 0.000_001 else {
        return text
    }

    return formattedEditableNumericText(clampedValue, maximumFractionDigits: maximumFractionDigits)
}

#if canImport(UIKit)
private struct UIKitDecimalTextField: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let alignment: NSTextAlignment
    let font: UIFont
    let textColor: UIColor
    let traceContext: String
    let onTapReceived: (() -> Void)?
    let onEditingBegan: (() -> Void)?
    let onEditingEnded: (() -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> TapLoggingTextField {
        let textField = TapLoggingTextField(frame: .zero)
        let fieldID = textFieldInstanceID(textField)
        textField.delegate = context.coordinator
        textField.keyboardType = .decimalPad
        textField.autocorrectionType = .no
        textField.spellCheckingType = .no
        textField.autocapitalizationType = .none
        textField.borderStyle = .none
        textField.backgroundColor = .clear
        textField.textAlignment = alignment
        textField.font = font
        textField.textColor = textColor
        textField.placeholder = placeholder
        textField.text = text
        textField.addTarget(context.coordinator, action: #selector(Coordinator.touchDown(_:)), for: .touchDown)
        textField.addTarget(context.coordinator, action: #selector(Coordinator.textDidChange(_:)), for: .editingChanged)
        textField.addTarget(context.coordinator, action: #selector(Coordinator.editingDidBegin(_:)), for: .editingDidBegin)
        textField.onTapReceived = {
            context.coordinator.parent.onTapReceived?()
        }
        textField.inputAccessoryView = context.coordinator.makeDoneAccessory()
        textField.traceContext = traceContext
        textField.instanceID = fieldID
        print("🔶 MAKE UI VIEW id=\(fieldID) text=\(text) placeholder=\(placeholder) [\(traceContext)]")
        return textField
    }

    func updateUIView(_ uiView: TapLoggingTextField, context: Context) {
        context.coordinator.parent = self
        let previousText = uiView.text ?? ""
        let previousPlaceholder = uiView.placeholder ?? ""
        if uiView.text != text {
            uiView.text = text
        }
        uiView.placeholder = placeholder
        uiView.textAlignment = alignment
        uiView.font = font
        uiView.textColor = textColor
        uiView.traceContext = traceContext
        uiView.instanceID = textFieldInstanceID(uiView)
        uiView.onTapReceived = {
            context.coordinator.parent.onTapReceived?()
        }
        print(
            "🔷 UPDATE UI VIEW id=\(uiView.instanceID) textChanged=\(previousText != text) " +
            "placeholderChanged=\(previousPlaceholder != placeholder) text=\(text) placeholder=\(placeholder) [\(traceContext)]"
        )
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: UIKitDecimalTextField
        weak var activeTextField: UITextField?

        init(parent: UIKitDecimalTextField) {
            self.parent = parent
        }

        func makeDoneAccessory() -> UIView {
            let accessory = KeyboardDoneAccessoryView(
                buttonColor: UIColor(LootyTheme.default.colors.success),
                backgroundColor: UIColor.systemBackground,
                actionTarget: self,
                action: #selector(doneButtonTapped)
            )
            return accessory
        }

        @objc func touchDown(_ textField: UITextField) {
            let context = (textField as? TapLoggingTextField)?.traceContext ?? parent.traceContext
            let fieldID = textFieldInstanceID(textField)
            print("⚪ TOUCH DOWN: uptime=\(interactionUptimeString()) id=\(fieldID) [\(context)]")
            scheduleMainThreadPing(label: "after-touchDown", context: context)
        }

        @objc func textDidChange(_ textField: UITextField) {
            parent.text = textField.text ?? ""
        }

        @objc func editingDidBegin(_ textField: UITextField) {
            let context = (textField as? TapLoggingTextField)?.traceContext ?? parent.traceContext
            let fieldID = textFieldInstanceID(textField)
            print("🟧 EDITING DID BEGIN CONTROL EVENT: uptime=\(interactionUptimeString()) id=\(fieldID) [\(context)]")
            parent.onEditingBegan?()
        }

        func textFieldShouldBeginEditing(_ textField: UITextField) -> Bool {
            let context = (textField as? TapLoggingTextField)?.traceContext ?? parent.traceContext
            let fieldID = textFieldInstanceID(textField)
            print("🟤 SHOULD BEGIN EDITING: uptime=\(interactionUptimeString()) id=\(fieldID) [\(context)]")
            scheduleMainThreadPing(label: "after-shouldBeginEditing", context: context)
            return true
        }

        func textFieldDidBeginEditing(_ textField: UITextField) {
            let context = (textField as? TapLoggingTextField)?.traceContext ?? parent.traceContext
            let fieldID = textFieldInstanceID(textField)
            activeTextField = textField
            print("🟪 DID BEGIN EDITING DELEGATE: uptime=\(interactionUptimeString()) id=\(fieldID) [\(context)]")
        }

        func textFieldDidEndEditing(_ textField: UITextField) {
            if activeTextField === textField {
                activeTextField = nil
            }
            parent.onEditingEnded?()
        }

        @objc private func doneButtonTapped() {
            activeTextField?.resignFirstResponder()
        }
    }

    final class TapLoggingTextField: UITextField {
        var traceContext: String = "UIKitDecimalTextField"
        var instanceID: String = "unknown"
        var onTapReceived: (() -> Void)?

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
            print("🟠 TOUCHES BEGAN: uptime=\(interactionUptimeString()) id=\(instanceID) [\(traceContext)]")
            scheduleMainThreadPing(label: "after-touchesBegan", context: traceContext)
            DispatchQueue.main.async {
                print("🟤 NEXT MAIN RUNLOOP AFTER TAP: uptime=\(interactionUptimeString()) id=\(self.instanceID) [\(self.traceContext)]")
            }
            onTapReceived?()
            super.touchesBegan(touches, with: event)
        }

        override func becomeFirstResponder() -> Bool {
            print("🟣 BECOME FIRST RESPONDER START: uptime=\(interactionUptimeString()) id=\(instanceID) [\(traceContext)]")
            scheduleMainThreadPing(label: "after-becomeFirstResponder-start", context: traceContext)
            let result = super.becomeFirstResponder()
            print("🟣 BECOME FIRST RESPONDER END result=\(result): uptime=\(interactionUptimeString()) id=\(instanceID) [\(traceContext)]")
            return result
        }

        deinit {
            print("🧹 DEINIT UI VIEW id=\(instanceID) [\(traceContext)]")
        }
    }

    final class KeyboardDoneAccessoryView: UIView {
        init(buttonColor: UIColor, backgroundColor: UIColor, actionTarget: Any?, action: Selector) {
            super.init(frame: CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: 52))
            self.backgroundColor = backgroundColor
            autoresizingMask = [.flexibleWidth, .flexibleHeight]

            let divider = UIView()
            divider.translatesAutoresizingMaskIntoConstraints = false
            divider.backgroundColor = UIColor.separator.withAlphaComponent(0.35)

            let button = UIButton(type: .system)
            button.translatesAutoresizingMaskIntoConstraints = false
            button.setTitle("Done", for: .normal)
            button.setTitleColor(buttonColor, for: .normal)
            button.tintColor = buttonColor
            button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
            button.addTarget(actionTarget, action: action, for: .touchUpInside)

            addSubview(divider)
            addSubview(button)

            NSLayoutConstraint.activate([
                divider.topAnchor.constraint(equalTo: topAnchor),
                divider.leadingAnchor.constraint(equalTo: leadingAnchor),
                divider.trailingAnchor.constraint(equalTo: trailingAnchor),
                divider.heightAnchor.constraint(equalToConstant: 1),

                button.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
                button.centerYAnchor.constraint(equalTo: centerYAnchor)
            ])
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override var intrinsicContentSize: CGSize {
            CGSize(width: UIView.noIntrinsicMetric, height: 52)
        }
    }
}
#endif

func visibleTransactionNote(_ transaction: PortfolioLedgerTransaction) -> String? {
    guard let note = transaction.note?.trimmingCharacters(in: .whitespacesAndNewlines),
          !note.isEmpty else {
        return nil
    }

    if note.lowercased().contains("purchase price") {
        return nil
    }

    return note
}

func dashboardHistoryPoints(_ history: PortfolioHistory?) -> [PortfolioHistoryPoint] {
    history?.points ?? []
}

struct LedgerTransactionPriceEditorSheet: View {
    let transaction: PortfolioLedgerTransaction
    let onSave: (Double) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme
    @State private var priceText: String
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var isPriceFieldFocused = false

    private var pageBackground: Color { theme.colors.pageLight }
    private var surfaceBackground: Color { theme.colors.surfaceLight }
    private var fieldBackground: Color { theme.colors.fieldLight }
    private var outline: Color { theme.colors.outlineLight }
    private var accent: Color { theme.colors.success }
    private var primaryText: Color { theme.colors.textInverse }
    private var secondaryText: Color { theme.colors.textSecondaryInverse }

    init(
        transaction: PortfolioLedgerTransaction,
        onSave: @escaping (Double) async throws -> Void
    ) {
        self.transaction = transaction
        self.onSave = onSave
        _priceText = State(initialValue: String(format: "%.2f", transaction.unitPrice ?? 0))
    }

    private var resolvedUnitPrice: Double {
        let normalized = priceText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Double(normalized), value >= 0 else {
            return 0
        }
        return value
    }

    private var sectionTitleText: String {
        transaction.kind == .sell ? "Update sell price" : "Update buy price"
    }

    var body: some View {
        NavigationStack {
            ZStack {
                pageBackground.ignoresSafeArea()

                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(transaction.card.name)
                            .font(.title3.weight(.bold))
                            .foregroundStyle(primaryText)

                        Text("Qty \(max(1, transaction.quantity))")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(secondaryText)
                    }
                    .padding(.horizontal, 2)

                    VStack(alignment: .leading, spacing: 12) {
                        Text(sectionTitleText)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(primaryText)

                        UIKitDecimalTextField(
                            text: $priceText,
                            placeholder: "0.00",
                            alignment: .left,
                            font: .systemFont(ofSize: 26, weight: .bold),
                            textColor: UIColor(primaryText),
                            traceContext: "LedgerTransactionPriceEditorSheet",
                            onTapReceived: {
                                print("🟡 TAP RECEIVED: \(Date()) [LedgerTransactionPriceEditorSheet]")
                            },
                            onEditingBegan: {
                                isPriceFieldFocused = true
                            },
                            onEditingEnded: {
                                isPriceFieldFocused = false
                            }
                        )
                        .padding(.horizontal, 16)
                        .frame(height: 58)
                        .background(fieldBackground)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(outline, lineWidth: 1)
                        )
                        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                        if let errorMessage {
                            Text(errorMessage)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(theme.colors.danger)
                        }
                    }
                    .padding(24)
                    .background(surfaceBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(outline, lineWidth: 1)
                    )

                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 20)
                .padding(.top, 40)
                .padding(.bottom, 24)
            }
            .toolbarBackground(pageBackground, for: .navigationBar)
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    Rectangle()
                        .fill(outline)
                        .frame(height: 1)

                    Button {
                        submit()
                    } label: {
                        Text(isSubmitting ? "SAVING…" : "Save price")
                    }
                    .buttonStyle(
                        LootyFilledButtonStyle(
                            fill: accent,
                            foreground: theme.colors.textInverse,
                            cornerRadius: 18,
                            minHeight: 56
                        )
                    )
                    .disabled(isSubmitting)
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 12)
                    .background(pageBackground)
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onChange(of: isPriceFieldFocused) { _, newValue in
            print("🟢 FOCUS STATE CHANGED to \(newValue): \(Date()) [LedgerTransactionPriceEditorSheet]")
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            print("🔵 KEYBOARD WILL SHOW: \(Date()) [LedgerTransactionPriceEditorSheet]")
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
            print("🔴 KEYBOARD DID SHOW: \(Date()) [LedgerTransactionPriceEditorSheet]")
        }
    }

    private func submit() {
        errorMessage = nil
        dismissKeyboard()
        isSubmitting = true

        Task {
            do {
                try await onSave(resolvedUnitPrice)
                await MainActor.run {
                    isSubmitting = false
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    isSubmitting = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}

struct DashboardView: View {
    @ObservedObject var collectionStore: CollectionStore
    let accountMonogram: String
    let onOpenPortfolio: () -> Void
    let onOpenScanner: () -> Void
    let onOpenAccount: () -> Void

    @Environment(\.lootyTheme) private var theme
    @State private var selectedOverviewIndex: Int?
    @State private var editingTransaction: PortfolioLedgerTransaction?

    private var inkBackground: Color { theme.colors.canvas }
    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var fieldBackground: Color { theme.colors.surface }
    private var limeAccent: Color { theme.colors.brand }
    private var tealAccent: Color { theme.colors.success }
    private var orangeAccent: Color { theme.colors.warning }
    private var outline: Color { theme.colors.outlineSubtle }

    private var ledger: PortfolioLedger? { collectionStore.portfolioLedger }
    private var history: PortfolioHistory? { collectionStore.portfolioHistory }
    private var summary: PortfolioLedgerSummary? { ledger?.summary }

    private var latestTransactions: [PortfolioLedgerTransaction] {
        (ledger?.transactions ?? [])
            .filter { $0.kind == .sell }
            .sorted { lhs, rhs in
                lhs.occurredAt > rhs.occurredAt
            }
    }

    private var dashboardInventoryPoints: [DashboardInventoryPoint] {
        dashboardHistoryPoints(history).compactMap { point in
            guard let date = dashboardDate(from: point.date) else { return nil }
            return DashboardInventoryPoint(
                id: point.date,
                date: date,
                marketValue: point.marketValue ?? point.totalValue,
                costBasisValue: point.costBasisValue
            )
        }
    }

    private var dashboardBusinessPoints: [DashboardBusinessPoint] {
        return portfolioCumulativeBusinessSeries(from: ledger?.dailySeries ?? [])
            .compactMap { point in
                guard let date = dashboardDate(from: point.date) else { return nil }
                return DashboardBusinessPoint(
                    id: point.date,
                    date: date,
                    cumulativeRevenue: point.cumulativeRevenue,
                    cumulativeSpend: point.cumulativeSpend,
                    cumulativeRealizedProfit: point.cumulativeRealizedProfit
                )
            }
    }

    private var dashboardOverviewPoints: [DashboardOverviewPoint] {
        var merged: [String: DashboardOverviewPoint] = [:]

        for point in dashboardInventoryPoints {
            let existing = merged[point.id]
            merged[point.id] = DashboardOverviewPoint(
                id: point.id,
                date: point.date,
                marketValue: point.marketValue,
                costBasisValue: point.costBasisValue,
                cumulativeRevenue: existing?.cumulativeRevenue
            )
        }

        for point in dashboardBusinessPoints {
            let existing = merged[point.id]
            merged[point.id] = DashboardOverviewPoint(
                id: point.id,
                date: point.date,
                marketValue: existing?.marketValue,
                costBasisValue: existing?.costBasisValue,
                cumulativeRevenue: point.cumulativeRevenue
            )
        }

        return merged.values.sorted { $0.date < $1.date }
    }

    private var resolvedSelectedOverviewIndex: Int? {
        resolvedOverviewSelectionIndex(
            selectedIndex: selectedOverviewIndex,
            points: dashboardOverviewPoints
        )
    }

    private var selectedOverviewPoint: DashboardOverviewPoint? {
        guard let resolvedSelectedOverviewIndex,
              dashboardOverviewPoints.indices.contains(resolvedSelectedOverviewIndex) else {
            return nil
        }
        return dashboardOverviewPoints[resolvedSelectedOverviewIndex]
    }

    private var displayedOverviewPoint: DashboardOverviewPoint? {
        selectedOverviewPoint
    }

    private var inventoryValue: Double {
        summary?.inventoryValue ?? portfolioCurrentMarketValue(from: history, fallbackValue: collectionStore.totalValue)
    }

    private var costBasisValue: Double {
        portfolioCurrentCostBasisValue(from: history, fallbackEntries: collectionStore.entries)
    }

    private var unrealizedProfit: Double { inventoryValue - costBasisValue }
    private var realizedProfit: Double { summary?.grossProfit ?? 0 }
    private var revenue: Double { summary?.revenue ?? 0 }
    private var spend: Double { summary?.spend ?? 0 }
    private var dashboardCurrencyCode: String { ledger?.currencyCode ?? history?.currencyCode ?? "USD" }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                inkBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 22) {
                        header
                        summarySection
                        chartSection
                        transactionsSection
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 18)
                    .padding(.bottom, 104 + max(proxy.safeAreaInsets.bottom, 0))
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                AppShellBottomBar(
                    selectedTab: .ledger,
                    onOpenPortfolio: onOpenPortfolio,
                    onOpenScanner: onOpenScanner,
                    onOpenLedger: {}
                )
            }
            .refreshable {
                await refreshDashboardData(range: collectionStore.selectedPortfolioLedgerRange)
            }
            .task {
                if collectionStore.portfolioLedger == nil || collectionStore.portfolioHistory == nil {
                    await refreshDashboardData(range: collectionStore.selectedPortfolioLedgerRange)
                }
            }
            .sheet(item: $editingTransaction) { transaction in
                LedgerTransactionPriceEditorSheet(transaction: transaction) { updatedUnitPrice in
                    switch transaction.kind {
                    case .buy:
                        try await collectionStore.updatePortfolioBuyTransactionPrice(
                            transactionID: transaction.id,
                            unitPrice: updatedUnitPrice,
                            currencyCode: transaction.currencyCode
                        )
                    case .sell:
                        try await collectionStore.updatePortfolioSaleTransactionPrice(
                            transactionID: transaction.id,
                            unitPrice: updatedUnitPrice,
                            currencyCode: transaction.currencyCode
                        )
                    }
                }
            }
        }
    }

    private func refreshDashboardData(range: PortfolioHistoryRange) async {
        await collectionStore.refreshPortfolioHistory(range: range)
        await collectionStore.refreshPortfolioLedger(range: range)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: theme.spacing.md) {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Dashboard")
                        .font(theme.typography.display)
                        .foregroundStyle(theme.colors.textPrimary)

                    Text("Track inventory value, spend, revenue, and realized profit over time.")
                        .font(.subheadline)
                        .foregroundStyle(theme.colors.textSecondary)
                }
            }

            Spacer(minLength: theme.spacing.md)

            Button(action: onOpenAccount) {
                Circle()
                    .fill(theme.colors.brand)
                    .frame(width: 38, height: 38)
                    .overlay(
                        Text(accountMonogram)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(theme.colors.textInverse)
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open account")
        }
    }

    private var rangePicker: some View {
        HStack(spacing: 8) {
            ForEach(PortfolioHistoryRange.allCases) { option in
                Button {
                    Task {
                        await refreshDashboardData(range: option)
                    }
                } label: {
                    Text(option.displayLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(collectionStore.selectedPortfolioLedgerRange == option ? theme.colors.textInverse : theme.colors.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity)
                        .background(collectionStore.selectedPortfolioLedgerRange == option ? limeAccent : fieldBackground)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(5)
        .background(theme.colors.surfaceMuted)
        .clipShape(Capsule())
    }

    private var summarySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Summary")
                .font(.headline.weight(.bold))
                .foregroundStyle(theme.colors.textPrimary)

            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                dashboardMetricCard("Inventory Value", value: formattedCurrency(inventoryValue, currencyCode: ledger?.currencyCode ?? "USD"), subtitle: "Current mark-to-market", accent: limeAccent)
                dashboardMetricCard("Cost Basis", value: formattedCurrency(costBasisValue, currencyCode: ledger?.currencyCode ?? "USD"), subtitle: "Buy-in cost basis", accent: orangeAccent)
                dashboardMetricCard("Unrealized P&L", value: formattedSignedCurrency(unrealizedProfit, currencyCode: ledger?.currencyCode ?? "USD"), subtitle: "Inventory value minus cost", accent: unrealizedProfit >= 0 ? tealAccent : theme.colors.danger)
                dashboardMetricCard("Realized Profit", value: formattedSignedCurrency(realizedProfit, currencyCode: ledger?.currencyCode ?? "USD"), subtitle: "Closed trades", accent: realizedProfit >= 0 ? tealAccent : theme.colors.danger)
                dashboardMetricCard("Revenue", value: formattedCurrency(revenue, currencyCode: ledger?.currencyCode ?? "USD"), subtitle: "Sell-side gross", accent: tealAccent)
                dashboardMetricCard("Spend", value: formattedCurrency(spend, currencyCode: ledger?.currencyCode ?? "USD"), subtitle: "Inventory cost", accent: orangeAccent)
            }
        }
    }

    private var chartSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Overview")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(theme.colors.textPrimary)
                    Text(selectedOverviewDateLabel)
                        .font(.subheadline)
                        .foregroundStyle(theme.colors.textSecondary)
                }

                Spacer()

                if collectionStore.isLoadingPortfolioLedger || collectionStore.isLoadingPortfolioHistory {
                    ProgressView()
                        .tint(theme.colors.textSecondary)
                }
            }

            rangePicker

            VStack(alignment: .leading, spacing: 12) {
                overviewLegend
                overviewChart
                    .frame(height: 232)
            }
            .padding(16)
            .background(surfaceBackground)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(outline, lineWidth: 1)
            )
        }
    }

    private var selectedOverviewDateLabel: String {
        if let date = displayedOverviewPoint?.date {
            return date.formatted(date: .abbreviated, time: .omitted)
        }
        if collectionStore.isLoadingPortfolioLedger || collectionStore.isLoadingPortfolioHistory {
            return "Loading overview"
        }
        return "Latest available"
    }

    private var overviewLegend: some View {
        ViewThatFits {
            HStack(spacing: 8) {
                overviewLegendChip(
                    title: "Inventory",
                    value: overviewLegendValue(displayedOverviewPoint?.marketValue, fallback: inventoryValue),
                    accent: limeAccent
                )
                overviewLegendChip(
                    title: "Cost Basis",
                    value: overviewLegendValue(displayedOverviewPoint?.costBasisValue, fallback: costBasisValue),
                    accent: orangeAccent
                )
                overviewLegendChip(
                    title: "Revenue",
                    value: overviewLegendValue(displayedOverviewPoint?.cumulativeRevenue, fallback: revenue),
                    accent: tealAccent
                )
            }
            VStack(spacing: 8) {
                overviewLegendChip(
                    title: "Inventory",
                    value: overviewLegendValue(displayedOverviewPoint?.marketValue, fallback: inventoryValue),
                    accent: limeAccent
                )
                overviewLegendChip(
                    title: "Cost Basis",
                    value: overviewLegendValue(displayedOverviewPoint?.costBasisValue, fallback: costBasisValue),
                    accent: orangeAccent
                )
                overviewLegendChip(
                    title: "Revenue",
                    value: overviewLegendValue(displayedOverviewPoint?.cumulativeRevenue, fallback: revenue),
                    accent: tealAccent
                )
            }
        }
    }

    @ViewBuilder
    private var overviewChart: some View {
        if dashboardOverviewPoints.isEmpty {
            emptyChartState(title: "No dashboard history yet", subtitle: "Run a sync and record buys or sales to populate the overview.")
        } else {
            Chart {
                ForEach(dashboardOverviewPoints) { point in
                    if let marketValue = point.marketValue {
                        LineMark(
                            x: .value("Date", point.date),
                            y: .value("Value", marketValue),
                            series: .value("Series", "Inventory")
                        )
                        .foregroundStyle(limeAccent)
                        .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                        .interpolationMethod(.linear)
                    }

                    if let costBasisValue = point.costBasisValue {
                        LineMark(
                            x: .value("Date", point.date),
                            y: .value("Value", costBasisValue),
                            series: .value("Series", "Cost Basis")
                        )
                        .foregroundStyle(orangeAccent)
                        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .interpolationMethod(.linear)
                    }

                    if let cumulativeRevenue = point.cumulativeRevenue {
                        LineMark(
                            x: .value("Date", point.date),
                            y: .value("Value", cumulativeRevenue),
                            series: .value("Series", "Revenue")
                        )
                        .foregroundStyle(tealAccent)
                        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .interpolationMethod(.linear)
                    }
                }

                if let selectedOverviewPoint {
                    RuleMark(x: .value("Date", selectedOverviewPoint.date))
                        .foregroundStyle(.white.opacity(0.18))

                    if let marketValue = selectedOverviewPoint.marketValue {
                        PointMark(
                            x: .value("Date", selectedOverviewPoint.date),
                            y: .value("Value", marketValue)
                        )
                        .foregroundStyle(limeAccent)
                        .symbolSize(52)
                    }

                    if let costBasisValue = selectedOverviewPoint.costBasisValue {
                        PointMark(
                            x: .value("Date", selectedOverviewPoint.date),
                            y: .value("Value", costBasisValue)
                        )
                        .foregroundStyle(orangeAccent)
                        .symbolSize(44)
                    }

                    if let cumulativeRevenue = selectedOverviewPoint.cumulativeRevenue {
                        PointMark(
                            x: .value("Date", selectedOverviewPoint.date),
                            y: .value("Value", cumulativeRevenue)
                        )
                        .foregroundStyle(tealAccent)
                        .symbolSize(44)
                    }
                }
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .day, count: max(1, dashboardOverviewPoints.count / 4))) { value in
                    AxisTick(stroke: StrokeStyle(lineWidth: 0))
                    AxisValueLabel()
                        .foregroundStyle(.white.opacity(0.48))
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) {
                    AxisValueLabel()
                        .foregroundStyle(.white.opacity(0.55))
                    AxisGridLine().foregroundStyle(.white.opacity(0.06))
                }
            }
            .chartPlotStyle { plotArea in
                plotArea.background(Color.clear)
            }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle()
                        .fill(.clear)
                        .contentShape(Rectangle())
                        .simultaneousGesture(
                            DragGesture(minimumDistance: 12)
                                .onChanged { value in
                                    guard chartDragShouldScrub(translation: value.translation) else { return }
                                    updateOverviewSelection(at: value.location, proxy: proxy, geometry: geometry)
                                }
                                .onEnded { value in
                                    guard chartDragShouldScrub(translation: value.translation) else { return }
                                    updateOverviewSelection(at: value.location, proxy: proxy, geometry: geometry)
                                }
                        )
                        .simultaneousGesture(
                            SpatialTapGesture()
                                .onEnded { value in
                                    updateOverviewSelection(at: value.location, proxy: proxy, geometry: geometry)
                                }
                        )
                }
            }
            .onChange(of: dashboardOverviewPoints, initial: false) { _, _ in
                selectedOverviewIndex = latestDisplayableOverviewPointIndex(in: dashboardOverviewPoints)
            }
            .onChange(of: collectionStore.selectedPortfolioLedgerRange, initial: false) {
                selectedOverviewIndex = latestDisplayableOverviewPointIndex(in: dashboardOverviewPoints)
            }
        }
    }

    private func emptyChartState(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline.weight(.semibold))
                .foregroundStyle(.white)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.62))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func overviewLegendChip(title: String, value: String, accent: Color) -> some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 999, style: .continuous)
                .fill(accent)
                .frame(width: 14, height: 3)

            VStack(alignment: .leading, spacing: 2) {
                Text(title.uppercased())
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .tracking(0.5)
                    .foregroundStyle(.white.opacity(0.46))
                Text(value)
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(fieldBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private func overviewLegendValue(_ value: Double?, fallback: Double?) -> String {
        if let value {
            return formattedCurrency(value, currencyCode: dashboardCurrencyCode)
        }
        if let fallback {
            return formattedCurrency(fallback, currencyCode: dashboardCurrencyCode)
        }
        return "—"
    }

    private func updateOverviewSelection(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) {
        guard !dashboardOverviewPoints.isEmpty else { return }
        guard let plotFrame = proxy.plotFrame else { return }
        let resolvedPlotFrame = geometry[plotFrame]
        let relativeX = location.x - resolvedPlotFrame.origin.x
        let clampedX = min(max(relativeX, 0), resolvedPlotFrame.size.width)
        guard let selectedDate: Date = proxy.value(atX: clampedX) else { return }
        selectedOverviewIndex = nearestOverviewIndex(for: selectedDate)
    }

    private func nearestOverviewIndex(for date: Date) -> Int {
        guard !dashboardOverviewPoints.isEmpty else { return 0 }

        var nearestIndex = 0
        var nearestDistance = abs(dashboardOverviewPoints[0].date.timeIntervalSince(date))

        for (index, point) in dashboardOverviewPoints.enumerated().dropFirst() {
            let distance = abs(point.date.timeIntervalSince(date))
            if distance < nearestDistance {
                nearestDistance = distance
                nearestIndex = index
            }
        }

        return nearestIndex
    }

    private var transactionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Latest sales")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(theme.colors.textPrimary)
                Spacer()
                if collectionStore.isLoadingPortfolioLedger {
                    ProgressView()
                        .tint(theme.colors.textSecondary)
                }
            }

            if !latestTransactions.isEmpty {
                VStack(spacing: 10) {
                    ForEach(latestTransactions) { transaction in
                        transactionCard(transaction)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No sales yet")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(theme.colors.textPrimary)
                    Text("Completed sales will appear here as soon as you start moving inventory.")
                        .font(.subheadline)
                        .foregroundStyle(theme.colors.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(surfaceBackground)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(outline, lineWidth: 1)
                )
            }
        }
    }

    private func dashboardMetricCard(_ title: String, value: String, subtitle: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .tracking(0.8)
                .foregroundStyle(theme.colors.textSecondary)
            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(theme.colors.textPrimary)
            Text(subtitle)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.white.opacity(0.56))
            RoundedRectangle(cornerRadius: 999, style: .continuous)
                .fill(accent.opacity(0.9))
                .frame(width: 36, height: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private func transactionCard(_ transaction: PortfolioLedgerTransaction) -> some View {
        HStack(alignment: .top, spacing: 12) {
            CardArtworkView(
                urlString: transaction.card.imageSmallURL ?? transaction.card.imageLargeURL,
                fallbackTitle: transaction.card.name,
                cornerRadius: 12,
                contentMode: .fit
            )
            .frame(width: 72, height: 96)
            .background(Color.white.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: 6) {
                if let grader = transaction.slabContext?.grader,
                   let grade = transaction.slabContext?.grade {
                    Text("\(grader) \(grade)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(theme.colors.textSecondary)
                }

                Text(transaction.card.name)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(theme.colors.textPrimary)

                Text("#\(transaction.card.number) • \(transaction.card.setName)")
                    .font(.caption)
                    .foregroundStyle(theme.colors.textSecondary)

                if let note = visibleTransactionNote(transaction) {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(theme.colors.textSecondary)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 0)

            VStack(alignment: .trailing, spacing: 6) {
                Text(formattedCurrency(transaction.totalPrice, currencyCode: transaction.currencyCode))
                    .font(.headline.weight(.bold))
                    .foregroundStyle(transaction.kind == .sell ? limeAccent : theme.colors.textPrimary)

                if let profitLabel = transactionProfitLabel(transaction) {
                    Text(profitLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(transactionProfitColor(transaction))
                }

                Text(formattedOccurredAt(transaction.occurredAt))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(theme.colors.textSecondary)
                    .multilineTextAlignment(.trailing)

                Image(systemName: "pencil")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white.opacity(0.44))
            }
        }
        .padding(14)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .onTapGesture {
            editingTransaction = transaction
        }
    }

    private func transactionProfitLabel(_ transaction: PortfolioLedgerTransaction) -> String? {
        guard transaction.kind == .sell else {
            return nil
        }

        guard let grossProfit = transaction.grossProfit else {
            return nil
        }

        if let costBasisTotal = transaction.costBasisTotal, costBasisTotal > 0 {
            return "Profit \(formattedCurrency(grossProfit, currencyCode: transaction.currencyCode))"
        }

        return "Buy price \(formattedCurrency(0, currencyCode: transaction.currencyCode))"
    }

    private func transactionProfitColor(_ transaction: PortfolioLedgerTransaction) -> Color {
        guard let costBasisTotal = transaction.costBasisTotal,
              costBasisTotal > 0,
              let grossProfit = transaction.grossProfit else {
            return theme.colors.textSecondary
        }

        return grossProfit >= 0 ? tealAccent : theme.colors.danger
    }

    private func dashboardDate(from dayString: String) -> Date? {
        let pieces = dayString.split(separator: "-")
        guard pieces.count == 3,
              let year = Int(pieces[0]),
              let month = Int(pieces[1]),
              let day = Int(pieces[2]) else {
            return nil
        }
        return Calendar(identifier: .gregorian).date(from: DateComponents(year: year, month: month, day: day, hour: 12))
    }

    private func formattedOccurredAt(_ occurredAt: Date) -> String {
        occurredAt.formatted(date: .abbreviated, time: .shortened)
    }

    private func formattedCurrency(_ value: Double, currencyCode: String) -> String {
        value.formatted(.currency(code: currencyCode).precision(.fractionLength(2)))
    }

    private func formattedSignedCurrency(_ value: Double, currencyCode: String) -> String {
        let magnitude = formattedCurrency(abs(value), currencyCode: currencyCode)
        return value < 0 ? "-\(magnitude)" : "+\(magnitude)"
    }
}

struct LedgerView: View {
    @ObservedObject var collectionStore: CollectionStore
    let onOpenPortfolio: () -> Void
    let onOpenScanner: () -> Void

    @Environment(\.lootyTheme) private var theme

    private var inkBackground: Color { theme.colors.canvas }
    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var fieldBackground: Color { theme.colors.surface }
    private var limeAccent: Color { theme.colors.brand }
    private var outline: Color { theme.colors.outlineSubtle }
    private var revenueAccent: Color { theme.colors.success }
    private var spendAccent: Color { theme.colors.warning }
    private var profitAccent: Color { theme.colors.info }
    private var costBasisAccent: Color { theme.colors.textSecondary }

    @State private var selectedChartMode: PortfolioDashboardChartMode = .inventory

    private var ledger: PortfolioLedger? {
        collectionStore.portfolioLedger
    }

    private var summary: PortfolioLedgerSummary? {
        ledger?.summary
    }

    private var latestTransactions: [PortfolioLedgerTransaction] {
        (ledger?.transactions ?? [])
            .filter { $0.kind == .sell }
            .sorted { lhs, rhs in
                lhs.occurredAt > rhs.occurredAt
            }
    }

    private var currencyCode: String {
        ledger?.currencyCode
            ?? collectionStore.portfolioHistory?.currencyCode
            ?? "USD"
    }

    private var currentInventoryValue: Double {
        collectionStore.portfolioHistory?.summary.currentValue
            ?? ledger?.summary.inventoryValue
            ?? collectionStore.totalValue
    }

    private var currentCostBasisValue: Double {
        collectionStore.portfolioHistory?.summary.currentCostBasisValue
            ?? collectionStore.totalCostBasis
    }

    private var unrealizedProfit: Double {
        currentInventoryValue - currentCostBasisValue
    }

    private var realizedProfit: Double {
        ledger?.summary.grossProfit ?? 0
    }

    private var revenue: Double {
        ledger?.summary.revenue ?? 0
    }

    private var spend: Double {
        ledger?.summary.spend ?? 0
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                inkBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 22) {
                        header
                        summarySection
                        transactionsSection
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 18)
                    .padding(.bottom, 104 + max(proxy.safeAreaInsets.bottom, 0))
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                AppShellBottomBar(
                    selectedTab: .ledger,
                    onOpenPortfolio: onOpenPortfolio,
                    onOpenScanner: onOpenScanner,
                    onOpenLedger: {}
                )
            }
            .refreshable {
                await collectionStore.refreshFromBackend()
                await collectionStore.refreshPortfolioHistory()
                await collectionStore.refreshPortfolioLedger()
            }
            .task {
                if collectionStore.portfolioHistory == nil || collectionStore.portfolioLedger == nil {
                    await collectionStore.refreshPortfolioHistory()
                    await collectionStore.refreshPortfolioLedger()
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Dashboard")
                .font(theme.typography.display)
                .foregroundStyle(theme.colors.textPrimary)

            Text("Analytics for inventory value, trading performance, and day-to-day activity.")
                .font(.subheadline)
                .foregroundStyle(theme.colors.textSecondary)
        }
    }

    private var summarySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Summary")
                .font(.headline.weight(.bold))
                .foregroundStyle(theme.colors.textPrimary)

            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                ledgerMetricCard("Revenue", value: formattedCurrency(summary?.revenue ?? 0, currencyCode: ledger?.currencyCode ?? "USD"), accent: revenueAccent)
                ledgerMetricCard("Spend", value: formattedCurrency(summary?.spend ?? 0, currencyCode: ledger?.currencyCode ?? "USD"), accent: spendAccent)
                ledgerMetricCard("Gross Profit", value: formattedCurrency(summary?.grossProfit ?? 0, currencyCode: ledger?.currencyCode ?? "USD"), accent: limeAccent)
                ledgerMetricCard("Inventory Value", value: formattedCurrency(summary?.inventoryValue ?? collectionStore.totalValue, currencyCode: ledger?.currencyCode ?? "USD"), accent: theme.colors.textPrimary)
            }

            activitySummaryStrip
        }
    }

    private var activitySummaryStrip: some View {
        HStack(spacing: 12) {
            Label(activitySummaryText, systemImage: "calendar.badge.clock")
                .font(.caption.weight(.semibold))
                .foregroundStyle(theme.colors.textSecondary)

            Spacer(minLength: 0)

            Label(inventorySummaryText, systemImage: "square.stack.3d.up.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(theme.colors.textSecondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(fieldBackground)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private var analyticsSection: some View {
        EmptyView()
    }

    private var rangePicker: some View {
        HStack(spacing: 8) {
            ForEach(PortfolioHistoryRange.allCases) { option in
                Button {
                    Task {
                        await collectionStore.refreshPortfolioLedger(range: option)
                    }
                } label: {
                    Text(option.displayLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(collectionStore.selectedPortfolioLedgerRange == option ? theme.colors.textInverse : theme.colors.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity)
                        .background(collectionStore.selectedPortfolioLedgerRange == option ? limeAccent : fieldBackground)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(5)
        .background(theme.colors.surfaceMuted)
        .clipShape(Capsule())
    }

    private var activitySummaryText: String {
        let count = ledger?.count ?? 0
        switch count {
        case 0:
            return "No activity in range"
        case 1:
            return "1 transaction in range"
        default:
            return "\(count) transactions in range"
        }
    }

    private var inventorySummaryText: String {
        let count = summary?.inventoryCount ?? collectionStore.totalCardCount
        switch count {
        case 1:
            return "1 card in inventory"
        default:
            return "\(count) cards in inventory"
        }
    }

    private var transactionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Latest sales")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)
                Spacer()
                if collectionStore.isLoadingPortfolioLedger {
                    ProgressView()
                        .tint(.white.opacity(0.72))
                }
            }

            rangePicker

            if !latestTransactions.isEmpty {
                VStack(spacing: 10) {
                    ForEach(latestTransactions) { transaction in
                        transactionCard(transaction)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No sales yet")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(.white)
                    Text("Completed sales will appear here as soon as you start moving inventory.")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.62))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(surfaceBackground)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(outline, lineWidth: 1)
                )
            }
        }
    }

    private func ledgerMetricCard(_ title: String, value: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .tracking(0.8)
                .foregroundStyle(.white.opacity(0.5))
            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            RoundedRectangle(cornerRadius: 999, style: .continuous)
                .fill(accent.opacity(0.9))
                .frame(width: 36, height: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private func transactionCard(_ transaction: PortfolioLedgerTransaction) -> some View {
        HStack(alignment: .top, spacing: 12) {
            CardArtworkView(
                urlString: transaction.card.imageSmallURL ?? transaction.card.imageLargeURL,
                fallbackTitle: transaction.card.name,
                cornerRadius: 12,
                contentMode: .fit
            )
            .frame(width: 72, height: 96)
            .background(Color.white.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: 6) {
                if let grader = transaction.slabContext?.grader,
                   let grade = transaction.slabContext?.grade {
                    Text("\(grader) \(grade)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white.opacity(0.68))
                }

                Text(transaction.card.name)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)

                Text("#\(transaction.card.number) • \(transaction.card.setName)")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.58))

                if let note = visibleTransactionNote(transaction) {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.52))
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 0)

            VStack(alignment: .trailing, spacing: 6) {
                Text(formattedCurrency(transaction.totalPrice, currencyCode: transaction.currencyCode))
                    .font(.headline.weight(.bold))
                    .foregroundStyle(transaction.kind == .sell ? limeAccent : .white)

                if let profitLabel = transactionProfitLabel(transaction) {
                    Text(profitLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(transactionProfitColor(transaction))
                }

                Text(formattedOccurredAt(transaction.occurredAt))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.white.opacity(0.52))
                    .multilineTextAlignment(.trailing)
            }
        }
        .padding(14)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private func transactionProfitLabel(_ transaction: PortfolioLedgerTransaction) -> String? {
        guard transaction.kind == .sell else {
            return nil
        }

        guard let grossProfit = transaction.grossProfit else {
            return nil
        }

        if let costBasisTotal = transaction.costBasisTotal, costBasisTotal > 0 {
            return "Profit \(formattedCurrency(grossProfit, currencyCode: transaction.currencyCode))"
        }

        return "Buy price \(formattedCurrency(0, currencyCode: transaction.currencyCode))"
    }

    private func transactionProfitColor(_ transaction: PortfolioLedgerTransaction) -> Color {
        guard let costBasisTotal = transaction.costBasisTotal,
              costBasisTotal > 0,
              let grossProfit = transaction.grossProfit else {
            return theme.colors.textSecondary
        }

        return grossProfit >= 0 ? revenueAccent : theme.colors.danger
    }

    private func formattedOccurredAt(_ occurredAt: Date) -> String {
        occurredAt.formatted(date: .abbreviated, time: .shortened)
    }

    private func formattedCurrency(_ value: Double, currencyCode: String) -> String {
        value.formatted(.currency(code: currencyCode).precision(.fractionLength(2)))
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
        presentedFlow = .sell(
            ShowSellDraft(
                title: title,
                subtitle: subtitle,
                entry: entry,
                suggestedPrice: entry.primaryPrice ?? 0,
                quantityLimit: quantityLimit ?? max(1, entry.quantity)
            )
        )
    }

    func presentSellBatch(
        lines: [ShowSellBatchLineDraft],
        title: String,
        subtitle: String? = nil
    ) {
        guard !lines.isEmpty else { return }
        presentedFlow = .sellBatch(
            ShowSellBatchDraft(
                title: title,
                subtitle: subtitle,
                lines: lines
            )
        )
    }

    func presentBuy(
        entry: DeckCardEntry,
        title: String,
        subtitle: String? = nil,
        quantityDefault: Int = 1,
        availableVariants: [MarketHistoryOption] = [],
        selectedVariant: String? = nil
    ) {
        presentedFlow = .buy(
            ShowBuyDraft(
                title: title,
                subtitle: subtitle,
                entry: entry,
                suggestedPrice: entry.costBasisPerUnit ?? entry.primaryPrice ?? 0,
                quantityDefault: max(1, quantityDefault),
                availableVariants: availableVariants,
                selectedVariant: selectedVariant
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
    let suggestedPrice: Double
    let quantityLimit: Int
}

struct ShowSellBatchLineDraft: Identifiable, Hashable {
    let id: String
    let entry: DeckCardEntry
    let sourceItemIDs: [UUID]
    let scannedCount: Int
    let quantityLimit: Int
    let suggestedUnitPrice: Double
}

struct ShowSellBatchDraft: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String?
    let lines: [ShowSellBatchLineDraft]
}

struct ShowBuyDraft: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String?
    let entry: DeckCardEntry
    let suggestedPrice: Double
    let quantityDefault: Int
    let availableVariants: [MarketHistoryOption]
    let selectedVariant: String?
}

struct ShowTradeDraft: Identifiable {
    let id = UUID()
    let show: ShowSessionMock
    let previewEntry: DeckCardEntry
}

struct ShowSellSubmission {
    let quantity: Int
    let unitPrice: Double
    let paymentMethod: String?
    let note: String?
}

struct ShowSellBatchLineSubmission: Hashable {
    let id: String
    let entry: DeckCardEntry
    let quantity: Int
    let unitPrice: Double
    let sourceItemIDs: [UUID]
}

struct ShowSellBatchSubmission {
    let lines: [ShowSellBatchLineSubmission]
    let paymentMethod: String?
    let note: String?
}

struct ShowBuySubmission {
    let quantity: Int
    let unitPrice: Double
    let paymentMethod: String?
    let note: String?
    let condition: DeckCardCondition?
    let slabContext: SlabContext?
    let selectedVariant: String?
}

enum ShowsPresentedFlow: Identifiable {
    case sell(ShowSellDraft)
    case sellBatch(ShowSellBatchDraft)
    case buy(ShowBuyDraft)
    case trade(ShowTradeDraft)

    var id: String {
        switch self {
        case .sell(let draft):
            return "sell-\(draft.id.uuidString)"
        case .sellBatch(let draft):
            return "sell-batch-\(draft.id.uuidString)"
        case .buy(let draft):
            return "buy-\(draft.id.uuidString)"
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
            return LootyTheme.default.colors.success
        case .buy:
            return LootyTheme.default.colors.warning
        case .trade:
            return LootyTheme.default.colors.info
        case .expense:
            return LootyTheme.default.colors.danger
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

    @Environment(\.lootyTheme) private var theme

    private var inkBackground: Color { theme.colors.canvas }
    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var fieldBackground: Color { theme.colors.surface }
    private var limeAccent: Color { theme.colors.brand }
    private var outline: Color { theme.colors.outlineSubtle }

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
            costBasisTotal: 108,
            costBasisCurrencyCode: "USD",
            addedAt: Date()
        )
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                inkBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 22) {
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
                    selectedTab: .ledger,
                    onOpenPortfolio: onOpenPortfolio,
                    onOpenScanner: onOpenScanner,
                    onOpenLedger: {}
                )
            }
        }
    }

    private var showsHeader: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Shows")
                    .font(theme.typography.display)
                    .foregroundStyle(theme.colors.textPrimary)

                Text("Run your show session from one place: sell fast, keep the ledger tight, and track every deal.")
                    .font(.subheadline)
                    .foregroundStyle(theme.colors.textSecondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 8) {
                Text("EARLY")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(theme.colors.textInverse)
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
                .foregroundStyle(theme.colors.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(fieldBackground)
                .clipShape(Capsule())
            }
        }
    }

    private func activeShowCard(_ show: ShowSessionMock) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("ACTIVE SESSION")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(theme.colors.textInverse)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(limeAccent)
                        .clipShape(Capsule())

                    Text(show.title)
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                        .foregroundStyle(theme.colors.textPrimary)

                    Text("\(show.location) • \(show.dateLabel)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(theme.colors.textSecondary)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 6) {
                    Text(formattedPrice(show.grossSales))
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundStyle(theme.colors.textPrimary)
                    Text("gross sales")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(theme.colors.textSecondary)
                }
            }

            HStack(spacing: 10) {
                showChip(show.boothLabel ?? "Show floor", icon: "mappin.and.ellipse")
                showChip("Portfolio linked", icon: "square.stack.3d.up.fill")
                showChip("Deals auto-tagged", icon: "checkmark.seal.fill")
            }

            HStack(spacing: 12) {
                showMetric(value: formattedPrice(show.netCash), label: "Net cash")
                showMetric(value: "\(show.cardsSold)", label: "Cards sold")
                showMetric(value: "\(show.cardsBought + show.tradeCount)", label: "Other moves")
            }

            Text("Every sale from Portfolio or the scan tray can attach to this session so your show ledger stays clean.")
                .font(.footnote)
                .foregroundStyle(theme.colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            theme.colors.canvasElevated,
                            theme.colors.canvas
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(limeAccent.opacity(0.34), lineWidth: 1)
        )
    }

    private func showChip(_ title: String, icon: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
            Text(title)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(theme.colors.textPrimary)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(theme.colors.surfaceMuted)
        .clipShape(Capsule())
    }

    private func showMetrics(_ show: ShowSessionMock) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .lastTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Today's pace")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(theme.colors.textSecondary)
                    Text(formattedPrice(show.grossSales))
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                        .foregroundStyle(theme.colors.textPrimary)
                }

                Spacer()

                Text("Live")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(theme.colors.textInverse)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(limeAccent)
                    .clipShape(Capsule())
            }

            HStack(spacing: 12) {
                showMetric(value: "\(show.cardsSold)", label: "Sold")
                showMetric(value: "\(show.cardsBought)", label: "Bought")
                showMetric(value: "\(show.tradeCount)", label: "Trades")
            }
        }
    }

    private func showMetric(value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(theme.colors.textPrimary)
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(theme.colors.textSecondary)
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
            Text("Fast actions")
                .font(.title3.weight(.bold))
                .foregroundStyle(theme.colors.textPrimary)

            VStack(spacing: 12) {
                showActionCard(
                    title: "Sell from scan",
                    subtitle: "Tap a fresh scan, confirm price and payment, and write it to this session.",
                    icon: "arrowshape.left.fill",
                    tint: theme.colors.success
                ) {
                    state.presentSell(
                        entry: previewEntry,
                        title: "Sell Card",
                        quantityLimit: 1
                    )
                }

                showActionCard(
                    title: "Sell from portfolio",
                    subtitle: "Open a card you already own and record the final sold price in one step.",
                    icon: "dollarsign.circle.fill",
                    tint: theme.colors.warning
                ) {
                    state.presentSell(
                        entry: previewEntry,
                        title: "Sell Card"
                    )
                }

                showActionCard(
                    title: "Trade builder",
                    subtitle: "Track cards out, cards in, and optional cash delta on one ticket.",
                    icon: "arrow.left.arrow.right.circle.fill",
                    tint: theme.colors.info
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
                        .foregroundStyle(theme.colors.textPrimary)
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(theme.colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(theme.colors.textSecondary)
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
                .foregroundStyle(theme.colors.textPrimary)

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
                                .foregroundStyle(theme.colors.textPrimary)
                            Text(activity.subtitle)
                                .font(.caption)
                                .foregroundStyle(theme.colors.textSecondary)
                            if let note = activity.note {
                                Text(note)
                                    .font(.caption2)
                                    .foregroundStyle(theme.colors.textSecondary)
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
                .foregroundStyle(theme.colors.textPrimary)

            Text("Start show mode before the event and keep every sale, trade, and buy attached to one session ledger.")
                .font(.subheadline)
                .foregroundStyle(theme.colors.textSecondary)

            Button("Start show") {
                state.startSampleShow()
            }
            .buttonStyle(
                LootyFilledButtonStyle(
                    fill: limeAccent,
                    foreground: theme.colors.textInverse,
                    cornerRadius: 18,
                    minHeight: 48
                )
            )
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
                .foregroundStyle(theme.colors.textPrimary)

            VStack(spacing: 12) {
                ForEach(state.recentShows.filter { state.activeShow?.id != $0.id }) { show in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(show.title)
                                    .font(.headline.weight(.bold))
                                    .foregroundStyle(theme.colors.textPrimary)
                                Text("\(show.location) • \(show.dateLabel)")
                                    .font(.caption)
                                    .foregroundStyle(theme.colors.textSecondary)
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
                .foregroundStyle(theme.colors.textPrimary)
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(theme.colors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func formattedPrice(_ value: Double, currencyCode: String = "USD") -> String {
        value.formatted(
            .currency(code: currencyCode)
                .precision(.fractionLength(2))
        )
    }
}

struct ShowSellPreviewSheet: View {
    private enum SellInputField: Hashable {
        case listPrice
        case sellPercent
    }

    let draft: ShowSellDraft
    let onConfirm: (ShowSellSubmission) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme
    @State private var quantity = 1
    @State private var listPriceText: String
    @State private var sellPercentText: String
    @State private var swipeOverlayState: SwipeSellOverlayState = .idle
    @State private var errorMessage: String?
    @State private var confirmationSheetOffset: CGFloat = 0
    @State private var hasInitializedConfirmationSheet = false
    @State private var lastClosedConfirmationSheetOffset: CGFloat = 0
    @State private var liveSwipeTranslation: CGFloat = 0
    @State private var focusedField: SellInputField?

    private var pageBackground: Color { theme.colors.pageLight }
    private var surfaceBackground: Color { theme.colors.surfaceLight }
    private var fieldBackground: Color { theme.colors.fieldLight }
    private var actionAccent: Color { theme.colors.success }
    private var primaryText: Color { theme.colors.textInverse }
    private var secondaryText: Color { theme.colors.textSecondaryInverse }
    private var outline: Color { theme.colors.outlineLight }
    private let compactInputWidth: CGFloat = 112
    private let compactInputHeight: CGFloat = 46
    private let actionHeight: CGFloat = 72
    private let swipeThreshold: CGFloat = 144
    private let listPriceValidationMessage = "Enter a list price before selling."

    init(
        draft: ShowSellDraft,
        onConfirm: @escaping (ShowSellSubmission) async throws -> Void
    ) {
        self.draft = draft
        self.onConfirm = onConfirm
        _listPriceText = State(initialValue: "")
        _sellPercentText = State(initialValue: "")
    }

    private var pricingCurrencyCode: String {
        draft.entry.card.pricing?.currencyCode ?? "USD"
    }

    private var parsedListPrice: Double? {
        let normalized = listPriceText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, let value = Double(normalized), value >= 0 else {
            return nil
        }
        return value
    }

    private var listingPrice: Double {
        parsedListPrice ?? 0
    }

    private var parsedSellPercent: Double? {
        let normalized = sellPercentText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, let value = Double(normalized), value >= 0 else {
            return nil
        }
        return value
    }

    private var resolvedSellPercent: Double {
        min(max(parsedSellPercent ?? 100, 0), 100)
    }

    private var targetSellPrice: Double {
        max(0, listingPrice * (resolvedSellPercent / 100))
    }

    private var grossTotal: Double {
        targetSellPrice * Double(quantity)
    }

    private var canSwipeToSubmit: Bool {
        !isInteractionLocked && !isEditingField
    }

    private var isEditingField: Bool {
        focusedField != nil
    }

    private var isInteractionLocked: Bool {
        swipeOverlayState != .idle
    }

    private var soldCardSummary: String {
        let quantitySummary = quantity == 1 ? "1 copy" : "\(quantity) copies"
        return "\(quantitySummary) of \(draft.entry.card.name)"
    }

    private var processingHeadline: String {
        "Selling \(formattedPrice(grossTotal, currencyCode: pricingCurrencyCode))"
    }

    private var processingDetail: String {
        "Locking in the sale for \(soldCardSummary)."
    }

    private var successHeadline: String {
        "You made \(formattedPrice(grossTotal, currencyCode: pricingCurrencyCode))"
    }

    private var successDetail: String {
        "by selling \(soldCardSummary)."
    }

    private var sellPercentBinding: Binding<String> {
        Binding(
            get: { sellPercentText },
            set: { newValue in
                let clampedValue = clampedDiscountInputText(newValue, maximum: 100, maximumFractionDigits: 2)
                guard clampedValue != sellPercentText else { return }
                sellPercentText = clampedValue
                invalidateReviewedSaleForValueChange()
            }
        )
    }

    private var hasInvalidPricingInput: Bool {
        parsedListPrice == nil
    }

    private var listPriceBinding: Binding<String> {
        Binding(
            get: { listPriceText },
            set: { newValue in
                guard newValue != listPriceText else { return }
                listPriceText = newValue
                invalidateReviewedSaleForValueChange()
            }
        )
    }

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                let containerHeight = proxy.size.height
                let closedOffset = closedConfirmationSheetOffset(containerHeight: containerHeight)
                let currentOffset = currentConfirmationSheetOffset(closedOffset: closedOffset)
                let confirmationProgress = confirmationSheetProgress(closedOffset: closedOffset)

                ZStack(alignment: .bottom) {
                    pageBackground
                        .ignoresSafeArea()
                    ScrollView(showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 14) {
                            sellSurface
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 18)
                        .padding(.bottom, actionHeight + 28)
                        .frame(
                            minHeight: max(0, proxy.size.height - proxy.safeAreaInsets.top - proxy.safeAreaInsets.bottom),
                            alignment: .top
                        )
                    }
                    .offset(y: -confirmationContentLift(containerHeight: containerHeight, closedOffset: closedOffset))
                    .scrollDismissesKeyboard(.interactively)

                    sellConfirmationSheet(
                        progress: confirmationProgress,
                        closedOffset: closedOffset
                    )
                    .offset(y: currentOffset)
                    .opacity(isEditingField ? 0 : 1)
                    .ignoresSafeArea(edges: .bottom)
                    .allowsHitTesting(!isInteractionLocked && !isEditingField)
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    clearInputFocus()
                }
                .onAppear {
                    initializeConfirmationSheetIfNeeded(closedOffset: closedOffset)
                }
                .onChange(of: closedOffset) { _, newValue in
                    updateConfirmationSheetClosedOffset(newValue)
                }
            }
            .toolbarBackground(pageBackground, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(actionAccent)
                    }
                    .disabled(isInteractionLocked)
                }

                ToolbarItem(placement: .principal) {
                    Text(draft.title)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(primaryText)
                }
            }
        }
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onChange(of: focusedField) { _, newValue in
            guard newValue != nil else { return }
            confirmationSheetOffset = lastClosedConfirmationSheetOffset
            liveSwipeTranslation = 0
        }
    }

    private func closedConfirmationSheetOffset(containerHeight: CGFloat) -> CGFloat {
        max(0, containerHeight - actionHeight)
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
        let translatedOffset = confirmationSheetOffset + resistedSwipeTranslation(liveSwipeTranslation)
        return min(max(0, translatedOffset), closedOffset)
    }

    private func confirmationSheetProgress(closedOffset: CGFloat) -> CGFloat {
        guard closedOffset > 0 else { return 0 }
        return 1 - (currentConfirmationSheetOffset(closedOffset: closedOffset) / closedOffset)
    }

    private func confirmationContentLift(containerHeight: CGFloat, closedOffset: CGFloat) -> CGFloat {
        confirmationSheetProgress(closedOffset: closedOffset) * max(0, min(containerHeight, closedOffset + actionHeight))
    }

    private func resistedSwipeTranslation(_ translation: CGFloat) -> CGFloat {
        if translation < 0 {
            return translation * 0.88
        }
        return translation * 0.35
    }

    private func sellConfirmationSheet(progress: CGFloat, closedOffset: CGFloat) -> some View {
        ZStack(alignment: .top) {
            if swipeOverlayState != .idle {
                SwipeSellStatusContent(
                    title: swipeOverlayState == .success ? "Congrats!" : "Processing sale",
                    headline: swipeOverlayState == .success ? successHeadline : processingHeadline,
                    detail: swipeOverlayState == .success ? successDetail : processingDetail,
                    showsProgress: swipeOverlayState == .processing
                )
                .padding(.horizontal, 28)
                .padding(.top, 148)
                .padding(.bottom, 96)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }

            VStack(spacing: 0) {
                sellBottomActionBar(progress: progress, closedOffset: closedOffset)
                Spacer(minLength: 0)
            }
            .opacity(swipeOverlayState == .idle ? 1 : 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(actionAccent)
        .animation(.spring(response: 0.28, dampingFraction: 0.88), value: swipeOverlayState)
    }

    private var sellSurface: some View {
        VStack(spacing: 0) {
            VStack(spacing: 14) {
                CardArtworkView(
                    urlString: draft.entry.card.imageSmallURL ?? draft.entry.card.imageLargeURL,
                    fallbackTitle: draft.entry.card.name,
                    cornerRadius: 20,
                    contentMode: .fit
                )
                .frame(width: 104, height: 146)
                .background(Color.black.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))

                VStack(spacing: 6) {
                    Text(draft.entry.card.name)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(primaryText)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)

                    Text("\(draft.entry.card.setName) • #\(draft.entry.card.number)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(secondaryText)
                        .multilineTextAlignment(.center)
                }

                VStack(spacing: 0) {
                    Text(formattedPrice(targetSellPrice, currencyCode: pricingCurrencyCode))
                        .font(.system(size: 52, weight: .bold, design: .rounded))
                        .foregroundStyle(primaryText)
                        .minimumScaleFactor(0.62)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 18)

            divider

            if let errorMessage {
                validationBanner(errorMessage)
                divider
            }

            cleanRow("List price") {
                compactValueField(
                    text: listPriceBinding,
                    placeholder: "0.00",
                    width: compactInputWidth,
                    focus: .listPrice
                )
            }

            divider

            cleanRow("Sell %") {
                compactValueField(
                    text: sellPercentBinding,
                    placeholder: "100",
                    width: compactInputWidth,
                    focus: .sellPercent
                )
            }

            divider

            cleanRow("Quantity") {
                quantityControl(maximum: max(1, draft.quantityLimit))
            }

            divider

            cleanRow("Total") {
                Text(formattedPrice(grossTotal, currencyCode: pricingCurrencyCode))
                    .font(.body.weight(.bold))
                    .foregroundStyle(primaryText)
            }
        }
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
        .padding(.bottom, 8)
    }

    private func sellBottomActionBar(progress: CGFloat, closedOffset: CGFloat) -> some View {
        let actionTitle = releaseToSellArmed ? "Release to sell" : "Swipe up to sell"
        return VStack(spacing: 0) {
            Rectangle()
                .fill(outline)
                .frame(height: 1)

            VStack(spacing: 6) {
                Image(systemName: "chevron.up")
                    .font(.system(size: 12, weight: .bold))
                Text(actionTitle)
                    .font(.headline.weight(.bold))
            }
            .foregroundStyle(theme.colors.textInverse)
            .frame(maxWidth: .infinity, minHeight: actionHeight)
        }
        .opacity(max(0.16, 1 - (progress * 1.15)))
        .scaleEffect(max(0.9, 1 - (progress * 0.1)))
        .contentShape(Rectangle())
        .gesture(sellSwipeGesture(closedOffset: closedOffset))
    }

    private var releaseToSellArmed: Bool {
        confirmationSheetProgress(closedOffset: lastClosedConfirmationSheetOffset) >= 0.42
    }

    private func sellSwipeGesture(closedOffset: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard canSwipeToSubmit else { return }
                let upwardTravel = max(0, -value.translation.height)
                guard !hasInvalidPricingInput else {
                    if upwardTravel > 6 {
                        showListPriceValidationError(closedOffset: closedOffset)
                    }
                    liveSwipeTranslation = 0
                    return
                }
                liveSwipeTranslation = value.translation.height
            }
            .onEnded { value in
                guard canSwipeToSubmit else { return }
                let resolvedTranslation = value.translation.height
                let upwardTravel = max(0, -resolvedTranslation)
                liveSwipeTranslation = 0
                guard !hasInvalidPricingInput else {
                    showListPriceValidationError(closedOffset: closedOffset)
                    return
                }
                if upwardTravel >= swipeThreshold {
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
        clearInputFocus()
        guard !hasInvalidPricingInput else {
            showListPriceValidationError(closedOffset: closedOffset)
            return
        }

        errorMessage = nil
        swipeOverlayState = .processing
        let processingStartedAt = Date()
        Task {
            do {
                try await onConfirm(
                    ShowSellSubmission(
                        quantity: quantity,
                        unitPrice: targetSellPrice,
                        paymentMethod: nil,
                        note: nil
                    )
                )
                let processingElapsed = Date().timeIntervalSince(processingStartedAt)
                let remainingProcessingDuration = max(
                    0,
                    sellSubmissionMinimumProcessingDuration - processingElapsed
                )
                if remainingProcessingDuration > 0 {
                    try? await Task.sleep(
                        nanoseconds: UInt64(remainingProcessingDuration * 1_000_000_000)
                    )
                }
                await MainActor.run {
                    swipeOverlayState = .success
                }
                try? await Task.sleep(
                    nanoseconds: UInt64(sellSubmissionSuccessDisplayDuration * 1_000_000_000)
                )
                await MainActor.run {
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    swipeOverlayState = .idle
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                        confirmationSheetOffset = closedOffset
                    }
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(outline)
            .frame(height: 1)
    }

    private func cleanRow<Content: View>(_ title: String, @ViewBuilder trailing: () -> Content) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(primaryText)

            Spacer()

            trailing()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private func quantityControl(maximum: Int) -> some View {
        HStack(spacing: 12) {
            quantityButton(systemName: "minus", disabled: quantity <= 1) {
                let updatedQuantity = max(1, quantity - 1)
                guard updatedQuantity != quantity else { return }
                quantity = updatedQuantity
                invalidateReviewedSaleForValueChange()
            }

            Text("\(quantity)")
                .font(.body.weight(.bold))
                .foregroundStyle(primaryText)
                .frame(minWidth: 28)

            quantityButton(systemName: "plus", disabled: quantity >= maximum) {
                let updatedQuantity = min(maximum, quantity + 1)
                guard updatedQuantity != quantity else { return }
                quantity = updatedQuantity
                invalidateReviewedSaleForValueChange()
            }
        }
    }

    private func quantityButton(systemName: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(disabled ? secondaryText.opacity(0.5) : primaryText)
                .frame(width: 38, height: 38)
                .background(fieldBackground)
                .clipShape(Circle())
                .overlay(
                    Circle()
                        .stroke(outline, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func validationBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(theme.colors.danger)

            VStack(alignment: .leading, spacing: 4) {
                Text("Can’t sell yet")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(primaryText)

                Text(message)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(primaryText.opacity(0.78))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(theme.colors.danger.opacity(0.12))
    }

    private func compactValueField(
        text: Binding<String>,
        placeholder: String,
        width: CGFloat?,
        focus: SellInputField
    ) -> some View {
        let needsAttention = focus == .listPrice && hasInvalidPricingInput && errorMessage != nil
        let strokeColor = needsAttention ? theme.colors.danger : outline

        return UIKitDecimalTextField(
            text: text,
            placeholder: placeholder,
            alignment: width == nil ? .left : .right,
            font: .systemFont(ofSize: 17, weight: .bold),
            textColor: UIColor(primaryText),
            traceContext: "ShowSellPreviewSheet",
            onTapReceived: {
                print("🟡 TAP RECEIVED: \(Date()) [ShowSellPreviewSheet]")
            },
            onEditingBegan: {
                focusedField = focus
                confirmationSheetOffset = lastClosedConfirmationSheetOffset
                liveSwipeTranslation = 0
            },
            onEditingEnded: {
                DispatchQueue.main.async {
                    if focusedField == focus {
                        focusedField = nil
                    }
                }
            }
        )
            .padding(.horizontal, 12)
            .frame(maxWidth: width == nil ? .infinity : width, minHeight: compactInputHeight, maxHeight: compactInputHeight)
            .background(fieldBackground)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(strokeColor, lineWidth: needsAttention ? 1.5 : 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func clearInputFocus() {
        focusedField = nil
        dismissKeyboard()
    }

    private func invalidateReviewedSaleForValueChange() {
        confirmationSheetOffset = lastClosedConfirmationSheetOffset
        liveSwipeTranslation = 0
        swipeOverlayState = .idle
        if errorMessage != nil {
            errorMessage = nil
        }
    }

    private func showListPriceValidationError(closedOffset: CGFloat) {
        swipeOverlayState = .idle
        errorMessage = "Enter a list price before selling."
        liveSwipeTranslation = 0
        withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
            confirmationSheetOffset = closedOffset
        }
    }

    private func formattedPrice(_ value: Double, currencyCode: String = "USD") -> String {
        value.formatted(
            .currency(code: currencyCode)
                .precision(.fractionLength(2))
        )
    }

    private func formattedPercent(_ value: Double) -> String {
        "\(value.formatted(.number.precision(.fractionLength(0...2))))%"
    }
}

struct ShowSellBatchPreviewSheet: View {
    private enum BatchSellInputField: Hashable {
        case listPrice(String)
        case sellPercent(String)
    }

    let draft: ShowSellBatchDraft
    let onConfirm: (ShowSellBatchSubmission) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme
    @State private var quantitiesByLineID: [String: Int]
    @State private var listPriceTextByLineID: [String: String]
    @State private var sellPercentTextByLineID: [String: String]
    @State private var swipeOverlayState: SwipeSellOverlayState = .idle
    @State private var errorMessage: String?
    @State private var isReviewingSale = false
    @State private var confirmationSheetOffset: CGFloat = 0
    @State private var hasInitializedConfirmationSheet = false
    @State private var lastClosedConfirmationSheetOffset: CGFloat = 0
    @State private var liveSwipeTranslation: CGFloat = 0
    @State private var focusedField: BatchSellInputField?

    private var pageBackground: Color { theme.colors.pageLight }
    private var surfaceBackground: Color { theme.colors.surfaceLight }
    private var fieldBackground: Color { theme.colors.fieldLight }
    private var actionAccent: Color { theme.colors.success }
    private var primaryText: Color { theme.colors.textInverse }
    private var secondaryText: Color { theme.colors.textSecondaryInverse }
    private var outline: Color { theme.colors.outlineLight }
    private let compactInputWidth: CGFloat = 112
    private let compactInputHeight: CGFloat = 46
    private let actionHeight: CGFloat = 72
    private let swipeThreshold: CGFloat = 144
    private let listPriceValidationMessage = "Enter a list price before selling."

    init(
        draft: ShowSellBatchDraft,
        onConfirm: @escaping (ShowSellBatchSubmission) async throws -> Void
    ) {
        self.draft = draft
        self.onConfirm = onConfirm
        _quantitiesByLineID = State(
            initialValue: Dictionary(
                uniqueKeysWithValues: draft.lines.map { ($0.id, $0.quantityLimit) }
            )
        )
        _listPriceTextByLineID = State(
            initialValue: Dictionary(
                uniqueKeysWithValues: draft.lines.map { ($0.id, "") }
            )
        )
        _sellPercentTextByLineID = State(
            initialValue: Dictionary(
                uniqueKeysWithValues: draft.lines.map { ($0.id, "") }
            )
        )
    }

    private var activeLines: [ShowSellBatchLineDraft] {
        draft.lines.filter { quantity(for: $0) > 0 }
    }

    private var totalSelectedQuantity: Int {
        activeLines.reduce(0) { partialResult, line in
            partialResult + quantity(for: line)
        }
    }

    private var summaryCurrencyCode: String {
        draft.lines.first?.entry.card.pricing?.currencyCode ?? "USD"
    }

    private var grossTotal: Double {
        activeLines.reduce(0) { partialResult, line in
            partialResult + (Double(quantity(for: line)) * resolvedUnitPrice(for: line))
        }
    }

    private var hasInvalidActivePricing: Bool {
        activeLines.contains { line in
            hasInvalidSelectedPricing(for: line)
        }
    }

    private var canSwipeToSubmit: Bool {
        !isInteractionLocked && !isEditingField
    }

    private var isEditingField: Bool {
        focusedField != nil
    }

    private var isInteractionLocked: Bool {
        swipeOverlayState != .idle
    }

    private var releaseToSellArmed: Bool {
        confirmationSheetProgress(closedOffset: lastClosedConfirmationSheetOffset) >= 0.42
    }

    private var batchSoldCardsSummary: String {
        let labels = activeLines.map { line in
            let quantitySummary = quantity(for: line) == 1 ? "1 copy" : "\(quantity(for: line)) copies"
            return "\(quantitySummary) of \(line.entry.card.name)"
        }

        guard let firstLabel = labels.first else {
            return "your selected cards"
        }

        if labels.count == 1 {
            return firstLabel
        }
        if labels.count == 2 {
            return "\(labels[0]) and \(labels[1])"
        }
        return "\(firstLabel) and \(labels.count - 1) more cards"
    }

    private var batchProcessingHeadline: String {
        "Selling \(formattedPrice(grossTotal, currencyCode: summaryCurrencyCode))"
    }

    private var batchProcessingDetail: String {
        "Locking in the sale for \(batchSoldCardsSummary)."
    }

    private var batchSuccessHeadline: String {
        "You made \(formattedPrice(grossTotal, currencyCode: summaryCurrencyCode))"
    }

    private var batchSuccessDetail: String {
        "by selling \(batchSoldCardsSummary)."
    }

    var body: some View {
        NavigationStack {
            ZStack {
                pageBackground
                    .ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 14) {
                        batchSummaryHero

                        if let errorMessage, shouldShowTopLevelValidationBanner {
                            validationBanner(errorMessage)
                        }

                        ForEach(draft.lines) { line in
                            batchLineCard(line)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 18)
                    .padding(.bottom, 118)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                clearInputFocus()
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                editBottomActionBar
            }
            .toolbarBackground(pageBackground, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(actionAccent)
                    }
                    .disabled(isInteractionLocked)
                }

                ToolbarItem(placement: .principal) {
                    Text(draft.title)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(primaryText)
                }
            }
            .navigationDestination(isPresented: $isReviewingSale) {
                reviewPage
            }
        }
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onChange(of: focusedField) { _, newValue in
            guard newValue != nil, isReviewingSale else { return }
            confirmationSheetOffset = lastClosedConfirmationSheetOffset
            liveSwipeTranslation = 0
        }
    }

    private var batchSummaryHero: some View {
        VStack(spacing: 8) {
            Text(formattedPrice(grossTotal, currencyCode: summaryCurrencyCode))
                .font(.system(size: 56, weight: .bold, design: .rounded))
                .foregroundStyle(primaryText)
                .minimumScaleFactor(0.6)

            Text("Sell total")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(secondaryText)

            Text(activeLines.isEmpty ? "Choose cards to sell" : "\(totalSelectedQuantity) cards selected")
                .font(.headline.weight(.semibold))
                .foregroundStyle(primaryText.opacity(0.88))
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 4)
    }

    private func validationBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(theme.colors.danger)

            VStack(alignment: .leading, spacing: 4) {
                Text("Can’t sell yet")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(primaryText)

                Text(message)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(primaryText.opacity(0.78))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(theme.colors.danger.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func closedConfirmationSheetOffset(containerHeight: CGFloat) -> CGFloat {
        max(0, containerHeight - actionHeight)
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
        let translatedOffset = confirmationSheetOffset + resistedSwipeTranslation(liveSwipeTranslation)
        return min(max(0, translatedOffset), closedOffset)
    }

    private func confirmationSheetProgress(closedOffset: CGFloat) -> CGFloat {
        guard closedOffset > 0 else { return 0 }
        return 1 - (currentConfirmationSheetOffset(closedOffset: closedOffset) / closedOffset)
    }

    private func confirmationContentLift(containerHeight: CGFloat, closedOffset: CGFloat) -> CGFloat {
        confirmationSheetProgress(closedOffset: closedOffset) * max(0, min(containerHeight, closedOffset + actionHeight))
    }

    private func resistedSwipeTranslation(_ translation: CGFloat) -> CGFloat {
        if translation < 0 {
            return translation * 0.88
        }
        return translation * 0.35
    }

    private var reviewPage: some View {
        GeometryReader { proxy in
            let containerHeight = proxy.size.height
            let closedOffset = closedConfirmationSheetOffset(containerHeight: containerHeight)
            let currentOffset = currentConfirmationSheetOffset(closedOffset: closedOffset)
            let confirmationProgress = confirmationSheetProgress(closedOffset: closedOffset)

            ZStack(alignment: .bottom) {
                pageBackground
                    .ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 18) {
                        reviewSummaryHero

                        if let errorMessage {
                            validationBanner(errorMessage)
                        }

                        VStack(spacing: 12) {
                            ForEach(activeLines) { line in
                                reviewLineCard(line)
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 10)
                    .padding(.bottom, actionHeight + 28)
                    .frame(
                        minHeight: max(0, proxy.size.height - proxy.safeAreaInsets.top - proxy.safeAreaInsets.bottom),
                        alignment: .top
                    )
                }
                .offset(y: -confirmationContentLift(containerHeight: containerHeight, closedOffset: closedOffset))
                .scrollDismissesKeyboard(.immediately)

                sellConfirmationSheet(
                    progress: confirmationProgress,
                    closedOffset: closedOffset
                )
                .offset(y: currentOffset)
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(!isInteractionLocked)
            }
            .onAppear {
                initializeConfirmationSheetIfNeeded(closedOffset: closedOffset)
            }
            .onChange(of: closedOffset) { _, newValue in
                updateConfirmationSheetClosedOffset(newValue)
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbarBackground(pageBackground, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    isReviewingSale = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(actionAccent)
                }
                .disabled(isInteractionLocked)
            }

            ToolbarItem(placement: .principal) {
                Text("Batch sell")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(primaryText)
            }
        }
    }

    private func sellConfirmationSheet(progress: CGFloat, closedOffset: CGFloat) -> some View {
        ZStack(alignment: .top) {
            if swipeOverlayState != .idle {
                SwipeSellStatusContent(
                    title: swipeOverlayState == .success ? "Congrats!" : "Processing sale",
                    headline: swipeOverlayState == .success ? batchSuccessHeadline : batchProcessingHeadline,
                    detail: swipeOverlayState == .success ? batchSuccessDetail : batchProcessingDetail,
                    showsProgress: swipeOverlayState == .processing
                )
                .padding(.horizontal, 28)
                .padding(.top, 148)
                .padding(.bottom, 96)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }

            VStack(spacing: 0) {
                sellBottomActionBar(progress: progress, closedOffset: closedOffset)
                Spacer(minLength: 0)
            }
            .opacity(swipeOverlayState == .idle ? 1 : 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(actionAccent)
        .animation(.spring(response: 0.28, dampingFraction: 0.88), value: swipeOverlayState)
    }

    private func batchLineCard(_ line: ShowSellBatchLineDraft) -> some View {
        let currentQuantity = quantity(for: line)
        let lineCurrencyCode = line.entry.card.pricing?.currencyCode ?? "USD"
        let lineDealTotal = Double(currentQuantity) * resolvedUnitPrice(for: line)
        let showsInlineListPriceValidation = shouldShowInlineListPriceValidation(for: line)

        return VStack(spacing: 0) {
            VStack(spacing: 14) {
                CardArtworkView(
                    urlString: line.entry.card.imageSmallURL ?? line.entry.card.imageLargeURL,
                    fallbackTitle: line.entry.card.name,
                    cornerRadius: 20,
                    contentMode: .fit
                )
                .frame(width: 104, height: 146)
                .background(Color.black.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))

                VStack(spacing: 6) {
                    Text(line.entry.card.name)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(primaryText)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)

                    Text("\(line.entry.card.setName) • #\(line.entry.card.number)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(secondaryText)
                        .multilineTextAlignment(.center)
                }

                Text(formattedPrice(resolvedUnitPrice(for: line), currencyCode: lineCurrencyCode))
                    .font(.system(size: 52, weight: .bold, design: .rounded))
                    .foregroundStyle(primaryText)
                    .minimumScaleFactor(0.62)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 18)

            divider

            if showsInlineListPriceValidation {
                validationBanner(listPriceValidationMessage)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)

                divider
            }

            cleanRow("List price") {
                compactValueField(
                    text: listPriceBinding(for: line),
                    placeholder: "0.00",
                    width: compactInputWidth,
                    focus: .listPrice(line.id),
                    needsAttention: quantity(for: line) > 0 && hasInvalidSelectedPricing(for: line) && errorMessage != nil
                )
            }

            divider

            cleanRow("Sell %") {
                compactValueField(
                    text: sellPercentBinding(for: line),
                    placeholder: "100",
                    width: compactInputWidth,
                    focus: .sellPercent(line.id),
                    needsAttention: false
                )
            }

            divider

            cleanRow("Quantity") {
                quantityControl(for: line)
            }

            divider

            cleanRow("Total") {
                Text(formattedPrice(lineDealTotal, currencyCode: lineCurrencyCode))
                    .font(.body.weight(.bold))
                    .foregroundStyle(primaryText)
            }
        }
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
        .opacity(currentQuantity == 0 ? 0.72 : 1)
    }

    private func quantity(for line: ShowSellBatchLineDraft) -> Int {
        min(max(0, quantitiesByLineID[line.id] ?? line.quantityLimit), line.quantityLimit)
    }

    private func quantityControl(for line: ShowSellBatchLineDraft) -> some View {
        HStack(spacing: 12) {
            quantityButton(
                systemName: "minus",
                disabled: quantity(for: line) <= 0
            ) {
                let updatedQuantity = max(0, quantity(for: line) - 1)
                guard updatedQuantity != quantity(for: line) else { return }
                quantitiesByLineID[line.id] = updatedQuantity
                invalidateReviewedSaleForValueChange()
            }

            Text("\(quantity(for: line))")
                .font(.body.weight(.bold))
                .foregroundStyle(primaryText)
                .frame(minWidth: 28)

            quantityButton(
                systemName: "plus",
                disabled: quantity(for: line) >= line.quantityLimit
            ) {
                let updatedQuantity = min(line.quantityLimit, quantity(for: line) + 1)
                guard updatedQuantity != quantity(for: line) else { return }
                quantitiesByLineID[line.id] = updatedQuantity
                invalidateReviewedSaleForValueChange()
            }
        }
    }

    private func quantityButton(systemName: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(disabled ? secondaryText.opacity(0.5) : primaryText)
                .frame(width: 38, height: 38)
                .background(fieldBackground)
                .clipShape(Circle())
                .overlay(
                    Circle()
                        .stroke(outline, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func listPriceBinding(for line: ShowSellBatchLineDraft) -> Binding<String> {
        Binding(
            get: { listPriceTextByLineID[line.id] ?? "" },
            set: { newValue in
                guard newValue != (listPriceTextByLineID[line.id] ?? "") else { return }
                listPriceTextByLineID[line.id] = newValue
                invalidateReviewedSaleForValueChange()
            }
        )
    }

    private func sellPercentBinding(for line: ShowSellBatchLineDraft) -> Binding<String> {
        Binding(
            get: { sellPercentTextByLineID[line.id] ?? "" },
            set: { newValue in
                let clampedValue = clampedDiscountInputText(newValue, maximum: 100, maximumFractionDigits: 2)
                guard clampedValue != (sellPercentTextByLineID[line.id] ?? "") else { return }
                sellPercentTextByLineID[line.id] = clampedValue
                invalidateReviewedSaleForValueChange()
            }
        )
    }

    private func parsedListPrice(for line: ShowSellBatchLineDraft) -> Double? {
        let normalized = (listPriceTextByLineID[line.id] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              let value = Double(normalized),
              value >= 0 else {
            return nil
        }
        return value
    }

    private func resolvedListPrice(for line: ShowSellBatchLineDraft) -> Double {
        parsedListPrice(for: line) ?? 0
    }

    private func parsedSellPercent(for line: ShowSellBatchLineDraft) -> Double? {
        let normalized = (sellPercentTextByLineID[line.id] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              let value = Double(normalized),
              value >= 0 else {
            return nil
        }
        return value
    }

    private func resolvedSellPercent(for line: ShowSellBatchLineDraft) -> Double {
        min(max(parsedSellPercent(for: line) ?? 100, 0), 100)
    }

    private func resolvedUnitPrice(for line: ShowSellBatchLineDraft) -> Double {
        max(0, resolvedListPrice(for: line) * (resolvedSellPercent(for: line) / 100))
    }

    private func hasInvalidSelectedPricing(for line: ShowSellBatchLineDraft) -> Bool {
        parsedListPrice(for: line) == nil
    }

    private var reviewSummaryHero: some View {
        VStack(spacing: 8) {
            Text(formattedPrice(grossTotal, currencyCode: summaryCurrencyCode))
                .font(.system(size: 52, weight: .bold, design: .rounded))
                .foregroundStyle(primaryText)
                .minimumScaleFactor(0.6)

            Text("Sell total")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(secondaryText)

            Text(totalSelectedQuantity == 1 ? "Total for 1 card" : "Total for \(totalSelectedQuantity) cards")
                .font(.headline.weight(.semibold))
                .foregroundStyle(primaryText.opacity(0.88))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 24)
        .padding(.bottom, 8)
    }

    private func reviewLineCard(_ line: ShowSellBatchLineDraft) -> some View {
        let currentQuantity = quantity(for: line)
        let currencyCode = line.entry.card.pricing?.currencyCode ?? "USD"
        let unitPrice = resolvedUnitPrice(for: line)
        let lineTotal = Double(currentQuantity) * unitPrice

        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                CardArtworkView(
                    urlString: line.entry.card.imageSmallURL ?? line.entry.card.imageLargeURL,
                    fallbackTitle: line.entry.card.name,
                    cornerRadius: 16,
                    contentMode: .fit
                )
                .frame(width: 60, height: 86)
                .background(Color.black.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                VStack(alignment: .leading, spacing: 6) {
                    Text(line.entry.card.name)
                        .font(.headline.weight(.bold))
                        .foregroundStyle(primaryText)
                        .lineLimit(2)

                    Text("\(line.entry.card.setName) • #\(line.entry.card.number)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(secondaryText)
                }
            }

            divider

            reviewLineDetailRow(
                "List price",
                value: formattedPrice(resolvedListPrice(for: line), currencyCode: currencyCode)
            )
            reviewLineDetailRow(
                "Sell %",
                value: formattedPercent(resolvedSellPercent(for: line))
            )
            reviewLineDetailRow(
                "Sale price",
                value: formattedPrice(unitPrice, currencyCode: currencyCode)
            )
            reviewLineDetailRow("Quantity", value: "\(currentQuantity)")
            reviewLineDetailRow(
                "Total",
                value: formattedPrice(lineTotal, currencyCode: currencyCode)
            )
        }
        .padding(20)
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private var divider: some View {
        Rectangle()
            .fill(outline)
            .frame(height: 1)
    }

    private func cleanRow<Content: View>(_ title: String, @ViewBuilder trailing: () -> Content) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(primaryText)

            Spacer()

            trailing()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private func reviewLineDetailRow(_ title: String, value: String) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(primaryText)

            Spacer()

            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(primaryText)
        }
    }

    private func compactValueField(
        text: Binding<String>,
        placeholder: String,
        width: CGFloat?,
        focus: BatchSellInputField,
        needsAttention: Bool
    ) -> some View {
        let strokeColor = needsAttention ? theme.colors.danger : outline

        return UIKitDecimalTextField(
            text: text,
            placeholder: placeholder,
            alignment: width == nil ? .left : .right,
            font: .systemFont(ofSize: 17, weight: .bold),
            textColor: UIColor(primaryText),
            traceContext: "ShowSellBatchPreviewSheet",
            onTapReceived: {
                print("🟡 TAP RECEIVED: \(Date()) [ShowSellBatchPreviewSheet]")
            },
            onEditingBegan: {
                focusedField = focus
                confirmationSheetOffset = lastClosedConfirmationSheetOffset
                liveSwipeTranslation = 0
            },
            onEditingEnded: {
                DispatchQueue.main.async {
                    if focusedField == focus {
                        focusedField = nil
                    }
                }
            }
        )
            .padding(.horizontal, 12)
            .frame(maxWidth: width == nil ? .infinity : width, minHeight: compactInputHeight, maxHeight: compactInputHeight)
            .background(fieldBackground)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(strokeColor, lineWidth: needsAttention ? 1.5 : 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func sellBottomActionBar(progress: CGFloat, closedOffset: CGFloat) -> some View {
        let actionTitle = releaseToSellArmed ? "Release to sell" : "Swipe up to sell"
        return VStack(spacing: 0) {
            Rectangle()
                .fill(outline)
                .frame(height: 1)

            VStack(spacing: 6) {
                Image(systemName: "chevron.up")
                    .font(.system(size: 12, weight: .bold))
                Text(actionTitle)
                    .font(.headline.weight(.bold))
            }
            .foregroundStyle(theme.colors.textInverse)
            .frame(maxWidth: .infinity, minHeight: actionHeight)
        }
        .opacity(max(0.16, 1 - (progress * 1.15)))
        .scaleEffect(max(0.9, 1 - (progress * 0.1)))
        .contentShape(Rectangle())
        .gesture(batchSellSwipeGesture(closedOffset: closedOffset))
    }

    private var editBottomActionBar: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(outline)
                .frame(height: 1)

            VStack {
                Button {
                    reviewSale()
                } label: {
                    Text("Review sale")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(
                    LootyFilledButtonStyle(
                        fill: actionAccent,
                        foreground: theme.colors.textInverse,
                        cornerRadius: 18,
                        minHeight: 58
                    )
                )
                .disabled(isInteractionLocked)
                .opacity(isInteractionLocked ? 0.78 : 1)
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
            }
            .background(pageBackground)
        }
    }

    private func batchSellSwipeGesture(closedOffset: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard canSwipeToSubmit else { return }
                let upwardTravel = max(0, -value.translation.height)
                guard !activeLines.isEmpty else {
                    if upwardTravel > 6 {
                        showEmptySelectionValidationError(closedOffset: closedOffset)
                    }
                    liveSwipeTranslation = 0
                    return
                }
                guard !hasInvalidActivePricing else {
                    if upwardTravel > 6 {
                        showListPriceValidationError(closedOffset: closedOffset)
                    }
                    liveSwipeTranslation = 0
                    return
                }
                liveSwipeTranslation = value.translation.height
            }
            .onEnded { value in
                guard canSwipeToSubmit else { return }
                let resolvedTranslation = value.translation.height
                let upwardTravel = max(0, -resolvedTranslation)
                liveSwipeTranslation = 0
                guard !activeLines.isEmpty else {
                    showEmptySelectionValidationError(closedOffset: closedOffset)
                    return
                }
                guard !hasInvalidActivePricing else {
                    showListPriceValidationError(closedOffset: closedOffset)
                    return
                }
                if upwardTravel >= swipeThreshold {
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

    private func invalidateReviewedSaleForValueChange() {
        if isReviewingSale {
            isReviewingSale = false
        }
        confirmationSheetOffset = lastClosedConfirmationSheetOffset
        liveSwipeTranslation = 0
        swipeOverlayState = .idle
        if errorMessage != nil {
            errorMessage = nil
        }
    }

    private func clearInputFocus() {
        focusedField = nil
        dismissKeyboard()
    }

    private var shouldShowTopLevelValidationBanner: Bool {
        guard let errorMessage else { return false }
        return errorMessage != listPriceValidationMessage
    }

    private func shouldShowInlineListPriceValidation(for line: ShowSellBatchLineDraft) -> Bool {
        guard errorMessage == listPriceValidationMessage else { return false }
        guard quantity(for: line) > 0 else { return false }
        return hasInvalidSelectedPricing(for: line)
    }

    private func reviewSale() {
        clearInputFocus()
        guard !activeLines.isEmpty else {
            errorMessage = "Choose at least one card to sell."
            return
        }
        guard !hasInvalidActivePricing else {
            errorMessage = listPriceValidationMessage
            return
        }
        errorMessage = nil
        swipeOverlayState = .idle
        confirmationSheetOffset = lastClosedConfirmationSheetOffset
        liveSwipeTranslation = 0
        isReviewingSale = true
    }

    private func submitBatchSale(closedOffset: CGFloat) {
        clearInputFocus()
        guard !activeLines.isEmpty else {
            showEmptySelectionValidationError(closedOffset: closedOffset)
            withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                confirmationSheetOffset = closedOffset
            }
            return
        }
        guard !hasInvalidActivePricing else {
            showListPriceValidationError(closedOffset: closedOffset)
            return
        }

        errorMessage = nil
        swipeOverlayState = .processing
        let processingStartedAt = Date()

        Task {
            do {
                try await onConfirm(
                    ShowSellBatchSubmission(
                        lines: activeLines.map { line in
                            ShowSellBatchLineSubmission(
                                id: line.id,
                                entry: line.entry,
                                quantity: quantity(for: line),
                                unitPrice: resolvedUnitPrice(for: line),
                                sourceItemIDs: line.sourceItemIDs
                            )
                        },
                        paymentMethod: nil,
                        note: nil
                    )
                )
                let processingElapsed = Date().timeIntervalSince(processingStartedAt)
                let remainingProcessingDuration = max(
                    0,
                    sellSubmissionMinimumProcessingDuration - processingElapsed
                )
                if remainingProcessingDuration > 0 {
                    try? await Task.sleep(
                        nanoseconds: UInt64(remainingProcessingDuration * 1_000_000_000)
                    )
                }
                await MainActor.run {
                    swipeOverlayState = .success
                }
                try? await Task.sleep(
                    nanoseconds: UInt64(sellSubmissionSuccessDisplayDuration * 1_000_000_000)
                )
                await MainActor.run {
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    swipeOverlayState = .idle
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                        confirmationSheetOffset = closedOffset
                    }
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func showEmptySelectionValidationError(closedOffset: CGFloat) {
        swipeOverlayState = .idle
        errorMessage = "Choose at least one card to sell."
        liveSwipeTranslation = 0
        withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
            confirmationSheetOffset = closedOffset
        }
    }

    private func showListPriceValidationError(closedOffset: CGFloat) {
        swipeOverlayState = .idle
        errorMessage = listPriceValidationMessage
        liveSwipeTranslation = 0
        withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
            confirmationSheetOffset = closedOffset
        }
    }

    private func formattedPrice(_ value: Double, currencyCode: String = "USD") -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }

    private func formattedPercent(_ value: Double) -> String {
        "\(value.formatted(.number.precision(.fractionLength(0...2))))%"
    }
}

private struct ShowBuyChoice: Identifiable, Hashable {
    let id: String
    let label: String
}

struct ShowBuyPreviewSheet: View {
    let draft: ShowBuyDraft
    let onConfirm: (ShowBuySubmission) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme
    @State private var quantity: Int
    @State private var buyPriceText: String
    @State private var selectedVariantID: String?
    @State private var selectedGrader: String
    @State private var selectedGrade: String
    @State private var selectedCondition: DeckCardCondition = .nearMint
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var pageBackground: Color { theme.colors.canvas }
    private var surfaceBackground: Color { theme.colors.canvasElevated }
    private var fieldBackground: Color { theme.colors.surface }
    private var actionAccent: Color { theme.colors.info }
    private var primaryText: Color { theme.colors.textPrimary }
    private var secondaryText: Color { theme.colors.textSecondary }
    private var outline: Color { theme.colors.outlineSubtle }

    init(
        draft: ShowBuyDraft,
        onConfirm: @escaping (ShowBuySubmission) async throws -> Void
    ) {
        let initialVariant = Self.normalizedValue(draft.selectedVariant)
            ?? Self.normalizedValue(draft.entry.slabContext?.variantName)
            ?? Self.normalizedValue(draft.entry.card.pricing?.variant)
            ?? Self.normalizedValue(draft.entry.card.variant)
            ?? Self.normalizedValue(draft.availableVariants.first?.id)
            ?? "Unlimited"
        let initialGrader = Self.normalizedValue(draft.entry.slabContext?.grader) ?? "Raw"
        let initialGrade = Self.normalizedValue(draft.entry.slabContext?.grade) ?? "10"
        self.draft = draft
        self.onConfirm = onConfirm
        _quantity = State(initialValue: draft.quantityDefault)
        _buyPriceText = State(initialValue: String(format: "%.2f", draft.suggestedPrice))
        _selectedVariantID = State(initialValue: initialVariant)
        _selectedGrader = State(initialValue: initialGrader)
        _selectedGrade = State(initialValue: initialGrade)
        _selectedCondition = State(initialValue: draft.entry.condition ?? .nearMint)
    }

    private var resolvedUnitPrice: Double {
        let normalized = buyPriceText.trimmingCharacters(in: .whitespacesAndNewlines)
        if let value = Double(normalized), value >= 0 {
            return value
        }
        return max(0, draft.suggestedPrice)
    }

    private var isRawSelection: Bool {
        selectedGrader.caseInsensitiveCompare("Raw") == .orderedSame
    }

    private var selectedVariant: String? {
        Self.normalizedValue(selectedVariantID)
    }

    private var selectedGradedGrade: String {
        Self.normalizedValue(selectedGrade) ?? gradedGradeChoices.first ?? "10"
    }

    private var variantChoices: [ShowBuyChoice] {
        var choices: [ShowBuyChoice] = []

        func appendChoice(id: String?, label: String? = nil) {
            guard let normalizedID = Self.normalizedValue(id) else { return }
            guard !choices.contains(where: { $0.id.caseInsensitiveCompare(normalizedID) == .orderedSame }) else {
                return
            }
            let resolvedLabel = Self.normalizedValue(label) ?? normalizedID
            choices.append(ShowBuyChoice(id: normalizedID, label: resolvedLabel))
        }

        for option in draft.availableVariants {
            appendChoice(id: option.id, label: option.label)
        }

        appendChoice(id: selectedVariant)
        appendChoice(id: draft.entry.slabContext?.variantName)
        appendChoice(id: draft.entry.card.pricing?.variant)
        appendChoice(id: draft.entry.card.variant)

        if choices.isEmpty {
            choices.append(ShowBuyChoice(id: "Unlimited", label: "Unlimited"))
        }

        return choices
    }

    private var graderChoices: [ShowBuyChoice] {
        ["Raw", "PSA", "BGS", "CGC"].map { option in
            ShowBuyChoice(id: option, label: option)
        }
    }

    private var gradedGradeChoices: [String] {
        ["10", "9.5", "9", "8.5", "8", "7.5", "7", "6.5", "6", "5.5", "5", "4.5", "4", "3.5", "3", "2.5", "2", "1.5", "1"]
    }

    var body: some View {
        NavigationStack {
            ZStack {
                pageBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 18) {
                        buySurface

                        if let errorMessage {
                            Text(errorMessage)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(theme.colors.danger)
                                .padding(.horizontal, 2)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 18)
                    .padding(.bottom, 118)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                bottomActionBar
            }
            .toolbarBackground(pageBackground, for: .navigationBar)
            .navigationTitle("Add to Collection")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onChange(of: selectedGrader) { _, newValue in
            guard newValue.caseInsensitiveCompare("Raw") != .orderedSame,
                  Self.normalizedValue(selectedGrade) == nil else {
                return
            }
            selectedGrade = gradedGradeChoices.first ?? "10"
        }
    }

    private var buySurface: some View {
        VStack(spacing: 0) {
            VStack(alignment: .center, spacing: 18) {
                CardArtworkView(
                    urlString: draft.entry.card.imageSmallURL ?? draft.entry.card.imageLargeURL,
                    fallbackTitle: draft.entry.card.name,
                    cornerRadius: 20,
                    contentMode: .fit
                )
                .frame(width: 118, height: 166)
                .background(fieldBackground)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))

                VStack(spacing: 8) {
                    Text(draft.entry.card.name)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(primaryText)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)

                    Text("#\(draft.entry.card.number) • \(draft.entry.card.setName)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(secondaryText)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 24)
            .padding(.horizontal, 20)
            .padding(.bottom, 20)

            divider

            VStack(alignment: .leading, spacing: 18) {
                selectionRow(title: "Variant") {
                    selectablePillRow(
                        options: variantChoices,
                        selectedID: selectedVariant
                    ) { optionID in
                        selectedVariantID = optionID
                    }
                }

                selectionRow(title: "Grader") {
                    selectablePillRow(
                        options: graderChoices,
                        selectedID: selectedGrader
                    ) { optionID in
                        selectedGrader = optionID
                    }
                }

                selectionRow(title: "Grade") {
                    if isRawSelection {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(DeckCardCondition.allCases) { condition in
                                    Button {
                                        selectedCondition = condition
                                    } label: {
                                        selectionPill(
                                            title: condition.shortLabel,
                                            isSelected: selectedCondition == condition
                                        )
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    } else {
                        selectablePillRow(
                            options: gradedGradeChoices.map { ShowBuyChoice(id: $0, label: $0) },
                            selectedID: selectedGradedGrade
                        ) { optionID in
                            selectedGrade = optionID
                        }
                    }
                }

                selectionRow(title: "Quantity") {
                    quantityControl(maximum: 99)
                }
            }
            .padding(20)
        }
        .background(surfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private var bottomActionBar: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(outline)
                .frame(height: 1)

            VStack(spacing: 12) {
                Button {
                    submitBuy()
                } label: {
                    Text(isSubmitting ? "ADDING…" : "Add to collection")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(
                    LootyFilledButtonStyle(
                        fill: actionAccent,
                        foreground: theme.colors.textInverse,
                        cornerRadius: 20,
                        minHeight: 56
                    )
                )
                .disabled(isSubmitting)
                .opacity(isSubmitting ? 0.82 : 1)
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 12)
            .background(pageBackground)
        }
    }

    private func submitBuy() {
        errorMessage = nil
        isSubmitting = true

        Task {
            do {
                try await onConfirm(
                    ShowBuySubmission(
                        quantity: quantity,
                        unitPrice: resolvedUnitPrice,
                        paymentMethod: nil,
                        note: nil,
                        condition: isRawSelection ? selectedCondition : nil,
                        slabContext: isRawSelection
                            ? nil
                            : SlabContext(
                                grader: selectedGrader,
                                grade: selectedGradedGrade,
                                certNumber: nil,
                                variantName: selectedVariant
                            ),
                        selectedVariant: selectedVariant
                    )
                )
                await MainActor.run {
                    isSubmitting = false
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    isSubmitting = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(outline)
            .frame(height: 1)
    }

    private func cleanRow<Content: View>(_ title: String, @ViewBuilder trailing: () -> Content) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(primaryText)

            Spacer()

            trailing()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
    }

    private func detailRow(title: String, value: String) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(primaryText)

            Spacer()

            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(primaryText)
        }
    }

    private func selectionRow<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(primaryText)
            content()
        }
    }

    private func selectablePillRow(
        options: [ShowBuyChoice],
        selectedID: String?,
        action: @escaping (String) -> Void
    ) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(options) { option in
                    Button {
                        action(option.id)
                    } label: {
                        selectionPill(
                            title: option.label,
                            isSelected: option.id.caseInsensitiveCompare(selectedID ?? "") == .orderedSame
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func selectionPill(title: String, isSelected: Bool) -> some View {
        LootyPill(
            title: title,
            isSelected: isSelected,
            fill: isSelected ? actionAccent : fieldBackground,
            foreground: isSelected ? .white : primaryText.opacity(0.78),
            stroke: isSelected ? actionAccent : outline,
            font: theme.typography.caption
        )
    }

    private func valueChip(_ value: String) -> some View {
        Text(value)
            .font(.subheadline.weight(.bold))
            .foregroundStyle(primaryText)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(fieldBackground)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(outline, lineWidth: 1)
            )
    }

    private func identityChip(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .tracking(0.8)
                .foregroundStyle(secondaryText)

            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(fieldBackground)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(outline, lineWidth: 1)
        )
    }

    private func quantityControl(maximum: Int) -> some View {
        HStack(spacing: 12) {
            quantityButton(systemName: "minus", disabled: quantity <= 1) {
                quantity = max(1, quantity - 1)
            }

            Text("\(quantity)")
                .font(.body.weight(.bold))
                .foregroundStyle(primaryText)
                .frame(minWidth: 28)

            quantityButton(systemName: "plus", disabled: quantity >= maximum) {
                quantity = min(maximum, quantity + 1)
            }
        }
    }

    private func quantityButton(systemName: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(disabled ? secondaryText.opacity(0.5) : primaryText)
                .frame(width: 32, height: 32)
                .background(fieldBackground)
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func formattedPrice(_ value: Double, currencyCode: String = "USD") -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }

    private static func normalizedValue(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return normalized.isEmpty ? nil : normalized
    }
}

struct ShowTradePreviewSheet: View {
    let draft: ShowTradeDraft

    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme
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
                        tint: theme.colors.danger
                    )
                    tradeColumn(
                        title: "You got",
                        cards: ["Blastoise ex #009", "Cash"],
                        tint: theme.colors.success
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
                }
                .buttonStyle(
                    LootyFilledButtonStyle(
                        fill: theme.colors.brand,
                        foreground: theme.colors.textInverse,
                        cornerRadius: 16,
                        minHeight: 52
                    )
                )

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
