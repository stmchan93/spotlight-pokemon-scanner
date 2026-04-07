#!/usr/bin/env python3
"""
Unit tests for price_cache.py

Tests the 24-hour price caching infrastructure including:
- Cache hit/miss behavior
- Expiration logic
- Cleanup functionality
- Statistics tracking
- Thread safety
"""

import unittest
import time
from datetime import datetime, timedelta
from price_cache import CachedPrice, PriceCache


class TestCachedPrice(unittest.TestCase):
    """Test CachedPrice dataclass functionality"""

    def test_create_cached_price(self):
        """Test creating a cached price entry"""
        card_id = "test-card-1"
        provider = "test_provider"
        pricing_data = {"market": 10.0, "low": 8.0}

        cached = CachedPrice.create(card_id, provider, pricing_data, ttl_hours=24)

        self.assertEqual(cached.card_id, card_id)
        self.assertEqual(cached.provider, provider)
        self.assertEqual(cached.pricing_data, pricing_data)
        self.assertIsInstance(cached.cached_at, datetime)
        self.assertIsInstance(cached.expires_at, datetime)

    def test_is_not_expired(self):
        """Test that recently cached prices are not expired"""
        cached = CachedPrice.create("test-1", "provider", {}, ttl_hours=24)
        self.assertFalse(cached.is_expired)

    def test_is_expired(self):
        """Test that old cached prices are expired"""
        # Create a cached price that expired 1 hour ago
        now = datetime.utcnow()
        expired_time = now - timedelta(hours=25)

        cached = CachedPrice(
            card_id="test-1",
            provider="provider",
            pricing_data={},
            cached_at=expired_time,
            expires_at=expired_time + timedelta(hours=24)
        )

        self.assertTrue(cached.is_expired)

    def test_age_hours(self):
        """Test age calculation in hours"""
        # Create a price cached 2 hours ago
        two_hours_ago = datetime.utcnow() - timedelta(hours=2)
        cached = CachedPrice(
            card_id="test-1",
            provider="provider",
            pricing_data={},
            cached_at=two_hours_ago,
            expires_at=two_hours_ago + timedelta(hours=24)
        )

        # Age should be approximately 2 hours (allow small variance)
        self.assertAlmostEqual(cached.age_hours, 2.0, delta=0.1)


