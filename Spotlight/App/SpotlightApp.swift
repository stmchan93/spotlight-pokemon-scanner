import SwiftUI

@main
struct SpotlightApp: App {
    @StateObject private var container = AppContainer()

    init() {
        // Cleanup expired cache on app launch
        let cacheManager = ScanCacheManager()
        cacheManager.cleanup()
        print("✅ [APP] Cache cleanup completed")
    }

    var body: some Scene {
        WindowGroup {
            ScannerRootView(viewModel: container.scannerViewModel)
                .preferredColorScheme(.dark)
        }
    }
}
