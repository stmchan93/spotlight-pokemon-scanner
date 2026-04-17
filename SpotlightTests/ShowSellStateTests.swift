import XCTest
@testable import Spotlight

@MainActor
final class ShowSellStateTests: XCTestCase {
    func testShowsMockStatePresentSellOpensDraftWithoutActiveShow() {
        let state = ShowsMockState()
        let entry = DeckCardEntry(
            id: "raw|base5-14",
            card: makeCardCandidate(id: "base5-14", name: "Dark Weezing", marketPrice: 68),
            slabContext: nil,
            condition: .nearMint,
            quantity: 3,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )

        state.endShow()
        state.presentSell(entry: entry, title: "Sell Card")

        guard case .sell(let draft)? = state.presentedFlow else {
            return XCTFail("Expected sell draft")
        }

        XCTAssertEqual(draft.title, "Sell Card")
        XCTAssertEqual(draft.entry.id, entry.id)
        XCTAssertEqual(draft.quantityLimit, entry.quantity)
        XCTAssertEqual(draft.suggestedPrice, 68)
    }

    func testShowsMockStateSellDraftUsesEntryPriceAndExplicitQuantityLimit() {
        let state = ShowsMockState()
        let entry = DeckCardEntry(
            id: "raw|gym1-60",
            card: makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75),
            slabContext: nil,
            condition: .nearMint,
            quantity: 4,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )

        state.presentSell(entry: entry, title: "Sell Card", quantityLimit: 1)

        guard case .sell(let draft)? = state.presentedFlow else {
            return XCTFail("Expected sell draft")
        }

        XCTAssertEqual(draft.title, "Sell Card")
        XCTAssertEqual(draft.suggestedPrice, 12.75)
        XCTAssertEqual(draft.quantityLimit, 1)
        XCTAssertEqual(draft.entry.quantity, 4)
    }

    func testShowsMockStatePresentSellBatchOpensBatchDraft() {
        let state = ShowsMockState()
        let entry = DeckCardEntry(
            id: "raw|sv2-185",
            card: makeCardCandidate(id: "sv2-185", name: "Lt. Surge's Bargain", marketPrice: 18.6),
            slabContext: nil,
            condition: .nearMint,
            quantity: 2,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )
        let lines = [
            ShowSellBatchLineDraft(
                id: entry.id,
                entry: entry,
                sourceItemIDs: [UUID()],
                scannedCount: 1,
                quantityLimit: 1,
                suggestedUnitPrice: 18.6
            )
        ]

        state.presentSellBatch(
            lines: lines,
            title: "Sell Scanned Cards",
            subtitle: "Only scanned cards you currently own are included."
        )

        guard case .sellBatch(let draft)? = state.presentedFlow else {
            return XCTFail("Expected sell batch draft")
        }

        XCTAssertEqual(draft.title, "Sell Scanned Cards")
        XCTAssertEqual(draft.lines.count, 1)
        XCTAssertEqual(draft.lines.first?.entry.id, entry.id)
        XCTAssertEqual(draft.lines.first?.quantityLimit, 1)
    }

    func testShowsMockStatePresentSellBatchIgnoresEmptyLines() {
        let state = ShowsMockState()

        state.presentSellBatch(lines: [], title: "Sell order")

        XCTAssertNil(state.presentedFlow)
    }

    func testShowsMockStatePresentBuyPrefersCostBasisPerUnitOverMarketPrice() {
        let state = ShowsMockState()
        let entry = DeckCardEntry(
            id: "raw|gym1-60",
            card: makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75),
            slabContext: nil,
            condition: .nearMint,
            quantity: 2,
            costBasisTotal: 18,
            costBasisCurrencyCode: "USD",
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )

        state.presentBuy(entry: entry, title: "Add to collection")

        guard case .buy(let draft)? = state.presentedFlow else {
            return XCTFail("Expected buy draft")
        }

        XCTAssertEqual(draft.title, "Add to collection")
        XCTAssertEqual(draft.suggestedPrice, 9)
        XCTAssertEqual(draft.quantityDefault, 1)
    }

    func testShowsMockStatePresentBuyClampsQuantityDefaultToAtLeastOne() {
        let state = ShowsMockState()
        let entry = DeckCardEntry(
            id: "raw|gym1-60",
            card: makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75),
            slabContext: nil,
            condition: .nearMint,
            quantity: 2,
            costBasisTotal: 0,
            costBasisCurrencyCode: "USD",
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )

        state.presentBuy(entry: entry, title: "Add to collection", quantityDefault: 0)

        guard case .buy(let draft)? = state.presentedFlow else {
            return XCTFail("Expected buy draft")
        }

        XCTAssertEqual(draft.quantityDefault, 1)
    }

    func testShowsMockStatePresentTradeRequiresActiveShow() {
        let state = ShowsMockState()
        let entry = DeckCardEntry(
            id: "raw|base5-14",
            card: makeCardCandidate(id: "base5-14", name: "Dark Weezing", marketPrice: 68),
            slabContext: nil,
            condition: .nearMint,
            quantity: 1,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )

        state.endShow()
        state.presentTrade(previewEntry: entry)

        XCTAssertNil(state.presentedFlow)
    }

    func testShowsMockStatePresentTradeUsesActiveShow() {
        let state = ShowsMockState()
        let entry = DeckCardEntry(
            id: "raw|base5-14",
            card: makeCardCandidate(id: "base5-14", name: "Dark Weezing", marketPrice: 68),
            slabContext: nil,
            condition: .nearMint,
            quantity: 1,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )

        state.startSampleShow()
        let activeTitle = state.activeShow?.title

        state.presentTrade(previewEntry: entry)

        guard case .trade(let draft)? = state.presentedFlow else {
            return XCTFail("Expected trade draft")
        }

        XCTAssertEqual(draft.previewEntry.id, entry.id)
        XCTAssertEqual(draft.show.title, activeTitle)
    }

    func testSellOrderReviewUIStateSwitchesBetweenEditAndReviewModes() {
        XCTAssertEqual(
            sellOrderReviewUIState(isReviewingSale: false, isSubmitting: false),
            .edit(buttonTitle: "Review sale")
        )
        XCTAssertEqual(
            sellOrderReviewUIState(isReviewingSale: true, isSubmitting: false),
            .review(trayTitle: "Swipe up to sell")
        )
        XCTAssertEqual(
            sellOrderReviewUIState(isReviewingSale: true, isSubmitting: true),
            .review(trayTitle: "SELLING…")
        )
    }

    func testClampedDiscountInputTextCapsPercentAtOneHundred() {
        XCTAssertEqual(
            clampedDiscountInputText("125", maximum: 100, maximumFractionDigits: 2),
            "100"
        )
    }

    func testClampedDiscountInputTextCapsDollarOffAtListPrice() {
        XCTAssertEqual(
            clampedDiscountInputText("25", maximum: 18.95, maximumFractionDigits: 2),
            "18.95"
        )
    }

    func testClampedDiscountInputTextPreservesValidDiscountInput() {
        XCTAssertEqual(
            clampedDiscountInputText("12.5", maximum: 100, maximumFractionDigits: 2),
            "12.5"
        )
    }
}
