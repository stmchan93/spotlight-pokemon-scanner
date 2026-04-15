import SwiftUI

enum AppShellTab {
    case deck
    case scan
}

struct AppShellState: Equatable {
    private(set) var selectedTab: AppShellTab = .scan

    mutating func exitScanner() {
        selectedTab = .deck
    }

    mutating func openScanner() {
        selectedTab = .scan
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

    private var showsDeckOverlay: Bool {
        shellState.selectedTab == .deck && scannerViewModel.route == .scanner
    }

    var body: some View {
        ZStack {
            ScannerRootView(
                viewModel: scannerViewModel,
                collectionStore: collectionStore,
                onExitScanner: {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        shellState.exitScanner()
                    }
                }
            )

            if showsDeckOverlay {
                DeckView(
                    onSelectEntry: { entry in
                        scannerViewModel.presentResultDetail(for: entry)
                    },
                    collectionStore: collectionStore,
                    onOpenScanner: {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            shellState.openScanner()
                        }
                    }
                )
                    .transition(.move(edge: .leading).combined(with: .opacity))
                    .zIndex(3)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: shellState.selectedTab)
    }
}
