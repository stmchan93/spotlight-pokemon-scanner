#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

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
  -only-testing:SpotlightTests/RawOCRRegressionSuiteTests/testRawFooterLayoutCheckFixturesEmitRegressionBaseline
