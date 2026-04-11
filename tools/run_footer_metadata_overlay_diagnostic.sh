#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

if [[ "$#" -lt 1 ]]; then
  echo "usage: zsh tools/run_footer_metadata_overlay_diagnostic.sh <scan-folder-or-root> [more paths...]" >&2
  exit 1
fi

tmp_binary="$(mktemp /tmp/footer_metadata_overlay_diagnostic.XXXXXX)"
module_cache_dir="/Users/stephenchan/Code/spotlight/.derivedData/ModuleCache.noindex"
trap 'rm -f "$tmp_binary"' EXIT

mkdir -p "$module_cache_dir"

swiftc \
  -parse-as-library \
  -module-cache-path "$module_cache_dir" \
  tools/footer_metadata_overlay_diagnostic.swift \
  -o "$tmp_binary"

"$tmp_binary" "$@"
