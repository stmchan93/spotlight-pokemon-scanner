# Visual Match Tail Latency Investigation Plan

Date: 2026-05-18

## Status

- Investigation plan + execution guide for the raw `visualMatchMs` p90 tail.
- Goal: drop raw-scan p90 server-side compute from ~1500ms to <800ms by attributing and fixing the dominant tail source.
- Current phase status:
  - Phase A code (sub-phase instrumentation): **complete locally, not yet deployed**
  - Phase A deploy + data accumulation: not started
  - Phase B analysis (attribute the tail from real data): not started
  - Phase C concurrent-load profiling: not started
  - Phase D targeted fix (hypothesis-driven): not started

## Why This Exists

User-felt scan latency on raw cards is dominated by server-side compute, not network or client work. From 7 days of staging logs (n=256 raw scans, 2026-05-11 → 2026-05-18):

| Phase | p50 | p90 | max |
|---|---|---|---|
| `visualMatchMs` (server) | 349ms | **1489ms** | 11907ms |
| `candidateEncodeMs` (server) | 97ms | 317ms | 1894ms |
| `responseBuildMs` (server) | 98ms | 318ms | 1895ms |

The 4× p90/p50 ratio on `visualMatchMs`, with an 11-second outlier, is the largest single source of user-felt scan-time variance. The fixed cost (p50) is fine. The variance is what makes the experience feel slow on a bad scan.

`visualMatchMs` is the wall-clock for `RawVisualMatcher.match_payload` in [`backend/raw_visual_matcher.py:985`](/Users/stephenchan/Code/spotlight/backend/raw_visual_matcher.py:985). It covers:

1. JPEG decode of the query image
2. Runtime/adapter lazy-init (cached after first call)
3. `_query_variants` — generates 1-N variant crops
4. Per-variant: encoder preprocess → encoder forward (CLIP) → encoder postprocess → adapter project → embedding normalize → FAISS index search → language reranker
5. Final aggregation across variants

The wall-clock is logged but the **sub-phase breakdown is computed and then dropped**. The matcher fills `debug["timings"]` with `imageDecodeMs`, `encoderForwardMs`, `indexSearchMs`, etc., but those fields don't reach the `scan_match` structured log line. Until we surface them, we can't attribute the tail.

## The Investigation Strategy

Tail latency in ML inference pipelines is usually one of:

1. **Encoder forward pass tail** — CPU CLIP-style encoders show 5-10× p90/p50 ratios under thermal throttling, GC, or memory pressure. Most common cause of this exact symptom.
2. **Variant fanout** — N variants × encoder forward per scan. If ambiguous captures trigger more variants, that's the lever.
3. **Index search tail** — In-memory FAISS is usually <10ms; spillover to disk or rebuilding hot caches can produce multi-second outliers.
4. **Ensure-runtime stalls** — `_ensure_runtime` should be a no-op after first call. If the runtime gets torn down under memory pressure, the lock around it serializes requests.
5. **Concurrent-load contention** — staging is `spotlight-backend-vm-small`. If two scans land while a background sync (Scrydex sync runs continuously, see `~/spotlight/logs/scrydex_sync.log`) is consuming CPU, both stall.

We don't know which yet. **Phase A produces the data needed to decide. Phases B-D are the analysis and fix.**

## Current Runtime Reality

### What is already real

- The matcher already computes all sub-phase timings inside `match_payload`. They land in `debug["timings"]` (see [`raw_visual_matcher.py:1163-1175`](/Users/stephenchan/Code/spotlight/backend/raw_visual_matcher.py:1163)):
  - `imageDecodeMs`, `ensureRuntimeMs`, `embeddingMs`, `encoderPreprocessMs`, `encoderForwardMs`, `encoderPostprocessMs`, `adapterProjectMs`, `embeddingNormalizeMs`, `indexSearchMs`, `userPhotoRerankMs`, `matchPayloadMs`
- The structured `scan_match` log line carries `backendTimingDebug` — currently includes `visualMatchMs`, `candidateEncodeMs`, `responseBuildMs`, and per-candidate timing arrays, but NOT the visual sub-phases.
- The hybrid resolver also has `phaseTimings` and `matcherTimings` inside `rawDecisionDebug.visualHybrid`, surfaced to stdout via `[MATCH PERF DETAIL]` prints in `_log_scrydex_match_usage` but not to structured logs.

