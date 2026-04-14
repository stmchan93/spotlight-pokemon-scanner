#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

fixture_root="${1:-qa/raw-footer-layout-check}"
fixture_root_abs="$(python3 - <<'PY' "$fixture_root"
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve())
PY
)"
override_file="qa/.raw_layout_fixture_root_override.txt"
print -r -- "$fixture_root_abs" > "$override_file"
cleanup() {
  rm -f "$override_file"
}
trap cleanup EXIT

destination_device_name="$(
python3 - <<'PY'
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

xcodebuild \
  -project Spotlight.xcodeproj \
  -scheme Spotlight \
  -configuration Debug \
  -destination "platform=iOS Simulator,name=${destination_device_name}" \
  -derivedDataPath .derivedData \
  CODE_SIGNING_ALLOWED=NO \
  test \
  -only-testing:SpotlightTests/OCRRewriteStage2FixtureTests/testRawFooterLayoutCheckFixturesEmitRuntimeSelectionSummary
