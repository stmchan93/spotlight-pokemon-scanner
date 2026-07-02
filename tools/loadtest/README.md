# Backend load testing (k6)

Decide if the backend is production-ready by finding **how many concurrent users
the VM can handle before scans time out**. The scanner runs a CPU-bound visual
encoder guarded by a semaphore (`SPOTLIGHT_MAX_CONCURRENT_SCAN_INFERENCES`,
default = vCPUs − 1, 6s acquire timeout → HTTP 503 `ScannerBusy`). So the real
question is: *at what concurrency does latency hockey-stick / do 503s start?*
That number is your max safe simultaneous scanners — compare it to your real
peak (e.g. a card show with N people each scanning every few seconds).

**One VU ≈ one concurrent user.** Each VU loops: do a request, then a think-time
pause. Ramp VUs up and read the curve.

## 0. Install

```bash
brew install k6          # load tool
# gcloud already installed (used by watch-cpu.sh)
```

## 1. Define "ready" (your SLOs)

Pick pass/fail targets before running (the scripts ship with these as
thresholds — edit to taste):

| Metric | Target |
| --- | --- |
| scan match p95 | < 3s |
| scan match p99 | < 6s |
| scan error rate (non-503) | < 1% |
| portfolio dashboard p95 | < 5s (cold-cache disk I/O lives here) |

Then decide your **peak concurrency** to test against — model it on a card show,
not abstract RPS (e.g. 20–30 people, each scanning ~every 4s).

## 2. Safety checklist (do this first)

- **Target a STAGING VM sized like prod** — never load-test prod-with-real-users.
  Beware burst-credit throttling on shared-core `e2` types; it distorts results.
- **Scan-artifact uploads OFF.** Confirm on the target:
  `curl -s "$BASE_URL/api/v1/health" | grep -o '"enabled":[a-z]*'` — the
  `scanArtifactUploads.enabled` should be `false` (it's the default). This keeps
  the test from writing images to GCS / polluting training data.
- **No Scrydex credits.** These scripts only hit DB-backed reads + scan/match.
  They never call `recent-sales?refresh=true` or `refresh-pricing` (those cost
  credits). Don't add them.
- **Corpus is private.** Put your own card JPEGs in `corpus/` — it's gitignored.
  Do not commit scan captures.

## 3. Get a token

Staging has `SPOTLIGHT_AUTH_REQUIRED=true`, so you need a Supabase JWT. Grab one
from a signed-in app session (or your Supabase project) and pass it as `TOKEN`
(with or without the `Bearer ` prefix). For a local instance with auth off you
can omit `TOKEN`.

## 4. Run — smoke FIRST, then ramp

Always smoke at low concurrency first to prove auth + the request shape + the
image upload work end-to-end. Only then ramp.

```bash
cd /Users/stephenchan/Code/spotlight     # run from repo root so corpus/ paths resolve
BASE=http://<staging-vm-ip>:8788
TOK=<jwt>

# --- Scanner (the critical one) ---
# smoke
k6 run --env PROFILE=smoke --env BASE_URL=$BASE --env TOKEN=$TOK \
  --env IMAGE_LIST=tools/loadtest/corpus/card1.jpg,tools/loadtest/corpus/card2.jpg \
  tools/loadtest/scanner.js
# ramp to 40 concurrent scanners
k6 run --env PROFILE=ramp --env MAX_VUS=40 --env BASE_URL=$BASE --env TOKEN=$TOK \
  --env IMAGE_LIST=tools/loadtest/corpus/card1.jpg,tools/loadtest/corpus/card2.jpg \
  tools/loadtest/scanner.js

# --- Collections / general browse ---
k6 run --env PROFILE=smoke --env BASE_URL=$BASE --env TOKEN=$TOK tools/loadtest/collections.js
k6 run --env PROFILE=ramp --env MAX_VUS=60 --env BASE_URL=$BASE --env TOKEN=$TOK tools/loadtest/collections.js
```

In a **second terminal**, watch the VM the whole time:

```bash
VM=spotlight-backend-vm-small ZONE=us-central1-b tools/loadtest/watch-cpu.sh
```

### Useful knobs (`--env`)
| Var | Default | Meaning |
| --- | --- | --- |
| `PROFILE` | `smoke` | `smoke` (constant low VUs) or `ramp` (capacity curve) |
| `MAX_VUS` | `40` | top of the ramp = peak concurrent users |
| `THINK` | `4` (scan) / `3` (browse) | seconds a VU waits between actions |
| `ENDPOINT` | `/api/v1/scan/match` | use `/api/v1/scan/visual-match` to isolate the encoder |
| `MODE` | `raw_card` | `raw_card` or `psa_slab` |
| `LANG` | `english` | `english` or `japanese` |
| `STEP_SECS`/`HOLD_SECS` | `20`/`45` | ramp step + hold durations |
| `CARD_IDS` | (auto from deck) | comma-separated card IDs for card-detail hits |

## 5. Read the results

k6 prints per-metric p50/p90/p95/p99 + rates at the end. The deliverable is a
**capacity curve** — re-run the ramp and note where each wall appears:

- **`scan_latency_ms` p95/p99** — climbs gently, then hockey-sticks. The
  concurrency just before the knee is your safe ceiling.
- **`scanner_busy_503` rate** — > 0 means you exceeded encoder capacity (requests
  queued past the 6s timeout). First non-zero point ≈ the ceiling.
- **`scan_error` rate** — real failures (not backpressure). Should stay ~0.
- **`watch-cpu.sh`**: `id` (idle) → 0 means **CPU-bound** (buy vCPUs / scale out);
  `wa` (iowait) spiking means **disk-bound** cold reads (optimize the query/cache,
  don't just add CPU); `r` (run queue) ≫ vCPUs means everything is queueing.

**Verdict:** if your safe ceiling ≥ modeled peak with headroom → ready. If not,
the wall tells you the fix: CPU-bound → bigger/more VMs; disk-bound → optimize
the cold-cache paths first (cheaper).

## Files
- `scanner.js` — POST /api/v1/scan/match ramp (the capacity test)
- `collections.js` — deck/entries + portfolio dashboard/history + card detail
- `mixed.js` — a POPULATION: `USERS=300` → 90% browsers + 10% scanners, so a
  run answers "can we survive N users on the app?" directly. Results + sizing
  model: `docs/backend-capacity-load-test-2026-07-01.md`
- `lib.js` — shared base-URL/auth/ramp helpers
- `watch-cpu.sh` — vmstat over gcloud ssh, run alongside k6
- `corpus/` — your private card JPEGs (gitignored). NOTE: `IMAGE_LIST` paths
  resolve relative to this directory (k6 script dir), e.g.
  `IMAGE_LIST=corpus/card1.jpg,corpus/card2.jpg`
- `mint-token.sh` — mint a 1h staging JWT into `.token` (gitignored)
