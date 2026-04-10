#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

tmp_binary="$(mktemp /tmp/ocr_fixture_runner.XXXXXX)"
module_cache_dir="/Users/stephenchan/Code/spotlight/.derivedData/ModuleCache.noindex"
trap 'rm -f "$tmp_binary"' EXIT

mkdir -p "$module_cache_dir"

swiftc \
  -parse-as-library \
  -module-cache-path "$module_cache_dir" \
  tools/ocr_fixture_runner.swift \
  -o "$tmp_binary"

"$tmp_binary" "$@"
