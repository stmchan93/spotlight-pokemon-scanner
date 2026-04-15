import SwiftUI

enum AppShellTab {
    case deck
    case scan
    case shows
}

struct AppShellState: Equatable {
    private(set) var selectedTab: AppShellTab = .scan

    mutating func exitScanner() {
        selectedTab = .deck
    }

    mutating func openScanner() {
        selectedTab = .scan
    }

    mutating func openShows() {
        selectedTab = .shows
    }
}

@main
struct SpotlightApp: App {
    @StateObject private var container = AppContainer()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            AppShellView(
                scannerViewModel: container.scannerViewModel,
                collectionStore: container.collectionStore
            )
                .preferredColorScheme(.dark)
                .onAppear {
                    container.primeLocalNetworkPermissionIfNeeded()
                    container.refreshCollectionStoreFromBackend()
                }
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            container.primeLocalNetworkPermissionIfNeeded()
            container.refreshCollectionStoreFromBackend()
        }
    }
}

struct AppShellView: View {
    @ObservedObject var scannerViewModel: ScannerViewModel
    @ObservedObject var collectionStore: CollectionStore
    @State private var shellState = AppShellState()
    @StateObject private var showsState = ShowsMockState()

    private var showingDeckDetail: Bool {
        shellState.selectedTab == .deck && scannerViewModel.route == .resultDetail
    }

    var body: some View {
        ZStack {
            if shellState.selectedTab == .scan {
                ScannerRootView(
                    viewModel: scannerViewModel,
                    collectionStore: collectionStore,
                    showsState: showsState,
                    onExitScanner: {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            shellState.exitScanner()
                        }
                    }
                )
            } else if shellState.selectedTab == .deck {
                DeckView(
                    onSelectEntry: { entry in
                        scannerViewModel.presentResultDetail(for: entry)
                    },
                    collectionStore: collectionStore,
                    onOpenScanner: {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            shellState.openScanner()
                        }
                    },
                    onOpenShows: {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            shellState.openShows()
                        }
                    }
                )
                .transition(.move(edge: .leading).combined(with: .opacity))

                if showingDeckDetail {
                    ScanResultDetailView(
                        viewModel: scannerViewModel,
                        collectionStore: collectionStore,
                        showsState: showsState
                    )
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                    .zIndex(2)
                }
            } else if shellState.selectedTab == .shows {
                ShowsView(
                    state: showsState,
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
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .sheet(item: $showsState.presentedFlow) { flow in
            switch flow {
            case .sell(let draft):
                ShowSellPreviewSheet(draft: draft)
            case .trade(let draft):
                ShowTradePreviewSheet(draft: draft)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: shellState.selectedTab)
        .animation(.easeInOut(duration: 0.24), value: scannerViewModel.route)
    }
}
