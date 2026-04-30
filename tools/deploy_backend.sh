#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
AUDIT_SCRIPT="$REPO_ROOT/tools/audit_release_config.py"
MOBILE_ENV_DIR="$REPO_ROOT/apps/spotlight-rn"

usage() {
  cat <<'EOF'
Usage: tools/deploy_backend.sh [staging|production] [backend/.env.<environment>.secrets]

Canonical local entrypoint for backend VM deploys.

Examples:
  bash tools/deploy_backend.sh staging
  bash tools/deploy_backend.sh production backend/.env.production.secrets

For a deploy run directly on the Linux VM host, use backend/deploy.sh instead.
EOF
}

case "${1:-}" in
  -h|--help|help)
    usage
    exit 0
    ;;
esac

ENVIRONMENT="${1:-staging}"

case "$ENVIRONMENT" in
  staging|production)
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac

default_secrets_file() {
  local environment="$1"
  local environment_upper
  environment_upper="$(printf '%s' "$environment" | tr '[:lower:]' '[:upper:]')"
  local environment_key="SPOTLIGHT_BACKEND_${environment_upper}_SECRETS_FILE"
  local environment_override="${!environment_key:-}"
  local generic_override="${SPOTLIGHT_BACKEND_SECRETS_FILE:-}"

  if [ -n "$environment_override" ]; then
    printf '%s\n' "$environment_override"
    return
  fi
  if [ -n "$generic_override" ]; then
    printf '%s\n' "$generic_override"
    return
  fi
  printf '%s/.env.%s.secrets\n' "$BACKEND_DIR" "$environment"
}

default_instance() {
  local environment="$1"
  case "$environment" in
    staging)
      printf '%s\n' "spotlight-backend-vm-small"
      ;;
    production)
      printf '%s\n' ""
      ;;
  esac
}

default_zone() {
  local environment="$1"
  case "$environment" in
    staging)
      printf '%s\n' "us-central1-b"
      ;;
    production)
      printf '%s\n' ""
      ;;
  esac
}

resolve_target_value() {
  local environment="$1"
  local kind="$2"
  local environment_upper
  environment_upper="$(printf '%s' "$environment" | tr '[:lower:]' '[:upper:]')"
  local environment_key="SPOTLIGHT_VM_${environment_upper}_${kind}"
  local generic_key="SPOTLIGHT_VM_${kind}"
  local environment_override="${!environment_key:-}"
  local generic_override="${!generic_key:-}"

  if [ -n "$environment_override" ]; then
    printf '%s\n' "$environment_override"
    return
  fi
  if [ -n "$generic_override" ]; then
    printf '%s\n' "$generic_override"
    return
  fi

  case "$kind" in
    INSTANCE)
      default_instance "$environment"
      ;;
    ZONE)
      default_zone "$environment"
      ;;
    REMOTE_DIR)
      printf '%s\n' "~/spotlight"
      ;;
  esac
}

read_dotenv_value() {
  local file_path="$1"
  local key="$2"
  python3 - "$file_path" "$key" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
target = sys.argv[2]

if not env_path.exists():
    raise SystemExit(0)

for raw_line in env_path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export "):
        line = line[len("export "):].strip()
    if "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key.strip() != target:
        continue
    value = value.strip()
    if value and len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    print(value, end="")
    break
PY
}

gcloud_cmd() {
  if [ -n "${GCLOUD_PROJECT:-}" ]; then
    gcloud --project "$GCLOUD_PROJECT" "$@"
  else
    gcloud "$@"
  fi
}

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required for local VM deploys." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for local VM deploys." >&2
  exit 1
fi

SECRETS_FILE="${2:-$(default_secrets_file "$ENVIRONMENT")}"
if [ ! -f "$SECRETS_FILE" ]; then
  echo "Missing secrets file: $SECRETS_FILE" >&2
  echo "Create it from backend/.env.secrets.example, for example:" >&2
  echo "  cp backend/.env.secrets.example backend/.env.${ENVIRONMENT}.secrets" >&2
  exit 1
fi

INSTANCE="$(resolve_target_value "$ENVIRONMENT" "INSTANCE")"
ZONE="$(resolve_target_value "$ENVIRONMENT" "ZONE")"
REMOTE_DIR="$(resolve_target_value "$ENVIRONMENT" "REMOTE_DIR")"

if [ -z "$INSTANCE" ]; then
  echo "Missing VM instance for $ENVIRONMENT." >&2
  echo "Set SPOTLIGHT_VM_${ENVIRONMENT^^}_INSTANCE or SPOTLIGHT_VM_INSTANCE." >&2
  exit 1
fi

if [ -z "$ZONE" ]; then
  echo "Missing VM zone for $ENVIRONMENT." >&2
  echo "Set SPOTLIGHT_VM_${ENVIRONMENT^^}_ZONE or SPOTLIGHT_VM_ZONE." >&2
  exit 1
fi

