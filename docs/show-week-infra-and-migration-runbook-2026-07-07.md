# Show-Week Infra + Price-JSON Migration Runbook (2026-07-07)

One document for the whole sequence: staging/prod split → JSON→cells migration rehearsed on
staging → show on t2d-16 → migration landed on prod → column drop. Each day is execute-only;
rollback paths are listed per phase.

## Already done (Sun Jul 6 night)

- ✅ **Prod moved to `us-central1-c` on `t2d-standard-4`** (8 min downtime, commit `bef9e0b`).
  Same instance name (`spotlight-backend-vm-small`), same static IP `34.59.188.129`, TLS/hostname
  unchanged. Old VM kept STOPPED in `-b` with its disk as full rollback.
- ✅ Daily disk snapshots: policy `daily-disk-snap` (3am PT, keep 7) attached to the new disk
  `spotlight-backend-vm-ssd-c`. Snapshot `prod-move-to-c-20260707` exists (the move snapshot).
- ✅ Post-sync + startup cache prewarm live (`9476a65`); deck_entries/performance/dashboard caches
  live; zone refs in tools/docs updated to `-c`.
- Capacity intel: `-b` stocked out of t2d 3× (6/25, 7/01, 7/06); `-c` probed AVAILABLE for both
  t2d-4 and t2d-16 on 7/06. Probe trick: `gcloud compute reservations create` per zone/shape,
  delete immediately (~pennies).

## Schedule

