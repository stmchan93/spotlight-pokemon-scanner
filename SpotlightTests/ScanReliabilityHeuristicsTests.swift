import XCTest
import UIKit
@testable import Spotlight

final class ScanReliabilityHeuristicsTests: XCTestCase {
    @MainActor
    func testCollectionStoreTracksQuantityByCardAndSlabContext() throws {
        let store = makeCollectionStore()
        let rawCard = makeCardCandidate(id: "base1-4", name: "Charizard")

        XCTAssertEqual(store.add(card: rawCard, slabContext: nil), 1)
        XCTAssertEqual(store.add(card: rawCard, slabContext: nil), 2)
        XCTAssertEqual(store.entries.count, 1)
        XCTAssertEqual(store.entries.first?.quantity, 2)
        XCTAssertEqual(store.totalCardCount, 2)

        let slabContext = SlabContext(grader: "PSA", grade: "10", certNumber: "12345", variantName: nil)
        XCTAssertEqual(store.add(card: rawCard, slabContext: slabContext), 1)
        XCTAssertEqual(store.entries.count, 2)
        XCTAssertEqual(store.quantity(card: rawCard, slabContext: slabContext), 1)
    }

    @MainActor
    func testCollectionStoreRefreshesFromBackendDeckEntries() async {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        let card = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75)
        await matcher.setDeckEntries([
            makeDeckEntryPayload(
                id: "raw|gym1-60",
                card: card,
                slabContext: nil,
                quantity: 3,
                addedAt: makeDate("2026-04-14T12:00:00Z")
            )
        ])

        await store.refreshFromBackend()

