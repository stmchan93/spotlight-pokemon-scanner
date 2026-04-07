# Caching Implementation Plan

**Purpose:** Enable offline/low-connectivity usage at conventions while reducing API costs and improving performance.

**Provider-Agnostic:** This caching strategy works with ALL pricing providers (Scrydex, PriceCharting, Pokemon TCG API).

---

## Problem Statement

### Current Issues:
1. ❌ Every scan requires real-time API call to pricing provider
2. ❌ No offline support - app useless without internet
3. ❌ High API credit usage - expensive at scale
4. ❌ Slow response times - waiting for external APIs
5. ❌ Convention usage fails with spotty WiFi

### Target Use Cases:
- **At home:** Building decks, organizing collection (good internet)
- **At conventions:** Quick price checks, making deals (spotty internet)
- **Trading:** Fast scanning multiple cards in succession

---

## Architecture Overview

### Three-Layer Caching Strategy

```
┌─────────────────────────────────────────────┐
│ Layer 1: iPhone App Local Cache             │
│ - 7-day cache of scan results                │
│ - Offline fallback                           │
│ - Pre-loaded sets support                    │
└─────────────────┬───────────────────────────┘
                  │
                  ↓ (when online)
┌─────────────────────────────────────────────┐
│ Layer 2: Backend Price Cache (24h)          │
│ - Provider-agnostic caching                  │
│ - In-memory or Redis                         │
│ - Automatic expiration                       │
└─────────────────┬───────────────────────────┘
                  │
                  ↓ (cache miss only)
┌─────────────────────────────────────────────┐
│ Layer 3: Pricing Providers                  │
│ - Scrydex API                                │
│ - PriceCharting API                          │
│ - Pokemon TCG API                            │
└─────────────────────────────────────────────┘
```

---

## Layer 1: iPhone App Local Cache

### Purpose
- Enable offline scanning at conventions
- Instant results for previously scanned cards
- Pre-load card sets before going to shows

### Implementation

#### Data Model
```swift
// Spotlight/Models/CachedScan.swift
struct CachedScan: Codable {
    let cardId: String
    let cardName: String
    let setName: String
    let cardNumber: String

    // Pricing data
    let price: Double
    let priceLabel: String  // "MARKET", "LOW", etc.
    let currencyCode: String
    let provider: String  // "scrydex", "pricecharting", "pokemontcg"

    // Cache metadata
    let cachedAt: Date
    let expiresAt: Date  // cachedAt + 7 days
    let source: CacheSource  // .scan, .preload, .backend

    // Full pricing details (optional)
    let fullPricing: PricingData?

    var age: TimeInterval {
        Date().timeIntervalSince(cachedAt)
    }

    var ageHours: Int {
        Int(age / 3600)
    }

    var isExpired: Bool {
        Date() > expiresAt
    }

    var freshnessLevel: FreshnessLevel {
        switch ageHours {
        case 0..<1: return .fresh
        case 1..<24: return .recent
        case 24..<168: return .outdated
        default: return .expired
        }
    }
}

enum CacheSource: String, Codable {
    case scan       // From scanning a card
    case preload    // From pre-loading a set
    case backend    // From backend response
}

enum FreshnessLevel {
    case fresh      // < 1 hour
    case recent     // 1-24 hours
    case outdated   // 1-7 days
    case expired    // > 7 days
}
```