| Date | Track | Work |
|---|---|---|
| ~~Tue Jul 8~~ Sun Jul 6 | 🚚 prod | ~~Zone move~~ **DONE early** (see above) |
| **Wed Jul 9** | 🧪 staging | Provision staging box (checklist below) + repoint tooling/EAS |
| **Jul 9–11** | 🧪 staging | Migration on staging: resolver fix → harness 0 mismatches → cutover → rehearse drop+VACUUM (time it). No deadline pressure; can bleed past the show. |
| **Thu Jul 10** | 🎪 prod | Reserve t2d-16 in `-c` → resize prod → t2d-standard-16 → early-morning soak (15–20 scanners, p95 < 3s). **Prod code freeze after today.** |
| **Fri Jul 11** | 🎪 prod | Buffer day. Verify daily sync + post-sync prewarm ran clean on the big box. Nothing ships. |
| **Sat–Sun Jul 12–13** | 🎪 SHOW | Prod on t2d-16, untouched. No deploys, no OTA, no manual syncs. Show mode stays ON. |
| **Sun Jul 13 night** | 🎪 prod | Resize t2d-16 → t2d-standard-4. Delete t2d-16 reservation if still held. |
| **Mon Jul 14** | 🚀 prod | Deploy the staging-validated **cutover** (current price → cells; JSON columns stay as fallback). Watch parity/behavior ~1 week. |
| **~Mon Jul 21** | 🚀 prod | Fresh manual snapshot → **drop JSON columns + offline VACUUM** (rehearsed; use staging's measured timing) → DB ~38GB → ~3GB. Optional epilogue: prod → t2d-standard-2 (~$61/mo) once the RAM floor is gone. |
| Anytime after Jul 10 | 🧹 cleanup | Delete the old `-b` VM + disk once `-c` has been stable a few days (saves $8/mo). |

## Wed Jul 9 — staging provisioning checklist

Goal: `spotlight-backend-staging`, `e2-standard-2`, zone `us-central1-c`, full data replica,
**zero interaction with the outside world**. Order matters — litestream is fixed BEFORE the
service ever starts.

1. **Static IP first** (staging gets stopped/started when idle; an ephemeral IP would change and
   break the hostname every start):
   `gcloud compute addresses create spotlight-staging-ip --region us-central1`
2. **Disk from a fresh snapshot** (last night's auto-snap or take one):
   `gcloud compute disks create spotlight-backend-staging-ssd --source-snapshot <latest> --type pd-balanced --size 80GB --zone us-central1-c`
   (80GB is the snapshot-restore floor; smaller disks only make sense after the JSON drop, worth ~$5/mo — skip.)
3. **Create instance with NO auto-start of the service if possible** — simplest reliable pattern:
   create it, then immediately SSH in and fix the clone hazards before `systemctl start` (or
   within the first minute; litestream corruption needs sustained writes, but don't dawdle):
   `gcloud compute instances create spotlight-backend-staging --zone us-central1-c --machine-type e2-standard-2 --disk name=spotlight-backend-staging-ssd,boot=yes,auto-delete=no --address <staging-ip> --tags spotlight-backend,spotlight-backend-web --service-account 47744758128-compute@developer.gserviceaccount.com --scopes cloud-platform`
4. **On the box, immediately** (`sudo systemctl stop spotlight-backend` first):

| Clone hazard | Why | Fix on staging |
|---|---|---|
| **Litestream** | 🚨 Streams its DB to prod's GCS path → silently corrupts prod's only DB backup lineage | `sudo systemctl stop litestream && sudo systemctl disable litestream` (staging needs no continuous backup — it restores FROM prod). If backup ever wanted: repoint config to `looty-staging-backups/staging/` first. |
| **Scrydex sync cron** | Double credit burn (~$200/mo plan) | `crontab -e` → remove the sync line (also health/resource crons: keep or drop, harmless). Backstop: strip `SCRYDEX_API_KEY` (+ any PPT key) from the box's env file — keyless = credit-safe even if a cron sneaks back. Prices still serve from the DB. |
| **PPT population/sync** | Same | Prod-only; no cron on staging, no key. |
| **Scan-artifact uploads** | Synthetic/test scans pollute the labeled training corpus. Runtime setting is IN the cloned DB as *enabled* | After service start: `POST /api/v1/admin/scan-artifact-uploads {"enabled":false,"note":"staging"}` (admin auth) |
| **Caddy/TLS hostname** | Clone's Caddyfile answers for prod's hostname | Edit Caddyfile → `looty.<STAGING_IP>.sslip.io`; reload caddy; verify cert issues |
| **Prewarm** | 2-core box grinding 16 owners × 3 caches at every boot | Env: `PORTFOLIO_DASHBOARD_PREWARM_MAX_OWNERS=5` |
| **Supabase auth** | Shared — same accounts work on both backends | No change. Testers will see snapshot-frozen collections on staging (edits don't cross boxes) — tell them, it's correct. |

5. **Start + verify**: `systemctl start spotlight-backend` → health on the new hostname → confirm
   journald shows NO litestream, NO sync activity → one test scan.

### Repo/tooling changes (same day, committed)

- `tools/deploy_backend.sh`: `default_instance/default_zone` — **staging → `spotlight-backend-staging` / `us-central1-c`**;
  **production → `spotlight-backend-vm-small` / `us-central1-c`**. Verify `backend:deploy:production` targets prod.
- **Release-gate check** 🚨: `frontend:release:staging` also deploys the backend — after the split it
  must deploy to the STAGING box, never prod. Trace `tools/run_staging_release_gate.sh` + mobile
  wrapper env (`SPOTLIGHT_VM_STAGING_*`) before trusting it.
- Env files: current `backend/.env.staging` IS the prod config. Rename flow:
  `.env.staging` → `.env.production` content-wise (keep keys), then rebuild `.env.staging` for the
  staging box: keyless Scrydex/PPT, `PORTFOLIO_DASHBOARD_PREWARM_MAX_OWNERS=5`, staging hostname.
  `deploy_to_vm.sh` picks `.env.$ENVIRONMENT` — verify both paths deploy clean.
- **EAS**: `eas.json` staging profile `EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL` → staging hostname; OTA
  the **staging channel** (`pnpm frontend:update:staging`). Production profile/channel untouched.

## Jul 9–11 — migration work (staging only; zero prod risk)

Refs: `docs/price-history-normalization-migration-plan-2026-06-09.md`,
`docs/db-size-reduction-plan-2026-06-10.md`. Harness:
`backend/tools/verify_current_price_cells_parity.py`.

1. **Fix `resolve_graded_entry_from_cells`** to replicate `_resolve_best_graded_context_entry`'s
   variant/hint ranking. Known failure cases the fix must nail (from the two reverted attempts —
   branches `wip-insights-cells-rewrite`, `worktree-agent-a9c0fdfdf6ef47d33`):
   - `base1-63` PSA 10: JSON picks Unlimited **$275**; cells picked Unlimited Shadowless **$1775**
   - `advp_ja-57` PSA 10: JSON picks Normal **$249**; cells picked Holofoil **$399**
   - One owner's insights total inflated $4,971 → $6,039
2. **Harness to 0 mismatches** across the FULL staging DB (both raw + graded, all owners' contexts).
   0 is the gate; 1 is a failure.
3. **Cutover on staging**: flip the current-price path (`_pricing_summary_from_snapshot_row` lane)
   to cells. JSON stays on disk. Testers verify graded PDP prices, slab values, insights totals.
4. **Rehearse the drop**: on staging, fresh snapshot → drop `raw_contexts_json`/`graded_contexts_json`
   (+ per plan doc) → offline VACUUM via the staging-table/file-swap pattern (never live, never at
   startup). **Record the wall-clock** — that number is prod's Jul 21 downtime estimate.

Rollback at any point: staging is disposable; re-restore from snapshot.

## Thu Jul 10 — show hardware

```bash
# hedge first — abort-safe
gcloud compute reservations create show-t2d16 --zone us-central1-c --machine-type t2d-standard-16 --vm-count 1
# resize (~5 min downtime, quiet hour)
gcloud compute instances stop spotlight-backend-vm-small --zone us-central1-c
gcloud compute instances set-machine-type spotlight-backend-vm-small --machine-type t2d-standard-16 --zone us-central1-c
gcloud compute instances start spotlight-backend-vm-small --zone us-central1-c
```
- Keep the reservation until AFTER the show-end downsize? No — delete once the resize lands (the
  running VM holds its own capacity). Re-reserve only if a mid-show restart is feared (paranoia tier).
- **Soak** (early morning, before users): k6 `scanner.js` 15–20 VUs 10 min → p95 < 3s, 0 shed;
  `mixed.js USERS=100 SCANNER_SHARE=0.4`. Artifact uploads OFF during, ON after (`/api/v1/admin/scan-artifact-uploads`).
- Verify post-resize: machine type, health, prewarm completed, `free -h` shows ~64GB (whole DB in
  page cache territory).
- **Code freeze on prod** after today. Staging work may continue.

## Mon Jul 14 — prod cutover

- Deploy the staging-validated cutover via the release gate (now split-aware). JSON stays.
- Watch: graded PDP prices vs pre-deploy spot checks, insights totals, `portfolio_*` timing logs.
- Rollback: revert commit + redeploy (JSON path still fully present).

## ~Mon Jul 21 — prod column drop

1. Manual snapshot: `gcloud compute disks snapshot spotlight-backend-vm-ssd-c --snapshot-names pre-json-drop-$(date +%Y%m%d) --zone us-central1-c`
2. Run the rehearsed drop + offline VACUUM (staging's timed procedure; expect the DB offline for
   roughly staging's wall-clock — schedule a quiet hour, announce nothing, it's minutes).
3. Verify: DB size ~3GB, prices spot-check, litestream re-baselines (first post-VACUUM replication
   is a full new generation — expected).
4. Rollback: restore `pre-json-drop-*` snapshot (~30 min) + litestream for the gap.
5. Epilogue (optional, any time after): prod t2d-standard-4 → t2d-standard-2 (~$61/mo) — the RAM
   floor is gone; scan ceiling ~3–4 concurrent until INT8. Decide from `scanner_busy_503` logs.
6. Epilogue 2 — **rebuild staging on a small disk** (~25–30GB, $8→$3/mo): the 80GB staging disk was
   only needed to rehearse the drop (38GB DB + VACUUM scratch ≈ 55–60GB peak). Post-drop: fresh
   small disk, provision via the deploy scripts, DB via **litestream restore** (~3GB, minutes).
   NOTE staging data refreshes must use litestream/file-level restore from now on, NOT disk
   snapshots — prod's disk stays 80GB, and snapshots always demand ≥ source-size target disks.

## Cost picture through July

| Item | Rate |
|---|---|
| Prod t2d-standard-4 (daily) | ~$123/mo |
| Show weekend t2d-16 (Thu→Sun) | ≈ +$50 one-time |
| Staging e2-standard-2 | ~$49/mo running · ~$8/mo stopped |
| Staging static IP + disk | ~$11/mo |
| Snapshots (both schedules) | ~$3–5/mo |
| Old -b VM disk until deleted | $8/mo → $0 after cleanup |
| **Post-drop option** | prod → t2d-2 saves $62/mo |
