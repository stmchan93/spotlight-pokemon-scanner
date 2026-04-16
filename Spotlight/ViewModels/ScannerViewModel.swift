import Foundation
import SwiftUI
import UIKit

private struct ScanAlternativesContext {
    let itemID: UUID
    let scanID: UUID
    let previewImage: UIImage?
    let analysis: AnalyzedCapture?
    let response: ScanMatchResponse
}

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

    private let ocrPipeline: OCRPipelineCoordinator
    private let matcher: CardMatchingService
    private let logStore: ScanEventStore
    private let artifactUploadsEnabled: Bool
    private var currentScanID: UUID?
    private var currentPendingItemID: UUID?
    private var currentScanStartedAt: TimeInterval?
    private var currentReticleRect: CGRect?
    private var hasShownPhotoSaveFailureBanner = false
    private var alternativesContexts: [UUID: ScanAlternativesContext] = [:]
    private var activeAlternativesItemID: UUID?
    private var activeResultItemID: UUID?
    private var activeResultPreviewItem: LiveScanStackItem?

    private var selectedResolverMode: ResolverMode {
        scannerPresentationMode == .slab ? .psaSlab : .rawCard
    }
    private var navigationState = ScannerNavigationState()

    init(
        cameraController: CameraSessionController,
        ocrPipeline: OCRPipelineCoordinator,
        matcher: CardMatchingService,
        logStore: ScanEventStore,
        artifactUploadsEnabled: Bool = true
    ) {
        self.cameraController = cameraController
        self.ocrPipeline = ocrPipeline
        self.matcher = matcher
        self.logStore = logStore
        self.artifactUploadsEnabled = artifactUploadsEnabled

        self.cameraController.onImageCaptured = { [weak self] capture in
            self?.processCapturedInput(capture)
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

    var visibleScannedItems: [LiveScanStackItem] {
        if isCapturingPhoto || isProcessing {
            return scannedItems
        }
        return scannedItems.filter { $0.phase != .pending }
    }

    var trayMetrics: ScanTrayMetrics {
        ScanTrayCalculator.metrics(for: visibleScannedItems.map(\.metricInput))
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
    }

    func capturePhoto(reticleRect: CGRect) {
        guard !isProcessing, !isCapturingPhoto else { return }
        guard isValidReticleCaptureRect(reticleRect) else {
            errorMessage = "Scanner overlay is still loading. Try again."
            return
        }
        errorMessage = nil
        resetRouteToScanner()
        currentReticleRect = reticleRect

        let scanID = UUID()
        let pendingItemID = enqueuePendingScan(scanID: scanID, previewImage: nil)
        currentScanID = scanID
        currentPendingItemID = pendingItemID
        currentScanStartedAt = Date().timeIntervalSinceReferenceDate

        // Tap-to-scan should prefer the live preview frame first so OCR starts
        // immediately. Still-photo capture remains available as a fallback or
        // future explicit retry path.
        let preferStillPhoto = false
        let didStartCapture = cameraController.capturePhoto(
            scanID: scanID,
            reticleRect: reticleRect,
            preferStillPhoto: preferStillPhoto
        )
        if didStartCapture {
            updateStackItem(id: pendingItemID) { item in
                item.statusMessage = "Capturing preview frame…"
            }
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
        processCapturedInput(
            ScanCaptureInput(
                originalImage: image,
                searchImage: image,
                fallbackImage: nil,
                captureSource: .importedPhoto
            )
        )
    }

    func fetchMarketHistory(
        cardID: String,
        slabContext: SlabContext?,
        days: Int = 30,
        variant: String? = nil,
        condition: String? = nil
    ) async -> CardMarketHistory? {
        await matcher.fetchCardMarketHistory(
            cardID: cardID,
            slabContext: slabContext,
            days: days,
            variant: variant,
            condition: condition
        )
    }

    func fetchGradedCardComps(
        cardID: String,
        slabContext: SlabContext?,
        selectedGrade: String?
    ) async -> GradedCardComps? {
        await matcher.fetchGradedCardComps(
            cardID: cardID,
            slabContext: slabContext,
            selectedGrade: selectedGrade
        )
    }

    private func processCapturedInput(_ capture: ScanCaptureInput) {
        guard !isProcessing else { return }
        isCapturingPhoto = false
        let scanID = currentScanID ?? UUID()
        let previewImage = capture.trayPreviewImage
        let pendingItemID = currentPendingItemID ?? enqueuePendingScan(scanID: scanID, previewImage: previewImage)
        currentScanID = scanID
        currentPendingItemID = pendingItemID
        if currentScanStartedAt == nil {
            currentScanStartedAt = Date().timeIntervalSinceReferenceDate
        }
        Task {
            await handleScannedCapture(
                capture,
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

    var activeResultItem: LiveScanStackItem? {
        if let activeResultPreviewItem {
            return activeResultPreviewItem
        }
        guard let activeResultItemID else {
            return nil
        }
        return scannedItems.first(where: { $0.id == activeResultItemID })
    }

    var activeAlternativesPreviewImage: UIImage? {
        activeAlternativesContext?.previewImage
    }

    var activeAlternativesResponse: ScanMatchResponse? {
        activeAlternativesContext?.response
    }

    func presentResultDetail(for itemID: UUID) {
        guard scannedItems.contains(where: { $0.id == itemID }) else { return }
        activeResultPreviewItem = nil
        activeResultItemID = itemID
        pushRoute(.resultDetail)
    }

    func presentResultDetail(for entry: DeckCardEntry) {
        activeAlternativesItemID = nil
        activeResultItemID = nil
        activeResultPreviewItem = LiveScanStackItem(
            id: UUID(),
            scanID: UUID(),
            phase: .resolved,
            card: entry.card,
            detail: nil,
            previewImage: nil,
            confidence: .high,
            matcherSource: .remoteHybrid,
            matcherVersion: "deck_entry",
            resolverMode: entry.slabContext == nil ? .rawCard : .psaSlab,
            resolverPath: nil,
            slabContext: entry.slabContext,
            reviewDisposition: .ready,
            reviewReason: nil,
            addedAt: entry.addedAt,
            isExpanded: false,
            isRefreshingPrice: false,
            statusMessage: entry.card.pricing?.freshnessLabel,
            pricingContextNote: pricingContextNote(
                for: entry.slabContext == nil ? .rawCard : .psaSlab,
                matcherSource: .remoteHybrid,
                slabContext: entry.slabContext,
                pricing: entry.card.pricing
            ),
            performance: nil,
            cacheStatus: nil,
            selectedRank: nil,
            wasTopPrediction: true,
            selectionSource: .unknown,
            availableVariants: [],
            selectedVariant: nil,
            variantPricingOverride: nil,
            isLoadingVariants: false
        )
        pushRoute(.resultDetail)
    }

    func presentCandidateDetail(_ candidate: CardCandidate) {
        guard let context = activeAlternativesContext,
              let sourceItem = scannedItems.first(where: { $0.id == context.itemID }) else {
            return
        }

        var previewItem = sourceItem
        previewItem.card = candidate
        previewItem.detail = nil
        previewItem.isExpanded = false
        previewItem.isRefreshingPrice = false
        previewItem.statusMessage = ScanTrayCalculator.initialStatusMessage(for: candidate.pricing)
        previewItem.slabContext = resolvedSlabContext(for: candidate, response: context.response)
        previewItem.pricingContextNote = pricingContextNote(
            for: context.response.resolverMode,
            matcherSource: context.response.matcherSource,
            slabContext: previewItem.slabContext,
            pricing: candidate.pricing
        )
        previewItem.availableVariants = []
        previewItem.selectedVariant = nil
        previewItem.variantPricingOverride = nil
        previewItem.isLoadingVariants = false

        activeResultItemID = context.itemID
        activeResultPreviewItem = previewItem
        pushRoute(.resultDetail)
    }

    func showAlternatives(for itemID: UUID) {
        guard activateAlternativesContext(for: itemID) else {
            return
        }
        activeResultPreviewItem = nil
        activeResultItemID = itemID
        pushRoute(.alternatives)
    }

    func dismissAlternatives() {
        popRoute()
    }

    func dismissResultDetail() {
        popRoute()
    }

    func selectCandidate(_ candidate: CardCandidate, correctionType override: CorrectionType? = nil) {
        let correctionType = override
            ?? (candidate.id == matchResponse?.bestMatch?.id ? .acceptedTop : .choseAlternative)
        completeSelection(with: candidate, correctionType: correctionType)
    }

    func recordDeckAddition(
        itemID: UUID,
        card: CardCandidate,
        slabContext: SlabContext?,
        condition: DeckCardCondition? = nil
    ) {
        guard let item = scannedItems.first(where: { $0.id == itemID }) else { return }

        Task {
            await logStore.enqueueDeckConfirmation(
                scanID: item.scanID,
                cardID: card.id,
                slabContext: slabContext,
                condition: condition,
                selectionSource: item.selectionSource,
                selectedRank: item.selectedRank,
                wasTopPrediction: item.wasTopPrediction
            )
            await flushPendingBackendQueues()
        }
    }

    func updatePendingDeckAdditionCondition(
        itemID: UUID,
        card: CardCandidate,
        slabContext: SlabContext?,
        condition: DeckCardCondition
    ) {
        guard let item = scannedItems.first(where: { $0.id == itemID }) else { return }

        Task {
            await logStore.updatePendingDeckConfirmationCondition(
                scanID: item.scanID,
                cardID: card.id,
                slabContext: slabContext,
                condition: condition
            )
        }
    }

    func flushPendingBackendQueues() async {
        await flushPendingArtifactUploads()
        await flushPendingDeckConfirmations()
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
        removeStackItems([itemID])
    }

    func removeStackItems(_ itemIDs: [UUID]) {
        let itemIDSet = Set(itemIDs)
        guard !itemIDSet.isEmpty else { return }

        let removedActiveAlternatives = activeAlternativesItemID.map(itemIDSet.contains) ?? false
        let removedActiveResult = activeResultItemID.map(itemIDSet.contains) ?? false

        for itemID in itemIDSet {
            alternativesContexts.removeValue(forKey: itemID)
        }

        if removedActiveAlternatives {
            activeAlternativesItemID = nil
        }
        if removedActiveResult {
            activeResultItemID = nil
            activeResultPreviewItem = nil
        }

        withAnimation(.spring(response: 0.28, dampingFraction: 0.9)) {
            scannedItems.removeAll { itemIDSet.contains($0.id) }
        }

        if removedActiveAlternatives || removedActiveResult {
            resetRouteToScanner()
        } else {
            syncNavigationStateForCurrentRoute()
        }
    }

    func clearScans() {
        alternativesContexts.removeAll()
        activeAlternativesItemID = nil
        activeResultItemID = nil
        activeResultPreviewItem = nil
        resetRouteToScanner()
        withAnimation(.spring(response: 0.28, dampingFraction: 0.9)) {
            scannedItems.removeAll()
        }
    }

    func hasAlternatives(for itemID: UUID) -> Bool {
        (alternativesContexts[itemID]?.response.topCandidates.count ?? 0) > 1
    }

    func similarMatchCount(for itemID: UUID) -> Int {
        max(0, (alternativesContexts[itemID]?.response.topCandidates.count ?? 0) - 1)
    }

    func candidateCycleState(for itemID: UUID) -> ResultCandidateCycleState? {
        guard let item = scannedItems.first(where: { $0.id == itemID }),
              let context = alternativesContexts[itemID] else {
            return nil
        }
        return resultCandidateCycleState(
            currentCardID: item.displayCard?.id,
            topCandidates: context.response.topCandidates.map(\.candidate)
        )
    }

    func cycleCandidate(for itemID: UUID) {
        guard let item = scannedItems.first(where: { $0.id == itemID }),
              let context = alternativesContexts[itemID],
              let nextCandidate = nextResultCandidate(
                currentCardID: item.displayCard?.id,
                topCandidates: context.response.topCandidates.map(\.candidate)
              ) else {
            return
        }

        applyCandidateToResultItem(
            nextCandidate,
            itemID: itemID,
            response: context.response,
            preservePhase: true,
            selectedRank: context.response.topCandidates.first(where: { $0.candidate.id == nextCandidate.id })?.rank,
            wasTopPrediction: nextCandidate.id == context.response.bestMatch?.id,
            selectionSource: nextCandidate.id == context.response.bestMatch?.id ? .topPrediction : .alternatePrediction
        )

        Task {
            await hydrateCycledCandidatePricingIfNeeded(
                nextCandidate,
                itemID: itemID,
                response: context.response
            )
        }
    }

    func refreshPricing(for itemID: UUID) {
        guard let item = scannedItems.first(where: { $0.id == itemID }),
              let cardID = item.displayCard?.id else { return }

        Task {
            await refreshPricing(for: itemID, cardID: cardID, initiatedByUser: true)
        }
    }

    func loadTrayVariantsIfNeeded(for itemID: UUID) {
        guard let item = scannedItems.first(where: { $0.id == itemID }),
              supportsTrayVariantSelection(for: item),
              item.availableVariants.isEmpty,
              !item.isLoadingVariants,
              let cardID = item.displayCard?.id else {
            return
        }

        let fallbackPricing = item.basePricing
        let selectedVariant = normalizedTrayVariant(item.selectedVariant ?? fallbackPricing?.variant)
        updateStackItem(id: itemID) { item in
            item.isLoadingVariants = true
        }

        Task {
            let history = await fetchMarketHistory(
                cardID: cardID,
                slabContext: nil,
                days: 30,
                variant: selectedVariant,
                condition: "NM"
            )
            await MainActor.run {
                self.applyTrayVariantHistory(
                    history,
                    to: itemID,
                    cardID: cardID,
                    fallbackPricing: fallbackPricing,
                    requestedVariant: selectedVariant,
                    restoreVariantOnFailure: selectedVariant
                )
            }
        }
    }

    func selectTrayVariant(_ variantID: String, for itemID: UUID) {
        guard let item = scannedItems.first(where: { $0.id == itemID }),
              supportsTrayVariantSelection(for: item),
              !item.isLoadingVariants,
              let cardID = item.displayCard?.id,
              let requestedVariant = normalizedTrayVariant(variantID) else {
            return
        }

        let fallbackPricing = item.basePricing
        let previousVariant = normalizedTrayVariant(item.selectedVariant ?? fallbackPricing?.variant)
        let existingOptions = item.availableVariants

        if requestedVariant == previousVariant && item.variantPricingOverride != nil {
            return
        }

        updateStackItem(id: itemID) { item in
            item.selectedVariant = requestedVariant
            item.isLoadingVariants = true
        }

        Task {
            let history = await fetchMarketHistory(
                cardID: cardID,
                slabContext: nil,
                days: 30,
                variant: requestedVariant,
                condition: "NM"
            )
            await MainActor.run {
                self.applyTrayVariantHistory(
                    history,
                    to: itemID,
                    cardID: cardID,
                    fallbackPricing: fallbackPricing,
                    requestedVariant: requestedVariant,
                    restoreVariantOnFailure: previousVariant,
                    existingOptions: existingOptions
                )
            }
        }
    }

    func showBannerMessage(_ message: String) {
        showBanner(message)
    }

    private func refreshSearchResults() {
        let trimmedQuery = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else {
            searchResults = []
            return
        }

        Task {
            let query = trimmedQuery
            let results = await matcher.search(query: query)
            await MainActor.run {
                guard self.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines) == query else {
                    return
                }
                self.searchResults = results
            }
        }
    }

    private func handleScannedCapture(
        _ capture: ScanCaptureInput,
        scanID: UUID? = nil,
        pendingItemID: UUID? = nil,
        scanStartedAt: TimeInterval? = nil
    ) async {
        print("🔍 [SCAN] Starting handleScannedCapture")
        isCapturingPhoto = false
        errorMessage = nil
        resetRouteToScanner()
        let resolverMode = selectedResolverMode

        // Balance OCR quality vs memory usage
        // Use a slightly larger budget for raw still-photo retries so footer OCR gains real benefit.
        let originalMaxDimension: CGFloat = (resolverMode == .rawCard && capture.captureSource == .liveStillPhoto) ? 1800 : 1400
        let searchMaxDimension: CGFloat = (resolverMode == .rawCard && capture.captureSource == .liveStillPhoto) ? 1600 : 1200
        let processedCapture = ScanCaptureInput(
            originalImage: downscaleImage(capture.originalImage, maxDimension: originalMaxDimension),
            searchImage: downscaleImage(capture.searchImage, maxDimension: searchMaxDimension),
            fallbackImage: capture.fallbackImage.map { downscaleImage($0, maxDimension: searchMaxDimension) },
            captureSource: capture.captureSource
        )
        print("🔍 [SCAN] Downscaled search image from \(capture.searchImage.size) to \(processedCapture.searchImage.size)")

        let effectiveScanID = scanID ?? currentScanID ?? UUID()
        let previewImage = processedCapture.trayPreviewImage
        let effectivePendingItemID = pendingItemID ?? currentPendingItemID ?? enqueuePendingScan(scanID: effectiveScanID, previewImage: previewImage)
        let effectiveScanStartedAt = scanStartedAt ?? currentScanStartedAt ?? Date().timeIntervalSinceReferenceDate
        currentScanID = effectiveScanID
        currentPendingItemID = effectivePendingItemID
        currentScanStartedAt = effectiveScanStartedAt
        updateStackItem(id: effectivePendingItemID) { item in
            if item.previewImage == nil {
                item.previewImage = downscaleImage(previewImage, maxDimension: 300)
            }
            item.statusMessage = "Reading card…"
        }
        isProcessing = true

        do {
            print("🔍 [SCAN] Starting Vision analysis...")
            let analysisStarted = Date().timeIntervalSinceReferenceDate
            let tapToAnalysisStartMs = (analysisStarted - effectiveScanStartedAt) * 1000
            print("⏱️ [SCAN] Tap to OCR start: \(tapToAnalysisStartMs)ms")

            // Add timeout to prevent indefinite hanging on complex images
            let analysis = try await withThrowingTaskGroup(of: AnalyzedCapture.self) { group in
                group.addTask {
                    try await self.ocrPipeline.analyze(
                        scanID: effectiveScanID,
                        capture: processedCapture,
                        resolverModeHint: resolverMode
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
            logOCRSummary(
                analysis,
                captureSource: processedCapture.captureSource,
                analysisMs: analysisMs
            )

            if analysis.shouldRetryWithStillPhoto,
               let reticleRect = currentReticleRect {
                print("🔁 [SCAN] Retrying with still photo: \(analysis.stillPhotoRetryReason ?? "footer OCR weak")")
                updateStackItem(id: effectivePendingItemID) { item in
                    item.statusMessage = "Trying a sharper capture…"
                }
                isProcessing = false
                let didStartRetry = cameraController.capturePhoto(
                    scanID: effectiveScanID,
                    reticleRect: reticleRect,
                    preferStillPhoto: true
                )
                if didStartRetry {
                    isCapturingPhoto = true
                    return
                }
                print("⚠️ [SCAN] Still-photo retry could not start; continuing with current analysis")
                isProcessing = true
            }

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
                performance: performance,
                captureSource: processedCapture.captureSource
            )
        } catch {
            print("❌ [SCAN] Error: \(error.localizedDescription)")
            errorMessage = error.localizedDescription
            markPendingScanFailed(itemID: effectivePendingItemID, message: "Could not identify card")
            resetPendingScanState()
        }

        print("🔍 [SCAN] Finished handleScannedCapture")
        isCapturingPhoto = false
        isProcessing = false
    }

    private func completeSelection(with candidate: CardCandidate, correctionType: CorrectionType) {
        let context = activeAlternativesContext
        guard let scanID = currentScanID ?? context?.scanID,
              let itemID = currentPendingItemID ?? context?.itemID else { return }

        let wasTopPrediction = candidate.id == matchResponse?.bestMatch?.id
        let selectionSource: ScanSelectionSource = switch correctionType {
        case .acceptedTop:
            .topPrediction
        case .choseAlternative:
            .alternatePrediction
        case .manualSearch:
            .manualSearch
        case .abandoned:
            .abandoned
        }
        let selectedRank = (matchResponse ?? context?.response)?
            .topCandidates
            .first(where: { $0.candidate.id == candidate.id })?
            .rank

        applyCandidateToResultItem(
            candidate,
            itemID: itemID,
            response: matchResponse ?? context?.response,
            preservePhase: false,
            selectedRank: selectedRank,
            wasTopPrediction: wasTopPrediction,
            selectionSource: selectionSource
        )
        activeResultItemID = itemID
        if activeAlternativesItemID == itemID {
            activeAlternativesItemID = nil
        }
        resetPendingScanState()
        pushRoute(.resultDetail)

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

    private func applyCandidateToResultItem(
        _ candidate: CardCandidate,
        itemID: UUID,
        response: ScanMatchResponse?,
        preservePhase: Bool,
        selectedRank: Int?,
        wasTopPrediction: Bool,
        selectionSource: ScanSelectionSource
    ) {
        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
            for index in scannedItems.indices {
                scannedItems[index].isExpanded = false
            }
            updateStackItem(id: itemID) { item in
                if !preservePhase {
                    item.phase = .resolved
                }
                item.card = candidate
                item.detail = nil
                item.isExpanded = false
                item.isRefreshingPrice = false
                item.selectedRank = selectedRank
                item.wasTopPrediction = wasTopPrediction
                item.selectionSource = selectionSource
                item.statusMessage = ScanTrayCalculator.initialStatusMessage(for: candidate.pricing)
                item.slabContext = resolvedSlabContext(for: candidate, response: response)
                item.pricingContextNote = pricingContextNote(
                    for: response?.resolverMode ?? item.resolverMode,
                    matcherSource: response?.matcherSource ?? item.matcherSource,
                    slabContext: response?.slabContext,
                    pricing: candidate.pricing
                )
                item.availableVariants = []
                item.selectedVariant = nil
                item.variantPricingOverride = nil
                item.isLoadingVariants = false
            }
        }

    }

    private func flushPendingArtifactUploads() async {
        guard artifactUploadsEnabled else { return }
        let uploads = await logStore.pendingArtifactUploads()
        for upload in uploads {
            do {
                let payload = try makeArtifactUploadPayload(from: upload)
                try await matcher.uploadScanArtifacts(payload)
                await logStore.markArtifactUploadAttempt(scanID: upload.scanID, uploaded: true)
            } catch {
                await logStore.markArtifactUploadAttempt(scanID: upload.scanID, uploaded: false)
            }
        }
    }

    private func flushPendingDeckConfirmations() async {
        let confirmations = await logStore.pendingDeckConfirmations()
        for confirmation in confirmations {
            do {
                try await matcher.addDeckEntry(
                    DeckEntryCreateRequestPayload(
                        cardID: confirmation.cardID,
                        slabContext: confirmation.slabContext,
                        condition: confirmation.condition,
                        sourceScanID: confirmation.scanID,
                        selectionSource: confirmation.selectionSource,
                        selectedRank: confirmation.selectedRank,
                        wasTopPrediction: confirmation.wasTopPrediction,
                        addedAt: Date()
                    )
                )
                await logStore.markDeckConfirmationAttempt(id: confirmation.id, submitted: true)
            } catch {
                await logStore.markDeckConfirmationAttempt(id: confirmation.id, submitted: false)
            }
        }
    }

    private func makeArtifactUploadPayload(from upload: PendingScanArtifactUpload) throws -> ScanArtifactUploadRequestPayload {
        let sourceImage = try makeStoredImagePayload(fromPath: upload.sourceImagePath)
        let normalizedImage = try makeStoredImagePayload(fromPath: upload.normalizedImagePath)
        return ScanArtifactUploadRequestPayload(
            scanID: upload.scanID,
            captureSource: upload.captureSource,
            cameraZoomFactor: upload.cameraZoomFactor,
            sourceImage: sourceImage,
            normalizedImage: normalizedImage,
            submittedAt: Date()
        )
    }

    private func makeStoredImagePayload(fromPath path: String) throws -> ScanImagePayload {
        let fileURL = URL(fileURLWithPath: path)
        let data = try Data(contentsOf: fileURL)
        guard let image = UIImage(contentsOfFile: path) else {
            throw NSError(domain: "ScanArtifactUpload", code: -1, userInfo: [NSLocalizedDescriptionKey: "Image payload missing"])
        }
        return ScanImagePayload(
            jpegBase64: data.base64EncodedString(),
            width: Int(image.size.width.rounded()),
            height: Int(image.size.height.rounded())
        )
    }

    private func abandonPendingScanIfNeeded() async {
        guard let scanID = currentScanID,
              let pendingItemID = currentPendingItemID else {
            resetRouteToScanner()
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
        resetRouteToScanner()
    }

    private var activeAlternativesContext: ScanAlternativesContext? {
        guard let activeAlternativesItemID else {
            return nil
        }
        return alternativesContexts[activeAlternativesItemID]
    }

    private func pushRoute(_ nextRoute: ScannerRoute) {
        navigationState.push(nextRoute)
        route = navigationState.currentRoute
        syncNavigationStateForCurrentRoute()
    }

    private func popRoute() {
        navigationState.pop()
        route = navigationState.currentRoute
        syncNavigationStateForCurrentRoute()
    }

    private func resetRouteToScanner() {
        navigationState.resetToScanner()
        route = navigationState.currentRoute
        syncNavigationStateForCurrentRoute()
    }

    private func syncNavigationStateForCurrentRoute() {
        switch navigationState.currentRoute {
        case .scanner:
            activeAlternativesItemID = nil
            activeResultPreviewItem = nil
            analyzedCapture = nil
            matchResponse = nil
            searchQuery = ""
            searchResults = []
        case .resultDetail:
            activeAlternativesItemID = nil
            analyzedCapture = nil
            matchResponse = nil
            searchQuery = ""
            searchResults = []
        case .alternatives:
            activeResultPreviewItem = nil
            searchQuery = ""
            searchResults = []
            guard let itemID = activeResultItemID ?? activeAlternativesItemID else {
                navigationState.resetToScanner()
                route = navigationState.currentRoute
                activeAlternativesItemID = nil
                activeResultPreviewItem = nil
                analyzedCapture = nil
                matchResponse = nil
                return
            }
            _ = activateAlternativesContext(for: itemID)
        }
    }

    @discardableResult
    private func activateAlternativesContext(for itemID: UUID) -> Bool {
        guard let context = alternativesContexts[itemID] else {
            activeAlternativesItemID = nil
            analyzedCapture = nil
            matchResponse = nil
            return false
        }

        activeAlternativesItemID = itemID
        analyzedCapture = context.analysis
        matchResponse = context.response
        return true
    }

    private func resetPendingScanState() {
        currentScanID = nil
        currentPendingItemID = nil
        currentScanStartedAt = nil
        currentReticleRect = nil
        if activeAlternativesItemID == nil {
            analyzedCapture = nil
            matchResponse = nil
        }
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
        resetRouteToScanner()
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

    private func supportsTrayVariantSelection(for item: LiveScanStackItem) -> Bool {
        (item.phase == .resolved || item.phase == .needsReview)
            && item.resolverMode == .rawCard
            && item.slabContext == nil
            && item.displayCard != nil
    }

    private func normalizedTrayVariant(_ variant: String?) -> String? {
        let normalized = variant?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return normalized.isEmpty ? nil : normalized
    }

    private func applyTrayVariantHistory(
        _ history: CardMarketHistory?,
        to itemID: UUID,
        cardID: String,
        fallbackPricing: CardPricingSummary?,
        requestedVariant: String?,
        restoreVariantOnFailure: String?,
        existingOptions: [MarketHistoryOption] = []
    ) {
        guard let index = scannedItems.firstIndex(where: { $0.id == itemID }),
              scannedItems[index].displayCard?.id == cardID else {
            return
        }

        scannedItems[index].isLoadingVariants = false

        guard let history else {
            scannedItems[index].availableVariants = existingOptions
            scannedItems[index].selectedVariant = restoreVariantOnFailure
            scannedItems[index].statusMessage = scannedItems[index].pricing?.freshnessLabel ?? scannedItems[index].statusMessage
            return
        }

        let resolvedVariant = normalizedTrayVariant(history.selectedVariant ?? requestedVariant ?? restoreVariantOnFailure)
        scannedItems[index].availableVariants = history.availableVariants
        scannedItems[index].selectedVariant = resolvedVariant
        scannedItems[index].variantPricingOverride = trayVariantPricingOverride(
            from: history,
            fallbackPricing: fallbackPricing,
            selectedVariant: resolvedVariant
        )
        scannedItems[index].statusMessage = scannedItems[index].pricing?.freshnessLabel ?? scannedItems[index].statusMessage
    }

    private func trayVariantPricingOverride(
        from history: CardMarketHistory,
        fallbackPricing: CardPricingSummary?,
        selectedVariant: String?
    ) -> CardPricingSummary? {
        if let fallbackPricing {
            return fallbackPricing.applyingMarketHistory(history, fallbackVariant: selectedVariant)
        }

        return CardPricingSummary(
            source: history.source,
            currencyCode: history.currencyCode,
            variant: selectedVariant,
            low: history.latestRenderablePoint?.low,
            market: history.primaryDisplayPrice,
            mid: history.latestRenderablePoint?.mid,
            high: history.latestRenderablePoint?.high,
            directLow: nil,
            trend: nil,
            updatedAt: nil,
            refreshedAt: history.refreshedAt,
            sourceURL: nil,
            pricingMode: history.pricingMode,
            snapshotAgeHours: nil,
            freshnessWindowHours: nil,
            isFresh: history.isFresh,
            grader: nil,
            grade: nil,
            pricingTier: nil,
            confidenceLabel: nil,
            confidenceLevel: nil,
            compCount: nil,
            recentCompCount: nil,
            lastSoldPrice: nil,
            lastSoldAt: nil,
            bucketKey: nil,
            methodologySummary: nil
        )
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
                        item.slabContext = self.mergedSlabContext(
                            existing: item.slabContext,
                            refreshed: refreshedDetail.slabContext
                        )
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

    private func hydrateCycledCandidatePricingIfNeeded(
        _ candidate: CardCandidate,
        itemID: UUID,
        response: ScanMatchResponse
    ) async {
        guard let activeCardID = scannedItems.first(where: { $0.id == itemID })?.displayCard?.id,
              activeCardID == candidate.id else {
            return
        }

        let slabContext = resolvedSlabContext(for: candidate, response: response)
        await MainActor.run {
            self.updateStackItem(id: itemID) { item in
                guard item.displayCard?.id == candidate.id else { return }
                item.isRefreshingPrice = true
            }
        }

        let details = await matcher.hydrateCandidatePricing(
            cardIDs: [candidate.id],
            // Candidate cycling should only hydrate whatever pricing is already
            // cached in SQLite. Live pricing stays behind explicit refresh flows.
            maxRefreshCount: 0,
            slabContext: slabContext
        )

        await MainActor.run {
            guard self.scannedItems.contains(where: { $0.id == itemID }) else { return }

            if let detail = details.first {
                if let existingContext = self.alternativesContexts[itemID] {
                    let mergedResponse = existingContext.response.mergingCandidateDetails([detail])
                    self.alternativesContexts[itemID] = ScanAlternativesContext(
                        itemID: existingContext.itemID,
                        scanID: existingContext.scanID,
                        previewImage: existingContext.previewImage,
                        analysis: existingContext.analysis,
                        response: mergedResponse
                    )
                    if self.activeAlternativesItemID == itemID || self.activeResultItemID == itemID {
                        self.matchResponse = mergedResponse
                    }
                }

                self.updateStackItem(id: itemID) { item in
                    guard item.displayCard?.id == detail.card.id else {
                        item.isRefreshingPrice = false
                        return
                    }
                    item.detail = detail
                    item.card = detail.card
                    item.slabContext = self.mergedSlabContext(
                        existing: item.slabContext,
                        refreshed: detail.slabContext
                    )
                    item.statusMessage = detail.pricing?.freshnessLabel ?? item.statusMessage
                    item.pricingContextNote = self.pricingContextNote(
                        for: item.resolverMode,
                        matcherSource: item.matcherSource,
                        slabContext: item.slabContext,
                        pricing: detail.pricing
                    )
                    item.isRefreshingPrice = false
                }
                return
            }

            self.updateStackItem(id: itemID) { item in
                if item.displayCard?.id == candidate.id {
                    item.isRefreshingPrice = false
                }
            }
        }
    }

    private func resolvedSlabContext(for candidate: CardCandidate, response: ScanMatchResponse?) -> SlabContext? {
        guard response?.resolverMode == .psaSlab || response?.slabContext != nil else {
            return response?.slabContext
        }

        let existing = response?.slabContext
        let grader = candidate.pricing?.grader ?? existing?.grader
        guard let grader else {
            return existing
        }

        return SlabContext(
            grader: grader,
            grade: candidate.pricing?.grade ?? existing?.grade,
            certNumber: existing?.certNumber,
            variantName: candidate.pricing?.variant ?? existing?.variantName
        )
    }

    private func mergedSlabContext(existing: SlabContext?, refreshed: SlabContext?) -> SlabContext? {
        guard existing != nil || refreshed != nil else {
            return nil
        }

        let grader = refreshed?.grader ?? existing?.grader
        guard let grader else {
            return refreshed ?? existing
        }

        return SlabContext(
            grader: grader,
            grade: refreshed?.grade ?? existing?.grade,
            certNumber: refreshed?.certNumber ?? existing?.certNumber,
            variantName: refreshed?.variantName ?? existing?.variantName
        )
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
                    performance: nil,
                    selectedRank: nil,
                    wasTopPrediction: false,
                    selectionSource: .unknown,
                    availableVariants: [],
                    selectedVariant: nil,
                    variantPricingOverride: nil,
                    isLoadingVariants: false
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
            if let bestMatch = response.bestMatch {
                item.card = bestMatch
                item.detail = nil
                item.selectedRank = 1
                item.wasTopPrediction = true
                item.selectionSource = .topPrediction
                item.pricingContextNote = pricingContextNote(
                    for: response.resolverMode,
                    matcherSource: response.matcherSource,
                    slabContext: response.slabContext,
                    pricing: bestMatch.pricing
                )
                item.availableVariants = []
                item.selectedVariant = nil
                item.variantPricingOverride = nil
                item.isLoadingVariants = false
            }
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

    private func logOCRSummary(
        _ analysis: AnalyzedCapture,
        captureSource: ScanCaptureSource,
        analysisMs: Double
    ) {
        let rawEvidence = analysis.ocrAnalysis?.rawEvidence
        let slabEvidence = analysis.ocrAnalysis?.slabEvidence

        print(
            "🧠 [OCR] Summary: "
            + "scanID=\(analysis.scanID.uuidString) "
            + "route=\(analysis.ocrAnalysis?.pipelineVersion.rawValue ?? "none") "
            + "mode=\(analysis.resolverModeHint.rawValue) "
            + "capture=\(captureSource.rawValue) "
            + "crop=\(String(format: "%.2f", analysis.cropConfidence)) "
            + "analysisMs=\(Int(analysisMs.rounded()))"
        )
        print(
            "🧠 [OCR] Target: "
            + "geometry=\(analysis.ocrAnalysis?.normalizedTarget?.geometryKind ?? "n/a") "
            + "fallback=\(analysis.ocrAnalysis?.normalizedTarget?.usedFallback == true ? "yes" : "no") "
            + "quality=\(formatDouble(analysis.ocrAnalysis?.normalizedTarget?.targetQuality.overallScore)) "
            + "warnings=\(analysis.warnings)"
        )
        if let rawEvidence {
            print(
                "🧠 [OCR] Raw evidence: "
                + "title=\(quoted(rawEvidence.titleTextPrimary)) "
                + "titleScore=\(formatFieldConfidence(rawEvidence.titleConfidence)) "
                + "collectorExact=\(quoted(rawEvidence.collectorNumberExact)) "
                + "collectorPartial=\(quoted(rawEvidence.collectorNumberPartial)) "
                + "collectorScore=\(formatFieldConfidence(rawEvidence.collectorConfidence)) "
                + "setBadge=\(quoted(rawEvidence.setBadgeHint?.rawValue)) "
                + "setBadgeKind=\(rawEvidence.setBadgeHint?.kind.rawValue ?? "unknown") "
                + "setHints=\(rawEvidence.setHints) "
                + "setScore=\(formatFieldConfidence(rawEvidence.setConfidence))"
            )
        }
        if let slabEvidence {
            print(
                "🧠 [OCR] Slab evidence: "
                + "title=\(quoted(slabEvidence.titleTextPrimary)) "
                + "cardNumber=\(quoted(slabEvidence.cardNumber)) "
                + "setHints=\(slabEvidence.setHints) "
                + "grader=\(quoted(slabEvidence.grader)) "
                + "grade=\(quoted(slabEvidence.grade)) "
                + "cert=\(quoted(slabEvidence.cert))"
            )
        }

        ScanStageArtifactWriter.recordFinalDecisionArtifact(
            scanID: analysis.scanID,
            stage: "frontend_ocr_summary",
            payload: FrontendOCRSummaryArtifact(
                scanID: analysis.scanID.uuidString,
                resolverModeHint: analysis.resolverModeHint.rawValue,
                captureSource: captureSource.rawValue,
                analysisMs: analysisMs,
                cropConfidence: analysis.cropConfidence,
                pipelineVersion: analysis.ocrAnalysis?.pipelineVersion.rawValue,
                selectedMode: analysis.ocrAnalysis?.selectedMode.rawValue,
                geometryKind: analysis.ocrAnalysis?.normalizedTarget?.geometryKind,
                usedFallback: analysis.ocrAnalysis?.normalizedTarget?.usedFallback,
                targetQualityScore: analysis.ocrAnalysis?.normalizedTarget?.targetQuality.overallScore,
                collectorNumber: analysis.collectorNumber,
                setHintTokens: analysis.setHintTokens,
                setBadgeHint: analysis.setBadgeHint,
                warnings: analysis.warnings,
                shouldRetryWithStillPhoto: analysis.shouldRetryWithStillPhoto,
                stillPhotoRetryReason: analysis.stillPhotoRetryReason,
                rawEvidence: rawEvidence,
                slabEvidence: slabEvidence
            )
        )
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
        performance: ScanPerformanceMetrics,
        captureSource: ScanCaptureSource
    ) async {
        do {
            print("🔍 [SCAN] Using backend match...")
            print(
                "🌐 [MATCH] Request: "
                + "scanID=\(scanID.uuidString) "
                + "mode=\(analysis.resolverModeHint.rawValue) "
                + "rawResolver=\(analysis.resolverModeHint.runtimeRawResolverMode?.rawValue ?? "n/a") "
                + "pipeline=\(analysis.ocrAnalysis?.pipelineVersion.rawValue ?? "none") "
                + "collector=\(quoted(analysis.collectorNumber)) "
                + "setHints=\(analysis.setHintTokens) "
                + "warnings=\(analysis.warnings)"
            )
            ScanStageArtifactWriter.recordFinalDecisionArtifact(
                scanID: scanID,
                stage: "frontend_backend_request",
                payload: FrontendBackendRequestArtifact(
                    scanID: scanID.uuidString,
                    resolverModeHint: analysis.resolverModeHint.rawValue,
                    rawResolverMode: analysis.resolverModeHint.runtimeRawResolverMode?.rawValue,
                    pipelineVersion: analysis.ocrAnalysis?.pipelineVersion.rawValue,
                    imageWidth: Int(analysis.normalizedImage.size.width.rounded()),
                    imageHeight: Int(analysis.normalizedImage.size.height.rounded()),
                    recognizedTokenCount: analysis.recognizedTokens.count,
                    cropConfidence: analysis.cropConfidence,
                    collectorNumber: analysis.collectorNumber,
                    collectorNumberPartial: analysis.ocrAnalysis?.rawEvidence?.collectorNumberPartial,
                    setHintTokens: analysis.setHintTokens,
                    setBadgeHint: analysis.setBadgeHint,
                    titleTextPrimary: analysis.ocrAnalysis?.rawEvidence?.titleTextPrimary,
                    titleTextSecondary: analysis.ocrAnalysis?.rawEvidence?.titleTextSecondary,
                    ocrAnalysisIncluded: analysis.ocrAnalysis != nil,
                    warnings: analysis.warnings
                )
            )
            let matchStarted = Date().timeIntervalSinceReferenceDate
            let response = try await matcher.match(analysis: analysis)
            let matchMs = (Date().timeIntervalSinceReferenceDate - matchStarted) * 1000
            let serverProcessingMs = response.performance?.serverProcessingMs
            let networkOverheadMs = serverProcessingMs.map { max(0, matchMs - $0) }
            print("✅ [SCAN] Backend match completed in \(matchMs)ms")
            logBackendResponseSummary(response, matchMs: matchMs)
            ScanStageArtifactWriter.recordFinalDecisionArtifact(
                scanID: scanID,
                stage: "frontend_backend_response",
                payload: FrontendBackendResponseArtifact(
                    scanID: scanID.uuidString,
                    matchMs: matchMs,
                    serverProcessingMs: serverProcessingMs,
                    networkOverheadMs: networkOverheadMs,
                    scrydexRequestCount: response.performance?.scrydexRequestCount,
                    scrydexRequestTypes: response.performance?.scrydexRequestTypes,
                    confidence: response.confidence.rawValue,
                    resolverMode: response.resolverMode.rawValue,
                    resolverPath: response.resolverPath?.rawValue,
                    reviewDisposition: response.reviewDisposition?.rawValue,
                    reviewReason: response.reviewReason,
                    ambiguityFlags: response.ambiguityFlags,
                    topCandidates: response.topCandidates.prefix(3).map { scored in
                        FrontendBackendCandidateArtifact(
                            id: scored.candidate.id,
                            name: scored.candidate.name,
                            setName: scored.candidate.setName,
                            number: scored.candidate.number,
                            finalScore: scored.finalScore
                        )
                    }
                )
            )
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
            alternativesContexts[pendingItemID] = ScanAlternativesContext(
                itemID: pendingItemID,
                scanID: scanID,
                previewImage: scannedItems.first(where: { $0.id == pendingItemID })?.previewImage,
                analysis: analysis,
                response: response
            )
            updateStackItem(id: pendingItemID) { item in
                item.performance = updatedPerformance
            }

            await logStore.logPrediction(
                analysis: analysis,
                response: response,
                captureSource: captureSource,
                cameraZoomFactor: Double(cameraController.currentZoomLevel),
                enqueueArtifactUpload: artifactUploadsEnabled
            )
            Task {
                await self.flushPendingBackendQueues()
            }

            if let bestMatch = response.bestMatch, shouldAutoAccept(response) {
                completeSelection(with: bestMatch, correctionType: .acceptedTop)
            } else if response.bestMatch != nil {
                updateStackItem(id: pendingItemID) { item in
                    let disposition = response.reviewDisposition ?? .needsReview
                    item.phase = matchedStackPhase(for: response)
                    item.reviewDisposition = disposition
                    item.reviewReason = response.reviewReason
                    if item.phase == .resolved {
                        item.statusMessage = ScanTrayCalculator.initialStatusMessage(for: item.pricing)
                    } else {
                        item.statusMessage = response.reviewReason ?? "Could not identify the card strongly enough."
                    }
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
            ScanStageArtifactWriter.recordFinalDecisionArtifact(
                scanID: scanID,
                stage: "frontend_backend_error",
                payload: FrontendBackendErrorArtifact(
                    scanID: scanID.uuidString,
                    errorType: String(describing: type(of: error)),
                    message: error.localizedDescription,
                    pipelineVersion: analysis.ocrAnalysis?.pipelineVersion.rawValue,
                    resolverModeHint: analysis.resolverModeHint.rawValue,
                    collectorNumber: analysis.collectorNumber,
                    setHintTokens: analysis.setHintTokens,
                    warnings: analysis.warnings
                )
            )
            errorMessage = error.localizedDescription
            markPendingScanFailed(itemID: pendingItemID, message: "Could not identify card")
            resetPendingScanState()
        }
    }

    private func logBackendResponseSummary(_ response: ScanMatchResponse, matchMs: Double) {
        let bestCandidate = response.bestMatch
        print(
            "🌐 [MATCH] Response: "
            + "matchMs=\(Int(matchMs.rounded())) "
            + "confidence=\(response.confidence.rawValue) "
            + "resolverMode=\(response.resolverMode.rawValue) "
            + "resolverPath=\(response.resolverPath?.rawValue ?? "n/a") "
            + "review=\(response.reviewDisposition?.rawValue ?? "n/a") "
            + "topCount=\(response.topCandidates.count)"
        )
        print(
            "🌐 [MATCH] Best candidate: "
            + "id=\(bestCandidate?.id ?? "n/a") "
            + "name=\(quoted(bestCandidate?.name)) "
            + "number=\(quoted(bestCandidate?.number)) "
            + "set=\(quoted(bestCandidate?.setName)) "
            + "reviewReason=\(quoted(response.reviewReason)) "
            + "ambiguityFlags=\(response.ambiguityFlags)"
        )
    }

    private func formatFieldConfidence(_ confidence: OCRFieldConfidence?) -> String {
        formatDouble(confidence?.score)
    }

    private func formatDouble(_ value: Double?) -> String {
        guard let value else { return "n/a" }
        return String(format: "%.2f", value)
    }

    private func quoted(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "\"\"" }
        return "\"\(value)\""
    }
}

func shouldAutoAccept(_ response: ScanMatchResponse) -> Bool {
    guard response.resolverMode == .rawCard else {
        return false
    }

    switch response.confidence {
    case .high:
        return true
    case .medium, .low:
        return false
    }
}

func matchedStackPhase(for response: ScanMatchResponse) -> LiveScanStackItemPhase {
    let disposition = response.reviewDisposition ?? .needsReview
    if disposition == .unsupported {
        return .unsupported
    }
    if response.confidence == .low || disposition == .needsReview {
        return .needsReview
    }
    return .resolved
}

func shouldPresentAlternativesImmediately(for response: ScanMatchResponse) -> Bool {
    false
}

private func normalizedNonEmpty(_ value: String?) -> String? {
    guard let value else {
        return nil
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

struct ResultCandidateCycleState: Equatable {
    let currentIndex: Int
    let totalCount: Int
}

func resultCandidateCycleState(
    currentCardID: String?,
    topCandidates: [CardCandidate]
) -> ResultCandidateCycleState? {
    guard topCandidates.count > 1,
          let currentCardID,
          let currentIndex = topCandidates.firstIndex(where: { $0.id == currentCardID }) else {
        return nil
    }

    return ResultCandidateCycleState(
        currentIndex: currentIndex + 1,
        totalCount: topCandidates.count
    )
}

func nextResultCandidate(
    currentCardID: String?,
    topCandidates: [CardCandidate]
) -> CardCandidate? {
    guard topCandidates.count > 1 else {
        return nil
    }

    guard let currentCardID,
          let currentIndex = topCandidates.firstIndex(where: { $0.id == currentCardID }) else {
        return topCandidates.first
    }

    let nextIndex = (currentIndex + 1) % topCandidates.count
    return topCandidates[nextIndex]
}

private struct FrontendOCRSummaryArtifact: Codable {
    let scanID: String
    let resolverModeHint: String
    let captureSource: String
    let analysisMs: Double
    let cropConfidence: Double
    let pipelineVersion: String?
    let selectedMode: String?
    let geometryKind: String?
    let usedFallback: Bool?
    let targetQualityScore: Double?
    let collectorNumber: String?
    let setHintTokens: [String]
    let setBadgeHint: OCRSetBadgeHint?
    let warnings: [String]
    let shouldRetryWithStillPhoto: Bool
    let stillPhotoRetryReason: String?
    let rawEvidence: OCRRawEvidence?
    let slabEvidence: OCRSlabEvidence?
}

private struct FrontendBackendRequestArtifact: Codable {
    let scanID: String
    let resolverModeHint: String
    let rawResolverMode: String?
    let pipelineVersion: String?
    let imageWidth: Int
    let imageHeight: Int
    let recognizedTokenCount: Int
    let cropConfidence: Double
    let collectorNumber: String?
    let collectorNumberPartial: String?
    let setHintTokens: [String]
    let setBadgeHint: OCRSetBadgeHint?
    let titleTextPrimary: String?
    let titleTextSecondary: String?
    let ocrAnalysisIncluded: Bool
    let warnings: [String]
}

private struct FrontendBackendCandidateArtifact: Codable {
    let id: String
    let name: String
    let setName: String
    let number: String
    let finalScore: Double
}

private struct FrontendBackendResponseArtifact: Codable {
    let scanID: String
    let matchMs: Double
    let serverProcessingMs: Double?
    let networkOverheadMs: Double?
    let scrydexRequestCount: Int?
    let scrydexRequestTypes: [String]?
    let confidence: String
    let resolverMode: String
    let resolverPath: String?
    let reviewDisposition: String?
    let reviewReason: String?
    let ambiguityFlags: [String]
    let topCandidates: [FrontendBackendCandidateArtifact]
}

private struct FrontendBackendErrorArtifact: Codable {
    let scanID: String
    let errorType: String
    let message: String
    let pipelineVersion: String?
    let resolverModeHint: String
    let collectorNumber: String?
    let setHintTokens: [String]
    let warnings: [String]
}
