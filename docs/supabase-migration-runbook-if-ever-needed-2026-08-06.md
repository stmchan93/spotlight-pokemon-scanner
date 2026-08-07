# Supabase migration runbook — the plan if the time ever comes

Date: 2026-08-06
Status: STANDBY. Not scheduled. This is the executable plan for a migration we have deliberately
decided **not** to do yet.

Read first: `docs/supabase-scale-plan-and-escape-hatch-2026-08-06.md` — that doc holds the
**decision** (stay on Supabase, target 100k MAU) and the cost model. This doc holds the **design
choices, the invariants, and the step-by-step migration** so that whoever executes it later does not
have to re-derive any of it.

---

## 1. When to open this doc

Only when one of these fires. Do not migrate for aesthetics.

- Supabase bill sustained above **~$1,500/mo** (roughly 300k+ MAU), **or**
- a compliance or acquisition requirement for a single GCP IAM / VPC / bill, **or**
- reliability that materially hurts the product, **or**
- Supabase changes pricing or terms in a way that breaks the model in the scale-plan doc.

If none has fired, close this doc and go build product. The scanner fleet is the more expensive
problem at every scale we can foresee.

---

## 2. Decision log — why the architecture is the way it is

These are the choices that determine how hard a migration is. Each is recorded with its reasoning so
a future reader can tell a deliberate trade from an accident.

| # | Choice | Why | Migration consequence |
|---|---|---|---|
| D1 | **Social data lives in Supabase Postgres, not the SQLite backend** | The Python backend is a single-VM stdlib `http.server` over SQLite — no framework, no realtime, single-writer. Social is many small concurrent writes + cross-user reads. | None. It's plain Postgres; `pg_dump` moves it. |
| D2 | **Card catalog / 27.5M-row price history / visual index stay VM-local SQLite** | They're a *rebuildable cache* (vendors are truth, rebuilt nightly), and the hot scan path needs zero network hops and CPU co-location with SigLIP2. | None — explicitly out of scope for any Supabase migration. |
| D3 | **The Supabase auth uuid is the universal user key** | One identity across two datastores. `owner_user_id` in SQLite == `user_id` in `user_profiles` == `auth.uid()`. | **The hard constraint.** See §3. |
| D4 | **The backend verifies JWTs itself** (`backend/request_auth.py`) | Keeps the backend independent of Supabase's client SDK; supports both HS256 and JWKS. | Huge win. 148 lines, env-driven, works unchanged against self-hosted GoTrue. |
| D5 | **No Edge Functions, ever** | Deno runtime + deploy model with no equivalent elsewhere; the moderation AI pass runs on the VM we already own. | Zero exposure. |
| D6 | **User image bytes go to GCS, not Supabase Storage** | Egress is the #1 Supabase cost surprise, and it scales with usage not users. Done for avatars (`avatar_store.py`) and post media (`post_media_store.py`). | Near-zero exposure. Only legacy `user_profiles.avatar_url` values still point at Supabase Storage. |
| D7 | **Social reads are client-direct via PostgREST under RLS** | Ships fast; RLS is standard Postgres and portable. | **Accepted cost.** ~40 policies, but they survive if `auth.uid()` survives (§3). |
| D8 | **Supabase Realtime for DMs** | Building a WebSocket tier to preserve optionality we're unlikely to exercise is the expensive choice at our scale. | **Accepted cost.** This is the one genuinely non-portable thing we chose. Rebuild required. |
| D9 | **Migrations are plain SQL files in the repo**, standard Postgres only (`citext`, `pgcrypto`) | Portability and reviewability. | Replays against any Postgres. |
| D10 | **New tables FK to `public.users`, not `auth.users`** | Adopted 2026-08-06. Existing ~18 FKs into GoTrue's schema stay; new ones don't add to the problem. | Shrinks the hardest part of the exit over time. |

### Deliberately accepted lock-in

D7 and D8. If we migrate, we rebuild the realtime tier and re-home the client-direct read path.
Everything else moves mechanically. This was a conscious velocity trade, not an oversight.

### The rules that keep it that way

Violating these is what turns a 2–3 week migration into a 3-month one:

1. Never foreign-key to `auth.users`.
2. Never read the `auth` schema from application code.
3. Keep one client seam — `createClient` in exactly one file.
4. Keep JWT verification env-driven; nothing else in the backend knows what an issuer is.
5. Our own backend never delegates authorization to RLS.
6. No Edge Functions. No new Supabase Storage usage.