#### Cache Manager
```swift
// Spotlight/Services/ScanCacheManager.swift
class ScanCacheManager {
    private let userDefaults = UserDefaults.standard
    private let cacheKey = "com.spotlight.scanCache"
    private let maxCacheSize = 1000  // Max cached cards

    // Save scan result to cache
    func save(_ scan: CachedScan) {
        var cache = loadCache()
        cache[scan.cardId] = scan

        // Enforce cache size limit
        if cache.count > maxCacheSize {
            removeOldestEntries(&cache)
        }

        saveCache(cache)
    }

    // Get cached scan
    func get(cardId: String) -> CachedScan? {
        let cache = loadCache()
        guard let scan = cache[cardId] else { return nil }

        // Check expiration
        if scan.isExpired {
            remove(cardId: cardId)
            return nil
        }

        return scan
    }

    // Check if we have cached data
    func hasCached(cardId: String) -> Bool {
        get(cardId: cardId) != nil
    }

    // Remove expired entries
    func cleanup() {
        var cache = loadCache()
        let beforeCount = cache.count

        cache = cache.filter { !$0.value.isExpired }

        let removedCount = beforeCount - cache.count
        if removedCount > 0 {
            print("🗑️ Removed \(removedCount) expired cache entries")
            saveCache(cache)
        }
    }

    // Pre-load a set of cards
    func preloadSet(cards: [CachedScan]) {
        var cache = loadCache()
        for card in cards {
            cache[card.cardId] = card
        }
        saveCache(cache)
        print("📦 Pre-loaded \(cards.count) cards")
    }

    // Clear all cache
    func clearAll() {
        userDefaults.removeObject(forKey: cacheKey)
    }

    // Private helpers
    private func loadCache() -> [String: CachedScan] {
        guard let data = userDefaults.data(forKey: cacheKey),
              let cache = try? JSONDecoder().decode([String: CachedScan].self, from: data) else {
            return [:]
        }
        return cache
    }

    private func saveCache(_ cache: [String: CachedScan]) {
        if let data = try? JSONEncoder().encode(cache) {
            userDefaults.set(data, forKey: cacheKey)
        }
    }

    private func removeOldestEntries(_ cache: inout [String: CachedScan]) {
        let sorted = cache.values.sorted { $0.cachedAt < $1.cachedAt }
        let toRemove = sorted.prefix(100)  // Remove oldest 100
        for scan in toRemove {
            cache.removeValue(forKey: scan.cardId)
        }
    }
}
```

#### Scanner Integration
```swift
// Spotlight/ViewModels/ScannerViewModel.swift
class ScannerViewModel: ObservableObject {
    private let cacheManager = ScanCacheManager()

    func processScannedCard(image: UIImage) async {
        // 1. Try backend (with timeout)
        do {
            let result = try await withTimeout(seconds: 5) {
                try await self.backend.scanCard(image)
            }

            // Success - save to cache
            let cachedScan = CachedScan(from: result)
            cacheManager.save(cachedScan)

            updateUI(result, cacheStatus: .fresh)
            return

        } catch {
            print("⚠️ Backend request failed: \(error)")
        }

        // 2. Backend failed - check local cache
        if let cached = cacheManager.get(cardId: extractedCardId) {
            print("📦 Using cached result (age: \(cached.ageHours)h)")
            updateUI(cached, cacheStatus: cached.freshnessLevel)
            return
        }

        // 3. No cache - show error
        showError("No internet and no cached data for this card")
    }
}
```

---

## Layer 2: Backend Price Cache (24 Hours)

### Purpose
- Reduce API calls to pricing providers
- Instant responses (no waiting for external APIs)
- Lower costs (fewer API credits consumed)
- Provider-agnostic caching

### Implementation

