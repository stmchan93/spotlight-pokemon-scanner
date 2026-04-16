import XCTest
import CoreGraphics
@testable import Spotlight

@MainActor
final class DeckPortfolioTests: XCTestCase {
    func testSlabContextDisplayBadgeTitlePrefersGraderAndGrade() {
        let slabContext = SlabContext(grader: "PSA", grade: "10", certNumber: "12345", variantName: "Raw")
        XCTAssertEqual(slabContext.displayBadgeTitle, "PSA 10")
    }

    func testSlabContextDisplayBadgeTitleFallsBackToGraderWhenGradeMissing() {
        let slabContext = SlabContext(grader: "CGC", grade: nil, certNumber: "12345", variantName: "Raw")
        XCTAssertEqual(slabContext.displayBadgeTitle, "CGC")
    }

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

    func testCollectionStorePreservesEntriesWhenBackendRefreshFails() async {
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

        await matcher.setDeckEntriesFetchFailure(true)
        await store.refreshFromBackend()

        XCTAssertEqual(store.entries.count, 1)
        XCTAssertEqual(store.entries.first?.card.id, card.id)
        XCTAssertEqual(store.entries.first?.quantity, 3)
        XCTAssertEqual(store.totalCardCount, 3)
    }

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

    func testCollectionStoreAddDoesNotCreateLegacyDeckJsonFile() throws {
        let fileManager = FileManager.default
        let rootURL = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: rootURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: rootURL) }

        let spotlightDirectoryURL = rootURL.appendingPathComponent("Spotlight", isDirectory: true)
        try fileManager.createDirectory(at: spotlightDirectoryURL, withIntermediateDirectories: true)
        let legacyFileURL = spotlightDirectoryURL.appendingPathComponent("deck_collection.json")
        try Data("{\"entries\":[]}".utf8).write(to: legacyFileURL)

        let store = CollectionStore(baseDirectoryURL: rootURL)
        let initialCard = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: nil)
        XCTAssertEqual(store.add(card: initialCard, slabContext: nil), 1)

        XCTAssertEqual(store.entries.count, 1)
        XCTAssertFalse(fileManager.fileExists(atPath: legacyFileURL.path))
    }

    func testCollectionStoreSearchMatchesNameSetAndNumber() throws {
        let store = makeCollectionStore()

        XCTAssertEqual(store.add(card: makeCardCandidate(id: "base1-4", name: "Charizard", setName: "Base Set", number: "4/102"), slabContext: nil), 1)
        XCTAssertEqual(store.add(card: makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", setName: "Gym Heroes", number: "60/132"), slabContext: nil), 1)

        XCTAssertEqual(store.searchResults(for: "char").count, 1)
        XCTAssertEqual(store.searchResults(for: "gym heroes").count, 1)
        XCTAssertEqual(store.searchResults(for: "60/132").count, 1)
        XCTAssertEqual(store.searchResults(for: "missing").count, 0)
    }

    func testFilteredPortfolioEntriesRespectsSearchAndInventoryFilter() {
        let rawEntry = DeckCardEntry(
            id: "raw|base1-4",
            card: makeCardCandidate(id: "base1-4", name: "Charizard", setName: "Base Set", number: "4/102", marketPrice: 250),
            slabContext: nil,
            condition: .nearMint,
            quantity: 1,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
            addedAt: makeDate("2026-04-12T12:00:00Z")
        )
        let gradedEntry = DeckCardEntry(
            id: "slab|base1-2",
            card: makeCardCandidate(id: "base1-2", name: "Blastoise", setName: "Base Set", number: "2/102", marketPrice: 500),
            slabContext: SlabContext(grader: "PSA", grade: "9", certNumber: "12345", variantName: "Unlimited"),
            condition: nil,
            quantity: 1,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
            addedAt: makeDate("2026-04-13T12:00:00Z")
        )

        XCTAssertEqual(
            filteredPortfolioEntries([rawEntry, gradedEntry], searchQuery: "char", filter: .all).map(\.id),
            [rawEntry.id]
        )
        XCTAssertEqual(
            Set(filteredPortfolioEntries([rawEntry, gradedEntry], searchQuery: "", filter: .graded).map(\.id)),
            [gradedEntry.id]
        )
        XCTAssertEqual(
            Set(filteredPortfolioEntries([rawEntry, gradedEntry], searchQuery: "psa", filter: .all).map(\.id)),
            [gradedEntry.id]
        )
    }

    func testToggledPortfolioSelectionIDsAddsAndRemovesEntries() {
        let selectedOnce = toggledPortfolioSelectionIDs([], entryID: "raw|base1-4")
        XCTAssertEqual(selectedOnce, ["raw|base1-4"])

        let deselected = toggledPortfolioSelectionIDs(selectedOnce, entryID: "raw|base1-4")
        XCTAssertTrue(deselected.isEmpty)
    }

    func testPortfolioSelectionModeShouldRemainActiveOnlyWhenSelectionsExist() {
        XCTAssertTrue(portfolioSelectionModeShouldRemainActive(selectedIDs: ["raw|base1-4"]))
        XCTAssertFalse(portfolioSelectionModeShouldRemainActive(selectedIDs: []))
    }

    func testCollectionStoreRefreshesPortfolioHistoryFromBackend() async {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        await matcher.setPortfolioHistory(
            PortfolioHistory(
                range: .days7,
                summary: PortfolioHistorySummary(
                    currentValue: 88.5,
                    startValue: 72.0,
                    deltaValue: 16.5,
                    deltaPercent: 22.9167,
                    currentCostBasisValue: nil,
                    startCostBasisValue: nil,
                    deltaCostBasisValue: nil
                ),
                coverage: PortfolioHistoryCoverage(
                    pricedCardCount: 2,
                    excludedCardCount: 1
                ),
                currencyCode: "USD",
                points: [
                    PortfolioHistoryPoint(
                        date: "2026-04-08",
                        totalValue: 72.0,
                        marketValue: 72.0,
                        costBasisValue: nil,
                        pricedCardCount: 2,
                        excludedCardCount: 1
                    ),
                    PortfolioHistoryPoint(
                        date: "2026-04-14",
                        totalValue: 88.5,
                        marketValue: 88.5,
                        costBasisValue: nil,
                        pricedCardCount: 2,
                        excludedCardCount: 1
                    ),
                ],
                isFresh: true,
                refreshedAt: "2026-04-14T20:00:00Z"
            )
        )

        await store.refreshPortfolioHistory(range: .days7)

        XCTAssertEqual(store.selectedPortfolioHistoryRange, .days7)
        XCTAssertEqual(store.portfolioHistory?.summary.currentValue, 88.5)
        XCTAssertEqual(store.portfolioHistory?.points.count, 2)
    }

    func testCollectionStorePreservesPortfolioHistoryWhenRefreshFails() async {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        let history = PortfolioHistory(
            range: .days7,
            summary: PortfolioHistorySummary(
                currentValue: 88.5,
                startValue: 72.0,
                deltaValue: 16.5,
                deltaPercent: 22.9167,
                currentCostBasisValue: nil,
                startCostBasisValue: nil,
                deltaCostBasisValue: nil
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 2,
                excludedCardCount: 1
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-08",
                    totalValue: 72.0,
                    marketValue: 72.0,
                    costBasisValue: nil,
                    pricedCardCount: 2,
                    excludedCardCount: 1
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-14",
                    totalValue: 88.5,
                    marketValue: 88.5,
                    costBasisValue: nil,
                    pricedCardCount: 2,
                    excludedCardCount: 1
                ),
            ],
            isFresh: true,
            refreshedAt: "2026-04-14T20:00:00Z"
        )

        await matcher.setPortfolioHistory(history)
        await store.refreshPortfolioHistory(range: .days7)

        await matcher.setPortfolioHistory(nil)
        await store.refreshPortfolioHistory(range: .days7)

        XCTAssertEqual(store.portfolioHistory?.summary.currentValue, 88.5)
        XCTAssertEqual(store.portfolioHistory?.points.count, 2)
    }

    func testUsablePortfolioHistoryPointsIgnoresUnpricedOnlyHistory() {
        let history = PortfolioHistory(
            range: .days30,
            summary: PortfolioHistorySummary(
                currentValue: 0.0,
                startValue: 0.0,
                deltaValue: 0.0,
                deltaPercent: nil,
                currentCostBasisValue: nil,
                startCostBasisValue: nil,
                deltaCostBasisValue: nil
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 0,
                excludedCardCount: 3
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-13",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: nil,
                    pricedCardCount: 0,
                    excludedCardCount: 3
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-14",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: nil,
                    pricedCardCount: 0,
                    excludedCardCount: 3
                )
            ],
            isFresh: true,
            refreshedAt: "2026-04-14T20:00:00Z"
        )

        XCTAssertTrue(usablePortfolioHistoryPoints(history).isEmpty)
    }

    func testUsablePortfolioHistoryPointsPreservesPricedHistory() {
        let history = PortfolioHistory(
            range: .days30,
            summary: PortfolioHistorySummary(
                currentValue: 42.0,
                startValue: 30.0,
                deltaValue: 12.0,
                deltaPercent: 40.0,
                currentCostBasisValue: nil,
                startCostBasisValue: nil,
                deltaCostBasisValue: nil
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 2,
                excludedCardCount: 0
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-13",
                    totalValue: 30.0,
                    marketValue: 30.0,
                    costBasisValue: nil,
                    pricedCardCount: 2,
                    excludedCardCount: 0
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-14",
                    totalValue: 42.0,
                    marketValue: 42.0,
                    costBasisValue: nil,
                    pricedCardCount: 2,
                    excludedCardCount: 0
                )
            ],
            isFresh: true,
            refreshedAt: "2026-04-14T20:00:00Z"
        )

        XCTAssertEqual(usablePortfolioHistoryPoints(history).count, 2)
    }

    func testUsablePortfolioHistoryPointsSkipsUnpricedPlaceholderDays() {
        let history = PortfolioHistory(
            range: .days30,
            summary: PortfolioHistorySummary(
                currentValue: 167.94,
                startValue: 0.0,
                deltaValue: 167.94,
                deltaPercent: nil,
                currentCostBasisValue: 0.0,
                startCostBasisValue: 0.0,
                deltaCostBasisValue: 0.0
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 3,
                excludedCardCount: 1
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-14",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: 0.0,
                    pricedCardCount: 0,
                    excludedCardCount: 7
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-15",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: 0.0,
                    pricedCardCount: 0,
                    excludedCardCount: 7
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-16",
                    totalValue: 167.94,
                    marketValue: 167.94,
                    costBasisValue: 0.0,
                    pricedCardCount: 3,
                    excludedCardCount: 1
                )
            ],
            isFresh: true,
            refreshedAt: "2026-04-16T20:00:00Z"
        )

        let points = usablePortfolioHistoryPoints(history)
        XCTAssertEqual(points.count, 1)
        XCTAssertEqual(points.first?.date, "2026-04-16")
    }

    func testLatestPricedPortfolioHistoryPointIndexSkipsTrailingUnpricedPoints() {
        let points = [
            PortfolioHistoryPoint(
                date: "2026-04-12",
                totalValue: 420.0,
                marketValue: 420.0,
                costBasisValue: 300.0,
                pricedCardCount: 3,
                excludedCardCount: 0
            ),
            PortfolioHistoryPoint(
                date: "2026-04-13",
                totalValue: 515.0,
                marketValue: 515.0,
                costBasisValue: 300.0,
                pricedCardCount: 3,
                excludedCardCount: 0
            ),
            PortfolioHistoryPoint(
                date: "2026-04-14",
                totalValue: 0.0,
                marketValue: 0.0,
                costBasisValue: 0.0,
                pricedCardCount: 0,
                excludedCardCount: 3
            )
        ]

        XCTAssertEqual(latestPricedPortfolioHistoryPointIndex(in: points), 1)
    }

    func testResolvedPortfolioHistorySelectionIndexFallsBackToLatestPricedPoint() {
        let history = PortfolioHistory(
            range: .days90,
            summary: PortfolioHistorySummary(
                currentValue: 515.0,
                startValue: 120.0,
                deltaValue: 395.0,
                deltaPercent: 329.17,
                currentCostBasisValue: 300.0,
                startCostBasisValue: 300.0,
                deltaCostBasisValue: 0.0
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 3,
                excludedCardCount: 0
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-12",
                    totalValue: 420.0,
                    marketValue: 420.0,
                    costBasisValue: 300.0,
                    pricedCardCount: 3,
                    excludedCardCount: 0
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-13",
                    totalValue: 515.0,
                    marketValue: 515.0,
                    costBasisValue: 300.0,
                    pricedCardCount: 3,
                    excludedCardCount: 0
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-14",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: 0.0,
                    pricedCardCount: 0,
                    excludedCardCount: 3
                )
            ],
            isFresh: true,
            refreshedAt: "2026-04-14T20:00:00Z"
        )

        XCTAssertEqual(
            resolvedPortfolioHistorySelectionIndex(selectedPointIndex: 2, history: history),
            1
        )
        XCTAssertEqual(
            resolvedPortfolioHistorySelectionIndex(selectedPointIndex: nil, history: history),
            1
        )
    }

    func testPortfolioSinglePricedHistoryDisplayDrawsBaselineThenDiagonalToLatestPoint() {
        let history = PortfolioHistory(
            range: .days30,
            summary: PortfolioHistorySummary(
                currentValue: 117.98,
                startValue: 0.0,
                deltaValue: 117.98,
                deltaPercent: nil,
                currentCostBasisValue: 0.0,
                startCostBasisValue: 0.0,
                deltaCostBasisValue: 0.0
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 3,
                excludedCardCount: 1
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-14",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: 0.0,
                    pricedCardCount: 0,
                    excludedCardCount: 4
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-15",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: 0.0,
                    pricedCardCount: 0,
                    excludedCardCount: 4
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-16",
                    totalValue: 117.98,
                    marketValue: 117.98,
                    costBasisValue: 0.0,
                    pricedCardCount: 3,
                    excludedCardCount: 1
                )
            ],
            isFresh: true,
            refreshedAt: "2026-04-16T20:00:00Z"
        )

        let display = portfolioSinglePricedHistoryDisplay(
            history: history,
            size: CGSize(width: 300, height: 200)
        )

        XCTAssertNotNil(display)
        guard let display else { return }
        XCTAssertEqual(display.points.count, 3)
        XCTAssertEqual(display.points[0].y, display.points[1].y, accuracy: 0.001)
        XCTAssertGreaterThan(display.points[2].x, display.points[1].x)
        XCTAssertLessThan(display.points[2].y, display.points[1].y)
        XCTAssertEqual(display.selectionPoint.x, display.points[2].x, accuracy: 0.001)
        XCTAssertEqual(display.selectionPoint.y, display.points[2].y, accuracy: 0.001)
    }

    func testPortfolioCurrentMarketValueFallsBackToLiveEntriesWhenHistoryIsUnpriced() {
        let history = PortfolioHistory(
            range: .days30,
            summary: PortfolioHistorySummary(
                currentValue: 0.0,
                startValue: 0.0,
                deltaValue: 0.0,
                deltaPercent: nil,
                currentCostBasisValue: 0.0,
                startCostBasisValue: 0.0,
                deltaCostBasisValue: 0.0
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 0,
                excludedCardCount: 2
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-14",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: 0.0,
                    pricedCardCount: 0,
                    excludedCardCount: 2
                )
            ],
            isFresh: true,
            refreshedAt: "2026-04-14T20:00:00Z"
        )

        XCTAssertEqual(portfolioCurrentMarketValue(from: history, fallbackValue: 534.19), 534.19)
    }

    func testPortfolioSelectedEntriesReturnsOnlyMatchingIDs() {
        let first = DeckCardEntry(
            id: "raw|gym1-60",
            card: makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12),
            slabContext: nil,
            condition: nil,
            quantity: 1,
            costBasisTotal: 0,
            costBasisCurrencyCode: "USD",
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )
        let second = DeckCardEntry(
            id: "raw|base5-14",
            card: makeCardCandidate(id: "base5-14", name: "Dark Weezing", marketPrice: 44),
            slabContext: nil,
            condition: nil,
            quantity: 2,
            costBasisTotal: 0,
            costBasisCurrencyCode: "USD",
            addedAt: makeDate("2026-04-14T13:00:00Z")
        )

        let selected = portfolioSelectedEntries([first, second], selectedIDs: ["raw|base5-14"])
        XCTAssertEqual(selected, [second])
    }

    func testPortfolioBatchSelectionSummarySumsCardsQuantityAndValue() {
        let entries = [
            DeckCardEntry(
                id: "raw|gym1-60",
                card: makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12),
                slabContext: nil,
                condition: nil,
                quantity: 1,
                costBasisTotal: 0,
                costBasisCurrencyCode: "USD",
                addedAt: makeDate("2026-04-14T12:00:00Z")
            ),
            DeckCardEntry(
                id: "raw|base5-14",
                card: makeCardCandidate(id: "base5-14", name: "Dark Weezing", marketPrice: 44),
                slabContext: nil,
                condition: nil,
                quantity: 2,
                costBasisTotal: 0,
                costBasisCurrencyCode: "USD",
                addedAt: makeDate("2026-04-14T13:00:00Z")
            )
        ]

        let summary = portfolioBatchSelectionSummary(for: entries)
        XCTAssertEqual(summary.cardCount, 2)
        XCTAssertEqual(summary.quantity, 3)
        XCTAssertEqual(summary.marketValue, 100)
        XCTAssertEqual(summary.currencyCode, "USD")
    }

    func testPortfolioResolvedCalculatorPriceSupportsAllPresets() {
        XCTAssertEqual(
            portfolioResolvedCalculatorPrice(
                marketPrice: 100,
                listPrice: 125,
                percentOff: 10,
                dollarOff: 8,
                preset: .market
            ),
            100,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            portfolioResolvedCalculatorPrice(
                marketPrice: 100,
                listPrice: 125,
                percentOff: 10,
                dollarOff: 8,
                preset: .list
            ),
            125,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            portfolioResolvedCalculatorPrice(
                marketPrice: 100,
                listPrice: 125,
                percentOff: 10,
                dollarOff: 8,
                preset: .percentOff
            ),
            90,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            portfolioResolvedCalculatorPrice(
                marketPrice: 100,
                listPrice: 125,
                percentOff: 10,
                dollarOff: 8,
                preset: .dollarOff
            ),
            92,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            portfolioResolvedCalculatorPrice(
                marketPrice: 100,
                listPrice: 125,
                percentOff: 10,
                dollarOff: 8,
                preset: .eightyPercent
            ),
            80,
            accuracy: 0.0001
        )
    }

    func testChartDragShouldScrubAllowsForgivingHorizontalDrags() {
        XCTAssertTrue(chartDragShouldScrub(translation: CGSize(width: 24, height: 6)))
        XCTAssertTrue(chartDragShouldScrub(translation: CGSize(width: 18, height: 18)))
        XCTAssertFalse(chartDragShouldScrub(translation: CGSize(width: 6, height: 24)))
        XCTAssertFalse(chartDragShouldScrub(translation: CGSize(width: 4, height: 1)))
    }

    func testDashboardHistoryPointsPreserveZeroValuedDaysForInventorySeries() {
        let history = PortfolioHistory(
            range: .days30,
            summary: PortfolioHistorySummary(
                currentValue: 117.98,
                startValue: 0.0,
                deltaValue: 117.98,
                deltaPercent: nil,
                currentCostBasisValue: 0.0,
                startCostBasisValue: 0.0,
                deltaCostBasisValue: 0.0
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 3,
                excludedCardCount: 1
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-15",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: 0.0,
                    pricedCardCount: 0,
                    excludedCardCount: 7
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-16",
                    totalValue: 117.98,
                    marketValue: 117.98,
                    costBasisValue: 0.0,
                    pricedCardCount: 3,
                    excludedCardCount: 1
                ),
            ],
            isFresh: true,
            refreshedAt: "2026-04-16T20:00:00Z"
        )

        let points = dashboardHistoryPoints(history)

        XCTAssertEqual(points.map(\.date), ["2026-04-15", "2026-04-16"])
        XCTAssertEqual(points.first?.totalValue, 0.0)
        XCTAssertEqual(points.first?.costBasisValue, 0.0)
        XCTAssertEqual(points.last?.totalValue, 117.98)
    }

    func testPortfolioSinglePricedHistoryDisplayBuildsFlatLeadInThenDiagonalRise() {
        let history = PortfolioHistory(
            range: .days30,
            summary: PortfolioHistorySummary(
                currentValue: 44.38,
                startValue: 0.0,
                deltaValue: 44.38,
                deltaPercent: nil,
                currentCostBasisValue: 0.0,
                startCostBasisValue: 0.0,
                deltaCostBasisValue: 0.0
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 1,
                excludedCardCount: 2
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-10",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: 0.0,
                    pricedCardCount: 0,
                    excludedCardCount: 1
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-11",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: 0.0,
                    pricedCardCount: 0,
                    excludedCardCount: 1
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-12",
                    totalValue: 44.38,
                    marketValue: 44.38,
                    costBasisValue: 0.0,
                    pricedCardCount: 1,
                    excludedCardCount: 0
                ),
            ],
            isFresh: true,
            refreshedAt: "2026-04-14T20:00:00Z"
        )

        let chart = portfolioSinglePricedHistoryDisplay(
            history: history,
            size: CGSize(width: 300, height: 200)
        )

        XCTAssertNotNil(chart)
        XCTAssertEqual(chart?.points.count, 3)

        guard let points = chart?.points,
              let selectionPoint = chart?.selectionPoint else {
            return XCTFail("Expected synthetic single-point chart output")
        }

        let baselineY = 180.0
        XCTAssertEqual(points[0].x, 14, accuracy: 0.001)
        XCTAssertEqual(points[0].y, baselineY, accuracy: 0.001)
        XCTAssertGreaterThan(points[1].x, points[0].x)
        XCTAssertEqual(points[1].y, baselineY, accuracy: 0.001)
        XCTAssertGreaterThan(points[2].x, points[1].x)
        XCTAssertLessThan(points[2].y, baselineY)
        XCTAssertEqual(selectionPoint.x, points[2].x, accuracy: 0.001)
        XCTAssertEqual(selectionPoint.y, points[2].y, accuracy: 0.001)
    }

    func testPortfolioSinglePricedHistoryDisplayUsesOriginalTimelineIndexForTrailingPoint() {
        let history = PortfolioHistory(
            range: .days30,
            summary: PortfolioHistorySummary(
                currentValue: 44.38,
                startValue: 0.0,
                deltaValue: 44.38,
                deltaPercent: nil,
                currentCostBasisValue: 0.0,
                startCostBasisValue: 0.0,
                deltaCostBasisValue: 0.0
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 1,
                excludedCardCount: 3
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(date: "2026-04-10", totalValue: 0.0, marketValue: 0.0, costBasisValue: 0.0, pricedCardCount: 0, excludedCardCount: 1),
                PortfolioHistoryPoint(date: "2026-04-11", totalValue: 0.0, marketValue: 0.0, costBasisValue: 0.0, pricedCardCount: 0, excludedCardCount: 1),
                PortfolioHistoryPoint(date: "2026-04-12", totalValue: 0.0, marketValue: 0.0, costBasisValue: 0.0, pricedCardCount: 0, excludedCardCount: 1),
                PortfolioHistoryPoint(date: "2026-04-13", totalValue: 44.38, marketValue: 44.38, costBasisValue: 0.0, pricedCardCount: 1, excludedCardCount: 0),
            ],
            isFresh: true,
            refreshedAt: "2026-04-14T20:00:00Z"
        )

        let chart = portfolioSinglePricedHistoryDisplay(
            history: history,
            size: CGSize(width: 300, height: 200)
        )

        guard let points = chart?.points else {
            return XCTFail("Expected synthetic single-point chart output")
        }

        XCTAssertEqual(points.count, 3)
        XCTAssertGreaterThan(points[2].x, 250)
    }

    func testPortfolioSinglePricedHistoryDisplayDoesNotInventLeadInForFirstPricedDay() {
        let history = PortfolioHistory(
            range: .days30,
            summary: PortfolioHistorySummary(
                currentValue: 44.38,
                startValue: 44.38,
                deltaValue: 0.0,
                deltaPercent: 0.0,
                currentCostBasisValue: 0.0,
                startCostBasisValue: 0.0,
                deltaCostBasisValue: 0.0
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 1,
                excludedCardCount: 0
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-10",
                    totalValue: 44.38,
                    marketValue: 44.38,
                    costBasisValue: 0.0,
                    pricedCardCount: 1,
                    excludedCardCount: 0
                ),
            ],
            isFresh: true,
            refreshedAt: "2026-04-14T20:00:00Z"
        )

        let chart = portfolioSinglePricedHistoryDisplay(
            history: history,
            size: CGSize(width: 300, height: 200)
        )

        XCTAssertEqual(chart?.points.count, 2)
        XCTAssertEqual(Double(chart?.points.first?.x ?? 0), 14, accuracy: 0.001)
        XCTAssertEqual(Double(chart?.selectionPoint.x ?? 0), 286, accuracy: 0.001)
    }

    func testPortfolioLedgerDecodesDailySeriesAndDefaultsMissingSeriesToEmptyArray() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let payloadWithSeries = """
        {
          "range": "30D",
          "currencyCode": "USD",
          "summary": {
            "revenue": 42.5,
            "spend": 17.25,
            "grossProfit": 25.25,
            "inventoryValue": 120.0,
            "inventoryCount": 2
          },
          "transactions": [],
          "dailySeries": [
            {
              "date": "2026-04-13",
              "revenue": 12.5,
              "spend": 7.25,
              "realizedProfit": 5.25,
              "buyCount": 1,
              "sellCount": 0
            }
          ],
          "count": 0,
          "limit": 25,
          "offset": 0,
          "refreshedAt": "2026-04-14T20:00:00Z"
        }
        """

        let withSeries = try decoder.decode(PortfolioLedger.self, from: Data(payloadWithSeries.utf8))
        XCTAssertEqual(withSeries.dailySeries.count, 1)
        XCTAssertEqual(withSeries.dailySeries.first?.date, "2026-04-13")
        XCTAssertEqual(withSeries.dailySeries.first?.realizedProfit, 5.25)
        XCTAssertEqual(withSeries.dailySeries.first?.buyCount, 1)
        XCTAssertEqual(withSeries.dailySeries.first?.sellCount, 0)

        let payloadWithoutSeries = """
        {
          "range": "30D",
          "currencyCode": "USD",
          "summary": {
            "revenue": 0.0,
            "spend": 0.0,
            "grossProfit": 0.0,
            "inventoryValue": 0.0,
            "inventoryCount": 0
          },
          "transactions": [],
          "count": 0,
          "limit": 25,
          "offset": 0,
          "refreshedAt": "2026-04-14T20:00:00Z"
        }
        """

        let withoutSeries = try decoder.decode(PortfolioLedger.self, from: Data(payloadWithoutSeries.utf8))
        XCTAssertTrue(withoutSeries.dailySeries.isEmpty)
    }

    func testPortfolioCumulativeBusinessSeriesSortsAndAccumulatesAscending() {
        let dailySeries = [
            PortfolioLedgerDailyPoint(
                date: "2026-04-15",
                revenue: 7.2,
                spend: 5.1,
                realizedProfit: 2.1,
                buyCount: 1,
                sellCount: 0
            ),
            PortfolioLedgerDailyPoint(
                date: "2026-04-13",
                revenue: 0.0,
                spend: 10.0,
                realizedProfit: 0.0,
                buyCount: 2,
                sellCount: 0
            ),
            PortfolioLedgerDailyPoint(
                date: "2026-04-14",
                revenue: 3.75,
                spend: 1.25,
                realizedProfit: 2.5,
                buyCount: 0,
                sellCount: 1
            )
        ]

        let cumulativeSeries = portfolioCumulativeBusinessSeries(from: dailySeries)
        XCTAssertEqual(cumulativeSeries.map(\.date), ["2026-04-13", "2026-04-14", "2026-04-15"])
        XCTAssertEqual(cumulativeSeries.count, 3)
        XCTAssertEqual(cumulativeSeries[0].cumulativeSpend, 10.0, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[1].cumulativeSpend, 11.25, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[2].cumulativeSpend, 16.35, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[0].cumulativeRevenue, 0.0, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[1].cumulativeRevenue, 3.75, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[2].cumulativeRevenue, 10.95, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[0].cumulativeRealizedProfit, 0.0, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[1].cumulativeRealizedProfit, 2.5, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[2].cumulativeRealizedProfit, 4.6, accuracy: 0.0001)
    }

    func testPortfolioCumulativeBusinessSeriesRoundsCentsAtEachStep() {
        let dailySeries = [
            PortfolioLedgerDailyPoint(
                date: "2026-04-13",
                revenue: 0.1,
                spend: 0.2,
                realizedProfit: 0.3,
                buyCount: 1,
                sellCount: 0
            ),
            PortfolioLedgerDailyPoint(
                date: "2026-04-14",
                revenue: 0.2,
                spend: 0.3,
                realizedProfit: 0.4,
                buyCount: 0,
                sellCount: 1
            )
        ]

        let cumulativeSeries = portfolioCumulativeBusinessSeries(from: dailySeries)

        XCTAssertEqual(cumulativeSeries.count, 2)
        XCTAssertEqual(cumulativeSeries[0].cumulativeRevenue, 0.1, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[0].cumulativeSpend, 0.2, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[0].cumulativeRealizedProfit, 0.3, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[1].cumulativeRevenue, 0.3, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[1].cumulativeSpend, 0.5, accuracy: 0.0001)
        XCTAssertEqual(cumulativeSeries[1].cumulativeRealizedProfit, 0.7, accuracy: 0.0001)
    }

    func testPortfolioHistoryRequestIncludesTimeZoneQueryItem() async throws {
        let service = makePortfolioRequestCapturingService()
        let recorder = RequestCaptureRecorder()
        RequestCaptureURLProtocol.requestHandler = { request in
            recorder.record(request)
            let responseJSON = """
            {
              "range": "30D",
              "summary": {
                "currentValue": 0.0,
                "startValue": 0.0,
                "deltaValue": 0.0,
                "deltaPercent": null,
                "currentCostBasisValue": null,
                "startCostBasisValue": null,
                "deltaCostBasisValue": null
              },
              "coverage": {
                "pricedCardCount": 0,
                "excludedCardCount": 0
              },
              "currencyCode": "USD",
              "points": [],
              "isFresh": true,
              "refreshedAt": "2026-04-14T20:00:00Z"
            }
            """
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data(responseJSON.utf8))
        }

        defer { RequestCaptureURLProtocol.requestHandler = nil }

        let history = await service.fetchPortfolioHistory(range: .days30)
        XCTAssertNotNil(history)
        let request = try XCTUnwrap(recorder.snapshot())
        let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
        let queryItems = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(components.path, "/api/v1/portfolio/history")
        XCTAssertEqual(queryItems["range"], "30D")
        XCTAssertEqual(queryItems["timeZone"], TimeZone.current.identifier)
    }

    func testPortfolioLedgerRequestIncludesTimeZoneQueryItem() async throws {
        let service = makePortfolioRequestCapturingService()
        let recorder = RequestCaptureRecorder()
        RequestCaptureURLProtocol.requestHandler = { request in
            recorder.record(request)
            let responseJSON = """
            {
              "range": "30D",
              "currencyCode": "USD",
              "summary": {
                "revenue": 0.0,
                "spend": 0.0,
                "grossProfit": 0.0,
                "inventoryValue": 0.0,
                "inventoryCount": 0
              },
              "transactions": [],
              "dailySeries": [],
              "count": 0,
              "limit": 25,
              "offset": 0,
              "refreshedAt": "2026-04-14T20:00:00Z"
            }
            """
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data(responseJSON.utf8))
        }

        defer { RequestCaptureURLProtocol.requestHandler = nil }

        let ledger = await service.fetchPortfolioLedger(range: .days30)
        XCTAssertNotNil(ledger)
        let request = try XCTUnwrap(recorder.snapshot())
        let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
        let queryItems = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(components.path, "/api/v1/portfolio/ledger")
        XCTAssertEqual(queryItems["range"], "30D")
        XCTAssertEqual(queryItems["timeZone"], TimeZone.current.identifier)
    }

    func testCollectionStoreRecordSaleUsesBackendEndpointAndRefreshesState() async throws {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        let card = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75)
        await matcher.setDeckEntries([
            makeDeckEntryPayload(
                id: "raw|gym1-60",
                card: card,
                slabContext: nil,
                quantity: 1,
                addedAt: makeDate("2026-04-14T12:00:00Z")
            )
        ])
        await matcher.setPortfolioHistory(
            PortfolioHistory(
                range: .days30,
                summary: PortfolioHistorySummary(
                    currentValue: 0.0,
                    startValue: 12.75,
                    deltaValue: -12.75,
                    deltaPercent: -100.0,
                    currentCostBasisValue: nil,
                    startCostBasisValue: nil,
                    deltaCostBasisValue: nil
                ),
                coverage: PortfolioHistoryCoverage(
                    pricedCardCount: 0,
                    excludedCardCount: 0
                ),
                currencyCode: "USD",
                points: [
                    PortfolioHistoryPoint(
                        date: "2026-04-14",
                        totalValue: 0.0,
                        marketValue: 0.0,
                        costBasisValue: nil,
                        pricedCardCount: 0,
                        excludedCardCount: 0
                    )
                ],
                isFresh: true,
                refreshedAt: "2026-04-14T20:00:00Z"
            )
        )
        await matcher.setSaleResponse(
            PortfolioSaleCreateResponsePayload(
                saleID: "sale:test",
                deckEntryID: "raw|gym1-60",
                remainingQuantity: 0,
                grossTotal: 20.0,
                soldAt: makeDate("2026-04-14T20:00:00Z"),
                showSessionID: "show-1"
            )
        )

        _ = try await store.recordSale(
            card: card,
            slabContext: nil,
            quantity: 1,
            unitPrice: 20.0,
            paymentMethod: "Cash",
            soldAt: makeDate("2026-04-14T20:00:00Z"),
            showSessionID: "show-1",
            note: "Show floor"
        )

        let payloads = await matcher.portfolioSalePayloads()
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads.first?.cardID, card.id)
        XCTAssertEqual(payloads.first?.quantity, 1)
        XCTAssertEqual(payloads.first?.showSessionID, "show-1")
        XCTAssertEqual(store.portfolioHistory?.summary.currentValue, 0.0)
    }

    func testCollectionStoreRecordSaleRemovesEntryAfterBackendSelloutEvenWithOptimisticCondition() async throws {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        let card = makeCardCandidate(id: "base1-4", name: "Charizard ex", marketPrice: 500.0)

        await matcher.setDeckEntries([
            makeDeckEntryPayload(
                id: "raw|base1-4",
                card: card,
                slabContext: nil,
                quantity: 1,
                addedAt: makeDate("2026-04-14T12:00:00Z")
            )
        ])
        await matcher.setPortfolioHistory(
            PortfolioHistory(
                range: .days30,
                summary: PortfolioHistorySummary(
                    currentValue: 0.0,
                    startValue: 500.0,
                    deltaValue: -500.0,
                    deltaPercent: -100.0,
                    currentCostBasisValue: nil,
                    startCostBasisValue: nil,
                    deltaCostBasisValue: nil
                ),
                coverage: PortfolioHistoryCoverage(
                    pricedCardCount: 0,
                    excludedCardCount: 0
                ),
                currencyCode: "USD",
                points: [
                    PortfolioHistoryPoint(
                        date: "2026-04-14",
                        totalValue: 0.0,
                        marketValue: 0.0,
                        costBasisValue: nil,
                        pricedCardCount: 0,
                        excludedCardCount: 0
                    )
                ],
                isFresh: true,
                refreshedAt: "2026-04-14T20:00:00Z"
            )
        )
        await matcher.setSaleResponse(
            PortfolioSaleCreateResponsePayload(
                saleID: "sale:charizard",
                deckEntryID: "raw|base1-4",
                remainingQuantity: 0,
                grossTotal: 520.0,
                soldAt: makeDate("2026-04-14T20:00:00Z"),
                showSessionID: nil
            )
        )

        await store.refreshFromBackend()
        _ = store.setCondition(card: card, slabContext: nil, condition: .nearMint)

        XCTAssertEqual(store.entries.count, 1)

        _ = try await store.recordSale(
            card: card,
            slabContext: nil,
            quantity: 1,
            unitPrice: 520.0,
            paymentMethod: "Cash",
            soldAt: makeDate("2026-04-14T20:00:00Z"),
            showSessionID: nil,
            note: nil
        )

        XCTAssertTrue(store.entries.isEmpty)
        XCTAssertEqual(store.quantity(card: card, slabContext: nil), 0)
    }

    func testCollectionStoreSetPurchasePriceUpdatesOptimistically() async {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        let card = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75)

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

        store.setPurchasePrice(card: card, slabContext: nil, unitPrice: 15, currencyCode: "USD")

        XCTAssertEqual(store.purchasePrice(card: card, slabContext: nil), 15)
        XCTAssertEqual(store.entries.first?.costBasisTotal, 30)
        XCTAssertEqual(store.entries.first?.costBasisPerUnit, 15)
    }

    func testCollectionStoreSyncPurchasePriceUsesBackendEndpoint() async {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        let card = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75)

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

        await store.syncPurchasePrice(card: card, slabContext: nil, unitPrice: 15, currencyCode: "USD")

        let payloads = await matcher.deckPurchasePriceUpdatePayloads()
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads.first?.cardID, card.id)
        XCTAssertEqual(payloads.first?.unitPrice, 15)
        XCTAssertEqual(payloads.first?.currencyCode, "USD")
    }

    func testCollectionStoreRecordBuyUsesBackendEndpoint() async throws {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        let card = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75)

        await matcher.setBuyResponse(
            PortfolioBuyCreateResponsePayload(
                deckEntryID: "raw|gym1-60",
                cardID: card.id,
                inserted: true,
                quantityAdded: 2,
                totalSpend: 18,
                boughtAt: makeDate("2026-04-14T20:00:00Z")
            )
        )

        _ = try await store.recordBuy(
            card: card,
            slabContext: nil,
            condition: .nearMint,
            quantity: 2,
            unitPrice: 9,
            paymentMethod: "Cash",
            boughtAt: makeDate("2026-04-14T20:00:00Z")
        )

        let payloads = await matcher.portfolioBuyPayloads()
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads.first?.cardID, card.id)
        XCTAssertEqual(payloads.first?.quantity, 2)
        XCTAssertEqual(payloads.first?.unitPrice, 9)
        XCTAssertEqual(payloads.first?.condition, .nearMint)
    }

    func testCollectionStoreRecordSalesBatchUsesBackendEndpointForEachLine() async throws {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)
        let first = makeCardCandidate(id: "base1-4", name: "Charizard", marketPrice: 250)
        let second = makeCardCandidate(id: "base1-2", name: "Blastoise", marketPrice: 90)

        _ = try await store.recordSalesBatch([
            PortfolioSaleBatchLineRequest(
                card: first,
                slabContext: nil,
                quantity: 1,
                unitPrice: 240,
                currencyCode: "USD",
                paymentMethod: "Cash",
                soldAt: makeDate("2026-04-14T20:00:00Z"),
                showSessionID: "show-1",
                note: "Bundle",
                sourceScanID: nil
            ),
            PortfolioSaleBatchLineRequest(
                card: second,
                slabContext: nil,
                quantity: 2,
                unitPrice: 85,
                currencyCode: "USD",
                paymentMethod: "Cash",
                soldAt: makeDate("2026-04-14T20:05:00Z"),
                showSessionID: "show-1",
                note: "Bundle",
                sourceScanID: nil
            )
        ])

        let payloads = await matcher.portfolioSalePayloads()
        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(payloads.map(\.cardID), [first.id, second.id])
        XCTAssertEqual(payloads.map(\.quantity), [1, 2])
        XCTAssertEqual(payloads.map(\.showSessionID), ["show-1", "show-1"])
    }

    func testCollectionStoreUpdatePortfolioBuyTransactionPriceUsesBackendEndpoint() async throws {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)

        try await store.updatePortfolioBuyTransactionPrice(
            transactionID: "buy-transaction-1",
            unitPrice: 18.25
        )

        let payloads = await matcher.portfolioBuyPriceUpdatePayloads()
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads.first?.transactionID, "buy-transaction-1")
        XCTAssertEqual(payloads.first?.payload.unitPrice, 18.25)
        XCTAssertEqual(payloads.first?.payload.currencyCode, "USD")
    }

    func testCollectionStoreUpdatePortfolioSaleTransactionPriceUsesBackendEndpoint() async throws {
        let matcher = RecordingCardMatchingService()
        let store = makeCollectionStore(matcher: matcher)

        try await store.updatePortfolioSaleTransactionPrice(
            transactionID: "sale-transaction-1",
            unitPrice: 44.38
        )

        let payloads = await matcher.portfolioSalePriceUpdatePayloads()
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads.first?.transactionID, "sale-transaction-1")
        XCTAssertEqual(payloads.first?.payload.unitPrice, 44.38)
        XCTAssertEqual(payloads.first?.payload.currencyCode, "USD")
    }

    func testVisibleTransactionNoteHidesPurchasePriceMetadataAndTrimsUserNotes() {
        let baseTransaction = PortfolioLedgerTransaction(
            id: "tx-1",
            kind: .buy,
            card: makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro"),
            slabContext: nil,
            condition: .nearMint,
            quantity: 1,
            unitPrice: 12.5,
            totalPrice: 12.5,
            currencyCode: "USD",
            paymentMethod: "Cash",
            costBasisTotal: 12.5,
            grossProfit: nil,
            occurredAt: makeDate("2026-04-14T20:00:00Z"),
            note: "  Updated purchase price from scan  "
        )

        XCTAssertNil(visibleTransactionNote(baseTransaction))

        let userNoteTransaction = PortfolioLedgerTransaction(
            id: "tx-2",
            kind: .sell,
            card: baseTransaction.card,
            slabContext: nil,
            condition: .nearMint,
            quantity: 1,
            unitPrice: 18.0,
            totalPrice: 18.0,
            currencyCode: "USD",
            paymentMethod: "Cash",
            costBasisTotal: 12.5,
            grossProfit: 5.5,
            occurredAt: makeDate("2026-04-14T21:00:00Z"),
            note: "  Sold at booth A12  "
        )

        XCTAssertEqual(visibleTransactionNote(userNoteTransaction), "Sold at booth A12")
    }

    func testResolvedOverviewSelectionIndexFallsBackToLatestVisiblePoint() {
        let points = [
            DashboardOverviewPoint(
                id: "2026-04-13",
                date: makeDate("2026-04-13T00:00:00Z"),
                marketValue: nil,
                costBasisValue: nil,
                cumulativeRevenue: nil
            ),
            DashboardOverviewPoint(
                id: "2026-04-14",
                date: makeDate("2026-04-14T00:00:00Z"),
                marketValue: 120,
                costBasisValue: 80,
                cumulativeRevenue: nil
            ),
            DashboardOverviewPoint(
                id: "2026-04-15",
                date: makeDate("2026-04-15T00:00:00Z"),
                marketValue: nil,
                costBasisValue: nil,
                cumulativeRevenue: nil
            )
        ]

        XCTAssertEqual(latestDisplayableOverviewPointIndex(in: points), 1)
        XCTAssertEqual(resolvedOverviewSelectionIndex(selectedIndex: nil, points: points), 1)
        XCTAssertEqual(resolvedOverviewSelectionIndex(selectedIndex: 2, points: points), 1)
        XCTAssertEqual(resolvedOverviewSelectionIndex(selectedIndex: 1, points: points), 1)
    }

    func testResolvedOverviewSelectionIndexKeepsExplicitVisiblePoint() {
        let points = [
            DashboardOverviewPoint(
                id: "2026-04-13",
                date: makeDate("2026-04-13T00:00:00Z"),
                marketValue: 65,
                costBasisValue: nil,
                cumulativeRevenue: nil
            ),
            DashboardOverviewPoint(
                id: "2026-04-14",
                date: makeDate("2026-04-14T00:00:00Z"),
                marketValue: 120,
                costBasisValue: 80,
                cumulativeRevenue: nil
            )
        ]

        XCTAssertEqual(resolvedOverviewSelectionIndex(selectedIndex: 0, points: points), 0)
    }

    func testPortfolioHistoryLineSeriesReturnsSingleMarketSeriesForUsableHistory() {
        let history = PortfolioHistory(
            range: .days30,
            summary: PortfolioHistorySummary(
                currentValue: 117.98,
                startValue: 72.0,
                deltaValue: 45.98,
                deltaPercent: 63.86,
                currentCostBasisValue: 55.0,
                startCostBasisValue: 55.0,
                deltaCostBasisValue: 0.0
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 2,
                excludedCardCount: 0
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-12",
                    totalValue: 72.0,
                    marketValue: 72.0,
                    costBasisValue: 55.0,
                    pricedCardCount: 2,
                    excludedCardCount: 0
                ),
                PortfolioHistoryPoint(
                    date: "2026-04-16",
                    totalValue: 117.98,
                    marketValue: 117.98,
                    costBasisValue: 55.0,
                    pricedCardCount: 2,
                    excludedCardCount: 0
                )
            ],
            isFresh: true,
            refreshedAt: "2026-04-16T18:00:00Z"
        )

        let series = portfolioHistoryLineSeries(for: history)
        XCTAssertEqual(series.count, 1)
        XCTAssertEqual(series.first?.kind, .market)
        XCTAssertEqual(series.first?.label, "Market value")
        XCTAssertEqual(series.first?.values.count, 2)
        XCTAssertEqual(series.first?.values.compactMap { $0 }, [72.0, 117.98])
    }

    func testPortfolioHistoryLineSeriesReturnsEmptyWhenHistoryIsUnpriced() {
        let history = PortfolioHistory(
            range: .days7,
            summary: PortfolioHistorySummary(
                currentValue: 0.0,
                startValue: 0.0,
                deltaValue: 0.0,
                deltaPercent: nil,
                currentCostBasisValue: nil,
                startCostBasisValue: nil,
                deltaCostBasisValue: nil
            ),
            coverage: PortfolioHistoryCoverage(
                pricedCardCount: 0,
                excludedCardCount: 3
            ),
            currencyCode: "USD",
            points: [
                PortfolioHistoryPoint(
                    date: "2026-04-16",
                    totalValue: 0.0,
                    marketValue: 0.0,
                    costBasisValue: nil,
                    pricedCardCount: 0,
                    excludedCardCount: 3
                )
            ],
            isFresh: true,
            refreshedAt: "2026-04-16T18:00:00Z"
        )

        XCTAssertTrue(portfolioHistoryLineSeries(for: history).isEmpty)
    }

    func testSortedDeckEntriesSupportsRecentValueAndAlphabetical() {
        let charizard = DeckCardEntry(
            id: "raw|base1-4",
            card: makeCardCandidate(id: "base1-4", name: "Charizard", marketPrice: 250),
            slabContext: nil,
            condition: nil,
            quantity: 1,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
            addedAt: makeDate("2026-04-12T12:00:00Z")
        )
        let blastoise = DeckCardEntry(
            id: "raw|base1-2",
            card: makeCardCandidate(id: "base1-2", name: "Blastoise", marketPrice: 90),
            slabContext: nil,
            condition: nil,
            quantity: 2,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )
        let alakazam = DeckCardEntry(
            id: "raw|base1-1",
            card: makeCardCandidate(id: "base1-1", name: "Alakazam", marketPrice: 120),
            slabContext: nil,
            condition: nil,
            quantity: 1,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
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

    func testGradedCardCompsDecodesGradeTabsAndTransactions() throws {
        let json = """
        {
          "card_id": "gym1-60",
          "grader": "PSA",
          "selected_grade": "10",
          "grade_tabs": [
            { "grade": "10", "label": "PSA 10", "count": 3, "selected": true },
            { "grade": "9", "label": "PSA 9", "count": 7 }
          ],
          "recent_transactions": [
            {
              "transaction_id": "tx-1",
              "listing_title": "Sabrina's Slowbro PSA 10",
              "sale_price": 125.5,
              "currency_code": "USD",
              "sold_at": "2026-04-14T12:00:00Z",
              "grade": "10",
              "sale_type": "Auction"
            }
          ],
          "currency_code": "USD",
          "is_fresh": true
        }
        """

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let comps = try decoder.decode(GradedCardComps.self, from: Data(json.utf8))

        XCTAssertEqual(comps.cardID, "gym1-60")
        XCTAssertEqual(comps.grader, "PSA")
        XCTAssertEqual(comps.selectedGrade, "10")
        XCTAssertEqual(comps.gradeOptions.count, 2)
        XCTAssertEqual(comps.gradeOptions.first?.displayLabel, "PSA 10")
        XCTAssertEqual(comps.gradeOptions.first?.count, 3)
        XCTAssertTrue(comps.gradeOptions.first?.isSelected ?? false)
        XCTAssertEqual(comps.transactions.count, 1)
        XCTAssertEqual(comps.transactions.first?.title, "Sabrina's Slowbro PSA 10")
        XCTAssertEqual(comps.transactions.first?.saleType, "Auction")
        XCTAssertEqual(comps.transactions.first?.price, 125.5)
        XCTAssertEqual(comps.transactions.first?.grade, "10")
    }

    func testGradedCardCompsDecodesBackendEbayPayloadShape() throws {
        let json = """
        {
          "cardID": "gym1-60",
          "grader": "PSA",
          "selectedGrade": "9",
          "availableGradeOptions": [
            { "id": "10", "label": "10", "selected": false },
            { "id": "9", "label": "9", "selected": true, "count": 2 },
            { "id": "8.5", "label": "8.5", "selected": false }
          ],
          "transactions": [
            {
              "id": "ebay:1234567890",
              "title": "Sabrina's Slowbro PSA 9 Gym Heroes 60/132",
              "saleType": "auction",
              "soldAt": "2026-04-12",
              "price": {
                "amount": 123.45,
                "currencyCode": "USD",
                "display": "$123.45"
              },
              "grader": "PSA",
              "grade": "9",
              "link": "https://www.ebay.com/itm/1234567890"
            }
          ],
          "statusReason": "no_results",
          "searchURL": "https://www.ebay.com/sch/i.html?_nkw=Sabrina%27s+Slowbro+PSA+9"
        }
        """

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let comps = try decoder.decode(GradedCardComps.self, from: Data(json.utf8))

        XCTAssertEqual(comps.cardID, "gym1-60")
        XCTAssertEqual(comps.selectedGrade, "9")
        XCTAssertEqual(comps.gradeOptions.map(\.id), ["10", "9", "8.5"])
        XCTAssertEqual(comps.gradeOptions[1].count, 2)
        XCTAssertTrue(comps.gradeOptions[1].isSelected ?? false)
        XCTAssertEqual(comps.transactions.count, 1)
        XCTAssertEqual(comps.transactions.first?.price, 123.45)
        XCTAssertEqual(comps.transactions.first?.currencyCode, "USD")
        XCTAssertEqual(comps.transactions.first?.listingURL, "https://www.ebay.com/itm/1234567890")
        XCTAssertEqual(comps.statusReason, "no_results")
        XCTAssertEqual(comps.unavailableReason, "no_results")
        XCTAssertEqual(comps.searchURL, "https://www.ebay.com/sch/i.html?_nkw=Sabrina%27s+Slowbro+PSA+9")
    }

    func testGradedCardCompsDecodesBackendEbayBotBlockedPayloadShape() throws {
        let json = """
        {
          "cardID": "gym1-60",
          "grader": "PSA",
          "selectedGrade": "9",
          "availableGradeOptions": [
            { "id": "10", "label": "10", "selected": false },
            { "id": "9", "label": "9", "selected": true }
          ],
          "transactions": [],
          "statusReason": "bot_blocked",
          "error": {
            "type": "bot_blocked",
            "message": "eBay returned a bot-check page"
          },
          "searchURL": "https://www.ebay.com/sch/i.html?_nkw=Sabrina%27s+Slowbro+PSA+9"
        }
        """

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let comps = try decoder.decode(GradedCardComps.self, from: Data(json.utf8))

        XCTAssertEqual(comps.statusReason, "bot_blocked")
        XCTAssertEqual(comps.errorMessage, "eBay returned a bot-check page")
        XCTAssertEqual(comps.unavailableReason, "eBay returned a bot-check page")
        XCTAssertEqual(comps.searchURL, "https://www.ebay.com/sch/i.html?_nkw=Sabrina%27s+Slowbro+PSA+9")
    }

    func testRemoteScanMatchingServiceBuildsGradedCardCompsRequestURL() throws {
        let slabContext = SlabContext(grader: "PSA", grade: "10", certNumber: "147387041", variantName: nil)
        let service = RemoteScanMatchingService(baseURL: URL(string: "https://example.com")!)

        let url = try XCTUnwrap(
            service.gradedCompsEndpointURL(
                path: "api/v1/cards/gym1-60/graded-comps",
                slabContext: slabContext,
                selectedGrade: "9"
            )
        )
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let queryItems = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })

        XCTAssertEqual(components.host, "example.com")
        XCTAssertEqual(components.path, "/api/v1/cards/gym1-60/graded-comps")
        XCTAssertEqual(queryItems["grader"], "PSA")
        XCTAssertEqual(queryItems["grade"], "9")
        XCTAssertEqual(queryItems["cert"], "147387041")
    }
}

private final class RequestCaptureURLProtocol: URLProtocol {
    nonisolated(unsafe) static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let requestHandler = Self.requestHandler else {
            fatalError("Missing request handler")
        }

        do {
            let (response, data) = try requestHandler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class RequestCaptureRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var capturedRequest: URLRequest?

    func record(_ request: URLRequest) {
        lock.lock()
        capturedRequest = request
        lock.unlock()
    }

    func snapshot() -> URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return capturedRequest
    }
}

private func makePortfolioRequestCapturingService() -> RemoteScanMatchingService {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RequestCaptureURLProtocol.self]
    let session = URLSession(configuration: configuration)
    return RemoteScanMatchingService(baseURL: URL(string: "https://example.com")!, session: session)
}