### What is not good enough yet (and what Phase A fixes)

The visual sub-phase data lives in the matcher's `debug` dict but is dropped when the response is built. We can't aggregate over hundreds of scans in journald because the fields aren't in the structured log.

## Phase A — Sub-Phase Instrumentation (CODE LANDED LOCALLY)

### Status: code changes complete, not yet deployed.

### What changed

Two changes in `backend/server.py`:

1. **New helper** `SpotlightScanService._visual_matcher_timing_fields(debug)` (around line 5357). Extracts a curated subset of sub-phase timings from the matcher's debug dict and returns them as a dict suitable for `_record_backend_timing(**)`.
2. **Wired into both visual paths**:
   - `_build_raw_visual_only_response` (around line 1016) — covers `resolverPath: "visual_only_index"` (the dominant path in current staging data)
   - `_resolve_raw_candidates_visual_hybrid_from_matches` (around line 6977) — covers `resolverPath: "visual_hybrid_index"` for parity

### New fields in `backendTimingDebug` after deploy

Every `scan_match` log line for a raw scan will carry:

- `imageDecodeMs` — JPEG decode of the incoming query
- `ensureRuntimeMs` — runtime init cost (should be ~0 after first call; non-zero implies re-init)
- `encoderPreprocessMs` — image-to-tensor prep
- `encoderForwardMs` — **CLIP forward pass; primary tail-latency suspect**
- `encoderPostprocessMs`
- `adapterProjectMs`
- `embeddingNormalizeMs`
- `indexSearchMs` — FAISS/HNSW lookup
- `userPhotoRerankMs`
- `embeddingMs` — sum across all variants (multi-variant fanout shows up as inflation here)
- `queryVariantCount` — number of query variants encoded for this scan (1 to N; variant fanout hypothesis depends on this)

All values are floats (milliseconds, rounded to 3 decimals), except `queryVariantCount` which is an int. None of these change runtime behavior; this is purely additive instrumentation.

### Tests

Two unit tests in `backend/tests/test_scan_logging_phase7.py`:

- `test_visual_matcher_timing_fields_extracts_sub_phases` — happy path, confirms fields are present and rounded.
- `test_visual_matcher_timing_fields_handles_missing_or_invalid_input` — defensive cases (None, empty, wrong types).

Full suite was green when this doc was written: **489 tests + 9 subtests passing**.

### Deploy

Run from repo root:

```bash
pnpm backend:deploy:staging
```

Per [`AGENTS.md`](/Users/stephenchan/Code/spotlight/AGENTS.md), always route through this wrapper rather than calling the raw deploy script directly. Deploy restarts the service (brief downtime), affects all staging clients. The change is additive instrumentation — safe to deploy.

After deploy, wait **24-48 hours** for natural staging traffic to populate the new fields. Don't try to synthesize traffic for this — the goal is to observe the natural distribution of real captures, especially the rare tail cases.

## Phase B — Analyze The New Data

### When to run

Wait until at least 100 raw scans have accumulated in journald with the new fields. Check with:

```bash
gcloud compute ssh spotlight-backend-vm-small --zone=us-central1-b --command='sudo journalctl -u spotlight-backend.service --no-pager --since "48 hours ago" 2>/dev/null | grep scan_match | grep -c encoderForwardMs'
```

If that returns 100+, run Phase B.

### Aggregation script

Run this on your local machine (it SSHes into staging, pulls the logs, parses them, prints distributions):

