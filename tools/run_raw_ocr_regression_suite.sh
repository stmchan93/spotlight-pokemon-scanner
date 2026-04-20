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

native_arch="$(uname -m)"
arch_overrides=()
case "$native_arch" in
  arm64)
    arch_overrides=(
      ONLY_ACTIVE_ARCH=YES
      ARCHS=arm64
      EXCLUDED_ARCHS=x86_64
    )
    ;;
  x86_64)
    arch_overrides=(
      ONLY_ACTIVE_ARCH=YES
      ARCHS=x86_64
      EXCLUDED_ARCHS=arm64
    )
    ;;
esac

run_bucket() {
  local cleanup_flag="$1"
  local selector="$2"

  RAW_OCR_REGRESSION_CLEANUP="${cleanup_flag}" \
  xcodebuild \
    -project Spotlight.xcodeproj \
    -scheme Spotlight \
    -configuration Debug \
    -destination "platform=iOS Simulator,name=${destination_device_name}" \
    -derivedDataPath .derivedData \
    CODE_SIGNING_ALLOWED=NO \
    "${arch_overrides[@]}" \
    test \
    -only-testing:"${selector}"
}

for bucket in $(seq -w 1 10); do
  cleanup_flag=0
  if [[ "${bucket}" == "01" ]]; then
    cleanup_flag=1
  fi

  run_bucket \
    "${cleanup_flag}" \
    "SpotlightTests/RawOCRRegressionSuiteTests/testRawFooterLayoutCheckBucket${bucket}EmitRegressionBaseline"
done

run_bucket \
  0 \
  "SpotlightTests/RawOCRRegressionSuiteTests/testRawFooterLayoutCheckBucket99AggregateScorecardMeetsThresholds"