        XCTAssertEqual(store.entries.count, 1)
        XCTAssertEqual(store.entries.first?.card.id, card.id)
        XCTAssertEqual(store.entries.first?.quantity, 3)
        XCTAssertEqual(store.entries.first?.card.pricing?.market, 12.75)
        XCTAssertEqual(store.totalCardCount, 3)
        XCTAssertEqual(store.totalValue, 38.25)
    }

    @MainActor
    func testCollectionStorePersistsConditionOptimisticallyAndRefreshesFromBackend() async {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        let card = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75)

        let mutation = store.setCondition(card: card, slabContext: nil, condition: .nearMint)
        XCTAssertTrue(mutation.inserted)
        XCTAssertEqual(mutation.quantity, 1)
        XCTAssertEqual(store.condition(card: card, slabContext: nil), .nearMint)

        await matcher.setDeckEntries([
            makeDeckEntryPayload(
                id: "raw|gym1-60",
                card: card,
                slabContext: nil,
                condition: .nearMint,
                quantity: 1,
                addedAt: makeDate("2026-04-14T12:00:00Z")
            )
        ])

        await store.refreshFromBackend()

        XCTAssertEqual(store.condition(card: card, slabContext: nil), .nearMint)
        XCTAssertEqual(store.searchResults(for: "near mint").count, 1)
    }

    @MainActor
    func testCollectionStoreSyncConditionUsesBackendEndpoint() async {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        let card = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75)

        await matcher.setDeckEntries([
            makeDeckEntryPayload(
                id: "raw|gym1-60",
                card: card,
                slabContext: nil,
                condition: .nearMint,
                quantity: 1,
                addedAt: makeDate("2026-04-14T12:00:00Z")
            )
        ])
        await store.refreshFromBackend()

        _ = store.setCondition(card: card, slabContext: nil, condition: .lightlyPlayed)
        await store.syncCondition(card: card, slabContext: nil, condition: .lightlyPlayed)

        let payloads = await matcher.deckConditionUpdatePayloads()
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads.first?.cardID, card.id)
        XCTAssertEqual(payloads.first?.condition, .lightlyPlayed)
    }

    @MainActor
    func testCollectionStorePreservesHigherOptimisticQuantityUntilBackendCatchesUp() async {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        let card = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75)

        XCTAssertEqual(store.add(card: card, slabContext: nil), 1)
        XCTAssertEqual(store.add(card: card, slabContext: nil), 2)

        await matcher.setDeckEntries([
            makeDeckEntryPayload(
                id: "raw|gym1-60",
                card: card,
                slabContext: nil,
                quantity: 1,
                addedAt: makeDate("2026-04-14T12:00:00Z")
            )
        ])
        await store.refreshFromBackend()

        XCTAssertEqual(store.quantity(card: card, slabContext: nil), 2)

        await matcher.setDeckEntries([
            makeDeckEntryPayload(
                id: "raw|gym1-60",
                card: card,
                slabContext: nil,
                quantity: 2,
                addedAt: makeDate("2026-04-14T12:00:00Z")
            )
        ])
        await store.refreshFromBackend()

        XCTAssertEqual(store.quantity(card: card, slabContext: nil), 2)
    }

    @MainActor
    func testCollectionStoreAddDoesNotCreateLegacyDeckJsonFile() throws {
        let fileManager = FileManager.default
        let rootURL = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: rootURL, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: rootURL) }

        let spotlightDirectoryURL = rootURL.appendingPathComponent("Spotlight", isDirectory: true)
        try fileManager.createDirectory(at: spotlightDirectoryURL, withIntermediateDirectories: true)
        let legacyFileURL = spotlightDirectoryURL.appendingPathComponent("deck_collection.json")
        try Data("{\"entries\":[]}".utf8).write(to: legacyFileURL)

        let store = CollectionStore(baseDirectoryURL: rootURL)
        let initialCard = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: nil)
        XCTAssertEqual(store.add(card: initialCard, slabContext: nil), 1)

        XCTAssertEqual(store.entries.count, 1)
        XCTAssertFalse(
            fileManager.fileExists(
                atPath: legacyFileURL.path
            )
        )
    }

    @MainActor
    func testCollectionStoreSearchMatchesNameSetAndNumber() throws {
        let store = makeCollectionStore()

        XCTAssertEqual(store.add(card: makeCardCandidate(id: "base1-4", name: "Charizard", setName: "Base Set", number: "4/102"), slabContext: nil), 1)
        XCTAssertEqual(store.add(card: makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", setName: "Gym Heroes", number: "60/132"), slabContext: nil), 1)

        XCTAssertEqual(store.searchResults(for: "char").count, 1)
        XCTAssertEqual(store.searchResults(for: "gym heroes").count, 1)
        XCTAssertEqual(store.searchResults(for: "60/132").count, 1)
        XCTAssertEqual(store.searchResults(for: "missing").count, 0)
    }

    func testSortedDeckEntriesSupportsRecentValueAndAlphabetical() {
        let charizard = DeckCardEntry(
            id: "raw|base1-4",
            card: makeCardCandidate(id: "base1-4", name: "Charizard", marketPrice: 250),
            slabContext: nil,
            condition: nil,
            quantity: 1,
            addedAt: makeDate("2026-04-12T12:00:00Z")
        )
        let blastoise = DeckCardEntry(
            id: "raw|base1-2",
            card: makeCardCandidate(id: "base1-2", name: "Blastoise", marketPrice: 90),
            slabContext: nil,
            condition: nil,
            quantity: 2,
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )
        let alakazam = DeckCardEntry(
            id: "raw|base1-1",
            card: makeCardCandidate(id: "base1-1", name: "Alakazam", marketPrice: 120),
            slabContext: nil,
            condition: nil,
            quantity: 1,
            addedAt: makeDate("2026-04-13T12:00:00Z")
        )
        let entries = [charizard, blastoise, alakazam]

        XCTAssertEqual(
            sortedDeckEntries(entries, by: .recentlyAdded).map(\.card.name),
            ["Blastoise", "Alakazam", "Charizard"]
        )
        XCTAssertEqual(
            sortedDeckEntries(entries, by: .highestValue).map(\.card.name),
            ["Charizard", "Blastoise", "Alakazam"]
        )
        XCTAssertEqual(
            sortedDeckEntries(entries, by: .alphabetical).map(\.card.name),
            ["Alakazam", "Blastoise", "Charizard"]
        )
    }

    func testCardMarketplaceLinksBuildTcgplayerSearchURL() throws {
        let card = makeCardCandidate(
            id: "gym1-60",
            name: "Sabrina's Slowbro",
            setName: "Gym Heroes",
            number: "60/132"
        )

        let url = try XCTUnwrap(CardMarketplaceLinks.tcgPlayerSearchURL(card: card, slabContext: nil))
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let queryItems = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })

        XCTAssertEqual(components.host, "www.tcgplayer.com")
        XCTAssertEqual(components.path, "/search/pokemon/product")
        XCTAssertEqual(queryItems["view"], "grid")
        XCTAssertEqual(queryItems["q"], "Sabrina's Slowbro 60/132 Gym Heroes")
    }

    func testCardMarketplaceLinksBuildEbaySearchURLForSlab() throws {
        let card = makeCardCandidate(
            id: "sv9-125",
            name: "Mega Charizard X ex",
            setName: "Triumphant Light",
            number: "125/094"
        )
        let slabContext = SlabContext(
            grader: "PSA",
            grade: "9",
            certNumber: "147387041",
            variantName: nil
        )

        let url = try XCTUnwrap(CardMarketplaceLinks.eBaySearchURL(card: card, slabContext: slabContext))
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let queryItems = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })

        XCTAssertEqual(components.host, "www.ebay.com")
        XCTAssertEqual(components.path, "/sch/i.html")
        XCTAssertEqual(
            queryItems["_nkw"],
            "Mega Charizard X ex 125/094 Triumphant Light PSA 9 147387041"
        )
    }

    func testTrayDismissSwipeHelpersClampAndThreshold() {
        XCTAssertEqual(clampedTrayDismissOffset(-40), 0)
        XCTAssertEqual(clampedTrayDismissOffset(40), 40)
        XCTAssertEqual(clampedTrayDismissOffset(240), 180)

        XCTAssertFalse(shouldRevealTrayItemDeleteAction(forSwipeOffset: 91))
        XCTAssertTrue(shouldRevealTrayItemDeleteAction(forSwipeOffset: 92))
    }

    @MainActor
    func testPresentResultDetailShowsDetailFirstForSlabItem() {
        let viewModel = makeScannerViewModel()
        let slabItem = makeScanStackItem(
            resolverMode: .psaSlab,
            reviewDisposition: .ready
        )
        viewModel.scannedItems = [slabItem]

        viewModel.presentResultDetail(for: slabItem.id)

        XCTAssertEqual(viewModel.route, .resultDetail)
        XCTAssertEqual(viewModel.activeResultItem?.id, slabItem.id)
        XCTAssertNil(viewModel.activeAlternativesResponse)
    }

    @MainActor
    func testPresentResultDetailForDeckEntryUsesSharedDetailPreview() {
        let viewModel = makeScannerViewModel()
        let card = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75)
        let entry = DeckCardEntry(
            id: "raw|gym1-60",
            card: card,
            slabContext: nil,
            condition: .nearMint,
            quantity: 2,
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )

        viewModel.presentResultDetail(for: entry)

        XCTAssertEqual(viewModel.route, .resultDetail)
        XCTAssertEqual(viewModel.activeResultItem?.displayCard?.id, card.id)
        XCTAssertEqual(viewModel.activeResultItem?.displayCard?.name, card.name)
        XCTAssertEqual(viewModel.activeResultItem?.resolverMode, .rawCard)
        XCTAssertNil(viewModel.activeAlternativesResponse)
    }

    @MainActor
    func testDismissResultDetailFromDeckEntryReturnsToScannerRoute() {
        let viewModel = makeScannerViewModel()
        let entry = DeckCardEntry(
            id: "raw|base1-4",
            card: makeCardCandidate(id: "base1-4", name: "Charizard"),
            slabContext: nil,
            condition: nil,
            quantity: 1,
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )

        viewModel.presentResultDetail(for: entry)
        viewModel.dismissResultDetail()

        XCTAssertEqual(viewModel.route, .scanner)
        XCTAssertNil(viewModel.activeResultItem)
    }

    @MainActor
    func testScanEventStoreLogPredictionQueuesArtifactUpload() async {
        let logStore = makeScanEventStore()
        let analysis = makeAnalyzedCapture(
            cropConfidence: 0.58,
            collectorNumber: "60/132",
            setHintTokens: ["gym1"],
            setBadgeHint: nil,
            rawEvidence: OCRRawEvidence(
                titleTextPrimary: "Sabrina's Slowbro",
                titleTextSecondary: nil,
                titleConfidence: makeFieldConfidence(0.72),
                collectorNumberExact: "60/132",
                collectorNumberPartial: nil,
                collectorConfidence: makeFieldConfidence(0.9),
                setBadgeHint: nil,
                setHints: ["gym1"],
                setConfidence: makeFieldConfidence(0.61),
                footerBandText: "Sabrina's Slowbro 60/132",
                wholeCardText: "Sabrina's Slowbro Gym Heroes 60/132",
                warnings: []
            )
        )

        await logStore.logPrediction(
            analysis: analysis,
            response: makeMatchResponse(confidence: .medium, reviewDisposition: .needsReview),
            captureSource: .livePreviewFrame,
            cameraZoomFactor: 1.5
        )

        let uploads = await logStore.pendingArtifactUploads()
        XCTAssertEqual(uploads.count, 1)
        XCTAssertEqual(uploads.first?.scanID, analysis.scanID)
        XCTAssertEqual(uploads.first?.captureSource, .livePreviewFrame)
        XCTAssertEqual(uploads.first?.cameraZoomFactor, 1.5)
        XCTAssertNotNil(uploads.first?.sourceImagePath)
        XCTAssertNotNil(uploads.first?.normalizedImagePath)
        XCTAssertTrue(FileManager.default.fileExists(atPath: uploads.first?.sourceImagePath ?? ""))
        XCTAssertTrue(FileManager.default.fileExists(atPath: uploads.first?.normalizedImagePath ?? ""))
    }

    @MainActor
    func testScanEventStoreLogPredictionSkipsArtifactUploadQueueWhenDisabled() async {
        let rootURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: rootURL)
        }

        let logStore = ScanEventStore(baseDirectoryURL: rootURL)
        let analysis = makeAnalyzedCapture(
            cropConfidence: 0.58,
            collectorNumber: "60/132",
            setHintTokens: ["gym1"],
            setBadgeHint: nil,
            rawEvidence: OCRRawEvidence(
                titleTextPrimary: "Sabrina's Slowbro",
                titleTextSecondary: nil,
                titleConfidence: makeFieldConfidence(0.72),
                collectorNumberExact: "60/132",
                collectorNumberPartial: nil,
                collectorConfidence: makeFieldConfidence(0.9),
                setBadgeHint: nil,
                setHints: ["gym1"],
                setConfidence: makeFieldConfidence(0.61),
                footerBandText: "Sabrina's Slowbro 60/132",
                wholeCardText: "Sabrina's Slowbro Gym Heroes 60/132",
                warnings: []
            )
        )

        await logStore.logPrediction(
            analysis: analysis,
            response: makeMatchResponse(confidence: .medium, reviewDisposition: .needsReview),
            captureSource: .livePreviewFrame,
            cameraZoomFactor: 1.5,
            enqueueArtifactUpload: false
        )

        let uploads = await logStore.pendingArtifactUploads()
        let cropsURL = rootURL.appendingPathComponent("Spotlight", isDirectory: true)
            .appendingPathComponent("ScanCrops", isDirectory: true)
        let cropFiles = (try? FileManager.default.contentsOfDirectory(atPath: cropsURL.path)) ?? []

        XCTAssertTrue(uploads.isEmpty)
        XCTAssertTrue(cropFiles.isEmpty)
    }

    @MainActor
    func testFlushPendingBackendQueuesUploadsArtifactPayloads() async {
        let matcher = RecordingCardMatchingService()
        let logStore = makeScanEventStore()
        let viewModel = makeScannerViewModel(matcher: matcher, logStore: logStore)
        let analysis = makeAnalyzedCapture(
            cropConfidence: 0.58,
            collectorNumber: "60/132",
            setHintTokens: ["gym1"],
            setBadgeHint: nil,
            rawEvidence: OCRRawEvidence(
                titleTextPrimary: "Sabrina's Slowbro",
                titleTextSecondary: nil,
                titleConfidence: makeFieldConfidence(0.72),
                collectorNumberExact: "60/132",
                collectorNumberPartial: nil,
                collectorConfidence: makeFieldConfidence(0.9),
                setBadgeHint: nil,
                setHints: ["gym1"],
                setConfidence: makeFieldConfidence(0.61),
                footerBandText: "Sabrina's Slowbro 60/132",
                wholeCardText: "Sabrina's Slowbro Gym Heroes 60/132",
                warnings: []
            )
        )

        await logStore.logPrediction(
            analysis: analysis,
            response: makeMatchResponse(confidence: .medium, reviewDisposition: .needsReview),
            captureSource: .liveStillPhoto,
            cameraZoomFactor: 1.5
        )

        await viewModel.flushPendingBackendQueues()

        let pendingUploads = await logStore.pendingArtifactUploads()
        XCTAssertTrue(pendingUploads.isEmpty)

        let uploadedPayloads = await matcher.uploadedArtifactPayloads()
        XCTAssertEqual(uploadedPayloads.count, 1)
        XCTAssertEqual(uploadedPayloads.first?.scanID, analysis.scanID)
        XCTAssertEqual(uploadedPayloads.first?.captureSource, .liveStillPhoto)
        XCTAssertEqual(uploadedPayloads.first?.cameraZoomFactor, 1.5)
        XCTAssertNotNil(uploadedPayloads.first?.sourceImage.jpegBase64)
        XCTAssertNotNil(uploadedPayloads.first?.normalizedImage.jpegBase64)
    }

    @MainActor
    func testRecordDeckAdditionFlushesBackendConfirmationUsingSelectionMetadata() async {
        let matcher = RecordingCardMatchingService()
        let logStore = makeScanEventStore()
        let viewModel = makeScannerViewModel(matcher: matcher, logStore: logStore)
        var item = makeScanStackItem(resolverMode: .rawCard, reviewDisposition: .needsReview)
        item.selectedRank = 2
        item.wasTopPrediction = false
        item.selectionSource = .alternatePrediction
        viewModel.scannedItems = [item]

        guard let card = item.card else {
            XCTFail("Expected test card")
            return
        }

        viewModel.recordDeckAddition(itemID: item.id, card: card, slabContext: nil)

        for _ in 0..<20 {
            if await matcher.deckEntryPayloads().count == 1 {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        let payloads = await matcher.deckEntryPayloads()
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads.first?.cardID, card.id)
        XCTAssertEqual(payloads.first?.sourceScanID, item.scanID)
        XCTAssertEqual(payloads.first?.selectionSource, .alternatePrediction)
        XCTAssertEqual(payloads.first?.selectedRank, 2)
        XCTAssertEqual(payloads.first?.wasTopPrediction, false)
        XCTAssertNil(payloads.first?.condition)

        let pendingConfirmations = await logStore.pendingDeckConfirmations()
        XCTAssertTrue(pendingConfirmations.isEmpty)
    }

    func testScannerNavigationStateStartsAtScanner() {
        let navigation = ScannerNavigationState()

        XCTAssertEqual(navigation.currentRoute, .scanner)
        XCTAssertEqual(navigation.stack, [.scanner])
    }

    func testScannerNavigationStateDetailBackReturnsToScanner() {
        var navigation = ScannerNavigationState()

        navigation.push(.resultDetail)
        XCTAssertEqual(navigation.stack, [.scanner, .resultDetail])

        navigation.pop()
        XCTAssertEqual(navigation.currentRoute, .scanner)
        XCTAssertEqual(navigation.stack, [.scanner])
    }

    func testScannerNavigationStateAlternativesThenDetailBackReturnsToAlternatives() {
        var navigation = ScannerNavigationState()

        navigation.push(.alternatives)
        navigation.push(.resultDetail)
        XCTAssertEqual(navigation.stack, [.scanner, .alternatives, .resultDetail])

        navigation.pop()
        XCTAssertEqual(navigation.currentRoute, .alternatives)
        XCTAssertEqual(navigation.stack, [.scanner, .alternatives])

        navigation.pop()
        XCTAssertEqual(navigation.currentRoute, .scanner)
        XCTAssertEqual(navigation.stack, [.scanner])
    }

    func testScannerNavigationStateIgnoresDuplicateTopRoute() {
        var navigation = ScannerNavigationState()

        navigation.push(.resultDetail)
        navigation.push(.resultDetail)

        XCTAssertEqual(navigation.stack, [.scanner, .resultDetail])
    }

    func testAppShellStateStartsInScanMode() {
        let state = AppShellState()

        XCTAssertEqual(state.selectedTab, .scan)
    }

    func testAppShellStateExitScannerAndReturnToScan() {
        var state = AppShellState()

        state.exitScanner()
        XCTAssertEqual(state.selectedTab, .deck)

        state.openScanner()
        XCTAssertEqual(state.selectedTab, .scan)
    }

    func testReticleCropLooksLikeRawCardRejectsBlankDarkCrop() {
        let image = makeImage(size: CGSize(width: 320, height: 460)) { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))
        }

        XCTAssertFalse(reticleCropLooksLikeRawCard(image))
    }

    func testReticleCropLooksLikeRawCardAcceptsCardLikeCrop() {
        let image = makeImage(size: CGSize(width: 320, height: 460)) { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))

            let cardRect = CGRect(x: 50, y: 23, width: 220, height: 414)
            UIColor(red: 0.94, green: 0.90, blue: 0.76, alpha: 1).setFill()
            context.fill(cardRect)

            UIColor(red: 0.16, green: 0.43, blue: 0.84, alpha: 1).setFill()
            context.fill(CGRect(x: 68, y: 48, width: 184, height: 88))

            UIColor(red: 0.92, green: 0.32, blue: 0.41, alpha: 1).setFill()
            context.fill(CGRect(x: 72, y: 316, width: 176, height: 94))
        }

        XCTAssertTrue(reticleCropLooksLikeRawCard(image))
    }

    func testShouldShortCircuitBackendMatchForLowSignalRawAnalysis() {
        let analysis = makeAnalyzedCapture(
            cropConfidence: 0.40,
            collectorNumber: nil,
            setHintTokens: [],
            setBadgeHint: nil,
            rawEvidence: OCRRawEvidence(
                titleTextPrimary: nil,
                titleTextSecondary: nil,
                titleConfidence: nil,
                collectorNumberExact: nil,
                collectorNumberPartial: "193",
                collectorConfidence: nil,
                setBadgeHint: nil,
                setHints: [],
                setConfidence: nil,
                footerBandText: "",
                wholeCardText: "",
                warnings: []
            )
        )

        XCTAssertTrue(shouldShortCircuitBackendMatch(analysis))
    }

    func testShouldShortCircuitBackendMatchAllowsExactCollectorSignal() {
        let analysis = makeAnalyzedCapture(
            cropConfidence: 0.40,
            collectorNumber: "057/193",
            setHintTokens: [],
            setBadgeHint: nil,
            rawEvidence: OCRRawEvidence(
                titleTextPrimary: nil,
                titleTextSecondary: nil,
                titleConfidence: nil,
                collectorNumberExact: "057/193",
                collectorNumberPartial: nil,
                collectorConfidence: OCRFieldConfidence.unknown,
                setBadgeHint: nil,
                setHints: [],
                setConfidence: nil,
                footerBandText: "",
                wholeCardText: "",
                warnings: []
            )
        )

        XCTAssertFalse(shouldShortCircuitBackendMatch(analysis))
    }

    func testDoesNotFastRejectWeakRawTargetSelectionForExactReticleFallback() {
        let image = makeImage(size: CGSize(width: 320, height: 460)) { context in
            UIColor.darkGray.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))
        }
        let targetSelection = OCRTargetSelectionResult(
            normalizedImage: image,
            normalizedContentRect: nil,
            selectionConfidence: 0.40,
            usedFallback: true,
            fallbackReason: "no_rectangle_detected",
            chosenCandidateIndex: nil,
            candidates: [],
            normalizedGeometryKind: .fallback,
            normalizationReason: "exact_reticle_fallback"
        )

        XCTAssertFalse(shouldFastRejectWeakRawTargetSelection(targetSelection))
    }

    func testDoesNotFastRejectRecoverableWeakTargetSelection() {
        let image = makeImage(size: CGSize(width: 320, height: 460)) { context in
            UIColor.darkGray.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))
        }
        let targetSelection = OCRTargetSelectionResult(
            normalizedImage: image,
            normalizedContentRect: nil,
            selectionConfidence: 0.52,
            usedFallback: true,
            fallbackReason: "multiple_rectangles_too_close_to_call",
            chosenCandidateIndex: nil,
            candidates: [],
            normalizedGeometryKind: .fallback,
            normalizationReason: "exact_reticle_fallback"
        )

        XCTAssertFalse(shouldFastRejectWeakRawTargetSelection(targetSelection))
    }

    func testDetectSlabLabelFallbackRectFindsTopLabelInNoisySlabCrop() {
        let image = makeImage(size: CGSize(width: 420, height: 720)) { context in
            UIColor(red: 0.96, green: 0.94, blue: 0.88, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 420, height: 720))

            UIColor(white: 0.85, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 420, height: 220))

            UIColor(white: 0.28, alpha: 1).setFill()
            context.fill(CGRect(x: 58, y: 210, width: 304, height: 450))

            UIColor(red: 0.89, green: 0.12, blue: 0.12, alpha: 1).setFill()
            context.fill(CGRect(x: 82, y: 248, width: 256, height: 78))

            UIColor.white.setFill()
            context.fill(CGRect(x: 96, y: 260, width: 228, height: 54))

            UIColor(white: 0.12, alpha: 1).setFill()
            context.fill(CGRect(x: 102, y: 292, width: 72, height: 10))
            context.fill(CGRect(x: 248, y: 266, width: 56, height: 30))

            UIColor(red: 0.18, green: 0.42, blue: 0.27, alpha: 1).setFill()
            context.fill(CGRect(x: 88, y: 340, width: 244, height: 282))

            UIColor(red: 0.78, green: 0.18, blue: 0.20, alpha: 1).setFill()
            context.fill(CGRect(x: 220, y: 390, width: 76, height: 120))
        }

        let rect = detectSlabLabelFallbackRect(in: image)

        XCTAssertNotNil(rect)
        XCTAssertLessThan(rect?.y ?? 1, 0.42)
        XCTAssertGreaterThan(rect?.width ?? 0, 0.40)
        XCTAssertLessThan(rect?.height ?? 1, 0.22)
    }

    func testDetectSlabLabelFallbackRectRejectsPlainDarkCrop() {
        let image = makeImage(size: CGSize(width: 420, height: 720)) { context in
            UIColor(white: 0.18, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 420, height: 720))
        }

        XCTAssertNil(detectSlabLabelFallbackRect(in: image))
    }

    func testDetectSlabLabelFallbackRectIgnoresRedCardArtBelowGuideBand() {
        let image = makeImage(size: CGSize(width: 420, height: 720)) { context in
            UIColor(red: 0.96, green: 0.94, blue: 0.88, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 420, height: 720))

            UIColor(white: 0.78, alpha: 1).setFill()
            context.fill(CGRect(x: 52, y: 86, width: 316, height: 568))

            UIColor(red: 0.89, green: 0.13, blue: 0.13, alpha: 1).setFill()
            context.fill(CGRect(x: 80, y: 112, width: 260, height: 76))

            UIColor.white.setFill()
            context.fill(CGRect(x: 96, y: 126, width: 228, height: 46))

            UIColor(white: 0.15, alpha: 1).setFill()
            context.fill(CGRect(x: 102, y: 140, width: 118, height: 10))
            context.fill(CGRect(x: 266, y: 126, width: 44, height: 30))

            UIColor(red: 0.86, green: 0.31, blue: 0.15, alpha: 1).setFill()
            context.fill(CGRect(x: 86, y: 250, width: 248, height: 220))

            UIColor(red: 0.80, green: 0.08, blue: 0.10, alpha: 1).setFill()
            context.fill(CGRect(x: 132, y: 300, width: 168, height: 180))
        }

        let rect = detectSlabLabelFallbackRect(in: image)

        XCTAssertNotNil(rect)
        XCTAssertLessThan((rect?.y ?? 1) + (rect?.height ?? 1), PSASlabGuidance.labelDividerRatio + 0.11)
        XCTAssertLessThan(rect?.height ?? 1, 0.22)
    }

    func testDetectSlabLabelFallbackRectFindsRealCharizardFullSlabFixture() {
        let imageURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("qa/incoming-slab-regression/psa-charizard-v-079-champions-path-secret-52300610-full-slab.jpg")
        guard let image = UIImage(contentsOfFile: imageURL.path) else {
            XCTFail("unable to load Charizard full-slab fixture")
            return
        }

        let rect = detectSlabLabelFallbackRect(in: image)

        XCTAssertNotNil(rect)
    }

    func testSelectOCRInputAcceptsRealCharizardFullSlabFixture() throws {
        let imageURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("qa/incoming-slab-regression/psa-charizard-v-079-champions-path-secret-52300610-full-slab.jpg")
        guard let image = UIImage(contentsOfFile: imageURL.path) else {
            XCTFail("unable to load Charizard full-slab fixture")
            return
        }
        let capture = ScanCaptureInput(
            originalImage: image,
            searchImage: image,
            fallbackImage: image,
            captureSource: .importedPhoto
        )

        let selection = try selectOCRInput(
            scanID: UUID(),
            capture: capture,
            mode: .psaSlab
        )

        XCTAssertTrue(selection.normalizedGeometryKind == .slab || selection.normalizedGeometryKind == .slabLabel)
    }

    func testSelectOCRInputRejectsBroadSlabFallbackWhenNoPSASlabOrLabelIsFound() {
        let image = makeImage(size: CGSize(width: 420, height: 720)) { context in
            UIColor(white: 0.18, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 420, height: 720))
        }
        let capture = ScanCaptureInput(
            originalImage: image,
            searchImage: image,
            fallbackImage: image,
            captureSource: .importedPhoto
        )

        XCTAssertThrowsError(
            try selectOCRInput(
                scanID: UUID(),
                capture: capture,
                mode: .psaSlab
            )
        ) { error in
            XCTAssertEqual(
                error.localizedDescription,
                "Could not isolate the PSA slab or label. Fit the full slab inside the reticle and keep the label above the guide."
            )
        }
    }

    func testPSASlabGuideBandMatchesTopLabelOCRRegion() {
        XCTAssertEqual(PSASlabGuidance.labelDividerRatio, 0.28, accuracy: 0.001)
        XCTAssertEqual(
            SlabScanConfiguration.default.labelOCR.topLabelWideRegion.height,
            PSASlabGuidance.labelDividerRatio,
            accuracy: 0.001
        )
        XCTAssertEqual(SlabScanConfiguration.default.labelOCR.topLabelWideRegion.minY, 0, accuracy: 0.001)
        XCTAssertGreaterThan(
            SlabScanConfiguration.default.labelOCR.topLabelExpandedRegion.height,
            SlabScanConfiguration.default.labelOCR.topLabelWideRegion.height
        )
    }

    func testLowConfidenceResponsesStayInTrayUntilTapped() {
        let response = makeMatchResponse(confidence: .low, reviewDisposition: .ready)

        XCTAssertEqual(matchedStackPhase(for: response), .needsReview)
        XCTAssertFalse(shouldPresentAlternativesImmediately(for: response))
    }

    func testNeedsReviewDispositionStaysInTrayUntilTapped() {
        let response = makeMatchResponse(confidence: .medium, reviewDisposition: .needsReview)

        XCTAssertEqual(matchedStackPhase(for: response), .needsReview)
        XCTAssertFalse(shouldPresentAlternativesImmediately(for: response))
    }

    func testMediumReadyResponseStaysResolvedInTray() {
        let response = makeMatchResponse(confidence: .medium, reviewDisposition: .ready)

        XCTAssertEqual(matchedStackPhase(for: response), .resolved)
        XCTAssertFalse(shouldPresentAlternativesImmediately(for: response))
    }

    func testSlabResponsesDoNotAutoAcceptEvenWhenHighConfidence() {
        let response = makeMatchResponse(
            confidence: .high,
            reviewDisposition: .ready,
            resolverMode: .psaSlab
        )

        XCTAssertFalse(shouldAutoAccept(response))
    }

    func testUnsupportedResponsesDoNotAutoOpenAlternatives() {
        let response = makeMatchResponse(confidence: .low, reviewDisposition: .unsupported)

        XCTAssertEqual(matchedStackPhase(for: response), .unsupported)
        XCTAssertFalse(shouldPresentAlternativesImmediately(for: response))
    }

    func testResultCandidateCycleStateReportsCurrentPosition() {
        let candidates = [
            makeCardCandidate(id: "a", name: "Alpha"),
            makeCardCandidate(id: "b", name: "Beta"),
            makeCardCandidate(id: "c", name: "Gamma")
        ]

        let state = resultCandidateCycleState(
            currentCardID: "b",
            topCandidates: candidates
        )

        XCTAssertEqual(state, ResultCandidateCycleState(currentIndex: 2, totalCount: 3))
    }

    func testNextResultCandidateWrapsAround() {
        let candidates = [
            makeCardCandidate(id: "a", name: "Alpha"),
            makeCardCandidate(id: "b", name: "Beta"),
            makeCardCandidate(id: "c", name: "Gamma")
        ]

        XCTAssertEqual(nextResultCandidate(currentCardID: "c", topCandidates: candidates)?.id, "a")
    }

    func testInvalidReticleCaptureRectRejectsZeroOrInfiniteBounds() {
        XCTAssertFalse(isValidReticleCaptureRect(.zero))
        XCTAssertFalse(isValidReticleCaptureRect(CGRect(x: CGFloat.infinity, y: 0, width: 10, height: 10)))
    }

    func testValidReticleCaptureRectAcceptsFiniteSizedBounds() {
        XCTAssertTrue(isValidReticleCaptureRect(CGRect(x: 10, y: 20, width: 240, height: 340)))
    }

    func testBroadFooterExactCollectorSkipsTightFooterPasses() {
        let model = RawConfidenceModel()
        let broadPass = RawOCRPassResult(
            kind: .footerBandWide,
            label: "13_raw_footer_band",
            normalizedRect: OCRNormalizedRect(x: 0.0, y: 0.78, width: 1.0, height: 0.22),
            text: "S10 072/070",
            tokens: [
                RecognizedToken(text: "S10", confidence: 0.92),
                RecognizedToken(text: "072/070", confidence: 0.94)
            ]
        )

        XCTAssertTrue(model.shouldSkipTightFooterPasses(after: [broadPass]))
    }

    func testBroadFooterWithoutExactCollectorKeepsTightFooterPasses() {
        let model = RawConfidenceModel()
        let broadPass = RawOCRPassResult(
            kind: .footerBandWide,
            label: "13_raw_footer_band",
            normalizedRect: OCRNormalizedRect(x: 0.0, y: 0.78, width: 1.0, height: 0.22),
            text: "S10",
            tokens: [
                RecognizedToken(text: "S10", confidence: 0.92)
            ]
        )

        XCTAssertFalse(model.shouldSkipTightFooterPasses(after: [broadPass]))
    }

    func testExactReticleFallbackStrongLoweredHeaderSkipsWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: true,
            targetQualityScore: 0.40,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            normalizationReason: "exact_reticle_fallback",
            warnings: ["Target selection used fallback crop"]
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "Lt. Surge's Bargain",
            tokens: [
                RecognizedToken(text: "Lt.", confidence: 0.98),
                RecognizedToken(text: "Surge's", confidence: 0.96),
                RecognizedToken(text: "Bargain", confidence: 0.95)
            ]
        )

        XCTAssertTrue(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: "185/132",
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
    }

    func testExactReticleFallbackWeakLoweredHeaderKeepsWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: true,
            targetQualityScore: 0.40,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            normalizationReason: "exact_reticle_fallback",
            warnings: ["Target selection used fallback crop"]
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "HP",
            tokens: [
                RecognizedToken(text: "HP", confidence: 0.78)
            ]
        )

        XCTAssertFalse(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: "185/132",
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
    }

    func testNonFallbackNeverSkipsWideHeaderPassFromLoweredResult() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: false,
            targetQualityScore: 0.86,
            normalizationReason: "basic_perspective_canonicalization",
            warnings: []
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "Lt. Surge's Bargain",
            tokens: [
                RecognizedToken(text: "Lt.", confidence: 0.98),
                RecognizedToken(text: "Surge's", confidence: 0.96),
                RecognizedToken(text: "Bargain", confidence: 0.95)
            ]
        )

        XCTAssertFalse(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: "185/132",
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
    }

    func testExactReticleFallbackJapaneseTitleWithoutSetHintKeepsWideHeaderPass() {
        let model = RawConfidenceModel()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: true,
            targetQualityScore: 0.44,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            normalizationReason: "exact_reticle_fallback",
            warnings: ["Target selection used fallback crop"]
        )
        let loweredPass = RawOCRPassResult(
            kind: .headerWide,
            label: "12_raw_header_wide_lowered",
            normalizedRect: OCRNormalizedRect(x: 0.06, y: 0.05, width: 0.88, height: 0.22),
            text: "なるイーブイ＆カビゴンタス HP",
            tokens: [
                RecognizedToken(text: "なるイーブイ＆カビゴンタス", confidence: 0.3),
                RecognizedToken(text: "HP 270 *", confidence: 0.5),
                RecognizedToken(text: "TAG TEAM", confidence: 1.0)
            ]
        )

        XCTAssertFalse(
            model.shouldSkipWideHeaderPassAfterLowered(
                passResults: [loweredPass],
                sceneTraits: sceneTraits,
                stage1Assessment: RawStageAssessment(
                    titleTextPrimary: nil,
                    titleConfidenceScore: 0,
                    collectorNumberExact: "066/095",
                    setHintTokens: [],
                    shouldEscalate: true,
                    reasons: []
                )
            )
        )
    }

    func testResolvedReticleCaptureRectFallsBackToLayoutWhenPreferredBoundsAreZero() {
        let layout = ScannerReticleLayout(
            width: 260,
            height: 364,
            topSpacing: 175,
            controlsTopSpacing: 16,
            controlsHeight: 36,
            bottomClearance: 120
        )

        let resolved = resolvedReticleCaptureRect(
            preferred: .zero,
            containerFrame: CGRect(x: 0, y: 0, width: 390, height: 844),
            layout: layout
        )

        XCTAssertEqual(resolved.origin.x, 65, accuracy: 0.5)
        XCTAssertEqual(resolved.origin.y, 175, accuracy: 0.5)
        XCTAssertEqual(resolved.width, 260, accuracy: 0.5)
        XCTAssertEqual(resolved.height, 364, accuracy: 0.5)
    }

    func testResolvedReticleCaptureRectPrefersMeasuredBoundsWhenValid() {
        let preferred = CGRect(x: 64.7, y: 175.0, width: 260.6, height: 364.0)
        let layout = ScannerReticleLayout(
            width: 260,
            height: 364,
            topSpacing: 175,
            controlsTopSpacing: 16,
            controlsHeight: 36,
            bottomClearance: 120
        )

        let resolved = resolvedReticleCaptureRect(
            preferred: preferred,
            containerFrame: CGRect(x: 0, y: 0, width: 390, height: 844),
            layout: layout
        )

        XCTAssertEqual(resolved.origin.x, preferred.origin.x, accuracy: 0.001)
        XCTAssertEqual(resolved.origin.y, preferred.origin.y, accuracy: 0.001)
        XCTAssertEqual(resolved.width, preferred.width, accuracy: 0.001)
        XCTAssertEqual(resolved.height, preferred.height, accuracy: 0.001)
    }

    private func makeAnalyzedCapture(
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

    private func shouldShortCircuitBackendMatch(_ analysis: AnalyzedCapture) -> Bool {
        guard analysis.resolverModeHint == .rawCard else {
            return false
        }

        let rawEvidence = analysis.ocrAnalysis?.rawEvidence
        let hasExactCollector = normalizedNonEmpty(analysis.collectorNumber) != nil
            || normalizedNonEmpty(rawEvidence?.collectorNumberExact) != nil
        let hasTrustedTitle = normalizedNonEmpty(rawEvidence?.titleTextPrimary) != nil
            || normalizedNonEmpty(rawEvidence?.titleTextSecondary) != nil
        let hasSetHints = !(rawEvidence?.setHints ?? analysis.setHintTokens).isEmpty
            || analysis.setBadgeHint != nil
            || rawEvidence?.setBadgeHint != nil

        guard analysis.cropConfidence <= 0.40 else {
            return false
        }

        return !hasExactCollector && !hasTrustedTitle && !hasSetHints
    }

    private func normalizedNonEmpty(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func makeFieldConfidence(_ score: Double) -> OCRFieldConfidence {
        OCRFieldConfidence(
            score: score,
            agreementScore: nil,
            tokenConfidenceAverage: nil,
            reasons: []
        )
    }

    private func makeMatchResponse(
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
            performance: nil
        )
    }

    @MainActor
    private func makeScannerViewModel(
        matcher: any CardMatchingService = StubCardMatchingService(),
        logStore: ScanEventStore = ScanEventStore(),
        artifactUploadsEnabled: Bool = true
    ) -> ScannerViewModel {
        ScannerViewModel(
            cameraController: CameraSessionController(),
            ocrPipeline: OCRPipelineCoordinator(
                rawRewritePipeline: RawPipeline(),
                slabAnalyzer: SlabScanner(config: .default)
            ),
            matcher: matcher,
            logStore: logStore,
            artifactUploadsEnabled: artifactUploadsEnabled
        )
    }

    private func makeScanStackItem(
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

    private func makeScanEventStore() -> ScanEventStore {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: url)
        }
        return ScanEventStore(baseDirectoryURL: url)
    }

    @MainActor
    private func makeCollectionStore() -> CollectionStore {
        makeCollectionStore(matcher: nil)
    }

    @MainActor
    private func makeCollectionStore(matcher: (any CardMatchingService)?) -> CollectionStore {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: url)
        }
        return CollectionStore(matcher: matcher, baseDirectoryURL: url)
    }

    private func makeDeckEntryPayload(
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

    private func makeDate(_ iso8601: String) -> Date {
        ISO8601DateFormatter().date(from: iso8601) ?? Date()
    }

    private func makeCardCandidate(
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

    private func makeImage(
        size: CGSize,
        draw: (CGContext) -> Void
    ) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        if #available(iOS 12.0, *) {
            format.preferredRange = .standard
        }
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { context in
            draw(context.cgContext)
        }
    }
}

