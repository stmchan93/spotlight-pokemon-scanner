import Foundation

@MainActor
final class AppContainer: ObservableObject {
    let scannerViewModel: ScannerViewModel

    init() {
        let cameraController = CameraSessionController()
        let analyzer = RawCardScanner(config: .init(
            cardDetection: .default,
            bottomRegionOCR: .default,
            debug: .disabled
        ))
        let fallbackMatcher = LocalPrototypeMatchingService()

        // HARDCODED: Force Mac's local IP for iPhone connectivity
        let remoteBaseURL = URL(string: "http://192.168.0.225:8788/")!

        print("📡 [APP] Backend URL: \(remoteBaseURL.absoluteString)")

        let matcher = HybridCardMatchingService(
            primary: RemoteScanMatchingService(baseURL: remoteBaseURL),
            fallback: fallbackMatcher
        )
        let logStore = ScanEventStore()

        scannerViewModel = ScannerViewModel(
            cameraController: cameraController,
            analyzer: analyzer,
            matcher: matcher,
            logStore: logStore
        )

        // Start camera session immediately so it's ready when view appears
        cameraController.requestAccessIfNeeded()
    }
}
