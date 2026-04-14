#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-cloudrun}"

case "$TARGET" in
  staging|production)
    ENVIRONMENT="$TARGET"
    SECRETS_FILE="${2:-$SCRIPT_DIR/.env}"
    exec "$SCRIPT_DIR/deploy_to_cloud_run.sh" "$ENVIRONMENT" "$SECRETS_FILE"
    ;;
  cloudrun)
    ENVIRONMENT="${2:-staging}"
    SECRETS_FILE="${3:-$SCRIPT_DIR/.env}"
    exec "$SCRIPT_DIR/deploy_to_cloud_run.sh" "$ENVIRONMENT" "$SECRETS_FILE"
    ;;
  vm)
    ENVIRONMENT="${2:-staging}"
    SECRETS_FILE="${3:-$SCRIPT_DIR/.env}"
    exec "$SCRIPT_DIR/deploy_to_vm.sh" "$ENVIRONMENT" "$SECRETS_FILE"
    ;;
  *)
    echo "Usage:" >&2
    echo "  $0 [staging|production] [secrets-file]" >&2
    echo "  $0 cloudrun [staging|production] [secrets-file]" >&2
    echo "  $0 vm [staging|production] [secrets-file]" >&2
    exit 1
    ;;
esac
