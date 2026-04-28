#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BACKEND_PORT="${SPOTLIGHT_PORT:-8788}"
BACKEND_HOST="${SPOTLIGHT_HOST:-0.0.0.0}"
DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$REPO_ROOT/backend/data/spotlight_scanner.sqlite}"
HEALTH_URL="http://127.0.0.1:${BACKEND_PORT}/api/v1/health"
EXPO_PORT_BASE="${SPOTLIGHT_EXPO_PORT:-8081}"

mode="all"
expo_launch_mode="go"

usage() {
  cat <<'EOF'
Usage:
  zsh tools/start_mobile_phone_dev.sh
  zsh tools/start_mobile_phone_dev.sh --backend-only
  zsh tools/start_mobile_phone_dev.sh --frontend-only
  zsh tools/start_mobile_phone_dev.sh --dev-client

Environment overrides:
  SPOTLIGHT_PHONE_IP        Force the LAN IP Expo should use for the backend base URL.
  SPOTLIGHT_HOST            Backend bind host. Defaults to 0.0.0.0 for phone testing.
  SPOTLIGHT_PORT            Backend port. Defaults to 8788.
  SPOTLIGHT_DATABASE_PATH   SQLite path. Defaults to backend/data/spotlight_scanner.sqlite.
  SPOTLIGHT_PYTHON_BIN      Python binary for the backend. Defaults to backend/.venv/bin/python, then python3.
EOF
}

if [[ $# -gt 2 ]]; then
  usage >&2
  exit 1
fi

for arg in "$@"; do
  case "$arg" in
    --backend-only)
      mode="backend"
      ;;
    --frontend-only)
      mode="frontend"
      ;;
    --dev-client)
      expo_launch_mode="dev-client"
      ;;
    --go)
      expo_launch_mode="go"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

detect_lan_ip() {
  if [[ -n "${SPOTLIGHT_PHONE_IP:-}" ]]; then
    printf '%s\n' "$SPOTLIGHT_PHONE_IP"
    return 0
  fi

  local default_interface=""
  default_interface="$(route -n get default 2>/dev/null | awk '/interface: / { print $2; exit }')"

  if [[ -n "$default_interface" ]]; then
    local detected_ip=""
    detected_ip="$(ipconfig getifaddr "$default_interface" 2>/dev/null || true)"
    if [[ -n "$detected_ip" ]]; then
      printf '%s\n' "$detected_ip"
      return 0
    fi
  fi

  local fallback_interface=""
  for fallback_interface in en0 en1 en2; do
    local fallback_ip=""
    fallback_ip="$(ipconfig getifaddr "$fallback_interface" 2>/dev/null || true)"
    if [[ -n "$fallback_ip" ]]; then
      printf '%s\n' "$fallback_ip"
      return 0
    fi
  done

  return 1
}

resolve_python_bin() {
  if [[ -n "${SPOTLIGHT_PYTHON_BIN:-}" ]]; then
    printf '%s\n' "$SPOTLIGHT_PYTHON_BIN"
    return 0
  fi

  if [[ -x "$REPO_ROOT/backend/.venv/bin/python" ]]; then
    printf '%s\n' "$REPO_ROOT/backend/.venv/bin/python"
    return 0
  fi

  printf '%s\n' "python3"
}

port_is_available() {
  local port="$1"
  ! lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

resolve_expo_port() {
  local port="$EXPO_PORT_BASE"

  while [[ "$port" -le $((EXPO_PORT_BASE + 20)) ]]; do
    if port_is_available "$port"; then
      printf '%s\n' "$port"
      return 0
    fi
    port=$((port + 1))
  done

  echo "Could not find a free Expo port starting at ${EXPO_PORT_BASE}." >&2
  exit 1
}

print_runtime_banner() {
  local lan_ip="$1"
  local api_base_url="http://${lan_ip}:${BACKEND_PORT}"

  cat <<EOF
Looty phone dev config
  backend health: ${HEALTH_URL}
  backend LAN URL: ${api_base_url}
  backend host: ${BACKEND_HOST}
  database path: ${DATABASE_PATH}
  Expo port: ${EXPO_PORT}

Important:
  - The React Native app will use this local backend over your LAN.
  - The Expo QR is for opening the RN app in Expo Go or a dev client. Do not scan that QR with the in-app card scanner.
  - If scans fail, watch this terminal for backend tracebacks and the Expo terminal for RN scanner logs.
EOF
}

wait_for_backend() {
  local attempts=0

  while [[ $attempts -lt 45 ]]; do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done

  return 1
}

PYTHON_BIN="$(resolve_python_bin)"
LAN_IP="$(detect_lan_ip || true)"
EXPO_PORT="$(resolve_expo_port)"

if [[ -z "$LAN_IP" ]]; then
  echo "Could not detect a LAN IP for physical-device testing." >&2
  echo "Set SPOTLIGHT_PHONE_IP manually, for example: SPOTLIGHT_PHONE_IP=192.168.1.23" >&2
  exit 1
fi

print_runtime_banner "$LAN_IP"

backend_pid=""

cleanup() {
  if [[ -n "$backend_pid" ]]; then
    kill "$backend_pid" >/dev/null 2>&1 || true
    wait "$backend_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

if [[ "$mode" == "backend" ]]; then
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo ""
    echo "Backend already healthy on port ${BACKEND_PORT}. Reusing the existing process."
    exit 0
  fi

  exec "$PYTHON_BIN" "$REPO_ROOT/backend/server.py" \
    --database-path "$DATABASE_PATH" \
    --host "$BACKEND_HOST" \
    --port "$BACKEND_PORT"
fi

if [[ "$mode" == "all" ]]; then
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo ""
    echo "Backend already healthy on port ${BACKEND_PORT}. Reusing the existing process."
  else
    echo ""
    echo "Starting backend for phone testing..."
    "$PYTHON_BIN" "$REPO_ROOT/backend/server.py" \
      --database-path "$DATABASE_PATH" \
      --host "$BACKEND_HOST" \
      --port "$BACKEND_PORT" &
    backend_pid=$!

    if ! wait_for_backend; then
      echo "Backend did not become healthy at ${HEALTH_URL}" >&2
      exit 1
    fi
  fi
fi

if [[ "$mode" == "frontend" ]] && ! curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  echo ""
  echo "Warning: backend is not healthy at ${HEALTH_URL}." >&2
  echo "Start it with: pnpm backend:start:phone" >&2
fi

echo ""
if [[ "$expo_launch_mode" == "dev-client" ]]; then
  echo "Starting Expo in dev-client mode with EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL=http://${LAN_IP}:${BACKEND_PORT}"
else
  echo "Starting Expo in Expo Go mode with EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL=http://${LAN_IP}:${BACKEND_PORT}"
  echo "Open the QR with the iPhone Camera app or Expo Go. Do not use the app's scanner surface."
fi

cd "$REPO_ROOT"
EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL="http://${LAN_IP}:${BACKEND_PORT}" \
  pnpm --filter @spotlight/mobile-app start -- --clear --"${expo_launch_mode}" --port "${EXPO_PORT}"
