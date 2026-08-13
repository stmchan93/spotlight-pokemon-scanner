#!/bin/bash

# Production release gate. Mirrors tools/run_staging_release_gate.sh but targets
# the production environment: checks + release-config audit + backend deploy via
# tools/deploy_backend.sh production.
#
# This gate deliberately does NOT set SPOTLIGHT_PROD_CONFIRM. The deploy step
# (tools/deploy_backend.sh production) hard-blocks unless the operator typed
# SPOTLIGHT_PROD_CONFIRM=yes for THIS invocation — that confirmation must stay
# per-invocation and human-typed, never baked into a script or profile.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

MOBILE_ACTION="none"
RUN_SMOKE=0
FORWARD_ARGS=()

if [ "${1:-}" = "build" ] || [ "${1:-}" = "release" ]; then
  MOBILE_ACTION="$1"
  shift
fi

if [ "${1:-}" = "--" ]; then
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --run-smoke)
      RUN_SMOKE=1
      ;;
    *)
      FORWARD_ARGS+=("$1")
      ;;
  esac
  shift
done

COMMAND=(python3 "$SCRIPT_DIR/run_release_gate.py" --environment production)
if [ "$MOBILE_ACTION" != "none" ]; then
  COMMAND+=(--mobile-action "$MOBILE_ACTION")
fi
if [ "$RUN_SMOKE" -ne 1 ]; then
  COMMAND+=(--skip-smoke)
fi
COMMAND+=("${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}")

exec "${COMMAND[@]}"
