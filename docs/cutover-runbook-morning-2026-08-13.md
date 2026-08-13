# Morning Cutover Runbook — 2026-08-13

> **STATUS UPDATE 07:10 UTC:** BACKEND DEPLOY SUCCEEDED (attempt 3, gate summary
> 20260813T070345Z). Prod is LIVE on the NEW code — verified: health 200, and
> `/api/v1/collections` answers 401 (exists ⇒ new code; old code 404'd it).
> Data is NOT yet remapped. Two earlier failed attempts: (1) `!`-runner killed the
> process mid-tests; (2) the NEW VM-side audit correctly refused over a stale
> pre-split `.env.staging.secrets` on the prod box — now moved to
> `~/spotlight/attic-pre-split/`. Remaining steps: runbook items 4 (remap via
> user `!`), 6-9 (verify, smoke, OTA repoint, captcha re-enable), 10 (housekeeping).
> The remap one-liner (stops service ~1 min, runs patched script, restarts):
> `gcloud compute ssh spotlight-backend-vm-small --zone=us-central1-c --command="sudo systemctl stop spotlight-backend && python3 /tmp/remap_prod_owners.py --db /home/stephenchan/spotlight/data/spotlight_scanner.sqlite 2>&1 | tail -3; sudo systemctl start spotlight-backend"`

Written the night of Aug 12 after parking the cutover mid-flight. This is the
authoritative state + script. A fresh session should read THIS first, then
`docs/production-promotion-checklist-2026-08-12.md` for wider context.

## EXACT CURRENT STATE (as of Aug 13 ~06:30 UTC)

### Prod backend VM (spotlight-backend-vm-small, us-central1-c)
- Running the OLD (pre-July-10) code against the ORIGINAL live DB — real users
  (Mainstreet Cards etc.) are being served normally. NOTHING user-facing swapped yet.
- On disk, ready: `/home/stephenchan/spotlight/data/prod_snapshot_cutover.sqlite`
  — a 28.57GB consistent snapshot taken ~05:45 UTC and then REMAPPED
  (4 owner-uuid rewrites + test@test.com purge). Treat it as the validated
  REHEARSAL + emergency data source, NOT the file to ship: live prod kept taking
  writes after the snapshot, so shipping it would lose overnight rows.
  ⚠️ FIRST TASK TOMORROW: read the remap job's output (task bzd41j74n in this
  session's tasks dir) and confirm it printed `REMAP COMPLETE` + `integrity: ok`.
- Scripts staged in `/tmp/` on the box: `remap_prod_owners.py`,
  `merge_sqlite_staging_prod.py` (the remap imports its table map), remap json.
- runtime_settings on live prod: `card_show_mode` ACTIVE (access gate open —
  user decision: STAYS OPEN at launch), `scan_artifact_uploads` enabled,
  `access_whitelist_emails` = [demo@ekalight.com].

### Prod Supabase (lvnjshymwvagwadqeofm)
- Migrated through social_24 ✔; SMTP via Resend LIVE (tested end-to-end) ✔;
  manual linking ON ✔; templates carry {{ .Token }} ✔; autoconfirm ON (decided).
- **CAPTCHA: OFF** (user toggled it off ~06:00 UTC after we found it blocking
  real prod users on old builds). RE-ENABLE ONLY after the Turnstile-carrying
  app update is verified live (step 8 below).
- Identity Phase A COMMITTED: the 8 staging-origin identities exist; the 5 old
  duplicate accounts (stmchan8953, johnsonma626, trogdor85, t4g…privaterelay,
  test@test.com) were DELETED. Consequence until the swap: those people sign in
  → new uuid → prod backend shows them EMPTY collections. Fixed by the remap.
- Social tables: EMPTY (clean-slate launch — the staging social copy (Phase B)
  was deliberately ABANDONED per user decision; `tools/migration_out/phase_b_retry.py`
  must never be run — delete it).
- Demo reviewer account: demo@ekalight.com / password `Ekalight-Review-2026!`,
  email-confirmed, whitelisted. Seed it with a few cards post-cutover.
- test@test.com's *staging-origin* auth user (2baa9c54…) WAS migrated in Phase A;
  user wants it gone — delete post-cutover via the app's account-deletion
  endpoint or admin API (its SQLite rows are already purged by the remap).

### Staging (VM + Supabase mphjen…)
- Fully operational; TestFlight users unaffected all night. One hiccup during
  the freeze: `spotlight-backend` start once failed on its prewarm race —
  fix was simply restart + 45s patience.
- Staging's social/card data stays in staging FOREVER (user ruling: staging is
  purely testing). People who only ever existed on staging start fresh on prod.

### Laptop / repo
- The working tree holds ALL of today's uncommitted work (Turnstile app code +
  real site key in `eas.json` production env + `.env.production`; RevenueCat
  removal; legal links; privacy manifest; deletion completeness; release lanes;
  runbooks). COMMIT AFTER CUTOVER (never mid-OTA).
