# Production Promotion — Complete Checklist (2026-08-12)

Every task, in dependency order. Companion to `docs/production-promotion-plan-2026-08-12.md` (which has the reasoning and file/line evidence). Legend: **[BLOCKER]** = launch cannot happen without it. **[SHOULD]** = do before real users scale on prod. **[LATER]** = safe to defer past launch.

## Phase 0 — Tooling safety fixes (local, safe, do first)

- [x] **[BLOCKER]** DONE 2026-08-12 — un-scoped `SPOTLIGHT_BACKEND_SECRETS_FILE` fallback removed from deploy + audit (env-scoped vars only; behaviorally verified).
- [x] **[BLOCKER]** DONE — `deploy_to_vm.sh` now hard-aborts if the secrets file's Supabase project ref mismatches the env file's (cross-pairings tested, both abort).
- [x] **[BLOCKER]** DONE — `ENVIRONMENT` is a required arg in `deploy.sh` + `deploy_to_vm.sh` (usage + exit 1; no arg-less callers exist).
- [x] **[BLOCKER]** DONE — tar exclude widened to `./.env*secrets*` (dry-tar verified); stale `.bak-before-moderation` secrets file deleted (was untracked).
- [x] DONE — `restore_staging_db_local.sh` defaults now point at the actual staging box.
- [x] **[SHOULD]** DONE — distinct `SPOTLIGHT_OPS_REFRESH_TOKEN` added to both secrets files; activates on each env's next deploy; `run_sync_vm.sh` already sends `?token=` so the daily sync survives.
- [x] **[SHOULD]** DONE — `tools/run_production_release_gate.sh` created; `backend:deploy:production` repointed at it; verified the gate still hard-blocks without `SPOTLIGHT_PROD_CONFIRM=yes`.

## Phase 0.5 — Identity inventory (read-only, informs everything)

- [x] DONE 2026-08-12 — staging: 10 auth users (8 email, 2 anon); prod: 80 (64 email, 16 anon). **5 email collisions** between projects (different UUIDs). ⚠️ Prod is STILL receiving signups from old builds (Aug 8, Aug 11 + anon) — pre-split binaries in the wild.
- [x] DONE (via merge dry-run) — 54 raw staging owners → 50 canonical after remap; 9 staging-auth uuids, remainder old-prod uuids resolved by remap or kept as prod accounts.
- [x] DONE 2026-08-12 — `tools/migrate_identity_staging_to_prod.py` written + dry-run against live data (reads only): Phase A auth (5 collision deletes + 8 UUID-preserving user inserts + 10 identities), Phase B social (16 tables, 464 rows, triggers paused, verification built in), idempotent, double-gated (`--apply` + `MIGRATE_CONFIRM=yes`). Artifacts in `tools/migration_out/`. AWAITING USER SIGN-OFF on 5 decision points (see plan doc addendum) before apply, inside the cutover freeze window.

## Phase 1 — Prod Supabase catch-up

- [x] **[BLOCKER]** DONE 2026-08-12 — auth_00 ledger repair applied.
- [x] **[BLOCKER]** DONE — blast-radius on prod: both 0 (nothing deleted, as measured).
- [x] **[BLOCKER]** DONE — dry-run showed exactly social_10→social_24; all 15 applied cleanly; ledger fully in sync. Post-push verified: auth.users triggers live, mirror backfill 80=80, blocked_terms 19 hard/117 soft.
- [x] **[BLOCKER]** DONE 2026-08-12 — live end-to-end proven: invite created a user, email delivered via Resend, social_10 mirror + social_14 profile triggers fired, admin delete + mirror-cleanup trigger verified; test user removed.
- [x] **[BLOCKER]** DONE — CLI re-linked to staging (verified).
- [x] **[BLOCKER]** social_12 verified: `messages` is in the supabase_realtime publication. (Live DM smoke on prod still worth doing at cutover.)
- [ ] Dashboard (per project — these do NOT travel with migrations):
  - [x] **[BLOCKER]** DONE 2026-08-12 — Resend SMTP live on prod (port-583 typo and wrong-Resend-account domain issue both fixed; real invite email delivered end-to-end). Rate limit raised to 30/hr. Templates already `{{ .Token }}`. DECIDED: `mailer_autoconfirm` stays ON — email OTP at sign-in already proves ownership; least friction.
  - [x] Rate limits inspected: `smtp_max_frequency` already 60s ✔; email_sent=2/hr until SMTP lands (see above); anonymous 30, otp 100, verify 30, token_refresh 150.
  - [x] **[BLOCKER]** VERIFIED — Apple client IDs already `com.ekalight.app.staging,com.ekalight.app,com.ekalight.app.dev`.
  - [x] **[BLOCKER — USER]** DONE 2026-08-12 — prod callback added to the Google OAuth web client (user); Supabase side verified. Final proof = first Google sign-in from a prod build.
  - [x] **[BLOCKER]** DONE — Manual Linking flipped False→True via Management API (single-field PATCH).
  - [x] **[SHOULD]** DONE 2026-08-12 — Turnstile CAPTCHA enabled on prod and VERIFIED enforcing (tokenless signup rejected). ⚠️ NEW BLOCKER CREATED: the app must send Turnstile tokens — see Phase 3.
  - [x] Anonymous sign-ins confirmed ON.