---

## 3. The invariants that must survive

**I1 — Every user's uuid must be preserved.** Non-negotiable. `owner_user_id` across ~12 SQLite
tables *is* the Supabase auth uuid (`scan_events`, `scan_confirmations`, `scan_artifacts`,
`card_favorites`, `card_likes`, `card_views`, `collections`, `deck_entries`, `deck_entry_events`,
`sale_events`, `card_transactions`, `portfolio_import_jobs`), plus `user_emails`, `access_grants`,
`labeler_user_id`, `reviewer_user_id`. Break it and every scan, collection, transaction and profile
is orphaned, silently.

**I2 — The JWT claim shape must be preserved.** Specifically `sub` (the uuid), `exp`, `iat`, and
issuer `{url}/auth/v1`. `backend/request_auth.py` verifies these; `auth.uid()` in every RLS policy
reads `sub` out of `request.jwt.claims`. Preserve the shape and ~40 policies plus the whole backend
keep working untouched.

**I3 — Password hashes must come along.** They are bcrypt rows in `auth.users.encrypted_password` in
*our own database*. This is a real advantage of Supabase over Clerk/Auth0, where hashes are not
exportable. `pg_dump` of the `auth` schema carries them.

**I4 — RLS semantics must not widen.** The policies encode real product rules (blocked users
mutually invisible, media hidden until `moderation_status='approved'`, authors see their own pending
content, conversation membership). Any reimplementation must be diffed against the migration files,
not against memory.

**I5 — Anonymous/guest users are real users.** They hold data. They must migrate too.

---

## 4. Current dependency inventory

Verified 2026-08-06. Re-verify before executing — this drifts.

### Client (React Native)

- `apps/spotlight-rn/src/lib/supabase.ts` — the **only** `createClient` call. Env resolution, the
  SecureStore session adapter, AppState auto-refresh wiring.
- Only **4 non-test files** import `@supabase/supabase-js`: the above plus
  `features/auth/auth-service.ts` (types), `providers/auth-provider.tsx` (types), and `package.json`.
- **19 distinct auth calls**, all in `features/auth/auth-service.ts` unless noted: `signUp`,
  `signInWithPassword`, `signOut`, `updateUser` (metadata + password), `verifyOtp` (`signup` and
  `recovery`), `resend`, `resetPasswordForEmail`, `signInWithOAuth` (Google) +
  `exchangeCodeForSession`, `signInWithIdToken` (Apple, SHA-256 hashed nonce), `setSession`,
  `getSession`, `getUser`, `signInAnonymously`, `onAuthStateChange` (in `auth-provider.tsx`),
  `startAutoRefresh`/`stopAutoRefresh` (in `lib/supabase.ts`).
- **8 relations queried client-direct** across `social-service.ts` and `profile-service.ts`:
  `user_profiles`, `public_profiles` (view), `follows`, `posts`, `post_media`, `post_likes`,
  `comment_likes`, `comments`.
- **1 RPC**: `email_exists`.
- **Zero** `supabase.storage`, **zero** `.channel()`, **zero** `functions.invoke()`.
- Access token reaches the Python backend at `packages/api-client/src/spotlight/repository.ts:4157+`
  (the single place the `Authorization` header is set), plus direct image fetches in
  `features/social/components/post-card.tsx`.

### Backend (Python)

- `backend/request_auth.py` — JWT verification (HS256 secret or JWKS).
- `backend/server.py` — JWT wiring (`:199-201`, `:1433-1446`); GoTrue Admin API for email sync
  (`:2598`) and account deletion (`:6429`); **PostgREST proxy forwarding the caller's JWT**
  (`:17083-17261`) — being unwound; GCS post-media upload (`:18422+`); `/api/v1/review/config`
  (`:17302`) deliberately serves the anon key to the internal review web page.
- `backend/social_moderation_worker.py` — service-role PostgREST polling; not on cron.
- `backend/review_web/index.html` — a **second** supabase-js client (CDN), uses `signInWithOtp`.

### Tooling

`tools/bootstrap_staging_simulator_auth.py`, `reset_staging_smoke_fixture.py`, `run_release_gate.py`,
`load_test_backend.py`, `loadtest/mint-token.sh`, `run_local_staging_ui_smoke.sh` — all use the
GoTrue password grant. `tools/audit_release_config.py` requires `SUPABASE_URL`, a valid
`SUPABASE_JWT_SECRET` or reachable JWKS, and `SUPABASE_SERVICE_ROLE_KEY`.

