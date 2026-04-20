import Foundation
import SwiftUI

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

enum AppShellTab {
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
        return 0
    case .portfolio:
        return -containerWidth
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
        .preferredColorScheme(.dark)
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
    @ObservedObject var scannerViewModel: ScannerViewModel
    @ObservedObject var collectionStore: CollectionStore
    @ObservedObject var authStore: AuthStore
    let onEnsurePortfolioEntries: () -> Void
    @State private var shellState = AppShellState()
    @StateObject private var dealFlowState = ShowsMockState()
    @State private var portfolioVerticalScrollIsActive = false
    @State private var pagerTransitionIsSettling = false
    @State private var pagerSettleToken = UUID()
    @State private var showingAccountSheet = false
    @GestureState private var pagerDragTranslation: CGFloat = 0

    private var isPresentingDealFlow: Bool {
        dealFlowState.presentedFlow != nil
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

    private var supportsPagedSwipe: Bool {
        appShellSupportsPagedSwipe(
            selectedTab: shellState.selectedTab,
            isPresentingDealFlow: isPresentingDealFlow,
            showingSharedDetail: showingSharedDetail,
            portfolioVerticalScrollIsActive: portfolioVerticalScrollIsActive
        )
    }

    private var effectivePagerDragTranslation: CGFloat {
        guard supportsPagedSwipe else { return 0 }
        switch shellState.selectedTab {
        case .scan:
            return min(pagerDragTranslation, 0)
        case .portfolio:
            return max(pagerDragTranslation, 0)
        case .ledger:
            return 0
        }
    }

    private var portfolioHorizontalPageSwipeIsActive: Bool {
        portfolioScrollShouldBeDisabledDuringHorizontalPageSwipe(
            selectedTab: shellState.selectedTab,
            pagerDragTranslation: effectivePagerDragTranslation
        )
    }

    private var scannerShellIsVisible: Bool {
        scannerShellShouldStayVisible(
            selectedTab: shellState.selectedTab,
            pagerDragTranslation: effectivePagerDragTranslation,
            pagerTransitionIsSettling: pagerTransitionIsSettling
        )
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                HStack(spacing: 0) {
                    ScannerRootView(
                        viewModel: scannerViewModel,
                        collectionStore: collectionStore,
                        dealFlowState: dealFlowState,
                        showsInlineDetail: false,
                        isVisible: scannerShellIsVisible,
                        keepsCameraWarmOffscreen: shellState.selectedTab == .portfolio,
                        onExitScanner: {
                            spotlightFlowLog("AppShell exitScanner requested from scanner")
                            transitionToPortfolio()
                        }
                    )
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .clipped()
                    .allowsHitTesting(shellState.selectedTab == .scan)

                    PortfolioSurfaceView(
                        onSelectEntry: { entry in
                            spotlightFlowLog("Portfolio entry tapped id=\(entry.id) cardID=\(entry.card.id)")
                            scannerViewModel.presentResultDetail(for: entry)
                        },
                        collectionStore: collectionStore,
                        isVisible: shellState.selectedTab == .portfolio,
                        isHorizontalPageSwipeActive: portfolioHorizontalPageSwipeIsActive,
                        onEnsureEntries: onEnsurePortfolioEntries,
                        onOpenScanner: {
                            spotlightFlowLog("AppShell openScanner requested from portfolio")
                            transitionToScanner()
                        },
                        onOpenLedger: {
                            spotlightFlowLog("AppShell openLedger requested from portfolio")
                            withAnimation(.easeInOut(duration: 0.18)) {
                                shellState.openLedger()
                            }
                        },
                        onVerticalScrollGestureActiveChanged: { isActive in
                            if portfolioVerticalScrollIsActive != isActive {
                                portfolioVerticalScrollIsActive = isActive
                            }
                        }
                    )
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .clipped()
                    .allowsHitTesting(shellState.selectedTab == .portfolio)
                }
                .frame(width: proxy.size.width * 2, height: proxy.size.height, alignment: .leading)
                .offset(
                    x: appShellPagerStackOffset(
                        selectedTab: shellState.selectedTab,
                        containerWidth: proxy.size.width
                    ) + effectivePagerDragTranslation
                )
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
                .clipped()

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
            .simultaneousGesture(shellPagerGesture(containerWidth: proxy.size.width))
        }
        .sheet(item: $dealFlowState.presentedFlow) { flow in
            switch flow {
            case .sell(let draft):
                ShowSellPreviewSheet(draft: draft) { submission in
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
                }
            case .sellBatch(let draft):
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
            case .buy(let draft):
                ShowBuyPreviewSheet(draft: draft) { submission in
                    _ = try await collectionStore.recordBuy(
                        card: draft.entry.card,
                        slabContext: draft.entry.slabContext,
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
            }
        }
        .sheet(isPresented: $showingAccountSheet) {
            AccountView(authStore: authStore)
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

    private func shellPagerGesture(containerWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 16)
            .updating($pagerDragTranslation) { value, state, _ in
                guard supportsPagedSwipe else { return }
                if shellState.selectedTab == .portfolio,
                   value.startLocation.x > 36 {
                    return
                }
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let limit = containerWidth * 0.92
                state = max(-limit, min(limit, value.translation.width))
            }
            .onEnded { value in
                guard supportsPagedSwipe else { return }
                guard abs(value.translation.width) > abs(value.translation.height) else { return }

                switch shellState.selectedTab {
                case .scan:
                    guard scannerSwipeShouldOpenPortfolio(
                        startLocation: value.startLocation,
                        translation: value.translation,
                        containerWidth: containerWidth
                    ) else { return }
                    transitionToPortfolio()
                case .portfolio:
                    guard portfolioSwipeShouldOpenScanner(
                        startLocation: value.startLocation,
                        translation: value.translation
                    ) else { return }
                    transitionToScanner()
                case .ledger:
                    break
                }
            }
    }

    private func transitionToPortfolio() {
        beginPagerSettleWindow()
        withAnimation(.spring(response: 0.26, dampingFraction: 0.9)) {
            shellState.exitScanner()
        }
    }

    private func transitionToScanner() {
        beginPagerSettleWindow()
        withAnimation(.spring(response: 0.26, dampingFraction: 0.9)) {
            shellState.openScanner()
        }
    }

    private func beginPagerSettleWindow(duration: TimeInterval = 0.38) {
        let token = UUID()
        pagerSettleToken = token
        pagerTransitionIsSettling = true
        DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
            guard pagerSettleToken == token else { return }
            pagerTransitionIsSettling = false
        }
    }
}
