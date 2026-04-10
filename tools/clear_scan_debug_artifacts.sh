#!/bin/zsh
set -euo pipefail

root="${HOME}/Library/Developer/CoreSimulator/Devices"
removed=0

while IFS= read -r debug_dir; do
  rm -rf "$debug_dir"
  echo "removed: $debug_dir"
  removed=$((removed + 1))
done < <(find "$root" -type d -path '*/Library/Application Support/Spotlight/ScanDebug' -print 2>/dev/null)

while IFS= read -r export_dir; do
  rm -rf "$export_dir"
  echo "removed: $export_dir"
  removed=$((removed + 1))
done < <(find "$root" -type d -path '*/Documents/ScanDebugExports' -print 2>/dev/null)

host_debug_dir="${HOME}/Library/Application Support/Spotlight/ScanDebug"
if [[ -d "$host_debug_dir" ]]; then
  rm -rf "$host_debug_dir"
  echo "removed: $host_debug_dir"
  removed=$((removed + 1))
fi

host_export_dir="${HOME}/Documents/ScanDebugExports"
if [[ -d "$host_export_dir" ]]; then
  rm -rf "$host_export_dir"
  echo "removed: $host_export_dir"
  removed=$((removed + 1))
fi

echo "cleared_scan_debug_artifacts=$removed"
