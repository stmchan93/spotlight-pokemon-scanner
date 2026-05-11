# Distribution + Backup Strategy — 2026-05-11

Living doc covering how to deploy + back up Spotlight at the current
friends-and-family scale (~3 internal testers, ~5 external testers, 1 staging
backend on GCE).

## What changed in this PR

Three additions and one explicit deferral:

1. **Litestream SQLite backup** — streams the SQLite WAL from the staging VM
   to `gs://looty-staging-backups/` in near-real-time. Restore is one command.
2. **`pnpm backend:restore:local`** — pulls a consistent snapshot of the live
   staging DB to your laptop for offline Scrydex-credit-free testing.
3. **Two EAS OTA channels (`staging` and `production`)** — internal testers
   get `staging` updates, external testers get `production` updates. Both
   builds still hit the same backend; only the JS bundle is gated.
4. **Deferred: production backend.** At 5 external users, a second VM (~$30/mo
   + extra Scrydex credits) isn't worth it. Single backend serves both groups
   for now. Revisit at ~50+ external users or when shipping breaking API
   changes.

## Backend

### Single staging VM

- Host: `spotlight-backend-vm-small` (`us-central1-b`, e2-medium, 50 GB disk)
- DB: `/home/stephenchan/spotlight/data/spotlight_scanner.sqlite` (~7 GB, growing)
- Public URL: `https://looty.34.59.188.129.sslip.io`
- Deploy command: `pnpm backend:deploy:staging`

Both internal and external mobile builds point at this URL. Backend changes
hit everyone immediately. Discipline rule: never make breaking API contract
changes (drop fields, change types) without a frontend that handles both old
and new shapes.

### Backups — Litestream

Litestream v0.3.14 runs as a systemd service on the VM. Every WAL frame is
streamed to `gs://looty-staging-backups/spotlight_scanner/` within ~1 second.

Verified end-to-end (2026-05-11):

- Full snapshot upload (6.7 GB DB → 705 MiB compressed): **62 seconds**.
- Restore from GCS: **58 seconds** to identical row counts (1,046,158
  price_history rows, 44,226 cards).

#### Disaster recovery (VM is gone)

On any Linux box with `gcloud` and Litestream v0.3.14 installed:

```bash
litestream restore -o spotlight_scanner.sqlite gcs://looty-staging-backups/spotlight_scanner
```

Then point a new backend instance at the restored file.

#### Day-to-day operations

```bash
# View Litestream status on the VM:
gcloud compute ssh spotlight-backend-vm-small --zone=us-central1-b --project=spotlight-492502 \
  --command='sudo journalctl -u litestream -n 20 --no-pager'

# Check GCS bucket size + recent generations:
gsutil du -sh gs://looty-staging-backups/
gsutil ls gs://looty-staging-backups/spotlight_scanner/generations/
```

### Local DB restore for testing

```bash
pnpm backend:restore:local
# → backend/data/spotlight_scanner.local.sqlite (~7 GB, gitignored)
```

Uses `sqlite3 .backup` (atomic snapshot, safe against the live DB) + `gcloud
compute scp`. Takes a few minutes depending on your network. Doesn't require
local Litestream install. Doesn't burn Scrydex API credits — you're operating
on a static copy.

Restore frequency: pull once when you need fresh data, reuse the local file
for multiple test runs.

## iOS distribution

### Two OTA channels, one TestFlight app

Both EAS build profiles produce a `com.looty.staging` IPA that uploads to the
same TestFlight app. The difference is which OTA channel each binary listens
to:

| Profile | Bundle | Channel | Audience | TestFlight group |
|---|---|---|---|---|
| `development` | `com.looty.spotlight.dev` | `development` | dev (your machine) | n/a (dev client) |
| `staging` | `com.looty.staging` | `staging` | internal (you + 2 friends) | "Internal" group |
| `production` | `com.looty.staging` | `production` | external (5 friends/family) | "External" group |

The bundle ID is intentionally the same for `staging` and `production` so
external users don't need to install a second app. TestFlight allows
distributing different builds to different groups, so internal users see the
latest build and external users stay on whatever build you last distributed
to them.

> When a real App Store launch happens, switch the `production` profile to
> `com.looty.spotlight` and create a new TestFlight app under that bundle ID.
> Until then, the current naming is "internal cadence vs external cadence,"
> not "real production."

### Deploy cadence

**Internal cycle (fast iteration):**
```bash
# After a code change you want internal testers to see:
pnpm frontend:update:staging
# Internal users get the update on next app launch.
```

**External cycle (curated stable releases):**
```bash
# When you're confident a feature is stable for external testers:
pnpm frontend:update:production
# External users get the update on next app launch.
```

**New native build (rare — only when you change native code):**
```bash
# For internal:
pnpm frontend:build:staging
# Then upload to TestFlight, distribute to Internal group.

# For external:
pnpm frontend:release:production
# Auto-uploads to TestFlight; distribute to External group manually.
```

### When OTAs reach what
- `pnpm frontend:update:staging` → only binaries built with the `staging`
  profile → only internal users.
- `pnpm frontend:update:production` → only binaries built with the
  `production` profile → only external users.
- Both build profiles currently hit the **same backend** at
  `https://looty.34.59.188.129.sslip.io`, so backend changes affect everyone.

## Discipline rules

These exist because we deferred infrastructure that would otherwise enforce
them. Important to internalize:

1. **Never make breaking backend API changes without backwards compat.**
   Drop a field? Add the new shape, keep the old, deprecate later. Change a
   type? Version the endpoint (e.g., `/v2/...`). Otherwise external users on
   older OTAs will crash.

2. **Push to internal first, then production.** Workflow:
   `pnpm frontend:update:staging` → test on your TestFlight build for a day →
   if good, `pnpm frontend:update:production`. Don't skip the staging step
   for external pushes.

3. **Monitor disk space on the staging VM.** Currently 50 GB total, ~38%
   used. DB grows ~250 MB/day (40K cards × snapshots). Resize before it fills:
   ```bash
   gcloud compute disks resize spotlight-backend-vm-small \
     --zone=us-central1-b --project=spotlight-492502 --size=100GB
   ```
   Then reboot the VM or run `sudo growpart` + `sudo resize2fs` to expand the
   filesystem.

4. **Don't manually checkpoint SQLite WAL on the VM.** Litestream owns
   checkpointing. Manual `PRAGMA wal_checkpoint(TRUNCATE)` can lose WAL
   segments that haven't replicated yet.

## When to revisit each decision

| Decision | Trigger to reconsider |
|---|---|
| Single backend | ~50+ external users, OR shipping schema migrations that break old clients |
| SQLite | ~500+ users, OR multi-instance backend needs |
| Manual TestFlight group management | When you have more than 3 audiences (e.g., add beta-testers cohort) |
| `com.looty.staging` bundle for "production" channel | App Store launch — switch to `com.looty.spotlight` |
| No PostHog feature flags | When you want to ship a feature behind a runtime toggle to a subset of users on the same binary |
