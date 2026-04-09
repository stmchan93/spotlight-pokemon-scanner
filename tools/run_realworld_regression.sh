#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST_PATH="${1:-$ROOT_DIR/qa/scanner-regression.realworld-2026-04-03.json}"
PORT="${SPOTLIGHT_REALWORLD_SCANNER_PORT:-}"
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
DATABASE_PATH="${SPOTLIGHT_REALWORLD_DATABASE_PATH:-$ROOT_DIR/backend/data/spotlight_scanner.sqlite}"
SLAB_SALES_FILE="${SPOTLIGHT_REALWORLD_SLAB_SALES_FILE:-$ROOT_DIR/backend/catalog/slab_sales.sample.json}"

cd "$ROOT_DIR"

if [[ -f "$SLAB_SALES_FILE" ]]; then
  python3 backend/import_slab_sales.py \
    --file "$SLAB_SALES_FILE" \
    --database-path "$DATABASE_PATH" \
    > /tmp/spotlight-realworld-regression-slab-import.log 2>&1 || true
fi

SERVER_ARGS=()
if [[ -n "${SPOTLIGHT_REALWORLD_CATALOG_FILE:-}" ]]; then
  SERVER_ARGS+=(--cards-file "${SPOTLIGHT_REALWORLD_CATALOG_FILE}")
fi

python3 backend/server.py \
  --database-path "$DATABASE_PATH" \
  --skip-seed \
  --port "$PORT" \
  "${SERVER_ARGS[@]}" \
  > /tmp/spotlight-realworld-regression-server.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in {1..30}; do
  if curl -sf "$SERVER_URL"api/v1/health >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -sf "$SERVER_URL"api/v1/health >/dev/null; then
  echo "Failed to start imported scanner backend for real-world regression." >&2
  exit 1
fi

mkdir -p .swift-module-cache
swiftc \
  -module-cache-path .swift-module-cache \
  Spotlight/Services/SlabLabelParsing.swift \
  tools/scanner_eval.swift \
  -o ./.scanner_eval
./.scanner_eval --manifest "$MANIFEST_PATH" --server "$SERVER_URL"
