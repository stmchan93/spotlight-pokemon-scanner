#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

MOBILE_ACTION="none"

if [ "${1:-}" = "build" ] || [ "${1:-}" = "release" ]; then
  MOBILE_ACTION="$1"
  shift
fi

if [ "${1:-}" = "--" ]; then
  shift
fi

COMMAND=(python3 "$SCRIPT_DIR/run_release_gate.py" --environment staging)
if [ "$MOBILE_ACTION" != "none" ]; then
  COMMAND+=(--mobile-action "$MOBILE_ACTION")
fi
COMMAND+=("$@")

exec "${COMMAND[@]}"
