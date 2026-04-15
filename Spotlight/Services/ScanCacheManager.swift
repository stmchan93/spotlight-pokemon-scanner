import Foundation

// MARK: - Scan Cache Models

/// Cached scan result for offline access
///
/// Stores pricing data locally for 7 days to enable offline fallback
/// when backend is unreachable or at conventions with spotty WiFi.
struct CachedScan: Codable {
    let cardId: String
    let cardName: String
    let setName: String
    let cardNumber: String
    let imageURL: String

    // Pricing
    let price: Double?
    let priceLabel: String?  // "MARKET", "LOW", etc.
    let currencyCode: String?
    let provider: String?

    // Cache metadata
    let cachedAt: Date
    let expiresAt: Date

    var isExpired: Bool {
        Date() > expiresAt
    }

    var ageHours: Int {
        Int(Date().timeIntervalSince(cachedAt) / 3600)
    }

    var ageDays: Int {
        Int(Date().timeIntervalSince(cachedAt) / 86400)
    }
}

// MARK: - Scan Cache Manager

/// Manages local caching of scan results for offline fallback
///
/// Features:
/// - 7-day cache TTL (time-to-live)
/// - Max 1000 items (oldest removed first)
/// - Automatic cleanup of expired entries
/// - Thread-safe UserDefaults storage
class ScanCacheManager {
    private let userDefaults = UserDefaults.standard
    private let cacheKey = "com.looty.scanCache"
    private let legacyCacheKey = "com.spotlight.scanCache"
    private let maxCacheSize = 1000
    private let cacheTTLDays = 7

    func save(cardId: String, name: String, set: String, number: String, imageURL: String, pricing: CardPricingSummary?) {
        var cache = loadCache()

        let cached = CachedScan(
            cardId: cardId,
            cardName: name,
            setName: set,
            cardNumber: number,
            imageURL: imageURL,
            price: pricing?.market,
            priceLabel: pricing?.primaryLabel,
            currencyCode: pricing?.currencyCode,
            provider: pricing?.source,
            cachedAt: Date(),
            expiresAt: Date().addingTimeInterval(TimeInterval(cacheTTLDays * 86400))
        )

        cache[cardId] = cached

        // Enforce size limit
        if cache.count > maxCacheSize {
            removeOldestEntries(&cache)
        }

        saveCache(cache)
    }

    func get(cardId: String) -> CachedScan? {
        let cache = loadCache()
        guard let cached = cache[cardId] else { return nil }

        if cached.isExpired {
            remove(cardId: cardId)
            return nil
        }

        return cached
    }

    func cleanup() {
        var cache = loadCache()
        let before = cache.count
        cache = cache.filter { !$0.value.isExpired }
        let removed = before - cache.count

        if removed > 0 {
            print("🗑️ Removed \(removed) expired cache entries")
            saveCache(cache)
        }
    }

    private func loadCache() -> [String: CachedScan] {
        if let data = userDefaults.data(forKey: cacheKey),
           let cache = try? JSONDecoder().decode([String: CachedScan].self, from: data) {
            return cache
        }

        guard let legacyData = userDefaults.data(forKey: legacyCacheKey),
              let legacyCache = try? JSONDecoder().decode([String: CachedScan].self, from: legacyData) else {
            return [:]
        }

        if let migratedData = try? JSONEncoder().encode(legacyCache) {
            userDefaults.set(migratedData, forKey: cacheKey)
            userDefaults.removeObject(forKey: legacyCacheKey)
        }
        return legacyCache
    }

    private func saveCache(_ cache: [String: CachedScan]) {
        if let data = try? JSONEncoder().encode(cache) {
            userDefaults.set(data, forKey: cacheKey)
        }
    }

    private func removeOldestEntries(_ cache: inout [String: CachedScan]) {
        let sorted = cache.values.sorted { $0.cachedAt < $1.cachedAt }
        let toRemove = sorted.prefix(100)
        for scan in toRemove {
            cache.removeValue(forKey: scan.cardId)
        }
    }

    func remove(cardId: String) {
        var cache = loadCache()
        cache.removeValue(forKey: cardId)
        saveCache(cache)
    }

    func clearAll() {
        userDefaults.removeObject(forKey: cacheKey)
    }
}
