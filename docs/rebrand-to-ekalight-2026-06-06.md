# Rebrand to "Ekalight" — scope, cost, and migration plan

**Status:** analysis + Phase 1 (cosmetic) executed 2026-06-06. Phases 2–4 deferred.

This doc captures what it would take to rename the product from its current two names —
**`spotlight`** (internal) and **`looty`** (external/product) — to **Ekalight**, everywhere:
code, env vars, the app bundle, GCS buckets, the VM, and the database.

> **The single most important fact:** the **visible app name is independent of the bundle id.**
> You can ship an app called "Ekalight" to users **today** (Phase 1) without touching
> `com.looty.*`, the EAS project, or any GCS bucket. Changing the bundle id / EAS project /
> buckets / VM is the **expensive, irreversible** part and should be a separate, deliberate
> decision (Phases 3–4).

---

## 1. The two-name landscape

| | `spotlight` (internal) | `looty` (external / product) |
|---|---|---|
| Packages | `@spotlight/{mobile-app,api-client,design-system}`, root `spotlight`, `spotlight-slab-scanner` | — |
| Imports | `~156` `@spotlight/*` (resolved via pnpm `workspace:*`; no babel/metro resolver) | — |
| Env vars | `SPOTLIGHT_` / `EXPO_PUBLIC_SPOTLIGHT_` (**103 distinct**) | — |
| Cloud / infra | GCP project `spotlight-492502`, VM `spotlight-backend-vm-small`, `spotlight-backend.service`, DB `spotlight_scanner.sqlite`, `~spotlight-datasets`, repo folder `spotlight/`, legacy `Spotlight/` Swift app | GCS buckets `looty-staging`, `looty-prod`, `looty-staging-backups` |
| App identity | URL scheme `spotlight://`, deep-link `exp+looty` | app name `Looty`, slug `looty`, bundle `com.looty.staging` + `com.looty.spotlight.dev`, EAS project `bd29d8aa-…`, owner `schan93`, ASC app `6764104335`, `ios/Looty/` |
| Outbound | — | UA `Looty/0.1 (+https://local.looty.app)`, staging URL `looty.34.59.188.129.sslip.io` |

The DB **schema has no product strings** (verified `backend/schema.sql`) — no in-data rename needed.

---

## 2. The four difficulty tiers

**Tier 1 — Mechanical strings (reversible, low risk).** Package names + `workspace:*` deps,
`@spotlight/*` imports, `SPOTLIGHT_`→`EKALIGHT_` env names (code side), user-agent strings,
tool-script bucket/VM defaults, docs, and the **app display name** + permission strings.
Grep-and-replace + tests.

**Tier 2 — External / irreversible identity (console + reinstall).**
- iOS/Android **bundle id** `com.looty.*` → changing it creates a **new** App Store / TestFlight
  app; existing installs cannot auto-update, testers must reinstall.
- **EAS projectId** `bd29d8aa-…` + updates URL `u.expo.dev/<uuid>` → a new project means old
  binaries silently stall on OTA.
- **URL scheme** `spotlight://` (+ `exp+looty`) → breaks saved deep links and OAuth redirects.
- **ASC app id** `6764104335`, and **Supabase** allowed redirect URLs.

**Tier 3 — Stateful resources (need migration scripts + data move).**
3 GCS buckets, the VM, the live `~7 GB` SQLite DB, and the GCP project itself (cannot be renamed).

**Tier 4 — Coupled VM contracts (must move in lockstep with the running VM).**
`spotlight-backend.service` systemd unit, crontab markers `# BEGIN/END spotlight-backend-vm`,
`SPOTLIGHT_RUNTIME_LABEL` (`vm-backend:`/`vm-sync:` values already written into the live audit
DB), and the 103-var `SPOTLIGHT_` EnvironmentFile on the VM. Renaming the env-var **prefix** in
code without updating the VM's EnvironmentFile in the same deploy **breaks the backend**.

---

## 3. Two paths (pick per your appetite)

| | **Path A — Cosmetic** (recommended first) | **Path B — Full identity** |
|---|---|---|
| App display name | `Ekalight` | `Ekalight` |
| Internal code/packages/env (Tier 1) | rename | rename |
| Bundle id / EAS / ASC (Tier 2) | **keep `com.looty.*`** | **new `com.ekalight.*`** + new EAS project + new ASC app |
| GCS buckets / VM / GCP (Tier 3) | **keep** (optionally rename buckets only) | migrate all → `ekalight-*` |
| User reinstall? | **No** | **Yes** |
| OTA continuity | intact | breaks for old binaries |
| Effort | ~1–2 days, reversible | multi-week, irreversible, console + migration heavy |

---

## 4. Phasing

- **Phase 1 — Cosmetic (DONE 2026-06-06).** Visible name + harmless brand strings. No coupling,
  fully reversible. See §7.
