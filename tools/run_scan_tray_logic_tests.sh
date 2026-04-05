#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

tmp_binary="$(mktemp /tmp/scan_tray_logic_tests.XXXXXX)"
trap 'rm -f "$tmp_binary"' EXIT

swiftc \
  Spotlight/Models/CardCandidate.swift \
  Spotlight/Models/ScanTrayLogic.swift \
  tools/scan_tray_logic_tests.swift \
  -o "$tmp_binary"

"$tmp_binary"