```bash
gcloud compute ssh spotlight-backend-vm-small --zone=us-central1-b --command='sudo journalctl -u spotlight-backend.service --no-pager --since "7 days ago" 2>/dev/null | grep scan_match' | python3 -c "
import sys, json, re
phases = {
    'imageDecodeMs': [],
    'ensureRuntimeMs': [],
    'encoderPreprocessMs': [],
    'encoderForwardMs': [],
    'encoderPostprocessMs': [],
    'adapterProjectMs': [],
    'embeddingNormalizeMs': [],
    'indexSearchMs': [],
    'userPhotoRerankMs': [],
    'embeddingMs': [],
    'visualMatchMs': [],
}
variants = []
for line in sys.stdin:
    m = re.search(r'\{.*\}', line)
    if not m: continue
    try: d = json.loads(m.group(0))
    except: continue
    if d.get('event') != 'scan_match': continue
    if d.get('resolverMode') != 'raw_card': continue
    btd = d.get('backendTimingDebug') or {}
    for k in phases:
        v = btd.get(k)
        if isinstance(v, (int, float)):
            phases[k].append(float(v))
    vc = btd.get('queryVariantCount')
    if isinstance(vc, int):
        variants.append(vc)

def stats(label, xs):
    if not xs: return
    xs = sorted(xs)
    n = len(xs)
    p50 = xs[n//2]
    p90 = xs[min(n-1, int(n*0.9))]
    p99 = xs[min(n-1, int(n*0.99))]
    avg = sum(xs) / n
    print(f'  {label:24s} n={n:4d}  p50={p50:7.1f}  p90={p90:7.1f}  p99={p99:7.1f}  max={max(xs):7.1f}  avg={avg:7.1f}')

print(f'Sample size: {len(phases[\"visualMatchMs\"])} raw scans')
print()
for k, v in phases.items():
    stats(k, v)
print()
if variants:
    from collections import Counter
    counter = Counter(variants)
    total = sum(counter.values())
    print('Variant count distribution:')
    for n, count in sorted(counter.items()):
        print(f'  variants={n}: {count} scans ({100*count/total:.1f}%)')
"
```

### What to look for

The output gives p50/p90/p99/max for every sub-phase. Compute the p90 - p50 gap for each. The phase(s) with the biggest p90 - p50 gap are your tail source.

| Symptom | Likely root cause |
|---|---|
| `encoderForwardMs` p90 ≫ p50 (5×+ ratio) | Encoder thermal throttling or GC pressure |
| `embeddingMs` p90 ≫ p50 but `encoderForwardMs` p90/p50 ratio is normal | Variant fanout — multiple variants encoded per scan |
| `indexSearchMs` p90 ≫ p50 | FAISS index spilling, cache miss, or memory pressure |
| `ensureRuntimeMs` non-zero p50 | Runtime is being re-initialized between scans (bug) |
| `imageDecodeMs` p90 ≫ p50 | Unusually large incoming images, or PIL/numpy contention |
| Variant count distribution skewed toward 3-4 on slow scans | Confidence-driven variant fanout is firing too often |

### Phase B deliverable

A short note (5-10 lines) at the bottom of this doc identifying:
- Which sub-phase is producing the tail
- What the p90/p50 ratio is for that phase
- Which Phase D hypothesis to pursue

## Phase C — Concurrent-Load Profiling

### When to run

In parallel with Phase B, or after Phase B if Phase B's signal is weak.

### Goal

Determine whether the tail correlates with concurrent load on the VM (other scans, Scrydex sync cron, scan-artifact uploads, etc.).

### Approach

1. **SSH into staging, observe the system during a sample of slow scans:**

```bash
gcloud compute ssh spotlight-backend-vm-small --zone=us-central1-b
htop  # interactive — look at CPU per-core, memory, swap, load average
free -h
ps aux --sort=-%cpu | head -10
```

2. **Cross-reference slow scans with background process activity.** The slow scans have timestamps in their `capturedAt` field. Check whether they correlate with:
   - Scrydex sync activity in `~/spotlight/logs/scrydex_sync.log`
   - Health monitor activity in `~/spotlight/logs/health_monitor.log`
   - Resource monitor spikes in `~/spotlight/logs/resource_monitor.log` (this is the most useful — CPU/memory snapshots at regular intervals)

```bash
# On staging VM:
tail -200 ~/spotlight/logs/resource_monitor.log | grep -E "cpu|mem|load"
```

3. **Synthetic load test (optional but recommended):** Issue concurrent `/api/v1/scan/match` requests against staging while observing CPU. If `visualMatchMs` spikes specifically when N concurrent scans are in flight, the bottleneck is request concurrency (likely a Python GIL or shared-runtime lock).

### Phase C deliverable

