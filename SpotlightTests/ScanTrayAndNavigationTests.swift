import XCTest
@testable import Spotlight

@MainActor
final class ScanTrayAndNavigationTests: XCTestCase {
    func testTrayDismissSwipeHelpersClampAndThreshold() {
        XCTAssertEqual(clampedTrayDismissOffset(40), 40)
        XCTAssertEqual(clampedTrayDismissOffset(400), 120)
        XCTAssertEqual(clampedTrayDismissOffset(-40), 0)
        XCTAssertEqual(clampedTrayDismissOffset(-400), 0)

        XCTAssertFalse(shouldRevealTrayItemAction(forSwipeOffset: 71))
        XCTAssertTrue(shouldRevealTrayItemAction(forSwipeOffset: 72))
        XCTAssertFalse(shouldRevealTrayItemAction(forSwipeOffset: -40))
        XCTAssertEqual(trayActionRevealWidth(forSwipeOffset: 90), 120)
        XCTAssertEqual(trayActionRevealWidth(forSwipeOffset: -90), 0)
    }

    func testTrayActionBackgroundHelpersHandleRemoveReveal() {
        XCTAssertEqual(leadingTrayActionBackgroundOpacity(forRevealedWidth: 0), 0)
        XCTAssertEqual(leadingTrayActionBackgroundOpacity(forRevealedWidth: 9), 1)
        XCTAssertFalse(leadingTrayActionButtonsAreInteractive(forRevealedWidth: 43))
        XCTAssertTrue(leadingTrayActionButtonsAreInteractive(forRevealedWidth: 44))
    }