#### Cache Data Structure
```python
# backend/price_cache.py
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
import threading

@dataclass
class CachedPrice:
    """Provider-agnostic cached pricing data"""
    card_id: str
    provider: str  # "scrydex", "pricecharting", "pokemontcg"
    pricing_data: Dict[str, Any]  # Full pricing response
    cached_at: datetime
    expires_at: datetime

    @property
    def is_expired(self) -> bool:
        return datetime.utcnow() > self.expires_at

    @property
    def age_hours(self) -> float:
        delta = datetime.utcnow() - self.cached_at
        return delta.total_seconds() / 3600

    @classmethod
    def create(cls, card_id: str, provider: str, pricing_data: Dict[str, Any]):
        """Create a new cache entry with 24-hour TTL"""
        now = datetime.utcnow()
        return cls(
            card_id=card_id,
            provider=provider,
            pricing_data=pricing_data,
            cached_at=now,
            expires_at=now + timedelta(hours=24)
        )

class PriceCache:
    """Thread-safe in-memory price cache"""

    def __init__(self):
        self._cache: Dict[str, CachedPrice] = {}
        self._lock = threading.Lock()
        self._hits = 0
        self._misses = 0

    def get(self, card_id: str, provider: str) -> Optional[Dict[str, Any]]:
        """Get cached price for a card from a specific provider"""
        cache_key = f"{provider}:{card_id}"

        with self._lock:
            cached = self._cache.get(cache_key)

            if cached is None:
                self._misses += 1
                return None

            if cached.is_expired:
                # Remove expired entry
                del self._cache[cache_key]
                self._misses += 1
                return None

            # Cache hit!
            self._hits += 1
            return {
                **cached.pricing_data,
                "_cache_metadata": {
                    "cache_hit": True,
                    "cached_at": cached.cached_at.isoformat(),
                    "age_hours": cached.age_hours,
                    "provider": cached.provider
                }
            }

    def set(self, card_id: str, provider: str, pricing_data: Dict[str, Any]):
        """Cache price for a card from a specific provider"""
        cache_key = f"{provider}:{card_id}"
        cached_price = CachedPrice.create(card_id, provider, pricing_data)

        with self._lock:
            self._cache[cache_key] = cached_price

    def cleanup_expired(self):
        """Remove all expired entries"""
        with self._lock:
            before_count = len(self._cache)
            self._cache = {
                k: v for k, v in self._cache.items()
                if not v.is_expired
            }
            removed = before_count - len(self._cache)
            if removed > 0:
                print(f"🗑️  Removed {removed} expired cache entries")

    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics"""
        with self._lock:
            total_requests = self._hits + self._misses
            hit_rate = (self._hits / total_requests * 100) if total_requests > 0 else 0

            return {
                "cache_size": len(self._cache),
                "hits": self._hits,
                "misses": self._misses,
                "hit_rate_percent": round(hit_rate, 2),
                "providers": self._get_provider_breakdown()
            }

    def _get_provider_breakdown(self) -> Dict[str, int]:
        """Get count of cached entries per provider"""
        breakdown = {}
        for cached in self._cache.values():
            breakdown[cached.provider] = breakdown.get(cached.provider, 0) + 1
        return breakdown

# Global cache instance
price_cache = PriceCache()
```

#### Provider Integration
```python
# backend/pricing_provider.py (modify existing)

class PricingProvider(ABC):
    """Base class for pricing providers - now with caching"""

    def get_pricing(self, card_id: str, **kwargs) -> Optional[PricingData]:
        """Get pricing with caching"""
        # Check cache first
        cached = price_cache.get(card_id, self.provider_name)
        if cached:
            print(f"✅ Cache hit: {card_id} ({self.provider_name})")
            return self._parse_pricing_data(cached)

        # Cache miss - fetch from API
        print(f"⚠️  Cache miss: {card_id} ({self.provider_name})")
        pricing_data = self._fetch_pricing_from_api(card_id, **kwargs)

        if pricing_data:
            # Save to cache
            price_cache.set(card_id, self.provider_name, pricing_data)

        return self._parse_pricing_data(pricing_data)

    @abstractmethod
    def _fetch_pricing_from_api(self, card_id: str, **kwargs) -> Optional[Dict]:
        """Fetch pricing from the actual API (to be implemented by subclasses)"""
        pass

    @abstractmethod
    def _parse_pricing_data(self, raw_data: Dict) -> Optional[PricingData]:
        """Parse raw pricing data into PricingData model"""
        pass
```

