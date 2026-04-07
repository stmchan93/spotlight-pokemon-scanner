#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

tmp_binary="$(mktemp /tmp/card_identifier_parser_tests.XXXXXX)"
module_cache_dir="/Users/stephenchan/Code/spotlight/.derivedData/ModuleCache.noindex"
trap 'rm -f "$tmp_binary"' EXIT

mkdir -p "$module_cache_dir"

swiftc \
  -module-cache-path "$module_cache_dir" \
  Spotlight/Services/CardIdentifierParsing.swift \
  tools/card_identifier_parser_tests.swift \
  -o "$tmp_binary"

"$tmp_binary"
