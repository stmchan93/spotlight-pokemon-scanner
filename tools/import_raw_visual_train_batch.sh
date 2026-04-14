#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

input_dir="${1:?usage: zsh tools/import_raw_visual_train_batch.sh /path/to/input-dir [/path/to/labels.tsv] [fixture-root]}"
default_fixture_root="$(
python3 - <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, str((Path.cwd() / "tools").resolve()))
from raw_visual_dataset_paths import default_raw_visual_train_root

print(default_raw_visual_train_root())
PY
)"

metadata_path=""
fixture_root="$default_fixture_root"

if [[ $# -ge 2 ]]; then
  if [[ -f "$2" ]]; then
    metadata_path="$2"
    if [[ $# -ge 3 ]]; then
      fixture_root="$3"
    fi
  else
    fixture_root="$2"
  fi
fi

import_args=(
  --input-dir "$input_dir"
  --output-root "$fixture_root"
  --exact-duplicate-root qa/raw-footer-layout-check
  --exact-duplicate-root "$fixture_root"
)

if [[ -n "$metadata_path" ]]; then
  import_args+=(--metadata "$metadata_path")
fi

python3 tools/import_raw_visual_training_photos.py "${import_args[@]}"

zsh tools/generate_raw_runtime_artifacts.sh "$fixture_root"

visual_python="python3"
if [[ ! -x ".venv-raw-visual-poc/bin/python" ]]; then
  python3 -m venv .venv-raw-visual-poc
  .venv-raw-visual-poc/bin/pip install -r tools/requirements_raw_visual_poc.txt
fi
visual_python=".venv-raw-visual-poc/bin/python"

"$visual_python" tools/auto_label_raw_visual_training_fixtures.py \
  --fixture-root "$fixture_root"

set -a
source backend/.env
set +a

"$visual_python" tools/build_raw_visual_training_manifest.py \
  --fixture-root "$fixture_root" \
  --output "$fixture_root/raw_visual_training_manifest.jsonl" \
  --summary-output "$fixture_root/raw_visual_training_manifest_summary.json" \
  --query-cache "$fixture_root/.visual_reference_cache/provider_search_cache.json" \
  --reference-image-root "$fixture_root/.visual_reference_cache/reference_images"