#### Background Cache Cleanup
```python
# backend/server.py (add)
import threading
import time

def background_cache_cleanup():
    """Run cache cleanup every hour"""
    while True:
        time.sleep(3600)  # 1 hour
        price_cache.cleanup_expired()

# Start background cleanup thread
cleanup_thread = threading.Thread(target=background_cache_cleanup, daemon=True)
cleanup_thread.start()
```

#### Cache Status Endpoint
```python
# backend/server.py (add endpoint)

@app.route("/api/v1/ops/cache-status", methods=["GET"])
def get_cache_status():
    """Get cache statistics"""
    stats = price_cache.get_stats()
    return jsonify({
        "status": "ok",
        "cache": stats,
        "uptime_hours": get_uptime_hours()
    })
```

---

## Layer 3: Pre-Load Sets Feature

### Purpose
- Download card sets before conventions
- Enable completely offline usage
- Faster scanning (no network calls needed)

### Backend Implementation

#### Pre-load API Endpoint
```python
# backend/server.py (add endpoint)

@app.route("/api/v1/preload-set/<set_id>", methods=["GET"])
def preload_set(set_id: str):
    """
    Get all cards in a set with current prices.

    Example: GET /api/v1/preload-set/sv3
    Returns: List of cards with pricing data
    """
    # Get all cards in set from catalog
    cards = catalog.get_cards_by_set(set_id)

    if not cards:
        return jsonify({"error": "Set not found"}), 404

    result = []
    for card in cards:
        # Get pricing (from cache or API)
        pricing = provider_registry.get_pricing(card.id)

        result.append({
            "card_id": card.id,
            "name": card.name,
            "set_name": card.set_name,
            "card_number": card.number,
            "image_url": card.image_url,
            "pricing": pricing.to_dict() if pricing else None,
            "cached_at": datetime.utcnow().isoformat()
        })

    return jsonify({
        "set_id": set_id,
        "set_name": cards[0].set_name if cards else None,
        "card_count": len(result),
        "cards": result,
        "generated_at": datetime.utcnow().isoformat()
    })

@app.route("/api/v1/sets/popular", methods=["GET"])
def get_popular_sets():
    """Get list of popular sets for pre-loading"""
    popular_sets = [
        {"id": "sv3pt5", "name": "Scarlet & Violet 151", "card_count": 165},
        {"id": "sv6", "name": "Twilight Masquerade", "card_count": 167},
        {"id": "sv5", "name": "Temporal Forces", "card_count": 162},
        {"id": "sv4pt5", "name": "Paldean Fates", "card_count": 91},
        # ... more sets
    ]

    return jsonify({
        "sets": popular_sets
    })
```

### iPhone Implementation

#### Pre-load Settings UI
```swift
// Spotlight/Views/SettingsView.swift
struct PreloadSetsView: View {
    @StateObject private var viewModel = PreloadViewModel()

    var body: some View {
        List {
            Section(header: Text("Popular Sets")) {
                ForEach(viewModel.popularSets) { set in
                    PreloadSetRow(
                        set: set,
                        isDownloaded: viewModel.isDownloaded(set.id),
                        downloadProgress: viewModel.downloadProgress(set.id),
                        onDownload: { viewModel.download(set) },
                        onDelete: { viewModel.delete(set) }
                    )
                }
            }

            Section(header: Text("Downloaded Sets")) {
                if viewModel.downloadedSets.isEmpty {
                    Text("No sets downloaded yet")
                        .foregroundColor(.secondary)
                } else {
                    ForEach(viewModel.downloadedSets) { set in
                        DownloadedSetRow(
                            set: set,
                            onDelete: { viewModel.delete(set) }
                        )
                    }
                }
            }
        }
        .navigationTitle("Pre-load Sets")
        .onAppear {
            viewModel.loadPopularSets()
        }
    }
}

struct PreloadSetRow: View {
    let set: CardSet
    let isDownloaded: Bool
    let downloadProgress: Double?
    let onDownload: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(set.name)
                    .font(.headline)
                Text("\(set.cardCount) cards")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer()

            if let progress = downloadProgress {
                ProgressView(value: progress)
                    .frame(width: 60)
                Text("\(Int(progress * 100))%")
                    .font(.caption)
            } else if isDownloaded {
                Button(action: onDelete) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                }
            } else {
                Button(action: onDownload) {
                    Image(systemName: "arrow.down.circle")
                        .foregroundColor(.blue)
                }
            }
        }
    }
}
```

