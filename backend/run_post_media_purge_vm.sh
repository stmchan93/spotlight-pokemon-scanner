#!/bin/bash

# Post-media retention purge. Intended to run DAILY from the managed crontab
# block in deploy_to_vm.sh (wired separately — this script does not install it).
#
# WHAT IT DOES: deletes the storage objects behind post_media rows whose parent
# post was soft-deleted more than 30 days ago, plus uploads the moderation worker
# never resolved. Post deletes are SOFT (social_17), so the bytes are not freed
# by the delete itself — this job is what frees them.
#
# DRY RUN IS THE DEFAULT, HERE TOO. This is the only job in the system with
# delete authority over users' photos, so a misconfigured cron must not be able
# to delete anything. Nothing is deleted unless SPOTLIGHT_POST_MEDIA_PURGE_APPLY
# is explicitly set to 1/true/yes in the runtime env or secrets file; until then
# every run just logs what it WOULD delete, which is exactly what the first
# real-world run should be: a human reading that output.
#
# Optional overrides (runtime env / secrets file):
#   SPOTLIGHT_POST_MEDIA_PURGE_APPLY   1|true|yes  -> actually delete (default: no)
#   SPOTLIGHT_POST_MEDIA_PURGE_LIMIT   hard cap on objects per run (default 500)
#
# Credentials come from the env (SPOTLIGHT_SECRETS_FILE), never the command line:
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (which rows to purge)
#   SPOTLIGHT_POST_MEDIA_GCS_BUCKET + GCP default credentials with delete access
# With the bucket unset the purge module refuses to run in --apply mode rather
# than reaping rows whose objects it cannot delete (that would strand the files
# forever, which is the exact garbage this job exists to prevent).

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

# No service-role key, nothing to do. Exit 0 rather than failing: a missing key
# should leave a breadcrumb in the log, not mail the operator a cron failure
# every day. Same posture as run_social_moderation_vm.sh.
if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "$(date -u +%FT%TZ) post-media-purge: SUPABASE_SERVICE_ROLE_KEY unset — skipping."
  exit 0
fi
if [ -z "${SUPABASE_URL:-}" ]; then
  echo "$(date -u +%FT%TZ) post-media-purge: SUPABASE_URL unset — skipping."
  exit 0
fi

PURGE_ARGS=("--limit" "${SPOTLIGHT_POST_MEDIA_PURGE_LIMIT:-500}")

case "$(printf '%s' "${SPOTLIGHT_POST_MEDIA_PURGE_APPLY:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    # Deliberate opt-in only. Everything else — unset, empty, "0", a typo —
    # falls through to the dry run below.
    echo "$(date -u +%FT%TZ) post-media-purge: APPLY enabled — objects will be deleted."
    PURGE_ARGS+=("--apply")
    ;;
  *)
    echo "$(date -u +%FT%TZ) post-media-purge: dry run (set SPOTLIGHT_POST_MEDIA_PURGE_APPLY=1 to enable deletion)."
    ;;
esac

exec "$PYTHON_BIN" "$SCRIPT_DIR/post_media_purge.py" "${PURGE_ARGS[@]}"
