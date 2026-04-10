import Foundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

func makePricing(
    currencyCode: String = "USD",
    market: Double? = 10,
    low: Double? = 8,
    mid: Double? = 12,
    high: Double? = 14,
    refreshedAt: String? = ISO8601DateFormatter().string(from: Date()),
    snapshotAgeHours: Double? = nil,
    isFresh: Bool? = nil
) -> CardPricingSummary {
    CardPricingSummary(
        source: "tcgplayer",
        currencyCode: currencyCode,
        variant: "raw",
        low: low,
        market: market,
        mid: mid,
        high: high,
        directLow: nil,
        trend: market,
        updatedAt: "2026/04/03",
        refreshedAt: refreshedAt,
        sourceURL: nil,
        pricingMode: nil,
        snapshotAgeHours: snapshotAgeHours,
        freshnessWindowHours: 24,
        isFresh: isFresh,
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

func testTrayTotalsIncludePricedNeedsReviewRows() {
    let metrics = ScanTrayCalculator.metrics(for: [
        ScanTrayMetricInput(phase: .resolved, pricing: makePricing(market: 11)),
        ScanTrayMetricInput(phase: .pending, pricing: makePricing(market: 999)),
        ScanTrayMetricInput(phase: .needsReview, pricing: makePricing(market: 7)),
        ScanTrayMetricInput(phase: .needsReview, pricing: nil),
        ScanTrayMetricInput(phase: .resolved, pricing: makePricing(market: 5)),
    ])

    require(metrics.resolvedCount == 3, "priced card count should include review rows with pricing")
    require(metrics.pendingCount == 2, "pending count should exclude priced review rows")
    require(abs(metrics.totalValue - 23) < 0.001, "total value should sum priced resolved and review rows")
    require(metrics.countLabel == "3 cards", "count label should reflect priced cards included in total")
}

func testMixedCurrenciesFlag() {
    let metrics = ScanTrayCalculator.metrics(for: [
        ScanTrayMetricInput(phase: .resolved, pricing: makePricing(currencyCode: "USD", market: 11)),
        ScanTrayMetricInput(phase: .resolved, pricing: makePricing(currencyCode: "EUR", market: 9)),
    ])

    require(metrics.hasMixedCurrencies, "mixed currencies should be detected")
    require(metrics.currencyCode != nil, "a display currency should still be chosen for the running total")
}

func testAutoRefreshHeuristic() {
    let staleDate = ISO8601DateFormatter().string(from: Date(timeIntervalSinceNow: -(60 * 60 * 30)))
    let freshDate = ISO8601DateFormatter().string(from: Date(timeIntervalSinceNow: -(60 * 5)))

    require(ScanTrayCalculator.shouldAutoRefresh(pricing: nil), "missing pricing should auto refresh")
    require(
        ScanTrayCalculator.shouldAutoRefresh(
            pricing: makePricing(refreshedAt: staleDate, snapshotAgeHours: 30, isFresh: false)
        ),
        "stale pricing should auto refresh"
    )
    require(
        !ScanTrayCalculator.shouldAutoRefresh(
            pricing: makePricing(refreshedAt: freshDate, snapshotAgeHours: 0.1, isFresh: true)
        ),
        "fresh pricing should not auto refresh"
    )
}

func testInitialStatusMessage() {
    require(
        ScanTrayCalculator.initialStatusMessage(for: nil) == "Cached price unavailable",
        "missing pricing should use the cached unavailable message"
    )

    let pricing = makePricing()
    require(
        ScanTrayCalculator.initialStatusMessage(for: pricing).contains("Refreshed"),
        "existing pricing should reuse freshness text"
    )
}

func testFreshnessStateClassification() {
    let staleDate = ISO8601DateFormatter().string(from: Date(timeIntervalSinceNow: -(60 * 60 * 30)))
    let freshDate = ISO8601DateFormatter().string(from: Date(timeIntervalSinceNow: -(60 * 5)))
    let cachedDate = ISO8601DateFormatter().string(from: Date(timeIntervalSinceNow: -(60 * 60 * 4)))

    require(
        makePricing(market: nil, low: nil, mid: nil, high: nil).freshnessState == .unavailable,
        "missing price should be unavailable"
    )
    require(makePricing(refreshedAt: nil).freshnessState == .cached, "missing refresh timestamp should be cached")
    require(
        makePricing(refreshedAt: freshDate, snapshotAgeHours: 0.05, isFresh: true).freshnessState == .refreshedRecently,
        "fresh snapshot should be recent"
    )
    require(
        makePricing(refreshedAt: cachedDate, snapshotAgeHours: 4, isFresh: true).freshnessState == .cached,
        "fresh but older snapshot should be cached"
    )
    require(
        makePricing(refreshedAt: staleDate, snapshotAgeHours: 30, isFresh: false).freshnessState == .stale,
        "old snapshot should be stale"
    )
}

@main
struct ScanTrayLogicTestRunner {
    static func main() {
        testTrayTotalsIncludePricedNeedsReviewRows()
        testMixedCurrenciesFlag()
        testAutoRefreshHeuristic()
        testInitialStatusMessage()
        testFreshnessStateClassification()
        print("scan_tray_logic_tests: PASS")
    }
}