- Legal pages LIVE (root=privacy, /terms/); App Store metadata + age sheet in
  `docs/app-store-submission-2026-08-12.md`.

## MORNING SEQUENCE (~20 min; prod down ~10-15 min)

Claude drives; USER steps marked. The `!` prefix = user runs it in-session.

1. **Verify rehearsal** (Claude): remap job output shows REMAP COMPLETE +
   integrity ok. If not, STOP and diagnose before anything else.
2. **Begin window** (Claude): on prod box — `sudo systemctl stop spotlight-backend`
   and stop litestream (`sudo systemctl stop litestream`). Real users see the
   app error for the window's duration.
3. **Backup live file** (Claude): `cp` the live
   `data/spotlight_scanner.sqlite` → `data/spotlight_scanner.pre-cutover-20260813.sqlite`
   (plain cp is safe with the service stopped; ~3 min). THIS is the rollback.
4. **Remap the LIVE file** (Claude): rerun
   `python3 /tmp/remap_prod_owners.py --db /home/stephenchan/spotlight/data/spotlight_scanner.sqlite`
   — same script that passed on the rehearsal snapshot; it self-verifies and
   rolls back its transaction on any stale row. Fast (the overnight snapshot
   run's slow part was only the final quick_check).
5. **Deploy** (USER):
   `! SPOTLIGHT_PROD_CONFIRM=yes pnpm backend:deploy:production`
   — new gate runs check → audit → deploy → smoke; the deploy restarts the
   service on the remapped DB and polls health ~5 min. Also restart litestream
   after (Claude): `sudo systemctl start litestream`.
6. **Server-side verification** (Claude): /api/v1/health 200; whitelist +
   show-mode rows intact; Mainstreet's 6,629 rows still count; stmchan's
   ~10,298 rows now resolve under uuid 0084c543…; recent-sales endpoint works
   (Scrydex ready); ops token now active (this deploy shipped it).
7. **SMOKE TEST** (USER, on their phone — can use a dev build pointed at prod,
   or wait for step 8's OTA and smoke right after):
   sign in (email code arrives via Resend / Google / Apple) → REAL collection
   visible (10k rows) → scan a card → add it → feed is a clean slate → send a DM.
   GO/NO-GO GATE: only proceed past here on user's green light.
   Rollback if red: stop service, `mv` backup file back, redeploy old code is
   NOT needed (old code still on box until deploy; if deploy already ran,
   rollback = swap file back + `systemctl restart spotlight-backend` — new code
   serves old data fine).
8. **OTA repoint** (Claude): temporarily edit `apps/spotlight-rn/eas.json`
   staging env block → prod values (`EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL` =
   https://looty.34.59.188.129.sslip.io, Supabase URL + anon key = lvnjsh… pair
   from the production block, plus `EXPO_PUBLIC_TURNSTILE_SITE_KEY`) →
   `pnpm frontend:update:staging` → REVERT the eas.json edit immediately.
   TestFlight users relaunch twice → signed out once → sign in on prod.
9. **Re-enable CAPTCHA** (USER, ~5 min after verifying a sign-in through the
   repointed app works): Supabase prod → Auth → Attack Protection → ON.
   Then verify sign-out/sign-in on the phone once more (Turnstile token path).
10. **Housekeeping** (Claude): commit the whole tree (structured commits);
    update checklist; delete `phase_b_retry.py`; delete test@test.com auth user;
    seed demo account with 2-3 cards; update memory.

## AFTER (same day, store track)
- USER: 6 iPhone screenshots + reuse for Play (shot-list in the submission doc).
- Production native build: `SPOTLIGHT_PROD_CONFIRM=yes pnpm frontend:build:production`
  (first prod binary: runtime 0.2.0, Turnstile, no RevenueCat, privacy manifest).
- App Store Connect: create listing from `docs/app-store-submission-2026-08-12.md`
  (metadata, privacy questionnaire, age questionnaire → 13+, review notes with
  demo@ekalight.com / Ekalight-Review-2026!). Submit.
- Later: Play internal track; prod litestream own bucket; api.ekalight.com + drop
  ATS exemption; re-check Turnstile widget hostnames include ekalight.com.

## Open risks ledger
- Old-build users (pre-Aug binaries) keep working against prod after cutover
  (new backend serves them; their JS lacks Turnstile → keep captcha OFF until
  they're a non-factor, or accept sign-in breakage for them once re-enabled —
  they should update via TestFlight/App Store anyway).
- Overnight-written prod rows are preserved by remapping the LIVE file (step 4),
  not shipping the stale snapshot.
- 23 dangling scan_events.deck_entry_id refs (pre-existing, informational).
