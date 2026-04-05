import SwiftUI

@main
struct SpotlightApp: App {
    @StateObject private var container = AppContainer()

    var body: some Scene {
        WindowGroup {
            ScannerRootView(viewModel: container.scannerViewModel)
                .preferredColorScheme(.dark)
        }
    }
}
