import Foundation
import SwiftUI
import UIKit

@MainActor
final class ScannerViewModel: ObservableObject {
    @Published var route: ScannerRoute = .scanner
    @Published var isProcessing = false
    @Published var errorMessage: String?
    @Published var bannerMessage: String?
    @Published var analyzedCapture: AnalyzedCapture?
    @Published var matchResponse: ScanMatchResponse?
    @Published var searchQuery = ""
    @Published var searchResults: [CardCandidate] = []
    @Published var scannedItems: [LiveScanStackItem] = []
    @Published var scannerPresentationMode: ScannerPresentationMode = .raw

    let cameraController: CameraSessionController

    private let analyzer: RawCardScanner
    private let matcher: CardMatchingService
    private let logStore: ScanEventStore
    private let identifierLookupService: IdentifierLookupService
    private let scanCacheManager: ScanCacheManager
    private var currentScanID: UUID?
    private var currentPendingItemID: UUID?
    private var idlePricingRefreshTask: Task<Void, Never>?

    private var selectedResolverMode: ResolverMode {
        scannerPresentationMode == .slab ? .psaSlab : .rawCard
    }

    init(
        cameraController: CameraSessionController,
        analyzer: RawCardScanner,
        matcher: CardMatchingService,
        logStore: ScanEventStore,
        identifierLookupService: IdentifierLookupService,
        scanCacheManager: ScanCacheManager
    ) {
        self.cameraController = cameraController
        self.analyzer = analyzer
        self.matcher = matcher
        self.logStore = logStore
        self.identifierLookupService = identifierLookupService
        self.scanCacheManager = scanCacheManager

        self.cameraController.onImageCaptured = { [weak self] image in
            self?.processImportedPhoto(image)
        }
    }

    var stackCountText: String {
        trayMetrics.countLabel
    }

    var trayMetrics: ScanTrayMetrics {
        ScanTrayCalculator.metrics(for: scannedItems.map(\.metricInput))
    }

    var totalValueText: String {
        trayMetrics.totalLabel
    }

    var usingLocalFallback: Bool {
        scannedItems.contains(where: { $0.matcherSource == .localPrototype })
    }

    func startScannerSession() {
        cameraController.requestAccessIfNeeded()
        cameraController.startSession()
    }

    func stopScannerSession() {
        cameraController.stopSession()
        idlePricingRefreshTask?.cancel()
    }

    func capturePhoto(reticleRect: CGRect) {
        guard !isProcessing else { return }
        errorMessage = nil
        cameraController.capturePhoto(reticleRect: reticleRect)
    }

    func toggleTorch() {
        cameraController.toggleTorch()
    }

    func processImportedPhoto(_ image: UIImage) {
        guard !isProcessing else { return }
        Task {
            await handleScannedImage(image)
        }
    }

    func acceptBestMatch() {
        guard let bestMatch = matchResponse?.bestMatch else { return }
        completeSelection(with: bestMatch, correctionType: .acceptedTop)
    }

    func showAlternatives() {
        route = .alternatives
        if searchQuery.isEmpty {
            searchQuery = analyzedCapture?.collectorNumber ?? matchResponse?.bestMatch?.name ?? ""
        }
        refreshSearchResults()
    }

    func dismissAlternatives() {
        Task {
            await abandonPendingScanIfNeeded()
        }
    }

    func selectCandidate(_ candidate: CardCandidate, correctionType override: CorrectionType? = nil) {
        let correctionType = override
            ?? (candidate.id == matchResponse?.bestMatch?.id ? .acceptedTop : .choseAlternative)
        completeSelection(with: candidate, correctionType: correctionType)
    }

    func updateSearchQuery(_ query: String) {
        searchQuery = query
        refreshSearchResults()
    }

