#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENVIRONMENT="${1:-staging}"
SECRETS_FILE="${2:-$SCRIPT_DIR/.env}"

case "$ENVIRONMENT" in
  staging|production)
    ;;
  *)
    echo "Usage: $0 [staging|production] [secrets-file]" >&2
    exit 1
    ;;
esac

exec "$SCRIPT_DIR/deploy_to_cloud_run.sh" "$ENVIRONMENT" "$SECRETS_FILE"
