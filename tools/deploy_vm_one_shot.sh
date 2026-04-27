#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

ENVIRONMENT="${1:-staging}"
SECRETS_FILE="${2:-$BACKEND_DIR/.env}"

case "$ENVIRONMENT" in
  staging|production)
    ;;
  *)
    echo "Usage: $0 [staging|production] [secrets-file]" >&2
    exit 1
    ;;
esac

if [ ! -f "$SECRETS_FILE" ]; then
  echo "Missing secrets file: $SECRETS_FILE" >&2
  echo "Create it from backend/.env.secrets.example or point this script at your existing backend secrets file." >&2
  exit 1
fi

cd "$REPO_ROOT"

echo "Deploying backend to VM for $ENVIRONMENT..."
"$BACKEND_DIR/deploy.sh" "$ENVIRONMENT" "$SECRETS_FILE"

echo
echo "Running post-deploy VM health check..."
"$BACKEND_DIR/run_vm_health_check.sh"

echo
echo "Staging deploy finished."
