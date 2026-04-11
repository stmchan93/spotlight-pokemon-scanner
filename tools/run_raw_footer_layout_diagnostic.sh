#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

target_path="${1:-qa/raw-footer-layout-check}"
zsh tools/run_footer_metadata_overlay_diagnostic.sh "$target_path"
