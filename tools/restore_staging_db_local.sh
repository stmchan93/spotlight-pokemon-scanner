#!/usr/bin/env bash
#
# Pull a consistent snapshot of the staging SQLite database to a local file so
# you can test pricing/query logic without burning Scrydex API credits.
#
# How it works:
#   1. SSH to the staging VM
#   2. Run `sqlite3 source.db ".backup /tmp/snapshot.sqlite"` — atomic snapshot
#      of the live DB, safe to run while the backend is serving traffic
#   3. gcloud compute scp the snapshot file back to your laptop
#   4. Clean up the VM-side temp file
#
# Why this approach instead of `litestream restore` locally:
#   The VM runs Litestream v0.3.14; macOS Homebrew only ships v0.5.x (different
#   replica format). Installing v0.3.14 locally requires Go or Docker. SSH +
#   sqlite3 .backup avoids that whole problem and gets you the freshest data.
#
# Disaster recovery (when the VM is gone):
#   Litestream backups in gs://looty-staging-backups can be restored on any
#   Linux box with Litestream v0.3.14 via:
#     litestream restore -o restored.sqlite gcs://looty-staging-backups/spotlight_scanner
#
# Requirements:
#   - gcloud CLI authenticated to spotlight-492502
#   - SSH access to spotlight-backend-vm-small (your account already has it)
#
# Usage:
#   pnpm backend:restore:local                 # → backend/data/spotlight_scanner.local.sqlite
#   bash tools/restore_staging_db_local.sh /tmp/x  # custom destination

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULT_DEST="$REPO_ROOT/backend/data/spotlight_scanner.local.sqlite"
DEST="${1:-$DEFAULT_DEST}"

VM_INSTANCE="${SPOTLIGHT_VM_STAGING_INSTANCE:-spotlight-backend-vm-small}"
VM_ZONE="${SPOTLIGHT_VM_STAGING_ZONE:-us-central1-b}"
VM_PROJECT="${SPOTLIGHT_GCP_PROJECT:-spotlight-492502}"
VM_DB_PATH="${SPOTLIGHT_VM_DB_PATH:-/home/stephenchan/spotlight/data/spotlight_scanner.sqlite}"
VM_SNAPSHOT_PATH="/home/stephenchan/restore-snapshot-$$.sqlite"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Error: gcloud CLI not found. Install: brew install --cask google-cloud-sdk"
  exit 1
fi

echo "Pulling staging DB snapshot:"
echo "  VM:     ${VM_INSTANCE} (${VM_ZONE}, ${VM_PROJECT})"
echo "  Source: ${VM_DB_PATH}"
echo "  Dest:   ${DEST}"
echo

mkdir -p "$(dirname "$DEST")"

echo "[1/3] Creating consistent snapshot on VM..."
gcloud compute ssh "$VM_INSTANCE" \
  --zone="$VM_ZONE" \
  --project="$VM_PROJECT" \
  --command="sqlite3 '${VM_DB_PATH}' \".backup '${VM_SNAPSHOT_PATH}'\" && ls -lh '${VM_SNAPSHOT_PATH}'"

echo
echo "[2/3] Copying snapshot to local..."
gcloud compute scp \
  "${VM_INSTANCE}:${VM_SNAPSHOT_PATH}" \
  "$DEST" \
  --zone="$VM_ZONE" \
  --project="$VM_PROJECT"

echo
echo "[3/3] Cleaning up VM-side temp file..."
gcloud compute ssh "$VM_INSTANCE" \
  --zone="$VM_ZONE" \
  --project="$VM_PROJECT" \
  --command="rm -f '${VM_SNAPSHOT_PATH}'"

echo
echo "Done. Local snapshot at:"
ls -lh "$DEST"
echo
echo "Sanity check (row counts):"
sqlite3 "$DEST" "SELECT 'price_history' AS table_name, COUNT(*) AS rows FROM card_price_history_daily UNION ALL SELECT 'cards', COUNT(*) FROM cards;"
