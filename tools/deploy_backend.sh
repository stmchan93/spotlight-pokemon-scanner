#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
AUDIT_SCRIPT="$REPO_ROOT/tools/audit_release_config.py"
MOBILE_ENV_DIR="$REPO_ROOT/apps/spotlight-rn"

usage() {
  cat <<'EOF'
Usage: tools/deploy_backend.sh [staging|production] [backend/.env.<environment>.secrets]

Canonical local entrypoint for backend VM deploys.

Examples:
  bash tools/deploy_backend.sh staging
  bash tools/deploy_backend.sh production backend/.env.production.secrets

For a deploy run directly on the Linux VM host, use backend/deploy.sh instead.
EOF
}

case "${1:-}" in
  -h|--help|help)
    usage
    exit 0
    ;;
esac

ENVIRONMENT="${1:-staging}"

case "$ENVIRONMENT" in
  staging|production)
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac

default_secrets_file() {
  local environment="$1"
  local environment_upper
  environment_upper="$(printf '%s' "$environment" | tr '[:lower:]' '[:upper:]')"
  local environment_key="SPOTLIGHT_BACKEND_${environment_upper}_SECRETS_FILE"
  local environment_override="${!environment_key:-}"
  local generic_override="${SPOTLIGHT_BACKEND_SECRETS_FILE:-}"

  if [ -n "$environment_override" ]; then
    printf '%s\n' "$environment_override"
    return
  fi
  if [ -n "$generic_override" ]; then
    printf '%s\n' "$generic_override"
    return
  fi
  printf '%s/.env.%s.secrets\n' "$BACKEND_DIR" "$environment"
}

default_instance() {
  local environment="$1"
  case "$environment" in
    staging)
      printf '%s\n' "spotlight-backend-vm-small"
      ;;
    production)
      printf '%s\n' ""
      ;;
  esac
}

default_zone() {
  local environment="$1"
  case "$environment" in
    staging)
      # Moved 2026-07-07: zone -b kept stocking out of t2d machines; the VM now
      # lives in -c (same region/IP, deeper t2d pool). Old -b disk kept as rollback.
      printf '%s\n' "us-central1-c"
      ;;
    production)
      printf '%s\n' ""
      ;;
  esac
}

resolve_target_value() {
  local environment="$1"
  local kind="$2"
  local environment_upper
  environment_upper="$(printf '%s' "$environment" | tr '[:lower:]' '[:upper:]')"
  local environment_key="SPOTLIGHT_VM_${environment_upper}_${kind}"
  local generic_key="SPOTLIGHT_VM_${kind}"
  local environment_override="${!environment_key:-}"
  local generic_override="${!generic_key:-}"

  if [ -n "$environment_override" ]; then
    printf '%s\n' "$environment_override"
    return
  fi
  if [ -n "$generic_override" ]; then
    printf '%s\n' "$generic_override"
    return
  fi

  case "$kind" in
    INSTANCE)
      default_instance "$environment"
      ;;
    ZONE)
      default_zone "$environment"
      ;;
    REMOTE_DIR)
      printf '%s\n' "~/spotlight"
      ;;
  esac
}

read_dotenv_value() {
  local file_path="$1"
  local key="$2"
  python3 - "$file_path" "$key" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
target = sys.argv[2]

if not env_path.exists():
    raise SystemExit(0)

for raw_line in env_path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export "):
        line = line[len("export "):].strip()
    if "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key.strip() != target:
        continue
    value = value.strip()
    if value and len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    print(value, end="")
    break
PY
}

gcloud_cmd() {
  if [ -n "${GCLOUD_PROJECT:-}" ]; then
    gcloud --project "$GCLOUD_PROJECT" "$@"
  else
    gcloud "$@"
  fi
}

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required for local VM deploys." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for local VM deploys." >&2
  exit 1
fi

SECRETS_FILE="${2:-$(default_secrets_file "$ENVIRONMENT")}"
if [ ! -f "$SECRETS_FILE" ]; then
  echo "Missing secrets file: $SECRETS_FILE" >&2
  echo "Create it from backend/.env.secrets.example, for example:" >&2
  echo "  cp backend/.env.secrets.example backend/.env.${ENVIRONMENT}.secrets" >&2
  exit 1
fi

