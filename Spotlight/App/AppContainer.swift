import Foundation

struct DeckCardEntry: Identifiable, Codable, Hashable {
    let id: String
    let card: CardCandidate
    let slabContext: SlabContext?
    let condition: DeckCardCondition?
    let quantity: Int
    let costBasisTotal: Double
    let costBasisCurrencyCode: String?
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

    var costBasisPerUnit: Double? {
        guard quantity > 0, costBasisTotal > 0 else {
            return nil
        }
        return costBasisTotal / Double(quantity)
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

struct PortfolioSaleBatchLineRequest: Hashable {
    let card: CardCandidate
    let slabContext: SlabContext?
    let quantity: Int
    let unitPrice: Double
    let currencyCode: String
    let paymentMethod: String?
    let soldAt: Date
    let showSessionID: String?
    let note: String?
    let sourceScanID: UUID?
}

@MainActor
final class CollectionStore: ObservableObject {
    @Published private(set) var entries: [DeckCardEntry] = []
    @Published private(set) var isLoadingEntries = false
    @Published private(set) var portfolioHistory: PortfolioHistory?
    @Published private(set) var selectedPortfolioHistoryRange: PortfolioHistoryRange = .days30
    @Published private(set) var isLoadingPortfolioHistory = false
    @Published private(set) var portfolioLedger: PortfolioLedger?
    @Published private(set) var selectedPortfolioLedgerRange: PortfolioHistoryRange = .days30
    @Published private(set) var isLoadingPortfolioLedger = false

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
        entries.reduce(0) { $0 + max(0, $1.quantity) }
    }

    var totalCostBasis: Double {
        entries.reduce(0) { $0 + max(0, $1.costBasisTotal) }
    }

    func refreshFromBackend() async {
        guard let matcher else { return }
        isLoadingEntries = true
        defer { isLoadingEntries = false }

        guard let payloads = await matcher.fetchDeckEntries() else {
            return
        }

        let backendEntries: [DeckCardEntry] = payloads.compactMap { payload in
            let entryID = payload.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? Self.storageKey(cardID: payload.card.id, slabContext: payload.slabContext)
                : payload.id
            let quantity = max(0, payload.quantity)
            guard quantity > 0 else {
                return nil
            }
            return DeckCardEntry(
                id: entryID,
                card: payload.card,
                slabContext: payload.slabContext,
                condition: payload.condition,
                quantity: quantity,
                costBasisTotal: payload.costBasisTotal,
                costBasisCurrencyCode: payload.costBasisCurrencyCode,
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

    func refreshPortfolioHistory(range: PortfolioHistoryRange? = nil) async {
        guard let matcher else { return }
        let targetRange = range ?? selectedPortfolioHistoryRange
        selectedPortfolioHistoryRange = targetRange
        isLoadingPortfolioHistory = true
        defer { isLoadingPortfolioHistory = false }
        if let history = await matcher.fetchPortfolioHistory(range: targetRange) {
            portfolioHistory = history
        }
    }

    func refreshPortfolioLedger(range: PortfolioHistoryRange? = nil) async {
        guard let matcher else { return }
        let targetRange = range ?? selectedPortfolioLedgerRange
        selectedPortfolioLedgerRange = targetRange
        isLoadingPortfolioLedger = true
        defer { isLoadingPortfolioLedger = false }
        if let ledger = await matcher.fetchPortfolioLedger(range: targetRange) {
            portfolioLedger = ledger
        }
    }

    func refreshDashboardData() async {
        async let entriesRefresh: Void = refreshFromBackend()
        async let historyRefresh: Void = refreshPortfolioHistory()
        async let ledgerRefresh: Void = refreshPortfolioLedger()
        _ = await (entriesRefresh, historyRefresh, ledgerRefresh)
    }

    func refreshPortfolioData() async {
        async let entriesRefresh: Void = refreshFromBackend()
        async let historyRefresh: Void = refreshPortfolioHistory()
        _ = await (entriesRefresh, historyRefresh)
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
            costBasisTotal: optimisticEntry?.costBasisTotal ?? backendEntry?.costBasisTotal ?? 0,
            costBasisCurrencyCode: optimisticEntry?.costBasisCurrencyCode ?? backendEntry?.costBasisCurrencyCode,
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
            costBasisTotal: 0,
            costBasisCurrencyCode: card.pricing?.currencyCode,
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

    func purchasePrice(cardID: String, slabContext: SlabContext?) -> Double? {
        let key = Self.storageKey(cardID: cardID, slabContext: slabContext)
        return optimisticEntriesByID[key]?.costBasisPerUnit ?? backendEntriesByID[key]?.costBasisPerUnit
    }

    func purchasePrice(card: CardCandidate, slabContext: SlabContext?) -> Double? {
        purchasePrice(cardID: card.id, slabContext: slabContext)
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
            costBasisTotal: existingEntry?.costBasisTotal ?? 0,
            costBasisCurrencyCode: existingEntry?.costBasisCurrencyCode,
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

    func setPurchasePrice(
        card: CardCandidate,
        slabContext: SlabContext?,
        unitPrice: Double,
        currencyCode: String = "USD"
    ) {
        let key = Self.storageKey(cardID: card.id, slabContext: slabContext)
        guard let existingEntry = optimisticEntriesByID[key] ?? backendEntriesByID[key] else {
            return
        }

        let quantity = max(1, existingEntry.quantity)
        optimisticEntriesByID[key] = DeckCardEntry(
            id: key,
            card: card,
            slabContext: slabContext,
            condition: existingEntry.condition,
            quantity: quantity,
            costBasisTotal: round(unitPrice * Double(quantity) * 100) / 100,
            costBasisCurrencyCode: currencyCode,
            addedAt: existingEntry.addedAt
        )
        rebuildEntries()
    }

    func syncPurchasePrice(
        card: CardCandidate,
        slabContext: SlabContext?,
        unitPrice: Double,
        currencyCode: String = "USD"
    ) async {
        guard let matcher else { return }
        do {
            try await matcher.updateDeckEntryPurchasePrice(
                DeckEntryPurchasePriceUpdateRequestPayload(
                    cardID: card.id,
                    slabContext: slabContext,
                    unitPrice: unitPrice,
                    currencyCode: currencyCode,
                    updatedAt: Date()
                )
            )
            await refreshFromBackend()
        } catch {
            // Keep the optimistic purchase price locally; refresh will reconcile once backend succeeds later.
        }
    }

    func recordSale(
        card: CardCandidate,
        slabContext: SlabContext?,
        quantity: Int,
        unitPrice: Double,
        currencyCode: String = "USD",
        paymentMethod: String?,
        soldAt: Date,
        showSessionID: String?,
        note: String?,
        sourceScanID: UUID? = nil
    ) async throws -> PortfolioSaleCreateResponsePayload {
        guard let matcher else {
            throw MatcherError.server(message: "Sale service unavailable.")
        }
        let payload = PortfolioSaleCreateRequestPayload(
            cardID: card.id,
            slabContext: slabContext,
            quantity: max(1, quantity),
            unitPrice: unitPrice,
            currencyCode: currencyCode,
            paymentMethod: paymentMethod,
            soldAt: soldAt,
            showSessionID: showSessionID,
            note: note,
            sourceScanID: sourceScanID
        )
        let response = try await matcher.createPortfolioSale(payload)
        applySaleResponse(
            response,
            fallbackCard: card,
            fallbackSlabContext: slabContext
        )
        await refreshDashboardData()
        return response
    }

    func recordSalesBatch(
        _ lines: [PortfolioSaleBatchLineRequest]
    ) async throws -> [PortfolioSaleCreateResponsePayload] {
        guard let matcher else {
            throw MatcherError.server(message: "Sale service unavailable.")
        }

        var responses: [PortfolioSaleCreateResponsePayload] = []
        responses.reserveCapacity(lines.count)

        for line in lines {
            let payload = PortfolioSaleCreateRequestPayload(
                cardID: line.card.id,
                slabContext: line.slabContext,
                quantity: max(1, line.quantity),
                unitPrice: line.unitPrice,
                currencyCode: line.currencyCode,
                paymentMethod: line.paymentMethod,
                soldAt: line.soldAt,
                showSessionID: line.showSessionID,
                note: line.note,
                sourceScanID: line.sourceScanID
            )
            let response = try await matcher.createPortfolioSale(payload)
            applySaleResponse(
                response,
                fallbackCard: line.card,
                fallbackSlabContext: line.slabContext
            )
            responses.append(response)
        }

        await refreshDashboardData()
        return responses
    }

    func recordBuy(
        card: CardCandidate,
        slabContext: SlabContext?,
        condition: DeckCardCondition?,
        quantity: Int,
        unitPrice: Double,
        currencyCode: String = "USD",
        paymentMethod: String?,
        boughtAt: Date,
        sourceScanID: UUID? = nil
    ) async throws -> PortfolioBuyCreateResponsePayload {
        guard let matcher else {
            throw MatcherError.server(message: "Buy service unavailable.")
        }
        let payload = PortfolioBuyCreateRequestPayload(
            cardID: card.id,
            slabContext: slabContext,
            condition: condition,
            quantity: max(1, quantity),
            unitPrice: unitPrice,
            currencyCode: currencyCode,
            paymentMethod: paymentMethod,
            boughtAt: boughtAt,
            sourceScanID: sourceScanID
        )
        let response = try await matcher.createPortfolioBuy(payload)
        await refreshDashboardData()
        return response
    }

    func updatePortfolioBuyTransactionPrice(
        transactionID: String,
        unitPrice: Double,
        currencyCode: String = "USD"
    ) async throws {
        guard let matcher else {
            throw MatcherError.server(message: "Buy service unavailable.")
        }
        try await matcher.updatePortfolioBuyPrice(
            transactionID: transactionID,
            payload: PortfolioTransactionPriceUpdateRequestPayload(
                unitPrice: unitPrice,
                currencyCode: currencyCode,
                updatedAt: Date()
            )
        )
        await refreshDashboardData()
    }

    func updatePortfolioSaleTransactionPrice(
        transactionID: String,
        unitPrice: Double,
        currencyCode: String = "USD"
    ) async throws {
        guard let matcher else {
            throw MatcherError.server(message: "Sale service unavailable.")
        }
        try await matcher.updatePortfolioSalePrice(
            transactionID: transactionID,
            payload: PortfolioTransactionPriceUpdateRequestPayload(
                unitPrice: unitPrice,
                currencyCode: currencyCode,
                updatedAt: Date()
            )
        )
        await refreshDashboardData()
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

    private func applySaleResponse(
        _ response: PortfolioSaleCreateResponsePayload,
        fallbackCard: CardCandidate,
        fallbackSlabContext: SlabContext?
    ) {
        let normalizedDeckEntryID = response.deckEntryID.trimmingCharacters(in: .whitespacesAndNewlines)
        let entryID = normalizedDeckEntryID.isEmpty
            ? Self.storageKey(cardID: fallbackCard.id, slabContext: fallbackSlabContext)
            : normalizedDeckEntryID

        let remainingQuantity = max(0, response.remainingQuantity)
        guard let existingEntry = optimisticEntriesByID[entryID] ?? backendEntriesByID[entryID] else {
            if remainingQuantity <= 0 {
                optimisticEntriesByID.removeValue(forKey: entryID)
                backendEntriesByID.removeValue(forKey: entryID)
                rebuildEntries()
            }
            return
        }

        if remainingQuantity <= 0 {
            optimisticEntriesByID.removeValue(forKey: entryID)
            backendEntriesByID.removeValue(forKey: entryID)
        } else {
            let updatedCostBasisTotal: Double
            if let costBasisPerUnit = existingEntry.costBasisPerUnit {
                updatedCostBasisTotal = round(costBasisPerUnit * Double(remainingQuantity) * 100) / 100
            } else {
                updatedCostBasisTotal = 0
            }

            let updatedEntry = DeckCardEntry(
                id: entryID,
                card: existingEntry.card,
                slabContext: existingEntry.slabContext,
                condition: existingEntry.condition,
                quantity: remainingQuantity,
                costBasisTotal: updatedCostBasisTotal,
                costBasisCurrencyCode: existingEntry.costBasisCurrencyCode,
                addedAt: existingEntry.addedAt
            )
            optimisticEntriesByID[entryID] = updatedEntry
            backendEntriesByID[entryID] = updatedEntry
        }

        rebuildEntries()
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
    enum CollectionRefreshScope {
        case entries
        case dashboard
    }

    let scannerViewModel: ScannerViewModel
    let collectionStore: CollectionStore
    private let remoteMatcher: RemoteScanMatchingService
    private var hasPrimedLocalNetworkPermission = false
    private var isPrimingLocalNetworkPermission = false
    private var localNetworkPrimingTask: Task<Void, Never>?
    private var activeCollectionRefreshScope: CollectionRefreshScope?
    private var pendingCollectionRefreshScope: CollectionRefreshScope?
    private var lastCompletedCollectionRefreshAt: Date?
    private var hasStartedInitialCollectionLoad = false

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

    func refreshCollectionStoreFromBackend(
        scope: CollectionRefreshScope = .dashboard,
        minimumInterval: TimeInterval = 0
    ) {
        let now = Date()
        if minimumInterval > 0,
           let lastCompletedCollectionRefreshAt,
           now.timeIntervalSince(lastCompletedCollectionRefreshAt) < minimumInterval {
            return
        }

        if let activeCollectionRefreshScope {
            let highestQueuedScope = Self.mergedCollectionRefreshScope(
                activeCollectionRefreshScope,
                pendingCollectionRefreshScope
            ) ?? activeCollectionRefreshScope
            if Self.collectionRefreshScope(highestQueuedScope, covers: scope) {
                return
            }
            pendingCollectionRefreshScope = Self.mergedCollectionRefreshScope(
                pendingCollectionRefreshScope,
                scope
            )
            return
        }

        activeCollectionRefreshScope = scope
        Task { [weak self] in
            guard let self else { return }
            await self.performCollectionRefresh(scope: scope)
            await MainActor.run {
                self.lastCompletedCollectionRefreshAt = Date()
                self.activeCollectionRefreshScope = nil

                guard let pendingScope = self.pendingCollectionRefreshScope else {
                    return
                }
                self.pendingCollectionRefreshScope = nil
                self.refreshCollectionStoreFromBackend(scope: pendingScope)
            }
        }
    }

    func beginInitialCollectionLoadIfNeeded() {
        guard !hasStartedInitialCollectionLoad else { return }
        hasStartedInitialCollectionLoad = true
        refreshCollectionStoreAfterWarmup(scope: .entries)
    }

    func handleAppDidBecomeActive() {
        refreshCollectionStoreAfterWarmup(scope: .entries, minimumInterval: 15)
    }

    func refreshCollectionStoreAfterWarmup(
        scope: CollectionRefreshScope = .entries,
        minimumInterval: TimeInterval = 0
    ) {
        Task { [weak self] in
            guard let self else { return }
            await self.ensureLocalNetworkPermissionPrimedIfNeeded()
            await MainActor.run {
                self.refreshCollectionStoreFromBackend(
                    scope: scope,
                    minimumInterval: minimumInterval
                )
            }
        }
    }

    func primeLocalNetworkPermissionIfNeeded() {
        Task { [weak self] in
            await self?.ensureLocalNetworkPermissionPrimedIfNeeded()
        }
    }

    private func ensureLocalNetworkPermissionPrimedIfNeeded() async {
        if hasPrimedLocalNetworkPermission {
            return
        }

        if let localNetworkPrimingTask {
            await localNetworkPrimingTask.value
            return
        }

        isPrimingLocalNetworkPermission = true
        let task = Task(priority: .utility) { [weak self, remoteMatcher] in
            let didPrime = await remoteMatcher.primeLocalNetworkPermissionIfNeeded()
            await MainActor.run {
                self?.isPrimingLocalNetworkPermission = false
                self?.localNetworkPrimingTask = nil
                if didPrime {
                    self?.hasPrimedLocalNetworkPermission = true
                }
            }
        }
        localNetworkPrimingTask = task
        await task.value
    }

    private func performCollectionRefresh(scope: CollectionRefreshScope) async {
        switch scope {
        case .entries:
            await collectionStore.refreshFromBackend()
        case .dashboard:
            await collectionStore.refreshDashboardData()
        }
    }

    private static func mergedCollectionRefreshScope(
        _ lhs: CollectionRefreshScope?,
        _ rhs: CollectionRefreshScope?
    ) -> CollectionRefreshScope? {
        switch (lhs, rhs) {
        case (.dashboard, _), (_, .dashboard):
            return .dashboard
        case (.entries, .entries):
            return .entries
        case let (value?, nil), let (nil, value?):
            return value
        case (nil, nil):
            return nil
        }
    }

    private static func collectionRefreshScope(
        _ scope: CollectionRefreshScope,
        covers requestedScope: CollectionRefreshScope
    ) -> Bool {
        switch (scope, requestedScope) {
        case (.dashboard, _), (.entries, .entries):
            return true
        case (.entries, .dashboard):
            return false
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
