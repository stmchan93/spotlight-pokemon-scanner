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
#   - SSH access to spotlight-backend-staging (your account already has it)
#
# Usage:
#   pnpm backend:restore:local                 # → backend/data/spotlight_scanner.local.sqlite
#   bash tools/restore_staging_db_local.sh /tmp/x  # custom destination

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULT_DEST="$REPO_ROOT/backend/data/spotlight_scanner.local.sqlite"
DEST="${1:-$DEFAULT_DEST}"

# Staging box (split 2026-07-10): spotlight-backend-staging in us-central1-a.
# (spotlight-backend-vm-small / us-central1-c is PRODUCTION — do not default there.)
VM_INSTANCE="${SPOTLIGHT_VM_STAGING_INSTANCE:-spotlight-backend-staging}"
VM_ZONE="${SPOTLIGHT_VM_STAGING_ZONE:-us-central1-a}"
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
# The VM has no sqlite3 CLI on the non-interactive PATH, but it does have
# python3 (with the sqlite3 module). Use the online backup API, which is the
# programmatic equivalent of sqlite3's ".backup" — atomic and safe while the
# backend is serving traffic.
gcloud compute ssh "$VM_INSTANCE" \
  --zone="$VM_ZONE" \
  --project="$VM_PROJECT" \
  --command="python3 -c \"import sqlite3; s=sqlite3.connect('${VM_DB_PATH}'); d=sqlite3.connect('${VM_SNAPSHOT_PATH}'); s.backup(d); d.close(); s.close()\" && ls -lh '${VM_SNAPSHOT_PATH}'"

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
python3 -c "import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
for t in ('card_price_history_daily','cards','scan_events'):
    try: n=c.execute('SELECT COUNT(*) FROM '+t).fetchone()[0]
    except Exception as e: n='(err: %s)'%e
    print('%-24s %s'%(t,n))" "$DEST"
