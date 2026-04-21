import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AudioToolbox)
import AudioToolbox
#endif

enum AppRuntime {
    static var isRunningTests: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }

    static var isRunningUITests: Bool {
        ProcessInfo.processInfo.environment["SPOTLIGHT_UI_TEST_MODE"] == "1"
    }

    static var shouldUseTestHostPlaceholder: Bool {
        isRunningTests && !isRunningUITests
    }

    static var shouldBypassAuthForUITests: Bool {
        isRunningUITests && ProcessInfo.processInfo.environment["SPOTLIGHT_UI_TEST_BYPASS_AUTH"] == "1"
    }
}

func spotlightFlowLog(_ message: @autoclosure () -> String) {
#if DEBUG
    let uptime = String(format: "%.3f", ProcessInfo.processInfo.systemUptime)
    let thread = Thread.isMainThread ? "main" : "bg"
    print("🧭 [FLOW \(uptime)s \(thread)] \(message())")
#endif
}

enum AppFeedback {
    static func cameraCapture() {
#if canImport(UIKit)
        DispatchQueue.main.async {
            let impact = UIImpactFeedbackGenerator(style: .rigid)
            impact.prepare()
            impact.impactOccurred(intensity: 0.9)
#if canImport(AudioToolbox)
            AudioServicesPlaySystemSound(1108)
#endif
        }
#endif
    }

    static func saleCompleted() {
#if canImport(UIKit)
        DispatchQueue.main.async {
            let success = UINotificationFeedbackGenerator()
            success.prepare()
            success.notificationOccurred(.success)

            let accent = UIImpactFeedbackGenerator(style: .soft)
            accent.prepare()
            accent.impactOccurred(intensity: 0.7)
        }
#endif
    }
}

enum AppShellTab: Hashable {
    case portfolio
    case scan
    case ledger
}

struct AppShellState: Equatable {
    private(set) var selectedTab: AppShellTab = .scan

    mutating func exitScanner() {
        selectedTab = .portfolio
    }

    mutating func openScanner() {
        selectedTab = .scan
    }

    mutating func openLedger() {
        selectedTab = .ledger
    }
}

func appShellSupportsPagedSwipe(
    selectedTab: AppShellTab,
    isPresentingDealFlow: Bool,
    showingSharedDetail: Bool,
    portfolioVerticalScrollIsActive: Bool
) -> Bool {
    guard !isPresentingDealFlow, !showingSharedDetail, selectedTab != .ledger else {
        return false
    }
    if selectedTab == .portfolio && portfolioVerticalScrollIsActive {
        return false
    }
    return true
}

func portfolioScrollShouldBeDisabledDuringHorizontalPageSwipe(
    selectedTab: AppShellTab,
    pagerDragTranslation: CGFloat,
    minimumHorizontalTravel: CGFloat = 6
) -> Bool {
    guard selectedTab == .portfolio else { return false }
    return abs(pagerDragTranslation) >= minimumHorizontalTravel
}

func appShellUsesSharedDetailOverlay(selectedTab: AppShellTab, route: ScannerRoute) -> Bool {
    switch selectedTab {
    case .portfolio, .scan:
        return route == .resultDetail
    case .ledger:
        return false
    }
}

func appShellPagerStackOffset(
    selectedTab: AppShellTab,
    containerWidth: CGFloat
) -> CGFloat {
    switch selectedTab {
    case .scan:
        return -containerWidth
    case .portfolio:
        return 0
    case .ledger:
        return 0
    }
}

func scannerShellShouldStayVisible(
    selectedTab: AppShellTab,
    pagerDragTranslation: CGFloat,
    pagerTransitionIsSettling: Bool
) -> Bool {
    if selectedTab == .scan {
        return true
    }
    if pagerTransitionIsSettling {
        return true
    }
    return abs(pagerDragTranslation) > 0
}

@main
struct SpotlightApp: App {
    var body: some Scene {
        WindowGroup {
            SpotlightRootView()
        }
    }
}

private struct SpotlightRootView: View {
    var body: some View {
        Group {
            if AppRuntime.shouldUseTestHostPlaceholder {
                TestHostPlaceholderView()
            } else {
                LiveAppRootView()
            }
        }
        .lootyTheme(.default)
        .preferredColorScheme(.light)
    }
}