#### Pre-load ViewModel
```swift
// Spotlight/ViewModels/PreloadViewModel.swift
class PreloadViewModel: ObservableObject {
    @Published var popularSets: [CardSet] = []
    @Published var downloadedSets: [CardSet] = []
    @Published var downloadProgress: [String: Double] = [:]

    private let backend: BackendService
    private let cacheManager: ScanCacheManager

    func loadPopularSets() async {
        let sets = await backend.getPopularSets()
        await MainActor.run {
            self.popularSets = sets
        }
    }

    func download(_ set: CardSet) {
        Task {
            await MainActor.run {
                downloadProgress[set.id] = 0.0
            }

            // Download set data
            let cards = await backend.preloadSet(set.id) { progress in
                await MainActor.run {
                    self.downloadProgress[set.id] = progress
                }
            }

            // Save to cache
            let cachedScans = cards.map { CachedScan(from: $0, source: .preload) }
            cacheManager.preloadSet(cards: cachedScans)

            await MainActor.run {
                downloadProgress.removeValue(forKey: set.id)
                downloadedSets.append(set)
            }
        }
    }

    func delete(_ set: CardSet) {
        // Remove from cache
        cacheManager.removeSet(set.id)
        downloadedSets.removeAll { $0.id == set.id }
    }
}
```

---

## UI/UX Changes

### Cache Freshness Indicators

#### In Scan Results
```swift
// Show cache status in scan result
struct ScanResultView: View {
    let result: ScanResult

    var cacheIndicator: some View {
        switch result.cacheStatus {
        case .fresh:
            Label("Fresh", systemImage: "checkmark.circle.fill")
                .foregroundColor(.green)
        case .recent(let hours):
            Label("Cached \(hours)h ago", systemImage: "clock.fill")
                .foregroundColor(.yellow)
        case .outdated(let hours):
            Label("Outdated (\(hours)h old)", systemImage: "exclamationmark.triangle.fill")
                .foregroundColor(.orange)
        case .offline:
            Label("Offline mode", systemImage: "wifi.slash")
                .foregroundColor(.red)
        }
    }
}
```

#### In Tray Rows
```
┌─────────────────────────────────────┐
│ [Image] Charizard VMAX              │
│         Darkness Ablaze • 020/189   │
│         Market $45.67 • Scrydex     │
│         🟢 Fresh                     │ ← Freshness indicator
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ [Image] Pikachu VMAX                │
│         Vivid Voltage • 044/185     │
│         Market $12.34 • PriceCharting│
│         🟡 Cached 3h ago             │ ← Cache age
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ [Image] Mewtwo V                    │
│         Pokemon GO • 030/078        │
│         Market $8.90 • Pokemon TCG  │
│         🟠 May be outdated (2d ago)  │ ← Outdated warning
└─────────────────────────────────────┘
```

---

## Performance & Cost Impact

### Without Caching
```
Users: 1,000
Scans per user per day: 20
Days per month: 30

Total scans: 1,000 × 20 × 30 = 600,000 scans/month

API calls: 600,000 (no caching)
Average latency: 500ms (waiting for API)
API credits consumed: 600,000
Estimated cost: $200-500/month
```

### With Backend Cache (24h TTL)
```
Unique cards scanned: ~5,000 different cards
Cache hit rate: 95% (most cards scanned multiple times)

API calls: 5,000 unique × 30 refreshes = 150,000/month
API calls saved: 450,000 (75% reduction)
Average latency: 50ms (cached)
API credits consumed: 150,000
Estimated cost: $50-125/month

Savings: $150-375/month (75% cost reduction)
```

