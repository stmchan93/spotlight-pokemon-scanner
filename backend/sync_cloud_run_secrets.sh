#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETS_FILE="${1:-$SCRIPT_DIR/.env}"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "Secrets source file not found: $SECRETS_FILE" >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI not found. Install Google Cloud SDK first." >&2
  exit 1
fi

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  echo "No Google Cloud project configured." >&2
  echo "Set GOOGLE_CLOUD_PROJECT or run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SERVICE_ACCOUNT="${CLOUD_RUN_SERVICE_ACCOUNT:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"

read_dotenv_value() {
  local key="$1"
  python3 - "$SECRETS_FILE" "$key" <<'PY'
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

SECRET_NAMES=(
  POKEMONTCG_API_KEY
  SCRYDEX_API_KEY
  SCRYDEX_TEAM_ID
  PRICECHARTING_API_KEY
)

REQUIRED_SECRET_NAMES=(
  POKEMONTCG_API_KEY
  SCRYDEX_API_KEY
  SCRYDEX_TEAM_ID
)

echo "Syncing Cloud Run secrets"
echo "  Project: $PROJECT_ID"
echo "  Secrets file: $SECRETS_FILE"
echo "  Runtime service account: $SERVICE_ACCOUNT"
echo ""

echo "Ensuring Secret Manager API is enabled..."
gcloud services enable secretmanager.googleapis.com \
  --project "$PROJECT_ID" \
  --quiet
echo "Secret Manager API ready"
echo ""

for secret_name in "${REQUIRED_SECRET_NAMES[@]}"; do
  secret_value="$(read_dotenv_value "$secret_name")"
  if [ -z "$secret_value" ]; then
    echo "Missing required secret in $SECRETS_FILE: $secret_name" >&2
    exit 1
  fi
done

for secret_name in "${SECRET_NAMES[@]}"; do
  secret_value="$(read_dotenv_value "$secret_name")"
  if [ -z "${secret_value:-}" ]; then
    continue
  fi

  echo "Checking secret: $secret_name"

  if gcloud secrets describe "$secret_name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "Updating secret: $secret_name"
  else
    echo "Creating secret: $secret_name"
    gcloud secrets create "$secret_name" \
      --project "$PROJECT_ID" \
      --replication-policy automatic \
      --quiet
  fi

  echo "Uploading latest secret version: $secret_name"
  printf '%s' "$secret_value" | gcloud secrets versions add "$secret_name" \
    --project "$PROJECT_ID" \
    --data-file=-

  echo "Granting runtime access: $secret_name"
  gcloud secrets add-iam-policy-binding "$secret_name" \
    --project "$PROJECT_ID" \
    --member "serviceAccount:$SERVICE_ACCOUNT" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null
done

echo ""
echo "Secret Manager sync complete for project: $PROJECT_ID"
echo "Runtime service account: $SERVICE_ACCOUNT"
