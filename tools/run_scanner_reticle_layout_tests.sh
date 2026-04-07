#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

tmp_binary="$(mktemp /tmp/scanner_reticle_layout_tests.XXXXXX)"
module_cache_dir="/Users/stephenchan/Code/spotlight/.derivedData/ModuleCache.noindex"
trap 'rm -f "$tmp_binary"' EXIT

mkdir -p "$module_cache_dir"

swiftc \
  -module-cache-path "$module_cache_dir" \
  Spotlight/Views/ScannerReticleLayout.swift \
  tools/scanner_reticle_layout_tests.swift \
  -o "$tmp_binary"

"$tmp_binary"
