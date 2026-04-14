#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
SUPERVISOR_LOG="$LOG_DIR/backend-supervisor.log"
BACKEND_LOG="$LOG_DIR/backend.log"

mkdir -p "$LOG_DIR"

while true; do
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "[$timestamp] starting backend" >> "$SUPERVISOR_LOG"

  if "$SCRIPT_DIR/run_backend_vm.sh" >> "$BACKEND_LOG" 2>&1; then
    timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo "[$timestamp] backend exited cleanly; restarting in 5s" >> "$SUPERVISOR_LOG"
  else
    exit_code="$?"
    timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo "[$timestamp] backend exited with code $exit_code; restarting in 5s" >> "$SUPERVISOR_LOG"
  fi

  sleep 5
done
