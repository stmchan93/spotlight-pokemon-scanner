#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-staging}"

if [ "$(uname -s)" != "Linux" ]; then
  echo "backend/deploy.sh is a VM-local deploy script." >&2
  echo "Run it on the Linux VM host, or use tools/deploy_vm_one_shot.sh from your local machine." >&2
  exit 1
fi

case "$TARGET" in
  staging|production)
    ENVIRONMENT="$TARGET"
    SECRETS_FILE="${2:-$SCRIPT_DIR/.env.$ENVIRONMENT.secrets}"
    exec "$SCRIPT_DIR/deploy_to_vm.sh" "$ENVIRONMENT" "$SECRETS_FILE"
    ;;
  vm)
    ENVIRONMENT="${2:-staging}"
    SECRETS_FILE="${3:-$SCRIPT_DIR/.env.$ENVIRONMENT.secrets}"
    exec "$SCRIPT_DIR/deploy_to_vm.sh" "$ENVIRONMENT" "$SECRETS_FILE"
    ;;
  *)
    echo "Usage:" >&2
    echo "  $0 [staging|production] [backend/.env.<environment>.secrets]" >&2
    echo "  $0 vm [staging|production] [backend/.env.<environment>.secrets]" >&2
    exit 1
    ;;
esac
