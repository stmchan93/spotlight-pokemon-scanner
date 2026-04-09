import SwiftUI

@main
struct SpotlightApp: App {
    @StateObject private var container = AppContainer()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ScannerRootView(viewModel: container.scannerViewModel)
                .preferredColorScheme(.dark)
                .onAppear {
                    container.primeLocalNetworkPermissionIfNeeded()
                }
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            container.primeLocalNetworkPermissionIfNeeded()
        }
    }
}
