#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_REALWORLD="${SPOTLIGHT_RUN_REALWORLD_REGRESSION:-0}"
REALWORLD_MANIFEST="${SPOTLIGHT_REALWORLD_MANIFEST:-$ROOT_DIR/qa/scanner-regression.realworld-2026-04-03.json}"

cd "$ROOT_DIR"

zsh tools/run_slab_label_parser_tests.sh
zsh tools/run_card_identifier_parser_tests.sh
zsh tools/run_scanner_reticle_layout_tests.sh
zsh tools/run_scan_tray_logic_tests.sh
python3 -m unittest discover -s backend/tests -p 'test_scanner_backend.py' -v

if [[ "$RUN_REALWORLD" == "1" ]]; then
  zsh tools/run_realworld_regression.sh "$REALWORLD_MANIFEST"
fi
