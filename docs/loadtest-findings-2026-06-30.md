# Backend load-test findings & fixes — 2026-06-30

Pre-production capacity test of the staging backend, plus the two code fixes that
came out of it. VM sizing is tracked separately (owner is handling it).

## Setup

- **Target:** staging `https://looty.34.59.188.129.sslip.io`, VM `spotlight-backend-vm-small` = **4 vCPU / 15 GB** (`t2d-standard-4`), in card-show mode (live Scrydex blocked → zero credit risk during the test).
- **Harness:** `tools/loadtest/` (k6). `scanner.js` ramps `POST /scan/match`; `collections.js` ramps the read endpoints; `health.js` is a no-auth baseline; `watch-cpu.sh` streams `vmstat` over `gcloud ssh`. One k6 VU ≈ one concurrent user.
- **Method:** ramp virtual users, find where latency hockey-sticks / errors appear. Synthetic image (encoder cost representative; match quality irrelevant for capacity). ~90s ramps (knee-finding, not a sustained soak).

## Results

### Scanner — `POST /scan/match` (ramp to 20 concurrent)
| | value |
|---|---|
| 1 scan, idle | ~1.5s |
| p95 under ramp to 20 | ~6–7.6s (max ~15s) |
| 503 / errors | 0 (semaphore queued rather than rejected) |
| throughput ceiling | ~1.8–2 scans/sec |
| **CPU during ramp** | idle 57% → **0%**, user **99%**, run-queue **4/4**, iowait ~0 |

Encoder allows only **3 concurrent inferences** (vCPU−1). **CPU-bound, not disk-bound.** Comfortably serves ~5–8 simultaneous scanners under 3s; degrades steeply beyond. A 20–30 person show overwhelms this VM.

### Reads / collections (ramp to 30 concurrent)
- **Solo, all fast:** `deck/entries?limit=200` 0.83s · `portfolio/dashboard` 0.58s · `portfolio/history?days=30` 1.43s.
- **Under 30 concurrent it collapses:** `portfolio/history` hit the **60s timeout on every call**, ~16% request failures, throughput < 1 req/s.
- Root cause: load hit **6.3 on 4 vCPU while the server process was only ~3% CPU** → threads blocked in **I/O wait**. The single-process Python threading server + SQLite **serialize under concurrent heavy reads** — they don't degrade gracefully, they fall off a cliff.

### Artifact storage (ON vs OFF comparison)
- **No consistent effect on scan latency** — artifact upload is a separate, async, scan-event-gated call that doesn't block the encoder.
- **Real finding (race):** the upload is fired in parallel with the match and looks up the match's `scan_events` stub; under load that stub write can lose the race / fail on write contention, and the upload then 404'd ("scan event not found") and was dropped — the mechanism behind past "card-show scans lost images." (The fix below makes the upload self-create the stub so it always lands.)
- **NOTE — earlier "0% persisted to GCS" was a measurement error, not a bug.** Two mistakes on my side: (1) the k6 harness checked the artifact response for HTTP `200`, but the endpoint returns `202 Accepted` on success; (2) I listed `gs://looty-prod` (a stale env-file value) when the *running* server uploads to `gs://looty-staging`. Verified ground truth: uploads succeed end-to-end — DB rows record `uploaded` **and** the JPEGs are present in `gs://looty-staging/scans/.../`. The harness metric is fixed (accept any 2xx) and now reports 100% uploaded.

## Fixes applied (this commit)

Both mirror the existing scan-inference-semaphore pattern and ship with tests; full backend suite (474) green.

1. **Read backpressure** (`backend/server.py`). New `_heavy_read_semaphore` (separate pool from scan inference — those are CPU-bound, these are I/O-bound) caps concurrent heavy reads and `_acquire_heavy_read_slot()` returns a fast retryable **503 `ServerBusy`** when the wait exceeds the timeout. Wrapped around `dashboard`, `history`, `ledger`, `deck/entries`. Turns the 60s-hang cliff into a fast, graceful shed.
   - Tunables: `SPOTLIGHT_MAX_CONCURRENT_HEAVY_READS` (default `~1 per core` = 4 here; tightened from cores×2 after a re-run showed 8 still thrashed the disk), `SPOTLIGHT_HEAVY_READ_ACQUIRE_TIMEOUT_S` (default 3s). Validated re-run: `portfolio/history` under 30 concurrent went 60s-timeout-on-every-call → median 3s / p95 ~19s, no timeouts; excess sheds fast and the client retries it silently.
2. **Artifact upload race** (`backend/server.py` `store_scan_artifacts`). When no `scan_events` row exists for the scanID, the handler now **self-creates an `in_progress` stub** instead of 404'ing, so the JPEG still lands when the match's own stub write races/fails under load. The match's later `_log_scan` upserts the real fields via `ON CONFLICT`. **Cross-user isolation preserved**: if the scanID exists for a *different* user, it still rejects (never creates/hijacks another user's row).

## Verdict & remaining levers

This 4-vCPU VM is **not ready for meaningful concurrent production load** as-is; both paths wall out at modest concurrency. The fixes above make failures *graceful* and stop losing scan images, but do not raise raw capacity. Remaining levers (not done here):

- **Scanner (CPU-bound):** bigger machine / more vCPUs (≈ linear gain in concurrent scanners), or horizontal scaling behind a LB. *(Owner is handling VM sizing.)*
- **Reads (I/O + serialization):** the threading-server + SQLite is the ceiling — caching/prewarm for `history`, read replicas / Postgres for hot tables. Deferred until sustained concurrent load justifies it.
- **Note on the active artifact bucket:** the running staging server writes scan artifacts to `gs://looty-staging` (per `/api/v1/health` → `scanArtifactUploads.activeBucketName`), even though `backend/.env.staging.secrets` lists `looty-prod`. Not a blocker, but worth reconciling so the configured and active bucket agree.
- **Client side:** the read 503s are `retryable: true`; the app could add a short backoff-retry so a brief spike is invisible to users.

## Re-running the harness

```bash
brew install k6
# you run this (uses the privileged service-role key):
bash tools/loadtest/mint-token.sh          # -> tools/loadtest/.token
# drop a real card JPEG in tools/loadtest/corpus/, then:
cd /Users/stephenchan/Code/spotlight
TOKEN=$(cat tools/loadtest/.token); BASE=https://looty.34.59.188.129.sslip.io
k6 run --env PROFILE=ramp --env MAX_VUS=20 --env BASE_URL=$BASE --env TOKEN=$TOKEN \
  --env IMAGE_LIST=$PWD/tools/loadtest/corpus/<your>.jpg tools/loadtest/scanner.js
k6 run --env PROFILE=ramp --env MAX_VUS=60 --env BASE_URL=$BASE --env TOKEN=$TOKEN tools/loadtest/collections.js
# watch the VM in a second terminal:
VM=spotlight-backend-vm-small ZONE=us-central1-b tools/loadtest/watch-cpu.sh
```

See `tools/loadtest/README.md` for the full runbook, SLO targets, and safety checklist. Test byproducts (synthetic images, `lt-*` scan rows) were cleaned up after this run.
