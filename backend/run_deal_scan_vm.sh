#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_CONFIG_FILE="${SPOTLIGHT_VM_RUNTIME_CONFIG:-$SCRIPT_DIR/.vm-runtime.conf}"

if [ ! -f "$RUNTIME_CONFIG_FILE" ]; then
  echo "Missing VM runtime config: $RUNTIME_CONFIG_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$RUNTIME_CONFIG_FILE"
if [ -n "${SPOTLIGHT_RUNTIME_ENV_FILE:-}" ] && [ -f "${SPOTLIGHT_RUNTIME_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${SPOTLIGHT_RUNTIME_ENV_FILE}"
fi
if [ -n "${SPOTLIGHT_SECRETS_FILE:-}" ] && [ -f "${SPOTLIGHT_SECRETS_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${SPOTLIGHT_SECRETS_FILE}"
fi
# Re-apply runtime config last so VM-specific overrides win over staged defaults.
# shellcheck disable=SC1090
. "$RUNTIME_CONFIG_FILE"
set +a

# Watchlist deal scan. The endpoint starts the scan on a daemon thread and acks
# immediately (same shape as /api/v1/ops/prewarm-portfolio), so a short timeout
# is enough — we are measuring the ack, not the scan.
#
# Env scoping is inherited, never chosen here: the runtime config sourced above
# is the one THIS box's deploy wrote for its own environment, and the target is
# always the loopback backend on this box. There is no environment switch and no
# remote host, so this wrapper cannot reach across environments.
DEAL_SCAN_URL="http://127.0.0.1:${SPOTLIGHT_PORT:-8788}/api/v1/ops/run-deal-scan"
if [ -n "${SPOTLIGHT_OPS_REFRESH_TOKEN:-}" ]; then
  DEAL_SCAN_URL="${DEAL_SCAN_URL}?token=${SPOTLIGHT_OPS_REFRESH_TOKEN}"
fi

echo "[deal-scan] $(date -u +"%Y-%m-%dT%H:%M:%SZ") triggering watchlist deal scan"
if curl -sS -m 30 -X POST "$DEAL_SCAN_URL"; then
  echo
  echo "[deal-scan] scan started"
else
  # Non-fatal by design. The scheduled wrapper reads this script's exit status
  # through `flock -n`, where a nonzero exit is indistinguishable from "lock
  # already held" — so a failed request must not poison that signal. The failure
  # is in the log above; the next hourly tick retries.
  echo "[deal-scan] request failed (non-fatal)" >&2
fi
