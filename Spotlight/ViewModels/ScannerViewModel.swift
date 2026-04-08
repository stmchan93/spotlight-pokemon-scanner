import Foundation
import SwiftUI
import UIKit

@MainActor
final class ScannerViewModel: ObservableObject {
    @Published var route: ScannerRoute = .scanner
    @Published var isCapturingPhoto = false
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

    private let rawAnalyzer: RawCardScanner
    private let slabAnalyzer: SlabScanner
    private let matcher: CardMatchingService
    private let logStore: ScanEventStore
    private var currentScanID: UUID?
    private var currentPendingItemID: UUID?
    private var currentScanStartedAt: TimeInterval?
    private var idlePricingRefreshTask: Task<Void, Never>?
    private var hasShownPhotoSaveFailureBanner = false

    private var selectedResolverMode: ResolverMode {
        scannerPresentationMode == .slab ? .psaSlab : .rawCard
    }

    init(
        cameraController: CameraSessionController,
        rawAnalyzer: RawCardScanner,
        slabAnalyzer: SlabScanner,
        matcher: CardMatchingService,
        logStore: ScanEventStore
    ) {
        self.cameraController = cameraController
        self.rawAnalyzer = rawAnalyzer
        self.slabAnalyzer = slabAnalyzer
        self.matcher = matcher
        self.logStore = logStore

        self.cameraController.onImageCaptured = { [weak self] image in
            self?.processImportedPhoto(image)
        }
        self.cameraController.onCaptureFailed = { [weak self] message in
            self?.handleCaptureFailure(message)
        }
        self.cameraController.onCaptureSavedToPhotoLibrary = { [weak self] success, message in
            self?.handlePhotoLibrarySaveResult(success: success, message: message)
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

    func startScannerSession() {
        if cameraController.authorizationState == .unknown {
            cameraController.requestAccessIfNeeded()
        }
        cameraController.startSession()
    }

    func stopScannerSession() {
        cameraController.stopSession()
        idlePricingRefreshTask?.cancel()
    }

    func capturePhoto(reticleRect: CGRect) {
        guard !isProcessing, !isCapturingPhoto else { return }
        errorMessage = nil
        route = .scanner

        let scanID = UUID()
        let pendingItemID = enqueuePendingScan(scanID: scanID, previewImage: nil)
        currentScanID = scanID
        currentPendingItemID = pendingItemID
        currentScanStartedAt = Date().timeIntervalSinceReferenceDate

        let didStartCapture = cameraController.capturePhoto(reticleRect: reticleRect)
        if didStartCapture {
            isCapturingPhoto = true
        } else {
            markPendingScanFailed(itemID: pendingItemID, message: "Could not capture card")
            resetPendingScanState()
            errorMessage = cameraController.lastErrorMessage ?? "Could not capture card"
        }
    }

    func toggleTorch() {
        cameraController.toggleTorch()
    }

    func processImportedPhoto(_ image: UIImage) {
        guard !isProcessing else { return }
        isCapturingPhoto = false
        let scanID = currentScanID ?? UUID()
        let pendingItemID = currentPendingItemID ?? enqueuePendingScan(scanID: scanID, previewImage: image)
        currentScanID = scanID
        currentPendingItemID = pendingItemID
        if currentScanStartedAt == nil {
            currentScanStartedAt = Date().timeIntervalSinceReferenceDate
        }
        Task {
            await handleScannedImage(
                image,
                scanID: scanID,
                pendingItemID: pendingItemID,
                scanStartedAt: currentScanStartedAt
            )
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

    private func handleScannedImage(
        _ image: UIImage,
        scanID: UUID? = nil,
        pendingItemID: UUID? = nil,
        scanStartedAt: TimeInterval? = nil
    ) async {
        print("🔍 [SCAN] Starting handleScannedImage")
        isCapturingPhoto = false
        errorMessage = nil
        route = .scanner

        // Balance OCR quality vs memory usage
        // 1200px = 50% larger than old 800px, but won't crash like 2400px did
        let processedImage = downscaleImage(image, maxDimension: 1200)
        print("🔍 [SCAN] Downscaled image from \(image.size) to \(processedImage.size)")

        let effectiveScanID = scanID ?? currentScanID ?? UUID()
        let effectivePendingItemID = pendingItemID ?? currentPendingItemID ?? enqueuePendingScan(scanID: effectiveScanID, previewImage: processedImage)
        let effectiveScanStartedAt = scanStartedAt ?? currentScanStartedAt ?? Date().timeIntervalSinceReferenceDate
        currentScanID = effectiveScanID
        currentPendingItemID = effectivePendingItemID
        currentScanStartedAt = effectiveScanStartedAt
        updateStackItem(id: effectivePendingItemID) { item in
            if item.previewImage == nil {
                item.previewImage = downscaleImage(processedImage, maxDimension: 300)
            }
            item.statusMessage = "Identifying card..."
        }
        isProcessing = true

        do {
            print("🔍 [SCAN] Starting Vision analysis...")
            let analysisStarted = Date().timeIntervalSinceReferenceDate
            let tapToAnalysisStartMs = (analysisStarted - effectiveScanStartedAt) * 1000
            print("⏱️ [SCAN] Tap to OCR start: \(tapToAnalysisStartMs)ms")
            let resolverMode = selectedResolverMode

            // Add timeout to prevent indefinite hanging on complex images
            let analysis = try await withThrowingTaskGroup(of: AnalyzedCapture.self) { group in
                group.addTask {
                    switch resolverMode {
                    case .psaSlab:
                        try await self.slabAnalyzer.analyze(
                            scanID: effectiveScanID,
                            image: processedImage,
                            resolverModeHint: resolverMode
                        )
                    case .rawCard, .unknownFallback:
                        try await self.rawAnalyzer.analyze(
                            scanID: effectiveScanID,
                            image: processedImage,
                            resolverModeHint: resolverMode
                        )
                    }
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
            print("🔍 [SCAN] Sending scan to backend matcher...")

            let performance = ScanPerformanceMetrics(
                analysisMs: analysisMs,
                matchMs: 0,  // Will be updated if backend is used
                totalMs: tapToAnalysisStartMs + analysisMs
            )

            await fallbackToBackendMatch(
                analysis: analysis,
                scanID: effectiveScanID,
                pendingItemID: effectivePendingItemID,
                performance: performance
            )
        } catch {
            print("❌ [SCAN] Error: \(error.localizedDescription)")
            errorMessage = error.localizedDescription
            markPendingScanFailed(itemID: effectivePendingItemID, message: "Could not identify card")
            resetPendingScanState()
        }

        print("🔍 [SCAN] Finished handleScannedImage")
        isCapturingPhoto = false
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
        currentScanStartedAt = nil
        analyzedCapture = nil
        matchResponse = nil
        searchQuery = ""
        searchResults = []
        errorMessage = nil
    }

    private func handleCaptureFailure(_ message: String) {
        isCapturingPhoto = false
        if let pendingItemID = currentPendingItemID {
            markPendingScanFailed(itemID: pendingItemID, message: "Could not capture card")
        }
        resetPendingScanState()
        errorMessage = message
    }

    private func handlePhotoLibrarySaveResult(success: Bool, message: String?) {
        if success {
            return
        }

        guard !hasShownPhotoSaveFailureBanner else { return }
        hasShownPhotoSaveFailureBanner = true
        showBanner(message ?? "Could not save scan to Photos")
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
            try? await Task.sleep(for: .milliseconds(150))
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

    private func enqueuePendingScan(scanID: UUID, previewImage: UIImage?) -> UUID {
        let itemID = UUID()

        // Downscale preview to save memory (max 300px)
        let thumbnail = previewImage.map { downscaleImage($0, maxDimension: 300) }

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

    // MARK: - Backend Matching Flow

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

    private func fallbackToBackendMatch(
        analysis: AnalyzedCapture,
        scanID: UUID,
        pendingItemID: UUID,
        performance: ScanPerformanceMetrics
    ) async {
        do {
            print("🔍 [SCAN] Using backend match...")
            let matchStarted = Date().timeIntervalSinceReferenceDate
            let response = try await matcher.match(analysis: analysis)
            let matchMs = (Date().timeIntervalSinceReferenceDate - matchStarted) * 1000
            print("✅ [SCAN] Backend match completed in \(matchMs)ms")
            if let bestMatch = response.bestMatch {
                logPricingSnapshot(prefix: "Backend best match", card: bestMatch)
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
            print("❌ [SCAN] Backend match failed: \(error.localizedDescription)")
            errorMessage = error.localizedDescription
            markPendingScanFailed(itemID: pendingItemID, message: "Could not identify card")
            resetPendingScanState()
        }
    }
}
