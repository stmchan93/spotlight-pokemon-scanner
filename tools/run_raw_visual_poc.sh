#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

if [[ -f backend/.env ]]; then
  set -a
  source backend/.env
  set +a
fi

python_bin="python3"
if command -v python3.10 >/dev/null 2>&1; then
  python_bin="python3.10"
fi

destination_device_name="$(
"$python_bin" - <<'PY'
import json
import subprocess

data = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"]))
for _, devices in data.get("devices", {}).items():
    for device in devices:
        if not device.get("isAvailable"):
            continue
        name = device.get("name", "")
        if "iPhone" in name:
            print(name)
            raise SystemExit(0)
raise SystemExit("No available iPhone simulator found")
PY
)"

expected_fixture_count="$("$python_bin" - <<'PY'
from pathlib import Path
root = Path("qa/raw-footer-layout-check")
count = 0
for directory in root.iterdir():
    if directory.is_dir() and (directory / "truth.json").exists() and (directory / "source_scan.jpg").exists():
        count += 1
print(count)
PY
)"

normalized_fixture_count="$(find qa/raw-footer-layout-check -name 'runtime_normalized.jpg' | wc -l | tr -d ' ')"

if [[ "${FORCE_RAW_VISUAL_NORMALIZATION:-0}" == "1" || "$normalized_fixture_count" != "$expected_fixture_count" ]]; then
  echo "Generating runtime_normalized.jpg for qa/raw-footer-layout-check ..."
  xcodebuild \
    -project Spotlight.xcodeproj \
    -scheme Spotlight \
    -configuration Debug \
    -destination "platform=iOS Simulator,name=${destination_device_name}" \
    -derivedDataPath .derivedData \
    CODE_SIGNING_ALLOWED=NO \
    test \
    -only-testing:SpotlightTests/OCRRewriteStage2FixtureTests/testRawFooterLayoutCheckFixturesEmitRuntimeSelectionSummary
else
  echo "Skipping normalization step; found $normalized_fixture_count/$expected_fixture_count runtime_normalized.jpg files."
fi

venv_dir=".venv-raw-visual-poc"
if [[ ! -d "$venv_dir" ]]; then
  "$python_bin" -m venv "$venv_dir"
fi
source "$venv_dir/bin/activate"
python -m pip install --upgrade pip >/dev/null
python -m pip install -r tools/requirements_raw_visual_poc.txt

echo "Building provider reference manifest ..."
python tools/build_raw_visual_seed_manifest.py

echo "Running raw visual proof-of-concept scorecard ..."
python tools/run_raw_visual_poc.py
