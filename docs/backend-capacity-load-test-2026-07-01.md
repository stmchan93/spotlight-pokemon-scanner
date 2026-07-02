# Backend capacity — load test + VM sizing (2026-07-01)

**Question:** what VM do we need for a beta of 50–100 users (up to ~1000
signups), and can we survive 300 concurrent users?

**Answer (TL;DR):**

| Population on the app *right now* | Verdict on t2d-standard-4 (current) | What you'd need |
| --- | --- | --- |
| 10–30 concurrent (≈ 50–100 beta signups at peak) | **Comfortable.** Scans p95 ≈ 2–3s, browse fast. | Nothing. Ship the beta on the current VM. |
| ~100 concurrent (≈ 500–1000 signups at peak) | **Degraded but alive.** Scans fine (p95 3.4s, 0% shed); Collection/dashboard slow (4–5s) with ~13% silent-retry 503s. | t2d-standard-8, or ship the caching fixes below first. |
| 300 concurrent | **Fails.** CPU pinned (99%), scans p95 8.6s with 28% shed, >50% of heavy reads shed. | ~16 vCPUs of compute (t2d-standard-16, or 4× standard-4 behind a LB) *plus* the software levers below. |

Signups → concurrency rule of thumb: peak concurrent ≈ 10–20% of active
signups. A 1000-user beta ≈ 100–200 concurrent at peak → **t2d-standard-8 is
the right next resize**, not standard-16.

## How this was measured

Harness: `tools/loadtest/` (k6). New `mixed.js` models a population directly:
N users = 90% browsers (one read per ~8–12s: Collection list / dashboard /
card detail) + 10% concurrently scanning (one scan per ~5–7s). Target:
staging `t2d-standard-4` (4 vCPU / 16 GB) via the real TLS hostname, real
auth, real card JPEGs from the QA corpus, scan-artifact uploads disabled for
the run (restored after). VM watched with `watch-cpu.sh` (vmstat).

Caveat: all VUs share one account with a large collection, so browse costs are
*pessimistic* vs. fresh beta users (whose decks are small); scan cost is
account-independent. Single-run numbers, ~60–150s per level.

## Results

### Scanner capacity curve (dedicated scanners, THINK=4s)

| Concurrent scanners | p95 | 503 shed rate | Successful scans/s |
| --- | --- | --- | --- |
| 2 | 1.8s | 0% | 0.4 |
| 10 | 3.2s | 0% | 1.7 |
| 20 | 6.6s | 0% | 2.2 |
| 30 | 9.4s | 11% | 2.6 |
| 40 | 11.7s | 30% | 2.6 (plateau) |

- Solo scan/match ≈ 1.2–1.5s; sustained throughput plateaus at ≈ **2.5
  scans/s** on 3 inference slots → **≈ 1.2 vCPU-seconds per scan**. This is
  the fundamental cost driver.
- Safe ceiling on this VM: **~10–12 concurrent scanners** (p95 < 3s SLO); 503
  shedding starts between 20–30.

### Mixed population (the product question)

| Users (90/10 browse/scan) | Scan p95 | Scan 503 | Deck entries p95 | Dashboard p95 | http_req_failed |
| --- | --- | --- | --- | --- | --- |
| 100 | 3.4s | 0% | 5.3s | 4.2s | 13% (fast 503s, app retries silently) |
| 300 | 8.6s | 28% | 6.0s (max 59s) | 4.5s (max 59s) | 54% |

### Which wall

vmstat during the 300-user run: `us≈90 sy≈8 id≈1 wa=0`, run queue 5–10 on 4
vCPUs → **pure CPU saturation**. Disk (`wa`) stayed at 0 — the price-history
cold-read work from earlier this year is not the bottleneck anymore; the page
cache (~12.5 GB) holds the DB. Don't buy disk; buy CPU or shed CPU work.

The two CPU consumers:
1. **Scan inference** (`/scan/match`): ~1.2 vCPU-s each, guarded by the scan
   semaphore (vCPUs−1 slots, 6s wait → 503 → app silently retries).
