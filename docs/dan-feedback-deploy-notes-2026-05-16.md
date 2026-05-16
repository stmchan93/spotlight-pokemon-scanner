# Dan-feedback deploy notes (2026-05-16)

## Summary

This PR fixes three pieces of Pokemon-card scanner feedback Dan flagged:
language confusion on basic energy cards, basic-energy top-1 misfires
(e.g. Japanese "Basic Metal Energy" returning for an English query), and
the missing `volumeLevel` field on the card market-history response. The
ML side ships two new gitignored runtime artifacts (a basic-energy
mini-index and a JP/EN logistic-regression language probe) plus
build/audit tooling under `tools/`. The backend agent wires those
artifacts into the matcher and adds `volumeLevel` to the API response;
the RN agent updates the client to surface the new field.

## Generated artifacts (gitignored)

These two `.npz` files are runtime artifacts. They are NOT committed to
git; they ride along by being scp'd to the VM at deploy time. The
scripts under `tools/` are the source-of-truth for how to regenerate
them.

| Path | Size | Regenerate with |
| --- | --- | --- |
| `backend/data/visual-index/basic_energy_mini_index.npz` | ~160 KB | `python tools/build_basic_energy_mini_index.py` |
| `backend/data/visual-models/language_probe_v1.npz` | ~4 KB | `python tools/train_jp_en_language_probe.py` |

Both scripts default their `--source-index` / `--source-manifest`
arguments to the active runtime index at
`backend/data/visual-index/visual_index_active_*`, so they pick up
whatever adapter version is currently published (v009 on staging at the
time of writing).

### basic_energy_mini_index.npz

Slice of the active visual index restricted to entries where
`supertype == "Energy"` AND `name` starts with `"Basic "` AND ends with
`" Energy"`. As of 2026-05-16 this is 78 entries (30 English, 48
Japanese) spanning all 8 basic types (Darkness, Fighting, Fire, Grass,
Lightning, Metal, Psychic, Water).

Schema (consumed by `backend/raw_visual_matcher.py`):

```
embeddings : float32 (N, 512), L2-normalized
card_ids   : object  (N,)  providerCardId
names      : object  (N,)  e.g. "Basic Fire Energy"
languages  : object  (N,)  "English" | "Japanese"
set_names  : object  (N,)  human-readable set name
```

### language_probe_v1.npz

Logistic-regression probe over CLIP embeddings classifying English vs
Japanese. Trained on all 43,982 entries of the active visual index
(23,441 English + 20,541 Japanese) with an 80/20 stratified split and
`C=1.0`. Held-out test accuracy: **99.00%**. Per-class precision/recall
all 0.99. Confusion matrix:

```
            English  Japanese
English      4660       29
Japanese       59     4049
```

Schema (consumed by `backend/raw_visual_matcher.py`):

```
coef       : float32 (2, 512)  softmax-ready; rows align with classes
intercept  : float32 (2,)
classes    : object  (2,)      ['English', 'Japanese']
```

sklearn binary LR ships `(1, n_features)` weights for the positive class
only; the trainer reformats these into `(2, n_features)` one-hot
softmax shape so the backend can use a uniform softmax interface for
both binary and future multi-class probes.

## Deploy to staging VM

The standard backend deploy (`tools/deploy_backend.sh staging`) excludes
the `data/` directory from its bundle, so the two new `.npz` files must
be copied to the VM out-of-band before (or alongside) the backend
deploy. The VM serves both `backend/data/visual-index/` and
`backend/data/visual-models/` as live runtime read paths.

Target VM (matches `tools/restore_staging_db_local.sh` and
`tools/deploy_backend.sh`):

```
INSTANCE = spotlight-backend-vm-small
ZONE     = us-central1-b
PROJECT  = spotlight-492502
REMOTE   = /home/stephenchan/spotlight/data
```

Step-by-step:

```bash
# 1. Regenerate locally so the artifacts pick up the current active index.
.venv-raw-visual-poc/bin/python tools/build_basic_energy_mini_index.py
.venv-raw-visual-poc/bin/python tools/train_jp_en_language_probe.py

# 2. Copy to the VM.
gcloud compute scp \
  backend/data/visual-index/basic_energy_mini_index.npz \
  spotlight-backend-vm-small:/home/stephenchan/spotlight/data/visual-index/basic_energy_mini_index.npz \
  --zone=us-central1-b --project=spotlight-492502

gcloud compute scp \
  backend/data/visual-models/language_probe_v1.npz \
  spotlight-backend-vm-small:/home/stephenchan/spotlight/data/visual-models/language_probe_v1.npz \
  --zone=us-central1-b --project=spotlight-492502

# 3. Deploy the backend bundle (this restarts the service, which reloads
#    the new artifacts from disk).
pnpm backend:deploy:staging
```

Sanity check on the VM after scp (run before the backend restart):

```bash
gcloud compute ssh spotlight-backend-vm-small \
  --zone=us-central1-b --project=spotlight-492502 \
  --command="ls -lh /home/stephenchan/spotlight/data/visual-index/basic_energy_mini_index.npz \
                    /home/stephenchan/spotlight/data/visual-models/language_probe_v1.npz"
```

## Verification post-deploy

The market-history endpoint now returns `volumeLevel`. Pick a card id
from staging (anything raw with snapshots, e.g. the most recently
scanned card) and confirm the field is present and non-null:

```bash
BASE_URL="$(grep EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL apps/spotlight-rn/.env.staging | cut -d= -f2-)"
CARD_ID="svp-86"   # substitute a card id known to have snapshots
curl -fsS "${BASE_URL%/}/api/v1/cards/${CARD_ID}/market-history" | jq '.volumeLevel'
```

The response should now contain a top-level `"volumeLevel"` key with a
string value like `"low"`, `"medium"`, or `"high"`. Before this PR the
key was absent.

To smoke-check the matcher's new energy + language behavior, run the
scanner against an English basic-energy fixture and confirm the top-1
returns an English card_id (not a Japanese one). Sample fixtures live in
`qa/raw-footer-layout-check/`.

## Backfill audit (impact quantification)

Run the audit on the latest staging snapshot to confirm the problem the
probe is meant to solve is still measurable in production traffic:

```bash
pnpm backend:restore:local          # refresh local snapshot from VM
.venv-raw-visual-poc/bin/python tools/backfill_language_probe_inference.py
```

As of 2026-05-16 the local snapshot showed **18.6%** of scans with a
known device locale + known card language had a predicted-card language
that did not match the device locale (99 of 532 audited scans in the
last 30 days). The CSV lands at
`tools/output/language_probe_backfill_audit.csv`.

This script does NOT rerun the probe over historical scans -- we do not
persist image embeddings at scan time. It just audits the existing
predictions for locale mismatch as a proxy impact stat.

## Rollback

The matcher loads both `.npz` files lazily and is expected to no-op
gracefully when either is missing. The fast rollback if the new behavior
misbehaves is therefore:

```bash
gcloud compute ssh spotlight-backend-vm-small \
  --zone=us-central1-b --project=spotlight-492502 \
  --command="mv /home/stephenchan/spotlight/data/visual-index/basic_energy_mini_index.npz{,.disabled} \
            && mv /home/stephenchan/spotlight/data/visual-models/language_probe_v1.npz{,.disabled} \
            && sudo systemctl restart spotlight-backend"
```

If the backend agent gates the new code behind an env flag, prefer
flipping that flag off in `backend/.env.staging.secrets` and redeploying
instead -- file moves should be the last resort.

For the API-side `volumeLevel` change, revert the relevant backend
commit and redeploy with `pnpm backend:deploy:staging`.
