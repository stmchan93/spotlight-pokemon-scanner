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
# shellcheck disable=SC1090
. "$RUNTIME_CONFIG_FILE"
set +a

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
local_base_url="http://127.0.0.1:${SPOTLIGHT_PORT:-8788}"
public_base_url="${SPOTLIGHT_PUBLIC_BASE_URL:-}"
public_health_url=""
public_health_host=""

if [ -n "$public_base_url" ]; then
  public_health_url="${public_base_url%/}/api/v1/health"
  public_health_host="$(python3 - "$public_health_url" <<'PY'
from urllib.parse import urlparse
import sys

parsed = urlparse(sys.argv[1])
print(parsed.hostname or "", end="")
PY
)"
fi

echo "[$timestamp] health-check start"

backend_state="$(systemctl is-active spotlight-backend.service 2>/dev/null || true)"
caddy_state="$(systemctl is-active caddy 2>/dev/null || true)"
echo "[$timestamp] systemd backend=${backend_state:-unknown} caddy=${caddy_state:-unknown}"

curl -fsS --max-time 10 "$local_base_url/api/v1/health" >/tmp/spotlight-local-health.json
echo "[$timestamp] local-health ok"

curl -fsS --max-time 15 "$local_base_url/api/v1/ops/provider-status" >/tmp/spotlight-provider-status.json
python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path("/tmp/spotlight-provider-status.json").read_text())
mirror = payload.get("manualScrydexMirror", {})
sync = payload.get("scrydexFullCatalogSync", {})
audit = payload.get("scrydexAudit", {})
summary = {
    "fullCatalogSyncFresh": mirror.get("fullCatalogSyncFresh"),
    "searchesBlocked": mirror.get("searchesBlocked"),
    "pricingRefreshBlocked": mirror.get("pricingRefreshBlocked"),
    "lastFullCatalogSyncAt": payload.get("providers", [{}])[0].get("lastFullCatalogSyncAt"),
    "lastSyncStatus": sync.get("status"),
    "scrydexTodayTotal": audit.get("todayTotal"),
    "scrydexRecentSources": audit.get("byRuntimeLabel", [])[:3],
}
print(summary)
PY

if [ -n "$public_base_url" ]; then
  if [ -n "$public_health_host" ]; then
    curl -fsS --max-time 20 --resolve "${public_health_host}:443:127.0.0.1" \
      "$public_health_url" >/tmp/spotlight-public-health.json
  else
    curl -fsS --max-time 20 "$public_health_url" >/tmp/spotlight-public-health.json
  fi
  echo "[$timestamp] public-health ok url=$public_health_url"
fi

echo "[$timestamp] health-check complete"
