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

# Production counterpart of run_staging_mobile_release_gate.sh, with one
# deliberate difference: --skip-deploy. The staging gate auto-deploys the
# backend alongside a mobile build; a PRODUCTION backend deploy must remain its
# own explicit, separately approved step (pnpm backend:deploy:production via
# run_production_release_gate.sh) — a mobile build/release must never silently
# ship backend code to real users as a side effect.
#
# --skip-smoke is inherited from the staging gate for a second reason too: the
# gate's smoke flow drives the staging fixture-reset lane and staging smoke
# credentials, which do not exist for production.
#
# The SPOTLIGHT_PROD_CONFIRM=yes per-invocation confirmation is NOT handled
# here; it is enforced downstream by tools/run_mobile_eas.sh before any EAS
# action runs, so this gate cannot be used to bypass it.
exec python3 "$SCRIPT_DIR/run_release_gate.py" --environment production --mobile-action "$ACTION" --skip-check --skip-audit --skip-smoke --skip-deploy "$@"
