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

VENV_DIR="$SCRIPT_DIR/.venv"
LOG_DIR="$SCRIPT_DIR/logs"
DATA_DIR="$SCRIPT_DIR/data"
DATABASE_PATH="$DATA_DIR/spotlight_scanner.sqlite"
RUNTIME_CONFIG_FILE="$SCRIPT_DIR/.vm-runtime.conf"
FLOCK_BIN="$(command -v flock)"
SYNC_LOCK_FILE="$DATA_DIR/scrydex-sync.lock"
SYNC_LOG_FILE="$LOG_DIR/scrydex_sync.log"
TORCH_CPU_INDEX_URL="${SPOTLIGHT_VM_TORCH_INDEX_URL:-https://download.pytorch.org/whl/cpu}"
TORCH_PACKAGE_SPEC="${SPOTLIGHT_VM_TORCH_PACKAGE_SPEC:-torch}"
SYNC_CRON_SCHEDULE="${SPOTLIGHT_VM_SYNC_CRON:-0 3 * * *}"
SYNC_CRON_TIMEZONE="${SPOTLIGHT_VM_SYNC_CRON_TZ:-America/Los_Angeles}"
BACKEND_HOST="${SPOTLIGHT_VM_BACKEND_HOST:-127.0.0.1}"
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

mkdir -p "$LOG_DIR" "$DATA_DIR"

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
EOF

chmod 600 "$RUNTIME_CONFIG_FILE"
chmod +x \
  "$SCRIPT_DIR/run_backend_vm.sh" \
  "$SCRIPT_DIR/run_backend_vm_forever.sh" \
  "$SCRIPT_DIR/run_sync_vm.sh"

sudo tee "$SERVICE_PATH" >/dev/null <<EOF
[Unit]
Description=Spotlight backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/run_backend_vm.sh
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

if [ "${SPOTLIGHT_SKIP_INITIAL_SYNC:-0}" != "1" ]; then
  echo "Running initial Scrydex sync..."
  "$SCRIPT_DIR/run_sync_vm.sh" >> "$SYNC_LOG_FILE" 2>&1
fi

CRON_BEGIN="# BEGIN spotlight-backend-vm"
CRON_END="# END spotlight-backend-vm"
SYNC_TZ_LINE="CRON_TZ=$SYNC_CRON_TIMEZONE"
SYNC_LINE="$SYNC_CRON_SCHEDULE cd $REPO_ROOT && $FLOCK_BIN -n $SYNC_LOCK_FILE $SCRIPT_DIR/run_sync_vm.sh >> $SYNC_LOG_FILE 2>&1"

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
  echo "$SYNC_TZ_LINE"
  echo "$SYNC_LINE"
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
echo "  Sync cron: $SYNC_CRON_SCHEDULE timezone=$SYNC_CRON_TIMEZONE"
echo "  Backend bind: $BACKEND_HOST:8788"
echo "  Backend service: $SERVICE_NAME"
echo "  Health: curl http://127.0.0.1:8788/api/v1/health"
echo "  Provider status: curl http://127.0.0.1:8788/api/v1/ops/provider-status"