private struct LiveAppRootView: View {
    @StateObject private var container = AppContainer()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        AuthGateView(authStore: container.authStore) {
            AppShellView(
                scannerViewModel: container.scannerViewModel,
                collectionStore: container.collectionStore,
                authStore: container.authStore,
                matcher: container.cardMatchingService,
                onEnsurePortfolioEntries: {
                    container.refreshCollectionStoreAfterWarmup(scope: .entries)
                }
            )
            .onAppear {
                container.beginInitialCollectionLoadIfNeeded()
            }
        }
        .onOpenURL { url in
            container.authStore.handleOpenURL(url)
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            guard container.authStore.state == .signedIn else { return }
            container.handleAppDidBecomeActive()
        }
    }
}

private struct TestHostPlaceholderView: View {
    var body: some View {
        Color.black
            .ignoresSafeArea()
            .accessibilityIdentifier("spotlight-test-host-root")
    }
}

struct AppShellView: View {
    @Environment(\.lootyTheme) private var theme
    @ObservedObject var scannerViewModel: ScannerViewModel
    @ObservedObject var collectionStore: CollectionStore
    @ObservedObject var authStore: AuthStore
    let matcher: any CardMatchingService
    let onEnsurePortfolioEntries: () -> Void
    @State private var shellState = AppShellState()
    @State private var portfolioVerticalScrollIsActive = false
    @StateObject private var dealFlowState = ShowsMockState()
    @State private var showingAccountSheet = false

    private var isPresentingDealFlow: Bool {
        dealFlowState.presentedFlow != nil
    }

    private var singleSellDealFlowBinding: Binding<ShowSellDraft?> {
        Binding(
            get: {
                switch dealFlowState.presentedFlow {
                case .some(.sell(let draft)):
                    return draft
                case .some(.sellBatch), .some(.buy), .some(.trade), nil:
                    return nil
                }
            },
            set: { newValue in
                switch newValue {
                case .some(let draft):
                    dealFlowState.presentedFlow = .sell(draft)
                case nil:
                    switch dealFlowState.presentedFlow {
                    case .some(.sell):
                        dealFlowState.presentedFlow = nil
                    case .some(.sellBatch), .some(.buy), .some(.trade), nil:
                        break
                    }
                }
            }
        )
    }

    private var sellBatchDealFlowBinding: Binding<ShowSellBatchDraft?> {
        Binding(
            get: {
                switch dealFlowState.presentedFlow {
                case .some(.sellBatch(let draft)):
                    return draft
                case .some(.sell), .some(.buy), .some(.trade), nil:
                    return nil
                }
            },
            set: { newValue in
                switch newValue {
                case .some(let draft):
                    dealFlowState.presentedFlow = .sellBatch(draft)
                case nil:
                    switch dealFlowState.presentedFlow {
                    case .some(.sellBatch):
                        dealFlowState.presentedFlow = nil
                    case .some(.sell), .some(.buy), .some(.trade), nil:
                        break
                    }
                }
            }
        )
    }

    private var sheetDealFlowBinding: Binding<ShowsPresentedFlow?> {
        Binding(
            get: {
                switch dealFlowState.presentedFlow {
                case .some(.buy), .some(.trade):
                    return dealFlowState.presentedFlow
                case .some(.sell), .some(.sellBatch), nil:
                    return nil
                }
            },
            set: { newValue in
                switch newValue {
                case .some(.buy), .some(.trade):
                    dealFlowState.presentedFlow = newValue
                case nil:
                    switch dealFlowState.presentedFlow {
                    case .some(.buy), .some(.trade):
                        dealFlowState.presentedFlow = nil
                    case .some(.sell), .some(.sellBatch), nil:
                        break
                    }
                case .some(.sell), .some(.sellBatch):
                    break
                }
            }
        )
    }

    private var showingScannerDetail: Bool {
        !isPresentingDealFlow &&
        shellState.selectedTab == .scan &&
        appShellUsesSharedDetailOverlay(selectedTab: shellState.selectedTab, route: scannerViewModel.route)
    }

    private var showingPortfolioDetail: Bool {
        !isPresentingDealFlow &&
        shellState.selectedTab == .portfolio &&
        appShellUsesSharedDetailOverlay(selectedTab: shellState.selectedTab, route: scannerViewModel.route)
    }