Answer the question: **does the tail correlate with concurrent activity, or does it appear randomly?**
- If it correlates with concurrency: pursue hypothesis 4 or 5 (concurrency/locking, or upgrade VM)
- If it's random: pursue hypothesis 1 (encoder thermal/GC)

## Phase D — Targeted Fix (Hypothesis-Driven)

Pursue ONLY the hypothesis that Phases B and C point to. Do not pre-emptively fix all of these.

### Hypothesis 1: Encoder forward pass tail (most likely, ~60% prior)

**Symptom from Phase B:** `encoderForwardMs` p90/p50 ratio is 5×+; `embeddingMs` is dominated by `encoderForwardMs`.

**Root causes to investigate:**
- ONNX/PyTorch runtime thread settings (no parallelism set → OS scheduler swings)
- Python garbage collector pauses during inference (large numpy allocations)
- Thermal throttling on the GCE VM CPU (less likely on cloud hardware, but possible)

**Fixes (in increasing complexity):**

1. **Pin runtime threads.** In `RawVisualMatcher.__init__` or `_ensure_runtime`:
   - If using ONNX: `session.set_providers(['CPUExecutionProvider'], [{'intra_op_num_threads': 4, 'inter_op_num_threads': 2}])`
   - If using PyTorch: `torch.set_num_threads(4); torch.set_num_interop_threads(2)`
   - The right numbers depend on VM core count. `spotlight-backend-vm-small` likely has 2 vCPUs — start with `intra_op_num_threads=2, inter_op_num_threads=1`.
2. **Disable GC during encoder forward pass.** Wrap the encoder call in `gc.disable()` / `gc.enable()` and trigger an explicit collection between scans. Reduces variance from incidental collections.
3. **Pool encoders.** If the bottleneck is contention on a single encoder instance, run 2-3 parallel encoders behind a queue. More memory cost; significant complexity.
4. **Quantize the encoder.** INT8 quantization typically gets 2-3× forward-pass speedup with minimal accuracy loss. Largest effort; biggest win if forward pass is the bottleneck.

### Hypothesis 2: Variant fanout (medium likely, ~25% prior)

**Symptom from Phase B:** Variant count distribution shows many scans with 3-4 variants; `embeddingMs` p90 is ~N× `embeddingMs` p50 where N is variant count.

**Root cause:** `_query_variants` in [`raw_visual_matcher.py:620`](/Users/stephenchan/Code/spotlight/backend/raw_visual_matcher.py:620) generates multiple variant crops for fanout. Each variant runs the encoder. If low-confidence base matches trigger variant fanout, slow scans pay the multiplier.

**Fixes:**

1. **Lazy variant fanout.** Run the base variant first. If top-1 similarity > threshold (e.g., 0.85), skip variants entirely. Saves N-1 encoder passes on confident matches.
2. **Cap variant count.** Hard-limit to 2 variants. The 3rd and 4th variants are likely diminishing returns.
3. **Parallelize variants.** Encoder calls for different variants are independent — could run them concurrently if Hypothesis 1's fixes (thread pinning) leave headroom.

Fix #1 is the easy win. Implement it first, measure, then consider #2/#3.

### Hypothesis 3: Index search tail (low likely, ~10% prior)

**Symptom from Phase B:** `indexSearchMs` p90 ≫ p50.

**Root causes:**
- Index spilling to disk under memory pressure
- HNSW parameter `efSearch` too high (over-searches the graph)
- Cold caches after process restarts

**Fixes:**
- Inspect the index implementation in `raw_visual_matcher.py` — look for the `self.index` attribute construction.
- If using HNSW: tune `efSearch` downward; the speed/recall tradeoff is well-documented.
- If spilling: ensure the VM has enough RAM to hold the full index in memory + headroom for inference.

### Hypothesis 4: Ensure-runtime stalls (low likely, ~5% prior)

**Symptom from Phase B:** `ensureRuntimeMs` is non-zero at p50 (should be <1ms steady-state).

**Root cause:** Runtime is being torn down and rebuilt between scans, likely under memory pressure or a thread-safety pathology.

**Fixes:**
- Add logging to `_ensure_runtime` to detect re-init events.
- Hold the runtime as a process-lifetime singleton.
- Audit any code that resets `self._raw_visual_matcher` to None.

### Hypothesis 5: VM undersized for concurrent load (~5% prior, but trivial to mitigate)

