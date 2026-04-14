#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

mem_available_mb="$(free -m | awk '/^Mem:/ {print $7}')"
disk_use_pct="$(df -P / | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
load_avg="$(uptime | sed 's/.*load average: //')"

echo "[$timestamp] resource-snapshot begin"
echo "[$timestamp] memAvailableMb=$mem_available_mb diskUsePct=$disk_use_pct loadAvg=$load_avg"

if [ "$mem_available_mb" -lt 256 ]; then
  echo "[$timestamp] WARN low memory available: ${mem_available_mb}MB"
fi

if [ "$disk_use_pct" -ge 80 ]; then
  echo "[$timestamp] WARN disk usage high: ${disk_use_pct}%"
fi

systemctl is-active spotlight-backend.service >/dev/null 2>&1 || echo "[$timestamp] WARN spotlight-backend.service not active"
systemctl is-active caddy >/dev/null 2>&1 || echo "[$timestamp] WARN caddy not active"

tail -n 5 "$SCRIPT_DIR/logs/scrydex_sync.log" 2>/dev/null || true
echo "[$timestamp] resource-snapshot complete"
