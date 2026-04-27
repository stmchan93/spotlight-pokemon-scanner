import Foundation
import SwiftUI
import UIKit
import CryptoKit

private struct ScanAlternativesContext {
    let itemID: UUID
    let scanID: UUID
    let previewImage: UIImage?
    let analysis: AnalyzedCapture?
    let response: ScanMatchResponse
}

@MainActor
final class ScannerViewModel: ObservableObject {
    typealias OCRPipelineFactory = @Sendable () -> OCRPipelineCoordinator

    @Published var route: ScannerRoute = .scanner
    @Published var isCapturingPhoto = false
    @Published var isProcessing = false
    @Published var errorMessage: String?
    @Published var bannerMessage: String?
    @Published var analyzedCapture: AnalyzedCapture?
    @Published var matchResponse: ScanMatchResponse?
    @Published var searchQuery = ""
    @Published var searchResults: [CardCandidate] = []
    @Published var scanJobs: [ScanJob] = []
    @Published var scannedItems: [LiveScanStackItem] = []
    @Published var scannerPresentationMode: ScannerPresentationMode = .raw

    let cameraController: CameraSessionController

    private let ocrPipelineFactory: OCRPipelineFactory
    private let matcher: CardMatchingService
    private let logStore: ScanEventStore
    private let artifactUploadsEnabled: Bool
    private var hasShownPhotoSaveFailureBanner = false
    private var alternativesContexts: [UUID: ScanAlternativesContext] = [:]
    private var activeAlternativesItemID: UUID?
    private var activeResultItemID: UUID?
    private var activeResultPreviewItem: LiveScanStackItem?
    private var scanTasks: [UUID: Task<Void, Never>] = [:]
    private var activeCaptureJobIDs = Set<UUID>()
    private var activeProcessingJobIDs = Set<UUID>()
    private var recentScanFingerprints: [String: Date] = [:]
    private let duplicateScanCooldownSeconds: TimeInterval = 0.9
    private let maxRetainedScanCount = 20

    private var selectedResolverMode: ResolverMode {
        scannerPresentationMode == .slab ? .psaSlab : .rawCard
    }
    private var navigationState = ScannerNavigationState()

    init(
        cameraController: CameraSessionController,
        ocrPipelineFactory: @escaping OCRPipelineFactory,
        matcher: CardMatchingService,
        logStore: ScanEventStore,
        artifactUploadsEnabled: Bool = true
    ) {
        self.cameraController = cameraController
        self.ocrPipelineFactory = ocrPipelineFactory
        self.matcher = matcher
        self.logStore = logStore
        self.artifactUploadsEnabled = artifactUploadsEnabled

        self.cameraController.onImageCapturedForRequest = { [weak self] result in
            self?.processCapturedInput(scanID: result.scanID, capture: result.captureInput)
        }
        self.cameraController.onCaptureFailedForRequest = { [weak self] failure in
            self?.handleCaptureFailure(scanID: failure.scanID, message: failure.message)
        }
        self.cameraController.onCaptureSavedToPhotoLibrary = { [weak self] success, message in
            self?.handlePhotoLibrarySaveResult(success: success, message: message)
        }
    }

    var stackCountText: String {
        trayMetrics.countLabel
    }