private actor StubCardMatchingService: CardMatchingService {
    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse {
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

    func fetchDeckEntries() async -> [DeckEntryPayload] {
        []
    }

    func updateDeckEntryCondition(_ payload: DeckEntryConditionUpdateRequestPayload) async throws {}

    func uploadScanArtifacts(_ payload: ScanArtifactUploadRequestPayload) async throws {}

    func addDeckEntry(_ payload: DeckEntryCreateRequestPayload) async throws {}

    func submitFeedback(
        scanID: UUID,
        selectedCardID: String?,
        wasTopPrediction: Bool,
        correctionType: CorrectionType
    ) async {}
}

private actor RecordingCardMatchingService: CardMatchingService {
    private var artifactPayloads: [ScanArtifactUploadRequestPayload] = []
    private var deckPayloads: [DeckEntryCreateRequestPayload] = []
    private var deckEntries: [DeckEntryPayload] = []
    private var deckConditionPayloads: [DeckEntryConditionUpdateRequestPayload] = []

    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse {
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

    func fetchDeckEntries() async -> [DeckEntryPayload] {
        deckEntries
    }

    func updateDeckEntryCondition(_ payload: DeckEntryConditionUpdateRequestPayload) async throws {
        deckConditionPayloads.append(payload)
    }

    func uploadScanArtifacts(_ payload: ScanArtifactUploadRequestPayload) async throws {
        artifactPayloads.append(payload)
    }

    func addDeckEntry(_ payload: DeckEntryCreateRequestPayload) async throws {
        deckPayloads.append(payload)
    }

    func submitFeedback(
        scanID: UUID,
        selectedCardID: String?,
        wasTopPrediction: Bool,
        correctionType: CorrectionType
    ) async {}

    func uploadedArtifactPayloads() -> [ScanArtifactUploadRequestPayload] {
        artifactPayloads
    }

    func deckEntryPayloads() -> [DeckEntryCreateRequestPayload] {
        deckPayloads
    }

    func setDeckEntries(_ entries: [DeckEntryPayload]) {
        deckEntries = entries
    }

    func deckConditionUpdatePayloads() -> [DeckEntryConditionUpdateRequestPayload] {
        deckConditionPayloads
    }
}