- [ ] Set `user_profiles.admin_enabled = true` for your account on prod (moderation queue + blocked_terms editing).
- [ ] **[BLOCKER]** Execute the identity migration (from Phase 0.5 dry-run) during the cutover window.

## Phase 2 — Backend + data promotion (needs explicit go + SPOTLIGHT_PROD_CONFIRM=yes)

- [ ] **[BLOCKER]** Deploy current backend code to prod VM (`pnpm backend:deploy:production` after Phase 0 fixes + manual audit/tests). Code-only; never touches `./data`.
- [x]/[ ] **[BLOCKER]** Merge machinery DONE 2026-08-12 — `tools/merge_sqlite_staging_prod.py` dry-run PASSED on real snapshots (50 staging owners: 7 insert/11 replace/9 dual-activity union/20 keep-base/3 drop; 13,907 uuid remap rewrites incl. JSON; test@test.com fully purged both sides; prod catalog rides untouched; schema upgrades applied). CUTOVER STEP REMAINING: re-pull snapshots inside the write-freeze, re-run with --apply, ship merged.sqlite to prod VM.
- [ ] **[BLOCKER]** Post-copy `runtime_setting` fixes on prod (DB rows BEAT env): re-enable scan-artifact uploads via `POST /api/v1/admin/scan-artifact-uploads`; check card-show-mode state.
- [ ] **[BLOCKER]** Catalog/price catch-up sync on prod (copied DB has staging's frozen catalog; prod's Scrydex key + sync are healthy).
- [ ] Keep prod's visual-index artifacts (they're ahead); SSH-diff `visual_index_active_manifest.json` + adapter metadata between boxes to confirm compatibility.
- [ ] **[SHOULD]** Point prod litestream at its own backups bucket (still streams to `looty-staging-backups`).
- [ ] **[SHOULD]** Prod scan-artifact GCS bucket is still named `looty-staging` (`backend/.env.production` ~L70) — rename or accept the name.
- [ ] Smoke on prod: `/api/v1/health`, authed scan round-trip, collections CRUD, recent-sales fetch, DM send + realtime, moderation worker log tail, JWKS auth (staging-migrated user token verifies).
- [ ] Confirm staging keeps serving TestFlight users untouched.

## Phase 3 — App production build + App Store

