# Production Promotion Plan — 2026-08-12

Goal: promote the staging stack (backend VM + Supabase + app) to production, then ship the App Store release. Written from a three-agent audit of the repo, both VMs, and both Supabase projects on 2026-08-12.

## The one decision that shapes everything: where do your users' identities live?

Since the Supabase split (2026-08-06), **your real TestFlight users authenticate against the STAGING Supabase project** (`mphjen…`) and their card data lives on the **staging VM's SQLite**, owner-keyed by their *staging* Supabase user ids. The production Supabase project (`lvnjsh…`) holds the pre-split accounts and has received nothing since.

Backend rows are owned by Supabase user UUIDs. If the production app simply points at prod Supabase, every current user signs in and gets a *different* UUID — and their collections/scans/posts orphan. So promotion is not just "deploy to the prod box"; it's a **data + identity migration**:

- **Recommended (A): migrate staging → prod, preserving UUIDs.** Copy staging Supabase auth users + social tables into the prod project keeping the same user ids (the pattern `docs/supabase-migration-runbook-if-ever-needed-2026-08-06.md` was written for), and copy the staging SQLite's user-owned tables to the prod VM. Users keep everything; they re-sign-in once (sessions don't survive a project move).
- (B) Declare staging the new prod (relabel) — rejected: leaves "production" pointing at the free-tier project with the template gate, wrong buckets, and no clean env story.
- (C) Fresh start on prod — rejected: your beta users lose their collections weeks before the Aug 22 show.

**Pre-req inventory (safe, read-only, do tonight):** count `auth.users` in both projects, list distinct `owner_user_id`s in the staging SQLite, and check overlap with prod Supabase — this tells us exactly how big the identity migration is and whether any pre-split accounts need merging.

> **ADDENDUM (later same day, from the migration dry-run):** the framing below is HALF wrong — prod's user data is NOT stale. Old builds kept writing to the prod VM after the split: ~24k rows for ~38 real users (team@mainstreetcards +6.6k rows, nataliesooter5 +2.6k, the July-12 show cohort, and the owner's own pre-split history). One user (johnsonma626) was still actively using an old build against prod as of 2026-08-12. Phase 2's data step is therefore a **per-owner union merge of the two SQLites** (+ the uuid remap from `tools/migration_out/uuid_remap_staging_prod.json`), not a staging-over-prod copy. The identity script and its dry-run report are the source of truth: `tools/migrate_identity_staging_to_prod.py`, `tools/migration_out/`.

## The second fork in the road: the two databases diverged in opposite directions

The VMs forked 2026-07-10. Since then:
- **Staging SQLite**: fresh *user* data (all TestFlight activity), **frozen catalog/prices** (no sync cron, no Scrydex key).
- **Prod SQLite**: fresh *catalog/prices* (daily sync, 466+ clean Scrydex calls/day) and a visual index that has grown incrementally for a month, but **stale user data**.

Plan: copy the staging DB to prod (file-level copy per the runbook — never disk snapshots), keep prod's **visual index artifacts** (they're separate files, ahead of staging's), then run a **catalog/price catch-up sync** on prod to un-freeze the copied DB's catalog tables. Two gotchas travel *inside* the DB file as `runtime_setting` rows and override env: scan-artifact uploads (staging has them OFF; flip ON via `POST /api/v1/admin/scan-artifact-uploads` after the copy) and card-show-mode state.

## Phase 0 — Fix the guns pointed at our feet (tonight, all local, zero risk)

The audited env landmine is real but subtler than remembered: the checked-in config is correct, and the danger is **un-scoped override variables**:

