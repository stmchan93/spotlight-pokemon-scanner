# Infra foundation & scaling plan (2026-07-20)

Reference doc for how prod is built and how it scales. Written before the GCP→Hetzner
move so the migration lays the **foundation** correctly and we don't retrofit later.

**Status of this doc:** the *foundation* section describes what we implement as part of
the Hetzner move. The *scaling* section is **documentation only — defer implementation
until a real signal fires** (see the triggers table). Do not build multi-box / Postgres /
CDN / autoscaling now; we have ~no users.

Related: GCP→Hetzner migration steps live in the plan file
`~/.claude/plans/hey-so-can-you-atomic-kazoo.md`. Prod-gating rules: `AGENTS.md`.

---

## Where we are today

- **One box** running the Python backend + **SQLite on local disk** (read-heavy card
  catalog / pricing / scan logging; ~22.6GB after the 2026-07-20 JSON-blob drop + VACUUM).
- **litestream** → GCS (`looty-staging-backups`) for continuous backup / point-in-time
  restore. Daily disk snapshots.
- **GCS** (`looty-staging`) for scan artifacts (uploads are free; only corpus pulls cost egress).
- **Supabase** for auth (external, managed Postgres).
- **Caddy** in front of the backend (TLS). systemd units: `spotlight-backend`, `litestream`.
- App is **invite-gated** (low traffic). Currently on GCP; moving to Hetzner (Ashburn, VA).

This single-box + SQLite + litestream setup is a deliberate, cost-effective architecture —
not a stopgap. The scaling path below keeps every door open without over-building now.

---

## Core principle

**Never mutate the box that's serving traffic.** Scaling = always having a second target
to shift traffic to, with a switch (reverse proxy / DNS) in front. That plus clean data
boundaries is the whole game.

Decide foundations by whether they are **one-way doors** (expensive to reverse — get right
now) or **two-way doors** (cheap to change — defer until a signal).

---

## Foundation — implement as part of the Hetzner move (one-way doors)

These are not "extra work"; they are the migration done correctly.

1. **Own the address layer — `api.ekalight.com` behind Cloudflare.**
   The app must address the backend by a **domain we own**, never a server IP. Today it's
   coupled to the GCP IP via an sslip hostname (`apps/spotlight-rn/eas.json` prod
   `EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL`). After the move, base URL = `https://api.ekalight.com`.
   Then every future move (resize, provider switch, multi-box) is a **DNS change**, and
   repointing installed apps is a **production OTA JS push** (base URL flows through
   `app.config.js` → `extra.spotlightApiBaseUrl`), not an App Store submission.
   *This is the single most important foundation — it makes everything else reversible.*

2. **Provider-agnostic deploy + config.**
   Deploy over plain `ssh`/`scp` to the **hostname** (not `gcloud ... --tunnel-through-iap`).
   Secrets in env files; systemd units + Caddyfile + litestream.yml captured from the VM and
   replayable anywhere. `backend/deploy_to_vm.sh` is already provider-agnostic; only
   `tools/deploy_backend.sh` transport needs a Hetzner target.

3. **Backups from day one.** litestream → object storage (keep GCS target initially) +
   provider snapshots. Any disaster = restore to a fresh box in minutes. Already in place.

4. **Clean data boundaries.** Know what lives where and keep it that way:
   - **SQLite (on box):** read-heavy card catalog, pricing snapshots/cells, scan logs,
     training/export state. Single-writer — fine for reads, watch it for write-heavy growth.
   - **Supabase (Postgres):** auth today; the natural home for **future social / marketplace
     writes** (relationships, feeds, comments, listings) — concurrent writes + realtime.
   - **GCS / (later) Cloudflare R2:** blobs (scan artifacts; future user images/avatars).
   The trap to avoid: dumping write-heavy social/marketplace data into SQLite and hitting
   the single-writer wall.

5. **Reverse proxy in front (Caddy).** Enables blue-green zero-downtime deploys (below) and,
   later, multi-box. Already present.

### Optional-but-recommended during the build: Caddy blue-green deploys
Since we set up Caddy fresh on the Hetzner box, bake in **zero-downtime code deploys** on the
single box: start the new backend on a new port → health-check until the ML model is warm →
Caddy swaps the upstream → drain + stop the old process. Sub-second cutover, no extra box,
and it specifically solves the "model takes seconds to load at startup" gap. If we want the
migration dead-minimal, document it and add later — but this is cheap to include now.

---

## Scaling — DOCUMENT ONLY. Implement each only when its signal fires.

| Scaling step | Implement when… |
|---|---|
| Resize the box (bigger CCX) | CPU sustained high / show-day load. Rescale is a ~2–4 min reboot; **keep disk size** so you can scale back down (disk grow is one-way). |
| Caddy blue-green zero-downtime deploys | *(cheap — recommended to include in the Hetzner build)* |
| Move hot tables to Supabase Postgres | You see `SQLITE_BUSY` / "database is locked" under social/marketplace write load |
| Cloudflare R2 + CDN for images | Image-serving egress bills get annoying, or feeds serve many images repeatedly |
| Multi-box + full Postgres (true HA) | Downtime costs real revenue |
| Multi-region | Users far from Virginia complain about latency |

Each is a bolt-on the foundation already supports — not a rewrite.

---

## Downtime taxonomy (how each kind is handled)

- **Deploy downtime** → *eliminable now* on one box via **Caddy blue-green**. Routine code
  pushes should never take the app down.
- **Maintenance downtime** (e.g. the 2026-07-20 VACUUM — needs exclusive DB access) → rare;
  handled with a quiet-hour maintenance window. Even large orgs do this for some DB ops.
- **Hardware-failure downtime** (box dies) → mitigated to *fast restore* by litestream +
  snapshots. *Eliminating* it entirely = multi-box + Postgres (deferred; see triggers).

Net: routine operations become zero-downtime; the only downtime taken is rare planned
maintenance or an actual dead box — both acceptable at current scale, both improvable later
without re-architecting.

---

## Explicitly NOT now (deliberate)

- Multi-box high availability / autoscaling groups.
- Full app migration to Postgres (only move *hot write tables* when `SQLITE_BUSY` shows up;
  card catalog stays on SQLite).
- Kubernetes / microservices / service mesh.
- CDN / R2 / read replicas / multi-region.
- Moving **staging** off GCP (locked to the E2 commitment — leave it, kill auto-renew).

The reason we can safely stay simple: the foundation (domain-fronted, provider-agnostic,
backed-up, blue-green-capable, clean data boundaries) keeps every scaling door open, so each
step is taken only when a real signal — not a guess — says to.