    func testCollapsedTrayRowBottomPaddingKeepsCollapsedItemNearBottom() {
        XCTAssertEqual(collapsedTrayRowBottomPadding(trayBottomInset: 16), 12)
        XCTAssertEqual(collapsedTrayRowBottomPadding(trayBottomInset: 34), 12)
        XCTAssertGreaterThan(collapsedTrayRowBottomPadding(trayBottomInset: 48), 12)
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

    func testPresentResultDetailForDeckEntryUsesSharedDetailPreview() {
        let viewModel = makeScannerViewModel()
        let card = makeCardCandidate(id: "gym1-60", name: "Sabrina's Slowbro", marketPrice: 12.75)
        let entry = DeckCardEntry(
            id: "raw|gym1-60",
            card: card,
            slabContext: nil,
            condition: .nearMint,
            quantity: 2,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )

        viewModel.presentResultDetail(for: entry)

        XCTAssertEqual(viewModel.route, .resultDetail)
        XCTAssertEqual(viewModel.activeResultItem?.displayCard?.id, card.id)
        XCTAssertEqual(viewModel.activeResultItem?.displayCard?.name, card.name)
        XCTAssertEqual(viewModel.activeResultItem?.resolverMode, .rawCard)
        XCTAssertNil(viewModel.activeAlternativesResponse)
    }

    func testDismissResultDetailFromDeckEntryReturnsToScannerRoute() {
        let viewModel = makeScannerViewModel()
        let entry = DeckCardEntry(
            id: "raw|base1-4",
            card: makeCardCandidate(id: "base1-4", name: "Charizard"),
            slabContext: nil,
            condition: nil,
            quantity: 1,
            costBasisTotal: 0,
            costBasisCurrencyCode: nil,
            addedAt: makeDate("2026-04-14T12:00:00Z")
        )

        viewModel.presentResultDetail(for: entry)
        viewModel.dismissResultDetail()

        XCTAssertEqual(viewModel.route, .scanner)
        XCTAssertNil(viewModel.activeResultItem)
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
        XCTAssertEqual(state.selectedTab, .portfolio)

        state.openScanner()
        XCTAssertEqual(state.selectedTab, .scan)
    }

    func testAppShellUsesSharedDetailOverlayForPortfolioAndScannerOnly() {
        XCTAssertTrue(appShellUsesSharedDetailOverlay(selectedTab: .portfolio, route: .resultDetail))
        XCTAssertTrue(appShellUsesSharedDetailOverlay(selectedTab: .scan, route: .resultDetail))
        XCTAssertFalse(appShellUsesSharedDetailOverlay(selectedTab: .ledger, route: .resultDetail))
        XCTAssertFalse(appShellUsesSharedDetailOverlay(selectedTab: .portfolio, route: .scanner))
    }

    func testAppShellSupportsPagedSwipeDisablesPortfolioPagingDuringVerticalScroll() {
        XCTAssertTrue(
            appShellSupportsPagedSwipe(
                selectedTab: .scan,
                isPresentingDealFlow: false,
                showingSharedDetail: false,
                portfolioVerticalScrollIsActive: false
            )
        )
        XCTAssertTrue(
            appShellSupportsPagedSwipe(
                selectedTab: .portfolio,
                isPresentingDealFlow: false,
                showingSharedDetail: false,
                portfolioVerticalScrollIsActive: false
            )
        )
        XCTAssertFalse(
            appShellSupportsPagedSwipe(
                selectedTab: .portfolio,
                isPresentingDealFlow: false,
                showingSharedDetail: false,
                portfolioVerticalScrollIsActive: true
            )
        )
        XCTAssertFalse(
            appShellSupportsPagedSwipe(
                selectedTab: .ledger,
                isPresentingDealFlow: false,
                showingSharedDetail: false,
                portfolioVerticalScrollIsActive: false
            )
        )
    }

    func testPortfolioScrollDisablesOnlyDuringActivePortfolioPageSwipe() {
        XCTAssertFalse(
            portfolioScrollShouldBeDisabledDuringHorizontalPageSwipe(
                selectedTab: .scan,
                pagerDragTranslation: 32
            )
        )
        XCTAssertFalse(
            portfolioScrollShouldBeDisabledDuringHorizontalPageSwipe(
                selectedTab: .portfolio,
                pagerDragTranslation: 4
            )
        )
        XCTAssertTrue(
            portfolioScrollShouldBeDisabledDuringHorizontalPageSwipe(
                selectedTab: .portfolio,
                pagerDragTranslation: 18
            )
        )
    }

    func testScannerShellStaysVisibleDuringPagerDragAndSettle() {
        XCTAssertTrue(
            scannerShellShouldStayVisible(
                selectedTab: .scan,
                pagerDragTranslation: 0,
                pagerTransitionIsSettling: false
            )
        )
        XCTAssertTrue(
            scannerShellShouldStayVisible(
                selectedTab: .portfolio,
                pagerDragTranslation: 22,
                pagerTransitionIsSettling: false
            )
        )
        XCTAssertTrue(
            scannerShellShouldStayVisible(
                selectedTab: .portfolio,
                pagerDragTranslation: 0,
                pagerTransitionIsSettling: true
            )
        )
        XCTAssertFalse(
            scannerShellShouldStayVisible(
                selectedTab: .portfolio,
                pagerDragTranslation: 0,
                pagerTransitionIsSettling: false
            )
        )
    }

    func testScannerCameraStaysWarmWhilePortfolioIsOpen() {
        XCTAssertTrue(
            scannerCameraShouldKeepRunning(
                isVisible: false,
                keepsCameraWarmOffscreen: true,
                route: .scanner,
                isPresentingDealFlow: false
            )
        )
        XCTAssertFalse(
            scannerCameraShouldKeepRunning(
                isVisible: false,
                keepsCameraWarmOffscreen: false,
                route: .scanner,
                isPresentingDealFlow: false
            )
        )
        XCTAssertFalse(
            scannerCameraShouldKeepRunning(
                isVisible: false,
                keepsCameraWarmOffscreen: true,
                route: .resultDetail,
                isPresentingDealFlow: false
            )
        )
        XCTAssertFalse(
            scannerCameraShouldKeepRunning(
                isVisible: false,
                keepsCameraWarmOffscreen: true,
                route: .scanner,
                isPresentingDealFlow: true
            )
        )
    }

    func testScannerSwipeShouldOpenPortfolioRequiresRightwardHorizontalTravel() {
        XCTAssertTrue(
            scannerSwipeShouldOpenPortfolio(
                startLocation: CGPoint(x: 200, y: 320),
                translation: CGSize(width: 120, height: 8),
                containerWidth: 390
            )
        )
        XCTAssertFalse(
            scannerSwipeShouldOpenPortfolio(
                startLocation: CGPoint(x: 24, y: 320),
                translation: CGSize(width: 40, height: 4),
                containerWidth: 390
            )
        )
        XCTAssertFalse(
            scannerSwipeShouldOpenPortfolio(
                startLocation: CGPoint(x: 24, y: 320),
                translation: CGSize(width: 50, height: 120),
                containerWidth: 390
            )
        )
    }

    func testPortfolioSwipeShouldOpenScannerRequiresLeftwardHorizontalTravelFromRightEdge() {
        XCTAssertTrue(
            portfolioSwipeShouldOpenScanner(
                startLocation: CGPoint(x: 372, y: 300),
                translation: CGSize(width: -120, height: 8),
                containerWidth: 390
            )
        )
        XCTAssertFalse(
            portfolioSwipeShouldOpenScanner(
                startLocation: CGPoint(x: 372, y: 300),
                translation: CGSize(width: -40, height: 8),
                containerWidth: 390
            )
        )
        XCTAssertFalse(
            portfolioSwipeShouldOpenScanner(
                startLocation: CGPoint(x: 372, y: 300),
                translation: CGSize(width: -40, height: 120),
                containerWidth: 390
            )
        )
        XCTAssertFalse(
            portfolioSwipeShouldOpenScanner(
                startLocation: CGPoint(x: 140, y: 300),
                translation: CGSize(width: -120, height: 8),
                containerWidth: 390
            )
        )
    }

    func testPortfolioDragBlocksHorizontalPagingOnlyWhenVerticalIntentIsClear() {
        XCTAssertTrue(
            portfolioDragShouldBlockHorizontalPageSwipe(
                translation: CGSize(width: 18, height: 72)
            )
        )
        XCTAssertFalse(
            portfolioDragShouldBlockHorizontalPageSwipe(
                translation: CGSize(width: 80, height: 18)
            )
        )
        XCTAssertFalse(
            portfolioDragShouldBlockHorizontalPageSwipe(
                translation: CGSize(width: 4, height: 8)
            )
        )
    }

    func testAppShellPagerStackOffsetPlacesPortfolioToTheLeftOfScanner() {
        XCTAssertEqual(
            appShellPagerStackOffset(
                selectedTab: .scan,
                containerWidth: 390
            ),
            -390
        )
        XCTAssertEqual(
            appShellPagerStackOffset(
                selectedTab: .portfolio,
                containerWidth: 390
            ),
            0
        )
        XCTAssertEqual(
            appShellPagerStackOffset(
                selectedTab: .ledger,
                containerWidth: 390
            ),
            0
        )
    }
}
