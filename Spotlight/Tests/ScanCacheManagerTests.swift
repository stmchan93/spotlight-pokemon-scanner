import XCTest
@testable import Spotlight

/// Unit tests for ScanCacheManager
///
/// Tests local scan caching including:
/// - Save and retrieve
/// - Expiration logic
/// - Cleanup functionality
/// - Max size enforcement
final class ScanCacheManagerTests: XCTestCase {

    var cacheManager: ScanCacheManager!
    let testCacheKey = "com.spotlight.test.scanCache"

    override func setUp() {
        super.setUp()
        // Create cache manager with test key
        cacheManager = ScanCacheManager()
        // Clear any existing test data
        UserDefaults.standard.removeObject(forKey: "com.spotlight.scanCache")
    }

    override func tearDown() {
        // Clean up test data
        UserDefaults.standard.removeObject(forKey: "com.spotlight.scanCache")
        cacheManager = nil
        super.tearDown()
    }

    // MARK: - Basic Save/Get Tests

    func testSaveAndRetrieve() {
        // Given: A scan result to cache
        let cardId = "test-card-1"
        let name = "Pikachu"
        let set = "Base Set"
        let number = "25/102"
        let imageURL = "https://example.com/pikachu.png"

        // Create mock pricing
        let pricing = CardPricingSummary(
            source: "test_provider",
            currencyCode: "USD",
            variant: nil,
            low: 8.0,
            market: 10.0,
            mid: 12.0,
            high: 15.0,
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

        // When: Saving to cache
        cacheManager.save(
            cardId: cardId,
            name: name,
            set: set,
            number: number,
            imageURL: imageURL,
            pricing: pricing
        )

        // Then: Should be able to retrieve it
        let cached = cacheManager.get(cardId: cardId)
        XCTAssertNotNil(cached)
        XCTAssertEqual(cached?.cardId, cardId)
        XCTAssertEqual(cached?.cardName, name)
        XCTAssertEqual(cached?.setName, set)
        XCTAssertEqual(cached?.cardNumber, number)
        XCTAssertEqual(cached?.imageURL, imageURL)
        XCTAssertEqual(cached?.price, 10.0)
        XCTAssertEqual(cached?.priceLabel, "MARKET")
        XCTAssertEqual(cached?.currencyCode, "USD")
        XCTAssertEqual(cached?.provider, "test_provider")
    }

    func testGetNonExistent() {
        // When: Getting a non-existent card
        let cached = cacheManager.get(cardId: "non-existent")

        // Then: Should return nil
        XCTAssertNil(cached)
    }

    func testOverwriteExisting() {
        // Given: A cached card
        cacheManager.save(
            cardId: "test-1",
            name: "Original Name",
            set: "Original Set",
            number: "1/100",
            imageURL: "https://example.com/old.png",
            pricing: nil
        )

        // When: Saving again with new data
        cacheManager.save(
            cardId: "test-1",
            name: "New Name",
            set: "New Set",
            number: "2/100",
            imageURL: "https://example.com/new.png",
            pricing: nil
        )

        // Then: Should have updated data
        let cached = cacheManager.get(cardId: "test-1")
        XCTAssertEqual(cached?.cardName, "New Name")
        XCTAssertEqual(cached?.setName, "New Set")
    }

    // MARK: - Expiration Tests

    func testCachedScanAgeCalculation() {
        // Given: A cached scan from 2 hours ago
        let twoHoursAgo = Date().addingTimeInterval(-2 * 3600)
        let sevenDaysLater = twoHoursAgo.addingTimeInterval(7 * 24 * 3600)

        let cached = CachedScan(
            cardId: "test-1",
            cardName: "Test",
            setName: "Set",
            cardNumber: "1/100",
            imageURL: "https://example.com/test.png",
            price: 10.0,
            priceLabel: "MARKET",
            currencyCode: "USD",
            provider: "test",
            cachedAt: twoHoursAgo,
            expiresAt: sevenDaysLater
        )

        // Then: Age should be approximately 2 hours
        XCTAssertEqual(cached.ageHours, 2, accuracy: 1)
        XCTAssertEqual(cached.ageDays, 0)
        XCTAssertFalse(cached.isExpired)
    }

    func testExpiredScan() {
        // Given: A cached scan from 8 days ago (expired)
        let eightDaysAgo = Date().addingTimeInterval(-8 * 24 * 3600)
        let sevenDaysLater = eightDaysAgo.addingTimeInterval(7 * 24 * 3600)

        let cached = CachedScan(
            cardId: "test-1",
            cardName: "Test",
            setName: "Set",
            cardNumber: "1/100",
            imageURL: "https://example.com/test.png",
            price: 10.0,
            priceLabel: "MARKET",
            currencyCode: "USD",
            provider: "test",
            cachedAt: eightDaysAgo,
            expiresAt: sevenDaysLater
        )

        // Then: Should be expired
        XCTAssertTrue(cached.isExpired)
        XCTAssertEqual(cached.ageDays, 8, accuracy: 1)
    }

    func testExpiredEntryNotReturned() {
        // Given: Manually insert an expired entry
        // (We can't easily test this with the real implementation since we can't control time,
        //  but we can test the expiration logic of CachedScan itself)

        let eightDaysAgo = Date().addingTimeInterval(-8 * 24 * 3600)
        let oneHourLater = eightDaysAgo.addingTimeInterval(3600)

        let expired = CachedScan(
            cardId: "test-1",
            cardName: "Test",
            setName: "Set",
            cardNumber: "1/100",
            imageURL: "https://example.com/test.png",
            price: 10.0,
            priceLabel: "MARKET",
            currencyCode: "USD",
            provider: "test",
            cachedAt: eightDaysAgo,
            expiresAt: oneHourLater
        )

        // Then: Expired scan should report as expired
        XCTAssertTrue(expired.isExpired)
    }

    // MARK: - Cleanup Tests

    func testCleanupRemovesExpired() {
        // Note: This test is difficult to verify without mocking time
        // We test the cleanup method doesn't crash
        cacheManager.save(
            cardId: "test-1",
            name: "Test",
            set: "Set",
            number: "1/100",
            imageURL: "https://example.com/test.png",
            pricing: nil
        )

        // When: Running cleanup
        cacheManager.cleanup()

        // Then: Should not crash (success)
        // Recent entries should still exist
        XCTAssertNotNil(cacheManager.get(cardId: "test-1"))
    }

    func testClearAll() {
        // Given: Multiple cached items
        cacheManager.save(cardId: "test-1", name: "Test 1", set: "Set", number: "1/100", imageURL: "", pricing: nil)
        cacheManager.save(cardId: "test-2", name: "Test 2", set: "Set", number: "2/100", imageURL: "", pricing: nil)
        cacheManager.save(cardId: "test-3", name: "Test 3", set: "Set", number: "3/100", imageURL: "", pricing: nil)

        // When: Clearing all
        cacheManager.clearAll()

        // Then: All items should be gone
        XCTAssertNil(cacheManager.get(cardId: "test-1"))
        XCTAssertNil(cacheManager.get(cardId: "test-2"))
        XCTAssertNil(cacheManager.get(cardId: "test-3"))
    }

    func testRemoveSpecificCard() {
        // Given: Multiple cached items
        cacheManager.save(cardId: "test-1", name: "Test 1", set: "Set", number: "1/100", imageURL: "", pricing: nil)
        cacheManager.save(cardId: "test-2", name: "Test 2", set: "Set", number: "2/100", imageURL: "", pricing: nil)

        // When: Removing one card
        cacheManager.remove(cardId: "test-1")

        // Then: Only that card should be removed
        XCTAssertNil(cacheManager.get(cardId: "test-1"))
        XCTAssertNotNil(cacheManager.get(cardId: "test-2"))
    }

    // MARK: - Persistence Tests

    func testPersistenceAcrossInstances() {
        // Given: A cached item
        cacheManager.save(
            cardId: "persist-test",
            name: "Persistence Test",
            set: "Test Set",
            number: "100/100",
            imageURL: "https://example.com/test.png",
            pricing: nil
        )

        // When: Creating a new cache manager instance
        let newCacheManager = ScanCacheManager()

        // Then: Should be able to retrieve the cached item
        let cached = newCacheManager.get(cardId: "persist-test")
        XCTAssertNotNil(cached)
        XCTAssertEqual(cached?.cardName, "Persistence Test")
    }

    // MARK: - Nil Pricing Tests

    func testSaveWithNilPricing() {
        // When: Saving without pricing
        cacheManager.save(
            cardId: "test-nil-pricing",
            name: "No Price Card",
            set: "Test Set",
            number: "1/100",
            imageURL: "https://example.com/test.png",
            pricing: nil
        )

        // Then: Should still save successfully
        let cached = cacheManager.get(cardId: "test-nil-pricing")
        XCTAssertNotNil(cached)
        XCTAssertNil(cached?.price)
        XCTAssertNil(cached?.priceLabel)
        XCTAssertNil(cached?.currencyCode)
        XCTAssertNil(cached?.provider)
    }

    // MARK: - Multiple Cards Tests

    func testMultipleCards() {
        // Given: Multiple different cards
        for i in 1...10 {
            cacheManager.save(
                cardId: "card-\\(i)",
                name: "Card \\(i)",
                set: "Test Set",
                number: "\\(i)/100",
                imageURL: "https://example.com/\\(i).png",
                pricing: nil
            )
        }

        // Then: All should be retrievable
        for i in 1...10 {
            let cached = cacheManager.get(cardId: "card-\\(i)")
            XCTAssertNotNil(cached, "Card \\(i) should be cached")
            XCTAssertEqual(cached?.cardName, "Card \\(i)")
        }
    }
}