### Database

`apps/spotlight-rn/supabase/migrations/social_00`–`social_09`, all applied. 17 relations, ~40 RLS
policies, 12 trigger/helper functions, 3 `SECURITY DEFINER` helpers (`is_admin`, `is_blocked`,
`is_conversation_participant`), one `security_invoker = false` view (`public_profiles`), column-level
`GRANT`/`REVOKE` fencing on `user_profiles` (`social_08`), and `storage.buckets`/`storage.objects`
policies that are now vestigial (bytes are on GCS).

---

## 5. The migration

Recommended path: **lift-and-shift the open-source components onto GCP.** Do not attempt to
hand-roll auth inside the 19.8k-line stdlib `http.server`; that is the 3-month path.

### Phase 0 — Prerequisites (do these before anything)

- [ ] **Two Supabase projects already split** (staging ≠ production). If this is still not done,
      do it first — you cannot rehearse a migration against production.
- [ ] Escape-hatch rules §2 all satisfied; in particular `public.users` exists and new FKs point at it.
- [ ] A **tested** `pg_dump` → local Postgres restore, with a two-user RLS smoke test passing
      against the restore.
- [ ] Confirm the current `@supabase/supabase-js` version's compatibility with the GoTrue and
      PostgREST versions you intend to self-host. Pin all three.
- [ ] Inventory re-verified against §4 (it drifts).

### Phase 1 — Database → Cloud SQL for Postgres (~1 day)

Cloud SQL, same region as the backend VM (Supabase runs on AWS today, so this also removes a
cross-cloud hop). Not self-managed Postgres on GCE: at solo-operator scale, automated backups + PITR
+ patching + failover are worth more than the ~40% compute saving, and the existing VM is CPU-bound
on SigLIP2 inference so Postgres cannot share it anyway.

1. Provision Cloud SQL, right-sized from the Supabase compute add-on you were on.
2. `pg_dump` including the `auth` schema, `citext` and `pgcrypto`, all functions and triggers.
3. `pg_restore` into Cloud SQL. **Verify: `select count(*) from auth.users` matches, and spot-check
   that `encrypted_password` is non-null for password users (I3).**
4. Verify all 17 relations, ~40 policies, 12 functions, and the `public_profiles` view exist.
5. Confirm `auth.uid()` resolves — it reads `request.jwt.claims`, so it needs the GoTrue/PostgREST
   role and `SET` conventions in place. Test after Phase 2/3, not here.

**Do not** migrate the SQLite card/pricing/index data. That is D2 and out of scope.

### Phase 2 — Auth → self-hosted GoTrue (~1 week; the crux)

1. Run GoTrue as a container against Cloud SQL, same JWT secret / signing key as before.
2. Re-register **Apple** and **Google** OAuth apps against the new issuer URL; update redirect URIs.
   Note the app uses native Apple sign-in with a SHA-256 hashed nonce — re-verify that path on a real
   device, not the simulator.
3. Re-point SMTP at **Resend** (already configured; see `docs/resend-supabase-smtp-setup.md`).
   Supabase's built-in sender is capped at 2 emails/hour, so Resend is already load-bearing.
4. Replace the GoTrue **Admin API** consumers: `sync_user_emails_from_supabase()` (`server.py:2598`)
   and `_delete_supabase_auth_user()` (`server.py:6429`). Self-hosted GoTrue exposes the same admin
   endpoints — this should be a base-URL change, but **account deletion is an App Store 5.1.1(v)
   requirement, so test it explicitly.**
5. Update every tool in §4 that uses the password grant.
6. **Verify I1 and I2:** an existing user signs in and gets the *same* uuid; their scans,
   collections, and profile all still resolve; `backend/request_auth.py` validates the new token
   with only env-var changes.

Alternatives considered and rejected: Google Identity Platform (more expensive at scale —
$0.0046/MAU vs $0.00325 — and would not preserve uuids without a custom import), Clerk/Auth0
(dramatically more expensive and cannot export password hashes), hand-rolled auth in the Python
backend (security-critical, no framework, 3 months).

### Phase 3 — Data API → self-hosted PostgREST (~2 days)

1. Run PostgREST against Cloud SQL with the same `anon` / `authenticated` roles and JWT secret.
2. Point `apps/spotlight-rn/src/lib/supabase.ts` at the new URL via the existing env vars. **The
   client code does not otherwise change** — this is the payoff for keeping one seam.