### With iPhone Local Cache
```
Convention scenario:
- User scans 50 cards at show
- 20 cards are rescans (checking prices again)
- With local cache: 20 rescans = 0 API calls
- Without cache: 20 rescans = 20 API calls

Additional savings: 30-40% fewer API calls
Offline capability: Works without internet
```

### With Pre-loaded Sets
```
Power user scenario:
- Pre-loads "Scarlet & Violet 151" (165 cards)
- At convention, scans 40 cards from this set
- With pre-load: 40 scans = 0 API calls (all cached)
- Without pre-load: 40 scans = ~38 API calls (2 cache hits)

Offline capability: Fully functional without internet
```

---

## Implementation Checklist

### Phase 1: Backend Cache (High Priority)
- [ ] Task #6: Design provider-agnostic caching architecture
- [ ] Task #7: Implement backend 24-hour price cache
- [ ] Task #8: Add cache metadata to API responses
- [ ] Task #14: Add cache expiration and cleanup logic
- [ ] Task #15: Add cache metrics and monitoring

**Estimated time:** 4-6 hours
**Impact:** 75% cost reduction, instant responses

### Phase 2: iPhone Local Cache (High Priority)
- [ ] Task #9: Implement iPhone local scan cache
- [ ] Task #10: Add offline fallback logic to iPhone app
- [ ] Task #11: Add cache age indicators to UI
- [ ] Cleanup expired cache on app launch
- [ ] Test offline mode thoroughly

**Estimated time:** 6-8 hours
**Impact:** Offline capability, convention-ready

### Phase 3: Pre-load Sets (Medium Priority)
- [ ] Task #12: Implement pre-load sets API endpoint
- [ ] Task #13: Add pre-load sets UI to iPhone app
- [ ] Add popular sets list
- [ ] Add download progress indicators
- [ ] Add set management (delete, update)

**Estimated time:** 6-8 hours
**Impact:** Full offline mode for power users

---

## Testing Strategy

### Backend Cache Testing
```bash
# Test cache hit/miss
curl http://localhost:8788/api/v1/scan -X POST -d '{"image": "..."}'
# Response should include: "cache_hit": false

# Scan same card again
curl http://localhost:8788/api/v1/scan -X POST -d '{"image": "..."}'
# Response should include: "cache_hit": true

# Check cache stats
curl http://localhost:8788/api/v1/ops/cache-status
# Should show hit rate, cache size, etc.
```

### iPhone Cache Testing
1. **Offline mode test:**
   - Scan a card with WiFi on → should get fresh data
   - Turn WiFi off
   - Scan same card → should show cached data with age
   - Scan new card → should show "No internet" error

2. **Cache expiration test:**
   - Scan a card
   - Manually set device date to +8 days in future
   - Open app → cache should be cleaned up
   - Scan card → should try backend (not use expired cache)

3. **Pre-load test:**
   - Go to Settings → Pre-load Sets
   - Download "Scarlet & Violet 151"
   - Turn off WiFi
   - Scan cards from this set → should work offline

### Performance Testing
```bash
# Measure latency improvement
time curl http://localhost:8788/api/v1/scan -X POST -d '{"image": "..."}'
# First call (cache miss): ~500ms
# Second call (cache hit): ~50ms

# Measure cache hit rate after 1000 scans
# Target: >90% hit rate
```

---

## Monitoring & Metrics

### Backend Metrics to Track
- Cache hit rate (target: >90%)
- Cache size (number of entries)
- API call reduction (target: 75%)
- Average response time (target: <100ms)
- Cache memory usage

### iPhone Metrics to Track
- Local cache size (number of cards)
- Offline scan success rate
- Cache age distribution
- Pre-loaded sets count

