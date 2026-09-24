#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_CONFIG_FILE="${SPOTLIGHT_VM_RUNTIME_CONFIG:-$SCRIPT_DIR/.vm-runtime.conf}"

if [ ! -f "$RUNTIME_CONFIG_FILE" ]; then
  echo "Missing VM runtime config: $RUNTIME_CONFIG_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$RUNTIME_CONFIG_FILE"
if [ -n "${SPOTLIGHT_RUNTIME_ENV_FILE:-}" ] && [ -f "${SPOTLIGHT_RUNTIME_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${SPOTLIGHT_RUNTIME_ENV_FILE}"
fi
if [ -n "${SPOTLIGHT_SECRETS_FILE:-}" ] && [ -f "${SPOTLIGHT_SECRETS_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${SPOTLIGHT_SECRETS_FILE}"
fi
# Re-apply runtime config last so VM-specific overrides win over staged defaults.
# shellcheck disable=SC1090
. "$RUNTIME_CONFIG_FILE"
set +a

# PDP "More like this" neighbours (similar_cards.py). Daily via the
# deploy_to_vm.sh crontab, in its OWN process — never inside the server. Reads
# the active per-game visual indexes (same env overrides as the matcher) and
# replaces each game's card_similar rows in one short transaction. Same flag as
# the endpoint, so the cron line is a no-op until the env turns it on.
case "$(printf '%s' "${SIMILAR_CARDS_ENABLED:-0}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ;;
  *)
    echo "[similar-cards] $(date -u +"%Y-%m-%dT%H:%M:%SZ") SIMILAR_CARDS_ENABLED is off; skipping"
    exit 0
    ;;
esac

PYTHON_BIN="${SPOTLIGHT_VM_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"
DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$SCRIPT_DIR/data/spotlight_scanner.sqlite}"
HOSTNAME_VALUE="$(hostname -s 2>/dev/null || hostname)"
export SPOTLIGHT_RUNTIME_LABEL="${SPOTLIGHT_RUNTIME_LABEL:-vm-similar-cards:${HOSTNAME_VALUE}}"

echo "[similar-cards] $(date -u +"%Y-%m-%dT%H:%M:%SZ") computing"
# "$@" forwards manual flags; the cron passes none.
cd "$SCRIPT_DIR"
# One BLAS thread + low priority: the live server keeps its CPUs for scans.
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}" OPENBLAS_NUM_THREADS="${OPENBLAS_NUM_THREADS:-1}" MKL_NUM_THREADS="${MKL_NUM_THREADS:-1}"
nice -n 10 "$PYTHON_BIN" "$SCRIPT_DIR/similar_cards.py" --database-path "$DATABASE_PATH" --repo-root "$(cd "$SCRIPT_DIR/.." && pwd)" "$@"