INSTANCE="$(resolve_target_value "$ENVIRONMENT" "INSTANCE")"
ZONE="$(resolve_target_value "$ENVIRONMENT" "ZONE")"
REMOTE_DIR="$(resolve_target_value "$ENVIRONMENT" "REMOTE_DIR")"

if [ -z "$INSTANCE" ]; then
  echo "Missing VM instance for $ENVIRONMENT." >&2
  echo "Set SPOTLIGHT_VM_${ENVIRONMENT^^}_INSTANCE or SPOTLIGHT_VM_INSTANCE." >&2
  exit 1
fi

if [ -z "$ZONE" ]; then
  echo "Missing VM zone for $ENVIRONMENT." >&2
  echo "Set SPOTLIGHT_VM_${ENVIRONMENT^^}_ZONE or SPOTLIGHT_VM_ZONE." >&2
  exit 1
fi

GCLOUD_PROJECT="${SPOTLIGHT_GCLOUD_PROJECT:-$(gcloud config get-value core/project 2>/dev/null || true)}"
GCLOUD_PROJECT="$(printf '%s' "$GCLOUD_PROJECT" | tr -d '\n')"
if [ "$GCLOUD_PROJECT" = "(unset)" ]; then
  GCLOUD_PROJECT=""
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/spotlight-vm-deploy.XXXXXX")"
REMOTE_BUNDLE_PATH="/tmp/spotlight-${ENVIRONMENT}-backend-bundle-$$.tgz"
REMOTE_SECRET_PATH="/tmp/spotlight-${ENVIRONMENT}-backend-secrets-$$.env"