    func toggleExpansion(for itemID: UUID) {
        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
            for index in scannedItems.indices {
                if scannedItems[index].id == itemID {
                    scannedItems[index].isExpanded.toggle()
                } else if scannedItems[index].isExpanded {
                    scannedItems[index].isExpanded = false
                }
            }
        }
    }

    func removeStackItem(_ itemID: UUID) {
        withAnimation(.spring(response: 0.28, dampingFraction: 0.9)) {
            scannedItems.removeAll { $0.id == itemID }
        }
    }

    func clearScans() {
        idlePricingRefreshTask?.cancel()
        withAnimation(.spring(response: 0.28, dampingFraction: 0.9)) {
            scannedItems.removeAll()
        }
    }

    func refreshPricing(for itemID: UUID) {
        guard let item = scannedItems.first(where: { $0.id == itemID }),
              let cardID = item.displayCard?.id else { return }
        idlePricingRefreshTask?.cancel()

        Task {
            await refreshPricing(for: itemID, cardID: cardID, initiatedByUser: true)
        }
    }

    private func refreshSearchResults() {
        Task {
            let query = searchQuery
            let results = await matcher.search(query: query)
            await MainActor.run {
                self.searchResults = results
            }
        }
    }

    private func handleScannedImage(_ image: UIImage) async {
        print("🔍 [SCAN] Starting handleScannedImage")
        errorMessage = nil
        route = .scanner

        // Balance OCR quality vs memory usage
        // 1200px = 50% larger than old 800px, but won't crash like 2400px did
        let processedImage = downscaleImage(image, maxDimension: 1200)
        print("🔍 [SCAN] Downscaled image from \(image.size) to \(processedImage.size)")

        let scanID = UUID()
        currentScanID = scanID
        let pendingItemID = enqueuePendingScan(scanID: scanID, previewImage: processedImage)
        currentPendingItemID = pendingItemID
        isProcessing = true

        do {
            print("🔍 [SCAN] Starting Vision analysis...")
            let analysisStarted = Date().timeIntervalSinceReferenceDate

            // Add timeout to prevent indefinite hanging on complex images
            let analysis = try await withThrowingTaskGroup(of: AnalyzedCapture.self) { group in
                group.addTask {
                    try await self.analyzer.analyze(
                        scanID: scanID,
                        image: processedImage,
                        resolverModeHint: self.selectedResolverMode
                    )
                }

                group.addTask {
                    try await Task.sleep(for: .seconds(30))
                    throw NSError(domain: "ScanTimeout", code: -1,
                                 userInfo: [NSLocalizedDescriptionKey: "Card analysis took too long - try removing from case or reducing glare"])
                }

                // Return first successful result (analyzer) or first error (timeout)
                let result = try await group.next()!
                group.cancelAll()
                return result
            }

            let analysisMs = (Date().timeIntervalSinceReferenceDate - analysisStarted) * 1000
            print("✅ [SCAN] Vision analysis completed in \(analysisMs)ms")
            print("🔍 [SCAN] Trying hybrid identification (local first)...")

            let performance = ScanPerformanceMetrics(
                analysisMs: analysisMs,
                matchMs: 0,  // Will be updated if backend is used
                totalMs: analysisMs
            )

            // Try hybrid flow: local identifier lookup first, then backend
            await tryHybridIdentification(
                analysis: analysis,
                scanID: scanID,
                pendingItemID: pendingItemID,
                previewImage: processedImage,
                performance: performance
            )
        } catch {
            print("❌ [SCAN] Error: \(error.localizedDescription)")
            errorMessage = error.localizedDescription
            markPendingScanFailed(itemID: pendingItemID, message: "Could not identify card")
            resetPendingScanState()
        }

        print("🔍 [SCAN] Finished handleScannedImage")
        isProcessing = false
    }

    private func completeSelection(with candidate: CardCandidate, correctionType: CorrectionType) {
        guard let scanID = currentScanID,
              let itemID = currentPendingItemID else { return }

        let wasTopPrediction = candidate.id == matchResponse?.bestMatch?.id

        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
            for index in scannedItems.indices {
                scannedItems[index].isExpanded = false
            }
            updateStackItem(id: itemID) { item in
                item.phase = .resolved
                item.card = candidate
                item.detail = nil
                // Keep existing thumbnail, don't replace with full-res
                item.isExpanded = false
                item.isRefreshingPrice = false
                item.statusMessage = ScanTrayCalculator.initialStatusMessage(for: candidate.pricing)
                item.slabContext = matchResponse?.slabContext
                item.pricingContextNote = pricingContextNote(
                    for: matchResponse?.resolverMode ?? .unknownFallback,
                    matcherSource: matchResponse?.matcherSource ?? .remoteHybrid,
                    slabContext: matchResponse?.slabContext,
                    pricing: candidate.pricing
                )
            }
        }

        scheduleIdlePricingRefresh(for: itemID, cardID: candidate.id)
        resetPendingScanState()
        route = .scanner
        showBanner("Added \(candidate.name)")

        Task {
            await matcher.submitFeedback(
                scanID: scanID,
                selectedCardID: candidate.id,
                wasTopPrediction: wasTopPrediction,
                correctionType: correctionType
            )
            await self.logStore.logSelection(
                scanID: scanID,
                selectedCardID: candidate.id,
                wasTopPrediction: wasTopPrediction,
                correctionType: correctionType
            )
        }
    }

    private func abandonPendingScanIfNeeded() async {
        guard let scanID = currentScanID,
              let pendingItemID = currentPendingItemID else {
            route = .scanner
            return
        }

        await matcher.submitFeedback(
            scanID: scanID,
            selectedCardID: nil,
            wasTopPrediction: false,
            correctionType: .abandoned
        )
        await logStore.logSelection(
            scanID: scanID,
            selectedCardID: nil,
            wasTopPrediction: false,
            correctionType: .abandoned
        )

        removeStackItem(pendingItemID)
        resetPendingScanState()
        route = .scanner
    }

    private func resetPendingScanState() {
        currentScanID = nil
        currentPendingItemID = nil
        analyzedCapture = nil
        matchResponse = nil
        searchQuery = ""
        searchResults = []
        errorMessage = nil
    }

    private func updateStackItem(id itemID: UUID, mutate: (inout LiveScanStackItem) -> Void) {
        guard let index = scannedItems.firstIndex(where: { $0.id == itemID }) else { return }
        mutate(&scannedItems[index])
    }

    private func refreshPricing(for itemID: UUID, cardID: String, initiatedByUser: Bool) async {
        guard scannedItems.contains(where: { $0.id == itemID }) else { return }

        let previousPricing = scannedItems.first(where: { $0.id == itemID })?.pricing
        let slabContext = scannedItems.first(where: { $0.id == itemID })?.slabContext

        await MainActor.run {
            self.updateStackItem(id: itemID) { item in
                item.isRefreshingPrice = true
                item.statusMessage = initiatedByUser ? "Refreshing live price…" : "Checking for fresher pricing…"
            }
        }

        do {
            let refreshedDetail = try await matcher.refreshCardDetail(
                cardID: cardID,
                slabContext: slabContext,
                forceRefresh: initiatedByUser
            )
            await MainActor.run {
                if let refreshedDetail {
                    self.updateStackItem(id: itemID) { item in
                        item.detail = refreshedDetail
                        item.card = refreshedDetail.card
                        item.slabContext = refreshedDetail.slabContext ?? item.slabContext
                        item.statusMessage = refreshedDetail.pricing?.freshnessLabel ?? "Price snapshot unavailable"
                        item.isRefreshingPrice = false
                        item.pricingContextNote = self.pricingContextNote(
                            for: item.resolverMode,
                            matcherSource: item.matcherSource,
                            slabContext: item.slabContext,
                            pricing: refreshedDetail.pricing
                        )
                    }

                    if initiatedByUser && previousPricing != refreshedDetail.pricing {
                        self.showBanner("Updated \(refreshedDetail.card.name) pricing")
                    }
                } else {
                    self.updateStackItem(id: itemID) { item in
                        item.statusMessage = item.pricing?.freshnessLabel ?? "Pricing unavailable"
                        item.isRefreshingPrice = false
                    }

                    if initiatedByUser {
                        self.showBanner("Pricing refresh unavailable")
                    }
                }
            }
        } catch {
            await MainActor.run {
                self.updateStackItem(id: itemID) { item in
                    item.statusMessage = item.pricing?.freshnessLabel ?? "Pricing unavailable"
                    item.isRefreshingPrice = false
                }

                if initiatedByUser {
                    self.showBanner("Pricing refresh failed")
                }
            }
        }
    }

    private func scheduleIdlePricingRefresh(for itemID: UUID, cardID: String) {
        idlePricingRefreshTask?.cancel()

        let shouldRefresh = scannedItems.first(where: { $0.id == itemID }).map(shouldAutoRefresh) ?? true
        guard shouldRefresh else { return }

        idlePricingRefreshTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1.8))
            guard let self, !Task.isCancelled else { return }
            guard self.scannedItems.contains(where: { $0.id == itemID }) else { return }
            await self.refreshPricing(for: itemID, cardID: cardID, initiatedByUser: false)
        }
    }

    private func shouldAutoRefresh(_ item: LiveScanStackItem) -> Bool {
        guard item.phase == .resolved else { return false }
        return ScanTrayCalculator.shouldAutoRefresh(pricing: item.pricing)
    }

    private func shouldAutoAccept(_ response: ScanMatchResponse) -> Bool {
        switch response.confidence {
        case .high:
            return true
        case .medium:
            return response.resolverPath == .directLookup || response.resolverPath == .psaLabel
        case .low:
            return false
        }
    }

    private func showBanner(_ message: String) {
        bannerMessage = message

        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            if self?.bannerMessage == message {
                self?.bannerMessage = nil
            }
        }
    }

    private func enqueuePendingScan(scanID: UUID, previewImage: UIImage) -> UUID {
        let itemID = UUID()

        // Downscale preview to save memory (max 300px)
        let thumbnail = downscaleImage(previewImage, maxDimension: 300)

        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
            for index in scannedItems.indices {
                scannedItems[index].isExpanded = false
            }

            // Limit scan stack to 20 items max to prevent memory bloat
            if scannedItems.count >= 20 {
                scannedItems.removeLast()
            }

            scannedItems.insert(
                LiveScanStackItem(
                    id: itemID,
                    scanID: scanID,
                    phase: .pending,
                    card: nil,
                    detail: nil,
                    previewImage: thumbnail,
                    confidence: .medium,
                    matcherSource: .remoteHybrid,
                    matcherVersion: "pending",
                    resolverMode: .unknownFallback,
                    resolverPath: nil,
                    slabContext: nil,
                    reviewDisposition: .ready,
                    reviewReason: nil,
                    addedAt: Date(),
                    isExpanded: false,
                    isRefreshingPrice: false,
                    statusMessage: "Identifying card…",
                    pricingContextNote: nil,
                    performance: nil
                ),
                at: 0
            )
        }

        return itemID
    }

    private func downscaleImage(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
        let size = image.size
        let longestSide = max(size.width, size.height)

        if longestSide <= maxDimension {
            return image
        }

        let scale = maxDimension / longestSide
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        if #available(iOS 12.0, *) {
            format.preferredRange = .standard
        }

        let renderer = UIGraphicsImageRenderer(size: newSize, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
    }

    private func applyAnalysis(_ analysis: AnalyzedCapture, response: ScanMatchResponse, to itemID: UUID) {
        updateStackItem(id: itemID) { item in
            // Keep existing thumbnail, don't replace with full-res image
            item.confidence = response.confidence
            item.matcherSource = response.matcherSource
            item.matcherVersion = response.matcherVersion
            item.resolverMode = response.resolverMode
            item.resolverPath = response.resolverPath
            item.slabContext = response.slabContext
            item.reviewDisposition = response.reviewDisposition ?? .ready
            item.reviewReason = response.reviewReason
        }
    }

    private func markPendingScanFailed(itemID: UUID, message: String) {
        updateStackItem(id: itemID) { item in
            item.phase = .failed
            item.statusMessage = message
            item.isRefreshingPrice = false
        }
    }

    private func pricingContextNote(
        for resolverMode: ResolverMode,
        matcherSource: MatcherSource,
        slabContext: SlabContext?,
        pricing: CardPricingSummary?
    ) -> String? {
        if matcherSource == .localPrototype {
            if pricing == nil {
                return "Local fallback mode. Start the backend for full catalog pricing."
            }
            return "Local fallback snapshot"
        }

        switch resolverMode {
        case .psaSlab:
            if pricing?.pricingMode == "psa_grade_estimate" {
                if let grader = slabContext?.grader ?? pricing?.grader,
                   let grade = slabContext?.grade ?? pricing?.grade,
                   let tier = pricing?.pricingTierLabel {
                return "\(grader) \(grade) • \(tier)"
                }
                return "Grade-specific slab estimate"
            }
            return "Slab detected. Price unavailable from provider."
        case .rawCard, .unknownFallback:
            return nil
        }
    }

    // MARK: - Hybrid Offline/Online Flow

    /// Try local identifier lookup first, fall back to backend if not found
    ///
    /// Flow:
    /// 1. Check if collector number exists in local identifier map
    /// 2. If unique match: Show card immediately, fetch pricing separately
    /// 3. If ambiguous: Let backend disambiguate using full analysis
    /// 4. If not found: Full backend scan with image
    private func tryHybridIdentification(
        analysis: AnalyzedCapture,
        scanID: UUID,
        pendingItemID: UUID,
        previewImage: UIImage,
        performance: ScanPerformanceMetrics
    ) async {
        if analysis.resolverModeHint == .psaSlab {
            print("🔍 [HYBRID] Slab mode selected - skipping local raw identifier lookup")
            await fallbackToBackendMatch(
                analysis: analysis,
                scanID: scanID,
                pendingItemID: pendingItemID,
                performance: performance
            )
            return
        }

        // Try local identifier lookup first
        let collectorNumber = analysis.collectorNumber ?? ""

        guard !collectorNumber.isEmpty else {
            // No collector number - fall back to backend
            await fallbackToBackendMatch(
                analysis: analysis,
                scanID: scanID,
                pendingItemID: pendingItemID,
                performance: performance
            )
            return
        }

        let lookupResult = identifierLookupService.lookup(
            collectorNumber,
            setHintTokens: analysis.setHintTokens
        )

        switch lookupResult {
        case .unique(let cardIdentifier):
            print("✅ [HYBRID] Found unique local match: \(cardIdentifier.name)")
            // Show card immediately from local data
            let localCandidate = createCandidateFromIdentifier(cardIdentifier)
            await showLocallyIdentifiedCard(
                candidate: localCandidate,
                scanID: scanID,
                pendingItemID: pendingItemID,
                performance: performance
            )

            // Try to fetch pricing from backend in background
            await fetchPricingForLocalCard(cardID: cardIdentifier.id, itemID: pendingItemID)

        case .ambiguous(let candidates):
            print("⚠️ [HYBRID] Ambiguous local match (\(candidates.count) candidates) - using backend to disambiguate")
            await primeBackendCatalog(for: candidates)
            // Multiple cards with same number - let backend disambiguate
            await fallbackToBackendMatch(
                analysis: analysis,
                scanID: scanID,
                pendingItemID: pendingItemID,
                performance: performance
            )

        case .notFound:
            print("⚠️ [HYBRID] Not found in local map - falling back to backend")
            // Not in local map - fall back to full backend scan
            await fallbackToBackendMatch(
                analysis: analysis,
                scanID: scanID,
                pendingItemID: pendingItemID,
                performance: performance
            )
        }
    }

    private func primeBackendCatalog(for candidates: [CardIdentifier]) async {
        let cardIDs = Array(Set(candidates.map(\.id))).sorted()
        guard !cardIDs.isEmpty else { return }

        print("🔄 [HYBRID] Priming backend catalog for \(cardIDs.count) ambiguous local candidates")

        await withTaskGroup(of: Void.self) { group in
            for cardID in cardIDs.prefix(4) {
                group.addTask { [matcher] in
                    _ = await matcher.fetchCardDetail(cardID: cardID, slabContext: nil)
                }
            }
        }
    }

    /// Create a CardCandidate from a local CardIdentifier (without pricing)
    ///
    /// Note: Creates a minimal candidate for immediate display. Fields like number, rarity,
    /// and variant are empty but will be populated when fetchPricingForLocalCard completes.
    private func createCandidateFromIdentifier(_ identifier: CardIdentifier) -> CardCandidate {
        CardCandidate(
            id: identifier.id,
            name: identifier.name,
            setName: identifier.set,
            number: "",
            rarity: "",
            variant: "",
            language: "English",
            pricing: nil
        )
    }

    /// Show card identified from local data immediately
    ///
    /// Displays the card with basic info while pricing is fetched asynchronously.
    /// Uses .localPrototype as matcherSource to indicate offline identification.
    private func showLocallyIdentifiedCard(
        candidate: CardCandidate,
        scanID: UUID,
        pendingItemID: UUID,
        performance: ScanPerformanceMetrics
    ) async {
        await MainActor.run {
            withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                updateStackItem(id: pendingItemID) { item in
                    item.phase = .resolved
                    item.card = candidate
                    item.confidence = .high
                    item.matcherSource = .localPrototype
                    item.matcherVersion = "offline-v1"
                    item.resolverMode = .rawCard
                    item.reviewDisposition = .ready
                    item.statusMessage = "Getting price..."
                    item.performance = performance
                    item.isExpanded = false
                    item.isRefreshingPrice = true
                }
            }

            resetPendingScanState()
            route = .scanner
            showBanner("Added \(candidate.name)")
        }
    }

    /// Fetch pricing from backend for a locally identified card
    private func fetchPricingForLocalCard(cardID: String, itemID: UUID) async {
        do {
            print("🔍 [HYBRID] Fetching pricing for \(cardID)...")
            if let detail = try await matcher.refreshCardDetail(
                cardID: cardID,
                slabContext: nil,
                forceRefresh: false
            ) {
                print("✅ [HYBRID] Got pricing from backend refresh")
                logPricingSnapshot(prefix: "Refreshed local card", card: detail.card)
                await applyFetchedLocalCardDetail(detail, itemID: itemID)
            } else if let detail = await matcher.fetchCardDetail(cardID: cardID, slabContext: nil) {
                print("✅ [HYBRID] Got detail from backend fetch")
                logPricingSnapshot(prefix: "Fetched local card", card: detail.card)
                await applyFetchedLocalCardDetail(detail, itemID: itemID)
            } else {
                print("⚠️ [HYBRID] Backend returned no detail after refresh/fetch")
                await MainActor.run {
                    updateStackItem(id: itemID) { item in
                        item.statusMessage = "Price unavailable"
                        item.isRefreshingPrice = false
                    }
                }
            }
        } catch {
            print("⚠️ [HYBRID] Backend pricing failed: \(error.localizedDescription)")
            // Check local cache as fallback
            if let cached = scanCacheManager.get(cardId: cardID) {
                print("✅ [HYBRID] Using cached pricing")
                await MainActor.run {
                    updateStackItem(id: itemID) { item in
                        // Set cache status based on age
                        if cached.ageHours < 1 {
                            item.cacheStatus = .fresh
                            item.statusMessage = "Fresh price"
                        } else if cached.ageHours < 24 {
                            item.cacheStatus = .recent(hours: cached.ageHours)
                            item.statusMessage = "Cached \(cached.ageHours)h ago"
                        } else {
                            item.cacheStatus = .outdated(days: cached.ageDays)
                            item.statusMessage = "Outdated (\(cached.ageDays)d ago)"
                        }
                        item.isRefreshingPrice = false
                    }
                }
            } else {
                print("❌ [HYBRID] No cached pricing available")
                await MainActor.run {
                    updateStackItem(id: itemID) { item in
                        item.cacheStatus = .offline
                        item.statusMessage = "Price unavailable (offline)"
                        item.isRefreshingPrice = false
                    }
                }
            }
        }
    }

    private func logPricingSnapshot(prefix: String, card: CardCandidate) {
        guard let pricing = card.pricing else {
            print("🔍 [PRICING] \(prefix): \(card.id) has no pricing snapshot")
            return
        }

        let primaryPrice = pricing.primaryDisplayPrice.map { String(format: "%.2f", $0) } ?? "n/a"
        print(
            "🔍 [PRICING] \(prefix): "
            + "card=\(card.id) "
            + "source=\(pricing.source) "
            + "variant=\(pricing.variant ?? "n/a") "
            + "price=\(primaryPrice) "
            + "currency=\(pricing.currencyCode) "
            + "url=\(pricing.sourceURL ?? "n/a")"
        )
    }

    private func applyFetchedLocalCardDetail(_ detail: CardDetail, itemID: UUID) async {
        await MainActor.run {
            updateStackItem(id: itemID) { item in
                item.card = detail.card
                item.detail = detail
                item.statusMessage = detail.pricing == nil
                    ? "No market price available"
                    : ScanTrayCalculator.initialStatusMessage(for: detail.pricing)
                item.isRefreshingPrice = false
            }

            if let pricing = detail.pricing {
                scanCacheManager.save(
                    cardId: detail.card.id,
                    name: detail.card.name,
                    set: detail.card.setName,
                    number: detail.card.number,
                    imageURL: detail.imageSmallURL ?? "",
                    pricing: pricing
                )
            }
        }
    }

    /// Fall back to original backend matching flow
    private func fallbackToBackendMatch(
        analysis: AnalyzedCapture,
        scanID: UUID,
        pendingItemID: UUID,
        performance: ScanPerformanceMetrics
    ) async {
        do {
            print("🔍 [HYBRID] Using backend match...")
            let matchStarted = Date().timeIntervalSinceReferenceDate
            let response = try await matcher.match(analysis: analysis)
            let matchMs = (Date().timeIntervalSinceReferenceDate - matchStarted) * 1000
            print("✅ [HYBRID] Backend match completed in \(matchMs)ms")
            if let bestMatch = response.bestMatch {
                logPricingSnapshot(prefix: "Backend best match", card: bestMatch)
            }

            if response.matcherSource == .localPrototype {
                print("⚠️ [HYBRID] Using LOCAL FALLBACK - backend unreachable")
                let updatedPerformance = ScanPerformanceMetrics(
                    analysisMs: performance.analysisMs,
                    matchMs: matchMs,
                    totalMs: performance.analysisMs + matchMs
                )

                updateStackItem(id: pendingItemID) { item in
                    item.phase = .needsReview
                    item.card = nil
                    item.detail = nil
                    item.confidence = .low
                    item.matcherSource = response.matcherSource
                    item.matcherVersion = response.matcherVersion
                    item.resolverMode = response.resolverMode
                    item.resolverPath = response.resolverPath
                    item.slabContext = response.slabContext
                    item.reviewDisposition = .needsReview
                    item.reviewReason = "Backend unavailable. Could not verify this card against the full catalog."
                    item.statusMessage = "Backend unavailable. Match not verified."
                    item.pricingContextNote = nil
                    item.performance = updatedPerformance
                    item.isRefreshingPrice = false
                }

                resetPendingScanState()
                return
            }

            let updatedPerformance = ScanPerformanceMetrics(
                analysisMs: performance.analysisMs,
                matchMs: matchMs,
                totalMs: performance.analysisMs + matchMs
            )

            analyzedCapture = analysis
            matchResponse = response
            applyAnalysis(analysis, response: response, to: pendingItemID)
            updateStackItem(id: pendingItemID) { item in
                item.performance = updatedPerformance
            }

            await logStore.logPrediction(analysis: analysis, response: response)

            if let bestMatch = response.bestMatch, shouldAutoAccept(response) {
                completeSelection(with: bestMatch, correctionType: .acceptedTop)
            } else if response.bestMatch != nil {
                updateStackItem(id: pendingItemID) { item in
                    let disposition = response.reviewDisposition ?? .needsReview
                    item.phase = (disposition == .unsupported) ? .unsupported : .needsReview
                    item.reviewDisposition = disposition
                    item.reviewReason = response.reviewReason
                    item.statusMessage = response.reviewReason ?? "Could not verify the card strongly enough."
                    item.isRefreshingPrice = false
                }
                resetPendingScanState()
            } else {
                updateStackItem(id: pendingItemID) { item in
                    let disposition = response.reviewDisposition ?? .ready
                    item.phase = (disposition == .unsupported) ? .unsupported : .failed
                    item.reviewDisposition = disposition
                    item.reviewReason = response.reviewReason
                    item.statusMessage = response.reviewReason ?? "No matching cards found"
                    item.isRefreshingPrice = false
                }
                resetPendingScanState()
            }
        } catch {
            print("❌ [HYBRID] Backend match failed: \(error.localizedDescription)")
            errorMessage = error.localizedDescription
            markPendingScanFailed(itemID: pendingItemID, message: "Could not identify card")
            resetPendingScanState()
        }
    }
}
