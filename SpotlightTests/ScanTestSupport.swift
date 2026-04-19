import XCTest
import UIKit
@testable import Spotlight

@MainActor
func makeScannerViewModel(
    matcher: any CardMatchingService = StubCardMatchingService(),
    logStore: ScanEventStore = ScanEventStore(),
    artifactUploadsEnabled: Bool = true
) -> ScannerViewModel {
    ScannerViewModel(
        cameraController: CameraSessionController(),
        ocrPipelineFactory: {
            OCRPipelineCoordinator(
                rawRewritePipeline: RawPipeline(),
                slabAnalyzer: SlabScanner(config: .default)
            )
        },
        matcher: matcher,
        logStore: logStore,
        artifactUploadsEnabled: artifactUploadsEnabled
    )
}

@MainActor
func makeCollectionStore(matcher: (any CardMatchingService)? = nil) -> CollectionStore {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return CollectionStore(matcher: matcher, baseDirectoryURL: url)
}

func makeScanEventStore() -> ScanEventStore {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return ScanEventStore(baseDirectoryURL: url)
}

func makeCardCandidate(
    id: String,
    name: String,
    setName: String = "Gym Heroes",
    number: String = "60/132",
    marketPrice: Double? = nil
) -> CardCandidate {
    CardCandidate(
        id: id,
        name: name,
        setName: setName,
        number: number,
        rarity: "Rare",
        variant: "1st Edition",
        language: "English",
        imageSmallURL: nil,
        imageLargeURL: nil,
        pricing: CardPricingSummary(
            source: "scrydex",
            currencyCode: "USD",
            variant: nil,
            low: nil,
            market: marketPrice,
            mid: nil,
            high: nil,
            directLow: nil,
            trend: nil,
            updatedAt: nil,
            refreshedAt: nil,
            sourceURL: nil,
            pricingMode: nil,
            snapshotAgeHours: nil,
            freshnessWindowHours: nil,
            isFresh: nil,
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
    )
}

func makeDeckEntryPayload(
    id: String,
    card: CardCandidate,
    slabContext: SlabContext?,
    condition: DeckCardCondition? = nil,
    quantity: Int = 1,
    addedAt: Date
) -> DeckEntryPayload {
    DeckEntryPayload(
        id: id,
        card: card,
        slabContext: slabContext,
        condition: condition,
        quantity: quantity,
        addedAt: addedAt
    )
}

func makeDate(_ iso8601: String) -> Date {
    ISO8601DateFormatter().date(from: iso8601) ?? Date()
}

func makeFieldConfidence(_ score: Double) -> OCRFieldConfidence {
    OCRFieldConfidence(
        score: score,
        agreementScore: nil,
        tokenConfidenceAverage: nil,
        reasons: []
    )
}

func makeMatchResponse(
    confidence: MatchConfidence,
    reviewDisposition: ReviewDisposition,
    resolverMode: ResolverMode = .rawCard
) -> ScanMatchResponse {
    let candidate = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro")

    return ScanMatchResponse(
        scanID: UUID(),
        topCandidates: [
            ScoredCandidate(
                rank: 1,
                candidate: candidate,
                imageScore: 0.77,
                collectorNumberScore: 0.91,
                nameScore: 0.84,
                finalScore: 0.82
            )
        ],
        confidence: confidence,
        ambiguityFlags: [],
        matcherSource: .remoteHybrid,
        matcherVersion: "test",
        resolverMode: resolverMode,
        resolverPath: .visualHybridIndex,
        slabContext: nil,
        reviewDisposition: reviewDisposition,
        reviewReason: nil,
        performance: nil,
        isProvisional: nil,
        matchStage: nil
    )
}

func makeAnalyzedCapture(
    cropConfidence: Double,
    collectorNumber: String?,
    setHintTokens: [String],
    setBadgeHint: OCRSetBadgeHint?,
    rawEvidence: OCRRawEvidence
) -> AnalyzedCapture {
    let image = makeImage(size: CGSize(width: 320, height: 460)) { context in
        UIColor.darkGray.setFill()
        context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))
    }

    return AnalyzedCapture(
        scanID: UUID(),
        originalImage: image,
        normalizedImage: image,
        recognizedTokens: [],
        collectorNumber: collectorNumber,
        setHintTokens: setHintTokens,
        setBadgeHint: setBadgeHint,
        promoCodeHint: nil,
        slabGrader: nil,
        slabGrade: nil,
        slabCertNumber: nil,
        slabBarcodePayloads: [],
        slabGraderConfidence: nil,
        slabGradeConfidence: nil,
        slabCertConfidence: nil,
        slabCardNumberRaw: nil,
        slabParsedLabelText: [],
        slabClassifierReasons: [],
        slabRecommendedLookupPath: nil,
        resolverModeHint: .rawCard,
        cropConfidence: cropConfidence,
        warnings: [],
        shouldRetryWithStillPhoto: false,
        stillPhotoRetryReason: nil,
        ocrAnalysis: OCRAnalysisEnvelope(
            pipelineVersion: .rewriteV1,
            selectedMode: .raw,
            normalizedTarget: nil,
            modeSanitySignals: nil,
            rawEvidence: rawEvidence,
            slabEvidence: nil
        )
    )
}

