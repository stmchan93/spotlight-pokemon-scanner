#!/bin/bash

# Social-content moderation pass (the layer-2 "AI pass"). Runs on the VM every
# couple of minutes via the managed crontab block in deploy_to_vm.sh.
#
# WHY THIS HAS TO RUN AT ALL: RLS gates post images on
# `moderation_status='approved'`, so an uploaded image stays hidden from everyone
# except its author until this worker approves it. Without the cron, image
# posting looks broken to every other user while behaving exactly as designed.
#
# `--once` (not `--loop`) because cron owns the cadence — a `--loop` process here
# would survive past the next deploy and end up running twice. The worker is
# explicitly safe to run repeatedly: it only picks up rows that are still
# unchecked or still `pending`, so an overlapping run finds nothing to do.
#
# Credentials come from the env (SPOTLIGHT_SECRETS_FILE), never the command line:
#   text pass:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
#   image pass: + SPOTLIGHT_POST_MEDIA_GCS_BUCKET and GCP default credentials
# With the bucket unset the worker still runs the text pass and SKIPS images —
# silently, leaving rows 'pending'. That failure looks identical to "uploads are
# broken", so check the bucket var first when images stop appearing.
#
# The OpenAI moderation endpoint (omni-moderation-latest) is free for text and
# images alike, so this costs nothing per post beyond GCS egress on the image read.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_CONFIG_FILE="${SPOTLIGHT_VM_RUNTIME_CONFIG:-$SCRIPT_DIR/.vm-runtime.conf}"

set -a
if [ -f "$RUNTIME_CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_CONFIG_FILE"
fi
if [ -n "${SPOTLIGHT_RUNTIME_ENV_FILE:-}" ] && [ -f "${SPOTLIGHT_RUNTIME_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${SPOTLIGHT_RUNTIME_ENV_FILE}"
fi
if [ -n "${SPOTLIGHT_SECRETS_FILE:-}" ] && [ -f "${SPOTLIGHT_SECRETS_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${SPOTLIGHT_SECRETS_FILE}"
fi
set +a

PYTHON_BIN="${SPOTLIGHT_VM_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"

# No key, nothing to do. Exit 0 rather than failing: a missing key should leave
# a breadcrumb in the log, not mail the operator a cron failure every 2 minutes.
if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "$(date -u +%FT%TZ) social-moderation: OPENAI_API_KEY unset — skipping."
  exit 0
fi

exec "$PYTHON_BIN" "$SCRIPT_DIR/social_moderation_worker.py" --once