- **Phase 2 — Internal code rename.** `@spotlight/*` package names + `~156` imports + `workspace:*`
  deps; `SPOTLIGHT_`→`EKALIGHT_` env vars **in lockstep with the VM EnvironmentFile**; tool-script
  defaults; docs. Big but internal; no user impact.
- **Phase 3 — External identity.** New bundle id, new EAS project + ASC app, scheme change +
  Supabase redirects. Breaks continuity → requires reinstall + console work.
- **Phase 4 — Infra migration.** GCS buckets, VM, DB (playbooks in §5).

> **What breaks if half-done:** renaming the env prefix in code but not on the VM → backend won't
> start; switching the EAS project but shipping old binaries → OTA stalls; repointing a bucket
> before `rsync` completes → missing scan artifacts.

---

## 5. Migration playbooks (Tier 3/4 — documented, NOT yet run)

**GCS bucket (×3: `looty-staging`, `looty-prod`, `looty-staging-backups`).** Buckets can't be
renamed.
```
gsutil mb -l <region> gs://ekalight-<x>
gsutil -m rsync -r gs://looty-<x> gs://ekalight-<x>
# repoint: backend/.env.staging:40, .env.production:15, tools/refresh_rerank_pool.sh,
#          build_full_review_queue.py, apply_verify_and_audit.py, export/audit defaults
# verify: backups → `litestream restore -o /tmp/t.sqlite gcs://ekalight-staging-backups/spotlight_scanner`
#         artifacts → read a known object
gsutil rm -r gs://looty-<x>   # only after verification
```

**VM (`spotlight-backend-vm-small`).** GCE can't rename an instance.
```
# create ekalight-backend-vm-small (same zone us-central1-b, same spec)
gcloud compute scp <old-vm>:~/spotlight/data/spotlight_scanner.sqlite <new-vm>:~/...
bash tools/deploy_backend.sh staging        # rewrites systemd unit + crontab markers
bash backend/run_vm_health_check.sh         # verify
# cut mobile over (or move the sslip.io/DNS), monitor 24–48h, then decommission old
```

**Env-var prefix (`SPOTLIGHT_`→`EKALIGHT_`).** Must change `backend/.env.*` AND the VM's
EnvironmentFile in the **same** deploy. `SPOTLIGHT_RUNTIME_LABEL` history stays as-is (old labels
remain in the audit DB; new VMs emit `ekalight-…`). No schema/data migration.

**GCP project (`spotlight-492502`).** Not renameable. Recommend **keeping it** — a new project
means re-IAM, re-billing, new service accounts; not worth it for a name.

---

## 6. External console actions (outside the repo)
- **Apple Developer / App Store Connect:** new app record for `com.ekalight.*`, new ASC app id (for `eas.json` submit).
- **Expo / EAS:** new project + UUID (for `app.json` + `eas.json`), or rename the existing project.
- **Supabase:** update allowed OAuth redirect URLs if the scheme changes (`spotlight://login-callback` → `ekalight://login-callback`).
- **DNS / TLS:** if the `looty.*` staging URL changes.

---

## 7. Phase 1 — what was changed (2026-06-06, cosmetic)
Reversible, no bundle/scheme/env/package/infra impact:
1. **App display name** — `apps/spotlight-rn/app.json`: `expo.name` → `"Ekalight"`; the iOS
   `NSCameraUsageDescription` and `expo-camera` `cameraPermission` strings → "Allow Ekalight…".
   *(Static config; takes effect on the next **native build** — NOT an OTA.)*
2. **Outbound user-agent** — `Looty/0.1 (+https://local.looty.app)` →
   `Ekalight/0.1 (+https://local.ekalight.app)` in `backend/scrydex_adapter.py`,
   `backend/fx_rates.py`, and 5 `tools/*.py`.
3. **Backend log strings** — "Looty scan service" → "Ekalight scan service" in `backend/server.py`.

**Untouched (kept for later phases):** slug `looty`, scheme `spotlight://`, bundle ids
`com.looty.*`, EAS project + updates URL, `SPOTLIGHT_` env vars, `@spotlight/*` packages, native
`ios/Looty/` dir, GCS buckets, VM, DB, GCP project, the `looty.app`/sslip URL.

---

## 8. Open decisions (before Phases 3–4)
1. Do you actually want a new **bundle id** (and the reinstall/new-App-Store-app it forces), or is
   "Ekalight" as the **display name** over the existing `com.looty.*` bundle enough indefinitely?
2. New **EAS project** vs rename the existing one.
3. Rename **GCS buckets** (migration) vs leave them `looty-*` (purely internal names).
4. Change the **URL scheme** (breaks deep links/OAuth) vs keep `spotlight://`.
5. Rename the `SPOTLIGHT_` **env prefix** (Tier 4 lockstep) vs leave it.