### Logging
```python
# Backend
print(f"✅ Cache hit: {card_id} ({provider}) - age: {age}h")
print(f"⚠️  Cache miss: {card_id} ({provider}) - calling API")
print(f"📊 Cache stats: {hit_rate}% hit rate, {cache_size} entries")
```

```swift
// iPhone
print("📦 Using cached result (age: \(ageHours)h)")
print("🌐 Fresh data from backend")
print("❌ Offline mode - no cached data")
```

---

## Migration Plan

### Step 1: Add Backend Cache (No Breaking Changes)
1. Add `price_cache.py` module
2. Modify `PricingProvider` base class to use cache
3. Add cache cleanup background thread
4. Add `/api/v1/ops/cache-status` endpoint
5. Deploy and monitor

**Timeline:** 1-2 days
**Risk:** Low (backwards compatible)

### Step 2: Add iPhone Local Cache
1. Add `CachedScan` model
2. Add `ScanCacheManager` service
3. Modify `ScannerViewModel` to check cache on failures
4. Add cache cleanup on app launch
5. Test offline mode

**Timeline:** 2-3 days
**Risk:** Low (additive feature)

### Step 3: Add UI Indicators
1. Add freshness indicators to scan results
2. Add cache age to tray rows
3. Add offline mode indicator
4. Test with various cache ages

**Timeline:** 1-2 days
**Risk:** Low (UI changes only)

### Step 4: Add Pre-load Feature (Optional)
1. Add backend endpoints
2. Add Settings UI
3. Add download logic
4. Test full offline mode

**Timeline:** 2-3 days
**Risk:** Low (isolated feature)

---

## Provider-Agnostic Design

### Key Principle
The caching layer is **provider-agnostic** - it caches responses from any pricing provider (Scrydex, PriceCharting, Pokemon TCG API) using the same mechanism.

### How It Works
```python
# Cache key format: "{provider}:{card_id}"
cache_key = "scrydex:charizard-vmax-sv3-123"
cache_key = "pricecharting:charizard-vmax-sv3-123"
cache_key = "pokemontcg:charizard-vmax-sv3-123"

# Each provider's data is cached separately
# This allows:
# - Switching providers without losing cache
# - Comparing prices from multiple providers
# - Provider-specific cache invalidation
```

### Provider Registry Integration
```python
# Existing provider registry (no changes needed)
provider_registry = PricingProviderRegistry()
provider_registry.register(PokemonTCGPricingAdapter(), priority=1)
provider_registry.register(PriceChartingAdapter(), priority=2)
provider_registry.register(ScrydexAdapter(), priority=3)

# Caching happens inside each provider's get_pricing() method
# Registry doesn't need to know about caching
pricing = provider_registry.get_pricing(card_id)  # May use cache
```

---

## Success Criteria

### Must Have (Phase 1 & 2)
- ✅ Backend cache reduces API calls by >75%
- ✅ Average response time <100ms (cached)
- ✅ iPhone works offline for previously scanned cards
- ✅ Cache age shown in UI
- ✅ No breaking changes to existing API

### Nice to Have (Phase 3)
- ✅ Pre-load sets feature working
- ✅ Offline mode for entire sets
- ✅ Cache hit rate >90%

### Success Metrics
```
Before Caching:
- API calls: 600,000/month
- Avg latency: 500ms
- Cost: $200-500/month
- Offline capable: No

After Caching:
- API calls: 150,000/month (75% reduction)
- Avg latency: 50ms (90% reduction)
- Cost: $50-125/month (75% reduction)
- Offline capable: Yes
```

---

## Next Steps

1. Review this plan with team
2. Start with Phase 1 (Backend cache) - highest ROI
3. Deploy and monitor for 1 week
4. Proceed to Phase 2 (iPhone cache) once Phase 1 is stable
5. Optionally add Phase 3 (Pre-load) based on user feedback

**Total estimated time:** 2-3 weeks part-time
**Total estimated cost savings:** $150-375/month
**User experience improvement:** Offline capability + 10x faster responses
