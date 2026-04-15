import Foundation

struct DeckCardEntry: Identifiable, Codable, Hashable {
    let id: String
    let card: CardCandidate
    let slabContext: SlabContext?
    let condition: DeckCardCondition?
    let quantity: Int
    let addedAt: Date

    var primaryPrice: Double? {
        card.pricing?.primaryDisplayPrice
    }

    var totalEntryValue: Double? {
        guard let primaryPrice else {
            return nil
        }
        return primaryPrice * Double(quantity)
    }

    var searchIndexText: String {
        [
            card.name,
            card.setName,
            card.number,
            card.language,
            card.rarity,
            condition?.displayName,
            slabContext?.grader,
            slabContext?.grade,
            slabContext?.variantName
        ]
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: " ")
        .lowercased()
    }
}

@MainActor
final class CollectionStore: ObservableObject {
    @Published private(set) var entries: [DeckCardEntry] = []

    private let matcher: (any CardMatchingService)?
    private var backendEntriesByID: [String: DeckCardEntry] = [:]
    private var optimisticEntriesByID: [String: DeckCardEntry] = [:]

    init(
        matcher: (any CardMatchingService)? = nil,
        fileManager: FileManager = .default,
        baseDirectoryURL: URL? = nil
    ) {
        self.matcher = matcher
        Self.removeLegacyDeckJSONIfPresent(
            fileManager: fileManager,
            baseDirectoryURL: baseDirectoryURL
        )
    }

    var totalValue: Double {
        entries.compactMap(\.totalEntryValue).reduce(0, +)
    }

    var totalCardCount: Int {
        entries.reduce(0) { $0 + max(1, $1.quantity) }
    }

    func refreshFromBackend() async {
        guard let matcher else { return }

        let backendEntries: [DeckCardEntry] = await matcher.fetchDeckEntries().map { payload in
            let entryID = payload.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? Self.storageKey(cardID: payload.card.id, slabContext: payload.slabContext)
                : payload.id
            return DeckCardEntry(
                id: entryID,
                card: payload.card,
                slabContext: payload.slabContext,
                condition: payload.condition,
                quantity: max(1, payload.quantity),
                addedAt: payload.addedAt
            )
        }

        let backendMap = Dictionary(uniqueKeysWithValues: backendEntries.map { ($0.id, $0) })
        backendEntriesByID = backendMap
        optimisticEntriesByID = optimisticEntriesByID.filter { key, optimisticEntry in
            guard let backendEntry = backendMap[key] else {
                return true
            }
            return optimisticEntry.quantity > backendEntry.quantity
                || optimisticEntry.condition != backendEntry.condition
        }
        rebuildEntries()
    }

    func add(card: CardCandidate, slabContext: SlabContext?, condition: DeckCardCondition? = nil) -> Int {
        let key = Self.storageKey(cardID: card.id, slabContext: slabContext)
        let backendEntry = backendEntriesByID[key]
        let optimisticEntry = optimisticEntriesByID[key]
        let existingQuantity = max(backendEntry?.quantity ?? 0, optimisticEntry?.quantity ?? 0)
        let nextQuantity = max(1, existingQuantity + 1)
        optimisticEntriesByID[key] = DeckCardEntry(
            id: key,
            card: card,
            slabContext: slabContext,
            condition: condition ?? optimisticEntry?.condition ?? backendEntry?.condition,
            quantity: nextQuantity,
            addedAt: backendEntry?.addedAt ?? optimisticEntry?.addedAt ?? Date()
        )
        rebuildEntries()
        return nextQuantity
    }

    func contains(cardID: String, slabContext: SlabContext?) -> Bool {
        let key = Self.storageKey(cardID: cardID, slabContext: slabContext)
        return backendEntriesByID[key] != nil || optimisticEntriesByID[key] != nil
    }

    func contains(card: CardCandidate, slabContext: SlabContext?) -> Bool {
        contains(cardID: card.id, slabContext: slabContext)
    }

    func quantity(cardID: String, slabContext: SlabContext?) -> Int {
        let key = Self.storageKey(cardID: cardID, slabContext: slabContext)
        return max(backendEntriesByID[key]?.quantity ?? 0, optimisticEntriesByID[key]?.quantity ?? 0)
    }

    func quantity(card: CardCandidate, slabContext: SlabContext?) -> Int {
        quantity(cardID: card.id, slabContext: slabContext)
    }

    func entry(cardID: String, slabContext: SlabContext?) -> DeckCardEntry? {
        let key = Self.storageKey(cardID: cardID, slabContext: slabContext)
        return optimisticEntriesByID[key] ?? backendEntriesByID[key]
    }

