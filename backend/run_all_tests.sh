#!/bin/bash
# Run all backend tests

set -e  # Exit on first error

echo "======================================"
echo "Running Backend Unit Tests"
echo "======================================"
echo ""

# Run price cache tests
echo "📦 Testing price_cache.py..."
python3 test_price_cache.py
echo ""

echo "======================================"
echo "✅ All Backend Tests Passed!"
echo "======================================"
