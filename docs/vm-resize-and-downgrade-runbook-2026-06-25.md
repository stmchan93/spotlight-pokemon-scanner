# VM resize + machine downgrade runbook (staging) — 2026-06-25

## Goal & current state
- Boot disk is **50 GB pd-standard (HDD), 98% full** (DB `spotlight_scanner.sqlite` = 30 GB + ~740 MB WAL).
  This blocks building the `idx_cell_trend_market` covering index (needs ~2–3 GB + sort space).
- Machine is **t2d-standard-4** (4 vCPU / 16 GB RAM, ~$129/mo). Want **t2d-standard-2** (2 vCPU / 8 GB,
  ~$64/mo) to save ~$65/mo.

## Names / devices (verified)
- VM: `spotlight-backend-vm-small`, zone `us-central1-b`, project `spotlight-492502`
- Boot disk name: `spotlight-backend-vm-small`
- Root partition: `/dev/sda1` on `/dev/sda` (root is the last partition → `growpart` works)
- DB path: `/home/stephenchan/spotlight/data/spotlight_scanner.sqlite`

---

## RECOMMENDED PATH (simple, low-risk): resize HDD + build index + downgrade machine

> The covering index makes the price-trend read **index-only (~0.8 ms cold) even on pd-standard HDD**
> (the proven figure was measured on this disk). So we likely do NOT need the SSD conversion to fix the
> PDP lag — just the disk *space* to build the index. SSD conversion is kept below as optional.

### Phase 1 — Grow the boot disk 50 → 80 GB (ONLINE, zero downtime, +$1.20/mo)
```bash
gcloud compute disks resize spotlight-backend-vm-small \
  --zone=us-central1-b --project=spotlight-492502 --size=80
# then on the VM, grow the partition + filesystem online:
sudo growpart /dev/sda 1
sudo resize2fs /dev/sda1
df -h /            # expect ~79G total, lots free
```
(If `growpart` says NOCHANGE, a reboot auto-grows it — and Phase 3's stop/start will anyway.)

### Phase 2 — Build the covering index (off-peak; avoid the 01:00 UTC nightly sync)
Holds a brief write lock (~minutes) and adds ~2–3 GB. Run while still on the **4-vCPU** machine (faster build):
```bash
cd /home/stephenchan/spotlight
.venv/bin/python tools/build_cell_trend_index.py \
  --database-path /home/stephenchan/spotlight/data/spotlight_scanner.sqlite
# tool prints EXPLAIN QUERY PLAN; confirm it shows "USING COVERING INDEX idx_cell_trend_market"
```
(`tools/build_cell_trend_index.py` is in the repo; deploy or scp it first.)

### Phase 3 — Downgrade the machine type (brief downtime, requires stop)
```bash
# optional: stop the backend service + PRAGMA wal_checkpoint(TRUNCATE) first for a clean WAL
gcloud compute instances stop spotlight-backend-vm-small --zone=us-central1-b --project=spotlight-492502
gcloud compute instances set-machine-type spotlight-backend-vm-small \
  --zone=us-central1-b --project=spotlight-492502 --machine-type=t2d-standard-2
gcloud compute instances start spotlight-backend-vm-small --zone=us-central1-b --project=spotlight-492502
# verify after boot:
gcloud compute ssh spotlight-backend-vm-small --zone=us-central1-b --project=spotlight-492502 \
  --command="df -h / ; systemctl is-active spotlight-backend ; curl -s http://127.0.0.1:8788/api/v1/health"
```

**Order matters:** resize (space) → build index (on 4 vCPU) → downgrade machine. Net cost ≈ **−$64/mo**.

### Caveat on the RAM cut (16 → 8 GB)
Less OS page cache for the 30 GB DB → other *uncovered* cold reads (e.g. the portfolio dashboard) may get
slower. The covering index removes the PDP's dependency on cache (index-only), so PDP is fine. If the
dashboard feels slow after the downgrade, that's the trigger to do the SSD conversion below.

---

## OPTIONAL: convert the boot disk to pd-balanced (SSD) — deferred, bigger op
You **cannot change a disk's type in place**; it's snapshot → new disk → swap boot disk. Do it in the same
stop window as the machine downgrade. ~$8/mo for 80 GB pd-balanced.
```bash
gcloud compute instances stop spotlight-backend-vm-small --zone=us-central1-b --project=spotlight-492502
# 1) snapshot the current boot disk
gcloud compute snapshots create spotlight-boot-snap-20260625 \
  --source-disk=spotlight-backend-vm-small --source-disk-zone=us-central1-b --project=spotlight-492502
# 2) create a new pd-balanced 80 GB disk from the snapshot
gcloud compute disks create spotlight-backend-vm-small-ssd \
  --source-snapshot=spotlight-boot-snap-20260625 --type=pd-balanced --size=80 \
  --zone=us-central1-b --project=spotlight-492502
# 3) swap the boot disk
gcloud compute instances detach-disk spotlight-backend-vm-small \
  --disk=spotlight-backend-vm-small --zone=us-central1-b --project=spotlight-492502
gcloud compute instances attach-disk spotlight-backend-vm-small \
  --disk=spotlight-backend-vm-small-ssd --boot --zone=us-central1-b --project=spotlight-492502
gcloud compute instances start spotlight-backend-vm-small --zone=us-central1-b --project=spotlight-492502
# 4) on the VM: grow FS if needed
sudo growpart /dev/sda 1 && sudo resize2fs /dev/sda1
# 5) after verifying health, delete the old disk + snapshot
```
Alternative architecture (cleaner long-term, more setup): keep a small cheap boot disk and put the DB on a
separate **pd-balanced data disk** (mount it, move `data/`, repoint the service). Avoids boot-disk swaps on
future resizes. Only worth it if the DB keeps growing.

## Rollback
- Disk resize: not reversible (can't shrink), but harmless.
- Machine type: re-run `set-machine-type` back to `t2d-standard-4` (e.g. before a card show — matches the
  existing "t2d-standard-2 daily / t2d-standard-4 for shows" plan).
- SSD swap: keep the old disk + snapshot until verified; reattach the old disk to roll back.