cleanup() {
  local exit_code="$1"
  rm -rf "$TMP_DIR"
  if [ -n "${INSTANCE:-}" ] && [ -n "${ZONE:-}" ]; then
    gcloud_cmd compute ssh "$INSTANCE" \
      --zone "$ZONE" \
      --command "rm -f $REMOTE_BUNDLE_PATH $REMOTE_SECRET_PATH" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap 'cleanup $?' EXIT

echo "Running local release config audit for $ENVIRONMENT..."
python3 "$AUDIT_SCRIPT" --environment "$ENVIRONMENT" --backend-secrets-file "$SECRETS_FILE"

BUNDLE_ROOT="$TMP_DIR/backend-root"
mkdir -p "$BUNDLE_ROOT/tools"

COPYFILE_DISABLE=1 tar -C "$BACKEND_DIR" \
  --exclude='./.venv' \
  --exclude='./.env' \
  --exclude='./.env.*.secrets' \
  --exclude='./__pycache__' \
  --exclude='./data' \
  --exclude='./logs' \
  --exclude='./tests/__pycache__' \
  --exclude='./._*' \
  -cf - . | tar -C "$BUNDLE_ROOT" -xf -

COPYFILE_DISABLE=1 tar -C "$REPO_ROOT" \
  --exclude='./tools/__pycache__' \
  --exclude='./tools/.pytest_cache' \
  --exclude='./tools/._*' \
  -cf - tools | tar -C "$BUNDLE_ROOT" -xf -

cp "$AUDIT_SCRIPT" "$BUNDLE_ROOT/tools/audit_release_config.py"
if [ -f "$BACKEND_DIR/data/slab_set_aliases.json" ]; then
  mkdir -p "$BUNDLE_ROOT/data"
  cp "$BACKEND_DIR/data/slab_set_aliases.json" "$BUNDLE_ROOT/data/slab_set_aliases.json"
fi
# --------------------------------------------------------------------------
# Rerank-pool / adapter embedding-space preflight guard.
#
# This script EXCLUDES ./data from the bundle (see the tar --exclude='./data'
# above), so it does NOT deploy the raw-visual adapter (.pt) or the reference
# visual index (.npz/manifest). Those are provisioned on the VM out-of-band.
# It DOES ship the small user-photo rerank pool. That asymmetry is the trap we
# guard against here: the stage-2 rerank compares query embeddings (produced by
# the VM's ACTIVE adapter) against the pool's stored embeddings (produced by
# whatever adapter the pool was BUILT against). If those two adapters differ,
# the embeddings live in different spaces and the boost is meaningless/harmful.
#
# We cannot see the VM's adapter from here, so we verify the locally-active
# adapter against the pool the deployed env actually loads, and we shout the
# out-of-band requirement so the operator confirms the VM adapter matches.
guard_rerank_pool() {
  if [ "${SPOTLIGHT_SKIP_RERANK_GUARD:-0}" = "1" ]; then
    echo "NOTE: rerank-pool guard skipped (SPOTLIGHT_SKIP_RERANK_GUARD=1)." >&2
    return 0
  fi

  echo
  echo "NOTE: this deploy does NOT ship the raw-visual adapter or reference index."
  echo "      (./data is excluded from the bundle.) Only code + the user-photo"
  echo "      rerank pool travel with this deploy. The VM's active adapter/index"
  echo "      must be updated out-of-band, and the shipped rerank pool MUST have"
  echo "      been built in that SAME adapter's embedding space."

  local active_meta="$BACKEND_DIR/data/visual-models/raw_visual_adapter_active_metadata.json"
  local env_file="$BACKEND_DIR/.env.$ENVIRONMENT"

  # The pool the deployed env actually loads (preferred), else any shipped pool.
  local pool_manifest=""
  if [ -f "$env_file" ]; then
    pool_manifest="$(read_dotenv_value "$env_file" "SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_POOL_MANIFEST_PATH")"
  fi
  if [ -n "$pool_manifest" ]; then
    case "$pool_manifest" in
      /*) : ;;
      *) pool_manifest="$REPO_ROOT/$pool_manifest" ;;
    esac
  fi

  # Run the comparison in python3. Exit codes: 0 ok, 2 mismatch (hard abort),
  # 3 indeterminate (warn-only, fail-safe).
  local guard_out=""
  set +e
  guard_out="$(python3 - "$active_meta" "$pool_manifest" "$BACKEND_DIR" <<'PY'
import json, re, sys
from pathlib import Path

active_meta_path = Path(sys.argv[1])
configured_pool = sys.argv[2].strip()
backend_dir = Path(sys.argv[3])

def load(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return None

def version_token(s):
    # Pull an explicit adapter version token like "v010"/"v011" if present.
    if not s:
        return None
    m = re.search(r"v0*(\d+)", str(s))
    return f"v{int(m.group(1))}" if m else None

active = load(active_meta_path)
if not active:
    print("INDETERMINATE|local active adapter metadata missing or unreadable "
          f"at {active_meta_path}")
    sys.exit(3)

active_version = active.get("artifactVersion")
active_generated = active.get("generatedAt")
active_model = active.get("modelId")
active_dim = active.get("embeddingDim")
active_vtok = version_token(active_version)

# Resolve the pool manifest to guard. Prefer the env-configured pool; else fall
# back to the shipped active pool; else any shipped dated pool.
candidates = []
if configured_pool:
    candidates.append(Path(configured_pool))
vidx = backend_dir / "data" / "visual-index"
candidates.append(vidx / "visual_index_user_photos_rerank_pool_active_manifest.json")
for p in sorted(vidx.glob("visual_index_user_photos_rerank_pool_*_manifest.json")):
    candidates.append(p)

pool_path = next((c for c in candidates if c and c.exists()), None)
if pool_path is None:
    # No pool to ship -> nothing to guard. (The bundling step below is also a no-op.)
    print(f"OK|no rerank pool present to guard (active adapter {active_version})")
    sys.exit(0)

pool = load(pool_path)
if not pool:
    print(f"INDETERMINATE|rerank pool manifest unreadable at {pool_path}")
    sys.exit(3)

pool_version = pool.get("artifactVersion")
pool_generated = pool.get("generatedAt")
pool_model = pool.get("modelId")
pool_dim = pool.get("embeddingDimension") or pool.get("embeddingDim")
pool_ckpt = pool.get("adapterCheckpointPath")
pool_vtok = version_token(pool_version)

ctx = (f"active adapter={active_version} (built {active_generated}); "
       f"pool={pool_path.name} version={pool_version} (built {pool_generated}, "
       f"adapterCheckpointPath={pool_ckpt})")

# --- Hard mismatch: model / embedding-dim disagree (different encoder entirely).
if pool_model and active_model and pool_model != active_model:
    print(f"MISMATCH|pool modelId {pool_model!r} != active adapter modelId "
          f"{active_model!r}. {ctx}")
    sys.exit(2)
if pool_dim and active_dim and int(pool_dim) != int(active_dim):
    print(f"MISMATCH|pool embedding dim {pool_dim} != active adapter dim "
          f"{active_dim}. {ctx}")
    sys.exit(2)

# --- Hard mismatch: explicit, differing adapter-version tokens on both sides.
# Pools built against a specific adapter often carry that token (e.g. "...-v011").
# If both carry a token and they differ, the pool was built in another space.
if active_vtok and pool_vtok and active_vtok != pool_vtok:
    print(f"MISMATCH|pool adapter-version token {pool_vtok} != active adapter "
          f"token {active_vtok}. {ctx}")
    sys.exit(2)

# --- Hard mismatch: pool predates the active adapter swap. The pool's
# adapterCheckpointPath points at the rolling raw_visual_adapter_active.pt, so a
# pool built BEFORE the current adapter became active was necessarily built in a
# prior adapter's space.
def parse_ts(s):
    if not s:
        return None
    try:
        from datetime import datetime, timezone
        s2 = str(s).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s2)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None

a_ts = parse_ts(active_generated)
p_ts = parse_ts(pool_generated)
if a_ts and p_ts and p_ts < a_ts:
    print(f"MISMATCH|rerank pool was built ({pool_generated}) BEFORE the current "
          f"active adapter became active ({active_generated}), so it was built in "
          f"a prior adapter's embedding space. {ctx}")
    sys.exit(2)

# --- Could not positively confirm a match (e.g. no tokens, no timestamps).
if not ((active_vtok and pool_vtok) or (a_ts and p_ts)):
    print(f"INDETERMINATE|could not compare adapter versions (no version tokens "
          f"and no comparable build timestamps). {ctx}")
    sys.exit(3)

print(f"OK|rerank pool appears built in the active adapter's space. {ctx}")
sys.exit(0)
PY
)"
  local guard_rc=$?
  set -e

  local guard_kind="${guard_out%%|*}"
  local guard_msg="${guard_out#*|}"

  case "$guard_rc" in
    0)
      echo "Rerank-pool guard: OK. $guard_msg"
      ;;
    3)
      echo >&2
      echo "WARNING: rerank-pool guard could not verify adapter/pool match." >&2
      echo "         $guard_msg" >&2
      echo "         Proceeding (fail-safe). Manually confirm the shipped pool was" >&2
      echo "         built in the VM's active adapter space before relying on rerank." >&2
      echo "         Set SPOTLIGHT_SKIP_RERANK_GUARD=1 to silence this." >&2
      ;;
    2)
      echo >&2
      echo "ABORT: rerank-pool / adapter embedding-space MISMATCH detected." >&2
      echo "       $guard_msg" >&2
      echo >&2
      echo "       Shipping this pool would compare embeddings from two different" >&2
      echo "       adapters, producing meaningless or harmful stage-2 rerank boosts." >&2
      echo >&2
      echo "       Rebuild the pool in the active adapter's space, e.g.:" >&2
      echo "         python3 tools/build_user_photo_rerank_pool.py \\" >&2
      echo "           --adapter-checkpoint backend/data/visual-models/raw_visual_adapter_active.pt \\" >&2
      echo "           --output-dir backend/data/visual-index \\" >&2
      echo "           --artifact-version <new-pool-version>" >&2
      echo "       then point SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_POOL_{NPZ,MANIFEST}_PATH" >&2
      echo "       in backend/.env.$ENVIRONMENT at the new pool and redeploy." >&2
      echo >&2
      echo "       If you are certain the pool matches the VM's active adapter," >&2
      echo "       re-run with SPOTLIGHT_SKIP_RERANK_GUARD=1 to override." >&2
      exit 1
      ;;
    *)
      echo >&2
      echo "WARNING: rerank-pool guard exited unexpectedly (rc=$guard_rc); proceeding." >&2
      echo "         ${guard_out:-<no output>}" >&2
      ;;
  esac
}

guard_rerank_pool

# Ship the user-photo rerank pool with the bundle. It is small (~1MB) and changes
# as new confirmed scans accrue, so unlike the large reference index (provisioned
# on the VM separately and excluded above) it travels with each deploy. The remote
# extract is additive — it drops these files into data/visual-index without
# disturbing the index already on the VM.
if compgen -G "$BACKEND_DIR/data/visual-index/visual_index_user_photos_rerank_pool_*" > /dev/null; then
  mkdir -p "$BUNDLE_ROOT/data/visual-index"
  cp "$BACKEND_DIR"/data/visual-index/visual_index_user_photos_rerank_pool_* "$BUNDLE_ROOT/data/visual-index/"
fi

# Ship the placeholder card-back denylist (tiny) so the matcher excludes the
# card-back "attractor" entries on the VM. The matcher reads it from beside the
# active manifest (data/visual-index/placeholder_card_ids.json); additive extract
# drops it in without touching the reference index already provisioned there.
if [ -f "$BACKEND_DIR/data/visual-index/placeholder_card_ids.json" ]; then
  mkdir -p "$BUNDLE_ROOT/data/visual-index"
  cp "$BACKEND_DIR/data/visual-index/placeholder_card_ids.json" "$BUNDLE_ROOT/data/visual-index/"
fi

BUNDLE_ARCHIVE="$TMP_DIR/backend-bundle.tgz"
COPYFILE_DISABLE=1 tar --exclude='./._*' -C "$BUNDLE_ROOT" -czf "$BUNDLE_ARCHIVE" .

echo "Syncing backend bundle to $INSTANCE ($ZONE)..."
gcloud_cmd compute scp "$BUNDLE_ARCHIVE" "$INSTANCE:$REMOTE_BUNDLE_PATH" --zone "$ZONE" --tunnel-through-iap
gcloud_cmd compute scp "$SECRETS_FILE" "$INSTANCE:$REMOTE_SECRET_PATH" --zone "$ZONE" --tunnel-through-iap

REMOTE_SETUP_COMMAND="mkdir -p $REMOTE_DIR && tar -C $REMOTE_DIR -xzf $REMOTE_BUNDLE_PATH && find $REMOTE_DIR -maxdepth 1 -name '._*' -delete"
echo "Extracting bundle on the VM..."
gcloud_cmd compute ssh "$INSTANCE" --zone "$ZONE" --tunnel-through-iap --command "$REMOTE_SETUP_COMMAND"

REMOTE_DEPLOY_COMMAND="cd $REMOTE_DIR && bash deploy.sh $ENVIRONMENT $REMOTE_SECRET_PATH"
echo "Running VM-local deploy..."
gcloud_cmd compute ssh "$INSTANCE" --zone "$ZONE" --tunnel-through-iap --command "$REMOTE_DEPLOY_COMMAND"

REMOTE_HEALTH_COMMAND="cd $REMOTE_DIR && bash run_vm_health_check.sh"
echo "Running post-deploy VM health check..."
gcloud_cmd compute ssh "$INSTANCE" --zone "$ZONE" --tunnel-through-iap --command "$REMOTE_HEALTH_COMMAND"

PUBLIC_BASE_URL="$(read_dotenv_value "$MOBILE_ENV_DIR/.env.$ENVIRONMENT" "EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL")"
if [ -n "$PUBLIC_BASE_URL" ]; then
  echo "Running public health check against ${PUBLIC_BASE_URL%/}/api/v1/health..."
  # After a restart the service can take well over 20s to answer publicly
  # (e.g. SigLIP2 visual-model load + reverse-proxy warm-up). A single
  # short-timeout curl false-fails an otherwise-successful deploy, so poll with
  # a generous budget and only fail if it never comes up.
  PUBLIC_HEALTH_OK=0
  for attempt in $(seq 1 18); do
    if curl -fsS --max-time 15 "${PUBLIC_BASE_URL%/}/api/v1/health" >/dev/null 2>&1; then
      PUBLIC_HEALTH_OK=1
      [ "$attempt" -gt 1 ] && echo "  public health passed on attempt ${attempt}."
      break
    fi
    echo "  public health not ready yet (attempt ${attempt}/18); retrying in 10s..."
    sleep 10
  done
  if [ "$PUBLIC_HEALTH_OK" != "1" ]; then
    echo "Public health check never passed within the warm-up budget (~5m)." >&2
    exit 1
  fi
fi

echo
echo "Deploy finished."
echo "Environment: $ENVIRONMENT"
echo "Instance: $INSTANCE"
echo "Zone: $ZONE"
echo "Remote dir: $REMOTE_DIR"