**Symptom from Phase C:** Slow scans correlate with concurrent Scrydex sync activity or other CPU consumers.

**Fixes:**

1. **Schedule heavy syncs off-peak.** Move Scrydex sync cron to run at 03:00 local time, not during peak scan hours.
2. **Upgrade VM size.** Instance name is `spotlight-backend-vm-small` (set in `tools/deploy_backend.sh:66`). Bumping to `spotlight-backend-vm-medium` or similar is a config flip — change the default name, redeploy.

Trivial mitigation; consider it the "if all else fails" lever.

### Phase D deliverable

Whatever fix the hypothesis points to. After implementing, redeploy, wait another 48 hours, re-run the Phase B aggregation script, and confirm p90 dropped.

## Expected Wins

If the encoder forward pass is the tail (most likely):
- Realistic improvement: p50 stays ~350ms; p90 drops from 1489ms → 600-800ms.
- That's the meaningful user-felt win — fewer "why is my scan so slow this time?" moments.

If variant fanout is the cause:
- p50 might drop slightly (fast-path skips fanout when confident).
- p90 drops a lot when the base variant is confident — and confident matches dominate the population, so most scans skip the extra encoder passes.

If the VM is undersized:
- Tail dependency on concurrent load disappears.
- p99 specifically drops; p50/p90 may stay similar.

## Effort Estimate

| Phase | Active work | Elapsed |
|---|---|---|
| Phase A: code (DONE) | 0 | 0 |
| Phase A: deploy + wait | 5 min | 24-48 hours passive |
| Phase B: aggregate + analyze | 1 hour | same day |
| Phase C: concurrent-load profile | 1 day | same day |
| Phase D: hypothesis-dependent fix | 1-5 days | 1-7 days |

**Total active work after returning to this doc: 2-7 days, depending on which hypothesis pans out.**

## Resources

- Staging VM: `spotlight-backend-vm-small` in `us-central1-b` ([`tools/deploy_backend.sh:66`](/Users/stephenchan/Code/spotlight/tools/deploy_backend.sh:66))
- Logs: `journalctl -u spotlight-backend.service` on the VM
- Matcher source: [`backend/raw_visual_matcher.py`](/Users/stephenchan/Code/spotlight/backend/raw_visual_matcher.py)
- Response/logging plumbing: [`backend/server.py`](/Users/stephenchan/Code/spotlight/backend/server.py) — search for `_visual_matcher_timing_fields`, `_record_backend_timing`, `_build_raw_visual_only_response`
- Original 7-day baseline numbers (for comparison):
  - `visualMatchMs`: n=256, p50=349, p90=1489, max=11907
  - `candidateEncodeMs`: n=256, p50=97, p90=317, max=1894
  - Source: 2026-05-11 → 2026-05-18, `resolverMode: raw_card`, `resolverPath: visual_only_index`

## What NOT To Do (Pitfalls)

- **Don't synthesize load to populate the new fields faster.** The point of the data is to observe natural distribution, not stress the system.
- **Don't add MORE instrumentation in Phase B.** The fields added in Phase A are sufficient. Adding more before analyzing what you have invites scope creep.
- **Don't ship Phase D fixes blindly.** Each hypothesis has a different fix; the wrong fix wastes a deploy cycle and could mask the real signal.
- **Don't conflate this with the toggle-removal work.** This is purely server-side. The toggle plan in [`scanner-toggle-removal-plan-2026-05-18.md`](/Users/stephenchan/Code/spotlight/docs/scanner-toggle-removal-plan-2026-05-18.md) is client-side; the two are independent.
- **Don't expect this to fix p50.** The p50 of 349ms is already fine. This investigation is purely about the p90 tail. If your goal becomes p50 reduction, that's a different investigation (different levers: index size, embedding dimension, encoder choice).

## Success Criteria

This investigation is successful if, after Phase D:

- Raw `visualMatchMs` p90 drops from 1489ms to <800ms.
- Raw `visualMatchMs` max drops from 11907ms to <3000ms (no 5+ second outliers).
- p50 stays within ±50ms of the baseline (we're not trying to optimize the fast path).
- The fix is supported by a clear before/after measurement using the Phase B aggregation script.