GCLOUD_PROJECT="${SPOTLIGHT_GCLOUD_PROJECT:-$(gcloud config get-value core/project 2>/dev/null || true)}"
GCLOUD_PROJECT="$(printf '%s' "$GCLOUD_PROJECT" | tr -d '\n')"
if [ "$GCLOUD_PROJECT" = "(unset)" ]; then
  GCLOUD_PROJECT=""
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/spotlight-vm-deploy.XXXXXX")"
REMOTE_BUNDLE_PATH="/tmp/spotlight-${ENVIRONMENT}-backend-bundle-$$.tgz"
REMOTE_SECRET_PATH="/tmp/spotlight-${ENVIRONMENT}-backend-secrets-$$.env"

cleanup() {
  local exit_code="$1"
  rm -rf "$TMP_DIR"
  if [ -n "${INSTANCE:-}" ] && [ -n "${ZONE:-}" ]; then
    gcloud_cmd compute ssh "$INSTANCE" \
      --zone "$ZONE" \
      --command "rm -f $REMOTE_BUNDLE_PATH $REMOTE_SECRET_PATH" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap 'cleanup $?' EXIT

echo "Running local release config audit for $ENVIRONMENT..."
python3 "$AUDIT_SCRIPT" --environment "$ENVIRONMENT" --backend-secrets-file "$SECRETS_FILE"

BUNDLE_ROOT="$TMP_DIR/backend-root"
mkdir -p "$BUNDLE_ROOT/tools"

COPYFILE_DISABLE=1 tar -C "$BACKEND_DIR" \
  --exclude='./.venv' \
  --exclude='./.env' \
  --exclude='./.env.*.secrets' \
  --exclude='./__pycache__' \
  --exclude='./data' \
  --exclude='./logs' \
  --exclude='./tests/__pycache__' \
  --exclude='./._*' \
  -cf - . | tar -C "$BUNDLE_ROOT" -xf -

COPYFILE_DISABLE=1 tar -C "$REPO_ROOT" \
  --exclude='./tools/__pycache__' \
  --exclude='./tools/.pytest_cache' \
  --exclude='./tools/._*' \
  -cf - tools | tar -C "$BUNDLE_ROOT" -xf -

cp "$AUDIT_SCRIPT" "$BUNDLE_ROOT/tools/audit_release_config.py"
if [ -f "$BACKEND_DIR/data/slab_set_aliases.json" ]; then
  mkdir -p "$BUNDLE_ROOT/data"
  cp "$BACKEND_DIR/data/slab_set_aliases.json" "$BUNDLE_ROOT/data/slab_set_aliases.json"
fi

BUNDLE_ARCHIVE="$TMP_DIR/backend-bundle.tgz"
COPYFILE_DISABLE=1 tar --exclude='./._*' -C "$BUNDLE_ROOT" -czf "$BUNDLE_ARCHIVE" .

echo "Syncing backend bundle to $INSTANCE ($ZONE)..."
gcloud_cmd compute scp "$BUNDLE_ARCHIVE" "$INSTANCE:$REMOTE_BUNDLE_PATH" --zone "$ZONE"
gcloud_cmd compute scp "$SECRETS_FILE" "$INSTANCE:$REMOTE_SECRET_PATH" --zone "$ZONE"

REMOTE_SETUP_COMMAND="mkdir -p $REMOTE_DIR && tar -C $REMOTE_DIR -xzf $REMOTE_BUNDLE_PATH && find $REMOTE_DIR -maxdepth 1 -name '._*' -delete"
echo "Extracting bundle on the VM..."
gcloud_cmd compute ssh "$INSTANCE" --zone "$ZONE" --command "$REMOTE_SETUP_COMMAND"

REMOTE_DEPLOY_COMMAND="cd $REMOTE_DIR && bash deploy.sh $ENVIRONMENT $REMOTE_SECRET_PATH"
echo "Running VM-local deploy..."
gcloud_cmd compute ssh "$INSTANCE" --zone "$ZONE" --command "$REMOTE_DEPLOY_COMMAND"

REMOTE_HEALTH_COMMAND="cd $REMOTE_DIR && bash run_vm_health_check.sh"
echo "Running post-deploy VM health check..."
gcloud_cmd compute ssh "$INSTANCE" --zone "$ZONE" --command "$REMOTE_HEALTH_COMMAND"

PUBLIC_BASE_URL="$(read_dotenv_value "$MOBILE_ENV_DIR/.env.$ENVIRONMENT" "EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL")"
if [ -n "$PUBLIC_BASE_URL" ]; then
  echo "Running public health check against ${PUBLIC_BASE_URL%/}/api/v1/health..."
  curl -fsS --max-time 20 "${PUBLIC_BASE_URL%/}/api/v1/health" >/dev/null
fi

echo
echo "Deploy finished."
echo "Environment: $ENVIRONMENT"
echo "Instance: $INSTANCE"
echo "Zone: $ZONE"
echo "Remote dir: $REMOTE_DIR"