Code/config items:
- [x] **[BLOCKER]** DONE 2026-08-12 — Turnstile wired (invisible WebView provider, tokens on signUp/password/OTP/anonymous/reset/resend; graceful null path for staging/dev; 24 new tests) AND real site key placed in eas.json production + .env.production. ⚠️ Verify at first prod-build sign-in that the Turnstile widget's hostname list allows `ekalight.com` (the hidden widget runs under that hostname).
- [x] **[BLOCKER]** Remove RevenueCat entirely — DONE 2026-08-12: SDK dependency, staging key, and all paywall gating removed; monetization feature dir deleted; Recent Sales + Lowest Listed free for everyone. OTA-safe now; next native build drops the native module (fingerprint change).
- [x] **[BLOCKER]** DONE 2026-08-12 — auth footer links tappable + new Legal section on the account screen. Discovered: privacy policy lives at the site ROOT (/privacy 404s) and the TERMS page is already live at /terms/.
- [x]/[ ] **[BLOCKER]** Content DONE 2026-08-12 — docs/legal/terms-of-service.md + privacy-policy.md publication-ready (UGC clause, 24h moderation commitment, RevenueCat purged, counsel-review banner). **USER STEP REMAINING: publish to the ekalight-legal GitHub Pages repo per docs/legal/PUBLISHING.md — the live site still serves STALE June docs with no social coverage.**
- [x] **[BLOCKER]** DONE — `ios.privacyManifests` added to app.json as source of truth (9 collected data types per legal README §5, tracking=false); merges non-destructively at prebuild; effective on next NATIVE build. ASC questionnaire must match.
- [ ] **[BLOCKER]** App Store Connect privacy questionnaire — answers per `docs/legal/README.md` §5, consistent with the Play Data Safety table.
- [x] **[BLOCKER]** DONE 2026-08-12 — demo@ekalight.com on prod: password set (Ekalight-Review-2026!), email confirmed, whitelisted via prod runtime_settings. Still to do at cutover: seed it with a few cards. ⚠️ Prod card_show_mode has been ACTIVE since June 17 (gate bypassed for everyone) — decide OFF at launch.
- [ ] **[BLOCKER]** Account deletion completeness (docs/legal §3.1-3.2, §3.11): delete images + all owner tables; don't report success on partial failure.
- [ ] **[SHOULD]** ATS: either move backend to `api.ekalight.com` + real TLS and drop `NSAllowsArbitraryLoads`, or prepare written justification for review.
- [x] DONE — mic usage string removed AND expo-image-picker `microphonePermission: false` set (the plugin silently re-adds it otherwise; Android RECORD_AUDIO blocked too).
- [ ] **[SHOULD]** Age gate / DOB consideration (docs/legal §4.2) — not strictly required for 13+, but revisit.
- [ ] **[SHOULD]** EU/UK consent for session replay (docs/legal §4.3) — or disable replay at launch.
- [x] DONE 2026-08-12 — per-env runtimeVersion in app.config.js: production→0.2.0, all other envs stay 0.1.2 (staging OTAs keep flowing until cutover). Fingerprint policy still a later option.
- [x] DONE — `frontend:build:production` added; `tools/run_production_mobile_release_gate.sh` created (no backend auto-deploy by design; SPOTLIGHT_PROD_CONFIRM gate verified holding); `frontend:update:production` now both platforms.
- [x] DONE — package.json 0.1.0→0.1.3.

Store assets/metadata:
- [ ] **[BLOCKER]** iOS screenshots (none exist; generate per device class).
- [x] **[BLOCKER]** DONE — full iOS runbook + paste-ready metadata in docs/app-store-submission-2026-08-12.md (name/subtitle/promo/description incl. social section, keywords, URLs, ATS justification, review-notes draft).
- [x] **[BLOCKER]** Answer sheet DONE (honest UGC declarations, all 1.2 safeguards real) → expected 13+. Enter into ASC at submission time.
- [ ] Submit profile: add ASC credentials (only `ascAppId` present) or plan to submit interactively.

Ship:
- [ ] **[BLOCKER]** `SPOTLIGHT_PROD_CONFIRM=yes pnpm frontend:release:production` (iOS build + auto-submit; clean worktree required).
- [ ] Monitor review; respond to questions (ATS, microphone if not removed).

## Phase 4 — Android/Play (after iOS)

- [ ] Play store listing: graphics exist (`docs/store-assets/`); listing fields, Data Safety, IARC rating, App access demo login all unchecked in the runbook.
- [ ] Manual `eas build -p android --profile production` + `eas submit` (track internal/draft; no scripted lane exists — script refuses Android release).
- [ ] Revisit Play target-audience (runbook chose 18+; align with iOS 13+).
- [ ] Consider `predictiveBackGestureEnabled: true` for the next native build.

## Cleanup (LATER, non-blocking)

- [x] DONE 2026-08-12 — `release:notes:testflight` script restored + workflow step made no-op-safe; prod still blocked in CI by design.
- [ ] Update stale `apps/spotlight-rn/README.md` script names (~L277-391) and `backend/README.md` staging-target notes (~L157-159).
- [ ] Delete stray `apps/spotlight-rn/build-*.ipa` artifact.
- [ ] Teach `audit_release_config.py` that avatars/post-media buckets are shared across envs intentionally (or split them).
- [ ] `social_19` open item: avatars bucket is deliberately public — revisit.
- [ ] Add artifact-version fields to `/api/v1/health` so VM model versions are diffable without SSH.
