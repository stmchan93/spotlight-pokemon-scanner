#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST_PATH="${1:-$ROOT_DIR/qa/scanner-regression.local.json}"
SERVER_URL="${SPOTLIGHT_SCANNER_SERVER:-http://127.0.0.1:8787/}"

cd "$ROOT_DIR"

mkdir -p .swift-module-cache

swiftc \
  -module-cache-path .swift-module-cache \
  Spotlight/Services/SlabLabelParsing.swift \
  tools/scanner_eval.swift \
  -o ./.scanner_eval
./.scanner_eval --manifest "$MANIFEST_PATH" --server "$SERVER_URL"