1. `SPOTLIGHT_BACKEND_SECRETS_FILE` (generic, applies to BOTH envs) — if it's exported in the shell, a prod deploy silently ships the staging secrets file, and because staging's secrets file contains `SUPABASE_URL` (line 29), prod gets repointed at staging Supabase. The audit tool honors the same variable, so it validates the wrong file. **Fix: delete the generic fallbacks in `tools/deploy_backend.sh:60,65-68` and `tools/audit_release_config.py:459`; add an assertion in `backend/deploy_to_vm.sh` that the secrets file's Supabase project ref matches the env file's before the copy.**
2. `bash deploy.sh` run by hand on the prod box defaults to `staging` (`${1:-staging}`) — repoints runtime config AND strips the sync/PPT crons. **Fix: make `ENVIRONMENT` required (no default) in `backend/deploy.sh` and `backend/deploy_to_vm.sh`.**
3. The deploy tarball leaks `backend/.env.staging.secrets.bak-before-moderation` (tar exclude pattern misses suffixed names). **Fix the exclude; delete the file.**
4. `tools/restore_staging_db_local.sh` is named "staging" but defaults to the **prod** box (stale pre-split values). **Fix defaults.**
5. Set `SPOTLIGHT_OPS_REFRESH_TOKEN` in both secrets files — three ops endpoints are currently unauthenticated (localhost-bound only). This is the pre-launch lockdown item.
6. (Nice-to-have) `guard_rerank_pool` and the audit only see the laptop's files; note in the runbook that VM artifact versions must be diffed over SSH (`visual_index_active_manifest.json` on each box).

## Phase 1 — Prod Supabase catch-up (can start tonight; careful, but reversible)

Prod is 16 ledger entries behind (`auth_00` repair + `social_10`…`social_24`). In order:

1. Link CLI to prod, `supabase migration repair --status applied 20260419210000` (auth_00 is repair-only, never executed).
2. Run the two blast-radius queries from `apps/spotlight-rn/supabase/README.md` before applying: social_19's `DELETE FROM follows` (blocked pairs) and social_21's `DELETE FROM notifications` (blank rows) — expected ~0 on prod.
3. `supabase db push` through social_24 (social_24 strictly after social_22 — same constraint they both touch).
4. Watch social_10's `auth.users` trigger: if it raises, prod signups fail with an opaque GoTrue error — test one signup immediately after.
5. **Re-link the CLI to staging** (the checked-in link state must stay staging).
6. Dashboard config that migrations can't carry: custom SMTP (Resend) + `{{ .Token }}` templates (prod is likely grandfathered and editable — verify), rate limits with 60s `max_frequency`, **Manual Linking ON** (guest→account conversion breaks without it), Apple Client IDs must include `com.ekalight.app`, `spotlight://login-callback` in redirect list, prod callback URL in the Google OAuth client, CAPTCHA on anonymous sign-in (before guest mode scales).
7. Set `user_profiles.admin_enabled = true` for your account (moderation review queue).
8. Identity migration per the decision above (its own runbook step — script it, dry-run against a restore first).

## Phase 2 — Backend promotion (after Phase 0 fixes; needs explicit go + `SPOTLIGHT_PROD_CONFIRM=yes`)

