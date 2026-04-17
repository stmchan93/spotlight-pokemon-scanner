import Foundation
import SwiftUI

enum AppRuntime {
    static var isRunningTests: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
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

func appShellUsesSharedDetailOverlay(selectedTab: AppShellTab, route: ScannerRoute) -> Bool {
    switch selectedTab {
    case .portfolio, .scan:
        return route == .resultDetail
    case .ledger:
        return false
    }
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
            if AppRuntime.isRunningTests {
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
        AppShellView(
            scannerViewModel: container.scannerViewModel,
            collectionStore: container.collectionStore,
            onEnsurePortfolioEntries: {
                container.refreshCollectionStoreAfterWarmup(scope: .entries)
            }
        )
        .onAppear {
            container.beginInitialCollectionLoadIfNeeded()
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
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
    let onEnsurePortfolioEntries: () -> Void
    @State private var shellState = AppShellState()
    @StateObject private var dealFlowState = ShowsMockState()

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

    var body: some View {
        ZStack {
            PortfolioSurfaceView(
                onSelectEntry: { entry in
                    spotlightFlowLog("Portfolio entry tapped id=\(entry.id) cardID=\(entry.card.id)")
                    scannerViewModel.presentResultDetail(for: entry)
                },
                collectionStore: collectionStore,
                isVisible: shellState.selectedTab == .portfolio,
                onEnsureEntries: onEnsurePortfolioEntries,
                onOpenScanner: {
                    spotlightFlowLog("AppShell openScanner requested from portfolio")
                    withAnimation(.easeInOut(duration: 0.18)) {
                        shellState.openScanner()
                    }
                },
                onOpenLedger: {
                    spotlightFlowLog("AppShell openLedger requested from portfolio")
                    withAnimation(.easeInOut(duration: 0.18)) {
                        shellState.openLedger()
                    }
                }
            )
            .opacity(shellState.selectedTab == .portfolio ? 1 : 0)
            .allowsHitTesting(shellState.selectedTab == .portfolio)
            .zIndex(shellState.selectedTab == .portfolio ? 1 : 0)

            if shellState.selectedTab == .scan {
                ScannerRootView(
                    viewModel: scannerViewModel,
                    collectionStore: collectionStore,
                    dealFlowState: dealFlowState,
                    showsInlineDetail: false,
                    onExitScanner: {
                        spotlightFlowLog("AppShell exitScanner requested from scanner")
                        withAnimation(.easeInOut(duration: 0.18)) {
                            shellState.exitScanner()
                        }
                    }
                )
                .transition(.opacity)
                .zIndex(2)
            } else if shellState.selectedTab == .ledger {
                DashboardView(
                    collectionStore: collectionStore,
                    onOpenPortfolio: {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            shellState.exitScanner()
                        }
                    },
                    onOpenScanner: {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            shellState.openScanner()
                        }
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
        .animation(.easeInOut(duration: 0.2), value: shellState.selectedTab)
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
}
