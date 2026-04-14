#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_CONFIG_FILE="${SPOTLIGHT_VM_RUNTIME_CONFIG:-$SCRIPT_DIR/.vm-runtime.conf}"

if [ -f "$RUNTIME_CONFIG_FILE" ]; then
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
fi

PYTHON_BIN="${SPOTLIGHT_VM_PYTHON:-python3}"
HOST="${SPOTLIGHT_HOST:-127.0.0.1}"
PORT="${SPOTLIGHT_PORT:-8788}"
URL="http://${HOST}:${PORT}/api/v1/health?prewarm=visual"

for attempt in $(seq 1 60); do
  if "$PYTHON_BIN" - "$URL" <<'PY'
import json
import sys
import urllib.request

url = sys.argv[1]
with urllib.request.urlopen(url, timeout=30) as response:
    payload = json.load(response)

visual_runtime = payload.get("visualRuntime") or {}
if visual_runtime.get("available") is not True:
    raise SystemExit(1)
PY
  then
    echo "Visual runtime prewarm succeeded on attempt ${attempt}."
    exit 0
  fi
  sleep 1
done

echo "Visual runtime prewarm failed after 60 attempts." >&2
exit 1
