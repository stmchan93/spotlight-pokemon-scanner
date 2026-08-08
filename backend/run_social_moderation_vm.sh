#!/bin/bash

# Social-content moderation pass (the layer-2 "AI pass"). Runs on the VM every
# couple of minutes via the managed crontab block in deploy_to_vm.sh.
#
# WHY THIS HAS TO RUN AT ALL: RLS gates post images on
# `moderation_status='approved'`, so an uploaded image stays hidden from everyone
# except its author until this worker approves it. Without the cron, image
# posting looks broken to every other user while behaving exactly as designed.
#
# `--once` (not `--loop`) because cron owns the cadence. A `--loop` process would
# have to be supervised by something, and nothing supervises it here: if it died
# — an unhandled error, an OOM kill, a VM reboot — moderation would stay dead
# until the next deploy, and the symptom (images invisible to everyone but their
# author) looks like a client bug, not a dead daemon. A cron tick self-heals: the
# worst case is one missed batch, and the next tick two minutes later picks up
# exactly the same unfinished rows, because the work queue lives in Postgres
# rather than in the process.
#
# Overlap is guarded by an exclusive flock below, NOT by the worker's poll
# filters. Those filters ("moderation_checked_at IS NULL" / "status = pending")
# do not deduplicate concurrent runs: a row stays selectable until its verdict is
# written, so two overlapping ticks would both fetch it, both call OpenAI on it,
# and both pay the GCS read. That matters most on the first run against a
# backlog, which is exactly when a tick is slowest and overlap is likeliest.
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
LOCK_FILE="${SPOTLIGHT_SOCIAL_MODERATION_LOCK_FILE:-$SCRIPT_DIR/data/social-moderation.lock}"
FLOCK_BIN="${FLOCK_BIN_OVERRIDE:-$(command -v flock || true)}"

# Take the lock before doing anything expensive. This is the man-page idiom: fd 9
# stays open across the `exec` below, so the lock is held for the whole lifetime
# of the Python process and is released by the kernel when it exits — including
# when it is killed, which a lock file with a PID in it would not survive.
# deploy_to_vm.sh hard-fails if flock is absent from the VM, so reaching the
# no-flock branch means someone is running this by hand on a box without
# util-linux; say so rather than silently running unguarded.
if [ -n "$FLOCK_BIN" ]; then
  mkdir -p "$(dirname "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  if ! "$FLOCK_BIN" -n 9; then
    echo "$(date -u +%FT%TZ) social-moderation: previous run still in progress — skipping this tick."
    exit 0
  fi
else
  echo "$(date -u +%FT%TZ) social-moderation: flock unavailable — running WITHOUT an overlap guard."
fi

# Missing credentials must be loud and greppable, never a silent no-op: with the
# cron installed and the log filling up with successful-looking ticks, "nothing
# is configured" and "nothing to do" are indistinguishable otherwise. Exit 0
# rather than failing, so cron does not mail the operator every 2 minutes — the
# log line is the signal:
#   grep 'moderation disabled' ~/spotlight/logs/social_moderation.log
MISSING_ENV=""
for required_key in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY OPENAI_API_KEY; do
  if [ -z "${!required_key:-}" ]; then
    if [ -n "$MISSING_ENV" ]; then
      MISSING_ENV="$MISSING_ENV, $required_key"
    else
      MISSING_ENV="$required_key"
    fi
  fi
done

if [ -n "$MISSING_ENV" ]; then
  echo "$(date -u +%FT%TZ) social-moderation: moderation disabled: missing $MISSING_ENV"
  exit 0
fi

# The bucket is only needed for the image pass. Report it and carry on: the text
# pass is still worth running, and the worker logs the same conclusion itself.
if [ -z "${SPOTLIGHT_POST_MEDIA_GCS_BUCKET:-}" ]; then
  echo "$(date -u +%FT%TZ) social-moderation: image moderation disabled: missing SPOTLIGHT_POST_MEDIA_GCS_BUCKET (post images stay 'pending' and hidden by RLS)"
fi

exec "$PYTHON_BIN" "$SCRIPT_DIR/social_moderation_worker.py" --once