3. Note the existing quirk: PostgREST cannot embed `follows`/`posts` → `public_profiles` because
   those FKs point at `auth.users`, so `social-service.ts` and `profile-service.ts` already do manual
   two-step hydration. That behavior is preserved as-is.
4. Verify the ~40 RLS policies behave identically with a two-user matrix (I4).

### Phase 4 — Realtime (~1 week, only if DMs shipped)

This is the rebuild (D8). Options, in order of preference:
- Postgres `LISTEN/NOTIFY` behind a small WebSocket service on the existing VM — fewest moving parts,
  no vendor.
- Self-hosted Supabase Realtime — preserves the client API shape, but you now operate it.
- A portable vendor (Ably/Pusher) — fastest, reintroduces a vendor.

Whatever you choose, the client subscription code in the DM feature is the blast radius.

### Phase 5 — Cleanup (~half day)

1. Backfill legacy `user_profiles.avatar_url` values still pointing at Supabase Storage.
2. Drop the vestigial `storage.buckets` / `storage.objects` artifacts from `social_05` / `social_06`.
3. Re-point `backend/review_web/index.html` (the second, CDN-loaded client).
4. Update `tools/audit_release_config.py` and both `backend/.env.*` files.
5. Decommission the Supabase project **only after** a full billing cycle of clean operation.

---

## 6. Cutover, failure modes, rollback

**Cutover order:** staging first, for at least a week of real use. The staging/production split is
what makes this safe — do not attempt a migration without it.

**Failure modes to watch, and how each shows up:**

| Failure | Symptom | Detection |
|---|---|---|
| uuid not preserved (I1) | Users sign in successfully but their collection is empty | Compare `select count(*) from auth.users` before/after; spot-check a known uuid end-to-end through the SQLite backend |
| JWT claim drift (I2) | Backend 401s, or RLS silently returns zero rows | `request_auth.py` unit tests against a real minted token; a two-user RLS matrix |
| RLS widened (I4) | **Silent data leak** — worst case, no error | Two-user matrix run against the restore, diffed against the migration SQL |
| SECURITY DEFINER lost | Counters drift permanently, no error (this bug already happened twice — see `social_07`, `social_09`) | Assert `prosecdef` on all counter triggers post-restore |
| Password hashes not carried (I3) | Every password user must reset | `select count(*) from auth.users where encrypted_password is not null` |
| OAuth redirect misconfig | Apple/Google sign-in fails on device only | Test on a real device; simulator behaves differently |

**Rollback:** until Phase 5, Supabase remains intact and running. Rollback is re-pointing env vars
back and redeploying — provided you have **not** taken writes on both sides. Therefore: **do the
cutover as a hard switch, never dual-write.** Reconciling divergent writes across two Postgres
instances is far worse than a few minutes of downtime.

---

## 7. Effort and cost summary

| Phase | Effort | Notes |
|---|---|---|
| 0 Prerequisites | ~3 evenings | Mostly already done if the escape-hatch rules are honored |
| 1 Cloud SQL | ~1 day | Mechanical |
| 2 GoTrue | ~1 week | The crux — OAuth re-registration and admin API are the fiddly parts |
| 3 PostgREST | ~2 days | Client untouched |
| 4 Realtime | ~1 week | Only if DMs shipped |
| 5 Cleanup | ~half day | |
| **Total** | **~2–3 weeks** | …**if** the rules in §2 were honored. ~3 months if not. |

Running cost after migration, at 1M MAU: roughly **$1,600/mo** (Cloud SQL + containers + egress)
versus ~$4,740 on Supabase — but you absorb Postgres HA, backups, patching, and five services'
worth of on-call. At 100k MAU the two are within noise of each other, which is exactly why this doc
is on standby rather than scheduled.

---

## 8. What would make this harder

Watch for drift. Any of these silently raises the migration cost:

- New foreign keys into `auth.users`.
- A second `createClient` call, or `@supabase/supabase-js` imported outside the service layer.
- New Supabase Storage usage for user bytes.
- Any Edge Function.
- The backend delegating another authorization decision to RLS.
- Supabase-proprietary SQL creeping into migrations.
- Realtime subscriptions spreading beyond the DM feature.

A quarterly `grep` for `auth.users`, `createClient`, `supabase.storage`, and `.channel(` is enough
to catch all of it.
