#!/bin/bash

set -euo pipefail

BASE_URL="${SPOTLIGHT_SCANNER_SERVER:-http://127.0.0.1:8788}"

echo "Health"
curl -s "$BASE_URL/api/v1/health" | python3 -m json.tool

echo
echo "Provider status"
curl -s "$BASE_URL/api/v1/ops/provider-status" | python3 -m json.tool

echo
echo "Local search"
curl -s "$BASE_URL/api/v1/cards/search?q=charizard" | python3 -m json.tool
