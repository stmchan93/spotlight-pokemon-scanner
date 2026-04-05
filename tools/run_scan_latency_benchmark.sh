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
CARDS_FILE="${SPOTLIGHT_BENCHMARK_CARDS_FILE:-$ROOT_DIR/backend/catalog/pokemontcg/cards.json}"
DATABASE_PATH="${SPOTLIGHT_BENCHMARK_DATABASE_PATH:-$ROOT_DIR/backend/data/imported_scanner.sqlite}"

cd "$ROOT_DIR"

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ -z "${SPOTLIGHT_SCANNER_SERVER:-}" ]]; then
  python3 backend/server.py \
    --cards-file "$CARDS_FILE" \
    --database-path "$DATABASE_PATH" \
    --skip-seed \
    --port "$PORT" \
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
swiftc -module-cache-path .swift-module-cache tools/scanner_eval.swift -o ./.scanner_eval
./.scanner_eval --benchmark-manifest "$MANIFEST_PATH" --iterations "$ITERATIONS" --server "$SERVER_URL"