func makeScanStackItem(
    resolverMode: ResolverMode,
    reviewDisposition: ReviewDisposition
) -> LiveScanStackItem {
    LiveScanStackItem(
        id: UUID(),
        scanID: UUID(),
        phase: .resolved,
        card: makeCardCandidate(id: "base1-26", name: "Raichu"),
        detail: nil,
        previewImage: nil,
        confidence: .medium,
        matcherSource: .remoteHybrid,
        matcherVersion: "test",
        resolverMode: resolverMode,
        resolverPath: resolverMode == .psaSlab ? .psaLabel : .visualHybridIndex,
        slabContext: resolverMode == .psaSlab
            ? SlabContext(grader: "PSA", grade: "10", certNumber: "12345678", variantName: nil)
            : nil,
        reviewDisposition: reviewDisposition,
        reviewReason: nil,
        addedAt: Date(),
        isExpanded: false,
        isRefreshingPrice: false,
        statusMessage: nil,
        pricingContextNote: nil,
        performance: nil,
        cacheStatus: nil,
        selectedRank: nil,
        wasTopPrediction: false,
        selectionSource: .unknown
    )
}

private actor StubCardMatchingService: CardMatchingService {
    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse {
        throw MatcherError.noCandidates
    }

    func matchVisualStart(payload: ScanVisualStartRequestPayload) async throws -> ScanMatchResponse {
        throw MatcherError.noCandidates
    }

    func matchRerank(payload: ScanRerankRequestPayload) async throws -> ScanMatchResponse {
        throw MatcherError.noCandidates
    }

    func search(query: String) async -> [CardCandidate] {
        []
    }

    func fetchCardDetail(cardID: String, slabContext: SlabContext?) async -> CardDetail? {
        nil
    }

    func fetchCardMarketHistory(
        cardID: String,
        slabContext: SlabContext?,
        days: Int,
        variant: String?,
        condition: String?
    ) async -> CardMarketHistory? {
        nil
    }

    func fetchGradedCardComps(
        cardID: String,
        slabContext: SlabContext?,
        selectedGrade: String?
    ) async -> GradedCardComps? {
        nil
    }

    func fetchPortfolioHistory(range: PortfolioHistoryRange) async -> PortfolioHistory? {
        nil
    }

    func fetchPortfolioLedger(range: PortfolioHistoryRange) async -> PortfolioLedger? {
        nil
    }

    func refreshCardDetail(
        cardID: String,
        slabContext: SlabContext?,
        forceRefresh: Bool
    ) async throws -> CardDetail? {
        nil
    }

    func hydrateCandidatePricing(
        cardIDs: [String],
        maxRefreshCount: Int,
        slabContext: SlabContext?
    ) async -> [CardDetail] {
        []
    }

    func fetchDeckEntries() async -> [DeckEntryPayload]? {
        []
    }

    func updateDeckEntryCondition(_ payload: DeckEntryConditionUpdateRequestPayload) async throws {}

    func updateDeckEntryPurchasePrice(_ payload: DeckEntryPurchasePriceUpdateRequestPayload) async throws {}

    func updatePortfolioBuyPrice(
        transactionID: String,
        payload: PortfolioTransactionPriceUpdateRequestPayload
    ) async throws {}

    func updatePortfolioSalePrice(
        transactionID: String,
        payload: PortfolioTransactionPriceUpdateRequestPayload
    ) async throws {}

    func uploadScanArtifacts(_ payload: ScanArtifactUploadRequestPayload) async throws {}

    func addDeckEntry(_ payload: DeckEntryCreateRequestPayload) async throws {}

    func createPortfolioBuy(_ payload: PortfolioBuyCreateRequestPayload) async throws -> PortfolioBuyCreateResponsePayload {
        throw MatcherError.server(message: "not implemented")
    }

    func createPortfolioSale(_ payload: PortfolioSaleCreateRequestPayload) async throws -> PortfolioSaleCreateResponsePayload {
        throw MatcherError.server(message: "not implemented")
    }

    func submitFeedback(
        scanID: UUID,
        selectedCardID: String?,
        wasTopPrediction: Bool,
        correctionType: CorrectionType
    ) async {}
}

