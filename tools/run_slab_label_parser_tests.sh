#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

tmp_binary="$(mktemp /tmp/slab_label_parser_tests.XXXXXX)"
module_cache_dir="/Users/stephenchan/Code/spotlight/.derivedData/ModuleCache.noindex"
trap 'rm -f "$tmp_binary"' EXIT

mkdir -p "$module_cache_dir"

swiftc \
  -module-cache-path "$module_cache_dir" \
  Spotlight/Services/SlabLabelParsing.swift \
  tools/slab_label_parser_tests.swift \
  -o "$tmp_binary"

"$tmp_binary"
