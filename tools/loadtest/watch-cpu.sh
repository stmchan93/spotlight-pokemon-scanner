#!/usr/bin/env bash
# Watch the backend VM's CPU + I/O while a k6 load test runs. Run this in a second
# terminal alongside k6.
#
# CPU is the scanner's capacity lever, so this is how you tell WHICH wall you hit:
#   - `id` (idle) column heading toward 0  → CPU-saturated → buy more vCPUs.
#   - `wa` (iowait) column spiking          → disk-bound (cold-cache reads) →
#                                             optimize the cold I/O path, not CPU.
#   - `r`  (run queue) >> vCPU count         → requests are queueing.
#
# Uses `vmstat` over `gcloud compute ssh` (one persistent session, low overhead).
#
# Usage:
#   tools/loadtest/watch-cpu.sh                     # defaults below
#   VM=spotlight-backend-vm-small ZONE=us-central1-b INTERVAL=3 tools/loadtest/watch-cpu.sh
#   HOST=user@1.2.3.4 tools/loadtest/watch-cpu.sh   # plain ssh instead of gcloud
set -euo pipefail

VM="${VM:-spotlight-backend-vm-small}"
ZONE="${ZONE:-us-central1-b}"
INTERVAL="${INTERVAL:-3}"
HOST="${HOST:-}"

# `vmstat -t` adds a wall-clock timestamp column; sampling every INTERVAL seconds
# prints a fresh row continuously until you Ctrl-C.
REMOTE_CMD="echo 'nproc:' \$(nproc); vmstat -tn ${INTERVAL}"

echo "Watching CPU/I/O on ${HOST:-$VM} every ${INTERVAL}s (Ctrl-C to stop)"
echo "Key columns:  r=runqueue  us=user%  sy=system%  id=idle%  wa=iowait%"
echo

if [[ -n "$HOST" ]]; then
  exec ssh "$HOST" "$REMOTE_CMD"
else
  exec gcloud compute ssh "$VM" --zone "$ZONE" --command "$REMOTE_CMD"
fi
