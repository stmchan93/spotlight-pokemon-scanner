#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "tools/deploy_vm_one_shot.sh is deprecated. Use tools/deploy_backend.sh instead." >&2
exec bash "$SCRIPT_DIR/deploy_backend.sh" "$@"
