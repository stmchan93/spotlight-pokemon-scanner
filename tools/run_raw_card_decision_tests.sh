#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

tmp_binary="$(mktemp /tmp/raw_card_decision_tests.XXXXXX)"
module_cache_dir="/Users/stephenchan/Code/spotlight/.derivedData/ModuleCache.noindex"
trap 'rm -f "$tmp_binary"' EXIT

mkdir -p "$module_cache_dir"

swiftc \
  -module-cache-path "$module_cache_dir" \
  tools/raw_card_decision_tests.swift \
  -o "$tmp_binary"

"$tmp_binary"