2. **Heavy reads** (deck entries ~0.8–0.9s, dashboard, history): guarded by the
   heavy-read semaphore (=vCPUs slots, 3s wait → 503 → silent retry). At 90+
   concurrent browsers most of these time out of the queue — that's the 13–54%
   "failure" rate (it's backpressure working as designed, but past ~100 users
   there isn't enough CPU for the queue to drain).

## Sizing model

Demand ≈ `N × 0.10 / 6.5s × 1.2 vCPU-s` (scans) + `N × 0.90 / 12s × ~0.35
vCPU-s` (browse mix) ≈ **0.045 vCPU per concurrent user**, so:

| Concurrent users | vCPUs needed (with ~30% headroom) | Cheapest GCP shape |
| --- | --- | --- |
| 30 | ~2 | t2d-standard-2 (current daily driver is already 4) |
| 100 | ~6 | t2d-standard-8 |
| 300 | ~18 | t2d-standard-16 (accept brief p95 blips) or 2× standard-8 |
| 1000 | ~60 | horizontal: LB + 4–8× standard-8, inference split out |

t2d monthly ballpark (us-central1, on-demand): standard-4 ≈ $150, standard-8 ≈
$300, standard-16 ≈ $600. Resizing is a stop-start of the one VM (minutes of
downtime) — the semaphores auto-scale with core count, no config change.

## Cheaper-than-CPU software levers (in order)

1. **Cache the heavy reads.** Dashboard/entries are recomputed per request; a
   per-user in-process cache with a 30–60s TTL (invalidated on writes) would
   collapse the browse load — browsers re-poll the same unchanged data. This
   is the single biggest win for the 100→300 range and costs no hardware.
2. **INT8 encoder** (already deferred to next retrain): ~2× cheaper inference
   → scan capacity doubles to ~5 scans/s per 4 vCPUs.
3. **Split inference from CRUD** (only needed at 300+): a dedicated inference
   VM (or two) behind the same API keeps browse latency flat while scans queue
   independently.
4. GPU inference — not worth it below ~10 scans/s sustained.

## Recommendation for the beta

- **50–100 signups → keep t2d-standard-4.** Expected peak ≈ 10–20 concurrent;
  every metric is green at that level (scans p95 ≈ 2–3s, browse sub-second when
  uncontended).
- Before opening to ~1000 signups: resize to **t2d-standard-8** (one command,
  ~$150/mo more) *and* do lever #1 (heavy-read caching) — that combination
  covers ~200 concurrent comfortably.
- Re-run this harness after either change:
  `k6 run --env USERS=300 ... tools/loadtest/mixed.js` — the pass criterion is
  scan p95 < 3s, scan 503 < 1%, deck entries p95 < 2s.

## Repro

```bash
bash tools/loadtest/mint-token.sh                     # writes tools/loadtest/.token
# corpus: cp qa/raw-footer-layout-check/*/runtime_normalized.jpg → tools/loadtest/corpus/cardN.jpg
# disable artifact uploads (restore after):
curl -X POST $BASE/api/v1/admin/scan-artifact-uploads -H "Authorization: Bearer $TOK" \
  -d '{"enabled": false, "note": "loadtest"}'
IMGS=corpus/card1.jpg,...,corpus/card6.jpg
k6 run --env PROFILE=smoke --env SMOKE_VUS=20 --env SMOKE_DURATION=60s \
  --env BASE_URL=$BASE --env TOKEN=$TOK --env IMAGE_LIST=$IMGS tools/loadtest/scanner.js
k6 run --env USERS=300 --env DURATION=150s \
  --env BASE_URL=$BASE --env TOKEN=$TOK --env IMAGE_LIST=$IMGS tools/loadtest/mixed.js
VM=spotlight-backend-vm-small ZONE=us-central1-b tools/loadtest/watch-cpu.sh   # 2nd terminal
```