    private var showingSharedDetail: Bool {
        showingScannerDetail || showingPortfolioDetail
    }

    private var activePagerTab: AppShellTab {
        shellState.selectedTab == .scan ? .scan : .portfolio
    }

    private var pagerSelection: Binding<AppShellTab> {
        Binding(
            get: { activePagerTab },
            set: { newValue in
                guard newValue != shellState.selectedTab else { return }
                switch newValue {
                case .portfolio:
                    shellState.exitScanner()
                case .scan:
                    shellState.openScanner()
                case .ledger:
                    shellState.openLedger()
                }
            }
        )
    }

    private var appShellBackgroundColor: Color {
        if shellState.selectedTab == .scan && scannerViewModel.route == .scanner {
            return .black
        }
        return theme.colors.canvas
    }

    private var preferredShellColorScheme: ColorScheme? {
        if shellState.selectedTab == .scan && scannerViewModel.route == .scanner {
            return .dark
        }
        return .light
    }

    var body: some View {
        GeometryReader { proxy in
            let pagerTopInset = proxy.safeAreaInsets.top
            let pagerBottomInset = proxy.safeAreaInsets.bottom

            ZStack {
                appShellBackgroundColor
                    .ignoresSafeArea()

                TabView(selection: pagerSelection) {
                    PortfolioSurfaceView(
                        onSelectEntry: { entry in
                            spotlightFlowLog("Portfolio entry tapped id=\(entry.id) cardID=\(entry.card.id)")
                            scannerViewModel.presentResultDetail(for: entry)
                        },
                        collectionStore: collectionStore,
                        scannerViewModel: scannerViewModel,
                        showsState: dealFlowState,
                        accountMonogram: authStore.currentUser?.initials ?? "?",
                        isVisible: shellState.selectedTab == .portfolio,
                        isHorizontalPageSwipeActive: false,
                        onEnsureEntries: onEnsurePortfolioEntries,
                        onOpenScanner: {
                            spotlightFlowLog("AppShell openScanner requested from portfolio")
                            transitionToScanner()
                        },
                        onOpenAccount: {
                            showingAccountSheet = true
                        },
                        onVerticalScrollGestureActiveChanged: { isActive in
                            if portfolioVerticalScrollIsActive != isActive {
                                portfolioVerticalScrollIsActive = isActive
                            }
                        }
                    )
                    .tag(AppShellTab.portfolio)

                    ScannerRootView(
                        viewModel: scannerViewModel,
                        collectionStore: collectionStore,
                        dealFlowState: dealFlowState,
                        rootSafeAreaTop: pagerTopInset,
                        rootSafeAreaBottom: pagerBottomInset,
                        showsInlineDetail: false,
                        isVisible: shellState.selectedTab == .scan,
                        keepsCameraWarmOffscreen: shellState.selectedTab == .portfolio,
                        onExitScanner: {
                            spotlightFlowLog("AppShell exitScanner requested from scanner")
                            transitionToPortfolio()
                        }
                    )
                    .tag(AppShellTab.scan)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .background(Color.clear)
                .allowsHitTesting(!showingSharedDetail && shellState.selectedTab != .ledger)

                if shellState.selectedTab == .ledger {
                    DashboardView(
                        collectionStore: collectionStore,
                        accountMonogram: authStore.currentUser?.initials ?? "?",
                        onOpenPortfolio: {
                            withAnimation(.easeInOut(duration: 0.18)) {
                                shellState.exitScanner()
                            }
                        },
                        onOpenScanner: {
                            withAnimation(.easeInOut(duration: 0.18)) {
                                shellState.openScanner()
                            }
                        },
                        onOpenAccount: {
                            showingAccountSheet = true
                        }
                    )
                    .transition(.opacity)
                    .zIndex(2)
                }

                if showingScannerDetail {
                    ScanResultDetailView(
                        viewModel: scannerViewModel,
                        collectionStore: collectionStore,
                        showsState: dealFlowState
                    )
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                    .zIndex(3)
                } else if showingPortfolioDetail {
                    ScanResultDetailView(
                        viewModel: scannerViewModel,
                        collectionStore: collectionStore,
                        showsState: dealFlowState
                    )
                        .zIndex(3)
                }
            }
        }
        .preferredColorScheme(preferredShellColorScheme)
        .sheet(item: singleSellDealFlowBinding) { draft in
            ShowSellPreviewSheet(
                draft: draft,
                onTrade: dealFlowState.activeShow == nil ? nil : {
                    dealFlowState.transitionFromSellToTrade(previewEntry: draft.entry)
                }
            ) { submission in
                _ = try await collectionStore.recordSale(
                    card: draft.entry.card,
                    slabContext: draft.entry.slabContext,
                    quantity: submission.quantity,
                    unitPrice: submission.unitPrice,
                    currencyCode: draft.entry.card.pricing?.currencyCode ?? "USD",
                    paymentMethod: submission.paymentMethod,
                    soldAt: Date(),
                    showSessionID: nil,
                    note: submission.note
                )
                AppFeedback.saleCompleted()
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .fullScreenCover(item: sellBatchDealFlowBinding) { draft in
            ShowSellBatchPreviewSheet(draft: draft) { submission in
                let soldAt = Date()
                let requests = submission.lines.map { line in
                    PortfolioSaleBatchLineRequest(
                        card: line.entry.card,
                        slabContext: line.entry.slabContext,
                        quantity: line.quantity,
                        unitPrice: line.unitPrice,
                        currencyCode: line.entry.card.pricing?.currencyCode ?? "USD",
                        paymentMethod: submission.paymentMethod,
                        soldAt: soldAt,
                        showSessionID: nil,
                        note: submission.note,
                        sourceScanID: nil
                    )
                }
                _ = try await collectionStore.recordSalesBatch(requests)
                AppFeedback.saleCompleted()

                let soldItemIDs = submission.lines.flatMap { line in
                    Array(line.sourceItemIDs.prefix(line.quantity))
                }
                await MainActor.run {
                    scannerViewModel.removeStackItems(soldItemIDs)
                    let cardCount = submission.lines.reduce(0) { partialResult, line in
                        partialResult + line.quantity
                    }
                    scannerViewModel.showBannerMessage("Sold \(cardCount) scanned card\(cardCount == 1 ? "" : "s")")
                }
            }
        }
        .sheet(item: sheetDealFlowBinding) { flow in
            switch flow {
            case .buy(let draft):
                ShowBuyPreviewSheet(draft: draft) { submission in
                    _ = try await collectionStore.recordBuy(
                        card: draft.entry.card,
                        slabContext: submission.slabContext,
                        condition: submission.condition,
                        quantity: submission.quantity,
                        unitPrice: submission.unitPrice,
                        currencyCode: draft.entry.card.pricing?.currencyCode ?? "USD",
                        paymentMethod: submission.paymentMethod,
                        boughtAt: Date(),
                        sourceScanID: nil
                    )
                }
            case .trade(let draft):
                ShowTradePreviewSheet(draft: draft)
            case .sell, .sellBatch:
                EmptyView()
            }
        }
        .sheet(isPresented: $showingAccountSheet) {
            AccountView(
                authStore: authStore,
                collectionStore: collectionStore,
                matcher: matcher
            )
        }
        .onChange(of: shellState.selectedTab, initial: true) { oldValue, newValue in
            spotlightFlowLog("AppShell selectedTab \(String(describing: oldValue)) -> \(String(describing: newValue)), route=\(String(describing: scannerViewModel.route)), sharedDetail=\(showingSharedDetail)")
        }
        .onChange(of: scannerViewModel.route, initial: true) { oldValue, newValue in
            spotlightFlowLog("AppShell route \(String(describing: oldValue)) -> \(String(describing: newValue)), tab=\(String(describing: shellState.selectedTab)), portfolioDetail=\(showingPortfolioDetail), scannerDetail=\(showingScannerDetail)")
        }
        .onChange(of: showingSharedDetail, initial: true) { oldValue, newValue in
            spotlightFlowLog("AppShell sharedDetail \(oldValue) -> \(newValue), tab=\(String(describing: shellState.selectedTab)), route=\(String(describing: scannerViewModel.route))")
        }
    }

    private func transitionToPortfolio() {
        withAnimation(.spring(response: 0.26, dampingFraction: 0.9)) {
            shellState.exitScanner()
        }
    }

    private func transitionToScanner() {
        withAnimation(.spring(response: 0.26, dampingFraction: 0.9)) {
            shellState.openScanner()
        }
    }
}
