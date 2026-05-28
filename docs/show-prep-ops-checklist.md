# Show-Prep Ops Checklist (Spotlight backend)

Reusable runbook for prepping the staging backend before a card-show demo.
Created 2026-05-27.

## Context — why this exists

- Backend VM: `spotlight-backend-vm-small`, zone `us-central1-b`, project `spotlight-492502`, systemd unit `spotlight-backend.service`.
- Root cause of "5–10s scans at the show": `e2-medium` is a **shared-core, burst-credit** machine. Under a burst of scans the credits drain and GCP throttles the VM to its ~1-vCPU baseline (the scheduler *pauses* the process in slices). A healthy CLIP embed is ~**254 ms**; throttled + concurrent (people tapping through stacks) it stretches to **5–10 s**. It was the machine — not the model, not the training data.
- **Daily baseline machine:** `t2d-standard-2` (2 dedicated AMD cores, 8 GB) — no throttle, no OOM.
- **Show machine:** `t2d-standard-4` (4 dedicated cores, 16 GB) — absorbs concurrent bursts.

## A. Free tweaks — do once, effectively zero regression

- [ ] **Pin PyTorch threads to 2 per scan** so concurrent scans don't each grab every core and thrash.
  - Add `OMP_NUM_THREADS=2` (and/or `torch.set_num_threads(2)`) to the backend service env.
  - Single isolated scan: ~no change (ViT-B/32 barely scales past 2 threads). Concurrent scans: large smoothing win.
- [x] **Add 4 GB swap** as an OOM safety net (free; turns a hard crash into a brief slowdown). — DONE 2026-05-27: `/swapfile`, active, in `/etc/fstab`. Optional follow-up: lower `vm.swappiness` 60→10 so swap stays an emergency net rather than routine paging.
- [x] Confirm swap persists across reboot (`/etc/fstab` entry added). Thread-pin still pending (see below).

## B. Show-day — resize up (morning of)

- [ ] Resize VM up to `t2d-standard-4` (stop → set-machine-type → start). ~3–5 min downtime.
- [ ] Verify after start: machine type is `t2d-standard-4`, `free -h` shows ~16 GB, swap present, backend healthy, one test scan returns fast.

## C. Validate before doors open

- [ ] Load test: fire ~10–20 concurrent scans at staging, measure p95; confirm < 3 s.
- [ ] Confirm the app build points at the right backend and a pinned version.

## D. During-show hygiene

- [ ] No deploys / OTA pushes during show hours.
- [ ] No manual scrydex sync during show hours (daily auto-sync runs 09:00 PT / 16:00 UTC, ~1h 45m before Ontario doors — leave it).
- [ ] Tail logs for OOM / errors if anything feels slow.

## E. After the show — resize back down

- [ ] Resize VM back to `t2d-standard-2` (stop → set-machine-type → start) to stop paying `-4` rates.

## Commands

Resize up (show) / down (after) — only the `--machine-type` differs:

```bash
ZONE=us-central1-b
PROJ=spotlight-492502
VM=spotlight-backend-vm-small

gcloud compute instances stop  $VM --zone=$ZONE --project=$PROJ
gcloud compute instances set-machine-type $VM --machine-type=t2d-standard-4 --zone=$ZONE --project=$PROJ   # down: t2d-standard-2
gcloud compute instances start $VM --zone=$ZONE --project=$PROJ
```

Add 4 GB swap (run once on the VM, survives reboot via fstab):

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Pin torch threads: add `Environment=OMP_NUM_THREADS=2` to the `[Service]` block of the
`spotlight-backend.service` unit (or its EnvironmentFile), then `sudo systemctl daemon-reload && sudo systemctl restart spotlight-backend`.

## Gotchas

- Machine type can only change while the VM is **stopped** (no live resize for CPU/RAM). Data is safe — it lives on the persistent boot disk, which stays attached.
- If the external IP is **ephemeral**, a stop/start can change it. Reserve it as static *before* the first resize if any client reaches the backend by IP.
- `t2d` is AMD; the Linux image is `x86_64` so it's compatible. No GPU, no disk changes needed.