    func entry(card: CardCandidate, slabContext: SlabContext?) -> DeckCardEntry? {
        entry(cardID: card.id, slabContext: slabContext)
    }

    func previewEntry(
        card: CardCandidate,
        slabContext: SlabContext?,
        quantityFallback: Int = 1
    ) -> DeckCardEntry {
        if let existingEntry = entry(card: card, slabContext: slabContext) {
            return existingEntry
        }

        return DeckCardEntry(
            id: Self.storageKey(cardID: card.id, slabContext: slabContext),
            card: card,
            slabContext: slabContext,
            condition: nil,
            quantity: max(1, quantityFallback),
            addedAt: Date()
        )
    }

    func condition(cardID: String, slabContext: SlabContext?) -> DeckCardCondition? {
        let key = Self.storageKey(cardID: cardID, slabContext: slabContext)
        return optimisticEntriesByID[key]?.condition ?? backendEntriesByID[key]?.condition
    }

    func condition(card: CardCandidate, slabContext: SlabContext?) -> DeckCardCondition? {
        condition(cardID: card.id, slabContext: slabContext)
    }

    @discardableResult
    func setCondition(
        card: CardCandidate,
        slabContext: SlabContext?,
        condition: DeckCardCondition
    ) -> (inserted: Bool, quantity: Int, pendingBackendCreate: Bool) {
        let key = Self.storageKey(cardID: card.id, slabContext: slabContext)
        let backendEntry = backendEntriesByID[key]
        let optimisticEntry = optimisticEntriesByID[key]
        let existingEntry = optimisticEntry ?? backendEntry
        let inserted = existingEntry == nil
        let quantity = max(1, existingEntry?.quantity ?? 1)
        optimisticEntriesByID[key] = DeckCardEntry(
            id: key,
            card: card,
            slabContext: slabContext,
            condition: condition,
            quantity: quantity,
            addedAt: existingEntry?.addedAt ?? Date()
        )
        rebuildEntries()
        return (inserted: inserted, quantity: quantity, pendingBackendCreate: backendEntry == nil)
    }

    func syncCondition(
        card: CardCandidate,
        slabContext: SlabContext?,
        condition: DeckCardCondition
    ) async {
        guard let matcher else { return }
        do {
            try await matcher.updateDeckEntryCondition(
                DeckEntryConditionUpdateRequestPayload(
                    cardID: card.id,
                    slabContext: slabContext,
                    condition: condition,
                    updatedAt: Date()
                )
            )
            await refreshFromBackend()
        } catch {
            // Keep the optimistic condition locally; refresh will reconcile once backend succeeds later.
        }
    }

