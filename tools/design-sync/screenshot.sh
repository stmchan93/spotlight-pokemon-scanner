#!/usr/bin/env bash
# Deterministic simulator screenshot for /sync-design.
#
# Usage: tools/design-sync/screenshot.sh <deep-link> <out.png> [settle-seconds]
#
# Opens the deep link on the booted iOS simulator (boots one if none is), pins
# the status bar to a fixed time/battery so screenshots don't differ run-to-run,
# waits for render/animations to settle, then captures a PNG.
set -euo pipefail

DEEP_LINK="${1:?usage: screenshot.sh <deep-link> <out.png> [settle-seconds]}"
OUT_PATH="${2:?usage: screenshot.sh <deep-link> <out.png> [settle-seconds]}"
SETTLE_SECONDS="${3:-2}"
# iPhone 16 Pro: the dedicated design-sync sim — the plain iPhone 16 sim has
# several legacy apps competing for the spotlight:// scheme.
PREFERRED_DEVICE="${SPOTLIGHT_IOS_SIMULATOR_DEVICE:-iPhone 16 Pro}"

if ! xcrun simctl list devices booted | grep -q "(Booted)"; then
  echo "No booted simulator — booting '${PREFERRED_DEVICE}'..."
  xcrun simctl boot "${PREFERRED_DEVICE}"
  open -a Simulator
  xcrun simctl bootstatus booted
fi

# Fixed chrome: Apple's canonical 9:41, full battery/signal. Kills the clock and
# battery indicator as diff noise at the source.
xcrun simctl status_bar booted override \
  --time "9:41" \
  --batteryState charged --batteryLevel 100 \
  --cellularMode active --cellularBars 4 \
  --wifiBars 3 >/dev/null 2>&1 || true

mkdir -p "$(dirname "${OUT_PATH}")"
xcrun simctl openurl booted "${DEEP_LINK}"
sleep "${SETTLE_SECONDS}"
xcrun simctl io booted screenshot "${OUT_PATH}"
echo "screenshot: ${OUT_PATH}"