1. Deploy current backend code to the prod VM via `pnpm backend:deploy:production` (raw script — note it has **no gate**: run `pnpm audit:production` and the test suite manually first; consider adding a prod gate wrapper mirroring staging's). Deploys never touch `./data`, so this is code-only. Ships everything since July 10 (expansions 100-cap fix, slab sanitizer, collections fixes, moderation worker updates…).
2. Data migration window: brief staging write-freeze (announce in TestFlight or pick 3am), litestream-consistent copy of staging SQLite → prod box, flip the two `runtime_setting` rows, run catalog catch-up sync, verify.
3. Keep prod's visual-index files; confirm the adapter/manifest versions on the prod box match what staging serves (SSH diff of the two manifests) — they should, both descend from the June builds, prod's just has incremental adds.
4. Litestream: point prod at its **own** backups bucket (it still streams to `looty-staging-backups` — flagged in the cost plan).
5. Smoke: health, authed scan round-trip, recent-sales fetch (Scrydex ready ✔), collections CRUD, a DM send, moderation worker log.
6. Staging keeps running untouched — TestFlight users are unaffected until the App Store build moves them.

## Phase 3 — App Store release (realistically: days, not tonight)

Hard blockers found in the audit (each small, none optional):
1. **RevenueCat key missing from the production profile** → prod builds currently grant premium for free (`purchases.ts:113-118`). Add `EXPO_PUBLIC_REVENUECAT_IOS_KEY` to `eas.json` production env + `.env.production`.
2. **Terms/Privacy links are dead text** in-app (`auth-controls.tsx:240-252`) — the legal site is live now; wire the links. Finish the two DRAFT docs' placeholders first.
3. **`PrivacyInfo.xcprivacy` declares zero collected data** while PostHog + session replay ship — fill per `docs/legal/README.md` §5, and match App Store Connect's privacy questionnaire to the Play Data Safety table.
4. **Review account**: the invite-only access gate will lock out Apple's reviewer — whitelist a demo account and put its credentials in App Review notes.
5. ATS: `NSAllowsArbitraryLoads: true` + raw `sslip.io` IP host invite a review question. Ideal fix is `api.ekalight.com` + TLS and dropping the exemption; acceptable short-term is a written justification.
6. Remove the unused microphone permission string.
7. Account deletion gaps (docs/legal §3.1-§3.2, Guideline 5.1.1(v) risk): deletion should cover images + all owner tables, and not report success on partial failure.
8. Screenshots + App Store metadata (none exist for iOS; the Android runbook's copy at `docs/android-play-store-submission-2026-07-20.md:28-59` is the paste-ready source).
9. Bump `runtimeVersion` (still `0.1.2` everywhere) for the prod binary so production OTAs can never land on staging-era binaries; add `frontend:build:production` and a prod release gate mirroring staging's (prod lane currently skips check/audit/smoke).
10. Submit profile needs ASC credentials wired (only `ascAppId` present) — fine interactively, gap for CI.

Then: `SPOTLIGHT_PROD_CONFIRM=yes pnpm frontend:release:production` (iOS build + auto-submit), Android later via manual `eas build/submit -p android --profile production` (Play track `internal`, listing still unchecked in the runbook).

### Age rating: answer the questionnaire honestly — 13+ is the likely result
Apple's 2025 system is 4+/9+/13+/16+/18+ (17+ no longer exists). The rating is computed from your questionnaire answers; UGC + DMs with the moderation you already have (report ✔, block ✔, wordlist + AI moderation ✔, contact ✔) typically lands **13+**. There is no "start high, lower later" requirement — that dance buys nothing, and lowering later is just another submission. What Apple actually gates UGC apps on is Guideline 1.2 compliance (report/block/moderation/contact — you have all four; the missing bit is the tappable Terms link with an objectionable-content clause, which is item 2 above). Note the Play runbook chose 18+ ("Target audience") for Android — revisit for parity once iOS lands at 13+.

## Suggested sequence

- **Tonight:** Phase 0 tooling fixes + read-only identity inventory + Phase 1 items 1–7 (Supabase catch-up + dashboard). Start Phase 3 items 1, 2, 4, 6 (they're small code/config changes).
- **Next session:** identity migration dry-run → Phase 2 backend + data promotion with a write-freeze window.
- **This week:** Phase 3 remainder → submit for review (Apple review is typically ~1-2 days).
- **Keep staging serving TestFlight throughout** — nothing here disrupts current users until the App Store build is in their hands.

## Appendix: file/line index

- Env landmine: `tools/deploy_backend.sh:54-71,108,116-119`; audit blind spot `tools/audit_release_config.py:456-465`; secrets copy `backend/deploy_to_vm.sh:36-44`; staging-default `backend/deploy.sh:6`, `backend/deploy_to_vm.sh:7`; tar leak `tools/deploy_backend.sh:240`.
- Migrations: `apps/spotlight-rn/supabase/migrations/` (through `20260818090000_social_24`); README blast-radius queries `supabase/README.md:243-248,283-293`; promotion checklist `docs/supabase-project-split-and-promotion-2026-08-06.md:82-126`.
- Data-vs-env precedence: `backend/server.py:2798-2825` (runtime_setting beats env).
- Deploy transport & exclusions: `tools/deploy_backend.sh:236-272,471-488`.
- Visual index versions: `data/visual-models/raw_visual_adapter_active_metadata.json`, `data/visual-index/visual_index_active_manifest.json` (diff over SSH; prod mutates in place daily via `run_sync_vm.sh:42-52`).
- App release lane: `apps/spotlight-rn/eas.json` (production profile 55-76, submit 78-94); RevenueCat gap `src/features/monetization/purchases.ts:113-118`; dead legal links `src/features/auth/components/auth-controls.tsx:240-252`; legal checklist `docs/legal/README.md`; Android runbook `docs/android-play-store-submission-2026-07-20.md`.
