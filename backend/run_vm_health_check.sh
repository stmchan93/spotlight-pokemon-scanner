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

# Fail (and so withhold the alert ping) when the backend is bloating, well before
# MemoryMax kills it. The 2026-11-15 hang started from slow growth to 13GB.
backend_pid="$(systemctl show -p MainPID --value spotlight-backend.service 2>/dev/null || echo 0)"
if [ "${backend_pid:-0}" != "0" ]; then
  backend_rss_mb="$(( $(ps -o rss= -p "$backend_pid" 2>/dev/null || echo 0) / 1024 ))"
  mem_total_mb="$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))"
  rss_limit_mb="${SPOTLIGHT_HEALTH_RSS_LIMIT_MB:-$(( mem_total_mb * 65 / 100 ))}"
  echo "[$timestamp] backend-rss ${backend_rss_mb}MB limit=${rss_limit_mb}MB"
  if [ "$backend_rss_mb" -gt "$rss_limit_mb" ]; then
    echo "[$timestamp] backend-rss over limit" >&2
    exit 1
  fi
fi

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

# TCGplayer prices come from the daily TCGCSV sync; a missed or failed day
# fails the check, which withholds the dead-man's-switch ping below.
tcgcsv = payload.get("tcgcsvPriceSync") or {}
print({"tcgcsvPriceSync": {k: tcgcsv.get(k) for k in ("enabled", "lastSucceededAt", "hoursSinceSuccess", "fresh")}})
if tcgcsv and not tcgcsv.get("fresh"):
    raise SystemExit("tcgcsv price sync is stale")
PY

# Real end-to-end scan (2026-11-15: /health answered while scans hung for hours).
# At most one scan per 15 min after a pass; a failure retries every tick. The
# probe uses the server's synthetic lane: nothing persisted, no provider spend.
# Skips (passes) until SPOTLIGHT_SYNTHETIC_SCAN_TOKEN is set in runtime secrets.
timeout 45 python3 "$SCRIPT_DIR/synthetic_scan_probe.py" \
  --base-url "$local_base_url" \
  --state-file "${SPOTLIGHT_SYNTHETIC_SCAN_STATE_FILE:-/tmp/spotlight-synthetic-scan.last-ok}" \
  | sed "s/^/[$timestamp] /"

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

# Dead-man's-switch ping (e.g. Healthchecks.io). This line is only reached when
# EVERY check above passed, because `set -euo pipefail` + `curl -fsS` abort the
# script on any failure. A missed ping — a failed check, the cron not running, or
# the whole VM being down — is what trips the external alert. No-op until
# SPOTLIGHT_HEALTHCHECK_PING_URL is set in the runtime env/secrets.
if [ -n "${SPOTLIGHT_HEALTHCHECK_PING_URL:-}" ]; then
  if curl -fsS --max-time 10 "$SPOTLIGHT_HEALTHCHECK_PING_URL" >/dev/null 2>&1; then
    echo "[$timestamp] healthcheck-ping ok"
  else
    echo "[$timestamp] healthcheck-ping failed (non-fatal)" >&2
  fi
fi