    func searchResults(for query: String) -> [DeckCardEntry] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else {
            return entries
        }
        return entries.filter { $0.searchIndexText.contains(trimmed) }
    }

    private func rebuildEntries() {
        var merged = backendEntriesByID
        for (key, optimisticEntry) in optimisticEntriesByID {
            merged[key] = optimisticEntry
        }
        entries = merged.values.sorted { lhs, rhs in
            if lhs.addedAt == rhs.addedAt {
                return lhs.card.name.localizedCaseInsensitiveCompare(rhs.card.name) == .orderedAscending
            }
            return lhs.addedAt > rhs.addedAt
        }
    }

    private static func storageKey(cardID: String, slabContext: SlabContext?) -> String {
        guard let slabContext else {
            return "raw|\(cardID)"
        }

        let grader = slabContext.grader.trimmingCharacters(in: .whitespacesAndNewlines)
        let grade = (slabContext.grade ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let cert = (slabContext.certNumber ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let variant = (slabContext.variantName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return "slab|\(cardID)|\(grader)|\(grade)|\(cert)|\(variant)"
    }

    private static func removeLegacyDeckJSONIfPresent(
        fileManager: FileManager,
        baseDirectoryURL: URL?
    ) {
        let baseURL = baseDirectoryURL
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
        guard let baseURL else { return }

        let candidateDirectories = [
            baseURL.appendingPathComponent("Looty", isDirectory: true),
            baseURL.appendingPathComponent("Spotlight", isDirectory: true),
        ]
        for directoryURL in candidateDirectories {
            let legacyFileURL = directoryURL.appendingPathComponent("deck_collection.json")
            guard fileManager.fileExists(atPath: legacyFileURL.path) else { continue }
            try? fileManager.removeItem(at: legacyFileURL)
        }
    }
}

@MainActor
final class AppContainer: ObservableObject {
    let scannerViewModel: ScannerViewModel
    let collectionStore: CollectionStore
    private let remoteMatcher: RemoteScanMatchingService
    private var hasPrimedLocalNetworkPermission = false
    private var isPrimingLocalNetworkPermission = false

    init() {
        let cameraController = CameraSessionController()
        let rawRewritePipeline = RawPipeline()
        let slabAnalyzer = SlabScanner(config: .init(
            labelOCR: .default,
            debug: .disabled
        ))
        let ocrPipeline = OCRPipelineCoordinator(
            rawRewritePipeline: rawRewritePipeline,
            slabAnalyzer: slabAnalyzer
        )
        let remoteBaseURL = Self.resolveBackendBaseURL()
        let remoteMatcher = RemoteScanMatchingService(baseURL: remoteBaseURL)
        self.remoteMatcher = remoteMatcher
        let logStore = ScanEventStore()
        self.collectionStore = CollectionStore(matcher: remoteMatcher)
        let artifactUploadsEnabled = Self.shouldEnableScanArtifactUploads()

        scannerViewModel = ScannerViewModel(
            cameraController: cameraController,
            ocrPipeline: ocrPipeline,
            matcher: remoteMatcher,
            logStore: logStore,
            artifactUploadsEnabled: artifactUploadsEnabled
        )

        Task { [weak self] in
            guard let self else { return }
            await self.scannerViewModel.flushPendingBackendQueues()
            await self.collectionStore.refreshFromBackend()
        }

        print("🔍 [OCR] Pipeline route: raw_rewrite_live")
        let scanDebugEnabled = Self.shouldEnableScanDebugExports()
        ScanStageArtifactWriter.setDebugExportsEnabled(scanDebugEnabled)
        if scanDebugEnabled {
            let artifactRoot = ScanStageArtifactWriter.artifactRootPath() ?? "<unavailable>"
            print("🧪 [DEBUG] Scan artifact root: \(artifactRoot)")
        } else {
            print("🧪 [DEBUG] Scan artifact exports disabled for this build")
        }
        print("🗂️ [APP] Scan artifact uploads \(artifactUploadsEnabled ? "enabled" : "disabled") for this build")

        Task.detached(priority: .utility) {
            let cacheManager = ScanCacheManager()
            cacheManager.cleanup()
            print("✅ [APP] Cache cleanup completed")
        }

        if scanDebugEnabled, Self.boolEnv("SPOTLIGHT_CLEAR_SCAN_DEBUG_ON_LAUNCH") == true {
            Task.detached(priority: .utility) {
                let removedCount = ScanStageArtifactWriter.clearAllArtifacts()
                let rootPath = ScanStageArtifactWriter.artifactRootPath() ?? "<unavailable>"
                print("🧹 [DEBUG] Cleared \(removedCount) scan artifact director\(removedCount == 1 ? "y" : "ies") at \(rootPath)")
            }
        }
    }

    func refreshCollectionStoreFromBackend() {
        Task { [weak self] in
            await self?.collectionStore.refreshFromBackend()
        }
    }

    func primeLocalNetworkPermissionIfNeeded() {
        guard !hasPrimedLocalNetworkPermission, !isPrimingLocalNetworkPermission else { return }
        isPrimingLocalNetworkPermission = true

        Task(priority: .utility) { [weak self, remoteMatcher] in
            try? await Task.sleep(for: .milliseconds(600))
            let didPrime = await remoteMatcher.primeLocalNetworkPermissionIfNeeded()
            await MainActor.run {
                self?.isPrimingLocalNetworkPermission = false
                if didPrime {
                    self?.hasPrimedLocalNetworkPermission = true
                }
            }
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

    private static func infoPlistBool(forKey key: String, fallback: Bool) -> Bool {
        if let value = Bundle.main.object(forInfoDictionaryKey: key) as? Bool {
            return value
        }
        if let value = Bundle.main.object(forInfoDictionaryKey: key) as? String {
            switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "1", "true", "yes", "on":
                return true
            case "0", "false", "no", "off":
                return false
            default:
                return fallback
            }
        }
        return fallback
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

    private static func shouldEnableScanDebugExports() -> Bool {
        if let envOverride = boolEnv("SPOTLIGHT_ENABLE_SCAN_DEBUG_EXPORTS") {
            return envOverride
        }

        let environment = infoPlistString(forKey: "SpotlightEnvironment", fallback: "local")
        return environment == "local"
    }

    private static func shouldEnableScanArtifactUploads() -> Bool {
        if let envOverride = boolEnv("SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED") {
            return envOverride
        }
        return infoPlistBool(forKey: "SpotlightScanArtifactUploadsEnabled", fallback: false)
    }
}
