import Foundation

@MainActor
final class AppContainer: ObservableObject {
    let scannerViewModel: ScannerViewModel
    private let remoteMatcher: RemoteScanMatchingService
    private var hasPrimedLocalNetworkPermission = false

    init() {
        let cameraController = CameraSessionController()
        let rawAnalyzer = RawCardScanner(config: .init(
            cardDetection: .default,
            bottomRegionOCR: .default,
            debug: .disabled
        ))
        let rawRewritePipeline = RawPipeline()
        let slabAnalyzer = SlabScanner(config: .init(
            labelOCR: .default,
            debug: .disabled
        ))
        let ocrFeatureFlags = OCRPipelineFeatureFlags.current()
        let ocrPipeline = OCRPipelineCoordinator(
            rawAnalyzer: rawAnalyzer,
            rawRewritePipeline: rawRewritePipeline,
            slabAnalyzer: slabAnalyzer,
            featureFlags: ocrFeatureFlags
        )
        let remoteBaseURL = Self.resolveBackendBaseURL()
        let remoteMatcher = RemoteScanMatchingService(baseURL: remoteBaseURL)
        self.remoteMatcher = remoteMatcher
        let logStore = ScanEventStore()

        scannerViewModel = ScannerViewModel(
            cameraController: cameraController,
            ocrPipeline: ocrPipeline,
            matcher: remoteMatcher,
            logStore: logStore
        )

        print("🔍 [OCR] Pipeline route: \(ocrFeatureFlags.requestedRoute.rawValue)")
        let artifactRoot = ScanStageArtifactWriter.artifactRootPath() ?? "<unavailable>"
        print("🧪 [DEBUG] Scan artifact root: \(artifactRoot)")

        Task.detached(priority: .utility) {
            let cacheManager = ScanCacheManager()
            cacheManager.cleanup()
            print("✅ [APP] Cache cleanup completed")
        }

        if Self.boolEnv("SPOTLIGHT_CLEAR_SCAN_DEBUG_ON_LAUNCH") == true {
            Task.detached(priority: .utility) {
                let removedCount = ScanStageArtifactWriter.clearAllArtifacts()
                let rootPath = ScanStageArtifactWriter.artifactRootPath() ?? "<unavailable>"
                print("🧹 [DEBUG] Cleared \(removedCount) scan artifact director\(removedCount == 1 ? "y" : "ies") at \(rootPath)")
            }
        }
    }

    func primeLocalNetworkPermissionIfNeeded() {
        guard !hasPrimedLocalNetworkPermission else { return }
        hasPrimedLocalNetworkPermission = true

        Task(priority: .utility) { [remoteMatcher] in
            try? await Task.sleep(for: .milliseconds(600))
            await remoteMatcher.primeLocalNetworkPermissionIfNeeded()
        }
    }

    private static func resolveBackendBaseURL() -> URL {
        if let configuredValue = ProcessInfo.processInfo.environment["SPOTLIGHT_API_BASE_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           let configuredURL = url(from: configuredValue) {
            print("🔧 [APP] Using configured backend from SPOTLIGHT_API_BASE_URL")
            print("📡 [APP] Backend URL: \(configuredURL.absoluteString)")
            return configuredURL
        }

        let environment = infoPlistString(forKey: "SpotlightEnvironment", fallback: "local")
        let bundleURLString = infoPlistString(forKey: "SpotlightAPIBaseURL", fallback: "http://127.0.0.1:8788/")
        let deviceOverrideString = infoPlistString(forKey: "SpotlightDeviceAPIBaseURL")

        #if targetEnvironment(simulator)
        if let configuredURL = url(from: bundleURLString) {
            print("🔧 [APP] Using \(environment.uppercased()) backend (build config)")
            print("📡 [APP] Backend URL: \(configuredURL.absoluteString)")
            return configuredURL
        }
        #else
        if environment == "local",
           let deviceOverrideURL = url(from: deviceOverrideString) {
            print("🔧 [APP] Using LOCAL backend (device override)")
            print("📡 [APP] Backend URL: \(deviceOverrideURL.absoluteString)")
            return deviceOverrideURL
        }

        if let configuredURL = url(from: bundleURLString) {
            print("🔧 [APP] Using \(environment.uppercased()) backend (build config)")
            if environment == "local" {
                print("⚠️ [APP] Local device override is empty; using SpotlightAPIBaseURL directly")
            }
            print("📡 [APP] Backend URL: \(configuredURL.absoluteString)")
            return configuredURL
        }
        #endif

        let fallbackURL = URL(string: "http://127.0.0.1:8788/")!
        print("⚠️ [APP] Backend config missing or invalid; falling back to local default")
        print("📡 [APP] Backend URL: \(fallbackURL.absoluteString)")
        return fallbackURL
    }

    private static func infoPlistString(forKey key: String, fallback: String = "") -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            return fallback
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }

    private static func url(from value: String?) -> URL? {
        guard let value else {
            return nil
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        return URL(string: trimmed)
    }

    private static func boolEnv(_ key: String, processInfo: ProcessInfo = .processInfo) -> Bool? {
        guard let value = processInfo.environment[key] else {
            return nil
        }

        switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "1", "true", "yes", "on":
            return true
        case "0", "false", "no", "off":
            return false
        default:
            return nil
        }
    }
}
