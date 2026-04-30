#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ACTION="${1:-}"

if [ "$ACTION" != "build" ] && [ "$ACTION" != "release" ]; then
  echo "Usage: $0 <build|release> [additional release-gate args...]" >&2
  exit 1
fi

shift
if [ "${1:-}" = "--" ]; then
  shift
fi

exec python3 "$SCRIPT_DIR/run_release_gate.py" --environment staging --mobile-action "$ACTION" --skip-check --skip-audit --skip-smoke "$@"