actor RecordingCardMatchingService: CardMatchingService {
    private var artifactPayloads: [ScanArtifactUploadRequestPayload] = []
    private var deckPayloads: [DeckEntryCreateRequestPayload] = []
    private var deckEntries: [DeckEntryPayload] = []
    private var shouldFailDeckEntriesFetch = false
    private var deckConditionPayloads: [DeckEntryConditionUpdateRequestPayload] = []
    private var deckPurchasePricePayloads: [DeckEntryPurchasePriceUpdateRequestPayload] = []
    private var portfolioHistory: PortfolioHistory?
    private var portfolioLedger: PortfolioLedger?
    private var recordedPortfolioBuyPayloads: [PortfolioBuyCreateRequestPayload] = []
    private var recordedPortfolioSalePayloads: [PortfolioSaleCreateRequestPayload] = []
    private var portfolioBuyPriceUpdates: [(transactionID: String, payload: PortfolioTransactionPriceUpdateRequestPayload)] = []
    private var portfolioSalePriceUpdates: [(transactionID: String, payload: PortfolioTransactionPriceUpdateRequestPayload)] = []
    private var portfolioBuyResponse = PortfolioBuyCreateResponsePayload(
        deckEntryID: "raw|test",
        cardID: "test",
        inserted: true,
        quantityAdded: 1,
        totalSpend: 0,
        boughtAt: Date()
    )
    private var portfolioSaleResponse = PortfolioSaleCreateResponsePayload(
        saleID: "sale:test",
        deckEntryID: "raw|test",
        remainingQuantity: 0,
        grossTotal: 0,
        soldAt: Date(),
        showSessionID: nil
    )

    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse {
        throw MatcherError.noCandidates
    }

    func matchVisualStart(payload: ScanVisualStartRequestPayload) async throws -> ScanMatchResponse {
        throw MatcherError.noCandidates
    }

    func matchRerank(payload: ScanRerankRequestPayload) async throws -> ScanMatchResponse {
        throw MatcherError.noCandidates
    }

    func search(query: String) async -> [CardCandidate] {
        []
    }

    func fetchCardDetail(cardID: String, slabContext: SlabContext?) async -> CardDetail? {
        nil
    }

    func fetchCardMarketHistory(
        cardID: String,
        slabContext: SlabContext?,
        days: Int,
        variant: String?,
        condition: String?
    ) async -> CardMarketHistory? {
        nil
    }

    func fetchGradedCardComps(
        cardID: String,
        slabContext: SlabContext?,
        selectedGrade: String?
    ) async -> GradedCardComps? {
        nil
    }

    func fetchPortfolioHistory(range: PortfolioHistoryRange) async -> PortfolioHistory? {
        portfolioHistory
    }

    func fetchPortfolioLedger(range: PortfolioHistoryRange) async -> PortfolioLedger? {
        portfolioLedger
    }

    func refreshCardDetail(
        cardID: String,
        slabContext: SlabContext?,
        forceRefresh: Bool
    ) async throws -> CardDetail? {
        nil
    }

    func hydrateCandidatePricing(
        cardIDs: [String],
        maxRefreshCount: Int,
        slabContext: SlabContext?
    ) async -> [CardDetail] {
        []
    }

    func fetchDeckEntries() async -> [DeckEntryPayload]? {
        guard !shouldFailDeckEntriesFetch else {
            return nil
        }
        return deckEntries
    }

    func updateDeckEntryCondition(_ payload: DeckEntryConditionUpdateRequestPayload) async throws {
        deckConditionPayloads.append(payload)
        if let index = deckEntries.firstIndex(where: { $0.card.id == payload.cardID && $0.slabContext == payload.slabContext }) {
            let existing = deckEntries[index]
            deckEntries[index] = DeckEntryPayload(
                id: existing.id,
                card: existing.card,
                slabContext: existing.slabContext,
                condition: payload.condition,
                quantity: existing.quantity,
                addedAt: existing.addedAt
            )
        }
    }

    func updateDeckEntryPurchasePrice(_ payload: DeckEntryPurchasePriceUpdateRequestPayload) async throws {
        deckPurchasePricePayloads.append(payload)
        if let index = deckEntries.firstIndex(where: { $0.card.id == payload.cardID && $0.slabContext == payload.slabContext }) {
            let existing = deckEntries[index]
            deckEntries[index] = DeckEntryPayload(
                id: existing.id,
                card: existing.card,
                slabContext: existing.slabContext,
                condition: existing.condition,
                quantity: existing.quantity,
                costBasisTotal: payload.unitPrice * Double(existing.quantity),
                costBasisCurrencyCode: payload.currencyCode,
                addedAt: existing.addedAt
            )
        }
    }

    func updatePortfolioBuyPrice(
        transactionID: String,
        payload: PortfolioTransactionPriceUpdateRequestPayload
    ) async throws {
        portfolioBuyPriceUpdates.append((transactionID: transactionID, payload: payload))
    }

    func updatePortfolioSalePrice(
        transactionID: String,
        payload: PortfolioTransactionPriceUpdateRequestPayload
    ) async throws {
        portfolioSalePriceUpdates.append((transactionID: transactionID, payload: payload))
    }

    func uploadScanArtifacts(_ payload: ScanArtifactUploadRequestPayload) async throws {
        artifactPayloads.append(payload)
    }

    func addDeckEntry(_ payload: DeckEntryCreateRequestPayload) async throws {
        deckPayloads.append(payload)
    }

    func createPortfolioBuy(_ payload: PortfolioBuyCreateRequestPayload) async throws -> PortfolioBuyCreateResponsePayload {
        recordedPortfolioBuyPayloads.append(payload)
        return portfolioBuyResponse
    }

    func createPortfolioSale(_ payload: PortfolioSaleCreateRequestPayload) async throws -> PortfolioSaleCreateResponsePayload {
        recordedPortfolioSalePayloads.append(payload)
        let normalizedDeckEntryID = portfolioSaleResponse.deckEntryID.trimmingCharacters(in: .whitespacesAndNewlines)
        if let index = deckEntries.firstIndex(where: { entry in
            if !normalizedDeckEntryID.isEmpty {
                return entry.id == normalizedDeckEntryID
            }
            return entry.card.id == payload.cardID && entry.slabContext == payload.slabContext
        }) {
            if portfolioSaleResponse.remainingQuantity <= 0 {
                deckEntries.remove(at: index)
            } else {
                let existing = deckEntries[index]
                deckEntries[index] = DeckEntryPayload(
                    id: existing.id,
                    card: existing.card,
                    slabContext: existing.slabContext,
                    condition: existing.condition,
                    quantity: portfolioSaleResponse.remainingQuantity,
                    costBasisTotal: existing.costBasisTotal,
                    costBasisCurrencyCode: existing.costBasisCurrencyCode,
                    addedAt: existing.addedAt
                )
            }
        }
        return portfolioSaleResponse
    }

    func submitFeedback(
        scanID: UUID,
        selectedCardID: String?,
        wasTopPrediction: Bool,
        correctionType: CorrectionType
    ) async {}

    func setDeckEntries(_ entries: [DeckEntryPayload]) {
        deckEntries = entries
    }

    func setDeckEntriesFetchFailure(_ shouldFail: Bool) {
        shouldFailDeckEntriesFetch = shouldFail
    }

    func setPortfolioHistory(_ history: PortfolioHistory?) {
        portfolioHistory = history
    }

    func setPortfolioLedger(_ ledger: PortfolioLedger?) {
        portfolioLedger = ledger
    }

    func setBuyResponse(_ response: PortfolioBuyCreateResponsePayload) {
        portfolioBuyResponse = response
    }

    func setSaleResponse(_ response: PortfolioSaleCreateResponsePayload) {
        portfolioSaleResponse = response
    }

    func uploadedArtifactPayloads() -> [ScanArtifactUploadRequestPayload] {
        artifactPayloads
    }

    func deckEntryPayloads() -> [DeckEntryCreateRequestPayload] {
        deckPayloads
    }

    func deckConditionUpdatePayloads() -> [DeckEntryConditionUpdateRequestPayload] {
        deckConditionPayloads
    }

    func deckPurchasePriceUpdatePayloads() -> [DeckEntryPurchasePriceUpdateRequestPayload] {
        deckPurchasePricePayloads
    }

    func portfolioSalePayloads() -> [PortfolioSaleCreateRequestPayload] {
        recordedPortfolioSalePayloads
    }

    func portfolioBuyPayloads() -> [PortfolioBuyCreateRequestPayload] {
        recordedPortfolioBuyPayloads
    }

    func portfolioBuyPriceUpdatePayloads() -> [(transactionID: String, payload: PortfolioTransactionPriceUpdateRequestPayload)] {
        portfolioBuyPriceUpdates
    }

    func portfolioSalePriceUpdatePayloads() -> [(transactionID: String, payload: PortfolioTransactionPriceUpdateRequestPayload)] {
        portfolioSalePriceUpdates
    }
}
