#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
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

SECRETS_FILE="$(cd "$(dirname "$SECRETS_FILE")" && pwd)/$(basename "$SECRETS_FILE")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required on the VM." >&2
  exit 1
fi

if ! command -v crontab >/dev/null 2>&1; then
  echo "crontab is required on the VM." >&2
  exit 1
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required on the VM." >&2
  echo "On Ubuntu/Debian install util-linux." >&2
  exit 1
fi

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

read_first_dotenv_value() {
  local key="$1"
  shift
  local candidate_file=""
  local value=""

  for candidate_file in "$@"; do
    if [ -z "$candidate_file" ] || [ ! -f "$candidate_file" ]; then
      continue
    fi
    value="$(read_dotenv_value "$candidate_file" "$key")"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return
    fi
  done
}

env_flag_enabled() {
  local raw_value="${1:-}"
  case "${raw_value,,}" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_vm_repo_path() {
  local raw_path="${1:-}"
  if [ -z "$raw_path" ]; then
    printf '%s' ""
    return
  fi

  if [[ "$raw_path" = /* ]]; then
    printf '%s' "$raw_path"
    return
  fi

  if [ -e "$SCRIPT_DIR/$raw_path" ]; then
    printf '%s' "$SCRIPT_DIR/$raw_path"
    return
  fi

  if [[ "$raw_path" == backend/* ]]; then
    local stripped_path="${raw_path#backend/}"
    if [ -e "$SCRIPT_DIR/$stripped_path" ]; then
      printf '%s' "$SCRIPT_DIR/$stripped_path"
      return
    fi
  fi

  printf '%s' "$raw_path"
}

stage_runtime_data_file() {
  local relative_target_path="$1"
  shift

  local target_path="$DATA_DIR/$relative_target_path"
  local source_path=""
  local candidate_path=""

  mkdir -p "$(dirname "$target_path")"

  for candidate_path in "$@"; do
    if [ -n "$candidate_path" ] && [ -f "$candidate_path" ]; then
      source_path="$candidate_path"
      break
    fi
  done

  if [ -z "$source_path" ]; then
    if [ -f "$target_path" ]; then
      return
    fi
    echo "Missing required runtime data file: $relative_target_path" >&2
    echo "Checked candidate paths:" >&2
    for candidate_path in "$@"; do
      if [ -n "$candidate_path" ]; then
        echo "  $candidate_path" >&2
      fi
    done
    exit 1
  fi

  if [ "$source_path" != "$target_path" ]; then
    cp "$source_path" "$target_path"
  fi
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

EBAY_BROWSE_ENABLED_VALUE="$(read_first_dotenv_value "SPOTLIGHT_EBAY_BROWSE_ENABLED" "$ENV_FILE" "$SECRETS_FILE")"
if env_flag_enabled "$EBAY_BROWSE_ENABLED_VALUE"; then
  for key in EBAY_CLIENT_ID EBAY_CLIENT_SECRET; do
    value="$(read_first_dotenv_value "$key" "$SECRETS_FILE" "$ENV_FILE")"
    if [ -z "$value" ]; then
      echo "eBay Browse is enabled, but $key is missing from $SECRETS_FILE or $ENV_FILE." >&2
      exit 1
    fi
  done
fi

VENV_DIR="$SCRIPT_DIR/.venv"
LOG_DIR="$SCRIPT_DIR/logs"
DATA_DIR="$SCRIPT_DIR/data"
DATABASE_PATH="$DATA_DIR/spotlight_scanner.sqlite"
RUNTIME_CONFIG_FILE="$SCRIPT_DIR/.vm-runtime.conf"
FLOCK_BIN="$(command -v flock)"
SYNC_LOCK_FILE="$DATA_DIR/scrydex-sync.lock"
SYNC_LOG_FILE="$LOG_DIR/scrydex_sync.log"
HEALTH_MONITOR_LOG_FILE="$LOG_DIR/health_monitor.log"
RESOURCE_MONITOR_LOG_FILE="$LOG_DIR/resource_monitor.log"
TORCH_CPU_INDEX_URL="${SPOTLIGHT_VM_TORCH_INDEX_URL:-https://download.pytorch.org/whl/cpu}"
TORCH_PACKAGE_SPEC="${SPOTLIGHT_VM_TORCH_PACKAGE_SPEC:-torch==2.11.0+cpu}"
SYNC_CRON_SCHEDULE="${SPOTLIGHT_VM_SYNC_CRON:-0 3 * * *}"
SYNC_CRON_TIMEZONE="${SPOTLIGHT_VM_SYNC_CRON_TZ:-America/Los_Angeles}"
BACKEND_HOST="${SPOTLIGHT_VM_BACKEND_HOST:-127.0.0.1}"
PUBLIC_BASE_URL="${SPOTLIGHT_VM_PUBLIC_BASE_URL:-}"
HEALTH_CRON_SCHEDULE="${SPOTLIGHT_VM_HEALTH_CRON:-*/5 * * * *}"
RESOURCE_CRON_SCHEDULE="${SPOTLIGHT_VM_RESOURCE_CRON:-*/15 * * * *}"
VISUAL_INDEX_NPZ_PATH="$(normalize_vm_repo_path "$(read_dotenv_value "$ENV_FILE" "SPOTLIGHT_VISUAL_INDEX_NPZ_PATH")")"
VISUAL_INDEX_MANIFEST_PATH="$(normalize_vm_repo_path "$(read_dotenv_value "$ENV_FILE" "SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH")")"
VISUAL_ADAPTER_CHECKPOINT_PATH="$(normalize_vm_repo_path "$(read_dotenv_value "$ENV_FILE" "SPOTLIGHT_VISUAL_ADAPTER_CHECKPOINT_PATH")")"
VISUAL_ADAPTER_METADATA_PATH="$(normalize_vm_repo_path "$(read_dotenv_value "$ENV_FILE" "SPOTLIGHT_VISUAL_ADAPTER_METADATA_PATH")")"
SCAN_ARTIFACTS_STORAGE="$(read_dotenv_value "$ENV_FILE" "SPOTLIGHT_SCAN_ARTIFACTS_STORAGE")"
SCAN_ARTIFACTS_GCS_BUCKET="$(read_dotenv_value "$ENV_FILE" "SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET")"
SCAN_ARTIFACTS_ROOT="$(read_dotenv_value "$ENV_FILE" "SPOTLIGHT_SCAN_ARTIFACTS_ROOT")"
SCAN_ARTIFACT_UPLOADS_ENABLED="$(read_dotenv_value "$ENV_FILE" "SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED")"
SERVICE_NAME="spotlight-backend.service"
SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME"
SERVICE_USER="$(id -un)"

if [ -z "$SYNC_CRON_SCHEDULE" ] || [[ "$SYNC_CRON_SCHEDULE" == *$'\n'* ]]; then
  echo "SPOTLIGHT_VM_SYNC_CRON must be a single non-empty cron schedule line." >&2
  exit 1
fi

if [ -z "$SYNC_CRON_TIMEZONE" ] || [[ "$SYNC_CRON_TIMEZONE" == *$'\n'* ]]; then
  echo "SPOTLIGHT_VM_SYNC_CRON_TZ must be a single non-empty timezone name." >&2
  exit 1
fi

if [ -z "$BACKEND_HOST" ] || [[ "$BACKEND_HOST" == *$'\n'* ]]; then
  echo "SPOTLIGHT_VM_BACKEND_HOST must be a single non-empty host value." >&2
  exit 1
fi

if [[ "$PUBLIC_BASE_URL" == *$'\n'* ]]; then
  echo "SPOTLIGHT_VM_PUBLIC_BASE_URL must be a single-line URL." >&2
  exit 1
fi

for schedule_var in SYNC_CRON_SCHEDULE HEALTH_CRON_SCHEDULE RESOURCE_CRON_SCHEDULE; do
  schedule_value="${!schedule_var}"
  if [ -z "$schedule_value" ] || [[ "$schedule_value" == *$'\n'* ]]; then
    echo "$schedule_var must be a single non-empty cron schedule line." >&2
    exit 1
  fi
done

if [ -n "$SCAN_ARTIFACTS_GCS_BUCKET" ] && [ -z "$SCAN_ARTIFACTS_STORAGE" ]; then
  SCAN_ARTIFACTS_STORAGE="gcs"
fi

if [ "$SCAN_ARTIFACTS_STORAGE" = "gcs" ] && [ -z "$SCAN_ARTIFACTS_GCS_BUCKET" ]; then
  echo "SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET is required when SPOTLIGHT_SCAN_ARTIFACTS_STORAGE=gcs" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$DATA_DIR"

stage_runtime_data_file \
  "slab_set_aliases.json" \
  "$SCRIPT_DIR/data/slab_set_aliases.json" \
  "$SCRIPT_DIR/backend/data/slab_set_aliases.json" \
  "$REPO_ROOT/backend/data/slab_set_aliases.json"

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel
"$VENV_DIR/bin/python" -m pip install --no-cache-dir --index-url "$TORCH_CPU_INDEX_URL" "$TORCH_PACKAGE_SPEC"
"$VENV_DIR/bin/python" -m pip install --no-cache-dir -r "$SCRIPT_DIR/requirements.vm.txt"

cat > "$RUNTIME_CONFIG_FILE" <<EOF
SPOTLIGHT_DEPLOY_ENVIRONMENT=$ENVIRONMENT
SPOTLIGHT_RUNTIME_ENV_FILE=$ENV_FILE
SPOTLIGHT_SECRETS_FILE=$SECRETS_FILE
SPOTLIGHT_VM_PYTHON=$VENV_DIR/bin/python
SPOTLIGHT_DATABASE_PATH=$DATABASE_PATH
SPOTLIGHT_HOST=$BACKEND_HOST
SPOTLIGHT_PORT=8788
SPOTLIGHT_PUBLIC_BASE_URL=$PUBLIC_BASE_URL
EOF

write_runtime_override() {
  local env_key="$1"
  local env_value="${2:-}"
  if [ -n "$env_value" ]; then
    printf '%s=%q\n' "$env_key" "$env_value" >> "$RUNTIME_CONFIG_FILE"
  fi
}

write_runtime_override "SPOTLIGHT_VISUAL_INDEX_NPZ_PATH" "$VISUAL_INDEX_NPZ_PATH"
write_runtime_override "SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH" "$VISUAL_INDEX_MANIFEST_PATH"
write_runtime_override "SPOTLIGHT_VISUAL_ADAPTER_CHECKPOINT_PATH" "$VISUAL_ADAPTER_CHECKPOINT_PATH"
write_runtime_override "SPOTLIGHT_VISUAL_ADAPTER_METADATA_PATH" "$VISUAL_ADAPTER_METADATA_PATH"
write_runtime_override "SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED" "$SCAN_ARTIFACT_UPLOADS_ENABLED"
write_runtime_override "SPOTLIGHT_SCAN_ARTIFACTS_STORAGE" "$SCAN_ARTIFACTS_STORAGE"
write_runtime_override "SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET" "$SCAN_ARTIFACTS_GCS_BUCKET"
write_runtime_override "SPOTLIGHT_SCAN_ARTIFACTS_ROOT" "$SCAN_ARTIFACTS_ROOT"
write_runtime_override "SPOTLIGHT_VM_SYNC_CRON" "$SYNC_CRON_SCHEDULE"
write_runtime_override "SPOTLIGHT_VM_SYNC_CRON_TZ" "$SYNC_CRON_TIMEZONE"
write_runtime_override "SPOTLIGHT_SYNC_LOCK_FILE" "$SYNC_LOCK_FILE"
write_runtime_override "SPOTLIGHT_SYNC_LOG_FILE" "$SYNC_LOG_FILE"

chmod 600 "$RUNTIME_CONFIG_FILE"
chmod +x \
  "$SCRIPT_DIR/run_backend_vm.sh" \
  "$SCRIPT_DIR/run_backend_vm_forever.sh" \
  "$SCRIPT_DIR/run_vm_prewarm_visual.sh" \
  "$SCRIPT_DIR/run_sync_vm.sh" \
  "$SCRIPT_DIR/run_sync_vm_scheduled.sh" \
  "$SCRIPT_DIR/run_vm_health_check.sh" \
  "$SCRIPT_DIR/run_vm_resource_snapshot.sh"

sudo tee "$SERVICE_PATH" >/dev/null <<EOF
[Unit]
Description=Looty backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/run_backend_vm.sh
ExecStartPost=$SCRIPT_DIR/run_vm_prewarm_visual.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "Validating Scrydex configuration..."
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
# shellcheck disable=SC1090
. "$SECRETS_FILE"
set +a
"$VENV_DIR/bin/python" "$SCRIPT_DIR/validate_scrydex.py" --database-path "$DATABASE_PATH"

if [ "${SPOTLIGHT_RUN_INITIAL_SYNC:-0}" = "1" ]; then
  echo "Running initial Scrydex sync (explicit opt-in)..."
  "$SCRIPT_DIR/run_sync_vm.sh" >> "$SYNC_LOG_FILE" 2>&1
else
  echo "Skipping initial Scrydex sync by default; relying on the scheduled 3:00 AM cron."
  echo "Set SPOTLIGHT_RUN_INITIAL_SYNC=1 to opt in during deploy."
fi

CRON_BEGIN="# BEGIN spotlight-backend-vm"
CRON_END="# END spotlight-backend-vm"
SYNC_LINE="* * * * * cd $REPO_ROOT && $SCRIPT_DIR/run_sync_vm_scheduled.sh"
HEALTH_LINE="$HEALTH_CRON_SCHEDULE cd $REPO_ROOT && $SCRIPT_DIR/run_vm_health_check.sh >> $HEALTH_MONITOR_LOG_FILE 2>&1"
RESOURCE_LINE="$RESOURCE_CRON_SCHEDULE cd $REPO_ROOT && $SCRIPT_DIR/run_vm_resource_snapshot.sh >> $RESOURCE_MONITOR_LOG_FILE 2>&1"

CURRENT_CRONTAB="$(mktemp "${TMPDIR:-/tmp}/spotlight-crontab.XXXXXX")"
trap 'rm -f "$CURRENT_CRONTAB"' EXIT

crontab -l > "$CURRENT_CRONTAB" 2>/dev/null || true
python3 - "$CURRENT_CRONTAB" "$CRON_BEGIN" "$CRON_END" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
begin = sys.argv[2]
end = sys.argv[3]
lines = path.read_text(encoding="utf-8").splitlines()
filtered: list[str] = []
inside = False
for line in lines:
    stripped = line.strip()
    if stripped == begin:
        inside = True
        continue
    if stripped == end:
        inside = False
        continue
    if not inside:
        filtered.append(line)
path.write_text("\n".join(filtered).strip() + ("\n" if filtered else ""), encoding="utf-8")
PY

{
  cat "$CURRENT_CRONTAB"
  echo "$CRON_BEGIN"
  echo "$SYNC_LINE"
  echo "$HEALTH_LINE"
  echo "$RESOURCE_LINE"
  echo "$CRON_END"
} | crontab -

pkill -f "$SCRIPT_DIR/run_backend_vm_forever.sh" 2>/dev/null || true
pkill -f "$SCRIPT_DIR/server.py" 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo "VM deploy complete"
echo "  Environment: $ENVIRONMENT"
echo "  Python: $VENV_DIR/bin/python"
echo "  Database: $DATABASE_PATH"
echo "  Runtime config: $RUNTIME_CONFIG_FILE"
echo "  Backend log: $LOG_DIR/backend.log"
echo "  Sync log: $SYNC_LOG_FILE"
echo "  Health monitor log: $HEALTH_MONITOR_LOG_FILE"
echo "  Resource monitor log: $RESOURCE_MONITOR_LOG_FILE"
echo "  Sync schedule: $SYNC_CRON_SCHEDULE timezone=$SYNC_CRON_TIMEZONE (minute scheduler wrapper)"
echo "  Health cron: $HEALTH_CRON_SCHEDULE"
echo "  Resource cron: $RESOURCE_CRON_SCHEDULE"
echo "  Backend bind: $BACKEND_HOST:8788"
echo "  Backend service: $SERVICE_NAME"
echo "  Public base URL: ${PUBLIC_BASE_URL:-<unset>}"
echo "  eBay Browse: $(if env_flag_enabled "$EBAY_BROWSE_ENABLED_VALUE"; then printf '%s' "enabled"; else printf '%s' "disabled"; fi)"
echo "  Health: curl http://127.0.0.1:8788/api/v1/health"
echo "  Provider status: curl http://127.0.0.1:8788/api/v1/ops/provider-status"
