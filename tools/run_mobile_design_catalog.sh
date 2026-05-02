#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${REPO_ROOT}/apps/spotlight-rn"

usage() {
  cat <<'EOF'
Usage:
  bash tools/run_mobile_design_catalog.sh [--print-only] [expo-start-args...]

What it does:
  - prints the Claude design workflow entrypoints for this repo
  - optionally starts Expo from apps/spotlight-rn

Useful paths:
  - design-system route: spotlight://design-system
  - Expo route path: /design-system
  - bundle generator: pnpm claude:design:bundle
EOF
}

print_only=0
forward_args=()

while (($# > 0)); do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --print-only)
      print_only=1
      shift
      ;;
    *)
      forward_args+=("$1")
      shift
      ;;
  esac
done

cat <<EOF
Claude design setup is ready.

Next steps:
  1. Generate the handoff bundle:
     pnpm claude:design:bundle

  2. Start the RN app and open the design-system catalog:
     spotlight://design-system

  3. Capture screenshots for:
     - design system
     - scanner
     - portfolio
     - inventory
     - card detail
     - add card
EOF

if [[ "${print_only}" == "1" ]]; then
  exit 0
fi

cd "${APP_DIR}"
if ((${#forward_args[@]} > 0)); then
  exec pnpm start "${forward_args[@]}"
fi

exec pnpm start
