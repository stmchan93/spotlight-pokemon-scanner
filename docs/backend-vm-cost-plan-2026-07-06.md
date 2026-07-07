# Backend VM Sizing + Cost Plan — 2026-07-06

> STATUS: **decision recorded, NOT yet provisioned.** This is the reference for when we split
> staging/prod soon. No VMs have been changed based on this doc.

## Context
- Launching to **real users ~week of 2026-07-13**. Need **staging + prod** on GCP Compute Engine
  (us-central1). Backend does CPU-heavy **visual card scanning**.
- Already spending **~$200/mo on Scrydex** pricing data; goal = minimize compute spend on top of that.
- **Current box:** `spotlight-backend-vm-small`, zone `us-central1-b`, machine `e2-standard-4`,
  `provisioningModel: STANDARD` (on-demand — **NOT spot/preemptible**). **One shared box currently serves
  both staging and prod**; we're splitting into two for launch isolation.

## Measured scan capacity (benchmark)
Source artifact: https://claude.ai/code/artifact/7a75d8f9-dc96-4acd-b178-a353586a59d8
(Claude artifact — cannot be auto-fetched; **paste the full table below**.)

Data points captured so far (user-reported):
- **t2d-standard-4 → ~20 concurrent scans OK.**
- `e2-standard-4` (today's box) — measured.
- `t2d-standard-4` — measured.
- `t2d-standard-16` — intended **prod peak scale-up** target (e.g. card shows).

> TODO: paste the full machine-type → (concurrent-scan capacity, p50/p95 scan latency) table here.

## FINAL SHAPES (what to provision, soon — two separate boxes)
| Env | Shape | Warm 24/7? | Why | Commit (1-yr CUD) |
|---|---|---|---|---|
| **Staging** | `e2-standard-2` (2/8) | yes | testers hit at RANDOM times (can't schedule off); light load → smallest box that holds the ~3.3GB model | **soon** (stays small → low risk) |
| **Prod baseline** | `t2d-standard-4` (4/16) | yes | dedicated AMD cores, no e2 burst-throttle; ~20 concurrent scans | **after ~1 month** of real load |
| **Prod peak (shows)** | `t2d-standard-16` (16/64) | only show days | free bidirectional resize up for a show, back down after | **never** (burst = on-demand) |

Both boxes are warm 24/7 for the **same reason**: the **~2-min model cold-load** makes scale-to-zero /
scheduled-off impractical for anything users (or random testers) touch.

## Cost — approx us-central1, $/month (~730 hrs). Verify on the GCP calculator before committing.
VM only:
| Env | Shape | On-demand | 1-yr CUD (~37% off) | 3-yr CUD (~55% off) |
|---|---|---|---|---|
| Staging | e2-standard-2 | $49 | **~$31** | ~$22 |
| Prod baseline | t2d-standard-4 | $119 | **~$75** | ~$54 |
| Prod peak | t2d-standard-16 | $478 (show days only) | — | — |

### FULL per-env cost (VM + disk + IP + storage) — measured 2026-07-06
Non-VM line items you're ALSO paying (audited on the current shared box):
- **80GB pd-balanced disk ≈ $8/mo** (holds OS + venv[torch/transformers/onnx, several GB] + vision model
  + the SQLite DB ~11GB & growing + WAL + logs + staged scans). ~40GB used → over-provisioned, but GCP
  disks **can't shrink** → keep on prod; give staging a smaller ~40GB disk.
- **Static external IP ≈ $3/mo** (in-use; GCP now charges all external IPv4). One per box, unavoidable.
- **GCS ≈ $0.30/mo total**: `looty-staging` 6.0GB scans + `looty-staging-backups` 8.0GB DB backups;
  `looty-prod` currently empty. **No lifecycle policy → grows forever** (add auto-expire, see below).
- **No Cloud SQL, no snapshots, no Cloud Run service, empty Artifact Registry** → $0.
- **Egress + Cloud Logging** = usage-billed (not a stored resource): small now, grows with real users
  (GCS→app image egress ~$0.12/GB after free tier; logs free <50GB/mo then $0.50/GB). Set a budget alert.

| Env (all-in) | VM (1-yr CUD) | Disk | IP | GCS | **~$/mo** |
|---|---|---|---|---|---|
| Staging (e2-standard-2, ~40GB) | ~$31 | ~$4 | ~$3 | ~$0.30 | **~$38** |
| Prod (t2d-standard-4, 80GB) | ~$75 | ~$8 | ~$3 | ~$1 (grows) | **~$87** + egress |

- **Current single shared box, all-in ≈ $110/mo GCP** ($98 VM + $8 disk + $3 IP + $0.3 GCS) + $200 Scrydex
  ≈ **~$310/mo**.
- **Split steady state (both VMs on 1-yr CUD): ~$125/mo GCP** + egress + show bursts + $200 Scrydex
  ≈ **~$325–345/mo all-in**. All-on-demand (no CUD): ~$187/mo GCP. Worst case (t2d-16 24/7): avoid.

### Savings / scale-properly checklist (audited 2026-07-06)
- **Egress: not a growth risk.** The backend serves images only for the INTERNAL review/labeling tool
  (`/api/v1/review/image/{scan_id}`, server.py); end-user card images load straight from Scrydex's CDN
  (`images.scrydex.com/...`) — Scrydex's egress, not ours. User traffic is just JSON → egress stays small.
- **Logging: $0.** No Ops/logging agent installed on the VM (`google-cloud-ops-agent`/fluentd/stackdriver
  all not-installed) → backend logs stay in journald on the VM, never ingested by Cloud Logging. Nothing
  to manage. (If an agent is ever installed, add Log Router EXCLUSION filters to stay under the 50GB/mo
  free tier.)
- **GCS lifecycle — TIER, don't delete** (scan artifacts = private training data + only ~$0.02/GB):
  - `looty-staging` + `looty-prod` (scan artifacts via `scan_artifact_store.py`): **APPLIED 2026-07-06** —
    `tools/gcs-scan-artifacts-lifecycle.json` = **60-day Standard → Coldline** (deletes nothing; keeps all
    training data). Chose Coldline over Archive because scans are re-read for retraining (>1×/yr), where
    Coldline's $0.02/GB retrieval beats Archive's $0.05; 0–60d Standard covers the capture→label window so
    labeling reads are free + instant (GCS cold = millisecond access, not AWS-Glacier thaw). Re-apply with
    `gcloud storage buckets update gs://<bucket> --lifecycle-file=tools/gcs-scan-artifacts-lifecycle.json`.
  - `looty-staging-backups` = **Litestream** (continuous SQLite→GCS replication = disaster recovery /
    point-in-time restore; restore via `litestream restore gcs://looty-staging-backups/...`). **KEEP IT;
    do NOT put a GCS delete-lifecycle on it** (would break Litestream's snapshot/WAL chain). Cap history
    via Litestream's own `retention` config if ever needed. Prod will need its OWN backups bucket +
    Litestream target when split.
- Keep the 80GB disk on prod (can't shrink; DB grows); staging gets a smaller disk.
- One static IP per box (~$3) — needed for the stable URL; leave it.
- **Budget alert CREATED (2026-07-06):** billingAccounts/016415-86A401-A067A1 budget
  `cd915e03-05ba-4852-92fa-a155db4157d7` = $150/mo, project-scoped, 50/90/100% actual + 100% forecast,
  emails the billing admin (stmchan8953@gmail.com).
- Optional cleanup ($0): delete the leftover `run-sources` bucket + empty `cloud-run-source-deploy` AR repo.

## Rules of thumb (so we don't relearn them)
- **VM resize up/down is free, unlimited, bidirectional.** t2d-4 → t2d-16 for a show → t2d-4 after is
  fine forever. There is NO machine-size lock.
- **A CUD is a ~37%-off (1yr) / ~55%-off (3yr) BILLING FLOOR**, not attached to a VM: you pay the
  committed baseline for the term even if you shrink/stop; usage ABOVE it bills on-demand. Commit only the
  24/7 baseline, never the burst size, and only after you know the size. (Flexible/spend-based CUDs are
  more forgiving if size varies a lot.)
- **Never put the backend on spot** — preemption = downtime.
- Commit prod AFTER ~1 month of measured load; commit staging soon (it stays small).

## Future: could we kill the idle cost (serverless / scale-to-zero)?
Only if the model could cold-load fast enough — and that's a multi-week re-architecture, not worth it at
this scale:
1. **DB off the VM** (SQLite-on-local-disk → Cloud SQL/Postgres or libSQL). Large: the backend is deeply
   SQLite-coupled (27M-row price cells, custom covering indexes, WAL) — schema port + data-layer rewrite +
   re-tuning every perf-critical query.
2. **Make the 3.3GB / ~2-min model cold-load fast** — INT8-quantize (on the retrain roadmap), mmap/lazy
   load, or a dedicated warm inference service (which is then itself always-on). Fundamental tension:
   instant scans need a WARM model; scale-to-zero means COLD — even done well, cold starts stay
   multi-second.
Verdict: weeks of work to save ~$75–100/mo, and likely a worse first-scan-after-idle. Only pays off at
much larger or much spikier/cold-start-tolerant traffic. The realistic partial win is INT8 quantization
next retrain (smaller model → maybe a cheaper warm box), NOT a serverless rewrite.