    var visibleScannedItems: [LiveScanStackItem] {
        scannedItems
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
        guard isValidReticleCaptureRect(reticleRect) else {
            errorMessage = "Scanner overlay is still loading. Try again."
            return
        }
        errorMessage = nil

        let scanID = UUID()
        let pendingItemID = enqueuePendingScan(scanID: scanID, previewImage: nil)
        insertScanJob(
            ScanJob(
                id: pendingItemID,
                scanID: scanID,
                status: .pending,
                capturedImage: nil,
                captureInput: nil,
                analysis: nil,
                result: nil,
                errorMessage: nil,
                startedAt: Date().timeIntervalSinceReferenceDate,
                reticleRect: reticleRect,
                dedupFingerprint: nil
            )
        )
        setCaptureState(true, for: pendingItemID)

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
            AppFeedback.cameraCapture()
            updateStackItem(id: pendingItemID) { item in
                item.statusMessage = "Capturing preview frame…"
            }
        } else {
            setCaptureState(false, for: pendingItemID)
            markPendingScanFailed(itemID: pendingItemID, message: "Could not capture card")
            errorMessage = cameraController.lastErrorMessage ?? "Could not capture card"
        }
    }

    func toggleTorch() {
        cameraController.toggleTorch()
    }

    func processImportedPhoto(_ image: UIImage) {
        let scanID = UUID()
        let capture = ScanCaptureInput(
                originalImage: image,
                searchImage: image,
                fallbackImage: nil,
                captureSource: .importedPhoto
            )
        let pendingItemID = enqueuePendingScan(scanID: scanID, previewImage: capture.trayPreviewImage)
        insertScanJob(
            ScanJob(
                id: pendingItemID,
                scanID: scanID,
                status: .pending,
                capturedImage: capture.trayPreviewImage,
                captureInput: nil,
                analysis: nil,
                result: nil,
                errorMessage: nil,
                startedAt: Date().timeIntervalSinceReferenceDate,
                reticleRect: nil,
                dedupFingerprint: nil
            )
        )
        processCapturedInput(scanID: scanID, capture: capture)
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

    private func processCapturedInput(scanID: UUID, capture: ScanCaptureInput) {
        guard let job = scanJob(forScanID: scanID) else { return }

        let resolverMode = selectedResolverMode
        let preparedCapture = prepareCaptureForProcessing(capture, resolverMode: resolverMode)
        let previewImage = preparedCapture.trayPreviewImage
        let fingerprint = captureFingerprint(for: previewImage)

        updateScanJob(id: job.id) { mutableJob in
            mutableJob.capturedImage = previewImage
            mutableJob.captureInput = preparedCapture
            mutableJob.errorMessage = nil
            if mutableJob.dedupFingerprint == nil {
                mutableJob.dedupFingerprint = fingerprint
            }
        }
        updateStackItem(id: job.id) { item in
            if item.previewImage == nil {
                item.previewImage = downscaleImage(previewImage, maxDimension: 300)
            }
            item.statusMessage = "Reading card…"
        }

        setCaptureState(false, for: job.id)

        if job.captureInput == nil,
           preparedCapture.captureSource != .importedPhoto,
           shouldSuppressDuplicateScan(fingerprint: fingerprint, excluding: job.id) {
            showBanner("Duplicate scan skipped")
            markPendingScanFailed(itemID: job.id, message: "Duplicate scan skipped")
            return
        }

        setProcessingState(true, for: job.id)
        let startedAt = job.startedAt
        scanTasks[job.id]?.cancel()
        scanTasks[job.id] = Task { [weak self] in
            guard let self else { return }
            await self.handleScannedCapture(
                preparedCapture,
                jobID: job.id,
                scanID: scanID,
                scanStartedAt: startedAt
            )
            _ = await MainActor.run {
                self.scanTasks.removeValue(forKey: job.id)
            }
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
            ?? activeAlternativesContext?.analysis?.originalImage
            ?? activeAlternativesContext?.analysis?.normalizedImage
    }

    var activeAlternativesResponse: ScanMatchResponse? {
        activeAlternativesContext?.response
    }

    func presentResultDetail(for itemID: UUID) {
        guard scannedItems.contains(where: { $0.id == itemID }) else { return }
        spotlightFlowLog("ScannerViewModel presentResultDetail scannedItem itemID=\(itemID)")
        activeResultPreviewItem = nil
        activeResultItemID = itemID
        pushRoute(.resultDetail)
    }

    func presentResultDetail(for entry: DeckCardEntry) {
        spotlightFlowLog("ScannerViewModel presentResultDetail deckEntry id=\(entry.id) cardID=\(entry.card.id)")
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
        spotlightFlowLog("ScannerViewModel dismissResultDetail route=\(String(describing: route)) activeResultItem=\(activeResultItemID?.uuidString ?? "nil") previewItem=\(activeResultPreviewItem?.id.uuidString ?? "nil")")
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

        for itemID in itemIDSet {
            scanTasks[itemID]?.cancel()
            scanTasks.removeValue(forKey: itemID)
            activeCaptureJobIDs.remove(itemID)
            activeProcessingJobIDs.remove(itemID)
        }
        syncActivityFlags()

        let removedActiveAlternatives = activeAlternativesItemID.map(itemIDSet.contains) ?? false
        let removedActiveResult = activeResultItemID.map(itemIDSet.contains) ?? false

        for itemID in itemIDSet {
            alternativesContexts.removeValue(forKey: itemID)
        }
        scanJobs.removeAll { itemIDSet.contains($0.id) }

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
        for task in scanTasks.values {
            task.cancel()
        }
        scanTasks.removeAll()
        activeCaptureJobIDs.removeAll()
        activeProcessingJobIDs.removeAll()
        syncActivityFlags()
        alternativesContexts.removeAll()
        activeAlternativesItemID = nil
        activeResultItemID = nil
        activeResultPreviewItem = nil
        resetRouteToScanner()
        withAnimation(.spring(response: 0.28, dampingFraction: 0.9)) {
            scanJobs.removeAll()
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

    func retryScan(for itemID: UUID) {
        guard let job = scanJob(id: itemID) else { return }

        let retriedScanID = UUID()
        let startedAt = Date().timeIntervalSinceReferenceDate
        updateScanJob(id: itemID) { mutableJob in
            mutableJob.scanID = retriedScanID
            mutableJob.status = .pending
            mutableJob.analysis = nil
            mutableJob.result = nil
            mutableJob.errorMessage = nil
            mutableJob.startedAt = startedAt
        }
        alternativesContexts.removeValue(forKey: itemID)
        updateStackItem(id: itemID) { item in
            item.phase = .pending
            item.isProvisional = false
            item.card = nil
            item.detail = nil
            item.confidence = .medium
            item.matcherSource = .remoteHybrid
            item.matcherVersion = "pending"
            item.resolverMode = .unknownFallback
            item.resolverPath = nil
            item.slabContext = nil
            item.reviewDisposition = .ready
            item.reviewReason = nil
            item.isRefreshingPrice = false
            item.statusMessage = "Retrying scan…"
            item.pricingContextNote = nil
            item.performance = nil
            item.cacheStatus = nil
            item.selectedRank = nil
            item.wasTopPrediction = false
            item.selectionSource = .unknown
            item.availableVariants = []
            item.selectedVariant = nil
            item.variantPricingOverride = nil
            item.isLoadingVariants = false
        }

        if let capture = job.captureInput {
            setProcessingState(true, for: itemID)
            scanTasks[itemID]?.cancel()
            scanTasks[itemID] = Task { [weak self] in
                guard let self else { return }
                await self.handleScannedCapture(
                    capture,
                    jobID: itemID,
                    scanID: retriedScanID,
                    scanStartedAt: startedAt
                )
                _ = await MainActor.run {
                    self.scanTasks.removeValue(forKey: itemID)
                }
            }
            return
        }

        guard let reticleRect = job.reticleRect else {
            markPendingScanFailed(itemID: itemID, message: "Capture a new frame to retry")
            return
        }

        setCaptureState(true, for: itemID)
        let didStartCapture = cameraController.capturePhoto(
            scanID: retriedScanID,
            reticleRect: reticleRect,
            preferStillPhoto: false
        )
        if !didStartCapture {
            setCaptureState(false, for: itemID)
            markPendingScanFailed(itemID: itemID, message: "Could not capture card")
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
        jobID: UUID,
        scanID: UUID,
        scanStartedAt: TimeInterval
    ) async {
        print("🔍 [SCAN] Starting handleScannedCapture")
        errorMessage = nil
        let resolverMode = selectedResolverMode
        let processedCapture = capture
        updateScanJob(id: jobID) { job in
            job.captureInput = processedCapture
            job.capturedImage = processedCapture.trayPreviewImage
            job.errorMessage = nil
        }
        updateStackItem(id: jobID) { item in
            if item.previewImage == nil {
                item.previewImage = downscaleImage(processedCapture.trayPreviewImage, maxDimension: 300)
            }
            item.statusMessage = "Reading card…"
        }

        var preparedTargetSelection: OCRTargetSelectionResult?
        var preparedTargetSelectionMs: Double?
        var visualStartTask: Task<(response: ScanMatchResponse?, durationMs: Double), Never>?

        do {
            print("🔍 [SCAN] Starting Vision analysis...")
            let analysisStarted = Date().timeIntervalSinceReferenceDate
            let tapToAnalysisStartMs = (analysisStarted - scanStartedAt) * 1000
            print("⏱️ [SCAN] Tap to OCR start: \(tapToAnalysisStartMs)ms")
            let ocrPipeline = ocrPipelineFactory()

            if resolverMode == .rawCard {
                let targetSelectionStartedAt = Date().timeIntervalSinceReferenceDate
                let targetSelection = try await ocrPipeline.prepareRawTargetSelection(
                    scanID: scanID,
                    capture: processedCapture
                )
                let targetSelectionMs = (Date().timeIntervalSinceReferenceDate - targetSelectionStartedAt) * 1000
                preparedTargetSelection = targetSelection
                preparedTargetSelectionMs = targetSelectionMs

                let visualPayload = makeVisualStartPayload(
                    scanID: scanID,
                    resolverMode: resolverMode,
                    targetSelection: targetSelection
                )
                let visualRequestStartedAt = Date().timeIntervalSinceReferenceDate
                print(
                    "🌐 [MATCH] Starting visual phase: "
                    + "scanID=\(scanID.uuidString) "
                    + "targetSelectionMs=\(Int(targetSelectionMs.rounded())) "
                    + "crop=\(String(format: "%.2f", targetSelection.selectionConfidence)) "
                    + "warnings=\(visualPayload.warnings)"
                )
                visualStartTask = Task.detached(priority: .userInitiated) { [matcher = self.matcher] in
                    do {
                        let response = try await matcher.matchVisualStart(payload: visualPayload)
                        let durationMs = (Date().timeIntervalSinceReferenceDate - visualRequestStartedAt) * 1000
                        return (response, durationMs)
                    } catch is CancellationError {
                        return (nil, (Date().timeIntervalSinceReferenceDate - visualRequestStartedAt) * 1000)
                    } catch {
                        print("⚠️ [SCAN] Visual start failed: \(error.localizedDescription)")
                        return (nil, (Date().timeIntervalSinceReferenceDate - visualRequestStartedAt) * 1000)
                    }
                }
            }

            // Add timeout to prevent indefinite hanging on complex images
            let preparedTargetSelectionForTask = preparedTargetSelection
            let preparedTargetSelectionMsForTask = preparedTargetSelectionMs
            let analysis = try await withThrowingTaskGroup(of: AnalyzedCapture.self) { group in
                group.addTask { [ocrPipeline, resolverMode, scanID, processedCapture, preparedTargetSelectionForTask, preparedTargetSelectionMsForTask] in
                    if resolverMode == .rawCard,
                       let targetSelection = preparedTargetSelectionForTask,
                       let targetSelectionMs = preparedTargetSelectionMsForTask {
                        return try await ocrPipeline.analyzePreparedRawScan(
                            scanID: scanID,
                            capture: processedCapture,
                            targetSelection: targetSelection,
                            resolverModeHint: resolverMode,
                            targetSelectionMs: targetSelectionMs
                        )
                    }

                    return try await ocrPipeline.analyze(
                        scanID: scanID,
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
            if let preparedTargetSelectionMs {
                print(
                    "⏱️ [SCAN] Raw pipeline front-half: "
                    + "scanID=\(scanID.uuidString) "
                    + "targetSelectionMs=\(Int(preparedTargetSelectionMs.rounded())) "
                    + "ocrOnlyMs=\(Int(max(0, analysisMs - preparedTargetSelectionMs).rounded()))"
                )
            }
            logOCRSummary(
                analysis,
                captureSource: processedCapture.captureSource,
                analysisMs: analysisMs
            )

            if analysis.shouldRetryWithStillPhoto,
               let reticleRect = scanJob(id: jobID)?.reticleRect {
                print("🔁 [SCAN] Retrying with still photo: \(analysis.stillPhotoRetryReason ?? "footer OCR weak")")
                updateStackItem(id: jobID) { item in
                    item.statusMessage = "Trying a sharper capture…"
                }
                setProcessingState(false, for: jobID)
                setCaptureState(true, for: jobID)
                visualStartTask?.cancel()
                let didStartRetry = cameraController.capturePhoto(
                    scanID: scanID,
                    reticleRect: reticleRect,
                    preferStillPhoto: true
                )
                if didStartRetry {
                    return
                }
                print("⚠️ [SCAN] Still-photo retry could not start; continuing with current analysis")
                setCaptureState(false, for: jobID)
                setProcessingState(true, for: jobID)
            }

            print("🔍 [SCAN] Sending scan to backend matcher...")

            let performance = ScanPerformanceMetrics(
                analysisMs: analysisMs,
                matchMs: 0,  // Will be updated if backend is used
                totalMs: tapToAnalysisStartMs + analysisMs
            )

            await fallbackToBackendMatch(
                analysis: analysis,
                scanID: scanID,
                pendingItemID: jobID,
                performance: performance,
                captureSource: processedCapture.captureSource,
                visualStartTask: visualStartTask
            )
        } catch {
            print("❌ [SCAN] Error: \(error.localizedDescription)")
            visualStartTask?.cancel()
            errorMessage = error.localizedDescription
            markPendingScanFailed(itemID: jobID, message: "Could not identify card")
        }

        print("🔍 [SCAN] Finished handleScannedCapture")
        setCaptureState(false, for: jobID)
        setProcessingState(false, for: jobID)
    }

    private func completeSelection(with candidate: CardCandidate, correctionType: CorrectionType) {
        let context = activeAlternativesContext
        guard let itemID = activeResultItemID ?? context?.itemID,
              let scanID = scanJob(id: itemID)?.scanID ?? context?.scanID else { return }

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
        updateScanJob(id: itemID) { job in
            job.status = .resolved
            job.errorMessage = nil
        }

        withAnimation(.easeOut(duration: 0.18)) {
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
        let previousRoute = navigationState.currentRoute
        withAnimation(.easeInOut(duration: 0.18)) {
            navigationState.push(nextRoute)
            route = navigationState.currentRoute
            syncNavigationStateForCurrentRoute()
        }
        spotlightFlowLog("ScannerRoute push \(String(describing: previousRoute)) -> \(String(describing: route))")
    }

    private func popRoute() {
        let previousRoute = navigationState.currentRoute
        withAnimation(.easeInOut(duration: 0.18)) {
            navigationState.pop()
            route = navigationState.currentRoute
            syncNavigationStateForCurrentRoute()
        }
        spotlightFlowLog("ScannerRoute pop \(String(describing: previousRoute)) -> \(String(describing: route))")
    }

    private func resetRouteToScanner() {
        let previousRoute = navigationState.currentRoute
        withAnimation(.easeInOut(duration: 0.18)) {
            navigationState.resetToScanner()
            route = navigationState.currentRoute
            syncNavigationStateForCurrentRoute()
        }
        spotlightFlowLog("ScannerRoute reset \(String(describing: previousRoute)) -> \(String(describing: route))")
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
        searchQuery = ""
        searchResults = []
        errorMessage = nil
    }

    private func handleCaptureFailure(scanID: UUID?, message: String) {
        guard let itemID = scanID.flatMap({ scanJob(forScanID: $0)?.id }) ?? activeCaptureJobIDs.first else {
            errorMessage = message
            return
        }

        setCaptureState(false, for: itemID)
        setProcessingState(false, for: itemID)
        markPendingScanFailed(itemID: itemID, message: "Could not capture card")
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

    private func updateScanJob(id jobID: UUID, mutate: (inout ScanJob) -> Void) {
        guard let index = scanJobs.firstIndex(where: { $0.id == jobID }) else { return }
        mutate(&scanJobs[index])
    }

    private func scanJob(id jobID: UUID) -> ScanJob? {
        scanJobs.first(where: { $0.id == jobID })
    }

    private func scanJob(forScanID scanID: UUID) -> ScanJob? {
        scanJobs.first(where: { $0.scanID == scanID })
    }

    private func insertScanJob(_ job: ScanJob) {
        scanJobs.insert(job, at: 0)
        if scanJobs.count > maxRetainedScanCount {
            scanJobs = Array(scanJobs.prefix(maxRetainedScanCount))
        }
        syncActivityFlags()
    }

    private func setCaptureState(_ active: Bool, for jobID: UUID) {
        if active {
            activeCaptureJobIDs.insert(jobID)
        } else {
            activeCaptureJobIDs.remove(jobID)
        }
        syncActivityFlags()
    }

    private func setProcessingState(_ active: Bool, for jobID: UUID) {
        if active {
            activeProcessingJobIDs.insert(jobID)
        } else {
            activeProcessingJobIDs.remove(jobID)
        }
        syncActivityFlags()
    }

    private func syncActivityFlags() {
        isCapturingPhoto = !activeCaptureJobIDs.isEmpty
        isProcessing = !activeProcessingJobIDs.isEmpty || scanJobs.contains(where: { $0.status == .pending })
    }

    private func prepareCaptureForProcessing(
        _ capture: ScanCaptureInput,
        resolverMode: ResolverMode
    ) -> ScanCaptureInput {
        let originalMaxDimension: CGFloat = (resolverMode == .rawCard && capture.captureSource == .liveStillPhoto) ? 1800 : 1400
        let searchMaxDimension: CGFloat = (resolverMode == .rawCard && capture.captureSource == .liveStillPhoto) ? 1600 : 1200

        return ScanCaptureInput(
            originalImage: downscaleImage(capture.originalImage, maxDimension: originalMaxDimension),
            searchImage: downscaleImage(capture.searchImage, maxDimension: searchMaxDimension),
            fallbackImage: capture.fallbackImage.map { downscaleImage($0, maxDimension: searchMaxDimension) },
            captureSource: capture.captureSource
        )
    }

    private func captureFingerprint(for image: UIImage) -> String? {
        let fingerprintImage = downscaleImage(image, maxDimension: 48)
        guard let data = fingerprintImage.jpegData(compressionQuality: 0.35) else {
            return nil
        }
        let digest = SHA256.hash(data: data)
        return digest.compactMap { String(format: "%02x", $0) }.joined()
    }

    private func shouldSuppressDuplicateScan(fingerprint: String?, excluding jobID: UUID) -> Bool {
        guard let fingerprint, !fingerprint.isEmpty else { return false }

        let now = Date()
        recentScanFingerprints = recentScanFingerprints.filter {
            now.timeIntervalSince($0.value) <= duplicateScanCooldownSeconds
        }

        let isDuplicate = recentScanFingerprints[fingerprint].map {
            now.timeIntervalSince($0) <= duplicateScanCooldownSeconds
        } ?? false

        if !isDuplicate {
            recentScanFingerprints[fingerprint] = now
        } else {
            updateScanJob(id: jobID) { job in
                job.dedupFingerprint = fingerprint
            }
        }

        return isDuplicate
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

    private func applyAnalysis(response: ScanMatchResponse, to itemID: UUID, provisional: Bool = false) {
        updateScanJob(id: itemID) { job in
            job.result = response
            job.errorMessage = nil
            if !provisional {
                job.status = .resolved
            }
        }
        updateStackItem(id: itemID) { item in
            // Keep existing thumbnail, don't replace with full-res image
            item.isProvisional = provisional
            item.confidence = response.confidence
            item.matcherSource = response.matcherSource
            item.matcherVersion = response.matcherVersion
            item.resolverMode = response.resolverMode
            item.resolverPath = response.resolverPath
            item.slabContext = response.slabContext
            item.reviewDisposition = provisional ? .needsReview : response.reviewDisposition ?? .ready
            item.reviewReason = provisional ? (response.reviewReason ?? "Confirming card text…") : response.reviewReason
            if let bestMatch = response.bestMatch {
                item.card = bestMatch
                item.detail = nil
                item.selectedRank = provisional ? response.topCandidates.first?.rank : 1
                item.wasTopPrediction = !provisional
                item.selectionSource = provisional ? .unknown : .topPrediction
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
            if provisional {
                item.phase = .needsReview
                item.statusMessage = response.reviewReason ?? "Confirming card text…"
                item.isRefreshingPrice = false
            }
        }
    }

    private func markPendingScanFailed(itemID: UUID, message: String) {
        alternativesContexts.removeValue(forKey: itemID)
        updateScanJob(id: itemID) { job in
            job.status = .failed
            job.errorMessage = message
        }
        updateStackItem(id: itemID) { item in
            item.isProvisional = false
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

    private func makeRerankPayload(from analysis: AnalyzedCapture) -> ScanRerankRequestPayload {
        ScanRerankRequestPayload(
            scanID: analysis.scanID,
            capturedAt: Date(),
            clientContext: .current(),
            image: ScanImagePayload(
                jpegBase64: nil,
                width: Int(analysis.normalizedImage.size.width.rounded()),
                height: Int(analysis.normalizedImage.size.height.rounded())
            ),
            recognizedTokens: analysis.recognizedTokens,
            collectorNumber: analysis.collectorNumber,
            setHintTokens: analysis.setHintTokens,
            setBadgeHint: analysis.setBadgeHint,
            promoCodeHint: analysis.promoCodeHint,
            slabGrader: analysis.slabGrader,
            slabGrade: analysis.slabGrade,
            slabCertNumber: analysis.slabCertNumber,
            slabBarcodePayloads: analysis.slabBarcodePayloads,
            slabGraderConfidence: analysis.slabGraderConfidence,
            slabGradeConfidence: analysis.slabGradeConfidence,
            slabCertConfidence: analysis.slabCertConfidence,
            slabCardNumberRaw: analysis.slabCardNumberRaw,
            slabParsedLabelText: analysis.slabParsedLabelText,
            slabClassifierReasons: analysis.slabClassifierReasons,
            slabRecommendedLookupPath: analysis.slabRecommendedLookupPath,
            resolverModeHint: analysis.resolverModeHint,
            rawResolverMode: analysis.resolverModeHint.runtimeRawResolverMode,
            cropConfidence: analysis.cropConfidence,
            warnings: analysis.warnings,
            ocrAnalysis: analysis.ocrAnalysis
        )
    }

    private func makeVisualStartPayload(
        scanID: UUID,
        resolverMode: ResolverMode,
        targetSelection: OCRTargetSelectionResult
    ) -> ScanVisualStartRequestPayload {
        var warnings = buildLegacyModeSanitySignals(
            selectedMode: resolverMode.ocrSelectedMode,
            targetSelection: targetSelection
        ).warnings
        if let normalizationReason = targetSelection.normalizationReason,
           !normalizationReason.isEmpty {
            warnings.append(normalizationReason)
        }

        let dedupedWarnings = Array(NSOrderedSet(array: warnings)) as? [String] ?? warnings
        return ScanVisualStartRequestPayload(
            scanID: scanID,
            capturedAt: Date(),
            clientContext: .current(),
            image: scanImagePayload(for: targetSelection.normalizedImage),
            resolverModeHint: resolverMode,
            rawResolverMode: .visual,
            cropConfidence: targetSelection.selectionConfidence,
            warnings: dedupedWarnings
        )
    }

    private func scanImagePayload(for image: UIImage) -> ScanImagePayload {
        image.downscaledJPEGPayload(maxDimension: 960, compressionQuality: 0.72)
            ?? ScanImagePayload(
                jpegBase64: nil,
                width: Int(image.size.width.rounded()),
                height: Int(image.size.height.rounded())
            )
    }

    private func fallbackToBackendMatch(
        analysis: AnalyzedCapture,
        scanID: UUID,
        pendingItemID: UUID,
        performance: ScanPerformanceMetrics,
        captureSource: ScanCaptureSource,
        visualStartTask: Task<(response: ScanMatchResponse?, durationMs: Double), Never>? = nil
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
            let rerankPayload = makeRerankPayload(from: analysis)
            let response: ScanMatchResponse
            let matchStage: ScanMatchStage
            var visualStageRoundTripMs: Double?
            var visualStageServerMs: Double?
            var visualStageTransportMs: Double?
            var visualWaitAfterOCRMs: Double?
            var resolutionRoundTripMs: Double?
            if analysis.resolverModeHint == .rawCard,
               let visualStartTask {
                let visualWaitStartedAt = Date().timeIntervalSinceReferenceDate
                let visualStartOutcome = await visualStartTask.value
                visualWaitAfterOCRMs = (Date().timeIntervalSinceReferenceDate - visualWaitStartedAt) * 1000
                let visualStartResponse = visualStartOutcome.response
                visualStageRoundTripMs = visualStartOutcome.durationMs
                visualStageServerMs = visualStartResponse?.performance?.serverProcessingMs
                visualStageTransportMs = zipOptional(visualStageRoundTripMs, visualStageServerMs).map { roundTripMs, serverMs in
                    max(0, roundTripMs - serverMs)
                }
                print(
                    "🌐 [MATCH] Visual phase outcome: "
                    + "scanID=\(scanID.uuidString) "
                    + "durationMs=\(Int(visualStartOutcome.durationMs.rounded())) "
                    + "available=\(visualStartResponse != nil ? "yes" : "no")"
                )
                if visualStartResponse != nil {
                    do {
                        print("🌐 [MATCH] Using cached visual shortlist for rerank")
                        let resolutionStartedAt = Date().timeIntervalSinceReferenceDate
                        response = try await matcher.matchRerank(payload: rerankPayload)
                        resolutionRoundTripMs = (Date().timeIntervalSinceReferenceDate - resolutionStartedAt) * 1000
                        matchStage = .reranked
                    } catch {
                        print("⚠️ [SCAN] Rerank match failed, falling back to one-shot match: \(error.localizedDescription)")
                        let resolutionStartedAt = Date().timeIntervalSinceReferenceDate
                        response = try await matcher.match(analysis: analysis)
                        resolutionRoundTripMs = (Date().timeIntervalSinceReferenceDate - resolutionStartedAt) * 1000
                        matchStage = .oneShot
                    }
                } else {
                    print("⚠️ [SCAN] Visual start unavailable, falling back to one-shot match")
                    let resolutionStartedAt = Date().timeIntervalSinceReferenceDate
                    response = try await matcher.match(analysis: analysis)
                    resolutionRoundTripMs = (Date().timeIntervalSinceReferenceDate - resolutionStartedAt) * 1000
                    matchStage = .oneShot
                }
            } else {
                let resolutionStartedAt = Date().timeIntervalSinceReferenceDate
                response = try await matcher.match(analysis: analysis)
                resolutionRoundTripMs = (Date().timeIntervalSinceReferenceDate - resolutionStartedAt) * 1000
                matchStage = .oneShot
            }
            let matchMs = (Date().timeIntervalSinceReferenceDate - matchStarted) * 1000
            let serverProcessingMs = response.performance?.serverProcessingMs
            let networkOverheadMs = serverProcessingMs.map { max(0, matchMs - $0) }
            print("✅ [SCAN] Backend match completed in \(matchMs)ms")
            let resolutionTransportMs = zipOptional(resolutionRoundTripMs, serverProcessingMs).map { roundTripMs, serverMs in
                max(0, roundTripMs - serverMs)
            }
            print(
                "⏱️ [MATCH] Split timings: "
                + "scanID=\(scanID.uuidString) "
                + "stage=\(matchStage.rawValue) "
                + "waitAfterOCRMs=\(formatTiming(visualWaitAfterOCRMs)) "
                + "visualRoundTripMs=\(formatTiming(visualStageRoundTripMs)) "
                + "visualServerMs=\(formatTiming(visualStageServerMs)) "
                + "visualTransportMs=\(formatTiming(visualStageTransportMs)) "
                + "resolutionRoundTripMs=\(formatTiming(resolutionRoundTripMs)) "
                + "resolutionServerMs=\(formatTiming(serverProcessingMs)) "
                + "resolutionTransportMs=\(formatTiming(resolutionTransportMs))"
            )
            let finalResponse = response.marking(provisional: false, stage: matchStage)
            logBackendResponseSummary(finalResponse, matchMs: matchMs)
            ScanStageArtifactWriter.recordFinalDecisionArtifact(
                scanID: scanID,
                stage: "frontend_backend_response",
                payload: FrontendBackendResponseArtifact(
                    scanID: scanID.uuidString,
                    matchMs: matchMs,
                    serverProcessingMs: serverProcessingMs,
                    networkOverheadMs: networkOverheadMs,
                    scrydexRequestCount: finalResponse.performance?.scrydexRequestCount,
                    scrydexRequestTypes: finalResponse.performance?.scrydexRequestTypes,
                    confidence: finalResponse.confidence.rawValue,
                    resolverMode: finalResponse.resolverMode.rawValue,
                    resolverPath: finalResponse.resolverPath?.rawValue,
                    reviewDisposition: finalResponse.reviewDisposition?.rawValue,
                    reviewReason: finalResponse.reviewReason,
                    ambiguityFlags: finalResponse.ambiguityFlags,
                    topCandidates: finalResponse.topCandidates.prefix(3).map { scored in
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
            if let bestMatch = finalResponse.bestMatch {
                logPricingSnapshot(prefix: "Backend best match", card: bestMatch)
            }

            let updatedPerformance = ScanPerformanceMetrics(
                analysisMs: performance.analysisMs,
                matchMs: matchMs,
                totalMs: performance.analysisMs + matchMs
            )

            updateScanJob(id: pendingItemID) { job in
                job.analysis = analysis
                job.result = finalResponse
                job.errorMessage = nil
                job.status = finalResponse.bestMatch == nil && (finalResponse.reviewDisposition ?? .ready) != .unsupported
                    ? .failed
                    : .resolved
            }
            if activeAlternativesItemID == pendingItemID || activeResultItemID == pendingItemID {
                analyzedCapture = analysis
                matchResponse = finalResponse
            }
            applyAnalysis(response: finalResponse, to: pendingItemID)
            alternativesContexts[pendingItemID] = ScanAlternativesContext(
                itemID: pendingItemID,
                scanID: scanID,
                previewImage: scannedItems.first(where: { $0.id == pendingItemID })?.previewImage,
                analysis: analysis,
                response: finalResponse
            )
            updateStackItem(id: pendingItemID) { item in
                item.performance = updatedPerformance
            }

            await logStore.logPrediction(
                analysis: analysis,
                response: finalResponse,
                captureSource: captureSource,
                cameraZoomFactor: Double(cameraController.currentZoomLevel),
                enqueueArtifactUpload: artifactUploadsEnabled
            )
            Task {
                await self.flushPendingBackendQueues()
            }

            if finalResponse.bestMatch != nil {
                updateStackItem(id: pendingItemID) { item in
                    let disposition = finalResponse.reviewDisposition ?? .needsReview
                    item.phase = matchedStackPhase(for: finalResponse)
                    item.reviewDisposition = disposition
                    item.reviewReason = finalResponse.reviewReason
                    if item.phase == .resolved {
                        item.statusMessage = ScanTrayCalculator.initialStatusMessage(for: item.pricing)
                    } else {
                        item.statusMessage = finalResponse.reviewReason ?? "Could not identify the card strongly enough."
                    }
                    item.isRefreshingPrice = false
                }
            } else {
                updateStackItem(id: pendingItemID) { item in
                    let disposition = finalResponse.reviewDisposition ?? .ready
                    item.phase = (disposition == .unsupported) ? .unsupported : .failed
                    item.reviewDisposition = disposition
                    item.reviewReason = finalResponse.reviewReason
                    item.statusMessage = finalResponse.reviewReason ?? "No matching cards found"
                    item.isRefreshingPrice = false
                }
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
        }
    }

    private func logBackendResponseSummary(_ response: ScanMatchResponse, matchMs: Double) {
        let bestCandidate = response.bestMatch
        print(
            "🌐 [MATCH] Response: "
            + "matchMs=\(Int(matchMs.rounded())) "
            + "stage=\(response.matchStage?.rawValue ?? "n/a") "
            + "provisional=\(response.isProvisional == true ? "yes" : "no") "
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

private func zipOptional<T, U>(_ lhs: T?, _ rhs: U?) -> (T, U)? {
    guard let lhs, let rhs else { return nil }
    return (lhs, rhs)
}

private func formatTiming(_ value: Double?) -> String {
    guard let value else { return "n/a" }
    return String(Int(value.rounded()))
}

func shouldAutoAccept(_ response: ScanMatchResponse) -> Bool {
    guard response.isProvisional != true else {
        return false
    }
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

func matchedStackPhase(for response: ScanMatchResponse, provisional: Bool = false) -> LiveScanStackItemPhase {
    if provisional {
        return .needsReview
    }
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
