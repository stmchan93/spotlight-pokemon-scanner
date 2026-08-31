#!/bin/bash
# Export ONLY the three 2026 show weekends' raw scans for labeling, then serve
# the labeling site on that worksheet. Run ON THE STAGING VM (the scans and
# artifacts live there); friends point browsers at <vm>:8765.
#
# Windows are LOCAL show days converted to UTC (created_at is UTC):
#   Jun 20-21  Blaisdell Arena, Honolulu   (HST, UTC-10)
#   Jul 12     1-Year Anniversary, Pomona  (PDT, UTC-7)
#   Aug 22-23  Ontario Convention Center   (PDT, UTC-7)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${SPOTLIGHT_DATABASE_PATH:-$REPO_ROOT/backend/data/spotlight_scanner.sqlite}"
OUT="${1:-$HOME/spotlight-datasets/raw-visual-train/scan-review-exports/shows-2026-hnl-pomona-ontario}"

python3 "$REPO_ROOT/tools/export_scan_training_rows.py" \
  --db "$DB" \
  --storage gcs --gcs-bucket "${SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET:-looty-staging}" \
  --include-unconfirmed \
  --window "2026-06-20T10:00:00..2026-06-22T10:00:00" \
  --window "2026-07-12T07:00:00..2026-07-13T07:00:00" \
  --window "2026-08-22T07:00:00..2026-08-24T07:00:00" \
  --batch-id shows-2026-hnl-pomona-ontario \
  --output-root "$OUT"

echo
echo "Serve the labeler on exactly these scans:"
echo "  python3 tools/scan_labeling_server.py --csv $OUT/*/scan_review.csv --db $DB --host 0.0.0.0 --port 8765"