class TestPriceCache(unittest.TestCase):
    """Test PriceCache functionality"""

    def setUp(self):
        """Create a fresh cache for each test"""
        self.cache = PriceCache()

    def test_cache_miss_on_empty(self):
        """Test that get returns None for non-existent entry"""
        result = self.cache.get("non-existent", "provider")
        self.assertIsNone(result)

    def test_cache_set_and_get(self):
        """Test basic cache set and get"""
        card_id = "test-card-1"
        provider = "test_provider"
        pricing_data = {"market": 10.0, "low": 8.0}

        self.cache.set(card_id, provider, pricing_data)
        result = self.cache.get(card_id, provider)

        self.assertIsNotNone(result)
        self.assertEqual(result["market"], 10.0)
        self.assertEqual(result["low"], 8.0)
        self.assertIn("_cache_metadata", result)

    def test_cache_metadata(self):
        """Test that cache metadata is added to retrieved data"""
        card_id = "test-card-1"
        provider = "test_provider"
        pricing_data = {"market": 10.0}

        self.cache.set(card_id, provider, pricing_data)
        result = self.cache.get(card_id, provider)

        metadata = result["_cache_metadata"]
        self.assertTrue(metadata["cache_hit"])
        self.assertEqual(metadata["provider"], provider)
        self.assertIn("cached_at", metadata)
        self.assertIn("age_hours", metadata)

    def test_cache_hit_miss_tracking(self):
        """Test that hit/miss statistics are tracked correctly"""
        # Initial state
        stats = self.cache.get_stats()
        self.assertEqual(stats["hits"], 0)
        self.assertEqual(stats["misses"], 0)

        # Cache miss
        self.cache.get("non-existent", "provider")
        stats = self.cache.get_stats()
        self.assertEqual(stats["misses"], 1)

        # Cache set and hit
        self.cache.set("test-1", "provider", {"market": 10.0})
        self.cache.get("test-1", "provider")
        stats = self.cache.get_stats()
        self.assertEqual(stats["hits"], 1)
        self.assertEqual(stats["misses"], 1)

    def test_cache_hit_rate(self):
        """Test hit rate calculation"""
        # 1 miss, 2 hits = 66.67% hit rate
        self.cache.get("non-existent", "provider")  # miss
        self.cache.set("test-1", "provider", {"market": 10.0})
        self.cache.get("test-1", "provider")  # hit
        self.cache.get("test-1", "provider")  # hit

        stats = self.cache.get_stats()
        self.assertAlmostEqual(stats["hit_rate_percent"], 66.67, places=1)

    def test_different_providers_different_cache(self):
        """Test that same card ID with different providers are cached separately"""
        card_id = "test-card-1"
        provider1 = "provider_a"
        provider2 = "provider_b"

        self.cache.set(card_id, provider1, {"market": 10.0})
        self.cache.set(card_id, provider2, {"market": 20.0})

        result1 = self.cache.get(card_id, provider1)
        result2 = self.cache.get(card_id, provider2)

        self.assertEqual(result1["market"], 10.0)
        self.assertEqual(result2["market"], 20.0)

    def test_expired_entry_removed_on_get(self):
        """Test that expired entries are removed when accessed"""
        card_id = "test-card-1"
        provider = "provider"

        # Manually create an expired entry
        cache_key = f"{provider}:{card_id}"
        expired_time = datetime.utcnow() - timedelta(hours=25)
        expired_entry = CachedPrice(
            card_id=card_id,
            provider=provider,
            pricing_data={"market": 10.0},
            cached_at=expired_time,
            expires_at=expired_time + timedelta(hours=24)
        )

        # Directly insert expired entry into cache
        self.cache._cache[cache_key] = expired_entry

        # Get should return None and remove the entry
        result = self.cache.get(card_id, provider)
        self.assertIsNone(result)

        # Verify it was removed (not just returned None)
        stats = self.cache.get_stats()
        self.assertEqual(stats["cache_size"], 0)

    def test_cleanup_expired(self):
        """Test cleanup of expired entries"""
        # Manually create expired entries
        expired_time = datetime.utcnow() - timedelta(hours=25)

        expired1 = CachedPrice(
            card_id="expired-1",
            provider="provider",
            pricing_data={"market": 10.0},
            cached_at=expired_time,
            expires_at=expired_time + timedelta(hours=24)
        )
        expired2 = CachedPrice(
            card_id="expired-2",
            provider="provider",
            pricing_data={"market": 20.0},
            cached_at=expired_time,
            expires_at=expired_time + timedelta(hours=24)
        )

        # Add expired entries directly
        self.cache._cache["provider:expired-1"] = expired1
        self.cache._cache["provider:expired-2"] = expired2

        # Add valid entry normally
        self.cache.set("valid-1", "provider", {"market": 30.0}, ttl_hours=24)

        # Should have 3 entries before cleanup
        self.assertEqual(len(self.cache._cache), 3)

        # Cleanup should remove 2 expired entries
        self.cache.cleanup_expired()

        stats = self.cache.get_stats()
        self.assertEqual(stats["cache_size"], 1)

    def test_provider_breakdown(self):
        """Test provider breakdown in statistics"""
        self.cache.set("card-1", "provider_a", {"market": 10.0})
        self.cache.set("card-2", "provider_a", {"market": 20.0})
        self.cache.set("card-3", "provider_b", {"market": 30.0})

        stats = self.cache.get_stats()
        providers = stats["providers"]

        self.assertEqual(providers["provider_a"], 2)
        self.assertEqual(providers["provider_b"], 1)

    def test_cache_update_overwrites(self):
        """Test that setting same card_id/provider updates the cache"""
        card_id = "test-card-1"
        provider = "provider"

        self.cache.set(card_id, provider, {"market": 10.0})
        self.cache.set(card_id, provider, {"market": 20.0})

        result = self.cache.get(card_id, provider)
        self.assertEqual(result["market"], 20.0)

        # Should only have 1 entry, not 2
        stats = self.cache.get_stats()
        self.assertEqual(stats["cache_size"], 1)


class TestPriceCacheThreadSafety(unittest.TestCase):
    """Test thread safety of PriceCache"""

    def test_concurrent_access(self):
        """Test concurrent get/set operations"""
        import threading

        cache = PriceCache()
        errors = []

        def worker(thread_id):
            try:
                for i in range(100):
                    card_id = f"card-{i}"
                    provider = f"provider-{thread_id}"
                    cache.set(card_id, provider, {"market": i})
                    result = cache.get(card_id, provider)
                    if result is None or result["market"] != i:
                        errors.append(f"Thread {thread_id}: Mismatch at {i}")
            except Exception as e:
                errors.append(f"Thread {thread_id}: {str(e)}")

        # Run 10 threads concurrently
        threads = []
        for i in range(10):
            t = threading.Thread(target=worker, args=(i,))
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        self.assertEqual(len(errors), 0, f"Thread safety errors: {errors}")


def run_tests():
    """Run all tests and return results"""
    # Create test suite
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    suite.addTests(loader.loadTestsFromTestCase(TestCachedPrice))
    suite.addTests(loader.loadTestsFromTestCase(TestPriceCache))
    suite.addTests(loader.loadTestsFromTestCase(TestPriceCacheThreadSafety))

    # Run tests
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    return result.wasSuccessful()


if __name__ == "__main__":
    success = run_tests()
    exit(0 if success else 1)
