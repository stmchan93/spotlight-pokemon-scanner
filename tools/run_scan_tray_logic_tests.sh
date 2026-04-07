#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

tmp_binary="$(mktemp /tmp/scan_tray_logic_tests.XXXXXX)"
module_cache_dir="/Users/stephenchan/Code/spotlight/.derivedData/ModuleCache.noindex"
trap 'rm -f "$tmp_binary"' EXIT

mkdir -p "$module_cache_dir"

swiftc \
  -module-cache-path "$module_cache_dir" \
  Spotlight/Models/CardCandidate.swift \
  Spotlight/Models/ScanTrayLogic.swift \
  tools/scan_tray_logic_tests.swift \
  -o "$tmp_binary"

"$tmp_binary"
