#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST_PATH="${1:-$ROOT_DIR/qa/scanner-regression.realworld-2026-04-03.json}"
ITERATIONS="${SPOTLIGHT_BENCHMARK_ITERATIONS:-3}"
PORT="${SPOTLIGHT_BENCHMARK_PORT:-}"
if [[ -z "$PORT" ]]; then
  PORT="$(
    python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
  )"
fi
SERVER_URL="${SPOTLIGHT_SCANNER_SERVER:-http://127.0.0.1:${PORT}/}"
DATABASE_PATH="${SPOTLIGHT_BENCHMARK_DATABASE_PATH:-$ROOT_DIR/backend/data/spotlight_scanner.sqlite}"
MAX_TOTAL_MS="${SPOTLIGHT_BENCHMARK_MAX_TOTAL_MS:-}"
MAX_TOTAL_P95_MS="${SPOTLIGHT_BENCHMARK_MAX_TOTAL_P95_MS:-}"

cd "$ROOT_DIR"

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ -z "${SPOTLIGHT_SCANNER_SERVER:-}" ]]; then
  SERVER_ARGS=()
  if [[ -n "${SPOTLIGHT_BENCHMARK_CATALOG_FILE:-}" ]]; then
    SERVER_ARGS+=(--cards-file "${SPOTLIGHT_BENCHMARK_CATALOG_FILE}")
  fi

  python3 backend/server.py \
    --database-path "$DATABASE_PATH" \
    --skip-seed \
    --port "$PORT" \
    "${SERVER_ARGS[@]}" \
    > /tmp/spotlight-benchmark-server.log 2>&1 &
  SERVER_PID=$!

  for _ in {1..30}; do
    if curl -sf "$SERVER_URL"api/v1/health >/dev/null; then
      break
    fi
    sleep 1
  done

  if ! curl -sf "$SERVER_URL"api/v1/health >/dev/null; then
    echo "Failed to start scanner backend for latency benchmark." >&2
    exit 1
  fi
fi

mkdir -p .swift-module-cache
swiftc \
  -module-cache-path .swift-module-cache \
  Spotlight/Services/SlabLabelParsing.swift \
  tools/scanner_eval.swift \
  -o ./.scanner_eval
BENCHMARK_ARGS=(--benchmark-manifest "$MANIFEST_PATH" --iterations "$ITERATIONS" --server "$SERVER_URL")
if [[ -n "$MAX_TOTAL_MS" ]]; then
  BENCHMARK_ARGS+=(--max-total-ms "$MAX_TOTAL_MS")
fi
if [[ -n "$MAX_TOTAL_P95_MS" ]]; then
  BENCHMARK_ARGS+=(--max-total-p95-ms "$MAX_TOTAL_P95_MS")
fi
./.scanner_eval "${BENCHMARK_ARGS[@]}"
