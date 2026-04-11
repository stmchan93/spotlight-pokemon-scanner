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

    private let ocrPipeline: OCRPipelineCoordinator
    private let matcher: CardMatchingService
    private let logStore: ScanEventStore
    private var currentScanID: UUID?
    private var currentPendingItemID: UUID?
    private var currentScanStartedAt: TimeInterval?
    private var currentReticleRect: CGRect?
    private var idlePricingRefreshTask: Task<Void, Never>?
    private var hasShownPhotoSaveFailureBanner = false

    private var selectedResolverMode: ResolverMode {
        scannerPresentationMode == .slab ? .psaSlab : .rawCard
    }

    init(
        cameraController: CameraSessionController,
        ocrPipeline: OCRPipelineCoordinator,
        matcher: CardMatchingService,
        logStore: ScanEventStore
    ) {
        self.cameraController = cameraController
        self.ocrPipeline = ocrPipeline
        self.matcher = matcher
        self.logStore = logStore

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

    private func processCapturedInput(_ capture: ScanCaptureInput) {
        guard !isProcessing else { return }
        isCapturingPhoto = false
        let scanID = currentScanID ?? UUID()
        let previewImage = capture.fallbackImage ?? capture.searchImage
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

    private func handleScannedCapture(
        _ capture: ScanCaptureInput,
        scanID: UUID? = nil,
        pendingItemID: UUID? = nil,
        scanStartedAt: TimeInterval? = nil
    ) async {
        print("🔍 [SCAN] Starting handleScannedCapture")
        isCapturingPhoto = false
        errorMessage = nil
        route = .scanner
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
        let previewImage = processedCapture.fallbackImage ?? processedCapture.searchImage
        let effectivePendingItemID = pendingItemID ?? currentPendingItemID ?? enqueuePendingScan(scanID: effectiveScanID, previewImage: previewImage)
        let effectiveScanStartedAt = scanStartedAt ?? currentScanStartedAt ?? Date().timeIntervalSinceReferenceDate
        currentScanID = effectiveScanID
        currentPendingItemID = effectivePendingItemID
        currentScanStartedAt = effectiveScanStartedAt
        updateStackItem(id: effectivePendingItemID) { item in
            if item.previewImage == nil {
                item.previewImage = downscaleImage(previewImage, maxDimension: 300)
            }
            item.statusMessage = "Identifying card..."
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
                performance: performance
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
        currentReticleRect = nil
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
        guard item.phase == .resolved || item.phase == .needsReview else { return false }
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
            if let bestMatch = response.bestMatch {
                item.card = bestMatch
                item.detail = nil
                item.pricingContextNote = pricingContextNote(
                    for: response.resolverMode,
                    matcherSource: response.matcherSource,
                    slabContext: response.slabContext,
                    pricing: bestMatch.pricing
                )
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
        performance: ScanPerformanceMetrics
    ) async {
        do {
            print("🔍 [SCAN] Using backend match...")
            print(
                "🌐 [MATCH] Request: "
                + "scanID=\(scanID.uuidString) "
                + "mode=\(analysis.resolverModeHint.rawValue) "
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
                    pipelineVersion: analysis.ocrAnalysis?.pipelineVersion.rawValue,
                    imageWidth: Int(analysis.normalizedImage.size.width.rounded()),
                    imageHeight: Int(analysis.normalizedImage.size.height.rounded()),
                    recognizedTokenCount: analysis.recognizedTokens.count,
                    cropConfidence: analysis.cropConfidence,
                    collectorNumber: analysis.collectorNumber,
                    collectorNumberPartial: analysis.ocrAnalysis?.rawEvidence?.collectorNumberPartial,
                    setHintTokens: analysis.setHintTokens,
                    titleTextPrimary: analysis.ocrAnalysis?.rawEvidence?.titleTextPrimary,
                    titleTextSecondary: analysis.ocrAnalysis?.rawEvidence?.titleTextSecondary,
                    ocrAnalysisIncluded: analysis.ocrAnalysis != nil,
                    warnings: analysis.warnings
                )
            )
            let matchStarted = Date().timeIntervalSinceReferenceDate
            let response = try await matcher.match(analysis: analysis)
            let matchMs = (Date().timeIntervalSinceReferenceDate - matchStarted) * 1000
            print("✅ [SCAN] Backend match completed in \(matchMs)ms")
            logBackendResponseSummary(response, matchMs: matchMs)
            ScanStageArtifactWriter.recordFinalDecisionArtifact(
                scanID: scanID,
                stage: "frontend_backend_response",
                payload: FrontendBackendResponseArtifact(
                    scanID: scanID.uuidString,
                    matchMs: matchMs,
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
                if let bestMatch = response.bestMatch {
                    scheduleIdlePricingRefresh(for: pendingItemID, cardID: bestMatch.id)
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
    let warnings: [String]
    let shouldRetryWithStillPhoto: Bool
    let stillPhotoRetryReason: String?
    let rawEvidence: OCRRawEvidence?
    let slabEvidence: OCRSlabEvidence?
}

private struct FrontendBackendRequestArtifact: Codable {
    let scanID: String
    let resolverModeHint: String
    let pipelineVersion: String?
    let imageWidth: Int
    let imageHeight: Int
    let recognizedTokenCount: Int
    let cropConfidence: Double
    let collectorNumber: String?
    let collectorNumberPartial: String?
    let setHintTokens: [String]
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
