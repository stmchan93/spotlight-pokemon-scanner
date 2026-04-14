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

ENV_FILE="$SCRIPT_DIR/.env.$ENVIRONMENT"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

if [ ! -f "$SECRETS_FILE" ]; then
  echo "Missing secrets file: $SECRETS_FILE" >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI not found. Install Google Cloud SDK first." >&2
  exit 1
fi

ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
if [ -z "$ACTIVE_ACCOUNT" ]; then
  echo "No active gcloud account. Run: gcloud auth login" >&2
  exit 1
fi

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  echo "No Google Cloud project configured." >&2
  echo "Set GOOGLE_CLOUD_PROJECT or run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

REGION="${GOOGLE_CLOUD_REGION:-us-central1}"
SERVICE_NAME="${CLOUD_RUN_SERVICE_NAME:-spotlight-backend}"
MEMORY="${CLOUD_RUN_MEMORY:-1Gi}"
CPU="${CLOUD_RUN_CPU:-1}"
TIMEOUT_SECONDS="${CLOUD_RUN_TIMEOUT_SECONDS:-300}"
MAX_INSTANCES="${CLOUD_RUN_MAX_INSTANCES:-10}"
MIN_INSTANCES="${CLOUD_RUN_MIN_INSTANCES:-0}"

read_dotenv_value() {
  local file_path="$1"
  local key="$2"
  python3 - "$file_path" "$key" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
target = sys.argv[2]

for raw_line in env_path.read_text().splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    key = key.strip()
    if key != target:
        continue
    value = value.strip()
    if value and len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    print(value, end="")
    break
PY
}

REQUIRED_ENV_KEYS=(
  SCRYDEX_API_KEY
  SCRYDEX_TEAM_ID
)

for key in "${REQUIRED_ENV_KEYS[@]}"; do
  value="$(read_dotenv_value "$SECRETS_FILE" "$key")"
  if [ -z "$value" ]; then
    echo "Missing required value in $SECRETS_FILE: $key" >&2
    exit 1
  fi
done

TMP_ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/spotlight-cloudrun-env.XXXXXX")"
cleanup() {
  rm -f "$TMP_ENV_FILE"
}
trap cleanup EXIT

python3 - "$ENV_FILE" "$SECRETS_FILE" "$TMP_ENV_FILE" <<'PY'
from pathlib import Path
import sys

base_file = Path(sys.argv[1])
secrets_file = Path(sys.argv[2])
output_file = Path(sys.argv[3])

allowed_secret_keys = {
    "SCRYDEX_API_KEY",
    "SCRYDEX_TEAM_ID",
    "PRICECHARTING_API_KEY",
}

merged: dict[str, str] = {}

def load_env(path: Path, allowed: set[str] | None = None) -> None:
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if allowed is not None and key not in allowed:
            continue
        value = value.strip()
        if value and len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        merged[key] = value

load_env(base_file)
load_env(secrets_file, allowed_secret_keys)

def quote_yaml(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'

output_file.write_text("".join(f"{key}: {quote_yaml(value)}\n" for key, value in merged.items()))
PY

echo "Deploying Spotlight backend"
echo "  Environment: $ENVIRONMENT"
echo "  Project: $PROJECT_ID"
echo "  Region: $REGION"
echo "  Service: $SERVICE_NAME"
echo "  Env file: $ENV_FILE"
echo "  Secrets file: $SECRETS_FILE"
echo ""

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project "$PROJECT_ID" \
  --quiet

gcloud run deploy "$SERVICE_NAME" \
  --source "$SCRIPT_DIR" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --memory "$MEMORY" \
  --cpu "$CPU" \
  --timeout "${TIMEOUT_SECONDS}s" \
  --max-instances "$MAX_INSTANCES" \
  --min-instances "$MIN_INSTANCES" \
  --env-vars-file "$TMP_ENV_FILE" \
  --quiet

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format='value(status.url)')"

echo ""
echo "Deployment complete"
echo "  URL: $SERVICE_URL"
echo "  Health: $SERVICE_URL/api/v1/health"
echo ""
echo "Next checks:"
echo "  curl $SERVICE_URL/api/v1/health"
echo "  curl $SERVICE_URL/api/v1/ops/provider-status"
